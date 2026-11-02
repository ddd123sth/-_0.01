import assert from 'node:assert/strict';
import test from 'node:test';
import { proveCurrentActionNeed } from '../runtime/backend/features/land/groups.mjs';

const context = { ownerRef: 'owner', subjectRef: 'subject', connectionEpoch: 2 };
function fixture(action, state, maturity = {}) {
  const source = { kind: 'response', responseRef: 'current-land-read', connectionEpoch: 2, requestSequence: 6 };
  const land = { landId: 4, current: true, status: action === 'plant' ? 'empty' : 'occupied', source,
    fields: { state: { presence: 'present', state: 'known', value: state }, flowerId: { presence: 'present', state: 'known', value: 12 },
      plantTime: { presence: 'present', state: 'known', value: 100 }, nextTime: maturity.nextTime ?? { presence: 'null', state: 'known', value: null } } };
  const life = { landId: 4, context: { subjectRef: 'subject' }, cropRef: 'crop-4', emptyRef: 'empty-4',
    needWaterStageRef: 'water-4', harvestStageRef: 'harvest-4' };
  const proof = { available: true, currentCheckpoint: { ownerRef: 'owner', subjectRef: 'subject', connectionEpoch: 2 },
    original: { ownerRef: 'owner', subjectRef: 'subject', featureId: action, connectionEpoch: 1,
      lifecycleTargetMetadata: { targets: [{ landId: 4, status: action === 'plant' ? 'empty' : 'occupied',
        flowerId: 12, plantTime: 100, cropRef: 'crop-4', state }] } },
    previousExecution: { kind: 'matched-operation-response', operationRequestEnded: true, requestTerminated: true,
      connectionEpoch: 2, requestSequence: 5 } };
  return { land, life, proof, source };
}

test('same-stage water unknown admits only a closed old request and a newer current need-water fact', () => {
  const f = fixture('water', 1);
  assert.equal(proveCurrentActionNeed({ ...f, context, action: 'water' }).allowed, true);
  assert.equal(proveCurrentActionNeed({ ...f, context, action: 'harvest' }).allowed, false);
  f.land.fields.state.value = 2;
  assert.equal(proveCurrentActionNeed({ ...f, context, action: 'water' }).allowed, false);
});

test('same empty stage remains a plant need without rewriting the old plant outcome', () => {
  const f = fixture('plant', 0);
  assert.equal(proveCurrentActionNeed({ ...f, context, action: 'plant' }).allowed, true);
  f.proof.previousExecution.requestTerminated = false;
  assert.equal(proveCurrentActionNeed({ ...f, context, action: 'plant' }).allowed, false);
});

test('same crop may be harvested again only when current official state proves maturity', () => {
  const f = fixture('harvest', 3);
  assert.equal(proveCurrentActionNeed({ ...f, context, action: 'harvest' }).allowed, true);
  f.land.fields.state.value = 2;
  f.land.fields.nextTime = { presence: 'present', state: 'known', value: 500 };
  assert.equal(proveCurrentActionNeed({ ...f, context, action: 'harvest', clock: { available: true, connectionEpoch: 2,
    nowMs: 400, uncertaintyMs: 1 } }).allowed, false);
  assert.equal(proveCurrentActionNeed({ ...f, context, action: 'harvest', clock: { available: true, connectionEpoch: 2,
    nowMs: 600, uncertaintyMs: 1 } }).allowed, true);
});
