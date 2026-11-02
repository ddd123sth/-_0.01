import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync as NativeDatabaseSync } from 'node:sqlite';

// No import of the legacy db module: opening a store must not initialize its
// schema, account defaults, business reconciliation, or production data path.
export function openBackendStore({ dataDir, filename = 'garden.db', DatabaseSync = NativeDatabaseSync,
  nowIso = () => new Date().toISOString() } = {}) {
  if (typeof dataDir !== 'string' || !dataDir.trim() || !path.isAbsolute(dataDir)) {
    throw new TypeError('Backend storage requires an explicit absolute dataDir');
  }
  if (typeof filename !== 'string' || !filename || path.basename(filename) !== filename || filename === ':memory:') {
    throw new TypeError('Backend storage filename must name a file inside dataDir');
  }
  if (typeof DatabaseSync !== 'function' || typeof nowIso !== 'function') throw new TypeError('Invalid backend storage dependencies');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dataDir, filename);
  const db = new DatabaseSync(filePath);
  let closed = false;
  let failed = null;
  let depth = 0;
  let savepointSequence = 0;
  let rollbackSafeCommitBusy = false;
  let contention = { totalBusyCalls: 0, maximumBusyMs: 0, slowestCallers: [], lastBusyAtMs: null, maintenanceCommitRollbacks: 0 };
  const check = () => {
    if (closed) throw new Error('Backend storage is closed');
    if (failed) throw new Error('Backend persistence commit failed; restart and inspect storage before continuing', { cause: failed });
  };
  const guarded = callback => {
    check();
    const started = Number(process.hrtime.bigint()) / 1e6;
    try { return callback(); }
    catch (error) {
      if ([5, 6].includes(Number(error.errcode) & 0xff) || /locked|busy/i.test(error.message || '')) {
        const elapsed = Math.round((Number(process.hrtime.bigint()) / 1e6 - started) * 1000) / 1000;
        // Only module/line locations, never SQL text, bindings or credentials.
        const callers = [...String(new Error().stack).matchAll(/(?:runtime\/)?backend\/[A-Za-z0-9_./-]+\.mjs:\d+:\d+/g)]
          .map(match => match[0]).slice(0, 8);
        contention = { ...contention, totalBusyCalls: Math.min(Number.MAX_SAFE_INTEGER, contention.totalBusyCalls + 1),
          maximumBusyMs: Math.max(contention.maximumBusyMs, elapsed),
          slowestCallers: elapsed >= contention.maximumBusyMs ? callers : contention.slowestCallers, lastBusyAtMs: Date.now() };
      }
      // Autocommit writes also have a durable commit boundary. I/O, full-disk,
      // corruption and invalid-image failures must stop this runtime rather
      // than permit a later decision on an assumed persisted state.
      const primaryCode = Number(error.errcode) & 0xff;
      if ([7, 10, 11, 13, 26].includes(primaryCode) || /SQLite persistence failed/i.test(error.message || '')) failed = error;
      throw error;
    }
  };
  const exec = sql => guarded(() => db.exec(sql));
  const run = (sql, ...params) => guarded(() => db.prepare(sql).run(...params));
  const get = (sql, ...params) => guarded(() => db.prepare(sql).get(...params) || null);
  const all = (sql, ...params) => guarded(() => db.prepare(sql).all(...params));
  try {
    exec('PRAGMA busy_timeout=5000');
    exec('PRAGMA foreign_keys=ON');
    exec('PRAGMA synchronous=FULL');
  } catch (error) {
    try { db.close(); } catch { /* Preserve the initialization error. */ }
    throw error;
  }
  function transaction(callback) {
    check();
    if (typeof callback !== 'function' || callback.constructor?.name === 'AsyncFunction') {
      throw new TypeError('Backend transactions require a synchronous callback');
    }
    const outer = depth === 0;
    const savepoint = outer ? null : 'backend_tx_' + (++savepointSequence);
    exec(outer ? 'BEGIN IMMEDIATE' : 'SAVEPOINT ' + savepoint);
    depth += 1;
    let result;
    try {
      result = callback();
      if (result && typeof result.then === 'function') {
        const error = new TypeError('Backend transactions must not return a Promise; restart before continuing asynchronous work');
        error.backendAsyncTransaction = true;
        throw error;
      }
    } catch (error) {
      try {
        if (outer) db.exec('ROLLBACK');
        else { db.exec('ROLLBACK TO SAVEPOINT ' + savepoint); db.exec('RELEASE SAVEPOINT ' + savepoint); }
      } catch (rollbackError) {
        failed = rollbackError;
        throw new AggregateError([error, rollbackError], 'Backend transaction failed and rollback could not be confirmed');
      } finally { depth -= 1; }
      if (error.backendAsyncTransaction) failed = error;
      throw error;
    }
    try {
      db.exec(outer ? 'COMMIT' : 'RELEASE SAVEPOINT ' + savepoint);
    } catch (error) {
      // In DELETE mode even a read-only peer can block COMMIT after BEGIN
      // IMMEDIATE succeeded. SQLITE_BUSY leaves that transaction active.
      // Only explicitly pure maintenance may resume after confirmed rollback;
      // the callback still fails, so no caller receives a false commit receipt.
      // Business/settlement and all non-Busy failures retain the old latch.
      if (outer && rollbackSafeCommitBusy && (Number(error.errcode) & 0xff) === 5) {
        try { db.exec('ROLLBACK'); }
        catch (rollbackError) {
          failed = rollbackError;
          throw new AggregateError([error, rollbackError], 'Maintenance commit failed and rollback could not be confirmed');
        }
        contention.maintenanceCommitRollbacks = Math.min(Number.MAX_SAFE_INTEGER, contention.maintenanceCommitRollbacks + 1);
        throw error;
      }
      // A failed COMMIT may already have changed the durable image. Never
      // resume decisions on an assumed rollback or retry the logical write.
      failed = error;
      try { if (outer) db.exec('ROLLBACK'); } catch { /* Restart is required regardless. */ }
      throw error;
    } finally { depth -= 1; }
    return result;
  }
  function close() {
    if (closed) return;
    if (depth) throw new Error('Cannot close backend storage inside a transaction');
    db.close();
    closed = true;
  }
  function withBusyTimeout(timeoutMs, callback, { maintenanceCommitRollback = false } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 5000 || typeof callback !== 'function' ||
        callback.constructor?.name === 'AsyncFunction') throw new TypeError('Lock timeout scope requires a synchronous connection scope');
    if (typeof maintenanceCommitRollback !== 'boolean' || maintenanceCommitRollback && depth !== 0)
      throw new TypeError('Maintenance commit rollback needs an outer synchronous scope');
    const previous = Object.values(get('PRAGMA busy_timeout') || {})[0], previousRollbackSafe = rollbackSafeCommitBusy;
    if (!Number.isSafeInteger(previous) || previous < 0 || previous > 600000) throw new Error('SQLite lock timeout is invalid');
    exec('PRAGMA busy_timeout=' + timeoutMs);
    rollbackSafeCommitBusy = maintenanceCommitRollback;
    try {
      const result = callback();
      if (result?.then) { result.catch?.(() => {}); throw new TypeError('Lock timeout scope cannot cross an asynchronous boundary'); }
      return result;
    } finally { rollbackSafeCommitBusy = previousRollbackSafe; exec('PRAGMA busy_timeout=' + previous); }
  }
  return Object.freeze({ db, filePath, exec, run, get, all, transaction, withBusyTimeout, inTransaction: () => depth > 0,
    lockContentionSnapshot: () => ({ ...contention, slowestCallers: [...contention.slowestCallers] }), close, nowIso });
}
