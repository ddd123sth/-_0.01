import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Generation-scoped byte budgets for the app's own files. The reclaim order is
// fixed (oldest closed unit first) so a repeated scan converges to the same
// result; nothing here reads business facts or changes run intent.
const STATUS_VERSION = 'file-capacity-status/v1';
const LEASE_VERSION = 'file-capacity-lease/v1';
const LEASE_TTL_MS = 150_000;
const STATUS_MIN_WRITE_MS = 30_000;
const SCAN_MIN_INTERVAL_MS = 240_000;
const FIRST_SCAN_DELAY_MS = 12_000;
const MAX_UNITS_PER_CLASS = 512;
const MAX_TREE_ENTRIES = 4096;
const MAX_TREE_DEPTH = 4;
const STATUS_BYTES = 8 * 1024;
const RECEIPTS_KEPT = 6;
const MiB = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Names that carry stop intent, credentials, current projections, the database
// or the executable payload. A misconfigured root must never reach them.
const PROTECTED_NAMES = new Set(['user-stop-request.json', 'native-stop-control.json', 'account-stop-requests',
  'credential-key.enc', 'engine-session.json', 'engine-heartbeat.json', 'device-profile.json',
  'reconnect-deadlines.json', 'garden.db', 'garden.db-wal', 'garden.db-shm', 'engine.zip', '.asset-version',
  'cloud-url.txt', 'file-capacity-status.json', 'file-capacity-lease.json', 'engine', 'engine.zip.tmp']);
const PROTECTED_PREFIXES = Object.freeze(['keepalive-', 'stop-request', 'native-stop', 'credential-', 'ui-heartbeat',
  'account-stop', 'ad-sdk-config', 'native-recovery-journal', 'engine-session', 'engine-heartbeat', 'garden.db']);
export const protectedFileName = name => PROTECTED_NAMES.has(name) || PROTECTED_PREFIXES.some(prefix => name.startsWith(prefix));

/**
 * Managed classes. `unit` names what one reclaim atom is:
 *   directory-child -> each direct child of the root (one per generation)
 *   directory-leaf  -> each grandchild of the root (probe/<capture>)
 *   file            -> each direct child file matching `pattern`
 * `keepNewest` is a floor: the newest N units of a class are never deleted, so a
 * class that only just started collecting keeps enough context to be read.
 */
export const FILE_CAPACITY_CLASSES = Object.freeze([
  { id: 'runtime-diagnostics', root: 'data/performance-diagnostics', unit: 'directory-child',
    budgetBytes: 6 * MiB, keepNewest: 8, graceMs: 600_000 },
  { id: 'probe-diagnostics', root: 'diagnostics', unit: 'directory-leaf',
    budgetBytes: 8 * MiB, keepNewest: 6, graceMs: 1_800_000 },
  { id: 'restart-decisions', root: 'engine-restart-decisions', unit: 'file', pattern: /^[0-9a-f-]{36}\.json$/i,
    budgetBytes: 256 * 1024, keepNewest: 64, graceMs: 600_000 },
  { id: 'plain-logs', root: 'log', unit: 'file', pattern: null, budgetBytes: 1 * MiB, keepNewest: 4, graceMs: 600_000 },
  { id: 'engine-staging', root: 'data', unit: 'file', pattern: /\.tmp$/, budgetBytes: 1 * MiB, keepNewest: 1, graceMs: 900_000 },
]);
export const FILE_CAPACITY_TOTAL_BUDGET_BYTES = FILE_CAPACITY_CLASSES.reduce((sum, entry) => sum + entry.budgetBytes, 0);

const insideRoot = (root, candidate) => {
  const resolved = path.resolve(candidate);
  return resolved === root || resolved.startsWith(root + path.sep);
};

function safeLstat(target) {
  try { const stat = fs.lstatSync(target); return stat.isSymbolicLink() ? null : stat; }
  catch { return null; }
}

// Bounded recursive measurement. A symlink is never followed and an over-large
// tree is reported as truncated instead of being deleted blind.
function measureTree(target, depth, budget) {
  const stat = safeLstat(target);
  if (!stat) return { bytes: 0, entries: 0, newestMtimeMs: 0, truncated: budget.truncated, protected: false };
  if (!stat.isDirectory()) {
    budget.entries -= 1;
    if (budget.entries < 0) budget.truncated = true;
    return { bytes: stat.size, entries: 1, newestMtimeMs: stat.mtimeMs, truncated: budget.truncated,
      protected: protectedFileName(path.basename(target)) };
  }
  if (depth > MAX_TREE_DEPTH) return { bytes: 0, entries: 0, newestMtimeMs: stat.mtimeMs, truncated: true, protected: false };
  let bytes = 0, entries = 0, newestMtimeMs = stat.mtimeMs;
  let protectedEntry = protectedFileName(path.basename(target));
  let children = [];
  try { children = fs.readdirSync(target); } catch { return { bytes, entries, newestMtimeMs, truncated: true, protected: true }; }
  for (const child of children) {
    const detail = measureTree(path.join(target, child), depth + 1, budget);
    bytes += detail.bytes; entries += detail.entries;
    newestMtimeMs = Math.max(newestMtimeMs, detail.newestMtimeMs);
    if (detail.protected) protectedEntry = true;
  }
  return { bytes, entries, newestMtimeMs, truncated: budget.truncated, protected: protectedEntry };
}

function listUnits(filesDir, definition) {
  const filesRoot = path.resolve(filesDir);
  const root = path.resolve(filesRoot, definition.root);
  if (!insideRoot(filesRoot, root)) return { root, units: [], unavailable: 'ROOT_OUTSIDE_FILES_DIR' };
  const stat = safeLstat(root);
  if (!stat) return { root, units: [], unavailable: null };
  if (!stat.isDirectory()) return { root, units: [], unavailable: 'ROOT_NOT_A_DIRECTORY' };
  let names = [];
  try { names = fs.readdirSync(root).sort(); } catch { return { root, units: [], unavailable: 'ROOT_UNREADABLE' }; }
  const units = [];
  for (const name of names) {
    if (units.length >= MAX_UNITS_PER_CLASS) break;
    if (protectedFileName(name)) continue;
    const target = path.join(root, name);
    const child = safeLstat(target);
    if (!child) continue;
    if (definition.unit === 'file') {
      if (!child.isFile() || definition.pattern && !definition.pattern.test(name)) continue;
      units.push({ key: name, absolute: target, bytes: child.size, entries: 1,
        mtimeMs: child.mtimeMs, truncated: false, generation: null });
      continue;
    }
    if (!child.isDirectory()) continue;
    if (definition.unit === 'directory-child') {
      const measured = measureTree(target, 0, { entries: MAX_TREE_ENTRIES, truncated: false });
      units.push({ key: name, absolute: target, bytes: measured.bytes, entries: measured.entries,
        mtimeMs: measured.newestMtimeMs, truncated: measured.truncated, generation: name });
      continue;
    }
    // directory-leaf: diagnostics/<probe>/<capture>. The probe directory itself
    // is not a unit, so one probe cannot own the whole class budget.
    let leaves = [];
    try { leaves = fs.readdirSync(target).sort(); } catch { continue; }
    for (const leaf of leaves) {
      if (units.length >= MAX_UNITS_PER_CLASS) break;
      const leafPath = path.join(target, leaf);
      const leafStat = safeLstat(leafPath);
      if (!leafStat || !leafStat.isDirectory()) continue;
      const measured = measureTree(leafPath, 0, { entries: MAX_TREE_ENTRIES, truncated: false });
      units.push({ key: name + '/' + leaf, absolute: leafPath, bytes: measured.bytes, entries: measured.entries,
        mtimeMs: measured.newestMtimeMs, truncated: measured.truncated, generation: leaf });
    }
  }
  return { root, units, unavailable: null };
}

function pruneEmptyProbeDirectories(root) {
  let names = [];
  try { names = fs.readdirSync(root); } catch { return; }
  for (const name of names) {
    const target = path.join(root, name);
    const stat = safeLstat(target);
    if (!stat || !stat.isDirectory()) continue;
    try { if (fs.readdirSync(target).length === 0) fs.rmdirSync(target); } catch { /* A raced writer keeps its directory. */ }
  }
}

/**
 * Reads the managed classes without writing anything. Used by the status
 * projection, the device evidence tool and the reclaim pass itself.
 */
export function collectFileCapacity({ filesDir, generation = null, now = Date.now() } = {}) {
  if (typeof filesDir !== 'string' || !path.isAbsolute(filesDir)) throw new TypeError('filesDir must be absolute');
  const classes = [];
  for (const definition of FILE_CAPACITY_CLASSES) {
    const listed = listUnits(filesDir, definition);
    const units = listed.units;
    const bytes = units.reduce((sum, unit) => sum + unit.bytes, 0);
    classes.push({ id: definition.id, root: listed.root, unavailable: listed.unavailable,
      budgetBytes: definition.budgetBytes, keepNewest: definition.keepNewest, entries: units.length, bytes,
      overBudget: bytes > definition.budgetBytes, overCount: units.length > definition.keepNewest,
      currentGenerationPresent: generation ? units.some(unit => unit.generation === generation) : null,
      truncated: units.some(unit => unit.truncated === true),
      oldestMtimeMs: units.length ? Math.min(...units.map(unit => unit.mtimeMs)) : null,
      newestMtimeMs: units.length ? Math.max(...units.map(unit => unit.mtimeMs)) : null,
      units });
  }
  return { atMs: now, generation, filesDir, totalBytes: classes.reduce((sum, entry) => sum + entry.bytes, 0),
    budgetBytes: FILE_CAPACITY_TOTAL_BUDGET_BYTES, classes };
}

/**
 * One deterministic reclaim pass. Oldest-first, whole-unit, and the current
 * generation plus the newest `keepNewest` units of every class are kept. A unit
 * is removed only when it is closed (nothing inside is younger than the class
 * grace) and nothing inside it is protected.
 */
export function reclaimFileCapacity({ filesDir, generation = null, now = Date.now(), dryRun = false } = {}) {
  const inventory = collectFileCapacity({ filesDir, generation, now });
  const definitions = new Map(FILE_CAPACITY_CLASSES.map(entry => [entry.id, entry]));
  const passes = [];
  for (const entry of inventory.classes) {
    const definition = definitions.get(entry.id);
    if (entry.unavailable) continue;
    const units = [...entry.units].sort((left, right) =>
      left.mtimeMs - right.mtimeMs || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
    // Only the newest unit of a class is unconditionally kept (plus the running
    // generation below): a class whose newest units alone exceed the budget must
    // still converge, so keepNewest is a soft floor and the budget is the hard one.
    const hardKept = new Set(units.slice(-1).map(unit => unit.key));
    let bytes = entry.bytes, count = units.length, removedBytes = 0, removedEntries = 0;
    const decisions = [];
    for (const unit of units) {
      if (bytes <= definition.budgetBytes && count <= definition.keepNewest) break;
      if (unit.generation && generation && unit.generation === generation) {
        decisions.push({ key: unit.key, action: 'keep', reason: 'CURRENT_GENERATION' }); continue;
      }
      // A single capture larger than the whole class budget cannot be kept just
      // because it is the newest one; only the running generation is exempt.
      if (unit.bytes > definition.budgetBytes) {
        if (dryRun) { decisions.push({ key: unit.key, action: 'would-reclaim', bytes: unit.bytes, reason: 'OVERSIZED_UNIT' }); }
        else {
          try { fs.rmSync(unit.absolute, { recursive: true, force: true, maxRetries: 2 }); }
          catch (error) { decisions.push({ key: unit.key, action: 'keep', reason: error?.code || 'REMOVE_FAILED' }); continue; }
          decisions.push({ key: unit.key, action: 'reclaimed', bytes: unit.bytes, reason: 'OVERSIZED_UNIT' });
        }
        removedBytes += unit.bytes; removedEntries += 1; bytes -= unit.bytes; count -= 1;
        continue;
      }
      if (hardKept.has(unit.key)) { decisions.push({ key: unit.key, action: 'keep', reason: 'NEWEST' }); continue; }
      if (unit.truncated) { decisions.push({ key: unit.key, action: 'keep', reason: 'SCAN_TRUNCATED' }); continue; }
      if (now - unit.mtimeMs < definition.graceMs) { decisions.push({ key: unit.key, action: 'keep', reason: 'WITHIN_GRACE' }); continue; }
      if (protectedFileName(path.basename(unit.absolute))) { decisions.push({ key: unit.key, action: 'keep', reason: 'PROTECTED' }); continue; }
      if (dryRun) { decisions.push({ key: unit.key, action: 'would-reclaim', bytes: unit.bytes }); }
      else {
        try { fs.rmSync(unit.absolute, { recursive: true, force: true, maxRetries: 2 }); }
        catch (error) { decisions.push({ key: unit.key, action: 'keep', reason: error?.code || 'REMOVE_FAILED' }); continue; }
        decisions.push({ key: unit.key, action: 'reclaimed', bytes: unit.bytes });
      }
      removedBytes += unit.bytes; removedEntries += 1; bytes -= unit.bytes; count -= 1;
    }
    if (!dryRun && definition.unit === 'directory-leaf' && removedEntries > 0) pruneEmptyProbeDirectories(entry.root);
    entry.bytes = bytes; entry.entries = count;
    passes.push({ id: entry.id, budgetBytes: definition.budgetBytes, keepNewest: definition.keepNewest,
      beforeBytes: bytes + removedBytes, afterBytes: bytes, removedBytes, removedEntries,
      overBudgetAfter: bytes > definition.budgetBytes, overCountAfter: count > definition.keepNewest,
      decisions: decisions.slice(0, 24) });
  }
  const afterTotalBytes = inventory.classes.reduce((sum, entry) => sum + entry.bytes, 0);
  return { atMs: now, generation, dryRun, beforeTotalBytes: inventory.totalBytes, afterTotalBytes,
    reclaimedBytes: inventory.totalBytes - afterTotalBytes, classes: passes,
    overBudgetAfter: passes.some(entry => entry.overBudgetAfter) };
}

const pidAlive = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { return fs.existsSync('/proc/' + pid); } catch { return true; }
};

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, value, mode = 0o600) {
  const temporary = file + '.tmp-' + crypto.randomBytes(4).toString('hex');
  try {
    fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { encoding: 'utf8', mode });
    fs.renameSync(temporary, file);
    return true;
  } catch {
    try { fs.unlinkSync(temporary); } catch { /* A failed projection is reported, not thrown. */ }
    return false;
  }
}

/**
 * A single-writer lease keeps two overlapping engine generations from
 * reclaiming at once. A dead or expired holder is taken over; a live one is
 * respected and its pass is skipped rather than duplicated.
 */
function acquireLease(leaseFile, generation) {
  const claim = () => {
    const body = { version: LEASE_VERSION, pid: process.pid, generation, nonce: crypto.randomBytes(8).toString('hex'),
      atMs: Date.now() };
    let handle = null;
    try { handle = fs.openSync(leaseFile, 'wx', 0o600); }
    catch (error) { if (error?.code !== 'EEXIST') return null; }
    if (handle === null) {
      const holder = readJson(leaseFile);
      const expired = !holder || !Number.isSafeInteger(holder.atMs) || Date.now() - holder.atMs > LEASE_TTL_MS
        || !pidAlive(holder.pid);
      if (!expired) return null;
      try { fs.unlinkSync(leaseFile); } catch { return null; }
      try { handle = fs.openSync(leaseFile, 'wx', 0o600); } catch { return null; }
    }
    try { fs.writeSync(handle, JSON.stringify(body)); } finally { try { fs.closeSync(handle); } catch { /* best effort */ } }
    return body;
  };
  return claim();
}

function renewLease(leaseFile, lease) {
  lease.atMs = Date.now();
  return writeJsonAtomic(leaseFile, lease);
}

function releaseLease(leaseFile, lease) {
  const holder = readJson(leaseFile);
  if (!holder || holder.nonce !== lease.nonce) return;
  try { fs.unlinkSync(leaseFile); } catch { /* Already gone. */ }
}

/**
 * Owns the periodic scan. `maintain()` is cheap between scans: it only compares
 * timestamps, so it can be called from an existing maintenance tick.
 */
export function createFileCapacityGovernor({ filesDir, dataDir = null, generation = null,
  scanIntervalMs = SCAN_MIN_INTERVAL_MS, onReceipt = () => {} } = {}) {
  if (typeof filesDir !== 'string' || !path.isAbsolute(filesDir)) throw new TypeError('filesDir must be absolute');
  const root = path.resolve(filesDir);
  const statusFile = path.join(dataDir ? path.resolve(dataDir) : path.join(root, 'data'), 'file-capacity-status.json');
  const leaseFile = path.join(path.dirname(statusFile), 'file-capacity-lease.json');
  let nextScanAt = Date.now() + FIRST_SCAN_DELAY_MS;
  let lastStatusAt = 0;
  let last = { state: 'idle', atMs: null, reclaimedBytes: 0, beforeTotalBytes: null, afterTotalBytes: null, classes: [] };
  const receipts = [];
  let closed = false, timer = null, firstTimer = null, lease = null, passes = 0, skips = 0, failures = 0;

  function publishStatus(extra = {}) {
    lastStatusAt = Date.now();
    const body = { version: STATUS_VERSION, schemaVersion: 1, generation, pid: process.pid,
      atMs: lastStatusAt, scanIntervalMs, passes, skips, failures,
      lastScan: last, receipts: receipts.slice(-RECEIPTS_KEPT), ...extra };
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded, 'utf8') > STATUS_BYTES) {
      writeJsonAtomic(statusFile, { version: STATUS_VERSION, schemaVersion: 1, generation, pid: process.pid,
        atMs: lastStatusAt, scanIntervalMs, passes, skips, failures, truncated: true,
        lastScan: { state: last.state, atMs: last.atMs, reclaimedBytes: last.reclaimedBytes } });
      return;
    }
    writeJsonAtomic(statusFile, body);
  }

  function scan({ force = false } = {}) {
    if (closed) return null;
    const now = Date.now();
    if (!force && now < nextScanAt) return null;
    nextScanAt = now + scanIntervalMs;
    lease = acquireLease(leaseFile, generation);
    if (!lease) { skips += 1; publishStatus(); return null; }
    let receipt = null;
    try {
      receipt = reclaimFileCapacity({ filesDir: root, generation, now });
      passes += 1;
      last = { state: receipt.overBudgetAfter ? 'over-budget' : 'within-budget', atMs: receipt.atMs,
        reclaimedBytes: receipt.reclaimedBytes, beforeTotalBytes: receipt.beforeTotalBytes,
        afterTotalBytes: receipt.afterTotalBytes, classes: receipt.classes.map(entry => ({ id: entry.id,
          beforeBytes: entry.beforeBytes, afterBytes: entry.afterBytes, removedBytes: entry.removedBytes,
          removedEntries: entry.removedEntries, overBudgetAfter: entry.overBudgetAfter })) };
      receipts.push({ atMs: receipt.atMs, reclaimedBytes: receipt.reclaimedBytes,
        beforeTotalBytes: receipt.beforeTotalBytes, afterTotalBytes: receipt.afterTotalBytes,
        removedEntries: receipt.classes.reduce((sum, entry) => sum + entry.removedEntries, 0) });
      if (receipts.length > RECEIPTS_KEPT) receipts.shift();
      renewLease(leaseFile, lease);
      try { onReceipt(last); } catch { /* A receipt consumer cannot change the reclaim. */ }
    } catch { failures += 1; last = { ...last, state: 'failed' }; }
    finally { releaseLease(leaseFile, lease); lease = null; }
    publishStatus();
    return receipt;
  }

  return Object.freeze({
    // Cheap enough for a 300ms maintenance tick: it only compares a timestamp.
    maintain(now = Date.now()) {
      if (closed) return null;
      if (now < nextScanAt) { if (now - lastStatusAt >= STATUS_MIN_WRITE_MS) publishStatus(); return null; }
      if (typeof setImmediate === 'function') { setImmediate(() => { try { scan(); } catch { /* bounded */ } }); return null; }
      return scan();
    },
    scan,
    status: () => ({ state: last.state, atMs: last.atMs, passes, skips, failures,
      beforeTotalBytes: last.beforeTotalBytes, afterTotalBytes: last.afterTotalBytes, classes: last.classes }),
    start() {
      if (closed || timer) return;
      publishStatus();
      // The first pass waits for the directory to settle after a restart, then
      // the steady interval takes over.
      firstTimer = setTimeout(() => {
        firstTimer = null;
        try { scan(); } catch { /* bounded */ }
        if (!closed && !timer) {
          timer = setInterval(() => { try { scan(); } catch { /* bounded */ } }, scanIntervalMs);
          if (typeof timer.unref === 'function') timer.unref();
        }
      }, Math.min(FIRST_SCAN_DELAY_MS, scanIntervalMs));
      if (typeof firstTimer.unref === 'function') firstTimer.unref();
    },
    close() {
      closed = true;
      if (firstTimer) { try { clearTimeout(firstTimer); } catch { /* best effort */ } firstTimer = null; }
      if (timer) { try { clearInterval(timer); } catch { /* best effort */ } timer = null; }
      if (lease) releaseLease(leaseFile, lease);
      lease = null;
    },
  });
}

let installed = null;

/**
 * Installs the engine-process governor once. It needs the same explicit
 * environment the diagnostics sink uses (absolute DATA_DIR plus the native
 * process generation); a test or a UI process therefore never installs it.
 */
export function installFileCapacityGovernorFromEnvironment() {
  if (process.env.GARDEN_FILE_CAPACITY === '0') return null;
  const dataDir = process.env.DATA_DIR;
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) return null;
  if (typeof process.env.GARDEN_NATIVE_GENERATION !== 'string' || !UUID.test(process.env.GARDEN_NATIVE_GENERATION)) return null;
  if (installed) return installed;
  const filesDir = path.dirname(dataDir);
  installed = createFileCapacityGovernor({ filesDir, dataDir, generation: process.env.GARDEN_NATIVE_GENERATION });
  installed.start();
  return installed;
}

export function currentFileCapacityGovernor() { return installed; }