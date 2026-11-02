import fs from 'node:fs';import crypto from 'node:crypto';
const FILE=new URL('./contracts/official-business-source-variants-v1.json',import.meta.url);
export const BUSINESS_SOURCE_VARIANTS_SHA256='317a0b196693d10336d7c6ed1e73244e9fbfb903d9eac6010bea0f939ad6e7d8';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function auditedBusinessSourceVariant({actionId,blockName,baselineSha256,sourceVersion,gameBytes,moBytes}) {
 const bytes=fs.readFileSync(FILE);if(digest(bytes)!==BUSINESS_SOURCE_VARIANTS_SHA256)throw Error('BUSINESS_SOURCE_VARIANT_INTEGRITY');
 const doc=JSON.parse(bytes);if(doc.schema!=='official-business-source-variants/v1')throw Error('BUSINESS_SOURCE_VARIANT_SCHEMA');
 const variant=doc.variants.find(v=>v.actionId===actionId&&v.blockName===blockName&&v.baselineSha256===baselineSha256&&v.sourceVersion===sourceVersion);
 if(!variant||!Buffer.isBuffer(gameBytes)||!Buffer.isBuffer(moBytes)||digest(gameBytes)!==variant.gameSha256||digest(moBytes)!==variant.moSha256)return null;
 if(!Number.isSafeInteger(variant.byteStart)||!Number.isSafeInteger(variant.byteEnd)||variant.byteStart<0||variant.byteEnd>gameBytes.length||variant.byteEnd<=variant.byteStart)return null;
 const block=gameBytes.subarray(variant.byteStart,variant.byteEnd);return digest(block)===variant.sha256?{bytes:block,sha256:variant.sha256}:null;
}
