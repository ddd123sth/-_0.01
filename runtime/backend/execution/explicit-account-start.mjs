import { newId, problem } from '../common.mjs';

// Only the authenticated, explicit account-start route uses this port. All
// checks and the native control advance happen before yielding to game login;
// automatic recovery keeps using supervisor.start/resumeDesired directly.
export function startExplicitAccount(backend, { ownerRef, accountRef,
  expectedPriorRunEpoch, commandId = newId() }) {
  accountRef = String(accountRef);
  backend.software.authorize({ ownerRef, purpose: 'read-session' });
  const request = { ownerRef, accountRef, expectedPriorRunEpoch, commandId };
  backend.supervisor.preflightStart(request);
  const priorControl = backend.store.get('SELECT * FROM backend_native_stop_controls ORDER BY control_seq DESC LIMIT 1');
  if (priorControl?.kind === 'STOP' && priorControl.stop_committed === 1 && priorControl.cleanup_complete !== 1)
    throw problem('NATIVE_STOP_PENDING', '整机停止尚未排空，完成停止后才能启动游戏号', 409);

  const control = backend.nativeStartControl({ commandId, sourceInstance: 'local-api:account:' + accountRef,
    sourceGeneration: backend.instanceId, requestedAtMs: Date.now() });
  const current = backend.store.get('SELECT * FROM backend_native_stop_controls ORDER BY control_seq DESC LIMIT 1');
  // Replaying an old start command may return its old receipt. It must never
  // supersede a newer STOP merely because the caller supplied a fresh run epoch.
  if (control?.ok !== true || current?.kind !== 'USER_START' ||
      current.command_id !== commandId || Number(current.control_seq) !== Number(control.controlSeq))
    throw problem('NATIVE_START_SUPERSEDED', '启动命令已被更新的控制取代，请刷新状态后重新操作', 409);
  if (control.journalWritten !== true)
    throw problem('NATIVE_START_NOT_PROJECTED', '启动意愿已保存，但原生恢复投影尚未写入；游戏号未启动，请稍后重试', 503);

  const flight = backend.supervisor.start(request);
  return { commandId, nativeStartControl: { controlSeq: control.controlSeq, kind: control.kind,
    commandId, journalWritten: control.journalWritten }, flight };
}
