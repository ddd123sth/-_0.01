import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createSubjectSupervisor } from '../runtime/backend/session/supervisor.mjs';

test('failed physical close remains desired and retries cleanup without a user command', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-cleanup-retry-'));
  const store = openBackendStore({ dataDir });
  let closeCalls = 0, onClosed; const recoveryEvents = [];
  const supervisor = createSubjectSupervisor({ store, authorize: () => true, onConnected: async () => {},
    appendRecoveryLog: event => recoveryEvents.push(event),
    isolatePreviousExecutor: async ({ subjectRef }) => ({ isolated: true, subjectRef, evidenceRef: 'fixture:isolation', sourceRef: 'fixture:source' }),
    connect: async ({ onClosed: notifyClosed }) => {
      onClosed = notifyClosed;
      let open = true;
      return { isOpen: () => open, close: async () => {
        closeCalls++;
        if (closeCalls === 1) return { closed: false };
        open = false;
        return { closed: true, connectionEpoch: 1, code: 'fixture-close' };
      } };
    }, cleanupTimeoutMs: 25, recoveryBaseMs: 150, recoveryMaxMs: 300 });
  const identity = { ownerRef: 'owner:cleanup', accountRef: '2', subjectRef: 'subject:cleanup', basis: 'fixture',
    identityVersion: 'fixture-v1', channel: 'official', evidence: { sourceRef: 'fixture:binding', sourceVersion: 'fixture-v1' } };
  const waitFor = async predicate => {
    const deadline = Date.now() + 1500;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(predicate(), 'condition reached before test deadline');
  };
  try {
    supervisor.bind(identity);
    supervisor.networkChanged({ online: true, transport: 'wifi' });
    await supervisor.start({ ownerRef: identity.ownerRef, accountRef: identity.accountRef, commandId: 'fixture:start' });
    assert.equal(supervisor.project(identity.ownerRef, identity.accountRef).desiredRunning, true);
    onClosed({ connectionEpoch: 1, code: 'PROTOCOL_CONNECTION_CLOSED', intentional: false });
    await waitFor(() => supervisor.project(identity.ownerRef, identity.accountRef).recovery?.state === 'cleanup_pending');
    const failure = recoveryEvents.find(event => event.status === 'cleanup_pending' && event.error.code === 'PROTOCOL_CONNECTION_CLOSED');
    assert.ok(failure, 'failure diagnostic is emitted with the persisted recovery change');
    assert.equal(failure.eventState, 'incomplete');
    assert.equal(failure.connectionEpoch, 1);
    assert.ok(failure.traceId.length <= 64);
    assert.equal(supervisor.project(identity.ownerRef, identity.accountRef).desiredRunning, true);
    await waitFor(() => closeCalls >= 2);
    assert.equal(supervisor.project(identity.ownerRef, identity.accountRef).desiredRunning, true);
    assert.equal(supervisor.project(identity.ownerRef, identity.accountRef).recovery?.state, 'scheduled');
    await supervisor.stop({ ownerRef: identity.ownerRef, accountRef: identity.accountRef, reasonCode: 'FIXTURE_STOP' });
    assert.equal(supervisor.project(identity.ownerRef, identity.accountRef).desiredRunning, false);
  } finally {
    await supervisor.shutdownForRestart({ timeoutMs: 1000 }).catch(() => {});
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('wall-clock rollback does not postpone an already armed automatic reconnect', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-session-clock-rollback-'));
  const store = openBackendStore({ dataDir });
  let connectCalls = 0, wallNow = Date.now(), onClosed; const recoveryEvents = [];
  const supervisor = createSubjectSupervisor({ store, authorize: () => true, onConnected: async () => {},
    appendRecoveryLog: event => recoveryEvents.push(event),
    isolatePreviousExecutor: async ({ subjectRef }) => ({ isolated: true, subjectRef, evidenceRef: 'fixture:isolation', sourceRef: 'fixture:source' }),
    connect: async ({ onClosed: closed }) => {
      connectCalls++;
      if (connectCalls === 1) onClosed = closed;
      let open = true;
      return { isOpen: () => open, close: async () => {
        open = false;
        return { closed: true, connectionEpoch: connectCalls === 1 ? 1 : 2, code: 'fixture-close' };
      } };
    }, recoveryBaseMs: 180, recoveryMaxMs: 300, deviceNow: () => wallNow });
  const identity = { ownerRef: 'owner:clock', accountRef: '3', subjectRef: 'subject:clock', basis: 'fixture',
    identityVersion: 'fixture-v1', channel: 'official', evidence: { sourceRef: 'fixture:binding-clock', sourceVersion: 'fixture-v1' } };
  const waitFor = async predicate => {
    const deadline = Date.now() + 1800;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(predicate(), 'automatic recovery completed before test deadline: ' + JSON.stringify(supervisor.project(identity.ownerRef, identity.accountRef)));
  };
  try {
    supervisor.bind(identity);
    supervisor.networkChanged({ online: true, transport: 'wifi' });
    await supervisor.start({ ownerRef: identity.ownerRef, accountRef: identity.accountRef, commandId: 'fixture:start-clock' });
    assert.equal(supervisor.project(identity.ownerRef, identity.accountRef).desiredRunning, true);
    onClosed({ connectionEpoch: 1, code: 'PROTOCOL_CONNECTION_CLOSED', intentional: false });
    await waitFor(() => supervisor.project(identity.ownerRef, identity.accountRef).recovery?.state === 'scheduled');
    await new Promise(resolve => setTimeout(resolve, 25));
    wallNow -= 6 * 60 * 60 * 1000;
    await waitFor(() => connectCalls >= 2);
    assert.equal(supervisor.project(identity.ownerRef, identity.accountRef).desiredRunning, true);
    assert.equal(supervisor.project(identity.ownerRef, identity.accountRef).state, 'running');
    const failed = recoveryEvents.find(event => event.status === 'scheduled');
    const connected = recoveryEvents.filter(event => event.status === 'connected').at(-1);
    assert.ok(failed && connected);
    assert.equal(failed.traceId, connected.traceId, 'retry and accepted connection retain one recovery incident trace across connection epochs');
  } finally {
    await supervisor.shutdownForRestart({ timeoutMs: 1000 }).catch(() => {});
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a fresh supervisor re-anchors persisted retry after wall rollback and resumes desired intent', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-session-restart-clock-'));
  const identity = { ownerRef: 'owner:restart-clock', accountRef: '5', subjectRef: 'subject:restart-clock', basis: 'fixture',
    identityVersion: 'fixture-v1', channel: 'official', evidence: { sourceRef: 'fixture:binding-restart', sourceVersion: 'fixture-v1' } };
  let wallNow = Date.now(), connectCalls = 0, oldClosed;
  const makeSupervisor = store => createSubjectSupervisor({ store, authorize: () => true, onConnected: async () => {},
    isolatePreviousExecutor: async ({ subjectRef }) => ({ isolated: true, subjectRef, evidenceRef: 'fixture:isolation-restart', sourceRef: 'fixture:source-restart' }),
    connect: async ({ onClosed }) => {
      connectCalls++;
      if (connectCalls === 1) oldClosed = onClosed;
      let open = true;
      return { isOpen: () => open, close: async () => { open = false; return { closed: true, connectionEpoch: connectCalls, code: 'fixture-close' }; } };
    }, recoveryBaseMs: 180, recoveryMaxMs: 400, deviceNow: () => wallNow });
  const waitFor = async (predicate, target) => {
    const deadline = Date.now() + 1500;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(predicate(), 'condition reached: ' + target + ' ' + JSON.stringify(supervisor.project(identity.ownerRef, identity.accountRef)));
  };
  let store = openBackendStore({ dataDir }), supervisor = makeSupervisor(store);
  try {
    supervisor.bind(identity); supervisor.networkChanged({ online: true, transport: 'wifi' });
    await supervisor.start({ ownerRef: identity.ownerRef, accountRef: identity.accountRef, commandId: 'fixture:start-restart-clock' });
    oldClosed({ connectionEpoch: 1, code: 'PROTOCOL_CONNECTION_CLOSED', intentional: false });
    await waitFor(() => supervisor.project(identity.ownerRef, identity.accountRef).recovery?.state === 'scheduled', 'persisted retry scheduled');
    await supervisor.shutdownForRestart({ timeoutMs: 1000 });
    store.close();

    wallNow -= 6 * 60 * 60 * 1000;
    store = openBackendStore({ dataDir }); supervisor = makeSupervisor(store);
    supervisor.bind(identity); supervisor.networkChanged({ online: true, transport: 'wifi' });
    const resumed = supervisor.resumeDesired(identity.ownerRef);
    assert.equal(resumed.accounts[0]?.resumed, true);
    await waitFor(() => connectCalls >= 2, 'new executor reconnect');
    assert.equal(supervisor.project(identity.ownerRef, identity.accountRef).desiredRunning, true);
  } finally {
    await supervisor.shutdownForRestart({ timeoutMs: 1000 }).catch(() => {});
    store.close(); fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('bounded engine cleanup uses monotonic duration when the device wall clock rolls back', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-shutdown-clock-'));
  const store = openBackendStore({ dataDir });
  let wallNow = Date.now(), closeCalls = 0;
  const supervisor = createSubjectSupervisor({ store, authorize: () => true, onConnected: async () => {},
    isolatePreviousExecutor: async ({ subjectRef }) => ({ isolated: true, subjectRef, evidenceRef: 'fixture:isolation-shutdown', sourceRef: 'fixture:source-shutdown' }),
    connect: async () => ({ isOpen: () => true, close: async () => { closeCalls++; return new Promise(() => {}); } }), deviceNow: () => wallNow,
    readWriteActivity: () => ({ inFlight: false }), quiesceScheduling: () => new Promise(() => {}),
    cleanupTimeoutMs: 1000, recoveryBaseMs: 150, recoveryMaxMs: 300 });
  const identity = { ownerRef: 'owner:shutdown-clock', accountRef: '6', subjectRef: 'subject:shutdown-clock', basis: 'fixture',
    identityVersion: 'fixture-v1', channel: 'official', evidence: { sourceRef: 'fixture:binding-shutdown', sourceVersion: 'fixture-v1' } };
  try {
    supervisor.bind(identity); supervisor.networkChanged({ online: true, transport: 'wifi' });
    await supervisor.start({ ownerRef: identity.ownerRef, accountRef: identity.accountRef, commandId: 'fixture:start-shutdown-clock' });
    assert.equal(supervisor.project(identity.ownerRef, identity.accountRef).connected, true);
    const started = Date.now();
    const rollback = setTimeout(() => { wallNow -= 6 * 60 * 60 * 1000; }, 100);
    await supervisor.shutdownForRestart({ timeoutMs: 1000 });
    clearTimeout(rollback);
    const elapsed = Date.now() - started;
    assert.equal(closeCalls, 0, 'quiesce timeout prevents unsafe close before drain completes');
    assert.ok(elapsed >= 900 && elapsed < 1500, 'cleanup consumes its monotonic bound across wall rollback; elapsed=' + elapsed);
  } finally {
    await supervisor.shutdownForRestart({ timeoutMs: 1000 }).catch(() => {});
    store.close(); fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('cleanup retries preserve the original credential and timed risk policy', async t => {
  for (const scenario of [
    { name: 'credential', failure: Object.assign(new Error('credential'), { code: 'REAL_ACCOUNT_CREDENTIAL_REJECTED',
      sourceNamespace: 'sdk-login', loginKind: 'credential', loginCode: 2011 }), expected: 'blocked', action: 'needs-credentials' },
    { name: 'disabled-code-only', failure: Object.assign(new Error('disabled'), { code: 'SOFTWARE_USER_DISABLED' }),
      expected: 'blocked', action: 'account-disabled' },
    { name: 'ownership-code-only', failure: Object.assign(new Error('owner conflict'), { code: 'SUBJECT_OWNER_CHANGED' }),
      expected: 'blocked', action: 'ownership-conflict' },
    { name: 'risk', failure: Object.assign(new Error('risk'), { code: 'REAL_SDK_LOGIN_FAILED',
      sourceNamespace: 'sdk-login', loginKind: 'risk_ip', loginCode: 902050 }), expected: 'scheduled', action: 'wait-egress' },
  ]) await t.test(scenario.name, async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-cleanup-policy-' + scenario.name + '-'));
    const store = openBackendStore({ dataDir });
    let closeCalls = 0, connects = 0;
    const supervisor = createSubjectSupervisor({ store, authorize: () => true,
      onConnected: async () => { throw scenario.failure; },
      isolatePreviousExecutor: async ({ subjectRef }) => ({ isolated: true, subjectRef, evidenceRef: 'fixture:isolation-policy', sourceRef: 'fixture:source-policy' }),
      connect: async () => { connects++; let open = true; return { isOpen: () => open, close: async () => {
        closeCalls++; if (closeCalls === 1) return { closed: false }; open = false; return { closed: true, connectionEpoch: 1 };
      } }; }, cleanupTimeoutMs: 20, recoveryBaseMs: 100, recoveryMaxMs: 250 });
    const identity = { ownerRef: 'owner:cleanup-policy-' + scenario.name, accountRef: '7', subjectRef: 'subject:cleanup-policy-' + scenario.name,
      basis: 'fixture', identityVersion: 'fixture-v1', channel: 'official', evidence: { sourceRef: 'fixture:binding-policy', sourceVersion: 'fixture-v1' } };
    const waitFor = async predicate => {
      const deadline = Date.now() + 1200;
      while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(predicate(), JSON.stringify(supervisor.project(identity.ownerRef, identity.accountRef)));
    };
    try {
      supervisor.bind(identity); supervisor.networkChanged({ online: true, transport: 'wifi' });
      await assert.rejects(supervisor.start({ ownerRef: identity.ownerRef, accountRef: identity.accountRef, commandId: 'fixture:policy-' + scenario.name }));
      await waitFor(() => supervisor.project(identity.ownerRef, identity.accountRef).recovery?.state === scenario.expected);
      const project = supervisor.project(identity.ownerRef, identity.accountRef);
      const stored = store.get('SELECT error_json FROM backend_session_recovery WHERE owner_ref=? AND account_ref=?', identity.ownerRef, identity.accountRef);
      const errorEvidence = JSON.parse(stored.error_json);
      assert.equal(project.desiredRunning, true);
      assert.equal(errorEvidence.action, scenario.action);
      assert.equal(errorEvidence.code, scenario.failure.code, 'cleanup retry must retain the original classifier code');
      if (scenario.name === 'risk') assert.ok(project.recovery.retryAtMs - Date.now() >= 3500000, '60 minute retry-after remains intact');
      assert.equal(connects, 1, 'classification must not trigger an immediate reconnect');
    } finally {
      await supervisor.shutdownForRestart({ timeoutMs: 1000 }).catch(() => {});
      store.close(); fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
