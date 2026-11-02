import { canonical, fingerprint, parseStored, problem } from '../../common.mjs';

const VERSION='order-flower-verified-delivery-root/v1';
const scope=row=>({ownerRef:row.owner_ref,subjectRef:row.subject_ref,kind:row.kind,officialUid:row.official_uid,
  dayKey:row.day_key,startMs:row.day_start_ms,endMs:row.day_end_ms});
const key=row=>fingerprint(scope(row));
const sourceHashes=original=>({originalFingerprint:original.op.original_fingerprint,
  preparationFingerprint:original.preparationRow.payload_fingerprint,settlementFingerprint:original.settlement.result_fingerprint,
  targetEvidenceFingerprint:original.targetEvent.payload_fingerprint});

function storedRoot(store,row){
  const root=store.get('SELECT * FROM backend_order_flower_delivery_roots WHERE root_key=?',key(row));
  if(!root)return null;
  const body=parseStored(root.root_json,'ordinary delivery recovery root');
  if(fingerprint(body)!==root.root_fingerprint||body.version!==VERSION||body.rootKey!==root.root_key
      ||canonical(body.scope)!==canonical(scope(row))||body.receiptRef!==root.receipt_ref
      ||body.receiptFingerprint!==root.receipt_fingerprint||body.policyCountAfter!==root.policy_count_after)
    throw problem('ORDER_DELIVERY_ROOT_INTEGRITY','订单交付最小恢复根不完整，原账保留',409);
  return {root,body};
}
// Pure read port shared with the bounded audit projection. The caller supplies
// hashes from its independently checked original/preparation/target evidence.
export function readVerifiedOrderFlowerDeliveryRoot({store,row,hashes}){
  if(!store.get("SELECT name FROM sqlite_schema WHERE type='table' AND name='backend_order_flower_delivery_roots'"))return null;
  const found=storedRoot(store,row);
  if(!found||found.root.receipt_ref!==row.receipt_ref||found.root.receipt_fingerprint!==row.receipt_fingerprint
      ||found.root.policy_count_after!==row.policy_count_after||canonical(found.body.sourceHashes)!==canonical(hashes))return null;
  return {...found.body,rootFingerprint:found.root.root_fingerprint};
}

// A compact certificate of an ACTUALLY validated leaf, not a scan watermark.
// Only that exact immutable receipt can terminate parent/source recursion.
// Current official day/counter reads and the new target verification are never
// replaced by this historical certificate. Existing originals remain intact.
export function createOrderFlowerDeliveryRoot({store}) {
  const {get,run,transaction}=store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_order_flower_delivery_roots(
    root_key TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,kind TEXT NOT NULL,day_key TEXT NOT NULL,
    receipt_ref TEXT NOT NULL REFERENCES backend_order_flower_delivery_receipts(receipt_ref),receipt_fingerprint TEXT NOT NULL,
    policy_count_after INTEGER NOT NULL,root_json TEXT NOT NULL,root_fingerprint TEXT NOT NULL,updated_at TEXT NOT NULL,
    UNIQUE(owner_ref,subject_ref,kind,day_key));
    CREATE TABLE IF NOT EXISTS backend_order_flower_delivery_root_callbacks(root_key TEXT PRIMARY KEY,new_fingerprint TEXT NOT NULL,
      previous_fingerprint TEXT,receipt_ref TEXT NOT NULL,receipt_fingerprint TEXT NOT NULL);`);
  const proof=`EXISTS(SELECT 1 FROM backend_order_flower_delivery_root_callbacks p
    JOIN backend_order_flower_delivery_receipts r ON r.receipt_ref=p.receipt_ref AND r.receipt_fingerprint=p.receipt_fingerprint
    JOIN backend_operations o ON o.operation_id=r.operation_id AND o.owner_ref=r.owner_ref AND o.subject_ref=r.subject_ref
    WHERE p.root_key=NEW.root_key AND p.new_fingerprint=NEW.root_fingerprint AND p.receipt_ref=NEW.receipt_ref
      AND p.receipt_fingerprint=NEW.receipt_fingerprint AND r.owner_ref=NEW.owner_ref AND r.subject_ref=NEW.subject_ref
      AND r.kind=NEW.kind AND r.day_key=NEW.day_key AND r.policy_count_after=NEW.policy_count_after
      AND o.business_verdict='confirmed' AND o.transport_state='answered' AND o.write_slot=0
      AND o.method IN ('orderFlower.finishOrder','orderFlower.finishSatinOrder','orderFlower.finishDecorateOrder')
      AND CASE WHEN json_valid(r.receipt_json) AND json_valid(NEW.root_json) THEN
        json_extract(r.receipt_json,'$.originalFingerprint')=o.original_fingerprint
        AND json_extract(NEW.root_json,'$.receiptRef')=r.receipt_ref
        AND json_extract(NEW.root_json,'$.receiptFingerprint')=r.receipt_fingerprint
        AND json_extract(NEW.root_json,'$.previousRootFingerprint') IS p.previous_fingerprint ELSE 0 END)`;
  store.db.exec(`CREATE TRIGGER IF NOT EXISTS backend_order_flower_delivery_roots_insert BEFORE INSERT ON backend_order_flower_delivery_roots
    WHEN NOT (${proof} AND EXISTS(SELECT 1 FROM backend_order_flower_delivery_root_callbacks p WHERE p.root_key=NEW.root_key AND p.previous_fingerprint IS NULL))
    BEGIN SELECT RAISE(ABORT,'delivery root requires verified receipt callback'); END;
    CREATE TRIGGER IF NOT EXISTS backend_order_flower_delivery_roots_update BEFORE UPDATE ON backend_order_flower_delivery_roots
    WHEN NOT (${proof} AND NEW.root_key=OLD.root_key AND NEW.owner_ref=OLD.owner_ref AND NEW.subject_ref=OLD.subject_ref
      AND NEW.kind=OLD.kind AND NEW.day_key=OLD.day_key AND NEW.policy_count_after>=OLD.policy_count_after
      AND EXISTS(SELECT 1 FROM backend_order_flower_delivery_root_callbacks p WHERE p.root_key=NEW.root_key AND p.previous_fingerprint=OLD.root_fingerprint))
    BEGIN SELECT RAISE(ABORT,'delivery root update requires verified monotonic receipt callback'); END;
    CREATE TRIGGER IF NOT EXISTS backend_order_flower_delivery_roots_no_delete BEFORE DELETE ON backend_order_flower_delivery_roots
    BEGIN SELECT RAISE(ABORT,'delivery recovery root must be retained'); END;`);
  const stored=row=>storedRoot(store,row);
  function matches(row,original){
    const found=stored(row);
    return !!found&&found.root.receipt_ref===row.receipt_ref&&found.root.receipt_fingerprint===row.receipt_fingerprint
      &&found.root.policy_count_after===row.policy_count_after
      &&canonical(found.body.sourceHashes)===canonical(sourceHashes(original));
  }
  function record(row,original){
    // Caller has just checked the real day, counter, target and parent floor
    // in recordConfirmed's FULL transaction. No caller-supplied count is used.
    return transaction(()=>{
      const latest=get(`SELECT receipt_ref FROM backend_order_flower_delivery_receipts WHERE owner_ref=? AND subject_ref=? AND kind=?
        AND day_start_ms=? AND day_end_ms=? ORDER BY policy_count_after DESC,receipt_ref LIMIT 1`,row.owner_ref,row.subject_ref,row.kind,row.day_start_ms,row.day_end_ms);
      if(latest?.receipt_ref!==row.receipt_ref)return {recorded:false,reason:'not-latest-leaf'};
      const prior=stored(row);if(prior?.root.receipt_ref===row.receipt_ref)return {recorded:false,reason:'same-leaf'};
      if(prior&&prior.root.policy_count_after>row.policy_count_after)throw problem('ORDER_DELIVERY_ROOT_REGRESSION','交付下界不可回退',409);
      const body={version:VERSION,rootKey:key(row),scope:scope(row),receiptRef:row.receipt_ref,receiptFingerprint:row.receipt_fingerprint,
        policyCountAfter:row.policy_count_after,sourceHashes:sourceHashes(original),previousRootFingerprint:prior?.root.root_fingerprint??null,
        chainFingerprint:fingerprint([prior?.body.chainFingerprint??null,row.receipt_ref,row.receipt_fingerprint,sourceHashes(original)])};
      const hash=fingerprint(body);
      run('INSERT INTO backend_order_flower_delivery_root_callbacks VALUES(?,?,?,?,?)',body.rootKey,hash,body.previousRootFingerprint,row.receipt_ref,row.receipt_fingerprint);
      if(prior)run(`UPDATE backend_order_flower_delivery_roots SET receipt_ref=?,receipt_fingerprint=?,policy_count_after=?,root_json=?,root_fingerprint=?,updated_at=? WHERE root_key=?`,
        row.receipt_ref,row.receipt_fingerprint,row.policy_count_after,canonical(body),hash,store.nowIso(),body.rootKey);
      else run('INSERT INTO backend_order_flower_delivery_roots VALUES(?,?,?,?,?,?,?,?,?,?,?)',body.rootKey,row.owner_ref,row.subject_ref,row.kind,row.day_key,
        row.receipt_ref,row.receipt_fingerprint,row.policy_count_after,canonical(body),hash,store.nowIso());
      run('DELETE FROM backend_order_flower_delivery_root_callbacks WHERE root_key=?',body.rootKey);
      return {recorded:true,rootFingerprint:hash};
    });
  }
  return Object.freeze({matches,record});
}
