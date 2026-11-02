import { canonical, clone, fingerprint, freeze, plainObject } from '../../common.mjs';
import { decodeOfficialOrderFlowerObservation, knownOrderFlowerCell } from './wire-facts.mjs';
import { ORDER_FLOWER_CONTRACTS, assertOrderFlowerProposal, orderFlowerAfterCloseLoginProof,
  orderFlowerContent, orderFlowerRequirements, orderFlowerSafeSource } from './rpc-contract.mjs';
import { ORDER_FLOWER_LEVEL_REWARD_ITEM_IDS, orderFlowerExperienceTransition } from './level-catalog.mjs';
import { assertOrderFlowerStoredPreparation, verifyOrderFlowerStoredTransition } from './stored-contract.mjs';
import { orderFlowerBranchCellShape } from './branch-shape.mjs';
import { officialAnswerProtocolChecks } from '../../official-server-version-contract.mjs';

const VERSION = 'order-flower-ordinary-verification/after-close-v1';
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const scalar = cell => knownOrderFlowerCell(cell) ? cell.value : null;
const codeOf = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(value) ? value : 'ORDER_FLOWER_POST_READ_FAILED';
const at = (raw, path) => {
  let value = raw;
  for (const key of path) { if (!plainObject(value) || !Object.hasOwn(value, key)) return { supplied: false, value: null }; value = value[key]; }
  return { supplied: true, value };
};
function dateMs(value) {
  if (positive(value) && value <= 8640000000000000) return value;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const result = Date.parse(value);
  return positive(result) && [value, value.replace('Z', '.000Z')].includes(new Date(result).toISOString()) ? result : null;
}
function itemMap(raw, path) {
  const entry = at(raw, path), map = entry.value;
  const known = entry.supplied && plainObject(map) && Object.keys(map).length <= 20000 && Object.entries(map).every(([id, quantity]) =>
    /^[1-9]\d*$/.test(id) && positive(Number(id)) && nonnegative(quantity));
  return { supplied: entry.supplied, known, values: known ? map : null };
}
const item = (map, id, completeMissingZero = false) => map.known && Object.hasOwn(map.values, String(id)) ? map.values[id]
  : map.known && completeMissingZero ? 0 : null;
function flowSummary(map) {
  const entries = map.known ? Object.entries(map.values).filter(([, quantity]) => quantity > 0)
    .map(([itemId, quantity]) => ({ itemId: Number(itemId), quantity })).sort((a, b) => a.itemId - b.itemId) : null;
  return { supplied: map.supplied, readable: map.known, totalPositiveEntries: entries?.length ?? null,
    entries: entries?.slice(0, 32) ?? null, complete: !!entries && entries.length <= 32,
    mapFingerprint: map.known ? fingerprint(map.values) : null };
}
function counter(raw, id) {
  const entry = at(raw, ['7', '4', String(id)]), value = entry.value;
  if (!entry.supplied || !plainObject(value) || !positive(value['0']) || value['1'] !== id ||
    !nonnegative(value['2']) || !nonnegative(value['3']) || !positive(dateMs(value['4']))) return null;
  return { uid: value['0'], type: id, raw: value['2'], totCnt: value['3'], rTime: dateMs(value['4']) };
}
function sourceBefore(source, proposal, response) {
  return (source?.kind ?? source?.sourceKind ?? source?.source) === 'response' &&
    source.connectionEpoch === proposal.connectionEpoch && positive(source.requestSequence) && source.requestSequence < response.requestSequence &&
    reference(source.responseRef) && reference(source.wireKey) && reference(source.method);
}
function knownOrder(row) {
  if (!knownOrderFlowerCell(row) || !row.readable || !plainObject(row.value)) return null;
  const { kind, boxId, fields } = row.value;
  if (!orderFlowerBranchCellShape(kind, boxId, fields)) return null;
  return { kind, boxId, ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, scalar(value)])) };
}
function snapshot({ proposal, response, observation, bridge }) {
  assertOrderFlowerProposal(proposal);
  assertOrderFlowerStoredPreparation(proposal);
  if (!bridge || observation !== bridge.newLoginObservation) return null;
  const proof = orderFlowerAfterCloseLoginProof({ proposal, response, bridge });
  const frame = decodeOfficialOrderFlowerObservation({ context: bridge.newContext, observation }), payload = frame?.payload;
  const fields = payload?.fields, order = proposal.orderFlower;
  if (!frame?.admissible || frame.source.method !== 'index.login' || frame.source.kind !== 'response' ||
    !knownOrderFlowerCell(payload.profileUid) || payload.profileUid.value !== order.officialUid ||
    !knownOrderFlowerCell(fields.uid) || fields.uid.value !== order.officialUid || !knownOrderFlowerCell(payload.domain) ||
    !knownOrderFlowerCell(fields.residentMap) || fields.residentMap.value.complete !== true || fields.residentMap.value.decodedComplete !== true ||
    fields.residentMap.value.total !== fields.residentMap.value.entries.length ||
    !knownOrderFlowerCell(fields.stockMap) || fields.stockMap.value.complete !== true ||
    !knownOrderFlowerCell(fields.tdyMap) || fields.tdyMap.value.complete !== true) return null;
  const bag = itemMap(observation.value, ['7', '0', '32']);
  const profile = Object.fromEntries([['gold', '44'], ['yb', '41'], ['level', '34'], ['lvlExp', '35']].map(([name, key]) =>
    [name, at(observation.value, ['7', '0', key])]));
  if (!bag.known || Object.values(profile).some(one => !one.supplied || !nonnegative(one.value)) || !positive(profile.level.value)) return null;
  let row;
  if (order.kind === 'resident') row = fields.residentMap.value.entries.find(one => one.value.boxId === order.boxId) || null;
  else {
    row = fields[order.kind];
    // An omitted scalar property is not an empty current order. Only an
    // actually supplied explicit null can prove this scalar order absent.
    if (!row || row.presence === 'missing') return null;
    if (row.presence === 'null') row = null;
  }
  const targetCounter = counter(observation.value, ORDER_FLOWER_CONTRACTS[order.kind].counterId), generationCounter = counter(observation.value, 107);
  if (!targetCounter || !generationCounter || [targetCounter.uid, generationCounter.uid].some(uid => uid !== order.officialUid)) return null;
  return { proof, frame, bag, profile: Object.fromEntries(Object.entries(profile).map(([key, value]) => [key, value.value])),
    row, targetCounter, generationCounter, stock: fields.stockMap.value.entries.find(one => one.boxId === order.boxId) || null };
}

export function validateOrderFlowerSnapshotCoverage({ proposal, response, observation, bridge = null, postReadBridge = null } = {}) {
  try { return snapshot({ proposal, response, observation, bridge: bridge || postReadBridge }) !== null; } catch { return false; }
}

// Only the already audited normal-anchor branch is supported here. Compare
// actual new-login timezone inputs against the ORIGINAL official day proof;
// no workstation Date offset or fabricated zero-uncertainty clock is created.
function sameOfficialDay(day, observation, proposal) {
  const proof = day?.timezoneProof, raw = at(observation.value, ['2', '11']).value;
  const ms = at(observation.value, ['2', '3']).value;
  const origin = proposal.orderFlower.source, source = day?.source;
  if (day?.known !== true || source?.method !== 'index.login' || source.officialUid !== proposal.orderFlower.officialUid ||
    source.connectionEpoch !== proposal.connectionEpoch || source.responseRef !== origin.responseRef || source.wireKey !== origin.wireKey ||
    source.requestSequence !== origin.requestSequence || !positive(ms) || observation.serverMs !== ms || ms < day?.startMs || ms >= day?.endMs ||
    day.endMs - day.startMs !== 86400000 || !Number.isSafeInteger(day.utcOffsetMinutes) || Math.abs(day.utcOffsetMinutes) > 840 ||
    proof?.kind !== 'matched-other-tzinfo-normal/v1' || !plainObject(raw) || !plainObject(raw.normal) ||
    !['type', 'ms', 'secNum', 'tzo'].every(key => (raw.normal[key] ?? null) === (proof.normal?.[key] ?? null))) return false;
  if (raw.normal.type !== 0 || !positive(raw.normal.ms) || !/^\d{14}$/.test(String(raw.normal.secNum)) ||
    Object.hasOwn(raw.normal, 'tzo') && raw.normal.tzo !== -day.utcOffsetMinutes) return false;
  const text = String(raw.normal.secNum), parts = [text.slice(0, 4), text.slice(4, 6), text.slice(6, 8), text.slice(8, 10), text.slice(10, 12), text.slice(12, 14)].map(Number);
  const wall = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
  if (wall - raw.normal.ms !== day.utcOffsetMinutes * 60000) return false;
  const split = raw.splitMap, previous = proof.splitMap;
  if (split !== null && split !== undefined) {
    const keys = plainObject(split) ? Object.keys(split) : null;
    if (!keys || keys.length > 16 || keys.some(year => !/^\d{4}$/.test(year) || Number(year) < 1970 || Number(year) > 9999 ||
      !Array.isArray(split[year]) || split[year].length !== 0) || previous?.presence !== 'present' ||
      previous.complete !== true || previous.totalAnchors !== 0 || previous.fingerprint !== fingerprint(split)) return false;
  } else if (previous?.totalAnchors !== 0 || previous?.totalYears !== 0 || previous.presence === 'present') return false;
  const start = Math.floor((ms + day.utcOffsetMinutes * 60000) / 86400000) * 86400000 - day.utcOffsetMinutes * 60000;
  return start === day.startMs && (observation.serverRespondedMs == null ||
    positive(observation.serverRespondedMs) && observation.serverRespondedMs >= start && observation.serverRespondedMs < day.endMs);
}
function result(proposal, response, reasonCode, { observation = null, state = null, afterOrder = null, flows = null,
  costs = null, rewards = null, counts = null, storedAccounting = null, effect = null, gateDiagnostics = null, confirmed = false } = {}) {
  const verdict = confirmed ? 'confirmed' : 'unknown', order = proposal.orderFlower, target = proposal.targets[0];
  const postReadRef = reference(observation?.responseRef) ? observation.responseRef : null, proof = state?.proof;
  return freeze({ verdict, verificationVersion: VERSION, reasonCode, postReadRef, targetEffect: effect,
    member: { memberKey: target.memberKey, verdict, reasonCode },
    resourceResolutions: proposal.resources.map(resource => ({ resourceKey: resource.resourceKey, state: 'historical_footprint',
      basisRefs: postReadRef ? [postReadRef] : [], coverageRef: null })),
    evidence: { version: VERSION, operationId: proposal.operationId, reasonCode, kind: order.kind, boxId: order.boxId,
      targetRef: target.targetRef, lifecycleRef: order.lifecycleRef, contentFingerprint: order.contentFingerprint,
      beforeOrder: clone(order.beforeOrder), afterOrder, answer: orderFlowerSafeSource(response), postRead: orderFlowerSafeSource(observation),
      flows, costs, rewards, counts, targetEffect: effect,
      ...(storedAccounting ? { storedAccounting } : {}),
      day: { key: order.day.key ?? null, startMs: order.day.startMs, endMs: order.day.endMs, proofRef: order.day.proofRef,
        timezoneProofFingerprint: order.day.timezoneProof ? fingerprint(order.day.timezoneProof) : null },
      bridge: proof ? { leaseRef: proof.leaseRef, bridgeFingerprint: proof.bridgeFingerprint,
        closureEvidenceRef: proof.oldPhysicalCloseReceipt.closureEvidenceRef, originalConnectionEpoch: proof.originalContext.connectionEpoch,
        newConnectionEpoch: proof.newContext.connectionEpoch, writeResponseRef: proof.after.responseRef, newLoginResponseRef: proof.newLogin.responseRef } : null,
      ...(gateDiagnostics ? { gateDiagnostics } : {}),
      counterOrOrderChangeAloneConfirmsNothing: true, resourceCoverageApplied: false } });
}
export function answerGateDiagnostics(proposal, response, version, anchor) {
  const protocols = officialAnswerProtocolChecks(response, anchor, proposal, proposal.orderFlower?.officialUid);
  const checks = [
    ['source', 'response.source', 'response', response?.source], ['transport', 'response.transport', 'answered', response?.transport],
    ['method', 'response.method', proposal.method, response?.method], ['connectionEpoch', 'response.connectionEpoch', proposal.connectionEpoch, response?.connectionEpoch],
    ['requestSequence', 'response.requestSequence', 'positive-integer', response?.requestSequence], ['wireKey', 'response.wireKey', 'reference', response?.wireKey],
    ['responseRef', 'response.responseRef', 'reference', response?.responseRef], ['envelopeOk', 'response.envelopeOk', true, response?.envelopeOk],
    ['dsName', 'response.dsName', 'G.ISyncData', response?.dsName], ['rejected', 'response.rejected', 'not-true', response?.rejected],
    ['messagePresent', 'response.messagePresent', 'false-or-notice-only', response?.messagePresent],
    ['noticeOnly', 'response.noticeOnly', 'true-when-message-present', response?.noticeOnly],
    ['version.gameVersion', 'response.versionEvidence.gameVersion', anchor.gameVersion, version?.gameVersion],
    ['version.protocolVersion', 'response.versionEvidence.protocolVersion', anchor.protocolVersion, version?.protocolVersion],
    ['version.loginResponseRef', 'response.versionEvidence.loginResponseRef', anchor.loginResponseRef, version?.loginResponseRef],
    ['protocolVersion', 'response.protocolVersion', 'absent-or-equal', response?.protocolVersion],
  ];
  const gates = checks.map(([name, path, expected, actual]) => {
    let passed;
    if (name === 'version.protocolVersion') passed = protocols.versionProtocol;
    else if (name === 'protocolVersion') passed = protocols.frameProtocol;
    else if (expected === 'positive-integer') passed = positive(actual);
    else if (expected === 'reference') passed = reference(actual);
    else if (expected === 'not-true') passed = actual !== true;
    else if (expected === 'false-or-notice-only') passed = actual !== true || response?.noticeOnly === true;
    else if (expected === 'true-when-message-present') passed = response?.messagePresent !== true || actual === true;
    else if (expected === 'absent-or-equal') passed = actual == null || actual === anchor.protocolVersion;
    else passed = actual === expected;
    const expectedType = typeof expected === 'string' ? 'string-or-contract' : typeof expected;
    const actualType = actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual;
    const gate = { name, path, expectedType, actualType, passed };
    if (['reference', 'positive-integer', 'not-true', 'false-or-notice-only', 'true-when-message-present', 'absent-or-equal'].includes(expected)) gate.expected = expected;
    return gate;
  });
  const failedGateNames = gates.filter(gate => !gate.passed).map(gate => gate.name);
  return { version: 'matched-answer-gates/v1', contractVersion: VERSION, operationId: proposal.operationId,
    responseRef: reference(response?.responseRef) ? response.responseRef : null,
    phase: 'matched-answer-verification', outcomeState: failedGateNames.length ? 'failed' : 'passed',
    reasonCode: failedGateNames.length ? 'ORDER_FLOWER_GATE_' + failedGateNames[0].replace(/[^A-Za-z0-9]+/g, '_').toUpperCase() : null,
    versionEvidence: { gameVersionPresent: typeof version?.gameVersion === 'string', gameVersionEqual: version?.gameVersion === anchor.gameVersion,
      protocolVersionPresent: typeof version?.protocolVersion === 'string', protocolVersionEqual: version?.protocolVersion === anchor.protocolVersion,
      loginResponseRefPresent: reference(version?.loginResponseRef), loginResponseRefEqual: version?.loginResponseRef === anchor.loginResponseRef },
    gates, failedGateNames };
}
function analyze({ proposal, response, observation, bridge }) {
  assertOrderFlowerProposal(proposal);
  const storedBefore = assertOrderFlowerStoredPreparation(proposal);
  const order = proposal.orderFlower, definition = ORDER_FLOWER_CONTRACTS[order.kind], version = response?.versionEvidence, anchor = order.versionEvidence;
  const context = { observation }, finish = (reasonCode, extra = {}) => result(proposal, response, reasonCode, { ...context, ...extra });
  const gateDiagnostics = answerGateDiagnostics(proposal, response, version, anchor);
  if (gateDiagnostics.failedGateNames.length) return finish('ORDER_FLOWER_MATCHED_ANSWER_UNPROVEN', { gateDiagnostics });
  const beforeSources = [order.source, order.counter?.source, order.beforeGenerationCounter?.source,
    order.beforeProfile?.source, order.beforeRewards?.source,
    ...['gold', 'yb', 'level', 'lvlExp'].map(key => order.beforeProfile?.sources?.[key]),
    ...['satin', 'decorate'].map(key => order.beforeRewards?.sources?.[key]), ...order.beforeItems.map(one => one.source)];
  if (!beforeSources.every(source => sourceBefore(source, proposal, response))) return finish('ORDER_FLOWER_BEFORE_SOURCES_UNPROVEN');
  let state;
  try { state = snapshot({ proposal, response, observation, bridge }); } catch { /* Missing exact proof is not a business result. */ }
  if (!state) return finish('ORDER_FLOWER_FRESH_LOGIN_COVERAGE_MISSING');
  context.state = state;
  if (!sameOfficialDay(order.day, observation, proposal) || state.targetCounter.rTime > observation.serverMs || state.generationCounter.rTime > observation.serverMs) return finish('ORDER_FLOWER_SAME_OFFICIAL_DAY_UNPROVEN');
  for (const path of [['7', '0', '0'], ['105', '0', '0']]) {
    const uid = at(response.value, path);
    if (uid.supplied && uid.value !== order.officialUid) return finish('ORDER_FLOWER_ANSWER_UID_CONFLICT');
  }
  const names = { bi: '0', bo: '1', bd: '2', actBi: '3', actBo: '4', proxyBi: '5', proxyBo: '6' };
  const maps = Object.fromEntries(Object.entries(names).map(([name, key]) => [name, itemMap(response.value, ['7', '2', key])]));
  context.flows = Object.fromEntries(Object.entries(maps).map(([name, map]) => [name, flowSummary(map)]));
  if (!maps.bo.known || !maps.bi.known || Object.values(maps).some(map => map.supplied && !map.known)) return finish('ORDER_FLOWER_ITEM_FLOWS_UNREADABLE');
  const requirements = orderFlowerRequirements(order.beforeOrder.flowers), ids = new Set(requirements.map(one => one.itemId));
  if (Object.entries(maps.bo.values).some(([id, quantity]) => quantity > 0 && !ids.has(Number(id))) ||
    [maps.actBo, maps.proxyBo].some(map => map.known && Object.values(map.values).some(value => value > 0)) ||
    requirements.some(one => item(maps.bo, one.itemId, true) > one.quantity)) return finish('ORDER_FLOWER_UNEXPECTED_COST');
  if (!requirements.every(one => item(maps.bo, one.itemId) === one.quantity)) return finish('ORDER_FLOWER_EXACT_MULTIPLICITY_CONSUMPTION_UNPROVEN');
  const main = item(maps.bi, definition.rewardItemId, true), experience = item(maps.bi, 2, true);
  const transition = orderFlowerExperienceTransition({ before: order.beforeProfile, after: state.profile, experience });
  if (!transition.known) return finish(transition.reasonCode);
  const upgradeCandidates = new Map(transition.rewardCandidates.map(one => [one.itemId, one.maximumQuantity]));
  const allowedGains = new Set([definition.rewardItemId, 2, ...upgradeCandidates.keys()]);
  if (Object.entries(maps.bi.values).some(([id, quantity]) => quantity > 0 && !allowedGains.has(Number(id))) ||
    [maps.actBi, maps.proxyBi].some(map => map.known && Object.values(map.values).some(value => value > 0))) return finish('ORDER_FLOWER_ORDINARY_REWARD_AMBIGUOUS');
  if (!positive(main) || !nonnegative(experience)) return finish('ORDER_FLOWER_ORDINARY_REWARD_NOT_OBSERVED');
  // Static level items only bound additional gains after an ACTUAL level
  // increase. They do not prove that any reward was granted. If item 1106 is
  // shared with satin's primary reward, only an honest lower bound on the
  // ordinary component is available; zero lower bound remains unknown.
  const ordinaryMainLowerBound = main - (upgradeCandidates.get(definition.rewardItemId) || 0);
  if (!positive(ordinaryMainLowerBound)) return finish('ORDER_FLOWER_LEVEL_REWARD_ATTRIBUTION_AMBIGUOUS');
  const extraGains = Object.entries(maps.bi.values).filter(([id, quantity]) => quantity > 0 && ![definition.rewardItemId, 2].includes(Number(id)))
    .map(([id, quantity]) => ({ itemId: Number(id), quantity, maximumQuantity: upgradeCandidates.get(Number(id)) ?? null }));
  if (extraGains.some(one => !positive(one.maximumQuantity) || one.quantity > one.maximumQuantity)) return finish('ORDER_FLOWER_LEVEL_REWARD_EXCEEDS_SOURCE_CANDIDATES');
  const upgradeBefore = order.beforeLevelRewardItems;
  if (upgradeBefore !== undefined && (!Array.isArray(upgradeBefore) || upgradeBefore.length > ORDER_FLOWER_LEVEL_REWARD_ITEM_IDS.length ||
    new Set(upgradeBefore.map(one => one?.itemId)).size !== upgradeBefore.length || !upgradeBefore.every(one =>
      ORDER_FLOWER_LEVEL_REWARD_ITEM_IDS.includes(one.itemId) && nonnegative(one.quantity) && sourceBefore(one.source, proposal, response)))) {
    return finish('ORDER_FLOWER_LEVEL_REWARD_BEFORE_BASIS_UNPROVEN');
  }
  const levelRewards = extraGains.map(one => {
    const initial = order.beforeItems.find(item => item.itemId === one.itemId) ||
      (one.itemId === 1106 ? { quantity: order.beforeRewards.satin, source: order.beforeRewards.sources.satin } :
        one.itemId === 1340 ? { quantity: order.beforeRewards.decorate, source: order.beforeRewards.sources.decorate } :
          upgradeBefore?.find(item => item.itemId === one.itemId));
    const spent = requirements.find(item => item.itemId === one.itemId)?.quantity || 0;
    return { ...one, before: initial?.quantity ?? null, after: item(state.bag, one.itemId, true), spent,
      bd: item(maps.bd, one.itemId), source: orderFlowerSafeSource(initial?.source) };
  });
  if (levelRewards.some(one => !nonnegative(one.before) || !sourceBefore(one.source, proposal, response) ||
    one.after !== one.before - one.spent + one.quantity || one.bd !== null && one.bd !== one.after)) return finish('ORDER_FLOWER_LEVEL_REWARD_ABSOLUTE_EFFECT_UNPROVEN');
  context.costs = requirements.map(one => {
    const before = order.beforeItems.find(item => item.itemId === one.itemId), after = item(state.bag, one.itemId, true);
    return { itemId: one.itemId, quantity: one.quantity, before: before.quantity, after, bo: item(maps.bo, one.itemId),
      bi: item(maps.bi, one.itemId, true), bd: item(maps.bd, one.itemId), basisRef: before.basisRef, source: orderFlowerSafeSource(before.source) };
  });
  if (context.costs.some(one => one.before < one.quantity || one.after !== one.before - one.quantity + one.bi || one.bd !== null && one.bd !== one.after)) return finish('ORDER_FLOWER_ABSOLUTE_FLOWER_EFFECT_CONFLICT');
  const gold = order.beforeProfile.gold + (definition.rewardItemId === 11 ? main : 0), yb = order.beforeProfile.yb;
  const satin = order.beforeRewards.satin + item(maps.bi, 1106, true), decorate = order.beforeRewards.decorate + item(maps.bi, 1340, true);
  context.rewards = { mainItemId: definition.rewardItemId, mainQuantity: main, experienceQuantity: experience,
    mainQuantityScope: 'total-observed-bi', ordinaryMainQuantityRange: { lowerBound: ordinaryMainLowerBound, upperBound: main },
    experienceTransition: transition, observedLevelRewards: levelRewards,
    profile: { before: { gold: order.beforeProfile.gold, yb, level: order.beforeProfile.level ?? null, lvlExp: order.beforeProfile.lvlExp ?? null }, after: state.profile },
    satin: { before: order.beforeRewards.satin, after: item(state.bag, 1106, true) },
    decorate: { before: order.beforeRewards.decorate, after: item(state.bag, 1340, true) },
    propertyMappings: { 11: '7.0.44/gld', 2: '7.0.35/lvlExp', 1: '7.0.41/dmd' } };
  if (![gold, yb, satin, decorate].every(nonnegative) || state.profile.gold !== gold || state.profile.yb !== yb ||
    item(state.bag, 1106, true) !== satin || item(state.bag, 1340, true) !== decorate) return finish('ORDER_FLOWER_ABSOLUTE_REWARD_EFFECT_CONFLICT');
  for (const [id, expected] of [[11, gold], [1, yb], [2, state.profile.lvlExp], [1106, satin], [1340, decorate]]) {
    const value = item(maps.bd, id);
    if (value !== null && value !== expected) return finish('ORDER_FLOWER_WRITE_ABSOLUTE_REWARD_CONFLICT');
  }
  for (const [key, expected] of [['44', gold], ['41', yb], ['34', state.profile.level], ['35', state.profile.lvlExp]]) {
    const value = at(response.value, ['7', '0', key]);
    if (value.supplied && value.value !== expected) return finish('ORDER_FLOWER_WRITE_PROFILE_CONFLICT');
  }
  const before = order.counter, originalGeneration = order.beforeGenerationCounter;
  const effectiveBefore = before.rawRTime < order.day.startMs ? 0 : before.raw;
  const after = state.targetCounter, effectiveAfter = after.rTime < order.day.startMs ? 0 : after.raw;
  const nextOrder = state.row ? knownOrder(state.row) : null;
  if (state.row && !nextOrder) return finish('ORDER_FLOWER_REPLACEMENT_ROW_UNREADABLE');
  const orderInDay = one => positive(one?.cTime) && one.cTime >= order.day.startMs && one.cTime < order.day.endMs;
  // G480 Butler's finished projection subtracts the outstanding scalar order
  // only when that order was created in this official day. The display helper
  // always subtracts one. Neither is an independent delivery receipt.
  const beforeOffset = order.kind === 'resident' ? 0 : Number(orderInDay(order.beforeOrder));
  const afterOffset = order.kind === 'resident' ? 0 : Number(orderInDay(nextOrder));
  const beforeFinished = Math.max(0, effectiveBefore - beforeOffset), afterFinished = Math.max(0, effectiveAfter - afterOffset);
  context.counts = { counterId: definition.counterId, projectionKind: 'official-client-stock-allocation-finished-projection',
    before: { raw: before.raw, total: before.total ?? null, rTime: before.rawRTime, effective: effectiveBefore, offset: beforeOffset, value: before.value,
      uiDisplayValue: Math.max(0, effectiveBefore - definition.countOffset) },
    after: { ...after, effective: effectiveAfter, offset: afterOffset, value: afterFinished, uiDisplayValue: Math.max(0, effectiveAfter - definition.countOffset) },
    projectionDelta: afterFinished - beforeFinished, rawGenerationIncrement: storedBefore ? after.raw - before.raw : 1, serviceDeliveryCounterClaimed: false,
    generationBefore: originalGeneration ? { uid: originalGeneration.uid ?? null, type: originalGeneration.type ?? null, raw: originalGeneration.raw ?? null,
      totCnt: originalGeneration.totCnt ?? null, rTime: originalGeneration.rTime ?? null } : null, generationAfter: state.generationCounter,
    otherCounters: [] };
  if (!nonnegative(before.total) || before.value !== beforeFinished || !storedBefore &&
    (after.totCnt !== before.total + 1 || effectiveAfter !== effectiveBefore + 1)) return finish('ORDER_FLOWER_TARGET_DAY_COUNTER_EFFECT_UNPROVEN');
  if (!originalGeneration || originalGeneration.uid !== order.officialUid || originalGeneration.type !== 107 ||
    !nonnegative(originalGeneration.raw) || !nonnegative(originalGeneration.totCnt) || !positive(originalGeneration.rTime) ||
    ['uid', 'type', 'raw', 'totCnt', 'rTime'].some(key => originalGeneration[key] !== state.generationCounter[key])) return finish('ORDER_FLOWER_GENERATION_COUNTER_CHANGED_OR_UNKNOWN');
  if (!Array.isArray(order.beforeOtherCounters) || order.beforeOtherCounters.length > 2 ||
    new Set(order.beforeOtherCounters.map(one => one?.type)).size !== order.beforeOtherCounters.length) return finish('ORDER_FLOWER_OTHER_COUNTER_BASIS_UNPROVEN');
  for (const old of order.beforeOtherCounters) {
    if (![105, 109, 116].includes(old.type) || old.type === definition.counterId || old.uid !== order.officialUid ||
      !nonnegative(old.raw) || !nonnegative(old.totCnt) || !positive(old.rTime) || !sourceBefore(old.source, proposal, response)) return finish('ORDER_FLOWER_OTHER_COUNTER_BASIS_UNPROVEN');
    const next = counter(observation.value, old.type); context.counts.otherCounters.push({ before: { uid: old.uid, type: old.type, raw: old.raw, totCnt: old.totCnt, rTime: old.rTime }, after: next });
    if (!next || !storedBefore && ['uid', 'type', 'raw', 'totCnt', 'rTime'].some(key => next[key] !== old[key])) return finish('ORDER_FLOWER_OTHER_CATEGORY_COUNTER_CHANGED');
  }
  if (storedBefore) {
    const checked = verifyOrderFlowerStoredTransition({ proposal, response, observation, afterDecoded: state.frame });
    context.storedAccounting = checked.evidence;
    if (!checked.known) return finish(checked.reasonCode);
  } else if (state.stock && (!knownOrderFlowerCell(state.stock.stockNum) || state.stock.stockNum.value !== 0)) return finish('ORDER_FLOWER_BUTLER_STOCK_EFFECT_UNPROVEN');
  let effect;
  if (state.row) {
    const next = knownOrder(state.row); context.afterOrder = next;
    if (!next) return finish('ORDER_FLOWER_REPLACEMENT_ROW_UNREADABLE');
    const old = order.beforeOrder, changed = fingerprint(orderFlowerContent(order.kind, order.boxId, next)) !== order.contentFingerprint;
    const explicitCooldown = positive(next.cdTime) && (old.cdTime === null || next.cdTime > old.cdTime);
    if (!changed && !explicitCooldown) return finish('ORDER_FLOWER_ORIGINAL_ORDER_OR_COOLDOWN_UNCHANGED');
    effect = { kind: changed ? 'distinguished-current-order' : 'explicit-cooldown-transition', boxId: order.boxId,
      originalLifecycleRef: order.lifecycleRef, originalContentFingerprint: order.contentFingerprint,
      newContentFingerprint: fingerprint(orderFlowerContent(order.kind, order.boxId, next)), cooldownBefore: old.cdTime, cooldownAfter: next.cdTime,
      newOccurrenceIdentityCreatedByVerifier: false };
  } else effect = { kind: 'absent-in-actually-provided-current-property', boxId: order.boxId,
    originalLifecycleRef: order.lifecycleRef, originalContentFingerprint: order.contentFingerprint, newOccurrenceIdentityCreatedByVerifier: false };
  return finish(storedBefore ? 'ORDER_FLOWER_STORED_EXACT_EFFECT_CONFIRMED' : 'ORDER_FLOWER_ORDINARY_EXACT_EFFECT_CONFIRMED', { effect, confirmed: true });
}

export function validateOrderFlowerTargetVerification({ proposal, response, verification, postReads, bridge = null, postReadBridge = null } = {}) {
  try {
    const packet = bridge || postReadBridge, observation = packet?.newLoginObservation;
    if (verification?.verdict !== 'confirmed' || !Array.isArray(postReads) || !postReads.includes(observation) || observation.responseRef !== verification.postReadRef) return false;
    const derived = analyze({ proposal, response, observation, bridge: packet });
    return derived.verdict === 'confirmed' && canonical(derived) === canonical(verification);
  } catch { return false; }
}
export function createOrderFlowerVerification({ isLeaseCurrent = null } = {}) {
  if (isLeaseCurrent !== null && (typeof isLeaseCurrent !== 'function' || isLeaseCurrent.constructor?.name === 'AsyncFunction')) throw new TypeError('Order flower lease-current guard must be synchronous');
  const current = input => {
    if (!isLeaseCurrent) return false;
    const value = isLeaseCurrent(input);
    if (value?.then) { value.catch?.(() => {}); throw new TypeError('Order flower lease-current guard must be synchronous'); }
    return value === true;
  };
  async function verify({ proposal, response, connection, signal }) {
    assertOrderFlowerProposal(proposal);
    const unknown = (reasonCode, observation = null) => result(proposal, response, reasonCode, { observation });
    if (signal?.aborted || connection?.isOpen?.() !== true || typeof connection.readSnapshotAfterClose !== 'function') return unknown('ORDER_FLOWER_READ_LEASE_UNAVAILABLE');
    let bridge;
    try { signal?.throwIfAborted(); bridge = await connection.readSnapshotAfterClose(); }
    catch (error) { return unknown(codeOf(error?.code)); }
    if (signal?.aborted || connection.isOpen() !== true || !current({ proposal, response, bridge })) return unknown('ORDER_FLOWER_READ_LEASE_REVOKED', bridge?.newLoginObservation);
    const verified = analyze({ proposal, response, observation: bridge.newLoginObservation, bridge });
    if (signal?.aborted || connection.isOpen() !== true || !current({ proposal, response, bridge })) return unknown('ORDER_FLOWER_READ_LEASE_REVOKED', bridge.newLoginObservation);
    return verified;
  }
  return Object.freeze({ verify });
}
