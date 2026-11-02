// R10 recovery-boundary counterexamples. Isolated database only: no real server,
// account, emulator or network request is created here.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createRewardRuntime } from '../runtime/backend/features/rewards/runtime.mjs';
import { classifyOfficialRefusal, OFFICIAL_REFUSAL_TEXT, METHOD_REFUSALS, refusalCodeSet } from '../runtime/backend/features/rewards/rejection.mjs';

const DAY_START = Date.UTC(2026, 10, 1, 16, 0, 0);
const DAY_END = DAY_START + 86400000;
const DAY = Object.freeze({ key: '2026-11-02', startMs: DAY_START, endMs: DAY_END });
const NEXT_DAY = Object.freeze({ key: '2026-11-03', startMs: DAY_START + 86400000, endMs: DAY_START + 2 * 86400000 });
const UID = 42030917102202;
const CONTEXT = Object.freeze({ ownerRef: 'owner-r10b', accountRef: 'account-r10b', subjectRef: 'subject-r10b',
  ownerEpoch: 1, runEpoch: 7, connectionEpoch: 3 });

function tempStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-reward-boundaries-'));
  return { root, store: openBackendStore({ dataDir: root }) };
}

const TABLES = {
  c_task_dly: { '-1': { $boxes: [[30], [60]] } },
  c_task_week: { '-1': {} },
  c_shop_cultivate: { 10004: { bLimit: [5], unlock_lvl: 1 }, 10005: { bLimit: [5], unlock_lvl: 1 } },
  c_shop_giftbag: { 1: { shareId: 21, dLimit: [3], cd: 0 } },
  c_share: { 21: { limit: 5 }, 11: { limit: 5 } },
  c_storyMainChapter: { 41: { sectionId: [501, 502, 503] } },
  c_storyMainSection: { 503: { cost: [[7, 5]] } },
};

function harness(store, { values, sources = null, nowMs = DAY_START + 3600000, day = DAY, tables = TABLES } = {}) {
  const world = { values, sources, nowMs, day };
  const runtime = createRewardRuntime({
    store,
    facts: { read: () => world.values ? { current: true, values: world.values, sources: world.sources ?? {},
      fingerprint: 'facts-' + JSON.stringify(world.values) } : { current: false } },
    clock: () => ({ available: true, connectionEpoch: CONTEXT.connectionEpoch, nowMs: world.nowMs }),
    officialDay: () => (world.day ? { current: true, ...world.day } : { current: false }),
    extensionForContext: () => ({ bundleRef: 'bundle-1', loginResponseRef: 'login-1' }),
    tablesForContext: () => ({ tables, tableHashes: {}, dataSnapshotId: 'snap-1' }),
    dynamicState: { snapshot: () => ({}) },
    ledgerView: { currentAdmission: () => ({ activeOperation: null, unresolvedOperations: [], resourceFootprints: [], bases: [] }),
      operation: () => null },
    resources: { balance: () => ({ base: { known: true, value: 100000, source: { responseRef: 'res-1' } }, basisRef: 'basis-1' }),
      currencyReservationSpec: ({ amount, currency, memberKey, lifecycleRef }) => ({ resourceKey: 'currency-reservation:' + memberKey,
        resourceKind: 'currency', resourceRef: 'currency:' + currency, basisRef: 'currency-basis-1',
        accountingRef: 'currency-accounting:' + memberKey, quantity: amount, lifecycleRef }) },
    isCurrent: () => true,
    readConfiguration: () => ({ savedRevision: 3, featureCancelEpochs: {} }),
    readProfile: () => ({ uid: UID, gold: 100000, level: 30 }),
    readBag: () => ({ items: { 7: 100 } }),
    appendOutbox: () => {},
  });
  const config = {
    'reward.free-gift': { freeYuanbaoGift: { enabled: true } },
    'cultivate.shop': { materialShop: { enabled: true, freeRefresh: true, maxBuyPerMinute: 3, keepGold: 0 } },
    'reward.daily-task': { dailyTaskRewards: { enabled: true } },
    'reward.daily-box': { dailyTaskBox: { enabled: true } },
    'reward.main-story': { mainStory: { enabled: true, maxUnlocksPerDay: 1 } },
  };
  const assess = (featureId, scheduleKey) => {
    const feature = runtime.features.find(one => one.featureId === featureId);
    const unit = feature.scheduleUnits.find(one => one.scheduleKey === scheduleKey);
    return unit.assess({ context: CONTEXT, scheduleKey,
      config: { savedRevision: 3, featureCancelEpochs: { [featureId]: 0 }, config: config[featureId] } });
  };
  return { runtime, world, assess,
    assessGift: () => assess('reward.free-gift', 'free-gift-share'),
    assessShop: () => assess('cultivate.shop', 'shop-buy'),
    assessDaily: () => assess('reward.daily-task', 'daily-task-recv'),
    assessBox: () => assess('reward.daily-box', 'daily-box-recv'),
    assessStory: () => assess('reward.main-story', 'story-unlock') };
}

function settleUnknown(runtime, proposal) {
  runtime.onSettled({ proposal, operation: { operation_id: proposal.operationId, transport_state: 'answered' },
    verification: { verdict: 'unknown', reasonCode: 'PROTOCOL_RPC_TIMEOUT',
      evidence: { targetRef: proposal.targets[0].targetRef, targetKey: proposal.reward.targetKey } } });
}

function giftValues({ used = 0, resetMs = DAY_START, buyTime = null } = {}) {
  return { 'reward-giftbag': { present: true, dRecord: { 1: used }, buyTimeRecord: buyTime === null ? {} : { 1: buyTime },
    rTime: resetMs }, 'reward-share': { present: true, shares: {} } };
}

function shopValues({ generation = 0, offers = [{ shopId: 10004, bought: 0, costItemId: 11, price: 10 }] } = {}) {
  return { 'reward-shop': { present: true, refreshCount: generation, offers } };
}

function dailyTaskValues({ recvMap = {}, score = 0, boxes = [], progress = {} } = {}) {
  return { 'reward-tasks': { daily: { taskMap: [{ taskId: 30250001, status: 1, targetCount: 1, finishCount: 0 }],
    progress, recvMap, score, boxes, malformed: false }, weekly: null, main: null } };
}

function storyValues({ chapter = 41, sectionIdx = 2 } = {}) {
  return { 'reward-story': { present: true, readable: true, chapter, sectionIdx } };
}

const refusedReply = ({ method, remoteCode, noticeOnly = false }) => ({ transport: 'answered', method, envelopeOk: true,
  dsName: 'G.ISyncData', rejected: true, noticeOnly, remoteCode, remoteKey: null, responseRef: 'official-response:refused-1',
  wireKey: 'ws|1|5', requestSequence: 5, connectionEpoch: CONTEXT.connectionEpoch, sentDeviceMs: 1000, receivedDeviceMs: 1200 });

// ---- the refusal contract itself ---------------------------------------------

test('every refusal code still carries its exact vendored official text', () => {
  const table = JSON.parse(fs.readFileSync(new URL('../vendor/garden-engine/server/data/official-cfg/c_msgCode.json',
    import.meta.url), 'utf8'));
  for (const [code, text] of Object.entries(OFFICIAL_REFUSAL_TEXT)) {
    assert.equal(table[code]?.text, text, 'official text drifted for msg code ' + code);
  }
  // Every code the per-method tables accept has a text and belongs to that method.
  for (const [method, table_] of Object.entries(METHOD_REFUSALS)) {
    const codes = [...(table_.consumed || []), ...(table_.refused || [])];
    assert.ok(codes.length > 0, method + ' declares no codes');
    for (const code of codes) assert.ok(OFFICIAL_REFUSAL_TEXT[code], method + ' uses unexplained code ' + code);
    assert.deepEqual([...refusalCodeSet(method)].sort((a, b) => a - b), [...new Set(codes)].sort((a, b) => a - b));
  }
});

test('only an answered, method-owned official code becomes a refusal exit', () => {
  const base = refusedReply({ method: 'taskDly.recv', remoteCode: 251 });
  assert.equal(classifyOfficialRefusal({ method: 'taskDly.recv', response: base })?.class, 'consumed');
  // A notice is a presentation, not a business verdict.
  assert.equal(classifyOfficialRefusal({ method: 'taskDly.recv', response: { ...base, noticeOnly: true, remoteCode: null } }), null);
  // A bare rejected flag without a documented code proves nothing.
  assert.equal(classifyOfficialRefusal({ method: 'taskDly.recv', response: { ...base, remoteCode: null } }), null);
  // An unmapped code proves nothing.
  assert.equal(classifyOfficialRefusal({ method: 'taskDly.recv', response: { ...base, remoteCode: 999999 } }), null);
  // A transport failure is not an answer.
  assert.equal(classifyOfficialRefusal({ method: 'taskDly.recv', response: { ...base, transport: 'unknown' } }), null);
  // The same code is meaningless for a method whose business object it does not name.
  assert.equal(classifyOfficialRefusal({ method: 'shopCultivate.buy', response: refusedReply({ method: 'shopCultivate.buy', remoteCode: 251 }) }), null);
  // A reply bound to another method is never borrowed.
  assert.equal(classifyOfficialRefusal({ method: 'taskDly.recv', response: { ...base, method: 'shopCultivate.buy' } }), null);
  // A string key has no verified official wording yet.
  assert.equal(classifyOfficialRefusal({ method: 'taskDly.recv', response: { ...base, remoteCode: null, remoteKey: 'some_key' } }), null);
  assert.equal(classifyOfficialRefusal({ method: 'shopCultivate.refresh', response: refusedReply({ method: 'shopCultivate.refresh', remoteCode: 306 }) })?.class, 'refused');
});

test('a consumed refusal releases the footprint, blocks only its own target and never credits', async () => {
  const { store } = tempStore();
  const h = harness(store, { values: dailyTaskValues() });
  const proposal = h.assessDaily().proposals[0];
  const feature = h.runtime.features.find(one => one.featureId === 'reward.daily-task');
  const verification = await feature.verify({ proposal, response: refusedReply({ method: proposal.method, remoteCode: 251 }) });
  assert.equal(verification.verdict, 'rejected');
  assert.equal(verification.rejection.msgCode, 251);
  assert.equal(verification.rejectionClass, 'consumed');
  h.runtime.onSettled({ proposal, operation: { operation_id: proposal.operationId, transport_state: 'answered' }, verification });
  const row = store.get(`SELECT * FROM backend_reward_claims WHERE claim_key=?`, proposal.reward.targetKey);
  assert.equal(row.state, 'rejected-consumed');
  assert.equal(row.operation_id, proposal.operationId, 'the refusing operation stays attached');
  assert.equal(store.all('SELECT * FROM backend_reward_period_usage').length, 0, 'a refusal never charges quota');
  const next = h.assessDaily();
  assert.equal(next.state, 'waiting-until');
  assert.equal(next.reasonCode, 'REWARD_TARGET_CONSUMED_BY_OFFICIAL');
  // A queued proposal drafted before the answer cannot slip past admission.
  const queued = { ...proposal, operationId: 'queued-after-refusal' };
  const decision = h.runtime.evaluateAdmission({ proposal: queued, actor: CONTEXT, factBasis: proposal.factBasis });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, 'REWARD_TARGET_CONSUMED_BY_OFFICIAL');
});

test('a consumed refusal closes only its own day, never the card', async () => {
  const { store } = tempStore();
  const h = harness(store, { values: dailyTaskValues() });
  const proposal = h.assessDaily().proposals[0];
  const feature = h.runtime.features.find(one => one.featureId === 'reward.daily-task');
  const verification = await feature.verify({ proposal, response: refusedReply({ method: proposal.method, remoteCode: 335 }) });
  h.runtime.onSettled({ proposal, operation: { operation_id: proposal.operationId, transport_state: 'answered' }, verification });
  // Same official day: the exact opportunity is closed.
  assert.equal(h.assessDaily().reasonCode, 'REWARD_TARGET_CONSUMED_BY_OFFICIAL');
  // Next official day is a new opportunity with its own key and must advance.
  h.world.day = NEXT_DAY;
  h.world.nowMs = NEXT_DAY.startMs + 3600000;
  const next = h.assessDaily();
  assert.equal(next.state, 'proposals');
  assert.equal(next.proposals[0].reward.targetKey, 'daily:30250001:2026-11-03');
});

test('a precondition refusal backs off briefly and leaves other slots free', async () => {
  const { store } = tempStore();
  const h = harness(store, { values: shopValues({ offers: [{ shopId: 10004, bought: 0, costItemId: 11, price: 10 },
    { shopId: 10005, bought: 0, costItemId: 11, price: 20 }] }) });
  const first = h.assessShop().proposals[0];
  assert.equal(first.reward.targetKey, 'buy:10004:0:r0');
  const feature = h.runtime.features.find(one => one.featureId === 'cultivate.shop');
  const verification = await feature.verify({ proposal: first, response: refusedReply({ method: first.method, remoteCode: 204 }) });
  assert.equal(verification.verdict, 'rejected');
  assert.equal(verification.rejectionClass, 'refused');
  h.runtime.onSettled({ proposal: first, operation: { operation_id: first.operationId, transport_state: 'answered' }, verification });
  assert.equal(store.get(`SELECT state FROM backend_reward_claims WHERE claim_key='buy:10004:0:r0'`).state, 'rejected-refused');
  // The refused slot waits, the unrelated slot keeps working in the same assess.
  const next = h.assessShop();
  assert.equal(next.state, 'proposals');
  assert.equal(next.proposals[0].reward.targetKey, 'buy:10005:0:r0');
  // After the bounded backoff the same slot is proposed again.
  store.run(`UPDATE backend_reward_claims SET updated_at=? WHERE claim_key='buy:10004:0:r0'`,
    new Date(Date.now() - 11 * 60 * 1000).toISOString());
  const after = harness(store, { values: shopValues({ offers: [{ shopId: 10004, bought: 0, costItemId: 11, price: 10 }] }) }).assessShop();
  assert.equal(after.state, 'proposals');
  assert.equal(after.proposals[0].reward.targetKey, 'buy:10004:0:r0');
});

// ---- cross-day late free gift -------------------------------------------------

test('a free gift unknown on the old day never overlaps the next day opportunity', () => {
  const { store } = tempStore();
  const h = harness(store, { values: giftValues({ used: 2 }) });
  const first = h.assessGift().proposals[0];
  assert.equal(first.reward.targetKey, 'gift:1:2026-11-02:2');
  settleUnknown(h.runtime, first);
  const row = store.get(`SELECT * FROM backend_reward_claims WHERE claim_key=?`, first.reward.targetKey);
  assert.equal(row.hold_scope, 'gift:1', 'the hold follows the wire target, not the local day');
  // Official day changes and the day counter legitimately resets: the old unknown
  // must still block the same shop's equivalent write.
  h.world.day = NEXT_DAY;
  h.world.nowMs = NEXT_DAY.startMs + 3600000;
  h.world.values = giftValues({ used: 0, resetMs: NEXT_DAY.startMs, buyTime: null });
  const next = h.assessGift();
  assert.equal(next.state, 'waiting-facts');
  assert.equal(next.reasonCode, 'REWARD_GIFT_PRIOR_UNKNOWN_REQUIRES_TARGET_PROOF');
  assert.equal(next.unresolvedClaimKey, 'gift:1:2026-11-02:2');
  assert.ok(!next.proposals, 'no equivalent write for the same shop row');
});

test('a late landing on the next day closes the hold and the card continues', () => {
  const { store } = tempStore();
  const h = harness(store, { values: giftValues({ used: 2 }) });
  const first = h.assessGift().proposals[0];
  settleUnknown(h.runtime, first);
  store.run(`UPDATE backend_reward_claims SET updated_at=?, before_json=? WHERE claim_key=?`,
    new Date(Date.now() - 120000).toISOString(),
    JSON.stringify({ shopId: 1, shareId: 21, used: 2, lastBuy: null, dayKey: '2026-11-02' }), 'gift:1:2026-11-02:2');
  // The old request landed after the day changed: dRecord resets, buyTimeRecord
  // moves past the recorded purchase.
  h.world.day = NEXT_DAY;
  h.world.nowMs = NEXT_DAY.startMs + 3600000;
  h.world.values = giftValues({ used: 1, resetMs: NEXT_DAY.startMs, buyTime: NEXT_DAY.startMs + 600000 });
  h.world.sources = { 'reward-giftbag': { responseRef: 'login-gift-next-day', requestSequence: 40,
    connectionEpoch: CONTEXT.connectionEpoch, receivedDeviceMs: Date.now(), method: 'index.login' } };
  h.assessGift();
  const row = store.get(`SELECT state,achieved_ref FROM backend_reward_claims WHERE claim_key='gift:1:2026-11-02:2'`);
  assert.equal(row.state, 'unknown-achieved');
  assert.equal(row.achieved_ref, 'login-gift-next-day');
  // The card is not closed: the remaining daily allowance is a real opportunity.
  const next = h.assessGift();
  assert.equal(next.state, 'proposals');
  assert.equal(next.proposals[0].reward.targetKey, 'gift:1:2026-11-03:1');
});

test('a stale free gift proposal is refused when the official day moved', () => {
  const { store } = tempStore();
  const h = harness(store, { values: giftValues({ used: 1 }) });
  const proposal = h.assessGift().proposals[0];
  h.world.day = NEXT_DAY;
  h.world.nowMs = NEXT_DAY.startMs + 3600000;
  h.world.values = giftValues({ used: 0, resetMs: NEXT_DAY.startMs });
  const staleBasis = h.runtime.evaluateAdmission({ proposal, actor: CONTEXT, factBasis: proposal.factBasis });
  assert.equal(staleBasis.allowed, false, 'a proposal drafted on the old day cannot be sent');
  // With a basis re-read from the new day, admission must still reject it on the
  // business opportunity itself, not only on the stale fact basis.
  const currentBasis = h.runtime.readFactBasis({ proposal, actor: CONTEXT });
  const decision = h.runtime.evaluateAdmission({ proposal, actor: CONTEXT, factBasis: currentBasis });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, 'REWARD_OPPORTUNITY_CHANGED');
});

// ---- cross-generation late purchase -------------------------------------------

test('a late purchase cannot be re-sent into the next shelf generation', () => {
  const { store } = tempStore();
  const h = harness(store, { values: shopValues() });
  const first = h.assessShop().proposals[0];
  assert.equal(first.reward.targetKey, 'buy:10004:0:r0');
  settleUnknown(h.runtime, first);
  assert.equal(store.get(`SELECT hold_scope FROM backend_reward_claims WHERE claim_key='buy:10004:0:r0'`).hold_scope, 'buy:10004');
  // Free refresh re-rolls the shelf: the same slot now sells a different item at
  // a different price, and a second slot appears.
  h.world.values = shopValues({ generation: 1, offers: [
    { shopId: 10004, bought: 0, costItemId: 11, price: 40 },
    { shopId: 10005, bought: 0, costItemId: 11, price: 15 }] });
  const next = h.assessShop();
  assert.equal(next.state, 'proposals');
  assert.equal(next.proposals[0].reward.targetKey, 'buy:10005:0:r1', 'the unrelated slot still buys');
  const same = harness(store, { values: shopValues({ generation: 1, offers: [
    { shopId: 10004, bought: 0, costItemId: 11, price: 40 }] }) }).assessShop();
  assert.equal(same.state, 'waiting-facts');
  assert.equal(same.reasonCode, 'REWARD_SHOP_PRIOR_UNKNOWN_REQUIRES_TARGET_PROOF', 'the old shopId request still owns its shelf slot');
});

test('a late purchase landing in the new generation is never counted as the old write', () => {
  const { store } = tempStore();
  const h = harness(store, { values: shopValues() });
  const first = h.assessShop().proposals[0];
  settleUnknown(h.runtime, first);
  h.world.values = shopValues({ generation: 1, offers: [{ shopId: 10004, bought: 1, costItemId: 11, price: 40 }] });
  h.world.sources = { 'reward-shop': { responseRef: 'login-shop-gen1', requestSequence: 50,
    connectionEpoch: CONTEXT.connectionEpoch, receivedDeviceMs: Date.now(), method: 'index.login' } };
  h.assessShop();
  const row = store.get(`SELECT state,achieved_ref FROM backend_reward_claims WHERE claim_key='buy:10004:0:r0'`);
  assert.equal(row.state, 'unknown-held', 'a new-generation counter says nothing about the old write');
  assert.equal(row.achieved_ref, null);
});

test('a proposal drafted before a shelf refresh cannot be sent into it', () => {
  const { store } = tempStore();
  const h = harness(store, { values: shopValues() });
  const proposal = h.assessShop().proposals[0];
  h.world.values = shopValues({ generation: 1, offers: [{ shopId: 10004, bought: 0, costItemId: 11, price: 40 }] });
  const staleBasis = h.runtime.evaluateAdmission({ proposal, actor: CONTEXT, factBasis: proposal.factBasis });
  assert.equal(staleBasis.allowed, false, 'a proposal drafted in the old generation cannot be sent');
  const currentBasis = h.runtime.readFactBasis({ proposal, actor: CONTEXT });
  const decision = h.runtime.evaluateAdmission({ proposal, actor: CONTEXT, factBasis: currentBasis });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, 'REWARD_OPPORTUNITY_CHANGED');
});

// ---- the other card recovery differences --------------------------------------

test('a daily box claim is confirmed by the claimed tier list, not by a task receipt', () => {
  const { store } = tempStore();
  const h = harness(store, { values: dailyTaskValues({ score: 40 }) });
  const proposal = h.assessBox().proposals[0];
  assert.equal(proposal.reward.action, 'recv');
  assert.equal(proposal.reward.before.idx, 0);
  settleUnknown(h.runtime, proposal);
  store.run(`UPDATE backend_reward_claims SET updated_at=? WHERE claim_key=?`,
    new Date(Date.now() - 120000).toISOString(), proposal.reward.targetKey);
  h.world.values = dailyTaskValues({ score: 40, boxes: [0] });
  h.world.sources = { 'reward-tasks': { responseRef: 'login-daily-box', requestSequence: 60,
    connectionEpoch: CONTEXT.connectionEpoch, receivedDeviceMs: Date.now(), method: 'index.login' } };
  h.assessBox();
  const row = store.get(`SELECT state FROM backend_reward_claims WHERE claim_key=?`, proposal.reward.targetKey);
  assert.equal(row.state, 'unknown-achieved', 'the tier list is the only post state for this action');
});

test('a story proposal is re-checked against the official chapter before send', () => {
  const { store } = tempStore();
  const h = harness(store, { values: storyValues() });
  const proposal = h.assessStory().proposals[0];
  assert.equal(proposal.reward.action, 'unlock');
  h.world.values = storyValues({ sectionIdx: 3 });
  const staleBasis = h.runtime.evaluateAdmission({ proposal, actor: CONTEXT, factBasis: proposal.factBasis });
  assert.equal(staleBasis.allowed, false, 'a story proposal cannot outlive its chapter state');
  const currentBasis = h.runtime.readFactBasis({ proposal, actor: CONTEXT });
  const decision = h.runtime.evaluateAdmission({ proposal, actor: CONTEXT, factBasis: currentBasis });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, 'REWARD_OPPORTUNITY_CHANGED');
});