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
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createBackendLedger } from '../runtime/backend/persistence/ledger.mjs';
import { createOfficialLandCatalogRegistry } from '../runtime/backend/features/land/catalog.mjs';
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
import { createOrderFlowerAuxiliaryFacts } from '../runtime/backend/features/order-flower/auxiliary-facts.mjs';
import { canonical } from '../runtime/backend/common.mjs';
import { createCustomerIdentity } from '../runtime/backend/features/customer/identity.mjs';
import { createCustomerAcceptance } from '../runtime/backend/features/customer/acceptance.mjs';
import { createCustomerAllocation } from '../runtime/backend/features/customer/allocation.mjs';
import { createCustomerRuntime } from '../runtime/backend/features/customer/runtime.mjs';
import { createOfficialCustomerCatalog } from '../runtime/backend/features/customer/catalog.mjs';
import { createOfficialArtCatalog } from '../runtime/backend/features/art/catalog.mjs';
import { createArtRuntime } from '../runtime/backend/features/art/runtime.mjs';

export const VERSION = { gameVersion: '480.0.27', protocolVersion: '480.0.0' };
export const BASE = Object.freeze({ ownerRef: 'fixture:owner', accountRef: '1', subjectRef: 'a'.repeat(64),
  ownerEpoch: 1, runEpoch: 1 });

export function makeObservation(context, { sequence, responseRef, landState, water = 8, method = 'usrLand.refresh', plantTime = 1000 }) {
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
      '4': 1_799_999_000_000, '5': 1_799_999_000_000, '6': 1 } }, '2': [], '3': null, '10': 1_800_000_000_000,
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

export function fixture({ keepWater = 0, plantEnabled = false, harvestEnabled = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'land-current-need-gateway-'));
  const store = openBackendStore({ dataDir });
  const ledger = createBackendLedger(store);
  store.db.exec(`CREATE TABLE backend_accounts(account_id INTEGER PRIMARY KEY,owner_ref TEXT,subject_ref TEXT,profile_json TEXT,server_id INTEGER,verification_ref TEXT,removed_at TEXT);
    CREATE TABLE backend_subject_owners(subject_ref TEXT PRIMARY KEY,owner_ref TEXT,executor_ref TEXT,owner_epoch INTEGER,active INTEGER,isolation_evidence_json TEXT,updated_at TEXT);
    CREATE TABLE backend_run_intents(owner_ref TEXT,account_ref TEXT,subject_ref TEXT,desired_running INTEGER,run_epoch INTEGER,connection_epoch INTEGER,state TEXT,reason_code TEXT,command_id TEXT,retry_at_ms INTEGER,updated_at TEXT,PRIMARY KEY(owner_ref,account_ref));
    CREATE TABLE backend_session_connection_closures(evidence_ref TEXT PRIMARY KEY,owner_ref TEXT,account_ref TEXT,subject_ref TEXT,executor_ref TEXT,owner_epoch INTEGER,run_epoch INTEGER,connection_epoch INTEGER,proof_kind TEXT,proof_json TEXT,recorded_at TEXT);
    CREATE TABLE backend_migration_pairings(pairing_ref TEXT PRIMARY KEY,target_owner_ref TEXT NOT NULL,source_owner_ref TEXT NOT NULL,
      descriptor_json TEXT NOT NULL,source_authentication_json TEXT NOT NULL,target_authentication_ref TEXT NOT NULL,created_at TEXT NOT NULL);`);
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
  const catalogRegistry = createOfficialLandCatalogRegistry({ capabilityPolicy: ({ catalogIdentity }) => ({
    supported: catalogIdentity.indexVersion === VERSION.gameVersion,
    reasonCode: catalogIdentity.indexVersion === VERSION.gameVersion ? null : 'LAND_FIXTURE_CATALOG_VERSION',
    versionEvidenceRefs: ['fixture:normal-login-version-binding'] }) });
  const catalog = catalogRegistry.resolve(VERSION.gameVersion, VERSION.protocolVersion);
  const customerItemCatalog = createOfficialCustomerCatalog({ landCatalog: catalog });
  const readCurrentLogin = context => currentObservation.get(context.connectionEpoch) || null;
  const isolationCipher = createCredentialCipher('00'.repeat(32));
  const readLegacyConstraint = input => {
    const archive = store.get(`SELECT source_row_fingerprint,source_primary_key_json,original_row_ciphertext FROM backend_legacy_archives
      WHERE archive_id=? AND transfer_id=? AND target_owner_ref=? AND target_account_ref=? AND target_subject_ref=? AND source_table=?`,
    input.archiveId, input.transferId, input.ownerRef, String(input.accountRef), input.subjectRef, input.sourceTable);
    if (!archive || archive.source_row_fingerprint !== input.expectedFingerprint ||
        canonical(JSON.parse(archive.source_primary_key_json)) !== canonical(input.expectedPrimaryKey)) return null;
    return JSON.parse(isolationCipher.decrypt(archive.original_row_ciphertext));
  };
  const isolationEvidence = createCurrentIsolationEvidence({ store, isCurrent: context => sameContext(active, context), readCurrentLogin, readLegacyConstraint });
  const legacy = createLegacyConstraints({ store, cipher: isolationCipher });
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
  landRuntime = createLandRuntime({ store, catalog, catalogRegistry, facts, ledgerView,
    legacyConstraints: Object.freeze({ candidateProjection: legacy.candidateProjection, appendBasis: legacy.appendBasis,
      currentAdmission: legacy.currentAdmission }), isolationEvidence, appendOutbox: event => ledger.appendOutbox(event),
    isCurrent, capabilities: capability, additionalItemRule: customerItemCatalog.itemRule,
    readCurrent: input => readCurrent(input) });

  const customerReadModel = createCustomerReadModel({ store, isCurrent });
  const customerGenerationFacts = createCustomerGenerationFacts({ store, isCurrent, clock: facts.clock,
    readView: customerReadModel.snapshot, verificationLease: () => ({ active: false }) });
  const flowerReadModel = createOrderFlowerReadModel({ store, isCurrent });
  const auxiliaryFacts = createOrderFlowerAuxiliaryFacts({ store, isCurrent });
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
  let customerRuntime = null, customerIdentity = null, customerConfigReceipt = null, artRuntime = null;
  const customerGateway = createWriteGateway({ ...gatewayOptions,
    readFactBasis: input => customerRuntime.readFactBasis(input),
    evaluateAdmission: input => customerRuntime.evaluateAdmission(input),
    onSettled: input => customerRuntime.onSettled(input),
    onCurrentVerified: input => customerRuntime.onCurrentVerified(input) });
  const gateway = createWriteGateway(gatewayOptions);
  const flowerGateway = createWriteGateway({ ...gatewayOptions, readFactBasis: input => flowerRuntime.readFactBasis(input),
    evaluateAdmission: input => flowerRuntime.evaluateAdmission(input), onSettled: input => flowerRuntime.onSettled(input),
    onCurrentVerified: input => flowerRuntime.onCurrentVerified(input) });
  // A second real gateway instance models two independent workers sharing the
  // same SQLite ledger/current-need claim rows. No business logic is faked.
  const competingGateway = createWriteGateway(gatewayOptions);
  const seedLogin = (context, epoch, state, mutate = null) => {
    stateByEpoch.set(epoch, state);
    const obs = makeObservation(context, { sequence: 1, responseRef: `fixture:login:${epoch}`,
      landState: state, method: 'index.login', water: 8 });
    if (typeof mutate === 'function') mutate(obs);
    obs.value['7']['0']['32'] = { ...obs.value['7']['0']['32'], '7': 8 };
    ingestor.ingest(context, obs);
    const accepted = landRuntime.ingest({ context, observation: obs });
    const customerAccepted = customerReadModel.ingest({ context, observation: obs });
    if (customerIdentity) customerIdentity.reconcile({ context, view: customerReadModel.snapshot(context) });
    customerGenerationFacts.ingest({ context, observation: obs });
    const flowerAccepted = flowerReadModel.ingest({ context, observation: obs });
    assert.equal(flowerAccepted.accepted, true, JSON.stringify(flowerAccepted));
    const customerView = customerReadModel.snapshot(context), flowerView = flowerReadModel.snapshot(context);
    const auxiliaryAccepted = auxiliaryFacts.ingest({ context, observation: obs, acceptedProjection: true, flowerView, customerView });
    assert.equal(auxiliaryAccepted.accepted, true, JSON.stringify(auxiliaryAccepted));
    flowerEligibility.evaluate({ context, view: flowerView, clock: facts.clock(context.subjectRef) });
    assert.equal(accepted.accepted, true, 'real decoder and land runtime accept the matched login frame');
    store.run(`INSERT INTO backend_account_official_identities VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      `fixture:identity:${epoch}`, BASE.ownerRef, BASE.accountRef, BASE.subjectRef, 1, 77123, obs.responseRef, epoch, 1,
      null, 'index.login', JSON.stringify({ uid: 77123 }), new Date().toISOString());
    const typedCoverage = buildTypedDynamicCoverage(context, obs, {
      land: accepted, landView: landRuntime.dynamicView(context), customer: customerAccepted, customerView,
      flowerOrders: flowerAccepted, flowerView, customerDay: customerGenerationFacts.read(context),
      flowerAuxiliary: auxiliaryFacts.read(context),
      officialClock: facts.clock(context.subjectRef) });
    const invalidTypedCells = typedCoverage.flatMap(entry => entry.paths.filter(path => {
      const source = entry.cellSources?.[path];
      return !source || !Number.isSafeInteger(source.observedAtMs) || !Number.isFinite(source.observedMonotonicMs);
    }).map(path => ({ domainId: entry.domainId, path, source: entry.cellSources?.[path] })));
    assert.deepEqual(invalidTypedCells, [], 'typed coverage must carry per-cell source times: ' + JSON.stringify(invalidTypedCells));
    const observed = dynamic.observe({ context, observation: obs, coverage: typedCoverage });
    assert.equal(observed.accepted, true, 'real typed dynamic coordinator accepts the login coverage');
    currentObservation.set(epoch, obs);
    return obs;
  };
  return { store, ledger, facts, configService, configReceipt, landRuntime, catalogRegistry, flowerRuntime, flowerReadModel, customerReadModel,
    customerGenerationFacts, auxiliaryFacts, isCurrent, flowerEligibility, flowerCatalog, flowerGateway, dynamic, registry, gateway, competingGateway,
    isolationEvidence, legacy, isolationCipher, customerGateway,
    installCustomerRuntime() {
      if (customerRuntime) return { runtime: customerRuntime, config: customerConfigReceipt };
      const current = configService.read({ ownerRef: BASE.ownerRef, accountRef: BASE.accountRef });
      configService.save({ ownerRef: BASE.ownerRef, accountRef: BASE.accountRef, expectedRevision: current.savedRevision,
        config: { ...current.config, orders: { ...current.config.orders, customer: { ...current.config.orders.customer,
          enabled: true, coinTiers: [1], autoReject: false } } } });
      const saved = configService.read({ ownerRef: BASE.ownerRef, accountRef: BASE.accountRef });
      customerConfigReceipt = configService.accept({ ownerRef: BASE.ownerRef, accountRef: BASE.accountRef,
        revision: saved.savedRevision, actorRef: 'fixture:customer-actor' });
      customerIdentity = createCustomerIdentity({ store, isCurrent });
      const catalogForCustomer = customerItemCatalog;
      const acceptance = createCustomerAcceptance({ catalog: catalogForCustomer, isCurrent });
      const allocation = createCustomerAllocation({ resources: landRuntime.resources, isCurrent });
      customerRuntime = createCustomerRuntime({ store, readModel: customerReadModel, identity: customerIdentity, acceptance,
        allocation, resources: landRuntime.resources, catalog: catalogForCustomer, ledgerView,
        legacyConstraints: Object.freeze({ candidateProjection: legacy.candidateProjection, appendBasis: legacy.appendBasis,
          currentAdmission: legacy.currentAdmission }), isolationEvidence: Object.freeze({ read: isolationEvidence.read }),
        isCurrent, clock: facts.clock, validateReadSnapshotLease: () => ({ valid: false, current: false }),
        readProfile: landRuntime.artSourceFacts, readGenerationFacts: customerGenerationFacts.read,
        requestFreshLogin: async () => ({}), appendOutbox: event => ledger.appendOutbox(event), dynamicState: dynamic,
        currentNeedFacts: input => dynamic.currentNeedSnapshot({ ...input, feature: customerRuntime?.feature }) });
      registry.register(customerRuntime.feature);
      return { runtime: customerRuntime, config: customerConfigReceipt };
    },
    installArtRuntime() {
      if (!customerRuntime) this.installCustomerRuntime();
      if (artRuntime) return artRuntime;
      artRuntime = createArtRuntime({ store, catalog: createOfficialArtCatalog({ customerCatalog: customerItemCatalog, landCatalog: catalog }),
        resources: landRuntime.resources, readView: customerReadModel.snapshot, readProfile: landRuntime.artSourceFacts,
        customerPlanning: customerRuntime.planning, ledgerView,
        legacyConstraints: Object.freeze({ candidateProjection: legacy.candidateProjection, appendBasis: legacy.appendBasis,
          currentAdmission: legacy.currentAdmission }), isolationEvidence: Object.freeze({ read: isolationEvidence.read }),
        isCurrent, clock: facts.clock, validateReadSnapshotLease: () => ({ valid: false, current: false }),
        appendOutbox: event => ledger.appendOutbox(event), dynamicState: dynamic,
        currentNeedFacts: input => dynamic.currentNeedSnapshot({ ...input, feature: artRuntime?.feature }) });
      registry.register(artRuntime.feature);
      return artRuntime;
    },
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
    currentContext: () => active,
    async close() { dynamic.close?.(); dynamic.shutdown?.(); landRuntime.shutdown?.(); flowerReadModel.shutdown?.(); customerIdentity?.shutdown?.();
      customerReadModel.shutdown?.(); facts.shutdown?.(); store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

function fingerprintParams(value) {
  // Gateway uses the shared canonical fingerprint. Importing `fingerprint`
  // from common instead of copying the algorithm is intentional below.
  return fingerprint(value);
}
