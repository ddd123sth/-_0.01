// 「我的花园世界」真实游戏连接器 —— 与 babigame.cn 官方服务器直接通信
// 协议（2026-09-06 从真实客户端逆向验证）：
//   网关: POST https://hygnhf2.babigame.cn/gw
//   请求: { sign: md5(aStr + "smallaitt"), a: JSON.stringify([...g].map(c=>c.charCodeAt(0)^0x77)), l: "zh" }
//   其中 g = ["模块.方法", {参数}, token|null]
//   响应: { v: {...}, d?, r?, t? }（v 内为数字字段索引的结构）
import crypto from "node:crypto";
import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { CAPTURED_TRANSPORT, dalvikRequestHeaders } from "./client-profile.js";
import { androidLoginSignal, beginAndroidHttpRequest, throwIfAndroidLoginAborted } from './android-login-context.js';

export const GW_HOSTS = ["hygnhf2.babigame.cn", "hygnhf1.babigame.cn"];
export const SDK_API = "https://apiwxfast.babigame.cn";
export const SIGN_KEY = "smallaitt";
const XOR = 0x77;

export function encodeG(str) {
  const codes = [];
  for (const ch of str) codes.push(ch.charCodeAt(0) ^ XOR);
  // codes contains only the finite integers produced by the original XOR loop.
  // Keep its exact JSON bytes without invoking an inherited Array.toJSON.
  return "[" + codes.join(",") + "]";
}
export function decodeA(aStr) {
  const arr = typeof aStr === "string" ? JSON.parse(aStr) : aStr;
  return arr.map((c) => String.fromCharCode(c ^ XOR)).join("");
}
export function gwSign(encodedA) {
  return crypto.createHash("md5").update(encodedA + SIGN_KEY, "utf8").digest("hex");
}

export function buildRpcPayload(method, args = {}, token = null, extra = null) {
  const call = [method, args, token];
  if (extra !== null && extra !== undefined) call.push(extra);
  const a = encodeG(JSON.stringify(call));
  return { sign: gwSign(a), a, l: "zh" };
}

export function buildWsRequest(method, args, token, key) {
  return { e: "request", d: { r: "gs", p: buildRpcPayload(method, args, token), k: key } };
}

// 官方网关请求走 Android Dalvik 栈：长连接 + 固定六个头 + 固定顺序。
// 我们原来只发两个头、走短连接、UA 是自造的 GardenWorld/*，在服务端日志里
// 与真机流量的差别过大，属于「不用分析就能判定为脚本」的特征。
const KEEP_ALIVE_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 8,
  maxFreeSockets: 4,
});

function post(host, path, body, { timeoutMs = 10000, proxy, userAgent, signal = androidLoginSignal() } = {}) {
  return new Promise((resolve, reject) => {
    throwIfAndroidLoginAborted(signal);
    const data = JSON.stringify(body);
    const proxyUrl = proxy ?? process.env.GAME_HTTP_PROXY ?? process.env.GAME_WS_PROXY;
    const lifetime = beginAndroidHttpRequest({ signal, timeoutMs, proxy: proxyUrl });
    let settled = false;
    const fail = error => { if (settled) return; settled = true; lifetime.finish(); reject(lifetime.normalize(error)); };
    const succeed = value => { if (settled) return; try { lifetime.check(); } catch (error) { fail(error); return; } settled = true; lifetime.finish(); resolve(value); };
    let req;
    try {
    const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl, { signal: lifetime.signal }) : KEEP_ALIVE_AGENT;
    req = https.request(
      {
        host,
        path,
        method: "POST",
        timeout: timeoutMs,
        agent,
        headers: dalvikRequestHeaders({
          host,
          contentLength: Buffer.byteLength(data),
          userAgent: userAgent || process.env.GARDEN_DALVIK_USER_AGENT || CAPTURED_TRANSPORT.dalvikUserAgent,
        }),
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try { succeed(JSON.parse(buf)); } catch { succeed({ raw: buf, status: res.statusCode }); }
        });
        res.on('error', fail);
        res.on('aborted', () => fail(Object.assign(new Error('网关响应连接已中断'), { code: 'ECONNRESET' })));
      }
    );
    } catch (error) { fail(error); return; }
    lifetime.attach(req);
    req.on("error", fail);
    req.on("timeout", () => { req.destroy(Object.assign(new Error("timeout"), { code: 'ETIMEDOUT' })); });
    try { lifetime.check(); req.end(data); } catch (error) { req.destroy(error); fail(error); }
  });
}

// 网关 RPC：g = ["index.login", {...}, token]
export async function gwCall(method, args = {}, token = null, {
  host = GW_HOSTS[0],
  extra = null,
  proxy,
  timeoutMs = 10000,
  signal = androidLoginSignal(),
} = {}) {
  throwIfAndroidLoginAborted(signal);
  const res = await post(host, "/gw", buildRpcPayload(method, args, token, extra), { proxy, timeoutMs, signal });
  throwIfAndroidLoginAborted(signal);
  return res;
}

// SDK 登录（微信小游戏通道）：用 /game/login 返回的 token + content 完成游戏登录
export async function sdkWxLogin({ token, openId, content, chnId = 537, zoneCode = "ys" }) {
  return gwCall("index.login", {
    sdkId: 10000,
    chnId,
    params: { token, open_id: openId, content, zoneCode, launchOptions: { scene: 1400, query: {} } },
  }, null);
}

// 会话级 RPC（带游戏会话 token）
export async function gameCall(method, args = {}, session) {
  return gwCall(method, args, session.token);
}
