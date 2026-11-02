import assert from 'node:assert/strict';
import test from 'node:test';
import { canonical, fingerprint } from '../runtime/backend/common.mjs';
import { createOrderFlowerDeliveryAccounting } from '../runtime/backend/features/order-flower/delivery-accounting.mjs';
import { decodeOfficialOrderFlowerObservation, orderFlowerContextKey } from '../runtime/backend/features/order-flower/wire-facts.mjs';
import { planOrderFlowerStock } from '../runtime/backend/features/order-flower/planning.mjs';
import { createOfficialOrderFlowerCatalog } from '../runtime/backend/features/order-flower/catalog.mjs';

const context = { ownerRef: 'fixture:owner', accountRef: '71', subjectRef: 'fixture:subject', ownerEpoch: 1, runEpoch: 1, connectionEpoch: 4 };
const ctxKey = orderFlowerContextKey(context), dayStart = Date.UTC(2026, 9, 26), loginRef = 'fixture:login:1';
const versionEvidence = responseRef => ({ source: 'normal-package-hop-and-matched-world-login/v1', gameVersion: '480.0.27',
  protocolVersion: '480.0.0', loginResponseRef: loginRef });
function observation(sequence, method, value, responseRef) {
  return { source: 'response', transport: 'answered', method, connectionEpoch: 4, requestSequence: sequence,
    wireKey: `ws|4|${sequence}`, responseRef, envelopeOk: true, dsName: 'G.ISyncData', value,
    versionEvidence: versionEvidence(responseRef), serverMs: dayStart + 1000 + sequence, receivedDeviceMs: dayStart + 1100 + sequence,
    receivedMonotonicMs: 100 + sequence };
}
const loginObservation = observation(1, 'index.login', { '7': { '0': { '0': 71 }, '4': { '105': { '0': 71, '1': 105, '2': 1, '3': 9,
  '4': new Date(dayStart + 500).toISOString() } } }, '105': { '0': { '0': 71, '1': { '1': { '0': 10, '1': 20, '2': [[100, 1]], '3': false,
  '4': new Date(dayStart - 1000).toISOString(), '5': new Date(dayStart + 400).toISOString(), '6': 0, '7': {} } } } } }, loginRef);
const heartbeatObservation = observation(2, 'usr.heartTick', { '7': { '4': { '105': { '2': 2 } } } }, 'fixture:heartbeat:2');
const loginFrame = decodeOfficialOrderFlowerObservation({ context, observation: loginObservation });
const heartbeatFrame = decodeOfficialOrderFlowerObservation({ context, observation: heartbeatObservation });
assert.equal(loginFrame.admissible, true);
assert.equal(heartbeatFrame.admissible, true);

function currentCell(cell, source) { return { ...cell, current: true, source: structuredClone(source) }; }
const baseCounter = loginFrame.payload.counters[105], deltaCounter = heartbeatFrame.payload.counters[105];
const counters = Object.fromEntries(Object.keys(baseCounter).map(key => [key,
  currentCell(key === 'tdyCnt' ? deltaCounter[key] : baseCounter[key], key === 'tdyCnt' ? heartbeatFrame.source : loginFrame.source)]));
const view = { current: true, available: true, context, identity: { verified: true, uid: currentCell(loginFrame.payload.profileUid, loginFrame.source) },
  domain: currentCell(loginFrame.payload.domain, loginFrame.source), counters: { 105: counters }, fields: {
    uid: currentCell(loginFrame.payload.fields.uid, loginFrame.source), residentMap: currentCell(loginFrame.payload.fields.residentMap, loginFrame.source) },
  financial: {}, shares: {}, adCard: {} };
const officialDay = { known: true, key: '2026-10-26', startMs: dayStart, endMs: dayStart + 86400000, utcOffsetMinutes: 480,
  proofRef: 'fixture:day-proof', source: { kind: 'response', method: 'index.login', connectionEpoch: 4, requestSequence: 1,
    responseRef: loginRef, wireKey: 'ws|4|1', contextKey: ctxKey, officialUid: 71,
    version: { gameVersion: '480.0.27', protocolVersion: '480.0.0', loginResponseRef: loginRef } } };
const loginDay = { kind: 'complete-login-day', context, officialUid: 71, officialDay, source: { ...loginFrame.source,
  officialUid: 71, version: { ...loginFrame.source.version } } };
const observationRows = [loginFrame, heartbeatFrame].map(frame => ({ observation_ref: frame.observationRef, owner_ref: context.ownerRef,
  account_ref: context.accountRef, subject_ref: context.subjectRef, connection_epoch: 4, request_sequence: frame.source.requestSequence,
  response_ref: frame.source.responseRef, accepted: 1, payload_json: canonical(frame), payload_fingerprint: fingerprint(frame) }));

test('normal counter-only response and immutable legacy day receipt preserve the exact login/day identity anchor', () => {
  const planned = planOrderFlowerStock({ context, view, config: { config: { orders: { resident: { enabled: true, dailyLimit: 0 },
    satin: { enabled: false, dailyLimit: 0 }, decorate: { enabled: false, dailyLimit: 0 } } }, savedRevision: 1 },
    catalog: createOfficialOrderFlowerCatalog(), resources: { budget: () => ({ known: true, allowed: true }) },
    eligibility: { resident: { known: true, value: true, context, officialUid: 71, openId: 'sys_orderFlower', proofRef: 'fixture:eligibility' } },
    clock: { available: true, source: 'official-anchor-monotonic', connectionEpoch: 4, nowMs: dayStart + 2000,
      lowerBoundMs: dayStart + 1900, upperBoundMs: dayStart + 2100 }, officialDay });
  const residentPlan = planned.entries.find(row => row.kind === 'resident');
  assert.ok(residentPlan, JSON.stringify(planned));
  const count = residentPlan.count;
  assert.equal(count.known, true);
  assert.equal(count.raw, 2);
  assert.equal(count.cellProofs.tdyCnt.source.method, 'usr.heartTick');
  assert.equal(count.cellProofs.uid.source.responseRef, loginRef);

  const store = { run() {}, all() { return []; }, transaction(fn) { return fn(); }, nowIso: () => '2026-10-26T00:00:00.000Z',
    get(sql, ...params) {
      if (sql.includes('FROM backend_customer_generation_days')) {
        if (sql.includes('receipt_ref=?')) return { payload_json: canonical(loginDay), payload_fingerprint: fingerprint(loginDay), receipt_ref: 'fixture:day-receipt' };
        return { receipt_ref: 'fixture:day-receipt', payload_json: canonical(loginDay), payload_fingerprint: fingerprint(loginDay) };
      }
      if (sql.includes('FROM backend_order_flower_observations')) return observationRows.find(row => row.response_ref === params.at(-1)) ?? null;
      if (sql.includes('FROM backend_order_flower_delivery_receipts')) return null;
      return null;
    } };
  const accounting = createOrderFlowerDeliveryAccounting({ store });
  const policy = accounting.readPolicyCount({ context, kind: 'resident', officialDay, serverCount: count });
  assert.equal(policy.known, true);
  assert.equal(policy.value, 2);
  assert.equal(policy.serverCount.cellProofs.tdyCnt.source.method, 'usr.heartTick');

  // A prior immutable day packet can lack the duplicated source.version tuple
  // while retaining it under officialDay.source. Re-read that exact old shape
  // without updating the stored bytes or accepting a different response.
  const legacyLoginDay = structuredClone(loginDay);
  delete legacyLoginDay.source.version;
  const legacyStore = { ...store, get(sql, ...params) {
    if (sql.includes('FROM backend_customer_generation_days')) return { receipt_ref: 'fixture:legacy-day-receipt',
      payload_json: canonical(legacyLoginDay), payload_fingerprint: fingerprint(legacyLoginDay) };
    return store.get(sql, ...params);
  } };
  const legacyPolicy = createOrderFlowerDeliveryAccounting({ store: legacyStore }).readPolicyCount({
    context, kind: 'resident', officialDay, serverCount: count });
  assert.equal(legacyPolicy.known, true, JSON.stringify(legacyPolicy));
  assert.equal(legacyPolicy.value, 2);
  assert.equal(legacyLoginDay.source.version, undefined, 'the old immutable payload remains unchanged');

  // The pre-cellProofs login-frame compatibility path must still reject a
  // known counter identity/type conflict instead of trusting its aggregate.
  const oldFrameCount = { ...count, source: loginFrame.source, raw: baseCounter.tdyCnt.value,
    total: baseCounter.totCnt.value, rawRTime: baseCounter.rTime.value, value: 0 };
  delete oldFrameCount.cellProofs;
  const conflictingFrame = structuredClone(loginFrame);
  conflictingFrame.payload.counters[105].uid.value = 72;
  conflictingFrame.payloadFingerprint = fingerprint(conflictingFrame.payload);
  const conflictRows = observationRows.map(row => row.response_ref === loginRef ? { ...row,
    payload_json: canonical(conflictingFrame), payload_fingerprint: fingerprint(conflictingFrame) } : row);
  const conflictStore = { ...legacyStore, get(sql, ...params) {
    if (sql.includes('FROM backend_order_flower_observations')) return conflictRows.find(row => row.response_ref === params.at(-1)) ?? null;
    return legacyStore.get(sql, ...params);
  } };
  assert.throws(() => createOrderFlowerDeliveryAccounting({ store: conflictStore }).readPolicyCount({
    context, kind: 'resident', officialDay, serverCount: oldFrameCount }), error => error.code === 'ORDER_DELIVERY_SERVER_COUNTER_IDENTITY_CONFLICT');
});
