import { encodeEvidenceJson, canonical, clone, fingerprint, freeze, parseStored, problem } from '../../common.mjs';
import { officialActionContractId } from '../../official-version-profile.mjs';
import { createSnapshotCacheClient } from '../../facts/snapshot-cache.mjs';
import { verifyOfficialServerVersionFrame, SERVER_VERSION_PROTOCOL_CONTRACT } from '../../official-server-version-contract.mjs';
import { CUSTOMER_COLLECTION_LIMIT, CUSTOMER_CONTEXT_FIELDS, CUSTOMER_DECODE_VERSION, customerContext, customerContextKey, decodeOfficialCustomerObservation,
  knownCustomerCell, missingCustomerCell, sameCustomerContext } from './wire-facts.mjs';

const PUBLIC_LIMIT = 32;
const BOARD_FIELDS = Object.freeze(['uid', 'orderMap', 'nextGenTime', 'uTime', 'cTime', 'createCount', 'orderStockList', 'isOrderStockInit']);
const ELIGIBILITY_FIELDS = Object.freeze({ profile: ['domain', 'level', 'vip', 'chnId', 'loginChnId'], mainTask: ['domain', 'uid', 'curTaskId'],
  serverOpenMap: ['map', 'entries', 'sys_orderCustomer', 'sys_waterwheel', 'sys_freeWater', 'butler'], butler: ['settingMap', 'type1', 'type4'],
  count107: ['map', 'domain', 'uid', 'type', 'tdyCnt', 'totCnt', 'rTime', 'uTime', 'cTime'] });
const emptyEligibility = () => ({ ...Object.fromEntries(Object.entries(ELIGIBILITY_FIELDS).map(([group, keys]) =>
  [group, Object.fromEntries(keys.map(key => [key, missingCustomerCell()]))])), sdkChannel: missingCustomerCell() });
const ART_INPUT_FIELDS = Object.freeze({ vases: ['domain', 'map'], flowerArt: ['domain', 'uid', 'exp', 'makeList', 'sRecvList'],
  collectRwd: ['domain', 'map', 'uid', 'exp', 'artCreateRwdList'], shareTot: ['domain', 'map'] });
const emptyArtInputs = () => Object.fromEntries(Object.entries(ART_INPUT_FIELDS).map(([group, keys]) =>
  [group, Object.fromEntries(keys.map(key => [key, missingCustomerCell()]))]));
const normalizeArtInputs = value => {
  const output = emptyArtInputs();
  for (const [group, keys] of Object.entries(ART_INPUT_FIELDS)) for (const key of keys) {
    const cell = value?.[group]?.[key];
    if (cell && typeof cell === 'object' && !Array.isArray(cell)) output[group][key] = cell;
  }
  return output;
};
const valueOf = cell => knownCustomerCell(cell) ? cell.value : null;
const hasCompatibleProof = source => Object.entries(source.version.sourceProofs || {}).some(([action, proof]) =>
  ['customer.generate', 'customer.finish', 'customer.reject'].includes(action) && proof?.supported === true &&
  proof.sourceVersion === source.version.gameVersion && proof.protocolVersion === source.version.protocolVersion &&
  proof.actionContractId === officialActionContractId(action) &&
  /^[a-f0-9]{64}$/.test(proof.gameSha256 || '') && /^[a-f0-9]{64}$/.test(proof.moSha256 || ''));
const newer = (source, previous) => !previous || source.connectionEpoch > previous.connectionEpoch ||
  source.connectionEpoch === previous.connectionEpoch && (source.requestSequence > previous.requestSequence ||
    source.requestSequence === previous.requestSequence && source.responseRef === previous.responseRef && hasCompatibleProof(source));
const empty = context => ({ context, revision: 0, identity: { verified: false, uid: missingCustomerCell(), source: null },
  domain: missingCustomerCell(), customer: missingCustomerCell(), fields: Object.fromEntries(BOARD_FIELDS.map(key => [key, missingCustomerCell()])),
  lastSource: null, versionBinding: null, blocked: null, invalidations: {}, eligibilityInputs: emptyEligibility(), artEligibilityInputs: emptyArtInputs() });
const reportedVersion = source => source.frameReportedServerVersion ?? source.version.reportedServerVersion ??
  (source.frameProtocolVersionPresent ? source.frameProtocolVersion : null);
const semanticVersionBindingValid = (source, context, officialUid) => {
  const reported = reportedVersion(source);
  if (!reported || reported === source.version.protocolVersion) return true;
  return source.version.protocolVersion === SERVER_VERSION_PROTOCOL_CONTRACT &&
    verifyOfficialServerVersionFrame({ versionEvidence: source.version, frameProtocolVersion: source.frameProtocolVersion,
      frameReportedServerVersion: reported, context, officialUid });
};
const versionSupported = (source, context, officialUid) => source.version.source === 'normal-package-hop-and-matched-world-login/v1' &&
  /^\d+(?:\.\d+){1,5}$/.test(source.version.gameVersion || '') && source.version.protocolVersion === SERVER_VERSION_PROTOCOL_CONTRACT &&
  (source.version.gameVersion === '480.0.27' || hasCompatibleProof(source)) &&
  (!source.frameProtocolVersionPresent || source.frameProtocolVersion === source.version.protocolVersion ||
    source.frameReportedServerVersion === source.frameProtocolVersion) &&
  semanticVersionBindingValid(source, context, officialUid);

// Identity reconciliation must use the same verified semantic-version contract
// as the projection that admitted the official customer frame. Keep the
// legacy 480.0.27 path and require an action proof plus a UID/login-bound
// server-version frame for later supported versions.
export function customerIdentitySourceVersionSupported(source, context, officialUid) {
  return !!source && versionSupported(source, context, officialUid);
}

// Resolve the immutable effective customer frame without constructing the
// projection service (which owns schema creation and mutation). A rejected
// legacy base row is usable only when its append-only compatibility receipt
// proves the same raw payload and exact login context under a supported proof.
export function resolveAcceptedCustomerObservationEvidence({ store, context, requestSequence, responseRef, expectedSource = undefined } = {}) {
  if (!store || typeof store.get !== 'function' || !context || !Number.isSafeInteger(requestSequence) || requestSequence <= 0 ||
      typeof responseRef !== 'string' || !responseRef) return null;
  const axes = ['owner_ref', 'account_ref', 'subject_ref', 'owner_epoch', 'run_epoch', 'connection_epoch'];
  const base = store.get(`SELECT * FROM backend_customer_observations WHERE owner_ref=? AND account_ref=? AND subject_ref=?
    AND owner_epoch=? AND run_epoch=? AND connection_epoch=? AND request_sequence=? AND response_ref=? AND source_kind='response' AND method='index.login'`,
  context.ownerRef, context.accountRef, context.subjectRef, context.ownerEpoch, context.runEpoch, context.connectionEpoch, requestSequence, responseRef);
  if (!base || axes.some(key => String(base[key]) !== String(context[{ owner_ref:'ownerRef', account_ref:'accountRef', subject_ref:'subjectRef',
      owner_epoch:'ownerEpoch', run_epoch:'runEpoch', connection_epoch:'connectionEpoch' }[key]]))) return null;
  let raw;
  try { raw = parseStored(base.frame_json, 'customer observation evidence'); } catch { return null; }
  const sourceEnvelopeMatches = frame => ['kind', 'method', 'transport', 'contextKey', 'connectionEpoch', 'requestSequence', 'responseRef', 'wireKey',
    'receivedDeviceMs', 'serverMs', 'serverRespondedMs', 'sentMonotonicMs', 'receivedMonotonicMs'].every(key => frame?.source?.[key] === raw.source?.[key]) &&
    frame?.source?.version?.source === raw.source?.version?.source && frame?.source?.version?.gameVersion === raw.source?.version?.gameVersion &&
    frame?.source?.version?.loginResponseRef === raw.source?.version?.loginResponseRef &&
    (frame?.source?.version?.protocolVersion === raw.source?.version?.protocolVersion &&
      frame?.source?.frameReportedServerVersion === raw.source?.frameReportedServerVersion ||
      frame?.source?.frameReportedServerVersion === reportedVersion(raw.source) &&
      semanticVersionBindingValid(frame.source, context, valueOf(frame?.payload?.profileUid)));
  const matchesRaw = frame => frame?.admissible === true && sameCustomerContext(frame.context, context) && frame.source?.kind === 'response' &&
    frame.source?.method === 'index.login' && frame.source?.requestSequence === requestSequence && frame.source?.responseRef === responseRef &&
    frame.source?.wireKey === base.wire_key && frame.source?.version?.loginResponseRef === responseRef &&
    fingerprint(frame.payload) === base.payload_fingerprint && frame.payloadFingerprint === base.payload_fingerprint &&
    fingerprint(frame.context) === fingerprint(raw.context) && sourceEnvelopeMatches(frame) &&
    fingerprint(frame.payload) === fingerprint(raw.payload);
  if (!matchesRaw(raw)) return null;
  // An explicit source request is used when proving an append-only identity
  // refinement. It must resolve to that exact accepted compatibility frame;
  // never substitute the original base or whichever receipt is newest.
  if (expectedSource !== undefined && (!expectedSource || typeof expectedSource !== 'object')) return null;
  if (base.accepted === 1) {
    if (expectedSource !== undefined) return null;
    return { row: base, frame: raw, accepted: true, compatibility: false, wholeFrameFingerprint: fingerprint(raw) };
  }
  if (base.reason_code !== 'CUSTOMER_SOURCE_VERSION_UNSUPPORTED' || typeof store.all !== 'function') return null;
  let receipts;
  try { receipts = store.all(`SELECT * FROM backend_customer_compatibility_revalidations WHERE observation_ref=? AND payload_fingerprint=?
    AND accepted=1 AND reason_code IS NULL ORDER BY recorded_at DESC,revalidation_ref`, base.observation_ref, base.payload_fingerprint); }
  catch { return null; }
  for (const receipt of receipts || []) {
    let frame;
    try { frame = parseStored(receipt.frame_json, 'customer compatibility evidence'); } catch { continue; }
    if (expectedSource !== undefined) {
      let exactSource = false;
      try { exactSource = !!frame?.source && canonical(frame.source) === canonical(expectedSource); } catch { /* malformed receipt */ }
      if (!exactSource) continue;
    }
    if (!frame?.source?.version?.sourceProofs || receipt.proof_fingerprint !== fingerprint(frame.source.version.sourceProofs) ||
        !hasCompatibleProof(frame.source) || !matchesRaw(frame)) continue;
    return { row: base, frame, accepted: true, compatibility: true, compatibilityRef: receipt.revalidation_ref,
      proofFingerprint: receipt.proof_fingerprint, wholeFrameFingerprint: fingerprint(raw) };
  }
  return null;
}
const semantic = value => {
  if (Array.isArray(value)) return value.map(semantic);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !['source', 'sourceRef'].includes(key)).map(([key, child]) => [key, semantic(child)]));
  return value;
};

// This model observes supplied fields only. It never sends a game request,
// identifies an order lifecycle, accepts an order, or authorizes a write.
export function createCustomerReadModel({ store, isCurrent } = {}) {
  if (!store || !['run', 'get', 'transaction', 'nowIso'].every(key => typeof store[key] === 'function') || typeof isCurrent !== 'function') {
    throw new TypeError('Customer read model requires store and a synchronous current-context guard');
  }
  const { run, get, transaction, nowIso } = store;
  let closed = false;
  run(`CREATE TABLE IF NOT EXISTS backend_customer_observations(
    observation_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,
    request_sequence INTEGER,wire_key TEXT,response_ref TEXT NOT NULL,source_kind TEXT NOT NULL,method TEXT,
    payload_fingerprint TEXT NOT NULL,accepted INTEGER NOT NULL,reason_code TEXT,frame_json TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
  run(`CREATE TABLE IF NOT EXISTS backend_customer_compatibility_revalidations(
    revalidation_ref TEXT PRIMARY KEY,observation_ref TEXT NOT NULL,payload_fingerprint TEXT NOT NULL,proof_fingerprint TEXT NOT NULL,
    accepted INTEGER NOT NULL,reason_code TEXT,frame_json TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
  run('CREATE UNIQUE INDEX IF NOT EXISTS backend_customer_compatibility_revalidation_unique ON backend_customer_compatibility_revalidations(observation_ref,proof_fingerprint)');
  run('CREATE INDEX IF NOT EXISTS backend_customer_observation_scope ON backend_customer_observations(owner_ref,subject_ref,connection_epoch,request_sequence,accepted)');
  run(`CREATE TABLE IF NOT EXISTS backend_customer_heads(owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,account_ref TEXT NOT NULL,
    revision INTEGER NOT NULL,model_json TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref))`);
  run(`CREATE TABLE IF NOT EXISTS backend_customer_bindings(binding_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    previous_account_ref TEXT NOT NULL,current_account_ref TEXT NOT NULL,official_uid INTEGER NOT NULL,
    observation_ref TEXT NOT NULL,evidence_json TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
  run(`CREATE TABLE IF NOT EXISTS backend_customer_revocations(context_key TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,
    subject_ref TEXT NOT NULL,owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,recorded_at TEXT NOT NULL)`);
  for (const table of ['observations', 'bindings', 'revocations']) for (const action of ['UPDATE', 'DELETE']) {
    run(`CREATE TRIGGER IF NOT EXISTS backend_customer_${table}_no_${action.toLowerCase()} BEFORE ${action} ON backend_customer_${table}
      BEGIN SELECT RAISE(ABORT,'customer read evidence is append only'); END`);
  }
  for (const action of ['UPDATE', 'DELETE']) run(`CREATE TRIGGER IF NOT EXISTS backend_customer_compatibility_revalidations_no_${action.toLowerCase()}
    BEFORE ${action} ON backend_customer_compatibility_revalidations BEGIN SELECT RAISE(ABORT,'customer compatibility revalidations are append only'); END`);
  function current(context) {
    if (closed) return false;
    const result = isCurrent(context);
    if (result?.then) throw new TypeError('Customer current-context guard must be synchronous');
    return result === true && !get('SELECT 1 FROM backend_customer_revocations WHERE context_key=?', customerContextKey(context));
  }
  const loadRow = context => get('SELECT account_ref,model_json FROM backend_customer_heads WHERE owner_ref=? AND subject_ref=?', context.ownerRef, context.subjectRef);
  const snapshotCache = createSnapshotCacheClient(store, 'customer');
  const cacheScope = context => canonical([context.ownerRef, context.subjectRef]);
  function save(model) {
    run(`INSERT INTO backend_customer_heads VALUES(?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref) DO UPDATE SET
      account_ref=excluded.account_ref,revision=excluded.revision,model_json=excluded.model_json,updated_at=excluded.updated_at`,
    model.context.ownerRef, model.context.subjectRef, model.context.accountRef, model.revision, canonical(model), nowIso());
  }
  function audit(frame, accepted, reasonCode) {
    const c = frame.context, s = frame.source;
    run('INSERT INTO backend_customer_observations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', frame.observationRef,
      c.ownerRef, c.accountRef, c.subjectRef, c.ownerEpoch, c.runEpoch, c.connectionEpoch, s.requestSequence, s.wireKey,
      s.responseRef, s.kind, s.method, frame.payloadFingerprint, Number(accepted), reasonCode, encodeEvidenceJson(canonical(frame)), nowIso());
  }
  function auditRevalidation(frame, accepted, reasonCode) {
    const proofFingerprint = fingerprint(frame.source.version.sourceProofs);
    run(`INSERT OR IGNORE INTO backend_customer_compatibility_revalidations VALUES(?,?,?,?,?,?,?,?)`,
      'customer-compatibility-revalidation:' + fingerprint([frame.observationRef, proofFingerprint]), frame.observationRef,
      frame.payloadFingerprint, proofFingerprint, Number(accepted), reasonCode, encodeEvidenceJson(canonical(frame)), nowIso());
  }
  function ingest({ context: supplied, observation } = {}) {
    if (closed) return { accepted: false, changed: false, reasonCode: 'CUSTOMER_READ_MODEL_SHUTDOWN' };
    const frame = decodeOfficialCustomerObservation({ context: supplied, observation });
    if (!frame) return { accepted: false, changed: false, reasonCode: 'CUSTOMER_OBSERVATION_CONTEXT_OR_ENVELOPE_MISSING' };
    const context = frame.context, source = frame.source, payload = frame.payload;
    return transaction(() => {
      const duplicate = get('SELECT reason_code,payload_fingerprint,frame_json FROM backend_customer_observations WHERE observation_ref=?', frame.observationRef);
      const originalFrame = duplicate ? parseStored(duplicate.frame_json, 'customer source receipt') : null;
      const revalidation = !!duplicate && duplicate.reason_code === 'CUSTOMER_SOURCE_VERSION_UNSUPPORTED' &&
        duplicate.payload_fingerprint === frame.payloadFingerprint && source.method === 'index.login' &&
        source.responseRef === source.version.loginResponseRef && hasCompatibleProof(source) &&
        fingerprint(originalFrame?.context) === fingerprint(frame.context) && originalFrame?.source?.requestSequence === source.requestSequence &&
        originalFrame?.source?.wireKey === source.wireKey && valueOf(originalFrame?.payload?.profileUid) === valueOf(frame.payload.profileUid) &&
        !get('SELECT 1 FROM backend_customer_compatibility_revalidations WHERE observation_ref=? AND proof_fingerprint=?',
          frame.observationRef, fingerprint(source.version.sourceProofs));
      if (duplicate && !revalidation) return { accepted: false, changed: false, replayed: true, reasonCode: duplicate.reason_code || 'CUSTOMER_OBSERVATION_ALREADY_SEEN', observationRef: frame.observationRef };
      let reasonCode = !current(context) ? 'CUSTOMER_CONTEXT_NOT_CURRENT' : !frame.admissible ? frame.reasonCode : null;
      const row = loadRow(context), model = row ? parseStored(row.model_json, 'customer read model') : empty(context);
      model.invalidations ||= {};
      model.eligibilityInputs ||= emptyEligibility();
      for (const [group, keys] of Object.entries(ELIGIBILITY_FIELDS)) model.eligibilityInputs[group] ||= Object.fromEntries(keys.map(key => [key, missingCustomerCell()]));
      // Persisted customer projections created before this independent input
      // existed may not contain it. Preserve that absence as unknown until a
      // source supplies the cell; do not infer that waterwheel is closed.
      model.eligibilityInputs.serverOpenMap.sys_waterwheel ||= missingCustomerCell();
      model.eligibilityInputs.serverOpenMap.sys_freeWater ||= missingCustomerCell();
      model.eligibilityInputs.serverOpenMap.entries ||= missingCustomerCell();
      const sameContext = sameCustomerContext(model.context, context), isLogin = source.method === 'index.login';
      const incomingUid = valueOf(payload.profileUid), previousUid = valueOf(model.identity.uid);
      const matchingIdentity = sameContext && model.identity.verified;
      const rebind = row && row.account_ref !== context.accountRef;
      const priorRequest = source.kind === 'response' && source.requestSequence !== null ? get(`SELECT payload_fingerprint FROM backend_customer_observations
        WHERE owner_ref=? AND subject_ref=? AND owner_epoch=? AND run_epoch=? AND connection_epoch=? AND request_sequence=? AND accepted=1 LIMIT 1`,
      context.ownerRef, context.subjectRef, context.ownerEpoch, context.runEpoch, context.connectionEpoch, source.requestSequence) : null;
      if (!reasonCode && priorRequest) reasonCode = priorRequest.payload_fingerprint === frame.payloadFingerprint ? 'CUSTOMER_REQUEST_ALREADY_SEEN' : 'CUSTOMER_REQUEST_CONTENT_CONFLICT';
      const sourceUid = valueOf(payload.profileUid) ?? valueOf(model.identity.uid);
      if (!reasonCode && !versionSupported(source, context, sourceUid)) reasonCode = 'CUSTOMER_SOURCE_VERSION_UNSUPPORTED';
      if (!reasonCode && isLogin && source.version.loginResponseRef !== source.responseRef) reasonCode = 'CUSTOMER_LOGIN_VERSION_BINDING_MISSING';
      if (!reasonCode && !isLogin && (!matchingIdentity || !model.versionBinding || source.version.loginResponseRef !== model.versionBinding.loginResponseRef)) reasonCode = 'CUSTOMER_CURRENT_LOGIN_UNVERIFIED';
      if (!reasonCode && payload.profileUid.presence !== 'missing' && !knownCustomerCell(payload.profileUid)) reasonCode = 'CUSTOMER_PROFILE_UID_UNREADABLE';
      if (!reasonCode && previousUid !== null && incomingUid !== null && previousUid !== incomingUid) reasonCode = 'CUSTOMER_PROFILE_UID_CONFLICT';
      if (!reasonCode && isLogin && incomingUid === null) reasonCode = 'CUSTOMER_LOGIN_UID_MISSING';
      if (!reasonCode && !sameContext && !isLogin) reasonCode = 'CUSTOMER_NEW_CONTEXT_REQUIRES_LOGIN';
      if (!reasonCode && rebind && !(isLogin && previousUid !== null && incomingUid === previousUid && newer(source, model.identity.source))) reasonCode = 'CUSTOMER_ACCOUNT_REBIND_REQUIRES_SAME_VERIFIED_UID';
      if (!reasonCode && model.blocked && sameContext && model.blocked.requiresNewLogin &&
          !(revalidation && model.blocked.source?.responseRef === source.responseRef)) reasonCode = model.blocked.reasonCode;
      const boundUid = isLogin ? incomingUid : previousUid;
      if (!reasonCode && payload.uid.presence !== 'missing' && (!knownCustomerCell(payload.uid) || valueOf(payload.uid) !== boundUid)) reasonCode = 'CUSTOMER_DOMAIN_UID_CONFLICT_OR_UNREADABLE';
      if (reasonCode) {
        if (revalidation) auditRevalidation(frame, false, reasonCode); else audit(frame, false, reasonCode);
        // An old/late/replayed packet may be audited but cannot invalidate a
        // newer current head. A genuine current contradictory response can.
        let changed = false;
        const guardSource = reasonCode === 'CUSTOMER_DOMAIN_UID_CONFLICT_OR_UNREADABLE' ? model.fields.uid.source : model.identity.source;
        if (sameContext && frame.admissible && current(context) && !priorRequest && newer(source, guardSource) &&
          ['CUSTOMER_SOURCE_VERSION_UNSUPPORTED', 'CUSTOMER_PROFILE_UID_UNREADABLE', 'CUSTOMER_PROFILE_UID_CONFLICT', 'CUSTOMER_DOMAIN_UID_CONFLICT_OR_UNREADABLE'].includes(reasonCode)) {
          model.blocked = { reasonCode, requiresNewLogin: reasonCode !== 'CUSTOMER_DOMAIN_UID_CONFLICT_OR_UNREADABLE', source: clone(source) };
          if (reasonCode === 'CUSTOMER_DOMAIN_UID_CONFLICT_OR_UNREADABLE') model.invalidations.domain = clone(source);
          if (newer(source, model.lastSource)) model.lastSource = clone(source);
          model.revision += 1; save(model);
          changed = true;
        }
        return freeze({ accepted: false, changed, reasonCode, observationRef: frame.observationRef, audited: true, revision: model.revision });
      }
      if (rebind) run('INSERT INTO backend_customer_bindings VALUES(?,?,?,?,?,?,?,?,?)', 'customer-binding:' + fingerprint([context, frame.observationRef]),
        context.ownerRef, context.subjectRef, row.account_ref, context.accountRef, incomingUid, frame.observationRef,
        canonical({ previousContext: model.context, currentContext: context, source, reasonCode: 'NORMAL_LOGIN_SAME_OWNER_STABLE_SUBJECT', originalObservationsRetained: true }), nowIso());
      const before = fingerprint(semantic({ identity: model.identity, domain: model.domain, customer: model.customer, fields: model.fields,
        blocked: model.blocked, eligibilityInputs: model.eligibilityInputs, artEligibilityInputs: model.artEligibilityInputs || emptyArtInputs() }));
      if (isLogin) {
        model.identity = { verified: true, uid: { ...clone(payload.profileUid), source: clone(source) }, source: clone(source) };
        model.versionBinding = clone(source.version);
        if (!sameContext) model.blocked = null;
      }
      const put = (object, key, entry) => {
        if (entry.presence === 'missing' || !newer(source, object[key]?.source)) return false;
        object[key] = { ...clone(entry), source: clone(source) };
        return true;
      };
      if (put(model, 'domain', payload.domain) && payload.domain.state !== 'known') model.invalidations.domain = clone(source);
      if (put(model, 'customer', payload.customer) && payload.customer.state !== 'known') model.invalidations.customer = clone(source);
      if (knownCustomerCell(payload.domain) && knownCustomerCell(payload.customer)) {
        if (model.blocked && !model.blocked.requiresNewLogin && knownCustomerCell(payload.uid) && valueOf(payload.uid) === boundUid && newer(source, model.blocked.source)) model.blocked = null;
        // Whole orderMap/stockList properties replace; their row fields are
        // never merged with a previous order at the same npcId.
        for (const key of BOARD_FIELDS) put(model.fields, key, payload[key]);
      }
      for (const [group, keys] of Object.entries(ELIGIBILITY_FIELDS)) for (const key of keys) {
        const entry = payload.eligibilityInputs[group][key];
        if (put(model.eligibilityInputs[group], key, entry) && ['domain', 'map', 'settingMap'].includes(key) && entry.state !== 'known') {
          model.invalidations['eligibility:' + group] = clone(source);
        }
      }
      put(model.eligibilityInputs, 'sdkChannel', payload.eligibilityInputs.sdkChannel);
      model.artEligibilityInputs = normalizeArtInputs(model.artEligibilityInputs);
      for (const [group, keys] of Object.entries(ART_INPUT_FIELDS)) for (const key of keys) {
        const entry = payload.artEligibilityInputs[group][key];
        if (put(model.artEligibilityInputs[group], key, entry) && key === 'domain' && entry.state !== 'known') {
          model.invalidations['art:' + group] = clone(source);
        }
      }
      if (newer(source, model.lastSource)) model.lastSource = clone(source);
      model.context = clone(context);
      const changed = before !== fingerprint(semantic({ identity: model.identity, domain: model.domain, customer: model.customer, fields: model.fields,
        blocked: model.blocked, eligibilityInputs: model.eligibilityInputs, artEligibilityInputs: model.artEligibilityInputs }));
      if (changed || !sameContext) model.revision += 1;
      if (revalidation) auditRevalidation(frame, true, null); else audit(frame, true, null);
      save(model);
      return freeze({ accepted: true, changed: changed || !sameContext, audited: true, reasonCode: null, observationRef: frame.observationRef,
        revision: model.revision, domainPresence: payload.domain.presence, orderMapPresence: payload.orderMap.presence,
        sourceProvidedMapComplete: payload.orderMap.sourceProvidedMapComplete === true, readOnly: true, writeEligible: false });
    });
  }
  function view(input = {}, limit = PUBLIC_LIMIT) {
    if (typeof input.ownerRef !== 'string' || typeof input.subjectRef !== 'string' || input.accountRef == null) throw problem('CUSTOMER_READ_SCOPE_INVALID', '顾客只读资料缺少归属范围', 400);
    const scope = { ownerRef: input.ownerRef, subjectRef: input.subjectRef, accountRef: String(input.accountRef) }, row = loadRow(scope);
    const hasEpoch = CUSTOMER_CONTEXT_FIELDS.slice(3).some(key => input[key] !== undefined && input[key] !== null), requested = hasEpoch ? customerContext(input) : null;
    if (hasEpoch && !requested) throw problem('CUSTOMER_READ_CONTEXT_INVALID', '顾客只读连接代际不完整', 400);
    const live = requested ? current(requested) : null, cacheKey = requested ? customerContextKey(requested) : null,
      signature = [row?.account_ref, row?.model_json, live], cached = requested && limit === CUSTOMER_COLLECTION_LIMIT ? snapshotCache.get(cacheKey, signature) : null;
    if (cached) return cached;
    const model = row && row.account_ref === scope.accountRef ? parseStored(row.model_json, 'customer read model') : empty(requested || scope);
    const context = customerContext(model.context), same = !!context && (!requested || sameCustomerContext(context, requested));
    const active = same && (requested ? live : current(context)), identityCurrent = active && model.identity.verified && model.identity.source?.contextKey === customerContextKey(context);
    const currentCell = one => !!identityCurrent && one?.source?.contextKey === customerContextKey(context);
    const barrier = Math.max(...['domain', 'customer'].map(key => model.invalidations?.[key]).filter(source => source && source.contextKey === (context && customerContextKey(context)))
      .map(source => source.requestSequence), 0);
    const domainCellCurrent = one => currentCell(one) && one.source.requestSequence > barrier;
    const expose = one => {
      const cell = one ?? missingCustomerCell();
      const copy = clone(cell); copy.current = currentCell(cell);
      if (copy.state === 'known' && !copy.current) { copy.state = 'stale'; copy.reasonCode = 'CUSTOMER_SOURCE_CONTEXT_STALE'; }
      return copy;
    };
    const uid = model.fields.uid, domainCurrent = identityCurrent && currentCell(model.domain) && knownCustomerCell(model.domain) &&
      domainCellCurrent(model.customer) && knownCustomerCell(model.customer) && domainCellCurrent(uid) && knownCustomerCell(uid) && valueOf(uid) === valueOf(model.identity.uid) && !model.blocked;
    const map = model.fields.orderMap, list = model.fields.orderStockList;
    const collection = (one, isMap) => {
      const rows = one.entries || [], total = one.total ?? null, returned = Math.min(rows.length, limit), truncated = total !== null && total > returned;
      const supplied = isMap ? one.sourceProvidedMapComplete === true : one.sourceProvidedListComplete === true;
      return { presence: one.presence, state: one.state === 'known' && (!domainCurrent || !domainCellCurrent(one)) ? 'stale' : one.state,
        current: !!domainCurrent && domainCellCurrent(one), source: one.source || null, reasonCode: one.reasonCode || null,
        coverageKind: isMap ? 'provided-order-map-property-only' : 'provided-order-stock-list-only',
        sourceProvidedCollectionComplete: supplied, decodedComplete: one.decodedComplete === true,
        complete: supplied && one.decodedComplete === true && !truncated, returnedComplete: supplied && !truncated,
        total, returned, limit, truncated, reportedEmpty: one.reportedEmpty === true,
        entries: rows.slice(0, limit).map(row => ({ ...clone(row), current: !!domainCurrent && domainCellCurrent(one), source: one.source || null })) };
    };
    const orderMap = collection(map, true), orderStockList = collection(list, false);
    const eligibility = model.eligibilityInputs || emptyEligibility();
    eligibility.count107 ||= emptyEligibility().count107;
    const inputCell = (entry, group) => {
      const cell = entry ?? missingCustomerCell();
      const out = expose(cell), blockedAt = model.invalidations?.['eligibility:' + group];
      if (blockedAt?.contextKey === (context && customerContextKey(context)) && cell.source?.requestSequence <= blockedAt.requestSequence) {
        out.current = false;
        if (out.state === 'known') { out.state = 'stale'; out.reasonCode = 'CUSTOMER_ELIGIBILITY_PARENT_UNREADABLE'; }
      }
      return out;
    };
    const profile = Object.fromEntries(ELIGIBILITY_FIELDS.profile.map(key => [key, inputCell(eligibility.profile[key], 'profile')]));
    const sdkChannel = expose(eligibility.sdkChannel), channelKnown = one => one.current && knownCustomerCell(one);
    const loginChannelKnown = channelKnown(profile.loginChnId), wireChannel = loginChannelKnown && profile.loginChnId.value ? profile.loginChnId.value :
      loginChannelKnown && channelKnown(profile.chnId) ? profile.chnId.value : null;
    const restriction = (entry, target, targetKnown) => {
      const out = clone(entry);
      if (knownCustomerCell(entry)) out.value = { targetKnown, matches: targetKnown ? entry.value.includes(target) : null,
        total: entry.value.length, valuesFingerprint: fingerprint(entry.value) };
      return out;
    };
    const openView = entry => {
      const out = inputCell(entry, 'serverOpenMap');
      if (knownCustomerCell(entry) && knownCustomerCell(entry.value.ext)) {
        for (const key of ['whiteUids', 'blackUids', 'whiteChns', 'blackChns', 'closeChnId']) {
          const target = key.endsWith('Uids') ? valueOf(model.identity.uid) : key === 'closeChnId' ? sdkChannel.value : wireChannel;
          const targetKnown = key.endsWith('Uids') ? !!identityCurrent : key === 'closeChnId' ? channelKnown(sdkChannel) : wireChannel !== null;
          out.value.ext.value[key] = restriction(entry.value.ext.value[key], target, targetKnown);
        }
      }
      return out;
    };
    const settingView = (entry, expectedType) => {
      const out = inputCell(entry, 'butler');
      out.uidMatchesCurrentLogin = knownCustomerCell(entry) && knownCustomerCell(entry.value.uid) && identityCurrent ? entry.value.uid.value === valueOf(model.identity.uid) : null;
      out.typeMatchesKey = knownCustomerCell(entry) && knownCustomerCell(entry.value.type) ? entry.value.type.value === expectedType : null;
      if (knownCustomerCell(entry) && knownCustomerCell(entry.value.buyPeriodMap)) {
        const keys = Object.keys(entry.value.buyPeriodMap.value).sort((a, b) => Number(a) - Number(b));
        out.value.buyPeriodMap.value = { entries: Object.fromEntries(keys.slice(0, limit).map(key => [key, entry.value.buyPeriodMap.value[key]])),
          total: keys.length, returned: Math.min(keys.length, limit), limit, truncated: keys.length > limit, complete: keys.length <= limit };
      }
      return out;
    };
    const eligibilityInputs = { evaluated: false, open: null, automaticExecutionAbsent: null,
      reasonCode: 'CUSTOMER_ELIGIBILITY_FACTS_ONLY_NOT_A_WRITE_PERMISSION', profile, sdkChannel,
      mainTask: Object.fromEntries(ELIGIBILITY_FIELDS.mainTask.map(key => [key, inputCell(eligibility.mainTask[key], 'mainTask')])),
      count107: Object.fromEntries(ELIGIBILITY_FIELDS.count107.map(key => [key, inputCell(eligibility.count107[key], 'count107')])),
      serverOpenMap: { map: inputCell(eligibility.serverOpenMap.map, 'serverOpenMap'), entries: inputCell(eligibility.serverOpenMap.entries, 'serverOpenMap'),
        semantics: 'listed-server-override-merge-not-global-snapshot',
        missingKeyDoesNotProveNoOverride: true, sys_orderCustomer: openView(eligibility.serverOpenMap.sys_orderCustomer),
        sys_waterwheel: openView(eligibility.serverOpenMap.sys_waterwheel), sys_freeWater: openView(eligibility.serverOpenMap.sys_freeWater),
        butler: openView(eligibility.serverOpenMap.butler) },
      butler: { settingMap: inputCell(eligibility.butler.settingMap, 'butler'), type1: settingView(eligibility.butler.type1, 1), type4: settingView(eligibility.butler.type4, 4),
        semantics: 'supplied-setting-facts-not-a-no-concurrency-proof', hired: null } };
    const art = normalizeArtInputs(model.artEligibilityInputs);
    const artCell = (entry, group) => {
      const out = expose(entry), blockedAt = model.invalidations?.['art:' + group];
      if (blockedAt?.contextKey === (context && customerContextKey(context)) && entry.source?.requestSequence <= blockedAt.requestSequence) {
        out.current = false;
        if (out.state === 'known') { out.state = 'stale'; out.reasonCode = 'ART_ELIGIBILITY_PARENT_UNREADABLE'; }
      }
      return out;
    };
    const vaseDomain = artCell(art.vases.domain, 'vases'), vaseMap = artCell(art.vases.map, 'vases');
    const vaseCurrent = vaseDomain.current && knownCustomerCell(vaseDomain) && vaseMap.current && knownCustomerCell(vaseMap);
    const vaseRows = vaseMap.entries || [], vaseTotal = vaseMap.total ?? null, vaseReturned = Math.min(vaseRows.length, limit);
    const vaseTruncated = vaseTotal !== null && vaseTotal > vaseReturned;
    delete vaseMap.entries;
    vaseMap.current = Boolean(vaseCurrent);
    vaseMap.entries = vaseRows.slice(0, limit).map(row => {
      const uidMatchesCurrentLogin = knownCustomerCell(row.fields.uid) && identityCurrent ? row.fields.uid.value === valueOf(model.identity.uid) : null;
      const vaseIdMatchesKey = knownCustomerCell(row.fields.vaseId) ? row.fields.vaseId.value === row.vaseId : null;
      return { ...clone(row), source: vaseMap.source || null, current: Boolean(vaseCurrent && uidMatchesCurrentLogin === true && vaseIdMatchesKey === true), uidMatchesCurrentLogin, vaseIdMatchesKey };
    });
    Object.assign(vaseMap, { coverageKind: 'provided-vase-map-property-only', total: vaseTotal, returned: vaseReturned, limit, truncated: vaseTruncated,
      complete: vaseMap.sourceProvidedMapComplete === true && vaseMap.decodedComplete === true && !vaseTruncated,
      returnedComplete: vaseMap.sourceProvidedMapComplete === true && !vaseTruncated });
    const artDomain = artCell(art.flowerArt.domain, 'flowerArt'), artUid = artCell(art.flowerArt.uid, 'flowerArt');
    const artUidMatches = artUid.current && knownCustomerCell(artUid) && identityCurrent ? artUid.value === valueOf(model.identity.uid) : null;
    const makeList = artCell(art.flowerArt.makeList, 'flowerArt'), exp = artCell(art.flowerArt.exp, 'flowerArt'),
      sRecvList = artCell(art.flowerArt.sRecvList, 'flowerArt');
    makeList.current = Boolean(makeList.current && artDomain.current && knownCustomerCell(artDomain) && artUidMatches === true);
    exp.current = Boolean(exp.current && artDomain.current && knownCustomerCell(artDomain) && artUidMatches === true);
    sRecvList.current = Boolean(sRecvList.current && artDomain.current && knownCustomerCell(artDomain) && artUidMatches === true);
    if (knownCustomerCell(makeList)) {
      const entries = makeList.value;
      makeList.value = { entries: entries.slice(0, limit), total: entries.length, returned: Math.min(entries.length, limit),
        limit, truncated: entries.length > limit, complete: entries.length <= limit, meaning: 'first-make-history-not-product-quantity' };
    }
    const collectRwd = Object.fromEntries(Object.entries(art.collectRwd).map(([key, value]) => [key, artCell(value, 'collectRwd')]));
    const collectMap = collectRwd.map;
    const collectUidMatches = collectRwd.uid.current && knownCustomerCell(collectRwd.uid) && identityCurrent
      ? collectRwd.uid.value === valueOf(model.identity.uid) : null;
    const rewardMapCurrent = collectRwd.domain.current && knownCustomerCell(collectRwd.domain) &&
      collectMap.current && knownCustomerCell(collectMap) && collectMap.sourceProvidedMapComplete === true && collectMap.decodedComplete === true;
    collectRwd.map.current = Boolean(rewardMapCurrent);
    const type13Present = rewardMapCurrent && collectMap.value?.keys?.includes(13) === true;
    const type13UidMatches = type13Present && collectRwd.uid.current && knownCustomerCell(collectRwd.uid) && identityCurrent
      ? collectRwd.uid.value === valueOf(model.identity.uid) : null;
    collectRwd.exp.current = Boolean(collectRwd.exp.current && rewardMapCurrent && type13Present && type13UidMatches === true);
    const emptyArtExperienceDefault = rewardMapCurrent && !type13Present;
    collectRwd.expDefault = { presence: 'derived', state: emptyArtExperienceDefault ? 'known' : 'missing',
      current: Boolean(emptyArtExperienceDefault), value: 0, source: emptyArtExperienceDefault ? collectMap.source || null : null,
      rule: 'official-current-complete-103-map-without-type13-getMb(13)?.exp||0' };
    collectRwd.artCreateRwdList.current = Boolean(collectRwd.artCreateRwdList.current && rewardMapCurrent &&
      type13Present && type13UidMatches === true);
    collectRwd.uidMatchesCurrentLogin = collectUidMatches;
    collectRwd.type13Present = type13Present;
    const emptyArtClaimListDefault = rewardMapCurrent &&
      (!type13Present || type13UidMatches === true && collectRwd.artCreateRwdList.presence === 'missing');
    collectRwd.artCreateRwdListDefault = { presence: 'derived', state: emptyArtClaimListDefault ? 'known' : 'missing',
      current: Boolean(emptyArtClaimListDefault), value: [], source: emptyArtClaimListDefault
        ? { map: collectMap.source || null, type13: type13Present ? collectRwd.uid.source || null : null } : null,
      rule: 'official-current-complete-103-map-and-matching-login-uid-getMb(13)?.artCreateRwdList||[]' };
    if (knownCustomerCell(collectRwd.artCreateRwdList)) {
      const entries = collectRwd.artCreateRwdList.value;
      collectRwd.artCreateRwdList.value = { entries: entries.slice(0, limit), total: entries.length, returned: Math.min(entries.length, limit),
        limit, truncated: entries.length > limit, complete: entries.length <= limit };
    }
    const shareTotDomain = artCell(art.shareTot.domain, 'shareTot'), shareTotMap = artCell(art.shareTot.map, 'shareTot');
    if (shareTotMap.entries && typeof shareTotMap.entries === 'object') for (const [shareId, member] of Object.entries(shareTotMap.entries)) {
      shareTotMap.entries[shareId] = { ...member, current: Boolean(shareTotDomain.current && knownCustomerCell(shareTotDomain) &&
        shareTotMap.current && knownCustomerCell(shareTotMap) && identityCurrent && member.state === 'known'),
        source: shareTotMap.source || null };
    }
    const artEligibilityInputs = { readOnly: true, writeEligible: false, vases: { domain: vaseDomain, map: vaseMap },
      flowerArt: { domain: artDomain, uid: artUid, uidMatchesCurrentLogin: artUidMatches, exp, makeList, sRecvList,
        sRecvListDefault: { presence: 'derived', state: artDomain.current && knownCustomerCell(artDomain) && artUidMatches === true &&
          makeList.current && knownCustomerCell(makeList) && makeList.value?.complete === true && sRecvList.presence === 'missing' ? 'known' : 'missing',
          current: Boolean(artDomain.current && knownCustomerCell(artDomain) && artUidMatches === true && makeList.current &&
            knownCustomerCell(makeList) && makeList.value?.complete === true && sRecvList.presence === 'missing'),
          value: [], source: sRecvList.presence === 'missing' ? (makeList.source || artDomain.source || null) : null,
          rule: 'official-current-complete-106-member-and-missing-sRecvList-means-empty-list' } }, collectRwd,
      shareTot: { domain: shareTotDomain, map: shareTotMap } };
    const reasonCode = !row || row.account_ref !== scope.accountRef ? 'CUSTOMER_NOT_OBSERVED' : !identityCurrent ? 'CUSTOMER_CURRENT_LOGIN_UNVERIFIED'
      : model.blocked?.reasonCode || (!domainCurrent ? 'CUSTOMER_DOMAIN_NOT_CURRENT_OR_UID_UNVERIFIED' : !orderMap.current || orderMap.state !== 'known' ? 'CUSTOMER_ORDER_MAP_NOT_CURRENT' : null);
    const result = freeze({ readOnly: true, writeEligible: false, lifecycleImplemented: false, decodeVersion: CUSTOMER_DECODE_VERSION,
      ownerRef: scope.ownerRef, accountRef: scope.accountRef, subjectRef: scope.subjectRef, context, revision: model.revision,
      current: !!domainCurrent, available: !!domainCurrent && orderMap.current && orderMap.state === 'known', reasonCode,
      identity: { verified: !!identityCurrent, uid: expose(model.identity.uid), source: model.identity.source },
      domain: expose(model.domain), customer: expose(model.customer), uid: expose(uid), orderMap, orders: orderMap.entries,
      orderStockList, nextGenTime: expose(model.fields.nextGenTime), uTime: expose(model.fields.uTime), cTime: expose(model.fields.cTime),
      createCount: expose(model.fields.createCount), isOrderStockInit: expose(model.fields.isOrderStockInit),
      lastObservation: model.lastSource, versionBinding: model.versionBinding, block: model.blocked, eligibilityInputs, artEligibilityInputs,
      refresh: { registered: false, guaranteed109: false, reasonCode: 'CUSTOMER_REFRESH_CONTRACT_UNPROVEN' } });
    if (requested && limit === CUSTOMER_COLLECTION_LIMIT && row?.account_ref === scope.accountRef)
      snapshotCache.put({ key: cacheKey, scope: cacheScope(requested), signature, value: result, sourceBytes: Buffer.byteLength(row.model_json, 'utf8') });
    return result;
  }
  function summary(input = {}) {
    if (typeof input.ownerRef !== 'string' || typeof input.subjectRef !== 'string' || input.accountRef == null)
      throw problem('CUSTOMER_READ_SCOPE_INVALID', '顾客只读资料缺少归属范围', 400);
    const scope = { ownerRef: input.ownerRef, subjectRef: input.subjectRef, accountRef: String(input.accountRef) }, row = loadRow(scope);
    const hasEpoch = CUSTOMER_CONTEXT_FIELDS.slice(3).some(key => input[key] !== undefined && input[key] !== null), requested = hasEpoch ? customerContext(input) : null;
    if (hasEpoch && !requested) throw problem('CUSTOMER_READ_CONTEXT_INVALID', '顾客只读连接代际不完整', 400);
    const model = row && row.account_ref === scope.accountRef ? parseStored(row.model_json, 'customer read model') : empty(requested || scope);
    const context = customerContext(model.context), same = !!context && (!requested || sameCustomerContext(context, requested));
    const active = same && current(context), identityCurrent = active && model.identity.verified &&
      model.identity.source?.contextKey === customerContextKey(context);
    const currentCell = one => !!identityCurrent && one?.source?.contextKey === customerContextKey(context);
    const barrier = Math.max(...['domain', 'customer'].map(key => model.invalidations?.[key])
      .filter(source => source && source.contextKey === (context && customerContextKey(context)))
      .map(source => source.requestSequence), 0);
    const domainCellCurrent = one => currentCell(one) && one.source.requestSequence > barrier;
    const uid = model.fields.uid, orderMap = model.fields.orderMap;
    const domainCurrent = !!(identityCurrent && currentCell(model.domain) && knownCustomerCell(model.domain) &&
      domainCellCurrent(model.customer) && knownCustomerCell(model.customer) && domainCellCurrent(uid) &&
      knownCustomerCell(uid) && valueOf(uid) === valueOf(model.identity.uid) && !model.blocked);
    const orderCurrent = !!(domainCurrent && domainCellCurrent(orderMap) && orderMap.state === 'known');
    const reasonCode = !row || row.account_ref !== scope.accountRef ? 'CUSTOMER_NOT_OBSERVED' : !identityCurrent ? 'CUSTOMER_CURRENT_LOGIN_UNVERIFIED'
      : model.blocked?.reasonCode || (!domainCurrent ? 'CUSTOMER_DOMAIN_NOT_CURRENT_OR_UID_UNVERIFIED'
        : !orderCurrent ? 'CUSTOMER_ORDER_MAP_NOT_CURRENT' : null);
    return Object.freeze({ readOnly: true, writeEligible: false, ownerRef: scope.ownerRef, accountRef: scope.accountRef,
      subjectRef: scope.subjectRef, context, revision: model.revision, current: domainCurrent, available: orderCurrent,
      reasonCode, identity: { verified: !!identityCurrent }, summaryOnly: true });
  }
  function stop(supplied) {
    const context = customerContext(supplied);
    if (!context) return { invalidated: false, reasonCode: 'CUSTOMER_STOP_CONTEXT_UNAVAILABLE' };
    const result = run('INSERT OR IGNORE INTO backend_customer_revocations VALUES(?,?,?,?,?,?,?,?)', customerContextKey(context),
      context.ownerRef, context.accountRef, context.subjectRef, context.ownerEpoch, context.runEpoch, context.connectionEpoch, nowIso());
    snapshotCache.dropScope(cacheScope(context));
    return freeze({ invalidated: true, recorded: Number(result.changes) === 1, context });
  }
  return Object.freeze({ ingest, publicView: input => view(input, PUBLIC_LIMIT), summary, snapshot: input => view(input, CUSTOMER_COLLECTION_LIMIT),
    stop, shutdown: () => { closed = true; snapshotCache.dispose(); return { shutdown: true }; } });
}
