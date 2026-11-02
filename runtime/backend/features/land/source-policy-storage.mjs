import { canonical, fingerprint, parseStored, plainObject, problem } from '../../common.mjs';
import { encodeEvidenceJson, decodeEvidenceJson } from '../../persistence/evidence-codec.mjs';
import { hashLedgerBytes } from '../../persistence/json-contract.mjs';
import { LAND_PUBLIC_JSON_VERSION, readLandPublicJsonText } from './public-json-storage.mjs';

const VERSION = 'land-source-policy-storage/v2';
const BINDING_VERSION = 'land-source-binding-storage/v1';
const COMPAT_VERSION = 'land-compatibility-storage/v1';
export const LAND_POLICY_OBJECT_SCHEMA = `CREATE TABLE IF NOT EXISTS backend_land_policy_public_objects(
  object_ref TEXT PRIMARY KEY,object_json TEXT NOT NULL);
  CREATE TRIGGER IF NOT EXISTS backend_land_policy_public_objects_no_update BEFORE UPDATE ON backend_land_policy_public_objects
    BEGIN SELECT RAISE(ABORT,'policy public objects are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS backend_land_policy_public_objects_no_delete BEFORE DELETE ON backend_land_policy_public_objects
    BEGIN SELECT RAISE(ABORT,'policy public objects remain referenced'); END;`;
const PUBLIC_FIELDS = Object.freeze(['tables', 'sourceProofs', 'validatedBundle', 'tableHashes']);

// This migrates repeated legacy *public tables*, not primary operation bytes.
// Preserve JSON member order in the detached object so reconstruction can also
// prove the exact JSON.stringify text of legacy receipts, not only their digest.
export function packLandSourcePolicyBinding(binding, { bindingCanonical = null, encodePublicObject = encodeEvidenceJson } = {}) {
  // The stopped-image builder supplies its already verified canonical text and
  // bounded encoding memo. Normal runtime writes always use these safe defaults.
  if (bindingCanonical !== null && typeof bindingCanonical !== 'string' || typeof encodePublicObject !== 'function')
    throw new TypeError('Invalid source binding image ports');
  const bindingRef = bindingCanonical === null ? fingerprint(binding) : hashLedgerBytes(bindingCanonical);
  const version = binding?.versionEvidence, objects = [], detached = [];
  if (!plainObject(version)) return { bindingRef, bindingJson: canonical(binding), objects };
  const body = { ...version };
  for (const key of PUBLIC_FIELDS) {
    if (!plainObject(version[key]) && !Array.isArray(version[key])) continue;
    const objectJson = JSON.stringify(version[key]);
    if (Buffer.byteLength(objectJson) < 512) continue;
    const objectRef = 'sha256:' + hashLedgerBytes(objectJson);
    objects.push({ objectRef, objectJson: encodePublicObject(objectJson) }); detached.push({ key, objectRef }); body[key] = null;
  }
  if (!objects.length) return { bindingRef, bindingJson: canonical(binding), objects };
  const value = { ...binding, versionEvidence: body };
  return { bindingRef, bindingJson: JSON.stringify({ storageVersion: BINDING_VERSION,
    detached, bindingJson: JSON.stringify(value) }), objects };
}

export function readLandSourcePolicyBinding(store, text) {
  const value = parseStored(text, 'land source binding');
  if (value?.storageVersion !== BINDING_VERSION) return value;
  if (!Array.isArray(value.detached) || !value.detached.length || value.detached.length > PUBLIC_FIELDS.length ||
      new Set(value.detached.map(one => one?.key)).size !== value.detached.length || typeof value.bindingJson !== 'string')
    throw problem('LAND_SOURCE_BINDING_INVALID', '土地公共表引用无效', 500);
  const binding = parseStored(value.bindingJson, 'land source binding body');
  if (!plainObject(binding?.versionEvidence))
    throw problem('LAND_SOURCE_BINDING_INVALID', '土地公共表绑定原件无效', 500);
  const version = { ...binding.versionEvidence };
  for (const one of value.detached) {
    if (!PUBLIC_FIELDS.includes(one?.key) || version[one.key] !== null || !/^sha256:[a-f0-9]{64}$/.test(one.objectRef || ''))
      throw problem('LAND_SOURCE_BINDING_INVALID', '土地公共对象引用无效', 500);
    const row = store.get('SELECT object_json FROM backend_land_policy_public_objects WHERE object_ref=?', one.objectRef);
    const original = row && decodeEvidenceJson(row.object_json);
    if (typeof original !== 'string' || 'sha256:' + hashLedgerBytes(original) !== one.objectRef)
      throw problem('LAND_SOURCE_BINDING_MISSING', '土地公共对象原件缺失或校验失败', 500);
    const object = parseStored(original, 'land source public object');
    if (!plainObject(object) && !Array.isArray(object)) throw problem('LAND_SOURCE_BINDING_INVALID', '土地公共对象原件无效', 500);
    version[one.key] = object;
  }
  return { ...binding, versionEvidence: version };
}
// Only the immutable binding is shared. The receipt retains its own subject,
// connection, response, request sequence and policy; freshness is never shared.
export function storeLandSourcePolicy(store, receipt) {
  if (!receipt.binding) return JSON.stringify(receipt);
  const { bindingJson, bindingRef, objects } = packLandSourcePolicyBinding(receipt.binding);
  for (const object of objects) {
    store.run('INSERT OR IGNORE INTO backend_land_policy_public_objects VALUES(?,?)', object.objectRef, object.objectJson);
    const row = store.get('SELECT object_json FROM backend_land_policy_public_objects WHERE object_ref=?', object.objectRef);
    if (!row || decodeEvidenceJson(row.object_json) !== decodeEvidenceJson(object.objectJson))
      throw problem('LAND_SOURCE_BINDING_CONFLICT', '土地公共表原件冲突', 500);
  }
  store.run('INSERT OR IGNORE INTO backend_land_source_policy_bindings VALUES(?,?)', bindingRef, bindingJson);
  const stored = store.get('SELECT binding_json FROM backend_land_source_policy_bindings WHERE binding_ref=?', bindingRef);
  if (!stored || canonical(readLandSourcePolicyBinding(store, stored.binding_json)) !== canonical(receipt.binding))
    throw problem('LAND_SOURCE_BINDING_CONFLICT', '土地来源绑定原件冲突', 500);
  return JSON.stringify({ storageVersion: VERSION, bindingRef, receipt: { ...receipt, binding: null } });
}

export function readLandSourcePolicy(store, text) {
  const stored = parseStored(text, 'land source policy');
  if (stored?.storageVersion === LAND_PUBLIC_JSON_VERSION) return JSON.parse(readLandPublicJsonText(store, stored, 'policy'));
  if (stored?.storageVersion !== VERSION) return stored;
  if (!/^[a-f0-9]{64}$/.test(stored.bindingRef || '') || stored.receipt?.version !== 'land-source-policy/v1' ||
      stored.receipt.binding !== null) throw problem('LAND_SOURCE_BINDING_INVALID', '土地来源绑定引用无效', 500);
  const row = store.get('SELECT binding_json FROM backend_land_source_policy_bindings WHERE binding_ref=?', stored.bindingRef);
  if (!row) throw problem('LAND_SOURCE_BINDING_MISSING', '土地来源绑定原件缺失', 500);
  const binding = readLandSourcePolicyBinding(store, row.binding_json);
  if (fingerprint(binding) !== stored.bindingRef) throw problem('LAND_SOURCE_BINDING_CONFLICT', '土地来源绑定原件校验失败', 500);
  return { ...stored.receipt, binding };
}

export function readLandSourcePolicyText(store, text) {
  const stored = parseStored(text, 'land source policy');
  if (stored?.storageVersion === LAND_PUBLIC_JSON_VERSION) return readLandPublicJsonText(store, stored, 'policy');
  if (stored?.storageVersion !== VERSION) return decodeEvidenceJson(text);
  if (stored.originalEncoding !== undefined && !['canonical','json-stringify'].includes(stored.originalEncoding))
    throw problem('LAND_SOURCE_BINDING_INVALID', '土地来源原文字节编码无效', 500);
  const receipt = readLandSourcePolicy(store, text);
  return stored.originalEncoding === 'canonical' ? canonical(receipt) : JSON.stringify(receipt);
}

// Compatibility receipts retain their own login, context and fingerprints.
// Only the same immutable public subtrees already used by source policies are
// shared. The fully hydrated receipt remains the fingerprinted evidence.
export function packLandCompatibilityReceipt(receipt, options = {}) {
  if (receipt?.version !== 'land-domain-compatibility-revalidation/v1' || !plainObject(receipt.authorizedVersionEvidence))
    throw problem('LAND_COMPATIBILITY_RECEIPT_INVALID', '土地兼容复核原件无效', 500);
  const { receiptCanonical = null, originalEncoding = 'json-stringify', ...bindingOptions } = options;
  if (receiptCanonical !== null && typeof receiptCanonical !== 'string' || !['json-stringify','canonical'].includes(originalEncoding))
    throw new TypeError('Invalid compatibility image encoding ports');
  const packed = packLandSourcePolicyBinding({ versionEvidence: receipt.authorizedVersionEvidence }, bindingOptions);
  if (!packed.objects.length) return { receiptJson: encodeEvidenceJson(JSON.stringify(receipt)), objects: [] };
  return { receiptJson: JSON.stringify({ storageVersion: COMPAT_VERSION,
    receiptJson: JSON.stringify({ ...receipt, authorizedVersionEvidence: null }), bindingJson: packed.bindingJson,
    originalEncoding, receiptFingerprint: receiptCanonical === null ? fingerprint(receipt) : hashLedgerBytes(receiptCanonical) }), objects: packed.objects };
}

export function readLandCompatibilityReceipt(store, text) {
  const stored = parseStored(text, 'land compatibility receipt');
  if (stored?.storageVersion === LAND_PUBLIC_JSON_VERSION) return JSON.parse(readLandPublicJsonText(store, stored, 'compatibility'));
  if (stored?.storageVersion !== COMPAT_VERSION) return stored;
  if (typeof stored.receiptJson !== 'string' || typeof stored.bindingJson !== 'string')
    throw problem('LAND_COMPATIBILITY_RECEIPT_INVALID', '土地兼容复核引用无效', 500);
  const receipt = parseStored(stored.receiptJson, 'land compatibility body');
  if (receipt?.version !== 'land-domain-compatibility-revalidation/v1' || receipt.authorizedVersionEvidence !== null)
    throw problem('LAND_COMPATIBILITY_RECEIPT_INVALID', '土地兼容复核原件无效', 500);
  const binding = readLandSourcePolicyBinding(store, stored.bindingJson);
  const hydrated = { ...receipt, authorizedVersionEvidence: binding.versionEvidence };
  if (fingerprint(hydrated) !== stored.receiptFingerprint)
    throw problem('LAND_COMPATIBILITY_RECEIPT_INVALID', '土地兼容复核原件校验失败', 500);
  return hydrated;
}

export function readLandCompatibilityReceiptText(store, text) {
  const stored = parseStored(text, 'land compatibility receipt');
  if (stored?.storageVersion === LAND_PUBLIC_JSON_VERSION) return readLandPublicJsonText(store, stored, 'compatibility');
  if (stored?.storageVersion !== COMPAT_VERSION) return decodeEvidenceJson(text);
  if (stored.originalEncoding !== undefined && !['canonical','json-stringify'].includes(stored.originalEncoding))
    throw problem('LAND_COMPATIBILITY_RECEIPT_INVALID', '土地兼容复核原文字节编码无效', 500);
  const receipt = readLandCompatibilityReceipt(store, text);
  return stored.originalEncoding === 'canonical' ? canonical(receipt) : JSON.stringify(receipt);
}

export function storeLandCompatibilityReceipt(store, receipt) {
  const packed = packLandCompatibilityReceipt(receipt);
  for (const object of packed.objects) {
    store.run('INSERT OR IGNORE INTO backend_land_policy_public_objects VALUES(?,?)', object.objectRef, object.objectJson);
    const row = store.get('SELECT object_json FROM backend_land_policy_public_objects WHERE object_ref=?', object.objectRef);
    if (!row || decodeEvidenceJson(row.object_json) !== decodeEvidenceJson(object.objectJson))
      throw problem('LAND_SOURCE_BINDING_CONFLICT', '土地公共表原件冲突', 500);
  }
  return packed.receiptJson;
}
