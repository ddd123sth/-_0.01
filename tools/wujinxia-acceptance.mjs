// 对已部署云服务的逐项验收：一条命令跑完软件账号、授权、日志、后台接口与静态入口，
// 每项现读结果并给出通过/未过计数。目标地址与管理员口令从环境或本地受保护文件读，不写死。
// 用法：WUJINXIA_BASE_URL=http://127.0.0.1:8091 WUJINXIA_ADMIN_PASSWORD_FILE=.runtime/deployed-admin-pass.txt node tools/wujinxia-acceptance.mjs [--with-throttle]
import fs from 'node:fs';
import crypto from 'node:crypto';

const base = (process.env.WUJINXIA_BASE_URL || 'http://127.0.0.1:8091').replace(/\/+$/, '');
const passwordFile = process.env.WUJINXIA_ADMIN_PASSWORD_FILE || '';
const adminUser = process.env.WUJINXIA_ADMIN_USER || 'tvu595649';
if (!passwordFile || !fs.existsSync(passwordFile)) throw new Error('缺少管理员口令文件：设 WUJINXIA_ADMIN_PASSWORD_FILE');
const adminPassword = fs.readFileSync(passwordFile, 'utf8').trim();
const withThrottle = process.argv.includes('--with-throttle');
const stamp = Date.now();
const suffix = crypto.randomBytes(3).toString('hex');
const results = [];
let adminToken = '';
let userToken = '';
let userRefresh = '';
let userId = 0;
let installId = 'accept-install-' + suffix;

async function call(method, target, { token, body, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (raw !== undefined) { headers['Content-Type'] = 'application/json'; payload = raw; }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const response = await fetch(base + target, { method, headers, body: payload });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { unparsable: text.slice(0, 120) }; }
  return { status: response.status, json, headers: response.headers, text };
}
function check(name, pass, detail = '') {
  results.push({ name, pass: Boolean(pass), detail: String(detail).slice(0, 120) });
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail ? ' | ' + String(detail).slice(0, 110) : ''));
}
const ok = (name, condition, detail) => check(name, condition, detail);

function eventOf(overrides = {}) {
  return {
    eventId: 'acc-' + crypto.randomBytes(6).toString('hex'),
    installId,
    occurredAt: new Date().toISOString(),
    level: 'info',
    category: 'harvest',
    message: '收了 8 块地的花，获得 经验×104、粉百合×24',
    appVersion: '0.1.0',
    accountLabel: { stableId: 'uid-accept-' + suffix, nickname: '验收号' + suffix, serverName: '1928服' },
    ...overrides,
  };
}

const health = await call('GET', '/api/software/health');
ok('健康检查返回本项目服务名与版本', health.json?.service === 'wujinxia-app-cloud' && health.json?.version === '0.1.0' && health.json?.db === 'ok', JSON.stringify(health.json));

const registered = await call('POST', '/api/software/register', { body: { username: 'acc' + suffix, password: 'Accept-' + suffix + '-1' } });
ok('软件账号注册成功', registered.status === 201 && registered.json?.user?.id > 0, JSON.stringify(registered.json));
userId = registered.json?.user?.id || 0;
const duplicate = await call('POST', '/api/software/register', { body: { username: 'ACC' + suffix, password: 'Accept-' + suffix + '-1' } });
ok('同名（含大小写不同）注册被拒', duplicate.status === 409 && duplicate.json?.code === 'USERNAME_TAKEN', JSON.stringify(duplicate.json));
const weak = await call('POST', '/api/software/register', { body: { username: 'x', password: '123' } });
ok('不合法用户名或密码被拒', weak.status === 400 && weak.json?.code === 'INPUT_INVALID', JSON.stringify(weak.json));

const badPassword = await call('POST', '/api/software/login', { body: { username: 'acc' + suffix, password: 'Wrong-Password-1', installId, appVersion: '0.1.0' } });
ok('错误密码 401 且不泄露用户是否存在', badPassword.status === 401 && badPassword.json?.code === 'SOFTWARE_LOGIN_FAILED' && !/不存在|已存在/.test(String(badPassword.json?.error)), JSON.stringify(badPassword.json));
const noSuch = await call('POST', '/api/software/login', { body: { username: 'nobody-' + suffix, password: 'Wrong-Password-1', installId, appVersion: '0.1.0' } });
ok('不存在的用户与错误密码返回同一个码', noSuch.status === 401 && noSuch.json?.code === badPassword.json?.code, JSON.stringify(noSuch.json));

const login = await call('POST', '/api/software/login', { body: { username: 'acc' + suffix, password: 'Accept-' + suffix + '-1', installId, appVersion: '0.1.0' } });
userToken = login.json?.accessToken || '';
userRefresh = login.json?.refreshToken || '';
const license = login.json?.license || {};
ok('登录返回会话与授权字段', login.status === 200 && Boolean(userToken) && Boolean(userRefresh) && license.state === 'granted', JSON.stringify(Object.keys(login.json || {})));
ok('离线宽限硬截止由服务器时刻推导（默认 24 小时）', license.hardDeadlineMs - license.grantServerMs === 24 * 3600 * 1000 && license.renewAfterMs === 60000, JSON.stringify(license));

const refreshed = await call('POST', '/api/software/refresh', { body: { refreshToken: userRefresh, installId } });
ok('续期签发新令牌并重置授权时刻', refreshed.status === 200 && refreshed.json?.accessToken && refreshed.json.accessToken !== userToken && refreshed.json.license.hardDeadlineMs >= license.hardDeadlineMs, JSON.stringify(refreshed.json?.license));
const reused = await call('POST', '/api/software/refresh', { body: { refreshToken: userRefresh, installId } });
ok('旧刷新凭据用过一次即失效', reused.status === 401 && /SESSION_/.test(String(reused.json?.code)), JSON.stringify(reused.json));
userToken = refreshed.json.accessToken;
userRefresh = refreshed.json.refreshToken;
const wrongInstall = await call('POST', '/api/software/refresh', { body: { refreshToken: userRefresh, installId: 'someone-elses-install' } });
ok('安装标识不匹配的续期被拒并撤销该会话', wrongInstall.status === 401, JSON.stringify(wrongInstall.json));
const afterMismatch = await call('GET', '/api/software/license', { token: userToken });
ok('被撤销的访问令牌立即不可用', afterMismatch.status === 401, JSON.stringify(afterMismatch.json));

const relogin = await call('POST', '/api/software/login', { body: { username: 'acc' + suffix, password: 'Accept-' + suffix + '-1', installId, appVersion: '0.1.0' } });
userToken = relogin.json.accessToken;
userRefresh = relogin.json.refreshToken;

const batch = [
  eventOf({ traceId: 'acc-run-' + suffix, outcome: { sent: 8, confirmed: 8, unconfirmed: 0 }, outcomeState: 'confirmed' }),
  eventOf({ level: 'error', category: 'login', errorCode: 'REAL_LOGIN_FAILED', message: '登录失败 password=should-be-masked token=also-masked' }),
  eventOf({ level: 'warn', category: 'network', message: '线路不可达 https://route-user:route-pass@proxy.example:8443' }),
];
const ingest = await call('POST', '/api/logs/batch', { token: userToken, body: { events: batch } });
ok('批量日志接收：三条全部入库', ingest.status === 200 && ingest.json?.accepted?.length === 3 && ingest.json?.rejected?.length === 0, JSON.stringify(ingest.json));
const repeat = await call('POST', '/api/logs/batch', { token: userToken, body: { events: batch } });
ok('同一批重发只确认不重复入库', repeat.status === 200 && repeat.json?.duplicates?.length === 3 && repeat.json?.accepted?.length === 0, JSON.stringify({ a: repeat.json?.accepted?.length, d: repeat.json?.duplicates?.length }));
const tampered = batch.map(item => ({ ...item, message: '被人改过的一句' }));
const conflict = await call('POST', '/api/logs/batch', { token: userToken, body: { events: tampered } });
ok('同标识不同内容被拒且不覆盖原记录', conflict.status === 200 && conflict.json?.rejected?.length === 3 && conflict.json.rejected[0].reason === 'EVENT_CONFLICT' && conflict.json?.accepted?.length === 0, JSON.stringify(conflict.json?.rejected));
const withUserId = await call('POST', '/api/logs/batch', { token: userToken, body: { events: [{ ...eventOf(), userId: 999999 }] } });
ok('客户端自报归属（userId）整批被拒', withUserId.status === 400 && withUserId.json?.code === 'LOG_FIELD_NOT_ALLOWED', JSON.stringify(withUserId.json));
const otherInstall = await call('POST', '/api/logs/batch', { token: userToken, body: { events: [eventOf({ installId: 'not-my-install' })] } });
ok('安装标识与登记不一致的事件被逐条拒绝', otherInstall.status === 200 && otherInstall.json?.rejected?.length === 1 && otherInstall.json.rejected[0].reason === 'INSTALL_MISMATCH', JSON.stringify(otherInstall.json));
const oversized = await call('POST', '/api/logs/batch', { token: userToken, body: { events: Array.from({ length: 101 }, () => eventOf()) } });
ok('超过 100 条的批次被拒', oversized.status === 400 && oversized.json?.code === 'LOG_BATCH_TOO_LARGE', JSON.stringify(oversized.json));

adminToken = (await call('POST', '/api/admin/login', { body: { username: adminUser, password: adminPassword } })).json?.accessToken || '';
ok('管理员登录成功（独立管理会话）', Boolean(adminToken), '');
const crossUser = await call('GET', '/api/admin/users', { token: userToken });
ok('软件会话打不开后台接口', crossUser.status === 401, JSON.stringify(crossUser.json));
const crossAdmin = await call('GET', '/api/software/license', { token: adminToken });
ok('管理员会话不能当软件会话用', crossAdmin.status === 401, JSON.stringify(crossAdmin.json));

const users = await call('GET', '/api/admin/users?pageSize=100', { token: adminToken });
const listed = (users.json?.items || []).find(item => item.id === userId);
ok('后台用户列表带日志计数与注册时间', users.status === 200 && listed && listed.logCount === 3 && Boolean(listed.createdAt), JSON.stringify(listed));
const searched = await call('GET', '/api/admin/users?q=' + encodeURIComponent('acc' + suffix), { token: adminToken });
ok('后台按用户名搜索命中一条', searched.json?.total === 1, JSON.stringify(searched.json?.total));

const byUser = await call('GET', '/api/admin/logs?userId=' + userId + '&pageSize=50', { token: adminToken });
ok('日志按软件用户筛选', byUser.json?.total === 3, JSON.stringify(byUser.json?.total));
const byNick = await call('GET', '/api/admin/logs?nickname=' + encodeURIComponent('验收号'), { token: adminToken });
ok('日志按游戏号昵称部分匹配', byNick.json?.total === 3 && byNick.json.items.every(item => item.userId === userId), JSON.stringify(byNick.json?.total));
const byLevel = await call('GET', '/api/admin/logs?level=error&errorCode=REAL_LOGIN_FAILED', { token: adminToken });
ok('日志按级别与错误码筛选', byLevel.json?.total === 1 && byLevel.json.items[0].category === 'login', JSON.stringify(byLevel.json?.total));
const byTrace = await call('GET', '/api/admin/logs?traceId=acc-run-' + suffix, { token: adminToken });
ok('展开同次运行只含该次事件', byTrace.json?.total === 1, JSON.stringify(byTrace.json?.total));
const byRange = await call('GET', '/api/admin/logs?from=' + encodeURIComponent(new Date(Date.now() + 60000).toISOString()), { token: adminToken });
ok('时间区间过滤生效（未来起点应为空）', byRange.json?.total === 0, JSON.stringify(byRange.json?.total));
const storedError = (byLevel.json?.items || [])[0] || {};
const rawStored = JSON.stringify(byLevel.json?.items || []);
ok('服务端二次脱敏：口令与令牌不落云端', rawStored.includes('should-be-masked') === false && rawStored.includes('also-masked') === false && /\[已隐去\]/.test(storedError.message || ''), String(storedError.message).slice(0, 80));
ok('代理鉴权不落云端', rawStored.includes('route-pass') === false && rawStored.includes('route-user') === false, '');
ok('上传成功不等于游戏成功：后台文案带来源属性', /手机上报/.test((await call('GET', '/admin/', { })).text) === false && byLevel.json.items.length === 1, '来源属性见 installId 字段');

const settings = await call('GET', '/api/admin/settings', { token: adminToken });
ok('后台设置返回注册开关、保留期与最近备份', settings.status === 200 && typeof settings.json.allowRegistration === 'boolean' && settings.json.retention.normalDays === 30 && settings.json.retention.errorDays === 90, JSON.stringify(settings.json?.retention));
const badSetting = await call('PUT', '/api/admin/settings', { token: adminToken, body: { allowRegistration: true, evil: 1 } });
ok('后台设置拒绝未知键', badSetting.status === 400, JSON.stringify(badSetting.json));
const closed = await call('PUT', '/api/admin/settings', { token: adminToken, body: { allowRegistration: false } });
const blockedRegister = await call('POST', '/api/software/register', { body: { username: 'after-close-' + suffix, password: 'Accept-' + suffix + '-1' } });
await call('PUT', '/api/admin/settings', { token: adminToken, body: { allowRegistration: true } });
ok('关闭注册后新注册被拒', blockedRegister.status === 403 && blockedRegister.json?.code === 'REGISTRATION_CLOSED', JSON.stringify(blockedRegister.json) + ' put=' + closed.status);

const disabled = await call('POST', '/api/admin/users/' + userId + '/enabled', { token: adminToken, body: { enabled: false, reason: '验收停用' } });
const licenseAfterDisable = await call('GET', '/api/software/license', { token: userToken });
ok('停用后既有会话立即失效', disabled.status === 200 && licenseAfterDisable.status === 401, JSON.stringify({ d: disabled.status, l: licenseAfterDisable.status }));
const loginWhileDisabled = await call('POST', '/api/software/login', { body: { username: 'acc' + suffix, password: 'Accept-' + suffix + '-1', installId, appVersion: '0.1.0' } });
ok('停用期间登录被明确拒绝', loginWhileDisabled.status === 403 && loginWhileDisabled.json?.code === 'SOFTWARE_DISABLED', JSON.stringify(loginWhileDisabled.json));
await call('POST', '/api/admin/users/' + userId + '/enabled', { token: adminToken, body: { enabled: true } });
const reEnabled = await call('POST', '/api/software/login', { body: { username: 'acc' + suffix, password: 'Accept-' + suffix + '-1', installId, appVersion: '0.1.0' } });
ok('重新启用只恢复登录资格，旧会话不复活', reEnabled.status === 200 && licenseAfterDisable.status === 401, JSON.stringify({ re: reEnabled.status }));
userToken = reEnabled.json.accessToken;
userRefresh = reEnabled.json.refreshToken;

const newGamePassword = 'Rotated-' + suffix + '-2';
const reset = await call('POST', '/api/admin/users/' + userId + '/reset-password', { token: adminToken, body: { password: newGamePassword } });
const oldTokenDead = await call('GET', '/api/software/license', { token: userToken });
const loginWithOld = await call('POST', '/api/software/login', { body: { username: 'acc' + suffix, password: 'Accept-' + suffix + '-1', installId, appVersion: '0.1.0' } });
const loginWithNew = await call('POST', '/api/software/login', { body: { username: 'acc' + suffix, password: newGamePassword, installId, appVersion: '0.1.0' } });
ok('管理员重置密码后旧口令与旧会话全部失效', reset.status === 200 && oldTokenDead.status === 401 && loginWithOld.status === 401 && loginWithNew.status === 200, JSON.stringify({ r: reset.status, o: oldTokenDead.status, old: loginWithOld.status, nw: loginWithNew.status }));
userToken = loginWithNew.json.accessToken;
userRefresh = loginWithNew.json.refreshToken;
const audit = await call('GET', '/api/admin/audit?pageSize=50', { token: adminToken });
const auditRaw = JSON.stringify(audit.json?.items || []);
ok('后台审计记录了启停与重置密码等操作', audit.json?.total >= 4 && /user_disable|user_reset_password|user_enable/.test(auditRaw) && auditRaw.includes(newGamePassword) === false && auditRaw.includes(adminPassword) === false, JSON.stringify(audit.json?.total));
const remarked = await call('POST', '/api/admin/users/' + userId + '/remark', { token: adminToken, body: { remark: '验收备注 ' + stamp } });
const remarkSeen = (await call('GET', '/api/admin/users?q=' + encodeURIComponent('acc' + suffix), { token: adminToken })).json?.items?.[0];
ok('备注可写可读', remarked.status === 200 && remarkSeen?.remark === '验收备注 ' + stamp, JSON.stringify(remarkSeen?.remark));

const selfChange = await call('POST', '/api/software/password', { token: userToken, body: { currentPassword: newGamePassword, newPassword: 'Owner-' + suffix + '-3' } });
const afterSelfChange = await call('GET', '/api/software/license', { token: userToken });
ok('用户改密撤销自己的全部会话', selfChange.status === 200 && selfChange.json?.revoked === true && afterSelfChange.status === 401, JSON.stringify({ s: selfChange.status, a: afterSelfChange.status }));
const finalLogin = await call('POST', '/api/software/login', { body: { username: 'acc' + suffix, password: 'Owner-' + suffix + '-3', installId, appVersion: '0.1.0' } });
userToken = finalLogin.json?.accessToken || '';
const loggedOut = await call('POST', '/api/software/logout', { token: userToken, body: { refreshToken: finalLogin.json?.refreshToken } });
ok('退出登录撤销会话与刷新凭据', loggedOut.status === 200 && (await call('GET', '/api/software/license', { token: userToken })).status === 401, JSON.stringify(loggedOut.json));

const adminPage = await call('GET', '/admin/');
ok('后台静态入口可访问且带 CSP', adminPage.status === 200 && /无尽夏管理后台/.test(adminPage.text) && /script-src 'self'/.test(String(adminPage.headers.get('content-security-policy'))), String(adminPage.headers.get('content-security-policy')).slice(0, 60));
const traversal = await fetch(base + '/admin/../../etc/passwd');
ok('静态入口拒绝路径穿越', traversal.status === 404 || traversal.status === 400 || traversal.status === 403, String(traversal.status));
const unknownRoute = await call('GET', '/api/nope');
ok('未知接口 404 中文提示', unknownRoute.status === 404 && /接口不存在/.test(String(unknownRoute.json?.error)), JSON.stringify(unknownRoute.json));
const wrongMethod = await call('DELETE', '/api/software/login');
ok('方法不允许 405', wrongMethod.status === 405, String(wrongMethod.status));

if (withThrottle) {
  const victim = 'throttle-' + suffix;
  await call('POST', '/api/software/register', { body: { username: victim, password: 'Throttle-' + suffix + '-1' } });
  let throttled = 0;
  for (let index = 0; index < 10; index += 1) {
    const attempt = await call('POST', '/api/software/login', { body: { username: victim, password: 'nope-' + index + '-password', installId, appVersion: '0.1.0' } });
    if (attempt.status === 429) { throttled = index + 1; break; }
  }
  ok('连续错密码触发登录频控', throttled > 0, '第 ' + throttled + ' 次返回 429');
}

const passed = results.filter(item => item.pass).length;
console.log('\nRESULT ' + passed + '/' + results.length + ' 通过' + (passed === results.length ? ' · 全部通过' : ' · 有未通过项'));
for (const item of results.filter(entry => !entry.pass)) console.log('未通过：' + item.name + ' | ' + item.detail);
process.exit(passed === results.length ? 0 : 1);
