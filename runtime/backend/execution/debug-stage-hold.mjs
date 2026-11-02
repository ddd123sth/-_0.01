import { problem } from '../common.mjs';

// Debug-only fault injection: hold one real, durably prepared operation before
// its send permit is consumed. No wire response, business fact or clock is
// manufactured. The production stage deadline and cancellation path stay live.
export function createDebugStageHold() {
  let current = null, cancel = null;
  const enabled = () => process.env.GARDEN_DEBUG_TOOLS === '1';
  const snapshot = () => current ? { ...current } : { state: 'idle' };
  function arm({ ownerRef, accountRef, subjectRef, featureId, stage = 'before-send-fence' }) {
    if (!enabled()) throw problem('DEBUG_TOOLS_DISABLED', '接口不存在', 404);
    if (current && ['armed', 'holding'].includes(current.state)) throw problem('DEBUG_STAGE_ALREADY_ARMED', '已有一次阶段故障等待结束', 409);
    if (!['order.resident', 'order.satin', 'order.decorate'].includes(featureId)) throw problem('DEBUG_STAGE_FEATURE_INVALID', '阶段故障只支持普通订单', 400);
    if (!['before-send-fence', 'fact-refresh', 'scheduled-fact-refresh', 'proposal-fact-refresh', 'branch-fact-refresh'].includes(stage))
      throw problem('DEBUG_STAGE_INVALID', '阶段故障只支持发送前或真实事实刷新阶段', 400);
    const limit = stage === 'before-send-fence' ? 180000 : 300000;
    current = { state: 'armed', ownerRef, accountRef: String(accountRef), subjectRef, featureId, armedAtMs: Date.now(),
      stage, stageLimitMs: limit, maxHoldMs: limit + 50000 };
    return snapshot();
  }
  async function beforeSend({ proposal, signal }) {
    return beforeStage({ context: proposal, featureId: proposal.featureId, operationId: proposal.operationId, stage: 'before-send-fence', signal });
  }
  async function beforeStage({ context: proposal, featureId, stage, operationId = null, signal }) {
    if (!enabled() || current?.state !== 'armed' || current.ownerRef !== proposal.ownerRef || current.accountRef !== String(proposal.accountRef)
        || current.subjectRef !== proposal.subjectRef || current.featureId !== featureId || current.stage !== stage
          && !(current.stage === 'fact-refresh' && ['scheduled-fact-refresh','proposal-fact-refresh','branch-fact-refresh'].includes(stage))) return;
    if (Date.now() - current.armedAtMs > 90000) { current.state = 'expired-before-entry'; return; }
    const entry = current;
    Object.assign(entry, { state: 'holding', stage, operationId, connectionEpoch: proposal.connectionEpoch,
      runEpoch: proposal.runEpoch, enteredAtMs: Date.now() });
    await new Promise((resolve, reject) => {
      let finished = false;
      const finish = reason => {
        if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted); cancel = null;
        Object.assign(entry, { state: 'ended', endedAtMs: Date.now(), endCode: reason?.code || 'DEBUG_STAGE_RELEASED' });
        if (reason) reject(reason); else resolve();
      };
      const aborted = () => finish(signal.reason || problem('DEBUG_STAGE_ABORTED', '真实阶段已取消'));
      const timer = setTimeout(() => finish(problem('DEBUG_STAGE_HOLD_EXPIRED', '阶段故障保护到期，原操作保持未发送')), entry.maxHoldMs);
      cancel = () => finish(problem('DEBUG_STAGE_RELEASED', '已结束阶段故障，原操作保持未发送'));
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }
  function release() {
    if (!enabled()) throw problem('DEBUG_TOOLS_DISABLED', '接口不存在', 404);
    if (cancel) cancel(); else if (current?.state === 'armed') current.state = 'released-before-entry';
    return snapshot();
  }
  return Object.freeze({ arm, beforeSend, beforeStage, snapshot, release });
}
