import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createSubjectSupervisor } from '../runtime/backend/session/supervisor.mjs';

function sdkFailure(code, loginKind, loginCode, connectionEpoch) {
  return Object.assign(new Error('sdk login rejected'), {
    code, sourceNamespace: 'sdk-login', loginKind, loginCode,
    transportClosed: true, closedConnectionEpoch: connectionEpoch, worldSocketOpened: false,
    closeEvidenceCode: 'PROTOCOL_AUTH_NO_WORLD',
  });
}

function harness({ accountRef, subjectRef, initialMode = 'conflict', wall }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-cooldown-'));
  const state = { mode: initialMode, connects: 0, onClosed: null, confirmedContinuousMs: 0 };
  const make = store => createSubjectSupervisor({
    store, authorize: () => true, onConnected: async () => {},
    isAccountStopPending: () => state.stopPending === true,
    assertCanonicalExecution: () => state.canonicalAllowed !== false,
    isolatePreviousExecutor: async ({ subjectRef: subject }) => ({ isolated: true, subjectRef: subject,
      evidenceRef: 'fixture:isolation:' + accountRef, sourceRef: 'fixture:source:' + accountRef }),
    connect: async ({ connectionEpoch, onClosed }) => {
      state.connects += 1;
      if (state.mode === 'conflict') throw sdkFailure('REAL_SDK_LOGIN_FAILED', 'single_session', 2001, connectionEpoch);
      if (state.mode === 'throttle') throw sdkFailure('REAL_SDK_LOGIN_FAILED', 'throttle', 902051, connectionEpoch);
      state.onClosed = onClosed;
      let open = true;
      return { isOpen: () => open, close: async () => {
        open = false;
        return { closed: state.closeProven !== false, connectionEpoch, code: 'fixture-close' };
      }, liveness: () => ({ openedMono: 0, closedMono: open ? null : 1, heartbeatsConfirmed: state.confirmedContinuousMs > 0 ? 2 : 0,
        longestContinuousMs: state.confirmedContinuousMs, lastHeartbeatMono: state.confirmedContinuousMs }) };
    },
    cleanupTimeoutMs: 20, recoveryBaseMs: 50, recoveryMaxMs: 100, deviceNow: () => wall.now,
  });
  const store = openBackendStore({ dataDir });
  return { dataDir, store, supervisor: make(store), make, state,
    identity: { ownerRef: 'owner:cooldown:' + accountRef, accountRef, subjectRef, basis: 'fixture',
      identityVersion: 'fixture-v1', channel: 'official',
      evidence: { sourceRef: 'fixture:binding:' + accountRef, sourceVersion: 'fixture-v1' } } };
}

const project = (supervisor, identity) => supervisor.project(identity.ownerRef, identity.accountRef);

test('synchronous start preflight shares rejection gates without committing intent or starting a connection', async () => {
  const wall = { now: Date.now() };
  const h = harness({ accountRef: '30', subjectRef: 'subject:cooldown:30', wall });
  const { supervisor, identity, state } = h;
  const args = { ownerRef: identity.ownerRef, accountRef: identity.accountRef };
  try {
    supervisor.bind(identity);
    assert.equal(supervisor.preflightStart({ ...args, expectedPriorRunEpoch: 0 }), true);
    assert.equal(supervisor.intent(args.ownerRef, args.accountRef), null);
    assert.equal(state.connects, 0);
    const check = async (code, input = args) => {
      assert.throws(() => supervisor.preflightStart(input), error => error.code === code);
      await assert.rejects(supervisor.start({ ...input, commandId: 'preflight:' + code }), error => error.code === code);
      assert.equal(state.connects, 0, 'rejected admission never opens a connection');
    };
    await check('START_CONTROL_REVISION_INVALID', { ...args, expectedPriorRunEpoch: -1 });
    await check('RUN_INTENT_CHANGED', { ...args, expectedPriorRunEpoch: 1 });
    state.stopPending = true;
    await check('ACCOUNT_STOP_PENDING');
    state.stopPending = false;
    state.canonicalAllowed = false;
    await check('OFFICIAL_SUBJECT_ALREADY_RUNNING');
    state.canonicalAllowed = true;
    await supervisor.stop({ ...args, commandId: 'preflight:seed-stopped' });
    h.store.run("UPDATE backend_run_intents SET state='STOPPING' WHERE owner_ref=? AND account_ref=?", args.ownerRef, args.accountRef);
    await check('SUBJECT_SESSION_STOPPING');
    h.store.run("UPDATE backend_run_intents SET state='STOPPED' WHERE owner_ref=? AND account_ref=?", args.ownerRef, args.accountRef);
    supervisor.networkChanged({ online: true, transport: 'wifi' });
    await assert.rejects(supervisor.start({ ...args, commandId: 'preflight:conflict' }));
    const before = supervisor.intent(args.ownerRef, args.accountRef);
    const connects = state.connects;
    assert.throws(() => supervisor.preflightStart(args), error => error.code === 'SESSION_COOLDOWN_ACTIVE' && error.retryAfterMs > 0);
    await assert.rejects(supervisor.start({ ...args, commandId: 'preflight:cooling' }), error => error.code === 'SESSION_COOLDOWN_ACTIVE');
    assert.deepEqual(supervisor.intent(args.ownerRef, args.accountRef), before);
    assert.equal(state.connects, connects);
    supervisor.holdForProcessRestart();
    assert.throws(() => supervisor.preflightStart(args), error => error.code === 'ENGINE_RESTARTING');
    await assert.rejects(supervisor.start({ ...args, commandId: 'preflight:shutdown' }), error => error.code === 'ENGINE_RESTARTING');
  } finally {
    await supervisor.shutdownForRestart({ timeoutMs: 1000 }).catch(() => {});
    h.store.close();
    fs.rmSync(h.dataDir, { recursive: true, force: true });
  }
});

test('start preflight cannot admit an old actor without physical-close proof', async () => {
  const h = harness({ accountRef: '35', subjectRef: 'subject:cooldown:35', initialMode: 'success', wall: { now: Date.now() } });
  const { supervisor, identity, state } = h;
  const args = { ownerRef: identity.ownerRef, accountRef: identity.accountRef };
  try {
    supervisor.bind(identity);
    supervisor.networkChanged({ online: true, transport: 'wifi' });
    await supervisor.start({ ...args, commandId: 'preflight:old-start' });
    supervisor.bind({ ...identity, accountRef: '36' });
    const aliasArgs = { ownerRef: args.ownerRef, accountRef: '36' };
    assert.throws(() => supervisor.preflightStart(aliasArgs), error => error.code === 'SUBJECT_SESSION_BUSY');
    await assert.rejects(supervisor.start({ ...aliasArgs, commandId: 'preflight:same-subject-alias' }), error => error.code === 'SUBJECT_SESSION_BUSY');
    assert.equal(supervisor.intent(args.ownerRef, '36'), null, 'the second alias never commits a running intent');
    state.closeProven = false;
    const stop = await supervisor.stop({ ...args, commandId: 'preflight:unproven-stop' });
    assert.equal(stop.cleanupComplete, false);
    assert.throws(() => supervisor.preflightStart(args), error => error.code === 'SUBJECT_SESSION_CLEANUP_REQUIRED');
    await assert.rejects(supervisor.start({ ...args, commandId: 'preflight:no-replacement' }), error => error.code === 'SUBJECT_SESSION_CLEANUP_REQUIRED');
    assert.equal(state.connects, 1);
  } finally {
    state.closeProven = true;
    await supervisor.shutdownForRestart({ timeoutMs: 1000 }).catch(() => {});
    h.store.close();
    fs.rmSync(h.dataDir, { recursive: true, force: true });
  }
});

test('SDK single-session conflict escalates a persistent cooldown that survives network restore, restart and STOP+START', async () => {
  const wall = { now: Date.now() };
  const h = harness({ accountRef: '31', subjectRef: 'subject:cooldown:31', wall });
  try {
    const { supervisor, identity } = h;
    supervisor.bind(identity);
    supervisor.networkChanged({ online: true, transport: 'wifi' });

    await assert.rejects(supervisor.start({ ownerRef: identity.ownerRef, accountRef: identity.accountRef, commandId: 'c:start-1' }));
    let p = project(supervisor, identity);
    assert.equal(p.desiredRunning, true);
    assert.equal(p.recovery.state, 'scheduled');
    assert.equal(p.cooldown.conflictStreak, 1);
    assert.equal(p.cooldown.lastSource, 'sdk-login');
    assert.ok(p.cooldown.untilMs - wall.now >= 15000, 'first conflict uses the SDK 15s lower bound');
    assert.equal(p.retryAtMs, p.cooldown.untilMs, 'the retry may not precede the cooldown floor');
    const firstFloor = p.cooldown.untilMs;

    // A network flap is not evidence that the other client left.
    supervisor.networkChanged({ online: false, transport: 'none' });
    supervisor.networkChanged({ online: true, transport: 'wifi' });
    p = project(supervisor, identity);
    assert.ok(p.retryAtMs >= firstFloor, 'network restore must not pull the retry before the cooldown');

    // A process restart is not evidence either.
    await supervisor.shutdownForRestart({ timeoutMs: 1000 });
    h.store.close();
    const store2 = openBackendStore({ dataDir: h.dataDir });
    const supervisor2 = h.make(store2);
    try {
      supervisor2.bind(identity);
      supervisor2.networkChanged({ online: true, transport: 'wifi' });
      supervisor2.resumeDesired(identity.ownerRef);
      const resumed = project(supervisor2, identity);
      assert.equal(resumed.desiredRunning, true);
      assert.ok(resumed.retryAtMs >= firstFloor, 'restart must not shorten the persisted cooldown');

      // A user STOP + START may not shorten it either.
      await supervisor2.stop({ ownerRef: identity.ownerRef, accountRef: identity.accountRef, commandId: 'c:stop', reasonCode: 'FIXTURE_STOP' });
      await assert.rejects(supervisor2.start({ ownerRef: identity.ownerRef, accountRef: identity.accountRef, commandId: 'c:start-2' }),
        error => error.code === 'SESSION_COOLDOWN_ACTIVE' && error.retryAfterMs > 0 && error.retryAfterMs <= 15000);

      // After the floor, a second conflict escalates instead of looping at 15s.
      wall.now += 15001;
      await assert.rejects(supervisor2.start({ ownerRef: identity.ownerRef, accountRef: identity.accountRef, commandId: 'c:start-3' }));
      p = project(supervisor2, identity);
      assert.equal(p.cooldown.conflictStreak, 2);
      assert.ok(p.cooldown.untilMs - wall.now >= 30000, 'repeated conflict doubles the cooldown');

      // A connection that stayed up for the configured window starts a new
      // streak. Only confirmed continuous heartbeats count, never wall time.
      wall.now += 30001;
      h.state.mode = 'success';
      h.state.confirmedContinuousMs = 5 * 60_000 + 1000;
      await supervisor2.start({ ownerRef: identity.ownerRef, accountRef: identity.accountRef, commandId: 'c:start-4' });
      assert.equal(project(supervisor2, identity).connected, true);
      await supervisor2.stop({ ownerRef: identity.ownerRef, accountRef: identity.accountRef, commandId: 'c:stop-2', reasonCode: 'FIXTURE_STOP' });
      wall.now += 5 * 60_000 + 1;
      h.state.mode = 'conflict';
      await assert.rejects(supervisor2.start({ ownerRef: identity.ownerRef, accountRef: identity.accountRef, commandId: 'c:start-5' }));
      p = project(supervisor2, identity);
      assert.equal(p.cooldown.conflictStreak, 1, 'a stable session retires the previous streak');
      assert.ok(p.cooldown.untilMs - wall.now >= 15000 && p.cooldown.untilMs - wall.now < 30000);
    } finally {
      await supervisor2.shutdownForRestart({ timeoutMs: 1000 }).catch(() => {});
      store2.close();
    }
  } finally {
    await h.supervisor.shutdownForRestart({ timeoutMs: 1000 }).catch(() => {});
    try { h.store.close(); } catch { /* already replaced by the restarted supervisor's store */ }
    fs.rmSync(h.dataDir, { recursive: true, force: true });
  }
});

test('SDK throttle cooldown also survives network restore and STOP+START', async () => {
  const wall = { now: Date.now() };
  const h = harness({ accountRef: '32', subjectRef: 'subject:cooldown:32', initialMode: 'throttle', wall });
  try {
    const { supervisor, identity } = h;
    supervisor.bind(identity);
    supervisor.networkChanged({ online: true, transport: 'wifi' });
    await assert.rejects(supervisor.start({ ownerRef: identity.ownerRef, accountRef: identity.accountRef, commandId: 't:start-1' }));
    const first = project(supervisor, identity);
    assert.ok(first.cooldown.untilMs - wall.now >= 180000, 'the SDK wait-time lower bound is persisted');
    supervisor.networkChanged({ online: false, transport: 'none' });
    supervisor.networkChanged({ online: true, transport: 'wifi' });
    assert.ok(project(supervisor, identity).retryAtMs >= first.cooldown.untilMs);
    await supervisor.stop({ ownerRef: identity.ownerRef, accountRef: identity.accountRef, commandId: 't:stop', reasonCode: 'FIXTURE_STOP' });
    await assert.rejects(supervisor.start({ ownerRef: identity.ownerRef, accountRef: identity.accountRef, commandId: 't:start-2' }),
      error => error.code === 'SESSION_COOLDOWN_ACTIVE' && error.retryAfterMs > 170000);
  } finally {
    await h.supervisor.shutdownForRestart({ timeoutMs: 1000 }).catch(() => {});
    h.store.close();
    fs.rmSync(h.dataDir, { recursive: true, force: true });
  }
});
test('a short session plus more than five minutes offline never looks like a stable connection', async () => {
  const wall = { now: Date.now() };
  const h = harness({ accountRef: '33', subjectRef: 'subject:cooldown:33', wall });
  try {
    const { supervisor, identity } = h;
    supervisor.bind(identity);
    supervisor.networkChanged({ online: true, transport: 'wifi' });
    await assert.rejects(supervisor.start({ ownerRef: identity.ownerRef, accountRef: identity.accountRef, commandId: 's:start-1' }));
    assert.equal(project(supervisor, identity).cooldown.conflictStreak, 1);
    wall.now += 15001;

    // Two confirmed seconds of connection, then a disconnect.
    h.state.mode = 'success';
    h.state.confirmedContinuousMs = 2000;
    await supervisor.start({ ownerRef: identity.ownerRef, accountRef: identity.accountRef, commandId: 's:start-2' });
    assert.equal(project(supervisor, identity).connected, true);
    await supervisor.stop({ ownerRef: identity.ownerRef, accountRef: identity.accountRef, commandId: 's:stop-1', reasonCode: 'FIXTURE_STOP' });

    // Wall time since the connect keeps growing, but none of it was connected.
    wall.now += 5 * 60_000 + 1;
    h.state.mode = 'conflict';
    await assert.rejects(supervisor.start({ ownerRef: identity.ownerRef, accountRef: identity.accountRef, commandId: 's:start-3' }));
    const p = project(supervisor, identity);
    assert.equal(p.cooldown.conflictStreak, 2, 'offline waiting time may not retire the streak');
    assert.ok(p.cooldown.untilMs - wall.now >= 30000, 'the escalated floor still applies');
    assert.equal(p.cooldown.confirmedStableMs, 0, 'the short confirmed span cannot be reused');
  } finally {
    await h.supervisor.shutdownForRestart({ timeoutMs: 1000 }).catch(() => {});
    h.store.close();
    fs.rmSync(h.dataDir, { recursive: true, force: true });
  }
});

test('stability evidence is spent once for the real subject and a spent state never returns after restart', async () => {
  const wall = { now: Date.now() };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-cooldown-oneshot-'));
  const ownerRef = 'owner:cooldown:oneshot';
  const store = openBackendStore({ dataDir });
  const state = { mode: 'conflict', confirmedContinuousMs: 0 };
  const SUPERVISOR_UID = 480, SAME_CHARACTER = 42030917102202;
  let supervisor = null;
  try {
    store.db.exec(`CREATE TABLE IF NOT EXISTS backend_official_subject_identities(
      owner_ref TEXT NOT NULL, subject_ref TEXT NOT NULL, subject_key TEXT NOT NULL, canonical_ref TEXT NOT NULL,
      primary_subject_ref TEXT NOT NULL, server_id INTEGER NOT NULL CHECK(server_id>0),
      official_uid INTEGER NOT NULL CHECK(official_uid>0), updated_at TEXT NOT NULL,
      PRIMARY KEY(owner_ref, subject_ref));`);
    const stamp = new Date().toISOString();
    const putIdentity = (subjectRef, uid) => store.run('INSERT OR REPLACE INTO backend_official_subject_identities VALUES(?,?,?,?,?,?,?,?)',
      ownerRef, subjectRef, SUPERVISOR_UID + ':' + uid, 'official-subject:' + uid, subjectRef, SUPERVISOR_UID, uid, stamp);
    putIdentity('subject:oneshot:a', SAME_CHARACTER);
    putIdentity('subject:oneshot:b', SAME_CHARACTER);

    const make = db => createSubjectSupervisor({
      store: db, authorize: () => true, onConnected: async () => {},
      isolatePreviousExecutor: async ({ subjectRef }) => ({ isolated: true, subjectRef,
        evidenceRef: 'fixture:isolation:' + subjectRef, sourceRef: 'fixture:source:' + subjectRef }),
      connect: async ({ connectionEpoch }) => {
        if (state.mode === 'conflict') throw sdkFailure('REAL_SDK_LOGIN_FAILED', 'single_session', 2001, connectionEpoch);
        let open = true;
        return { isOpen: () => open, close: async () => { open = false; return { closed: true, connectionEpoch, code: 'fixture-close' }; },
          liveness: () => ({ openedMono: 0, closedMono: open ? null : 1, heartbeatsConfirmed: 2,
            longestContinuousMs: state.confirmedContinuousMs, lastHeartbeatMono: state.confirmedContinuousMs }) };
      },
      cleanupTimeoutMs: 20, recoveryBaseMs: 50, recoveryMaxMs: 100, deviceNow: () => wall.now });
    const identityOf = (accountRef, subjectRef) => ({ ownerRef, accountRef, subjectRef, basis: 'fixture',
      identityVersion: 'fixture-v1', channel: 'official',
      evidence: { sourceRef: 'fixture:binding:' + accountRef, sourceVersion: 'fixture-v1' } });
    const A = identityOf('51', 'subject:oneshot:a'), B = identityOf('52', 'subject:oneshot:b');
    const bindAll = target => { for (const id of [A, B]) target.bind(id); target.networkChanged({ online: true, transport: 'wifi' }); };
    const startOf = (target, id, commandId) => assert.rejects(target.start({ ownerRef, accountRef: id.accountRef, commandId }));
    const scope = 'verified:official-subject:' + SAME_CHARACTER;

    supervisor = make(store);
    bindAll(supervisor);
    // Alias A reaches two escalations on its own.
    await startOf(supervisor, A, 'o:a-1');
    assert.equal(supervisor.project(ownerRef, '51').cooldown.conflictStreak, 1);
    wall.now += 15001;
    await startOf(supervisor, A, 'o:a-2');
    assert.equal(supervisor.project(ownerRef, '51').cooldown.conflictStreak, 2);

    // A genuinely stable session is captured as subject evidence.
    wall.now += 30001;
    state.mode = 'success'; state.confirmedContinuousMs = 5 * 60_000 + 2000;
    await supervisor.start({ ownerRef, accountRef: '51', commandId: 'o:a-stable' });
    assert.equal(supervisor.project(ownerRef, '51').connected, true);
    await supervisor.stop({ ownerRef, accountRef: '51', commandId: 'o:a-stop', reasonCode: 'FIXTURE_STOP' });
    assert.ok(Number(store.get('SELECT stable_connected_ms AS ms FROM backend_session_cooldown_subjects WHERE owner_ref=? AND subject_scope=?',
      ownerRef, scope)?.ms) >= 5 * 60_000, 'the stable session is recorded for the real subject');

    // Alias B of the same character spends that evidence: the shared streak
    // drops to 1 and the evidence is zero for every alias.
    state.mode = 'conflict';
    await startOf(supervisor, B, 'o:b-1');
    assert.equal(supervisor.project(ownerRef, '52').cooldown.conflictStreak, 1, 'B consumes the shared stable session');
    assert.equal(supervisor.project(ownerRef, '51').cooldown.confirmedStableMs, 0, "A's copy of the evidence is retired too");
    assert.equal(supervisor.project(ownerRef, '52').cooldown.confirmedStableMs, 0);

    // Back to alias A: the already-spent evidence must not reset the streak again.
    wall.now += 15001;
    await startOf(supervisor, A, 'o:a-3');
    assert.equal(supervisor.project(ownerRef, '51').cooldown.conflictStreak, 2, 'a second alias cannot spend the same stable session');

    // Restart: the consumed state is durable and the model is not rebuilt from
    // an alias row that still carries the pre-consumption value.
    await supervisor.shutdownForRestart({ timeoutMs: 200 }).catch(() => {});
    supervisor = null;
    supervisor = make(store);
    supervisor.bind(A); supervisor.bind(B);
    supervisor.networkChanged({ online: true, transport: 'wifi' });
    const subject = store.get('SELECT * FROM backend_session_cooldown_subjects WHERE owner_ref=? AND subject_scope=?', ownerRef, scope);
    assert.equal(Number(subject.conflict_streak), 2);
    assert.equal(Number(subject.stable_connected_ms), 0, 'restart does not refill spent evidence');
    assert.equal(supervisor.project(ownerRef, '51').cooldown.conflictStreak, 2);

    // A stale alias row (an artifact of an older build) cannot inflate the count
    // on the next restart either.
    store.run(`UPDATE backend_session_cooldowns SET conflict_streak=9,stable_connected_ms=?,evidence_generation=0
      WHERE owner_ref=? AND account_ref='51'`, 5 * 60_000 + 2000, ownerRef);
    await supervisor.shutdownForRestart({ timeoutMs: 200 }).catch(() => {});
    supervisor = null;
    supervisor = make(store);
    supervisor.bind(A);
    supervisor.networkChanged({ online: true, transport: 'wifi' });
    assert.equal(supervisor.project(ownerRef, '51').cooldown.conflictStreak, 2, 'migration may not resurrect a retired count');
    const reread = store.get('SELECT * FROM backend_session_cooldown_subjects WHERE owner_ref=? AND subject_scope=?', ownerRef, scope);
    assert.equal(Number(reread.conflict_streak), 2, 'migration never raises the shared streak from an alias row');
    assert.equal(Number(reread.stable_connected_ms), 0, 'migration never refills consumed subject evidence from a stale alias');

    // The next real conflict escalates from the persisted canonical count.
    wall.now += 30001;
    await startOf(supervisor, A, 'o:a-4');
    assert.equal(supervisor.project(ownerRef, '51').cooldown.conflictStreak, 3);
  } finally {
    await supervisor?.shutdownForRestart({ timeoutMs: 200 }).catch(() => {});
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
for (const streaks of [[1, 4], [4, 1]]) {
  test('legacy alias migration keeps the maximum streak in order ' + streaks.join(','), async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-cooldown-legacy-'));
    const store = openBackendStore({ dataDir });
    const ownerRef = 'owner:cooldown:legacy', scope = 'verified:official-subject:42030917102202';
    const wall = { now: Date.now() }, floor = wall.now + 300_000;
    let supervisor = null;
    try {
      // The legacy schema has per-alias cooldowns and no shared-subject table.
      store.db.exec(`CREATE TABLE backend_session_cooldowns(
        owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
        conflict_streak INTEGER NOT NULL,cooldown_until_ms INTEGER NOT NULL,
        last_source TEXT NOT NULL,last_code TEXT,last_connected_ms INTEGER,
        last_run_epoch INTEGER,last_connection_epoch INTEGER,updated_at TEXT NOT NULL,
        PRIMARY KEY(owner_ref,account_ref));
        CREATE TABLE backend_official_subject_identities(
        owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,subject_key TEXT NOT NULL,canonical_ref TEXT NOT NULL,
        primary_subject_ref TEXT NOT NULL,server_id INTEGER NOT NULL,official_uid INTEGER NOT NULL,updated_at TEXT NOT NULL,
        PRIMARY KEY(owner_ref,subject_ref));`);
      for (const [index, streak] of streaks.entries()) {
        const subjectRef = 'subject:legacy:' + index, accountRef = String(61 + index), stamp = new Date().toISOString();
        store.run('INSERT INTO backend_official_subject_identities VALUES(?,?,?,?,?,?,?,?)', ownerRef, subjectRef,
          '480:42030917102202', 'official-subject:42030917102202', subjectRef, 480, 42030917102202, stamp);
        store.run('INSERT INTO backend_session_cooldowns VALUES(?,?,?,?,?,?,?,?,?,?,?)', ownerRef, accountRef, subjectRef,
          streak, streak === 1 ? floor : wall.now + 120_000, 'sdk-login', 'REAL_SDK_LOGIN_FAILED', null, 10, 10, stamp);
      }
      supervisor = createSubjectSupervisor({ store, authorize: () => true,
        isolatePreviousExecutor: async ({ subjectRef }) => ({ isolated: true, subjectRef,
          evidenceRef: 'fixture:isolation:' + subjectRef, sourceRef: 'fixture:source:' + subjectRef }),
        connect: async ({ connectionEpoch }) => { throw sdkFailure('REAL_SDK_LOGIN_FAILED', 'single_session', 2001, connectionEpoch); },
        cleanupTimeoutMs: 20, recoveryBaseMs: 50, recoveryMaxMs: 100, deviceNow: () => wall.now });
      const migrated = store.get('SELECT * FROM backend_session_cooldown_subjects WHERE owner_ref=? AND subject_scope=?', ownerRef, scope);
      assert.equal(Number(migrated.conflict_streak), 4, 'all legacy aliases contribute before the new subject becomes authoritative');
      assert.equal(Number(migrated.cooldown_until_ms), floor, 'the strictest floor is independent of the maximum streak');
      supervisor.bind({ ownerRef, accountRef: '61', subjectRef: 'subject:legacy:0', basis: 'fixture',
        identityVersion: 'fixture-v1', channel: 'official', evidence: { sourceRef: 'fixture:binding:61', sourceVersion: 'fixture-v1' } });
      supervisor.networkChanged({ online: true, transport: 'wifi' });
      wall.now = floor + 1;
      await assert.rejects(supervisor.start({ ownerRef, accountRef: '61', commandId: 'legacy:next' }));
      assert.equal(supervisor.project(ownerRef, '61').cooldown.conflictStreak, 5, 'the next real conflict escalates from the migrated maximum');
    } finally {
      await supervisor?.shutdownForRestart({ timeoutMs: 200 }).catch(() => {});
      store.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
}

test('a verified server+UID shares one cooldown across login aliases while other real subjects stay independent', async () => {
  const wall = { now: Date.now() };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-cooldown-alias-'));
  const ownerRef = 'owner:cooldown:alias';
  const store = openBackendStore({ dataDir });
  let supervisor = null, second = null;
  try {
    // Shape written by the accounts module once a real server+UID is verified.
    store.db.exec(`CREATE TABLE IF NOT EXISTS backend_official_subject_identities(
      owner_ref TEXT NOT NULL, subject_ref TEXT NOT NULL, subject_key TEXT NOT NULL, canonical_ref TEXT NOT NULL,
      primary_subject_ref TEXT NOT NULL, server_id INTEGER NOT NULL CHECK(server_id>0),
      official_uid INTEGER NOT NULL CHECK(official_uid>0), updated_at TEXT NOT NULL,
      PRIMARY KEY(owner_ref, subject_ref));`);
    const stamp = new Date().toISOString();
    const putIdentity = (subjectRef, uid) => store.run('INSERT OR REPLACE INTO backend_official_subject_identities VALUES(?,?,?,?,?,?,?,?)',
      ownerRef, subjectRef, '480:' + uid, 'official-subject:' + uid, subjectRef, 480, uid, stamp);
    putIdentity('subject:alias:s1', 42030917102202);
    putIdentity('subject:alias:s2', 42030917102202);
    putIdentity('subject:alias:s3', 97155634104312);

    const make = db => createSubjectSupervisor({
      store: db, authorize: () => true, onConnected: async () => {},
      isolatePreviousExecutor: async ({ subjectRef }) => ({ isolated: true, subjectRef,
        evidenceRef: 'fixture:isolation:' + subjectRef, sourceRef: 'fixture:source:' + subjectRef }),
      connect: async ({ connectionEpoch }) => { throw sdkFailure('REAL_SDK_LOGIN_FAILED', 'single_session', 2001, connectionEpoch); },
      cleanupTimeoutMs: 20, recoveryBaseMs: 50, recoveryMaxMs: 100, deviceNow: () => wall.now });
    supervisor = make(store);
    const identityOf = (accountRef, subjectRef) => ({ ownerRef, accountRef, subjectRef, basis: 'fixture',
      identityVersion: 'fixture-v1', channel: 'official',
      evidence: { sourceRef: 'fixture:binding:' + accountRef, sourceVersion: 'fixture-v1' } });
    for (const id of [identityOf('41', 'subject:alias:s1'), identityOf('42', 'subject:alias:s2'),
      identityOf('43', 'subject:alias:s3'), identityOf('44', 'subject:alias:unverified')]) supervisor.bind(id);
    supervisor.networkChanged({ online: true, transport: 'wifi' });

    await assert.rejects(supervisor.start({ ownerRef, accountRef: '41', commandId: 'a:start-1' }));
    const floor = supervisor.project(ownerRef, '41').cooldown.untilMs;
    assert.equal(supervisor.project(ownerRef, '41').cooldown.conflictStreak, 1);

    // Another login alias of the same verified character inherits the floor.
    await assert.rejects(supervisor.start({ ownerRef, accountRef: '42', commandId: 'a:start-2' }),
      error => error.code === 'SESSION_COOLDOWN_ACTIVE' && error.cooldownUntilMs === floor);
    assert.equal(supervisor.project(ownerRef, '42').cooldown.conflictStreak, 1);

    // An identity that was never verified is not normalised by guesswork.
    let unverified = null;
    await supervisor.start({ ownerRef, accountRef: '44', commandId: 'a:start-3' }).catch(error => { unverified = error; });
    assert.notEqual(unverified?.code, 'SESSION_COOLDOWN_ACTIVE');

    // A different real character keeps its own independent floor.
    let other = null;
    await supervisor.start({ ownerRef, accountRef: '43', commandId: 'a:start-4' }).catch(error => { other = error; });
    assert.notEqual(other?.code, 'SESSION_COOLDOWN_ACTIVE');
    assert.equal(supervisor.project(ownerRef, '43').cooldown.conflictStreak, 1);

    // The two aliases share one subject row keyed on the verified identity.
    const sharedScope = 'verified:official-subject:42030917102202';
    const shared = store.get('SELECT * FROM backend_session_cooldown_subjects WHERE owner_ref=? AND subject_scope=?', ownerRef, sharedScope);
    assert.ok(shared, 'a verified subject row exists');
    assert.ok(Number(shared.cooldown_until_ms) >= floor);

    // Pre-existing per-alias rows keep their floor when the shared mirror is
    // rebuilt by a new supervisor (upgrade path from the per-alias schema).
    store.run(`DELETE FROM backend_session_cooldown_subjects WHERE owner_ref=? AND subject_scope LIKE 'verified:%'`, ownerRef);
    await supervisor.shutdownForRestart({ timeoutMs: 200 }).catch(() => {});
    supervisor = null;
    second = make(store);
    second.bind(identityOf('41', 'subject:alias:s1'));
    second.networkChanged({ online: true, transport: 'wifi' });
    const migrated = store.get('SELECT * FROM backend_session_cooldown_subjects WHERE owner_ref=? AND subject_scope=?', ownerRef, sharedScope);
    assert.ok(migrated, 'migration mirrors the existing per-alias floor onto the verified subject');
    assert.ok(Number(migrated.cooldown_until_ms) >= floor, 'migration never shortens a persisted floor');
    await assert.rejects(second.start({ ownerRef, accountRef: '42', commandId: 'a:start-5' }),
      error => error.code === 'SESSION_COOLDOWN_ACTIVE' && error.cooldownUntilMs >= floor);
  } finally {
    await second?.shutdownForRestart({ timeoutMs: 200 }).catch(() => {});
    await supervisor?.shutdownForRestart({ timeoutMs: 200 }).catch(() => {});
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
