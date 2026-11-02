import { fingerprint, parseStored } from '../../common.mjs';
import { ledgerJsonFingerprint } from '../../persistence/json-contract.mjs';

// The mutable head owns revision allocation. Historical snapshots are never a
// generation counter or an admission source. Adoption and separation receipts
// remain available; unknown groups retain every original snapshot.
export function createLandGroupHistory({ store, ledgerView }) {
  const { get, all, run, transaction } = store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_land_group_history_callbacks(
    receipt_ref TEXT PRIMARY KEY,payload_json TEXT NOT NULL,head_json TEXT NOT NULL,head_revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS backend_land_group_history_progress(owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
      scanned_rowid INTEGER NOT NULL,retired_count INTEGER NOT NULL,chain_fingerprint TEXT NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY(owner_ref,subject_ref));
    CREATE TABLE IF NOT EXISTS backend_land_group_history_totals(owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
      group_ref TEXT NOT NULL,retired_count INTEGER NOT NULL,PRIMARY KEY(owner_ref,subject_ref,group_ref));
    CREATE INDEX IF NOT EXISTS backend_land_group_history_unresolved ON backend_operations(owner_ref,subject_ref)
      WHERE write_slot=1 OR business_verdict IN ('unknown','unverified');
    CREATE INDEX IF NOT EXISTS backend_land_group_history_scan ON backend_land_group_receipts(owner_ref,subject_ref);`);
  if (!all('PRAGMA table_info(backend_land_group_history_callbacks)').some(row => row.name === 'closed_stages_json'))
    run('ALTER TABLE backend_land_group_history_callbacks ADD COLUMN closed_stages_json TEXT');
  transaction(() => {
    const name = 'backend_land_group_receipts_append_only', prior = get("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?", name)?.sql;
    if (prior?.includes('land group exit requires proven superseded snapshot and closed-stage fence')) return;
    if (prior && !prior.includes('land group receipts are append only') && !prior.includes('land group exit requires proven superseded snapshot'))
      throw new Error('Unknown land group history guard');
    if (prior) store.db.exec('DROP TRIGGER ' + name);
    store.db.exec(`CREATE TRIGGER ${name} BEFORE DELETE ON backend_land_group_receipts WHEN OLD.kind='adopted'
      OR NOT EXISTS(SELECT 1 FROM backend_land_group_history_callbacks p JOIN backend_land_group_heads h
        ON h.owner_ref=OLD.owner_ref AND h.subject_ref=OLD.subject_ref AND h.group_ref=OLD.group_ref
        AND h.document_json=p.head_json AND h.revision=p.head_revision WHERE p.receipt_ref=OLD.receipt_ref AND p.payload_json=OLD.payload_json
        AND CASE WHEN json_valid(OLD.payload_json) THEN json_type(OLD.payload_json,'$.revision')='integer'
          AND json_extract(OLD.payload_json,'$.revision')>0 AND json_extract(OLD.payload_json,'$.revision')<h.revision ELSE 0 END
        AND (p.closed_stages_json IS NULL OR CASE WHEN json_valid(p.closed_stages_json) THEN
          json_array_length(p.closed_stages_json)>0 AND NOT EXISTS(SELECT 1 FROM json_each(p.closed_stages_json) s
            LEFT JOIN backend_land_lifecycle_heads l ON l.subject_ref=OLD.subject_ref AND l.owner_ref=OLD.owner_ref
              AND l.land_id=json_extract(s.value,'$.landId')
            WHERE l.model_json IS NULL OR l.model_json!=json_extract(s.value,'$.modelJson')) ELSE 0 END))
      OR EXISTS(SELECT 1 FROM backend_land_group_heads h WHERE h.owner_ref=OLD.owner_ref AND h.subject_ref=OLD.subject_ref
        AND instr(h.document_json,'"'||OLD.receipt_ref||'"')>0)
      OR EXISTS(SELECT 1 FROM backend_operations o WHERE o.owner_ref=OLD.owner_ref AND o.subject_ref=OLD.subject_ref
        AND (o.write_slot=1 OR o.business_verdict IN ('unknown','unverified'))
        AND (NOT json_valid(o.original_json) OR instr(o.original_json,'"'||OLD.group_ref||'"')>0))
      BEGIN SELECT RAISE(ABORT,'land group exit requires proven superseded snapshot and closed-stage fence'); END;`);
    // Eligibility changed, not business progress: revisit the old skipped
    // physical prefix once, keeping all cumulative exit counts and hash roots.
    run('UPDATE backend_land_group_history_progress SET scanned_rowid=0');
  });
  function documentSafe(value, owner, subject, checked, missingClosedPlans = null) {
    if (!value || typeof value !== 'object') return true;
    for (const [key, item] of Object.entries(value)) {
      if (['state','verdict','business_verdict'].includes(key) && ['unknown', 'conflict', 'unverified', 'verifying'].includes(item)
          || key === 'currentUnknownOperationId' && item) return false;
      if (/operationId$/i.test(key) && typeof item === 'string' && item) {
        if (!checked.has(item)) {
          const op = ledgerView?.operation(item);
          const retired=!op?ledgerView?.retiredOperation?.(item):null;
          checked.set(item, !!retired&&retired.ownerRef===owner&&retired.subjectRef===subject&&retired.verdict==='confirmed'
            &&retired.resourcesReleased===true||!!op && op.owner_ref === owner && op.subject_ref === subject && op.write_slot === 0
            && (op.business_verdict === 'confirmed' || op.transport_state === 'not_sent' && op.business_verdict === 'not_applicable')
            && ledgerJsonFingerprint(op.original) === op.original_fingerprint && op.resources.every(r => r.state === 'released'));
        }
        if (!checked.get(item) && !missingClosedPlans?.has(item)) return false;
      }
      if (item && typeof item === 'object' && !documentSafe(item, owner, subject, checked, missingClosedPlans)) return false;
    }
    return true;
  }
  function closedStages(headDocument, oldDocument, owner, subject) {
    if (headDocument.state !== 'closed' || !Array.isArray(headDocument.members) || headDocument.members.length > 64
        || !headDocument.members.every(m => ['finished','cancelled'].includes(m.state))
        || headDocument.round && !['completed','cancelled'].includes(headDocument.round.state)) return null;
    const stages = new Map(), missing = new Set();
    for (const doc of [headDocument, oldDocument]) {
      if (!Array.isArray(doc?.members) || doc.members.length > 64) return null;
      for (const member of doc.members) {
        if (!Number.isSafeInteger(member.landId) || member.landId < 1) return null;
        if (!stages.has(member.landId)) {
          const row = get('SELECT model_json FROM backend_land_lifecycle_heads WHERE owner_ref=? AND subject_ref=? AND land_id=?', owner, subject, member.landId);
          const life = row && parseStored(row.model_json, 'closed plan current land generation');
          if (!life || life.subjectRef !== subject || life.landId !== member.landId || life.context?.ownerRef !== owner
              || life.context?.subjectRef !== subject || !Number.isSafeInteger(life.semanticVersion) || life.semanticVersion < 1
              || !['proven-empty','identified-crop'].includes(life.confidence)) return null;
          stages.set(member.landId, { landId: member.landId, modelJson: row.model_json, life });
        }
        const life = stages.get(member.landId).life;
        // A closed plan for the still-current empty/crop identity must retain
        // its revision history. Only a genuinely different durable generation
        // fences every delayed proposal associated with the old identity.
        if (!(member.emptyRef || member.cropRef) || member.emptyRef && member.emptyRef === life.emptyRef
            || member.cropRef && member.cropRef === life.cropRef) return null;
        if (member.operationId && !get('SELECT 1 FROM backend_operations WHERE operation_id=?', member.operationId)) {
          if (!member.emptyRef || !['planned','pending','cancelled'].includes(member.state)
              || get('SELECT 1 FROM backend_send_permits WHERE operation_id=?', member.operationId)) return null;
          missing.add(member.operationId);
        }
      }
    }
    return stages.size ? { stages: [...stages.values()].map(({ landId, modelJson }) => ({ landId, modelJson })), missing } : null;
  }
  let owner = '', subject = '';
  function retire() {
    const scope = get(`SELECT owner_ref,subject_ref FROM backend_land_group_heads WHERE (owner_ref,subject_ref)>(?,?)
      ORDER BY owner_ref,subject_ref LIMIT 1`, owner, subject) || get('SELECT owner_ref,subject_ref FROM backend_land_group_heads ORDER BY owner_ref,subject_ref LIMIT 1');
    if (!scope) return { retired: 0 }; owner = scope.owner_ref; subject = scope.subject_ref;
    return transaction(() => {
      if (get(`SELECT 1 FROM backend_land_group_heads WHERE owner_ref=? AND subject_ref=? AND NOT json_valid(document_json) LIMIT 1`, owner, subject))
        return { retired: 0, held: 'non-plain-head' };
      const progress = get('SELECT * FROM backend_land_group_history_progress WHERE owner_ref=? AND subject_ref=?', owner, subject), cursor = progress?.scanned_rowid || 0;
      const rows = all(`SELECT rowid AS scan_id,* FROM backend_land_group_receipts WHERE owner_ref=? AND subject_ref=? AND rowid>? ORDER BY rowid LIMIT 32`, owner, subject, cursor);
      if (!rows.length) {
        if (cursor) run('UPDATE backend_land_group_history_progress SET scanned_rowid=0 WHERE owner_ref=? AND subject_ref=?', owner, subject);
        return { retired: 0 };
      }
      let retired = 0, chain = progress?.chain_fingerprint || fingerprint([]), scanned = cursor;
      const heads = new Map(), checked = new Map(), started = performance.now();
      for (const row of rows) {
        if (scanned !== cursor && performance.now() - started > 40) break;
        scanned = row.scan_id;
        if (row.kind === 'adopted') continue;
        if (!heads.has(row.group_ref)) {
          const head = get('SELECT * FROM backend_land_group_heads WHERE owner_ref=? AND subject_ref=? AND group_ref=?', owner, subject, row.group_ref);
          const doc = head && parseStored(head.document_json, 'land group current history root');
          const unresolved = get(`SELECT 1 FROM backend_operations WHERE owner_ref=? AND subject_ref=?
            AND (write_slot=1 OR business_verdict IN ('unknown','unverified'))
            AND (NOT json_valid(original_json) OR instr(original_json,?)>0) LIMIT 1`, owner, subject, '"' + row.group_ref + '"');
          heads.set(row.group_ref, head && doc?.groupRef === row.group_ref && Number.isSafeInteger(head.revision)
            && !unresolved ? { head, doc } : null);
        }
        const root = heads.get(row.group_ref); if (!root) continue;
        const { head, doc } = root;
        const payload = parseStored(row.payload_json, 'land group historical snapshot');
        const closed = doc.state === 'closed' ? closedStages(doc, payload?.document, owner, subject) : null;
        if (!Number.isSafeInteger(payload?.revision) || payload.revision < 1 || payload.revision >= head.revision
            || payload.document?.groupRef !== row.group_ref || fingerprint(payload.document) !== payload.documentFingerprint
            || fingerprint([owner, subject, row.group_ref, row.kind, payload]) !== row.receipt_ref
            || !documentSafe(doc, owner, subject, checked, closed?.missing)
            || !documentSafe(payload.document, owner, subject, checked, closed?.missing)
            || get(`SELECT 1 FROM backend_land_group_heads WHERE owner_ref=? AND subject_ref=? AND instr(document_json,?)>0 LIMIT 1`, owner, subject, '"' + row.receipt_ref + '"')) continue;
        run(`INSERT INTO backend_land_group_history_callbacks(receipt_ref,payload_json,head_json,head_revision,closed_stages_json)
          VALUES(?,?,?,?,?)`, row.receipt_ref, row.payload_json, head.document_json, head.revision, closed ? JSON.stringify(closed.stages) : null);
        if (Number(run('DELETE FROM backend_land_group_receipts WHERE receipt_ref=?', row.receipt_ref).changes) !== 1) throw new Error('Land group history exit proof changed');
        run('DELETE FROM backend_land_group_history_callbacks WHERE receipt_ref=?', row.receipt_ref);
        run(`INSERT INTO backend_land_group_history_totals VALUES(?,?,?,1) ON CONFLICT(owner_ref,subject_ref,group_ref)
          DO UPDATE SET retired_count=retired_count+1`, owner, subject, row.group_ref);
        const { scan_id, ...original } = row; chain = fingerprint([chain, fingerprint(original)]); retired++;
      }
      run(`INSERT INTO backend_land_group_history_progress VALUES(?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref) DO UPDATE SET
        scanned_rowid=excluded.scanned_rowid,retired_count=excluded.retired_count,chain_fingerprint=excluded.chain_fingerprint,updated_at=excluded.updated_at`,
      owner, subject, scanned, (progress?.retired_count || 0) + retired, chain, store.nowIso());
      return { retired };
    });
  }
  return Object.freeze({ retire });
}
