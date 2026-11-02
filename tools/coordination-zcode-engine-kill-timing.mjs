// Bounded SIGKILL recovery timing probe.
//
// The prior probe read files/engine-session.json once and reused that ADB
// forward for the whole window. EngineService.launchEngine() picks a fresh
// ServerSocket(0) port and a fresh token on every start, so after a SIGKILL the
// cached forward points at a closed port and "ready" can never be observed even
// when the engine already recovered. This probe therefore re-reads the session
// file, rebuilds the forward when the port changes, and stamps every phase
// against one kill event, one generation and a monotonic clock.
//
// Phases recorded (all relative to the kill):
//   kill                       confirmed kill issued by this process
//   process_new                first sample with a live <package>:engine pid != old pid
//   session_new                first sample whose session file names that new pid
//   forward                    first forward created for the new session port
//   http_listen                first HTTP answer from the new port (any status)
//   api_ready                  first /api/local/status with engineReadiness.ready and pid
//   account_running            first status where the target account is running
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ADB = process.env.GARDEN_ANDROID_ADB || 'C:/leidian/LDPlayer14/adb.exe';
const PACKAGE = 'online.ainiannian.wujinxia';

export function parseArgs(argv) {
  const out = {};
  for (const entry of argv) {
    const [key, ...rest] = entry.replace(/^--/, '').split('=');
    out[key] = rest.length ? rest.join('=') : true;
  }
  return out;
}

function adb(serial, args, timeout = 15000) {
  return execFileSync(ADB, ['-s', serial, ...args], { encoding: 'utf8', timeout, windowsHide: true });
}

function shell(serial, command, timeout = 15000) {
  return adb(serial, ['shell', command], timeout);
}

function parseSamples(raw) {
  const [psPart, ...rest] = raw.split('---SESSION---');
  const [sessionPart, ...stateParts] = rest.join('---SESSION---').split('---STATE---');
  const statePart = stateParts.join('---STATE---');
  let pid = null;
  for (const line of psPart.split(/\r?\n/)) {
    if (!line.includes(PACKAGE + ':engine')) continue;
    const cols = line.trim().split(/\s+/);
    const candidate = Number(cols[1]);
    if (Number.isInteger(candidate) && candidate > 0) pid = candidate;
  }
  const json = text => {
    const trimmed = (text || '').trim();
    if (!trimmed) return null;
    try { return JSON.parse(trimmed.slice(trimmed.indexOf('{'))); } catch { return null; }
  };
  return { pid, session: json(sessionPart), engineState: json(statePart) };
}

function readProbe(serial) {
  const raw = shell(serial,
    `ps -A | grep ${PACKAGE}:engine ; echo "---SESSION---" ; run-as ${PACKAGE} cat files/engine-session.json 2>/dev/null ; echo ; echo "---STATE---" ; run-as ${PACKAGE} cat files/keepalive-engine.json 2>/dev/null ; echo`);
  return parseSamples(raw);
}

async function httpStatus(localPort, token, timeoutMs = 2500) {
  try {
    const response = await fetch('http://127.0.0.1:' + localPort + '/api/local/status',
      { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json().catch(() => null);
    return { answered: true, status: response.status, body };
  } catch (error) { return { answered: false, error: String(error?.name || error).slice(0, 80) }; }
}

const mono = () => Number(process.hrtime.bigint()) / 1e6;

export async function main(argv) {
  const options = parseArgs(argv);
  const serial = String(options.serial || 'emulator-5558');
  const accountId = Number(options.account || 3);
  const outFile = String(options.out || `.runtime/validation/r8-zcode-b2/kill-timing-${Date.now()}.json`);
  const timeoutMs = Number(options.timeout || 120000);
  const pollMs = Number(options.poll || 250);
  const allowKill = options.kill === true || options.kill === 'true';
  if (!Number.isInteger(accountId) || accountId < 1) throw new Error('--account must be a positive integer');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const out = { at: new Date().toISOString(), serial, accountId, phases: {}, samples: [], forwards: [] };
  const mark = (name) => {
    if (out.phases[name]) return false;
    out.phases[name] = { tMs: Math.round(mono() - out.killMono), at: new Date().toISOString() };
    return true;
  };
  let forwardPort = null, forwardDevicePort = null;
  const ensureForward = (devicePort) => {
    if (!Number.isInteger(devicePort)) return null;
    if (devicePort === forwardDevicePort && forwardPort) return forwardPort;
    if (forwardPort) { try { adb(serial, ['forward', '--remove', 'tcp:' + forwardPort]); } catch { /* stale forward */ } }
    const local = adb(serial, ['forward', 'tcp:0', 'tcp:' + devicePort]).trim();
    if (!/^\d+$/.test(local)) throw new Error('forward failed for device port ' + devicePort);
    forwardPort = Number(local); forwardDevicePort = devicePort;
    out.forwards.push({ localPort: forwardPort, devicePort, atMs: Math.round(mono() - (out.killMono || mono())) });
    return forwardPort;
  };
  try {
    // 1. Preconditions: a real ready engine and a running target account.
    const before = await new Promise((resolve, reject) => {
      const deadline = Date.now() + 60000;
      const tick = async () => {
        try {
          const probe = readProbe(serial);
          const port = ensureForward(probe.session?.port);
          if (port && probe.session?.token) {
            const answer = await httpStatus(port, probe.session.token);
            if (answer.answered && answer.body?.engineReadiness?.ready) return resolve({ probe, status: answer.body });
          }
        } catch { /* keep waiting for readiness */ }
        if (Date.now() > deadline) return reject(new Error('engine never became ready before the window'));
        setTimeout(tick, 500);
      };
      tick();
    });
    const oldPid = before.status.engineReadiness.pid;
    const accountBefore = (before.status.accounts || []).find(one => one.id === accountId);
    out.before = { enginePid: oldPid, instanceId: before.status.engineReadiness.instanceId,
      session: { port: before.probe.session?.port ?? null, pid: before.probe.session?.pid ?? null,
        processGeneration: before.probe.session?.processGeneration ?? null },
      account: accountBefore ? { state: accountBefore.state, running: accountBefore.running,
        runEpoch: accountBefore.runEpoch, connectionEpoch: accountBefore.connectionEpoch } : null };
    if (!(accountBefore?.running && accountBefore?.state === 'running')) throw new Error('target account is not running; refusing to time a kill without a real session');
    if (!allowKill) throw new Error('--kill=true is required: this probe terminates the real engine process');

    // 2. Kill and measure.
    out.killMono = mono();
    out.killAt = new Date().toISOString();
    try { shell(serial, `su -c "kill -9 ${oldPid}"`); } catch (error) { throw new Error('kill failed: ' + error.message); }
    mark('kill');
    // Direct evidence for the earlier measurement artefact: the cached forward
    // points at the dead process port and can no longer answer.
    const oldForward = await httpStatus(forwardPort, before.probe.session.token, 2000);
    out.oldForwardAfterKill = { localPort: forwardPort, devicePort: forwardDevicePort,
      answered: oldForward.answered, status: oldForward.status ?? null, error: oldForward.error ?? null };
    const deadline = mono() + timeoutMs;
    let newPid = null, lastState = null;
    while (mono() < deadline) {
      await new Promise(resolve => setTimeout(resolve, pollMs));
      let probe;
      try { probe = readProbe(serial); } catch (error) {
        out.samples.push({ tMs: Math.round(mono() - out.killMono), error: String(error.message).slice(0, 120) });
        continue;
      }
      const sample = { tMs: Math.round(mono() - out.killMono), pid: probe.pid,
        sessionPid: probe.session?.pid ?? null, sessionPort: probe.session?.port ?? null,
        generation: probe.session?.processGeneration ?? null,
        engineState: probe.engineState?.state ?? null, phase: probe.engineState?.phase ?? null,
        code: probe.engineState?.code ?? null, failureCount: probe.engineState?.failureCount ?? null };
      if (probe.pid && probe.pid !== Number(oldPid)) {
        newPid = probe.pid;
        if (sample.generation && sample.generation !== out.before.session.processGeneration) sample.newGeneration = true;
        mark('process_new');
        if (Number(probe.session?.pid) === newPid) { mark('session_new'); sample.sessionFresh = true; }
      }
      let answered = null;
      try {
        const portChanged = probe.session?.port && probe.session?.port !== forwardDevicePort;
        const port = ensureForward(probe.session?.port);
        if (port && probe.session?.token) {
          if (portChanged) mark('forward');
          answered = await httpStatus(port, probe.session.token);
          sample.http = answered.answered ? answered.status : answered.error;
          if (answered.answered) mark('http_listen');
          const readiness = answered.body?.engineReadiness;
          if (answered.answered && readiness?.ready === true && Number(readiness.pid) === newPid) {
            mark('api_ready');
            const account = (answered.body.accounts || []).find(one => one.id === accountId);
            sample.account = account ? { state: account.state, running: account.running, runEpoch: account.runEpoch,
              connectionEpoch: account.connectionEpoch, desiredRunning: account.desiredRunning } : null;
            if (account?.running === true && account?.state === 'running') {
              mark('account_running');
              out.after = { enginePid: newPid, instanceId: readiness.instanceId,
                session: { port: probe.session?.port ?? null, pid: probe.session?.pid ?? null,
                  processGeneration: probe.session?.processGeneration ?? null },
                account: sample.account, status: { state: account.state, reasonCode: account.reasonCode ?? null } };
              out.samples.push(sample);
              lastState = sample;
              break;
            }
          }
        }
      } catch { /* transport between processes; keep sampling */ }
      out.samples.push(sample);
      lastState = sample;
    }
    out.newPid = newPid;
    out.recovered = Boolean(out.phases.api_ready);
    out.completed = Boolean(out.phases.account_running);
    if (!out.completed && lastState) out.lastSample = lastState;
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');
    console.log(JSON.stringify({ outFile, phases: out.phases, before: out.before, after: out.after ?? null,
      recovered: out.recovered, completed: out.completed }, null, 1));
    return out.completed ? 0 : 2;
  } finally {
    for (const entry of out.forwards) { try { adb(serial, ['forward', '--remove', 'tcp:' + entry.localPort]); } catch { /* already gone */ } }
  }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('coordination-zcode-engine-kill-timing.mjs')) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; })
    .catch(error => { console.error('ERR', error.message); process.exitCode = 1; });
}