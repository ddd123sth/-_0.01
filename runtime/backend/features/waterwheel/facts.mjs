import { canonical, fingerprint, freeze, plainObject, problem } from '../../common.mjs';
import { officialDateMs } from '../land/wire-facts.mjs';

const SOURCE_METHODS = new Set(['index.login', 'waterwheel.enter', 'waterwheel.recv', 'waterwheel.skip', 'usr.share']);
const fields = Object.freeze({ uid: '0', count: '1', advList: '2', rTime: '3', uTime: '4', cTime: '5', offlineNum: '6', calcTime: '7', maxNumTime: '8' });
const validList = value => Array.isArray(value) && value.length <= 128 && value.every(one => Number.isSafeInteger(one) && one >= 0 ||
  plainObject(one) && Object.keys(one).length <= 8 && Object.values(one).every(child => Number.isSafeInteger(child) && child >= 0 || typeof child === 'boolean'));

export function decodeWaterwheelObservation(observation, expectedUid = null) {
  if (!observation || observation.source !== 'response' || observation.transport !== 'answered' || observation.envelopeOk !== true ||
      observation.dsName !== 'G.ISyncData' || !SOURCE_METHODS.has(observation.method)) return null;
  const sync = observation.value, raw = plainObject(sync) ? sync['114'] ?? sync.waterwheel : null;
  if (!plainObject(raw)) return null;
  const value = {};
  for (const [name, index] of Object.entries(fields)) {
    const one = Object.hasOwn(raw, name) ? raw[name] : raw[index];
    if (one === undefined) continue;
    if (name === 'advList') { if (!validList(one)) return null; value[name] = one; }
    else if (one === null && ['rTime', 'uTime', 'cTime', 'calcTime', 'maxNumTime'].includes(name)) value[name] = null;
    else if (['rTime', 'uTime', 'cTime', 'calcTime', 'maxNumTime'].includes(name) && officialDateMs(one) !== null) value[name] = officialDateMs(one);
    else if (Number.isSafeInteger(one) && one >= 0) value[name] = one;
    else return null;
  }
  if (!Number.isSafeInteger(value.uid) || value.uid <= 0 || !Number.isSafeInteger(expectedUid) || expectedUid <= 0 || value.uid !== expectedUid ||
      !Number.isSafeInteger(value.count) || !Array.isArray(value.advList)) return null;
  const usrTotal = plainObject(sync) ? (sync['7'] ?? sync.usrTot) : null;
  const usr = plainObject(usrTotal) ? (usrTotal.usr ?? usrTotal['0']) : null;
  if (plainObject(usr)) {
    const uid = Object.hasOwn(usr, 'uid') ? usr.uid : usr['0'];
    const bag = Object.hasOwn(usr, 'bag') ? usr.bag : usr['32'];
    if (Number.isSafeInteger(uid) && uid > 0 && uid === value.uid && plainObject(bag)) {
      const item7 = Object.hasOwn(bag, '7') ? bag['7'] : undefined;
      if (Number.isSafeInteger(item7) && item7 >= 0) value.item7Balance = item7;
    }
  }
  const openMap = plainObject(usrTotal) ? (usrTotal.openMap ?? usrTotal['9']) : null;
  const open = plainObject(openMap) ? openMap.butler : null;
  const openExt = plainObject(open) ? (open.ext ?? open['10']) : null;
  const closedRaw = plainObject(open) ? (open.closed ?? open['9']) : undefined;
  const beginRaw = plainObject(openExt) ? openExt.beginTime : undefined, endRaw = plainObject(openExt) ? openExt.endTime : undefined;
  const begins = Array.isArray(beginRaw) && beginRaw.length <= 128 ? beginRaw.map(officialDateMs) : null;
  const ends = Array.isArray(endRaw) && endRaw.length <= 128 ? endRaw.map(officialDateMs) : null;
  const butlerTotal = plainObject(sync) ? (sync['175'] ?? sync.butlerTot) : null;
  const settingMap = plainObject(butlerTotal) ? (butlerTotal.butlerSetting ?? butlerTotal['0']) : null;
  const setting = plainObject(settingMap) ? settingMap['1'] : null;
  const buyMap = plainObject(setting) ? (setting.buyPeriodMap ?? setting['5']) : null;
  const hireUid = plainObject(setting) ? (setting.uid ?? setting['0']) : null;
  const hireType = plainObject(setting) ? (setting.type ?? setting['1']) : null;
  const bought = plainObject(buyMap) && Object.keys(buyMap).length <= 1024 && Object.entries(buyMap).every(([key, amount]) =>
    /^\d{1,16}$/.test(key) && Number.isSafeInteger(Number(key)) && Number.isSafeInteger(amount) && amount >= 0)
    ? Object.fromEntries(Object.entries(buyMap).map(([key, amount]) => [key, amount])) : null;
  if (open && (closedRaw === true || closedRaw === false || closedRaw === 0 || closedRaw === 1)) {
    const hire = { closed: closedRaw === true || closedRaw === 1, beginMs: begins, endMs: ends,
      uid: Number.isSafeInteger(hireUid) && hireUid > 0 ? hireUid : null,
      type: Number.isSafeInteger(hireType) && hireType > 0 ? hireType : null, bought };
    if (begins && ends && begins.length === ends.length && begins.every(Number.isSafeInteger) && ends.every(Number.isSafeInteger)) value.butlerHire = hire;
  }
  const shareTotal = plainObject(sync) ? (sync['31'] ?? sync.shareTot) : null;
  const shareMap = plainObject(shareTotal) ? (shareTotal.map ?? shareTotal['0'] ?? null) : null;
  if (plainObject(shareMap)) {
    const row = shareMap['9'];
    // A sparse/missing share row is not proof of a zero allowance.  The game
    // client synthesizes a local fallback row, but that is not server evidence.
    if (plainObject(row)) {
      const shareFields = { uid: '0', tmpId: '1', shareCnt: '2', recvCnt: '3', recvTime: '4', totCnt: '5', uTime: '6', cTime: '7' };
      const share = {}; let validShare = true;
      for (const [name, index] of Object.entries(shareFields)) {
        const one = Object.hasOwn(row, name) ? row[name] : row[index];
        if (one === undefined) continue;
        if (one === null && ['recvTime', 'uTime', 'cTime'].includes(name)) share[name] = null;
        else if (['recvTime', 'uTime', 'cTime'].includes(name) && officialDateMs(one) !== null) share[name] = officialDateMs(one);
        else if (Number.isSafeInteger(one) && one >= 0) share[name] = one;
        else { validShare = false; break; }
      }
      if (validShare && share.uid === value.uid && share.tmpId === 9) value.share9 = { present: true, ...share };
    }
  }
  return freeze({ value, fingerprint: fingerprint(value), source: { method: observation.method,
    responseRef: observation.responseRef, requestSequence: observation.requestSequence, wireKey: observation.wireKey,
    connectionEpoch: observation.connectionEpoch, receivedDeviceMs: observation.receivedDeviceMs,
    receivedMonotonicMs: observation.receivedMonotonicMs, operationId: observation.operationId ?? null } });
}

export function createWaterwheelFacts({ store, isCurrent, officialUidForContext }) {
  const { run, get, transaction, nowIso } = store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_waterwheel_receipts(
    response_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,request_sequence INTEGER NOT NULL,
    method TEXT NOT NULL,operation_id TEXT,value_json TEXT NOT NULL,value_fingerprint TEXT NOT NULL,received_device_ms INTEGER NOT NULL,
    received_monotonic_ms REAL NOT NULL,recorded_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS backend_waterwheel_receipts_no_update BEFORE UPDATE ON backend_waterwheel_receipts
      BEGIN SELECT RAISE(ABORT,'waterwheel source receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_waterwheel_receipts_no_delete BEFORE DELETE ON backend_waterwheel_receipts
      BEGIN SELECT RAISE(ABORT,'waterwheel source receipts are append only'); END;
    CREATE TABLE IF NOT EXISTS backend_waterwheel_heads(
      owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,
      connection_epoch INTEGER NOT NULL,response_ref TEXT NOT NULL REFERENCES backend_waterwheel_receipts(response_ref),
      source_method TEXT NOT NULL,request_sequence INTEGER NOT NULL,value_json TEXT NOT NULL,value_fingerprint TEXT NOT NULL,
      received_device_ms INTEGER NOT NULL,received_monotonic_ms REAL NOT NULL,
      updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref));`);
  function ingest({ context, observation } = {}) {
    const officialUid = context && typeof officialUidForContext === 'function' ? officialUidForContext(context) : null;
    const decoded = decodeWaterwheelObservation(observation, officialUid);
    if (!decoded || !context || !isCurrent(context) || decoded.source.connectionEpoch !== context.connectionEpoch ||
        !Number.isSafeInteger(decoded.source.requestSequence) || decoded.source.requestSequence <= 0 ||
        typeof decoded.source.responseRef !== 'string' || !Number.isSafeInteger(decoded.source.receivedDeviceMs) ||
        !Number.isFinite(decoded.source.receivedMonotonicMs)) return { accepted: false, changed: false, reasonCode: 'WATERWHEEL_SOURCE_NOT_CURRENT' };
    const receipt = { ...context, ...decoded.source, value: decoded.value, valueFingerprint: decoded.fingerprint };
    const valueJson = canonical(decoded.value), prior = get('SELECT * FROM backend_waterwheel_receipts WHERE response_ref=?', decoded.source.responseRef);
    if (prior) {
      if (prior.owner_ref !== context.ownerRef || prior.subject_ref !== context.subjectRef || prior.value_fingerprint !== decoded.fingerprint ||
          prior.connection_epoch !== context.connectionEpoch || prior.request_sequence !== decoded.source.requestSequence || prior.method !== decoded.source.method) {
        throw problem('WATERWHEEL_RECEIPT_CONFLICT', '同一水车回包引用对应了不同的官服事实', 409);
      }
    }
    const before = get('SELECT * FROM backend_waterwheel_heads WHERE owner_ref=? AND subject_ref=?', context.ownerRef, context.subjectRef);
    const newer = !before || before.connection_epoch < context.connectionEpoch || before.connection_epoch === context.connectionEpoch && before.request_sequence < decoded.source.requestSequence;
    if (newer) transaction(() => {
      run(`INSERT OR IGNORE INTO backend_waterwheel_receipts(response_ref,owner_ref,account_ref,subject_ref,owner_epoch,run_epoch,connection_epoch,
        request_sequence,method,operation_id,value_json,value_fingerprint,received_device_ms,received_monotonic_ms,recorded_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, decoded.source.responseRef, context.ownerRef, String(context.accountRef), context.subjectRef,
        context.ownerEpoch, context.runEpoch, context.connectionEpoch, decoded.source.requestSequence, decoded.source.method,
        decoded.source.operationId, valueJson, decoded.fingerprint, decoded.source.receivedDeviceMs, decoded.source.receivedMonotonicMs, nowIso());
      run(`INSERT INTO backend_waterwheel_heads(owner_ref,account_ref,subject_ref,owner_epoch,run_epoch,connection_epoch,response_ref,source_method,
        request_sequence,value_json,value_fingerprint,received_device_ms,received_monotonic_ms,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(owner_ref,subject_ref) DO UPDATE SET account_ref=excluded.account_ref,owner_epoch=excluded.owner_epoch,run_epoch=excluded.run_epoch,
        connection_epoch=excluded.connection_epoch,response_ref=excluded.response_ref,source_method=excluded.source_method,
        request_sequence=excluded.request_sequence,value_json=excluded.value_json,
        value_fingerprint=excluded.value_fingerprint,received_device_ms=excluded.received_device_ms,
        received_monotonic_ms=excluded.received_monotonic_ms,updated_at=excluded.updated_at`, context.ownerRef, String(context.accountRef),
        context.subjectRef, context.ownerEpoch, context.runEpoch, context.connectionEpoch, decoded.source.responseRef,
        decoded.source.method, decoded.source.requestSequence, valueJson,
        decoded.fingerprint, decoded.source.receivedDeviceMs, decoded.source.receivedMonotonicMs, nowIso());
    });
    return { accepted: true, changed: newer && (!before || before.value_fingerprint !== decoded.fingerprint), responseRef: decoded.source.responseRef };
  }
  function read(context) {
    if (!context || !isCurrent(context)) return { current: false, reasonCode: 'WATERWHEEL_CONTEXT_STALE', value: null };
    const row = get('SELECT * FROM backend_waterwheel_heads WHERE owner_ref=? AND subject_ref=?', context.ownerRef, context.subjectRef);
    if (!row || row.owner_epoch !== context.ownerEpoch || row.run_epoch !== context.runEpoch || row.connection_epoch !== context.connectionEpoch ||
        Number(process.hrtime.bigint()) / 1_000_000 - row.received_monotonic_ms > 120000) return { current: false, reasonCode: 'WATERWHEEL_FACTS_NOT_CURRENT', value: null };
    let value;
    try { value = JSON.parse(row.value_json); } catch { return { current: false, reasonCode: 'WATERWHEEL_FACTS_INVALID', value: null }; }
    if (fingerprint(value) !== row.value_fingerprint) return { current: false, reasonCode: 'WATERWHEEL_FACTS_INVALID', value: null };
    return freeze({ current: true, value, source: { responseRef: row.response_ref, method: row.source_method,
      connectionEpoch: row.connection_epoch, requestSequence: row.request_sequence, receivedDeviceMs: row.received_device_ms,
      receivedMonotonicMs: row.received_monotonic_ms }, fingerprint: row.value_fingerprint });
  }
  return Object.freeze({ ingest, read });
}
