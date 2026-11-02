import { canonical, fingerprint, parseStored } from '../../common.mjs';
import { hashLedgerBytes } from '../../persistence/json-contract.mjs';
import { orderFlowerContext, orderFlowerContextKey } from './wire-facts.mjs';

// Auxiliary historical audits read only an operation's original/new lease CE.
// Keep those whole connections, including unknowns and released leases. The
// durable current head is the recovery root for dependency-free older reads.
export function createOrderFlowerAuxiliarySourceRetirement({ store }) {
  const { get, all, run, transaction } = store;
  const referenced = (subject, ce) => !!(get('SELECT 1 FROM backend_operations WHERE subject_ref=? AND connection_epoch=? LIMIT 1', subject, ce)
    || get('SELECT 1 FROM backend_session_verification_leases WHERE subject_ref=? AND original_connection_epoch=? LIMIT 1', subject, ce)
    || get('SELECT 1 FROM backend_session_verification_leases WHERE subject_ref=? AND new_connection_epoch=? LIMIT 1', subject, ce));
  store.db.exec(`CREATE INDEX IF NOT EXISTS backend_order_aux_source_scope ON backend_order_flower_auxiliary_observations(owner_ref,account_ref,subject_ref);
    CREATE INDEX IF NOT EXISTS backend_order_aux_revalidation_parent ON backend_order_flower_auxiliary_compatibility_revalidations(observation_ref,revalidation_ref);
    CREATE TABLE IF NOT EXISTS backend_order_aux_source_exit_callbacks(observation_ref TEXT PRIMARY KEY,head_fingerprint TEXT NOT NULL,connection_epoch INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS backend_order_aux_source_exit_progress(owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
      connection_epoch INTEGER NOT NULL,scanned_rowid INTEGER NOT NULL,retired_count INTEGER NOT NULL,revalidations_retired INTEGER NOT NULL,
      chain_fingerprint TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,account_ref,subject_ref));`);
  const proof = `EXISTS(SELECT 1 FROM backend_order_aux_source_exit_callbacks p
    JOIN backend_order_flower_auxiliary_heads h ON h.owner_ref=o.owner_ref AND h.account_ref=o.account_ref AND h.subject_ref=o.subject_ref AND h.payload_fingerprint=p.head_fingerprint
    JOIN backend_subject_connection_epochs c ON c.subject_ref=o.subject_ref
    WHERE p.observation_ref=o.observation_ref AND o.connection_epoch>0 AND o.connection_epoch<p.connection_epoch
      AND p.connection_epoch<=c.connection_epoch)
    AND NOT EXISTS(SELECT 1 FROM backend_operations b WHERE b.subject_ref=o.subject_ref AND b.connection_epoch=o.connection_epoch)
    AND NOT EXISTS(SELECT 1 FROM backend_session_verification_leases v WHERE v.subject_ref=o.subject_ref AND v.original_connection_epoch=o.connection_epoch)
    AND NOT EXISTS(SELECT 1 FROM backend_session_verification_leases v WHERE v.subject_ref=o.subject_ref AND v.new_connection_epoch=o.connection_epoch)`;
  transaction(() => {
    for (const [table, legacy, condition] of [
      ['backend_order_flower_auxiliary_observations', 'order flower auxiliary observations are append only',
        `NOT EXISTS(SELECT 1 FROM backend_order_flower_auxiliary_observations o WHERE o.observation_ref=OLD.observation_ref AND ${proof})
          OR EXISTS(SELECT 1 FROM backend_order_flower_auxiliary_compatibility_revalidations r WHERE r.observation_ref=OLD.observation_ref)`],
      ['backend_order_flower_auxiliary_compatibility_revalidations', 'order flower auxiliary revalidations are append only',
        `NOT EXISTS(SELECT 1 FROM backend_order_flower_auxiliary_observations o WHERE o.observation_ref=OLD.observation_ref AND ${proof})`]
    ]) {
      const name = table + '_no_delete', prior = get("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?", name)?.sql;
      if (prior?.includes('auxiliary source exit requires unreferenced superseded connection')) continue;
      if (prior && !prior.includes(legacy)) throw new Error('Unknown auxiliary source exit guard');
      if (prior) store.db.exec('DROP TRIGGER ' + name);
      store.db.exec(`CREATE TRIGGER ${name} BEFORE DELETE ON ${table} WHEN ${condition}
        BEGIN SELECT RAISE(ABORT,'auxiliary source exit requires unreferenced superseded connection'); END;`);
    }
  });
  const heads = new Map();
  function headEpoch(head) {
    const key = canonical([head.owner_ref, head.account_ref, head.subject_ref]);
    const rawHash = hashLedgerBytes(canonical([head.payload_json, head.context_json, head.source_json]));
    const cached = heads.get(key);
    if (cached?.rawHash === rawHash && cached.fingerprint === head.payload_fingerprint && cached.contextKey === head.context_key) return cached.ce;
    const payload = parseStored(head.payload_json, 'auxiliary exit head'), context = orderFlowerContext(parseStored(head.context_json, 'auxiliary exit context')),
      source = parseStored(head.source_json, 'auxiliary exit source'), ce = context?.connectionEpoch;
    if (fingerprint(payload) !== head.payload_fingerprint || !context || context.ownerRef !== head.owner_ref || context.accountRef !== head.account_ref
        || context.subjectRef !== head.subject_ref || orderFlowerContextKey(context) !== head.context_key || !Number.isSafeInteger(ce) || ce < 1
        || canonical(source.context) !== canonical(context) || source.source !== 'response' || source.transport !== 'answered'
        || source.connectionEpoch !== ce || source.envelopeOk !== true || source.dsName !== 'G.ISyncData'
        || !Number.isSafeInteger(source.officialUid) || source.officialUid < 1 || payload.inventory?.known !== true
        || payload.inventory.value?.officialUid !== source.officialUid || !source.versionEvidence?.loginResponseRef) return null;
    if (!heads.has(key) && heads.size >= 32) heads.delete(heads.keys().next().value);
    heads.set(key, { rawHash, fingerprint: head.payload_fingerprint, contextKey: head.context_key, ce });
    return ce;
  }
  let owner = '', account = '', subject = '';
  function retire({ limit = 16 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new RangeError('Auxiliary exit slice is out of bounds');
    const h = get(`SELECT owner_ref,account_ref,subject_ref FROM backend_order_flower_auxiliary_heads WHERE (owner_ref,account_ref,subject_ref)>(?,?,?)
      ORDER BY owner_ref,account_ref,subject_ref LIMIT 1`, owner, account, subject)
      || get('SELECT owner_ref,account_ref,subject_ref FROM backend_order_flower_auxiliary_heads ORDER BY owner_ref,account_ref,subject_ref LIMIT 1');
    if (!h) return { scanned: 0, retired: 0 }; owner = h.owner_ref; account = h.account_ref; subject = h.subject_ref;
    return transaction(() => {
      const head = get('SELECT * FROM backend_order_flower_auxiliary_heads WHERE owner_ref=? AND account_ref=? AND subject_ref=?', owner, account, subject), ce = headEpoch(head);
      const global = get('SELECT connection_epoch FROM backend_subject_connection_epochs WHERE subject_ref=?', subject)?.connection_epoch;
      if (ce === null || !Number.isSafeInteger(global) || global < ce) return { scanned: 0, retired: 0, held: 'head-not-proven' };
      const prior = get('SELECT * FROM backend_order_aux_source_exit_progress WHERE owner_ref=? AND account_ref=? AND subject_ref=?', owner, account, subject),
        cursor = prior?.scanned_rowid ?? 0, passCe = prior?.connection_epoch ?? ce,
        rows = all(`SELECT rowid AS scan_id,* FROM backend_order_flower_auxiliary_observations WHERE owner_ref=? AND account_ref=? AND subject_ref=?
          AND rowid>? ORDER BY rowid LIMIT ?`, owner, account, subject, cursor, limit);
      if (!rows.length) {
        if (ce > passCe) run('UPDATE backend_order_aux_source_exit_progress SET connection_epoch=?,scanned_rowid=0,updated_at=? WHERE owner_ref=? AND account_ref=? AND subject_ref=?',
          ce, store.nowIso(), owner, account, subject);
        return { scanned: 0, retired: 0 };
      }
      let retired = 0, children = 0, through = cursor, chain = prior?.chain_fingerprint || fingerprint([]);
      for (const row of rows) {
        if (!Number.isSafeInteger(row.connection_epoch) || row.connection_epoch < 1 || row.connection_epoch >= ce || referenced(subject, row.connection_epoch)) { through = row.scan_id; continue; }
        let payload, source; try { payload = parseStored(row.payload_json, 'auxiliary exit original'); source = parseStored(row.source_json, 'auxiliary exit original source'); }
        catch { through = row.scan_id; continue; }
        const context = orderFlowerContext(source?.context);
        if (fingerprint(payload) !== row.payload_fingerprint || !context || context.ownerRef !== owner || context.accountRef !== account || context.subjectRef !== subject
            || context.connectionEpoch !== row.connection_epoch || context.ownerEpoch !== row.owner_epoch || context.runEpoch !== row.run_epoch
            || orderFlowerContextKey(context) !== row.context_key || source.connectionEpoch !== row.connection_epoch
            || typeof source.responseRef !== 'string' || row.observation_ref !== 'order-flower-auxiliary-observation:' + fingerprint([context, source.responseRef])) { through = row.scan_id; continue; }
        const revalidations = all('SELECT * FROM backend_order_flower_auxiliary_compatibility_revalidations WHERE observation_ref=? ORDER BY revalidation_ref LIMIT ?', row.observation_ref, 16 - children);
        let valid = true;
        for (const child of revalidations) {
          let receipt; try { receipt = parseStored(child.receipt_json, 'auxiliary exit revalidation'); } catch { valid = false; break; }
          if (receipt.observationRef !== row.observation_ref || canonical(receipt.context) !== canonical(context)
              || receipt.source?.connectionEpoch !== row.connection_epoch || receipt.source?.responseRef !== source.responseRef
              || receipt.source?.requestSequence !== source.requestSequence || receipt.source?.wireKey !== source.wireKey
              || receipt.rawPayloadFingerprint !== child.raw_payload_fingerprint || receipt.proofFingerprint !== child.proof_fingerprint
              || receipt.accepted !== (child.accepted === 1) || (receipt.reasonCode || null) !== child.reason_code) { valid = false; break; }
        }
        if (!valid) { through = row.scan_id; continue; }
        run('INSERT INTO backend_order_aux_source_exit_callbacks VALUES(?,?,?)', row.observation_ref, head.payload_fingerprint, ce);
        for (const child of revalidations) {
          if (Number(run('DELETE FROM backend_order_flower_auxiliary_compatibility_revalidations WHERE revalidation_ref=? AND observation_ref=?', child.revalidation_ref, row.observation_ref).changes) !== 1)
            throw new Error('Auxiliary revalidation exit proof changed');
          chain = fingerprint([chain, fingerprint(child)]); children++;
        }
        const remaining = get('SELECT 1 FROM backend_order_flower_auxiliary_compatibility_revalidations WHERE observation_ref=? LIMIT 1', row.observation_ref);
        if (!remaining) {
          if (Number(run('DELETE FROM backend_order_flower_auxiliary_observations WHERE observation_ref=? AND owner_ref=? AND account_ref=? AND subject_ref=?', row.observation_ref, owner, account, subject).changes) !== 1)
            throw new Error('Auxiliary source exit proof changed');
          const { scan_id, ...original } = row; chain = fingerprint([chain, fingerprint(original)]); retired++; through = row.scan_id;
        }
        run('DELETE FROM backend_order_aux_source_exit_callbacks WHERE observation_ref=?', row.observation_ref);
        if (remaining || children >= 16) break;
      }
      run(`INSERT INTO backend_order_aux_source_exit_progress VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,account_ref,subject_ref)
        DO UPDATE SET connection_epoch=excluded.connection_epoch,scanned_rowid=excluded.scanned_rowid,retired_count=excluded.retired_count,
        revalidations_retired=excluded.revalidations_retired,chain_fingerprint=excluded.chain_fingerprint,updated_at=excluded.updated_at`,
      owner, account, subject, passCe, through, (prior?.retired_count || 0) + retired, (prior?.revalidations_retired || 0) + children, chain, store.nowIso());
      return { scanned: rows.length, retired, revalidations: children };
    });
  }
  return Object.freeze({ retire });
}
