import { clone, fingerprint, freeze, plainObject, problem } from '../../common.mjs';
import { customerContext, sameCustomerContext } from './wire-facts.mjs';
import { CUSTOMER_GENERATION_STATIC } from './generation.mjs';
import { isNormalSyncMethod } from '../../facts/normal-sync-contract.mjs';
import { officialActionContractId } from '../../official-version-profile.mjs';
import { customerVersionFrameValid } from './rpc-contract.mjs';

export const CUSTOMER_GENERATION_CONTRACT = Object.freeze({ contractId: 'customer-generation/headless-empty-stock-v1',
  featureId: 'order.customer', scope: 'order-customer-gen', method: 'orderCustomer.genOrder', targetKind: 'customer-generation' });
export const CUSTOMER_GENERATION_POST_READ = Object.freeze({ contractId: 'customer-generation-fresh-login/after-physical-close/v1',
  kind: 'after-close-login', method: 'index.login', args: {}, evidenceRef: 'g3a/normal-fresh-login/generation-complete109-count107-and-bag/v1' });
export const GENERATION_ORDER_FIELDS = Object.freeze(['dialogId', 'artId', 'num', 'pathId', 'cTime']);
export const CUSTOMER_GENERATION_OPEN_NPC_SOURCE = freeze({ version: 'customer-generation/open-official-npcs/v1',
  gameVersion: '480.0.27', protocolVersion: '480.0.0',
  gameSha256: CUSTOMER_GENERATION_STATIC.source.gameDecodedSha256,
  npcTableSha256: CUSTOMER_GENERATION_STATIC.source.npcTableSha256,
  ruleRange: [2359904, 2360126], ruleSha256: 'aabe22303e674accc76c986fea771fdc1cbb4303256a0ad5508a255faf969cf5',
  rule: 'all-listed-npcs-whose-main-task-threshold-is-met',
  clientRoamingGuestListIsNotServerOutputWhitelist: true });
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const exactKeys = (value, keys) => plainObject(value) && fingerprint(Object.keys(value).sort()) === fingerprint([...keys].sort());
export const generationSource = source => source ? { kind: source.kind ?? source.sourceKind ?? source.source ?? null,
  method: source.method ?? null, connectionEpoch: source.connectionEpoch ?? null, requestSequence: source.requestSequence ?? null,
  wireKey: source.wireKey ?? null, responseRef: source.responseRef ?? null } : null;
export function generationSourceKnown(source, context) {
  const value = generationSource(source);
  return value?.kind === 'response' && typeof value.method === 'string' && /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(value.method) &&
    value.connectionEpoch === context.connectionEpoch && positive(value.requestSequence) && reference(value.responseRef) && reference(value.wireKey) &&
    /^ws\|\d+\|[1-9]\d*$/.test(value.wireKey) && Number(value.wireKey.split('|').at(-1)) === value.requestSequence;
}
export function generationOpenNpcPolicy({ context, mainTaskId, source, staticPolicy = CUSTOMER_GENERATION_STATIC }) {
  if (!nonnegative(mainTaskId) || !generationSourceKnown(source, context) || !isNormalSyncMethod(source.method)) {
    throw problem('CUSTOMER_GENERATION_OPEN_NPC_SOURCE_REQUIRED', '完整已开放顾客集合须由本次正常登录主线进度及已核官方目录生成');
  }
  return freeze({ version: CUSTOMER_GENERATION_OPEN_NPC_SOURCE.version, source: staticPolicy?.source ?? CUSTOMER_GENERATION_OPEN_NPC_SOURCE,
    mainTaskId, mainTaskSource: generationSource(source),
    openNpcIds: staticPolicy.npcs.filter(row => mainTaskId >= row.mainTaskId).map(row => row.id) });
}
export function generationOrderContent(row) {
  return { npcId: row.npcId, fields: Object.fromEntries(GENERATION_ORDER_FIELDS.map(key => [key,
    { presence: 'present', state: 'known', value: row[key] }])) };
}
export function captureCustomerGenerationArgs(input) {
  if (!exactKeys(input, ['guestNpcIdList']) || !Array.isArray(input.guestNpcIdList) || input.guestNpcIdList.length || Object.keys(input.guestNpcIdList).length) {
    throw problem('CUSTOMER_GENERATION_ARGUMENT_INVALID', '有限生成仅允许真实无漫游访客状态对应的空列表', 400);
  }
  const params = clone(input); return freeze({ params, paramsFingerprint: fingerprint(params) });
}
export function assertCustomerGenerationProposal(proposal) {
  const captured = captureCustomerGenerationArgs(proposal?.params), context = customerContext(proposal), data = proposal.generation,
    target = proposal.targets?.[0], day = data?.day, count = data?.beforeCount, need = proposal?.customer?.currentNeed,
    sourceBoundGeneration = Object.hasOwn(data || {}, 'decisionGeneration'), policyMaxBoard = data?.policy?.maxBoard ?? 3;
  if (!context || proposal.featureId !== 'order.customer' || proposal.scope !== 'order-customer-gen' || proposal.method !== 'orderCustomer.genOrder' ||
      captured.paramsFingerprint !== proposal.paramsFingerprint || !plainObject(data) || !digest(data.businessFingerprint) ||
      data.lifecycleRef !== 'customer-generation-life:' + data.businessFingerprint ||
      (sourceBoundGeneration ? !digest(data.decisionGeneration) ||
        proposal.semanticKey !== 'customer-generation:' + data.businessFingerprint + ':' + data.decisionGeneration ||
        need?.necessary !== true || need.featureId !== proposal.featureId || need.targetRef !== 'customer-generation:' + context.subjectRef + ':' + day?.key ||
        !reference(need.businessNeedRef) || !digest(need.decisionGeneration) || need.decisionGeneration !== data.decisionGeneration ||
        need.needRef !== 'current-need:' + fingerprint([need.featureId, need.targetRef, need.businessNeedRef]) ||
        !digest(need.semanticFingerprint) || !reference(need.claimRef) || !Array.isArray(need.basisRefs) || !need.basisRefs.length
        : proposal.semanticKey !== 'customer-generation:' + data.businessFingerprint) ||
      day?.known !== true || !/^\d{4}-\d{2}-\d{2}$/.test(day.key || '') || !positive(day.startMs) || day.endMs - day.startMs !== 86400000 || !reference(day.proofRef) ||
      !Array.isArray(proposal.targets) || proposal.targets.length !== 1 ||
      !exactKeys(target, ['memberKey', 'targetKind', 'targetRef', 'lifecycleRef', 'targetFingerprint']) ||
      target.targetKind !== 'customer-generation' || target.targetRef !== 'customer-generation:' + context.subjectRef + ':' + day.key ||
      target.lifecycleRef !== data.lifecycleRef || target.memberKey !== 'customer-generation:' + data.businessFingerprint || target.targetFingerprint !== data.businessFingerprint ||
      !Array.isArray(proposal.resources) || proposal.resources.length !== 0 || !Array.isArray(proposal.resourceBindings) || proposal.resourceBindings.length !== 0 ||
      !positive(data.officialUid) || !/^\d+(?:\.\d+){1,5}$/.test(data.versionEvidence?.gameVersion || '') || data.versionEvidence.protocolVersion !== '480.0.0' ||
      !reference(data.versionEvidence.loginResponseRef) || !positive(policyMaxBoard) || policyMaxBoard > 128 || !Array.isArray(data.beforeBoard) || data.beforeBoard.length >= policyMaxBoard ||
      new Set(data.beforeBoard.map(row => row.npcId)).size !== data.beforeBoard.length || !Array.isArray(data.beforeStock) || data.beforeStock.length !== 0 ||
      !Array.isArray(data.openRegularNpcIds) || !data.openRegularNpcIds.length || data.openRegularNpcIds.some(id => !positive(id)) ||
      !positive(count?.rTimeMs) || !nonnegative(count.rawTdyCnt) || !nonnegative(count.totCnt) || !nonnegative(count.effectiveCount) ||
      count.effectiveCount !== (count.rTimeMs < day.startMs ? 0 : count.rawTdyCnt) || !generationSourceKnown(count.source, context) ||
      !generationSourceKnown(data.boardSource, context) ||
      !nonnegative(data.beforeProfile?.gold) || !nonnegative(data.beforeProfile?.yb) ||
      !generationSourceKnown(data.beforeProfile.goldSource, context) || !generationSourceKnown(data.beforeProfile.ybSource, context) ||
      data.beforeProfile.completeBagFingerprint?.known !== true || !digest(data.beforeProfile.completeBagFingerprint.fingerprint) ||
      !nonnegative(data.beforeProfile.completeBagFingerprint.positiveItemCount) ||
      data.beforeProfile.completeBagFingerprint.rule !== 'complete-absolute-bag-positive-integer-counts/zero-and-missing-equivalent/v1' ||
      !generationSourceKnown(data.beforeProfile.completeBagFingerprint.source, context) ||
      !positive(data.remainingDailyOpportunity) || !reference(data.localReportProofRef) || !reference(data.guestScopeProofRef)) {
    throw problem('CUSTOMER_GENERATION_PROPOSAL_BINDING_INVALID', '生成提案须绑定同日真实机会、空待发列表、完整原板、107原计数和绝对库存证据', 400);
  }
  // Existing immutable v1 preparations keep their original regular-only
  // verification semantics. Only a new source-bound policy admits 8/9 outputs;
  // reading this code never upgrades an old unknown operation's verdict.
  if (Object.hasOwn(data, 'openNpcPolicy')) {
    const policy = data.openNpcPolicy;
    const policySource = data.policy?.source;
    const currentPolicy = policySource?.sourceProof?.supported === true
      ? { maxBoard: policySource.maxBoard, dailyLimit: policySource.dailyLimit, npcs: policySource.npcs, source: policySource }
      : CUSTOMER_GENERATION_STATIC;
    if (!plainObject(data.policy) || !plainObject(policy) || !generationSourceKnown(policy.mainTaskSource, context) ||
        data.policy.gameVersion !== data.versionEvidence.gameVersion || data.policy.protocolVersion !== data.versionEvidence.protocolVersion ||
        data.policy.source?.dataSnapshotId !== data.versionEvidence.dataSnapshotId ||
        data.policy.source?.loginResponseRef !== data.versionEvidence.loginResponseRef ||
        policySource?.sourceProof?.supported === true && policySource.sourceProof.actionContractId !== officialActionContractId('customer.generate') ||
        data.versionEvidence.gameVersion !== '480.0.27' && policySource?.sourceProof?.supported !== true ||
        fingerprint(policy) !== fingerprint(generationOpenNpcPolicy({ context, mainTaskId: policy.mainTaskId, source: policy.mainTaskSource, staticPolicy: currentPolicy })) ||
        !policy.openNpcIds.length || !policy.openNpcIds.some(id => !data.beforeBoard.some(row => row.npcId === id))) {
      throw problem('CUSTOMER_GENERATION_COMPLETE_OPEN_NPC_POLICY_INVALID', '服务端新订单只可对应本次主线进度已开放的完整官方顾客集合');
    }
  }
  for (const row of data.beforeBoard) {
    if (!positive(row.npcId) || !GENERATION_ORDER_FIELDS.every(key => ['artId', 'num', 'cTime'].includes(key) ? positive(row[key]) : nonnegative(row[key])) ||
        !/^customer-life:[a-f0-9]{64}$/.test(row.lifecycleRef || '') || fingerprint(generationOrderContent(row)) !== row.contentFingerprint) {
      throw problem('CUSTOMER_GENERATION_ORIGINAL_BOARD_INVALID', '原订单板必须保留逐行五字段、内容及已知生命周期', 400);
    }
  }
  return captured;
}
export function customerGenerationAfterCloseLoginProof({ proposal, response, bridge } = {}) {
  assertCustomerGenerationProposal(proposal);
  const originalContext = customerContext(proposal), current = customerContext(bridge?.newContext), observed = bridge?.newLoginObservation,
    closed = bridge?.oldPhysicalCloseReceipt, expected = proposal.generation.versionEvidence, version = observed?.versionEvidence, old = bridge?.oldLoginSource;
  const after = { connectionEpoch: response?.connectionEpoch, requestSequence: response?.requestSequence, wireKey: response?.wireKey, responseRef: response?.responseRef };
  if (proposal.operationDescriptor?.postRead?.kind !== 'after-close-login' || proposal.operationDescriptor.postRead.method !== 'index.login' ||
      !reference(bridge?.leaseRef) || bridge.operationId !== proposal.operationId || !digest(bridge.bridgeFingerprint) ||
      !sameCustomerContext(originalContext, customerContext(bridge.originalContext)) || !current ||
      ['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch'].some(key => current[key] !== originalContext[key]) || current.connectionEpoch <= originalContext.connectionEpoch ||
      fingerprint(after) !== fingerprint(bridge.after) || !generationSourceKnown(response, originalContext) || response.method !== 'orderCustomer.genOrder' ||
      response.transport !== 'answered' || closed?.closed !== true || closed.connectionEpoch !== originalContext.connectionEpoch || !reference(closed.closureEvidenceRef) ||
      !generationSourceKnown(observed, current) || observed.method !== 'index.login' || observed.transport !== 'answered' ||
      observed.envelopeOk !== true || observed.dsName !== 'G.ISyncData' || observed.rejected === true || observed.messagePresent === true && observed.noticeOnly !== true ||
      bridge.officialUid !== proposal.generation.officialUid || observed.value?.['7']?.['0']?.['0'] !== bridge.officialUid ||
      old?.method !== 'index.login' || old.connectionEpoch !== originalContext.connectionEpoch || old.officialUid !== bridge.officialUid ||
      old.responseRef !== expected.loginResponseRef || old.versionEvidence?.gameVersion !== expected.gameVersion ||
      !customerVersionFrameValid(old, expected, originalContext, bridge.officialUid) ||
      version?.source !== 'normal-package-hop-and-matched-world-login/v1' || version.gameVersion !== expected.gameVersion || version.protocolVersion !== expected.protocolVersion ||
      version.loginResponseRef !== observed.responseRef || !customerVersionFrameValid(observed, version, current, bridge.officialUid)) {
    throw problem('CUSTOMER_GENERATION_AFTER_CLOSE_BRIDGE_INVALID', '生成写与真实物理关闭后的同主体正常新登录证据不匹配');
  }
  return freeze({ version: 'customer-generation-after-close-login/v1', leaseRef: bridge.leaseRef, operationId: proposal.operationId,
    originalContext, newContext: current, after, bridgeFingerprint: bridge.bridgeFingerprint, officialUid: bridge.officialUid,
    oldPhysicalCloseReceipt: { closed: true, connectionEpoch: closed.connectionEpoch, closureEvidenceRef: closed.closureEvidenceRef },
    newLogin: { responseRef: observed.responseRef, method: 'index.login', connectionEpoch: current.connectionEpoch,
      requestSequence: observed.requestSequence, wireKey: observed.wireKey, gameVersion: version.gameVersion, protocolVersion: version.protocolVersion, loginResponseRef: version.loginResponseRef } });
}
