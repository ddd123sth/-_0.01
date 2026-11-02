// Synthetic protocol unit fixture. This exercises the production decoder,
// projection, typed coverage extractor and coordinator; it is not live-server evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createLandProjection } from '../runtime/backend/features/land/projection.mjs';
import { decodeOfficialLandObservation } from '../runtime/backend/features/land/wire-facts.mjs';
import { createCustomerReadModel } from '../runtime/backend/features/customer/projection.mjs';
import { createOrderFlowerReadModel } from '../runtime/backend/features/order-flower/read-model.mjs';
import { createOrderFlowerAuxiliaryFacts } from '../runtime/backend/features/order-flower/auxiliary-facts.mjs';
import { buildTypedDynamicCoverage } from '../runtime/backend/facts/typed-coverage.mjs';
import { createDynamicStateCoordinator, dynamicTokenMatches, FEATURE_DOMAINS } from '../runtime/backend/facts/dynamic-state.mjs';
import { fingerprint } from '../runtime/backend/common.mjs';

const context = Object.freeze({ ownerRef: 'fixture:owner', accountRef: 'fixture:acct', subjectRef: 'fixture:subject',
  ownerEpoch: 1, runEpoch: 1, connectionEpoch: 1 });
let now = 1000, mono = 1000;
const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-typed-coverage-'));
const store = openBackendStore({ dataDir: storeDir });
const projection = createLandProjection({ store, catalog: { land: id => id === 1, identity: () => ({ catalogId: 'fixture-catalog' }) },
  isCurrent: value => JSON.stringify(value) === JSON.stringify(context) });
const coordinator = createDynamicStateCoordinator({ store,
  isCurrent: value => JSON.stringify(value) === JSON.stringify(context), deviceNow: () => now, monotonicNow: () => mono });
const feature = { featureId: 'plant', consumedDomains: ['land', 'cultivation', 'inventory'],
  consumedDomainsFor: ({ config }) => config?.plantMode === 'chosen_top' ? ['land', 'land-top', 'cultivation', 'inventory'] : ['land', 'cultivation', 'inventory'] };
const featureConfig = { plantMode: 'chosen_top' };

function observation({ seq, ref, receivedDeviceMs, changed = false, bag = false, bd = null, profilePatch = {} }) {
  const row = changed ? { '0': 3002, '1': 1 } : { '0': 3001, '1': 1 };
  const bagSection = bag === 'empty' ? { '32': {}, '33': {} } : bag ? { '32': { '100': bag === true ? 5 : bag }, '33': {} } : {};
  const value = { '7': { '0': { '0': 123, ...bagSection, ...profilePatch },
      ...(seq === 1 ? { '3': { flowerPlantTop: { '2': { '2': [1] } } } } : {}),
      ...(bd ? { '2': { '2': bd } } : {}) },
    '101': { '0': { '3001': { '0': 123, '1': 3001, '2': 1, '4': 2 } } },
    '100': { '0': { '0': 123, '1': { '1': row } }, ...(changed ? { '1': { '1': row } } : {}) } };
  return { source: 'response', transport: 'answered', envelopeOk: true, dsName: 'G.ISyncData', rejected: false,
    context, connectionEpoch: context.connectionEpoch, requestSequence: seq, responseRef: ref, wireKey: `ws|fixture|${seq}`,
    method: seq === 1 ? 'index.login' : 'usr.heartTick', receivedDeviceMs, receivedMonotonicMs: mono,
    ...(seq === 1 ? { currentIdentity: { verified: true, officialUid: 123, responseRef: ref } } : {}),
    versionEvidence: { source: 'normal-package-hop-and-matched-world-login/v1', gameVersion: '480.0.27', protocolVersion: '480.0.0',
      loginResponseRef: seq === 1 ? ref : 'fixture:login' }, value };
}
function project(obs, { bagComplete = false } = {}) {
  const frame = decodeOfficialLandObservation({ context, observation: obs, capabilities: { bagComplete, itemExtComplete: bagComplete } });
  assert.ok(frame, 'real land decoder accepts synthetic matched G.ISyncData frame');
  const accepted = projection.ingest(frame);
  assert.equal(accepted.accepted, true);
  const landView = projection.view(context);
  const coverage = buildTypedDynamicCoverage(context, obs, { land: accepted, landView });
  const result = coordinator.observe({ context, observation: obs, coverage });
  assert.equal(result.accepted, true, JSON.stringify(result));
  return { frame, accepted, landView, coverage, result };
}

test('synthetic protocol fixture flows decoder→projection→typed coverage→freshness and preserves per-cell arrival', () => {
  try {
    const login = observation({ seq: 1, ref: 'fixture:login', receivedDeviceMs: now, bag: true, profilePatch: { '35': 4, '37': 5 } });
    const first = project(login, { bagComplete: true });
    assert.equal(store.get(`SELECT official_uid,game_version,protocol_version FROM backend_dynamic_login_identity_anchors
      WHERE owner_ref=? AND subject_ref=? AND connection_epoch=? AND response_ref=?`, context.ownerRef, context.subjectRef,
    context.connectionEpoch, login.responseRef).official_uid, 123, 'accepted login identity is kept as a stable append-only anchor');
    const landCell = first.landView.lands['1'].fields.flowerId;
    assert.equal(landCell.state, 'known');
    assert.equal(landCell.source.responseRef, login.responseRef);
    const inventoryCoverage = first.coverage.find(item => item.domainId === 'inventory');
    assert.ok(inventoryCoverage);
    assert.deepEqual(inventoryCoverage.paths, ['inventory.bag.complete', 'inventory.bag.items.100', 'inventory.itemExt.complete']);
    assert.equal(coordinator.snapshot({ context, feature, config: featureConfig }).current, true);
    const token = coordinator.semanticToken({ context, feature, config: featureConfig });

    now = 30000; mono = 30000;
    const update = observation({ seq: 2, ref: 'fixture:land-change', receivedDeviceMs: now, changed: true, bag: false, profilePatch: { '35': 27 } });
    const second = project(update);
    assert.equal(second.landView.lands['1'].fields.flowerId.source.responseRef, update.responseRef);
    assert.equal(second.landView.profile.lvlExp.value, 27, '7.0.35 is a distinct verified profile cell, not inventory item 2');
    assert.equal(second.landView.profile.lvlExp.source.responseRef, update.responseRef);
    const currentProfileCoverage = second.coverage.find(item => item.domainId === 'profile');
    assert.equal(currentProfileCoverage.cellSources['profile.lvlExp'].sourceRef, update.responseRef,
      'the dynamic freshness token binds the per-field profile source for level experience');
    assert.equal(second.landView.inventory.bag.source.responseRef, login.responseRef);
    assert.equal(second.coverage.some(item => item.domainId === 'inventory'), false);
    assert.notEqual(coordinator.semanticToken({ context, feature, config: featureConfig }).domains.find(item => item.domainId === 'land').semanticFingerprint,
      token.domains.find(item => item.domainId === 'land').semanticFingerprint);
    assert.equal(dynamicTokenMatches(coordinator.semanticToken({ context, feature, config: featureConfig }), token), false,
      'gateway send-fence comparison rejects proposal after semantic facts change');

    now = 50000; mono = 50000;
    const inventoryUpdate = observation({ seq: 3, ref: 'fixture:inventory-change', receivedDeviceMs: now, bag: 3 });
    const third = project(inventoryUpdate, { bagComplete: true });
    assert.equal(third.landView.inventory.bag.items['100'].value, 3);
    assert.notEqual(coordinator.semanticToken({ context, feature, config: featureConfig }).domains.find(item => item.domainId === 'inventory').semanticFingerprint,
      token.domains.find(item => item.domainId === 'inventory').semanticFingerprint);

    now = 60000; mono = 60000;
    const emptyBagLogin = observation({ seq: 4, ref: 'fixture:inventory-empty', receivedDeviceMs: now, bag: 'empty' });
    const fourth = project(emptyBagLogin, { bagComplete: true });
    assert.equal(fourth.landView.inventory.bag.complete, true);
    assert.equal(store.get(`SELECT 1 FROM backend_dynamic_domain_cells WHERE owner_ref=? AND subject_ref=? AND domain_id='inventory'
      AND path='inventory.bag.items.100'`, context.ownerRef, context.subjectRef), null,
    'a complete absolute bag snapshot removes members absent from its typed collection');
    assert.equal(coordinator.snapshot({ context, feature, config: featureConfig }).current, true,
      'a legitimate empty bag remains complete through explicit membership coverage');

    now = 70000; mono = 70000;
    const sparse = observation({ seq: 5, ref: 'fixture:sparse-land-after-empty', receivedDeviceMs: now, changed: true });
    project(sparse);
    assert.equal(store.get(`SELECT 1 FROM backend_dynamic_domain_cells WHERE owner_ref=? AND subject_ref=? AND domain_id='inventory'
      AND path='inventory.bag.items.100'`, context.ownerRef, context.subjectRef), null,
    'a sparse non-bag response cannot recreate or delete absolute inventory membership');

    now = 80000; mono = 80000;
    const fullBag = observation({ seq: 6, ref: 'fixture:full-bag-before-bd', receivedDeviceMs: now, bag: 5 });
    project(fullBag, { bagComplete: true });
    const beforeBdToken = coordinator.semanticToken({ context, feature, config: featureConfig });

    now = 90000; mono = 90000;
    const bd = observation({ seq: 8, ref: 'fixture:sparse-bd-newer', receivedDeviceMs: now,
      profilePatch: { '44': 1, '41': 2, '35': 3, '37': 6 },
      bd: { '1': 17, '2': 23, '3': 29, '11': 31, '100': 9 } });
    const bdResult = project(bd);
    const afterBdToken = coordinator.semanticToken({ context, feature, config: featureConfig });
    assert.notEqual(dynamicTokenMatches(afterBdToken, beforeBdToken), true,
      'a sparse absolute bd item changes the send-fence token');
    assert.equal(bdResult.landView.inventory.bag.items['100'].value, 9);
    assert.equal(bdResult.landView.inventory.bag.items['100'].source.responseRef, bd.responseRef);
    assert.equal(bdResult.landView.profile.yuanbao.value, 17, 'G480 bd item 1 updates profile yuanbao');
    assert.equal(bdResult.landView.profile.lvlExp.value, 23, 'G480 bd item 2 updates profile level experience');
    assert.equal(bdResult.landView.profile.vipExp.value, 29, 'G480 bd item 3 updates profile VIP experience');
    assert.equal(bdResult.landView.profile.vipExp.source.responseRef, bd.responseRef);
    assert.equal(bdResult.landView.profile.gold.value, 31, 'G480 bd item 11 is applied after direct profile fields');
    assert.equal(bdResult.landView.profile.gold.source.responseRef, bd.responseRef);
    for (const id of ['1', '2', '3', '11']) assert.equal(bdResult.landView.inventory.bag.items[id], undefined,
      `mapped profile item ${id} is not fabricated as a bag item`);

    now = 95000; mono = 95000;
    const lateFullBag = observation({ seq: 7, ref: 'fixture:older-full-bag-arrives-late', receivedDeviceMs: now, bag: 'empty' });
    const lateResult = project(lateFullBag, { bagComplete: true });
    assert.equal(lateResult.landView.inventory.bag.items['100'].value, 9,
      'the projection retains the newer absolute bd cell when the earlier full bag arrives late');
    assert.equal(lateResult.landView.inventory.bag.items['100'].source.responseRef, bd.responseRef);
    assert.equal(lateResult.coverage.find(item => item.domainId === 'inventory').semanticValue['inventory.bag.items.100'], 9,
      'typed coverage follows the projection cell, not the older response payload');
    assert.equal(lateResult.result.unresolved.includes('inventory'), true,
      'the older full bag cannot publish over the newer domain head');
    assert.equal(dynamicTokenMatches(coordinator.semanticToken({ context, feature, config: featureConfig }), afterBdToken), true,
      'the late older observation cannot change the current send-fence token');
    const inventoryCell = store.get(`SELECT request_sequence,observed_monotonic_ms FROM backend_dynamic_domain_cells
      WHERE owner_ref=? AND subject_ref=? AND domain_id='inventory' AND path='inventory.bag.items.100'`, context.ownerRef, context.subjectRef);
    assert.deepEqual({ ...inventoryCell }, { request_sequence: 8, observed_monotonic_ms: 90000 },
      'the sparse cell keeps its own request sequence and monotonic arrival time');

    now = 200001; mono = 200001;
    const snapshot = coordinator.snapshot({ context, feature, config: featureConfig });
    assert.equal(snapshot.domains.find(item => item.domainId === 'inventory').current, false);
    assert.equal(snapshot.domains.find(item => item.domainId === 'inventory').reasonCode, 'DYNAMIC_DOMAIN_CELL_MAX_AGE_EXCEEDED');
  } finally { store.close(); fs.rmSync(storeDir, { recursive: true, force: true }); }
});

test('nested typed collections keep business semantics stable across response provenance', () => {
  const coverageFor = (responseRef, requestSequence) => {
    const source = { responseRef, connectionEpoch: context.connectionEpoch, receivedDeviceMs: 2000,
      receivedMonotonicMs: 2000, requestSequence, method: 'index.login' };
    const typed = (value) => ({ presence: 'present', state: 'known', current: true, value, source });
    const observation = { responseRef, requestSequence, method: 'index.login' };
    const customerView = { current: true,
      orderMap: { ...typed({ entries: [{ npcId: 7, orderId: 19, source: { responseRef, requestSequence }, current: true }],
        fields: { total: { value: 1, source: { responseRef } } } }), total: 1, complete: true, returnedComplete: true },
      orderStockList: { ...typed([]), total: 0, complete: true, returnedComplete: true } };
    return buildTypedDynamicCoverage(context, observation, { customer: { accepted: true }, customerView })
      .find(item => item.domainId === 'customer');
  };
  const first = coverageFor('fixture:customer-r1', 1);
  const second = coverageFor('fixture:customer-r2', 2);
  assert.ok(first && second);
  assert.equal(first.semanticFingerprint, second.semanticFingerprint);
  assert.deepEqual(first.semanticValue, second.semanticValue);
  assert.notDeepEqual(first.cellSources, second.cellSources,
    'provenance advances while the business value remains unchanged');
});

test('auxiliary producer does not promote unknown/missing source sections to complete freshness domains', () => {
  const auxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-aux-typed-'));
  const auxStore = openBackendStore({ dataDir: auxDir });
  try {
    const auxContext = Object.freeze({ ...context, connectionEpoch: 9 });
    const sourceNow = Date.now();
    const obs = { source: 'response', transport: 'answered', envelopeOk: true, dsName: 'G.ISyncData', rejected: false,
      context: auxContext, connectionEpoch: 9, requestSequence: 11, responseRef: 'fixture:aux-login-r11', wireKey: 'ws|9|11',
      method: 'index.login', receivedDeviceMs: sourceNow, receivedMonotonicMs: mono,
      versionEvidence: { source: 'normal-package-hop-and-matched-world-login/v1', gameVersion: '480.0.27',
        protocolVersion: '480.0.0', loginResponseRef: 'fixture:aux-login-r11' },
      value: { '7': { '0': { '0': 123, '32': {}, '34': 1, '35': 0, '41': 0, '44': 100 },
        '4': Object.fromEntries([105, 109, 116, 107].map(id => [String(id), { '0': 123, '1': id, '2': 0, '3': 0, '4': 1780000000000 }])) },
        '21': { '5': {} }, '31': { '0': Object.fromEntries([[5, 19, 34].map(id => [String(id),
          { '0': 123, '1': id, '2': 0, '3': 0, '5': 0, '6': 1780000000000 }])].flat()) },
        '105': { '0': { '0': 123, '1': {}, '2': [], '6': {}, '7': {}, '10': 1780000000000 } },
        '109': { '0': { '0': 123, '1': {}, '2': 0, '3': 1780000000000, '4': 1780000000000, '5': 0, '6': [], '7': true } },
        '22': { '2': { '0': 123, '1': {}, '3': {}, '4': 0 } }, '101': { '0': {} } } };
    const model = createOrderFlowerAuxiliaryFacts({ store: auxStore, isCurrent: value => JSON.stringify(value) === JSON.stringify(auxContext) });
    const flowerModel = createOrderFlowerReadModel({ store: auxStore, isCurrent: value => JSON.stringify(value) === JSON.stringify(auxContext) });
    const customerModel = createCustomerReadModel({ store: auxStore, isCurrent: value => JSON.stringify(value) === JSON.stringify(auxContext) });
    assert.equal(customerModel.ingest({ context: auxContext, observation: obs }).accepted, true);
    const customerView = customerModel.snapshot(auxContext);
    assert.equal(flowerModel.ingest({ context: auxContext, observation: obs }).accepted, true);
    assert.equal(model.ingest({ context: auxContext, observation: obs }).accepted, true);
    const auxiliary = model.read(auxContext);
    assert.equal(auxiliary.current, true);
    assert.equal(auxiliary.payload.rewardState.ownership.known, false,
      'absence from the initial sparse ownership map is unknown, not a complete negative');
    const officialClock = { available: true, source: 'official-anchor-monotonic', revision: 4, connectionEpoch: 9,
      nowMs: 1780000000000, lowerBoundMs: 1779999999990, upperBoundMs: 1780000000010,
      evidence: { responseRef: obs.responseRef, requestSequence: obs.requestSequence,
        receivedDeviceMs: obs.receivedDeviceMs, receivedMonotonicMs: obs.receivedMonotonicMs } };
    const coverage = buildTypedDynamicCoverage(auxContext, obs, { flowerAuxiliary: auxiliary, officialClock });
    assert.ok(coverage.some(item => item.domainId === 'clock'), 'clock freshness comes from the matched login clock anchor');
    for (const domainId of ['order-flower-video-resident', 'order-flower-video-satin', 'order-flower-video-decorate',
      'order-flower-reward-stage', 'order-flower-reward-achievement', 'order-flower-enter-state']) {
      const domain = coverage.find(item => item.domainId === domainId);
      assert.ok(domain, domainId + ' is produced from its actual validated typed source section');
      assert.ok(Object.values(domain.cellSources).every(source => source.sourceRef === obs.responseRef));
      assert.ok(Object.values(domain.cellSources).every(source => source.requestSequence === obs.requestSequence && source.connectionEpoch === obs.connectionEpoch));
    }
    assert.equal(coverage.some(item => ['order-flower-card-video', 'order-flower-card-noble'].includes(item.domainId)), false,
      'a sparse card map that omits an ID cannot be treated as a complete absent-card assertion');

    const orderMapOnly = { ...obs, method: 'usr.heartTick', requestSequence: 12, responseRef: 'fixture:customer-map-only-r12',
      wireKey: 'ws|9|12', receivedDeviceMs: sourceNow + 1000, receivedMonotonicMs: mono + 1000,
      versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef },
      value: { '109': { '0': { '1': {} } } } };
    const acceptedOrderMap = customerModel.ingest({ context: auxContext, observation: orderMapOnly });
    assert.equal(acceptedOrderMap.accepted, true, JSON.stringify(acceptedOrderMap));
    const mergedCustomer = customerModel.snapshot(auxContext);
    const customerDeltaCoverage = buildTypedDynamicCoverage(auxContext, orderMapOnly,
      { customer: acceptedOrderMap, customerView: mergedCustomer }).find(item => item.domainId === 'customer');
    assert.ok(customerDeltaCoverage, JSON.stringify({ acceptedOrderMap, customerCurrent: mergedCustomer.current, reasonCode: mergedCustomer.reasonCode,
      orderMap: mergedCustomer.orderMap, stock: mergedCustomer.orderStockList }, null, 2));
    assert.ok(customerDeltaCoverage.paths.some(path => path.startsWith('customer.orderMap')));
    assert.equal(customerDeltaCoverage.paths.some(path => path.startsWith('customer.orderStockList')), false,
      'the older complete stock list is not renewed by this orderMap-only frame');

    const artBaseline = { ...obs, method: 'usr.heartTick', requestSequence: 13, responseRef: 'fixture:art-input-baseline-r13',
      wireKey: 'ws|9|13', receivedDeviceMs: sourceNow + 1100, receivedMonotonicMs: mono + 1100,
      versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef },
      value: { '102': { '0': { '3002': { '0': 123, '1': 3002, '2': 1, '3': 1780000000000 } } },
        '106': { '0': { '0': 123, '2': [] } } } };
    const acceptedArtBaseline = customerModel.ingest({ context: auxContext, observation: artBaseline });
    assert.equal(acceptedArtBaseline.accepted, true);
    const artBaselineView = customerModel.snapshot(auxContext);
    const artBaselineCoverage = buildTypedDynamicCoverage(auxContext, artBaseline,
      { customer: acceptedArtBaseline, customerView: artBaselineView }).find(item => item.domainId === 'art-inputs');
    assert.ok(artBaselineCoverage, 'merged complete vase and flower-art model establishes the initial art-input coverage');
    const makeListOnly = { ...obs, method: 'usr.heartTick', requestSequence: 14, responseRef: 'fixture:art-makelist-only-r14',
      wireKey: 'ws|9|14', receivedDeviceMs: sourceNow + 1200, receivedMonotonicMs: mono + 1200,
      versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef }, value: { '106': { '0': { '2': [300202] } } } };
    const acceptedMakeList = customerModel.ingest({ context: auxContext, observation: makeListOnly });
    assert.equal(acceptedMakeList.accepted, true);
    const makeListCoverage = buildTypedDynamicCoverage(auxContext, makeListOnly,
      { customer: acceptedMakeList, customerView: customerModel.snapshot(auxContext) }).find(item => item.domainId === 'art-inputs');
    assert.ok(makeListCoverage, 'a makeList-only update remains publishable because the other required accepted model cells are still complete');
    assert.ok(makeListCoverage.paths.some(path => path.includes('makeList')));
    assert.equal(makeListCoverage.paths.some(path => path.includes('vases')), false,
      'vase cells retain their own source and age during a makeList-only response');
    const unknownReward = { known: true, inventory: { known: false }, stage: { known: true, value: {} },
      achievement: { known: true, value: {} }, ownership: { known: true, value: {} }, counters: [] };
    const malformed = buildTypedDynamicCoverage(auxContext, obs, { flowerAuxiliary: { ...auxiliary,
      payload: { ...auxiliary.payload, rewardState: unknownReward, enterState: { known: false } } } });
    assert.equal(malformed.some(item => ['order-flower-reward-stage', 'order-flower-reward-achievement', 'order-flower-enter-state'].includes(item.domainId)), false,
      'known wrapper with unknown child or explicitly unknown section cannot become current coverage');

    // A separately accepted normal response may update one auxiliary component
    // without carrying UID, the other shares, or any login-only full state.
    const increment = { ...obs, method: 'usr.heartTick', requestSequence: 12, responseRef: 'fixture:aux-heart-r12',
      wireKey: 'ws|9|12', receivedDeviceMs: sourceNow + 1200, receivedMonotonicMs: mono + 1200,
      versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef },
      value: { '31': { '0': { '5': { '0': 123, '1': 5, '2': 2, '3': 1, '5': 3, '6': 1780000001200 } } } } };
    const acceptedIncrement = flowerModel.ingest({ context: auxContext, observation: increment });
    assert.equal(acceptedIncrement.accepted, true);
    assert.equal(model.ingest({ context: auxContext, observation: increment, acceptedProjection: acceptedIncrement.accepted }).accepted, true);
    const afterIncrement = model.read(auxContext);
    assert.equal(afterIncrement.payload.videoShares[5].value.source.responseRef, increment.responseRef);
    assert.equal(afterIncrement.payload.videoShares[19].value.source.responseRef, obs.responseRef,
      'omitted components retain their original source instead of inheriting the latest head timestamp');
    const incrementalCoverage = buildTypedDynamicCoverage(auxContext, increment, { flowerAuxiliary: afterIncrement });
    assert.ok(incrementalCoverage.some(item => item.domainId === 'order-flower-video-resident'));
    assert.equal(incrementalCoverage.some(item => item.domainId === 'order-flower-video-satin' ||
      item.domainId === 'order-flower-video-decorate'), false, 'unmentioned shares do not receive this response freshness');

    const componentUpdate = { ...obs, method: 'usr.heartTick', requestSequence: 13, responseRef: 'fixture:aux-heart-r13',
      wireKey: 'ws|9|13', receivedDeviceMs: sourceNow + 2400, receivedMonotonicMs: mono + 2400,
      versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef },
      value: { '105': { '0': { '0': 123, '1': {}, '2': [1], '6': {}, '7': {}, '10': 1780000000000 } },
        '22': { '2': { '0': 123, '1': { '9': 400 }, '3': {}, '4': 0 } },
        '101': { '0': { '23068': { '0': 123, '1': 23068, '2': 2, '4': 1 } } } } };
    const acceptedComponents = flowerModel.ingest({ context: auxContext, observation: componentUpdate });
    assert.equal(acceptedComponents.accepted, true);
    assert.equal(model.ingest({ context: auxContext, observation: componentUpdate, acceptedProjection: true }).accepted, true);
    const afterComponents = model.read(auxContext);
    assert.equal(afterComponents.payload.rewardState.stage.value.source.responseRef, componentUpdate.responseRef);
    assert.equal(afterComponents.payload.rewardState.achievement.value.source.responseRef, componentUpdate.responseRef);
    assert.equal(afterComponents.payload.rewardState.ownership.value.source.responseRef, componentUpdate.responseRef);
    assert.equal(afterComponents.payload.enterState.value.board.source.responseRef, componentUpdate.responseRef);
    assert.equal(afterComponents.payload.enterState.value.counters[0].value.source.responseRef, obs.responseRef,
      'updating the board does not renew the old counter source');
    const componentCoverage = buildTypedDynamicCoverage(auxContext, componentUpdate, { flowerAuxiliary: afterComponents });
    assert.ok(componentCoverage.some(item => item.domainId === 'order-flower-reward-stage' &&
      Object.values(item.cellSources).some(source => source.sourceRef === componentUpdate.responseRef)));
    assert.ok(componentCoverage.some(item => item.domainId === 'order-flower-reward-achievement'));
    assert.ok(componentCoverage.some(item => item.domainId === 'order-flower-enter-state' &&
      Object.keys(item.semanticValue).some(key => key.endsWith('.board.resetTime'))));
    const achievementProgressOnly = { ...obs, method: 'usr.heartTick', requestSequence: 14,
      responseRef: 'fixture:aux-ach-progress-r14', wireKey: 'ws|9|14', receivedDeviceMs: sourceNow + 2500,
      receivedMonotonicMs: mono + 2500, versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef },
      value: { '22': { '2': { '1': { '9': 401 } } } } };
    assert.equal(model.ingest({ context: auxContext, observation: achievementProgressOnly, acceptedProjection: true }).accepted, true);
    const afterProgressOnly = model.read(auxContext).payload.rewardState.achievement.value;
    assert.equal(afterProgressOnly.progress, 401);
    assert.equal(afterProgressOnly.receivedIndex, 0);
    assert.equal(afterProgressOnly.fieldSources.progress.responseRef, achievementProgressOnly.responseRef);
    assert.equal(afterProgressOnly.fieldSources.receivedIndex.responseRef, componentUpdate.responseRef,
      'a progress-map update does not renew the independently sourced received map');
    const achievementReceivedMap = { ...obs, method: 'usr.heartTick', requestSequence: 15,
      responseRef: 'fixture:aux-ach-received-r15', wireKey: 'ws|9|15', receivedDeviceMs: sourceNow + 2600,
      receivedMonotonicMs: mono + 2600, versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef },
      value: { '22': { '2': { '3': {} } } } };
    assert.equal(model.ingest({ context: auxContext, observation: achievementReceivedMap, acceptedProjection: true }).accepted, true);
    const afterReceivedMap = model.read(auxContext).payload.rewardState.achievement.value;
    assert.equal(afterReceivedMap.receivedIndex, 0, 'missing group 9 in a supplied complete recvMap means zero');
    assert.equal(afterReceivedMap.fieldSources.receivedIndex.responseRef, achievementReceivedMap.responseRef);
    const receivedZeroCoverage = buildTypedDynamicCoverage(auxContext, achievementReceivedMap,
      { flowerAuxiliary: model.read(auxContext) }).find(item => item.domainId === 'order-flower-reward-achievement');
    assert.equal(receivedZeroCoverage?.semanticValue['order-flower-reward-achievement.achievement.receivedIndex'], 0,
      'a valid zero is represented in typed coverage with its actual response source');
    assert.equal(receivedZeroCoverage?.cellSources['order-flower-reward-achievement.achievement.receivedIndex'].sourceRef,
      achievementReceivedMap.responseRef);
    const sparseOwnership = { ...obs, method: 'usr.heartTick', requestSequence: 16,
      responseRef: 'fixture:aux-ownership-sparse-r16', wireKey: 'ws|9|16', receivedDeviceMs: sourceNow + 2700,
      receivedMonotonicMs: mono + 2700, versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef },
      value: { '101': { '0': {} } } };
    assert.equal(model.ingest({ context: auxContext, observation: sparseOwnership, acceptedProjection: true }).accepted, true);
    assert.equal(model.read(auxContext).payload.rewardState.ownership.value.source.responseRef, componentUpdate.responseRef,
      'omitting 23068 from sparse ownership map retains the previous known row and source');
    const stageOnly = { ...obs, method: 'usr.heartTick', requestSequence: 17, responseRef: 'fixture:aux-stage-only-r17',
      wireKey: 'ws|9|17', receivedDeviceMs: sourceNow + 3000, receivedMonotonicMs: mono + 3000,
      versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef },
      value: { '105': { '0': { '2': [1, 2] } } } };
    const stageOnlyProjection = flowerModel.ingest({ context: auxContext, observation: stageOnly });
    assert.equal(stageOnlyProjection.accepted, true);
    assert.equal(model.ingest({ context: auxContext, observation: stageOnly, acceptedProjection: true }).accepted, true);
    const afterStageOnly = model.read(auxContext);
    assert.deepEqual(afterStageOnly.payload.rewardState.stage.value.receivedIds, [1, 2]);
    assert.equal(afterStageOnly.payload.rewardState.stage.value.fieldSources.resetTime.responseRef, componentUpdate.responseRef,
      'an isolated stage field update retains the actual reset-time source');
    assert.equal(afterStageOnly.payload.enterState.value.board.source.responseRef, componentUpdate.responseRef,
      'a stage-only 105.0.2 update does not invalidate the independently captured enter board');
    const stageOnlyCoverage = buildTypedDynamicCoverage(auxContext, stageOnly, { flowerAuxiliary: afterStageOnly });
    const stageDomain = stageOnlyCoverage.find(item => item.domainId === 'order-flower-reward-stage');
    assert.ok(stageDomain?.paths.includes('order-flower-reward-stage.stage.receivedIds'));
    assert.equal(stageDomain?.paths.includes('order-flower-reward-stage.stage.resetTime'), false,
      'a one-field stage response does not renew other stage-field freshness');

    const cardRows = { '1': { '0': 123, '1': 1, '2': 1, '5': 1780000000000 },
      '6': { '0': 123, '1': 6, '2': 1, '5': 1780000000000 } };
    const fullCardUpdate = { ...obs, method: 'usr.heartTick', requestSequence: 18, responseRef: 'fixture:aux-card-full-r18',
      wireKey: 'ws|9|18', receivedDeviceMs: sourceNow + 3100, receivedMonotonicMs: mono + 3100,
      versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef }, value: { '21': { '5': cardRows } } };
    assert.equal(model.ingest({ context: auxContext, observation: fullCardUpdate, acceptedProjection: true }).accepted, true);
    const partialCardUpdate = { ...obs, method: 'usr.heartTick', requestSequence: 19, responseRef: 'fixture:aux-card-sparse-r19',
      wireKey: 'ws|9|19', receivedDeviceMs: sourceNow + 3200, receivedMonotonicMs: mono + 3200,
      versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef },
      value: { '21': { '5': { '6': { ...cardRows['6'], '2': 0 } } } } };
    assert.equal(model.ingest({ context: auxContext, observation: partialCardUpdate, acceptedProjection: true }).accepted, true);
    const afterSparseCards = model.read(auxContext).payload;
    assert.equal(afterSparseCards.videoCard.source.responseRef, partialCardUpdate.responseRef,
      'the explicitly updated card receives the sparse frame source');
    assert.equal(afterSparseCards.nobleCard.source.responseRef, fullCardUpdate.responseRef,
      'omitting card 1 from the sparse map retains its previous value and source');
    const resetOnly = { ...obs, method: 'usr.heartTick', requestSequence: 20, responseRef: 'fixture:aux-reset-r20',
      wireKey: 'ws|9|20', receivedDeviceMs: sourceNow + 3300, receivedMonotonicMs: mono + 3300,
      versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef },
      value: { '105': { '0': { '10': 1780000003300 } } } };
    assert.equal(flowerModel.ingest({ context: auxContext, observation: resetOnly }).accepted, true);
    assert.equal(model.ingest({ context: auxContext, observation: resetOnly, acceptedProjection: true }).accepted, true);
    const afterResetOnly = model.read(auxContext).payload.enterState.value.board;
    assert.equal(afterResetOnly.resetTime, 1780000003300, 'resetTime-only normal frames update the enter board');
    assert.equal(afterResetOnly.fieldSources.resetTime.responseRef, resetOnly.responseRef);
    assert.equal(afterResetOnly.fieldSources.receivedIds.responseRef, stageOnly.responseRef,
      'a resetTime update does not renew the prior receivedIds cell');
    const enterStageOnly = { ...obs, method: 'usr.heartTick', requestSequence: 21, responseRef: 'fixture:aux-enter-stage-r21',
      wireKey: 'ws|9|21', receivedDeviceMs: sourceNow + 3400, receivedMonotonicMs: mono + 3400,
      versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef },
      value: { '105': { '0': { '2': [1, 2] } } } };
    assert.equal(flowerModel.ingest({ context: auxContext, observation: enterStageOnly }).accepted, true);
    assert.equal(model.ingest({ context: auxContext, observation: enterStageOnly, acceptedProjection: true }).accepted, true);
    const afterEnterStageOnly = model.read(auxContext).payload.enterState.value.board;
    assert.equal(afterEnterStageOnly.resetTime, 1780000003300);
    assert.equal(afterEnterStageOnly.fieldSources.resetTime.responseRef, resetOnly.responseRef,
      'stage-only frames preserve the independently sourced enter resetTime');

    // Counter projections are merged by their own read-model cells. A frame
    // that carries only today's count must not require or refresh total/reset.
    const counterIncrement = { ...obs, method: 'usr.heartTick', requestSequence: 22,
      responseRef: 'fixture:aux-heart-counter-r22', wireKey: 'ws|9|22', receivedDeviceMs: sourceNow + 3500,
      receivedMonotonicMs: mono + 3500, versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef },
      value: { '7': { '4': { '105': { '2': 2 } } } } };
    const counterProjection = flowerModel.ingest({ context: auxContext, observation: counterIncrement });
    assert.equal(counterProjection.accepted, true);
    const counterView = flowerModel.snapshot(auxContext);
    assert.equal(counterView.counters[105].tdyCnt.value, 2);
    assert.equal(counterView.counters[105].totCnt.value, 0);
    assert.equal(counterView.counters[105].totCnt.source.responseRef, obs.responseRef,
      'unprovided total retains the earlier accepted source');
    assert.equal(model.ingest({ context: auxContext, observation: counterIncrement,
      acceptedProjection: counterProjection.accepted, flowerView: counterView, customerView }).accepted, true);
    const counterAux = model.read(auxContext);
    const enterCounter105 = counterAux.payload.enterState.value.counters.find(one => (one?.value || one)?.type === 105),
      enterCounter105Value = enterCounter105?.value || enterCounter105;
    assert.equal(enterCounter105Value.raw, 2, 'enter state consumes the same accepted current counter update');
    assert.equal(enterCounter105Value.fieldSources.raw.responseRef, counterIncrement.responseRef);
    const enterCounterCoverage = buildTypedDynamicCoverage(auxContext, counterIncrement, { flowerAuxiliary: counterAux })
      .find(item => item.domainId === 'order-flower-enter-state');
    assert.equal(enterCounterCoverage?.semanticValue['order-flower-enter-state.counters.105.raw'], 2);
    assert.equal(enterCounterCoverage?.cellSources['order-flower-enter-state.counters.105.raw'].sourceRef, counterIncrement.responseRef);
    const counterCoverage = buildTypedDynamicCoverage(auxContext, counterIncrement, { flowerAuxiliary: counterAux });
    const rewardCoverage = counterCoverage.find(item => item.domainId === 'order-flower-reward-stage');
    assert.ok(rewardCoverage?.paths.includes('order-flower-reward-stage.counters.105.raw'));
    assert.equal(rewardCoverage.paths.includes('order-flower-reward-stage.counters.105.total'), false,
      'a partial counter response refreshes only its supplied count cell');
    const counter107Increment = { ...obs, method: 'usr.heartTick', requestSequence: 23,
      responseRef: 'fixture:aux-heart-counter107-r23', wireKey: 'ws|9|23', receivedDeviceMs: sourceNow + 3600,
      receivedMonotonicMs: mono + 3600, versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef },
      value: { '7': { '4': { '107': { '2': 4 } } } } };
    const customerProjection = customerModel.ingest({ context: auxContext, observation: counter107Increment });
    assert.equal(customerProjection.accepted, true);
    const customerViewAfter107 = customerModel.snapshot(auxContext);
    assert.equal(customerViewAfter107.eligibilityInputs.count107.tdyCnt.value, 4);
    assert.equal(customerViewAfter107.eligibilityInputs.count107.totCnt.source.responseRef, obs.responseRef);
    assert.equal(model.ingest({ context: auxContext, observation: counter107Increment,
      acceptedProjection: customerProjection.accepted, customerView: customerViewAfter107 }).accepted, true);
    const counter107Aux = model.read(auxContext).payload.rewardState.counters[3];
    assert.equal(counter107Aux.value.raw, 4, 'the auxiliary 107 counter consumes the real customer projection delta');
    assert.equal(counter107Aux.value.total, 0);
    assert.equal(counter107Aux.value.fieldSources.total.responseRef, obs.responseRef,
      'the 107 total keeps its own older accepted source');
    const explicitOwnershipDelete = { ...obs, method: 'usr.heartTick', requestSequence: 24,
      responseRef: 'fixture:aux-ownership-delete-r24', wireKey: 'ws|9|24', receivedDeviceMs: sourceNow + 3700,
      receivedMonotonicMs: mono + 3700, versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef },
      value: { '101': { '0': { '23068': false } } } };
    assert.equal(model.ingest({ context: auxContext, observation: explicitOwnershipDelete, acceptedProjection: true }).accepted, true);
    const deletedOwnership = model.read(auxContext).payload.rewardState.ownership;
    assert.equal(deletedOwnership.known, true);
    assert.equal(deletedOwnership.value.present, false,
      'an explicit falsy update removes the provided ownership row');
    assert.equal(deletedOwnership.value.source.responseRef, explicitOwnershipDelete.responseRef);
    const nullSlot = { ...obs, method: 'usr.heartTick', requestSequence: 25, responseRef: 'fixture:aux-null-slot-r25',
      wireKey: 'ws|9|25', receivedDeviceMs: sourceNow + 3800, receivedMonotonicMs: mono + 3800,
      versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef },
      value: { '105': { '0': { '3': null, '6': null } } } };
    assert.equal(flowerModel.ingest({ context: auxContext, observation: nullSlot }).accepted, true);
    assert.equal(model.ingest({ context: auxContext, observation: nullSlot, acceptedProjection: true }).accepted, true);
    const nullSlotAux = model.read(auxContext), nullSlotBoard = nullSlotAux.payload.enterState.value.board;
    assert.equal(nullSlotBoard.satin, null, 'an explicitly supplied null slot replaces the prior slot');
    assert.equal(nullSlotBoard.fieldSources.satin.responseRef, nullSlot.responseRef);
    const nullSlotCoverage = buildTypedDynamicCoverage(auxContext, nullSlot, { flowerAuxiliary: nullSlotAux })
      .find(item => item.domainId === 'order-flower-enter-state');
    assert.equal(nullSlotCoverage?.semanticValue['order-flower-enter-state.board.satin'], null,
      'null is a present typed cell, not absence');
    assert.equal(nullSlotCoverage?.cellSources['order-flower-enter-state.board.satin'].sourceRef, nullSlot.responseRef);
    const cardIdentity = { ...obs, method: 'usr.heartTick', requestSequence: 26, responseRef: 'fixture:aux-card-id-r26',
      wireKey: 'ws|9|26', receivedDeviceMs: sourceNow + 3900, receivedMonotonicMs: mono + 3900,
      versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef },
      value: { '21': { '5': { '6': { '0': 123, '1': 6, '2': 0 } } } } };
    assert.equal(flowerModel.ingest({ context: auxContext, observation: cardIdentity }).accepted, true);
    assert.equal(model.ingest({ context: auxContext, observation: cardIdentity, acceptedProjection: true }).accepted, true);
    assert.equal(model.read(auxContext).payload.videoCard.known, true, 'a sparse identity update preserves the previously complete row and its unprovided expiry');
    const cardExpiry = { ...obs, method: 'usr.heartTick', requestSequence: 27, responseRef: 'fixture:aux-card-expiry-r27',
      wireKey: 'ws|9|27', receivedDeviceMs: sourceNow + 4000, receivedMonotonicMs: mono + 4000,
      versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef },
      value: { '21': { '5': { '6': { '5': 1780000004000 } } } } };
    assert.equal(flowerModel.ingest({ context: auxContext, observation: cardExpiry }).accepted, true);
    assert.equal(model.ingest({ context: auxContext, observation: cardExpiry, acceptedProjection: true }).accepted, true);
    const cardAfterExpiry = model.read(auxContext).payload.videoCard;
    assert.equal(cardAfterExpiry.known, true);
    assert.equal(cardAfterExpiry.fieldSources.uid.responseRef, cardIdentity.responseRef);
    assert.equal(cardAfterExpiry.fieldSources.invalidTime.responseRef, cardExpiry.responseRef);
    const cardConflict = { ...obs, method: 'usr.heartTick', requestSequence: 28, responseRef: 'fixture:aux-card-type-bad-r28',
      wireKey: 'ws|9|28', receivedDeviceMs: sourceNow + 4100, receivedMonotonicMs: mono + 4100,
      versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef },
      value: { '21': { '5': { '6': { '1': 99 } } } } };
    assert.equal(flowerModel.ingest({ context: auxContext, observation: cardConflict }).accepted, true);
    assert.equal(model.ingest({ context: auxContext, observation: cardConflict, acceptedProjection: true }).accepted, true);
    assert.equal(model.read(auxContext).payload.videoCard.known, false, 'wrong provided type invalidates the eligibility row');
    const cardTypeRecovery = { ...obs, method: 'usr.heartTick', requestSequence: 29, responseRef: 'fixture:aux-card-type-good-r29',
      wireKey: 'ws|9|29', receivedDeviceMs: sourceNow + 4200, receivedMonotonicMs: mono + 4200,
      versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef },
      value: { '21': { '5': { '6': { '1': 6 } } } } };
    assert.equal(flowerModel.ingest({ context: auxContext, observation: cardTypeRecovery }).accepted, true);
    assert.equal(model.ingest({ context: auxContext, observation: cardTypeRecovery, acceptedProjection: true }).accepted, true);
    assert.equal(model.read(auxContext).payload.videoCard.known, true, 'correct type recovers using the separately bound card ID');
    const sharePartial = { ...obs, method: 'usr.heartTick', requestSequence: 30, responseRef: 'fixture:aux-share-count-r30',
      wireKey: 'ws|9|30', receivedDeviceMs: sourceNow + 4300, receivedMonotonicMs: mono + 4300,
      versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef },
      value: { '31': { '0': { '5': { '3': 4 } } } } };
    const priorShareTotalSource = model.read(auxContext).payload.videoShares[5].value.fieldSources.total.responseRef;
    assert.equal(flowerModel.ingest({ context: auxContext, observation: sharePartial }).accepted, true);
    assert.equal(model.ingest({ context: auxContext, observation: sharePartial, acceptedProjection: true }).accepted, true);
    const mergedShare = model.read(auxContext).payload.videoShares[5].value;
    assert.equal(mergedShare.recvCnt, 4);
    assert.equal(mergedShare.fieldSources.recvCnt.responseRef, sharePartial.responseRef);
    assert.equal(mergedShare.fieldSources.total.responseRef, priorShareTotalSource,
      'a counter-only share response updates its cell without refreshing omitted quota fields');

    // Freshness is per typed card field. A later expiry-only frame must not
    // make the older identity cells fresh merely because the wrapper row has
    // a new top-level source.
    let auxNow = sourceNow + 5000, auxMono = 6000;
    const auxCoordinator = createDynamicStateCoordinator({ store: auxStore,
      isCurrent: value => JSON.stringify(value) === JSON.stringify(auxContext),
      deviceNow: () => auxNow, monotonicNow: () => auxMono });
    const cardBaseline = { ...obs, method: 'usr.heartTick', requestSequence: 31,
      responseRef: 'fixture:aux-card-typed-baseline-r31', wireKey: 'ws|9|31',
      receivedDeviceMs: auxNow, receivedMonotonicMs: auxMono,
      versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef },
      value: { '21': { '5': { '6': { '0': 123, '1': 6, '2': 0, '5': 1780000005000 } } } } };
    const baselineFlower = flowerModel.ingest({ context: auxContext, observation: cardBaseline });
    assert.equal(baselineFlower.accepted, true);
    assert.equal(model.ingest({ context: auxContext, observation: cardBaseline, acceptedProjection: true }).accepted, true);
    const cardFeature = { featureId: 'order.resident', consumedDomains: FEATURE_DOMAINS['order.resident'],
      consumedDomainsFor: () => ['order-flower-card-video'] };
    const baselineCoverage = buildTypedDynamicCoverage(auxContext, cardBaseline, { flowerAuxiliary: model.read(auxContext) });
      const baselineResult = auxCoordinator.observe({ context: auxContext, observation: cardBaseline, coverage: baselineCoverage });
    assert.equal(baselineResult.accepted, true, JSON.stringify(baselineResult));
    const baselineCardSnapshot = auxCoordinator.snapshot({ context: auxContext, feature: cardFeature });
    assert.equal(baselineCardSnapshot.current, true, JSON.stringify({ baselineCoverage, baselineCardSnapshot }));

    auxNow += 120001; auxMono += 120001;
    const expiryOnlyAfterTtl = { ...obs, method: 'usr.heartTick', requestSequence: 32,
      responseRef: 'fixture:aux-card-expiry-after-ttl-r32', wireKey: 'ws|9|32',
      receivedDeviceMs: auxNow, receivedMonotonicMs: auxMono,
      versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef },
      value: { '21': { '5': { '6': { '5': 1780000125001 } } } } };
    const expiryFlower = flowerModel.ingest({ context: auxContext, observation: expiryOnlyAfterTtl });
    assert.equal(expiryFlower.accepted, true);
    assert.equal(model.ingest({ context: auxContext, observation: expiryOnlyAfterTtl, acceptedProjection: true }).accepted, true);
    const expiryCoverage = buildTypedDynamicCoverage(auxContext, expiryOnlyAfterTtl, { flowerAuxiliary: model.read(auxContext) })
      .find(item => item.domainId === 'order-flower-card-video');
    assert.deepEqual(expiryCoverage.paths, ['order-flower-card-video.card.invalidTime']);
    const expiryResult = auxCoordinator.observe({ context: auxContext, observation: expiryOnlyAfterTtl,
      coverage: [expiryCoverage] });
    assert.equal(expiryResult.accepted, true, JSON.stringify(expiryResult));
    const staleCard = auxCoordinator.snapshot({ context: auxContext, feature: cardFeature });
    assert.equal(staleCard.current, false,
      'refreshing card expiry after the TTL does not renew stale uid/type/isMain cells');
    assert.equal(staleCard.domains[0].reasonCode, 'DYNAMIC_DOMAIN_CELL_MAX_AGE_EXCEEDED');

    auxNow += 1; auxMono += 1;
    const cardDeleted = { ...obs, method: 'usr.heartTick', requestSequence: 33,
      responseRef: 'fixture:aux-card-explicit-delete-r33', wireKey: 'ws|9|33',
      receivedDeviceMs: auxNow, receivedMonotonicMs: auxMono,
      versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef },
      value: { '21': { '5': { '6': false } } } };
    assert.equal(flowerModel.ingest({ context: auxContext, observation: cardDeleted }).accepted, true);
    assert.equal(model.ingest({ context: auxContext, observation: cardDeleted, acceptedProjection: true }).accepted, true);
    const deletedCardCoverage = buildTypedDynamicCoverage(auxContext, cardDeleted, { flowerAuxiliary: model.read(auxContext) })
      .find(item => item.domainId === 'order-flower-card-video');
    assert.deepEqual(deletedCardCoverage.paths, ['order-flower-card-video.card.present']);
    const deleteResult = auxCoordinator.observe({ context: auxContext, observation: cardDeleted, coverage: [deletedCardCoverage] });
    assert.equal(deleteResult.accepted, true, JSON.stringify(deleteResult));
    assert.equal(auxStore.get(`SELECT COUNT(*) AS n FROM backend_dynamic_domain_cells WHERE owner_ref=? AND subject_ref=? AND domain_id=? AND path LIKE ?`,
      auxContext.ownerRef, auxContext.subjectRef, 'order-flower-card-video', 'order-flower-card-video.card.%').n, 1,
    'explicit delete replaces only the declared card collection, leaving its absent marker');
    assert.equal(auxCoordinator.snapshot({ context: auxContext, feature: cardFeature }).current, true,
      'the explicit absent marker is a fresh, usable fact rather than stale card fields');

    const shareFeature = { featureId: 'order.resident', consumedDomains: FEATURE_DOMAINS['order.resident'],
      consumedDomainsFor: () => ['order-flower-video-resident'] };
    auxNow += 100; auxMono += 100;
    const shareBaseline = { ...obs, method: 'usr.heartTick', requestSequence: 35,
      responseRef: 'fixture:aux-share-typed-baseline-r35', wireKey: 'ws|9|35',
      receivedDeviceMs: auxNow, receivedMonotonicMs: auxMono,
      versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef },
      value: { '31': { '0': { '5': { '0': 123, '1': 5, '2': 4, '3': 1, '4': 1780000005000,
        '5': 6, '6': 1780000005000 } } } } };
    const shareBaselineFlower = flowerModel.ingest({ context: auxContext, observation: shareBaseline });
    assert.equal(shareBaselineFlower.accepted, true);
    assert.equal(model.ingest({ context: auxContext, observation: shareBaseline, acceptedProjection: true }).accepted, true);
    const shareBaselineCoverage = buildTypedDynamicCoverage(auxContext, shareBaseline, { flowerAuxiliary: model.read(auxContext) });
    const shareBaselineResult = auxCoordinator.observe({ context: auxContext, observation: shareBaseline, coverage: shareBaselineCoverage });
    assert.equal(shareBaselineResult.accepted, true, JSON.stringify(shareBaselineResult));
    assert.equal(auxCoordinator.snapshot({ context: auxContext, feature: shareFeature }).current, true);

    auxNow += 120001; auxMono += 120001;
    const shareCountOnly = { ...obs, method: 'usr.heartTick', requestSequence: 36,
      responseRef: 'fixture:aux-share-count-after-ttl-r36', wireKey: 'ws|9|36',
      receivedDeviceMs: auxNow, receivedMonotonicMs: auxMono,
      versionEvidence: { ...obs.versionEvidence, loginResponseRef: obs.responseRef },
      value: { '31': { '0': { '5': { '3': 2 } } } } };
    const shareCountFlower = flowerModel.ingest({ context: auxContext, observation: shareCountOnly });
    assert.equal(shareCountFlower.accepted, true);
    assert.equal(model.ingest({ context: auxContext, observation: shareCountOnly, acceptedProjection: true }).accepted, true);
    const shareCountCoverage = buildTypedDynamicCoverage(auxContext, shareCountOnly, { flowerAuxiliary: model.read(auxContext) })
      .find(item => item.domainId === 'order-flower-video-resident');
    assert.deepEqual(shareCountCoverage.paths, ['order-flower-video-resident.share.recvCnt']);
    const shareCountResult = auxCoordinator.observe({ context: auxContext, observation: shareCountOnly, coverage: [shareCountCoverage] });
    assert.equal(shareCountResult.accepted, true, JSON.stringify(shareCountResult));
    const staleShare = auxCoordinator.snapshot({ context: auxContext, feature: shareFeature });
    assert.equal(staleShare.current, false,
      'refreshing only recvCnt after the TTL does not renew stale share identity/quota/time cells');
    assert.equal(staleShare.domains[0].reasonCode, 'DYNAMIC_DOMAIN_CELL_MAX_AGE_EXCEEDED');
    flowerModel.shutdown();
    customerModel.stop();
    model.shutdown();
  } finally { auxStore.close(); fs.rmSync(auxDir, { recursive: true, force: true }); }
});

test('one matched login merges land, customer and flower-order decoder projections before observation', () => {
  const combinedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-combined-projections-'));
  const combinedStore = openBackendStore({ dataDir: combinedDir });
  const combinedContext = Object.freeze({ ...context, connectionEpoch: 2 });
  const isCurrent = value => JSON.stringify(value) === JSON.stringify(combinedContext);
  const obs = observation({ seq: 1, ref: 'fixture:combined-login', receivedDeviceMs: Date.now() });
  obs.connectionEpoch = combinedContext.connectionEpoch;
  obs.context = combinedContext;
  obs.wireKey = 'ws|1|1';
  Object.assign(obs.value['7']['0'], { '34': 8, '36': 2, '44': 5000, '41': 17 });
  obs.value['109'] = { '0': { '0': 123, '1': {}, '2': 0, '3': 0, '4': 0, '5': 0, '6': [], '7': true } };
  obs.value['105'] = { '0': { '0': 123, '1': {}, '2': [], '3': 0, '4': 0, '5': 0, '6': {}, '7': {}, '8': {}, '9': {}, '10': 0 } };
  obs.versionEvidence = { source: 'normal-package-hop-and-matched-world-login/v1', gameVersion: '480.0.27',
    protocolVersion: '480.0.0', loginResponseRef: obs.responseRef };
  const landProjection = createLandProjection({ store: combinedStore, catalog: { land: id => id === 1, identity: () => ({ catalogId: 'fixture-catalog' }) }, isCurrent });
  const customerModel = createCustomerReadModel({ store: combinedStore, isCurrent });
  const flowerModel = createOrderFlowerReadModel({ store: combinedStore, isCurrent });
  const frame = decodeOfficialLandObservation({ context: combinedContext, observation: obs,
    capabilities: { bagComplete: true, itemExtComplete: true } });
  const land = landProjection.ingest(frame);
  const customer = customerModel.ingest({ context: combinedContext, observation: obs });
  const flowerOrders = flowerModel.ingest({ context: combinedContext, observation: obs });
  assert.equal(land.accepted, true);
  assert.equal(customer.accepted, true);
  assert.equal(flowerOrders.accepted, true);
  const customerSnapshot = customerModel.snapshot(combinedContext);
  assert.equal(customerSnapshot.eligibilityInputs.profile.vip.state, 'known', 'customer decoder contributes profile.vip');
  assert.equal(customerSnapshot.eligibilityInputs.profile.vip.value, 2);
  const coverage = buildTypedDynamicCoverage(combinedContext, obs, { land, landView: landProjection.view(combinedContext),
    customer, customerView: customerSnapshot, flowerOrders, flowerView: flowerModel.snapshot(combinedContext) });
  assert.equal(new Set(coverage.map(item => item.domainId)).size, coverage.length, 'each domain is emitted once after fragment merge');
  const combinedCoordinator = createDynamicStateCoordinator({ store: combinedStore, isCurrent, deviceNow: () => Date.now(), monotonicNow: () => mono });
  const result = combinedCoordinator.observe({ context: combinedContext, observation: obs, coverage });
  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.ok(result.published.includes('profile'), 'overlapping profile cells from three accepted decoders merge in one response');
  const profile = coverage.find(item => item.domainId === 'profile');
  assert.ok(profile.paths.includes('profile.vip'), 'merged profile publishes customer-only VIP coverage');
  assert.ok(profile.paths.includes('profile.gold'), 'merged profile publishes order-only gold coverage');
  customerModel.stop(); flowerModel.stop(); combinedStore.close(); fs.rmSync(combinedDir, { recursive: true, force: true });
});

test('customer required collections arrive across frames without losing early cells or claiming premature completeness', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-customer-split-required-'));
  const db = openBackendStore({ dataDir: dir });
  const ctx = Object.freeze({ ...context, connectionEpoch: 9 });
  const isCurrent = value => JSON.stringify(value) === JSON.stringify(ctx);
  let wall = 5000, clock = 5000;
  const model = createCustomerReadModel({ store: db, isCurrent });
  const coord = createDynamicStateCoordinator({ store: db, isCurrent, deviceNow: () => wall, monotonicNow: () => clock });
  const make = (seq, ref, data, method = 'usr.heartTick') => ({ ...observation({ seq, ref, receivedDeviceMs: wall }),
    context: ctx, connectionEpoch: ctx.connectionEpoch, method, wireKey: `ws|9|${seq}`, receivedMonotonicMs: clock,
    versionEvidence: { source: 'normal-package-hop-and-matched-world-login/v1', gameVersion: '480.0.27',
      protocolVersion: '480.0.0', loginResponseRef: 'fixture:split-customer-login' }, value: { '7': { '0': { '0': 123 } }, ...data } });
  const cov = obs => {
    const accepted = model.ingest({ context: ctx, observation: obs });
    assert.equal(accepted.accepted, true, JSON.stringify(accepted));
    const view = model.snapshot(ctx);
    const coverage = buildTypedDynamicCoverage(ctx, obs, { customer: accepted, customerView: view })
      .filter(item => ['customer', 'art-inputs'].includes(item.domainId));
    const result = coord.observe({ context: ctx, observation: obs, coverage });
    assert.equal(result.accepted, true, JSON.stringify(result));
    return { view, coverage, item: coverage.find(item => item.domainId === 'customer'), artItem: coverage.find(item => item.domainId === 'art-inputs'),
      head: db.get(`SELECT complete FROM backend_dynamic_domain_heads WHERE owner_ref=? AND subject_ref=? AND domain_id='customer'`, ctx.ownerRef, ctx.subjectRef),
      artHead: db.get(`SELECT complete FROM backend_dynamic_domain_heads WHERE owner_ref=? AND subject_ref=? AND domain_id='art-inputs'`, ctx.ownerRef, ctx.subjectRef) };
  };
  try {
    const orderRow = { '0': 1, '1': 23001, '2': 2, '3': 1, '4': 100 };
    const login = make(1, 'fixture:split-customer-login', { '109': { '0': { '0': 123, '1': {} } },
      '102': { '0': {} }, '106': { '0': { '0': 123 } } }, 'index.login');
    login.currentIdentity = { verified: true, officialUid: 123, responseRef: login.responseRef };
    const initial = cov(login);
    assert.ok(initial.artItem, 'partial initial art cells are published');
    assert.equal(initial.artItem.complete, false, 'make-list is not invented from a missing property');
    assert.equal(initial.artHead.complete, 0);

    wall += 10; clock += 10;
    const mapFrame = make(2, 'fixture:customer-map-only', { '109': { '0': { '1': { '7': orderRow } } } });
    const partial = cov(mapFrame);
    assert.equal(partial.item.complete, false, 'model remains incomplete while stock collection is not yet known');
    assert.ok(partial.item.paths.includes('customer.orderMap'));
    assert.equal(partial.head.complete, 0, 'partial board cannot authorize a consumer');
    assert.equal(db.get(`SELECT source_ref FROM backend_dynamic_domain_cells WHERE owner_ref=? AND subject_ref=? AND domain_id='customer' AND path='customer.orderMap'`,
      ctx.ownerRef, ctx.subjectRef).source_ref, mapFrame.responseRef);
    const makeListPath = 'art-inputs.flowerArt.makeList';
    wall += 1; clock += 1;
    const artFrame = make(3, 'fixture:customer-art-makelist', { '106': { '0': { '2': [] } } });
    const artUpdate = cov(artFrame);
    assert.equal(artUpdate.artItem.complete, true, 'merged art input model becomes complete across frames');
    assert.equal(artUpdate.artHead.complete, 1);
    assert.equal(db.get(`SELECT source_ref FROM backend_dynamic_domain_cells WHERE owner_ref=? AND subject_ref=? AND domain_id='art-inputs' AND path=?`,
      ctx.ownerRef, ctx.subjectRef, makeListPath).source_ref, artFrame.responseRef);

    wall += 10; clock += 10;
    const stockFrame = make(4, 'fixture:customer-stock-only', { '109': { '0': { '6': [orderRow] } } });
    const completed = cov(stockFrame);
    assert.equal(completed.item.complete, true, JSON.stringify({ orderMap: completed.view.orderMap, stock: completed.view.orderStockList,
      paths: completed.item.paths, selected: completed.item.semanticValue }));
    assert.equal(completed.head.complete, 1, 'the domain becomes complete after both required collections are merged');
    assert.equal(db.get(`SELECT source_ref FROM backend_dynamic_domain_cells WHERE owner_ref=? AND subject_ref=? AND domain_id='customer' AND path='customer.orderMap'`,
      ctx.ownerRef, ctx.subjectRef).source_ref, mapFrame.responseRef, 'the earlier collection keeps its actual source');
    assert.equal(db.get(`SELECT source_ref FROM backend_dynamic_domain_cells WHERE owner_ref=? AND subject_ref=? AND domain_id='customer' AND path='customer.orderStockList'`,
      ctx.ownerRef, ctx.subjectRef).source_ref, stockFrame.responseRef, 'the later collection keeps its own source');
  } finally { model.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
