import { canonical, fingerprint, plainObject, problem } from '../../common.mjs';

export const WATERWHEEL_METHODS = Object.freeze({ recv: 'waterwheel.recv', skip: 'waterwheel.skip', share: 'usr.share' });
export const WATERWHEEL_SCOPES = Object.freeze({ recv: 'waterwheel-recv', skip: 'waterwheel-skip', share: 'waterwheel-ad-bucket' });
export const WATERWHEEL_CONTRACT_REF = 'waterwheel/official-actions/v1';
export const WATERWHEEL_POST_READ = Object.freeze({ contractId: 'waterwheel/after-close-login/v1', method: 'index.login',
  kind: 'after-close-login', args: Object.freeze({}), evidenceRef: 'waterwheel/independent-after-write-state/v1',
  validateResponseCoverage: waterwheelResponseCoverage });
export const WATERWHEEL_DEFINITIONS = Object.freeze(Object.fromEntries(Object.entries(WATERWHEEL_METHODS).map(([kind, method]) => [kind,
  Object.freeze({ contractId: WATERWHEEL_CONTRACT_REF + '/' + kind, featureId: 'waterwheel', scope: WATERWHEEL_SCOPES[kind], method,
    targetKind: 'waterwheel', params: kind === 'share' ? Object.freeze({ shareId: 9, ext: Object.freeze({ opType: 1 }) }) : Object.freeze({}) })])));

export function waterwheelResponseCoverage({ proposal, response, observation, bridge } = {}) {
  const writeMatched = WATERWHEEL_DEFINITIONS[proposal?.waterwheel?.kind]?.method === proposal?.method && response?.method === proposal?.method &&
    response?.transport === 'answered' && typeof response?.responseRef === 'string' && response.responseRef.length > 0;
  // The only post-write source is the supervisor's durable physical-close/new
  // login bridge. It is intentionally not an enter ACK and does not claim that
  // enter supplied wheel fields.
  const login = observation?.method === 'index.login' && observation?.source === 'response' && observation?.transport === 'answered' &&
    observation?.envelopeOk === true && observation?.dsName === 'G.ISyncData' && observation?.rejected !== true &&
    bridge?.newLoginObservation?.responseRef === observation.responseRef && bridge?.oldPhysicalCloseReceipt?.closed === true &&
    bridge?.operationId === proposal?.operationId;
  return writeMatched && login;
}

export function waterwheelAfterCloseLoginProof({ proposal, response, bridge } = {}) {
  const observation = bridge?.newLoginObservation;
  if (!waterwheelResponseCoverage({ proposal, response, observation, bridge }) ||
      observation?.versionEvidence?.loginResponseRef !== observation?.responseRef ||
      bridge?.officialUid !== proposal?.waterwheel?.uid || bridge?.newContext?.connectionEpoch !== observation.connectionEpoch)
    throw problem('WATERWHEEL_POST_READ_BRIDGE_INVALID', '水车后验新登录没有通过原操作的物理关闭与身份合同');
  return Object.freeze({ version: 'waterwheel/after-close-login/v1', operationId: proposal.operationId,
    oldLoginResponseRef: proposal.waterwheel.loginResponseRef, newLoginResponseRef: observation.responseRef,
    newLoginRequestSequence: observation.requestSequence, newLoginWireKey: observation.wireKey,
    newLoginConnectionEpoch: observation.connectionEpoch,
    postReadRef: observation.responseRef, officialUid: bridge.officialUid, leaseRef: bridge.leaseRef,
    bridgeFingerprint: bridge.bridgeFingerprint, oldConnectionEpoch: bridge.originalContext?.connectionEpoch,
    newConnectionEpoch: bridge.newContext?.connectionEpoch, oldPhysicalCloseReceipt: bridge.oldPhysicalCloseReceipt, newContext: bridge.newContext,
    extensionRef: proposal.waterwheel.extensionRef, writeResponseRef: response.responseRef });
}
export function waterwheelTargetVerification({ proposal, verification } = {}) {
  return verification?.verificationVersion === 'waterwheel/target-postread/v1' &&
    verification.evidence?.targetRef === proposal?.targets?.[0]?.targetRef && verification.evidence?.extensionRef === proposal?.waterwheel?.extensionRef;
}

export function captureWaterwheelArgs({ method, params } = {}) {
  const kind = Object.entries(WATERWHEEL_METHODS).find(([, candidate]) => candidate === method)?.[0];
  const expected = kind === 'share' ? { shareId: 9, ext: { opType: 1 } } : {};
  if (!kind || !plainObject(params) || canonical(params) !== canonical(expected))
    throw problem('WATERWHEEL_ARGUMENT_CONTRACT_INVALID', '水车参数与已核官服方法不一致', 400);
  return Object.freeze({ method, params: Object.freeze(expected), paramsFingerprint: fingerprint(expected), kind });
}

export function assertWaterwheelProposal(proposal) {
  if (!proposal || proposal.featureId !== 'waterwheel' || proposal.contractRef !== WATERWHEEL_CONTRACT_REF ||
      !Object.values(WATERWHEEL_METHODS).includes(proposal.method) || !plainObject(proposal.params) ||
      !Array.isArray(proposal.targets) || proposal.targets.length !== 1 || !Array.isArray(proposal.resources))
    throw problem('WATERWHEEL_PROPOSAL_INVALID', '水车提案缺少独立有限动作合同', 400);
  const captured = captureWaterwheelArgs({ method: proposal.method, params: proposal.params });
  if (captured.paramsFingerprint !== proposal.paramsFingerprint) throw problem('WATERWHEEL_PROPOSAL_INVALID', '水车参数指纹不一致', 400);
  const target = proposal.targets[0], wheel = proposal.waterwheel, extension = wheel?.extension;
  const { extensionRef, ...extensionBody } = plainObject(extension) ? extension : {};
  const expectedTargetRef = `waterwheel:${proposal.subjectRef}:${wheel?.generationRef}:${wheel?.count}:${wheel?.slot}`;
  const expectedMemberKey = 'waterwheel:' + fingerprint([wheel?.generationRef, wheel?.count, wheel?.slot]);
  const expectedTargetFingerprint = fingerprint({ targetRef: expectedTargetRef, sourceRef: wheel?.sourceRef,
    extensionRef: wheel?.extensionRef });
  if (!Object.hasOwn(WATERWHEEL_METHODS, wheel?.kind) || WATERWHEEL_METHODS[wheel.kind] !== proposal.method ||
      WATERWHEEL_SCOPES[wheel.kind] !== proposal.scope || target.targetKind !== 'waterwheel' ||
      target.targetRef !== expectedTargetRef || target.memberKey !== expectedMemberKey || target.targetFingerprint !== expectedTargetFingerprint ||
      !Number.isSafeInteger(wheel?.count) || wheel.count < 0 || !Number.isSafeInteger(wheel?.slot) || wheel.slot < 1 ||
      typeof wheel?.extensionRef !== 'string' || wheel.extensionRef !== extensionRef || extensionRef !== 'sha256:' + fingerprint(extensionBody) ||
      extension?.extensionId !== 'waterwheel-public-data/v1' || extension?.loginResponseRef !== wheel?.loginResponseRef ||
      extension?.bundleRef !== wheel.bundleRef || extension?.sourcePin !== wheel.sourcePin ||
      typeof wheel?.sourceRef !== 'string' || typeof wheel?.generationRef !== 'string')
    throw problem('WATERWHEEL_PROPOSAL_INVALID', '水车目标机会未绑定当前官服计数和持久产桶阶段', 400);
  return true;
}
