// Offline synthetic protocol fixture; does not represent a live official-server acceptance.
//
// This offline integration fixture uses public production factories (land
// runtime, registry, ledger, SQLite store, official observation ingestion,
// dynamic state, current-isolation evidence and write gateway). Only the
// supervisor's physical close and outer transport are synthetic.
//
// Important: no proposal, land group, lifecycle, ledger verdict, send permit,
// or need claim is fabricated here. In particular, the first unknown is made
// by an actual gateway send whose outer transport consumes its real permit
// and then loses the answer. The land runtime's real onSettled path records
// that unknown into the real group projection.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createBackendLedger } from '../runtime/backend/persistence/ledger.mjs';
import { createOfficialLandCatalog } from '../runtime/backend/features/land/catalog.mjs';
import { createLandRuntime } from '../runtime/backend/features/land/runtime.mjs';
import { buildTypedDynamicCoverage } from '../runtime/backend/facts/typed-coverage.mjs';
import { createDynamicStateCoordinator } from '../runtime/backend/facts/dynamic-state.mjs';
import { createFactService } from '../runtime/backend/facts/service.mjs';
import { createOfficialObservationIngestor } from '../runtime/backend/facts/official-observations.mjs';
import { createFeatureRegistry } from '../runtime/backend/registry/index.mjs';
import { createWriteGateway } from '../runtime/backend/execution/gateway.mjs';
import { createClosedWriteRecovery } from '../runtime/backend/execution/recovery.mjs';
import { createCurrentIsolationEvidence } from '../runtime/backend/migration/current-isolation.mjs';
import { createConfigService } from '../runtime/backend/config/service.mjs';
import { createLegacyConstraints } from '../runtime/backend/migration/legacy-constraints.mjs';
import { createCredentialCipher } from '../runtime/backend/persistence/credential-cipher.mjs';
import { fingerprint } from '../runtime/backend/common.mjs';
import { createOrderFlowerReadModel } from '../runtime/backend/features/order-flower/read-model.mjs';
import { createOfficialOrderFlowerCatalog } from '../runtime/backend/features/order-flower/catalog.mjs';
import { createOrderFlowerEligibility } from '../runtime/backend/features/order-flower/eligibility.mjs';
import { createOrderFlowerRuntime } from '../runtime/backend/features/order-flower/runtime.mjs';
import { createCustomerReadModel } from '../runtime/backend/features/customer/projection.mjs';
import { createCustomerGenerationFacts } from '../runtime/backend/features/customer/generation-facts.mjs';

const VERSION = { gameVersion: '480.0.27', protocolVersion: '480.0.0' };
const BASE = Object.freeze({ ownerRef: 'fixture:owner', accountRef: '1', subjectRef: 'fixture:subject',
  ownerEpoch: 1, runEpoch: 1 });

function makeObservation(context, { sequence, responseRef, landState, water = 8, method = 'usrLand.refresh', plantTime = 1000 }) {
  const landRow = landState === 0 ? { '0': 0, '1': 0 } : { '0': 23001, '1': landState, '2': 1, '3': 0,
    ...(landState === 3 ? { '5': null } : { '5': 0 }), '7': plantTime };
  const value = { '7': { '0': { '0': 77123, '17': 1_700_000_000, '32': { '7': water }, '33': {} },
      '2': sequence > 1 ? { '0': {}, '1': {}, '2': {} } : undefined },
    '100': { '0': { '0': 77123, '1': { '1001': landRow } },
      ...(sequence > 1 ? { '1': { '1001': landRow } } : {}) },
    '101': { '0': { '23001': { '0': 77123, '1': 23001, '2': 1, '4': 2 },
      '23002': { '0': 77123, '1': 23002, '2': 1, '4': 2 } } },
    '2': { '0': { '0': 0, '1': 1_800_000_000_000 + sequence * 1000, '2': 1_800_000_000_000 + sequence * 1000,
      '3': 1_800_000_000_000 + sequence * 1000 }, '3': 1_800_000_000_000 + sequence * 1000,
      '11': {} },
    '105': { '0': { '0': 77123, '1': { '1': { '0': 1, '1': 0, '2': [[23001, 1]], '3': false,
      '4': 1_799_999_000_000, '5': 1_799_999_000_000, '6': 1 } },
      '8': {}, '9': {} } },
    '109': { '0': { '0': 77123, '1': {}, '2': 0, '3': 1_800_000_001_000, '4': 1_800_000_001_000,
      '5': 0, '6': [], '7': true } },
    '7': { ...({ '0': { '0': 77123, '17': 1_700_000_000, '32': { '23001': 1, '7': water }, '33': { '23001': {} },
      '34': 5, '35': 0, '36': 0, '41': 100, '44': 500 },
      '2': sequence > 1 ? { '0': {}, '1': {}, '2': {} } : undefined,
      '4': { '105': { '0': 77123, '1': 105, '2': 0, '3': 0, '4': 1_800_000_001_000, '5': 1_800_000_001_000, '6': 1_800_000_001_000 },
        '107': { '0': 77123, '1': 107, '2': 0, '3': 0, '4': 1_800_000_001_000, '5': 1_800_000_001_000, '6': 1_800_000_001_000 },
        '109': { '0': 77123, '1': 109, '2': 0, '3': 0, '4': 1_800_000_001_000, '5': 1_800_000_001_000, '6': 1_800_000_001_000 },
        '116': { '0': 77123, '1': 116, '2': 0, '3': 0, '4': 1_800_000_001_000, '5': 1_800_000_001_000, '6': 1_800_000_001_000 } },
      '9': {} }) } };
  if (value['7']['2']?.['0'] === undefined) delete value['7']['2'];
  return { source: 'response', transport: 'answered', envelopeOk: true, dsName: 'G.ISyncData', rejected: false,
    context, connectionEpoch: context.connectionEpoch, requestSequence: sequence,
    responseRef, wireKey: `ws|${context.connectionEpoch}|${sequence}`, method,
    receivedDeviceMs: 1_800_000_000_000 + sequence * 1000, sentMonotonicMs: sequence * 1000 - 1,
    receivedMonotonicMs: sequence * 1000, serverMs: 1_800_000_000_000 + sequence * 1000,
    ...(method === 'index.login' ? { currentIdentity: { verified: true, officialUid: 77123, responseRef } } : {}),
    versionEvidence: { source: 'normal-package-hop-and-matched-world-login/v1', ...VERSION,
      loginResponseRef: method === 'index.login' ? responseRef : `fixture:login:${context.connectionEpoch}` }, value };
}

function fixture({ keepWater = 0, plantEnabled = false, harvestEnabled = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'land-current-need-gateway-'));
  const store = openBackendStore({ dataDir });
  const ledger = createBackendLedger(store);
  store.db.exec(`CREATE TABLE backend_accounts(account_id INTEGER PRIMARY KEY,owner_ref TEXT,subject_ref TEXT,profile_json TEXT,server_id INTEGER,verification_ref TEXT,removed_at TEXT);
    CREATE TABLE backend_subject_owners(subject_ref TEXT PRIMARY KEY,owner_ref TEXT,executor_ref TEXT,owner_epoch INTEGER,active INTEGER,isolation_evidence_json TEXT,updated_at TEXT);
    CREATE TABLE backend_run_intents(owner_ref TEXT,account_ref TEXT,subject_ref TEXT,desired_running INTEGER,run_epoch INTEGER,connection_epoch INTEGER,state TEXT,reason_code TEXT,command_id TEXT,retry_at_ms INTEGER,updated_at TEXT,PRIMARY KEY(owner_ref,account_ref));
    CREATE TABLE backend_session_connection_closures(evidence_ref TEXT PRIMARY KEY,owner_ref TEXT,account_ref TEXT,subject_ref TEXT,executor_ref TEXT,owner_epoch INTEGER,run_epoch INTEGER,connection_epoch INTEGER,proof_kind TEXT,proof_json TEXT,recorded_at TEXT);`);
  store.run('INSERT INTO backend_accounts VALUES(?,?,?,?,?, ?,NULL)', 1, BASE.ownerRef, BASE.subjectRef, JSON.stringify({ uid: 77123 }), 1, 'fixture:account-verification');
  store.db.exec(`CREATE TABLE backend_account_official_identities(identity_ref TEXT PRIMARY KEY,owner_ref TEXT,account_ref TEXT,subject_ref TEXT,
      server_id INTEGER,official_uid INTEGER,evidence_ref TEXT,connection_epoch INTEGER,identity_epoch INTEGER,inspection_id TEXT,
      source_method TEXT,profile_uid_before_json TEXT,recorded_at TEXT);
    CREATE TABLE backend_subject_bindings(owner_ref TEXT,account_ref TEXT,subject_ref TEXT,basis TEXT,identity_version TEXT,channel TEXT,evidence_json TEXT,created_at TEXT,
      PRIMARY KEY(owner_ref,account_ref));
    CREATE TABLE backend_executor_isolation(subject_ref TEXT,evidence_ref TEXT,source_ref TEXT,proof_json TEXT,created_at TEXT,
      PRIMARY KEY(subject_ref,evidence_ref));`);
  store.run('INSERT INTO backend_subject_bindings VALUES(?,?,?,?,?,?,?,?)', BASE.ownerRef, BASE.accountRef, BASE.subjectRef,
    'fixture:verified-account', 'fixture:v1', 'official', '{}', new Date().toISOString());
  store.run('INSERT INTO backend_subject_owners VALUES(?,?,?,?,1,?,?)', BASE.subjectRef, BASE.ownerRef, 'fixture:executor', BASE.ownerEpoch, '{}', new Date().toISOString());
  store.run('INSERT INTO backend_run_intents VALUES(?,?,?,1,?,?,\'RUNNING\',NULL,?,NULL,?)', BASE.ownerRef, BASE.accountRef,
    BASE.subjectRef, BASE.runEpoch, 1, 'fixture:start', new Date().toISOString());
  const isCurrent = context => active && sameContext(active, context);
  const sameContext = (a, b) => !!a && !!b && ['ownerRef','accountRef','subjectRef','ownerEpoch','runEpoch','connectionEpoch'].every(k => a[k] === b[k]);
  let active = Object.freeze({ ...BASE, connectionEpoch: 1 });
  let officialMs = 1_800_000_000_000, monotonicMs = 10_000;
  const configService = createConfigService({ store, appendOutbox: event => ledger.appendOutbox(event) });
  configService.migrate({ ownerRef: BASE.ownerRef, accountRef: BASE.accountRef, subjectRef: BASE.subjectRef,
    legacyDocument: JSON.stringify({ land: { waterEnabled: true, keepWater, groupSize: 4 } }) });
  const saved = configService.read({ ownerRef: BASE.ownerRef, accountRef: BASE.accountRef });
  configService.save({ ownerRef: BASE.ownerRef, accountRef: BASE.accountRef, expectedRevision: saved.savedRevision,
    config: { ...saved.config, waterEnabled: true, plantEnabled, harvestEnabled, keepWater, groupSize: 4,
      orders: { ...saved.config.orders, resident: { ...saved.config.orders?.resident, enabled: true, dailyLimit: 0 } } } });
  const savedConfigured = configService.read({ ownerRef: BASE.ownerRef, accountRef: BASE.accountRef });
  const configReceipt = configService.accept({ ownerRef: BASE.ownerRef, accountRef: BASE.accountRef,
    revision: savedConfigured.savedRevision, actorRef: 'fixture:actor' });
  const facts = createFactService({ store, isConnectionCurrent: (subjectRef, epoch) => subjectRef === active.subjectRef && epoch === active.connectionEpoch,
    appendOutbox: event => ledger.appendOutbox({ ownerRef: event.ownerRef, subjectRef: event.subjectRef, eventType: event.type,
      eventKey: `fact:${event.payload.domain}:${event.payload.semanticPath}:${event.payload.factId}`, payload: event.payload }), deviceNow: () => officialMs });
  const ingestor = createOfficialObservationIngestor({ facts, store });

  let landRuntime, dynamic;
  const catalog = createOfficialLandCatalog({ capabilityPolicy: ({ catalogIdentity }) => ({
    supported: catalogIdentity.indexVersion === VERSION.gameVersion,
    reasonCode: catalogIdentity.indexVersion === VERSION.gameVersion ? null : 'LAND_FIXTURE_CATALOG_VERSION',
    versionEvidenceRefs: ['fixture:normal-login-version-binding'] }) });
  const readCurrentLogin = context => currentObservation.get(context.connectionEpoch) || null;
  const isolationEvidence = createCurrentIsolationEvidence({ store, isCurrent: context => sameContext(active, context), readCurrentLogin });
  const legacy = createLegacyConstraints({ store, cipher: createCredentialCipher('00'.repeat(32)) });
  const ledgerView = Object.freeze({ operation: ledger.operation, listOperations: ledger.listOperations,
    currentAdmission: ledger.currentAdmission, recordAdmissionBasis: ledger.recordAdmissionBasis });
  const writeRecovery = createClosedWriteRecovery({ store, ledger, appId: 'fixture.app', isCurrent: isContext => sameContext(active, isContext),
    authorizeCurrent: () => true });
  const currentObservation = new Map();
  const readCurrent = async ({ context, method, after }) => {
    assert.equal(method, 'usrLand.refresh');
    const previous = currentObservation.get(context.connectionEpoch);
    if (previous) return previous;
    const sequence = Math.max(previous?.requestSequence ?? 0, after?.requestSequence ?? 0) + 1;
    const obs = makeObservation(context, { sequence, responseRef: `fixture:read:${context.connectionEpoch}:${sequence}`,
      landState: stateByEpoch.get(context.connectionEpoch) ?? 1, water: 8 });
    ingestor.ingest(context, obs);
    const accepted = landRuntime.ingest({ context, observation: obs });
    dynamic.observe({ context, observation: obs, coverage: coverage(context, obs, accepted) });
    currentObservation.set(context.connectionEpoch, obs);
    return obs;
  };
  const stateByEpoch = new Map([[1, 1], [2, 1]]);
  const capability = { landMapComplete: true, bagComplete: true, itemExtComplete: true };
  const coverage = (context, obs, landAccepted) => {
    return buildTypedDynamicCoverage(context, obs, { land: landAccepted,
      landView: landRuntime.dynamicView(context), officialClock: facts.clock(context.subjectRef) });
  };
  dynamic = createDynamicStateCoordinator({ store, isCurrent, deviceNow: () => officialMs, monotonicNow: () => monotonicMs,
    requestRefresh: async () => {} });
  landRuntime = createLandRuntime({ store, catalog, facts, ledgerView,
    legacyConstraints: Object.freeze({ candidateProjection: legacy.candidateProjection, appendBasis: legacy.appendBasis,
      currentAdmission: legacy.currentAdmission }), isolationEvidence, appendOutbox: event => ledger.appendOutbox(event),
    isCurrent, capabilities: capability, additionalItemRule: null,
    readCurrent: input => readCurrent(input) });

  const customerReadModel = createCustomerReadModel({ store, isCurrent });
  const customerGenerationFacts = createCustomerGenerationFacts({ store, isCurrent, clock: facts.clock,
    readView: customerReadModel.snapshot, verificationLease: () => ({ active: false }) });
  const flowerReadModel = createOrderFlowerReadModel({ store, isCurrent });
  const flowerCatalog = createOfficialOrderFlowerCatalog();
  const flowerEligibility = createOrderFlowerEligibility({ catalog: flowerCatalog, isCurrent, clock: facts.clock });
  const flowerRuntime = createOrderFlowerRuntime({ store, readModel: flowerReadModel, catalog: flowerCatalog,
    resources: landRuntime.resources, ledgerView,
    legacyConstraints: Object.freeze({ candidateProjection: legacy.candidateProjection, appendBasis: legacy.appendBasis,
      currentAdmission: legacy.currentAdmission }), isolationEvidence: Object.freeze({ read: isolationEvidence.read }),
    readLegacyOperation: () => null, isCurrent, clock: facts.clock, readGenerationFacts: customerGenerationFacts.read,
    readCustomerView: customerReadModel.snapshot, validateReadSnapshotLease: () => ({ valid: false, current: false }),
    requestFreshLogin: async () => ({}), appendOutbox: event => ledger.appendOutbox(event), dynamicState: dynamic });

  const registry = createFeatureRegistry();
  for (const module of landRuntime.features) registry.register(module);
  for (const module of flowerRuntime.features) registry.register(module);
  const configRead = actor => configService.read({ ownerRef: actor.ownerRef, accountRef: String(actor.accountRef) });
  const supervisor = {
    executorRef: 'fixture:executor',
    context: () => actor,
    verificationLease: () => ({ active: false }),
  };
  let actor, sendBytes = 0, wireSequence = 0, mode = 'unknown', beforeSendMutation = null;
  const connection = {
    isOpen: () => active.connectionEpoch > 0,
    prepareWrite(method, params) { return { send(permit) {
      const requestSequence = ++wireSequence, wireKey = `fixture-write:${requestSequence}`;
      permit.claim({ method, paramsFingerprint: fingerprintParams(params), connectionEpoch: active.connectionEpoch, wireKey, requestSequence });
      sendBytes++;
      if (mode === 'unknown') return Promise.reject(Object.assign(new Error('fixture answer lost after bytes'), { code: 'FIXTURE_ANSWER_LOST' }));
      return Promise.resolve({ transport: 'answered', method, connectionEpoch: active.connectionEpoch, wireKey,
        requestSequence, responseRef: `fixture:write-reply:${requestSequence}`, receivedDeviceMs: officialMs,
        envelopeOk: true, dsName: 'G.ISyncData', rejected: false,
        value: { '7': { '2': { '0': {}, '1': {}, '2': { '7': 1 } } } } });
    } }; },
    async read(method, args, { after }) {
      assert.equal(method, 'usrLand.refresh');
      const context = active;
      const sequence = Math.max(wireSequence, after.requestSequence) + 1;
      wireSequence = sequence;
      const obs = makeObservation(context, { sequence, responseRef: `fixture:postread:${sequence}`,
        landState: stateByEpoch.get(context.connectionEpoch) ?? 1, water: 7 });
      obs.wireKey = `fixture-read:${sequence}`;
      obs.envelopeOk = true;
      ingestor.ingest(context, obs);
      const accepted = landRuntime.ingest({ context, observation: obs });
      dynamic.observe({ context, observation: obs, coverage: coverage(context, obs, accepted) });
      return obs;
    },
  };
  actor = { ...active, connection, isCurrent: () => isCurrent(active), controller: new AbortController() };
  supervisor.context = () => actor;
  const gatewayOptions = { store, ledger, registry, supervisor, readConfiguration: configRead,
    authorize: () => true, readFactBasis: input => landRuntime.readFactBasis(input),
    evaluateAdmission: input => landRuntime.evaluateAdmission(input), dynamicState: dynamic,
    beforeSend: async input => { if (beforeSendMutation) await beforeSendMutation(input); },
    onSettled: input => landRuntime.onSettled(input), onCurrentVerified: input => landRuntime.onCurrentVerified(input),
    onTransportUncertain: ({ proposal }) => {
      // Only the physical-transport/close boundary is a stub. The bytes were
      // already authorized by the real gateway permit; the old outcome remains
      // unknown and the next connection is explicitly a different epoch.
      store.run(`INSERT INTO backend_session_connection_closures VALUES(?,?,?,?,?,?,?,?,?,?,?)`, `fixture:closed:${proposal.connectionEpoch}`,
        proposal.ownerRef, String(proposal.accountRef), proposal.subjectRef, 'fixture:executor', proposal.ownerEpoch, proposal.runEpoch,
        proposal.connectionEpoch, 'transport-closed', JSON.stringify({ closed: true, connectionEpoch: proposal.connectionEpoch,
          source: 'transport-close-receipt' }), new Date().toISOString());
      connection.isOpen = () => false;
    }, postReadLease: {
      // This test deliberately exercises the real prepare/permit/send path and
      // an uncertain transport outcome. A successful-write verification lease
      // is outside this slice and must never be used by this fixture.
      readSnapshotAfterClose() { throw new Error('unexpected post-read lease use in uncertain-write fixture'); },
      validateReadSnapshotLease() { return false; },
      releaseReadSnapshotLease() { return { released: false }; },
    } };
  const gateway = createWriteGateway(gatewayOptions);
  const flowerGateway = createWriteGateway({ ...gatewayOptions, readFactBasis: input => flowerRuntime.readFactBasis(input),
    evaluateAdmission: input => flowerRuntime.evaluateAdmission(input), onSettled: input => flowerRuntime.onSettled(input),
    onCurrentVerified: input => flowerRuntime.onCurrentVerified(input) });
  // A second real gateway instance models two independent workers sharing the
  // same SQLite ledger/current-need claim rows. No business logic is faked.
  const competingGateway = createWriteGateway(gatewayOptions);
  const seedLogin = (context, epoch, state) => {
    stateByEpoch.set(epoch, state);
    const obs = makeObservation(context, { sequence: 1, responseRef: `fixture:login:${epoch}`,
      landState: state, method: 'index.login', water: 8 });
    obs.value['7']['0']['32'] = { ...obs.value['7']['0']['32'], '7': 8 };
    ingestor.ingest(context, obs);
    const accepted = landRuntime.ingest({ context, observation: obs });
    const customerAccepted = customerReadModel.ingest({ context, observation: obs });
    customerGenerationFacts.ingest({ context, observation: obs });
    const flowerAccepted = flowerReadModel.ingest({ context, observation: obs });
    assert.equal(flowerAccepted.accepted, true, JSON.stringify(flowerAccepted));
    const customerView = customerReadModel.snapshot(context), flowerView = flowerReadModel.snapshot(context);
    flowerEligibility.evaluate({ context, view: flowerView, clock: facts.clock(context.subjectRef) });
    assert.equal(accepted.accepted, true, 'real decoder and land runtime accept the matched login frame');
    store.run(`INSERT INTO backend_account_official_identities VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      `fixture:identity:${epoch}`, BASE.ownerRef, BASE.accountRef, BASE.subjectRef, 1, 77123, obs.responseRef, epoch, 1,
      null, 'index.login', JSON.stringify({ uid: 77123 }), new Date().toISOString());
    const observed = dynamic.observe({ context, observation: obs, coverage: buildTypedDynamicCoverage(context, obs, {
      land: accepted, landView: landRuntime.dynamicView(context), customer: customerAccepted, customerView,
      flowerOrders: flowerAccepted, flowerView, customerDay: customerGenerationFacts.read(context),
      officialClock: facts.clock(context.subjectRef) }) });
    assert.equal(observed.accepted, true, 'real typed dynamic coordinator accepts the login coverage');
    currentObservation.set(epoch, obs);
    return obs;
  };
  return { store, ledger, facts, configService, configReceipt, landRuntime, flowerRuntime, flowerGateway, dynamic, registry, gateway, competingGateway,
    get actor() { return actor; }, get active() { return active; }, get sendBytes() { return sendBytes; }, get mode() { return mode; },
    set mode(value) { mode = value; }, set beforeSendMutation(value) { beforeSendMutation = value; },
    setLandState(epoch, state) { stateByEpoch.set(epoch, state); }, seedLogin,
    updateFlowerCounter(context = active, id = 105, raw = 1) {
      const sequence = (currentObservation.get(context.connectionEpoch)?.requestSequence ?? 1) + 1;
      const obs = makeObservation(context, { sequence, responseRef: `fixture:flower-counter:${context.connectionEpoch}:${sequence}`,
        landState: stateByEpoch.get(context.connectionEpoch) ?? 1, method: 'usr.heartTick' });
      obs.value = { '7': { '4': { [String(id)]: { '2': raw } } } };
      const accepted = flowerReadModel.ingest({ context, observation: obs });
      if (accepted.accepted) {
        const flowerView = flowerReadModel.snapshot(context);
        const observed = dynamic.observe({ context, observation: obs,
          coverage: buildTypedDynamicCoverage(context, obs, { flowerOrders: accepted, flowerView }) });
        if (!observed.accepted) throw new Error('FIXTURE_FLOWER_DYNAMIC_OBSERVE_REJECTED:' + observed.reasonCode);
      }
      return { observation: obs, accepted };
    },
    currentSequence(epoch) { return currentObservation.get(epoch)?.requestSequence ?? 0; },
    recordCurrentResourceBaseline(observation) {
      const result = ledger.recordCurrentResourceBaseline({ context: { ...active }, responseRef: observation.responseRef,
        requestSequence: observation.requestSequence, connectionEpoch: observation.connectionEpoch,
        officialUid: 77123,
        versionEvidence: observation.versionEvidence });
      return result;
    },
    setMonotonic(value) { monotonicMs = value; },
    ingestor,
    async assess(featureId = 'water') {
      const module = landRuntime.features.find(one => one.featureId === featureId);
      return module.assess({ context: active, config: configReceipt });
    },
    async assessFlower() {
      const module = flowerRuntime.features.find(one => one.featureId === 'order.resident');
      const result = await module.assess({ context: active, config: configReceipt });
      return { ...result, debugEligibility: flowerEligibility.evaluate({ context: active, view: flowerReadModel.snapshot(active), clock: facts.clock(active.subjectRef) }),
        debugView: flowerReadModel.snapshot(active), debugDay: customerGenerationFacts.read(active),
        debugPlanning: flowerRuntime.planning(active, configReceipt).planning.entries,
        debugCurrentNeed: dynamic.currentNeedSnapshot({ context: active,
          feature: flowerRuntime.features.find(one => one.featureId === 'order.resident'),
          config: configReceipt.config, method: 'orderFlower.finishOrder' }),
        debugProposalSnapshot: dynamic.snapshot({ context: active,
          feature: flowerRuntime.features.find(one => one.featureId === 'order.resident'), config: configReceipt.config,
          method: 'orderFlower.finishOrder', proposal: { orderFlower: { kind: 'resident', deliveryPath: 'ordinary-ready-order' } } }) };
    },
    advanceEpoch(epoch) {
      active = Object.freeze({ ...BASE, connectionEpoch: epoch });
      store.run('UPDATE backend_run_intents SET connection_epoch=?,updated_at=? WHERE owner_ref=? AND account_ref=?', epoch,
        new Date().toISOString(), BASE.ownerRef, BASE.accountRef);
      connection.isOpen = () => true;
      actor = { ...active, connection, isCurrent: () => isCurrent(active), controller: new AbortController() };
    },
    recoverClosedWriteSlots(observation) {
      return writeRecovery.recoverClosedWriteSlots({ context: active, checkpoint: { observation, factBasis: {
        source: 'fixture:matched-login-checkpoint', responseRef: observation.responseRef,
        requestSequence: observation.requestSequence, connectionEpoch: observation.connectionEpoch } } });
    },
    async close() { dynamic.close?.(); dynamic.shutdown?.(); landRuntime.shutdown?.(); flowerReadModel.shutdown?.();
      customerReadModel.shutdown?.(); facts.shutdown?.(); store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

function fingerprintParams(value) {
  // Gateway uses the shared canonical fingerprint. Importing `fingerprint`
  // from common instead of copying the algorithm is intentional below.
  return fingerprint(value);
}

test('ordinary resident producer creates and submits its own current proposal through the production gateway', async () => {
  const f = fixture();
  try {
    const login = f.seedLogin(f.active, 1, 1);
    const result = await f.assessFlower();
    assert.equal(result.state, 'proposals', JSON.stringify({ state: result.state, reasonCode: result.reasonCode,
      entries: result.debugPlanning?.filter(one => one.kind === 'resident').map(({ state, reasonCode, boxId, requirements }) => ({ state, reasonCode, boxId, requirements })),
      currentNeed: result.debugCurrentNeed,
      domains: result.debugProposalSnapshot?.domains?.map(({ domainId, current, reasonCode, coverage }) => ({ domainId, current, reasonCode, coverage })),
      proposals: result.proposals?.map(one => one.method), eligibility: result.debugEligibility?.resident,
      day: result.debugDay?.officialDay, counter: result.debugView?.counters?.[105] }));
    const proposal = result.proposals[0];
    const currentNeedPaths = (value, prefix = '', depth = 0, output = []) => {
      if (!value || typeof value !== 'object' || depth > 8) return output;
      for (const [key, child] of Object.entries(value)) {
        const next = prefix ? prefix + '.' + key : key;
        if (key === 'currentNeed' && child !== null) output.push(next);
        else currentNeedPaths(child, next, depth + 1, output);
      }
      return output;
    };
    assert.deepEqual(currentNeedPaths(proposal), ['orderFlower.currentNeed']);
    assert.deepEqual(f.registry.get('order.resident').currentNeedContracts, {
      'orderFlower.finishOrder': { path: 'orderFlower.currentNeed', required: true },
    });
    assert.equal(proposal.method, 'orderFlower.finishOrder');
    assert.ok(proposal.orderFlower.currentNeed?.claimRef);
    await assert.rejects(f.flowerGateway.submit(proposal), { code: 'FIXTURE_ANSWER_LOST' });
    const receipt = f.ledger.operation(proposal.operationId);
    assert.equal(receipt.method, 'orderFlower.finishOrder');
    assert.equal(receipt.write_slot, 1);
    assert.equal(receipt.business_verdict, 'unknown');
    assert.equal(f.sendBytes, 1);
    assert.ok(login.responseRef);
  } finally { await f.close(); }
});

test('ordinary resident producer can re-evaluate the same live order after exact close without rewriting the unknown original', async () => {
  const f = fixture();
  try {
    const firstLogin = f.seedLogin(f.active, 1, 1);
    const first = await f.assessFlower();
    assert.equal(first.state, 'proposals');
    const oldProposal = first.proposals[0];
    await assert.rejects(f.flowerGateway.submit(oldProposal), { code: 'FIXTURE_ANSWER_LOST' });
    const before = f.store.get('SELECT original_json,original_fingerprint,business_verdict,write_slot FROM backend_operations WHERE operation_id=?',
      oldProposal.operationId);
    assert.equal(before.business_verdict, 'unknown');
    assert.equal(before.write_slot, 1);

    f.advanceEpoch(2);
    const nextLogin = f.seedLogin(f.active, 2, 1);
    const recovered = f.recoverClosedWriteSlots(nextLogin);
    assert.equal(recovered.released.length, 1);
    const baseline = f.recordCurrentResourceBaseline(nextLogin);
    assert.equal(baseline.recorded, true, JSON.stringify(baseline));
    const next = await f.assessFlower();
    assert.equal(next.state, 'proposals', JSON.stringify({ state: next.state, reasonCode: next.reasonCode,
      planning: next.debugPlanning?.filter(one => one.kind === 'resident').map(({ state, reasonCode }) => ({ state, reasonCode })) }));
    const proposal = next.proposals[0];
    assert.equal(proposal.targets[0].targetRef, oldProposal.targets[0].targetRef);
    assert.notEqual(proposal.operationId, oldProposal.operationId);
    assert.match(proposal.semanticKey, /:current-need:/);
    await assert.rejects(f.flowerGateway.submit(proposal), { code: 'FIXTURE_ANSWER_LOST' });

    const after = f.store.get('SELECT original_json,original_fingerprint,business_verdict,write_slot FROM backend_operations WHERE operation_id=?',
      oldProposal.operationId);
    assert.equal(after.original_json, before.original_json);
    assert.equal(after.original_fingerprint, before.original_fingerprint);
    assert.equal(after.business_verdict, 'unknown');
    assert.equal(after.write_slot, 0);
    assert.equal(f.ledger.operation(proposal.operationId).business_verdict, 'unknown');
    assert.equal(f.sendBytes, 2, 'the new generation uses one independent proposal and one gateway send');
  } finally { await f.close(); }
});

test('normal matched counter response between resident assessment and send invalidates the old proposal', async () => {
  const f = fixture();
  try {
    f.seedLogin(f.active, 1, 1);
    const assessment = await f.assessFlower();
    assert.equal(assessment.state, 'proposals');
    const proposal = assessment.proposals[0];
    f.beforeSendMutation = async () => {
      const update = f.updateFlowerCounter(f.active, 105, 1);
      assert.equal(update.accepted.accepted, true, JSON.stringify(update.accepted));
    };
    await assert.rejects(f.flowerGateway.submit(proposal));
    assert.equal(f.sendBytes, 0, 'the stale resident proposal is fenced before transport bytes');
    assert.equal(f.ledger.operation(proposal.operationId).transport_state, 'not_sent', 'the prepared candidate is durably classified before bytes');
    assert.equal(f.ledger.operation(proposal.operationId).write_slot, 0);
  } finally { await f.close(); }
});

// The historical water outcome is represented by the real group projection's
// unknown marker and does not rewrite the member's prior state.
test('closed old land-water unknown does not own a later independently current need; one claim crosses the real gateway once', async () => {
  const f = fixture();
  try {
    const context1 = f.active;
    f.seedLogin(context1, 1, 1);
    const first = await f.assess();
    assert.equal(first.state, 'proposals', 'real water producer adopts current land and proposes watering');
    const oldProposal = first.proposals[0];
    await assert.rejects(f.gateway.submit(oldProposal), { code: 'FIXTURE_ANSWER_LOST' });
    const old = f.ledger.operation(oldProposal.operationId);
    assert.equal(old.business_verdict, 'unknown');
    assert.equal(old.write_slot, 1, 'unknown keeps the technical slot until exact old-connection closure is admitted');
    assert.equal(old.transport_state, 'unknown');
    const oldGroup = f.landRuntime.publicView({ ownerRef: context1.ownerRef, accountRef: context1.accountRef,
      subjectRef: context1.subjectRef, config: f.configReceipt }).groups.find(group => group.groupRef === oldProposal.land.groupRef);
    assert.ok(oldGroup, 'the old group exists through the real public land projection');
    const uncertainMember = oldGroup.members.find(member => member.memberKey === oldProposal.land.groupMemberKey);
    assert.equal(uncertainMember.currentUnknownOperationId, oldProposal.operationId,
      'water uncertainty is retained as the group current-unknown marker');
    assert.equal(uncertainMember.currentUnknownFeature, 'water');
    assert.equal(uncertainMember.state, 'confirmed',
      'water uncertainty does not rewrite the adopted member state');

    // Physical close receipt is emitted only by the outer supervisor stub.
    f.advanceEpoch(2);
    const context2 = f.active;
    const login2 = f.seedLogin(context2, 2, 1); // same crop/lifecycle and real current state
    const recovered = f.recoverClosedWriteSlots(login2);
    assert.equal(recovered.released.length, 1, 'real recovery service releases only the exact closed old slot');
    assert.equal(f.ledger.operation(oldProposal.operationId).business_verdict, 'unknown', 'historical verdict stays unchanged');
    assert.equal(f.ledger.operation(oldProposal.operationId).write_slot, 0);
    const next = await f.assess();
    assert.equal(next.state, 'proposals', 'a distinct full current login proves watering remains necessary');
    assert.equal(next.proposals.length, 1);
    const proposal = next.proposals[0];
    assert.equal(proposal.operationId === oldProposal.operationId, false, 'the new operation never reuses the old ID');
    assert.equal(proposal.targets[0].targetRef, oldProposal.targets[0].targetRef,
      'the same real land target remains the current need');
    assert.ok(proposal.land.currentNeed, 'current producer must bind the shared claim to the real land need');

    // Both planners may produce candidates from the same complete snapshot.
    // Two independent gateways then compete for the same durable current-need
    // claim; the storage CAS, rather than planner suppression, owns one send.
    const competing = await f.assess();
    assert.equal(competing.state, 'proposals');
    assert.equal(competing.proposals.length, 1);
    let releaseFirst, signalEntered;
    const entered = new Promise(resolve => { signalEntered = resolve; });
    const gate = new Promise(resolve => { releaseFirst = resolve; });
    f.beforeSendMutation = async () => { signalEntered(); await gate; };
    const firstSubmit = f.gateway.submit(proposal);
    await entered;
    await assert.rejects(f.competingGateway.submit(competing.proposals[0]), error =>
      ['WRITE_CURRENT_NEED_CLAIM_REJECTED', 'CURRENT_NEED_CLAIM_ALREADY_CONSUMED', 'LAND_CURRENT_WRITE_IN_FLIGHT'].includes(error.code));
    releaseFirst();
    await assert.rejects(firstSubmit, { code: 'FIXTURE_ANSWER_LOST' });
    const fresh = f.ledger.operation(proposal.operationId);
    assert.equal(fresh.business_verdict, 'unknown');
    assert.equal(fresh.write_slot, 1, 'the new unknown remains fenced until its own exact close is processed');
    assert.equal(f.sendBytes, 2, 'exactly the old unknown and one current operation sent bytes');
  } finally { await f.close(); }
});

test('a real source update between assess and gateway send fences stale land proposals before bytes', async () => {
  const f = fixture();
  try {
    f.seedLogin(f.active, 1, 1);
    const assessment = await f.assess();
    assert.equal(assessment.state, 'proposals');
    const proposal = assessment.proposals[0];
    // This executes after gateway proposal capture and prepare, but before its
    // final permit check. A newer matched land frame says water is no longer
    // needed and passes through the actual decoder/runtime/dynamic-state chain.
    f.beforeSendMutation = async () => {
      f.mode = 'answer';
      const sequence = f.currentSequence(f.active.connectionEpoch) + 1;
      f.setMonotonic(sequence * 1000 + 1000);
      const next = makeObservation(f.active, { sequence, responseRef: 'fixture:land-update:no-water', landState: 3, water: 0 });
      f.ingestor.ingest(f.active, next);
      const accepted = f.landRuntime.ingest({ context: f.active, observation: next });
      assert.equal(accepted.accepted, true, `land projection accepts matched incremental frame: ${JSON.stringify(accepted)}`);
      f.dynamic.observe({ context: f.active, observation: next,
        coverage: buildTypedDynamicCoverage(f.active, next, { land: accepted, landView: f.landRuntime.dynamicView(f.active),
          officialClock: f.facts.clock(f.active.subjectRef) }) });
    };
    await assert.rejects(f.gateway.submit(proposal), error => ['WRITE_DYNAMIC_FACTS_SUPERSEDED', 'LAND_TARGET_NO_LONGER_NEEDS_WATER'].includes(error.code));
    assert.equal(f.sendBytes, 0, 'no transport bytes leave after source currentness changes');
  } finally { await f.close(); }
});

test('same-lifecycle water recovery admits exactly effective balance minus keep, including its own reservation', async () => {
  const f = fixture({ keepWater: 64 });
  try {
    f.seedLogin(f.active, 1, 1);
    const initialBudget = f.landRuntime.publicView({ ownerRef: f.active.ownerRef, accountRef: f.active.accountRef,
      subjectRef: f.active.subjectRef, config: f.configReceipt }).waterBudget;
    assert.equal(initialBudget.known, true, 'the typed water resource rule is independently current');
    assert.equal(initialBudget.effectiveLowerBound, 65);
    assert.equal(initialBudget.available, 1, 'only one effective water remains above keep=64 before any proposal reservation');
    const first = await f.assess();
    assert.equal(first.state, 'proposals');
    const oldProposal = first.proposals[0];
    await assert.rejects(f.gateway.submit(oldProposal), { code: 'FIXTURE_ANSWER_LOST' });
    const oldRowBefore = f.store.get(`SELECT original_json,original_fingerprint,business_verdict,write_slot FROM backend_operations WHERE operation_id=?`, oldProposal.operationId);
    const permitBefore = f.store.get(`SELECT method,params_fingerprint,consumed,wire_key,request_sequence FROM backend_send_permits WHERE operation_id=?`, oldProposal.operationId);
    const resourcesBefore = f.store.all(`SELECT resource_key,resource_kind,resource_ref,quantity,basis_ref,accounting_ref,state,original_json
      FROM backend_operation_resources WHERE operation_id=? ORDER BY resource_key`, oldProposal.operationId);
    const assertOldEvidenceUnchanged = () => {
      const oldRowAfter = f.store.get(`SELECT original_json,original_fingerprint,business_verdict,write_slot FROM backend_operations WHERE operation_id=?`, oldProposal.operationId);
      assert.equal(oldRowAfter.original_json, oldRowBefore.original_json, 'the byte-exact original JSON remains untouched after close/rebaseline and the next operation');
      assert.equal(oldRowAfter.original_fingerprint, oldRowBefore.original_fingerprint);
      assert.equal(oldRowAfter.business_verdict, oldRowBefore.business_verdict, 'the historical unknown verdict is never rewritten');
      assert.equal(oldRowAfter.write_slot, 0, 'only the derived technical slot is released');
      assert.deepEqual(f.store.get(`SELECT method,params_fingerprint,consumed,wire_key,request_sequence FROM backend_send_permits WHERE operation_id=?`, oldProposal.operationId), permitBefore,
        'the original consumed wire permit and sequence remain immutable evidence');
      assert.deepEqual(f.store.all(`SELECT resource_key,resource_kind,resource_ref,quantity,basis_ref,accounting_ref,state,original_json
        FROM backend_operation_resources WHERE operation_id=? ORDER BY resource_key`, oldProposal.operationId), resourcesBefore,
      'the original resource footprint is preserved byte-for-byte; only separate baseline links alter current accounting');
    };
    assert.equal(oldRowBefore.business_verdict, 'unknown');
    assert.equal(permitBefore.consumed, 1);
    assert.ok(permitBefore.wire_key && permitBefore.request_sequence > 0);

    f.advanceEpoch(2);
    const login = f.seedLogin(f.active, 2, 1);
    assert.equal(f.recoverClosedWriteSlots(login).released.length, 1);
    const baseline = f.recordCurrentResourceBaseline(login);
    assert.equal(baseline.recorded, true, `formal current absolute-resource baseline links the exact closed footprint: ${JSON.stringify(baseline)}`);
    const recoveredBudget = f.landRuntime.publicView({ ownerRef: f.active.ownerRef, accountRef: f.active.accountRef,
      subjectRef: f.active.subjectRef, config: f.configReceipt }).waterBudget;
    assert.equal(recoveredBudget.available, 1, JSON.stringify(recoveredBudget));
    const next = await f.assess();
    assert.equal(next.state, 'proposals', JSON.stringify(next));
    await assert.rejects(f.gateway.submit(next.proposals[0]), { code: 'FIXTURE_ANSWER_LOST' });
    assertOldEvidenceUnchanged();
    assert.equal(f.sendBytes, 2, 'the current proposal reservation is not subtracted twice at its own send fence');
  } finally { await f.close(); }
});

test('an unknown plant result is retained while a new current occupied-land fact drives water assessment', async () => {
  const f = fixture({ plantEnabled: true });
  try {
    f.seedLogin(f.active, 1, 0);
    const planting = await f.assess('plant');
    assert.equal(planting.state, 'proposals', JSON.stringify(planting));
    const oldProposal = planting.proposals[0];
    await assert.rejects(f.gateway.submit(oldProposal), { code: 'FIXTURE_ANSWER_LOST' });
    const before = f.store.get('SELECT original_json,original_fingerprint,business_verdict FROM backend_operations WHERE operation_id=?', oldProposal.operationId);
    assert.equal(before.business_verdict, 'unknown');

    f.advanceEpoch(2);
    const login = f.seedLogin(f.active, 2, 1);
    assert.equal(f.recoverClosedWriteSlots(login).released.length, 1);
    const current = await f.assess('water');
    assert.equal(current.state, 'proposals', JSON.stringify(current));
    assert.equal(current.proposals[0].featureId, 'water');
    await assert.rejects(f.gateway.submit(current.proposals[0]), { code: 'FIXTURE_ANSWER_LOST' });
    const after = f.store.get('SELECT original_json,original_fingerprint,business_verdict FROM backend_operations WHERE operation_id=?', oldProposal.operationId);
    assert.deepEqual(after, before, 'plant history remains byte-identical unknown evidence while new land facts control water eligibility');
    assert.equal(f.sendBytes, 2, 'the new water need crosses the real gateway after the independent current occupied-land login');
  } finally { await f.close(); }
});

test('a closed unknown harvest does not make the same currently mature crop permanently ineligible', async () => {
  const f = fixture({ harvestEnabled: true });
  try {
    f.seedLogin(f.active, 1, 3);
    const harvest = await f.assess('harvest');
    assert.equal(harvest.state, 'proposals', JSON.stringify(harvest));
    const original = harvest.proposals[0];
    await assert.rejects(f.gateway.submit(original), { code: 'FIXTURE_ANSWER_LOST' });
    const historyBefore = f.store.get(`SELECT original_json,original_fingerprint,business_verdict FROM backend_operations WHERE operation_id=?`, original.operationId);
    assert.equal(historyBefore.business_verdict, 'unknown');

    f.advanceEpoch(2);
    const login = f.seedLogin(f.active, 2, 3);
    assert.equal(f.recoverClosedWriteSlots(login).released.length, 1);
    const current = await f.assess('harvest');
    assert.equal(current.state, 'proposals', JSON.stringify(current));
    assert.equal(current.proposals[0].featureId, 'harvest');
    assert.equal(current.proposals[0].targets[0].targetRef, original.targets[0].targetRef);
    assert.notEqual(current.proposals[0].operationId, original.operationId);
    await assert.rejects(f.gateway.submit(current.proposals[0]), { code: 'FIXTURE_ANSWER_LOST' });
    assert.deepEqual(f.store.get(`SELECT original_json,original_fingerprint,business_verdict FROM backend_operations WHERE operation_id=?`, original.operationId),
      historyBefore, 'same-stage historical harvest unknown remains immutable while fresh mature state remains actionable');
    assert.equal(f.sendBytes, 2, 'the current mature-stage need crosses the gateway under a new operation ID');
  } finally { await f.close(); }
});

test('STOP/CANCEL at the final gateway boundary sends zero bytes for a genuine assessed proposal', async () => {
  const f = fixture();
  try {
    f.seedLogin(f.active, 1, 1);
    const assessment = await f.assess();
    assert.equal(assessment.state, 'proposals');
    const proposal = assessment.proposals[0];
    const controller = new AbortController();
    controller.abort(Object.assign(new Error('fixture STOP before dispatch'), { code: 'FIXTURE_STOP' }));
    await assert.rejects(f.gateway.submit(proposal, controller.signal));
    assert.equal(f.sendBytes, 0);
  } finally { await f.close(); }
});


