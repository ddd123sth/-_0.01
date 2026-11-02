import { fingerprint, parseStored } from '../../common.mjs';
import { customerContext, customerContextKey } from './wire-facts.mjs';
import { createCustomerSourceRetirement } from './source-retirement.mjs';

// These two events are redundant observations, not customer occurrences or
// absence boundaries. Admission reads lives/slots/scopes; immutable operation
// and wire evidence never read this table. A newer durable source fences replay
// before event() can run again, including after a subject's connection changes.
export function createCustomerHistoryRetirement({ store }) {
  const sources = createCustomerSourceRetirement({ store }); let turn = 0;
  const { get, all, run, transaction } = store;
  store.db.exec(`CREATE INDEX IF NOT EXISTS backend_customer_identity_event_owner ON backend_customer_identity_events(owner_ref,subject_ref);
    CREATE TABLE IF NOT EXISTS backend_customer_event_retirement_callbacks(event_key TEXT PRIMARY KEY,source_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS backend_customer_event_retirement_progress(
      owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,connection_epoch INTEGER NOT NULL,request_sequence INTEGER NOT NULL,
      scanned_rowid INTEGER NOT NULL,retired_count INTEGER NOT NULL,chain_fingerprint TEXT NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY(owner_ref,subject_ref));`);
  const guard = `CREATE TRIGGER backend_customer_identity_events_no_delete BEFORE DELETE ON backend_customer_identity_events
    WHEN OLD.event_kind NOT IN('row-observed','row-unreadable') OR NOT EXISTS(
      SELECT 1 FROM backend_customer_event_retirement_callbacks p JOIN backend_customer_identity_scopes h
        ON h.owner_ref=OLD.owner_ref AND h.subject_ref=OLD.subject_ref AND h.last_source_json=p.source_json
      JOIN backend_subject_connection_epochs c ON c.subject_ref=h.subject_ref
      WHERE p.event_key=OLD.event_key AND CASE WHEN json_valid(OLD.payload_json) AND json_valid(h.last_source_json) THEN
        json_type(OLD.payload_json,'$.source.connectionEpoch')='integer'
        AND json_type(OLD.payload_json,'$.source.requestSequence')='integer'
        AND json_extract(OLD.payload_json,'$.source.connectionEpoch')>0
        AND json_extract(OLD.payload_json,'$.source.requestSequence')>0
        AND json_type(h.last_source_json,'$.connectionEpoch')='integer'
        AND json_type(h.last_source_json,'$.requestSequence')='integer'
        AND c.connection_epoch>=json_extract(h.last_source_json,'$.connectionEpoch')
        AND (json_extract(OLD.payload_json,'$.source.connectionEpoch')<json_extract(h.last_source_json,'$.connectionEpoch')
          OR json_extract(OLD.payload_json,'$.source.connectionEpoch')=json_extract(h.last_source_json,'$.connectionEpoch')
          AND json_extract(OLD.payload_json,'$.source.contextKey')=json_extract(h.last_source_json,'$.contextKey')
          AND json_extract(OLD.payload_json,'$.source.requestSequence')<json_extract(h.last_source_json,'$.requestSequence'))
      ELSE 0 END)
    BEGIN SELECT RAISE(ABORT,'customer redundant event exit requires newer durable source and callback'); END;`;
  transaction(() => {
    const prior = get("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='backend_customer_identity_events_no_delete'")?.sql;
    if (prior?.includes('customer identity evidence is append only')) {
      run('DROP TRIGGER backend_customer_identity_events_no_delete'); store.db.exec(guard);
    } else if (!prior) store.db.exec(guard);
    else if (!prior.includes('customer redundant event exit requires newer durable source and callback')) throw new Error('Unknown customer event exit guard');
  });
  let owner = '', subject = '';
  function retire({ limit = 16 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new RangeError('Customer event exit slice is out of bounds');
    const head = get(`SELECT * FROM backend_customer_identity_scopes WHERE (owner_ref,subject_ref)>(?,?) ORDER BY owner_ref,subject_ref LIMIT 1`, owner, subject)
      || get('SELECT * FROM backend_customer_identity_scopes ORDER BY owner_ref,subject_ref LIMIT 1');
    if (!head) return { scanned: 0, retired: 0 }; owner = head.owner_ref; subject = head.subject_ref;
    return transaction(() => {
      const current = get('SELECT * FROM backend_customer_identity_scopes WHERE owner_ref=? AND subject_ref=?', owner, subject);
      const source = parseStored(current.last_source_json, 'customer event retirement source'), context = customerContext(parseStored(current.context_json, 'customer event retirement context'));
      if (!context || context.ownerRef !== owner || context.subjectRef !== subject || source.contextKey !== customerContextKey(context)
          || source.connectionEpoch !== context.connectionEpoch || !Number.isSafeInteger(source.requestSequence) || source.requestSequence < 1
          || source.kind !== 'response' || source.transport !== 'answered') return { scanned: 0, retired: 0, held: 'source-not-proven' };
      const previous = get('SELECT * FROM backend_customer_event_retirement_progress WHERE owner_ref=? AND subject_ref=?', owner, subject);
      const cursor = previous?.connection_epoch === source.connectionEpoch && previous.request_sequence === source.requestSequence ? previous.scanned_rowid : 0;
      const rows = all(`SELECT rowid AS scan_id,* FROM backend_customer_identity_events WHERE owner_ref=? AND subject_ref=?
        AND rowid>? AND event_kind IN('row-observed','row-unreadable') ORDER BY rowid LIMIT ?`, owner, subject, cursor, limit);
      if (!rows.length) return { scanned: 0, retired: 0 };
      let retired = 0, chain = previous?.chain_fingerprint || fingerprint([]);
      for (const row of rows) {
        let old; try { old = parseStored(row.payload_json, 'customer redundant event').source; } catch { continue; }
        if (!Number.isSafeInteger(old?.connectionEpoch) || old.connectionEpoch < 1 || !Number.isSafeInteger(old.requestSequence) || old.requestSequence < 1
            || !(old.connectionEpoch < source.connectionEpoch || old.connectionEpoch === source.connectionEpoch
              && old.contextKey === source.contextKey && old.requestSequence < source.requestSequence)) continue;
        run('INSERT INTO backend_customer_event_retirement_callbacks VALUES(?,?)', row.event_key, current.last_source_json);
        const result = run('DELETE FROM backend_customer_identity_events WHERE event_key=? AND owner_ref=? AND subject_ref=?', row.event_key, owner, subject);
        if (Number(result.changes) !== 1) throw new Error('Customer single-event exit proof changed');
        run('DELETE FROM backend_customer_event_retirement_callbacks WHERE event_key=?', row.event_key);
        const { scan_id, ...original } = row;
        chain = fingerprint([chain, fingerprint(original)]); retired++;
      }
      run(`INSERT INTO backend_customer_event_retirement_progress VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref) DO UPDATE SET
        connection_epoch=excluded.connection_epoch,request_sequence=excluded.request_sequence,scanned_rowid=excluded.scanned_rowid,
        retired_count=excluded.retired_count,chain_fingerprint=excluded.chain_fingerprint,updated_at=excluded.updated_at`,
        owner, subject, source.connectionEpoch, source.requestSequence, rows.at(-1).scan_id, (previous?.retired_count || 0) + retired, chain, store.nowIso());
      return { scanned: rows.length, retired };
    });
  }
  return Object.freeze({ retire: options => ++turn % 2 ? retire(options) : sources.retire(options) });
}
