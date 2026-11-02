import test from 'node:test';
import assert from 'node:assert/strict';
import { startCloud } from './cloud-harness.mjs';

const ADMIN_PW = 'Root-Admin-1';
const USER_PW = 'Admin-Target-3';

async function adminToken(cloud) {
  await cloud.createAdminUser('root_admin', ADMIN_PW);
  const login = await cloud.adminLogin('root_admin', ADMIN_PW);
  assert.equal(login.status, 200);
  return login.json.accessToken;
}

function insertRunLog(store, { eventId, daysAgo, isError }) {
  const occurredAt = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  store.run(`INSERT INTO run_logs(event_id,user_id,install_id,occurred_at,received_at,level,category,message,content_sha256,is_error)
    VALUES(?,?,?, ?,?, 'info','plant','row',?, ?)`, eventId, 1, 'install-aaaa1111', occurredAt, store.nowIso(), `sha-${eventId}`, isError ? 1 : 0);
}

test('settings returns defaults, PUT rejects unknown keys and closing registration blocks new signups', async () => {
  const cloud = await startCloud();
  try {
    const token = await adminToken(cloud);
    const initial = await cloud.call('GET', '/api/admin/settings', { token });
    assert.equal(initial.status, 200);
    assert.equal(initial.json.allowRegistration, true);
    assert.equal(initial.json.retention.normalDays, 30);
    assert.equal(initial.json.retention.errorDays, 90);

    const badKey = await cloud.call('PUT', '/api/admin/settings', { token, body: { allowRegistration: true, evil: 1 } });
    assert.equal(badKey.status, 400);

    const badRetention = await cloud.call('PUT', '/api/admin/settings', { token, body: { retention: { normalDays: 0 } } });
    assert.equal(badRetention.status, 400);

    const closed = await cloud.call('PUT', '/api/admin/settings', { token, body: { allowRegistration: false } });
    assert.equal(closed.status, 200);
    assert.equal(closed.json.allowRegistration, false);

    const blocked = await cloud.register('late_user', USER_PW);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.code, 'REGISTRATION_CLOSED');

    const reopened = await cloud.call('PUT', '/api/admin/settings', { token, body: { allowRegistration: true } });
    assert.equal(reopened.status, 200);
    assert.equal((await cloud.register('late_user', USER_PW)).status, 201);
  } finally { await cloud.close(); }
});

test('disabling a user revokes sessions, re-enabling restores login but not the old session', async () => {
  const cloud = await startCloud();
  try {
    const token = await adminToken(cloud);
    await cloud.register('target_user', USER_PW);
    const login = await cloud.login('target_user', USER_PW);
    const oldAccessToken = login.json.accessToken;
    const userId = login.json.user.id;

    const disable = await cloud.call('POST', `/api/admin/users/${userId}/enabled`, { token, body: { enabled: false, reason: '排查' } });
    assert.equal(disable.status, 200);

    const oldSession = await cloud.call('GET', '/api/software/license', { token: oldAccessToken });
    assert.equal(oldSession.status, 401);
    const loginDisabled = await cloud.login('target_user', USER_PW);
    assert.equal(loginDisabled.status, 403);

    const enable = await cloud.call('POST', `/api/admin/users/${userId}/enabled`, { token, body: { enabled: true } });
    assert.equal(enable.status, 200);
    const loginAgain = await cloud.login('target_user', USER_PW);
    assert.equal(loginAgain.status, 200);
    const staleSession = await cloud.call('GET', '/api/software/license', { token: oldAccessToken });
    assert.equal(staleSession.status, 401);
    assert.equal(staleSession.json.code, 'SESSION_REVOKED');
  } finally { await cloud.close(); }
});

test('changing the admin password revokes every admin session', async () => {
  const cloud = await startCloud();
  try {
    const token = await adminToken(cloud);
    const changed = await cloud.call('POST', '/api/admin/password', { token, body: { currentPassword: ADMIN_PW, newPassword: 'Rotated-Admin-2' } });
    assert.equal(changed.status, 200);
    assert.equal(changed.json.revoked, true);

    const after = await cloud.call('GET', '/api/admin/users', { token });
    assert.equal(after.status, 401);

    const oldLogin = await cloud.adminLogin('root_admin', ADMIN_PW);
    assert.equal(oldLogin.status, 401);
    const newLogin = await cloud.adminLogin('root_admin', 'Rotated-Admin-2');
    assert.equal(newLogin.status, 200);
  } finally { await cloud.close(); }
});

// 保留期以「首次云端接收」为准：昨天的日志今天才传上来，不能因为 occurred_at 就已被删掉。
// 到保留期先清正文（行、事件号、未确认事实留着，重传仍判重）；只有正文已清且发生与首次接收
// 都超过收据窗口，整行才真删。一轮最多处理 config.maintenanceRows 行，不一次扫穿整库。
function insertRow(store, { eventId, occurredDaysAgo = 0, receivedDaysAgo = 0, isError = false, bodyClass = null, purged = false, outcomeState = null }) {
  const iso = days => new Date(Date.now() - days * 86_400_000).toISOString();
  // 与 cloud/logs.mjs 同一口径：错误、未确认、失败都算重要，不能只认 level=error。
  const klass = bodyClass || (isError || outcomeState === 'unconfirmed' || outcomeState === 'failed' ? 'important' : 'normal');
  store.run(`INSERT INTO run_logs(event_id,user_id,install_id,occurred_at,received_at,level,category,message,
    content_sha256,is_error,body_class,outcome_state,outcome_json,body_purged_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    eventId, 1, 'install-aaaa1111', iso(occurredDaysAgo), iso(receivedDaysAgo), isError ? 'error' : 'info', 'plant', '正文句子',
    `sha-${eventId}`, isError ? 1 : 0, klass, outcomeState, outcomeState ? '{"unconfirmed":1}' : null, purged ? iso(receivedDaysAgo) : null);
  return { klass };
}

test('retention purge anchors on first cloud receipt, purges bodies before rows and stays bounded', async () => {
  const cloud = await startCloud();
  try {
    const store = cloud.app.store;
    // 1) 老事件、刚收到：必须原样留着，正文也不能清。
    insertRow(store, { eventId: 'evt-late-arrival', occurredDaysAgo: 31, receivedDaysAgo: 0 });
    // 2) 普通正文到 30 天：清正文，行与事实留着。
    insertRow(store, { eventId: 'evt-normal-old', occurredDaysAgo: 31, receivedDaysAgo: 31 });
    // 3) 未确认按重要保留：31 天不清，91 天才清。
    insertRow(store, { eventId: 'evt-unconfirmed-31', occurredDaysAgo: 31, receivedDaysAgo: 31, outcomeState: 'unconfirmed' });
    insertRow(store, { eventId: 'evt-unconfirmed-91', occurredDaysAgo: 91, receivedDaysAgo: 91, outcomeState: 'unconfirmed' });
    // 4) 正文已清且双双超过 180 天收据窗口：整行删除。
    insertRow(store, { eventId: 'evt-window-out', occurredDaysAgo: 181, receivedDaysAgo: 181, purged: true });
    store.run('INSERT INTO log_receipts(user_id,install_id,event_id,content_sha256,occurred_at,first_received_at,body_class) VALUES(?,?,?,?,?,?,?)',
      1, 'install-aaaa1111', 'evt-window-out', 'sha-evt-window-out',
      new Date(Date.now() - 181 * 86_400_000).toISOString(), new Date(Date.now() - 181 * 86_400_000).toISOString(), 'normal');
    // 5) 有界：150 条同样到期的普通正文，一趟最多清 maintenanceRows(100) 行。
    for (let i = 0; i < 150; i += 1) insertRow(store, { eventId: 'evt-bulk-' + i, occurredDaysAgo: 40, receivedDaysAgo: 40 });

    const removed = cloud.app.purgeOnce({ trigger: 'manual' });
    const present = id => store.get('SELECT id, message, body_purged_at, outcome_state FROM run_logs WHERE event_id=?', id);

    assert.ok(present('evt-late-arrival'), '老事件刚收到不能被删');
    assert.equal(present('evt-late-arrival').body_purged_at, null, '刚收到时正文也不该清');
    assert.ok(present('evt-normal-old').body_purged_at, '普通正文到 30 天要清');
    assert.ok(String(present('evt-normal-old').message).includes('正文已按保留期清理'), '清的是正文，行要留着');
    assert.ok(present('evt-unconfirmed-31'), '未确认按重要保留，31 天不能动');
    assert.equal(present('evt-unconfirmed-31').body_purged_at, null);
    assert.ok(present('evt-unconfirmed-91').body_purged_at, '重要正文 90 天后清正文');
    assert.equal(present('evt-unconfirmed-91').outcome_state, 'unconfirmed', '清正文不能把未确认事实一起抹掉');
    assert.equal(present('evt-window-out'), undefined, '正文已清且超过收据窗口的整行才真删');
    assert.equal(store.get('SELECT event_id FROM log_receipts WHERE event_id=?', 'evt-window-out'), undefined, '超过窗口的收据也要删');
    const bulkPurged = Number(store.get('SELECT COUNT(*) AS n FROM run_logs WHERE body_purged_at IS NOT NULL AND event_id LIKE ?', 'evt-bulk-%').n);
    assert.ok(bulkPurged <= 100, '一趟清理必须有界，实测 ' + bulkPurged);
    assert.ok(removed > 0 && removed <= 100 + 3, '本次处理量要落在有界额度内，实测 ' + removed);

    // 游标推进：再跑一趟要继续清剩下的，不能每趟都回到同一段前缀。
    const second = cloud.app.purgeOnce({ trigger: 'manual' });
    const afterSecond = Number(store.get('SELECT COUNT(*) AS n FROM run_logs WHERE body_purged_at IS NOT NULL AND event_id LIKE ?', 'evt-bulk-%').n);
    assert.ok(afterSecond > bulkPurged, '第二趟必须往前推，实测 ' + bulkPurged + ' → ' + afterSecond);
    assert.ok(second >= 0);
  } finally { await cloud.close(); }
});

test('admin log listing filters by user and reflects stored rows', async () => {
  const cloud = await startCloud();
  try {
    const token = await adminToken(cloud);
    await cloud.register('listed_user', USER_PW);
    const login = await cloud.login('listed_user', USER_PW);
    await cloud.call('POST', '/api/logs/batch', { token: login.json.accessToken, body: { events: [{
      eventId: 'evt-listaaaa', installId: 'install-aaaa1111', occurredAt: '2026-10-18T09:00:00.000Z',
      level: 'error', category: 'harvest', message: 'harvest failed', errorCode: 'H500',
      accountLabel: { stableId: 'g1', nickname: '小花', serverName: '一区' }, traceId: 'run-1', operationId: 'op-1',
      attempted: true, outcomeState: 'unconfirmed', diagnostic: { eventState: 'failed', phase: 'health', remoteCode: 503 },
    }] } });

    const list = await cloud.call('GET', '/api/admin/logs', { token });
    assert.equal(list.status, 200);
    assert.equal(list.json.total, 1);
    const row = list.json.items[0];
    assert.equal(row.errorCode, 'H500');
    assert.equal(row.nickname, '小花');
    assert.equal(row.isError, true);
    assert.equal(row.installId, 'install-aaaa1111');
    assert.equal(row.operationId, 'op-1');
    assert.equal(row.attempted, true);
    assert.equal(row.outcomeState, 'unconfirmed');
    assert.equal(row.diagnostic.remoteCode, 503);

    const runs = await cloud.call('GET', `/api/admin/logs/runs?traceId=run-1&userId=${login.json.user.id}&installId=install-aaaa1111`, { token });
    assert.equal(runs.json.total, 1);
    const wrongInstallRun = await cloud.call('GET', `/api/admin/logs/runs?traceId=run-1&userId=${login.json.user.id}&installId=install-other`, { token });
    assert.equal(wrongInstallRun.json.total, 0, 'same trace cannot cross an installation scope');

    const byLevel = await cloud.call('GET', '/api/admin/logs?level=error&userId=' + login.json.user.id, { token });
    assert.equal(byLevel.json.total, 1);
    const byOther = await cloud.call('GET', '/api/admin/logs?level=info', { token });
    assert.equal(byOther.json.total, 0);
    const byTypedState = await cloud.call('GET', '/api/admin/logs?eventState=failed&installId=install-aaaa1111&operationId=op-1', { token });
    assert.equal(byTypedState.json.total, 1);
    const byWrongState = await cloud.call('GET', '/api/admin/logs?eventState=completed', { token });
    assert.equal(byWrongState.json.total, 0);
  } finally { await cloud.close(); }
});

test('用户列表带日志计数，游戏号昵称按关键词部分匹配、稳定标识按精确匹配', async () => {
  const cloud = await startCloud();
  try {
    const token = await adminToken(cloud);
    const registered = await cloud.call('POST', '/api/software/register', { body: { username: 'label_owner', password: USER_PW } });
    assert.equal(registered.status, 201);
    const userId = registered.json.user.id;
    const insert = (eventId, stableId, nickname, serverName) => cloud.app.store.run(
      `INSERT INTO run_logs(event_id,user_id,install_id,stable_id,nickname,server_name,occurred_at,received_at,level,category,message,content_sha256,is_error)
       VALUES(?,?,?,?,?,?,?,?,?,?,?, ?,0)`,
      eventId, userId, 'install-label1', stableId, nickname, serverName, cloud.app.store.nowIso(), cloud.app.store.nowIso(), 'info', 'harvest', '收了 8 块地的花', 'sha-' + eventId);
    insert('label-a-0001', 'uid-36019328101928', 's1928.Hello可可4', '1928服');
    insert('label-b-0002', 'uid-44020000002202', 's2202.十九+', '2202服');
    const users = await cloud.call('GET', '/api/admin/users', { token });
    assert.equal(users.status, 200, JSON.stringify(users.json));
    assert.equal(Array.isArray(users.json.items), true);
    const listed = users.json.items.find(item => item.id === userId);
    assert.equal(listed.logCount, 2);
    assert.equal(listed.username, 'label_owner');
    const search = await cloud.call('GET', '/api/admin/users?q=label', { token });
    assert.equal(search.json.total, 1);
    const partial = await cloud.call('GET', '/api/admin/logs?nickname=' + encodeURIComponent('可可'), { token });
    assert.equal(partial.json.total, 1, '昵称只记得一半也要能筛出来');
    assert.equal(partial.json.items[0].stableId, 'uid-36019328101928');
    const server = await cloud.call('GET', '/api/admin/logs?serverName=' + encodeURIComponent('2202'), { token });
    assert.equal(server.json.total, 1);
    const stableExact = await cloud.call('GET', '/api/admin/logs?stableId=' + encodeURIComponent('uid-36019328'), { token });
    assert.equal(stableExact.json.total, 0, '稳定标识按精确匹配，不给半串');
    const wildcard = await cloud.call('GET', '/api/admin/logs?nickname=%25', { token });
    assert.equal(wildcard.json.total, 0, '通配符要按字面匹配，不能变成全表');
    const none = await cloud.call('GET', '/api/admin/logs?nickname=' + encodeURIComponent('没有这个号'), { token });
    assert.equal(none.json.total, 0);
  } finally { await cloud.close(); }
});
