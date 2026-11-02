import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, makeObservation } from './helpers-land-current-need-fixture.mjs';
import { createOrderFlowerIdentity } from '../runtime/backend/features/order-flower/identity.mjs';
import { createOrderFlowerAuxiliaryRuntime } from '../runtime/backend/features/order-flower/auxiliary-runtime.mjs';
import { composeOrderFlowerFeature } from '../runtime/backend/features/order-flower/composition.mjs';
import { createFeatureRegistry } from '../runtime/backend/registry/index.mjs';
import { createWriteGateway } from '../runtime/backend/execution/gateway.mjs';
import { buildTypedDynamicCoverage } from '../runtime/backend/facts/typed-coverage.mjs';
import { fingerprint } from '../runtime/backend/common.mjs';
import { createOrderFlowerVideoRequests } from '../runtime/backend/features/order-flower/video-request.mjs';

test('decoded auxiliary stage facts flow through production models, composed schedule unit, registry and gateway', async () => {
  const f = fixture();
  try {
    const login = f.seedLogin(f.active, 1, 1, observation => {
      observation.value['105']['0']['10'] = 1_800_000_001_000;
      for (const id of [105, 109, 116]) observation.value['7']['4'][String(id)]['2'] = 100;
    });
    const auxiliaryIdentity = createOrderFlowerIdentity({ store: f.store, isCurrent: f.isCurrent, clock: f.facts.clock });
    const legacyConstraints = { candidateProjection: () => ({ ownerRef: login.context.ownerRef, subjectRef: login.context.subjectRef,
      operations: [], targets: [], resourceFootprints: [], bases: [], semanticMatches: [], matchedTargets: [], declaredTargetMatches: [], matchedResources: [],
      unclassifiedOperations: [] }) };
    const readConfig = context => f.configService.read({ ownerRef: context.ownerRef, accountRef: String(context.accountRef) });
    const orderFeature = f.flowerRuntime.features.find(one => one.featureId === 'order.resident');
    const auxiliaryRuntime = createOrderFlowerAuxiliaryRuntime({ store: f.store,
      readAuxiliaryFacts: f.auxiliaryFacts.read,
      readView: f.flowerReadModel.snapshot,
      reconcileIdentities: input => auxiliaryIdentity.reconcile(input),
      readEligibility: ({ context, view, clock }) => f.flowerEligibility.evaluate({ context, view, clock }),
      readGenerationFacts: f.customerGenerationFacts.read,
      readConfiguration: readConfig,
      isCurrent: f.isCurrent,
      clock: f.facts.clock,
      ledgerView: { operation: f.ledger.operation, currentAdmission: f.ledger.currentAdmission },
      isolationEvidence: { read: () => ({ available: false }) },
      validateReadSnapshotLease: () => ({ valid: false, current: false }),
      appendOutbox: event => f.ledger.appendOutbox({ ...event, eventType: event.eventType || event.type,
        eventKey: event.eventKey || 'aux-fixture:' + fingerprint(event) }),
      notify: () => {}, legacyConstraints,
      readCurrentInventory: context => f.landRuntime.dynamicView(context),
      currentNeedFacts: ({ context, method, proposal, config }) => f.dynamic.currentNeedSnapshot({ context,
        feature: composed, config: config?.config || config, method, proposal }) });
    const composed = composeOrderFlowerFeature({ feature: orderFeature, orderFlowerRuntime: f.flowerRuntime,
      auxiliaryRuntime, actionRuntime: { evaluateAdmission: input => auxiliaryRuntime.evaluateAdmission(input) } });
    const registry = createFeatureRegistry();
    for (const module of f.landRuntime.features) registry.register(module);
    for (const module of f.flowerRuntime.features) if (module.featureId !== 'order.resident') registry.register(module);
    registry.register(composed);

    // A sparse, matched normal response updates only the stage receipt cell.
    // The read models and auxiliary facts merge it with the login baseline;
    // typed coverage records the actual response source and the dynamic gate
    // still checks each consumed domain's own age.
    const partial = makeObservation(f.active, { sequence: 2, responseRef: 'fixture:normal-stage-partial',
      landState: 1, method: 'usr.heartTick' });
    partial.value = { '105': { '0': { '2': [], '3': null } }, '7': { '4': { '107': { '2': 0 } } } };
    f.ingestor.ingest(f.active, partial);
    const land = f.landRuntime.ingest({ context: f.active, observation: partial });
    const customer = f.customerReadModel.ingest({ context: f.active, observation: partial });
    f.customerGenerationFacts.ingest({ context: f.active, observation: partial });
    const flowerOrders = f.flowerReadModel.ingest({ context: f.active, observation: partial });
    assert.equal(flowerOrders.accepted, true, JSON.stringify(flowerOrders));
    const customerView = f.customerReadModel.snapshot(f.active), flowerView = f.flowerReadModel.snapshot(f.active);
    const auxiliaryAccepted = f.auxiliaryFacts.ingest({ context: f.active, observation: partial,
      acceptedProjection: land?.accepted === true || customer?.accepted === true || flowerOrders.accepted === true,
      flowerView, customerView });
    assert.equal(auxiliaryAccepted.accepted, true, JSON.stringify(auxiliaryAccepted));
    const auxiliaryView = f.auxiliaryFacts.read(f.active);
    const observed = f.dynamic.observe({ context: f.active, observation: partial, coverage: buildTypedDynamicCoverage(f.active, partial, {
      land, landView: f.landRuntime.dynamicView(f.active), customer, customerView, flowerOrders, flowerView,
      flowerAuxiliary: auxiliaryView, customerDay: f.customerGenerationFacts.read(f.active), officialClock: f.facts.clock(f.active.subjectRef) }) });
    assert.equal(observed.accepted, true, JSON.stringify(observed));
    const stage = auxiliaryView.payload.rewardState.stage.value;
    assert.equal(stage.receivedIds.length, 0);
    assert.equal(stage.fieldSources.receivedIds.responseRef, partial.responseRef);
    assert.equal(stage.receivedTime, null, 'an explicitly supplied null is retained as a known stage field');
    assert.equal(stage.fieldSources.receivedTime.responseRef, partial.responseRef);
    const dailyCounter107 = auxiliaryView.payload.rewardState.counters[3].value;
    assert.equal(dailyCounter107.raw, 0, 'a real sparse counter update to zero is retained');
    assert.equal(dailyCounter107.fieldSources.raw.responseRef, partial.responseRef);
    for (const domainId of ['order-flower-reward-stage', 'inventory', 'profile', 'clock']) {
      const domain = f.dynamic.snapshot({ context: f.active, feature: composed,
        config: f.configReceipt.config, method: 'orderFlower.recvOrderRwd', proposal: { orderFlowerReward: { kind: 'stage' } } })
        .domains.find(one => one.domainId === domainId);
      assert.equal(domain?.current, true, `required production dynamic domain ${domainId} is current`);
    }

    const stageUnit = composed.scheduleUnits.find(one => one.scheduleKey === 'order.resident:stage-reward');
    const assessment = await stageUnit.assess({ context: f.active, config: f.configReceipt });
    assert.equal(assessment.state, 'proposals', JSON.stringify({ state: assessment.state, reasonCode: assessment.reasonCode,
      readiness: auxiliaryRuntime.readiness(f.active) }));
    const proposal = assessment.proposals[0];
    assert.equal(proposal.method, 'orderFlower.recvOrderRwd');
    assert.ok(proposal.orderFlowerReward.currentNeed.claimRef);

    const gateway = createWriteGateway({ store: f.store, ledger: f.ledger, registry,
      supervisor: { executorRef: 'fixture:executor', context: () => f.actor, verificationLease: () => ({ active: false }) },
      readConfiguration: readConfig, authorize: () => true,
      readFactBasis: input => auxiliaryRuntime.readFactBasis(input),
      evaluateAdmission: input => composed.qualify(input), dynamicState: f.dynamic,
      onSettled: event => auxiliaryRuntime.onSettled(event), onTransportUncertain: () => {},
      postReadLease: { readSnapshotAfterClose: async () => { throw new Error('unused'); },
        validateReadSnapshotLease: () => false, releaseReadSnapshotLease: () => ({ released: true }) } });
    await assert.rejects(gateway.submit(proposal), { code: 'FIXTURE_ANSWER_LOST' });
    assert.equal(f.sendBytes, 1);
    const permit = f.store.get('SELECT consumed,wire_key,request_sequence FROM backend_send_permits WHERE operation_id=?', proposal.operationId);
    assert.equal(permit?.consumed, 1);
    assert.equal(permit?.request_sequence, 1);
    assert.equal(f.ledger.operation(proposal.operationId)?.business_verdict, 'unknown');
  } finally { await f.close(); }
});

test('decoded partial enter reset and zero counters flow through actual enter proposal and gateway', async () => {
  const f = fixture();
  try {
    const initialConfig = f.configService.read({ ownerRef: f.active.ownerRef, accountRef: String(f.active.accountRef) });
    const savedConfig = f.configService.save({ ownerRef: f.active.ownerRef, accountRef: String(f.active.accountRef),
      expectedRevision: initialConfig.savedRevision, config: { ...initialConfig.config,
        orders: { ...initialConfig.config.orders, satin: { ...initialConfig.config.orders?.satin, enabled: true } } } });
    const currentConfig = f.configService.read({ ownerRef: f.active.ownerRef, accountRef: String(f.active.accountRef) });
    const configReceipt = f.configService.accept({ ownerRef: f.active.ownerRef, accountRef: String(f.active.accountRef),
      revision: currentConfig.savedRevision, actorRef: 'fixture:actor' });
    const login = f.seedLogin(f.active, 1, 1, observation => {
      observation.value['105']['0']['10'] = 1_799_900_000_000;
      observation.value['105']['0']['6'] = {};
      observation.value['105']['0']['7'] = {};
      observation.value['7']['9']['sys_orderSatins'] = { '0': 'sys_orderSatins', '6': [] };
      for (const id of [105, 109, 116, 107]) observation.value['7']['4'][String(id)]['2'] = 0;
    });
    const identity = createOrderFlowerIdentity({ store: f.store, isCurrent: f.isCurrent, clock: f.facts.clock });
    const legacyConstraints = { candidateProjection: () => ({ ownerRef: login.context.ownerRef, subjectRef: login.context.subjectRef,
      operations: [], targets: [], resourceFootprints: [], bases: [], semanticMatches: [], matchedTargets: [], declaredTargetMatches: [], matchedResources: [],
      unclassifiedOperations: [{ operation_ref: 'legacy-share-without-target', method: 'usr.share' }] }) };
    const readConfig = context => f.configService.read({ ownerRef: context.ownerRef, accountRef: String(context.accountRef) });
    const orderFeature = f.flowerRuntime.features.find(one => one.featureId === 'order.resident');
    const satinFeature = f.flowerRuntime.features.find(one => one.featureId === 'order.satin');
    let composed, composedSatin;
    const auxiliaryRuntime = createOrderFlowerAuxiliaryRuntime({ store: f.store, readAuxiliaryFacts: f.auxiliaryFacts.read,
      readView: f.flowerReadModel.snapshot, reconcileIdentities: input => identity.reconcile(input),
      readEligibility: ({ context, view, clock }) => f.flowerEligibility.evaluate({ context, view, clock }),
      readGenerationFacts: f.customerGenerationFacts.read, readConfiguration: readConfig, isCurrent: f.isCurrent,
      clock: f.facts.clock, ledgerView: { operation: f.ledger.operation, currentAdmission: f.ledger.currentAdmission },
      isolationEvidence: f.isolationEvidence, validateReadSnapshotLease: () => ({ valid: false, current: false }),
      appendOutbox: event => f.ledger.appendOutbox({ ...event, eventType: event.eventType || event.type,
        eventKey: event.eventKey || 'aux-enter-fixture:' + fingerprint(event) }), notify: () => {}, legacyConstraints,
      readCurrentInventory: context => f.landRuntime.dynamicView(context),
      currentNeedFacts: ({ context, method, proposal, config }) => f.dynamic.currentNeedSnapshot({ context,
        feature: proposal.featureId === 'order.satin' ? composedSatin : composed, config: config?.config || config, method, proposal }) });
    composed = composeOrderFlowerFeature({ feature: orderFeature, orderFlowerRuntime: f.flowerRuntime, auxiliaryRuntime,
      actionRuntime: { evaluateAdmission: input => auxiliaryRuntime.evaluateAdmission(input) } });
    composedSatin = composeOrderFlowerFeature({ feature: satinFeature, orderFlowerRuntime: f.flowerRuntime, auxiliaryRuntime,
      actionRuntime: { evaluateAdmission: input => auxiliaryRuntime.evaluateAdmission(input) } });
    const registry = createFeatureRegistry();
    for (const module of f.landRuntime.features) registry.register(module);
    for (const module of f.flowerRuntime.features) if (!['order.resident', 'order.satin'].includes(module.featureId)) registry.register(module);
    registry.register(composed); registry.register(composedSatin);

    const day = f.customerGenerationFacts.read(f.active).officialDay;
    const partial = makeObservation(f.active, { sequence: 2, responseRef: 'fixture:normal-enter-reset-partial',
      landState: 1, method: 'usr.heartTick' });
    partial.value = { '105': { '0': { '10': day.startMs - 1, '2': [], '3': null } },
      '7': { '4': { '105': { '2': 0 }, '109': { '2': 0 }, '116': { '2': 0 }, '107': { '2': 0 } } } };
    f.ingestor.ingest(f.active, partial);
    const land = f.landRuntime.ingest({ context: f.active, observation: partial });
    const customer = f.customerReadModel.ingest({ context: f.active, observation: partial });
    f.customerGenerationFacts.ingest({ context: f.active, observation: partial });
    const flowerOrders = f.flowerReadModel.ingest({ context: f.active, observation: partial });
    assert.equal(flowerOrders.accepted, true, JSON.stringify(flowerOrders));
    const customerView = f.customerReadModel.snapshot(f.active), flowerView = f.flowerReadModel.snapshot(f.active);
    const auxiliaryAccepted = f.auxiliaryFacts.ingest({ context: f.active, observation: partial,
      acceptedProjection: land?.accepted === true || customer?.accepted === true || flowerOrders.accepted === true,
      flowerView, customerView });
    assert.equal(auxiliaryAccepted.accepted, true, JSON.stringify(auxiliaryAccepted));
    const auxiliaryView = f.auxiliaryFacts.read(f.active);
    const observed = f.dynamic.observe({ context: f.active, observation: partial, coverage: buildTypedDynamicCoverage(f.active, partial, {
      land, landView: f.landRuntime.dynamicView(f.active), customer, customerView, flowerOrders, flowerView,
      flowerAuxiliary: auxiliaryView, customerDay: f.customerGenerationFacts.read(f.active), officialClock: f.facts.clock(f.active.subjectRef) }) });
    assert.equal(observed.accepted, true, JSON.stringify(observed));
    assert.equal(auxiliaryView.payload.enterState.value.board.resetTime, day.startMs - 1);
    assert.equal(auxiliaryView.payload.enterState.value.board.fieldSources.resetTime.responseRef, partial.responseRef);
    assert.equal(auxiliaryView.payload.rewardState.counters[0].value.raw, 0);

    const enterUnit = composed.scheduleUnits.find(one => one.scheduleKey === 'order.resident:enter');
    const assessment = await enterUnit.assess({ context: f.active, config: configReceipt });
    assert.equal(assessment.state, 'proposals', JSON.stringify({ state: assessment.state, reasonCode: assessment.reasonCode,
      readiness: auxiliaryRuntime.readiness(f.active), enter: auxiliaryView.payload.enterState,
      eligibility: f.flowerEligibility.evaluate({ context: f.active, view: flowerView, clock: f.facts.clock(f.active.subjectRef) }) }));
    const proposal = assessment.proposals[0];
    assert.equal(proposal.method, 'orderFlower.enter');
    assert.deepEqual(proposal.params, {});
    assert.ok(proposal.orderFlowerEnter.currentNeed.claimRef);
    const discarded = await enterUnit.assess({ context: f.active, config: configReceipt });
    assert.equal(discarded.state, 'proposals', JSON.stringify({ state: discarded.state, reasonCode: discarded.reasonCode }));
    assert.equal(discarded.proposals[0].orderFlowerEnter.currentNeed.claimRef, proposal.orderFlowerEnter.currentNeed.claimRef,
      'discarding an unprepared proposal reuses the same source-bound need claim');
    const gateway = createWriteGateway({ store: f.store, ledger: f.ledger, registry,
      supervisor: { executorRef: 'fixture:executor', context: () => f.actor, verificationLease: () => ({ active: false }) },
      readConfiguration: readConfig, authorize: () => true, readFactBasis: input => auxiliaryRuntime.readFactBasis(input),
      evaluateAdmission: input => composed.qualify(input), dynamicState: f.dynamic,
      onSettled: event => auxiliaryRuntime.onSettled(event), onTransportUncertain: ({ proposal }) => {
        f.store.run(`INSERT INTO backend_session_connection_closures VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          `fixture:aux-enter-closed:${proposal.connectionEpoch}`, proposal.ownerRef, String(proposal.accountRef), proposal.subjectRef,
          'fixture:executor', proposal.ownerEpoch, proposal.runEpoch, proposal.connectionEpoch, 'transport-closed',
          JSON.stringify({ closed: true, connectionEpoch: proposal.connectionEpoch, source: 'transport-close-receipt' }), new Date().toISOString());
      },
      postReadLease: { readSnapshotAfterClose: async () => { throw new Error('unused'); },
        validateReadSnapshotLease: () => false, releaseReadSnapshotLease: () => ({ released: true }) } });
    await assert.rejects(gateway.submit(proposal), { code: 'FIXTURE_ANSWER_LOST' });
    assert.equal(f.sendBytes, 1);
    const operation = f.ledger.operation(proposal.operationId);
    assert.equal(operation.method, 'orderFlower.enter');
    assert.equal(operation.business_verdict, 'unknown');
    assert.equal(f.store.get('SELECT consumed FROM backend_send_permits WHERE operation_id=?', proposal.operationId)?.consumed, 1);

    const oldOriginalBytes = operation.original_json, oldFingerprint = operation.original_fingerprint;
    const oldPermit = f.store.get('SELECT consumed,wire_key,request_sequence FROM backend_send_permits WHERE operation_id=?', proposal.operationId);
    f.advanceEpoch(2);
    const nextLogin = f.seedLogin(f.active, 2, 1, observation => {
      observation.value['105']['0']['10'] = day.startMs - 1;
      observation.value['105']['0']['6'] = {};
      observation.value['105']['0']['7'] = {};
      observation.value['7']['9']['sys_orderSatins'] = { '0': 'sys_orderSatins', '6': [] };
      for (const id of [105, 109, 116, 107]) observation.value['7']['4'][String(id)]['2'] = 0;
    });
    assert.equal(f.recordCurrentResourceBaseline(nextLogin).recorded, true);
    const recovered = f.recoverClosedWriteSlots(nextLogin);
    assert.equal(recovered.released.length, 1, JSON.stringify(recovered));
    const satinUnit = composedSatin.scheduleUnits.find(one => one.scheduleKey === 'order.satin:enter');
    const discardedAfterReconcile = await satinUnit.assess({ context: f.active, config: configReceipt });
    assert.equal(discardedAfterReconcile.state, 'proposals', JSON.stringify({ state: discardedAfterReconcile.state,
      reasonCode: discardedAfterReconcile.reasonCode,
      readiness: auxiliaryRuntime.readiness(f.active), eligibility: f.flowerEligibility.evaluate({ context: f.active,
        view: f.flowerReadModel.snapshot(f.active), clock: f.facts.clock(f.active.subjectRef) }) }));
    const resumed = await satinUnit.assess({ context: f.active, config: configReceipt });
    assert.equal(resumed.state, 'proposals', JSON.stringify({ state: resumed.state, reasonCode: resumed.reasonCode }));
    assert.equal(resumed.proposals[0].orderFlowerEnter.currentNeed.claimRef,
      discardedAfterReconcile.proposals[0].orderFlowerEnter.currentNeed.claimRef,
      'discard after reconciliation reuses the same official-source claim');
    const resumedProposal = resumed.proposals[0];
    assert.equal(resumedProposal.featureId, 'order.satin');
    assert.notEqual(resumedProposal.operationId, proposal.operationId);
    assert.equal(resumedProposal.orderFlowerEnter.lifecycleRef, proposal.orderFlowerEnter.lifecycleRef,
      'the same official shared-all opportunity remains the current need');
    await assert.rejects(gateway.submit(resumedProposal), { code: 'FIXTURE_ANSWER_LOST' });
    assert.equal(f.sendBytes, 2, 'fresh independently observed current need can send one new operation');
    const oldAfter = f.ledger.operation(proposal.operationId);
    assert.equal(oldAfter.original_json, oldOriginalBytes);
    assert.equal(oldAfter.original_fingerprint, oldFingerprint);
    assert.equal(oldAfter.business_verdict, 'unknown');
    assert.deepEqual(f.store.get('SELECT consumed,wire_key,request_sequence FROM backend_send_permits WHERE operation_id=?', proposal.operationId), oldPermit);
  } finally { await f.close(); }
});

test('eligible video DTO binds request preparation to the current need and final composed gateway', async () => {
  const f = fixture();
  try {
    const login = f.seedLogin(f.active, 1, 1, observation => {
      observation.value['105']['0']['1']['1'] = { '0': 1, '1': 1, '2': [[23001, 1]], '3': true,
        '4': null, '5': 1_799_999_000_000, '6': 1, '7': { '21068': 1 } };
      observation.value['105']['0']['8'] = { '1': { '0': 0, '1': 1_799_999_000_000, '2': 1_799_999_000_000 } };
      observation.value['105']['0']['9'] = { '1': 0 };
      observation.value['31'] = { '0': { '5': { '0': 77123, '1': 5, '2': 0, '3': 0, '4': 1_800_000_000_000,
        '5': 0, '6': 1_800_000_000_000, '7': 1_800_000_000_000 } } };
      for (const id of [105, 109, 116, 107]) observation.value['7']['4'][String(id)]['2'] = 0;
    });
    f.actor.connection.orderVideoRequestRouting = () => ({ known: true, source: 'official-sdk-effective-ad-route/v1',
      proofRef: 'fixture:official-request-only-route', openAdRewardSdk: { known: true, value: false },
      nativeAbSwitch: { known: true, value: true } });
    const provider = createOrderFlowerVideoRequests({ store: f.store,
      ledgerView: { operation: f.ledger.operation }, isCurrent: f.isCurrent, connectionFor: () => f.actor.connection,
      readGenerationFacts: f.customerGenerationFacts.read });
    const identity = createOrderFlowerIdentity({ store: f.store, isCurrent: f.isCurrent, clock: f.facts.clock });
    const legacyConstraints = { candidateProjection: () => ({ ownerRef: login.context.ownerRef, subjectRef: login.context.subjectRef,
      operations: [], targets: [], resourceFootprints: [], bases: [], semanticMatches: [], matchedTargets: [], declaredTargetMatches: [], matchedResources: [],
      unclassifiedOperations: [] }) };
    const readConfig = context => f.configService.read({ ownerRef: context.ownerRef, accountRef: String(context.accountRef) });
    const orderFeature = f.flowerRuntime.features.find(one => one.featureId === 'order.resident');
    let composed;
    const auxiliaryRuntime = createOrderFlowerAuxiliaryRuntime({ store: f.store, videoRequestProvider: provider,
      readAuxiliaryFacts: f.auxiliaryFacts.read, readView: f.flowerReadModel.snapshot,
      reconcileIdentities: input => identity.reconcile(input),
      readEligibility: ({ context, view, clock }) => f.flowerEligibility.evaluate({ context, view, clock }),
      readGenerationFacts: f.customerGenerationFacts.read, readConfiguration: readConfig, isCurrent: f.isCurrent,
      clock: f.facts.clock, ledgerView: { operation: f.ledger.operation, currentAdmission: f.ledger.currentAdmission },
      isolationEvidence: f.isolationEvidence, validateReadSnapshotLease: () => ({ valid: false, current: false }),
      appendOutbox: event => f.ledger.appendOutbox({ ...event, eventType: event.eventType || event.type,
        eventKey: event.eventKey || 'aux-video-fixture:' + fingerprint(event) }), notify: () => {}, legacyConstraints,
      readCurrentInventory: context => f.landRuntime.dynamicView(context),
      readStockPlanning: context => f.flowerRuntime.planning(context).planning,
      currentNeedFacts: ({ context, method, proposal, config }) => f.dynamic.currentNeedSnapshot({ context,
        feature: composed, config: config?.config || config, method, proposal }) });
    composed = composeOrderFlowerFeature({ feature: orderFeature, orderFlowerRuntime: f.flowerRuntime,
      auxiliaryRuntime, actionRuntime: { evaluateAdmission: input => auxiliaryRuntime.evaluateAdmission(input) } });
    const registry = createFeatureRegistry();
    for (const module of f.landRuntime.features) registry.register(module);
    for (const module of f.flowerRuntime.features) if (module.featureId !== 'order.resident') registry.register(module);
    registry.register(composed);

    const first = await composed.scheduleUnits.find(one => one.scheduleKey === 'order.resident:video').assess({
      context: f.active, config: f.configReceipt });
    assert.equal(first.state, 'waiting-facts', JSON.stringify({ first, ready: auxiliaryRuntime.readiness(f.active) }));
    await new Promise(resolve => setTimeout(resolve, 10));
    const second = await composed.scheduleUnits.find(one => one.scheduleKey === 'order.resident:video').assess({
      context: f.active, config: f.configReceipt });
    assert.equal(second.state, 'proposals', JSON.stringify({ second, ready: auxiliaryRuntime.readiness(f.active),
      view: f.flowerReadModel.snapshot(f.active), auxiliary: f.auxiliaryFacts.read(f.active),
      eligibility: f.flowerEligibility.evaluate({ context: f.active, view: f.flowerReadModel.snapshot(f.active), clock: f.facts.clock(f.active.subjectRef) }),
      planning: f.flowerRuntime.planning(f.active).planning }));
    const proposal = second.proposals[0];
    assert.ok(proposal.orderFlowerVideo.currentNeed.claimRef);
    assert.match(proposal.semanticKey, /:current-need:[a-f0-9]{64}$/);
    assert.equal(provider.validateCapability({ proposal, capability: proposal.orderFlowerVideo.capability,
      phase: 'after-request-preparation' }), true, 'the v1 request receipt remains valid under the exact current-need dispatch key');
    const proofBefore = f.store.get(`SELECT binding_json,binding_fingerprint FROM backend_order_legacy_api_requests WHERE request_ref=?
      UNION ALL SELECT binding_json,binding_fingerprint FROM backend_order_legacy_api_request_attempts WHERE request_ref=? LIMIT 1`,
      proposal.orderFlowerVideo.capability.requestRef, proposal.orderFlowerVideo.capability.requestRef);
    assert.ok(proofBefore);
    const wrongGeneration = structuredClone(proposal);
    wrongGeneration.orderFlowerVideo.currentNeed.decisionGeneration = 'f'.repeat(64);
    wrongGeneration.semanticKey = wrongGeneration.semanticKey.replace(/current-need:[a-f0-9]{64}$/, 'current-need:' + 'f'.repeat(64));
    assert.equal(provider.validateCapability({ proposal: wrongGeneration, capability: wrongGeneration.orderFlowerVideo.capability,
      phase: 'after-request-preparation' }), false, 'a request proof cannot authorize another current-need generation');
    assert.deepEqual(f.store.get(`SELECT binding_json,binding_fingerprint FROM backend_order_legacy_api_requests WHERE request_ref=?
      UNION ALL SELECT binding_json,binding_fingerprint FROM backend_order_legacy_api_request_attempts WHERE request_ref=? LIMIT 1`,
      proposal.orderFlowerVideo.capability.requestRef, proposal.orderFlowerVideo.capability.requestRef), proofBefore,
    'current-need binding leaves the immutable v1 request proof bytes untouched');

    const gateway = createWriteGateway({ store: f.store, ledger: f.ledger, registry,
      supervisor: { executorRef: 'fixture:executor', context: () => f.actor, verificationLease: () => ({ active: false }) },
      readConfiguration: readConfig, authorize: () => true,
      readFactBasis: input => auxiliaryRuntime.readFactBasis(input),
      evaluateAdmission: input => composed.qualify(input), dynamicState: f.dynamic,
      onSettled: event => auxiliaryRuntime.onSettled(event), onTransportUncertain: () => {},
      postReadLease: { readSnapshotAfterClose: async () => { throw new Error('unused'); },
        validateReadSnapshotLease: () => false, releaseReadSnapshotLease: () => ({ released: true }) } });
    await assert.rejects(gateway.submit(wrongGeneration));
    assert.equal(f.sendBytes, 0, 'a mismatched generation cannot cross the composed gateway byte boundary');
    await assert.rejects(gateway.submit(proposal), { code: 'FIXTURE_ANSWER_LOST' });
    assert.equal(f.sendBytes, 1);
    assert.equal(f.ledger.operation(proposal.operationId)?.business_verdict, 'unknown');
    assert.equal(f.store.get('SELECT consumed FROM backend_send_permits WHERE operation_id=?', proposal.operationId)?.consumed, 1);
    assert.equal(provider.validateCapability({ proposal, capability: proposal.orderFlowerVideo.capability,
      phase: 'original-verification' }), true, 'persisted startup/original verification resolves the same claim-version binding');
  } finally { await f.close(); }
});
