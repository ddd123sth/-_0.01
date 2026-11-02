// Thin client for this project's own cloud service. It never talks to the reference
// web project, never accepts a client-chosen owner, and never logs a token or password.
import crypto from 'node:crypto';

export const SOFTWARE_ENDPOINTS = Object.freeze({
  register: '/api/software/register',
  login: '/api/software/login',
  refresh: '/api/software/refresh',
  refreshRecoveryRevoke: '/api/software/refresh-recovery-revoke',
  logout: '/api/software/logout',
  password: '/api/software/password',
  license: '/api/software/license',
  logsBatch: '/api/logs/batch',
  health: '/api/software/health',
});
const PRIVATE_HOSTS = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^\[?::1\]?$/, /^localhost$/];
function failure(error, { status = 0, code = 'SOFTWARE_UNREACHABLE' } = {}) {
  return Object.assign(new Error(typeof error === 'string' ? error : error?.message || '云服务暂时不可达'), { status, code, scope: 'software-cloud' });
}
function maskedUrl(value) {
  const string = String(value || '');
  return string.replace(/\/\/[^/@]*:[^/@]*@/, '//[已隐去]@').slice(0, 160);
}
export function softwareBaseUrl(raw = process.env.GARDEN_SOFTWARE_BASE_URL) {
  const text = String(raw || '').trim();
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { throw failure('云服务地址格式不正确，请检查配置', { status: 500, code: 'SOFTWARE_BASE_URL_INVALID' }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw failure('云服务地址只能是不带鉴权与参数的 http(s) 地址', { status: 500, code: 'SOFTWARE_BASE_URL_INVALID' });
  }
  if (url.protocol === 'https:') return text.replace(/\/+$/, '');
  // Cleartext is only ever allowed to a loopback or private test host; production is TLS at the site entry.
  if (!PRIVATE_HOSTS.some(pattern => pattern.test(url.hostname))) {
    throw failure('云服务地址必须使用 HTTPS', { status: 500, code: 'SOFTWARE_BASE_URL_INSECURE' });
  }
  return text.replace(/\/+$/, '');
}
export function createSoftwareApi({ baseUrl, appVersion = '0.1.0', fetchImpl, timeoutMs = 10000, randomId = () => crypto.randomUUID() } = {}) {
  const origin = softwareBaseUrl(baseUrl);
  const call = fetchImpl || globalThis.fetch;
  if (typeof call !== 'function') throw failure('本机没有可用的网络请求实现', { status: 500, code: 'SOFTWARE_FETCH_MISSING' });
  // 服务端限流提示：只认「秒数」和「HTTP 日期」两种写法，认不出来就不当它存在。
  function retryAfterMs(response) {
    try {
      const raw = response?.headers?.get?.('retry-after');
      if (raw === undefined || raw === null || raw === '') return null;
      const text = String(raw).trim();
      if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
      const dateMs = Date.parse(text);
      return Number.isNaN(dateMs) ? null : Math.max(0, Math.round(dateMs - Date.now()));
    } catch { return null; }
  }
  async function request(pathname, { method = 'POST', body, accessToken, requireAuth = false, expectedStatus, timeout = timeoutMs } = {}) {
    if (!origin) throw failure('尚未配置云服务地址，请先在应用里填写服务器地址', { status: 500, code: 'SOFTWARE_BASE_URL_MISSING' });
    const controller = new AbortController();
    // An opaque correlation ID is safe to show in diagnostics; never include the body or credentials.
    const requestId = randomId();
    const startedAt = Date.now();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    try {
      let response;
      try {
        response = await call(origin + pathname, {
          method, headers: buildHeaders(), body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal, cache: 'no-store',
        });
      } catch (error) {
        throw failure(error?.name === 'AbortError' || timedOut ? '云服务响应超时' : '无法连接云服务',
          { status: 0, code: error?.name === 'AbortError' || timedOut ? 'SOFTWARE_TIMEOUT' : 'SOFTWARE_UNREACHABLE' });
      }
      // 同一条时限必须覆盖到正文读完：只等到响应头就撤表，服务端停在正文上的连接
      // 会一直占住唯一的在途位，客户端也永远等不到超时。
      let text = '';
      const remaining = Math.max(1, timeout - (Date.now() - startedAt));
      let bodyTimer = null;
      try {
        text = await Promise.race([
          response.text(),
          new Promise((_, reject) => { bodyTimer = setTimeout(() => reject(Object.assign(new Error('云服务响应正文超时'), { code: 'SOFTWARE_TIMEOUT' })), remaining); }),
        ]);
      } catch (error) {
        controller.abort();
        throw failure('云服务响应正文没有按时读完', { status: 0, code: error?.code === 'SOFTWARE_TIMEOUT' ? 'SOFTWARE_TIMEOUT' : 'SOFTWARE_UNREACHABLE' });
      } finally {
        if (bodyTimer) clearTimeout(bodyTimer);
      }
      let payload;
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
      if (!response.ok) {
        const error = failure(String(payload?.error || '云服务返回了未能处理的错误'), { status: response.status, code: String(payload?.code || 'SOFTWARE_REQUEST_FAILED') });
        error.requestId = requestId;
        error.payload = payload && typeof payload === 'object' ? payload : {};
        error.maskedUrl = maskedUrl(origin + pathname);
        const headerWait = retryAfterMs(response);
        const payloadWait = payload?.retryAfterMs == null ? NaN : Number(payload.retryAfterMs);
        const wait = headerWait ?? (Number.isFinite(payloadWait) && payloadWait >= 0 ? payloadWait : null);
        if (wait !== null) error.retryAfterMs = wait;
        throw error;
      }
      // The cloud register handler confirms its committed new row with HTTP 201.
      // Another 2xx (including an empty 204) is not that confirmation. It may have
      // created the account, so return an explicit unknown result without retrying.
      if (expectedStatus !== undefined && response.status !== expectedStatus) {
        throw failure('云服务未返回完整的注册确认，账号可能已创建；请先核对登录，不要重复注册',
          { status: 502, code: 'SOFTWARE_REGISTER_UNCONFIRMED' });
      }
      if (requireAuth && !payload?.accessToken) throw failure('云服务返回的登录信息不完整', { status: 502, code: 'SOFTWARE_AUTH_INCOMPLETE' });
      return payload;
    } catch (error) {
      error.scope = 'software-cloud';
      error.requestId = requestId;
      throw error;
    } finally {
      clearTimeout(timer);
    }
    function buildHeaders() {
      const headers = { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8', 'X-App-Version': String(appVersion).slice(0, 32), 'X-Request-Id': requestId };
      if (accessToken) headers.Authorization = 'Bearer ' + accessToken;
      return headers;
    }
  }
  return {
    origin,
    register: ({ username, password }) => request(SOFTWARE_ENDPOINTS.register, { method: 'POST', body: { username: String(username || '').trim(), password: String(password || '') }, expectedStatus: 201 }),
    login: ({ username, password, installId }) => request(SOFTWARE_ENDPOINTS.login, { method: 'POST', body: { username: String(username || '').trim(), password: String(password || ''), installId, appVersion }, requireAuth: true }),
    refresh: ({ refreshToken, installId, rotationId }) => request(SOFTWARE_ENDPOINTS.refresh, { method: 'POST', body: { refreshToken, installId, rotationId }, requireAuth: true }),
    refreshRecoveryRevoke: ({ refreshToken, installId, rotationId }) => request(SOFTWARE_ENDPOINTS.refreshRecoveryRevoke,
      { method: 'POST', body: { refreshToken, installId, rotationId } }),
    logout: ({ accessToken, refreshToken }) => request(SOFTWARE_ENDPOINTS.logout, { method: 'POST', body: { refreshToken }, accessToken }),
    changePassword: ({ accessToken, currentPassword, newPassword }) => request(SOFTWARE_ENDPOINTS.password, { method: 'POST', body: { currentPassword, newPassword }, accessToken }),
    license: ({ accessToken }) => request(SOFTWARE_ENDPOINTS.license, { method: 'GET', accessToken }),
    // 上传用同一条 10 秒完整请求时限（含读正文），不再单独放宽到 20 秒。
    sendLogs: ({ accessToken, events }) => request(SOFTWARE_ENDPOINTS.logsBatch, { method: 'POST', body: { events }, accessToken }),
    health: () => request(SOFTWARE_ENDPOINTS.health, { method: 'GET', timeout: 5000 }),
    newRequestId: randomId,
  };
}
