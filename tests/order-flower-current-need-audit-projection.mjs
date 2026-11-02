import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonical, fingerprint } from '../runtime/backend/common.mjs';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { ledgerJsonFingerprint, serializeLedgerJson } from '../runtime/backend/persistence/json-contract.mjs';
import { projectOrderFlowerCurrentNeedAdmission } from '../runtime/backend/features/order-flower/audit-projection.mjs';
import { orderFlowerCurrentNeedAdmissionEvidence } from '../runtime/backend/features/order-flower/runtime.mjs';

test('audit projection associates same-lifecycle current need without requiring old optional preparation metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-flower-current-need-audit-'));
  const store = openBackendStore({ dataDir: root });
  try {
    store.db.exec(`CREATE TABLE backend_operations(operation_id TEXT PRIMARY KEY,owner_ref TEXT,account_ref TEXT,subject_ref TEXT,
      owner_epoch INTEGER,run_epoch INTEGER,connection_epoch INTEGER,executor_ref TEXT,feature_id TEXT,scope TEXT,method TEXT,
      original_json TEXT,original_fingerprint TEXT,business_verdict TEXT,write_slot INTEGER,transport_state TEXT,params_fingerprint TEXT);
      CREATE TABLE backend_current_need_claims(claim_ref TEXT PRIMARY KEY,owner_ref TEXT,account_ref TEXT,subject_ref TEXT,
      feature_id TEXT,target_ref TEXT,business_need_ref TEXT,current_snapshot_ref TEXT);
      CREATE TABLE backend_current_need_claim_owners(claim_ref TEXT PRIMARY KEY,operation_id TEXT,decision_generation TEXT);
      CREATE TABLE backend_current_need_claim_owner_events(event_ref TEXT,claim_ref TEXT,previous_operation_id TEXT,new_operation_id TEXT,
      decision_generation TEXT,reason_code TEXT,evidence_json TEXT,evidence_fingerprint TEXT,recorded_at TEXT);
      CREATE TABLE backend_current_need_reconciliations(reconciliation_ref TEXT PRIMARY KEY,claim_ref TEXT,original_operation_id TEXT,
      original_fingerprint TEXT,feature_id TEXT,target_ref TEXT,current_need_ref TEXT,current_snapshot_ref TEXT,evidence_json TEXT,evidence_fingerprint TEXT);
      CREATE TABLE backend_operation_evidence(evidence_id INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT,evidence_key TEXT,kind TEXT,
      source TEXT,payload_json TEXT,payload_fingerprint TEXT,observed_at TEXT);
      CREATE TABLE backend_session_connection_closures(evidence_ref TEXT PRIMARY KEY,owner_ref TEXT,account_ref TEXT,subject_ref TEXT,
      owner_epoch INTEGER,run_epoch INTEGER,connection_epoch INTEGER,executor_ref TEXT,proof_kind TEXT,proof_json TEXT,recorded_at TEXT);`);
    const ownerRef = 'fixture:owner', accountRef = '1', subjectRef = 'fixture:subject', featureId = 'order.resident';
    const targetRef = 'flower-order:fixture:subject:resident:1', lifecycleRef = 'resident:stable-life';
    const old = { operationId: 'op:old', ownerRef, accountRef, subjectRef, ownerEpoch: 1, runEpoch: 1, connectionEpoch: 1,
      executorRef: 'executor:old', featureId, scope: 'order-resident', method: 'orderFlower.finishOrder',
      targets: [{ targetRef, lifecycleRef }], resources: [] };
    const oldJson = serializeLedgerJson(old), oldFingerprint = ledgerJsonFingerprint(old);
    store.run(`INSERT INTO backend_operations(operation_id,owner_ref,account_ref,subject_ref,owner_epoch,run_epoch,connection_epoch,
      executor_ref,feature_id,scope,method,original_json,original_fingerprint,business_verdict,write_slot,transport_state)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, old.operationId, ownerRef, accountRef,
      subjectRef, 1, 1, 1, old.executorRef, featureId, old.scope, old.method, oldJson, oldFingerprint, 'unknown', 0, 'answered');
    const closure = { closed: true, connectionEpoch: 1, source: 'transport-close-receipt' };
    store.run('INSERT INTO backend_session_connection_closures VALUES(?,?,?,?,?,?,?,?,?,?,?)', 'close:old', ownerRef, accountRef,
      subjectRef, 1, 1, 1, old.executorRef, 'transport-closed', canonical(closure), '2026-10-26T00:00:00.000Z');
    const claimRef = 'claim:current', decisionGeneration = 'd'.repeat(64), needRef = 'current-need:need';
    const preparedOrder = { kind: 'resident', boxId: 1, lifecycleRef, currentNeed: { necessary: true, featureId, targetRef,
      businessNeedRef: 'business-need:stable', needRef, claimRef, decisionGeneration } };
    const current = { operationId: 'op:new', ownerRef, accountRef, subjectRef, ownerEpoch: 2, runEpoch: 1, connectionEpoch: 2,
      executorRef: 'executor:new', featureId, scope: old.scope, method: old.method,
      semanticKey: 'order-flower-finish:' + lifecycleRef + ':current-need:' + decisionGeneration,
      targets: [{ targetRef, lifecycleRef }] };
    const operation = { operation_id: current.operationId, original: current, original_fingerprint: ledgerJsonFingerprint(current) };
    const observedAt = '2026-10-26T00:00:00.000Z', evidenceSource = 'backend/write-gateway/v2';
    const appendEvidence = (kind, evidenceKey, payload) => store.run(`INSERT INTO backend_operation_evidence
      (operation_id,evidence_key,kind,source,payload_json,payload_fingerprint,observed_at) VALUES(?,?,?,?,?,?,?)`,
    current.operationId, evidenceKey, kind, evidenceSource, serializeLedgerJson(payload),
    ledgerJsonFingerprint({ kind, source: evidenceSource, payload, observedAt }), observedAt);
    appendEvidence('finite-domain-preparation', 'finite-domain-preparation:v1', { domain: 'order-flower-resident', preparation: preparedOrder });
    appendEvidence('admitted-operation-contract', 'admitted-operation-contract:v1', { contractId: 'order-flower-resident/ordinary-single-v1' });
    const reconciliationRef = 'reconciliation:current';
    const reconciliationEvidence = { claimRef, originalOperationId: old.operationId, originalFingerprint: oldFingerprint,
      originalVerdictUnchanged: 'unknown', currentDecisionSnapshotRef: 'current-facts:abc', closureEvidenceRef: 'close:old',
      closureFingerprint: fingerprint(closure) };
    store.run('INSERT INTO backend_current_need_claims VALUES(?,?,?,?,?,?,?,?)', claimRef, ownerRef, accountRef, subjectRef,
      featureId, targetRef, 'business-need:stable', 'current-facts:abc');
    store.run('INSERT INTO backend_current_need_claim_owners VALUES(?,?,?)', claimRef, current.operationId, decisionGeneration);
    const ownerEvent = { version: 'current-need-claim-consumption/v1', claimRef, previousOperationId: null,
      operationId: current.operationId, decisionGeneration, reasonCode: 'CURRENT_NEED_CLAIM_FIRST_OPERATION', notSentProof: null };
    const ownerEventFingerprint = fingerprint(ownerEvent);
    store.run('INSERT INTO backend_current_need_claim_owner_events VALUES(?,?,?,?,?,?,?,?,?)',
      'current-need-claim-use:' + ownerEventFingerprint, claimRef, null, current.operationId, decisionGeneration,
      ownerEvent.reasonCode, canonical(ownerEvent), ownerEventFingerprint, '2026-10-26T00:00:00.000Z');
    store.run('INSERT INTO backend_current_need_reconciliations VALUES(?,?,?,?,?,?,?,?,?,?)', reconciliationRef, claimRef,
      old.operationId, oldFingerprint, featureId, targetRef, needRef, 'current-facts:abc', canonical(reconciliationEvidence), fingerprint(reconciliationEvidence));
    const evidence = orderFlowerCurrentNeedAdmissionEvidence({ currentNeedGeneration: true, isolation: null,
      currentOrderSource: { kind: 'response', method: 'index.login', responseRef: 'login:new', requestSequence: 1,
        connectionEpoch: 2 }, oldLifecycleRef: null, oldTime: null, currentTime: 1_800_000_000_000,
      claimRef, decisionGeneration, reconciliationRef });
    const affected = { targetRef, lifecycleRef, currentOperationId: current.operationId, currentNeedClaimRef: claimRef,
      currentNeedDecisionGeneration: decisionGeneration, originalOutcomeUnchanged: true, originalResourceFootprintsUnchanged: true };
    const projected = projectOrderFlowerCurrentNeedAdmission({ store, operation, basisRow: { operation_id: old.operationId,
      subject_ref: subjectRef, constraint_key: targetRef, conclusion: 'permit_current',
      reason_code: 'ORDER_FLOWER_CURRENT_NEED_AFTER_EXACT_CLOSED_EXECUTION' }, affected, evidence,
      referenceOriginalJson: oldJson, referenceOriginalFingerprint: oldFingerprint });
    assert.equal(projected.associated, true, JSON.stringify(projected));
    assert.equal(projected.complete, true, JSON.stringify(projected));
    assert.equal(projected.priorPreparationMetadataAvailable, false);
    assert.equal(projected.evidence.oldTime, null);
    assert.equal(projected.evidence.originalPreparationFingerprint, null);
    assert.equal(projected.evidence.version, 'order-flower/current-need-after-exact-closed-execution/v1');
    assert.equal(Object.hasOwn(operation.original, 'orderFlower'), false, 'ledger original remains the generic production shape');
    store.run('UPDATE backend_current_need_claim_owners SET operation_id=? WHERE claim_ref=?', 'op:later', claimRef);
    const transfer = { version: 'current-need-claim-consumption/v1', claimRef, previousOperationId: current.operationId,
      operationId: 'op:later', decisionGeneration, reasonCode: 'CURRENT_NEED_REPLANNED_AFTER_PROVEN_NOT_SENT',
      notSentProof: { transportState: 'not_sent', writeSlot: 0, permitConsumed: false, wireKeyPresent: false, requestSequencePresent: false } };
    const transferFingerprint = fingerprint(transfer);
    store.run('INSERT INTO backend_current_need_claim_owner_events VALUES(?,?,?,?,?,?,?,?,?)', 'current-need-claim-use:' + transferFingerprint,
      claimRef, current.operationId, 'op:later', decisionGeneration, transfer.reasonCode, canonical(transfer), transferFingerprint,
      '2026-10-26T00:00:01.000Z');
    const historical = projectOrderFlowerCurrentNeedAdmission({ store, operation, basisRow: { operation_id: old.operationId,
      subject_ref: subjectRef, constraint_key: targetRef, conclusion: 'permit_current',
      reason_code: 'ORDER_FLOWER_CURRENT_NEED_AFTER_EXACT_CLOSED_EXECUTION' }, affected, evidence,
      referenceOriginalJson: oldJson, referenceOriginalFingerprint: oldFingerprint });
    assert.equal(historical.complete, true, 'later strict-not-sent claim reassignment must not erase historical admission audit');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
