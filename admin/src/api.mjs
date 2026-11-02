// 无尽夏安卓端专用管理后台 · 接口层
// 只走同源相对路径 /api/admin/*：云服务的 CSP 是 connect-src 'self'，
// 因此本文件不允许出现任何主机名、端口或协议前缀，路径全部按接口契约写相对地址。

import { clearSession, readAccessToken, readRefreshToken, shouldRefresh, startSession } from "./session.mjs";

export class ApiError extends Error {
  constructor(message, code = "", status = 0) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export function adminPath(path = "", query = "") {
  // The same admin UI can be mounted at the original root or the independent
  // backend-v2 prefix. Derive its own service base from this loaded module.
  const base = new URL("../", import.meta.url).pathname.replace(/\/+$/, "");
  return base + "/api/admin" + path + query;
}

function errorCodeFallback(code, status) {
  if (status === 401) return "会话无效或已过期，请重新登录";
  if (status === 403) return "当前管理员没有这一步的权限";
  if (status === 404) return "云端没有找到对应的记录";
  if (status === 429) return "操作过于频繁，请稍后再试";
  return `云端未接受这次请求（${code}，状态码 ${status}）`;
}

async function parseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: "云端返回的不是可解析的 JSON", code: "INTERNAL_ERROR" };
  }
}

async function send(method, path, { query = "", body, auth = false } = {}) {
  const headers = { accept: "application/json" };
  if (auth) {
    const token = readAccessToken();
    if (token) headers.authorization = "Bearer " + token;
  }
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json; charset=utf-8";
    payload = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(adminPath(path, query), { method, headers, body: payload, credentials: "omit" });
  } catch {
    throw new ApiError("连不上云端服务：请确认本后台与云服务部署在同一站点入口下，且服务在线", "NETWORK_UNAVAILABLE", 0);
  }
  const data = await parseBody(response);
  if (!response.ok) {
    const code = String((data && data.code) || "INTERNAL_ERROR");
    // 401 只说明这条会话不能用了：丢掉内存里的令牌回到登录页，不猜原因也不自动重试。
    if (auth && response.status === 401) clearSession();
    throw new ApiError((data && data.error) || errorCodeFallback(code, response.status), code, response.status);
  }
  return data === null ? {} : data;
}

/* 访问令牌快到期时先用刷新凭据换一把；刷新失败就当这条会话不再可用。 */
async function ensureFresh() {
  if (!shouldRefresh()) return;
  const token = readRefreshToken();
  if (!token) return;
  startSession(await send("POST", "/refresh", { body: { refreshToken: token } }));
}

async function authed(method, path, options = {}) {
  await ensureFresh();
  return send(method, path, { ...options, auth: true });
}

export const api = {
  login: (username, password) => send("POST", "/login", { body: { username, password } }),
  logout: () => send("POST", "/logout", { body: { refreshToken: readRefreshToken() }, auth: true }),
  changePassword: (currentPassword, newPassword) => authed("POST", "/password", { body: { currentPassword, newPassword } }),
  users: (query) => authed("GET", "/users", { query }),
  setUserEnabled: (id, enabled, reason) => authed("POST", `/users/${encodeURIComponent(id)}/enabled`, {
    body: reason ? { enabled, reason } : { enabled },
  }),
  resetUserPassword: (id, password) => authed("POST", `/users/${encodeURIComponent(id)}/reset-password`, { body: { password } }),
  setUserRemark: (id, remark) => authed("POST", `/users/${encodeURIComponent(id)}/remark`, { body: { remark } }),
  logs: (query) => authed("GET", "/logs", { query }),
  runEvents: (query) => authed("GET", "/logs/runs", { query }),
  settings: () => authed("GET", "/settings"),
  putSettings: (payload) => authed("PUT", "/settings", { body: payload }),
};
