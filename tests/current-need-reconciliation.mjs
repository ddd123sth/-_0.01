import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createBackendLedger } from '../runtime/backend/persistence/ledger.mjs';
import { createCurrentNeedReconciler } from '../runtime/backend/execution/current-need.mjs';
import { createDynamicStateCoordinator } from '../runtime/backend/facts/dynamic-state.mjs';
import { createLegacyConstraints } from '../runtime/backend/migration/legacy-constraints.mjs';
import { fingerprint } from '../runtime/backend/common.mjs';

const oldContext = { ownerRef: 'owner-a', accountRef: 'account-a', subjectRef: 'subject-a', ownerEpoch: 1, runEpoch: 1, connectionEpoch: 1 };
const newContext = { ...oldContext, ownerEpoch: 2, runEpoch: 1, connectionEpoch: 2 };
const need = (needNo = 1, targetRef = 'flower-art:subject-a:443841', responseRef = 'login-2') => {
  const businessNeedRef = 'business-need:' + fingerprint(['art.make', targetRef, 'parent-life-7', 'recipe-1', 2]);
  const decisionGeneration = fingerprint({ source: responseRef, needNo });
  const semanticFingerprint = fingerprint({ product: 443841, source: responseRef, needNo });
  return { necessary: true, featureId: 'art.make', targetRef, businessNeedRef, decisionGeneration, needRef:
    'current-need:' + fingerprint(['art.make', targetRef, businessNeedRef]), semanticFingerprint, basisRefs: [responseRef, 'bag-' + needNo] };
};
const snapshot = { complete: true, method: 'index.login', responseRef: 'login-2', requestSequence: 8, connectionEpoch: 2,
  identityVerified: true, officialUid: 12345, gameVersion: '480.0.27', protocolVersion: '480.0.0',
  sourceProofs: [{ kind: 'login', method: 'index.login', responseRef: 'login-2', requestSequence: 8, connectionEpoch: 2,
    gameVersion: '480.0.27', protocolVersion: '480.0.0' }] };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-current-need-'));
  const store = openBackendStore({ dataDir: root }), ledger = createBackendLedger(store);
  store.run(`CREATE TABLE backend_send_permits(permit_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,consumed INTEGER NOT NULL DEFAULT 0,
    wire_key TEXT,request_sequence INTEGER)`);
  store.db.exec(`CREATE TABLE backend_session_connection_closures(evidence_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,
    subject_ref TEXT NOT NULL,executor_ref TEXT NOT NULL,owner_epoch INTEGER,run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,
    proof_kind TEXT NOT NULL,proof_json TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
  createDynamicStateCoordinator({ store, isCurrent: () => true, monotonicNow: () => 10 });
  const original = { ownerRef: oldContext.ownerRef, accountRef: oldContext.accountRef, subjectRef: oldContext.subjectRef,
    ownerEpoch: oldContext.ownerEpoch, executorRef: 'old-executor', runEpoch: oldContext.runEpoch, connectionEpoch: oldContext.connectionEpoch,
    featureId: 'art.make', scope: 'flower-art-make', method: 'flowerArt.makeFlowerArt', semanticKey: 'art-make:old-unit',
    configRevision: 1, cancelEpoch: 0, paramsFingerprint: 'params-fp', factBasis: { version: 'art/v1', need: 1, officialIdentity: { uid: 12345 } },
    targets: [{ memberKey: 'art:old-unit', targetKind: 'flower-art-unit', targetRef: 'flower-art:subject-a:443841',
      lifecycleRef: 'old-unit', targetFingerprint: 'target-fp' }], resources: [], resourceBindings: [] };
  ledger.prepareOperation({ operationId: 'old-art-operation', proposalId: 'old-proposal', ...original });
  ledger.markMayHaveSent({ operationId: 'old-art-operation', evidence: { kind: 'send-boundary-prepared', source: 'test', payload: { accepted: true } } });
  ledger.recordTransport({ operationId: 'old-art-operation', transportState: 'unknown',
    evidence: { kind: 'transport-unknown', source: 'test', payload: { responseUnproven: true } },
    releaseWriteSlot: true, transportTermination: { ended: true, source: 'physical-close-receipt' } });
  ledger.settleOperation({ operationId: 'old-art-operation', businessVerdict: 'unknown', verificationVersion: 'test/v1',
    evidence: { kind: 'business-verification', source: 'test', payload: { outcome: 'unknown' } } });
  let liveSnapshot = snapshot;
  const isolationEvidence = { read: ({ context, operationId }) => {
    const operation = ledger.operation(operationId), closure = store.get(`SELECT evidence_ref,proof_json FROM backend_session_connection_closures
      WHERE owner_ref=? AND account_ref=? AND subject_ref=? AND owner_epoch=? AND run_epoch=? AND connection_epoch=? AND executor_ref=?`,
    operation.owner_ref, String(operation.account_ref), operation.subject_ref, original.ownerEpoch, operation.run_epoch,
    operation.connection_epoch, original.executorRef);
    if (!closure) return { available: false };
    const savedProof = JSON.parse(closure.proof_json), currentCheckpoint = { ...context, accountRef: String(context.accountRef),
      uid: liveSnapshot.officialUid, serverId: 1, responseRef: liveSnapshot.responseRef, requestSequence: liveSnapshot.requestSequence,
      wireKey: 'ws|1793000000000|' + liveSnapshot.requestSequence, gameVersion: liveSnapshot.gameVersion, protocolVersion: liveSnapshot.protocolVersion };
    const previousExecution = { kind: 'backend-physical-closure', closed: true, executionClosed: true,
      evidenceRef: closure.evidence_ref, evidenceHash: fingerprint(savedProof), ownerRef: operation.owner_ref,
      accountRef: String(operation.account_ref), subjectRef: operation.subject_ref, ownerEpoch: original.ownerEpoch,
      runEpoch: operation.run_epoch, connectionEpoch: operation.connection_epoch, executorRef: original.executorRef };
    const isolatedOriginal = { kind: 'backend', operationId, ownerRef: operation.owner_ref, accountRef: String(operation.account_ref),
      subjectRef: operation.subject_ref, ownerEpoch: original.ownerEpoch, runEpoch: operation.run_epoch,
      connectionEpoch: operation.connection_epoch, executorRef: original.executorRef, originalFingerprint: operation.original_fingerprint };
    const receipt = { version: 'current-execution-isolation/v1', currentCheckpoint, previousExecution, original: isolatedOriginal,
      outcomeProven: false, resourceCoverageProven: false }, receiptHash = fingerprint(receipt);
    return { ...receipt, available: true, receiptHash, receiptRef: 'current-isolation:' + receiptHash };
  } };
  const reconciler = createCurrentNeedReconciler({ store, ledgerView: ledger, isolationEvidence });
  const acceptSnapshot = (context, current) => {
    liveSnapshot = current;
    store.run(`INSERT OR REPLACE INTO backend_dynamic_domain_cells(owner_ref,account_ref,subject_ref,domain_id,path,owner_epoch,run_epoch,
      connection_epoch,semantic_fingerprint,source_ref,source_method,request_sequence,observed_at_ms,updated_at,observed_monotonic_ms,instance_ref)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, context.ownerRef, String(context.accountRef), context.subjectRef, 'profile', 'profile.uid',
    context.ownerEpoch, context.runEpoch, current.connectionEpoch, fingerprint(current.officialUid), current.responseRef, current.method,
    current.requestSequence, Date.now(), store.nowIso(), 10, 'test-instance');
    store.run(`INSERT OR IGNORE INTO backend_dynamic_login_identity_anchors(owner_ref,account_ref,subject_ref,owner_epoch,run_epoch,
      connection_epoch,response_ref,request_sequence,official_uid,game_version,protocol_version,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    context.ownerRef, String(context.accountRef), context.subjectRef, context.ownerEpoch, context.runEpoch, current.connectionEpoch,
    current.responseRef, current.requestSequence, current.officialUid, current.gameVersion, current.protocolVersion, store.nowIso());
    store.run(`INSERT OR REPLACE INTO backend_dynamic_domain_cells(owner_ref,account_ref,subject_ref,domain_id,path,owner_epoch,run_epoch,
      connection_epoch,semantic_fingerprint,source_ref,source_method,request_sequence,observed_at_ms,updated_at,observed_monotonic_ms,instance_ref)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, context.ownerRef, String(context.accountRef), context.subjectRef, 'profile', 'profile.anchor',
    context.ownerEpoch, context.runEpoch, current.connectionEpoch, fingerprint(current.officialUid), current.responseRef, current.method,
    current.requestSequence, Date.now(), store.nowIso(), 10, 'test-instance');
  };
  const acceptSource = (context, source, domain = 'land', pathName = 'land.test') => store.run(`INSERT OR REPLACE INTO backend_dynamic_domain_cells(
    owner_ref,account_ref,subject_ref,domain_id,path,owner_epoch,run_epoch,connection_epoch,semantic_fingerprint,source_ref,source_method,
    request_sequence,observed_at_ms,updated_at,observed_monotonic_ms,instance_ref) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  context.ownerRef, String(context.accountRef), context.subjectRef, domain, pathName, context.ownerEpoch, context.runEpoch,
  source.connectionEpoch, fingerprint(pathName), source.responseRef, source.method, source.requestSequence, Date.now(), store.nowIso(), 11, 'test-instance');
  acceptSnapshot(newContext, snapshot);
  const addClosure = () => store.run('INSERT INTO backend_session_connection_closures VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    'close-old', oldContext.ownerRef, oldContext.accountRef, oldContext.subjectRef, 'old-executor', oldContext.ownerEpoch,
    oldContext.runEpoch, oldContext.connectionEpoch, 'transport-closed', JSON.stringify({ closed: true, connectionEpoch: 1, source: 'transport-close-receipt' }), store.nowIso());
  return { root, store, ledger, reconciler, original: ledger.operation('old-art-operation'), addClosure, acceptSnapshot, acceptSource,
    close: () => { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('synthetic protocol unit: a closed historical unknown gains only a new current-need reconciliation', () => {
  const h = setup();
  try {
    const args = { context: newContext, originalOperationId: 'old-art-operation', currentSnapshot: snapshot, currentNeed: need() };
    assert.equal(h.reconciler.reconcile(args).reasonCode, 'CURRENT_NEED_OLD_EXECUTOR_NOT_CLOSED');
    h.addClosure();
    const result = h.reconciler.reconcile(args);
    assert.equal(result.accepted, true);
    assert.equal(result.replayed, false);
    const replay = h.reconciler.reconcile(args);
    assert.equal(replay.replayed, true);
    assert.equal(replay.claimRef, result.claimRef, 'reconciliation replay returns the reusable stable claim reference');
    const nextSnapshot = { ...snapshot, responseRef: 'login-3', connectionEpoch: 3, requestSequence: 1,
      sourceProofs: [{ method: 'index.login', responseRef: 'login-3', requestSequence: 1, connectionEpoch: 3 }] };
    const nextContext = { ...newContext, connectionEpoch: 3 };
    h.acceptSnapshot(nextContext, nextSnapshot);
    assert.equal(h.reconciler.reconcile({ ...args, context: nextContext, currentSnapshot: nextSnapshot, currentNeed: need(2, undefined, 'login-3') }).accepted, true,
      'the same stable business need may be independently re-evaluated under a newer full snapshot');
    const immutable = h.ledger.operation('old-art-operation');
    assert.equal(immutable.business_verdict, 'unknown');
    assert.equal(immutable.original_fingerprint, h.original.original_fingerprint);
    assert.equal(h.store.get('SELECT COUNT(*) AS n FROM backend_current_need_reconciliations').n, 2);
  } finally { h.close(); }
});

test('synthetic protocol unit: no reconciliation for active writes, stale snapshots, unrelated targets, or conflicting UID evidence', () => {
  const h = setup();
  try {
    h.addClosure();
    const base = { context: newContext, originalOperationId: 'old-art-operation', currentSnapshot: snapshot, currentNeed: need() };
    assert.equal(h.reconciler.reconcile({ ...base, currentSnapshot: { ...snapshot, connectionEpoch: 1 } }).reasonCode,
      'CURRENT_NEED_PROOF_SNAPSHOT_SOURCE_INVALID');
    assert.equal(h.reconciler.reconcile({ ...base, currentNeed: need(1, 'other-target') }).reasonCode,
      'CURRENT_NEED_ORIGINAL_BINDING_UNPROVEN');
    h.store.run("UPDATE backend_operations SET write_slot=1 WHERE operation_id='old-art-operation'");
    assert.equal(h.reconciler.reconcile(base).reasonCode, 'CURRENT_NEED_ORIGINAL_BINDING_UNPROVEN');
    h.store.run("UPDATE backend_operations SET write_slot=0 WHERE operation_id='old-art-operation'");
    assert.equal(h.reconciler.reconcile({ ...base, currentSnapshot: { ...snapshot, officialUid: 54321 } }).reasonCode,
      'CURRENT_NEED_IDENTITY_CONFLICT');
  } finally { h.close(); }
});

test('synthetic protocol unit: one current snapshot claim has one operation owner at the send fence', () => {
  const h = setup();
  try {
    const currentNeed = need(), args = { context: newContext, currentSnapshot: snapshot, currentNeed };
    const claim = h.reconciler.claimCurrent(args);
    assert.equal(claim.accepted, true);
    const claimedNeed = { ...currentNeed, claimRef: claim.claimRef };
    assert.equal(h.reconciler.consumeCurrentNeed({ claimRef: claim.claimRef, operationId: 'candidate-a',
      decisionGeneration: currentNeed.decisionGeneration, currentNeed: { ...claimedNeed, targetRef: 'other-target' },
      featureId: currentNeed.featureId }).reasonCode, 'CURRENT_NEED_CLAIM_NOT_CURRENT');
    assert.equal(h.reconciler.consumeCurrentNeed({ claimRef: claim.claimRef, operationId: 'candidate-a', decisionGeneration: currentNeed.decisionGeneration,
      currentNeed: claimedNeed, featureId: currentNeed.featureId }).accepted, true);
    assert.equal(h.reconciler.isClaimCurrent({ ...args, claimRef: claim.claimRef, operationId: 'candidate-a' }).accepted, true);
    assert.equal(h.reconciler.isClaimCurrent({ ...args, claimRef: claim.claimRef, operationId: 'candidate-b' }).reasonCode,
      'CURRENT_NEED_CLAIM_OPERATION_NOT_OWNER');
    const changedDecision = { ...claimedNeed, decisionGeneration: fingerprint('different-generation'), semanticFingerprint: fingerprint('different-semantic') };
    assert.equal(h.reconciler.isClaimCurrent({ ...args, currentNeed: changedDecision, claimRef: claim.claimRef,
      operationId: 'candidate-a' }).reasonCode, 'CURRENT_NEED_CLAIM_NOT_CURRENT',
      'ownership cannot be detached from its consumed decision version');
    assert.equal(h.reconciler.consumeCurrentNeed({ claimRef: claim.claimRef, operationId: 'candidate-b', decisionGeneration: currentNeed.decisionGeneration,
      currentNeed: claimedNeed, featureId: currentNeed.featureId }).reasonCode,
      'CURRENT_NEED_CLAIM_ALREADY_CONSUMED');
    assert.equal(h.store.get('SELECT operation_id FROM backend_current_need_claim_owners WHERE claim_ref=?', claim.claimRef).operation_id, 'candidate-a');
  } finally { h.close(); }
});

test('shared opportunity markers are accepted only for the registered all-enter action scope', () => {
  const h = setup();
  try {
    const invalid = { ...need(), sharedOpportunity: 'order-flower-enter-all/v1', method: 'orderFlower.enter' };
    assert.equal(h.reconciler.claimCurrent({ context: newContext, currentSnapshot: snapshot, currentNeed: invalid }).reasonCode,
      'CURRENT_NEED_PROOF_SHARED_OPPORTUNITY_INVALID');
  } finally { h.close(); }
});

test('synthetic protocol unit: local decision changes share the official source claim; a new accepted login creates a new claim', () => {
  const h = setup();
  try {
    const first = need(1), second = need(2), one = h.reconciler.claimCurrent({ context: newContext, currentSnapshot: snapshot, currentNeed: first });
    const two = h.reconciler.claimCurrent({ context: newContext, currentSnapshot: snapshot, currentNeed: second });
    assert.equal(one.accepted, true);
    assert.equal(two.accepted, true);
    assert.equal(one.claimRef, two.claimRef, 'policy/semantic changes cannot mint a second official snapshot claim');
    const nextSnapshot = { ...snapshot, responseRef: 'login-3', connectionEpoch: 3, requestSequence: 1,
      sourceProofs: [{ method: 'index.login', responseRef: 'login-3', requestSequence: 1, connectionEpoch: 3 }] };
    const nextContext = { ...newContext, connectionEpoch: 3 };
    h.acceptSnapshot(nextContext, nextSnapshot);
    const nextNeed = need(2, undefined, 'login-3');
    const next = h.reconciler.claimCurrent({ context: nextContext, currentSnapshot: nextSnapshot, currentNeed: nextNeed });
    assert.equal(next.accepted, true);
    assert.notEqual(next.claimRef, one.claimRef, 'only an accepted new official source creates a distinct claim');
    assert.equal(h.store.get('SELECT COUNT(*) AS n FROM backend_current_need_claims').n, 2);
  } finally { h.close(); }
});

test('synthetic protocol unit: caller booleans cannot authorize an unaccepted login source or mismatched UID cell', () => {
  const h = setup();
  try {
    const forgedLogin = { ...snapshot, responseRef: 'login-not-ingested', sourceProofs: [{ method: 'index.login',
      responseRef: 'login-not-ingested', requestSequence: snapshot.requestSequence, connectionEpoch: snapshot.connectionEpoch }] };
    assert.equal(h.reconciler.claimCurrent({ context: newContext, currentSnapshot: forgedLogin, currentNeed: { ...need(), basisRefs: ['login-not-ingested'] } }).reasonCode,
      'CURRENT_NEED_SOURCE_NOT_ACCEPTED');
    const wrongUid = { ...snapshot, officialUid: 99999 };
    assert.equal(h.reconciler.claimCurrent({ context: newContext, currentSnapshot: wrongUid, currentNeed: need() }).reasonCode,
      'CURRENT_NEED_SOURCE_NOT_ACCEPTED');
  } finally { h.close(); }
});

test('synthetic protocol unit: source order and duplicates normalize identically through claim and consumption', () => {
  const h = setup();
  try {
    const extra = { method: 'usrLand.refresh', responseRef: 'land-read-2', requestSequence: 7, connectionEpoch: 2 };
    h.acceptSource(newContext, extra);
    const sources = [...snapshot.sourceProofs, extra];
    const firstSnapshot = { ...snapshot, sourceProofs: sources };
    const secondSnapshot = { ...snapshot, sourceProofs: [extra, ...snapshot.sourceProofs, extra] };
    const currentNeed = { ...need(), basisRefs: ['login-2', 'land-read-2'] };
    const first = h.reconciler.claimCurrent({ context: newContext, currentSnapshot: firstSnapshot, currentNeed });
    const second = h.reconciler.claimCurrent({ context: newContext, currentSnapshot: secondSnapshot, currentNeed: { ...currentNeed,
      decisionGeneration: fingerprint('changed-local-policy'), semanticFingerprint: fingerprint('changed-proposal') } });
    assert.equal(first.accepted, true);
    assert.equal(second.accepted, true);
    assert.equal(first.claimRef, second.claimRef);
    const ownedNeed = { ...currentNeed, claimRef: first.claimRef };
    assert.equal(h.reconciler.consumeCurrentNeed({ claimRef: first.claimRef, operationId: 'candidate-source-order',
      decisionGeneration: currentNeed.decisionGeneration, currentNeed: ownedNeed, featureId: currentNeed.featureId }).accepted, true);
  } finally { h.close(); }
});

test('synthetic protocol unit: accepted login UID anchor survives a newer same-UID profile cell source', () => {
  const h = setup();
  try {
    const update = { method: 'usrLand.harvest', responseRef: 'profile-update-9', requestSequence: 9, connectionEpoch: 2 };
    h.acceptSource(newContext, update, 'profile', 'profile.uid');
    h.acceptSource(newContext, update, 'profile', 'profile.anchor');
    const body = { context: newContext, currentSnapshot: snapshot, currentNeed: need() };
    const claim = h.reconciler.claimCurrent(body);
    assert.equal(claim.accepted, true, 'the login identity anchor remains valid while mutable UID cell provenance advances');
    assert.equal(h.store.get(`SELECT source_ref,source_method FROM backend_dynamic_domain_cells WHERE owner_ref=? AND subject_ref=?
      AND domain_id='profile' AND path='profile.uid'`, newContext.ownerRef, newContext.subjectRef).source_method, 'usrLand.harvest');
  } finally { h.close(); }
});

test('synthetic protocol unit: shared legacy candidate projection separates only a closed target under a verified current baseline', () => {
  const h = setup();
  try {
    const legacy = createLegacyConstraints({ store: h.store, cipher: { decrypt: () => { throw new Error('not used'); } } });
    const operationRef = 'legacy-op-current-candidate', sourceFingerprint = fingerprint('legacy immutable source');
    h.store.run(`INSERT INTO backend_legacy_operation_index(operation_ref,transfer_id,archive_id,owner_ref,account_ref,subject_ref,
      source_origin_key,source_operation_id,source_version,source_fingerprint,feature_id,scope,method,unresolved,recorded_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`, operationRef, 'legacy-transfer', 'legacy-archive', newContext.ownerRef,
    newContext.accountRef, newContext.subjectRef, 'legacy-origin', 'legacy-source-op', 'v1', sourceFingerprint,
    'art.make', 'flower-art-make', 'flowerArt.makeFlowerArt', h.store.nowIso());
    h.store.run(`INSERT INTO backend_legacy_constraint_index(constraint_ref,transfer_id,archive_id,operation_ref,source_operation_id,
      source_origin_key,owner_ref,account_ref,subject_ref,kind,raw_ref,source_fingerprint,recorded_at)
      VALUES(?,?,?,?,?,?,?,?,?,'target',?,?,?)`, 'legacy-target-constraint', 'legacy-transfer', 'legacy-archive', operationRef,
    'legacy-source-op', 'legacy-part-target', newContext.ownerRef, newContext.accountRef, newContext.subjectRef,
    'flower-art:subject-a:443841', fingerprint('legacy target source'), h.store.nowIso());
    const orphanFingerprint = fingerprint('legacy orphan target source');
    h.store.run(`INSERT INTO backend_legacy_constraint_index(constraint_ref,transfer_id,archive_id,operation_ref,source_operation_id,
      source_origin_key,owner_ref,account_ref,subject_ref,kind,raw_ref,source_fingerprint,recorded_at)
      VALUES(?,?,?,NULL,?,?,?,?,?,'target',?,?,?)`, 'legacy-orphan-target', 'legacy-transfer', 'legacy-orphan-archive',
    'orphan-source-op', 'legacy-orphan-origin', newContext.ownerRef, newContext.accountRef, newContext.subjectRef,
    'flower-art:subject-a:443841', orphanFingerprint, h.store.nowIso());
    const baselineRef = 'baseline-current-candidate', baselineFingerprint = fingerprint('verified bag fixture');
    const baselineEvidence = { version: 'current-resource-baseline/closed-executor-complete-login-bag/v2',
      login: { sourceRef: 'land-observation:login-2', responseRef: snapshot.responseRef, requestSequence: snapshot.requestSequence,
        connectionEpoch: snapshot.connectionEpoch, sourceFingerprint: baselineFingerprint, officialUid: snapshot.officialUid,
        absoluteBagComplete: true, absoluteItemFrameRef: 'items-login-2' },
      accountingSeparation: 'current-absolute-resource-accounting-only; does-not-prove-historical-success-or-consumption; does-not-authorize-replay' };
    h.store.run(`INSERT INTO backend_resource_budget_baselines(baseline_ref,owner_ref,account_ref,subject_ref,connection_epoch,request_sequence,
      response_ref,operation_rowid,source_fingerprint,isolation_evidence_ref,evidence_json,recorded_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, baselineRef, newContext.ownerRef, newContext.accountRef, newContext.subjectRef,
    snapshot.connectionEpoch, snapshot.requestSequence, snapshot.responseRef, 0, baselineFingerprint, '', JSON.stringify(baselineEvidence), h.store.nowIso());
    const currentNeed = need(), claimed = h.reconciler.claimCurrent({ context: newContext, currentSnapshot: snapshot, currentNeed });
    const withClaim = { ...currentNeed, claimRef: claimed.claimRef };
    const checkpoint = { ownerRef: newContext.ownerRef, accountRef: newContext.accountRef, subjectRef: newContext.subjectRef,
      ownerEpoch: newContext.ownerEpoch, runEpoch: newContext.runEpoch, connectionEpoch: newContext.connectionEpoch,
      uid: snapshot.officialUid, responseRef: snapshot.responseRef, requestSequence: snapshot.requestSequence,
      gameVersion: snapshot.gameVersion, protocolVersion: snapshot.protocolVersion };
    const previousExecution = { kind: 'legacy-signed-migration-fence', closed: true, executionClosed: true };
    const isolationEvidence = { read: input => {
      const original = input.legacyConstraintRef ? { kind: 'legacy-constraint', constraintRef: input.legacyConstraintRef,
        ownerRef: newContext.ownerRef, subjectRef: newContext.subjectRef,
        sourceFingerprint: input.legacyConstraintRef === 'legacy-orphan-target' ? orphanFingerprint : fingerprint('wrong source row') } :
        { kind: 'legacy', operationRef, ownerRef: newContext.ownerRef, subjectRef: newContext.subjectRef, sourceFingerprint };
      const receiptBody = { version: 'current-execution-isolation/v1', currentCheckpoint: checkpoint, previousExecution,
        original, outcomeProven: false, resourceCoverageProven: false };
      return { ...receiptBody, available: true, receiptHash: fingerprint(receiptBody), receiptRef: 'current-isolation:' + fingerprint(receiptBody) };
    } };
    const candidateFingerprint = fingerprint('current candidate');
    const result = h.reconciler.reconcileLegacyCandidate({ context: newContext, currentSnapshot: snapshot, currentNeed: withClaim,
      legacyConstraints: legacy, isolationEvidence, rawTargetRefs: ['flower-art:subject-a:443841'], rawResourceKeys: [],
      semanticKey: 'new-art-need', factBasis: { version: 'test/current-candidate', currentNeed: withClaim.needRef },
      candidateFingerprint, action: 'flowerArt.makeFlowerArt', methodScope: ['flowerArt.makeFlowerArt'], resourceBaselineRef: baselineRef });
    assert.equal(result.accepted, true, JSON.stringify(result));
    assert.deepEqual(result.projection.separatedOperations.map(row => row.operation_ref), [operationRef]);
    assert.equal(result.projection.matchedTargets.length, 0, 'the exact old target no longer blocks this current candidate');
    assert.equal(result.projection.targets.length, 0, 'an orphan target is separated only by its own constraint proof, without a fake operation id');
    h.store.run(`INSERT INTO backend_legacy_constraint_index(constraint_ref,transfer_id,archive_id,operation_ref,source_operation_id,
      source_origin_key,owner_ref,account_ref,subject_ref,kind,raw_ref,source_fingerprint,recorded_at)
      VALUES(?,?,?,?,?,?,?,?,?,'target',?,?,?)`, 'legacy-dangling-wrong-source', 'legacy-transfer', 'legacy-orphan-archive-2',
    'dangling-parent-op-2', 'orphan-source-op-2', 'legacy-orphan-origin-2', newContext.ownerRef, newContext.accountRef, newContext.subjectRef,
    'flower-art:subject-a:443841', fingerprint('actual immutable source row'), h.store.nowIso());
    const wrongSource = h.reconciler.reconcileLegacyCandidate({ context: newContext, currentSnapshot: snapshot, currentNeed: withClaim,
      legacyConstraints: legacy, isolationEvidence, rawTargetRefs: ['flower-art:subject-a:443841'], rawResourceKeys: [],
      semanticKey: 'new-art-need', factBasis: { version: 'test/current-candidate', currentNeed: withClaim.needRef },
      candidateFingerprint, action: 'flowerArt.makeFlowerArt', methodScope: ['flowerArt.makeFlowerArt'], resourceBaselineRef: baselineRef });
    assert.equal(wrongSource.accepted, false, 'a dangling parent does not bypass constraint source fingerprint validation');
    assert.equal(wrongSource.reasonCode, 'CURRENT_NEED_LEGACY_CONSTRAINT_SOURCE_UNPROVEN');
    assert.equal(h.store.get('SELECT unresolved,business_verdict FROM backend_legacy_operation_index WHERE operation_ref=?', operationRef).unresolved, 1,
      'the historical unknown remains unchanged');
  } finally { h.close(); }
});

test('synthetic protocol unit: claim ownership, ledger preparation, and permit commit or roll back together', () => {
  const h = setup();
  try {
    const currentNeed = need(), claim = h.reconciler.claimCurrent({ context: newContext, currentSnapshot: snapshot, currentNeed });
    const claimedNeed = { ...currentNeed, claimRef: claim.claimRef };
    const operation = operationId => ({ operationId, proposalId: 'proposal-' + operationId, ownerRef: newContext.ownerRef,
      accountRef: newContext.accountRef, subjectRef: newContext.subjectRef, ownerEpoch: newContext.ownerEpoch, executorRef: 'new-executor',
      featureId: 'art.make', scope: 'flower-art-make', method: 'flowerArt.makeFlowerArt', semanticKey: 'art-make:current:' + currentNeed.decisionGeneration,
      paramsFingerprint: 'params-' + operationId, runEpoch: newContext.runEpoch, connectionEpoch: newContext.connectionEpoch,
      configRevision: 1, cancelEpoch: 0, factBasis: { version: 'test/current-need', decisionGeneration: currentNeed.decisionGeneration },
      targets: [{ memberKey: 'art:unit-current', targetKind: 'flower-art-unit', targetRef: currentNeed.targetRef,
        lifecycleRef: 'unit-current', targetFingerprint: 'target-current' }], resources: [], resourceBindings: [] });
    const consume = operationId => h.reconciler.consumeCurrentNeed({ claimRef: claim.claimRef, operationId,
      decisionGeneration: currentNeed.decisionGeneration, currentNeed: claimedNeed, featureId: currentNeed.featureId });
    assert.throws(() => h.store.transaction(() => {
      assert.equal(consume('candidate-rollback').accepted, true);
      h.ledger.prepareOperation(operation('candidate-rollback'));
      h.store.run('INSERT INTO backend_send_permits(permit_id,operation_id,consumed,wire_key,request_sequence) VALUES(?,?,0,NULL,NULL)',
        'permit-rollback', 'candidate-rollback');
      throw new Error('injected prepare transaction failure');
    }), /injected prepare transaction failure/);
    assert.equal(h.store.get('SELECT 1 FROM backend_current_need_claim_owners WHERE claim_ref=?', claim.claimRef), null);
    assert.equal(h.ledger.operation('candidate-rollback'), null);
    h.store.transaction(() => {
      assert.equal(consume('candidate-live').accepted, true);
      h.ledger.prepareOperation(operation('candidate-live'));
      h.store.run('INSERT INTO backend_send_permits(permit_id,operation_id,consumed,wire_key,request_sequence) VALUES(?,?,0,NULL,NULL)',
        'permit-live', 'candidate-live');
    });
    assert.equal(consume('candidate-racer').reasonCode, 'CURRENT_NEED_CLAIM_ALREADY_CONSUMED');
    assert.equal(h.store.get('SELECT operation_id FROM backend_send_permits WHERE permit_id=?', 'permit-live').operation_id, 'candidate-live');
  } finally { h.close(); }
});
