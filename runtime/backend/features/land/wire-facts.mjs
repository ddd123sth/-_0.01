import { fingerprint, freeze, plainObject } from '../../common.mjs';

export const LAND_DECODE_VERSION = 'official-land-wire/F1-1.2.5/v1';
const text = (value, limit = 512) => typeof value === 'string' && value.length > 0 && value.length <= limit ? value : null;
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const idKey = key => /^[1-9][0-9]*$/.test(key) && positive(Number(key));
export const knownCell = cell => cell?.presence === 'present' && cell.state === 'known';
export function missingCell(sourceRef = null) { return { presence: 'missing', state: 'unobserved', value: null, sourceRef, reasonCode: 'FIELD_NOT_SUPPLIED' }; }
function at(root, path) {
  let current = root;
  for (const key of path) {
    if (!plainObject(current) || !Object.hasOwn(current, key)) return { present: false };
    current = current[key];
  }
  return { present: true, value: current };
}
export function officialDateMs(value) {
  if (positive(value)) return value <= 8640000000000000 ? value : null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const ms = Date.parse(value);
  if (!positive(ms)) return null;
  const canonical = new Date(ms).toISOString();
  return canonical === value || canonical.replace('.000Z', 'Z') === value ? ms : null;
}
function invalidCell(value, sourceRef, reasonCode = 'WIRE_FIELD_INVALID') {
  const cell = { presence: value === null ? 'null' : 'present', state: 'unreadable', value: null, sourceRef, reasonCode,
    rawType: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value };
  // Do not archive arbitrary strings/objects received at a numeric field.
  if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') cell.rawValue = value;
  return cell;
}
function cell(entry, sourceRef, validate, transform = value => value) {
  if (!entry.present) return missingCell(sourceRef);
  if (entry.value === null) return { presence: 'null', state: 'unreadable', value: null, sourceRef, reasonCode: 'WIRE_EXPLICIT_NULL' };
  if (!validate(entry.value)) return invalidCell(entry.value, sourceRef);
  return { presence: 'present', state: 'known', value: transform(entry.value), sourceRef };
}
const numeric = (entry, ref, predicate = nonnegative) => cell(entry, ref, predicate);
const date = (entry, ref) => cell(entry, ref, value => officialDateMs(value) !== null, officialDateMs);
const numbers = value => Array.isArray(value) && value.length <= 4096 && value.every(nonnegative);
function safeNumericShape(value, depth = 0) {
  if (nonnegative(value) || value === null || typeof value === 'boolean') return true;
  if (depth >= 4) return false;
  if (Array.isArray(value)) return value.length <= 1024 && value.every(one => safeNumericShape(one, depth + 1));
  return plainObject(value) && Object.keys(value).length <= 1024 && Object.keys(value).every(idKey)
    && Object.values(value).every(one => safeNumericShape(one, depth + 1));
}
function numericMap(entry, ref, { limit = 20000 } = {}) {
  if (!entry.present || entry.value === null || !plainObject(entry.value)) return cell(entry, ref, () => false);
  const keys = Object.keys(entry.value);
  if (keys.length > limit || !keys.every(idKey)) return invalidCell(entry.value, ref, 'WIRE_MAP_KEYS_INVALID');
  const items = {}, value = {};
  for (const key of keys) {
    items[key] = numeric({ present: true, value: entry.value[key] }, ref);
    if (knownCell(items[key])) value[key] = items[key].value;
  }
  return { presence: 'present', state: Object.values(items).every(knownCell) ? 'known' : 'unreadable', value, items, sourceRef: ref,
    reasonCode: Object.values(items).every(knownCell) ? null : 'WIRE_MAP_MEMBER_INVALID' };
}
const LAND_FIELDS = { flowerId: '0', state: '1', lvl: '2', harvestCnt: '3', stealUids: '4', nextTime: '5', elvesId: '6', plantTime: '7', elvesStealUids: '8', skills: '9' };
const CULTIVATE_FIELDS = { uid: '0', flowerId: '1', lvl: '2', culTime: '3', status: '4', uTime: '5', cTime: '6', isRecvShareRwd: '7', isReduce: '8', reduceByHelpCnt: '9', isUseItem: '10', advanceSlotMap: '11' };
function member(value, ref, fields, kind) {
  if (value === null) return { valid: true, removed: true, fields: {}, sourceRef: ref };
  if (!plainObject(value)) return { valid: false, removed: false, fields: {}, sourceRef: ref, reasonCode: 'WIRE_MEMBER_INVALID' };
  const out = {};
  for (const [name, key] of Object.entries(fields)) {
    const entry = at(value, [key]);
    if (['nextTime', 'plantTime', 'culTime', 'uTime', 'cTime'].includes(name)) out[name] = date(entry, ref);
    else if (['stealUids', 'elvesStealUids'].includes(name)) out[name] = cell(entry, ref, numbers);
    else if (['skills', 'advanceSlotMap'].includes(name)) out[name] = cell(entry, ref, safeNumericShape);
    else if (['isRecvShareRwd', 'isReduce', 'isUseItem'].includes(name)) out[name] = cell(entry, ref, one => typeof one === 'boolean');
    else if (name === 'state') out[name] = numeric(entry, ref, one => Number.isSafeInteger(one) && one >= 0 && one <= 3);
    else if (['uid', 'lvl'].includes(name)) out[name] = numeric(entry, ref, positive);
    else out[name] = numeric(entry, ref);
  }
  return { valid: true, removed: false, fields: out, sourceRef: ref,
    explicitEmptyObject: kind === 'land' && Object.keys(value).length === 0 };
}
function memberMap(entry, ref, fields, kind, limit) {
  if (!entry.present || !plainObject(entry.value)) return cell(entry, ref, () => false);
  const keys = Object.keys(entry.value);
  if (keys.length > limit || !keys.every(idKey)) return invalidCell(entry.value, ref, 'WIRE_MAP_KEYS_INVALID');
  return { presence: 'present', state: 'known', value: Object.fromEntries(keys.map(key => [key, member(entry.value[key], ref, fields, kind)])), sourceRef: ref };
}
function extMap(entry, ref) {
  if (!entry.present || !plainObject(entry.value)) return cell(entry, ref, () => false);
  const keys = Object.keys(entry.value);
  if (keys.length > 20000 || !keys.every(idKey)) return invalidCell(entry.value, ref, 'WIRE_MAP_KEYS_INVALID');
  const value = {};
  for (const key of keys) {
    const one = entry.value[key];
    if (!plainObject(one)) { value[key] = { valid: false, fields: {}, sourceRef: ref, reasonCode: 'ITEM_EXT_MEMBER_INVALID' }; continue; }
    const fields = {};
    for (const [name, index] of Object.entries({ limit: '0', resetNum: '1', lrms: '2', restoreNum: '3', cd: '4', lems: '5' })) {
      fields[name] = ['lrms', 'lems'].includes(name) ? date(at(one, [index]), ref) : numeric(at(one, [index]), ref);
    }
    value[key] = { valid: true, fields, sourceRef: ref };
  }
  return { presence: 'present', state: 'known', value, sourceRef: ref };
}

export function decodeOfficialLandObservation({ context, observation, capabilities = {} } = {}) {
  if (!context || !text(context.ownerRef) || !text(context.accountRef) || !text(context.subjectRef) || !positive(context.connectionEpoch)) return null;
  if (observation?.connectionEpoch !== context.connectionEpoch) return null;
  if (observation?.envelopeOk !== true || observation.dsName !== 'G.ISyncData' || !plainObject(observation.value) || !text(observation.responseRef)) return null;
  const ref = 'land-observation:' + fingerprint([context.ownerRef, context.subjectRef, context.connectionEpoch, observation.responseRef]);
  const sourceKind = observation.source === 'late' ? 'late' : observation.source === 'push' || observation.transport === 'push' ? 'push' : 'response';
  const version = observation.versionEvidence;
  const versionEvidence = plainObject(version) && version.source === 'normal-package-hop-and-matched-world-login/v1' &&
    text(version.gameVersion, 32) && text(version.protocolVersion, 32) && text(version.loginResponseRef, 512)
    ? { source: version.source, gameVersion: version.gameVersion, protocolVersion: version.protocolVersion, loginResponseRef: version.loginResponseRef } : null;
  const source = { observationRef: ref, responseRef: observation.responseRef, wireKey: text(observation.wireKey, 256),
    connectionEpoch: context.connectionEpoch, requestSequence: positive(observation.requestSequence) ? observation.requestSequence : null,
    method: text(observation.method, 96), kind: sourceKind,
    serverMs: positive(observation.serverMs) ? observation.serverMs : null,
    serverRespondedMs: positive(observation.serverRespondedMs) ? observation.serverRespondedMs : null,
    sentMonotonicMs: typeof observation.sentMonotonicMs === 'number' && Number.isFinite(observation.sentMonotonicMs) ? observation.sentMonotonicMs : null,
    receivedMonotonicMs: typeof observation.receivedMonotonicMs === 'number' && Number.isFinite(observation.receivedMonotonicMs) ? observation.receivedMonotonicMs : null,
    receivedDeviceMs: Number.isSafeInteger(observation.receivedDeviceMs) ? observation.receivedDeviceMs : null,
    versionEvidence,
    decodeVersion: LAND_DECODE_VERSION };
  const raw = observation.value;
  const profile = {};
  for (const [name, index] of Object.entries({ uid: '0', cTime: '17', level: '34', lvlExp: '35', vipExp: '37', gold: '44', yuanbao: '41' })) {
    profile[name] = name === 'cTime' ? date(at(raw, ['7', '0', index]), ref) : numeric(at(raw, ['7', '0', index]), ref, name === 'uid' ? positive : nonnegative);
  }
  const frame = { observationRef: ref, context: Object.fromEntries(['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch'].map(key => [key, context[key] ?? null])),
    source, admissible: sourceKind === 'response' && source.requestSequence !== null,
    reasonCode: sourceKind !== 'response' ? 'LAND_UNORDERED_OBSERVATION_AUDIT_ONLY' : source.requestSequence === null ? 'LAND_REQUEST_SEQUENCE_MISSING' : null,
    profile, landUid: numeric(at(raw, ['100', '0', '0']), ref, positive),
    landBase: memberMap(at(raw, ['100', '0', '1']), ref, LAND_FIELDS, 'land', 256),
    landChanges: memberMap(at(raw, ['100', '1']), ref, LAND_FIELDS, 'land', 256),
    cultivates: memberMap(at(raw, ['101', '0']), ref, CULTIVATE_FIELDS, 'cultivate', 10000),
    bag: numericMap(at(raw, ['7', '0', '32']), ref), itemExt: extMap(at(raw, ['7', '0', '33']), ref),
    bi: numericMap(at(raw, ['7', '2', '0']), ref), bo: numericMap(at(raw, ['7', '2', '1']), ref), bd: numericMap(at(raw, ['7', '2', '2']), ref),
    top: cell(at(raw, ['7', '3', 'flowerPlantTop', '2', '2']), ref, value => Array.isArray(value) && value.length <= 10000 && value.every(positive)),
    harvestMap: numericMap(at(raw, ['100', '2']), ref, { limit: 256 }),
    coverage: { landMapComplete: capabilities.landMapComplete === true, bagComplete: capabilities.bagComplete === true,
      itemExtComplete: capabilities.itemExtComplete === true, evidenceRef: text(capabilities.evidenceRef) }, issues: [] };
  return freeze(frame);
}
