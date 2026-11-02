import {canonical,fingerprint,parseStored} from '../../common.mjs';
import {hashLedgerBytes,ledgerJsonFingerprint} from '../../persistence/json-contract.mjs';
import {assertSingleProposal,valueOf} from './rpc-contract.mjs';
import {resolveAcceptedLandObservationEvidence} from './compatibility-evidence.mjs';

const CHILDREN=[['backend_operation_resource_targets','backend_resource_targets_no_delete','resource target binding is append only'],
  ['backend_operation_target_settlements','backend_target_settlements_no_delete','target settlement is append only'],
  ['backend_admission_basis','backend_admission_no_delete','backend admission evidence is append only'],
  ['backend_operation_evidence','backend_evidence_no_delete','backend evidence is append only'],
  ['backend_operation_resources','backend_resources_no_delete','backend resource history is append only'],
  ['backend_operation_targets','backend_targets_no_delete','backend target history is append only'],
  ['backend_send_permits','backend_send_permits_known_exit',null],
  ['backend_operations','backend_operations_no_delete','backend operation history is append only']];
const RETAINED_ANCHORS=new Set(['backend_current_need_claim_owners','backend_current_need_claim_owner_events','backend_local_logs']);
const positive=n=>Number.isSafeInteger(n)&&n>0;

export function createKnownLandHistory({store,ledgerView,currentContexts,isCurrent,projection}){
  const {get,all,run,transaction}=store;
  const base=`EXISTS(SELECT 1 FROM backend_land_known_history_callbacks p
    JOIN backend_land_lifecycle_heads h ON h.owner_ref=p.owner_ref AND h.subject_ref=p.subject_ref AND h.land_id=p.land_id AND h.model_json=p.head_json
    JOIN backend_accounts active ON active.owner_ref=p.owner_ref AND active.subject_ref=p.subject_ref AND active.removed_at IS NULL
    JOIN backend_run_intents i ON i.owner_ref=active.owner_ref AND i.account_ref=CAST(active.account_id AS TEXT)
    JOIN backend_accounts old ON old.owner_ref=o.owner_ref AND CAST(old.account_id AS TEXT)=o.account_ref AND old.subject_ref=o.subject_ref
    WHERE p.operation_id=o.operation_id AND p.owner_ref=o.owner_ref AND p.subject_ref=o.subject_ref AND p.operation_fingerprint=o.original_fingerprint
      AND o.feature_id='harvest' AND o.scope='harvest' AND o.method='usrLand.harvest' AND o.business_verdict='confirmed'
      AND o.transport_state='answered' AND o.write_slot=0 AND o.verification_version='land-single-verification/v1'
      AND active.verification_ref IS NOT NULL AND active.username_cipher IS NOT NULL AND active.credential_cipher IS NOT NULL
      AND old.server_id=active.server_id AND i.desired_running=1
      AND CASE WHEN json_valid(h.model_json) AND json_valid(o.fact_basis_json) AND json_valid(active.profile_json) AND json_valid(old.profile_json) THEN
        json_extract(h.model_json,'$.confidence') IN ('identified-crop','proven-empty')
        AND json_extract(h.model_json,'$.landSemanticVersion')>p.old_land_version
        AND json_extract(h.model_json,'$.cropRef') IS NOT p.old_crop_ref
        AND json_extract(h.model_json,'$.context.accountRef')=CAST(active.account_id AS TEXT)
        AND json_extract(h.model_json,'$.context.runEpoch')=i.run_epoch AND json_extract(h.model_json,'$.context.connectionEpoch')=i.connection_epoch
        AND json_extract(o.fact_basis_json,'$.target.landId')=p.land_id AND json_extract(o.fact_basis_json,'$.target.cropRef')=p.old_crop_ref
        AND json_extract(o.fact_basis_json,'$.target.semanticVersion')=p.old_land_version
        AND json_extract(active.profile_json,'$.uid')=p.official_uid AND json_extract(old.profile_json,'$.uid')=p.official_uid ELSE 0 END
      AND NOT EXISTS(SELECT 1 FROM backend_operation_resources r WHERE r.operation_id=o.operation_id AND r.state!='released')
      AND NOT EXISTS(SELECT 1 FROM backend_session_verification_leases v WHERE v.operation_id=o.operation_id)
      AND EXISTS(SELECT 1 FROM backend_durable_sequences s WHERE s.namespace='operation' AND s.scope_key='[]' AND s.value>=o.operation_sequence))`;
  const complete=`${base} AND EXISTS(SELECT 1 FROM backend_land_known_history_callbacks p
    JOIN backend_land_known_history_receipts r ON r.operation_id=p.operation_id AND r.receipt_fingerprint=p.receipt_fingerprint
    JOIN backend_land_known_history_roots g ON g.owner_ref=r.owner_ref AND g.subject_ref=r.subject_ref AND g.land_id=r.land_id
    WHERE p.operation_id=o.operation_id AND r.operation_sequence=o.operation_sequence AND g.operation_sequence>=o.operation_sequence
      AND g.retired_version>=p.old_land_version)`;
  transaction(()=>{
    for(const [table,name,legacy]of CHILDREN){
      const prior=get("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?",name)?.sql;
      const known=prior?.includes('known harvest exit requires closed generation callback');
      if(known&&!prior.includes("i.state='running'"))continue;
      if(prior&&!known&&(!legacy||!prior.includes(legacy)))throw new Error('Unknown primary history exit guard: '+name);
      if(prior)store.db.exec('DROP TRIGGER '+name);
      store.db.exec(`CREATE TRIGGER ${name} BEFORE DELETE ON ${table}
        WHEN NOT EXISTS(SELECT 1 FROM backend_operations o WHERE o.operation_id=OLD.operation_id AND ${complete})
        BEGIN SELECT RAISE(ABORT,'known harvest exit requires closed generation callback'); END;`);
    }
    // Repair the observed old guard: intent+epochs are authoritative; the
    // public lower-case state label is not the persisted session enum.
    for(const [name,message]of[['backend_land_known_history_receipts_insert','known harvest receipt requires complete current generation proof'],
      ['backend_land_known_history_roots_insert','land replay fence requires verified known receipt'],
      ['backend_land_known_history_roots_update','land replay fence cannot move without verified known receipt']]){
      const prior=get("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?",name)?.sql;
      if(prior?.includes("i.state='running'")){
        if(!prior.includes(message))throw new Error('Unknown land history root guard');
        store.db.exec('DROP TRIGGER '+name);
      }
    }
    store.db.exec(`CREATE TRIGGER IF NOT EXISTS backend_land_known_history_receipts_insert BEFORE INSERT ON backend_land_known_history_receipts
      WHEN NOT EXISTS(SELECT 1 FROM backend_operations o JOIN backend_land_known_history_callbacks p ON p.operation_id=o.operation_id
        WHERE o.operation_id=NEW.operation_id AND o.operation_sequence=NEW.operation_sequence AND o.owner_ref=NEW.owner_ref
          AND o.subject_ref=NEW.subject_ref AND o.prepared_at=NEW.prepared_at AND p.land_id=NEW.land_id
          AND p.old_land_version=NEW.old_land_version AND p.receipt_fingerprint=NEW.receipt_fingerprint AND ${base})
      BEGIN SELECT RAISE(ABORT,'known harvest receipt requires complete current generation proof'); END;
      CREATE TRIGGER IF NOT EXISTS backend_land_known_history_roots_insert BEFORE INSERT ON backend_land_known_history_roots
      WHEN NEW.retired_count!=1 OR NOT EXISTS(SELECT 1 FROM backend_operations o JOIN backend_land_known_history_callbacks p ON p.operation_id=o.operation_id
        JOIN backend_land_known_history_receipts r ON r.operation_id=o.operation_id AND r.receipt_fingerprint=p.receipt_fingerprint
        WHERE p.owner_ref=NEW.owner_ref AND p.subject_ref=NEW.subject_ref AND p.land_id=NEW.land_id
          AND NEW.retired_version=p.old_land_version AND NEW.operation_sequence=o.operation_sequence AND ${base})
      BEGIN SELECT RAISE(ABORT,'land replay fence requires verified known receipt'); END;
      CREATE TRIGGER IF NOT EXISTS backend_land_known_history_roots_update BEFORE UPDATE ON backend_land_known_history_roots
      WHEN NEW.owner_ref!=OLD.owner_ref OR NEW.subject_ref!=OLD.subject_ref OR NEW.land_id!=OLD.land_id
        OR NEW.retired_count!=OLD.retired_count+1 OR NOT EXISTS(SELECT 1 FROM backend_operations o
          JOIN backend_land_known_history_callbacks p ON p.operation_id=o.operation_id
          JOIN backend_land_known_history_receipts r ON r.operation_id=o.operation_id AND r.receipt_fingerprint=p.receipt_fingerprint
          WHERE p.owner_ref=NEW.owner_ref AND p.subject_ref=NEW.subject_ref AND p.land_id=NEW.land_id
            AND NEW.retired_version=max(OLD.retired_version,p.old_land_version)
            AND NEW.operation_sequence=max(OLD.operation_sequence,o.operation_sequence) AND ${base})
      BEGIN SELECT RAISE(ABORT,'land replay fence cannot move without verified known receipt'); END;`);
  });
  let referenceSql=null,contextTurn=0,lastReason='not-sampled',last={state:'idle',retired:0,scannedThrough:0};
  function otherReferences(operationId){
    if(referenceSql===null){
      const excluded=new Set([...CHILDREN.map(x=>x[0]),...RETAINED_ANCHORS,'backend_land_known_history_receipts','backend_land_known_history_callbacks']);
      const columns=all(`SELECT m.name AS tab,p.name AS col FROM sqlite_schema m JOIN pragma_table_info(m.name) p
        WHERE m.type='table' AND m.name LIKE 'backend_%' AND p.name LIKE '%operation%id%'`)
        .filter(x=>!excluded.has(x.tab)&&x.col!=='operation_rowid');
      if(columns.some(x=>!/^backend_[a-z_]+$/.test(x.tab)||!/^\w+$/.test(x.col)))throw new Error('Unknown operation dependency identifier');
      referenceSql=columns.length?'SELECT 1 WHERE '+columns.map(x=>`EXISTS(SELECT 1 FROM ${x.tab} WHERE ${x.col}=?1)`).join(' OR '):'';
    }
    return referenceSql&&get(referenceSql,operationId);
  }
  function evidence(row){
    const payload=row&&parseStored(row.payload_json,'known land evidence');
    return row&&ledgerJsonFingerprint({kind:row.kind,source:row.source,payload,observedAt:row.observed_at})===row.payload_fingerprint?payload:null;
  }
  function proofFor(row,context,view){
    lastReason='original';
    const op=ledgerView.operation(row.operation_id),p=op?.original,t=p?.factBasis?.target,target=p?.targets?.[0];
    if(!p||hashLedgerBytes(op.original_json)!==op.original_fingerprint||p.operationId!==op.operation_id||p.ownerRef!==op.owner_ref
        ||p.accountRef!==op.account_ref||p.subjectRef!==op.subject_ref||p.runEpoch!==op.run_epoch||p.connectionEpoch!==op.connection_epoch
        ||p.factBasis.version!=='land-single-basis/v1'
        ||!positive(t?.landId)||!positive(t.semanticVersion)||!t.cropRef||p.targets.length!==1||p.resources.length!==1
        ||p.method!=='usrLand.harvest'||p.featureId!=='harvest'||p.scope!=='harvest')return null;
    assertSingleProposal({...p,params:{landId:t.landId}});
    lastReason='target-resource';
    if(target.lifecycleRef!==t.lifecycleRef
        ||op.targets.length!==1||canonical(op.targets[0].original)!==canonical(target)||op.resources.length!==1)return null;
    const resource=op.resources[0];
    if(resource.state!=='released'||resource.resource_kind!=='land'||resource.quantity!==1||resource.resource_ref!==target.targetRef
        ||canonical(resource.original)!==canonical(p.resources[0])||!positive(resource.release_evidence_id)
        ||op.resourceBindings.length!==1||op.resourceBindings[0].resource_key!==resource.resource_key
        ||op.resourceBindings[0].member_key!==target.memberKey||op.resourceBindings[0].quantity!==1)return null;
    const settlement=op.targetSettlements[0],result=settlement?.result,body=result?.evidence?.payload;
    lastReason='target-settlement';
    if(op.targetSettlements.length!==1||settlement.verdict!=='confirmed'||settlement.verification_version!=='land-single-verification/v1'
        ||ledgerJsonFingerprint(result)!==settlement.result_fingerprint||result.member?.verdict!=='confirmed'
        ||result.member.memberKey!==target.memberKey||result.verificationVersion!=='land-single-verification/v1'
        ||body?.targetRef!==target.targetRef||body.lifecycleRef!==target.lifecycleRef||body.rejected!==false
        ||body.before?.cropRef!==t.cropRef||body.before.semanticVersion!==t.semanticVersion||body.before.landId!==t.landId)return null;
    const rows=all('SELECT * FROM backend_operation_evidence WHERE operation_id=? ORDER BY evidence_id',row.operation_id);
    lastReason='answer-permit-evidence';
    if(rows.some(e=>!evidence(e)))return null;
    const answerRow=rows.find(e=>e.kind==='official-answer'),answer=evidence(answerRow),event=rows.find(e=>e.evidence_id===settlement.evidence_id),eventBody=evidence(event),release=rows.find(e=>e.evidence_id===resource.release_evidence_id),permit=get('SELECT * FROM backend_send_permits WHERE operation_id=?',row.operation_id);
    if(!answer||answer.method!=='usrLand.harvest'||answer.connectionEpoch!==p.connectionEpoch||answer.rejected!==false
        ||answer.responseRef!==body.answer?.responseRef||answer.wireKey!==body.answer?.wireKey
        ||answer.requestSequence!==body.answer?.requestSequence||body.traceId!==(p.traceId??body.traceId)||!eventBody||!release
        ||!permit||permit.consumed!==1||permit.owner_ref!==p.ownerRef||permit.subject_ref!==p.subjectRef
        ||permit.account_ref!==p.accountRef&&permit.account_ref!==null||permit.owner_epoch!==p.ownerEpoch||permit.run_epoch!==p.runEpoch
        ||permit.connection_epoch!==p.connectionEpoch||permit.method!==p.method||permit.params_fingerprint!==p.paramsFingerprint
        ||permit.wire_key!==answer.wireKey||permit.request_sequence!==answer.requestSequence&&!(permit.request_sequence===null&&new RegExp('^ws\\|[0-9]+\\|'+answer.requestSequence+'$').test(permit.wire_key))
        ||event.kind!=='domain-verification'||event.source!=='backend/write-gateway/v2'
        ||canonical(eventBody)!==canonical({...body,member:result.member,verificationVersion:result.verificationVersion,
          resourceResolutions:result.resourceResolutions,transportTermination:result.transportTermination})
        ||result.transportTermination?.ended!==true||result.transportTermination.operationId!==row.operation_id
        ||body.postRead?.method!=='usrLand.refresh'||body.postRead.connectionEpoch!==p.connectionEpoch
        ||body.postRead.requestSequence<=answer.requestSequence||body.after.source?.responseRef!==body.postRead.responseRef
        ||!result.resourceResolutions?.some(x=>x.resourceKey===resource.resource_key&&x.state==='released'))return null;
    const oldContext=Object.fromEntries(['ownerRef','accountRef','subjectRef','ownerEpoch','runEpoch','connectionEpoch'].map(k=>[k,p[k]]));
    lastReason='normal-source';
    const source=resolveAcceptedLandObservationEvidence({store,context:oldContext,observationRef:body.after.source.observationRef});
    if(!source?.accepted||source.frame.source?.responseRef!==body.postRead.responseRef||!/^[a-f0-9]{64}$/.test(source.frameFingerprint||''))return null;
    const h=get('SELECT * FROM backend_land_lifecycle_heads WHERE owner_ref=? AND subject_ref=? AND land_id=?',context.ownerRef,context.subjectRef,t.landId),head=h&&parseStored(h.model_json,'known harvest current fence');
    lastReason='current-generation';
    if(!head||!['identified-crop','proven-empty'].includes(head.confidence)||head.cropRef===t.cropRef
        ||head.landSemanticVersion<=t.semanticVersion||head.context?.accountRef!==context.accountRef
        ||head.context?.runEpoch!==context.runEpoch||head.context?.connectionEpoch!==context.connectionEpoch)return null;
    const oldAccount=get('SELECT profile_json,server_id FROM backend_accounts WHERE owner_ref=? AND account_id=? AND subject_ref=?',p.ownerRef,Number(p.accountRef),p.subjectRef),active=get('SELECT profile_json,server_id FROM backend_accounts WHERE owner_ref=? AND account_id=? AND subject_ref=? AND removed_at IS NULL',context.ownerRef,Number(context.accountRef),context.subjectRef),uid=valueOf(view.identity.uid);
    lastReason='same-official-subject';
    if(!oldAccount||!active||!positive(uid)||oldAccount.server_id!==active.server_id
        ||parseStored(oldAccount.profile_json,'known harvest old UID').uid!==uid||parseStored(active.profile_json,'known harvest active UID').uid!==uid)return null;
    let legacyLogin=null;
    if(permit.account_ref===null){
      lastReason='legacy-permit-normal-login-identity';
      // Before the permit account_ref column existed, immutable operation axes
      // and the matched normal login are the independent roster binding. This
      // archival-only branch never admits a new write or backfills that column.
      const starts=all(`SELECT observation_ref FROM backend_land_domain_observations WHERE owner_ref=? AND account_ref=? AND subject_ref=?
        AND connection_epoch=? AND request_sequence>=1 AND request_sequence<? ORDER BY request_sequence LIMIT 4`,p.ownerRef,p.accountRef,p.subjectRef,p.connectionEpoch,answer.requestSequence);
      for(const start of starts){
        const login=resolveAcceptedLandObservationEvidence({store,context:oldContext,observationRef:start.observation_ref});
        if(login?.accepted&&login.frame.source?.method==='index.login'&&valueOf(login.frame.profile?.uid)===uid
            &&valueOf(login.frame.landUid)===uid&&/^[a-f0-9]{64}$/.test(login.frameFingerprint||'')){legacyLogin=login;break;}
      }
      if(!legacyLogin)return null;
    }
    return {op,p,t,target,resource,settlement,rows,h,head,uid,source,legacyLogin,permit};
  }
  function retire(){
    const contexts=currentContexts().filter(isCurrent);if(!contexts.length)return {retired:0};
    const context=contexts[contextTurn++%contexts.length],view=projection.view(context);
    if(!view.current||view.identity?.verified!==true)return {retired:0};
    return transaction(()=>{
      const progress=get('SELECT scanned_sequence FROM backend_land_known_history_scans WHERE owner_ref=? AND subject_ref=?',context.ownerRef,context.subjectRef)?.scanned_sequence||0;
      const candidates=all(`SELECT operation_id,operation_sequence FROM backend_operations WHERE owner_ref=? AND subject_ref=?
        AND method='usrLand.harvest' AND feature_id='harvest' AND scope='harvest' AND business_verdict='confirmed' AND transport_state='answered'
        AND write_slot=0 AND verification_version='land-single-verification/v1' AND operation_sequence>? ORDER BY operation_sequence LIMIT 8`,context.ownerRef,context.subjectRef,progress);
      if(!candidates.length){run('INSERT INTO backend_land_known_history_scans VALUES(?,?,0) ON CONFLICT(owner_ref,subject_ref) DO UPDATE SET scanned_sequence=0',context.ownerRef,context.subjectRef);return {retired:0};}
      let retired=0,scanned=progress;const started=performance.now();
      for(const row of candidates){
        if(scanned!==progress&&performance.now()-started>25)break;scanned=row.operation_sequence;
        lastReason='other-operation-reference';if(otherReferences(row.operation_id))continue;
        const proof=proofFor(row,context,view);if(!proof)continue;
        const {op,p,t,target,resource,settlement,rows,h,head,uid,source,legacyLogin,permit}=proof;
        const tokens=[row.operation_id,t.cropRef,t.lifecycleRef,...all('SELECT claim_ref FROM backend_current_need_claim_owners WHERE operation_id=?',row.operation_id).map(x=>x.claim_ref)];
        lastReason='unresolved-original-reference';
        if(tokens.some(token=>get(`SELECT 1 FROM backend_operations WHERE (write_slot=1 OR business_verdict IN ('unknown','unverified'))
          AND (NOT json_valid(original_json) OR instr(original_json,?)>0) LIMIT 1`,token)
          ||get(`SELECT 1 FROM backend_admission_basis a JOIN backend_operations o ON o.operation_id=a.operation_id
            WHERE (o.write_slot=1 OR o.business_verdict IN ('unknown','unverified')) AND (instr(a.fact_basis_json,?)>0 OR instr(a.affected_json,?)>0 OR instr(a.evidence_json,?)>0) LIMIT 1`,token,token,token)
          ||get(`SELECT 1 FROM backend_operation_evidence e JOIN backend_operations o ON o.operation_id=e.operation_id
            WHERE (o.write_slot=1 OR o.business_verdict IN ('unknown','unverified')) AND instr(e.payload_json,?)>0 LIMIT 1`,token)))continue;
        const events=all('SELECT * FROM backend_outbox WHERE owner_ref=? AND subject_ref=? AND event_key IN (?,?)',context.ownerRef,context.subjectRef,row.operation_id,'land-group-current:'+row.operation_id);
        lastReason='consumer-not-confirmed';
        if(!events.length||events.some(e=>!get(`SELECT 1 FROM backend_outbox_confirmed_progress c WHERE c.owner_ref=? AND c.subject_ref=?
          AND NOT EXISTS(SELECT 1 FROM backend_outbox_consumer_retirements r WHERE r.consumer_id=c.consumer_id) LIMIT 1`,context.ownerRef,context.subjectRef)
          ||get(`SELECT 1 FROM backend_outbox_confirmed_progress c WHERE c.owner_ref=? AND c.subject_ref=? AND NOT EXISTS(
            SELECT 1 FROM backend_outbox_consumer_retirements r WHERE r.consumer_id=c.consumer_id) AND (c.confirmed_through<? OR EXISTS(
              SELECT 1 FROM backend_outbox_scan_pending p WHERE p.consumer_id=c.consumer_id AND p.owner_ref=c.owner_ref AND p.subject_ref=c.subject_ref AND p.event_id=?)) LIMIT 1`,context.ownerRef,context.subjectRef,e.event_id,e.event_id)))continue;
        const fingerprintRows={original:op.original_fingerprint,targets:op.targets,resources:op.resources,bindings:op.resourceBindings,
          settlements:op.targetSettlements,evidence:rows,admission:all('SELECT * FROM backend_admission_basis WHERE operation_id=? ORDER BY basis_id',row.operation_id),permit:get('SELECT * FROM backend_send_permits WHERE operation_id=?',row.operation_id)};
        const body={version:'land-harvest-retirement/v1',operationId:row.operation_id,operationSequence:row.operation_sequence,ownerRef:p.ownerRef,
          accountRef:p.accountRef,subjectRef:p.subjectRef,preparedAt:op.prepared_at,method:p.method,featureId:p.featureId,scope:p.scope,
          verdict:'confirmed',transport:'answered',landId:t.landId,oldLandVersion:t.semanticVersion,oldCropRef:t.cropRef,lifecycleRef:t.lifecycleRef,
          originalFingerprint:op.original_fingerprint,paramsFingerprint:op.params_fingerprint,traceId:p.traceId??null,resourcesReleased:true,
          resources:[{resourceKey:resource.resource_key,resourceKind:'land',resourceRef:resource.resource_ref,quantity:1,state:'released'}],
          settlementFingerprint:settlement.result_fingerprint,childrenFingerprint:fingerprint(fingerprintRows),normalSourceFingerprint:source.frameFingerprint,
          permitAccountBinding:permit.account_ref===null?'accepted-normal-login/same-connection/v1':'original-permit-column',
          normalLoginFingerprint:legacyLogin?.frameFingerprint??null,
          currentHeadFingerprint:hashLedgerBytes(h.model_json),fenceLandVersion:head.landSemanticVersion,officialUid:uid};
        const receiptHash=fingerprint(body),root=get('SELECT * FROM backend_land_known_history_roots WHERE owner_ref=? AND subject_ref=? AND land_id=?',context.ownerRef,context.subjectRef,t.landId),chain=fingerprint([root?.chain_fingerprint??null,receiptHash]);
        lastReason='guarded-full-transaction';
        run('INSERT INTO backend_land_known_history_callbacks VALUES(?,?,?,?,?,?,?,?,?,?)',row.operation_id,context.ownerRef,context.subjectRef,t.landId,t.semanticVersion,t.cropRef,h.model_json,op.original_fingerprint,receiptHash,uid);
        run('INSERT INTO backend_land_known_history_receipts VALUES(?,?,?,?,?,?,?,?,?,?)',row.operation_id,row.operation_sequence,p.ownerRef,p.subjectRef,op.prepared_at,t.landId,t.semanticVersion,canonical(body),receiptHash,store.nowIso());
        if(root)run(`UPDATE backend_land_known_history_roots SET retired_version=?,operation_sequence=?,retired_count=?,chain_fingerprint=?,updated_at=? WHERE owner_ref=? AND subject_ref=? AND land_id=?`,Math.max(root.retired_version,t.semanticVersion),Math.max(root.operation_sequence,row.operation_sequence),root.retired_count+1,chain,store.nowIso(),context.ownerRef,context.subjectRef,t.landId);
        else run('INSERT INTO backend_land_known_history_roots VALUES(?,?,?,?,?,?,?,?)',context.ownerRef,context.subjectRef,t.landId,t.semanticVersion,row.operation_sequence,1,chain,store.nowIso());
        for(const [table]of CHILDREN)run('DELETE FROM '+table+' WHERE operation_id=?',row.operation_id);
        run('DELETE FROM backend_land_known_history_callbacks WHERE operation_id=?',row.operation_id);retired++;lastReason='retired';
      }
      run(`INSERT INTO backend_land_known_history_scans VALUES(?,?,?) ON CONFLICT(owner_ref,subject_ref) DO UPDATE SET scanned_sequence=excluded.scanned_sequence`,context.ownerRef,context.subjectRef,scanned);
      return {retired,scannedThrough:scanned};
    });
  }
  return Object.freeze({retire:()=>{
    try{const result=retire();last={...result,state:'sampled',lastReason};return result;}
    catch(error){last={...last,state:'retry',lastReason,code:error.code||'KNOWN_LAND_HISTORY_GUARD_HELD'};throw error;}
  },snapshot:()=>({...last})});
}
