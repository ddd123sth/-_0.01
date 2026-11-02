// Shared harness: builds a real cloud app + real HTTP server on a random loopback
// port and a real SQLite file, plus fetch helpers. Never hardcodes any secret here.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../cloud/app.mjs';
import { loadConfig } from '../cloud/config.mjs';

const scratchRoot = path.resolve('.runtime');
fs.mkdirSync(scratchRoot, { recursive: true });

export function makeConfig({ dbFile, env = {} } = {}) {
  const merged = { ...process.env, WUJINXIA_PORT: '13999', WUJINXIA_SCRYPT_N: '1024', ...env };
  const config = loadConfig(merged);
  // Tests need an ephemeral port and, when asked, a dedicated database file.
  config.port = 0;
  if (dbFile) config.dbFile = dbFile;
  return config;
}

export async function startCloud({ dbFile, env = {} } = {}) {
  let file = dbFile;
  let ownsFile = false;
  if (!file) {
    file = fs.mkdtempSync(path.join(scratchRoot, 'cloud-test-'));
    file = path.join(file, 'service.db');
    ownsFile = true;
  }
  const config = makeConfig({ dbFile: file, env });
  const app = await createApp(config);
  const server = http.createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function call(method, target, { token, body, headers = {}, raw, allowRedirect = false } = {}) {
    const finalHeaders = { ...headers };
    if (token) finalHeaders.Authorization = `Bearer ${token}`;
    let payload;
    if (raw !== undefined) { finalHeaders['Content-Type'] = finalHeaders['Content-Type'] || 'application/json'; payload = raw; }
    else if (body !== undefined) { finalHeaders['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const response = await fetch(base + target, {
      method, headers: finalHeaders, body: payload, redirect: allowRedirect ? 'follow' : 'manual',
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, headers: response.headers, json, text };
  }

  async function register(username, password) {
    return call('POST', '/api/software/register', { body: { username, password } });
  }
  async function login(username, password, installId = 'install-aaaa1111') {
    return call('POST', '/api/software/login', { body: { username, password, installId } });
  }

  async function createAdminUser(username, password) {
    const hash = await app.hasher.hash(password);
    app.store.run('INSERT INTO admins(username,password_hash,enabled,created_at) VALUES(?,?,1,?)', username, hash, app.store.nowIso());
  }

  async function adminLogin(username, password) {
    return call('POST', '/api/admin/login', { body: { username, password } });
  }

  async function close() {
    await new Promise(resolve => server.close(resolve));
    app.close();
    if (ownsFile) fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }

  return { app, config, base, port, file, call, register, login, createAdminUser, adminLogin, close };
}

export function readDbBytes(file) {
  const parts = [];
  for (const name of [file, `${file}-wal`, `${file}-shm`]) {
    if (fs.existsSync(name)) parts.push(fs.readFileSync(name));
  }
  return Buffer.concat(parts);
}
