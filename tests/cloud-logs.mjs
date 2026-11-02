import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startCloud, readDbBytes } from './cloud-harness.mjs';

const PW = 'Ingest-Pass-7';
const INSTALL = 'install-aaaa1111';

async function session(cloud, username = 'ingest_user') {
  await cloud.register(username, PW);
  const login = await cloud.login(username, PW, INSTALL);
  return login.json.accessToken;
}

function event(overrides = {}) {
  return {
    eventId: 'evt-aaaa1111',
    installId: INSTALL,
    occurredAt: '2026-10-18T10:00:00.000Z',
    level: 'info',
    category: 'plant',
    message: 'planted a flower',
    ...overrides,
  };
}

test('batch accepts new events and re-transmits land in duplicates without changing received_at', async () => {
  const cloud = await startCloud();
  try {
    const token = await session(cloud);
    const first = await cloud.call('POST', '/api/logs/batch', { token, body: { events: [event()] } });
    assert.equal(first.status, 200);
    assert.deepEqual(first.json.accepted, ['evt-aaaa1111']);
    assert.deepEqual(first.json.duplicates, []);
    const stored = cloud.app.store.get('SELECT received_at,message FROM run_logs WHERE event_id=?', 'evt-aaaa1111');

    const second = await cloud.call('POST', '/api/logs/batch', { token, body: { events: [event()] } });
    assert.deepEqual(second.json.duplicates, ['evt-aaaa1111']);
    assert.deepEqual(second.json.accepted, []);
    const after = cloud.app.store.get('SELECT received_at,message FROM run_logs WHERE event_id=?', 'evt-aaaa1111');
    assert.equal(after.received_at, stored.received_at);
    assert.equal(after.message, stored.message);
  } finally { await cloud.close(); }
});

test('same eventId with different content is rejected and the original row is untouched', async () => {
  const cloud = await startCloud();
  try {
    const token = await session(cloud);
    await cloud.call('POST', '/api/logs/batch', { token, body: { events: [event({ message: 'first message' })] } });
    const before = cloud.app.store.get('SELECT received_at,message,content_sha256 FROM run_logs WHERE event_id=?', 'evt-aaaa1111');

    const conflict = await cloud.call('POST', '/api/logs/batch', { token, body: { events: [event({ message: 'conflicting message' })] } });
    assert.equal(conflict.status, 200);
    assert.deepEqual(conflict.json.rejected, [{ eventId: 'evt-aaaa1111', reason: 'EVENT_CONFLICT' }]);
    const after = cloud.app.store.get('SELECT received_at,message,content_sha256 FROM run_logs WHERE event_id=?', 'evt-aaaa1111');
    assert.equal(after.received_at, before.received_at);
    assert.equal(after.message, before.message);
    assert.equal(after.content_sha256, before.content_sha256);
    const conflictRow = cloud.app.store.get('SELECT detail FROM log_conflicts WHERE event_id=?', 'evt-aaaa1111');
    assert.ok(conflictRow);
  } finally { await cloud.close(); }
});

test('a forbidden field such as userId rejects the whole batch with 400', async () => {
  const cloud = await startCloud();
  try {
    const token = await session(cloud);
    const res = await cloud.call('POST', '/api/logs/batch', { token, body: { events: [event(), { ...event({ eventId: 'evt-bbbb2222' }), userId: 99 }] } });
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'LOG_FIELD_NOT_ALLOWED');
    assert.equal(cloud.app.store.get('SELECT COUNT(*) AS n FROM run_logs').n, 0);
  } finally { await cloud.close(); }
});

test('an install id that does not match the session is rejected for that event', async () => {
  const cloud = await startCloud();
  try {
    const token = await session(cloud);
    const res = await cloud.call('POST', '/api/logs/batch', { token, body: { events: [event({ installId: 'install-zzzz9999' })] } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.rejected, [{ eventId: 'evt-aaaa1111', reason: 'INSTALL_MISMATCH' }]);
    assert.equal(cloud.app.store.get('SELECT COUNT(*) AS n FROM run_logs').n, 0);
  } finally { await cloud.close(); }
});

test('an over-long message is redacted then truncated to the 1200 character cap', async () => {
  const cloud = await startCloud();
  try {
    const token = await session(cloud);
    const long = 'x'.repeat(3000);
    const res = await cloud.call('POST', '/api/logs/batch', { token, body: { events: [event({ message: long })] } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.accepted, ['evt-aaaa1111']);
    const row = cloud.app.store.get('SELECT message FROM run_logs WHERE event_id=?', 'evt-aaaa1111');
    assert.ok(row.message.length <= 1200);
    assert.ok(row.message.endsWith('...'));
  } finally { await cloud.close(); }
});

test('server redacts secrets in free text and no plaintext reaches disk or the response', async () => {
  const dir = fs.mkdtempSync('.runtime/cloud-test-');
  const file = dir + '/redact.db';
  const cloud = await startCloud({ dbFile: file });
  try {
    const token = await session(cloud, 'redact_user');
    const leak = 'login password=SuperSecret9 token=AbcToken123 via http://route-user:route-secret@proxy.example:8080 ok';
    const res = await cloud.call('POST', '/api/logs/batch', { token, body: { events: [event({ message: leak })] } });
    assert.equal(res.status, 200);
    assert.equal(res.text.includes('SuperSecret9'), false);
    const row = cloud.app.store.get('SELECT message FROM run_logs WHERE event_id=?', 'evt-aaaa1111');
    assert.ok(row.message.includes('[已隐去]'));
    for (const secret of ['SuperSecret9', 'AbcToken123', 'route-secret', 'route-user']) {
      assert.equal(row.message.includes(secret), false, `message leaked ${secret}`);
    }
    cloud.app.close();
    const bytes = readDbBytes(file);
    for (const secret of ['SuperSecret9', 'AbcToken123', 'route-secret']) {
      assert.equal(bytes.includes(Buffer.from(secret)), false, `disk leaked ${secret}`);
    }
  } finally {
    await cloud.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('typed diagnostic keeps bounded health/recovery fields and numeric official codes', async () => {
  const cloud = await startCloud();
  try {
    const token = await session(cloud, 'typed_diagnostic');
    const res = await cloud.call('POST', '/api/logs/batch', { token, body: { events: [event({
      eventId: 'evt-typed1111', traceId: 'trace-typed', operationId: 'op-typed', attempted: true, outcomeState: 'unconfirmed',
      diagnostic: { eventType: 'native-recovery', eventState: 'incomplete', phase: 'health', method: 'GET',
        connectionEpoch: 1470, requestSequence: 8, retryAtMs: 1793000000000, sourceNamespace: 'engine-health',
        remoteCode: 'R'.repeat(72), transportCode: -7, reasonCode: 'Q'.repeat(80), code: 2037, serverMsgCode: 4100, readFailureKind: 'SocketTimeoutException',
        truncated: false, domains: ['land', 'inventory'], summary: 'token=must-not-leak', domainId: 'profile',
        path: 'backend/facts/dynamic-state.mjs:429:24 > backend/persistence/store.mjs:62:16',
        difference: 'same-response-projection-changed', changedPaths: [], removedPaths: [], addedPaths: [],
        rawAnchorMatches: true, priorProjectionReceiptAvailable: true, proofAdvanced: false },
    })] } });
    assert.equal(res.status, 200);
    const row = cloud.app.store.get('SELECT attempted,outcome_state,diagnostic_json FROM run_logs WHERE event_id=?', 'evt-typed1111');
    assert.equal(row.attempted, 1);
    assert.equal(row.outcome_state, 'unconfirmed');
    const diagnostic = JSON.parse(row.diagnostic_json);
    assert.equal(diagnostic.eventState, 'incomplete');
    assert.equal(diagnostic.remoteCode, 'R'.repeat(72));
    assert.equal(diagnostic.transportCode, -7);
    assert.equal(diagnostic.reasonCode, 'Q'.repeat(80));
    assert.equal(diagnostic.code, 2037);
    assert.equal(diagnostic.serverMsgCode, 4100);
    assert.equal(diagnostic.readFailureKind, 'SocketTimeoutException');
    assert.equal(diagnostic.connectionEpoch, 1470);
    assert.equal(diagnostic.domainId, 'profile');
    assert.equal(diagnostic.path, 'backend/facts/dynamic-state.mjs:429:24 > backend/persistence/store.mjs:62:16');
    assert.deepEqual(diagnostic.changedPaths, []);
    assert.deepEqual(diagnostic.removedPaths, []);
    assert.deepEqual(diagnostic.addedPaths, []);
    assert.equal(diagnostic.rawAnchorMatches, true);
    assert.equal(diagnostic.priorProjectionReceiptAvailable, true);
    assert.equal(diagnostic.proofAdvanced, false);
    assert.equal(diagnostic.summary.includes('must-not-leak'), false);
    assert.ok(Buffer.byteLength(row.diagnostic_json, 'utf8') <= 4000);
  } finally { await cloud.close(); }
});

test('is_error is set for error level and for any event carrying an error code', async () => {
  const cloud = await startCloud();
  try {
    const token = await session(cloud);
    await cloud.call('POST', '/api/logs/batch', { token, body: { events: [
      event({ eventId: 'evt-err1aaaa', level: 'error', message: 'boom' }),
      event({ eventId: 'evt-codebbbb', level: 'warn', message: 'official failure', errorCode: 'E1001' }),
      event({ eventId: 'evt-okcccccc', level: 'info', message: 'fine' }),
    ] } });
    const errorRow = cloud.app.store.get('SELECT is_error FROM run_logs WHERE event_id=?', 'evt-err1aaaa');
    const codeRow = cloud.app.store.get('SELECT is_error FROM run_logs WHERE event_id=?', 'evt-codebbbb');
    const okRow = cloud.app.store.get('SELECT is_error FROM run_logs WHERE event_id=?', 'evt-okcccccc');
    assert.equal(errorRow.is_error, 1);
    assert.equal(codeRow.is_error, 1);
    assert.equal(okRow.is_error, 0);
  } finally { await cloud.close(); }
});

test('a batch larger than the event cap is rejected as too large', async () => {
  const cloud = await startCloud();
  try {
    const token = await session(cloud);
    const events = [];
    for (let index = 0; index < 101; index += 1) events.push(event({ eventId: `evt-${String(index).padStart(6, '0')}x` }));
    const res = await cloud.call('POST', '/api/logs/batch', { token, body: { events } });
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'LOG_BATCH_TOO_LARGE');
  } finally { await cloud.close(); }
});

test('log batch requires a user session', async () => {
  const cloud = await startCloud();
  try {
    const res = await cloud.call('POST', '/api/logs/batch', { body: { events: [event()] } });
    assert.equal(res.status, 401);
  } finally { await cloud.close(); }
});

// K25.1：正文清理之后，同一事件重传必须还能认出「收过」，既不能复活成正文，也不能换内容当新记录。
// 收据要真有人读——只写不读的表等于假通道，所以这三条断言全部走真实接口，不直接查库自证。
test('body purged by retention still dedups a re-transmit and refuses a changed body', async () => {
  const cloud = await startCloud();
  try {
    const token = await session(cloud, 'purge_user');
    const first = await cloud.call('POST', '/api/logs/batch', { token, body: { events: [event()] } });
    assert.deepEqual(first.json.accepted, ['evt-aaaa1111']);
    const receipt = cloud.app.store.get('SELECT first_received_at,content_sha256 FROM log_receipts WHERE event_id=?', 'evt-aaaa1111');
    assert.ok(receipt?.first_received_at, '入账时要同时落最小收据与首次接收时刻');

    // 把首次接收推到 40 天前，真实跑一轮保留清理：正文应被清，行与收据要留着。
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    cloud.app.store.run('UPDATE run_logs SET received_at=? WHERE event_id=?', old, 'evt-aaaa1111');
    cloud.app.store.run('UPDATE log_receipts SET first_received_at=? WHERE event_id=?', old, 'evt-aaaa1111');
    cloud.app.purgeOnce({ trigger: 'manual' });
    const purged = cloud.app.store.get('SELECT message,body_purged_at,outcome_state FROM run_logs WHERE event_id=?', 'evt-aaaa1111');
    assert.ok(purged?.body_purged_at, '普通正文到 30 天要清');
    assert.ok(!String(purged.message).includes('planted a flower'), '清掉的必须是正文本身');

    const again = await cloud.call('POST', '/api/logs/batch', { token, body: { events: [event()] } });
    assert.deepEqual(again.json.duplicates, ['evt-aaaa1111'], '正文清理后重传必须按收据判重');
    assert.deepEqual(again.json.accepted, [], '重传不能把这条复活成新记录');
    assert.ok(!String(cloud.app.store.get('SELECT message FROM run_logs WHERE event_id=?', 'evt-aaaa1111').message).includes('planted a flower'), '判重也不能顺手写回正文');

    const changed = await cloud.call('POST', '/api/logs/batch', { token, body: { events: [event({ message: '换了一条内容' })] } });
    assert.equal(changed.json.rejected?.[0]?.reason, 'EVENT_CONFLICT', '同一事件号换内容必须按冲突拒绝');
    assert.equal(cloud.app.store.get('SELECT COUNT(*) AS n FROM run_logs WHERE event_id=?', 'evt-aaaa1111').n, 1, '拒绝不能多出一行');
  } finally { await cloud.close(); }
});

// K25.1：窗口外的旧事件明确拒收，不能靠补一个当前接收时刻把它塞进账。
test('events older than the receipt window are refused without fabricating a receipt', async () => {
  const cloud = await startCloud();
  try {
    const token = await session(cloud, 'window_user');
    const ancient = event({ eventId: 'evt-ancient1', occurredAt: new Date(Date.now() - 200 * 86_400_000).toISOString() });
    const result = await cloud.call('POST', '/api/logs/batch', { token, body: { events: [ancient] } });
    assert.equal(result.status, 200);
    assert.equal(result.json.rejected?.[0]?.reason, 'EVENT_OUTSIDE_WINDOW');
    assert.deepEqual(result.json.accepted, []);
    assert.equal(cloud.app.store.get('SELECT COUNT(*) AS n FROM run_logs WHERE event_id=?', 'evt-ancient1').n, 0, '拒收就是不留行');
    assert.equal(cloud.app.store.get('SELECT COUNT(*) AS n FROM log_receipts WHERE event_id=?', 'evt-ancient1').n, 0, '也不留收据');
  } finally { await cloud.close(); }
});

// K25.4：日志通道超预算要回 429 并带真实 Retry-After，客户端才可能按原截止退避而不是自己猜。
test('log channel returns 429 with Retry-After once the per-minute budget is spent', async () => {
  const cloud = await startCloud({ env: { WUJINXIA_LOG_BUDGET_INSTALL_REQUESTS: '2' } });
  try {
    const token = await session(cloud, 'budget_user');
    const sent = [];
    for (let i = 0; i < 4; i += 1) {
      sent.push(await cloud.call('POST', '/api/logs/batch', { token, body: { events: [event({ eventId: 'evt-budget-' + i + '000000' })] } }));
    }
    const blocked = sent.find(item => item.status === 429);
    assert.ok(blocked, '超过每分钟预算的请求必须被拒，实测状态码 ' + sent.map(item => item.status).join(','));
    assert.equal(blocked.json.code, 'LOG_BUDGET_EXCEEDED');
    const retryAfter = Number(blocked.headers?.['retry-after'] ?? blocked.headers?.get?.('retry-after'));
    assert.ok(retryAfter >= 1 && retryAfter <= 60, 'Retry-After 要落在本窗口剩余秒数，实测 ' + retryAfter);
  } finally { await cloud.close(); }
});
