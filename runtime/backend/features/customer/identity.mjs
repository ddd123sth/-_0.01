import { canonical, clone, fingerprint, freeze, parseStored, problem } from '../../common.mjs';
import { createDurableSequences } from '../../persistence/sequences.mjs';
import { customerIdentitySourceVersionSupported, resolveAcceptedCustomerObservationEvidence } from './projection.mjs';
import { customerContext, customerContextKey, sameCustomerContext, knownCustomerCell } from './wire-facts.mjs';

const FIELDS = Object.freeze(['dialogId', 'artId', 'num', 'pathId', 'cTime']);
const MAX_ROWS = 128;
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const value = cell => knownCustomerCell(cell) ? cell.value : null;
const text = entry => typeof entry === 'string' && entry.length > 0 && entry.length <= 512;
const synchronous = result => {
  if (result?.then) throw new TypeError('Customer identity dependencies must be synchronous');
  return result;
};
const SOURCE_PROOF_ACTIONS = Object.freeze(['art.make', 'customer.finish', 'customer.generate', 'customer.reject', 'land.harvest',
  'land.plant', 'land.water', 'order.butler-stock', 'order.decorate', 'order.resident', 'order.satin', 'session.official-day']);
const REFINABLE_VERSION_PATHS = Object.freeze([
  ['sourceIndexSha256'],
  ...SOURCE_PROOF_ACTIONS.map(action => ['sourceProofs', action, 'indexSha256']),
  ['serverVersionBinding', 'bindingRef'], ['serverVersionBinding', 'bundleRef'],
  ['serverVersionBinding', 'proofRef'], ['serverVersionBinding', 'proof', 'bundleRef'],
  ['serverVersionBinding', 'proof', 'proofRef']
]);

function rowsForFingerprint(rows) {
  return rows.map(one => ({ npcId: one.npcId, content: customerOrderContent(one),
    readable: one.readable === true, current: one.current === true })).sort((a, b) => a.npcId - b.npcId);
}
function replaceAtPath(root, path, value) {
  let current = root;
  for (const part of path.slice(0, -1)) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) return false;
    current = current[part];
  }
  const last = path.at(-1);
  if (!current || typeof current !== 'object' || !Object.hasOwn(current, last)) return false;
  current[last] = value;
  return true;
}
function validSourceProofIndexes(source) {
  const version = source?.version;
  if (!/^[a-f0-9]{64}$/.test(version?.sourceIndexSha256 || '') || !version?.sourceProofs ||
      typeof version.sourceProofs !== 'object' || Array.isArray(version.sourceProofs)) return false;
  return SOURCE_PROOF_ACTIONS.every(action => {
    const proof = version.sourceProofs[action];
    return proof && /^[a-f0-9]{64}$/.test(proof.indexSha256 || '') && proof.indexSha256 === version.sourceIndexSha256;
  });
}
function refinementSourcePairValid(oldSource, nextSource) {
  if (!oldSource || !nextSource || !oldSource.version || !nextSource.version ||
      canonical({ ...oldSource, version: null }) !== canonical({ ...nextSource, version: null }) ||
      !validSourceProofIndexes(oldSource) || !validSourceProofIndexes(nextSource)) return false;
  const oldVersion = clone(oldSource.version), nextVersion = clone(nextSource.version);
  for (const path of REFINABLE_VERSION_PATHS) {
    const marker = '__identity_source_refinement__';
    if (!replaceAtPath(oldVersion, path, marker) || !replaceAtPath(nextVersion, path, marker)) return false;
  }
  if (canonical(oldVersion) !== canonical(nextVersion)) return false;
  const refs = [nextSource.version.serverVersionBinding?.bindingRef, nextSource.version.serverVersionBinding?.bundleRef,
    nextSource.version.serverVersionBinding?.proofRef, nextSource.version.serverVersionBinding?.proof?.bundleRef,
    nextSource.version.serverVersionBinding?.proof?.proofRef];
  return refs.every(one => text(one));
}

// Content is deliberately separate from a locally observed occurrence. In
// particular, cTime is a Date value, not a proven unique official order id.
export function customerOrderContent(order) {
  if (!positive(order?.npcId)) return null;
  const fields = {};
  for (const name of FIELDS) {
    const one = order.fields?.[name];
    const valid = knownCustomerCell(one) && (['artId', 'num', 'cTime'].includes(name) ? positive(one.value) : nonnegative(one.value));
    fields[name] = { presence: ['missing', 'null', 'present'].includes(one?.presence) ? one.presence : 'missing',
      state: valid ? 'known' : one?.state === 'stale' ? 'stale' : 'unreadable', value: valid ? one.value : null };
  }
  return { npcId: order.npcId, fields };
}
export const customerOrderFingerprint = order => {
  const content = customerOrderContent(order);
  return content ? fingerprint(content) : null;
};

export function createCustomerIdentity({ store, isCurrent } = {}) {
  if (!store?.transaction || !store?.nowIso || typeof isCurrent !== 'function') throw new TypeError('Customer identity requires storage and current-context authorization');
  const { run, get, all, transaction, nowIso } = store;
  const sequences = createDurableSequences(store);
  const blocked = new Map();
  let closed = false;
  run(`CREATE TABLE IF NOT EXISTS backend_customer_identity_scopes(owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    official_uid INTEGER NOT NULL,account_ref TEXT NOT NULL,context_json TEXT NOT NULL,last_source_json TEXT NOT NULL,
    life_sequence INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref))`);
  run(`CREATE TABLE IF NOT EXISTS backend_customer_identity_lives(lifecycle_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,
    subject_ref TEXT NOT NULL,npc_id INTEGER NOT NULL,occurrence_no INTEGER NOT NULL,first_seen_sequence INTEGER NOT NULL,
    content_fingerprint TEXT NOT NULL,content_json TEXT NOT NULL,anchor_source_json TEXT NOT NULL,boundary_kind TEXT NOT NULL,
    identity_known INTEGER NOT NULL,reason_code TEXT,prior_lifecycle_ref TEXT,recorded_at TEXT NOT NULL,
    UNIQUE(owner_ref,subject_ref,npc_id,occurrence_no))`);
  run('CREATE INDEX IF NOT EXISTS backend_customer_identity_content ON backend_customer_identity_lives(owner_ref,subject_ref,npc_id,content_fingerprint)');
  run(`CREATE TABLE IF NOT EXISTS backend_customer_identity_slots(owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    npc_id INTEGER NOT NULL,lifecycle_ref TEXT,content_fingerprint TEXT,presence TEXT NOT NULL,readable INTEGER NOT NULL,
    source_json TEXT NOT NULL,boundary_pending INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref,npc_id))`);
  run(`CREATE TABLE IF NOT EXISTS backend_customer_identity_observations(observation_key TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,
    subject_ref TEXT NOT NULL,context_json TEXT NOT NULL,source_json TEXT NOT NULL,input_fingerprint TEXT NOT NULL,
    collection_complete INTEGER NOT NULL,recorded_at TEXT NOT NULL)`);
  run(`CREATE TABLE IF NOT EXISTS backend_customer_identity_source_refinements(refinement_ref TEXT PRIMARY KEY,observation_key TEXT NOT NULL,
    owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,refinement_fingerprint TEXT NOT NULL,payload_json TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
  run(`CREATE TABLE IF NOT EXISTS backend_customer_identity_events(event_key TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,
    subject_ref TEXT NOT NULL,npc_id INTEGER NOT NULL,lifecycle_ref TEXT,event_kind TEXT NOT NULL,payload_json TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
  for (const table of ['lives', 'observations', 'events']) for (const action of ['UPDATE', 'DELETE']) run(`CREATE TRIGGER IF NOT EXISTS backend_customer_identity_${table}_no_${action.toLowerCase()}
    BEFORE ${action} ON backend_customer_identity_${table} BEGIN SELECT RAISE(ABORT,'customer identity evidence is append only'); END`);
  for (const action of ['UPDATE', 'DELETE']) run(`CREATE TRIGGER IF NOT EXISTS backend_customer_identity_source_refinements_no_${action.toLowerCase()}
    BEFORE ${action} ON backend_customer_identity_source_refinements BEGIN SELECT RAISE(ABORT,'customer identity source refinements are append only'); END`);

  const active = context => !closed && synchronous(isCurrent(context)) === true;
  const contextKey = context => fingerprint(context);
  function contextOf(input) {
    const context = customerContext(input);
    if (!context) throw problem('CUSTOMER_IDENTITY_CONTEXT_INVALID', '顾客身份需要完整当前归属代际', 400);
    return context;
  }
  function sourceValid(source, context, officialUid) {
    return source?.kind === 'response' && source.transport === 'answered' && source.contextKey === customerContextKey(context) && source.connectionEpoch === context.connectionEpoch &&
      positive(source.requestSequence) && text(source.responseRef) && text(source.wireKey) && text(source.version?.loginResponseRef) &&
      customerIdentitySourceVersionSupported(source, context, officialUid);
  }
  function refineExistingObservation({ observation, observationKey, context, source, rows, inputFingerprint, officialUid }) {
    let oldContext, oldSource;
    try {
      oldContext = parseStored(observation.context_json, 'customer identity observation context');
      oldSource = parseStored(observation.source_json, 'customer identity observation source');
    } catch { return false; }
    const priorScope = get('SELECT official_uid FROM backend_customer_identity_scopes WHERE owner_ref=? AND subject_ref=?',
      context.ownerRef, context.subjectRef);
    if (!sameCustomerContext(oldContext, context) || canonical(oldContext) !== canonical(context) ||
        observation.owner_ref !== context.ownerRef || observation.subject_ref !== context.subjectRef ||
        observation.collection_complete !== 1 || !priorScope || priorScope.official_uid !== officialUid ||
        !sourceValid(oldSource, context, officialUid) || !sourceValid(source, context, officialUid) ||
        !refinementSourcePairValid(oldSource, source)) return false;
    const oldInputFingerprint = fingerprint({ context: oldContext, source: oldSource, rows: rowsForFingerprint(rows) });
    if (oldInputFingerprint !== observation.input_fingerprint) return false;
    const oldSourceFingerprint = fingerprint(oldSource), newSourceFingerprint = fingerprint(source);
    if (oldSourceFingerprint === newSourceFingerprint || observation.input_fingerprint === inputFingerprint) return false;
    const refinementRef = 'customer-identity-source-refinement:' + fingerprint([observationKey, oldInputFingerprint, inputFingerprint,
      oldSourceFingerprint, newSourceFingerprint]);
    const existing = get('SELECT refinement_fingerprint,payload_json FROM backend_customer_identity_source_refinements WHERE refinement_ref=? AND observation_key=? AND owner_ref=? AND subject_ref=?',
      refinementRef, observationKey, context.ownerRef, context.subjectRef);
    if (existing) {
      let prior, priorBase;
      try { prior = parseStored(existing.payload_json, 'customer identity source refinement'); } catch { return false; }
      if (!prior || typeof prior !== 'object' || Array.isArray(prior)) return false;
      priorBase = { ...prior };
      delete priorBase.refinementFingerprint;
      if (fingerprint(priorBase) !== existing.refinement_fingerprint || prior.refinementFingerprint !== existing.refinement_fingerprint) return false;
      if (!(prior.refinementRef === refinementRef && prior.observationKey === observationKey &&
        prior.contextFingerprint === fingerprint(context) && prior.officialUid === officialUid &&
        prior.responseRef === source.responseRef && prior.requestSequence === source.requestSequence && prior.wireKey === source.wireKey &&
        prior.observationRef === oldSource.observationRef && prior.observationRef === source.observationRef &&
        prior.oldInputFingerprint === oldInputFingerprint && prior.newInputFingerprint === inputFingerprint &&
        prior.oldSourceFingerprint === oldSourceFingerprint && prior.newSourceFingerprint === newSourceFingerprint &&
        prior.ownerRef === context.ownerRef && prior.subjectRef === context.subjectRef &&
        text(prior.observationRef) && /^[a-f0-9]{64}$/.test(prior.payloadFingerprint || '') &&
        prior.compatibility?.old?.proofFingerprint === fingerprint(oldSource.version.sourceProofs) &&
        prior.compatibility?.old?.compatibilityRef === 'customer-compatibility-revalidation:' + fingerprint([prior.observationRef,
          prior.compatibility.old.proofFingerprint]) &&
        prior.compatibility?.new?.proofFingerprint === fingerprint(source.version.sourceProofs) &&
        prior.compatibility?.new?.compatibilityRef === 'customer-compatibility-revalidation:' + fingerprint([prior.observationRef,
          prior.compatibility.new.proofFingerprint]))) return false;
      const receiptMatches = entry => {
        const receipt = get('SELECT observation_ref,payload_fingerprint,proof_fingerprint,accepted,reason_code FROM backend_customer_compatibility_revalidations WHERE revalidation_ref=?',
          entry.compatibilityRef);
        return !!receipt && receipt.observation_ref === prior.observationRef && receipt.payload_fingerprint === prior.payloadFingerprint &&
          receipt.proof_fingerprint === entry.proofFingerprint && receipt.accepted === 1 && receipt.reason_code == null;
      };
      return prior.sourcePayloadFingerprint === prior.payloadFingerprint && /^[a-f0-9]{64}$/.test(prior.wholeFrameFingerprint || '') &&
        receiptMatches(prior.compatibility.old) &&
        receiptMatches(prior.compatibility.new);
    }
    const oldEvidence = resolveAcceptedCustomerObservationEvidence({ store, context: oldContext,
      requestSequence: oldSource.requestSequence, responseRef: oldSource.responseRef, expectedSource: oldSource });
    const newEvidence = resolveAcceptedCustomerObservationEvidence({ store, context,
      requestSequence: source.requestSequence, responseRef: source.responseRef, expectedSource: source });
    if (!oldEvidence?.accepted || oldEvidence.compatibility !== true || !newEvidence?.accepted || newEvidence.compatibility !== true ||
        oldEvidence.row.observation_ref !== newEvidence.row.observation_ref ||
        oldEvidence.row.observation_ref !== oldSource.observationRef || oldEvidence.row.observation_ref !== source.observationRef ||
        oldEvidence.row.payload_fingerprint !== newEvidence.row.payload_fingerprint ||
        oldEvidence.wholeFrameFingerprint !== newEvidence.wholeFrameFingerprint ||
        oldEvidence.row.response_ref !== source.responseRef || oldEvidence.row.request_sequence !== source.requestSequence ||
        oldEvidence.row.wire_key !== source.wireKey) return false;
    const payload = { refinementRef, observationKey, ownerRef: context.ownerRef, subjectRef: context.subjectRef,
      contextFingerprint: fingerprint(context), officialUid, responseRef: source.responseRef, requestSequence: source.requestSequence,
      wireKey: source.wireKey, observationRef: oldEvidence.row.observation_ref,
      sourcePayloadFingerprint: oldEvidence.row.payload_fingerprint, payloadFingerprint: oldEvidence.row.payload_fingerprint,
      wholeFrameFingerprint: oldEvidence.wholeFrameFingerprint, oldInputFingerprint, newInputFingerprint: inputFingerprint,
      oldSourceFingerprint, newSourceFingerprint,
      compatibility: { old: { compatibilityRef: oldEvidence.compatibilityRef, proofFingerprint: oldEvidence.proofFingerprint },
        new: { compatibilityRef: newEvidence.compatibilityRef, proofFingerprint: newEvidence.proofFingerprint } } };
    if (!active(context)) return false;
    const refinementFingerprint = fingerprint(payload), persistedPayload = { ...payload, refinementFingerprint };
    run('INSERT INTO backend_customer_identity_source_refinements VALUES(?,?,?,?,?,?,?)', refinementRef, observationKey,
      context.ownerRef, context.subjectRef, refinementFingerprint, canonical(persistedPayload), nowIso());
    return true;
  }
  function event(context, source, npcId, lifecycleRef, eventKind, payload) {
    const key = 'customer-identity-event:' + fingerprint([context.ownerRef, context.subjectRef, source.responseRef, npcId, eventKind]);
    const json = canonical(payload), prior = get('SELECT payload_json FROM backend_customer_identity_events WHERE event_key=?', key);
    if (prior && prior.payload_json !== json) throw problem('CUSTOMER_IDENTITY_EVENT_CONFLICT', '顾客身份原证据冲突', 500);
    if (!prior) run('INSERT INTO backend_customer_identity_events VALUES(?,?,?,?,?,?,?,?)', key, context.ownerRef, context.subjectRef,
      npcId, lifecycleRef, eventKind, json, nowIso());
  }
  function makeLife(context, source, order, priorSlot, boundaryKind) {
    const content = customerOrderContent(order), contentFingerprint = fingerprint(content);
    const previous = priorSlot?.lifecycle_ref ? get('SELECT * FROM backend_customer_identity_lives WHERE lifecycle_ref=? AND owner_ref=? AND subject_ref=?',
      priorSlot.lifecycle_ref, context.ownerRef, context.subjectRef) : null;
    const repeats = all(`SELECT lifecycle_ref FROM backend_customer_identity_lives WHERE owner_ref=? AND subject_ref=? AND npc_id=?
      AND content_fingerprint=? ORDER BY occurrence_no LIMIT 33`, context.ownerRef, context.subjectRef, order.npcId, contentFingerprint);
    const oldContent = previous ? parseStored(previous.content_json, 'customer previous order content') : null;
    const distinguishingChange = oldContent && ['cTime', 'artId', 'num'].some(name => oldContent.fields[name].value !== content.fields[name].value);
    const known = repeats.length === 0 && (boundaryKind === 'first-observed' || boundaryKind === 'observed-after-absence' || distinguishingChange);
    const reasonCode = repeats.length ? 'CUSTOMER_SAME_CONTENT_REAPPEARED' : known ? null : 'CUSTOMER_ROW_MUTATION_IDENTITY_UNPROVEN';
    const occurrenceNo = sequences.next('customer-occurrence', [context.ownerRef, context.subjectRef, order.npcId], () =>
      Number(get(`SELECT COALESCE(MAX(occurrence_no),0) AS n FROM backend_customer_identity_lives
        WHERE owner_ref=? AND subject_ref=? AND npc_id=?`, context.ownerRef, context.subjectRef, order.npcId).n));
    run('UPDATE backend_customer_identity_scopes SET life_sequence=life_sequence+1 WHERE owner_ref=? AND subject_ref=?', context.ownerRef, context.subjectRef);
    const firstSeenSequence = get('SELECT life_sequence FROM backend_customer_identity_scopes WHERE owner_ref=? AND subject_ref=?', context.ownerRef, context.subjectRef).life_sequence;
    if (!positive(occurrenceNo) || !positive(firstSeenSequence)) throw problem('CUSTOMER_IDENTITY_SEQUENCE_EXHAUSTED', '顾客身份持久序号超出范围', 500);
    const lifecycleRef = 'customer-life:' + fingerprint([context.ownerRef, context.subjectRef, order.npcId, occurrenceNo]);
    run('INSERT INTO backend_customer_identity_lives VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', lifecycleRef, context.ownerRef, context.subjectRef,
      order.npcId, occurrenceNo, firstSeenSequence, contentFingerprint, canonical(content), canonical(source), boundaryKind,
      known ? 1 : 0, reasonCode, previous?.lifecycle_ref || null, nowIso());
    event(context, source, order.npcId, lifecycleRef, 'occurrence-observed', { boundaryKind, contentFingerprint,
      priorLifecycleRef: previous?.lifecycle_ref || null, identityKnown: known, reasonCode,
      sameContentReferences: repeats.slice(0, 32).map(one => one.lifecycle_ref), referencesTruncated: repeats.length > 32,
      officialOrderIdProven: false, historicalConstraintsChecked: false });
    return lifecycleRef;
  }
  function reconcile({ context: supplied, view } = {}) {
    const context = contextOf(supplied), map = view?.orderMap, source = map?.source;
    const denied = reasonCode => freeze({ accepted: false, changed: false, current: false, complete: false, reasonCode,
      context: clone(context), identities: [], writeEligible: false });
    if (!active(context)) return denied('CUSTOMER_IDENTITY_CONTEXT_NOT_CURRENT');
    if (!sameCustomerContext(context, view?.context) || view.current !== true || view.identity?.verified !== true ||
      !knownCustomerCell(view.identity.uid) || !positive(value(view.identity.uid)) || map?.current !== true ||
      map.presence !== 'present' || map.state !== 'known' || !sourceValid(source, context, value(view.identity.uid))) {
      blocked.set(contextKey(context), 'CUSTOMER_IDENTITY_CURRENT_MAP_REQUIRED');
      return denied('CUSTOMER_IDENTITY_CURRENT_MAP_REQUIRED');
    }
    const rows = map.entries;
    if (!Array.isArray(rows) || rows.length > MAX_ROWS || map.truncated === true || map.returnedComplete !== true ||
      map.sourceProvidedCollectionComplete !== true || map.total !== rows.length || !rows.every(one => positive(one.npcId)) ||
      new Set(rows.map(one => one.npcId)).size !== rows.length) {
      blocked.set(contextKey(context), 'CUSTOMER_IDENTITY_COMPLETE_COLLECTION_REQUIRED');
      return denied('CUSTOMER_IDENTITY_COMPLETE_COLLECTION_REQUIRED');
    }
    // Complete is collection coverage, not an assertion that every row is
    // readable. A malformed different slot must not suppress a valid order.
    const inputFingerprint = fingerprint({ context, source, rows: rows.map(one => ({ npcId: one.npcId,
      content: customerOrderContent(one), readable: one.readable === true, current: one.current === true })).sort((a, b) => a.npcId - b.npcId) });
    const observationKey = 'customer-identity-observation:' + fingerprint([context.ownerRef, context.subjectRef, source.responseRef]);
    return transaction(() => {
      if (!active(context)) return denied('CUSTOMER_IDENTITY_CONTEXT_NOT_CURRENT');
      const scope = get('SELECT * FROM backend_customer_identity_scopes WHERE owner_ref=? AND subject_ref=?', context.ownerRef, context.subjectRef);
      if (scope && scope.official_uid !== value(view.identity.uid)) return denied('CUSTOMER_IDENTITY_OFFICIAL_UID_CONFLICT');
      const previousSource = scope ? parseStored(scope.last_source_json, 'customer identity last source') : null;
      // A newer durable head makes an older input incapable of changing the
      // identity. It needs neither a historical replay row nor a refinement of
      // its old public proofs. Current-response conflicts remain exact below.
      if (previousSource && (source.connectionEpoch < previousSource.connectionEpoch || source.connectionEpoch === previousSource.connectionEpoch
          && source.requestSequence < previousSource.requestSequence)) return freeze({ ...listCurrent({ context }), accepted: false,
        changed: false, replayed: true, sourceIgnored: true, reasonCode: 'CUSTOMER_IDENTITY_SOURCE_SUPERSEDED' });
      const observation = get('SELECT * FROM backend_customer_identity_observations WHERE observation_key=?', observationKey);
      if (observation) {
        if (observation.input_fingerprint !== inputFingerprint && !refineExistingObservation({ observation, observationKey, context,
          source, rows, inputFingerprint, officialUid: value(view.identity.uid) })) {
          throw problem('CUSTOMER_IDENTITY_OBSERVATION_CONFLICT', '同一顾客观察的身份内容冲突', 500);
        }
        blocked.delete(contextKey(context));
        return freeze({ ...listCurrent({ context }), accepted: true, changed: false, replayed: true });
      }
      if (previousSource && (source.connectionEpoch < previousSource.connectionEpoch || source.connectionEpoch === previousSource.connectionEpoch &&
        source.requestSequence <= previousSource.requestSequence)) return denied('CUSTOMER_IDENTITY_SOURCE_NOT_NEWER');
      if (!scope) run('INSERT INTO backend_customer_identity_scopes VALUES(?,?,?,?,?,?,?,?)', context.ownerRef, context.subjectRef,
        value(view.identity.uid), context.accountRef, canonical(context), canonical(source), 0, nowIso());
      const oldSlots = all('SELECT * FROM backend_customer_identity_slots WHERE owner_ref=? AND subject_ref=? ORDER BY npc_id', context.ownerRef, context.subjectRef);
      const slots = new Map(oldSlots.map(one => [one.npc_id, one])), observed = new Set();
      let changed = false;
      for (const order of [...rows].sort((a, b) => a.npcId - b.npcId)) {
        observed.add(order.npcId);
        const old = slots.get(order.npcId), content = customerOrderContent(order);
        const readable = order.current === true && order.readable === true && order.presence === 'present' && order.state === 'known' &&
          Object.values(content.fields).every(one => one.presence === 'present' && one.state === 'known');
        let lifecycleRef = old?.lifecycle_ref || null, contentFingerprint = old?.content_fingerprint || null;
        if (readable) {
          const nextFingerprint = fingerprint(content);
          if (!lifecycleRef || old.boundary_pending === 1 || old.presence === 'not-present' || nextFingerprint !== contentFingerprint) {
            lifecycleRef = makeLife(context, source, order, old, !lifecycleRef ? 'first-observed' : old.presence === 'not-present' || old.boundary_pending === 1 ? 'observed-after-absence' : 'observed-content-change');
            changed = true;
          }
          contentFingerprint = nextFingerprint;
        }
        if (!old || old.presence !== 'present' || old.readable !== (readable ? 1 : 0)) changed = true;
        const boundaryPending = !readable && (old?.presence === 'not-present' || old?.boundary_pending === 1) ? 1 : 0;
        run(`INSERT INTO backend_customer_identity_slots VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref,npc_id)
          DO UPDATE SET lifecycle_ref=excluded.lifecycle_ref,content_fingerprint=excluded.content_fingerprint,presence=excluded.presence,
          readable=excluded.readable,source_json=excluded.source_json,boundary_pending=excluded.boundary_pending,updated_at=excluded.updated_at`, context.ownerRef, context.subjectRef,
        order.npcId, lifecycleRef, contentFingerprint, 'present', readable ? 1 : 0, canonical(source), boundaryPending, nowIso());
        // The slot/source is the durable recovery head. An unchanged row does
        // not need another historical event just because a new read arrived.
        if (!old || old.presence !== 'present' || old.readable !== Number(readable) || old.lifecycle_ref !== lifecycleRef
            || old.content_fingerprint !== contentFingerprint || old.boundary_pending !== boundaryPending) {
          event(context, source, order.npcId, lifecycleRef, readable ? 'row-observed' : 'row-unreadable',
            { contentFingerprint: readable ? contentFingerprint : null, originalContentRetained: !readable, source: clone(source) });
        }
      }
      for (const old of oldSlots) if (!observed.has(old.npc_id) && old.presence !== 'not-present') {
        run("UPDATE backend_customer_identity_slots SET presence='not-present',readable=0,boundary_pending=1,source_json=?,updated_at=? WHERE owner_ref=? AND subject_ref=? AND npc_id=?",
          canonical(source), nowIso(), context.ownerRef, context.subjectRef, old.npc_id);
        event(context, source, old.npc_id, old.lifecycle_ref, 'absence-observed', { source: clone(source),
          collectionComplete: true, attributedToOperation: false, historicalVerdictChanged: false });
        changed = true;
      }
      if (!active(context)) throw problem('CUSTOMER_IDENTITY_CONTEXT_REVOKED', '顾客身份提交前归属代际已改变');
      run('UPDATE backend_customer_identity_scopes SET account_ref=?,context_json=?,last_source_json=?,updated_at=? WHERE owner_ref=? AND subject_ref=?',
        context.accountRef, canonical(context), canonical(source), nowIso(), context.ownerRef, context.subjectRef);
      run('INSERT INTO backend_customer_identity_observations VALUES(?,?,?,?,?,?,?,?)', observationKey, context.ownerRef, context.subjectRef,
        canonical(context), canonical(source), inputFingerprint, 1, nowIso());
      blocked.delete(contextKey(context));
      return freeze({ ...listCurrent({ context }), accepted: true, changed });
    });
  }
  function listCurrent({ context: supplied } = {}) {
    const context = contextOf(supplied);
    if (!active(context)) return freeze({ context: clone(context), current: false, complete: false, source: null, identities: [],
      writeEligible: false, reasonCode: 'CUSTOMER_IDENTITY_CONTEXT_NOT_CURRENT', queueVersion: fingerprint([]) });
    const scope = get('SELECT * FROM backend_customer_identity_scopes WHERE owner_ref=? AND subject_ref=?', context.ownerRef, context.subjectRef);
    const current = active(context) && !blocked.has(contextKey(context)) && !!scope && sameCustomerContext(context, parseStored(scope.context_json, 'customer identity context'));
    const source = scope ? parseStored(scope.last_source_json, 'customer identity source') : null;
    const slots = all(`SELECT s.*,l.occurrence_no,l.first_seen_sequence,l.content_json,l.identity_known,l.reason_code,l.boundary_kind
      FROM backend_customer_identity_slots s LEFT JOIN backend_customer_identity_lives l ON l.lifecycle_ref=s.lifecycle_ref
      AND l.owner_ref=s.owner_ref AND l.subject_ref=s.subject_ref WHERE s.owner_ref=? AND s.subject_ref=? AND s.presence='present'
      ORDER BY l.first_seen_sequence,s.npc_id LIMIT 129`, context.ownerRef, context.subjectRef);
    const complete = current && slots.length <= MAX_ROWS;
    const identities = slots.slice(0, MAX_ROWS).map(one => {
      const rowSource = parseStored(one.source_json, 'customer identity row source');
      const rowCurrent = current && rowSource.connectionEpoch === context.connectionEpoch && sourceValid(rowSource, context, scope?.official_uid);
      return { context: clone(context), npcId: one.npc_id, lifecycleRef: one.lifecycle_ref,
        occurrenceNo: one.occurrence_no ?? null, firstSeenSequence: one.first_seen_sequence ?? null,
        contentFingerprint: one.content_fingerprint, content: one.content_json ? parseStored(one.content_json, 'customer order identity content') : null,
        identityKnown: rowCurrent && one.readable === 1 && one.identity_known === 1, current: rowCurrent,
        reasonCode: !rowCurrent ? 'CUSTOMER_IDENTITY_CONTEXT_NOT_CURRENT' : one.readable !== 1 ? 'CUSTOMER_ORDER_FIELDS_INCOMPLETE' : one.reason_code,
        boundaryKind: one.boundary_kind ?? null, source: rowSource, officialOrderIdProven: false,
        historicalConstraintsChecked: false, writeEligible: false };
    });
    return freeze({ context: clone(context), current, complete, source, identities, writeEligible: false,
      reasonCode: !current ? 'CUSTOMER_IDENTITY_CONTEXT_NOT_CURRENT' : !complete ? 'CUSTOMER_IDENTITY_COLLECTION_LIMIT_EXCEEDED' : null,
      queueVersion: fingerprint(identities.map(one => [one.npcId, one.lifecycleRef, one.contentFingerprint, one.identityKnown, one.firstSeenSequence])) });
  }
  function getIdentity({ context, npcId } = {}) {
    if (!positive(npcId)) throw problem('CUSTOMER_NPC_ID_INVALID', '顾客NPC编号无效', 400);
    return listCurrent({ context }).identities.find(one => one.npcId === npcId) || null;
  }
  return Object.freeze({ reconcile, get: getIdentity, listCurrent, shutdown: () => { closed = true; blocked.clear(); } });
}
