import { fingerprint, freeze, plainObject } from '../../common.mjs';
import { NORMAL_SYNC_METHODS } from '../../facts/normal-sync-contract.mjs';

export const CUSTOMER_DECODE_VERSION = 'official-customer-wire/480.0.27/readonly-v4';
export const CUSTOMER_COLLECTION_LIMIT = 4096;
export const CUSTOMER_CONTEXT_FIELDS = Object.freeze(['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch']);
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, limit = 512) => typeof value === 'string' && value.length > 0 && value.length <= limit ? value : null;
const versionText = value => typeof value === 'string' && /^[0-9]+(?:\.[0-9]+){1,5}$/.test(value) && value.length <= 64 ? value : null;
const idKey = key => /^[1-9][0-9]*$/.test(key) && positive(Number(key));
export const knownCustomerCell = cell => cell?.presence === 'present' && cell.state === 'known';
export const missingCustomerCell = () => ({ presence: 'missing', state: 'unobserved', value: null, reasonCode: 'FIELD_NOT_SUPPLIED' });

export function customerContext(value) {
  if (!value || !text(value.ownerRef) || !text(value.subjectRef)) return null;
  const accountRef = positive(value.accountRef) ? String(value.accountRef) : value.accountRef;
  if (!text(accountRef) || !CUSTOMER_CONTEXT_FIELDS.slice(3).every(key => positive(value[key]))) return null;
  return Object.fromEntries(CUSTOMER_CONTEXT_FIELDS.map(key => [key, key === 'accountRef' ? accountRef : value[key]]));
}
export const customerContextKey = context => fingerprint(CUSTOMER_CONTEXT_FIELDS.map(key => context[key]));
export const sameCustomerContext = (a, b) => !!a && !!b && CUSTOMER_CONTEXT_FIELDS.every(key => a[key] === b[key]);

function at(root, path) {
  let value = root;
  for (const key of path) {
    if (!plainObject(value) || !Object.hasOwn(value, key)) return { present: false };
    value = value[key];
  }
  return { present: true, value };
}
function containerEntry(root, path) {
  let value = root;
  for (const key of path) {
    if (!plainObject(value)) return { present: true, value };
    if (!Object.hasOwn(value, key)) return { present: false };
    value = value[key];
  }
  return { present: true, value };
}
function containerMember(entry, path) {
  if (!entry?.present) return { present: false };
  if (!plainObject(entry.value)) return { present: true, value: entry.value };
  return at(entry.value, path);
}
function invalid(value, reasonCode = 'CUSTOMER_WIRE_FIELD_INVALID') {
  const out = { presence: value === null ? 'null' : 'present', state: 'unreadable', value: null, reasonCode,
    rawType: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value };
  // Never retain arbitrary strings, objects, or unrecognised property names.
  if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') out.rawValue = value;
  return out;
}
function cell(entry, validate, transform = value => value) {
  if (!entry.present) return missingCustomerCell();
  if (entry.value === null) return invalid(null, 'CUSTOMER_WIRE_EXPLICIT_NULL');
  return validate(entry.value) ? { presence: 'present', state: 'known', value: transform(entry.value), reasonCode: null } : invalid(entry.value);
}
export function customerDateMs(value) {
  if (positive(value)) return value <= 8640000000000000 ? value : null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const ms = Date.parse(value);
  if (!positive(ms)) return null;
  const normal = new Date(ms).toISOString();
  return normal === value || normal.replace('.000Z', 'Z') === value ? ms : null;
}
const numberCell = (entry, predicate = nonnegative) => cell(entry, predicate);
const dateCell = entry => cell(entry, value => customerDateMs(value) !== null, customerDateMs);
function order(value, npcId = null) {
  const object = plainObject(value), fields = {};
  for (const [name, key] of Object.entries({ dialogId: '0', artId: '1', num: '2', pathId: '3', cTime: '4' })) {
    const entry = object ? at(value, [key]) : { present: false };
    fields[name] = name === 'cTime' ? dateCell(entry) : numberCell(entry, ['artId', 'num'].includes(name) ? positive : nonnegative);
  }
  const readable = object && Object.values(fields).every(knownCustomerCell);
  return { npcId, presence: value === null ? 'null' : 'present', state: object ? readable ? 'known' : 'partial' : 'unreadable',
    readable, fields, contentFingerprint: object ? fingerprint({ npcId, fields }) : null,
    fingerprintKind: 'content-only-not-lifecycle', reasonCode: object ? readable ? null : 'CUSTOMER_ORDER_FIELDS_INCOMPLETE' : 'CUSTOMER_ORDER_ROW_INVALID' };
}
function orderMap(entry) {
  if (!entry.present || !plainObject(entry.value)) return cell(entry, () => false);
  const keys = Object.keys(entry.value), total = keys.length;
  if (total > CUSTOMER_COLLECTION_LIMIT || !keys.every(idKey)) return { ...invalid(entry.value,
    total > CUSTOMER_COLLECTION_LIMIT ? 'CUSTOMER_ORDER_MAP_LIMIT_EXCEEDED' : 'CUSTOMER_ORDER_MAP_KEYS_INVALID'),
  total, sourceProvidedMapComplete: false, decodedComplete: false, entries: [] };
  const entries = keys.sort((a, b) => Number(a) - Number(b)).map(key => order(entry.value[key], Number(key)));
  return { presence: 'present', state: 'known', value: null, total, sourceProvidedMapComplete: true,
    decodedComplete: entries.every(one => one.readable), reportedEmpty: total === 0,
    coverageKind: 'provided-order-map-property-only', entries, reasonCode: null };
}
function stockList(entry) {
  if (!entry.present || !Array.isArray(entry.value)) return cell(entry, () => false);
  const total = entry.value.length;
  if (total > CUSTOMER_COLLECTION_LIMIT) return { ...invalid(entry.value, 'CUSTOMER_STOCK_LIST_LIMIT_EXCEEDED'), total,
    sourceProvidedListComplete: false, decodedComplete: false, entries: [] };
  const entries = entry.value.map(value => order(value));
  return { presence: 'present', state: 'known', value: null, total, sourceProvidedListComplete: true,
    decodedComplete: entries.every(one => one.readable), reportedEmpty: total === 0, entries, reasonCode: null };
}
const containerCell = entry => cell(entry, plainObject, () => null);
const finiteTime = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const scalarId = value => nonnegative(value) || typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value);
const boolLike = value => typeof value === 'boolean' || value === 0 || value === 1;
const boundedArray = (entry, predicate, limit = 4096) => cell(entry, value => Array.isArray(value) && value.length <= limit && value.every(predicate));
function conditionShape(value, depth = 0) {
  if (nonnegative(value) || typeof value === 'boolean') return true;
  if (typeof value === 'string') return /^(?:\d+|\$mainTask|\$lvl|\$vip|And|Or|and|or|\$and|\$or)$/.test(value) && value.length <= 64;
  return depth < 6 && Array.isArray(value) && value.length <= 64 && value.every(one => conditionShape(one, depth + 1));
}
const periodValue = value => nonnegative(value) || typeof value === 'string' && value.length <= 64 &&
  /^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value);
const EXT_FIELDS = Object.freeze(['whiteUids', 'blackUids', 'whiteChns', 'blackChns', 'closeChnId', 'duration', 'beginTime', 'endTime']);
function openExt(entry) {
  if (!entry.present) return missingCustomerCell();
  let value = entry.value;
  if (typeof value === 'string') {
    if (value.length > 32768) return invalid(value, 'CUSTOMER_OPEN_EXT_LIMIT_EXCEEDED');
    try { value = JSON.parse(value); } catch { return invalid(value, 'CUSTOMER_OPEN_EXT_JSON_INVALID'); }
  }
  if (!plainObject(value)) return invalid(value, 'CUSTOMER_OPEN_EXT_INVALID');
  const unknownKeyCount = Object.keys(value).filter(key => !EXT_FIELDS.includes(key)).length;
  const fields = {};
  for (const key of EXT_FIELDS) fields[key] = boundedArray(at(value, [key]), ['beginTime', 'endTime'].includes(key) ? periodValue :
    key === 'duration' ? value => nonnegative(value) || typeof value === 'string' && /^\d{1,16}$/.test(value) : scalarId,
    key === 'duration' ? 2 : 4096);
  return { presence: 'present', state: 'known', value: fields, unknownKeyCount, hasUnprojectedKeys: unknownKeyCount > 0, reasonCode: null };
}
function openEntry(entry, name) {
  if (!entry.present || !plainObject(entry.value)) return cell(entry, () => false);
  const row = entry.value;
  return { presence: 'present', state: 'known', value: { name: cell(at(row, ['0']), value => value === name),
    level: numberCell(at(row, ['2'])), vip: numberCell(at(row, ['3'])), isOr: cell(at(row, ['4']), boolLike),
    isCndOr: cell(at(row, ['5']), boolLike), conditions: cell(at(row, ['6']), conditionShape), closed: cell(at(row, ['9']), boolLike),
    ext: openExt(at(row, ['10'])) }, reasonCode: null };
}
function openEntries(entry) {
  if (!entry.present || !plainObject(entry.value)) return cell(entry, () => false);
  const keys = Object.keys(entry.value);
  if (keys.length > CUSTOMER_COLLECTION_LIMIT || !keys.every(key => /^[A-Za-z0-9_-]{1,64}$/.test(key)))
    return invalid(entry.value, 'CUSTOMER_OPEN_MAP_INVALID');
  return { presence: 'present', state: 'known', value: Object.fromEntries(keys.map(name => [name,
    openEntry({ present: true, value: entry.value[name] }, name)])), total: keys.length, reportedEmpty: keys.length === 0, reasonCode: null };
}
function mapPresence(entry) {
  return cell(entry, value => plainObject(value) && Object.keys(value).length <= 4096,
    value => ({ total: Object.keys(value).length, reportedEmpty: Object.keys(value).length === 0 }));
}
function rewardMap(entry) {
  if (!entry.present || !plainObject(entry.value)) return cell(entry, () => false);
  const keys = Object.keys(entry.value);
  if (keys.length > CUSTOMER_COLLECTION_LIMIT || !keys.every(idKey)) return invalid(entry.value, 'CUSTOMER_REWARD_MAP_INVALID_OR_LIMIT');
  return { presence: 'present', state: 'known', value: { keys: keys.map(Number).sort((a, b) => a - b), total: keys.length,
    reportedEmpty: keys.length === 0 }, total: keys.length, sourceProvidedMapComplete: true, decodedComplete: true,
    reportedEmpty: keys.length === 0, reasonCode: null };
}
function shareCounter(entry) {
  if (!entry.present || !plainObject(entry.value)) return cell(entry, () => false);
  const row = entry.value, value = {
    uid: numberCell(at(row, ['0']), positive), tmpId: numberCell(at(row, ['1']), positive),
    shareCnt: numberCell(at(row, ['2']), nonnegative), recvCnt: numberCell(at(row, ['3']), nonnegative),
    recvTime: dateCell(at(row, ['4'])), totCnt: numberCell(at(row, ['5']), nonnegative),
    uTime: dateCell(at(row, ['6'])), cTime: dateCell(at(row, ['7'])) };
  const currentEnough = knownCustomerCell(value.uid) && knownCustomerCell(value.tmpId) && knownCustomerCell(value.recvCnt);
  return { presence: 'present', state: currentEnough ? 'known' : 'unreadable', value,
    reasonCode: currentEnough ? null : 'CUSTOMER_SHARE_COUNTER_INVALID' };
}
function shareCounterMap(entry) {
  if (!entry.present || !plainObject(entry.value)) return cell(entry, () => false);
  const keys = Object.keys(entry.value);
  if (keys.length > CUSTOMER_COLLECTION_LIMIT || !keys.every(idKey)) return invalid(entry.value, 'CUSTOMER_SHARE_MAP_INVALID_OR_LIMIT');
  const entries = Object.fromEntries(keys.map(key => [key, shareCounter({ present: true, value: entry.value[key] })]));
  const decodedComplete = Object.values(entry.value).every(plainObject);
  return { presence: 'present', state: decodedComplete ? 'known' : 'unreadable', value: null, entries,
    total: keys.length, reportedEmpty: keys.length === 0, sourceProvidedMapComplete: true, decodedComplete,
    reasonCode: decodedComplete ? null : 'CUSTOMER_SHARE_MAP_MEMBER_INVALID' };
}
function periodMap(entry) {
  if (!entry.present || !plainObject(entry.value)) return cell(entry, () => false);
  const keys = Object.keys(entry.value);
  if (keys.length > 4096 || !keys.every(key => /^\d{1,16}$/.test(key) && nonnegative(Number(key)))) return invalid(entry.value, 'CUSTOMER_BUTLER_PERIOD_MAP_INVALID');
  return cell(entry, value => Object.values(value).every(nonnegative));
}
function butlerSetting(entry) {
  if (!entry.present || !plainObject(entry.value)) return cell(entry, () => false);
  const row = entry.value;
  return { presence: 'present', state: 'known', value: { uid: numberCell(at(row, ['0']), positive), type: numberCell(at(row, ['1']), positive),
    status: numberCell(at(row, ['2'])), buyPeriodMap: periodMap(at(row, ['5'])), needSettle: cell(at(row, ['8']), boolLike),
    specifyFlowerStatus: numberCell(at(row, ['3', '0', '0'])), autoPlantStatus: numberCell(at(row, ['3', '1', '0'])),
    modeType: numberCell(at(row, ['3', '2'])) }, reasonCode: null };
}

// G480 IUsrTot@49648: openMap=7.9; IGsOpen@44830 has closed=9/ext=10.
// OpenCtrl@261733 checks server override, UID/channel lists; update@262857
// merges listed keys. SysOpen@689565 additionally uses SDK channel/duration.
// ITaskMain@34307: current task=22.0.1; $mainTask@688390 is strict >.
// ButlerTot=175.0, IButlerSetting@110692; hire helper@1341920/1342100
// reads open('butler').ext periods + type1 buyPeriodMap, NOT type4.status.
function eligibilityInputs(raw, observation) {
  return { profile: { domain: containerCell(containerEntry(raw, ['7', '0'])), level: numberCell(at(raw, ['7', '0', '34'])), vip: numberCell(at(raw, ['7', '0', '36'])),
    chnId: cell(at(raw, ['7', '0', '3']), scalarId), loginChnId: cell(at(raw, ['7', '0', '51']), scalarId) },
  sdkChannel: cell({ present: Object.hasOwn(observation.versionEvidence || {}, 'clientChannel'), value: observation.versionEvidence?.clientChannel }, scalarId),
  mainTask: { domain: containerCell(containerEntry(raw, ['22', '0'])), uid: numberCell(at(raw, ['22', '0', '0']), positive), curTaskId: numberCell(at(raw, ['22', '0', '1'])) },
  serverOpenMap: { map: mapPresence(containerEntry(raw, ['7', '9'])), entries: openEntries(containerEntry(raw, ['7', '9'])),
    sys_orderCustomer: openEntry(at(raw, ['7', '9', 'sys_orderCustomer']), 'sys_orderCustomer'),
    sys_waterwheel: openEntry(at(raw, ['7', '9', 'sys_waterwheel']), 'sys_waterwheel'), sys_freeWater: openEntry(at(raw, ['7', '9', 'sys_freeWater']), 'sys_freeWater'),
    butler: openEntry(at(raw, ['7', '9', 'butler']), 'butler') },
  butler: { settingMap: mapPresence(containerEntry(raw, ['175', '0'])), type1: butlerSetting(at(raw, ['175', '0', '1'])), type4: butlerSetting(at(raw, ['175', '0', '4'])) },
  count107: { map: mapPresence(containerEntry(raw, ['7', '4'])), domain: containerCell(containerEntry(raw, ['7', '4', '107'])),
    uid: numberCell(at(raw, ['7', '4', '107', '0']), positive), type: numberCell(at(raw, ['7', '4', '107', '1']), value => value === 107),
    tdyCnt: numberCell(at(raw, ['7', '4', '107', '2'])), totCnt: numberCell(at(raw, ['7', '4', '107', '3'])),
    rTime: dateCell(at(raw, ['7', '4', '107', '4'])), uTime: dateCell(at(raw, ['7', '4', '107', '5'])), cTime: dateCell(at(raw, ['7', '4', '107', '6'])) } };
}

// G480 IVase [95427,95501), IVaseTot [116090,116158), IFlowerArt
// [95616,95715), IFlowerArtTot [116322,116384): makeList is history,
// not a product quantity; vase rows have uTime/cTime, no invented counter.
const ART_INPUT_METHODS = new Set([...NORMAL_SYNC_METHODS, 'index.reLogin', 'usr.lazySync', 'collectRwd.recvArtCreateRwdByVase']);
function vaseMap(entry) {
  if (!entry.present || !plainObject(entry.value)) return cell(entry, () => false);
  const keys = Object.keys(entry.value), total = keys.length;
  if (total > CUSTOMER_COLLECTION_LIMIT || !keys.every(idKey)) return { ...invalid(entry.value, 'CUSTOMER_VASE_MAP_INVALID_OR_LIMIT'),
    total, sourceProvidedMapComplete: false, decodedComplete: false, entries: [] };
  const entries = keys.sort((a, b) => Number(a) - Number(b)).map(key => {
    const row = entry.value[key], object = plainObject(row), fields = {
      uid: numberCell(object ? at(row, ['0']) : { present: false }, positive),
      vaseId: numberCell(object ? at(row, ['1']) : { present: false }, positive),
      uTime: dateCell(object ? at(row, ['2']) : { present: false }), cTime: dateCell(object ? at(row, ['3']) : { present: false }) };
    return { vaseId: Number(key), presence: row === null ? 'null' : 'present', state: object ? 'known' : 'unreadable',
      fields, readable: object && Object.values(fields).every(knownCustomerCell), reasonCode: object ? null : 'CUSTOMER_VASE_ROW_INVALID' };
  });
  return { presence: 'present', state: 'known', value: null, total, reportedEmpty: total === 0,
    sourceProvidedMapComplete: true, decodedComplete: entries.every(row => row.readable), entries, reasonCode: null };
}
function artEligibilityInputs(raw, method) {
  const allowed = ART_INPUT_METHODS.has(method), input = allowed ? raw : {};
  const rwdMapEntry = containerEntry(input, ['103', '0']), rwd13 = containerEntry(input, ['103', '0', '13']);
  const shareMapEntry = containerEntry(input, ['31', '0']);
  return { vases: { domain: containerCell(containerEntry(input, ['102'])), map: vaseMap(containerEntry(input, ['102', '0'])) },
    flowerArt: { domain: containerCell(containerEntry(input, ['106', '0'])), uid: numberCell(at(input, ['106', '0', '0']), positive),
      exp: numberCell(at(input, ['106', '0', '1'])), makeList: boundedArray(at(input, ['106', '0', '2']), positive),
      sRecvList: boundedArray(at(input, ['106', '0', '3']), positive) },
    collectRwd: { domain: containerCell(containerEntry(input, ['103'])), map: rewardMap(rwdMapEntry),
      uid: numberCell(containerMember(rwd13, ['0']), positive), exp: numberCell(containerMember(rwd13, ['3']), nonnegative),
      artCreateRwdList: boundedArray(containerMember(rwd13, ['7']), positive) },
    shareTot: { domain: containerCell(containerEntry(input, ['31'])), map: shareCounterMap(shareMapEntry) } };
}

export function decodeOfficialCustomerObservation({ context: supplied, observation } = {}) {
  const context = customerContext(supplied);
  if (!context || !text(observation?.responseRef) || observation.connectionEpoch !== context.connectionEpoch) return null;
  const sourceKind = observation.source === 'response' ? 'response' : observation.source === 'push' || observation.transport === 'push' ? 'push' : 'late';
  const envelopeValid = observation.envelopeOk === true && observation.dsName === 'G.ISyncData' && plainObject(observation.value);
  const source = { kind: sourceKind, method: typeof observation.method === 'string' && observation.method.length <= 96 && /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(observation.method) ? observation.method : null,
    transport: observation.transport === 'answered' ? 'answered' : observation.transport === 'push' ? 'push' : null,
    contextKey: customerContextKey(context), connectionEpoch: context.connectionEpoch, requestSequence: positive(observation.requestSequence) ? observation.requestSequence : null,
    responseRef: observation.responseRef, wireKey: typeof observation.wireKey === 'string' && observation.wireKey.length <= 128 && /^ws\|\d+\|[1-9]\d*$/.test(observation.wireKey) ? observation.wireKey : null,
    receivedDeviceMs: finiteTime(observation.receivedDeviceMs), serverMs: finiteTime(observation.serverMs), serverRespondedMs: finiteTime(observation.serverRespondedMs),
    sentMonotonicMs: finiteTime(observation.sentMonotonicMs), receivedMonotonicMs: finiteTime(observation.receivedMonotonicMs),
    version: { source: observation.versionEvidence?.source === 'normal-package-hop-and-matched-world-login/v1' ? observation.versionEvidence.source : null,
      gameVersion: versionText(observation.versionEvidence?.gameVersion), protocolVersion: versionText(observation.versionEvidence?.protocolVersion),
      reportedServerVersion: versionText(observation.versionEvidence?.reportedServerVersion),
      loginResponseRef: text(observation.versionEvidence?.loginResponseRef), dataSnapshotId: observation.versionEvidence?.dataSnapshotId ?? null,
      ...Object.fromEntries(['sourceDataVersion', 'contractId', 'resourceSha256', 'sourceIndexSha256', 'sourceConfigSha256',
        'dataSchemaContractId', 'tableHashes'].filter(key => Object.hasOwn(observation.versionEvidence || {}, key) &&
          observation.versionEvidence[key] !== undefined).map(key => [key, observation.versionEvidence[key]])),
      profileBinding: plainObject(observation.versionEvidence?.profileBinding) ? observation.versionEvidence.profileBinding : null,
      serverVersionBinding: plainObject(observation.versionEvidence?.serverVersionBinding) ? observation.versionEvidence.serverVersionBinding : null,
      sourceProofs: observation.versionEvidence?.sourceProofs && plainObject(observation.versionEvidence.sourceProofs)
        ? observation.versionEvidence.sourceProofs : null },
    frameProtocolVersion: versionText(observation.protocolVersion),
    frameProtocolVersionPresent: observation.protocolVersion !== undefined && observation.protocolVersion !== null,
    frameReportedServerVersion: versionText(observation.reportedServerVersion ?? observation.protocolVersion ??
      observation.versionEvidence?.reportedServerVersion) };
  const raw = envelopeValid ? observation.value : {}, domain = at(raw, ['109']), customer = at(raw, ['109', '0']);
  const payload = { profileUid: numberCell(at(raw, ['7', '0', '0']), positive), domain: containerCell(domain), customer: containerCell(customer),
    uid: numberCell(at(raw, ['109', '0', '0']), positive), orderMap: orderMap(at(raw, ['109', '0', '1'])),
    nextGenTime: dateCell(at(raw, ['109', '0', '2'])), uTime: dateCell(at(raw, ['109', '0', '3'])), cTime: dateCell(at(raw, ['109', '0', '4'])),
    createCount: numberCell(at(raw, ['109', '0', '5'])), orderStockList: stockList(at(raw, ['109', '0', '6'])),
    isOrderStockInit: cell(at(raw, ['109', '0', '7']), boolLike), eligibilityInputs: eligibilityInputs(raw, observation),
    artEligibilityInputs: artEligibilityInputs(raw, source.method) };
  const wireSequence = source.wireKey ? Number(source.wireKey.split('|').at(-1)) : null;
  const reasonCode = sourceKind !== 'response' ? 'CUSTOMER_UNORDERED_OBSERVATION_AUDIT_ONLY'
    : !envelopeValid ? 'CUSTOMER_ENVELOPE_UNSUPPORTED' : observation.rejected === true || observation.messagePresent === true && observation.noticeOnly !== true ? 'CUSTOMER_RESPONSE_UNCONFIRMED'
      : source.transport !== 'answered' || !source.method || source.requestSequence === null || wireSequence !== source.requestSequence ? 'CUSTOMER_MATCHED_SOURCE_INCOMPLETE' : null;
  const observationRef = 'customer-observation:' + fingerprint([context, source.responseRef]);
  source.observationRef = observationRef;
  return freeze({ observationRef, context, source, payload, payloadFingerprint: fingerprint(payload), admissible: reasonCode === null,
    reasonCode, decodeVersion: CUSTOMER_DECODE_VERSION });
}
