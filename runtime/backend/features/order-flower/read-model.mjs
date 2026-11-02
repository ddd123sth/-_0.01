import { encodeEvidenceJson, canonical, clone, fingerprint, freeze, parseStored, problem } from '../../common.mjs';
import { officialActionContractId } from '../../official-version-profile.mjs';
import { createSnapshotCacheClient } from '../../facts/snapshot-cache.mjs';
import { decodeOfficialOrderFlowerObservation, ORDER_FLOWER_FIELDS, ORDER_FLOWER_ELIGIBILITY_FIELDS, ORDER_FLOWER_BUTLER_FIELDS, ORDER_FLOWER_BUTLER_TYPES, knownOrderFlowerCell, missingOrderFlowerCell,
  orderFlowerContext, orderFlowerContextKey, sameOrderFlowerContext } from './wire-facts.mjs';

const sync = value => { if (value?.then) { value.catch?.(() => {}); throw new TypeError('Order flower current guard must be synchronous'); } return value; };
const positive = value => Number.isSafeInteger(value) && value > 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const COUNTER_FIELDS = ['domain', 'uid', 'type', 'tdyCnt', 'totCnt', 'rTime', 'uTime', 'cTime'];
const SHARE_FIELDS = ['domain', 'uid', 'tmpId', 'shareCnt', 'recvCnt', 'recvTime', 'totCnt', 'uTime', 'cTime'];
const CARD_FIELDS = ['map', 'domain', 'uid', 'type', 'isMain', 'receiveTime', 'invalidTime', 'cTime', 'expire', 'refundDeductMs'];
const emptyGroup = keys => Object.fromEntries(keys.map(key => [key, missingOrderFlowerCell()]));
const FINANCIAL_FIELDS = ['bag', 'gold', 'yb', 'level', 'lvlExp', 'vipExp', 'levelRewardItems', '1106', '1340'];
const emptyButler = () => ({ domain: missingOrderFlowerCell(), settingMap: missingOrderFlowerCell(),
  types: Object.fromEntries(ORDER_FLOWER_BUTLER_TYPES.map(id => [id, emptyGroup(ORDER_FLOWER_BUTLER_FIELDS)])) });
const emptyEligibility = () => ({ ...Object.fromEntries(Object.entries(ORDER_FLOWER_ELIGIBILITY_FIELDS).map(([group, keys]) => [group, emptyGroup(keys)])),
  sdkChannel: missingOrderFlowerCell() });
const semantic = value => Array.isArray(value) ? value.map(semantic) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => !['source', 'lastSource', 'revision', 'barriers'].includes(key)).map(([key, child]) => [key, semantic(child)])) : value;

// Read-only effective view over immutable wire evidence and append-only
// compatibility revalidations. Never changes the original accepted bit.
export function resolveOrderFlowerObservationEvidence({ store, context, requestSequence, responseRef } = {}) {
  if (typeof store?.get !== 'function' || typeof store?.all !== 'function' || !context || !positive(requestSequence) || !reference(responseRef)) return null;
  const row = store.get(`SELECT * FROM backend_order_flower_observations WHERE owner_ref=? AND account_ref=? AND subject_ref=?
    AND connection_epoch=? AND request_sequence=? AND response_ref=?`, context.ownerRef, context.accountRef, context.subjectRef,
  context.connectionEpoch, requestSequence, responseRef);
  if (!row) return null;
  let original;
  try { original = parseStored(row.payload_json, '三类订单原始来源证据'); } catch { return null; }
  if (fingerprint(original) !== row.payload_fingerprint || original.observationRef !== row.observation_ref ||
      !sameOrderFlowerContext(original.context, context) || original.source?.connectionEpoch !== context.connectionEpoch ||
      original.source?.requestSequence !== requestSequence || original.source?.responseRef !== responseRef ||
      !original.payloadFingerprint || fingerprint(original.payload) !== original.payloadFingerprint) return null;
  if (row.accepted === 1 && original.admissible === true) return { row, frame: original, accepted: true, revalidated: false,
    wholeFrameFingerprint: row.payload_fingerprint, payloadFingerprint: original.payloadFingerprint };
  if (row.accepted !== 0 || row.reason_code !== 'ORDER_FLOWER_VERSION_SOURCE_UNPROVEN' || original.admissible !== false) return null;
  const receipts = store.all(`SELECT * FROM backend_order_flower_compatibility_revalidations WHERE observation_ref=? AND accepted=1
    ORDER BY recorded_at DESC,revalidation_ref DESC`, row.observation_ref);
  for (const receipt of receipts) {
    let frame;
    try { frame = parseStored(receipt.payload_json, '三类订单兼容重评来源'); } catch { continue; }
    // payloadFingerprint is the normalized payload hash; row.payload_fingerprint
    // above is the whole-frame hash. Preserve and compare these distinct axes.
    if (receipt.payload_fingerprint !== original.payloadFingerprint || frame.payloadFingerprint !== original.payloadFingerprint ||
        canonical(frame.payload) !== canonical(original.payload) || frame.admissible !== true ||
        frame.observationRef !== original.observationRef || !sameOrderFlowerContext(frame.context, context) ||
        frame.source?.connectionEpoch !== original.source?.connectionEpoch || frame.source?.requestSequence !== original.source?.requestSequence ||
        frame.source?.wireKey !== original.source?.wireKey || frame.source?.responseRef !== original.source?.responseRef ||
        frame.source?.method !== original.source?.method || frame.source?.version?.loginResponseRef !== responseRef ||
        fingerprint(frame.source?.version?.sourceProofs) !== receipt.proof_fingerprint) continue;
    return { row, frame, accepted: true, revalidated: true, revalidationRef: receipt.revalidation_ref,
      wholeFrameFingerprint: row.payload_fingerprint, payloadFingerprint: original.payloadFingerprint,
      revalidationPayloadFingerprint: receipt.payload_fingerprint, proofFingerprint: receipt.proof_fingerprint };
  }
  return null;
}
const empty = context => ({ context, identity: { verified: false, uid: missingOrderFlowerCell(), source: null }, level: missingOrderFlowerCell(),
  domain: missingOrderFlowerCell(), fields: emptyGroup(ORDER_FLOWER_FIELDS),
  counters: { map: missingOrderFlowerCell(), ...Object.fromEntries([105, 109, 116].map(id => [id, emptyGroup(COUNTER_FIELDS)])) },
  shares: { map: missingOrderFlowerCell(), ...Object.fromEntries([5, 19, 34].map(id => [id, emptyGroup(SHARE_FIELDS)])) },
  adCard: emptyGroup(CARD_FIELDS), financial: emptyGroup(FINANCIAL_FIELDS), eligibilityInputs: emptyEligibility(), butler: emptyButler(),
  barriers: {}, lastSource: null, revision: 0 });

export function createOrderFlowerReadModel({ store, isCurrent } = {}) {
  for (const fn of [store?.run, store?.get, store?.transaction, store?.nowIso, isCurrent]) if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') throw new TypeError('Order flower read model requires synchronous store/current ports');
  store.run(`CREATE TABLE IF NOT EXISTS backend_order_flower_heads(owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    context_key TEXT NOT NULL,model_json TEXT NOT NULL,model_fingerprint TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL,
    PRIMARY KEY(owner_ref,account_ref,subject_ref))`);
  store.run(`CREATE TABLE IF NOT EXISTS backend_order_flower_observations(observation_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,
    account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,context_key TEXT NOT NULL,connection_epoch INTEGER NOT NULL,request_sequence INTEGER,
    response_ref TEXT NOT NULL,accepted INTEGER NOT NULL,reason_code TEXT,payload_json TEXT NOT NULL,payload_fingerprint TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
  for (const action of ['UPDATE', 'DELETE']) store.run(`CREATE TRIGGER IF NOT EXISTS backend_order_flower_observations_no_${action.toLowerCase()}
    BEFORE ${action} ON backend_order_flower_observations BEGIN SELECT RAISE(ABORT,'order flower observations are append only'); END`);
  store.run(`CREATE TABLE IF NOT EXISTS backend_order_flower_compatibility_revalidations(
    revalidation_ref TEXT PRIMARY KEY,observation_ref TEXT NOT NULL,payload_fingerprint TEXT NOT NULL,proof_fingerprint TEXT NOT NULL,
    accepted INTEGER NOT NULL,reason_code TEXT,payload_json TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
  store.run('CREATE UNIQUE INDEX IF NOT EXISTS backend_order_flower_compatibility_revalidation_unique ON backend_order_flower_compatibility_revalidations(observation_ref,proof_fingerprint)');
  for (const action of ['UPDATE', 'DELETE']) store.run(`CREATE TRIGGER IF NOT EXISTS backend_order_flower_compatibility_revalidations_no_${action.toLowerCase()}
    BEFORE ${action} ON backend_order_flower_compatibility_revalidations BEGIN SELECT RAISE(ABORT,'order compatibility revalidations are append only'); END`);
  const stopped = new Set(); let closed = false;
  const current = context => !closed && !stopped.has(orderFlowerContextKey(context)) && sync(isCurrent(context)) === true;
  const headRow = context => store.get('SELECT * FROM backend_order_flower_heads WHERE owner_ref=? AND account_ref=? AND subject_ref=?', context.ownerRef, context.accountRef, context.subjectRef);
  // At most one immutable full view per account. Raw head bytes, fingerprint,
  // context and currentness are checked afresh on every hit; admission results
  // and the financial overlay supplied by live land facts are never cached.
  const viewCache = createSnapshotCacheClient(store, 'order-flower');
  const cacheScope = context => canonical([context.ownerRef, context.subjectRef]);
  function load(context, row = headRow(context)) {
    if (!row) return empty(context);
    const model = parseStored(row.model_json, '鲜花订单只读头');
    if (fingerprint(model) !== row.model_fingerprint) throw problem('ORDER_FLOWER_HEAD_CORRUPT', '鲜花订单只读来源指纹不一致', 500);
    model.financial ||= {};
    for (const key of FINANCIAL_FIELDS) model.financial[key] ||= missingOrderFlowerCell();
    model.butler ||= emptyButler(); model.butler.types ||= {};
    for (const key of ['domain', 'settingMap']) model.butler[key] ||= missingOrderFlowerCell();
    for (const id of ORDER_FLOWER_BUTLER_TYPES) {
      model.butler.types[id] ||= {};
      for (const key of ORDER_FLOWER_BUTLER_FIELDS) model.butler.types[id][key] ||= missingOrderFlowerCell();
    }
    model.eligibilityInputs ||= emptyEligibility();
    for (const [group, keys] of Object.entries(ORDER_FLOWER_ELIGIBILITY_FIELDS)) {
      model.eligibilityInputs[group] ||= {};
      for (const key of keys) model.eligibilityInputs[group][key] ||= missingOrderFlowerCell();
    }
    model.eligibilityInputs.sdkChannel ||= missingOrderFlowerCell();
    return model;
  }
  function audit(frame, accepted, reasonCode) {
    store.run('INSERT INTO backend_order_flower_observations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', frame.observationRef,
      frame.context.ownerRef, frame.context.accountRef, frame.context.subjectRef, orderFlowerContextKey(frame.context), frame.context.connectionEpoch,
      frame.source.requestSequence, frame.source.responseRef, accepted ? 1 : 0, reasonCode, encodeEvidenceJson(canonical(frame), { minimumBytes: 4096 }), fingerprint(frame), store.nowIso());
  }
  function auditRevalidation(frame, accepted, reasonCode) {
    const proofFingerprint = fingerprint(frame.source.version.sourceProofs);
    store.run(`INSERT OR IGNORE INTO backend_order_flower_compatibility_revalidations VALUES(?,?,?,?,?,?,?,?)`,
      'order-flower-compatibility-revalidation:' + fingerprint([frame.observationRef, proofFingerprint]), frame.observationRef,
      frame.payloadFingerprint, proofFingerprint, Number(accepted), reasonCode, encodeEvidenceJson(canonical(frame), { minimumBytes: 4096 }), store.nowIso());
  }
  function save(model) {
    const context = model.context;
    store.run(`INSERT INTO backend_order_flower_heads VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,account_ref,subject_ref) DO UPDATE SET
      context_key=excluded.context_key,model_json=excluded.model_json,model_fingerprint=excluded.model_fingerprint,revision=excluded.revision,updated_at=excluded.updated_at`,
    context.ownerRef, context.accountRef, context.subjectRef, orderFlowerContextKey(context), canonical(model), fingerprint(model), model.revision, store.nowIso());
  }
  const supplied = cell => cell.presence !== 'missing';
  function ingest({ context: suppliedContext, observation } = {}) {
    const frame = decodeOfficialOrderFlowerObservation({ context: suppliedContext, observation });
    if (!frame) return freeze({ accepted: false, reasonCode: 'ORDER_FLOWER_CONTEXT_OR_SOURCE_INVALID' });
    return store.transaction(() => {
      // Referenced old connections still collect late source evidence for
      // their operations, including unknown writes. Only the same dependency-
      // free connections eligible for source exit may ignore old replays.
      if (store.get('SELECT connection_epoch FROM backend_subject_connection_epochs WHERE subject_ref=?', frame.context.subjectRef)?.connection_epoch > frame.context.connectionEpoch
          && !store.get('SELECT 1 FROM backend_operations WHERE subject_ref=? AND connection_epoch=? LIMIT 1', frame.context.subjectRef, frame.context.connectionEpoch)
          && !store.get('SELECT 1 FROM backend_session_verification_leases WHERE subject_ref=? AND original_connection_epoch=? LIMIT 1', frame.context.subjectRef, frame.context.connectionEpoch)
          && !store.get('SELECT 1 FROM backend_session_verification_leases WHERE subject_ref=? AND new_connection_epoch=? LIMIT 1', frame.context.subjectRef, frame.context.connectionEpoch))
        return freeze({ accepted: false, replayed: true, sourceIgnored: true, reasonCode: 'ORDER_FLOWER_SOURCE_CONNECTION_SUPERSEDED' });
      const priorObservation = store.get('SELECT reason_code,payload_fingerprint,payload_json FROM backend_order_flower_observations WHERE observation_ref=?', frame.observationRef);
      const originalFrame = priorObservation ? parseStored(priorObservation.payload_json, 'order flower source receipt') : null;
      const hasOrderProof = ['order.resident', 'order.satin', 'order.decorate'].some(action => {
        const proof = frame.source.version.sourceProofs?.[action];
        return proof?.supported === true && proof.sourceVersion === frame.source.version.gameVersion &&
          proof.protocolVersion === frame.source.version.protocolVersion && proof.actionContractId === officialActionContractId(action) &&
          /^[a-f0-9]{64}$/.test(proof.gameSha256 || '') && /^[a-f0-9]{64}$/.test(proof.moSha256 || '');
      });
      const proofFingerprint = fingerprint(frame.source.version.sourceProofs);
      const revalidation = !!priorObservation && priorObservation.reason_code === 'ORDER_FLOWER_VERSION_SOURCE_UNPROVEN' &&
        originalFrame?.payloadFingerprint === frame.payloadFingerprint && frame.source.method === 'index.login' &&
        frame.source.responseRef === frame.source.version.loginResponseRef && hasOrderProof &&
        fingerprint(originalFrame?.context) === fingerprint(frame.context) && originalFrame?.source?.requestSequence === frame.source.requestSequence &&
        originalFrame?.source?.wireKey === frame.source.wireKey && originalFrame?.payload?.profileUid?.value === frame.payload.profileUid?.value &&
        !store.get('SELECT 1 FROM backend_order_flower_compatibility_revalidations WHERE observation_ref=? AND proof_fingerprint=?', frame.observationRef, proofFingerprint);
      if (priorObservation && !revalidation) return freeze({ accepted: false, replayed: true });
      const context = frame.context, before = load(context), same = sameOrderFlowerContext(context, before.context), payload = frame.payload,
        beforeSemantic = canonical(semantic(before));
      let reasonCode = !current(context) ? 'ORDER_FLOWER_CONTEXT_REVOKED' : !frame.admissible ? frame.reasonCode : null;
      const login = frame.source.method === 'index.login';
      if (!reasonCode && same && before.lastSource && frame.source.requestSequence <= before.lastSource.requestSequence) reasonCode = 'ORDER_FLOWER_SEQUENCE_NOT_NEWER';
      if (!reasonCode && (!same || !before.identity.verified) && (!login || !knownOrderFlowerCell(payload.profileUid) || frame.source.version.loginResponseRef !== frame.source.responseRef)) reasonCode = 'ORDER_FLOWER_NORMAL_LOGIN_REQUIRED';
      if (!reasonCode && before.identity.verified && knownOrderFlowerCell(payload.profileUid) && payload.profileUid.value !== before.identity.uid.value) reasonCode = 'ORDER_FLOWER_STABLE_UID_CONFLICT';
      if (!reasonCode && same && before.identity.verified && frame.source.version.loginResponseRef !== before.identity.source.responseRef) reasonCode = 'ORDER_FLOWER_LOGIN_VERSION_BINDING_CHANGED';
      const uid = knownOrderFlowerCell(payload.profileUid) ? payload.profileUid.value : before.identity.uid.value;
      if (!reasonCode && knownOrderFlowerCell(payload.fields.uid) && payload.fields.uid.value !== uid) reasonCode = 'ORDER_FLOWER_DOMAIN_UID_CONFLICT';
      if (reasonCode) {
        if (same && current(context) && frame.admissible && ['ORDER_FLOWER_STABLE_UID_CONFLICT', 'ORDER_FLOWER_DOMAIN_UID_CONFLICT'].includes(reasonCode)) {
          before.barriers.identity = frame.source.requestSequence; before.blockedReason = reasonCode; before.revision += 1; save(before);
        }
        if (same && current(context) && frame.source.kind === 'response' && frame.source.transport === 'answered' &&
          frame.source.requestSequence > (before.lastSource?.requestSequence ?? 0) && reasonCode === 'ORDER_FLOWER_VERSION_SOURCE_UNPROVEN') {
          before.barriers.identity = frame.source.requestSequence; before.blockedReason = reasonCode; before.revision += 1; save(before);
        }
        if (revalidation) auditRevalidation(frame, false, reasonCode); else audit(frame, false, reasonCode);
        return freeze({ accepted: false, audited: true, reasonCode });
      }
      const model = same ? before : empty(context), source = frame.source;
      model.financial ||= emptyGroup(FINANCIAL_FIELDS);
      const assign = (target, key, value) => { if (supplied(value)) target[key] = { ...clone(value), source: clone(source) }; };
      if (login && knownOrderFlowerCell(payload.profileUid)) { model.identity = { verified: true, uid: { ...clone(payload.profileUid), source: clone(source) }, source: clone(source) }; model.blockedReason = null; delete model.barriers.identity; }
      if (supplied(payload.profileUid) && !knownOrderFlowerCell(payload.profileUid)) model.barriers.identity = source.requestSequence;
      assign(model, 'level', payload.level); assign(model, 'domain', payload.domain);
      if (supplied(payload.domain) && !knownOrderFlowerCell(payload.domain) || supplied(payload.fields.uid) && !knownOrderFlowerCell(payload.fields.uid)) model.barriers.order = source.requestSequence;
      for (const key of ORDER_FLOWER_FIELDS) assign(model.fields, key, payload.fields[key]);
      for (const group of ['counters', 'shares']) {
        assign(model[group], 'map', payload[group].map);
        if (supplied(payload[group].map) && !knownOrderFlowerCell(payload[group].map)) model.barriers[group] = source.requestSequence;
        for (const id of group === 'counters' ? [105, 109, 116] : [5, 19, 34]) for (const key of Object.keys(payload[group][id])) assign(model[group][id], key, payload[group][id][key]);
      }
      for (const key of CARD_FIELDS) assign(model.adCard, key, payload.adCard[key]);
      for (const key of Object.keys(model.financial)) assign(model.financial, key, payload.financial[key]);
      for (const key of ['domain', 'settingMap']) {
        assign(model.butler, key, payload.butler[key]);
        if (supplied(payload.butler[key]) && !knownOrderFlowerCell(payload.butler[key])) model.barriers.butler = source.requestSequence;
      }
      for (const id of ORDER_FLOWER_BUTLER_TYPES) {
        for (const key of ORDER_FLOWER_BUTLER_FIELDS) assign(model.butler.types[id], key, payload.butler.types[id][key]);
        if (supplied(payload.butler.types[id].domain) && !knownOrderFlowerCell(payload.butler.types[id].domain)) model.barriers['butler:' + id] = source.requestSequence;
      }
      for (const [group, keys] of Object.entries(ORDER_FLOWER_ELIGIBILITY_FIELDS)) {
        for (const key of keys) assign(model.eligibilityInputs[group], key, payload.eligibilityInputs[group][key]);
        if (keys.some(key => ['domain', 'map'].includes(key) && supplied(payload.eligibilityInputs[group][key]) && !knownOrderFlowerCell(payload.eligibilityInputs[group][key]))) {
          model.barriers['eligibility:' + group] = source.requestSequence;
        }
      }
      assign(model.eligibilityInputs, 'sdkChannel', payload.eligibilityInputs.sdkChannel);
      if (supplied(payload.adCard.map) && !knownOrderFlowerCell(payload.adCard.map) || supplied(payload.adCard.domain) && !knownOrderFlowerCell(payload.adCard.domain)) model.barriers.adCard = source.requestSequence;
      model.context = clone(context); model.lastSource = clone(source);
      const changed = beforeSemantic !== canonical(semantic(model));
      model.revision += changed ? 1 : 0;
      save(model);
      if (revalidation) auditRevalidation(frame, true, null); else audit(frame, true, null);
      return freeze({ accepted: true, audited: true, changed, revision: model.revision, observationRef: frame.observationRef, readOnly: true, writeEligible: false });
    });
  }
  function view(input = {}, limit) {
    const context = orderFlowerContext(input);
    if (!context) throw problem('ORDER_FLOWER_READ_CONTEXT_REQUIRED', '鲜花订单读取需要完整归属和连接代际', 400);
    const row = headRow(context), live = current(context), cacheKey = orderFlowerContextKey(context),
      signature = [row?.model_json, row?.model_fingerprint, live], cached = limit === 4096 ? viewCache.get(cacheKey, signature) : null;
    if (cached) return cached;
    const model = load(context, row ?? null), active = sameOrderFlowerContext(context, model.context) && live && model.identity.verified &&
      model.identity.source?.requestSequence > (model.barriers.identity ?? 0);
    function expose(value, group = null) {
      if (!value || typeof value !== 'object') return value;
      if (Object.hasOwn(value, 'presence') && Object.hasOwn(value, 'state')) {
        const out = clone(value), barrier = Array.isArray(group) ? Math.max(0, ...group.map(key => model.barriers[key] ?? 0)) : model.barriers[group] ?? 0;
        out.current = !!active && value.source?.contextKey === orderFlowerContextKey(context) && value.source.requestSequence > barrier;
        if (knownOrderFlowerCell(out) && !out.current) { out.state = 'stale'; out.reasonCode = 'ORDER_FLOWER_SOURCE_STALE'; }
        if (knownOrderFlowerCell(out) && Array.isArray(out.value)) {
          const total = out.value.length; out.value = out.value.slice(0, limit); out.collection = { total, returned: Math.min(total, limit), limit, complete: total <= limit, truncated: total > limit };
        }
        return out;
      }
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expose(child, group)]));
    }
    const identity = { verified: !!active, uid: expose(model.identity.uid), source: model.identity.source };
    const fields = expose(model.fields, 'order'), domain = expose(model.domain, 'order');
    const uidCurrent = fields.uid.current && knownOrderFlowerCell(fields.uid) && fields.uid.value === identity.uid.value;
    const eligibility = model.eligibilityInputs || emptyEligibility();
    const inputCell = (entry, group) => expose(entry, 'eligibility:' + group);
    const profile = Object.fromEntries(ORDER_FLOWER_ELIGIBILITY_FIELDS.profile.map(key => [key, inputCell(eligibility.profile[key], 'profile')]));
    const sdkChannel = expose(eligibility.sdkChannel), channelKnown = cell => cell.current === true && knownOrderFlowerCell(cell);
    const wireChannel = channelKnown(profile.loginChnId) && profile.loginChnId.value ? profile.loginChnId.value :
      channelKnown(profile.loginChnId) && channelKnown(profile.chnId) ? profile.chnId.value : null;
    const restriction = (entry, target, targetKnown) => {
      const out = clone(entry);
      if (knownOrderFlowerCell(entry)) out.value = { targetKnown, matches: targetKnown ? entry.value.includes(target) : null,
        total: entry.value.length, valuesFingerprint: fingerprint(entry.value) };
      return out;
    };
    const serverOpenMap = { map: inputCell(eligibility.serverOpenMap.map, 'serverOpenMap'),
      semantics: 'listed-server-override-merge-not-global-snapshot', missingKeyDoesNotProveNoOverride: true };
    for (const key of ORDER_FLOWER_ELIGIBILITY_FIELDS.serverOpenMap.filter(key => key !== 'map')) {
      const entry = eligibility.serverOpenMap[key], out = inputCell(entry, 'serverOpenMap');
      if (knownOrderFlowerCell(entry) && knownOrderFlowerCell(entry.value.ext)) for (const name of ['whiteUids', 'blackUids', 'whiteChns', 'blackChns', 'closeChnId']) {
        const uidList = name.endsWith('Uids'), sdkList = name === 'closeChnId', target = uidList ? identity.uid.value : sdkList ? sdkChannel.value : wireChannel;
        out.value.ext.value[name] = restriction(entry.value.ext.value[name], target, uidList ? !!active : sdkList ? channelKnown(sdkChannel) : wireChannel !== null);
      }
      serverOpenMap[key] = out;
    }
    const eligibilityInputs = { ...Object.fromEntries(Object.entries(ORDER_FLOWER_ELIGIBILITY_FIELDS).filter(([group]) => group !== 'serverOpenMap')
      .map(([group, keys]) => [group, Object.fromEntries(keys.map(key => [key, inputCell(eligibility[group][key], group)]))])),
    profile, sdkChannel, serverOpenMap, readOnly: true, writeEligible: false };
    const result = freeze({ source: 'rebuilt-order-flower-readonly', context, current: !!active, revision: model.revision, identity, level: expose(model.level),
      available: !!active && uidCurrent && domain.current && knownOrderFlowerCell(domain), domain, fields,
      counters: expose(model.counters, 'counters'), shares: expose(model.shares, 'shares'), adCard: expose(model.adCard, 'adCard'),
      financial: expose(model.financial || emptyGroup(FINANCIAL_FIELDS)), eligibilityInputs,
      butler: { domain: expose(model.butler.domain, 'butler'), settingMap: expose(model.butler.settingMap, 'butler'),
        types: Object.fromEntries(ORDER_FLOWER_BUTLER_TYPES.map(id => [id, expose(model.butler.types[id], ['butler', 'butler:' + id])])) },
      lastSource: clone(model.lastSource), coverage: 'provided-properties-only-not-a-refresh-promise', preparationOnly: true, readOnly: true, writeEligible: false,
      reasonCode: !active ? 'ORDER_FLOWER_CURRENT_NORMAL_LOGIN_REQUIRED' : !uidCurrent ? 'ORDER_FLOWER_DOMAIN_UID_NOT_CURRENT' : null });
    if (limit === 4096 && row) {
      viewCache.put({ key: cacheKey, scope: cacheScope(context), signature, value: result, sourceBytes: Buffer.byteLength(row.model_json, 'utf8') });
    }
    return result;
  }
  return Object.freeze({ ingest, snapshot: input => view(input, 4096), publicView: input => view(input, 32),
    stop: input => { const context = orderFlowerContext(input); if (context) { stopped.add(orderFlowerContextKey(context)); viewCache.dropScope(cacheScope(context)); } },
    shutdown: () => { closed = true; stopped.clear(); viewCache.dispose(); } });
}
