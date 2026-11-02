import { fingerprint, freeze } from '../../common.mjs';
import { customerContext, customerContextKey, knownCustomerCell, sameCustomerContext } from './wire-facts.mjs';

// Copied finite public rows from current 480.0.27, not the old runner:
// c_orderCustomerNpc SHA5077bc2c009b74361efe3d963195be4eb7ab099c26c18017cb37f46584fe0258;
// c_flowerArt SHA636220908e677377ee4902a38a7ab6adb66540f86902199e99141eaff3de66da.
// G480 [2363210,2364567) is the actual client generation gate/request;
// [2364942,2366225) constructs LOCAL roaming guests. Its initial list is [].
export const CUSTOMER_GENERATION_STATIC = freeze({ gameVersion: '480.0.27', protocolVersion: '480.0.0', maxBoard: 3, dailyLimit: 350,
  clientNextTimeOffsetMs: 1000, npcIds: [1, 2, 3, 4, 5, 6, 7, 8, 9], npcs: [
    { id: 1, mainTaskId: 170001, spokes: false }, { id: 2, mainTaskId: 330001, spokes: false },
    { id: 3, mainTaskId: 330001, spokes: false }, { id: 4, mainTaskId: 100001, spokes: false },
    { id: 5, mainTaskId: 730001, spokes: false }, { id: 6, mainTaskId: 170001, spokes: false },
    { id: 7, mainTaskId: 480001, spokes: false }, { id: 8, mainTaskId: 120001, spokes: true }, { id: 9, mainTaskId: 100001, spokes: true } ],
  source: { gameDecodedSha256: 'fc9970989021e4266301d2a167ae8e827ef71a124ad9d7f23cb922095a22aa69',
    npcTableSha256: '5077bc2c009b74361efe3d963195be4eb7ab099c26c18017cb37f46584fe0258',
    artTableSha256: '636220908e677377ee4902a38a7ab6adb66540f86902199e99141eaff3de66da',
    generationRange: [2363210, 2364567], generationSha256: '5cae729320bf656b9daec0a460b24d972afb1359ca0c242942da4a6b02c9cdad' } });
export const CUSTOMER_GENERATION_ORDINARY_BOARD_SOURCE = freeze({ version: 'customer-generation/ordinary-common-branch/480.0.27/v1',
  gameSha256: CUSTOMER_GENERATION_STATIC.source.gameDecodedSha256,
  commonBranch: { range: [2363210, 2364567], sha256: '5cae729320bf656b9daec0a460b24d972afb1359ca0c242942da4a6b02c9cdad' },
  openVersusHire: { range: [2480950, 2481347], sha256: 'b9a26718e6c83c4648cb658b38affe7bbb355787e19259427c33b78b3ae610b4' },
  stockAndOverflowMode: { range: [2485936, 2486210], sha256: '60516e3814914ce025867c6351ad3d8dc5a7b1ca77286a575cd3250fa5ac5622' },
  rule: 'both-hired-and-non-hired-client-branches-share-ordinary-board-gap-request',
  beforeStockMustBeExplicitlyEmpty: true, overflowBranchAdmitted: false, hiringInferredFromFeatureOpen: false,
  requestHasServerQuantityOrOverflowFlag: false });
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const ref = source => source ? { responseRef: source.responseRef ?? null, observationRef: source.observationRef ?? null,
  method: source.method ?? null, connectionEpoch: source.connectionEpoch ?? null, requestSequence: source.requestSequence ?? null,
  wireKey: source.wireKey ?? null } : null;

// Readonly first-scope decision: a headless actor with NO synthesized roaming
// guests and no overflow planning. It does not send, reserve, create a
// proposal, infer a server output count, or authorize a retry after unknown.
// generationFacts must be normalized from real current sources by the root:
// officialDay {known,key,startMs,endMs,utcOffsetMinutes,proofRef};
// count107 {current,uid,type,tdyCnt,rTimeMs,source};
// localSession {context,current,noPendingButlerReport,proofRef};
// guestState {context,current,mode:'headless-no-synthetic-roaming',ids:[],proofRef}.
export function evaluateCustomerGeneration({ context: supplied, view, config, eligibility, clock, generationFacts,
  staticPolicy = CUSTOMER_GENERATION_STATIC } = {}) {
  const context = customerContext(supplied), identity = view?.identity;
  const revision = positive(config?.savedRevision) ? config.savedRevision : null;
  const cancelEpoch = nonnegative(config?.featureCancelEpochs?.['order.customer']) ? config.featureCancelEpochs['order.customer'] : null;
  const enabled = config?.config?.orders?.customer?.enabled;
  const sources = [], initial = { version: 'customer-generation/headless-empty-guest-readonly-v1', context,
    configRevision: revision, featureCancelEpoch: cancelEpoch, readOnly: true, writeEligible: false, rpcCreated: false,
    proposalCreated: false, reservationCreated: false, originalUnknownMayBeRetried: false,
    overflowImplemented: false, outputCountKnown: false, ordinaryBoardSubset: true,
    hiredStateRequiredForThisCommonBranch: false, source: staticPolicy?.source ?? null,
    ordinaryBoardSource: CUSTOMER_GENERATION_ORDINARY_BOARD_SOURCE };
  const finish = (state, reasonCode, opportunity = null, earliestOfficialMs = null) => {
    const body = { ...initial, state, reasonCode, opportunity, earliestOfficialMs, sources };
    return freeze({ ...body, decisionRef: 'customer-generation-decision:' + fingerprint(body) });
  };
  if (typeof enabled !== 'boolean' || revision === null || cancelEpoch === null) return finish('waiting-facts', 'CUSTOMER_GENERATION_CONFIG_UNKNOWN');
  if (!enabled) return finish('disabled', 'CUSTOMER_DISABLED');
  if (!context || !sameCustomerContext(context, view?.context) || view?.current !== true || identity?.verified !== true ||
      !positive(identity.uid?.value) || !knownCustomerCell(identity.uid) || identity.uid.current !== true) return finish('waiting-facts', 'CUSTOMER_GENERATION_CURRENT_IDENTITY_UNKNOWN');
  const sourceCurrent = source => source?.contextKey === customerContextKey(context) && source.connectionEpoch === context.connectionEpoch &&
    source.kind === 'response' && source.transport === 'answered' && positive(source.requestSequence) && reference(source.responseRef) &&
    reference(source.wireKey) && source.version?.source === 'normal-package-hop-and-matched-world-login/v1' &&
    source.version.protocolVersion === '480.0.0' && source.version.gameVersion === view?.versionBinding?.gameVersion &&
    source.version.loginResponseRef === identity.source?.responseRef &&
    (!view?.versionBinding?.dataSnapshotId || source.version.dataSnapshotId === view.versionBinding.dataSnapshotId);
  const currentCell = cell => cell?.current === true && knownCustomerCell(cell) && sourceCurrent(cell.source);
  if (!sourceCurrent(identity.source) || identity.source.method !== 'index.login' || !sourceCurrent(identity.uid.source)) return finish('waiting-facts', 'CUSTOMER_GENERATION_LOGIN_SOURCE_UNVERIFIED');
  sources.push(ref(identity.source));
  if (!staticPolicy || !positive(staticPolicy.maxBoard) || !positive(staticPolicy.dailyLimit) || !Array.isArray(staticPolicy.npcs) ||
      !staticPolicy.npcs.length || staticPolicy.npcs.some(row => !positive(row.id) || !positive(row.mainTaskId) || typeof row.spokes !== 'boolean')) {
    return finish('waiting-facts', 'CUSTOMER_GENERATION_POLICY_UNPROVEN');
  }
  if (eligibility?.current !== true || !sameCustomerContext(context, eligibility.context) || eligibility.customerOpen?.known !== true) return finish('waiting-facts', 'CUSTOMER_GENERATION_OPEN_UNKNOWN');
  if (eligibility.customerOpen.value !== true) return finish('no-action', 'CUSTOMER_GENERATION_CURRENT_DOMAIN_CLOSED');
  // Feature openness is not the hired state. Both _genOrderNotOv and the
  // ordinary-gap arm of _genOrderOv call the same _tryGenOrderToMap. The
  // separate overflow-only arm (no ordinary gap, store below hired capacity)
  // is never planned here. Missing 175 still proves neither hired nor unhired.
  const local = generationFacts?.localSession, guests = generationFacts?.guestState;
  if (!local || local.current !== true || !sameCustomerContext(context, local.context) || local.noPendingButlerReport !== true || !reference(local.proofRef)) return finish('waiting-facts', 'CUSTOMER_GENERATION_LOCAL_REPORT_NOT_QUIESCENT');
  if (!guests || guests.current !== true || !sameCustomerContext(context, guests.context) || guests.mode !== 'headless-no-synthetic-roaming' ||
      !Array.isArray(guests.ids) || guests.ids.length !== 0 || !reference(guests.proofRef)) return finish('waiting-facts', 'CUSTOMER_GENERATION_CURRENT_EMPTY_GUEST_SCOPE_UNPROVEN');
  const board = view.orderMap, stock = view.orderStockList;
  const collectionCurrent = one => one?.current === true && one.state === 'known' && one.presence === 'present' &&
    sourceCurrent(one.source) && one.sourceProvidedCollectionComplete === true && one.complete === true && one.truncated === false &&
    Array.isArray(one.entries) && nonnegative(one.total) && one.total <= 4096 && one.entries.length === one.total &&
    one.entries.every(row => row.current === true && row.readable === true && digest(row.contentFingerprint));
  if (!collectionCurrent(board)) return finish('waiting-facts', 'CUSTOMER_GENERATION_COMPLETE_CURRENT_BOARD_REQUIRED');
  if (board.total >= staticPolicy.maxBoard) return finish('no-action', 'CUSTOMER_GENERATION_BOARD_FULL_IN_NON_OVERFLOW_MODE');
  if (!collectionCurrent(stock)) return finish('waiting-facts', 'CUSTOMER_GENERATION_COMPLETE_CURRENT_STOCK_LIST_REQUIRED');
  if (stock.total !== 0 || stock.reportedEmpty !== true) return finish('waiting-facts', 'CUSTOMER_GENERATION_ORDINARY_SCOPE_REQUIRES_EXPLICIT_EMPTY_STOCK');
  sources.push(ref(board.source), ref(stock.source));
  const task = view.eligibilityInputs?.mainTask;
  if (!currentCell(task?.domain) || !currentCell(task.uid) || task.uid.value !== identity.uid.value || !currentCell(task.curTaskId) || !nonnegative(task.curTaskId.value)) return finish('waiting-facts', 'CUSTOMER_GENERATION_CURRENT_MAIN_TASK_UNKNOWN');
  const openIds = staticPolicy.npcs.filter(row => task.curTaskId.value >= row.mainTaskId).map(row => row.id);
  const occupied = new Set(board.entries.map(row => row.npcId));
  const regularAvailable = staticPolicy.npcs.filter(row => !row.spokes && openIds.includes(row.id) && !occupied.has(row.id)).map(row => row.id);
  if (!regularAvailable.length || board.total >= openIds.length) return finish('no-action', 'CUSTOMER_GENERATION_NO_OPEN_REGULAR_NPC_SPACE');
  sources.push(ref(task.curTaskId.source));
  const day = generationFacts?.officialDay, count = generationFacts?.count107;
  if (!day || day.known !== true || !/^\d{4}-\d{2}-\d{2}$/.test(day.key || '') || !positive(day.startMs) || !positive(day.endMs) || day.endMs <= day.startMs ||
      !Number.isSafeInteger(day.utcOffsetMinutes) || Math.abs(day.utcOffsetMinutes) > 14 * 60 || !reference(day.proofRef) ||
      clock?.available !== true || clock.source !== 'official-anchor-monotonic' || clock.connectionEpoch !== context.connectionEpoch ||
      !Number.isFinite(clock.lowerBoundMs) || !Number.isFinite(clock.upperBoundMs) || clock.lowerBoundMs > clock.upperBoundMs ||
      clock.lowerBoundMs < day.startMs || clock.upperBoundMs >= day.endMs || day.endMs - day.startMs !== 86400000 ||
      (day.startMs + day.utcOffsetMinutes * 60000) % 86400000 !== 0 ||
      new Date(day.startMs + day.utcOffsetMinutes * 60000).toISOString().slice(0, 10) !== day.key) return finish('waiting-facts', 'CUSTOMER_GENERATION_OFFICIAL_DAY_OR_CLOCK_UNKNOWN');
  if (!count || count.current !== true || count.uid !== identity.uid.value || count.type !== 107 || !nonnegative(count.tdyCnt) ||
      !positive(count.rTimeMs) || !sourceCurrent(count.source)) return finish('waiting-facts', 'CUSTOMER_GENERATION_CURRENT_COUNT107_UNKNOWN');
  // These are independently typed current facts. Their sources remain separate
  // in the proposal; requiring one response frame would reject valid matched
  // incremental updates and would not strengthen identity or completeness.
  const readAt = positive(count.source.serverRespondedMs) ? count.source.serverRespondedMs : positive(count.source.serverMs) ? count.source.serverMs : null;
  if (readAt === null || readAt < day.startMs || readAt >= day.endMs || readAt > clock.upperBoundMs || count.rTimeMs >= day.endMs) return finish('waiting-facts', 'CUSTOMER_GENERATION_COUNT_REQUIRES_NORMAL_READ_THIS_DAY');
  // Preserve the raw row. A prior-day counter is interpreted only after a
  // real matched read THIS official day, never by clearing local stored data.
  const effectiveCount = count.rTimeMs < day.startMs ? 0 : count.tdyCnt;
  sources.push(ref(count.source));
  const used = effectiveCount + board.total + stock.total;
  if (!nonnegative(used)) return finish('waiting-facts', 'CUSTOMER_GENERATION_DAILY_ACCOUNTING_INVALID');
  if (used >= staticPolicy.dailyLimit) return finish('no-action', 'CUSTOMER_GENERATION_DAILY_OPPORTUNITY_EXHAUSTED', null, day.endMs);
  const next = view.nextGenTime;
  let schedule;
  if (next?.current === true && sourceCurrent(next.source) && next.presence === 'null') schedule = { kind: 'explicit-null-client-no-deadline', value: null };
  else if (currentCell(next) && positive(next.value)) schedule = { kind: 'provided-date', value: next.value };
  else return finish('waiting-facts', 'CUSTOMER_GENERATION_NEXT_TIME_UNKNOWN');
  sources.push(ref(next.source));
  if (schedule.value !== null && clock.lowerBoundMs <= schedule.value + staticPolicy.clientNextTimeOffsetMs) return finish('waiting-until',
    'CUSTOMER_GENERATION_CLIENT_DEADLINE_NOT_PASSED', null, schedule.value + staticPolicy.clientNextTimeOffsetMs + 1);
  const business = { ownerRef: context.ownerRef, subjectRef: context.subjectRef, officialDay: day.key, effectiveCount,
    board: board.entries.map(row => [row.npcId, row.contentFingerprint]).sort((a, b) => a[0] - b[0]),
    stock: stock.entries.map(row => row.contentFingerprint).sort(), nextGenTime: schedule, openNpcIds: openIds, guestIds: [] };
  const opportunity = { businessFingerprint: fingerprint(business), officialDay: { key: day.key, startMs: day.startMs, endMs: day.endMs,
    utcOffsetMinutes: day.utcOffsetMinutes, proofRef: day.proofRef }, count107: { rawValue: count.tdyCnt, rTimeMs: count.rTimeMs,
    effectiveValue: effectiveCount, priorDayValueInterpretedAfterCurrentRead: count.rTimeMs < day.startMs },
    boardCount: board.total, stockCount: stock.total, dailyLimit: staticPolicy.dailyLimit, remainingDailyOpportunity: staticPolicy.dailyLimit - used,
    maxBoard: staticPolicy.maxBoard, remainingBoardCapacity: staticPolicy.maxBoard - board.total, openNpcIds: openIds,
    availableRegularNpcIds: regularAvailable, nextGenTime: schedule, guestIds: [], guestMode: guests.mode,
    localReportProofRef: local.proofRef, guestScopeProofRef: guests.proofRef,
    serverGeneratedQuantityKnown: false, requiresExactHistoricalGenerationAdmission: true, requiresFinalCurrentRecheck: true,
    requiresMatchedAnswerAndIndependentComplete109: true, predictedOrdersAreInventory: false };
  return finish('opportunity', 'CUSTOMER_GENERATION_CURRENT_FINITE_OPPORTUNITY', opportunity);
}
