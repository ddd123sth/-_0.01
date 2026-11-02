import { canonical, fingerprint, parseStored } from '../../common.mjs';
import { ledgerJsonFingerprint } from '../../persistence/json-contract.mjs';
import { customerContextKey } from '../customer/wire-facts.mjs';

const tables = ['backend_daily_art_unit_attempts', 'backend_daily_art_unit_recoveries', 'backend_daily_art_units'];
const validDay = key => typeof key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(key) &&
  Number.isFinite(Date.parse(key + 'T00:00:00Z')) && new Date(key + 'T00:00:00Z').toISOString().slice(0, 10) === key;

// An expired official business day cannot create new daily units. The ledger
// keeps every original operation; this retires only its known terminal private
// scheduling detail. Unknown/claimed units and unknown attempts remain intact.
export function createDailyArtHistory({ store, ledgerView, readLiveScope }) {
  const { get, all, run, transaction } = store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_daily_art_history_roots(owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    day_key TEXT NOT NULL,day_start_ms INTEGER NOT NULL,proof_json TEXT NOT NULL,proof_fingerprint TEXT NOT NULL,
    PRIMARY KEY(owner_ref,subject_ref));
    CREATE TABLE IF NOT EXISTS backend_daily_art_history_callbacks(owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,day_key TEXT NOT NULL,
      art_id INTEGER NOT NULL,ordinal INTEGER NOT NULL,root_fingerprint TEXT NOT NULL,
      PRIMARY KEY(owner_ref,subject_ref,day_key,art_id,ordinal));
    CREATE TABLE IF NOT EXISTS backend_daily_art_history_progress(owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,scanned_rowid INTEGER NOT NULL,
      units_retired INTEGER NOT NULL,attempts_retired INTEGER NOT NULL,recoveries_retired INTEGER NOT NULL,chain_fingerprint TEXT NOT NULL,
      updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref));
    CREATE INDEX IF NOT EXISTS backend_daily_art_recovery_scope ON backend_daily_art_unit_recoveries(owner_ref,subject_ref,day_key,art_id,ordinal);`);
  transaction(() => {
    for (const table of tables) {
      const name = table + '_no_delete', prior = get("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?", name)?.sql;
      if (prior?.includes('daily history exit requires proven closed day')) continue;
      const legacy = table === tables[0] ? 'daily art attempt history is retained' : table === tables[1]
        ? 'daily art unit recovery receipts are retained' : 'daily art unit history is retained';
      if (prior && !prior.includes(legacy)) throw new Error('Unknown daily art history guard');
      if (prior) store.db.exec('DROP TRIGGER ' + name);
      store.db.exec(`CREATE TRIGGER ${name} BEFORE DELETE ON ${table} WHEN
        NOT EXISTS(SELECT 1 FROM backend_daily_art_history_callbacks p JOIN backend_daily_art_history_roots r
          ON r.owner_ref=p.owner_ref AND r.subject_ref=p.subject_ref AND r.proof_fingerprint=p.root_fingerprint
          WHERE p.owner_ref=OLD.owner_ref AND p.subject_ref=OLD.subject_ref AND p.day_key=OLD.day_key
            AND p.art_id=OLD.art_id AND p.ordinal=OLD.ordinal AND OLD.day_key<r.day_key)
        OR NOT EXISTS(SELECT 1 FROM backend_operations o WHERE o.operation_id=OLD.operation_id AND o.owner_ref=OLD.owner_ref
          AND o.subject_ref=OLD.subject_ref AND o.feature_id='art.daily' AND o.write_slot=0
          AND (o.business_verdict='confirmed' ${table === tables[2] ? '' : "OR o.transport_state='not_sent' AND o.business_verdict='not_applicable'"}))
        ${table === tables[2] ? `OR OLD.state!='confirmed' OR EXISTS(SELECT 1 FROM backend_daily_art_unit_attempts a WHERE a.owner_ref=OLD.owner_ref
          AND a.subject_ref=OLD.subject_ref AND a.day_key=OLD.day_key AND a.art_id=OLD.art_id AND a.ordinal=OLD.ordinal)
          OR EXISTS(SELECT 1 FROM backend_daily_art_unit_recoveries a WHERE a.owner_ref=OLD.owner_ref AND a.subject_ref=OLD.subject_ref
            AND a.day_key=OLD.day_key AND a.art_id=OLD.art_id AND a.ordinal=OLD.ordinal)` : ''}
        BEGIN SELECT RAISE(ABORT,'daily history exit requires proven closed day'); END;`);
    }
  });
  function terminalOriginal(row, unit = false) {
    const op = ledgerView.operation(row.operation_id);
    if (!op || op.owner_ref !== row.owner_ref || op.subject_ref !== row.subject_ref || op.feature_id !== 'art.daily' || op.write_slot !== 0
        || !(op.business_verdict === 'confirmed' || !unit && op.transport_state === 'not_sent' && op.business_verdict === 'not_applicable')
        || ledgerJsonFingerprint(op.original) !== op.original_fingerprint || op.resources.some(r => r.state !== 'released')) return false;
    const evidence = get(`SELECT * FROM backend_operation_evidence WHERE operation_id=? AND evidence_key='finite-domain-preparation:v1'
      AND kind='finite-domain-preparation' AND source='backend/write-gateway/v2'`, row.operation_id);
    if (!evidence) return false;
    const payload = parseStored(evidence.payload_json, 'daily history original preparation'), p = payload?.preparation;
    return ledgerJsonFingerprint({ kind: evidence.kind, source: evidence.source, payload, observedAt: evidence.observed_at }) === evidence.payload_fingerprint
      && payload.domain === 'art-daily' && p?.dayKey === row.day_key && p.artId === row.art_id && p.unitOrdinal === row.ordinal && p.unitRef === row.unit_ref
      && op.original.targets?.some(t => t.lifecycleRef === row.unit_ref);
  }
  let owner = '', subject = '';
  function retire() {
    const scope = get(`SELECT DISTINCT owner_ref,subject_ref FROM backend_daily_art_units WHERE (owner_ref,subject_ref)>(?,?)
      ORDER BY owner_ref,subject_ref LIMIT 1`, owner, subject)
      || get('SELECT owner_ref,subject_ref FROM backend_daily_art_units ORDER BY owner_ref,subject_ref LIMIT 1');
    if (!scope) return { retired: 0 }; owner = scope.owner_ref; subject = scope.subject_ref;
    const live = readLiveScope(subject), context = live?.context, day = live?.day, clock = live?.clock;
    if (!context || context.ownerRef !== owner || context.subjectRef !== subject || !day?.known || !validDay(day.key)
        || day.source?.contextKey !== customerContextKey(context) || day.source.connectionEpoch !== context.connectionEpoch
        || !Number.isSafeInteger(day.source.officialUid) || day.source.officialUid <= 0 || !clock?.available
        || clock.connectionEpoch !== context.connectionEpoch || clock.lowerBoundMs < day.startMs || clock.upperBoundMs >= day.endMs)
      return { retired: 0, held: 'current-official-day-required' };
    return transaction(() => {
      const oldRoot = get('SELECT * FROM backend_daily_art_history_roots WHERE owner_ref=? AND subject_ref=?', owner, subject);
      if (oldRoot && (day.startMs < oldRoot.day_start_ms || day.startMs === oldRoot.day_start_ms && day.key !== oldRoot.day_key))
        return { retired: 0, held: 'official-day-not-monotonic' };
      if (oldRoot) {
        const original = parseStored(oldRoot.proof_json, 'daily history durable day root');
        if (fingerprint(original) !== oldRoot.proof_fingerprint || original.context?.ownerRef !== owner || original.context?.subjectRef !== subject
            || original.day?.key !== oldRoot.day_key || original.day?.startMs !== oldRoot.day_start_ms) throw new Error('Daily history root proof changed');
      }
      const advance = !oldRoot || day.startMs > oldRoot.day_start_ms;
      const proof = { version: 'daily-art/closed-official-day-history/v1', context, day }, proofJson = canonical(proof),
        rootHash = advance ? fingerprint(proof) : oldRoot.proof_fingerprint;
      if (advance) run(`INSERT INTO backend_daily_art_history_roots VALUES(?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref)
        DO UPDATE SET day_key=excluded.day_key,day_start_ms=excluded.day_start_ms,proof_json=excluded.proof_json,proof_fingerprint=excluded.proof_fingerprint`,
      owner, subject, day.key, day.startMs, proofJson, rootHash);
      if (!get(`SELECT 1 FROM backend_daily_art_units WHERE owner_ref=? AND subject_ref=? AND day_key<? AND state='confirmed' LIMIT 1`, owner, subject, day.key))
        return { retired: 0 };
      const progress = get('SELECT * FROM backend_daily_art_history_progress WHERE owner_ref=? AND subject_ref=?', owner, subject), cursor = progress?.scanned_rowid || 0;
      const rows = all(`SELECT rowid AS scan_id,* FROM backend_daily_art_units WHERE owner_ref=? AND subject_ref=? AND rowid>?
        ORDER BY rowid LIMIT 16`, owner, subject, cursor);
      if (!rows.length) {
        if (cursor) run('UPDATE backend_daily_art_history_progress SET scanned_rowid=0 WHERE owner_ref=? AND subject_ref=?', owner, subject);
        return { retired: 0 };
      }
      let units = 0, attempts = 0, recoveries = 0, chain = progress?.chain_fingerprint || fingerprint([]);
      for (const row of rows) {
        if (!validDay(row.day_key) || row.day_key >= day.key || row.state !== 'confirmed' || !terminalOriginal(row, true)) continue;
        run('INSERT INTO backend_daily_art_history_callbacks VALUES(?,?,?,?,?,?)', owner, subject, row.day_key, row.art_id, row.ordinal, rootHash);
        for (const [table, id] of [[tables[0], 'attempt_ref'], [tables[1], 'recovery_ref']]) {
          const children = all(`SELECT * FROM ${table} WHERE owner_ref=? AND subject_ref=? AND day_key=? AND art_id=? AND ordinal=? ORDER BY ${id} LIMIT ?`,
            owner, subject, row.day_key, row.art_id, row.ordinal, 16 - attempts - recoveries);
          for (const child of children) if (terminalOriginal(child)) {
            if (Number(run(`DELETE FROM ${table} WHERE ${id}=?`, child[id]).changes) !== 1) throw new Error('Daily art child exit proof changed');
            chain = fingerprint([chain, fingerprint(child)]); if (table === tables[0]) attempts++; else recoveries++;
          }
        }
        const args = [owner, subject, row.day_key, row.art_id, row.ordinal];
        if (!get('SELECT 1 FROM backend_daily_art_unit_attempts WHERE owner_ref=? AND subject_ref=? AND day_key=? AND art_id=? AND ordinal=? LIMIT 1', ...args)
            && !get('SELECT 1 FROM backend_daily_art_unit_recoveries WHERE owner_ref=? AND subject_ref=? AND day_key=? AND art_id=? AND ordinal=? LIMIT 1', ...args)) {
          if (Number(run('DELETE FROM backend_daily_art_units WHERE owner_ref=? AND subject_ref=? AND day_key=? AND art_id=? AND ordinal=?', ...args).changes) !== 1)
            throw new Error('Daily art unit exit proof changed');
          const { scan_id, ...original } = row; chain = fingerprint([chain, fingerprint(original)]); units++;
        }
        run('DELETE FROM backend_daily_art_history_callbacks WHERE owner_ref=? AND subject_ref=? AND day_key=? AND art_id=? AND ordinal=?', ...args);
      }
      run(`INSERT INTO backend_daily_art_history_progress VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref) DO UPDATE SET
        scanned_rowid=excluded.scanned_rowid,units_retired=excluded.units_retired,attempts_retired=excluded.attempts_retired,
        recoveries_retired=excluded.recoveries_retired,chain_fingerprint=excluded.chain_fingerprint,updated_at=excluded.updated_at`,
      owner, subject, rows.at(-1).scan_id, (progress?.units_retired || 0) + units, (progress?.attempts_retired || 0) + attempts,
      (progress?.recoveries_retired || 0) + recoveries, chain, store.nowIso());
      return { units, attempts, recoveries };
    });
  }
  return Object.freeze({ retire });
}
