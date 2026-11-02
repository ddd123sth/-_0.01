import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, BASE } from './helpers-land-current-need-fixture.mjs';

test('real customer finish producer reaches composed registry, shared claim, ledger and gateway permit', async () => {
  const f = fixture();
  try {
    const installed = f.installCustomerRuntime();
    const context = f.active;
    const login = f.seedLogin(context, 1, 1, observation => {
      observation.value['109']['0']['1'] = { '12': { '0': 1, '1': 300202, '2': 1, '3': 0, '4': 1_800_000_001_100 } };
      observation.value['109']['0']['6'] = [];
      observation.value['7']['0']['32'] = { '300202': 1, '7': 8 };
      observation.value['7']['0']['33'] = { '300202': {} };
      observation.value['7']['9'] = { sys_orderCustomer: { '0': 'sys_orderCustomer', '9': 0 } };
      observation.value['22'] = { '0': { '0': 77123, '1': 90002 } };
    });
    assert.equal(f.customerReadModel.snapshot(context).orders[0].npcId, 12);
    const { runtime, config } = installed;
    const result = await runtime.feature.scheduleUnits.find(unit => unit.scheduleKey === 'order.customer:delivery')
      .assess({ context, config });
    const planning = runtime.planning(context, config);
    assert.equal(result.state, 'proposals', JSON.stringify({ result, customerOpen: planning.eligibility.customerOpen,
      decisions: planning.decisions.map(one => ({ verdict: one.verdict, reasonCode: one.reasonCode, lifecycleRef: one.lifecycleRef })),
      allocation: planning.allocation, domains: f.dynamic.snapshot({ context, feature: runtime.feature, config: config.config,
        method: 'orderCustomer.finishOrder', proposal: { method: 'orderCustomer.finishOrder', customer: { currentNeed: { necessary: true } } } }).domains }));
    const proposal = result.proposals[0];
    assert.equal(proposal.method, 'orderCustomer.finishOrder');
    assert.equal(proposal.customer.currentNeed.necessary, true);
    f.mode = 'unknown';
    await assert.rejects(f.customerGateway.submit(proposal), { code: 'FIXTURE_ANSWER_LOST' });
    assert.equal(f.sendBytes, 1, 'the registered customer producer consumed one real gateway permit');
    const operation = f.ledger.operation(proposal.operationId);
    assert.equal(operation.feature_id, 'order.customer');
    assert.equal(operation.method, 'orderCustomer.finishOrder');
    assert.equal(operation.business_verdict, 'unknown');
    assert.equal(operation.write_slot, 1);
    assert.equal(login.responseRef, proposal.customer.versionEvidence.loginResponseRef);
  } finally {
    await f.close();
  }
});
