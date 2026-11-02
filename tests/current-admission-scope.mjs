import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createBackendLedger } from '../runtime/backend/persistence/ledger.mjs';
import { createCurrentNeedReconciler } from '../runtime/backend/execution/current-need.mjs';

function prepared(ledger, id, targetRef, { sent = false } = {}) {
  const targets = (Array.isArray(targetRef) ? targetRef : [targetRef]).map(ref => ({ memberKey: 'target:' + ref,
    targetKind: 'order', targetRef: ref, lifecycleRef: 'life:' + ref, targetFingerprint: 'target:' + ref }));
  ledger.prepareOperation({ operationId: id, proposalId: 'p-' + id, ownerRef: 'owner', accountRef: 'account', subjectRef: 'subject',
    ownerEpoch: 1, executorRef: 'executor', runEpoch: 1, connectionEpoch: 1, featureId: 'order.resident',
    scope: 'box:' + targetRef, method: 'orderFlower.finishOrder', semanticKey: 'semantic:' + id,
    configRevision: 1, cancelEpoch: 0, paramsFingerprint: 'params:' + id,
    factBasis: { version: 'test/v1' }, targets, resources: [], resourceBindings: [] });
  if (!sent) return;
  ledger.markMayHaveSent({ operationId: id, evidence: { kind: 'send', source: 'unit', payload: { accepted: true } } });
  ledger.recordTransport({ operationId: id, transportState: 'unknown', releaseWriteSlot: true,
    transportTermination: { ended: true, source: 'unit-close' }, evidence: { kind: 'transport', source: 'unit', payload: { state: 'unknown' } } });
  ledger.settleOperation({ operationId: id, businessVerdict: 'unknown', verificationVersion: 'test/v1',
    evidence: { kind: 'unknown', source: 'unit', payload: { verdict: 'unknown' } } });
}

test('target-scoped current admission limits history while preserving the global active write slot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-current-admission-scope-'));
  const store = openBackendStore({ dataDir: root });
  const ledger = createBackendLedger(store);
  try {
    prepared(ledger, 'unknown-a', ['box-a', 'box-a2'], { sent: true });
    prepared(ledger, 'unknown-b', 'box-b', { sent: true });
    prepared(ledger, 'active-c', 'box-c');
    const withoutReconciliationSchema = ledger.currentAdmission({ ownerRef: 'owner', subjectRef: 'subject', targetRefs: ['box-a'] });
    assert.deepEqual(withoutReconciliationSchema.unresolvedOperations.map(row => row.operation_id), ['unknown-a', 'active-c'],
      'an independently constructed ledger remains compatible before the optional reconciliation table exists');
    createCurrentNeedReconciler({ store, ledgerView: ledger });
    store.run(`INSERT INTO backend_current_need_reconciliations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, 'reconcile-a', 'claim-a',
      'owner', 'account', 'subject', 'unknown-a', ledger.operation('unknown-a').original_fingerprint, 'order.resident', 'box-a',
      'need-a', 'snapshot-a', 2, '{}', 'evidence-a', store.nowIso());

    const scoped = ledger.currentAdmission({ ownerRef: 'owner', subjectRef: 'subject', targetRefs: ['box-a'] });
    assert.deepEqual(scoped.unresolvedOperations.map(row => row.operation_id), ['active-c'], 'a reconciled historical target leaves the live candidate set');
    assert.equal(scoped.activeOperation.operation_id, 'active-c', 'the subject-wide live writer remains visible');
    assert.deepEqual(scoped.bases, []);

    const siblingScope = ledger.currentAdmission({ ownerRef: 'owner', subjectRef: 'subject', targetRefs: ['box-a2'] });
    assert.deepEqual(siblingScope.unresolvedOperations.map(row => row.operation_id), ['unknown-a', 'active-c'],
      'separating one target does not separate another target on the same historical operation');
    const inactiveFeatures = ledger.currentAdmission({ ownerRef: 'owner', subjectRef: 'subject', featureIds: [], targetRefs: ['box-a2'] });
    assert.deepEqual(inactiveFeatures.unresolvedOperations.map(row => row.operation_id), ['active-c'],
      'an explicitly empty feature set does not pull unrelated history into candidate checks');

    const unfiltered = ledger.currentAdmission({ ownerRef: 'owner', subjectRef: 'subject' });
    assert.deepEqual(unfiltered.unresolvedOperations.map(row => row.operation_id), ['unknown-a', 'unknown-b', 'active-c']);
    assert.equal(ledger.operation('unknown-a').business_verdict, 'unknown');
    assert.equal(ledger.operation('unknown-b').business_verdict, 'unknown');
    assert.equal(ledger.listOperationsPage({ ownerRef: 'owner', subjectRef: 'subject', limit: 10 }).rows.some(row => row.operation_id === 'unknown-a'), true,
      'history pagination still exposes the immutable original');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
