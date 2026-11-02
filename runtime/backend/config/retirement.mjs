import { canonical, fingerprint } from '../common.mjs';

// Revision allocation stays in backend_config_heads. History is needed by
// outstanding immutable operations and by the currently saved/accepted head;
// an inactive run cannot retain an unprepared proposal in a future generation.
export function createConfigHistoryRetirement({ store, isQuiescent = () => false, monotonicNow = () => Number(process.hrtime.bigint()) / 1e6 }) {
  if (typeof isQuiescent !== 'function') throw new TypeError('Configuration retirement needs a synchronous quiescence port');
  const { get, all, run, transaction } = store;
  store.db.exec(`CREATE INDEX IF NOT EXISTS backend_operations_config_revision ON backend_operations(owner_ref,account_ref,config_revision);
    CREATE TABLE IF NOT EXISTS backend_config_retirement(
      owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,head_revision INTEGER NOT NULL,accepted_revision INTEGER NOT NULL,
      scanned_revision INTEGER NOT NULL,retired_count INTEGER NOT NULL,chain_fingerprint TEXT NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY(owner_ref,account_ref));
    CREATE TABLE IF NOT EXISTS backend_config_retirement_callbacks(
      owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,revision INTEGER NOT NULL,run_epoch INTEGER NOT NULL,
      connection_epoch INTEGER NOT NULL,PRIMARY KEY(owner_ref,account_ref,revision));
    `);
  const guard = `CREATE TRIGGER backend_config_history_retention_guard BEFORE DELETE ON backend_config_history
    WHEN NOT EXISTS(SELECT 1 FROM backend_config_retirement_callbacks p WHERE p.owner_ref=OLD.owner_ref AND p.account_ref=OLD.account_ref AND p.revision=OLD.revision)
      OR EXISTS(SELECT 1 FROM backend_config_heads h WHERE h.owner_ref=OLD.owner_ref AND h.account_ref=OLD.account_ref AND OLD.revision IN(h.saved_revision,h.accepted_revision))
      OR EXISTS(SELECT 1 FROM backend_operations o WHERE o.owner_ref=OLD.owner_ref AND o.account_ref=OLD.account_ref AND o.config_revision=OLD.revision)
      OR EXISTS(SELECT 1 FROM backend_run_intents i WHERE i.owner_ref=OLD.owner_ref AND (i.account_ref=OLD.account_ref OR i.subject_ref=OLD.subject_ref)
        AND (i.desired_running!=0 OR i.state!='STOPPED') AND NOT EXISTS(SELECT 1 FROM backend_config_retirement_callbacks p
          WHERE p.owner_ref=OLD.owner_ref AND p.account_ref=OLD.account_ref AND p.revision=OLD.revision AND i.account_ref=p.account_ref
          AND i.desired_running=1 AND i.state IN('RUNNABLE','WAITING') AND i.run_epoch=p.run_epoch AND i.connection_epoch=p.connection_epoch))
      OR EXISTS(SELECT 1 FROM backend_operations o WHERE o.owner_ref=OLD.owner_ref AND (o.account_ref=OLD.account_ref OR o.subject_ref=OLD.subject_ref) AND o.write_slot=1)
    BEGIN SELECT RAISE(ABORT,'configuration history still owns a recovery or active-run dependency'); END;`;
  transaction(() => {
    const previous = get("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='backend_config_history_retention_guard'")?.sql;
    if (previous?.includes("i.state!='stopped'") && previous.includes("i.state='running'") &&
        previous.includes('configuration history still owns a recovery or active-run dependency')) {
      // Replace our previous guard atomically: supervisor persists lifecycle
      // names, while its public API translates those names to lowercase states.
      // No commit can observe an unprotected table; every recovery fence stays.
      run('DROP TRIGGER backend_config_history_retention_guard');
      store.db.exec(guard);
    } else if (!previous) store.db.exec(guard);
    else if (!previous.includes("i.state IN('RUNNABLE','WAITING')")) throw new Error('Unknown configuration retirement guard');
  });
  let afterOwner = '', afterAccount = '', nextAt = 0;
  function retire({ limit = 16 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new RangeError('Configuration retirement slice is out of bounds');
    const now = monotonicNow(); if (now < nextAt) return { scanned: 0, retired: 0 }; nextAt = now + 1000;
    const head = get(`SELECT * FROM backend_config_heads WHERE (owner_ref,account_ref)>(?,?) ORDER BY owner_ref,account_ref LIMIT 1`, afterOwner, afterAccount)
      || get('SELECT * FROM backend_config_heads ORDER BY owner_ref,account_ref LIMIT 1');
    if (!head) return { scanned: 0, retired: 0 };
    afterOwner = head.owner_ref; afterAccount = head.account_ref;
    return transaction(() => {
      // Repeat all fences while holding this short FULL transaction. A new
      // pending STOP or an in-flight write forbids history retirement. A running
      // generation may retire only between assessment/dispatch/verification
      // flights; its exact tuple is part of every transient callback proof.
      const current = get('SELECT * FROM backend_config_heads WHERE owner_ref=? AND account_ref=?', head.owner_ref, head.account_ref);
      if (!current) return { scanned: 0, retired: 0 };
      const live = all(`SELECT account_ref,run_epoch,connection_epoch,desired_running,state FROM backend_run_intents WHERE owner_ref=? AND (account_ref=? OR subject_ref=?)
        AND (desired_running!=0 OR state!='STOPPED')`, head.owner_ref, head.account_ref, current.subject_ref);
      let runEpoch = 0, connectionEpoch = 0;
      if (live.length) {
        if (live.length !== 1 || live[0].account_ref !== head.account_ref || live[0].desired_running !== 1 || !['RUNNABLE','WAITING'].includes(live[0].state))
          return { scanned: 0, retired: 0, held: 'active-or-draining-alias' };
        const idle = isQuiescent({ ownerRef: head.owner_ref, accountRef: head.account_ref, subjectRef: current.subject_ref,
          runEpoch: live[0].run_epoch, connectionEpoch: live[0].connection_epoch });
        if (idle?.then) { idle.catch?.(() => {}); throw new TypeError('Configuration quiescence cannot be asynchronous'); }
        if (idle !== true) return { scanned: 0, retired: 0, held: 'assessment-or-dispatch-flight' };
        runEpoch = live[0].run_epoch; connectionEpoch = live[0].connection_epoch;
      }
      if (get(`SELECT 1 FROM backend_operations WHERE owner_ref=? AND (account_ref=? OR subject_ref=?) AND write_slot=1 LIMIT 1`,
        head.owner_ref, head.account_ref, current.subject_ref)) return { scanned: 0, retired: 0, held: 'write-slot' };
      const previous = get('SELECT * FROM backend_config_retirement WHERE owner_ref=? AND account_ref=?', head.owner_ref, head.account_ref);
      const accepted = current.accepted_revision ?? 0, cursor = previous?.head_revision === current.saved_revision && previous.accepted_revision === accepted
        ? previous.scanned_revision : 0;
      const rows = all(`SELECT * FROM backend_config_history WHERE owner_ref=? AND account_ref=? AND revision>? ORDER BY revision LIMIT ?`,
        head.owner_ref, head.account_ref, cursor, limit);
      if (!rows.length) return { scanned: 0, retired: 0 };
      let retired = 0, chain = previous?.chain_fingerprint || fingerprint([]);
      for (const row of rows) {
        if (row.revision === current.saved_revision || row.revision === accepted || get(`SELECT 1 FROM backend_operations
          WHERE owner_ref=? AND account_ref=? AND config_revision=? LIMIT 1`, row.owner_ref, row.account_ref, row.revision)) continue;
        run('INSERT INTO backend_config_retirement_callbacks VALUES(?,?,?,?,?)', row.owner_ref, row.account_ref, row.revision, runEpoch, connectionEpoch);
        const result = run('DELETE FROM backend_config_history WHERE owner_ref=? AND account_ref=? AND revision=?', row.owner_ref, row.account_ref, row.revision);
        if (Number(result.changes) !== 1) throw new Error('Configuration retirement did not remove the proven single revision');
        run('DELETE FROM backend_config_retirement_callbacks WHERE owner_ref=? AND account_ref=? AND revision=?', row.owner_ref, row.account_ref, row.revision);
        chain = fingerprint([chain, canonical(row)]); retired++;
      }
      run(`INSERT INTO backend_config_retirement VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,account_ref) DO UPDATE SET
        head_revision=excluded.head_revision,accepted_revision=excluded.accepted_revision,scanned_revision=excluded.scanned_revision,
        retired_count=excluded.retired_count,chain_fingerprint=excluded.chain_fingerprint,updated_at=excluded.updated_at`,
      head.owner_ref, head.account_ref, current.saved_revision, accepted, rows.at(-1).revision,
      (previous?.retired_count || 0) + retired, chain, store.nowIso());
      return { scanned: rows.length, retired, ownerRef: head.owner_ref, accountRef: head.account_ref };
    });
  }
  return Object.freeze({ retire });
}
