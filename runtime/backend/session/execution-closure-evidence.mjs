import { canonical, fingerprint, parseStored, plainObject } from '../common.mjs';
import { ledgerJsonFingerprint } from '../persistence/json-contract.mjs';

const positive = value => Number.isSafeInteger(value) && value > 0;
const axes = ['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch'];

// Read-only generic proof of a precisely bound old execution close. Business
// policy remains with the caller.
export function resolveExecutionClosureEvidence({ store, operationId, operation, saved, checkpoint, row, proof }) {
  const { get, all } = store;
  const has = name => Boolean(get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name));
  const observedAtMs = Date.parse(checkpoint.observedAt), closedAtMs = Date.parse(row.recorded_at);
  let original;
  try { original = parseStored(operation.original_json, '原操作不可变身份'); } catch { return null; }
  if (!plainObject(original) || ledgerJsonFingerprint(original) !== operation.original_fingerprint || original.operationId !== operationId ||
      original.ownerRef !== operation.owner_ref || original.accountRef !== operation.account_ref || original.subjectRef !== operation.subject_ref ||
      original.runEpoch !== operation.run_epoch || original.connectionEpoch !== operation.connection_epoch ||
      canonical(saved) !== canonical(original) || saved.featureId !== operation.feature_id || saved.scope !== operation.scope ||
      saved.method !== operation.method || saved.paramsFingerprint !== operation.params_fingerprint ||
      operation.business_verdict !== 'unknown' || operation.write_slot !== 0 || operation.transport_state !== 'answered' ||
      !Number.isFinite(observedAtMs) || !Number.isFinite(closedAtMs) || observedAtMs < closedAtMs ||
      !has('backend_session_verification_leases') || !has('backend_session_verification_events') ||
      !has('backend_send_permits') || !has('backend_operation_evidence') ||
      row.proof_kind !== 'verification-snapshot-physical-close' || proof.source !== 'verification-snapshot-actual-close' ||
      proof.closed !== true || proof.connectionEpoch !== operation.connection_epoch || proof.operationId !== operationId ||
      typeof proof.leaseRef !== 'string' || !proof.leaseRef || row.evidence_ref !== 'session-close:' +
        fingerprint([saved.executorRef, operation.subject_ref, operation.connection_epoch, 'verification-snapshot-physical-close']) ||
      row.owner_ref !== operation.owner_ref || String(row.account_ref) !== String(operation.account_ref) ||
      row.subject_ref !== operation.subject_ref || row.executor_ref !== saved.executorRef ||
      row.owner_epoch !== saved.ownerEpoch || row.run_epoch !== operation.run_epoch || row.connection_epoch !== operation.connection_epoch) return null;
  const lease = get(`SELECT * FROM backend_session_verification_leases WHERE lease_ref=? AND operation_id=? AND owner_ref=? AND account_ref=?
    AND subject_ref=? AND executor_ref=? AND owner_epoch=? AND run_epoch=? AND original_connection_epoch=?`, proof.leaseRef, operationId,
  operation.owner_ref, String(operation.account_ref), operation.subject_ref, saved.executorRef, saved.ownerEpoch,
  operation.run_epoch, operation.connection_epoch);
  if (!lease || lease.active !== 0 || lease.state !== 'released' || lease.bridge_json !== null || lease.bridge_fingerprint !== null ||
      !Number.isSafeInteger(lease.new_connection_epoch) || lease.new_connection_epoch <= operation.connection_epoch ||
      typeof lease.reason_code !== 'string' || !lease.reason_code) return null;
  const originalContext = { ownerRef: operation.owner_ref, accountRef: String(operation.account_ref), subjectRef: operation.subject_ref,
    ownerEpoch: saved.ownerEpoch, runEpoch: operation.run_epoch, connectionEpoch: operation.connection_epoch };
  const leaseContext = parseStored(lease.original_context_json, '物理关闭隔离原上下文');
  const after = parseStored(lease.after_json, '物理关闭隔离原匹配回包');
  const sameAxes = (left, right) => plainObject(left) && plainObject(right) && axes.every(key => left[key] === right[key]);
  const bindingKnown = value => plainObject(value) && positive(value.connectionEpoch) && positive(value.requestSequence) &&
    typeof value.responseRef === 'string' && value.responseRef.length > 0 && typeof value.wireKey === 'string' &&
    /^ws\|\d+\|[1-9]\d*$/.test(value.wireKey) && Number(value.wireKey.split('|').at(-1)) === value.requestSequence;
  if (!sameAxes(leaseContext, originalContext) || !bindingKnown(after) || after.connectionEpoch !== operation.connection_epoch ||
      canonical(proof.after) !== canonical(after) || proof.code !== null && (typeof proof.code !== 'string' || proof.code.length > 80)) return null;
  const permit = get('SELECT * FROM backend_send_permits WHERE operation_id=?', operationId);
  if (!permit || permit.owner_ref !== operation.owner_ref || permit.subject_ref !== operation.subject_ref || permit.owner_epoch !== saved.ownerEpoch ||
      permit.run_epoch !== operation.run_epoch || permit.connection_epoch !== operation.connection_epoch || permit.method !== operation.method ||
      permit.params_fingerprint !== operation.params_fingerprint || permit.consumed !== 1 || permit.request_sequence !== after.requestSequence || permit.wire_key !== after.wireKey) return null;
  const answers = all(`SELECT evidence_id,kind,source,payload_json,payload_fingerprint,observed_at FROM backend_operation_evidence
    WHERE operation_id=? AND kind='official-answer' AND source='backend/write-gateway/v2' ORDER BY evidence_id LIMIT 17`, operationId);
  if (answers.length > 16) return null;
  const answer = answers.find(candidate => {
    const payload = parseStored(candidate.payload_json, '物理关闭隔离原匹配答复');
    return ledgerJsonFingerprint({ kind: candidate.kind, source: candidate.source, payload, observedAt: candidate.observed_at }) === candidate.payload_fingerprint &&
      payload.method === operation.method && payload.connectionEpoch === after.connectionEpoch && payload.requestSequence === after.requestSequence &&
      payload.wireKey === after.wireKey && payload.responseRef === after.responseRef && positive(payload.receivedDeviceMs);
  });
  if (!answer) return null;
  const events = all(`SELECT event_kind,receipt_json,recorded_at FROM backend_session_verification_events
    WHERE lease_ref=? AND event_kind IN ('created','old-closed-new-epoch','failed','durable-outcome-released') ORDER BY recorded_at,event_ref LIMIT 8`, lease.lease_ref);
  const oneEvent = kind => { const matches = events.filter(event => event.event_kind === kind);
    return matches.length === 1 ? { ...matches[0], receipt: parseStored(matches[0].receipt_json, '物理关闭隔离租约事件') } : null; };
  const created = oneEvent('created'), closed = oneEvent('old-closed-new-epoch'), failed = oneEvent('failed'), released = oneEvent('durable-outcome-released');
  if (!created || !closed || !failed || !released) return null;
  const oldLogin = created.receipt.oldLoginSource, loginVersion = oldLogin?.versionEvidence;
  if (created.receipt.operationId !== operationId || !sameAxes(created.receipt.originalContext, originalContext) ||
      canonical(created.receipt.after) !== canonical(after) || created.receipt.answerEvidenceId !== Number(answer.evidence_id) ||
      created.receipt.answerEvidenceFingerprint !== answer.payload_fingerprint || oldLogin?.kind !== 'response' || oldLogin.transport !== 'answered' ||
      oldLogin.method !== 'index.login' || oldLogin.connectionEpoch !== operation.connection_epoch || oldLogin.officialUid !== checkpoint.uid ||
      oldLogin.serverId !== checkpoint.serverId || !bindingKnown(oldLogin) || loginVersion?.source !== 'normal-package-hop-and-matched-world-login/v1' ||
      loginVersion.loginResponseRef !== oldLogin.responseRef || typeof loginVersion.gameVersion !== 'string' || typeof loginVersion.protocolVersion !== 'string') return null;
  const nextContext = closed.receipt.newContext, closeReceipt = closed.receipt.oldPhysicalCloseReceipt;
  if (!sameAxes(nextContext, { ...originalContext, connectionEpoch: lease.new_connection_epoch }) ||
      !Number.isSafeInteger(checkpoint.connectionEpoch) || checkpoint.connectionEpoch < lease.new_connection_epoch || checkpoint.connectionEpoch <= operation.connection_epoch ||
      closeReceipt?.closed !== true || closeReceipt.connectionEpoch !== operation.connection_epoch || closeReceipt.closureEvidenceRef !== row.evidence_ref ||
      closeReceipt.code !== proof.code || closed.recorded_at < row.recorded_at || failed.receipt.operationId !== operationId ||
      !sameAxes(failed.receipt.originalContext, originalContext) || !sameAxes(failed.receipt.currentContext, nextContext) || failed.receipt.reasonCode !== lease.reason_code ||
      released.receipt.operationId !== operationId || released.receipt.businessVerdict !== 'unknown' || released.receipt.originalUnknownAndResourcesUnchanged !== true ||
      !(created.recorded_at <= row.recorded_at && row.recorded_at <= closed.recorded_at && closed.recorded_at <= failed.recorded_at && failed.recorded_at <= released.recorded_at)) return null;
  const closureProof = { closed: true, connectionEpoch: operation.connection_epoch, leaseRef: lease.lease_ref,
    operationId, after, code: proof.code, source: 'verification-snapshot-actual-close' };
  if (canonical(proof) !== canonical(closureProof)) return null;
  return { kind: 'backend-physical-close-only', closed: true, executionClosed: true, outcomeProven: false, resourceCoverageProven: false,
    evidenceRef: row.evidence_ref, evidenceHash: fingerprint(proof), sourceRef: 'verification-snapshot-actual-close',
    ownerRef: operation.owner_ref, accountRef: operation.account_ref, subjectRef: operation.subject_ref, ownerEpoch: saved.ownerEpoch,
    runEpoch: operation.run_epoch, connectionEpoch: operation.connection_epoch, executorRef: saved.executorRef, recordedAt: row.recorded_at,
    leaseRef: lease.lease_ref, newConnectionEpoch: lease.new_connection_epoch, failureReasonCode: lease.reason_code,
    answerEvidenceRef: 'operation-evidence:' + answer.evidence_id, answerEvidenceHash: answer.payload_fingerprint };
}
