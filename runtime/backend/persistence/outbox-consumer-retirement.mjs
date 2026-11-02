import {canonical,fingerprint,parseStored} from '../common.mjs';
const RETIRABLE_PARENTS=new Set(['order.customer','order.resident','order.satin','order.decorate']);

export const OUTBOX_CONSUMER_RETIREMENT_SCHEMA=`CREATE TABLE IF NOT EXISTS backend_outbox_consumer_retirements(
  consumer_id TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,parent_feature_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,cutoff_event_id INTEGER NOT NULL,successors_json TEXT NOT NULL,retirement_json TEXT NOT NULL,
  retirement_fingerprint TEXT NOT NULL,recorded_at TEXT NOT NULL);
  CREATE TRIGGER IF NOT EXISTS backend_outbox_consumer_retirements_no_update BEFORE UPDATE ON backend_outbox_consumer_retirements
    BEGIN SELECT RAISE(ABORT,'consumer retirement proof is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS backend_outbox_consumer_retirements_no_delete BEFORE DELETE ON backend_outbox_consumer_retirements
    BEGIN SELECT RAISE(ABORT,'consumer retirement proof must be retained'); END;
  CREATE TRIGGER IF NOT EXISTS backend_outbox_consumer_retirements_insert BEFORE INSERT ON backend_outbox_consumer_retirements
    WHEN NEW.contract_id!='scheduler/split-parent-consumer/v1'
      OR NEW.parent_feature_id NOT IN ('order.customer','order.resident','order.satin','order.decorate')
      OR NEW.consumer_id!='scheduler:'||NEW.owner_ref||':'||NEW.subject_ref||':'||NEW.parent_feature_id
      OR NOT EXISTS(SELECT 1 FROM backend_outbox_confirmed_progress old WHERE old.consumer_id=NEW.consumer_id
        AND old.owner_ref=NEW.owner_ref AND old.subject_ref=NEW.subject_ref
        AND CASE WHEN json_valid(NEW.retirement_json) THEN NEW.cutoff_event_id=json_extract(NEW.retirement_json,'$.cutoffEventId')
          AND NEW.consumer_id=json_extract(NEW.retirement_json,'$.consumerId') AND old.confirmed_through=json_extract(NEW.retirement_json,'$.oldConfirmedThrough')
          AND old.examined_through=json_extract(NEW.retirement_json,'$.oldExaminedThrough') ELSE 0 END)
      OR CASE WHEN json_valid(NEW.successors_json) THEN json_type(NEW.successors_json)!='array'
        OR json_array_length(NEW.successors_json)<1 OR json_array_length(NEW.successors_json)>16
        OR EXISTS(SELECT 1 FROM json_each(NEW.successors_json) s WHERE s.type!='text'
          OR s.value=NEW.consumer_id OR substr(s.value,1,length(NEW.consumer_id)+1)!=NEW.consumer_id||':'
          OR NOT EXISTS(SELECT 1 FROM backend_outbox_confirmed_progress c WHERE c.consumer_id=s.value
            AND c.owner_ref=NEW.owner_ref AND c.subject_ref=NEW.subject_ref AND c.confirmed_through>=NEW.cutoff_event_id)
          OR EXISTS(SELECT 1 FROM backend_outbox_scan_pending p WHERE p.consumer_id=s.value AND p.owner_ref=NEW.owner_ref
            AND p.subject_ref=NEW.subject_ref AND p.event_id<=NEW.cutoff_event_id)) ELSE 1 END
    BEGIN SELECT RAISE(ABORT,'consumer retirement requires all real replacement confirmations'); END;`;

// Subscription retirement is NOT acknowledgement. The old progress and holes
// stay byte-exact. Only explicitly split parents absent from the actual live
// work-unit registry can retire, after EVERY replacement processed the full
// existing stream through a transactionally fixed cut.
export function createOutboxConsumerRetirement({store,replacementContracts}){
  const contracts=new Map(replacementContracts.map(x=>[x.parentFeatureId,x]));
  const allowed=RETIRABLE_PARENTS;
  for(const [parent,c]of contracts)if(!allowed.has(parent)||!Array.isArray(c.successorUnits)||!c.successorUnits.length
      ||c.successorUnits.length>16||new Set(c.successorUnits).size!==c.successorUnits.length
      ||c.successorUnits.some(x=>typeof x!=='string'||!x.startsWith(parent+':')))
    throw new TypeError('Unknown scheduler consumer replacement contract');
  let last=['','',''];
  function retire(){
    if(!contracts.size)return {retired:0};
    return store.transaction(()=>{
      const condition=`consumer_id IN (${[...contracts].map(()=>"'scheduler:'||owner_ref||':'||subject_ref||':'||?").join(',')})
        AND NOT EXISTS(SELECT 1 FROM backend_outbox_consumer_retirements r WHERE r.consumer_id=c.consumer_id)`;
      const names=[...contracts.keys()];
      const old=store.get(`SELECT * FROM backend_outbox_confirmed_progress c WHERE ${condition}
        AND (owner_ref,subject_ref,consumer_id)>(?,?,?) ORDER BY owner_ref,subject_ref,consumer_id LIMIT 1`,...names,...last)
        ||store.get(`SELECT * FROM backend_outbox_confirmed_progress c WHERE ${condition} ORDER BY owner_ref,subject_ref,consumer_id LIMIT 1`,...names);
      if(!old)return {retired:0};last=[old.owner_ref,old.subject_ref,old.consumer_id];
      const prefix='scheduler:'+old.owner_ref+':'+old.subject_ref+':',parent=old.consumer_id.slice(prefix.length),contract=contracts.get(parent);
      if(!contract||old.consumer_id!==prefix+parent)return {retired:0,held:'not-registered-replacement'};
      const cutoff=store.get('SELECT max(event_id) AS n FROM backend_outbox WHERE owner_ref=? AND subject_ref=?',old.owner_ref,old.subject_ref)?.n;
      if(!Number.isSafeInteger(cutoff)||cutoff<1)return {retired:0,held:'no-stream-cut'};
      const successors=contract.successorUnits.map(unit=>prefix+unit),proofs=[];
      for(const consumerId of successors){
        if(store.get('SELECT 1 FROM backend_outbox_consumer_retirements WHERE consumer_id=?',consumerId))return {retired:0,held:'replacement-retired'};
        const p=store.get('SELECT confirmed_through,examined_through FROM backend_outbox_confirmed_progress WHERE consumer_id=? AND owner_ref=? AND subject_ref=?',consumerId,old.owner_ref,old.subject_ref);
        if(!p||p.confirmed_through<cutoff||store.get('SELECT 1 FROM backend_outbox_scan_pending WHERE consumer_id=? AND owner_ref=? AND subject_ref=? AND event_id<=? LIMIT 1',consumerId,old.owner_ref,old.subject_ref,cutoff))
          return {retired:0,held:'replacement-not-confirmed'};
        proofs.push({consumerId,confirmedThrough:p.confirmed_through,examinedThrough:p.examined_through});
      }
      const body={version:'scheduler-consumer-subscription-retirement/v1',consumerId:old.consumer_id,ownerRef:old.owner_ref,subjectRef:old.subject_ref,
        parentFeatureId:parent,contractId:'scheduler/split-parent-consumer/v1',replacementContract:contract,
        cutoffEventId:cutoff,oldConfirmedThrough:old.confirmed_through,oldExaminedThrough:old.examined_through,successors:proofs,
        oldAcknowledgementsUnchanged:true,oldPendingHolesUnchanged:true};
      store.run('INSERT INTO backend_outbox_consumer_retirements VALUES(?,?,?,?,?,?,?,?,?,?)',old.consumer_id,old.owner_ref,old.subject_ref,parent,
        body.contractId,cutoff,canonical(successors),canonical(body),fingerprint(body),store.nowIso());
      return {retired:1,parentFeatureId:parent,cutoffEventId:cutoff};
    });
  }
  return Object.freeze({retire});
}

export function outboxConsumerRetired(store,consumerId){
  // All current split work-unit IDs have a different suffix. Keep this check
  // off their high-volume read/ACK SQL path entirely.
  if(!RETIRABLE_PARENTS.has(consumerId.slice(consumerId.lastIndexOf(':')+1)))return false;
  const row=store.get('SELECT * FROM backend_outbox_consumer_retirements WHERE consumer_id=?',consumerId);
  if(!row)return false;
  const proof=parseStored(row.retirement_json,'outbox consumer retirement');
  if(fingerprint(proof)!==row.retirement_fingerprint||proof.consumerId!==consumerId||proof.ownerRef!==row.owner_ref
      ||proof.subjectRef!==row.subject_ref||proof.parentFeatureId!==row.parent_feature_id||proof.cutoffEventId!==row.cutoff_event_id
      ||proof.contractId!==row.contract_id||!Array.isArray(proof.successors)
      ||canonical(proof.successors.map(p=>p.consumerId))!==row.successors_json)throw new Error('Outbox consumer retirement proof corrupt');
  return true;
}
