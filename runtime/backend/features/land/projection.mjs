import { encodeEvidenceJson, canonical, clone, fingerprint, freeze, parseStored, problem } from '../../common.mjs';
import { knownCell, missingCell } from './wire-facts.mjs';
import { buildLandCompatibilityRevalidation, resolveAcceptedLandObservationEvidence } from './compatibility-evidence.mjs';
import { assertSingleProposal, LAND_METHODS } from './rpc-contract.mjs';
import { storeLandCompatibilityReceipt } from './source-policy-storage.mjs';
import { createSnapshotCacheClient } from '../../facts/snapshot-cache.mjs';

const semantic = value => {
  if (Array.isArray(value)) return value.map(semantic);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['source', 'sourceRef', 'semanticVersion', 'observationRef', 'responseRef'].includes(key)).map(([key, one]) => [key, semantic(one)]));
  return value;
};
const valueOf = cell => knownCell(cell) ? cell.value : null;
const newer = (source, previous, equal = false) => !previous || source.connectionEpoch > previous.connectionEpoch
  || source.connectionEpoch === previous.connectionEpoch && (source.requestSequence > previous.requestSequence
    || equal && source.observationRef === previous.observationRef);
const cover = (source, kind, complete = false) => ({ kind, complete, sourceRef: source.observationRef, responseRef: source.responseRef, requestSequence: source.requestSequence });
function empty(context) {
  return { context: clone(context), identity: { uid: missingCell(), verified: false, source: null }, profile: {}, lands: {}, cultivates: {},
    top: missingCell(), inventory: { bag: { ...missingCell(), items: {}, complete: false, semanticVersion: 0 },
      itemExt: { ...missingCell(), items: {}, complete: false, semanticVersion: 0 } }, coverage: {}, revision: 0 };
}
function sourced(cell, source, old = null) {
  const result = { ...clone(cell), source: clone(source) };
  result.semanticVersion = (old?.semanticVersion || 0) + (fingerprint(semantic(cell)) === fingerprint(semantic(old || missingCell())) ? 0 : 1);
  return result;
}
function landStatus(member) {
  if (!member.valid || member.removed) return member.removed ? 'removed' : 'unknown';
  if (member.explicitEmptyObject) return 'empty';
  const fields = member.fields;
  const noTime = one => one?.presence === 'missing' || one?.presence === 'null';
  if (valueOf(fields.state) === 0 && (fields.flowerId?.presence === 'missing' || valueOf(fields.flowerId) === 0)
    && noTime(fields.plantTime) && noTime(fields.nextTime)) return 'empty';
  if ([1, 2, 3].includes(valueOf(fields.state)) && Number.isSafeInteger(valueOf(fields.flowerId)) && valueOf(fields.flowerId) > 0) return 'occupied';
  return 'unknown';
}
function entityChanged(old, next) {
  // Cultivation entities have no land status/empty-object fields. Normalize
  // those optional members before strict canonicalization on later logins.
  const shape = one => ({ fields: one.fields, status: one.status ?? null,
    removed: one.removed === true, explicitEmptyObject: one.explicitEmptyObject === true });
  return !old || fingerprint(semantic(shape(old))) !== fingerprint(semantic(shape(next)));
}

// Strict single-target binding for the plant/water/harvest diagnostics. Every
// axis has to agree with the stored operation row and the live context; there
// is no textual or "either params or targetRef" fallback. Failures return null
// so the caller keeps the normal refresh path.
export function landWriteTarget({ original, operationRow, context, observation } = {}) {
  if (!original || !operationRow || !context || !observation) return null;
  const featureId = original.featureId;
  if (!Object.hasOwn(LAND_METHODS, featureId)) return null;
  if (LAND_METHODS[featureId] !== original.method || observation.method !== original.method) return null;
  if (operationRow.feature_id !== featureId || operationRow.method !== original.method ||
      operationRow.scope !== original.scope || original.scope !== featureId) return null;
  if (typeof operationRow.params_fingerprint !== 'string' || operationRow.params_fingerprint !== original.paramsFingerprint) return null;
  let captured;
  try {
    const request = original.landRequest;
    if (request !== undefined && (request?.version !== 'land-request/v1' ||
        !['params,version','params,version,workset'].includes(Object.keys(request).sort().join(',')))) return null;
    captured = assertSingleProposal(request ? { ...original, params: request.params } : original);
  } catch { return null; }
  if (captured.featureId !== featureId) return null;
  // Generation axes must be validated as integers before an exact compare; a
  // String() comparison would let undefined/undefined or "3" vs 3 pass.
  // Continuous review 02: ownerRef/subjectRef are checked as real text at this
  // entry itself. Coercing an integer through String() here would let a ref that
  // is not a text reference at all reach the proof chain, and a stricter check
  // further down could not undo that. Only accountRef keeps the existing
  // contract's textual normalisation.
  const textRef = value => typeof value === 'string' && value.length > 0;
  const strictSameRef = (left, right) => textRef(left) && textRef(right) && left === right;
  const reference = value => typeof value === 'string' && value.length > 0 || Number.isSafeInteger(value) && value > 0;
  const sameRef = (left, right) => reference(left) && reference(right) && String(left) === String(right);
  const epoch = value => Number.isSafeInteger(value) && value > 0;
  if (!strictSameRef(original.ownerRef, context.ownerRef) || !sameRef(original.accountRef, context.accountRef) ||
      !strictSameRef(original.subjectRef, context.subjectRef) ||
      !epoch(original.ownerEpoch) || original.ownerEpoch !== context.ownerEpoch ||
      !epoch(original.runEpoch) || original.runEpoch !== context.runEpoch ||
      !epoch(original.connectionEpoch) || original.connectionEpoch !== context.connectionEpoch ||
      !strictSameRef(operationRow.owner_ref, context.ownerRef) || !sameRef(operationRow.account_ref, context.accountRef) ||
      !strictSameRef(operationRow.subject_ref, context.subjectRef) ||
      !epoch(operationRow.run_epoch) || operationRow.run_epoch !== context.runEpoch ||
      !epoch(operationRow.connection_epoch) || operationRow.connection_epoch !== context.connectionEpoch ||
      original.operationId !== observation.operationId) return null;
  const landId = captured.params.landId, flowerId = featureId === 'plant' ? captured.params.flowerId : null;
  return Object.freeze({ featureId, method: captured.method, landId, flowerId, lifecycleRef:original.targets[0].lifecycleRef,
    context: Object.freeze(Object.fromEntries(['ownerRef','accountRef','subjectRef','ownerEpoch','runEpoch','connectionEpoch'].map(key=>[key,context[key]]))),
    workset: original.landRequest?.workset ?? null,
    fields: Object.freeze(featureId === 'harvest'
      ? ['state', 'flowerId', 'plantTime', 'harvestCnt', 'nextTime']
      : ['state', 'flowerId', 'plantTime']) });
}

export function createLandProjection({ store, catalog, catalogForContext = () => catalog, isCurrent, appendOutbox = () => {} } = {}) {
  if (!store || !catalog || typeof isCurrent !== 'function') throw new TypeError('Land projection requires store, catalog and current-context guard');
  const { run, get, transaction, nowIso } = store;
  const revoked = new Set();
  const snapshotCache = createSnapshotCacheClient(store, 'land');
  const cacheScope = context => canonical([context.ownerRef, context.subjectRef]);
  const contextKey = context => fingerprint(['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch'].map(key => context[key] ?? null));
  run(`CREATE TABLE IF NOT EXISTS backend_land_domain_observations(
    observation_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    connection_epoch INTEGER NOT NULL,request_sequence INTEGER,wire_key TEXT,response_ref TEXT NOT NULL,
    payload_fingerprint TEXT NOT NULL,accepted INTEGER NOT NULL,reason_code TEXT,frame_json TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
  run('CREATE INDEX IF NOT EXISTS backend_land_domain_wire ON backend_land_domain_observations(subject_ref,connection_epoch,wire_key,accepted)');
  run(`CREATE TABLE IF NOT EXISTS backend_land_domain_compatibility_revalidations(
    revalidation_ref TEXT PRIMARY KEY,observation_ref TEXT NOT NULL,payload_fingerprint TEXT NOT NULL,proof_fingerprint TEXT NOT NULL,
    accepted INTEGER NOT NULL,reason_code TEXT,receipt_json TEXT NOT NULL,frame_json TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
  run('CREATE UNIQUE INDEX IF NOT EXISTS backend_land_domain_compat_revalidation_unique ON backend_land_domain_compatibility_revalidations(observation_ref,proof_fingerprint)');
  run(`CREATE TABLE IF NOT EXISTS backend_land_domain_heads(subject_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,
    account_ref TEXT NOT NULL,revision INTEGER NOT NULL,model_json TEXT NOT NULL,updated_at TEXT NOT NULL)`);
  run(`CREATE TABLE IF NOT EXISTS backend_land_domain_bindings(binding_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,
    subject_ref TEXT NOT NULL,previous_account_ref TEXT NOT NULL,current_account_ref TEXT NOT NULL,
    official_uid INTEGER NOT NULL,observation_ref TEXT NOT NULL,evidence_json TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
  for (const action of ['UPDATE', 'DELETE']) run(`CREATE TRIGGER IF NOT EXISTS backend_land_domain_observations_no_${action.toLowerCase()}
    BEFORE ${action} ON backend_land_domain_observations BEGIN SELECT RAISE(ABORT,'land observations are append only'); END`);
  for (const action of ['UPDATE', 'DELETE']) run(`CREATE TRIGGER IF NOT EXISTS backend_land_domain_compat_revalidations_no_${action.toLowerCase()}
    BEFORE ${action} ON backend_land_domain_compatibility_revalidations BEGIN SELECT RAISE(ABORT,'land compatibility evidence is append only'); END`);
  for (const action of ['UPDATE', 'DELETE']) run(`CREATE TRIGGER IF NOT EXISTS backend_land_domain_bindings_no_${action.toLowerCase()}
    BEFORE ${action} ON backend_land_domain_bindings BEGIN SELECT RAISE(ABORT,'land binding evidence is append only'); END`);
  function load(context) {
    const row = get('SELECT * FROM backend_land_domain_heads WHERE subject_ref=? AND owner_ref=? AND account_ref=?', context.subjectRef, context.ownerRef, context.accountRef);
    return row ? parseStored(row.model_json, 'land domain model') : empty(context);
  }
  function ingest(frame, { sourcePolicyRef = null } = {}) {
    if (!frame?.observationRef || !frame.context?.subjectRef || !frame.source) throw problem('LAND_FRAME_INVALID', '土地事实帧不完整', 500);
    const context = frame.context, source = frame.source;
    return transaction(() => {
      const scope = get('SELECT owner_ref,account_ref,model_json FROM backend_land_domain_heads WHERE subject_ref=?', context.subjectRef);
      if (scope && scope.owner_ref !== context.ownerRef) throw problem('LAND_SUBJECT_SCOPE_CONFLICT', '土地资料归属冲突，原资料保留', 500);
      const rebind = scope && scope.account_ref !== context.accountRef;
      const payload = Object.fromEntries(['profile', 'landUid', 'landBase', 'landChanges', 'cultivates', 'bag', 'itemExt', 'bi', 'bo', 'bd', 'top', 'harvestMap'].map(key => [key, semantic(frame[key])]));
      const digest = fingerprint(payload);
      const existing = get('SELECT * FROM backend_land_domain_observations WHERE observation_ref=?', frame.observationRef);
      let compatibilityPromotion = false;
      let compatibilityCandidate = null;
      if (existing) {
        let original = null;
        try { original = parseStored(existing.frame_json, 'land prior observation'); } catch {}
        const sameContext = original && ['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch']
          .every(key => (original.context?.[key] ?? null) === (context[key] ?? null));
        const priorSource = original?.source;
        const sameSource = priorSource && priorSource.responseRef === source.responseRef && priorSource.wireKey === source.wireKey &&
          priorSource.requestSequence === source.requestSequence && priorSource.connectionEpoch === source.connectionEpoch &&
          priorSource.method === source.method && priorSource.kind === source.kind &&
          priorSource.receivedDeviceMs === source.receivedDeviceMs && priorSource.receivedMonotonicMs === source.receivedMonotonicMs;
        const exactAcceptedReplay = existing.accepted === 1 && existing.owner_ref === context.ownerRef &&
          existing.account_ref === context.accountRef && existing.subject_ref === context.subjectRef &&
          existing.connection_epoch === context.connectionEpoch && existing.request_sequence === source.requestSequence &&
          existing.wire_key === source.wireKey && existing.response_ref === source.responseRef &&
          existing.payload_fingerprint === digest && sameContext && sameSource && frame.admissible === true &&
          isCurrent(context) === true && !revoked.has(contextKey(context));
        if (exactAcceptedReplay) return { accepted: false, coverageReplay: true, changed: false, changedDomains: [], replayed: true,
          reasonCode: null, replayReceiptRef: frame.observationRef, changedLandIds: [], changedCultivateIds: [], changes: [], issues: [] };
        if (existing.accepted === 0 && existing.owner_ref === context.ownerRef && existing.account_ref === context.accountRef &&
            existing.subject_ref === context.subjectRef && existing.connection_epoch === context.connectionEpoch &&
            existing.request_sequence === source.requestSequence && existing.wire_key === source.wireKey && existing.response_ref === source.responseRef &&
            existing.payload_fingerprint === digest && sameContext && sameSource && isCurrent(context) === true && !revoked.has(contextKey(context))) {
          compatibilityCandidate = buildLandCompatibilityRevalidation({ store, context, originalRow: existing, originalFrame: original,
            currentFrame: frame, currentSourcePolicyRef: sourcePolicyRef });
          if (compatibilityCandidate) {
            const prior = resolveAcceptedLandObservationEvidence({ store, context, observationRef: frame.observationRef, source: frame.source });
            if (prior?.compatibility === true && prior.frame?.admissible === true && prior.compatibilityRef === compatibilityCandidate.receiptRef)
              return { accepted: false, coverageReplay: true, changed: false, changedDomains: [], replayed: true,
                reasonCode: null, replayReceiptRef: prior.compatibilityRef, changedLandIds: [], changedCultivateIds: [], changes: [], issues: [] };
          }
        }
        if (!compatibilityCandidate) return { accepted: false, coverageReplay: false, changed: false, changedDomains: [], replayed: true,
          reasonCode: exactAcceptedReplay ? null : existing.reason_code || 'LAND_OBSERVATION_ALREADY_SEEN',
          replayReceiptRef: null,
          changedLandIds: [], changedCultivateIds: [], changes: [], issues: [] };
        compatibilityPromotion = true;
      }
      const model = rebind ? parseStored(scope.model_json, 'land previous account binding') : load(context);
      const priorWire = source.wireKey ? get(`SELECT payload_fingerprint FROM backend_land_domain_observations
        WHERE subject_ref=? AND connection_epoch=? AND wire_key=? AND accepted=1 LIMIT 1`, context.subjectRef, source.connectionEpoch, source.wireKey) : null;
      const oldUid = model.identity.verified ? valueOf(model.identity.uid) : null;
      const currentIdentity = model.identity.verified && model.identity.source?.connectionEpoch === context.connectionEpoch;
      const incomingUid = valueOf(frame.profile.uid);
      let reasonCode = isCurrent(context) !== true || revoked.has(contextKey(context)) ? 'LAND_CONTEXT_NOT_CURRENT' : !frame.admissible ? frame.reasonCode : priorWire ?
        priorWire.payload_fingerprint === digest ? 'LAND_WIRE_DUPLICATE' : 'LAND_WIRE_CONTENT_CONFLICT' : null;
      if (!reasonCode && oldUid !== null && incomingUid !== null && oldUid !== incomingUid) reasonCode = 'LAND_OFFICIAL_UID_CONFLICT';
      if (!reasonCode && frame.profile.uid.presence !== 'missing' && !knownCell(frame.profile.uid)) reasonCode = 'LAND_OFFICIAL_UID_UNREADABLE';
      const isLogin = source.method === 'index.login';
      if (!reasonCode && !currentIdentity && !(isLogin && incomingUid > 0)) reasonCode = 'LAND_LOGIN_IDENTITY_UNVERIFIED';
      // A stable subject already includes the official server/UID binding at
      // the composition root. Only its current normally verified login can
      // move a same-owner head to a new local roster row after remove/re-add.
      if (!reasonCode && rebind && !(isLogin && incomingUid > 0 && oldUid === incomingUid && newer(source, model.identity.source))) {
        reasonCode = 'LAND_ACCOUNT_BINDING_REQUIRES_VERIFIED_LOGIN';
      }
      const accepted = reasonCode === null;
      if (!existing) run('INSERT INTO backend_land_domain_observations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', frame.observationRef, context.ownerRef, context.accountRef,
        context.subjectRef, context.connectionEpoch, source.requestSequence, source.wireKey, source.responseRef, digest, Number(accepted), reasonCode, encodeEvidenceJson(canonical(frame)), nowIso());
      if (!accepted) return { accepted: false, changed: false, changedDomains: [], reasonCode, changedLandIds: [], changedCultivateIds: [], changes: [], issues: frame.issues || [] };
      if (compatibilityPromotion && compatibilityCandidate) {
        run(`INSERT OR IGNORE INTO backend_land_domain_compatibility_revalidations VALUES(?,?,?,?,?,?,?,?,?)`, compatibilityCandidate.receiptRef,
          frame.observationRef, digest, compatibilityCandidate.proofFingerprint, 1, null, storeLandCompatibilityReceipt(store, compatibilityCandidate.receipt), encodeEvidenceJson(canonical(frame)), nowIso());
      }
      if (rebind) run('INSERT INTO backend_land_domain_bindings VALUES(?,?,?,?,?,?,?,?,?)',
        'land-binding:' + fingerprint([context.ownerRef, context.subjectRef, scope.account_ref, context.accountRef, frame.observationRef]),
        context.ownerRef, context.subjectRef, scope.account_ref, context.accountRef, incomingUid, frame.observationRef,
        canonical({ reasonCode: 'NORMAL_LOGIN_SAME_OWNER_STABLE_SUBJECT', previousContext: model.context, currentContext: context,
          source, originalObservationsRetained: true }), nowIso());
      const changes = [], issues = [], changedLandIds = [], changedCultivateIds = [], observedLandIds = [];
      if (isLogin && incomingUid > 0 && newer(source, model.identity.source)) {
        model.identity = { uid: sourced(frame.profile.uid, source, model.identity.uid), verified: true, source: clone(source) };
      }
      for (const [name, one] of Object.entries(frame.profile)) {
        if (one.presence === 'missing' || !newer(source, model.profile[name]?.source)) continue;
        const next = sourced(one, source, model.profile[name]);
        if (fingerprint(semantic(next)) !== fingerprint(semantic(model.profile[name] || missingCell()))) changes.push('profile:' + name);
        model.profile[name] = next;
      }
      const landOwner = valueOf(frame.landUid), uid = valueOf(model.identity.uid);
      const landAllowed = frame.landUid.presence === 'missing' || landOwner !== null && landOwner === uid;
      if (!landAllowed) issues.push({ reasonCode: 'LAND_FRAME_OWNER_MISMATCH_OR_UNREADABLE', domain: 'land' });
      function putLand(id, member, kind, equal = false) {
        const old = model.lands[id];
        if (model.landCompleteSource && !newer(source, model.landCompleteSource, true)) return;
        if (!newer(source, old?.source, equal)) return;
        observedLandIds.push(Number(id));
        const fields = Object.fromEntries(Object.entries(member.fields).map(([name, one]) => [name, sourced(one, source, old?.fields?.[name])]));
        const status = landStatus(member);
        const next = { subjectRef: context.subjectRef, landId: Number(id), fields, status, removed: member.removed, explicitEmptyObject: member.explicitEmptyObject === true,
          source: clone(source), coverage: cover(source, kind, frame.coverage.landMapComplete), current: true, issues: [] };
        if (!catalogForContext(context)?.land(Number(id))) next.issues.push({ reasonCode: 'LAND_ID_OUTSIDE_STATIC_CATALOG' });
        if (!member.valid || status === 'unknown') next.issues.push({ reasonCode: member.reasonCode || 'LAND_ROW_QUALIFICATION_UNKNOWN' });
        const changed = entityChanged(old, next);
        next.semanticVersion = (old?.semanticVersion || 0) + Number(changed);
        model.lands[id] = next;
        if (changed) { changedLandIds.push(Number(id)); changes.push('land:' + id); }
      }
      if (landAllowed) {
        if (knownCell(frame.landBase)) {
          if (frame.coverage.landMapComplete) {
            for (const id of Object.keys(model.lands)) if (!Object.hasOwn(frame.landBase.value, id) && newer(source, model.lands[id].source)) {
              putLand(id, { valid: true, removed: true, fields: {} }, 'complete-map-absence');
            }
          }
          for (const [id, member] of Object.entries(frame.landBase.value)) putLand(id, member, frame.coverage.landMapComplete ? 'complete-map' : 'listed-members');
        }
        if (knownCell(frame.landChanges)) for (const [id, member] of Object.entries(frame.landChanges.value)) putLand(id, member, 'listed-member-replacement', true);
        if (knownCell(frame.landBase) && frame.coverage.landMapComplete && newer(source, model.landCompleteSource)) model.landCompleteSource = clone(source);
      }
      if (knownCell(frame.cultivates)) for (const [id, member] of Object.entries(frame.cultivates.value)) {
        const old = model.cultivates[id];
        if (!newer(source, old?.source)) continue;
        const fields = member.removed ? {} : clone(old?.removed ? {} : old?.fields || {});
        for (const [name, one] of Object.entries(member.fields)) if (one.presence !== 'missing' || !fields[name]) fields[name] = sourced(one, source, fields[name]);
        const owner = valueOf(fields.uid), flower = valueOf(fields.flowerId);
        const valid = member.valid && (fields.uid?.presence === 'missing' || owner === uid) && (fields.flowerId?.presence === 'missing' || flower === Number(id));
        const next = { subjectRef: context.subjectRef, flowerId: Number(id), fields, removed: member.removed, source: clone(source), coverage: cover(source, 'listed-member-field-merge'), current: true,
          issues: valid ? [] : [{ reasonCode: 'CULTIVATE_MEMBER_IDENTITY_UNVERIFIED' }], valid };
        const changed = entityChanged(old, next) || old?.valid !== next.valid;
        next.semanticVersion = (old?.semanticVersion || 0) + Number(changed);
        model.cultivates[id] = next;
        if (changed) { changedCultivateIds.push(Number(id)); changes.push('cultivate:' + id); }
      }
      const putInventory = (name, entry, complete) => {
        const old = model.inventory[name];
        if (entry.presence === 'missing' || !newer(source, old.source)) return;
        const next = { ...clone(entry), source: clone(source), complete: complete && entry.state === 'known', items: {}, coverage: cover(source, 'property-replacement', complete) };
        if (name === 'bag') {
          for (const [id, one] of Object.entries(entry.items || {})) next.items[id] = sourced(one, source, old.items?.[id]);
          // A newer absolute bd may already have updated one item while this
          // earlier full-bag request was in flight. Keep that newer item.
          for (const [id, one] of Object.entries(old.items || {})) if (!newer(source, one.source, true)) next.items[id] = clone(one);
          if (entry.presence === 'present' && entry.value && typeof entry.value === 'object') {
            next.value = Object.fromEntries(Object.entries(next.items).filter(([, one]) => knownCell(one)).map(([id, one]) => [id, one.value]));
            if (Object.values(next.items).some(one => !knownCell(one))) { next.state = 'unreadable'; next.complete = false; }
          }
        } else if (knownCell(entry)) {
          for (const [id, one] of Object.entries(entry.value)) next.items[id] = { ...clone(one), source: clone(source),
            fields: Object.fromEntries(Object.entries(one.fields).map(([key, field]) => [key, sourced(field, source, old.items?.[id]?.fields?.[key])])) };
        }
        next.semanticVersion = (old.semanticVersion || 0) + Number(fingerprint(semantic({ value: next.value, complete: next.complete, state: next.state }))
          !== fingerprint(semantic({ value: old.value, complete: old.complete, state: old.state })));
        if (next.semanticVersion !== old.semanticVersion) changes.push('inventory:' + name);
        model.inventory[name] = next;
      };
      putInventory('bag', frame.bag, frame.coverage.bagComplete);
      putInventory('itemExt', frame.itemExt, frame.coverage.itemExtComplete);
      // The official controller skips oi on login. bd is an absolute sparse
      // patch; bi/bo never change this balance a second time. G480's
      // _updateBag maps currency/experience ids into profile instead of bag.
      if (!isLogin && frame.bd.presence === 'present' && frame.bd.items) {
        const bag = model.inventory.bag;
        const profileItems = { '1': 'yuanbao', '2': 'lvlExp', '3': 'vipExp', '11': 'gold' };
        for (const [id, name] of Object.entries(profileItems)) {
          const one = frame.bd.items[id];
          if (!one || !newer(source, model.profile[name]?.source, true)) continue;
          const next = sourced(one, source, model.profile[name]);
          if (fingerprint(semantic(next)) !== fingerprint(semantic(model.profile[name] || missingCell()))) changes.push('profile:' + name);
          model.profile[name] = next;
        }
        for (const [id, one] of Object.entries(frame.bd.items)) if (!Object.hasOwn(profileItems, id) &&
            newer(source, bag.source, true) && newer(source, bag.items[id]?.source, true)) {
          const old = bag.items[id];
          bag.items[id] = sourced(one, source, old);
          if (knownCell(one)) { if (!bag.value || typeof bag.value !== 'object') bag.value = {}; bag.value[id] = one.value; }
          if (fingerprint(semantic(old || missingCell())) !== fingerprint(semantic(one))) { bag.semanticVersion += 1; changes.push('inventory:item:' + id); }
        }
      }
      if (frame.top.presence !== 'missing' && newer(source, model.top.source)) {
        const next = sourced(frame.top, source, model.top);
        if (fingerprint(semantic(next)) !== fingerprint(semantic(model.top))) changes.push('top');
        model.top = next;
      }
      model.context = clone(context); model.coverage = { ...clone(frame.coverage), source: clone(source) };
      if (changes.length) model.revision += 1;
      run(`INSERT INTO backend_land_domain_heads VALUES(?,?,?,?,?,?) ON CONFLICT(subject_ref) DO UPDATE SET
        account_ref=excluded.account_ref,revision=excluded.revision,model_json=excluded.model_json,updated_at=excluded.updated_at`, context.subjectRef, context.ownerRef, context.accountRef, model.revision, canonical(model), nowIso());
      if (changes.length) appendOutbox({ ownerRef: context.ownerRef, subjectRef: context.subjectRef, eventType: 'FactsChanged',
        eventKey: 'land-domain:' + frame.observationRef, payload: { domain: 'land-domain', revision: model.revision,
          changedLandIds: [...new Set(changedLandIds)], changedCultivateIds: [...new Set(changedCultivateIds)], changes: [...new Set(changes)], responseRef: source.responseRef } });
      return freeze({ accepted: true, changed: changes.length > 0, changedDomains: changes.length ? ['land-domain'] : [], reasonCode: null,
        observedLandIds: [...new Set(observedLandIds)], changedLandIds: [...new Set(changedLandIds)], changedCultivateIds: [...new Set(changedCultivateIds)], changes: [...new Set(changes)], issues, revision: model.revision });
    });
  }
  function view(context) {
    const head = get('SELECT model_json FROM backend_land_domain_heads WHERE subject_ref=? AND owner_ref=? AND account_ref=?',
      context.subjectRef, context.ownerRef, context.accountRef);
    const modelJson = head?.model_json ?? null;
    const current = isCurrent(context) === true && !revoked.has(contextKey(context));
    let contextCanonical = null;
    try { contextCanonical = canonical(context); } catch {}
    const signature = [modelJson, current], cached = modelJson !== null && contextCanonical !== null ? snapshotCache.get(contextCanonical, signature) : null;
    if (cached) return cached;
    const model = modelJson === null ? empty(context) : parseStored(modelJson, 'land domain model');
    const staleCell = one => {
      if (one && typeof one === 'object') {
        if (one.state === 'known' && one.source && (!current || one.source.connectionEpoch !== context.connectionEpoch)) { one.state = 'stale'; one.reasonCode = 'LAND_SOURCE_CONNECTION_STALE'; }
        for (const child of Object.values(one)) if (child && typeof child === 'object') staleCell(child);
      }
    };
    staleCell(model);
    model.current = current && model.identity.source?.connectionEpoch === context.connectionEpoch && model.identity.verified;
    if (!model.current) model.identity.verified = false;
    for (const collection of [model.lands, model.cultivates]) for (const one of Object.values(collection)) {
      one.current = model.current && one.source.connectionEpoch === context.connectionEpoch;
    }
    model.context = clone(context);
    const result = freeze(model);
    if (modelJson !== null && contextCanonical !== null) snapshotCache.put({ key: contextCanonical, scope: cacheScope(context),
      signature, value: result, sourceBytes: Buffer.byteLength(modelJson, 'utf8') });
    return result;
  }
  function basis({ context, targets = [], purposes = [] } = {}) {
    const model = view(context), selected = {};
    for (const target of targets) {
      const id = typeof target === 'number' ? target : target.landId ?? Number(String(target.targetRef || '').split(':').at(-1));
      const one = model.lands[id];
      selected[id] = one ? { semanticVersion: one.semanticVersion, current: one.current, status: one.status, fields: semantic(one.fields) } : null;
    }
    return freeze({ version: 'land-basis/v1', subjectRef: context.subjectRef, connectionEpoch: context.connectionEpoch,
      identityVerified: model.identity.verified, uid: valueOf(model.identity.uid), purposes: [...purposes], lands: selected,
      catalogId: catalogForContext(context)?.identity().catalogId ?? null });
  }
  return Object.freeze({ ingest, view, basis, invalidate: context => { revoked.add(contextKey(context));
    snapshotCache.dropScope(cacheScope(context));
    return { invalidated: true, subjectRef: context.subjectRef, connectionEpoch: context.connectionEpoch }; }, disposeCache: snapshotCache.dispose });
}
