import { fingerprint } from '../../common.mjs';

// Sparse enter ACKs are connection-local clock anchors. The only reader is
// anchorFor(), which requires the exact current login, baseline and CE. Keep
// every CE used by an operation or verification lease, plus all generation
// references; only an unreferenced, durably superseded CE may exit.
export function createWaterwheelAnchorRetirement({ store }) {
  const { get, all, run, transaction } = store;
  store.db.exec(`CREATE INDEX IF NOT EXISTS backend_waterwheel_anchor_scope ON backend_waterwheel_enter_anchors(owner_ref,subject_ref,connection_epoch);
    CREATE INDEX IF NOT EXISTS backend_waterwheel_generation_enter ON backend_waterwheel_generation(enter_response_ref);
    CREATE INDEX IF NOT EXISTS backend_operations_subject_connection ON backend_operations(subject_ref,connection_epoch);
    CREATE INDEX IF NOT EXISTS backend_verification_subject_original_connection ON backend_session_verification_leases(subject_ref,original_connection_epoch);
    CREATE INDEX IF NOT EXISTS backend_verification_subject_new_connection ON backend_session_verification_leases(subject_ref,new_connection_epoch);
    CREATE TABLE IF NOT EXISTS backend_waterwheel_anchor_exit_callbacks(response_ref TEXT PRIMARY KEY,connection_epoch INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS backend_waterwheel_anchor_exit_progress(owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
      connection_epoch INTEGER NOT NULL,scanned_rowid INTEGER NOT NULL,retired_count INTEGER NOT NULL,
      chain_fingerprint TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref));`);
  const proof = `EXISTS(SELECT 1 FROM backend_waterwheel_anchor_exit_callbacks p JOIN backend_subject_connection_epochs c
      ON c.subject_ref=OLD.subject_ref AND c.connection_epoch=p.connection_epoch
      WHERE p.response_ref=OLD.response_ref AND OLD.connection_epoch>0 AND OLD.connection_epoch<c.connection_epoch)
    AND NOT EXISTS(SELECT 1 FROM backend_operations o WHERE o.subject_ref=OLD.subject_ref AND o.connection_epoch=OLD.connection_epoch)
    AND NOT EXISTS(SELECT 1 FROM backend_session_verification_leases v WHERE v.subject_ref=OLD.subject_ref AND v.original_connection_epoch=OLD.connection_epoch)
    AND NOT EXISTS(SELECT 1 FROM backend_session_verification_leases v WHERE v.subject_ref=OLD.subject_ref AND v.new_connection_epoch=OLD.connection_epoch)
    AND NOT EXISTS(SELECT 1 FROM backend_waterwheel_generation g WHERE g.enter_response_ref=OLD.response_ref)`;
  transaction(() => {
    const name = 'backend_waterwheel_enter_anchors_no_delete';
    const prior = get("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?", name)?.sql;
    if (prior?.includes('waterwheel anchor exit requires superseded unreferenced connection')) return;
    if (prior && !prior.includes('waterwheel enter anchors are append only')) throw new Error('Unknown waterwheel anchor exit guard');
    if (prior) store.db.exec('DROP TRIGGER ' + name);
    store.db.exec(`CREATE TRIGGER ${name} BEFORE DELETE ON backend_waterwheel_enter_anchors WHEN NOT(${proof})
      BEGIN SELECT RAISE(ABORT,'waterwheel anchor exit requires superseded unreferenced connection'); END;`);
  });
  let owner = '', subject = '';
  function retire({ limit = 16 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new RangeError('Waterwheel anchor exit slice is out of bounds');
    const head = get(`SELECT owner_ref,subject_ref FROM backend_waterwheel_heads WHERE (owner_ref,subject_ref)>(?,?)
      ORDER BY owner_ref,subject_ref LIMIT 1`, owner, subject) || get('SELECT owner_ref,subject_ref FROM backend_waterwheel_heads ORDER BY owner_ref,subject_ref LIMIT 1');
    if (!head) return { scanned: 0, retired: 0 };
    owner = head.owner_ref; subject = head.subject_ref;
    return transaction(() => {
      const ce = get('SELECT connection_epoch FROM backend_subject_connection_epochs WHERE subject_ref=?', subject)?.connection_epoch;
      if (!Number.isSafeInteger(ce) || ce < 1) return { scanned: 0, retired: 0 };
      const prior = get('SELECT * FROM backend_waterwheel_anchor_exit_progress WHERE owner_ref=? AND subject_ref=?', owner, subject);
      const cursor = prior?.connection_epoch === ce ? prior.scanned_rowid : 0;
      const rows = all(`SELECT rowid AS scan_id,* FROM backend_waterwheel_enter_anchors WHERE owner_ref=? AND subject_ref=?
        AND rowid>? ORDER BY rowid LIMIT ?`, owner, subject, cursor, limit);
      if (!rows.length) return { scanned: 0, retired: 0 };
      let retired = 0, chain = prior?.chain_fingerprint || fingerprint([]);
      for (const row of rows) {
        if (!Number.isSafeInteger(row.connection_epoch) || row.connection_epoch < 1 || row.connection_epoch >= ce
            || get('SELECT 1 FROM backend_operations WHERE subject_ref=? AND connection_epoch=? LIMIT 1', subject, row.connection_epoch)
            || get('SELECT 1 FROM backend_session_verification_leases WHERE subject_ref=? AND original_connection_epoch=? LIMIT 1', subject, row.connection_epoch)
            || get('SELECT 1 FROM backend_session_verification_leases WHERE subject_ref=? AND new_connection_epoch=? LIMIT 1', subject, row.connection_epoch)
            || get('SELECT 1 FROM backend_waterwheel_generation WHERE enter_response_ref=? LIMIT 1', row.response_ref)) continue;
        run('INSERT INTO backend_waterwheel_anchor_exit_callbacks VALUES(?,?)', row.response_ref, ce);
        const result = run('DELETE FROM backend_waterwheel_enter_anchors WHERE response_ref=? AND owner_ref=? AND subject_ref=?', row.response_ref, owner, subject);
        if (Number(result.changes) !== 1) throw new Error('Waterwheel single-anchor exit proof changed');
        run('DELETE FROM backend_waterwheel_anchor_exit_callbacks WHERE response_ref=?', row.response_ref);
        const { scan_id, ...original } = row; chain = fingerprint([chain, fingerprint(original)]); retired++;
      }
      run(`INSERT INTO backend_waterwheel_anchor_exit_progress VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref)
        DO UPDATE SET connection_epoch=excluded.connection_epoch,scanned_rowid=excluded.scanned_rowid,retired_count=excluded.retired_count,
        chain_fingerprint=excluded.chain_fingerprint,updated_at=excluded.updated_at`, owner, subject, ce, rows.at(-1).scan_id,
      (prior?.retired_count || 0) + retired, chain, store.nowIso());
      return { scanned: rows.length, retired };
    });
  }
  return Object.freeze({ retire });
}
