import { canonical, fingerprint, parseStored } from '../../common.mjs';
import { readLandSourcePolicy, readLandCompatibilityReceipt } from './source-policy-storage.mjs';

const CONTEXT_FIELDS = Object.freeze(['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch']);
const FRAME_FIELDS = Object.freeze(['profile', 'landUid', 'landBase', 'landChanges', 'cultivates', 'bag', 'itemExt', 'bi', 'bo', 'bd', 'top', 'harvestMap']);
const ROW_FINGERPRINT_MAX_ITEMS = 16;
const ROW_FINGERPRINT_MAX_UTF16_BYTES = 16 * 1024 * 1024;
const ROW_FINGERPRINT_SUBJECT_MAX_ITEMS = 4;
const ROW_FINGERPRINT_SUBJECT_MAX_UTF16_BYTES = 2 * 1024 * 1024;
const rowStoreIds = new WeakMap();
const rowFingerprintCache = new Map();
let nextRowStoreId = 1;
let nextRowFingerprintEntryId = 1;
let rowFingerprintCacheBytes = 0;
const semantic = value => {
  if (Array.isArray(value)) return value.map(semantic);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['source', 'sourceRef', 'semanticVersion', 'observationRef', 'responseRef'].includes(key))
    .map(([key, child]) => [key, semantic(child)]));
  return value;
};
const sameContext = (left, right) => !!left && !!right && CONTEXT_FIELDS.every(key => left[key] === right[key]);
const sameSourceEnvelope = (left, right) => !!left && !!right && Object.keys({ ...left, ...right }).filter(key => !['version', 'versionEvidence'].includes(key))
  .every(key => canonical(left[key] ?? null) === canonical(right[key] ?? null)) &&
  (left.versionEvidence?.source ?? null) === (right.versionEvidence?.source ?? null) &&
  (left.versionEvidence?.gameVersion ?? null) === (right.versionEvidence?.gameVersion ?? null) &&
  (left.versionEvidence?.loginResponseRef ?? null) === (right.versionEvidence?.loginResponseRef ?? null) &&
  (left.reportedServerVersion ?? left.versionEvidence?.reportedServerVersion ?? null) ===
    (right.reportedServerVersion ?? right.versionEvidence?.reportedServerVersion ?? null);
const cellUid = frame => frame?.profile?.uid?.presence === 'present' && frame.profile.uid.state === 'known' &&
  Number.isSafeInteger(frame.profile.uid.value) && frame.profile.uid.value > 0 ? frame.profile.uid.value : null;
const payloadFingerprint = frame => fingerprint(Object.fromEntries(FRAME_FIELDS.map(key => [key, semantic(frame?.[key])] )));

function rowFingerprint(store, artifactKind, ref, rowJson, parsed, calculate = fingerprint) {
  if (!store || (typeof store !== 'object' && typeof store !== 'function') || typeof artifactKind !== 'string' ||
      typeof ref !== 'string' || typeof rowJson !== 'string') return calculate(parsed);
  let storeId = rowStoreIds.get(store);
  if (storeId === undefined) { storeId = nextRowStoreId++; rowStoreIds.set(store, storeId); }
  for (const [entryId, entry] of rowFingerprintCache) {
    if (entry.storeId !== storeId || entry.artifactKind !== artifactKind || entry.ref !== ref || entry.rowJson !== rowJson) continue;
    rowFingerprintCache.delete(entryId);
    rowFingerprintCache.set(entryId, entry);
    return entry.fingerprint;
  }
  const value = calculate(parsed);
  const retainedBytes = (artifactKind.length + ref.length + rowJson.length + value.length) * 2;
  if (retainedBytes > ROW_FINGERPRINT_SUBJECT_MAX_UTF16_BYTES) return value;
  const context = parsed?.context;
  const subjectKey = canonical([storeId, context?.ownerRef ?? null, context?.subjectRef ?? null]);
  // A busy subject replaces its own oldest derived hashes before taking space
  // from another subject. Account aliases share the stable subject quota.
  let own = [...rowFingerprintCache].filter(([, entry]) => entry.subjectKey === subjectKey);
  let ownBytes = own.reduce((sum, [, entry]) => sum + entry.retainedBytes, 0);
  while (own.length >= ROW_FINGERPRINT_SUBJECT_MAX_ITEMS || ownBytes + retainedBytes > ROW_FINGERPRINT_SUBJECT_MAX_UTF16_BYTES) {
    const [id, entry] = own.shift();
    rowFingerprintCache.delete(id); ownBytes -= entry.retainedBytes; rowFingerprintCacheBytes -= entry.retainedBytes;
  }
  rowFingerprintCache.set(nextRowFingerprintEntryId++, { storeId, subjectKey, artifactKind, ref, rowJson, fingerprint: value, retainedBytes });
  rowFingerprintCacheBytes += retainedBytes;
  while (rowFingerprintCache.size > ROW_FINGERPRINT_MAX_ITEMS || rowFingerprintCacheBytes > ROW_FINGERPRINT_MAX_UTF16_BYTES) {
    const oldestId = rowFingerprintCache.keys().next().value;
    if (oldestId === undefined) break;
    const oldest = rowFingerprintCache.get(oldestId);
    rowFingerprintCache.delete(oldestId);
    rowFingerprintCacheBytes -= oldest.retainedBytes;
  }
  return value;
}

function sourcePolicyReceipt(store, ref, context, source) {
  const responseRef = source?.responseRef;
  if (typeof ref !== 'string' || !ref.startsWith('land-source-policy:')) return null;
  const row = store.get(`SELECT receipt_ref,owner_ref,subject_ref,connection_epoch,response_ref,receipt_json FROM backend_land_source_policy_receipts
    WHERE receipt_ref=? AND owner_ref=? AND subject_ref=? AND connection_epoch=? AND response_ref=?`,
  ref, context.ownerRef, context.subjectRef, context.connectionEpoch, responseRef);
  if (!row || row.receipt_ref !== ref) return null;
  let receipt;
  try { receipt = readLandSourcePolicy(store, row.receipt_json); } catch { return null; }
  const receiptFingerprint = rowFingerprint(store, 'land-source-policy', ref, row.receipt_json, receipt);
  if (ref !== 'land-source-policy:' + receiptFingerprint || !sameContext(receipt.context, context) ||
      receipt.source?.responseRef !== responseRef || receipt.source?.method !== 'index.login' || receipt.source?.sourceKind !== 'response' ||
      receipt.source?.connectionEpoch !== source.connectionEpoch || receipt.source?.requestSequence !== source.requestSequence ||
      receipt.source?.wireKey !== source.wireKey) return null;
  return { row, receipt, fingerprint: receiptFingerprint };
}

export function buildLandCompatibilityRevalidation({ store, context, originalRow, originalFrame, currentFrame, currentSourcePolicyRef } = {}) {
  if (!store || !context || !originalRow || !originalFrame || !currentFrame || typeof currentSourcePolicyRef !== 'string') return null;
  const payload = payloadFingerprint(originalFrame);
  if (originalRow.accepted !== 0 || originalRow.reason_code !== 'LAND_CONTEXT_NOT_CURRENT' ||
      originalRow.payload_fingerprint !== payload || originalFrame.admissible !== false ||
      originalFrame.reasonCode !== 'LAND_SOURCE_VERSION_UNSUPPORTED' || originalFrame.source?.method !== 'index.login' ||
      originalFrame.source?.kind !== 'response' || originalFrame.source?.responseRef !== originalFrame.source?.versionEvidence?.loginResponseRef ||
      !sameContext(originalFrame.context, context) || !sameContext(currentFrame.context, context) ||
      !sameSourceEnvelope(originalFrame.source, currentFrame.source) || currentFrame.admissible !== true ||
      currentFrame.reasonCode != null || cellUid(originalFrame) === null || cellUid(currentFrame) !== cellUid(originalFrame) ||
      payloadFingerprint(currentFrame) !== payload) return null;
  const rows = store.all(`SELECT receipt_ref,receipt_json FROM backend_land_source_policy_receipts
    WHERE owner_ref=? AND subject_ref=? AND connection_epoch=? AND response_ref=? ORDER BY recorded_at,receipt_ref`,
  context.ownerRef, context.subjectRef, context.connectionEpoch, originalFrame.source.responseRef);
  const policies = (rows || []).map(row => {
    try { const receipt = readLandSourcePolicy(store, row.receipt_json); return { row, receipt,
      fingerprint: rowFingerprint(store, 'land-source-policy', row.receipt_ref, row.receipt_json, receipt) }; }
    catch { return null; }
  }).filter(Boolean);
  const valid = item => item.row.receipt_ref === 'land-source-policy:' + item.fingerprint && sameContext(item.receipt.context, context) &&
    item.receipt.source?.responseRef === originalFrame.source.responseRef && item.receipt.source?.method === 'index.login' &&
    item.receipt.source?.sourceKind === 'response' && item.receipt.source?.connectionEpoch === originalFrame.source.connectionEpoch &&
    item.receipt.source?.requestSequence === originalFrame.source.requestSequence && item.receipt.source?.wireKey === originalFrame.source.wireKey;
  const oldPolicy = policies.find(item => valid(item) && item.receipt.policy?.supported === false &&
    item.receipt.policy?.reasonCode === 'LAND_SOURCE_VERSION_UNSUPPORTED' && item.receipt.policy?.requiresNewLogin === false);
  const newPolicy = policies.find(item => valid(item) && item.row.receipt_ref === currentSourcePolicyRef &&
    item.receipt.policy?.supported === true && item.receipt.policy?.reasonCode == null && item.receipt.policy?.requiresNewLogin === false &&
    item.receipt.supplied?.loginResponseRef === originalFrame.source.responseRef &&
    item.receipt.supplied?.gameVersion === currentFrame.source.versionEvidence.gameVersion &&
    item.receipt.supplied?.protocolVersion === currentFrame.source.versionEvidence.protocolVersion &&
    item.receipt.binding?.loginResponseRef === originalFrame.source.responseRef &&
    item.receipt.binding?.versionEvidence?.loginResponseRef === originalFrame.source.responseRef);
  if (!oldPolicy || !newPolicy) return null;
  const authorizedVersionEvidence = newPolicy.receipt.binding.versionEvidence;
  if (!authorizedVersionEvidence || authorizedVersionEvidence.loginResponseRef !== originalFrame.source.responseRef ||
      authorizedVersionEvidence.gameVersion !== currentFrame.source.versionEvidence.gameVersion ||
      authorizedVersionEvidence.protocolVersion !== currentFrame.source.versionEvidence.protocolVersion) return null;
  const proofFingerprint = fingerprint(authorizedVersionEvidence);
  const receipt = { version: 'land-domain-compatibility-revalidation/v1', observationRef: originalRow.observation_ref,
    context, payloadFingerprint: payload, originalFrameFingerprint: fingerprint(originalFrame), frameFingerprint: fingerprint(currentFrame),
    originalSourcePolicyRef: oldPolicy.row.receipt_ref, originalSourcePolicyFingerprint: oldPolicy.fingerprint,
    currentSourcePolicyRef: newPolicy.row.receipt_ref, currentSourcePolicyFingerprint: newPolicy.fingerprint,
    authorizedVersionEvidence, proofFingerprint };
  return { receipt, receiptRef: 'land-domain-compatibility:' + fingerprint(receipt), proofFingerprint };
}

export function resolveAcceptedLandObservationEvidence({ store, context, observationRef, source = null } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.all !== 'function' || !context || typeof observationRef !== 'string') return null;
  const base = store.get(`SELECT * FROM backend_land_domain_observations WHERE observation_ref=? AND owner_ref=? AND account_ref=? AND subject_ref=?
    AND connection_epoch=?`, observationRef, context.ownerRef, context.accountRef, context.subjectRef, context.connectionEpoch);
  if (!base) return null;
  let raw;
  try { raw = parseStored(base.frame_json, 'land observation evidence'); } catch { return null; }
  if (!sameContext(raw.context, context) || base.observation_ref !== observationRef) return null;
  const rawPayloadFingerprint = rowFingerprint(store, 'land-domain-observation-payload', observationRef, base.frame_json, raw, payloadFingerprint);
  if (base.payload_fingerprint !== rawPayloadFingerprint || source && !sameSourceEnvelope(raw.source, source)) return null;
  if (base.accepted === 1) return raw.admissible === true &&
    (!source || canonical(raw.source?.versionEvidence ?? null) === canonical(source.versionEvidence ?? null))
    ? { row: base, frame: raw, accepted: true, compatibility: false, payloadFingerprint: base.payload_fingerprint,
      frameFingerprint: rowFingerprint(store, 'land-domain-observation-frame', observationRef, base.frame_json, raw) } : null;
  if (base.accepted !== 0 || base.reason_code !== 'LAND_CONTEXT_NOT_CURRENT' || raw.admissible !== false ||
      raw.reasonCode !== 'LAND_SOURCE_VERSION_UNSUPPORTED' || raw.source?.kind !== 'response' || raw.source?.method !== 'index.login' ||
      raw.source?.versionEvidence?.loginResponseRef !== raw.source?.responseRef || cellUid(raw) === null) return null;
  let receipts;
  try { receipts = store.all(`SELECT * FROM backend_land_domain_compatibility_revalidations WHERE observation_ref=? AND payload_fingerprint=?
    AND accepted=1 AND reason_code IS NULL ORDER BY recorded_at DESC,revalidation_ref`, observationRef, base.payload_fingerprint); }
  catch { return null; }
  for (const row of receipts || []) {
    let receipt, frame;
    try { receipt = readLandCompatibilityReceipt(store, row.receipt_json); frame = parseStored(row.frame_json, 'land compatible frame'); } catch { continue; }
    if (receipt?.version !== 'land-domain-compatibility-revalidation/v1' || receipt.observationRef !== observationRef ||
        receipt.payloadFingerprint !== base.payload_fingerprint ||
        receipt.originalFrameFingerprint !== rowFingerprint(store, 'land-domain-observation-frame', observationRef, base.frame_json, raw)) continue;
    const receiptFingerprint = rowFingerprint(store, 'land-domain-compatibility-receipt', row.revalidation_ref, row.receipt_json, receipt);
    if (row.revalidation_ref !== 'land-domain-compatibility:' + receiptFingerprint || row.proof_fingerprint !== receipt.proofFingerprint ||
        receipt.proofFingerprint !== fingerprint(receipt.authorizedVersionEvidence) ||
        receipt.frameFingerprint !== rowFingerprint(store, 'land-domain-compatibility-frame', row.revalidation_ref, row.frame_json, frame) ||
        !sameContext(frame?.context, context) || !sameSourceEnvelope(raw.source, frame?.source) ||
        frame?.admissible !== true || frame?.reasonCode != null || cellUid(frame) !== cellUid(raw) ||
        rowFingerprint(store, 'land-domain-compatibility-payload', row.revalidation_ref, row.frame_json, frame, payloadFingerprint) !== base.payload_fingerprint ||
        source && !sameSourceEnvelope(frame.source, source)) continue;
    const frameFingerprint = rowFingerprint(store, 'land-domain-compatibility-frame', row.revalidation_ref, row.frame_json, frame);
    const originalPolicy = sourcePolicyReceipt(store, receipt.originalSourcePolicyRef, context, raw.source);
    const currentPolicy = sourcePolicyReceipt(store, receipt.currentSourcePolicyRef, context, raw.source);
    if (!originalPolicy || !currentPolicy || originalPolicy.fingerprint !== receipt.originalSourcePolicyFingerprint ||
        currentPolicy.fingerprint !== receipt.currentSourcePolicyFingerprint || originalPolicy.receipt.policy?.supported !== false ||
        originalPolicy.receipt.policy?.reasonCode !== 'LAND_SOURCE_VERSION_UNSUPPORTED' ||
        originalPolicy.receipt.policy?.requiresNewLogin !== false || currentPolicy.receipt.policy?.supported !== true ||
        currentPolicy.receipt.policy?.reasonCode != null || currentPolicy.receipt.policy?.requiresNewLogin !== false ||
        currentPolicy.receipt.supplied?.loginResponseRef !== raw.source.responseRef ||
        currentPolicy.receipt.supplied?.gameVersion !== frame.source.versionEvidence.gameVersion ||
        currentPolicy.receipt.supplied?.protocolVersion !== frame.source.versionEvidence.protocolVersion ||
        fingerprint(currentPolicy.receipt.binding?.versionEvidence) !== receipt.proofFingerprint ||
        canonical(receipt.authorizedVersionEvidence) !== canonical(currentPolicy.receipt.binding?.versionEvidence)) continue;
    return { row: base, frame, accepted: true, compatibility: true, compatibilityRef: row.revalidation_ref,
      proofFingerprint: receipt.proofFingerprint, payloadFingerprint: base.payload_fingerprint, frameFingerprint };
  }
  return null;
}
