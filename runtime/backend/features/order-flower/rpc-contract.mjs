import { verifyOfficialSourceVersionFrame } from '../../official-server-version-contract.mjs';
import { canonical, clone, fingerprint, freeze, plainObject, problem } from '../../common.mjs';
import { ORDER_FLOWER_AXES, orderFlowerContext, orderFlowerSourceProofValid, sameOrderFlowerContext } from './wire-facts.mjs';
import { ORDER_FLOWER_LEVEL_REWARD_ITEM_IDS } from './level-catalog.mjs';
import { isNormalSyncMethod } from '../../facts/normal-sync-contract.mjs';
import { assertOrderFlowerStoredPreparation } from './stored-contract.mjs';

export const ORDER_FLOWER_CONTRACTS = freeze(Object.fromEntries([
  ['resident', 'order.resident', 'order-resident', 'orderFlower.finishOrder', 105, 0, 11],
  ['satin', 'order.satin', 'order-satin', 'orderFlower.finishSatinOrder', 109, 1, 1106],
  ['decorate', 'order.decorate', 'order-decorate', 'orderFlower.finishDecorateOrder', 116, 1, 1340]
].map(([kind, featureId, scope, method, counterId, countOffset, rewardItemId]) => [kind, {
  kind, featureId, scope, method, counterId, countOffset, rewardItemId, targetKind: 'flower-order',
  contractId: 'order-flower-' + kind + '/ordinary-single-v1' }])));
export const ORDER_FLOWER_POST_READ = freeze({ contractId: 'order-flower-fresh-login/after-physical-close/v1', kind: 'after-close-login',
  method: 'index.login', args: {}, evidenceRef: 'g4/normal-fresh-login/provided-105-counter-and-absolute-bag/v1' });
export const ORDER_FLOWER_CURRENT_NEED_CONTRACT = freeze({ path: 'orderFlower.currentNeed', required: true });
export const orderFlowerAdmittedContract = definition => freeze({ ...definition, currentNeed: ORDER_FLOWER_CURRENT_NEED_CONTRACT,
  postRead: ORDER_FLOWER_POST_READ });
export const orderFlowerAdmittedContractMatches = (actual, definition) => canonical(actual) === canonical(orderFlowerAdmittedContract(definition));
export const orderFlowerHistoricalAdmittedContractMatches = (actual, definition) => orderFlowerAdmittedContractMatches(actual, definition) ||
  canonical(actual) === canonical({ ...definition, postRead: ORDER_FLOWER_POST_READ });
export function assertOrderFlowerImmutableEvidence({ admitted, prepared, definition, original } = {}) {
  if (!definition || !orderFlowerAdmittedContractMatches(admitted, definition) ||
      prepared?.domain !== 'order-flower-' + definition.kind || prepared.preparation?.kind !== definition.kind ||
      original?.featureId !== definition.featureId || original?.scope !== definition.scope || original?.method !== definition.method) {
    throw problem('ORDER_FLOWER_IMMUTABLE_EVIDENCE_INVALID', '普通订单不可变准入证据或准备证据不匹配');
  }
  const proposal = { ...original, orderFlower: prepared.preparation,
    params: definition.kind === 'resident' ? { boxId: prepared.preparation.boxId } : {} };
  assertOrderFlowerProposal(proposal);
  assertOrderFlowerStoredPreparation(proposal);
  return proposal;
}
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => plainObject(value) && canonical(Object.keys(value).sort()) === canonical([...keys].sort());
export function orderFlowerRequirements(flowers) {
  if (!Array.isArray(flowers) || flowers.length < 1 || flowers.length > 16 || !flowers.every(one =>
    Array.isArray(one) && one.length === 2 && positive(one[0]) && positive(one[1]))) return null;
  const totals = new Map();
  for (const [id, amount] of flowers) { const n = (totals.get(id) || 0) + amount; if (!positive(n)) return null; totals.set(id, n); }
  return [...totals].sort((a, b) => a[0] - b[0]).map(([itemId, quantity]) => ({ itemId, quantity }));
}
export function orderFlowerContent(kind, boxId, fields) {
  const names = ['npcId', 'dialogId', 'flowers', 'isVideo', 'cTime', kind === 'resident' ? 'placeIdx' : 'finishCnt'];
  return { kind, boxId, fields: Object.fromEntries(names.map(key => [key, fields?.[key] ?? null])) };
}
export function orderFlowerLife(context, kind, boxId, fields) {
  return 'order-flower-life:' + fingerprint({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
    content: orderFlowerContent(kind, boxId, fields) });
}
const ACTION_FOR_KIND = Object.freeze({ resident: 'order.resident', satin: 'order.satin', decorate: 'order.decorate' });
const SAFE_ACTION_PROOF_FIELDS = Object.freeze(['supported', 'sourceVersion', 'protocolVersion', 'actionContractId', 'gameSha256', 'moSha256']);
export const orderFlowerSafeSource = (source, actionKind = null, boundVersion = null) => source ? { kind: source.kind ?? source.sourceKind ?? source.source ?? null,
  method: source.method ?? null, connectionEpoch: source.connectionEpoch ?? null, requestSequence: source.requestSequence ?? null,
  responseRef: source.responseRef ?? null, wireKey: source.wireKey ?? null,
  ...(source.version ? { version: { gameVersion: source.version.gameVersion ?? null,
    protocolVersion: source.version.protocolVersion ?? null, loginResponseRef: source.version.loginResponseRef ?? null,
    ...(ACTION_FOR_KIND[actionKind] && source.version.gameVersion === boundVersion?.gameVersion &&
      source.version.protocolVersion === boundVersion?.protocolVersion && source.version.loginResponseRef === boundVersion?.loginResponseRef &&
      plainObject(boundVersion?.sourceProofs?.[ACTION_FOR_KIND[actionKind]]) ? {
      sourceProofs: { [ACTION_FOR_KIND[actionKind]]: Object.fromEntries(SAFE_ACTION_PROOF_FIELDS
        .filter(key => boundVersion.sourceProofs[ACTION_FOR_KIND[actionKind]][key] !== undefined)
        .map(key => [key, boundVersion.sourceProofs[ACTION_FOR_KIND[actionKind]][key]])) }
    } : {}) } } : {}) } : null;
export function captureOrderFlowerArgs(kind, params) {
  if (!ORDER_FLOWER_CONTRACTS[kind] || !exact(params, kind === 'resident' ? ['boxId'] : []) ||
    kind === 'resident' && (!positive(params.boxId) || params.boxId > 6)) throw problem('ORDER_FLOWER_ARGUMENT_CONTRACT_INVALID', '普通鲜花订单仅允许已核单箱参数', 400);
  return freeze({ params: clone(params), paramsFingerprint: fingerprint(params) });
}
export function assertOrderFlowerProposal(proposal) {
  const order = proposal?.orderFlower, definition = ORDER_FLOWER_CONTRACTS[order?.kind], context = orderFlowerContext(proposal);
  const captured = captureOrderFlowerArgs(order?.kind, proposal?.params), before = order?.beforeOrder, target = proposal?.targets?.[0];
  const requirements = orderFlowerRequirements(before?.flowers), memberKey = 'order-flower:' + order?.lifecycleRef;
  const beforeSource = source => source?.kind === 'response' && source.connectionEpoch === context?.connectionEpoch &&
    positive(source.requestSequence) && reference(source.wireKey) && reference(source.responseRef) && isNormalSyncMethod(source.method);
  const loginAnchoredSource = source => beforeSource(source) && orderFlowerSourceProofValid(source.version, order?.kind) &&
    source.version?.protocolVersion === order?.versionEvidence?.protocolVersion && source.version?.gameVersion === order?.versionEvidence?.gameVersion &&
    source.version?.loginResponseRef === order?.versionEvidence?.loginResponseRef;
  const sourceFailures = [];
  const checkProofSource = (name, source) => {
    const action = ACTION_FOR_KIND[order?.kind], capsule = source?.version?.sourceProofs?.[action], anchor = order?.versionEvidence?.sourceProofs?.[action];
    const legacy = order?.versionEvidence?.gameVersion === '480.0.27' && order?.versionEvidence?.protocolVersion === '480.0.0';
    const capsuleMatchesAnchor = legacy || plainObject(capsule) && plainObject(anchor) && SAFE_ACTION_PROOF_FIELDS.every(key => capsule[key] === anchor[key]);
    if (!beforeSource(source) || !orderFlowerSourceProofValid(source.version, order?.kind) || !capsuleMatchesAnchor ||
        source.version?.protocolVersion !== order?.versionEvidence?.protocolVersion ||
        source.version?.gameVersion !== order?.versionEvidence?.gameVersion ||
        source.version?.loginResponseRef !== order?.versionEvidence?.loginResponseRef) {
      const proof = capsule;
      const actualType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
      sourceFailures.push({ gate: name, path: name + '.version.sourceProofs.' + (ACTION_FOR_KIND[order?.kind] || 'unknown'),
        actualType: proof && plainObject(proof) && plainObject(anchor) && !capsuleMatchesAnchor ? 'mismatch' : actualType(proof) });
    }
  };
  checkProofSource('order.counter.source', order?.counter?.source);
  checkProofSource('order.beforeGenerationCounter.source', order?.beforeGenerationCounter?.source);
  for (let index = 0; Array.isArray(order?.beforeOtherCounters) && index < Math.min(2, order.beforeOtherCounters.length); index++)
    checkProofSource('order.beforeOtherCounters[' + index + '].source', order.beforeOtherCounters[index]?.source);
  if (sourceFailures.length) throw problem('ORDER_FLOWER_PROPOSAL_BINDING_INVALID', '普通订单来源证明不完整', 400,
    { diagnosticVersion: 'order-flower-proposal-binding/v1', failedGateNames: sourceFailures.map(one => one.gate), failedPaths: sourceFailures });
  const currentNeed = order?.currentNeed, baseSemanticKey = 'order-flower-finish:' + order?.lifecycleRef;
  const currentNeedValid = currentNeed === undefined || plainObject(currentNeed) && currentNeed.necessary === true &&
    currentNeed.featureId === proposal?.featureId && currentNeed.targetRef === 'flower-order:' + context?.subjectRef + ':' + order?.kind + ':' + order?.boxId &&
    reference(currentNeed.businessNeedRef) && currentNeed.needRef === 'current-need:' + fingerprint([proposal?.featureId, currentNeed.targetRef, currentNeed.businessNeedRef]) &&
    digest(currentNeed.decisionGeneration) && digest(currentNeed.semanticFingerprint) && reference(currentNeed.claimRef) &&
    Array.isArray(currentNeed.basisRefs) && currentNeed.basisRefs.includes(order?.versionEvidence?.loginResponseRef);
  const semanticKeyValid = proposal?.semanticKey === baseSemanticKey || currentNeed !== undefined &&
    proposal?.semanticKey === baseSemanticKey + ':current-need:' + currentNeed.decisionGeneration;
  if (!context || !definition || proposal.featureId !== definition.featureId || proposal.scope !== definition.scope || proposal.method !== definition.method ||
    captured.paramsFingerprint !== proposal.paramsFingerprint || order.boxId !== (order.kind === 'resident' ? captured.params.boxId : order.kind === 'satin' ? 7 : 8) ||
    !positive(order.officialUid) || !plainObject(before) || !positive(before.npcId) || !nonnegative(before.dialogId) ||
    !positive(before.cTime) || ![false, 0].includes(before.isVideo) || !nonnegative(before[order.kind === 'resident' ? 'placeIdx' : 'finishCnt']) ||
    !(before.cdTime === null || positive(before.cdTime)) || !requirements || !beforeSource(order.source) ||
    order.lifecycleRef !== orderFlowerLife(context, order.kind, order.boxId, before) ||
    order.contentFingerprint !== fingerprint(orderFlowerContent(order.kind, order.boxId, before)) ||
    !Array.isArray(proposal.targets) || proposal.targets.length !== 1 || !exact(target, ['memberKey', 'targetKind', 'targetRef', 'lifecycleRef', 'targetFingerprint']) ||
    target.memberKey !== memberKey || target.targetKind !== definition.targetKind || target.targetRef !== 'flower-order:' + context.subjectRef + ':' + order.kind + ':' + order.boxId ||
    target.lifecycleRef !== order.lifecycleRef || target.targetFingerprint !== order.contentFingerprint || !semanticKeyValid || !currentNeedValid ||
    !orderFlowerSourceProofValid(order.versionEvidence, order.kind) || order.versionEvidence.protocolVersion !== '480.0.0' ||
    order.source.version?.loginResponseRef !== order.versionEvidence.loginResponseRef ||
    !Array.isArray(order.beforeItems) || order.beforeItems.length !== requirements.length ||
    !Array.isArray(proposal.resources) || proposal.resources.length !== requirements.length ||
    !Array.isArray(proposal.resourceBindings) || proposal.resourceBindings.length !== requirements.length ||
    new Set(proposal.resources.map(one => one.resourceKey)).size !== requirements.length ||
    !order.beforeItems.every(one => requirements.some(need => one.itemId === need.itemId) && nonnegative(one.quantity) && reference(one.basisRef) && beforeSource(one.source)) ||
    !requirements.every(need => proposal.resources.filter(one => one.resourceKind === 'item' && one.resourceRef === 'item:' + need.itemId && one.quantity === need.quantity &&
      one.basisRef === order.beforeItems.find(item => item.itemId === need.itemId)?.basisRef && reference(one.accountingRef) && reference(one.resourceKey)).length === 1) ||
    !proposal.resources.every(one => proposal.resourceBindings.filter(binding => binding.resourceKey === one.resourceKey && binding.memberKey === memberKey && binding.quantity === one.quantity).length === 1) ||
    !nonnegative(order.beforeProfile?.gold) || !nonnegative(order.beforeProfile?.yb) || !beforeSource(order.beforeProfile?.source) ||
    !positive(order.beforeProfile?.level) || !nonnegative(order.beforeProfile?.lvlExp) ||
    !['gold', 'yb', 'level', 'lvlExp'].every(key => beforeSource(order.beforeProfile?.sources?.[key])) ||
    !nonnegative(order.beforeRewards?.satin) || !nonnegative(order.beforeRewards?.decorate) || !beforeSource(order.beforeRewards?.source) ||
    !['satin', 'decorate'].every(key => beforeSource(order.beforeRewards?.sources?.[key])) ||
    !Array.isArray(order.beforeLevelRewardItems) || order.beforeLevelRewardItems.length !== ORDER_FLOWER_LEVEL_REWARD_ITEM_IDS.length ||
    new Set(order.beforeLevelRewardItems.map(one => one?.itemId)).size !== ORDER_FLOWER_LEVEL_REWARD_ITEM_IDS.length ||
    !order.beforeLevelRewardItems.every(one => ORDER_FLOWER_LEVEL_REWARD_ITEM_IDS.includes(one?.itemId) && nonnegative(one.quantity) && beforeSource(one.source)) ||
    !digest(order.eligibilityFingerprint) || !order.counter?.known || order.counter.counterId !== definition.counterId ||
    !nonnegative(order.counter.raw) || !nonnegative(order.counter.total) || !nonnegative(order.counter.value) || !positive(order.counter.rawRTime) || !loginAnchoredSource(order.counter.source) ||
    order.day?.known !== true ||
    order.day.source?.responseRef !== order.versionEvidence?.loginResponseRef || order.day.source?.method !== 'index.login' || !positive(order.day?.startMs) ||
    order.day.endMs - order.day.startMs !== 86400000 || !reference(order.day.proofRef) || !nonnegative(order.limit) || order.limit < 1 ||
    !nonnegative(order.keepPolicy?.keep) || order.keepPolicy.known !== true || !reference(order.keepPolicy.policyRef) ||
    order.occurrence?.identityKnown !== true || order.occurrence.lifecycleRef !== order.lifecycleRef ||
    order.occurrence.contentFingerprint !== order.contentFingerprint || order.occurrence.kind !== order.kind || order.occurrence.boxId !== order.boxId ||
    !sameOrderFlowerContext(order.occurrence.context, context) || order.occurrence.source?.responseRef !== order.source.responseRef ||
    order.beforeGenerationCounter?.uid !== order.officialUid || order.beforeGenerationCounter.type !== 107 ||
    !nonnegative(order.beforeGenerationCounter.raw) || !nonnegative(order.beforeGenerationCounter.totCnt) || !positive(order.beforeGenerationCounter.rTime) ||
    !loginAnchoredSource(order.beforeGenerationCounter.source) ||
    !Array.isArray(order.beforeOtherCounters) || order.beforeOtherCounters.length > 2 ||
    !order.beforeOtherCounters.every(one => [105, 109, 116].includes(one.type) && one.type !== definition.counterId &&
      one.uid === order.officialUid && nonnegative(one.raw) && nonnegative(one.totCnt) && positive(one.rTime) && loginAnchoredSource(one.source))) {
    throw problem('ORDER_FLOWER_PROPOSAL_BINDING_INVALID', '普通鲜花订单须绑定原生命周期、当日资格和每项真实花材预约', 400,
      { diagnosticVersion: 'order-flower-proposal-binding/v1', failedGateNames: ['proposal.binding.contract'], failedPaths: [] });
  }
  assertOrderFlowerStoredPreparation(proposal);
  return captured;
}
export function orderFlowerAfterCloseLoginProof({ proposal, response, bridge } = {}) {
  assertOrderFlowerProposal(proposal);
  const old = orderFlowerContext(proposal), next = orderFlowerContext(bridge?.newContext), observed = bridge?.newLoginObservation;
  const same = (a, b, keys) => !!a && !!b && keys.every(key => a[key] === b[key]);
  const after = { connectionEpoch: response?.connectionEpoch, requestSequence: response?.requestSequence, wireKey: response?.wireKey, responseRef: response?.responseRef };
  const anchor = proposal.orderFlower.versionEvidence, version = observed?.versionEvidence, closed = bridge?.oldPhysicalCloseReceipt;
  if (!reference(bridge?.leaseRef) || bridge.operationId !== proposal.operationId || !digest(bridge.bridgeFingerprint) ||
    !sameOrderFlowerContext(bridge.originalContext, old) || !same(next, old, ORDER_FLOWER_AXES.slice(0, 5)) || next.connectionEpoch <= old.connectionEpoch ||
    !same(bridge.after, after, Object.keys(after)) || response.source !== 'response' || response.transport !== 'answered' || response.method !== proposal.method ||
    response.connectionEpoch !== old.connectionEpoch || !positive(response.requestSequence) || !reference(response.wireKey) || !reference(response.responseRef) ||
    closed?.closed !== true || closed.connectionEpoch !== old.connectionEpoch || !reference(closed.closureEvidenceRef) ||
    observed?.source !== 'response' || observed.transport !== 'answered' || observed.method !== 'index.login' || observed.connectionEpoch !== next.connectionEpoch ||
    !positive(observed.requestSequence) || !reference(observed.wireKey) || !reference(observed.responseRef) || observed.envelopeOk !== true || observed.dsName !== 'G.ISyncData' || observed.rejected === true ||
    bridge.officialUid !== proposal.orderFlower.officialUid || observed.value?.['7']?.['0']?.['0'] !== bridge.officialUid ||
    bridge.oldLoginSource?.responseRef !== anchor.loginResponseRef || bridge.oldLoginSource?.officialUid !== bridge.officialUid ||
    bridge.oldLoginSource?.method !== 'index.login' || bridge.oldLoginSource?.connectionEpoch !== old.connectionEpoch ||
    bridge.oldLoginSource?.versionEvidence?.gameVersion !== anchor.gameVersion || !verifyOfficialSourceVersionFrame(bridge.oldLoginSource, anchor, old, proposal.orderFlower.officialUid) ||
    version?.gameVersion !== anchor.gameVersion || version?.protocolVersion !== anchor.protocolVersion || version?.loginResponseRef !== observed.responseRef ||
    !verifyOfficialSourceVersionFrame(observed, version, next, proposal.orderFlower.officialUid)) throw problem('ORDER_FLOWER_AFTER_CLOSE_BRIDGE_INVALID', '普通订单原写与真实关闭后正常登录桥不匹配');
  return freeze({ version: 'order-flower-after-close-login/v1', leaseRef: bridge.leaseRef, operationId: proposal.operationId, originalContext: old, newContext: next,
    after, bridgeFingerprint: bridge.bridgeFingerprint, oldPhysicalCloseReceipt: { closed: true, connectionEpoch: closed.connectionEpoch, closureEvidenceRef: closed.closureEvidenceRef },
    newLogin: { method: observed.method, responseRef: observed.responseRef, connectionEpoch: observed.connectionEpoch, requestSequence: observed.requestSequence,
      wireKey: observed.wireKey, gameVersion: version.gameVersion, protocolVersion: version.protocolVersion, loginResponseRef: version.loginResponseRef }, officialUid: bridge.officialUid });
}
