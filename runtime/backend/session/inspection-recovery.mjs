import { canonical, fingerprint, parseStored, plainObject, problem, requireText } from '../common.mjs';
import { compareNativeProcessIdentity, readLinuxProcessIdentity } from './native-executor-identity.mjs';

const positive = value => Number.isSafeInteger(value) && value > 0;

export function createInspectionRecovery({ store, appId,
  isNative = () => process.env.GARDEN_LOCAL_NATIVE === '1', processIdentity = readLinuxProcessIdentity } = {}) {
  if (!store?.transaction || !store?.run || !store?.get || !store?.all || !store?.db?.exec ||
      typeof isNative !== 'function' || isNative.constructor?.name === 'AsyncFunction' ||
      typeof processIdentity !== 'function' || processIdentity.constructor?.name === 'AsyncFunction') {
    throw new TypeError('Inspection recovery requires synchronous native process identity and storage dependencies');
  }
  requireText(appId, 'appId');
  const { get, all, run, transaction, nowIso } = store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_read_inspection_retirements(
    retirement_ref TEXT PRIMARY KEY,subject_ref TEXT NOT NULL,owner_ref TEXT NOT NULL,inspection_id TEXT NOT NULL,
    instance_ref TEXT NOT NULL,pid INTEGER NOT NULL,process_start_token TEXT NOT NULL,current_process_start_token TEXT NOT NULL,
    evidence_json TEXT NOT NULL,prior_checkpoint_json TEXT NOT NULL,recorded_at TEXT NOT NULL,
    UNIQUE(subject_ref,inspection_id,instance_ref,pid,process_start_token));
    CREATE TRIGGER IF NOT EXISTS backend_read_inspection_retirements_no_update BEFORE UPDATE ON backend_read_inspection_retirements
      BEGIN SELECT RAISE(ABORT,'inspection retirement evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_read_inspection_retirements_no_delete BEFORE DELETE ON backend_read_inspection_retirements
      BEGIN SELECT RAISE(ABORT,'inspection retirement evidence is append only'); END;`);
  const hasTable = name => Boolean(get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name));

  function scope(input = {}) {
    const subjectRef = input.subjectRef ?? null, ownerRef = input.ownerRef ?? null;
    if (subjectRef !== null) requireText(subjectRef, 'subjectRef');
    if (ownerRef !== null) requireText(ownerRef, 'ownerRef');
    return { subjectRef, ownerRef };
  }
  function slots(input) {
    const { subjectRef, ownerRef } = scope(input);
    if (!hasTable('backend_read_inspection_slots')) return [];
    if (!hasTable('backend_read_inspections')) throw problem('INSPECTION_RECOVERY_CHECKPOINT_MISSING', '只读检查槽缺少原检查点，原槽已保留', 500);
    const columns = all('PRAGMA table_info(backend_read_inspection_slots)').map(column => column.name);
    const tokenColumn = columns.includes('process_start_token') ? 's.process_start_token' : 'NULL AS process_start_token';
    const bootColumn = columns.includes('process_boot_id') ? 's.process_boot_id' : 'NULL AS process_boot_id';
    return all(`SELECT s.subject_ref,s.inspection_id,s.instance_ref,s.pid,${tokenColumn},${bootColumn},s.created_at,i.owner_ref
      FROM backend_read_inspection_slots s LEFT JOIN backend_read_inspections i ON i.inspection_id=s.inspection_id
      WHERE (? IS NULL OR s.subject_ref=?) AND (? IS NULL OR i.owner_ref=? OR i.owner_ref IS NULL)
      ORDER BY s.subject_ref`, subjectRef, subjectRef, ownerRef, ownerRef);
  }
  function pendingSlots(input = {}) {
    return slots(input).map(slot => ({ subjectRef: slot.subject_ref, ownerRef: slot.owner_ref ?? null,
      inspectionId: slot.inspection_id, instanceRef: slot.instance_ref, pid: slot.pid,
      processStartToken: slot.process_start_token ?? null, processBootId: slot.process_boot_id ?? null }));
  }
  function retireProvedDeadInspection(input = {}) {
    const selectedScope = scope(input);
    if (!slots(selectedScope).length) return { retired: [], retiredCount: 0, remaining: 0, pending: [], cleanupComplete: true };
    return transaction(() => {
      const selected = slots(selectedScope), retired = [], reasons = new Map();
      const native = isNative();
      if (native && typeof native.then === 'function') throw problem('INSPECTION_RECOVERY_PROOF_MUST_BE_SYNC', '只读检查退出证明必须同步核实', 500);
      for (const slot of selected) {
        const skip = reason => reasons.set(slot.inspection_id, reason);
        if (native !== true) { skip('NATIVE_EXECUTOR_BOUNDARY_UNPROVEN'); continue; }
        if (!positive(slot.pid) || typeof slot.process_start_token !== 'string' || !/^\d{1,32}$/.test(slot.process_start_token)) { skip('INSPECTION_PREVIOUS_PROCESS_IDENTITY_UNKNOWN'); continue; }
        const checkpoint = get('SELECT * FROM backend_read_inspections WHERE inspection_id=?', slot.inspection_id);
        if (!checkpoint || checkpoint.subject_ref !== slot.subject_ref || !checkpoint.owner_ref ||
            selectedScope.ownerRef !== null && checkpoint.owner_ref !== selectedScope.ownerRef) {
          skip('INSPECTION_PREVIOUS_CHECKPOINT_UNPROVEN'); continue;
        }
        const currentIdentity = processIdentity(slot.pid);
        if (currentIdentity && typeof currentIdentity.then === 'function') throw problem('INSPECTION_RECOVERY_PROOF_MUST_BE_SYNC', '只读检查退出证明必须同步核实', 500);
        const identityState = compareNativeProcessIdentity({ pid: slot.pid, startToken: slot.process_start_token, bootId: slot.process_boot_id }, currentIdentity);
        if (identityState !== 'exited') {
          skip(identityState === 'same-process' ? 'INSPECTION_PREVIOUS_PROCESS_ALIVE' : 'INSPECTION_PREVIOUS_PROCESS_EXIT_UNPROVEN'); continue;
        }
        const priorSummary = parseStored(checkpoint.summary_json, '原只读检查点');
        if (!plainObject(priorSummary)) throw problem('INSPECTION_RECOVERY_CHECKPOINT_INVALID', '原只读检查点格式不正确，原槽已保留', 500);
        const readAt = nowIso();
        const identity = { appId, subjectRef: slot.subject_ref, ownerRef: checkpoint.owner_ref,
          inspectionId: slot.inspection_id, instanceRef: slot.instance_ref, pid: slot.pid, processStartToken: slot.process_start_token,
          processBootId: slot.process_boot_id ?? null };
        const retirementRef = 'inspection-process-exit:' + fingerprint(identity);
        const evidence = { ...identity, evidenceRef: retirementRef, stopped: true, currentInFlight: false,
          nativeExecutorExited: true, transportClosed: true, currentProcessStartToken: currentIdentity.state === 'exited' ? 'exited' : currentIdentity.startToken,
          currentProcessBootId: currentIdentity.bootId ?? null,
          basis: currentIdentity.state === 'exited' ? 'native-proc-original-pid-exited' : 'native-proc-original-start-token-replaced', readAt };
        run(`INSERT INTO backend_read_inspection_retirements
          (retirement_ref,subject_ref,owner_ref,inspection_id,instance_ref,pid,process_start_token,current_process_start_token,evidence_json,prior_checkpoint_json,recorded_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`, retirementRef, slot.subject_ref, checkpoint.owner_ref, slot.inspection_id,
        slot.instance_ref, slot.pid, slot.process_start_token, evidence.currentProcessStartToken, canonical(evidence), canonical(checkpoint), readAt);
        const summary = { ...priorSummary, cleanupComplete: true, transportClosed: true, completedAt: readAt,
          stage: 'retired_with_close_proof', code: 'INSPECTION_RETIRED_WITH_PROOF',
          retirement: { evidenceRef: retirementRef, readAt, basis: evidence.basis } };
        const updated = run(`UPDATE backend_read_inspections SET cleanup_complete=1,stage=?,code=?,summary_json=?,updated_at=?,completed_at=?
          WHERE inspection_id=? AND owner_ref=? AND subject_ref=?`, 'retired_with_close_proof', 'INSPECTION_RETIRED_WITH_PROOF',
        canonical(summary), readAt, readAt, slot.inspection_id, checkpoint.owner_ref, slot.subject_ref).changes;
        if (updated !== 1) throw problem('INSPECTION_RECOVERY_CHECKPOINT_CHANGED', '原只读检查点已变化，未退休原槽');
        const deleted = run(`DELETE FROM backend_read_inspection_slots WHERE subject_ref=? AND inspection_id=?
          AND instance_ref=? AND pid=? AND process_start_token=?`, slot.subject_ref, slot.inspection_id,
        slot.instance_ref, slot.pid, slot.process_start_token).changes;
        if (deleted !== 1) throw problem('INSPECTION_RECOVERY_SLOT_CHANGED', '原只读检查槽身份已变化，未退休其他槽');
        retired.push({ subjectRef: slot.subject_ref, ownerRef: checkpoint.owner_ref, inspectionId: slot.inspection_id,
          evidenceRef: retirementRef, transportClosed: true });
      }
      const pending = pendingSlots(selectedScope).map(slot => ({ ...slot,
        reasonCode: reasons.get(slot.inspectionId) || 'INSPECTION_PREVIOUS_CLEANUP_REQUIRED' }));
      return { retired, retiredCount: retired.length, remaining: pending.length, pending, cleanupComplete: pending.length === 0 };
    });
  }
  return Object.freeze({ retireProvedDeadInspection, pendingSlots });
}
