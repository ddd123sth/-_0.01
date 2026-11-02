import { fingerprint, parseStored } from '../common.mjs';
import { currentNeedOwnerEligibility } from './current-need-ownership.mjs';

/**
 * Phase-aware persisted binding verifier for currentNeed already created by
 * the production producer. It intentionally does not demand live source
 * freshness: call the dynamic gate for that at assessment/final dispatch.
 */
export function createPersistedCurrentNeedBindingValidator({ store, ledgerView } = {}) {
  if (typeof store?.get !== 'function' || typeof ledgerView?.operation !== 'function') {
    throw new TypeError('Current-need binding validator requires synchronous store and ledger reads');
  }
  return function validateCurrentNeedBinding({ currentNeed, context, featureId, targetRef, operationId,
    baseSemanticKey, phase } = {}) {
    try {
      if (!currentNeed || typeof currentNeed !== 'object' || !context || !operationId ||
          !['prepare', 'operation-owned'].includes(phase) || currentNeed.necessary !== true ||
          currentNeed.featureId !== featureId || currentNeed.targetRef !== targetRef ||
          typeof currentNeed.businessNeedRef !== 'string' || !currentNeed.businessNeedRef ||
          currentNeed.needRef !== 'current-need:' + fingerprint([featureId, targetRef, currentNeed.businessNeedRef]) ||
          !/^[a-f0-9]{64}$/.test(currentNeed.decisionGeneration || '') ||
          !/^[a-f0-9]{64}$/.test(currentNeed.semanticFingerprint || '') ||
          typeof currentNeed.claimRef !== 'string' || !currentNeed.claimRef ||
          typeof baseSemanticKey !== 'string' || !baseSemanticKey) return false;

      const claim = store.get('SELECT * FROM backend_current_need_claims WHERE claim_ref=? AND owner_ref=? AND account_ref=? AND subject_ref=?',
        currentNeed.claimRef, context.ownerRef, String(context.accountRef), context.subjectRef);
      if (!claim || claim.feature_id !== featureId || claim.target_ref !== targetRef ||
          claim.business_need_ref !== currentNeed.businessNeedRef ||
          claim.claim_ref !== 'current-need-claim:' + fingerprint([context.ownerRef, context.subjectRef, currentNeed.needRef, claim.current_snapshot_ref]) ||
          claim.current_connection_epoch !== context.connectionEpoch) return false;

      const claimEvidence = parseStored(claim.evidence_json, 'current-need binding claim');
      if (fingerprint(claimEvidence) !== claim.evidence_fingerprint || claimEvidence?.version !== 'current-need-claim/v2' ||
          claimEvidence.featureId !== featureId || claimEvidence.targetRef !== targetRef ||
          claimEvidence.businessNeedRef !== currentNeed.businessNeedRef ||
          claimEvidence.decisionSnapshotRef !== claim.current_snapshot_ref ||
          claimEvidence.currentSnapshot?.connectionEpoch !== context.connectionEpoch ||
          claimEvidence.currentSnapshot?.method !== 'index.login' || claimEvidence.currentSnapshot?.identityVerified !== true ||
          !Array.isArray(claimEvidence.sourceProofs) ||
          !Array.isArray(currentNeed.basisRefs) ||
          !currentNeed.basisRefs.every(ref => claimEvidence.sourceProofs.some(source => source.responseRef === ref))) return false;

      const version = store.get('SELECT * FROM backend_current_need_claim_versions WHERE claim_ref=? AND decision_generation=? AND semantic_fingerprint=?',
        currentNeed.claimRef, currentNeed.decisionGeneration, currentNeed.semanticFingerprint);
      if (!version || version.version_ref !== 'current-need-decision:' + fingerprint([currentNeed.claimRef, currentNeed.decisionGeneration, currentNeed.semanticFingerprint])) return false;
      const versionEvidence = parseStored(version.evidence_json, 'current-need binding version');
      if (fingerprint(versionEvidence) !== version.evidence_fingerprint ||
          versionEvidence?.version !== 'current-need-decision/v1' ||
          versionEvidence.claimRef !== currentNeed.claimRef ||
          versionEvidence.decisionGeneration !== currentNeed.decisionGeneration ||
          versionEvidence.semanticFingerprint !== currentNeed.semanticFingerprint ||
          !Array.isArray(versionEvidence.basisRefs) ||
          fingerprint([...versionEvidence.basisRefs].sort()) !== fingerprint([...currentNeed.basisRefs].sort())) return false;

      const owner = store.get('SELECT operation_id,decision_generation FROM backend_current_need_claim_owners WHERE claim_ref=?',
        currentNeed.claimRef);
      const eligibility = currentNeedOwnerEligibility({ store, ledgerView, owner, operationId, decisionGeneration: currentNeed.decisionGeneration });
      return phase === 'prepare' ? eligibility.prepareAllowed : eligibility.operationOwned;
    } catch { return false; }
  };
}
