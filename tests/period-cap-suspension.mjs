import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createConfigService } from '../runtime/backend/config/service.mjs';
import { createScheduler } from '../runtime/backend/scheduler/service.mjs';
import { createDynamicStateCoordinator, FEATURE_DOMAINS } from '../runtime/backend/facts/dynamic-state.mjs';
import { fingerprint } from '../runtime/backend/common.mjs';

async function harness({ localLimit, officialCap = false, periodMs = 5000, withAuxActions = false, restoreClockOnRefresh = false,
  clockRestoreAfterPeriod = true, capClockRecheckMs = 15 }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-period-cap-'));
  const store = openBackendStore({ dataDir: root });
  const ownerRef = 'fixture:owner', accountRef = 'fixture:account', subjectRef = 'fixture:subject';
  const context = Object.freeze({ ownerRef, accountRef, subjectRef, ownerEpoch: 1, runEpoch: 1, connectionEpoch: 1 });
  let eventId = 0;
  const pending = [];
  const configService = createConfigService({ store, appendOutbox: event => { pending.push({ ...event, eventId: ++eventId }); } });
  configService.migrate({ ownerRef, accountRef, subjectRef, legacyDocument: {} });
  let config = configService.read({ ownerRef, accountRef });
  config.config.orders.resident.enabled = true;
  config.config.orders.resident.dailyLimit = localLimit;
  config = configService.save({ ownerRef, accountRef, expectedRevision: 1, config: config.config });
  configService.accept({ ownerRef, accountRef, revision: config.savedRevision, actorRef: 'fixture:scheduler' });
  const periodKey = 'fixture-day-2026-10-26', periodEndOfficialMs = Date.now() + periodMs;
  let officialClockAvailable = true, officialNowMs = null;
  let assessments = 0, refreshes = 0, assessmentsAtClockRefresh = null, auxiliarySends = 0, auxiliaryAssessments = 0, videoAssessments = 0;
  let schedulerError = null;
  let scheduler;
  const assessDelivery = async input => {
      assessments++;
      const now = input.clock.nowMs;
      if (now >= periodEndOfficialMs) return { state: 'no-action', reasonCode: 'NEXT_PERIOD_REASSESSED', deviceDueMs: now + 4 * 60 * 60 * 1000 };
      const cap = officialCap || input.config.config.orders.resident.dailyLimit <= 1;
      if (!cap) return { state: 'no-action', reasonCode: 'LOCAL_LIMIT_RAISED', deviceDueMs: now + 4 * 60 * 60 * 1000 };
      return { state: 'cap-wait', reasonCode: 'ORDER_FLOWER_DAILY_LIMIT_REACHED', suspension: {
        kind: 'period-cap', quotaKey: 'order-flower:resident', actionScope: withAuxActions ? 'order.resident:delivery' : 'feature', periodKind: 'official-day', periodKey,
        periodEndOfficialMs, scope: officialCap ? 'official' : 'local', used: 1, limit: 1,
        proofRefs: ['fixture:official-day', 'fixture:counter'], configRevision: input.config.savedRevision } };
    };
  const parentFeature = { featureId: 'order.resident', factRequirements: [],
    consumedDomains: FEATURE_DOMAINS['order.resident'],
    consumedDomainsFor: () => ['order-flower'], factDomains: ['land-domain'], resourceKinds: ['inventory'],
    assess: assessDelivery };
  if (withAuxActions) {
    let auxSent = false;
    parentFeature.scheduleUnits = [
      { scheduleKey: 'order.resident:delivery', quotaKeys: ['order-flower:resident'], assess: assessDelivery },
      { scheduleKey: 'order.resident:stage-reward', assess: async input => {
        auxiliaryAssessments++;
        if (auxSent) return { state: 'no-action', reasonCode: 'AUXILIARY_ALREADY_CLAIMED', deviceDueMs: input.clock.nowMs + 4 * 60 * 60 * 1000 };
        auxSent = true; return { state: 'proposals', proposals: [{ ...context, featureId: 'order.resident', method: 'orderFlower.enter',
          operationId: 'fixture-auxiliary-once', proposalId: 'fixture-auxiliary-once' }] };
      } },
      { scheduleKey: 'order.resident:video', quotaKeys: ['order-flower:resident'], priority: -1, assess: async () => {
        videoAssessments++; return { state: 'waiting-facts', reasonCode: 'VIDEO_WOULD_BE_ASSESSED' };
      } },
    ];
  }
  const feature = parentFeature;
  const registry = { modules: () => [feature], get: id => id === feature.featureId ? feature : null };
  const ledger = { readPendingOutbox: () => [...pending],
    ackOutbox: ({ eventId: id }) => { const index = pending.findIndex(event => event.eventId === id); if (index >= 0) pending.splice(index, 1); } };
  const dynamicState = createDynamicStateCoordinator({ store, isCurrent: value => JSON.stringify(value) === JSON.stringify(context),
    requestRefresh: async request => {
      refreshes++;
      if (restoreClockOnRefresh && request.domains.includes('clock')) {
        assessmentsAtClockRefresh = assessments;
        officialClockAvailable = true; officialNowMs = periodEndOfficialMs + (clockRestoreAfterPeriod ? 1 : -1);
      }
      return { refreshed: false, reasonCode: 'TEST_REFRESH_UNEXPECTED' };
    } });
  const observeFacts = sequence => {
    const arrived = Date.now(), receivedMonotonicMs = Number(process.hrtime.bigint()) / 1_000_000;
    const observation = { source: 'response', transport: 'answered', envelopeOk: true, dsName: 'G.ISyncData', rejected: false,
      context, method: 'index.login', connectionEpoch: context.connectionEpoch, requestSequence: sequence,
      responseRef: 'fixture:cap-facts:' + sequence, receivedDeviceMs: arrived, receivedMonotonicMs };
    const source = { sourceRef: observation.responseRef, method: observation.method, connectionEpoch: context.connectionEpoch,
      requestSequence: sequence, observedAtMs: arrived, observedMonotonicMs: receivedMonotonicMs };
    const semanticValue = { 'order-flower.value': sequence };
    dynamicState.observe({ context, observation, coverage: [{ domainId: 'order-flower', complete: true, paths: ['order-flower.value'], semanticValue,
      cellSources: { 'order-flower.value': source }, semanticFingerprint: fingerprint(semanticValue), observedAtMs: arrived }] });
  };
  observeFacts(1);
  const makeScheduler = () => createScheduler({ store, ledger, registry, dynamicState, capClockRecheckMs,
    readConfiguration: () => configService.read({ ownerRef, accountRef }),
    acceptConfiguration: (_context, revision) => configService.accept({ ownerRef, accountRef, revision, actorRef: 'fixture:scheduler' }),
    recordPlan: (_context, input) => configService.recordPlan({ ...input, ownerRef, accountRef }),
    facts: { clock: () => ({ available: officialClockAvailable, nowMs: officialNowMs ?? Date.now(), revision: officialClockAvailable ? 1 : null }), snapshot: () => ({}) },
    submitProposal: async () => { if (withAuxActions) auxiliarySends++; }, isCurrent: () => true, onError: (_context, error) => { schedulerError = error; } });
  scheduler = makeScheduler();
  return { root, store, context, configService, config, pending, get scheduler() { return scheduler; }, dynamicState, observeFacts,
    restartScheduler: () => { scheduler.stop(context); scheduler = makeScheduler(); scheduler.start(context); return scheduler; },
    addEvent: (eventType, payload) => pending.push({ eventId: ++eventId, eventType, payload }),
    setClock: ({ available, nowMs = officialNowMs }) => { officialClockAvailable = available; officialNowMs = nowMs; },
    get assessments() { return assessments; }, get refreshes() { return refreshes; },
    get assessmentsAtClockRefresh() { return assessmentsAtClockRefresh; },
    get auxiliarySends() { return auxiliarySends; }, get auxiliaryAssessments() { return auxiliaryAssessments; },
    get videoAssessments() { return videoAssessments; },
    get schedulerError() { return schedulerError; }, periodEndOfficialMs };
}

const waitFor = async (predicate, timeoutMs = 1500) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(predicate(), 'condition became true before test deadline');
};

test('local cap is persisted as cap-wait and raising the local limit wakes the feature immediately', async () => {
  const h = await harness({ localLimit: 1 });
  try {
    h.scheduler.start(h.context);
    await waitFor(() => h.store.get("SELECT 1 FROM backend_feature_wakes WHERE feature_id='order.resident'") !== null || h.schedulerError);
    assert.equal(h.schedulerError, null, h.schedulerError?.stack || 'scheduler returned no error');
    let wake = h.store.get("SELECT state,official_due_ms,device_due_ms FROM backend_feature_wakes WHERE feature_id='order.resident'");
    assert.equal(wake.state, 'cap-wait');
    assert.equal(wake.official_due_ms, h.periodEndOfficialMs);
    assert.equal(wake.device_due_ms, null);
    assert.equal(h.store.get("SELECT scope FROM backend_period_suspensions WHERE feature_id='order.resident'").scope, 'local');
    assert.equal(h.configService.read({ ownerRef: h.context.ownerRef, accountRef: h.context.accountRef }).byFeature['order.resident'].state, 'cap-wait');

    const latest = h.configService.read({ ownerRef: h.context.ownerRef, accountRef: h.context.accountRef });
    latest.config.orders.resident.dailyLimit = 2;
    h.configService.save({ ownerRef: h.context.ownerRef, accountRef: h.context.accountRef,
      expectedRevision: latest.savedRevision, config: latest.config });
    h.scheduler.notify(h.context);
    await waitFor(() => h.assessments === 2);
    wake = h.store.get("SELECT state FROM backend_feature_wakes WHERE feature_id='order.resident'");
    assert.equal(wake.state, 'no-action');
    assert.equal(h.store.get("SELECT 1 FROM backend_period_suspensions WHERE feature_id='order.resident' AND scope='local'"), null);
  } finally { h.scheduler.stop(h.context); h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('official cap survives a local configuration change and is reconsidered at the official period end', async () => {
  const h = await harness({ localLimit: 1, officialCap: true, periodMs: 700 });
  try {
    h.scheduler.start(h.context);
    await waitFor(() => h.store.get("SELECT 1 FROM backend_feature_wakes WHERE feature_id='order.resident'") !== null || h.schedulerError);
    assert.equal(h.schedulerError, null, h.schedulerError?.stack || 'scheduler returned no error');
    assert.equal(h.store.get("SELECT scope FROM backend_period_suspensions WHERE feature_id='order.resident'").scope, 'official');
    const latest = h.configService.read({ ownerRef: h.context.ownerRef, accountRef: h.context.accountRef });
    latest.config.orders.resident.dailyLimit = 2;
    h.configService.save({ ownerRef: h.context.ownerRef, accountRef: h.context.accountRef,
      expectedRevision: latest.savedRevision, config: latest.config });
    h.scheduler.notify(h.context);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(h.assessments, 1, 'ConfigChanged cannot clear an official cap before its official day ends');
    assert.equal(h.store.get("SELECT scope FROM backend_period_suspensions WHERE feature_id='order.resident'").scope, 'official');
    const accepted = h.configService.read({ ownerRef: h.context.ownerRef, accountRef: h.context.accountRef });
    const wakeAfterConfig = h.store.get("SELECT state,config_revision,reason_code FROM backend_feature_wakes WHERE feature_id='order.resident'");
    assert.equal(wakeAfterConfig.state, 'cap-wait');
    assert.equal(wakeAfterConfig.reason_code, 'PERIOD_CAP_WAIT');
    assert.equal(wakeAfterConfig.config_revision, accepted.savedRevision, 'cap proof stays active while the projected plan advances to the accepted config revision');
    assert.equal(accepted.byFeature['order.resident'].plannedRevision, accepted.savedRevision);
    assert.equal(accepted.byFeature['order.resident'].state, 'cap-wait');
    await waitFor(() => h.assessments >= 2);
    assert.equal(h.store.get("SELECT state FROM backend_feature_wakes WHERE feature_id='order.resident'").state, 'no-action');
  } finally { h.scheduler.stop(h.context); h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('official clock loss cannot clear a stored cap and clock recovery wakes after the proven period end', async () => {
  const h = await harness({ localLimit: 1, officialCap: true, periodMs: 5000 });
  try {
    h.scheduler.start(h.context);
    await waitFor(() => h.store.get("SELECT 1 FROM backend_period_suspensions WHERE feature_id='order.resident'") !== null);
    assert.equal(h.assessments, 1);
    h.setClock({ available: false });
    const latest = h.configService.read({ ownerRef: h.context.ownerRef, accountRef: h.context.accountRef });
    latest.config.orders.resident.dailyLimit = 2;
    h.configService.save({ ownerRef: h.context.ownerRef, accountRef: h.context.accountRef,
      expectedRevision: latest.savedRevision, config: latest.config });
    h.scheduler.notify(h.context);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(h.assessments, 1, 'unknown official time cannot bypass an official cap on config change');
    assert.equal(h.store.get("SELECT scope FROM backend_period_suspensions WHERE feature_id='order.resident'").scope, 'official');
    assert.equal(h.store.get("SELECT state FROM backend_feature_wakes WHERE feature_id='order.resident'").state, 'cap-wait');
    h.setClock({ available: true, nowMs: h.periodEndOfficialMs + 1 });
    h.scheduler.notify(h.context);
    await waitFor(() => h.assessments === 2);
    assert.equal(h.schedulerError, null, h.schedulerError?.stack || 'scheduler returned no error');
    assert.equal(h.store.get("SELECT state FROM backend_feature_wakes WHERE feature_id='order.resident'").state, 'no-action');
  } finally { h.scheduler.stop(h.context); h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('an official cap automatically reacquires its clock without a business assessment while the clock is unavailable', async () => {
  const h = await harness({ localLimit: 1, officialCap: true, periodMs: 5000, restoreClockOnRefresh: true });
  try {
    h.scheduler.start(h.context);
    await waitFor(() => h.store.get("SELECT 1 FROM backend_period_suspensions WHERE feature_id='order.resident'") !== null);
    h.setClock({ available: false });
    h.scheduler.notify(h.context);
    await waitFor(() => h.refreshes > 0);
    assert.equal(h.assessmentsAtClockRefresh, 1, 'clock recovery runs through the shared fact refresh gate before any business assessment');
    await waitFor(() => h.assessments === 2, 7000);
    assert.equal(h.store.get("SELECT 1 FROM backend_period_suspensions WHERE feature_id='order.resident'") !== null, true);
  } finally { h.scheduler.stop(h.context); h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('an inherited cap creates its missing unit wake and repeated facts events cannot postpone clock recovery', async () => {
  const h = await harness({ localLimit: 1, withAuxActions: true, periodMs: 8000, restoreClockOnRefresh: true,
    clockRestoreAfterPeriod: false, capClockRecheckMs: 60 });
  try {
    h.store.run(`INSERT INTO backend_period_suspensions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, h.context.ownerRef, h.context.subjectRef,
      'order.resident:delivery', 'order-flower:resident', 'order.resident:delivery', 'official-day', 'fixture-inherited-day',
      h.periodEndOfficialMs, 'official', 1, 1, '["fixture:official-counter"]', 1, new Date().toISOString());
    h.setClock({ available: false });
    h.scheduler.start(h.context);
    await waitFor(() => h.store.get("SELECT 1 FROM backend_feature_wakes WHERE feature_id='order.resident:video'") !== null || h.schedulerError);
    assert.equal(h.schedulerError, null, h.schedulerError?.stack || 'scheduler returned no error');
    const videoWake = h.store.get("SELECT state,official_due_ms,device_due_ms FROM backend_feature_wakes WHERE feature_id='order.resident:video'");
    assert.equal(videoWake.state, 'cap-wait');
    assert.equal(videoWake.official_due_ms, h.periodEndOfficialMs);
    assert.ok(videoWake.device_due_ms > Date.now() + 10, 'the missing sibling unit gets a persisted clock recheck deadline');
    const interval = setInterval(() => {
      h.addEvent('FactsChanged', { domain: 'land-domain', responseRef: 'fixture:unrelated-facts-' + Date.now() });
      h.scheduler.notify(h.context);
    }, 5);
    await waitFor(() => h.refreshes > 0 || h.schedulerError, 1000);
    clearInterval(interval);
    assert.equal(h.schedulerError, null, h.schedulerError?.stack || 'scheduler returned no error');
    assert.equal(h.refreshes, 1, 'the inherited cap refreshes only its official clock once when the original deadline arrives');
    assert.equal(h.assessments, 0, 'clock reacquisition never assesses capped business work');
    assert.equal(h.videoAssessments, 0, 'the sibling unit is never sent to normal assessment while the shared cap is active');
    assert.ok(h.store.get("SELECT 1 FROM backend_feature_wakes WHERE feature_id='order.resident:video'"));
  } finally { h.scheduler.stop(h.context); h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('delivery action cap does not suppress an auxiliary claim and later resource events cannot wake capped delivery', async () => {
  const h = await harness({ localLimit: 1, withAuxActions: true, periodMs: 5000 });
  try {
    h.scheduler.start(h.context);
    await waitFor(() => h.schedulerError || h.store.get("SELECT 1 FROM backend_period_suspensions WHERE feature_id='order.resident:delivery'") !== null && h.auxiliarySends === 1);
    assert.equal(h.schedulerError, null, h.schedulerError?.stack || 'scheduler returned no error');
    assert.equal(h.assessments, 1, 'delivery is assessed once and enters its action-scoped cap');
    assert.equal(h.auxiliaryAssessments, 1, 'auxiliary action gets its own assessment');
    assert.equal(h.videoAssessments, 0, 'the delivery daily quota also pre-gates the same-category video action; persisted caps=' +
      JSON.stringify(h.store.all('SELECT feature_id,quota_key,action_scope FROM backend_period_suspensions')));
    h.addEvent('ResourceChanged', { resourceKind: 'inventory' });
    h.scheduler.notify(h.context);
    await waitFor(() => h.pending.length === 0);
    assert.equal(h.assessments, 1, 'resource event is consumed without re-assessing capped delivery');
    assert.equal(h.auxiliarySends, 1, 'auxiliary result does not duplicate the already claimed opportunity');
    assert.equal(h.videoAssessments, 0, 'resource events cannot wake video while its shared category quota is capped');
    assert.equal(h.refreshes, 0, 'cap and unrelated resource event do not request login refresh');
    assert.equal(h.store.get("SELECT state FROM backend_feature_wakes WHERE feature_id='order.resident:delivery'").state, 'cap-wait');
  } finally { h.scheduler.stop(h.context); h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('raising a local limit clears the shared local quota, while an official shared quota remains closed', async () => {
  const local = await harness({ localLimit: 1, withAuxActions: true, periodMs: 8000 });
  try {
    local.scheduler.start(local.context);
    await waitFor(() => local.store.get("SELECT 1 FROM backend_period_suspensions WHERE feature_id='order.resident:delivery'") !== null);
    const current = local.configService.read({ ownerRef: local.context.ownerRef, accountRef: local.context.accountRef });
    current.config.orders.resident.dailyLimit = 2;
    local.configService.save({ ownerRef: local.context.ownerRef, accountRef: local.context.accountRef,
      expectedRevision: current.savedRevision, config: current.config });
    local.scheduler.notify(local.context);
    await waitFor(() => local.assessments === 2 && local.videoAssessments === 1);
    assert.equal(local.store.get("SELECT 1 FROM backend_period_suspensions WHERE feature_id='order.resident:delivery' AND scope='local'"), null);
    assert.equal(local.videoAssessments, 1, 'raising the effective local category quota releases both delivery and video work units');
  } finally { local.scheduler.stop(local.context); local.store.close(); fs.rmSync(local.root, { recursive: true, force: true }); }

  const official = await harness({ localLimit: 1, officialCap: true, withAuxActions: true, periodMs: 8000 });
  try {
    official.scheduler.start(official.context);
    await waitFor(() => official.store.get("SELECT 1 FROM backend_period_suspensions WHERE feature_id='order.resident:delivery' AND scope='official'") !== null);
    const current = official.configService.read({ ownerRef: official.context.ownerRef, accountRef: official.context.accountRef });
    current.config.orders.resident.dailyLimit = 2;
    official.configService.save({ ownerRef: official.context.ownerRef, accountRef: official.context.accountRef,
      expectedRevision: current.savedRevision, config: current.config });
    official.scheduler.notify(official.context);
    await waitFor(() => official.pending.length === 0);
    assert.equal(official.assessments, 1);
    assert.equal(official.videoAssessments, 0, 'a local limit edit cannot release the official category cap for either shared unit');
    assert.equal(official.store.get("SELECT scope FROM backend_period_suspensions WHERE feature_id='order.resident:delivery'").scope, 'official');
  } finally { official.scheduler.stop(official.context); official.store.close(); fs.rmSync(official.root, { recursive: true, force: true }); }
});

test('a restarted scheduler resumes an interrupted assessment attempt without a new external event', async () => {
  const h = await harness({ localLimit: 2, periodMs: 15000 });
  try {
    h.scheduler.start(h.context);
    await waitFor(() => h.assessments === 1);
    const revision = h.configService.read({ ownerRef: h.context.ownerRef, accountRef: h.context.accountRef }).savedRevision;
    const now = new Date().toISOString();
    h.store.run(`INSERT INTO backend_feature_failures VALUES(?,?,?,?,?,?,?)`, h.context.ownerRef, h.context.subjectRef,
      'order.resident', 999, revision, 'TEST_PREVIOUS_FAILURE', now);
    h.store.run(`INSERT INTO backend_feature_replans VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, h.context.ownerRef, h.context.subjectRef,
      'order.resident', String(h.context.accountRef), h.context.ownerEpoch, h.context.runEpoch, h.context.connectionEpoch,
      1, 3, 'attempting', null, revision, 999, 'TEST_INTERRUPTED', '{}', now);
    h.restartScheduler();
    await waitFor(() => h.assessments === 2, 7000);
    assert.equal(h.pending.length, 0, 'the recovery comes from persisted scheduler intent, without a new outbox trigger');
    assert.equal(h.store.get("SELECT status FROM backend_feature_replans WHERE feature_id='order.resident'"), null,
      'the recovered assessment completes and clears its retry record');
  } finally { h.scheduler.stop(h.context); h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('disabling a feature during a cap projects disabled without clearing its cap proof', async () => {
  const h = await harness({ localLimit: 1, officialCap: true, periodMs: 5000 });
  try {
    h.scheduler.start(h.context);
    await waitFor(() => h.store.get("SELECT 1 FROM backend_period_suspensions WHERE feature_id='order.resident'") !== null);
    const latest = h.configService.read({ ownerRef: h.context.ownerRef, accountRef: h.context.accountRef });
    latest.config.orders.resident.enabled = false;
    const changed = h.configService.save({ ownerRef: h.context.ownerRef, accountRef: h.context.accountRef,
      expectedRevision: latest.savedRevision, config: latest.config });
    h.scheduler.notify(h.context);
    await waitFor(() => h.configService.read({ ownerRef: h.context.ownerRef, accountRef: h.context.accountRef }).byFeature['order.resident'].state === 'disabled');
    const wake = h.store.get("SELECT state,config_revision,reason_code FROM backend_feature_wakes WHERE feature_id='order.resident'");
    assert.equal(wake.state, 'disabled');
    assert.equal(wake.reason_code, 'FEATURE_DISABLED');
    assert.equal(wake.config_revision, changed.savedRevision);
    assert.equal(h.store.get("SELECT scope FROM backend_period_suspensions WHERE feature_id='order.resident'").scope, 'official');
    assert.equal(h.assessments, 1, 'disabled feature does not assess or refresh facts');
    assert.equal(h.refreshes, 0);
  } finally { h.scheduler.stop(h.context); h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('stale dynamic facts and resource events cannot refresh or re-assess while a local cap is active', async () => {
  const h = await harness({ localLimit: 1 });
  try {
    h.scheduler.start(h.context);
    await waitFor(() => h.store.get("SELECT 1 FROM backend_period_suspensions WHERE feature_id='order.resident'") !== null);
    h.dynamicState.invalidate({ context: h.context, domains: ['order-flower'], reasonCode: 'TEST_FACTS_DIRTY' });
    assert.equal(h.dynamicState.snapshot({ context: h.context, feature: { featureId: 'order.resident',
      consumedDomains: FEATURE_DOMAINS['order.resident'],
      consumedDomainsFor: () => ['order-flower'] } }).current, false);
    h.addEvent('FactsChanged', { domain: 'land-domain', responseRef: 'fixture:land-change' });
    h.addEvent('ResourceChanged', { resourceKind: 'inventory' });
    h.scheduler.notify(h.context);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(h.assessments, 1);
    assert.equal(h.refreshes, 0, 'period-cap gate precedes ensureCurrent/login refresh');
    assert.equal(h.pending.length, 0, 'relevant facts/resource events are acknowledged with a cap-wait receipt');
  } finally { h.scheduler.stop(h.context); h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});
