import { canonical, fingerprint, freeze, parseStored } from '../common.mjs';
import { hashLedgerBytes, ledgerJsonFingerprint } from '../persistence/json-contract.mjs';
import { currentNeedOwnerEligibility } from './current-need-ownership.mjs';

const positive = value => Number.isSafeInteger(value) && value > 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const denied = reasonCode => freeze({ accepted: false, reasonCode });
const normalizedSources = sourceProofs => [...new Map(sourceProofs.map(one => {
  const source = { method: one.method, responseRef: one.responseRef, requestSequence: one.requestSequence, connectionEpoch: one.connectionEpoch };
  return [canonical(source), source];
})).values()].sort((a, b) => a.connectionEpoch - b.connectionEpoch || a.requestSequence - b.requestSequence ||
  a.method.localeCompare(b.method) || a.responseRef.localeCompare(b.responseRef));

// Reconciliation keeps the original unknown operation immutable. It only
// records that a newer, complete official snapshot independently proves a
// current need after the exact old executor has closed.
export function createCurrentNeedReconciler({ store, ledgerView, isolationEvidence } = {}) {
  for (const [name, fn] of Object.entries({ run: store?.run, get: store?.get, all: store?.all, transaction: store?.transaction,
    nowIso: store?.nowIso, operation: ledgerView?.operation })) {
    if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') throw new TypeError('Current-need reconciler requires synchronous port: ' + name);
  }
  store.run(`CREATE TABLE IF NOT EXISTS backend_current_need_reconciliations(
    reconciliation_ref TEXT PRIMARY KEY,claim_ref TEXT NOT NULL,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    original_operation_id TEXT NOT NULL,original_fingerprint TEXT NOT NULL,feature_id TEXT NOT NULL,target_ref TEXT NOT NULL,
    current_need_ref TEXT NOT NULL,current_snapshot_ref TEXT NOT NULL,current_connection_epoch INTEGER NOT NULL,
    evidence_json TEXT NOT NULL,evidence_fingerprint TEXT NOT NULL,recorded_at TEXT NOT NULL,
    UNIQUE(claim_ref,original_operation_id))`);
  store.run(`CREATE INDEX IF NOT EXISTS backend_current_need_reconciliations_by_target
    ON backend_current_need_reconciliations(owner_ref,subject_ref,original_operation_id,feature_id,target_ref,original_fingerprint)`);
  store.run(`CREATE TABLE IF NOT EXISTS backend_current_need_claims(
    claim_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,feature_id TEXT NOT NULL,
    target_ref TEXT NOT NULL,business_need_ref TEXT NOT NULL,current_snapshot_ref TEXT NOT NULL,current_connection_epoch INTEGER NOT NULL,
    decision_generation TEXT NOT NULL,semantic_fingerprint TEXT NOT NULL,evidence_json TEXT NOT NULL,evidence_fingerprint TEXT NOT NULL,
    recorded_at TEXT NOT NULL,UNIQUE(owner_ref,subject_ref,business_need_ref,current_snapshot_ref))`);
  store.run(`CREATE TABLE IF NOT EXISTS backend_current_need_claim_versions(
    version_ref TEXT PRIMARY KEY,claim_ref TEXT NOT NULL,decision_generation TEXT NOT NULL,semantic_fingerprint TEXT NOT NULL,
    evidence_json TEXT NOT NULL,evidence_fingerprint TEXT NOT NULL,recorded_at TEXT NOT NULL,UNIQUE(claim_ref,decision_generation,semantic_fingerprint))`);
  store.run(`CREATE TABLE IF NOT EXISTS backend_current_need_claim_owners(
    claim_ref TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,decision_generation TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
  store.run(`CREATE TABLE IF NOT EXISTS backend_current_need_claim_owner_events(
    event_ref TEXT PRIMARY KEY,claim_ref TEXT NOT NULL,previous_operation_id TEXT,new_operation_id TEXT NOT NULL,
    decision_generation TEXT NOT NULL,reason_code TEXT NOT NULL,evidence_json TEXT NOT NULL,evidence_fingerprint TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
  store.run(`CREATE TRIGGER IF NOT EXISTS backend_current_need_claim_owner_events_no_update BEFORE UPDATE ON backend_current_need_claim_owner_events
    BEGIN SELECT RAISE(ABORT,'current-need claim owner events are append only'); END`);
  store.run(`CREATE TRIGGER IF NOT EXISTS backend_current_need_claim_owner_events_no_delete BEFORE DELETE ON backend_current_need_claim_owner_events
    BEGIN SELECT RAISE(ABORT,'current-need claim owner events are append only'); END`);
  const existing = store.get("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='backend_current_need_reconciliations_immutable'");
  if (!existing) store.run(`CREATE TRIGGER backend_current_need_reconciliations_immutable BEFORE UPDATE ON backend_current_need_reconciliations
    BEGIN SELECT RAISE(ABORT,'current-need reconciliation evidence is append only'); END`);
  if (!store.get("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='backend_current_need_reconciliations_no_delete'")) store.run(`CREATE TRIGGER backend_current_need_reconciliations_no_delete BEFORE DELETE ON backend_current_need_reconciliations
    BEGIN SELECT RAISE(ABORT,'current-need reconciliation evidence is append only'); END`);
  if (!store.get("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='backend_current_need_claims_immutable'")) store.run(`CREATE TRIGGER backend_current_need_claims_immutable BEFORE UPDATE ON backend_current_need_claims
    BEGIN SELECT RAISE(ABORT,'current-need claims are append only'); END`);
  if (!store.get("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='backend_current_need_claims_no_delete'")) store.run(`CREATE TRIGGER backend_current_need_claims_no_delete BEFORE DELETE ON backend_current_need_claims
    BEGIN SELECT RAISE(ABORT,'current-need claims are append only'); END`);
  for (const [name, action] of [['backend_current_need_claim_versions_no_update', 'UPDATE'], ['backend_current_need_claim_versions_no_delete', 'DELETE']]) {
    if (!store.get('SELECT 1 FROM sqlite_master WHERE type=\'trigger\' AND name=?', name)) store.run(`CREATE TRIGGER ${name} BEFORE ${action} ON backend_current_need_claim_versions
      BEGIN SELECT RAISE(ABORT,'current-need claim versions are append only'); END`);
  }

  function validateCurrent({ context, currentSnapshot, currentNeed } = {}) {
    if (!context || !reference(context.ownerRef) || !reference(context.accountRef) || !reference(context.subjectRef) ||
      !positive(context.ownerEpoch) || !positive(context.connectionEpoch)) return 'CURRENT_NEED_PROOF_CONTEXT_INVALID';
    if (currentSnapshot?.complete !== true) return 'CURRENT_NEED_PROOF_SNAPSHOT_NOT_COMPLETE';
    if (currentSnapshot.identityVerified !== true || currentSnapshot.method !== 'index.login') return 'CURRENT_NEED_PROOF_SNAPSHOT_IDENTITY_INVALID';
    if (!reference(currentSnapshot.responseRef) || !positive(currentSnapshot.requestSequence) || currentSnapshot.connectionEpoch !== context.connectionEpoch) return 'CURRENT_NEED_PROOF_SNAPSHOT_SOURCE_INVALID';
    if (!positive(currentSnapshot.officialUid) || !reference(currentSnapshot.gameVersion) || !reference(currentSnapshot.protocolVersion)) return 'CURRENT_NEED_PROOF_SNAPSHOT_VERSION_INVALID';
    if (!Array.isArray(currentSnapshot.sourceProofs) || !currentSnapshot.sourceProofs.length || currentSnapshot.sourceProofs.some(one =>
      !one || !reference(one.responseRef) || !reference(one.method) || !positive(one.requestSequence) || one.connectionEpoch !== context.connectionEpoch ||
      !Array.isArray(currentNeed?.basisRefs) || !currentNeed.basisRefs.includes(one.responseRef))) return 'CURRENT_NEED_PROOF_SOURCE_SET_INCOMPLETE';
    if (currentNeed?.necessary !== true || !reference(currentNeed.featureId) || !reference(currentNeed.targetRef) || !reference(currentNeed.businessNeedRef) ||
      !digest(currentNeed.decisionGeneration) || !digest(currentNeed.semanticFingerprint) ||
      currentNeed.needRef !== 'current-need:' + fingerprint([currentNeed.featureId, currentNeed.targetRef, currentNeed.businessNeedRef])) return 'CURRENT_NEED_PROOF_NEED_IDENTITY_INVALID';
    if (currentNeed.sharedOpportunity !== undefined && !validSharedOpportunity(currentNeed, context.subjectRef))
      return 'CURRENT_NEED_PROOF_SHARED_OPPORTUNITY_INVALID';
    if (!Array.isArray(currentNeed.basisRefs) || !currentNeed.basisRefs.length || currentNeed.basisRefs.some(ref => !reference(ref)) ||
      !currentNeed.basisRefs.includes(currentSnapshot.responseRef)) return 'CURRENT_NEED_PROOF_BASIS_INVALID';
    return null;
  }
  function decisionSnapshotRef(context, currentSnapshot) {
    const sources = normalizedSources(currentSnapshot.sourceProofs);
    if (!sources.some(one => one.method === 'index.login' && one.responseRef === currentSnapshot.responseRef &&
      one.requestSequence === currentSnapshot.requestSequence && one.connectionEpoch === currentSnapshot.connectionEpoch)) return null;
    const loginUid = store.get(`SELECT 1 FROM backend_dynamic_login_identity_anchors WHERE owner_ref=? AND account_ref=? AND subject_ref=?
      AND owner_epoch=? AND run_epoch=? AND connection_epoch=? AND response_ref=? AND request_sequence=? AND official_uid=?
      AND game_version=? AND protocol_version=? LIMIT 1`,
    context.ownerRef, String(context.accountRef), context.subjectRef, context.ownerEpoch, context.runEpoch, currentSnapshot.connectionEpoch,
    currentSnapshot.responseRef, currentSnapshot.requestSequence, currentSnapshot.officialUid, currentSnapshot.gameVersion, currentSnapshot.protocolVersion);
    if (!loginUid) return null;
    for (const source of sources) {
      if (source.method === 'index.login' && source.responseRef === currentSnapshot.responseRef &&
          source.requestSequence === currentSnapshot.requestSequence && source.connectionEpoch === currentSnapshot.connectionEpoch) continue;
      const accepted = store.get(`SELECT 1 FROM backend_dynamic_domain_cells WHERE owner_ref=? AND account_ref=? AND subject_ref=? AND owner_epoch=?
        AND run_epoch=? AND connection_epoch=? AND source_ref=? AND source_method=? AND request_sequence=? LIMIT 1`,
      context.ownerRef, String(context.accountRef), context.subjectRef,
      context.ownerEpoch, context.runEpoch, source.connectionEpoch, source.responseRef, source.method, source.requestSequence);
      if (!accepted) return null;
    }
    return 'current-facts:' + fingerprint(sources);
  }
  function claimCurrent({ context, currentSnapshot, currentNeed } = {}) {
    const invalid = validateCurrent({ context, currentSnapshot, currentNeed });
    if (invalid) return denied(invalid);
    return store.transaction(() => {
      const snapshotRef = decisionSnapshotRef(context, currentSnapshot);
      if (!snapshotRef) return denied('CURRENT_NEED_SOURCE_NOT_ACCEPTED');
      const claimRef = 'current-need-claim:' + fingerprint([context.ownerRef, context.subjectRef, currentNeed.needRef, snapshotRef]);
      const claimEvidence = { version: 'current-need-claim/v2', featureId: currentNeed.featureId, targetRef: currentNeed.targetRef,
        businessNeedRef: currentNeed.businessNeedRef, currentSnapshot: { method: currentSnapshot.method, responseRef: currentSnapshot.responseRef,
          requestSequence: currentSnapshot.requestSequence, connectionEpoch: currentSnapshot.connectionEpoch,
          identityVerified: currentSnapshot.identityVerified, officialUid: currentSnapshot.officialUid,
          gameVersion: currentSnapshot.gameVersion, protocolVersion: currentSnapshot.protocolVersion },
        sourceProofs: normalizedSources(currentSnapshot.sourceProofs),
        decisionSnapshotRef: snapshotRef,
        statement: 'new current opportunity only; no historical success, consumption, or replay is inferred' };
      const claimJson = canonical(claimEvidence), claimFingerprint = fingerprint(claimEvidence);
      const existingClaim = store.get('SELECT evidence_fingerprint FROM backend_current_need_claims WHERE claim_ref=?', claimRef);
      if (existingClaim && existingClaim.evidence_fingerprint !== claimFingerprint) return denied('CURRENT_NEED_SOURCE_SET_CONFLICT');
      if (!existingClaim) store.run('INSERT INTO backend_current_need_claims VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', claimRef, context.ownerRef,
        context.accountRef, context.subjectRef, currentNeed.featureId, currentNeed.targetRef, currentNeed.businessNeedRef,
        snapshotRef, currentSnapshot.connectionEpoch, currentNeed.decisionGeneration, currentNeed.semanticFingerprint,
        claimJson, claimFingerprint, store.nowIso());
      const versionEvidence = { version: 'current-need-decision/v1', claimRef, decisionGeneration: currentNeed.decisionGeneration,
        semanticFingerprint: currentNeed.semanticFingerprint, basisRefs: [...currentNeed.basisRefs] };
      const versionJson = canonical(versionEvidence), versionFingerprint = fingerprint(versionEvidence);
      const versionRef = 'current-need-decision:' + fingerprint([claimRef, currentNeed.decisionGeneration, currentNeed.semanticFingerprint]);
      store.run('INSERT OR IGNORE INTO backend_current_need_claim_versions VALUES(?,?,?,?,?,?,?)', versionRef, claimRef,
        currentNeed.decisionGeneration, currentNeed.semanticFingerprint, versionJson, versionFingerprint, store.nowIso());
      return freeze({ accepted: true, replayed: !!existingClaim, claimRef });
    });
  }
  function isClaimCurrent({ claimRef, context, currentSnapshot, currentNeed, operationId = null } = {}) {
    const invalid = validateCurrent({ context, currentSnapshot, currentNeed });
    if (invalid) return denied(invalid);
    const found = store.get('SELECT * FROM backend_current_need_claims WHERE claim_ref=? AND owner_ref=? AND subject_ref=? AND account_ref=?',
      claimRef, context.ownerRef, context.subjectRef, context.accountRef);
    if (!found || found.feature_id !== currentNeed.featureId || found.target_ref !== currentNeed.targetRef ||
      found.business_need_ref !== currentNeed.businessNeedRef || found.current_snapshot_ref !== decisionSnapshotRef(context, currentSnapshot) ||
      !store.get('SELECT 1 FROM backend_current_need_claim_versions WHERE claim_ref=? AND decision_generation=? AND semantic_fingerprint=?',
        claimRef, currentNeed.decisionGeneration, currentNeed.semanticFingerprint)) return denied('CURRENT_NEED_CLAIM_NOT_CURRENT');
    if (operationId !== null) {
      const owner = store.get('SELECT operation_id,decision_generation FROM backend_current_need_claim_owners WHERE claim_ref=?', claimRef);
      if (owner?.operation_id !== operationId || owner.decision_generation !== currentNeed.decisionGeneration) return denied('CURRENT_NEED_CLAIM_OPERATION_NOT_OWNER');
    }
    return freeze({ accepted: true, claimRef });
  }

  function consumeCurrentNeed({ claimRef, operationId, decisionGeneration, currentNeed, featureId } = {}) {
    if (!reference(claimRef) || !reference(operationId) || !digest(decisionGeneration) || !currentNeed ||
      !reference(featureId) || currentNeed.featureId !== featureId || !reference(currentNeed.targetRef) ||
      !reference(currentNeed.businessNeedRef) || !digest(currentNeed.semanticFingerprint) ||
      currentNeed.decisionGeneration !== decisionGeneration || currentNeed.claimRef !== claimRef) return denied('CURRENT_NEED_CLAIM_CONSUMPTION_BINDING_INVALID');
    return store.transaction(() => {
      const claim = store.get('SELECT * FROM backend_current_need_claims WHERE claim_ref=?', claimRef);
      const claimEvidence = claim?.evidence_json ? parseStored(claim.evidence_json, '当前需求声明') : null;
      const snapshotRef = claimEvidence ? 'current-facts:' + fingerprint(normalizedSources(claimEvidence.sourceProofs)) : null;
      const expectedClaimRef = 'current-need-claim:' + fingerprint([claim?.owner_ref, claim?.subject_ref, currentNeed.needRef, snapshotRef]);
      if (!claim || claim.feature_id !== featureId ||
        claim.target_ref !== currentNeed.targetRef || claim.business_need_ref !== currentNeed.businessNeedRef ||
        claim.current_snapshot_ref !== snapshotRef || !store.get('SELECT 1 FROM backend_current_need_claim_versions WHERE claim_ref=? AND decision_generation=? AND semantic_fingerprint=?',
          claimRef, decisionGeneration, currentNeed.semanticFingerprint) ||
        currentNeed.claimRef !== claimRef || claimRef !== expectedClaimRef) return denied('CURRENT_NEED_CLAIM_NOT_CURRENT');
      const decisionVersion = store.get('SELECT evidence_json FROM backend_current_need_claim_versions WHERE claim_ref=? AND decision_generation=? AND semantic_fingerprint=?',
        claimRef, decisionGeneration, currentNeed.semanticFingerprint);
      if (!decisionVersion || parseStored(decisionVersion.evidence_json, '当前需求决策版本')?.claimRef !== claimRef) return denied('CURRENT_NEED_CLAIM_PROPOSAL_BINDING_MISMATCH');
      const owner = store.get('SELECT operation_id,decision_generation FROM backend_current_need_claim_owners WHERE claim_ref=?', claimRef);
      if (owner?.operation_id === operationId && owner.decision_generation === decisionGeneration) return freeze({ accepted: true, replayed: true });
      let previousOperationId = null, reasonCode = 'CURRENT_NEED_CLAIM_FIRST_OPERATION';
      if (owner) {
        const eligibility = currentNeedOwnerEligibility({ store, ledgerView, owner, operationId, decisionGeneration });
        if (!eligibility.transferable) return denied('CURRENT_NEED_CLAIM_ALREADY_CONSUMED');
        previousOperationId = eligibility.previousOperationId;
        reasonCode = 'CURRENT_NEED_REPLANNED_AFTER_PROVEN_NOT_SENT';
      }
      const evidence = { version: 'current-need-claim-consumption/v1', claimRef, previousOperationId, operationId,
        decisionGeneration, reasonCode, notSentProof: previousOperationId ? { transportState: 'not_sent', writeSlot: 0,
          permitConsumed: false, wireKeyPresent: false, requestSequencePresent: false } : null };
      const eventFingerprint = fingerprint(evidence), eventRef = 'current-need-claim-use:' + eventFingerprint;
      store.run('INSERT OR IGNORE INTO backend_current_need_claim_owner_events VALUES(?,?,?,?,?,?,?,?,?)', eventRef, claimRef,
        previousOperationId, operationId, decisionGeneration, reasonCode, canonical(evidence), eventFingerprint, store.nowIso());
      if (owner) {
        const changed = store.run('UPDATE backend_current_need_claim_owners SET operation_id=?,decision_generation=?,recorded_at=? WHERE claim_ref=? AND operation_id=?',
          operationId, decisionGeneration, store.nowIso(), claimRef, previousOperationId);
        if (Number(changed.changes) !== 1) return denied('CURRENT_NEED_CLAIM_OWNERSHIP_CAS_FAILED');
      } else store.run('INSERT INTO backend_current_need_claim_owners VALUES(?,?,?,?)', claimRef, operationId, decisionGeneration, store.nowIso());
      return freeze({ accepted: true, replayed: false, reasonCode });
    });
  }

  function reconcile({ context, originalOperationId, currentSnapshot, currentNeed, operationId = null } = {}) {
    const invalid = validateCurrent({ context, currentSnapshot, currentNeed });
    if (invalid) return denied(invalid);
    return store.transaction(() => {
      const old = ledgerView.operation(originalOperationId);
      if (!old || old.owner_ref !== context.ownerRef || old.subject_ref !== context.subjectRef || old.business_verdict !== 'unknown' ||
        old.write_slot !== 0 || !['answered', 'terminated', 'unknown'].includes(old.transport_state) || !old.original ||
        typeof old.original_json !== 'string' || hashLedgerBytes(old.original_json) !== old.original_fingerprint ||
        ledgerJsonFingerprint(old.original) !== old.original_fingerprint || old.original.ownerRef !== context.ownerRef ||
        old.original.subjectRef !== context.subjectRef || old.connection_epoch >= context.connectionEpoch ||
        old.feature_id !== currentNeed.featureId && !sharedEnterTransfer(currentNeed, context, old) ||
        !old.targets?.some(target => (target.target_ref ?? target.original?.targetRef) === currentNeed.targetRef)) {
        return denied('CURRENT_NEED_ORIGINAL_BINDING_UNPROVEN');
      }
      const oldUid = old.factBasis?.officialIdentity?.uid;
      if (positive(oldUid) && oldUid !== currentSnapshot.officialUid) return denied('CURRENT_NEED_IDENTITY_CONFLICT');
      let ownedCurrentSlot = false;
      if (reference(operationId)) {
        const operation = store.get(`SELECT operation_id FROM backend_operations WHERE operation_id=? AND owner_ref=? AND account_ref=?
          AND subject_ref=? AND run_epoch=? AND connection_epoch=? AND write_slot=1`, operationId, context.ownerRef, context.accountRef,
        context.subjectRef, context.runEpoch, context.connectionEpoch);
        if (operation?.operation_id === operationId && reference(currentNeed.claimRef)) {
          const claimOwner = store.get('SELECT operation_id,decision_generation FROM backend_current_need_claim_owners WHERE claim_ref=?', currentNeed.claimRef);
          ownedCurrentSlot = claimOwner?.operation_id === operationId && claimOwner.decision_generation === currentNeed.decisionGeneration;
        }
      }
      if (store.get('SELECT 1 FROM backend_operations WHERE subject_ref=? AND write_slot=1 AND operation_id<>? LIMIT 1',
        context.subjectRef, ownedCurrentSlot ? operationId : '')) return denied('CURRENT_NEED_WRITE_SLOT_ACTIVE');
      const original = old.original;
      if (typeof isolationEvidence?.read !== 'function') return denied('CURRENT_NEED_OLD_EXECUTOR_NOT_CLOSED');
      const isolation = isolationEvidence.read({ context, operationId: originalOperationId });
      const priorExecution = isolation?.previousExecution, isolatedOriginal = isolation?.original;
      const isolationReceipt = isolation && { version: isolation.version, currentCheckpoint: isolation.currentCheckpoint,
        previousExecution: priorExecution, original: isolatedOriginal, outcomeProven: isolation.outcomeProven,
        resourceCoverageProven: isolation.resourceCoverageProven };
      if (isolation?.available !== true || !priorExecution || priorExecution.closed !== true || priorExecution.executionClosed !== true ||
          !['backend-physical-closure', 'backend-native-executor-exit'].includes(priorExecution.kind) ||
          isolatedOriginal?.kind !== 'backend' || isolatedOriginal.operationId !== originalOperationId ||
          isolatedOriginal.originalFingerprint !== old.original_fingerprint || isolatedOriginal.ownerRef !== old.owner_ref ||
          String(isolatedOriginal.accountRef) !== String(old.account_ref) || isolatedOriginal.subjectRef !== old.subject_ref ||
          isolatedOriginal.ownerEpoch !== original.ownerEpoch || isolatedOriginal.runEpoch !== old.run_epoch ||
          isolatedOriginal.connectionEpoch !== old.connection_epoch || isolatedOriginal.executorRef !== original.executorRef ||
          priorExecution.ownerRef !== old.owner_ref || String(priorExecution.accountRef) !== String(old.account_ref) ||
          priorExecution.subjectRef !== old.subject_ref || priorExecution.ownerEpoch !== original.ownerEpoch ||
          priorExecution.runEpoch !== old.run_epoch || priorExecution.connectionEpoch !== old.connection_epoch ||
          priorExecution.executorRef !== original.executorRef || !reference(priorExecution.evidenceRef) || !digest(priorExecution.evidenceHash) ||
          !checkpointMatches(context, currentSnapshot, isolation.currentCheckpoint) || isolation.version !== 'current-execution-isolation/v1' ||
          fingerprint(isolationReceipt) !== isolation.receiptHash || isolation.receiptRef !== 'current-isolation:' + isolation.receiptHash) {
        return denied('CURRENT_NEED_OLD_EXECUTOR_NOT_CLOSED');
      }
      const closure = { evidenceRef: priorExecution.evidenceRef, proofFingerprint: priorExecution.evidenceHash, closureKind: priorExecution.kind,
        isolationReceiptRef: isolation.receiptRef, isolationReceiptHash: isolation.receiptHash };
      const claim = claimCurrent({ context, currentSnapshot, currentNeed });
      if (claim?.accepted !== true) return claim || denied('CURRENT_NEED_CLAIM_NOT_CURRENT');
      const claimRef = claim.claimRef;
      const evidence = { version: 'current-need-reconciliation/v2', claimRef, originalOperationId, originalFingerprint: old.original_fingerprint,
        currentDecisionSnapshotRef: decisionSnapshotRef(context, currentSnapshot), originalVerdictUnchanged: old.business_verdict,
        closureEvidenceRef: closure.evidenceRef, closureFingerprint: closure.proofFingerprint,
        closureKind: closure.closureKind, isolationReceiptRef: closure.isolationReceiptRef,
        isolationReceiptHash: closure.isolationReceiptHash };
      const reconciliationRef = 'current-need-reconciliation:' + fingerprint([claimRef, originalOperationId]);
      const evidenceJson = canonical(evidence), evidenceFingerprint = fingerprint(evidence);
      const prior = store.get('SELECT evidence_fingerprint FROM backend_current_need_reconciliations WHERE reconciliation_ref=?', reconciliationRef);
      if (prior) return prior.evidence_fingerprint === evidenceFingerprint ? freeze({ accepted: true, replayed: true, reconciliationRef, claimRef })
        : denied('CURRENT_NEED_RECONCILIATION_CONFLICT');
      store.run('INSERT INTO backend_current_need_reconciliations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', reconciliationRef, claimRef,
        context.ownerRef, context.accountRef, context.subjectRef, originalOperationId, old.original_fingerprint, currentNeed.featureId,
        currentNeed.targetRef, currentNeed.needRef, decisionSnapshotRef(context, currentSnapshot), context.connectionEpoch, evidenceJson, evidenceFingerprint, store.nowIso());
      return freeze({ accepted: true, replayed: false, reconciliationRef, claimRef });
    });
  }
  function reconcileLegacySource({ context, currentSnapshot, currentNeed, operation, isolationEvidence, legacyConstraints,
    factBasis, candidateFingerprint, action, resourceBaseline = null } = {}) {
    const invalid = validateCurrent({ context, currentSnapshot, currentNeed });
    if (invalid) return denied(invalid);
    if (!operation || !reference(operation.operation_ref) || !digest(operation.source_fingerprint) ||
      !reference(action) || !digest(candidateFingerprint) || !legacyConstraints ||
      typeof legacyConstraints.appendBasis !== 'function' || !isolationEvidence || typeof isolationEvidence.read !== 'function') {
      return denied('CURRENT_NEED_LEGACY_SOURCE_INPUT_INVALID');
    }
    return store.transaction(() => {
      const claim = isClaimCurrent({ claimRef: currentNeed.claimRef, context, currentSnapshot, currentNeed });
      if (claim?.accepted !== true) return claim || denied('CURRENT_NEED_CLAIM_NOT_CURRENT');
      const snapshotRef = decisionSnapshotRef(context, currentSnapshot);
      const proof = isolationEvidence.read({ context, legacyOperationRef: operation.operation_ref });
      const original = proof?.original, prior = proof?.previousExecution, checkpoint = proof?.currentCheckpoint;
      if (proof?.available !== true || original?.kind !== 'legacy' || original.operationRef !== operation.operation_ref ||
        original.ownerRef !== context.ownerRef || original.subjectRef !== context.subjectRef || original.sourceFingerprint !== operation.source_fingerprint ||
        prior?.kind !== 'legacy-signed-migration-fence' || prior.closed !== true || prior.executionClosed !== true ||
        !checkpointMatches(context, currentSnapshot, checkpoint) ||
        !reference(proof.receiptRef) || !digest(proof.receiptHash)) return denied('CURRENT_NEED_LEGACY_SOURCE_FENCE_UNPROVEN');
      const receipt = { version: proof.version, currentCheckpoint: proof.currentCheckpoint, previousExecution: proof.previousExecution,
        original: proof.original, outcomeProven: proof.outcomeProven, resourceCoverageProven: proof.resourceCoverageProven };
      if (fingerprint(receipt) !== proof.receiptHash || proof.receiptRef !== 'current-isolation:' + proof.receiptHash)
        return denied('CURRENT_NEED_LEGACY_SOURCE_FENCE_FINGERPRINT_INVALID');
      const constraintRef = operation.constraint_ref || operation.operation_ref;
      const evidence = { version: 'legacy-current-need-separation/v1', claimRef: currentNeed.claimRef,
        currentNeedRef: currentNeed.needRef, businessNeedRef: currentNeed.businessNeedRef, decisionGeneration: currentNeed.decisionGeneration,
        currentSnapshotRef: snapshotRef, currentSnapshotSources: normalizedSources(currentSnapshot.sourceProofs),
        resourceBaseline: resourceBaseline ? { baselineRef: resourceBaseline.baselineRef,
          sourceFingerprint: resourceBaseline.sourceFingerprint, responseRef: resourceBaseline.responseRef,
          requestSequence: resourceBaseline.requestSequence, connectionEpoch: resourceBaseline.connectionEpoch,
          completeAbsoluteBag: resourceBaseline.completeAbsoluteBag, accountingOnly: resourceBaseline.accountingOnly } : null,
        action, targetRef: currentNeed.targetRef, legacyOperationRef: operation.operation_ref,
        sourceFingerprint: operation.source_fingerprint, previousExecution: prior, isolationReceiptRef: proof.receiptRef,
        isolationReceiptHash: proof.receiptHash, originalOutcomeUnchanged: true, historicalSuccessInferred: false,
        replayAuthorized: false, currentCandidateOnly: true };
      const result = legacyConstraints.appendBasis({ ownerRef: context.ownerRef, subjectRef: context.subjectRef, constraintRef,
        sourceFingerprint: operation.source_fingerprint, basisKey: 'current-need-legacy:' + fingerprint([snapshotRef,
          currentNeed.businessNeedRef, operation.operation_ref, currentNeed.decisionGeneration, candidateFingerprint]),
        conclusion: 'permit_current', factBasis, affected: { constraintRef, candidateFingerprint, targetRef: currentNeed.targetRef,
          action, claimRef: currentNeed.claimRef, legacyOperationRef: operation.operation_ref }, evidence,
        reasonCode: 'LEGACY_SOURCE_CLOSED_CURRENT_SNAPSHOT_PROVES_NEED' });
      if (!result || !positive(result.basisId)) return denied(result?.reasonCode || 'CURRENT_NEED_LEGACY_BASIS_NOT_RECORDED');
      return freeze({ accepted: true, replayed: result.replayed === true, basisId: result.basisId,
        receiptRef: proof.receiptRef, receiptHash: proof.receiptHash, currentSnapshotRef: snapshotRef });
    });
  }
  function reconcileLegacyCandidate({ context, currentSnapshot, currentNeed, legacyConstraints, isolationEvidence,
    rawTargetRefs = [], rawResourceKeys = [], semanticKey = null, factBasis, candidateFingerprint, action,
    methodScope = [], resourceBaselineRef } = {}) {
    const invalid = validateCurrent({ context, currentSnapshot, currentNeed });
    if (invalid) return denied(invalid);
    if (!legacyConstraints || typeof legacyConstraints.candidateProjection !== 'function' || !Array.isArray(methodScope) ||
      !digest(candidateFingerprint) || !reference(action)) return denied('CURRENT_NEED_LEGACY_CANDIDATE_PORT_INVALID');
    const claim = isClaimCurrent({ claimRef: currentNeed.claimRef, context, currentSnapshot, currentNeed });
    if (claim?.accepted !== true) return claim || denied('CURRENT_NEED_CLAIM_NOT_CURRENT');
    const projection = legacyConstraints.candidateProjection({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
      semanticKey, rawTargetRefs, rawResourceKeys, factBasis, resourceBaselineRef });
    if (!projection || projection.ownerRef !== context.ownerRef || projection.subjectRef !== context.subjectRef)
      return denied('CURRENT_NEED_LEGACY_PROJECTION_UNAVAILABLE');
    if (!Array.isArray(projection.operations) || !Array.isArray(projection.targets) ||
        !Array.isArray(projection.resourceFootprints) || !Array.isArray(projection.matchedTargets) ||
        !Array.isArray(projection.matchedResources) || !Array.isArray(projection.bases))
      return denied('CURRENT_NEED_LEGACY_PROJECTION_INCOMPLETE');
    const targets = new Set(rawTargetRefs), resources = new Set(rawResourceKeys), methods = new Set(methodScope);
    const related = projection.operations.filter(operation => {
      if (methods.has(operation.method)) return true;
      if (projection.matchedTargets.some(row => row.operation_ref === operation.operation_ref && targets.has(row.raw_ref))) return true;
      return projection.matchedResources.some(row => row.operation_ref === operation.operation_ref && resources.has(row.raw_ref));
    });
    const orphanTargets = projection.targets.filter(row => targets.has(row.raw_ref) && (!row.operation_ref ||
      !store.get('SELECT 1 FROM backend_legacy_operation_index WHERE operation_ref=? AND owner_ref=? AND subject_ref=?',
        row.operation_ref, context.ownerRef, context.subjectRef)));
    if (!related.length && !orphanTargets.length) return freeze({ accepted: true, currentSnapshotRef: decisionSnapshotRef(context, currentSnapshot),
      resourceBaseline: null, separated: [], projection: legacyConstraints.candidateProjection({ ownerRef: context.ownerRef,
        subjectRef: context.subjectRef, semanticKey, rawTargetRefs, rawResourceKeys, factBasis, candidateFingerprint, resourceBaselineRef }) });
    if (typeof legacyConstraints.validateResourceBaseline !== 'function' || !reference(resourceBaselineRef)) return denied('CURRENT_NEED_LEGACY_BASELINE_PORT_MISSING');
    const baseline = legacyConstraints.validateResourceBaseline({ ownerRef: context.ownerRef, accountRef: context.accountRef,
      subjectRef: context.subjectRef, baselineRef: resourceBaselineRef, currentSnapshot });
    if (!baseline) return denied('CURRENT_NEED_RESOURCE_BASELINE_NOT_CURRENT');
    const separated = [];
    for (const operation of related) {
      const result = reconcileLegacySource({ context, currentSnapshot, currentNeed, operation, isolationEvidence,
        legacyConstraints, factBasis, candidateFingerprint, action, resourceBaseline: baseline });
      if (result?.accepted !== true) return result || denied('CURRENT_NEED_LEGACY_SOURCE_NOT_SEPARATED');
      separated.push({ operationRef: operation.operation_ref, sourceFingerprint: operation.source_fingerprint, basisId: result.basisId });
    }
    // An imported target/hold may have no source operation row. Its exact
    // archived constraint is still independently addressable and must never
    // be represented by a fabricated operation id. Target separation can be
    // recorded here; resource arithmetic remains governed by its own baseline
    // link and is deliberately not cleared by this path.
    for (const constraint of orphanTargets) {
      if (typeof isolationEvidence?.read !== 'function') return denied('CURRENT_NEED_LEGACY_CONSTRAINT_READER_MISSING');
      const proof = isolationEvidence.read({ context, legacyConstraintRef: constraint.constraint_ref });
      const original = proof?.original, prior = proof?.previousExecution;
      if (proof?.available !== true || original?.kind !== 'legacy-constraint' || original.constraintRef !== constraint.constraint_ref ||
          original.ownerRef !== context.ownerRef || original.subjectRef !== context.subjectRef ||
          original.sourceFingerprint !== constraint.source_fingerprint || prior?.kind !== 'legacy-signed-migration-fence' ||
          prior.closed !== true || prior.executionClosed !== true ||
          !checkpointMatches(context, currentSnapshot, proof.currentCheckpoint) ||
          !reference(proof.receiptRef) || !digest(proof.receiptHash)) return denied(proof?.reasonCode || 'CURRENT_NEED_LEGACY_CONSTRAINT_SOURCE_UNPROVEN');
      const receipt = { version: proof.version, currentCheckpoint: proof.currentCheckpoint, previousExecution: prior,
        original, outcomeProven: proof.outcomeProven, resourceCoverageProven: proof.resourceCoverageProven };
      if (fingerprint(receipt) !== proof.receiptHash || proof.receiptRef !== 'current-isolation:' + proof.receiptHash)
        return denied('CURRENT_NEED_LEGACY_CONSTRAINT_RECEIPT_INVALID');
      const evidence = { version: 'legacy-current-need-constraint-separation/v1', claimRef: currentNeed.claimRef,
        currentNeedRef: currentNeed.needRef, businessNeedRef: currentNeed.businessNeedRef, decisionGeneration: currentNeed.decisionGeneration,
        currentSnapshotRef: decisionSnapshotRef(context, currentSnapshot), currentSnapshotSources: normalizedSources(currentSnapshot.sourceProofs),
        resourceBaseline: baseline, action, targetRef: constraint.raw_ref, legacyConstraintRef: constraint.constraint_ref,
        sourceFingerprint: constraint.source_fingerprint, isolationReceiptRef: proof.receiptRef, isolationReceiptHash: proof.receiptHash,
        originalOutcomeUnchanged: true, historicalSuccessInferred: false, replayAuthorized: false, currentCandidateOnly: true };
      const result = legacyConstraints.appendBasis({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
        constraintRef: constraint.constraint_ref, sourceFingerprint: constraint.source_fingerprint,
        basisKey: 'current-need-legacy-constraint:' + fingerprint([evidence.currentSnapshotRef, currentNeed.businessNeedRef,
          constraint.constraint_ref, currentNeed.decisionGeneration, candidateFingerprint]),
        conclusion: 'permit_current', factBasis, affected: { constraintRef: constraint.constraint_ref, candidateFingerprint,
          targetRef: constraint.raw_ref, action, claimRef: currentNeed.claimRef }, evidence,
        reasonCode: 'LEGACY_CONSTRAINT_CLOSED_CURRENT_SNAPSHOT_PROVES_NEED' });
      if (!positive(result?.basisId)) return denied(result?.reasonCode || 'CURRENT_NEED_LEGACY_CONSTRAINT_BASIS_NOT_RECORDED');
      separated.push({ constraintRef: constraint.constraint_ref, sourceFingerprint: constraint.source_fingerprint, basisId: result.basisId });
    }
    const activeProjection = legacyConstraints.candidateProjection({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
      semanticKey, rawTargetRefs, rawResourceKeys, factBasis, candidateFingerprint, resourceBaselineRef });
    return freeze({ accepted: true, currentSnapshotRef: decisionSnapshotRef(context, currentSnapshot),
      resourceBaseline: baseline, separated, projection: activeProjection });
  }
  return Object.freeze({ claimCurrent, isClaimCurrent, consumeCurrentNeed, reconcile, reconcileLegacySource, reconcileLegacyCandidate });
}

function sharedEnterTransfer(currentNeed, context, old) {
  return validSharedOpportunity(currentNeed, context.subjectRef) && old.feature_id !== currentNeed.featureId &&
    new Set(['order.resident', 'order.satin', 'order.decorate']).has(old.feature_id) &&
    old.method === 'orderFlower.enter' && old.scope === 'order-' + old.feature_id.slice(6) + '-enter';
}

function validSharedOpportunity(currentNeed, subjectRef) {
  return currentNeed?.sharedOpportunity === 'order-flower-enter-all/v1' && currentNeed.method === 'orderFlower.enter' &&
    currentNeed.targetRef === 'flower-order-enter:' + subjectRef + ':all' &&
    new Set(['order.resident', 'order.satin', 'order.decorate']).has(currentNeed.featureId);
}

function digest(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function checkpointMatches(context, currentSnapshot, checkpoint) {
  const login = Array.isArray(currentSnapshot?.sourceProofs) ? currentSnapshot.sourceProofs.find(one => one?.method === 'index.login' &&
    one.responseRef === currentSnapshot.responseRef && one.requestSequence === currentSnapshot.requestSequence &&
    one.connectionEpoch === currentSnapshot.connectionEpoch) : null;
  return !!login && checkpoint?.ownerRef === context.ownerRef && String(checkpoint?.accountRef) === String(context.accountRef) &&
    checkpoint?.subjectRef === context.subjectRef && checkpoint?.ownerEpoch === context.ownerEpoch &&
    checkpoint?.runEpoch === context.runEpoch && checkpoint?.connectionEpoch === context.connectionEpoch &&
    checkpoint?.connectionEpoch === currentSnapshot.connectionEpoch && checkpoint?.uid === currentSnapshot.officialUid &&
    checkpoint?.responseRef === login.responseRef && checkpoint?.requestSequence === login.requestSequence &&
    typeof currentSnapshot.gameVersion === 'string' && currentSnapshot.gameVersion.length > 0 &&
    typeof currentSnapshot.protocolVersion === 'string' && currentSnapshot.protocolVersion.length > 0 &&
    checkpoint?.gameVersion === currentSnapshot.gameVersion && checkpoint?.protocolVersion === currentSnapshot.protocolVersion;
}
