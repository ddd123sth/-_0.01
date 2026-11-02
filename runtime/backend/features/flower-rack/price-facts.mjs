import { canonical, fingerprint, freeze, plainObject } from '../../common.mjs';
import { officialDateMs } from '../land/wire-facts.mjs';

const axes = ['ownerRef','accountRef','subjectRef','ownerEpoch','runEpoch','connectionEpoch'];
const positive = value => Number.isSafeInteger(value) && value > 0;
const at = (value, key) => value == null ? undefined : value[key];
const field = (value, name, index) => value != null && !Array.isArray(value) && Object.hasOwn(value, name) ? value[name] : at(value, index);
const dateCell = value => value === undefined ? { presence: 'missing', value: null } : value === null
  ? { presence: 'present', value: null } : { presence: officialDateMs(value) === null ? 'unreadable' : 'present', value: officialDateMs(value) };

export function decodeFlowerRackPriceObservation(observation, expectedUid) {
  if (!observation || observation.method !== 'index.login' || observation.source !== 'response' || observation.transport !== 'answered' ||
      observation.envelopeOk !== true || observation.dsName !== 'G.ISyncData' || !positive(expectedUid) || !plainObject(observation.value)) return null;
  const raw = observation.value;
  const cultivateTot = raw['101'], cultivateMap = field(cultivateTot, 'cultivateMap', '0');
  let cultivate = { presence: cultivateTot === null ? 'unreadable' : cultivateMap === undefined ? 'missing' : 'present', entries: null };
  if (cultivateMap !== undefined) {
    if (!plainObject(cultivateMap) && !Array.isArray(cultivateMap)) cultivate.presence = 'unreadable';
    else {
      const entries = Array.isArray(cultivateMap) ? cultivateMap.map((row, index) => [String(index), row]) : Object.entries(cultivateMap);
      if (entries.length > 10000) cultivate.presence = 'unreadable';
      else {
        cultivate.entries = {};
        for (const [key, row] of entries) {
          const uid = at(row,'0'), flowerId = at(row,'1'), slotMap = at(row,'11');
          if (!/^[0-9]{1,8}$/.test(key) || !plainObject(row) && !Array.isArray(row) || !positive(uid) || uid !== expectedUid ||
              !positive(flowerId) || slotMap !== undefined && slotMap !== null && !plainObject(slotMap) && !Array.isArray(slotMap)) {
            cultivate.presence = 'unreadable'; cultivate.entries = null; break;
          }
          const slots = slotMap === undefined || slotMap === null ? {} : slotMap;
          if (Object.keys(slots).length > 64) { cultivate.presence = 'unreadable'; cultivate.entries = null; break; }
          const normalized = {};
          for (const [slotKey, slot] of Object.entries(slots)) {
            if (!/^[1-3]$/.test(slotKey) || !plainObject(slot) && !Array.isArray(slot)) { cultivate.presence = 'unreadable'; cultivate.entries = null; break; }
            const skillId = field(slot,'skillId','1');
            if (skillId !== undefined && skillId !== null && !Number.isSafeInteger(skillId) || skillId < 0) { cultivate.presence = 'unreadable'; cultivate.entries = null; break; }
            normalized[slotKey] = skillId ? { skillId, origin: slotMap == null ? 'official-getter-empty-default' : 'official-row' } : { skillId: null, origin: 'official-row-empty-slot' };
          }
          if (cultivate.presence === 'unreadable') break;
          if (cultivate.entries[String(flowerId)]) { cultivate.presence = 'unreadable'; cultivate.entries = null; break; }
          cultivate.entries[String(flowerId)] = { uid, flowerId, slots: normalized, slotMapPresence: slotMap === undefined ? 'missing' : slotMap === null ? 'null' : 'present' };
        }
      }
    }
  }
  const cardRoot = raw['21'], cardMap = field(cardRoot, 'cardMap', '5'), card = at(cardMap, '6');
  let cardState = { presence: cardRoot === null ? 'unreadable' : cardMap === undefined ? 'missing' : 'present', value: null };
  if (cardRoot !== null && cardMap !== undefined && (!plainObject(cardMap) && !Array.isArray(cardMap))) cardState.presence = 'unreadable';
  else if (card !== undefined) {
    const uid = field(card,'uid','0'), type = field(card,'type','1'), isMain = field(card,'isMain','2');
    const invalidTime = dateCell(field(card,'invalidTime','5'));
    if (!positive(uid) || uid !== expectedUid || type !== undefined && type !== 6 || isMain !== undefined && typeof isMain !== 'boolean' && ![0,1].includes(isMain) ||
        invalidTime.presence === 'unreadable' && !isMain) cardState.presence = 'unreadable';
    else cardState = { presence: 'present', value: { uid, type: 6, isMain: !!isMain, invalidTime } };
  }
  const videoRaw = raw['118'];
  let videoState = { presence: videoRaw === undefined ? 'missing' : 'present', value: null };
  if (videoRaw !== undefined) {
    if (!plainObject(videoRaw) && !Array.isArray(videoRaw)) videoState.presence = 'unreadable';
    else {
      const uid = field(videoRaw,'uid','0'), eTime = dateCell(field(videoRaw,'eTime','2'));
      if (!positive(uid) || uid !== expectedUid || eTime.presence === 'unreadable') videoState.presence = 'unreadable';
      else videoState = { presence: 'present', value: { uid, eTime } };
    }
  }
  return { uid: expectedUid, cultivate, card: cardState, video: videoState };
}

export function createFlowerRackPriceFacts({ store, isCurrent, officialUidForContext } = {}) {
  for (const fn of [store?.run,store?.get,store?.transaction,store?.nowIso,isCurrent,officialUidForContext]) if (typeof fn !== 'function')
    throw new TypeError('Flower-rack price facts require bounded current-source ports');
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_flower_rack_price_receipts(
    response_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,owner_epoch INTEGER NOT NULL,
    run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,request_sequence INTEGER NOT NULL,value_json TEXT NOT NULL,
    value_fingerprint TEXT NOT NULL,received_monotonic_ms REAL NOT NULL,recorded_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS backend_flower_rack_price_receipts_no_update BEFORE UPDATE ON backend_flower_rack_price_receipts
      BEGIN SELECT RAISE(ABORT,'flower-rack price receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_flower_rack_price_receipts_no_delete BEFORE DELETE ON backend_flower_rack_price_receipts
      BEGIN SELECT RAISE(ABORT,'flower-rack price receipts are append only'); END;
    CREATE TABLE IF NOT EXISTS backend_flower_rack_price_heads(owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,account_ref TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,response_ref TEXT NOT NULL REFERENCES backend_flower_rack_price_receipts(response_ref),
      request_sequence INTEGER NOT NULL,value_json TEXT NOT NULL,value_fingerprint TEXT NOT NULL,received_monotonic_ms REAL NOT NULL,
      updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref));`);
  const { run, get, transaction, nowIso } = store;
  function ingest({ context, observation } = {}) {
    const uid = context && isCurrent(context) ? officialUidForContext(context) : null, value = decodeFlowerRackPriceObservation(observation, uid);
    if (!value || !context || !isCurrent(context) || observation.connectionEpoch !== context.connectionEpoch ||
        !Number.isSafeInteger(observation.requestSequence) || observation.requestSequence <= 0 || typeof observation.responseRef !== 'string' ||
        !observation.responseRef || typeof observation.wireKey !== 'string' || !observation.wireKey ||
        !Number.isSafeInteger(observation.receivedDeviceMs) || !Number.isFinite(observation.receivedMonotonicMs))
      return { accepted: false, reasonCode: 'FLOWER_RACK_PRICE_SOURCE_NOT_CURRENT' };
    const axesValue = Object.fromEntries(axes.map(key => [key, key === 'accountRef' ? String(context[key]) : context[key]]));
    const payload = { version: 'flower-rack-price-facts/v1', context: axesValue, source: { method: observation.method,
      connectionEpoch: observation.connectionEpoch, requestSequence: observation.requestSequence, responseRef: observation.responseRef,
      wireKey: observation.wireKey, receivedDeviceMs: observation.receivedDeviceMs }, value };
    const fp = fingerprint(payload), prior = get('SELECT * FROM backend_flower_rack_price_receipts WHERE response_ref=?', observation.responseRef);
    if (prior && (prior.owner_ref !== context.ownerRef || prior.account_ref !== String(context.accountRef) || prior.subject_ref !== context.subjectRef ||
        prior.owner_epoch !== context.ownerEpoch || prior.run_epoch !== context.runEpoch || prior.connection_epoch !== context.connectionEpoch ||
        prior.request_sequence !== observation.requestSequence || prior.value_fingerprint !== fp))
      throw new Error('FLOWER_RACK_PRICE_RECEIPT_CONFLICT');
    const head = get('SELECT * FROM backend_flower_rack_price_heads WHERE owner_ref=? AND subject_ref=?', context.ownerRef, context.subjectRef);
    const newer = !head || head.connection_epoch < context.connectionEpoch || head.connection_epoch === context.connectionEpoch && head.request_sequence < observation.requestSequence;
    if (newer) transaction(() => {
      run('INSERT OR IGNORE INTO backend_flower_rack_price_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', observation.responseRef, context.ownerRef,
        String(context.accountRef), context.subjectRef, context.ownerEpoch, context.runEpoch, context.connectionEpoch, observation.requestSequence,
        canonical(payload), fp, observation.receivedMonotonicMs, nowIso());
      run(`INSERT INTO backend_flower_rack_price_heads(owner_ref,subject_ref,account_ref,owner_epoch,run_epoch,connection_epoch,response_ref,
        request_sequence,value_json,value_fingerprint,received_monotonic_ms,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref) DO UPDATE SET
        account_ref=excluded.account_ref,owner_epoch=excluded.owner_epoch,run_epoch=excluded.run_epoch,connection_epoch=excluded.connection_epoch,
        response_ref=excluded.response_ref,request_sequence=excluded.request_sequence,value_json=excluded.value_json,value_fingerprint=excluded.value_fingerprint,
        received_monotonic_ms=excluded.received_monotonic_ms,updated_at=excluded.updated_at`, context.ownerRef, context.subjectRef, String(context.accountRef),
        context.ownerEpoch, context.runEpoch, context.connectionEpoch, observation.responseRef, observation.requestSequence, canonical(payload), fp,
        observation.receivedMonotonicMs, nowIso());
    });
    return { accepted: true, changed: newer, responseRef: observation.responseRef };
  }
  function read(context) {
    if (!context || !isCurrent(context)) return { current: false, value: null, reasonCode: 'FLOWER_RACK_PRICE_CONTEXT_STALE' };
    const head = get('SELECT * FROM backend_flower_rack_price_heads WHERE owner_ref=? AND account_ref=? AND subject_ref=?', context.ownerRef, String(context.accountRef), context.subjectRef);
    if (!head || head.owner_epoch !== context.ownerEpoch || head.run_epoch !== context.runEpoch || head.connection_epoch !== context.connectionEpoch ||
        Number(process.hrtime.bigint()) / 1e6 - head.received_monotonic_ms > 120000) return { current: false, value: null, reasonCode: 'FLOWER_RACK_PRICE_FACTS_NOT_CURRENT' };
    let payload; try { payload = JSON.parse(head.value_json); } catch { return { current: false, value: null, reasonCode: 'FLOWER_RACK_PRICE_FACTS_INVALID' }; }
    if (fingerprint(payload) !== head.value_fingerprint || canonical(payload.context) !== canonical(Object.fromEntries(axes.map(key => [key, key === 'accountRef' ? String(context[key]) : context[key]]))))
      return { current: false, value: null, reasonCode: 'FLOWER_RACK_PRICE_FACTS_INVALID' };
    return freeze({ current: true, value: payload.value, fingerprint: head.value_fingerprint,
      source: payload.source, responseRef: head.response_ref, ageMs: Math.max(0, Number(process.hrtime.bigint()) / 1e6 - head.received_monotonic_ms) });
  }
  return Object.freeze({ ingest, read });
}
