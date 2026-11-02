import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Read-only layered recovery timing. Start points are stated, never inferred:
//   deadlineAtMs   the account's own retry deadline published by the engine
//   armedAtMs      AlarmManager accepted the appointment
//   firedAtMs      the broadcast reached the process
//   deliveredAtMs  the engine service accepted the wake
//   handledAtMs    the reconnect path finished
//   runnableAtMs   the engine published this subject as RUNNABLE again
const outDir = process.argv[2];
const serial = process.argv[3] || 'emulator-5558';
const pkg = process.argv[4] || 'online.ainiannian.wujinxia';
if (!outDir) { console.error('usage: node coordination-zcode-p01-timing.mjs <outDir> [serial] [package]'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const adb = process.env.ADB_PATH || 'C:/leidian/LDPlayer14/adb.exe';
const read = (relative, timeout = 30000) => {
  try { return execFileSync(adb, ['-s', serial, 'shell', `run-as ${pkg} cat ${relative}`], { encoding: 'utf8', timeout, windowsHide: true }); }
  catch { return ''; }
};
const sha = value => createHash('sha256').update(value).digest('hex');
const save = (name, value) => {
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  fs.writeFileSync(path.join(outDir, name), body);
  return sha(body);
};

const raw = { timings: read('files/reconnect-timings.json'), engine: read('files/keepalive-engine.json'),
  projection: read('files/data/reconnect-deadlines.json'), alarm: read('files/keepalive-reconnect.json'),
  delivery: read('files/keepalive-reconnect-delivery.json'), handling: read('files/keepalive-reconnect-handling.json') };
const parsed = Object.fromEntries(Object.entries(raw).map(([key, text]) => {
  try { return [key, text.trim() ? JSON.parse(text) : null]; } catch { return [key, { __unparsable: true }]; }
}));

const LAYERS = [
  ['armBeforeDeadlineMs', 'requestedAtMs', 'deadlineAtMs'],
  ['deadlineToFiredMs', 'deadlineAtMs', 'firedAtMs'],
  ['firedToDeliveredMs', 'firedAtMs', 'deliveredAtMs'],
  ['deliveredToHandledMs', 'deliveredAtMs', 'handledAtMs'],
  ['handledToRunnableMs', 'handledAtMs', 'runnableAtMs'],
];
const UPPER_LAYERS = [
  ['deadlineToDeliveredMs', 'deadlineAtMs', 'deliveredAtMs'],
  ['deadlineToHandledMs', 'deadlineAtMs', 'handledAtMs'],
  ['deadlineToRunnableMs', 'deadlineAtMs', 'runnableAtMs'],
  ['requestedToRunnableMs', 'requestedAtMs', 'runnableAtMs'],
];
const layerValue = (cycle, from, to) => {
  const stored = cycle[`${from.replace(/Ms$/, '')}To${to[0].toUpperCase()}${to.slice(1)}`];
  if (typeof stored === 'number') return stored;
  const start = cycle[from], end = cycle[to];
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
};

const cycles = (parsed.timings?.cycles || []);
const report = {
  capturedAt: new Date().toISOString(), serial, package: pkg,
  scope: 'read-only reconnect timing layers; no START/STOP, no device writes',
  targetMs: 35000,
  metricDefinition: 'deadlineToRunnableMs: the account retry deadline -> the engine publishes the subject connected again (RUNNABLE or WAITING, both connected fact states)',
  cycles: cycles.map(cycle => {
    const row = { id: cycle.id, accountRef: cycle.accountRef, state: cycle.state, mode: cycle.mode,
      generation: cycle.generation, controlSeq: cycle.controlSeq, runEpoch: cycle.runEpoch,
      outcome: cycle.outcome || null, deliveryOutcome: cycle.deliveryOutcome || null };
    for (const [name, from, to] of LAYERS) row[name] = layerValue(cycle, from, to);
    for (const [name, from, to] of UPPER_LAYERS) row[name] = layerValue(cycle, from, to);
    row.meetsTarget = typeof row.deadlineToRunnableMs === 'number' ? row.deadlineToRunnableMs <= 35000 : null;
    return row;
  }),
  engine: parsed.engine ? { phase: parsed.engine.phase, state: parsed.engine.state,
    runningCount: parsed.engine.runningCount, pendingCount: parsed.engine.pendingCount,
    wakeLockHeld: parsed.engine.wakeLockHeld, cpuLockReason: parsed.engine.cpuLockReason,
    reconnectWakeAtMs: parsed.engine.reconnectWakeAtMs, lastStopLatencyMs: parsed.engine.lastStopLatencyMs,
    cost: parsed.engine.cost || null, reconnectTiming: parsed.engine.reconnectTiming || null } : null,
  alarm: parsed.alarm, delivery: parsed.delivery, handling: parsed.handling,
  projection: parsed.projection ? { revision: parsed.projection.revision, controlSeq: parsed.projection.controlSeq,
    controlKind: parsed.projection.controlKind, capturedAtMs: parsed.projection.capturedAtMs,
    accounts: (parsed.projection.accounts || []).map(row => ({ accountRef: row.accountRef,
      desiredRunning: row.desiredRunning, state: row.state, retryAtMs: row.retryAtMs, runEpoch: row.runEpoch })) } : null,
};
report.completeCycles = report.cycles.filter(row => typeof row.deadlineToRunnableMs === 'number').length;
report.reportSha256 = save('P01-TIMING.json', report);
save('raw-timing-files.txt', Object.entries(raw).map(([key, text]) => `=== ${key} (${text ? sha(text) : 'absent'})\n${text}`).join('\n'));
console.log(JSON.stringify(report, null, 2));