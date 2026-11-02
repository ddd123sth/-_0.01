import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createSubjectSupervisor } from '../runtime/backend/session/supervisor.mjs';
import { startExplicitAccount } from '../runtime/backend/execution/explicit-account-start.mjs';

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-explicit-start-'));
  const store = openBackendStore({ dataDir: dir });
  store.db.exec(`CREATE TABLE backend_native_stop_controls(control_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    command_id TEXT UNIQUE,kind TEXT,stop_committed INTEGER,cleanup_complete INTEGER)`);
  const state = { connects: 0, controls: 0, release: null };
  const authorization = new Promise(resolve => { state.release = resolve; });
  const supervisor = createSubjectSupervisor({ store,
    authorize: () => authorization,
    isolatePreviousExecutor: async ({ subjectRef }) => ({ isolated: true, subjectRef, evidenceRef: 'fixture:closed', sourceRef: 'fixture:source' }),
    onConnected: async () => {},
    connect: async ({ connectionEpoch }) => {
      state.connects++;
      let open = true;
      return { isOpen: () => open, close: async () => { open = false; return { closed: true, connectionEpoch, code: 'fixture-close' }; } };
    }, cleanupTimeoutMs: 50 });
  const identity = { ownerRef: 'owner:explicit-start', accountRef: '31', subjectRef: 'subject:explicit-start',
    basis: 'fixture', identityVersion: 'fixture-v1', channel: 'official',
    evidence: { sourceRef: 'fixture:binding', sourceVersion: 'fixture-v1' } };
  supervisor.bind(identity);
  const control = () => store.get('SELECT * FROM backend_native_stop_controls ORDER BY control_seq DESC LIMIT 1');
  const putStop = complete => store.run('INSERT INTO backend_native_stop_controls(command_id,kind,stop_committed,cleanup_complete) VALUES(?,\'STOP\',1,?)', randomUUID(), complete ? 1 : 0);
  putStop(true);
  const backend = { store, supervisor, software: { authorize: () => true }, instanceId: randomUUID(),
    nativeStartControl: ({ commandId }) => {
      state.controls++;
      store.run(`INSERT INTO backend_native_stop_controls(command_id,kind,stop_committed,cleanup_complete)
        VALUES(?,'USER_START',0,0) ON CONFLICT(command_id) DO NOTHING`, commandId);
      const row = store.get('SELECT * FROM backend_native_stop_controls WHERE command_id=?', commandId);
      return { ok: true, controlSeq: row.control_seq, kind: row.kind, journalWritten: true };
    } };
  return { store, state, backend, identity, control, putStop,
    request: () => ({ ...identity, expectedPriorRunEpoch: Number(supervisor.intent(identity.ownerRef, identity.accountRef)?.run_epoch || 0) }),
    async close() { state.release(true); await supervisor.stopAll(identity.ownerRef); store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('cooldown rejects synchronously with remaining time before native control or login changes', async () => {
  const h = harness();
  try {
    const until = Date.now() + 180000;
    h.store.run(`INSERT INTO backend_session_cooldowns(owner_ref,account_ref,subject_ref,conflict_streak,cooldown_until_ms,
      last_source,last_code,updated_at) VALUES(?,?,?,3,?,'sdk-login','2001',?)`,
      h.identity.ownerRef, h.identity.accountRef, h.identity.subjectRef, until, new Date().toISOString());
    assert.throws(() => startExplicitAccount(h.backend, h.request()), error =>
      error.code === 'SESSION_COOLDOWN_ACTIVE' && error.status === 429 && error.retryAfterMs > 179000);
    assert.equal(h.state.controls, 0);
    assert.equal(h.state.connects, 0);
    assert.equal(h.control().kind, 'STOP');
    assert.ok(h.backend.supervisor.intent(h.identity.ownerRef, h.identity.accountRef) == null);
  } finally { await h.close(); }
});

test('explicit acceptance advances native control without waiting for login; a later STOP still revokes it', async () => {
  const h = harness();
  try {
    const untouched = { ...h.identity, accountRef: '32', subjectRef: 'subject:untouched',
      evidence: { sourceRef: 'fixture:untouched', sourceVersion: 'fixture-v1' } };
    h.backend.supervisor.bind(untouched);
    const accepted = startExplicitAccount(h.backend, h.request());
    const eventual = accepted.flight.catch(error => error);
    assert.equal(h.control().kind, 'USER_START');
    assert.equal(h.state.connects, 0, 'acceptance does not await or claim successful official login');
    assert.equal(h.backend.supervisor.project(h.identity.ownerRef, h.identity.accountRef).desiredRunning, true);
    assert.equal(h.backend.supervisor.project(untouched.ownerRef, untouched.accountRef).desiredRunning, false);
    h.putStop(true);
    await h.backend.supervisor.stopAll(h.identity.ownerRef);
    h.state.release(true);
    assert.ok((await eventual) instanceof Error);
    assert.equal(h.control().kind, 'STOP');
    assert.equal(h.state.connects, 0, 'late authorization cannot connect after STOP');
    assert.equal(h.backend.supervisor.project(h.identity.ownerRef, h.identity.accountRef).desiredRunning, false);
  } finally { await h.close(); }
});

test('unfinished native STOP and superseded old start command cannot reopen a session', async () => {
  const h = harness();
  try {
    h.putStop(false);
    assert.throws(() => startExplicitAccount(h.backend, h.request()), error => error.code === 'NATIVE_STOP_PENDING');
    assert.equal(h.state.controls, 0);
    h.putStop(true);
    const old = randomUUID();
    h.backend.nativeStartControl({ commandId: old });
    h.putStop(true);
    assert.throws(() => startExplicitAccount(h.backend, { ...h.request(), commandId: old }), error => error.code === 'NATIVE_START_SUPERSEDED');
    assert.equal(h.control().kind, 'STOP');
    assert.equal(h.state.connects, 0);
  } finally { await h.close(); }
});
