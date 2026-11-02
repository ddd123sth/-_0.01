import test from 'node:test';import assert from 'node:assert/strict';
import {landSnapshotVersionEvidence} from '../runtime/backend/features/land/runtime.mjs';
import {fingerprint} from '../runtime/backend/common.mjs';
test('large verified catalog remains separate while proof hashes and identity survive binding',()=>{
 const tables={c_item:Object.fromEntries(Array.from({length:20000},(_,i)=>[i,{id:i,description:'catalog row '.repeat(20)}]))};
 const tableHashes={c_item:fingerprint(tables.c_item)},profileBinding={loginResponseRef:'login',connectionEpoch:9};
 const evidence={source:'normal-package-hop-and-matched-world-login/v1',gameVersion:'490.0.5',protocolVersion:'480.0.0',tables,profileBinding};
 const snapshot={tables,tableHashes,dataSnapshotId:'sha256:catalog',bundleRef:'sha256:bundle',sourceVersion:'490.0.5'};
 const bound=landSnapshotVersionEvidence(evidence,snapshot,'480.0.0','login');
 assert.ok(Buffer.byteLength(JSON.stringify(tables))>4*1024*1024);
 assert.ok(Buffer.byteLength(JSON.stringify(bound))<4096,'per-login proof must not grow with catalog row count');
 assert.deepEqual(bound.tableHashes,tableHashes);assert.deepEqual(bound.profileBinding,profileBinding);
 assert.equal(snapshot.tables.c_item[42],tables.c_item[42]);assert.equal(bound.dataSnapshotId,snapshot.dataSnapshotId);
});
