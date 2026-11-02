import { canonical, newId, plainObject } from '../common.mjs';

// Direct wire paths from gs-ds-schemas.json: G.ISyncData/G.IUsrTot/G.IUsr/
// G.IUsrLandTot/G.IUsrLand/G.ILand/G.ICultivateTot. Missing fields are never
// manufactured. A sparse reply supplies only the paths actually present.
const NUMERIC_PROFILE = Object.freeze({ level: '34', gold: '44', yuanbao: '41' });
const profileFields = Object.freeze({ ...NUMERIC_PROFILE, uid: '0', nickname: '5' });
const map = value => plainObject(value) && Object.keys(value).every(key => /^\d+$/.test(key));
const empty = value => value !== null && typeof value === 'object' && Object.keys(value).length === 0;
const read = (value, path) => {
  let node = value;
  for (const key of path) {
    if (!plainObject(node) || !Object.hasOwn(node, key)) return { present: false };
    node = node[key];
  }
  return { present: true, value: node };
};

export function publicLoginProfile(observation) {
  if (observation?.source !== 'response' || observation.transport !== 'answered' || observation.method !== 'index.login' ||
      !Number.isSafeInteger(observation.requestSequence) || observation.requestSequence < 1 || !observation.envelopeOk ||
      observation.dsName !== 'G.ISyncData' || !plainObject(observation.value)) return null;
  const found = read(observation.value, ['7', '0']);
  if (!found.present || !plainObject(found.value)) return null;
  const out = {};
  for (const [name, key] of Object.entries(profileFields)) {
    if (!Object.hasOwn(found.value, key)) continue;
    const value = found.value[key];
    if (name === 'nickname') { if (typeof value === 'string') out.nickname = value.slice(0, 80); }
    else if (Number.isSafeInteger(value) && value >= 0) out[name] = value;
  }
  return Object.hasOwn(out, 'uid') && out.uid > 0 ? out : null;
}

export function createOfficialObservationIngestor({ facts, store, notify = () => {} }) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_late_official_observations(
    audit_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,connection_epoch INTEGER NOT NULL,
    response_ref TEXT NOT NULL,wire_key TEXT,ds_name TEXT,envelope_ok INTEGER NOT NULL,rejected INTEGER NOT NULL,
    received_device_ms INTEGER,evidence_json TEXT NOT NULL,recorded_at TEXT NOT NULL,
    UNIQUE(subject_ref,connection_epoch,response_ref));
    CREATE TRIGGER IF NOT EXISTS backend_late_official_observations_no_update BEFORE UPDATE ON backend_late_official_observations
      BEGIN SELECT RAISE(ABORT,'late official evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_late_official_observations_no_delete BEFORE DELETE ON backend_late_official_observations
      BEGIN SELECT RAISE(ABORT,'late official evidence is append only'); END;`);
  const sequences = new Map();
  function auditLate(context, observation) {
    const paths = [];
    if (observation.envelopeOk === true && observation.dsName === 'G.ISyncData' && plainObject(observation.value)) {
      // Retain only public G2 identity/land/resource evidence. Never archive an
      // arbitrary IUsr, IOther, private token or authentication response here.
      for (const path of [['7', '0', '0'], ['7', '0', '32'], ['7', '2', '0'], ['7', '2', '1'], ['7', '2', '2'],
        ['100', '0'], ['100', '1'], ['100', '2'], ['101', '0'], ['7', '3', 'flowerPlantTop']]) {
        const found = read(observation.value, path);
        if (found.present) paths.push({ path: path.join('.'), value: found.value });
      }
    }
    const responseRef = typeof observation.responseRef === 'string' && observation.responseRef.length <= 512 ? observation.responseRef : null;
    if (!responseRef) return { accepted: false, audited: false, reasonCode: 'LATE_OBSERVATION_REFERENCE_MISSING' };
    const auditRef = newId();
    const result = store.run(`INSERT OR IGNORE INTO backend_late_official_observations(audit_ref,owner_ref,subject_ref,connection_epoch,
      response_ref,wire_key,ds_name,envelope_ok,rejected,received_device_ms,evidence_json,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    auditRef, context.ownerRef, context.subjectRef, context.connectionEpoch, responseRef,
    typeof observation.wireKey === 'string' && observation.wireKey.length <= 128 ? observation.wireKey : null,
    typeof observation.dsName === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,95}$/.test(observation.dsName) ? observation.dsName : null,
    Number(observation.envelopeOk === true), Number(observation.rejected === true),
    Number.isSafeInteger(observation.receivedDeviceMs) && observation.receivedDeviceMs >= 0 ? observation.receivedDeviceMs : null,
    canonical({ source: observation.source === 'push' ? 'push-without-causal-sequence' : 'late', paths }), store.nowIso());
    return { accepted: false, audited: true, auditInserted: result.changes === 1, reasonCode: 'LATE_OBSERVATION_AUDIT_ONLY', responseRef };
  }
  function ingest(context, observation) {
    // Do this before envelope, clock, profile or arrival-sequence processing.
    // Same-epoch late data may describe an older land/resource state and must
    // never become a fresh head merely because it arrived last.
    if (observation?.source === 'late' || observation?.source === 'push' || observation?.transport === 'push') return auditLate(context, observation);
    if (observation?.envelopeOk !== true || observation.dsName !== 'G.ISyncData' || !plainObject(observation.value)) return { accepted: false, reasonCode: 'OBSERVATION_ENVELOPE_UNSUPPORTED' };
    const connectionKey = context.subjectRef + ':' + context.connectionEpoch;
    const arrivalSequence = Number(sequences.get(connectionKey) || 0) + 1;
    sequences.set(connectionKey, arrivalSequence);
    const source = { kind: observation.method === 'index.login' ? 'login' : observation.transport === 'push' ? 'official-sync' :
      observation.method === 'usrLand.refresh' ? 'official-read' : 'official-response', method: observation.method || 'official-push', responseRef: observation.responseRef,
      requestSequence: Number.isSafeInteger(observation.requestSequence) ? observation.requestSequence : null,
      wireKey: observation.wireKey ?? null,
      receivedMonotonicMs: typeof observation.receivedMonotonicMs === 'number' && Number.isFinite(observation.receivedMonotonicMs)
        ? observation.receivedMonotonicMs : null };
    const accepted = [];
    store.transaction(() => {
      const clockMs = Number.isSafeInteger(observation.serverMs) && observation.serverMs > 0 ? observation.serverMs :
        Number.isSafeInteger(observation.serverRespondedMs) && observation.serverRespondedMs > 0 ? observation.serverRespondedMs : null;
      const timedResponse = Number.isFinite(observation.sentMonotonicMs) && observation.sentMonotonicMs >= 0
        && Number.isFinite(observation.receivedMonotonicMs) && observation.receivedMonotonicMs >= observation.sentMonotonicMs;
      // A push has no measured request/response interval. Keep any existing
      // trusted monotonic anchor; neither absent RTT nor a clock rollback is a
      // zero-uncertainty sample or grounds to create a new anchor.
      if (clockMs !== null && timedResponse) facts.calibrateClock({ subjectRef: context.subjectRef, connectionEpoch: context.connectionEpoch,
        officialMs: clockMs, uncertaintyMs: Math.ceil(observation.receivedMonotonicMs - observation.sentMonotonicMs), source });
      const put = (domain, semanticPath, entry, validate = () => true) => {
        if (!entry.present) return;
        const valid = validate(entry.value);
        accepted.push(facts.observe({ ownerRef: context.ownerRef, subjectRef: context.subjectRef, connectionEpoch: context.connectionEpoch,
          arrivalSequence, domain, semanticPath, state: valid ? 'read' : 'unreadable', ...(valid ? { value: entry.value } : {}),
          verifiedEmpty: valid && empty(entry.value), source, decodeVersion: 'official-wire-paths/v1',
          coverage: [semanticPath], observedDeviceMs: observation.receivedDeviceMs, observedOfficialMs: clockMs,
          clockRevision: facts.clock(context.subjectRef).revision ?? null }));
      };
      for (const [name, fieldKey] of Object.entries(profileFields)) {
        if (name === 'nickname') continue;
        put('profile', name, read(observation.value, ['7', '0', fieldKey]), value => Number.isSafeInteger(value) && (name === 'uid' ? value > 0 : value >= 0));
      }
      put('inventory', 'bag', read(observation.value, ['7', '0', '32']), value => map(value) && Object.values(value).every(count => Number.isSafeInteger(count) && count >= 0));
      put('land', 'reportedLandMap', read(observation.value, ['100', '0', '1']), map);
      put('land', 'changedLandMap', read(observation.value, ['100', '1']), map);
      put('cultivation', 'reportedCultivateMap', read(observation.value, ['101', '0']), map);
      // Domain absence in a sparse response is not deletion or a zero value.
    });
    if (accepted.some(one => one.changed)) notify(context);
    return { accepted: true, changed: accepted.some(one => one.changed), cells: accepted.filter(one => one.accepted).length, arrivalSequence, responseRef: observation.responseRef };
  }
  return Object.freeze({ ingest });
}
