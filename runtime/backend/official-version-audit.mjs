import {plainObject} from './common.mjs';
const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>value&&Object.hasOwn(value,k)).map(k=>[k,value[k]]));
const CONTEXT=['ownerRef','accountRef','subjectRef','ownerEpoch','runEpoch','connectionEpoch'];
const BINDING=['version','proofRef','sourceVersion','gameSha256','moSha256','coreContractId','protocolContractVersion','bundleRef',
  'dataSnapshotId','resourceSha256','reportedServerVersion','loginResponseRef','officialUid','bindingRef'];
const PROOF=['extensionId','sourcePin','referenceGameVersion','referenceGameSha256','referenceMoVersion','referenceMoSha256',
  'gameSha256','moSha256','coreContractId','protocolContractVersion','sourceVersion','bundleRef','dataSnapshotId','resourceSha256','proofRef'];
const RANGE=['module','name','pinnedStart','pinnedEnd','actualStart','actualEnd','byteLength','sha256'];

// Projection only: signature/source validation remains in the existing normal
// version-binding verifier. Unknown fields still fail exact audit comparison.
export function officialVersionAuditExtras(value){
  const out=pick(value,['reportedServerVersion']);
  if(value&&Object.hasOwn(value,'serverVersionBinding')){
    const binding=value.serverVersionBinding;
    if(binding===null)out.serverVersionBinding=null;
    else if(!plainObject(binding))out.serverVersionBinding=null;
    else {
      const projected=pick(binding,BINDING);projected.context=plainObject(binding.context)?pick(binding.context,CONTEXT):null;
      projected.proof=plainObject(binding.proof)?{...pick(binding.proof,PROOF),matchedRanges:Array.isArray(binding.proof.matchedRanges)
        ?binding.proof.matchedRanges.slice(0,10).map(row=>pick(row,RANGE)):null}:null;
      out.serverVersionBinding=projected;
    }
  }
  return out;
}
