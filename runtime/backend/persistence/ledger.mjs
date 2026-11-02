import crypto from 'node:crypto';
import { createDurableSequences } from './sequences.mjs';
import { outboxConsumerRetired } from './outbox-consumer-retirement.mjs';
import { assertLandHistoryNotRetired, readRetiredKnownLandOperation } from './known-land-history.mjs';
import { ensureBackendLedgerSchema } from './schema.mjs';
import { normalizeLedgerJson as normalizeJson, serializeLedgerJson as json, hashLedgerBytes as fingerprint } from './json-contract.mjs';
import { fingerprint as semanticFingerprint, parseStored as parseEvidence } from '../common.mjs';
import { assertSingleProposal } from '../features/land/rpc-contract.mjs';
import { resolveNativeExecutorExitProof } from '../session/native-executor-identity.mjs';
import { resolveAcceptedLandObservationEvidence } from '../features/land/compatibility-evidence.mjs';
import { resolveExecutionClosureEvidence } from '../session/execution-closure-evidence.mjs';

const verdicts = new Set(['confirmed', 'rejected', 'unknown']);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const textValue = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(name + ' must be a nonempty string');
  return value;
};
const integer = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(name + ' must be a nonnegative safe integer');
  return value;
};
const decode = value => JSON.parse(value);
function timestamp(value, name) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError(name + ' must be a valid timestamp');
  return value;
}
function boundedLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw new TypeError('limit must be an integer between 1 and 1000');
  return value;
}

export function createBackendLedger(store) {
  ensureBackendLedgerSchema(store);
  const { run, get, all, transaction, nowIso } = store;
  const sequences = createDurableSequences(store);
  const resourceBaselineProofs = new Map();
  const resourceBaselineCursors = new Map();
  // Derived scheduler read acceleration only. Source outbox rows and receipts
  // remain append-only; these per-consumer cursors retain every unacknowledged
  // event ID so a failure hole can never be skipped by a high-water mark.
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_outbox_scan_state(
    consumer_id TEXT NOT NULL,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,scanned_through INTEGER NOT NULL CHECK(scanned_through>=0),
    updated_at TEXT NOT NULL,PRIMARY KEY(consumer_id,owner_ref,subject_ref));
    CREATE TABLE IF NOT EXISTS backend_outbox_scan_pending(
    consumer_id TEXT NOT NULL,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,event_id INTEGER NOT NULL CHECK(event_id>0),
    PRIMARY KEY(consumer_id,owner_ref,subject_ref,event_id))`);
  store.db.exec('CREATE INDEX IF NOT EXISTS backend_operation_targets_by_ref ON backend_operation_targets(target_ref,operation_id)');
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_resource_budget_baselines(
    baseline_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    connection_epoch INTEGER NOT NULL,request_sequence INTEGER NOT NULL,response_ref TEXT NOT NULL,operation_rowid INTEGER NOT NULL,
    source_fingerprint TEXT NOT NULL,isolation_evidence_ref TEXT NOT NULL,evidence_json TEXT NOT NULL,recorded_at TEXT NOT NULL,
    UNIQUE(owner_ref,subject_ref,connection_epoch,request_sequence));
    CREATE INDEX IF NOT EXISTS backend_resource_budget_baseline_current ON backend_resource_budget_baselines(owner_ref,subject_ref,connection_epoch,request_sequence);
    CREATE TRIGGER IF NOT EXISTS backend_resource_budget_baselines_no_update BEFORE UPDATE ON backend_resource_budget_baselines
      BEGIN SELECT RAISE(ABORT,'resource budget baseline evidence is append only'); END;
    CREATE TRIGGER IF NOT EXISTS backend_resource_budget_baselines_no_delete BEFORE DELETE ON backend_resource_budget_baselines
      BEGIN SELECT RAISE(ABORT,'resource budget baseline evidence is append only'); END;
    CREATE TABLE IF NOT EXISTS backend_currency_budget_baselines(
      baseline_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
      connection_epoch INTEGER NOT NULL,request_sequence INTEGER NOT NULL,response_ref TEXT NOT NULL,
      value INTEGER NOT NULL,source_fingerprint TEXT NOT NULL,evidence_json TEXT NOT NULL,recorded_at TEXT NOT NULL,
      UNIQUE(owner_ref,subject_ref,connection_epoch,request_sequence));
    CREATE TRIGGER IF NOT EXISTS backend_currency_budget_baselines_no_update BEFORE UPDATE ON backend_currency_budget_baselines
      BEGIN SELECT RAISE(ABORT,'currency budget baseline evidence is append only'); END;
    CREATE TRIGGER IF NOT EXISTS backend_currency_budget_baselines_no_delete BEFORE DELETE ON backend_currency_budget_baselines
      BEGIN SELECT RAISE(ABORT,'currency budget baseline evidence is append only'); END;
    CREATE TABLE IF NOT EXISTS backend_resource_budget_baseline_links(
      baseline_ref TEXT NOT NULL,operation_id TEXT NOT NULL,resource_key TEXT NOT NULL,resource_kind TEXT NOT NULL,
      closure_evidence_ref TEXT NOT NULL,closure_fingerprint TEXT NOT NULL,recorded_at TEXT NOT NULL,
      PRIMARY KEY(baseline_ref,operation_id,resource_key));
    CREATE INDEX IF NOT EXISTS backend_resource_baseline_links_operation ON backend_resource_budget_baseline_links(operation_id,resource_key);
    CREATE TABLE IF NOT EXISTS backend_resource_budget_active(
      subject_ref TEXT NOT NULL,owner_ref TEXT NOT NULL,operation_id TEXT NOT NULL,resource_key TEXT NOT NULL,
      resource_kind TEXT NOT NULL,quantity REAL NOT NULL,PRIMARY KEY(operation_id,resource_key));
    CREATE INDEX IF NOT EXISTS backend_resource_budget_active_subject ON backend_resource_budget_active(subject_ref,owner_ref,operation_id);
    CREATE TRIGGER IF NOT EXISTS backend_resource_active_insert AFTER INSERT ON backend_operation_resources BEGIN
      INSERT OR REPLACE INTO backend_resource_budget_active(subject_ref,owner_ref,operation_id,resource_key,resource_kind,quantity)
        SELECT o.subject_ref,o.owner_ref,NEW.operation_id,NEW.resource_key,NEW.resource_kind,NEW.quantity FROM backend_operations o
        WHERE o.operation_id=NEW.operation_id AND NEW.state!='released' AND NOT EXISTS(
          SELECT 1 FROM backend_resource_budget_baseline_links l WHERE l.operation_id=NEW.operation_id AND l.resource_key=NEW.resource_key);
    END;
    CREATE TRIGGER IF NOT EXISTS backend_resource_active_update AFTER UPDATE OF state,quantity ON backend_operation_resources BEGIN
      DELETE FROM backend_resource_budget_active WHERE operation_id=NEW.operation_id AND resource_key=NEW.resource_key;
      INSERT OR REPLACE INTO backend_resource_budget_active(subject_ref,owner_ref,operation_id,resource_key,resource_kind,quantity)
        SELECT o.subject_ref,o.owner_ref,NEW.operation_id,NEW.resource_key,NEW.resource_kind,NEW.quantity FROM backend_operations o
        WHERE o.operation_id=NEW.operation_id AND NEW.state!='released' AND NOT EXISTS(
          SELECT 1 FROM backend_resource_budget_baseline_links l WHERE l.operation_id=NEW.operation_id AND l.resource_key=NEW.resource_key);
    END;
    CREATE TRIGGER IF NOT EXISTS backend_resource_active_baseline_link AFTER INSERT ON backend_resource_budget_baseline_links BEGIN
      DELETE FROM backend_resource_budget_active WHERE operation_id=NEW.operation_id AND resource_key=NEW.resource_key;
    END;
    INSERT OR IGNORE INTO backend_resource_budget_active(subject_ref,owner_ref,operation_id,resource_key,resource_kind,quantity)
      SELECT o.subject_ref,o.owner_ref,r.operation_id,r.resource_key,r.resource_kind,r.quantity FROM backend_operation_resources r
      JOIN backend_operations o ON o.operation_id=r.operation_id WHERE r.state!='released' AND NOT EXISTS(
        SELECT 1 FROM backend_resource_budget_baseline_links l WHERE l.operation_id=r.operation_id AND l.resource_key=r.resource_key);
    CREATE TRIGGER IF NOT EXISTS backend_resource_budget_baseline_links_no_update BEFORE UPDATE ON backend_resource_budget_baseline_links
      BEGIN SELECT RAISE(ABORT,'resource baseline links are append only'); END;
    CREATE TRIGGER IF NOT EXISTS backend_resource_budget_baseline_links_no_delete BEFORE DELETE ON backend_resource_budget_baseline_links
      BEGIN SELECT RAISE(ABORT,'resource baseline links are append only'); END`);
  const row = operationId => get('SELECT * FROM backend_operations WHERE operation_id=?', textValue(operationId, 'operationId'));
  function required(operationId, expectedRevision = null) {
    const found = row(operationId);
    if (!found) fail('BACKEND_OPERATION_MISSING', 'Operation does not exist');
    if (expectedRevision !== null && found.revision !== integer(expectedRevision, 'expectedRevision')) {
      fail('BACKEND_OPERATION_REVISION_CONFLICT', 'Operation revision changed');
    }
    return found;
  }
  function operation(operationId) {
    const found = row(operationId);
    if (!found) return null;
    return {
      ...found, original: decode(found.original_json), factBasis: decode(found.fact_basis_json),
      targets: all('SELECT * FROM backend_operation_targets WHERE operation_id=? ORDER BY member_key', operationId)
        .map(target => ({ ...target, original: decode(target.original_json) })),
      resources: all('SELECT * FROM backend_operation_resources WHERE operation_id=? ORDER BY resource_key', operationId)
        .map(resource => ({ ...resource, original: decode(resource.original_json) })),
      resourceBindings: all('SELECT * FROM backend_operation_resource_targets WHERE operation_id=? ORDER BY resource_key,member_key', operationId),
      targetSettlements: all('SELECT * FROM backend_operation_target_settlements WHERE operation_id=? ORDER BY member_key', operationId)
        .map(settlement => ({ ...settlement, result: decode(settlement.result_json) })),
    };
  }
  function listOperations({ subjectRef, ownerRef = null, limit = 100, beforePreparedAt = null } = {}) {
    const predicates = ['subject_ref=?'];
    const params = [textValue(subjectRef, 'subjectRef')];
    if (ownerRef !== null) { predicates.push('owner_ref=?'); params.push(textValue(ownerRef, 'ownerRef')); }
    if (beforePreparedAt !== null) { predicates.push('prepared_at<?'); params.push(timestamp(beforePreparedAt, 'beforePreparedAt')); }
    return all('SELECT * FROM backend_operations WHERE ' + predicates.join(' AND ') + ' ORDER BY prepared_at DESC,operation_id DESC LIMIT ?',
      ...params, boundedLimit(limit));
  }
  function listOperationsPage({ subjectRef, ownerRef, limit = 100, beforePreparedAt = null, beforeOperationId = null } = {}) {
    textValue(subjectRef, 'subjectRef'); textValue(ownerRef, 'ownerRef');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('BACKEND_OPERATION_PAGE_INVALID', 'Operation page limit is invalid');
    const predicates = ['owner_ref=?', 'subject_ref=?'], params = [ownerRef, subjectRef];
    if (beforePreparedAt !== null || beforeOperationId !== null) {
      if (typeof beforePreparedAt !== 'string' || !Number.isFinite(Date.parse(beforePreparedAt)) ||
          typeof beforeOperationId !== 'string' || !beforeOperationId.trim()) {
        fail('BACKEND_OPERATION_CURSOR_INVALID', 'Operation cursor is incomplete or invalid');
      }
      const anchor = get('SELECT prepared_at FROM backend_operations WHERE owner_ref=? AND subject_ref=? AND operation_id=?',
        ownerRef, subjectRef, beforeOperationId)||get('SELECT prepared_at FROM backend_land_known_history_receipts WHERE owner_ref=? AND subject_ref=? AND operation_id=?',
        ownerRef,subjectRef,beforeOperationId);
      if (!anchor || anchor.prepared_at !== beforePreparedAt) fail('BACKEND_OPERATION_CURSOR_INVALID', 'Operation cursor does not match this owner and subject');
      predicates.push('(prepared_at<? OR (prepared_at=? AND operation_id<?))');
      params.push(beforePreparedAt, beforePreparedAt, beforeOperationId);
    }
    const selected = all('SELECT * FROM backend_operations WHERE ' + predicates.join(' AND ') +
      ' ORDER BY prepared_at DESC,operation_id DESC LIMIT ?', ...params, limit + 1);
    const rows = selected.slice(0, limit), totals = get(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN business_verdict IN ('unknown','unverified') THEN 1 ELSE 0 END),0) AS unknown,
      COALESCE(SUM(CASE WHEN write_slot=1 THEN 1 ELSE 0 END),0) AS writeSlot
      FROM backend_operations WHERE owner_ref=? AND subject_ref=?`, ownerRef, subjectRef);
    const last = rows.at(-1);
    return { rows, totals, page: { limit, hasMore: selected.length > limit,
      older: last ? { beforePreparedAt: last.prepared_at, beforeOperationId: last.operation_id } : null } };
  }
  function prepareOperation(input) {
    if (!object(input)) throw new TypeError('Prepared operation must be an object');
    const names = ['operationId', 'proposalId', 'ownerRef', 'accountRef', 'subjectRef', 'featureId', 'scope', 'method', 'semanticKey', 'paramsFingerprint'];
    const original = Object.fromEntries(names.map(name => [name, textValue(input[name], name)]));
    if (input.traceId !== undefined) {
      if (typeof input.traceId !== 'string' || input.traceId.length > 64 || !/^[A-Za-z0-9_.:-]{1,64}$/.test(input.traceId)) {
        throw new TypeError('traceId must be a bounded stable identifier');
      }
      original.traceId = input.traceId;
    }
    for (const name of ['runEpoch', 'connectionEpoch', 'configRevision', 'cancelEpoch']) original[name] = integer(input[name], name);
    if (input.ownerEpoch !== undefined) original.ownerEpoch = integer(input.ownerEpoch, 'ownerEpoch');
    if (input.executorRef !== undefined) original.executorRef = textValue(input.executorRef, 'executorRef');
    if (input.ownerEpoch !== undefined && original.executorRef === undefined) throw new TypeError('Executor-bound operations require executorRef');
    if (!object(input.factBasis) || Object.keys(input.factBasis).length === 0) throw new TypeError('Prepared operation requires explicit factBasis');
    original.factBasis = normalizeJson(input.factBasis);
    if (!Array.isArray(input.targets) || !input.targets.length || !Array.isArray(input.resources)) {
      throw new TypeError('Prepared operation requires target members and an explicit resource array');
    }
    original.targets = input.targets.map(target => {
      if (!object(target)) throw new TypeError('Target member must be an object');
      return Object.fromEntries(['memberKey', 'targetKind', 'targetRef', 'lifecycleRef', 'targetFingerprint']
        .map(name => [name, textValue(target[name], 'target.' + name)]));
    });
    if (input.landRequest !== undefined) {
      if (!object(input.landRequest) || input.landRequest.version !== 'land-request/v1' ||
          !['params,version','params,version,workset'].includes(Object.keys(input.landRequest).sort().join(','))) throw new TypeError('Invalid immutable land request');
      const captured = assertSingleProposal({ ...original, params: input.landRequest.params });
      original.landRequest = { version: 'land-request/v1', params: normalizeJson(captured.params) };
      if (input.landRequest.workset !== undefined) {
        if (Buffer.byteLength(json(input.landRequest.workset))>66*1024) throw new TypeError('Immutable land workset exceeds budget');
        original.landRequest.workset=normalizeJson(input.landRequest.workset);
      }
    }
    original.resources = input.resources.map(resource => {
      if (!object(resource) || typeof resource.quantity !== 'number' || !Number.isFinite(resource.quantity) || resource.quantity < 0) {
        throw new TypeError('Resource quantity must be a finite nonnegative number');
      }
      return { ...Object.fromEntries(['resourceKey', 'resourceKind', 'resourceRef', 'basisRef', 'accountingRef']
        .map(name => [name, textValue(resource[name], 'resource.' + name)])), quantity: resource.quantity };
    });
    if (new Set(original.targets.map(target => target.memberKey)).size !== original.targets.length
      || new Set(original.resources.map(resource => resource.resourceKey)).size !== original.resources.length) {
      throw new TypeError('Target member keys and resource keys must be unique within an operation');
    }
    if (input.resourceBindings !== undefined) {
      if (!Array.isArray(input.resourceBindings)) throw new TypeError('resourceBindings must be an explicit array');
      const members = new Set(original.targets.map(target => target.memberKey));
      const quantities = new Map(original.resources.map(resource => [resource.resourceKey, 0]));
      const seen = new Set();
      original.resourceBindings = input.resourceBindings.map(binding => {
        if (!object(binding)) throw new TypeError('Resource member binding must be an object');
        const resourceKey = textValue(binding.resourceKey, 'resourceKey'), memberKey = textValue(binding.memberKey, 'memberKey');
        if (!members.has(memberKey) || !quantities.has(resourceKey) || seen.has(json([resourceKey, memberKey])) ||
            typeof binding.quantity !== 'number' || !Number.isFinite(binding.quantity) || binding.quantity < 0) {
          throw new TypeError('Resource binding must identify one original resource and member with a finite nonnegative quantity');
        }
        seen.add(json([resourceKey, memberKey])); quantities.set(resourceKey, quantities.get(resourceKey) + binding.quantity);
        return { resourceKey, memberKey, quantity: binding.quantity };
      });
      if (original.resources.some(resource => quantities.get(resource.resourceKey) !== resource.quantity ||
          !original.resourceBindings.some(binding => binding.resourceKey === resource.resourceKey))) {
        throw new TypeError('Resource bindings must cover each original quantity exactly');
      }
    } else if (input.ownerEpoch !== undefined) throw new TypeError('New executor-bound operations require explicit resourceBindings');
    return transaction(() => {
      const existing = row(original.operationId);
      if(!existing)assertLandHistoryNotRetired(store,original);
      if (existing) {
        const savedOriginal = decode(existing.original_json);
        if (typeof savedOriginal.traceId === 'string') original.traceId = savedOriginal.traceId;
        else delete original.traceId; // Preserve pre-trace operation fingerprints and raw history.
      }
      // A proved-unsent proposal may be assessed again under a new immutable
      // operation. The semantic occurrence stays stable, and every previous
      // unsent identity/evidence is linked rather than hidden by a random key.
      if (existing) original.previousUnsentOperations = decode(existing.original_json).previousUnsentOperations || [];
      else {
        const previous = all(`SELECT * FROM backend_operations WHERE subject_ref=? AND feature_id=? AND semantic_key=? ORDER BY prepared_at,operation_id`,
          original.subjectRef, original.featureId, original.semanticKey);
        if (previous.some(item => item.transport_state !== 'not_sent')) {
          fail('BACKEND_SEMANTIC_DUPLICATE', 'This semantic occurrence has a possibly sent operation; append evidence to the original operation');
        }
        original.previousUnsentOperations = previous.map(item => {
          const proof = all('SELECT * FROM backend_operation_evidence WHERE operation_id=? ORDER BY evidence_id DESC', item.operation_id)
            .find(event => {
              const payload = decode(event.payload_json);
              return payload.nonSendProof?.permitConsumed === false && payload.nonSendProof?.byteSendStarted === false;
            });
          if (!proof) fail('BACKEND_UNSENT_PROOF_MISSING', 'Previous not-sent operation has no immutable non-send proof');
          return { operationId: item.operation_id, originalFingerprint: item.original_fingerprint,
            evidenceId: Number(proof.evidence_id), evidenceFingerprint: proof.payload_fingerprint };
        });
      }
      const originalJson = json(original);
      const originalFingerprint = fingerprint(originalJson);
      if (existing) {
        if (existing.original_fingerprint !== originalFingerprint) fail('BACKEND_OPERATION_ID_CONFLICT', 'Operation identity was reused with different original data');
        return { operation: operation(original.operationId), replayed: true };
      }
      if (get('SELECT operation_id FROM backend_operations WHERE subject_ref=? AND write_slot=1', original.subjectRef)) {
        fail('BACKEND_WRITE_SLOT_BUSY', 'The subject has a current write slot');
      }
      const at = nowIso();
      run(`INSERT INTO backend_operations(operation_id,proposal_id,owner_ref,account_ref,subject_ref,run_epoch,connection_epoch,
        feature_id,scope,method,semantic_key,config_revision,cancel_epoch,fact_basis_json,params_fingerprint,
        original_json,original_fingerprint,prepared_at,updated_at,operation_sequence) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      original.operationId, original.proposalId, original.ownerRef, original.accountRef, original.subjectRef,
      original.runEpoch, original.connectionEpoch, original.featureId, original.scope, original.method, original.semanticKey,
      original.configRevision, original.cancelEpoch, json(original.factBasis), original.paramsFingerprint,
      originalJson, originalFingerprint, at, at, sequences.next('operation', []));
      for (const target of original.targets) run(`INSERT INTO backend_operation_targets
        (operation_id,member_key,target_kind,target_ref,lifecycle_ref,target_fingerprint,original_json) VALUES(?,?,?,?,?,?,?)`,
      original.operationId, target.memberKey, target.targetKind, target.targetRef, target.lifecycleRef, target.targetFingerprint, json(target));
      for (const resource of original.resources) run(`INSERT INTO backend_operation_resources
        (operation_id,resource_key,resource_kind,resource_ref,quantity,basis_ref,accounting_ref,original_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      original.operationId, resource.resourceKey, resource.resourceKind, resource.resourceRef, resource.quantity,
      resource.basisRef, resource.accountingRef, json(resource), at);
      for (const binding of original.resourceBindings || []) run(`INSERT INTO backend_operation_resource_targets
        (operation_id,resource_key,member_key,quantity) VALUES(?,?,?,?)`, original.operationId, binding.resourceKey, binding.memberKey, binding.quantity);
      return { operation: operation(original.operationId), replayed: false };
    });
  }
  function appendEvidence({ operationId, evidenceKey = crypto.randomUUID(), kind, source, payload, observedAt = nowIso() } = {}) {
    textValue(evidenceKey, 'evidenceKey'); textValue(kind, 'kind'); textValue(source, 'source');
    timestamp(observedAt, 'observedAt');
    if (!object(payload) || !Object.keys(payload).length) throw new TypeError('Evidence requires a nonempty payload object');
    const payloadJson = json(payload);
    const payloadFingerprint = fingerprint(json({ kind, source, payload: decode(payloadJson), observedAt }));
    return transaction(() => {
      required(operationId);
      const existing = get('SELECT * FROM backend_operation_evidence WHERE operation_id=? AND evidence_key=?', operationId, evidenceKey);
      if (existing) {
        if (existing.payload_fingerprint !== payloadFingerprint) fail('BACKEND_EVIDENCE_ID_CONFLICT', 'Evidence key was reused with different evidence');
        return { evidenceId: existing.evidence_id, replayed: true };
      }
      const result = run(`INSERT INTO backend_operation_evidence
        (operation_id,evidence_key,kind,source,payload_json,payload_fingerprint,observed_at,recorded_at) VALUES(?,?,?,?,?,?,?,?)`,
      operationId, evidenceKey, kind, source, payloadJson, payloadFingerprint, observedAt, nowIso());
      run('UPDATE backend_operations SET revision=revision+1,updated_at=? WHERE operation_id=?', nowIso(), operationId);
      return { evidenceId: Number(result.lastInsertRowid), replayed: false };
    });
  }
  function evidenceFor(operationId, evidence, kind) {
    if (!object(evidence)) throw new TypeError('Operation transition requires explicit evidence');
    return appendEvidence({ ...evidence, operationId, kind: evidence.kind || kind });
  }
  function markMayHaveSent({ operationId, expectedRevision = null, evidence } = {}) {
    return transaction(() => {
      const found = required(operationId, expectedRevision);
      if (found.transport_state !== 'not_started' || found.write_slot !== 1) fail('BACKEND_TRANSPORT_TRANSITION_INVALID', 'Only a prepared current operation can enter may-have-sent');
      evidenceFor(operationId, evidence, 'send-boundary-prepared');
      run("UPDATE backend_operations SET transport_state='may_have_sent',revision=revision+1,updated_at=? WHERE operation_id=?", nowIso(), operationId);
      run("UPDATE backend_operation_resources SET state='in_flight',updated_at=? WHERE operation_id=? AND state='reserved'", nowIso(), operationId);
      return operation(operationId);
    });
  }
  function markNotSent({ operationId, expectedRevision = null, nonSendProof, evidence } = {}) {
    if (!object(nonSendProof) || nonSendProof.permitConsumed !== false || nonSendProof.byteSendStarted !== false) {
      throw new TypeError('Not-sent requires explicit unconsumed-permit and byte-send-not-started proof');
    }
    textValue(nonSendProof.source, 'nonSendProof.source');
    return transaction(() => {
      const found = required(operationId, expectedRevision);
      if (!['not_started', 'may_have_sent'].includes(found.transport_state) || found.business_verdict !== 'unverified') {
        fail('BACKEND_TRANSPORT_TRANSITION_INVALID', 'An answered or unknown operation cannot be cancelled as not sent');
      }
      const receipt = evidenceFor(operationId, { ...evidence, payload: { ...evidence?.payload, nonSendProof } }, 'proved-not-sent');
      run("UPDATE backend_operations SET transport_state='not_sent',business_verdict='not_applicable',write_slot=0,revision=revision+1,updated_at=? WHERE operation_id=?", nowIso(), operationId);
      run("UPDATE backend_operation_resources SET state='released',release_evidence_id=?,updated_at=? WHERE operation_id=?", receipt.evidenceId, nowIso(), operationId);
      return operation(operationId);
    });
  }
  function terminationProof(proof) {
    if (!object(proof) || proof.ended !== true) throw new TypeError('Write-slot release requires explicit transport-ended proof');
    textValue(proof.source, 'transportTermination.source');
    return normalizeJson(proof);
  }
  function recordTransport({ operationId, expectedRevision = null, transportState, evidence,
    releaseWriteSlot = false, transportTermination = null } = {}) {
    if (!['answered', 'terminated', 'unknown'].includes(transportState)) throw new TypeError('Invalid recorded transport state');
    const proof = releaseWriteSlot || transportState === 'terminated' ? terminationProof(transportTermination) : null;
    return transaction(() => {
      const found = required(operationId, expectedRevision);
      const allowed = found.transport_state === 'may_have_sent'
        || found.transport_state === 'answered' && ['answered', 'terminated'].includes(transportState)
        || found.transport_state === 'terminated' && transportState === 'terminated'
        || found.transport_state === 'unknown' && transportState === 'unknown';
      if (!allowed) fail('BACKEND_TRANSPORT_TRANSITION_INVALID', 'Transport evidence cannot rewrite a not-sent or historical unknown outcome');
      evidenceFor(operationId, { ...evidence, payload: { ...evidence?.payload, ...(proof ? { transportTermination: proof } : {}) } }, 'transport-' + transportState);
      run('UPDATE backend_operations SET transport_state=?,write_slot=?,revision=revision+1,updated_at=? WHERE operation_id=?',
        transportState, releaseWriteSlot ? 0 : found.write_slot, nowIso(), operationId);
      if (transportState === 'unknown') run("UPDATE backend_operation_resources SET state='historical_footprint',updated_at=? WHERE operation_id=? AND state!='released'", nowIso(), operationId);
      return operation(operationId);
    });
  }
  function settleOperation({ operationId, expectedRevision = null, businessVerdict, verificationVersion, evidence,
    releaseWriteSlot = false, transportTermination = null, resourceResolutions = [] } = {}) {
    if (!verdicts.has(businessVerdict)) throw new TypeError('Invalid business verdict');
    textValue(verificationVersion, 'verificationVersion');
    if (!Array.isArray(resourceResolutions)) throw new TypeError('resourceResolutions must be an array');
    const proof = releaseWriteSlot ? terminationProof(transportTermination) : null;
    return transaction(() => {
      const found = required(operationId, expectedRevision);
      if (found.business_verdict !== 'unverified' && found.business_verdict !== businessVerdict) {
        fail('BACKEND_BUSINESS_VERDICT_IMMUTABLE', 'An existing business verdict cannot be rewritten; append evidence and a current-admission basis');
      }
      if (!['answered', 'terminated', 'unknown'].includes(found.transport_state)
        || found.transport_state === 'unknown' && businessVerdict !== 'unknown') {
        fail('BACKEND_BUSINESS_VERIFICATION_INVALID', 'Business settlement requires suitable transport evidence; historical unknown cannot become success');
      }
      if (new Set(resourceResolutions.map(item => item.resourceKey)).size !== resourceResolutions.length) throw new TypeError('Duplicate resource resolutions');
      for (const resolution of resourceResolutions) {
        textValue(resolution.resourceKey, 'resourceKey');
        if (!['released', 'historical_footprint'].includes(resolution.state)) throw new TypeError('Invalid resource resolution state');
        if (businessVerdict === 'unknown' && resolution.state !== 'historical_footprint') throw new TypeError('Unknown operations retain resource footprints');
        if (!get('SELECT resource_key FROM backend_operation_resources WHERE operation_id=? AND resource_key=?', operationId, resolution.resourceKey)) {
          fail('BACKEND_RESOURCE_MISSING', 'Resource resolution does not belong to this operation');
        }
      }
      const receipt = evidenceFor(operationId, { ...evidence, payload: { ...evidence?.payload,
        businessVerdict, verificationVersion, resourceResolutions, ...(proof ? { transportTermination: proof } : {}) } }, 'business-verification');
      run('UPDATE backend_operations SET business_verdict=?,verification_version=?,write_slot=?,revision=revision+1,updated_at=? WHERE operation_id=?',
        businessVerdict, verificationVersion, releaseWriteSlot ? 0 : found.write_slot, nowIso(), operationId);
      if (businessVerdict === 'unknown') run("UPDATE backend_operation_resources SET state='historical_footprint',updated_at=? WHERE operation_id=? AND state!='released'", nowIso(), operationId);
      for (const resolution of resourceResolutions) run('UPDATE backend_operation_resources SET state=?,release_evidence_id=?,updated_at=? WHERE operation_id=? AND resource_key=?',
        resolution.state, receipt.evidenceId, nowIso(), operationId, resolution.resourceKey);
      return operation(operationId);
    });
  }
  function settleSingleTarget({ operationId, expectedRevision = null, settlementKey, member,
    verificationVersion, evidence, resourceResolutions = [], transportTermination = null } = {}) {
    textValue(operationId, 'operationId');
    textValue(settlementKey, 'settlementKey'); textValue(verificationVersion, 'verificationVersion');
    if (!object(member) || !verdicts.has(member.verdict)) throw new TypeError('Single-target settlement requires a member verdict');
    textValue(member.memberKey, 'memberKey'); textValue(member.reasonCode, 'reasonCode');
    if (!object(evidence) || !object(evidence.payload) || !Object.keys(evidence.payload).length) throw new TypeError('Single-target settlement requires explicit operation evidence');
    if (!Array.isArray(resourceResolutions)) throw new TypeError('Resource resolutions must be an array');
    const result = { member: { memberKey: member.memberKey, verdict: member.verdict, reasonCode: member.reasonCode },
      verificationVersion, evidence: normalizeJson(evidence), resourceResolutions: normalizeJson(resourceResolutions),
      transportTermination: transportTermination === null ? null : terminationProof(transportTermination) };
    const resultJson = json(result), resultFingerprint = fingerprint(resultJson);
    return transaction(() => {
      const previous = get('SELECT * FROM backend_operation_target_settlements WHERE operation_id=? AND (member_key=? OR settlement_key=?)',
        operationId, member.memberKey, settlementKey);
      if (previous) {
        if (previous.member_key !== member.memberKey || previous.settlement_key !== settlementKey || previous.result_fingerprint !== resultFingerprint) {
          fail('BACKEND_TARGET_SETTLEMENT_CONFLICT', 'An original target verdict is immutable; append reconciliation evidence instead');
        }
        return { operation: operation(operationId), targetSettlement: { ...previous, result: decode(previous.result_json) }, replayed: true };
      }
      const found = required(operationId, expectedRevision), prepared = operation(operationId);
      if (prepared.targets.length !== 1 || prepared.targets[0].member_key !== member.memberKey) {
        fail('BACKEND_SINGLE_TARGET_REQUIRED', 'Only the exact single original member can use this settlement API');
      }
      if (resourceResolutions.length !== prepared.resources.length || new Set(resourceResolutions.map(item => item.resourceKey)).size !== prepared.resources.length ||
          resourceResolutions.some(item => !prepared.resources.some(resource => resource.resource_key === item.resourceKey))) {
        fail('BACKEND_RESOURCE_RESOLUTION_INCOMPLETE', 'Every original resource requires one explicit resolution');
      }
      if (prepared.resources.some(resource => !prepared.resourceBindings.some(binding => binding.resource_key === resource.resource_key &&
          binding.member_key === member.memberKey && binding.quantity === resource.quantity))) {
        fail('BACKEND_RESOURCE_BINDING_MISSING', 'Single-target resources require exact immutable member bindings');
      }
      if (found.business_verdict !== 'unverified' && found.business_verdict !== member.verdict) {
        fail('BACKEND_BUSINESS_VERDICT_IMMUTABLE', 'Historical results cannot become a different target verdict');
      }
      if (transportTermination !== null && (transportTermination.operationId !== operationId ||
          transportTermination.connectionEpoch !== found.connection_epoch)) {
        fail('BACKEND_TRANSPORT_PROOF_MISMATCH', 'Termination proof must bind this original operation and connection');
      }
      if (transportTermination !== null) {
        const permit = get('SELECT consumed,wire_key,request_sequence FROM backend_send_permits WHERE operation_id=?', operationId);
        const answer = all("SELECT payload_json FROM backend_operation_evidence WHERE operation_id=? AND kind='official-answer'", operationId)
          .some(event => {
            const payload = decode(event.payload_json);
            return payload.responseRef === transportTermination.responseRef && payload.wireKey === transportTermination.wireKey &&
              payload.requestSequence === transportTermination.requestSequence && payload.connectionEpoch === found.connection_epoch;
          });
        if (transportTermination.source !== 'matched-rpc-response' || found.transport_state !== 'answered' || !answer ||
            permit?.consumed !== 1 || permit.wire_key !== transportTermination.wireKey ||
            permit.request_sequence !== transportTermination.requestSequence || !Number.isSafeInteger(transportTermination.requestSequence) ||
            transportTermination.requestSequence < 1) {
          fail('BACKEND_MATCHED_RESPONSE_PROOF_MISSING', 'Only the exact durably matched answer releases a single-target request slot');
        }
      }
      const receipt = evidenceFor(operationId, { ...evidence, evidenceKey: 'target-settlement:' + settlementKey,
        payload: { ...evidence.payload, member: result.member, resourceResolutions, verificationVersion,
          transportTermination: result.transportTermination } }, 'single-target-verification');
      settleOperation({ operationId, businessVerdict: member.verdict, verificationVersion,
        releaseWriteSlot: transportTermination !== null, transportTermination, resourceResolutions,
        evidence: { ...evidence, evidenceKey: 'operation-settlement:' + settlementKey } });
      run(`INSERT INTO backend_operation_target_settlements(operation_id,member_key,settlement_key,verdict,
        verification_version,reason_code,evidence_id,result_json,result_fingerprint,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      operationId, member.memberKey, settlementKey, member.verdict, verificationVersion, member.reasonCode,
      receipt.evidenceId, resultJson, resultFingerprint, nowIso());
      const targetSettlement = get('SELECT * FROM backend_operation_target_settlements WHERE operation_id=? AND member_key=?', operationId, member.memberKey);
      return { operation: operation(operationId), targetSettlement: { ...targetSettlement, result: decode(targetSettlement.result_json) }, replayed: false };
    });
  }
  function recordAdmissionBasis({ operationId, constraintKey, basisKey, conclusion, factBasis, affected, evidence, reasonCode } = {}) {
    textValue(constraintKey, 'constraintKey'); textValue(basisKey, 'basisKey'); textValue(reasonCode, 'reasonCode');
    if (!['hold_current', 'permit_current', 'needs_evidence'].includes(conclusion)) throw new TypeError('Invalid current-admission conclusion');
    if (!object(factBasis) || !Object.keys(factBasis).length || !object(affected) || !Object.keys(affected).length
      || !object(evidence) || !Object.keys(evidence).length) throw new TypeError('Admission basis requires explicit facts, affected constraint scope and evidence');
    const factJson = json(factBasis); const affectedJson = json(affected); const evidenceJson = json(evidence);
    return transaction(() => {
      const found = required(operationId);
      const existing = get('SELECT * FROM backend_admission_basis WHERE operation_id=? AND constraint_key=? AND basis_key=?', operationId, constraintKey, basisKey);
      if (existing) {
        if (existing.conclusion !== conclusion || existing.fact_basis_json !== factJson || existing.affected_json !== affectedJson
          || existing.evidence_json !== evidenceJson || existing.reason_code !== reasonCode) fail('BACKEND_ADMISSION_ID_CONFLICT', 'Admission basis key was reused with different evidence');
        return { basisId: existing.basis_id, replayed: true };
      }
      const result = run(`INSERT INTO backend_admission_basis(operation_id,subject_ref,constraint_key,basis_key,conclusion,
        operation_revision,fact_basis_json,affected_json,evidence_json,reason_code,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      operationId, found.subject_ref, constraintKey, basisKey, conclusion, found.revision, factJson, affectedJson, evidenceJson, reasonCode, nowIso());
      return { basisId: Number(result.lastInsertRowid), replayed: false };
    });
  }
  function recordCurrentResourceBaseline({ context, responseRef, requestSequence, connectionEpoch, executorIsolation = null,
    officialUid, versionEvidence } = {}) {
    if (!object(context) || !['ownerRef', 'accountRef', 'subjectRef'].every(key => typeof context[key] === 'string' && context[key].length > 0) ||
        !['ownerEpoch', 'runEpoch'].every(key => Number.isSafeInteger(context[key]) && context[key] > 0) ||
        !Number.isSafeInteger(connectionEpoch) || connectionEpoch < 1 || !Number.isSafeInteger(requestSequence) || requestSequence < 1 ||
        typeof responseRef !== 'string' || !responseRef || responseRef.length > 512 ||
        executorIsolation !== null && (!object(executorIsolation) || executorIsolation.isolated !== true ||
          typeof executorIsolation.evidenceRef !== 'string' || typeof executorIsolation.sourceRef !== 'string')) {
      throw new TypeError('Current resource baseline requires an exact complete official login');
    }
    let descriptor = null;
    const result = transaction(() => {
      // The baseline proves today's absolute resource state. Historical
      // reservations are reconciled one operation per bounded later call.
      const isolationRef = executorIsolation?.evidenceRef ?? '';
      const isolation = executorIsolation ? get('SELECT * FROM backend_executor_isolation WHERE subject_ref=? AND evidence_ref=? AND source_ref=?',
        context.subjectRef, executorIsolation.evidenceRef, executorIsolation.sourceRef) : null;
      if (executorIsolation) {
        const isolationProof = isolation && decode(isolation.proof_json);
        if (!isolationProof || isolationProof.stopped !== true || isolationProof.currentInFlight !== false ||
            !(isolationProof.sourceFenceCommitted === true || isolationProof.nativeExecutorExited === true)) {
          return { recorded: false, reasonCode: 'RESOURCE_BASELINE_EXECUTOR_CLOSE_UNPROVEN' };
        }
      }
      const admitted = get(`SELECT * FROM backend_land_domain_observations WHERE observation_ref=? AND owner_ref=? AND account_ref=?
        AND subject_ref=? AND connection_epoch=? AND request_sequence=? AND response_ref=?`,
      'land-observation:' + semanticFingerprint([context.ownerRef, context.subjectRef, connectionEpoch, responseRef]),
      context.ownerRef, String(context.accountRef), context.subjectRef, connectionEpoch, requestSequence, responseRef);
      if (!admitted) return { recorded: false, reasonCode: 'RESOURCE_BASELINE_LOGIN_NOT_ADMITTED' };
      const effective = resolveAcceptedLandObservationEvidence({ store, context: { ...context, accountRef: String(context.accountRef), connectionEpoch },
        observationRef: admitted.observation_ref });
      if (!effective?.accepted) return { recorded: false, reasonCode: 'RESOURCE_BASELINE_LOGIN_NOT_ADMITTED' };
      const landFrame = effective.frame, source = landFrame.source;
      if (source?.method !== 'index.login' || source.kind !== 'response' || source.connectionEpoch !== connectionEpoch ||
          source.requestSequence !== requestSequence || source.responseRef !== responseRef || landFrame.coverage?.bagComplete !== true ||
          landFrame.bag?.presence !== 'present' || landFrame.bag?.state !== 'known' || !landFrame.bag.items ||
          !Object.values(landFrame.bag.items).every(item => item?.presence === 'present' && item.state === 'known' && Number.isSafeInteger(item.value) && item.value >= 0)) {
        return { recorded: false, reasonCode: 'RESOURCE_BASELINE_FULL_ABSOLUTE_BAG_UNPROVEN' };
      }
      const itemFrame = get(`SELECT * FROM backend_official_item_frames WHERE owner_ref=? AND account_ref=? AND subject_ref=?
        AND connection_epoch=? AND request_sequence=? AND response_ref=?`, context.ownerRef, String(context.accountRef), context.subjectRef,
      connectionEpoch, requestSequence, responseRef);
      const itemSource = itemFrame && decode(itemFrame.source_json);
      if (!itemFrame || itemSource.method !== 'index.login' || itemSource.connectionEpoch !== connectionEpoch ||
          itemSource.requestSequence !== requestSequence || itemSource.responseRef !== responseRef || !Number.isSafeInteger(officialUid) || officialUid < 1 ||
          landFrame.profile?.uid?.presence !== 'present' || landFrame.profile.uid.state !== 'known' || landFrame.profile.uid.value !== officialUid ||
          versionEvidence?.source !== 'normal-package-hop-and-matched-world-login/v1' ||
          typeof versionEvidence.gameVersion !== 'string' || typeof versionEvidence.protocolVersion !== 'string' || versionEvidence.loginResponseRef !== responseRef) {
        return { recorded: false, reasonCode: 'RESOURCE_BASELINE_IDENTITY_OR_ITEM_FRAME_UNPROVEN' };
      }
      const baselineOwner = get('SELECT owner_ref,owner_epoch,executor_ref,active FROM backend_subject_owners WHERE subject_ref=?', context.subjectRef);
      const baselineAccount = get(`SELECT subject_ref,server_id,profile_json,verification_ref FROM backend_accounts
        WHERE owner_ref=? AND account_id=? AND removed_at IS NULL`, context.ownerRef, Number(context.accountRef));
      const baselineProfile = baselineAccount && decode(baselineAccount.profile_json);
      const baselineIdentity = baselineAccount && get(`SELECT identity_ref FROM backend_account_official_identities
        WHERE owner_ref=? AND account_ref=? AND subject_ref=? AND server_id=? AND official_uid=? AND evidence_ref=? AND connection_epoch=?`,
      context.ownerRef, String(context.accountRef), context.subjectRef, baselineAccount.server_id, officialUid, responseRef, connectionEpoch);
      const baselineAnchor = get(`SELECT response_ref,request_sequence,official_uid,connection_epoch,game_version,protocol_version
        FROM backend_dynamic_login_identity_anchors WHERE owner_ref=? AND account_ref=? AND subject_ref=? AND owner_epoch=? AND run_epoch=?
        AND connection_epoch=? AND response_ref=?`, context.ownerRef, String(context.accountRef), context.subjectRef, context.ownerEpoch,
      context.runEpoch, connectionEpoch, responseRef);
      const baselineObservedMs = source.receivedDeviceMs;
      if (!baselineOwner || baselineOwner.active !== 1 || baselineOwner.owner_ref !== context.ownerRef || baselineOwner.owner_epoch !== context.ownerEpoch ||
          typeof baselineOwner.executor_ref !== 'string' || !baselineOwner.executor_ref || !baselineAccount || baselineAccount.subject_ref !== context.subjectRef || !Number.isSafeInteger(baselineAccount.server_id) ||
          baselineAccount.server_id < 1 || baselineProfile?.uid !== officialUid || !baselineAccount.verification_ref || !baselineIdentity ||
          !baselineAnchor || baselineAnchor.request_sequence !== requestSequence || baselineAnchor.official_uid !== officialUid ||
          baselineAnchor.game_version !== versionEvidence.gameVersion || baselineAnchor.protocol_version !== versionEvidence.protocolVersion ||
          !Number.isSafeInteger(baselineObservedMs) || baselineObservedMs < 1 || !Number.isFinite(Date.parse(new Date(baselineObservedMs).toISOString()))) {
        return { recorded: false, reasonCode: 'RESOURCE_BASELINE_CURRENT_IDENTITY_ANCHOR_UNPROVEN' };
      }
      const operationRowid = sequences.current('operation', []);
      const sourceFingerprint = fingerprint(JSON.stringify({ responseRef, requestSequence, connectionEpoch, bag: landFrame.bag, coverage: landFrame.coverage }));
      const baselineRef = 'resource-baseline:' + semanticFingerprint([context.ownerRef, context.subjectRef, connectionEpoch, requestSequence, responseRef]);
      const evidence = { version: 'current-resource-baseline/closed-executor-complete-login-bag/v2', context,
        login: { sourceRef: admitted.observation_ref, responseRef, requestSequence, connectionEpoch, sourceFingerprint,
          officialUid, versionEvidence: { source: versionEvidence.source, gameVersion: versionEvidence.gameVersion,
            protocolVersion: versionEvidence.protocolVersion, loginResponseRef: versionEvidence.loginResponseRef },
          absoluteBagComplete: true, absoluteItemFrameRef: itemFrame.observation_ref },
        isolation: isolation ? { evidenceRef: isolation.evidence_ref, sourceRef: isolation.source_ref,
          proofFingerprint: fingerprint(isolation.proof_json) } : null,
        operationWatermark: operationRowid, archivedFootprintsRemainImmutable: true,
        accountingSeparation: 'current-absolute-resource-accounting-only; does-not-prove-historical-success-or-consumption; does-not-authorize-replay',
        note: 'operationWatermark is diagnostic only; resource exclusion requires per-operation links' };
      const existing = get('SELECT * FROM backend_resource_budget_baselines WHERE baseline_ref=?', baselineRef);
      const evidenceJson = JSON.stringify(evidence);
      const makeDescriptor = watermark => Object.freeze({ baselineRef,
        ownerRef: context.ownerRef, accountRef: String(context.accountRef), subjectRef: context.subjectRef,
        ownerEpoch: context.ownerEpoch, runEpoch: context.runEpoch, connectionEpoch,
        observationRef: admitted.observation_ref, payloadFingerprint: effective.payloadFingerprint,
        frameFingerprint: effective.frameFingerprint, compatibilityRef: effective.compatibilityRef ?? null,
        compatibilityProofFingerprint: effective.proofFingerprint ?? null, itemFrameRef: itemFrame.observation_ref,
        responseRef, requestSequence, sourceFingerprint, officialUid, serverId: baselineAccount.server_id,
        observedAt: new Date(baselineObservedMs).toISOString(), identityRef: baselineIdentity.identity_ref,
        currentExecutorRef: baselineOwner.executor_ref, gameVersion: versionEvidence.gameVersion,
        protocolVersion: versionEvidence.protocolVersion, operationWatermark: watermark });
      if (existing) {
        const oldEvidence = decode(existing.evidence_json);
        if (existing.source_fingerprint !== sourceFingerprint || existing.isolation_evidence_ref !== isolationRef ||
            oldEvidence?.login?.sourceRef !== evidence.login.sourceRef ||
            oldEvidence?.isolation?.proofFingerprint !== evidence.isolation?.proofFingerprint) {
          fail('BACKEND_RESOURCE_BASELINE_CONFLICT', 'The same current login cannot be recorded with different resource proof');
        }
        descriptor = makeDescriptor(existing.operation_rowid);
        return { recorded: true, baselineRef, operationWatermark: existing.operation_rowid, replayed: true };
      }
      run(`INSERT INTO backend_resource_budget_baselines VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, baselineRef, context.ownerRef,
        String(context.accountRef), context.subjectRef, connectionEpoch, requestSequence, responseRef, operationRowid,
        sourceFingerprint, isolationRef, evidenceJson, nowIso());
      descriptor = makeDescriptor(operationRowid);
      return { recorded: true, baselineRef, operationWatermark: operationRowid, linkedResources: 0, replayed: false };
    });
    if (result.recorded && descriptor) resourceBaselineProofs.set(JSON.stringify([context.ownerRef, String(context.accountRef), context.subjectRef]), descriptor);
    return result;
  }
  function currentResourceBaselineProof({ context, baselineRef, isCurrent } = {}) {
    if (!object(context) || typeof isCurrent !== 'function' || isCurrent(context) !== true) return null;
    const key = JSON.stringify([context.ownerRef, String(context.accountRef), context.subjectRef]);
    const descriptor = resourceBaselineProofs.get(key);
    if (!descriptor || descriptor.baselineRef !== baselineRef ||
        descriptor.ownerRef !== context.ownerRef || descriptor.accountRef !== String(context.accountRef) || descriptor.subjectRef !== context.subjectRef ||
        descriptor.ownerEpoch !== context.ownerEpoch || descriptor.runEpoch !== context.runEpoch || descriptor.connectionEpoch !== context.connectionEpoch) return null;
    const baseline = get('SELECT * FROM backend_resource_budget_baselines WHERE baseline_ref=?', baselineRef);
    if (!baseline || baseline.owner_ref !== descriptor.ownerRef || String(baseline.account_ref) !== descriptor.accountRef ||
        baseline.subject_ref !== descriptor.subjectRef || baseline.connection_epoch !== descriptor.connectionEpoch ||
        baseline.request_sequence !== descriptor.requestSequence || baseline.response_ref !== descriptor.responseRef ||
        baseline.source_fingerprint !== descriptor.sourceFingerprint || baseline.operation_rowid !== descriptor.operationWatermark) return null;
    const evidence = decode(baseline.evidence_json);
    if (!object(evidence) || !object(evidence.context) || evidence.context.ownerRef !== descriptor.ownerRef ||
        String(evidence.context.accountRef) !== descriptor.accountRef || evidence.context.subjectRef !== descriptor.subjectRef ||
        evidence.context.ownerEpoch !== descriptor.ownerEpoch || evidence.context.runEpoch !== descriptor.runEpoch ||
        evidence.context.connectionEpoch !== descriptor.connectionEpoch) return null;
    const intent = get('SELECT subject_ref,desired_running,run_epoch,connection_epoch FROM backend_run_intents WHERE owner_ref=? AND account_ref=?',
      descriptor.ownerRef, descriptor.accountRef);
    const owner = get('SELECT owner_ref,owner_epoch,executor_ref,active FROM backend_subject_owners WHERE subject_ref=?', descriptor.subjectRef);
    const account = get(`SELECT subject_ref,server_id,profile_json,verification_ref FROM backend_accounts
      WHERE owner_ref=? AND account_id=? AND removed_at IS NULL`, descriptor.ownerRef, Number(descriptor.accountRef));
    let profile;
    try { profile = account && decode(account.profile_json); } catch { return null; }
    if (intent?.desired_running !== 1 || intent.subject_ref !== descriptor.subjectRef || intent.run_epoch !== descriptor.runEpoch ||
        intent.connection_epoch !== descriptor.connectionEpoch || owner?.active !== 1 || owner.owner_ref !== descriptor.ownerRef ||
        owner.owner_epoch !== descriptor.ownerEpoch || owner.executor_ref !== descriptor.currentExecutorRef ||
        !account || account.subject_ref !== descriptor.subjectRef || account.server_id !== descriptor.serverId ||
        profile?.uid !== descriptor.officialUid || account.verification_ref == null || account.verification_ref === '') return null;
    const observation = get(`SELECT observation_ref,owner_ref,account_ref,subject_ref,connection_epoch,request_sequence,response_ref,
      payload_fingerprint,accepted,reason_code,frame_json
      FROM backend_land_domain_observations WHERE observation_ref=?`, descriptor.observationRef);
    let observationReceivedMs;
    try { observationReceivedMs = observation && parseEvidence(observation.frame_json, 'resource baseline observation').source?.receivedDeviceMs; }
    catch { return null; }
    if (!observation || observation.owner_ref !== descriptor.ownerRef || observation.account_ref !== descriptor.accountRef ||
        observation.subject_ref !== descriptor.subjectRef || observation.connection_epoch !== descriptor.connectionEpoch ||
        observation.request_sequence !== descriptor.requestSequence || observation.response_ref !== descriptor.responseRef ||
        observation.payload_fingerprint !== descriptor.payloadFingerprint || observationReceivedMs !== Date.parse(descriptor.observedAt)) return null;
    if (observation.accepted !== 1) {
      const compatibility = descriptor.compatibilityRef && get(`SELECT revalidation_ref,observation_ref,payload_fingerprint,proof_fingerprint,accepted,reason_code
        FROM backend_land_domain_compatibility_revalidations WHERE revalidation_ref=? AND observation_ref=? AND payload_fingerprint=? AND proof_fingerprint=?`,
      descriptor.compatibilityRef, descriptor.observationRef, descriptor.payloadFingerprint, descriptor.compatibilityProofFingerprint);
      if (observation.accepted !== 0 || observation.reason_code == null || !compatibility || compatibility.accepted !== 1 ||
          compatibility.reason_code !== null || compatibility.proof_fingerprint !== descriptor.compatibilityProofFingerprint) return null;
    } else if (observation.reason_code !== null) return null;
    const identity = get(`SELECT identity_ref,server_id,official_uid,evidence_ref,connection_epoch FROM backend_account_official_identities
      WHERE identity_ref=? AND owner_ref=? AND account_ref=? AND subject_ref=?`, descriptor.identityRef,
    descriptor.ownerRef, descriptor.accountRef, descriptor.subjectRef);
    const anchor = get(`SELECT owner_ref,account_ref,subject_ref,owner_epoch,run_epoch,connection_epoch,response_ref,request_sequence,
      official_uid,game_version,protocol_version FROM backend_dynamic_login_identity_anchors
      WHERE owner_ref=? AND account_ref=? AND subject_ref=? AND owner_epoch=? AND run_epoch=? AND connection_epoch=? AND response_ref=?`,
    descriptor.ownerRef, descriptor.accountRef, descriptor.subjectRef, descriptor.ownerEpoch, descriptor.runEpoch,
    descriptor.connectionEpoch, descriptor.responseRef);
    const itemFrame = get(`SELECT observation_ref FROM backend_official_item_frames WHERE observation_ref=? AND owner_ref=? AND account_ref=? AND subject_ref=?
      AND connection_epoch=? AND request_sequence=? AND response_ref=?`, descriptor.itemFrameRef, descriptor.ownerRef, descriptor.accountRef,
    descriptor.subjectRef, descriptor.connectionEpoch, descriptor.requestSequence, descriptor.responseRef);
    if (!identity || identity.server_id !== descriptor.serverId || identity.official_uid !== descriptor.officialUid ||
        identity.evidence_ref !== descriptor.responseRef || identity.connection_epoch !== descriptor.connectionEpoch || !anchor ||
        anchor.request_sequence !== descriptor.requestSequence || anchor.official_uid !== descriptor.officialUid ||
        anchor.game_version !== descriptor.gameVersion || anchor.protocol_version !== descriptor.protocolVersion || !itemFrame) return null;
    if (isCurrent(context) !== true) return null;
    return descriptor;
  }
  function nextResourceBaselineCandidate(descriptor, afterOperationId = '') {
    return get(`SELECT o.operation_sequence AS operation_rowid,o.* FROM backend_resource_budget_active a
      JOIN backend_operations o ON o.operation_id=a.operation_id
      WHERE a.owner_ref=? AND a.subject_ref=? AND a.resource_kind='item' AND o.account_ref=?
      AND o.connection_epoch<? AND o.operation_sequence<=? AND o.write_slot=0 AND a.operation_id>?
      ORDER BY a.operation_id LIMIT 1`, descriptor.ownerRef, descriptor.subjectRef, descriptor.accountRef,
    descriptor.connectionEpoch, descriptor.operationWatermark, afterOperationId);
  }
  function hasPendingResourceBaselineOperations(descriptor) {
    return Boolean(get(`SELECT 1 AS pending FROM backend_resource_budget_active a
      JOIN backend_operations o ON o.operation_id=a.operation_id
      WHERE a.owner_ref=? AND a.subject_ref=? AND a.resource_kind='item' AND o.account_ref=?
      AND o.connection_epoch<? AND o.operation_sequence<=? LIMIT 1`, descriptor.ownerRef, descriptor.subjectRef, descriptor.accountRef,
    descriptor.connectionEpoch, descriptor.operationWatermark));
  }
  function resolveResourceBaselineClosure(descriptor, candidate) {
    let original;
    try { original = decode(candidate.original_json); } catch { return null; }
    if (fingerprint(candidate.original_json) !== candidate.original_fingerprint || original?.operationId !== candidate.operation_id ||
        original.ownerRef !== descriptor.ownerRef || original.ownerRef !== candidate.owner_ref || String(original.accountRef) !== String(candidate.account_ref) ||
        original.accountRef !== descriptor.accountRef || original.subjectRef !== candidate.subject_ref ||
        original.subjectRef !== descriptor.subjectRef || original.runEpoch !== candidate.run_epoch ||
        original.connectionEpoch !== candidate.connection_epoch || !Number.isSafeInteger(original.ownerEpoch) ||
        typeof original.executorRef !== 'string' || !original.executorRef || original.featureId !== candidate.feature_id ||
        original.scope !== candidate.scope || original.method !== candidate.method || original.paramsFingerprint !== candidate.params_fingerprint) return null;
    const binding = get('SELECT subject_ref FROM backend_subject_bindings WHERE owner_ref=? AND account_ref=?',
      descriptor.ownerRef, String(candidate.account_ref));
    if (!binding || binding.subject_ref !== descriptor.subjectRef) return null;
    const closure = get(`SELECT evidence_ref,owner_ref,account_ref,subject_ref,executor_ref,owner_epoch,run_epoch,connection_epoch,
      proof_kind,proof_json,recorded_at FROM backend_session_connection_closures
      WHERE owner_ref=? AND account_ref=? AND subject_ref=? AND owner_epoch=? AND run_epoch=? AND connection_epoch=? AND executor_ref=?
      AND proof_kind='transport-closed' ORDER BY recorded_at DESC LIMIT 1`, descriptor.ownerRef, String(candidate.account_ref),
    descriptor.subjectRef, original.ownerEpoch, candidate.run_epoch, candidate.connection_epoch, original.executorRef);
    let proof;
    try { proof = closure && decode(closure.proof_json); } catch { proof = null; }
    const loginMs = Date.parse(descriptor.observedAt), closedMs = Date.parse(closure?.recorded_at);
    if (closure && closure.owner_ref === descriptor.ownerRef && String(closure.account_ref) === descriptor.accountRef &&
        closure.subject_ref === descriptor.subjectRef && closure.owner_epoch === original.ownerEpoch && closure.run_epoch === candidate.run_epoch &&
        closure.connection_epoch === candidate.connection_epoch && closure.executor_ref === original.executorRef &&
        proof?.closed === true && proof.connectionEpoch === candidate.connection_epoch &&
        ['transport-close-receipt', 'connect-rejected-after-physical-close'].includes(proof.source) &&
        Number.isFinite(loginMs) && Number.isFinite(closedMs) && loginMs >= closedMs) {
      return { evidenceRef: closure.evidence_ref, evidenceHash: fingerprint(closure.proof_json), recordedAt: closure.recorded_at };
    }
    const physical = get(`SELECT evidence_ref,owner_ref,account_ref,subject_ref,executor_ref,owner_epoch,run_epoch,connection_epoch,
      proof_kind,proof_json,recorded_at FROM backend_session_connection_closures
      WHERE owner_ref=? AND account_ref=? AND subject_ref=? AND owner_epoch=? AND run_epoch=? AND connection_epoch=? AND executor_ref=?
      AND proof_kind='verification-snapshot-physical-close' ORDER BY recorded_at DESC LIMIT 1`, descriptor.ownerRef, String(candidate.account_ref),
    descriptor.subjectRef, original.ownerEpoch, candidate.run_epoch, candidate.connection_epoch, original.executorRef);
    let physicalProof;
    try { physicalProof = physical && decode(physical.proof_json); } catch { physicalProof = null; }
    if (physical && physical.owner_ref === descriptor.ownerRef && String(physical.account_ref) === descriptor.accountRef &&
        physical.subject_ref === descriptor.subjectRef && physical.executor_ref === original.executorRef &&
        physical.owner_epoch === original.ownerEpoch && physical.run_epoch === candidate.run_epoch &&
        physical.connection_epoch === candidate.connection_epoch && physicalProof) {
      const resolved = resolveExecutionClosureEvidence({ store, operationId: candidate.operation_id, operation: candidate,
        saved: original, checkpoint: { ...descriptor, uid: descriptor.officialUid }, row: physical, proof: physicalProof });
      if (resolved?.closed === true && resolved.executionClosed === true) return {
        evidenceRef: resolved.evidenceRef, evidenceHash: resolved.evidenceHash, recordedAt: physical.recorded_at };
    }
    const currentExecutor = get('SELECT app_id FROM backend_local_executors WHERE executor_ref=?', descriptor.currentExecutorRef);
    const native = currentExecutor && resolveNativeExecutorExitProof({ store, appId: currentExecutor.app_id,
      subjectRef: descriptor.subjectRef, executorRef: original.executorRef, ownerEpoch: original.ownerEpoch,
      exactEvidenceRef: `local-executor-exit:${original.executorRef}:${original.ownerEpoch}` });
    const nativeMs = Date.parse(native?.recordedAt);
    if (!native || !Number.isFinite(nativeMs) || !Number.isFinite(loginMs) || loginMs < nativeMs) return null;
    return { evidenceRef: native.evidenceRef, evidenceHash: native.proofFingerprint, recordedAt: native.recordedAt };
  }
  function reconcileCurrentResourceBaseline({ context, baselineRef, isCurrent } = {}) {
    const key = JSON.stringify([context?.ownerRef, String(context?.accountRef), context?.subjectRef]);
    let cursorAfter = resourceBaselineCursors.get(key) || '';
    let committedCursor = cursorAfter, result;
    try {
      result = transaction(() => {
        const descriptor = currentResourceBaselineProof({ context, baselineRef, isCurrent });
        if (!descriptor) return { current: false, scanned: 0, linkedResources: 0, hasMore: false, sweepComplete: false };
        const stale = () => { throw Object.assign(new Error('Current resource baseline changed during bounded reconciliation'), { code: 'RESOURCE_BASELINE_PROOF_STALE' }); };
        let candidate = nextResourceBaselineCandidate(descriptor, cursorAfter);
        if (!candidate && cursorAfter) {
          candidate = nextResourceBaselineCandidate(descriptor, '');
          if (candidate) cursorAfter = '';
        }
        if (!candidate) {
          if (currentResourceBaselineProof({ context, baselineRef, isCurrent }) !== descriptor) stale();
          committedCursor = '';
          const hasPending = hasPendingResourceBaselineOperations(descriptor);
          return { current: true, scanned: 0, linkedResources: 0, hasMore: false, hasPending, sweepComplete: !hasPending,
            outcomeProven: false, resourceCoverageProven: false, originalOutcomesUnchanged: true, originalFootprintsUnchanged: true };
        }
        let closure = null;
        try { closure = resolveResourceBaselineClosure(descriptor, candidate); } catch { closure = null; }
        const pending = nextResourceBaselineCandidate(descriptor, candidate.operation_id);
        let linkedResources = 0;
        if (closure) {
          const resources = all(`SELECT resource_key,resource_kind FROM backend_operation_resources
            WHERE operation_id=? AND state!='released' AND resource_kind='item'`, candidate.operation_id);
          for (const resource of resources) {
            const priorLink = get(`SELECT baseline_ref FROM backend_resource_budget_baseline_links
              WHERE operation_id=? AND resource_key=? AND resource_kind=? LIMIT 1`,
            candidate.operation_id, resource.resource_key, resource.resource_kind);
            if (priorLink) continue;
            const inserted = run('INSERT OR IGNORE INTO backend_resource_budget_baseline_links VALUES(?,?,?,?,?,?,?)', baselineRef,
              candidate.operation_id, resource.resource_key, resource.resource_kind, closure.evidenceRef, closure.evidenceHash, nowIso());
            linkedResources += Number(inserted?.changes || 0);
          }
        }
        const hasPending = hasPendingResourceBaselineOperations(descriptor);
        if (currentResourceBaselineProof({ context, baselineRef, isCurrent }) !== descriptor) stale();
        committedCursor = pending ? candidate.operation_id : '';
        return { current: true, scanned: 1, linkedResources, hasMore: Boolean(pending), hasPending, sweepComplete: !pending,
          operationId: candidate.operation_id, closureEvidenceRef: closure?.evidenceRef ?? null,
          closureEvidenceHash: closure?.evidenceHash ?? null, closureRecordedAt: closure?.recordedAt ?? null,
          outcomeProven: false, resourceCoverageProven: false, originalOutcomesUnchanged: true, originalFootprintsUnchanged: true };
      });
    } catch (error) {
      if (error?.code === 'RESOURCE_BASELINE_PROOF_STALE') return { current: false, scanned: 0, linkedResources: 0, hasMore: false,
        hasPending: false, sweepComplete: false, outcomeProven: false, resourceCoverageProven: false,
        originalOutcomesUnchanged: true, originalFootprintsUnchanged: true };
      throw error;
    }
    if (result.current) resourceBaselineCursors.set(key, committedCursor);
    return result;
  }
  function recordCurrentCurrencyBaseline({ context, responseRef, requestSequence, connectionEpoch, executorIsolation = null,
    officialUid, versionEvidence, currency = 'gold' } = {}) {
    if (!['gold', 'yuanbao'].includes(currency) || !object(context) || !['ownerRef','accountRef','subjectRef'].every(key => typeof context[key] === 'string' && context[key].length > 0) ||
        !['ownerEpoch','runEpoch'].every(key => Number.isSafeInteger(context[key]) && context[key] > 0) ||
        !Number.isSafeInteger(connectionEpoch) || connectionEpoch < 1 || !Number.isSafeInteger(requestSequence) || requestSequence < 1 ||
        typeof responseRef !== 'string' || !responseRef || !Number.isSafeInteger(officialUid) || officialUid < 1) return { recorded: false, reasonCode: 'CURRENCY_BASELINE_INPUT_INVALID' };
    return transaction(() => {
      const admitted = get(`SELECT * FROM backend_land_domain_observations WHERE observation_ref=? AND owner_ref=? AND account_ref=?
        AND subject_ref=? AND connection_epoch=? AND request_sequence=? AND response_ref=?`,
      'land-observation:' + semanticFingerprint([context.ownerRef, context.subjectRef, connectionEpoch, responseRef]), context.ownerRef,
      String(context.accountRef), context.subjectRef, connectionEpoch, requestSequence, responseRef);
      if (!admitted) return { recorded: false, reasonCode: 'CURRENCY_BASELINE_LOGIN_NOT_ADMITTED' };
      const resolved = resolveAcceptedLandObservationEvidence({ store, context: { ...context, accountRef: String(context.accountRef), connectionEpoch }, observationRef: admitted.observation_ref });
      const frame = resolved?.accepted ? resolved.frame : null, currencyCell = frame?.profile?.[currency], source = currencyCell?.source;
      const item = get(`SELECT * FROM backend_official_item_frames WHERE owner_ref=? AND account_ref=? AND subject_ref=? AND connection_epoch=? AND request_sequence=? AND response_ref=?`,
        context.ownerRef, String(context.accountRef), context.subjectRef, connectionEpoch, requestSequence, responseRef);
      if (!frame || frame.source?.kind !== 'response' || frame.source?.method !== 'index.login' || frame.source?.responseRef !== responseRef ||
          frame.source?.connectionEpoch !== connectionEpoch || frame.source?.requestSequence !== requestSequence ||
          frame.profile?.uid?.state !== 'known' || frame.profile.uid.value !== officialUid || currencyCell?.state !== 'known' ||
          !Number.isSafeInteger(currencyCell.value) || currencyCell.value < 0 || source?.kind !== 'response' || source?.responseRef !== responseRef ||
          source?.connectionEpoch !== connectionEpoch || source?.requestSequence !== requestSequence || !item ||
          versionEvidence?.loginResponseRef !== responseRef || versionEvidence?.source !== 'normal-package-hop-and-matched-world-login/v1')
        return { recorded: false, reasonCode: `CURRENCY_BASELINE_ABSOLUTE_PROFILE_${currency.toUpperCase()}_UNPROVEN` };
      const baseRef = (currency === 'gold' ? 'currency-baseline:' : 'currency-baseline:yuanbao:') + semanticFingerprint([context.ownerRef, context.subjectRef, connectionEpoch, requestSequence, responseRef]);
      const sourceFingerprint = semanticFingerprint([responseRef, requestSequence, connectionEpoch, officialUid, currencyCell.value, currencyCell.sourceRef || null]);
      const evidence = { version: `current-currency-baseline/profile-${currency}/v1`, context,
        login: { sourceRef: admitted.observation_ref, responseRef, requestSequence, connectionEpoch, officialUid, value: currencyCell.value,
          source: source, sourceFingerprint, versionEvidence: { source: versionEvidence.source, gameVersion: versionEvidence.gameVersion,
            protocolVersion: versionEvidence.protocolVersion, loginResponseRef: versionEvidence.loginResponseRef } },
        isolation: executorIsolation ? { evidenceRef: executorIsolation.evidenceRef, sourceRef: executorIsolation.sourceRef } : null,
        accounting: `current profile.${currency} only; old verdicts and original resources remain immutable` };
      // The legacy table's source tuple is unique and represents gold only.
      // Yuanbao uses an operation-bound admission proof only when an actual
      // historical footprint exits; it never creates a second per-login log.
      const prior = currency === 'gold' ? get('SELECT * FROM backend_currency_budget_baselines WHERE baseline_ref=?', baseRef) : null;
      if (prior && (prior.source_fingerprint !== sourceFingerprint || prior.value !== currencyCell.value)) fail('CURRENCY_BASELINE_CONFLICT', 'Currency baseline source conflict');
      if (currency === 'gold' && !prior) run('INSERT INTO backend_currency_budget_baselines VALUES(?,?,?,?,?,?,?,?,?,?,?)', baseRef, context.ownerRef, String(context.accountRef),
        context.subjectRef, connectionEpoch, requestSequence, responseRef, currencyCell.value, sourceFingerprint, json(evidence), nowIso());
      let linkedResources = 0;
      if (executorIsolation?.isolated === true && typeof executorIsolation.evidenceRef === 'string' && typeof executorIsolation.sourceRef === 'string') {
        const candidates = all(`SELECT o.operation_id,o.original_json,o.original_fingerprint,o.account_ref,o.run_epoch,o.connection_epoch,o.write_slot,
          r.resource_key,r.resource_kind FROM backend_resource_budget_active a JOIN backend_operations o ON o.operation_id=a.operation_id
          JOIN backend_operation_resources r ON r.operation_id=a.operation_id AND r.resource_key=a.resource_key
          WHERE a.owner_ref=? AND a.subject_ref=? AND ((a.resource_kind='currency' AND r.resource_ref=?)
            OR (a.resource_kind='item' AND r.resource_ref=?)) AND o.connection_epoch<? AND o.write_slot=0`,
        context.ownerRef, context.subjectRef, 'currency:' + currency, 'item:' + (currency === 'gold' ? 11 : 1), connectionEpoch);
        for (const row of candidates) {
          const original = decode(row.original_json);
          if (fingerprint(row.original_json) !== row.original_fingerprint || original.accountRef !== row.account_ref || original.runEpoch !== row.run_epoch ||
              original.ownerRef !== context.ownerRef || original.subjectRef !== context.subjectRef || original.connectionEpoch !== row.connection_epoch ||
              !Number.isSafeInteger(original.ownerEpoch) || !original.executorRef) continue;
          const oldBinding = get('SELECT subject_ref FROM backend_subject_bindings WHERE owner_ref=? AND account_ref=?', context.ownerRef, row.account_ref);
          if (!oldBinding || oldBinding.subject_ref !== context.subjectRef) continue;
          const close = get(`SELECT evidence_ref,proof_json FROM backend_session_connection_closures WHERE owner_ref=? AND account_ref=? AND subject_ref=?
            AND owner_epoch=? AND run_epoch=? AND connection_epoch=? AND executor_ref=? AND proof_kind='transport-closed' ORDER BY recorded_at DESC LIMIT 1`,
          context.ownerRef, row.account_ref, context.subjectRef, original.ownerEpoch, row.run_epoch, row.connection_epoch, original.executorRef);
          const proof = close && decode(close.proof_json);
          if (!close || proof?.closed !== true || proof.connectionEpoch !== row.connection_epoch ||
              !['transport-close-receipt','connect-rejected-after-physical-close'].includes(proof.source)) continue;
          let linkRef = baseRef;
          if (currency === 'yuanbao') {
            const admission = recordAdmissionBasis({ operationId: row.operation_id,
              constraintKey: 'currency-accounting:yuanbao:' + row.resource_key, basisKey: baseRef,
              conclusion: 'permit_current', factBasis: evidence.login,
              affected: { operationId: row.operation_id, resourceKey: row.resource_key, currentBudgetOnly: true, doesNotAuthorizeReplay: true },
              evidence: { currency, login: evidence.login, executorIsolation: evidence.isolation,
                closureRef: close.evidence_ref, closureFingerprint: fingerprint(close.proof_json) },
              reasonCode: 'CURRENT_YUANBAO_ABSOLUTE_ACCOUNTING' });
            linkRef = 'currency-admission:' + admission.basisId;
          }
          run('INSERT OR IGNORE INTO backend_resource_budget_baseline_links VALUES(?,?,?,?,?,?,?)', linkRef, row.operation_id, row.resource_key,
            row.resource_kind, close.evidence_ref, fingerprint(close.proof_json), nowIso());
          linkedResources += 1;
        }
      }
      return { recorded: currency === 'gold' || linkedResources > 0, baselineRef: baseRef, value: currencyCell.value, linkedResources, replayed: !!prior,
        ...(currency === 'yuanbao' && !linkedResources ? { reasonCode: 'CURRENCY_HISTORICAL_ISOLATION_NOT_PROVEN' } : {}) };
    });
  }
  function currentAdmission({ ownerRef = null, subjectRef, targetRefs = null, featureIds = null } = {}) {
    textValue(subjectRef, 'subjectRef');
    const targets = targetRefs === null ? null : [...new Set(targetRefs.map((value, index) => textValue(value, 'targetRefs[' + index + ']')))];
    const features = featureIds === null ? null : [...new Set(featureIds.map((value, index) => textValue(value, 'featureIds[' + index + ']')))];
    const featureSql = features?.length ? ` AND o.feature_id IN (${features.map(() => '?').join(',')})` : features ? ' AND 0' : '';
    const targetSql = targets?.length ? ` AND EXISTS(SELECT 1 FROM backend_operation_targets t WHERE t.operation_id=o.operation_id
      AND t.target_ref IN (${targets.map(() => '?').join(',')}))` : targets ? ' AND 0' : '';
    const hasCurrentNeedReconciliations = Boolean(get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='backend_current_need_reconciliations'"));
    const reconciledSql = hasCurrentNeedReconciliations ? ` AND EXISTS(SELECT 1 FROM backend_operation_targets t WHERE t.operation_id=o.operation_id
      ${targets?.length ? `AND t.target_ref IN (${targets.map(() => '?').join(',')})` : targets ? 'AND 0' : ''}
      AND NOT EXISTS(SELECT 1 FROM backend_current_need_reconciliations n WHERE n.owner_ref=o.owner_ref AND n.subject_ref=o.subject_ref
        AND n.original_operation_id=o.operation_id AND n.original_fingerprint=o.original_fingerprint AND n.feature_id=o.feature_id
        AND n.target_ref=t.target_ref))` : '';
    const filteredParams = [...(features || []), ...(targets || []), ...(hasCurrentNeedReconciliations ? targets || [] : [])];
    // A target-scoped query keeps the global write slot visible while reading
    // only unresolved operations that can affect this candidate. Full history
    // remains available through operationsPage and unfiltered currentAdmission.
    const operations = all(`SELECT * FROM backend_operations o WHERE o.subject_ref=? AND (o.write_slot=1 OR
      (o.business_verdict IN ('unverified','unknown')${featureSql}${targetSql}${reconciledSql})) ORDER BY o.prepared_at,o.operation_id`, subjectRef, ...filteredParams);
    const baseline = ownerRef === null ? null : get(`SELECT * FROM backend_resource_budget_baselines WHERE owner_ref=? AND subject_ref=?
      ORDER BY connection_epoch DESC,request_sequence DESC,recorded_at DESC LIMIT 1`, textValue(ownerRef, 'ownerRef'), subjectRef);
    const resourceFootprints = all(`SELECT r.*,o.subject_ref,o.owner_ref,o.connection_epoch,o.operation_sequence AS operation_rowid FROM backend_resource_budget_active active
      JOIN backend_operation_resources r ON r.operation_id=active.operation_id AND r.resource_key=active.resource_key
      JOIN backend_operations o ON o.operation_id=active.operation_id
      WHERE active.subject_ref=? ORDER BY o.operation_sequence,r.resource_key`, subjectRef);
    const operationIds = operations.map(item => item.operation_id);
    const bases = operationIds.length ? all(`SELECT a.*,o.revision AS current_operation_revision FROM backend_admission_basis a
      JOIN backend_operations o ON o.operation_id=a.operation_id WHERE a.subject_ref=? AND a.operation_id IN (${operationIds.map(() => '?').join(',')}) AND NOT EXISTS(
      SELECT 1 FROM backend_admission_basis newer WHERE newer.operation_id=a.operation_id
      AND newer.constraint_key=a.constraint_key AND newer.basis_id>a.basis_id) ORDER BY a.basis_id`, subjectRef, ...operationIds)
      .map(basis => ({ ...basis, basisCurrent: basis.operation_revision === basis.current_operation_revision,
        factBasis: decode(basis.fact_basis_json), affected: decode(basis.affected_json), evidence: decode(basis.evidence_json) })) : [];
    return {
      subjectRef, activeOperation: operations.find(item => item.write_slot === 1) || null,
      unresolvedOperations: operations.filter(item => ['unverified', 'unknown'].includes(item.business_verdict)),
      resourceFootprints, resourceBaseline: baseline ? { baselineRef: baseline.baseline_ref, connectionEpoch: baseline.connection_epoch,
        requestSequence: baseline.request_sequence, operationWatermark: baseline.operation_rowid, recordedAt: baseline.recorded_at } : null, bases,
      // No generic eligible=true: domain admission checks the current facts and
      // exact target/resource scope. Old audit verdicts stay unchanged.
    };
  }
  function releaseHistoricalWriteSlot({ operationId, expectedRevision, basisId,
    transportTermination, executorIsolation, checkpoint, evidence } = {}) {
    integer(expectedRevision, 'expectedRevision'); integer(basisId, 'basisId');
    const endedProof = terminationProof(transportTermination);
    if (!object(executorIsolation) || executorIsolation.isolated !== true) throw new TypeError('Historical slot release requires exact old-executor isolation proof');
    textValue(executorIsolation.source, 'executorIsolation.source');
    if (!object(checkpoint) || !object(checkpoint.factBasis) || !Object.keys(checkpoint.factBasis).length) {
      throw new TypeError('Historical slot release requires a current official checkpoint and explicit fact basis');
    }
    textValue(checkpoint.source, 'checkpoint.source'); textValue(checkpoint.checkpointRef, 'checkpoint.checkpointRef');
    timestamp(checkpoint.observedAt, 'checkpoint.observedAt');
    integer(checkpoint.runEpoch, 'checkpoint.runEpoch'); integer(checkpoint.connectionEpoch, 'checkpoint.connectionEpoch');
    return transaction(() => {
      const found = required(operationId, expectedRevision);
      if (found.write_slot !== 1 || !['not_started', 'may_have_sent', 'answered', 'terminated', 'unknown'].includes(found.transport_state)) {
        fail('BACKEND_HISTORICAL_SLOT_INVALID', 'Only an isolated historical possible-send slot can use historical release');
      }
      if (executorIsolation.ownerRef !== found.owner_ref || executorIsolation.runEpoch !== found.run_epoch
        || executorIsolation.connectionEpoch !== found.connection_epoch ||
        decode(found.original_json).ownerEpoch !== undefined && executorIsolation.ownerEpoch !== decode(found.original_json).ownerEpoch ||
        decode(found.original_json).executorRef !== undefined && executorIsolation.executorRef !== decode(found.original_json).executorRef) {
        fail('BACKEND_EXECUTOR_PROOF_MISMATCH', 'Isolation proof does not identify the original executor');
      }
      // Connection epochs are subject-wide; run epochs belong to an account
      // alias and can restart at one after a normal remove/re-add.
      if (checkpoint.subjectRef !== found.subject_ref || checkpoint.connectionEpoch <= found.connection_epoch) {
        fail('BACKEND_CHECKPOINT_NOT_CURRENT', 'Checkpoint must identify the same subject in a later run or connection');
      }
      const basis = get('SELECT * FROM backend_admission_basis WHERE basis_id=? AND operation_id=?', basisId, operationId);
      const affected = basis ? decode(basis.affected_json) : null;
      if (!basis || basis.conclusion !== 'permit_current' || basis.constraint_key !== 'write-slot'
        || basis.operation_revision !== found.revision || affected.operationId !== operationId || affected.writeSlot !== 'historical'
        || json(decode(basis.fact_basis_json)) !== json(checkpoint.factBasis)) {
        fail('BACKEND_SLOT_ADMISSION_MISSING', 'Historical slot release requires a fresh matching write-slot admission basis');
      }
      evidenceFor(operationId, { ...evidence, payload: { ...evidence?.payload, basisId,
        transportTermination: endedProof, executorIsolation, checkpoint } }, 'historical-write-slot-release');
      // No verdict or transport rewrite, and no resource release. The domain
      // still has to judge each historical target/resource footprint separately.
      run('UPDATE backend_operations SET write_slot=0,revision=revision+1,updated_at=? WHERE operation_id=?', nowIso(), operationId);
      run("UPDATE backend_operation_resources SET state='historical_footprint',updated_at=? WHERE operation_id=? AND state!='released'", nowIso(), operationId);
      return operation(operationId);
    });
  }
  function outboxEvent(found) {
    return { eventId: Number(found.event_id), ownerRef: found.owner_ref, subjectRef: found.subject_ref,
      eventType: found.event_type, eventKey: found.event_key, configRevision: found.config_revision,
      payload: decode(found.payload_json), occurredAt: found.occurred_at, recordedAt: found.recorded_at };
  }
  const schedulerConsumer = (consumerId, ownerRef, subjectRef) => typeof ownerRef === 'string' && typeof subjectRef === 'string' &&
    consumerId.startsWith(`scheduler:${ownerRef}:${subjectRef}:`) && consumerId.length > `scheduler:${ownerRef}:${subjectRef}:`.length;
  const acknowledgedSql = (event, consumer) => `(EXISTS(SELECT 1 FROM backend_outbox_receipts r
    WHERE r.event_id=${event}.event_id AND r.consumer_id=${consumer}) OR EXISTS(
      SELECT 1 FROM backend_outbox_confirmed_progress c WHERE c.consumer_id=${consumer}
      AND c.owner_ref=${event}.owner_ref AND c.subject_ref=${event}.subject_ref AND ${event}.event_id<=c.examined_through
      AND NOT EXISTS(SELECT 1 FROM backend_outbox_scan_pending h WHERE h.consumer_id=c.consumer_id
        AND h.owner_ref=c.owner_ref AND h.subject_ref=c.subject_ref AND h.event_id=${event}.event_id)))`;
  function advanceConfirmed(stateKey, examinedThrough = null) {
    const progress = get(`SELECT * FROM backend_outbox_confirmed_progress WHERE consumer_id=? AND owner_ref=? AND subject_ref=?`, ...stateKey);
    if (!progress) return;
    const examined = examinedThrough ?? progress.examined_through;
    const hole = get(`SELECT MIN(event_id) AS event_id FROM backend_outbox_scan_pending
      WHERE consumer_id=? AND owner_ref=? AND subject_ref=? AND event_id<=?`, ...stateKey, examined)?.event_id;
    const confirmed = hole === null || hole === undefined ? examined : Number(hole) - 1;
    if (examined < progress.examined_through || confirmed < progress.confirmed_through)
      fail('BACKEND_EVENT_CONFIRMATION_CONFLICT', 'Outbox confirmation roots and unconfirmed holes disagree');
    if (examined !== progress.examined_through || confirmed !== progress.confirmed_through)
      run(`UPDATE backend_outbox_confirmed_progress SET confirmed_through=?,examined_through=?,confirmed_at=?
        WHERE consumer_id=? AND owner_ref=? AND subject_ref=?`, confirmed, examined, nowIso(), ...stateKey);
  }
  function appendOutbox({ ownerRef, subjectRef = null, eventType, eventKey, payload, configRevision = null, occurredAt = null } = {}) {
    textValue(ownerRef, 'ownerRef'); textValue(eventType, 'eventType'); textValue(eventKey, 'eventKey');
    if (subjectRef !== null) textValue(subjectRef, 'subjectRef');
    if (configRevision !== null) integer(configRevision, 'configRevision');
    if (occurredAt !== null) timestamp(occurredAt, 'occurredAt');
    const payloadJson = json(payload);
    const payloadFingerprint = fingerprint(json({ subjectRef, configRevision, payload: decode(payloadJson) }));
    return transaction(() => {
      const existing = get('SELECT * FROM backend_outbox WHERE owner_ref=? AND event_type=? AND event_key=?', ownerRef, eventType, eventKey);
      if (existing) {
        if (existing.payload_fingerprint !== payloadFingerprint || occurredAt !== null && existing.occurred_at !== occurredAt) {
          fail('BACKEND_EVENT_ID_CONFLICT', 'Event key was reused with different immutable contents');
        }
        return { ...outboxEvent(existing), replayed: true };
      }
      const at = nowIso();
      const result = run(`INSERT INTO backend_outbox(owner_ref,subject_ref,event_type,event_key,config_revision,payload_json,
        payload_fingerprint,occurred_at,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      ownerRef, subjectRef, eventType, eventKey, configRevision, payloadJson, payloadFingerprint, occurredAt || at, at);
      return { ...outboxEvent(get('SELECT * FROM backend_outbox WHERE event_id=?', Number(result.lastInsertRowid))), replayed: false };
    });
  }
  function readPendingOutbox({ consumerId, ownerRef = null, subjectRef = null, eventType = null, afterEventId = 0, limit = 100 } = {}) {
    consumerId = textValue(consumerId, 'consumerId');
    if(outboxConsumerRetired(store,consumerId))fail('BACKEND_EVENT_CONSUMER_RETIRED','This obsolete subscription has verified replacements; use the registered work-unit consumers');
    integer(afterEventId, 'afterEventId');
    limit = boundedLimit(limit);
    const clauses = ['NOT ' + acknowledgedSql('e', '?1')];
    const params = [consumerId];
    if (afterEventId > 0) { clauses.push('e.event_id>?'); params.push(afterEventId); }
    for (const [column, value] of [['owner_ref', ownerRef], ['subject_ref', subjectRef], ['event_type', eventType]]) {
      if (value !== null) { clauses.push('e.' + column + '=?'); params.push(textValue(value, column)); }
    }
    const originalQuery = () => all('SELECT e.* FROM backend_outbox e WHERE ' + clauses.join(' AND ') +
      ' ORDER BY e.event_id LIMIT ?', ...params, limit).map(outboxEvent);
    // Preserve the exact generic query for caller shapes that cannot use this
    // consumer/owner/subject projection.
    if (ownerRef === null || subjectRef === null || eventType !== null) return originalQuery();
    textValue(ownerRef, 'ownerRef'); textValue(subjectRef, 'subjectRef');
    return transaction(() => {
      const cutoff = Number(get('SELECT COALESCE(MAX(event_id),0) AS event_id FROM backend_outbox WHERE owner_ref=? AND subject_ref=?',
        ownerRef, subjectRef)?.event_id ?? 0);
      if (!Number.isSafeInteger(cutoff) || cutoff < 0) return originalQuery();
      const stateKey = [consumerId, ownerRef, subjectRef];
      const compact = schedulerConsumer(consumerId, ownerRef, subjectRef);
      if (compact && !get(`SELECT 1 FROM backend_outbox_confirmed_progress WHERE consumer_id=? AND owner_ref=? AND subject_ref=?`, ...stateKey)) {
        // Old scan projections were disposable. Rebuild their confirmation
        // basis from actual old receipts in bounded windows; never promote an
        // old scan cursor to a successful-consumption watermark.
        run('INSERT INTO backend_outbox_confirmed_progress VALUES(?,?,?,0,0,?)', ...stateKey, nowIso());
        run('DELETE FROM backend_outbox_scan_pending WHERE consumer_id=? AND owner_ref=? AND subject_ref=?', ...stateKey);
        run('DELETE FROM backend_outbox_scan_state WHERE consumer_id=? AND owner_ref=? AND subject_ref=?', ...stateKey);
      }
      let state = get(`SELECT scanned_through FROM backend_outbox_scan_state
        WHERE consumer_id=? AND owner_ref=? AND subject_ref=?`, ...stateKey);
      if (!state) {
        const recovery = get(`SELECT examined_through FROM backend_outbox_confirmed_progress
          WHERE consumer_id=? AND owner_ref=? AND subject_ref=?`, ...stateKey);
        const restoredThrough = recovery?.examined_through ?? 0;
        run(`INSERT INTO backend_outbox_scan_state(consumer_id,owner_ref,subject_ref,scanned_through,updated_at) VALUES(?,?,?,?,?)`,
          ...stateKey, restoredThrough, nowIso());
        state = { scanned_through: restoredThrough };
      }
      const scannedThrough = state.scanned_through;
      if (!Number.isSafeInteger(scannedThrough) || scannedThrough < 0 || scannedThrough > cutoff) return originalQuery();

      // A hole is removed only after the immutable receipt for this exact
      // consumer/event pair exists. Avoid no-op writes on every scheduler poll,
      // and bound cleanup when a consumer has accumulated many acknowledged holes.
      const acknowledgedHoles = all(`SELECT p.event_id FROM backend_outbox_scan_pending p
        JOIN backend_outbox_receipts r ON r.consumer_id=p.consumer_id AND r.event_id=p.event_id
        WHERE p.consumer_id=? AND p.owner_ref=? AND p.subject_ref=? ORDER BY p.event_id LIMIT ?`, ...stateKey, 1000);
      for (const row of acknowledgedHoles) run(`DELETE FROM backend_outbox_scan_pending
        WHERE consumer_id=? AND owner_ref=? AND subject_ref=? AND event_id=?`, ...stateKey, Number(row.event_id));
      let nextThrough = scannedThrough;
      if (cutoff > scannedThrough) {
        // Bound source rows, not only the unacknowledged result count: a fresh
        // consumer may otherwise inspect an unbounded acknowledged history.
        const sourceWindow = all(`SELECT event_id FROM backend_outbox
          WHERE event_id>? AND event_id<=? AND owner_ref=? AND subject_ref=?
          ORDER BY event_id LIMIT ?`, scannedThrough, cutoff, ownerRef, subjectRef, 1000);
        const sourceThrough = sourceWindow.length ? Number(sourceWindow.at(-1).event_id) : cutoff;
        if (sourceWindow.length && (!Number.isSafeInteger(sourceThrough) || sourceThrough <= scannedThrough || sourceThrough > cutoff)) return originalQuery();
        const found = sourceWindow.length ? all(`SELECT e.event_id FROM backend_outbox e
          WHERE e.event_id>? AND e.event_id<=? AND e.owner_ref=? AND e.subject_ref=?
            AND NOT ${acknowledgedSql('e', '?5')}
          ORDER BY e.event_id LIMIT ?`, scannedThrough, sourceThrough, ownerRef, subjectRef, consumerId, 1000) : [];
        for (const row of found) run(`INSERT OR IGNORE INTO backend_outbox_scan_pending
          (consumer_id,owner_ref,subject_ref,event_id) VALUES(?,?,?,?)`, ...stateKey, Number(row.event_id));
        nextThrough = sourceWindow.length < 1000 ? cutoff : sourceThrough;
        run(`UPDATE backend_outbox_scan_state SET scanned_through=?,updated_at=?
          WHERE consumer_id=? AND owner_ref=? AND subject_ref=?`, nextThrough, nowIso(), ...stateKey);
      }
      if (compact) advanceConfirmed(stateKey, nextThrough);
      if (nextThrough < cutoff) {
        // Until one bounded pass proves the whole prefix has been scanned,
        // retain the original ordered read so a newer event is never hidden.
        const pending = originalQuery();
        Object.defineProperty(pending, 'scanHasMore', { value: true });
        return pending;
      }
      const pendingClauses = ['p.consumer_id=?', 'p.owner_ref=?', 'p.subject_ref=?',
        'NOT ' + acknowledgedSql('e', 'p.consumer_id')];
      const pendingParams = [...stateKey];
      if (afterEventId > 0) { pendingClauses.push('e.event_id>?'); pendingParams.push(afterEventId); }
      pendingParams.push(limit);
      return all(`SELECT e.* FROM backend_outbox_scan_pending p JOIN backend_outbox e ON e.event_id=p.event_id
        WHERE ${pendingClauses.join(' AND ')} ORDER BY e.event_id LIMIT ?`, ...pendingParams).map(outboxEvent);
    });
  }
  function ackOutbox({ consumerId, eventId, receipt = {} } = {}) {
    textValue(consumerId, 'consumerId'); integer(eventId, 'eventId');
    if(outboxConsumerRetired(store,consumerId))fail('BACKEND_EVENT_CONSUMER_RETIRED','A retired subscription cannot advance acknowledgements');
    if (!object(receipt)) throw new TypeError('Outbox receipt must be an object');
    const receiptJson = json(receipt);
    return transaction(() => {
      const event = get('SELECT event_id,owner_ref,subject_ref FROM backend_outbox WHERE event_id=?', eventId);
      if (!event) fail('BACKEND_EVENT_MISSING', 'Outbox event does not exist');
      const existing = get('SELECT receipt_json,consumed_at FROM backend_outbox_receipts WHERE consumer_id=? AND event_id=?', consumerId, eventId);
      if (existing) {
        if (existing.receipt_json !== receiptJson) fail('BACKEND_EVENT_RECEIPT_CONFLICT', 'Existing consumer receipt cannot be rewritten');
        return { consumerId, eventId, consumedAt: existing.consumed_at, replayed: true };
      }
      const consumedAt = nowIso();
      const stateKey = [consumerId, event.owner_ref, event.subject_ref];
      const progress = schedulerConsumer(...stateKey) ? get(`SELECT * FROM backend_outbox_confirmed_progress
        WHERE consumer_id=? AND owner_ref=? AND subject_ref=?`, ...stateKey) : null;
      if (progress && eventId <= progress.examined_through) {
        const pending = get(`SELECT event_id FROM backend_outbox_scan_pending
          WHERE consumer_id=? AND owner_ref=? AND subject_ref=? AND event_id=?`, ...stateKey, eventId);
        if (!pending) return { consumerId, eventId, consumedAt: progress.confirmed_at, replayed: true, compacted: true, receiptStored: false };
        // Only the real success callback removes a hole. Scanning inserted it
        // as pending and could not acknowledge it. This participates in the
        // caller's same business-state transaction and rolls back with it.
        run('INSERT INTO backend_outbox_success_callbacks VALUES(?,?,?,?)', ...stateKey, eventId);
        run(`DELETE FROM backend_outbox_scan_pending WHERE consumer_id=? AND owner_ref=? AND subject_ref=? AND event_id=?`, ...stateKey, eventId);
        run(`DELETE FROM backend_outbox_success_callbacks WHERE consumer_id=? AND owner_ref=? AND subject_ref=? AND event_id=?`, ...stateKey, eventId);
        advanceConfirmed(stateKey);
        return { consumerId, eventId, consumedAt, replayed: false, compacted: true, receiptStored: false };
      }
      run('INSERT INTO backend_outbox_receipts(consumer_id,event_id,consumed_at,receipt_json) VALUES(?,?,?,?)', consumerId, eventId, consumedAt, receiptJson);
      return { consumerId, eventId, consumedAt, replayed: false };
    });
  }
  return Object.freeze({ prepareOperation, operation, retiredOperation:operationId=>readRetiredKnownLandOperation(store,operationId), listOperations, listOperationsPage, markMayHaveSent, markNotSent, recordTransport,
    settleOperation, settleSingleTarget, appendEvidence, recordAdmissionBasis, currentAdmission, recordCurrentResourceBaseline,
    reconcileCurrentResourceBaseline, recordCurrentCurrencyBaseline, releaseHistoricalWriteSlot,
    appendOutbox, readPendingOutbox, ackOutbox });
}
