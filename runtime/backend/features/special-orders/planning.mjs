import { fingerprint, plainObject } from '../../common.mjs';
import { officialDateMs } from '../land/wire-facts.mjs';

const wait = reasonCode => ({ state: 'waiting-facts', reasonCode });
const positive = value => Number.isSafeInteger(value) && value > 0;
const value = (snapshot, name) => snapshot?.fields?.[name]?.state === 'known' ? snapshot.fields[name].value : undefined;
const read = (object, name, index) => Object.hasOwn(object, name) ? object[name] : object[index];

export function palacePeriod({ extension, clock, day } = {}) {
  const hours = extension?.rules?.palaceHours;
  if (!Array.isArray(hours) || !hours.length || clock?.available !== true || day?.current !== true ||
      !Number.isSafeInteger(day.startMs) || !Number.isSafeInteger(day.endMs) || day.endMs - day.startMs !== 86400000 ||
      !Number.isSafeInteger(clock.lowerBoundMs) || !Number.isSafeInteger(clock.upperBoundMs)) return null;
  const periodAt = at => {
    const starts = [-1, 0, 1].flatMap(offset => hours.map(hour => day.startMs + offset * 86400000 + hour * 3600000)).sort((a, b) => a - b);
    const index = starts.findLastIndex(start => start <= at);
    return index >= 0 && index + 1 < starts.length ? { startMs: starts[index], endMs: starts[index + 1] } : null;
  };
  const lower = periodAt(clock.lowerBoundMs), upper = periodAt(clock.upperBoundMs);
  return lower && upper && lower.startMs === upper.startMs ? lower : null;
}

// Returns a finite candidate and its actual server-state identity. It cannot
// reserve, send, settle or create a current-write permission by itself.
export function planSpecialOrder({ kind, snapshot, extension, clock, day, config, open, itemBudget, currencyBudget } = {}) {
  const cfg = config?.orders?.[kind];
  if (cfg?.enabled !== true) return { state: 'disabled', reasonCode: 'SPECIAL_ORDER_DISABLED' };
  if (open?.known !== true || open.value !== true) return wait(open?.reasonCode || 'SPECIAL_ORDER_OPEN_NOT_PROVEN');
  if (!extension || clock?.available !== true) return wait('SPECIAL_ORDER_RULES_OR_CLOCK_REQUIRED');
  if (kind === 'palace') {
    const period = palacePeriod({ extension, clock, day });
    if (!period) return wait('PALACE_PERIOD_NOT_PROVEN');
    const periodRef = 'palace-period:' + fingerprint(period);
    if (snapshot?.current !== true || value(snapshot, 'flowerId') === 0 || value(snapshot, 'isFinish') === true || value(snapshot, 'isFinish') === 1)
      return { state: 'candidate', kind, action: 'enter', params: {}, cycleRef: periodRef, period };
    const flowerId = value(snapshot, 'flowerId'), quantity = value(snapshot, 'num'), updated = value(snapshot, 'uTime'),
      last = value(snapshot, 'lTime'), finished = value(snapshot, 'isFinish'), quality = extension.rules.palette[flowerId];
    if (positive(updated) && updated < period.startMs)
      return { state: 'candidate', kind, action: 'enter', params: {}, cycleRef: periodRef, period };
    if (positive(updated) && updated >= period.endMs) return wait('PALACE_OFFER_CLOCK_PERIOD_CONFLICT');
    if (!positive(flowerId) || !positive(quantity) || !positive(updated) || ![false, 0].includes(finished) || !quality)
      return wait('PALACE_CURRENT_OFFER_NOT_PROVEN');
    if (!Array.isArray(cfg.qualityFilter) || cfg.qualityFilter.includes(quality))
      return { state: 'no-action', reasonCode: 'PALACE_QUALITY_EXCLUDED', period };
    const budget = itemBudget({ itemId: flowerId, quantity, keep: 0 });
    if (budget?.known !== true || budget.allowed !== true) return wait(budget?.reasonCode || 'PALACE_FLOWER_BUDGET_UNAVAILABLE');
    return { state: 'candidate', kind, action: 'finish', params: {}, itemId: flowerId, quantity, quality, period,
      cycleRef: 'palace-offer:' + fingerprint({ uid: value(snapshot, 'uid'), flowerId, quantity, updated, last: last ?? null }) };
  }
  if (kind !== 'team') return { state: 'unimplemented', reasonCode: 'SPECIAL_ORDER_KIND_UNKNOWN' };
  if (cfg.realWrite !== true) return { state: 'blocked', reasonCode: 'TEAM_REAL_WRITE_DISABLED' };
  if (snapshot?.current !== true) return wait('TEAM_CURRENT_STATE_REQUIRED');
  const status = value(snapshot, 'status'), start = value(snapshot, 'startTime'), npcId = value(snapshot, 'npcId'),
    activeTime = value(snapshot, 'activeTime'), activeCnt = value(snapshot, 'activeCnt'), updated = value(snapshot, 'uTime');
  if (![0, 1, 2, 3].includes(status) || !Number.isSafeInteger(activeCnt) || activeCnt < 0 || !positive(updated))
    return wait('TEAM_CURRENT_CYCLE_NOT_PROVEN');
  const cycle = { uid: value(snapshot, 'uid'), npcId: npcId ?? null, start: start ?? null,
    activeTime: activeTime ?? null, activeCnt };
  const cycleRef = 'team-cycle:' + fingerprint(cycle), durationMs = extension.rules.teamDurationSeconds * 1000,
    ended = status === 3 || status === 2 && positive(start) && clock.lowerBoundMs > start + durationMs;
  if (ended) {
    if (!plainObject(value(snapshot, 'rwd'))) return wait('TEAM_REWARD_STATE_REQUIRED');
    return { state: 'candidate', kind, action: 'receive', params: {}, cycleRef, cycle };
  }
  if (status === 2) {
    const orderNum = value(snapshot, 'orderNum'), flowerId = value(snapshot, 'flowerId'), quantity = extension.rules.quantities[orderNum];
    if (!positive(start) || !positive(orderNum) || !positive(flowerId) || !positive(quantity) || !extension.rules.palette[flowerId])
      return wait('TEAM_CURRENT_STAGE_NOT_PROVEN');
    if (clock.upperBoundMs + 2000 >= start + durationMs) return { state: 'waiting-until', reasonCode: 'TEAM_STAGE_END_NEAR',
      officialDueMs: start + durationMs + 1 };
    const budget = itemBudget({ itemId: flowerId, quantity, keep: 0 });
    if (budget?.known !== true || budget.allowed !== true) return wait(budget?.reasonCode || 'TEAM_FLOWER_BUDGET_UNAVAILABLE');
    return { state: 'candidate', kind, action: 'submit', params: {}, cycleRef: cycleRef + ':stage:' + orderNum,
      cycle, orderNum, itemId: flowerId, quantity };
  }
  if (status === 1 && cfg.allowFreeTake === true) return { state: 'candidate', kind, action: 'take', params: { isAgree: true, isCost: false },
    cycleRef: 'team-offer:' + fingerprint({ ...cycle, updated }), cycle, paid: false };
  const stored = value(snapshot, 'storedOrders');
  if (cfg.allowFreeTake === true && Array.isArray(stored)) {
    const candidates = stored.map(row => ({ npcId: read(row, 'npcId', '0'), expireTime: officialDateMs(read(row, 'expireTime', '1')) }))
      .filter(row => positive(row.npcId) && positive(row.expireTime) && row.expireTime > clock.upperBoundMs + 2000)
      .filter(row => stored.filter(other => read(other, 'npcId', '0') === row.npcId).length === 1)
      .sort((a, b) => a.expireTime - b.expireTime || a.npcId - b.npcId);
    if (candidates.length) {
      const chosen = candidates[0];
      return { state: 'candidate', kind, action: 'stored', params: { npcId: chosen.npcId }, cycle,
        cycleRef: 'team-stored:' + fingerprint({ uid: cycle.uid, ...chosen }), stored: chosen, paid: false };
    }
  }
  if (status === 0 && cfg.allowBuyAgain === true) {
    const remaining = value(snapshot, 'remainingNum'), rwd = value(snapshot, 'rwd'), quantity = extension.rules.teamBuyAmount,
      keep = cfg.buyAgainKeepYuanbao;
    if (!positive(remaining) || !plainObject(rwd) || Object.values(rwd).some(amount => amount !== 0))
      return { state: 'no-action', reasonCode: 'TEAM_NO_PAID_REENTRY_OPPORTUNITY' };
    if (!Number.isSafeInteger(keep) || keep < 0) return wait('TEAM_YUANBAO_KEEP_INVALID');
    const budget = currencyBudget({ currency: 'yuanbao', quantity, keep });
    if (budget?.known !== true || budget.allowed !== true) return wait(budget?.reasonCode || 'TEAM_YUANBAO_BUDGET_UNAVAILABLE');
    return { state: 'candidate', kind, action: 'take', params: { isAgree: true, isCost: true },
      cycleRef: 'team-paid-offer:' + fingerprint({ ...cycle, updated, remaining }), cycle, paid: true,
      currency: 'yuanbao', quantity, keep };
  }
  return { state: 'no-action', reasonCode: 'TEAM_NO_ENABLED_CURRENT_ACTION' };
}
