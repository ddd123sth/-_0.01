import test from 'node:test';
import assert from 'node:assert/strict';
import { startCloud } from './cloud-harness.mjs';

const SECRET_PASSWORD = 'Correct-Horse-9';

test('register succeeds, rejects duplicate and bad input', async () => {
  const cloud = await startCloud();
  try {
    const createdUser = await cloud.register('alice_demo', SECRET_PASSWORD);
    assert.equal(createdUser.status, 201);
    assert.equal(createdUser.json.user.username, 'alice_demo');
    assert.equal(createdUser.json.user.enabled, true);
    assert.ok(createdUser.json.user.createdAt);

    const duplicate = await cloud.register('alice_demo', SECRET_PASSWORD);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.json.code, 'USERNAME_TAKEN');

    const shortName = await cloud.register('ab', SECRET_PASSWORD);
    assert.equal(shortName.status, 400);
    assert.equal(shortName.json.code, 'INPUT_INVALID');

    const weakPassword = await cloud.register('bob_demo', 'short');
    assert.equal(weakPassword.status, 400);
    assert.equal(weakPassword.json.code, 'INPUT_INVALID');

    const sameAsName = await cloud.register('carol_demo', 'carol_demo');
    assert.equal(sameAsName.status, 400);
    assert.equal(sameAsName.json.code, 'INPUT_INVALID');
  } finally { await cloud.close(); }
});

test('login returns a full license derived from server time', async () => {
  const cloud = await startCloud({ env: { WUJINXIA_GRACE_HOURS: '24', WUJINXIA_LICENSE_RENEW_AFTER_SECONDS: '60' } });
  try {
    await cloud.register('dave_demo', SECRET_PASSWORD);
    const before = Date.now();
    const res = await cloud.login('dave_demo', SECRET_PASSWORD);
    const after = Date.now();
    assert.equal(res.status, 200);
    const body = res.json;
    assert.ok(body.accessToken && body.refreshToken);
    assert.equal(body.license.state, 'granted');
    assert.ok(body.license.grantServerMs >= before - 1 && body.license.grantServerMs <= after + 1);
    assert.equal(body.license.renewAfterMs, 60000);
    assert.equal(body.license.hardDeadlineMs, body.license.grantServerMs + 24 * 3600 * 1000);
    assert.ok(body.serverTimeMs >= before - 1 && body.serverTimeMs <= after + 1);
    assert.equal(body.user.username, 'dave_demo');
  } finally { await cloud.close(); }
});

test('wrong password is 401 without leaking whether the user exists; disabled is 403', async () => {
  const cloud = await startCloud();
  try {
    await cloud.register('erin_demo', SECRET_PASSWORD);
    const badReal = await cloud.login('erin_demo', 'Wrong-Pass-1');
    const badGhost = await cloud.login('nobody_here', 'Wrong-Pass-1');
    assert.equal(badReal.status, 401);
    assert.equal(badGhost.status, 401);
    assert.equal(badReal.json.code, 'SOFTWARE_LOGIN_FAILED');
    assert.equal(badGhost.json.code, 'SOFTWARE_LOGIN_FAILED');
    assert.equal(badReal.json.error, badGhost.json.error);

    cloud.app.store.run("UPDATE software_users SET enabled=0 WHERE username='erin_demo'");
    const disabled = await cloud.login('erin_demo', SECRET_PASSWORD);
    assert.equal(disabled.status, 403);
    assert.equal(disabled.json.code, 'SOFTWARE_DISABLED');
  } finally { await cloud.close(); }
});

test('refresh rotates the old credential and rejects an install mismatch', async () => {
  const cloud = await startCloud();
  try {
    await cloud.register('frank_demo', SECRET_PASSWORD);
    const login = await cloud.login('frank_demo', SECRET_PASSWORD);
    const oldRefresh = login.json.refreshToken;
    const refreshed = await cloud.call('POST', '/api/software/refresh', { body: { refreshToken: oldRefresh, installId: 'install-aaaa1111' } });
    assert.equal(refreshed.status, 200);
    assert.ok(refreshed.json.accessToken);

    const reuse = await cloud.call('POST', '/api/software/refresh', { body: { refreshToken: oldRefresh, installId: 'install-aaaa1111' } });
    assert.equal(reuse.status, 401);
    assert.equal(reuse.json.code, 'SESSION_REVOKED');

    const newRefresh = refreshed.json.refreshToken;
    const mismatch = await cloud.call('POST', '/api/software/refresh', { body: { refreshToken: newRefresh, installId: 'install-bbbb2222' } });
    assert.equal(mismatch.status, 401);
    assert.equal(mismatch.json.code, 'SESSION_INSTALL_MISMATCH');

    const afterMismatch = await cloud.call('GET', '/api/software/license', { token: refreshed.json.accessToken });
    assert.equal(afterMismatch.status, 401);
    assert.equal(afterMismatch.json.code, 'SESSION_REVOKED');
  } finally { await cloud.close(); }
});

test('logout kills the access token immediately; password change revokes every session', async () => {
  const cloud = await startCloud();
  try {
    await cloud.register('grace_demo', SECRET_PASSWORD);
    const login = await cloud.login('grace_demo', SECRET_PASSWORD);
    const loggedOut = await cloud.call('POST', '/api/software/logout', { token: login.json.accessToken, body: { refreshToken: login.json.refreshToken } });
    assert.equal(loggedOut.status, 200);
    assert.equal(loggedOut.json.ok, true);
    const afterLogout = await cloud.call('GET', '/api/software/license', { token: login.json.accessToken });
    assert.equal(afterLogout.status, 401);
    assert.equal(afterLogout.json.code, 'SESSION_REVOKED');

    const login2 = await cloud.login('grace_demo', SECRET_PASSWORD);
    const changed = await cloud.call('POST', '/api/software/password', { token: login2.json.accessToken, body: { currentPassword: SECRET_PASSWORD, newPassword: 'Newer-Pass-2' } });
    assert.equal(changed.status, 200);
    assert.equal(changed.json.revoked, true);
    const afterChange = await cloud.call('GET', '/api/software/license', { token: login2.json.accessToken });
    assert.equal(afterChange.status, 401);
    assert.equal(afterChange.json.code, 'SESSION_REVOKED');

    const wrongCurrent = await cloud.call('POST', '/api/software/password', { token: (await cloud.login('grace_demo', 'Newer-Pass-2')).json.accessToken, body: { currentPassword: 'nope', newPassword: 'Another-Pass-3' } });
    assert.equal(wrongCurrent.status, 401);
    assert.equal(wrongCurrent.json.code, 'SOFTWARE_LOGIN_FAILED');
  } finally { await cloud.close(); }
});

test('a user token cannot reach admin routes and an admin token cannot reach software routes', async () => {
  const cloud = await startCloud();
  try {
    await cloud.register('henry_demo', SECRET_PASSWORD);
    await cloud.createAdminUser('root_admin', 'Admin-Pass-1');
    const userLogin = await cloud.login('henry_demo', SECRET_PASSWORD);
    const adminLogin = await cloud.adminLogin('root_admin', 'Admin-Pass-1');
    assert.equal(adminLogin.status, 200);

    const userOnAdmin = await cloud.call('GET', '/api/admin/users', { token: userLogin.json.accessToken });
    assert.equal(userOnAdmin.status, 401);

    const adminOnSoftware = await cloud.call('GET', '/api/software/license', { token: adminLogin.json.accessToken });
    assert.equal(adminOnSoftware.status, 401);
    assert.equal(adminOnSoftware.json.code, 'SESSION_INVALID');
  } finally { await cloud.close(); }
});
