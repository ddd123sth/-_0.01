// R10 unknown-dedup fix: an unresolved reward write is held by its business
// opportunity, not by elapsed local time. These are admission counterexamples on
// an isolated database; no real server, account or emulator is touched.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createBackendLedger } from '../runtime/backend/persistence/ledger.mjs';
import { createRewardRuntime } from '../runtime/backend/features/rewards/runtime.mjs';
import { assertClaimProposal } from '../runtime/backend/features/rewards/rpc-contract.mjs';

const DAY_START = Date.UTC(2026, 10, 1, 16, 0, 0);
const DAY_END = DAY_START + 86400000;
const UID = 42030917102202;
const CONTEXT = Object.freeze({ ownerRef: 'owner-r10', accountRef: 'account-r10', subjectRef: 'subject-r10',
  ownerEpoch: 1, runEpoch: 7, connectionEpoch: 3 });

function tempStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-reward-unknown-'));
  return { root, store: openBackendStore({ dataDir: root }) };
}

function dailyTaskValues({ recvMap = {}, taskIds = [30250001] } = {}) {
  return { 'reward-tasks': { daily: { taskMap: taskIds.map(taskId => ({ taskId, status: 1, targetCount: 1, finishCount: 0 })),
    progress: {}, recvMap, score: 0, boxes: [], malformed: false }, weekly: null, main: null } };
}

function harness(store, { values, sources = null, tables: suppliedTables = null, nowMs = DAY_START + 3600000,
  ledgerView = null, day = null } = {}) {
  const world = { values, sources, nowMs, day: day || { key: '2026-11-02', startMs: DAY_START, endMs: DAY_END } };
  const tables = suppliedTables ?? { c_task_dly: { '-1': {}, 30250001: { type: 1 }, 30250002: { type: 1 } },
    c_task_week: { '-1': {} }, c_shop_cultivate: { 10004: { bLimit: [5], unlock_lvl: 1 } } };
  const runtime = createRewardRuntime({
    store,
    facts: { read: () => world.values ? { current: true, values: world.values, sources: world.sources ?? {},
      fingerprint: 'facts-' + JSON.stringify(world.values) } : { current: false } },
    clock: () => ({ available: true, connectionEpoch: CONTEXT.connectionEpoch, nowMs: world.nowMs }),
    officialDay: () => ({ current: true, key: world.day.key, startMs: world.day.startMs, endMs: world.day.endMs }),
    extensionForContext: () => ({ bundleRef: 'bundle-1', loginResponseRef: 'login-1' }),
    tablesForContext: () => ({ tables, tableHashes: { c_task_dly: 'h1' }, dataSnapshotId: 'snap-1' }),
    dynamicState: { snapshot: () => ({}) },
    ledgerView: ledgerView ?? { currentAdmission: () => ({ activeOperation: null, unresolvedOperations: [], resourceFootprints: [], bases: [] }),
      operation: () => null },
    resources: { balance: () => ({ base: { known: true, value: 100000, source: { responseRef: 'res-1' } }, basisRef: 'basis-1' }),
      currencyReservationSpec: ({ amount, currency, memberKey, lifecycleRef }) => ({ resourceKey: 'currency-reservation:' + memberKey,
        resourceKind: 'currency', resourceRef: 'currency:' + currency, basisRef: 'currency-basis-1',
        accountingRef: 'currency-accounting:' + memberKey, quantity: amount, lifecycleRef }) },
    isCurrent: () => true,
    readConfiguration: () => ({ savedRevision: 3, featureCancelEpochs: {} }),
    readProfile: () => ({ uid: UID, gold: 100000, level: 30 }),
    readBag: () => ({ items: {} }),
    appendOutbox: () => {},
  });
  const unit = (featureId, scheduleKey) => runtime.features.find(feature => feature.featureId === featureId)
    .scheduleUnits.find(one => one.scheduleKey === scheduleKey);
  const assessDaily = () => unit('reward.daily-task', 'daily-task-recv').assess({ context: CONTEXT,
    config: { savedRevision: 3, featureCancelEpochs: { 'reward.daily-task': 0 }, config: { dailyTaskRewards: { enabled: true } } } });
  const assessShop = () => unit('cultivate.shop', 'shop-buy').assess({ context: CONTEXT,
    config: { savedRevision: 3, featureCancelEpochs: { 'cultivate.shop': 0 }, config: { materialShop: { enabled: true, maxBuyPerMinute: 3 } } } });
  const assessDouble = () => unit('reward.double-coin', 'double-coin-share').assess({ context: CONTEXT,
    config: { savedRevision: 3, featureCancelEpochs: { 'reward.double-coin': 0 }, config: { doubleCoin: { enabled: true } } } });
  return { runtime, world, assessDaily, assessShop, assessDouble, unit };
}

function settleUnknown(runtime, proposal, operationId = proposal.operationId) {
  runtime.onSettled({ proposal, operation: { operation_id: operationId, transport_state: 'answered' },
    verification: { verdict: 'unknown', reasonCode: 'WRITE_RESPONSE_TIMEOUT',
      evidence: { targetRef: proposal.targets[0].targetRef, targetKey: proposal.reward.targetKey } } });
}

test('an unknown keeps its opportunity held past the old ten-minute quiet window', () => {
  const { store } = tempStore();
  const h = harness(store, { values: dailyTaskValues() });
  const first = h.assessDaily();
  assert.equal(first.state, 'proposals');
  const proposal = first.proposals[0];
  settleUnknown(h.runtime, proposal);
  const row = store.get(`SELECT * FROM backend_reward_claims WHERE feature_id='reward.daily-task'`);
  assert.equal(row.state, 'unknown-held');
  assert.equal(row.hold_scope, 'task:30250001');
  // Eleven minutes of local time, restart, and a new run epoch: still the same
  // business opportunity and no proposal.
  store.run(`UPDATE backend_reward_claims SET updated_at=? WHERE claim_key=?`,
    new Date(Date.now() - 11 * 60 * 1000).toISOString(), row.claim_key);
  const restarted = harness(store, { values: dailyTaskValues() });
  assert.equal(restarted.runtime.migratedUnknownClaims, 0);
  const afterRestart = restarted.assessDaily();
  assert.equal(afterRestart.state, 'waiting-facts');
  assert.equal(afterRestart.reasonCode, 'REWARD_DAILY_TASK_PRIOR_UNKNOWN_REQUIRES_TARGET_PROOF');
  assert.equal(afterRestart.unresolvedClaimKey, row.claim_key);
  assert.equal(afterRestart.proposals, undefined);
});

test('a damaged before state also keeps the hold', () => {
  const { store } = tempStore();
  const h = harness(store, { values: dailyTaskValues() });
  settleUnknown(h.runtime, h.assessDaily().proposals[0]);
  store.run(`UPDATE backend_reward_claims SET before_json='{not-json', updated_at=?`, new Date(Date.now() - 3600000).toISOString());
  const restarted = harness(store, { values: dailyTaskValues() });
  const result = restarted.assessDaily();
  assert.equal(result.reasonCode, 'REWARD_DAILY_TASK_PRIOR_UNKNOWN_REQUIRES_TARGET_PROOF');
});

test('legacy unknown-retired and attempt>1 rows migrate to a hold idempotently', () => {
  const { store } = tempStore();
  const h = harness(store, { values: dailyTaskValues() });
  settleUnknown(h.runtime, h.assessDaily().proposals[0]);
  const key = 'daily:30250001:2026-11-02';
  store.run(`UPDATE backend_reward_claims SET state='unknown-retired', attempt=5 WHERE claim_key=?`, key);
  const before = store.get(`SELECT * FROM backend_reward_claims WHERE claim_key=?`, key);
  // A legacy :gN target row from the old build is immutable audit history; the
  // claim-level hold is what must block the same opportunity.
  const migrated = harness(store, { values: dailyTaskValues() });
  assert.equal(migrated.runtime.migratedUnknownClaims, 1);
  const row = store.get(`SELECT * FROM backend_reward_claims WHERE claim_key=?`, key);
  assert.equal(row.state, 'unknown-held');
  assert.equal(row.attempt, 5, 'the local attempt counter is preserved, never reset');
  assert.equal(row.operation_id, before.operation_id);
  assert.equal(row.before_json, before.before_json);
  const receipts = store.all(`SELECT * FROM backend_reward_claim_migrations`);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].reason_code, 'LOCAL_QUIET_TIME_IS_NOT_NON_EFFECT_PROOF');
  const result = migrated.assessDaily();
  assert.equal(result.reasonCode, 'REWARD_DAILY_TASK_PRIOR_UNKNOWN_REQUIRES_TARGET_PROOF');
  // A second restart is a no-op for both rows and receipts.
  const again = harness(store, { values: dailyTaskValues() });
  assert.equal(again.runtime.migratedUnknownClaims, 0);
  assert.equal(store.all(`SELECT * FROM backend_reward_claim_migrations`).length, 1);
  assert.equal(store.get(`SELECT * FROM backend_reward_claims WHERE claim_key=?`, key).attempt, 5);
});

test('a later official observation closes one attempt as achieved and never credits it', () => {
  const { store } = tempStore();
  const h = harness(store, { values: dailyTaskValues() });
  const proposal = h.assessDaily().proposals[0];
  settleUnknown(h.runtime, proposal);
  const older = new Date(Date.now() - 120000).toISOString();
  store.run(`UPDATE backend_reward_claims SET updated_at=?, before_json=? WHERE claim_key=?`, older,
    JSON.stringify({ taskId: 30250001, type: 1, recvBefore: 0 }), 'daily:30250001:2026-11-02');
  h.world.values = dailyTaskValues({ recvMap: { 1: true } });
  h.world.sources = { 'reward-tasks': { responseRef: 'login-2', requestSequence: 90, connectionEpoch: 3,
    receivedDeviceMs: Date.now(), method: 'index.login' } };
  const result = h.assessDaily();
  const row = store.get(`SELECT * FROM backend_reward_claims WHERE claim_key='daily:30250001:2026-11-02'`);
  assert.equal(row.state, 'unknown-achieved');
  assert.equal(row.achieved_ref, 'login-2');
  assert.equal(row.operation_id, proposal.operationId, 'the original operation stays attached');
  assert.equal(store.all(`SELECT * FROM backend_reward_period_usage`).length, 0, 'achieved is not credited as a confirmed claim');
  assert.ok(!result.proposals, 'no resend once the official state no longer offers the target');
});

test('one official post-state can close only one held attempt', () => {
  const { store } = tempStore();
  const h = harness(store, { values: dailyTaskValues({ taskIds: [30250001, 30250002] }) });
  const first = h.assessDaily().proposals[0];
  settleUnknown(h.runtime, first);
  // Simulate a second held attempt for another task of the same card.
  store.run(`INSERT INTO backend_reward_claims(owner_ref,subject_ref,feature_id,claim_key,period_key,state,operation_id,
    params_json,before_json,quota_key,hold_scope,attempt,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  CONTEXT.ownerRef, CONTEXT.subjectRef, 'reward.daily-task', 'daily:30250002:2026-11-02', '2026-11-02', 'unknown-held',
  'op-second', '{"id":30250002}', JSON.stringify({ taskId: 30250002, type: 1, recvBefore: 0 }), null, 'task:30250002', 3,
  new Date(Date.now() - 60000).toISOString());
  h.world.values = dailyTaskValues({ taskIds: [30250001, 30250002], recvMap: { 1: true } });
  h.world.sources = { 'reward-tasks': { responseRef: 'login-9', requestSequence: 99, connectionEpoch: 3,
    receivedDeviceMs: Date.now(), method: 'index.login' } };
  h.assessDaily();
  h.assessDaily();
  const rows = store.all(`SELECT claim_key, state FROM backend_reward_claims ORDER BY claim_key`);
  assert.equal(rows.filter(row => row.state === 'unknown-achieved').length, 1, 'one observation closes at most one attempt');
  assert.equal(rows.filter(row => row.state === 'unknown-held').length, 1);
});

test('a held target does not block an independent opportunity of the same card', () => {
  const { store } = tempStore();
  const h = harness(store, { values: dailyTaskValues({ taskIds: [30250001, 30250002] }) });
  const first = h.assessDaily().proposals[0];
  assert.equal(first.reward.targetKey, 'daily:30250001:2026-11-02');
  settleUnknown(h.runtime, first);
  h.world.values = dailyTaskValues({ taskIds: [30250001, 30250002], progress: { 1: 1 } });
  const next = h.assessDaily();
  assert.equal(next.state, 'proposals', 'the other task still advances');
  assert.equal(next.proposals[0].reward.targetKey, 'daily:30250002:2026-11-02');
});

test('admission refuses a queued proposal for a held opportunity', () => {
  const { store } = tempStore();
  const h = harness(store, { values: dailyTaskValues() });
  const proposal = h.assessDaily().proposals[0];
  // A second proposal drafted before the first attempt settled carries its own
  // operation id but the same business target; it must not slip past admission.
  const queued = { ...proposal, operationId: 'queued-operation-2', proposalId: 'queued-proposal-2' };
  settleUnknown(h.runtime, proposal);
  const decision = h.runtime.evaluateAdmission({ proposal: queued, actor: CONTEXT, factBasis: proposal.factBasis });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, 'REWARD_OPPORTUNITY_UNRESOLVED');
});

test('a legacy :gN unresolved ledger target still blocks the base opportunity', () => {
  const { store } = tempStore();
  const ledger = createBackendLedger(store);
  const base = `reward:${CONTEXT.subjectRef}:recv:daily:30250001:2026-11-02`;
  const targetRef = base + ':g2';
  ledger.prepareOperation({ operationId: 'legacy-g2', proposalId: 'legacy-proposal', ownerRef: CONTEXT.ownerRef,
    accountRef: CONTEXT.accountRef, subjectRef: CONTEXT.subjectRef, ownerEpoch: 1, executorRef: 'executor', runEpoch: 7,
    connectionEpoch: 3, featureId: 'reward.daily-task', scope: 'daily-task-recv', method: 'taskDly.recv',
    semanticKey: 'rewards/1:reward.daily-task:daily:30250001:2026-11-02:g2', configRevision: 3, cancelEpoch: 0,
    paramsFingerprint: 'params-legacy', factBasis: { version: 'rewards/1' },
    targets: [{ memberKey: 'reward:legacy', targetKind: 'reward:recv', targetRef, lifecycleRef: '2026-11-02',
      targetFingerprint: 'legacy-fingerprint' }], resources: [], resourceBindings: [] });
  ledger.markMayHaveSent({ operationId: 'legacy-g2', evidence: { kind: 'send', source: 'unit', payload: { sent: true } } });
  ledger.recordTransport({ operationId: 'legacy-g2', transportState: 'unknown', releaseWriteSlot: true,
    transportTermination: { ended: true, source: 'unit-close' }, evidence: { kind: 'transport', source: 'unit', payload: { state: 'unknown' } } });
  ledger.settleOperation({ operationId: 'legacy-g2', businessVerdict: 'unknown', verificationVersion: 'test/v1',
    evidence: { kind: 'unknown', source: 'unit', payload: { verdict: 'unknown' } } });
  const h = harness(store, { values: dailyTaskValues(), ledgerView: { currentAdmission: ledger.currentAdmission, operation: ledger.operation } });
  const proposal = h.assessDaily().proposals[0];
  assert.equal(proposal.targets[0].targetRef, base, 'new proposals never mint a local generation suffix');
  const decision = h.runtime.evaluateAdmission({ proposal, actor: CONTEXT, factBasis: proposal.factBasis });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, 'REWARD_TARGET_UNRESOLVED');
});

test('quota is charged once per operation across unknown settlement and later proof', () => {
  const { store } = tempStore();
  const h = harness(store, { values: { 'reward-shop': { present: true, refreshCount: 0,
    offers: [{ shopId: 10004, bought: 0, costItemId: 11, price: 10 }] } } });
  const proposal = h.assessShop().proposals[0];
  settleUnknown(h.runtime, proposal);
  // A retried settlement hook for the same operation must not charge twice.
  settleUnknown(h.runtime, proposal, proposal.operationId);
  const usage = store.all(`SELECT * FROM backend_reward_period_usage WHERE quota_key='shop-buy'`);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].used, 1);
  const charges = store.all(`SELECT * FROM backend_reward_usage_charges`);
  assert.equal(charges.length, 1);
  assert.equal(charges[0].period_key, proposal.reward.quotaPeriodKey);
});

test('the double-coin renewal uses the renew action its post-state contract expects', () => {
  const { store } = tempStore();
  const world = { values: { 'reward-double': { present: true, eTime: DAY_START, videoCnt: 1 } }, sources: null, nowMs: DAY_START + 3600000 };
  const h = harness(store, { values: world.values, tables: { c_share: { 11: { limit: 5 } }, c_task_dly: { '-1': {} }, c_task_week: { '-1': {} } } });
  const result = h.assessDouble();
  assert.equal(result.state, 'proposals');
  const proposal = result.proposals[0];
  assert.equal(proposal.reward.action, 'renew');
  assert.equal(proposal.targets[0].targetKind, 'reward:renew');
  assert.equal(assertClaimProposal(proposal), true, 'the renewal still satisfies the exact usr.share argument contract');
  settleUnknown(h.runtime, proposal);
  const key = proposal.reward.targetKey;
  assert.equal(store.get(`SELECT state FROM backend_reward_claims WHERE claim_key=?`, key).state, 'unknown-held');
  // The official buff moves forward: the held renewal is closed as achieved and
  // never re-sent, which the misnamed action used to make impossible.
  h.world.values = { 'reward-double': { present: true, eTime: DAY_START + 7200000, videoCnt: 1 } };
  h.world.sources = { 'reward-double': { responseRef: 'login-double-2', requestSequence: 12, connectionEpoch: 3,
    receivedDeviceMs: Date.now(), method: 'index.login' } };
  h.assessDouble();
  const row = store.get(`SELECT state,achieved_ref FROM backend_reward_claims WHERE claim_key=?`, key);
  assert.equal(row.state, 'unknown-achieved');
  assert.equal(row.achieved_ref, 'login-double-2');
});

// ---- R10 continuation: bounded legacy migration -------------------------------

const claimInsert = `INSERT INTO backend_reward_claims(owner_ref,subject_ref,feature_id,claim_key,period_key,state,operation_id,
  params_json,before_json,updated_at,attempt,hold_scope) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`;

test('legacy migration advances past 512 legitimately null-scope holds and keeps the NULL', () => {
  const { store } = tempStore();
  harness(store, { values: dailyTaskValues() });
  store.transaction(() => {
    for (let i = 0; i < 512; i += 1) store.run(claimInsert, CONTEXT.ownerRef, CONTEXT.subjectRef, 'reward.main-story',
      'story:' + i, '2026-11-01', 'unknown-held', 'old-story-' + i, '{}', '{}', '2026-11-01T00:00:00Z', 1, null);
    store.run(claimInsert, CONTEXT.ownerRef, CONTEXT.subjectRef, 'reward.daily-task', 'daily:30250001:2026-11-01',
      '2026-11-01', 'unknown-retired', 'old-daily', '{}', '{}', '2026-11-01T00:00:00Z', 2, null);
  });
  // Two restarts are more than the first page needs; the row behind it must be
  // converted without the operator restarting anything.
  const first = harness(store, { values: dailyTaskValues() });
  assert.equal(first.runtime.migratedUnknownClaims, 1);
  const row = store.get("SELECT state,hold_scope FROM backend_reward_claims WHERE feature_id='reward.daily-task'");
  assert.equal(row.state, 'unknown-held');
  assert.equal(row.hold_scope, 'task:30250001');
  const story = store.get("SELECT hold_scope,scope_version FROM backend_reward_claims WHERE claim_key='story:0'");
  assert.equal(story.hold_scope, null, 'a story chapter has no period-independent hold scope');
  assert.equal(story.scope_version, 1, 'the examined NULL is recorded as processed');
  const again = harness(store, { values: dailyTaskValues() });
  assert.equal(again.runtime.migratedUnknownClaims, 0);
  assert.equal(store.all('SELECT * FROM backend_reward_claim_migrations').length, 1, 'no repeated receipt');
});

test('a migration larger than one startup budget continues without a restart', () => {
  const { store } = tempStore();
  harness(store, { values: dailyTaskValues() });
  // 4,200 null-scope holds exceed the 8x512 startup budget, so the two retired
  // rows behind them cannot be reached by construction alone.
  store.transaction(() => {
    for (let i = 0; i < 4200; i += 1) store.run(claimInsert, CONTEXT.ownerRef, CONTEXT.subjectRef, 'reward.main-story',
      'story:' + i, '2026-11-01', 'unknown-held', 'old-story-' + i, '{}', '{}', '2026-11-01T00:00:00Z', 1, null);
    store.run(claimInsert, CONTEXT.ownerRef, CONTEXT.subjectRef, 'reward.daily-task', 'daily:30250001:2026-11-01',
      '2026-11-01', 'unknown-retired', 'old-daily', '{}', '{}', '2026-11-01T00:00:00Z', 2, null);
    store.run(claimInsert, CONTEXT.ownerRef, CONTEXT.subjectRef, 'reward.daily-task', 'daily:30250002:2026-11-01',
      '2026-11-01', 'unknown-retired', 'old-daily-2', '{}', '{}', '2026-11-01T00:00:00Z', 4, null);
  });
  const h = harness(store, { values: dailyTaskValues() });
  assert.equal(store.get("SELECT state FROM backend_reward_claims WHERE claim_key='daily:30250001:2026-11-01'").state,
    'unknown-retired', 'the startup budget is genuinely bounded');
  let remaining = true;
  for (let run = 0; run < 8 && remaining; run += 1) {
    const result = h.runtime.migrateLegacyUnknowns({ ownerRef: CONTEXT.ownerRef, subjectRef: CONTEXT.subjectRef,
      limit: 512, maxBatches: 1 });
    assert.ok(result.examined <= 512, 'each maintenance run stays bounded');
    remaining = result.remaining;
  }
  assert.equal(remaining, false, 'the backlog is finished by maintenance runs, not restarts');
  const rows = store.all("SELECT state,hold_scope,attempt FROM backend_reward_claims WHERE feature_id='reward.daily-task' ORDER BY claim_key");
  assert.deepEqual(rows.map(row => row.state), ['unknown-held', 'unknown-held']);
  assert.deepEqual(rows.map(row => row.hold_scope), ['task:30250001', 'task:30250002']);
  assert.deepEqual(rows.map(row => row.attempt), [2, 4], 'the local attempt counter is preserved');
  assert.equal(store.all('SELECT * FROM backend_reward_claim_migrations').length, 2);
  const idle = h.runtime.migrateLegacyUnknowns({ ownerRef: CONTEXT.ownerRef, subjectRef: CONTEXT.subjectRef });
  assert.equal(idle.examined, 0, 'finished rows are never rewritten');
});

test('a restart after a partial migration resumes without duplicates or skips', () => {
  const { store } = tempStore();
  harness(store, { values: dailyTaskValues() });
  // 5,000 null-scope holds leave a real remainder after the bounded startup pass.
  store.transaction(() => {
    for (let i = 0; i < 5000; i += 1) store.run(claimInsert, CONTEXT.ownerRef, CONTEXT.subjectRef, 'reward.main-story',
      'story:' + i, '2026-11-01', 'unknown-held', 'old-story-' + i, '{}', '{}', '2026-11-01T00:00:00Z', 1, null);
    store.run(claimInsert, CONTEXT.ownerRef, CONTEXT.subjectRef, 'reward.daily-task', 'daily:30250001:2026-11-01',
      '2026-11-01', 'unknown-retired', 'old-daily', '{}', '{}', '2026-11-01T00:00:00Z', 3, null);
  });
  const first = harness(store, { values: dailyTaskValues() });
  assert.equal(first.runtime.migratedUnknownClaims, 0, 'the retired row is still behind the startup budget');
  assert.equal(store.all("SELECT 1 FROM backend_reward_claims WHERE scope_version=0").length, 905,
    'the startup pass examined exactly its budget, never the whole table');
  // One maintenance batch resumes exactly where the startup pass stopped.
  const resumed = first.runtime.migrateLegacyUnknowns({ ownerRef: CONTEXT.ownerRef, subjectRef: CONTEXT.subjectRef,
    limit: 512, maxBatches: 1 });
  assert.equal(resumed.examined, 512);
  // A restart finishes the remainder; already-stamped rows are never rewritten
  // and the retired row still gets exactly one receipt.
  const restarted = harness(store, { values: dailyTaskValues() });
  assert.equal(restarted.runtime.migratedUnknownClaims, 1, 'the restart reached the retired row');
  assert.equal(store.all("SELECT 1 FROM backend_reward_claims WHERE scope_version=0").length, 0);
  assert.equal(store.all('SELECT * FROM backend_reward_claim_migrations').length, 1, 'no duplicate receipt');
  assert.equal(store.get("SELECT attempt FROM backend_reward_claims WHERE claim_key='daily:30250001:2026-11-01'").attempt, 3);
});

test('an unmigrated retired row still blocks its target on the next official day', () => {
  const { store } = tempStore();
  const h = harness(store, { values: dailyTaskValues({ taskIds: [30250001] }) });
  // Written after the runtime started, so the bounded pass has not seen it: this
  // is the window in which admission must already be safe.
  store.run(claimInsert, CONTEXT.ownerRef, CONTEXT.subjectRef, 'reward.daily-task', 'daily:30250001:2026-11-01',
    '2026-11-01', 'unknown-retired', 'old-daily', '{}', '{}', '2026-11-01T00:00:00Z', 2, null);
  h.world.day = { key: '2026-11-03', startMs: DAY_START + 2 * 86400000, endMs: DAY_START + 3 * 86400000 };
  h.world.nowMs = DAY_START + 2 * 86400000 + 3600000;
  const result = h.assessDaily();
  assert.equal(result.state, 'waiting-facts');
  assert.equal(result.reasonCode, 'REWARD_DAILY_TASK_PRIOR_UNKNOWN_REQUIRES_TARGET_PROOF');
  assert.equal(result.unresolvedClaimKey, 'daily:30250001:2026-11-01');
  assert.ok(!result.proposals, 'no proposal while the same action target is held');
  // The other task of the same card is not affected by the pending migration.
  h.world.values = dailyTaskValues({ taskIds: [30250001, 30250002] });
  const independent = h.assessDaily();
  assert.equal(independent.state, 'proposals');
  assert.equal(independent.proposals[0].reward.targetKey, 'daily:30250002:2026-11-03');
});

// ---- R10 continuation: reconciliation fairness ---------------------------------

test('reconciliation reaches a provable row behind an unprovable head batch', () => {
  const { store } = tempStore();
  const h = harness(store, { values: dailyTaskValues({ taskIds: [30250001], recvMap: { 1: true } }) });
  const settledAt = new Date(Date.now() - 120000).toISOString();
  store.transaction(() => {
    // Sixteen held daily claims whose official state can never prove them, with
    // the smallest claim keys so an unrotated LIMIT 16 page would always be them.
    for (let i = 2; i <= 17; i += 1) store.run(claimInsert, CONTEXT.ownerRef, CONTEXT.subjectRef, 'reward.daily-task',
      'daily:302500' + String(i).padStart(2, '0') + ':2026-11-02', '2026-11-02', 'unknown-held', 'old-' + i, '{}',
      JSON.stringify({ taskId: 30250000 + i, type: 99, recvBefore: 0 }), settledAt, 1, 'task:' + (30250000 + i));
    store.run(claimInsert, CONTEXT.ownerRef, CONTEXT.subjectRef, 'reward.daily-task', 'daily:30999999:2026-11-02',
      '2026-11-02', 'unknown-held', 'held-achievable', '{}',
      JSON.stringify({ taskId: 30999999, type: 1, recvBefore: 0 }), settledAt, 1, 'task:30999999');
  });
  h.world.sources = { 'reward-tasks': { responseRef: 'login-fair-2', requestSequence: 12, connectionEpoch: 3,
    receivedDeviceMs: Date.now(), method: 'index.login' } };
  // The maintenance path is used, not a card assessment: a card suspended by its
  // own cap is not reassessed at all, yet its held rows must still be re-read.
  h.runtime.reconcileHeldClaims({ context: CONTEXT });
  assert.equal(store.get("SELECT state FROM backend_reward_claims WHERE claim_key='daily:30999999:2026-11-02'").state,
    'unknown-held', 'the first page cannot contain the last key');
  h.runtime.reconcileHeldClaims({ context: CONTEXT });
  const row = store.get("SELECT state,achieved_ref FROM backend_reward_claims WHERE claim_key='daily:30999999:2026-11-02'");
  assert.equal(row.state, 'unknown-achieved');
  assert.equal(row.achieved_ref, 'login-fair-2');
  // The unprovable rows stay held and are not rewritten as confirmed.
  assert.equal(store.all("SELECT 1 FROM backend_reward_claims WHERE claim_key LIKE 'daily:3025%' AND state='unknown-held'").length, 16);
});
