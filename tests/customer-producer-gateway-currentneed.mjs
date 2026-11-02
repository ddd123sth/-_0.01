// Offline C customer producer-to-gateway candidate; no live service or DB.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, BASE } from './helpers-land-current-need-fixture.mjs';

const officialNow = 1_800_000_000_000;
function populateCustomerFrame(observation, { npc = false } = {}) {
  const raw = observation.value;
  raw['7']['0'] = { ...raw['7']['0'], '0': 77123, '3': 1, '1': 100000, '11': 100000, '34': 100, '36': 0,
    '41': 100000, '44': 100000,
    '32': { '7': 100, '23001': 20, '23002': 20 }, '33': {} };
  raw['7']['9'] = { sys_orderCustomer: { '0': 'sys_orderCustomer', '2': 0, '3': 0, '4': 1, '5': 0, '6': 1, '9': 0, '10': {} } };
  raw['22'] = { '0': { '0': 77123, '1': 730001 } };
  raw['109'] = { '0': { '0': 77123, '1': npc ? { '1': { '0': 1, '1': 23001, '2': 1, '3': 1, '4': officialNow - 10000 } } : {},
    '2': officialNow - 10000, '3': officialNow - 10000, '4': officialNow - 10000, '5': 0, '6': [], '7': true } };
  raw['7']['4']['107'] = { '0': 77123, '1': 107, '2': 0, '3': 0, '4': officialNow - 86400000,
    '5': officialNow - 86400000, '6': officialNow - 86400000 };
}
async function acceptedConfig(f, { autoReject, coinTiers }) {
  const prior = f.configService.read({ ownerRef: BASE.ownerRef, accountRef: BASE.accountRef });
  const config = structuredClone(prior.config);
  config.orders.customer = { ...config.orders.customer, enabled: true, autoReject, coinTiers };
  f.configService.save({ ownerRef: BASE.ownerRef, accountRef: BASE.accountRef, expectedRevision: prior.savedRevision, config });
  const saved = f.configService.read({ ownerRef: BASE.ownerRef, accountRef: BASE.accountRef });
  return f.configService.accept({ ownerRef: BASE.ownerRef, accountRef: BASE.accountRef, revision: saved.savedRevision,
    actorRef: 'fixture:customer-gateway-candidate' });
}
function unit(runtime, method) {
  return runtime.feature.scheduleUnits.find(one => one.allowedMethods.includes(method));
}
async function closeAndReassess(f, oldProposal, unitForAction, receipt) {
  const oldBefore = f.store.get('SELECT original_json,original_fingerprint,business_verdict,write_slot FROM backend_operations WHERE operation_id=?', oldProposal.operationId);
  assert.equal(oldBefore.business_verdict, 'unknown');
  assert.equal(oldBefore.write_slot, 1);
  f.advanceEpoch(2);
  const login = f.seedLogin(f.active, 2, 1, observation => populateCustomerFrame(observation, { npc: oldProposal.method === 'orderCustomer.rejectOrder' }));
  assert.equal(f.recoverClosedWriteSlots(login).released.length, 1, 'real close evidence releases the exact old technical slot');
  const now = await unitForAction.assess({ context: f.active, config: receipt });
  assert.equal(now.state, 'proposals', JSON.stringify({ state: now.state, reasonCode: now.reasonCode }));
  const nextProposal = now.proposals[0];
  assert.notEqual(nextProposal.operationId, oldProposal.operationId);
  await assert.rejects(f.customerGateway.submit(nextProposal), { code: 'FIXTURE_ANSWER_LOST' });
  const oldAfter = f.store.get('SELECT original_json,original_fingerprint,business_verdict,write_slot FROM backend_operations WHERE operation_id=?', oldProposal.operationId);
  assert.equal(oldAfter.original_json, oldBefore.original_json);
  assert.equal(oldAfter.original_fingerprint, oldBefore.original_fingerprint);
  assert.equal(oldAfter.business_verdict, 'unknown');
  assert.equal(oldAfter.write_slot, 0);
  assert.equal(f.sendBytes, 2, 'one original unknown plus one fresh-generation send');
}
test('real customer reject producer claims, sends once, retains unknown, then allows only a fresh epoch decision', async () => {
  const f = fixture();
  try {
    const { runtime } = f.installCustomerRuntime();
    const config = await acceptedConfig(f, { autoReject: true, coinTiers: [] });
    f.seedLogin(f.active, 1, 1, observation => populateCustomerFrame(observation, { npc: true }));
    const action = unit(runtime, 'orderCustomer.rejectOrder');
    const first = await action.assess({ context: f.active, config });
    assert.equal(first.state, 'proposals', JSON.stringify({ state: first.state, reasonCode: first.reasonCode }));
    const proposal = first.proposals[0];
    assert.equal(proposal.method, 'orderCustomer.rejectOrder');
    assert.ok(proposal.customer.filteredDecisionRef, 'empty configured tier set is an explicit policy rejection');
    assert.equal(proposal.customer.rejectCause, undefined, 'this case is policy filtering, not fabricated physical impossibility');
    assert.equal(proposal.customer.currentNeed.necessary, true);
    assert.ok(proposal.customer.currentNeed.claimRef);
    await assert.rejects(f.customerGateway.submit(proposal), { code: 'FIXTURE_ANSWER_LOST' });
    const row = f.ledger.operation(proposal.operationId);
    assert.equal(row.business_verdict, 'unknown');
    assert.equal(row.write_slot, 1);
    assert.equal(f.sendBytes, 1);
    await assert.rejects(f.customerGateway.submit(proposal));
    const repeatedAssessment = await action.assess({ context: f.active, config });
    assert.notEqual(repeatedAssessment.state, 'proposals', 'same epoch cannot manufacture a second decision after current-need consumption');
    assert.equal(f.sendBytes, 1, 'same proposal and same epoch cannot consume a second permit');
    await closeAndReassess(f, proposal, action, config);
  } finally { await f.close(); }
});

test('real customer empty-board generation uses current quota/resources, claims, and cannot resend within its epoch', async () => {
  const f = fixture();
  try {
    const { runtime } = f.installCustomerRuntime();
    const config = await acceptedConfig(f, { autoReject: false, coinTiers: [1, 2, 3] });
    f.seedLogin(f.active, 1, 1, observation => populateCustomerFrame(observation, { npc: false }));
    const action = unit(runtime, 'orderCustomer.genOrder');
    const first = await action.assess({ context: f.active, config });
    assert.equal(first.state, 'proposals', JSON.stringify({ state: first.state, reasonCode: first.reasonCode }));
    const proposal = first.proposals[0];
    assert.equal(proposal.method, 'orderCustomer.genOrder');
    assert.equal(proposal.generation.beforeBoard.length, 0);
    assert.equal(proposal.generation.beforeCount.effectiveCount, 0);
    assert.ok(proposal.generation.openRegularNpcIds.length > 0);
    assert.equal(proposal.generation.beforeProfile.gold, 100000);
    assert.equal(proposal.generation.beforeProfile.yb, 100000);
    assert.equal(proposal.generation.beforeProfile.completeBagFingerprint.known, true);
    assert.equal(proposal.customer.currentNeed.necessary, true);
    assert.ok(proposal.customer.currentNeed.claimRef);
    await assert.rejects(f.customerGateway.submit(proposal), { code: 'FIXTURE_ANSWER_LOST' });
    const row = f.ledger.operation(proposal.operationId);
    assert.equal(row.business_verdict, 'unknown');
    assert.equal(row.write_slot, 1);
    assert.equal(f.sendBytes, 1);
    await assert.rejects(f.customerGateway.submit(proposal));
    assert.equal(f.sendBytes, 1, 'same proposal/epoch cannot consume a second permit');
    await closeAndReassess(f, proposal, action, config);
  } finally { await f.close(); }
});
