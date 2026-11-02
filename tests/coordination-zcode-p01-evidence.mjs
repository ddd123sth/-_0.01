import assert from 'node:assert/strict';
import test from 'node:test';
import { P01_REQUIRED, recoveredP01Sample, recoveredIsolationSample, liveAppointmentIdentity, oldAppointmentBroadcast, analyzeP01Samples } from '../tools/coordination-zcode-p01-window.mjs';

const generation = '11111111-2222-4333-8444-555555555555';
const initial = { connectionEpoch: 5, generation };
const running = { atMs: 3000, state: 'running', running: true, desiredRunning: true, runEpoch: 3,
  engineInstance: generation, nativeStop: { stopCommitted: false, controlSeq: 2 },
  intent: { desiredRunning: 1, state: 'RUNNABLE', runEpoch: 3, connectionEpoch: 6, retryAtMs: null },
  projection: { desiredRunning: true, accountRef: '3', scopeHash: 'scope:3', runEpoch: 3, connectionEpoch: 6 } };

test('short isolation requires a real increasing durable CE, never a missing public-account field or NaN', () => {
  const row = { ...running, connectionEpoch: 6 };
  assert.equal(recoveredIsolationSample(row, initial), true);
  for (const connectionEpoch of [undefined, null, NaN, 5, 4])
    assert.equal(recoveredIsolationSample({ ...row, connectionEpoch }, initial), false);
  assert.equal(recoveredIsolationSample({ ...row, state: 'starting' }, initial), false);
  assert.equal(recoveredIsolationSample({ ...row, desiredRunning: false }, initial), false);
  assert.equal(recoveredIsolationSample({ ...row, intent: { ...row.intent, connectionEpoch: 7 } }, initial), false);
});

test('P01 accepts actual new-epoch recovery, never a running intent or handling receipt alone', () => {
  assert.equal(recoveredP01Sample(running, initial, 2000), true);
  assert.equal(recoveredP01Sample({ ...running, state: 'starting' }, initial, 2000), false);
  assert.equal(recoveredP01Sample({ ...running, state: 'waiting_login' }, initial, 2000), false);
  assert.equal(recoveredP01Sample(running, { ...initial, connectionEpoch: 6 }, 2000), false);
  assert.equal(recoveredP01Sample(running, initial, null), false);
  assert.equal(recoveredP01Sample(running, initial, 4000), false);
  const passed = Object.fromEntries(P01_REQUIRED.map(key => [key, true]));
  for (const key of ['futureDeadlineCaptured', 'nativeAppointmentScheduled', 'deliveryReceived', 'handlingReceived',
    'accountRecoveredRunning', 'recoveredOnNewConnectionEpoch', 'liveAppointmentRereadStable', 'oldAppointmentRejectedAfterRecovery']) {
    assert.ok(P01_REQUIRED.includes(key));
    assert.deepEqual(P01_REQUIRED.filter(required => ({ ...passed, [key]: false })[required] !== true), [key]);
  }
});

test('live reread identity requires a still-valid appointment and exact current intent', () => {
  const row = { ...running, alarm: { id: generation, generation, epoch: 1, scheduled: true, deadlineAtMs: 10000,
    requestedAtMs: 1000, accountRef: '3', scopeHash: 'scope:3', runEpoch: 3, controlSeq: 2 },
    intent: { ...running.intent, retryAtMs: 10000 } };
  const key = liveAppointmentIdentity(row);
  assert.ok(key);
  assert.equal(liveAppointmentIdentity({ ...row, atMs: 9500 }), null);
  assert.equal(liveAppointmentIdentity({ ...row, nativeStop: { ...row.nativeStop, stopCommitted: true } }), null);
  assert.equal(liveAppointmentIdentity({ ...row, intent: { ...row.intent, connectionEpoch: 7 } }), null);
  assert.equal(liveAppointmentIdentity({ ...row, nativeStop: { ...row.nativeStop, controlSeq: 3 } }), null);
  const command = oldAppointmentBroadcast('online.ainiannian.wujinxia', row.alarm);
  assert.match(command, /KeepAliveReceiver.*RECONNECT_DUE/);
  assert.match(command, /--es reconnectId/);
  assert.doesNotMatch(command, /connectionEpoch|stop-all/);
  assert.throws(() => oldAppointmentBroadcast('foreign.package', row.alarm));
});

test('replacement appointments keep separate chains and late-observed future alarms can be the delivered one', () => {
  const idA = generation, idB = '66666666-7777-4888-9999-aaaaaaaaaaaa';
  const appointment = (id, atMs, deadlineAtMs) => ({ ...running, atMs, deviceAtMs: atMs, state: 'waiting_login',
    intent: { ...running.intent, state: 'WAITING_LOGIN', retryAtMs: deadlineAtMs },
    alarm: { id, generation, epoch: 1, scheduled: true, deadlineAtMs, requestedAtMs: 500,
      accountRef: '3', scopeHash: 'scope:3', runEpoch: 3, controlSeq: 2 } });
  const first = appointment(idA, 1000, 10000), reread = appointment(idA, 2100, 10000);
  // B has only 500ms remaining when first observed: enough to prove a real
  // future appointment, although it cannot provide the separate 1s live reread.
  const replacement = appointment(idB, 10500, 11000);
  replacement.alarm.replacesId = idA;
  const delivered = { ...replacement, atMs: 11010, deviceAtMs: 11010,
    alarm: { ...replacement.alarm, scheduled: false, state: 'delivered' },
    delivery: { id: idB, receivedAtMs: 11000, outcome: 'forward-accepted' },
    handling: { id: idB, handledAtMs: 11001, outcome: 'accepted-passive-recovery', generation, epoch: 1 } };
  const restored = { ...running, atMs: 13000, deviceAtMs: 13000 };
  const result = analyzeP01Samples([first, reread, replacement, delivered, restored],
    { initial, faultStartMs: 0, restoredAtMs: 12000 });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].complete, false);
  assert.equal(result.selected.id, idB);
  assert.equal(result.selected.futureDeadline.aheadMs, 500);
  assert.equal(result.selected.delivery.id, result.selected.handling.id);
  assert.equal(result.liveReread.a.alarmId, idA, 'reread evidence stays attributed to its actual appointment');
  assert.equal(result.recovered.sampleIndex, 4);
});

test('actual running is recorded even when appointment receipts are absent', () => {
  const result = analyzeP01Samples([running], { initial, faultStartMs: 0, restoredAtMs: 2000 });
  assert.equal(result.selected, null, 'missing native chain must stay missing');
  assert.equal(result.recovered.state, 'running');
  assert.equal(result.recovered.sampleIndex, 0);
});
