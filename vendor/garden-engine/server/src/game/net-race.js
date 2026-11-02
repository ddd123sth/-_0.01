// 官方客户端「链路选择」算法的可测试移植。
//
// 为什么需要它：世界服地址不是常量。`index.getGsInfoList` 每次登录都会下发**一组**
// 候选网关（host 与 port_ssl 成对变化），官方客户端把它们排序后**并发拨号、最快者胜、
// 其余关闭**；此外还有 direct 前缀与 dyHost 代理两套备用形态。因此「端口每次都变」
// 不是异常，而是官方设计：写死 53031 或只取第一条，都会在换服/扩容时直接连不上。
//
// 证据来源（三级）：
//   1. 官方源码 `_ref/game_src/scripts/src/assets/scripts/game.js`
//      mo.NET.Helper: _getGsTotalInfo / _connectGsList / _connectGs / _pickBest / _getGsUrl
//      mo.PROJ 默认值: gsTestDuration=150 gsMinTestTimeout=1e4 gsSingleTestTimeout=1e4
//                      wsCountLimit=5 gwJudgeMs=2e3 gwTestTimeout=1e4 wsTolerableDelay=1e3
//      mo.NUM.calWeight（权重随机）
//   2. 2026-09-07 雷电透明抓包：`index.getGsInfoList` 实发响应
//      {"v":{"6":{"2":[{"0":"hy2gnhf114.babigame.cn","1":43031,"2":53031,"4":1,"5":32},
//                      {"0":"hy2gnhf119.babigame.cn","1":43033,"2":53033,"4":1,"5":31}]}}}
//      数字键映射：0=host 1=port 2=port_ssl 4=status 5=count（3/6 未下发）
//   3. 同次抓包实证官方客户端实际落到 hy2gnhf114:53031（`GET /?sgid=2303`，Host 头同端口）

export const WORLD_ENDPOINT_FIELD_MAP = Object.freeze({
  0: "host",
  1: "port",
  2: "port_ssl",
  4: "status",
  5: "count",
});

export const NET_RACE_DEFAULTS = Object.freeze({
  tickMs: 25,
  gsTestDurationMs: 150,
  gsMinTestTimeoutMs: 10000,
  gsSingleTestTimeoutMs: 10000,
  gsTotalTimeoutMs: 60000,
  wsCountLimit: 5,
  gwJudgeMs: 2000,
  gwTestTimeoutMs: 10000,
  gwProbeTickMs: 100,
  wsTolerableDelayMs: 1000,
  probeTimeoutMs: 5000,
});

function integerOrNull(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** 归一化单条端点：同时接受数字字段号（实发形态）与命名字段（历史/手工形态）。 */
export function normalizeWorldEndpoint(entry, { sgid, includeDisabled = false } = {}) {
  if (!entry || typeof entry !== "object") return null;
  const field = (numberKey, name) => entry[numberKey] ?? entry[name];
  const host = String(field(0, "host") ?? "").trim();
  const portSsl = integerOrNull(field(2, "port_ssl") ?? field("port_ssl", "portSsl"));
  const port = integerOrNull(field(1, "port") ?? entry.plainPort);
  const statusValue = field(4, "status");
  const status = statusValue === undefined ? 1 : Number(statusValue);
  const countValue = field(5, "count") ?? weightOf(entry);
  const count = Number.isFinite(Number(countValue)) ? Number(countValue) : 0;
  const idx = integerOrNull(entry.idx ?? entry.gsIdx ?? entry.sgid ?? (sgid ? Number(sgid) : null));
  if (!host || Number.isFinite(status) === false) return null;
  // status<=0 是「官方标记为不可用」：默认丢弃，只有兼容旧接口列全量时才保留。
  if (status <= 0 && !includeDisabled) return null;
  if (!portSsl && !port) return null;
  return {
    host,
    port: port ?? portSsl,
    portSsl: portSsl ?? port,
    status,
    count,
    idx: idx ?? (sgid === undefined ? null : Number(sgid)),
    dyHost: typeof entry.dyHost === "string" ? entry.dyHost : undefined,
    hostSrc: host,
  };
}

function weightOf(entry) {
  if (!entry || typeof entry !== "object") return 0;
  const value = entry.weight ?? entry["5"];
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

/**
 * 从网关响应里取出世界服候选。响应结构：`v.6.2`（实发）/ `v.6.gsInfoList` /
 * `v.servers` / `servers`（历史兼容），也接受已归一化的端点数组（失败转移重试用）。
 * 返回空数组表示「网关没给可用端点」，调用方必须 fail-closed，
 * 绝不回退到写死的 host:port——那正是换服当天连不上的原因。
 */
export function parseWorldEndpoints(source, { sgid, includeDisabled = false } = {}) {
  // 允许直接传「已归一化的端点数组」：启动器在登录阶段已经解析过一次，
  // 失败转移时要拿同一份候选重新竞速，而不是假装还能从响应里读。
  const buckets = Array.isArray(source)
    ? [source]
    : [
      source?.v?.["6"]?.["2"],
      source?.v?.["6"]?.gsInfoList,
      source?.v?.["6"]?.["0"]?.gsInfoList,
      source?.v?.gsInfoList,
      source?.v?.servers,
      source?.servers,
    ];
  const raw = buckets.find((bucket) => Array.isArray(bucket) && bucket.length) || [];
  const seen = new Set();
  const endpoints = [];
  for (const entry of raw) {
    const normalized = normalizeWorldEndpoint(entry, { sgid, includeDisabled });
    if (!normalized) continue;
    const key = `${normalized.host}:${normalized.port}:${normalized.portSsl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    endpoints.push(normalized);
  }
  return endpoints;
}

/** 官方 `mo.NUM.calWeight`：按累计权重做随机，返回下标（全 0 权重返回 -1）。 */
export function calWeight(weights, excludedIndexes, random = Math.random) {
  if (!Array.isArray(weights) || weights.length === 0) return -1;
  let total = 0;
  const cumulative = [];
  for (let index = 0; index < weights.length; index += 1) {
    let value = Number(weights[index]) || 0;
    if (Array.isArray(excludedIndexes) && excludedIndexes.includes(index)) value = 0;
    if (value <= 0) {
      cumulative.push(-1);
    } else {
      total += value;
      cumulative.push(total);
    }
  }
  if (!total) return -1;
  const pick = random();
  for (let index = 0; index < cumulative.length; index += 1) {
    const value = cumulative[index];
    if (value > 0 && value / total >= pick) return index;
  }
  return -1;
}

/** 官方 `_randomDefaultGsInfo`：有 weight 走权重随机，没有就在无权重项里等概率随机。 */
export function weightedPick(items, random = Math.random) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const weighted = [];
  const weights = [];
  const unweighted = [];
  for (const item of list) {
    if (Number(item?.weight) > 0) {
      weights.push(Number(item.weight));
      weighted.push(item);
    } else {
      unweighted.push(item);
    }
  }
  if (weighted.length) {
    const index = calWeight(weights, null, random);
    if (index >= 0) return weighted[index];
  }
  if (!unweighted.length) return null;
  return unweighted[Math.floor(random() * unweighted.length) % unweighted.length];
}

export function worldSocketUrl(candidate, { isHttps = true } = {}) {
  const port = isHttps ? candidate.portSsl : candidate.port;
  if (candidate.dyHost) {
    // 官方 dyHost 形态：把代理域名拆段后追加 gw/gs/<子域>/<端口>，默认列表为空，
    // 只有显式配置 gsDyHostList 时才会用到。
    let trimmed = String(candidate.dyHost).trim().replace(/^[\w]+:\/\//i, "");
    const segments = trimmed.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (last !== undefined && /^\d+$/.test(last)) segments.pop();
    segments.push("gs", String(candidate.host).split(".")[0], String(port));
    return `wss://${segments.join("/")}/`;
  }
  return `${isHttps ? "wss" : "ws"}://${candidate.host}:${port}/`;
}

/**
 * 官方 `_getGsTotalInfo`：按 count 升序、剔除 status<=0、受 socketLimit 限制数量，
 * 并派生 direct 前缀与 dyHost 两组备用候选（默认 PROJ 未配置时为空）。
 */
export function buildWorldCandidates(endpoints, {
  isHttps = true,
  hostDirectPre = "",
  dyHostList = [],
  socketLimit = 0,
} = {}) {
  const sorted = [...(endpoints || [])].sort((left, right) => (left.count ?? 0) - (right.count ?? 0));
  const primary = [];
  const direct = [];
  const dynamic = [];
  for (const endpoint of sorted) {
    if (!endpoint || endpoint.status <= 0) continue;
    if (socketLimit > 0 && primary.length >= socketLimit) break;
    if (hostDirectPre && !endpoint.host.startsWith(hostDirectPre) && !/^\d+(\.\d+){3}$/.test(endpoint.host)) {
      direct.push({ ...endpoint, host: `${hostDirectPre}${endpoint.host}`, variant: "direct" });
    }
    primary.push({ ...endpoint, variant: "primary" });
  }
  const first = primary[0] || null;
  if (first && Array.isArray(dyHostList)) {
    for (const dyHost of dyHostList) {
      if (!dyHost) continue;
      dynamic.push({ ...first, dyHost, variant: "dy" });
    }
  }
  void isHttps;
  return { primary, direct, dynamic, all: [...primary, ...direct, ...dynamic] };
}

/** 把已选中的候选变成可直接建连的 endpoint 形状（与历史 extractWorldEndpoints 兼容）。 */
export function toWorldEndpoint(candidate) {
  return {
    host: candidate.host,
    port: Number(candidate.portSsl || candidate.port),
    plainPort: Number(candidate.port || candidate.portSsl),
    enabled: true,
    weight: Number(candidate.count || 0),
    status: Number(candidate.status || 1),
    idx: candidate.idx ?? null,
    variant: candidate.variant || "primary",
    delayMs: Number.isFinite(Number(candidate.delay)) ? Number(candidate.delay) : undefined,
    url: worldSocketUrl(candidate),
  };
}

/**
 * 官方 `_connectGsList` 竞速循环：每 25ms 检查一次；没有成功者时每隔
 * `staggerMs`（150ms）再拨下一条；并发受 `maxInFlight`（wsCountLimit=5）限制；
 * 一旦有成功者立即排序取最优并中止其余；三条放弃条件与官方一致。
 */
export async function raceCandidates(items, {
  measure,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  tickMs = NET_RACE_DEFAULTS.tickMs,
  staggerMs = NET_RACE_DEFAULTS.gsTestDurationMs,
  minTestTimeoutMs = NET_RACE_DEFAULTS.gsMinTestTimeoutMs,
  singleTestTimeoutMs = NET_RACE_DEFAULTS.gsSingleTestTimeoutMs,
  totalTimeoutMs = NET_RACE_DEFAULTS.gsTotalTimeoutMs,
  maxInFlight = NET_RACE_DEFAULTS.wsCountLimit,
  label = (item) => `${item?.host}:${item?.portSsl ?? item?.port}`,
} = {}) {
  const queue = [...(items || [])];
  const attempts = [];
  const succeeded = [];
  const inflight = new Map();
  const startMs = now();
  let lastStartMs = null;
  let aborted = false;
  let reason = null;

  const stopAll = () => {
    aborted = true;
    for (const controller of inflight.values()) {
      try { controller.abort(); } catch { /* already settled */ }
    }
  };

  const launch = (item) => {
    const controller = new AbortController();
    const beganAt = now();
    lastStartMs = beganAt;
    const record = { target: label(item), startedAt: beganAt, succeeded: false, error: null };
    attempts.push(record);
    inflight.set(record, controller);
    // 官方在 _connectGs 里先记 startMs 再同步 connect()：测量必须在同一时刻发起，
    // 否则时延会被事件循环的额外一 tick 拉高。
    let pending;
    try {
      pending = Promise.resolve(measure(item, { signal: controller.signal, startedAt: beganAt }));
    } catch (error) {
      inflight.delete(record);
      record.error = error?.message ? String(error.message).slice(0, 160) : "probe-threw";
      return;
    }
    pending
      .then(() => {
        inflight.delete(record);
        if (aborted) return;
        const delay = Math.max(0, now() - beganAt);
        record.succeeded = true;
        record.delayMs = delay;
        succeeded.push({ item, delay, record });
      })
      .catch((error) => {
        inflight.delete(record);
        record.error = error?.message ? String(error.message).slice(0, 160) : "probe-failed";
      });
  };

  while (!aborted) {
    const elapsed = now() - startMs;
    if (succeeded.length) {
      // 官方：sort("count:asc","delay:asc") —— 负载小者优先，其次时延低者。
      succeeded.sort((a, b) => {
        const countA = Number(a.item?.count ?? 0);
        const countB = Number(b.item?.count ?? 0);
        if (countA !== countB) return countA - countB;
        return a.delay - b.delay;
      });
      const winner = succeeded[0];
      stopAll();
      return {
        ok: true,
        winner: winner.item,
        delayMs: winner.delay,
        attempts,
        elapsedMs: now() - startMs,
        reason: "fastest",
      };
    }
    const attempted = attempts.length;
    const failedCount = attempts.filter((entry) => !entry.succeeded && entry.error).length;
    if (elapsed >= totalTimeoutMs) reason = "total-timeout";
    else if (!queue.length && inflight.size === 0 && attempted > 0 && failedCount >= attempted) reason = "all-failed";
    else if (lastStartMs !== null && elapsed >= minTestTimeoutMs && now() - lastStartMs >= singleTestTimeoutMs) reason = "stalled";
    if (reason) break;
    if (queue.length && inflight.size < maxInFlight && (lastStartMs === null || now() - lastStartMs >= staggerMs)) {
      launch(queue.shift());
    }
    await sleep(tickMs);
  }
  stopAll();
  return {
    ok: false,
    winner: null,
    delayMs: null,
    attempts,
    elapsedMs: now() - startMs,
    reason: reason || "aborted",
  };
}

/** 默认测量手段：只做 TLS 握手（不发业务字节），与官方拨号的时延口径可比。 */
/**
 * 默认测量手段：只做 TLS 握手（不发业务字节），与官方拨号的时延口径可比。
 * 传了 `proxy` 就经代理隧道测量——探测与实连必须同一条出口，否则选出来的端点
 * 在真实链路上完全是另一个结果。
 */
export function createTlsMeasure({
  timeoutMs = NET_RACE_DEFAULTS.probeTimeoutMs,
  tls,
  proxy,
  connect = connectThroughProxy,
} = {}) {
  return async (candidate, { signal } = {}) => {
    const tlsModule = tls || await import("node:tls");
    return await new Promise((resolve, reject) => {
      let settled = false;
      let socket = null;
      let tunnel = null;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        try { socket?.destroy(); } catch { /* already gone */ }
        try { tunnel?.destroy(); } catch { /* already gone */ }
        fn(value);
      };
      const port = Number(candidate.portSsl || candidate.port);
      const attach = (options) => {
        if (settled) return options;
        socket = tlsModule.connect(options);
        socket.once("secureConnect", () => finish(resolve, true));
        socket.once("error", (error) => finish(reject, error));
        socket.once("timeout", () => finish(reject, new Error("tls-probe-timeout")));
        signal?.addEventListener?.("abort", () => finish(reject, new Error("tls-probe-cancelled")), { once: true });
        return options;
      };
      const base = {
        host: candidate.host,
        port,
        servername: candidate.host,
        ALPNProtocols: ["http/1.1"],
        timeout: timeoutMs,
        rejectUnauthorized: false,
      };
      if (!proxy) { attach(base); return; }
      void connect(proxy, { host: candidate.host, port, timeoutMs })
        .then((tunneled) => {
          if (settled) { try { tunneled.destroy(); } catch { /* ignore */ } return; }
          tunnel = tunneled;
          attach({ ...base, socket: tunneled, agent: undefined });
        })
        .catch((error) => finish(reject, error));
    });
  };
}

/**
 * 解析代理串：支持 `http://user:pass@host:port`、`host:port`、`127.0.0.1:7897`。
 * 只允许 http/https 两类（本项目所有出口都是 HTTP CONNECT 代理）。
 */
export function parseProxyUrl(proxy) {
  if (!proxy) return null;
  const raw = String(proxy).trim();
  if (!raw) return null;
    // 协议文法要带数字：socks5 / socks4 这类名字本身就含数字，旧的 /^[a-z]+:\/\// 认不出它，
  // 于是 "socks5://10.0.17.186:1090" 被拼成 "http://socks5://…"，解析出主机名 "socks5"、端口 80，
  // 一路没人报错。URL 规范的 scheme 文法是 [a-z][a-z0-9+.-]*，按它来才轮到下面的协议闸门说话。
  // 少了协议前缀的简写只接受 host:port 这种形态。
  // 否则 "7897" 会被 URL 按 IPv4 数字写法解析成 0.0.30.217:80——一个合法但完全错误的出口。
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !raw.includes(":")) {
    const error = new Error("代理地址缺少端口：请填写 主机:端口（例：127.0.0.1:7897），只写 " + raw.slice(0, 20) + " 会被当成一个 IP");
    error.code = "REAL_PROXY_URL_INVALID";
    throw error;
  }
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    const error = new Error("代理地址无法解析：" + raw.slice(0, 60));
    error.code = "REAL_PROXY_URL_INVALID";
    throw error;
  }
  // 只接受 http / https：本项目的出口是 HTTP CONNECT 隧道（见下方 connectThroughProxy）。
  // 为什么必须在解析这一步就挡掉：socks5:// 交给 https-proxy-agent **不会报错**，它会照拨不误，
  // 把 SOCKS 端口当 HTTP 代理用——结果就是「连了二十秒超时 + 一句看不懂的错误」，
  // 谁也想不出根因是协议不对。在这里当场判死，文案自己说清支持哪两种。
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    const error = new Error(
      "代理协议不支持：" + url.protocol.replace(/:$/, "") + "，本项目的出口只支持 http / https 的 CONNECT 代理",
    );
    error.code = "REAL_PROXY_URL_INVALID";
    throw error;
  }


  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!url.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) {
    const error = new Error("代理地址缺少主机或端口：" + raw.slice(0, 60));
    error.code = "REAL_PROXY_URL_INVALID";
    throw error;
  }
  return {
    protocol: url.protocol === "https:" ? "https" : "http",
    hostname: url.hostname,
    port,
    username: decodeURIComponent(url.username || "") || undefined,
    password: decodeURIComponent(url.password || "") || undefined,
  };
}

/**
 * 用 HTTP CONNECT 在代理里打一条隧道，返回已建立裸 socket。
 * 这是端点竞速与真实连接**共用**的出口：探测走直连、实连走代理，量到的时延
 * 是假的，选出来的端点也可能是错的。
 */
export const PROXY_MISMATCH_CODE = "REAL_PROXY_MISMATCH";

function proxyFailure(message, proxyStatus) {
  const error = new Error(message);
  error.code = PROXY_MISMATCH_CODE;
  if (Number.isInteger(proxyStatus)) error.proxyStatus = proxyStatus;
  return error;
}

export async function connectThroughProxy(proxy, {
  host,
  port,
  timeoutMs = NET_RACE_DEFAULTS.probeTimeoutMs,
  net,
  now = () => Date.now(),
} = {}) {
  const parsed = parseProxyUrl(proxy);
  const netModule = parsed ? (net || await import("node:net")) : null;
  if (!parsed) {
    const net = await import("node:net");
    return await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("direct-connect-timeout")); }, timeoutMs);
      socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
  }
  return await new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const socket = netModule.createConnection({ host: parsed.hostname, port: parsed.port });
    const timer = setTimeout(() => finish(reject, proxyFailure("代理连接超时（" + timeoutMs + "ms）")), timeoutMs);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (fn === reject) { try { socket.destroy(); } catch { /* ignore */ } }
      fn(value);
    };
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      if (settled) return;
      buffer += chunk.toString("latin1");
      const endOfHead = buffer.indexOf("\r\n\r\n");
      if (endOfHead < 0) return;
      const statusLine = buffer.slice(0, buffer.indexOf("\r\n"));
      const status = Number(/\s(\d{3})/.exec(statusLine)?.[1] || 0);
      if (status !== 200) {
        finish(reject, proxyFailure("代理 CONNECT 被拒：" + statusLine.slice(0, 80), status));
        return;
      }
      // 代理可能在 200 之后立刻把远端字节塞进同一个包里，这些数据属于隧道，不能丢。
      const leftover = buffer.slice(endOfHead + 4);
      buffer = "";
      socket.removeAllListeners("data");
      if (leftover.length) socket.unshift(leftover);
      resolve(socket);
    });
    socket.once("close", () => finish(reject, proxyFailure("代理在 CONNECT 完成前关闭了连接")));
    socket.once("error", (error) => finish(reject, tagProxyConnectFailure(error, proxy)
      || proxyFailure("代理不可达：" + String(error?.message || error).slice(0, 120))));
    const auth = parsed.username
      ? "\r\nProxy-Authorization: Basic " + Buffer.from(parsed.username + ":" + (parsed.password || "")).toString("base64")
      : "";
    socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}${auth}\r\nConnection: keep-alive\r\n\r\n`);
  });
}

/**
 * 出口一致性闸门：账号网关、SDK、世界服必须走**同一条**出口 IP。
 * 「登录 IP 在 A、进世界 IP 在 B」是脚本最常见的机器特征，也是官方风控最容易
 * 归并的信号，所以这里一旦探不通代理就直接 fail-closed，绝不退化成直连。
 */
export async function assertProxyRoute({
  proxy,
  targets = [],
  timeoutMs = NET_RACE_DEFAULTS.probeTimeoutMs,
  connect = connectThroughProxy,
} = {}) {
  const parsed = parseProxyUrl(proxy);
  if (!parsed) return { required: false, ok: true, mode: "direct", checks: [] };
  const checks = [];
  const connectionErrors = [];
  for (const target of targets) {
    if (!target || !target.host || !Number(target.port)) continue;
    const startedAt = Date.now();
    let socket = null;
    try {
      socket = await connect(proxy, { host: target.host, port: Number(target.port), timeoutMs });
      checks.push({ target: `${target.host}:${target.port}`, ok: true, delayMs: Date.now() - startedAt });
    } catch (error) {
      connectionErrors.push(error);
      checks.push({
        target: `${target.host}:${target.port}`,
        ok: false,
        delayMs: Date.now() - startedAt,
        reason: String(error?.message || error).slice(0, 160),
      });
    } finally {
      try { socket?.destroy(); } catch { /* ignore */ }
    }
  }
  const failed = checks.filter((entry) => !entry.ok);
  if (failed.length) {
    // Android overlay: retain actual no-route socket facts through preflight.
    // A mixed auth/format/protocol failure must retain the original blocking path.
    if (connectionErrors.length === failed.length && connectionErrors.every(isProxyRouteUnavailable)) throw connectionErrors[0];
    const error = new Error("代理出口与世界服不可达（" + failed.map((entry) => entry.target).join(", ") + "）：拒绝改用直连，以免出现换出口的机器特征");
    error.code = "REAL_PROXY_MISMATCH";
    error.proxy = `${parsed.hostname}:${parsed.port}`;
    error.checks = checks;
    throw error;
  }
  return { required: true, ok: true, mode: "proxy", proxy: `${parsed.hostname}:${parsed.port}`, checks };
}

export function endpointKey(endpoint) {
  if (typeof endpoint === "string") return endpoint.trim();
  return `${endpoint?.host}:${endpoint?.portSsl ?? endpoint?.port}`;
}

/**
 * 完整解析：候选集合 → 排除已知失败 → 上次成功者优先拨号 → 竞速 → 返回端点。
 * `cacheKey` 为 `sgid`，缓存只用来决定「先试谁」，绝不用来跳过重新查询。
 */
export async function resolveWorldEndpoint(response, {
  sgid,
  // 不显式传 measure 时，探测出口跟随 proxy：这是「测到的就是连的」这条硬约束的落点。
  proxy,
  measure = createTlsMeasure({ proxy }),
  now,
  sleep,
  exclude = [],
  preferred,
  isHttps = true,
  hostDirectPre = process.env.GARDEN_HOST_DIRECT_PRE || "",
  dyHostList = (process.env.GARDEN_GS_DY_HOSTS || "").split(",").map((value) => value.trim()).filter(Boolean),
  socketLimit = 0,
  raceOptions = {},
} = {}) {
  const endpoints = parseWorldEndpoints(response, { sgid });
  if (!endpoints.length) {
    const error = new Error("网关未下发可用世界服端点");
    error.code = "REAL_WORLD_ENDPOINT_MISSING";
    throw error;
  }
  const excluded = new Set(exclude.map(endpointKey));
  const candidates = buildWorldCandidates(endpoints, { isHttps, hostDirectPre, dyHostList, socketLimit })
    .all
    .filter((candidate) => !excluded.has(endpointKey(candidate)));
  if (!candidates.length) {
    const error = new Error("全部世界服候选都已失败");
    error.code = "REAL_WORLD_ENDPOINT_EXHAUSTED";
    throw error;
  }
  const wanted = preferred ? endpointKey(typeof preferred === "string" ? { host: preferred.split(":")[0], portSsl: Number(preferred.split(":")[1]) } : preferred) : null;
  const ordered = wanted
    ? [...candidates].sort((left, right) => (endpointKey(left) === wanted ? -1 : 0) - (endpointKey(right) === wanted ? -1 : 0))
    : candidates;
  const raced = await raceCandidates(ordered, {
    measure,
    now,
    sleep,
    label: endpointKey,
    ...raceOptions,
  });
  if (!raced.ok) {
    const proxyErrors = raced.attempts.filter((attempt) => attempt.error && /代理|proxy/i.test(String(attempt.error)));
    if (proxy && raced.attempts.length && proxyErrors.length === raced.attempts.length) {
      const error = new Error("代理出口无法到达任何世界服候选：拒绝退回直连（换出口进世界是最容易被归并的脚本特征）");
      error.code = PROXY_MISMATCH_CODE;
      error.race = raced;
      throw error;
    }
    const error = new Error(`世界服端点全部不可达（${raced.reason}）`);
    error.code = "REAL_WORLD_ENDPOINT_UNREACHABLE";
    error.race = raced;
    throw error;
  }
  return {
    endpoint: toWorldEndpoint({ ...raced.winner, delay: raced.delayMs }),
    candidates: ordered.map((candidate) => ({
      host: candidate.host,
      port: Number(candidate.portSsl || candidate.port),
      count: candidate.count,
      variant: candidate.variant,
    })),
    attempts: raced.attempts.map((attempt) => ({
      target: attempt.target,
      ok: Boolean(attempt.succeeded),
      delayMs: attempt.delayMs ?? null,
      error: attempt.error || null,
    })),
    delivered: endpoints.map((entry) => ({ host: entry.host, port: entry.port, portSsl: entry.portSsl, status: entry.status, count: entry.count })),
  };
}

/** 官方 `_getGwTotalInfo`：主域名 + direct 前缀 + dyHost 代理三类 URL。 */
export function buildGatewayProbeUrls({
  host,
  port = null,
  portSsl = null,
  isHttps = true,
  hostDirectPre = "",
  dyHostList = [],
}) {
  const urls = [];
  const scheme = isHttps ? "https" : "http";
  const activePort = isHttps ? portSsl : port;
  const push = (hostname) => {
    const url = `${scheme}://${hostname}${activePort ? `:${activePort}` : ""}`;
    if (!urls.includes(url)) urls.push(url);
  };
  push(host);
  if (hostDirectPre && !host.startsWith(hostDirectPre)) push(`${hostDirectPre}${host}`);
  for (const dyHost of dyHostList || []) {
    if (!dyHost) continue;
    let segments = String(dyHost).trim().replace(/^[\w]+:\/\//i, "").split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (last !== undefined && /^\d+$/.test(last)) segments = segments.slice(0, -1);
    segments.push("gw", String(host).split(".")[0], ...(activePort ? [String(activePort)] : []));
    const url = `https://${segments.join("/")}`;
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

/**
 * 官方 `tryGw`：并发探测所有网关 URL；2 秒内谁先通就用谁；超过判定窗口后取
 * 已完成里最快的一条；总超时 10 秒则回退主 URL（返回 finalUrl=null 由调用方决定）。
 */
export async function raceGatewayUrls(urls, {
  probe,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  judgeMs = NET_RACE_DEFAULTS.gwJudgeMs,
  totalTimeoutMs = NET_RACE_DEFAULTS.gwTestTimeoutMs,
  tickMs = NET_RACE_DEFAULTS.gwProbeTickMs,
} = {}) {
  const list = Array.isArray(urls) ? urls.filter(Boolean) : [];
  if (!list.length) return { ok: false, url: null, results: [] };
  const startedAt = now();
  const results = list.map((url) => ({ url, delayMs: null, failed: false }));
  for (const entry of results) {
    void Promise.resolve()
      .then(() => probe(entry.url))
      .then(() => { entry.delayMs = now() - startedAt; })
      .catch(() => { entry.failed = true; });
  }
  while (true) {
    const elapsed = now() - startedAt;
    const first = results[0];
    if (first.delayMs !== null && first.delayMs <= judgeMs) return { ok: true, url: first.url, delayMs: first.delayMs, results };
    if (elapsed > totalTimeoutMs) break;
    if (elapsed > judgeMs) {
      const alive = results.filter((entry) => !entry.failed && entry.delayMs !== null);
      if (alive.length) {
        alive.sort((left, right) => left.delayMs - right.delayMs);
        return { ok: true, url: alive[0].url, delayMs: alive[0].delayMs, results };
      }
      if (results.every((entry) => entry.failed)) break;
    }
    await sleep(tickMs);
  }
  return { ok: false, url: list[0], results };
}

/**
 * 这条代理地址能不能当出口。返回 null 表示可用，否则返回 { code, message }。
 *
 * 为什么要单独一层：**内网地址永远不可能成为公网出口**，但它长得完全像一条合法代理
 * （socks5://10.0.17.186:1090 就是这样——演示数据塞进池子、一键分配给账号，
 * 真实托管于是卡二十秒超时，客户手机上只剩一句看不懂的「启动失败」）。这里当场判死。
 *
 * **回环不算错**：本机跑 Clash / v2ray 转发器（127.0.0.1:7897）是文档里的正常抓包姿势，
 * 一起挡掉就把调试链路也砍了。被拒的是「既不是本机、也不在公网」的那一段。
 * 只按字面量判定，不做 DNS：域名解析到内网是另一回事，运行时由拨号实测兜住。
 */
export function proxyEgressProblem(proxy) {
  let parsed = null;
  try {
    parsed = parseProxyUrl(proxy);
  } catch (error) {
    return { code: error?.code || "REAL_PROXY_URL_INVALID", message: String(error?.message || error) };
  }
  if (!parsed) return null;
  const host = String(parsed.hostname || "").toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (!host) return { code: "REAL_PROXY_EGRESS_UNUSABLE", message: "代理地址没有主机名" };
  if (host === "localhost" || host === "ip6-localhost") return null;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127) return null; // 本机转发器：允许
    const reason = a === 10 || a === 0 ? "内网或本网络地址"
      : a === 169 && b === 254 ? "链路本地地址"
      : a === 192 && b === 168 ? "局域网地址"
      : a === 172 && b >= 16 && b <= 31 ? "内网地址"
      : a === 100 && b >= 64 && b <= 127 ? "运营商级内网地址"
      : a >= 224 ? "组播或保留地址"
      : null;
    if (reason) {
      return {
        code: "REAL_PROXY_EGRESS_UNUSABLE",
        message: "代理地址 " + host + " 是" + reason + "，既不是本机也不是公网出口，不可能把流量带到游戏服务器",
      };
    }
    return null;
  }
  if (/^::1$/.test(host)) return null;
  if (/^f[cd]/i.test(host) || /^fe80/i.test(host)) {
    return { code: "REAL_PROXY_EGRESS_UNUSABLE", message: "代理指向 IPv6 内网地址（" + host + "），不能当出口" };
  }
  if (host.endsWith(".local") || host.endsWith(".internal")) {
    return { code: "REAL_PROXY_EGRESS_UNUSABLE", message: "代理指向局域网名字（" + host + "），不能当公网出口" };
  }
  return null;
}

/**
 * 「线路连不上」必须和「游戏返回错误」分开：混在一起的代价是白烧真实登录。
 * 实服事故（2026-09-09 run 51 / 账号 12）：一条 socks5://10.0.17.186:1090 的废线路被一键
 * 分配给真实托管账号，账号层 HTTPS 去拨代理，21 秒后 Node 抛「connect ETIMEDOUT
 * 10.0.17.186:1090」。因为 etimedout 这个串里不含 timeout，错误映射层没认出它是网络问题，
 * 一路塌缩成 REAL_RPC_ERROR，客户手机上只剩「未归类原因：REAL_RPC_ERROR」，
 * 复工逻辑又按同一句白烧了两次一次性会话。
 */
export const PROXY_UNREACHABLE_CODE = "REAL_PROXY_UNREACHABLE";
export const PROXY_NO_ROUTE_SOCKET_CODES = Object.freeze(new Set(['ENETUNREACH', 'EHOSTUNREACH']));

// These facts originate at the actual connect error callback. Text, an outer
// proxy code alone and a missing syscall/errno are insufficient for recovery.
export function proxyRouteFailureEvidence(error) {
  if (error?.code !== PROXY_UNREACHABLE_CODE || error.transportFailure !== true
    || !PROXY_NO_ROUTE_SOCKET_CODES.has(error.transportCode)
    || error.socketSyscall !== 'connect' || !Number.isSafeInteger(error.socketErrno)) return null;
  return { transportFailure: true, transportCode: error.transportCode, socketSyscall: 'connect', socketErrno: error.socketErrno };
}
export function isProxyRouteUnavailable(error) { return proxyRouteFailureEvidence(error) !== null; }

/**
 * 只收「拨代理这一步」的 Socket 错误。
 * ECONNRESET / EPIPE 有可能是隧道建好之后游戏侧断的，那种不能算在线路头上。
 */
export const PROXY_CONNECT_SOCKET_CODES = Object.freeze(new Set([
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
]));

/** 代理的 host:port；地址本身不合法就返回 null（宁可不定性，也不硬猜一条线路）。 */
export function proxyConnectAddress(proxy) {
  let parsed = null;
  try {
    parsed = parseProxyUrl(proxy);
  } catch {
    return null;
  }
  if (!parsed) return null;
  const host = String(parsed.hostname || "").toLowerCase().replace(/^\[(.*)\]$/, "$1");
  const port = String(parsed.port || "");
  if (!host || !port) return null;
  return { host, port, egress: host + ":" + port };
}

/**
 * 证据齐了才改判：① 这一轮确实挂了代理 ② 错误码属于拨号阶段
 * ③ 报错里出现的 host:port 要么一个都没有、要么就是代理本身。
 * 任何一条不满足都返回 null，原错误照常上抛。命中时不改原错误对象，
 * 而是新建一条并把原错误挂进 cause——后台溯源必须看得到底层原文。
 */
export function tagProxyConnectFailure(error, proxy) {
  const code = typeof error?.code === "string" ? error.code.toUpperCase() : "";
  if (!code || !PROXY_CONNECT_SOCKET_CODES.has(code)) return null;
  const address = proxyConnectAddress(proxy);
  if (!address) return null;
  const message = String(error?.message || "");
  const seen = [...message.matchAll(/([a-z0-9._-]+|\[[0-9a-f:.]+]):(\d{1,5})/gi)];
  const namesProxy = seen.some(([, host, port]) => (
    host.replace(/^\[|\]$/g, "").toLowerCase() === address.host && port === address.port
  ));
  if (seen.length && !namesProxy) return null;
  const tagged = new Error("出口线路连不上：" + (message || code), { cause: error });
  tagged.code = PROXY_UNREACHABLE_CODE;
  tagged.proxyEgress = address.egress;
  tagged.originalCode = code;
  if (PROXY_NO_ROUTE_SOCKET_CODES.has(code) && error?.syscall === 'connect' && Number.isSafeInteger(error?.errno)) {
    Object.assign(tagged, { transportFailure: true, transportCode: code, socketSyscall: 'connect', socketErrno: error.errno });
  }
  return tagged;
}
