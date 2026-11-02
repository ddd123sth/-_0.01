// Android overlay: account-isolated cancellation and proven HTTP transport facts.
// No credentials or response bodies are retained in this context.
import { AsyncLocalStorage } from 'node:async_hooks';
import { tagProxyConnectFailure } from './net-race.js';

const loginContext = new AsyncLocalStorage();
export const ANDROID_HTTP_TRANSPORT_CODE = 'REAL_ANDROID_HTTP_TRANSPORT';
export const ANDROID_SOCKET_ERROR_CODES = Object.freeze(new Set([
  'ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT','ENOTFOUND','EAI_AGAIN',
  'EHOSTUNREACH','ENETUNREACH','ENETDOWN','ERR_SOCKET_CLOSED','UND_ERR_CONNECT_TIMEOUT',
]));
export function androidLoginSignal(explicit) { return explicit ?? loginContext.getStore()?.signal; }
export function androidLoginAbortError() { return Object.assign(new Error('启动已经按请求取消'), { code: 'REAL_ABORTED' }); }
export function throwIfAndroidLoginAborted(signal = androidLoginSignal()) {
  if (signal?.aborted) throw androidLoginAbortError();
}
export function withAndroidLoginSignal(signal, action) {
  const current = androidLoginSignal(signal);
  return loginContext.run({ signal: current }, async () => { throwIfAndroidLoginAborted(current); return action(); });
}
export function androidHttpTransportError(error, { signal, proxy } = {}) {
  if (signal?.aborted || error?.code === 'REAL_ABORTED') return androidLoginAbortError();
  if (String(error?.code || '').startsWith('REAL_') || error?.remoteCode !== undefined || error?.worldAnswered === true) return error;
  const proxyFailure = tagProxyConnectFailure(error, proxy);
  if (proxyFailure) return proxyFailure;
  const code = typeof error?.code === 'string' ? error.code : '';
  if (!ANDROID_SOCKET_ERROR_CODES.has(code)) return error;
  return Object.assign(new Error('与登录服务器的网络连接中断（' + code + '）', { cause: error }), {
    code: ANDROID_HTTP_TRANSPORT_CODE, transportFailure: true, transportCode: code,
  });
}
export function isAndroidHttpTransportError(error) {
  return error?.code === ANDROID_HTTP_TRANSPORT_CODE && error.transportFailure === true && ANDROID_SOCKET_ERROR_CODES.has(error.transportCode);
}

// Includes DNS and a proxy's CONNECT handshake, before request.setTimeout can
// see an assigned socket. The existing caller-supplied timeout is the only clock.
export function beginAndroidHttpRequest({ signal = androidLoginSignal(), timeoutMs, proxy } = {}) {
  throwIfAndroidLoginAborted(signal);
  const controller = new AbortController();
  let request;
  let deadlineError;
  const stop = error => { if (!controller.signal.aborted) controller.abort(error); request?.destroy(error); };
  const onAbort = () => stop(androidLoginAbortError());
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    deadlineError = Object.assign(new Error('登录网络请求已超时'), { code: 'ETIMEDOUT' });
    stop(deadlineError);
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    check: () => { throwIfAndroidLoginAborted(signal); if (deadlineError) throw deadlineError; },
    attach: value => { request = value; if (controller.signal.aborted) request.destroy(controller.signal.reason); },
    normalize: error => androidHttpTransportError(deadlineError || error, { signal, proxy }),
    finish: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); },
  };
}
