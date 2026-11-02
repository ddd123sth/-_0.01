import test from 'node:test';import assert from 'node:assert/strict';
import { captureLandWriteWorkset, landWriteWorksetValid } from '../runtime/backend/features/land/write-workset.mjs';
test('workset freezes every received member and every harvest-round member; missing members never produce a complete receipt',()=>{
 const context={ownerRef:'o',accountRef:'1',subjectRef:'s',ownerEpoch:1,runEpoch:2,connectionEpoch:3};
 const proposal={featureId:'harvest',params:{landId:1001},targets:[{lifecycleRef:'stage-1'}],
  land:{groupRef:'g',groupMemberKey:'member-1',roundRef:'r',before:{state:3}}};
 const acceptedLogin={accepted:true,frameFingerprint:'hash',frame:{context,observationRef:'obs',source:{kind:'response',method:'index.login',
  responseRef:'login',requestSequence:1},profile:{uid:{presence:'present',state:'known',value:123}},
  landBase:{presence:'present',state:'known',value:{1001:{state:3},1002:{state:3}}}}};
 const group={groupRef:'g',members:[{landId:1001,memberKey:'member-1'},{landId:1002,memberKey:'member-2'}],
  round:{roundRef:'r',members:[{landId:1001,stageRef:'stage-1'},{landId:1002,stageRef:'stage-2'}]}};
 const input={context,proposal,acceptedLogin,group},receipt=captureLandWriteWorkset(input);
 assert.equal(receipt.complete,true);assert.equal(receipt.loginReceivedMembers.length,2);assert.equal(receipt.group.round.members.length,2);
 assert.equal(landWriteWorksetValid(receipt,context,{landId:1001}),true);
 group.round.members.pop();assert.equal(receipt.group.round.members.length,2,'input mutation cannot shrink the frozen round');
 const changed=structuredClone(receipt);changed.loginReceivedMembers.pop();assert.equal(landWriteWorksetValid(changed,context,{landId:1001}),false);
 const missing=structuredClone(input);delete missing.acceptedLogin.frame.landBase.value[1002];
 assert.equal(captureLandWriteWorkset(missing).complete,false);
 assert.equal(landWriteWorksetValid(receipt,{...context,connectionEpoch:4},{landId:1001}),false);
});
