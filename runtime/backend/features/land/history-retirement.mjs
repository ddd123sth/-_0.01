import { canonical, fingerprint, parseStored } from '../../common.mjs';

export const LAND_HISTORY_RETIREMENT_SCHEMA = `CREATE TABLE IF NOT EXISTS backend_land_history_retirement_callbacks(
  event_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,land_id INTEGER NOT NULL,head_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS backend_land_history_retirement_progress(
    owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,land_id INTEGER NOT NULL,head_version INTEGER NOT NULL,
    scanned_rowid INTEGER NOT NULL,retired_count INTEGER NOT NULL,chain_fingerprint TEXT NOT NULL,updated_at TEXT NOT NULL,
    PRIMARY KEY(owner_ref,subject_ref,land_id));
  CREATE INDEX IF NOT EXISTS backend_land_history_retirement_order ON backend_land_lifecycle_events(owner_ref,subject_ref,land_id);`;
export const LAND_HISTORY_DELETE_GUARD = `CREATE TRIGGER IF NOT EXISTS backend_land_lifecycle_events_no_delete
  BEFORE DELETE ON backend_land_lifecycle_events
  WHEN NOT EXISTS(SELECT 1 FROM backend_land_history_retirement_callbacks p JOIN backend_land_lifecycle_heads h
    ON h.owner_ref=p.owner_ref AND h.subject_ref=p.subject_ref AND h.land_id=p.land_id AND h.model_json=p.head_json
    WHERE p.event_ref=OLD.event_ref AND p.owner_ref=OLD.owner_ref AND p.subject_ref=OLD.subject_ref AND p.land_id=OLD.land_id
    AND CASE WHEN json_valid(OLD.after_json) AND json_valid(h.model_json) THEN
      json_type(OLD.after_json,'$.semanticVersion')='integer' AND json_type(h.model_json,'$.semanticVersion')='integer'
      AND json_extract(OLD.after_json,'$.semanticVersion')>0
      AND json_extract(OLD.after_json,'$.semanticVersion')<json_extract(h.model_json,'$.semanticVersion') ELSE 0 END)
  BEGIN SELECT RAISE(ABORT,'land history exit requires current head and callback'); END;`;

// event_ref is never returned by reconcile(), read by an admission port or
// used to allocate a generation. Every business read uses the durable head;
// operation originals retain their complete admitted lifecycle snapshot. This
// exits only obsolete derived before/after details, never original wire frames,
// operation evidence, unknown verdicts or the newest generation's event.
export function createLandHistoryRetirement({ store, monotonicNow = () => Number(process.hrtime.bigint()) / 1e6 }) {
  store.db.exec(LAND_HISTORY_RETIREMENT_SCHEMA);
  const { get, all, run, transaction } = store;
  const supported = get("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='backend_land_lifecycle_events_no_delete'")?.sql
    ?.includes('land history exit requires current head and callback') === true;
  let owner = '', subject = '', land = 0, nextAt = 0;
  function retire({ limit = 32 } = {}) {
    if (!supported) return { held: 'legacy-append-only-guard-needs-verified-image', retired: 0 };
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new RangeError('Land history retirement slice is out of bounds');
    const at = monotonicNow(); if (at < nextAt) return { retired: 0, scanned: 0 }; nextAt = at + 1000;
    const head = get(`SELECT * FROM backend_land_lifecycle_heads WHERE (owner_ref,subject_ref,land_id)>(?,?,?)
      ORDER BY owner_ref,subject_ref,land_id LIMIT 1`, owner, subject, land)
      || get('SELECT * FROM backend_land_lifecycle_heads ORDER BY owner_ref,subject_ref,land_id LIMIT 1');
    if (!head) return { retired: 0, scanned: 0 };
    owner = head.owner_ref; subject = head.subject_ref; land = head.land_id;
    return transaction(() => {
      const current = get('SELECT * FROM backend_land_lifecycle_heads WHERE owner_ref=? AND subject_ref=? AND land_id=?', owner, subject, land);
      const model = current && parseStored(current.model_json, 'land lifecycle retirement root');
      if (!model || !Number.isSafeInteger(model.semanticVersion) || model.semanticVersion < 1 || model.subjectRef !== subject || model.landId !== land)
        return { retired: 0, scanned: 0, held: 'head-not-proven' };
      const previous = get('SELECT * FROM backend_land_history_retirement_progress WHERE owner_ref=? AND subject_ref=? AND land_id=?', owner, subject, land);
      const cursor = previous?.head_version === model.semanticVersion ? previous.scanned_rowid : 0;
      const rows = all(`SELECT rowid AS scan_id,* FROM backend_land_lifecycle_events WHERE owner_ref=? AND subject_ref=? AND land_id=?
        AND rowid>? ORDER BY rowid LIMIT ?`, owner, subject, land, cursor, limit);
      if (!rows.length) return { retired: 0, scanned: 0 };
      let retired = 0, chain = previous?.chain_fingerprint || fingerprint([]);
      for (const row of rows) {
        let after; try { after = parseStored(row.after_json, 'land lifecycle derived event'); } catch { continue; }
        if (!Number.isSafeInteger(after?.semanticVersion) || after.semanticVersion < 1 || after.semanticVersion >= model.semanticVersion) continue;
        run('INSERT INTO backend_land_history_retirement_callbacks VALUES(?,?,?,?,?)', row.event_ref, owner, subject, land, current.model_json);
        const result = run('DELETE FROM backend_land_lifecycle_events WHERE event_ref=? AND owner_ref=? AND subject_ref=? AND land_id=?', row.event_ref, owner, subject, land);
        if (Number(result.changes) !== 1) throw new Error('Land history single-event exit proof changed');
        run('DELETE FROM backend_land_history_retirement_callbacks WHERE event_ref=?', row.event_ref);
        chain = fingerprint([chain, canonical(row)]); retired++;
      }
      run(`INSERT INTO backend_land_history_retirement_progress VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref,land_id)
        DO UPDATE SET head_version=excluded.head_version,scanned_rowid=excluded.scanned_rowid,retired_count=excluded.retired_count,
        chain_fingerprint=excluded.chain_fingerprint,updated_at=excluded.updated_at`, owner, subject, land, model.semanticVersion,
      rows.at(-1).scan_id, (previous?.retired_count || 0) + retired, chain, store.nowIso());
      return { scanned: rows.length, retired, subjectRef: subject, landId: land };
    });
  }
  return Object.freeze({ retire });
}
