import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createBackendLedger } from '../runtime/backend/persistence/ledger.mjs';
import { fingerprint } from '../runtime/backend/common.mjs';
import { legacyConstraintHasClosedSourceOperation } from '../runtime/backend/features/land/runtime.mjs';
import { createLegacyConstraints } from '../runtime/backend/migration/legacy-constraints.mjs';

const ctx = Object.freeze({ ownerRef: 'owner-a', accountRef: 'account-a', subjectRef: 'subject-a', ownerEpoch: 2, runEpoch: 4, connectionEpoch: 2 });

test('legacy resource rebasing binds its part origin through the exact closed parent operation', () => {
  const constraint = { operation_ref: 'op-ref', source_operation_id: 'old-op-1',
    source_origin_key: 'constraint-origin-part-resource-item-7' };
  const proof = { available: true, original: { operationRef: 'op-ref', sourceOperationId: 'old-op-1',
    sourceOriginKey: 'operation-origin-part-null', ownerRef: ctx.ownerRef, subjectRef: ctx.subjectRef },
  previousExecution: { closed: true, executionClosed: true, sourceFenceRef: 'fence', evidenceRef: 'evidence',
    sourceInstallId: 'install', sourceSignerFingerprint: 'signer' } };
  assert.notEqual(constraint.source_origin_key, proof.original.sourceOriginKey, 'resource and operation origins are separately scoped');
  assert.equal(legacyConstraintHasClosedSourceOperation(constraint, proof, ctx), true);
  assert.equal(legacyConstraintHasClosedSourceOperation({ ...constraint, operation_ref: 'other-op' }, proof, ctx), false);
  assert.equal(legacyConstraintHasClosedSourceOperation({ ...constraint, source_operation_id: 'other-source-id' }, proof, ctx), false);
  assert.equal(legacyConstraintHasClosedSourceOperation(constraint, { ...proof, previousExecution: { ...proof.previousExecution, closed: false } }, ctx), false);
});

test('legacy current resource view preserves a valid prior per-constraint separation under later baselines', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-legacy-resource-view-'));
  const store = openBackendStore({ dataDir: root });
  try {
    const legacy = createLegacyConstraints({ store, cipher: { decrypt: () => { throw new Error('not used'); } } });
    store.db.exec(`CREATE TABLE backend_legacy_resource_budget_baseline_links(
      baseline_ref TEXT NOT NULL,constraint_ref TEXT NOT NULL,source_origin_key TEXT NOT NULL,raw_ref TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,resource_key TEXT NOT NULL,source_fence_ref TEXT NOT NULL,source_fence_fingerprint TEXT NOT NULL,
      evidence_json TEXT NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(baseline_ref,constraint_ref));`);
    store.run(`INSERT INTO backend_legacy_operation_index(operation_ref,transfer_id,archive_id,owner_ref,account_ref,subject_ref,
      source_origin_key,source_operation_id,source_version,source_fingerprint,feature_id,unresolved,recorded_at)
      VALUES('op-ref','transfer','archive','owner-a','account-a','subject-a','operation-origin','old-op-1','v1','op-fp','plant',1,?)`, store.nowIso());
    for (const [constraintRef, origin, rawRef, kind] of [
      ['linked-resource', 'constraint-part-resource-7', 'item:7', 'resource'],
      ['unlinked-resource', 'constraint-part-resource-8', 'item:8', 'resource'],
      ['target-constraint', 'constraint-part-target-1', 'land:1', 'target']
    ]) store.run(`INSERT INTO backend_legacy_constraint_index(constraint_ref,transfer_id,archive_id,operation_ref,source_operation_id,
      source_origin_key,owner_ref,account_ref,subject_ref,kind,raw_ref,quantity,source_fingerprint,recorded_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, constraintRef, 'transfer', 'archive', 'op-ref', 'old-op-1', origin,
    'owner-a', 'account-a', 'subject-a', kind, rawRef, kind === 'resource' ? 2 : null, 'constraint-fp-' + constraintRef, store.nowIso());
    store.run(`INSERT INTO backend_legacy_resource_budget_baseline_links VALUES(?,?,?,?,?,?,?,?,?,?)`,
      'baseline-1', 'linked-resource', 'constraint-part-resource-7', 'item:7', 'constraint-fp-linked-resource',
      'legacy-item:key-7', 'source-fence', 'fence-fp', '{}', store.nowIso());
    const current = legacy.currentAdmission({ ownerRef: 'owner-a', subjectRef: 'subject-a', resourceBaselineRef: 'baseline-1' });
    assert.deepEqual(current.resourceFootprints.map(row => row.constraint_ref), ['unlinked-resource']);
    assert.deepEqual(current.targets.map(row => row.constraint_ref), ['target-constraint']);
    assert.equal(current.operations.some(row => row.operation_ref === 'op-ref'), true, 'audit operation remains visible');
    const withoutBaseline = legacy.currentAdmission({ ownerRef: 'owner-a', subjectRef: 'subject-a' });
    assert.equal(withoutBaseline.resourceFootprints.length, 2, 'ordinary history view retains all raw constraints');
    const laterBaseline = legacy.currentAdmission({ ownerRef: 'owner-a', subjectRef: 'subject-a', resourceBaselineRef: 'baseline-2' });
    assert.deepEqual(laterBaseline.resourceFootprints.map(row => row.constraint_ref), ['unlinked-resource'],
      'a later complete baseline reuses the exact prior constraint separation instead of reintroducing it');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('legacy candidate projection loads only matching target and resource constraints but keeps unclassified operation evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-legacy-candidate-scope-'));
  const store = openBackendStore({ dataDir: root });
  try {
    const legacy = createLegacyConstraints({ store, cipher: { decrypt: () => { throw new Error('not used'); } } });
    const now = store.nowIso();
    for (const [operationRef, targetRef] of [['op-a', 'land:1'], ['op-b', 'land:2'], ['op-unclassified', null]]) {
      store.run(`INSERT INTO backend_legacy_operation_index(operation_ref,transfer_id,archive_id,owner_ref,account_ref,subject_ref,
        source_origin_key,source_operation_id,source_version,source_fingerprint,feature_id,scope,method,unresolved,recorded_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`, operationRef, 'transfer', 'archive-' + operationRef, ctx.ownerRef, ctx.accountRef,
      ctx.subjectRef, 'origin-' + operationRef, operationRef, 'v1', 'fp-' + operationRef, 'land', 'land-water', 'usrLand.water', now);
      if (targetRef) store.run(`INSERT INTO backend_legacy_constraint_index(constraint_ref,transfer_id,archive_id,operation_ref,
        source_operation_id,source_origin_key,owner_ref,account_ref,subject_ref,kind,raw_ref,source_fingerprint,recorded_at)
        VALUES(?,?,?,?,?,?,?,?,?,'target',?,?,?)`, 'constraint-' + operationRef, 'transfer', 'archive-' + operationRef,
      operationRef, operationRef, 'part-' + operationRef, ctx.ownerRef, ctx.accountRef, ctx.subjectRef, targetRef, 'constraint-fp-' + operationRef, now);
    }
    store.run(`INSERT INTO backend_legacy_admission_basis(owner_ref,subject_ref,constraint_ref,basis_key,source_fingerprint,conclusion,
      fact_basis_json,fact_basis_fingerprint,affected_json,evidence_json,reason_code,recorded_at)
      VALUES(?,?,?,?,?,'needs_evidence','{}',?,'{}','{}','LEGACY_TEST',?)`, ctx.ownerRef, ctx.subjectRef, 'constraint-op-a', 'basis-a',
    'constraint-fp-op-a', fingerprint({}), now);
    const projection = legacy.candidateProjection({ ownerRef: ctx.ownerRef, subjectRef: ctx.subjectRef,
      rawTargetRefs: ['land:1'], rawResourceKeys: [], semanticKey: 'none' });
    assert.deepEqual(projection.targets.map(one => one.raw_ref), ['land:1']);
    assert.deepEqual(projection.resourceFootprints, []);
    assert.deepEqual(projection.bases.map(one => one.constraint_ref), ['constraint-op-a']);
    assert.deepEqual(projection.unclassifiedOperations.map(one => one.operation_ref), ['op-unclassified'],
      'an operation already mapped to another target is not relabelled unclassified when the current candidate is narrower');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

function operation(ledger, id, connectionEpoch, resourceKey, accountRef = ctx.accountRef, overrides = {}) {
  return ledger.prepareOperation({ operationId: id, proposalId: 'proposal-' + id, ownerRef: ctx.ownerRef, accountRef,
    subjectRef: ctx.subjectRef, ownerEpoch: 1, executorRef: 'executor-old', runEpoch: 1, connectionEpoch,
    featureId: 'order.resident', scope: 'order:box:1', method: 'orderFlower.finishOrder', semanticKey: 'semantic-' + id,
    configRevision: 1, cancelEpoch: 0, paramsFingerprint: 'params-' + id,
    factBasis: overrides.factBasis ?? { version: 'order-flower-ordinary-admission/v1', target: { kind: 'resident', boxId: 1, lifecycleRef: 'life-' + id },
      officialIdentity: { uid: 12345, gameVersion: '480.0.27', protocolVersion: '480.0.0' } },
    targets: [{ memberKey: 'land:1', targetKind: 'land', targetRef: '1', lifecycleRef: 'life-1', targetFingerprint: 'target-1' }],
    resources: [{ resourceKey, resourceKind: 'item', resourceRef: 'seed:7', quantity: 7, basisRef: 'basis-' + id, accountingRef: 'accounting-' + id }],
    resourceBindings: [{ resourceKey, memberKey: 'land:1', quantity: 7 }] });
}

function insertLoginProof(store, { complete = true, connectionEpoch = 2, requestSequence = 11,
  responseRef = 'login-response-' + connectionEpoch, isolationEvidenceRef = 'isolation-proof-' + connectionEpoch,
  isolationSourceRef = 'source-fence-' + connectionEpoch } = {}) {
  const observationRef = 'land-observation:' + fingerprint([ctx.ownerRef, ctx.subjectRef, connectionEpoch, responseRef]);
  const source = { method: 'index.login', kind: 'response', connectionEpoch, requestSequence, responseRef };
  const landFrame = { source, profile: { uid: { presence: 'present', state: 'known', value: 12345 } },
    coverage: { bagComplete: complete }, bag: { presence: 'present', state: 'known', items: complete
    ? { '7': { presence: 'present', state: 'known', value: 23 }, '8': { presence: 'present', state: 'known', value: 0 } } :
      { '7': { presence: 'present', state: 'known', value: 23 } } } };
  store.run(`INSERT INTO backend_land_domain_observations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, observationRef, ctx.ownerRef, ctx.accountRef,
    ctx.subjectRef, connectionEpoch, requestSequence, 'wire-login-2', responseRef, 'payload-fingerprint', 1, null, JSON.stringify(landFrame), store.nowIso());
  const itemRef = 'item-login-' + connectionEpoch;
  store.run(`INSERT INTO backend_official_item_frames VALUES(?,?,?,?,?,?,?,?,?,?,?)`, itemRef, ctx.ownerRef, ctx.accountRef, ctx.subjectRef,
    connectionEpoch, requestSequence, responseRef, 'wire-login-2', JSON.stringify(source), JSON.stringify({ bag: landFrame.bag }), store.nowIso());
  const proof = { stopped: true, currentInFlight: false, sourceFenceCommitted: true };
  store.run('INSERT INTO backend_executor_isolation VALUES(?,?,?,?,?)', ctx.subjectRef, isolationEvidenceRef, isolationSourceRef, JSON.stringify(proof), store.nowIso());
  return { responseRef, requestSequence, connectionEpoch,
    executorIsolation: { isolated: true, evidenceRef: isolationEvidenceRef, sourceRef: isolationSourceRef } };
}

test('closed-executor complete login rebases only current resource admission; unknown history remains immutable and new opportunities count', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-resource-baseline-'));
  const store = openBackendStore({ dataDir: root }), ledger = createBackendLedger(store);
  try {
    store.db.exec(`CREATE TABLE backend_executor_isolation(subject_ref TEXT NOT NULL,evidence_ref TEXT NOT NULL,source_ref TEXT NOT NULL,proof_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(subject_ref,evidence_ref));
      CREATE TABLE backend_subject_bindings(owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,basis TEXT,identity_version TEXT,channel TEXT,evidence_json TEXT,created_at TEXT,PRIMARY KEY(owner_ref,account_ref));
      CREATE TABLE backend_session_connection_closures(evidence_ref TEXT PRIMARY KEY,owner_ref TEXT,account_ref TEXT,subject_ref TEXT,executor_ref TEXT,owner_epoch INTEGER,run_epoch INTEGER,connection_epoch INTEGER,proof_kind TEXT,proof_json TEXT,recorded_at TEXT);
      CREATE TABLE backend_land_domain_observations(observation_ref TEXT PRIMARY KEY,owner_ref TEXT,account_ref TEXT,subject_ref TEXT,connection_epoch INTEGER,request_sequence INTEGER,wire_key TEXT,response_ref TEXT,payload_fingerprint TEXT,accepted INTEGER,reason_code TEXT,frame_json TEXT,recorded_at TEXT);
      CREATE TABLE backend_official_item_frames(observation_ref TEXT PRIMARY KEY,owner_ref TEXT,account_ref TEXT,subject_ref TEXT,connection_epoch INTEGER,request_sequence INTEGER,response_ref TEXT,wire_key TEXT,source_json TEXT,payload_json TEXT,recorded_at TEXT);`);
    operation(ledger, 'old-unknown-operation', 1, 'old-seed', 'old-account-a');
    store.run('INSERT INTO backend_subject_bindings VALUES(?,?,?,?,?,?,?,?)', ctx.ownerRef, 'old-account-a', ctx.subjectRef,
      'fixture-stable-subject', 'fixture-v1', 'official', '{}', store.nowIso());
    ledger.markMayHaveSent({ operationId: 'old-unknown-operation', expectedRevision: 1,
      evidence: { kind: 'send-boundary', source: 'synthetic-protocol-fixture', payload: { runEpoch: 1, connectionEpoch: 1 } } });
    ledger.appendEvidence({ operationId: 'old-unknown-operation', evidenceKey: 'unknown-result', kind: 'test', source: 'synthetic-protocol-fixture', payload: { verdict: 'unknown' } });
    store.run('INSERT INTO backend_session_connection_closures VALUES(?,?,?,?,?,?,?,?,?,?,?)', 'old-closed-1', ctx.ownerRef, 'old-account-a',
      ctx.subjectRef, 'executor-old', 1, 1, 1, 'transport-closed', JSON.stringify({ closed: true, connectionEpoch: 1, source: 'transport-close-receipt' }), store.nowIso());
    ledger.recordTransport({ operationId: 'old-unknown-operation', expectedRevision: 4, transportState: 'unknown', releaseWriteSlot: true,
      transportTermination: { ended: true, source: 'synthetic-old-executor-close' },
      evidence: { kind: 'synthetic-unknown-transport', source: 'unit-fixture', payload: { responseMatched: false } } });
    ledger.settleOperation({ operationId: 'old-unknown-operation', expectedRevision: 6, businessVerdict: 'unknown', verificationVersion: 'test/v1', releaseWriteSlot: false,
      evidence: { kind: 'synthetic-unknown', source: 'unit-fixture' } });
    const before = ledger.operation('old-unknown-operation');
    const proof = insertLoginProof(store);
    const baseline = ledger.recordCurrentResourceBaseline({ context: ctx, ...proof, officialUid: 12345,
      versionEvidence: { source: 'normal-package-hop-and-matched-world-login/v1', gameVersion: '480.0.27',
        protocolVersion: '480.0.0', loginResponseRef: proof.responseRef } });
    assert.equal(baseline.recorded, true);
    assert.equal(ledger.operation('old-unknown-operation').original_fingerprint, before.original_fingerprint);
    assert.equal(ledger.operation('old-unknown-operation').business_verdict, 'unknown');
    assert.equal(ledger.currentAdmission({ ownerRef: ctx.ownerRef, subjectRef: ctx.subjectRef }).resourceFootprints.length, 0,
      'old resource footprint is now audit-only for current absolute budget: ' + JSON.stringify({ operation: ledger.operation('old-unknown-operation')?.original,
        links: store.all('SELECT * FROM backend_resource_budget_baseline_links') }));

    operation(ledger, 'new-opportunity', 2, 'new-seed');
    const current = ledger.currentAdmission({ ownerRef: ctx.ownerRef, subjectRef: ctx.subjectRef });
    assert.deepEqual(current.resourceFootprints.map(item => item.operation_id), ['new-opportunity']);
    assert.equal(current.resourceFootprints[0].quantity, 7);
    assert.equal(current.unresolvedOperations.some(item => item.operation_id === 'old-unknown-operation'), true,
      'business uncertainty remains available for opportunity-local checks');
  } finally {
    store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('incomplete login bag cannot establish a resource baseline', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-resource-baseline-incomplete-'));
  const store = openBackendStore({ dataDir: root }), ledger = createBackendLedger(store);
  try {
    store.db.exec(`CREATE TABLE backend_executor_isolation(subject_ref TEXT NOT NULL,evidence_ref TEXT NOT NULL,source_ref TEXT NOT NULL,proof_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(subject_ref,evidence_ref));
      CREATE TABLE backend_session_connection_closures(evidence_ref TEXT PRIMARY KEY,owner_ref TEXT,account_ref TEXT,subject_ref TEXT,executor_ref TEXT,owner_epoch INTEGER,run_epoch INTEGER,connection_epoch INTEGER,proof_kind TEXT,proof_json TEXT,recorded_at TEXT);
      CREATE TABLE backend_land_domain_observations(observation_ref TEXT PRIMARY KEY,owner_ref TEXT,account_ref TEXT,subject_ref TEXT,connection_epoch INTEGER,request_sequence INTEGER,wire_key TEXT,response_ref TEXT,payload_fingerprint TEXT,accepted INTEGER,reason_code TEXT,frame_json TEXT,recorded_at TEXT);
      CREATE TABLE backend_official_item_frames(observation_ref TEXT PRIMARY KEY,owner_ref TEXT,account_ref TEXT,subject_ref TEXT,connection_epoch INTEGER,request_sequence INTEGER,response_ref TEXT,wire_key TEXT,source_json TEXT,payload_json TEXT,recorded_at TEXT);`);
    operation(ledger, 'old-still-active', 1, 'old-seed');
    const proof = insertLoginProof(store, { complete: false });
    assert.deepEqual(ledger.recordCurrentResourceBaseline({ context: ctx, ...proof, officialUid: 12345,
      versionEvidence: { source: 'normal-package-hop-and-matched-world-login/v1', gameVersion: '480.0.27',
        protocolVersion: '480.0.0', loginResponseRef: proof.responseRef } }),
      { recorded: false, reasonCode: 'RESOURCE_BASELINE_FULL_ABSOLUTE_BAG_UNPROVEN' });
    assert.equal(ledger.currentAdmission({ ownerRef: ctx.ownerRef, subjectRef: ctx.subjectRef }).resourceFootprints.length, 1);
  } finally {
    store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a closed old item reservation is excluded with missing old identity and links only once across later baselines', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-resource-baseline-repeated-'));
  const store = openBackendStore({ dataDir: root }), ledger = createBackendLedger(store);
  try {
    store.db.exec(`CREATE TABLE backend_executor_isolation(subject_ref TEXT NOT NULL,evidence_ref TEXT NOT NULL,source_ref TEXT NOT NULL,proof_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(subject_ref,evidence_ref));
      CREATE TABLE backend_subject_bindings(owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,basis TEXT,identity_version TEXT,channel TEXT,evidence_json TEXT,created_at TEXT,PRIMARY KEY(owner_ref,account_ref));
      CREATE TABLE backend_session_connection_closures(evidence_ref TEXT PRIMARY KEY,owner_ref TEXT,account_ref TEXT,subject_ref TEXT,executor_ref TEXT,owner_epoch INTEGER,run_epoch INTEGER,connection_epoch INTEGER,proof_kind TEXT,proof_json TEXT,recorded_at TEXT);
      CREATE TABLE backend_land_domain_observations(observation_ref TEXT PRIMARY KEY,owner_ref TEXT,account_ref TEXT,subject_ref TEXT,connection_epoch INTEGER,request_sequence INTEGER,wire_key TEXT,response_ref TEXT,payload_fingerprint TEXT,accepted INTEGER,reason_code TEXT,frame_json TEXT,recorded_at TEXT);
      CREATE TABLE backend_official_item_frames(observation_ref TEXT PRIMARY KEY,owner_ref TEXT,account_ref TEXT,subject_ref TEXT,connection_epoch INTEGER,request_sequence INTEGER,response_ref TEXT,wire_key TEXT,source_json TEXT,payload_json TEXT,recorded_at TEXT);`);
    operation(ledger, 'old-no-identity', 1, 'old-seed', 'old-account-a', { factBasis: { version: 'legacy/unknown' } });
    store.run('INSERT INTO backend_subject_bindings VALUES(?,?,?,?,?,?,?,?)', ctx.ownerRef, 'old-account-a', ctx.subjectRef,
      'fixture-stable-subject', 'fixture-v1', 'official', '{}', store.nowIso());
    ledger.markMayHaveSent({ operationId: 'old-no-identity', expectedRevision: 1,
      evidence: { kind: 'send-boundary', source: 'synthetic-protocol-fixture', payload: { runEpoch: 1, connectionEpoch: 1 } } });
    ledger.appendEvidence({ operationId: 'old-no-identity', evidenceKey: 'unknown-result', kind: 'test', source: 'synthetic-protocol-fixture', payload: { verdict: 'unknown' } });
    store.run('INSERT INTO backend_session_connection_closures VALUES(?,?,?,?,?,?,?,?,?,?,?)', 'old-closed-no-identity', ctx.ownerRef, 'old-account-a',
      ctx.subjectRef, 'executor-old', 1, 1, 1, 'transport-closed', JSON.stringify({ closed: true, connectionEpoch: 1, source: 'transport-close-receipt' }), store.nowIso());
    ledger.recordTransport({ operationId: 'old-no-identity', expectedRevision: 4, transportState: 'unknown', releaseWriteSlot: true,
      transportTermination: { ended: true, source: 'synthetic-old-executor-close' }, evidence: { kind: 'synthetic-unknown-transport', source: 'unit-fixture' } });
    ledger.settleOperation({ operationId: 'old-no-identity', expectedRevision: 6, businessVerdict: 'unknown', verificationVersion: 'test/v1', releaseWriteSlot: false,
      evidence: { kind: 'synthetic-unknown', source: 'unit-fixture' } });
    const before = ledger.operation('old-no-identity');
    const resourceBefore = before.resources.map(({ original_json, ...row }) => ({ ...row, original_json }));
    const record = (epoch, seq) => {
      const context = Object.freeze({ ...ctx, connectionEpoch: epoch });
      const proof = insertLoginProof(store, { connectionEpoch: epoch, requestSequence: seq });
      return ledger.recordCurrentResourceBaseline({ context, ...proof, officialUid: 12345,
        versionEvidence: { source: 'normal-package-hop-and-matched-world-login/v1', gameVersion: '480.1.0',
          protocolVersion: '480.1.0', loginResponseRef: proof.responseRef } });
    };
    assert.equal(record(2, 11).linkedResources, 1,
      'the current absolute bag can isolate a closed old item reservation despite absent old identity/version fields');
    assert.equal(ledger.currentAdmission({ ownerRef: ctx.ownerRef, subjectRef: ctx.subjectRef }).resourceFootprints.length, 0);
    assert.equal(record(3, 12).linkedResources, 0);
    assert.equal(record(4, 13).linkedResources, 0);
    assert.equal(store.get('SELECT COUNT(*) AS n FROM backend_resource_budget_baseline_links').n, 1,
      'later logins do not create one new accounting link per historical baseline');
    assert.equal(ledger.currentAdmission({ ownerRef: ctx.ownerRef, subjectRef: ctx.subjectRef }).resourceFootprints.length, 0,
      'prior exact per-resource isolation remains effective under the newer current baseline');
    const after = ledger.operation('old-no-identity');
    assert.equal(after.original_fingerprint, before.original_fingerprint);
    assert.equal(after.business_verdict, 'unknown');
    assert.equal(after.original.factBasis.version, 'legacy/unknown');
    assert.deepEqual(after.resources.map(({ original_json, ...row }) => ({ ...row, original_json })), resourceBefore,
      'resource source rows and fingerprints remain unchanged; only the separate active-budget projection is rebased');
  } finally {
    store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an active old write reservation stays in the current resource budget even after a newer full login', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-resource-baseline-active-'));
  const store = openBackendStore({ dataDir: root }), ledger = createBackendLedger(store);
  try {
    store.db.exec(`CREATE TABLE backend_executor_isolation(subject_ref TEXT NOT NULL,evidence_ref TEXT NOT NULL,source_ref TEXT NOT NULL,proof_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(subject_ref,evidence_ref));
      CREATE TABLE backend_subject_bindings(owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,basis TEXT,identity_version TEXT,channel TEXT,evidence_json TEXT,created_at TEXT,PRIMARY KEY(owner_ref,account_ref));
      CREATE TABLE backend_session_connection_closures(evidence_ref TEXT PRIMARY KEY,owner_ref TEXT,account_ref TEXT,subject_ref TEXT,executor_ref TEXT,owner_epoch INTEGER,run_epoch INTEGER,connection_epoch INTEGER,proof_kind TEXT,proof_json TEXT,recorded_at TEXT);
      CREATE TABLE backend_land_domain_observations(observation_ref TEXT PRIMARY KEY,owner_ref TEXT,account_ref TEXT,subject_ref TEXT,connection_epoch INTEGER,request_sequence INTEGER,wire_key TEXT,response_ref TEXT,payload_fingerprint TEXT,accepted INTEGER,reason_code TEXT,frame_json TEXT,recorded_at TEXT);
      CREATE TABLE backend_official_item_frames(observation_ref TEXT PRIMARY KEY,owner_ref TEXT,account_ref TEXT,subject_ref TEXT,connection_epoch INTEGER,request_sequence INTEGER,response_ref TEXT,wire_key TEXT,source_json TEXT,payload_json TEXT,recorded_at TEXT);`);
    operation(ledger, 'old-active-write', 1, 'reserved-seed', 'old-account-a');
    store.run('INSERT INTO backend_subject_bindings VALUES(?,?,?,?,?,?,?,?)', ctx.ownerRef, 'old-account-a', ctx.subjectRef,
      'fixture-stable-subject', 'fixture-v1', 'official', '{}', store.nowIso());
    const proof = insertLoginProof(store, { connectionEpoch: 2, requestSequence: 11,
      isolationEvidenceRef: 'login-boundary-only', isolationSourceRef: 'migration-fence' });
    const result = ledger.recordCurrentResourceBaseline({ context: ctx, ...proof, officialUid: 12345,
      versionEvidence: { source: 'normal-package-hop-and-matched-world-login/v1', gameVersion: '480.1.0',
        protocolVersion: '480.1.0', loginResponseRef: proof.responseRef } });
    assert.equal(result.recorded, true);
    assert.equal(result.linkedResources, 0,
      'a broad source fence cannot substitute for an exact closure of the old modern executor');
    const current = ledger.currentAdmission({ ownerRef: ctx.ownerRef, subjectRef: ctx.subjectRef });
    assert.deepEqual(current.resourceFootprints.map(item => item.operation_id), ['old-active-write']);
    assert.equal(current.resourceFootprints[0].quantity, 7);
    assert.equal(current.activeOperation.operation_id, 'old-active-write');
  } finally {
    store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
