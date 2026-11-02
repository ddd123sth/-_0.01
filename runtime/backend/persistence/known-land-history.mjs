import {fingerprint,parseStored,problem} from '../common.mjs';

export const KNOWN_LAND_HISTORY_SCHEMA=`CREATE TABLE IF NOT EXISTS backend_land_known_history_roots(
  owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,land_id INTEGER NOT NULL,retired_version INTEGER NOT NULL,
  operation_sequence INTEGER NOT NULL,retired_count INTEGER NOT NULL,chain_fingerprint TEXT NOT NULL,updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_ref,subject_ref,land_id));
  CREATE TABLE IF NOT EXISTS backend_land_known_history_receipts(operation_id TEXT PRIMARY KEY,operation_sequence INTEGER NOT NULL UNIQUE,
    owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,prepared_at TEXT NOT NULL,land_id INTEGER NOT NULL,old_land_version INTEGER NOT NULL,
    receipt_json TEXT NOT NULL,receipt_fingerprint TEXT NOT NULL,recorded_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS backend_land_known_history_callbacks(operation_id TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,
    subject_ref TEXT NOT NULL,land_id INTEGER NOT NULL,old_land_version INTEGER NOT NULL,old_crop_ref TEXT NOT NULL,
    head_json TEXT NOT NULL,operation_fingerprint TEXT NOT NULL,receipt_fingerprint TEXT NOT NULL,official_uid INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS backend_land_known_history_scans(owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    scanned_sequence INTEGER NOT NULL,PRIMARY KEY(owner_ref,subject_ref));
  CREATE TRIGGER IF NOT EXISTS backend_land_known_history_roots_no_delete BEFORE DELETE ON backend_land_known_history_roots
    BEGIN SELECT RAISE(ABORT,'land generation replay fences must remain'); END;
  CREATE TRIGGER IF NOT EXISTS backend_land_known_history_receipts_no_update BEFORE UPDATE ON backend_land_known_history_receipts
    BEGIN SELECT RAISE(ABORT,'known land retirement receipt is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS backend_land_known_history_receipts_no_delete BEFORE DELETE ON backend_land_known_history_receipts
    BEGIN SELECT RAISE(ABORT,'known land retirement references must close before receipt exit'); END;
  CREATE INDEX IF NOT EXISTS backend_outbox_owner_subject_key ON backend_outbox(owner_ref,subject_ref,event_key);`;

// A small known-result receipt remains while logs/group snapshots/consumed
// claims still name the UUID. It carries hashes and released land metadata,
// never a second copy of the full operation/evidence/source history.
export function readRetiredKnownLandOperation(store,operationId){
  const row=store.get('SELECT * FROM backend_land_known_history_receipts WHERE operation_id=?',operationId);
  if(!row)return null;
  const body=parseStored(row.receipt_json,'known land retirement receipt'),root=store.get(`SELECT * FROM backend_land_known_history_roots
    WHERE owner_ref=? AND subject_ref=? AND land_id=?`,row.owner_ref,row.subject_ref,row.land_id);
  if(fingerprint(body)!==row.receipt_fingerprint||body.version!=='land-harvest-retirement/v1'||body.operationId!==row.operation_id
      ||body.operationSequence!==row.operation_sequence||body.ownerRef!==row.owner_ref||body.subjectRef!==row.subject_ref
      ||body.preparedAt!==row.prepared_at||body.landId!==row.land_id||body.oldLandVersion!==row.old_land_version
      ||body.method!=='usrLand.harvest'||body.featureId!=='harvest'||body.verdict!=='confirmed'||body.resourcesReleased!==true
      ||!root||root.operation_sequence<body.operationSequence||root.retired_version<body.oldLandVersion)
    throw problem('LAND_RETIRED_RECEIPT_INTEGRITY','已知收获退出回执不完整，恢复根保留',409);
  return {...body,receiptFingerprint:row.receipt_fingerprint,retired:true,detailAvailable:false,readOnly:true};
}

export function assertLandHistoryNotRetired(store,original){
  if(store.get('SELECT 1 FROM backend_land_known_history_receipts WHERE operation_id=?',original.operationId))
    throw problem('BACKEND_OPERATION_RETIRED','这个已确认操作的明细已安全退出，不可重新发送',409);
  if(original.method!=='usrLand.harvest'||original.featureId!=='harvest')return;
  const target=original.factBasis?.target;
  if(!Number.isSafeInteger(target?.landId)||!Number.isSafeInteger(target?.semanticVersion))return;
  const root=store.get('SELECT retired_version FROM backend_land_known_history_roots WHERE owner_ref=? AND subject_ref=? AND land_id=?',
    original.ownerRef,original.subjectRef,target.landId);
  if(root&&target.semanticVersion<=root.retired_version)
    throw problem('BACKEND_LAND_GENERATION_RETIRED','旧收获代次已由更晚土地状态关闭，不能换编号重发',409);
}
