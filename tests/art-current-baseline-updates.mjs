import test from 'node:test';
import assert from 'node:assert/strict';
import { currentAbsoluteSourceAfterBaseline } from '../runtime/backend/features/art/runtime.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createBackendLedger } from '../runtime/backend/persistence/ledger.mjs';
import { createTechnicalHoldReviews } from '../runtime/backend/features/art/technical-hold-review.mjs';
import { createCustomerArtBatchRuntime } from '../runtime/backend/features/art/customer-batch-runtime.mjs';
import { createArtFirstRewardRuntime } from '../runtime/backend/features/art/first-reward-runtime.mjs';
import { createWriteGateway } from '../runtime/backend/execution/gateway.mjs';
import { createFeatureRegistry } from '../runtime/backend/registry/index.mjs';
import { createDynamicStateCoordinator } from '../runtime/backend/facts/dynamic-state.mjs';
import { fingerprint } from '../runtime/backend/common.mjs';

const context = { connectionEpoch: 8 };
const login = { kind: 'response', method: 'index.login', responseRef: 'login-8', wireKey: 'w-login',
  requestSequence: 2, connectionEpoch: 8 };
const baseline = { known: true, source: login };

test('art current facts may use accepted post-login absolute updates without losing the complete baseline', () => {
  const matchedBagUpdate = { kind: 'response', method: 'orderCustomer.finishOrder', responseRef: 'finish-9', wireKey: 'w-finish',
    requestSequence: 9, connectionEpoch: 8 };
  assert.equal(currentAbsoluteSourceAfterBaseline(baseline, matchedBagUpdate, context), true);
});

test('art current facts still reject wrong-epoch, pre-baseline, and non-response provenance', () => {
  assert.equal(currentAbsoluteSourceAfterBaseline(baseline, { ...login, requestSequence: 1 }, context), false);
  assert.equal(currentAbsoluteSourceAfterBaseline(baseline, { ...login, connectionEpoch: 9 }, context), false);
  assert.equal(currentAbsoluteSourceAfterBaseline(baseline, { ...login, kind: 'push' }, context), false);
  assert.equal(currentAbsoluteSourceAfterBaseline({ known: false, source: login }, login, context), false);
});

function holdFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-hold-review-'));
  const store = openBackendStore({ dataDir: dir });
  const ledger = createBackendLedger(store);
  store.db.exec(`CREATE TABLE backend_art_technical_holds(owner_ref TEXT,subject_ref TEXT,feature_id TEXT,
    implementation_version TEXT,reason_code TEXT,operation_id TEXT,created_at TEXT,
    PRIMARY KEY(owner_ref,subject_ref,feature_id,implementation_version))`);
  const key = { ownerRef: 'owner', subjectRef: 'subject', accountRef: '1', ownerEpoch: 1, runEpoch: 2, connectionEpoch: 3,
    featureId: 'art.first-album', implementationVersion: 'probe/v1' };
  let clock = Date.now();
  const holdAt = new Date(clock - 3_600_000).toISOString();
  const hold = (featureId = key.featureId, version = key.implementationVersion) => store.run(
    'INSERT INTO backend_art_technical_holds VALUES(?,?,?,?,?,?,?)', key.ownerRef, key.subjectRef, featureId, version,
    'VERIFICATION_OPERATION_CONTRACT_INVALID', 'old-failure', holdAt);
  const reviews = () => createTechnicalHoldReviews({ store, now: () => clock });
  const prepare = (operationId, overrides = {}) => {
    const input = { ...key, ...overrides, operationId, proposalId: operationId + ':proposal', executorRef: 'executor',
      scope: 'vase-album-recv', method: 'collectRwd.recvArtCreateRwdByVase', semanticKey: operationId,
      paramsFingerprint: 'params', configRevision: 1, cancelEpoch: 0, factBasis: { synthetic: true },
      targets: [{ memberKey: 'member', targetKind: 'vase', targetRef: operationId + ':target', lifecycleRef: 'life', targetFingerprint: 'target' }],
      resources: [], resourceBindings: [] };
    ledger.prepareOperation(input);
    return input;
  };
  return { store, ledger, key, hold, reviews, prepare, tick: value => { clock += value; }, holdAt,
    close: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('technical review claims are operation-bound, reentrant, and durable not-sent closes only that review', () => {
  const f = holdFixture();
  try {
    f.hold(); const manager = f.reviews(), proposal = f.prepare('probe-one'), key = { ...f.key, operationId: proposal.operationId };
    assert.equal(manager.state(key).probeAllowed, true);
    const started = manager.beginProbe(key);
    assert.ok(started);
    assert.equal(manager.beginProbe(key).reviewRef, started.reviewRef);
    assert.equal(manager.state(key).ownedProbe, true);
    assert.equal(manager.beginProbe({ ...key, operationId: 'probe-two' }), null);
    assert.equal(manager.beginProbe({ ...key, connectionEpoch: 4 }), null);
    assert.equal(manager.finishProbe({ ...key, verdict: 'confirmed' }), null, 'caller verdict alone cannot end a live operation');
    f.tick(86_400_000);
    assert.equal(f.reviews().state({ ...f.key }).openProbe, true, 'time and restart cannot unlock an in-flight probe');
    f.ledger.markNotSent({ operationId: proposal.operationId,
      nonSendProof: { permitConsumed: false, byteSendStarted: false, source: 'same-process-permit-never-consumed' },
      evidence: { source: 'test', payload: { synthetic: true } } });
    const crashed = f.reviews();
    assert.equal(crashed.state(key).openProbe, false, 'durable ledger outcome survives a missing finish callback');
    assert.equal(crashed.state(key).held, true, 'not-sent is not a successful technical review');
    assert.ok(crashed.finishProbe(key));
    assert.equal(crashed.finishProbe(key), null);
    assert.equal(f.store.get("SELECT COUNT(*) AS n FROM backend_art_technical_hold_reviews WHERE decision='retained'").n, 1);
    assert.equal(f.ledger.operation(proposal.operationId).transport_state, 'not_sent');
  } finally { f.close(); }
});

test('crashed unknown review ends without changing unknown; legacy pre-operation claim heals by exact ledger absence', () => {
  const f = holdFixture();
  try {
    f.hold(); const manager = f.reviews(), proposal = f.prepare('unknown-probe'), key = { ...f.key, operationId: proposal.operationId };
    assert.ok(manager.beginProbe(key));
    f.ledger.markMayHaveSent({ operationId: proposal.operationId, evidence: { source: 'test', payload: { synthetic: true } } });
    f.ledger.recordTransport({ operationId: proposal.operationId, transportState: 'unknown', evidence: { source: 'test', payload: { synthetic: true } } });
    f.ledger.settleOperation({ operationId: proposal.operationId, businessVerdict: 'unknown', verificationVersion: 'test',
      evidence: { source: 'test', payload: { synthetic: true } }, resourceResolutions: [] });
    const before = f.store.get('SELECT * FROM backend_operations WHERE operation_id=?', proposal.operationId);
    assert.ok(f.reviews().finishProbe(key));
    assert.equal(f.reviews().state(key).held, true);
    assert.deepEqual(f.store.get('SELECT * FROM backend_operations WHERE operation_id=?', proposal.operationId), before);
    const legacyKey = { ...f.key, implementationVersion: 'legacy/v1' }; f.hold(legacyKey.featureId, legacyKey.implementationVersion);
    f.store.run(`INSERT INTO backend_art_technical_hold_reviews
      (review_ref,owner_ref,subject_ref,feature_id,implementation_version,decision,evidence_ref,recorded_at_ms,recorded_at)
      VALUES(?,?,?,?,?,'probe-started',?,?,?)`, 'orphan', f.key.ownerRef, f.key.subjectRef, f.key.featureId,
    legacyKey.implementationVersion, 'art-first-reward-probe:never-prepared', Date.parse(f.holdAt) + 1, f.holdAt);
    assert.equal(f.reviews().state(legacyKey).openProbe, false);
    assert.equal(f.reviews().state(legacyKey).probeAllowed, true);
    assert.equal(f.store.get("SELECT operation_id FROM backend_operations WHERE operation_id='never-prepared'"), null);
  } finally { f.close(); }
});

test('customer batch and first reward repeated admission checks are pure reads', () => {
  const f = holdFixture();
  try {
    const empty = () => ({ current: false, entries: [] }), noop = () => ({});
    const ports = { store: f.store, artRuntime: { customerBatchInputs: empty, customerBatchPostState: empty,
      firstRewardInputs: empty, firstRewardBalances: empty },
    resources: { balance: noop, budget: noop, reservationSpec: noop, matchedItemFlow: noop, matchedProfileFlow: noop },
    dynamicState: { snapshot: () => ({ current: false, domains: [] }) }, readConfiguration: () => ({ savedRevision: 1,
      config: { art: { makeEnabled: true, firstAlbumClaim: true }, orders: { customer: { enabled: true } } } }),
    readProfile: empty, readInputDemand: empty, isCurrent: () => true, extensionForContext: () => ({ extensionRef: 'ext' }),
    ledgerView: { operation: f.ledger.operation, currentAdmission: () => ({ unresolvedOperations: [] }) } };
    const batch = createCustomerArtBatchRuntime(ports), first = createArtFirstRewardRuntime(ports).feature('art.first-album');
    for (const feature of [batch.feature, first]) {
      f.hold(feature.featureId, feature.implementationVersion);
      const proposal = { ...f.key, featureId: feature.featureId, operationId: feature.featureId + ':candidate', params: {},
        artFirstReward: { extensionRef: 'ext', extension: { extensionRef: 'ext' } } };
      const a = feature.evaluateAdmission({ proposal, actor: proposal, factBasis: {} });
      const b = feature.evaluateAdmission({ proposal, actor: proposal, factBasis: {} });
      assert.equal(a.allowed, false); assert.deepEqual(a, b);
      assert.equal(f.store.get('SELECT COUNT(*) AS n FROM backend_art_technical_hold_reviews').n, 0);
    }
  } finally { f.close(); }
});

test('a confirmed durable review retires its hold, while transaction rollback leaves no claimed attempt', () => {
  const f = holdFixture();
  try {
    f.hold(); const manager = f.reviews();
    assert.throws(() => f.store.transaction(() => {
      f.prepare('rolled-back'); assert.ok(manager.beginProbe({ ...f.key, operationId: 'rolled-back' })); throw Error('abort prepare');
    }), /abort prepare/);
    assert.equal(f.store.get('SELECT COUNT(*) AS n FROM backend_art_technical_hold_reviews').n, 0);
    assert.equal(f.ledger.operation('rolled-back'), null);
    const proposal = f.prepare('confirmed-probe'), key = { ...f.key, operationId: proposal.operationId };
    assert.ok(manager.beginProbe(key));
    f.ledger.markMayHaveSent({ operationId: proposal.operationId, evidence: { source: 'test', payload: { synthetic: true } } });
    f.ledger.recordTransport({ operationId: proposal.operationId, transportState: 'answered', releaseWriteSlot: true,
      transportTermination: { ended: true, source: 'synthetic-matched-response' }, evidence: { source: 'test', payload: { synthetic: true } } });
    f.ledger.settleOperation({ operationId: proposal.operationId, businessVerdict: 'confirmed', verificationVersion: 'test',
      evidence: { source: 'test', payload: { synthetic: true } }, resourceResolutions: [] });
    assert.ok(f.reviews().finishProbe(key)); assert.equal(f.reviews().state(key).held, false);
    assert.equal(f.store.get("SELECT COUNT(*) AS n FROM backend_art_technical_hold_reviews WHERE decision='retired'").n, 1);
  } finally { f.close(); }
});

test('real gateway repeated admission fences share one atomic technical-review claim and finish on durable unknown', async () => {
  const f = holdFixture();
  try {
    const context = { ...f.key }; delete context.featureId; delete context.implementationVersion;
    const key = { ...context, featureId: 'water', implementationVersion: 'probe/v1' };
    f.hold('water', key.implementationVersion); const manager = f.reviews();
    const config = { waterEnabled: true, keepWater: 0 }, basis = { synthetic: true };
    f.store.db.exec('CREATE TABLE backend_config_history(owner_ref TEXT,account_ref TEXT,revision INTEGER,dto_json TEXT)');
    f.store.run('INSERT INTO backend_config_history VALUES(?,?,1,?)', context.ownerRef, context.accountRef, JSON.stringify(config));
    const dynamic = createDynamicStateCoordinator({ store: f.store, isCurrent: () => true, deviceNow: () => 1000, monotonicNow: () => 1000 });
    const paths = ['state', 'flowerId', 'plantTime'].map(field => 'land.lands.1001.fields.' + field);
    const values = Object.fromEntries(paths.map((p, i) => [p, [1, 23001, 1234][i]]));
    dynamic.observe({ context, observation: { method: 'index.login', source: 'response', transport: 'answered', envelopeOk: true,
      dsName: 'G.ISyncData', rejected: false, connectionEpoch: context.connectionEpoch, requestSequence: 1,
      responseRef: 'synthetic-login', wireKey: 'ws|1|1', receivedDeviceMs: 1000, receivedMonotonicMs: 1000,
      value: { '7': { '0': { '0': 777 } } }, currentIdentity: { verified: true, officialUid: 777, responseRef: 'synthetic-login' } },
    coverage: [{ domainId: 'land', complete: true, paths, semanticValue: values, semanticFingerprint: fingerprint(values),
      cellSources: Object.fromEntries(paths.map(p => [p, { sourceRef: 'synthetic-login', method: 'index.login',
        connectionEpoch: context.connectionEpoch, requestSequence: 1, observedAtMs: 1000, observedMonotonicMs: 1000 }])) }] });
    let checks = 0, claims = 0, sent = 0;
    const admission = ({ proposal }) => {
      checks++; const hold = manager.state({ ...key, operationId: proposal.operationId });
      return { allowed: !hold.held || hold.probeAllowed || hold.ownedProbe, targetsCurrent: true, resourcesCurrent: true,
        historicalConstraintsChecked: true, currentInFlightChecked: true };
    };
    const feature = { featureId: 'water', consumedDomains: ['land'], scopes: ['water'], methods: ['usrLand.water'], release: 'validation-only',
      implementationVersion: key.implementationVersion, contractRef: 'test', assess: () => ({}), qualify: admission, verify: () => { throw Error('unused'); },
      claimTechnicalReview: ({ proposal }) => { claims++; return { accepted: Boolean(manager.beginProbe({ ...key, operationId: proposal.operationId })) }; },
      finishTechnicalReview: ({ proposal }) => manager.finishProbe({ ...key, operationId: proposal.operationId }) };
    const registry = createFeatureRegistry(); registry.register(feature);
    const actor = { ...context, isCurrent: () => true, controller: new AbortController(), connection: { isOpen: () => true,
      prepareWrite: (method, params) => ({ send: permit => {
        permit.claim({ method, paramsFingerprint: fingerprint(params), connectionEpoch: context.connectionEpoch, wireKey: 'ws|1|2', requestSequence: 2 });
        sent++; return Promise.reject(Object.assign(Error('synthetic answer lost'), { code: 'TEST_ANSWER_LOST' }));
      } }) } };
    const gateway = createWriteGateway({ store: f.store, ledger: f.ledger, registry, dynamicState: dynamic,
      supervisor: { executorRef: 'executor', context: () => actor }, authorize: () => true,
      readConfiguration: () => ({ config, savedRevision: 1, featureCancelEpochs: { water: 0 } }),
      readFactBasis: () => basis, evaluateAdmission: admission,
      beforeSend: async ({ proposal }) => {
        assert.equal(manager.state({ ...key, operationId: proposal.operationId }).ownedProbe, true);
        assert.equal(manager.beginProbe({ ...key, operationId: 'competing-operation' }), null);
      } });
    const proposal = { ...context, featureId: 'water', scope: 'water', method: 'usrLand.water', params: { landId: 1001 },
      operationId: 'gateway-probe', semanticKey: 'gateway-probe', configRevision: 1, featureCancelEpoch: 0, factBasis: basis,
      targets: [{ memberKey: 'member', targetKind: 'land', targetRef: 'land:subject:1001', lifecycleRef: 'stage', targetFingerprint: 'target' }],
      resources: [], resourceBindings: [] };
    await assert.rejects(gateway.submit(proposal), { code: 'TEST_ANSWER_LOST' });
    assert.ok(checks >= 4, 'all repeated gateway fences completed'); assert.equal(claims, 1); assert.equal(sent, 1);
    assert.equal(f.store.get("SELECT COUNT(*) AS n FROM backend_art_technical_hold_reviews WHERE decision='probe-started'").n, 1);
    assert.equal(f.store.get("SELECT COUNT(*) AS n FROM backend_art_technical_hold_reviews WHERE decision='retained'").n, 1);
    assert.equal(manager.state(key).openProbe, false); assert.equal(manager.state(key).held, true);
    assert.equal(f.ledger.operation(proposal.operationId).business_verdict, 'unknown');
  } finally { f.close(); }
});


test('gateway faults survive reconstruction and recover only by an explicit evidence port', () => {
  const f = holdFixture();
  try {
    let proof = null;
    const gateway = () => createWriteGateway({ store: f.store, ledger: f.ledger, registry: createFeatureRegistry(),
      supervisor: { context: () => null }, readConfiguration: () => ({}), authorize: () => true,
      readFactBasis: () => ({}), evaluateAdmission: () => ({ allowed: false }),
      dynamicState: { snapshot() {}, beforeDispatch() {} }, authorizeFaultRecovery: () => proof });
    gateway();
    f.store.run('INSERT INTO backend_gateway_subject_faults VALUES(?,?,?,?,?,?,?,?,?,?)',
      'fault', f.key.ownerRef, f.key.accountRef, f.key.subjectRef, 1, 2, 3, 'operation', 'WRITE_DURABILITY_UNCONFIRMED', f.store.nowIso());
    let g = gateway();
    assert.equal(g.recoverSubjectFaults({ context: f.key }).remaining, 1);
    assert.equal(f.store.get('SELECT COUNT(*) AS n FROM backend_gateway_subject_fault_recoveries').n, 0);
    proof = { operationId: 'wrong', technicalFaultOnly: true };
    assert.equal(g.recoverSubjectFaults({ context: f.key }).recovered, 0);
    proof = { operationId: 'operation', technicalFaultOnly: true, synthetic: true };
    assert.equal(g.recoverSubjectFaults({ context: { ...f.key, accountRef: 'other' } }).recovered, 0);
    assert.deepEqual(g.recoverSubjectFaults({ context: f.key }), { recovered: 1, remaining: 0 });
    assert.deepEqual(gateway().recoverSubjectFaults({ context: f.key }), { recovered: 0, remaining: 0 });
    assert.throws(() => f.store.run('DELETE FROM backend_gateway_subject_faults'), /retained/);
    assert.throws(() => f.store.run('UPDATE backend_gateway_subject_fault_recoveries SET evidence_json=?', '{}'), /immutable/);
  } finally { f.close(); }
});
