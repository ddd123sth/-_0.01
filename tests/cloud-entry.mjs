import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, '..', 'cloud', 'server.mjs');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function runServer(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [serverPath, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr, child }));
  });
}

test('the entry point refuses to start without a valid loopback port and exits non-zero', async () => {
  const missing = await runServer([], { WUJINXIA_PORT: '', WUJINXIA_BIND: '127.0.0.1' });
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /端口/);

  const wide = await runServer([], { WUJINXIA_PORT: '0.0.0.0', WUJINXIA_BIND: '127.0.0.1' });
  assert.notEqual(wide.code, 0);
});

test('the entry point binds a real port and prints the ready marker', async () => {
  const dir = fs.mkdtempSync(path.resolve('.runtime/cloud-entry-'));
  const port = await freePort();
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, WUJINXIA_PORT: String(port), WUJINXIA_BIND: '127.0.0.1', WUJINXIA_DATA_DIR: dir, WUJINXIA_SCRYPT_N: '1024' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  try {
    const deadline = Date.now() + 8000;
    while (!stdout.includes('WUJINXIA_CLOUD_READY') && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(stdout.includes('WUJINXIA_CLOUD_READY'), `no ready marker, stderr=${child.stderr}`);
    const res = await fetch(`http://127.0.0.1:${port}/api/software/health`);
    const json = await res.json();
    assert.equal(json.service, 'wujinxia-app-cloud');
  } finally {
    child.kill();
    await new Promise(r => child.once('close', r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
