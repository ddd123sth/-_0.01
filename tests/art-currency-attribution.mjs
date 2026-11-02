import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fingerprint } from '../runtime/backend/common.mjs';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createOfficialLandCatalog } from '../runtime/backend/features/land/catalog.mjs';
import { createOfficialCustomerCatalog } from '../runtime/backend/features/customer/catalog.mjs';
import { createOfficialArtCatalog } from '../runtime/backend/features/art/catalog.mjs';
import { ART_MAKE_CONTRACT, artRecipeFingerprint, artTargetFingerprint, assertArtMakeProposal } from '../runtime/backend/features/art/rpc-contract.mjs';
import { deriveArtVerification } from '../runtime/backend/features/art/verification.mjs';
import { hasProvenUnexpectedArtDebit } from '../runtime/backend/features/art/production-units.mjs';
import { createArtProductionUnits } from '../runtime/backend/features/art/production-units.mjs';

const source = (method, responseRef, requestSequence, connectionEpoch = 1) => ({ kind: 'response', method,
  responseRef, wireKey: 'wire:' + responseRef, requestSequence, connectionEpoch });
const digest = value => fingerprint(value);

function fixture({ goldAfter = 100, extraBoQuantity = 0, extraActBoQuantity = 0 } = {}) {
  const land = createOfficialLandCatalog(), customer = createOfficialCustomerCatalog({ landCatalog: land });
  const recipe = createOfficialArtCatalog({ customerCatalog: customer, landCatalog: land }).recipe(300101);
  assert.equal(recipe.known, true);
  const { artId, vaseId, flowersIds } = recipe;
  const expected = recipe.unitInputMultiset.map(one => ({ itemId: one.itemId, quantity: one.occurrences }));
  const subjectRef = 'subject-a', uid = 12345, oldContext = { ownerRef: 'owner-a', accountRef: 'account-a', subjectRef,
    ownerEpoch: 1, runEpoch: 1, connectionEpoch: 1 }, newContext = { ...oldContext, connectionEpoch: 2 };
  const loginRef = 'login-old', basis = source('usrLand.harvest', 'basis-old', 5), write = source(ART_MAKE_CONTRACT.method, 'write-ref', 6);
  const currentRead = source('index.login', 'login-new', 1, 2);
  const inputs = expected.map(one => ({ itemId: one.itemId, quantity: one.quantity + 4, basisRef: 'basis:' + one.itemId, source: basis }));
  const productBefore = { itemId: artId, quantity: 0, basisRef: 'basis:' + artId, source: basis };
  const items = [...inputs, productBefore];
  const art = { artId, vaseId, flowersIds, num: 1, officialUid: uid, parentLifecycleRef: 'customer-life:' + 'a'.repeat(64),
    demandRef: 'demand-a', unitRef: 'unit-a', recipeFingerprint: '', versionEvidence: { gameVersion: '480.0.27',
      protocolVersion: '480.0.0', loginResponseRef: loginRef },
    beforeItems: items, beforeProfile: { gold: 100, yb: 20, source: basis, goldSource: basis, ybSource: basis },
    beforeVase: { uid, vaseId, uTime: 1, cTime: 1, source: basis },
    costContract: { known: true, complete: true, kind: 'observed-versioned-recipe-cost', receiptRef: 'receipt-a',
      receiptFingerprint: 'b'.repeat(64), gameVersion: '480.0.27', protocolVersion: '480.0.0', recipeFingerprint: '',
      consumptions: expected, additionalCurrencyCostKnown: true, gold: 0, yb: 0, vaseConsumed: false } };
  art.recipeFingerprint = artRecipeFingerprint(art); art.costContract.recipeFingerprint = art.recipeFingerprint;
  const target = { memberKey: 'art:unit-a', targetKind: ART_MAKE_CONTRACT.targetKind, targetRef: `flower-art:${subjectRef}:${artId}`,
    lifecycleRef: 'unit-a' };
  target.targetFingerprint = artTargetFingerprint(art);
  const resources = expected.map(one => ({ resourceKind: 'item', resourceRef: 'item:' + one.itemId,
    resourceKey: 'item:' + one.itemId, quantity: one.quantity, basisRef: 'basis:' + one.itemId, accountingRef: 'acct:' + one.itemId }));
  const proposal = { ...ART_MAKE_CONTRACT, ownerRef: oldContext.ownerRef, accountRef: oldContext.accountRef, subjectRef,
    ownerEpoch: 1, runEpoch: 1, connectionEpoch: 1, operationId: 'operation-a', proposalId: 'proposal-a',
    operationDescriptor: { postRead: { kind: 'after-close-login', method: 'index.login' } },
    params: { vaseId, flowersIds, num: 1 }, paramsFingerprint: digest({ vaseId, flowersIds, num: 1 }),
    semanticKey: 'art-make:unit-a', targets: [target], resources,
    resourceBindings: resources.map(one => ({ resourceKey: one.resourceKey, memberKey: target.memberKey, quantity: one.quantity })), art };
  art.currentNeed = { necessary: true, featureId: 'art.make', targetRef: target.targetRef,
    businessNeedRef: 'business-need-a', decisionGeneration: 'c'.repeat(64), semanticFingerprint: 'd'.repeat(64),
    needRef: 'current-need:' + digest([ART_MAKE_CONTRACT.featureId, target.targetRef, 'business-need-a']),
    claimRef: 'claim-a', basisRefs: [loginRef, ...items.map(one => one.basisRef)] };
  const afterItems = Object.fromEntries(items.map(one => [String(one.itemId), one.quantity]));
  for (const one of expected) afterItems[String(one.itemId)] -= one.quantity;
  afterItems[String(artId)] = 1;
  const answer = { source: 'response', transport: 'answered', method: ART_MAKE_CONTRACT.method, connectionEpoch: 1,
    requestSequence: 6, wireKey: 'wire:write-ref', responseRef: 'write-ref', envelopeOk: true, dsName: 'G.ISyncData',
    rejected: false, versionEvidence: { gameVersion: '480.0.27', protocolVersion: '480.0.0', loginResponseRef: loginRef },
    value: { '7': { '0': { '0': uid, '44': 100, '41': 20 }, '2': { '0': { [String(artId)]: 1 },
      '1': Object.fromEntries(expected.map((one, index) => [String(one.itemId), one.quantity + (index === 0 ? extraBoQuantity : 0)])),
      ...(extraActBoQuantity ? { '4': { [String(expected[0].itemId)]: extraActBoQuantity } } : {}) } } } };
  const currentValue = { '7': { '0': { '0': uid, '32': afterItems, '44': goldAfter, '41': 20 } },
    '102': { '0': { [String(vaseId)]: { '0': uid, '1': vaseId } } }, '106': { '0': { '0': uid, '2': [] } } };
  const observation = { ...currentRead, source: 'response', transport: 'answered', envelopeOk: true, dsName: 'G.ISyncData',
    rejected: false, protocolVersion: '480.0.0', versionEvidence: { gameVersion: '480.0.27', protocolVersion: '480.0.0', loginResponseRef: 'login-new' },
    value: currentValue };
  const bridge = { leaseRef: 'lease-a', operationId: proposal.operationId, bridgeFingerprint: 'e'.repeat(64), originalContext: oldContext,
    newContext, after: { connectionEpoch: 1, requestSequence: 6, wireKey: 'wire:write-ref', responseRef: 'write-ref' },
    oldPhysicalCloseReceipt: { closed: true, connectionEpoch: 1, closureEvidenceRef: 'close-a' },
    oldLoginSource: { method: 'index.login', connectionEpoch: 1, responseRef: loginRef, officialUid: uid,
      versionEvidence: { gameVersion: '480.0.27', protocolVersion: '480.0.0' } },
    officialUid: uid, newLoginObservation: observation };
  return { proposal, answer, observation, bridge };
}

test('unrelated current currency movement remains unknown and cannot create a recipe-wide debit guard', () => {
  const { proposal, answer, observation, bridge } = fixture({ goldAfter: 95 });
  const verification = deriveArtVerification({ proposal, response: answer, observation, bridge });
  assert.equal(verification.verdict, 'unknown');
  assert.equal(verification.reasonCode, 'ART_MAKE_CURRENCY_RECONCILIATION_UNPROVEN');
  assert.deepEqual(verification.evidence.unexpectedDebits, []);
  assert.deepEqual(verification.evidence.unattributedCurrencyChange, {
    before: { gold: 100, yb: 20 }, after: { gold: 95, yb: 20 },
    positiveCurrencyFlowReported: false, evidence: 'independent-current-profile-not-operation-attributed',
  });
  assert.equal(hasProvenUnexpectedArtDebit(verification), false);
});

test('current art proposal cannot reuse one profile source for both currencies', () => {
  const { proposal } = fixture();
  const missingYuanbaoSource = structuredClone(proposal);
  delete missingYuanbaoSource.art.beforeProfile.ybSource;
  assert.throws(() => assertArtMakeProposal(missingYuanbaoSource), { code: 'ART_MAKE_CURRENCY_SOURCES_REQUIRED' });
});

test('legacy verifier evidence without expectedConsumptions is classified from its exact saved proposal', () => {
  const { proposal, answer, observation, bridge } = fixture({ extraBoQuantity: 1 });
  const verification = deriveArtVerification({ proposal, response: answer, observation, bridge });
  assert.equal(verification.reasonCode, 'ART_MAKE_UNEXPECTED_COST');
  // Older evidence did not persist expectedConsumptions. Production ledger
  // originals are generic; the exact art vector comes from the separately
  // fingerprinted finite-domain preparation, while reserved resources remain
  // cross-checked against the immutable original.
  const oldEvidence = { ...verification.evidence };
  delete oldEvidence.expectedConsumptions;
  delete oldEvidence.unexpectedDebits;
  const oldOperation = { feature_id: 'art.make', method: ART_MAKE_CONTRACT.method, factBasis: { recipeFingerprint: proposal.art.recipeFingerprint },
    original: { featureId: 'art.make', method: ART_MAKE_CONTRACT.method, ownerRef: proposal.ownerRef, subjectRef: proposal.subjectRef, connectionEpoch: proposal.connectionEpoch,
      resources: proposal.resources.map(resource => ({ resourceKind: 'item', resourceRef: resource.resourceRef, quantity: resource.quantity })) } };
  assert.equal(hasProvenUnexpectedArtDebit({ reasonCode: verification.reasonCode, evidence: oldEvidence }, oldOperation, proposal.art), true);
  const mismatchedOperation = { ...oldOperation, original: { ...oldOperation.original,
    resources: oldOperation.original.resources.map((resource, index) => index === 0 ? { ...resource, quantity: resource.quantity + 1 } : resource) } };
  assert.equal(hasProvenUnexpectedArtDebit({ reasonCode: verification.reasonCode, evidence: oldEvidence }, mismatchedOperation, proposal.art), false);
});

test('real art verifier excess-flow output is persisted as a recipe-scoped guard', () => {
  const { proposal, answer, observation, bridge } = fixture({ extraBoQuantity: 1 });
  const verification = deriveArtVerification({ proposal, response: answer, observation, bridge });
  assert.equal(verification.reasonCode, 'ART_MAKE_UNEXPECTED_COST');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-art-cost-guard-'));
  const store = openBackendStore({ dataDir: root });
  try {
    const operation = { operation_id: proposal.operationId, owner_ref: proposal.ownerRef, subject_ref: proposal.subjectRef,
      method: proposal.method, business_verdict: 'unknown', write_slot: 0 };
    const units = createArtProductionUnits({ store, resources: { planCoverage() { return { applicable: false, links: [] }; } },
      ledgerView: { operation() { return operation; } }, isCurrent() { return true; } });
    assert.equal(units.recordUnexpectedCostGuard({ ownerRef: proposal.ownerRef, subjectRef: proposal.subjectRef,
      recipeFingerprint: proposal.art.recipeFingerprint, operationId: proposal.operationId, unitRef: proposal.art.unitRef,
      costReceiptRef: null, verification, operation }), true);
    const { proposal: actProposal, answer: actAnswer, observation: actObservation, bridge: actBridge } = fixture({ extraActBoQuantity: 1 });
    const actVerification = deriveArtVerification({ proposal: actProposal, response: actAnswer, observation: actObservation, bridge: actBridge });
    assert.equal(actVerification.reasonCode, 'ART_MAKE_UNEXPECTED_COST');
    assert.equal(actVerification.evidence.unexpectedDebits[0].source, 'actBo');
    const actOperation = { operation_id: actProposal.operationId, owner_ref: actProposal.ownerRef, subject_ref: actProposal.subjectRef,
      method: actProposal.method, business_verdict: 'unknown', write_slot: 0 };
    assert.equal(units.recordUnexpectedCostGuard({ ownerRef: actProposal.ownerRef, subjectRef: actProposal.subjectRef,
      recipeFingerprint: actProposal.art.recipeFingerprint, operationId: actProposal.operationId, unitRef: actProposal.art.unitRef,
      verification: actVerification, operation: actOperation }), true);
    const rows = store.all('SELECT recipe_fingerprint,operation_id,reason_code,evidence_json,evidence_fingerprint FROM backend_art_recipe_cost_guard_events');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].recipe_fingerprint, proposal.art.recipeFingerprint);
    assert.equal(rows[0].operation_id, proposal.operationId);
    assert.equal(rows[0].reason_code, 'ART_MAKE_UNEXPECTED_COST');
    const guardEvidence = rows.map(row => JSON.parse(row.evidence_json).observedEvidence.unexpectedDebits[0]);
    assert.ok(guardEvidence.some(one => one.source === 'bo' && one.quantity === 1));
    assert.ok(guardEvidence.some(one => one.source === 'actBo' && one.quantity === 1));
    assert.equal(units.recordUnexpectedCostGuard({ ownerRef: proposal.ownerRef, subjectRef: proposal.subjectRef,
      recipeFingerprint: proposal.art.recipeFingerprint, operationId: proposal.operationId, unitRef: proposal.art.unitRef,
      verification: { ...verification, reasonCode: 'ART_MAKE_CURRENCY_RECONCILIATION_UNPROVEN' }, operation }), false);
    assert.equal(store.all('SELECT * FROM backend_art_recipe_cost_guard_events').length, 2,
      'unattributed balance deltas and other unknown reasons cannot broaden the guard');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
