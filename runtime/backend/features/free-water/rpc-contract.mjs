import { canonical, fingerprint, plainObject, problem } from '../../common.mjs';

export const FREE_WATER_CONTRACT_REF = 'free-water/official-actions/v1';
export const FREE_WATER_METHODS = Object.freeze({ receive: 'freeWater.recv', share: 'usr.share' });
export const FREE_WATER_SCOPES = Object.freeze({ receive: 'free-water-recv', share: 'free-water-fallback' });
export const FREE_WATER_POST_READ = Object.freeze({ contractId: 'free-water/after-close-login/v1', method: 'index.login',
  kind: 'after-close-login', args: Object.freeze({}), evidenceRef: 'free-water/independent-after-write-state/v1',
  validateResponseCoverage: freeWaterResponseCoverage });
export const FREE_WATER_DEFINITIONS = Object.freeze(Object.fromEntries(Object.entries(FREE_WATER_METHODS).map(([kind, method]) =>
  [kind, Object.freeze({ contractId: FREE_WATER_CONTRACT_REF + '/' + kind, featureId: 'free-water', scope: FREE_WATER_SCOPES[kind], method,
    targetKind: 'free-water', paramsContract: 'free-water-index-0-or-1/v1' })])));
export function captureFreeWaterArgs({ method, params } = {}) {
  const kind = Object.entries(FREE_WATER_METHODS).find(([, value]) => value === method)?.[0];
  const idx = kind === 'receive' ? params?.idx : params?.ext?.id;
  const expected = !kind || !Number.isSafeInteger(idx) || (idx !== 0 && idx !== 1) ? null :
    kind === 'receive' ? { idx } : { shareId: 13, ext: { opType: 1, id: idx } };
  if (!expected || !plainObject(params) || canonical(params) !== canonical(expected))
    throw problem('FREE_WATER_ARGUMENT_CONTRACT_INVALID', '每日水滴参数与已核官服方法不一致', 400);
  return Object.freeze({ method, params: Object.freeze(expected), paramsFingerprint: fingerprint(expected), kind, idx });
}
export function assertFreeWaterProposal(proposal) {
  const water = proposal?.freeWater;
  if (!proposal || proposal.featureId !== 'free-water' || proposal.contractRef !== FREE_WATER_CONTRACT_REF ||
      !Object.values(FREE_WATER_METHODS).includes(proposal.method) || !plainObject(proposal.params) ||
      !Array.isArray(proposal.targets) || proposal.targets.length !== 1 || !Array.isArray(proposal.resources) ||
      !water || !['receive','share'].includes(water.kind) || FREE_WATER_METHODS[water.kind] !== proposal.method ||
      FREE_WATER_SCOPES[water.kind] !== proposal.scope || !Number.isSafeInteger(water.idx) || (water.idx !== 0 && water.idx !== 1))
    throw problem('FREE_WATER_PROPOSAL_INVALID', '每日水滴提案缺少独立有限动作合同', 400);
  const captured = captureFreeWaterArgs({ method: proposal.method, params: proposal.params });
  if (captured.idx !== water.idx || captured.paramsFingerprint !== proposal.paramsFingerprint)
    throw problem('FREE_WATER_PROPOSAL_INVALID', '每日水滴参数指纹或索引不一致', 400);
  const target = proposal.targets[0], expectedTargetRef = `free-water:${proposal.subjectRef}:${water.dayKey}:${water.idx}`;
  if (target.targetKind !== 'free-water' || target.targetRef !== expectedTargetRef ||
      target.memberKey !== 'free-water:' + fingerprint([water.dayKey, water.idx]) ||
      target.targetFingerprint !== fingerprint({ targetRef: expectedTargetRef, sourceRef: water.sourceRef, extensionRef: water.extensionRef }))
    throw problem('FREE_WATER_PROPOSAL_INVALID', '每日水滴目标未绑定当前官方日和领取索引', 400);
  const extension = water.extension, { extensionRef, ...body } = plainObject(extension) ? extension : {};
  const factSnapshot = water.factSnapshot;
  if (extensionRef !== water.extensionRef || extensionRef !== 'sha256:' + fingerprint(body) ||
      extension?.extensionId !== 'free-water-public-data/v1' || extension.loginResponseRef !== water.loginResponseRef ||
      extension.bundleRef !== water.bundleRef || extension.sourcePin !== water.sourcePin || !water.dayProofRef || !water.sourceRef ||
      !plainObject(factSnapshot) || !plainObject(factSnapshot.value) || !plainObject(factSnapshot.sources) ||
      factSnapshot.fingerprint !== water.sourceFingerprint || factSnapshot.fingerprint !== fingerprint({ value: factSnapshot.value, sources: factSnapshot.sources }) ||
      factSnapshot.sources.water?.responseRef !== water.sourceRef || !factSnapshot.sources.water?.connectionEpoch)
    throw problem('FREE_WATER_PROPOSAL_INVALID', '每日水滴公开数据或原始来源绑定无效', 400);
  return true;
}
export function freeWaterResponseCoverage({ proposal, response, observation, bridge } = {}) {
  return FREE_WATER_METHODS[proposal?.freeWater?.kind] === proposal?.method && response?.method === proposal.method &&
    response?.transport === 'answered' && typeof response?.responseRef === 'string' && observation?.method === 'index.login' &&
    observation?.source === 'response' && observation?.transport === 'answered' && observation?.envelopeOk === true &&
    observation?.dsName === 'G.ISyncData' && observation?.rejected !== true && observation.responseRef === bridge?.newLoginObservation?.responseRef &&
    bridge?.oldPhysicalCloseReceipt?.closed === true && bridge.operationId === proposal.operationId;
}
export function freeWaterAfterCloseLoginProof({ proposal, response, bridge } = {}) {
  const observation = bridge?.newLoginObservation;
  if (!freeWaterResponseCoverage({ proposal, response, observation, bridge }) || observation?.versionEvidence?.loginResponseRef !== observation.responseRef ||
      bridge.officialUid !== proposal.freeWater.uid || bridge.newContext?.connectionEpoch !== observation.connectionEpoch)
    throw problem('FREE_WATER_POST_READ_BRIDGE_INVALID', '每日水滴后验登录不符合原操作的身份与关闭合同');
  return Object.freeze({ version: 'free-water/after-close-login/v1', operationId: proposal.operationId,
    oldLoginResponseRef: proposal.freeWater.loginResponseRef, newLoginResponseRef: observation.responseRef,
    newLoginRequestSequence: observation.requestSequence, newLoginWireKey: observation.wireKey,
    newLoginConnectionEpoch: observation.connectionEpoch, postReadRef: observation.responseRef, officialUid: bridge.officialUid,
    leaseRef: bridge.leaseRef, bridgeFingerprint: bridge.bridgeFingerprint, oldConnectionEpoch: bridge.originalContext?.connectionEpoch,
    newConnectionEpoch: bridge.newContext?.connectionEpoch, oldPhysicalCloseReceipt: bridge.oldPhysicalCloseReceipt,
    newContext: bridge.newContext, extensionRef: proposal.freeWater.extensionRef, writeResponseRef: response.responseRef });
}
export function freeWaterTargetVerification({ proposal, verification } = {}) {
  return verification?.verificationVersion === 'free-water/target-postread/v1' &&
    verification.evidence?.targetRef === proposal?.targets?.[0]?.targetRef && verification.evidence?.extensionRef === proposal?.freeWater?.extensionRef;
}
