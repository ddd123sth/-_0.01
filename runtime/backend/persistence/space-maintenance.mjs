import { freeze } from '../common.mjs';

// Reclaim only SQLite free pages. Never choose a history row, change journal
// mode/durability, run a full VACUUM or hold a maintenance lock waiting for work.
export function createSpaceMaintenance({ store, isQuiescent, monotonicNow = () => Number(process.hrtime.bigint()) / 1e6 }) {
  for (const port of [store?.get, store?.exec, store?.inTransaction, isQuiescent, monotonicNow])
    if (typeof port !== 'function') throw new TypeError('Space maintenance requires synchronous bounded ports');
  let nextAt = 0, sample = { state: 'not-sampled', runs: 0, reclaimedPages: 0, maximumSliceMs: 0 };
  const value = pragma => Object.values(store.get('PRAGMA ' + pragma) || {})[0];
  const snapshot = () => freeze({ ...sample });
  function maintain() {
    const started = monotonicNow(); if (started < nextAt) return snapshot(); nextAt = started + 2000;
    if (store.inTransaction() || isQuiescent() !== true) return snapshot();
    let priorTimeout, changedTimeout = false;
    try {
      priorTimeout = value('busy_timeout');
      if (!Number.isSafeInteger(priorTimeout) || priorTimeout < 0 || priorTimeout > 600000) throw new Error('Invalid SQLite lock timeout');
      store.exec('PRAGMA busy_timeout=0'); changedTimeout = true;
      const mode = value('auto_vacuum'), journal = value('journal_mode'), synchronous = value('synchronous');
      if (mode !== 2 || !['delete','wal','truncate','persist'].includes(journal) || synchronous < 2) {
        sample = { ...sample, state: 'held-storage-mode', autoVacuum: mode, journal, synchronous }; return snapshot();
      }
      const freeBefore = value('freelist_count'), pagesBefore = value('page_count'), pageSize = value('page_size');
      sample = { ...sample, state: freeBefore ? 'ready' : 'no-free-pages', journal, synchronous,
        pageSize, pageCount: pagesBefore, freePages: freeBefore, sampledAtMs: Date.now() };
      if (!Number.isSafeInteger(freeBefore) || freeBefore < 1) return snapshot();
      // One page per statement limits each indivisible relocation; yield after
      // at most eight relocations or ten milliseconds of measured work.
      let attempted = 0;
      do {
        if (store.inTransaction() || isQuiescent() !== true) break;
        store.exec('PRAGMA incremental_vacuum(1)'); attempted++;
      } while (attempted < Math.min(8, freeBefore) && monotonicNow() - started < 10);
      const pagesAfter = value('page_count'), freeAfter = value('freelist_count');
      sample = { ...sample, state: 'reclaimed', runs: sample.runs + 1, pageCount: pagesAfter, freePages: freeAfter,
        attemptedPages: attempted, reclaimedPages: sample.reclaimedPages + Math.max(0, pagesBefore - pagesAfter) };
    } catch (error) {
      const code = Number(error.errcode) & 255;
      sample = { ...sample, state: [5,6].includes(code) || /locked|busy/i.test(error.message || '') ? 'busy-retry' : 'maintenance-error',
        errorCode: typeof error.code === 'string' ? error.code : 'SQLITE_MAINTENANCE_UNAVAILABLE' };
      nextAt = monotonicNow() + 15000;
    } finally {
      if (changedTimeout) store.exec('PRAGMA busy_timeout=' + priorTimeout);
      const elapsed = monotonicNow() - started;
      sample = { ...sample, lastSliceMs: Math.round(elapsed * 1000) / 1000,
        maximumSliceMs: Math.max(sample.maximumSliceMs, Math.round(elapsed * 1000) / 1000) };
      if (elapsed > 25) nextAt = Math.max(nextAt, monotonicNow() + 15000);
    }
    return snapshot();
  }
  return Object.freeze({ maintain, snapshot });
}
