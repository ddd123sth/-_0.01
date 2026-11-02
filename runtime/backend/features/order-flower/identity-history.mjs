import { fingerprint, parseStored } from '../../common.mjs';
import { hashLedgerBytes } from '../../persistence/json-contract.mjs';
import { orderFlowerContext, orderFlowerContextKey, orderFlowerSourceProofValid } from './wire-facts.mjs';
import { orderFlowerLife } from './rpc-contract.mjs';

// Admission resolves only the current head; the durable head's cTime fence
// rejects a same/older server occurrence. Operation originals/semantic keys
// remain untouched. Keep the current and immediately preceding identity too.
export function createOrderFlowerIdentityHistory({ store }) {
  const { get, all, run, transaction } = store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_order_flower_identity_exit_callbacks(lifecycle_ref TEXT PRIMARY KEY,
    head_ref TEXT NOT NULL,head_source_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS backend_order_flower_identity_exit_progress(owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
      kind TEXT NOT NULL,box_id INTEGER NOT NULL,scanned_rowid INTEGER NOT NULL,retired_count INTEGER NOT NULL,
      chain_fingerprint TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref,kind,box_id));
    CREATE INDEX IF NOT EXISTS backend_order_flower_identity_exit_scan ON backend_order_flower_lives(owner_ref,subject_ref,kind,box_id);
    CREATE INDEX IF NOT EXISTS backend_operation_target_lifecycle ON backend_operation_targets(lifecycle_ref,operation_id);`);
  transaction(() => {
    const name = 'backend_order_flower_lives_no_delete', prior = get("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?", name)?.sql;
    if (prior?.includes('order identity exit requires newer durable head')) return;
    if (prior && !prior.includes('order flower lives are append only')) throw new Error('Unknown order identity exit guard');
    if (prior) store.db.exec('DROP TRIGGER ' + name);
    store.db.exec(`CREATE TRIGGER ${name} BEFORE DELETE ON backend_order_flower_lives WHEN OLD.identity_known!=1
      OR NOT EXISTS(SELECT 1 FROM backend_order_flower_identity_exit_callbacks p JOIN backend_order_flower_identity_heads h
        ON h.owner_ref=OLD.owner_ref AND h.subject_ref=OLD.subject_ref AND h.kind=OLD.kind AND h.box_id=OLD.box_id
        AND h.lifecycle_ref=p.head_ref AND h.source_json=p.head_source_json
        JOIN backend_order_flower_lives c ON c.lifecycle_ref=h.lifecycle_ref
        WHERE p.lifecycle_ref=OLD.lifecycle_ref AND c.identity_known=1 AND c.owner_ref=OLD.owner_ref AND c.subject_ref=OLD.subject_ref
          AND c.kind=OLD.kind AND c.box_id=OLD.box_id AND c.official_uid=OLD.official_uid AND c.c_time>OLD.c_time
          AND c.lifecycle_ref!=OLD.lifecycle_ref AND COALESCE(c.prior_lifecycle_ref,'')!=OLD.lifecycle_ref)
      OR EXISTS(SELECT 1 FROM backend_operation_targets t JOIN backend_operations o ON o.operation_id=t.operation_id
        WHERE t.lifecycle_ref=OLD.lifecycle_ref AND (o.write_slot!=0 OR NOT(o.business_verdict='confirmed'
          OR o.transport_state='not_sent' AND o.business_verdict='not_applicable')
          OR EXISTS(SELECT 1 FROM backend_operation_resources r WHERE r.operation_id=o.operation_id AND r.state!='released')))
      OR EXISTS(SELECT 1 FROM backend_operations o WHERE o.owner_ref=OLD.owner_ref AND o.subject_ref=OLD.subject_ref
        AND (o.write_slot=1 OR o.business_verdict IN('unknown','unverified')) AND instr(o.original_json,'"'||OLD.lifecycle_ref||'"')>0)
      BEGIN SELECT RAISE(ABORT,'order identity exit requires newer durable head'); END;`);
  });
  let owner = '', subject = '', kind = '', box = -1;
  const intact = row => {
    if (!row || row.identity_known !== 1 || !Number.isSafeInteger(row.c_time) || row.c_time < 1
        || !Number.isSafeInteger(row.official_uid) || row.official_uid < 1) return false;
    const content = parseStored(row.content_json, 'order identity exit content'), source = parseStored(row.first_source_json, 'order identity exit original source');
    return content.kind === row.kind && content.boxId === row.box_id && content.fields?.cTime === row.c_time
      && fingerprint(content) === row.content_fingerprint && fingerprint(source) === row.first_source_fingerprint
      && orderFlowerLife({ ownerRef: row.owner_ref, subjectRef: row.subject_ref }, row.kind, row.box_id, content.fields) === row.lifecycle_ref
      && source.kind === 'response' && source.transport === 'answered' && source.method === 'index.login'
      && Number.isSafeInteger(source.requestSequence) && source.requestSequence > 0 && orderFlowerSourceProofValid(source.version);
  };
  function retire() {
    const head = get(`SELECT * FROM backend_order_flower_identity_heads WHERE (owner_ref,subject_ref,kind,box_id)>(?,?,?,?)
      ORDER BY owner_ref,subject_ref,kind,box_id LIMIT 1`, owner, subject, kind, box)
      || get('SELECT * FROM backend_order_flower_identity_heads ORDER BY owner_ref,subject_ref,kind,box_id LIMIT 1');
    if (!head) return { retired: 0 }; owner = head.owner_ref; subject = head.subject_ref; kind = head.kind; box = head.box_id;
    return transaction(() => {
      const current = get('SELECT * FROM backend_order_flower_lives WHERE lifecycle_ref=?', head.lifecycle_ref);
      const source = parseStored(head.source_json, 'order identity exit head source'), context = orderFlowerContext(parseStored(head.context_json, 'order identity exit context'));
      if (!intact(current) || current.owner_ref !== owner || current.subject_ref !== subject || current.kind !== kind || current.box_id !== box
          || !context || context.ownerRef !== owner || context.subjectRef !== subject || fingerprint(source) !== head.source_fingerprint
          || source.kind !== 'response' || source.transport !== 'answered' || source.method !== 'index.login'
          || source.contextKey !== orderFlowerContextKey(context) || source.connectionEpoch !== context.connectionEpoch
          || !Number.isSafeInteger(source.requestSequence) || source.requestSequence < 1
          || source.version?.loginResponseRef !== source.responseRef || !orderFlowerSourceProofValid(source.version))
        return { retired: 0, held: 'current-identity-source-required' };
      const progress = get('SELECT * FROM backend_order_flower_identity_exit_progress WHERE owner_ref=? AND subject_ref=? AND kind=? AND box_id=?', owner, subject, kind, box), cursor = progress?.scanned_rowid || 0;
      const rows = all(`SELECT rowid AS scan_id,* FROM backend_order_flower_lives WHERE owner_ref=? AND subject_ref=? AND kind=? AND box_id=?
        AND rowid>? ORDER BY rowid LIMIT 16`, owner, subject, kind, box, cursor);
      if (!rows.length) {
        if (cursor) run('UPDATE backend_order_flower_identity_exit_progress SET scanned_rowid=0 WHERE owner_ref=? AND subject_ref=? AND kind=? AND box_id=?', owner, subject, kind, box);
        return { retired: 0 };
      }
      let retired = 0, chain = progress?.chain_fingerprint || fingerprint([]), scanned = cursor;
      const start = performance.now();
      for (const row of rows) {
        if (scanned !== cursor && performance.now() - start > 30) break;
        scanned = row.scan_id;
        if (!intact(row) || row.official_uid !== current.official_uid || row.c_time >= current.c_time
            || row.lifecycle_ref === current.lifecycle_ref || row.lifecycle_ref === current.prior_lifecycle_ref) continue;
        const related = all(`SELECT DISTINCT o.operation_id,o.owner_ref,o.subject_ref,o.write_slot,o.transport_state,o.business_verdict,
          o.original_json,o.original_fingerprint FROM backend_operation_targets t JOIN backend_operations o ON o.operation_id=t.operation_id
          WHERE t.lifecycle_ref=? ORDER BY o.operation_id LIMIT 33`, row.lifecycle_ref);
        if (related.length > 32 || related.some(op => op.owner_ref !== owner || op.subject_ref !== subject || op.write_slot !== 0
            || !(op.business_verdict === 'confirmed' || op.transport_state === 'not_sent' && op.business_verdict === 'not_applicable')
            || hashLedgerBytes(op.original_json) !== op.original_fingerprint
            || get('SELECT 1 FROM backend_operation_resources WHERE operation_id=? AND state!=\'released\' LIMIT 1', op.operation_id))
            || get(`SELECT 1 FROM backend_operations WHERE owner_ref=? AND subject_ref=? AND (write_slot=1 OR business_verdict IN('unknown','unverified'))
              AND instr(original_json,?)>0 LIMIT 1`, owner, subject, '"' + row.lifecycle_ref + '"')) continue;
        run('INSERT INTO backend_order_flower_identity_exit_callbacks VALUES(?,?,?)', row.lifecycle_ref, current.lifecycle_ref, head.source_json);
        if (Number(run('DELETE FROM backend_order_flower_lives WHERE lifecycle_ref=?', row.lifecycle_ref).changes) !== 1) throw new Error('Order identity single-row exit changed');
        run('DELETE FROM backend_order_flower_identity_exit_callbacks WHERE lifecycle_ref=?', row.lifecycle_ref);
        const { scan_id, ...original } = row; chain = fingerprint([chain, fingerprint(original)]); retired++;
      }
      run(`INSERT INTO backend_order_flower_identity_exit_progress VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref,kind,box_id) DO UPDATE SET
        scanned_rowid=excluded.scanned_rowid,retired_count=excluded.retired_count,chain_fingerprint=excluded.chain_fingerprint,updated_at=excluded.updated_at`,
      owner, subject, kind, box, scanned, (progress?.retired_count || 0) + retired, chain, store.nowIso());
      return { retired };
    });
  }
  return Object.freeze({ retire });
}
