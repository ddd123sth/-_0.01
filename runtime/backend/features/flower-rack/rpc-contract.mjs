import { canonical, fingerprint, plainObject, problem } from '../../common.mjs';

export const FLOWER_RACK_CONTRACT_REF = 'flower-rack/official-actions/v1';
export const FLOWER_RACK_METHODS = Object.freeze({ unlock: 'flowerRack.unlockStand', sell: 'flowerRack.sell',
  receive: 'flowerRack.recvSellMoney', cancel: 'flowerRack.cancelSell' });
export const FLOWER_RACK_SCOPES = Object.freeze({ unlock: 'rack-unlock', sell: 'rack-sell', receive: 'rack-recv', cancel: 'rack-cancel' });
export const FLOWER_RACK_POST_READ = Object.freeze({ contractId: 'flower-rack/after-close-login/v1', method: 'index.login',
  kind: 'after-close-login', args: Object.freeze({}), evidenceRef: 'flower-rack/independent-rack-and-bag-state/v1',
  validateResponseCoverage: flowerRackResponseCoverage });

const positive = value => Number.isSafeInteger(value) && value > 0;
const definitions = Object.freeze({
  unlock: Object.freeze({ method: FLOWER_RACK_METHODS.unlock, scope: FLOWER_RACK_SCOPES.unlock, args: ['standId'] }),
  sell: Object.freeze({ method: FLOWER_RACK_METHODS.sell, scope: FLOWER_RACK_SCOPES.sell, args: ['rackId', 'iid', 'num'] }),
  receive: Object.freeze({ method: FLOWER_RACK_METHODS.receive, scope: FLOWER_RACK_SCOPES.receive, args: ['rackId'] }),
  cancel: Object.freeze({ method: FLOWER_RACK_METHODS.cancel, scope: FLOWER_RACK_SCOPES.cancel, args: ['rackId'] }),
});
export const FLOWER_RACK_DEFINITIONS = Object.freeze(Object.fromEntries(Object.entries(definitions).map(([kind, one]) => [kind,
  Object.freeze({ contractId: `${FLOWER_RACK_CONTRACT_REF}/${kind}`, featureId: 'flower-rack', scope: one.scope,
    method: one.method, targetKind: 'flower-rack', paramsContract: `flower-rack-${kind}/v1` })])));

export function captureFlowerRackArgs({ method, params } = {}) {
  const [kind, definition] = Object.entries(definitions).find(([, one]) => one.method === method) || [];
  if (!kind || !plainObject(params)) throw problem('FLOWER_RACK_ARGUMENT_CONTRACT_INVALID', '花架方法不在独立RPC合同中', 400);
  const expected = {};
  for (const key of definition.args) {
    const value = params[key];
    if (!positive(value)) throw problem('FLOWER_RACK_ARGUMENT_CONTRACT_INVALID', '花架参数必须是正整数', 400);
    expected[key] = value;
  }
  if (Object.keys(params).length !== definition.args.length || canonical(params) !== canonical(expected) ||
      kind === 'sell' && params.num > 12) throw problem('FLOWER_RACK_ARGUMENT_CONTRACT_INVALID', '花架参数字段或范围不符合官服合同', 400);
  return Object.freeze({ kind, method, params: Object.freeze(expected), paramsFingerprint: fingerprint(expected) });
}

export function assertFlowerRackProposal(proposal) {
  const kind = Object.keys(FLOWER_RACK_METHODS).find(key => FLOWER_RACK_METHODS[key] === proposal?.method);
  const captured = captureFlowerRackArgs({ method: proposal?.method, params: proposal?.params });
  const rack = proposal?.flowerRack, target = proposal?.targets?.[0];
  const expectedRef = `flower-rack:${proposal.subjectRef}:${rack?.targetKey}`;
  if (!kind || proposal.featureId !== 'flower-rack' || proposal.contractRef !== FLOWER_RACK_CONTRACT_REF ||
      proposal.scope !== FLOWER_RACK_SCOPES[kind] || proposal.paramsFingerprint !== captured.paramsFingerprint ||
      !plainObject(rack) || !positive(rack.officialUid) || !positive(rack.rackId) ||
      kind === 'unlock' && rack.artId !== null || kind !== 'unlock' && !positive(rack.artId) ||
      !Number.isSafeInteger(rack.quantity) || rack.quantity <= 0 || typeof rack.targetKey !== 'string' ||
      target?.targetKind !== 'flower-rack' || target.targetRef !== expectedRef ||
      target.memberKey !== 'flower-rack:' + fingerprint([rack.targetKey, kind === 'unlock' ? 0 : rack.artId]) ||
      target.targetFingerprint !== fingerprint({ targetRef: expectedRef, sourceRef: rack.sourceRef, extensionRef: rack.extensionRef }) ||
      captured.kind === 'sell' && rack.sortStrategy === 'max_price' && (!plainObject(rack.priceProof) ||
        rack.priceProof.version !== 'flower-rack/current-table-price/v2' || rack.priceProof.artId !== rack.artId ||
        !positive(rack.priceProof.currencyId) || !Number.isSafeInteger(rack.priceProof.amount) || rack.priceProof.amount < 0 ||
        !/^[a-f0-9]{64}$/.test(rack.priceProof.rowFingerprint || '') || !/^[a-f0-9]{64}$/.test(rack.priceProof.tableSha256 || '') ||
        !/^[a-f0-9]{64}$/.test(rack.priceProof.flowerTableSha256 || '') || !/^[a-f0-9]{64}$/.test(rack.priceProof.priceFactsFingerprint || '') ||
        !/^sha256:[a-f0-9]{64}$/.test(rack.priceProof.priceExtensionRef || '') ||
        rack.priceProof.priceRef !== 'flower-rack-price:' + fingerprint(Object.fromEntries(Object.entries(rack.priceProof).filter(([key]) => key !== 'priceRef')))) ||
      captured.kind === 'sell' && rack.sortStrategy !== 'max_price' && rack.priceProof != null ||
      !Array.isArray(proposal.targets) || proposal.targets.length !== 1 || !Array.isArray(proposal.resources) ||
      captured.kind === 'sell' && (captured.params.rackId !== rack.rackId || captured.params.iid !== rack.artId || captured.params.num !== rack.quantity) ||
      ['receive', 'cancel'].includes(captured.kind) && captured.params.rackId !== rack.rackId ||
      captured.kind === 'unlock' && captured.params.standId !== rack.rackId)
    throw problem('FLOWER_RACK_PROPOSAL_INVALID', '花架动作未绑定当前本人目标、架位与库存', 400);
  return true;
}

export function flowerRackResponseCoverage({ proposal, response, observation, bridge } = {}) {
  return FLOWER_RACK_METHODS[proposal?.flowerRack?.kind] === proposal?.method && response?.method === proposal.method &&
    response?.transport === 'answered' && typeof response?.responseRef === 'string' && response.responseRef.length > 0 &&
    observation?.method === 'index.login' && observation?.source === 'response' && observation?.transport === 'answered' &&
    observation?.envelopeOk === true && observation?.dsName === 'G.ISyncData' && observation?.rejected !== true &&
    bridge?.newLoginObservation?.responseRef === observation.responseRef && bridge?.oldPhysicalCloseReceipt?.closed === true &&
    bridge?.operationId === proposal?.operationId;
}

export function flowerRackAfterCloseLoginProof({ proposal, response, bridge } = {}) {
  const observation = bridge?.newLoginObservation;
  if (!flowerRackResponseCoverage({ proposal, response, observation, bridge }) ||
      observation?.versionEvidence?.loginResponseRef !== observation.responseRef || bridge?.officialUid !== proposal?.flowerRack?.officialUid ||
      bridge?.newContext?.connectionEpoch !== observation.connectionEpoch)
    throw problem('FLOWER_RACK_POST_READ_BRIDGE_INVALID', '花架后验登录未绑定本人、原写答复与物理关闭');
  return Object.freeze({ version: 'flower-rack/after-close-login/v1', operationId: proposal.operationId,
    oldLoginResponseRef: proposal.flowerRack.loginResponseRef, newLoginResponseRef: observation.responseRef,
    newLoginRequestSequence: observation.requestSequence, newLoginWireKey: observation.wireKey,
    newLoginConnectionEpoch: observation.connectionEpoch, postReadRef: observation.responseRef, officialUid: bridge.officialUid,
    leaseRef: bridge.leaseRef, bridgeFingerprint: bridge.bridgeFingerprint, oldConnectionEpoch: bridge.originalContext?.connectionEpoch,
    newConnectionEpoch: bridge.newContext?.connectionEpoch, oldPhysicalCloseReceipt: bridge.oldPhysicalCloseReceipt,
    newContext: bridge.newContext, extensionRef: proposal.flowerRack.extensionRef, writeResponseRef: response.responseRef });
}

export function flowerRackTargetVerification({ proposal, verification } = {}) {
  return verification?.verificationVersion === 'flower-rack/target-postread/v1' &&
    verification.evidence?.targetRef === proposal?.targets?.[0]?.targetRef &&
    verification.evidence?.extensionRef === proposal?.flowerRack?.extensionRef;
}
