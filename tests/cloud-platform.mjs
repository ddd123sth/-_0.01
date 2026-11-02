import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../cloud/config.mjs';
import { createPasswordHasher } from '../cloud/password.mjs';
import { startCloud } from './cloud-harness.mjs';

test('loadConfig rejects a bad port and a non loopback bind with a Chinese message', () => {
  const base = { WUJINXIA_BIND: '127.0.0.1', WUJINXIA_PORT: '8080' };
  assert.doesNotThrow(() => loadConfig(base));
  assert.throws(() => loadConfig({ ...base, WUJINXIA_PORT: '80' }), error => /端口/.test(error.message));
  assert.throws(() => loadConfig({ ...base, WUJINXIA_PORT: 'not-a-number' }), error => /整数/.test(error.message));
  assert.throws(() => loadConfig({ ...base, WUJINXIA_BIND: '0.0.0.0' }), error => /回环地址/.test(error.message));
});

test('password hashing uses the scrypt envelope and timing-safe verification', async () => {
  const hasher = createPasswordHasher({ n: 1024, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024, concurrency: 2, queueLimit: 32 });
  const secret = 'Hash-Check-4';
  const stored = await hasher.hash(secret);
  assert.match(stored, /^scrypt\$1024\$8\$1\$/);
  assert.equal(stored.includes(secret), false);
  assert.equal(await hasher.verify(secret, stored), true);
  assert.equal(await hasher.verify('wrong', stored), false);
  assert.equal(await hasher.verify(secret, 'not-a-hash'), false);
});

test('health endpoints report the service and a healthy database', async () => {
  const cloud = await startCloud();
  try {
    const software = await cloud.call('GET', '/api/software/health');
    assert.equal(software.status, 200);
    assert.equal(software.json.ok, true);
    assert.equal(software.json.service, 'wujinxia-app-cloud');
    assert.equal(software.json.version, '0.1.0');
    assert.equal(software.json.db, 'ok');
    assert.equal(typeof software.json.serverTimeMs, 'number');

    const admin = await cloud.call('GET', '/api/admin/health');
    assert.equal(admin.status, 200);
    assert.equal(admin.json.service, 'wujinxia-app-cloud');
  } finally { await cloud.close(); }
});

test('unknown routes are 404, wrong methods are 405 and the admin static placeholder is Chinese', async () => {
  const cloud = await startCloud({ env: { WUJINXIA_ADMIN_STATIC_DIR: '.runtime/no-such-admin-dir' } });
  try {
    const notFound = await cloud.call('GET', '/api/software/does-not-exist');
    assert.equal(notFound.status, 404);
    assert.equal(notFound.json.code, 'ROUTE_NOT_FOUND');

    const wrongMethod = await cloud.call('GET', '/api/software/login');
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'POST');

    const root = await cloud.call('GET', '/');
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/admin/');

    const staticMissing = await cloud.call('GET', '/admin/');
    assert.equal(staticMissing.status, 404);
    assert.equal(staticMissing.json.error, '管理后台静态资源尚未构建');

    const cors = await cloud.call('GET', '/api/software/health');
    assert.equal(cors.headers.get('access-control-allow-origin'), null);
    assert.equal(cors.headers.get('cache-control'), 'no-store');
  } finally { await cloud.close(); }
});

test('login is throttled with a 429 after eight failed attempts', async () => {
  const cloud = await startCloud();
  try {
    await cloud.register('throttle_user', 'Throttle-Pass-5');
    let last;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      last = await cloud.login('throttle_user', 'not-the-password');
      assert.equal(last.status, 401);
      assert.equal(last.json.code, 'SOFTWARE_LOGIN_FAILED');
    }
    const throttled = await cloud.login('throttle_user', 'not-the-password');
    assert.equal(throttled.status, 429);
    assert.equal(throttled.json.code, 'LOGIN_THROTTLED');
  } finally { await cloud.close(); }
});

test('register is throttled per hour after the volume cap', async () => {
  const cloud = await startCloud();
  try {
    for (let index = 0; index < 10; index += 1) {
      const res = await cloud.register(`bulk_user_${index}`, 'Bulk-Pass-8');
      assert.equal(res.status, 201, `register ${index} should succeed`);
    }
    const limited = await cloud.register('bulk_user_limited', 'Bulk-Pass-8');
    assert.equal(limited.status, 429);
    assert.equal(limited.json.code, 'REGISTER_THROTTLED');
  } finally { await cloud.close(); }
});
