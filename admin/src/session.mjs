// 无尽夏安卓端专用管理后台 · 管理员会话
// 独立管理员会话（/api/admin/login）的令牌只保存在下面这个模块级变量里。
// 本文件禁止出现任何浏览器本地存储写法：凭据不进本地存储，所以刷新页面或换标签页后必须重新登录，
// 界面上要照实说明这一点，不许假装能自动恢复登录态。

let current = null;

/* 距访问令牌到期不足这个余量时提前续期，避免请求正好卡在过点上。 */
export const REFRESH_SKEW_MS = 30 * 1000;

function instantMs(value) {
  const text = String(value ?? "").trim();
  if (!text) return 0;
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return numeric;
  const stamp = Date.parse(text);
  return Number.isNaN(stamp) ? 0 : stamp;
}

export function startSession(payload = {}) {
  const accessToken = String(payload.accessToken ?? "");
  if (!accessToken) throw new Error("登录回包缺少访问令牌");
  current = {
    accessToken,
    refreshToken: String(payload.refreshToken ?? ""),
    accessExpiresAt: instantMs(payload.accessExpiresAt),
    refreshExpiresAt: instantMs(payload.refreshExpiresAt),
    admin: String((payload.admin && payload.admin.username) ?? payload.username ?? ""),
  };
  return describe();
}

export function describe() {
  if (!current) return { loggedIn: false, admin: "", accessExpiresAt: 0, hasRefreshToken: false };
  return {
    loggedIn: true,
    admin: current.admin,
    accessExpiresAt: current.accessExpiresAt,
    hasRefreshToken: current.refreshToken !== "",
  };
}

export function whoami() {
  return current ? current.admin : "";
}

export function readAccessToken() {
  return current ? current.accessToken : "";
}

export function readRefreshToken() {
  return current ? current.refreshToken : "";
}

export function clearSession() {
  current = null;
}

export function isLoggedIn() {
  return current !== null;
}

/* 会话失效（服务端撤销或过期）由调用方在拿到 401 后触发，这里只负责把内存里的令牌丢掉。 */
export function invalidate() {
  clearSession();
  return describe();
}

export function isExpired(nowMs = Date.now()) {
  if (!current) return true;
  if (!current.accessExpiresAt) return false;
  return current.accessExpiresAt <= Number(nowMs);
}

export function shouldRefresh(nowMs = Date.now(), skewMs = REFRESH_SKEW_MS) {
  if (!current) return false;
  if (!current.refreshToken) return false;
  if (!current.accessExpiresAt) return false;
  return current.accessExpiresAt - Number(nowMs) <= skewMs;
}

export function secondsUntilAccessExpiry(nowMs = Date.now()) {
  if (!current || !current.accessExpiresAt) return null;
  return Math.max(0, Math.round((current.accessExpiresAt - Number(nowMs)) / 1000));
}
