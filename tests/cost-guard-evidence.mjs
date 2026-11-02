import test from 'node:test';
import assert from 'node:assert/strict';
import { provenLandUnexpectedCosts } from '../runtime/backend/features/land/runtime.mjs';
import { hasProvenUnexpectedArtDebit } from '../runtime/backend/features/art/production-units.mjs';
import { hasProvenCustomerUnexpectedDebit } from '../runtime/backend/features/customer/verification.mjs';
import { deriveCustomerVerification } from '../runtime/backend/features/customer/verification.mjs';
import { fingerprint } from '../runtime/backend/common.mjs';
import { customerOrderFingerprint } from '../runtime/backend/features/customer/identity.mjs';

test('land missing/unreadable post-write flow does not become a permanent cost guard', () => {
  const incomplete = { source: { kind: 'response' }, bo: { state: 'unknown', items: { '7': { state: 'unknown' } } } };
  assert.deepEqual(provenLandUnexpectedCosts(incomplete, 'water'), []);
  assert.deepEqual(provenLandUnexpectedCosts({ source: { kind: 'response' }, bo: { state: 'missing' } }, 'plant'), []);
});

test('land known unexpected debit remains a proven cost guard, while expected water is ignored', () => {
  const water = { source: { kind: 'response' }, bo: { items: {
    '7': { state: 'known', value: 1 }, '9': { state: 'known', value: 2 }, '10': { state: 'unknown' },
  } } };
  assert.deepEqual(provenLandUnexpectedCosts(water, 'water'), [
    { itemId: 9, quantity: 2, evidence: 'known-positive-official-bo' },
  ]);
});

test('art incomplete quantity evidence is not a durable guard, but observed excess debit is', () => {
  assert.equal(hasProvenUnexpectedArtDebit({ reasonCode: 'ART_MAKE_FLOW_QUANTITIES_UNPROVEN' }), false);
  assert.equal(hasProvenUnexpectedArtDebit({ reasonCode: 'ART_MAKE_UNEXPECTED_COST', evidence: { unexpectedDebits: [] } }), false);
  // An absolute profile balance can move because of unrelated play between
  // the matched write and the independent reconnect read. It is not a debit
  // attributed to the art operation and must not guard the recipe forever.
  assert.equal(hasProvenUnexpectedArtDebit({ reasonCode: 'ART_MAKE_UNEXPECTED_PROFILE_CURRENCY_EFFECT', evidence: {
    unexpectedDebits: [{ source: 'profile.gold', quantity: 5, expectedQuantity: 0,
      observedBefore: 100, observedAfter: 95, evidence: 'independent-current-profile-post-read' }],
  } }), false);
  assert.equal(hasProvenUnexpectedArtDebit({ reasonCode: 'ART_MAKE_UNEXPECTED_COST', evidence: { unexpectedDebits: [
    { source: 'bo', itemId: 31, quantity: 1, expectedQuantity: 1, observedQuantity: 2,
      evidence: 'independent-current-profile-post-read' },
  ] } }), false);
  assert.equal(hasProvenUnexpectedArtDebit({ reasonCode: 'ART_MAKE_UNEXPECTED_COST', evidence: { unexpectedDebits: [
    { source: 'bo', itemId: 31, quantity: 1, expectedQuantity: 1, observedQuantity: 2,
      evidence: 'complete-known-official-operation-flow' },
  ] } }), true);
  assert.equal(hasProvenUnexpectedArtDebit({ reasonCode: 'ART_MAKE_FLOW_QUANTITIES_UNPROVEN', evidence: {
    answer: { kind: 'response', method: 'flowerArt.makeFlowerArt', responseRef: 'write-a', wireKey: 'wire-a', requestSequence: 5 },
    expectedConsumptions: [{ itemId: 31, quantity: 1 }],
    flows: { bo: { readable: true, entries: [{ itemId: 31, quantity: 2 }] } },
  } }), true);
  // Declared recipe consumption applies only to `bo`; an extra matching item
  // in actBo/proxyBo is still a separately reported positive debit.
  for (const source of ['actBo', 'proxyBo']) {
    assert.equal(hasProvenUnexpectedArtDebit({ reasonCode: 'ART_MAKE_FLOW_QUANTITIES_UNPROVEN', evidence: {
      answer: { kind: 'response', method: 'flowerArt.makeFlowerArt', responseRef: 'write-' + source,
        wireKey: 'wire-' + source, requestSequence: 6 },
      expectedConsumptions: [{ itemId: 31, quantity: 3 }],
      flows: { bo: { readable: true, entries: [{ itemId: 31, quantity: 3 }] },
        [source]: { readable: true, entries: [{ itemId: 31, quantity: 1 }] } },
    } }), true);
  }
  assert.equal(hasProvenUnexpectedArtDebit({ reasonCode: 'ART_MAKE_UNEXPECTED_COST', evidence: {
    answer: { kind: 'response', method: 'flowerArt.makeFlowerArt', responseRef: 'write-a', wireKey: 'wire-a', requestSequence: 5 },
    expectedConsumptions: [{ itemId: 31, quantity: 1 }],
    flows: { bo: { readable: true, entries: [{ itemId: 31, quantity: 1 }] } },
    unattributedCurrencyChange: { before: { gold: 10, yb: 2 }, after: { gold: 9, yb: 2 } },
  } }), false);
});

test('customer finish cost guard requires exact positive-flow evidence and does not apply to other actions', () => {
  assert.equal(hasProvenCustomerUnexpectedDebit({ unexpectedDebits: [] }), false);
  assert.equal(hasProvenCustomerUnexpectedDebit({ unexpectedDebits: [{ source: 'bo', itemId: 31, quantity: 1,
    expectedQuantity: 1, evidence: 'complete-known-official-operation-flow' }] }), true);
  assert.equal(hasProvenCustomerUnexpectedDebit({ unexpectedDebits: [{ source: 'bo', itemId: 31, quantity: null,
    expectedQuantity: 1, evidence: 'complete-known-official-operation-flow' }] }), false);
});

test('customer cost guard consumes an actual derived verifier result with extra official flow', () => {
  const uid = 731, npcId = 9, artId = 101, rewardQuantity = 1;
  const oldContext = { ownerRef: 'owner-c', accountRef: 'account-c', subjectRef: 'subject-c', ownerEpoch: 3, runEpoch: 4, connectionEpoch: 5 };
  const newContext = { ...oldContext, connectionEpoch: 6 };
  const source = { kind: 'response', method: 'orderCustomer.genOrder', connectionEpoch: 5, requestSequence: 3,
    wireKey: 'ws|5|3', responseRef: 'stock:3' };
  const fields = { dialogId: { presence: 'present', state: 'known', value: 1 }, artId: { presence: 'present', state: 'known', value: artId },
    num: { presence: 'present', state: 'known', value: 1 }, pathId: { presence: 'present', state: 'known', value: 0 },
    cTime: { presence: 'present', state: 'known', value: 1792900000000 } };
  const order = { npcId, fields }, contentFingerprint = customerOrderFingerprint(order), lifecycleRef = 'customer-life:' + 'a'.repeat(64);
  const loginRef = 'login:c:6', answer = { source: 'response', transport: 'answered', method: 'orderCustomer.finishOrder',
    connectionEpoch: 5, requestSequence: 7, wireKey: 'ws|5|7', responseRef: 'finish:7', envelopeOk: true, dsName: 'G.ISyncData',
    rejected: false, versionEvidence: { gameVersion: '480.0.27', protocolVersion: '480.0.0', loginResponseRef: 'login:c:5' },
    value: { '7': { '0': { '0': uid }, '2': { '1': { [artId]: 2 }, '0': { 1002: rewardQuantity } } } } };
  const proposal = { featureId: 'order.customer', scope: 'order-customer', method: 'orderCustomer.finishOrder',
    ownerRef: oldContext.ownerRef, accountRef: oldContext.accountRef, subjectRef: oldContext.subjectRef,
    ownerEpoch: oldContext.ownerEpoch, runEpoch: oldContext.runEpoch, connectionEpoch: oldContext.connectionEpoch,
    operationId: 'customer-op-extra-flow', operationDescriptor: { postRead: { kind: 'after-close-login', method: 'index.login' } },
    params: { npcId, guestNpcIdList: [] }, paramsFingerprint: fingerprint({ npcId, guestNpcIdList: [] }),
    semanticKey: 'customer-finish:' + lifecycleRef, targets: [{ memberKey: 'customer:' + lifecycleRef,
      targetKind: 'customer-order', targetRef: 'customer-order:' + oldContext.subjectRef + ':' + npcId,
      lifecycleRef, targetFingerprint: contentFingerprint }],
    resources: [{ resourceKind: 'item', resourceRef: 'item:' + artId, resourceKey: 'item:art:' + artId, quantity: 1,
      basisRef: 'stock:3', accountingRef: 'accounting:stock:3' }],
    resourceBindings: [{ resourceKey: 'item:art:' + artId, memberKey: 'customer:' + lifecycleRef, quantity: 1 }],
    customer: { npcId, lifecycleRef, artId, need: 1, contentFingerprint, officialUid: uid, rewardQuantity,
      acceptedDecisionRef: 'customer-decision:' + 'b'.repeat(64), allocationRef: 'customer-allocation:' + 'c'.repeat(64),
      beforeOrder: { npcId, dialogId: 1, artId, num: 1, pathId: 0, cTime: fields.cTime.value },
      beforeStock: { itemId: artId, quantity: 2, basisRef: 'stock:3', source },
      versionEvidence: { gameVersion: '480.0.27', protocolVersion: '480.0.0', loginResponseRef: 'login:c:5' } } };
  const observation = { source: 'response', transport: 'answered', method: 'index.login', connectionEpoch: 6, requestSequence: 1,
    wireKey: 'ws|6|1', responseRef: loginRef, envelopeOk: true, dsName: 'G.ISyncData', rejected: false,
    versionEvidence: { gameVersion: '480.0.27', protocolVersion: '480.0.0', loginResponseRef: loginRef },
    value: { '7': { '0': { '0': uid, '32': { [artId]: 1, 1002: 1 } } }, '109': { '0': { '0': uid, '1': {} } } } };
  const bridge = { leaseRef: 'lease:c', operationId: proposal.operationId, bridgeFingerprint: 'd'.repeat(64),
    originalContext: oldContext, newContext, after: { connectionEpoch: 5, requestSequence: 7, wireKey: answer.wireKey, responseRef: answer.responseRef },
    oldPhysicalCloseReceipt: { closed: true, connectionEpoch: 5, closureEvidenceRef: 'closed:c:5' }, officialUid: uid,
    oldLoginSource: { method: 'index.login', connectionEpoch: 5, officialUid: uid, responseRef: 'login:c:5',
      versionEvidence: { gameVersion: '480.0.27', protocolVersion: '480.0.0' } }, newLoginObservation: observation };
  const verification = deriveCustomerVerification({ proposal, response: answer, observation, bridge });
  assert.equal(verification.reasonCode, 'CUSTOMER_FINISH_UNEXPECTED_COST');
  assert.equal(hasProvenCustomerUnexpectedDebit(verification.evidence), true);
});
