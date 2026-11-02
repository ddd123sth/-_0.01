// 拟人化节奏与风控闸门（防检测的核心层）。
//
// 背景判断（证据分级见括号）：
//   * 官方客户端的心跳本身是**精确周期**的（usr.heartTick 实测 60.000s，SDK heartbeat 实测
//     30.000s 各 49 次零漂移）——所以给心跳加抖动反而是负优化（实服抓包已验证）。
//   * 真正的机器特征是「玩法动作」：0 间隔连发、每天 24 小时无休、动作间隔方差为 0、
//     同一目标反复重试、被踢/报错后立刻重连。这些才是风控可观测的（官方源码推断）。
//   * 因此本层只做三件事：玩法动作之间拟人抽样间隔 + 随机长休息；按账号/自然日累计
//     配额并在越线时拒绝；遇到服务器异常码直接熔断并冷却，绝不自动重试。
//
// 本模块是纯状态机（时间、随机、等待全部注入），离线可测；落盘账本只写计数与时间戳，
// 不写账号、token、方法参数。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** 官方源码 `G.CnnMgr` 的踢线/维护码：出现即必须停手，不能自动重连硬闯。 */
import { LOGIN_FATAL_REMOTE_CODES } from "./login-error-codes.js";

// 世界服致命码 + 登录侧致命码（封号/设备封/IP 封）。
// 登录侧此前一个都没纳入，于是「账号已被封禁」在系统里等同于一次普通失败，还会继续重试。
export const FATAL_REMOTE_CODES = Object.freeze(Object.freeze([
  90000, 90001, 90002, 90003, 90004, 91002, 91005, 91006,
  ...LOGIN_FATAL_REMOTE_CODES,
]));
export const FATAL_ERROR_CODES = Object.freeze([
  "REAL_SESSION_KICKED",
  "REAL_MAINTENANCE",
  "REAL_ACCOUNT_BLOCKED",
]);

/** 默认睡眠起点带：本地 00:00–03:00 之间抽一个起点。 */
export const SLEEP_START_BAND_DEFAULT = Object.freeze([0, 180]);

const PRESET_BASE = {
  preset: "balanced",
  // 动作间隔抽样区间（毫秒）：读操作与写操作分开建模。
  readGapMs: [180, 1100],
  writeGapMs: [900, 3200],
  // 同一目标（同方法+同参数摘要）在这个窗口内不再重复写，避免「连点」痕迹。
  sameTargetWindowMs: 90000,
  // 每做 burstEvery 次动作，插入一次随机长休息。
  burstEvery: [6, 16],
  burstPauseMs: [45000, 240000],
  // 配额。
  // 2026-09-10 按用户明确要求放宽（「不能限制写额度啊，不然工作还没做完呢，怎么实现自动化」）。
  // 900/天 实测在 08:06-09:23 就被一整轮正常托管用光（run 29-32），当天之后只能等到凌晨复工。
  // 放宽的是**日**额度；每小时那道防连点上限与每分钟动作数一律不动 —— 那两条才是像不像人的关键，
  // 日额度只管「一天总共能干多少活」，钟点节奏才是风控看得见的东西。
  maxWritesPerHour: 300,
  maxWritesPerDay: 3000,
  maxActionsPerMinute: 30,
  // 官方有 IDelayLoginCheckCfg：登录后一段窗口内的行为被重点核查，
  // 且 IAbnormalLog 会记 lastHeartTime/missCnt。窗口内只读不写是唯一稳的处置。
  // 实值不下发（见 docs/RISK-MODEL.md 第 2 节），所以取保守整档并可被面板配置覆盖。
  postLoginReadOnlyMs: 90000,
  // 会话时长与每日睡眠窗口（真人不会 24 小时在线）。
  // 睡眠起点带（自本地零点起算的分钟偏移）：真人是「深夜睡、白天醒」，不是在一天里随机挑 8 小时睡。
  // 2026-09-10 实况反证：官服 2280 的号 16:09 被判去睡觉、00:02 才醒，整个傍晚到午夜停着不动，
  // 而客户恰恰是晚上打开手机看它干活；旧写法把起点从全天 1440 分钟里抽，一定会摊到营业时段。
  // 起点抽在 00:00–03:00、时长仍 6–9 小时 ⇒ 收工落在 06:00–12:00，顺带盖住官方 05:00–07:00 停服更新。
  sleepStartBandMinutes: SLEEP_START_BAND_DEFAULT,
  sessionMaxMs: [3600000, 9000000],
  sessionRestMs: [900000, 2700000],
  dailySleepHours: [6, 9],
  dailyMaxOnlineMinutes: 1080,
  // 熔断。
  maxConsecutiveFailures: 3,
  errorRateWindow: 20,
  errorRateLimit: 0.35,
  breakerMs: 900000,
  reloginMinIntervalMs: 300000,
};

// ── 开发态总闸（GARDEN_DEV_UNTHROTTLE=1，2026-09-21 用户立项）──────────────────────
// 为什么有它：实服切换/验收要一遍遍跑真轮次，而下面这 9 项**面板里调不到**（都是硬闸），
// 每一轮都要白等几分钟到几十分钟。开发态把它们**放到各自可达的最小值**，把这段等待省掉。
//
// ⛔ 三条边界（写死在这里，越界即违规）：
//   ① 只动**我们自己设的等待**（下面那 9 项）。官方侧的拒绝、次数上限、接口限流、顶号处理
//      **一律照旧尊重**——被拒就是被拒，不因为开了这个闸就重试、硬闯或刷脸。
//   ② **真钱、凭据、单会话、写后不重发四条不在本闸范围内**，一条都不放宽。
//   ③ **本闸不免「走客户路径」（铁律 12）**：升 ready 仍必须由界面上那张卡勾起来、走完整用户链路；
//      开了这个闸也不许拿"我用脚本 / 直接改配置跑通了"当验收证据。
//
// 出厂态必须逐字等于今天：不带这个环境变量时 `applyDevUnthrottle` 原样返回，一个字段都不碰
// （`test:duty-unthrottle` 有一半判据专钉这条）。
export const DEV_UNTHROTTLE_ENV = "GARDEN_DEV_UNTHROTTLE";

/** 闸开没开。只认 1/true/on（"0"/"false"/空一律算关，别让随手一个值就把硬闸拆了）。 */
export function isDevUnthrottleOn(env = process.env) {
  const raw = String((env && env[DEV_UNTHROTTLE_ENV]) ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

/**
 * 被放到最松的 9 项。`min` 一律取 `createHumanPolicy` 里那层 clamp 的**下界**（或 0）——
 * 即"最小可达值"，闸门只把它顶到下界，**不绕过 clamp**（那两个高下界也照旧尊重：
 * 熔断冷却下界 60 秒、重登最小间隔下界 30 秒，够用且不动安全常量）。
 */
export const DEV_UNTHROTTLE_FIELDS = Object.freeze([
  ["postLoginReadOnlyMs", 1000, "登录后只读核查窗口"],
  // ⚠️ 这一格是**标量**，但 `createHumanPolicy` 把它交给 `clampPair` 处理，而 `clampPair` 对
  //    非数组入参一律回落 fallback ⇒ **传标量根本不生效**（今天任何标量覆盖都会被静默忽略，
  //    包括面板那一路）。所以要过它必须写成数组 `[0, 0]`（取 `[0]` 就是 0）。
  ["sameTargetWindowMs", [0, 0], "同一目标重复写冷却"],
  ["burstPauseMs", [1000, 1000], "长休息时长"],
  ["reloginMinIntervalMs", 30000, "两次重登的最小间隔"],
  ["breakerMs", 60000, "熔断后的冷却"],
  ["sessionMaxMs", [86400000, 86400000], "单次在线时长"],
  ["sessionRestMs", [1000, 1000], "两次上线之间的间歇"],
  ["readGapMs", [60, 60], "读操作之间的停顿"],
  ["writeGapMs", [300, 300], "写操作之间的停顿"],
]);

/** 给人看的一行：「开发加速态·被放到最松的项：登录后只读核查窗口、同一目标重复写冷却、…」。 */
export function describeDevUnthrottle(env = process.env) {
  if (!isDevUnthrottleOn(env)) return null;
  return "开发加速态·被放到最松的项：" + DEV_UNTHROTTLE_FIELDS.map(([, , label]) => label).join("、");
}

/**
 * 把上面那 9 项盖到面板覆盖层之上（**放最后**，所以它盖得住面板值——这正是"总闸"的意思）。
 * 不带环境变量时**原样返回同一个对象**，出厂态逐字不变。
 * @returns {{overrides: object, applied: string[]|null}} applied=null 表示闸没开
 */
export function applyDevUnthrottle(overrides = {}, env = process.env) {
  if (!isDevUnthrottleOn(env)) return { overrides, applied: null };
  const next = { ...overrides };
  for (const [field, min] of DEV_UNTHROTTLE_FIELDS) {
    next[field] = Array.isArray(min) ? [...min] : min;
  }
  // 会话时长按"分钟"还有一个面板字段在管它（见 humanPolicyFromConfig 末尾那一段），
  // 一起顶到上限，否则面板里填过的那个数会把 sessionMaxMs 又压回去。
  next.dailyMaxOnlineMinutes = 1440;
  // 旗标随策略走（`createHumanPolicy` 会把它原样带出来）：重登那道**账本 hold** 不在策略数值里，
  // 它由 `noteRelogin` 现读，只能靠这个旗标知道闸开着。闸关时**不写这个字段**，
  // 策略对象与今天逐字相同（出厂态零漂移）。
  next.devUnthrottle = true;
  return { overrides: next, applied: DEV_UNTHROTTLE_FIELDS.map(([, , label]) => label) };
}

export const HUMAN_POLICY_PRESETS = Object.freeze({
  // 最像真人：动作更慢、配额更紧、必睡觉。
  conservative: Object.freeze({
    ...PRESET_BASE,
    preset: "conservative",
    readGapMs: [320, 2200],
    writeGapMs: [1600, 6000],
    burstEvery: [4, 10],
    burstPauseMs: [120000, 480000],
    maxWritesPerHour: 150,
    maxWritesPerDay: 1200,
    maxActionsPerMinute: 18,
    dailyMaxOnlineMinutes: 780,
    postLoginReadOnlyMs: 180000,
  }),
  balanced: Object.freeze({ ...PRESET_BASE }),
  // 只给"我自己的号"用：去掉睡眠窗口、放宽配额；风险自负，日志会标明用了 brisk。
  brisk: Object.freeze({
    ...PRESET_BASE,
    preset: "brisk",
    readGapMs: [120, 600],
    writeGapMs: [500, 1600],
    burstEvery: [10, 25],
    burstPauseMs: [20000, 90000],
    maxWritesPerHour: 800,
    maxWritesPerDay: 6000,
    maxActionsPerMinute: 60,
    dailySleepHours: [0, 0],
    dailyMaxOnlineMinutes: 1440,
    reloginMinIntervalMs: 120000,
    postLoginReadOnlyMs: 30000,
  }),
});

function clampPair(value, fallback, { min, max }) {
  const source = Array.isArray(value) ? value : fallback;
  let low = Math.round(Number(source?.[0] ?? fallback[0]));
  let high = Math.round(Number(source?.[1] ?? source?.[0] ?? fallback[1]));
  if (!Number.isFinite(low)) low = fallback[0];
  if (!Number.isFinite(high)) high = fallback[1];
  if (low > high) [low, high] = [high, low];
  return [Math.min(Math.max(low, min), max), Math.min(Math.max(high, min), max)];
}

/**
 * 下一个本地 0 点的毫秒时间戳。
 * 「今日额度」的计数器正是在这一刻清零（roll() 按 localDayKey 判断换日），
 * 所以日额度的恢复时间必须算到这里：不能拍一个整数小时，更不能返回 null 把任务停死
 * ——停在原地等于把「全自动」断成「等人再点一次启动」。
 */
export function nextLocalDayBoundaryMs(nowMs = Date.now()) {
  const date = new Date(nowMs);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

function positiveInteger(value, fallback, min) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Math.max(min, Math.round(fallback));
  return Math.max(min, Math.round(parsed));
}

/**
 * 动作最小间隔的 **clamp 下界**（毫秒）——客户自己在面板上填数时拦他的那道底，
 * **不是运行期实际停顿的值**（那个取档位表 `readGapMs`/`writeGapMs` 的第一元）。
 * 屏上要说「最快多久」只能报档位值；报这里就是假话（10-02 用户当面抓到过）。
 * 唯一出处：`createHumanPolicy` 与 `schema.js` 那句只读展示行都读这一份。
 */
export const GAP_FLOOR_MS = Object.freeze({
  read: (limitsOn) => (limitsOn === false ? 30 : 60),
  write: (limitsOn) => (limitsOn === false ? 100 : 300),
});

/**
 * 日常段（领工资／邮件／宝箱那一族）两次跑之间的节流。
 * 〔10-02 用户令「不能说设置关了，你后台还在强行等待」〕它从前**完全不吃总开关**：
 *   出厂 5 分钟、下界 60 秒，页面上从头到尾没有这一格 ⇒ 0 点后到点该领的日常会被整段推后最多 5 分钟。
 * 现在跟着那把「操作节奏」总开关分两档：**开着逐字等于今天（5 分钟），关着压到本文件早就声明过的
 *   那道 60 秒下界**（`Math.max(60_000, …)` 里同一个数，不是新发明的常数）。
 * 为什么不压到 0：日常段一跑就是四五发 RPC，每拍都问一遍是最典型的机器特征——那是官方侧风险，
 *   属铁律 9 §C「别人砌的墙」，不在可以拆的范围内。
 * 调用方递的是 `adapter.policy.limitsEnabled`——**与写闸、与排程缓冲同一份策略对象**（同源同拍）。
 * 方向上它只准让事情**更早**发生，永远不能授权任何客户没勾的东西（判据在 `test:pacing-master` ③）。
 */
export function dailyThrottleMs(baseMs, limitsEnabled) {
  const base = Number.isFinite(Number(baseMs)) && Number(baseMs) > 0 ? Number(baseMs) : 5 * 60 * 1000;
  if (limitsEnabled === false) return Math.min(base, 60_000);
  return base;
}

/**
 * 「我们自己数出来的失败」之后冻多久：只读策略、不在这里另定一个数。
 * 策略里没有 `breakerLocalMs`（旧夹具/旧账本）时回落 `breakerMs` ⇒ 与今天逐字一致，绝不放大也不缩小。
 */
export function localBreakerMs(policy) {
  const local = Number(policy?.breakerLocalMs);
  if (Number.isFinite(local) && local > 0) return local;
  const full = Number(policy?.breakerMs);
  return Number.isFinite(full) && full > 0 ? full : 60000;
}

/**
 * 归一化 + 安全下限：任何配置都不允许把写间隔压到 0 或关掉熔断。
 *
 * [第22件·2026-09-23] `limitsEnabled` ＝面板「开启节奏限制」那格总开关。
 *   · `true`（面板打开）＝下面的档位与各项上限**全部生效**；
 *   · `false`（面板关着，也是出厂态）＝**额度、每日休息、两次上线间歇、长休息、同目标冷却一律不生效**
 *     （判定里整段跳过），**只剩两个底线**：① 动作最小间隔（`readGapMs`/`writeGapMs` 的**下界**，由下面那层
 *     clamp 保证：〔10-02 用户改口径〕**关着时读 ≥30ms、写 ≥100ms**——用户原话「不开启防封，大概0.1秒就可以了，
 *     默认的兜底策略要时间控制的很短」；**开着时仍是读 ≥60ms、写 ≥300ms，一格未动**）② 出错熔断（它管的是
 *     "被踢了别硬闯"，不是节奏）。
 *     另两个底线不经过本文件：**登录后只读核查窗**在 `real-adapter.js`（关着时同样归 0，见
 *     `humanPolicyFromConfig` 的清零清单）、**写后不重发与单会话**在各自模块。
 *   ⚠️ 这一格**不是**"把安全一并放掉"：上面两条底线 + adapter 那两条在任何档位下都成立（守卫 `test:pacing-master`）。
 */
export function createHumanPolicy(overrides = {}) {
  const name = typeof overrides?.preset === "string" ? overrides.preset : "balanced";
  const preset = HUMAN_POLICY_PRESETS[name] || HUMAN_POLICY_PRESETS.balanced;
  const merged = { ...preset, ...overrides, preset: name in HUMAN_POLICY_PRESETS ? name : preset.preset };
  // 〔10-02 用户口径〕地板分两档。用户原话：「**不开启防封，大概0.1秒就可以了…不开启防封，默认的兜底策略，
  //   要时间控制的很短；开启了之后保持当下**」。一手实测支撑这个数：满地 64 块，真人拖一遍 3–5 秒，
  //   而写地板 300ms 时 64 块最快也要 ~19 秒（还没算每发往返）；降到 100ms ⇒ 64 块 ≈ 6.4 秒，落在同一量级。
  //   ⚠️ 「开启了之后保持当下」是硬约束：开着时那一档仍 300/60ms，本改动一格未碰。
  //   ⚠️ 这两个数是 **clamp 下界**（客户自己填数时才拦得住），**不是实际停顿值**：没有显式覆盖时
  //   `clampPair` 取的是档位表那一对（均衡＝读 180／写 900）。屏上要说"最快多久"必须报档位值，
  //   报这两个下界就是假话——10-02 用户当面抓到 `schema.js` 那句「动手操作最快 0.3 秒」而真判据是 0.9 秒。
  const limitsOn = overrides.limitsEnabled !== false;
  return Object.freeze({
    ...merged,
    limitsEnabled: limitsOn,
    readGapMs: clampPair(overrides.readGapMs, preset.readGapMs, { min: GAP_FLOOR_MS.read(limitsOn), max: 60000 }),
    writeGapMs: clampPair(overrides.writeGapMs, preset.writeGapMs, { min: GAP_FLOOR_MS.write(limitsOn), max: 120000 }),
    sameTargetWindowMs: clampPair(overrides.sameTargetWindowMs, [preset.sameTargetWindowMs], { min: 0, max: 3600000 })[0],
    burstEvery: clampPair(overrides.burstEvery, preset.burstEvery, { min: 1, max: 500 }),
    burstPauseMs: clampPair(overrides.burstPauseMs, preset.burstPauseMs, { min: 0, max: 3600000 }),
    sessionMaxMs: clampPair(overrides.sessionMaxMs, preset.sessionMaxMs, { min: 60000, max: 86400000 }),
    sessionRestMs: clampPair(overrides.sessionRestMs, preset.sessionRestMs, { min: 0, max: 86400000 }),
    dailySleepHours: clampPair(overrides.dailySleepHours, preset.dailySleepHours, { min: 0, max: 16 }),
    // 上限 720：起点带最宽 12 小时，再宽就等于把「深夜睡」放宽回「全天随机」。
    sleepStartBandMinutes: clampPair(overrides.sleepStartBandMinutes, preset.sleepStartBandMinutes, { min: 0, max: 720 }),
    maxWritesPerHour: positiveInteger(merged.maxWritesPerHour, preset.maxWritesPerHour, 1),
    maxWritesPerDay: positiveInteger(merged.maxWritesPerDay, preset.maxWritesPerDay, 1),
    maxActionsPerMinute: positiveInteger(merged.maxActionsPerMinute, preset.maxActionsPerMinute, 1),
    maxConsecutiveFailures: positiveInteger(merged.maxConsecutiveFailures, preset.maxConsecutiveFailures, 1),
    errorRateWindow: positiveInteger(merged.errorRateWindow, preset.errorRateWindow, 5),
    errorRateLimit: (() => {
      const parsed = Number(merged.errorRateLimit);
      const base = Number.isFinite(parsed) ? parsed : preset.errorRateLimit;
      return Math.min(0.95, Math.max(0.05, base));
    })(),
    breakerMs: positiveInteger(merged.breakerMs, preset.breakerMs, 60000),
    // 〔10-02 用户令「不能说设置关了，你后台还在强行等待」〕**熔断时长分两种来历，只有这一种跟着总开关走**：
    //   · `breakerMs`（今天 15 分钟）＝**官方侧说我们"别硬闯"时**用的：被踢、维护、会话过期、封号
    //     （`FATAL_ERROR_CODES`/`FATAL_REMOTE_CODES`/`fatal` 旗标）。这一条**任何档位都不缩短**——
    //     它是铁律 9 §C 里"别人砌的墙"，不是我们替客户决定的保守。
    //   · `breakerLocalMs`＝**我们自己数出来的失败**（连吃 N 次普通失败 / 最近 20 发错误率过线）之后冻多久。
    //     页面从头到尾没有这一格（连只读说明都没有），却一冻 15 分钟 ⇒ 铁律 16 的形状。
    //     关着总开关时压到本文件早就声明过的最短熔断下界 60 秒（`positiveInteger(..., 60000)` 那同一把尺），
    //     开着时逐字等于 `breakerMs`（**零漂移**：客户没关任何东西，行为一律不变）。
    breakerLocalMs: (() => {
      const full = positiveInteger(merged.breakerMs, preset.breakerMs, 60000);
      return limitsOn ? full : Math.min(full, 60000);
    })(),
    reloginMinIntervalMs: positiveInteger(merged.reloginMinIntervalMs, preset.reloginMinIntervalMs, 30000),
  });
}

/** 默认随机源可替换：测试要确定性，生产要跨进程不相关。 */
export function createHumanRandom(seed = Date.now()) {
  let state = (Number(seed) >>> 0) || 0x9e3779b9;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
}

/** 区间内抽样，偏向低端但长尾自然（类似真人点击间隔的对数正态形状）。 */
export function sampleRange([low, high], random = Math.random) {
  const min = Math.min(low, high);
  const max = Math.max(low, high);
  if (max <= min) return min;
  const skewed = (2 * random() - 1) ** 3;
  const normalized = (skewed + 1) / 2;
  return Math.round(min + (max - min) * normalized);
}

/** 本地日键（与 guard 账本里的 day 字段同一算法）；[L14 批2c] 供面板回退读数判新鲜。 */
export function localDayKey(dateLike) {
  const date = new Date(dateLike);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function minutesOfDay(dateLike) {
  const date = new Date(dateLike);
  return date.getHours() * 60 + date.getMinutes();
}

function emptyCounters(nowMs) {
  return {
    day: localDayKey(nowMs),
    writes: 0,
    reads: 0,
    actions: 0,
    sinceMs: nowMs,
    writesSinceHour: 0,
    hourSinceMs: nowMs,
    actionsSinceMinute: 0,
    minuteSinceMs: nowMs,
    consecutiveFailures: 0,
    outcomes: [],
    breakerUntilMs: 0,
    breakerReason: null,
    onlineMs: 0,
    sessionSinceMs: 0,
    lastActionMs: 0,
    lastReloginMs: 0,
    reloginHoldUntilMs: 0,
    reloginHoldReason: null,
    // [第109件·补 2026-10-03 用户令「在日志里显示被封禁了多久」] 只存"到什么时候"算不出时长——
    // 必须同时存**这一轮是从什么时候开始的**，登回的那一刻才能结算出真实窗口（起→止→N 分钟）。
    // 同一轮里被多次延长（官方连着拒几次）时起点不动，只推终点：那才是"从第一次被拦到现在"。
    reloginHoldStartedAtMs: 0,
    // 官方在参数槽里说的那个"多久"（毫秒）；0＝它没说 ⇒ 屏上不许出现"官方说 N 分钟"那种话。
    reloginHoldOfficialMs: 0,
    sleepStartMinute: null,
    sleepEndMinute: null,
    lastTargetMs: {},
    actionsSinceBurst: 0,
    burstThreshold: null,
    pendingBurstReset: false,
  };
}

/**
 * 排程种子：一切按「身份+自然日」派生作息的调用方共用的唯一摘要。
 * 账本落盘、guard 内部、realRestHoldFor、面板值守读数必须全走这里——
 * 各算各的会出现「闸门说睡到 10:07、面板说 07:14」两只表（09-14 实录）。
 */
export function pacingSeed(identity = "") {
  return crypto.createHash("sha256").update(String(identity), "utf8").digest("hex").slice(0, 16);
}

/**
 * [L14 值守排程·批2a] 把 guard 快照折成面板可读的「值守状态」——唯一出口：
 * 任何界面要说「几点睡、几点醒、今天干了多久」只能读这里，不得自己再算第二块表。
 * snapshot 取 guard.snapshot()/pacer.snapshot() 的返回；产出全部为纯数据＋一句人话。
 * 两个文本字段分工（2026-09-17 起）：
 *   textZh    ——**发给客户的那一份**，只有客户能用的信息（几点睡/几点醒/今日在线多久/下次上线等待）；
 *   opsTextZh ——运营那一份（textZh + 「写入 N/M 次」这个内部额度量纲），只许管理端与日志读。
 */
export function dutyViewFromSnapshot(snapshot, nowMs = Date.now()) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const s = snapshot.schedule || null;
  const hhmm = (ms) => (Number.isFinite(Number(ms))
    ? new Date(Number(ms)).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })
    : null);
  const sleepingNow = Boolean(s && s.sleepingNow);
  const wakeAt = s && sleepingNow ? hhmm(s.wakeAtMs) : null;
  const nextSleep = s && !sleepingNow ? hhmm(s.nextSleepAtMs ?? s.nextSleepStartMs) : null;
  const nextWake = s && !sleepingNow ? hhmm(s.nextWakeAtMs) : null;
  // 「今日/明天」按日期说人话：傍晚时窗在次日凌晨，报「今日 00:21」就是假话（16:39 实读抓到）。
  const dayOf = (ms) => { const d = new Date(Number(ms)); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
  const dayLabel = (ms) => (Number.isFinite(Number(ms)) && dayOf(ms) === dayOf(Number(nowMs) || Date.now()) ? "今日" : "明天");
  const sleepWord = s && !sleepingNow ? dayLabel(s.nextSleepAtMs ?? s.nextSleepStartMs) : "";
  const wakeWord = s && sleepingNow ? dayLabel(s.wakeAtMs) : "";
  const onlineMinutes = Math.round(Number(snapshot.dailyOnlineMinutes ?? snapshot.onlineMinutes ?? 0) || 0);
  const writes = Number(snapshot.writes ?? 0) || 0;
  const writesLimit = Number(snapshot.writesLimit ?? 0) || 0;
  // 客户那一份与运营那一份从这里分家（2026-09-17，用户实屏口径「整个手机端都不要有不应该给客户看的东西」）：
  //   · textZh    = 只留客户能用的信息：几点睡、几点醒、今日在线多少分钟、下次上线的等待；
  //   · opsTextZh = 客户那份 + 内部额度量纲「写入 N/M 次」（管理端/日志要这份量纲时才读它）。
  // 为什么分开：额度量纲（900/3000）是我们自己的风控闸门刻度，客户拿它既看不懂也没法用，
  // 印在他手机上只会引出一句「这 3000 是什么」。writesToday / writesLimit 两个数字字段原样保留，
  // 管理端要量纲读字段、要整句读 opsTextZh——**现有读法（textZh 进客户屏）一个字都不用改**。
  let textZh;
  if (!s || (!s.sleepingNow && !s.nextSleepStartMs)) {
    textZh = "未设每日休息时段：账号会 24 小时不下线（不建议）";
  } else if (sleepingNow) {
    textZh = `正在每日休息，${wakeWord === "明天" ? "明天" : ""}${wakeAt} 自动上线继续任务`;
  } else {
    textZh = `${sleepWord} ${nextSleep} 前后自动下线休息，约 ${nextWake} 自动上线继续任务`;
  }
  textZh += `；今日已在线 ${onlineMinutes} 分钟`;
  // [开发态总闸·09-21] 开着闸时，加速态那一行**只进 opsTextZh**（管理端与日志读它）。
  // ⛔ 硬闸：`textZh` 是客户面，**永远不许**出现「开发加速态」——服务端在这里就分好，
  //    不指望调用方记得挑字段（`test:duty-unthrottle` 有一半判据专钉这条）。
  const devNotice = describeDevUnthrottle();
  const opsTextZh = `${textZh}、写入 ${writes}${writesLimit ? `/${writesLimit}` : ""} 次`
    + (devNotice ? `（${devNotice}）` : "");
  return {
    sleepingNow,
    wakeAtMs: s && sleepingNow ? s.wakeAtMs : null,
    nextSleepAtMs: s && !sleepingNow ? s.nextSleepStartMs : null,
    nextWakeAtMs: s && !sleepingNow ? s.nextWakeAtMs : null,
    onlineMinutes,
    writesToday: writes,
    writesLimit,
    textZh,
    opsTextZh,
    // 单独一格给管理端/日志按字段读（客户面 DTO 不许带它，见上面那条硬闸）。
    devUnthrottle: devNotice,
    atMs: Number(nowMs) || 0,
  };
}

/**
 * [L14 批2c] 账本 → 值守读数的纯核心（面板回退用；api-user 只留文件读取的胶水，
 * 这样这段能进离线测试——api-user 带库解密副作用，测试链不碰）。
 * state＝拟人账本 JSON；policy＝该账号执行策略；seedIdentity＝pacingSeed(锁身份)。
 */
export function dutyViewFromLedger(state, policy, nowMs = Date.now(), { seedIdentity = "" } = {}) {
  if (!state || typeof state !== "object" || !policy) return null;
  const freshDay = state.day === localDayKey(nowMs);
  const schedule = nextRestSchedule({ identity: seedIdentity, policy, nowMs });
  return dutyViewFromSnapshot({
    dailyOnlineMinutes: freshDay ? (Number(state.onlineMs) || 0) / 60000 : 0,
    writes: freshDay ? (Number(state.writes) || 0) : 0,
    writesLimit: policy.limitsEnabled === false ? null : (Number(policy.maxWritesPerDay) || 0),
    schedule,
  }, nowMs);
}

/**
 * 睡眠窗口：按「账号身份摘要 + 自然日」派生，保证同一天稳定、隔天自然漂移，
 * 不会出现每天同一分钟下线的机器人特征。
 */
export function dailySleepWindow({ identity = "", dayKey, hours, startBand = SLEEP_START_BAND_DEFAULT }) {
  const [minHours, maxHours] = hours;
  if (!(maxHours > 0)) return null;
  let hash = 2166136261;
  const text = `${identity}|${dayKey}`;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const spanHours = maxHours - minHours;
  const lengthMinutes = Math.round((minHours + (spanHours > 0 ? (hash % 1000) / 1000 * spanHours : 0)) * 60);
  // 起点只在「深夜带」内抽，不再从全天 1440 分钟里抽；带内仍按身份+日期漂移，
  // 所以既不会把觉睡到傍晚，也不会出现「所有号同一分钟集体下线」的机器人特征。
  const band = Array.isArray(startBand) && startBand.length === 2 ? startBand : SLEEP_START_BAND_DEFAULT;
  const bandLow = Number(band[0]) || 0;
  const bandSpan = Math.max(0, (Number(band[1]) || 0) - bandLow);
  const startMinutes = (bandLow + ((hash >>> 10) % (bandSpan + 1))) % 1440;
  return { startMinutes, endMinutes: (startMinutes + lengthMinutes) % 1440, lengthMinutes };
}

/**
 * 只读回答「现在是不是在每日休息时段里、下一次几点睡、几点醒」，不创建 guard、不写账本。
 *
 * 为什么要它（2026-09-10 实服 run 53）：17:41:42「正在登录游戏」→ 连上世界 →
 * 第一条 usr.lazySync 被睡眠窗拦下 → 17:41:44 会话关闭。**一次真实登录什么都没换来**。
 * 2026-09-11 这条更明显：00:00:44 复工、00:05 就又睡下到 08:51——不为几分钟在线登一次录，
 * 正是本文件开头列的机器特征「每天 24 小时无休」的反面兄弟：作息碎片化。
 *
 * 与 HumanRiskGuard 同源是硬要求：同一个身份摘要 + 同一个自然日 + 同一条策略 + 同一个
 * `dailySleepWindow()`，否则会出现「闸门说醒着、这里说睡着」这种互相矛盾的判据。
 * 唯一允许的差别是：guard 当天把窗口缓存在账本里（改配置当天不生效），这里按当前策略重算。
 */
export function nextRestSchedule({ identity = "", policy = null, nowMs = Date.now() } = {}) {
  const activePolicy = policy || createHumanPolicy();
  const empty = {
    sleepingNow: false, wakeAtMs: null, nextSleepStartMs: null, nextWakeAtMs: null, awakeMs: null,
  };
  const [lowHours, highHours] = activePolicy.dailySleepHours || [0, 0];
  if (!(highHours > 0)) return empty;
  const digest = String(identity || "");
  // 种子直传（不再二次哈希）：与 HumanRiskGuard 的 dailySleepWindow 调用逐字同种子——
  // 09-14 晨读账本实测：双哈希会得出两只不同的表（我按默认盘算 07:14、worker 真拦到 10:07 的同源解释）。
  // 约定：identity 参数一律收「排程种子」=pacingSeed(原始身份)（账本里存的 identity 已是种子，直传即可）。
  // [第22件·2026-09-23] 睡窗被关掉时（总开关关 ⇒ dailySleepHours=[0,0]）**显式**返回"没有觉"：
  // 以前这一支会走到 `dailySleepWindow()` 回 null、再在下面解引用时抛错，靠调用方的 try/catch 兜住——
  // 「靠异常兜住」不算判据，这里写死（守卫 `test:pacing-master` 判据④ 就钉这一支）。
  if (!(Number(activePolicy.dailySleepHours?.[1]) > 0)) {
    return { sleepingNow: false, wakeAtMs: null, nextSleepStartMs: null, nextWakeAtMs: null, awakeMs: null };
  }
  const dayMs = 86400000;
  const base = new Date(nowMs);
  base.setHours(0, 0, 0, 0);
  // 从「昨天」开始扫：跨零点的觉（起点带被人配到傍晚之后才可能）也要判得出来。
  let current = null;
  let upcoming = null;
  for (let offset = -1; offset <= 2; offset += 1) {
    const dayStart = base.getTime() + offset * dayMs;
    if (dayStart < 0) continue;
    const window = dailySleepWindow({
      identity: digest,
      dayKey: localDayKey(dayStart),
      hours: activePolicy.dailySleepHours,
      startBand: activePolicy.sleepStartBandMinutes,
    });
    const sleepStartMs = dayStart + window.startMinutes * 60000;
    const sleepEndMs = sleepStartMs + window.lengthMinutes * 60000;
    if (!current && nowMs >= sleepStartMs && nowMs < sleepEndMs) current = { start: sleepStartMs, end: sleepEndMs };
    if (!upcoming && sleepStartMs > nowMs) upcoming = { start: sleepStartMs, end: sleepEndMs };
    if (current && upcoming) break;
  }
  return {
    sleepingNow: Boolean(current),
    wakeAtMs: current ? current.end : null,
    nextSleepStartMs: upcoming ? upcoming.start : null,
    nextWakeAtMs: upcoming ? upcoming.end : null,
    awakeMs: upcoming ? upcoming.start - nowMs : null,
  };
}

function inSleepWindow(window, nowMs) {
  if (!window) return false;
  const minute = minutesOfDay(nowMs);
  const { startMinutes, endMinutes } = window;
  if (startMinutes === endMinutes) return true;
  return startMinutes < endMinutes
    ? minute >= startMinutes && minute < endMinutes
    : minute >= startMinutes || minute < endMinutes;
}

/** 日额度的账面：只报形态与数字，供日志与面板说清「今天还剩多少写」。 */
function dailyBudget(kind, used, limit) {
  return Object.freeze({ kind, used, limit, remaining: Math.max(0, limit - used) });
}

/** 让计数器按小时/分钟窗口滚动。 */
function roll(state, nowMs, policy) {
  const day = localDayKey(nowMs);
  if (state.day !== day) {
    Object.assign(state, emptyCounters(nowMs), {
      breakerUntilMs: state.breakerUntilMs || 0,
      breakerReason: state.breakerReason || null,
      lastReloginMs: state.lastReloginMs || 0,
      reloginHoldUntilMs: state.reloginHoldUntilMs || 0,
      reloginHoldReason: state.reloginHoldReason || null,
    });
    state.sleepStartMinute = null;
  }
  if (state.sleepStartMinute === null) {
      const window = dailySleepWindow({
        identity: state.identity,
        dayKey: day,
        hours: policy.dailySleepHours,
        startBand: policy.sleepStartBandMinutes,
      });
    if (window) {
      state.sleepStartMinute = window.startMinutes;
      state.sleepEndMinute = window.endMinutes;
    } else {
      state.sleepStartMinute = -1;
    }
  }
  if (nowMs - state.hourSinceMs >= 3600000) { state.hourSinceMs = nowMs; state.writesSinceHour = 0; }
  if (nowMs - state.minuteSinceMs >= 60000) { state.minuteSinceMs = nowMs; state.actionsSinceMinute = 0; }
  // 〔第174件·真号现读抓到的自锁〕那本「最近 N 次成没成」的账**只在真的发出去过东西之后**才往里添条目，
  //   所以**冷却等满**就是它该作废的时刻——不是"条目过期"，是"这一笔罚已经罚完了"。
  //   病根（一手读数，号 28，10-14）：账里 20 条有 9 条是 0，全来自更早那几趟被顶号打回来的真实失败；
  //   此后闸门一条都不让发 ⇒ 永远补不进 1 ⇒ 错误率永远 ≥ 线 ⇒ 每次登录成功后的第一读就被自己的熔断拦下，
  //   号在这一整天里再也干不了活（08:06 那一轮跑得好好的，之后每次起来都停在同一形状）。
  //   ⚠️ 两条边界（都有反例钉在测试里）：
  //   · 冷却期间又吃了新的失败 ⇒ `recordOutcome` 当场把冷却重新点着，于是"等满"还没到，一条都不清；
  //   · 官方侧那种信号（被踢/维护/封号那一族）走 `breakerMs` 那一档，本条**只等满自己那档，一秒都不缩短它**。
  if (state.breakerUntilMs > 0 && nowMs >= state.breakerUntilMs) {
    state.outcomes = [];
    state.consecutiveFailures = 0;
    state.breakerUntilMs = 0;
    state.breakerReason = null;
  }
  if (state.lastActionMs && nowMs - state.lastActionMs > 120000) {
    // 超过 2 分钟不动就算「这一段人下线了」，不再累计在线时长。
    state.sessionSinceMs = 0;
  }
  if (state.lastActionMs) state.onlineMs += Math.min(nowMs - state.lastActionMs, 60000);
  const trackedTargets = Object.keys(state.lastTargetMs || {});
  if (trackedTargets.length > 400) {
    for (const key of trackedTargets) {
      if (nowMs - (state.lastTargetMs[key] || 0) > 3600000) delete state.lastTargetMs[key];
    }
  }
  return state;
}

function sleepWindowOf(state) {
  if (state.sleepStartMinute === null || state.sleepStartMinute < 0) return null;
  return { startMinutes: state.sleepStartMinute, endMinutes: state.sleepEndMinute };
}

export function minutesUntilWindowEnd(state, nowMs) {
  const window = sleepWindowOf(state);
  if (!window) return 0;
  const minute = minutesOfDay(nowMs);
  const delta = (value) => (value - minute + 1440) % 1440;
  return delta(window.endMinutes);
}

/**
 * 纯状态机：所有决定都是「允许 / 等待多久 / 拒绝并给原因」，不直接操作时间。
 * 用法：`const verdict = guard.evaluate({ nowMs, kind, method, targetKey })`。
 */
export class HumanRiskGuard {
  constructor({ identity = "default", policy = createHumanPolicy(), random = Math.random, now = () => Date.now(), state } = {}) {
    this.identity = String(identity);
    this.policy = policy;
    this.random = random;
    this.now = now;
    this.state = { ...emptyCounters(now()), identity: this.identity, ...(state || {}) };
    this.state.identity = this.identity;
  }

  /**
   * [第45件 B 块·§4.2.4] 整份换策略引用的唯一接缝（策略对象是 frozen 的，逐字段改＝漏键的旧病）。
   * 只换读的那把尺：账本 state、种子、随机源、熔断计数一律不动——09-14「两只表」的教训是同一块表，
   * 这里动的不是表本身。每轮由 `real-harvest-runner.js` 在现读配置后经适配器调用（写闸每笔现读那条链一字不动）。
   */
  updatePolicy(nextPolicy) {
    if (!nextPolicy || typeof nextPolicy !== "object") return false;
    this.policy = nextPolicy;
    return true;
  }

  /**
   * [第45件 B 块·§4.2.4] 整份换策略引用的唯一接缝（策略对象是 frozen 的，逐字段改＝漏键的旧病）。
   * 只换读的那把尺：账本 state、种子、随机源、熔断计数一律不动——09-14「两只表」的教训是同一块表，
   * 这里动的不是表本身。每轮由 `real-harvest-runner.js` 在现读配置后调用（写闸每笔现读那条链一字不动）。
   */
  updatePolicy(nextPolicy) {
    if (!nextPolicy || typeof nextPolicy !== "object") return false;
    this.policy = nextPolicy;
    return true;
  }

  /**
   * 日额度用尽后的恢复时间：到下一个本地 0 点，再加 0-4 分钟抖动（真人不会卡在 00:00:00 复工）。
   * Worker 拿到有限的 retryAfterMs 就会走「退回队列 + resume_at + 到点自动晋升」这条既有通道，
   * 期间状态是 queued 且 ready_at 为空，不产生任何计费。
   */
  #dailyCapResumeMs(nowMs) {
    const jitterMs = Math.round(this.random() * 240000);
    return Math.max(60000, nextLocalDayBoundaryMs(nowMs) - nowMs + jitterMs);
  }

  evaluate({ nowMs = this.now(), kind = "read", method = "", targetKey = "" } = {}) {
    const state = roll(this.state, nowMs, this.policy);
    const isWrite = kind === "write";
    if (state.breakerUntilMs > nowMs) {
      // 〔第174件·铁律 13 第 1 条〕这一句要上客户屏，所以把"是谁说的、当时的数"一起带出去：
      //   旧写法一律说「服务器返回异常信号」，而 `error-rate`／`consecutive-failures` 这两档**是咱们自己数出来的**，
      //   把自设的计数挂到服务器名下＝对客户撒谎（真号现读：号 28 这一整天停在这一档，屏上一直指着服务器）。
      return {
        allowed: false,
        waitMs: 0,
        reason: "risk-breaker",
        retryAfterMs: state.breakerUntilMs - nowMs,
        breakerReason: state.breakerReason || null,
        windowCount: Array.isArray(state.outcomes) ? state.outcomes.length : 0,
        windowFailures: Array.isArray(state.outcomes) ? state.outcomes.filter((entry) => entry === 0).length : 0,
      };
    }
    // [第22件·2026-09-23] 总开关关着 ⇒ **额度与休息整段跳过**（只留动作最小间隔与熔断）。
    const limitsOn = this.policy.limitsEnabled !== false;
    const sleepWindow = limitsOn ? sleepWindowOf(state) : null;
    if (sleepWindow && inSleepWindow(sleepWindow, nowMs)) {
      return {
        allowed: false,
        waitMs: 0,
        reason: "daily-sleep-window",
        retryAfterMs: minutesUntilWindowEnd(state, nowMs) * 60000,
      };
    }
    if (limitsOn && isWrite && state.writes >= this.policy.maxWritesPerDay) {
      return {
        allowed: false,
        waitMs: 0,
        reason: "daily-write-cap",
        retryAfterMs: this.#dailyCapResumeMs(nowMs),
        budget: dailyBudget("writes", state.writes, this.policy.maxWritesPerDay),
      };
    }
    if (limitsOn && isWrite && state.writesSinceHour >= this.policy.maxWritesPerHour) {
      return { allowed: false, waitMs: 0, reason: "hourly-write-cap", retryAfterMs: 3600000 - (nowMs - state.hourSinceMs) };
    }
    if (limitsOn && state.actionsSinceMinute >= this.policy.maxActionsPerMinute) {
      return { allowed: false, waitMs: 60000 - (nowMs - state.minuteSinceMs), reason: "per-minute-action-cap" };
    }
    // 〔10-02 铁律 16〕这里原来还有**第二道**每分钟闸：`maxReadsPerMinute`（保守 40／均衡 60／激进 120）。
    //   它管的东西页面上**已经有那一格了**——「每分钟动作上限」，而 `commit()` 里
    //   `state.actionsSinceMinute += 1` 是**无条件**自增的（读也计数），所以那一格从来就管着读操作。
    //   三档逐个对过：18<40、30<60、60<120 —— 可见那一格**每一档都更严** ⇒ 这道暗闸一次都没真正拦过东西，
    //   它唯一的作用是让客户看不见的那个数藏在人话那格的影子里。按「页面上摸不到的限制不该存在」删除。
    //   ⚠️ 反向钉在 `tests/human-pacing.mjs`：读操作必须仍被「每分钟动作上限」拦住（一格管一次，不是没人管）。
    // 〔第146件 M2〕两把尺分家（zcode 单 S2）：**这一把只管「同一目标 90 秒冷却」**——归「操作节奏」那一族，
    //   总开关关着就不挡（客户不要我们自设的等待窗）。而「同目标有一条写在飞、还没收口 ⇒ 绝不发第二条」
    //   是另一条**常开底线**，落在下面 `HumanPacer` 的 in-flight 账本上（不受 limitsEnabled 影响）：
    //   重复发一条没收口的写碰的是「写后不重发」红线——那是安全，不是节奏（铁律 9 §C 的命门分界）。
    const targetStamp = targetKey ? state.lastTargetMs[targetKey] : undefined;
    if (limitsOn && isWrite && this.policy.sameTargetWindowMs > 0 && targetStamp && nowMs - targetStamp < this.policy.sameTargetWindowMs) {
      return {
        allowed: false,
        waitMs: 0,
        reason: "same-target-cooldown",
        retryAfterMs: this.policy.sameTargetWindowMs - (nowMs - targetStamp),
      };
    }
    if (state.lastActionMs) {
      const gap = nowMs - state.lastActionMs;
      const [floorMs] = isWrite ? this.policy.writeGapMs : this.policy.readGapMs;
      if (gap < floorMs) {
        return { allowed: false, waitMs: floorMs - gap, reason: "min-gap" };
      }
    }
    if (limitsOn && this.policy.dailyMaxOnlineMinutes > 0
      && state.onlineMs >= this.policy.dailyMaxOnlineMinutes * 60000) {
      return {
        allowed: false,
        waitMs: 0,
        reason: "daily-online-cap",
        retryAfterMs: this.#dailyCapResumeMs(nowMs),
        budget: dailyBudget("onlineMinutes", Math.round(state.onlineMs / 60000), this.policy.dailyMaxOnlineMinutes),
      };
    }
    if (limitsOn && state.sessionSinceMs && nowMs - state.sessionSinceMs >= sampleRange(this.policy.sessionMaxMs, this.random)) {
      const [restLow, restHigh] = this.policy.sessionRestMs;
      const restMs = Math.round((restLow + (restHigh - restLow) * this.random()) / 60000) * 60000;
      if (restMs > 0) return { allowed: false, waitMs: 0, reason: "session-rest", retryAfterMs: restMs };
    }
    const waitMs = this.#nextGapMs(kind, nowMs);
    return { allowed: true, waitMs, reason: null, retryAfterMs: null };
  }

  /**
   * 只读抽样：不改变计数（pacer 等待后会再次 evaluate，两次调用必须给出一致口径）。
   * 长休息的记账放在 commit() 里，效果等价于「第 N 次动作之后先歇一会」。
   */
  #nextGapMs(kind, nowMs) {
    const state = this.state;
    const isWrite = kind === "write";
    const range = isWrite ? this.policy.writeGapMs : this.policy.readGapMs;
    let delay = sampleRange(range, this.random);
    const [burstLow, burstHigh] = this.policy.burstEvery;
    if (state.burstThreshold === null || state.burstThreshold === undefined) {
      state.burstThreshold = Math.round(burstLow + (burstHigh - burstLow) * this.random());
    }
    if (state.actionsSinceBurst >= state.burstThreshold) {
      delay += sampleRange(this.policy.burstPauseMs, this.random);
      state.pendingBurstReset = true;
    }
    if (state.lastActionMs) {
      const alreadyWaited = nowMs - state.lastActionMs;
      delay = Math.max(0, delay - alreadyWaited);
    }
    return delay;
  }

  /** 真正放行时记账；调用方在等待之后必须再 evaluate 一次以拿到最新判定。 */
  commit({ nowMs = this.now(), kind = "read", method = "", targetKey = "" } = {}) {
    const state = roll(this.state, nowMs, this.policy);
    const isWrite = kind === "write";
    state.lastActionMs = nowMs;
    if (!state.sessionSinceMs) state.sessionSinceMs = nowMs;
    state.actions += 1;
    state.actionsSinceMinute += 1;
    if (isWrite) {
      state.writes += 1;
      state.writesSinceHour += 1;
      if (targetKey) state.lastTargetMs[targetKey] = nowMs;
    } else {
      state.reads += 1;
    }
    if (state.pendingBurstReset) {
      state.actionsSinceBurst = 0;
      state.burstThreshold = null;
      state.pendingBurstReset = false;
    }
    void method;
    return state;
  }

  /**
   * 记录结果。`errorCode`/`remoteCode` 命中异常清单时立即熔断：
   * 被服务器踢、维护、会话过期这类信号出现后继续打请求，是最典型的脚本行为。
   */
  recordOutcome({ nowMs = this.now(), ok = true, errorCode, remoteCode, fatal = false } = {}) {
    const state = this.state;
    const fatalHit = fatal
      || FATAL_ERROR_CODES.includes(errorCode)
      || FATAL_REMOTE_CODES.includes(Number(remoteCode));
    state.outcomes.push(ok && !fatalHit ? 1 : 0);
    if (state.outcomes.length > this.policy.errorRateWindow) state.outcomes.shift();
    if (fatalHit) {
      state.breakerUntilMs = nowMs + this.policy.breakerMs;
      state.breakerReason = errorCode || `remote-${remoteCode}`;
      state.consecutiveFailures = 0;
      return { breaker: true, reason: state.breakerReason };
    }
    state.consecutiveFailures = ok ? 0 : state.consecutiveFailures + 1;
    if (state.consecutiveFailures >= this.policy.maxConsecutiveFailures) {
      // 「连吃 N 次普通失败」是**我们自己数出来的**，不是官方说别闯 ⇒ 走 `breakerLocalMs`（关着压到 60 秒）
      state.breakerUntilMs = nowMs + localBreakerMs(this.policy);
      state.breakerReason = "consecutive-failures";
      state.consecutiveFailures = 0;
      return { breaker: true, reason: state.breakerReason };
    }
    const failures = state.outcomes.filter((entry) => entry === 0).length;
    if (state.outcomes.length >= this.policy.errorRateWindow
      && failures / state.outcomes.length >= this.policy.errorRateLimit) {
      state.breakerUntilMs = nowMs + localBreakerMs(this.policy);
      state.breakerReason = "error-rate";
      return { breaker: true, reason: state.breakerReason };
    }
    return { breaker: false, reason: null };
  }

  /**
   * 回滚上一次 noteRelogin（把 lastReloginMs 写回旧值）。
   * 现场（2026-09-19 云上首用）：服务器缺设备档案那一次，登录请求**根本没构造出来**
   * （日志逐字「未消耗任何登录机会」），却占掉了 5 分钟的重登间隔 ⇒ 用户改好配置再点一次，
   * 被自己的闸门拦住。**本机拒绝不消耗节奏**——与「本地拒绝不许记成服务器拒绝」同一条原则。
   * ⚠️ 只给「压根没发出去」那一类失败用（isServerSetupFailure）；发出去过的失败一律不还。
   */
  restoreRelogin(previousMs) {
    const state = this.state;
    state.lastReloginMs = Math.max(0, Number(previousMs) || 0);
    return { restored: state.lastReloginMs };
  }

  noteRelogin({ nowMs = this.now() } = {}) {
    const state = this.state;
    // 官方明确判定「这个号/这台设备/这个 IP 不能再试了」时，冻结期优先于普通重登间隔。
    // 冻结写进账本，因此跨进程、跨重启都有效 —— 这正是防止有人反复点启动去撞风控的关键。
    // [开发态总闸·09-21] 开了 `GARDEN_DEV_UNTHROTTLE` 时**跳过这道账本 hold**（冻结期最长 7 天，
    // 是开发期最贵的等待）。⚠️ 只跳过"我们给自己上的锁"，**官方那条拒绝本身照旧算数**：
    // 号被官方判了就是判了，跳过 hold 只是让我们能立刻再试一次、而不是 7 天后再试。
    const holdSkipped = this.policy?.devUnthrottle === true;
    if (!holdSkipped && state.reloginHoldUntilMs > nowMs) {
      return {
        allowed: false,
        held: true,
        holdReason: state.reloginHoldReason || "login-outcome",
        retryAfterMs: state.reloginHoldUntilMs - nowMs,
      };
    }
    const since = state.lastReloginMs ? nowMs - state.lastReloginMs : Infinity;
    if (since < this.policy.reloginMinIntervalMs) {
      return { allowed: false, retryAfterMs: this.policy.reloginMinIntervalMs - since };
    }
    const previousMs = Number(state.lastReloginMs) || 0;
    state.lastReloginMs = nowMs;
    state.sessionSinceMs = 0;
    state.onlineMs = 0;
    // `previousMs` 是**改之前**的值：调用方发现「这一趟压根没发出去」时要能还回来
    // （见 `restoreRelogin` 与 real-adapter 里那段注释）。
    return { allowed: true, retryAfterMs: 0, previousMs };
  }

  /**
   * 依据官方登录结论冻结重登。reason 只接受稳定的枚举名，不写任何响应内容。
   */
  holdRelogin({ holdMs = 0, reason = "login-outcome", officialMs = null, nowMs = this.now() } = {}) {
    const ms = Number(holdMs);
    if (!Number.isFinite(ms) || ms <= 0) return { held: false, retryAfterMs: 0 };
    const until = nowMs + Math.min(Math.round(ms), 7 * 24 * 3600 * 1000);
    const previousUntil = Number(this.state.reloginHoldUntilMs) || 0;
    this.state.reloginHoldUntilMs = Math.max(previousUntil, until);
    this.state.reloginHoldReason = String(reason).slice(0, 40);
    // [第109件·补2] 官方在参数槽里说了多久，就把"官方说的那个数"一起记下来——
    // 屏上那句要分清「官方说封禁 5 分钟」与「我们自己等到 11:32 才登上」，两件事不能揉成一句。
    const official = Number(officialMs);
    this.state.reloginHoldOfficialMs = Number.isFinite(official) && official > 0 ? Math.round(official) : 0;
    // 起点＝**第一次**被拦的那一刻（已有起点就不动，延长只推终点）。没有这一格，
    // 「被封了多久」就只能靠人去翻日志（用户 10-03 点名的就是这一句）。
    if (!(Number(this.state.reloginHoldStartedAtMs) > 0) || previousUntil <= nowMs) {
      this.state.reloginHoldStartedAtMs = nowMs;
    }
    return {
      held: true,
      retryAfterMs: this.state.reloginHoldUntilMs - nowMs,
      startedAtMs: this.state.reloginHoldStartedAtMs,
    };
  }

  /**
   * 登回之后结算这一轮被拦的窗口：返回 `{startedAtMs, endedAtMs, minutes, reason}` 并清空三格。
   * 没在冻结中（或账本里压根没有起点）⇒ 回 null，调用方一个字都不许编。
   * `endedAtMs` 用的是**这次成功登录的时刻**：官方没说它什么时候放行，只有"这一次登上了"是事实。
   */
  releaseReloginHold({ nowMs = this.now() } = {}) {
    const started = Number(this.state.reloginHoldStartedAtMs) || 0;
    const until = Number(this.state.reloginHoldUntilMs) || 0;
    // 原因要在清空**之前**取（清空之后再读就是 null，那一行日志会丢掉"为什么被拦"）。
    const reason = typeof this.state.reloginHoldReason === "string" && this.state.reloginHoldReason
      ? this.state.reloginHoldReason : null;
    const officialMs = Number(this.state.reloginHoldOfficialMs) || 0;
    this.state.reloginHoldStartedAtMs = 0;
    this.state.reloginHoldUntilMs = 0;
    this.state.reloginHoldReason = null;
    this.state.reloginHoldOfficialMs = 0;
    if (!started) return null;
    return {
      startedAtMs: started,
      endedAtMs: nowMs,
      minutes: Math.max(1, Math.round((nowMs - started) / 60000)),
      reason,
      heldUntilMs: until || null,
      // 官方说了多久才有这一格（分钟）；没说就是 null——调用方那句会换成"我们等到"的措辞。
      officialMinutes: officialMs > 0 ? Math.max(1, Math.round(officialMs / 60000)) : null,
    };
  }

  resetSession({ nowMs = this.now() } = {}) {
    this.state.sessionSinceMs = 0;
    this.state.onlineMs = 0;
    void nowMs;
  }

  snapshot({ nowMs = this.now() } = {}) {
    const state = this.state;
    return {
      preset: this.policy.preset,
      day: state.day,
      writes: state.writes,
      // [第22件] 总开关关着时**没有上限**这一回事：如实报 null（屏上显示"不限次数"），
      // 不许把一个不生效的数字当成上限摆出去（铁律 8：读到的与没生效的分开说）。
      writesLimit: this.policy.limitsEnabled === false ? null : this.policy.maxWritesPerDay,
      writesRemaining: this.policy.limitsEnabled === false ? null : Math.max(0, this.policy.maxWritesPerDay - state.writes),
      reads: state.reads,
      actions: state.actions,
      onlineMinutes: Math.round(state.onlineMs / 60000),
      dailyOnlineMinutes: Math.round(state.onlineMs / 60000),
      consecutiveFailures: state.consecutiveFailures,
      breakerUntilMs: state.breakerUntilMs,
      breakerReason: state.breakerReason,
      breakerActive: state.breakerUntilMs > nowMs,
      reloginHoldUntilMs: state.reloginHoldUntilMs || 0,
      reloginHoldReason: state.reloginHoldReason || null,
      // [第109件·补] 面板/日志要算「被封了多久」，只给终点算不出来 ⇒ 起点一起带出去。
      reloginHoldStartedAtMs: state.reloginHoldStartedAtMs || 0,
      reloginHoldOfficialMs: state.reloginHoldOfficialMs || 0,
      reloginHeld: (state.reloginHoldUntilMs || 0) > nowMs,
      sleepWindow: sleepWindowOf(state),
      inSleepWindow: Boolean(sleepWindowOf(state) && inSleepWindow(sleepWindowOf(state), nowMs)),
      // [L14 值守排程·批2a] 排程真值随快照带出（同源 nextRestSchedule，不另造第二裁判）：
      // 面板/手机端只读这组数说人话，任何界面不得自己再算一只表。
      schedule: nextRestSchedule({ identity: this.identity, policy: this.policy, nowMs }),
    };
  }

  /** 给持久化用；identity 是摘要后的稳定串，不含账号原文。 */
  toJSON() {
    return { version: 1, ...this.state };
  }
}

/**
 * 〔第154件 P2-4 抽出来公用〕这一族**唯一的"等一会儿"公用件**（原来只是 `HumanPacer` 构造函数里
 * 内联的那枚默认值，语义一字未改地搬出来，别再各处自己 `new Promise(setTimeout)`）：
 *   · 停止按钮按下 ⇒ 正在等的立刻醒来并抛 `REAL_ABORTED`（不许等完剩下的秒数）；
 *   · `ms` 不是正数 ⇒ 立刻返回，一次计时都不立。
 * 使用边界：段内两次动作之间"至少隔 N 秒"这类**页面上有那一格**的等待走这里；
 * 跨轮的排程仍归 `wake-set.js` 的 `planCycleSleep`，两者不互相冒充。
 */
export function pacingWait(ms, signal) {
  return new Promise((resolve, reject) => {
    // 停止按钮按下时，正在睡觉的会话必须立刻醒来并报错，不能等完剩下的几分钟。
    if (signal?.aborted) { reject(abortError()); return; }
    if (!(ms > 0)) { resolve(); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() { clearTimeout(timer); reject(abortError()); }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/**
 * 异步外壳：把「等待」和「停止信号」处理掉，业务代码只需 `await pacer.acquire(...)`。
 */
export class HumanPacer {
  constructor({
    guard,
    identity,
    policy,
    now = () => Date.now(),
    wait = pacingWait,
    random,
    onDecision = () => {},
  } = {}) {
    this.now = now;
    this.wait = wait;
    this.onDecision = onDecision;
    this.guard = guard || new HumanRiskGuard({
      identity: identity || "default",
      policy: policy || createHumanPolicy(),
      random: random || Math.random,
      now,
    });
    // 串行化：并发的 RPC 也必须被拉开成人的间隔，而不是各自算一份间隔同时发出。
    this._tail = Promise.resolve();
    // 〔第146件 M2〕同目标 in-flight 账本（常开底线，zcode 单 S2）：一条写**发出去到收口之间**占住它的目标键，
    //   第二条碰同一把键必须等收口——这一条**不看 limitsEnabled**（红线：写后不重发，不是节奏）。
    //   key → { done, resolve }；acquire 由 `_tail` 全局串行，"查在飞→登记"之间没有 await，天然无竞态。
    //   ⚠️ 诚实账：等收口排在 `_tail` 上，会把后面的 acquire 一起垫住——整个运行器本就一条写链串行，
    //   这一等只有一个 RPC 往返的量级（秒），不引入新的并发面，也不引入新的等待常数（不是节拍器，是门闩）。
    //   收口全押在 `real-adapter.js` 的 `finally`（成功/失败/取消都 settle）；真挂了没 settle＝整条链本来也停在那一发上。
    this._inFlight = new Map();
  }

  /**
   * 取得一次「可发送」许可。返回 `{ waitMs, verdict }`；拒绝时抛错，
   * 错误码统一 REAL_RISK_*，调用方（Worker）据此停止本轮而不是重试。
   */
  /**
   * 取得一次「可发送」许可。返回 `{ waitMs, verdict }`；拒绝时抛错，错误码统一
   * `REAL_RISK_*`，调用方（Worker）据此停止本轮而不是重试。
   * 记账发生在真正放行发送的时刻，所以下一次判定看到的间隔就是实际发送间隔。
   */
  acquire(options) {
    const run = () => this.#acquire(options);
    const result = this._tail.then(run, run);
    this._tail = result.then(() => undefined, () => undefined);
    return result;
  }

    async #acquire({ kind = "read", method = "", targetKey = "", scopeKeys = [], signal, allowWait = true } = {}) {
      // 用户按停止优先于风控判定：信号已触发时直接抛取消，不再判定、不再等待。
      if (signal?.aborted) throw abortError();
      let waitedMs = 0;
      const pause = async (ms, reason) => {
        if (signal?.aborted) throw abortError();
        if (!(ms > 0) || !allowWait) return;
      this.onDecision({ level: "debug", reason, waitMs: ms, method });
      waitedMs += ms;
      await this.wait(ms, signal);
    };
    let verdict = this.guard.evaluate({ nowMs: this.now(), kind, method, targetKey });
    if (!verdict.allowed && verdict.waitMs > 0) {
      const minimumGap = verdict.reason === "min-gap";
      let beforeWait = this.now();
      await pause(minimumGap ? Math.ceil(verdict.waitMs) : verdict.waitMs, verdict.reason);
      let afterWait = this.now();
      verdict = this.guard.evaluate({ nowMs: afterWait, kind, method, targetKey });
      // 定时器可能早醒1ms：只重领同一把节奏许可，不重发RPC、不吞其它拒绝。
      // 注入wait/clock未推进时保留拒绝，避免无进展自旋；停止仍由pause优先中止。
      while (minimumGap && allowWait && !verdict.allowed && verdict.reason === "min-gap"
        && verdict.waitMs > 0 && Number.isFinite(afterWait) && afterWait > beforeWait) {
        beforeWait = afterWait;
        await pause(Math.ceil(verdict.waitMs), verdict.reason);
        afterWait = this.now();
        verdict = this.guard.evaluate({ nowMs: afterWait, kind, method, targetKey });
      }
    }
    if (!verdict.allowed) {
      this.onDecision({ level: "warn", reason: verdict.reason, method, rejected: true });
      throw riskError(verdict);
    }
    await pause(verdict.waitMs, "gap");
    // 〔第146件 M2〕常开底线：写发出前，等同一目标（方法+参数摘要键 ∪ 地块号等"更贴的键"）在飞的那一条收口。
    //   放在 commit 之前、gap 等待之后——间隔照拟人节奏走，门闩只管"没收口就不许第二条"。
    const inFlightKeys = kind === "write"
      ? [...new Set([targetKey, ...(Array.isArray(scopeKeys) ? scopeKeys : [])].filter(Boolean).map(String))]
      : [];
    if (inFlightKeys.length > 0) {
      for (;;) {
        const holders = inFlightKeys.map((key) => this._inFlight.get(key)).filter(Boolean);
        if (holders.length === 0) break;
        if (signal?.aborted) throw abortError();
        await Promise.race(holders.map((holder) => holder.done));
      }
      for (const key of inFlightKeys) {
        let resolve = null;
        const done = new Promise((r) => { resolve = r; });
        this._inFlight.set(key, { done, resolve });
      }
    }
    this.guard.commit({ nowMs: this.now(), kind, method, targetKey });
    return { waitMs: waitedMs, gapMs: verdict.waitMs, verdict, inFlightKeys };
  }

  /**
   * 〔第146件 M2〕写收口（成功/失败/取消都算收口）：释放 in-flight 门闩。
   * 幂等——没登记过的键、重复收口都安静通过；读路径不带键＝空操作。
   */
  settleInFlight(keys) {
    for (const key of Array.isArray(keys) ? keys : []) {
      const holder = this._inFlight.get(key);
      if (!holder) continue;
      this._inFlight.delete(key);
      holder.resolve();
    }
  }

  recordOutcome(outcome) {
    return this.guard.recordOutcome({ nowMs: this.now(), ...outcome });
  }

  noteRelogin() {
    return this.guard.noteRelogin({ nowMs: this.now() });
  }

  /**
   * 把上一次 「noteRelogin()「 记下的时间戳**还回原值**。
   * 只给「登录请求压根没发出去」那一类失败用（设备档案缺失、凭据缺失这类**本机拒绝**）——
   * 那种失败官方一个字都没收到，凭什么占着重登间隔。**发出去过的失败一律不还**（那才是闸门要防的）。
   */
  restoreRelogin(previousMs) {
    return this.guard.restoreRelogin(previousMs);
  }

  /**
   * 〔第147件·2026-10-09 §3.5〕这一层是 `HumanRiskGuard.holdRelogin` 的薄包装，**曾经把 `officialMs` 丢了**：
   * 包装层形参只接 `{holdMs, reason}` ⇒ 账本里 `reloginHoldOfficialMs` 恒为 0（12 本账本现读全 0 佐证），
   * 「官方说 N 分钟」那一路（客户屏那一句的第一档）永远出不来。形参必须与 guard 那一层**逐字对齐**并原样透传。
   */
  holdRelogin({ holdMs, reason, officialMs } = {}) {
    return this.guard.holdRelogin({ holdMs, reason, officialMs, nowMs: this.now() });
  }

  // [第109件·补] 登回之后结算「这次被官方拦了多久」（用户点名要上日志）。
  releaseReloginHold() {
    return this.guard.releaseReloginHold({ nowMs: this.now() });
  }

  snapshot() {
    return this.guard.snapshot({ nowMs: this.now() });
  }
}

function abortError() {
  const error = new Error("拟人化等待被取消");
  error.code = "REAL_ABORTED";
  return error;
}

/**
 * 〔第174件〕熔断这一档上客户屏的那句话——**三种来路各说各的，谁的名字挂给谁**（铁律 13 第 1 条＋铁律 8 第 5 条）：
 *   · 官方自己发回来的信号（被踢／维护／封号那一族）⇒ 说「服务器返回异常信号」，这是事实；
 *   · `error-rate`／`consecutive-failures` ⇒ 说「这是我们自己按次数停的」并带当时的两个数，**不许挂到服务器名下**；
 *   · 来路读不出 ⇒ 也不说服务器的名字（fail-safe 方向：宁可说是我们自己停的，不把没依据的账算给别人）。
 * 句子只用玩家词，零行话零内部码（守卫：`test:settings-cycle-copy` 判据⑩ 按这张表逐条量出参）。
 */
export function breakerNoteZh(verdict = {}) {
  const reason = typeof verdict.breakerReason === "string" ? verdict.breakerReason : null;
  const count = Number(verdict.windowCount);
  const failures = Number(verdict.windowFailures);
  const hasNumbers = Number.isInteger(count) && count > 0 && Number.isInteger(failures) && failures >= 0;
  if (reason === "error-rate") {
    return "先停一会儿，稍后自己接着做（这是我们自己按次数停的，服务器没这么说："
      + (hasNumbers ? `最近 ${count} 次里有 ${failures} 次没成` : "这几次的账这会儿没读到") + "）。";
  }
  if (reason === "consecutive-failures") {
    return "先停一会儿，稍后自己接着做（这是我们自己按次数停的，服务器没这么说："
      + (Number.isInteger(failures) && failures > 0 ? `连着有 ${failures} 次没成` : "连着几次没成，这会儿数没读到") + "）。";
  }
  if (!reason) return "先停一会儿，稍后自己接着做（这一条是我们自己停的；为什么停的来路这会儿没读到）。";
  return `风控熔断中：服务器返回异常信号（${reason.slice(0, 40)}），冷却后再试。`;
}

function riskMessage(verdict) {
  switch (verdict.reason) {
    case "daily-sleep-window": return "已进入每日深夜休息时段（模拟真人下线，起点在 00:00-03:00 之间逐日漂移），这次不再向服务器发起玩法请求。";
    case "risk-breaker": return breakerNoteZh(verdict);
    case "session-rest": return "本次在线时长已达上限，先休息再续跑。";
    case "daily-online-cap": return "今日累计在线时长已达上限（拟人保护，不是账号异常），日计数器滚动后自动继续。";
    case "daily-write-cap": return "今日写操作已达上限（拟人保护，不是账号异常），日计数器滚动后自动继续，不需要再点一次启动。";
    case "hourly-write-cap": return "本小时写操作已达上限。";
    case "same-target-cooldown": return "同一目标刚操作过，冷却窗口内不重复提交。";
    case "per-minute-action-cap": return "每分钟动作数已达上限。";
    case "min-gap": return "动作间隔不足，已按拟人节奏拒绝。";
    default: return "拟人化风控闸门拒绝本次请求。";
  }
}

/** 账本：按游戏身份摘要分文件，只存计数与时间戳。 */
export function humanLedgerPath(identity, runtimeDir) {
  // 文件名一律取 sha256 前 24 位：传进来的可能是账号原文，绝不能落到磁盘文件名上。
  const digest = crypto.createHash("sha256").update(String(identity || "default"), "utf8").digest("hex").slice(0, 24);
  return path.join(path.resolve(runtimeDir), "human-pacing-" + digest + ".json");
}

export function loadHumanLedger(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function saveHumanLedger(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state), "utf8");
  fs.renameSync(temporary, file);
  return file;
}

/**
 * 只读查询某个账号身份当前是否处于「重登冻结」中。
 * 面板 API 在把任务排进队列之前先问一次，避免明知官方已经给出致命结论还去排队。
 * 这里只读账本，不创建 guard、不写盘，因此绝不会因为查询本身刷新任何计时。
 */
export function readReloginHold({ identity, runtimeDir, ledgerPath, nowMs = Date.now() } = {}) {
  if (!ledgerPath && !runtimeDir) return { held: false, reason: null, retryAfterMs: 0 };
  const file = ledgerPath || humanLedgerPath(identity || "default", runtimeDir);
  const stored = loadHumanLedger(file);
  const until = Number(stored?.reloginHoldUntilMs);
  if (!Number.isFinite(until) || until <= nowMs) return { held: false, reason: null, retryAfterMs: 0 };
  return {
    held: true,
    reason: typeof stored.reloginHoldReason === "string" ? stored.reloginHoldReason.slice(0, 40) : null,
    retryAfterMs: Math.round(until - nowMs),
  };
}
/**
 * [第109件·补 2026-10-03 用户点名「在日志里边显示被封禁了多久」]
 * 会话登上来之后结一次账：账本里若记着"这一轮被官方拦过"的起点，就把它结算成
 * `{startedAtMs, endedAtMs, minutes, reason}` 并**清空那三格**（一行只报一次）。
 * 没记过起点 ⇒ null，调用方一个字都不许编。
 * 与 `readReloginHold` 同一把尺：只读这本按账号身份摘要落盘的账，跨进程、跨重启都算得出来。
 */
export function settleReloginHoldWindow({ identity, runtimeDir, ledgerPath, nowMs = Date.now() } = {}) {
  if (!ledgerPath && !runtimeDir) return null;
  const file = ledgerPath || humanLedgerPath(identity || "default", runtimeDir);
  const stored = loadHumanLedger(file);
  const started = Number(stored?.reloginHoldStartedAtMs) || 0;
  if (!started) return null;
  const window = {
    startedAtMs: started,
    endedAtMs: nowMs,
    minutes: Math.max(1, Math.round((nowMs - started) / 60000)),
    reason: typeof stored.reloginHoldReason === "string" && stored.reloginHoldReason
      ? stored.reloginHoldReason.slice(0, 40) : null,
    heldUntilMs: Number(stored.reloginHoldUntilMs) || null,
    officialMinutes: (Number(stored.reloginHoldOfficialMs) || 0) > 0
      ? Math.max(1, Math.round(Number(stored.reloginHoldOfficialMs) / 60000)) : null,
  };
  try {
    saveHumanLedger(file, {
      ...stored,
      reloginHoldStartedAtMs: 0,
      reloginHoldUntilMs: 0,
      reloginHoldReason: null,
      reloginHoldOfficialMs: 0,
    });
  } catch {
    // 结算写不回盘也不能把这一行吞掉：窗口已经算出来了，调用方照报；
    // 只是下一次成功登录可能再报一遍——宁可重复，不可隐瞒。
  }
  return window;
}

/**
 * 生产用的常驻 pacer：账本按「账号身份摘要」落盘，所以面板重启、Worker 换进程之后
 * 仍然记得今天已经做了多少动作、是否正在熔断。防检测最怕的就是「重启即失忆」。
 *
 * 返回值仍是 HumanPacer，只是额外挂了 `ledgerPath` 与 `flush()`：
 * 调用方在会话结束、熔断、拒绝时强制落盘；正常放行时按 1.5 秒节流写。
 */
export function createPersistentPacer({
  identity = "default",
  policy,
  runtimeDir,
  ledgerPath: ledgerPathOption,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  if (!ledgerPathOption && !runtimeDir) {
    throw new TypeError("createPersistentPacer needs runtimeDir or ledgerPath");
  }
  const file = ledgerPathOption || humanLedgerPath(identity, runtimeDir);
  // 落盘身份用摘要，账本文件内容里不允许出现账号原文。（摘要算法与 realRestHoldFor/面板读数同源＝pacingSeed。）
  const guardIdentity = pacingSeed(identity);
  const stored = loadHumanLedger(file);
  const state = stored && stored.identity === guardIdentity ? stored : null;
  let lastSavedAt = 0;
  const guard = new HumanRiskGuard({
    identity: guardIdentity,
    policy: policy || createHumanPolicy(),
    now,
    state,
  });
  const flush = ({ force = true } = {}) => {
    const stamp = now();
    if (!force && stamp - lastSavedAt < 1500) return null;
    try {
      saveHumanLedger(file, guard.toJSON());
      lastSavedAt = stamp;
      return file;
    } catch (error) {
      log(`[risk] 拟人账本写入失败：${String(error?.message || error).slice(0, 120)}`);
      return null;
    }
  };
  const pacer = new HumanPacer({
    guard,
    now,
    onDecision: (decision) => { if (decision?.rejected) flush({ force: true }); },
  });
  pacer.ledgerPath = file;
  pacer.flush = () => flush({ force: true });
  const originalAcquire = pacer.acquire.bind(pacer);
  pacer.acquire = async (options) => {
    const result = await originalAcquire(options);
    flush({ force: false });
    return result;
  };
  const originalRecordOutcome = pacer.recordOutcome.bind(pacer);
  pacer.recordOutcome = (outcome) => {
    const result = originalRecordOutcome(outcome);
    if (result?.breaker) flush({ force: true });
    return result;
  };
  return pacer;
}

/**
 * 离线测试与回放用的「虚拟时钟 pacer」：等待不睡真实时间，而是把时钟推进抽样的间隔。
 * 计数、配额、熔断逻辑与生产完全一致，所以测试既快又仍然覆盖真实判定分支。
 * 仅供测试/回放使用，生产路径一律走 createPersistentPacer。
 */
export function createVirtualClockPacer({
  policy,
  startMs = 1760000000000,
  identity = "virtual",
  random = () => 0,
  keepSleepWindow = false,
} = {}) {
  let clock = Number(startMs);
  // 默认关掉睡眠窗口：离线测试必须与「现在几点」无关，否则同一份代码换个点跑就红。
  const clockPolicy = policy && !keepSleepWindow
    ? createHumanPolicy({ ...policy, dailySleepHours: [0, 0] })
    : (policy || createHumanPolicy({
      readGapMs: [60, 60],
      writeGapMs: [300, 300],
      burstPauseMs: [0, 0],
      dailySleepHours: [0, 0],
      sessionRestMs: [0, 0],
    }));
  const guard = new HumanRiskGuard({
    identity: String(identity),
    policy: clockPolicy,
    random,
    now: () => clock,
  });
  const pacer = new HumanPacer({
    guard,
    now: () => clock,
    wait: (ms) => new Promise((resolve) => {
      clock += Math.max(0, Math.round(ms || 0));
      resolve();
    }),
  });
  pacer.advance = (ms) => { clock += Math.max(0, Math.round(ms || 0)); return clock; };
  pacer.nowMs = () => clock;
  pacer.flush = () => null;
  return pacer;
}

/** 从面板配置里取拟人档位；没有配置就用 balanced。 */
export function humanPolicyFromConfig(config = {}, env = process.env) {
  // 面板里这些字段属于「基础配置 / 防封节奏」模块，即 config.basic.anti_detect；
  // 同时兼容历史扁平写法 config.basic.<key>。扁平值是用户曾经明确设置过的旧配置，
  // 必须优先于补齐后必然存在的内层默认值，否则「取消休息时段」会被默认 false 悄悄覆盖。
  const basic = { ...(config?.basic?.anti_detect || {}), ...(config?.basic || {}) };
  const preset = String(basic.anti_detect?.human_preset
    || basic.human_preset
    || env.GARDEN_HUMAN_PRESET
    || "balanced").trim().toLowerCase();
  const overrides = { preset: HUMAN_POLICY_PRESETS[preset] ? preset : "balanced" };
  // [第22件·2026-09-23] **总开关**（面板「防封节奏 → 开启节奏限制」，出厂 false）。
  // 关着 ⇒ 额度/休息/睡窗/间歇**真的不生效**：下面的面板数值一个都不采纳，只保留 preset（它给的是
  // 动作最小间隔那一对下界），另把睡窗与各种休息显式清零。开 ⇒ 一切照旧（今天的行为）。
  // ⚠️ 判定侧的开关是 `limitsEnabled`（`HumanRiskGuard.evaluate` 整段跳过那些检查）；
  //    这里同时把数值清零是为了让"读快照/值守读数"也说同一件事（屏上不许显示一个不存在的上限）。
  const cadenceMaster = basic.enabled === true || basic.cadence_enabled === true;
  if (!cadenceMaster) {
    return createHumanPolicy({
      preset: overrides.preset,
      limitsEnabled: false,
      dailySleepHours: [0, 0],
      sessionRestMs: [0, 0],
      burstPauseMs: [0, 0],
      sameTargetWindowMs: [0, 0],
      // 〔10-02 用户下令「不能说设置关了，你后台还在强行等待」〕这一对从前**漏在清零清单之外**：
      // 总开关一关，屏上「操作节奏」那一格整格消失（它是 `cadenceChild()`），代码却仍按档位的
      // 读 180–1100ms／写 900–3200ms 在**每一发之前等**——客户在界面上已经把这一族全关了，
      // 后台还在替他慢。一手实测：#20 现读 `basic.anti_detect.enabled=false`，
      // 而 run 241 每一发前都印「拟人等待 2.5s」，28 块地收花耗掉 70 秒（官方拖一遍是即时发的）。
      // 清零后落进 clampPair 的地板——〔10-02 用户又给数：「不开启防封，大概0.1秒就可以了」〕
      // 那道地板关着时是 写 100ms／读 30ms（开着时仍是 300／60，见 `createHumanPolicy`）。
      readGapMs: [0, 0],
      writeGapMs: [0, 0],
      // 〔同上第二条〕登录后只读核查窗：从前**完全不吃总开关**——档位 balanced 是 90 秒、保守档 180 秒，
      // 每次起号都白等那么久才能发第一写（一手实测 run 241/242：`00:29:10 … 核查窗口还剩约 90 秒`，
      // 第一拍真正干活要到 00:30:40）。这一条的来历是官方 `IDelayLoginCheckCfg`（刚进世界重点核查），
      // 属"我们替客户决定的保守"，不是官方下发的硬事实 ⇒ 关着就归 0，开着照档位。
      // 读取方 `real-adapter.js:826` 走 `this.postLoginReadOnlyMs ?? policy.postLoginReadOnlyMs`，
      // 而 runner 不传那个显式覆盖口（`:558-560` 不传＝null）⇒ 改这一格就真的生效。
      postLoginReadOnlyMs: 0,
    });
  }
  // 面板配置一律 snake_case，内部策略是 camelCase，这里两种都收，
  // 否则用户在设置面板里改的上限永远不会生效（静默失效最难查）。
  const readNumber = (...names) => {
    for (const name of names) {
      const raw = Number(basic[name]);
      if (Number.isFinite(raw) && raw > 0) return Math.round(raw);
    }
    return undefined;
  };
  for (const [camel, ...aliases] of [
    ["maxWritesPerHour", "max_writes_per_hour"],
    ["maxWritesPerDay", "max_writes_per_day"],
    ["maxActionsPerMinute", "max_actions_per_minute"],
    ["dailyMaxOnlineMinutes", "daily_max_online_minutes"],
  ]) {
    const value = readNumber(...aliases, camel);
    if (value !== undefined) overrides[camel] = value;
  }
  if (basic.disable_sleep_window === true || basic.dailySleepHours === "off") overrides.dailySleepHours = [0, 0];
  // [L14 值守排程·09-14] 面板可调的作息参数（都>0 才生效；取消休息总开关永远压过它们）。
  const sleepLow = readNumber("sleep_hours_min", "sleepHoursMin");
  const sleepHigh = readNumber("sleep_hours_max", "sleepHoursMax");
  if (overrides.dailySleepHours === undefined && sleepLow !== undefined) {
    overrides.dailySleepHours = [sleepLow, Math.max(sleepHigh ?? 0, sleepLow)];
  }
  const sessionRestMinutes = readNumber("session_rest_minutes", "sessionRestMinutes");
  if (sessionRestMinutes !== undefined) {
    // 下限照用户填的分钟数，上限给到 1.5 倍——完全定死时长会形成「每分钟准点上下线」的机器节拍。
    overrides.sessionRestMs = [sessionRestMinutes * 60000, Math.round(sessionRestMinutes * 90000)];
  }
  if (Number(overrides.dailyMaxOnlineMinutes) > 0) {
    overrides.sessionMaxMs = [overrides.dailyMaxOnlineMinutes * 30000, overrides.dailyMaxOnlineMinutes * 60000];
  }
  // [开发态总闸·09-21] 放在**面板覆盖之后**：它就是用来盖住那些面板调不到的硬闸的。
  // 不带 `GARDEN_DEV_UNTHROTTLE` 时这一步是恒等变换（出厂态逐字＝今天）。
  const dev = applyDevUnthrottle(overrides, env);
  return createHumanPolicy(dev.overrides);
}

/**
 * 「当前生效」那一行（面板用，2026-09-23 第22件）。
 *
 * 三条纪律：
 *   ① **数字全部从 `policy` 现取**——那份 policy 就是运行期真正在用的同一份产物（`humanPolicyFromConfig`），
 *      所以"屏上显示的值"与"闸门判据用的值"**同源同拍**（守卫 `test:pacing-master` 判据② 钉这一条）；
 *   ② 关着时**不显示任何额度**（那时候确实没有额度），只说"不限次数、不自己休息"；
 *   ③ 话里不许出现「闸门／拟人／进程」这类行话（customer-copy 的禁用词表在管）。
 */
export function describeEffectivePacing(policy) {
  const presetZh = { conservative: "保守", balanced: "均衡", brisk: "激进" }[policy?.preset] || String(policy?.preset || "");
  const enabled = policy?.limitsEnabled !== false;
  if (!enabled) {
    return {
      enabled: false,
      preset: policy?.preset || null,
      presetZh,
      values: null,
      textZh: "现在没开节奏限制：不限次数、也不自己休息（账号安全的几条底线照旧，见上面「脚本永远会做的四件事」）。",
    };
  }
  const sleep = Array.isArray(policy.dailySleepHours) ? policy.dailySleepHours : [0, 0];
  const sleepZh = Number(sleep[1]) > 0
    ? ("每天自动休息 " + Number(sleep[0]) + "~" + Number(sleep[1]) + " 小时")
    : "不自动休息";
  const values = {
    perHour: Number(policy.maxWritesPerHour),
    perDay: Number(policy.maxWritesPerDay),
    perMinute: Number(policy.maxActionsPerMinute),
    onlineMinutes: Number(policy.dailyMaxOnlineMinutes),
    sleepHours: [Number(sleep[0]), Number(sleep[1])],
  };
  return {
    enabled: true,
    preset: policy?.preset || null,
    presetZh,
    values,
    textZh: "当前生效：操作节奏＝" + presetZh + "——每小时最多 " + values.perHour + " 次操作、每天 " + values.perDay
      + " 次、每分钟最多 " + values.perMinute + " 个动作、每天在线不超过 " + values.onlineMinutes
      + " 分钟、" + sleepZh + "。",
  };
}

/** 当前这一进程的开发态加速说明（没开就是 null）。给运行器日志与 DTO 用，客户面不许出现。 */
export function devUnthrottleNotice(env = process.env) {
  return describeDevUnthrottle(env);
}
function riskError(verdict) {
  const error = new Error(riskMessage(verdict));
  error.code = verdict.reason === "daily-sleep-window" ? "REAL_RISK_SLEEP_WINDOW"
    : verdict.reason === "risk-breaker" ? "REAL_RISK_BREAKER"
      : verdict.reason === "session-rest" ? "REAL_RISK_SESSION_REST"
        : verdict.reason === "daily-online-cap" ? "REAL_RISK_DAILY_CAP"
          : verdict.reason === "daily-write-cap" ? "REAL_RISK_DAILY_CAP"
            : "REAL_RISK_LIMIT";
  error.verdict = verdict;
  // 复用既有的「本地拦下」通道：所有按 writeBlocked 停批的循环都能立刻收手，
  // 不会把 63 块地逐个撞闸门，也不会把本地拒绝误报成服务器故障。
  error.writeBlocked = true;
  error.pacingBlocked = true;
  error.riskControl = true;
  error.blockReason = riskMessage(verdict);
  error.retryAfterMs = Number(verdict.retryAfterMs) > 0
    ? Math.round(Number(verdict.retryAfterMs))
    : (Number(verdict.waitMs) > 0 ? Math.round(Number(verdict.waitMs)) : 0);
  return error;
}

/** 本地拟人闸门拦下的错误：Worker 据此「本轮停止且不重试」，重试本身就是机器特征。 */
export function isRiskControlError(error) {
  return error?.riskControl === true
    || error?.pacingBlocked === true
    || (typeof error?.code === "string" && error.code.startsWith("REAL_RISK_"));
}

/**
 * 〔第152件〕导出理由＝这一族字符串**会到客户屏**：`stopReason` 经 `api-user.js` 的
 * `plainForCustomer(lastRun.stop_reason)` 出成「上次为什么停」，客户手机上直接读。
 * 从前它是模块内私有表 ⇒ 文案守卫够不着，「登录后核查窗口」那句行话就这么上了屏（10-10 用户点名）。
 * 现在由 `tests/settings-cycle-copy.mjs` 判据⑩把它当成一张客户面取材量。
 */
export const RISK_STOP_REASONS = Object.freeze({
  REAL_RISK_SLEEP_WINDOW: "每日休息时段",
  REAL_RISK_BREAKER: "风控熔断冷却",
  REAL_RISK_SESSION_REST: "单次在线时长上限",
  REAL_RISK_DAILY_CAP: "今日配额上限",
  REAL_RISK_RELOGIN: "登录频率限制",
  // 与「失败」区分开：这是主动推迟，不是出错，计费与状态都不能按失败处理。
  REAL_POST_LOGIN_WINDOW: "刚上线那一会儿只看不动手",
  REAL_RISK_LIMIT: "操作节奏限制",
});

/** 恢复时间的中文口径：短的说「N 分钟」，长的直接报「明天 HH:mm」，不让人自己换算毫秒。 */
function resumePhrase(nowMs, retryAfterMs, minutes) {
  if (minutes < 90) return `预计 ${minutes} 分钟后自动恢复`;
  const resume = new Date(nowMs + retryAfterMs);
  const pad = (value) => String(value).padStart(2, "0");
  const hm = pad(resume.getHours()) + ":" + pad(resume.getMinutes());
  const nextDay = resume.toLocaleDateString("en-CA") !== new Date(nowMs).toLocaleDateString("en-CA");
  return `预计${nextDay ? "明天" : ""} ${hm} 自动继续，无需再点启动`;
}

/**
 * 把风控拦截翻译成面板可见的友好停止原因。
 * 返回 null 表示这不是本地闸门错误，调用方按既有失败策略处理。
 */
export function describeRiskControlError(error, { nowMs = Date.now() } = {}) {
  if (!isRiskControlError(error)) return null;
  const code = typeof error?.code === "string" && /^REAL_RISK_[A-Z_]{1,52}$/.test(error.code)
    ? error.code
    : "REAL_RISK_LIMIT";
  const rawRetry = Number(error.retryAfterMs ?? error.verdict?.retryAfterMs);
  const retryAfterMs = Number.isFinite(rawRetry) && rawRetry > 0 ? Math.min(Math.round(rawRetry), 86400000) : 0;
  const minutes = retryAfterMs > 0 ? Math.max(1, Math.ceil(retryAfterMs / 60000)) : 0;
  const base = String(error.message || riskMessage(error.verdict || { reason: null })).slice(0, 200);
  return Object.freeze({
    code,
    // 「826 分钟后自动恢复」这种话用户不会去换算：超过 90 分钟就直接报几点复工。
    message: minutes ? `${base}（${resumePhrase(nowMs, retryAfterMs, minutes)}）` : base,
    stopReason: RISK_STOP_REASONS[code] || RISK_STOP_REASONS.REAL_RISK_LIMIT,
    retryAfterMs,
    retryAfterIso: retryAfterMs > 0 ? new Date(nowMs + retryAfterMs).toISOString() : null,
    // 闸门拒绝的都不是服务器错误，一律按「正常休息」而非「异常」呈现。
    level: "warn",
  });
}

/**
 * 把跨层传递的风控描述还原成可抛出的闸门错误。
 * 执行器只在结果里带描述（结果对象会被裁剪），循环需要靠它决定「整轮收手」。
 */
export function riskPauseError(description) {
  if (!description || typeof description.code !== "string") return null;
  const error = new Error(String(description.message || "拟人化风控闸门暂停"));
  error.code = description.code;
  error.riskControl = true;
  error.pacingBlocked = true;
  error.writeBlocked = true;
  error.blockReason = String(description.message || description.stopReason || "拟人化风控闸门暂停");
  error.retryAfterMs = Number(description.retryAfterMs) > 0 ? Math.round(Number(description.retryAfterMs)) : 0;
  return error;
}
