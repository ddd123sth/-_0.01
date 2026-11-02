import test from 'node:test';import assert from 'node:assert/strict';
import {encodeEvidenceJson,decodeEvidenceJson} from '../runtime/backend/persistence/evidence-codec.mjs';
import {parseStored,fingerprint} from '../runtime/backend/common.mjs';
import {hashLedgerBytes} from '../runtime/backend/persistence/json-contract.mjs';
test('evidence compression preserves exact UTF-8 bytes and semantic fingerprints',()=>{
 const raw=JSON.stringify({proof:'中文来源'.repeat(100000),context:{connectionEpoch:2}}),encoded=encodeEvidenceJson(raw);
 assert.ok(encoded.startsWith('zjson:v1:'));assert.ok(encoded.length<raw.length/10);
 assert.equal(decodeEvidenceJson(encoded),raw);assert.equal(hashLedgerBytes(decodeEvidenceJson(encoded)),hashLedgerBytes(raw));
 assert.equal(fingerprint(parseStored(encoded,'proof')),fingerprint(JSON.parse(raw)));
});
test('legacy small JSON remains byte-identical and codec is idempotent for legacy reads',()=>{
 const raw='{"x":1}';assert.equal(encodeEvidenceJson(raw),raw);assert.equal(decodeEvidenceJson(raw),raw);assert.deepEqual(parseStored(raw,'proof'),{x:1});
});
test('truncation, corrupt streams and oversized envelopes fail closed',()=>{
 const encoded=encodeEvidenceJson(JSON.stringify({proof:'x'.repeat(100000)}));
 for(const raw of [encoded.slice(0,-4),'zjson:v1:999999999:00','zjson:v1:2:deadbeef','zjson:v1:2:f'])
 assert.throws(()=>parseStored(raw,'proof'),{code:'BACKEND_STORAGE_CORRUPT'});
});
