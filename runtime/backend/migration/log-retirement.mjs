import { canonical, fingerprint } from '../common.mjs';

// The uploader owns confirmation semantics. This module owns bounded physical
// exits only, and cannot infer success from a scan, selection or elapsed time.
export function createLogHistoryRetirement({ store, cloudRef, installId, readRetention,
  monotonicNow = () => Number(process.hrtime.bigint()) / 1e6 } = {}) {
  if (typeof readRetention !== 'function' || typeof cloudRef !== 'string' || typeof installId !== 'string')
    throw new TypeError('Log retirement needs the uploader confirmation port and exact installation binding');
  const { get, all, run, transaction } = store;
  store.db.exec(`CREATE INDEX IF NOT EXISTS backend_local_logs_retirement ON backend_local_logs(owner_ref,log_id);
    CREATE TABLE IF NOT EXISTS backend_log_sync_retention(
      cloud_ref TEXT NOT NULL,owner_ref TEXT NOT NULL,install_id TEXT NOT NULL,remove_through_local_id INTEGER NOT NULL,
      confirmed_at TEXT NOT NULL,PRIMARY KEY(cloud_ref,owner_ref,install_id));
    CREATE TABLE IF NOT EXISTS backend_log_retirement_counts(
      cloud_ref TEXT NOT NULL,owner_ref TEXT NOT NULL,install_id TEXT NOT NULL,retired_rows INTEGER NOT NULL,
      chain_fingerprint TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(cloud_ref,owner_ref,install_id));
    CREATE TABLE IF NOT EXISTS backend_log_retirement_callbacks(owner_ref TEXT NOT NULL,log_id INTEGER NOT NULL,
      install_id TEXT NOT NULL,through_id INTEGER NOT NULL,PRIMARY KEY(owner_ref,log_id));
    CREATE TRIGGER IF NOT EXISTS backend_local_log_retirement_guard BEFORE DELETE ON backend_local_logs
    WHEN NOT EXISTS(SELECT 1 FROM backend_log_retirement_callbacks p WHERE p.owner_ref=OLD.owner_ref AND p.log_id=OLD.log_id AND OLD.log_id<=p.through_id)
      OR lower(COALESCE(OLD.outcome_state,''))='unknown'
      OR EXISTS(SELECT 1 FROM backend_log_sync_quarantined_events q WHERE q.owner_ref=OLD.owner_ref AND q.source_log_id=OLD.log_id)
      OR EXISTS(SELECT 1 FROM backend_log_sync_batches b WHERE b.owner_ref=OLD.owner_ref AND b.state IN('pending','sending','unknown')
        AND b.from_log_id<=OLD.log_id AND b.through_log_id>=OLD.log_id)
    BEGIN SELECT RAISE(ABORT,'log source still owns an unconfirmed or quarantined dependency'); END;`);
  let nextAt = 0, last = { state: 'not-checked' };
  const read = () => { const result = readRetention();
    if (result?.then) throw new TypeError('Log retention confirmation must be a synchronous transaction read'); return result; };
  function retire({ limit = 64 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new RangeError('Log retirement slice is out of bounds');
    const now = monotonicNow(); if (now < nextAt) return last; nextAt = now + 15000;
    const before = read();
    if (!before || typeof before.ownerRef !== 'string' || !before.ownerRef || before.installId !== installId ||
        !Number.isSafeInteger(before.identityEpoch) || before.identityEpoch < 1 ||
        !Number.isSafeInteger(before.removeThroughLocalId) || before.removeThroughLocalId < 1)
      return last = { state: 'held', reasonCode: 'LOG_CONFIRMED_RETENTION_PORT_UNAVAILABLE', retired: 0 };
    return last = transaction(() => {
      const current = read();
      if (!current || current.ownerRef !== before.ownerRef || current.identityEpoch !== before.identityEpoch || current.installId !== installId ||
          !Number.isSafeInteger(current.removeThroughLocalId) || current.removeThroughLocalId < 1)
        return { state: 'held', reasonCode: 'LOG_RETENTION_IDENTITY_OR_PREFIX_CHANGED', retired: 0 };
      const upper = Math.min(before.removeThroughLocalId, current.removeThroughLocalId), owner = current.ownerRef;
      const rows = all(`SELECT * FROM backend_local_logs l WHERE l.owner_ref=? AND l.log_id<=? AND lower(COALESCE(l.outcome_state,''))!='unknown'
        AND NOT EXISTS(SELECT 1 FROM backend_log_sync_quarantined_events q WHERE q.owner_ref=l.owner_ref AND q.source_log_id=l.log_id)
        AND NOT EXISTS(SELECT 1 FROM backend_log_sync_batches b WHERE b.owner_ref=l.owner_ref AND b.state IN('pending','sending','unknown')
          AND b.from_log_id<=l.log_id AND b.through_log_id>=l.log_id) ORDER BY l.log_id LIMIT ?`, owner, upper, limit);
      const prior = get('SELECT * FROM backend_log_retirement_counts WHERE cloud_ref=? AND owner_ref=? AND install_id=?', cloudRef, owner, installId);
      let chain = prior?.chain_fingerprint || fingerprint([]), retired = 0;
      for (const row of rows) {
        run('INSERT INTO backend_log_retirement_callbacks VALUES(?,?,?,?)', owner, row.log_id, installId, upper);
        const result = run('DELETE FROM backend_local_logs WHERE owner_ref=? AND log_id=?', owner, row.log_id);
        if (Number(result.changes) !== 1) throw new Error('Log source single-row retirement proof changed');
        run('DELETE FROM backend_log_retirement_callbacks WHERE owner_ref=? AND log_id=?', owner, row.log_id);
        chain = fingerprint([chain, canonical(row)]); retired++;
      }
      run(`INSERT INTO backend_log_sync_retention VALUES(?,?,?,?,?) ON CONFLICT(cloud_ref,owner_ref,install_id)
        DO UPDATE SET remove_through_local_id=max(remove_through_local_id,excluded.remove_through_local_id),confirmed_at=excluded.confirmed_at`,
      cloudRef, owner, installId, upper, store.nowIso());
      run(`INSERT INTO backend_log_retirement_counts VALUES(?,?,?,?,?,?) ON CONFLICT(cloud_ref,owner_ref,install_id)
        DO UPDATE SET retired_rows=excluded.retired_rows,chain_fingerprint=excluded.chain_fingerprint,updated_at=excluded.updated_at`,
      cloudRef, owner, installId, (prior?.retired_rows || 0) + retired, chain, store.nowIso());
      // Retain both the latest successful batch and the batch owning the latest
      // successful receipt. Quarantine originals and completed selections remain.
      const batches = all(`SELECT b.batch_id FROM backend_log_sync_batches b WHERE b.cloud_ref=? AND b.owner_ref=? AND b.install_id=?
        AND b.state='acknowledged' AND b.through_log_id<=? AND NOT EXISTS(SELECT 1 FROM backend_log_sync_quarantines q WHERE q.batch_id=b.batch_id)
        AND b.batch_id!=(SELECT batch_id FROM backend_log_sync_batches WHERE cloud_ref=? AND owner_ref=? AND install_id=? AND state='acknowledged'
          ORDER BY through_log_id DESC,updated_at DESC,batch_id DESC LIMIT 1)
        AND b.batch_id!=COALESCE((SELECT batch_id FROM backend_log_sync_receipts WHERE cloud_ref=? AND owner_ref=? AND install_id=? AND receipt_state='acknowledged'
          ORDER BY recorded_at DESC,receipt_id DESC LIMIT 1),'') ORDER BY b.through_log_id,b.batch_id LIMIT 4`,
      cloudRef, owner, installId, upper, cloudRef, owner, installId, cloudRef, owner, installId);
      for (const batch of batches) {
        run('DELETE FROM backend_log_sync_receipts WHERE batch_id=? AND cloud_ref=? AND owner_ref=? AND install_id=?', batch.batch_id, cloudRef, owner, installId);
        run("DELETE FROM backend_log_sync_batches WHERE batch_id=? AND cloud_ref=? AND owner_ref=? AND install_id=? AND state='acknowledged'", batch.batch_id, cloudRef, owner, installId);
      }
      return { state: 'checked', retired, retiredBatches: batches.length, removeThroughLocalId: upper, ownerRef: owner,
        heldUnknownRowsPreserved: true, completedSelectionsRetained: true };
    });
  }
  return Object.freeze({ retire, snapshot: () => ({ ...last }) });
}
