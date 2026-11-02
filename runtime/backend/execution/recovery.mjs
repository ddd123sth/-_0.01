import { fingerprint, parseStored, plainObject, requireText } from '../common.mjs';
import { resolveNativeExecutorExitProof } from '../session/native-executor-identity.mjs';
import { ledgerJsonFingerprint } from '../persistence/json-contract.mjs';

const positive = value => Number.isSafeInteger(value) && value > 0;
const synchronous = (callback, value) => {
  const result = callback(value);
  if (result?.then) { result.catch?.(() => {}); throw new TypeError('Write recovery guards must be synchronous'); }
  return result === true;
};

// No PID probing, connection opening, legacy mutation or outcome rewriting.
// Only exact already-recorded closure/isolation evidence and a current normal
// login checkpoint can retire an old technical slot. Resources remain evidence.
export function createClosedWriteRecovery({ store, ledger, appId, isCurrent, authorizeCurrent }) {
  requireText(appId, 'appId');
  for (const callback of [isCurrent, authorizeCurrent]) if (typeof callback !== 'function' || callback.constructor?.name === 'AsyncFunction') {
    throw new TypeError('Write recovery requires synchronous current-owner guards');
  }
  const { get, all, transaction } = store;
  const hasTable = name => Boolean(get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name));
  function current(context) {
    if (!context || !synchronous(isCurrent, context) || !synchronous(authorizeCurrent, context)) return false;
    const intent = get('SELECT subject_ref,desired_running,run_epoch,connection_epoch FROM backend_run_intents WHERE owner_ref=? AND account_ref=?', context.ownerRef, String(context.accountRef));
    const owner = get('SELECT owner_ref,owner_epoch,active FROM backend_subject_owners WHERE subject_ref=?', context.subjectRef);
    return intent?.desired_running === 1 && intent.subject_ref === context.subjectRef && intent.run_epoch === context.runEpoch &&
      intent.connection_epoch === context.connectionEpoch && owner?.active === 1 && owner.owner_ref === context.ownerRef && owner.owner_epoch === context.ownerEpoch;
  }
  function sourceCheckpoint(context, input) {
    const observation = input?.observation;
    if (!plainObject(input?.factBasis) || !Object.keys(input.factBasis).length || !observation || observation.method !== 'index.login' ||
        observation.source === 'late' || observation.transport !== 'answered' || observation.connectionEpoch !== context.connectionEpoch ||
        !positive(observation.requestSequence) || typeof observation.wireKey !== 'string' || !observation.wireKey ||
        typeof observation.responseRef !== 'string' || !observation.responseRef || !positive(observation.receivedDeviceMs) ||
        observation.envelopeOk !== true || observation.dsName !== 'G.ISyncData' || observation.rejected === true) return null;
    const uid = observation.value?.['7']?.['0']?.['0'];
    const account = get('SELECT subject_ref,profile_json FROM backend_accounts WHERE owner_ref=? AND account_id=? AND removed_at IS NULL', context.ownerRef, Number(context.accountRef));
    if (!account || account.subject_ref !== context.subjectRef || !positive(uid) || parseStored(account.profile_json, '当前官方身份').uid !== uid) return null;
    return { source: 'current-matched-official-login', checkpointRef: observation.responseRef, subjectRef: context.subjectRef,
      runEpoch: context.runEpoch, connectionEpoch: context.connectionEpoch, observedAt: new Date(observation.receivedDeviceMs).toISOString(),
      factBasis: { ...input.factBasis, checkpointResponseRef: observation.responseRef, checkpointConnectionEpoch: context.connectionEpoch,
        checkpointRequestSequence: observation.requestSequence, officialUid: uid } };
  }
  function proofFor(operation, nativeOnly = false) {
    const original = parseStored(operation.original_json, '原操作身份');
    const permit = hasTable('backend_send_permits') ? get('SELECT owner_epoch FROM backend_send_permits WHERE operation_id=?', operation.operation_id) : null;
    const ownerEpoch = original.ownerEpoch ?? permit?.owner_epoch;
    if (!positive(ownerEpoch)) return null;
    if (!nativeOnly && hasTable('backend_session_connection_closures')) {
      const rows = all(`SELECT * FROM backend_session_connection_closures WHERE subject_ref=? AND owner_ref=? AND account_ref=?
        AND owner_epoch=? AND run_epoch=? AND connection_epoch=? AND proof_kind='transport-closed' ORDER BY evidence_ref`,
      operation.subject_ref, operation.owner_ref, operation.account_ref, ownerEpoch, operation.run_epoch, operation.connection_epoch);
      for (const row of rows) {
        const proof = parseStored(row.proof_json, '旧物理连接关闭证明');
        if (proof.closed === true && proof.connectionEpoch === operation.connection_epoch && row.executor_ref &&
            (original.executorRef === undefined || original.executorRef === row.executor_ref)) {
          return { evidenceRef: row.evidence_ref, source: 'stored-physical-connection-closure', ownerEpoch, executorRef: row.executor_ref };
        }
      }
    }
    if (!original.executorRef) return null;
    const native = resolveNativeExecutorExitProof({ store, appId, subjectRef: operation.subject_ref,
      executorRef: original.executorRef, ownerEpoch });
    return native ? { evidenceRef: native.evidenceRef, source: 'stored-native-executor-isolation', ownerEpoch,
      executorRef: original.executorRef, processStartToken: native.processStartToken } : null;
  }
  function recoverClosedWriteSlots({ context, checkpoint } = {}) {
    for (const key of ['ownerRef', 'subjectRef']) requireText(context?.[key], key);
    const selected = all('SELECT * FROM backend_operations WHERE subject_ref=? AND write_slot=1 ORDER BY prepared_at,operation_id', context.subjectRef);
    if (!selected.length) return { released: [], held: [], remaining: 0 };
    return transaction(() => {
      const released = [], held = [];
      const validContext = current(context), captured = validContext ? sourceCheckpoint(context, checkpoint) : null;
      for (const operation of selected) {
        const hold = reasonCode => held.push({ operationId: operation.operation_id, reasonCode });
        if (!validContext || !captured) { hold(validContext ? 'WRITE_RECOVERY_CHECKPOINT_UNPROVEN' : 'WRITE_RECOVERY_CONTEXT_NOT_CURRENT'); continue; }
        if (context.connectionEpoch <= operation.connection_epoch) {
          hold('WRITE_RECOVERY_ORIGINAL_EPOCH_STILL_CURRENT'); continue;
        }
        const proof = proofFor(operation);
        if (!proof) { hold('WRITE_RECOVERY_OLD_CLOSE_OR_ISOLATION_UNPROVEN'); continue; }
        if (!current(context)) { hold('WRITE_RECOVERY_CONTEXT_CHANGED'); continue; }
        const operationId = operation.operation_id;
        const basis = ledger.recordAdmissionBasis({ operationId, constraintKey: 'write-slot',
          basisKey: 'closed-slot:' + fingerprint([operationId, operation.revision, proof.evidenceRef, captured.checkpointRef]),
          conclusion: 'permit_current', factBasis: captured.factBasis, affected: { operationId, writeSlot: 'historical' },
          evidence: { closureOrIsolationRef: proof.evidenceRef, currentCheckpointRef: captured.checkpointRef,
            previousOutcomeUnchanged: true, resourcesUnreleased: true }, reasonCode: 'EXACT_OLD_EXECUTOR_CLOSED_CURRENT_CHECKPOINT' });
        const receipt = ledger.releaseHistoricalWriteSlot({ operationId, expectedRevision: operation.revision, basisId: basis.basisId,
          executorIsolation: { isolated: true, source: proof.source, evidenceRef: proof.evidenceRef, ownerRef: operation.owner_ref,
            ownerEpoch: proof.ownerEpoch, executorRef: proof.executorRef, runEpoch: operation.run_epoch, connectionEpoch: operation.connection_epoch },
          transportTermination: { ended: true, source: proof.source, evidenceRef: proof.evidenceRef, operationId, connectionEpoch: operation.connection_epoch },
          checkpoint: captured, evidence: { source: 'backend/closed-write-recovery/v1', payload: {
            closureOrIsolationRef: proof.evidenceRef, currentCheckpointRef: captured.checkpointRef, technicalSlotOnly: true } } });
        released.push({ operationId, basisId: basis.basisId, evidenceRef: proof.evidenceRef, checkpointRef: captured.checkpointRef,
          originalTransport: receipt.transport_state, originalVerdict: receipt.business_verdict, resourceFootprintsPreserved: true });
      }
      return { released, held, remaining: held.length };
    });
  }
  // Retiring a local gateway fault is separate from resolving a remote write.
  // The old ledger verdict and every target/resource constraint remain intact.
  function authorizeGatewayFaultRecovery({ context, operationId, checkpoint, requireNative = true } = {}) {
    if (!current(context)) return null;
    const captured = sourceCheckpoint(context, checkpoint);
    const operation = get('SELECT * FROM backend_operations WHERE operation_id=?', operationId);
    if (!captured || !operation || operation.owner_ref !== context.ownerRef ||
        String(operation.account_ref) !== String(context.accountRef) || operation.subject_ref !== context.subjectRef ||
        operation.write_slot !== 0 || !['confirmed', 'unknown', 'rejected', 'not_applicable'].includes(operation.business_verdict) ||
        context.connectionEpoch <= operation.connection_epoch) return null;
    let original;
    try { original = parseStored(operation.original_json, '故障原操作'); } catch { return null; }
    if (ledgerJsonFingerprint(original) !== operation.original_fingerprint || original.operationId !== operationId) return null;
    const isolation = proofFor(operation, requireNative);
    if (!isolation || !current(context)) return null;
    return { operationId, originalFingerprint: operation.original_fingerprint, checkpoint: captured,
      isolation, technicalFaultOnly: true, originalOutcomeAndResourcesUnchanged: true };
  }
  return Object.freeze({ recoverClosedWriteSlots, authorizeGatewayFaultRecovery });
}
