import crypto from 'node:crypto';
import { canonical, fingerprint, freeze, plainObject, problem } from '../../common.mjs';

export const LAND_ACCELERATION_METHODS = freeze({ card: 'usrLand.speedUp', free: 'usrLand.speedUpFree' });
export const LAND_ACCELERATION_SCOPES = freeze({ card: 'land-speedup', free: 'land-speedfree' });
export const LAND_ACCELERATION_CONTRACT_ID = 'land-acceleration/isolated-extension/v1';
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const sha256 = value => 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');

export function captureLandAccelerationArgs({ mode, params, targetLandId } = {}) {
  const method = LAND_ACCELERATION_METHODS[mode], scope = LAND_ACCELERATION_SCOPES[mode];
  const expected = mode === 'card' ? ['landId'] : [];
  if (!method || !scope || !plainObject(params) || canonical(Object.keys(params).sort()) !== canonical(expected) ||
      !positiveId(targetLandId) || mode === 'card' && params.landId !== targetLandId) {
    throw problem('LAND_ACCELERATION_ARGUMENT_INVALID', '加速方法、参数和当前目标没有匹配独立合同', 400);
  }
  return freeze({ mode, featureId: 'land.acceleration', method, scope, params: { ...params },
    paramsFingerprint: fingerprint(params), targetLandId,
    contractId: LAND_ACCELERATION_CONTRACT_ID + '/' + mode });
}

export function assertLandAccelerationProposal(proposal) {
  if (!plainObject(proposal?.acceleration)) throw problem('LAND_ACCELERATION_PROPOSAL_INVALID', '加速提案缺少独立合同绑定');
  const bound = captureLandAccelerationArgs({ mode: proposal.acceleration.mode, params: proposal.params,
    targetLandId: proposal.acceleration.targetLandId });
  const target = proposal.targets?.[0], extension = proposal.acceleration.extension;
  const extensionBody = extension && { extensionId: extension.extensionId, sourcePin: extension.sourcePin,
    sourceVersion: extension.sourceVersion, baseDataSnapshotId: extension.baseDataSnapshotId, bundleRef: extension.bundleRef,
    loginResponseRef: extension.loginResponseRef, resourceSha256: extension.resourceSha256, tableHashes: extension.tableHashes,
    thresholdSeconds: extension.thresholdSeconds, cardItemId: extension.cardItemId,
    staticResetRestoreLimitAbsent: extension.staticResetRestoreLimitAbsent, sourcePinRef: extension.sourcePinRef };
  if (!Array.isArray(proposal.targets) || proposal.targets.length !== 1 || target?.targetKind !== 'land' ||
      target.targetRef !== `land:${proposal.subjectRef}:${bound.targetLandId}` || !target.memberKey || !target.lifecycleRef ||
      proposal.featureId !== bound.featureId || proposal.scope !== bound.scope || proposal.method !== bound.method ||
      proposal.paramsFingerprint !== bound.paramsFingerprint || proposal.acceleration.contractId !== bound.contractId ||
      proposal.acceleration.extensionRef !== extension?.extensionRef || !/^sha256:[a-f0-9]{64}$/.test(extension?.extensionRef || '') ||
      extension?.extensionId !== 'land-acceleration-public-data/v1' || !/^sha256:[a-f0-9]{64}$/.test(extension?.sourcePin || '') ||
      !Number.isSafeInteger(extension?.thresholdSeconds) || extension.thresholdSeconds <= 0 || extension.thresholdSeconds > 3600 ||
      extension?.cardItemId !== 1001 || extension?.staticResetRestoreLimitAbsent !== true ||
      !plainObject(extension?.tableHashes) || !/^sha256:[a-f0-9]{64}$/.test(extension?.baseDataSnapshotId || '') ||
      sha256(Buffer.from(canonical(extensionBody))) !== extension?.extensionRef ||
      extension?.baseDataSnapshotId !== proposal.acceleration.baseDataSnapshotId ||
      extension?.loginResponseRef !== proposal.acceleration.loginResponseRef ||
      typeof extension?.bundleRef !== 'string' || !extension.bundleRef ||
      proposal.acceleration.connectionEpoch !== proposal.connectionEpoch) {
    throw problem('LAND_ACCELERATION_PROPOSAL_BINDING_INVALID', '加速动作、土地目标、资源扩展或本次登录绑定不一致');
  }
  return bound;
}
