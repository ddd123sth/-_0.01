// Android account/session handoff for the real game connector.
// Credential values stay in memory and are never returned in summaries.
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import zlib from "node:zlib";
import path from "node:path";
import { proxyEgressProblem } from "./net-race.js";
import {
  CAPTURED_TRANSPORT,
  DALVIK_HEADER_ORDER,
  OKHTTP_HEADER_ORDER,
  orderHeaders,
} from "./client-profile.js";

import { RUNTIME_ROOT } from "./runtime-paths.js";
import { parseWorldEndpoints, toWorldEndpoint } from "./net-race.js";
import { androidLoginSignal, beginAndroidHttpRequest, throwIfAndroidLoginAborted, withAndroidLoginSignal, isAndroidHttpTransportError } from './android-login-context.js';

const DEFAULT_CHN_ID = 459;
const DEFAULT_ACCOUNT_CLID = 91;
const DEFAULT_ACCOUNT_APP_ID = "95cdabc1e87532edb21c99f4ed845653";
const DEFAULT_ACCOUNT_PACKAGE_NAME = "cn.lbwdhysj.gw";
const DEFAULT_ACCOUNT_LANG = "zh";
const DEFAULT_ACCOUNT_SECURITY_IV_VERSION = "1";
const DEFAULT_ACCOUNT_SECURITY_AES_IV = "rI9SFNo4PYP8^6MQ";
// [第31件·2026-09-23] 与 APK 现读的 versionName 对齐（改前 1.2.5；客户端设置面板自报 V450.0.15-prod）。
const DEFAULT_APP_VERSION = "1.3.2";
// ⚠️ [39C·X1·硬禁令] 这个常量**一个字都不许改**：它是 V5 请求体的必填键 `version` 的来源
//（`v5-official-fields.js:48` 标 `level:"required"`，值经 `androidDeviceContext` 的 `version:` 传下去），
//   而 V5 那一跳**现在是通的**（8 发全卡在 SDK 那跳），且盘上没有官方 V5 参照帧 ⇒ 没有参照就不许动通着的那条。
const DEFAULT_WORLD_VERSION = "420.0.33";
// [39C·C1] `495` → `506`：09-23 抓包 body `packageId = "506"`、09-12 抓包 `= "495"`，两份响应 url 回显分别为
//   `packageId=506`／`495` ⇒ 它随客户端版本 1.2.5→1.3.2 变。隔离面已查清：本常量只被 :91（配置默认）、
//   :913（`buildAndroidSdkLoginBody` 形参默认）、:1111 与 `loginAndroidCredentials` 的形参默认消费，
//   **V5 请求体里没有 packageId 这一键**（守卫 test:android-auth 里那条正向断言钉住这一点）。
const DEFAULT_PACKAGE_ID = "506";
// [39C·C4] SDK `appInfo._game_version` 的**独立来源**＝官方 1.3.2 抓包现读值（`"450.0.15"`）。
//   ⚠️ 与 `DEFAULT_WORLD_VERSION`（V5 的 `version` 键，仍 "420.0.33"）**刻意不同源**，原因是 X1：
//     V5 那一跳通着、且没有官方 V5 参照 ⇒ 一个字都不许改它；而 appInfo 这一格有抓包现读值 ⇒ 只给 SDK appInfo 单独取值。
const SDK_APPINFO_GAME_VERSION = "450.0.15";
const DEFAULT_GAME_ID = 160;
const DEFAULT_SDK_VERSION = "7.0.183";
import { describeLoginError, extractLoginErrorCode, loginCodeKeyOf, sanitizeRemoteNote, officialErrorNoteFields } from "./login-error-codes.js";
import {
  ANDROID_GPU_UNKNOWN,
  buildV5DeviceFields,
  diffV5LoginBody,
} from "./v5-official-fields.js";

const ACCOUNT_HOST = "moac.babigame.cn";
/**
 * [第29/30件·2026-09-23] SDK 登录网关的候选主机，**按抓包实证排序**：
 * 官方 1.3.2 打的是 `api.boboxia.cn`（透明劫持抓包 14 次，路径形状与我们一致），而 `api.babigame.cn`
 * 在整场抓包里**零命中**。旧域留作**回退**（只在传输层失败时用，业务层拒绝不换域重试）。
 * 可用 `GARDEN_SDK_HOST` 覆盖（逗号分隔，便于临时试验；改这个不改代码）。
 */
const SDK_HOST_CANDIDATES = Object.freeze(String(process.env.GARDEN_SDK_HOST || "api.boboxia.cn,api.babigame.cn")
  .split(",").map((one) => one.trim()).filter(Boolean));
const SDK_HOST = SDK_HOST_CANDIDATES[0];

/**
 * [36A·1] 官方 `/game/login` 请求体的**键集合**（现读写死，出处＝`.runtime/ld-tls/events-20260923085134.jsonl` **seq=0**）：
 *   content,timestamp,signature,loginType,appId,apiVersion,isNewDevice,hotCloudData,deeplinkUrl,packageId,lang,session1,appInfo,uuid
 * 用途只有一个：**发出前**把我们自己的键集合与它做差集，把「多哪些／少哪些」落到日志里（键名而已，值不落）。
 */
export const OFFICIAL_LOGIN_BODY_KEYS = Object.freeze([
  "content", "timestamp", "signature", "loginType", "appId", "apiVersion", "isNewDevice",
  "hotCloudData", "deeplinkUrl", "packageId", "lang", "session1", "appInfo", "uuid",
]);

/** 我们的请求体 × 官方键集合：`{键数, 键名, 缺哪些, 多哪些}`（纯函数；只读键名）。 */
export function describeSdkLoginRequestShape(body = {}) {
  const keys = Object.keys(body || {}).sort();
  const have = new Set(keys);
  const want = new Set(OFFICIAL_LOGIN_BODY_KEYS);
  return {
    键数: keys.length,
    键名: keys,
    缺哪些: OFFICIAL_LOGIN_BODY_KEYS.filter((one) => !have.has(one)),
    多哪些: keys.filter((one) => !want.has(one)),
  };
}
const ACCOUNT_LOGIN_PATH = "/account/login/username/v5";
const ACCOUNT_TIMESTAMP_EXPIRED_STATUS = 14101;

export const ANDROID_AUTH_DEFAULTS = Object.freeze({
  chnId: DEFAULT_CHN_ID,
  accountClid: DEFAULT_ACCOUNT_CLID,
  accountAppId: DEFAULT_ACCOUNT_APP_ID,
  accountPackageName: DEFAULT_ACCOUNT_PACKAGE_NAME,
  accountLang: DEFAULT_ACCOUNT_LANG,
  accountLoginPath: ACCOUNT_LOGIN_PATH,
  accountSecurityIvVersion: DEFAULT_ACCOUNT_SECURITY_IV_VERSION,
  appVersion: DEFAULT_APP_VERSION,
  worldVersion: DEFAULT_WORLD_VERSION,
  packageId: DEFAULT_PACKAGE_ID,
  gameId: DEFAULT_GAME_ID,
  sdkVersion: DEFAULT_SDK_VERSION,
  accountHost: ACCOUNT_HOST,
  sdkHost: SDK_HOST,
  sdkHosts: SDK_HOST_CANDIDATES,
});

// 官方 Android 端两条 HTTP 栈的自报特征不同：账号中心（moac）走 React Native 的 okhttp，
// SDK 与网关走系统 Dalvik。UA、头集合与头顺序都必须按各自的栈发，否则服务端日志里
// 同一台设备会同时出现两种互斥指纹，比 UA 缺失更容易被判定为脚本。
const ANDROID_KEEP_ALIVE_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 8,
  maxFreeSockets: 4,
});

export function androidWireHeaders(hostname, headers, { contentLength, profile } = {}) {
  const resolvedProfile = profile === "okhttp" || profile === "dalvik"
    ? profile
    : (hostname === ACCOUNT_HOST ? "okhttp" : "dalvik");
  if (resolvedProfile === "okhttp") {
    return orderHeaders({
      ...headers,
      "content-type": "application/json",
      "content-length": contentLength,
      host: hostname,
      connection: CAPTURED_TRANSPORT.connection,
      "accept-encoding": CAPTURED_TRANSPORT.acceptEncodingGzip,
      "user-agent": process.env.GARDEN_OKHTTP_USER_AGENT || CAPTURED_TRANSPORT.okhttpUserAgent,
    }, OKHTTP_HEADER_ORDER);
  }
  return orderHeaders({
    ...headers,
    "accept-encoding": CAPTURED_TRANSPORT.acceptEncodingIdentity,
    "content-type": "application/json",
    "user-agent": process.env.GARDEN_DALVIK_USER_AGENT || CAPTURED_TRANSPORT.dalvikUserAgent,
    host: hostname,
    connection: CAPTURED_TRANSPORT.connection,
    "content-length": contentLength,
  }, DALVIK_HEADER_ORDER);
}

/**
 * 原始响应体形态描述器：**只输出元数据，绝不输出正文的任何字符**。
 *
 * 为什么必须有它：V5 账号层响应的正文本身就是 token/content/signature，失败时把原文
 * 塞进 error.message 等于把凭据写进面板日志与数据库；可只留一个 rawLength 又什么都分辨
 * 不出来 —— 同一份代码 12:10 还是合法 JSON、08:21 就变成「200 + 非 JSON」，
 * 必须靠形态把三类完全不同的故障拆开：
 *   html-or-xml  被中间层 / WAF / 网关拦截（防封视角必须当真，立刻停手并上报）
 *   base64-ish / hex-ish  官方改了响应编码格式，要回查解密入口的输入约定
 *   empty        连接层或被限流
 *   json-ish     形似 JSON 但解析失败：截断、非法转义、BOM
 *   binary-ish   未声明的压缩流（gzip 忘了解码等）
 */
export const RESPONSE_SHAPE_SCAN_LIMIT = 4096;

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const hit = Object.keys(headers).find((key) => String(key).toLowerCase() === name);
  const value = hit ? headers[hit] : undefined;
  if (Array.isArray(value)) return String(value[0] ?? "");
  return typeof value === "string" ? value : "";
}

function safeHeaderText(value, limit) {
  return String(value).slice(0, limit).replace(/[^ -~]/g, "");
}

function printableRatioOf(text) {
  if (!text) return 0;
  let printable = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126)) printable += 1;
  }
  return Number((printable / text.length).toFixed(4));
}

export function describeResponseBodyShape(text, headers) {
  const raw = typeof text === "string"
    ? text
    : Buffer.isBuffer(text) ? text.toString("utf8") : String(text ?? "");
  const bom = raw.charCodeAt(0) === 0xfeff;
  const body = bom ? raw.slice(1) : raw;
  const trimmed = body.trim();
  const scanned = body.slice(0, RESPONSE_SHAPE_SCAN_LIMIT);
  const printableRatio = printableRatioOf(scanned);
  let rawKind = "other";
  // 判定顺序有意义：十六进制字符集是 Base64 的子集，先判 hex 才分得开两者；
  // binary-ish 放最后，靠可打印比例兜住「看着像文本其实是压缩流」的情况。
  if (!trimmed) rawKind = "empty";
  else if (/^<(!doctype|html|\?xml)/i.test(trimmed)) rawKind = "html-or-xml";
  else if (/^[{[]/.test(trimmed)) rawKind = "json-ish";
  else if (/^[0-9a-f]{8,}$/i.test(trimmed)) rawKind = "hex-ish";
  else if (/^[A-Za-z0-9+/]{16,}={0,2}$/.test(trimmed.replace(/\s/g, ""))) rawKind = "base64-ish";
  else if (printableRatio < 0.9) rawKind = "binary-ish";
  return {
    rawLength: Buffer.byteLength(body, "utf8"),
    rawKind,
    printableRatio,
    bom,
    contentType: safeHeaderText(headerValue(headers, "content-type"), 64),
    contentEncoding: safeHeaderText(headerValue(headers, "content-encoding"), 24),
    headerNames: headers && typeof headers === "object"
      ? Object.keys(headers).slice(0, 24).map((name) => safeHeaderText(name, 40))
      : [],
  };
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 12);
}

/**
 * 解析账号层响应正文：先按 JSON 解析；失败时保留形态元数据，并把正文换成只含长度的占位对象。
 * 单独导出是为了让「非 JSON 响应」这条失败路径能被离线测试直接覆盖 ——
 * 否则测试只能复刻一份同样的分支，测到的是副本而不是生产代码。
 */
export function parseAndroidAccountResponse(text, headers) {
  const responseShape = describeResponseBodyShape(text, headers);
  const raw = typeof text === "string" ? text : String(text ?? "");
  try {
    return { body: JSON.parse(raw), responseShape };
  } catch {
    if (responseShape.bom) {
      // BOM 不属于 JSON 内容，Node 的 JSON.parse 会直接抛错；剥掉重试一次并显式打标，
      // 免得「官方多发一个对齐字符」被记成一次无法解释的未知故障。
      try {
        const parsed = JSON.parse(raw.slice(1));
        responseShape.bomStripped = true;
        return { body: parsed, responseShape };
      } catch {
        // 剥掉 BOM 仍然不是合法 JSON：落到占位分支，由 rawKind 说明它到底像什么。
      }
    }
    return { body: { rawLength: responseShape.rawLength }, responseShape };
  }
}/** 响应体上限：压缩流异常膨胀会拖垮 Worker，解压前后各设一道。 */
export const ACCOUNT_MAX_COMPRESSED_BYTES = 512 * 1024;
export const ACCOUNT_MAX_DECOMPRESSED_BYTES = 4 * 1024 * 1024;

/**
 * 按 content-encoding 解码响应体。
 *
 * 为什么必须有：我们为了贴合真实 okhttp 客户端，对账号主机发 `Accept-Encoding: gzip`，
 * 而 Node 的 https 不像 okhttp 会自动解压 —— 服务器正常返回的 gzip 正文被当成 UTF-8 文本收下，
 * JSON.parse 必然失败，最后塌缩成一句「官方账号登录失败」。
 * 要修的是**我们的解码**，不是伪装强度：真实客户端就发 gzip，退回 identity 反而是可区分特征。
 */
export function decodeAccountResponseBuffer(chunks, headers) {
  const parts = Buffer.isBuffer(chunks) ? [chunks] : (chunks || []);
  const buffer = Buffer.concat(parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part))));
  const encoding = headerValue(headers, "content-encoding").toLowerCase().trim();
  if (!encoding || encoding === "identity") return { text: buffer.toString("utf8"), compressed: null };
  const fail = (error) => {
    const wrapped = new Error("Android account response " + encoding + " decompression failed");
    wrapped.code = "REAL_ACCOUNT_RESPONSE_DECOMPRESS_FAILED";
    wrapped.causeCode = String((error && (error.code || error.name)) || "UNKNOWN");
    return wrapped;
  };
  let decompressed;
  // canonical 记的是「我们实际按什么解的」，与 shape.contentEncoding（服务器原样声明）分开：
  // 别名 x-gzip/大小写差异不该让消费方各自归一，但也不能把服务器的原始声明改掉。
  let canonical = encoding;
  if (encoding === "gzip" || encoding === "x-gzip") {
    canonical = "gzip";
    try { decompressed = zlib.gunzipSync(buffer); } catch (error) { throw fail(error); }
  } else if (encoding === "br") {
    try { decompressed = zlib.brotliDecompressSync(buffer); } catch (error) { throw fail(error); }
  } else if (encoding === "deflate") {
    try {
      decompressed = zlib.inflateSync(buffer);
    } catch {
      // 不少实现把 raw deflate（没有 zlib 头）也标成 deflate，再试一次才不误伤。
      try { decompressed = zlib.inflateRawSync(buffer); } catch (error) { throw fail(error); }
    }
  } else {
    const error = new Error("Unsupported Android account response encoding: " + safeHeaderText(encoding, 24));
    error.code = "REAL_ACCOUNT_RESPONSE_ENCODING_UNSUPPORTED";
    throw error;
  }
  if (decompressed.byteLength > ACCOUNT_MAX_DECOMPRESSED_BYTES) {
    const error = new Error("Android account response decompressed too large");
    error.code = "REAL_ACCOUNT_RESPONSE_TOO_LARGE";
    throw error;
  }
  return { text: decompressed.toString("utf8"), compressed: canonical };
}
export async function requestJson(hostname, requestPath, body, {
  proxy,
  timeoutMs = 15000,
  headers = {},
  profile,
  signal = androidLoginSignal(),
} = {}) {
  const HttpsProxyAgent = proxy ? (await import("https-proxy-agent")).HttpsProxyAgent : null;
  return new Promise((resolve, reject) => {
    throwIfAndroidLoginAborted(signal);
    const payload = JSON.stringify(body);
    // 出口先判一次：协议不对、或指向内网的代理永远到不了官方服务器。
    // 让 https-proxy-agent 照拨只会换来二十秒超时 + 一句没人看得懂的 ETIMEDOUT，
    // 客户在手机上看到的就是「启动失败」。这里当场拒绝，并说清该怎么改。
    const egress = proxyEgressProblem(proxy);
    if (egress) {
      const error = new Error(egress.message);
      error.code = egress.code;
      reject(error);
      return;
    }
    const lifetime = beginAndroidHttpRequest({ signal, timeoutMs, proxy });
    let settled = false;
    const fail = error => { if (settled) return; settled = true; lifetime.finish(); reject(lifetime.normalize(error)); };
    const succeed = result => { if (settled) return; try { lifetime.check(); } catch (error) { fail(error); return; } settled = true; lifetime.finish(); resolve(result); };
    let request;
    try {
    const agent = proxy ? new HttpsProxyAgent(proxy, { signal: lifetime.signal }) : ANDROID_KEEP_ALIVE_AGENT;
    request = https.request({
      hostname,
      path: requestPath,
      method: "POST",
      agent,
      timeout: timeoutMs,
      headers: androidWireHeaders(hostname, headers, {
        contentLength: Buffer.byteLength(payload),
        profile,
      }),
    }, (response) => {
      // 收 Buffer 而不是字符串：编码可能是 gzip/br，按文本收会把压缩流毁掉（这正是 V5 长期失败的根因）。
      const chunks = [];
      let received = 0;
      response.on("data", (chunk) => {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += part.length;
        if (received > ACCOUNT_MAX_COMPRESSED_BYTES) {
          request.destroy(new Error("Android account response too large"));
          return;
        }
        chunks.push(part);
      });
      response.on("end", () => {
        let decoded;
        try { decoded = decodeAccountResponseBuffer(chunks, response.headers); }
        catch (error) { fail(error); return; }
        // 形态里已经带 contentEncoding：它非空而 rawKind 是 json-ish，就说明解压这条链是通的；
        // 若哪天又出现 binary-ish + contentEncoding 非空，一眼可判定是同源漏解。
        const { body, responseShape } = parseAndroidAccountResponse(decoded.text, response.headers);
        // 只带形态元数据，绝不在这里返回 headers：set-cookie 里可能有会话凭据。
        succeed({ statusCode: response.statusCode, body, responseShape });
      });
      response.on('error', fail);
      response.on('aborted', () => fail(Object.assign(new Error('登录响应连接已中断'), { code: 'ECONNRESET' })));
    });
    } catch (error) { fail(error); return; }
    lifetime.attach(request);
    request.on("timeout", () => request.destroy(Object.assign(new Error("Android account login timed out"), { code: 'ETIMEDOUT' })));
    // 挂了代理时这句错误只会是「代理拨不通」，不是官方拒绝：定错性就会白烧一次性会话。
    request.on("error", fail);
    try { lifetime.check(); request.end(payload); } catch (error) { request.destroy(error); fail(error); }
  });
}

function pickValue(records, field, predicate = () => true) {
  return records
    .filter((record) => record?.field === field && predicate(record))
    .sort((left, right) => Number(right?.byteLength || 0) - Number(left?.byteLength || 0))
    .map((record) => record?.value)
    .find((value) => value !== undefined && value !== null && value !== "");
}

function recordLength(record) {
  return Number(record?.byteLength || Buffer.byteLength(String(record?.value || ""), "utf8"));
}

function pickSdkArtifactValue(records, field, predicate) {
  return records
    .filter((record) => record?.field === field)
    .filter((record) => Array.isArray(record?.tags) && record.tags.includes("sdk-login"))
    .filter((record) => predicate(String(record?.value || ""), record))
    .sort((left, right) => recordLength(right) - recordLength(left))
    .map((record) => record.value)
    .find(Boolean);
}

function safeInteger(value) {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !/^-?\d{1,15}$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function firstSafeInteger(values) {
  for (const value of values) {
    const parsed = safeInteger(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/**
 * 登录失败必须落到「能不能重试」上。
 * 码系边界：本函数的表来自 SDK 的 LOGIN 枚举（101~104 / 2001~2047 / 902048~902053）。
 * V5 账号服务另有 14xxx 码系（如 14101=时间戳过期，见 ACCOUNT_TIMESTAMP_EXPIRED_STATUS），
 * 两者不同源；表外的码只记录 loginCode，不改写官方层的原始文案。
 * 封号/设备封/IP 封/密码错如果继续按普通失败重试，就是拿着废凭据反复撞风控，
 * 那正是最容易被归并成自动化脚本的行为。这里把官方码翻译成处置标记挂在 error 上。
 * 只使用官方码表里的常量文案与数字，绝不拼接响应内容。
 */
function attachLoginOutcome(error, body) {
  const outcome = describeLoginError(extractLoginErrorCode(body));
  // [第26件·2026-09-23 A] 连**键名**一起留下：只记码的话判不出它是哪一层的数（run 149 就卡在这）。
  const codeKey = loginCodeKeyOf(body);
  if (codeKey) error.loginCodeKey = codeKey;
  if (outcome.code !== null) error.loginCode = outcome.code;
  if (outcome.name) error.loginReason = outcome.name;
  error.loginKind = outcome.kind;
  error.retryable = outcome.retryable === true;
  error.stopAccount = outcome.stopAccount === true;
  error.needsUserAction = outcome.needsUserAction === true;
  // 只在**认识这个码**时才替换文案：V5 账号服务用的是 14xxx 码系，与 SDK 的 LOGIN 枚举不同源，
  // 不认识的码就把官方那一层的原始描述覆盖掉，等于用猜测冒充证据。
  if (outcome.name) {
    error.message = outcome.message;
    error.code = outcome.kind === "blocked" || outcome.kind === "risk_ip"
      ? "REAL_ACCOUNT_BLOCKED"
      : outcome.kind === "credential"
        ? "REAL_ACCOUNT_CREDENTIAL_REJECTED"
        : error.code;
  }
  return error;
}
function loginFailure(response, fallback, code = "REAL_LOGIN_FAILED") {
  // Remote errors can echo request fields. Keep credentials out of application
  // logs by exposing only a local message and non-sensitive status metadata.
  const error = new Error(fallback);
  error.code = "REAL_LOGIN_FAILED";
  if (code) error.code = code;
  const httpStatus = safeInteger(response?.httpStatus ?? response?.statusCode);
  if (httpStatus !== undefined && httpStatus >= 100 && httpStatus <= 599) {
    error.httpStatus = httpStatus;
    error.statusCode = httpStatus;
  }
  const remoteCode = firstSafeInteger([
    response?.remoteCode,
    response?.body?.code,
    response?.body?.status,
    response?.code,
    response?.status,
    response?.m,
    response?.err,
  ]);
  if (remoteCode !== undefined) error.remoteCode = remoteCode;
  if (response && typeof response === "object") {
    const body = response.body && typeof response.body === "object" ? response.body : response;
    Object.assign(error, sdkResponseReadings({ body }));
    attachLoginOutcome(error, body);
  }
  return error;
}

// The SDK heartbeat and login hops share the same safe error collector. This
// accepts an already received response; it never starts a request or retries.
export function androidOfficialFailure(response, fallback, code) {
  return loginFailure(response, fallback, code);
}

function sdkSession1(now = Date.now()) {
  const random = crypto.randomBytes(16).toString("base64url").slice(0, 17);
  const timestamp = String(Number(now)).padStart(13, "0").slice(-13);
  return `s1${random}${timestamp}`;
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""),
  );
}

function primaryLanguage(value) {
  const language = String(value || "zh").trim().toLowerCase();
  if (!language) return "zh";
  const normalized = language.replace("_", "-");
  if (normalized === "zh-hant" || normalized === "zh-hk" || normalized === "zh-tw") return "zh-tw";
  return normalized.split("-")[0];
}

function officialVersion(value = DEFAULT_APP_VERSION) {
  const version = String(value);
  return version.startsWith("v") ? version : `v${version}`;
}

function firstString(...values) {
  const value = values.find((item) => item !== undefined && item !== null && String(item) !== "");
  return value === undefined ? "" : String(value);
}

function resolvedTimezone(value) {
  if (value) return String(value);
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai"; }
  catch { return "Asia/Shanghai"; }
}

function requestSecurityKey(deviceId, nonce, timestamp) {
  const seed = `${String(deviceId)}${String(nonce)}${String(timestamp)}`;
  const md5 = crypto.createHash("md5").update(seed, "utf8").digest();
  return crypto.createHash("sha256").update(md5).digest();
}

function accountCipherContext({
  deviceId,
  nonce,
  timestamp,
  aesIv = DEFAULT_ACCOUNT_SECURITY_AES_IV,
}) {
  const iv = Buffer.from(String(aesIv), "utf8");
  if (iv.length !== 16) throw new Error("Android request-security IV must be 16 bytes");
  if (!deviceId || !nonce || !Number.isFinite(Number(timestamp))) {
    throw new Error("Android request-security context is incomplete");
  }
  return {
    key: requestSecurityKey(deviceId, nonce, Number(timestamp)),
    iv,
  };
}

export function encryptAndroidAccountPayload(value, context) {
  const { key, iv } = accountCipherContext(context);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]).toString("base64");
}

export function decryptAndroidAccountPayload(data, context) {
  const { key, iv } = accountCipherContext(context);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  const plaintext = Buffer.concat([
    decipher.update(String(data), "base64"),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext);
}

export function buildAndroidAccountCanonical(
  body,
  { method = "POST", requestPath = ACCOUNT_LOGIN_PATH } = {},
) {
  const params = { ...body };
  delete params.fullSignature;
  const fields = Object.keys(params)
    .sort()
    .filter((key) => params[key] !== undefined
      && params[key] !== null
      && typeof params[key] !== "object")
    .map((key) => `${key}=${String(params[key])}`);
  return `${method}\n${requestPath}\n${fields.join("&")}`;
}

export function createAndroidAccountNonce(timestamp = Date.now(), random = Math.random) {
  const milliseconds = Number(timestamp);
  if (!Number.isFinite(milliseconds)) {
    throw new Error("Android request-security nonce timestamp is invalid");
  }
  return `v5-${Math.trunc(milliseconds)}-${String(random()).toString(36).slice(2, 12)}`;
}

export function readAndroidAccountClock(now = Date.now) {
  const milliseconds = Number(now());
  if (!Number.isFinite(milliseconds)) {
    throw new Error("Android request-security clock is invalid");
  }
  return Math.trunc(milliseconds);
}

export function buildAndroidAccountSecureRequest(body, {
  deviceId = body?.deviceId,
  method = "POST",
  requestPath = ACCOUNT_LOGIN_PATH,
  timestamp,
  nonce,
  aesIv = DEFAULT_ACCOUNT_SECURITY_AES_IV,
  ivVersion = DEFAULT_ACCOUNT_SECURITY_IV_VERSION,
} = {}) {
  // The official client samples its request-security clock independently for
  // the nonce and the encrypted outer timestamp.
  const resolvedTimestamp = timestamp === undefined ? Date.now() : Number(timestamp);
  const resolvedNonce = nonce === undefined ? createAndroidAccountNonce(Date.now()) : nonce;
  const unsignedBody = { ...body };
  delete unsignedBody.fullSignature;
  const canonical = buildAndroidAccountCanonical(unsignedBody, { method, requestPath });
  const signedBody = {
    ...unsignedBody,
    fullSignature: crypto.createHmac("sha256", String(deviceId))
      .update(canonical, "utf8")
      .digest("hex"),
  };
  const context = { deviceId, nonce: resolvedNonce, timestamp: resolvedTimestamp, aesIv };
  return {
    body: {
      timestamp: resolvedTimestamp,
      data: encryptAndroidAccountPayload(signedBody, context),
    },
    headers: {
      nonce: resolvedNonce,
      requestSecurityIvVersion: String(ivVersion),
    },
    context,
  };
}

export function buildAndroidAccountRequestAttempt(body, {
  now = Date.now,
  serverTimeOffset = 0,
  attempt = 0,
  nonce: nonceFactory,
  random,
} = {}) {
  const offset = Number(serverTimeOffset);
  if (!Number.isFinite(offset)) {
    throw new Error("Android request-security server time offset is invalid");
  }
  const nonceTimestamp = readAndroidAccountClock(now) + offset;
  const timestamp = readAndroidAccountClock(now) + offset;
  const nonce = typeof nonceFactory === "function"
    ? nonceFactory(nonceTimestamp, attempt)
    : createAndroidAccountNonce(nonceTimestamp, random);
  return {
    nonceTimestamp,
    timestamp,
    secureRequest: buildAndroidAccountSecureRequest(body, { timestamp, nonce }),
  };
}

export function decryptAndroidAccountResponse(body, context) {
  if (!body || body.isEncrypt !== true) return body;
  if (typeof body.encryptData !== "string" || !body.encryptData) {
    throw new Error("Android encrypted account response is empty");
  }
  return decryptAndroidAccountPayload(body.encryptData, context);
}

/** 官方 Android 客户端的 sysLanguage 实测值（language 仍是主语言 zh，两者不能混用）。 */
export const DEFAULT_SYS_LANGUAGE = "zh_CN";

/** 采集档案默认落点；用 GARDEN_ANDROID_DEVICE_PROFILE 覆盖。锚点见 runtime-paths.js。 */
export const ANDROID_DEVICE_PROFILE_CANDIDATE = path.join(RUNTIME_ROOT, "android_device_profile.json");

export function androidDeviceProfilePath() {
  const configured = String(process.env.GARDEN_ANDROID_DEVICE_PROFILE || "").trim();
  // "off" 是显式关闭档案，不能被 path.resolve 变成一个路径。
  if (configured === "off") return configured;
  if (configured) return path.resolve(configured);
  return ANDROID_DEVICE_PROFILE_CANDIDATE;
}

/**
 * 生产入口用的档案发现。两道保护：
 *  - GARDEN_ANDROID_DEVICE_PROFILE 显式指定时以它为准，值 "off" 表示关闭；
 *  - 没显式指定且 NODE_ENV=test 时一律不自动发现 —— 自动化测试绝不允许
 *    意外拿着真机设备号去打官方服务器，那会直接消耗一次真实登录。
 * 需要点名某份档案时直接给 readAndroidDeviceProfile(path)，它不受这两条限制。
 */
export function discoverAndroidDeviceProfile() {
  const configured = String(process.env.GARDEN_ANDROID_DEVICE_PROFILE || "").trim();
  if (!configured && String(process.env.NODE_ENV || "") === "test") return null;
  return readAndroidDeviceProfile(configured || ANDROID_DEVICE_PROFILE_CANDIDATE);
}

/**
 * 读取 tools/collect-android-device.mjs 采到的**当前设备真值**。
 * 读不到就返回 null：设备号缺失必须被闸门报出来，绝不回退成自造哈希。
 */
export function readAndroidDeviceProfile(profilePath = androidDeviceProfilePath()) {
  if (!profilePath || profilePath === "off" || !fs.existsSync(profilePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(profilePath, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 官方 V5 账号请求体（Android 分支）的等价实现。
 *
 * 权威依据两条：
 *  1. 热更新账号 SDK 的 buildV5DeviceFields / buildFullFingerprintInner（逐行语义）；
 *  2. 官方客户端一次成功登录自己打进 logcat 的 35 键 canonical（实际字节）。
 *
 * 由此定下三条硬规则，别再回退：
 *  - 键集必须与官方 35 键完全相等。多发（历史上的 storeCountryCode）与少发一样，
 *    都是服务端能直接观测到的形态差异。
 *  - 官方在这台设备上发空串的字段（build_fingerprint / oaid / carrier / idfv /
 *    darwin_version / device_product / simCountryCode）我们就发空串，不要拿 getprop
 *    去补真值「更像真机」。比官方更完整本身就是新特征，而且会改变参与签名的键集。
 *  - deviceId 只接受真实采集值（显式注入、环境变量或采集档案）。自造设备号会撞上
 *    官方 /user/device/login/record 的设备记录，是最容易被归并成脚本的特征之一。
 */
/** Digits only: an unmeasured 0 must stay empty so resolution becomes "" instead of "0x0". */
function positiveText(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? String(parsed) : "";
}

export function buildAndroidAccountLoginBody({
  username,
  password,
  passwordEncoded = false,
  deviceId,
  appVersion = DEFAULT_APP_VERSION,
  accountClid = DEFAULT_ACCOUNT_CLID,
  accountAppId = DEFAULT_ACCOUNT_APP_ID,
  packageName = DEFAULT_ACCOUNT_PACKAGE_NAME,
  lang = DEFAULT_ACCOUNT_LANG,
  platform = "Android",
  showVerEighteenAgeTips = false,
  simCountryCode = "",
  networkCountryCode = "ca",
  sysLanguage = DEFAULT_SYS_LANGUAGE,
  device,
  fingerprint = {},
}) {
  const info = device?.deviceInfo || {};
  const resolvedDeviceId = firstString(deviceId, device?.deviceId, info.deviceId);
  if (!resolvedDeviceId) {
    const error = loginFailure(
      null,
      "缺少真实设备标识 deviceId，已拒绝构造 V5 登录请求（未消耗任何登录机会）",
      "REAL_DEVICE_ID_MISSING",
    );
    error.missingFields = ["deviceId"];
    throw error;
  }
  const official = buildV5DeviceFields({
    appEntry: info,
    equipment: {
      ...info,
      screenWidth: positiveText(firstString(info.screenWidthPx, info.screenWidth)),
      screenHeight: positiveText(firstString(info.screenHeightPx, info.screenHeight)),
      ram: firstString(info.ram, info.memoryState),
    },
    appInfo: { memoryState: firstString(info.memoryState, info.ram), deviceId: resolvedDeviceId },
    platform,
  });
  const osVersion = firstString(fingerprint.osVersion, info.osVersion, info.systemOSVersion);
  const width = positiveText(firstString(fingerprint.screenWidth, info.screenWidthPx, info.screenWidth));
  const height = positiveText(firstString(fingerprint.screenHeight, info.screenHeightPx, info.screenHeight));
  const brand = firstString(fingerprint.brand, info.equipmentBrand, info.brand, official.brand);
  const model = firstString(fingerprint.model, info.equipmentModel, info.model, official.model);
  const isAndroid = String(platform || "").toLowerCase() === "android";
  return {
    appId: accountAppId,
    platform,
    version: officialVersion(appVersion),
    packageName,
    clid: String(accountClid),
    deviceId: resolvedDeviceId,
    requestSecurityIvVersion: DEFAULT_ACCOUNT_SECURITY_IV_VERSION,
    gpu: firstString(fingerprint.gpu, info.gpu, isAndroid ? ANDROID_GPU_UNKNOWN : ""),
    os_version: osVersion,
    language: primaryLanguage(firstString(fingerprint.language, info.language, info.userLanguage, sysLanguage, lang)),
    carrier: firstString(fingerprint.carrier, info.isp),
    sdk_version: firstString(fingerprint.sdkVersion, info.sdkVersion, osVersion),
    timezone: resolvedTimezone(firstString(fingerprint.timezone, info.timezone, info.timeZone, official.timezone)),
    cpu: firstString(fingerprint.cpu, info.cpuType, info.cpu, official.cpu, "arm64-v8a"),
    model,
    network_type: firstString(fingerprint.networkType, info.netWorkType, info.networkType, official.network_type),
    resolution: firstString(fingerprint.resolution, official.resolution, width && height ? width + "x" + height : ""),
    ram_gb: firstString(fingerprint.ramGb, official.ram_gb),
    brand,
    manufacturer: firstString(fingerprint.manufacturer, info.manufacturer, official.manufacturer, brand),
    device_product: firstString(fingerprint.deviceProduct, info.deviceProduct),
    app_instance_id: firstString(
      fingerprint.appInstanceId,
      info.appInstanceId,
      official.app_instance_id,
      "inst-" + resolvedDeviceId.slice(0, 12),
    ),
    keychain_id: firstString(fingerprint.keychainId, info.keychainId, official.keychain_id, resolvedDeviceId),
    idfv: firstString(fingerprint.idfv, info.idfv),
    darwin_version: firstString(fingerprint.darwinVersion, info.darwinVersion),
    android_id: firstString(fingerprint.androidId, info.androidId, official.android_id, resolvedDeviceId),
    build_fingerprint: firstString(fingerprint.buildFingerprint, info.buildFingerprint),
    oaid: firstString(fingerprint.oaid, info.oaid),
    name: username,
    value: passwordEncoded
      ? String(password)
      : Buffer.from(String(password), "utf8").toString("base64"),
    lang,
    showVerEighteenAgeTips,
    simCountryCode,
    networkCountryCode,
    sysLanguage: firstString(fingerprint.sysLanguage, info.sysLanguage, sysLanguage),
  };
}

/**
 * 出站键集闸门：与官方 canonical 的 35 键不等就本地拒发。
 * 纯本地检查，不消耗一次性登录机会；宁可停在这里，也不要拿官方服务器去试一个新形态。
 */
export function assertV5LoginBodyKeys(body) {
  const diff = diffV5LoginBody(body);
  if (diff.ok) return diff;
  const error = loginFailure(
    null,
    "V5 请求体键集与官方不一致，已拒绝发送（未消耗任何登录机会）",
    "REAL_V5_BODY_SHAPE_MISMATCH",
  );
  error.missingFields = diff.missing;
  error.extraFields = diff.extra;
  throw error;
}

export function buildAndroidAccountLoginHeaders({
  deviceId,
  appVersion = DEFAULT_APP_VERSION,
  accountAppId = DEFAULT_ACCOUNT_APP_ID,
  packageName = DEFAULT_ACCOUNT_PACKAGE_NAME,
  lang = DEFAULT_ACCOUNT_LANG,
  platform = "Android",
  token = "",
  nonce,
  ivVersion = DEFAULT_ACCOUNT_SECURITY_IV_VERSION,
} = {}) {
  const headers = {
    "Content-Type": "application/json",
    token,
    lang,
    deviceId,
    appId: accountAppId,
    packageName,
    platform,
    version: officialVersion(appVersion),
  };
  if (nonce) headers.nonce = nonce;
  if (ivVersion) headers.requestSecurityIvVersion = String(ivVersion);
  return headers;
}

export function parseAndroidAccountHandoff(result) {
  const body = result?.body || {};
  const data = body.data || body.result || {};
  const handoff = {
    accountToken: data.token || body.token,
    content: data.content || body.content,
    timestamp: data.timestamp ?? body.timestamp,
    signature: data.signature || body.signature,
    appId: data.appId || body.appId,
    apiVersion: data.apiVersion ?? body.apiVersion ?? 2,
    hotCloudData: data.hotCloudData ?? body.hotCloudData ?? "{}",
    deeplinkUrl: data.deeplinkUrl ?? body.deeplinkUrl ?? "",
    // [34B·1] `isNewDevice` 是**透传**：V5 给就带、不给就不带（官方语义＝ `_ref/game_src/scripts/src/assets/scripts/game.js`
    //   @397161 `t.$userInfo.channelLoginInfo=n; var c=…getValue(n,"isNewDevice"); c&&(i.isNewDevice=c)` 与
    //   @397839 `i.isNewDevice&&(n.isNewDevice=i.isNewDevice)`）⇒ 这里**不给默认值**（缺就是 undefined，绝不写常量 true）。
    //   我们自己也在采它：`tools/android-account-login-summary.mjs` 的 `DEVICE_FLAGS`（:128 那一段）。
    // 〔2026-10-14〕`openId` 同上一条规矩：**V5 给了才挂这一格**（恒挂一个 undefined 会让
    //   `"openId" in handoff` 变 true，而守卫钉的正是「没给不许凭空出现」）。
    //   今天现读：V5 响应里**没有** openId ⇒ 这一格今天不会出现；官方 login body 那枚 32 位 openId
    //   另有来源（待查），本改动只负责"哪天 V5 给了就自动带上"。
    isNewDevice: data.isNewDevice ?? body.isNewDevice,
    // [34B·3] **只读观测、不改行为**：这次 V5 响应里到底有没有 `loginType` 这个键——只记布尔，不记值。
    //   为什么要问：官方那侧它是透传（`_ref/sdk_drivers/modosdk_official.js` @4953 `a.loginType=n.loginType||""`），
    //   而我们的 `DEVICE_FLAGS` 不含它 ⇒ 今天没人知道 V5 给不给；先问清楚，下一批才谈得上改透传。
    v5HasLoginType: (data.loginType ?? body.loginType) !== undefined,
  };
  const status = typeof body.status === "string"
    ? body.status.trim().toLowerCase()
    : body.status;
  const httpOk = result?.statusCode === undefined
    || (Number(result.statusCode) >= 200 && Number(result.statusCode) < 300);
  const statusOk = status === undefined || status === 0 || status === "0" || status === "success";
  const missing = [];
  if (!httpOk) missing.push("httpStatus");
  if (!statusOk) missing.push("status");
  if (!handoff.accountToken) missing.push("accountToken");
  if (!handoff.content) missing.push("content");
  if (!handoff.signature) missing.push("signature");
  if (!handoff.appId) missing.push("appId");
  if (!Number.isFinite(Number(handoff.timestamp))) missing.push("timestamp");
  if (missing.length) {
    const error = loginFailure(result, "官方账号登录失败", "REAL_ACCOUNT_LOGIN_FAILED");
    // 只暴露「缺什么」和「响应里有哪些键」，绝不暴露任何值：V5 响应体里就是 token/content/signature。
    // 没有这一步，所有解析失败都会塌缩成同一句文案，等于无法诊断。
    error.missingFields = missing;
    error.responseKeys = Object.keys(body).slice(0, 24);
    error.dataKeys = Object.keys(data).slice(0, 32);
    if (typeof status === "string" || typeof status === "number") error.remoteStatus = status;
    // 响应形态元数据：长度 / 类型 / 可打印比例 / Content-Type / 是否带 BOM，不含任何正文字符。
    error.responseShape = result?.responseShape ?? null;
    attachLoginOutcome(error, body);
    const shapeKind = error.responseShape?.rawKind;
    // 形似 JSON 就不加后缀（那是官方正常返回了业务错误码，形态不是重点）；
    // 非 JSON 形态必须让文案自己说话，避免又被塌缩成同一句「官方账号登录失败」。
    if (shapeKind && shapeKind !== "json-ish") error.message += "（响应形态 " + shapeKind + "）";
    throw error;
  }
  return handoff;
}

export function buildAndroidSdkAppInfo(device, {
  clientIp,
  ram,
  cpuType = "arm64-v8a",
  sdkVersion = DEFAULT_SDK_VERSION,
  timezone = -new Date().getTimezoneOffset() / 60,
  // 〔2026-10-14〕**服务器现下发这一格，我们必须用它**：① `pack/queryPackageConfig` 的
  //   `userParams.gameVersion` 今天现读＝`460.0.23`，而下面那个常量是 09-06 那份抓包的 `450.0.15`
  //   ⇒ 我们一直把服务器刚告诉我们的值丢掉、改发一枚过期常量（"读到了不用"那一族）。
  //   官方 `issueAdToken` 按「这台设备登记过的版本」配广告位，版本对不上就拒（现读 1856，
  //   且同一请求体只换 pkgId 就从 1856 变 1855 ⇒ 这个接口确实在按包体/版本分档）。
  //   读不到活值才落回常量，且**由调用方把用的哪一路记进跳日志**（不许静默冒充活值）。
  gameVersion,
} = {}) {
  const info = device?.deviceInfo || {};
  const language = primaryLanguage(info.sysLanguage);
  const resolvedRam = ram === undefined || ram === null || ram === ""
    ? firstString(info.memoryState, info.ram)
    : ram;
  return compactObject({
    _ip: clientIp,
    _os: "android",
    _ram: resolvedRam === "" ? undefined : String(resolvedRam),
    _os_version: String(info.osVersion || "14"),
    _cpu_type: cpuType,
    _time_zone: String(timezone),
    _game_platform: "mobilegame",
    // [39C·C4] 优先用**① 那一跳服务器现下发的** `gameVersion`；没有活值才落回抓包常量。
    _game_version: String(gameVersion || "").trim() || SDK_APPINFO_GAME_VERSION,
    _sdk_version: sdkVersion,
    _screen_height: Number(info.screenHeightPx) || 1920,
    _screen_width: Number(info.screenWidthPx) || 1080,
    _network_type: info.networkType || "wifi",
    // [39C·C4] 这两格**不吃 artifact 的历史记录**：旧写法 `device?.appVersion` 拿到的是会话 artifact 里
    //   09-07 那条 logcat 记录（"1.2.5"，见 `androidDeviceContext` 的 `appVersion: anyValue("appVersion")`），
    //   把第 31 件已经对齐好的常量盖掉了。官方 1.3.2 抓包现读这两格都是 "1.3.2" ＝ 本常量 ⇒ 直接以常量为准。
    _package_version: DEFAULT_APP_VERSION,
    _native_version: DEFAULT_APP_VERSION,
    _equipment_model: String(info.model || "25060RK16C").toLowerCase(),
    _equipment_brand: String(info.brand || "REDMI").toLowerCase(),
    _deviceId: device?.deviceId,
    _equipment_language: language,
    _runtime_language: language,
  });
}

export function buildAndroidSdkLoginBody({
  handoff,
  device,
  packageId = DEFAULT_PACKAGE_ID,
  session1 = sdkSession1(),
  // [39C·C2] 形状对照（**这半句是对的，保留**）：官方 1.3.2 的 uuid 是 **31 字 base64url**，
  //   而 1.2.5 那一版是 36 字带 4 个连字符的标准 UUID（剖面现读：长度 36／连字符 4／去连字符后全 hex）。
  // [39F·F1/F2 订正]**来源**：它不是"客户端侧生成"（那是 39C 的错推断，只查到 ③ 就下了结论）——
  //   真出处是 **① `pack/queryPackageConfig` 响应里的 `userParams.uuid`**（服务端下发）。
  //   39F 那一发实测：HTTP 200／`status:"success"`／`userParams.uuid` 有值、31 字、base64url 字符集合法。
  // ⚠️ [39G·G1b] **这一格没有默认值**：过去默认 `sdkSessionUuid()` 是个静默回落陷阱——
  //   活链（`loginAndroidCredentials`）已显式传 ① 下发的值，但任何一处漏传都会**静默**拿到一个自造 uuid
  //   （35 批的病灶就是静默回落）。现在不传就抛错，绝不静默生成。
  uuid,
  lang = "zh",
  clientIp,
  ram,
  cpuType,
  sdkVersion,
  timezone,
  // 〔2026-10-14〕① 那一跳服务器现下发的 `gameVersion`（`460.0.23` 这一档），透传给 appInfo。
  gameVersion,
} = {}) {
  if (!handoff?.content || !handoff?.signature || !handoff?.appId) {
    throw loginFailure(null, "渠道登录材料不完整", "REAL_SDK_HANDOFF_INVALID");
  }
  // [39G·G1b] uuid 是**必填**：它是 ① 服务端下发的那一个，构造器不许"没给就自己造一个"。
  if (typeof uuid !== "string" || !uuid.trim()) {
    throw loginFailure(null, "登录请求缺 uuid（这一格只能来自官方下发的入场参数）", "REAL_SDK_UUID_MISSING");
  }
  const hotCloudData = typeof handoff.hotCloudData === "string"
    ? handoff.hotCloudData
    : JSON.stringify(handoff.hotCloudData || {});
  // [34B·1] `isNewDevice`：**有才带**（官方语义同上）——所以先建对象、最后按需挂键，
  //   不许写成常量 `isNewDevice: true`（那是把一次抓包的值当成永久契约）。
  const body = {
    content: handoff.content,
    timestamp: handoff.timestamp,
    signature: handoff.signature,
    // [34B·2] `loginType` ＝**自述常量 "account"**，理由：我们只做「账号＋密码」这一档渠道登录。
    //   出处两条：① 本包 `events-20260923085134.jsonl` seq=0 现读 `loginType="account"`；
    //   ② 官方取值域里 "account" 是账号密码档（`_ref/android_apk/extracted/assets/index.android.bundle` @1586897
    //      `"phone"===t.$currentLoginType||"account"===t.$currentLoginType`）。
    //   ⚠️ 今天只有一档 ⇒ **不许建映射表/枚举对象**（没有第二个取值就没有表的必要）。
    loginType: "account",
    appId: handoff.appId,
    apiVersion: Number(handoff.apiVersion) || 2,
    hotCloudData,
    deeplinkUrl: String(handoff.deeplinkUrl || ""),
    packageId: String(packageId),
    lang: primaryLanguage(lang),
    session1,
    appInfo: JSON.stringify(buildAndroidSdkAppInfo(device, {
      clientIp,
      ram,
      cpuType,
      sdkVersion,
      timezone,
      gameVersion,
    })),
    uuid,
  };
  // [34B·1] 透传那一格：**有才带**（V5 没给就不带这一键）。这一发带没带，日志里能看出（body 的键集合）。
  if (handoff.isNewDevice !== undefined && handoff.isNewDevice !== null) {
    body.isNewDevice = handoff.isNewDevice;
  }
  // 〔2026-10-14〕`openId` 与上面同一格规矩：**有才带**。官方今天这一跳的键集合里有它（32 位），
  //   我们从前不带 ⇒ 签出的 token 少这一项属性 ⇒ `issueAdToken` 回 1856。
  if (handoff.openId !== undefined && handoff.openId !== null && handoff.openId !== "") {
    body.openId = String(handoff.openId);
  }
  return body;
}

export function parseAndroidSdkCredentials(result) {
  const body = result?.body || {};
  const data = body.data || {};
  let landingUrl;
  try { landingUrl = new URL(String(body.url || "")); }
  catch {
    // [38D] 这一支原来**只抛错、不挂 outcome**：官方回了真码（例如 2004 封号）而 url 是空的（或不可解析）时，
    //   loginCode／loginKind／stopAccount 全是 undefined，code 停在 REAL_SDK_LOGIN_FAILED
    //   ⇒ 封号被当成「原因不明」处置，而 run-recovery.js 正是靠 loginPolicy 才不会拿着被封的凭据反复撞。
    //   与下面「渠道登录失败」那一支**同形**（同一次 attachLoginOutcome、同一份 body）；判序一个字没动。
    throw attachLoginOutcome(loginFailure(result, "渠道登录返回的地址无效", "REAL_SDK_LOGIN_FAILED"), result?.body);
  }
  const credentials = {
    sdkToken: landingUrl.searchParams.get("token"),
    openId: landingUrl.searchParams.get("open_id"),
    content: data.content || body.content,
  };
  const status = typeof body.status === "string"
    ? body.status.trim().toLowerCase()
    : body.status;
  const httpOk = result?.statusCode === undefined
    || (Number(result.statusCode) >= 200 && Number(result.statusCode) < 300);
  const statusOk = status === undefined || status === 1 || status === "1" || status === "success";
  if (!httpOk || !statusOk || !credentials.sdkToken || !credentials.openId || !credentials.content) {
    throw attachLoginOutcome(loginFailure(result, "渠道登录失败", "REAL_SDK_LOGIN_FAILED"), result?.body);
  }
  return credentials;
}

export function androidDeviceContext(records = [], {
  deviceId,
  appVersion = DEFAULT_APP_VERSION,
  profile,
} = {}) {
  // 底层构造器**不猜**默认路径：只有显式设了 GARDEN_ANDROID_DEVICE_PROFILE 才自动发现。
  // 否则仓库里只要存在一份真机档案，就会悄悄改变离线测试的结论（本轮实测踩过）。
  const collected = profile === undefined
    ? (process.env.GARDEN_ANDROID_DEVICE_PROFILE ? discoverAndroidDeviceProfile() : null)
    : (profile || null);
  const equipment = collected?.equipment || {};
  const equipmentValue = (...fields) => firstString(...fields.map((field) => equipment[field]));
  const recordValue = (...fields) => firstString(...fields.map((field) => pickValue(records, field)));
  const anyValue = (...fields) => equipmentValue(...fields) || recordValue(...fields);
  // 采集档案优先于会话 artifact：已实证 artifact 里的那个 deviceId 是历史值，
  // 而官方有 /user/device/login/record 设备记录，只有「当前真值」才有意义。
  // artifact 仍然是合法来源（它本身就是从设备上提取的），被禁止的是自造哈希。
  const resolvedDeviceId = firstString(
    deviceId,
    process.env.GARDEN_ANDROID_DEVICE_ID,
    equipmentValue("deviceId"),
    collected?.deviceId,
    recordValue("deviceId"),
  );
  const screenWidthPx = Number(anyValue("screenWidth", "screenWidthPx") || 0);
  const screenHeightPx = Number(anyValue("screenHeight", "screenHeightPx") || 0);
  return {
    deviceId: resolvedDeviceId,
    appVersion: anyValue("appVersion") || appVersion,
    version: DEFAULT_WORLD_VERSION,
    osType: 2,
    isNative: true,
    isSimulator: 0,
    deviceInfo: {
      osType: "android",
      deviceId: resolvedDeviceId,
      isEmulator: false,
      osVersion: anyValue("osVersion", "systemOSVersion"),
      brand: anyValue("equipmentBrand", "brand"),
      model: anyValue("equipmentModel", "model"),
      networkType: anyValue("netWorkType", "networkType"),
      sysLanguage: anyValue("sysLanguage"),
      screenWidthPx: Number.isFinite(screenWidthPx) ? screenWidthPx : 0,
      screenHeightPx: Number.isFinite(screenHeightPx) ? screenHeightPx : 0,
      cpuType: anyValue("cpuType", "cpu"),
      gpu: anyValue("gpu"),
      memoryState: anyValue("memoryState", "ram"),
      manufacturer: anyValue("manufacturer"),
      deviceProduct: anyValue("deviceProduct", "device_product"),
      appInstanceId: anyValue("appInstanceId", "app_instance_id"),
      buildFingerprint: anyValue("buildFingerprint", "build_fingerprint"),
      oaid: anyValue("oaid"),
      carrier: anyValue("carrier", "isp"),
      timezone: anyValue("timezone", "timeZone"),
      deviceType: "Phone",
      appVersion: anyValue("appVersion") || appVersion,
    },
    profileSource: anyValue("source") || String(collected?.source || ""),
    profileCapturedAt: String(collected?.capturedAt || ""),
  };
}

export function readAndroidArtifact(artifactPath) {
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const records = Array.isArray(artifact.records) ? artifact.records : [];
  const sdkToken = pickSdkArtifactValue(
    records,
    "token",
    (value) => value.length >= 40 && /^[a-z0-9_-]+$/i.test(value),
  );
  const openId = pickSdkArtifactValue(
    records,
    "openId",
    (value) => /^\d{18,32}$/.test(value),
  );
  const content = pickSdkArtifactValue(
    records,
    "content",
    (value) => value.length >= 192 && /^[a-z0-9+/=_-]+$/i.test(value),
  );
  if (!sdkToken || !openId || !content) {
    throw loginFailure(null, "Android 会话材料不完整，请重新打开游戏后提取");
  }
  return {
    sdkToken,
    openId,
    content,
    records,
    device: androidDeviceContext(records, { profile: discoverAndroidDeviceProfile() }),
  };
}

/**
 * [38C] 官方在响应里给的**人话原因**：只从这几个键名取（白名单式采集，别处一律不看）。
 * 为什么要有它：run 148 起那 8 发里，官方若回过一句「设备变了，请重新登录」之类的原因，**我们一个字都没留**——
 * 复核方把 `msg` 放进 stub body，落库那一行 detail 里一个字符都没有。有了它，下次失败才分得清
 * 「官方说了什么」与「我们猜的」。值的掩码与截断在唯一清单那一层（`login-error-codes.js` 的 `sdkRemoteNote`）做。
 */
const REMOTE_NOTE_KEYS = Object.freeze(["msg", "message", "tips", "error_msg", "reason", "desc"]);
function pickRemoteNote(body, sanitize = sanitizeRemoteNote) {
  if (!body || typeof body !== "object") return undefined;
  // 902049 这一类 SDK 回包曾把 errCode/msg 放进 data；只看顶层会把官方原因
  // 压成「没有码」。容器名单与登录码解析保持同一边界：只看顶层、data、result，
  // 不递归任意业务对象，也不把凭据值带出。
  const containers = [body, body.data, body.result];
  for (const container of containers) {
    if (!container || typeof container !== "object" || Array.isArray(container)) continue;
    for (const key of REMOTE_NOTE_KEYS) {
      const value = container[key];
      if (typeof value !== "string") continue;
      // 采集这一刻就过同一把净化尺（掩码＋截断）：原始错误对象上**从不出现未掩码的官方原文**。
      const note = sanitize(value);
      if (note !== undefined) return note;
    }
  }
  return undefined;
}

/**
 * [39C·C3] 响应侧读数（原先是 `exchangeAndroidSdkHandoff` 里的闭包，抽出来给**两跳共用**：
 * `/game/queryInitParams` 与 `/game/login` 的响应形态是同一套键：`{url,status,code,data{...}}`）。
 * 只落布尔/长度/枚举/净化后的短句，值不落。
 */
function sdkResponseReadings(res) {
  const b = res?.body || {};
  const url = String(b.url || "");
  let parsed = false;
  try { new URL(url); parsed = url.length > 0; } catch { parsed = false; }
  // [38B] 「data.content 这一格在不在」与「它是不是空串」必须分开：旧写法 `(b.data && b.data.content) || b.content`
  //   把空串塌成了"没有"，于是"没有这一格"与"空串"共用同一个 0 —— 两件事一个数（读不到却显示 0 那一族）。
  const hasDataContent = b.data && typeof b.data === "object" && b.data.content !== undefined && b.data.content !== null;
  const content = hasDataContent ? b.data.content : b.content;
  const statusRaw = b.status;
  const norm = statusRaw === undefined ? "没有这一格"
    : (String(statusRaw).toLowerCase() === "success" || Number(statusRaw) === 1 ? "success" : "非success");
  const readings = {
    sdkStatusEnum: norm,
    sdkUrlParsed: parsed,
    sdkUrlHasToken: url.includes("token="),
    sdkUrlHasOpenId: url.includes("open_id="),
    // 只有真的拿到字符串才给字节数；**没有这一格就是 null（整格不打），绝不是 0**。
    sdkContentBytes: typeof content === "string" ? content.length : null,
    sdkContentState: typeof content === "string" ? (content.length === 0 ? "空串" : "有内容") : "没有这一格",
  };
  // [38C] 官方自己给的那句人话原因（白名单键名；掩码与截断在唯一清单那一层做，见 login-error-codes.js）。
  // 官方一个字都没给 ⇒ **不建这一格**（与"给了个空串"分开）。
  const note = pickRemoteNote(b);
  if (note !== undefined) readings.sdkRemoteNote = note;
  const official = pickRemoteNote(b, officialErrorNoteFields);
  if (official !== undefined) Object.assign(readings, official);
  return readings;
}

/**
 * ⚠️ [39G·G1b] **它现在连"形参默认值"都不是了**（`buildAndroidSdkLoginBody` 的 uuid 已改成必填）。
 * 这一格整场只做一件事：**给离线用例提供一个形状对的合成值**（31 字 base64url）。
 * 登录链（`loginAndroidCredentials` → ① → ② → ③ → V5 → ④）的 uuid 一律取
 * `① pack/queryPackageConfig` 响应里的 `userParams.uuid`（服务端下发，现读三处同值）。
 * **不许**再被任何"要真发出去的"路径当作 uuid 来源——历史上就是"没给就自己造"这个静默回落害了这一族。
 */
/** 〔以下的形状依据保留（39C 现读），**来源那一句已被 39F 取代**，见下一条注释〕
 * [39C·C2] 形状：**31 字 base64url**（＝ `randomBytes(23).toString("base64url")`）——
 *   `tools/ld-tls-hop.mjs --profile "/game/login#uuid"` 现读 `{"长度":31,…, "连字符":0(1), "全hex":false, "base64url字符合法":true}`，
 *   23 字节 ⇒ 31 字、无填充；每会话一个新值（39A 现读 12 套会话 12 个不同指纹）。
 * ⚠️ **作废的推断**：39C 曾写「客户端侧生成、服务器只回显」——**错**，它只查到 ③ 就下结论；
 *   39F 现读证明 **uuid 由 ① `pack/queryPackageConfig` 的响应下发**（`userParams.uuid`，服务端给）。
 *   「纯随机」那句也随之作废：它是**服务端发什么我们就用什么**。
 * ⚠️ 也不是 `:996` 禁的「自造哈希」（那是把别的东西哈希成假身份）——我们根本不生成它了。
 */
export function sdkSessionUuid() {
  return crypto.randomBytes(23).toString("base64url");
}

/** [39C·C3] 前置那一跳读不到 `data.ip` 时留给诊断层的那句话（不编值，只说明"没有"）。 */
export const SDK_IP_MISSING_NOTE = "两处都没给出口 IP（client info 与 queryInitParams），appInfo 的 _ip 这一格按「没有」处理（不编值）";
/** [39E·E2] `client/info` 那一跳没通／没给值、`_ip` 用了回落来源时留的话（好让日志看得出是哪一路给的）。 */
export const SDK_IP_FALLBACK_NOTE_UNREACHABLE = "client info 那一跳没通，_ip 用的是 queryInitParams 的回落值（官方两处同值）";
export const SDK_IP_FALLBACK_NOTE_EMPTY = "client info 那一跳没给出口 IP，_ip 用的是 queryInitParams 的回落值（官方两处同值）";

/**
 * [39E·E2] 官方第二跳：`POST api.babigame.cn/client/info`——**请求体是空的、零前置、零凭据**，
 * 响应 `{status:"success", data:{clientIp}}`，拿服务器看到的出口 IP（官方 appInfo 的 `_ip` 与它同值，现读）。
 * 主机与 SDK 网关那族**不同**（`api.babigame.cn`，不是 `api.boboxia.cn`）⇒ 不走候选表，写死这一台。
 * 失败**不致命**（调用方回落 `queryInitParams`）；但照样把响应读数与域留下来，别让失败无据可查。
 */
export const CLIENT_INFO_HOST = "api.babigame.cn";
// ⚠️ 这一格**刻意不 export**：`ds-modules.js` 的登记守卫按 `export const *_PATH` 扫"同步态语义路径"，
//   而这是条 **HTTP 路由**（不是 `$usrTot.data.bag` 那种同步态路径），登记进那张表属语义污染。
//   本文件对 HTTP 路径的既有写法就是非导出的（见上面的 `ACCOUNT_LOGIN_PATH`），这里照同一条走。
const CLIENT_INFO_PATH = "/client/info";
export async function clientInfoHop({ proxy } = {}, { request = requestJson } = {}) {
  const result = await request(CLIENT_INFO_HOST, CLIENT_INFO_PATH, {}, { proxy, timeoutMs: 15000 });
  const readings = sdkResponseReadings(result);
  const httpOk = result?.statusCode === undefined
    || (Number(result.statusCode) >= 200 && Number(result.statusCode) < 300);
  const statusRaw = result?.body?.status;
  const statusOk = statusRaw === undefined || statusRaw === 1 || statusRaw === "1"
    || String(statusRaw).toLowerCase() === "success";
  if (!httpOk || !statusOk) {
    const error = loginFailure(result, "取出口线路信息失败", "REAL_SDK_CLIENT_INFO_FAILED");
    Object.assign(error, readings);
    error.sdkHostUsed = CLIENT_INFO_HOST;
    throw error;
  }
  const rawIp = result?.body?.data && typeof result.body.data === "object" ? result.body.data.clientIp : undefined;
  const clientIp = typeof rawIp === "string" && rawIp.trim() ? rawIp.trim() : undefined;
  // [39H·H1] HTTP 码也带出来：逐跳读数那一行要能写出「HTTP xxx」，不许只写「没读到」。
  return { host: CLIENT_INFO_HOST, statusCode: result?.statusCode, clientIp, readings };
}

/**
 * [39F·F1] 官方**第一跳**：`POST api.boboxia.cn/pack/queryPackageConfig`——它回答的是「这一场登录的参数包」，
 * 其中 `userParams.uuid` 就是随后 `queryInitParams` 与 `/game/login` 要用的那个 uuid。
 *
 * 依据（同一场抓包现读，`--same-value` 三态）：`①` 响应 `userParams.uuid` ≡ `③ queryInitParams` 请求 uuid
 * ≡ `④ /game/login` 请求 uuid（三处同值），且 ≠ `userParams.deviceId`。
 * 而 39D 那一发（run 156）拿**自己随机造的** uuid 去打 ③，官方回 `params is null` ⇒ 这一跳必须先走。
 *
 * **零凭据**：16 格请求体里没有 content／signature／token（`session0` 是设备侧会话材料，不是账号凭据）。
 * 失败关闭：业务层拒绝 ⇒ 当场停（不换域、不重发）；**读不到 `userParams.uuid` ⇒ 由调用方就地停**（绝不回落到自造 uuid）。
 */
export const PACKAGE_CONFIG_PACKAGE_NAME = "cn.lbwdhysj.ml";
/** [39F·F1c] `egretNativeSupportVersion`：09-23 抓包 ① 现读 "2.0.3"；1.2.5 那版是 "2.0.2" ⇒ **随版本变**，
 *  所以它是"当前这一版的取值"而不是永久常量（换版本时要跟着对一次抓包）。 */
const EGRET_NATIVE_SUPPORT_VERSION = "2.0.3";
/** [39F·F1d] `networkCountryCode`：09-12 与 09-23 两份抓包**同值** "ca" ⇒ 跨 11 天稳定；**语义未明**。
 *  ⚠️ 设备档案里那个 `networkCountryCode = "78"`（两位数字）**不是同一个量**（官方这里是两位字母），
 *  所以不拿它顶；也**不许**编一个来源——这里如实写"取值来自两次抓包同值、语义未明"。 */
const PACKAGE_CONFIG_NETWORK_COUNTRY = "ca";
// ⚠️ 这一格**刻意不 export**（同 `CLIENT_INFO_PATH`／`ACCOUNT_LOGIN_PATH`）：它是 HTTP 路由，
// 进 `ds-modules` 那张"同步态语义路径"登记表属语义污染。
const PACKAGE_CONFIG_PATH = "/pack/queryPackageConfig";

/**
 * [39F·F1b] 官方 `version` 的编码：`major×10⁶ ＋ minor×10³ ＋ patch`。
 * **两个独立样本现读**：`1.2.5 → 1002005`、`1.3.2 → 1003002`（都由这条式子算得出来）⇒ 不写死字面量。
 * 读不出三段数字（或段位越界）⇒ undefined（调用方按"没这一格"处理，由守卫钉住）。
 */
export function packageConfigVersion(appVersion = DEFAULT_APP_VERSION) {
  const parts = String(appVersion).split(".").map((one) => Number(one));
  if (parts.length < 3 || parts.some((one) => !Number.isInteger(one) || one < 0)) return undefined;
  if (parts[1] > 999 || parts[2] > 999) return undefined;   // 段位越界会串味，宁可不给
  return parts[0] * 1e6 + parts[1] * 1e3 + parts[2];
}

/**
 * 〔2026-10-14 抓包定案〕`session0` 是**客户端每场自造**的 32 位 `[A-Z0-9]` 随机串。
 * 一手依据（同一台模拟器、10-14 两场抓包现读）：跨 09-07／09-12／09-23／10-14 共 18 枚、**两两不同**、
 * 形状一致（32 位全大写＋数字），且**从未出现在任何一个响应里** ⇒ 它不是服务器下发的凭据；
 * 最早一次出现在 ① `pack/queryPackageConfig` 的**请求**里（比 login 还早）⇒ 客户端在发第一跳之前就造好了。
 * 我们从前在这格发空串 ⇒ 这一场会话在服务器侧没有会话号 ⇒ `issueAdToken` 回 1856
 * （其余 SDK 接口宽松、同样这枚 token 照样 success）。
 * ⇒ 读得到设备上的就用，读不到就按官方形状造一枚、并**在整场会话内沿用同一枚**。
 *   这是复刻官方行为，不是伪造凭据：它不参与任何签名，也不是账号侧凭据。
 */
export function freshSdkSession0(random = Math.random) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < 32; i += 1) out += alphabet[Math.floor(random() * alphabet.length)];
  return out;
}

export async function queryPackageConfigHop({
  device,
  session0,
  lang = "zh",
  appVersion = DEFAULT_APP_VERSION,
  timezone = -new Date().getTimezoneOffset() / 60,
  proxy,
} = {}, { request = requestJson } = {}) {
  const info = device?.deviceInfo || {};
  // ⚠️ 16 格**一棵不落**（官方在这台设备上发空串的字段我们就发空串，见本文件 :659-663 的既有硬规则）
  //   ⇒ 不用 compactObject 剔空值，形状本身就是证据。
  const body = {
    // [39F·F1a] ① 这一跳官方自报的包名是 `.ml`，与 V5 那一跳的 `.gw` **刻意不同源**：
    //   V5 用 `.gw` 现在通着（9 发都拿到了 handoff），且盘上没有官方 1.3.2 的 V5 参照 ⇒ `DEFAULT_ACCOUNT_PACKAGE_NAME` 一字不改。
    //   两个出处：`.ml` ＝ 09-23 抓包 ① 现读；`.gw` ＝ AGENTS.md 铁律 3（V5 渠道包名）。
    packageName: PACKAGE_CONFIG_PACKAGE_NAME,
    language: primaryLanguage(lang),
    platform: "android",
    userParams: true,
    sysLanguage: DEFAULT_SYS_LANGUAGE,
    userLanguage: "",
    simCountryCode: "",
    networkCountryCode: PACKAGE_CONFIG_NETWORK_COUNTRY,
    version: packageConfigVersion(appVersion),
    deviceId: device?.deviceId,
    lastTimeGameId: "",
    // `session0` 来自设备侧会话 artifact（合法的"从设备上提取"来源）；读不到就空串——**不许自造**。
    session0: session0 || "",
    timeZone: String(timezone),
    egretNativeSupportVersion: EGRET_NATIVE_SUPPORT_VERSION,
    equipmentInfo: {
      equipmentModel: String(info.model || "").toLowerCase(),
      equipmentBrand: String(info.brand || "").toLowerCase(),
      os: "android",
      osVersion: String(info.osVersion || ""),
      cpuType: String(info.cpuType || ""),
      ram: String(info.memoryState || info.ram || ""),
      screenHeight: String(info.screenHeightPx || ""),
      screenWidth: String(info.screenWidthPx || ""),
      netWorkType: String(info.networkType || ""),
    },
    humeChannel: "",
  };
  let lastTransportError = null;
  for (const host of SDK_HOST_CANDIDATES) {
    throwIfAndroidLoginAborted();
    let result;
    try {
      result = await request(host, PACKAGE_CONFIG_PATH, body, { proxy, timeoutMs: 15000 });
    } catch (error) {
      // 只有传输层失败才换下一个域（与另外两跳同一把尺）。
      throwIfAndroidLoginAborted();
      if (error?.code === 'REAL_ABORTED' || !isAndroidHttpTransportError(error)) throw error;
      lastTransportError = error;
      continue;
    }
    const readings = sdkResponseReadings(result);
    const httpOk = result?.statusCode === undefined
      || (Number(result.statusCode) >= 200 && Number(result.statusCode) < 300);
    const statusRaw = result?.body?.status;
    const statusOk = statusRaw === undefined || statusRaw === 1 || statusRaw === "1"
      || String(statusRaw).toLowerCase() === "success";
    if (!httpOk || !statusOk) {
      // 官方给了业务层结论 ⇒ 当场停下并上报（不赌第二个域、不重发）。
      const error = loginFailure(result, "取入场参数失败", "REAL_PACKAGE_CONFIG_FAILED");
      Object.assign(error, readings);
      error.sdkHostUsed = host;
      throw error;
    }
    const userParams = result?.body?.userParams;
    const rawUuid = userParams && typeof userParams === "object" ? userParams.uuid : undefined;
    const uuid = typeof rawUuid === "string" && rawUuid.trim() ? rawUuid.trim() : undefined;
    const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
    return {
      host,
      // [39F·F3] HTTP 状态也要带出来（那一发只打这一跳，读数里必须有它）
      statusCode: result?.statusCode,
      uuid,
      // [39F·F3] 只有这三格是"不是凭据、可落盘"的口径（用来校准我们那三个版本常量）。
      plain: userParams && typeof userParams === "object" ? {
        packageId: text(userParams.packageId),
        appVersion: text(userParams.appVersion),
        gameVersion: text(userParams.gameVersion),
      } : {},
      // 键名集合（只键名，值一个不落）——诊断用，与 38C 的「body键名」同一姿势。
      userParamsKeys: userParams && typeof userParams === "object" ? Object.keys(userParams).slice(0, 40) : [],
      readings,
    };
  }
  throw lastTransportError || new Error("入场参数主机全部不可达");
}

/**
 * [39C·C3] 官方新登录的**第一跳**：`POST /game/queryInitParams`（探场）。
 *
 * 依据（现读）：官方 appInfo 的 `_ip` 与这一跳响应里的 `data.ip` **同值**（`--same-value` 现读三套会话全同值），
 * 而我们从来没打这一跳 ⇒ appInfo 少一格（19 键 vs 18 键、454 字 vs 434 字，差 20 字全在这一格）。
 * **零账号消耗**：请求体只有 `{uuid, lang}`，不带 content／signature／任何凭据。
 * 失败关闭：业务层拒绝 ⇒ 当场停（不换域、不重发）；**读不到 `data.ip` ⇒ 不编值**（由调用方把这格留空 + 记一句中文原因）。
 */
export async function queryInitParamsHop({
  uuid,
  lang = "zh",
  chnId = DEFAULT_CHN_ID,
  gameId = DEFAULT_GAME_ID,
  env = "prod",
  proxy,
} = {}, { request = requestJson } = {}) {
  // 路径形状照 09-23 抓包 seq=0 现读：/game/queryInitParams/mdcl/c459/mdgid/160/env/prod
  const requestPath = `/game/queryInitParams/mdcl/c${Number(chnId)}/mdgid/${Number(gameId)}/env/${encodeURIComponent(env)}`;
  // ⚠️ **恰为这两键**（守卫钉死）：多带任何一格都可能把凭据捎进这一跳。
  const body = { uuid, lang: primaryLanguage(lang) };
  let lastTransportError = null;
  for (const host of SDK_HOST_CANDIDATES) {
    throwIfAndroidLoginAborted();
    let result;
    try {
      result = await request(host, requestPath, body, { proxy, timeoutMs: 15000 });
    } catch (error) {
      // 只有传输层失败才换下一个域（与登录那一跳同一把尺）。
      throwIfAndroidLoginAborted();
      if (error?.code === 'REAL_ABORTED' || !isAndroidHttpTransportError(error)) throw error;
      lastTransportError = error;
      continue;
    }
    const readings = sdkResponseReadings(result);
    const httpOk = result?.statusCode === undefined
      || (Number(result.statusCode) >= 200 && Number(result.statusCode) < 300);
    const statusRaw = result?.body?.status;
    const statusOk = statusRaw === undefined || statusRaw === 1 || statusRaw === "1"
      || String(statusRaw).toLowerCase() === "success";
    if (!httpOk || !statusOk) {
      // 官方给了业务层结论 ⇒ 当场停下并上报（不赌第二个域、不重发）。
      const error = loginFailure(result, "渠道前置查询失败", "REAL_SDK_QUERY_INIT_FAILED");
      Object.assign(error, readings);
      error.sdkHostUsed = host;
      throw error;
    }
    const rawIp = result?.body?.data && typeof result.body.data === "object" ? result.body.data.ip : undefined;
    const ip = typeof rawIp === "string" && rawIp.trim() ? rawIp.trim() : undefined;
    return { host, statusCode: result?.statusCode, ip, readings };
  }
  throw lastTransportError || new Error("SDK 前置查询主机全部不可达");
}

export async function exchangeAndroidSdkHandoff({
  handoff,
  device,
  proxy,
  chnId = DEFAULT_CHN_ID,
  gameId = DEFAULT_GAME_ID,
  env = "prod",
  packageId = DEFAULT_PACKAGE_ID,
  session1,
  uuid,
  lang = "zh",
  clientIp,
  ram,
  cpuType,
  sdkVersion,
  timezone,
  gameVersion,
} = {}, { request = requestJson } = {}) {
  const requestPath = `/game/login/mdcl/c${Number(chnId)}/mdgid/${Number(gameId)}/env/${encodeURIComponent(env)}`;
  const body = buildAndroidSdkLoginBody({
    handoff,
    device,
    packageId,
    session1,
    uuid,
    lang,
    clientIp,
    ram,
    cpuType,
    sdkVersion,
    timezone,
    gameVersion,
  });
  // [36A·1] **发出前**就算好键名差集（发出后再算也行，但失败时可能没机会算）。
  const requestShape = describeSdkLoginRequestShape(body);
  // [36A·2] 响应侧四件的读数（只落布尔/长度/枚举，值不落）——[39C·C3] 已抽成模块级函数给两跳共用。
  const responseReadings = sdkResponseReadings;
  // 候选主机依次试：**只有传输层失败（压根没连上）才换下一个**；
  // 官方给了业务层结论（例如那个 302）就当场停下——拿一次性会话去赌第二个域，是这一族最伤的姿势。
  let lastTransportError = null;
  for (const host of SDK_HOST_CANDIDATES) {
    throwIfAndroidLoginAborted();
    let result;
    try {
      result = await request(host, requestPath, body, { proxy, timeoutMs: 15000 });
    } catch (error) {
      throwIfAndroidLoginAborted();
      if (error?.code === 'REAL_ABORTED' || !isAndroidHttpTransportError(error)) throw error;
      lastTransportError = error;
      continue;
    }
    try {
      const parsed = parseAndroidSdkCredentials(result);
      parsed.sdkHostUsed = host;   // 这一次打的是哪个域（诊断要能查）
      // [39H·H1] 成功路也要带 HTTP 码：逐跳读数那一行要能写出「HTTP xxx」（原先只有失败路才带）。
      parsed.statusCode = result?.statusCode;
      // [36A·3] 成功路也要有三格（不只挂在 catch 里）
      parsed.sdkRequestShape = requestShape;
      Object.assign(parsed, responseReadings(result));
      return parsed;
    } catch (error) {
      // 失败也要能查「打的是哪个域」：否则分不清「boboxia 回了 302」与「boboxia 不通、回退到 babigame 才有 302」。
      if (error && typeof error === "object") {
        // [36A·3] 失败路同样挂三格（键名差集＋响应四件），这样「缺哪一件」就不必再猜。
        if (error.sdkHostUsed === undefined) error.sdkHostUsed = host;
        if (error.sdkRequestShape === undefined) error.sdkRequestShape = requestShape;
        if (error.sdkStatusEnum === undefined) Object.assign(error, responseReadings(result));
        // [38C] **响应体的键名集合整份留下**（只有键名、没有值）：`detail.官方` 那格「body键名」读的就是
        //   `responseKeys`／`dataKeys`，而 SDK 登录这一路**从来没设过这两个字段**（V5 账号那一路在 :847-848 设了）
        //   ⇒ 历史 8 发里「body键名」一格都没落上，官方回了哪些键只能靠猜。这里补上（白名单式：纯 ASCII 键名）。
        if (error.responseKeys === undefined) error.responseKeys = Object.keys(result?.body || {}).slice(0, 24);
        if (error.dataKeys === undefined) {
          const dataBody = result?.body && typeof result.body.data === "object" && result.body.data ? result.body.data : {};
          error.dataKeys = Object.keys(dataBody).slice(0, 32);
        }
      }
      throw error;
    }
  }
  throw lastTransportError || new Error("SDK 登录主机全部不可达");
}

async function exchangeGateway({
  sdkToken,
  openId,
  content,
  chnId = DEFAULT_CHN_ID,
  proxy,
  sgid,
} = {}, { gatewayCall = null } = {}) {
  if (typeof gatewayCall !== 'function') gatewayCall = (await import('./client.js')).gwCall;
  const response = await gatewayCall("index.login", {
    sdkId: 10000,
    chnId,
    params: {
      token: sdkToken,
      open_id: openId,
      content,
      zoneCode: "ys",
      launchOptions: { scene: 1400, query: {} },
    },
  }, null, { proxy, timeoutMs: 15000 });
  const account = response?.v?.acc || {};
  const other = response?.v?.$other || response?.v?.other || {};
  const aid = Number(account.id);
  const sessionToken = other.token;
  const resolvedSgid = Number(sgid || account.lastGsIdx || 2303);
  if (response?.m || response?.err || !Number.isInteger(aid) || !sessionToken) {
    throw loginFailure(response, "Android 网关登录失败");
  }
  const endpointResponse = await gatewayCall("index.getGsInfoList", {
    aid,
    idx: resolvedSgid,
    chnId,
  }, null, { proxy, timeoutMs: 15000 });
  // 网关每次下发的是一组候选（host 与 port_ssl 成对变化），不是常量。
  // 这里只返回完整候选集，具体连哪一条交给启动器竞速 + 失败转移决定，
  // 绝不在登录层写死或只取第一条。
  const endpoints = parseWorldEndpoints(endpointResponse, { sgid: resolvedSgid });
  const endpoint = endpoints.length ? toWorldEndpoint(endpoints[0]) : null;
  if (!endpoint) throw loginFailure(endpointResponse, "网关没有返回可用世界服");
  return {
    aid,
    sgid: resolvedSgid,
    chnId,
    sessionToken,
    endpoint,
    endpoints,
    account: {
      name: account.name,
      zoneCode: account.zoneCode,
      lastGsIdx: account.lastGsIdx,
    },
    sessionSummary: { length: String(sessionToken).length, sha256: digest(sessionToken) },
  };
}

export async function loginAndroidArtifact(
  { artifactPath, proxy, chnId = DEFAULT_CHN_ID, sgid } = {},
  dependencies = {},
) {
  const artifact = readAndroidArtifact(artifactPath);
  const gateway = await exchangeGateway({
    sdkToken: artifact.sdkToken,
    openId: artifact.openId,
    content: artifact.content,
    proxy,
    chnId,
    sgid,
  }, dependencies);
  return {
    ...gateway,
    device: artifact.device,
    sdk: { token: artifact.sdkToken, openId: artifact.openId },
    source: "artifact",
  };
}

function readDeviceRecords(artifactPath) {
  if (!artifactPath || !fs.existsSync(artifactPath)) return [];
  try {
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    return Array.isArray(artifact.records) ? artifact.records : [];
  } catch {
    return [];
  }
}

export function readAndroidDeviceContext(artifactPath, options = {}) {
  return androidDeviceContext(readDeviceRecords(artifactPath), {
    ...options,
    profile: options.profile === undefined ? discoverAndroidDeviceProfile() : options.profile,
  });
}

/**
 * 真实登录预检：只检查「官方确实会发值、而我们又真能采到」的那批字段。
 *
 * 明确**不**检查 build_fingerprint / oaid / carrier / idfv / darwin_version /
 * device_product / simCountryCode —— 实测官方在这台设备上就给它们发空串并且登录成功。
 * 把空字段做成闸门会比官方更严格，等于自己造一个可区分特征，方向是反的。
 *
 * 缺口名一律使用官方字段名，方便和采集档案逐字段对账。
 */
export function androidDeviceFingerprintGaps(device, fingerprint = {}) {
  const info = device?.deviceInfo || {};
  const official = buildV5DeviceFields({
    appEntry: info,
    equipment: {
      ...info,
      screenWidth: positiveText(firstString(info.screenWidthPx, info.screenWidth)),
      screenHeight: positiveText(firstString(info.screenHeightPx, info.screenHeight)),
      ram: firstString(info.ram, info.memoryState),
    },
    appInfo: {
      memoryState: firstString(info.memoryState, info.ram),
      deviceId: firstString(device?.deviceId, info.deviceId),
    },
  });
  const gaps = [];
  const require = (field, ...values) => {
    if (!firstString(...values)) gaps.push(field);
  };
  require("deviceId", fingerprint.deviceId, device?.deviceId, info.deviceId);
  require("brand", fingerprint.brand, info.equipmentBrand, info.brand, official.brand);
  require("model", fingerprint.model, info.equipmentModel, info.model, official.model);
  require("cpu", fingerprint.cpu, info.cpuType, info.cpu, official.cpu);
  require("ram_gb", fingerprint.ramGb, official.ram_gb);
  require("resolution", fingerprint.resolution, official.resolution);
  require("network_type", fingerprint.networkType, info.netWorkType, info.networkType, official.network_type);
  require("os_version", fingerprint.osVersion, info.osVersion, info.systemOSVersion);
  return gaps;
}

export function loginAndroidCredentials(options = {}, dependencies = {}) {
  return withAndroidLoginSignal(options.signal, () => loginAndroidCredentialsInContext(options, dependencies));
}
async function loginAndroidCredentialsInContext({
  username,
  password,
  passwordEncoded = false,
  deviceId,
  artifactPath,
  proxy,
  chnId = DEFAULT_CHN_ID,
  accountClid = DEFAULT_ACCOUNT_CLID,
  accountAppId = DEFAULT_ACCOUNT_APP_ID,
  accountPackageName = DEFAULT_ACCOUNT_PACKAGE_NAME,
  sgid,
  appVersion = DEFAULT_APP_VERSION,
  packageId = DEFAULT_PACKAGE_ID,
  gameId = DEFAULT_GAME_ID,
  env = "prod",
  lang = "zh",
  accountFingerprint = {},
} = {}, dependencies = {}) {
  throwIfAndroidLoginAborted();
  if (!username || !password) throw loginFailure(null, "缺少 Android 游戏账号或密码");
  const sender = dependencies.request || requestJson;
  const request = async (host, requestPath, body, options = {}) => {
    const signal = androidLoginSignal();
    throwIfAndroidLoginAborted(signal);
    const response = await sender(host, requestPath, body, { ...options, signal });
    throwIfAndroidLoginAborted(signal);
    return response;
  };
  const device = readAndroidDeviceContext(artifactPath, {
    deviceId,
    appVersion,
    username,
  });
  const loginBody = buildAndroidAccountLoginBody({
    username,
    password,
    passwordEncoded,
    deviceId: device.deviceId,
    device,
    fingerprint: accountFingerprint,
    appVersion,
    accountClid,
    accountAppId,
    packageName: accountPackageName,
    lang,
  });
  assertV5LoginBodyKeys(loginBody);
  // ── [39E·E1/E2／39F·F1/F2] 前置跳**全部在 V5 之前**（官方顺序：① pack/queryPackageConfig → ② client/info → ③ queryInitParams →（账号登录）→ /game/login）──
  //   为什么必须挪：run 156（09-23 23:45:40）就是先把 V5 的**一次性三元组**换回来、再在前置跳上失败 ⇒ **白烧一次**。
  //   前置跳失败就地停，绝不进 V5。
  // [39F·F2] **uuid 的唯一来源＝① 的响应 `userParams.uuid`**（现读：① ≡ ③ ≡ ④ 三处同值）。
  //   读不到 ⇒ 就地停 + 一句中文原因；**绝不回落到 `sdkSessionUuid()`**（读不到就不做，铁律 7）。
  const records = readDeviceRecords(artifactPath);
  const artifactSession0 = records
    .map((one) => (one && one.field === "session0" && typeof one.value === "string" ? one.value : ""))
    .find((one) => one.trim().length > 0);
  // 〔2026-10-14〕设备上读不到也要有一枚可复用的会话号（理由见 `freshSdkSession0` 那段一手依据）。
  //   整场登录只造**一枚**：① 前置跳、BI 上报、`/game/login` 用的都必须是同一个值 ⇒ 绝不每跳各造一枚。
  const session0 = (artifactSession0 && artifactSession0.trim()) || freshSdkSession0();
  const packageConfig = await queryPackageConfigHop({
    device,
    session0,
    lang,
    appVersion,
    proxy,
  }, { request });
  if (!packageConfig.uuid) {
    throw loginFailure(null, "入场参数里没有 uuid（官方没下发），这次不登录", "REAL_PACKAGE_CONFIG_UUID_MISSING");
  }
  const sessionUuid = packageConfig.uuid;
  // [39H·H1] **逐跳成功读数**：只落 HTTP／status 枚举／关键格的「有没有＋长度」——凭据原文（uuid／token／open_id／
  //   content／session0／session1／clientIp）**一个字都不许进这里**（铁律 2）。
  //   为什么要有它：39G 那一发走到世界了，可"哪一跳通成什么样"全靠"链路继续往下走"倒推；
  //   一旦断在某一跳，日志得能一眼点名，而不是猜。
  const hopReadings = [];
  const cellOf = (label, value) => label + (value === undefined || value === null || value === ""
    ? " 没有"
    : (typeof value === "string" ? " 有(" + value.length + " 字)" : " 有"));
  const pushHop = (跳, 域, http, status, 关键格) => hopReadings.push({ 跳, 域, http, status, 关键格 });
  pushHop("① 入场参数", packageConfig.host, packageConfig.statusCode, packageConfig.readings?.sdkStatusEnum,
    [cellOf("uuid", packageConfig.uuid), cellOf("packageId", packageConfig.plain?.packageId), cellOf("gameVersion", packageConfig.plain?.gameVersion)]);
  let clientIp;
  let ipRouteState = "有值";
  let clientInfo = null;
  try {
    // ② 主来源：零前置、零凭据；**失败不致命**（它只负责一个便利值，下面还有回落来源）——这是「保留为回落」的前提。
    clientInfo = await clientInfoHop({ proxy }, { request });
    clientIp = clientInfo.clientIp;
    if (!clientIp) ipRouteState = "没给";
  } catch (error) {
    throwIfAndroidLoginAborted();
    if (error?.code === 'REAL_ABORTED') throw error;
    if (error?.loginKind === 'blocked' || error?.loginKind === 'risk_ip') throw error;
    ipRouteState = "没通";
  }
  pushHop("② 出口 IP", CLIENT_INFO_HOST, clientInfo?.statusCode, clientInfo?.readings?.sdkStatusEnum,
    [ipRouteState === "有值" ? cellOf("clientIp", clientIp) : "这一跳" + ipRouteState]);
  // ③ 回落来源，同时也是官方顺序里的第三跳：这一跳失败**就地停**（E1：一次性三元组不许白发）。
  const preflight = await queryInitParamsHop({ uuid: sessionUuid, lang, chnId, gameId, env, proxy }, { request });
  pushHop("③ 入场信息", preflight.host, preflight.statusCode, preflight.readings?.sdkStatusEnum,
    [cellOf("ip", preflight.ip), "与①同一个 uuid"]);  let ipNote;
  if (!clientIp && preflight.ip) {
    clientIp = preflight.ip;
    ipNote = ipRouteState === "没通" ? SDK_IP_FALLBACK_NOTE_UNREACHABLE : SDK_IP_FALLBACK_NOTE_EMPTY;
  }
  if (!clientIp) ipNote = SDK_IP_MISSING_NOTE;   // 两路都没值 ⇒ 整格不打 + 一句中文原因（绝不编值）
  const now = typeof dependencies.now === "function" ? dependencies.now : Date.now;
  const nonceFactory = typeof dependencies.nonce === "function" ? dependencies.nonce : undefined;
  let result;
  let serverTimeOffset = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    throwIfAndroidLoginAborted();
    const { secureRequest } = buildAndroidAccountRequestAttempt(loginBody, {
      now,
      serverTimeOffset,
      attempt,
      nonce: nonceFactory,
    });
    const response = await request(
      ACCOUNT_HOST,
      ACCOUNT_LOGIN_PATH,
      secureRequest.body,
      {
        proxy,
        headers: buildAndroidAccountLoginHeaders({
          deviceId: device.deviceId,
          appVersion,
          accountAppId,
          packageName: accountPackageName,
          lang,
          nonce: secureRequest.headers.nonce,
          ivVersion: secureRequest.headers.requestSecurityIvVersion,
        }),
      },
    );
    try {
      result = {
        ...response,
        body: decryptAndroidAccountResponse(response?.body, secureRequest.context),
      };
    } catch {
      throw loginFailure(
        response,
        "官方账号登录响应解密失败",
        "REAL_ACCOUNT_RESPONSE_DECRYPT_FAILED",
      );
    }
    const serverTime = Number(result?.body?.data);
    if (attempt === 0
      && Number(result?.body?.status) === ACCOUNT_TIMESTAMP_EXPIRED_STATUS
      && Number.isFinite(serverTime)
      && serverTime >= 1e12) {
      // The native client calculates its offset after the server response,
      // then samples the clock again for the retry's nonce and envelope.
      serverTimeOffset = serverTime - readAndroidAccountClock(now);
      continue;
    }
    break;
  }
  const handoff = parseAndroidAccountHandoff(result);
  // [39C·C3＋39E·E1] 前置跳已在 V5 之前跑完（见上面那段）：这里只把已经拿到的 uuid 与出口 IP 交给 SDK 登录那一跳。
  let credentials;
  try {
    credentials = await exchangeAndroidSdkHandoff({
      handoff,
      device,
      proxy,
      chnId,
      gameId,
      env,
      packageId,
      lang,
      // 与前置那一跳**同一个** uuid（官方两处同值，`--same-value` 现读三套会话全同值）。
      uuid: sessionUuid,
      // 官方 appInfo._ip 就是前置跳取回来的出口 IP；读不到就是 undefined ⇒ `compactObject` 整格不打（**不编值**）。
      clientIp,
      // 〔2026-10-14〕appInfo._game_version 用 **① 现下发的那一个**（今天 `460.0.23`），不再发过期常量。
      gameVersion: packageConfig?.plain?.gameVersion,
    }, { request });
  } catch (error) {
    // 前置跳"通了但没给出出口 IP"⇒ 把原因挂进诊断链（落库那行能看到"这一格为什么空着"）。
    if (ipNote && error && typeof error === "object" && error.sdkIpNote === undefined) {
      error.sdkIpNote = ipNote;
    }
    throw error;
  }
  if (ipNote) credentials.sdkIpNote = ipNote;
  // [39H·H1] ④ 那一跳的成功读数（`parseAndroidSdkCredentials` 成功路上已挂好这几格：全是布尔/长度/枚举）。
  pushHop("④ 渠道登录", credentials.sdkHostUsed, credentials.statusCode, credentials.sdkStatusEnum, [
    "url " + (credentials.sdkUrlParsed === true ? "可解析" : "不可解析"),
    "token " + (credentials.sdkUrlHasToken === true ? "有" : "没有"),
    "open_id " + (credentials.sdkUrlHasOpenId === true ? "有" : "没有"),
    "content " + (typeof credentials.sdkContentBytes === "number" ? "有(" + credentials.sdkContentBytes + " 字)" : (credentials.sdkContentState || "没有")),
  ]);
  const gateway = await exchangeGateway({
    sdkToken: credentials.sdkToken,
    openId: credentials.openId,
    content: credentials.content,
    proxy,
    chnId,
    sgid,
  }, dependencies);
  return {
    ...gateway,
    device,
    sdk: { token: credentials.sdkToken, openId: credentials.openId },
    // 〔2026-10-14〕账号层那枚 token 以前**只用来做缺项检查、随后整个丢掉**。现在带着它：
    //   官方在领广告票前一秒打的 `moac /user/report/role` 就是拿这枚号做请求头（抓包现读 len=46），
    //   我们拿不到它 ⇒ 那一跳打不了 ⇒ 广告票一直被拒（现读 1856）。
    //   与 `sdk.token` 同一待遇：只在内存里流转，绝不进日志、绝不落库、绝不外发。
    account: { token: handoff.accountToken, appId: handoff.appId },
    source: "credentials",
    // [39H·H1] 逐跳成功读数（调用方负责落日志）；形状＝`[{跳, 域, http, status, 关键格:[…]}]`，
    //   里面**只有** HTTP 码、status 枚举与"有没有＋长度"，没有任何凭据原文。
    hopReadings,
  };
}
