import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, BASE } from './helpers-land-current-need-fixture.mjs';

const now = 1_800_000_000_000;
function populateArtNeed(obs) {
  const raw = obs.value;
  raw['7']['0'] = { ...raw['7']['0'], '0': 77123, '32': { '7': 8, '23001': 3, '23002': 3, '23003': 3, '300101': 0 }, '33': {}, '41': 100000, '44': 100000 };
  raw['22'] = { '0': { '0': 77123, '1': 90002 } };
  raw['109']['0'] = { '0': 77123, '1': { '1': { '0': 1, '1': 300101, '2': 1, '3': 1, '4': now - 10000 } },
    '2': now - 10000, '3': now - 10000, '4': now - 10000, '5': 0, '6': [], '7': true };
  raw['105']['0'] = { ...raw['105']['0'], '0': 77123, '1': { '1': { '0': 1, '1': 0, '2': [[23001, 2]], '3': false,
    '4': now - 1000, '5': now - 1000, '6': 1 } }, '2': [], '3': null, '10': now };
  raw['102'] = { '0': { '3001': { '0': 77123, '1': 3001, '2': now - 1000, '3': now - 1000 } } };
  raw['106'] = { '0': { '0': 77123, '2': [] } };
}
async function configForArt(f) {
  const before = f.configService.read({ ownerRef: BASE.ownerRef, accountRef: BASE.accountRef });
  const config = structuredClone(before.config);
  config.art = { ...config.art, makeEnabled: true };
  config.orders.customer = { ...config.orders.customer, enabled: true, autoReject: false, coinTiers: [1] };
  f.configService.save({ ownerRef: BASE.ownerRef, accountRef: BASE.accountRef, expectedRevision: before.savedRevision, config });
  const saved = f.configService.read({ ownerRef: BASE.ownerRef, accountRef: BASE.accountRef });
  return f.configService.accept({ ownerRef: BASE.ownerRef, accountRef: BASE.accountRef,
    revision: saved.savedRevision, actorRef: 'fixture:art-producer-gateway' });
}
test('actual art runtime plans a current customer shortage and reaches registered gateway permit', async () => {
  const f = fixture();
  try {
    f.installCustomerRuntime();
    const art = f.installArtRuntime();
    const config = await configForArt(f);
    f.seedLogin(f.active, 1, 1, populateArtNeed);
    const planned = art.planning(f.active, config);
    assert.equal(planned.current, true);
    
    console.log('DYN', JSON.stringify(f.dynamic.snapshot({ context:f.active, feature:art.feature, config:config.config, method:'flowerArt.makeFlowerArt', proposal:{method:'flowerArt.makeFlowerArt'} }))); const assessed = await art.feature.assess({ context: f.active, config });
    assert.equal(assessed.state, 'proposals', JSON.stringify({ state: assessed.state, reasonCode: assessed.reasonCode,
      customer: planned.customer }));
    const proposal = assessed.proposals[0];
    assert.equal(proposal.method, 'flowerArt.makeFlowerArt');
    assert.equal(proposal.art.currentNeed.necessary, true);
    assert.ok(proposal.art.currentNeed.claimRef);
    await assert.rejects(f.gateway.submit(proposal), { code: 'FIXTURE_ANSWER_LOST' });
    const operation = f.ledger.operation(proposal.operationId);
    assert.equal(operation.business_verdict, 'unknown');
    assert.equal(operation.write_slot, 1);
    assert.equal(f.sendBytes, 1);
    assert.equal(f.store.get('SELECT consumed FROM backend_send_permits WHERE operation_id=?', proposal.operationId).consumed, 1);
  } finally { await f.close(); }
});






