// Independent timed STOP guardian. Derived narrowly from the proven
// .runtime/validation/keepalive-independent-20261031-T00-takeover-run01/guardian.mjs.
//
// Two roles, two processes, because one Node loop cannot promise a prompt STOP: every adb call is
// execFileSync and blocks that loop for up to its timeout. Sampling therefore lives in its own
// process (`--role=sampler`) and the STOP timer lives in this one (`--role=guardian`), which does no
// work at all between readiness and close except a cheap timer and a file-existence check.
//
// Contract:
//  - explicit --serial --package --out --origin --close --hard --role --label; the window must
//    satisfy origin < close < hard, close-origin <=15min and hard-origin <=17min;
//    a future origin, expired hard or close that already passed is refused (exit 4)
//  - ready means a real engine identity from the live status response only: buildId,
//    engineReadiness.ready/phase, a positive engine pid, an instance id, that pid running as
//    <package>:engine, and a matching keepalive heartbeat. A missing field is never filled from a
//    cache, and a file merely existing is never ready.
//  - one commandId (UUID) is reused by every durable STOP retry; each attempt is bounded by the
//    time actually left before hard, and no attempt starts when the remainder is too small
//  - only stopCommitted AND cleanupComplete AND every account stopped with desiredRunning false
//    ends successfully (exit 0); unverified ends exit 2 and never claims success.
//    Optional --expect-uids=<uid,...> / --expect-owner=<ownerRef> / --min-control-seq=<n> bind the
//    verification to the accounts this run owns: a missing expected account, a stopped-looking run
//    whose control is superseded or whose pending count is non-zero, or a foreign account still
//    running all end exit 2 instead of a clean stop.
//  - reasons are reported as they happened: close, hard-backstop, early-stop-file, uncaught; an
//    early or abnormal trigger is never relabelled as the fixed close
//  - exit 3 when readiness never became real; this process opens no window and sends no STOP, and
//    the controller must not start accounts on a non-ready guardian
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { connectDeviceApi } from './device-local-api.mjs';

const ADB = 'C:/leidian/LDPlayer14/adb.exe';
const SELF_PATH = fileURLToPath(import.meta.url);
const READY_BUDGET_MS = 60_000;
const STOP_RETRY_MS = 3_000;
const MIN_ATTEMPT_MS = 4_000;
const ATTEMPT_BUDGET_MS = 15_000;
const HEARTBEAT_MAX_AGE_MS = 30_000;

const positiveInt = (value, fallback, min, max) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

export function parseArgs(argv) {
  const out = Object.fromEntries(argv.map(entry => {
    const [key, ...rest] = entry.replace(/^--/, '').split('=');
    return [key, rest.join('=')];
  }));
  const need = ['serial', 'package', 'out', 'origin', 'close', 'hard'];
  const missing = need.filter(k => !out[k]);
  if (missing.length) throw Object.assign(new Error('missing args: ' + missing.join(',')), { code: 'ARGS' });
  if (!['emulator-5554', 'emulator-5556', 'emulator-5558'].includes(out.serial)
    || !['online.ainiannian.wujinxia', 'online.ainiannian.garden'].includes(out.package)) {
    throw Object.assign(new Error('serial/package outside this project'), { code: 'ARGS' });
  }
  const origin = Date.parse(out.origin), close = Date.parse(out.close), hard = Date.parse(out.hard);
  if (![origin, close, hard].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw Object.assign(new Error('origin/close/hard must be ISO timestamps'), { code: 'WINDOW' });
  }
  if (!(origin < close && close < hard) || close - origin > 15 * 60_000 || hard - origin > 17 * 60_000) {
    throw Object.assign(new Error('window requires origin < close < hard, close within 15 minutes and hard within 17 minutes'), { code: 'WINDOW' });
  }
  if (origin > Date.now() || hard <= Date.now()) throw Object.assign(new Error('origin is in the future or hard already passed'), { code: 'WINDOW' });
  if (out.role && !['guardian', 'sampler', 'stop-worker'].includes(out.role)) throw Object.assign(new Error('Invalid role'), { code: 'ARGS' });
  const role = out.role === 'sampler' ? 'sampler' : out.role === 'stop-worker' ? 'stop-worker' : 'guardian';
  // The STOP worker is spawned by an already-armed guardian at/after close by design, so only the
  // arming roles refuse a window whose close has passed.
  if (role !== 'stop-worker' && Date.now() > close) throw Object.assign(new Error('close already passed; refusing to arm a late window'), { code: 'WINDOW' });
  return {
    ...out, role, originMs: origin, closeMs: close, hardMs: hard,
    label: out.label || role,
    loopMs: positiveInt(out.loopMs, 5000, 500, 60_000),
    commandId: out['command-id'] || '',
    attemptId: out['attempt-id'] || '',
    resultFile: out['result-file'] || '',
    // Exact binding for the accounts this run is responsible for. A run that
    // cannot name them cannot prove the stop it reports.
    expectUids: (out['expect-uids'] || '').split(',').map(one => one.trim()).filter(Boolean),
    expectOwner: out['expect-owner'] || '',
    minControlSeq: positiveInt(out['min-control-seq'], 0, 0, 2 ** 40),
  };
}

/** One external operation is bounded so no attempt can cross the hard boundary. */
async function withBudget(ms, work) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('BUDGET_EXCEEDED'), { code: 'BUDGET_EXCEEDED' })), Math.max(1, ms));
  });
  try { return await Promise.race([work(), timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

export function createGuardian(options) {
  const { serial, package: pkg, out: outDir, originMs, closeMs, hardMs, label, loopMs, role } = options;
  // One UUID for the whole run: the closure and the returned object must be the same value.
  const commandId = options.commandId || randomUUID();
  fs.mkdirSync(outDir, { recursive: true });
  const logPath = path.join(outDir, `guardian-${label}.jsonl`);
  const receiptPath = path.join(outDir, `guardian-${label}-stop.json`);
  const earlyStopFile = path.join(outDir, `STOP_NOW-${label}`);
  // The watchdog is keyed on success only: a failure receipt does not excuse a still-alive worker.
  const successMarkerPath = path.join(outDir, `guardian-${label}-verified.json`);
  const workerPidFile = path.join(outDir, `stop-worker-pids-${label}.txt`);
  const log = entry => fs.appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  const adb = (args, timeout = 15000) => execFileSync(ADB, ['-s', serial, ...args], { encoding: 'utf8', timeout, windowsHide: true }).trim();
  const openApi = () => connectDeviceApi({ adb: ADB, serial, packageName: pkg });
  const compact = status => ({
    buildId: status?.buildId || null,
    engine: status?.engineReadiness ? { pid: status.engineReadiness.pid, phase: status.engineReadiness.phase, instanceId: status.engineReadiness.instanceId } : null,
    runtime: status?.runtime || null,
    accounts: (status?.accounts || []).map(({ id, uid, state, running, desiredRunning }) => ({ id, uid, state, running, desiredRunning })),
  });

  async function waitReady() {
    const deadline = Math.min(Date.now() + READY_BUDGET_MS, closeMs);
    let last = null;
    let baselineElapsed = null, previousElapsed = null, advanced = false;
    // Measured cadence on a real idle engine is ~15s for both heartbeat files, so a window shorter
    // than one cadence cannot observe an advance; longer windows must still prove it moves.
    const requireAdvance = closeMs - Date.now() >= 60_000;
    while (Date.now() < deadline) {
      let api = null;
      try {
        const remaining = Math.max(MIN_ATTEMPT_MS, deadline - Date.now());
        const measured = await withBudget(Math.min(remaining, ATTEMPT_BUDGET_MS), async () => {
          api = openApi();
          const status = await api.request('GET', '/api/local/status');
          const engine = status && status.engineReadiness;
          const problems = [];
          if (!status || !status.buildId) problems.push('NO_BUILD_ID');
          if (!engine) problems.push('NO_ENGINE_READINESS');
          if (engine && (engine.ready !== true || engine.phase !== 'ready')) problems.push('ENGINE_NOT_READY');
          if (engine && !(Number(engine.pid) > 0)) problems.push('NO_ENGINE_PID');
          if (engine && !/^[0-9a-f-]{36}$/.test(String(engine.instanceId || ''))) problems.push('NO_INSTANCE_ID');
          if (!problems.length) {
            const line = adb(['shell', 'ps', '-A']).split(/\r?\n/).find(one => one.includes(`${pkg}:engine`));
            const psPid = line ? Number(line.trim().split(/\s+/)[1]) : 0;
            if (!psPid) problems.push('NO_ENGINE_PROCESS');
            else if (psPid !== Number(engine.pid)) problems.push('ENGINE_PID_MISMATCH');
          }
          let age = 0, elapsed = 0;
          if (!problems.length) {
            const beat = JSON.parse(adb(['shell', `run-as ${pkg} cat files/keepalive-engine.json`]));
            age = Date.now() - Number(beat.at || 0);
            elapsed = Number(beat.atElapsed || 0);
            if (!(beat.pid > 0) || Number(beat.pid) !== Number(engine.pid)) problems.push('HEARTBEAT_PID_MISMATCH');
            if (beat.generation !== engine.instanceId) problems.push('HEARTBEAT_GENERATION_MISMATCH');
            if (beat.state !== 'running') problems.push('HEARTBEAT_NOT_RUNNING');
            if (!(age >= -HEARTBEAT_MAX_AGE_MS && age <= HEARTBEAT_MAX_AGE_MS)) problems.push('HEARTBEAT_STALE');
            if (baselineElapsed === null) baselineElapsed = elapsed;
            if (previousElapsed !== null && elapsed < previousElapsed) problems.push('HEARTBEAT_WENT_BACKWARDS');
            if (elapsed > baselineElapsed) advanced = true;
            previousElapsed = elapsed;
            if (requireAdvance && !advanced) problems.push('HEARTBEAT_NOT_ADVANCING');
          }
          return { status, engine, problems, age, elapsed };
        });
        if (api) { try { api.close(); api = null; } catch { /* best effort */ } }
        if (!measured.problems.length) {
          log({ phase: 'ready', role, ...compact(measured.status), enginePid: measured.engine.pid, heartbeatAgeMs: measured.age, heartbeatAdvanced: advanced, advanceRequired: requireAdvance, heartbeatElapsed: [baselineElapsed, measured.elapsed] });
          return { status: measured.status, enginePid: Number(measured.engine.pid), instanceId: measured.engine.instanceId };
        }
        last = measured.problems;
        log({ phase: 'not-ready', role, problems: measured.problems, ...compact(measured.status) });
      } catch (error) {
        if (api) { try { api.close(); } catch { /* best effort */ } }
        last = [error.code || error.message];
        log({ phase: 'ready-error', role, code: error.code || error.message });
      }
      if (Date.now() + MIN_ATTEMPT_MS >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(2000, Math.max(0, deadline - Date.now()))));
    }
    log({ phase: 'ready-timeout', role, problems: last });
    return null;
  }

  const NL = String.fromCharCode(10);
  const writeText = (target, value) => fs.writeFileSync(target, value + NL);

  /** One real child process per attempt, so a budget breach is an actual kill, not a lost race. */
  async function runStopChild({ attemptId, resultFile, budget }) {
    const child = spawn(process.execPath, [SELF_PATH,
      '--role=stop-worker', `--serial=${serial}`, `--package=${pkg}`, `--out=${outDir}`,
      `--origin=${new Date(originMs).toISOString()}`, `--close=${new Date(closeMs).toISOString()}`,
      `--hard=${new Date(hardMs).toISOString()}`, `--label=${label}`,
      `--command-id=${commandId}`, `--attempt-id=${attemptId}`, `--result-file=${resultFile}`,
      ...(options.expectUids?.length ? [`--expect-uids=${options.expectUids.join(',')}`] : []),
      ...(options.expectOwner ? [`--expect-owner=${options.expectOwner}`] : []),
      ...(options.minControlSeq ? [`--min-control-seq=${options.minControlSeq}`] : []),
    ], { stdio: 'ignore', windowsHide: true });
    try { fs.appendFileSync(workerPidFile, String(child.pid) + NL); } catch { /* best effort */ }
    let exitCode = null;
    const exited = new Promise(resolve => child.on('exit', code => { exitCode = code; resolve({ code }); }));
    const outcome = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve({ killed: true }), Math.max(1, budget)))]);
    if (outcome.killed) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      // Give a zombie a moment so its late write cannot be read as a completed attempt.
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1000))]);
      return 'killed';
    }
    return { code: exitCode };
  }

  /** Durable STOP. Every attempt is bounded by the time left before hard; a late success is refused. */
  async function fireStop(reason) {
    let result = null, verified = null, attempt = 0, budgetStop = false;
    while (Date.now() < hardMs) {
      const remaining = hardMs - Date.now();
      if (remaining < MIN_ATTEMPT_MS) { budgetStop = true; log({ phase: 'stop-budget-exhausted', reason, attempt, remainingMs: remaining }); break; }
      attempt += 1;
      const attemptId = `${attempt}-${Date.now()}`;
      const resultFile = path.join(outDir, `stop-attempt-${label}-${attemptId}.json`);
      const budget = Math.min(remaining, ATTEMPT_BUDGET_MS);
      const outcome = await runStopChild({ attemptId, resultFile, budget });
      if (outcome === 'killed') {
        log({ phase: 'stop-attempt-killed', reason, attempt, budgetMs: budget, remainingMs: hardMs - Date.now() });
      } else {
        let measured = null;
        try { measured = JSON.parse(fs.readFileSync(resultFile, 'utf8')); }
        catch (error) { log({ phase: 'stop-result-unreadable', reason, attempt, code: error.code || error.message }); }
        if (measured) {
          result = measured.result || null;
          log({
            phase: 'stop-attempt', reason, attempt, commandId, workerExitCode: outcome.code,
            stopCommitted: result && result.stopCommitted, cleanupComplete: result && result.cleanupComplete,
            controlSeq: result && result.controlSeq, superseded: result && result.superseded, pending: result && result.pending,
            remainingMs: hardMs - Date.now(),
          });
          if (measured.verified && Date.now() <= hardMs) {
            verified = measured.verified;
            log({ phase: 'stop-verify', ...verified });
            if (verified.allStopped) {
              const stoppedAt = new Date().toISOString();
              writeText(receiptPath, JSON.stringify({ commandId, label, role, reason, originMs, closeMs, hardMs, attempts: attempt, verifiedStop: true, result, verified, stoppedAt }, null, 2));
              writeText(successMarkerPath, JSON.stringify({ commandId, label, stoppedAt }));
              return { ok: true, commandId, result, verified };
            }
          } else if (measured.verified) {
            log({ phase: 'late-success-refused', reason, attempt, verifiedAtMs: Date.now(), hardMs });
          }
        }
      }
      const wait = Math.min(STOP_RETRY_MS, Math.max(0, hardMs - Date.now() - MIN_ATTEMPT_MS));
      if (wait <= 0) { budgetStop = true; break; }
      await new Promise(resolve => setTimeout(resolve, wait));
    }
    writeText(receiptPath, JSON.stringify({ commandId, label, role, reason, originMs, closeMs, hardMs, attempts: attempt, verifiedStop: false, budgetStopped: budgetStop, result, verified, stoppedAt: new Date().toISOString() }, null, 2));
    return { ok: false, commandId, result, verified, budgetStop };
  }

  return { serial, pkg, outDir, originMs, closeMs, hardMs, label, loopMs, role, commandId, log, waitReady, fireStop, earlyStopFile, successMarkerPath, workerPidFile };
}

/** Sampling only: no STOP, bounded sleep, exits at close. Runs in its own process. */
export async function runSampler(options) {
  const guardian = createGuardian(options);
  const { log, loopMs, closeMs } = guardian;
  log({ phase: 'sampler-start', loopMs, closeAt: new Date(closeMs).toISOString() });
  let api = null;
  try {
    api = connectDeviceApi({ adb: ADB, serial: options.serial, packageName: options.package });
    while (Date.now() < closeMs) {
      await new Promise(resolve => setTimeout(resolve, Math.max(500, Math.min(loopMs, closeMs - Date.now()))));
      if (Date.now() >= closeMs) break;
      try {
        const status = await withBudget(ATTEMPT_BUDGET_MS, () => api.request('GET', '/api/local/status'));
        log({ phase: 'sample', buildId: status?.buildId ?? null, runtime: status?.runtime ?? null });
      } catch (error) {
        log({ phase: 'sample-error', code: error.code || error.message });
        try { api.close(); } catch { /* reconnect below */ }
        try { api = connectDeviceApi({ adb: ADB, serial: options.serial, packageName: options.package }); }
        catch (error2) { log({ phase: 'reconnect-error', code: error2.code || error2.message }); }
      }
    }
  } catch (error) {
    log({ phase: 'sampler-crash', code: error.code || error.message });
  } finally {
    try { api?.close(); } catch { /* best effort */ }
  }
  log({ phase: 'sampler-done' });
  return { exitCode: 0 };
}

/** STOP timer only. No sampling and no adb work between readiness and close. */
export async function runGuardian(options) {
  const guardian = createGuardian(options);
  const { log, closeMs, hardMs } = guardian;
  let fired = null;
  let resolveStop = () => { };
  // The STOP is only ever triggered by a timer or the early-stop file, never by reaching this line.
  const stopCompleted = new Promise(resolve => { resolveStop = resolve; });
  const fire = reason => {
    if (!fired) {
      fired = guardian.fireStop(reason)
        .catch(error => { log({ phase: 'stop-channel-crash', code: error.code || error.message }); return { ok: false, reason }; })
        .then(result => { resolveStop(result); return result; });
    }
    return fired;
  };

  const ready = await guardian.waitReady();
  if (!ready) {
    fs.writeFileSync(path.join(options.out, `guardian-${options.label}-stop.json`), JSON.stringify({ label: options.label, role: 'guardian', readyAt: null, verifiedStop: false, reason: 'not-ready' }, null, 2) + '\n');
    return { exitCode: 3 };
  }

  // Keyed on success only: a failure receipt does not excuse a still-alive worker. At absolute hard
  // the watchdog kills leftover stop workers and, unless this run really verified, this guardian too.
  const successMarker = guardian.successMarkerPath;
  const workerPids = guardian.workerPidFile;
  try { fs.unlinkSync(successMarker); } catch { /* no stale marker may excuse a kill */ }
  try { fs.writeFileSync(workerPids, ''); } catch { /* best effort */ }
  try {
    const watchdog = `const fs=require('node:fs');const [marker,pids,pid,ms]=process.argv.slice(1);` +
      `setTimeout(()=>{const ok=fs.existsSync(marker);let list=[];` +
      `try{list=fs.readFileSync(pids,'utf8').split(String.fromCharCode(10)).filter(Boolean).map(Number)}catch(e){}` +
      `for(const p of list){if(p&&p!==Number(pid)){try{process.kill(p)}catch(e){}}}` +
      `if(!ok){try{process.kill(Number(pid))}catch(e){}}},Number(ms));`;
    spawn(process.execPath, ['-e', watchdog, successMarker, workerPids, String(process.pid), String(Math.max(0, hardMs - Date.now() + 1000))],
      { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    log({ phase: 'watchdog-armed', successMarker, workerPids, killAtMs: hardMs + 1000 });
  } catch (error) {
    log({ phase: 'watchdog-failed', code: error.code || error.message });
  }

  // From here to close this process does nothing but wait on cheap timers.
  const closeTimer = setTimeout(() => { void fire('close'); }, Math.max(0, closeMs - Date.now()));
  const hardTimer = setTimeout(() => { void fire('hard-backstop'); }, Math.max(0, hardMs - Date.now() - 500));
  const earlyTimer = setInterval(() => { if (fs.existsSync(guardian.earlyStopFile)) void fire('early-stop-file'); }, 500);
  // A real independent hard exit: nothing may keep this process alive past hard.
  const hardExit = setTimeout(() => {
    log({ phase: 'hard-exit', verified: false });
    try { fs.writeFileSync(path.join(options.out, `guardian-${options.label}-hard-exit.json`), JSON.stringify({ label: options.label, at: new Date().toISOString(), verifiedStop: false }, null, 2) + '\n'); } catch { /* best effort */ }
    process.exit(2);
  }, Math.max(0, hardMs - Date.now() + 1000));

  const stop = await stopCompleted;
  clearTimeout(closeTimer); clearTimeout(hardTimer); clearInterval(earlyTimer); clearTimeout(hardExit);
  if (!stop || stop.ok !== true) {
    log({ phase: 'done', verifiedStop: false, reason: stop && stop.reason });
    return { exitCode: 2, stop };
  }
  log({ phase: 'done', verifiedStop: true, commandId: guardian.commandId });
  return { exitCode: 0, stop };
}

/** One STOP attempt in its own process. The parent may kill it; a killed worker proves nothing. */
export async function runStopWorker(options) {
  const NL = String.fromCharCode(10);
  const payload = {
    attemptId: options.attemptId || '', commandId: options.commandId || '',
    startedAt: new Date().toISOString(), ok: false, result: null, verified: null, error: null,
  };
  let api = null;
  try {
    api = connectDeviceApi({ adb: ADB, serial: options.serial, packageName: options.package });
    const response = await api.request('POST', '/api/local/stop-all', { commandId: options.commandId, requestedAtMs: Date.now() });
    payload.result = response;
    if (response && response.stopCommitted === true && response.cleanupComplete === true) {
      const status = await api.request('GET', '/api/local/status');
      const rows = status.accounts || [];
      // Exact binding: the STOP must be the newest control (not superseded), no
      // operation may still be pending, and every account this run owns must be
      // present and stopped. An account that is simply absent is not a pass.
      const problems = [];
      if (response.superseded === true) problems.push('STOP_SUPERSEDED');
      if (response.pending !== 0) problems.push('PENDING_NOT_ZERO');
      if (options.minControlSeq && !(Number(response.controlSeq) >= options.minControlSeq)) problems.push('CONTROL_SEQ_BEHIND');
      const expectedUids = Array.isArray(options.expectUids) ? options.expectUids : [];
      if (expectedUids.length) {
        for (const uid of expectedUids) {
          const row = rows.find(entry => String(entry.uid || '') === uid);
          if (!row) { problems.push('EXPECTED_ACCOUNT_MISSING:' + uid); continue; }
          if (row.state !== 'stopped' || row.running !== false || row.desiredRunning !== false)
            problems.push('EXPECTED_ACCOUNT_NOT_STOPPED:' + uid);
        }
        for (const row of rows)
          if (!expectedUids.includes(String(row.uid || '')) && (row.running === true || row.desiredRunning === true))
            problems.push('FOREIGN_ACCOUNT_RUNNING:' + (row.uid || row.id));
      }
      const ownerRef = typeof status.ownerRef === 'string' ? status.ownerRef : '';
      // /status does not publish ownerRef; the health document is the authority
      // for the current owner, so an owner binding is checked against it.
      if (options.expectOwner && !ownerRef) {
        try {
          const health = await api.request('GET', '/api/local/health');
          if (typeof health?.ownerRef === 'string' && health.ownerRef !== options.expectOwner) problems.push('OWNER_MISMATCH');
          else if (typeof health?.ownerRef !== 'string') problems.push('OWNER_UNAVAILABLE');
        } catch (error) { problems.push('OWNER_UNAVAILABLE:' + (error.code || 'HEALTH_FAILED')); }
      } else if (options.expectOwner && ownerRef !== options.expectOwner) problems.push('OWNER_MISMATCH');
      payload.verified = {
        allStopped: problems.length === 0 && rows.length > 0
          && rows.every(a => a.state === 'stopped' && a.running === false && a.desiredRunning === false),
        problems,
        binding: { expectUids: expectedUids, expectOwnerProvided: Boolean(options.expectOwner),
          minControlSeq: options.minControlSeq || 0, controlSeq: response.controlSeq ?? null,
          superseded: response.superseded === true, pending: response.pending ?? null, ownerRef: ownerRef || null },
        accounts: rows.map(({ id, uid, state, running, desiredRunning }) => ({ id, uid, state, running, desiredRunning })),
        runtime: status.runtime || null,
      };
    }
    payload.ok = true;
  } catch (error) {
    payload.error = error.code || error.message;
  } finally {
    try { api?.close(); } catch { /* best effort */ }
    payload.finishedAt = new Date().toISOString();
    if (options.resultFile) {
      try { fs.writeFileSync(options.resultFile, JSON.stringify(payload, null, 2) + NL); }
      catch { /* the parent will treat a missing result as unreadable, never as success */ }
    }
  }
  return { exitCode: payload.ok ? 0 : 2 };
}

export async function main(argv) {
  let options;
  try { options = parseArgs(argv); }
  catch (error) { console.error(JSON.stringify({ phase: 'window-rejected', code: error.code || 'ARGS', message: error.message })); return 4; }
  const result = options.role === 'sampler' ? await runSampler(options)
    : options.role === 'stop-worker' ? await runStopWorker(options)
    : await runGuardian(options);
  return result.exitCode;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('coordination-zcode-stop-guardian.mjs')) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
