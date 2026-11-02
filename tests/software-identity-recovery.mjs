import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createCredentialCipher } from '../runtime/backend/persistence/credential-cipher.mjs';
import { createSoftwareIdentity } from '../runtime/backend/software/identity.mjs';

test('disabled identity with expired access token refreshes to the same owner and wakes preserved intent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-software-recovery-'));
  const store = openBackendStore({ dataDir: root });
  const requests = [];
  let licenseCall = 0, refreshCall = 0, authorizationWakeups = 0, suspensions = 0;
  const now = () => Date.now();
  const grant = () => {
    const serverTimeMs = now();
    return { user: { id: 42, username: 'garden.user', enabled: true }, accessToken: 'access-token-123456789',
      refreshToken: 'refresh-token-123456789', accessExpiresAt: new Date(serverTimeMs + 3600000).toISOString(),
      refreshExpiresAt: new Date(serverTimeMs + 7200000).toISOString(), state: 'granted', grantServerMs: serverTimeMs,
      serverTimeMs, hardDeadlineMs: serverTimeMs + 3600000, renewAfterMs: 1800000 };
  };
  const reply = (status, payload) => ({ ok: status >= 200 && status < 300, status,
    headers: { get: () => null }, text: async () => JSON.stringify(payload) });
  const fetchImpl = async (url, init) => {
    requests.push({ path: new URL(url).pathname, method: init.method });
    if (url.endsWith('/api/software/login')) return reply(200, grant());
    if (url.endsWith('/api/software/license')) {
      licenseCall++;
      if (licenseCall === 1) return reply(200, { enabled: false });
      return reply(401, { code: 'SESSION_EXPIRED', error: 'expired' });
    }
    if (url.endsWith('/api/software/refresh')) { refreshCall++; return reply(200, grant()); }
    throw new Error('Unexpected test request');
  };
  const identity = createSoftwareIdentity({ store, cipher: createCredentialCipher('a'.repeat(64)),
    baseUrl: 'https://identity.example.invalid/backend-v2', fetchImpl,
    stopAll: async () => ({ stopCommitted: true, cleanupComplete: true }),
    suspendOwner: async owner => { suspensions++; return { ownerRef: owner, stopCommitted: true, cleanupComplete: true, suspended: true }; },
    onAuthorized: () => { authorizationWakeups++; } });
  try {
    await identity.initialize();
    await identity.login({ username: 'garden.user', password: 'valid-password-123' });
    const owner = identity.status().ownerRef;
    assert.ok(owner);
    await identity.checkLicense();
    assert.equal(identity.status().licenseState, 'disabled');
    assert.equal(suspensions, 1);
    const recovered = await identity.checkLicense();
    assert.equal(recovered.licenseState, 'granted');
    assert.equal(recovered.ownerRef, owner);
    assert.equal(refreshCall, 1, 'expired access token falls through to refresh-token recovery instead of a licenseFlight cycle');
    assert.ok(authorizationWakeups >= 1, 'same-owner valid grant wakes preserved desired intents');
    assert.equal(identity.status().identityEpoch, 1, 'same-owner reauthentication does not manufacture an owner switch');
    assert.ok(suspensions >= 2, 'resume waits for a completed same-owner cleanup receipt');
  } finally {
    await identity.shutdown();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rotated refresh credentials survive a cleanup-pending window and activate without another cloud refresh', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-software-pending-grant-'));
  const store = openBackendStore({ dataDir: root });
  const requests = [];
  let licenseCall = 0, refreshCall = 0, cleanupCalls = 0, authorizationWakeups = 0;
  const now = () => Date.now();
  const grant = (refreshToken = 'refresh-token-original-123') => {
    const serverTimeMs = now();
    return { user: { id: 77, username: 'garden.pending', enabled: true }, accessToken: 'access-token-123456789',
      refreshToken, accessExpiresAt: new Date(serverTimeMs + 3600000).toISOString(),
      refreshExpiresAt: new Date(serverTimeMs + 7200000).toISOString(), state: 'granted', grantServerMs: serverTimeMs,
      serverTimeMs, hardDeadlineMs: serverTimeMs + 3600000, renewAfterMs: 1800000 };
  };
  const reply = (status, payload) => ({ ok: status >= 200 && status < 300, status,
    headers: { get: () => null }, text: async () => JSON.stringify(payload) });
  const fetchImpl = async (url, init) => {
    const endpoint = new URL(url).pathname;
    requests.push({ endpoint, method: init.method });
    if (endpoint.endsWith('/api/software/login')) return reply(200, grant());
    if (endpoint.endsWith('/api/software/license')) {
      licenseCall++;
      return reply(200, { enabled: false });
    }
    if (endpoint.endsWith('/api/software/refresh')) {
      refreshCall++;
      return reply(200, grant('refresh-token-rotated-123456'));
    }
    throw new Error('Unexpected test request');
  };
  const identity = createSoftwareIdentity({ store, cipher: createCredentialCipher('b'.repeat(64)),
    baseUrl: 'https://identity.example.invalid/backend-v2', fetchImpl,
    stopAll: async () => ({ stopCommitted: true, cleanupComplete: true }),
    suspendOwner: async owner => {
      cleanupCalls++;
      return { ownerRef: owner, stopCommitted: true, cleanupComplete: cleanupCalls !== 3, suspended: true };
    },
    onAuthorized: () => { authorizationWakeups++; } });
  try {
    await identity.initialize();
    await identity.login({ username: 'garden.pending', password: 'valid-password-123' });
    const owner = identity.status().ownerRef;
    await identity.checkLicense();
    assert.equal(identity.status().licenseState, 'disabled');

    await assert.rejects(identity.refresh(), error => error.code === 'SOFTWARE_SUSPEND_PENDING');
    assert.equal(refreshCall, 1, 'cloud refresh rotated the token exactly once');
    assert.equal(identity.status().pendingAuthorization, true, 'new encrypted grant remains pending until game cleanup is complete');
    assert.equal(identity.status().ownerRef, owner);

    const resumed = await identity.checkLicense();
    assert.equal(resumed.licenseState, 'granted');
    assert.equal(resumed.pendingAuthorization, false);
    assert.equal(resumed.ownerRef, owner);
    assert.equal(refreshCall, 1, 'pending grant resumes locally without reusing the rotated refresh token');
    assert.ok(authorizationWakeups >= 1);
  } finally {
    await identity.shutdown();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a pending authorization from a previous process is rechecked with the rotated session before activation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-software-pending-restart-'));
  const store = openBackendStore({ dataDir: root });
  let licenseCall = 0, refreshCall = 0, cleanupCalls = 0, authorizationWakeups = 0;
  const now = () => Date.now();
  const grant = (refreshToken = 'refresh-token-original-123') => {
    const serverTimeMs = now();
    return { user: { id: 88, username: 'garden.restart', enabled: true }, accessToken: 'access-token-original-123',
      refreshToken, accessExpiresAt: new Date(serverTimeMs + 3600000).toISOString(),
      refreshExpiresAt: new Date(serverTimeMs + 7200000).toISOString(), state: 'granted', grantServerMs: serverTimeMs,
      serverTimeMs, hardDeadlineMs: serverTimeMs + 3600000, renewAfterMs: 1800000 };
  };
  const licenseGrant = () => {
    const serverTimeMs = now();
    return { enabled: true, state: 'granted', user: { id: 88, username: 'garden.restart', enabled: true },
      grantServerMs: serverTimeMs, serverTimeMs, hardDeadlineMs: serverTimeMs + 3600000, renewAfterMs: 1800000 };
  };
  const reply = (status, payload) => ({ ok: status >= 200 && status < 300, status,
    headers: { get: () => null }, text: async () => JSON.stringify(payload) });
  const fetchImpl = async url => {
    const endpoint = new URL(url).pathname;
    if (endpoint.endsWith('/api/software/login')) return reply(200, grant());
    if (endpoint.endsWith('/api/software/license')) {
      licenseCall++;
      return reply(200, licenseCall === 1 ? { enabled: false } : licenseGrant());
    }
    if (endpoint.endsWith('/api/software/refresh')) { refreshCall++; return reply(200, grant('refresh-token-rotated-restart-123')); }
    throw new Error('Unexpected test request');
  };
  const cipher = createCredentialCipher('c'.repeat(64));
  let processNo = 0;
  const makeIdentity = () => createSoftwareIdentity({ store, cipher, processInstanceRef: 'fixture-process-' + (++processNo),
    baseUrl: 'https://identity.example.invalid/backend-v2', fetchImpl,
    stopAll: async () => ({ stopCommitted: true, cleanupComplete: true }),
    suspendOwner: async owner => {
      cleanupCalls++;
      return { ownerRef: owner, stopCommitted: true, cleanupComplete: cleanupCalls !== 3, suspended: true };
    }, onAuthorized: () => { authorizationWakeups++; } });
  let first = makeIdentity();
  try {
    await first.initialize();
    await first.login({ username: 'garden.restart', password: 'valid-password-123' });
    await first.checkLicense();
    await assert.rejects(first.refresh(), error => error.code === 'SOFTWARE_SUSPEND_PENDING');
    assert.equal(first.status().pendingAuthorization, true);
    await first.shutdown();

    first = makeIdentity();
    const recovered = await first.initialize();
    assert.equal(recovered.licenseState, 'granted');
    assert.equal(recovered.pendingAuthorization, false);
    assert.equal(refreshCall, 1);
    assert.equal(licenseCall, 2, 'new process must use the rotated access token for a fresh license response');
    assert.ok(authorizationWakeups >= 1, 'only the fresh current-process license response activates and wakes the preserved intent');
  } finally {
    await first.shutdown();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pending grant expiry uses monotonic time despite wall-clock rollback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-software-pending-clock-'));
  const store = openBackendStore({ dataDir: root });
  const realNow = Date.now;
  let licenseCall = 0, cleanupCalls = 0;
  const grant = (duration = 3600000) => {
    const serverTimeMs = realNow();
    return { user: { id: 99, username: 'garden.clock', enabled: true }, accessToken: 'access-token-clock-123456',
      refreshToken: 'refresh-token-clock-123456', accessExpiresAt: new Date(serverTimeMs + duration * 2).toISOString(),
      refreshExpiresAt: new Date(serverTimeMs + duration * 4).toISOString(), state: 'granted', grantServerMs: serverTimeMs,
      serverTimeMs, hardDeadlineMs: serverTimeMs + duration, renewAfterMs: Math.max(1, Math.floor(duration / 2)) };
  };
  const reply = (status, payload) => ({ ok: status >= 200 && status < 300, status,
    headers: { get: () => null }, text: async () => JSON.stringify(payload) });
  const fetchImpl = async url => {
    const endpoint = new URL(url).pathname;
    if (endpoint.endsWith('/api/software/login')) return reply(200, grant());
    if (endpoint.endsWith('/api/software/license')) {
      licenseCall++;
      return reply(200, licenseCall === 1 ? { enabled: false } : { ...grant(), enabled: true });
    }
    if (endpoint.endsWith('/api/software/refresh')) return reply(200, grant(120));
    throw new Error('Unexpected test request');
  };
  const identity = createSoftwareIdentity({ store, cipher: createCredentialCipher('d'.repeat(64)),
    baseUrl: 'https://identity.example.invalid/backend-v2', fetchImpl,
    stopAll: async () => ({ stopCommitted: true, cleanupComplete: true }),
    suspendOwner: async owner => {
      cleanupCalls++;
      return { ownerRef: owner, stopCommitted: true, cleanupComplete: cleanupCalls !== 3, suspended: true };
    } });
  try {
    await identity.initialize();
    await identity.login({ username: 'garden.clock', password: 'valid-password-123' });
    await identity.checkLicense();
    await assert.rejects(identity.refresh(), error => error.code === 'SOFTWARE_SUSPEND_PENDING');
    assert.equal(identity.status().pendingAuthorization, true);
    await new Promise(resolve => setTimeout(resolve, 160));
    Date.now = () => realNow() - 3600000;
    const checked = await identity.checkLicense();
    assert.equal(checked.licenseState, 'granted');
    assert.equal(checked.pendingAuthorization, false);
    assert.equal(licenseCall, 2, 'expired pending grant must be replaced by a fresh cloud license response');
  } finally {
    Date.now = realNow;
    await identity.shutdown();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
