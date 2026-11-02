import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createScheduler } from '../runtime/backend/scheduler/service.mjs';
import { createDynamicStateCoordinator } from '../runtime/backend/facts/dynamic-state.mjs';
import { fingerprint } from '../runtime/backend/common.mjs';

test('real dynamic coordinator TTL wakes a long wait and refreshes without FactsChanged', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-real-dynamic-ttl-'));
  const store = openBackendStore({ dataDir: root });
  const initial = Object.freeze({ ownerRef: 'fixture:owner', accountRef: 'fixture:acct', subjectRef: 'fixture:subject', ownerEpoch: 1, runEpoch: 1, connectionEpoch: 1 });
  let active = initial, scheduler, refreshes = 0, assessments = 0, schedulerErrors = [];
  const same = (left, right) => left && right && ['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch']
    .every(key => String(left[key]) === String(right[key]));
  const coverageFor = context => ['land', 'cultivation', 'inventory'].map(domainId => {
    const path = domainId + '.fixture-cell', semanticValue = { [path]: { stable: true } };
    return { domainId, complete: true, paths: [path], semanticValue, semanticFingerprint: fingerprint(semanticValue), observedAtMs: Date.now(),
      cellSources: { [path]: { sourceRef: 'login-' + context.connectionEpoch, method: 'index.login', connectionEpoch: context.connectionEpoch,
        requestSequence: 1, observedAtMs: Date.now(), observedMonotonicMs: Number(process.hrtime.bigint()) / 1e6 } } };
  });
  const observationFor = context => ({ source: 'response', transport: 'answered', envelopeOk: true, dsName: 'G.ISyncData', rejected: false,
    method: 'index.login', connectionEpoch: context.connectionEpoch, requestSequence: 1, responseRef: 'login-' + context.connectionEpoch,
    receivedDeviceMs: Date.now(), receivedMonotonicMs: Number(process.hrtime.bigint()) / 1e6 });
  const feature = { featureId: 'plant', priority: 1, consumedDomains: ['land', 'cultivation', 'inventory'],
    consumedDomainsFor: () => ['land', 'cultivation', 'inventory'],
    assess: async () => { assessments++; if (assessments >= 2) scheduler.stop(active);
      return { state: 'waiting-until', deviceDueMs: Date.now() + 4 * 60 * 60 * 1000, factBasis: {} }; } };
  const registry = { modules: () => [feature], get: id => id === feature.featureId ? feature : null };
  const ledger = { readPendingOutbox: () => [], ackOutbox: () => {} };
  const dynamicState = createDynamicStateCoordinator({ store, isCurrent: context => same(context, active),
    requestRefresh: async ({ context }) => {
      refreshes++;
      const next = Object.freeze({ ...context, connectionEpoch: context.connectionEpoch + 1 }); active = next;
      dynamicState.observe({ context: next, observation: observationFor(next), coverage: coverageFor(next) });
      scheduler.start(next);
      return { newContext: next, refreshed: true };
    } });
  const config = { savedRevision: 1, config: { plantEnabled: true } };
  scheduler = createScheduler({ store, ledger, registry, dynamicState, readConfiguration: () => config,
    acceptConfiguration: () => {}, recordPlan: () => {}, facts: { clock: () => ({ available: false }), snapshot: () => ({}) },
    submitProposal: async () => {}, isCurrent: context => same(context, active), onError: error => schedulerErrors.push(String(error?.stack || error)) });
  try {
    dynamicState.observe({ context: initial, observation: observationFor(initial), coverage: coverageFor(initial) });
    const aged = Number(process.hrtime.bigint()) / 1e6 - 119950;
    store.run('UPDATE backend_dynamic_domain_cells SET observed_monotonic_ms=? WHERE owner_ref=? AND subject_ref=? AND connection_epoch=?',
      aged, initial.ownerRef, initial.subjectRef, initial.connectionEpoch);
    assert.ok(dynamicState.snapshot({ context: initial, feature, config: config.config }).domains.every(domain => domain.nextCheckAtMs < Date.now() + 1000),
      JSON.stringify(store.all('SELECT observed_monotonic_ms,instance_ref FROM backend_dynamic_domain_cells')));
    scheduler.start(initial);
    const deadline = Date.now() + 2500;
    while ((assessments < 2 || refreshes < 1) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(refreshes, 1, 'real coordinator TTL causes a normal refresh without an outbox event; ' + JSON.stringify({ assessments, schedulerErrors,
      snapshot: dynamicState.snapshot({ context: active, feature, config: config.config }), wakes: store.all('SELECT * FROM backend_feature_wakes'), replans: store.all('SELECT * FROM backend_feature_replans') }));
    assert.equal(assessments, 2, 'scheduler resumes assessment on the fresh connection context');
    assert.deepEqual(ledger.readPendingOutbox(), []);
  } finally { scheduler.stop(active); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('scheduler waits on a missing typed domain and resumes after its automatic retry without an external event', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-dynamic-domain-retry-'));
  const store = openBackendStore({ dataDir: root });
  const initial = Object.freeze({ ownerRef: 'fixture:owner', accountRef: 'fixture:acct', subjectRef: 'fixture:subject',
    ownerEpoch: 1, runEpoch: 1, connectionEpoch: 1 });
  let active = initial, scheduler, refreshes = 0, assessments = 0, errors = [];
  const same = (left, right) => left && right && ['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch']
    .every(key => String(left[key]) === String(right[key]));
  const feature = { featureId: 'plant', priority: 1, consumedDomains: ['land', 'cultivation', 'inventory'],
    consumedDomainsFor: () => ['land'], assess: async () => { assessments++; scheduler.stop(active); return { state: 'no-action' }; } };
  const registry = { modules: () => [feature], get: id => id === feature.featureId ? feature : null };
  const ledger = { readPendingOutbox: () => [], ackOutbox: () => {} };
  const config = { savedRevision: 1, config: { plantEnabled: true } };
  const observation = context => ({ source: 'response', transport: 'answered', envelopeOk: true, dsName: 'G.ISyncData',
    rejected: false, method: 'index.login', connectionEpoch: context.connectionEpoch, requestSequence: 1,
    responseRef: 'retry-login-' + context.connectionEpoch, receivedDeviceMs: Date.now(), receivedMonotonicMs: Number(process.hrtime.bigint()) / 1e6,
    currentIdentity: { verified: true, officialUid: 777, responseRef: 'retry-login-' + context.connectionEpoch } });
  const coverage = (context, complete) => {
    const cellPath = 'land.fixture'; const semanticValue = { [cellPath]: { ready: true } };
    return [{ domainId: 'land', complete, paths: [cellPath], semanticValue, semanticFingerprint: fingerprint(semanticValue),
      observedAtMs: Date.now(), cellSources: { [cellPath]: { sourceRef: 'retry-login-' + context.connectionEpoch,
        method: 'index.login', connectionEpoch: context.connectionEpoch, requestSequence: 1,
        observedAtMs: Date.now(), observedMonotonicMs: Number(process.hrtime.bigint()) / 1e6 } } }];
  };
  const dynamicState = createDynamicStateCoordinator({ store, isCurrent: context => same(context, active), refreshRetryBaseMs: 40,
    refreshRetryMaxMs: 160, requestRefresh: async ({ context }) => {
      refreshes++;
      const next = Object.freeze({ ...context, connectionEpoch: context.connectionEpoch + 1 }); active = next;
      dynamicState.observe({ context: next, observation: observation(next), coverage: coverage(next, refreshes > 1) });
      scheduler.start(next);
      return { newContext: next, refreshed: true, responseRef: 'retry-login-' + next.connectionEpoch };
    } });
  scheduler = createScheduler({ store, ledger, registry, dynamicState, readConfiguration: () => config,
    acceptConfiguration: () => {}, recordPlan: () => {}, facts: { clock: () => ({ available: false }), snapshot: () => ({}) },
    submitProposal: async () => {}, isCurrent: context => same(context, active), onError: error => errors.push(String(error?.stack || error)) });
  try {
    scheduler.start(initial);
    const deadline = Date.now() + 2000;
    while ((refreshes < 2 || assessments < 1) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(refreshes, 2, 'a missing domain is re-read at its durable deadline, not in an immediate login loop');
    assert.equal(assessments, 1, 'the enabled consumer resumes once typed coverage becomes current');
    assert.deepEqual(errors, [], 'missing optional typed coverage waits instead of becoming a feature failure');
  } finally { scheduler.stop(active); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('an action discovered during assessment requests only its declared optional domains through the shared refresh', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-action-refresh-domain-'));
  const store = openBackendStore({ dataDir: root });
  const initial = Object.freeze({ ownerRef: 'fixture:owner', accountRef: 'fixture:acct', subjectRef: 'fixture:subject',
    ownerEpoch: 1, runEpoch: 1, connectionEpoch: 1 });
  let active = initial, scheduler, refreshes = 0, assessments = 0, errors = [];
  const same = (left, right) => left && right && ['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch']
    .every(key => String(left[key]) === String(right[key]));
  const feature = { featureId: 'plant', priority: 1, consumedDomains: ['land', 'cultivation', 'inventory'],
    consumedDomainsFor: () => ['land'], assess: async () => {
      assessments++;
      if (assessments === 1) return { state: 'waiting-facts', reasonCode: 'ACTION_OPTIONAL_DOMAIN_REQUIRED', refreshDomains: ['land-top'] };
      scheduler.stop(active);
      return { state: 'no-action' };
    } };
  const registry = { modules: () => [feature], get: id => id === feature.featureId ? feature : null };
  const ledger = { readPendingOutbox: () => [], ackOutbox: () => {} };
  const config = { savedRevision: 1, config: { plantEnabled: true } };
  const makeObservation = context => ({ source: 'response', transport: 'answered', envelopeOk: true, dsName: 'G.ISyncData', rejected: false,
    method: 'index.login', connectionEpoch: context.connectionEpoch, requestSequence: 1, responseRef: 'action-login-' + context.connectionEpoch,
    receivedDeviceMs: Date.now(), receivedMonotonicMs: Number(process.hrtime.bigint()) / 1e6,
    currentIdentity: { verified: true, officialUid: 778, responseRef: 'action-login-' + context.connectionEpoch } });
  const makeCoverage = context => ['land', 'land-top'].map(domainId => {
    const path = domainId + '.fixture', semanticValue = { [path]: { ready: true } }, now = Date.now(), mono = Number(process.hrtime.bigint()) / 1e6;
    return { domainId, complete: true, paths: [path], semanticValue, semanticFingerprint: fingerprint(semanticValue), observedAtMs: now,
      cellSources: { [path]: { sourceRef: 'action-login-' + context.connectionEpoch, method: 'index.login',
        connectionEpoch: context.connectionEpoch, requestSequence: 1, observedAtMs: now, observedMonotonicMs: mono } } };
  });
  const dynamicState = createDynamicStateCoordinator({ store, isCurrent: context => same(context, active), requestRefresh: async ({ context, domains }) => {
    refreshes++;
    assert.deepEqual(domains, ['land-top']);
    const next = Object.freeze({ ...context, connectionEpoch: context.connectionEpoch + 1 }); active = next;
    dynamicState.observe({ context: next, observation: makeObservation(next), coverage: makeCoverage(next) });
    scheduler.start(next);
    return { newContext: next, refreshed: true, responseRef: 'action-login-' + next.connectionEpoch };
  } });
  const schedulerConfig = { savedRevision: 1, config: { plantEnabled: true } };
  scheduler = createScheduler({ store, ledger, registry, dynamicState, readConfiguration: () => schedulerConfig,
    acceptConfiguration: () => {}, recordPlan: () => {}, facts: { clock: () => ({ available: false }), snapshot: () => ({}) },
    submitProposal: async () => {}, isCurrent: context => same(context, active), onError: error => errors.push(String(error?.stack || error)) });
  try {
    const now = Date.now(), mono = Number(process.hrtime.bigint()) / 1e6, semanticValue = { 'land.fixture': { ready: true } };
    dynamicState.observe({ context: initial, observation: makeObservation(initial), coverage: [{ domainId: 'land', complete: true,
      paths: ['land.fixture'], semanticValue, semanticFingerprint: fingerprint(semanticValue), observedAtMs: now,
      cellSources: { 'land.fixture': { sourceRef: 'action-login-1', method: 'index.login', connectionEpoch: 1,
        requestSequence: 1, observedAtMs: now, observedMonotonicMs: mono } } }] });
    scheduler.start(initial);
    const deadline = Date.now() + 1500;
    while ((refreshes < 1 || assessments < 2) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(refreshes, 1, 'a candidate-only domain is fetched through the shared refresh coordinator');
    assert.equal(assessments, 2, 'the old candidate is discarded and the new context is reassessed');
    assert.deepEqual(errors, []);
  } finally { scheduler.stop(active); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('long business waits wake again at the consumed fact TTL without a new event', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-scheduler-freshness-'));
  const store = openBackendStore({ dataDir: root });
  const context = Object.freeze({ ownerRef: 'fixture:owner', accountRef: 'fixture:acct', subjectRef: 'fixture:subject',
    ownerEpoch: 1, runEpoch: 1, connectionEpoch: 1 });
  let assessments = 0;
  let scheduler;
  const feature = { featureId: 'fixture.long-wait', priority: 1, factRequirements: [],
    assess: async () => {
      assessments++;
      if (assessments >= 2) scheduler.stop(context);
      return { state: 'waiting-until', deviceDueMs: Date.now() + 4 * 60 * 60 * 1000, factBasis: {} };
    } };
  const registry = { modules: () => [feature], get: id => id === feature.featureId ? feature : null };
  const ledger = { readPendingOutbox: () => [], ackOutbox: () => {} };
  const config = { savedRevision: 1, config: {} };
  const dynamicState = { snapshot: () => ({ current: true, nextCheckAtMs: Date.now() + 35, domains: [] }),
    ensureCurrent: async () => ({ current: true }) };
  scheduler = createScheduler({ store, ledger, registry, dynamicState,
    readConfiguration: () => config, acceptConfiguration: () => {}, recordPlan: () => {},
    facts: { clock: () => ({ available: false }), snapshot: () => ({}) }, submitProposal: async () => {},
    isCurrent: () => true, onError: error => { throw error; } });
  try {
    scheduler.start(context);
    const deadline = Date.now() + 1500;
    while (assessments < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(assessments, 2, 'the TTL deadline causes a second assessment without FactsChanged or another outbox event');
    assert.deepEqual(ledger.readPendingOutbox(), [], 'no external event was needed to wake the feature');
  } finally {
    scheduler.stop(context);
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('wall-clock rollback followed by notify preserves the original monotonic fact deadline', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-scheduler-clock-rollback-'));
  const store = openBackendStore({ dataDir: root });
  const context = Object.freeze({ ownerRef: 'fixture:owner', accountRef: 'fixture:acct', subjectRef: 'fixture:subject',
    ownerEpoch: 1, runEpoch: 1, connectionEpoch: 1 });
  let wallNow = Date.now(), assessments = 0, scheduler;
  const feature = { featureId: 'fixture.clock-rollback', priority: 1, factRequirements: [],
    assess: async () => {
      assessments++;
      if (assessments >= 2) scheduler.stop(context);
      return { state: 'waiting-until', deviceDueMs: wallNow + 4 * 60 * 60 * 1000, factBasis: {} };
    } };
  const registry = { modules: () => [feature], get: id => id === feature.featureId ? feature : null };
  const ledger = { readPendingOutbox: () => [], ackOutbox: () => {} };
  const config = { savedRevision: 1, config: {} };
  const dynamicState = { snapshot: () => ({ current: true, nextCheckAtMs: wallNow + 180, domains: [] }),
    ensureCurrent: async () => ({ current: true }) };
  scheduler = createScheduler({ store, ledger, registry, dynamicState,
    readConfiguration: () => config, acceptConfiguration: () => {}, recordPlan: () => {},
    facts: { clock: () => ({ available: false }), snapshot: () => ({}) }, submitProposal: async () => {},
    deviceNow: () => wallNow, isCurrent: () => true });
  try {
    scheduler.start(context);
    const deadline = Date.now() + 1200;
    while (assessments < 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(assessments, 1);
    wallNow -= 6 * 60 * 60 * 1000;
    scheduler.notify(context);
    const monotonicDeadline = Date.now() + 1200;
    while (assessments < 2 && Date.now() < monotonicDeadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(assessments, 2, 'notify and timer re-arm use the saved monotonic deadline after wall time moves backwards');
  } finally {
    scheduler.stop(context);
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
