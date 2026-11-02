import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { bootstrapAdmin } from './bootstrap.mjs';

const service = 'wujinxia-backend-cloud';
const installRoot = '/opt/' + service;
const state = '/var/lib/' + service;
const configRoot = '/etc/' + service;
const backupRoot = '/var/backups/' + service;
const site = '/etc/nginx/conf.d/wujinxia-app-cloud.conf';
const rootUrl = 'https://wujinxia01.ainiannian.online';
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function publicHealth(url) {
  return JSON.parse(run('curl', ['--fail', '--silent', '--show-error', '--max-time', '15', '--resolve',
    'wujinxia01.ainiannian.online:443:127.0.0.1', url]));
}
function privateWrite(file, bytes, mode, options = {}) { fs.writeFileSync(file, bytes, { mode, ...options }); fs.chmodSync(file, mode); }
function ownDirectory(directory, mode, uid, gid) { fs.mkdirSync(directory, { recursive: true, mode }); fs.chmodSync(directory, mode); if (uid !== undefined) fs.chownSync(directory, uid, gid); }

export async function installRelease({ source, releaseId }) {
  if (process.getuid() !== 0 || !/^[a-f0-9]{24}$/.test(releaseId)) throw new Error('Independent deployment requires root and an exact release ID');
  const marker = path.join(installRoot, 'ownership.json');
  const existed = fs.existsSync(installRoot);
  if (existed) {
    if (!fs.existsSync(marker)) throw new Error('Existing new-cloud root lacks this project ownership proof');
    const ownership = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (ownership.service !== service || ownership.project !== 'garden-android-backend-rebuild') throw new Error('Existing independent service ownership does not match');
  } else {
    for (const item of [state, configRoot, backupRoot, '/etc/systemd/system/' + service + '.service']) {
      if (fs.existsSync(item)) throw new Error('An independent service object already exists without ownership proof: ' + item);
    }
    try { run('getent', ['passwd', service]); throw new Error('Independent system user already exists without ownership proof'); }
    catch (error) { if (error.status !== 2) throw error; }
    if (run('ss', ['-H', '-ltn', '( sport = :8092 )'])) throw new Error('Independent port 8092 is occupied');
  }
  const oldHealthBefore = publicHealth(rootUrl + '/api/software/health');
  if (oldHealthBefore.ok !== true) throw new Error('Original Android cloud health is not confirmed before mutation');
  if (!existed) {
    run('useradd', ['--system', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', service]);
    ownDirectory(installRoot, 0o755);
    privateWrite(marker, JSON.stringify({ service, project: 'garden-android-backend-rebuild', createdAt: new Date().toISOString() }) + '\n', 0o600, { flag: 'wx' });
  }
  const uid = Number(run('id', ['-u', service])), gid = Number(run('id', ['-g', service]));
  ownDirectory(state, 0o750, uid, gid);
  ownDirectory(configRoot, 0o750, 0, gid);
  ownDirectory(backupRoot, 0o700, 0, 0);
  const releaseRoot = path.join(installRoot, 'releases');
  ownDirectory(releaseRoot, 0o755);
  const release = path.join(releaseRoot, releaseId);
  if (!fs.existsSync(release)) fs.cpSync(source, release, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(release, 'release-manifest.json'), 'utf8'));
  if (manifest.releaseId !== releaseId) throw new Error('Independent release identity mismatch');
  for (const item of manifest.files) {
    const file = path.resolve(release, item.file);
    if (!file.startsWith(release + '/') || sha(fs.readFileSync(file)) !== item.sha256) throw new Error('Independent release source digest mismatch');
  }
  const env = { WUJINXIA_BIND: '127.0.0.1', WUJINXIA_PORT: '8092', WUJINXIA_DATA_DIR: state,
    WUJINXIA_DB_FILE: path.join(state, service + '.db'), WUJINXIA_ADMIN_STATIC_DIR: release + '/admin/dist',
    WUJINXIA_LICENSE_RENEW_AFTER_SECONDS: '20', WUJINXIA_GRACE_HOURS: '24', WUJINXIA_PURGE_INTERVAL_MINUTES: '60' };
  const envFile = path.join(configRoot, 'env');
  privateWrite(envFile, Object.entries(env).map(([key, value]) => key + '=' + value).join('\n') + '\n', 0o640);
  fs.chownSync(envFile, 0, gid);
  const backupKey = path.join(configRoot, 'backup.key');
  if (!fs.existsSync(backupKey)) privateWrite(backupKey, crypto.randomBytes(32), 0o600, { flag: 'wx' });
  if (fs.statSync(backupKey).uid !== 0 || (fs.statSync(backupKey).mode & 0o077)) throw new Error('New backup key permissions are unsafe');

  let admin;
  let adminCount = 0;
  if (fs.existsSync(env.WUJINXIA_DB_FILE)) {
    const db = new DatabaseSync(env.WUJINXIA_DB_FILE, { readOnly: true });
    try { adminCount = Number(db.prepare('SELECT COUNT(*) AS n FROM admins').get().n); } finally { db.close(); }
  }
  if (!adminCount) admin = bootstrapAdmin(release, env);
  else admin = { username: 'backend-admin', passwordFile: '/root/wujinxia-backend-cloud-admin.txt', created: false };
  for (const name of fs.readdirSync(state)) { const full = path.join(state, name); if (fs.statSync(full).isFile()) { fs.chownSync(full, uid, gid); fs.chmodSync(full, 0o600); } }
  const next = path.join(installRoot, 'current.next'), current = path.join(installRoot, 'current');
  if (fs.existsSync(next)) { if (!fs.lstatSync(next).isSymbolicLink()) throw new Error('Independent release swap target is not a symlink'); fs.unlinkSync(next); }
  if (fs.existsSync(current) && !fs.lstatSync(current).isSymbolicLink()) throw new Error('Independent current target is not a symlink');
  const previous = fs.existsSync(current) ? fs.readlinkSync(current) : null;
  fs.symlinkSync(release, next); fs.renameSync(next, current);
  for (const name of [service + '.service', service + '-backup.service', service + '-backup.timer']) {
    privateWrite('/etc/systemd/system/' + name, fs.readFileSync(path.join(release, 'deploy/backend-rebuild', name)), 0o644);
  }
  run('systemctl', ['daemon-reload']);
  run('systemctl', ['enable', service + '.service']);
  run('systemctl', [existed ? 'restart' : 'start', service + '.service']);
  let privateHealth;
  for (let attempt = 0; attempt < 24; attempt++) {
    try { privateHealth = await (await fetch('http://127.0.0.1:8092/api/software/health', { signal: AbortSignal.timeout(3000) })).json(); if (privateHealth.ok) break; } catch {}
    await pause(500);
  }
  if (privateHealth?.ok !== true || privateHealth.service !== service) throw new Error('New independent cloud did not become healthy');

  const before = fs.readFileSync(site, 'utf8'), beforeSha = sha(before);
  const block = fs.readFileSync(path.join(release, 'deploy/backend-rebuild/nginx-location.conf'), 'utf8').trimEnd();
  let updated = before;
  const begin = '    # BEGIN ' + service + ' independent service';
  const end = '    # END ' + service + ' independent service';
  if (before.includes(begin)) {
    const start = before.indexOf(begin), stop = before.indexOf(end, start);
    if (stop < 0) throw new Error('Existing backend prefix block has no end marker');
    updated = before.slice(0, start) + block + before.slice(stop + end.length);
  } else {
    const tls = before.indexOf('listen 443 ssl;'), anchor = before.indexOf('    location / {', tls);
    if (tls < 0 || anchor < 0 || before.includes('location ^~ /backend-v2/')) throw new Error('Original Android TLS config does not match the scoped insertion contract');
    updated = before.slice(0, anchor) + block + '\n\n' + before.slice(anchor);
  }
  const backupConf = '/root/' + service + '-nginx-before-' + new Date().toISOString().replace(/[:.]/g, '-') + '.conf';
  privateWrite(backupConf, before, 0o600, { flag: 'wx' });
  const nextConf = site + '.backend-v2-next';
  privateWrite(nextConf, updated, fs.statSync(site).mode & 0o777);
  fs.renameSync(nextConf, site);
  try { run('nginx', ['-t']); }
  catch { privateWrite(site, before, 0o644); throw new Error('Nginx validation failed; original scoped config restored before reload'); }
  run('systemctl', ['reload', 'nginx']);
  // reload returns before all new workers accept connections. Confirm the
  // actual prefix after the generation handoff instead of treating its first
  // old-worker 404 as a failed independent service.
  let newHealth;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { newHealth = publicHealth(rootUrl + '/backend-v2/api/software/health'); if (newHealth.service === service && newHealth.ok === true) break; } catch {}
    await pause(250);
  }
  const oldHealthAfter = publicHealth(rootUrl + '/api/software/health');
  if (newHealth.service !== service || newHealth.ok !== true || oldHealthAfter.ok !== true
    || oldHealthBefore.generation !== oldHealthAfter.generation) throw new Error('New prefix or original root health changed unexpectedly; inspect scoped rollback anchors');
  run('systemctl', ['enable', '--now', service + '-backup.timer']);
  run('systemctl', ['start', service + '-backup.service']);
  const backup = JSON.parse(fs.readFileSync(path.join(backupRoot, 'last-result.json'), 'utf8'));

  // These requests hit the actual new cloud and its real administrator.
  // No fabricated software/game account is created for this verification.
  const password = fs.readFileSync(admin.passwordFile, 'utf8').trim();
  async function request(endpoint, { method = 'GET', token, body } = {}) {
    const response = await fetch('http://127.0.0.1:8092' + endpoint, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    return { status: response.status, body: await response.json() };
  }
  const loggedIn = await request('/api/admin/login', { method: 'POST', body: { username: admin.username, password } });
  if (loggedIn.status !== 200 || !loggedIn.body.accessToken || loggedIn.body.admin?.username !== admin.username) throw new Error('New real administrator login not confirmed');
  const token = loggedIn.body.accessToken;
  const settingsBefore = await request('/api/admin/settings', { token });
  const auditBefore = await request('/api/admin/audit', { token });
  const invalid = await request('/api/admin/settings', { method: 'PUT', token,
    body: { allowRegistration: !settingsBefore.body.allowRegistration, retention: { normalDays: 0 } } });
  const settingsAfterInvalid = await request('/api/admin/settings', { token });
  const auditAfterInvalid = await request('/api/admin/audit', { token });
  if (invalid.status !== 400 || settingsBefore.body.allowRegistration !== settingsAfterInvalid.body.allowRegistration
    || JSON.stringify(settingsBefore.body.retention) !== JSON.stringify(settingsAfterInvalid.body.retention)
    || auditBefore.body.total !== auditAfterInvalid.body.total) throw new Error('Actual new-cloud settings validation changed persistent data');
  const valid = await request('/api/admin/settings', { method: 'PUT', token,
    body: { allowRegistration: settingsBefore.body.allowRegistration, retention: settingsBefore.body.retention } });
  const auditAfterValid = await request('/api/admin/audit', { token });
  if (valid.status !== 200 || auditAfterValid.body.total !== auditBefore.body.total + 1) throw new Error('Actual new-cloud settings/audit commit not confirmed');
  await request('/api/admin/logout', { method: 'POST', token, body: { refreshToken: loggedIn.body.refreshToken } });
  const database = new DatabaseSync(env.WUJINXIA_DB_FILE, { readOnly: true });
  let counts;
  try { counts = { users: Number(database.prepare('SELECT COUNT(*) AS n FROM software_users').get().n),
    admins: Number(database.prepare('SELECT COUNT(*) AS n FROM admins').get().n) }; } finally { database.close(); }
  return { service, releaseId, previous, release, port: 8092, publicBase: rootUrl + '/backend-v2',
    oldHealthBefore, oldHealthAfter, newHealth, nginx: { beforeSha, afterSha: sha(updated), backupConf },
    admin, database: env.WUJINXIA_DB_FILE, backupKey, backup,
    settingsVerification: { invalidRejected: invalid.status, invalidUnchanged: true, validCommittedWithAudit: true }, counts };
}
