import { canonical, clone, fingerprint, freeze, plainObject, problem } from '../../common.mjs';
import { orderFlowerContext, sameOrderFlowerContext } from './wire-facts.mjs';
import { orderFlowerContent, orderFlowerLife, orderFlowerSafeSource } from './rpc-contract.mjs';
import { auxPositive, auxNonnegative, auxRef, auxDigest, auxExact, auxAt, auxDate, auxNumMap, auxBagBody,
  auxSourceBefore, auxSourceOnLoginAnchor, auxSameDay, auxRawOrder, auxOrderFields, assertOrderFlowerAuxiliaryBase, captureOrderFlowerInventory, captureOrderFlowerCounter, orderFlowerAuxiliaryCatalog,
  orderFlowerAuxiliaryAfterCloseProof, auxiliaryInventoryEffect, auxiliaryResult, createAuxiliaryVerifier, auxiliarySemanticKeyMatches } from './auxiliary-contract.mjs';
import { mergeOrderFlowerCardCellRow, mergeOrderFlowerShareCellRow } from './canonical-aux-cells.mjs';

export const ORDER_FLOWER_VIDEO_CONTRACTS = freeze(Object.fromEntries([
  ['resident', 5, 105, 'share_Order'], ['satin', 19, 109, 'share_orderSatins'], ['decorate', 34, 116, 'share_orderDecorate']
].map(([kind, shareId, counterId, openId]) => [kind, { contractId: 'order-flower-' + kind + '/video-single-v1', kind,
  featureId: 'order.' + kind, scope: 'order-' + kind + '-video', method: 'usr.share', targetKind: 'flower-order-video', shareId, counterId, openId }])));
const VERSION = 'order-flower-video-verification/after-close-v1', FIELD = 'orderFlowerVideo';
const videoCellSource = (observation, officialUid) => ({ ...orderFlowerSafeSource(observation),
  officialUid: auxPositive(officialUid) ? officialUid : null,
  receivedDeviceMs: Number.isSafeInteger(observation?.receivedDeviceMs) ? observation.receivedDeviceMs : null,
  receivedMonotonicMs: Number.isFinite(observation?.receivedMonotonicMs) ? observation.receivedMonotonicMs : null });
export function orderFlowerVideoPolicy(kind, versionEvidence = null) {
  const definition = ORDER_FLOWER_VIDEO_CONTRACTS[kind], catalog = orderFlowerAuxiliaryCatalog(versionEvidence), row = catalog.videoShares?.[definition?.shareId];
  if (!row || row.id !== definition.shareId || row.openId !== definition.openId || row.hasVideo !== 1 || row.limitType !== 1 || !auxPositive(row.limit) || !auxRef(row.tag)) {
    return freeze({ known: false, reasonCode: 'ORDER_VIDEO_CURRENT_SHARE_POLICY_UNPROVEN' });
  }
  return freeze({ known: true, ...clone(row), tableSha256: catalog.tableSha256.c_share, sourceGameSha256: catalog.gameDecodedSha256 });
}

export function captureOrderFlowerVideoArgs(params) {
  const definition = Object.values(ORDER_FLOWER_VIDEO_CONTRACTS).find(one => one.shareId === params?.shareId), ext = params?.ext;
  const publicKeys = definition?.kind === 'resident' ? ['opType', 'id'] : ['opType'];
  if (!definition || !auxExact(params, ['shareId', 'ext']) || !plainObject(ext) || !auxExact(ext, [...publicKeys, ...(Object.hasOwn(ext, 'token') ? ['token'] : [])]) ||
    ext.opType !== 1 || definition.kind === 'resident' && (!auxPositive(ext.id) || ext.id > 6) ||
    Object.hasOwn(ext, 'token') && (typeof ext.token !== 'string' || ext.token.length < 1 || ext.token.length > 4096)) {
    throw problem('ORDER_VIDEO_ARGUMENT_INVALID', '视频单仅允许已核点位和真实原格参数', 400);
  }
  // `params` is an IN-MEMORY wire packet. Persist only publicArgs and this
  // fingerprint; the preparation and verification payload never contain token.
  return freeze({ params: clone(params), paramsFingerprint: fingerprint(params), tokenPresent: Object.hasOwn(ext, 'token'),
    publicArgs: { shareId: params.shareId, ext: Object.fromEntries(publicKeys.map(key => [key, ext[key]])) } });
}
export function captureOrderFlowerVideoCard({ context, observation, previous = null } = {}) {
  const actual = orderFlowerContext(context), map = auxAt(observation?.value, ['21', '5']);
  const uidCell = auxAt(observation?.value, ['7', '0', '0']), officialUid = uidCell.supplied ? uidCell.value :
    (previous?.boundOfficialUid ?? previous?.officialUid);
  if (!actual || !Number.isSafeInteger(officialUid) || officialUid < 1 || map.supplied &&
      (!plainObject(map.value) || Object.keys(map.value).length > 128 || Object.keys(map.value).some(key => !/^[1-9]\d*$/.test(key)))) {
    return freeze({ known: false, presence: 'unknown', reasonCode: 'ORDER_VIDEO_CARD6_SOURCE_OR_MAP_INVALID' });
  }
  return freeze(mergeOrderFlowerCardCellRow({ previous, outerMap: map.supplied ? map.value : null, id: 6,
    source: videoCellSource(observation, officialUid), context: actual, officialUid }));
}
export function evaluateOrderFlowerVideoCard({ context, officialUid, card, clock } = {}) {
  const valid = card?.known === true && card.presence === 'present' && card.type === 6 && card.officialUid === officialUid &&
    sameOrderFlowerContext(card.context, orderFlowerContext(context)) && card.source?.kind === 'response' && card.source.connectionEpoch === context?.connectionEpoch &&
    (card.isMain === true || auxPositive(card.invalidTime) && clock?.available === true && clock.source === 'official-anchor-monotonic' && clock.connectionEpoch === context.connectionEpoch &&
      Number.isFinite(clock.lowerBoundMs) && clock.lowerBoundMs > 0 && Number.isFinite(clock.upperBoundMs) && clock.lowerBoundMs <= clock.upperBoundMs && card.invalidTime > clock.upperBoundMs);
  const clockBasis = card?.isMain === true ? null : clock?.available === true ? { available: true, source: clock.source ?? null,
    connectionEpoch: clock.connectionEpoch ?? null, lowerBoundMs: clock.lowerBoundMs ?? null, upperBoundMs: clock.upperBoundMs ?? null } : null;
  const safeCard = card?.presence === 'present' ? { known: card.known === true, presence: 'present', officialUid: card.officialUid,
    context: orderFlowerContext(card.context), source: orderFlowerSafeSource(card.source), type: card.type, isMain: card.isMain === true, invalidTime: card.invalidTime ?? null } : null;
  const body = { kind: 'current-official-card6', context: orderFlowerContext(context), officialUid, card: safeCard, clockBasis, valid };
  return freeze({ ...body, receiptRef: 'order-video-card6:' + fingerprint(body) });
}
export function captureOrderFlowerShare(observation, shareId, { context = null, officialUid = null, previous = null } = {}) {
  const actual = orderFlowerContext(context), map = auxAt(observation?.value, ['31', '0']);
  const uid = officialUid ?? (auxAt(observation?.value, ['7', '0', '0']).supplied ? observation.value['7']['0']['0'] :
    (previous?.boundOfficialUid ?? previous?.officialUid));
  if (!actual || !auxPositive(uid) || !map.supplied || !plainObject(map.value) || !Object.hasOwn(map.value, String(shareId))) return null;
  return freeze(mergeOrderFlowerShareCellRow({ previous, outerMap: map.supplied ? map.value : null, id: shareId,
    source: videoCellSource(observation, uid), context: actual, officialUid: uid }));
}
function assertPreparation(proposal, { wire = true } = {}) {
  const input = proposal?.[FIELD], definition = ORDER_FLOWER_VIDEO_CONTRACTS[input?.kind];
  const p = assertOrderFlowerAuxiliaryBase(proposal, definition, FIELD), expectedBox = p.kind === 'resident' ? p.boxId : p.kind === 'satin' ? 7 : 8;
  const content = orderFlowerContent(p.kind, p.boxId, p.beforeOrder), publicArgs = { shareId: definition.shareId,
    ext: p.kind === 'resident' ? { opType: 1, id: p.boxId } : { opType: 1 } };
  const target = proposal.targets[0], before = p.beforeShare, capability = p.capability, policy = orderFlowerVideoPolicy(p.kind, p.versionEvidence);
  if (!auxPositive(p.boxId) || p.boxId !== expectedBox || p.kind === 'resident' && p.boxId > 6 || !auxOrderFields(p.kind, p.beforeOrder) || ![true, 1].includes(p.beforeOrder?.isVideo) ||
    !auxPositive(p.beforeOrder.cTime) || !auxNumMap(p.videoReward, 128) || !Object.values(p.videoReward).some(auxPositive) ||
    canonical(p.beforeOrder.videoRwd) !== canonical(p.videoReward) || p.contentFingerprint !== fingerprint(content) ||
    p.lifecycleRef !== orderFlowerLife(proposal, p.kind, p.boxId, p.beforeOrder) ||
    p.targetFingerprint !== fingerprint({ contentFingerprint: p.contentFingerprint, videoReward: p.videoReward }) ||
    target.targetRef !== 'flower-order-video:' + proposal.subjectRef + ':' + p.kind + ':' + p.boxId || target.memberKey !== 'order-video:' + p.lifecycleRef ||
    !auxiliarySemanticKeyMatches(proposal, FIELD, 'order-flower-video:' + p.lifecycleRef) || !auxDigest(p.wireArgsFingerprint) || p.wireArgsFingerprint !== proposal.paramsFingerprint ||
    canonical(p.publicArgs) !== canonical(publicArgs) || p.occurrence?.identityKnown !== true || p.occurrence.lifecycleRef !== p.lifecycleRef ||
    p.occurrence.contentFingerprint !== p.contentFingerprint || !sameOrderFlowerContext(p.occurrence.context, proposal) ||
    p.day?.known !== true || !auxRef(p.day.proofRef) || p.day.source?.responseRef !== p.source.responseRef || p.day.source?.officialUid !== p.officialUid ||
    before?.uid !== p.officialUid || before.shareId !== definition.shareId || ![before.recvCnt, before.shareCnt, before.total].every(auxNonnegative) ||
    !auxPositive(before.uTime) || !auxSourceOnLoginAnchor(before.source, proposal) ||
    !policy.known || p.adSlotTag !== policy.tag || (before.uTime < p.day.startMs ? 0 : before.recvCnt) >= policy.limit || !Array.isArray(p.beforeCounters) || p.beforeCounters.length !== 4 ||
    ![105, 109, 116, 107].every(id => p.beforeCounters.filter(row => row.type === id && row.uid === p.officialUid && auxNonnegative(row.raw) &&
      auxNonnegative(row.total) && auxPositive(row.rTime) && auxSourceOnLoginAnchor(row.source, proposal)).length === 1) ||
    !auxRef(capability?.receiptRef) || canonical(capability.context) !== canonical(orderFlowerContext(proposal)) || capability.officialUid !== p.officialUid ||
     !['current-official-card6', 'legacy-api-request'].includes(capability.kind) ||
    capability.kind === 'legacy-api-request' && (Object.keys(capability).sort().join('|') !== ['kind', 'context', 'officialUid', 'requestRef',
      'receiptRef', 'operationId', 'shareId', 'lifecycleRef', 'sourceKind', 'requestOnly', 'playbackClaimed', 'tokenPresent'].sort().join('|') ||
      capability.requestOnly !== true || capability.playbackClaimed !== false || capability.tokenPresent !== false ||
      capability.sourceKind !== 'legacy-api-request-only' || capability.operationId !== proposal.operationId ||
      capability.shareId !== definition.shareId || capability.lifecycleRef !== p.lifecycleRef ||
      !/^legacy-api-request:[a-f0-9-]{36}$/.test(capability.requestRef) || !/^legacy-api-request-proof:[a-f0-9]{64}$/.test(capability.receiptRef)) ||
    capability.kind === 'current-official-card6' && (capability.valid !== true || capability.card?.presence !== 'present' || capability.card.type !== 6 ||
      capability.card.officialUid !== p.officialUid || !sameOrderFlowerContext(capability.card.context, proposal) || !auxSourceOnLoginAnchor(capability.card.source, proposal))) {
     throw problem('ORDER_VIDEO_PREPARATION_INVALID', '视频单缺少当前原单、日次数和当前卡或请求准备凭据', 400);
  }
  if (wire) {
    const args = captureOrderFlowerVideoArgs(proposal.params);
    if (args.paramsFingerprint !== proposal.paramsFingerprint || canonical(args.publicArgs) !== canonical(publicArgs) ||
      capability.kind === 'current-official-card6' && args.tokenPresent ||
       capability.kind === 'legacy-api-request' && args.tokenPresent) {
      throw problem('ORDER_VIDEO_WIRE_BINDING_INVALID', '视频发送参数与已完成的有限能力不匹配', 400);
    }
  }
  if (capability.kind === 'current-official-card6' && canonical(evaluateOrderFlowerVideoCard({ context: proposal, officialUid: p.officialUid,
    card: capability.card, clock: capability.clockBasis })) !== canonical(capability)) throw problem('ORDER_VIDEO_CARD6_PROOF_INVALID', '视频卡回执不能脱离实际卡字段和官方时钟', 400);
  return p;
}
export const assertOrderFlowerVideoProposal = proposal => assertPreparation(proposal);
export const assertOrderFlowerVideoPreparedOperation = ({ original, preparation }) => assertPreparation({ ...original, [FIELD]: preparation }, { wire: false });
export function orderFlowerVideoAfterCloseLoginProof(input) {
  assertOrderFlowerVideoProposal(input.proposal);
  return orderFlowerAuxiliaryAfterCloseProof({ ...input, field: FIELD, proofVersion: 'order-flower-video-after-close-login/v1' });
}
function snapshot(input) {
  const { proposal, response, bridge } = input;
  const proof = orderFlowerVideoAfterCloseLoginProof(input), p = proposal[FIELD], observation = bridge.newLoginObservation,
    inventory = captureOrderFlowerInventory({ context: bridge.newContext, observation }), order = auxRawOrder(observation, p.kind, p.boxId),
    share = captureOrderFlowerShare(observation, ORDER_FLOWER_VIDEO_CONTRACTS[p.kind].shareId);
  if (!inventory || !order.known || !share || share.uid !== p.officialUid || observation.value?.['105']?.['0']?.['0'] !== p.officialUid) return null;
  return { proof, observation, inventory, order, share };
}
export function validateOrderFlowerVideoSnapshotCoverage({ proposal, response, bridge = null, postReadBridge = null, observation } = {}) {
  try { const packet = bridge || postReadBridge; return packet?.newLoginObservation === observation && snapshot({ proposal, response, bridge: packet }) !== null; } catch { return false; }
}
const unknown = (proposal, response, reasonCode, observation = null) => auxiliaryResult(proposal, response, VERSION, reasonCode, { field: FIELD, observation });
function analyze({ proposal, response, bridge, validateCapability = null }) {
  const p = assertPreparation(proposal), definition = ORDER_FLOWER_VIDEO_CONTRACTS[p.kind], state = snapshot({ proposal, response, bridge });
  if (!state) return unknown(proposal, response, 'ORDER_VIDEO_POST_DOMAIN_MISSING');
  const { observation } = state, fail = reason => unknown(proposal, response, reason, observation);
  if (![p.source, p.beforeInventory.source, p.beforeShare.source, ...p.beforeCounters.map(one => one.source)].every(source => auxSourceBefore(source, proposal, response)) ||
    !auxSameDay(p.day, observation, p.officialUid)) return fail('ORDER_VIDEO_CURRENT_DAY_OR_SOURCES_UNPROVEN');
  // The request-only admission record is checked against this ORIGINAL operation.
  if (p.capability.kind === 'legacy-api-request') {
    const valid = validateCapability?.({ proposal, capability: p.capability, phase: 'original-verification' });
    if (valid?.then) { valid.catch?.(() => {}); throw new TypeError('Request proof validation must be synchronous'); }
    if (valid !== true) return fail('ORDER_VIDEO_REQUEST_PROOF_UNPROVEN');
  }
  const expected = auxBagBody(p.videoReward), effect = auxiliaryInventoryEffect({ before: p.beforeInventory, response, observation,
    gainRule: ({ gains, proxy, transition }) => {
      if (Object.keys(proxy).length) return false;
      const possible = new Map(transition.rewardCandidates.map(one => [one.itemId, one.maximumQuantity]));
      return Object.entries(expected).every(([id, count]) => (gains[id] || 0) >= count && (gains[id] || 0) <= count + (possible.get(Number(id)) || 0)) &&
        Object.entries(gains).every(([id, count]) => count <= (expected[id] || 0) + (possible.get(Number(id)) || 0));
    } });
  if (!effect.known) return fail(effect.reasonCode);
  const originalEffective = p.beforeShare.uTime < p.day.startMs ? 0 : p.beforeShare.recvCnt;
  if (state.share.uTime < p.day.startMs || state.share.uTime > observation.serverMs || state.share.recvCnt !== originalEffective + 1 || state.share.total !== p.beforeShare.total + 1) return fail('ORDER_VIDEO_EXACT_SHARE_COUNTER_EFFECT_UNPROVEN');
  const counters = [];
  for (const before of p.beforeCounters) {
    const after = captureOrderFlowerCounter(observation, before.type); counters.push({ before: clone(before), after });
    if (!after || after.uid !== p.officialUid) return fail('ORDER_VIDEO_POST_COUNTER_MISSING');
    if (before.type === definition.counterId) {
      const effective = before.rTime < p.day.startMs ? 0 : before.raw;
      if (after.rTime < p.day.startMs || after.raw !== effective + 1 || after.total !== before.total + 1) return fail('ORDER_VIDEO_TARGET_COUNTER_EFFECT_UNPROVEN');
    } else if (['raw', 'total', 'rTime'].some(key => before[key] !== after[key])) return fail('ORDER_VIDEO_UNRELATED_COUNTER_CHANGED');
  }
  const next = state.order.row, changed = !next || fingerprint(orderFlowerContent(p.kind, p.boxId, next)) !== p.contentFingerprint ||
    auxPositive(next.cdTime) && (p.beforeOrder.cdTime == null || next.cdTime > p.beforeOrder.cdTime);
  if (!changed) return fail('ORDER_VIDEO_ORIGINAL_ORDER_UNCHANGED');
  return auxiliaryResult(proposal, response, VERSION, 'ORDER_VIDEO_ORIGINAL_EXACT_EFFECT_CONFIRMED', { field: FIELD, observation,
    proof: state.proof, confirmed: true, effect: { kind: p.kind, boxId: p.boxId, beforeOrder: clone(p.beforeOrder), afterOrder: next,
      expectedVideoReward: clone(expected), sharePolicy: orderFlowerVideoPolicy(p.kind, p.versionEvidence), inventory: effect, shareBefore: clone(p.beforeShare), shareAfter: state.share, counters,
      capability: clone(p.capability), newOccurrenceIdentityCreatedByVerifier: false } });
}
export function validateOrderFlowerVideoTargetVerification({ proposal, response, verification, postReads, bridge = null, postReadBridge = null, validateCapability = null } = {}) {
  try { const packet = bridge || postReadBridge;
    if (verification?.verdict !== 'confirmed' || !Array.isArray(postReads) || !postReads.includes(packet?.newLoginObservation)) return false;
    return canonical(analyze({ proposal, response, bridge: packet, validateCapability })) === canonical(verification);
  } catch { return false; }
}
export function createOrderFlowerVideoVerification({ isLeaseCurrent, validateCapability = null } = {}) {
  if (validateCapability !== null && (typeof validateCapability !== 'function' || validateCapability.constructor?.name === 'AsyncFunction')) throw new TypeError('Video completion validator must be synchronous');
  const verifier = createAuxiliaryVerifier({ assert: assertOrderFlowerVideoProposal, analyze: input => analyze({ ...input, validateCapability }), unknown, isLeaseCurrent });
  return Object.freeze({ ...verifier, validateResponseCoverage: validateOrderFlowerVideoSnapshotCoverage,
    validateTargetVerification: input => validateOrderFlowerVideoTargetVerification({ ...input, validateCapability }) });
}
