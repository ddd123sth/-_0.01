import { canonical, fingerprint, freeze, plainObject, problem } from '../../common.mjs';
import { SPECIAL_ORDERS_SOURCE_PIN } from '../../official-special-orders-extension.mjs';

export const SPECIAL_ORDER_CONTRACT_REF = 'special-orders/official-actions/v1';
const make = (kind, action, method, scope) => freeze({ featureId: 'order.' + kind, kind, action, method, scope,
  contractId: `${SPECIAL_ORDER_CONTRACT_REF}/${kind}/${action}`, targetKind: 'special-order', paramsContract: 'special-order-finite-args/v1' });
export const SPECIAL_ORDER_DEFINITIONS = freeze({
  'palace-finish': make('palace', 'finish', 'orderPalace.finishOrder', 'order-palace'),
  'team-take': make('team', 'take', 'orderTeam.takeOrder', 'order-team-take'),
  'team-submit': make('team', 'submit', 'orderTeam.submitOrder', 'order-team-submit'),
  'team-receive': make('team', 'receive', 'orderTeam.recvRwd', 'order-team-receive'),
  'team-stored': make('team', 'stored', 'orderTeam.takeStoredOrder', 'order-team-stored'),
});

export function captureSpecialOrderArgs({ method, params } = {}) {
  const definition = Object.values(SPECIAL_ORDER_DEFINITIONS).find(one => one.method === method);
  let expected = null;
  if (definition && plainObject(params)) {
    if (definition.action === 'take' && params.isAgree === true && typeof params.isCost === 'boolean')
      expected = { isAgree: true, isCost: params.isCost };
    else if (definition.action === 'stored' && Number.isSafeInteger(params.npcId) && params.npcId > 0)
      expected = { npcId: params.npcId };
    else if (!['take', 'stored'].includes(definition.action)) expected = {};
  }
  if (!expected || canonical(expected) !== canonical(params))
    throw problem('SPECIAL_ORDER_ARGUMENT_CONTRACT_INVALID', '宫廷或组团订单参数不符合已核官服合同', 400);
  return freeze({ ...definition, params: expected, paramsFingerprint: fingerprint(expected) });
}

export function assertSpecialOrderProposal(proposal) {
  const action = proposal?.specialOrder, captured = captureSpecialOrderArgs({ method: proposal?.method, params: proposal?.params });
  if (!plainObject(action) || !plainObject(action.params) || proposal.contractRef !== SPECIAL_ORDER_CONTRACT_REF || proposal.featureId !== captured.featureId ||
      proposal.scope !== captured.scope || action.kind !== captured.kind || action.action !== captured.action ||
      proposal.paramsFingerprint !== captured.paramsFingerprint || !Number.isSafeInteger(action.officialUid) || action.officialUid <= 0 ||
      typeof action.cycleRef !== 'string' || !action.cycleRef || !Array.isArray(proposal.targets) || proposal.targets.length !== 1 ||
      !Array.isArray(proposal.resources) || !Array.isArray(proposal.resourceBindings))
    throw problem('SPECIAL_ORDER_PROPOSAL_INVALID', '宫廷或组团订单缺少有限动作与目标绑定', 400);
  const target = proposal.targets[0], targetRef = `special-order:${proposal.subjectRef}:${action.kind}:${action.cycleRef}:${action.action}`;
  if (target.targetKind !== 'special-order' || target.targetRef !== targetRef || target.lifecycleRef !== action.cycleRef ||
      target.memberKey !== 'special-order:' + fingerprint([action.kind, action.cycleRef, action.action]) ||
      target.targetFingerprint !== fingerprint({ targetRef, sourceFingerprint: action.sourceFingerprint, extensionRef: action.extensionRef }) ||
      !plainObject(action.factSnapshot) || action.factSnapshot.current !== true || action.factSnapshot.kind !== action.kind ||
      action.factSnapshot.fingerprint !== action.sourceFingerprint || !plainObject(action.extension) ||
      action.extension.extensionRef !== action.extensionRef || !/^sha256:[a-f0-9]{64}$/.test(action.extensionRef || '') ||
      action.extension.sourcePin !== action.sourcePin || action.sourcePin !== SPECIAL_ORDERS_SOURCE_PIN ||
      canonical(action.params) !== canonical(proposal.params) || action.extension.loginResponseRef !== action.loginResponseRef)
    throw problem('SPECIAL_ORDER_PROPOSAL_INVALID', '宫廷或组团目标、事实或公开规则绑定无效', 400);
  if (['ownerRef','accountRef','subjectRef','ownerEpoch','runEpoch','connectionEpoch'].some(key =>
    action.factSnapshot.context?.[key] !== proposal[key]) || action.factSnapshot.fields?.uid?.state !== 'known' ||
      action.factSnapshot.fields.uid.value !== action.officialUid || action.factSnapshot.source?.connectionEpoch !== proposal.connectionEpoch)
    throw problem('SPECIAL_ORDER_PROPOSAL_INVALID', '宫廷或组团事实不属于原始主体和代次', 400);
  const { extensionRef, ...extensionBody } = action.extension;
  if ('sha256:' + fingerprint(extensionBody) !== extensionRef)
    throw problem('SPECIAL_ORDER_PROPOSAL_INVALID', '宫廷或组团公开规则原件指纹无效', 400);
  const { current, fingerprint: factFingerprint, ...factBody } = action.factSnapshot;
  if (fingerprint(factBody) !== factFingerprint)
    throw problem('SPECIAL_ORDER_PROPOSAL_INVALID', '宫廷或组团事实原件指纹无效', 400);
  return true;
}

export function specialOrderResponseCoverage({ proposal, response, observation, bridge } = {}) {
  const definition = Object.values(SPECIAL_ORDER_DEFINITIONS).find(one => one.method === proposal?.method && one.scope === proposal?.scope);
  return !!definition && response?.method === proposal.method && response.transport === 'answered' && typeof response.responseRef === 'string' &&
    observation?.method === 'index.login' && observation.source === 'response' && observation.transport === 'answered' &&
    observation.envelopeOk === true && observation.dsName === 'G.ISyncData' && observation.rejected !== true &&
    observation.responseRef === bridge?.newLoginObservation?.responseRef && bridge?.oldPhysicalCloseReceipt?.closed === true &&
    bridge.operationId === proposal.operationId && bridge.officialUid === proposal.specialOrder?.officialUid;
}
export const SPECIAL_ORDER_POST_READ = Object.freeze({ contractId: 'special-orders/after-close-login/v1', method: 'index.login',
  kind: 'after-close-login', args: Object.freeze({}), evidenceRef: 'special-orders/independent-order-and-inventory/v1',
  validateResponseCoverage: specialOrderResponseCoverage });
export function specialOrderAfterCloseLoginProof({ proposal, response, bridge } = {}) {
  const observation = bridge?.newLoginObservation;
  if (!specialOrderResponseCoverage({ proposal, response, observation, bridge }) ||
      observation.versionEvidence?.loginResponseRef !== observation.responseRef || bridge.newContext?.connectionEpoch !== observation.connectionEpoch)
    throw problem('SPECIAL_ORDER_POST_READ_BRIDGE_INVALID', '宫廷或组团后验登录身份与物理关闭证据不一致');
  return freeze({ version: 'special-orders/after-close-login/v1', operationId: proposal.operationId,
    oldLoginResponseRef: proposal.specialOrder.loginResponseRef, newLoginResponseRef: observation.responseRef,
    newLoginRequestSequence: observation.requestSequence, newLoginWireKey: observation.wireKey,
    newLoginConnectionEpoch: observation.connectionEpoch, postReadRef: observation.responseRef, officialUid: bridge.officialUid,
    leaseRef: bridge.leaseRef, bridgeFingerprint: bridge.bridgeFingerprint, oldConnectionEpoch: bridge.originalContext?.connectionEpoch,
    newConnectionEpoch: bridge.newContext?.connectionEpoch, oldPhysicalCloseReceipt: bridge.oldPhysicalCloseReceipt,
    newContext: bridge.newContext, extensionRef: proposal.specialOrder.extensionRef, writeResponseRef: response.responseRef });
}
export function specialOrderTargetVerification({ proposal, verification } = {}) {
  return verification?.verificationVersion === 'special-orders/target-postread/v1' &&
    verification.evidence?.targetRef === proposal?.targets?.[0]?.targetRef && verification.evidence?.kind === proposal?.specialOrder?.kind &&
    verification.evidence?.action === proposal?.specialOrder?.action && verification.evidence?.extensionRef === proposal?.specialOrder?.extensionRef;
}
