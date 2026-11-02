import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createBackendLedger } from '../runtime/backend/persistence/ledger.mjs';
import { fingerprint } from '../runtime/backend/common.mjs';
import { landWriteTarget } from '../runtime/backend/features/land/projection.mjs';

test('a real durable land original retains exact request values, rejects mismatches and leaves old originals unguessed', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'r8-land-request-'));const store=openBackendStore({dataDir:root});
  try {
    const ledger=createBackendLedger(store), context={ownerRef:'owner',accountRef:'1',subjectRef:'subject',ownerEpoch:1,runEpoch:2,connectionEpoch:3};
    const params={landId:1001};
    const input={...context,operationId:'op-new',proposalId:'p-new',executorRef:'executor',featureId:'harvest',scope:'harvest',method:'usrLand.harvest',
      semanticKey:'harvest:crop',paramsFingerprint:fingerprint(params),configRevision:1,cancelEpoch:0,factBasis:{crop:'crop'},
      targets:[{memberKey:'land:1001',targetKind:'land',targetRef:'land:subject:1001',lifecycleRef:'crop',targetFingerprint:'target'}],resources:[],resourceBindings:[],
      landRequest:{version:'land-request/v1',params}};
    ledger.prepareOperation(input);params.landId=1002;
    const row=ledger.operation('op-new'), observation={method:input.method,operationId:'op-new'};
    assert.equal(row.original.landRequest.params.landId,1001);
    assert.equal(landWriteTarget({original:row.original,operationRow:row,context,observation}).landId,1001);
    const wrong=structuredClone(row.original);wrong.landRequest.params.landId=1002;
    assert.equal(landWriteTarget({original:wrong,operationRow:row,context,observation}),null);
    const old=structuredClone(row.original);delete old.landRequest;
    assert.equal(landWriteTarget({original:old,operationRow:row,context,observation}),null);
    assert.throws(()=>ledger.prepareOperation({...input,operationId:'op-bad',landRequest:{version:'land-request/v1',params:{landId:1002}}}),{code:'LAND_PROPOSAL_BINDING_INVALID'});
  } finally {store.close();fs.rmSync(root,{recursive:true,force:true});}
});
