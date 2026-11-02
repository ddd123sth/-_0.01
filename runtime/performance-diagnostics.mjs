import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { installFileCapacityGovernorFromEnvironment } from './backend/observability/file-capacity.mjs';

const MAX_EVENTS = 64;
const MAX_PER_SECOND = 2;
const MIN_DURATION_MS = 50;
const MAX_SQL_SLOTS = 512;
const MAX_PARSE_SLOTS = 3;
const MAX_PHASE_SLOTS = 16;
const MAX_PHASE_MARKER_WRITES_PER_SECOND = 2;
const SNAPSHOT_INTERVAL_MS = 5000;
const TABLE_REFERENCE = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE|ON)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
const PHASE_LABELS = new Set(['land.select','art.catalog','art.plan','art.dailyInputs','art.daily.assess',
  'art.daily.sourceFingerprint','gateway.semanticToken','gateway.factBasis','art.dailyInputs.readView',
  'art.dailyInputs.recipeEnumeration','art.dailyInputs.profileBatch','art.dailyInputs.pendingEntryProofLoop','art.dailyInputs.finalFreeze',
  'gateway.check']);
let emitted = 0;
let eventAttempts = 0;
let droppedAtEventCap = 0;
let droppedAtRateCap = 0;
let eventSinkFailures = 0;
let second = -1;
let inSecond = 0;
let snapshotSequence = 0;
let lastSnapshotAt = -SNAPSHOT_INTERVAL_MS;
let totalCalls = 0;
let totalDurationMs = 0;
let maxDurationMs = 0;
let totalErrors = 0;
let totalOverThresholdCalls = 0;
let overflowCalls = 0;
let overflowDurationMs = 0;
let overflowMaxDurationMs = 0;
let overflowErrors = 0;
let overflowOverThresholdCalls = 0;
const sqlSlots = new Map();
let sqlSlotCount = 0;
const parseSlots = new Map();
const phaseSlots = new Map();
const activePhases = [];
let phaseSequence = 0;
let phaseOverflowCalls = 0;
let phaseMarkerFailures = 0;
let phaseMarkerWrites = 0;
let phaseMarkerDrops = 0;
let phaseMarkerSecond = -1;
let phaseMarkerWritesInSecond = 0;
let activeMarkerOnDisk = false;
let phaseDiagnosticFailures = 0;
const processStartedAt = performance.now();
const processGeneration = typeof process.env.GARDEN_NATIVE_GENERATION === 'string' &&
  /^[a-f0-9-]{36}$/i.test(process.env.GARDEN_NATIVE_GENERATION) ? process.env.GARDEN_NATIVE_GENERATION : null;
const diagnosticFile = processGeneration && typeof process.env.DATA_DIR === 'string' && path.isAbsolute(process.env.DATA_DIR)
  ? path.join(process.env.DATA_DIR, 'performance-diagnostics', processGeneration, 'events.ndjson') : null;
const summaryFile = diagnosticFile ? path.join(path.dirname(diagnosticFile), 'summary.json') : null;
const activePhaseFile = diagnosticFile ? path.join(path.dirname(diagnosticFile), 'active-phase.json') : null;

// The engine process owns the file budget. A harness has neither an absolute
// DATA_DIR nor a native generation, so it never installs a governor.
try { installFileCapacityGovernorFromEnvironment(); } catch { /* Capacity work cannot block measurement. */ }

function permitEvent(now) {
  if (eventAttempts >= MAX_EVENTS) { droppedAtEventCap += 1; return false; }
  const currentSecond = Math.floor(now / 1000);
  if (currentSecond !== second) {
    second = currentSecond;
    inSecond = 0;
  }
  if (inSecond >= MAX_PER_SECOND) { droppedAtRateCap += 1; return false; }
  inSecond += 1;
  eventAttempts += 1;
  return true;
}

function ensureDiagnosticDirectory() {
  if (!diagnosticFile) return false;
  try { fs.mkdirSync(path.dirname(diagnosticFile), { recursive: true, mode: 0o700 }); return true; }
  catch { return false; }
}

function writeDiagnosticLine(line) {
  let fileWritten = false;
  if (ensureDiagnosticDirectory()) {
    try { fs.appendFileSync(diagnosticFile, line, { encoding: 'utf8', mode: 0o600 }); fileWritten = true; }
    catch { /* A diagnostic sink must never change the measured operation. */ }
  }
  try { process.stderr.write(line); } catch { /* Android may attach stderr to /dev/null. */ }
  return diagnosticFile ? fileWritten : false;
}

function freshMetricSlot(key, metadata) {
  return { key, ...metadata, calls: 0, totalMs: 0, maxMs: 0, errors: 0, over50ms: 0, maxInputCodeUnits: null };
}

function addMetric(slot, durationMs, outcome, inputCodeUnits = null) {
  slot.calls += 1;
  slot.totalMs += durationMs;
  slot.maxMs = Math.max(slot.maxMs, durationMs);
  if (outcome === 'error') slot.errors += 1;
  if (durationMs >= MIN_DURATION_MS) slot.over50ms += 1;
  if (Number.isSafeInteger(inputCodeUnits) && inputCodeUnits >= 0) {
    slot.maxInputCodeUnits = slot.maxInputCodeUnits === null ? inputCodeUnits : Math.max(slot.maxInputCodeUnits, inputCodeUnits);
  }
}

function snapshotMetrics(now) {
  if (now - lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return;
  lastSnapshotAt = now;
  if (!ensureDiagnosticDirectory()) return;
  const temporaryFile = `${summaryFile}.tmp`;
  const summary = {
    type: 'garden-sqlite-timing-summary:v1',
    processGeneration,
    pid: process.pid,
    snapshotSequence: ++snapshotSequence,
    capturedAt: new Date().toISOString(),
    processElapsedMs: Number((now - processStartedAt).toFixed(3)),
    sink: 'app-data-generation-file',
    totals: { calls: totalCalls, durationMs: Number(totalDurationMs.toFixed(3)), maxMs: Number(maxDurationMs.toFixed(3)), errors: totalErrors,
      over50ms: totalOverThresholdCalls, slowEventAttempts: eventAttempts, emittedSlowEvents: emitted, slowEventCap: MAX_EVENTS,
      droppedAtEventCap, droppedAtRateCap, eventSinkFailures },
    sqlSlots: [...sqlSlots.values()].flatMap(byMode => [...byMode.values()])
      .map(slot => ({ ...slot, totalMs: Number(slot.totalMs.toFixed(3)), maxMs: Number(slot.maxMs.toFixed(3)) })),
    parseSlots: [...parseSlots.values()].map(slot => ({ ...slot, totalMs: Number(slot.totalMs.toFixed(3)), maxMs: Number(slot.maxMs.toFixed(3)) })),
    phaseSlots: [...phaseSlots.values()].map(slot => ({ ...slot, totalMs: Number(slot.totalMs.toFixed(3)), maxMs: Number(slot.maxMs.toFixed(3)) })),
    phaseDiagnostics: { capacity: MAX_PHASE_SLOTS, slots: phaseSlots.size, overflowCalls: phaseOverflowCalls,
      markerWriteLimitPerSecond: MAX_PHASE_MARKER_WRITES_PER_SECOND, markerAttempts: phaseMarkerWrites, markerDrops: phaseMarkerDrops,
      markerFailures: phaseMarkerFailures, diagnosticFailures: phaseDiagnosticFailures, activeDepth: activePhases.length,
      markerMayBeStale: activePhases.length > 0 || activeMarkerOnDisk || phaseMarkerDrops > 0 || phaseMarkerFailures > 0 },
    overflow: { calls: overflowCalls, durationMs: Number(overflowDurationMs.toFixed(3)), maxMs: Number(overflowMaxDurationMs.toFixed(3)),
      errors: overflowErrors, over50ms: overflowOverThresholdCalls },
  };
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(summary) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryFile, summaryFile);
  } catch {
    try { fs.unlinkSync(temporaryFile); } catch { /* Preserve diagnostic-only failure. */ }
  }
}

function writeActivePhaseMarker() {
  if (!activePhaseFile) return;
  if (!activePhases.length && !activeMarkerOnDisk) return;
  const now = performance.now(), currentSecond = Math.floor(now / 1000);
  if (currentSecond !== phaseMarkerSecond) { phaseMarkerSecond = currentSecond; phaseMarkerWritesInSecond = 0; }
  if (phaseMarkerWritesInSecond >= MAX_PHASE_MARKER_WRITES_PER_SECOND) { phaseMarkerDrops += 1; return; }
  phaseMarkerWritesInSecond += 1;
  phaseMarkerWrites += 1;
  try {
    if (!activePhases.length) {
      if (!activeMarkerOnDisk) return;
      try { fs.unlinkSync(activePhaseFile); activeMarkerOnDisk = false; }
      catch (error) { if (error?.code === 'ENOENT') activeMarkerOnDisk = false; else phaseMarkerFailures += 1; }
      return;
    }
    if (!ensureDiagnosticDirectory()) { phaseMarkerFailures += 1; return; }
    const top = activePhases[activePhases.length - 1];
    const marker = { type: 'garden-sync-phase-active:v1', processGeneration, pid: process.pid, sequence: top.sequence,
      label: top.label, parentSequence: top.parentSequence, parentChain: top.parentChain, depth: top.depth,
      startedMonotonicMs: Number(top.startedAt.toFixed(3)),
      markerMayBeStale: true };
    const temporaryFile = `${activePhaseFile}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(marker) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryFile, activePhaseFile);
    activeMarkerOnDisk = true;
  } catch { phaseMarkerFailures += 1; }
}

export function timedSyncPhase(label, callback) {
  if (typeof callback !== 'function') throw new TypeError('A synchronous phase callback is required');
  if (!PHASE_LABELS.has(label)) return callback();
  const startedAt = performance.now();
  const parentLabel = activePhases.length ? activePhases[activePhases.length - 1].label : null;
  const parent = activePhases.length ? activePhases[activePhases.length - 1] : null;
  const entry = { sequence: ++phaseSequence, label, parentLabel, parentSequence: parent?.sequence ?? null,
    parentChain: [...activePhases.map(phase => phase.label), label].slice(-8), depth: activePhases.length + 1, startedAt };
  activePhases.push(entry);
  writeActivePhaseMarker();
  entry.startedAt = performance.now();
  let outcome = 'ok';
  try { return callback(); }
  catch (error) { outcome = 'error'; throw error; }
  finally {
    try {
      const durationMs = performance.now() - entry.startedAt;
      const slot = phaseSlots.get(label);
      if (slot) addMetric(slot, durationMs, outcome);
      else if (phaseSlots.size < MAX_PHASE_SLOTS) {
        const created = freshMetricSlot(label, { label });
        addMetric(created, durationMs, outcome);
        phaseSlots.set(label, created);
      } else phaseOverflowCalls += 1;
    } catch { phaseDiagnosticFailures += 1; }
    try {
      const index = activePhases.lastIndexOf(entry);
      if (index >= 0) activePhases.splice(index, 1);
      writeActivePhaseMarker();
      snapshotMetrics(performance.now());
    } catch { phaseDiagnosticFailures += 1; }
  }
}

function recordSQLSample({ sql, kind, mode, databaseMode }, durationMs, outcome) {
  totalCalls += 1;
  totalDurationMs += durationMs;
  maxDurationMs = Math.max(maxDurationMs, durationMs);
  if (outcome === 'error') totalErrors += 1;
  if (durationMs >= MIN_DURATION_MS) totalOverThresholdCalls += 1;
  let slot = null;
  if (typeof sql === 'string') {
    const txFamily = transactionFamily(sql);
    const signature = `${String(kind)}\0${String(mode)}\0${String(databaseMode)}\0${txFamily || ''}`;
    const slotSql = txFamily ? `backend_tx_family:${txFamily}` : sql;
    let byMode = sqlSlots.get(slotSql);
    slot = byMode?.get(signature) || null;
    if (!slot && sqlSlotCount < MAX_SQL_SLOTS) {
      const sqlSha256 = txFamily ? null : crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
      const key = txFamily ? `family:${txFamily}:${String(kind)}:${String(mode)}:${String(databaseMode)}`
        : `${sqlSha256}:${String(kind)}:${String(mode)}:${String(databaseMode)}`;
      slot = freshMetricSlot(key, { sqlSha256, ...(txFamily ? { family: txFamily, hashKind: 'family' } : {}),
        call: String(kind).slice(0, 32), mode: String(mode).slice(0, 32), databaseMode: String(databaseMode).slice(0, 32),
        verb: verbOf(sql), tables: txFamily ? [] : tablesIn(sql) });
      if (!byMode) { byMode = new Map(); sqlSlots.set(slotSql, byMode); }
      byMode.set(signature, slot);
      sqlSlotCount += 1;
    }
  }
  if (slot) addMetric(slot, durationMs, outcome);
  else {
    overflowCalls += 1; overflowDurationMs += durationMs; overflowMaxDurationMs = Math.max(overflowMaxDurationMs, durationMs);
    if (outcome === 'error') overflowErrors += 1;
    if (durationMs >= MIN_DURATION_MS) overflowOverThresholdCalls += 1;
  }
}

function transactionFamily(sql) {
  // The transaction wrapper generates only these fixed command shapes. Keep
  // this diagnostic grouping strict; event records continue to use the exact
  // original SQL hash above/below and the SQLite statements remain unchanged.
  const normalized = sql.trim();
  if (/^SAVEPOINT\s+backend_tx_\d+$/i.test(normalized)) return 'savepoint';
  if (/^RELEASE\s+SAVEPOINT\s+backend_tx_\d+$/i.test(normalized)) return 'release-savepoint';
  if (/^ROLLBACK\s+TO\s+SAVEPOINT\s+backend_tx_\d+$/i.test(normalized)) return 'rollback-savepoint';
  return null;
}

function recordParseSample(field, inputCodeUnits, durationMs, outcome) {
  totalCalls += 1;
  totalDurationMs += durationMs;
  maxDurationMs = Math.max(maxDurationMs, durationMs);
  if (outcome === 'error') totalErrors += 1;
  if (durationMs >= MIN_DURATION_MS) totalOverThresholdCalls += 1;
  const label = String(field).slice(0, 64);
  let slot = parseSlots.get(label);
  if (!slot && parseSlots.size < MAX_PARSE_SLOTS) {
    slot = freshMetricSlot(label, { call: 'parseStored', label });
    parseSlots.set(label, slot);
  }
  if (slot) addMetric(slot, durationMs, outcome, inputCodeUnits);
  else {
    overflowCalls += 1; overflowDurationMs += durationMs; overflowMaxDurationMs = Math.max(overflowMaxDurationMs, durationMs);
    if (outcome === 'error') overflowErrors += 1;
    if (durationMs >= MIN_DURATION_MS) overflowOverThresholdCalls += 1;
  }
}

function tablesIn(sql) {
  const names = new Set();
  TABLE_REFERENCE.lastIndex = 0;
  for (let match; (match = TABLE_REFERENCE.exec(sql)) && names.size < 4;) {
    const name = match[1].toLowerCase();
    // Product persistence tables use this namespace. Never emit arbitrary
    // identifiers, SQL text, bind values, or SQLite internal table names.
    if (/^backend_[a-z0-9_]{1,96}$/.test(name)) names.add(name);
  }
  return [...names].sort();
}

function verbOf(sql) {
  const match = /^\s*(?:(?:--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/\s*)\s*)*([A-Za-z]+)/.exec(sql);
  return match ? match[1].toUpperCase() : 'OTHER';
}

function emit(durationMs, makeEvent) {
  if (durationMs < MIN_DURATION_MS || !permitEvent(performance.now())) return durationMs;
  try {
    const event = makeEvent();
    const written = writeDiagnosticLine(JSON.stringify({
      type: 'garden-sqlite-timing:v1',
      at: new Date().toISOString(),
      pid: process.pid,
      processGeneration,
      durationMs: Number(durationMs.toFixed(3)),
      ...event,
    }) + '\n');
    if (written) emitted += 1;
    else eventSinkFailures += 1;
  } catch { eventSinkFailures += 1; /* Diagnostics must never alter the database call's result. */ }
  return durationMs;
}

export function timedSQLiteCall({ sql, kind, mode, databaseMode, rowCount }, callback) {
  const startedAt = performance.now();
  try {
    const result = callback();
    const durationMs = performance.now() - startedAt;
    const rows = typeof rowCount === 'function' ? rowCount(result) : null;
    try { recordSQLSample({ sql, kind, mode, databaseMode }, durationMs, 'ok'); } catch { /* Diagnostics cannot alter a successful SQLite call. */ }
    emit(durationMs, () => {
      if (typeof sql !== 'string') return { call: kind, mode, databaseMode, rowCount: null, outcome: 'ok', sqlMetadataAvailable: false };
      return { call: kind, mode, databaseMode, verb: verbOf(sql), tables: tablesIn(sql),
        sqlSha256: crypto.createHash('sha256').update(sql, 'utf8').digest('hex'),
        rowCount: Number.isSafeInteger(rows) && rows >= 0 ? rows : null, outcome: 'ok' };
    });
    snapshotMetrics(performance.now());
    return result;
  } catch (error) {
    const durationMs = performance.now() - startedAt;
    try { recordSQLSample({ sql, kind, mode, databaseMode }, durationMs, 'error'); } catch { /* Diagnostics cannot replace the SQLite error. */ }
    emit(durationMs, () => {
      if (typeof sql !== 'string') return { call: kind, mode, databaseMode, rowCount: null, outcome: 'error', sqlMetadataAvailable: false };
      return { call: kind, mode, databaseMode, verb: verbOf(sql), tables: tablesIn(sql),
        sqlSha256: crypto.createHash('sha256').update(sql, 'utf8').digest('hex'), rowCount: null, outcome: 'error' };
    });
    snapshotMetrics(performance.now());
    throw error;
  }
}

export function timedStoredParse(field, inputCodeUnits, callback) {
  const startedAt = performance.now();
  let outcome = 'ok';
  try {
    return callback();
  } catch (error) {
    outcome = 'error';
    throw error;
  } finally {
    const durationMs = performance.now() - startedAt;
    try { recordParseSample(field, inputCodeUnits, durationMs, outcome); } catch { /* Diagnostics cannot change parsing. */ }
    emit(durationMs, () => ({ call: 'parseStored', label: String(field).slice(0, 64), inputCodeUnits,
      sizeUnit: 'utf16-code-units', outcome }));
    snapshotMetrics(performance.now());
  }
}
