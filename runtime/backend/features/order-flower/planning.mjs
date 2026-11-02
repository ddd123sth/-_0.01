import { clone, fingerprint, freeze } from '../../common.mjs';
import { knownOrderFlowerCell, orderFlowerContext, orderFlowerContextKey, orderFlowerSourceProofValid, sameOrderFlowerContext } from './wire-facts.mjs';
import { accountOrderFlowerButler, ORDER_FLOWER_STORED_DELIVERY_CONTRACT } from './butler.mjs';
import { isNormalSyncMethod } from '../../facts/normal-sync-contract.mjs';

const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const scalar = cell => knownOrderFlowerCell(cell) ? cell.value : null;
const sync = value => { if (value?.then) { value.catch?.(() => {}); throw new TypeError('Order flower planning ports must be synchronous'); } return value; };
export function sourceCurrent(cell, context) {
  const source = cell?.source;
  return cell?.current === true && source?.contextKey === orderFlowerContextKey(context) && source.kind === 'response' && source.transport === 'answered' &&
    source.connectionEpoch === context.connectionEpoch && positive(source.requestSequence) && reference(source.responseRef) && isNormalSyncMethod(source.method) &&
    orderFlowerSourceProofValid(source.version);
}
function observedDay(officialDay, clock, context) {
  return officialDay?.known === true && positive(officialDay.startMs) && officialDay.endMs - officialDay.startMs === 86400000 && reference(officialDay.proofRef) &&
    clock?.available === true && clock.source === 'official-anchor-monotonic' && clock.connectionEpoch === context.connectionEpoch &&
    Number.isFinite(clock.nowMs) && clock.lowerBoundMs <= clock.nowMs && clock.nowMs <= clock.upperBoundMs &&
    Number.isFinite(clock.lowerBoundMs) && Number.isFinite(clock.upperBoundMs) && clock.lowerBoundMs <= clock.upperBoundMs &&
    clock.lowerBoundMs >= officialDay.startMs && clock.upperBoundMs < officialDay.endMs;
}
function countFor(view, definition, day, clock, context, uid) {
  const row = view.counters[definition.counterId], required = ['domain', 'uid', 'type', 'tdyCnt', 'totCnt', 'rTime'];
  if (!observedDay(day, clock, context) || required.some(key => !knownOrderFlowerCell(row?.[key]) || !sourceCurrent(row[key], context)) ||
      scalar(row.uid) !== uid || scalar(row.type) !== definition.counterId) return { known: false, reasonCode: 'ORDER_FLOWER_CURRENT_DAY_COUNTER_UNKNOWN' };
  const readAt = row.tdyCnt.source.serverMs, rTime = scalar(row.rTime);
  if (!positive(readAt) || readAt < day.startMs || readAt >= day.endMs || !positive(rTime) || rTime > clock.upperBoundMs) return { known: false, reasonCode: 'ORDER_FLOWER_NORMAL_COUNTER_READ_THIS_DAY_REQUIRED' };
  const raw = scalar(row.tdyCnt), effective = rTime < day.startMs ? 0 : raw;
  let offset = 0;
  if (definition.counterId !== 105) {
    const order = view.fields[definition.kind], created = order?.value?.fields?.cTime;
    if (!knownOrderFlowerCell(order) || !sourceCurrent(order, context) || !knownOrderFlowerCell(created) || !positive(created.value) ||
        created.value > clock.upperBoundMs) return { known: false, reasonCode: 'ORDER_FLOWER_CURRENT_GENERATED_ORDER_TIME_REQUIRED' };
    offset = created.value >= day.startMs ? 1 : 0;
  }
  return { known: true, counterId: definition.counterId, raw, total: scalar(row.totCnt), rawRTime: rTime, effective,
    value: Math.max(0, effective - offset), offset, uiDisplayValue: Math.max(0, effective - definition.countOffset),
    countRule: 'actual-current-day-generated-order-offset-not-unconditional-ui-minus-one', dayKey: day.key, dayProofRef: day.proofRef,
    source: clone(row.tdyCnt.source),
    cellProofs: Object.fromEntries(required.map(key => [key, { value: clone(scalar(row[key])), source: clone(row[key].source) }])),
    ...(definition.counterId !== 105 ? { generatedOrderTimeProof: { value: scalar(view.fields[definition.kind].value.fields.cTime),
      source: clone(view.fields[definition.kind].source) } } : {}),
    originalCounterUnchanged: true };
}
function cardFor(view, context, uid, clock) {
  const row = view.adCard;
  if (['domain', 'uid', 'type', 'isMain'].some(key => !knownOrderFlowerCell(row?.[key]) || !sourceCurrent(row[key], context)) || scalar(row.uid) !== uid || scalar(row.type) !== 6) return { known: false, value: null, reasonCode: 'ORDER_FLOWER_AD_CARD_NOT_OBSERVED' };
  if (scalar(row.isMain) === true || scalar(row.isMain) === 1) return { known: true, value: true, kind: 'official-card6-isMain', source: clone(row.isMain.source) };
  if (!knownOrderFlowerCell(row.invalidTime) || !sourceCurrent(row.invalidTime, context) || clock?.available !== true || clock.connectionEpoch !== context.connectionEpoch) return { known: false, value: null, reasonCode: 'ORDER_FLOWER_AD_CARD_EXPIRY_UNKNOWN' };
  const end = scalar(row.invalidTime);
  return end > clock.upperBoundMs ? { known: true, value: true, kind: 'official-card6-valid-until', invalidTime: end, source: clone(row.invalidTime.source) }
    : end <= clock.lowerBoundMs ? { known: true, value: false, reasonCode: 'ORDER_FLOWER_AD_CARD_EXPIRED' }
      : { known: false, value: null, reasonCode: 'ORDER_FLOWER_AD_CARD_CLOCK_INTERVAL_OVERLAP' };
}

// A readonly candidate plan, not a proposal/permit/reservation/verification.
// eligibility[kind] must come from the corresponding CURRENT official-client
// open inputs including server overrides/channels; a static row is no proof.
// keepPolicy is explicit per item. Request proof and token values never enter
// this stock planner; video readiness is assessed by the auxiliary runtime.
export function planOrderFlowerStock({ context: supplied, view, config, catalog, resources, eligibility, clock, officialDay,
  keepPolicy, claimingOperationId = null, storedOrderContract = null, readPolicyCount = null, demandOnly = false } = {}) {
  const context = orderFlowerContext(supplied), uid = scalar(view?.identity?.uid), rows = [];
  catalog = catalog?.forContext?.(context, view?.identity?.source?.version) ?? catalog;
  let butlerAccounting = null;
  const finish = reasonCode => {
    const body = { version: 'order-flower-stock-planning/readonly-v1', context, reasonCode, entries: rows, readOnly: true, writeEligible: false,
      proposalCreated: false, reservationCreated: false, registeredMethods: [], fullPlanDenominatorUnchanged: '77-modules/478-fields',
      requiresPersistentOccurrenceIdentity: true, requiresTwoStageAdmissionAndIndependentVerification: true, butlerAccounting };
    return freeze({ ...body, planRef: 'order-flower-readonly-plan:' + fingerprint(body) });
  };
  if (!context || !view?.current || !view.available || !sameOrderFlowerContext(context, view.context) || !view.identity?.verified || !positive(uid) ||
      !sourceCurrent(view.identity.uid, context) || !sourceCurrent(view.domain, context)) return finish('ORDER_FLOWER_CURRENT_MATCHED_DOMAIN_REQUIRED');
  if (typeof catalog?.definition !== 'function' || typeof resources?.budget !== 'function') return finish('ORDER_FLOWER_READONLY_DEPENDENCIES_UNAVAILABLE');
  butlerAccounting = accountOrderFlowerButler({ context, view, eligibility, catalog, clock, officialDay });
  const resident = view.fields.residentMap;
  const candidates = knownOrderFlowerCell(resident) && sourceCurrent(resident, context) && resident.value.complete === true
    ? resident.value.entries.map(row => ({ row, sourceCell: resident })) : [];
  for (const kind of ['satin', 'decorate']) if (knownOrderFlowerCell(view.fields[kind]) && sourceCurrent(view.fields[kind], context)) candidates.push({ row: view.fields[kind], sourceCell: view.fields[kind] });
  for (const kind of ['resident', 'satin', 'decorate']) {
    const definition = catalog.definition(kind), options = config?.config?.orders?.[kind] ?? config?.orders?.[kind], open = eligibility?.[kind];
    const base = { kind, featureId: definition?.featureId ?? null, videoFollowsCategoryEnabled: true, independentVideoSwitchUsed: false };
    if (definition && typeof catalog.supports === 'function' && !catalog.supports(kind, view.identity.source?.version)) {
      rows.push({ ...base, state: 'waiting-facts', reasonCode: 'ORDER_FLOWER_CURRENT_DATA_BINDING_UNPROVEN' }); continue;
    }
    if (typeof options?.enabled !== 'boolean' || !nonnegative(options.dailyLimit)) { rows.push({ ...base, state: 'waiting-facts', reasonCode: 'ORDER_FLOWER_CONFIG_UNKNOWN' }); continue; }
    if (!options.enabled) { rows.push({ ...base, state: 'disabled', reasonCode: 'ORDER_FLOWER_CATEGORY_DISABLED' }); continue; }
    if (!definition || open?.known !== true || !sameOrderFlowerContext(context, open.context) || open.officialUid !== uid || open.openId !== definition.openId || !reference(open.proofRef)) { rows.push({ ...base, state: 'waiting-facts', reasonCode: 'ORDER_FLOWER_CURRENT_OPEN_INPUTS_REQUIRED' }); continue; }
    if (open.value !== true) { rows.push({ ...base, state: 'no-action', reasonCode: 'ORDER_FLOWER_CURRENTLY_CLOSED' }); continue; }
    const count = countFor(view, definition, officialDay, clock, context, uid), limit = options.dailyLimit === 0 ? definition.officialDailyLimit : Math.min(definition.officialDailyLimit, options.dailyLimit);
    if (!count.known) { rows.push({ ...base, state: 'waiting-facts', reasonCode: count.reasonCode }); continue; }
    const policyCount = readPolicyCount ? sync(readPolicyCount({ context, kind, officialDay, serverCount: count }))
      : { known: true, value: count.value, serverOnly: true };
    if (policyCount?.known !== true || !nonnegative(policyCount.value)) { rows.push({ ...base, state: 'waiting-facts', reasonCode: policyCount?.reasonCode || 'ORDER_FLOWER_CURRENT_POLICY_COUNT_REQUIRED' }); continue; }
    if (policyCount.value >= limit) { rows.push({ ...base, state: 'no-action', reasonCode: 'ORDER_FLOWER_DAILY_LIMIT_REACHED', count, policyCount, limit }); continue; }
    const selected = candidates.filter(({ row }) => row.value?.kind === kind);
    if (!selected.length) { rows.push({ ...base, state: 'waiting-facts', reasonCode: 'ORDER_FLOWER_CURRENT_ROW_NOT_PROVIDED', count, limit }); continue; }
    for (const { row, sourceCell } of selected) {
      const { boxId, fields } = row.value;
      const accounting = butlerAccounting.boxes[boxId];
      const entry = { ...base, boxId, contentFingerprint: row.contentFingerprint, contentIsNotOccurrenceIdentity: true, source: clone(sourceCell.source), count, policyCount, limit,
        butlerStock: accounting ? clone(accounting) : null, butlerDaily: clone(butlerAccounting.daily[kind] ?? null),
        storedOrderConsumesActualFlowers: true };
      if (!['npcId', 'dialogId', 'isVideo', 'cTime'].every(key => knownOrderFlowerCell(fields[key])) || !positive(scalar(fields.npcId)) || !catalog.npc(scalar(fields.npcId))) { rows.push({ ...entry, state: 'waiting-facts', reasonCode: 'ORDER_FLOWER_ORDER_IDENTITY_FIELDS_UNKNOWN' }); continue; }
      if (!sourceCurrent(sourceCell, context)) { rows.push({ ...entry, state: 'waiting-facts', reasonCode: 'ORDER_FLOWER_NORMAL_CURRENT_BOARD_SNAPSHOT_REQUIRED' }); continue; }
      if (scalar(fields.cTime) > clock.upperBoundMs) { rows.push({ ...entry, state: 'waiting-facts', reasonCode: 'ORDER_FLOWER_ORDER_TIME_IN_FUTURE' }); continue; }
      if (kind === 'resident') {
        const level = sourceCurrent(view.level, context) && knownOrderFlowerCell(view.level) ? catalog.level(view.level.value) : null;
        if (!positive(level?.orderFlower)) { rows.push({ ...entry, state: 'waiting-facts', reasonCode: 'ORDER_FLOWER_CURRENT_UNLOCKED_BOX_COUNT_UNKNOWN' }); continue; }
        if (boxId > level.orderFlower) { rows.push({ ...entry, state: 'no-action', reasonCode: 'ORDER_FLOWER_BOX_NOT_OPEN_AT_CURRENT_LEVEL' }); continue; }
      }
      if (demandOnly) {
        if (scalar(fields.isVideo) === true || scalar(fields.isVideo) === 1) continue;
        if (!knownOrderFlowerCell(fields.flowers) || fields.flowers.value.length === 0) {
          rows.push({ ...entry, state: 'waiting-facts', reasonCode: 'ORDER_FLOWER_ACTUAL_FLOWER_REQUIREMENTS_UNKNOWN' }); continue;
        }
        const sums = new Map();
        for (const [itemId, quantity] of fields.flowers.value) sums.set(itemId, (sums.get(itemId) || 0) + quantity);
        rows.push({ ...entry, state: 'demand', requirements: [...sums].map(([itemId, quantity]) => ({ itemId, quantity, known: true })) });
        continue;
      }
      const stock = view.fields.stockMap;
      if (!knownOrderFlowerCell(stock) || !sourceCurrent(stock, context) || stock.value.complete !== true) {
        rows.push({ ...entry, state: 'waiting-facts', reasonCode: 'ORDER_FLOWER_CURRENT_COMPLETE_BUTLER_STOCK_MAP_REQUIRED' }); continue;
      }
      if (accounting?.known !== true) {
        rows.push({ ...entry, state: 'waiting-facts', reasonCode: accounting?.reasonCode || butlerAccounting.reasonCode || 'ORDER_FLOWER_BUTLER_ACCOUNTING_REQUIRED' }); continue;
      }
      const hasStoredOrder = accounting.effectiveStockNum > 0;
      const cd = fields.cdTime;
      if (!hasStoredOrder && cd.presence !== 'null' && !knownOrderFlowerCell(cd)) { rows.push({ ...entry, state: 'waiting-facts', reasonCode: 'ORDER_FLOWER_COOLDOWN_UNKNOWN' }); continue; }
      if (!hasStoredOrder && knownOrderFlowerCell(cd) && cd.value > clock.lowerBoundMs) {
        const provedReadyAt = Math.ceil(cd.value + Math.max(0, clock.nowMs - clock.lowerBoundMs) + 1);
        const nextStockAt = positive(accounting.nextChangeAt) && accounting.nextChangeAt > clock.nowMs ? accounting.nextChangeAt : null;
        rows.push({ ...entry, state: 'waiting-until', reasonCode: 'ORDER_FLOWER_COOLDOWN_NOT_PROVED_FINISHED',
          earliestOfficialMs: nextStockAt === null ? provedReadyAt : Math.min(provedReadyAt, nextStockAt) }); continue;
      }
      if (scalar(fields.isVideo) === true || scalar(fields.isVideo) === 1) {
        const share = view.shares[definition.shareId], shareStatic = catalog.share(definition.shareId);
        const shareKnown = ['domain', 'uid', 'tmpId', 'recvCnt', 'uTime'].every(key => knownOrderFlowerCell(share?.[key]) && sourceCurrent(share[key], context)) && scalar(share.uid) === uid && scalar(share.tmpId) === definition.shareId;
        const readAt = shareKnown ? share.recvCnt.source.serverMs : null, time = shareKnown ? scalar(share.uTime) : null;
        const quotaKnown = shareKnown && positive(shareStatic?.limit) && shareStatic.limitType === 1 && positive(readAt) && readAt >= officialDay.startMs && readAt < officialDay.endMs && positive(time) && time <= clock.upperBoundMs;
        const effectiveRecv = quotaKnown ? time < officialDay.startMs ? 0 : scalar(share.recvCnt) : null;
        const card = cardFor(view, context, uid, clock);
        const videoOpen = eligibility?.video?.[kind];
        const videoOpenKnown = videoOpen?.known === true && videoOpen.value === true && sameOrderFlowerContext(context, videoOpen.context) &&
          videoOpen.officialUid === uid && videoOpen.openId === definition.videoOpenId && reference(videoOpen.proofRef);
        rows.push({ ...entry, branch: 'video', shareId: definition.shareId, reward: knownOrderFlowerCell(fields.videoRwd) ? clone(fields.videoRwd.value) : null,
          state: !quotaKnown || !videoOpenKnown || !knownOrderFlowerCell(fields.videoRwd) ? 'waiting-facts' : effectiveRecv >= shareStatic.limit ? 'no-action'
            : card.known && card.value ? 'capability-observed' : 'waiting-capability',
          reasonCode: !quotaKnown ? 'ORDER_FLOWER_VIDEO_CURRENT_QUOTA_UNKNOWN' : !videoOpenKnown ? 'ORDER_FLOWER_VIDEO_OPEN_INPUTS_UNKNOWN' : !knownOrderFlowerCell(fields.videoRwd) ? 'ORDER_FLOWER_VIDEO_REWARD_UNKNOWN'
             : effectiveRecv >= shareStatic.limit ? 'ORDER_FLOWER_VIDEO_DAILY_QUOTA_EXHAUSTED' : card.known && card.value ? 'ORDER_FLOWER_LEGAL_CARD_CAPABILITY_OBSERVED'
               : 'ORDER_FLOWER_LEGAL_CARD_OR_REQUEST_PREPARATION_REQUIRED',
          videoQuota: { known: !!quotaKnown, rawRecvCnt: shareKnown ? scalar(share.recvCnt) : null, effectiveRecvCnt: effectiveRecv, limit: shareStatic?.limit ?? null, originalRowUnchanged: true },
          adCard: card, tokenStored: false, shareWriteRegistered: false });
        continue;
      }
      if (!knownOrderFlowerCell(fields.flowers) || fields.flowers.value.length === 0) { rows.push({ ...entry, state: 'waiting-facts', reasonCode: 'ORDER_FLOWER_ACTUAL_FLOWER_REQUIREMENTS_UNKNOWN' }); continue; }
      if (hasStoredOrder && storedOrderContract !== ORDER_FLOWER_STORED_DELIVERY_CONTRACT) {
        rows.push({ ...entry, state: 'waiting-contract', reasonCode: 'ORDER_FLOWER_BUTLER_STOCK_SETTLEMENT_CONTRACT_REQUIRED',
          deliveryPath: 'butler-stored-order', beforeEffectiveStockNum: accounting.effectiveStockNum,
          requiredStoredOrderContract: ORDER_FLOWER_STORED_DELIVERY_CONTRACT }); continue;
      }
      const sums = new Map(); for (const [itemId, quantity] of fields.flowers.value) sums.set(itemId, (sums.get(itemId) || 0) + quantity);
      const budgets = [...sums].map(([itemId, quantity]) => {
        const keep = typeof keepPolicy === 'function' ? sync(keepPolicy({ context, itemId, kind, purpose: 'order-flower-delivery' })) : keepPolicy;
        if (keep?.known !== true || !nonnegative(keep.keep) || !reference(keep.policyRef) || !positive(quantity)) return { itemId, quantity, known: false, reasonCode: 'ORDER_FLOWER_EXPLICIT_KEEP_POLICY_REQUIRED' };
        const budget = sync(resources.budget({ context, itemId, quantity, keep: keep.keep, claimingOperationId,
          requireOwnReservation: claimingOperationId !== null }));
        return { itemId, quantity, keep: keep.keep, keepPolicyRef: keep.policyRef, budget: clone(budget), known: budget?.known === true, allowed: budget?.allowed === true };
      });
      rows.push({ ...entry, branch: 'stock-delivery', state: budgets.every(one => one.known && one.allowed) ? 'stock-candidate' : 'waiting-stock',
        reasonCode: budgets.every(one => one.known && one.allowed) ? 'ORDER_FLOWER_REAL_STOCK_CANDIDATE_ONLY' : 'ORDER_FLOWER_REQUIRED_STOCK_OR_RESOURCE_BASIS_UNKNOWN_OR_SHORT',
        requirements: budgets, futureMethodHint: definition.methodHint, requiredFutureContract: 'original-occurrence+exact-resources+matched-answer+fresh-complete-105/counter/absolute-items',
        butlerStockReconciliationRequiredBeforeAnyWrite: true, rawButlerStockKnown: accounting.known, deliveryPath: hasStoredOrder ? 'butler-stored-order' : 'ordinary-ready-order',
        beforeEffectiveStockNum: accounting.effectiveStockNum, stockAccountingBasisRef: accounting.basisRef,
        noQuickCraftOrBuyingScheduled: true });
    }
  }
  return finish(null);
}
