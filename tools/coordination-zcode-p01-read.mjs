import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Read-only P01 evidence capture. Never writes to the device.
const outDir = process.argv[2];
const serial = process.argv[3] || 'emulator-5558';
const pkg = process.argv[4] || 'online.ainiannian.wujinxia';
if (!outDir) { console.error('usage: node coordination-zcode-p01-read.mjs <outDir> [serial] [package]'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const adb = 'C:/leidian/LDPlayer14/adb.exe';
const run = (args, timeout = 30000) => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout, windowsHide: true });
const asApp = (cmd, timeout = 30000) => run(['shell', `run-as ${pkg} sh -c "${cmd}"`], timeout);
const sha = b => createHash('sha256').update(b).digest('hex');
const save = (n, v) => fs.writeFileSync(path.join(outDir, n), typeof v === 'string' ? v : JSON.stringify(v, null, 2) + '\n');

const report = { capturedAt: new Date().toISOString(), serial, package: pkg, scope: 'read-only P01 projection/deadline/alarm capture; no START/STOP, no fault injection, no device writes' };

// inventory of private files that carry keepalive/reconnect/stop state
const listing = asApp('ls -la files files/data 2>&1');
save('private-listing.txt', listing);
const names = listing.split(/\r?\n/).map(l => l.trim().split(/\s+/).pop()).filter(n => n && !/^(\.|\.\.)$/.test(n));
report.privateFileNames = names;

// engine-session.json carries the local API token: it is never copied. Only the whitelisted
// identity fields are recorded, and the token stays in the device's own file / tool memory.
const SECRET_FILES = new Set(['engine-session.json']);
const SESSION_WHITELIST = ['port', 'pid', 'processGeneration', 'state'];
const wanted = names.filter(n => /^(reconnect-deadlines\.json|keepalive-engine\.json|keepalive-selfcheck\.json|keepalive-reconnect.*\.json|native-stop-control\.json|engine-session\.json|stop-request.*\.json|keepalive-recovery.*\.json)$/.test(n));
report.readFiles = [];
for (const name of wanted) {
  const guesses = [`files/${name}`, `files/data/${name}`];
  for (const g of guesses) {
    let body;
    try { body = asApp(`cat ${g} 2>/dev/null`); } catch (e) { continue; }
    if (!body || !body.trim()) continue;
    if (SECRET_FILES.has(name)) {
      // Never persist the raw body of a file that holds a credential; keep identity fields only.
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (error) { parsed = null; }
      const safe = { note: 'whitelisted fields only; credential values are never written to evidence' };
      for (const key of SESSION_WHITELIST) if (parsed && parsed[key] !== undefined) safe[key] = parsed[key];
      save(`file-${path.basename(g)}`, safe);
      report.readFiles.push({ devicePath: g, bytes: null, sha256: null, parsed: parsed !== null, whitelist: SESSION_WHITELIST });
      break;
    }
    const isJson = /^\s*[{[]/.test(body);
    let parsed = null;
    if (isJson) { try { parsed = JSON.parse(body); } catch (e) { parsed = { __parseError: e.message }; } }
    save(`file-${path.basename(g)}`, body);
    report.readFiles.push({ devicePath: g, bytes: body.length, sha256: sha(body), parsed: parsed !== null, topKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 20) : null });
    break;
  }
}

// alarm manager entries that belong to this package
let alarm = '';
try { alarm = run(['shell', 'dumpsys', 'alarm'], 60000); } catch (e) { alarm = 'ERROR ' + e.message; }
save('dumpsys-alarm.raw.txt', alarm);
const alarmLines = alarm.split(/\r?\n/).filter(l => l.includes(pkg) || l.includes('garden'));
save('dumpsys-alarm-package-lines.txt', alarmLines.join('\n') + '\n');
report.alarm = { packageLineCount: alarmLines.length, sample: alarmLines.slice(0, 40) };

// engine/stop control identity from the local API, if reachable
try {
  const { connectDeviceApi } = await import('./device-local-api.mjs');
  const api = connectDeviceApi({ adb, serial, packageName: pkg });
  try {
    const status = await api.request('GET', '/api/local/status');
    save('api-status.json', status);
    report.api = { buildId: status.buildId, runtime: status.runtime, engineReadiness: status.engineReadiness, nativeStopControl: status.nativeStopControl };
  } finally { api.close(); }
} catch (e) { report.apiError = e.message; }

save('p01-report.json', report);
const idx = fs.readdirSync(outDir).filter(n => n !== 'index.json');
save('index.json', { capturedAt: new Date().toISOString(), files: idx.map(name => { const b = fs.readFileSync(path.join(outDir, name)); return { name, bytes: b.length, sha256: sha(b) }; }) });
console.log(JSON.stringify({ readFiles: report.readFiles, alarmCount: report.alarm.packageLineCount, api: report.api && { build: report.api.buildId, runtime: report.api.runtime, engine: report.api.engineReadiness }, apiError: report.apiError }, null, 1));