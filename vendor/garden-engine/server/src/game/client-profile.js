// 官方 Android 客户端传输指纹（2026-09-07 依据官方小程序源码 + 网关往返反推，**证据分级：推测待验**）。
//
// 为什么要单独一层：风控不看「你像不像人」第一眼，先看「你和官方客户端是不是同一种
// 流量」。我们此前的 Node 请求带 `GardenWorld/1.2.5 (Android)` UA、只有两个请求头、
// 世界 WebSocket 握手带 Chrome 的 UA 与 `origin: null` —— 这三点在服务端日志里都是
// 一眼假。本层把**协议无关**的表现层对齐到实发客户端：UA、请求头集合与顺序、
// keep-alive、WebSocket 握手头，全部以抓包为准，且允许用设备真实字段覆盖。
//
// 铁律：这里只允许出现「设备型号/构建号/屏幕/内存」这类客户端自报字段，
// 绝不出现 token、open_id、content、签名、会话 JSON 或抓包正文。

function envOverride(name, fallback) {
  const raw = process.env[name];
  if (typeof raw !== "string") return fallback;
  const value = raw.trim();
  return value ? value.slice(0, 200) : fallback;
}
/** 设备自报字段（雷电 14 那台 REDMI 的型号/构建号；真机字段允许被抓包或环境变量覆盖）。 */
export const CAPTURED_EQUIPMENT = Object.freeze({
  brand: "REDMI",
  model: "25060RK16C",
  os: "android",
  osVersion: "14",
  buildId: "UQ1A.240205.08311809",
  cpuType: "arm64-v8a",
  ramMb: 5944,
  screenWidth: 1080,
  screenHeight: 1920,
  networkType: "wifi",
  sysLanguage: "zh_CN",
  userLanguage: "",
  deviceType: "Phone",
});

/** 版本与渠道常量（换版本时必须同步，否则又是一处「不像官方」的点）。
 * ⚠️ [第31件·2026-09-23] 三个版本按**官方客户端自己屏幕上现读的号**对齐：
 *   clientVersion ← `V450.0.15-prod`（设置面板现读，截图 shots-29/settings.png）、
 *   appVersion ← APK `versionName=1.3.2`（dumpsys 现读）、packageConfigVersion ← 同构拼法 1003002（原 1002005 ↔ 1.2.5）。
 *   改前分别是 420.0.36 / 1.2.5 / 1002005。 */
export const CAPTURED_VERSIONS = Object.freeze({
  appVersion: "1.3.2",
  clientVersion: "450.0.15",
  packageConfigVersion: "1003002",
  packageId: "495",
  gameId: 160,
  chnId: 459,
  officialClid: 91,
  sdkVersion: "7.0.183",
  egretNativeSupportVersion: "2.0.2",
  driverBaseVersion: "5.0.0",
  osType: 2,
  isNative: true,
  isSimulator: 0,
  isEmulator: false,
  area: "ca",
  networkCountryCode: "ca",
  zoneCode: "ys",
  lang: "zh",
  platform: "android",
  accountPlatform: "Android",
  packageName: "cn.lbwdhysj.gw",
  installedPackageName: "cn.lbwdhysj.gf",
});

/**
 * HTTP 栈标识（UA 三条仍为推测待验，可用 GARDEN_*_USER_AGENT 覆盖）。
 * 2026-09-08 被动抓包实证：这三条 UA 只影响 HTTP 网关与账号层的**表现一致性**；
 * 世界服 WebSocket 已实测**不校验握手头**（5/5 变体都拿到业务响应），所以它们不是世界链路的准入条件。
 */
/**
 * 微信小游戏渠道（chnId=537）的世界登录自报版本。
 * 与 Android 官服(459) 的 420.0.36 不是一套：两条链路包体不同，
 * 版本/设备形态混用会同时错三处（version、osType、deviceInfo），所以分开命名。
 */
export const MINIGAME_VERSIONS = Object.freeze({
  clientVersion: "420.0.33",
  chnId: 537,
  osType: 4,
  isNative: false,
  deviceInfoOsType: "Windows",
  deviceType: "PC",
});

export const CAPTURED_TRANSPORT = Object.freeze({
  // 这三条 UA 目前只能定级为「推测待验」：仓库内还没有能证明它们的抓包文件，
  // 因此一律允许环境变量覆盖，等雷电透明抓包复核后直接改默认值即可，不必动调用方。
  dalvikUserAgent: envOverride("GARDEN_DALVIK_USER_AGENT", "Dalvik/2.1.0 (Linux; U; Android 14; 25060RK16C Build/UQ1A.240205.08311809)"),
  okhttpUserAgent: envOverride("GARDEN_OKHTTP_USER_AGENT", "okhttp/4.12.0"),
  worldWebSocketUserAgent: envOverride("GARDEN_WORLD_WS_USER_AGENT", "okhttp/3.12.14-SNAPSHOT"),
  webSocketSecVersion: "13",
  connection: "Keep-Alive",
  acceptEncodingIdentity: "identity",
  acceptEncodingGzip: "gzip",
});

/**
 * 世界 WebSocket 握手头顺序（Chrome 默认会多发 `sec-websocket-extensions`，且 origin 为 null；官方 okhttp 不发扩展头）。
 * 注意：这套头序原本是为「绕过世界服 TLS 指纹检测」设计的，而该前提已于 2026-09-08 被
 * `tools/world-handshake-probe.mjs` 的 5 组单变量对照证伪。保留它只为表现层一致性，
 * 不再是准入条件，也不应再为它引入 Chrome/CDP。
 */
export const WORLD_WS_HANDSHAKE_ORDER = Object.freeze([
  "upgrade",
  "connection",
  "sec-websocket-key",
  "sec-websocket-version",
  "host",
  "accept-encoding",
  "user-agent",
  "origin",
]);

/** 官方账号/网关层（Dalvik HttpURLConnection）的请求头顺序。 */
export const DALVIK_HEADER_ORDER = Object.freeze([
  "accept-encoding",
  "content-type",
  "user-agent",
  "host",
  "connection",
  "content-length",
]);

/** 官方 RN/okhttp 层（moac 账号中心）的请求头顺序：业务头在前，标准头在后。 */
export const OKHTTP_HEADER_ORDER = Object.freeze([
  "token",
  "lang",
  "deviceid",
  "appid",
  "packagename",
  "platform",
  "version",
  "nonce",
  "requestsecurityivversion",
  "content-type",
  "content-length",
  "host",
  "connection",
  "accept-encoding",
  "user-agent",
]);

export function dalvikUserAgent({
  osVersion = CAPTURED_EQUIPMENT.osVersion,
  model = CAPTURED_EQUIPMENT.model,
  buildId = CAPTURED_EQUIPMENT.buildId,
} = {}) {
  // 三个字段全默认时直接返回（可能被环境变量覆盖过的）抓包 UA，避免两处真相。
  if (arguments.length === 0) return CAPTURED_TRANSPORT.dalvikUserAgent;
  return `Dalvik/2.1.0 (Linux; U; Android ${osVersion}; ${model} Build/${buildId})`;
}

/** 按给定顺序输出请求头，未提供的键跳过；键统一小写，便于逐字节比对。 */
export function orderHeaders(headers, order) {
  const lowered = new Map(Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
  const output = {};
  for (const key of order) {
    if (!lowered.has(key)) continue;
    const value = lowered.get(key);
    if (value === undefined || value === null || value === "") continue;
    output[key] = value;
    lowered.delete(key);
  }
  for (const [key, value] of lowered) {
    if (value === undefined || value === null || value === "") continue;
    output[key] = value;
  }
  return output;
}

/**
 * 网关 `/gw`、账号 `/game/*` 这类 Dalvik 请求的头集合。
 * 返回顺序对象；调用方必须按 `Object.keys` 顺序交给 http.request，Node 会照抄顺序。
 */
export function dalvikRequestHeaders({ host, userAgent, contentLength, contentType = "application/json" }) {
  return orderHeaders({
    "accept-encoding": CAPTURED_TRANSPORT.acceptEncodingIdentity,
    "content-type": contentType,
    "user-agent": userAgent || CAPTURED_TRANSPORT.dalvikUserAgent,
    host,
    connection: CAPTURED_TRANSPORT.connection,
    "content-length": contentLength,
  }, DALVIK_HEADER_ORDER);
}

/** moac 账号中心（okhttp）的头集合：okhttp 默认带 `accept-encoding: gzip`。 */
export function okhttpRequestHeaders({
  host,
  contentLength,
  token,
  lang = CAPTURED_VERSIONS.lang,
  deviceId,
  appId,
  packageName = CAPTURED_VERSIONS.packageName,
  platform = CAPTURED_VERSIONS.accountPlatform,
  version,
  nonce,
  ivVersion,
  extraHeaders,
  userAgent = CAPTURED_TRANSPORT.okhttpUserAgent,
}) {
  return orderHeaders({
    token,
    lang,
    deviceid: deviceId,
    appid: appId,
    packagename: packageName,
    platform,
    version,
    nonce,
    requestsecurityivversion: ivVersion,
    "content-type": "application/json",
    "content-length": contentLength,
    host,
    connection: CAPTURED_TRANSPORT.connection,
    "accept-encoding": CAPTURED_TRANSPORT.acceptEncodingGzip,
    "user-agent": userAgent,
    ...extraHeaders,
  }, OKHTTP_HEADER_ORDER);
}

/**
 * 世界 WebSocket 握头部（CDP Fetch 覆盖用）。
 * Chrome 自己生成 `sec-websocket-key`，我们保持原值；重点是补 `origin`、换成 okhttp UA，
 * 并删掉官方客户端不会发的 `sec-websocket-extensions`。
 */
export function worldWebSocketHeaders({ host, port, requestHeaders = {}, userAgent = CAPTURED_TRANSPORT.worldWebSocketUserAgent }) {
  const lowered = Object.fromEntries(Object.entries(requestHeaders).map(([key, value]) => [key.toLowerCase(), value]));
  const origin = `https://${host}:${port}`;
  return orderHeaders({
    upgrade: lowered.upgrade || "websocket",
    connection: lowered.connection || "Upgrade",
    "sec-websocket-key": lowered["sec-websocket-key"],
    "sec-websocket-version": lowered["sec-websocket-version"] || CAPTURED_TRANSPORT.webSocketSecVersion,
    // Host 必须等于我们真正拨号的 host:port：握手里这个头一旦和 TCP 目的不一致，就是明确的代理/改写特征。
    host: `${host}:${port}`,
    "accept-encoding": lowered["accept-encoding"] || CAPTURED_TRANSPORT.acceptEncodingGzip,
    "user-agent": userAgent,
    origin,
  }, WORLD_WS_HANDSHAKE_ORDER);
}

/** 世界登录 deviceInfo：官方源码里 `osType` 上报为 "Android"（首字母大写），并带屏幕/网络/系统语言。 */
export function worldDeviceInfo(device = {}, { appVersion } = {}) {
  const info = device.deviceInfo || {};
  const value = (key, fallback) => {
    const raw = info[key];
    return raw === undefined || raw === null || raw === "" ? fallback : raw;
  };
  return {
    osType: "Android",
    deviceId: value("deviceId", device.deviceId),
    isEmulator: false,
    osVersion: String(value("osVersion", CAPTURED_EQUIPMENT.osVersion)),
    brand: String(value("brand", CAPTURED_EQUIPMENT.brand)),
    model: String(value("model", CAPTURED_EQUIPMENT.model)),
    networkType: String(value("networkType", CAPTURED_EQUIPMENT.networkType)),
    sysLanguage: String(value("sysLanguage", CAPTURED_VERSIONS.lang)),
    screenWidthPx: Number(value("screenWidthPx", CAPTURED_EQUIPMENT.screenWidth)),
    screenHeightPx: Number(value("screenHeightPx", CAPTURED_EQUIPMENT.screenHeight)),
    deviceType: String(value("deviceType", CAPTURED_EQUIPMENT.deviceType)),
    appVersion: String(value("appVersion", appVersion || CAPTURED_VERSIONS.appVersion)),
  };
}

/**
 * 给账号服务补 `ram_gb`：官方热更新用 `appInfo.memoryState`/`equipment.ram`，
 * 抓包实证 `ram:"5944"`（MB）→ 向上取整成 GB。这是之前 V5 第一层被拒时最明确的差异。
 */
export function ramGbFrom({ memoryMb, ramGb } = {}, fallbackMb = CAPTURED_EQUIPMENT.ramMb) {
  const explicit = Number(ramGb);
  if (Number.isFinite(explicit) && explicit > 0) return String(explicit);
  const mb = Number(memoryMb);
  if (Number.isFinite(mb) && mb > 0) return String(Math.ceil(mb / 1024));
  const fallback = Number(fallbackMb);
  return Number.isFinite(fallback) && fallback > 0 ? String(Math.ceil(fallback / 1024)) : "";
}

