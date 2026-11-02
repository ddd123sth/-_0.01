import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonical } from '../runtime/backend/common.mjs';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createLandGroups } from '../runtime/backend/features/land/groups.mjs';

test('closed unknown member retires only the old current group binding; siblings get a new harvest round', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'land-current-binding-'));
  const store = openBackendStore({ dataDir: root });
  const context = { ownerRef: 'owner-1', accountRef: 'account-1', subjectRef: 'subject-1', ownerEpoch: 2, runEpoch: 1, connectionEpoch: 2 };
  const lands = {}, lives = {};
  for (const landId of [1, 2, 3]) {
    const source = { kind: 'response', responseRef: `new-land-${landId}`, connectionEpoch: 2, requestSequence: 6,
      method: 'index.login', observationRef: `obs-${landId}` };
    lands[String(landId)] = { landId, current: true, status: 'occupied', semanticVersion: 2, source,
      fields: { flowerId: { presence: 'present', state: 'known', value: 12 },
        plantTime: { presence: 'present', state: 'known', value: 100 },
        harvestCnt: { presence: 'present', state: 'known', value: 0 },
        state: { presence: 'present', state: 'known', value: 3 },
        nextTime: { presence: 'null', state: 'known', value: null } } };
    lives[String(landId)] = { landId, context, cropRef: `crop-${landId}`, flowerId: 12, plantTime: 100,
      harvestStageRef: `harvest-${landId}`, needWaterStageRef: `water-${landId}`, emptyRef: `empty-${landId}` };
  }
  const group = { groupRef: 'original-three-member-group', flowerId: 12, capacity: 3, configRevision: 1, state: 'active',
    adoption: true, layoutBasis: 'stable-land-id-order', members: [1, 2, 3].map(landId => ({ memberKey: `member-${landId}`,
      landId, cropRef: `crop-${landId}`, operationId: null, state: 'confirmed', ...(landId === 1 ?
        { currentUnknownOperationId: 'old-water-operation', currentUnknownFeature: 'water' } : {}) })),
    round: { roundRef: 'original-frozen-round', state: 'active', members: [1, 2, 3].map(landId => ({ memberKey: `member-${landId}`,
      landId, cropRef: `crop-${landId}`, stageRef: `old-stage-${landId}`,
      state: landId === 1 ? 'unknown' : 'confirmed', ...(landId === 1 ? { operationId: 'old-water-operation', featureId: 'water' } : {}) })) } };
  try {
    const proof = { available: true, receiptRef: 'isolation-proof-1', receiptHash: 'a'.repeat(64),
      currentCheckpoint: context, original: { ownerRef: context.ownerRef, subjectRef: context.subjectRef,
        featureId: 'water', connectionEpoch: 1, lifecycleTargetMetadata: { targets: [{ landId: 1,
          status: 'occupied', flowerId: 12, plantTime: 100, harvestCnt: 0, state: 1, cropRef: 'crop-1' }] } },
      previousExecution: { kind: 'matched-operation-response', operationRequestEnded: true, requestTerminated: true,
        connectionEpoch: 2, requestSequence: 5 } };
    const groups = createLandGroups({ store, projection: { view: () => ({ current: true,
      identity: { verified: true }, lands }) }, lifecycles: { get: ({ landId }) => lives[String(landId)],
      stageFor: ({ land }) => ({ known: true, lifecycleRef: `harvest-${land.landId}` }),
      ripeness: ({ land }) => ({ known: true, mature: land.fields.state.value === 3, dueMs: null }) },
      appendOutbox: () => {}, ledgerView: { operation: id => id === 'old-water-operation' ? { operation_id: id,
        feature_id: 'water', business_verdict: 'unknown', transport_state: 'unknown' } : null },
      isolationEvidence: { read: ({ operationId }) => operationId === 'old-water-operation' ? proof : null },
      clock: () => ({ available: false }) });
    store.run('INSERT INTO backend_land_group_heads VALUES(?,?,?,?,?,?)', context.ownerRef, context.subjectRef,
      group.groupRef, canonical(group), 1, store.nowIso());

    const current = groups.reconcile({ context, configReceipt: { savedRevision: 2, config: { groupSize: 3 } } });
    const original = current.groups.find(item => item.groupRef === group.groupRef);
    assert.equal(original.currentBinding.state, 'historical');
    assert.deepEqual(original.round, group.round, 'the original unknown outcome and frozen denominator stay unchanged');
    assert.equal(original.members.find(item => item.landId === 1).state, 'confirmed');
    const active = current.groups.filter(item => item.currentBinding?.state !== 'historical');
    assert.equal(active.length, 1);
    assert.deepEqual(active[0].members.map(item => item.landId), [1, 2, 3]);
    assert.ok(active[0].members.every(item => item.state === 'confirmed'));
    const round = groups.freezeHarvestRound({ context, groupRef: active[0].groupRef, clock: { available: false } });
    assert.equal(round.ready, true, 'current mature sibling crops can form a separate live round');
    assert.equal(round.group.round.members.length, 3);
    assert.equal(store.get('SELECT COUNT(*) AS count FROM backend_land_group_receipts WHERE group_ref=? AND kind=?',
      group.groupRef, 'current-group-binding-historical').count, 1);
    store.run('INSERT INTO backend_land_group_heads VALUES(?,?,?,?,?,?)', context.ownerRef, context.subjectRef,
      'retired-occupancy-only', canonical({ groupRef: 'retired-occupancy-only', flowerId: 99, state: 'active',
        currentBinding: { state: 'historical', receiptRef: 'retired-proof' }, members: [{ memberKey: 'retired-member', landId: 9, state: 'confirmed' }] }),
      1, store.nowIso());
    assert.equal(groups.view(context).flowerOccupancy(99), 0, 'a historical group binding cannot reserve flower occupancy');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
