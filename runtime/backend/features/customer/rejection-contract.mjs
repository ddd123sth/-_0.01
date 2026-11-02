import { clone, fingerprint, freeze, plainObject, problem } from '../../common.mjs';
import { customerDateMs } from './wire-facts.mjs';
import { assertCustomerPhysicalRejectCause } from './impossibility.mjs';
import { customerVersionFrameValid } from './rpc-contract.mjs';
import { currentOfficialDataEvidence } from '../../official-data-evidence.mjs';

export const CUSTOMER_REJECT_CONTRACT = Object.freeze({ contractId: 'customer-reject/single-v1', featureId: 'order.customer',
  scope: 'order-reject', method: 'orderCustomer.rejectOrder', targetKind: 'customer-order' });
export const CUSTOMER_REJECT_POST_READ = Object.freeze({ contractId: 'customer-reject-fresh-login/after-physical-close/v1',
  kind: 'after-close-login', method: 'index.login', args: {}, evidenceRef: 'g3a/normal-fresh-login/reject-original-order-and-no-delivery-effect/v1' });
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const FIELDS = Object.freeze(['dialogId', 'artId', 'num', 'pathId', 'cTime']);
const exactKeys = (value, keys) => plainObject(value) && fingerprint(Object.keys(value).sort()) === fingerprint([...keys].sort());
export function captureCustomerRejectArgs(input) {
  if (!exactKeys(input, ['npcId', 'guestNpcIdList']) || !positive(input.npcId) || !Array.isArray(input.guestNpcIdList) ||
    input.guestNpcIdList.length !== 0 || Object.keys(input.guestNpcIdList).length !== 0) throw problem('CUSTOMER_REJECT_ARGUMENT_CONTRACT_INVALID', '政策拒单仅允许当前真实NPC与明确空访客列表', 400);
  const params = clone(input);
  return freeze({ params, paramsFingerprint: fingerprint(params) });
}
export function assertCustomerRejectProposal(proposal) {
  const captured = captureCustomerRejectArgs(proposal?.params), customer = proposal.customer, target = proposal.targets?.[0];
  if (proposal.featureId !== 'order.customer' || proposal.scope !== 'order-reject' || proposal.method !== 'orderCustomer.rejectOrder' ||
    !reference(proposal.subjectRef) || captured.paramsFingerprint !== proposal.paramsFingerprint || !plainObject(customer) ||
    customer.npcId !== proposal.params.npcId || !positive(customer.artId) || customer.artId === 1002 || !positive(customer.need) ||
    !/^customer-life:[a-f0-9]{64}$/.test(customer.lifecycleRef) || !digest(customer.contentFingerprint) ||
    !(customer.rejectCause ? /^customer-decision:[a-f0-9]{64}$/.test(customer.acceptedDecisionRef) && !Object.hasOwn(customer, 'filteredDecisionRef')
      : /^customer-decision:[a-f0-9]{64}$/.test(customer.filteredDecisionRef)) || !digest(customer.policyFingerprint) ||
    !positive(customer.officialUid) || !(customer.versionEvidence?.gameVersion === '480.0.27' || currentOfficialDataEvidence(customer.versionEvidence, 'customer.reject')) ||
    customer.versionEvidence.protocolVersion !== '480.0.0' || !reference(customer.versionEvidence.loginResponseRef) ||
    !Array.isArray(proposal.targets) || proposal.targets.length !== 1 ||
    !exactKeys(target, ['memberKey', 'targetKind', 'targetRef', 'lifecycleRef', 'targetFingerprint']) ||
    target.memberKey !== 'customer:' + customer.lifecycleRef || target.targetKind !== 'customer-order' ||
    target.targetRef !== 'customer-order:' + proposal.subjectRef + ':' + customer.npcId || target.lifecycleRef !== customer.lifecycleRef ||
    target.targetFingerprint !== customer.contentFingerprint || ![ 'customer-reject:' + customer.lifecycleRef,
      'customer-reject:' + customer.lifecycleRef + ':' + customer?.currentNeed?.decisionGeneration ].includes(proposal.semanticKey) ||
    !Array.isArray(proposal.resources) || proposal.resources.length !== 0 || !Array.isArray(proposal.resourceBindings) || proposal.resourceBindings.length !== 0) {
    throw problem('CUSTOMER_REJECT_PROPOSAL_BINDING_INVALID', '政策拒单必须绑定原已知订单和过滤证明，且不预约任何交单成品', 400);
  }
  if (customer.rejectCause) assertCustomerPhysicalRejectCause({ cause: customer.rejectCause, customer, proposal });
  const currentNeed = customer.currentNeed;
  if (currentNeed !== undefined && (!currentNeed || currentNeed.necessary !== true || currentNeed.featureId !== proposal.featureId || currentNeed.targetRef !== target.targetRef ||
    !reference(currentNeed.businessNeedRef) || !digest(currentNeed.decisionGeneration) || !digest(currentNeed.semanticFingerprint) ||
    currentNeed.needRef !== 'current-need:' + fingerprint([proposal.featureId, target.targetRef, currentNeed.businessNeedRef]) ||
    !reference(currentNeed.claimRef) || !Array.isArray(currentNeed.basisRefs) || !currentNeed.basisRefs.length ||
    !currentNeed.basisRefs.every(reference) || !currentNeed.basisRefs.includes(customer.versionEvidence.loginResponseRef) ||
    ![ 'customer-reject:' + customer.lifecycleRef, 'customer-reject:' + customer.lifecycleRef + ':' + currentNeed.decisionGeneration ].includes(proposal.semanticKey))) {
    throw problem('CUSTOMER_REJECT_CURRENT_NEED_INVALID', '政策拒单必须绑定当前官服快照中的必要性判断', 400);
  }
  const before = customer.beforeOrder;
  if (!plainObject(before) || before.npcId !== customer.npcId || before.artId !== customer.artId || before.num !== customer.need ||
    !FIELDS.every(key => ['artId', 'num', 'cTime'].includes(key) ? positive(before[key]) : nonnegative(before[key])) ||
    customerDateMs(before.cTime) !== before.cTime || fingerprint({ npcId: before.npcId, fields: Object.fromEntries(FIELDS.map(key =>
      [key, { presence: 'present', state: 'known', value: before[key] }])) }) !== customer.contentFingerprint) {
    throw problem('CUSTOMER_REJECT_ORIGINAL_ORDER_REQUIRED', '拒单须保全原订单五字段及其内容指纹', 400);
  }
  const source = one => (one?.kind ?? one?.sourceKind ?? one?.source) === 'response' && one.connectionEpoch === proposal.connectionEpoch &&
    positive(one.requestSequence) && reference(one.responseRef) && reference(one.wireKey) && reference(one.method);
  const items = customer.beforeItems, profile = customer.beforeProfile;
  if (!Array.isArray(items) || items.length !== 2 || new Set(items.map(one => one.itemId)).size !== 2 ||
    !items.every(one => [customer.artId, 1002].includes(one.itemId) && nonnegative(one.quantity) && reference(one.basisRef) && source(one.source)) ||
    !plainObject(profile) || !nonnegative(profile.gold) || !nonnegative(profile.yb) ||
    !source(profile.goldSource) || !source(profile.ybSource)) {
    throw problem('CUSTOMER_REJECT_ORIGINAL_BALANCES_REQUIRED', '拒单前须保全真实成品、花坊币、金币和元宝绝对余额来源', 400);
  }
  return captured;
}
export function customerRejectAfterCloseLoginProof({ proposal, response, bridge } = {}) {
  assertCustomerRejectProposal(proposal);
  const axes = ['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch'];
  const originalContext = Object.fromEntries(axes.map(key => [key, proposal[key]]));
  const same = (a, b, keys) => !!a && !!b && keys.every(key => a[key] === b[key]);
  const after = { connectionEpoch: response?.connectionEpoch, requestSequence: response?.requestSequence,
    wireKey: response?.wireKey, responseRef: response?.responseRef };
  const observed = bridge?.newLoginObservation, current = bridge?.newContext, closed = bridge?.oldPhysicalCloseReceipt;
  const expected = proposal.customer.versionEvidence, version = observed?.versionEvidence, oldLogin = bridge?.oldLoginSource;
  if (proposal.operationDescriptor?.postRead?.kind !== 'after-close-login' || proposal.operationDescriptor.postRead.method !== 'index.login' ||
    !reference(bridge?.leaseRef) || bridge.operationId !== proposal.operationId || !digest(bridge.bridgeFingerprint) ||
    !same(bridge.originalContext, originalContext, axes) || !same(bridge.after, after, Object.keys(after)) ||
    !same(current, originalContext, axes.filter(key => key !== 'connectionEpoch')) || !positive(current?.connectionEpoch) ||
    current.connectionEpoch <= originalContext.connectionEpoch || response?.transport !== 'answered' || response.method !== 'orderCustomer.rejectOrder' ||
    after.connectionEpoch !== originalContext.connectionEpoch || !positive(after.requestSequence) || !reference(after.wireKey) || !reference(after.responseRef) ||
    closed?.closed !== true || closed.connectionEpoch !== originalContext.connectionEpoch || !reference(closed.closureEvidenceRef) ||
    observed?.source !== 'response' || observed.transport !== 'answered' || observed.method !== 'index.login' ||
    observed.connectionEpoch !== current.connectionEpoch || !positive(observed.requestSequence) || !reference(observed.wireKey) || !reference(observed.responseRef) ||
    observed.envelopeOk !== true || observed.dsName !== 'G.ISyncData' || observed.rejected === true ||
    !positive(bridge.officialUid) || bridge.officialUid !== proposal.customer.officialUid || observed.value?.['7']?.['0']?.['0'] !== bridge.officialUid ||
    oldLogin?.method !== 'index.login' || oldLogin.connectionEpoch !== originalContext.connectionEpoch || oldLogin.officialUid !== bridge.officialUid ||
    oldLogin.responseRef !== expected.loginResponseRef || oldLogin.versionEvidence?.gameVersion !== expected.gameVersion ||
    !customerVersionFrameValid(oldLogin, expected, originalContext, bridge.officialUid) || version?.gameVersion !== expected.gameVersion ||
    version?.protocolVersion !== expected.protocolVersion || version?.loginResponseRef !== observed.responseRef ||
    !customerVersionFrameValid(observed, version, current, bridge.officialUid)) throw problem('CUSTOMER_REJECT_AFTER_CLOSE_BRIDGE_INVALID', '原拒单与真实关闭后的同主体正常登录证据不匹配');
  return freeze({ version: 'customer-reject-after-close-login/v1', leaseRef: bridge.leaseRef, operationId: proposal.operationId,
    originalContext, newContext: Object.fromEntries(axes.map(key => [key, current[key]])), after, bridgeFingerprint: bridge.bridgeFingerprint,
    oldPhysicalCloseReceipt: { closed: true, connectionEpoch: closed.connectionEpoch, closureEvidenceRef: closed.closureEvidenceRef },
    newLogin: { method: 'index.login', responseRef: observed.responseRef, connectionEpoch: observed.connectionEpoch,
      requestSequence: observed.requestSequence, wireKey: observed.wireKey, gameVersion: version.gameVersion,
      protocolVersion: version.protocolVersion, loginResponseRef: version.loginResponseRef }, officialUid: bridge.officialUid });
}
