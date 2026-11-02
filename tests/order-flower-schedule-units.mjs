import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createBackendLedger } from '../runtime/backend/persistence/ledger.mjs';
import { createOrderFlowerAuxiliaryRuntime } from '../runtime/backend/features/order-flower/auxiliary-runtime.mjs';
import { sameOrderFlowerContext } from '../runtime/backend/features/order-flower/wire-facts.mjs';
import { createConfigService } from '../runtime/backend/config/service.mjs';
import { createScheduler } from '../runtime/backend/scheduler/service.mjs';
import { createDynamicStateCoordinator, FEATURE_DOMAINS } from '../runtime/backend/facts/dynamic-state.mjs';
import { fingerprint } from '../runtime/backend/common.mjs';
import { orderFlowerVideoPolicy } from '../runtime/backend/features/order-flower/video-contract.mjs';
import { assertOrderFlowerRewardProposal } from '../runtime/backend/features/order-flower/reward-contract.mjs';

const context = Object.freeze({ ownerRef: 'fixture:owner', accountRef: 'fixture:account', subjectRef: 'fixture:subject',
  ownerEpoch: 1, runEpoch: 1, connectionEpoch: 1 });
const responseRef = 'fixture:matched-login';
const source = { kind: 'response', responseRef, officialUid: 7654321, connectionEpoch: 1, requestSequence: 1,
  receivedDeviceMs: Date.now(), receivedMonotonicMs: 5000, method: 'index.login', wireKey: 'ws|1|1',
  versionEvidence: { source: 'normal-package-hop-and-matched-world-login/v1', gameVersion: '480.0.27', protocolVersion: '480.0.0', loginResponseRef: responseRef } };
const known = value => ({ known: true, presence: 'present', state: 'known', current: true, value, source });

test('the production auxiliary runtime emits one real stage reward candidate from current typed facts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-order-work-unit-'));
  const store = openBackendStore({ dataDir: root });
  try {
    const backendLedger = createBackendLedger(store);
    store.db.exec(`CREATE TABLE IF NOT EXISTS backend_send_permits(operation_id TEXT PRIMARY KEY,request_sequence INTEGER)`);
    store.db.exec(`CREATE TABLE IF NOT EXISTS backend_legacy_operation_index(operation_ref TEXT,owner_ref TEXT,subject_ref TEXT,method TEXT,semantic_key TEXT,transport_state TEXT)`);
    const uid = source.officialUid, startMs = 1_780_000_000_000, endMs = startMs + 86_400_000;
    const day = { known: true, key: 'fixture-official-day', startMs, endMs, proofRef: 'fixture:day-proof', source: { officialUid: uid, responseRef } };
    const inventory = { version: 'order-aux-current-inventory/v1', bagComplete: true, bagFingerprint: 'a'.repeat(64), context,
      officialUid: uid, source: { ...source }, versionEvidence: source.versionEvidence,
      profile: { level: 1, gold: 0, yb: 0, lvlExp: 0 }, items: {} };
    const counters = [105, 109, 116, 107].map(type => ({ known: true, value: { uid, type, raw: 1000, total: 1000, rTime: startMs + 1, source } }));
    const payload = { inventory: known(inventory), rewardState: { known: true,
      stage: known({ uid, receivedIds: [], resetTime: startMs + 1, source }),
      achievement: { known: false }, ownership: { known: false }, counters } };
    const config = { savedRevision: 7, config: { orders: { resident: { enabled: true } } },
      featureCancelEpochs: { 'order.resident': 0 } };
    const clock = { available: true, source: 'official-anchor-monotonic', connectionEpoch: context.connectionEpoch,
      lowerBoundMs: startMs + 100, upperBoundMs: startMs + 200, nowMs: startMs + 150 };
    const view = { available: true, current: true, context, identity: { verified: true, uid: known(uid), source } };
    const dynamicState = createDynamicStateCoordinator({ store, isCurrent: () => true, notify: () => {},
      deviceNow: () => Date.now(), monotonicNow: () => Number(process.hrtime.bigint()) / 1_000_000 });
    const arrivalMono = Number(process.hrtime.bigint()) / 1_000_000;
    const acceptedLogin = { source: 'response', transport: 'answered', envelopeOk: true, dsName: 'G.ISyncData', rejected: false,
      context, method: 'index.login', connectionEpoch: context.connectionEpoch, requestSequence: source.requestSequence,
      responseRef, wireKey: source.wireKey, receivedDeviceMs: source.receivedDeviceMs, receivedMonotonicMs: arrivalMono,
      value: { '7': { '0': { '0': uid } } }, versionEvidence: source.versionEvidence,
      currentIdentity: { verified: true, responseRef, officialUid: uid } };
    const dynamicSource = { sourceRef: responseRef, method: 'index.login', connectionEpoch: context.connectionEpoch,
      requestSequence: source.requestSequence, observedAtMs: source.receivedDeviceMs, observedMonotonicMs: arrivalMono };
    const semanticValue = { 'order-flower.current-input': true };
    assert.equal(dynamicState.observe({ context, observation: acceptedLogin, coverage: [{ domainId: 'order-flower', complete: true,
      paths: ['order-flower.current-input'], semanticValue, cellSources: { 'order-flower.current-input': dynamicSource },
      semanticFingerprint: fingerprint(semanticValue), observedAtMs: source.receivedDeviceMs }] }).accepted, true);
    const currentProjection = { current: true, identity: { verified: true, uid: known(uid) },
      inventory: { bag: { presence: 'present', state: 'known', complete: true, source, items: {
        '2': { presence: 'present', state: 'known', value: 0, source },
        '21068': { presence: 'present', state: 'known', value: 3, source } } } },
      profile: { gold: { presence: 'present', state: 'known', value: 9, source }, yuanbao: { presence: 'present', state: 'known', value: 2, source },
        lvlExp: { presence: 'present', state: 'known', value: 7, source },
        level: { presence: 'present', state: 'known', value: 1, source } } };
    let auxiliary = { current: true, context, source, payload };
    assert.equal(view.available && view.current && view.identity.verified, true);
    assert.equal(view.identity.uid.current && view.identity.uid.value === uid, true);
    const runtime = createOrderFlowerAuxiliaryRuntime({ store, readAuxiliaryFacts: () => auxiliary,
      readView: () => view,
      reconcileIdentities: () => ({ current: true, identities: [] }), readEligibility: () => ({ current: true, officialUid: uid,
        resident: { known: true, value: true, proofRef: 'fixture:resident-open' } }),
      readGenerationFacts: () => ({ officialDay: day }), readConfiguration: () => config, isCurrent: () => true,
      clock: () => clock, ledgerView: { operation: backendLedger.operation, currentAdmission: () => ({ unresolvedOperations: [], activeOperation: null }) },
      isolationEvidence: { read: () => ({ available: false }) }, validateReadSnapshotLease: () => ({ valid: false, current: false }),
      readCurrentInventory: () => currentProjection,
      currentNeedFacts: ({ context: actual }) => dynamicState.currentNeedSnapshot({ context: actual,
        feature: { featureId: 'order.resident', consumedDomains: ['order-flower'] } }),
      appendOutbox: () => {}, notify: () => {}, legacyConstraints: { candidateProjection: () => ({ ownerRef: context.ownerRef,
        subjectRef: context.subjectRef, operations: [], targets: [], resourceFootprints: [], bases: [], semanticMatches: [], matchedTargets: [], declaredTargetMatches: [],
        matchedResources: [], unclassifiedOperations: [] }) } });
    assert.equal(payload.inventory.value.officialUid, uid);
    assert.equal(source.officialUid, inventory.officialUid);
    assert.equal(source.responseRef, inventory.source.responseRef);
    assert.equal(source.versionEvidence.loginResponseRef, inventory.versionEvidence.loginResponseRef);
    assert.equal(day.source.responseRef, inventory.source.responseRef);
    assert.equal(source.responseRef, responseRef);
    assert.equal(source.connectionEpoch, context.connectionEpoch);
    assert.equal(sameOrderFlowerContext(auxiliary.context, context), true);
    assert.equal(sameOrderFlowerContext(view.context, context), true);
    assert.equal(view.identity.source.responseRef, inventory.source.responseRef);
    assert.deepEqual(['source', 'gameVersion', 'protocolVersion', 'loginResponseRef'].map(key => [
      auxiliary.source.versionEvidence[key], inventory.versionEvidence[key]]), [
      ['normal-package-hop-and-matched-world-login/v1', 'normal-package-hop-and-matched-world-login/v1'], ['480.0.27', '480.0.27'],
      ['480.0.0', '480.0.0'], [responseRef, responseRef]]);
    assert.equal(day.known, true);
    assert.equal(day.source.officialUid, inventory.officialUid);
    assert.equal(known(uid).current, true);
    assert.equal(clock.available, true);
    const result = await runtime.assess('resident', { context }, 'stage-reward');
    assert.equal(result?.state, 'proposals', JSON.stringify(runtime.readiness(context)));
    assert.equal(result.proposals.length, 1, 'only the first currently eligible stage reward is proposed');
    assert.equal(result.proposals[0].method, 'orderFlower.recvOrderRwd');
    assert.equal(result.proposals[0].orderFlowerReward.target, 1);
    assert.equal(result.proposals[0].orderFlowerReward.beforeInventory.version, 'order-aux-current-inventory/v2');
    assert.equal(result.proposals[0].orderFlowerReward.beforeInventory.profile.gold, 9);
    assert.equal(result.proposals[0].orderFlowerReward.beforeInventory.profile.lvlExp, 7,
      'level experience comes from the verified profile cell, not bag item 2');
    assert.equal(result.proposals[0].orderFlowerReward.beforeInventory.rewardSeedQuantity, 3);
    assert.equal(result.proposals[0].orderFlowerReward.currentNeed?.necessary, true,
      'the actual auxiliary producer attaches a current-need claim from the accepted dynamic login source');
    assert.match(result.proposals[0].orderFlowerReward.currentNeed.claimRef, /^current-need-claim:/);
    assert.equal(result.proposals[0].orderFlowerReward.beforeInventory.baseline.fingerprint, inventory.bagFingerprint);
    assert.doesNotThrow(() => assertOrderFlowerRewardProposal(result.proposals[0]), 'the public producer contract accepts the versioned central inventory envelope');
    const admissionInput = { proposal: result.proposals[0], actor: context, factBasis: result.proposals[0].factBasis, boundary: 'before-prepare' };
    assert.equal(runtime.evaluateAdmission(admissionInput).allowed, true, 'the same central source/value envelope passes the real producer admission gate');
    currentProjection.profile.gold.value = 10;
    const changedInventory = runtime.evaluateAdmission(admissionInput);
    assert.equal(changedInventory.allowed, false, 'a changed current absolute profile cell invalidates the prepared auxiliary candidate');
    assert.equal(changedInventory.reasonCode, 'ORDER_AUXILIARY_ORIGINAL_FACTS_CHANGED');
    currentProjection.profile.gold.value = 9;
    const savedLvlExpCell = currentProjection.profile.lvlExp;
    currentProjection.profile.lvlExp = { ...savedLvlExpCell, state: 'unreadable', value: null };
    assert.equal(runtime.readiness(context).current, false, 'missing central profile fields cannot fall back to the login inventory envelope');
    currentProjection.profile.lvlExp = savedLvlExpCell;
    const normalInventorySource = { ...source, method: 'usr.heartTick', responseRef: 'fixture:bag-update', wireKey: 'fixture:bag-update-wire',
      requestSequence: 2, receivedMonotonicMs: 6000, receivedDeviceMs: source.receivedDeviceMs + 1000,
      versionEvidence: { ...source.versionEvidence, loginResponseRef: responseRef } };
    currentProjection.inventory.bag.items['21068'] = { presence: 'present', state: 'known', value: 4, source: normalInventorySource };
    const refreshedCandidate = await runtime.assess('resident', { context }, 'stage-reward');
    assert.equal(refreshedCandidate.proposals[0].orderFlowerReward.beforeInventory.rewardSeedQuantity, 4,
      'the next auxiliary proposal consumes the current centrally projected bag update');
    assert.equal(refreshedCandidate.proposals[0].orderFlowerReward.beforeInventory.baseline.fingerprint, inventory.bagFingerprint,
      'the original complete login baseline remains separately identifiable');
    const repeated = await runtime.assess('resident', { context }, 'stage-reward');
    assert.equal(repeated?.state, 'proposals', 'assessment remains pure; the scheduler/ledger write boundary owns one-time claim serialization');
    assert.equal(repeated.proposals[0].semanticKey, result.proposals[0].semanticKey);

    view.fields = { residentMap: { ...known({ total: 0, entries: [], complete: true }), source } };
    const noVideoCandidate = await runtime.assess('resident', { context }, 'video');
    assert.equal(noVideoCandidate?.refreshDomains, undefined, 'an empty current board does not request optional video facts');
    const videoRow = { presence: 'present', state: 'known', current: true, readable: true, source,
      value: { kind: 'resident', boxId: 1, fields: { npcId: known(1), dialogId: known(1), flowers: known([[1, 1]]),
        isVideo: known(true), cdTime: known(null), cTime: known(startMs + 1), placeIdx: known(1), videoRwd: known({ 1: 1 }) } } };
    view.fields.residentMap = { ...known({ total: 1, entries: [videoRow], complete: true }), source };
    const candidateNeedsShare = await runtime.assess('resident', { context }, 'video');
    assert.deepEqual(candidateNeedsShare.refreshDomains, ['order-flower-video-resident'],
      'a real current video candidate with missing share/open facts requests scoped shared refresh');
    assert.equal(candidateNeedsShare.state, 'waiting-facts');
    const videoPolicy = orderFlowerVideoPolicy('resident');
    payload.videoShares = { 5: known({ uid, shareId: 5, recvCnt: videoPolicy.limit, uTime: startMs + 2, source }) };
    const videoCap = await runtime.assess('resident', { context }, 'video');
    assert.equal(videoCap.state, 'cap-wait', 'verified current official share count is a durable video-unit cap');
    assert.equal(videoCap.suspension.quotaKey, 'order-flower:resident:video');
    assert.equal(videoCap.suspension.actionScope, 'order.resident:video');
    assert.equal(videoCap.suspension.scope, 'official');
    assert.ok(videoCap.suspension.proofRefs.includes(day.proofRef));
    const oldStart = day.startMs, oldEnd = day.endMs, oldKey = day.key, oldNow = clock.nowMs, oldLower = clock.lowerBoundMs, oldUpper = clock.upperBoundMs;
    day.startMs = oldEnd; day.endMs = oldEnd + 86400000; day.key = 'fixture-next-official-day';
    clock.nowMs = oldEnd + 150; clock.lowerBoundMs = oldEnd + 100; clock.upperBoundMs = oldEnd + 200;
    payload.videoShares = { 5: known({ uid, shareId: 5, recvCnt: videoPolicy.limit, uTime: oldStart + 2, source }) };
    const nextDay = await runtime.assess('resident', { context }, 'video');
    assert.notEqual(nextDay?.state, 'cap-wait', 'a new official day does not inherit the prior share count as a cap');
    day.startMs = oldStart; day.endMs = oldEnd; day.key = oldKey;
    clock.nowMs = oldNow; clock.lowerBoundMs = oldLower; clock.upperBoundMs = oldUpper;
    delete payload.videoShares;
    view.fields.residentMap = { ...known({ total: 0, entries: [], complete: true }), source };

    auxiliary = structuredClone(auxiliary);
    auxiliary.payload.rewardState.stage.value.receivedIds = [1, 2, 3, 4];
    const stageComplete = await runtime.assess('resident', { context }, 'stage-reward');
    assert.equal(stageComplete.state, 'cap-wait', 'all four verified current-day stage claims suspend until the official day ends');
    assert.equal(stageComplete.suspension.quotaKey, 'order-flower:resident:stage-reward');
    assert.equal(stageComplete.suspension.periodEndOfficialMs, endMs);

    auxiliary = structuredClone(auxiliary);
    auxiliary.payload.rewardState.achievement = known({ uid, groupId: 9, progress: 20, receivedIndex: 1, source });
    const achievementComplete = await runtime.assess('resident', { context }, 'achievement');
    assert.equal(achievementComplete.state, 'cap-wait', 'a current received achievement is quiet through the official day boundary');
    assert.equal(achievementComplete.suspension.quotaKey, 'order-flower:resident:achievement');

    auxiliary = structuredClone(auxiliary);
    auxiliary.payload.enterState = known({ board: { uid, residents: { 1: { boxId: 1 } }, satin: { boxId: 1 }, decorate: { boxId: 1 },
      receivedIds: [], resetTime: startMs + 1, source }, counters: counters.map(one => one.value), inventory });
    const enterComplete = await runtime.assess('resident', { context }, 'enter');
    assert.equal(enterComplete.state, 'cap-wait', 'a complete board with no open day-reset/missing-order opportunity sleeps until the official day ends');
    assert.equal(enterComplete.suspension.quotaKey, 'order-flower:resident:enter');
    runtime.shutdown();
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('delivery cap stays asleep while a shared fact update enables one production auxiliary claim', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-aux-schedule-integration-'));
  const store = openBackendStore({ dataDir: root });
  const pending = [];
  let nextEventId = 0, scheduler = null, deliveryAssessments = 0, auxiliaryAssessments = 0, videoAssessments = 0, sends = 0;
  const configService = createConfigService({ store, appendOutbox: event => pending.push({ ...event, eventId: ++nextEventId }) });
  const configOwner = { ownerRef: context.ownerRef, accountRef: context.accountRef, subjectRef: context.subjectRef };
  try {
    const backendLedger = createBackendLedger(store);
    store.db.exec(`CREATE TABLE IF NOT EXISTS backend_send_permits(operation_id TEXT PRIMARY KEY,request_sequence INTEGER);
      CREATE TABLE IF NOT EXISTS backend_legacy_operation_index(operation_ref TEXT,owner_ref TEXT,subject_ref TEXT,method TEXT,semantic_key TEXT,transport_state TEXT)`);
    configService.migrate({ ...configOwner, legacyDocument: {} });
    let storedConfig = configService.read(configOwner);
    storedConfig.config.orders.resident.enabled = true;
    storedConfig = configService.save({ ...configOwner, expectedRevision: storedConfig.savedRevision, config: storedConfig.config });
    configService.accept({ ...configOwner, revision: storedConfig.savedRevision, actorRef: 'fixture:scheduler' });
    configService.recordPlan({ ...configOwner, revision: storedConfig.savedRevision, featureId: 'order.resident',
      actionKey: 'order.resident:stage-reward', primaryActionKey: 'order.resident:delivery', state: 'waiting-facts',
      reasonCode: 'ORDER_AUXILIARY_NOT_CURRENT', evidenceRef: 'fixture:aux-before-primary' });
    const pendingPrimary = configService.read(configOwner).byFeature['order.resident'];
    assert.equal(pendingPrimary.state, 'waiting-facts');
    assert.equal(pendingPrimary.reasonCode, 'PRIMARY_ACTION_PENDING', 'an auxiliary plan cannot stand in for an unevaluated primary action');
    const startMs = 1_780_000_000_000, endMs = startMs + 86_400_000;
    const day = { known: true, key: 'fixture-official-day', startMs, endMs, proofRef: 'fixture:day-proof', source: { officialUid: source.officialUid, responseRef } };
    const inventory = { version: 'order-aux-current-inventory/v1', bagComplete: true, bagFingerprint: 'b'.repeat(64), context,
      officialUid: source.officialUid, source: { ...source }, versionEvidence: source.versionEvidence,
      profile: { level: 1, gold: 0, yb: 0, lvlExp: 0 }, items: {} };
    const counters = [105, 109, 116, 107].map(type => ({ known: true, value: { uid: source.officialUid, type, raw: 1000, total: 1000, rTime: startMs + 1, source } }));
    const payload = { inventory: known(inventory), rewardState: { known: true,
      stage: known({ uid: source.officialUid, receivedIds: [], resetTime: startMs + 1, source }),
      achievement: { known: false }, ownership: { known: false }, counters } };
    const clock = { available: true, source: 'official-anchor-monotonic', connectionEpoch: context.connectionEpoch,
      lowerBoundMs: startMs + 100, upperBoundMs: startMs + 200, nowMs: startMs + 150 };
    const view = { available: true, current: true, context, identity: { verified: true, uid: known(source.officialUid), source } };
    const currentProjection = { current: true, identity: { verified: true, uid: known(source.officialUid) },
      inventory: { bag: { presence: 'present', state: 'known', complete: true, source, items: {
        '2': { presence: 'present', state: 'known', value: 0, source } } } },
      profile: { gold: { presence: 'present', state: 'known', value: 0, source }, yuanbao: { presence: 'present', state: 'known', value: 0, source },
        lvlExp: { presence: 'present', state: 'known', value: 0, source },
        level: { presence: 'present', state: 'known', value: 1, source } } };
    let auxiliary = { current: false, context, source, payload };
    const config = () => configService.read(configOwner);
    const runtime = createOrderFlowerAuxiliaryRuntime({ store, readAuxiliaryFacts: () => auxiliary, readView: () => view,
      readCurrentInventory: () => currentProjection,
      reconcileIdentities: () => ({ current: true, identities: [] }), readEligibility: () => ({ current: true, officialUid: source.officialUid,
        resident: { known: true, value: true, proofRef: 'fixture:resident-open' } }),
      readGenerationFacts: () => ({ officialDay: day }), readConfiguration: config, isCurrent: () => true, clock: () => clock,
      ledgerView: { operation: backendLedger.operation, currentAdmission: () => ({ unresolvedOperations: [], activeOperation: null }) },
      isolationEvidence: { read: () => ({ available: false }) }, validateReadSnapshotLease: () => ({ valid: false, current: false }),
      appendOutbox: event => pending.push({ ...event, eventId: ++nextEventId }), notify: () => scheduler?.notify(context),
      legacyConstraints: { candidateProjection: () => ({ ownerRef: context.ownerRef, subjectRef: context.subjectRef, operations: [], targets: [], resourceFootprints: [], bases: [],
        semanticMatches: [], matchedTargets: [], declaredTargetMatches: [], matchedResources: [], unclassifiedOperations: [] }) } });
    const dynamicState = createDynamicStateCoordinator({ store, isCurrent: value => JSON.stringify(value) === JSON.stringify(context),
      appendOutbox: event => pending.push({ ...event, eventId: ++nextEventId }), notify: () => scheduler?.notify(context),
      deviceNow: () => Date.now(), monotonicNow: () => Number(process.hrtime.bigint()) / 1_000_000 });
    const observeOrderFacts = sequence => {
      const arrived = Date.now(), receivedMonotonicMs = Number(process.hrtime.bigint()) / 1_000_000;
      const ref = 'fixture:order-facts:' + sequence;
      const observation = { source: 'response', transport: 'answered', envelopeOk: true, dsName: 'G.ISyncData', rejected: false,
        context, method: sequence === 1 ? 'index.login' : 'usr.heartTick', connectionEpoch: context.connectionEpoch,
        requestSequence: sequence, responseRef: ref, wireKey: sequence === 1 ? `ws|1|${sequence}` : 'fixture:wire:' + sequence,
        ...(sequence === 1 ? { value: { '7': { '0': { '0': 7654321 } } },
          currentIdentity: { verified: true, officialUid: 7654321, responseRef: ref } } : {}),
        receivedDeviceMs: arrived, receivedMonotonicMs };
      const semanticValue = { 'order-flower.value': sequence };
      const sourceCell = { sourceRef: ref, method: observation.method, connectionEpoch: context.connectionEpoch,
        requestSequence: sequence, observedAtMs: arrived, observedMonotonicMs: receivedMonotonicMs };
      return dynamicState.observe({ context, observation, coverage: [{ domainId: 'order-flower', complete: true,
        paths: ['order-flower.value'], semanticValue, cellSources: { 'order-flower.value': sourceCell },
        semanticFingerprint: fingerprint(semanticValue), observedAtMs: arrived }] });
    };
    const firstFacts = observeOrderFacts(1);
    assert.equal(firstFacts.accepted, true);
    const delivery = async input => {
      deliveryAssessments++;
      return { state: 'cap-wait', reasonCode: 'ORDER_FLOWER_DAILY_LIMIT_REACHED', suspension: { kind: 'period-cap',
        quotaKey: 'order-flower:resident', actionScope: 'order.resident:delivery', periodKind: 'official-day',
        periodKey: day.key, periodEndOfficialMs: day.endMs, scope: 'official', used: 1, limit: 1,
        proofRefs: [day.proofRef, 'fixture:counter'], configRevision: input.config.savedRevision } };
    };
    const auxiliaryAssess = async input => {
      auxiliaryAssessments++;
      const result = await runtime.assess('resident', input, 'stage-reward');
      return result || { state: 'waiting-facts', reasonCode: runtime.readiness(context).reasonCode || 'ORDER_AUXILIARY_NOT_CURRENT' };
    };
    const videoAssess = async input => {
      videoAssessments++;
      const result = await runtime.assess('resident', input, 'video');
      return result || { state: 'waiting-facts', reasonCode: runtime.readiness(context).reasonCode || 'ORDER_AUXILIARY_NOT_CURRENT' };
    };
    const parent = { featureId: 'order.resident', primaryActionKey: 'order.resident:delivery', consumedDomains: FEATURE_DOMAINS['order.resident'],
      consumedDomainsFor: () => ['order-flower'], factDomains: ['order-flower'], resourceKinds: [],
      scheduleUnits: [{ scheduleKey: 'order.resident:delivery', quotaKeys: ['order-flower:resident'], assess: delivery },
        { scheduleKey: 'order.resident:stage-reward', assess: auxiliaryAssess },
        { scheduleKey: 'order.resident:video', quotaKeys: ['order-flower:resident'], priority: -1, assess: videoAssess }] };
    const registry = { modules: () => [parent], get: id => id === parent.featureId ? parent : null };
    const ledger = { readPendingOutbox: () => [...pending], ackOutbox: ({ eventId }) => {
      const index = pending.findIndex(event => event.eventId === eventId); if (index >= 0) pending.splice(index, 1);
    } };
    scheduler = createScheduler({ store, ledger, registry, dynamicState,
      readConfiguration: config, acceptConfiguration: (_context, revision) => configService.accept({ ...configOwner,
        revision, actorRef: 'fixture:scheduler' }), recordPlan: (_context, plan) => configService.recordPlan({ ...configOwner, ...plan,
          primaryActionKey: parent.primaryActionKey }),
      facts: { clock: () => clock, snapshot: () => ({}) }, submitProposal: async (_context, proposal) => { sends++; return proposal; },
      isCurrent: value => JSON.stringify(value) === JSON.stringify(context) });
    scheduler.start(context);
    const waitFor = async predicate => {
      const deadline = Date.now() + 1500;
      while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(predicate(), 'condition became true before test deadline');
    };
    await waitFor(() => auxiliaryAssessments >= 1 && store.get("SELECT 1 FROM backend_period_suspensions WHERE feature_id='order.resident:delivery'") !== null);
    assert.equal(deliveryAssessments, 1);
    assert.equal(sends, 0, 'missing auxiliary typed facts do not send or bypass the delivery cap');
    assert.equal(videoAssessments, 0, 'the category quota shared by delivery and video prevents video assessment');
    const parentPlan = configService.read(configOwner).byFeature['order.resident'];
    assert.equal(parentPlan.state, 'cap-wait', 'parent status follows the declared ordinary delivery action');
    assert.equal(parentPlan.actions['order.resident:stage-reward'].state, 'waiting-facts', 'auxiliary action status remains independently visible');

    auxiliary.current = true;
    const update = observeOrderFacts(2);
    assert.equal(update.accepted, true);
    pending.push({ eventId: ++nextEventId, eventType: 'FactsChanged', payload: { domain: 'order-flower', revision: 2 } });
    scheduler.notify(context);
    await waitFor(() => sends === 1);
    assert.equal(deliveryAssessments, 1, 'the stage-reward fact update does not reassess the capped delivery unit');
    assert.equal(sends, 1, 'the real auxiliary runtime produces exactly one stage reward claim');
    assert.equal(videoAssessments, 0, 'shared facts do not wake video while the category quota remains capped');

    auxiliary = structuredClone(auxiliary);
    auxiliary.payload.rewardState.stage.value.receivedIds = [1];
    observeOrderFacts(3);
    pending.push({ eventId: ++nextEventId, eventType: 'FactsChanged', payload: { domain: 'order-flower', revision: 3 } });
    scheduler.notify(context);
    await waitFor(() => pending.length === 0 && auxiliaryAssessments >= 3);
    assert.equal(sends, 1, 'a current receivedIds update leaves the auxiliary unit quiet');
    assert.equal(deliveryAssessments, 1, 'further shared facts do not wake a capped delivery unit');
    assert.equal(videoAssessments, 0, 'further shared facts do not wake a capped video unit');
    assert.equal(store.get("SELECT state FROM backend_feature_wakes WHERE feature_id='order.resident:delivery'").state, 'cap-wait');
  } finally {
    scheduler?.stop(context);
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
