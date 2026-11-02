import { problem } from '../../common.mjs';
import { contextKey } from './rpc-contract.mjs';

export function createLandReadCoordinator({ readCurrent, isCurrent, projection }) {
  if (typeof readCurrent !== 'function' || typeof isCurrent !== 'function') throw new TypeError('Land reads require finite current-session ports');
  const flights = new Map(), controllers = new Map();
  let closed = false;
  async function perform({ context, reason, signal, after = null }) {
    if (closed || !isCurrent(context)) throw problem('LAND_READ_CONTEXT_REVOKED', '土地读取的运行上下文已撤销');
    const controller = new AbortController(), key = contextKey(context);
    const set = controllers.get(key) || new Set(); set.add(controller); controllers.set(key, set);
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    try {
      controller.signal.throwIfAborted();
      const observation = await readCurrent({ context, method: 'usrLand.refresh', params: {}, after, reason, signal: controller.signal });
      controller.signal.throwIfAborted();
      if (closed || !isCurrent(context)) throw problem('LAND_READ_CONTEXT_REVOKED', '旧土地读取不能恢复当前执行');
      // Root's observation callback synchronously ingests before read resolves.
      return { observation, view: projection.view(context) };
    } finally { signal?.removeEventListener('abort', abort); set.delete(controller); if (!set.size) controllers.delete(key); }
  }
  function refresh(input) {
    const key = contextKey(input.context);
    if (flights.has(key)) return flights.get(key);
    const promise = perform(input).finally(() => { if (flights.get(key) === promise) flights.delete(key); });
    flights.set(key, promise); return promise;
  }
  function refreshAfter({ context, response, reason, signal }) {
    if (!Number.isSafeInteger(response?.requestSequence) || response.requestSequence < 1 || response.connectionEpoch !== context.connectionEpoch) {
      throw problem('LAND_POST_READ_BARRIER_MISSING', '独立后读缺少原写连接和请求序');
    }
    return perform({ context, reason, signal, after: { connectionEpoch: response.connectionEpoch,
      requestSequence: response.requestSequence, wireKey: response.wireKey, responseRef: response.responseRef } });
  }
  function cancel(context) { const key = contextKey(context); for (const controller of controllers.get(key) || []) controller.abort(); flights.delete(key); }
  function shutdown() { closed = true; for (const set of controllers.values()) for (const controller of set) controller.abort(); flights.clear(); }
  return Object.freeze({ refresh, refreshAfter, cancel, shutdown });
}
