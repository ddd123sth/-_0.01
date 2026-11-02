// 无尽夏安卓端专用管理后台 · 纯逻辑层
// 这里只做可以在 Node 里直接单测的事：转义、查询串构造、分页、时刻格式、脱敏、错误码文案、校验。
// 不开 DOM、不发请求、不读任何浏览器本地存储。配色与布局的出处记录在 admin/source.json。

/* 掩码标记：脱敏后的值一律替换成这个记号，界面上不再回显原值。 */
export const MASK_MARK = "〔已脱敏〕";
/* 读不到时的占位，不说成空字符串，避免看起来像「确实是空」。 */
export const DASH = "—";

/* 后台导航名册：键、路由与页面一一对应，严格只有三条，多一条都是骗人的菜单。 */
export const NAV = [
  {
    key: "users",
    route: "#/users",
    label: "用户管理",
    tip: "软件用户名册：搜索、注册时间、启用状态、启用停用、密码重置、备注，以及跳转到该用户运行日志。",
  },
  {
    key: "logs",
    route: "#/logs",
    label: "运行日志",
    tip: "按软件用户、游戏号标签、时间、级别、错误码与关键词筛选手机上报的运行记录，可展开同次运行。",
  },
  {
    key: "settings",
    route: "#/settings",
    label: "后台设置",
    tip: "管理员修改密码、是否允许注册、日志保留期限与最近备份结果。",
  },
];

export const DEFAULT_ROUTE = NAV[0].route;

/* 后台不提供远程登录游戏、读取游戏密码、远程改花种、启动游戏任务或接管失联手机的入口。 */
export const FORBIDDEN_ACTIONS = [
  "远程登录游戏",
  "读取游戏密码",
  "远程改花种",
  "启动游戏任务",
  "接管失联手机",
];

export function navByKey(key) {
  return NAV.find((item) => item.key === key) || null;
}

export function navByRoute(route) {
  const normalized = normalizeRoute(route);
  return NAV.find((item) => item.route === normalized) || null;
}

export function normalizeRoute(route) {
  const raw = String(route ?? "").trim();
  if (!raw) return DEFAULT_ROUTE;
  const withHash = raw.startsWith("#") ? raw : "#" + (raw.startsWith("/") ? raw : "/" + raw);
  const path = withHash.split("?")[0];
  return NAV.some((item) => item.route === path) ? path : DEFAULT_ROUTE;
}

const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/* 所有来自接口的数据进 DOM 前都要走这里；本仓面板用同样做法，代码各自独立一份。 */
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ESC_MAP[char]);
}

/* 敏感键值：只按白名单键名掩码，避免把 stableId、traceId 这类排障字段一起抹掉。 */
const SECRET_PAIR = /([A-Za-z0-9_-]*(?:password|passwd|pwd|passphrase|secret|token|authorization|cookie|sessionid|apikey|api_key|credential)[A-Za-z0-9_-]*)(["']?\s*[:=]\s*["']?)([^\s,;&}"']+)/gi;
const BEARER_VALUE = /(Bearer\s+)(["']?)([A-Za-z0-9._~+/=-]{6,})/gi;

/* 手机端已脱敏一次，云端再过一道；后台显示前本地再过一道，三道互不替代。
 * 先按 Bearer 掩码，再按键值掩码：反过来的话键值规则会把 Bearer 当成值吃掉，令牌原文就漏出来了。 */
export function maskSecrets(text) {
  const raw = String(text ?? "");
  return raw
    .replace(BEARER_VALUE, (match, prefix, quote) => prefix + quote + MASK_MARK)
    .replace(SECRET_PAIR, (match, key, sep) => key + sep + MASK_MARK);
}

export function containsSecret(text) {
  const raw = String(text ?? "");
  SECRET_PAIR.lastIndex = 0;
  BEARER_VALUE.lastIndex = 0;
  return SECRET_PAIR.test(raw) || BEARER_VALUE.test(raw);
}

/* 列表行给人看的那一句：只出脱敏后的内容，绝不返回原文。 */
export function logExcerpt(record = {}) {
  const message = String(record.message ?? "").trim();
  return message ? maskSecrets(message) : DASH;
}

/* 展开行的脱敏诊断块：字段固定白名单，接口多给的键不会显示出来。 */
export const LOG_DETAIL_FIELDS = [
  { key: "eventId", label: "事件标识" },
  { key: "installId", label: "来源安装标识" },
  { key: "level", label: "级别", map: (value) => levelText(value) },
  { key: "category", label: "类别" },
  { key: "appVersion", label: "App 版本" },
  { key: "errorCode", label: "错误码", map: (value, row) => (value ? `${errorCodeText(value)}（${value}）` : "") },
  { key: "traceId", label: "同次运行标识" },
  { key: "operationId", label: "操作标识" },
  { key: "outcome", label: "发出与核验", map: (value) => outcomeText(value) },
  { key: "attempted", label: "是否已尝试", map: (value) => value === true ? "已尝试" : value === false ? "未尝试" : "" },
  { key: "outcomeState", label: "业务结果", map: (value) => ({ confirmed: "已确认", unconfirmed: "未确认", failed: "失败", rejected: "已拒绝", unknown: "未知", dirty: "需核对", scheduled: "已安排", waiting: "等待中" }[String(value)] || "") },
  { key: "receivedAt", label: "云端接收时间", map: (value) => formatTime(value) },
];

export function logDetailRows(record = {}) {
  const rows = LOG_DETAIL_FIELDS.map(({ key, label, map }) => {
    const raw = record[key];
    if (raw === undefined || raw === null || raw === "") return null;
    const value = map ? map(raw, record) : maskSecrets(String(raw));
    return value && value !== DASH ? { label, value } : null;
  }).filter(Boolean);
  const diagnostic = record.diagnostic;
  if (diagnostic && typeof diagnostic === "object" && !Array.isArray(diagnostic)) {
    const labels = { eventType: "事件类型", eventState: "事件状态", phase: "阶段", method: "方法", status: "连接状态", cause: "原因",
      reasonCode: "原因码", action: "后续动作", retryAtMs: "下次重试时间", runEpoch: "运行代次", connectionEpoch: "连接代次",
      requestSequence: "请求序号", schemaVersion: "诊断版本", httpStatus: "本机HTTP状态", sourceNamespace: "来源", loginKind: "登录类型",
      loginCode: "登录码（原值）", loginCodeKey: "登录码字段", serverMsgCode: "服务端消息码（原值）", code: "来源码（原值）",
      readFailureKind: "健康读取异常类型",
      remoteCode: "官服错误码（原值）", transportCode: "传输错误码（原值）", summary: "安全摘要", ok: "检查结果",
      domains: "涉及域", reasons: "原因码", retryable: "可自动重试", userActionRequired: "需要人工处理",
      transportFailure: "传输失败", closureProven: "连接已确认关闭", truncated: "详情有截断",
      domainId: "事实域", path: "安全源码位置", difference: "差异类型", changedPaths: "值或来源差异",
      removedPaths: "本次未投影字段", addedPaths: "新增字段", rawAnchorMatches: "原响应锚匹配",
      priorProjectionReceiptAvailable: "原投影收据存在", proofAdvanced: "来源证明已更新" };
    const eventStateText = { requested: "已请求", "not-started": "未开始", completed: "已完成", incomplete: "未完成", failed: "失败" };
    const displayHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : "缺失";
    const phaseText = { "v5-account-auth": "官服账号认证", "sdk-session-exchange": "渠道会话兑换", health: "本机健康检查", connect: "连接建立" };
    const actionText = { retry: "安排重试", restart: "请求重启", wait: "等待后复查", login: "重新登录",
      "needs-credentials": "需要更新登录凭据", "account-disabled": "账号需要人工处理", "ownership-conflict": "主体归属冲突需处理",
      "single-session": "等待旧会话释放", "wait-network": "等待网络恢复", "wait-time": "等待限流时间结束",
      "wait-egress": "等待网络出口恢复", "refresh-config": "刷新登录配置后重试" };
    for (const [key, label] of Object.entries(labels)) {
      const value = diagnostic[key];
      if (value === undefined || value === null || value === "") continue;
      const shown = key === "changedPaths" && Array.isArray(value) ? value.length ? value.map(item => item && typeof item === "object" && typeof item.path === "string"
        ? `${item.path}（${displayHash(item.storedFingerprint)} → ${displayHash(item.currentFingerprint)}）` : "无效差异项").join("；") : "无变化"
        : Array.isArray(value) ? value.length ? value.filter(item => typeof item === "string").join("、") : "无" : key === "retryAtMs" ? formatTime(Number(value))
        : key === "eventState" ? eventStateText[value] || String(value) : key === "phase" ? phaseText[value] || String(value) : key === "action" ? actionText[value] || String(value)
          : ["retryable","userActionRequired","transportFailure","closureProven","rawAnchorMatches","priorProjectionReceiptAvailable","proofAdvanced"].includes(key) ? value ? "是" : "否"
            : key === "ok" ? value === true ? "通过" : value === false ? "未通过" : String(value) : String(value);
      if (shown && shown !== DASH) rows.push({ label, value: maskSecrets(shown) });
    }
  } else if (typeof diagnostic === "string" && diagnostic.trim()) rows.push({ label: "脱敏诊断", value: maskSecrets(diagnostic.trim()) });
  rows.push({ label: "来源", value: sourceNote() });
  return rows;
}

/* 「手机上报」的来源属性：云端只证明收到这条记录，不代表云端独立核验过官服结果。 */
export function sourceNote() {
  return "手机上报（来源安装标识见上行；内容经本机脱敏后上传，云端只确认收到，不等同于云端独立核验的官服结果）";
}

/* 没有新记录能说的只有一件事：没收到。其余结论一律不由界面替服务器下。 */
export function noRecentLogsNotice() {
  return "最近没有日志只表示云端没有收到新记录，不能据此判断手机已停止、游戏号已离线或某次操作已成功。";
}

export function logAcceptedNotice() {
  return "日志上传成功只表示云端保存成功，不代表游戏操作成功。";
}

export const LOG_LEVELS = ["debug", "info", "warn", "error"];

const LEVEL_TEXT = { debug: "调试", info: "信息", warn: "警告", error: "错误" };

export function levelText(level) {
  const key = String(level ?? "").trim().toLowerCase();
  return LEVEL_TEXT[key] || "未标注级别";
}

export function isErrorRecord(record = {}) {
  if (record.isError === true) return true;
  if (record.isError === false) return false;
  return String(record.level ?? "").toLowerCase() === "error";
}

export function outcomeText(outcome) {
  if (!outcome || typeof outcome !== "object") return "";
  const sent = Number(outcome.sent ?? 0);
  const confirmed = Number(outcome.confirmed ?? 0);
  const unconfirmed = Number(outcome.unconfirmed ?? 0);
  if (![sent, confirmed, unconfirmed].every((n) => Number.isFinite(n) && n >= 0)) return "";
  return `发出 ${sent} · 已确认 ${confirmed} · 未确认 ${unconfirmed}`;
}

/* 错误码到中文提示：客户端只按 code 判分支，文案在这里单点维护。 */
export const ERROR_CODE_TEXT = {
  INPUT_INVALID: "提交的内容不符合要求，请按字段说明重新填写",
  ADMIN_LOGIN_FAILED: "管理员账号或密码不正确",
  ADMIN_DISABLED: "该管理员账号已停用",
  REGISTRATION_CLOSED: "当前已关闭注册",
  USERNAME_TAKEN: "该用户名已被占用",
  LOGIN_THROTTLED: "登录过于频繁，请稍后再试",
  REGISTER_THROTTLED: "注册过于频繁，请稍后再试",
  SOFTWARE_LOGIN_FAILED: "软件账号或密码不正确",
  SOFTWARE_DISABLED: "该软件用户已被停用",
  SESSION_INVALID: "会话无效，请重新登录",
  SESSION_EXPIRED: "会话已过期，请重新登录",
  SESSION_REVOKED: "会话已被撤销，请重新登录",
  SESSION_INSTALL_MISMATCH: "会话与本机的安装标识不一致，请重新登录",
  PASSWORD_TOO_WEAK: "新密码不符合长度与字符要求",
  PASSWORD_REUSED: "新密码与当前密码相同",
  SETTINGS_FIELD_NOT_ALLOWED: "设置接口只接受注册开关与日志保留期限",
  LOG_FIELD_NOT_ALLOWED: "日志字段不在允许清单内",
  LOG_BATCH_TOO_LARGE: "单批日志超出大小限制",
  EVENT_CONFLICT: "同一事件标识收到不同内容，原记录未被覆盖",
  BACKUP_UNAVAILABLE: "最近备份结果暂时读不到",
  RATE_LIMITED: "请求过于频繁，请稍后再试",
  INTERNAL_ERROR: "云端服务内部错误，请稍后重试",
};

export const SESSION_CODES = ["SESSION_INVALID", "SESSION_EXPIRED", "SESSION_REVOKED", "SESSION_INSTALL_MISMATCH"];

export function errorCodeText(code) {
  const key = String(code ?? "").trim();
  if (!key) return "未给出错误码";
  return ERROR_CODE_TEXT[key] || `未登记错误码：${key}`;
}

export function isSessionFailure(code) {
  return SESSION_CODES.includes(String(code ?? "").trim());
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
export const PAGE_SIZE_CHOICES = [10, 20, 50, 100];

export function clampPageSize(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(n, MAX_PAGE_SIZE);
}

export function clampPage(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

export function pageCount(total, pageSize) {
  const size = clampPageSize(pageSize);
  const count = Math.max(0, Number(total) || 0);
  return count === 0 ? 1 : Math.ceil(count / size);
}

export function pageRange(total, page, pageSize) {
  const size = clampPageSize(pageSize);
  const current = clampPage(page);
  const count = Math.max(0, Number(total) || 0);
  const from = count === 0 ? 0 : (current - 1) * size + 1;
  const to = Math.min(count, current * size);
  return { from, to, total: count, totalPages: pageCount(count, size), page: current, pageSize: size };
}

/* 页码条：超过 7 格折成首尾加省略号，省略号用 0 表示，渲染层显示为 …。 */
export function pageWindow(current, totalPages) {
  const total = Math.max(1, Number(totalPages) || 1);
  const now = clampPage(current);
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const pages = [1];
  const start = Math.max(2, now - 1);
  const end = Math.min(total - 1, now + 1);
  if (start > 2) pages.push(0);
  for (let page = start; page <= end; page += 1) pages.push(page);
  if (end < total - 1) pages.push(0);
  pages.push(total);
  return pages;
}

/* 接口约定所有 *At 是 ISO8601 字符串；本函数把表单值规整成 ISO，读不出的一律当空不下发。 */
export function normalizeIso(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const full = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(text);
  if (full) return `${full[1]}-${full[2]}-${full[3]}T${full[4]}:${full[5]}:${full[6] || "00"}${full[7] || ""}${full[8] || ""}`;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(text);
  if (day) return `${text}T00:00:00`;
  const stamp = Date.parse(text);
  return Number.isNaN(stamp) ? "" : new Date(stamp).toISOString();
}

const pad2 = (value) => String(value).padStart(2, "0");

/* 界面时刻：以服务器给出的时刻换算显示；读不出就明说读不到，不猜。 */
export function formatTime(value) {
  const text = String(value ?? "").trim();
  if (!text) return DASH;
  const stamp = Date.parse(text);
  if (Number.isNaN(stamp)) return DASH;
  const date = new Date(stamp);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

export function formatRelative(value, nowMs = Date.now()) {
  const text = String(value ?? "").trim();
  if (!text) return DASH;
  const stamp = Date.parse(text);
  if (Number.isNaN(stamp)) return DASH;
  const seconds = Math.max(0, Math.round((Number(nowMs) - stamp) / 1000));
  if (seconds < 60) return "刚刚收到";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前收到`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前收到`;
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)} 天前收到`;
  return formatTime(text);
}

export function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return DASH;
  if (bytes < 1024) return `${bytes} 字节`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let size = bytes / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index]}`;
}

export function buildQuery(params = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const text = typeof value === "string" ? value.trim() : String(value);
    if (text === "") continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(text)}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

export const LOG_FILTER_KEYS = ["userId", "installId", "stableId", "nickname", "serverName", "from", "to", "level", "category", "errorCode", "traceId", "operationId", "eventState", "outcomeState", "attempted", "q"];

/* 空值不下发：没填的筛选项一个字都不进查询串，避免服务端把空串当成一个条件。 */
export function buildLogQuery(filters = {}, page = 1, pageSize = DEFAULT_PAGE_SIZE) {
  const params = { page: clampPage(page), pageSize: clampPageSize(pageSize) };
  for (const key of LOG_FILTER_KEYS) {
    const raw = filters[key];
    if (raw === undefined || raw === null) continue;
    const text = String(raw).trim();
    if (!text) continue;
    params[key] = key === "from" || key === "to" ? normalizeIso(text) : text;
  }
  return buildQuery(params);
}

export function buildUserQuery(q = "", page = 1, pageSize = DEFAULT_PAGE_SIZE) {
  return buildQuery({ q: String(q ?? "").trim(), page: clampPage(page), pageSize: clampPageSize(pageSize) });
}

export function buildRunQuery(traceId, userId = "", installId = "") {
  return buildQuery({ traceId: String(traceId ?? "").trim(), userId: String(userId ?? "").trim(), installId: String(installId ?? "").trim() });
}

export function parseHash(hash) {
  const raw = String(hash ?? "").replace(/^#/, "");
  const cut = raw.indexOf("?");
  const route = normalizeRoute(cut === -1 ? raw : raw.slice(0, cut));
  const query = {};
  if (cut !== -1) {
    for (const [key, value] of new URLSearchParams(raw.slice(cut + 1))) query[key] = value;
  }
  return { route, query };
}

export function buildHash(route, query = {}) {
  return normalizeRoute(route) + buildQuery(query);
}

/* 从日志页的地址读筛选初值：用户管理页跳转过来时带上 userId。 */
export function logFiltersFromQuery(query = {}) {
  const filters = {};
  for (const key of LOG_FILTER_KEYS) {
    const value = query[key];
    filters[key] = value === undefined || value === null ? "" : String(value);
  }
  return filters;
}

export function cleanLogFilters(filters = {}) {
  const cleaned = {};
  for (const key of LOG_FILTER_KEYS) cleaned[key] = String(filters[key] ?? "").trim();
  return cleaned;
}

export function activeFilterCount(filters = {}) {
  return Object.values(cleanLogFilters(filters)).filter((value) => value !== "").length;
}

export const RETENTION_MIN_DAYS = 1;
export const RETENTION_MAX_DAYS = 3650;

export function validateDays(value, label = "天数") {
  const text = String(value ?? "").trim();
  if (!text) return { ok: false, error: `${label}不能为空` };
  if (!/^\d+$/.test(text)) return { ok: false, error: `${label}必须是 1 到 3650 的整数` };
  const days = Number(text);
  if (days < RETENTION_MIN_DAYS || days > RETENTION_MAX_DAYS) {
    return { ok: false, error: `${label}必须介于 1 与 3650 之间` };
  }
  return { ok: true, value: days, error: "" };
}

/* 设置接口只接受这两个键，其他键一律不发，避免误触服务端未定义字段。 */
export function buildSettingsPayload(input = {}) {
  const payload = {};
  if (typeof input.allowRegistration === "boolean") payload.allowRegistration = input.allowRegistration;
  if (input.normalDays !== undefined || input.errorDays !== undefined) {
    const retention = {};
    if (input.normalDays !== undefined) retention.normalDays = input.normalDays;
    if (input.errorDays !== undefined) retention.errorDays = input.errorDays;
    payload.retention = retention;
  }
  return payload;
}

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 64;

/* 新密码只在输入框里停留，校验后直接发给接口，不写任何存储、不回显。 */
export function validateNewPassword(value, username = "") {
  const text = String(value ?? "");
  if (!text) return { ok: false, error: "请填写新密码" };
  if (text.length < PASSWORD_MIN_LENGTH || text.length > PASSWORD_MAX_LENGTH) {
    return { ok: false, error: `新密码需要 ${PASSWORD_MIN_LENGTH} 到 ${PASSWORD_MAX_LENGTH} 个字符` };
  }
  if (!/^[\x21-\x7e]+$/.test(text)) return { ok: false, error: "新密码只能使用可见 ASCII 字符，不要空格" };
  if (username && text === String(username)) return { ok: false, error: "新密码不能与用户名相同" };
  return { ok: true, error: "" };
}

export function usernameText(user = {}) {
  const name = String(user.username ?? "").trim();
  return name || `用户 ${user.id ?? DASH}`;
}

/* 界面只显示令牌被掩码后的样子，完整值只留在 session 模块的内存变量里。 */
export function maskToken(token) {
  const text = String(token ?? "");
  if (!text) return "";
  if (text.length <= 8) return MASK_MARK;
  return `${text.slice(0, 2)}${MASK_MARK}${text.slice(-2)}`;
}

/* 浏览器本地存储扫描尺：给构建闸与单测用，命中即返回位置与关键词。 */
const BROWSER_STORAGE_USAGE = /(?:window\.)?(?:localStorage|sessionStorage)\b|\bindexedDB\b|document\s*\.\s*cookie|(?:document|window)\s*\.\s*cookie/gi;

export function findStorageUsage(source) {
  const text = String(source ?? "");
  const hits = [];
  BROWSER_STORAGE_USAGE.lastIndex = 0;
  let match = BROWSER_STORAGE_USAGE.exec(text);
  while (match !== null) {
    hits.push({ index: match.index, token: match[0] });
    match = BROWSER_STORAGE_USAGE.exec(text);
  }
  return hits;
}

export function describeBackup(backup = {}) {
  if (!backup || (!backup.lastAt && backup.ok !== true && backup.ok !== false)) {
    return { hasResult: false, lines: [{ label: "最近备份", value: "还没读到备份结果，不能推断备份已成功或已失败" }] };
  }
  const lines = [
    { label: "完成时刻", value: formatTime(backup.lastAt) },
    { label: "结果", value: backup.ok === true ? "成功" : backup.ok === false ? "失败" : "未给出结论" },
    { label: "大小", value: formatBytes(backup.sizeBytes) },
    { label: "校验和", value: backup.sha256 ? maskSecrets(String(backup.sha256)) : DASH },
    { label: "说明", value: backup.detail ? maskSecrets(String(backup.detail)) : "接口未给出更多说明" },
  ];
  return { hasResult: true, lines };
}
