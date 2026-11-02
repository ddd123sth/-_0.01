import { clone, fingerprint, freeze, plainObject, problem } from '../../common.mjs';
import { currentOfficialDataEvidence } from '../../official-data-evidence.mjs';
import { officialActionContractId } from '../../official-version-profile.mjs';
import { verifyOfficialServerVersionFrame } from '../../official-server-version-contract.mjs';

export const CUSTOMER_FINISH_CONTRACT = Object.freeze({ contractId: 'customer-finish/single-v1',
  featureId: 'order.customer', scope: 'order-customer', method: 'orderCustomer.finishOrder', targetKind: 'customer-order' });
const positive = value => Number.isSafeInteger(value) && value > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const keysAre = (value, expected) => plainObject(value) && fingerprint(Object.keys(value).sort()) === fingerprint([...expected].sort());
export function customerVersionFrameValid(source, versionEvidence, context, officialUid) {
  if (!versionEvidence || !positive(officialUid) || source?.officialUid != null && source.officialUid !== officialUid) return false;
  const frameProtocol = source?.protocolVersion ?? source?.frameProtocolVersion ?? source?.reportedServerVersion ??
    source?.frameReportedServerVersion ?? source?.versionEvidence?.reportedServerVersion ?? source?.versionEvidence?.protocolVersion ??
    versionEvidence.reportedServerVersion ?? versionEvidence.protocolVersion;
  const reported = source?.reportedServerVersion ?? source?.frameReportedServerVersion ?? source?.versionEvidence?.reportedServerVersion ?? frameProtocol;
  return verifyOfficialServerVersionFrame({ versionEvidence, frameProtocolVersion: frameProtocol,
    frameReportedServerVersion: reported, context, officialUid });
}
const loginVersionFrameValid = (login, versionEvidence, context, officialUid) =>
  versionEvidence?.loginResponseRef === login?.responseRef && customerVersionFrameValid(login, versionEvidence, context, officialUid);
const customerFinishLoginCompatible = (oldVersion, newVersion) => {
  if (!oldVersion || !newVersion || oldVersion.protocolVersion !== '480.0.0' || newVersion.protocolVersion !== oldVersion.protocolVersion) return false;
  if (oldVersion.gameVersion === '480.0.27' && newVersion.gameVersion === '480.0.27') return true;
  if (oldVersion.gameVersion === '480.0.27' || newVersion.gameVersion === '480.0.27' ||
      !currentOfficialDataEvidence(oldVersion, 'customer.finish') || !currentOfficialDataEvidence(newVersion, 'customer.finish')) return false;
  const oldProof = oldVersion.sourceProofs?.['customer.finish'], newProof = newVersion.sourceProofs?.['customer.finish'];
  const blocks = proof => {
    if (!Array.isArray(proof?.matchedBlocks) || proof.matchedBlocks.length === 0 || proof.matchedBlocks.length > 64) return null;
    const values = proof.matchedBlocks.map(({ name, byteLength, sha256 }) => ({ name, byteLength, sha256 }));
    if (values.some(one => typeof one.name !== 'string' || !one.name || one.name.length > 96 ||
      !Number.isSafeInteger(one.byteLength) || one.byteLength < 1 || !/^[a-f0-9]{64}$/.test(one.sha256 || '')) ||
      new Set(values.map(one => one.name)).size !== values.length) return null;
    return values.sort((a,b) => a.name.localeCompare(b.name));
  };
  const oldBlocks = blocks(oldProof), newBlocks = blocks(newProof);
  return !!oldProof && !!newProof && oldProof.actionContractId === officialActionContractId('customer.finish') &&
    newProof.actionContractId === oldProof.actionContractId && oldProof.sourceVersion === oldVersion.gameVersion &&
    newProof.sourceVersion === newVersion.gameVersion && oldProof.protocolVersion === newVersion.protocolVersion &&
    !!oldBlocks && !!newBlocks && fingerprint(oldBlocks) === fingerprint(newBlocks);
};

// This first contract deliberately has no visitor synthesis, partial delivery,
// generation/rejection, optional raw args, or multiple-order expansion.
export function captureCustomerFinishArgs(input) {
  if (!keysAre(input, ['npcId', 'guestNpcIdList']) || !positive(input.npcId) ||
    !Array.isArray(input.guestNpcIdList) || input.guestNpcIdList.length !== 0 || Object.keys(input.guestNpcIdList).length !== 0) {
    throw problem('CUSTOMER_FINISH_ARGUMENT_CONTRACT_INVALID', '首批顾客交付仅允许真实NPC与明确空访客列表', 400);
  }
  const params = clone(input);
  return freeze({ params, paramsFingerprint: fingerprint(params) });
}

export function assertCustomerFinishProposal(proposal) {
  const captured = captureCustomerFinishArgs(proposal?.params), definition = CUSTOMER_FINISH_CONTRACT;
  if (proposal.featureId !== definition.featureId || proposal.scope !== definition.scope || proposal.method !== definition.method ||
    !reference(proposal.subjectRef) || !Array.isArray(proposal.targets) || proposal.targets.length !== 1 ||
    captured.paramsFingerprint !== proposal.paramsFingerprint) throw problem('CUSTOMER_FINISH_PROPOSAL_CONTRACT_INVALID', '顾客单笔方法、范围或参数绑定不一致', 400);
  const target = proposal.targets[0], customer = proposal.customer;
  if (!keysAre(target, ['memberKey', 'targetKind', 'targetRef', 'lifecycleRef', 'targetFingerprint']) ||
    target.targetKind !== definition.targetKind || !/^customer-life:[a-f0-9]{64}$/.test(target.lifecycleRef) ||
    target.targetRef !== 'customer-order:' + proposal.subjectRef + ':' + captured.params.npcId ||
    target.memberKey !== 'customer:' + target.lifecycleRef || !digest(target.targetFingerprint) ||
    ![ 'customer-finish:' + target.lifecycleRef, 'customer-finish:' + target.lifecycleRef + ':' + customer?.currentNeed?.decisionGeneration ].includes(proposal.semanticKey) || !plainObject(customer) ||
    customer.npcId !== captured.params.npcId || customer.lifecycleRef !== target.lifecycleRef ||
    customer.contentFingerprint !== target.targetFingerprint || !positive(customer.artId) || !positive(customer.need) ||
    !/^customer-decision:[a-f0-9]{64}$/.test(customer.acceptedDecisionRef) ||
    !/^customer-allocation:[a-f0-9]{64}$/.test(customer.allocationRef)) {
    throw problem('CUSTOMER_FINISH_TARGET_BINDING_INVALID', '顾客提案缺少原订单身份、接受或分配引用', 400);
  }
  if (!Array.isArray(proposal.resources) || proposal.resources.length !== 1 || !Array.isArray(proposal.resourceBindings) || proposal.resourceBindings.length !== 1) {
    throw problem('CUSTOMER_FINISH_RESOURCE_BINDING_INVALID', '单订单须有且仅有一份真实成品预约', 400);
  }
  const currentNeed = customer.currentNeed;
  if (currentNeed !== undefined && (!plainObject(currentNeed) || currentNeed.necessary !== true || currentNeed.featureId !== proposal.featureId ||
    currentNeed.targetRef !== proposal.targets[0].targetRef || !reference(currentNeed.businessNeedRef) || !digest(currentNeed.decisionGeneration) ||
    !digest(currentNeed.semanticFingerprint) || currentNeed.needRef !== 'current-need:' + fingerprint([proposal.featureId, proposal.targets[0].targetRef, currentNeed.businessNeedRef]) ||
    !reference(currentNeed.claimRef) || !Array.isArray(currentNeed.basisRefs) || !currentNeed.basisRefs.includes(customer.versionEvidence?.loginResponseRef) ||
    !currentNeed.basisRefs.includes(customer.beforeStock?.basisRef) ||
    ![ 'customer-finish:' + target.lifecycleRef, 'customer-finish:' + target.lifecycleRef + ':' + currentNeed.decisionGeneration ].includes(proposal.semanticKey))) throw problem('CUSTOMER_FINISH_CURRENT_NEED_INVALID', '顾客交付须绑定当前必要性与绝对库存依据', 400);
  const resource = proposal.resources[0], binding = proposal.resourceBindings[0];
  if (!plainObject(resource) || !plainObject(binding) || resource.resourceKind !== 'item' || resource.resourceRef !== 'item:' + customer.artId ||
    resource.quantity !== customer.need || !reference(resource.resourceKey) || !reference(resource.basisRef) || !reference(resource.accountingRef) ||
    binding.resourceKey !== resource.resourceKey || binding.memberKey !== target.memberKey || binding.quantity !== customer.need) {
    throw problem('CUSTOMER_FINISH_RESOURCE_BINDING_INVALID', '成品预约必须精确绑定原单数量与成员', 400);
  }
  if (proposal.operationDescriptor?.postRead?.kind === 'after-close-login' && (!positive(customer.officialUid) ||
    customer.versionEvidence?.protocolVersion !== '480.0.0' ||
    !(customer.versionEvidence?.gameVersion === '480.0.27' || currentOfficialDataEvidence(customer.versionEvidence, 'customer.finish')) ||
    !reference(customer.versionEvidence?.loginResponseRef))) {
    throw problem('CUSTOMER_FINISH_LOGIN_BASIS_REQUIRED', '跨连接后验需要原正常登录的主体与版本依据', 400);
  }
  return captured;
}

// This pure projection proves packet bindings only. The supervisor must still
// verify the immutable lease/close/login receipts against its private state.
// No raw ISyncData, credentials, token, or remote text enters this proof.
export function customerAfterCloseLoginProof({ proposal, response, bridge } = {}) {
  assertCustomerFinishProposal(proposal);
  const originalContext = Object.fromEntries(['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch'].map(key => [key, proposal[key]]));
  const same = (a, b, keys) => !!a && !!b && keys.every(key => a[key] === b[key]);
  const axes = Object.keys(originalContext), stableAxes = axes.filter(key => key !== 'connectionEpoch');
  const after = { connectionEpoch: response?.connectionEpoch, requestSequence: response?.requestSequence,
    wireKey: response?.wireKey, responseRef: response?.responseRef };
  const current = bridge?.newContext, closed = bridge?.oldPhysicalCloseReceipt, observed = bridge?.newLoginObservation;
  const expected = proposal.customer.versionEvidence, version = observed?.versionEvidence, oldLogin = bridge?.oldLoginSource;
  if (proposal.operationDescriptor?.postRead?.kind !== 'after-close-login' || proposal.operationDescriptor.postRead.method !== 'index.login' ||
    !reference(bridge?.leaseRef) || bridge.operationId !== proposal.operationId || !digest(bridge.bridgeFingerprint) ||
    !same(bridge.originalContext, originalContext, axes) || !same(bridge.after, after, Object.keys(after)) ||
    !same(current, originalContext, stableAxes) || !positive(current?.connectionEpoch) || current.connectionEpoch <= originalContext.connectionEpoch ||
    response?.transport !== 'answered' || response?.method !== CUSTOMER_FINISH_CONTRACT.method ||
    after.connectionEpoch !== originalContext.connectionEpoch || !positive(after.requestSequence) || !reference(after.wireKey) || !reference(after.responseRef) ||
    closed?.closed !== true || closed.connectionEpoch !== originalContext.connectionEpoch || !reference(closed.closureEvidenceRef) ||
    observed?.source !== 'response' || observed.transport !== 'answered' || observed.method !== 'index.login' ||
    observed.connectionEpoch !== current.connectionEpoch || !positive(observed.requestSequence) || !reference(observed.wireKey) || !reference(observed.responseRef) ||
    observed.envelopeOk !== true || observed.dsName !== 'G.ISyncData' || observed.rejected === true ||
    !positive(bridge.officialUid) || bridge.officialUid !== proposal.customer.officialUid ||
    observed.value?.['7']?.['0']?.['0'] !== bridge.officialUid || !expected ||
    oldLogin?.method !== 'index.login' || oldLogin.connectionEpoch !== originalContext.connectionEpoch ||
    oldLogin.officialUid !== bridge.officialUid || oldLogin.responseRef !== expected.loginResponseRef ||
    oldLogin.versionEvidence?.gameVersion !== expected.gameVersion ||
    !loginVersionFrameValid(oldLogin, expected, originalContext, bridge.officialUid) ||
    !loginVersionFrameValid(observed, version, current, bridge.officialUid) || !customerFinishLoginCompatible(expected, version) ||
    version?.loginResponseRef !== observed.responseRef) {
    throw problem('CUSTOMER_AFTER_CLOSE_LOGIN_BRIDGE_INVALID', '原交付与真实关闭后的同主体登录证据不匹配');
  }
  return freeze({ version: 'customer-after-close-login/v1', leaseRef: bridge.leaseRef, operationId: proposal.operationId,
    originalContext, newContext: Object.fromEntries(axes.map(key => [key, current[key]])), after, bridgeFingerprint: bridge.bridgeFingerprint,
    oldPhysicalCloseReceipt: { closed: true, connectionEpoch: closed.connectionEpoch, closureEvidenceRef: closed.closureEvidenceRef },
    newLogin: { responseRef: observed.responseRef, method: 'index.login', connectionEpoch: observed.connectionEpoch,
      requestSequence: observed.requestSequence, wireKey: observed.wireKey, gameVersion: version.gameVersion,
      protocolVersion: version.protocolVersion, loginResponseRef: version.loginResponseRef }, officialUid: bridge.officialUid });
}
