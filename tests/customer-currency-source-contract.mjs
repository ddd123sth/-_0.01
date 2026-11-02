import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './helpers-land-current-need-fixture.mjs';
import { assertCustomerRejectProposal } from '../runtime/backend/features/customer/rejection-contract.mjs';

test('customer reject producer keeps gold and yuanbao source tuples distinct and rejects missing yuanbao provenance', async () => {
  const f = fixture();
  try {
    const installed = f.installCustomerRuntime();
    const current = f.configService.read({ ownerRef: f.active.ownerRef, accountRef: f.active.accountRef });
    f.configService.save({ ownerRef: f.active.ownerRef, accountRef: f.active.accountRef, expectedRevision: current.savedRevision,
      config: { ...current.config, orders: { ...current.config.orders,
        customer: { ...current.config.orders.customer, enabled: true, coinTiers: [1], autoReject: true } } } });
    const saved = f.configService.read({ ownerRef: f.active.ownerRef, accountRef: f.active.accountRef });
    const config = f.configService.accept({ ownerRef: f.active.ownerRef, accountRef: f.active.accountRef,
      revision: saved.savedRevision, actorRef: 'fixture:customer-currency-contract' });
    const context = f.active;
    const login = f.seedLogin(context, 1, 1, observation => {
      observation.value['109']['0']['1'] = { '12': { '0': 1, '1': 300202, '2': 2, '3': 0, '4': 1_800_000_001_100 } };
      observation.value['109']['0']['6'] = [];
      observation.value['7']['0']['32'] = { '300202': 10, '7': 8 };
      observation.value['7']['0']['33'] = { '300202': {} };
      observation.value['7']['9'] = { sys_orderCustomer: { '0': 'sys_orderCustomer', '9': 0 } };
      observation.value['22'] = { '0': { '0': 77123, '1': 90002 } };
    });
    const unit = installed.runtime.feature.scheduleUnits.find(one => one.scheduleKey === 'order.customer:reject');
    const result = await unit.assess({ context, config });
    assert.equal(result.state, 'proposals', JSON.stringify(result));
    const proposal = result.proposals[0];
    assert.equal(proposal.method, 'orderCustomer.rejectOrder');
    assert.equal(proposal.customer.beforeProfile.goldSource.responseRef, login.responseRef);
    assert.equal(proposal.customer.beforeProfile.ybSource.responseRef, login.responseRef);
    assert.throws(() => assertCustomerRejectProposal({ ...proposal, customer: { ...proposal.customer,
      beforeProfile: { ...proposal.customer.beforeProfile, ybSource: undefined } } }),
    { code: 'CUSTOMER_REJECT_ORIGINAL_BALANCES_REQUIRED' });
    assert.throws(() => assertCustomerRejectProposal({ ...proposal, customer: { ...proposal.customer,
      beforeProfile: { ...proposal.customer.beforeProfile,
        ybSource: { ...proposal.customer.beforeProfile.ybSource, requestSequence: 0 } } } }),
    { code: 'CUSTOMER_REJECT_ORIGINAL_BALANCES_REQUIRED' });
    f.mode = 'unknown';
    await assert.rejects(f.customerGateway.submit(proposal), { code: 'FIXTURE_ANSWER_LOST' });
    assert.equal(f.sendBytes, 1, 'the true rejection producer passed registry/currentNeed/gateway and consumed one permit');
  } finally { await f.close(); }
});

