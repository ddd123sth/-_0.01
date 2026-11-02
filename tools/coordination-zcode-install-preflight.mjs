import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { connectDeviceApi } from './device-local-api.mjs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phase = process.argv[2];
if (!['before', 'after', 'final'].includes(phase)) throw new Error('Expected before, after or final');
const options = Object.fromEntries(process.argv.slice(3).map(arg => {
  const match = /^--(out|serial|index)=(.+)$/.exec(arg);
  if (!match) throw new Error('Expected --out=<directory> [--serial=emulator-5554|5556|5558] [--index=0|1|2]');
  return [match[1], match[2]];
}));
if (!options.out?.trim()) throw new Error('Explicit --out=<current evidence directory> required');
const serials = ['emulator-5554', 'emulator-5556', 'emulator-5558'];
if (options.index !== undefined && !/^[012]$/.test(options.index)) throw new Error('Index must be 0, 1 or 2');
const serial = options.serial ?? serials[Number(options.index ?? 2)];
const index = options.index === undefined ? serials.indexOf(serial) : Number(options.index);
if (!serials.includes(serial) || serials[index] !== serial) throw new Error('Serial/index mismatch');
const output = path.resolve(root, options.out);
if (fs.existsSync(output) && fs.readdirSync(output).some(name => name.startsWith(phase + '-'))) throw new Error('Phase evidence already exists; use a new --out directory');
fs.mkdirSync(output, { recursive: true });
const adb = 'C:/leidian/LDPlayer14/adb.exe';
const packageName = 'online.ainiannian.wujinxia';
const invoke = (args, maxBuffer = 16 * 1024 * 1024) => execFileSync(adb, ['-s', serial, ...args], { timeout: 30000, maxBuffer, windowsHide: true });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(one => JSON.parse(canonical(one)))
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
const indexBoot = execFileSync('C:/leidian/LDPlayer14/ld.exe', ['-s', String(index), 'cat', '/proc/sys/kernel/random/boot_id'], { timeout: 15000, encoding: 'utf8' }).trim();
const serialBoot = invoke(['shell', 'cat', '/proc/sys/kernel/random/boot_id']).toString().trim();
if (!/^[a-f0-9-]{36}$/.test(indexBoot) || indexBoot !== serialBoot) throw new Error('Index/serial boot identity mismatch');
const rawFile = (name, bytes) => {
  const file = path.join(output, phase + '-' + name);
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  return { file: path.basename(file), bytes: Buffer.byteLength(bytes), sha256: hash(bytes) };
};
const records = [];
const data = {};
let api;
try {
  api = connectDeviceApi({ adb, serial, packageName });
  for (const [key, route] of [['status', '/api/local/status'], ['accounts', '/api/local/accounts']]) {
    data[key] = await api.request('GET', route);
    records.push(rawFile(key + '.json', JSON.stringify(data[key], null, 2) + '\n'));
  }
  const accounts = data.status.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 3) throw new Error('Expected three preserved accounts');
  const expected = new Map([['2202', '42030917102202'], ['1928', '36019328101928'], ['4312', '97155634104312']]);
  const checks = [];
  for (const account of accounts) {
    const full = await api.request('GET', '/api/local/accounts/' + account.id);
    const config = await api.request('GET', '/api/local/accounts/' + account.id + '/config');
    records.push(rawFile('account-' + account.id + '.json', JSON.stringify(full, null, 2) + '\n'));
    records.push(rawFile('config-' + account.id + '.json', JSON.stringify(config, null, 2) + '\n'));
    const value = full.account || full;
    const desired = account.desiredRunning === false && account.running === false && account.state === 'stopped';
    const uid = String(account.uid ?? '');
    const server = String(account.serverId ?? '');
    checks.push({ id: account.id, server, uid, stopped: desired, runEpoch: account.runEpoch,
      fullConfigSha256: hash(canonical(value.config)), configResponseSha256: hash(canonical(config)),
      configCanonicalSha256: hash(canonical(config.config || config)),
      fullConfigEqualsConfig: canonical(value.config) === canonical(config.config || config),
      fullConfig: value.config });
    if (expected.get(server) !== uid || !desired) throw new Error('UID or stopped intent mismatch for local id ' + account.id);
  }
  const status = data.status;
  const runtime = status.runtime || {};
  const stopped = runtime.runningCount === 0 && runtime.pendingCount === 0;
  records.push(rawFile('processes.txt', invoke(['shell', 'ps', '-A', '-o', 'PID,PPID,NAME,ARGS'])));
  records.push(rawFile('package.txt', invoke(['shell', 'dumpsys', 'package', packageName])));
  const pm = invoke(['shell', 'pm', 'path', packageName]).toString().trim();
  if (!/^package:\/data\/app\/[^\r\n]+\/base\.apk$/.test(pm)) throw new Error('Unexpected package path');
  const installedPath = pm.slice('package:'.length);
  const destination = path.join(output, phase + '-base.apk');
  fs.writeFileSync(destination, invoke(['exec-out', 'cat', installedPath], 128 * 1024 * 1024), { flag: 'wx' });
  records.push({ file: path.basename(destination), bytes: fs.statSync(destination).size, sha256: hash(fs.readFileSync(destination)) });
  for (const name of ['keepalive-engine.json', 'keepalive-reconnect.json', 'keepalive-reconnect-delivery.json', 'keepalive-reconnect-handling.json', 'keepalive-reconnect-rejected.json', 'data/native-stop-control.json']) {
    try { records.push(rawFile(name.replaceAll('/', '-') , invoke(['shell', 'run-as', packageName, 'cat', 'files/' + name]))); }
    catch { records.push({ file: name, readable: false }); }
  }
  const summary = { taskId: 'install-preflight', phase, at: new Date().toISOString(), index, serial, bootId: serialBoot,
    packageName, build: status.clientBuildId || status.buildId || null, engineReadiness: status.engineReadiness,
    runtime, stopped, accounts: checks.map(({ fullConfig, ...one }) => one), records };
  fs.writeFileSync(path.join(output, phase + '-summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ phase, at: summary.at, bootMatched: true, build: summary.build,
    engineReadiness: summary.engineReadiness, runtime: summary.runtime, stopped,
    accounts: summary.accounts, evidenceFiles: records.length }, null, 2));
  if (!stopped || checks.some(one => !one.fullConfigEqualsConfig)) throw new Error('Idle/config precondition failed');
} finally { if (api) api.close(); }
