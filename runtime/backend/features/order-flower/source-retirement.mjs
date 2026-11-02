import { fingerprint, parseStored } from '../../common.mjs';
import { hashLedgerBytes } from '../../persistence/json-contract.mjs';
import { orderFlowerContext, orderFlowerContextKey } from './wire-facts.mjs';

// All historical readers (delivery-accounting, after-close verification and
// audit projection) belong to an operation's original CE or a verification
// lease's original/new CE. Preserve those entire connections, not merely
// references discovered by scanning JSON. Identity lives contain their own
// immutable first-source proof. A newer verified read head fences replay of
// all remaining, unreferenced connections.
export function createOrderFlowerSourceRetirement({ store }) {
  const { get, all, run, transaction } = store;
  store.db.exec(`CREATE INDEX IF NOT EXISTS backend_order_flower_source_scope ON backend_order_flower_observations(owner_ref,account_ref,subject_ref);
    CREATE INDEX IF NOT EXISTS backend_order_flower_revalidation_parent ON backend_order_flower_compatibility_revalidations(observation_ref,revalidation_ref);
    CREATE TABLE IF NOT EXISTS backend_order_flower_source_exit_callbacks(observation_ref TEXT PRIMARY KEY,head_fingerprint TEXT NOT NULL,connection_epoch INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS backend_order_flower_source_exit_progress(owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
      connection_epoch INTEGER NOT NULL,scanned_rowid INTEGER NOT NULL,retired_count INTEGER NOT NULL,revalidations_retired INTEGER NOT NULL,
      chain_fingerprint TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,account_ref,subject_ref));`);
  if (!all('PRAGMA table_info(backend_order_flower_source_exit_callbacks)').some(c=>c.name==='head_account_ref'))
    store.db.exec('ALTER TABLE backend_order_flower_source_exit_callbacks ADD COLUMN head_account_ref TEXT');
  const sameSubjectReplacement = `EXISTS(SELECT 1 FROM backend_accounts old JOIN backend_accounts fresh
    ON fresh.owner_ref=old.owner_ref AND fresh.subject_ref=old.subject_ref AND fresh.server_id=old.server_id
    WHERE old.owner_ref=o.owner_ref AND CAST(old.account_id AS TEXT)=o.account_ref AND old.subject_ref=o.subject_ref
      AND old.removed_at IS NOT NULL AND fresh.removed_at IS NULL AND CAST(fresh.account_id AS TEXT)=h.account_ref
      AND fresh.verification_ref IS NOT NULL AND length(fresh.verification_ref)>0
      AND fresh.username_cipher IS NOT NULL AND fresh.credential_cipher IS NOT NULL
      AND CASE WHEN json_valid(old.profile_json) AND json_valid(fresh.profile_json) AND json_valid(h.model_json) THEN
        json_type(old.profile_json,'$.uid')='integer' AND json_extract(old.profile_json,'$.uid')>0
        AND json_extract(old.profile_json,'$.uid')=json_extract(fresh.profile_json,'$.uid')
        AND json_extract(old.profile_json,'$.uid')=json_extract(h.model_json,'$.identity.uid.value') ELSE 0 END)`;
  const proof = `EXISTS(SELECT 1 FROM backend_order_flower_source_exit_callbacks p
    JOIN backend_order_flower_heads h ON h.owner_ref=o.owner_ref AND h.account_ref=COALESCE(p.head_account_ref,o.account_ref)
      AND h.subject_ref=o.subject_ref AND h.model_fingerprint=p.head_fingerprint
    JOIN backend_subject_connection_epochs c ON c.subject_ref=o.subject_ref
    WHERE p.observation_ref=o.observation_ref AND o.connection_epoch>0 AND o.connection_epoch<p.connection_epoch
      AND (h.account_ref=o.account_ref OR ${sameSubjectReplacement})
      AND p.connection_epoch<=c.connection_epoch)
    AND NOT EXISTS(SELECT 1 FROM backend_operations b WHERE b.subject_ref=o.subject_ref AND b.connection_epoch=o.connection_epoch)
    AND NOT EXISTS(SELECT 1 FROM backend_session_verification_leases v WHERE v.subject_ref=o.subject_ref AND v.original_connection_epoch=o.connection_epoch)
    AND NOT EXISTS(SELECT 1 FROM backend_session_verification_leases v WHERE v.subject_ref=o.subject_ref AND v.new_connection_epoch=o.connection_epoch)`;
  transaction(() => {
    for (const [table, condition] of [
      ['backend_order_flower_observations', `NOT EXISTS(SELECT 1 FROM backend_order_flower_observations o WHERE o.observation_ref=OLD.observation_ref AND ${proof})
        OR EXISTS(SELECT 1 FROM backend_order_flower_compatibility_revalidations r WHERE r.observation_ref=OLD.observation_ref)`],
      ['backend_order_flower_compatibility_revalidations', `NOT EXISTS(SELECT 1 FROM backend_order_flower_observations o WHERE o.observation_ref=OLD.observation_ref AND ${proof})`]
    ]) {
      const name = table + '_no_delete', prior = get("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?", name)?.sql;
      if (prior?.includes('order source exit requires verified roster root and unreferenced superseded connection')) continue;
      const legacy = table === 'backend_order_flower_observations' ? 'order flower observations are append only' : 'order compatibility revalidations are append only';
      if (prior && !prior.includes(legacy) && !prior.includes('order source exit requires unreferenced superseded connection')) throw new Error('Unknown order source exit guard');
      if (prior) store.db.exec('DROP TRIGGER ' + name);
      store.db.exec(`CREATE TRIGGER ${name} BEFORE DELETE ON ${table} WHEN ${condition}
        BEGIN SELECT RAISE(ABORT,'order source exit requires verified roster root and unreferenced superseded connection'); END;`);
    }
  });
  // Cache only validated scalar head summaries, never the multi-MiB model.
  // Every use still hashes fresh stored bytes and reads current global CE.
  const validatedHeads = new Map();
  function headEpoch(head, expectedUid = null) {
    if (!head) return null;
    const key = JSON.stringify([head.owner_ref, head.account_ref, head.subject_ref]), rawHash = hashLedgerBytes(head.model_json);
    const cached = validatedHeads.get(key);
    if (cached?.rawHash === rawHash && cached.fingerprint === head.model_fingerprint && cached.contextKey === head.context_key)
      return expectedUid===null||cached.uid===expectedUid?cached.ce:null;
    const model = parseStored(head.model_json, 'order source exit recovery head'), context = orderFlowerContext(model?.context), ce = context?.connectionEpoch;
    if (fingerprint(model) !== head.model_fingerprint || model.identity?.verified !== true || context?.ownerRef !== head.owner_ref
        || context?.accountRef !== head.account_ref || context?.subjectRef !== head.subject_ref || !Number.isSafeInteger(ce) || ce < 1
        || orderFlowerContextKey(context) !== head.context_key || model.identity.source?.contextKey !== head.context_key
        || model.identity.source?.method !== 'index.login' || model.identity.source?.transport !== 'answered'
        || model.identity.source?.connectionEpoch !== ce || expectedUid!==null&&model.identity.uid?.value!==expectedUid) return null;
    if (!validatedHeads.has(key) && validatedHeads.size >= 32) validatedHeads.delete(validatedHeads.keys().next().value);
    validatedHeads.set(key, { rawHash, fingerprint: head.model_fingerprint, contextKey: head.context_key, ce,uid:model.identity.uid?.value });
    return ce;
  }
  let owner = '', account = '', subject = '';
  function retire({ limit = 16 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new RangeError('Order source exit slice is out of bounds');
    const h = get(`SELECT owner_ref,account_ref,subject_ref FROM backend_order_flower_heads WHERE (owner_ref,account_ref,subject_ref)>(?,?,?) ORDER BY owner_ref,account_ref,subject_ref LIMIT 1`, owner, account, subject)
      || get('SELECT owner_ref,account_ref,subject_ref FROM backend_order_flower_heads ORDER BY owner_ref,account_ref,subject_ref LIMIT 1');
    if (!h) return { scanned: 0, retired: 0 }; owner = h.owner_ref; account = h.account_ref; subject = h.subject_ref;
    return transaction(() => {
      let head = get('SELECT * FROM backend_order_flower_heads WHERE owner_ref=? AND account_ref=? AND subject_ref=?', owner, account, subject);
      // A normal delete/readd retains the subject but changes accountRef. The
      // archived partition cannot advance its own head. A verified replacement
      // may supply the newer read fence; original operations/leases still pin
      // their complete old connections, irrespective of accountRef.
      const archived=get('SELECT profile_json,server_id,removed_at FROM backend_accounts WHERE owner_ref=? AND account_id=? AND subject_ref=?',owner,Number(account),subject);
      if (archived?.removed_at) {
        const replacements=all(`SELECT account_id,profile_json,server_id FROM backend_accounts WHERE owner_ref=? AND subject_ref=?
          AND removed_at IS NULL AND verification_ref IS NOT NULL AND length(verification_ref)>0
          AND username_cipher IS NOT NULL AND credential_cipher IS NOT NULL LIMIT 2`,owner,subject);
        if (replacements.length===1) {
          const fresh=replacements[0],oldProfile=parseStored(archived.profile_json,'archived source owner'),freshProfile=parseStored(fresh.profile_json,'replacement source owner');
          const candidate=get('SELECT * FROM backend_order_flower_heads WHERE owner_ref=? AND account_ref=? AND subject_ref=?',owner,String(fresh.account_id),subject);
          if (candidate&&Number.isSafeInteger(oldProfile.uid)&&oldProfile.uid>0&&oldProfile.uid===freshProfile.uid
              &&fresh.server_id===archived.server_id) {
            const candidateCe=headEpoch(candidate,oldProfile.uid),oldCe=headEpoch(head);
            if (candidateCe!==null&&(oldCe===null||candidateCe>oldCe)) head=candidate;
          }
        }
      }
      const ce = headEpoch(head);
      const global = get('SELECT connection_epoch FROM backend_subject_connection_epochs WHERE subject_ref=?', subject)?.connection_epoch;
      if (ce === null || !Number.isSafeInteger(global) || global < ce) return { scanned: 0, retired: 0, held: 'head-not-proven' };
      const prior = get('SELECT * FROM backend_order_flower_source_exit_progress WHERE owner_ref=? AND account_ref=? AND subject_ref=?', owner, account, subject);
      // This is a physical scan cursor, never a success/retirement authority.
      // Do not restart at a protected historical prefix on every new login.
      // Finish the pass, then revisit old retained rows if the head advanced.
      const cursor = prior?.scanned_rowid ?? 0, passCe = prior?.connection_epoch ?? ce;
      const rows = all(`SELECT rowid AS scan_id,* FROM backend_order_flower_observations WHERE owner_ref=? AND account_ref=? AND subject_ref=?
        AND rowid>? ORDER BY rowid LIMIT ?`, owner, account, subject, cursor, limit);
      if (!rows.length) {
        if (ce > passCe) run(`UPDATE backend_order_flower_source_exit_progress SET connection_epoch=?,scanned_rowid=0,updated_at=?
          WHERE owner_ref=? AND account_ref=? AND subject_ref=?`, ce, store.nowIso(), owner, account, subject);
        return { scanned: 0, retired: 0 };
      }
      let retired = 0, children = 0, through = cursor, chain = prior?.chain_fingerprint || fingerprint([]);
      for (const row of rows) {
        if (!Number.isSafeInteger(row.connection_epoch) || row.connection_epoch < 1 || row.connection_epoch >= ce
            || get('SELECT 1 FROM backend_operations WHERE subject_ref=? AND connection_epoch=? LIMIT 1', subject, row.connection_epoch)
            || get('SELECT 1 FROM backend_session_verification_leases WHERE subject_ref=? AND original_connection_epoch=? LIMIT 1', subject, row.connection_epoch)
            || get('SELECT 1 FROM backend_session_verification_leases WHERE subject_ref=? AND new_connection_epoch=? LIMIT 1', subject, row.connection_epoch)) { through = row.scan_id; continue; }
        let frame; try { frame = parseStored(row.payload_json, 'unreferenced order source'); } catch { through = row.scan_id; continue; }
        if (fingerprint(frame) !== row.payload_fingerprint || frame.observationRef !== row.observation_ref || frame.context?.ownerRef !== owner
            || frame.context?.accountRef !== account || frame.context?.subjectRef !== subject || frame.context?.connectionEpoch !== row.connection_epoch
            || frame.source?.connectionEpoch !== row.connection_epoch || frame.source?.responseRef !== row.response_ref
            || fingerprint(frame.payload) !== frame.payloadFingerprint) { through = row.scan_id; continue; }
        const revalidations = all('SELECT * FROM backend_order_flower_compatibility_revalidations WHERE observation_ref=? ORDER BY revalidation_ref LIMIT ?', row.observation_ref, 16 - children);
        let valid = true;
        for (const child of revalidations) {
          let decoded; try { decoded = parseStored(child.payload_json, 'unreferenced order compatibility source'); } catch { valid = false; break; }
          if (decoded.observationRef !== row.observation_ref || decoded.context?.ownerRef !== owner || decoded.context?.accountRef !== account
              || decoded.context?.subjectRef !== subject || decoded.context?.connectionEpoch !== row.connection_epoch
              || decoded.source?.connectionEpoch !== row.connection_epoch || decoded.source?.responseRef !== row.response_ref
              || fingerprint(decoded.payload) !== child.payload_fingerprint || child.payload_fingerprint !== frame.payloadFingerprint) { valid = false; break; }
        }
        if (!valid) { through = row.scan_id; continue; }
        run('INSERT INTO backend_order_flower_source_exit_callbacks(observation_ref,head_fingerprint,connection_epoch,head_account_ref) VALUES(?,?,?,?)', row.observation_ref, head.model_fingerprint, ce,head.account_ref);
        for (const child of revalidations) {
          const result = run('DELETE FROM backend_order_flower_compatibility_revalidations WHERE revalidation_ref=? AND observation_ref=?', child.revalidation_ref, row.observation_ref);
          if (Number(result.changes) !== 1) throw new Error('Order compatibility single-row exit proof changed');
          chain = fingerprint([chain, fingerprint(child)]); children++;
        }
        const remaining = get('SELECT 1 FROM backend_order_flower_compatibility_revalidations WHERE observation_ref=? LIMIT 1', row.observation_ref);
        if (!remaining) {
          const result = run('DELETE FROM backend_order_flower_observations WHERE observation_ref=? AND owner_ref=? AND account_ref=? AND subject_ref=?', row.observation_ref, owner, account, subject);
          if (Number(result.changes) !== 1) throw new Error('Order source single-row exit proof changed');
          const { scan_id, ...original } = row; chain = fingerprint([chain, fingerprint(original)]); retired++; through = row.scan_id;
        }
        run('DELETE FROM backend_order_flower_source_exit_callbacks WHERE observation_ref=?', row.observation_ref);
        if (remaining || children >= 16) break;
      }
      run(`INSERT INTO backend_order_flower_source_exit_progress VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,account_ref,subject_ref)
        DO UPDATE SET connection_epoch=excluded.connection_epoch,scanned_rowid=excluded.scanned_rowid,retired_count=excluded.retired_count,
        revalidations_retired=excluded.revalidations_retired,chain_fingerprint=excluded.chain_fingerprint,updated_at=excluded.updated_at`,
      owner, account, subject, passCe, through, (prior?.retired_count || 0) + retired, (prior?.revalidations_retired || 0) + children, chain, store.nowIso());
      return { scanned: rows.length, retired, revalidations: children };
    });
  }
  return Object.freeze({ retire });
}
