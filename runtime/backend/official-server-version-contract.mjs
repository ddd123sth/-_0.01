import crypto from 'node:crypto';
import fs from 'node:fs';
import { canonical, freeze, plainObject } from './common.mjs';

export const SERVER_VERSION_SEMANTIC_ID = 'official-server-version-semantic/v1';
export const SERVER_VERSION_BINDING_ID = 'official-server-version-binding/v1';
export const SERVER_VERSION_PROTOCOL_CONTRACT = '480.0.0';
const PIN_BYTES = fs.readFileSync(new URL('./contracts/official-server-version-semantic-v1.json', import.meta.url));
const PIN_HASH = '4db6b8df8ad49642dbf651ff53ced6f56068443712b78ba5ffe92b2c0b111f32';
export const SERVER_VERSION_SOURCE_PIN = 'sha256:' + PIN_HASH;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = value => /^sha256:[a-f0-9]{64}$/.test(value || '');
const versionText = value => typeof value === 'string' && /^[0-9]+(?:\.[0-9]+){1,5}$/.test(value) && value.length <= 64;
const identityFields = Object.freeze(['ownerRef','accountRef','subjectRef','ownerEpoch','runEpoch','connectionEpoch']);

export function proveOfficialServerVersionSemantics({ gameBytes, moBytes } = {}) {
  if (sha256(PIN_BYTES) !== PIN_HASH || !Buffer.isBuffer(gameBytes) || !Buffer.isBuffer(moBytes) ||
      gameBytes.length > 8 * 1024 * 1024 || moBytes.length > 8 * 1024 * 1024) return null;
  let pin;
  try { pin = JSON.parse(PIN_BYTES.toString('utf8')); } catch { return null; }
  if (pin?.schema !== SERVER_VERSION_SEMANTIC_ID || !Array.isArray(pin.blocks) || pin.blocks.length !== 10 ||
      !digest(pin.coreContractId) || !versionText(pin.contractProtocolVersion)) return null;
  const matchedRanges = [];
  for (const row of pin.blocks) {
    const source = row.module === 'game' ? gameBytes : row.module === 'mo' ? moBytes : null;
    if (!source || typeof row.base64 !== 'string' || !Number.isSafeInteger(row.byteLength) || row.byteLength < 1) return null;
    const bytes = Buffer.from(row.base64, 'base64'), offset = source.indexOf(bytes);
    if (bytes.length !== row.byteLength || sha256(bytes) !== row.sha256 || offset < 0 || source.indexOf(bytes, offset + 1) >= 0) return null;
    matchedRanges.push({ module: row.module, name: row.name, pinnedStart: row.start, pinnedEnd: row.end,
      actualStart: offset, actualEnd: offset + bytes.length, byteLength: bytes.length, sha256: row.sha256 });
  }
  const body = { extensionId: SERVER_VERSION_SEMANTIC_ID, sourcePin: SERVER_VERSION_SOURCE_PIN,
    referenceGameVersion: pin.referenceGameVersion, referenceGameSha256: pin.referenceGameSha256,
    referenceMoVersion: pin.referenceMoVersion, referenceMoSha256: pin.referenceMoSha256,
    gameSha256: sha256(gameBytes), moSha256: sha256(moBytes), coreContractId: pin.coreContractId,
    protocolContractVersion: pin.contractProtocolVersion, matchedRanges };
  return freeze({ ...body, proofRef: 'sha256:' + sha256(Buffer.from(canonical(body))) });
}

export function bindOfficialServerVersionProofToBundle({ proof, bundleRef, sourceVersion, dataSnapshotId, resourceSha256 } = {}) {
  if (!plainObject(proof) || proof.extensionId !== SERVER_VERSION_SEMANTIC_ID || proof.sourcePin !== SERVER_VERSION_SOURCE_PIN ||
      !digest(proof.proofRef) || !digest(bundleRef) || !versionText(sourceVersion) || !digest(dataSnapshotId) ||
      !/^[a-f0-9]{64}$/.test(resourceSha256 || '')) return null;
  const { proofRef: priorProofRef, ...proofBody } = proof;
  if ('sha256:' + sha256(Buffer.from(canonical(proofBody))) !== priorProofRef) return null;
  const body = { ...proofBody, sourceVersion, bundleRef, dataSnapshotId, resourceSha256 };
  return freeze({ ...body, proofRef: 'sha256:' + sha256(Buffer.from(canonical(body))) });
}

export function bindOfficialServerVersionEvidence({ proof, bundleRef, sourceVersion, dataSnapshotId, resourceSha256,
  reportedServerVersion, loginResponseRef, context, officialUid } = {}) {
  if (!plainObject(proof) || proof.extensionId !== SERVER_VERSION_SEMANTIC_ID || proof.sourcePin !== SERVER_VERSION_SOURCE_PIN ||
      !digest(proof.proofRef) || !digest(bundleRef) || !versionText(sourceVersion) || !digest(dataSnapshotId) || !/^[a-f0-9]{64}$/.test(resourceSha256 || '') ||
      !versionText(reportedServerVersion) || typeof loginResponseRef !== 'string' || !loginResponseRef || !plainObject(context) ||
      identityFields.some(key => context[key] === undefined || context[key] === null) || !Number.isSafeInteger(officialUid) || officialUid <= 0 ||
      !digest(proof.coreContractId) || proof.protocolContractVersion !== SERVER_VERSION_PROTOCOL_CONTRACT) return null;
  const { proofRef, ...proofBody } = proof;
  if ('sha256:' + sha256(Buffer.from(canonical(proofBody))) !== proofRef || proof.sourceVersion !== sourceVersion ||
      proof.bundleRef !== bundleRef || proof.dataSnapshotId !== dataSnapshotId || proof.resourceSha256 !== resourceSha256) return null;
  const body = { version: SERVER_VERSION_BINDING_ID, proofRef, proof,
    sourceVersion, gameSha256: proof.gameSha256, moSha256: proof.moSha256, coreContractId: proof.coreContractId,
    protocolContractVersion: proof.protocolContractVersion, bundleRef, dataSnapshotId, resourceSha256,
    reportedServerVersion, loginResponseRef, officialUid,
    context: Object.fromEntries(identityFields.map(key => [key, key === 'accountRef' ? String(context[key]) : context[key]])) };
  return freeze({ ...body, bindingRef: 'sha256:' + sha256(Buffer.from(canonical(body))) });
}

export function verifyOfficialServerVersionBinding(binding, { sourceVersion, protocolVersion, reportedServerVersion,
  loginResponseRef, context, officialUid, bundleRef = null } = {}) {
  if (!plainObject(binding) || binding.version !== SERVER_VERSION_BINDING_ID || !digest(binding.bindingRef) ||
      binding.sourceVersion !== sourceVersion || binding.protocolContractVersion !== protocolVersion ||
      binding.reportedServerVersion !== reportedServerVersion || binding.loginResponseRef !== loginResponseRef ||
      binding.officialUid !== officialUid || (bundleRef !== null && binding.bundleRef !== bundleRef) ||
      !plainObject(context) || identityFields.some(key => binding.context?.[key] !== (key === 'accountRef' ? String(context[key]) : context[key])) ||
      binding.proof?.proofRef !== binding.proofRef || binding.proof?.gameSha256 !== binding.gameSha256 ||
      binding.proof?.moSha256 !== binding.moSha256 || binding.proof?.coreContractId !== binding.coreContractId) return false;
  const { bindingRef, ...body } = binding;
  if ('sha256:' + sha256(Buffer.from(canonical(body))) !== bindingRef) return false;
  const { proofRef, ...proofBody } = binding.proof;
  return 'sha256:' + sha256(Buffer.from(canonical(proofBody))) === proofRef &&
    binding.proof.extensionId === SERVER_VERSION_SEMANTIC_ID && binding.proof.sourcePin === SERVER_VERSION_SOURCE_PIN &&
    binding.proof.sourceVersion === sourceVersion && binding.proof.bundleRef === binding.bundleRef &&
    binding.proof.dataSnapshotId === binding.dataSnapshotId && binding.proof.resourceSha256 === binding.resourceSha256 &&
    binding.proof.protocolContractVersion === protocolVersion && binding.proof.coreContractId === binding.coreContractId;
}

export function verifyOfficialServerVersionFrame({ versionEvidence, frameProtocolVersion, frameReportedServerVersion,
  context, officialUid } = {}) {
  if (!plainObject(versionEvidence) || !versionText(versionEvidence.protocolVersion)) return false;
  if (frameProtocolVersion === null || frameProtocolVersion === undefined || frameProtocolVersion === versionEvidence.protocolVersion) return true;
  const binding = versionEvidence.serverVersionBinding, profile = versionEvidence.profileBinding;
  if (!binding || !plainObject(profile) || frameProtocolVersion !== frameReportedServerVersion ||
      frameReportedServerVersion !== versionEvidence.reportedServerVersion || profile.officialUid !== officialUid ||
      identityFields.some(key => profile[key] !== (key === 'accountRef' ? String(context?.[key]) : context?.[key]))) return false;
  return verifyOfficialServerVersionBinding(binding, { sourceVersion: versionEvidence.gameVersion,
    protocolVersion: versionEvidence.protocolVersion, reportedServerVersion: frameReportedServerVersion,
    loginResponseRef: versionEvidence.loginResponseRef, context, officialUid, bundleRef: binding.bundleRef });
}


// Shared business-frame adapter. A reported server release is accepted only
// through the existing login-bound semantic version proof, never by text mapping.
export function verifyOfficialSourceVersionFrame(source, versionEvidence, context, officialUid) {
  if (!versionEvidence || !Number.isSafeInteger(officialUid) || officialUid <= 0 ||
      source?.officialUid != null && source.officialUid !== officialUid) return false;
  const frameProtocol = source?.protocolVersion ?? source?.frameProtocolVersion ?? source?.reportedServerVersion ??
    source?.frameReportedServerVersion ?? source?.versionEvidence?.reportedServerVersion ?? source?.versionEvidence?.protocolVersion ??
    versionEvidence.reportedServerVersion ?? versionEvidence.protocolVersion;
  const reported = source?.reportedServerVersion ?? source?.frameReportedServerVersion ?? source?.versionEvidence?.reportedServerVersion ?? frameProtocol;
  return verifyOfficialServerVersionFrame({ versionEvidence, frameProtocolVersion: frameProtocol,
    frameReportedServerVersion: reported, context, officialUid });
}

// A matched write may retain the server's release in its version projection,
// while its original preparation carries the login-bound semantic contract.
// Check BOTH reported fields independently; neither may conceal the other.
export function officialAnswerProtocolChecks(source, anchor, context, officialUid) {
  const version = source?.versionEvidence;
  const check = (protocol, reported) => (reported==null || reported===(anchor?.reportedServerVersion??anchor?.protocolVersion)) &&
    verifyOfficialServerVersionFrame({ versionEvidence: anchor,
      frameProtocolVersion: protocol, frameReportedServerVersion: reported ?? protocol, context, officialUid });
  return {
    versionProtocol: typeof version?.protocolVersion === 'string' && check(version.protocolVersion,
      version.reportedServerVersion ?? source?.reportedServerVersion),
    frameProtocol: source?.protocolVersion == null || check(source.protocolVersion,
      source.reportedServerVersion ?? version?.reportedServerVersion),
  };
}
