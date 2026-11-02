import { canonical, fingerprint, freeze, plainObject } from '../../common.mjs';
import { decodeOfficialCustomerObservation, knownCustomerCell } from './wire-facts.mjs';
import { customerOrderFingerprint } from './identity.mjs';
import { assertCustomerGenerationProposal, customerGenerationAfterCloseLoginProof, generationSource, generationSourceKnown,
  GENERATION_ORDER_FIELDS } from './generation-contract.mjs';
import { customerVersionFrameValid } from './rpc-contract.mjs';

const VERSION = 'customer-generation-verification/after-close-empty-stock-v1';
const versionFor = proposal => proposal.generation.openNpcPolicy
  ? 'customer-generation-verification/after-close-open-official-npcs-v2' : VERSION;
const BAG_RULE = 'complete-absolute-bag-positive-integer-counts/zero-and-missing-equivalent/v1';
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const scalar = cell => knownCustomerCell(cell) ? cell.value : null;
const sync = value => { if (value?.then) { value.catch?.(() => {}); throw new TypeError('Generation verification ports must be synchronous'); } return value; };
function at(raw, path) {
  let value = raw;
  for (const key of path) { if (!plainObject(value) || !Object.hasOwn(value, key)) return { supplied: false, value: null }; value = value[key]; }
  return { supplied: true, value };
}
function itemMap(raw, path) {
  const entry = at(raw, path), map = entry.value;
  const known = entry.supplied && plainObject(map) && Object.keys(map).length <= 20000 &&
    Object.entries(map).every(([id, quantity]) => /^[1-9]\d*$/.test(id) && positive(Number(id)) && nonnegative(quantity));
  return { supplied: entry.supplied, known, values: known ? map : null };
}
const order = row => ({ npcId: row.npcId, ...Object.fromEntries(GENERATION_ORDER_FIELDS.map(key => [key, scalar(row.fields[key])])), contentFingerprint: customerOrderFingerprint(row) });
function snapshot({ proposal, response, observation, bridge, readGenerationFacts }) {
  assertCustomerGenerationProposal(proposal);
  if (!bridge || observation !== bridge.newLoginObservation) return null;
  const proof = customerGenerationAfterCloseLoginProof({ proposal, response, bridge });
  const frame = decodeOfficialCustomerObservation({ context: bridge.newContext, observation }), payload = frame?.payload;
  const board = payload?.orderMap, stock = payload?.orderStockList, counter = payload?.eligibilityInputs?.count107;
  if (!frame?.admissible || frame.source.method !== 'index.login' || scalar(payload.profileUid) !== proposal.generation.officialUid ||
      scalar(payload.uid) !== proposal.generation.officialUid || !knownCustomerCell(payload.domain) || !knownCustomerCell(payload.customer) ||
      !board || board.presence !== 'present' || board.state !== 'known' || board.sourceProvidedMapComplete !== true || board.decodedComplete !== true ||
      !Array.isArray(board.entries) || board.total !== board.entries.length || board.entries.some(row => !row.readable) ||
      !stock || stock.presence !== 'present' || stock.state !== 'known' || stock.sourceProvidedListComplete !== true || stock.decodedComplete !== true ||
      !Array.isArray(stock.entries) || stock.total !== stock.entries.length || stock.entries.some(row => !row.readable) ||
      !counter || !['domain', 'uid', 'type', 'tdyCnt', 'totCnt', 'rTime'].every(key => knownCustomerCell(counter[key])) ||
      scalar(counter.uid) !== proposal.generation.officialUid || scalar(counter.type) !== 107) return null;
  const facts = sync(readGenerationFacts(bridge.newContext)), day = facts?.officialDay, originalDay = proposal.generation.day;
  if (facts?.current !== true || day?.known !== true || day.key !== originalDay.key || day.startMs !== originalDay.startMs ||
      day.endMs !== originalDay.endMs || day.utcOffsetMinutes !== originalDay.utcOffsetMinutes || !reference(day.proofRef) ||
      day.source?.responseRef !== observation.responseRef || day.source?.officialUid !== proposal.generation.officialUid ||
      facts.count107?.current !== true || facts.count107.source?.responseRef !== observation.responseRef ||
      !['tdyCnt', 'totCnt'].every(key => facts.count107[key] === scalar(counter[key])) || facts.count107.rTimeMs !== scalar(counter.rTime)) return null;
  const bag = itemMap(observation.value, ['7', '0', '32']), gold = at(observation.value, ['7', '0', '44']), yb = at(observation.value, ['7', '0', '41']);
  if (!bag.known || !gold.supplied || !nonnegative(gold.value) || !yb.supplied || !nonnegative(yb.value)) return null;
  const positiveBag = Object.fromEntries(Object.entries(bag.values).filter(([, quantity]) => quantity > 0));
  return { proof, frame, board, stock, counter, day, gold: gold.value, yb: yb.value,
    bag: { fingerprint: fingerprint(positiveBag), positiveItemCount: Object.keys(positiveBag).length, rule: BAG_RULE } };
}
function result(proposal, response, reasonCode, { observation = null, proof = null, accounting = null, orders = null, costs = null, confirmed = false } = {}) {
  const verdict = confirmed ? 'confirmed' : 'unknown', target = proposal.targets[0];
  const version = versionFor(proposal);
  return freeze({ verdict, verificationVersion: version, reasonCode,
    postReadRef: reference(observation?.responseRef) ? observation.responseRef : null,
    member: { memberKey: target.memberKey, verdict, reasonCode }, resourceResolutions: [],
    targetEffect: confirmed ? { kind: 'new-orders-original-board-preserved', addedBoardCount: orders.addedBoard.length,
      addedStockCount: orders.stock.total, accountedNewOrders: orders.addedBoard.length + orders.stock.total,
      generatedQuantityWasNotPredicted: true } : null,
    evidence: { version, operationId: proposal.operationId, reasonCode, targetRef: target.targetRef, lifecycleRef: target.lifecycleRef,
      businessFingerprint: proposal.generation.businessFingerprint, beforeDayProofRef: proposal.generation.day.proofRef,
      ...(proposal.generation.openNpcPolicy ? { openNpcPolicy: proposal.generation.openNpcPolicy } : {}),
      beforeBoard: proposal.generation.beforeBoard, beforeStockCount: 0, beforeCount: proposal.generation.beforeCount,
      answer: generationSource(response), postRead: generationSource(observation), accounting, orders, costs,
      noZeroInferenceFromMissingFlows: true, originalCounterRowsUnchanged: true,
      bridge: proof ? { leaseRef: proof.leaseRef, bridgeFingerprint: proof.bridgeFingerprint, closureEvidenceRef: proof.oldPhysicalCloseReceipt.closureEvidenceRef,
        originalConnectionEpoch: proof.originalContext.connectionEpoch, newConnectionEpoch: proof.newContext.connectionEpoch,
        writeResponseRef: proof.after.responseRef, newLoginResponseRef: proof.newLogin.responseRef } : null } });
}
function analyze({ proposal, response, observation, bridge, readGenerationFacts }) {
  assertCustomerGenerationProposal(proposal);
  const data = proposal.generation, version = response?.versionEvidence, context = { observation };
  const originalContext = Object.fromEntries(['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch']
    .map(key => [key, proposal[key]]));
  const finish = reasonCode => result(proposal, response, reasonCode, context);
  if (!generationSourceKnown(response, proposal) || response.transport !== 'answered' || response.method !== 'orderCustomer.genOrder' ||
      response.envelopeOk !== true || response.dsName !== 'G.ISyncData' || response.rejected === true || response.messagePresent === true && response.noticeOnly !== true ||
      version?.gameVersion !== data.versionEvidence.gameVersion ||
      version?.loginResponseRef !== data.versionEvidence.loginResponseRef ||
      !customerVersionFrameValid(response, data.versionEvidence, originalContext, data.officialUid)) return finish('CUSTOMER_GENERATION_MATCHED_ANSWER_UNPROVEN');
  for (const source of [data.boardSource, data.beforeCount.source, data.beforeProfile.goldSource,
    data.beforeProfile.ybSource, data.beforeProfile.completeBagFingerprint.source]) {
    if (!generationSourceKnown(source, proposal) || source.requestSequence >= response.requestSequence) return finish('CUSTOMER_GENERATION_ORIGINAL_SOURCE_NOT_BEFORE_WRITE');
  }
  for (const path of [['7', '0', '0'], ['109', '0', '0'], ['7', '4', '107', '0']]) {
    const uid = at(response.value, path);
    if (uid.supplied && uid.value !== data.officialUid) return finish('CUSTOMER_GENERATION_ANSWER_UID_CONFLICT');
  }
  let state;
  try { state = snapshot({ proposal, response, observation, bridge, readGenerationFacts }); } catch { /* Keep the original operation unknown. */ }
  if (!state) return finish('CUSTOMER_GENERATION_NEW_LOGIN_FULL_SAME_DAY_COVERAGE_REQUIRED');
  context.proof = state.proof;
  const afterCount = { uid: scalar(state.counter.uid), type: 107, rawTdyCnt: scalar(state.counter.tdyCnt), totCnt: scalar(state.counter.totCnt), rTimeMs: scalar(state.counter.rTime) };
  const readAt = observation.serverMs, day = data.day;
  if (!positive(readAt) || readAt < day.startMs || readAt >= day.endMs || !positive(afterCount.rTimeMs) || afterCount.rTimeMs > readAt || afterCount.rTimeMs >= day.endMs) return finish('CUSTOMER_GENERATION_COUNTER_DAY_OR_TIME_UNPROVEN');
  afterCount.effectiveCount = afterCount.rTimeMs < day.startMs ? 0 : afterCount.rawTdyCnt;
  context.accounting = { before: data.beforeCount, after: afterCount, currentDayProofRef: state.day.proofRef,
    effectiveCountDelta: afterCount.effectiveCount - data.beforeCount.effectiveCount, totalDelta: afterCount.totCnt - data.beforeCount.totCnt,
    rawResetMayHaveOccurred: afterCount.rawTdyCnt !== data.beforeCount.rawTdyCnt || afterCount.rTimeMs !== data.beforeCount.rTimeMs,
    firstScopeRequiresNoOtherCountFlow: true };
  if (context.accounting.effectiveCountDelta !== 0 || context.accounting.totalDelta !== 0) return finish('CUSTOMER_GENERATION_COUNTER_FLOW_NOT_UNIQUELY_ATTRIBUTABLE');
  const afterBoard = state.board.entries.map(order), added = afterBoard.filter(row => !data.beforeBoard.some(old => old.npcId === row.npcId));
  const stockRows = state.stock.entries.map(order), stockHashes = stockRows.map(row => row.contentFingerprint).sort();
  context.orders = { originalBoardPreserved: data.beforeBoard.every(old => afterBoard.some(row => row.npcId === old.npcId && row.contentFingerprint === old.contentFingerprint)),
    afterBoard, addedBoard: added, stock: { total: stockRows.length, fingerprint: fingerprint(stockHashes), rows: stockRows.slice(0, 32),
      returned: Math.min(stockRows.length, 32), limit: 32, complete: stockRows.length <= 32, truncated: stockRows.length > 32 },
    completeCollectionRead: true, originalStockWasExplicitlyEmpty: true };
  if (!context.orders.originalBoardPreserved) return finish('CUSTOMER_GENERATION_ORIGINAL_BOARD_CHANGED');
  const allowedOutputNpcIds = data.openNpcPolicy?.openNpcIds ?? data.openRegularNpcIds;
  if (afterBoard.length > 3 || added.some(row => !allowedOutputNpcIds.includes(row.npcId)) ||
      added.length + stockRows.length < 1 || added.length + stockRows.length > data.remainingDailyOpportunity) return finish('CUSTOMER_GENERATION_NEW_ORDER_SET_UNPROVEN');
  const flows = [];
  context.costs = { beforeProfile: data.beforeProfile, afterProfile: { gold: state.gold, yb: state.yb },
    afterCompleteBag: state.bag, reportedFlows: flows, noMissingFlowWasConvertedToZero: true };
  for (const base of [['7', '2'], ['18']]) for (const key of ['0', '1', '2', '3', '4', '5', '6']) {
    const map = itemMap(response.value, [...base, key]);
    if (map.supplied && !map.known) return finish('CUSTOMER_GENERATION_REPORTED_FLOWS_UNREADABLE');
    if (map.supplied) {
      const entries = Object.entries(map.values).filter(([, value]) => value > 0).map(([itemId, quantity]) => ({ itemId: Number(itemId), quantity }));
      flows.push({ path: [...base, key].join('.'), fingerprint: fingerprint(map.values), positiveEntries: entries.length,
        rows: entries.slice(0, 32), limit: 32, complete: entries.length <= 32, truncated: entries.length > 32 });
    }
    if (key !== '2' && map.known && Object.values(map.values).some(value => value > 0)) return finish(['1', '4', '6'].includes(key) ? 'CUSTOMER_GENERATION_UNEXPECTED_COST' : 'CUSTOMER_GENERATION_UNEXPECTED_ITEM_GAIN');
  }
  if (state.gold !== data.beforeProfile.gold || state.yb !== data.beforeProfile.yb) return finish('CUSTOMER_GENERATION_UNEXPECTED_CURRENCY_EFFECT');
  if (state.bag.fingerprint !== data.beforeProfile.completeBagFingerprint.fingerprint) return finish('CUSTOMER_GENERATION_ABSOLUTE_INVENTORY_CHANGED');
  for (const [key, expected] of [['44', state.gold], ['41', state.yb]]) {
    const entry = at(response.value, ['7', '0', key]);
    if (entry.supplied && entry.value !== expected) return finish('CUSTOMER_GENERATION_WRITE_CURRENCY_EFFECT_CONFLICT');
  }
  return result(proposal, response, 'CUSTOMER_GENERATION_EXACT_NEW_ORDERS_CONFIRMED', { ...context, confirmed: true });
}
export function createCustomerGenerationVerification({ readGenerationFacts, isLeaseCurrent } = {}) {
  for (const fn of [readGenerationFacts, isLeaseCurrent]) if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') throw new TypeError('Generation verification requires synchronous fact/lease ports');
  const current = input => sync(isLeaseCurrent(input)) === true;
  const validateResponseCoverage = input => {
    try { return snapshot({ ...input, bridge: input.bridge || input.postReadBridge, readGenerationFacts }) !== null; } catch { return false; }
  };
  const validateTargetVerification = input => {
    try {
      const packet = input.bridge || input.postReadBridge, observation = packet?.newLoginObservation;
      if (input.verification?.verdict !== 'confirmed' || !Array.isArray(input.postReads) || !input.postReads.includes(observation) || input.verification.postReadRef !== observation.responseRef) return false;
      const derived = analyze({ ...input, observation, bridge: packet, readGenerationFacts });
      return derived.verdict === 'confirmed' && canonical(derived) === canonical(input.verification);
    } catch { return false; }
  };
  async function verify({ proposal, response, connection, signal }) {
    assertCustomerGenerationProposal(proposal);
    const unknown = reasonCode => result(proposal, response, reasonCode);
    if (signal?.aborted || connection?.isOpen?.() !== true || typeof connection.readSnapshotAfterClose !== 'function') return unknown('CUSTOMER_GENERATION_READ_LEASE_UNAVAILABLE');
    let bridge;
    try { bridge = await connection.readSnapshotAfterClose(); }
    catch (error) { return unknown(typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : 'CUSTOMER_GENERATION_POST_READ_FAILED'); }
    if (signal?.aborted || connection.isOpen() !== true || !current({ proposal, response, bridge })) return unknown('CUSTOMER_GENERATION_READ_LEASE_REVOKED');
    const derived = analyze({ proposal, response, observation: bridge.newLoginObservation, bridge, readGenerationFacts });
    return signal?.aborted || connection.isOpen() !== true || !current({ proposal, response, bridge }) ? unknown('CUSTOMER_GENERATION_READ_LEASE_REVOKED') : derived;
  }
  return Object.freeze({ verify, validateResponseCoverage, validateTargetVerification });
}
