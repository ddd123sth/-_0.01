import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createCredentialCipher } from '../runtime/backend/persistence/credential-cipher.mjs';
import { createSoftwareIdentity } from '../runtime/backend/software/identity.mjs';
import { startCloud } from './cloud-harness.mjs';

const KEY = 'b'.repeat(64);
const reply = (status, value, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
function makeIdentity(store, cloud, fetchImpl) {
  return createSoftwareIdentity({ store, cipher: createCredentialCipher(KEY),
    baseUrl: 'https://identity.example.invalid/backend-v2', fetchImpl: async (url, init) => fetchImpl(cloud, url, init),
    stopAll: async () => ({ stopCommitted: true, cleanupComplete: true }),
    suspendOwner: async ownerRef => ({ ownerRef, stopCommitted: true, cleanupComplete: true, suspended: true }) });
}
async function realFetch(cloud, url, init) { return fetch(cloud.base + new URL(url).pathname.replace(/^\/backend-v2(?=\/)/, ''), init); }
const apiPath = url => new URL(url).pathname.replace(/^\/backend-v2(?=\/)/, '');
function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-integration-'));
  const store = openBackendStore({ dataDir: root });
  t.after(() => { try { store.close(); } catch {} });
  return { root, store };
}
async function registeredCloud(t, username='rotation_user') {
  const cloud = await startCloud({ env: { WUJINXIA_SESSION_TTL_MINUTES: '60', WUJINXIA_REFRESH_TTL_DAYS: '14' } });
  t.after(() => cloud.close());
  assert.equal((await cloud.register(username, 'Correct-Horse-9')).status, 201);
  return cloud;
}

// Real cloud HTTP routes and SQLite are used. Fetch wrappers only inject response
// loss/delay/malformed-license faults after the server has processed the request.
test('lost committed refresh response survives client restart with the same UUID and exact pair', async t => {
  const cloud = await registeredCloud(t), { root, store } = scratch(t);
  const observed = []; let lose = true;
  const fetchImpl = async (c, url, init) => {
    const response = await realFetch(c, url, init);
    if (apiPath(url) === '/api/software/refresh') {
      const request = JSON.parse(init.body); const body = await response.clone().json();
      observed.push({ rotationId: request.rotationId, status: response.status, pair: [body.accessToken, body.refreshToken] });
      if (lose) { lose = false; throw new TypeError('injected lost response after cloud commit'); }
    }
    return response;
  };
  let identity = makeIdentity(store, cloud, fetchImpl);
  await identity.initialize(); await identity.login({ username: 'rotation_user', password: 'Correct-Horse-9' });
  await assert.rejects(identity.refresh());
  await identity.shutdown(); store.close();
  const reopened = openBackendStore({ dataDir: root });
  t.after(() => { try { reopened.close(); } catch {} });
  identity = makeIdentity(reopened, cloud, fetchImpl);
  await identity.initialize();
  assert.equal(observed.length, 2);
  assert.ok(observed[0].rotationId, 'new clients attach a durable UUID');
  assert.equal(observed[1].rotationId, observed[0].rotationId);
  assert.deepEqual(observed[1].pair, observed[0].pair, 'retry returns the identical access/refresh pair');
  await identity.shutdown();
  reopened.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('new UUID refresh replays exact pair; legacy no-UUID refresh remains accepted without replay semantics', async t => {
  const cloud = await registeredCloud(t, 'contract_user');
  const login = await cloud.login('contract_user', 'Correct-Horse-9');
  const body = { refreshToken: login.json.refreshToken, installId: 'install-aaaa1111' };
  const legacy = await cloud.call('POST', '/api/software/refresh', { body });
  assert.equal(legacy.status, 200, 'pre-UUID clients keep their original three-argument route contract');
  const secondLogin = await cloud.login('contract_user', 'Correct-Horse-9');
  const rotationId = 'd32a9f20-45a6-4e88-90b6-f6b91f1f31d7';
  const fresh = { refreshToken: secondLogin.json.refreshToken, installId: 'install-aaaa1111', rotationId };
  const first = await cloud.call('POST', '/api/software/refresh', { body: fresh });
  const replay = await cloud.call('POST', '/api/software/refresh', { body: fresh });
  assert.equal(first.status, 200); assert.equal(replay.status, 200);
  assert.deepEqual([replay.json.accessToken, replay.json.refreshToken], [first.json.accessToken, first.json.refreshToken]);
  assert.equal((await cloud.call('POST', '/api/software/refresh', { body: { ...fresh, rotationId: 'bad' } })).status, 400);
});

test('pair is durable before a rejected license payload and restart does not rotate again', async t => {
  const cloud = await registeredCloud(t, 'pair_user'), { root, store } = scratch(t);
  let corrupt = true, refreshCount = 0;
  const fetchImpl = async (c, url, init) => {
    const response = await realFetch(c, url, init);
    if (apiPath(url) === '/api/software/refresh') {
      refreshCount++;
      if (corrupt) { corrupt = false; const json = await response.json(); json.license = { state: 'incomplete' }; return reply(200, json); }
    }
    return response;
  };
  let identity = makeIdentity(store, cloud, fetchImpl);
  await identity.initialize(); await identity.login({ username: 'pair_user', password: 'Correct-Horse-9' });
  await assert.rejects(identity.refresh());
  const cipher = createCredentialCipher(KEY), cloudRef = identity.cloudRef;
  const saved = JSON.parse(cipher.decrypt(store.get('SELECT session_cipher FROM backend_software_state WHERE cloud_ref=?', cloudRef).session_cipher));
  assert.notEqual(saved.refreshToken, undefined);
  await identity.shutdown(); store.close();
  const reopened = openBackendStore({ dataDir: root });
  identity = makeIdentity(reopened, cloud, fetchImpl); await identity.initialize();
  await identity.checkLicense();
  assert.equal(refreshCount, 1, 'the already committed pair is reused after restart');
  await identity.shutdown(); reopened.close();
});

test('late refresh cannot restore local authorization after explicit logout', async t => {
  const cloud = await registeredCloud(t, 'logout_race'), { store } = scratch(t);
  let release, reached; const seen = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; }); let hold = true;
  const fetchImpl = async (c, url, init) => {
    const response = await realFetch(c, url, init);
    if (hold && apiPath(url) === '/api/software/refresh') { hold = false; reached(); await gate; }
    return response;
  };
  const identity = makeIdentity(store, cloud, fetchImpl);
  await identity.initialize(); await identity.login({ username: 'logout_race', password: 'Correct-Horse-9' });
  const pending = identity.refresh().catch(error => error);
  await seen;
  const logout = await identity.logout();
  assert.equal(logout.localSignedOut, true);
  release(); await pending;
  assert.equal(identity.status().licenseState, 'signed_out');
  assert.equal(identity.status().licenseState, 'signed_out');
  await identity.shutdown();
});

test('unused expired/revoked refresh retirement is exact, idempotent and never issues a pair', async t => {
  const cloud = await registeredCloud(t, 'retire_user');
  for (const state of ['expired','revoked']) {
    const login = await cloud.login('retire_user', 'Correct-Horse-9');
    const token = login.json.refreshToken;
    if (state === 'expired') cloud.app.store.run("UPDATE refresh_tokens SET expires_at='2000-01-01T00:00:00.000Z' WHERE token_hash=?", cloud.app.sessions.hashToken(token));
    else cloud.app.store.run("UPDATE refresh_tokens SET revoked_at=?,revoke_reason='disabled' WHERE token_hash=?", cloud.app.store.nowIso(), cloud.app.sessions.hashToken(token));
    const denied = await cloud.call('POST', '/api/software/refresh-recovery-revoke', { body: { refreshToken: token, installId: 'install-wrong1111', rotationId: 'd32a9f20-45a6-4e88-90b6-f6b91f1f31d7' } });
    assert.notEqual(denied.status, 200, 'wrong install cannot retire a session');
    const accepted = await cloud.call('POST', '/api/software/refresh-recovery-revoke', { body: { refreshToken: token, installId: 'install-aaaa1111', rotationId: 'd32a9f20-45a6-4e88-90b6-f6b91f1f31d7' } });
    assert.equal(accepted.status, 200); assert.equal(accepted.json.revoked, true);
    assert.equal('accessToken' in accepted.json, false); assert.equal('refreshToken' in accepted.json, false);
    const replay = await cloud.call('POST', '/api/software/refresh-recovery-revoke', { body: { refreshToken: token, installId: 'install-aaaa1111', rotationId: 'd32a9f20-45a6-4e88-90b6-f6b91f1f31d7' } });
    assert.equal(replay.status, 200); assert.equal(replay.json.revoked, true);
  }
});

test('refresh username rename keeps the stable user-id owner', async t => {
  const cloud = await registeredCloud(t, 'rename_before'); const { store } = scratch(t);
  const identity = makeIdentity(store, cloud, realFetch);
  await identity.initialize(); await identity.login({ username: 'rename_before', password: 'Correct-Horse-9' });
  const before = identity.status().ownerRef;
  cloud.app.store.run("UPDATE software_users SET username='rename_after' WHERE username='rename_before'");
  await identity.refresh();
  assert.equal(identity.status().ownerRef, before);
  assert.equal(identity.status().user.username, 'rename_after');
  await identity.shutdown();
});


async function assertRollbackAfterInsertFault(cloud, { token, installId, rotationId = undefined, pathName = '/api/software/refresh', admin = false }) {
  const hash = cloud.app.sessions.hashToken(token);
  const beforeRefresh = cloud.app.store.get('SELECT * FROM refresh_tokens WHERE token_hash=?', hash);
  const beforeSession = beforeRefresh && cloud.app.store.get('SELECT id,token_hash FROM software_sessions WHERE id=?', beforeRefresh.session_id);
  assert.ok(beforeSession && beforeRefresh);
  const oldChildCount = cloud.app.store.get('SELECT COUNT(*) AS n FROM refresh_tokens WHERE session_id=?', beforeSession.id).n;
  const body = { refreshToken: token, ...(installId ? { installId } : {}), ...(rotationId !== undefined ? { rotationId } : {}) };
  const response = await cloud.call('POST', pathName, { body });
  assert.ok(response.status >= 500, 'injected database write failure reaches a failed response');
  const afterSession = cloud.app.store.get('SELECT token_hash FROM software_sessions WHERE id=?', beforeSession.id);
  const afterRefresh = cloud.app.store.get('SELECT used_at,rotation_id,revoked_at FROM refresh_tokens WHERE id=?', beforeRefresh.id);
  const afterChildCount = cloud.app.store.get('SELECT COUNT(*) AS n FROM refresh_tokens WHERE session_id=?', beforeSession.id).n;
  assert.equal(afterSession.token_hash, beforeSession.token_hash);
  assert.equal(afterRefresh.used_at, null); assert.equal(afterRefresh.rotation_id, null); assert.equal(afterRefresh.revoked_at, null);
  assert.equal(afterChildCount, oldChildCount);
}

test('all refresh routes roll back old-token consumption and session mutation when child or receipt insert fails', async t => {
  // UUID user route: fail after old-token consume, session hash update and child insert.
  const cloud = await registeredCloud(t, 'atomic_user');
  const login = await cloud.login('atomic_user', 'Correct-Horse-9');
  cloud.app.store.db.exec(`CREATE TRIGGER fail_rotation_receipt BEFORE INSERT ON refresh_rotation_receipts BEGIN SELECT RAISE(ABORT,'injected receipt write failure'); END`);
  await assertRollbackAfterInsertFault(cloud, { token: login.json.refreshToken, installId: 'install-aaaa1111', rotationId: 'ef4015cc-4f22-4fa1-8aa7-bc2a76a31f56' });
  cloud.app.store.db.exec('DROP TRIGGER fail_rotation_receipt');
  // Legacy user route still has the three-argument API but its writes are atomic.
  const legacyLogin = await cloud.login('atomic_user', 'Correct-Horse-9');
  cloud.app.store.db.exec(`CREATE TRIGGER fail_legacy_user_child BEFORE INSERT ON refresh_tokens WHEN NEW.parent_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected child write failure'); END`);
  await assertRollbackAfterInsertFault(cloud, { token: legacyLogin.json.refreshToken, installId: 'install-aaaa1111' });
  cloud.app.store.db.exec('DROP TRIGGER fail_legacy_user_child');
  // Legacy admin route retains its three-argument manager signature and also rolls back.
  await cloud.createAdminUser('atomic_admin', 'Correct-Horse-9');
  const adminLogin = await cloud.adminLogin('atomic_admin', 'Correct-Horse-9');
  cloud.app.store.db.exec(`CREATE TRIGGER fail_legacy_admin_child BEFORE INSERT ON refresh_tokens WHEN NEW.parent_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected admin child write failure'); END`);
  await assertRollbackAfterInsertFault(cloud, { token: adminLogin.json.refreshToken, installId: null, pathName: '/api/admin/refresh', admin: true });
  cloud.app.store.db.exec('DROP TRIGGER fail_legacy_admin_child');
});
