import { canonical, clone, fingerprint, freeze, parseStored, problem } from '../../common.mjs';
import { hashLedgerBytes, ledgerJsonFingerprint } from '../../persistence/json-contract.mjs';

const VERSION = 'art-necessary-production-unit/v1';
const positive = value => Number.isSafeInteger(value) && value > 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const sync = value => { if (value?.then) { value.catch?.(() => {}); throw new TypeError('Art unit ports must be synchronous'); } return value; };
const failure = reasonCode => freeze({ known: false, reasonCode });

// Only an observed, readable excess debit is a durable cost-contract guard.
// Incomplete flow maps and mismatched projections remain ordinary unknowns
// and are handled by current-fact recovery instead.
function expectedLegacyArtInputs(operation, recipeFingerprint, artPreparation) {
  const original = operation?.original;
  // Generic ledger originals intentionally contain only the shared operation
  // contract. Finite-domain proposal data lives in immutable gateway evidence.
  const art = artPreparation;
  if (operation?.feature_id !== 'art.make' || operation?.method !== 'flowerArt.makeFlowerArt' ||
      original?.featureId !== 'art.make' || original?.method !== 'flowerArt.makeFlowerArt' || art?.recipeFingerprint !== recipeFingerprint ||
      art?.num !== 1 || !Array.isArray(art.flowersIds) || art.flowersIds.length !== 3 || !art.flowersIds.every(positive) ||
      !Array.isArray(original.resources)) return null;
  const expectedMap = new Map();
  for (const itemId of art.flowersIds) expectedMap.set(itemId, (expectedMap.get(itemId) || 0) + 1);
  const resourceMap = new Map();
  for (const resource of original.resources) {
    if (resource?.resourceKind !== 'item' || !/^item:[1-9]\d*$/.test(resource.resourceRef || '') || !positive(resource.quantity)) return null;
    const itemId = Number(resource.resourceRef.slice(5));
    resourceMap.set(itemId, (resourceMap.get(itemId) || 0) + resource.quantity);
  }
  if (expectedMap.size !== resourceMap.size || [...expectedMap].some(([id, quantity]) => resourceMap.get(id) !== quantity)) return null;
  return [...expectedMap].map(([itemId, quantity]) => ({ itemId, quantity })).sort((a, b) => a.itemId - b.itemId);
}

export function hasProvenUnexpectedArtDebit(verification, operation = null, artPreparation = null) {
  const reason = verification?.reasonCode;
  const evidence = verification?.evidence;
  const debits = evidence?.unexpectedDebits;
  if (reason === 'ART_MAKE_UNEXPECTED_COST' && Array.isArray(debits) && debits.length > 0 && debits.every(one =>
    ['bo', 'actBo', 'proxyBo'].includes(one.source) && positive(one.itemId) && positive(one.quantity) &&
    Number.isSafeInteger(one.expectedQuantity) && one.expectedQuantity >= 0 &&
    Number.isSafeInteger(one.observedQuantity) && one.observedQuantity > one.expectedQuantity &&
    one.quantity === one.observedQuantity - one.expectedQuantity &&
    one.evidence === 'complete-known-official-operation-flow')) return true;
  // Old immutable receipts predate unexpectedDebits. Re-derive only when the
  // matched response and complete flow projections are present in that exact
  // operation's evidence; a reason string or profile delta alone is not proof.
  if (!['ART_MAKE_UNEXPECTED_COST', 'ART_MAKE_FLOW_QUANTITIES_UNPROVEN'].includes(reason) ||
      evidence?.answer?.kind !== 'response' || evidence.answer.method !== 'flowerArt.makeFlowerArt' ||
      !reference(evidence.answer.responseRef) || !reference(evidence.answer.wireKey) || !positive(evidence.answer.requestSequence)) return false;
  const expected = evidence.expectedConsumptions || expectedLegacyArtInputs(operation, evidence.recipeFingerprint, artPreparation), flows = evidence.flows;
  if (!Array.isArray(expected) || !expected.length || expected.some(one => !positive(one?.itemId) || !positive(one?.quantity)) ||
      !flows?.bo?.readable || !Array.isArray(flows.bo.entries)) return false;
  const expectedById = new Map(expected.map(one => [one.itemId, one.quantity]));
  const hasExcess = (entries, expectedForSource) => Array.isArray(entries) && entries.some(one => positive(one?.itemId) && positive(one?.quantity) &&
    one.quantity > (expectedForSource.get(one.itemId) || 0));
  // Recipe costs are declared against bo only. actBo/proxyBo are additional
  // operation flows, so any known positive quantity there is excess, even
  // when the item id also appears in the declared recipe.
  return hasExcess(flows.bo.entries, expectedById) || ['actBo', 'proxyBo'].some(name =>
    flows[name]?.readable && hasExcess(flows[name].entries, new Map()));
}

// These are new normal-production identities. The original cost-observation
// quota and its immutable operation are only read, never rearmed or rewritten.
export function createArtProductionUnits({ store, resources, ledgerView, isCurrent }) {
  for (const [name, fn] of Object.entries({ run: store?.run, get: store?.get, all: store?.all, transaction: store?.transaction,
    nowIso: store?.nowIso, operation: ledgerView?.operation, planCoverage: resources?.planCoverage, isCurrent })) {
    if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') throw new TypeError('Art units missing synchronous port: ' + name);
  }
  store.run(`CREATE TABLE IF NOT EXISTS backend_art_production_units(unit_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,
    subject_ref TEXT NOT NULL,parent_lifecycle_ref TEXT NOT NULL,recipe_fingerprint TEXT NOT NULL,ordinal INTEGER NOT NULL,
    art_id INTEGER NOT NULL,demand_ref TEXT NOT NULL,cost_receipt_ref TEXT NOT NULL,cost_receipt_fingerprint TEXT NOT NULL,
    account_ref TEXT NOT NULL,operation_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('claimed','armed','settled')),
    binding_json TEXT NOT NULL,binding_fingerprint TEXT NOT NULL,verdict TEXT,receipt_json TEXT,receipt_fingerprint TEXT,
    revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    UNIQUE(owner_ref,subject_ref,parent_lifecycle_ref,recipe_fingerprint,ordinal))`);
  store.run(`CREATE TRIGGER IF NOT EXISTS backend_art_production_identity_immutable BEFORE UPDATE OF unit_ref,owner_ref,subject_ref,
    parent_lifecycle_ref,recipe_fingerprint,ordinal,art_id,demand_ref,cost_receipt_ref,cost_receipt_fingerprint ON backend_art_production_units
    BEGIN SELECT RAISE(ABORT,'art production unit identity is immutable'); END`);
  store.run(`CREATE TRIGGER IF NOT EXISTS backend_art_production_no_delete BEFORE DELETE ON backend_art_production_units
    BEGIN SELECT RAISE(ABORT,'art production units are retained'); END`);
  store.run(`CREATE TABLE IF NOT EXISTS backend_art_production_events(event_ref TEXT PRIMARY KEY,unit_ref TEXT NOT NULL,
    operation_id TEXT NOT NULL,event_kind TEXT NOT NULL,payload_json TEXT NOT NULL,payload_fingerprint TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
  store.run(`CREATE TABLE IF NOT EXISTS backend_art_recipe_cost_guards(owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    recipe_fingerprint TEXT NOT NULL,operation_id TEXT NOT NULL,reason_code TEXT NOT NULL,evidence_json TEXT NOT NULL,
    evidence_fingerprint TEXT NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref,recipe_fingerprint))`);
  store.run(`CREATE TABLE IF NOT EXISTS backend_art_recipe_cost_guard_events(guard_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    recipe_fingerprint TEXT NOT NULL,operation_id TEXT NOT NULL,reason_code TEXT NOT NULL,evidence_json TEXT NOT NULL,
    evidence_fingerprint TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
  store.run('CREATE INDEX IF NOT EXISTS backend_art_recipe_cost_guard_lookup ON backend_art_recipe_cost_guard_events(owner_ref,subject_ref,recipe_fingerprint)');
  for (const action of ['UPDATE', 'DELETE']) store.run(`CREATE TRIGGER IF NOT EXISTS backend_art_recipe_cost_guard_events_no_${action.toLowerCase()} BEFORE ${action} ON backend_art_recipe_cost_guard_events
    BEGIN SELECT RAISE(ABORT,'art cost guard events are append only'); END`);
  for (const table of ['backend_art_production_events', 'backend_art_recipe_cost_guards']) for (const action of ['UPDATE', 'DELETE']) {
    store.run(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${action.toLowerCase()} BEFORE ${action} ON ${table}
      BEGIN SELECT RAISE(ABORT,'art production evidence is append only'); END`);
  }
  const active = context => sync(isCurrent(context)) === true;
  function event(row, eventKind, payload) {
    const eventRef = 'art-production-event:' + fingerprint([row.unit_ref, row.operation_id, eventKind, payload]);
    const hash = fingerprint(payload), old = store.get('SELECT payload_fingerprint FROM backend_art_production_events WHERE event_ref=?', eventRef);
    if (old && old.payload_fingerprint !== hash) throw problem('ART_PRODUCTION_EVENT_CONFLICT', '原制作单件事件不可覆盖');
    if (!old) store.run('INSERT INTO backend_art_production_events VALUES(?,?,?,?,?,?,?)', eventRef, row.unit_ref, row.operation_id,
      eventKind, canonical(payload), hash, store.nowIso());
    return eventRef;
  }
  function evidence(row) {
    const payload = parseStored(row.payload_json, '花艺成本原操作证据');
    return ledgerJsonFingerprint({ kind: row.kind, source: row.source, payload, observedAt: row.observed_at }) === row.payload_fingerprint ? payload : null;
  }
  function artPreparationFor(operation) {
    if (!operation?.operation_id || operation.feature_id !== 'art.make' || operation.method !== 'flowerArt.makeFlowerArt') return null;
    const rows = store.all("SELECT * FROM backend_operation_evidence WHERE operation_id=? AND kind='finite-domain-preparation' AND source='backend/write-gateway/v2' ORDER BY evidence_id DESC LIMIT 4",
      operation.operation_id);
    for (const row of rows) {
      const payload = evidence(row);
      if (payload?.domain === 'art' && payload.preparation && typeof payload.preparation === 'object' &&
          payload.preparation.recipeFingerprint && payload.preparation.recipeFingerprint === operation.factBasis?.recipeFingerprint) return payload.preparation;
    }
    return null;
  }
  function coverageForOperation({ operationId, ownerRef, subjectRef, recipeFingerprint }) {
    const operation = sync(ledgerView.operation(operationId));
    if (!operation || operation.owner_ref !== ownerRef || operation.subject_ref !== subjectRef || operation.feature_id !== 'art.make' ||
      operation.scope !== 'flower-art-make' || operation.method !== 'flowerArt.makeFlowerArt' || operation.business_verdict !== 'confirmed' ||
      operation.transport_state !== 'answered' || operation.write_slot !== 0 || typeof operation.original_json !== 'string' ||
      hashLedgerBytes(operation.original_json) !== operation.original_fingerprint || ledgerJsonFingerprint(operation.original) !== operation.original_fingerprint ||
      operation.targets.length !== 1 || operation.targetSettlements.length !== 1) return failure('ART_OBSERVED_COST_ORIGINAL_NOT_CONFIRMED');
    const settlement = operation.targetSettlements[0], result = settlement.result, cost = result?.evidence?.payload?.observedCostReceipt;
    if (settlement.verdict !== 'confirmed' || typeof settlement.result_json !== 'string' || hashLedgerBytes(settlement.result_json) !== settlement.result_fingerprint ||
      ledgerJsonFingerprint(result) !== settlement.result_fingerprint || !cost || cost.known !== true ||
      cost.complete !== true || cost.kind !== 'observed-versioned-recipe-cost' || cost.operationId !== operationId ||
      cost.recipeFingerprint !== recipeFingerprint || cost.gameVersion !== operation.original?.art?.versionEvidence?.gameVersion || cost.protocolVersion !== '480.0.0' ||
      cost.num !== 1 || cost.additionalCurrencyCostKnown !== true || cost.gold !== 0 || cost.yb !== 0 || cost.vaseConsumed !== false) return failure('ART_OBSERVED_COST_RECEIPT_NOT_EXACT');
    const body = Object.fromEntries(Object.entries(cost).filter(([key]) => !['receiptRef', 'receiptFingerprint'].includes(key)));
    if (fingerprint(body) !== cost.receiptFingerprint || cost.receiptRef !== 'art-observed-cost:' + cost.receiptFingerprint) return failure('ART_OBSERVED_COST_RECEIPT_HASH_INVALID');
    const candidates = store.all("SELECT * FROM backend_operation_evidence WHERE operation_id=? AND kind='after-close-login-post-read' AND source='backend/write-gateway/v2' ORDER BY evidence_id LIMIT 17", operationId);
    if (candidates.length > 16) return failure('ART_OBSERVED_COST_BRIDGE_LIMIT');
    const bridgeRow = candidates.find(row => {
      const payload = evidence(row);
      return payload?.version === 'art-after-close-login/v1' && payload.operationId === operationId && payload.bridgeFingerprint === cost.bridgeFingerprint;
    });
    const packet = bridgeRow && evidence(bridgeRow);
    if (!packet) return failure('ART_OBSERVED_COST_BRIDGE_UNPROVEN');
    const bridge = Object.fromEntries(['leaseRef', 'operationId', 'originalContext', 'newContext', 'after', 'bridgeFingerprint'].map(key => [key, packet[key]]));
    const planned = sync(resources.planCoverage({ context: packet.originalContext, operation, targetSettlement: settlement,
      postRead: { responseRef: packet.newLogin.responseRef }, sendBinding: packet.after, postReadBridge: bridge }));
    if (!planned?.applicable || planned.links.length !== operation.original.resources.length || planned.links.length !== cost.consumptions?.length ||
      !planned.links.length || planned.links.length > 3) return failure(planned?.issues?.[0]?.reasonCode || 'ART_OBSERVED_COST_COVERAGE_NOT_REDERIVABLE');
    const persisted = store.all('SELECT * FROM backend_official_item_coverage WHERE operation_id=? AND owner_ref=? AND subject_ref=? ORDER BY coverage_key', operationId, ownerRef, subjectRef);
    if (persisted.length !== planned.links.length || !planned.links.every(link => {
      const old = persisted.find(row => row.coverage_key === link.coverageKey);
      return old && old.result_fingerprint === fingerprint(link) && old.quantity === link.quantity && old.resource_key === link.resourceKey &&
        old.post_read_ref === link.postReadRef && canonical(parseStored(old.evidence_json, '花艺原实际费用覆盖')) === canonical(link.evidence);
    })) return failure('ART_OBSERVED_COST_PERSISTED_COVERAGE_MISSING');
    return freeze({ known: true, reasonCode: null, operationId, cost: clone(cost), originalFingerprint: operation.original_fingerprint,
      settlementFingerprint: settlement.result_fingerprint, bridgeFingerprint: packet.bridgeFingerprint,
      bridgeEvidenceFingerprint: bridgeRow.payload_fingerprint, coverage: planned.links.map(link => ({ coverageRef: link.coverageKey,
        resourceKey: link.resourceKey, quantity: link.quantity, fingerprint: fingerprint(link) })).sort((a, b) => a.resourceKey.localeCompare(b.resourceKey)) });
  }
  function hasCostGuard(context, recipeFingerprint) {
    const current = store.all('SELECT operation_id,reason_code,evidence_json FROM backend_art_recipe_cost_guard_events WHERE owner_ref=? AND subject_ref=? AND recipe_fingerprint=?',
      context.ownerRef, context.subjectRef, recipeFingerprint);
    if (current.some(row => {
      const payload = parseStored(row.evidence_json, '花艺费用保护证据');
      const operation = sync(ledgerView.operation(row.operation_id));
      return hasProvenUnexpectedArtDebit({ reasonCode: row.reason_code, evidence: payload.observedEvidence }, operation, artPreparationFor(operation));
    })) return true;
    const legacy = store.get('SELECT operation_id,reason_code,evidence_json FROM backend_art_recipe_cost_guards WHERE owner_ref=? AND subject_ref=? AND recipe_fingerprint=?',
      context.ownerRef, context.subjectRef, recipeFingerprint);
    if (!legacy) return false;
    // Legacy profile deltas were independently observed after reconnect and
    // cannot be attributed to this write. Preserve the original row, but do
    // not turn it into a permanent recipe-wide cost guard.
    const payload = parseStored(legacy.evidence_json, '旧花艺费用保护证据');
    const operation = sync(ledgerView.operation(payload.operationId || legacy.operation_id));
    const expected = payload.observedEvidence?.expectedConsumptions || operation?.original?.resources?.filter(one =>
      one.resourceKind === 'item' && /^item:[1-9][0-9]*$/.test(one.resourceRef || '')).map(one => ({
      itemId: Number(one.resourceRef.slice(5)), quantity: one.quantity }));
    const observedEvidence = payload.observedEvidence ? { ...payload.observedEvidence,
      ...(Array.isArray(expected) ? { expectedConsumptions: expected } : {}) } : null;
    return hasProvenUnexpectedArtDebit({ reasonCode: legacy.reason_code, evidence: observedEvidence }, operation, artPreparationFor(operation));
  }
  function costFor({ context, recipeFingerprint, artId, currentCatalogSource = null, currentRowProof = null }) {
    if (!active(context)) return failure('ART_COST_AUTHORIZATION_CONTEXT_NOT_CURRENT');
    if (hasCostGuard(context, recipeFingerprint)) return failure('ART_RECIPE_OBSERVED_COST_GUARD');
    const first = store.get(`SELECT *,quota_ref AS authority_ref FROM backend_art_cost_observation_quotas WHERE owner_ref=? AND subject_ref=?
      AND recipe_fingerprint=? ORDER BY created_at LIMIT 1`, context.ownerRef, context.subjectRef, recipeFingerprint);
    const retries = store.all(`SELECT *,attempt_ref AS authority_ref FROM backend_art_cost_observation_attempts WHERE owner_ref=? AND subject_ref=?
      AND recipe_fingerprint=? AND state='settled' AND verdict='confirmed'
      ORDER BY created_at DESC,attempt_ref DESC LIMIT 16`, context.ownerRef, context.subjectRef, recipeFingerprint);
    const candidates = [first, ...retries].filter(row => row?.state === 'settled' && row.verdict === 'confirmed' && row.art_id === artId && row.receipt_json);
    let lastReason = 'ART_VERSIONED_RECIPE_OBSERVED_COST_NOT_AVAILABLE';
    for (const quota of candidates) {
      const settled = parseStored(quota.receipt_json, '花艺成本观察结算'), proof = coverageForOperation({ operationId: quota.operation_id,
        ownerRef: context.ownerRef, subjectRef: context.subjectRef, recipeFingerprint });
      if (fingerprint(settled) !== quota.receipt_fingerprint || settled.operationId !== quota.operation_id || settled.quotaRef !== quota.authority_ref ||
        settled.unitRef !== quota.unit_ref || settled.parentLifecycleRef !== quota.parent_lifecycle_ref || settled.recipeFingerprint !== recipeFingerprint ||
        settled.verdict !== 'confirmed' || !proof.known || canonical(settled.observedCostReceipt) !== canonical(proof.cost)) {
        lastReason = proof.reasonCode || 'ART_ORIGINAL_COST_QUOTA_RECEIPT_UNPROVEN';
        continue;
      }
      const currentSourceValid = currentCatalogSource?.dataSnapshotId
        ? currentCatalogSource.dataSnapshotId === currentRowProof?.dataSnapshotId &&
          currentCatalogSource.loginResponseRef === currentRowProof?.loginResponseRef &&
          currentCatalogSource.sourceProof?.supported === true && currentCatalogSource.sourceProof.sourceVersion === currentCatalogSource.gameVersion &&
          currentCatalogSource.sourceProof.protocolVersion === currentCatalogSource.protocolVersion &&
          /^[a-f0-9]{64}$/.test(currentCatalogSource.sourceProof.gameSha256 || '') && /^[a-f0-9]{64}$/.test(currentCatalogSource.sourceProof.moSha256 || '') &&
          /^[a-f0-9]{64}$/.test(currentCatalogSource.itemTableSha256 || '') && /^[a-f0-9]{64}$/.test(currentCatalogSource.flowerTableSha256 || '') &&
          currentCatalogSource.artTableSha256 === currentRowProof.tableSha256 && currentRowProof.fingerprint === fingerprint(currentRowProof.row)
        : currentCatalogSource?.gameVersion === '480.0.27' && currentCatalogSource.protocolVersion === '480.0.0';
      if (!currentSourceValid) { lastReason = 'ART_CURRENT_RECIPE_SOURCE_BINDING_UNPROVEN'; continue; }
      const compatibilityLink = { dataSnapshotId: currentCatalogSource.dataSnapshotId ?? null,
        sourceVersion: currentCatalogSource.gameVersion, protocolVersion: currentCatalogSource.protocolVersion,
        sourceProofFingerprint: currentCatalogSource.sourceProof ? fingerprint(currentCatalogSource.sourceProof) : null,
        rowProofFingerprint: currentRowProof?.fingerprint ?? null, currentLoginResponseRef: currentCatalogSource.loginResponseRef ?? null,
        historicalQuotaRef: quota.authority_ref, historicalOperationId: quota.operation_id,
        historicalCostGameVersion: proof.cost.gameVersion, historicalCostProtocolVersion: proof.cost.protocolVersion,
        costReceiptRef: proof.cost.receiptRef, costReceiptFingerprint: proof.cost.receiptFingerprint,
        historicalOperationFingerprint: proof.originalFingerprint, historicalSettlementFingerprint: proof.settlementFingerprint,
        historicalBridgeFingerprint: proof.bridgeFingerprint, historicalCoverage: proof.coverage };
      const authority = { version: 'art-versioned-recipe-cost-authorization/v1', ownerRef: context.ownerRef, subjectRef: context.subjectRef,
        recipeFingerprint, artId, sourceQuotaRef: quota.authority_ref, sourceOperationId: quota.operation_id,
        observedParentLifecycleRef: quota.parent_lifecycle_ref, sourceQuotaReceiptFingerprint: quota.receipt_fingerprint,
        originalFingerprint: proof.originalFingerprint, settlementFingerprint: proof.settlementFingerprint, bridgeFingerprint: proof.bridgeFingerprint,
        bridgeEvidenceFingerprint: proof.bridgeEvidenceFingerprint, coverage: proof.coverage, costReceiptRef: proof.cost.receiptRef,
        costReceiptFingerprint: proof.cost.receiptFingerprint, compatibilityLink };
      return freeze({ known: true, reasonCode: null, ...authority, authorizationRef: 'art-cost-authorization:' + fingerprint(authority), costContract: proof.cost });
    }
    return failure(lastReason);
  }
  function rowFor(context, unitRef) { return store.get('SELECT * FROM backend_art_production_units WHERE owner_ref=? AND subject_ref=? AND unit_ref=?', context.ownerRef, context.subjectRef, unitRef); }
  function nonSendProof(operationId) {
    const operation = sync(ledgerView.operation(operationId));
    if (!operation) return { kind: 'no-prepared-operation', operationId };
    const permit = store.get('SELECT consumed,wire_key,request_sequence FROM backend_send_permits WHERE operation_id=?', operationId);
    if (operation.transport_state !== 'not_sent' || operation.business_verdict !== 'not_applicable' || operation.write_slot !== 0 ||
      !permit || permit.consumed !== 0 || permit.wire_key !== null || permit.request_sequence !== null) return null;
    for (const row of store.all('SELECT * FROM backend_operation_evidence WHERE operation_id=? ORDER BY evidence_id DESC LIMIT 8', operationId)) {
      const payload = evidence(row);
      if (payload?.nonSendProof?.permitConsumed === false && payload.nonSendProof.byteSendStarted === false) return { kind: 'persisted-proved-not-sent', operationId,
        originalFingerprint: operation.original_fingerprint, evidenceId: row.evidence_id, evidenceFingerprint: row.payload_fingerprint };
    }
    return null;
  }
  function claim({ context, parent, recipeFingerprint, artId, operationId, authorization, decisionGeneration, currentCatalogSource, currentRowProof }) {
    return store.transaction(() => {
      if (!active(context) || authorization?.known !== true || !/^[a-f0-9]{64}$/.test(decisionGeneration || '')) return failure('ART_NORMAL_UNIT_CONTEXT_OR_COST_NOT_CURRENT');
      const refreshed = costFor({ context, recipeFingerprint, artId, currentCatalogSource, currentRowProof });
      if (!refreshed.known || refreshed.authorizationRef !== authorization.authorizationRef) return failure(refreshed.reasonCode || 'ART_NORMAL_UNIT_COST_AUTHORIZATION_CHANGED');
      const last = store.get(`SELECT * FROM backend_art_production_units WHERE owner_ref=? AND subject_ref=? AND parent_lifecycle_ref=?
        AND recipe_fingerprint=? ORDER BY ordinal DESC LIMIT 1`, context.ownerRef, context.subjectRef, parent.lifecycleRef, recipeFingerprint);
      const demandRef = 'art-production-demand:' + fingerprint({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
        parentLifecycleRef: parent.lifecycleRef, recipeFingerprint, decisionGeneration });
      let ordinal = last ? last.ordinal + 1 : 1, nonSend = null;
      if (last) {
        if (last.state !== 'settled') {
          nonSend = nonSendProof(last.operation_id);
          if (!nonSend) return failure('ART_ORIGINAL_NORMAL_UNIT_MAY_HAVE_SENT');
          ordinal = last.ordinal;
        } else {
          if (last.verdict === 'confirmed') {
            const covered = coverageForOperation({ operationId: last.operation_id, ownerRef: context.ownerRef, subjectRef: context.subjectRef, recipeFingerprint });
            if (!covered.known) return failure(covered.reasonCode || 'ART_PRIOR_UNIT_PRODUCT_OR_CONSUMPTION_NOT_ACCOUNTED');
          } else if (last.verdict !== 'unknown') return failure('ART_ORIGINAL_NORMAL_UNIT_RESULT_UNKNOWN');
        }
      }
      const priorGeneration = store.get(`SELECT unit_ref,operation_id,state,verdict FROM backend_art_production_units
        WHERE owner_ref=? AND subject_ref=? AND parent_lifecycle_ref=? AND recipe_fingerprint=? AND demand_ref=? LIMIT 1`,
      context.ownerRef, context.subjectRef, parent.lifecycleRef, recipeFingerprint, demandRef);
      if (priorGeneration && !(nonSend && priorGeneration.unit_ref === last?.unit_ref)) return failure('ART_CURRENT_NEED_GENERATION_ALREADY_USED');
      // ordinal is an immutable attempt identity, not a production count. The
      // current planner's fresh netShortage is the only quantity authority;
      // a closed unknown attempt may have produced nothing, so it cannot spend
      // the parent's current need a second time.
      if (!positive(ordinal) || !positive(parent.need)) return failure('ART_PARENT_NECESSARY_UNIT_LIMIT_REACHED');
      const identity = { ownerRef: context.ownerRef, subjectRef: context.subjectRef, parentLifecycleRef: parent.lifecycleRef, recipeFingerprint, ordinal };
      const unitRef = 'art-production-unit:' + fingerprint(identity);
      const at = store.nowIso();
      if (nonSend) {
        if (last.unit_ref !== unitRef || last.cost_receipt_ref !== authorization.costContract.receiptRef || last.cost_receipt_fingerprint !== authorization.costContract.receiptFingerprint) return failure('ART_NORMAL_UNIT_IMMUTABLE_IDENTITY_CONFLICT');
        const updated = store.run(`UPDATE backend_art_production_units SET account_ref=?,operation_id=?,state='claimed',binding_json='{}',
          binding_fingerprint=?,revision=revision+1,updated_at=? WHERE unit_ref=? AND operation_id=? AND revision=? AND state!='settled'`,
        context.accountRef, operationId, fingerprint({}), at, unitRef, last.operation_id, last.revision);
        if (Number(updated.changes) !== 1) return failure('ART_NORMAL_UNIT_REPLAN_CAS_FAILED');
      } else store.run('INSERT INTO backend_art_production_units VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', unitRef, context.ownerRef,
        context.subjectRef, parent.lifecycleRef, recipeFingerprint, ordinal, artId, demandRef, authorization.costContract.receiptRef,
        authorization.costContract.receiptFingerprint, context.accountRef, operationId, 'claimed', '{}', fingerprint({}), null, null, null, 1, at, at);
      const row = rowFor(context, unitRef);
      event(row, nonSend ? 'proved-unsent-replanned' : 'normal-unit-claimed', { identity, authorizationRef: authorization.authorizationRef, priorNonSendProof: nonSend });
      return freeze({ known: true, reasonCode: null, row: clone(row), authorization: refreshed });
    });
  }
  function bind({ context, unitRef, operationId, binding }) {
    const row = rowFor(context, unitRef);
    if (!active(context) || !row || row.operation_id !== operationId || row.state !== 'claimed') throw problem('ART_NORMAL_UNIT_BINDING_NOT_OWNED', '原正常制作单件未归属本操作');
    const changed = store.run(`UPDATE backend_art_production_units SET binding_json=?,binding_fingerprint=?,revision=revision+1,updated_at=?
      WHERE unit_ref=? AND operation_id=? AND revision=? AND state='claimed'`, canonical(binding), fingerprint(binding), store.nowIso(), unitRef, operationId, row.revision);
    if (Number(changed.changes) !== 1) throw problem('ART_NORMAL_UNIT_BINDING_CAS_FAILED', '原正常制作单件持久绑定已改变');
  }
  function validate({ context, proposal, binding }) {
    const art = proposal.art, row = rowFor(context, art.unitRef), authorization = costFor({ context, recipeFingerprint: art.recipeFingerprint, artId: art.artId });
    if (!active(context) || !row || row.account_ref !== context.accountRef || row.operation_id !== proposal.operationId || row.state === 'settled' ||
      row.parent_lifecycle_ref !== art.parentLifecycleRef || row.recipe_fingerprint !== art.recipeFingerprint || row.demand_ref !== art.demandRef ||
      row.ordinal !== art.productionUnit?.ordinal || art.productionUnit.unitRef !== row.unit_ref || art.productionUnit.authorizationRef !== authorization.authorizationRef ||
      !authorization.known || row.cost_receipt_ref !== art.costContract?.receiptRef || row.cost_receipt_fingerprint !== art.costContract?.receiptFingerprint ||
      canonical(art.costContract) !== canonical(authorization.costContract) || fingerprint(parseStored(row.binding_json, '正常制作原单件绑定')) !== row.binding_fingerprint ||
      row.binding_fingerprint !== fingerprint(binding)) return failure(authorization.reasonCode || 'ART_NORMAL_UNIT_OR_COST_AUTHORIZATION_CHANGED');
    return freeze({ known: true, reasonCode: null, row: clone(row), authorization });
  }
  function arm(input) {
    const checked = validate(input);
    if (!checked.known) return checked;
    const row = checked.row, changed = store.run("UPDATE backend_art_production_units SET state='armed',revision=revision+1,updated_at=? WHERE unit_ref=? AND operation_id=? AND revision=? AND state IN ('claimed','armed')",
      store.nowIso(), row.unit_ref, row.operation_id, row.revision);
    if (Number(changed.changes) !== 1) return failure('ART_NORMAL_UNIT_SEND_CAS_FAILED');
    event(row, 'normal-unit-send-fence', { operationId: row.operation_id, authorizationRef: checked.authorization.authorizationRef });
    return checked;
  }
  function settle({ proposal, operation, verification, binding }) {
    const context = { ownerRef: proposal.ownerRef, subjectRef: proposal.subjectRef }, row = rowFor(context, proposal.art.unitRef);
    if (!row || row.operation_id !== proposal.operationId || row.binding_fingerprint !== fingerprint(binding) ||
      operation.operation_id !== proposal.operationId || operation.owner_ref !== context.ownerRef || operation.subject_ref !== context.subjectRef ||
      operation.business_verdict !== verification.verdict || operation.write_slot !== 0 && verification.verdict !== 'unknown') throw problem('ART_NORMAL_UNIT_SETTLEMENT_BINDING_INVALID', '正常制作原单件结算不匹配');
    if (verification.verdict === 'confirmed') {
      const cost = verification.observedCostReceipt;
      const body = cost ? Object.fromEntries(Object.entries(cost).filter(([key]) => !['receiptRef', 'receiptFingerprint'].includes(key))) : null;
      if (!body || body.operationId !== row.operation_id || body.unitRef !== row.unit_ref || body.recipeFingerprint !== row.recipe_fingerprint ||
        body.kind !== 'observed-versioned-recipe-cost' || body.known !== true || body.complete !== true || fingerprint(body) !== cost.receiptFingerprint ||
        cost.receiptRef !== 'art-observed-cost:' + cost.receiptFingerprint) throw problem('ART_NORMAL_UNIT_ACTUAL_COST_RECEIPT_INVALID', '正常制作须有本次真实费用回执');
    }
    const payload = { version: VERSION, unitRef: row.unit_ref, demandRef: row.demand_ref, parentLifecycleRef: row.parent_lifecycle_ref,
      recipeFingerprint: row.recipe_fingerprint, ordinal: row.ordinal, operationId: row.operation_id,
      verdict: verification.verdict, reasonCode: verification.reasonCode ?? null, postReadRef: verification.postReadRef ?? null,
      sourceCostReceiptRef: row.cost_receipt_ref, actualCostReceiptRef: verification.observedCostReceipt?.receiptRef ?? null,
      originalOutcomeAndResourceFootprintsUnchanged: true, currentEffectsPublished: false };
    const hash = fingerprint(payload);
    if (row.state === 'settled' && row.receipt_fingerprint !== hash) throw problem('ART_NORMAL_UNIT_SETTLEMENT_CONFLICT', '正常制作原单件结论不可覆盖');
    if (row.state !== 'settled') store.run("UPDATE backend_art_production_units SET state='settled',verdict=?,receipt_json=?,receipt_fingerprint=?,revision=revision+1,updated_at=? WHERE unit_ref=? AND operation_id=? AND state!='settled'",
      verification.verdict, canonical(payload), hash, store.nowIso(), row.unit_ref, row.operation_id);
    event(row, 'normal-unit-settled', payload);
    recordUnexpectedCostGuard({ ownerRef: row.owner_ref, subjectRef: row.subject_ref, recipeFingerprint: row.recipe_fingerprint,
      operationId: row.operation_id, unitRef: row.unit_ref, costReceiptRef: row.cost_receipt_ref, verification, operation });
    return freeze(payload);
  }
  function recordUnexpectedCostGuard({ ownerRef, subjectRef, recipeFingerprint, operationId, unitRef, costReceiptRef = null, verification, operation }) {
    if (!hasProvenUnexpectedArtDebit(verification, operation) || verification?.verdict !== 'unknown' ||
        !verification.evidence || verification.evidence.operationId !== operationId ||
        operation?.operation_id !== operationId || operation.owner_ref !== ownerRef || operation.subject_ref !== subjectRef ||
        operation.method !== 'flowerArt.makeFlowerArt' || operation.business_verdict !== 'unknown' || operation.write_slot !== 0 ||
        !/^[a-f0-9]{64}$/.test(recipeFingerprint || '') || !reference(unitRef)) return false;
    const proof = { version: VERSION, operationId, unitRef, reasonCode: verification.reasonCode,
      previousCostReceiptRef: costReceiptRef, observedEvidence: verification.evidence };
    const guardRef = 'art-cost-guard:' + fingerprint({ ownerRef, subjectRef, recipeFingerprint, operationId,
      evidenceFingerprint: fingerprint(proof) });
    store.run('INSERT OR IGNORE INTO backend_art_recipe_cost_guard_events VALUES(?,?,?,?,?,?,?,?,?)', guardRef, ownerRef, subjectRef,
      recipeFingerprint, operationId, verification.reasonCode, canonical(proof), fingerprint(proof), store.nowIso());
    return true;
  }
  function publicView({ ownerRef, subjectRef }) {
    const rows = store.all(`SELECT unit_ref,demand_ref,parent_lifecycle_ref,recipe_fingerprint,ordinal,art_id,operation_id,state,
      cost_receipt_ref,cost_receipt_fingerprint,verdict,receipt_fingerprint FROM backend_art_production_units
      WHERE owner_ref=? AND subject_ref=? ORDER BY created_at,unit_ref LIMIT 65`, ownerRef, subjectRef);
    return freeze({ complete: rows.length <= 64, limit: 64, rows: rows.slice(0, 64).map(clone) });
  }
  return Object.freeze({ costFor, hasCostGuard: (context, recipeFingerprint) => active(context) && hasCostGuard(context, recipeFingerprint),
    claim, bind, validate, arm, settle, recordUnexpectedCostGuard, publicView });
}
