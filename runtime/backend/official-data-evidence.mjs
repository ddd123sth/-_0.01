import { fingerprint, freeze, plainObject } from './common.mjs';
import { OFFICIAL_GDATA_SCHEMA_CONTRACT_ID } from './official-public-data.mjs';
import { OFFICIAL_CORE_CONTRACT, OFFICIAL_CORE_CONTRACT_ID, officialActionContractId, officialActionContracts } from './official-version-profile.mjs';
import { sourceProofContractBytesHash } from './official-source-proof.mjs';

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sourceRef = value => typeof value === 'string' && value.length > 0 && value.length <= 512;

export function currentOfficialSourceEvidence(versionEvidence) {
  if (versionEvidence?.source !== 'normal-package-hop-and-matched-world-login/v1' ||
      versionEvidence.protocolVersion !== OFFICIAL_CORE_CONTRACT.protocolVersion ||
      !sourceRef(versionEvidence.loginResponseRef) || versionEvidence.sourceDataVersion !== versionEvidence.gameVersion ||
      versionEvidence.contractId !== OFFICIAL_CORE_CONTRACT_ID || !plainObject(versionEvidence.profileBinding) ||
      versionEvidence.profileBinding.contractId !== OFFICIAL_CORE_CONTRACT_ID ||
      versionEvidence.profileBinding.loginResponseRef !== versionEvidence.loginResponseRef ||
      versionEvidence.profileBinding.dataSnapshotId !== versionEvidence.dataSnapshotId ||
      !/^sha256:[a-f0-9]{64}$/.test(versionEvidence.dataSnapshotId || '') ||
      !digest(versionEvidence.resourceSha256) || !digest(versionEvidence.sourceIndexSha256) ||
      !digest(versionEvidence.sourceConfigSha256) || !plainObject(versionEvidence.sourceProofs)) return null;
  const proofs = Object.entries(versionEvidence.sourceProofs).filter(([action, proof]) => {
    return !!officialActionContractId(action) && plainObject(proof) && proof.supported === true &&
      proof.actionContractId === officialActionContractId(action) && proof.coreContractId === OFFICIAL_CORE_CONTRACT_ID &&
      proof.sourceVersion === versionEvidence.gameVersion && proof.protocolVersion === versionEvidence.protocolVersion &&
      digest(proof.indexSha256) && proof.indexSha256 === versionEvidence.sourceIndexSha256 &&
      digest(proof.gameSha256) && digest(proof.moSha256) && digest(proof.gameResourceSha256) &&
      digest(proof.moResourceSha256) && digest(proof.sourceBlockContractSha256) &&
      proof.sourceBlockContractSha256 === sourceProofContractBytesHash();
  }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (!proofs.length) return null;
  const body = { sourceVersion: versionEvidence.gameVersion, protocolVersion: versionEvidence.protocolVersion,
    loginResponseRef: versionEvidence.loginResponseRef, contractId: versionEvidence.contractId,
    dataSnapshotId: versionEvidence.dataSnapshotId, resourceSha256: versionEvidence.resourceSha256,
    sourceIndexSha256: versionEvidence.sourceIndexSha256, sourceConfigSha256: versionEvidence.sourceConfigSha256,
    proofRefs: proofs.map(([action, proof]) => ({ action, actionContractId: proof.actionContractId,
      gameSha256: proof.gameSha256, moSha256: proof.moSha256, gameResourceSha256: proof.gameResourceSha256,
      moResourceSha256: proof.moResourceSha256, sourceBlockContractSha256: proof.sourceBlockContractSha256 })) };
  return freeze({ ...body, proofFingerprint: fingerprint(body) });
}

// This is a data/source receipt, not a write permission. Callers must still
// apply their action-specific facts, eligibility, and final admission gates.
export function currentOfficialDataEvidence(versionEvidence, action) {
  const definition = officialActionContracts()[action], requiredTables = definition?.tables;
  const sourceEvidence = currentOfficialSourceEvidence(versionEvidence);
  if (!definition || !Array.isArray(requiredTables) || !requiredTables.length || !sourceEvidence ||
      versionEvidence.dataSchemaContractId !== OFFICIAL_GDATA_SCHEMA_CONTRACT_ID || !plainObject(versionEvidence.tableHashes)) return null;
  const hashes = versionEvidence.tableHashes;
  if (Object.values(hashes).some(value => !digest(value)) ||
      versionEvidence.dataSnapshotId !== 'sha256:' + fingerprint(hashes) ||
      requiredTables.some(name => !digest(hashes[name]))) return null;
  const proof = versionEvidence.sourceProofs?.[action];
  if (!plainObject(proof) || proof.supported !== true || proof.actionContractId !== officialActionContractId(action) ||
      proof.coreContractId !== OFFICIAL_CORE_CONTRACT_ID || proof.sourceVersion !== versionEvidence.gameVersion ||
      proof.protocolVersion !== versionEvidence.protocolVersion || !digest(proof.indexSha256) ||
      proof.indexSha256 !== versionEvidence.sourceIndexSha256 || !digest(proof.gameSha256) || !digest(proof.moSha256) ||
      !digest(proof.gameResourceSha256) || !digest(proof.moResourceSha256) ||
      !digest(proof.sourceBlockContractSha256) || proof.sourceBlockContractSha256 !== sourceProofContractBytesHash()) return null;
  const tableHashes = Object.fromEntries(requiredTables.map(name => [name, hashes[name]]));
  return freeze({ action, actionContractId: proof.actionContractId, coreContractId: proof.coreContractId,
    sourceVersion: versionEvidence.gameVersion, protocolVersion: versionEvidence.protocolVersion,
    loginResponseRef: versionEvidence.loginResponseRef, dataSnapshotId: versionEvidence.dataSnapshotId,
    dataSchemaContractId: versionEvidence.dataSchemaContractId, resourceSha256: versionEvidence.resourceSha256,
    sourceIndexSha256: versionEvidence.sourceIndexSha256, sourceConfigSha256: versionEvidence.sourceConfigSha256,
    gameResourceSha256: proof.gameResourceSha256, moResourceSha256: proof.moResourceSha256,
    sourceBlockContractSha256: proof.sourceBlockContractSha256, tableHashes,
    sourceProofFingerprint: sourceEvidence.proofFingerprint,
    proofFingerprint: fingerprint({ action, loginResponseRef: versionEvidence.loginResponseRef,
      dataSnapshotId: versionEvidence.dataSnapshotId, resourceSha256: versionEvidence.resourceSha256,
      sourceIndexSha256: versionEvidence.sourceIndexSha256, sourceConfigSha256: versionEvidence.sourceConfigSha256,
      proof, tableHashes }) });
}
