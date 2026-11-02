import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createObservationLog, safeRecoveryPhase } from '../runtime/backend/observability/logs.mjs';
import { createCloudLogSync } from '../runtime/backend/observability/cloud-sync.mjs';
import { canonical, fingerprint } from '../runtime/backend/common.mjs';

test('log search filters in SQLite before paging and treats Chinese and LIKE metacharacters literally', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-log-search-'));
  const store = openBackendStore({ dataDir: root });
  try {
    const logs = createObservationLog({ store });
    for (let index = 1; index <= 25; index += 1) logs.append({
      ownerRef: 'owner-test', accountRef: '7', category: '运行状态', level: index <= 2 ? 'error' : 'info',
      message: index <= 2 ? `花架核验未完成 ${index} · literal %_ 符号` : `普通运行记录 ${index}`,
      detail: { eventType: 'gateway.response', errorCode: index === 2 ? 'ORDER_FLOWER_MATCHED_ANSWER_UNPROVEN' : index === 1 ? 'OLDER_MATCH' : 'OK',
        operationId: index <= 2 ? `op-percent-literal-${index}` : `op-${index}`, phase: 'verify', outcomeState: index <= 2 ? 'unknown' : 'confirmed',
        ...(index <= 2 ? { reason: 'x'.repeat(700) } : {}) },
      eventRef: `event-${index}`
    });
    const hit = logs.page({ ownerRef: 'owner-test', accountRef: '7', limit: 1, keyword: '花架核验' });
    assert.equal(hit.logs.length, 1);
    assert.match(hit.logs[0].message, /花架核验未完成 2/);
    assert.equal(hit.page.hasMore, true);
    const older = logs.page({ ownerRef: 'owner-test', accountRef: '7', limit: 1, keyword: '花架核验', beforeLocalId: hit.page.older.localId });
    assert.match(older.logs[0].message, /花架核验未完成 1/);
    const literal = logs.page({ ownerRef: 'owner-test', accountRef: '7', limit: 5, keyword: '%_' });
    assert.equal(literal.logs.length, 2);
    assert.match(literal.logs[0].message, /%_/);
    const structured = logs.page({ ownerRef: 'owner-test', accountRef: '7', limit: 5, errorCode: 'ORDER_FLOWER_MATCHED_ANSWER_UNPROVEN', outcomeState: 'unknown' });
    assert.equal(structured.logs.length, 1);
    assert.equal(structured.logs[0].detail.phase, 'verify');
    assert.equal(structured.logs[0].truncated, true);
    logs.append({ ownerRef: 'owner-test', accountRef: '7', message: '旧结果字段兼容', detail: { verdict: 'unknown' }, eventRef: 'legacy-verdict' });
    assert.equal(logs.page({ ownerRef: 'owner-test', accountRef: '7', outcomeState: 'unknown', keyword: '旧结果字段兼容' }).logs[0].outcomeState, 'unknown');
    logs.append({ ownerRef: 'owner-test', accountRef: '7', message: '常规登录刷新已完成', eventType: 'dynamic-refresh-completed',
      outcomeState: null, attempted: true, runEpoch: 3, connectionEpoch: 9, phase: 'completed', retryAtMs: 123456,
      detail: { eventState: 'completed', domains: ['inventory'] }, eventRef: 'dynamic-refresh-state' });
    const refresh = logs.page({ ownerRef: 'owner-test', accountRef: '7', keyword: 'dynamic-refresh-completed' }).logs[0];
    assert.equal(refresh.detail.eventState, 'completed');
    assert.equal(refresh.outcomeState, null);
    assert.equal(refresh.eventType, 'dynamic-refresh-completed');
    assert.equal(refresh.attempted, true);
    assert.equal(refresh.runEpoch, 3);
    assert.equal(refresh.connectionEpoch, 9);
    assert.equal(refresh.retryAtMs, 123456);
    logs.append({ ownerRef: 'owner-test', accountRef: '7', message: '登录协议错误保留原码', eventType: 'session-recovery',
      detail: { eventState: 'failed', reasonCode: 'R'.repeat(80), transportCode: 'T'.repeat(72), code: 2037,
        serverMsgCode: 4100, loginCode: 2011, phase: 'connect', method: 'GET' }, eventRef: 'typed-long-codes' });
    const typed = logs.page({ ownerRef: 'owner-test', accountRef: '7', keyword: '登录协议错误' }).logs[0];
    assert.equal(typed.detail.reasonCode, 'R'.repeat(80));
    assert.equal(typed.detail.transportCode, 'T'.repeat(72));
    assert.equal(typed.detail.code, 2037);
    assert.equal(typed.detail.serverMsgCode, 4100);
    assert.equal(typed.detail.loginCode, 2011);
    assert.equal(typed.truncated, false);
    store.run("UPDATE backend_local_logs SET occurred_at=? WHERE event_ref=?", '2026-10-24T16:30:00.000Z', 'event-2');
    const shanghaiDay = logs.page({ ownerRef: 'owner-test', accountRef: '7', day: '2026-10-25', keyword: '花架核验未完成 2' });
    assert.equal(shanghaiDay.logs.length, 1);
    assert.equal(shanghaiDay.timeZone, 'Asia/Shanghai');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('localized authentication phase and numeric source codes survive local log to cloud projection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-log-projection-'));
  const store = openBackendStore({ dataDir: root });
  const installId = 'install-typed-01'; let projected;
  try {
    const logs = createObservationLog({ store });
    const ownerRef = 'cloud:' + 'a'.repeat(64) + ':software:1';
    logs.append({ ownerRef, accountRef: '0', category: '连接恢复', level: 'error',
      message: '渠道认证未完成，已记录安全原因', eventRef: 'recovery-local-projection', eventType: 'session-recovery',
      traceId: 'sr:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWX', errorCode: 'SESSION_START_FAILED',
      attempted: true, runEpoch: 3, connectionEpoch: 4, phase: safeRecoveryPhase('官服账号认证'),
      detail: { eventState: 'failed', phase: safeRecoveryPhase('官服账号认证'), sourceNamespace: 'v5-account',
        reasonCode: 'R'.repeat(80), code: 2037, remoteCode: 14101, transportCode: -7, retryAtMs: 1793000000000,
        status: 'scheduled', closureProven: true, readFailureKind: 'SocketTimeoutException', domainId: 'profile',
        path: 'backend/facts/dynamic-state.mjs:429:24 > backend/persistence/store.mjs:62:16',
        difference: 'same-response-projection-changed', changedPaths: [], removedPaths: [], addedPaths: [],
        rawAnchorMatches: true, priorProjectionReceiptAvailable: true, proofAdvanced: false } });
    const sync = createCloudLogSync({ store, cloudRef: 'a'.repeat(64), installId, sourceInstallId: installId,
      appVersion: 'test', identity: () => ({ signedIn: true, ownerRef, identityEpoch: 1, installId }),
      sendLogs: async ({ events }) => { projected = events[0]; return { accepted: events.map(item => item.eventId), duplicates: [], rejected: [], receivedAt: new Date().toISOString() }; } });
    const selection = logs.selectIds({ ownerRef, accountRef: '0', level: 'error' });
    const frozen = sync.createManualSelection({ accountRef: '0', ...selection });
    const sent = await sync.flush({ manual: true, selectionRef: frozen.selectionRef });
    assert.equal(sent.confirmed, true);
    assert.equal(projected.diagnostic.phase, 'v5-account-auth');
    assert.equal(projected.diagnostic.reasonCode, 'R'.repeat(80));
    assert.equal(projected.diagnostic.code, 2037);
    assert.equal(projected.diagnostic.remoteCode, 14101);
    assert.equal(projected.diagnostic.transportCode, -7);
    assert.equal(projected.diagnostic.status, 'scheduled');
    assert.equal(projected.diagnostic.readFailureKind, 'SocketTimeoutException');
    assert.equal(projected.diagnostic.domainId, 'profile');
    assert.deepEqual(projected.diagnostic.changedPaths, []);
    assert.deepEqual(projected.diagnostic.removedPaths, []);
    assert.deepEqual(projected.diagnostic.addedPaths, []);
    assert.equal(projected.diagnostic.rawAnchorMatches, true);
    assert.equal(projected.diagnostic.priorProjectionReceiptAvailable, true);
    assert.equal(projected.diagnostic.proofAdvanced, false);
    await sync.stop();
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('automatic uploader selects only explicit errors or failed outcomes and advances its own scan watermark', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-log-auto-policy-'));
  const store = openBackendStore({ dataDir: root });
  const installId = 'install-auto-01', ownerRef = 'cloud:' + 'b'.repeat(64) + ':software:1';
  let projected = [];
  try {
    const logs = createObservationLog({ store });
    logs.append({ ownerRef, accountRef: '0', level: 'info', errorCode: 'HAS_CODE_ONLY', message: 'normal with code', eventRef: 'normal-code' });
    logs.append({ ownerRef, accountRef: '0', level: 'info', outcomeState: 'unknown', message: 'normal unknown',
      detail: { note: 'nested text says verdict failed' }, eventRef: 'normal-unknown' });
    logs.append({ ownerRef, accountRef: '0', level: 'warn', outcomeState: 'rejected', message: 'rejected outcome', eventRef: 'failed-outcome' });
    logs.append({ ownerRef, accountRef: '0', level: 'error', outcomeState: 'unknown', message: 'error level stays unknown', eventRef: 'error-level' });
    const sync = createCloudLogSync({ store, cloudRef: 'b'.repeat(64), installId, sourceInstallId: installId,
      appVersion: 'test', identity: () => ({ signedIn: true, ownerRef, identityEpoch: 1, installId }),
      sendLogs: async ({ events }) => { projected = [...events]; return { accepted: events.map(item => item.eventId), duplicates: [], rejected: [], receivedAt: new Date().toISOString() }; } });
    sync.status();
    store.run('UPDATE backend_log_sync_cursors SET auto_due_ms=0 WHERE owner_ref=?', ownerRef);
    const sent = await sync.flush();
    assert.equal(sent.confirmed, true);
    assert.equal(projected.length, 2);
    assert.equal(projected.some(item => item.message === 'normal with code'), false);
    assert.equal(projected.some(item => item.message === 'normal unknown'), false);
    assert.deepEqual(projected.map(item => item.outcomeState).sort(), ['failed', 'unconfirmed']);
    store.run('UPDATE backend_log_sync_install SET next_send_ms=0 WHERE install_id=?', installId);
    store.run('UPDATE backend_log_sync_cursors SET auto_due_ms=0 WHERE owner_ref=?', ownerRef);
    assert.equal((await sync.flush()).reason, 'empty');
    assert.equal(Number(store.get('SELECT high_water_log_id AS n FROM backend_log_auto_scans WHERE owner_ref=?', ownerRef).n), 4);
    await sync.stop();
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('manual filtered selection spans pages, freezes IDs, and batches only selected rows', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-log-manual-selection-'));
  const store = openBackendStore({ dataDir: root });
  const installId = 'install-manual-01', ownerRef = 'cloud:' + 'c'.repeat(64) + ':software:1';
  const projected = [];
  try {
    const logs = createObservationLog({ store });
    for (let index = 0; index < 205; index += 1) logs.append({ ownerRef, accountRef: '7', level: 'info',
      message: index % 2 ? `chosen manual row ${index}` : `outside row ${index}`, eventRef: `manual-${index}` });
    const selection = logs.selectIds({ ownerRef, accountRef: '7', keyword: 'chosen manual row' });
    assert.equal(selection.sourceLogIds.length, 102);
    const sync = createCloudLogSync({ store, cloudRef: 'c'.repeat(64), installId, sourceInstallId: installId,
      appVersion: 'test', identity: () => ({ signedIn: true, ownerRef, identityEpoch: 5, installId }),
      sendLogs: async ({ events }) => { projected.push(...events); return { accepted: events.map(item => item.eventId), duplicates: [], rejected: [], receivedAt: new Date().toISOString() }; } });
    const frozen = sync.createManualSelection({ accountRef: '7', ...selection });
    for (let step = 0; step < 2; step += 1) {
      store.run('UPDATE backend_log_sync_install SET next_send_ms=0 WHERE install_id=?', installId);
      const result = await sync.flush({ manual: true, selectionRef: frozen.selectionRef });
      assert.equal(result.confirmed, true);
    }
    assert.equal(projected.length, 102);
    assert.ok(projected.every(item => item.message.startsWith('chosen manual row')));
    assert.equal(store.get('SELECT state FROM backend_log_sync_selections WHERE selection_ref=?', frozen.selectionRef).state, 'acknowledged');
    await sync.stop();
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('manual selection reuses the immutable wire body for an already acknowledged event ID', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-log-manual-ack-reuse-'));
  const store = openBackendStore({ dataDir: root });
  const installId = 'install-manual-ack-01', cloudRef = 'f'.repeat(64), ownerRef = `cloud:${cloudRef}:software:1`;
  let sentEvents = [];
  try {
    const logs = createObservationLog({ store });
    logs.append({ ownerRef, accountRef: '7', category: '运行状态', level: 'info', message: 'already accepted',
      outcomeState: 'confirmed', detail: { method: 'session.refresh', schemaVersion: 1 }, eventRef: 'manual-ack-reuse' });
    const row = store.get('SELECT * FROM backend_local_logs WHERE event_ref=?', 'manual-ack-reuse');
    const eventId = 'b2_' + fingerprint([cloudRef, ownerRef, installId, row.log_id, row.event_ref]).slice(0, 61);
    const oldEvent = { eventId, seq: row.log_id, installId, occurredAt: row.occurred_at, level: row.level,
      category: row.category, message: row.message, appVersion: 'test',
      accountLabel: { stableId: fingerprint([ownerRef, row.account_ref]) } };
    const oldEvents = [oldEvent], batchId = 'legacy-ack-batch-0001', attemptRef = 'legacy-ack-attempt-01';
    const sync = createCloudLogSync({ store, cloudRef, installId, sourceInstallId: installId, appVersion: 'test',
      identity: () => ({ signedIn: true, ownerRef, identityEpoch: 4, installId }),
      sendLogs: async ({ events }) => {
        sentEvents = events;
        return { accepted: [], duplicates: [eventId], rejected: [], receivedAt: new Date().toISOString() };
      } });
    sync.status();
    store.run(`INSERT INTO backend_log_sync_batches(batch_id,cloud_ref,owner_ref,install_id,from_log_id,through_log_id,
      events_json,content_sha256,state,attempts,mode,attempt_ref,attempt_identity_epoch,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, batchId, cloudRef, ownerRef, installId, row.log_id - 1, row.log_id,
    canonical(oldEvents), fingerprint(oldEvents), 'acknowledged', 1, 'legacy', attemptRef, 4,
    '2026-10-25T00:00:00.000Z', '2026-10-25T00:00:00.000Z');
    store.run(`INSERT INTO backend_log_sync_receipts(receipt_id,batch_id,cloud_ref,owner_ref,install_id,identity_epoch,attempt_ref,
      receipt_state,accepted_json,duplicates_json,rejected_json,received_at,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'legacy-ack-receipt-01', batchId, cloudRef, ownerRef, installId, 4, attemptRef, 'acknowledged', canonical([eventId]),
    '[]', '[]', '2026-10-25T00:00:01.000Z', '2026-10-25T00:00:01.000Z');
    const originalBatch = store.get('SELECT events_json,content_sha256 FROM backend_log_sync_batches WHERE batch_id=?', batchId);
    const selected = logs.selectIds({ ownerRef, accountRef: '7' });
    const frozen = sync.createManualSelection({ accountRef: '7', ...selected });
    const result = await sync.flush({ manual: true, selectionRef: frozen.selectionRef });
    assert.equal(result.confirmed, true);
    assert.deepEqual(result.duplicates, 1);
    assert.deepEqual(sentEvents, oldEvents, 'same event ID must reuse the exact previously accepted wire object');
    assert.deepEqual(store.get('SELECT events_json,content_sha256 FROM backend_log_sync_batches WHERE batch_id=?', batchId), originalBatch);
    assert.equal(store.get('SELECT receipt_state FROM backend_log_sync_receipts WHERE batch_id=? AND attempt_ref=?', batchId, attemptRef).receipt_state, 'acknowledged');
    await sync.stop();
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('active automatic batch remains visible to Wi-Fi policy and cannot ACK a different manual selection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-log-active-policy-'));
  const store = openBackendStore({ dataDir: root });
  const installId = 'install-active-01', ownerRef = 'cloud:' + 'd'.repeat(64) + ':software:1';
  let transport = 'wifi', release, calls = 0;
  try {
    const logs = createObservationLog({ store });
    logs.append({ ownerRef, accountRef: '0', level: 'error', message: 'auto error', eventRef: 'auto-error-active' });
    logs.append({ ownerRef, accountRef: '7', level: 'info', message: 'manual normal', eventRef: 'manual-active' });
    const sync = createCloudLogSync({ store, cloudRef: 'd'.repeat(64), installId, sourceInstallId: installId,
      appVersion: 'test', identity: () => ({ signedIn: true, ownerRef, identityEpoch: 8, installId }),
      network: () => ({ transport }),
      sendLogs: ({ events }) => {
        const answer = { accepted: events.map(item => item.eventId), duplicates: [], rejected: [], receivedAt: new Date().toISOString() };
        if (++calls > 1) return Promise.resolve(answer);
        return new Promise(resolve => { release = () => resolve(answer); });
      } });
    sync.setWifiOnly(true);
    sync.status();
    store.run('UPDATE backend_log_sync_cursors SET auto_due_ms=0 WHERE owner_ref=?', ownerRef);
    const automatic = sync.flush();
    for (let attempt = 0; !release && attempt < 100; attempt += 1) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(typeof release, 'function', JSON.stringify(sync.status()));
    transport = 'cellular';
    assert.ok(sync.policy().holdSince);
    assert.ok(sync.policy().pending >= 1);
    const picked = logs.selectIds({ ownerRef, accountRef: '7' });
    const manual = sync.createManualSelection({ accountRef: '7', ...picked });
    const queued = await sync.flush({ manual: true, selectionRef: manual.selectionRef });
    assert.equal(queued.reason, 'queued_behind_other_batch');
    assert.notEqual(queued.selectionRef, manual.selectionRef);
    assert.equal(queued.confirmed, undefined);
    release();
    assert.equal((await automatic).confirmed, true);
    transport = 'wifi';
    store.run('UPDATE backend_log_sync_install SET next_send_ms=0 WHERE install_id=?', installId);
    const manualAck = await sync.flush({ manual: true, selectionRef: manual.selectionRef });
    assert.equal(manualAck.confirmed, true);
    assert.equal(manualAck.selectionRef, manual.selectionRef);
    await sync.stop();
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('legacy rejected mixed batches and corrupt batches are held without blocking new error logs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-log-legacy-hold-'));
  const store = openBackendStore({ dataDir: root });
  const installId = 'install-legacy-01', cloudRef = 'e'.repeat(64), ownerRef = 'cloud:' + cloudRef + ':software:1';
  const identity = () => ({ signedIn: true, ownerRef, identityEpoch: 3, installId });
  const send = [];
  try {
    const logs = createObservationLog({ store });
    const initial = createCloudLogSync({ store, cloudRef, installId, sourceInstallId: installId, appVersion: 'test', identity,
      sendLogs: async ({ events }) => ({ accepted: events.map(item => item.eventId), duplicates: [], rejected: [], receivedAt: new Date().toISOString() }) });
    initial.status();
    await initial.stop();
    const events = [
      { eventId: 'b2_legacy-error-000001', seq: 1, installId, occurredAt: '2026-10-27T00:00:00.000Z', level: 'error', category: 'old', message: 'old error', appVersion: 'test' },
      { eventId: 'b2_legacy-normal-00001', seq: 2, installId, occurredAt: '2026-10-27T00:00:01.000Z', level: 'info', category: 'old', message: 'must stay held', appVersion: 'test' },
    ];
    const eventsJson = canonical(events), eventsHash = fingerprint(events), createdAt = new Date().toISOString();
    store.run(`INSERT INTO backend_log_sync_batches(batch_id,cloud_ref,owner_ref,install_id,from_log_id,through_log_id,
      events_json,content_sha256,state,attempts,mode,last_code,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      'legacy-mixed-batch-0001', cloudRef, ownerRef, installId, 0, 2, eventsJson, eventsHash, 'rejected', 1, 'legacy', 'TEMPORARY_FAILURE', createdAt, createdAt);
    store.run(`INSERT INTO backend_log_sync_batches(batch_id,cloud_ref,owner_ref,install_id,from_log_id,through_log_id,
      events_json,content_sha256,state,attempts,mode,last_code,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      'legacy-corrupt-batch-0001', cloudRef, ownerRef, installId, 2, 3, '{', '0'.repeat(64), 'rejected', 1, 'legacy', 'TEMPORARY_FAILURE', createdAt, createdAt);
    logs.append({ ownerRef, accountRef: '0', level: 'error', message: 'new error must flow', eventRef: 'new-error-after-migration' });
    const sync = createCloudLogSync({ store, cloudRef, installId, sourceInstallId: installId, appVersion: 'test', identity,
      sendLogs: async ({ events: batch }) => { send.push(...batch); return { accepted: batch.map(item => item.eventId), duplicates: [], rejected: [], receivedAt: new Date().toISOString() }; } });
    sync.status();
    store.run('UPDATE backend_log_sync_cursors SET auto_due_ms=0 WHERE owner_ref=?', ownerRef);
    const result = await sync.flush();
    assert.equal(result.confirmed, true);
    assert.deepEqual(send.map(item => item.message), ['new error must flow']);
    const mixed = store.get('SELECT state,events_json,content_sha256 FROM backend_log_sync_batches WHERE batch_id=?', 'legacy-mixed-batch-0001');
    assert.equal(mixed.state, 'held-policy');
    assert.equal(mixed.events_json, eventsJson);
    assert.equal(mixed.content_sha256, eventsHash);
    const corrupt = store.get('SELECT state,events_json,content_sha256 FROM backend_log_sync_batches WHERE batch_id=?', 'legacy-corrupt-batch-0001');
    assert.equal(corrupt.state, 'held-corrupt');
    assert.equal(corrupt.events_json, '{');
    assert.equal(corrupt.content_sha256, '0'.repeat(64));
    await sync.stop();
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('one malformed automatic row is quarantined and byte-bounded batches continue through long legal errors', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-log-auto-bytes-'));
  const store = openBackendStore({ dataDir: root });
  const installId = 'install-bytes-01', cloudRef = 'f'.repeat(64), ownerRef = 'cloud:' + cloudRef + ':software:1';
  const sent = [];
  try {
    const logs = createObservationLog({ store });
    store.run(`INSERT INTO backend_local_logs(owner_ref,account_ref,event_ref,category,level,message,detail_json,occurred_at)
      VALUES(?,?,?,?,?,?,?,?)`, ownerRef, '0', 'malformed-source-row', '运行状态', 'error', 'broken detail', '{', new Date().toISOString());
    for (let index = 0; index < 60; index += 1) logs.append({ ownerRef, accountRef: '0', level: 'error',
      message: `long legal error ${index} ` + 'x'.repeat(1450), eventRef: `long-legal-error-${index}` });
    const sync = createCloudLogSync({ store, cloudRef, installId, sourceInstallId: installId, appVersion: 'test',
      identity: () => ({ signedIn: true, ownerRef, identityEpoch: 9, installId }),
      sendLogs: async ({ events }) => { sent.push(...events); return { accepted: events.map(item => item.eventId), duplicates: [], rejected: [], receivedAt: new Date().toISOString() }; } });
    sync.status();
    store.run('UPDATE backend_log_sync_cursors SET auto_due_ms=0 WHERE owner_ref=?', ownerRef);
    const isolated = await sync.flush();
    assert.equal(isolated.reason, 'receipt_quarantined');
    assert.equal(Number(store.get("SELECT COUNT(*) AS n FROM backend_log_sync_quarantined_events WHERE source_log_id=1").n), 1);
    for (let attempt = 0; attempt < 8 && sent.length < 60; attempt += 1) {
      store.run('UPDATE backend_log_sync_install SET next_send_ms=0 WHERE install_id=?', installId);
      store.run('UPDATE backend_log_sync_cursors SET auto_due_ms=0,retry_at_ms=0 WHERE owner_ref=?', ownerRef);
      await sync.flush();
    }
    assert.equal(sent.length, 60);
    assert.equal(new Set(sent.map(item => item.message)).size, 60);
    const batches = store.all("SELECT events_json FROM backend_log_sync_batches WHERE mode='auto-error' AND state='acknowledged'");
    assert.ok(batches.length > 1);
    assert.ok(batches.every(row => Buffer.byteLength(canonical({ events: JSON.parse(row.events_json) }), 'utf8') <= 64 * 1024));
    await sync.stop();
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
