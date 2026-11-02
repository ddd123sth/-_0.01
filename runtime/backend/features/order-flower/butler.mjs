import fs from 'node:fs';
import crypto from 'node:crypto';
import { canonical, clone, fingerprint, freeze, plainObject, problem } from '../../common.mjs';
import { knownOrderFlowerCell, orderFlowerContext, orderFlowerContextKey, sameOrderFlowerContext } from './wire-facts.mjs';
import { currentOfficialDataEvidence } from '../../official-data-evidence.mjs';

const VERSION = 'order-flower-butler-accounting/current-source/v2';
export const ORDER_FLOWER_STORED_DELIVERY_CONTRACT = 'order-flower-stored-delivery/480.0.27/v1';
const DATA_SHA = '05562cc75cab3fa18970582c082e44a29ca4928bd2e73d95f6bd1c4ad9270585';
const GAME_SHA = 'fc9970989021e4266301d2a167ae8e827ef71a124ad9d7f23cb922095a22aa69';
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const sync = value => { if (value?.then) { value.catch?.(() => {}); throw new TypeError('Butler accounting ports must be synchronous'); } return value; };
let staticData;
function data() {
  if (!staticData) {
    const bytes = fs.readFileSync(new URL('./static/butler-480.0.27.json', import.meta.url));
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== DATA_SHA) throw problem('ORDER_BUTLER_STATIC_INTEGRITY', '管家存单静态来源指纹不一致', 500);
    const value = JSON.parse(bytes.toString('utf8'));
    if (value.gameDecodedSha256 !== GAME_SHA || value.gameVersion !== '480.0.27' || value.protocolVersion !== '480.0.0' ||
        !Array.isArray(value.maxFlowerOrder) || value.maxFlowerOrder.length !== 3 || !value.maxFlowerOrder.every(positive)) {
      throw problem('ORDER_BUTLER_STATIC_VERSION', '管家存单静态版本不成立', 500);
    }
    staticData = freeze(value);
  }
  return staticData;
}

// This is a bounded, explicit-date subset of the official period parser. No
// unzoned string is parsed in the workstation/device's guessed local timezone.
function periodMs(value, day) {
  if (positive(value) && value <= 8640000000000000) return value;
  if (typeof value !== 'string') return null;
  // mo R()/w() recognizes this exact ISO form before replacing hyphens.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    const parsed = Date.parse(value);
    return positive(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
  }
  if (/[TZ+]/.test(value)) return null;
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(value);
  if (!m) return null;
  const [year, month, date, hour, minute, second] = m.slice(1, 7).map((v, i) => v === undefined ? i >= 3 ? 0 : NaN : Number(v));
  const ms = Number((m[7] || '').padEnd(3, '0'));
  if (year < 1970 || year > 9999 || month < 1 || month > 12 || date < 1 || date > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const wall = Date.UTC(year, month - 1, date, hour, minute, second, ms), check = new Date(wall);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null;
  let offset;
  if (m[8] === 'Z') offset = 0;
  else if (m[8]) {
    const text = m[8].replace(':', ''), hours = Number(text.slice(1, 3)), minutes = Number(text.slice(3, 5));
    if (hours > 14 || minutes > 59 || hours === 14 && minutes !== 0) return null;
    offset = (text[0] === '+' ? 1 : -1) * (hours * 60 + minutes);
  } else {
    offset = day?.utcOffsetMinutes;
    if (day?.known !== true || !reference(day.proofRef) || !Number.isSafeInteger(offset) || Math.abs(offset) > 840) return null;
  }
  const result = wall - offset * 60000;
  return positive(result) ? result : null;
}

// Audited current D()/R() accounting caps satin/decorate stock by today's
// remaining official allowance. The resident round-robin rule is unchanged.
export function officialStoredStockCapacity({ kind, capacity, dailyLimit, counter, dailyClamp = false }) {
  if (!dailyClamp || kind === 'resident') return capacity;
  if (counter?.known !== true || !nonnegative(counter.uiDisplayCount) || !nonnegative(dailyLimit)) return null;
  return Math.max(0, Math.min(capacity, dailyLimit - counter.uiDisplayCount));
}

// Only official-client stock accounting. No execution, reservation, purchase,
// server reset, cache clock, or absence-of-official-automation assertion.
export function accountOrderFlowerButler({ context: supplied, view, eligibility, catalog, clock, officialDay } = {}) {
  const context = orderFlowerContext(supplied), boxes = {}, daily = {}, dependencies = [], sourceData = data();
  const uid = view?.identity?.uid?.value;
  let currentSourceReceipt = null;
  const sourceCurrent = source => !!context && source?.contextKey === orderFlowerContextKey(context) && source.kind === 'response' &&
    source.transport === 'answered' && source.connectionEpoch === context.connectionEpoch && positive(source.requestSequence) &&
    reference(source.responseRef) && /^ws\|\d+\|[1-9]\d*$/.test(source.wireKey || '') && Number(source.wireKey.split('|').at(-1)) === source.requestSequence &&
    source.version?.source === 'normal-package-hop-and-matched-world-login/v1' &&
    currentOfficialDataEvidence(source.version, 'order.butler-stock')?.dataSnapshotId === view?.identity?.source?.version?.dataSnapshotId &&
    source.version.loginResponseRef === view?.identity?.source?.responseRef;
  const current = cell => cell?.current === true && knownOrderFlowerCell(cell) && sourceCurrent(cell.source);
  const scalar = cell => current(cell) ? cell.value : null;
  const unknown = reasonCode => ({ known: false, reasonCode });
  let hire = unknown('ORDER_BUTLER_HIRE_NOT_OBSERVED');
  const finish = reasonCode => {
    const body = { version: VERSION, context, officialUid: positive(uid) ? uid : null, known: reasonCode === null && Object.keys(boxes).length > 0 &&
      Object.values(boxes).every(one => one.known) && Object.values(daily).every(one => one.known),
      reasonCode, hire, boxes, daily, dependencies: [...new Set(dependencies)], staticSource: { sha256: DATA_SHA,
        historicalGameDecodedSha256: GAME_SHA, fullButlerTableSha256: sourceData.fullButlerTableSha256, ranges: sourceData.ranges },
      currentSource: currentSourceReceipt,
      accountingOnly: true, writeEligible: false, originalRowsUnchanged: true, officialAutomationAbsent: { known: false, value: null },
      storedOrderConsumesActualFlowers: true, storedOrderOnlyBypassesCooldown: true };
    return freeze({ ...body, basisRef: 'order-butler-accounting:' + fingerprint(body) });
  };
  if (!context || !view?.current || !view.available || !sameOrderFlowerContext(context, view.context) || !view.identity?.verified ||
      !positive(uid) || !current(view.identity.uid) || !sourceCurrent(view.identity.source) || view.identity.source.method !== 'index.login') {
    return finish('ORDER_BUTLER_CURRENT_OFFICIAL_IDENTITY_REQUIRED');
  }
  if (clock?.available !== true || clock.source !== 'official-anchor-monotonic' || clock.connectionEpoch !== context.connectionEpoch ||
      !Number.isFinite(clock.lowerBoundMs) || !Number.isFinite(clock.upperBoundMs) || clock.lowerBoundMs <= 0 || clock.lowerBoundMs > clock.upperBoundMs) {
    return finish('ORDER_BUTLER_CURRENT_OFFICIAL_CLOCK_REQUIRED');
  }
  if (officialDay?.known !== true || !positive(officialDay.startMs) || officialDay.endMs - officialDay.startMs !== 86400000 ||
      !reference(officialDay.proofRef) || clock.lowerBoundMs < officialDay.startMs || clock.upperBoundMs >= officialDay.endMs) {
    return finish('ORDER_BUTLER_CURRENT_OFFICIAL_DAY_REQUIRED');
  }
  const catalogIdentity = typeof catalog?.identity === 'function' ? sync(catalog.identity()) : null,
    meta = typeof catalog?.metadata === 'function' ? sync(catalog.metadata()) : null,
    currentPolicy = typeof catalog?.butlerPolicy === 'function' ? sync(catalog.butlerPolicy()) : null,
    loginVersion = view.identity.source.version, sourceProof = currentOfficialDataEvidence(loginVersion, 'order.butler-stock');
  if (!sourceProof || !currentPolicy || currentPolicy.dataSnapshotId !== sourceProof.dataSnapshotId ||
      currentPolicy.sourceVersion !== sourceProof.sourceVersion || currentPolicy.loginResponseRef !== loginVersion.loginResponseRef ||
      currentPolicy.tableHashes?.c_butler !== sourceProof.tableHashes?.c_butler ||
      currentPolicy.tableHashes?.c_orderFlower !== sourceProof.tableHashes?.c_orderFlower ||
      !Array.isArray(currentPolicy.maxFlowerOrder) || currentPolicy.maxFlowerOrder.length !== 3 ||
      !currentPolicy.maxFlowerOrder.every(positive) || !plainObject(meta) ||
      ![meta.$orderCd, meta.$orderCd2, meta.$orderCd3, meta.$dailyMax, meta.$dailyMax2, meta.$dailyMax3].every(positive)) {
    return finish('ORDER_BUTLER_CURRENT_CATALOG_REQUIRED');
  }
  currentSourceReceipt = { proofFingerprint: sourceProof.proofFingerprint, sourceVersion: sourceProof.sourceVersion,
    loginResponseRef: sourceProof.loginResponseRef, dataSnapshotId: sourceProof.dataSnapshotId,
    dataSchemaContractId: sourceProof.dataSchemaContractId, tableHashes: currentPolicy.tableHashes,
    actionContractId: sourceProof.actionContractId, sourceBlockContractSha256: sourceProof.sourceBlockContractSha256 };

  const open = eligibility?.butlerOpen, extRow = view.eligibilityInputs?.serverOpenMap?.butler;
  if (open?.known === true && sameOrderFlowerContext(context, open.context) && open.officialUid === uid && open.openId === 'butler' && reference(open.proofRef)) {
    // UT's hire helper calls OpenCtrl, whereas the public feature evaluator
    // also applies SysOpen SDK-channel/duration checks. A generic SysOpen=false
    // cannot prove unhire. Explicit row.closed is shared by both evaluators.
    if (open.value === false && open.reasonCode === 'ORDER_OPEN_EXPLICITLY_CLOSED') hire = { known: true, hired: false, period: null,
      reasonCode: 'ORDER_BUTLER_CURRENT_OPEN_CLOSED', openProofRef: open.proofRef };
    else if (open.value === true && current(extRow)) {
      const ext = extRow.value?.ext;
      // G480 OpenCtrl.checkAndGetExt returns row.ext || {} for a supplied
      // open override (UTF-8 bytes 261471..261733). The hire helper returns
      // false before consulting 175 when that object has no current period
      // (1341920..1342324). Only actual missing/null ext has this meaning;
      // an unreadable supplied ext remains unknown, and stock rows survive.
      if (ext?.presence === 'missing' || ext?.presence === 'null') {
        hire = { known: true, hired: false, period: null, reasonCode: 'ORDER_BUTLER_NO_CURRENT_OPEN_PERIOD',
          openProofRef: open.proofRef, source: clone(extRow.source) };
      } else if (knownOrderFlowerCell(ext) && plainObject(ext.value)) {
        const begins = ext.value.beginTime, ends = ext.value.endTime,
          array = cell => cell?.presence === 'missing' || cell?.presence === 'null' ? [] : knownOrderFlowerCell(cell) && Array.isArray(cell.value) ? cell.value : null;
        const left = array(begins), right = array(ends);
        if (left && right && left.length === right.length) {
          const periods = left.map((begin, i) => ({ beginMs: periodMs(begin, officialDay), endMs: periodMs(right[i], officialDay) }));
          if (periods.every(one => positive(one.beginMs) && positive(one.endMs) && one.beginMs < one.endMs)) {
            const select = time => periods.find(one => time >= one.beginMs && time < one.endMs) || null,
              low = select(clock.lowerBoundMs), high = select(clock.upperBoundMs);
            // Do not collapse an interval spanning a different/expired period.
            const crossesBoundary = periods.some(one => one.beginMs > clock.lowerBoundMs && one.beginMs <= clock.upperBoundMs ||
              one.endMs > clock.lowerBoundMs && one.endMs <= clock.upperBoundMs);
            if (!crossesBoundary && canonical(low) === canonical(high)) {
              if (!low) hire = { known: true, hired: false, period: null, reasonCode: 'ORDER_BUTLER_NO_CURRENT_OPEN_PERIOD',
                openProofRef: open.proofRef, source: clone(extRow.source) };
              else {
                const one = view.butler?.types?.[1], bought = one?.buyPeriodMap;
                if (current(view.butler?.domain) && current(view.butler?.settingMap) && current(one?.domain) &&
                    scalar(one.uid) === uid && scalar(one.type) === 1 && current(bought) && Array.isArray(bought.value) && bought.collection?.complete !== false) {
                  const found = bought.value.find(item => item.beginMs === low.beginMs), quantity = found?.quantity ?? 0;
                  if (nonnegative(quantity)) hire = { known: true, hired: quantity > 0, period: clone(low), boughtQuantity: quantity,
                    reasonCode: quantity > 0 ? 'ORDER_BUTLER_CURRENT_PERIOD_ACTUALLY_BOUGHT' : 'ORDER_BUTLER_CURRENT_PERIOD_NOT_BOUGHT',
                    openProofRef: open.proofRef, source: clone(bought.source), periodSource: clone(extRow.source),
                    buyPeriodMissingKeyMeansZero: !found, statusWasNotUsedAsHire: true };
                } else dependencies.push('175.0.1.uid/type/buyPeriodMap');
              }
            } else hire = unknown('ORDER_BUTLER_CLOCK_INTERVAL_CROSSES_HIRE_PERIOD');
          } else hire = unknown('ORDER_BUTLER_PERIOD_DATE_UNREADABLE');
        } else hire = unknown('ORDER_BUTLER_PERIOD_PAIRS_UNREADABLE');
      } else dependencies.push('7.9.butler.ext.beginTime/endTime');
    }
  } else dependencies.push('current-open:butler');

  const stocks = view.fields.stockMap, residents = view.fields.residentMap;
  if (!current(stocks) || stocks.value?.complete !== true || !Array.isArray(stocks.value.entries) || !positive(stocks.source.serverMs) ||
      stocks.source.serverMs < officialDay.startMs || stocks.source.serverMs >= officialDay.endMs) return finish('ORDER_BUTLER_CURRENT_COMPLETE_STOCK_MAP_REQUIRED');
  const rawByBox = new Map(stocks.value.entries.map(row => [row.boxId, row]));
  function counter(id, order) {
    const row = view.counters?.[id];
    if (['domain', 'uid', 'type', 'tdyCnt', 'rTime'].some(key => !current(row?.[key])) || scalar(row.uid) !== uid || scalar(row.type) !== id ||
        !positive(row.tdyCnt.source.serverMs) || row.tdyCnt.source.serverMs < officialDay.startMs || row.tdyCnt.source.serverMs >= officialDay.endMs || !positive(scalar(row.rTime)) || scalar(row.rTime) > clock.upperBoundMs) {
      return unknown('ORDER_BUTLER_CURRENT_DAY_COUNTER_REQUIRED');
    }
    const raw = scalar(row.tdyCnt), count = scalar(row.rTime) < officialDay.startMs ? 0 : raw;
    let offset = 0;
    if (id !== 105) {
      if (!current(order) || !knownOrderFlowerCell(order.value?.fields?.cTime)) return unknown('ORDER_BUTLER_GENERATED_ORDER_TIME_REQUIRED');
      const time = order.value.fields.cTime.value;
      if (time > clock.upperBoundMs) return unknown('ORDER_BUTLER_GENERATED_ORDER_TIME_IN_FUTURE');
      offset = time >= officialDay.startMs ? 1 : 0;
    }
    return { known: true, counterId: id, rawGenCount: raw, effectiveGenCount: count, finishedCount: Math.max(count - offset, 0),
      currentGeneratedOrderOffset: offset, uiDisplayCount: Math.max(count - (id === 105 ? 0 : 1), 0), rawRTime: scalar(row.rTime),
      meaning: 'official-client-stock-allocation-finished-count-projection-not-per-operation-settlement-proof',
      dayKey: officialDay.key ?? null, dayProofRef: officialDay.proofRef, source: clone(row.tdyCnt.source), originalCounterUnchanged: true };
  }
  const counters = { resident: counter(105), satin: counter(109, view.fields.satin), decorate: counter(116, view.fields.decorate) };
  const residentRows = current(residents) && residents.value?.complete === true && Array.isArray(residents.value.entries) ? residents.value.entries : null;
  const residentIds = residentRows?.map(row => row.value?.boxId);
  const residentMapKnown = residentIds && residentIds.every(id => positive(id) && id <= 6) && new Set(residentIds).size === residentIds.length;
  const settings = [
    { kind: 'resident', ids: residentMapKnown ? residentIds : [], cap: currentPolicy.maxFlowerOrder[0], cd: meta.$orderCd, max: meta.$dailyMax },
    { kind: 'satin', ids: [7], cap: currentPolicy.maxFlowerOrder[1], cd: meta.$orderCd2, max: meta.$dailyMax2 },
    { kind: 'decorate', ids: [8], cap: currentPolicy.maxFlowerOrder[2], cd: meta.$orderCd3, max: meta.$dailyMax3 }
  ];
  // Validate one actually provided row; absence is zero ONLY inside the valid
  // current complete stockMap. This says nothing about official concurrency.
  function raw(boxId) {
    const row = rawByBox.get(boxId);
    if (!row) return { known: true, num: 0, calc: null, maxTime: null, present: false, rawPresence: 'absent-in-provided-complete-map' };
    if (!knownOrderFlowerCell(row.domain) || !knownOrderFlowerCell(row.stockNum) || !nonnegative(row.stockNum.value)) return unknown('ORDER_BUTLER_EXPLICIT_STOCK_NUMBER_REQUIRED');
    const time = cell => cell?.presence === 'missing' || cell?.presence === 'null' ? null : knownOrderFlowerCell(cell) && positive(cell.value) ? cell.value : NaN;
    const calc = time(row.calcTime), maxTime = time(row.maxStockTime);
    return Number.isNaN(calc) || Number.isNaN(maxTime) ? unknown('ORDER_BUTLER_STOCK_TIME_UNREADABLE')
      : { known: true, num: row.stockNum.value, calc, maxTime, present: true, rawPresence: 'explicit-row',
        calcTimePresence: row.calcTime.presence, maxStockTimePresence: row.maxStockTime.presence };
  }
  const values = new Map(Array.from({ length: 8 }, (_, i) => [i + 1, raw(i + 1)]));
  for (const setting of settings) {
    const { kind, cap: configuredCap, cd, max } = setting, count = counters[kind];
    const dailyClamp = loginVersion.sourceProofs?.['order.butler-stock']?.matchedBlocks?.some(block =>
      block.name === 'butler-client-stock-accounting' && block.sha256 === '64b1e3eac6d24464e582d424bb35cd9080acbd91bd5fcc77d44ac2ad933260a6') === true;
    const cap = officialStoredStockCapacity({ kind, capacity: configuredCap, dailyLimit: max, counter: count, dailyClamp });
    const rowsKnown = setting.ids.every(id => values.get(id).known) && (kind !== 'resident' || residentMapKnown);
    const storedSum = rowsKnown ? setting.ids.reduce((sum, id) => sum + values.get(id).num, 0) : null,
      storedCount = nonnegative(storedSum) ? storedSum : null;
    daily[kind] = count.known && rowsKnown && storedCount !== null ? { ...count, storedCount, officialLimit: max,
      remainingForGeneration: Math.max(max - count.finishedCount - storedCount, 0),
      countRule: kind === 'resident' ? 'explicit105-finished' : 'gen-count-minus-current-order-created-this-client-day' }
      : { ...unknown(count.reasonCode || 'ORDER_BUTLER_RESIDENT_BOARD_REQUIRED_FOR_DAILY_ALLOCATION'), officialLimit: max, storedCount };
    function evaluateAt(time) {
      const endpoint = hire.known && hire.hired ? Math.min(time, hire.period.endMs) : null, output = {};
      const wants = setting.ids.map(id => {
        const value = values.get(id);
        return value.known && value.calc !== null && endpoint !== null ? Math.min(Math.max(0, Math.floor((endpoint - value.calc) / (cd * 1000))), Math.max(cap - value.num, 0)) : 0;
      });
      // _allocOrderStockDailyByWant is round-robin over integer box keys, not
      // greedy filling of the first resident box. Bounded <=6*70 iterations.
      const allocated = wants.map(() => 0);
      if (kind === 'resident' && daily[kind].known) {
        let remaining = daily[kind].remainingForGeneration;
        while (remaining > 0) {
          let advanced = false;
          for (let i = 0; i < wants.length && remaining > 0; i++) if (allocated[i] < wants[i]) { allocated[i]++; remaining--; advanced = true; }
          if (!advanced) break;
        }
      }
      for (let i = 0; i < setting.ids.length; i++) {
        const id = setting.ids[i], value = values.get(id);
        if (cap === null) { output[id] = unknown('ORDER_BUTLER_CURRENT_DAY_COUNTER_REQUIRED'); continue; }
        if (!value.known) { output[id] = value; continue; }
        if (!value.present || value.calc === null) { output[id] = { known: true, num: Math.max(0, Math.min(value.num, cap)), added: 0, calc: value.calc, maxTime: value.maxTime }; continue; }
        if (!hire.known) { output[id] = unknown(hire.reasonCode || 'ORDER_BUTLER_HIRE_NOT_OBSERVED'); continue; }
        if (!hire.hired) { output[id] = { known: true, num: Math.max(0, Math.min(value.num, cap)), added: 0, calc: value.calc, maxTime: value.maxTime }; continue; }
        if (kind === 'resident' && !daily[kind].known) { output[id] = unknown(daily[kind].reasonCode); continue; }
        if (kind !== 'resident') {
          const added = Math.max(0, Math.floor((endpoint - value.calc) / (cd * 1000)));
          output[id] = { known: true, num: Math.max(0, Math.min(value.num + added, cap)), added: Math.max(0, Math.min(value.num + added, cap) - value.num), calc: value.calc, maxTime: value.maxTime };
          continue;
        }
        const periods = Math.floor((endpoint - value.calc) / (cd * 1000)), capacity = Math.max(cap - value.num, 0),
          hasAllocation = wants[i] > 0, added = hasAllocation ? Math.min(Math.max(periods, 0), allocated[i], capacity) : 0;
        // Client M() overrides pause to ONLY (dailyLeft<=0), deliberately not
        // the helper's default allocatedSum>=dailyLeft pause flag.
        const pause = hasAllocation && daily[kind].remainingForGeneration <= 0;
        if (hasAllocation && allocated[i] <= 0 && !pause) {
          // _calcOneOrderStock returns before recalculating either timestamp
          // when this box received no quota but the shared day is not paused.
          output[id] = { known: true, num: value.num, added: 0, calc: value.calc, maxTime: value.maxTime };
          continue;
        }
        let calc = value.calc;
        if (pause) calc = officialDay.endMs - cd * 1000;
        else if (periods > 0) calc += (hasAllocation && added < periods && added < capacity ? added : periods) * cd * 1000;
        output[id] = { known: true, num: value.num + added, added, calc, maxTime: calc + Math.max(cap - value.num - added, 0) * cd * 1000 };
      }
      return output;
    }
    const low = evaluateAt(clock.lowerBoundMs), high = evaluateAt(clock.upperBoundMs);
    for (const id of setting.ids) {
      const original = values.get(id), left = low[id], right = high[id], exact = left?.known && right?.known && canonical(left) === canonical(right),
        next = original.known && original.calc !== null && hire.known && hire.hired && (left?.num ?? cap) < cap
          ? original.calc + (Math.floor(Math.max(0, clock.upperBoundMs - original.calc) / (cd * 1000)) + 1) * cd * 1000 : null;
      const body = { boxId: id, kind, known: !!exact, reasonCode: exact ? null : left?.reasonCode || right?.reasonCode || 'ORDER_BUTLER_CLOCK_INTERVAL_CROSSES_STOCK_TICK',
        rawStockNum: original.known ? original.num : null, rawRowPresent: original.known ? original.present : null,
        rawPresence: original.rawPresence || null, rawCalcTime: original.known ? original.calc : null, rawMaxStockTime: original.known ? original.maxTime : null,
        effectiveStockNum: exact ? left.num : null, generatedSinceSnapshot: exact ? left.added : null,
        calcTime: exact ? left.calc : null, maxStockTime: exact ? left.maxTime : null,
        nextChangeAt: positive(next) && next < officialDay.endMs && next < (hire.period?.endMs ?? Infinity) ? next : null,
        capacity: cap, cdSeconds: cd, branch: exact ? left.num > 0 ? 'stored' : 'ordinary' : 'unknown',
        source: clone(stocks.source), hireProofRef: hire.known ? 'order-butler-hire:' + fingerprint(hire) : null,
        ordinaryDeliveryStillRequiresFlowers: true, rawMapFingerprint: fingerprint(stocks.value) };
      boxes[id] = { ...body, basisRef: 'order-butler-box:' + fingerprint(body) };
    }
    if (kind === 'resident' && !residentMapKnown) dependencies.push('105.0.1-current-complete-resident-map');
    if (!count.known) dependencies.push('7.4.' + (kind === 'resident' ? 105 : kind === 'satin' ? 109 : 116) + '-current-day-counter');
  }
  // A resident key not actually in the normal complete board is not an order
  // candidate; do not invent a six-box order/stock lifecycle to fill it.
  return finish(null);
}
