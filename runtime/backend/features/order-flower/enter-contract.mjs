import { canonical, clone, fingerprint, freeze, plainObject, problem } from '../../common.mjs';
import { orderFlowerSafeSource } from './rpc-contract.mjs';
import { orderFlowerContext, sameOrderFlowerContext } from './wire-facts.mjs';
import { auxPositive, auxNonnegative, auxRef, auxExact, auxAt, auxDate, auxRawOrder, auxSourceBefore, auxSourceOnLoginAnchor, auxSameDay,
  captureOrderFlowerInventory, captureOrderFlowerCounter, assertOrderFlowerAuxiliaryBase, orderFlowerAuxiliaryAfterCloseProof,
  auxiliaryInventoryEffect, auxiliaryResult, createAuxiliaryVerifier, auxiliarySemanticKeyMatches } from './auxiliary-contract.mjs';

// The official controller's enter({}) is invoked at RefreshOnZero and when an
// opened satin/decorate slot has no cTime. It can initialize/generate orders;
// it is a ledgered mutation, never a replacement for a read endpoint.
export const ORDER_FLOWER_ENTER_CONTRACTS = freeze(Object.fromEntries(['resident', 'satin', 'decorate'].map(kind => [kind, {
  contractId: 'order-flower-' + kind + '/enter-single-v1', kind, featureId: 'order.' + kind,
  scope: 'order-' + kind + '-enter', method: 'orderFlower.enter', targetKind: 'flower-order-initialization'
}])));
const FIELD = 'orderFlowerEnter', VERSION = 'order-flower-enter-verification/after-close-v1';
export function captureOrderFlowerEnterArgs(params) {
  if (!auxExact(params, [])) throw problem('ORDER_ENTER_ARGUMENT_INVALID', '订单初始化仅允许官方空参数', 400);
  return freeze({ params: {}, paramsFingerprint: fingerprint({}) });
}
function scalar(observation, kind, officialUid = null) {
  const raw = auxAt(observation?.value, ['105', '0', kind === 'satin' ? '6' : '7']);
  if (!raw.supplied) return { known: false, row: null };
  if (raw.value === null || plainObject(raw.value) && Object.keys(raw.value).length === 0) return { known: true, row: null };
  return auxRawOrder(observation, kind, kind === 'satin' ? 7 : 8, officialUid);
}
function domain(observation, officialUid) {
  const raw = auxAt(observation?.value, ['105', '0']).value;
  if (!plainObject(raw) || raw['0'] !== officialUid || !plainObject(raw['1']) || Object.keys(raw['1']).length > 6 ||
    !Object.keys(raw['1']).every(key => /^[1-6]$/.test(key)) || !Array.isArray(raw['2']) || raw['2'].length > 4 ||
    !raw['2'].every(id => auxPositive(id) && id <= 4) || new Set(raw['2']).size !== raw['2'].length || !auxPositive(auxDate(raw['10']))) return null;
  const residents = Object.fromEntries(Object.keys(raw['1']).sort().map(key => [key, auxRawOrder(observation, 'resident', Number(key))]));
  if (Object.values(residents).some(one => !one.known)) return null;
  const satin = scalar(observation, 'satin', officialUid), decorate = scalar(observation, 'decorate', officialUid);
  if (!satin.known || !decorate.known) return null;
  return { uid: officialUid, residents: Object.fromEntries(Object.entries(residents).map(([key, one]) => [key, one.row])),
    satin: satin.row, decorate: decorate.row, receivedIds: [...raw['2']].sort(), resetTime: auxDate(raw['10']),
    source: orderFlowerSafeSource(observation) };
}
export function captureOrderFlowerEnterBoard({ observation, officialUid } = {}) {
  if (!auxPositive(officialUid)) return null;
  return domain(observation, officialUid);
}
// Incremental ISyncData frames merge the properties the official controller
// actually supplies. Keep this patch field-scoped so a stage-only response
// cannot renew the board, while a resetTime/slot-only response is not lost.
export function captureOrderFlowerEnterBoardUpdates({ observation, officialUid } = {}) {
  if (!auxPositive(officialUid) || !plainObject(observation?.value)) return null;
  const raw = auxAt(observation.value, ['105', '0']);
  if (!raw.supplied || !plainObject(raw.value)) return null;
  const board = raw.value, fields = {};
  const supplied = key => Object.hasOwn(board, key);
  if (supplied('0') && board['0'] !== officialUid) return { malformed: true, fields: {} };
  if (supplied('1')) {
    const map = board['1'];
    if (!plainObject(map) || Object.keys(map).length > 6 || !Object.keys(map).every(key => /^[1-6]$/.test(key))) return { malformed: true, fields: {} };
    const residents = Object.fromEntries(Object.keys(map).sort().map(key => [key, auxRawOrder(observation, 'resident', Number(key), officialUid)]));
    if (Object.values(residents).some(one => !one.known)) return { malformed: true, fields: {} };
    fields.residents = Object.fromEntries(Object.entries(residents).map(([key, one]) => [key, one.row]));
  }
  if (supplied('2')) {
    if (!Array.isArray(board['2']) || board['2'].length > 4 || !board['2'].every(id => auxPositive(id) && id <= 4) ||
      new Set(board['2']).size !== board['2'].length) return { malformed: true, fields: {} };
    fields.receivedIds = [...board['2']].sort();
  }
  if (supplied('10')) {
    const resetTime = auxDate(board['10']);
    if (!auxPositive(resetTime)) return { malformed: true, fields: {} };
    fields.resetTime = resetTime;
  }
  for (const [kind, key] of [['satin', '6'], ['decorate', '7']]) if (supplied(key)) {
    const one = scalar(observation, kind, officialUid);
    if (!one.known) return { malformed: true, fields: {} };
    fields[kind] = one.row;
  }
  return Object.keys(fields).length ? { malformed: false, fields } : null;
}
export function captureOrderFlowerEnterState({ context, observation } = {}) {
  const inventory = captureOrderFlowerInventory({ context, observation });
  if (!inventory) return null;
  const components = captureOrderFlowerEnterComponents({ observation, officialUid: inventory.officialUid });
  return components ? freeze({ ...components, inventory }) : null;
}
export function captureOrderFlowerEnterComponents({ observation, officialUid } = {}) {
  if (!auxPositive(officialUid)) return null;
  const board = captureOrderFlowerEnterBoard({ observation, officialUid }), counters = [105, 109, 116, 107].map(id => captureOrderFlowerCounter(observation, id));
  return board && counters.every(one => one && one.uid === officialUid) ? freeze({ board, counters }) : null;
}
export function orderFlowerEnterOpportunity({ context, kind, officialUid, day, beforeState, eligibility } = {}) {
  const denied = reasonCode => freeze({ known: false, eligible: false, reasonCode });
  if (!ORDER_FLOWER_ENTER_CONTRACTS[kind] || !orderFlowerContext(context) || day?.known !== true || !auxPositive(day.startMs) ||
    day.endMs - day.startMs !== 86400000 || beforeState?.board?.uid !== officialUid || !auxPositive(beforeState.board.resetTime) ||
    eligibility?.current !== true || eligibility.open !== true || eligibility.kind !== kind || eligibility.officialUid !== officialUid ||
    !sameOrderFlowerContext(eligibility.context, context) || !auxRef(eligibility.basisRef)) return denied('ORDER_ENTER_CURRENT_OPEN_STATE_REQUIRED');
  const stale = beforeState.board.resetTime < day.startMs;
  const missing = kind !== 'resident' && beforeState.board[kind] === null;
  if (!stale && !missing) return denied('ORDER_ENTER_NO_REAL_INITIALIZATION_OPPORTUNITY');
  const reason = stale ? 'official-day-reset' : 'missing-open-order';
  const lifecycleRef = 'order-enter:' + fingerprint({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
    dayStartMs: day.startMs, kind: stale ? 'all' : kind, reason });
  return freeze({ known: true, eligible: true, reason, kind, lifecycleRef,
    basis: { officialUid, previousResetTime: beforeState.board.resetTime, currentDayStartMs: day.startMs,
      missingKind: missing ? kind : null, eligibilityRef: eligibility.basisRef, boardSource: clone(beforeState.board.source) } });
}
export function assertOrderFlowerEnterProposal(proposal) {
  const p = proposal?.[FIELD], definition = ORDER_FLOWER_ENTER_CONTRACTS[p?.kind];
  assertOrderFlowerAuxiliaryBase(proposal, definition, FIELD);
  const captured = captureOrderFlowerEnterArgs(proposal.params), opportunity = orderFlowerEnterOpportunity({ context: proposal, kind: p.kind,
    officialUid: p.officialUid, day: p.day, beforeState: p.beforeState, eligibility: p.eligibility }), target = proposal.targets[0];
  if (captured.paramsFingerprint !== proposal.paramsFingerprint || !opportunity.eligible || canonical(p.opportunity) !== canonical(opportunity) ||
    p.lifecycleRef !== opportunity.lifecycleRef || !auxiliarySemanticKeyMatches(proposal, FIELD, 'order-flower-enter:' + p.lifecycleRef) ||
    target.memberKey !== 'order-enter:' + p.lifecycleRef || target.targetRef !== 'flower-order-enter:' + proposal.subjectRef + ':' + (opportunity.reason === 'official-day-reset' ? 'all' : p.kind) ||
    p.targetFingerprint !== fingerprint({ lifecycleRef: p.lifecycleRef, reason: opportunity.reason, dayStartMs: p.day.startMs }) ||
    !auxSourceOnLoginAnchor(p.beforeState.board.source, proposal) ||
    !Array.isArray(p.beforeState.counters) || p.beforeState.counters.length !== 4 || ![105, 109, 116, 107].every(id =>
      p.beforeState.counters.filter(one => one?.type === id && one.uid === p.officialUid && auxNonnegative(one.raw) && auxNonnegative(one.total) &&
        auxPositive(one.rTime) && auxSourceOnLoginAnchor(one.source, proposal)).length === 1)) {
    throw problem('ORDER_ENTER_PREPARATION_INVALID', '订单初始化须绑定真实跨日或已开放缺单机会，不能用新请求编号重试', 400);
  }
  return captured;
}
export function orderFlowerEnterAfterCloseLoginProof(input) {
  assertOrderFlowerEnterProposal(input.proposal);
  return orderFlowerAuxiliaryAfterCloseProof({ ...input, field: FIELD, proofVersion: 'order-flower-enter-after-close-login/v1' });
}
export const assertOrderFlowerEnterPreparedOperation = ({ original, preparation }) => assertOrderFlowerEnterProposal({ ...original, params: {}, [FIELD]: preparation });
function snapshot(input) {
  const proof = orderFlowerEnterAfterCloseLoginProof(input), state = captureOrderFlowerEnterState({ context: input.bridge.newContext, observation: input.bridge.newLoginObservation });
  return state && state.inventory.officialUid === input.proposal[FIELD].officialUid ? { proof, state, observation: input.bridge.newLoginObservation } : null;
}
export function validateOrderFlowerEnterSnapshotCoverage({ proposal, response, observation, bridge = null, postReadBridge = null } = {}) {
  try { const packet = bridge || postReadBridge; return packet?.newLoginObservation === observation && snapshot({ proposal, response, bridge: packet }) !== null; } catch { return false; }
}
const unknown = (proposal, response, reasonCode, observation = null) => auxiliaryResult(proposal, response, VERSION, reasonCode, { field: FIELD, observation });
function analyze(input) {
  const { proposal, response } = input, p = proposal[FIELD], post = snapshot(input);
  if (!post) return unknown(proposal, response, 'ORDER_ENTER_POST_COMPLETE_DOMAIN_MISSING');
  const { observation, state } = post, fail = reason => unknown(proposal, response, reason, observation), before = p.beforeState.board, after = state.board;
  if (![p.source, p.beforeInventory.source, before.source, ...p.beforeState.counters.map(one => one.source)].every(one => auxSourceBefore(one, proposal, response)) ||
    !auxSameDay(p.day, observation, p.officialUid)) return fail('ORDER_ENTER_DAY_OR_ORIGINAL_SOURCE_UNPROVEN');
  const effect = auxiliaryInventoryEffect({ before: p.beforeInventory, response, observation,
    gainRule: ({ gains, proxy, transition }) => Object.keys(gains).length === 0 && Object.keys(proxy).length === 0 && transition.crossedLevels.length === 0 });
  if (!effect.known) return fail(effect.reasonCode);
  const rawAnswer = auxAt(response.value, ['105', '0']).value;
  if (!plainObject(rawAnswer) || rawAnswer['0'] !== p.officialUid) return fail('ORDER_ENTER_ORIGINAL_TARGET_ANSWER_MISSING');
  if (p.opportunity.reason === 'official-day-reset') {
    if (before.resetTime >= p.day.startMs || after.resetTime < p.day.startMs || after.resetTime >= p.day.endMs ||
      auxDate(rawAnswer['10']) !== after.resetTime || after.receivedIds.length !== 0 || !Array.isArray(rawAnswer['2']) || rawAnswer['2'].length !== 0) return fail('ORDER_ENTER_DAILY_RESET_EFFECT_UNPROVEN');
  } else {
    const written = scalar(response, p.kind), next = after[p.kind];
    if (before[p.kind] !== null || !next || !written.known || !written.row || canonical(written.row) !== canonical(next)) return fail('ORDER_ENTER_INITIALIZED_ORDER_EFFECT_UNPROVEN');
    // Existing orders must survive initialization. Newly initialized other
    // slots are recorded, but never minted into a fresh occurrence here.
    if (Object.entries(before.residents).some(([id, row]) => row && canonical(row) !== canonical(after.residents[id] ?? null)) ||
      ['satin', 'decorate'].some(kind => before[kind] && canonical(before[kind]) !== canonical(after[kind])) ||
      canonical(before.receivedIds) !== canonical(after.receivedIds)) return fail('ORDER_ENTER_EXISTING_ORDER_OR_CLAIM_STATE_CHANGED');
  }
  const counters = [];
  for (const previous of p.beforeState.counters) {
    const next = state.counters.find(one => one.type === previous.type), changed = ['raw', 'total', 'rTime'].some(key => previous[key] !== next[key]);
    if (previous.type === 107 && changed || next.total < previous.total) return fail('ORDER_ENTER_UNRELATED_OR_DECREASING_COUNTER_EFFECT');
    if (changed) {
      const written = captureOrderFlowerCounter(response, previous.type);
      if (!written || ['uid', 'type', 'raw', 'total', 'rTime'].some(key => written[key] !== next[key])) return fail('ORDER_ENTER_CHANGED_COUNTER_NOT_BOUND_TO_ORIGINAL_ANSWER');
    }
    counters.push({ before: clone(previous), after: next, changed, deliveryCountSemanticsClaimed: false });
  }
  return auxiliaryResult(proposal, response, VERSION, 'ORDER_ENTER_ACTUAL_INITIALIZATION_EFFECT_CONFIRMED', { field: FIELD, observation, proof: post.proof,
    confirmed: true, effect: { opportunity: clone(p.opportunity), beforeBoard: clone(before), afterBoard: after, inventory: effect, counters,
      serverRawCountersNeverLocallyReset: true, newOccurrenceIdentityCreatedByVerifier: false } });
}
export function validateOrderFlowerEnterTargetVerification({ proposal, response, verification, postReads, bridge = null, postReadBridge = null } = {}) {
  try { const packet = bridge || postReadBridge; return verification?.verdict === 'confirmed' && Array.isArray(postReads) &&
    postReads.includes(packet?.newLoginObservation) && canonical(analyze({ proposal, response, bridge: packet })) === canonical(verification); } catch { return false; }
}
export function createOrderFlowerEnterVerification({ isLeaseCurrent } = {}) {
  return Object.freeze({ ...createAuxiliaryVerifier({ assert: assertOrderFlowerEnterProposal, analyze, unknown, isLeaseCurrent }),
    validateResponseCoverage: validateOrderFlowerEnterSnapshotCoverage, validateTargetVerification: validateOrderFlowerEnterTargetVerification });
}
