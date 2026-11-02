import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Read-only capacity evidence for the app-private file roots. It never starts
// or stops anything and never writes to the device: the reclaim itself runs
// inside the engine process, this only records what the device reports.
const outDir = process.argv[2];
const serial = process.argv[3] || 'emulator-5558';
const pkg = process.argv[4] || 'online.ainiannian.wujinxia';
if (!outDir) { console.error('usage: node coordination-zcode-capacity.mjs <outDir> [serial] [package]'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const adb = process.env.ADB_PATH || 'C:/leidian/LDPlayer14/adb.exe';
const run = (args, timeout = 60000) => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout, windowsHide: true });
const asApp = (command, timeout = 60000) => run(['shell', `run-as ${pkg} sh -c "${command}"`], timeout);
const sha = value => createHash('sha256').update(value).digest('hex');
const save = (name, value) => {
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  fs.writeFileSync(path.join(outDir, name), body);
  return sha(body);
};

const report = { capturedAt: new Date().toISOString(), serial, package: pkg,
  scope: 'read-only capacity projection and directory sizes; no START/STOP, no device writes' };

// The managed classes, in the same order the governor reports them.
const ROOTS = ['data/performance-diagnostics', 'diagnostics', 'engine-restart-decisions', 'log', 'engine',
  'pangle_p', 'gdt_database', 'native-ad-bridge', 'official-ui-bridge'];
report.roots = [];
for (const relative of ROOTS) {
  let listing = '', size = '';
  try { listing = asApp(`ls files/${relative} 2>/dev/null | head -40`); } catch { listing = ''; }
  try { size = asApp(`du -sk files/${relative} 2>/dev/null`); } catch { size = ''; }
  const entries = listing.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const kilobytes = Number((/(\d+)/.exec(size) || [])[1] || 0);
  report.roots.push({ relative, kilobytes, entryCount: entries.length, sample: entries.slice(0, 12) });
}
try { report.totalPrivateKilobytes = Number((/(\d+)/.exec(asApp('du -sk files 2>/dev/null')) || [])[1] || 0); }
catch { report.totalPrivateKilobytes = null; }
try { report.filesystem = asApp('df -k files 2>/dev/null'); } catch { report.filesystem = ''; }

// The engine's own bounded status projection. engine-session.json carries the
// local API token, so it is never read here.
let status = null;
try { status = JSON.parse(asApp('cat files/data/file-capacity-status.json 2>/dev/null')); } catch { status = null; }
report.capacityStatus = status;
report.capacityStatusPresent = status !== null;

// Current intent projection, whitelisted fields only.
let projection = null;
try { projection = JSON.parse(asApp('cat files/data/reconnect-deadlines.json 2>/dev/null')); } catch { projection = null; }
report.intentProjection = projection ? {
  revision: projection.revision, capturedAtMs: projection.capturedAtMs, nativeGeneration: projection.nativeGeneration,
  controlSeq: projection.controlSeq, controlKind: projection.controlKind, stopCommitted: projection.stopCommitted,
  accounts: (projection.accounts || []).map(row => ({ accountRef: row.accountRef, desiredRunning: row.desiredRunning,
    state: row.state, reconnectionEpoch: row.connectionEpoch, runEpoch: row.runEpoch, retryAtMs: row.retryAtMs })),
} : null;

// A STOP/latch or credential file that must survive every reclaim.
const PROTECTED = ['user-stop-request.json', 'data/native-stop-control.json', 'credential-key.enc',
  'engine-session.json', 'engine-heartbeat.json', 'device-profile.json', 'data/reconnect-deadlines.json'];
report.protectedPresent = {};
for (const relative of PROTECTED) {
  let present = false;
  try { present = asApp(`test -f files/${relative} && echo yes || echo no`).trim() === 'yes'; } catch { present = false; }
  report.protectedPresent[relative] = present;
}

report.processes = (() => { try { return run(['shell', 'ps -A']).split(/\r?\n/).filter(line => line.includes(pkg)); } catch { return []; } })();
report.reportSha256 = save('CAPACITY-READ.json', report);
console.log(JSON.stringify({ outDir, reportSha256: report.reportSha256,
  totalPrivateKilobytes: report.totalPrivateKilobytes, capacityStatusPresent: report.capacityStatusPresent,
  roots: report.roots.map(entry => `${entry.relative}=${entry.kilobytes}KB/${entry.entryCount}`) }, null, 2));