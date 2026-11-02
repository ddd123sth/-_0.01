import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createSubjectSupervisor } from '../runtime/backend/session/supervisor.mjs';

test('authorization suspension preserves current desired intents and later STOP remains final', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-owner-suspension-'));
  const store = openBackendStore({ dataDir });
  const supervisor = createSubjectSupervisor({ store, authorize: () => true, connect: async () => { throw new Error('not used'); },
    isolatePreviousExecutor: async () => ({ isolated: false }), readWriteActivity: () => ({ inFlight: false }),
    quiesceScheduling: async () => ({ quiesced: true }) });
  try {
    const identity = { ownerRef: 'owner:test', accountRef: '1', subjectRef: 'subject:test', basis: 'test-fixture',
      identityVersion: 'test-v1', channel: 'official', evidence: { sourceRef: 'fixture:binding', sourceVersion: 'test-v1' } };
    supervisor.bind(identity);
    store.run("INSERT INTO backend_run_intents VALUES(?,?,?,1,1,0,'WAITING_LOGIN','TEST_WAIT','command:test',NULL,?)",
      identity.ownerRef, identity.accountRef, identity.subjectRef, store.nowIso());

    const suspended = await supervisor.suspendOwner(identity.ownerRef, 'SOFTWARE_GRACE_EXPIRED');
    assert.equal(suspended.cleanupComplete, true);
    assert.equal(suspended.suspended, true);
    let projected = supervisor.project(identity.ownerRef, identity.accountRef);
    assert.equal(projected.desiredRunning, true);
    assert.equal(projected.lifecycle, 'SUSPENDED');
    assert.equal(projected.state, 'waiting_authorization');
    assert.equal(projected.reasonCode, 'SOFTWARE_GRACE_EXPIRED');

    const epoch = projected.runEpoch;
    await supervisor.suspendOwner(identity.ownerRef, 'SOFTWARE_GRACE_EXPIRED');
    projected = supervisor.project(identity.ownerRef, identity.accountRef);
    assert.equal(projected.runEpoch, epoch, 'repeated authorization checks do not churn a settled suspension');
    await supervisor.stop({ ownerRef: identity.ownerRef, accountRef: identity.accountRef, reasonCode: 'USER_STOPPED' });
    projected = supervisor.project(identity.ownerRef, identity.accountRef);
    assert.equal(projected.desiredRunning, false);
    assert.equal(projected.state, 'stopped');
    await supervisor.suspendOwner(identity.ownerRef, 'SOFTWARE_GRACE_EXPIRED');
    projected = supervisor.project(identity.ownerRef, identity.accountRef);
    assert.equal(projected.desiredRunning, false, 'an authorization retry cannot resurrect an explicit STOP');
  } finally {
    await supervisor.shutdownForRestart({ timeoutMs: 1000 }).catch(() => {});
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
