import { canonical, fingerprint, freeze, plainObject, problem } from '../../common.mjs';
import { officialDateMs } from '../land/wire-facts.mjs';

const METHODS = new Set(['index.login','flowerRack.unlockStand','flowerRack.sell','flowerRack.recvSellMoney','flowerRack.cancelSell']);
const read = (row, name, index) => Object.hasOwn(row, name) ? row[name] : row[index];

export function decodeFlowerRackObservation(observation, expectedUid) {
  if (!observation || observation.source !== 'response' || observation.transport !== 'answered' || observation.envelopeOk !== true ||
      observation.dsName !== 'G.ISyncData' || !METHODS.has(observation.method) || !Number.isSafeInteger(expectedUid) || expectedUid <= 0) return null;
  const sync = observation.value, raw = plainObject(sync) ? (sync['104'] ?? sync.flowerRack) : null;
  if (raw === undefined) return { uid: expectedUid, map: null, supplied: false };
  if (!plainObject(raw)) return null;
  // IFlowerRackTot is sparse {flowerRackMap:'0:{rackId:IFlowerRack}'}. UID lives
  // on each actual member, never on the total object or as map key completeness.
  const map = read(raw, 'flowerRackMap', '0');
  if (map !== undefined && map !== null && !plainObject(map) && !Array.isArray(map)) return null;
  let members = null;
  if (map !== undefined && map !== null) {
    const entries = Array.isArray(map) ? map.map((value, index) => [String(index), value]) : Object.entries(map);
    if (entries.length > 256) return null;
    members = {};
    for (const [key, value] of entries) {
      if (!/^[0-9]{1,6}$/.test(key) || !plainObject(value)) return null;
      const one = { uid: read(value, 'uid', '0'), rackId: read(value, 'rackId', '1') };
      if (![one.uid, one.rackId].every(number => Number.isSafeInteger(number) && number > 0) || one.uid !== expectedUid) return null;
      const iid = read(value, 'iid', '2'), num = read(value, 'num', '3');
      // An actual member with no iid is an empty rack slot in the official
      // consumer. Keep absence/null distinct; never manufacture a member for
      // a missing rackMap key.
      if (iid !== undefined) {
        if (iid !== null && (!Number.isSafeInteger(iid) || iid < 0)) return null;
        one.iid = iid;
      }
      if (num !== undefined) {
        if (num !== null && (!Number.isSafeInteger(num) || num < 0)) return null;
        one.num = num;
      }
      if (one.iid > 0 && (!Number.isSafeInteger(one.num) || one.num <= 0)) return null;
      for (const [name, index] of [['sellStartTime','4'],['uTime','5'],['cTime','6']]) {
        const rawTime = read(value, name, index);
        if (rawTime === undefined) continue;
        if (rawTime === null) one[name] = null;
        else { const ms = officialDateMs(rawTime); if (ms === null) return null; one[name] = ms; }
      }
      members[key] = one;
    }
  }
  return { uid: expectedUid, map: members, supplied: true };
}

export function createFlowerRackFacts({ store, isCurrent, officialUidForContext } = {}) {
  for (const fn of [store?.run,store?.get,store?.all,store?.transaction,isCurrent,officialUidForContext]) if (typeof fn !== 'function')
    throw new TypeError('Flower-rack facts require bounded shared ports');
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_flower_rack_receipts(
    response_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,request_sequence INTEGER NOT NULL,
    method TEXT NOT NULL,value_json TEXT NOT NULL,value_fingerprint TEXT NOT NULL,received_device_ms INTEGER NOT NULL,
    received_monotonic_ms REAL NOT NULL,recorded_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS backend_flower_rack_receipts_no_update BEFORE UPDATE ON backend_flower_rack_receipts
      BEGIN SELECT RAISE(ABORT,'flower-rack receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_flower_rack_receipts_no_delete BEFORE DELETE ON backend_flower_rack_receipts
      BEGIN SELECT RAISE(ABORT,'flower-rack receipts are append only'); END;
    CREATE TABLE IF NOT EXISTS backend_flower_rack_heads(
      owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,
      connection_epoch INTEGER NOT NULL,response_ref TEXT NOT NULL REFERENCES backend_flower_rack_receipts(response_ref),
      source_method TEXT NOT NULL,request_sequence INTEGER NOT NULL,value_json TEXT NOT NULL,value_fingerprint TEXT NOT NULL,
      received_device_ms INTEGER NOT NULL,received_monotonic_ms REAL NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY(owner_ref,subject_ref));`);
  const { run, get, transaction, nowIso } = store;
  function ingest({ context, observation } = {}) {
    const uid = context && isCurrent(context) ? officialUidForContext(context) : null;
    const decoded = decodeFlowerRackObservation(observation, uid);
    if (!decoded || !context || !isCurrent(context) || decoded.supplied !== true || !decoded.map ||
        observation.connectionEpoch !== context.connectionEpoch || !Number.isSafeInteger(observation.requestSequence) || observation.requestSequence <= 0 ||
        typeof observation.responseRef !== 'string' || !Number.isSafeInteger(observation.receivedDeviceMs) || !Number.isFinite(observation.receivedMonotonicMs))
      return { accepted: false, changed: false, reasonCode: decoded?.supplied === false ? 'FLOWER_RACK_SOURCE_NOT_SUPPLIED' : 'FLOWER_RACK_SOURCE_NOT_CURRENT' };
    const payload = { uid: decoded.uid, map: decoded.map }, fp = fingerprint(payload), prior = get('SELECT * FROM backend_flower_rack_receipts WHERE response_ref=?', observation.responseRef);
    if (prior && (prior.owner_ref !== context.ownerRef || prior.account_ref !== String(context.accountRef) || prior.subject_ref !== context.subjectRef ||
        prior.connection_epoch !== context.connectionEpoch || prior.request_sequence !== observation.requestSequence || prior.value_fingerprint !== fp || prior.method !== observation.method))
      throw problem('FLOWER_RACK_RECEIPT_CONFLICT', '同一花架响应引用对应不同的原始状态', 409);
    const before = get('SELECT * FROM backend_flower_rack_heads WHERE owner_ref=? AND account_ref=? AND subject_ref=?', context.ownerRef, String(context.accountRef), context.subjectRef);
    const newer = !before || before.connection_epoch < context.connectionEpoch || before.connection_epoch === context.connectionEpoch && before.request_sequence < observation.requestSequence;
    if (newer) transaction(() => {
      run(`INSERT OR IGNORE INTO backend_flower_rack_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, observation.responseRef, context.ownerRef,
        String(context.accountRef), context.subjectRef, context.ownerEpoch, context.runEpoch, context.connectionEpoch, observation.requestSequence,
        observation.method, canonical(payload), fp, observation.receivedDeviceMs, observation.receivedMonotonicMs, nowIso());
      run(`INSERT INTO backend_flower_rack_heads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref) DO UPDATE SET
        account_ref=excluded.account_ref,owner_epoch=excluded.owner_epoch,run_epoch=excluded.run_epoch,connection_epoch=excluded.connection_epoch,
        response_ref=excluded.response_ref,source_method=excluded.source_method,request_sequence=excluded.request_sequence,value_json=excluded.value_json,
        value_fingerprint=excluded.value_fingerprint,received_device_ms=excluded.received_device_ms,received_monotonic_ms=excluded.received_monotonic_ms,
        updated_at=excluded.updated_at`, context.ownerRef, String(context.accountRef), context.subjectRef, context.ownerEpoch, context.runEpoch,
        context.connectionEpoch, observation.responseRef, observation.method, observation.requestSequence, canonical(payload), fp,
        observation.receivedDeviceMs, observation.receivedMonotonicMs, nowIso());
    });
    return { accepted: true, changed: newer && (!before || before.value_fingerprint !== fp), responseRef: observation.responseRef };
  }
  function read(context) {
    if (!context || !isCurrent(context)) return { current: false, value: null, reasonCode: 'FLOWER_RACK_CONTEXT_STALE' };
    const row = get('SELECT * FROM backend_flower_rack_heads WHERE owner_ref=? AND account_ref=? AND subject_ref=?', context.ownerRef, String(context.accountRef), context.subjectRef);
    if (!row || row.owner_epoch !== context.ownerEpoch || row.run_epoch !== context.runEpoch || row.connection_epoch !== context.connectionEpoch ||
        Number(process.hrtime.bigint()) / 1e6 - row.received_monotonic_ms > 120000) return { current: false, value: null, reasonCode: 'FLOWER_RACK_FACTS_NOT_CURRENT' };
    let value; try { value = JSON.parse(row.value_json); } catch { return { current: false, value: null, reasonCode: 'FLOWER_RACK_FACTS_INVALID' }; }
    if (fingerprint(value) !== row.value_fingerprint) return { current: false, value: null, reasonCode: 'FLOWER_RACK_FACTS_INVALID' };
    return freeze({ current: true, value, fingerprint: row.value_fingerprint, source: { responseRef: row.response_ref, method: row.source_method,
      requestSequence: row.request_sequence, connectionEpoch: row.connection_epoch, receivedDeviceMs: row.received_device_ms,
      receivedMonotonicMs: row.received_monotonic_ms } });
  }
  function readHistoricalReceipt({ ownerRef, accountRef, subjectRef, ownerEpoch, runEpoch, connectionEpoch, requestSequence,
    responseRef, officialUid } = {}) {
    if (typeof ownerRef !== 'string' || !ownerRef || typeof accountRef !== 'string' || !accountRef ||
        typeof subjectRef !== 'string' || !subjectRef || ![ownerEpoch, runEpoch, connectionEpoch, requestSequence, officialUid]
          .every(value => Number.isSafeInteger(value) && value > 0) || typeof responseRef !== 'string' || !responseRef || responseRef.length > 512)
      return { current: false, value: null, reasonCode: 'FLOWER_RACK_HISTORICAL_RECEIPT_INPUT_INVALID' };
    const row = get('SELECT * FROM backend_flower_rack_receipts WHERE response_ref=?', responseRef);
    if (!row) return { current: false, value: null, reasonCode: 'FLOWER_RACK_HISTORICAL_RECEIPT_NOT_FOUND' };
    if (row.owner_ref !== ownerRef || row.account_ref !== accountRef || row.subject_ref !== subjectRef || row.owner_epoch !== ownerEpoch ||
        row.run_epoch !== runEpoch || row.connection_epoch !== connectionEpoch || row.request_sequence !== requestSequence)
      return { current: false, value: null, reasonCode: 'FLOWER_RACK_HISTORICAL_RECEIPT_CONTEXT_CONFLICT' };
    let value;
    try { value = JSON.parse(row.value_json); } catch { return { current: false, value: null, reasonCode: 'FLOWER_RACK_HISTORICAL_RECEIPT_INVALID' }; }
    if (fingerprint(value) !== row.value_fingerprint || value?.uid !== officialUid || !plainObject(value?.map) ||
        !Number.isSafeInteger(row.received_device_ms) || row.received_device_ms <= 0 ||
        !Number.isFinite(row.received_monotonic_ms) || row.received_monotonic_ms < 0)
      return { current: false, value: null, reasonCode: 'FLOWER_RACK_HISTORICAL_RECEIPT_INVALID' };
    const decoded = decodeFlowerRackObservation({ source: 'response', transport: 'answered', envelopeOk: true, dsName: 'G.ISyncData',
      method: row.method, responseRef: row.response_ref, requestSequence: row.request_sequence, connectionEpoch: row.connection_epoch,
      value: { '104': { flowerRackMap: value.map } } }, officialUid);
    if (!decoded || decoded.supplied !== true || canonical({ uid: decoded.uid, map: decoded.map }) !== canonical(value))
      return { current: false, value: null, reasonCode: 'FLOWER_RACK_HISTORICAL_RECEIPT_INVALID' };
    return freeze({ current: false, value, fingerprint: row.value_fingerprint, source: { responseRef: row.response_ref, method: row.method,
      ownerEpoch: row.owner_epoch, runEpoch: row.run_epoch, connectionEpoch: row.connection_epoch, requestSequence: row.request_sequence,
      receivedDeviceMs: row.received_device_ms, receivedMonotonicMs: row.received_monotonic_ms } });
  }
  return Object.freeze({ ingest, read, readHistoricalReceipt });
}
