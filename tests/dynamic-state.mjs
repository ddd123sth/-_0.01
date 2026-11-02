import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createDynamicStateCoordinator, DYNAMIC_DOMAIN_MANIFEST, affectedDomainsForWrite } from '../runtime/backend/facts/dynamic-state.mjs';
import { fingerprint } from '../runtime/backend/common.mjs';
import { orderFlowerDynamicDomains } from '../runtime/backend/features/order-flower/runtime.mjs';

const base = Object.freeze({ ownerRef: 'owner-a', accountRef: '3', subjectRef: 'subject-a', ownerEpoch: 1, runEpoch: 7, connectionEpoch: 11 });
const feature = Object.freeze({ featureId: 'plant', consumedDomains: ['land', 'cultivation', 'inventory'],
  consumedDomainsFor: ({ config }) => config?.plantMode === 'chosen_top' ? ['land', 'land-top', 'cultivation', 'inventory'] : ['land', 'cultivation', 'inventory'] });
function harness(requestRefresh = null, coordinatorOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-dynamic-'));
  const store = openBackendStore({ dataDir: dir });
  let now = 1000, mono = 1000, active = base;
  const coordinator = createDynamicStateCoordinator({ store, isCurrent: ctx => JSON.stringify(ctx) === JSON.stringify(active),
    deviceNow: () => now, monotonicNow: () => mono, requestRefresh, ...coordinatorOptions });
  const close = () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  const observation = (ctx, seq, ref, source = 'response') => ({ source: source === 'push' ? 'push' : 'response', transport: 'answered', envelopeOk: true,
    dsName: 'G.ISyncData', rejected: false, connectionEpoch: ctx.connectionEpoch, requestSequence: seq,
    responseRef: ref, method: source === 'login' ? 'index.login' : 'usr.heartTick', receivedDeviceMs: now, receivedMonotonicMs: mono,
    ...(source === 'login' ? { wireKey: `ws|1|${seq}`, value: { '7': { '0': { '0': 777 } } },
      currentIdentity: { verified: true, officialUid: 777, responseRef: ref } } : {}) });
  const coverage = (domainId, semanticFingerprint = 'fp-1', complete = true, sourceRef = 'fixture:cell', sequence = 20, connectionEpoch = base.connectionEpoch, method = 'usr.heartTick') => {
    const paths = ['test.' + domainId];
    const semanticValue = { [paths[0]]: { domainId, semanticFingerprint } };
    return { domainId, complete, paths, semanticValue, semanticFingerprint: fingerprint(semanticValue), observedAtMs: now,
      cellSources: { [paths[0]]: { sourceRef, method, connectionEpoch,
        requestSequence: sequence, observedAtMs: now, observedMonotonicMs: mono } } };
  };
  const coveragePaths = (domainId, paths, sourceRef = 'fixture:cell', sequence = 20, connectionEpoch = base.connectionEpoch, method = 'usr.heartTick') => {
    const semanticValue = Object.fromEntries(paths.map((path, index) => [path, path === 'profile.uid' ? 777 : { path, index }]));
    const cellSources = Object.fromEntries(paths.map(path => [path, { sourceRef, method, connectionEpoch,
      requestSequence: sequence, observedAtMs: now, observedMonotonicMs: mono }]));
    return { domainId, complete: true, paths, semanticValue, semanticFingerprint: fingerprint(semanticValue), observedAtMs: now, cellSources };
  };
  const plantCoverage = (ref, sequence, epoch = base.connectionEpoch, includeTop = true) => ['land', ...(includeTop ? ['land-top'] : []), 'cultivation', 'inventory']
    .map(domain => coverage(domain, 'fp-' + domain + '-' + ref, true, ref, sequence, epoch));
  return { coordinator, store, close, now: value => { now = value; }, mono: value => { mono = value; }, active: value => { active = value; }, observation, coverage, coveragePaths, plantCoverage };
}

test('unmatched-order push only dirties current domains and never overwrites their heads', () => {
  const h = harness();
  try {
    h.coordinator.observe({ context: base, observation: h.observation(base, 20, 'r20'), coverage: h.plantCoverage('r20', 20) });
    const before = h.coordinator.head(base, 'land');
    const pushed = h.coordinator.observe({ context: base, observation: { ...h.observation(base, 99, 'push-1', 'push'), transport: 'push' } });
    assert.equal(pushed.dirty.includes('land'), true);
    assert.equal(h.coordinator.head(base, 'land').source_ref, before.source_ref);
    assert.equal(h.coordinator.snapshot({ context: base, feature }).current, false);
  } finally { h.close(); }
});

test('older response and incomplete coverage cannot make a dynamic domain current', () => {
  const h = harness();
  try {
    h.coordinator.observe({ context: base, observation: h.observation(base, 20, 'r20'), coverage: h.plantCoverage('r20', 20) });
    h.coordinator.observe({ context: base, observation: h.observation(base, 19, 'r19'), coverage: [h.coverage('land', 'fp-19')] });
    assert.equal(h.coordinator.head(base, 'land').source_ref, 'r20');
    h.coordinator.observe({ context: base, observation: h.observation(base, 21, 'r21'), coverage: [h.coverage('inventory', 'partial', false)] });
    assert.equal(h.coordinator.snapshot({ context: base, feature }).current, false);
    assert.equal(h.coordinator.dirty(base, 'inventory').reason_code, 'DYNAMIC_DOMAIN_COVERAGE_INCOMPLETE');
  } finally { h.close(); }
});

test('same-login profile subset replay is a no-op only with the exact raw anchor and prior full projection receipt', () => {
  const h = harness();
  try {
    const loginRef = 'login-profile-subset';
    const login = { ...h.observation(base, 1, loginRef, 'login'), source: 'response', method: 'index.login',
      wireKey: 'ws|1|1', value: { '7': { '0': { '0': 777 } } },
      currentIdentity: { verified: true, officialUid: 777, responseRef: loginRef } };
    const allPaths = ['profile.uid', 'profile.cTime', 'profile.chnId', 'profile.domain', 'profile.gold', 'profile.level',
      'profile.loginChnId', 'profile.lvlExp', 'profile.vip', 'profile.vipExp', 'profile.yuanbao'];
    const coverage = (paths, override = {}) => {
      const semanticValue = Object.fromEntries(paths.map(path => [path, path === 'profile.uid' ? 777 : { path, value: path }]));
      Object.assign(semanticValue, override);
      return { domainId: 'profile', complete: true, paths, semanticValue, semanticFingerprint: fingerprint(semanticValue), observedAtMs: 1000,
        cellSources: Object.fromEntries(paths.map(path => [path, { sourceRef: loginRef, method: 'index.login', connectionEpoch: base.connectionEpoch,
          requestSequence: 1, observedAtMs: 1000, observedMonotonicMs: 1000 }])) };
    };
    const first = h.coordinator.observe({ context: base, observation: login, coverage: [coverage(allPaths)] });
    assert.equal(first.accepted, true);
    const originalHead = h.coordinator.head(base, 'profile');
    assert.ok(originalHead);
    h.now(2000); h.mono(2000);
    assert.doesNotThrow(() => h.coordinator.observe({ context: base, observation: login,
      coverage: [coverage(allPaths.filter(path => !['profile.chnId', 'profile.domain', 'profile.loginChnId', 'profile.vip'].includes(path)))] }));
    const afterSubset = h.coordinator.head(base, 'profile');
    assert.equal(afterSubset.semantic_revision, originalHead.semantic_revision);
    assert.equal(afterSubset.observed_at_ms, originalHead.observed_at_ms);
    assert.equal(h.coordinator.dirty(base, 'profile'), null);

    assert.throws(() => h.coordinator.observe({ context: base, observation: login,
      coverage: [coverage(allPaths.filter(path => path !== 'profile.chnId'), { 'profile.gold': { changed: true } })] }),
    error => error.code === 'DYNAMIC_RESPONSE_REF_CONFLICT');
    const extended = [...allPaths, 'profile.extra'];
    assert.throws(() => h.coordinator.observe({ context: base, observation: login, coverage: [coverage(extended)] }),
      error => error.code === 'DYNAMIC_RESPONSE_REF_BASELINE_MISSING');
  } finally { h.close(); }
});

test('write barrier is set at dispatch and remains until exact typed write scope or full login is proved', () => {
  const h = harness();
  try {
    h.coordinator.observe({ context: base, observation: h.observation(base, 20, 'r20'), coverage: h.plantCoverage('r20', 20) });
    h.coordinator.beforeDispatch({ context: base, proposal: { ...base, featureId: 'plant', method: 'usrLand.plant',
      affectedDomains: affectedDomainsForWrite('plant', 'usrLand.plant'), operationId: 'op-1' }, binding: { requestSequence: 21, connectionEpoch: 11, wireKey: 'wire-1' } });
    assert.equal(h.coordinator.dirty(base, 'land').request_sequence, 21);
    h.coordinator.observe({ context: base, observation: { ...h.observation(base, 21, 'r21'), method: 'usrLand.plant', operationId: 'op-1' },
      coverage: [{ ...h.coverage('land'), operationId: 'op-1' }] });
    assert.equal(h.coordinator.dirty(base, 'land').operation_id, 'op-1');
    assert.equal(h.coordinator.head(base, 'land').source_ref, 'r21');
    const next = Object.freeze({ ...base, connectionEpoch: 12 }); h.active(next);
    h.coordinator.observe({ context: next, observation: { ...h.observation(next, 1, 'login-12', 'login'),
      currentIdentity: { verified: true, officialUid: 777, responseRef: 'login-12' } },
      coverage: h.plantCoverage('login-12', 1, 12) });
    assert.equal(h.coordinator.dirty(next, 'land'), null);
  } finally { h.close(); }
});

test('new connection context is stale until its own complete projection arrives', () => {
  const h = harness();
  try {
    h.coordinator.observe({ context: base, observation: h.observation(base, 20, 'r20'), coverage: h.plantCoverage('r20', 20) });
    const next = Object.freeze({ ...base, connectionEpoch: 12 });
    h.active(next);
    assert.equal(h.coordinator.snapshot({ context: next, feature }).current, false);
    h.coordinator.observe({ context: next, observation: h.observation(next, 1, 'login-12', 'login'),
      coverage: h.plantCoverage('login-12', 1, 12) });
    assert.equal(h.coordinator.snapshot({ context: next, feature }).current, true);
    assert.equal(h.coordinator.snapshot({ context: next, feature }).domains.find(one => one.domainId === 'land').current, true);
  } finally { h.close(); }
});

test('shared current-need snapshot binds current typed sources to the accepted login identity anchor', () => {
  const h = harness();
  try {
    h.coordinator.observe({ context: base, observation: { ...h.observation(base, 1, 'login-current', 'login'),
      currentIdentity: { verified: true, officialUid: 777, responseRef: 'login-current' },
      versionEvidence: { gameVersion: '480.0.27', protocolVersion: '480.0.0' } },
      coverage: h.plantCoverage('login-current', 1, base.connectionEpoch) });
    const snapshot = h.coordinator.currentNeedSnapshot({ context: base, feature });
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.identityVerified, true);
    assert.equal(snapshot.method, 'index.login');
    assert.equal(snapshot.responseRef, 'login-current');
    assert.equal(snapshot.officialUid, 777);
    assert.equal(snapshot.gameVersion, '480.0.27');
    assert.ok(snapshot.sourceProofs.some(one => one.method === 'usr.heartTick' && one.responseRef === 'login-current'));
    h.coordinator.beforeDispatch({ context: base, proposal: { ...base, featureId: 'plant', method: 'usrLand.plant',
      affectedDomains: affectedDomainsForWrite('plant', 'usrLand.plant'), operationId: 'op-current-need' },
      binding: { requestSequence: 2, connectionEpoch: base.connectionEpoch, wireKey: 'wire-current-need' } });
    assert.equal(h.coordinator.currentNeedSnapshot({ context: base, feature }).complete, false);
  } finally { h.close(); }
});

test('refresh flight is shared across a reconnect and an incomplete result gets a durable retry deadline', async () => {
  let h, calls = 0;
  const next = Object.freeze({ ...base, connectionEpoch: 12 });
  const retryFeature = { ...feature, consumedDomainsFor: () => ['land'] };
  h = harness(async ({ refreshRef, context }) => {
    calls++;
    const refreshedContext = Object.freeze({ ...context, connectionEpoch: context.connectionEpoch + 1 });
    h.active(refreshedContext);
    h.coordinator.observe({ context: refreshedContext, observation: { ...h.observation(refreshedContext, calls, refreshRef, 'login'),
      currentIdentity: { verified: true, officialUid: 777, responseRef: refreshRef } },
      coverage: [h.coverage('land', 'land-' + calls, calls > 1, refreshRef, calls, refreshedContext.connectionEpoch, 'index.login')] });
    return { newContext: refreshedContext, refreshed: true, responseRef: refreshRef };
  });
  try {
    const first = await h.coordinator.ensureCurrent({ context: base, feature: retryFeature });
    assert.equal(first.current, false, 'an incomplete projection does not become current');
    assert.equal(Number.isSafeInteger(first.retryAtMs), true);
    assert.equal(calls, 1);
    const current = Object.freeze({ ...base, connectionEpoch: 12 });
    const waiting = await h.coordinator.ensureCurrent({ context: current, feature: retryFeature });
    assert.equal(waiting.reasonCode, 'DYNAMIC_DOMAIN_REFRESH_BACKOFF');
    assert.equal(calls, 1, 'a missing domain cannot cause an immediate second login');
    h.mono(31000); h.now(31000);
    const recovered = await h.coordinator.ensureCurrent({ context: current, feature: retryFeature });
    assert.equal(recovered.current, true);
    assert.equal(calls, 2, 'the persisted retry becomes eligible at its monotonic deadline');
  } finally { h.close(); }
});

test('incomplete refresh cooldown is shared across distinct feature domains and reconnect epochs', async () => {
  let h, restarted, calls = 0, restartedAt = 1000, currentContext = base;
  h = harness(async ({ context, refreshRef }) => {
    calls++;
    const next = Object.freeze({ ...context, connectionEpoch: context.connectionEpoch + 1 });
    h.active(next);
    currentContext = next;
    h.coordinator.observe({ context: next, observation: { ...h.observation(next, 1, refreshRef, 'login'),
      currentIdentity: { verified: true, officialUid: 777, responseRef: refreshRef } },
      coverage: calls === 1 ? [] : h.plantCoverage(refreshRef, 1, next.connectionEpoch, false) });
    return { newContext: next, refreshed: true, responseRef: refreshRef };
  });
  const domainFeature = { ...feature, consumedDomainsFor: ({ config }) => config?.top ? ['land', 'land-top', 'cultivation', 'inventory'] : ['land', 'cultivation', 'inventory'] };
  try {
    const first = await h.coordinator.ensureCurrent({ context: base, feature: domainFeature, config: { top: false } });
    assert.equal(first.current, false);
    assert.equal(calls, 1);
    const next = Object.freeze({ ...base, connectionEpoch: 12 });
    currentContext = next;
    restarted = createDynamicStateCoordinator({ store: h.store, isCurrent: context => JSON.stringify(context) === JSON.stringify(currentContext),
      deviceNow: () => restartedAt, monotonicNow: () => restartedAt,
      requestRefresh: async ({ context, refreshRef }) => {
        calls++;
        const refreshedContext = Object.freeze({ ...context, connectionEpoch: context.connectionEpoch + 1 });
        currentContext = refreshedContext; h.active(refreshedContext);
        restarted.observe({ context: refreshedContext, observation: { ...h.observation(refreshedContext, 1, refreshRef, 'login'),
          currentIdentity: { verified: true, officialUid: 777, responseRef: refreshRef } },
          coverage: h.plantCoverage(refreshRef, 1, refreshedContext.connectionEpoch, false) });
        return { newContext: refreshedContext, refreshed: true, responseRef: refreshRef };
      } });
    const otherDomain = await restarted.ensureCurrent({ context: next, feature: domainFeature, config: { top: true } });
    assert.equal(otherDomain.reasonCode, 'DYNAMIC_DOMAIN_REFRESH_BACKOFF');
    assert.equal(otherDomain.retryAtMs, first.retryAtMs);
    assert.equal(calls, 1, 'a different feature after coordinator reconstruction cannot trigger login during the persisted subject cooldown');
    restartedAt = 31000;
    const due = await restarted.ensureCurrent({ context: next, feature: domainFeature, config: { top: false } });
    assert.equal(due.current, true, `due retry should accept its fresh land evidence: ${due.reasonCode} ${JSON.stringify(due.snapshot?.domains)}`);
    assert.equal(calls, 2, 'the persistent cooldown permits a bounded retry when due');
    const afterSuccessfulRefresh = await restarted.ensureCurrent({ context: currentContext, feature: domainFeature, config: { top: true } });
    assert.equal(afterSuccessfulRefresh.reasonCode, 'DYNAMIC_DOMAIN_REFRESH_BACKOFF');
    assert.equal(afterSuccessfulRefresh.retryAtMs, 61000, 'a successful refresh resets the normal subject interval to 30 seconds');
    assert.equal(calls, 2, 'late different-domain work units share the post-success minimum interval');
  } finally { h.close(); }
});

test('reconnect contexts join one in-flight refresh instead of starting duplicate logins', async () => {
  let h, calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const next = Object.freeze({ ...base, connectionEpoch: 12 });
  const retryFeature = { ...feature, consumedDomainsFor: () => ['land'] };
  h = harness(async ({ refreshRef, context }) => {
    calls++;
    const refreshedContext = Object.freeze({ ...context, connectionEpoch: context.connectionEpoch + 1 });
    h.active(Object.freeze({ ...base, connectionEpoch: 12 }));
    await gate;
    h.active(refreshedContext);
    h.coordinator.observe({ context: refreshedContext, observation: { ...h.observation(refreshedContext, 1, refreshRef, 'login'),
      currentIdentity: { verified: true, officialUid: 777, responseRef: refreshRef } },
      coverage: [h.coverage('land', 'land-current', true, refreshRef, 1, refreshedContext.connectionEpoch, 'index.login')] });
    return { newContext: refreshedContext, refreshed: true, responseRef: refreshRef };
  });
  try {
    const oldContextRefresh = h.coordinator.ensureCurrent({ context: base, feature: retryFeature });
    await new Promise(resolve => setImmediate(resolve));
    const newContextRefresh = h.coordinator.ensureCurrent({ context: Object.freeze({ ...base, connectionEpoch: 12 }), feature: retryFeature });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1, 'new scheduler context must join the owner/subject flight');
    release();
    const [oldResult, newResult] = await Promise.all([oldContextRefresh, newContextRefresh]);
    assert.equal(oldResult.current, true);
    assert.equal(newResult.current, true);
    assert.equal(calls, 1);
  } finally { h.close(); }
});

test('an aborted old scheduler cannot cancel refresh progress or trigger an immediate late-context login', async () => {
  let h, calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const current = Object.freeze({ ...base, connectionEpoch: 12 });
  const retryFeature = { ...feature, consumedDomainsFor: () => ['land'] };
  h = harness(async ({ refreshRef }) => {
    calls++;
    h.active(current);
    await gate;
    h.coordinator.observe({ context: current, observation: { ...h.observation(current, 1, refreshRef, 'login'),
      currentIdentity: { verified: true, officialUid: 777, responseRef: refreshRef } },
      coverage: [h.coverage('land', 'still-incomplete', false, refreshRef, 1, current.connectionEpoch, 'index.login')] });
    return { newContext: current, refreshed: true, responseRef: refreshRef };
  });
  try {
    const abort = new AbortController();
    const oldWaiter = h.coordinator.ensureCurrent({ context: base, feature: retryFeature, signal: abort.signal });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.store.get('SELECT COUNT(*) AS count FROM backend_dynamic_refresh_domain_retry').count, 1,
      'the missing-domain retry gate is durable before refresh is awaited');
    abort.abort();
    release();
    assert.equal((await oldWaiter).reasonCode, 'DYNAMIC_REFRESH_CANCELLED');
    const lateScheduler = await h.coordinator.ensureCurrent({ context: current, feature: retryFeature });
    assert.equal(lateScheduler.reasonCode, 'DYNAMIC_DOMAIN_REFRESH_BACKOFF');
    assert.equal(calls, 1, 'a scheduler arriving after the old flight closes observes its persisted retry gate');
  } finally { h.close(); }
});

test('refresh busy before reading facts uses a short availability wake without counting a failed fact read', async () => {
  let h, calls = 0;
  const next = Object.freeze({ ...base, connectionEpoch: 12 });
  const retryFeature = { ...feature, consumedDomainsFor: () => ['land'] };
  h = harness(async ({ refreshRef }) => {
    calls++;
    if (calls === 1) return { accepted: false, refreshed: false, reasonCode: 'SESSION_SNAPSHOT_REFRESH_WRITE_BUSY' };
    h.active(next);
    h.coordinator.observe({ context: next, observation: { ...h.observation(next, 1, refreshRef, 'login'),
      currentIdentity: { verified: true, officialUid: 777, responseRef: refreshRef } },
      coverage: [h.coverage('land', 'land-after-write', true, refreshRef, 1, next.connectionEpoch, 'index.login')] });
    return { accepted: true, newContext: next, refreshed: true, responseRef: refreshRef };
  }, { refreshBusyRetryMs: 20 });
  try {
    const busy = await h.coordinator.ensureCurrent({ context: base, feature: retryFeature });
    assert.equal(busy.reasonCode, 'SESSION_SNAPSHOT_REFRESH_WRITE_BUSY');
    assert.equal(busy.retryAtMs, 1020);
    const row = h.store.get('SELECT attempt,reason_code FROM backend_dynamic_refresh_domain_retry WHERE domain_id=?', 'land');
    assert.equal(row.attempt, 0, 'a request refused before reading does not increment missing-read attempts');
    assert.match(row.reason_code, /^DYNAMIC_REFRESH_BUSY:/);
    h.mono(1021); h.now(1021);
    const recovered = await h.coordinator.ensureCurrent({ context: base, feature: retryFeature });
    assert.equal(recovered.current, true);
    assert.equal(calls, 2);
  } finally { h.close(); }
});

test('verified alias login clears prior-account dirty barriers without accepting old epoch or mismatched UID', () => {
  const h = harness();
  try {
    const withProfile = (ctx, ref, seq, uid, method) => {
      const value = { 'profile.uid': uid }, path = 'profile.uid';
      const source = { sourceRef: ref, method, connectionEpoch: ctx.connectionEpoch, requestSequence: seq,
        observedAtMs: 1000, observedMonotonicMs: 1000 };
      return { domainId: 'profile', complete: true, paths: [path], semanticValue: value,
        semanticFingerprint: fingerprint(value), cellSources: { [path]: source }, observedAtMs: 1000 };
    };
    const baseLogin = { ...h.observation(base, 1, 'alias-old-login', 'login'), currentIdentity: {
      verified: true, officialUid: 777, responseRef: 'alias-old-login' } };
    const cellsFor = (ctx, ref, seq, uid) => [withProfile(ctx, ref, seq, uid, 'index.login'),
      ...h.plantCoverage(ref, seq, ctx.connectionEpoch).map(item => {
        for (const source of Object.values(item.cellSources)) source.method = 'index.login';
        return item;
      })];
    h.coordinator.observe({ context: base, observation: baseLogin, coverage: cellsFor(base, 'alias-old-login', 1, 777) });
    h.coordinator.invalidate({ context: base, domains: ['profile', 'land', 'land-top', 'cultivation', 'inventory'],
      reasonCode: 'WRITE_MAY_HAVE_CHANGED_DOMAIN', operationId: 'alias-write', requestSequence: 2 });
    const next = Object.freeze({ ...base, accountRef: 'new-account-ref', ownerEpoch: 2, runEpoch: 1, connectionEpoch: 12 }); h.active(next);
    const login = { ...h.observation(next, 1, 'alias-new-login', 'login'), currentIdentity: {
      verified: true, officialUid: 777, responseRef: 'alias-new-login' } };
    const coverage = cellsFor(next, 'alias-new-login', 1, 777);
    const accepted = h.coordinator.observe({ context: next, observation: login, coverage });
    assert.equal(accepted.accepted, true);
    for (const domain of ['profile', 'land', 'land-top', 'cultivation', 'inventory'])
      assert.equal(h.coordinator.dirty(next, domain), null, 'same UID and higher owner/connection epochs clear old alias barrier for ' + domain);
    h.coordinator.invalidate({ context: next, domains: ['profile', 'land', 'land-top', 'cultivation', 'inventory'],
      reasonCode: 'WRITE_MAY_HAVE_CHANGED_DOMAIN', operationId: 'alias-write-2', requestSequence: 2 });
    const wrong = { ...h.observation(Object.freeze({ ...next, connectionEpoch: 13 }), 1, 'alias-wrong-login', 'login'),
      value: { '7': { '0': { '0': 999 } } }, currentIdentity: { verified: true, officialUid: 999, responseRef: 'alias-wrong-login' } };
    const wrongContext = Object.freeze({ ...next, connectionEpoch: 13 }); h.active(wrongContext);
    const wrongCoverage = cellsFor(wrongContext, 'alias-wrong-login', 1, 999);
    const result = h.coordinator.observe({ context: wrongContext, observation: wrong, coverage: wrongCoverage.reverse() });
    assert.equal(result.accepted, false);
    assert.equal(result.reasonCode, 'DYNAMIC_STABLE_UID_MISMATCH');
    assert.equal(h.coordinator.head(wrongContext, 'profile').source_ref, 'alias-new-login', 'wrong UID login cannot rewrite current semantic head');
    for (const domain of ['profile', 'land', 'land-top', 'cultivation', 'inventory']) {
      assert.equal(h.coordinator.head(wrongContext, domain).source_ref, 'alias-new-login', 'wrong UID cannot update ' + domain + ' in any projection order');
      assert.equal(h.coordinator.dirty(wrongContext, domain).operation_id, 'alias-write-2', 'wrong UID cannot clear ' + domain + ' barrier');
    }
  } finally { h.close(); }
});

test('a newer partial projection does not renew an older typed cell expiry', () => {
  const h = harness();
  try {
    const firstValue = { 'land.1.state': 1, 'land.1.flowerId': 3001 };
    const sources = (values, ref, seq, at) => Object.fromEntries(Object.keys(values).map(path => [path, { sourceRef: ref,
      method: 'usr.heartTick', connectionEpoch: base.connectionEpoch, requestSequence: seq, observedAtMs: at, observedMonotonicMs: at }]));
    const first = { domainId: 'land', complete: true, paths: Object.keys(firstValue), semanticValue: firstValue,
      cellSources: sources(firstValue, 'r20', 20, 1000), semanticFingerprint: fingerprint(firstValue), observedAtMs: 1000 };
    h.coordinator.observe({ context: base, observation: h.observation(base, 20, 'r20'), coverage: [first] });
    h.now(119000); h.mono(119000);
    const secondValue = { 'land.2.state': 1 };
    const second = { domainId: 'land', complete: true, paths: Object.keys(secondValue), semanticValue: secondValue,
      cellSources: sources(secondValue, 'r21', 21, 119000), semanticFingerprint: fingerprint(secondValue), observedAtMs: 119000 };
    h.coordinator.observe({ context: base, observation: h.observation(base, 21, 'r21'), coverage: [second] });
    h.now(121001); h.mono(121001);
    assert.equal(h.coordinator.snapshot({ context: base, feature }).domains.find(one => one.domainId === 'land').current, false);
    const head = h.coordinator.head(base, 'land');
    assert.equal(head.source_ref, 'r21');
    assert.equal(h.store.get('SELECT observed_at_ms FROM backend_dynamic_domain_cells WHERE domain_id=? AND path=?', 'land', 'land.1.state').observed_at_ms, 1000);
  } finally { h.close(); }
});

test('wall clock rollback cannot extend freshness after monotonic TTL', () => {
  const h = harness();
  try {
    h.coordinator.observe({ context: base, observation: h.observation(base, 20, 'r20'), coverage: h.plantCoverage('r20', 20) });
    h.now(-500000); h.mono(121001);
    const snapshot = h.coordinator.snapshot({ context: base, feature });
    assert.equal(snapshot.domains.find(one => one.domainId === 'land').current, false);
    assert.equal(snapshot.domains.find(one => one.domainId === 'land').reasonCode, 'DYNAMIC_DOMAIN_CELL_MAX_AGE_EXCEEDED');
  } finally { h.close(); }
});

test('wall rollback allows a newer partial cell while preserving old cell monotonic expiry', () => {
  const h = harness();
  const landOnly = { featureId: 'plant', consumedDomains: ['land'], consumedDomainsFor: () => ['land'] };
  try {
    const firstValue = { 'land.1.state': 1, 'land.1.flowerId': 3001 };
    const sources = (values, ref, seq, at, mono) => Object.fromEntries(Object.keys(values).map(path => [path, { sourceRef: ref,
      method: 'usr.heartTick', connectionEpoch: base.connectionEpoch, requestSequence: seq, observedAtMs: at, observedMonotonicMs: mono }]));
    h.coordinator.observe({ context: base, observation: h.observation(base, 20, 'clock-before-rollback'), coverage: [{ domainId: 'land', complete: true,
      paths: Object.keys(firstValue), semanticValue: firstValue, semanticFingerprint: fingerprint(firstValue), observedAtMs: 1000,
      cellSources: sources(firstValue, 'clock-before-rollback', 20, 1000, 1000) }] });
    h.now(500); h.mono(1500);
    const partialValue = { 'land.2.state': 1 };
    h.coordinator.observe({ context: base, observation: h.observation(base, 21, 'clock-after-rollback'), coverage: [{ domainId: 'land', complete: true,
      paths: Object.keys(partialValue), semanticValue: partialValue, semanticFingerprint: fingerprint(partialValue), observedAtMs: 500,
      cellSources: sources(partialValue, 'clock-after-rollback', 21, 500, 1500) }] });
    assert.equal(h.coordinator.head(base, 'land').source_ref, 'clock-after-rollback');
    const during = h.coordinator.snapshot({ context: base, feature: landOnly });
    assert.equal(during.current, true, JSON.stringify(during.domains));
    h.mono(121001);
    const expired = h.coordinator.snapshot({ context: base, feature: landOnly });
    assert.equal(expired.current, false);
    assert.equal(expired.domains.find(one => one.domainId === 'land').reasonCode, 'DYNAMIC_DOMAIN_CELL_MAX_AGE_EXCEEDED');
  } finally { h.close(); }
});

test('plant chosen-top freshness is conditional on current accepted config', () => {
  const h = harness();
  try {
    h.coordinator.observe({ context: base, observation: h.observation(base, 20, 'r20'), coverage: h.plantCoverage('r20', 20, base.connectionEpoch, false) });
    assert.equal(h.coordinator.snapshot({ context: base, feature, config: { plantMode: 'least_stock' } }).current, true);
    const chosenTop = h.coordinator.snapshot({ context: base, feature, config: { plantMode: 'chosen_top' } });
    assert.equal(chosenTop.current, false);
    assert.equal(chosenTop.reasonCode, 'DYNAMIC_DOMAIN_NOT_OBSERVED');
  } finally { h.close(); }
});

test('customer daily facts are required only for generation branch', () => {
  const h = harness();
  const customer = { featureId: 'order.customer', consumedDomains: ['customer', 'customer-eligibility', 'profile', 'inventory'],
    consumedDomainsFor: ({ method }) => method === 'orderCustomer.genOrder'
      ? ['customer', 'customer-eligibility', 'profile', 'customer-day', 'inventory']
      : ['customer', 'customer-eligibility', 'profile', 'inventory'] };
  try {
    const domains = ['customer', 'customer-eligibility', 'profile', 'inventory'];
    h.coordinator.observe({ context: base, observation: h.observation(base, 20, 'customer-base'),
      coverage: [
        h.coveragePaths('customer', ['customer.orderMap', 'customer.orderMapComplete'], 'customer-base', 20),
        h.coveragePaths('customer-eligibility', ['customer-eligibility.profile.level', 'customer-eligibility.profile.vip',
          'customer-eligibility.sdkChannel', 'customer-eligibility.serverOpenMap.sys_orderCustomer', 'customer-eligibility.mainTask.domain',
          'customer-eligibility.mainTask.uid', 'customer-eligibility.mainTask.curTaskId'], 'customer-base', 20),
        h.coveragePaths('profile', ['profile.uid'], 'customer-base', 20),
        h.coveragePaths('inventory', ['inventory.bag.complete', 'inventory.itemExt.complete'], 'customer-base', 20),
        h.coveragePaths('clock', ['official-clock.lowerBoundMs', 'official-clock.upperBoundMs'], 'customer-base', 20),
      ] });
    const finish = h.coordinator.snapshot({ context: base, feature: customer, method: 'orderCustomer.finishOrder' });
    const generate = h.coordinator.snapshot({ context: base, feature: customer, method: 'orderCustomer.genOrder' });
    assert.equal(finish.current, true, 'normal order path can proceed without day-only generation counter');
    assert.equal(generate.current, false, 'generation remains gated until its day domain is current');
    assert.equal(generate.domains.some(one => one.domainId === 'customer-day'), true);
  } finally { h.close(); }
});

test('ordinary flower order path does not wait on optional video facts', () => {
  const h = harness();
  const flower = { featureId: 'order.resident',
    consumedDomains: ['order-flower', 'order-flower-counter', 'order-flower-eligibility', 'inventory', 'customer-day', 'clock', 'profile'],
    consumedDomainsFor: orderFlowerDynamicDomains };
  try {
    const domains = flower.consumedDomains;
    const login = h.observation(base, 1, 'flower-base', 'login');
    const coverage = [
        h.coverage('order-flower-eligibility', 'fp-eligibility', true, 'flower-base', 20),
        h.coveragePaths('order-flower', ['order-flower.domain', 'order-flower.fields.uid', 'order-flower.fields.residentMap'], 'flower-base', 20),
        h.coveragePaths('order-flower-counter', ['uid', 'type', 'tdyCnt', 'totCnt', 'rTime', 'uTime', 'cTime']
          .map(field => `order-flower-counter.counters.105.${field}`), 'flower-base', 20),
        h.coveragePaths('inventory', ['inventory.bag.complete', 'inventory.itemExt.complete'], 'flower-base', 20),
        h.coveragePaths('clock', ['official-clock.lowerBoundMs', 'official-clock.upperBoundMs'], 'flower-base', 20),
        h.coveragePaths('customer-day', ['official-day.dayKey', 'official-day.endMs'], 'flower-base', 20),
        h.coveragePaths('profile', ['profile.uid'], 'flower-base', 20),
      ].map(item => {
        item.observedAtMs = login.receivedDeviceMs;
        for (const source of Object.values(item.cellSources)) Object.assign(source, { method: 'index.login', requestSequence: 1,
          observedAtMs: login.receivedDeviceMs, observedMonotonicMs: login.receivedMonotonicMs });
        if (item.domainId === 'profile') item.semanticFingerprint = fingerprint(item.semanticValue);
        return item;
      });
    h.coordinator.observe({ context: base, observation: login, coverage });
    const ordinary = h.coordinator.snapshot({ context: base, feature: flower, method: 'orderFlower.finishOrder' });
    assert.equal(ordinary.current, true, JSON.stringify(ordinary.domains));
    const video = h.coordinator.snapshot({ context: base, feature: flower, method: 'usr.share' });
    assert.equal(video.current, false);
    assert.equal(video.domains.some(one => one.domainId === 'order-flower-video-resident'), true);
    assert.equal(h.coordinator.snapshot({ context: base, feature: flower, method: 'orderFlower.recvOrderRwd' }).current, false,
      'reward method requires its current reward state');
    const stageDomains = orderFlowerDynamicDomains({ method: 'orderFlower.recvOrderRwd' });
    const achievementDomains = orderFlowerDynamicDomains({ method: 'taskAch.recv' });
    assert.ok(stageDomains.includes('order-flower-reward-stage') && !stageDomains.includes('order-flower-reward-achievement'));
    assert.ok(achievementDomains.includes('order-flower-reward-achievement') && !achievementDomains.includes('order-flower-reward-stage'));
    assert.equal(h.coordinator.snapshot({ context: base, feature: flower, method: 'orderFlower.enter' }).current, false,
      'enter method requires its current opportunity state');
    const stored = h.coordinator.snapshot({ context: base, feature: flower, method: 'orderFlower.finishOrder',
      proposal: { orderFlower: { deliveryPath: 'butler-stored-order' } } });
    assert.equal(stored.current, false, 'stored delivery requires current butler state');
    assert.equal(h.coordinator.snapshot({ context: base, feature: flower, method: 'orderFlower.finishOrder',
      proposal: { orderFlower: { deliveryPath: 'instant' } } }).current, false,
    'instant/stored selection both require current butler facts because planning reads them before choosing a path');
    const residentShare = orderFlowerDynamicDomains({ method: 'usr.share', proposal: { orderFlowerVideo: { kind: 'resident', capability: { kind: 'request-only' } } } });
    const videoScan = orderFlowerDynamicDomains({ actionKey: 'video', kind: 'resident' });
    assert.ok(!videoScan.includes('order-flower-card-video') && !videoScan.some(domain => domain.startsWith('order-flower-video-')),
      'no current video candidate does not consume optional video/card facts');
    assert.ok(residentShare.includes('order-flower-video-resident'));
    assert.ok(!residentShare.includes('order-flower-video-satin') && !residentShare.includes('order-flower-video-decorate') &&
      !residentShare.includes('order-flower-card-video'), 'request-only share checks its exact share inputs without requiring card6');
    const cardShare = orderFlowerDynamicDomains({ method: 'usr.share', proposal: { orderFlowerVideo: {
      kind: 'satin', capability: { kind: 'current-official-card6' } } } });
    assert.ok(cardShare.includes('order-flower-video-satin') && cardShare.includes('order-flower-card-video'));
  } finally { h.close(); }
});

test('three-order write keeps counter and eligibility dirty when reply omits those typed cells', () => {
  const h = harness();
  try {
    const method = 'orderFlower.finishSatinOrder', operationId = 'flower-write-1';
    const domains = affectedDomainsForWrite('order.satin', method);
    h.coordinator.beforeDispatch({ context: base, proposal: { ...base, featureId: 'order.satin', method, affectedDomains: domains, operationId },
      binding: { requestSequence: 21, connectionEpoch: base.connectionEpoch, wireKey: 'wire-flower-1' } });
    assert.ok(domains.includes('order-flower-counter'));
    assert.ok(domains.includes('order-flower-eligibility'));
    h.coordinator.observe({ context: base, observation: { ...h.observation(base, 21, 'reply-flower-1'), method, operationId },
      coverage: [h.coverage('order-flower', 'order-refreshed', true, 'reply-flower-1', 21, base.connectionEpoch, method),
        h.coverage('inventory', 'piggyback-inventory', true, 'reply-flower-1', 21, base.connectionEpoch, method)] });
    assert.equal(h.coordinator.dirty(base, 'order-flower-counter').operation_id, operationId);
    assert.equal(h.coordinator.dirty(base, 'order-flower-eligibility').operation_id, operationId);
    assert.equal(h.coordinator.head(base, 'inventory').source_ref, 'reply-flower-1', 'validated piggyback projection is accepted');
    assert.equal(h.coordinator.dirty(base, 'inventory').operation_id, operationId, 'piggyback does not clear a write barrier without exact effect coverage');
  } finally { h.close(); }
});
