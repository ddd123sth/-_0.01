import test from 'node:test';import assert from 'node:assert/strict';
import { postWriteCoverage } from '../runtime/backend/facts/typed-coverage.mjs';
test('matching land paths alone cannot prove a response: raw values, exact members and receive source must agree',()=>{
 const context={ownerRef:'o',accountRef:'1',subjectRef:'s',ownerEpoch:1,runEpoch:2,connectionEpoch:3};
 const observation={source:'response',transport:'answered',envelopeOk:true,dsName:'G.ISyncData',rejected:false,
  method:'usrLand.water',connectionEpoch:3,requestSequence:2,responseRef:'answer',receivedDeviceMs:2000,receivedMonotonicMs:1000,
  value:{100:{1:{1001:{0:23001,1:2,7:1000}}}}};
 const fields=['state','flowerId','plantTime'], paths=fields.map(f=>'land.lands.1001.fields.'+f);
 const source={sourceRef:'answer',method:observation.method,connectionEpoch:3,requestSequence:2,observedAtMs:2000,observedMonotonicMs:1000};
 const item={domainId:'land',paths,semanticValue:Object.fromEntries(paths.map((p,i)=>[p,[2,23001,1000][i]])),
  cellSources:Object.fromEntries(paths.map(p=>[p,{...source}]))};
 const target={context,landId:1001,featureId:'water',fields};
 const check=(i=item,o=observation)=>postWriteCoverage({domainId:'land',item:i,observation:o,target});
 assert.equal(check().proven,true);assert.equal(check().admission,'none');
 const wrong=structuredClone(item);wrong.semanticValue[paths[0]]=3;assert.equal(check(wrong).proven,false);
 const stale=structuredClone(item);stale.cellSources[paths[0]].observedMonotonicMs=999;assert.equal(check(stale).proven,false);
 const other=structuredClone(observation);other.value[100][1][1002]={0:23001,1:2,7:1000};assert.equal(check(item,other).proven,false);
 const missing=structuredClone(observation);delete missing.value[100][1][1001][7];assert.equal(check(item,missing).proven,false);
});

test('provided empty harvest member proves semantic absence; omitted member and partial row remain unproven',()=>{
 const context={ownerRef:'o',accountRef:'1',subjectRef:'s',ownerEpoch:1,runEpoch:2,connectionEpoch:3};
 const observation={source:'response',transport:'answered',envelopeOk:true,dsName:'G.ISyncData',method:'usrLand.harvest',connectionEpoch:3,
  requestSequence:2,responseRef:'empty',receivedDeviceMs:2000,receivedMonotonicMs:1000,value:{100:{1:{1001:{}}}}};
 const fields=['state','flowerId','plantTime','harvestCnt','nextTime'],paths=fields.map(f=>'land.lands.1001.fields.'+f);
 const source={sourceRef:'empty',method:observation.method,connectionEpoch:3,requestSequence:2,observedAtMs:2000,observedMonotonicMs:1000};
 const item={domainId:'land',paths,semanticValue:Object.fromEntries(paths.map(p=>[p,{presence:'missing'}])),cellSources:Object.fromEntries(paths.map(p=>[p,source]))};
 const target={context,landId:1001,featureId:'harvest',fields,workset:{before:{landId:1001,status:'occupied',flowerId:23001,cropRef:'crop'}}};
 const check=o=>postWriteCoverage({domainId:'land',item,observation:o,target});
 assert.equal(check(observation).proven,true);assert.equal(check(observation).basis,'land-post-write-explicit-empty/v1');
 const omitted=structuredClone(observation);delete omitted.value[100][1][1001];assert.equal(check(omitted).proven,false);
 const partial=structuredClone(observation);partial.value[100][1][1001]={1:0};assert.equal(check(partial).proven,false);
});
