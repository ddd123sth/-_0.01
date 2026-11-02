import { clone, fingerprint, freeze, plainObject } from '../../common.mjs';
import { ORDER_FLOWER_LEVEL_REWARD_ITEM_IDS } from './level-catalog.mjs';
import { orderFlowerBranchCellShape } from './branch-shape.mjs';
import { NORMAL_SYNC_METHODS } from '../../facts/normal-sync-contract.mjs';
import { officialActionContractId } from '../../official-version-profile.mjs';
import { verifyOfficialServerVersionFrame } from '../../official-server-version-contract.mjs';

export const ORDER_FLOWER_DECODE_VERSION = 'official-order-flower/480.0.27/readonly-v4';
export const ORDER_FLOWER_BUTLER_TYPES = Object.freeze([1, 2, 3, 4, 5]);
export const ORDER_FLOWER_BUTLER_FIELDS = Object.freeze(['domain', 'uid', 'type', 'status', 'buyPeriodMap', 'needSettle', 'uTime', 'cTime']);
export const ORDER_FLOWER_AXES = Object.freeze(['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch']);
export const ORDER_FLOWER_FIELDS = Object.freeze(['uid', 'residentMap', 'satin', 'decorate', 'stockMap', 'tdyMap', 'recvIds', 'recvTime', 'uTime', 'cTime', 'rTime']);
export const ORDER_FLOWER_OPEN_IDS = Object.freeze(['sys_orderFlower', 'sys_orderSatins', 'sys_orderDecorate',
  'share_Order', 'share_orderSatins', 'share_orderDecorate', 'butler']);
export const ORDER_FLOWER_ELIGIBILITY_FIELDS = Object.freeze({ profile: ['domain', 'uid', 'level', 'vip', 'chnId', 'loginChnId'],
  mainTask: ['domain', 'uid', 'curTaskId'], cultivated: ['domain', 'map'],
  fashionHistory: ['map', 'domain', 'uid', 'type', 'valueMap'], serverOpenMap: ['map', ...ORDER_FLOWER_OPEN_IDS] });
const INPUT_METHODS = new Set(NORMAL_SYNC_METHODS);
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const ACTION_FOR_KIND = Object.freeze({ resident: 'order.resident', satin: 'order.satin', decorate: 'order.decorate' });
export function orderFlowerSourceProofValid(version, kind = null) {
  if (version?.gameVersion === '480.0.27' && version?.protocolVersion === '480.0.0') return true;
  const actions = kind ? [ACTION_FOR_KIND[kind]] : Object.values(ACTION_FOR_KIND);
  return actions.some(action => {
    const proof = version?.sourceProofs?.[action];
    return proof?.supported === true && proof.sourceVersion === version.gameVersion && proof.protocolVersion === version.protocolVersion &&
      proof.actionContractId === officialActionContractId(action) && /^[a-f0-9]{64}$/.test(proof.gameSha256 || '') &&
      /^[a-f0-9]{64}$/.test(proof.moSha256 || '');
  });
}
export function orderFlowerContext(value) {
  if (!value || !reference(value.ownerRef) || !reference(value.subjectRef) || !ORDER_FLOWER_AXES.slice(3).every(key => positive(value[key]))) return null;
  const accountRef = positive(value.accountRef) ? String(value.accountRef) : value.accountRef;
  return reference(accountRef) ? Object.fromEntries(ORDER_FLOWER_AXES.map(key => [key, key === 'accountRef' ? accountRef : value[key]])) : null;
}
export const orderFlowerContextKey = context => fingerprint(ORDER_FLOWER_AXES.map(key => context[key]));
export const sameOrderFlowerContext = (a, b) => !!a && !!b && ORDER_FLOWER_AXES.every(key => a[key] === b[key]);
export const knownOrderFlowerCell = cell => cell?.presence === 'present' && cell.state === 'known';
export const missingOrderFlowerCell = () => ({ presence: 'missing', state: 'unobserved', value: null, reasonCode: 'FIELD_NOT_SUPPLIED' });
const boolLike = value => typeof value === 'boolean' || value === 0 || value === 1;
function at(raw, path) {
  let value = raw;
  for (const key of path) { if (!plainObject(value) || !Object.hasOwn(value, key)) return { present: false }; value = value[key]; }
  return { present: true, value };
}
function dateMs(value) {
  if (positive(value) && value <= 8640000000000000) return value;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const ms = Date.parse(value);
  return positive(ms) && [value, value.replace('Z', '.000Z')].includes(new Date(ms).toISOString()) ? ms : null;
}
function cell(entry, predicate, project = clone) {
  if (!entry.present) return missingOrderFlowerCell();
  if (entry.value === null) return { presence: 'null', state: 'unreadable', value: null, reasonCode: 'EXPLICIT_NULL' };
  if (!predicate(entry.value)) return { presence: 'present', state: 'unreadable', value: null, reasonCode: 'WIRE_FIELD_INVALID', rawType: Array.isArray(entry.value) ? 'array' : typeof entry.value };
  return { presence: 'present', state: 'known', value: project(entry.value), reasonCode: null };
}
const num = (raw, path, predicate = nonnegative) => cell(at(raw, path), predicate);
const date = (raw, path) => cell(at(raw, path), value => dateMs(value) !== null, dateMs);
const container = (raw, path) => cell(at(raw, path), plainObject, () => null);
const numericMap = value => plainObject(value) && Object.keys(value).length <= 4096 &&
  Object.entries(value).every(([key, amount]) => /^[1-9]\d*$/.test(key) && positive(Number(key)) && nonnegative(amount));
const mapPresence = (raw, path) => cell(at(raw, path), value => plainObject(value) && Object.keys(value).length <= 4096,
  value => ({ total: Object.keys(value).length, reportedEmpty: Object.keys(value).length === 0 }));
function orderRow(entry, kind, boxId) {
  const raw = plainObject(entry.value) ? entry.value : {}, resident = kind === 'resident';
  const fields = { npcId: num(raw, [resident ? '0' : '1']), dialogId: num(raw, [resident ? '1' : '2']),
    flowers: cell(at(raw, [resident ? '2' : '0']), value => Array.isArray(value) && value.length <= 16 && value.every(pair =>
      Array.isArray(pair) && pair.length === 2 && positive(pair[0]) && positive(pair[1]))),
    isVideo: cell(at(raw, [resident ? '3' : '4']), boolLike), cdTime: date(raw, [resident ? '4' : '6']), cTime: date(raw, [resident ? '5' : '7']),
    videoRwd: cell(at(raw, [resident ? '7' : '5']), numericMap),
    ...(resident ? { placeIdx: num(raw, ['6']) } : { finishCnt: num(raw, ['3']) }) };
  const body = { kind, boxId, fields };
  return { ...cell(entry, plainObject, () => body), readable: entry.present && plainObject(entry.value) &&
    orderFlowerBranchCellShape(kind, boxId, fields), contentFingerprint: fingerprint(body),
    fingerprintKind: 'content-not-occurrence-or-lifecycle' };
}
function residentMap(raw) {
  const entry = at(raw, ['105', '0', '1']);
  if (!entry.present || !plainObject(entry.value)) return cell(entry, () => false);
  const keys = Object.keys(entry.value);
  if (keys.length > 6 || keys.some(key => !/^[1-6]$/.test(key))) return cell(entry, () => false);
  const entries = keys.sort().map(key => orderRow({ present: true, value: entry.value[key] }, 'resident', Number(key)));
  return { presence: 'present', state: 'known', value: { total: keys.length, entries, complete: true,
    decodedComplete: entries.every(row => row.readable), reportedEmpty: keys.length === 0 }, reasonCode: null };
}
function boundedBoxMap(raw, path, stock) {
  const entry = at(raw, path);
  if (!entry.present || !plainObject(entry.value)) return cell(entry, () => false);
  const keys = Object.keys(entry.value);
  if (keys.length > 8 || keys.some(key => !/^[1-8]$/.test(key))) return cell(entry, () => false);
  const entries = keys.sort().map(key => ({ boxId: Number(key), ...(stock ? { domain: container(entry.value, [key]), stockNum: num(entry.value, [key, '0']),
    calcTime: date(entry.value, [key, '1']), maxStockTime: date(entry.value, [key, '2']) } : { count: num(entry.value, [key]) }) }));
  return { presence: 'present', state: 'known', value: { entries, total: keys.length, complete: true, reportedEmpty: keys.length === 0 }, reasonCode: null };
}
function counter(raw, id) {
  const path = ['7', '4', String(id)];
  return { domain: container(raw, path), uid: num(raw, [...path, '0'], positive), type: num(raw, [...path, '1'], value => value === id),
    tdyCnt: num(raw, [...path, '2']), totCnt: num(raw, [...path, '3']), rTime: date(raw, [...path, '4']), uTime: date(raw, [...path, '5']), cTime: date(raw, [...path, '6']) };
}
function share(raw, id) {
  const path = ['31', '0', String(id)];
  return { domain: container(raw, path), uid: num(raw, [...path, '0'], positive), tmpId: num(raw, [...path, '1'], value => value === id),
    shareCnt: num(raw, [...path, '2']), recvCnt: num(raw, [...path, '3']), recvTime: date(raw, [...path, '4']), totCnt: num(raw, [...path, '5']),
    uTime: date(raw, [...path, '6']), cTime: date(raw, [...path, '7']) };
}
function financial(raw) {
  const bag = at(raw, ['7', '0', '32']), valid = bag.present && numericMap(bag.value);
  return { bag: cell(bag, numericMap, value => ({ complete: true, total: Object.keys(value).length, fingerprint: fingerprint(value) })),
    gold: num(raw, ['7', '0', '44']), yb: num(raw, ['7', '0', '41']),
    level: num(raw, ['7', '0', '34'], positive), lvlExp: num(raw, ['7', '0', '35']), vipExp: num(raw, ['7', '0', '37']),
    levelRewardItems: cell(bag, numericMap, value => ORDER_FLOWER_LEVEL_REWARD_ITEM_IDS.map(itemId => ({ itemId, quantity: value[itemId] ?? 0 }))),
    ...Object.fromEntries([1106, 1340].map(id => [id, cell({ present: bag.present, value: valid ? bag.value[id] ?? 0 : undefined }, nonnegative)])) };
}
// ButlerCtrl merges listed setting rows and their provided direct properties
// (G480 481325..481728; mo.OBJ.merge is shallow). A missing type/field is not
// an unhire/disable event. A PROVIDED buyPeriodMap replaces that one property.
function butlerInputs(raw) {
  const path = ['175', '0'];
  return { domain: container(raw, ['175']), settingMap: cell(at(raw, path), value => plainObject(value) && Object.keys(value).length <= 4096 &&
      Object.keys(value).every(key => /^[1-9]\d*$/.test(key) && positive(Number(key))),
    value => ({ total: Object.keys(value).length, listedTypes: ORDER_FLOWER_BUTLER_TYPES.filter(id => Object.hasOwn(value, String(id))),
      semantics: 'listed-setting-rows-shallow-property-merge', missingTypeDoesNotProveAbsent: true })),
    types: Object.fromEntries(ORDER_FLOWER_BUTLER_TYPES.map(id => {
      const row = [...path, String(id)];
      return [id, { domain: container(raw, row), uid: num(raw, [...row, '0'], positive), type: num(raw, [...row, '1'], value => value === id),
        status: num(raw, [...row, '2']), buyPeriodMap: cell(at(raw, [...row, '5']), value => plainObject(value) && Object.keys(value).length <= 4096 &&
          Object.entries(value).every(([key, count]) => /^[1-9]\d{0,15}$/.test(key) && positive(Number(key)) && nonnegative(count)),
        value => Object.entries(value).map(([key, quantity]) => ({ beginMs: Number(key), quantity })).sort((a, b) => a.beginMs - b.beginMs)),
        needSettle: cell(at(raw, [...row, '8']), boolLike), uTime: date(raw, [...row, '6']), cTime: date(raw, [...row, '7']) }];
    })) };
}
const scalarId = value => nonnegative(value) || typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value);
function conditionShape(value, depth = 0) {
  if (nonnegative(value) || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 64 && /^(?:\d+|\$mainTask|\$lvl|\$vip|\$cultivatedNum|\$fashionCoinNum|And|Or|and|or|\$and|\$or)$/.test(value);
  return depth < 6 && Array.isArray(value) && value.length <= 64 && value.every(one => conditionShape(one, depth + 1));
}
const OPEN_EXT_KEYS = Object.freeze(['whiteUids', 'blackUids', 'whiteChns', 'blackChns', 'closeChnId', 'duration', 'beginTime', 'endTime']);
function openExt(entry) {
  if (!entry.present) return missingOrderFlowerCell();
  let value = entry.value;
  if (typeof value === 'string') {
    if (value.length > 32768) return { presence: 'present', state: 'unreadable', value: null, reasonCode: 'ORDER_OPEN_EXT_LIMIT' };
    try { value = JSON.parse(value); } catch { return { presence: 'present', state: 'unreadable', value: null, reasonCode: 'ORDER_OPEN_EXT_JSON_INVALID' }; }
  }
  if (value === null) return cell({ present: true, value }, () => false);
  if (!plainObject(value)) return cell({ present: true, value }, () => false);
  const fields = {};
  for (const key of OPEN_EXT_KEYS) fields[key] = cell(at(value, [key]), one => Array.isArray(one) && one.length <= (key === 'duration' ? 2 : 4096) &&
    one.every(key === 'duration' ? item => nonnegative(item) || typeof item === 'string' && /^\d{1,16}$/.test(item)
      : ['beginTime', 'endTime'].includes(key) ? item => nonnegative(item) || typeof item === 'string' && item.length <= 64 && /^[0-9T Z/:.+-]+$/.test(item) : scalarId));
  return { presence: 'present', state: 'known', value: fields, unknownKeyCount: Object.keys(value).filter(key => !OPEN_EXT_KEYS.includes(key)).length,
    reasonCode: null };
}
function openEntry(entry, name) {
  if (!entry.present || !plainObject(entry.value)) return cell(entry, () => false);
  const row = entry.value;
  return { presence: 'present', state: 'known', value: { name: cell(at(row, ['0']), value => value === name),
    level: num(row, ['2']), vip: num(row, ['3']), isOr: cell(at(row, ['4']), boolLike), isCndOr: cell(at(row, ['5']), boolLike),
    conditions: cell(at(row, ['6']), conditionShape), closed: cell(at(row, ['9']), boolLike), ext: openExt(at(row, ['10'])) }, reasonCode: null };
}
function cultivateInputs(raw, uid) {
  const entry = at(raw, ['101', '0']);
  if (!entry.present || !plainObject(entry.value)) return cell(entry, () => false);
  const keys = Object.keys(entry.value);
  if (keys.length > 20000 || keys.some(key => !/^[1-9]\d*$/.test(key) || !positive(Number(key)))) return cell(entry, () => false);
  let matched = 0, unreadable = 0, observedCultivatedNum = 0;
  for (const key of keys) {
    const row = entry.value[key];
    if (!plainObject(row) || !positive(uid) || row['0'] !== uid || row['1'] !== Number(key) || !nonnegative(row['4'])) { unreadable += 1; continue; }
    matched += 1; if (row['4'] === 2) observedCultivatedNum += 1;
  }
  return { presence: 'present', state: 'known', value: { total: keys.length, matchedUidRows: matched, unreadableRows: unreadable,
    observedCultivatedNum, decodedComplete: unreadable === 0, sourceProvidedMap: true, populationComplete: false,
    countRule: 'G480/CultivateMgr.getList(2)/explicit-current-own-rows-lower-bound', countIsLowerBound: true }, reasonCode: null };
}
function fashionValueMap(raw) {
  const entry = at(raw, ['7', '5', '4', '6']);
  return cell(entry, value => plainObject(value) && Object.keys(value).length <= 4096 && Object.entries(value).every(([key, amount]) =>
    /^[A-Za-z0-9._-]{1,64}$/.test(key) && nonnegative(amount)), value => ({ total: Object.keys(value).length,
    has1106: Object.hasOwn(value, '1106'), value1106: Object.hasOwn(value, '1106') ? value['1106'] : null,
    sourceProvidedPropertyComplete: true, mapFingerprint: fingerprint(value) }));
}
function eligibilityInputs(raw, observation) {
  const uid = at(raw, ['7', '0', '0']).value;
  return { profile: { domain: container(raw, ['7', '0']), uid: num(raw, ['7', '0', '0'], positive), level: num(raw, ['7', '0', '34']),
    vip: num(raw, ['7', '0', '36']), chnId: cell(at(raw, ['7', '0', '3']), scalarId), loginChnId: cell(at(raw, ['7', '0', '51']), scalarId) },
  sdkChannel: cell({ present: Object.hasOwn(observation.versionEvidence || {}, 'clientChannel'), value: observation.versionEvidence?.clientChannel }, scalarId),
  mainTask: { domain: container(raw, ['22', '0']), uid: num(raw, ['22', '0', '0'], positive), curTaskId: num(raw, ['22', '0', '1']) },
  cultivated: { domain: container(raw, ['101']), map: cultivateInputs(raw, uid) },
  fashionHistory: { map: mapPresence(raw, ['7', '5']), domain: container(raw, ['7', '5', '4']), uid: num(raw, ['7', '5', '4', '0'], positive),
    type: num(raw, ['7', '5', '4', '1'], value => value === 4), valueMap: fashionValueMap(raw) },
  serverOpenMap: { map: mapPresence(raw, ['7', '9']), ...Object.fromEntries(ORDER_FLOWER_OPEN_IDS.map(name => [name, openEntry(at(raw, ['7', '9', name]), name)])) } };
}
export function decodeOfficialOrderFlowerObservation({ context: supplied, observation } = {}) {
  const context = orderFlowerContext(supplied);
  if (!context || !reference(observation?.responseRef) || observation.connectionEpoch !== context.connectionEpoch) return null;
  const version = observation.versionEvidence, matched = observation.source === 'response' && observation.transport === 'answered' && positive(observation.requestSequence) &&
    typeof observation.wireKey === 'string' && /^ws\|\d+\|[1-9]\d*$/.test(observation.wireKey) && Number(observation.wireKey.split('|').at(-1)) === observation.requestSequence;
  const source = { kind: observation.source === 'response' ? 'response' : observation.source === 'push' ? 'push' : 'late', transport: ['answered', 'push'].includes(observation.transport) ? observation.transport : null,
    method: typeof observation.method === 'string' && /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(observation.method) ? observation.method : null,
    contextKey: orderFlowerContextKey(context), connectionEpoch: context.connectionEpoch, requestSequence: positive(observation.requestSequence) ? observation.requestSequence : null,
    responseRef: observation.responseRef, wireKey: typeof observation.wireKey === 'string' && observation.wireKey.length <= 128 ? observation.wireKey : null,
    receivedDeviceMs: Number.isSafeInteger(observation.receivedDeviceMs) ? observation.receivedDeviceMs : null,
    receivedMonotonicMs: typeof observation.receivedMonotonicMs === 'number' && Number.isFinite(observation.receivedMonotonicMs) ? observation.receivedMonotonicMs : null,
    serverMs: positive(observation.serverMs) ? observation.serverMs : null, serverRespondedMs: positive(observation.serverRespondedMs) ? observation.serverRespondedMs : null,
    version: { source: version?.source === 'normal-package-hop-and-matched-world-login/v1' ? version.source : null,
      gameVersion: typeof version?.gameVersion === 'string' && /^\d+(?:\.\d+){1,5}$/.test(version.gameVersion) ? version.gameVersion : null,
      protocolVersion: version?.protocolVersion === '480.0.0' ? version.protocolVersion : null,
      reportedServerVersion: typeof version?.reportedServerVersion === 'string' ? version.reportedServerVersion : null,
      serverVersionBinding: plainObject(version?.serverVersionBinding) ? version.serverVersionBinding : null,
      profileBinding: plainObject(version?.profileBinding) ? version.profileBinding : null,
      loginResponseRef: reference(version?.loginResponseRef) ? version.loginResponseRef : null,
      dataSnapshotId: version?.dataSnapshotId ?? null,
      sourceDataVersion: version?.sourceDataVersion ?? null, contractId: version?.contractId ?? null,
      dataSchemaContractId: version?.dataSchemaContractId ?? null, tableHashes: plainObject(version?.tableHashes) ? version.tableHashes : null,
      resourceSha256: version?.resourceSha256 ?? null, sourceIndexSha256: version?.sourceIndexSha256 ?? null,
      sourceConfigSha256: version?.sourceConfigSha256 ?? null,
      sourceProofs: plainObject(version?.sourceProofs) ? version.sourceProofs : null } };
  const envelope = observation.envelopeOk === true && observation.dsName === 'G.ISyncData' && plainObject(observation.value), raw = envelope ? observation.value : {};
  const path = ['21', '5', '6'];
  const payload = { financial: financial(raw), butler: butlerInputs(raw), profileUid: num(raw, ['7', '0', '0'], positive), level: num(raw, ['7', '0', '34']), domain: container(raw, ['105', '0']),
    eligibilityInputs: eligibilityInputs(raw, observation),
    fields: { uid: num(raw, ['105', '0', '0'], positive), residentMap: residentMap(raw), satin: orderRow(at(raw, ['105', '0', '6']), 'satin', 7),
      decorate: orderRow(at(raw, ['105', '0', '7']), 'decorate', 8), stockMap: boundedBoxMap(raw, ['105', '0', '8'], true),
      tdyMap: boundedBoxMap(raw, ['105', '0', '9'], false), recvIds: cell(at(raw, ['105', '0', '2']), value => Array.isArray(value) && value.length <= 4096 && value.every(nonnegative)),
      recvTime: date(raw, ['105', '0', '3']), uTime: date(raw, ['105', '0', '4']), cTime: date(raw, ['105', '0', '5']), rTime: date(raw, ['105', '0', '10']) },
    counters: { map: mapPresence(raw, ['7', '4']), ...Object.fromEntries([105, 109, 116].map(id => [id, counter(raw, id)])) },
    shares: { map: mapPresence(raw, ['31', '0']), ...Object.fromEntries([5, 19, 34].map(id => [id, share(raw, id)])) },
    adCard: { map: mapPresence(raw, ['21', '5']), domain: container(raw, path), uid: num(raw, [...path, '0'], positive), type: num(raw, [...path, '1'], value => value === 6),
      isMain: cell(at(raw, [...path, '2']), boolLike), receiveTime: date(raw, [...path, '4']), invalidTime: date(raw, [...path, '5']),
      cTime: date(raw, [...path, '6']), expire: num(raw, [...path, '7']), refundDeductMs: num(raw, [...path, '101']) } };
  const boundUid = payload.profileUid.presence === 'missing' ? source.version.profileBinding?.officialUid : payload.profileUid.value;
  const frameVersionCompatible = observation.protocolVersion == null || observation.protocolVersion === source.version.protocolVersion ||
    verifyOfficialServerVersionFrame({ versionEvidence: source.version, frameProtocolVersion: observation.protocolVersion,
      frameReportedServerVersion: observation.reportedServerVersion ?? observation.protocolVersion,
      context, officialUid: boundUid });
  const reasonCode = !matched ? 'ORDER_FLOWER_UNORDERED_FRAME_AUDIT_ONLY' : !envelope ? 'ORDER_FLOWER_ENVELOPE_UNREADABLE'
    : observation.rejected === true || observation.messagePresent === true && observation.noticeOnly !== true ? 'ORDER_FLOWER_RESPONSE_UNCONFIRMED'
      : !INPUT_METHODS.has(source.method) ? 'ORDER_FLOWER_METHOD_NOT_ADMITTED'
      : source.version.gameVersion === null || source.version.protocolVersion === null || !source.version.source ||
        !orderFlowerSourceProofValid(source.version) || !frameVersionCompatible ? 'ORDER_FLOWER_VERSION_SOURCE_UNPROVEN' : null;
  return freeze({ version: ORDER_FLOWER_DECODE_VERSION, context, source, payload, payloadFingerprint: fingerprint(payload),
    observationRef: 'order-flower-observation:' + fingerprint([context, source.responseRef]), admissible: reasonCode === null, reasonCode });
}
