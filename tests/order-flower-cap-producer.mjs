import assert from 'node:assert/strict';
import test from 'node:test';
import { orderFlowerContextKey } from '../runtime/backend/features/order-flower/wire-facts.mjs';
import { planOrderFlowerStock } from '../runtime/backend/features/order-flower/planning.mjs';
import { orderFlowerDailyCapSuspension } from '../runtime/backend/features/order-flower/runtime.mjs';
import { createOfficialOrderFlowerCatalog } from '../runtime/backend/features/order-flower/catalog.mjs';

const context = Object.freeze({ ownerRef: 'fixture:owner', accountRef: '71', subjectRef: 'fixture:subject',
  ownerEpoch: 1, runEpoch: 1, connectionEpoch: 1 });
const catalog = createOfficialOrderFlowerCatalog();
const dayStart = Date.UTC(2026, 9, 26), clock = { available: true, source: 'official-anchor-monotonic',
  connectionEpoch: 1, nowMs: dayStart + 1000, lowerBoundMs: dayStart + 900, upperBoundMs: dayStart + 1100 };
const officialDay = { known: true, key: 'fixture:official-day', startMs: dayStart, endMs: dayStart + 86400000,
  proofRef: 'fixture:day-proof' };
const source = (sequence, method = 'index.login') => ({ contextKey: orderFlowerContextKey(context), kind: 'response',
  transport: 'answered', connectionEpoch: 1, requestSequence: sequence, responseRef: 'fixture:response:' + sequence,
  method, version: { gameVersion: '480.0.27', protocolVersion: '480.0.0', loginResponseRef: 'fixture:response:1' }, serverMs: dayStart + 500 });
const cell = (value, sequence = 1, method = 'index.login', extra = {}) => ({ presence: 'present', state: 'known', value,
  current: true, source: { ...source(sequence, method), ...extra } });
function fixture({ counter = 1, day = officialDay, localLimit = 1 } = {}) {
  const counterSource = source(1);
  const row = { domain: cell(null), uid: cell(71), type: cell(105), tdyCnt: cell(counter, 1, 'index.login', { serverMs: dayStart + 500 }),
    totCnt: cell(10), rTime: cell(dayStart + 600), uTime: cell(dayStart + 600), cTime: cell(dayStart + 100) };
  for (const key of Object.keys(row)) row[key].source = { ...counterSource, ...row[key].source };
  const view = { current: true, available: true, context, identity: { verified: true, uid: cell(71) }, domain: cell(null),
    counters: { 105: row }, fields: {}, financial: {}, shares: {}, adCard: {} };
  const config = { config: { orders: { resident: { enabled: true, dailyLimit: localLimit }, satin: { enabled: false, dailyLimit: 0 },
    decorate: { enabled: false, dailyLimit: 0 } } }, savedRevision: 4 };
  const eligibility = { resident: { known: true, value: true, context, officialUid: 71, openId: 'sys_orderFlower', proofRef: 'fixture:open' } };
  return { view, config, eligibility, day };
}
function plan(options) {
  const f = fixture(options);
  return planOrderFlowerStock({ context, view: f.view, config: f.config, catalog, resources: { budget: () => ({ known: true, allowed: true }) },
    eligibility: f.eligibility, clock, officialDay: f.day });
}

test('real order-flower planner output produces local and catalog-backed official cap suspensions', () => {
  const local = plan({ counter: 1, localLimit: 1 });
  const exhausted = local.entries.find(row => row.kind === 'resident');
  assert.equal(exhausted.reasonCode, 'ORDER_FLOWER_DAILY_LIMIT_REACHED');
  const localSuspension = orderFlowerDailyCapSuspension({ kind: 'resident', exhausted, officialDay, clock, catalog,
    config: { orders: { resident: { dailyLimit: 1 } } }, configRevision: 4 });
  assert.equal(localSuspension.state, 'cap-wait');
  assert.equal(localSuspension.suspension.scope, 'local');
  assert.equal(localSuspension.suspension.periodKind, 'official-day');
  assert.equal(localSuspension.suspension.proofRefs.includes('fixture:day-proof'), true);

  const definition = catalog.definition('resident');
  const officialPlan = plan({ counter: definition.officialDailyLimit, localLimit: 0 });
  const officialEntry = officialPlan.entries.find(row => row.kind === 'resident');
  const officialSuspension = orderFlowerDailyCapSuspension({ kind: 'resident', exhausted: officialEntry, officialDay, clock, catalog,
    config: { orders: { resident: { dailyLimit: 0 } } }, configRevision: 4 });
  assert.equal(officialSuspension.suspension.scope, 'official');
  assert.equal(officialSuspension.suspension.policySource.gameVersion, '480.0.27');
  assert.equal(officialSuspension.suspension.policySource.officialLimit, definition.officialDailyLimit);
});

test('missing official day or current counter stays waiting-facts and cannot become a cap', () => {
  const missingDay = plan({ counter: 1, day: { known: false }, localLimit: 1 });
  assert.equal(missingDay.entries.find(row => row.kind === 'resident').state, 'waiting-facts');
  assert.equal(orderFlowerDailyCapSuspension({ kind: 'resident', exhausted: missingDay.entries[0], officialDay: { known: false },
    clock, catalog, config: { orders: { resident: { dailyLimit: 1 } } }, configRevision: 4 }), null);

  const missingCounter = fixture({ counter: 1, localLimit: 1 });
  missingCounter.view.counters[105].tdyCnt = { presence: 'missing', state: 'unobserved', value: null };
  const planResult = planOrderFlowerStock({ context, view: missingCounter.view, config: missingCounter.config, catalog,
    resources: { budget: () => ({ known: true, allowed: true }) }, eligibility: missingCounter.eligibility, clock, officialDay });
  const entry = planResult.entries.find(row => row.kind === 'resident');
  assert.equal(entry.state, 'waiting-facts');
  assert.equal(orderFlowerDailyCapSuspension({ kind: 'resident', exhausted: entry, officialDay, clock, catalog,
    config: missingCounter.config.config, configRevision: 4 }), null);
});

test('a normally matched non-login sync can refresh the current daily counter without changing the login identity anchor', () => {
  const current = fixture({ counter: 1, localLimit: 0 });
  const heartbeat = source(2, 'usr.heartTick');
  current.view.counters[105].tdyCnt.source = heartbeat;
  const planned = planOrderFlowerStock({ context, view: current.view, config: current.config, catalog,
    resources: { budget: () => ({ known: true, allowed: true }) }, eligibility: current.eligibility, clock, officialDay: current.day });
  const entry = planned.entries.find(row => row.kind === 'resident');
  assert.equal(entry.count.known, true);
  assert.equal(entry.count.source.method, 'usr.heartTick');
  assert.equal(entry.count.cellProofs.tdyCnt.source.responseRef, heartbeat.responseRef);
  assert.equal(entry.count.cellProofs.uid.source.responseRef, 'fixture:response:1', 'unmodified cells retain their original login provenance');
  assert.equal(current.view.identity.uid.source.method, 'index.login', 'stable identity remains anchored to the admitted login');
});

test('a video-only quota result cannot become a whole-feature daily cap', () => {
  const videoOnly = { state: 'no-action', reasonCode: 'ORDER_FLOWER_VIDEO_DAILY_QUOTA_EXHAUSTED',
    videoQuota: { known: true, effectiveRecvCnt: 6, limit: 6 } };
  assert.equal(orderFlowerDailyCapSuspension({ kind: 'resident', exhausted: videoOnly, officialDay, clock, catalog,
    config: { orders: { resident: { dailyLimit: 0 } } }, configRevision: 4 }), null);
});
