import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {orderFlowerAfterCloseLoginProof} from '../runtime/backend/features/order-flower/rpc-contract.mjs';
import {answerGateDiagnostics} from '../runtime/backend/features/order-flower/verification.mjs';
const capture='.runtime/validation/r8-a-20261101/window02/bridge-replay-input.json';
test('captured old raw server release and new normalized login retain exact close/version/UID axes', {skip:!fs.existsSync(capture)},()=>{
 const input=JSON.parse(fs.readFileSync(capture));const old=structuredClone(input);
 const proof=orderFlowerAfterCloseLoginProof(input);assert.equal(proof.newContext.connectionEpoch,1196);
 assert.deepEqual(input,old,'verification must not rewrite the recorded bridge');
 for(const change of [
  x=>{delete x.proposal.orderFlower.versionEvidence.serverVersionBinding;},
  x=>{x.bridge.newLoginObservation.versionEvidence.serverVersionBinding.context.connectionEpoch++;},
  x=>{x.bridge.oldLoginSource.versionEvidence.protocolVersion='999.0.0';},
  x=>{x.bridge.newLoginObservation.value['7']['0']['0']++;},
  x=>{x.bridge.oldPhysicalCloseReceipt.closed=false;}
 ]){const mutated=structuredClone(input);change(mutated);assert.throws(()=>orderFlowerAfterCloseLoginProof(mutated),{code:'ORDER_FLOWER_AFTER_CLOSE_BRIDGE_INVALID'});}
});

test('matched write release is checked against its exact login semantic binding in both fields', {skip:!fs.existsSync(capture)},()=>{
 const {proposal}=JSON.parse(fs.readFileSync(capture)), anchor=proposal.orderFlower.versionEvidence;
 const response={source:'response',transport:'answered',method:proposal.method,connectionEpoch:proposal.connectionEpoch,
  requestSequence:3,wireKey:'captured-contract-test:3',responseRef:'captured-contract-test:answer',envelopeOk:true,dsName:'G.ISyncData',
  rejected:false,messagePresent:false,versionEvidence:{gameVersion:anchor.gameVersion,protocolVersion:anchor.reportedServerVersion,
   loginResponseRef:anchor.loginResponseRef},protocolVersion:anchor.reportedServerVersion};
 const check=(p,r)=>answerGateDiagnostics(p,r,r.versionEvidence,p.orderFlower.versionEvidence);
 assert.deepEqual(check(proposal,response).failedGateNames,[]);
 for(const change of [
  (p,r)=>{delete p.orderFlower.versionEvidence.serverVersionBinding;},
  (p,r)=>{p.connectionEpoch++;r.connectionEpoch++;},
  (p,r)=>{r.versionEvidence.protocolVersion='999.0.0';},
  (p,r)=>{r.protocolVersion='999.0.0';},
  (p,r)=>{r.versionEvidence.protocolVersion=p.orderFlower.versionEvidence.protocolVersion;r.versionEvidence.reportedServerVersion='999.0.0';},
  (p,r)=>{p.orderFlower.officialUid++;}
 ]){const p=structuredClone(proposal),r=structuredClone(response);change(p,r);assert(check(p,r).failedGateNames.some(n=>n.includes('protocolVersion')));}
});
