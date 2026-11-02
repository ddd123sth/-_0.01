// P01 appointment observer: reads the device's own receipts for one already
// armed window. It never creates a fault and cannot change device networking.
//
// B2 shipped this file with `svc wifi disable`, which took the emulator offline
// on an image whose adb channel depends on the guest network, and with a
// defaulted instance/account, a relative timeout and no guardian binding. That
// entry point is removed, not merely discouraged:
//
//  - no `svc`, no Wi-Fi, no `iptables`, no broadcast and no process control is
//    present in this file (asserted by `selftest` over the source itself);
//  - every device read is bound to one explicit serial/account/owner/subject,
//    one run and connection epoch, one guardian pid and log, and one absolute
//    hard epoch that is still in the future;
//  - each sample re-reads files/engine-session.json, so a restarted engine can
//    never be read through a stale forward;
//  - the output file is opened once and an existing path is refused, so a
//    re-collection can never overwrite an earlier proof;
//  - it refuses to sample unless the independent STOP guardian reports ready.
//
// Usage:
//   node tools/coordination-zcode-p01-appointment.mjs --serial=emulator-5558 \
//     --account-ref=3 --uid=36019328101928 --owner-ref=<owner> \
//     --subject-ref=<subject> --run-epoch=<n> --connection-epoch=<n> \
//     --guardian-pid=<pid> --guardian-log=<file> --hard-epoch-ms=<ms> \
//     --out=.runtime/validation/.../appointment-sample.json [--seconds=60]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectDeviceApi } from './device-local-api.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADB = process.env.GARDEN_ANDROID_ADB || 'C:/leidian/LDPlayer14/adb.exe';
const PACKAGE = 'online.ainiannian.wujinxia';
const SERIALS = new Set(['emulator-5554', 'emulator-5556', 'emulator-5558']);
const TEXT = /^[A-Za-z0-9_.:-]{1,512}$/;
const argsOf = argv => Object.fromEntries(argv.filter(a => a.startsWith('--')).map(entry => {
  const [key, ...rest] = entry.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));

const mono = () => Number(process.hrtime.bigint()) / 1e6;
const fail = (code, message = code) => Object.assign(new Error(message), { code });

const readJson = (serial, file) => {
  try {
    const text = execFileSync(ADB, ['-s', serial, 'shell', `run-as ${PACKAGE} cat files/${file} 2>/dev/null`],
      { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim();
    if (!text) return null;
    return JSON.parse(text.slice(text.indexOf('{')));
  } catch { return null; }
};

export function validateSelection(input) {
  const serial = String(input.serial || '');
  if (!SERIALS.has(serial)) throw fail('ARGS', 'serial outside this project');
  const accountRef = String(input.accountRef || '');
  if (!/^[1-9][0-9]{0,19}$/.test(accountRef)) throw fail('ARGS', 'account-ref is required and must be one installed account');
  const uid = String(input.uid || '');
  if (!/^[0-9]{6,20}$/.test(uid)) throw fail('ARGS', 'uid is required');
  const ownerRef = String(input.ownerRef || '');
  if (!TEXT.test(ownerRef)) throw fail('ARGS', 'owner-ref is required');
  const subjectRef = String(input.subjectRef || '');
  if (!TEXT.test(subjectRef)) throw fail('ARGS', 'subject-ref is required');
  const runEpoch = Number(input.runEpoch), connectionEpoch = Number(input.connectionEpoch);
  if (!Number.isSafeInteger(runEpoch) || runEpoch < 1) throw fail('ARGS', 'run-epoch is required');
  if (!Number.isSafeInteger(connectionEpoch) || connectionEpoch < 1) throw fail('ARGS', 'connection-epoch is required');
  const guardianPid = Number(input.guardianPid);
  if (!Number.isSafeInteger(guardianPid) || guardianPid < 1) throw fail('ARGS', 'guardian-pid is required');
  const guardianLog = path.resolve(String(input.guardianLog || ''));
  if (!fs.existsSync(guardianLog)) throw fail('GUARDIAN', 'guardian log is missing');
  const hardEpochMs = Number(input.hardEpochMs);
  if (!Number.isSafeInteger(hardEpochMs) || hardEpochMs <= Date.now()) throw fail('ARGS', 'hard-epoch-ms must be a future absolute time');
  const out = path.resolve(String(input.out || ''));
  if (!out.startsWith(path.join(root, '.runtime') + path.sep)) throw fail('ARGS', 'evidence path must live under .runtime');
  const seconds = Number(input.seconds ?? 60);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 300) throw fail('ARGS', 'seconds must be 1..300');
  return { serial, accountRef, uid, ownerRef, subjectRef, runEpoch, connectionEpoch, guardianPid, guardianLog, hardEpochMs, out, seconds };
}

function processAlive(pid) {
  // process.kill(pid, 0) is not a reliable liveness proof on Windows for a pid
  // that was never used, so the platform probe is explicit.
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/NH'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      return out.includes(String(pid));
    } catch { return false; }
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function guardianReady(selection) {
  // A ready line alone is not freshness: the guardian must have been armed
  // recently, must still be alive, and must not have finished.
  try {
    if (Date.now() - fs.statSync(selection.guardianLog).mtimeMs > 180_000) return { ok: false, reason: 'GUARDIAN_LOG_STALE' };
  } catch { return { ok: false, reason: 'GUARDIAN_LOG_MISSING' }; }
  if (!processAlive(selection.guardianPid)) return { ok: false, reason: 'GUARDIAN_PROCESS_GONE' };
  const lines = fs.readFileSync(selection.guardianLog, 'utf8').split(/\r?\n/).filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const ready = lines.filter(line => line.phase === 'ready').at(-1);
  const done = lines.some(line => line.phase === 'done' || line.phase === 'hard-exit');
  return ready && !done ? { ok: true, enginePid: Number(ready.enginePid || 0), generation: ready.engine?.instanceId || null }
    : { ok: false, reason: ready ? 'GUARDIAN_ALREADY_DONE' : 'GUARDIAN_NOT_READY' };
}

async function collect(selection) {
  const startedAt = Date.now();
  const hardStop = Math.min(selection.hardEpochMs, startedAt + selection.seconds * 1000);
  // Create once, exclusively: an existing sample is never overwritten.
  fs.mkdirSync(path.dirname(selection.out), { recursive: true });
  const handle = fs.openSync(selection.out, 'wx');
  fs.closeSync(handle);
  const audit = { at: new Date().toISOString(), role: 'p01-appointment-observer', selection: { ...selection, guardianLog: selection.guardianLog },
    phases: {}, samples: [], note: 'read-only observer: no fault, no network change, no process control' };
  const mark = name => { if (!audit.phases[name]) audit.phases[name] = { at: new Date().toISOString(), elapsedMs: Math.round(mono() - audit.t0) }; };
  const persist = () => fs.writeFileSync(selection.out, JSON.stringify(audit, null, 2) + '\n');
  audit.t0 = mono();
  let api = null;
  try {
    const gate = guardianReady(selection);
    audit.phases.guardianGate = gate;
    if (!gate.ok) throw fail('GUARDIAN', 'STOP guardian is not ready: ' + gate.reason);
    while (Date.now() < hardStop) {
      // Every sample re-reads the session file: a new engine port is not read
      // through the previous forward.
      let status = null;
      try {
        api = connectDeviceApi({ adb: ADB, serial: selection.serial });
        status = await api.request('GET', '/api/local/status');
      } catch (error) {
        audit.samples.push({ at: new Date().toISOString(), error: error.code || error.message });
        try { api?.close(); } catch { /* stale forward is already gone */ }
        api = null;
        await new Promise(resolve => setTimeout(resolve, 700));
        continue;
      } finally { try { api?.close(); } catch { /* best effort */ } api = null; }
      const account = (status.accounts || []).find(one => String(one.uid) === selection.uid);
      const projection = readJson(selection.serial, 'data/reconnect-deadlines.json');
      const projectionRow = (projection?.accounts || []).find(one => one.accountRef === String(selection.accountRef));
      const engine = readJson(selection.serial, 'keepalive-engine.json');
      audit.samples.push({
        at: new Date().toISOString(), elapsedMs: Math.round(mono() - audit.t0),
        account: account ? { state: account.state, running: account.running, desiredRunning: account.desiredRunning,
          runEpoch: account.runEpoch, connectionEpoch: account.connectionEpoch, retryAt: account.retryAt, lastError: account.lastError } : null,
        projection: projection ? { revision: projection.revision, capturedAtMs: projection.capturedAtMs,
          row: projectionRow ? { state: projectionRow.state, retryAtMs: projectionRow.retryAtMs, runEpoch: projectionRow.runEpoch,
            connectionEpoch: projectionRow.connectionEpoch, desiredRunning: projectionRow.desiredRunning, scopeHash: projectionRow.scopeHash } : null } : null,
        alarm: engine ? { reconnectAlarm: engine.reconnectAlarm ?? null, reconnectSelection: engine.reconnectSelection ?? null,
          reconnectWakeAtMs: engine.reconnectWakeAtMs ?? null } : null,
        delivery: readJson(selection.serial, 'keepalive-reconnect-delivery.json'),
        handling: readJson(selection.serial, 'keepalive-reconnect-handling.json'),
      });
      if (projectionRow?.retryAtMs) mark('deadline_published');
      if (engine?.reconnectAlarm?.scheduled) mark('alarm_scheduled');
      if (audit.samples.at(-1).delivery?.receivedAtMs) mark('delivery_received');
      if (audit.samples.at(-1).handling?.receivedAtMs) mark('handling_received');
      if (account?.state === 'running' && Number(account.runEpoch) !== selection.runEpoch) mark('recovered_on_new_run');
      persist();
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    audit.completed = true;
    return { audit, exitCode: 0 };
  } catch (error) {
    audit.error = { code: error.code || 'ERROR', message: error.message };
    audit.completed = false;
    return { audit, exitCode: 5 };
  } finally {
    try { persist(); } catch { /* the first exclusive create already reserved the path */ }
  }
}

const selftest = () => {
  const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  // Only executable lines are inspected: the header comment intentionally names
  // the removed entry points, and a comment cannot disable a network.
  const code = source.split(/\r?\n/).filter(line => !line.trim().startsWith('//')).join('\n');
  // Needles are assembled at runtime so this assertion cannot match its own text.
  const wifiService = 'svc' + ' ' + 'wifi', wifiToggle = 'wifi' + ' ' + 'disable', firewall = 'ipta' + 'bles';
  const cases = [];
  cases.push(['no device Wi-Fi service call', !code.includes(wifiService) && !code.includes(wifiToggle)]);
  cases.push(['no device firewall command', !code.includes(firewall)]);
  cases.push(['no broadcast/process control', !/\bam\s+broadcast\b/.test(code) && !/\bkill\s+-9\b/.test(code)]);
  cases.push(['output is created exclusively', source.includes("fs.openSync(selection.out, 'wx')")]);
  cases.push(['guardian is required', source.includes('GUARDIAN_NOT_READY') && source.includes('guardianReady(selection)')]);
  cases.push(['session is re-read per sample', source.includes('connectDeviceApi({ adb: ADB, serial: selection.serial })')]);
  const rejects = mutate => {
    const base = { serial: 'emulator-5558', accountRef: '3', uid: '36019328101928', ownerRef: 'owner:fixture',
      subjectRef: 'subject:fixture', runEpoch: 1, connectionEpoch: 1, guardianPid: process.pid,
      guardianLog: fs.existsSync(path.join(root, 'package.json')) ? path.join(root, 'package.json') : '',
      hardEpochMs: Date.now() + 60000, out: path.join(root, '.runtime', 'tmp-b3', 'x.json'), seconds: 5, ...mutate };
    try { validateSelection(base); return false; } catch { return true; }
  };
  cases.push(['rejects a defaulted account', rejects({ accountRef: '' })]);
  cases.push(['rejects a missing owner', rejects({ ownerRef: '' })]);
  cases.push(['rejects a missing subject', rejects({ subjectRef: '' })]);
  cases.push(['rejects a missing run epoch', rejects({ runEpoch: 0 })]);
  cases.push(['rejects a missing guardian', rejects({ guardianPid: 0 })]);
  cases.push(['rejects a past hard bound', rejects({ hardEpochMs: Date.now() - 1 })]);
  cases.push(['rejects an output outside .runtime', rejects({ out: path.join(root, 'docs', 'x.json') })]);
  const failed = cases.filter(([, ok]) => !ok).map(([name]) => name);
  console.log(JSON.stringify({ mode: 'selftest', cases: cases.length, failed }, null, 2));
  return failed.length ? 1 : 0;
};

export async function main(argv) {
  if (argv[0] === 'selftest') return selftest();
  const options = argsOf(argv);
  let selection;
  try {
    selection = validateSelection({ serial: options.serial, accountRef: options['account-ref'], uid: options.uid,
      ownerRef: options['owner-ref'], subjectRef: options['subject-ref'], runEpoch: options['run-epoch'],
      connectionEpoch: options['connection-epoch'], guardianPid: options['guardian-pid'], guardianLog: options['guardian-log'],
      hardEpochMs: options['hard-epoch-ms'], out: options.out, seconds: options.seconds });
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code || 'ARGS', message: error.message }));
    return 4;
  }
  const { audit, exitCode } = await collect(selection);
  console.log(JSON.stringify({ out: selection.out, phases: audit.phases, samples: audit.samples.length,
    completed: audit.completed, error: audit.error ?? null }, null, 1));
  return exitCode;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('coordination-zcode-p01-appointment.mjs')) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; })
    .catch(error => { console.error(JSON.stringify({ ok: false, code: error.code || 'ERROR', message: error.message })); process.exitCode = 1; });
}