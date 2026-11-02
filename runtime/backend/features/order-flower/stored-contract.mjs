import { canonical, clone, fingerprint, freeze, plainObject, problem } from '../../common.mjs';
import { decodeOfficialOrderFlowerObservation, knownOrderFlowerCell, orderFlowerContext, orderFlowerContextKey,
  sameOrderFlowerContext } from './wire-facts.mjs';
import { ORDER_FLOWER_STORED_DELIVERY_CONTRACT } from './butler.mjs';
import { isNormalSyncMethod } from '../../facts/normal-sync-contract.mjs';

export const ORDER_FLOWER_STORED_CONTRACT = ORDER_FLOWER_STORED_DELIVERY_CONTRACT;
const BEFORE_VERSION = 'order-flower-stored-before/480.0.27/v1';
const EFFECT_VERSION = 'order-flower-stored-transition/480.0.27/v1';
const GAME_SHA = 'fc9970989021e4266301d2a167ae8e827ef71a124ad9d7f23cb922095a22aa69';
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const kinds = { resident: { counterId: 105, boxIds: [1, 2, 3, 4, 5, 6] }, satin: { counterId: 109, boxIds: [7] }, decorate: { counterId: 116, boxIds: [8] } };
const fail = code => { throw problem(code, '管家存单需要原始来源、官方时钟和完整有限会计证明', 400); };
const value = cell => knownOrderFlowerCell(cell) ? cell.value : null;
const source = input => input ? Object.fromEntries(['kind', 'transport', 'method', 'contextKey', 'connectionEpoch', 'requestSequence',
  'responseRef', 'wireKey', 'serverMs', 'serverRespondedMs', 'version'].map(key => [key, input[key] ?? null])) : null;
const sourceBefore = (one, context, afterSequence = Infinity) => one?.kind === 'response' && one.transport === 'answered' &&
  one.contextKey === orderFlowerContextKey(context) && one.connectionEpoch === context.connectionEpoch && positive(one.requestSequence) && isNormalSyncMethod(one.method) &&
  one.requestSequence < afterSequence && reference(one.responseRef) && /^ws\|\d+\|[1-9]\d*$/.test(one.wireKey || '') &&
  Number(one.wireKey.split('|').at(-1)) === one.requestSequence && one.version?.source === 'normal-package-hop-and-matched-world-login/v1' &&
  one.version.gameVersion === '480.0.27' && one.version.protocolVersion === '480.0.0' && reference(one.version.loginResponseRef);
function timeField(cell) {
  if (cell?.presence === 'missing' || cell?.presence === 'null') return { presence: cell.presence, value: null };
  return knownOrderFlowerCell(cell) && positive(cell.value) ? { presence: 'present', value: cell.value } : null;
}
function stockRows(cell) {
  if (!knownOrderFlowerCell(cell) || cell.value?.complete !== true || !Array.isArray(cell.value.entries) || cell.value.entries.length > 8) return null;
  const output = [];
  for (const row of cell.value.entries) {
    const calcTime = timeField(row.calcTime), maxStockTime = timeField(row.maxStockTime);
    if (!positive(row.boxId) || row.boxId > 8 || !knownOrderFlowerCell(row.domain) || !knownOrderFlowerCell(row.stockNum) ||
        !nonnegative(row.stockNum.value) || !calcTime || !maxStockTime) return null;
    output.push({ boxId: row.boxId, stockNum: row.stockNum.value, calcTime, maxStockTime });
  }
  return new Set(output.map(one => one.boxId)).size === output.length ? output.sort((a, b) => a.boxId - b.boxId) : null;
}
function rowFor(rows, boxId) {
  return rows.find(one => one.boxId === boxId) || { boxId, stockNum: 0,
    calcTime: { presence: 'missing', value: null }, maxStockTime: { presence: 'missing', value: null }, absentInProvidedCompleteMap: true };
}
const stripHash = proof => Object.fromEntries(Object.entries(proof).filter(([key]) => key !== 'fingerprint'));

// The stable basis deliberately excludes continuously changing clock.now.
// A real stock tick/source/day/hire change changes the accounting reference;
// merely inserting this operation's reservation does not.
export function orderFlowerStoredBasis(proof) {
  if (proof == null) return null;
  const body = { version: BEFORE_VERSION, contract: proof.contract, context: proof.context, kind: proof.kind, boxId: proof.boxId,
    officialUid: proof.officialUid, rawStockFingerprint: proof.rawStockFingerprint, accountingBasisRef: proof.accountingBasisRef,
    selectedBoxBasisRef: proof.selectedBox?.basisRef ?? null, effectiveStockNum: proof.selectedBox?.effectiveStockNum ?? null,
    dailyFingerprint: fingerprint(proof.daily), hireFingerprint: fingerprint(proof.hire),
    officialDayProofRef: proof.day?.proofRef ?? null, stockSource: proof.stockSource };
  return freeze({ ...body, basisRef: 'order-stored-basis:' + fingerprint(body) });
}

export function captureOrderFlowerStoredBefore({ context: supplied, view, accounting, candidate, clock, officialDay } = {}) {
  const context = orderFlowerContext(supplied), kind = candidate?.kind, boxId = candidate?.boxId, selected = accounting?.boxes?.[boxId],
    uid = value(view?.identity?.uid), stock = view?.fields?.stockMap, rawStocks = stockRows(stock);
  if (!context || !kinds[kind]?.boxIds.includes(boxId) || !sameOrderFlowerContext(context, view?.context) || !view.current || !view.available ||
      !view.identity?.verified || !positive(uid) || view.identity.uid.current !== true || !sourceBefore(view.identity.source, context) ||
      view.identity.source.method !== 'index.login' || !sourceBefore(stock?.source, context) || stock.current !== true || !rawStocks ||
      stock.source.version.loginResponseRef !== view.identity.source.responseRef ||
      accounting?.version !== 'order-flower-butler-accounting/480.0.27/v1' || !sameOrderFlowerContext(accounting.context, context) ||
      accounting.officialUid !== uid || accounting.staticSource?.gameDecodedSha256 !== GAME_SHA || !reference(accounting.basisRef) ||
      selected?.known !== true || selected.boxId !== boxId || selected.kind !== kind || !positive(selected.effectiveStockNum) ||
      !positive(selected.capacity) || !positive(selected.cdSeconds) || !reference(selected.basisRef) ||
      canonical(selected.source) !== canonical(stock.source)) fail('ORDER_STORED_CURRENT_ACCOUNTING_REQUIRED');
  if (clock?.available !== true || clock.source !== 'official-anchor-monotonic' || clock.connectionEpoch !== context.connectionEpoch ||
      !Number.isFinite(clock.nowMs) || !Number.isFinite(clock.lowerBoundMs) || !Number.isFinite(clock.upperBoundMs) ||
      clock.lowerBoundMs > clock.nowMs || clock.upperBoundMs < clock.nowMs || clock.lowerBoundMs <= 0 ||
      officialDay?.known !== true || !positive(officialDay.startMs) || officialDay.endMs - officialDay.startMs !== 86400000 ||
      clock.lowerBoundMs < officialDay.startMs || clock.upperBoundMs >= officialDay.endMs || !reference(officialDay.proofRef)) fail('ORDER_STORED_OFFICIAL_TIME_REQUIRED');
  const groupBoxes = kinds[kind].boxIds.filter(id => accounting.boxes[id]);
  if (!groupBoxes.includes(boxId) || groupBoxes.some(id => accounting.boxes[id]?.known !== true ||
      !nonnegative(accounting.boxes[id].effectiveStockNum)) || accounting.daily?.[kind]?.known !== true) fail('ORDER_STORED_COMPLETE_CATEGORY_ACCOUNTING_REQUIRED');
  const rawTdys = tdys({ payload: { fields: { tdyMap: view.fields.tdyMap } } });
  if (!rawTdys || view.fields.tdyMap.current !== true || !sourceBefore(view.fields.tdyMap.source, context)) fail('ORDER_STORED_ORIGINAL_TDY_MAP_REQUIRED');
  const counters = [], unobservedOtherCounters = [];
  for (const id of [105, 109, 116]) {
    const row = view.counters?.[id];
    if (!['uid', 'type', 'tdyCnt', 'totCnt', 'rTime'].every(key => row?.[key]?.current === true && knownOrderFlowerCell(row[key]) && sourceBefore(row[key].source, context)) ||
        value(row.uid) !== uid || value(row.type) !== id) {
      if (id === kinds[kind].counterId) fail('ORDER_STORED_ORIGINAL_TARGET_COUNTER_REQUIRED');
      unobservedOtherCounters.push({ counterId: id, reasonCode: 'OTHER_CATEGORY_COUNTER_NOT_CURRENTLY_OBSERVED', treatedAsZero: false });
      continue;
    }
    counters.push({ counterId: id, uid, raw: value(row.tdyCnt), total: value(row.totCnt), rTime: value(row.rTime), source: source(row.tdyCnt.source) });
  }
  const body = { version: BEFORE_VERSION, contract: ORDER_FLOWER_STORED_CONTRACT, context, kind, boxId, officialUid: uid,
    stockSource: source(stock.source), rawStocks, rawStockFingerprint: fingerprint(rawStocks),
    accountingBasisRef: accounting.basisRef, selectedBox: clone(selected),
    groupBoxes: groupBoxes.map(id => clone(accounting.boxes[id])), daily: clone(accounting.daily[kind]), hire: clone(accounting.hire), counters, unobservedOtherCounters, rawTdys,
    day: { known: true, key: officialDay.key ?? null, startMs: officialDay.startMs, endMs: officialDay.endMs, proofRef: officialDay.proofRef },
    clock: { source: clock.source, connectionEpoch: context.connectionEpoch, nowMs: clock.nowMs,
      lowerBoundMs: clock.lowerBoundMs, upperBoundMs: clock.upperBoundMs, revision: clock.revision ?? null },
    sourceContract: clone(accounting.staticSource), actualFlowersStillRequired: true, stockProjectionAloneConfirmsNothing: true };
  return freeze({ ...body, fingerprint: fingerprint(body) });
}

export function assertOrderFlowerStoredPreparation(proposal) {
  const order = proposal?.orderFlower, proof = order?.beforeStored;
  if (order?.deliveryPath !== 'butler-stored-order') {
    if (order?.deliveryPath !== undefined && order.deliveryPath !== 'ordinary-ready-order') fail('ORDER_STORED_DELIVERY_PATH_INVALID');
    if (proof !== undefined && proof !== null) fail('ORDER_STORED_PROOF_PATH_CONFLICT');
    return null;
  }
  const context = orderFlowerContext(proposal), box = proof?.selectedBox;
  if (!context || !plainObject(proof) || proof.version !== BEFORE_VERSION || proof.contract !== ORDER_FLOWER_STORED_CONTRACT ||
      !digest(proof.fingerprint) || fingerprint(stripHash(proof)) !== proof.fingerprint || !sameOrderFlowerContext(proof.context, context) ||
      proof.kind !== order.kind || proof.boxId !== order.boxId || !kinds[proof.kind]?.boxIds.includes(proof.boxId) || proof.officialUid !== order.officialUid ||
      !Array.isArray(proof.rawStocks) || proof.rawStocks.length > 8 || fingerprint(proof.rawStocks) !== proof.rawStockFingerprint ||
      !sourceBefore(proof.stockSource, context) ||
      proof.stockSource.version.loginResponseRef !== order.versionEvidence?.loginResponseRef ||
      !reference(proof.accountingBasisRef) || box?.known !== true || !positive(box.effectiveStockNum) || box.boxId !== order.boxId || box.kind !== order.kind ||
      box.capacity !== (order.kind === 'resident' ? 70 : 40) || box.cdSeconds !== (order.kind === 'resident' ? 42 : 60) || !reference(box.basisRef) ||
      !Array.isArray(proof.groupBoxes) || !proof.groupBoxes.length || proof.groupBoxes.length > 6 ||
      new Set(proof.groupBoxes.map(one => one.boxId)).size !== proof.groupBoxes.length ||
      !proof.groupBoxes.every(one => one.known === true && one.kind === order.kind && kinds[order.kind].boxIds.includes(one.boxId) &&
        nonnegative(one.effectiveStockNum) && one.cdSeconds === box.cdSeconds && one.capacity === box.capacity &&
        canonical(source(one.source)) === canonical(proof.stockSource)) ||
      canonical(proof.groupBoxes.find(one => one.boxId === order.boxId)) !== canonical(box) ||
      proof.daily?.known !== true || !nonnegative(proof.daily.finishedCount) || !nonnegative(proof.daily.remainingForGeneration) || !positive(proof.daily.officialLimit) ||
      !Array.isArray(proof.rawTdys) || proof.rawTdys.length > 8 || new Set(proof.rawTdys.map(one => one.boxId)).size !== proof.rawTdys.length ||
      !proof.rawTdys.every(one => positive(one.boxId) && one.boxId <= 8 && nonnegative(one.count)) ||
      !Array.isArray(proof.counters) || proof.counters.length < 1 || proof.counters.length > 3 || new Set(proof.counters.map(one => one.counterId)).size !== proof.counters.length ||
      !proof.counters.some(one => one.counterId === kinds[proof.kind].counterId) ||
      !proof.counters.every(one => [105, 109, 116].includes(one.counterId) && one.uid === order.officialUid && nonnegative(one.raw) && nonnegative(one.total) &&
        positive(one.rTime) && sourceBefore(one.source, context)) || proof.day?.proofRef !== order.day?.proofRef || proof.day.startMs !== order.day.startMs ||
      proof.day.endMs !== order.day.endMs || proof.clock?.source !== 'official-anchor-monotonic' || proof.clock.connectionEpoch !== context.connectionEpoch ||
      !Number.isFinite(proof.clock.nowMs) || !Number.isFinite(proof.clock.lowerBoundMs) || !Number.isFinite(proof.clock.upperBoundMs) || proof.clock.lowerBoundMs > proof.clock.nowMs ||
      proof.clock.upperBoundMs < proof.clock.nowMs || proof.clock.lowerBoundMs < proof.day.startMs || proof.clock.upperBoundMs >= proof.day.endMs ||
      proof.sourceContract?.gameDecodedSha256 !== GAME_SHA || proof.actualFlowersStillRequired !== true || proof.stockProjectionAloneConfirmsNothing !== true) {
    fail('ORDER_STORED_ORIGINAL_PREPARATION_INVALID');
  }
  const validTime = cell => plainObject(cell) && ['present', 'null', 'missing'].includes(cell.presence) &&
    (cell.presence === 'present' ? positive(cell.value) : cell.value === null);
  if (new Set(proof.rawStocks.map(one => one.boxId)).size !== proof.rawStocks.length || !proof.rawStocks.every(one => positive(one.boxId) && one.boxId <= 8 &&
      nonnegative(one.stockNum) && validTime(one.calcTime) && validTime(one.maxStockTime))) fail('ORDER_STORED_ORIGINAL_RAW_ROWS_INVALID');
  if (proof.unobservedOtherCounters !== undefined && (!Array.isArray(proof.unobservedOtherCounters) || proof.unobservedOtherCounters.length > 2 ||
      new Set(proof.unobservedOtherCounters.map(one => one.counterId)).size !== proof.unobservedOtherCounters.length ||
      !proof.unobservedOtherCounters.every(one => [105, 109, 116].includes(one.counterId) && one.counterId !== kinds[proof.kind].counterId &&
        !proof.counters.some(observed => observed.counterId === one.counterId) && one.reasonCode === 'OTHER_CATEGORY_COUNTER_NOT_CURRENTLY_OBSERVED' && one.treatedAsZero === false))) {
    fail('ORDER_STORED_OTHER_COUNTER_COVERAGE_INVALID');
  }
  const targetCounter = proof.counters.find(one => one.counterId === kinds[proof.kind].counterId);
  if (targetCounter.raw !== order.counter?.raw || targetCounter.total !== order.counter?.total || targetCounter.rTime !== order.counter?.rawRTime) fail('ORDER_STORED_ORIGINAL_COUNTER_BINDING_INVALID');
  if (box.rawStockNum !== rowFor(proof.rawStocks, order.boxId).stockNum ||
      proof.sourceContract.sha256 !== '05562cc75cab3fa18970582c082e44a29ca4928bd2e73d95f6bd1c4ad9270585') fail('ORDER_STORED_ORIGINAL_STATIC_OR_RAW_BINDING_INVALID');
  return proof;
}

function counterAt(frame, id, uid) {
  const row = frame?.payload?.counters?.[id];
  return row && ['domain', 'uid', 'type', 'tdyCnt', 'totCnt', 'rTime'].every(key => knownOrderFlowerCell(row[key])) && value(row.uid) === uid && value(row.type) === id
    ? { counterId: id, uid, raw: value(row.tdyCnt), total: value(row.totCnt), rTime: value(row.rTime) } : null;
}
function tdys(frame) {
  const one = frame?.payload?.fields?.tdyMap;
  return knownOrderFlowerCell(one) && one.value?.complete === true && Array.isArray(one.value.entries) && one.value.entries.every(row => knownOrderFlowerCell(row.count))
    ? one.value.entries.map(row => ({ boxId: row.boxId, count: row.count.value })) : null;
}
function maxAdditionalTicks(box, fromMs, toMs, hire, raw) {
  if (toMs < fromMs) return null;
  if (hire?.known !== true) return raw.calcTime.value === null ? 0 : null;
  if (!hire.hired || raw.calcTime.value === null) return 0;
  if (!positive(hire.period?.beginMs) || !positive(hire.period?.endMs) || fromMs < hire.period.beginMs || toMs >= hire.period.endMs) return null;
  const anchor = positive(box.calcTime) ? box.calcTime : raw.calcTime.value, period = box.cdSeconds * 1000;
  const ticks = Math.max(0, Math.floor((toMs - anchor) / period)) - Math.max(0, Math.floor((fromMs - anchor) / period));
  return nonnegative(ticks) ? ticks : null;
}
function timestamps(before, after, box, observedAt, added, pauseAt = null, ownDebit = 0) {
  const cd = box.cdSeconds * 1000, oldCalc = before.calcTime.value, nextCalc = after.calcTime.value;
  if (ownDebit === 1 && after.absentInProvidedCompleteMap === true && after.stockNum === 0 && before.stockNum === 1 && added === 0) {
    return { calcTimeBefore: clone(before.calcTime), calcTimeAfter: clone(after.calcTime), maxStockTimeBefore: clone(before.maxStockTime),
      maxStockTimeAfter: clone(after.maxStockTime), maxTimeClassification: 'actual-final-raw-unit-row-removed', sourceCadenceSeconds: box.cdSeconds,
      futureClockOrPauseNotInvented: true };
  }
  if (oldCalc === null && nextCalc !== null || oldCalc !== null && nextCalc === null) return null;
  if (nextCalc !== null) {
    const actualPause = positive(pauseAt) && nextCalc === pauseAt;
    if (nextCalc < oldCalc || !actualPause && (nextCalc > observedAt && nextCalc !== oldCalc || (nextCalc - oldCalc) % cd !== 0) ||
        added > 0 && nextCalc <= oldCalc) return null;
  } else if (added > 0) return null;
  const oldMax = before.maxStockTime.value, nextMax = after.maxStockTime.value;
  if (oldMax !== null && nextMax === null || nextMax !== null && nextCalc === null || nextMax !== null && nextMax < nextCalc) return null;
  const recomputed = nextCalc === null ? null : nextCalc + Math.max(box.capacity - after.stockNum, 0) * cd;
  // The public helper proves the max-time formula, but not whether the
  // service persists it before or after the independently proven one-unit
  // debit. Preserve that distinction instead of inventing an ordering.
  const beforeDebit = nextCalc === null || ownDebit !== 1 ? null : nextCalc + Math.max(box.capacity - after.stockNum - 1, 0) * cd;
  if (nextMax !== null && nextMax !== oldMax && nextMax !== recomputed && nextMax !== beforeDebit) return null;
  return { calcTimeBefore: clone(before.calcTime), calcTimeAfter: clone(after.calcTime), maxStockTimeBefore: clone(before.maxStockTime),
    maxStockTimeAfter: clone(after.maxStockTime), maxTimeClassification: nextMax === oldMax ? 'actual-field-unchanged' : nextMax === recomputed ? 'matches-actual-post-raw-count-formula'
      : nextMax === beforeDebit ? 'matches-raw-count-before-single-debit-formula' : 'not-supplied',
    sourceCadenceSeconds: box.cdSeconds, futureClockOrPauseNotInvented: true };
}

// This proof describes ACTUALLY supplied raw rows. Bounds admit an observed
// replenishment only when official clock/cadence/cap/day allocation can explain
// it; a changing display projection is never a delivery receipt by itself.
export function verifyOrderFlowerStoredTransition({ proposal, response, observation, afterDecoded = null } = {}) {
  const denied = (reasonCode, evidence = null) => freeze({ known: false, reasonCode, evidence });
  let before;
  try { before = assertOrderFlowerStoredPreparation(proposal); } catch (error) { return denied(error.code || 'ORDER_STORED_ORIGINAL_PREPARATION_INVALID'); }
  if (!before) return denied('ORDER_STORED_PATH_NOT_SELECTED');
  const context = orderFlowerContext(proposal), nextContext = { ...context, connectionEpoch: observation?.connectionEpoch },
    answer = decodeOfficialOrderFlowerObservation({ context, observation: response }), decodedPost = decodeOfficialOrderFlowerObservation({ context: nextContext, observation }), post = afterDecoded || decodedPost;
  const answerMs = response?.serverMs, postMs = observation?.serverMs, uid = proposal.orderFlower.officialUid;
  if (!answer?.admissible || !post?.admissible || !decodedPost || canonical(post) !== canonical(decodedPost) || answer.source.method !== proposal.method || post.source.method !== 'index.login' ||
      !positive(answerMs) || !positive(postMs) || answerMs < before.clock.lowerBoundMs || postMs < answerMs ||
      answerMs < before.day.startMs || postMs >= before.day.endMs || post.source.version.loginResponseRef !== post.source.responseRef ||
      !sourceBefore(before.stockSource, context, response.requestSequence)) return denied('ORDER_STORED_MATCHED_TIMED_RAW_SOURCES_REQUIRED');
  for (const frame of [answer, post]) {
    const domainUid = frame.payload.fields.uid;
    if (frame === post && (!knownOrderFlowerCell(frame.payload.domain) || !knownOrderFlowerCell(domainUid) || domainUid.value !== uid) ||
        domainUid.presence !== 'missing' && (!knownOrderFlowerCell(domainUid) || domainUid.value !== uid) ||
        frame.payload.profileUid.presence !== 'missing' && (!knownOrderFlowerCell(frame.payload.profileUid) || frame.payload.profileUid.value !== uid)) {
      return denied('ORDER_STORED_ACTUAL_DOMAIN_UID_REQUIRED');
    }
  }
  const answerStocks = stockRows(answer.payload.fields.stockMap), postStocks = stockRows(post.payload.fields.stockMap),
    answerTdys = tdys(answer), postTdys = tdys(post);
  if (!postStocks || !postTdys || answer.payload.fields.stockMap.presence !== 'missing' && !answerStocks ||
      answer.payload.fields.tdyMap.presence !== 'missing' && !answerTdys) return denied('ORDER_STORED_ACTUAL_COMPLETE_STOCK_AND_TDY_REQUIRED');
  const countEvidence = [];
  for (const original of before.counters) {
    const atAnswer = counterAt(answer, original.counterId, uid), after = counterAt(post, original.counterId, uid),
      suppliedAtAnswer = answer.payload.counters[original.counterId].domain.presence !== 'missing';
    if (!after || suppliedAtAnswer && !atAnswer || atAnswer && canonical(atAnswer) !== canonical(after) ||
        after.rTime < original.rTime || after.rTime > postMs || atAnswer && atAnswer.rTime > answerMs) return denied('ORDER_STORED_ACTUAL_COUNTER_SOURCE_CONFLICT');
    const rawDelta = after.raw - original.raw, totalDelta = after.total - original.total,
      effectiveBefore = original.rTime < before.day.startMs ? 0 : original.raw,
      effectiveAfter = after.rTime < before.day.startMs ? 0 : after.raw, effectiveDelta = effectiveAfter - effectiveBefore,
      selected = original.counterId === kinds[before.kind].counterId;
    if (selected ? ![0, 1].includes(effectiveDelta) || totalDelta !== effectiveDelta : effectiveDelta !== 0 || totalDelta !== 0) {
      return denied('ORDER_STORED_COUNTER_CHANGE_NOT_FINITE_SINGLE_EFFECT');
    }
    countEvidence.push({ before: clone(original), answer: atAnswer, after, answerFieldProvided: suppliedAtAnswer, rawDelta, totalDelta,
      effectiveBefore, effectiveAfter, effectiveDelta,
      classification: selected ? effectiveDelta === 0 ? 'actual-counter-unchanged' : 'actual-one-counter-unit' : 'other-category-unchanged',
      generatedCountIsNotDeliveryCount: true });
  }
  const stockEvidence = [];
  let generatedBeforeAnswer = 0, generatedAfterAnswer = 0;
  for (const box of before.groupBoxes) {
    const original = rowFor(before.rawStocks, box.boxId), atAnswer = answerStocks ? rowFor(answerStocks, box.boxId) : null, after = rowFor(postStocks, box.boxId),
      debit = box.boxId === before.boxId ? 1 : 0, baseline = box.effectiveStockNum,
      possibleFirst = maxAdditionalTicks(box, before.clock.lowerBoundMs, answerMs, before.hire, original),
      firstAdded = atAnswer ? atAnswer.stockNum - baseline + debit : null;
    const pauseAt = before.kind === 'resident' && before.daily.remainingForGeneration <= 0 ? before.day.endMs - box.cdSeconds * 1000 : null;
    if (!answerStocks) {
      const possibleTotal = maxAdditionalTicks(box, before.clock.lowerBoundMs, postMs, before.hire, original),
        inferred = after.stockNum - baseline + debit;
      // No middle stock value is fabricated. Without an answer stock anchor,
      // only a quiescent actual raw decrement is independently unambiguous.
      if (possibleTotal !== 0 || inferred !== 0 || after.stockNum > box.capacity) return denied('ORDER_STORED_POST_ONLY_QUIESCENT_RAW_EFFECT_REQUIRED');
      const directTimes = timestamps(original, after, box, postMs, Math.max(0, baseline - original.stockNum), pauseAt, debit);
      if (!directTimes) return denied('ORDER_STORED_RAW_TIME_ADVANCEMENT_UNPROVEN');
      stockEvidence.push({ boxId: box.boxId, beforeRaw: clone(original), beforeEffective: baseline, answerRaw: null,
        answerStockFieldProvided: false, afterRaw: clone(after), ownConsumption: debit,
        actuallyObservedGrowthBeforeAnswer: null, actuallyObservedGrowthAfterAnswer: null,
        maximumAdditionalCadenceTicksWholeInterval: possibleTotal, directPostTimes: directTimes });
      continue;
    }
    if (possibleFirst === null || !nonnegative(firstAdded) || firstAdded > possibleFirst || atAnswer.stockNum > box.capacity) {
      return denied('ORDER_STORED_ANSWER_RAW_CONSERVATION_UNPROVEN');
    }
    const firstTimes = timestamps(original, atAnswer, box, answerMs, firstAdded + Math.max(0, baseline - original.stockNum), pauseAt, debit);
    const postBox = { ...box, calcTime: atAnswer.calcTime.value }, possibleSecond = maxAdditionalTicks(postBox, answerMs, postMs, before.hire, atAnswer),
      secondAdded = after.stockNum - atAnswer.stockNum;
    if (!firstTimes || possibleSecond === null || !nonnegative(secondAdded) || secondAdded > possibleSecond || after.stockNum > box.capacity) {
      return denied('ORDER_STORED_POST_LOGIN_RAW_CONSERVATION_UNPROVEN');
    }
    const nextTimes = timestamps(atAnswer, after, postBox, postMs, secondAdded, pauseAt);
    if (!nextTimes) return denied('ORDER_STORED_RAW_TIME_ADVANCEMENT_UNPROVEN');
    generatedBeforeAnswer += firstAdded; generatedAfterAnswer += secondAdded;
    stockEvidence.push({ boxId: box.boxId, beforeRaw: clone(original), beforeEffective: baseline,
      answerRaw: clone(atAnswer), afterRaw: clone(after), ownConsumption: debit,
      actuallyObservedGrowthBeforeAnswer: firstAdded, actuallyObservedGrowthAfterAnswer: secondAdded,
      maximumAdditionalCadenceTicksBeforeAnswer: possibleFirst, maximumAdditionalCadenceTicksAfterAnswer: possibleSecond,
      answerTimes: firstTimes, postTimes: nextTimes });
  }
  const beforeProjected = before.groupBoxes.reduce((sum, box) => sum + box.effectiveStockNum, 0),
    remainingAtBefore = Math.max(before.daily.officialLimit - before.daily.finishedCount - beforeProjected, 0);
  if (before.kind === 'resident' && generatedBeforeAnswer + generatedAfterAnswer > remainingAtBefore) return denied('ORDER_STORED_RESIDENT_SHARED_DAILY_GENERATION_EXCEEDED');
  const targetBeforeTdy = before.rawTdys.find(one => one.boxId === before.boxId)?.count ?? 0,
    targetAnswerTdy = answerTdys ? answerTdys.find(one => one.boxId === before.boxId)?.count ?? 0 : null,
    targetPostTdy = postTdys.find(one => one.boxId === before.boxId)?.count ?? 0;
  if (answerTdys && targetAnswerTdy !== targetPostTdy || ![0, 1].includes(targetPostTdy - targetBeforeTdy)) return denied('ORDER_STORED_POST_LOGIN_TDY_CHANGED');
  for (let id = 1; id <= 8; id++) if (id !== before.boxId &&
      ((before.rawTdys.find(one => one.boxId === id)?.count ?? 0) !== (postTdys.find(one => one.boxId === id)?.count ?? 0) ||
       answerTdys && (answerTdys.find(one => one.boxId === id)?.count ?? 0) !== (postTdys.find(one => one.boxId === id)?.count ?? 0))) return denied('ORDER_STORED_OTHER_BOX_TDY_CHANGED');
  const body = { version: EFFECT_VERSION, contract: ORDER_FLOWER_STORED_CONTRACT, kind: before.kind, boxId: before.boxId,
    beforeFingerprint: before.fingerprint, beforeBasis: orderFlowerStoredBasis(before), counterEvidence: countEvidence, stockEvidence,
    tdyEvidence: { before: before.rawTdys, answer: answerTdys, after: postTdys, targetBefore: targetBeforeTdy, targetAnswer: targetAnswerTdy, targetAfter: targetPostTdy,
      tdyAloneConfirmsNothing: true },
    actualSource: { answer: source(answer.source), postRead: source(post.source) },
    ownStockConsumption: 1, observedGrowth: { beforeAnswer: generatedBeforeAnswer, afterAnswer: generatedAfterAnswer },
    residentRemainingForGenerationAtBefore: before.kind === 'resident' ? remainingAtBefore : null,
    storedOrderStillConsumesActualFlowers: true, financialAndOriginalOrderTransitionMustAlsoPass: true,
    serviceDeliveryCounterClaimed: false, serverAllocationAlgorithmClaimedEquivalent: false };
  return freeze({ known: true, reasonCode: 'ORDER_STORED_ACTUAL_RAW_SINGLE_CONSUMPTION_ACCOUNTED', evidence: { ...body, fingerprint: fingerprint(body) } });
}
