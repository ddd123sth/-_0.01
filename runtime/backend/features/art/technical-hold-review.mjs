// A review is claimed atomically with a durable operation, never by assessment.
import { fingerprint, newId } from '../../common.mjs';
import { hashLedgerBytes, ledgerJsonFingerprint } from '../../persistence/json-contract.mjs';
const PROBE_INTERVAL_MS = 30 * 60_000;
const AXES = ['accountRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch'];
const text = value => typeof value === 'string' && value.length > 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
export function createTechnicalHoldReviews({ store, now = () => Date.now() }) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_art_technical_hold_reviews(
    review_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,feature_id TEXT NOT NULL,
    implementation_version TEXT NOT NULL,decision TEXT NOT NULL,reason_code TEXT,evidence_ref TEXT,
    recorded_at_ms INTEGER NOT NULL,recorded_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS backend_art_technical_hold_reviews_key
      ON backend_art_technical_hold_reviews(owner_ref,subject_ref,feature_id,implementation_version,recorded_at_ms);
    CREATE TRIGGER IF NOT EXISTS backend_art_technical_hold_reviews_no_update BEFORE UPDATE ON backend_art_technical_hold_reviews
      BEGIN SELECT RAISE(ABORT,'technical hold reviews are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_art_technical_hold_reviews_no_delete BEFORE DELETE ON backend_art_technical_hold_reviews
      BEGIN SELECT RAISE(ABORT,'technical hold reviews are retained'); END;`);
  const columns = new Set(store.all('PRAGMA table_info(backend_art_technical_hold_reviews)').map(row => row.name));
  for (const [name, type] of [['hold_event_ref', 'TEXT'], ['operation_id', 'TEXT'], ['account_ref', 'TEXT'],
    ['owner_epoch', 'INTEGER'], ['run_epoch', 'INTEGER'], ['connection_epoch', 'INTEGER']])
    if (!columns.has(name)) store.run('ALTER TABLE backend_art_technical_hold_reviews ADD COLUMN ' + name + ' ' + type);
  const holdRow = key => store.get('SELECT * FROM backend_art_technical_holds WHERE owner_ref=? AND subject_ref=? AND feature_id=? AND implementation_version=?',
    key.ownerRef, key.subjectRef, key.featureId, key.implementationVersion);
  const holdRef = held => 'technical-hold:' + fingerprint({ ...held });
  const legacyOperationId = row => row?.decision === 'probe-started'
    ? /^(?:customer-art-batch-probe:|art-first-reward-probe:)(.+)$/.exec(row.evidence_ref || '')?.[1] ?? null : row?.evidence_ref;
  function operationFor(key, operationId) {
    if (!text(operationId) || !store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='backend_operations'")) return { readable: false };
    const row = store.get('SELECT * FROM backend_operations WHERE operation_id=?', operationId);
    if (!row) return { readable: true, absent: true };
    let original;
    try { original = JSON.parse(row.original_json); } catch { return { readable: false }; }
    if (hashLedgerBytes(row.original_json) !== row.original_fingerprint || ledgerJsonFingerprint(original) !== row.original_fingerprint ||
        row.operation_id !== operationId || original.operationId !== operationId || row.owner_ref !== key.ownerRef ||
        row.subject_ref !== key.subjectRef || row.feature_id !== key.featureId || original.ownerRef !== row.owner_ref ||
        String(original.accountRef) !== String(row.account_ref) || original.subjectRef !== row.subject_ref || original.featureId !== row.feature_id ||
        original.scope !== row.scope || original.method !== row.method || original.paramsFingerprint !== row.params_fingerprint ||
        original.runEpoch !== row.run_epoch || original.connectionEpoch !== row.connection_epoch || !positive(original.ownerEpoch) ||
        !positive(row.run_epoch) || !positive(row.connection_epoch)) return { readable: false };
    return { readable: true, row, identity: { operationId, accountRef: String(row.account_ref), ownerEpoch: original.ownerEpoch,
      runEpoch: row.run_epoch, connectionEpoch: row.connection_epoch } };
  }
  const sameIdentity = (left, right) => text(left?.operationId) && left.operationId === right?.operationId &&
    AXES.every(axis => left[axis] === (axis === 'accountRef' ? String(right?.[axis]) : right?.[axis]));
  const savedIdentity = row => ({ operationId: row.operation_id, accountRef: row.account_ref,
    ownerEpoch: row.owner_epoch, runEpoch: row.run_epoch, connectionEpoch: row.connection_epoch });
  function ledgerEnd(operation) {
    const row = operation?.row;
    if (!row) return null;
    if (row.transport_state === 'answered' && row.business_verdict === 'confirmed' && row.write_slot === 0)
      return { decision: 'retired', reasonCode: 'TECHNICAL_HOLD_PROBE_CONFIRMED' };
    if (row.transport_state === 'not_sent' && row.business_verdict === 'not_applicable' && row.write_slot === 0)
      return { decision: 'retained', reasonCode: 'TECHNICAL_HOLD_PROBE_NOT_SENT' };
    if (['answered', 'unknown', 'terminated'].includes(row.transport_state) && ['unknown', 'rejected'].includes(row.business_verdict))
      return { decision: 'retained', reasonCode: 'TECHNICAL_HOLD_PROBE_' + row.business_verdict.toUpperCase() };
    return null;
  }
  function inspect(key) {
    const held = holdRow(key);
    if (!held) return { held: false, reasonCode: null, probeAllowed: false, openProbe: false, ownedProbe: false };
    const eventRef = holdRef(held), since = Date.parse(held.created_at);
    const rows = store.all('SELECT rowid AS review_order,* FROM backend_art_technical_hold_reviews WHERE owner_ref=? AND subject_ref=? AND feature_id=? AND implementation_version=? ORDER BY rowid',
      key.ownerRef, key.subjectRef, key.featureId, key.implementationVersion).filter(row => row.hold_event_ref === eventRef ||
      row.hold_event_ref === null && Number.isFinite(since) && row.recorded_at_ms >= since);
    const last = rows.at(-1);
    let end = null, operation = null, identity = null;
    if (last?.decision === 'probe-started') {
      const operationId = last.operation_id || legacyOperationId(last);
      operation = operationFor(key, operationId);
      identity = last.operation_id ? savedIdentity(last) : operation.identity;
      if (operation.readable && operation.row && sameIdentity(identity, operation.identity)) end = ledgerEnd(operation);
      // Legacy assessment-time claims could exist without any prepared operation.
      // Only the healthy ledger's exact absence proves that orphan sent no gateway write.
      if (!last.operation_id && operation.readable && operation.absent && text(operationId))
        end = { decision: 'retained', reasonCode: 'TECHNICAL_HOLD_LEGACY_PROBE_WITHOUT_OPERATION' };
    }
    const retired = last?.decision === 'retired' || end?.decision === 'retired';
    const open = last?.decision === 'probe-started' && !end;
    const endedAt = end ? Date.parse(operation?.row?.updated_at) : NaN;
    const baseMs = end ? Math.max(last.recorded_at_ms, Number.isFinite(endedAt) ? endedAt : last.recorded_at_ms)
      : last?.recorded_at_ms ?? (Number.isFinite(since) ? since : now());
    return { held: !retired, retired, reasonCode: held.reason_code, holdEventRef: eventRef,
      openProbe: Boolean(open), ownedProbe: Boolean(open && operation?.readable && operation.row &&
        sameIdentity(identity, operation.identity) && sameIdentity(identity, key)),
      probeAllowed: !retired && !open && now() >= baseMs + PROBE_INTERVAL_MS,
      nextProbeAtMs: retired || open ? null : baseMs + PROBE_INTERVAL_MS,
      ...(last?.decision === 'probe-started' ? { probe: last, operation, identity, recoveredEnd: end, endedAtMs: baseMs } : {}) };
  }
  function state(key) {
    const { probe, operation, identity, recoveredEnd, endedAtMs, ...visible } = inspect(key);
    return visible;
  }
  function append(key, current, decision, reasonCode, identity, recordedAtMs = now()) {
    const reviewRef = newId();
    store.run('INSERT INTO backend_art_technical_hold_reviews (review_ref,owner_ref,subject_ref,feature_id,implementation_version,decision,reason_code,evidence_ref,recorded_at_ms,recorded_at,hold_event_ref,operation_id,account_ref,owner_epoch,run_epoch,connection_epoch) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      reviewRef, key.ownerRef, key.subjectRef, key.featureId, key.implementationVersion, decision, reasonCode,
      identity?.operationId ?? null, recordedAtMs, store.nowIso(), current.holdEventRef, identity?.operationId ?? null,
      identity?.accountRef ?? null, identity?.ownerEpoch ?? null, identity?.runEpoch ?? null, identity?.connectionEpoch ?? null);
    return { reviewRef, decision, reasonCode, recordedAtMs };
  }
  function beginProbe(key) {
    return store.transaction(() => {
      let current = inspect(key);
      if (!current.held) return null;
      if (current.ownedProbe) return { reviewRef: current.probe.review_ref, decision: 'probe-started', replayed: true };
      if (current.recoveredEnd) {
        append(key, current, current.recoveredEnd.decision, current.recoveredEnd.reasonCode,
          current.identity || { operationId: legacyOperationId(current.probe) }, current.endedAtMs);
        current = inspect(key);
      }
      if (!current.probeAllowed) return null;
      const operation = operationFor(key, key.operationId);
      if (!operation.readable || !sameIdentity(operation.identity, key) || operation.row.write_slot !== 1 ||
          operation.row.transport_state !== 'not_started' || operation.row.business_verdict !== 'unverified') return null;
      return append(key, current, 'probe-started', 'TECHNICAL_HOLD_PROBE', operation.identity);
    });
  }
  function finishProbe(key) {
    return store.transaction(() => {
      const current = inspect(key);
      if (!current.probe || !current.recoveredEnd || !sameIdentity(current.identity, key)) return null;
      return append(key, current, current.recoveredEnd.decision, current.recoveredEnd.reasonCode, current.identity, current.endedAtMs);
    });
  }
  return Object.freeze({ state, beginProbe, finishProbe });
}
