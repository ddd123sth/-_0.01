// Bounded P01 window: one exact TCP DROP on the live world socket, aimed one
// second before an already-answered usr.heartTick of the *current* session.
//
// Repaired from the unmerged r7 tool (never imported as-is). The known defects
// fixed here:
//  - the heartbeat query binds the complete owner/subject/run/connection
//    identity in SQL WHERE, not an account-only post-filter;
//  - the device->host clock conversion has the correct sign (+offset) and the
//    next heartbeat phase is read from the answered frame, never guessed;
//  - immediately before the DROP the tool re-checks STOP, guardian liveness,
//    permit expiry and the remaining absolute budget;
//  - the window and the independent restore worker share one absolute hard
//    deadline, and every external call is bounded by what remains;
//  - readiness means a live engine pid + generation + advancing heartbeat, and
//    the closeout verifies rules are gone, workers are gone and the account is
//    running on a new connection epoch.
//
// Modes
//   selftest   argument/clock/SQL validation only, no device access
//   probe      read-only snapshot (intent identity, heartbeat phase, readiness)
//   window     guardian ready -> one START (or auto) -> phase -> armed restore
//              -> one DROP -> observe recovery -> verified restore -> summary
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connectDeviceApi } from './device-local-api.mjs';
import { armDeviceGuard, readGuardState } from './coordination-zcode-device-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADB = process.env.GARDEN_ANDROID_ADB || 'C:/leidian/LDPlayer14/adb.exe';
const SERIALS = new Set(['emulator-5554', 'emulator-5556', 'emulator-5558']);
const ACCOUNTS = Object.freeze({ '3': '36019328101928', '4': '97155634104312' });
const HB_PERIOD_MS = 60_000;
const MAX_PERMIT_AHEAD_MS = 20 * 60_000;
const MIN_RESTORE_HEADROOM_MS = 8_000;
const RECOVERY_BOUND_MS = 35_000;
export const P01_REQUIRED = Object.freeze(['guardianReady', 'engineReady', 'businessAllFalse', 'otherAccountsStopped',
  'accountStartControlValid', 'heartbeatPhaseBound', 'projectionSourceLive', 'freshGateBeforeFault', 'deviceGuardArmed',
  'deviceGuardIndependent', 'faultApplied', 'faultTargetsObservedSockets', 'futureDeadlineCaptured', 'nativeAppointmentScheduled',
  'deliveryReceived', 'handlingReceived', 'liveAppointmentRereadStable', 'accountRecoveredRunning', 'recoveredOnNewConnectionEpoch',
  'oldAppointmentRejectedAfterRecovery', 'rulesRestored', 'deviceLocalStopVerified', 'stopCommitted', 'allAccountsStopped',
  'stopCancellationStable', 'oldStopCommandDoesNotRevive', 'adbStayedAvailable']);

export function recoveredP01Sample(row, initial, restoredAtMs) {
  return Number.isFinite(restoredAtMs) && row.atMs >= restoredAtMs && row.state === 'running' && row.running === true &&
    row.desiredRunning === true && row.nativeStop?.stopCommitted === false && row.engineInstance === initial.generation &&
    row.intent?.desiredRunning === 1 && ['RUNNABLE', 'WAITING'].includes(row.intent?.state) &&
    row.intent?.runEpoch === row.runEpoch && row.intent?.connectionEpoch > initial.connectionEpoch &&
    row.projection?.runEpoch === row.intent.runEpoch && row.projection?.connectionEpoch === row.intent.connectionEpoch;
}

export function recoveredIsolationSample(row, initial) {
  return row.state === 'running' && row.running === true && row.desiredRunning === true &&
    Number.isSafeInteger(row.runEpoch) && row.runEpoch > 0 && Number.isSafeInteger(row.connectionEpoch) &&
    Number.isSafeInteger(initial.connectionEpoch) && row.connectionEpoch > initial.connectionEpoch &&
    row.intent?.desiredRunning === 1 && ['RUNNABLE', 'WAITING'].includes(row.intent.state) &&
    row.intent.runEpoch === row.runEpoch && row.intent.connectionEpoch === row.connectionEpoch;
}

export function liveAppointmentIdentity(row) {
  const a = row.alarm, i = row.intent, p = row.projection;
  if (!a?.scheduled || a.deadlineAtMs <= (row.deviceAtMs ?? row.atMs) + 1200 || row.nativeStop?.stopCommitted !== false ||
      i?.desiredRunning !== 1 || p?.desiredRunning !== true || a.accountRef !== p.accountRef || a.scopeHash !== p.scopeHash ||
      a.runEpoch !== i.runEpoch || p.runEpoch !== i.runEpoch || p.connectionEpoch !== i.connectionEpoch ||
      a.deadlineAtMs !== i.retryAtMs || a.controlSeq !== row.nativeStop.controlSeq || a.generation !== row.engineInstance) return null;
  return JSON.stringify([a.accountRef, a.scopeHash, i.runEpoch, i.connectionEpoch, a.deadlineAtMs, a.controlSeq, a.generation]);
}

export function oldAppointmentBroadcast(packageName, alarm) {
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  if (!['online.ainiannian.wujinxia', 'online.ainiannian.garden'].includes(packageName) || !uuid.test(alarm?.id || '') ||
      !uuid.test(alarm?.generation || '') || !intIn(alarm?.epoch, 0, 2147483647)) throw new Error('invalid captured appointment');
  return `am broadcast -n ${packageName}/online.ainiannian.garden.KeepAliveReceiver ` +
    `-a online.ainiannian.garden.action.RECONNECT_DUE --es reconnectId ${alarm.id} ` +
    `--es reconnectGeneration ${alarm.generation} --ei controlEpoch ${alarm.epoch}`;
}

// A window can replace several appointments before one is delivered. Keep
// every observed identity, including a valid future appointment first seen
// less than the live-reread headroom before its due time.
export function analyzeP01Samples(samples, { initial, faultStartMs, clockOffsetMs = 0,
  receiptBaseline = {}, restoredAtMs = null } = {}) {
  const futures = new Map(), candidates = new Map(), rereads = new Map();
  let liveReread = null, duplicateLiveAlarm = false, recovered = null;
  for (const [sampleIndex, row] of samples.entries()) {
    const deviceAtMs = row.deviceAtMs ?? row.atMs - clockOffsetMs, i = row.intent, p = row.projection, a = row.alarm;
    if (i?.desiredRunning === 1 && i.retryAtMs > deviceAtMs && p?.runEpoch === i.runEpoch && p?.connectionEpoch === i.connectionEpoch) {
      const key = `${i.runEpoch}:${i.connectionEpoch}:${i.retryAtMs}`;
      if (!futures.has(key)) futures.set(key, { sampleIndex, at: row.at, atMs: row.atMs, deviceAtMs,
        runEpoch: i.runEpoch, connectionEpoch: i.connectionEpoch, retryAtMs: i.retryAtMs, aheadMs: i.retryAtMs - deviceAtMs });
    }
    const future = i && a && futures.get(`${a.runEpoch}:${i.connectionEpoch}:${a.deadlineAtMs}`);
    if (a?.scheduled === true && a.deadlineAtMs > deviceAtMs && a.deadlineAtMs === i?.retryAtMs && future && a.runEpoch === i.runEpoch &&
        a.accountRef === p?.accountRef && a.scopeHash === p?.scopeHash && p?.desiredRunning === true &&
        a.controlSeq === row.nativeStop?.controlSeq && row.nativeStop?.stopCommitted === false &&
        a.generation === initial.generation && hostDueMs(Number(a.requestedAtMs), clockOffsetMs) >= faultStartMs) {
      if (!candidates.has(a.id)) candidates.set(a.id, { id: a.id, futureDeadline: future,
        alarmScheduled: { ...a, sampleIndex, at: row.at, atMs: row.atMs, afterFault: true }, delivery: null, handling: null });
    }
    const liveKey = liveAppointmentIdentity(row);
    if (liveKey) {
      const compact = { sampleIndex, atMs: row.atMs, intentKey: liveKey, alarmId: a.id,
        requestedAtMs: a.requestedAtMs, deadlineAtMs: a.deadlineAtMs };
      const prior = rereads.get(liveKey);
      if (prior) {
        if (prior.alarmId !== compact.alarmId || prior.requestedAtMs !== compact.requestedAtMs) duplicateLiveAlarm = true;
        else if (row.atMs - prior.atMs >= 1000 && !liveReread)
          liveReread = { a: prior, b: compact, sameIntent: true, bothBeforeDeadline: true };
      } else rereads.set(liveKey, compact);
    }
    const d = row.delivery, dc = candidates.get(d?.id);
    if (dc && d.outcome === 'forward-accepted' && d.receivedAtMs >= dc.alarmScheduled.deadlineAtMs &&
        d.receivedAtMs > Number(receiptBaseline.deliveryReceivedAtMs || 0) &&
        hostDueMs(Number(d.receivedAtMs), clockOffsetMs) > faultStartMs)
      dc.delivery ??= { ...d, sampleIndex, at: row.at, fresh: true };
    const h = row.handling, hc = candidates.get(h?.id);
    if (hc?.delivery && h.outcome === 'accepted-passive-recovery' && h.handledAtMs >= hc.delivery.receivedAtMs &&
        h.handledAtMs > Number(receiptBaseline.handlingHandledAtMs || 0) && h.generation === hc.alarmScheduled.generation &&
        h.epoch === hc.alarmScheduled.epoch)
      hc.handling ??= { ...h, sampleIndex, at: row.at, fresh: true };
    // Record actual recovery independently of whether the chosen/native
    // receipt has been observed yet. Missing receipt evidence stays missing.
    if (!recovered && recoveredP01Sample(row, initial, restoredAtMs)) recovered = { ...row, sampleIndex };
  }
  const all = [...candidates.values()].map(c => ({ ...c, complete: Boolean(c.delivery && c.handling) }));
  return { candidates: all, selected: all.find(c => c.complete) || null, liveReread, duplicateLiveAlarm, recovered };
}

const now = () => new Date().toISOString();
const ms = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
const ipv4 = value => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(value)) && String(value).split('.').every(p => Number(p) <= 255);
const intIn = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
// Device wall clock -> host wall clock. offset = host - device, so an event at
// device time D happens on the host at D + offset. Subtracting it was the r7
// sign defect and aimed the DROP at the wrong phase.
export const hostDueMs = (deviceDueMs, offsetMs) => deviceDueMs + offsetMs;

export function heartbeatSql(identity) {
  const text = value => /^[A-Za-z0-9:_.-]{1,512}$/.test(String(value)) ? String(value) : null;
  const num = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const parts = {
    owner_ref: text(identity.ownerRef), account_ref: text(identity.accountRef), subject_ref: text(identity.subjectRef),
    run_epoch: num(identity.runEpoch), connection_epoch: num(identity.connectionEpoch),
  };
  if (Object.values(parts).some(value => value === null)) throw new Error('heartbeat identity is incomplete');
  return `SELECT request_sequence,connection_epoch,accepted,frame_json FROM backend_customer_observations
WHERE owner_ref='${parts.owner_ref}' AND account_ref='${parts.account_ref}' AND subject_ref='${parts.subject_ref}'
  AND run_epoch=${parts.run_epoch} AND connection_epoch=${parts.connection_epoch}
  AND method='usr.heartTick' AND source_kind='response'
ORDER BY rowid DESC LIMIT 12;`;
}

function parseArgs(argv) {
  const mode = argv[0];
  if (!['selftest', 'probe', 'window', 'p01'].includes(mode)) throw Object.assign(new Error('mode must be selftest|probe|window|p01'), { code: 'ARGS' });
  const out = Object.fromEntries(argv.slice(1).filter(a => a.startsWith('--')).map(entry => {
    const [key, ...rest] = entry.replace(/^--/, '').split('=');
    return [key, rest.join('=')];
  }));
  out.mode = mode;
  out.out = path.resolve(out.out || '');
  out.serial = out.serial || 'emulator-5558';
  out.package = out.package || 'online.ainiannian.wujinxia';
  out.accountRef = String(out['account-ref'] || '3');
  out.uid = String(out.uid || ACCOUNTS[out.accountRef] || '');
  out.offlineMs = Number(out['offline-ms'] || 30000);
  out.dropLeadMs = Number(out['drop-lead-ms'] || 1000);
  out.start = out.start || 'auto';
  out.guardianPid = Number(out['guardian-pid'] || 0);
  out.guardianLog = path.resolve(out['guardian-log'] || '');
  out.hardEpochMs = Number(out['hard-epoch-ms'] || 0);
  out.stopCommandId = out['stop-command-id'] || '';
  out.closeEpochMs = Number(out['close-epoch-ms'] || 0);
  out.recoveryObserveMs = Number(out['recovery-observe-ms'] || 90000);
  if (mode !== 'selftest' && !out.out.startsWith(path.join(root, '.runtime') + path.sep)) throw Object.assign(new Error('evidence dir must live under .runtime'), { code: 'ARGS' });
  if (!SERIALS.has(out.serial)) throw Object.assign(new Error('serial outside this project'), { code: 'ARGS' });
  if (!['online.ainiannian.wujinxia', 'online.ainiannian.garden'].includes(out.package)) throw Object.assign(new Error('package outside this project'), { code: 'ARGS' });
  if (!ACCOUNTS[out.accountRef] || ACCOUNTS[out.accountRef] !== out.uid) throw Object.assign(new Error('account/uid pair is not an installed target'), { code: 'ARGS' });
  if (!['1', 'auto'].includes(out.start)) throw Object.assign(new Error('start must be 1 or auto'), { code: 'ARGS' });
  if (mode === 'window') {
    if (!intIn(out.offlineMs, 1000, 30000)) throw Object.assign(new Error('offline-ms must be 1000..30000'), { code: 'ARGS' });
    if (!intIn(out.dropLeadMs, 200, 5000)) throw Object.assign(new Error('drop-lead-ms must be 200..5000'), { code: 'ARGS' });
    if (!intIn(out.guardianPid, 1, 2 ** 31 - 1)) throw Object.assign(new Error('guardian-pid is required'), { code: 'ARGS' });
    if (!intIn(out.hardEpochMs, 1, Number.MAX_SAFE_INTEGER) || out.hardEpochMs <= Date.now()) throw Object.assign(new Error('hard epoch must be a future absolute time'), { code: 'ARGS' });
  }
  if (mode === 'p01') {
    // A real appointment window has to outlast one heartbeat (60s) plus the
    // 15s request timeout and several recovery backoff steps. The bound is
    // explicit here instead of being hidden in a per-call timeout.
    if (!intIn(out.offlineMs, 60_000, 240_000)) throw Object.assign(new Error('p01 offline-ms must be 60000..240000'), { code: 'ARGS' });
    if (!intIn(out.dropLeadMs, 200, 5000)) throw Object.assign(new Error('drop-lead-ms must be 200..5000'), { code: 'ARGS' });
    if (!intIn(out.guardianPid, 1, 2 ** 31 - 1)) throw Object.assign(new Error('guardian-pid is required'), { code: 'ARGS' });
    if (!intIn(out.hardEpochMs, 1, Number.MAX_SAFE_INTEGER) || out.hardEpochMs <= Date.now()) throw Object.assign(new Error('hard epoch must be a future absolute time'), { code: 'ARGS' });
    if (out.accountRef !== '3') throw Object.assign(new Error('p01 is bound to account 3 on this device'), { code: 'ARGS' });
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(out.stopCommandId)) throw Object.assign(new Error('p01 requires stop-command-id shared with guardian'), { code: 'ARGS' });
    if (out.serial !== 'emulator-5558') throw Object.assign(new Error('p01 is bound to 003'), { code: 'ARGS' });
    if (!intIn(out.recoveryObserveMs, 35000, 180000) || !(out.closeEpochMs > Date.now() && out.closeEpochMs + 30000 <= out.hardEpochMs))
      throw Object.assign(new Error('p01 requires close-epoch-ms, hard >= close+30000, recovery-observe-ms 35000..180000'), { code: 'ARGS' });
    if (out.closeEpochMs - Date.now() > 15 * 60000 || out.hardEpochMs - Date.now() > 17 * 60000)
      throw Object.assign(new Error('p01 close/hard exceed 15/17 minute window'), { code: 'ARGS' });
  }
  return out;
}

function validatePermit(options) {
  if (!options.permit) throw Object.assign(new Error('--permit is required'), { code: 'PERMIT' });
  const parsed = JSON.parse(fs.readFileSync(path.resolve(options.permit), 'utf8'));
  if (parsed.executionAllowed !== true) throw Object.assign(new Error('permit does not allow execution'), { code: 'PERMIT' });
  if (parsed.serial !== options.serial || String(parsed.accountRef) !== options.accountRef || String(parsed.uid) !== options.uid)
    throw Object.assign(new Error('permit identity mismatch'), { code: 'PERMIT' });
  const expiresAtMs = Number(parsed.expiresAtMs);
  if (!intIn(expiresAtMs, 1, Number.MAX_SAFE_INTEGER) || Date.now() >= expiresAtMs || expiresAtMs - Date.now() > MAX_PERMIT_AHEAD_MS)
    throw Object.assign(new Error('permit expiry is invalid or outside the permitted horizon'), { code: 'PERMIT' });
  if (Number(parsed.offlineMs) < options.offlineMs) throw Object.assign(new Error('offline duration exceeds the permit'), { code: 'PERMIT' });
  if (options.hardEpochMs > expiresAtMs) throw Object.assign(new Error('hard deadline exceeds the permit expiry'), { code: 'PERMIT' });
  if (options.mode === 'p01' && (Number(parsed.closeEpochMs) !== options.closeEpochMs || parsed.stopCommandId !== options.stopCommandId))
    throw Object.assign(new Error('permit closeEpochMs must match the guardian/window close'), { code: 'PERMIT' });
  return parsed;
}

const selftest = () => {
  const cases = [
    ['host conversion positive offset', hostDueMs(1000, 500) === 1500],
    ['host conversion negative offset', hostDueMs(1000, -250) === 750],
    ['host conversion zero', hostDueMs(1000, 0) === 1000],
    ['ipv4', ipv4('43.179.238.191') && !ipv4('43.179.238.256')],
    ['intIn rejects NaN', !intIn(NaN, 1, 10) && intIn(5, 1, 10)],
    ['account pair', ACCOUNTS['3'] === '36019328101928'],
  ];
  try {
    const sql = heartbeatSql({ ownerRef: 'owner:1', accountRef: '3', subjectRef: 'a'.repeat(64), runEpoch: 7, connectionEpoch: 9 });
    cases.push(['heartbeat SQL binds owner', sql.includes("owner_ref='owner:1'")]);
    cases.push(['heartbeat SQL binds subject', sql.includes("subject_ref='" + 'a'.repeat(64) + "'")]);
    cases.push(['heartbeat SQL binds run', sql.includes('run_epoch=7')]);
    cases.push(['heartbeat SQL binds connection', sql.includes('connection_epoch=9')]);
    try { heartbeatSql({ ownerRef: 'owner:1', accountRef: '3', subjectRef: "x' OR 1=1 --", runEpoch: 1, connectionEpoch: 1 }); cases.push(['SQL rejects injection', false]); }
    catch { cases.push(['SQL rejects injection', true]); }
  } catch { cases.push(['heartbeat SQL build', false]); }
  const failed = cases.filter(([, ok]) => !ok).map(([name]) => name);
  console.log(JSON.stringify({ mode: 'selftest', cases: cases.length, failed }, null, 2));
  return failed.length ? 1 : 0;
};

function device(options) {
  const shell = (command, timeout = 20000, input = null) => {
    const budget = options.hardEpochMs ? Math.min(timeout, options.hardEpochMs - Date.now()) : timeout;
    if (budget < 500) throw Object.assign(new Error('device call has no absolute hard budget'), { code: 'BUDGET' });
    return execFileSync(ADB, ['-s', options.serial, 'shell', command],
      { encoding: 'utf8', timeout: budget, windowsHide: true, ...(input === null ? {} : { input }) });
  };
  const rootShell = (command, timeout = 20000) => shell(`su -c ${JSON.stringify(command)}`, timeout);
  const sql = (statement, timeout = 30000, readOnly = true) => {
    const database = `/data/data/${options.package}/files/data/garden.db`;
    // The engine writes during login/recovery. A dot-command timeout waits for
    // a transient writer lock without printing a value that would corrupt the
    // single-row evidence output parsed below.
    return shell(`su -c 'sqlite3 ${readOnly ? '-readonly ' : ''}-cmd ".timeout 20000" ${database}'`,
      timeout, statement);
  };
  return { shell, rootShell, sql };
}

function appUid(options) {
  return device(options).rootShell(`stat -c %u /data/data/${options.package}`, 8000).trim();
}

function worldSockets(options, uid) {
  const text = device(options).rootShell('cat /proc/net/tcp', 8000);
  const found = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const local = fields[1], remote = fields[2], state = fields[3], owner = fields[7];
    if (state !== '01' || owner !== String(uid)) continue;
    const portHex = remote.split(':')[1];
    const port = parseInt(portHex, 16);
    if (!intIn(port, 1, 65535)) continue;
    const addr = remote.split(':')[0];
    const ip = [6, 4, 2, 0].map(i => parseInt(addr.slice(i, i + 2), 16)).join('.');
    const localPort = parseInt(local.split(':')[1], 16);
    if (!ipv4(ip) || !intIn(localPort, 1, 65535) || /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(ip)) continue;
    if (!found.some(one => one.ip === ip && one.port === port)) found.push({ ip, port, local, localPort });
  }
  return found.filter(one => one.port !== 443);
}

// Bind the fault to one exact session, not "the only socket". With a second
// account connected there are two world sockets; the engine's transport
// identity receipt carries the complete owner/subject/run/connection identity
// and the private TLS tuple, so the match stays exact.
function worldSocketForIdentity(options, identity) {
  const sockets = worldSockets(options, appUid(options));
  let receipt = null;
  try {
    const text = device(options).sql(`SELECT payload_json FROM backend_session_transport_identity_receipts
WHERE owner_ref='${identity.ownerRef}' AND account_ref='${identity.accountRef}' AND subject_ref='${identity.subjectRef}'
  AND run_epoch=${identity.runEpoch} AND connection_epoch=${identity.connectionEpoch}
ORDER BY rowid DESC LIMIT 1;`).trim();
    if (text) receipt = JSON.parse(text);
  } catch { receipt = null; }
  const tls = receipt?.tlsSocket;
  if (tls && intIn(tls.localPort, 1, 65535) && ipv4(tls.remoteAddress) && intIn(tls.remotePort, 1, 65535)) {
    const match = sockets.find(one => one.localPort === tls.localPort && one.ip === tls.remoteAddress && one.port === tls.remotePort);
    return { socket: match || null, source: 'transport-identity-receipt', receiptVerified: Boolean(match),
      candidates: sockets.length, receiptPresent: true };
  }
  if (sockets.length === 1) return { socket: sockets[0], source: 'unique-non-443-socket', receiptVerified: false, candidates: 1, receiptPresent: false };
  return { socket: null, source: 'ambiguous', receiptVerified: false, candidates: sockets.length, receiptPresent: Boolean(receipt) };
}

function engineReady(api, options) {
  return api.request('GET', '/api/local/status').then(status => {
    const engine = status?.engineReadiness;
    const problems = [];
    if (!status?.buildId) problems.push('NO_BUILD_ID');
    if (!engine || engine.ready !== true || engine.phase !== 'ready') problems.push('ENGINE_NOT_READY');
    if (!engine || !(Number(engine.pid) > 0)) problems.push('NO_ENGINE_PID');
    if (!engine || !/^[0-9a-f-]{36}$/.test(String(engine.instanceId || ''))) problems.push('NO_INSTANCE');
    if (!problems.length) {
      const line = device(options).shell('ps -A').split(/\r?\n/).find(one => one.includes(`${options.package}:engine`));
      const psPid = line ? Number(line.trim().split(/\s+/)[1]) : 0;
      if (!psPid) problems.push('NO_ENGINE_PROCESS');
      else if (psPid !== Number(engine.pid)) problems.push('ENGINE_PID_MISMATCH');
    }
    return { ready: problems.length === 0, problems, status, pid: Number(engine?.pid || 0), instanceId: engine?.instanceId || null };
  });
}

function guardianReady(options) {
  if (!options.guardianPid) return { ok: false, reason: 'NO_GUARDIAN' };
  try { process.kill(options.guardianPid, 0); } catch { return { ok: false, reason: 'GUARDIAN_PROCESS_GONE' }; }
  if (!options.guardianLog || !fs.existsSync(options.guardianLog)) return { ok: false, reason: 'GUARDIAN_LOG_MISSING' };
  const lines = fs.readFileSync(options.guardianLog, 'utf8').split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const ready = lines.filter(line => line.phase === 'ready').at(-1);
  const done = lines.some(line => line.phase === 'done' || line.phase === 'hard-exit');
  return ready && !done ? { ok: true, enginePid: Number(ready.enginePid || 0), generation: ready.engine?.instanceId || null }
    : { ok: false, reason: ready ? 'GUARDIAN_ALREADY_DONE' : 'GUARDIAN_NOT_READY' };
}

function latestHeartbeat(options, identity) {
  const rows = device(options).sql(heartbeatSql(identity)).trim();
  if (!rows) return { rowsSeen: 0, latest: null };
  const parsed = rows.split(/\r?\n/).map(line => line.split('|')).filter(parts => parts.length >= 4).map(([seq, ce, accepted, ...rest]) => {
    let frame; try { frame = JSON.parse(rest.join('|')); } catch { frame = null; }
    return { requestSequence: Number(seq), connectionEpoch: Number(ce), accepted: Number(accepted),
      receivedDeviceMs: Number(frame?.source?.receivedDeviceMs || 0), receivedMonotonicMs: Number(frame?.source?.receivedMonotonicMs || 0) };
  }).filter(one => one.receivedDeviceMs > 0 && one.connectionEpoch === identity.connectionEpoch);
  return { rowsSeen: parsed.length, latest: parsed[0] || null };
}

function deviceClockOffset(options) {
  const t0 = Date.now();
  const raw = device(options).shell('date +%s%3N', 8000).trim();
  const t1 = Date.now();
  const deviceNow = Number(raw);
  if (!Number.isFinite(deviceNow)) throw Object.assign(new Error('device clock unreadable'), { code: 'CLOCK' });
  return Math.round((t0 + t1) / 2 - deviceNow);
}

function writeJson(dir, name, value) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2) + '\n');
}

// Read one of the app's own receipts. A missing file is null, never a guess.
function appReadJson(options, file) {
  try {
    const text = execFileSync(ADB, ['-s', options.serial, 'shell', `run-as ${options.package} cat files/${file} 2>/dev/null`],
      { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim();
    if (!text) return null;
    return JSON.parse(text.slice(text.indexOf('{')));
  } catch { return null; }
}

async function probe(options) {
  fs.mkdirSync(options.out, { recursive: true });
  const api = connectDeviceApi({ adb: ADB, serial: options.serial, packageName: options.package });
  try {
    const ready = await engineReady(api, options);
    const status = ready.status;
    const account = (status.accounts || []).find(one => String(one.uid) === options.uid);
    const identityRows = account ? device(options).sql(`SELECT owner_ref,account_ref,subject_ref,run_epoch,connection_epoch FROM backend_run_intents
WHERE owner_ref='${account.ownerRef}' AND account_ref='${options.accountRef}' AND desired_running=1;`).trim() : '';
    const parts = identityRows ? identityRows.split('|') : null;
    const identity = parts ? { ownerRef: parts[0], accountRef: parts[1], subjectRef: parts[2], runEpoch: Number(parts[3]), connectionEpoch: Number(parts[4]) } : null;
    const heartbeat = identity ? latestHeartbeat(options, identity) : null;
    const offset = deviceClockOffset(options);
    const sockets = worldSockets(options, appUid(options));
    const result = { at: now(), mode: 'probe', serial: options.serial, package: options.package, accountRef: options.accountRef,
      uid: options.uid, engine: { ready: ready.ready, problems: ready.problems, pid: ready.pid, instanceId: ready.instanceId },
      nativeStopControl: status.nativeStopControl ?? null, account: account ? { state: account.state, running: account.running,
        desiredRunning: account.desiredRunning, runEpoch: account.runEpoch } : null,
      identity, heartbeat: heartbeat ? { rowsSeen: heartbeat.rowsSeen, latest: heartbeat.latest,
        nextDueHostMs: heartbeat.latest ? hostDueMs(heartbeat.latest.receivedDeviceMs + HB_PERIOD_MS, offset) : null } : null,
      clockOffsetMs: offset, worldSockets: sockets };
    writeJson(options.out, 'probe.json', result);
    console.log(JSON.stringify(result, null, 2));
    return ready.ready && sockets.length === 1 ? 0 : 2;
  } finally { api.close(); }
}

async function window(options) {
  fs.mkdirSync(options.out, { recursive: true });
  const permit = validatePermit(options);
  const hardMs = Math.min(options.hardEpochMs, Number(permit.expiresAtMs));
  const remaining = () => hardMs - Date.now();
  const write = (name, value) => writeJson(options.out, name, value);
  const summary = { at: now(), mode: 'window', serial: options.serial, package: options.package, accountRef: options.accountRef,
    uid: options.uid, offlineMs: options.offlineMs, dropLeadMs: options.dropLeadMs, hardEpochMs: hardMs,
    permitExpiresAtMs: Number(permit.expiresAtMs), criteria: {}, evidence: {}, startedAccount: false };
  let api = null, restore = null, dropped = false, faultAt = null, world = null, before = null;
  const cleanup = async () => {
    try { if (restore && restore.exitCode === null) restore.kill('SIGKILL'); } catch { /* best effort */ }
    try { api?.close(); } catch { /* forward removal is best effort but reported below */ }
  };
  try {
    const gate = guardianReady(options);
    summary.evidence.guardianGate = gate;
    if (!gate.ok) throw Object.assign(new Error('STOP guardian not ready: ' + gate.reason), { code: 'GUARDIAN' });
    api = connectDeviceApi({ adb: ADB, serial: options.serial, packageName: options.package });
    const ready = await engineReady(api, options);
    summary.evidence.engineReady = { ready: ready.ready, problems: ready.problems, pid: ready.pid, instanceId: ready.instanceId };
    if (!ready.ready) throw Object.assign(new Error('engine is not really ready'), { code: 'READY' });
    if (gate.enginePid && gate.enginePid !== ready.pid) throw Object.assign(new Error('guardian armed for another engine generation'), { code: 'READY' });
    const status0 = ready.status;
    let account = (status0.accounts || []).find(one => String(one.uid) === options.uid);
    if (!account) throw Object.assign(new Error('assigned account missing'), { code: 'ACCOUNT' });
    // An auxiliary account may stay connected for the isolation check, but only
    // with every business switch off. Its exact run/connection identity is
    // recorded so the same process can be shown not to be collateral damage.
    const accountsFull = await api.request('GET', '/api/local/accounts');
    const otherActive = (accountsFull.accounts || []).filter(one => String(one.uid) !== options.uid && (one.running || one.desiredRunning));
    summary.evidence.otherAccounts = [];
    for (const other of otherActive) {
      const otherConfig = await api.request('GET', `/api/local/accounts/${other.id}/config`);
      const otherText = JSON.stringify(otherConfig);
      for (const flag of ['plantEnabled', 'harvestEnabled', 'waterEnabled', 'waterwheelEnabled', 'freeWaterEnabled']) {
        if (new RegExp(`"${flag}":true`).test(otherText)) throw Object.assign(new Error('auxiliary account business switch is on: ' + flag), { code: 'BUSINESS' });
      }
      if (/"enabled":true/.test(JSON.stringify(otherConfig.config?.flowerRack || {}))) throw Object.assign(new Error('auxiliary flower rack switch is on'), { code: 'BUSINESS' });
      const otherIntent = device(options).sql(`SELECT run_epoch,connection_epoch,state FROM backend_run_intents
WHERE owner_ref='${other.ownerRef}' AND account_ref='${other.accountRef}';`).trim().split('|');
      summary.evidence.otherAccounts.push({ id: other.id, uid: other.uid, ownerRef: other.ownerRef,
        accountRef: other.accountRef, running: other.running, state: other.state,
        runEpoch: Number(otherIntent[0]), connectionEpoch: Number(otherIntent[1]) });
    }
    const config = await api.request('GET', `/api/local/accounts/${account.id}/config`);
    const configText = JSON.stringify(config);
    for (const flag of ['plantEnabled', 'harvestEnabled', 'waterEnabled', 'waterwheelEnabled', 'freeWaterEnabled']) {
      if (new RegExp(`"${flag}":true`).test(configText)) throw Object.assign(new Error('business switch is on: ' + flag), { code: 'BUSINESS' });
    }
    if (/"enabled":true/.test(JSON.stringify(config.config?.flowerRack || {}))) throw Object.assign(new Error('flower rack switch is on'), { code: 'BUSINESS' });
    summary.evidence.businessAllFalse = true;
    const originMs = Date.now();
    if (options.start === '1') {
      if (account.running || account.state === 'running') throw Object.assign(new Error('account already running before START'), { code: 'ACCOUNT' });
      const receipt = await api.request('POST', `/api/local/accounts/${account.id}/start`, { expectedPriorRunEpoch: account.runEpoch });
      summary.startedAccount = true;
      summary.evidence.start = { accepted: receipt.accepted === true, runEpoch: receipt.account?.runEpoch ?? null };
      for (let i = 0; i < 40; i++) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const fresh = await api.request('GET', '/api/local/status');
        const current = (fresh.accounts || []).find(one => String(one.uid) === options.uid);
        if (current?.running && current.state === 'running') { account = current; break; }
      }
    }
    if (!account.running || account.state !== 'running') throw Object.assign(new Error('account is not running'), { code: 'ACCOUNT' });
    const identityText = device(options).sql(`SELECT owner_ref,account_ref,subject_ref,run_epoch,connection_epoch FROM backend_run_intents
WHERE owner_ref='${account.ownerRef}' AND account_ref='${options.accountRef}' AND desired_running=1;`).trim();
    const parts = identityText.split('|');
    if (parts.length < 5) throw Object.assign(new Error('current intent identity missing'), { code: 'IDENTITY' });
    const identity = { ownerRef: parts[0], accountRef: parts[1], subjectRef: parts[2], runEpoch: Number(parts[3]), connectionEpoch: Number(parts[4]) };
    summary.evidence.identity = identity;
    const offset = deviceClockOffset(options);
    summary.evidence.clockOffsetMs = offset;
    // Wait for at least one answered heartbeat of this exact connection; a blind
    // DROP without phase evidence is exactly what P01 must not do.
    const hbDeadline = Date.now() + Math.min(75000, Math.max(5000, remaining() - options.offlineMs - MIN_RESTORE_HEADROOM_MS));
    let hb = null;
    while (Date.now() < hbDeadline) {
      hb = latestHeartbeat(options, identity);
      if (hb.latest) break;
      await new Promise(resolve => setTimeout(resolve, 6000));
    }
    if (!hb?.latest) throw Object.assign(new Error('no answered usr.heartTick in this connection; refusing a blind DROP'), { code: 'PHASE' });
    let dueHost = hostDueMs(hb.latest.receivedDeviceMs + HB_PERIOD_MS, offset);
    for (let i = 0; i < 4 && dueHost - Date.now() < 2000; i++) dueHost += HB_PERIOD_MS;
    if (dueHost - Date.now() > HB_PERIOD_MS * 2) throw Object.assign(new Error('heartbeat phase target is too far ahead'), { code: 'PHASE' });
    const plannedDropAt = dueHost - options.dropLeadMs;
    summary.evidence.heartbeatPhase = { latest: hb.latest, clockOffsetMs: offset, dueHostMs: dueHost, plannedDropAt };
    if (plannedDropAt <= Date.now() + MIN_RESTORE_HEADROOM_MS) throw Object.assign(new Error('planned DROP leaves no restore headroom'), { code: 'PHASE' });
    const selection = worldSocketForIdentity(options, identity);
    if (!selection.socket) throw Object.assign(new Error('cannot bind one exact world socket: ' + JSON.stringify(selection)), { code: 'SOCKET' });
    world = selection.socket;
    summary.evidence.world = { ...world, selection: selection.source, receiptVerified: selection.receiptVerified,
      candidateSockets: selection.candidates };
    const rulesBefore = device(options).rootShell('iptables -S OUTPUT; iptables -S INPUT', 8000);
    summary.evidence.rulesBefore = rulesBefore;
    if (rulesBefore.includes(world.ip) && /DROP/.test(rulesBefore.split(/\r?\n/).filter(line => line.includes(world.ip)).join('\n')))
      throw Object.assign(new Error('target already has a DROP rule'), { code: 'RULES' });
    // Fresh gate immediately before arming: STOP, guardian, permit, budget.
    const fresh = await api.request('GET', '/api/local/status');
    const stop = fresh.nativeStopControl;
    const stopIsNewer = stop?.recordedAt && Date.parse(stop.recordedAt) > originMs;
    const liveAccount = (fresh.accounts || []).find(one => String(one.uid) === options.uid);
    const freshGate = { stopIsNewer: Boolean(stopIsNewer), accountStillRunning: Boolean(liveAccount?.running),
      guardian: guardianReady(options), permitRemainingMs: Number(permit.expiresAtMs) - Date.now(), budgetRemainingMs: remaining() };
    summary.evidence.freshGate = freshGate;
    if (stopIsNewer) throw Object.assign(new Error('a newer STOP arrived before the fault'), { code: 'STOP' });
    if (!liveAccount?.running) throw Object.assign(new Error('account stopped before the fault'), { code: 'STOP' });
    if (!freshGate.guardian.ok) throw Object.assign(new Error('guardian lost before the fault'), { code: 'GUARDIAN' });
    if (freshGate.permitRemainingMs <= options.offlineMs + MIN_RESTORE_HEADROOM_MS) throw Object.assign(new Error('permit too close to expiry'), { code: 'PERMIT' });
    if (remaining() <= options.offlineMs + MIN_RESTORE_HEADROOM_MS) throw Object.assign(new Error('absolute budget too small'), { code: 'BUDGET' });
    const restoreDeadline = Math.min(plannedDropAt + options.offlineMs, hardMs - MIN_RESTORE_HEADROOM_MS);
    if (restoreDeadline - plannedDropAt < 1000) throw Object.assign(new Error('restore deadline collapses into the DROP'), { code: 'BUDGET' });
    const restoreScript = path.join(root, 'tools', 'coordination-zcode-p01-restore.mjs');
    restore = spawn(process.execPath, [restoreScript, `--serial=${options.serial}`, `--ip=${world.ip}`, `--port=${world.port}`,
      `--deadline-epoch-ms=${restoreDeadline}`, `--hard-epoch-ms=${Math.min(hardMs, restoreDeadline + 8000)}`, `--out=${options.out}`],
    { detached: false, stdio: 'ignore', windowsHide: true });
    const readyFile = path.join(options.out, 'restore-ready.json');
    let restoreReady = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      if (fs.existsSync(readyFile)) {
        try { restoreReady = JSON.parse(fs.readFileSync(readyFile, 'utf8')); } catch { restoreReady = null; }
        if (restoreReady?.pid === restore.pid) break;
      }
      if (restore.exitCode !== null) break;
    }
    let restoreAlive = false;
    try { process.kill(restore.pid, 0); restoreAlive = true; } catch { restoreAlive = false; }
    summary.evidence.restoreArm = { pid: restore.pid, ready: restoreReady, alive: restoreAlive, deadline: restoreDeadline };
    if (!restoreReady || restoreReady.pid !== restore.pid || !restoreAlive) throw Object.assign(new Error('independent restore worker is not ready'), { code: 'RESTORE' });
    while (Date.now() < plannedDropAt - 1000) await new Promise(resolve => setTimeout(resolve, Math.min(1000, plannedDropAt - Date.now() - 1000)));
    // Re-discover the socket immediately before the DROP: a reconnect can move it.
    const atDrop = worldSocketForIdentity(options, identity);
    if (!atDrop.socket || atDrop.socket.ip !== world.ip || atDrop.socket.port !== world.port || atDrop.socket.localPort !== world.localPort)
      throw Object.assign(new Error('world socket moved before the DROP'), { code: 'SOCKET' });
    while (Date.now() < plannedDropAt) await new Promise(resolve => setTimeout(resolve, Math.min(50, plannedDropAt - Date.now())));
    const apply = device(options).rootShell(`iptables -I OUTPUT 1 -d ${world.ip} -p tcp --dport ${world.port} -j DROP; `
      + `iptables -I INPUT 1 -s ${world.ip} -p tcp --sport ${world.port} -j DROP; echo applied`, 8000);
    dropped = true; faultAt = Date.now();
    const after = device(options).rootShell(`iptables -S OUTPUT; iptables -S INPUT`, 8000);
    const applied = after.split(/\r?\n/).filter(line => line.includes(world.ip) && /DROP/.test(line));
    summary.evidence.fault = { apply, faultAt, ip: world.ip, port: world.port, appliedRules: applied };
    if (applied.length < 2) throw Object.assign(new Error('DROP rules were not both applied'), { code: 'RULES' });
    const samples = [];
    let firstRecoveringAt = null, firstRunningAt = null, newEpoch = null;
    const observeUntil = Math.min(restoreDeadline + 5000, hardMs - 2000);
    while (Date.now() < observeUntil) {
      try {
        const status = await api.request('GET', '/api/local/status');
        const row = (status.accounts || []).find(one => String(one.uid) === options.uid);
        // publicAccount intentionally has no connectionEpoch field. Read the
        // exact durable intent, never Number(undefined)/NaN as a "new epoch".
        const intentFields = device(options).sql(`SELECT run_epoch,connection_epoch,state,desired_running FROM backend_run_intents
WHERE owner_ref='${identity.ownerRef}' AND account_ref='${identity.accountRef}' AND subject_ref='${identity.subjectRef}';`).trim().split('|');
        const intent = intentFields.length === 4 ? { runEpoch: Number(intentFields[0]), connectionEpoch: Number(intentFields[1]),
          state: intentFields[2], desiredRunning: Number(intentFields[3]) } : null;
        const sample = { at: now(), state: row?.state ?? null, running: row?.running ?? null,
          desiredRunning: row?.desiredRunning ?? null, runEpoch: row?.runEpoch ?? null,
          connectionEpoch: intent?.connectionEpoch ?? null, intent,
          enginePid: status.engineReadiness?.pid ?? null, engineInstance: status.engineReadiness?.instanceId ?? null,
          recovery: row?.recovery ?? null };
        samples.push(sample);
        if (row?.state === 'recovering' && firstRecoveringAt === null) firstRecoveringAt = Date.now();
        if (Date.now() > faultAt + 500 && firstRunningAt === null && recoveredIsolationSample(sample, identity)) {
          firstRunningAt = Date.now(); newEpoch = sample.connectionEpoch;
        }
      } catch (error) { samples.push({ at: now(), error: error.code || error.message }); }
      if (firstRunningAt !== null) break;
      await new Promise(resolve => setTimeout(resolve, 700));
    }
    const restoreReceipt = path.join(options.out, 'restore-worker.json');
    let restored = null;
    for (let i = 0; i < 20 && !restored; i++) {
      if (fs.existsSync(restoreReceipt)) { try { restored = JSON.parse(fs.readFileSync(restoreReceipt, 'utf8')); } catch { /* wait */ } }
      if (!restored) await new Promise(resolve => setTimeout(resolve, 500));
    }
    let rulesClean = false;
    const remainingText = device(options).rootShell('iptables -S OUTPUT; iptables -S INPUT', 8000);
    rulesClean = !remainingText.split(/\r?\n/).some(line => line.includes(world.ip) && /DROP/.test(line));
    if (!rulesClean) {
      // Backstop only: the independent worker failed. Record it; never claim the
      // independent channel restored the link.
      device(options).rootShell(`iptables -D OUTPUT -d ${world.ip} -p tcp --dport ${world.port} -j DROP 2>/dev/null; `
        + `iptables -D INPUT -s ${world.ip} -p tcp --sport ${world.port} -j DROP 2>/dev/null; echo fallback`, 8000);
      rulesClean = !device(options).rootShell('iptables -S OUTPUT; iptables -S INPUT', 8000).split(/\r?\n/).some(line => line.includes(world.ip) && /DROP/.test(line));
    }
    summary.evidence.restore = { receipt: restored, rulesClean, backstopUsed: restored ? false : true };
    const recoveryMs = firstRunningAt === null ? null : firstRunningAt - faultAt;
    // Isolation: the exact auxiliary account(s) that were connected before the
    // fault must still be running on the same run/connection identity.
    const afterAccounts = await api.request('GET', '/api/local/accounts');
    summary.evidence.otherAccountsAfter = [];
    let otherAccountsUnaffected = true;
    for (const beforeOne of summary.evidence.otherAccounts) {
      const afterOne = (afterAccounts.accounts || []).find(one => one.id === beforeOne.id);
      const afterIntent = device(options).sql(`SELECT run_epoch,connection_epoch,state FROM backend_run_intents
WHERE owner_ref='${beforeOne.ownerRef}' AND account_ref='${beforeOne.accountRef}';`).trim().split('|');
      const after = { id: beforeOne.id, uid: beforeOne.uid, running: afterOne?.running ?? false,
        state: afterOne?.state ?? null, runEpoch: Number(afterIntent[0]), connectionEpoch: Number(afterIntent[1]) };
      summary.evidence.otherAccountsAfter.push(after);
      if (after.running !== true || after.runEpoch !== beforeOne.runEpoch ||
          after.connectionEpoch !== beforeOne.connectionEpoch) otherAccountsUnaffected = false;
    }
    summary.criteria = { startedOrReused: true, addCondition: true, noBusinessSwitches: summary.evidence.businessAllFalse === true,
      heartbeatPhaseBound: true, exactlyOneDrop: applied.length >= 2, independentRestoreReady: Boolean(restoreReady && restoreAlive),
      rulesRemoved: rulesClean, recovered: firstRunningAt !== null, newConnectionEpoch: newEpoch !== null && newEpoch !== identity.connectionEpoch,
      recoveryWithinBound: recoveryMs !== null && recoveryMs <= RECOVERY_BOUND_MS,
      otherAccountsUnaffected };
    summary.recoveryMs = recoveryMs;
    summary.samples = samples;
    summary.pass = Object.values(summary.criteria).every(Boolean);
    write('window.json', summary);
    console.log(JSON.stringify({ pass: summary.pass, criteria: summary.criteria, recoveryMs, faultAt, world, samples: samples.length }, null, 2));
    return summary.pass ? 0 : 2;
  } catch (error) {
    summary.error = { code: error.code || 'ERROR', message: error.message };
    summary.dropped = dropped;
    summary.pass = false;
    if (dropped && world) {
      // The worker owns the restore, but if the window itself failed after the
      // DROP we still verify/recover the exact rules before exiting.
      try {
        device(options).rootShell(`iptables -D OUTPUT -d ${world.ip} -p tcp --dport ${world.port} -j DROP 2>/dev/null; `
          + `iptables -D INPUT -s ${world.ip} -p tcp --sport ${world.port} -j DROP 2>/dev/null; iptables -S OUTPUT | grep -F '${world.ip}' || true`, 8000);
      } catch { /* the independent worker still owns its deadline */ }
    }
    write('window.json', summary);
    console.error(JSON.stringify({ pass: false, code: summary.error.code, message: summary.error.message }, null, 2));
    return 5;
  } finally { await cleanup(); }
}

// P01: one evidence-based appointment window. The fault is NOT applied by this
// process: the device-local guard owns the blocking interval, so the same
// failure that kills the host probe or its adb forward still restores the rules
// and delivers the durable STOP. This process only observes and verifies.
async function p01(options) {
  fs.mkdirSync(options.out, { recursive: true });
  if (fs.existsSync(path.join(options.out, 'window.json'))) {
    console.error(JSON.stringify({ pass: false, code: 'EVIDENCE_EXISTS', message: 'this evidence directory already holds a window.json' }));
    return 4;
  }
  const permit = validatePermit(options);
  const hardMs = Math.min(options.hardEpochMs, Number(permit.expiresAtMs));
  const remaining = () => hardMs - Date.now();
  const summary = { at: now(), mode: 'p01', serial: options.serial, package: options.package,
    accountRef: options.accountRef, uid: options.uid, offlineMs: options.offlineMs, dropLeadMs: options.dropLeadMs,
    hardEpochMs: hardMs, closeEpochMs: options.closeEpochMs, recoveryObserveMs: options.recoveryObserveMs,
    permitExpiresAtMs: Number(permit.expiresAtMs), criteria: {}, evidence: {}, samples: [],
    startedAccount: false, pass: false };
  const writeExclusive = (name, value) => {
    try { fs.writeFileSync(path.join(options.out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); return true; }
    catch { return false; }
  };
  let api = null, guard = null, prepared = null;
  const openApi = () => connectDeviceApi({ adb: ADB, serial: options.serial, packageName: options.package });
  // An adb forward is an independent failure domain from the engine: it can be
  // reset while the engine keeps its port. A dead forward is retried once on a
  // fresh session instead of being reported as an engine failure.
  const reconnectApi = async () => {
    try { api?.close(); } catch { /* forward already gone */ }
    api = null;
    await new Promise(resolve => setTimeout(resolve, 300));
    api = openApi();
    return api;
  };
  const apiRequest = async (method, route, body) => {
    try {
      if (!api) api = openApi();
      return await api.request(method, route, body);
    } catch (error) {
      if (error?.status) throw error;
      await reconnectApi();
      return api.request(method, route, body);
    }
  };
  // One sample is evidence, not a log line: a saturated engine API may fail
  // while the device is healthy, so the durable intent and the native receipts
  // are read from the device itself and API failures are counted separately.
  const counters = { apiFailures: 0, adbFailures: 0 };
  let sampleIdentity = null, observedClockOffsetMs = 0;
  const sample = async label => {
    const row = { at: now(), label, atMs: Date.now(), state: null, running: null, desiredRunning: null,
      runEpoch: null, connectionEpoch: null, retryAtMs: null, intentRetryAtMs: null, lastError: null,
      enginePid: null, engineInstance: null, recovery: null, nativeStop: null,
      projection: null, alarm: null, delivery: null, handling: null };
    try {
      const status = await apiRequest('GET', '/api/local/status');
      const account = (status.accounts || []).find(one => String(one.uid) === options.uid);
      Object.assign(row, { state: account?.state ?? null, running: account?.running ?? null,
        desiredRunning: account?.desiredRunning ?? null, runEpoch: account?.runEpoch ?? null,
        connectionEpoch: account?.connectionEpoch ?? null, retryAtMs: account?.retryAt ? Date.parse(account.retryAt) : null,
        lastError: account?.lastError ?? null, enginePid: status.engineReadiness?.pid ?? null,
        engineInstance: status.engineReadiness?.instanceId ?? null, recovery: account?.recovery ?? null,
        nativeStop: status.nativeStopControl ? { controlSeq: status.nativeStopControl.controlSeq,
          kind: status.nativeStopControl.kind, stopCommitted: status.nativeStopControl.stopCommitted,
          cleanupComplete: status.nativeStopControl.cleanupComplete, commandId: status.nativeStopControl.commandId } : null });
    } catch (error) { counters.apiFailures += 1; row.apiError = error.code || error.message; }
    try {
      row.projection = appReadJson(options, 'data/reconnect-deadlines.json')?.accounts
        ?.find(one => one.accountRef === String(options.accountRef)) ?? null;
      row.alarm = appReadJson(options, 'keepalive-engine.json')?.reconnectAlarm ?? null;
      row.delivery = appReadJson(options, 'keepalive-reconnect-delivery.json');
      row.handling = appReadJson(options, 'keepalive-reconnect-handling.json');
      if (row.projection?.retryAtMs) row.retryAtMs = Number(row.projection.retryAtMs);
      if (sampleIdentity) {
        const intent = device(options).sql(`SELECT state,run_epoch,connection_epoch,retry_at_ms,desired_running
FROM backend_run_intents WHERE owner_ref='${sampleIdentity.ownerRef}' AND account_ref='${options.accountRef}';`).trim().split('|');
        if (intent.length >= 5) {
          row.intent = { state: intent[0], runEpoch: Number(intent[1]), connectionEpoch: Number(intent[2]),
            retryAtMs: intent[3] === '' ? null : Number(intent[3]), desiredRunning: Number(intent[4]) };
          if (row.intent.retryAtMs) row.retryAtMs = row.intent.retryAtMs;
        }
      }
    } catch { counters.adbFailures += 1; row.adbError = 'READ_FAILED'; }
    row.atMs = Date.now(); row.at = new Date(row.atMs).toISOString(); row.deviceAtMs = row.atMs - observedClockOffsetMs;
    return row;
  };
  try {
    const gate = guardianReady(options);
    summary.evidence.guardianGate = gate;
    summary.criteria.guardianReady = gate.ok === true;
    if (!gate.ok) throw Object.assign(new Error('STOP guardian not ready: ' + gate.reason), { code: 'GUARDIAN' });
    api = openApi();
    const ready = await engineReady({ request: apiRequest }, options);
    summary.evidence.engineReady = { ready: ready.ready, problems: ready.problems, pid: ready.pid, instanceId: ready.instanceId };
    summary.criteria.engineReady = ready.ready === true;
    if (!ready.ready) throw Object.assign(new Error('engine is not really ready'), { code: 'READY' });
    if (gate.enginePid && gate.enginePid !== ready.pid) throw Object.assign(new Error('guardian armed for another engine generation'), { code: 'READY' });
    let armedControlSeq = Number(ready.status.nativeStopControl?.controlSeq ?? 0);
    summary.evidence.controlSeqAtReadiness = armedControlSeq;
    summary.evidence.armedGeneration = ready.instanceId;
    let account = (ready.status.accounts || []).find(one => String(one.uid) === options.uid);
    if (!account) throw Object.assign(new Error('assigned account missing'), { code: 'ACCOUNT' });
    // Long fault: nothing else may be connected. Unlike the 12s tuple window,
    // an auxiliary account is not tolerated here: the same app network carries
    // its connection and this fault is not allowed to touch it.
    const accountsFull = await apiRequest('GET', '/api/local/accounts');
    const otherActive = (accountsFull.accounts || []).filter(one => String(one.uid) !== options.uid && (one.running || one.desiredRunning));
    summary.evidence.otherAccounts = otherActive.map(one => ({ id: one.id, uid: one.uid, running: one.running, desiredRunning: one.desiredRunning }));
    summary.criteria.otherAccountsStopped = otherActive.length === 0;
    if (otherActive.length) throw Object.assign(new Error('another account is running or desired; a long fault needs it stopped'), { code: 'ACCOUNT' });
    const config = await apiRequest('GET', `/api/local/accounts/${account.id}/config`);
    const configText = JSON.stringify(config);
    for (const flag of ['plantEnabled', 'harvestEnabled', 'waterEnabled', 'waterwheelEnabled', 'freeWaterEnabled']) {
      if (new RegExp(`"${flag}":true`).test(configText)) throw Object.assign(new Error('business switch is on: ' + flag), { code: 'BUSINESS' });
    }
    if (/"enabled":true/.test(JSON.stringify(config.config?.flowerRack || {}))) throw Object.assign(new Error('flower rack switch is on'), { code: 'BUSINESS' });
    summary.criteria.businessAllFalse = true;
    const originMs = Date.now();
    // Product acceptance uses only the normal account entry. The tool never
    // supplies a native USER_START on its behalf.
    summary.acceptanceMode = 'product-account-start';
    {
      if (options.start === '1' && (account.running || account.state === 'running'))
        throw Object.assign(new Error('account already running before START'), { code: 'ACCOUNT' });
      const receipt = await apiRequest('POST', `/api/local/accounts/${account.id}/start`, { expectedPriorRunEpoch: account.runEpoch });
      summary.startedAccount = true;
      summary.evidence.start = { accepted: receipt.accepted === true, runEpoch: receipt.account?.runEpoch ?? null,
        nativeStartControl: receipt.nativeStartControl ?? null, mode: options.start };
      for (let i = 0; i < 40; i++) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const fresh = await apiRequest('GET', '/api/local/status');
        const current = (fresh.accounts || []).find(one => String(one.uid) === options.uid);
        if (current?.running && current.state === 'running') { account = current; break; }
      }
    }
    if (!account.running || account.state !== 'running') throw Object.assign(new Error('account is not running'), { code: 'ACCOUNT' });
    const afterStartControl = await apiRequest('GET', '/api/local/status');
    const nativeControl = afterStartControl.nativeStopControl;
    armedControlSeq = Number(nativeControl?.controlSeq ?? NaN);
    summary.evidence.accountStartControl = { controlSeq: armedControlSeq, kind: nativeControl?.kind,
      stopCommitted: nativeControl?.stopCommitted, commandId: nativeControl?.commandId };
    summary.criteria.accountStartControlValid = Number.isSafeInteger(armedControlSeq) &&
      nativeControl?.kind === 'USER_START' && nativeControl?.stopCommitted === false &&
      (!summary.startedAccount || armedControlSeq > summary.evidence.controlSeqAtReadiness);
    if (!summary.criteria.accountStartControlValid) throw Object.assign(new Error('normal account START did not establish USER_START; no tool-side native-start workaround'), { code: 'CONTROL' });
    // The native appointment needs a live projection source for this account. A
    // durable STOP keeps it unpublished until the user-start control supersedes
    // it, and a fault without a projection could never be delivered: wait for
    // the document itself (bounded) instead of assuming it is there.
    let projectionReady = null;
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const doc = appReadJson(options, 'data/reconnect-deadlines.json');
      const row = doc?.accounts?.find(one => one.accountRef === String(options.accountRef));
      if (doc && row && row.desiredRunning === true) {
        projectionReady = { at: now(), attempts: attempt, revision: doc.revision, state: row.state, runEpoch: row.runEpoch,
          retryAtMs: row.retryAtMs, controlSeq: doc.controlSeq, controlKind: doc.controlKind, stopCommitted: doc.stopCommitted,
          publisherState: doc.publisherState, authorized: doc.authorized };
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    summary.evidence.projectionReady = projectionReady;
    summary.criteria.projectionSourceLive = Boolean(projectionReady);
    if (!projectionReady) throw Object.assign(new Error('native projection is not live for this account; refusing a fault that could not be delivered'), { code: 'PROJECTION' });
    const identityText = device(options).sql(`SELECT owner_ref,account_ref,subject_ref,run_epoch,connection_epoch FROM backend_run_intents
WHERE owner_ref='${account.ownerRef}' AND account_ref='${options.accountRef}' AND desired_running=1;`).trim();
    const parts = identityText.split('|');
    if (parts.length < 5) throw Object.assign(new Error('current intent identity missing'), { code: 'IDENTITY' });
    const identity = { ownerRef: parts[0], accountRef: parts[1], subjectRef: parts[2], runEpoch: Number(parts[3]), connectionEpoch: Number(parts[4]) };
    summary.evidence.identity = identity;
    sampleIdentity = identity;
    const offset = deviceClockOffset(options);
    observedClockOffsetMs = offset;
    summary.evidence.clockOffsetMs = offset;
    const hbDeadline = Date.now() + Math.min(75000, Math.max(5000, remaining() - options.offlineMs - MIN_RESTORE_HEADROOM_MS));
    let hb = null;
    while (Date.now() < hbDeadline) {
      hb = latestHeartbeat(options, identity);
      if (hb.latest) break;
      await new Promise(resolve => setTimeout(resolve, 6000));
    }
    if (!hb?.latest) throw Object.assign(new Error('no answered usr.heartTick in this connection; refusing a blind fault'), { code: 'PHASE' });
    let dueHost = hostDueMs(hb.latest.receivedDeviceMs + HB_PERIOD_MS, offset);
    for (let i = 0; i < 4 && dueHost - Date.now() < 2000; i++) dueHost += HB_PERIOD_MS;
    if (dueHost - Date.now() > HB_PERIOD_MS * 2) throw Object.assign(new Error('heartbeat phase target is too far ahead'), { code: 'PHASE' });
    const plannedDropAt = dueHost - options.dropLeadMs;
    summary.evidence.heartbeatPhase = { latest: hb.latest, clockOffsetMs: offset, dueHostMs: dueHost, plannedDropAt };
    summary.criteria.heartbeatPhaseBound = true;
    if (plannedDropAt <= Date.now() + MIN_RESTORE_HEADROOM_MS) throw Object.assign(new Error('planned fault leaves no restore headroom'), { code: 'PHASE' });
    const selection = worldSocketForIdentity(options, identity);
    if (!selection.socket) throw Object.assign(new Error('cannot bind one exact world socket: ' + JSON.stringify(selection)), { code: 'SOCKET' });
    summary.evidence.world = { ...selection.socket, selection: selection.source, receiptVerified: selection.receiptVerified,
      candidateSockets: selection.candidates };
    const rulesBefore = device(options).rootShell('iptables -S OUTPUT; iptables -S INPUT', 8000);
    summary.evidence.rulesBefore = rulesBefore;
    if (rulesBefore.includes(selection.socket.ip) && /DROP/.test(rulesBefore.split(/\r?\n/).filter(line => line.includes(selection.socket.ip)).join('\n')))
      throw Object.assign(new Error('target already has a DROP rule'), { code: 'RULES' });
    const restoreDeadline = plannedDropAt + options.offlineMs;
    const closeMs = options.closeEpochMs;
    if (restoreDeadline + options.recoveryObserveMs > closeMs)
      throw Object.assign(new Error('close leaves insufficient recovery-observe-ms after restoring connectivity'), { code: 'BUDGET' });
    summary.evidence.deadlines = { faultStartAtMs: plannedDropAt, restoreAtMs: restoreDeadline, closeAtMs: closeMs,
      hardAtMs: hardMs, recoveryObserveMs: options.recoveryObserveMs };
    const fresh = await apiRequest('GET', '/api/local/status');
    const stop = fresh.nativeStopControl;
    const liveAccount = (fresh.accounts || []).find(one => String(one.uid) === options.uid);
    const freshGate = { latestControlKind: stop?.kind ?? null, stopCommitted: stop?.stopCommitted === true,
      accountStillRunning: Boolean(liveAccount?.running), guardian: guardianReady(options),
      controlSeqMatches: Number(stop?.controlSeq ?? 0) === armedControlSeq,
      permitRemainingMs: Number(permit.expiresAtMs) - Date.now(), budgetRemainingMs: remaining() };
    summary.evidence.freshGate = freshGate;
    summary.criteria.freshGateBeforeFault = freshGate.stopCommitted === false && freshGate.accountStillRunning === true &&
      freshGate.guardian.ok === true && freshGate.controlSeqMatches === true;
    if (!summary.criteria.freshGateBeforeFault) throw Object.assign(new Error('fresh gate failed: ' + JSON.stringify(freshGate)), { code: 'GATE' });
    if (freshGate.permitRemainingMs <= options.offlineMs + MIN_RESTORE_HEADROOM_MS) throw Object.assign(new Error('permit too close to expiry'), { code: 'PERMIT' });
    if (remaining() <= options.offlineMs + MIN_RESTORE_HEADROOM_MS) throw Object.assign(new Error('absolute budget too small'), { code: 'BUDGET' });
    // The independent device guard is armed BEFORE the fault: rules restore and
    // the durable STOP must not depend on this process being alive.
    const windowId = randomUUID(), commandId = options.stopCommandId;
    summary.evidence.windowId = windowId;
    summary.evidence.deviceGuardCommandId = commandId;
    const arm = await armDeviceGuard({ serial: options.serial, args: {
      windowId, commandId, serial: options.serial, accountRef: options.accountRef, ownerRef: identity.ownerRef,
      scan: true, startAtMs: plannedDropAt, deadlineMs: restoreDeadline,
      closeMs, hardMs, clockOffsetMs: offset,
      armedControlSeq, armedGeneration: ready.instanceId } });
    guard = arm;
    summary.evidence.deviceGuardArm = { ok: arm.ok, scriptPath: arm.scriptPath, firstHeartbeatMs: arm.firstHeartbeatMs,
      secondHeartbeatMs: arm.secondHeartbeatMs, state: arm.state?.state, guardPid: arm.state?.guardPid };
    summary.criteria.deviceGuardArmed = arm.ok === true && arm.state?.state === 'armed';
    if (!arm.ok) throw Object.assign(new Error('device-local guard did not prove it is running'), { code: 'GUARD' });
    // Independence proof #1: drop our own adb forward and watch the device-side
    // heartbeat keep moving with the host channel gone.
    try { api?.close(); } catch { /* forward already gone */ }
    api = null;
    const beforeBeat = readGuardState({ serial: options.serial, windowId, hardEpochMs: hardMs }).heartbeatAtMs;
    await new Promise(resolve => setTimeout(resolve, 4000));
    const afterBeat = readGuardState({ serial: options.serial, windowId, hardEpochMs: hardMs }).heartbeatAtMs;
    summary.evidence.independenceWhileForwardClosed = { beforeBeat, afterBeat,
      advanced: Boolean(beforeBeat && afterBeat && afterBeat > beforeBeat), waitMs: 4000 };
    summary.criteria.deviceGuardIndependent = summary.evidence.independenceWhileForwardClosed.advanced === true;
    api = openApi();
    if (!summary.criteria.deviceGuardIndependent) throw Object.assign(new Error('device guard did not advance while the host forward was closed'), { code: 'GUARD' });
    // The host restore worker stays as a second channel; it is not the primary.
    const restoreScript = path.join(root, 'tools', 'coordination-zcode-p01-restore.mjs');
    const restore = spawn(process.execPath, [restoreScript, `--serial=${options.serial}`, `--ip=${selection.socket.ip}`,
      `--port=${selection.socket.port}`, `--deadline-epoch-ms=${restoreDeadline}`,
      `--hard-epoch-ms=${Math.min(hardMs, restoreDeadline + 8000)}`, `--out=${options.out}`],
    { detached: false, stdio: 'ignore', windowsHide: true });
    summary.evidence.hostRestoreWorkerPid = restore.pid;
    while (Date.now() < plannedDropAt - 500) await new Promise(resolve => setTimeout(resolve, Math.min(500, plannedDropAt - Date.now() - 500)));
    // Watch the guard engage the fault; nothing here changes device rules.
    let faultEngaged = null;
    const faultDeadline = Math.min(plannedDropAt + 25000, restoreDeadline - 5000);
    while (Date.now() < faultDeadline) {
      const state = readGuardState({ serial: options.serial, windowId, hardEpochMs: hardMs });
      if (state.state === 'fault-active' && state.rules.length >= 1 && state.blockedEvents.length >= 1) {
        faultEngaged = { at: now(), atMs: Date.now(), state: state.state, rules: state.rules, blockedEvents: state.blockedEvents };
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 700));
    }
    summary.evidence.faultEngaged = faultEngaged;
    summary.criteria.faultApplied = Boolean(faultEngaged);
    if (!faultEngaged) throw Object.assign(new Error('device guard did not block any world socket'), { code: 'FAULT' });
    const blockedTuples = new Set();
    for (const state of [readGuardState({ serial: options.serial, windowId, hardEpochMs: hardMs })]) for (const line of state.blockedEvents) {
      const [, ip, port] = line.trim().split(/\s+/);
      if (ip && port) blockedTuples.add(ip + ':' + port);
    }
    summary.evidence.blockedTuples = [...blockedTuples];
    summary.criteria.faultTargetsObservedSockets = blockedTuples.size >= 1 && [...blockedTuples].every(one => !one.endsWith(':443'));
    // Observe the appointment chain while the device stays blocked. Receipts on
    // the device may be leftovers from an earlier window, so only a timestamp
    // newer than the baseline taken before this fault counts as this window's.
    const receiptBaseline = {
      deliveryReceivedAtMs: Number(appReadJson(options, 'keepalive-reconnect-delivery.json')?.receivedAtMs ?? 0),
      handlingHandledAtMs: Number(appReadJson(options, 'keepalive-reconnect-handling.json')?.handledAtMs ?? 0),
      alarmId: appReadJson(options, 'keepalive-engine.json')?.reconnectAlarm?.id ?? null,
    };
    summary.evidence.receiptBaseline = receiptBaseline;
    const faultStartMs = faultEngaged?.atMs ?? Date.now();
    const observeUntil = Math.min(closeMs - 15000, restoreDeadline + options.recoveryObserveMs);
    let restoredAtMs = null, analysis = null;
    while (Date.now() < observeUntil) {
      const row = await sample('observe');
      summary.samples.push(row);
      const guardState = readGuardState({ serial: options.serial, windowId, hardEpochMs: hardMs });
      if (guardState.rulesClean === 'clean' && guardState.rulesRestoredAtMs)
        restoredAtMs = hostDueMs(guardState.rulesRestoredAtMs, offset);
      analysis = analyzeP01Samples(summary.samples, { initial: { ...identity, generation: ready.instanceId }, faultStartMs,
        clockOffsetMs: offset, receiptBaseline, restoredAtMs });
      if (analysis.selected && analysis.recovered && analysis.liveReread && !analysis.duplicateLiveAlarm) break;
      await new Promise(resolve => setTimeout(resolve, 700));
    }
    analysis ??= analyzeP01Samples(summary.samples, { initial: { ...identity, generation: ready.instanceId }, faultStartMs,
      clockOffsetMs: offset, receiptBaseline, restoredAtMs });
    const { recovered, liveReread, duplicateLiveAlarm } = analysis;
    const selected = analysis.selected || analysis.candidates[0] || {};
    const { futureDeadline = null, alarmScheduled = null, delivery = null, handling = null } = selected;
    summary.evidence.appointmentCandidates = analysis.candidates;
    summary.evidence.selectedDeliveredAppointmentId = analysis.selected?.id ?? null;
    summary.evidence.appointment = { futureDeadline, alarmScheduled, delivery, handling, receiptBaseline };
    summary.evidence.liveReread = liveReread;
    summary.evidence.recovered = recovered;
    summary.evidence.rulesRestoredAtMs = restoredAtMs;
    summary.recoveryMs = recovered && restoredAtMs ? Math.max(0, recovered.atMs - restoredAtMs) : null;
    summary.faultToRecoveredMs = recovered ? recovered.atMs - faultStartMs : null;
    summary.criteria.futureDeadlineCaptured = Boolean(futureDeadline);
    summary.criteria.nativeAppointmentScheduled = Boolean(alarmScheduled && futureDeadline &&
      alarmScheduled.deadlineAtMs === futureDeadline.retryAtMs && alarmScheduled.runEpoch === futureDeadline.runEpoch);
    summary.criteria.deliveryReceived = delivery?.fresh === true && delivery.id === alarmScheduled?.id;
    summary.criteria.handlingReceived = handling?.fresh === true && handling.id === alarmScheduled?.id;
    summary.criteria.liveAppointmentRereadStable = Boolean(liveReread) && !duplicateLiveAlarm;
    summary.criteria.accountRecoveredRunning = recovered?.state === 'running';
    summary.criteria.recoveredOnNewConnectionEpoch = Boolean(recovered?.intent?.connectionEpoch > identity.connectionEpoch);
    summary.criteria.recoveryWithin35s = summary.recoveryMs !== null && summary.recoveryMs <= RECOVERY_BOUND_MS;
    // The formal receiver has id/epoch/generation fields, but no connectionEpoch
    // extra. Replay a real old appointment after a real new-CE recovery; do not
    // describe this as a separate old-CE-field rejection test.
    let oldAppointmentProbe = { attempted: false, reason: 'NO_REAL_RECOVERY_OR_CAPTURED_APPOINTMENT' };
    if (recovered && alarmScheduled && Date.now() + 12000 < closeMs) {
      const beforeRejected = appReadJson(options, 'keepalive-reconnect-rejected.json');
      const probeAtMs = Date.now();
      const command = oldAppointmentBroadcast(options.package, alarmScheduled);
      const output = device(options).rootShell(command, Math.min(8000, closeMs - Date.now() - 1000));
      let rejection = null;
      for (let i = 0; i < 8 && Date.now() + 3000 < closeMs; i++) {
        const current = appReadJson(options, 'keepalive-reconnect-rejected.json');
        if (current?.id === alarmScheduled.id && current.outcome === 'stale-or-cancelled' &&
            Number(current.receivedAtMs) > Number(beforeRejected?.receivedAtMs || 0) &&
            hostDueMs(Number(current.receivedAtMs), offset) >= probeAtMs - 500) { rejection = current; break; }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      const after = await sample('after-old-appointment');
      oldAppointmentProbe = { attempted: true, command, output, probeAtMs, rejection, beforeConnectionEpoch: recovered.intent.connectionEpoch,
        after: { state: after.state, desiredRunning: after.desiredRunning, intent: after.intent, engineInstance: after.engineInstance },
        passed: Boolean(rejection) && after.state === 'running' && after.desiredRunning === true &&
          after.intent?.runEpoch === recovered.intent.runEpoch && after.intent?.connectionEpoch === recovered.intent.connectionEpoch };
    }
    summary.evidence.oldAppointmentProbe = oldAppointmentProbe;
    summary.criteria.oldAppointmentRejectedAfterRecovery = oldAppointmentProbe.passed === true;
    summary.limitations = ['Receiver has no connectionEpoch extra; old appointment id/epoch/generation rejection is tested after new-CE recovery.',
      'recoveryWithin35s is reported separately from the mandatory end-to-end chain.'];
    writeExclusive('recovery-observed.json', { windowId, commandId, closeMs, hardMs,
      observedAt: now(), criteria: summary.criteria, recoveryMs: summary.recoveryMs,
      oldAppointmentProbe, recovered: recovered ? { state: recovered.state, intent: recovered.intent } : null });
    // Recovery observation is complete. The independent guard keeps its own
    // close and must still STOP even if this host disappears now.
    let guardFinal = null;
    const guardDeadline = Math.min(hardMs - 20000, closeMs + 60000);
    while (Date.now() < guardDeadline) {
      const state = readGuardState({ serial: options.serial, windowId, hardEpochMs: hardMs });
      if (state.state === 'done') { guardFinal = state; break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    summary.evidence.guardFinal = guardFinal ? { state: guardFinal.state, rulesClean: guardFinal.rulesClean,
      rulesRestoredAtMs: guardFinal.rulesRestoredAtMs, stopStartedAtMs: guardFinal.stopStartedAtMs,
      stopTrigger: guardFinal.stopTrigger,
      stopPrecheck: guardFinal.stopPrecheck, stopOutcome: guardFinal.stopOutcome, stopVerified: guardFinal.stopVerified,
      events: guardFinal.events.slice(-12) } : null;
    summary.criteria.rulesRestored = guardFinal?.rulesClean === 'clean';
    summary.criteria.deviceLocalStopVerified = ['sent', 'already-committed'].includes(guardFinal?.stopOutcome) && guardFinal?.stopVerified === 'stopped';
    summary.criteria.adbStayedAvailable = counters.adbFailures === 0;
    summary.evidence.sampleCounters = counters;
    // The guardian delivers the formal close STOP as well.
    let finalStop = null;
    for (let i = 0; i < 60; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      try {
        const status = await apiRequest('GET', '/api/local/status');
        const rows = status.accounts || [];
        finalStop = { at: now(), controlSeq: status.nativeStopControl?.controlSeq ?? null,
          stopCommitted: status.nativeStopControl?.stopCommitted === true,
          cleanupComplete: status.nativeStopControl?.cleanupComplete === true,
          allStopped: rows.length > 0 && rows.every(one => one.state === 'stopped' && one.running === false && one.desiredRunning === false),
          accounts: rows.map(({ id, uid, state, running, desiredRunning }) => ({ id, uid, state, running, desiredRunning })),
          runtime: status.runtime ?? null };
        if (finalStop.stopCommitted && finalStop.cleanupComplete && finalStop.allStopped) break;
      } catch (error) { finalStop = { at: now(), error: error.code || error.message }; }
      if (remaining() < 5_000) break;
    }
    summary.evidence.finalStop = finalStop;
    summary.criteria.stopCommitted = finalStop?.stopCommitted === true && finalStop?.cleanupComplete === true;
    summary.criteria.allAccountsStopped = finalStop?.allStopped === true;
    // The alarm may still be the pre-STOP one for a few hundred milliseconds
    // while the engine publishes the cancellation. Wait for that write, bounded,
    // and record how long it took instead of assuming it already happened.
    let cleared = null;
    for (let attempt = 1; attempt <= 25 && remaining() > 20_000; attempt += 1) {
      const row = await sample('post-stop-wait');
      if (!row.retryAtMs && row.alarm?.scheduled !== true) { cleared = { at: row.at, attempts: attempt }; break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    summary.evidence.postStopCleared = cleared;
    // STOP cancellation is a separate assertion from the live appointment reread above.
    const rereadA = await sample('reread-a');
    await new Promise(resolve => setTimeout(resolve, 2500));
    const rereadB = await sample('reread-b');
    summary.evidence.reread = { a: rereadA, b: rereadB };
    summary.criteria.stopCancellationStable = cleared !== null && !rereadA.retryAtMs && !rereadB.retryAtMs &&
      rereadA.alarm?.scheduled !== true && rereadB.alarm?.scheduled !== true;
    // Replaying STOP checks idempotency only; it does not test old appointments.
    let replay = null;
    try {
      replay = await apiRequest('POST', '/api/local/stop-all', { commandId, requestedAtMs: Date.now() });
    } catch (error) { replay = { error: error.code || error.message }; }
    await new Promise(resolve => setTimeout(resolve, 3000));
    const afterReplay = await sample('after-replay');
    summary.evidence.replay = { response: replay, after: { state: afterReplay.state, running: afterReplay.running,
      desiredRunning: afterReplay.desiredRunning, retryAtMs: afterReplay.retryAtMs, controlSeq: afterReplay.nativeStop?.controlSeq ?? null } };
    summary.criteria.oldStopCommandSuperseded = replay?.superseded === true;
    summary.criteria.oldStopCommandIdempotent = replay?.stopCommitted === true && replay?.cleanupComplete === true;
    summary.criteria.oldStopCommandDoesNotRevive = afterReplay.running !== true && afterReplay.desiredRunning !== true && !afterReplay.retryAtMs;
    summary.evidence.engineGenerationStable = afterReplay.enginePid === ready.pid && afterReplay.engineInstance === ready.instanceId;
    const required = P01_REQUIRED;
    summary.required = required;
    summary.missing = required.filter(key => summary.criteria[key] !== true);
    summary.pass = summary.missing.length === 0;
    summary.completedAt = now();
    if (!writeExclusive('window.json', summary)) throw Object.assign(new Error('window.json already present'), { code: 'EVIDENCE_EXISTS' });
    console.log(JSON.stringify({ pass: summary.pass, criteria: summary.criteria, missing: summary.missing,
      appointment: summary.evidence.appointment, finalStop, guard: summary.evidence.guardFinal,
      world: summary.evidence.world, fault: summary.evidence.faultEngaged, samples: summary.samples.length }, null, 1));
    return summary.pass ? 0 : 2;
  } catch (error) {
    summary.error = { code: error.code || 'ERROR', message: error.message };
    summary.pass = false;
    summary.completedAt = now();
    // A failed window still owes the device: ask the armed guard to run early.
    if (guard?.state?.state === 'armed') {
      try {
        await armRunEarly({ serial: options.serial, windowId: summary.evidence.windowId });
        summary.evidence.earlyGuardRequested = true;
      } catch (error2) { summary.evidence.earlyGuardRequested = false; summary.evidence.earlyGuardError = error2.message; }
    }
    writeExclusive('window.json', summary);
    console.error(JSON.stringify({ pass: false, code: summary.error.code, message: summary.error.message }, null, 2));
    return 5;
  } finally {
    try { api?.close(); } catch { /* best effort */ }
  }
}

// The guard reads STOP files only through its own deadline; an early request is
// written to the device so a failed host does not leave the fault running.
async function armRunEarly({ serial, windowId }) {
  execFileSync(ADB, ['-s', serial, 'shell', `su -c 'echo early > /data/local/tmp/r8z-b3/${windowId}/STOP_NOW'`],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
}

export async function main(argv) {
  let options;
  try { options = parseArgs(argv); }
  catch (error) { console.error(JSON.stringify({ code: error.code || 'ARGS', message: error.message })); return 4; }
  if (options.mode === 'selftest') return selftest();
  return options.mode === 'probe' ? probe(options) : options.mode === 'p01' ? p01(options) : window(options);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('coordination-zcode-p01-window.mjs')) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
