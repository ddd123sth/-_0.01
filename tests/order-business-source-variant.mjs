import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {officialStoredStockCapacity as cap} from '../runtime/backend/features/order-flower/butler.mjs';
import {proveOfficialSourceActions} from '../runtime/backend/official-source-proof.mjs';
test('new official satin/decorate stock cap consumes the displayed daily allowance, preserving resident/legacy rules',()=>{
 const input={kind:'satin',capacity:20,dailyLimit:120,counter:{known:true,uiDisplayCount:119},dailyClamp:true};
 assert.equal(cap(input),1);assert.equal(cap({...input,counter:{known:true,uiDisplayCount:120}}),0);
 assert.equal(cap({...input,counter:{known:true,uiDisplayCount:0}}),20);
 assert.equal(cap({...input,counter:{known:false}}),null);
 assert.equal(cap({...input,kind:'resident'}),20);assert.equal(cap({...input,dailyClamp:false}),20);
});
const root='.runtime/validation/r8-a-20261101/public-source/';
test('audited current source bytes prove butler accounting; a changed module cannot reuse the variant', {skip:!fs.existsSync(root+'game.decoded.js')},()=>{
 const gameBytes=fs.readFileSync(root+'game.decoded.js'),moBytes=fs.readFileSync(root+'mo.decoded.js');const input={gameVersion:'490.0.5',protocolVersion:'480.0.0',index:JSON.parse(fs.readFileSync(root+'index.json')),gameBytes,moBytes,indexSha256:'a6200ed3b9c4d0d793c6d6de039d620b4ee57f4af4b4ac98040cbd8148f03311'};
 assert.equal(proveOfficialSourceActions(input)['order.butler-stock'].supported,true);
 const changed=Buffer.from(gameBytes);changed[0]^=1;
 assert.equal(proveOfficialSourceActions({...input,gameBytes:changed})['order.butler-stock'].supported,false);
 assert.equal(proveOfficialSourceActions({...input,gameVersion:'490.0.6',index:{...input.index,version:'490.0.6'}})['order.butler-stock'].supported,false);
});
