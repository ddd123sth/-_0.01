import assert from 'node:assert/strict';
import test from 'node:test';
import { CUSTOMER_GENERATION_STATIC } from '../runtime/backend/features/customer/generation.mjs';
import { customerGenerationCapSuspension } from '../runtime/backend/features/customer/generation-runtime.mjs';
import { generationOpenNpcPolicy } from '../runtime/backend/features/customer/generation-contract.mjs';

// Offline typed producer fixture: this verifies only the adapter from an
// already-derived generation decision to a durable cap proof, not live server data.
const context = { ownerRef: 'fixture:owner', accountRef: '7', subjectRef: 'fixture:subject', ownerEpoch: 1, runEpoch: 1, connectionEpoch: 4 };
const ref = 'fixture:matched-login:9', uid = 71, startMs = Date.UTC(2026, 9, 26);
const source = { method: 'index.login', responseRef: ref, wireKey: 'fixture:wire:9', connectionEpoch: 4, requestSequence: 9,
  officialUid: uid, kind: 'response' };
const day = { known: true, key: '2026-10-26', startMs, endMs: startMs + 86400000, proofRef: 'fixture:day-proof',
  source: { ...source, officialUid: uid } };
function fixture(overrides = {}) {
  const board = { complete: true, entries: [], total: 0, source };
  const stock = { complete: true, entries: [], total: 0, reportedEmpty: true, source };
  const state = { context, view: { current: true, identity: { verified: true,
    uid: { presence: 'present', state: 'known', value: uid } }, orderMap: board, orderStockList: stock },
    facts: { officialDay: day, count107: { current: true, uid, type: 107, tdyCnt: 350, rTimeMs: startMs + 500,
      source } }, clock: { available: true, source: 'official-anchor-monotonic', connectionEpoch: 4, nowMs: startMs + 1000 } };
  return { decision: { state: 'no-action', reasonCode: 'CUSTOMER_GENERATION_DAILY_OPPORTUNITY_EXHAUSTED', sources: [source] },
    state: { ...state, ...overrides.state }, configRevision: 3, staticPolicy: CUSTOMER_GENERATION_STATIC };
}

test('customer generation producer scopes its proven 350-opportunity quota to generation action', () => {
  const result = customerGenerationCapSuspension(fixture());
  assert.equal(result?.state, 'cap-wait');
  assert.equal(result.suspension.quotaKey, 'order.customer:generation');
  assert.equal(result.suspension.actionScope, 'order.customer:generation');
  assert.equal(result.suspension.scope, 'official');
  assert.equal(result.suspension.periodKey, day.key);
  assert.equal(result.suspension.proofRefs.includes(ref), true);
});

test('generation open-NPC policy accepts a current matched normal sync while retaining the login anchor elsewhere', () => {
  const normal = { ...source, method: 'usr.heartTick', responseRef: 'fixture:matched-heartbeat:10', requestSequence: 10,
    wireKey: 'ws|1|10' };
  const policy = generationOpenNpcPolicy({ context, mainTaskId: 300202, source: normal });
  assert.equal(policy.mainTaskSource.method, 'usr.heartTick');
  assert.equal(policy.openNpcIds.length > 0, true);
});

test('independently sourced current counters are accepted while missing identity or official clock cannot fabricate a cap', () => {
  const independentCounter = fixture();
  independentCounter.state.facts.count107 = { ...independentCounter.state.facts.count107,
    source: { ...source, method: 'usr.heartTick', responseRef: 'other-response', requestSequence: 10 } };
  assert.equal(customerGenerationCapSuspension(independentCounter)?.state, 'cap-wait');
  const noClock = fixture({ state: { clock: { available: false } } });
  assert.equal(customerGenerationCapSuspension(noClock), null);
  const wrongUid = fixture();
  wrongUid.state.view.identity.uid.value = 72;
  assert.equal(customerGenerationCapSuspension(wrongUid), null);
});
