import { OUTBOX_CONSUMER_RETIREMENT_SCHEMA } from './outbox-consumer-retirement.mjs';
import { KNOWN_LAND_HISTORY_SCHEMA } from './known-land-history.mjs';
export const BACKEND_LEDGER_SCHEMA_VERSION = 23;

// These tables contain new ledger data only. Existing game_write_*, account,
// identity, credential and archive tables are neither rewritten nor deleted.
export function ensureBackendLedgerSchema(store) {
  const { db, get, run, transaction, nowIso } = store;
  transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS backend_persistence_migrations(
      version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, description TEXT NOT NULL)`);
    const latest = get('SELECT MAX(version) AS version FROM backend_persistence_migrations');
    if (Number(latest?.version || 0) > BACKEND_LEDGER_SCHEMA_VERSION) throw new Error('Backend ledger schema is newer than this runtime');
    if (!get('SELECT version FROM backend_persistence_migrations WHERE version=1')) {
    db.exec(`
CREATE TABLE backend_operations(
  operation_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL,
  owner_ref TEXT NOT NULL, account_ref TEXT NOT NULL, subject_ref TEXT NOT NULL,
  run_epoch INTEGER NOT NULL CHECK(run_epoch>=0), connection_epoch INTEGER NOT NULL CHECK(connection_epoch>=0),
  feature_id TEXT NOT NULL, scope TEXT NOT NULL, method TEXT NOT NULL, semantic_key TEXT NOT NULL,
  config_revision INTEGER NOT NULL CHECK(config_revision>=0), cancel_epoch INTEGER NOT NULL CHECK(cancel_epoch>=0),
  fact_basis_json TEXT NOT NULL, params_fingerprint TEXT NOT NULL, original_json TEXT NOT NULL,
  original_fingerprint TEXT NOT NULL, prepared_at TEXT NOT NULL,
  transport_state TEXT NOT NULL DEFAULT 'not_started' CHECK(transport_state IN ('not_started','may_have_sent','answered','terminated','unknown','not_sent')),
  business_verdict TEXT NOT NULL DEFAULT 'unverified' CHECK(business_verdict IN ('unverified','confirmed','rejected','unknown','not_applicable')),
  verification_version TEXT, write_slot INTEGER NOT NULL DEFAULT 1 CHECK(write_slot IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1), updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX backend_operations_semantic ON backend_operations(subject_ref,feature_id,semantic_key) WHERE transport_state!='not_sent';
CREATE UNIQUE INDEX backend_operations_one_slot ON backend_operations(subject_ref) WHERE write_slot=1;
CREATE INDEX backend_operations_subject ON backend_operations(subject_ref,prepared_at,operation_id);
CREATE TABLE backend_operation_targets(
  operation_id TEXT NOT NULL REFERENCES backend_operations(operation_id), member_key TEXT NOT NULL,
  target_kind TEXT NOT NULL, target_ref TEXT NOT NULL, lifecycle_ref TEXT NOT NULL,
  target_fingerprint TEXT NOT NULL, original_json TEXT NOT NULL,
  PRIMARY KEY(operation_id,member_key)
);
CREATE INDEX backend_operation_targets_ref ON backend_operation_targets(target_kind,target_ref,lifecycle_ref);
CREATE TABLE backend_operation_resources(
  operation_id TEXT NOT NULL REFERENCES backend_operations(operation_id), resource_key TEXT NOT NULL,
  resource_kind TEXT NOT NULL, resource_ref TEXT NOT NULL, quantity REAL NOT NULL CHECK(quantity>=0),
  basis_ref TEXT NOT NULL, accounting_ref TEXT NOT NULL, original_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','in_flight','historical_footprint','released')),
  release_evidence_id INTEGER, updated_at TEXT NOT NULL,
  PRIMARY KEY(operation_id,resource_key)
);
CREATE INDEX backend_operation_resources_ref ON backend_operation_resources(resource_kind,resource_ref,state);
CREATE TABLE backend_operation_evidence(
  evidence_id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL REFERENCES backend_operations(operation_id),
  evidence_key TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, payload_json TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL, observed_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
  UNIQUE(operation_id,evidence_key)
);
CREATE TABLE backend_admission_basis(
  basis_id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL REFERENCES backend_operations(operation_id),
  subject_ref TEXT NOT NULL, constraint_key TEXT NOT NULL, basis_key TEXT NOT NULL,
  conclusion TEXT NOT NULL CHECK(conclusion IN ('hold_current','permit_current','needs_evidence')),
  operation_revision INTEGER NOT NULL, fact_basis_json TEXT NOT NULL, affected_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL, reason_code TEXT NOT NULL, recorded_at TEXT NOT NULL,
  UNIQUE(operation_id,constraint_key,basis_key)
);
CREATE INDEX backend_admission_basis_subject ON backend_admission_basis(subject_ref,basis_id);
CREATE TABLE backend_outbox(
  event_id INTEGER PRIMARY KEY AUTOINCREMENT, owner_ref TEXT NOT NULL, subject_ref TEXT,
  event_type TEXT NOT NULL, event_key TEXT NOT NULL, config_revision INTEGER,
  payload_json TEXT NOT NULL, payload_fingerprint TEXT NOT NULL,
  occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
  UNIQUE(owner_ref,event_type,event_key)
);
CREATE TABLE backend_outbox_receipts(
  consumer_id TEXT NOT NULL, event_id INTEGER NOT NULL REFERENCES backend_outbox(event_id),
  consumed_at TEXT NOT NULL, receipt_json TEXT NOT NULL,
  PRIMARY KEY(consumer_id,event_id)
);
CREATE TRIGGER backend_operations_original_immutable BEFORE UPDATE OF
  operation_id,proposal_id,owner_ref,account_ref,subject_ref,run_epoch,connection_epoch,feature_id,scope,method,
  semantic_key,config_revision,cancel_epoch,fact_basis_json,params_fingerprint,original_json,original_fingerprint,prepared_at
  ON backend_operations BEGIN SELECT RAISE(ABORT,'backend operation original fields are immutable'); END;
CREATE TRIGGER backend_operations_no_delete BEFORE DELETE ON backend_operations
  BEGIN SELECT RAISE(ABORT,'backend operation history is append only'); END;
CREATE TRIGGER backend_targets_no_update BEFORE UPDATE ON backend_operation_targets
  BEGIN SELECT RAISE(ABORT,'backend target identity is immutable'); END;
CREATE TRIGGER backend_targets_no_delete BEFORE DELETE ON backend_operation_targets
  BEGIN SELECT RAISE(ABORT,'backend target history is append only'); END;
CREATE TRIGGER backend_resources_original_immutable BEFORE UPDATE OF
  operation_id,resource_key,resource_kind,resource_ref,quantity,basis_ref,accounting_ref,original_json
  ON backend_operation_resources BEGIN SELECT RAISE(ABORT,'backend resource original fields are immutable'); END;
CREATE TRIGGER backend_resources_no_delete BEFORE DELETE ON backend_operation_resources
  BEGIN SELECT RAISE(ABORT,'backend resource history is append only'); END;
CREATE TRIGGER backend_evidence_no_update BEFORE UPDATE ON backend_operation_evidence
  BEGIN SELECT RAISE(ABORT,'backend evidence is append only'); END;
CREATE TRIGGER backend_evidence_no_delete BEFORE DELETE ON backend_operation_evidence
  BEGIN SELECT RAISE(ABORT,'backend evidence is append only'); END;
CREATE TRIGGER backend_admission_no_update BEFORE UPDATE ON backend_admission_basis
  BEGIN SELECT RAISE(ABORT,'backend admission evidence is append only'); END;
CREATE TRIGGER backend_admission_no_delete BEFORE DELETE ON backend_admission_basis
  BEGIN SELECT RAISE(ABORT,'backend admission evidence is append only'); END;
CREATE TRIGGER backend_outbox_no_update BEFORE UPDATE ON backend_outbox
  BEGIN SELECT RAISE(ABORT,'backend outbox events are append only'); END;
CREATE TRIGGER backend_outbox_no_delete BEFORE DELETE ON backend_outbox
  BEGIN SELECT RAISE(ABORT,'backend outbox events are append only'); END;
CREATE TRIGGER backend_outbox_receipts_no_update BEFORE UPDATE ON backend_outbox_receipts
  BEGIN SELECT RAISE(ABORT,'backend event receipts are append only'); END;
CREATE TRIGGER backend_outbox_receipts_no_delete BEFORE DELETE ON backend_outbox_receipts
  BEGIN SELECT RAISE(ABORT,'backend event receipts are append only'); END;
`);
    run('INSERT INTO backend_persistence_migrations(version,applied_at,description) VALUES(?,?,?)',
      1, nowIso(), 'G1 independent operation ledger, resource footprints, evidence, admission basis and durable outbox');
    }
    if (!get('SELECT version FROM backend_persistence_migrations WHERE version=2')) {
      db.exec(`CREATE TABLE backend_operation_resource_targets(
        operation_id TEXT NOT NULL,resource_key TEXT NOT NULL,member_key TEXT NOT NULL,
        quantity REAL NOT NULL CHECK(quantity>=0),
        PRIMARY KEY(operation_id,resource_key,member_key),
        FOREIGN KEY(operation_id,resource_key) REFERENCES backend_operation_resources(operation_id,resource_key),
        FOREIGN KEY(operation_id,member_key) REFERENCES backend_operation_targets(operation_id,member_key));
      CREATE TABLE backend_operation_target_settlements(
        operation_id TEXT NOT NULL,member_key TEXT NOT NULL,settlement_key TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK(verdict IN ('confirmed','rejected','unknown')),
        verification_version TEXT NOT NULL,reason_code TEXT NOT NULL,
        evidence_id INTEGER NOT NULL REFERENCES backend_operation_evidence(evidence_id),
        result_json TEXT NOT NULL,result_fingerprint TEXT NOT NULL,recorded_at TEXT NOT NULL,
        PRIMARY KEY(operation_id,member_key),UNIQUE(operation_id,settlement_key),
        FOREIGN KEY(operation_id,member_key) REFERENCES backend_operation_targets(operation_id,member_key));
      CREATE TRIGGER backend_resource_targets_no_update BEFORE UPDATE ON backend_operation_resource_targets
        BEGIN SELECT RAISE(ABORT,'resource target binding is immutable'); END;
      CREATE TRIGGER backend_resource_targets_no_delete BEFORE DELETE ON backend_operation_resource_targets
        BEGIN SELECT RAISE(ABORT,'resource target binding is append only'); END;
      CREATE TRIGGER backend_target_settlements_no_update BEFORE UPDATE ON backend_operation_target_settlements
        BEGIN SELECT RAISE(ABORT,'target settlement is immutable'); END;
      CREATE TRIGGER backend_target_settlements_no_delete BEFORE DELETE ON backend_operation_target_settlements
        BEGIN SELECT RAISE(ABORT,'target settlement is append only'); END;`);
      run('INSERT INTO backend_persistence_migrations(version,applied_at,description) VALUES(?,?,?)',
        2, nowIso(), 'G2 immutable resource member bindings and append-only single-target settlement');
    }
    if (!get('SELECT version FROM backend_persistence_migrations WHERE version=3')) {
      // Preserve every old watermark exactly. Future IDs are allocated from a
      // recovery root and cannot change when SQLite reclaims physical pages.
      db.exec(`ALTER TABLE backend_operations ADD COLUMN operation_sequence INTEGER NOT NULL DEFAULT 0
        CHECK(operation_sequence>=0 AND operation_sequence<=9007199254740991);
        UPDATE backend_operations SET operation_sequence=rowid;
        CREATE UNIQUE INDEX backend_operations_sequence ON backend_operations(operation_sequence);
        CREATE INDEX backend_operations_subject_sequence ON backend_operations(subject_ref,operation_sequence);
        CREATE TRIGGER backend_operations_sequence_immutable BEFORE UPDATE OF operation_sequence ON backend_operations
          BEGIN SELECT RAISE(ABORT,'operation sequence is immutable'); END;
        CREATE TRIGGER backend_operations_sequence_required BEFORE INSERT ON backend_operations
          WHEN NEW.operation_sequence<=0 BEGIN SELECT RAISE(ABORT,'operation sequence is required'); END;
        CREATE TABLE IF NOT EXISTS backend_durable_sequences(namespace TEXT NOT NULL,scope_key TEXT NOT NULL,
          value INTEGER NOT NULL CHECK(value>=0 AND value<=9007199254740991),PRIMARY KEY(namespace,scope_key));
        INSERT INTO backend_durable_sequences(namespace,scope_key,value)
          SELECT 'operation', '[]', COALESCE(MAX(operation_sequence),0) FROM backend_operations;`);
      run('INSERT INTO backend_persistence_migrations VALUES(?,?,?)', 3, nowIso(),
        'Stable operation sequence preserving legacy resource watermarks; no original evidence rewritten');
    }
    if (!get('SELECT version FROM backend_persistence_migrations WHERE version=4')) {
      db.exec(`CREATE TABLE backend_outbox_confirmed_progress(
        consumer_id TEXT NOT NULL,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
        confirmed_through INTEGER NOT NULL CHECK(confirmed_through>=0),
        examined_through INTEGER NOT NULL CHECK(examined_through>=confirmed_through),
        confirmed_at TEXT NOT NULL,PRIMARY KEY(consumer_id,owner_ref,subject_ref));
        CREATE TRIGGER backend_outbox_confirmed_progress_monotonic BEFORE UPDATE ON backend_outbox_confirmed_progress
          WHEN NEW.confirmed_through<OLD.confirmed_through OR NEW.examined_through<OLD.examined_through
          BEGIN SELECT RAISE(ABORT,'outbox confirmation cannot move backwards'); END;
        CREATE TRIGGER backend_outbox_confirmed_progress_no_delete BEFORE DELETE ON backend_outbox_confirmed_progress
          BEGIN SELECT RAISE(ABORT,'outbox confirmation is a recovery root'); END;`);
      run('INSERT INTO backend_persistence_migrations VALUES(?,?,?)', 4, nowIso(),
        'Outbox true confirmed prefix plus examined ceiling and explicit unconfirmed holes; old receipts retained');
    }
    if (!get('SELECT version FROM backend_persistence_migrations WHERE version=5')) {
      db.exec(`CREATE TABLE IF NOT EXISTS backend_outbox_scan_pending(
        consumer_id TEXT NOT NULL,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,event_id INTEGER NOT NULL CHECK(event_id>0),
        PRIMARY KEY(consumer_id,owner_ref,subject_ref,event_id));
        CREATE TABLE backend_outbox_success_callbacks(
          consumer_id TEXT NOT NULL,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,event_id INTEGER NOT NULL,
          PRIMARY KEY(consumer_id,owner_ref,subject_ref,event_id));
        CREATE TRIGGER backend_outbox_pending_immutable BEFORE UPDATE ON backend_outbox_scan_pending
          BEGIN SELECT RAISE(ABORT,'outbox gap identity is immutable'); END;
        CREATE TRIGGER backend_outbox_pending_delete_proof BEFORE DELETE ON backend_outbox_scan_pending
          WHEN EXISTS(SELECT 1 FROM backend_outbox_confirmed_progress c WHERE c.consumer_id=OLD.consumer_id
            AND c.owner_ref=OLD.owner_ref AND c.subject_ref=OLD.subject_ref AND OLD.event_id<=c.examined_through)
          AND NOT EXISTS(SELECT 1 FROM backend_outbox_receipts r WHERE r.consumer_id=OLD.consumer_id AND r.event_id=OLD.event_id)
          AND NOT EXISTS(SELECT 1 FROM backend_outbox_success_callbacks s WHERE s.consumer_id=OLD.consumer_id
            AND s.owner_ref=OLD.owner_ref AND s.subject_ref=OLD.subject_ref AND s.event_id=OLD.event_id)
          BEGIN SELECT RAISE(ABORT,'outbox gap needs a real success callback'); END;`);
      run('INSERT INTO backend_persistence_migrations VALUES(?,?,?)', 5, nowIso(),
        'Protect authoritative outbox gaps; transient callback proof shares the success transaction');
    }
    if (!get('SELECT version FROM backend_persistence_migrations WHERE version=6'))
      run('INSERT INTO backend_persistence_migrations VALUES(?,?,?)', 6, nowIso(),
        'Lossless codecs for land/customer frames; resource baseline no longer applies SQL JSON extraction to encoded frames');
    if (!get('SELECT version FROM backend_persistence_migrations WHERE version=7'))
      run('INSERT INTO backend_persistence_migrations VALUES(?,?,?)', 7, nowIso(),
        'Lossless public-object references for legacy source bindings; head-owned fact history retirement');
    if (!get('SELECT version FROM backend_persistence_migrations WHERE version=8'))
      run('INSERT INTO backend_persistence_migrations VALUES(?,?,?)', 8, nowIso(),
        'Byte-exact shared public JSON evidence; dependency-guarded configuration and confirmed log history exits');
    if (!get('SELECT version FROM backend_persistence_migrations WHERE version=9'))
      run('INSERT INTO backend_persistence_migrations VALUES(?,?,?)', 9, nowIso(),
        'Customer redundant observation events exit behind durable source heads; occurrences and originals retained');
    if (!get('SELECT version FROM backend_persistence_migrations WHERE version=10'))
      run('INSERT INTO backend_persistence_migrations VALUES(?,?,?)', 10, nowIso(),
        'Customer source replay fences use durable heads; superseded identity observations and refinements exit together');
    if (!get('SELECT version FROM backend_persistence_migrations WHERE version=11'))
      run('INSERT INTO backend_persistence_migrations VALUES(?,?,?)', 11, nowIso(),
        'Waterwheel sparse-enter anchors exit only behind a superseded unreferenced connection; lossless order evidence encoding');
    if (!get('SELECT version FROM backend_persistence_migrations WHERE version=12'))
      run('INSERT INTO backend_persistence_migrations VALUES(?,?,?)', 12, nowIso(),
        'Order source replay fence and bounded exit of superseded connections with no operation or verification dependencies');
    db.exec('CREATE INDEX IF NOT EXISTS backend_outbox_owner_subject_event ON backend_outbox(owner_ref,subject_ref,event_id)');
    db.exec(OUTBOX_CONSUMER_RETIREMENT_SCHEMA);
    db.exec(KNOWN_LAND_HISTORY_SCHEMA);
    // Compatibility generation, distinct from individual modules' resumable
    // CREATE/guard installation. Earlier runtimes must not replace newer
    // dependency guards merely because their core migration list ended at 12.
    if (!get('SELECT version FROM backend_persistence_migrations WHERE version=?',BACKEND_LEDGER_SCHEMA_VERSION))
      run('INSERT INTO backend_persistence_migrations VALUES(?,?,?)',BACKEND_LEDGER_SCHEMA_VERSION,nowIso(),
        'Compatibility fence for verified roster retirement roots and dependency-guarded history exits');
  });
}
