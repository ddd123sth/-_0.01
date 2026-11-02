import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {openBackendStore} from '../runtime/backend/persistence/store.mjs';
import {createBackendLedger} from '../runtime/backend/persistence/ledger.mjs';
import {createDynamicStateCoordinator} from '../runtime/backend/facts/dynamic-state.mjs';
import {buildTypedDynamicCoverage} from '../runtime/backend/facts/typed-coverage.mjs';
import {createLandProjection} from '../runtime/backend/features/land/projection.mjs';
import {createOfficialLandCatalog} from '../runtime/backend/features/land/catalog.mjs';
import {decodeOfficialLandObservation} from '../runtime/backend/features/land/wire-facts.mjs';
import {resolveAcceptedLandObservationEvidence} from '../runtime/backend/features/land/compatibility-evidence.mjs';
import {captureLandWriteWorkset} from '../runtime/backend/features/land/write-workset.mjs';
import {bindOfficialContract} from '../runtime/backend/official-version-profile.mjs';
import {fingerprint} from '../runtime/backend/common.mjs';
import {createHarvestFeature} from '../runtime/backend/features/land/harvest.mjs';
import {consumedDomains,affectedDomainsForWrite} from '../runtime/backend/facts/dynamic-state.mjs';

test('harvest has no item-input dependency but still invalidates inventory for its real consumers',()=>{
 assert.deepEqual(consumedDomains(createHarvestFeature({})),['land','clock']);
 assert(affectedDomainsForWrite('harvest','usrLand.harvest').includes('inventory'));
 assert(consumedDomains({featureId:'water',consumedDomains:['land','inventory','clock','profile']}).includes('inventory'));
});

// Real SQLite ledger/projection/coordinator; only incoming protocol frames and
// the consumed transport permit are synthetic. This is not a live-server pass.
for(const mode of ['valid','prior-gap','wrong-value','missing-member','wrong-permit']) test('land certificate transaction: '+mode,()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r8-certificate-')),store=openBackendStore({dataDir:dir});
 try{
  const context={ownerRef:'o',accountRef:'1',subjectRef:'s',ownerEpoch:1,runEpoch:2,connectionEpoch:3},ledger=createBackendLedger(store);
  const projection=createLandProjection({store,catalog:createOfficialLandCatalog(),isCurrent:()=>true});
  const dynamic=createDynamicStateCoordinator({store,isCurrent:()=>true,deviceNow:()=>10000,monotonicNow:()=>10000});
  const version={source:'normal-package-hop-and-matched-world-login/v1',gameVersion:'480.0.27',protocolVersion:'480.0.0',loginResponseRef:'login',dataSnapshotId:'a'.repeat(64)};
  version.profileBinding=bindOfficialContract(version,{...context,officialUid:123,loginResponseRef:'login',dataSnapshotId:version.dataSnapshotId}).binding;
  const login={source:'response',transport:'answered',envelopeOk:true,dsName:'G.ISyncData',method:'index.login',connectionEpoch:3,
   requestSequence:1,responseRef:'login',wireKey:'ws|1000|1',receivedDeviceMs:1000,receivedMonotonicMs:1000,versionEvidence:version,
   currentIdentity:{verified:true,responseRef:'login',officialUid:123},value:{7:{0:{0:123,17:1000,32:{7:10},33:{}}},100:{0:{0:123,1:{1001:{0:23001,1:1,7:1000},1002:{0:23001,1:1,7:1000}}}}}};
  const ingest=obs=>{const frame=decodeOfficialLandObservation({context,observation:obs,capabilities:{bagComplete:true,itemExtComplete:true}});
   const accepted=projection.ingest(frame);return {frame,coverage:buildTypedDynamicCoverage(context,obs,{land:accepted,landView:projection.view(context)})};};
  const initial=ingest(login);dynamic.observe({context,observation:login,coverage:initial.coverage});
  const proposal={...context,operationId:'op',proposalId:'proposal',featureId:'water',scope:'water',method:'usrLand.water',params:{landId:1001},
   paramsFingerprint:fingerprint({landId:1001}),semanticKey:'water:stage',configRevision:1,cancelEpoch:0,executorRef:'executor',factBasis:{land:1001},resources:[],resourceBindings:[],
   targets:[{memberKey:'member-1',targetKind:'land',targetRef:'land:s:1001',lifecycleRef:'stage',targetFingerprint:'target'}],
   land:{groupRef:'group',groupMemberKey:'member-1',roundRef:null,before:{state:1}}};
  const acceptedLogin=resolveAcceptedLandObservationEvidence({store,context,observationRef:initial.frame.observationRef});
  const group={groupRef:'group',members:[{landId:1001,memberKey:'member-1'},{landId:1002,memberKey:'member-2'}],round:null};
  const workset=structuredClone(captureLandWriteWorkset({context,proposal,acceptedLogin,group}));
  assert.equal(workset.complete,true);
  if(mode==='missing-member')workset.loginReceivedMembers.pop();
  ledger.prepareOperation({...proposal,landRequest:{version:'land-request/v1',params:proposal.params,workset}});
  store.run(`CREATE TABLE backend_send_permits(operation_id TEXT,owner_ref TEXT,account_ref TEXT,subject_ref TEXT,owner_epoch INTEGER,
   run_epoch INTEGER,connection_epoch INTEGER,method TEXT,params_fingerprint TEXT,consumed INTEGER,wire_key TEXT,request_sequence INTEGER)`);
  store.run('INSERT INTO backend_send_permits VALUES(?,?,?,?,?,?,?,?,?,?,?,?)','op','o','1','s',1,2,3,'usrLand.water',proposal.paramsFingerprint,mode==='wrong-permit'?0:1,'ws|1000|2',2);
  if(mode==='prior-gap')dynamic.invalidate({context,domains:['land'],reasonCode:'OLDER_UNRESOLVED_WRITE',operationId:'old'});
  dynamic.beforeDispatch({context,proposal,binding:{connectionEpoch:3,requestSequence:2,wireKey:'ws|1000|2'}});
  const response={...login,method:'usrLand.water',operationId:'op',requestSequence:2,responseRef:'answer',wireKey:'ws|1000|2',receivedDeviceMs:2000,
   receivedMonotonicMs:2000,value:{100:{1:{1001:{0:23001,1:2,7:1000}}}}};
  const next=ingest(response);if(mode==='wrong-value'){
   const item=next.coverage.find(one=>one.domainId==='land');item.semanticValue['land.lands.1001.fields.state']=3;item.semanticFingerprint=fingerprint(item.semanticValue);
  }
  dynamic.observe({context,observation:response,coverage:next.coverage});
  const dirty=store.get("SELECT * FROM backend_dynamic_domain_dirty WHERE domain_id='land'");
  // A2 also emits unchanged-domain certificates; this contract checks only
  // the land barrier. Other domains must not hide an invalid land proof.
  const certificates=store.all("SELECT receipt_json FROM backend_dynamic_refresh_events WHERE event_kind='write-certificate' AND domains_json=?",JSON.stringify(['land']));
  assert.equal(dirty===null,mode==='valid');assert.equal(certificates.length,mode==='valid'?1:0);
  assert(store.get("SELECT 1 FROM backend_dynamic_domain_dirty WHERE domain_id='inventory'"),'unproved inventory barrier remains');
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
