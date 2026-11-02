import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createSubjectSupervisor } from '../runtime/backend/session/supervisor.mjs';

test('fractional retry timer cannot lose the just-before-due wake', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-supervisor-fractional-wake-'));
  const store = openBackendStore({ dataDir });
  const ownerRef = 'owner:fractional-wake', accountRef = '31', subjectRef = 'subject:fractional-wake';
  const identity = { ownerRef, accountRef, subjectRef, basis: 'fixture', identityVersion: 'fixture-v1', channel: 'official',
    evidence: { sourceRef: 'fixture:fractional-wake', sourceVersion: 'fixture-v1' } };
  const recoveryBaseMs = 50, recoveryMaxMs = 500, wallNow = Date.now();
  let monotonic = 0, scriptedReads = [0, 0.001], connectCalls = 0, notifyClosed = null;
  const supervisor = createSubjectSupervisor({ store, authorize: () => true, onConnected: async () => {},
    isolatePreviousExecutor: async ({ subjectRef: requested }) => ({ isolated: true, subjectRef: requested,
      evidenceRef: 'fixture:isolation:fractional-wake', sourceRef: 'fixture:source:fractional-wake' }),
    connect: async ({ onClosed }) => {
      connectCalls += 1;
      if (connectCalls === 1) notifyClosed = onClosed;
      let open = true;
      return { isOpen: () => open, close: async () => {
        open = false;
        return { closed: true, connectionEpoch: connectCalls === 1 ? 1 : 2, code: 'fixture-close' };
      } };
    },
    cleanupTimeoutMs: 1000, recoveryBaseMs, recoveryMaxMs, maxRecoveryAttempts: 1, deviceNow: () => wallNow,
    monotonicNow: () => scriptedReads.length ? scriptedReads.shift() : monotonic });
  const flush = async () => { for (let i = 0; i < 24; i += 1) await new Promise(resolve => setImmediate(resolve)); };
  const waitUntil = async predicate => {
    for (let i = 0; i < 200 && !predicate(); i += 1) await new Promise(resolve => setImmediate(resolve));
    assert.ok(predicate(), 'condition not reached: ' + JSON.stringify(supervisor.project(ownerRef, accountRef)));
  };
  try {
    supervisor.bind(identity);
    supervisor.networkChanged({ online: true, transport: 'wifi' });
    await supervisor.start({ ownerRef, accountRef, commandId: 'fixture:start-fractional-wake' });
    assert.equal(supervisor.project(ownerRef, accountRef).desiredRunning, true);
    notifyClosed({ connectionEpoch: 1, code: 'PROTOCOL_CONNECTION_CLOSED', intentional: false });
    await waitUntil(() => supervisor.project(ownerRef, accountRef).recovery?.state === 'scheduled');

    const saved = store.get('SELECT * FROM backend_session_recovery WHERE owner_ref=? AND account_ref=?', ownerRef, accountRef);
    assert.ok(saved && saved.retry_at_ms !== null);
    // Derive the actual monotonic deadline from the persisted retry and the
    // same bounded backoff rule; no fixed timer duration is assumed.
    const exponent = Math.min(30, Math.max(0, Number(saved.attempt || 0)));
    const delayBound = Math.min(recoveryMaxMs, recoveryBaseMs * 2 ** exponent);
    const remaining = Math.min(Math.max(0, saved.retry_at_ms - wallNow), delayBound);
    const dueMono = remaining; // The scripted first deadline anchor is exactly monotonic=0.
    const armNow = 0.001;
    const scheduledDelay = Math.max(1, Math.ceil(dueMono - armNow));
    assert.ok(scheduledDelay > 1);

    // Timer fires at due, while the first monotonic read says due-0.001 and
    // the later no-next recovery check says due+0.001. That boundary used to
    // consume the only timer without rearming.
    monotonic = dueMono + 0.001;
    scriptedReads = [dueMono - 0.001, dueMono + 0.001];
    t.mock.timers.tick(scheduledDelay - 1);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(connectCalls, 1, 'first due check observes just-before-due');
    assert.equal(supervisor.project(ownerRef, accountRef).desiredRunning, true);

    // A one millisecond tick proves an eligible retry timer remained armed.
    t.mock.timers.tick(1);
    await waitUntil(() => connectCalls === 2);
    assert.equal(supervisor.project(ownerRef, accountRef).desiredRunning, true);
    assert.equal(supervisor.project(ownerRef, accountRef).state, 'running');
  } finally {
    await supervisor.shutdownForRestart({ timeoutMs: 1000 }).catch(() => {});
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    t.mock.timers.reset();
  }
});

