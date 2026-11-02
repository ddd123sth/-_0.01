// Independent bounded network-restore worker for one P01 window.
//
// This process exists so the restore cannot be starved by the window controller's
// own event loop (every adb call there is synchronous). It sleeps on a ref'd timer
// until the shared absolute deadline, removes exactly the two rules the window
// added, verifies the device rule table, writes one receipt, and exits.
//
// The caller must verify `restore-ready.json` (pid alive) BEFORE it applies the
// DROP. A ref'd timer is deliberate: an unref'd timer exits immediately and the
// caller would believe a restore channel is armed when it is not.
//
// Absolute budget: every external call is bounded by what actually remains before
// the hard deadline, not by a fixed per-call timeout. Two 6s calls could not fit
// an 8s grace (B2), and a fixed timeout that starts after the hard deadline is a
// lie. When the remaining budget cannot cover a call, the worker records
// BUDGET_EXHAUSTED for that step and still attempts the next one with whatever is
// left; a command that was sent but not verified is never reported as clean.
//
// Usage:
//   node tools/coordination-zcode-p01-restore.mjs --serial=emulator-5558 \
//     --ip=43.179.238.191 --port=53121 --deadline-epoch-ms=<ms> \
//     --hard-epoch-ms=<ms> --out=<.runtime evidence dir>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADB = process.env.GARDEN_ANDROID_ADB || 'C:/leidian/LDPlayer14/adb.exe';
const SERIALS = new Set(['emulator-5554', 'emulator-5556', 'emulator-5558']);
const MAX_AHEAD_MS = 20 * 60_000;
const HARD_GRACE_MS = 8_000;
const MIN_CALL_MS = 400;
const args = Object.fromEntries(process.argv.slice(2).map(entry => {
  const [key, ...rest] = entry.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
const fail = code => { console.error(JSON.stringify({ ok: false, code })); process.exit(4); };
const serial = args.serial || '';
const ip = args.ip || '';
const port = Number(args.port || 0);
const deadline = Number(args['deadline-epoch-ms'] || 0);
const hard = Number(args['hard-epoch-ms'] || 0);
const outDir = path.resolve(args.out || '');
const octets = String(ip).split('.');
if (!SERIALS.has(serial)) fail('SERIAL');
if (octets.length !== 4 || octets.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) fail('IP');
if (!Number.isSafeInteger(port) || port < 1025 || port > 65535) fail('PORT');
if (!Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline - Date.now() > MAX_AHEAD_MS) fail('DEADLINE');
if (!Number.isSafeInteger(hard) || hard < deadline || hard - Date.now() > MAX_AHEAD_MS + HARD_GRACE_MS) fail('HARD');
if (!outDir.startsWith(path.join(root, '.runtime') + path.sep)) fail('OUT_DIR');
fs.mkdirSync(outDir, { recursive: true });

const writeOnce = (name, value) => {
  try { fs.writeFileSync(path.join(outDir, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
  catch { /* first writer wins; never overwrite another channel's proof */ }
};
// One external call may only use what is left before hard (minus the exit
// reserve). A call that cannot start is reported, not attempted with a timeout
// that would cross the boundary.
const run = (command) => {
  const budget = Math.floor(hard - Date.now());
  if (budget < MIN_CALL_MS) return { ok: false, code: 'BUDGET_EXHAUSTED', budgetMs: Math.max(0, budget), out: '' };
  const startedAt = Date.now();
  try {
    const out = execFileSync(ADB, ['-s', serial, 'shell', `su -c ${JSON.stringify(command)}`],
      { encoding: 'utf8', timeout: budget, windowsHide: true }).trim();
    return { ok: true, budgetMs: budget, elapsedMs: Date.now() - startedAt, out };
  } catch (error) {
    return { ok: false, code: budget < 1000 ? 'BUDGET_EXHAUSTED' : (error.code || 'EXEC_FAILED'),
      budgetMs: budget, elapsedMs: Date.now() - startedAt, out: String(error.stdout || '').trim() };
  }
};
const ready = { role: 'independent-restore-worker', pid: process.pid, serial, ip, port,
  deadlineEpochMs: deadline, hardEpochMs: hard, armedAt: new Date().toISOString() };
writeOnce('restore-ready.json', ready);

let fired = false;
const restore = () => {
  if (fired) return;
  fired = true;
  const calls = [];
  for (let pass = 0; pass < 2; pass += 1) {
    const result = run(`iptables -D OUTPUT -d ${ip} -p tcp --dport ${port} -j DROP 2>/dev/null; `
      + `iptables -D INPUT -s ${ip} -p tcp --sport ${port} -j DROP 2>/dev/null; echo done`);
    calls.push({ step: `remove-${pass + 1}`, ...result });
    if (!result.ok) break;
  }
  const verify = run(`iptables -S OUTPUT | grep -F '${ip}' || echo CLEAN-OUT; iptables -S INPUT | grep -F '${ip}' || echo CLEAN-IN`);
  calls.push({ step: 'verify', ...verify });
  const clean = verify.ok === true && /CLEAN-OUT/.test(String(verify.out)) && /CLEAN-IN/.test(String(verify.out));
  const removeAttempted = calls.some(entry => entry.step.startsWith('remove') && entry.ok);
  const receipt = { ...ready, restoredAt: new Date().toISOString(), calls, removeAttempted,
    removeFailed: calls.filter(entry => entry.step.startsWith('remove') && !entry.ok).map(entry => entry.code),
    verifyOk: verify.ok === true, clean };
  try { fs.writeFileSync(path.join(outDir, 'restore-worker.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' }); }
  catch { /* keep the first receipt */ }
  // Only a verified rule table is a successful restore; a sent command is not.
  process.exit(clean ? 0 : 2);
};

const timer = setTimeout(restore, Math.max(0, deadline - Date.now()));
timer.ref?.();
setTimeout(() => {
  if (fired) return;
  try {
    fs.writeFileSync(path.join(outDir, 'restore-hard-exit.json'),
      JSON.stringify({ ...ready, code: 'RESTORE_NOT_FIRED', firedAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' });
  } catch { /* best effort */ }
  process.exit(5);
}, Math.max(0, hard - Date.now()));