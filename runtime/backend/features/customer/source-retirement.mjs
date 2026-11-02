import { fingerprint, parseStored } from '../../common.mjs';
import { customerContext, customerContextKey } from './wire-facts.mjs';

// The immutable wire observations remain elsewhere. Identity reconciliation
// reads only its current scope/slots/lives and the current response's replay /
// source-refinement record. A superseded response cannot change those heads.
export function createCustomerSourceRetirement({ store }) {
  const { get, all, run, transaction } = store;
  store.db.exec(`CREATE INDEX IF NOT EXISTS backend_customer_identity_observation_owner ON backend_customer_identity_observations(owner_ref,subject_ref);
    CREATE INDEX IF NOT EXISTS backend_customer_identity_refinement_parent ON backend_customer_identity_source_refinements(observation_key,refinement_ref);
    CREATE TABLE IF NOT EXISTS backend_customer_source_retirement_callbacks(observation_key TEXT PRIMARY KEY,source_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS backend_customer_source_retirement_progress(
      owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,connection_epoch INTEGER NOT NULL,request_sequence INTEGER NOT NULL,
      scanned_rowid INTEGER NOT NULL,retired_count INTEGER NOT NULL,refinements_retired INTEGER NOT NULL,chain_fingerprint TEXT NOT NULL,
      updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref));`);
  const proof = `EXISTS(SELECT 1 FROM backend_customer_source_retirement_callbacks p
    JOIN backend_customer_identity_scopes h ON h.owner_ref=o.owner_ref AND h.subject_ref=o.subject_ref AND h.last_source_json=p.source_json
    JOIN backend_subject_connection_epochs c ON c.subject_ref=h.subject_ref
    WHERE p.observation_key=o.observation_key AND CASE WHEN json_valid(o.source_json) AND json_valid(h.last_source_json) THEN
      json_type(o.source_json,'$.connectionEpoch')='integer' AND json_extract(o.source_json,'$.connectionEpoch')>0
      AND json_type(o.source_json,'$.requestSequence')='integer' AND json_extract(o.source_json,'$.requestSequence')>0
      AND json_type(h.last_source_json,'$.connectionEpoch')='integer' AND json_type(h.last_source_json,'$.requestSequence')='integer'
      AND c.connection_epoch>=json_extract(h.last_source_json,'$.connectionEpoch')
      AND (json_extract(o.source_json,'$.connectionEpoch')<json_extract(h.last_source_json,'$.connectionEpoch')
        OR json_extract(o.source_json,'$.connectionEpoch')=json_extract(h.last_source_json,'$.connectionEpoch')
        AND json_extract(o.source_json,'$.contextKey')=json_extract(h.last_source_json,'$.contextKey')
        AND json_extract(o.source_json,'$.requestSequence')<json_extract(h.last_source_json,'$.requestSequence')) ELSE 0 END)`;
  transaction(() => {
    for (const [table, name, condition, oldMessage] of [
      ['backend_customer_identity_observations','backend_customer_identity_observations_no_delete',
        `NOT EXISTS(SELECT 1 FROM backend_customer_identity_observations o WHERE o.observation_key=OLD.observation_key AND ${proof})
          OR EXISTS(SELECT 1 FROM backend_customer_identity_source_refinements r WHERE r.observation_key=OLD.observation_key)`, 'customer identity evidence is append only'],
      ['backend_customer_identity_source_refinements','backend_customer_identity_source_refinements_no_delete',
        `NOT EXISTS(SELECT 1 FROM backend_customer_identity_observations o WHERE o.observation_key=OLD.observation_key
          AND o.owner_ref=OLD.owner_ref AND o.subject_ref=OLD.subject_ref AND ${proof})`, 'customer identity source refinements are append only']
    ]) {
      const prior = get("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?", name)?.sql;
      if (prior && !prior.includes(oldMessage) && !prior.includes('customer superseded source exit requires durable head and callback'))
        throw new Error('Unknown customer source exit guard');
      if (prior?.includes('customer superseded source exit requires durable head and callback')) continue;
      if (prior) store.db.exec('DROP TRIGGER ' + name);
      store.db.exec(`CREATE TRIGGER ${name} BEFORE DELETE ON ${table} WHEN ${condition}
        BEGIN SELECT RAISE(ABORT,'customer superseded source exit requires durable head and callback'); END;`);
    }
  });
  let owner = '', subject = '';
  function retire({ limit = 16 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new RangeError('Customer source exit slice is out of bounds');
    const head = get(`SELECT * FROM backend_customer_identity_scopes WHERE (owner_ref,subject_ref)>(?,?) ORDER BY owner_ref,subject_ref LIMIT 1`, owner, subject)
      || get('SELECT * FROM backend_customer_identity_scopes ORDER BY owner_ref,subject_ref LIMIT 1');
    if (!head) return { scanned: 0, retired: 0 }; owner = head.owner_ref; subject = head.subject_ref;
    return transaction(() => {
      const current = get('SELECT * FROM backend_customer_identity_scopes WHERE owner_ref=? AND subject_ref=?', owner, subject);
      const source = parseStored(current.last_source_json, 'customer source retirement head'), context = customerContext(parseStored(current.context_json, 'customer source retirement context'));
      if (!context || context.ownerRef !== owner || context.subjectRef !== subject || source.contextKey !== customerContextKey(context)
          || source.connectionEpoch !== context.connectionEpoch || !Number.isSafeInteger(source.requestSequence) || source.requestSequence < 1
          || source.kind !== 'response' || source.transport !== 'answered') return { scanned: 0, retired: 0, held: 'source-not-proven' };
      const previous = get('SELECT * FROM backend_customer_source_retirement_progress WHERE owner_ref=? AND subject_ref=?', owner, subject);
      const cursor = previous?.connection_epoch === source.connectionEpoch && previous.request_sequence === source.requestSequence ? previous.scanned_rowid : 0;
      const rows = all(`SELECT rowid AS scan_id,* FROM backend_customer_identity_observations WHERE owner_ref=? AND subject_ref=?
        AND rowid>? ORDER BY rowid LIMIT ?`, owner, subject, cursor, limit);
      if (!rows.length) return { scanned: 0, retired: 0 };
      let retired = 0, refinements = 0, scannedThrough = cursor, chain = previous?.chain_fingerprint || fingerprint([]);
      for (const row of rows) {
        let old; try { old = parseStored(row.source_json, 'customer superseded source'); } catch { scannedThrough = row.scan_id; continue; }
        if (!Number.isSafeInteger(old?.connectionEpoch) || old.connectionEpoch < 1 || !Number.isSafeInteger(old.requestSequence) || old.requestSequence < 1
            || !(old.connectionEpoch < source.connectionEpoch || old.connectionEpoch === source.connectionEpoch
              && old.contextKey === source.contextKey && old.requestSequence < source.requestSequence)) { scannedThrough = row.scan_id; continue; }
        run('INSERT INTO backend_customer_source_retirement_callbacks VALUES(?,?)', row.observation_key, current.last_source_json);
        const children = all(`SELECT * FROM backend_customer_identity_source_refinements WHERE observation_key=? ORDER BY refinement_ref LIMIT ?`, row.observation_key, 32 - refinements);
        for (const child of children) {
          const changed = run('DELETE FROM backend_customer_identity_source_refinements WHERE refinement_ref=? AND observation_key=?', child.refinement_ref, row.observation_key);
          if (Number(changed.changes) !== 1) throw new Error('Customer source refinement single-row exit changed');
          chain = fingerprint([chain, fingerprint(child)]); refinements++;
        }
        const remaining = get('SELECT 1 FROM backend_customer_identity_source_refinements WHERE observation_key=? LIMIT 1', row.observation_key);
        if (!remaining) {
          const changed = run('DELETE FROM backend_customer_identity_observations WHERE observation_key=? AND owner_ref=? AND subject_ref=?', row.observation_key, owner, subject);
          if (Number(changed.changes) !== 1) throw new Error('Customer source single-row exit changed');
          const { scan_id, ...original } = row; chain = fingerprint([chain, fingerprint(original)]); retired++; scannedThrough = row.scan_id;
        }
        run('DELETE FROM backend_customer_source_retirement_callbacks WHERE observation_key=?', row.observation_key);
        if (remaining || refinements >= 32) break;
      }
      run(`INSERT INTO backend_customer_source_retirement_progress VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref) DO UPDATE SET
        connection_epoch=excluded.connection_epoch,request_sequence=excluded.request_sequence,scanned_rowid=excluded.scanned_rowid,
        retired_count=excluded.retired_count,refinements_retired=excluded.refinements_retired,chain_fingerprint=excluded.chain_fingerprint,updated_at=excluded.updated_at`,
        owner, subject, source.connectionEpoch, source.requestSequence, scannedThrough, (previous?.retired_count || 0) + retired,
        (previous?.refinements_retired || 0) + refinements, chain, store.nowIso());
      return { scanned: rows.length, retired, refinements };
    });
  }
  return Object.freeze({ retire });
}
