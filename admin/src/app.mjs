// 无尽夏安卓端专用管理后台 · 入口
// 单页 + hash 路由；DOM 只在这里做一次整体重绘，事件全部走委托监听（页面里没有内联事件属性）。
// 会话令牌只经 session.mjs 的内存变量，本文件不读写任何浏览器本地存储。

import { ApiError, api } from "./api.mjs";
import {
  DEFAULT_ROUTE, LOG_FILTER_KEYS, buildHash, buildLogQuery, buildRunQuery, buildSettingsPayload, buildUserQuery,
  cleanLogFilters, clampPage, clampPageSize, errorCodeText, isSessionFailure,
  logFiltersFromQuery, parseHash, validateDays, validateNewPassword, usernameText,
} from "./console.mjs";
import { clearSession, describe, isLoggedIn, startSession, whoami } from "./session.mjs";
import { loginView, logsView, settingsView, shellView, usersView } from "./views.mjs";

const root = document.getElementById("root");
let logsRequestGeneration = 0;
let runRequestGeneration = 0;

const state = {
  route: DEFAULT_ROUTE,
  session: describe(),
  busy: "",
  loginError: "",
  notice: null,
  confirm: null,
  users: { q: "", page: 1, pageSize: 20, loading: false, error: "", data: null, openId: null },
  logs: {
    filters: cleanLogFilters({}),
    page: 1,
    pageSize: 20,
    loading: false,
    error: "",
    data: null,
    expanded: new Set(),
    run: { traceId: "", items: [], loading: false, error: "" },
  },
  settings: { loading: false, busy: "", error: "", data: null, form: null, passwordMessage: null },
};

function pageView() {
  if (state.route === "#/logs") return logsView(state);
  if (state.route === "#/settings") return settingsView(state);
  return usersView(state);
}

function render() {
  state.session = describe();
  if (!state.session.loggedIn) {
    root.className = "";
    root.innerHTML = loginView(state);
    return;
  }
  root.className = "";
  root.innerHTML = shellView(state, pageView());
  syncHash();
}

/* 把当前页的筛选与页码同步进地址栏（只 replaceState，不触发 hashchange）：
 * 这样刷新前复制出来的地址仍然带着同一批筛选条件，跳转链路也能被记录进证据。 */
function syncHash() {
  if (!window.history || typeof window.history.replaceState !== "function") return;
  let hash = state.route;
  if (state.route === "#/logs") hash = buildHash("#/logs", { ...state.logs.filters, page: state.logs.page, pageSize: state.logs.pageSize });
  if (state.route === "#/users") hash = buildHash("#/users", { q: state.users.q, page: state.users.page, pageSize: state.users.pageSize });
  if (hash !== window.location.hash) window.history.replaceState(null, "", hash);
}

function notify(kind, text) {
  state.notice = { kind, text };
}

function fail(err, scope) {
  if (err instanceof ApiError) {
    // 401 已经把内存里的会话清掉了：这里只说明为什么回到登录页，不自动重试旧请求。
    if (err.status === 401 || isSessionFailure(err.code)) {
      clearSession();
      state.loginError = `${scope}失败：${err.message || errorCodeText(err.code)}。请按提示重新登录。`;
      notify("warn", `${scope}未成功：会话已经不可用，需要重新登录。`);
      render();
      return;
    }
    notify("error", `${scope}失败：${err.message || errorCodeText(err.code)}（错误码 ${err.code || "未给出"}）`);
    return;
  }
  notify("error", `${scope}失败：${err && err.message ? err.message : "未知原因"}`);
}

async function guard(scope, task) {
  try {
    return await task();
  } catch (err) {
    fail(err, scope);
    return null;
  }
}

/* ================= 数据加载 ================= */

async function loadUsers() {
  const panel = state.users;
  panel.loading = true;
  panel.error = "";
  render();
  const data = await guard("读取用户列表", () => api.users(buildUserQuery(panel.q, panel.page, panel.pageSize)));
  if (data) {
    panel.data = data;
  } else {
    panel.error = "用户列表没有读到。下面保留的是上一次成功读到的内容；读不到不等于云端没有用户。";
  }
  panel.loading = false;
  render();
}

async function loadLogs() {
  const panel = state.logs;
  const generation = ++logsRequestGeneration;
  const filters = { ...panel.filters };
  const page = panel.page, pageSize = panel.pageSize;
  panel.loading = true;
  panel.error = "";
  render();
  try {
    const data = await api.logs(buildLogQuery(filters, page, pageSize));
    if (generation !== logsRequestGeneration || state.logs !== panel) return;
    panel.data = data;
  } catch (err) {
    if (generation !== logsRequestGeneration || state.logs !== panel) return;
    fail(err, "读取运行日志");
    panel.error = "运行日志没有读到。这里只说明云端这次没返回记录，不能据此判断手机已停止或操作已成功。";
  }
  if (generation !== logsRequestGeneration || state.logs !== panel) return;
  panel.loading = false;
  render();
}

async function loadRun(traceId, userId = "", installId = "") {
  const generation = ++runRequestGeneration;
  const run = { traceId, userId: String(userId ?? ""), installId: String(installId ?? ""), items: [], loading: true, error: "" };
  state.logs.run = run;
  render();
  let data = null;
  try { data = await api.runEvents(buildRunQuery(traceId, run.userId, run.installId)); }
  catch (err) {
    if (generation !== runRequestGeneration || state.logs.run !== run) return;
    fail(err, "读取同次运行");
  }
  if (generation !== runRequestGeneration || state.logs.run !== run || run.traceId !== traceId || run.userId !== String(userId ?? "") || run.installId !== String(installId ?? "")) return;
  if (data) run.items = Array.isArray(data.items) ? data.items : (Array.isArray(data) ? data : []);
  else run.error = "同次运行的事件没有读到；这次没读到不等于这些事件不存在。";
  run.loading = false;
  render();
}

async function loadSettings() {
  const panel = state.settings;
  panel.loading = true;
  panel.error = "";
  const data = await guard("读取后台设置", () => api.settings());
  if (data) {
    panel.data = data;
    panel.form = {
      allowRegistration: data.allowRegistration === true,
      normalDays: data.retention && data.retention.normalDays !== undefined ? String(data.retention.normalDays) : "",
      errorDays: data.retention && data.retention.errorDays !== undefined ? String(data.retention.errorDays) : "",
    };
  } else {
    panel.error = "设置没有读到。下面显示不出来的值一律留空，不填默认值。";
  }
  panel.loading = false;
  render();
}

function reloadCurrent() {
  if (!isLoggedIn()) return;
  if (state.route === "#/users") loadUsers();
  else if (state.route === "#/logs") loadLogs();
  else loadSettings();
}

/* ================= 路由 ================= */

function applyHash(hash) {
  const { route, query } = parseHash(hash);
  const routeChanged = route !== state.route;
  state.route = route;
  if (route === "#/logs" && Object.keys(query).length) {
    runRequestGeneration++;
    state.logs.filters = cleanLogFilters({ ...state.logs.filters, ...logFiltersFromQuery(query) });
    state.logs.page = clampPage(query.page || 1);
    state.logs.pageSize = clampPageSize(query.pageSize || state.logs.pageSize);
    state.logs.data = null;
    state.logs.expanded = new Set();
    runRequestGeneration++;
    state.logs.run = { traceId: "", items: [], loading: false, error: "" };
    if (isLoggedIn()) loadLogs();
    else render();
    return;
  }
  if (routeChanged) {
    state.confirm = null;
    state.notice = null;
    if (isLoggedIn()) reloadCurrent();
    else render();
    return;
  }
  render();
}

window.addEventListener("hashchange", () => applyHash(window.location.hash));

/* ================= 表单与按钮 ================= */

const forms = {
  async login(form) {
    const data = new FormData(form);
    const username = String(data.get("username") || "").trim();
    const password = String(data.get("password") || "");
    state.loginError = "";
    state.busy = "login";
    render();
    try {
      const result = await api.login(username, password);
      startSession(result);
      state.busy = "";
      notify("ok", "已登录。令牌只存在本页内存里，刷新页面后需要重新登录。");
      if (!window.location.hash || parseHash(window.location.hash).route === state.route) reloadCurrent();
      else applyHash(window.location.hash);
    } catch (err) {
      state.busy = "";
      state.loginError = err instanceof ApiError ? (err.message || errorCodeText(err.code)) : "登录失败：未知原因";
      clearSession();
      render();
    }
  },

  "user-filters"(form) {
    const data = new FormData(form);
    state.users.q = String(data.get("q") || "").trim();
    state.users.pageSize = clampPageSize(data.get("pageSize"));
    state.users.page = 1;
    state.users.data = null;
    state.users.openId = null;
    loadUsers();
  },

  "log-filters"(form) {
    const data = new FormData(form);
    const filters = {};
    for (const key of LOG_FILTER_KEYS) {
      filters[key] = String(data.get(key) || "").trim();
    }
    state.logs.filters = cleanLogFilters(filters);
    state.logs.pageSize = clampPageSize(data.get("pageSize"));
    state.logs.page = 1;
    state.logs.data = null;
    state.logs.expanded = new Set();
    runRequestGeneration++;
    state.logs.run = { traceId: "", items: [], loading: false, error: "" };
    loadLogs();
  },

  async "reset-password"(form) {
    const id = form.getAttribute("data-id");
    const user = findUser(id);
    const password = String(new FormData(form).get("password") || "");
    const check = validateNewPassword(password, user ? user.username : "");
    if (!check.ok) {
      notify("error", `新密码不合格：${check.error}`);
      render();
      return;
    }
    const done = await guard("重置密码", () => api.resetUserPassword(id, password));
    // 新密码只用在这一发请求里：不写任何存储、不进状态、界面也不回显，重绘后输入框是空的。
    if (done) {
      notify("ok", "密码已重置。该用户的全部会话与刷新凭据已被撤销，他必须重新登录；本后台不会显示新密码。");
      await loadUsers();
      return;
    }
    render();
  },

  async "remark"(form) {
    const id = form.getAttribute("data-id");
    const remark = String(new FormData(form).get("remark") || "").trim();
    if (remark.length > 200) {
      notify("error", "备注最长 200 字，请缩短后再保存。");
      render();
      return;
    }
    const done = await guard("保存备注", () => api.setUserRemark(id, remark));
    if (done) notify("ok", "备注已保存。");
    await loadUsers();
  },

  "settings"(form) {
    const data = new FormData(form);
    const allowRegistration = data.get("allowRegistration") === "on";
    const normal = validateDays(data.get("normalDays"), "普通记录保留天数");
    const errorDays = validateDays(data.get("errorDays"), "错误记录保留天数");
    if (!normal.ok || !errorDays.ok) {
      notify("error", [normal.error, errorDays.error].filter(Boolean).join("；"));
      render();
      return;
    }
    const payload = buildSettingsPayload({ allowRegistration, normalDays: normal.value, errorDays: errorDays.value });
    saveSettings(payload);
  },

  async "admin-password"(form) {
    const data = new FormData(form);
    const currentPassword = String(data.get("currentPassword") || "");
    const newPassword = String(data.get("newPassword") || "");
    const check = validateNewPassword(newPassword, whoami());
    if (!check.ok) {
      state.settings.passwordMessage = { kind: "error", text: `新密码不合格：${check.error}` };
      render();
      return;
    }
    state.settings.busy = "password";
    render();
    const done = await guard("修改管理员密码", () => api.changePassword(currentPassword, newPassword));
    state.settings.busy = "";
    if (done) {
      clearSession();
      state.settings.passwordMessage = null;
      state.loginError = "管理员密码已改好，云端已撤销全部管理员会话。请用新密码重新登录。";
      notify("ok", "密码已修改；本页内存中的会话已清除，需要重新登录。");
    }
    render();
  },

  "confirm-reason"(form) {
    const reason = String(new FormData(form).get("reason") || "").trim();
    if (state.confirm) state.confirm.reason = reason;
    notify("info", "停用原因已填好，点「确认停用」才会生效；也可以直接点「确认停用」不带原因。");
    render();
  },
};

async function saveSettings(payload) {
  state.settings.busy = "settings";
  render();
  const done = await guard("保存设置", () => api.putSettings(payload));
  state.settings.busy = "";
  if (done) notify("ok", "设置已保存；注册开关与保留期限以云端返回的值为准，下面重新读取一次。");
  await loadSettings();
}

function findUser(id) {
  const items = state.users.data && Array.isArray(state.users.data.items) ? state.users.data.items : [];
  return items.find((user) => String(user.id) === String(id)) || null;
}

const clicks = {
  "reload-page": () => reloadCurrent(),
  "reload-settings": () => loadSettings(),
  logout: async () => {
    const done = await guard("退出登录", () => api.logout());
    clearSession();
    state.notice = null;
    state.loginError = done ? "已退出，服务端会话已撤销。" : "本地会话已清除；云端会话需等它自然过期或按错误提示处理。";
    render();
  },
  "clear-user-filters": () => {
    state.users.q = "";
    state.users.page = 1;
    state.users.data = null;
    loadUsers();
  },
  "clear-log-filters": () => {
    state.logs.filters = cleanLogFilters({});
    state.logs.page = 1;
    state.logs.data = null;
    state.logs.expanded = new Set();
    runRequestGeneration++;
    state.logs.run = { traceId: "", items: [], loading: false, error: "" };
    loadLogs();
  },
  "toggle-user-row": (el) => {
    const id = el.getAttribute("data-id");
    state.users.openId = state.users.openId === id ? null : id;
    render();
  },
  "disable-user": (el) => {
    const id = el.getAttribute("data-id");
    const user = findUser(id);
    // 用户名从状态里取，不从按钮属性回读，避免用户数据在 DOM 属性上来回搬。
    state.confirm = { kind: "disable", id, name: user ? usernameText(user) : `用户 ${id}`, reason: "" };
    render();
  },
  "enable-user": async (el) => {
    const id = el.getAttribute("data-id");
    const user = findUser(id);
    const name = user ? usernameText(user) : `用户 ${id}`;
    const done = await guard("启用用户", () => api.setUserEnabled(id, true));
    if (done) notify("ok", `已恢复 ${name} 的登录资格。注意：这只恢复资格，不会复活已撤销的会话，也不会替他在手机上开启任何任务。`);
    await loadUsers();
  },
  "confirm-no": () => {
    state.confirm = null;
    render();
  },
  "confirm-yes": async () => {
    const confirm = state.confirm;
    if (!confirm) return;
    state.confirm = null;
    const done = await guard("停用用户", () => api.setUserEnabled(confirm.id, false, confirm.reason || undefined));
    if (done) {
      notify("warn", `已停用 ${confirm.name}：该用户的全部会话已撤销，他会立即无法登录与续期。在途的未确认操作未被改写，云端已有日志继续保留。`);
      await loadUsers();
      return;
    }
    render();
  },
  "toggle-log-detail": (el) => {
    const id = el.getAttribute("data-id");
    const set = state.logs.expanded;
    if (set.has(id)) set.delete(id);
    else set.add(id);
    render();
  },
  "open-run": (el) => loadRun(el.getAttribute("data-trace"), el.getAttribute("data-user"), el.getAttribute("data-install")),
  "close-run": () => {
    runRequestGeneration++;
    state.logs.run = { traceId: "", items: [], loading: false, error: "" };
    render();
  },
  "filter-by-run": (el) => {
    state.logs.filters = cleanLogFilters({ traceId: el.getAttribute("data-trace"), userId: el.getAttribute("data-user"), installId: el.getAttribute("data-install") });
    runRequestGeneration++;
    state.logs.run = { traceId: "", items: [], loading: false, error: "" };
    state.logs.page = 1;
    state.logs.data = null;
    loadLogs();
  },
  page: (el) => {
    const panelKey = el.getAttribute("data-panel");
    const panel = state[panelKey];
    if (!panel) return;
    panel.page = clampPage(el.getAttribute("data-page"));
    if (panelKey === "logs") {
      state.logs.expanded = new Set();
      loadLogs();
      return;
    }
    state.users.openId = null;
    loadUsers();
  },
};

document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.getAttribute("data-action");
  const handler = clicks[action];
  if (!handler) return;
  event.preventDefault();
  handler(target);
});

document.addEventListener("submit", (event) => {
  const form = event.target;
  const name = form.getAttribute("data-form");
  if (!name) return;
  event.preventDefault();
  const handler = forms[name];
  if (!handler) return;
  handler(form);
});

state.route = parseHash(window.location.hash).route;
render();
if (isLoggedIn()) reloadCurrent();
else if (!window.location.hash) window.location.hash = DEFAULT_ROUTE;
