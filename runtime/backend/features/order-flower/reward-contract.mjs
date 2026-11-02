import { canonical, clone, fingerprint, freeze, plainObject, problem } from '../../common.mjs';
import { orderFlowerSafeSource } from './rpc-contract.mjs';
import { auxPositive, auxNonnegative, auxRef, auxDigest, auxExact, auxAt, auxDate, auxNumMap, auxSourceBefore,
  auxSourceOnLoginAnchor,
  auxSameDay, assertOrderFlowerAuxiliaryBase, captureOrderFlowerInventory, captureOrderFlowerCounter, orderFlowerAuxiliaryCatalog,
  orderFlowerAuxiliaryAfterCloseProof, auxiliaryInventoryEffect, auxiliaryResult, createAuxiliaryVerifier, auxiliarySemanticKeyMatches } from './auxiliary-contract.mjs';

export const ORDER_FLOWER_REWARD_CONTRACTS = freeze({
  stage: { contractId: 'order-resident/progress-reward-single-v1', featureId: 'order.resident', scope: 'order-resident-reward',
    method: 'orderFlower.recvOrderRwd', targetKind: 'order-flower-progress-reward' },
  achievement: { contractId: 'order-resident/achievement-90001-single-v1', featureId: 'order.resident', scope: 'order-resident-achievement',
    method: 'taskAch.recv', targetKind: 'order-flower-achievement' }
});
const FIELD = 'orderFlowerReward', VERSION = 'order-flower-reward-verification/after-close-v1';
export function captureOrderFlowerStageRewardArgs(params) {
  if (!auxExact(params, ['target']) || !auxPositive(params.target) || params.target > 4) throw problem('ORDER_STAGE_REWARD_ARGUMENT_INVALID', '阶段奖励只允许真实1至4目标', 400);
  return freeze({ params: clone(params), paramsFingerprint: fingerprint(params) });
}
export function captureOrderFlowerAchievementArgs(params) {
  if (!auxExact(params, ['id']) || params.id !== 90001) throw problem('ORDER_ACHIEVEMENT_ARGUMENT_INVALID', '本合同仅允许居民累计成就90001', 400);
  return freeze({ params: clone(params), paramsFingerprint: fingerprint(params) });
}
export function captureOrderFlowerRewardState({ context, observation } = {}) {
  const inventory = captureOrderFlowerInventory({ context, observation });
  if (!inventory) return null;
  const components = captureOrderFlowerRewardComponents({ observation, officialUid: inventory.officialUid });
  return components ? freeze({ ...components, inventory,
    counters: [105, 109, 116, 107].map(id => captureOrderFlowerCounter(observation, id)) }) : null;
}

// Component capture is deliberately independent from inventory capture. A
// matched ordinary response can update one reward component without carrying
// a complete bag; omitted components remain at their original source/age.
export function captureOrderFlowerRewardComponents({ observation, officialUid } = {}) {
  if (!auxPositive(officialUid)) return null;
  const source = orderFlowerSafeSource(observation), raw = auxAt(observation.value, ['105', '0']).value,
    ids = raw?.['2'], receivedTime = raw?.['3'] == null ? null : auxDate(raw['3']), resetTime = auxDate(raw?.['10']);
  const stage = plainObject(raw) && raw['0'] === officialUid && Array.isArray(ids) && ids.length <= 4 &&
    ids.every(id => auxPositive(id) && id <= 4) && new Set(ids).size === ids.length && auxPositive(resetTime) &&
    (raw['3'] == null || auxPositive(receivedTime)) ? { uid: raw['0'], receivedIds: [...ids].sort(), receivedTime, resetTime, source } : null;
  const ach = auxAt(observation.value, ['22', '2']).value, progress = ach?.['1'], recv = ach?.['3'];
  const achievement = plainObject(ach) && ach['0'] === officialUid && auxNumMap(progress, 4096) && auxNumMap(recv, 4096) && auxNonnegative(ach['4'])
    ? { uid: ach['0'], groupId: 9, progress: progress['9'] || 0, receivedIndex: recv['9'] || 0, achHist: ach['4'],
      progressMapFingerprint: fingerprint(progress), otherRecvMapFingerprint: fingerprint(Object.fromEntries(Object.entries(recv).filter(([key]) => key !== '9'))),
      progressPresent: Object.hasOwn(progress, '9'), recvZeroProvenByCompleteMap: !Object.hasOwn(recv, '9'), source } : null;
  const map = auxAt(observation.value, ['101', '0']), member = map.value?.['23068'], memberProvided = map.supplied &&
    plainObject(map.value) && Object.hasOwn(map.value, '23068');
  const ownership = memberProvided && (member === null || member === false || member === 0 ||
    plainObject(member) && member['0'] === officialUid && member['1'] === 23068 && auxNonnegative(member['2']) && [0, 1, 2].includes(member['4']))
    ? { uid: officialUid, flowerId: 23068, itemId: 21068, present: !!member, completePropertyProvided: true,
      level: member && typeof member === 'object' ? member['2'] : null,
      status: member && typeof member === 'object' ? member['4'] : null, source } : null;
  return freeze({ stage, achievement, ownership });
}
// G480 updates achievement state with setData semantics: only supplied top
// level fields change, while each supplied map replaces that map as a whole.
// A missing group-9 key in a supplied map means zero; an omitted map is no
// update and must retain its older source.
export function captureOrderFlowerAchievementFieldUpdates({ observation, officialUid } = {}) {
  if (!auxPositive(officialUid)) return null;
  const section = auxAt(observation?.value, ['22', '2']);
  if (!section.supplied) return null;
  if (!plainObject(section.value)) return { malformed: true, fields: {} };
  const raw = section.value, source = orderFlowerSafeSource(observation), fields = {};
  if (Object.hasOwn(raw, '0')) {
    if (raw['0'] !== officialUid) return { malformed: true, fields };
    fields.uid = { value: officialUid, source };
  }
  if (Object.hasOwn(raw, '1')) {
    if (!auxNumMap(raw['1'], 4096)) return { malformed: true, fields };
    fields.progress = { value: raw['1']['9'] || 0, source };
    fields.progressMapFingerprint = { value: fingerprint(raw['1']), source };
    fields.progressPresent = { value: Object.hasOwn(raw['1'], '9'), source };
  }
  if (Object.hasOwn(raw, '3')) {
    if (!auxNumMap(raw['3'], 4096)) return { malformed: true, fields };
    fields.receivedIndex = { value: raw['3']['9'] || 0, source };
    fields.otherRecvMapFingerprint = { value: fingerprint(Object.fromEntries(Object.entries(raw['3']).filter(([key]) => key !== '9'))), source };
    fields.recvZeroProvenByCompleteMap = { value: !Object.hasOwn(raw['3'], '9'), source };
  }
  if (Object.hasOwn(raw, '4')) {
    if (!auxNonnegative(raw['4'])) return { malformed: true, fields };
    fields.achHist = { value: raw['4'], source };
  }
  return { malformed: false, fields };
}
export function orderFlowerStageRewardPolicy({ target, level, versionEvidence = null } = {}) {
  const data = orderFlowerAuxiliaryCatalog(versionEvidence), row = data.stageRewards[target * 10000 + level];
  if (!auxPositive(target) || target > 4 || !auxPositive(level) || !row || row.target !== target || row.lvl?.length !== 1 || row.lvl[0] !== level ||
    !Array.isArray(row.items) || !row.items.every(auxPositive) || !auxPositive(row.typeNum) || !auxPositive(row.itemNum)) return freeze({ known: false, reasonCode: 'ORDER_STAGE_REWARD_CURRENT_POOL_UNKNOWN' });
  return freeze({ known: true, target, level, requiredCount: data.stageTargets[target - 1], poolItemIds: [...row.items],
    typeNum: row.typeNum, itemNum: row.itemNum, candidatePoolOnly: true, randomDistributionProvenByStaticNames: false,
    tableRowId: row.id, tableSha256: data.tableSha256.c_orderRwd, sourceGameSha256: data.gameDecodedSha256 });
}
export function evaluateOrderFlowerRewardEligibility({ kind, target = null, officialUid, day, beforeState, level, versionEvidence = null } = {}) {
  const denied = reasonCode => freeze({ known: false, eligible: false, reasonCode });
  if (!beforeState || day?.known !== true || !auxRef(day.proofRef) || !auxPositive(officialUid)) return denied('ORDER_REWARD_CURRENT_FACTS_REQUIRED');
  if (kind === 'achievement') {
    const a = beforeState.achievement, row = orderFlowerAuxiliaryCatalog(versionEvidence).residentAchievement;
    return a?.uid === officialUid && a.groupId === 9 && auxNonnegative(a.receivedIndex) && auxNonnegative(a.progress) && a.source?.kind === 'response'
      ? freeze({ known: true, eligible: a.progress >= row.value && a.receivedIndex === 0, kind, taskId: row.id, groupId: 9,
        progress: a.progress, threshold: row.value, receivedIndex: a.receivedIndex, rewards: clone(row.rewards),
        reasonCode: a.receivedIndex !== 0 ? 'ORDER_ACHIEVEMENT_ALREADY_RECEIVED' : a.progress < row.value ? 'ORDER_ACHIEVEMENT_PROGRESS_SHORT' : null }) : denied('ORDER_ACHIEVEMENT_CURRENT_STATE_REQUIRED');
  }
  const stage = beforeState.stage, counters = beforeState.counters, policy = orderFlowerStageRewardPolicy({ target, level, versionEvidence });
  if (kind !== 'stage' || !policy.known || stage?.uid !== officialUid || !auxPositive(stage.resetTime) || stage.resetTime < day.startMs || stage.resetTime >= day.endMs ||
    !Array.isArray(counters) || ![105, 109, 116].every(id => counters.filter(one => one?.uid === officialUid && one.type === id && auxNonnegative(one.raw) && auxPositive(one.rTime)).length === 1)) return denied('ORDER_STAGE_REWARD_CURRENT_DAY_STATE_REQUIRED');
  const counts = [105, 109, 116].map(id => { const row = counters.find(one => one.type === id), effective = row.rTime < day.startMs ? 0 : row.raw;
    return { type: id, raw: row.raw, rTime: row.rTime, uiValue: Math.max(0, effective - (id === 105 ? 0 : 1)) }; });
  const sum = counts.reduce((total, one) => total + one.uiValue, 0), eligible = !stage.receivedIds.includes(target) && sum >= policy.requiredCount;
  return freeze({ known: true, eligible, kind, target, countRule: 'G480-progress-reward-sum-of-three-UI-counts', counts, sum, policy,
    reasonCode: stage.receivedIds.includes(target) ? 'ORDER_STAGE_REWARD_ALREADY_RECEIVED' : sum < policy.requiredCount ? 'ORDER_STAGE_REWARD_PROGRESS_SHORT' : null });
}
export function assertOrderFlowerRewardProposal(proposal) {
  const p = proposal?.[FIELD], definition = ORDER_FLOWER_REWARD_CONTRACTS[p?.kind];
  assertOrderFlowerAuxiliaryBase(proposal, definition, FIELD);
  const captured = p.kind === 'stage' ? captureOrderFlowerStageRewardArgs(proposal.params) : captureOrderFlowerAchievementArgs(proposal.params);
  const target = proposal.targets[0], key = p.kind === 'stage' ? String(p.target) : '90001', stage = p.beforeState?.stage, achievement = p.beforeState?.achievement;
  const life = p.kind === 'stage' ? 'order-stage-reward:' + fingerprint([proposal.ownerRef, proposal.subjectRef, p.day?.key, p.day?.startMs, p.target])
    : 'order-resident-achievement:' + fingerprint([proposal.ownerRef, proposal.subjectRef, 90001]);
  const eligibility = evaluateOrderFlowerRewardEligibility({ kind: p.kind, target: p.target, officialUid: p.officialUid, day: p.day,
    beforeState: p.beforeState, versionEvidence: p.versionEvidence, level: p.beforeInventory.profile.level });
  if (captured.paramsFingerprint !== proposal.paramsFingerprint || p.kind === 'stage' && p.target !== proposal.params.target || p.kind === 'achievement' && p.taskId !== 90001 ||
    p.lifecycleRef !== life || target.memberKey !== 'order-reward:' + life || target.targetRef !== 'order-flower-reward:' + proposal.subjectRef + ':' + p.kind + ':' + key ||
    !auxiliarySemanticKeyMatches(proposal, FIELD, 'order-flower-reward:' + life) || eligibility.known !== true || eligibility.eligible !== true ||
    p.targetFingerprint !== fingerprint({ kind: p.kind, target: key, lifecycleRef: life, eligibility }) ||
    !Array.isArray(p.beforeState.counters) || p.beforeState.counters.length !== 4 || ![105, 109, 116, 107].every(id => p.beforeState.counters.filter(one =>
      one?.type === id && one.uid === p.officialUid && auxNonnegative(one.raw) && auxNonnegative(one.total) && auxPositive(one.rTime) && auxSourceOnLoginAnchor(one.source, proposal)).length === 1) ||
    p.kind === 'stage' && (!stage || !auxSourceOnLoginAnchor(stage.source, proposal)) ||
    p.kind === 'achievement' && (!achievement || !auxSourceOnLoginAnchor(achievement.source, proposal) || !auxDigest(achievement.progressMapFingerprint) ||
      !auxDigest(achievement.otherRecvMapFingerprint) || !p.beforeState.ownership || p.beforeState.ownership.uid !== p.officialUid ||
      p.beforeState.ownership.completePropertyProvided !== true || !auxSourceOnLoginAnchor(p.beforeState.ownership.source, proposal)) ||
    p.day?.known !== true || p.day.source?.officialUid !== p.officialUid || p.day.source.responseRef !== p.source.responseRef) {
    throw problem('ORDER_FLOWER_REWARD_PREPARATION_INVALID', '订单奖励缺少真实当前资格和唯一领取目标', 400);
  }
  return captured;
}
export function orderFlowerRewardAfterCloseLoginProof(input) {
  assertOrderFlowerRewardProposal(input.proposal);
  return orderFlowerAuxiliaryAfterCloseProof({ ...input, field: FIELD, proofVersion: 'order-flower-reward-after-close-login/v1' });
}
export const assertOrderFlowerRewardPreparedOperation = ({ original, preparation }) => assertOrderFlowerRewardProposal({ ...original,
  params: preparation?.kind === 'stage' ? { target: preparation.target } : { id: 90001 }, [FIELD]: preparation });
function snapshot(input) {
  const proof = orderFlowerRewardAfterCloseLoginProof(input), p = input.proposal[FIELD], observed = input.bridge.newLoginObservation;
  const state = captureOrderFlowerRewardState({ context: input.bridge.newContext, observation: observed });
  if (!state || state.inventory.officialUid !== p.officialUid || state.counters.some(one => !one || one.uid !== p.officialUid) ||
    p.kind === 'stage' && !state.stage || p.kind === 'achievement' && (!state.achievement || !state.ownership)) return null;
  return { proof, state, observation: observed };
}
export function validateOrderFlowerRewardSnapshotCoverage({ proposal, response, observation, bridge = null, postReadBridge = null } = {}) {
  try { const packet = bridge || postReadBridge; return packet?.newLoginObservation === observation && snapshot({ proposal, response, bridge: packet }) !== null; } catch { return false; }
}
const unknown = (proposal, response, reasonCode, observation = null) => auxiliaryResult(proposal, response, VERSION, reasonCode, { field: FIELD, observation });
function analyze(input) {
  const p = input.proposal[FIELD], s = snapshot(input);
  if (!s) return unknown(input.proposal, input.response, 'ORDER_REWARD_POST_DOMAIN_MISSING');
  const { proposal, response } = input, { state, observation } = s, fail = reason => unknown(proposal, response, reason, observation);
  const sources = [p.source, p.beforeInventory.source, ...p.beforeState.counters.map(one => one.source),
    p.kind === 'stage' ? p.beforeState.stage.source : p.beforeState.achievement.source, ...(p.kind === 'achievement' ? [p.beforeState.ownership.source] : [])];
  if (!sources.every(source => auxSourceOnLoginAnchor(source, proposal) && (!response || source.requestSequence < response.requestSequence)) ||
      !auxSameDay(p.day, observation, p.officialUid)) return fail('ORDER_REWARD_DAY_OR_BEFORE_SOURCE_UNPROVEN');
  for (const before of p.beforeState.counters) {
    const after = state.counters.find(one => one.type === before.type);
    if (!after || ['uid', 'type', 'raw', 'total', 'rTime'].some(key => before[key] !== after[key])) return fail('ORDER_REWARD_UNDERLYING_BUSINESS_COUNTER_CHANGED');
  }
  let inventory, reward;
  if (p.kind === 'stage') {
    const before = p.beforeState.stage, after = state.stage, policy = orderFlowerStageRewardPolicy({ target: p.target, versionEvidence: p.versionEvidence, level: p.beforeInventory.profile.level });
    if (canonical(after.receivedIds) !== canonical([...before.receivedIds, p.target].sort()) || !auxPositive(after.receivedTime) ||
      after.receivedTime < p.day.startMs || after.receivedTime >= p.day.endMs || after.resetTime < p.day.startMs || after.resetTime >= p.day.endMs) return fail('ORDER_STAGE_REWARD_CLAIM_STATE_UNPROVEN');
    inventory = auxiliaryInventoryEffect({ before: p.beforeInventory, response, observation, gainRule: ({ gains, proxy, transition }) =>
      transition.crossedLevels.length === 0 && Object.keys(proxy).length === 0 && Object.keys(gains).length > 0 &&
      Object.entries(gains).every(([id, quantity]) => policy.poolItemIds.includes(Number(id)) && auxPositive(quantity)) });
    reward = { kind: 'actual-random-reward-realization', policy, actualDistributionIsNotPredictedFromNames: true,
      theoreticalRandomQuantityGuaranteeClaimed: false, before, after };
  } else {
    const before = p.beforeState.achievement, after = state.achievement, ownershipBefore = p.beforeState.ownership, ownershipAfter = state.ownership;
    if (after.receivedIndex !== before.receivedIndex + 1 || after.progressMapFingerprint !== before.progressMapFingerprint ||
      after.otherRecvMapFingerprint !== before.otherRecvMapFingerprint || after.achHist !== before.achHist) return fail('ORDER_ACHIEVEMENT_EXACT_CLAIM_STATE_UNPROVEN');
    const newlyOwned = ownershipBefore.present === false && ownershipAfter.present === true && ownershipAfter.uid === p.officialUid;
    const acceptableProxy = values => newlyOwned && Object.keys(values).length > 0 && Object.entries(values).every(([id, quantity]) => ['21068', '23068'].includes(id) && quantity === 1);
    inventory = auxiliaryInventoryEffect({ before: p.beforeInventory, response, observation,
      allowProxy: (values, options) => options?.rawGain ? acceptableProxy(values) && (observation.value['7']['0']['32']['21068'] || 0) === p.beforeInventory.rewardSeedQuantity : acceptableProxy(values),
      gainRule: ({ gains, proxy, transition }) => transition.crossedLevels.length === 0 &&
        Object.entries(gains).every(([id, quantity]) => id === '21068' && quantity === 1) &&
        (gains['21068'] === 1 || acceptableProxy(proxy)) });
    reward = { kind: 'resident-achievement-90001', expectedReward: [[21068, 1]], before, after, ownershipBefore, ownershipAfter,
      actualOwnershipTransitionProven: newlyOwned, actualBagGrantAlternative: !newlyOwned };
  }
  if (!inventory.known) return fail(inventory.reasonCode);
  return auxiliaryResult(proposal, response, VERSION, 'ORDER_FLOWER_REWARD_EXACT_EFFECT_CONFIRMED', { field: FIELD, observation,
    proof: s.proof, confirmed: true, effect: { reward, inventory, originalUnderlyingBusinessCountersUnchanged: true } });
}
export function validateOrderFlowerRewardTargetVerification({ proposal, response, verification, postReads, bridge = null, postReadBridge = null } = {}) {
  try { const packet = bridge || postReadBridge; return verification?.verdict === 'confirmed' && Array.isArray(postReads) &&
    postReads.includes(packet?.newLoginObservation) && canonical(analyze({ proposal, response, bridge: packet })) === canonical(verification); } catch { return false; }
}
export function createOrderFlowerRewardVerification({ isLeaseCurrent } = {}) {
  return Object.freeze({ ...createAuxiliaryVerifier({ assert: assertOrderFlowerRewardProposal, analyze, unknown, isLeaseCurrent }),
    validateResponseCoverage: validateOrderFlowerRewardSnapshotCoverage, validateTargetVerification: validateOrderFlowerRewardTargetVerification });
}
