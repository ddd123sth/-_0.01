import { canonical, fingerprint, freeze, plainObject, problem } from '../../common.mjs';
import { officialDateMs } from '../land/wire-facts.mjs';

const METHODS = new Set(['index.login', 'freeWater.recv', 'usr.share']);
function decode(observation, expectedUid) {
  if (!observation || observation.source !== 'response' || observation.transport !== 'answered' || observation.envelopeOk !== true ||
      observation.dsName !== 'G.ISyncData' || !METHODS.has(observation.method) || !Number.isSafeInteger(expectedUid) || expectedUid <= 0) return null;
  const sync = observation.value, raw = plainObject(sync) ? (sync['117'] ?? sync.freeWater) : null;
  let water = null;
  if (raw !== undefined) {
    if (!plainObject(raw)) return null;
    const read = (name, index) => Object.hasOwn(raw, name) ? raw[name] : raw[index];
    const uid = read('uid', '0'), recvIdx = read('recvIdx', '1');
    if (!Number.isSafeInteger(uid) || uid <= 0 || uid !== expectedUid || !Array.isArray(recvIdx) || recvIdx.length > 2 ||
        new Set(recvIdx).size !== recvIdx.length || recvIdx.some(idx => !Number.isSafeInteger(idx) || idx < 0 || idx > 1)) return null;
    water = { uid, recvIdx: [...recvIdx] };
    for (const [name, index] of [['rTime','2'],['uTime','3'],['cTime','4']]) {
      const value = read(name, index);
      if (value === undefined) continue;
      if (value === null) water[name] = null;
      else { const ms = officialDateMs(value); if (ms === null) return null; water[name] = ms; }
    }
  }
  const shareTotal = plainObject(sync) ? (sync['31'] ?? sync.shareTot) : null;
  const shareMap = plainObject(shareTotal) ? (shareTotal.map ?? shareTotal['0'] ?? null) : null;
  let share13 = null;
  if (plainObject(shareMap) && plainObject(shareMap['13'])) {
    const row = shareMap['13'], get = (name, index) => Object.hasOwn(row, name) ? row[name] : row[index];
    const uid = get('uid','0'), tmpId = get('tmpId','1'), recvCnt = get('recvCnt','3'), uTimeRaw = get('uTime','6');
    const uTime = uTimeRaw === null ? null : officialDateMs(uTimeRaw);
    const shareCnt = get('shareCnt','2');
    if (Number.isSafeInteger(uid) && uid > 0 && uid === expectedUid && tmpId === 13 && Number.isSafeInteger(recvCnt) && recvCnt >= 0 &&
        uTime !== null && (shareCnt === undefined || Number.isSafeInteger(shareCnt) && shareCnt >= 0))
      share13 = { uid, tmpId, recvCnt, uTime, ...(shareCnt === undefined ? {} : { shareCnt }) };
  }
  if (!water && !share13 && !['freeWater.recv', 'usr.share'].includes(observation.method)) return null;
  const value = { water, share13, share13MapPresent: plainObject(shareMap) };
  return { value, valueFingerprint: fingerprint(value), source: { method: observation.method, responseRef: observation.responseRef,
    requestSequence: observation.requestSequence, wireKey: observation.wireKey, connectionEpoch: observation.connectionEpoch,
    receivedDeviceMs: observation.receivedDeviceMs, receivedMonotonicMs: observation.receivedMonotonicMs,
    operationId: observation.operationId ?? null } };
}

export function createFreeWaterFacts({ store, isCurrent, officialUidForContext } = {}) {
  const { run, get, transaction, nowIso } = store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_free_water_receipts(
    response_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,request_sequence INTEGER NOT NULL,
    method TEXT NOT NULL,operation_id TEXT,value_json TEXT NOT NULL,value_fingerprint TEXT NOT NULL,received_device_ms INTEGER NOT NULL,
    received_monotonic_ms REAL NOT NULL,recorded_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS backend_free_water_receipts_no_update BEFORE UPDATE ON backend_free_water_receipts
      BEGIN SELECT RAISE(ABORT,'free-water receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_free_water_receipts_no_delete BEFORE DELETE ON backend_free_water_receipts
      BEGIN SELECT RAISE(ABORT,'free-water receipts are append only'); END;
    CREATE TABLE IF NOT EXISTS backend_free_water_heads(
      owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,
      connection_epoch INTEGER NOT NULL,response_ref TEXT NOT NULL REFERENCES backend_free_water_receipts(response_ref),
      source_method TEXT NOT NULL,request_sequence INTEGER NOT NULL,value_json TEXT NOT NULL,value_fingerprint TEXT NOT NULL,
      received_device_ms INTEGER NOT NULL,received_monotonic_ms REAL NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref));`);
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_free_water_domain_heads(
    owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,domain_key TEXT NOT NULL CHECK(domain_key IN ('water','share13')),
    owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,response_ref TEXT NOT NULL REFERENCES backend_free_water_receipts(response_ref),
    source_method TEXT NOT NULL,request_sequence INTEGER NOT NULL,value_json TEXT NOT NULL,value_fingerprint TEXT NOT NULL,
    received_device_ms INTEGER NOT NULL,received_monotonic_ms REAL NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref,domain_key));`);
  store.db.exec(`CREATE TRIGGER IF NOT EXISTS backend_free_water_domain_heads_no_delete BEFORE DELETE ON backend_free_water_domain_heads
    BEGIN SELECT RAISE(ABORT,'free-water domain heads are retained'); END;`);
  function ingest({ context, observation } = {}) {
    const decoded = decode(observation, officialUidForContext?.(context));
    const src = decoded?.source;
    if (!decoded || !context || !isCurrent(context) || src.connectionEpoch !== context.connectionEpoch ||
        !Number.isSafeInteger(src.requestSequence) || src.requestSequence <= 0 || typeof src.responseRef !== 'string' ||
        !Number.isSafeInteger(src.receivedDeviceMs) || !Number.isFinite(src.receivedMonotonicMs))
      return { accepted: false, changed: false, reasonCode: 'FREE_WATER_SOURCE_NOT_CURRENT' };
    const valueJson = canonical(decoded.value), prior = get('SELECT * FROM backend_free_water_receipts WHERE response_ref=?', src.responseRef);
    if (prior && (prior.owner_ref !== context.ownerRef || prior.account_ref !== String(context.accountRef) || prior.subject_ref !== context.subjectRef ||
        prior.owner_epoch !== context.ownerEpoch || prior.run_epoch !== context.runEpoch || prior.value_fingerprint !== decoded.valueFingerprint ||
        prior.connection_epoch !== context.connectionEpoch || prior.request_sequence !== src.requestSequence || prior.method !== src.method))
      throw problem('FREE_WATER_RECEIPT_CONFLICT', '同一水滴回包引用对应了不同事实', 409);
    const before = get('SELECT * FROM backend_free_water_heads WHERE owner_ref=? AND subject_ref=?', context.ownerRef, context.subjectRef);
    const newer = !before || before.account_ref !== String(context.accountRef) || before.owner_epoch !== context.ownerEpoch || before.run_epoch !== context.runEpoch ||
      before.connection_epoch < context.connectionEpoch || before.connection_epoch === context.connectionEpoch && before.request_sequence < src.requestSequence;
    transaction(() => {
      run(`INSERT OR IGNORE INTO backend_free_water_receipts(response_ref,owner_ref,account_ref,subject_ref,owner_epoch,run_epoch,connection_epoch,
        request_sequence,method,operation_id,value_json,value_fingerprint,received_device_ms,received_monotonic_ms,recorded_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, src.responseRef, context.ownerRef, String(context.accountRef), context.subjectRef, context.ownerEpoch,
        context.runEpoch, context.connectionEpoch, src.requestSequence, src.method, src.operationId, valueJson, decoded.valueFingerprint,
        src.receivedDeviceMs, src.receivedMonotonicMs, nowIso());
      if (newer) run(`INSERT INTO backend_free_water_heads(owner_ref,account_ref,subject_ref,owner_epoch,run_epoch,connection_epoch,response_ref,source_method,
        request_sequence,value_json,value_fingerprint,received_device_ms,received_monotonic_ms,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(owner_ref,subject_ref) DO UPDATE SET account_ref=excluded.account_ref,owner_epoch=excluded.owner_epoch,run_epoch=excluded.run_epoch,
        connection_epoch=excluded.connection_epoch,response_ref=excluded.response_ref,source_method=excluded.source_method,request_sequence=excluded.request_sequence,
        value_json=excluded.value_json,value_fingerprint=excluded.value_fingerprint,received_device_ms=excluded.received_device_ms,
        received_monotonic_ms=excluded.received_monotonic_ms,updated_at=excluded.updated_at`, context.ownerRef, String(context.accountRef), context.subjectRef,
        context.ownerEpoch, context.runEpoch, context.connectionEpoch, src.responseRef, src.method, src.requestSequence, valueJson,
        decoded.valueFingerprint, src.receivedDeviceMs, src.receivedMonotonicMs, nowIso());
      for (const [domainKey, domainValue] of [['water', decoded.value.water], ['share13', decoded.value.share13]]) {
        if (!domainValue) continue;
        const oldDomain = get('SELECT account_ref,owner_epoch,run_epoch,connection_epoch,request_sequence FROM backend_free_water_domain_heads WHERE owner_ref=? AND subject_ref=? AND domain_key=?',
          context.ownerRef, context.subjectRef, domainKey);
        const domainNewer = !oldDomain || oldDomain.account_ref !== String(context.accountRef) || oldDomain.owner_epoch !== context.ownerEpoch ||
          oldDomain.run_epoch !== context.runEpoch || oldDomain.connection_epoch < context.connectionEpoch ||
          oldDomain.connection_epoch === context.connectionEpoch && oldDomain.request_sequence < src.requestSequence;
        if (!domainNewer) continue;
        const domainJson = canonical(domainValue), domainFingerprint = fingerprint(domainValue);
        run(`INSERT INTO backend_free_water_domain_heads(owner_ref,account_ref,subject_ref,domain_key,owner_epoch,run_epoch,connection_epoch,response_ref,
          source_method,request_sequence,value_json,value_fingerprint,received_device_ms,received_monotonic_ms,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(owner_ref,subject_ref,domain_key) DO UPDATE SET account_ref=excluded.account_ref,owner_epoch=excluded.owner_epoch,run_epoch=excluded.run_epoch,
          connection_epoch=excluded.connection_epoch,response_ref=excluded.response_ref,source_method=excluded.source_method,request_sequence=excluded.request_sequence,
          value_json=excluded.value_json,value_fingerprint=excluded.value_fingerprint,received_device_ms=excluded.received_device_ms,
          received_monotonic_ms=excluded.received_monotonic_ms,updated_at=excluded.updated_at`, context.ownerRef, String(context.accountRef), context.subjectRef,
          domainKey, context.ownerEpoch, context.runEpoch, context.connectionEpoch, src.responseRef, src.method, src.requestSequence, domainJson,
          domainFingerprint, src.receivedDeviceMs, src.receivedMonotonicMs, nowIso());
      }
    });
    return { accepted: true, changed: newer && (!before || before.value_fingerprint !== decoded.valueFingerprint), responseRef: src.responseRef };
  }
  function read(context) {
    if (!context || !isCurrent(context)) return { current: false, reasonCode: 'FREE_WATER_CONTEXT_STALE', value: null };
    const rows = store.all('SELECT * FROM backend_free_water_domain_heads WHERE owner_ref=? AND subject_ref=? ORDER BY domain_key', context.ownerRef, context.subjectRef);
    const result = { water: null, share13: null }, sources = {};
    for (const row of rows) {
      if (row.account_ref !== String(context.accountRef) || row.owner_epoch !== context.ownerEpoch || row.run_epoch !== context.runEpoch || row.connection_epoch !== context.connectionEpoch ||
          Number(process.hrtime.bigint()) / 1_000_000 - row.received_monotonic_ms > 120000) continue;
      let value; try { value = JSON.parse(row.value_json); } catch { return { current: false, reasonCode: 'FREE_WATER_FACTS_INVALID', value: null }; }
      if (fingerprint(value) !== row.value_fingerprint) return { current: false, reasonCode: 'FREE_WATER_FACTS_INVALID', value: null };
      result[row.domain_key] = value;
      sources[row.domain_key] = { responseRef: row.response_ref, method: row.source_method, connectionEpoch: row.connection_epoch,
        requestSequence: row.request_sequence, receivedDeviceMs: row.received_device_ms, receivedMonotonicMs: row.received_monotonic_ms };
    }
    if (!sources.water && !sources.share13) return { current: false, reasonCode: 'FREE_WATER_FACTS_NOT_CURRENT', value: null };
    return freeze({ current: true, value: result, sources, source: sources.water || sources.share13,
      fingerprint: fingerprint({ value: result, sources }) });
  }
  return Object.freeze({ ingest, read });
}
