import fs from 'node:fs';
import { fingerprint } from '../common.mjs';

const TOKEN = /^\d{1,32}$/;
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const positive = n => Number.isSafeInteger(n) && n > 0;
const validToken = value => typeof value === 'string' && TOKEN.test(value);
const validBootId = value => typeof value === 'string' && BOOT_ID.test(value);

/** Linux /proc stat field 22 is starttime. Split after the last ')' because comm may contain spaces or ')'. */
export function readLinuxBootId({ readFileSync = fs.readFileSync } = {}) {
  try {
    const value = String(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    return validBootId(value) ? value.toLowerCase() : null;
  } catch { return null; }
}

export function readLinuxProcessIdentity(pid, {
  readFileSync = fs.readFileSync,
  bootId = readLinuxBootId({ readFileSync }),
} = {}) {
  if (!positive(Number(pid))) return Object.freeze({ state: 'unknown', pid: null, startToken: null, bootId: validBootId(bootId) ? bootId.toLowerCase() : null });
  const exactPid = Number(pid);
  try {
    const stat = String(readFileSync('/proc/' + exactPid + '/stat', 'utf8'));
    const end = stat.lastIndexOf(')');
    if (end < 0) return Object.freeze({ state: 'unknown', pid: exactPid, startToken: null, bootId: validBootId(bootId) ? bootId.toLowerCase() : null });
    const startToken = stat.slice(end + 1).trim().split(/\s+/)[19] || null;
    if (!validToken(startToken)) return Object.freeze({ state: 'unknown', pid: exactPid, startToken: null, bootId: validBootId(bootId) ? bootId.toLowerCase() : null });
    return Object.freeze({ state: 'present', pid: exactPid, startToken, bootId: validBootId(bootId) ? bootId.toLowerCase() : null });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return Object.freeze({ state: 'exited', pid: exactPid, startToken: 'exited', bootId: validBootId(bootId) ? bootId.toLowerCase() : null });
    return Object.freeze({ state: 'unknown', pid: exactPid, startToken: null, bootId: validBootId(bootId) ? bootId.toLowerCase() : null });
  }
}

/** A missing PID or replaced starttick proves exit even if boot_id is unavailable. Same ticks require two known boot IDs to prove a reboot. */
export function compareNativeProcessIdentity(original, current) {
  if (!original || !positive(original.pid) || !validToken(original.startToken)) return 'unproven';
  if (current?.state === 'exited' && current.pid === original.pid) return 'exited';
  if (!current || current.state !== 'present' || current.pid !== original.pid || !validToken(current.startToken)) return 'unproven';
  if (current.startToken !== original.startToken) return 'exited';
  if (validBootId(original.bootId) && validBootId(current.bootId)) return original.bootId.toLowerCase() === current.bootId.toLowerCase() ? 'same-process' : 'exited';
  return 'unproven';
}

/** Verifies a persisted native-exit proof against the exact executor row and caller identity. */
export function matchesNativeExecutorExitProof({
  appId, subjectRef, executorRef, ownerEpoch, executor, proof, proofSource,
}) {
  if (typeof appId !== 'string' || !appId || typeof subjectRef !== 'string' || !subjectRef ||
      typeof executorRef !== 'string' || !executorRef || !positive(ownerEpoch) || !executor || !proof) return false;
  if (executor.executor_ref !== executorRef || executor.app_id !== appId || !positive(Number(executor.pid)) || !validToken(executor.process_start_token)) return false;
  if ((Object.hasOwn(proof, 'subjectRef') && proof.subjectRef !== subjectRef) ||
      (validBootId(executor.process_boot_id) && (!validBootId(proof.previousProcessBootId) || proof.previousProcessBootId.toLowerCase() !== executor.process_boot_id.toLowerCase())) ||
      (proof.previousProcessBootId != null && !validBootId(executor.process_boot_id)) ||
      proofSource !== 'native-single-engine:' + appId || proof.nativeExecutorExited !== true ||
      proof.stopped !== true || proof.currentInFlight !== false || proof.executorRef !== executorRef ||
      proof.ownerEpoch !== ownerEpoch || Number(proof.pid) !== Number(executor.pid) ||
      proof.previousProcessStartToken !== executor.process_start_token) return false;
  const current = { state: proof.currentProcessStartToken === 'exited' ? 'exited' : 'present',
    pid: Number(executor.pid), startToken: proof.currentProcessStartToken,
    bootId: validBootId(proof.currentProcessBootId) ? proof.currentProcessBootId.toLowerCase() : null };
  const original = { pid: Number(executor.pid), startToken: executor.process_start_token,
    bootId: validBootId(executor.process_boot_id) ? executor.process_boot_id.toLowerCase() : null };
  return compareNativeProcessIdentity(original, current) === 'exited';
}

/** Shared exact-row resolver. No current-owner head lookup is used as a substitute for saved identity. */
export function resolveNativeExecutorExitProof({ store, appId, subjectRef, executorRef, ownerEpoch, exactEvidenceRef = null }) {
  if (!store?.get || !store?.all || typeof appId !== 'string' || !appId || typeof subjectRef !== 'string' || !subjectRef ||
      typeof executorRef !== 'string' || !executorRef || !positive(ownerEpoch)) return null;
  const has = name => Boolean(store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name));
  if (!has('backend_local_executors') || !has('backend_executor_isolation')) return null;
  const executorColumns = store.all('PRAGMA table_info(backend_local_executors)').map(column => column.name);
  if (!['executor_ref','app_id','pid','process_start_token'].every(column => executorColumns.includes(column))) return null;
  const bootColumn = executorColumns.includes('process_boot_id') ? 'process_boot_id' : 'NULL AS process_boot_id';
  const executor = store.get('SELECT executor_ref,app_id,pid,process_start_token,' + bootColumn + ' FROM backend_local_executors WHERE executor_ref=?', executorRef);
  if (!executor || executor.executor_ref !== executorRef) return null;
  const evidenceRef = exactEvidenceRef ?? null;
  if (evidenceRef !== null && evidenceRef !== `local-executor-exit:${executorRef}:${ownerEpoch}`) return null;
  const rows = evidenceRef === null
    ? store.all('SELECT evidence_ref,source_ref,proof_json,created_at FROM backend_executor_isolation WHERE subject_ref=? ORDER BY created_at DESC,evidence_ref', subjectRef)
    : [store.get('SELECT evidence_ref,source_ref,proof_json,created_at FROM backend_executor_isolation WHERE subject_ref=? AND evidence_ref=?', subjectRef, evidenceRef)].filter(Boolean);
  for (const row of rows) {
    let proof;
    try { proof = JSON.parse(row.proof_json); } catch { continue; }
    if (matchesNativeExecutorExitProof({ appId, subjectRef, executorRef, ownerEpoch, executor, proof, proofSource: row.source_ref })) {
      return Object.freeze({ evidenceRef: row.evidence_ref, sourceRef: row.source_ref, executorRef, appId,
        subjectRef, ownerEpoch, pid: executor.pid, processStartToken: executor.process_start_token,
        processBootId: executor.process_boot_id ?? null, proofFingerprint: fingerprint(proof), recordedAt: row.created_at });
    }
  }
  return null;
}
