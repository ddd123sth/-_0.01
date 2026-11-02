import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createSubjectSupervisor } from '../runtime/backend/session/supervisor.mjs';

test('repeated unprovable cleanup isolates only that account, never fakes closure and leaves a healthy account running', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-cleanup-isolation-'));
  const store = openBackendStore({ dataDir });
  const ownerRef = 'owner:isolation';
  let brokenClosed = null, healthyClosed = null, connects = [];
  const supervisor = createSubjectSupervisor({ store, authorize: () => true, onConnected: async () => {},
    isolatePreviousExecutor: async ({ subjectRef }) => ({ isolated: true, subjectRef,
      evidenceRef: 'fixture:isolation-proof', sourceRef: 'fixture:isolation-source' }),
    connect: async ({ accountRef, connectionEpoch, onClosed }) => {
      connects.push(String(accountRef));
      if (String(accountRef) === '8') {
        brokenClosed = onClosed;
        let open = true;
        // The peer/engine never returns a physical-close receipt. The supervisor
        // must not turn this into closure evidence.
        return { isOpen: () => open, close: async () => { open = false; return { closed: false }; } };
      }
      healthyClosed = onClosed;
      let open = true;
      return { isOpen: () => open, close: async () => {
        open = false;
        return { closed: true, connectionEpoch, code: 'fixture-close' };
      } };
    }, cleanupTimeoutMs: 20, recoveryBaseMs: 20, recoveryMaxMs: 40 });
  const identity = (accountRef, subjectRef) => ({ ownerRef, accountRef, subjectRef, basis: 'fixture',
    identityVersion: 'fixture-v1', channel: 'official',
    evidence: { sourceRef: 'fixture:binding:' + accountRef, sourceVersion: 'fixture-v1' } });
  const broken = identity('8', 'subject:isolation:8'), healthy = identity('9', 'subject:isolation:9');
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 8000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(predicate(), label + ': ' + JSON.stringify(supervisor.project(ownerRef, broken.accountRef)));
  };
  try {
    supervisor.bind(broken); supervisor.bind(healthy);
    supervisor.networkChanged({ online: true, transport: 'wifi' });
    await supervisor.start({ ownerRef, accountRef: broken.accountRef, commandId: 'i:start-8' });
    await supervisor.start({ ownerRef, accountRef: healthy.accountRef, commandId: 'i:start-9' });
    assert.equal(supervisor.project(ownerRef, healthy.accountRef).connected, true);

    brokenClosed({ connectionEpoch: 1, code: 'PROTOCOL_CONNECTION_CLOSED', intentional: false });
    await waitFor(() => supervisor.project(ownerRef, broken.accountRef).recovery?.state === 'blocked',
      'the affected account is isolated after the bounded cleanup attempts');

    const brokenProject = supervisor.project(ownerRef, broken.accountRef);
    assert.equal(brokenProject.desiredRunning, true, 'the account keeps its own desired intent');
    assert.equal(brokenProject.recovery.reasonCode, 'SESSION_CLEANUP_UNPROVEN_ISOLATED');
    assert.equal(brokenProject.recovery.retryAtMs, null, 'isolation does not keep an automatic retry armed');
    assert.equal(brokenProject.state, 'blocked');
    assert.ok(!store.get(`SELECT 1 AS x FROM backend_session_connection_closures WHERE owner_ref=? AND account_ref='8' LIMIT 1`, ownerRef),
      'no closure row may be invented for an unproven close');
    const evidence = JSON.parse(store.get('SELECT error_json FROM backend_session_recovery WHERE owner_ref=? AND account_ref=?', ownerRef, '8').error_json);
    assert.equal(evidence.isolationOnly, true);
    assert.equal(evidence.action, 'cleanup-isolation');
    assert.equal(evidence.userActionRequired, true);
    assert.ok(evidence.cleanupAttempts >= 8);

    const health = supervisor.healthSnapshot();
    assert.equal(health.isolatedCleanup.length, 1);
    assert.equal(health.isolatedCleanup[0].accountRef, '8');
    assert.equal(health.isolatedCleanup[0].isolationOnly, true);

    // The healthy account is still connected and was never torn down.
    const healthyProject = supervisor.project(ownerRef, healthy.accountRef);
    assert.equal(healthyProject.connected, true);
    assert.equal(healthyProject.state, 'running');
    assert.equal(healthyProject.desiredRunning, true);

    // A resume sweep (engine restart path) may not silently revive the isolated account.
    const resumed = supervisor.resumeDesired(ownerRef);
    const brokenReceipt = resumed.accounts.find(account => String(account.accountRef) === '8');
    // The still-present unproven actor is not resumed by the sweep; it stays
    // isolated until a process-level restart and an explicit user START.
    assert.notEqual(brokenReceipt?.resumed, true);
    assert.equal(supervisor.project(ownerRef, broken.accountRef).recovery.state, 'blocked');
    assert.equal(supervisor.project(ownerRef, broken.accountRef).desiredRunning, true);
  } finally {
    await supervisor.shutdownForRestart({ timeoutMs: 1000 }).catch(() => {});
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});