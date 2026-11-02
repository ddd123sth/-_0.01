import assert from 'node:assert/strict';
import test from 'node:test';
import { canonical } from '../runtime/backend/common.mjs';
import { orderFlowerCurrentNeedAdmissionEvidence } from '../runtime/backend/features/order-flower/runtime.mjs';

test('same-lifecycle current-need audit records missing legacy preparation as unknown metadata, not a later occurrence', () => {
  const isolation = { available: true, previousExecution: { closed: true, connectionEpoch: 4 } };
  const evidence = orderFlowerCurrentNeedAdmissionEvidence({ currentNeedGeneration: true, isolation,
    currentOrderSource: { kind: 'response', responseRef: 'current:login', requestSequence: 1 },
    oldLifecycleRef: null, oldTime: null, currentTime: 1_800_000_000_000, prepared: null });
  assert.equal(evidence.version, 'order-flower/current-need-after-exact-closed-execution/v1');
  assert.equal(evidence.oldLifecycleRef, null);
  assert.equal(evidence.oldTime, null);
  assert.equal(evidence.originalPreparationFingerprint, null);
  assert.equal(evidence.originalContractFingerprint, null);
  assert.doesNotThrow(() => canonical(evidence));
  assert.equal(evidence.version.includes('later-generation'), false);
});

test('true later server occurrence keeps its separate auditable basis contract', () => {
  const evidence = orderFlowerCurrentNeedAdmissionEvidence({ currentNeedGeneration: false, isolation: { available: true },
    currentOrderSource: { responseRef: 'new:row' }, oldLifecycleRef: 'old-life', oldTime: 10, currentTime: 20,
    prepared: { preparationFingerprint: 'a'.repeat(64), contractFingerprint: 'b'.repeat(64) } });
  assert.equal(evidence.version, 'order-flower/later-generation-after-exact-closed-execution/v1');
  assert.equal(evidence.originalPreparationFingerprint, 'a'.repeat(64));
  assert.equal(evidence.oldTime, 10);
});
