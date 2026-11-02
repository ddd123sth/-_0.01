// 官方账号/登录侧错误码字典。
//
// 证据来源：官方包源码里的枚举表 `e("LOGIN",[],{...})`
//（现读 `_ref/game_src/scripts/src/assets/scripts/game.js`，枚举起点在该文件偏移 279455 处；
//  原文 **57 条**：101–104 / 2001–2047 / 902048–902053——**里面没有任何 3xx 段**）。
// ⚠️ 2026-09-23 第 26 件 B 订正：这一行原来写「56 个码」是旧口径的笔误；逐条对账后**一条不缺、一条不多**
//（守卫 `test:login-codes` 现在直接读反解包原文比对，缺一条就红）。全部是**源码实证**的官方常量。
//
// 为什么必须有这个模块：在接入它之前，所有登录失败都塌缩成一句「官方账号登录失败」，
// 于是「密码录错了」和「这个号已经被封了」在系统里长得一模一样。
// 后者如果继续按普通失败重试，就是拿着被封的凭据反复撞风控 —— 恰恰是最容易被判为自动化的行为。
// 分级处置（不可重试 / 需人工 / 换出口 / 等待）必须建立在这张表上。

export const LOGIN_ERROR_CODES = Object.freeze({
  101: { name: "closedUserRegister", kind: "config", zh: "该渠道已关闭注册" },
  102: { name: "channelNotRelease", kind: "config", zh: "渠道未开放" },
  103: { name: "ipRegisterMax", kind: "risk_ip", zh: "该出口 IP 注册数已达上限" },
  104: { name: "ipLoginMax", kind: "risk_ip", zh: "该出口 IP 登录数已达上限" },
  2001: { name: "sdk_Logged", kind: "single_session", zh: "账号已在别处登录（顶号）" },
  2002: { name: "user_logout", kind: "single_session", zh: "账号已登出" },
  2003: { name: "user_logout_protection", kind: "throttle", zh: "登出保护期内，需等待后再试" },
  2004: { name: "user_ban", kind: "blocked", zh: "账号已被封禁" },
  2005: { name: "sign_not_match", kind: "credential", zh: "签名不匹配" },
  2006: { name: "need_login", kind: "single_session", zh: "需要先登录" },
  2007: { name: "register_fail", kind: "credential", zh: "注册失败" },
  2008: { name: "user_exist", kind: "credential", zh: "账号已存在" },
  2009: { name: "reg_limit_amount", kind: "throttle", zh: "注册次数上限" },
  2010: { name: "reg_limit_phone", kind: "throttle", zh: "手机号注册次数上限" },
  2011: { name: "password_error", kind: "credential", zh: "密码错误" },
  2012: { name: "username_error", kind: "credential", zh: "账号不存在或用户名错误" },
  2013: { name: "reg_often", kind: "throttle", zh: "注册过于频繁" },
  2014: { name: "sensitive_word", kind: "credential", zh: "含敏感词" },
  2015: { name: "register_ban", kind: "blocked", zh: "注册被封禁" },
  2016: { name: "user_register_ip_limit", kind: "risk_ip", zh: "该 IP 注册受限" },
  2017: { name: "user_device_is_fobid", kind: "blocked", zh: "设备已被封禁" },
  2018: { name: "registered_too_many_times", kind: "throttle", zh: "注册次数过多" },
  2019: { name: "sign_fail", kind: "credential", zh: "签名失败" },
  2020: { name: "sign_phone_not_exist", kind: "credential", zh: "该手机号未注册" },
  2021: { name: "sing_error_code", kind: "credential", zh: "验证码错误" },
  2022: { name: "sing_limit_amount", kind: "throttle", zh: "验证码次数上限" },
  2023: { name: "sign_not_exist", kind: "credential", zh: "签名不存在" },
  2024: { name: "old_pwd_error", kind: "credential", zh: "原密码错误" },
  2025: { name: "phone_unbind", kind: "credential", zh: "手机号未绑定" },
  2026: { name: "phone_limit_amount", kind: "throttle", zh: "手机号操作次数上限" },
  2027: { name: "ip_limit_amount", kind: "risk_ip", zh: "该 IP 操作次数已达上限" },
  2028: { name: "phone_type_error", kind: "credential", zh: "手机号格式错误" },
  2029: { name: "phone_sms_error", kind: "credential", zh: "短信发送失败" },
  2030: { name: "phone_al_user", kind: "credential", zh: "手机号已被占用" },
  2031: { name: "phone_error", kind: "credential", zh: "手机号错误" },
  2032: { name: "phone_not_exist", kind: "credential", zh: "手机号不存在" },
  2033: { name: "phone_al_user_change_bind", kind: "credential", zh: "手机号已绑定他号" },
  2034: { name: "send_fail", kind: "throttle", zh: "发送失败" },
  2035: { name: "pict_valid_error", kind: "credential", zh: "图形验证码错误" },
  2036: { name: "pict_valid_limit_amount", kind: "throttle", zh: "图形验证码次数上限" },
  2037: { name: "phone_sms_maintenance_in_progress", kind: "config", zh: "短信通道维护中" },
  2038: { name: "failed_to_obtain_verification_code", kind: "credential", zh: "获取验证码失败" },
  2039: { name: "email_unbind", kind: "credential", zh: "邮箱未绑定" },
  2040: { name: "email_formal_error", kind: "credential", zh: "邮箱格式错误" },
  2041: { name: "email_limit_amount", kind: "throttle", zh: "邮箱操作次数上限" },
  2042: { name: "template_id_not_exist", kind: "config", zh: "模板不存在" },
  2043: { name: "email_al_user_change_bind", kind: "credential", zh: "邮箱已绑定他号" },
  2044: { name: "email_verify_old_email", kind: "credential", zh: "需验证原邮箱" },
  2045: { name: "email_sign_not_exist", kind: "credential", zh: "邮箱验证签名不存在" },
  2046: { name: "email_is_exist", kind: "credential", zh: "邮箱已存在" },
  2047: { name: "email_send_frequent", kind: "throttle", zh: "邮件发送过频" },
  902048: { name: "request_token_fail", kind: "single_session", zh: "会话令牌获取失败" },
  902049: { name: "ip_login_risk", kind: "risk_ip", zh: "该出口 IP 触发登录风险判定" },
  902050: { name: "ip_ban", kind: "risk_ip", zh: "出口 IP 已被封禁" },
  902051: { name: "ip_frequency", kind: "risk_ip", zh: "该出口 IP 请求过频" },
  902052: { name: "rate_limit", kind: "throttle", zh: "触发限流" },
  902053: { name: "sdk_acc_ban", kind: "blocked", zh: "SDK 侧账号封禁" },
});

/**
 * 每个分类的处置策略。核心原则：**能重试的只有 throttle**，
 * 其余一律不许自动重试（拿被封的凭据反复撞，本身就是最强的自动化特征）。
 */
const LOGIN_OUTCOME_POLICIES = Object.freeze({
  // [第25件·2026-09-23 B] blocked 冻结**24 小时**（取值理由：官方封禁通常以「天」为单位，且账本"只延长不缩短"，
  //   宁可长一点等人来处理，也不许短了以后自己再撞一次）。改前是 null（走 360 分钟的兜底值）。
  blocked: { retryable: false, needsUserAction: true, stopAccount: true, breaker: true, minutes: 1440 },
  credential: { retryable: false, needsUserAction: true, stopAccount: true, breaker: false, minutes: null },
  risk_ip: { retryable: false, needsUserAction: true, stopAccount: true, breaker: true, minutes: 60 },
  // [第25件·2026-09-23 B] 顶号（2001 等）冻结 **15 分钟**（取值理由：上一次实测是同一账号刚在别处退出的两分钟内发起，
  //   15 分钟足够对方会话被官方回收，也远小于"拿号刷脸"的密度）。改前 5 分钟太短、且当时压根不会写冻结（见下）。
  single_session: { retryable: false, needsUserAction: false, stopAccount: false, breaker: true, minutes: 15 },
  throttle: { retryable: true, needsUserAction: false, stopAccount: false, breaker: false, minutes: 3 },
  config: { retryable: false, needsUserAction: true, stopAccount: false, breaker: false, minutes: null },
  // **本地分类，不是官方码**（见 ACCOUNT_REFUSED_KIND 的注释）：官方账号层拒了这次登录，
  // 但码不在本表里。处置同 credential（不重试、要用户核对），但**文案不许冒充凭据类**。
  account_refused: { retryable: false, needsUserAction: true, stopAccount: false, breaker: false, minutes: null },
  unknown: { retryable: false, needsUserAction: true, stopAccount: false, breaker: false, minutes: null },
});

/**
 * 官方 **V5 账号服务层**（`moac.babigame.cn/account/login/username/v5`）码系是 14xxx，与 SDK 的
 * LOGIN 枚举（101~104 / 2001~2047 / 902048~902053）**不同源**：我们只实证过其中一条（14101＝时间戳过期，
 * 见 `android-auth.ACCOUNT_TIMESTAMP_EXPIRED_STATUS`）。于是「账号层明确拒了这次登录、而码不在表里」
 * 是一个**没有官方名字的真实档位**，必须单独成立：
 *   - 塌缩成 `unknown` ⇒ 客户只看到一句「原因不明」，不知道该去核对什么；
 *   - 一律扣成 `credential` ⇒ 网络/改版/维护类故障会被说成「密码错」，用户会去改一个本来没错的密码（用户原话点名不许这样）。
 * 所以这里给它一个**本地**名字与处置档，客户文案由调用方按档给（添加账号那条链在 `account-verify.js`）。
 */
export const ACCOUNT_REFUSED_KIND = "account_refused";

/**
 * 官方**世界服文案号**（`c_msgCode` 那一族：随 rs 信封的 `m` 下发，`ws.js:236` 把它挂在
 * `error.serverMsgCode` 上）里属于「这是账号级裁决、别再撞」的那几条。
 *
 * ⚠️ 它与上面 `LOGIN_ERROR_CODES`（SDK 登录码 101~104 / 2001~2047 / 902xxx）**不是一套号**：
 * 同一个数字 `2004` 在文案表里是别的话，在登录码典里是 `user_ban`。所以这里单独一张表，
 * **绝不并进 `LOGIN_ERROR_CODES`**——两套分母互相冒充，要么把普通业务拒绝说成封号，
 * 要么反过来把封号说成普通拒绝。
 *
 * 判据出处（一手、2026-10-03 现场）：库内 `run_logs.id=1274901`（run 269、账号 #16）原文
 * 「服务器文案#97778：检查到您角色数据或因使用第三方工具导致数据异常无法正常登录，
 * 目前数据正在加急修复中。请于…后尝试重新登录」。当时我们把它包装成了
 * `REAL_SESSION_EXPIRED`（`real-adapter.js` 那条含「登录」二字的正则先命中），客户屏上于是印成
 * 「游戏会话已过期，需要重新登录」——**那是一句假话，而且是在邀请再登一次**；
 * 而恢复计划因为读不到任何登录码，把它算成 `remote-reject／可复工`，
 * 只差一格（用户自己关着「异常自动复工」）就会拿着这个号每 5 分钟撞一次、连撞 3 次。
 * 本表就是把这一族裁决从"猜"变成"点名"。
 *
 * 〔2026-10-18 03:22:34 真号 #28 run 441 现读补的第二枚号〕**同一条官方裁决在 `c_msgCode` 里占两个号**：
 * `97778` 与 `5000`，两行的 `type` 都是 97778，文本只差一个「中」字（表内逐字现读）。
 * 本表从前只点名 97778 ⇒ 官方回 5000 的那一发**整条链没人认**：探针直递 5000 回 `null`，
 * 连"从消息文本认回号"那一条路（`worldMsgVerdictFromText`，第147件就为这个洞加的）也回 `null`
 * ⇒ `officialSoftBlockVerdict` 空转 ⇒ 屏上落的还是 10-03 被判死的那句「游戏会话已过期，需要重新登录」，
 * 而 `run.hold_started`（拦了多久／下一次几点试／还是不再试）一个字没写。
 * 库内同一形状累计三起（run 269 带 97778、run 310 与 run 441 带 5000），**全走的那句假话**。
 * ⇒ 5000 与 97778 共用**同一份**裁决对象（不是抄第二份参数）：一份算式，两个入口号。
 */
const DATA_ABNORMAL_REPAIR_VERDICT = Object.freeze({
    name: "data_abnormal_repair",
    // 〔10-03 11:1x 用户实测改口〕这一档**不是封号，是"稍等一会儿再登"**：官方原话「数据正在加急修复中、
    // 请于 %s 后尝试重新登录」，而那个 %s 没下发。本号 10:28:57 被拦，用户自己在官方客户端实测已能登录
    // （11:1x），并点名「下次到点你需要重试登录」⇒ 上一版按 blocked/1440 分钟处理**比官方更保守**，
    // 会把一个本来能登的号锁一整天（同族教训：花坊那面"读不到就不换"的墙把主线卡死三天）。
    // 所以走 throttle：**到点自动再登一次**，次数与节奏都吃页面上那一格「异常自动复工」
    // （本号现读 `delay_minutes=5`、`max_attempts=3`，就是用户说的"5 分钟、10 分钟"那个量级）——
    // 冻结时长与复工延时是同一个数，不做两套分母（铁律 16）。撞满 3 次仍进不去才落终态等人工。
    // ⚠️〔10-09 第147件 用户②原话「在官方允许登录后**追加**这几分钟再尝试进行登录」〕上面那句「同一个数」**已退役**：
    //   现在这一档的 `minutes` 只是「官方没说时长时我们先等的那一段」，真正排定的时刻＝这一段＋页面上那一格（相加）。
    //   分母仍然只有一套（都从这张表与这一格算出来），所以铁律 16 的底线没变；翻判据的留痕在
    //   `memory/plan-1009-softblock-log-and-autorecovery.md` §3.1 与 `tests/world-msg-risk-verdict.mjs` 判据①⑤。
    kind: "throttle",
    minutes: 5,
    zh: "官方把这个号的角色数据拦下来说在修复中（它自己提示与使用第三方工具有关）；先等几分钟，到点会自己再登一次",
    // 〔10-09 第147件·收口时实测抓出来的「同一秒两句打脸」〕上面那句 `zh` 把**两件事**揉在了一句里：
    //   「官方拦下这个号」（事实）＋「到点会自己再登一次」（承诺）。承诺只有握着 `plan`/开关值的那一层
    //   说得出口——`run-recovery.js` 的 requeue 分支、`real-adapter.js` 那条内部行都在那里说，没问题；
    //   但**读侧**（`customer-log-view.js#officialMsgVerdictZh`）与**面板启动预检**手上没有开关值，
    //   而出厂默认是关的（铁律 5），于是同一秒里旧行承诺「会自己再登」、新行 `run.hold_started` 却说
    //   「你不会自己去试」＝两句互相打脸。这一格就是给那两处用的：**只陈述事实，不替系统承诺**。
    //   ⚠️ 不许加「去看下一行」那种指路句：库里 10-03／10-08 那些**历史行旁边并没有新行**，指了就是新的假话。
    factZh: "官方把这个号的角色数据拦下来说在修复中（它自己提示与使用第三方工具有关）；这一刻这个号登不上",
});

export const WORLD_MSG_RISK_VERDICTS = Object.freeze({
  // 〔2026-10-18 03:22 真号 #28 run 441 那一发补的第二枚入口号〕这一族在官方文案表里占**两个号**：
  // `c_msgCode` 现读 5000 与 97778 两行的 `type` 都是 97778、文本只差一个「中」字。从前这张表只点名 97778
  // ⇒ 官方回 5000 时整条链没人认（探针直递 5000 回 null，从消息文本认回那一条路也回 null）：
  // `officialSoftBlockVerdict` 空转、`run.hold_started` 一个字没写，屏上落的还是 10-03 判死过的
  // 「游戏会话已过期，需要重新登录」。两个号**共用上面那一份裁决**——抄第二份 kind/minutes/zh
  // 就是两套分母，改一处忘一处必然自相矛盾。
  97778: DATA_ABNORMAL_REPAIR_VERDICT,
  5000: DATA_ABNORMAL_REPAIR_VERDICT,
  // 〔10-03 12:2x 用户点名「别人屏上写封禁 5 分钟，他们怎么查出来的」〕上面那句 %s **不是没下发**——
  // 官方把时长填在信封的参数槽 `args` 里（读法 `server-msg.js#serverMsgHoldMs`），是我们以前只印模板、
  // 参数一个不读。读到官方的数就用官方的（见 `loginOutcomePolicyOf` 里那一格），`minutes` 只是兜底。
  // ↓ 下面两条**我们还没在实服遇到过**，登记依据＝官方文案表 `c_msgCode` 现读原文（等级＝推测待验）：
  //   它们的话术明写「解封时间：${time}」，正是"封禁 N 分钟"那一族最标准的形状。真遇到时按 blocked
  //   处理（不自动重试、按官方给的解封时刻冻结），读不到参数才按 minutes 兜底。
  3800: Object.freeze({
    name: "etiquette_restricted",
    kind: "blocked",
    minutes: 60,
    zh: "官方说这个号因礼仪分过低被限制登录，并给了解封时间",
  }),
  3801: Object.freeze({
    name: "account_banned_with_time",
    kind: "blocked",
    minutes: 1440,
    zh: "官方说这个号已被封禁，并给了解封时间",
  }),
});

/** 这条文案号是不是「账号级、别再撞」的裁决（不是／读不到 ⇒ null，绝不回 0 冒充）。 */
export function worldMsgRiskVerdictOf(code) {
  const raw = code;
  if (raw === null || raw === undefined || raw === "") return null;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric === 0) return null;
  const hit = WORLD_MSG_RISK_VERDICTS[numeric];
  return hit ? { code: numeric, ...hit } : null;
}

/** 我们自己拼进消息里的那一枚号（`server-msg.js#describeServerMsg` 的形状：`服务器文案#<号>：原文`）。 */
const WORLD_MSG_TEXT_CODE = /服务器文案#(\d{1,9})/;

/**
 * 〔10-09 第147件·收口时从服务器日志查出来的真形状〕**号有时候只活在消息文本里**。
 * 一手证据（中央库现读，22 行）：`run_logs.detail.官方` 逐行都是 `{"码所在键":"没有","官方码":"—"}`，
 * 而 `message` 文本带着「服务器文案#97778：…」——这批全是**登录阶段**抛的错，那条路径把号拼进了中文、
 * 却没挂到 `error.serverMsgCode` 上。⇒ 只认结构化字段的判据在实服上**一次都没命中**：
 * 10-08 部署之后的 10 行仍然写着 `code=REAL_SESSION_EXPIRED`（第109件那批的映射没生效），
 * 而我这批新加的 `run.hold_started` 也永远不会亮＝又一条「代码齐了、生产上是死通道」（同 09-14 白名单漏键）。
 * 所以号有两个来路时**都要认**：先读结构化字段，读不到再按文本认回来。认不得 ⇒ null（绝不猜）。
 * ⚠️ 读侧（`customer-log-view.js#officialMsgVerdictZh`）与本函数是同一张嘴、同一枚正则，不许各写一份。
 */
export function worldMsgVerdictFromText(text) {
  const found = WORLD_MSG_TEXT_CODE.exec(String(text || ""));
  return found ? worldMsgRiskVerdictOf(found[1]) : null;
}

/** 分钟数夹在 1 分钟～7 天之间：官方给个离谱的数就当读不到，不拿它去锁号（也不拿 0 冒充）。 */
function clampMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const rounded = Math.round(n);
  if (rounded < 1 || rounded > 7 * 24 * 60) return null;
  return rounded;
}

/** 冻结原因那一格存的是枚举名（不存响应内容）；翻回中文：先查本表，再查登录码典，都没有就照实说。
 *  〔10-09 第147件〕本表这一档**优先取 `factZh`**：这一句的两个调用方（面板启动预检、登回来那句的「原因」尾巴）
 *  手上都没有「异常自动复工」的开关值，无权承诺「到点会自己再登」——承诺归拿着排程的那一行（`officialHoldNoteZh`）。
 *  没有 `factZh` 的档（3800／3801 本来就只讲事实）照旧回落 `zh`。 */
export function loginHoldReasonZh(reason) {
  const key = typeof reason === "string" ? reason.trim() : "";
  if (!key) return "官方没说原因";
  const verdict = Object.values(WORLD_MSG_RISK_VERDICTS).find((one) => one?.name === key);
  if (verdict) return verdict.factZh || verdict.zh;
  return LOGIN_OUTCOME_LABEL_BY_NAME[key]?.zh || key;
}

/** 时刻只到分钟（客户屏上不需要秒）；读不到就显「—」，绝不显 00:00（铁律 8 第 5 条）。 */
function holdClockZh(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const d = new Date(n);
  const pad = (one) => String(one).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 〔第147件·2026-10-09〕同一族句子给客户看的是「下一次**几点**再试」，所以要到秒；
 * 读不到照旧显「—」，绝不显 00:00:00（铁律 8 第 5 条）。
 * 导出给 `run-recovery.js` 复用：这一族的时刻格式只许这一处定义，别在两个文件各写一份 `pad`。
 */
export function holdClockWithSecondsZh(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const d = new Date(n);
  const pad = (one) => String(one).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 毫秒 → 分钟（向上取整至少 1 分钟）；**读不到就回 null，调用方那一支整段不出现**——绝不拿 null 冒充 0 分钟。 */
function minutesFromMs(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.round(n / 60000)) : null;
}

/**
 * [第109件·补 2026-10-03 用户点名「在日志里边显示被封禁了多久」，同日 12:2x 追问「别人显示封禁 5 分钟，
 * 他们怎么查出来的」] 把一次「被官方拦下 → 又登上来」的窗口写成一句客户话。两种来源分开说，绝不揉成一句：
 *   · `officialMinutes` —— **官方自己在参数槽里给的数**（`%s`／`${time}` 那个位置），这才叫"封禁 N 分钟"；
 *   · `minutes` —— 我们自己量的（第一次被拦 → 真登上来的那一刻）。官方没说时只有这一种，句子里要带"约"。
 * 拿不到分钟数就回空串（调用方不给那一行，屏上宁缺不凑）。
 */
export function holdWindowNoteZh({ startedAtMs = null, endedAtMs = null, minutes = null, officialMinutes = null, reason = null } = {}) {
  const measured = Number(minutes);
  const official = Number(officialMinutes);
  if (!Number.isFinite(measured) || measured <= 0) return "";
  const span = `${holdClockZh(startedAtMs)} 到 ${holdClockZh(endedAtMs)}`;
  const head = Number.isFinite(official) && official > 0
    ? `官方说这个号要封禁 ${Math.round(official)} 分钟；实际 ${span} 之间登不上，共约 ${Math.round(measured)} 分钟，现在登回来了`
    : `官方这次把这个号拦了约 ${Math.round(measured)} 分钟（${span}），现在登回来了`;
  return `${head}；原因：${loginHoldReasonZh(reason)}。这期间没有重复发任何东西。`;
}

/**
 * [第147件·2026-10-09 用户①原话「软拦也要在日志里面写上，让用户看到被拦下来了几分钟，然后预计下次什么时候尝试登录」]
 * 与 `holdWindowNoteZh` 同一族、一出一进：那一句是**登回来时**的结算，这一句是**被拦下那一刻**的账——
 * 不等登回来才说（登不回来就永远没人知道）。判据与三种出口逐字来自
 * `memory/plan-1009-softblock-log-and-autorecovery.md` §3.2／§4.2，句子本体住在本文件而不是 `worker.js`
 * （`log-contract.js` 明写「契约不自己长嘴」）。
 *
 * 三个档**各成一式、不许共用一句**：
 *   · **会再试**（`plan.action === "requeue"`）：两段时长各自的数＋下一次几点试＋第几次；
 *   · **官方没给时长**（`loginPolicy.officialHoldMs` 读不到）：整句必须原样出现「但没说等多久」，
 *     并且**不许出现「官方说」这三个字**——把表里兜底那个分钟数说成官方给的数就是撒谎（施工单 §8 第 1 条）；
 *   · **不再试**：关着／次数用满（含填 0）／官方说别再撞，三种理由各一句，不合并。
 */
export function officialHoldNoteZh({ verdict = null, plan = null, nowMs = null } = {}) {
  const loginPolicy = verdict?.loginPolicy ?? null;
  const clock = Number(nowMs) > 0 ? Number(nowMs) : Date.now();
  // 「官方自己说了多久」与「官方没说、我们用表里的数兜底」是两件不同的事，分开取、分开说（铁律 13 第 2 条：
  // 判据用的数与屏上显示的数同源；§8 第 1 条：不许按兜底值冒充官方的数）。
  const officialGivenMs = Number(loginPolicy?.officialHoldMs) > 0 ? Math.round(Number(loginPolicy.officialHoldMs)) : 0;
  const heldMs = Number(plan?.officialWaitMs) > 0
    ? Math.round(Number(plan.officialWaitMs))
    : (Number(loginPolicy?.minutes) > 0 ? Math.round(Number(loginPolicy.minutes) * 60000) : 0);
  const officialMinutes = minutesFromMs(officialGivenMs);
  const heldMinutes = minutesFromMs(heldMs);
  const waitNote = officialMinutes
    ? `它说要等 ${officialMinutes} 分钟（到 ${holdClockWithSecondsZh(clock + officialGivenMs)} 才让登）`
    : `但没说等多久${heldMinutes ? `（我们按 ${heldMinutes} 分钟先等）` : ""}`;
  const head = `官方这一刻把这个号拦下了，${waitNote}`;

  if (plan?.action === "requeue") {
    const extraMinutes = minutesFromMs(plan?.extraWaitMs);
    const attempt = Number(plan.attempt) > 0 ? Math.round(Number(plan.attempt)) : null;
    const max = Number(plan.maxAttempts) > 0 ? Math.round(Number(plan.maxAttempts)) : null;
    const tries = (attempt !== null && max !== null) ? `自己再试第 ${attempt}/${max} 次` : "自己再试一次";
    return `${head}；${extraMinutes ? `我们再等 ${extraMinutes} 分钟，` : ""}约 ${holdClockWithSecondsZh(plan.retryAtMs ?? plan.resumeAtMs)} ${tries}。这期间没有再向游戏发任何东西。`;
  }

  // 不再试：三档各一句，不合并（关着 ≠ 次数用满 ≠ 官方说别再撞，客户要做的动作也不一样）。
  const policy = plan?.policy ?? null;
  const maxAttempts = Number(policy?.maxAttempts);
  let stopNote;
  if (loginPolicy?.kind === "blocked" || plan?.kind === "blocked") {
    stopNote = "官方要这个号先别再撞，等你自己在游戏里看过之后再起。";
  } else if (policy && policy.enabled === false) {
    stopNote = "面板上「出错后自动重新登录」这一项你是关着的，所以到点不会自己去试，要你在页面上点「启动」。";
  } else if (Number.isFinite(maxAttempts) && maxAttempts <= 0) {
    stopNote = "页面上「一次托管最多自己重试几回」填的是 0，所以出错后一次都不会自己重试，要你在页面上点「启动」。";
  } else if (policy && Number(plan?.attempt) >= maxAttempts) {
    stopNote = `这一次托管已经自己试过 ${Math.round(maxAttempts)} 回都没进去，先停下等你看一眼。`;
  } else {
    // 读不出为什么停手就照实说，不替客户编一个理由（铁律 8 第 5 条）。
    stopNote = "这一刻没有安排自动重新登录，为什么停手请看上一行。";
  }
  return `${head}；${stopNote}`;
}

/** 「账号层拒了但码不在表里」的处置结论：形状与 `describeLoginError` 完全一致，便于同一处消费。 */
export function describeAccountRefusedLogin(code) {
  // [39A·c] 与 `describeLoginError` 同形先挡空：不挡的话 `Number(null) === 0` 会让「账号层没回码」
  //   变成一条假的「未收录的账号层码 0」。**潜在**地雷（当前不上客户屏、不落库，见 worklog 第 39 件 A 的事实边界）。
  const numeric = isBlank(code) ? NaN : Number(code);
  const known = Number.isFinite(numeric) ? LOGIN_ERROR_CODES[numeric] : undefined;
  // 表里真有这个码就不该走这一档（调用方判错时在这里兜住，避免用「未收录」的名义覆盖真结论）。
  if (known) return describeLoginError(numeric);
  return {
    code: Number.isFinite(numeric) ? numeric : null,
    name: null,
    kind: ACCOUNT_REFUSED_KIND,
    ...LOGIN_OUTCOME_POLICIES[ACCOUNT_REFUSED_KIND],
    message: Number.isFinite(numeric)
      ? `官方账号层拒绝了这次登录（未收录的账号层码 ${numeric}）`
      : "官方账号层拒绝了这次登录（没有回码）",
  };
}

/** 把官方错误码翻成「哪一类、能不能重试、该告诉用户什么」。 */
export function describeLoginError(code) {
  // [38E] 先挡空：`null`/`undefined`/`""` 是**同一件事**（没读到码）。不挡的话 `Number(null) === 0`
  //   会把这个函数同一个输入拆成两种答案——`null` ⇒「未收录的登录错误码 0」，`undefined` ⇒「官方未返回错误码」，
  //   而前者的 `code: 0` 还会顺着 `attachLoginOutcome` 写进 error.loginCode，让落库那一格变成 `LOGIN_0_unlisted`
  //   （「读不到却显示 0」那一族在**诊断层**的形状，见错误清单第 26 条）。
  const numeric = isBlank(code) ? NaN : Number(code);
  const entry = Number.isFinite(numeric) ? LOGIN_ERROR_CODES[numeric] : undefined;
  const policy = LOGIN_OUTCOME_POLICIES[entry?.kind] || LOGIN_OUTCOME_POLICIES.unknown;
  if (!entry) {
    return {
      code: Number.isFinite(numeric) ? numeric : null,
      name: null,
      kind: "unknown",
      ...policy,
      message: Number.isFinite(numeric)
        ? `官方返回了未收录的登录错误码 ${numeric}，按不可重试处理`
        : "登录失败，官方未返回错误码",
    };
  }
  return {
    code: numeric,
    name: entry.name,
    kind: entry.kind,
    ...policy,
    message: `${entry.zh}（官方码 ${numeric} ${entry.name}）`,
  };
}

/**
 * 从 V5/SDK 的响应里挑出最可能的错误码。
 * 官方在不同层用的键名不一样（status / code / errCode），而且 status 有时是字符串 "success"。
 */
/**
 * [第26件·2026-09-23 A] 与 `extractLoginErrorCode` 同一套判据，但**连键名一起给**。
 * 为什么要有它：run 149 只落下了「官方码 302」，没落键名 ⇒ 判不出它是挂在 `code` 还是 `status` 上，
 * 也就判不出「是哪一层的数」（HTTP 层？SDK 网关？业务层？）。键名是纯 ASCII 短词，可以安全落盘。
 */
/**
 * **唯一候选位表**（37A）：三个取值函数都从这一张走，**值与键名必须同一次命中共出**。
 * ⚠️ `code` **不在表内**：它在两条链的成功响应里都自带（微信链 `docs/PROTOCOL.md:19` 的 `status:"success"+code:302`；
 *   安卓 c459 链 `.runtime/ld-tls/events-20260923085134.jsonl` **seq=1** 同一棵键名树）⇒ 拿它当错误码会把成功读成失败。
 */
export const LOGIN_ERROR_CODE_KEYS = Object.freeze(["errCode", "error_code", "status"]);

// SDK 网关在不同版本把同一枚 LOGIN 码放在顶层、data 或 result 里；
// 成功回包的 `code=302` 不在候选表，不能把它误认成失败码。
// 只展开这两个官方信封容器，绝不递归任意响应对象，避免把凭据或业务字段当成登录码。
const LOGIN_ERROR_CODE_CONTAINERS = Object.freeze([
  { key: "", value: (body) => body },
  { key: "data", value: (body) => body?.data },
  { key: "result", value: (body) => body?.result },
]);

/**
 * 唯一遍历。返回 `{code, key}` 或 **null**（读不到就是 null，**绝不用 0 冒充**）。
 * 挡空值是显式的：`null`/`undefined`/`""` 一律跳过（不许 `Number(null)===0` 那族再上屏或入库）。
 * 优先表内码（同一批候选里先找认得的），表外数字码也照给（调用方按 unknown 处置）。
 */
export function findLoginErrorCode(body) {
  if (!body || typeof body !== "object") return null;
  const seen = [];
  for (const container of LOGIN_ERROR_CODE_CONTAINERS) {
    const source = container.value(body);
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const key of LOGIN_ERROR_CODE_KEYS) {
      const raw = source[key];
      if (raw === undefined || raw === null || raw === "") continue;   // 空值：跳过
      if (typeof raw === "string" && !/^-?\d+$/.test(raw.trim())) continue;
      const numeric = Number(raw);
      if (!Number.isFinite(numeric)) continue;                          // NaN：跳过
      if (numeric === 0) continue;                                      // 0 不是码（挡 Number(null)=0 那族）
      if (key === "status" && numeric === 1) continue;                 // status:1 ＝ 成功
      seen.push({ code: numeric, key: container.key ? container.key + "." + key : key });
    }
  }
  return seen.find((one) => LOGIN_ERROR_CODES[one.code]) || seen[0] || null;
}

/** 码（读不到 ⇒ null）。 */
export function extractLoginErrorCode(body) {
  return findLoginErrorCode(body)?.code ?? null;
}

/** 码＋键名（读不到 ⇒ null）。 */
export function extractLoginErrorCodeSource(body) {
  return findLoginErrorCode(body);
}

/** 键名那一版（读不到 ⇒ null）。 */
export function loginCodeKeyOf(body) {
  return findLoginErrorCode(body)?.key ?? null;
}
/** 登录侧「一遇就停、绝不重试」的码：封号、设备封禁、IP 封禁。 */
export const LOGIN_FATAL_REMOTE_CODES = Object.freeze([...new Set(
  Object.entries(LOGIN_ERROR_CODES)
    .filter(([, entry]) => entry.kind === "blocked" || entry.kind === "risk_ip")
    .map(([code]) => Number(code)),
)]);

/**
 * 冻结账本只存枚举名（不存响应内容），面板文案需要能把它翻回中文。
 * 反查表由字典本身派生，避免第二份手工维护的映射漂移。
 */
const LOGIN_OUTCOME_LABEL_BY_NAME = Object.freeze(Object.entries(LOGIN_ERROR_CODES).reduce((acc, [code, entry]) => {
  if (entry && typeof entry.name === "string" && typeof entry.zh === "string" && !acc[entry.name]) {
    acc[entry.name] = { zh: entry.zh, code: Number(code) };
  }
  return acc;
}, {}));

export function loginOutcomeLabel(name) {
  const key = typeof name === "string" ? name.slice(0, 40) : "";
  return LOGIN_OUTCOME_LABEL_BY_NAME[key] || null;
}
export function isLoginFatalCode(code) {
  return LOGIN_FATAL_REMOTE_CODES.includes(Number(code));
}

const LOGIN_KINDS = new Set(["blocked", "credential", "risk_ip", "single_session", "throttle", "config", "unknown", ACCOUNT_REFUSED_KIND]);

/** 空值一律先挡：`null`/`undefined`/`""` ⇒ **没读到**（绝不让 `Number(null)===0` 那族上屏或入库）。 */
const isBlank = (value) => value === null || value === undefined || value === "";
/** 有限数字（先挡空值再转）。读不到 ⇒ undefined（调用方**整格不打**）。 */
const asFiniteNumber = (value) => (isBlank(value) ? undefined : (Number.isFinite(Number(value)) ? Number(value) : undefined));
/** 纯 ASCII 短词（键名/枚举名那一类）。 */
const asShortWord = (value, re) => (typeof value === "string" && re.test(value) ? value : undefined);
const asBoolean = (value) => (typeof value === "boolean" ? value : undefined);

/**
 * [38C] 值里有没有凭据（**失败关闭**：命中就整条退回「〈已掩码〉」，不做部分遮盖）。
 * 判据与抓包工具**同一族**：`tools/ld-tls-hop.mjs:39` 的 `looksCredentialBearing`
 * （SECRET_PARAMS ＝ token／open_id／openid／mdSession1／session1／signature／sign／uuid，
 *   不要求 `?`/`&` 前缀——`token=…`、`"token":…` 这种裸露形状也算），
 * 再加 real-adapter `REDACT_PATTERNS` 那条「长十六进制／长 base64 样串」的网。
 */
const NOTE_SECRET_NAMES = Object.freeze(["token", "open_id", "openid", "mdSession1", "session1", "signature", "sign", "uuid"]);
function looksCredentialBearing(text) {
  const raw = String(text);
  if (NOTE_SECRET_NAMES.some((name) => new RegExp("(^|[^A-Za-z0-9_])" + name + "\\s*[=:]", "i").test(raw))) return true;
  return /\b[a-f0-9]{24,}\b/i.test(raw) || /\b[A-Za-z0-9+/_=-]{48,}\b/.test(raw);
}

/**
 * [38C] 「官方那一句」的**唯一净化出口**：控制字符归一 → 凭据掩码（命中则整条退回「〈已掩码〉」）→ 截断 ≤40 字。
 * 采集端（`android-auth.js` 的 `pickRemoteNote`）与规格表（`sdkRemoteNote.build`）**都调它**，于是：
 *   ① 原始错误对象上从不出现未掩码的官方原文；② 这一步是幂等的（`sanitize(sanitize(x)) === sanitize(x)`），
 *   所以生产那两遍清单不会把它改样（见 `test:login-diagnostics` ⑤ 的全表幂等断言）。
 * 读不到（非字符串 / 全空白）⇒ undefined（整格不打）。
 */
export function sanitizeRemoteNote(value) {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  if (looksCredentialBearing(text)) return "〈已掩码〉";
  return text.length > 40 ? text.slice(0, 39) + "…" : text;
}

// Error display has a separate budget from short remote annotations. Keep the
// official sentence, masking credential values in place instead of discarding
// the whole explanation. Callers still select only known message fields.
function officialErrorNoteParts(value) {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  const secretKeys = "password|passwd|pwd|token|access[_-]?token|account[_-]?token|session[_-]?token|sdk[_-]?token|open[_-]?id|mdSession1|session1|signature|sign|uuid|credential|authorization|cookie|密码|口令|凭据|会话令牌|登录令牌";
  const masked = text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi, "$1 [已隐藏]")
    .replace(new RegExp("((?:[\\\"']?)(?:" + secretKeys + ")(?:[\\\"']?)\\s*[=:：]\\s*)(?:\\\"[^\\\"]*\\\"|'[^']*'|\\[[^\\]]*\\]|[^\\s,，;；}\\]&)]+)", "gi"), "$1[已隐藏]")
    .replace(/\b[a-f0-9]{24,}\b/gi, "[已隐藏]")
    .replace(/\b[A-Za-z0-9+/_=-]{48,}\b/g, "[已隐藏]");
  return { text: masked, redacted: masked !== text };
}

export function sanitizeOfficialErrorNote(value) {
  const parts = officialErrorNoteParts(value);
  if (!parts) return undefined;
  return parts.text.length > 1600 ? parts.text.slice(0, 1599) + "…" : parts.text;
}

export function officialErrorNoteFields(value) {
  const parts = officialErrorNoteParts(value);
  if (!parts) return undefined;
  return {
    officialErrorNote: sanitizeOfficialErrorNote(value),
    officialErrorRedacted: parts.redacted,
    officialErrorTruncated: parts.text.length > 1600,
  };
}

/**
 * 〔第211件·方案 §18.3〕「官服对这一发回了话／回了但读不懂／带数字裁决码当面拒」这一族**结论旗标**的收法。
 * ⚠️ 不许复用 `asBoolean`：false 落在这一族里说的是「我们没读到回话」，而这一侧根本无从断言"官方一定没回"——
 * 写 false 冒充「没回话」＝拿自己的读不到替官服说话（方案 §18.3 第 5 条：未知保护必须留在未知那一档）。
 * 所以只收恰好 `true`：读不到／没挂旗 ⇒ 整格不打，下层判据回到「没有这一格」。
 */
const asConfirmedAnswerFlag = (value) => (value === true ? true : undefined);

/** 官方参数槽里那句「还要等多久」（毫秒）：与 `real-adapter.diagnosticMetadata` 手写那一支同一把尺（正整数、上限 7 天）。 */
const asHoldMs = (value) => {
  const n = asFiniteNumber(value);
  return n !== undefined && Number.isSafeInteger(n) && n >= 1 && n <= 7 * 24 * 3600 * 1000 ? n : undefined;
};

/**
 * 〔第211件·从 `real-adapter.js` 整段搬入，语义一字未改〕读不懂信封的**结构**：`{ 键名 -> 值类型 }`，
 * 唯一生产者是 `server-msg.js` 的 `serverMsgShape()` / `serverMsgArgsShape()`。
 * 这里只做一件事——挡住"把任意对象当结构塞进诊断链"：键名过同一张字符合法性表（含那几个 `__`/`?键` 汇总键），
 * 值只许是类型串（`string(12)` 这种）或汇总用的整数；其余一律丢。
 * 一个真实值都不可能被放行，因为生产者早就把值折成类型与长度了（官方参数槽里常是玩家昵称）。
 * ⚠️ 住在这里（而不是 real-adapter）的理由：`LOGIN_DIAGNOSTIC_FIELDS` 的 `serverMsgArgsShape` 一项要认它，
 * 而那份清单**不许有第二处手写搬运**（real-adapter 依赖本文件，反向 import 会成环）。
 * 与 run 216 那条一手账同族：`taskDly.recv` 回了 `{codeOfLangJs, msg}` 我们读不懂，
 * ws 层把形状挂上了错误，搬运层没这一格 ⇒ 落库 `detail.serverMsgShape = null`，至今定不了性。
 */
const SHAPE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,23}$/;
const SHAPE_SUMMARY_KEYS = new Set(["?键", "__另", "__数组长度", "__形态"]);
const SHAPE_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9()]{0,31}$/;
const SHAPE_MAX_KEYS = 10;

export function diagnosticShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out = {};
  for (const [key, raw] of Object.entries(value).slice(0, SHAPE_MAX_KEYS)) {
    if (!SHAPE_KEY_PATTERN.test(key) && !SHAPE_SUMMARY_KEYS.has(key)) continue;
    if (typeof raw === "string" && SHAPE_TYPE_PATTERN.test(raw)) out[key] = raw;
    else if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) out[key] = raw;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * **登录诊断的唯一规格表**（37B）。
 *
 * 一份数组**同时驱动**：白名单、取值分支、`RealGameError` 构造层的转发、以及搬运。
 * ⇒ 从此**不许再有第二处手写键名**——那一族「整层蒸发」的唯一成因就是构造层漏了一格（已犯六次）。
 * 每项＝`{key, build(value)}`；`build` 返回 `undefined` 表示"这一格不收/读不到"。
 */
export const LOGIN_DIAGNOSTIC_FIELDS = Object.freeze([
  // ── 官方登录结论（34C/37A 的口径：code 不在候选位里，读不到就是"没有"）──
  // 37B：`loginCode` 连 **0** 也不收（0 不是码，它正是"读不到却显示 0"那族的形状）。
  { key: "loginCode", build: (v) => {
    const n = asFiniteNumber(v);
    return n === undefined || n === 0 ? undefined : n;
  } },
  { key: "loginCodeKey", build: (v) => asShortWord(v, /^[A-Za-z_][A-Za-z0-9_.]{1,40}$/) },
  { key: "loginKind", build: (v) => (LOGIN_KINDS.has(v) ? v : undefined) },
  { key: "loginReason", build: (v) => asShortWord(v, /^[a-z_]{3,32}$/) },
  { key: "retryable", build: asBoolean },
  { key: "stopAccount", build: asBoolean },
  { key: "needsUserAction", build: asBoolean },
  // ── 打到的域 / 一次请求与响应的读数（第 30/33/36 件）──
  { key: "sdkHostUsed", build: (v) => asShortWord(v, /^[a-z0-9.-]{4,60}$/) },
  { key: "sdkStatusEnum", build: (v) => (v === "success" || v === "非success" || v === "没有这一格" ? v : undefined) },
  { key: "sdkUrlParsed", build: asBoolean },
  { key: "sdkUrlHasToken", build: asBoolean },
  { key: "sdkUrlHasOpenId", build: asBoolean },
  { key: "sdkContentBytes", build: asFiniteNumber },
  // [38B] 「本来就没有这一格」与「是空串」是两件事（前者 0 是假值、后者 0 是真值）。取值只许这三个词。
  { key: "sdkContentState", build: (v) => (v === "有内容" || v === "空串" || v === "没有这一格" ? v : undefined) },
  // [38C] **官方自己给的那句人话原因**（只从白名单键名取、值过凭据掩码、≤40 字）。
  //   ⚠️ 红线：这里只许搬官方给的短句；**绝不许我们自己拼一句解释冒充官方话**（错误清单第 8 条）。
  { key: "sdkRemoteNote", build: sanitizeRemoteNote },
  { key: "officialErrorNote", build: sanitizeOfficialErrorNote },
  { key: "officialErrorRedacted", build: asBoolean },
  { key: "officialErrorTruncated", build: asBoolean },
  // [39C·C3] `_ip` 那一格为什么空着（中文短句；白名单式：只放行中文/字母数字/常见标点与空格，≤80 字，别的一律不收。
  //   这一格**是我们自己写的固定话**，不是官方文本，所以按"形状白名单"收就够了。）
  { key: "sdkIpNote", build: (v) => (typeof v === "string" && v.length > 0 && v.length <= 80
    && /^[\u4e00-\u9fa5A-Za-z0-9_:：（）()，。、；;「」\-. ]+$/.test(v) ? v : undefined) },
  { key: "sdkRequestShape", build: (v) => {
    const shape = v && typeof v === "object" ? v : null;
    if (!shape) return undefined;
    // [38A] 准入放宽成「原始形状**或**已建形状都收」：生产要过**两遍**清单
    //   （第一遍 real-adapter.js:347 `diagnosticMetadata`，第二遍 RealGameError 构造层 :282），
    //   而第一遍的产物里**没有「键名」**（那是刻意的：日志不需要 14 个键名，且已建形状就是最终形状）。
    //   旧版只认 `Array.isArray(shape["键名"])` ⇒ 第二遍返回 undefined ⇒ **整格蒸发**（这一族第七次）。
    //   ⇒ 修完的性质：`build(build(x))` 与 `build(x)` **逐字节相同**（幂等，由 test:login-diagnostics ⑤ 全表锁死）。
    if (!Array.isArray(shape["键名"]) && !Array.isArray(shape["缺哪些"]) && !Array.isArray(shape["多哪些"])) return undefined;
    const asKeys = (list) => (Array.isArray(list) ? list.filter((one) => /^[A-Za-z][A-Za-z0-9_]{0,32}$/.test(String(one))) : []);
    const 键数 = asFiniteNumber(shape["键数"]);
    const out = { 缺哪些: asKeys(shape["缺哪些"]), 多哪些: asKeys(shape["多哪些"]) };
    // [37B] 键数**读不到就整格不打**（绝不写 0——0 与"没读到"是两件事）。
    if (键数 !== undefined) out.键数 = 键数;
    return out;
  } },
  // ── 响应体键名 / status 形状 / 33 件那几条 ──
  { key: "loginResponseKeys", build: (v) => (Array.isArray(v)
    ? (v.filter((one) => /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(String(one))).slice(0, 24).length
      ? v.filter((one) => /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(String(one))).slice(0, 24) : undefined)
    : undefined) },
  { key: "loginStatusKind", build: (v) => (typeof v === "string" ? v.slice(0, 40) : undefined) },
  { key: "loginUrlParsed", build: asBoolean },
  { key: "loginUrlHasToken", build: asBoolean },
  { key: "loginUrlHasOpenId", build: asBoolean },
  { key: "loginContentBytes", build: asFiniteNumber },
  // ── 〔第211件·方案 §18.3〕「官服对这一发回了话没有」的结构化结论 ──
  // 病根（一手现读）：`ws.js`／`node-world.js`／`chrome-world.js` 把这一眼挂上错误之后，
  // `real-adapter.diagnosticMetadata` 也算出来了，**却死在 `RealGameError` 构造层**——构造器只搬
  // 手写清单与这张表，两样都不含下面这几格 ⇒ 写闸 `_answeredByServer` 读到的是"没有这一格"，
  // 明确的官方拒绝被记成 `transport_unknown` 并冻住整号（生产 #30 pearlPlace.hire／#29 orderCustomer.genOrder 两笔）。
  // 四枚旗标各说各的事、不合并：`worldAnswered`＝映射层汇总的"对这一发回了话"；
  // `serverMsgAnswered`＝传输层自己那一挂；`worldRejected`＝带数字裁决码的当面拒；
  // `envelopeRejected`＝回了但读不懂——闸那把尺**第一条**就靠它把"读不懂"从"回了话"里排除，
  // 少了它，"读了不懂"与"没回话"在下一层就再也分不开（方案 §18.3 第 5 条的未知保护依赖这一格活着）。
  // 全部走 `asConfirmedAnswerFlag`：读不到就整格不打，绝不写 false 冒充「没回话」。
  { key: "worldAnswered", build: asConfirmedAnswerFlag },
  { key: "serverMsgAnswered", build: asConfirmedAnswerFlag },
  { key: "worldRejected", build: asConfirmedAnswerFlag },
  { key: "envelopeRejected", build: asConfirmedAnswerFlag },
  // 官方在参数槽里给的"还要等多久"与参数形态（第109件·补2 的采集端早已把它挂上错误；
  // 从前同样死在构造层 ⇒ 冻结账本与客户屏那行只能退回自己编的默认值）。
  { key: "serverMsgHoldMs", build: asHoldMs },
  { key: "serverMsgArgsShape", build: diagnosticShape },
]);

/** 清单里的键名（构造层/守卫都引用它，**不许再手写第二份**）。 */
export const LOGIN_DIAGNOSTIC_KEYS = Object.freeze(LOGIN_DIAGNOSTIC_FIELDS.map((one) => one.key));

/** 按唯一清单搬运：读不到就整格不打（绝不写 0 / false 冒充）。 */
export function loginDiagnosticFields(error) {
  const out = {};
  for (const one of LOGIN_DIAGNOSTIC_FIELDS) {
    const raw = error?.[one.key];
    if (raw === undefined) continue;
    const built = one.build(raw);
    if (built !== undefined) out[one.key] = built;
  }
  return out;
}

/**
 * 「本机就没发出去」那一类失败：设备档案 / 凭据没配好时，登录请求在**构造阶段**就被拒了
 * （错误文案里那句「未消耗任何登录机会」就是它）。
 *
 * 放在这个**两边都依赖**的公共模块里，是因为两端都要用它、而它们互相 import 会成环：
 *   · 核验链（account-verify）用它把失败定成 `server_setup` 档；
 *   · 托管链（real-adapter）用它决定「这笔重登记录要不要还回去」——
 *     2026-09-19 云上首用踩过：服务器缺设备档案那次登录**一次都没发出去**，却占掉 5 分钟重登间隔，
 *     用户改好配置再点一次，被自己的节奏闸门拦住。
 */
export function isServerSetupFailure(error) {
  const code = String(error?.code || "");
  return code === "REAL_DEVICE_ID_MISSING"
    || code === "REAL_V5_BODY_SHAPE_MISMATCH"
    || code === "REAL_GAME_IDENTITY_REQUIRED"
    || code === "REAL_CREDENTIALS_MISSING";
}

/* ---------- [第25件·2026-09-23 A] 官方原始码的**可查落盘**（白名单式：只允许枚举名／数字／键名） ----------
 *
 * 病根：run 148（2026-09-23 12:35:45）那个号在渠道登录被官方拒，而**官方原始码没落在任何可查处**——
 * 我们的包装码 REAL_SDK_LOGIN_FAILED 只说「没走完」，分不出是顶号、封禁还是限流；
 * 于是「要不要重试」只能靠猜，而反复撞风控本身就是最强的自动化特征。
 * 从这里以后：能分类就把**官方码与分类**落到 run_logs 的 code／detail；分不了也留一行「读不到」。
 * ⚠️ 白名单铁律：只允许 枚举名／数字码／状态／**键名**（body 的键名，不是值）——
 *    token、open_id、content、响应体原文一律不许进日志（凭据不外发）。
 */

/** 落日志用的官方码标签：LOGIN_2004_user_ban（表外数字码 ⇒ LOGIN_1234_unlisted；没有码 ⇒ null）。 */
export function loginCodeLogTag(error) {
  const raw = error?.loginCode;
  // ⚠️ `Number(null) === 0`：不显式挡空值，没码的错误会得到一条**假的** `LOGIN_0_unlisted`
  //（「读不到却显示 0」那一族；凡数字判据先挡空值——第 26 件 A 当场抓到这条自己写出来的）。
  if (raw === null || raw === undefined || raw === "") return null;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return null;
  // [38E] **0 不是码**（防御性挡：正常情况下上游 `describeLoginError` 已不再产出 0，
  //   但这一格是落 run_logs 的那个 tag，宁可多一道；0 一旦漏进去就会变成 `LOGIN_0_unlisted` 这种假标签）。
  if (numeric === 0) return null;
  const named = typeof error?.loginReason === "string" && /^[a-z_]{3,32}$/.test(error.loginReason)
    ? error.loginReason
    : null;
  const name = named || LOGIN_ERROR_CODES[numeric]?.name || "unlisted";
  return "LOGIN_" + numeric + "_" + name;
}

/** 白名单式的官方诊断块：只带数字码、枚举名、状态与**键名**，任何值都不穿过。 */
export function loginCodeLogDetail(error) {
  const out = {};
  const raw = error?.loginCode;
  // 同上：空值不许变成「官方码 0」——读不到就**不打这一格**。
  const hasCode = raw !== null && raw !== undefined && raw !== "" && Number.isFinite(Number(raw));
  const numeric = hasCode ? Number(raw) : null;
  if (hasCode) {
    out["官方码"] = numeric;
    out["官方名"] = String(error?.loginReason || LOGIN_ERROR_CODES[numeric]?.name || "unlisted").slice(0, 32);
    const zh = LOGIN_ERROR_CODES[numeric]?.zh;
    if (zh) out["官方中文"] = String(zh).slice(0, 40);
  }
  if (typeof error?.loginKind === "string" && LOGIN_KINDS.has(error.loginKind)) out.kind = error.loginKind;
  // [第26件·2026-09-23 A] **这个码取自响应体的哪个键**——判「是哪一层的数」就靠它（run 149 缺这一格）。
  // 37A：**读不到一律「—」，绝不用 0 冒充**；键名那格读不到就写「没有」（客户/复核一眼能看出是"没读到"）。
  if (typeof error?.loginCodeKey === "string" && /^[A-Za-z_][A-Za-z0-9_.]{1,40}$/.test(error.loginCodeKey)) out["码所在键"] = error.loginCodeKey;
  else if (!hasCode) out["码所在键"] = "没有";
  if (!hasCode) out["官方码"] = "—";
  // [36A] 三格读数：请求体键名差集 ＋ 响应四件（只落键名/布尔/长度/枚举）
  if (error?.sdkRequestShape) out["请求键差集"] = error.sdkRequestShape;
  if (typeof error?.sdkStatusEnum === "string") out["status枚举"] = error.sdkStatusEnum;
  if (typeof error?.sdkUrlParsed === "boolean") out["url可解析"] = error.sdkUrlParsed;
  if (typeof error?.sdkUrlHasToken === "boolean") out["url有token"] = error.sdkUrlHasToken;
  if (typeof error?.sdkUrlHasOpenId === "boolean") out["url有open_id"] = error.sdkUrlHasOpenId;
  // [38B] 「没有这一格」时**不许打 0**（旧写法 `Number.isFinite(Number(null)) === true` ⇒ 空值一路印成 0）：
  //   字节数只在真拿到字符串时才是数字；是哪一档由紧邻的「content格」说明。
  const contentBytes = asFiniteNumber(error?.sdkContentBytes);
  if (contentBytes !== undefined) out["content字节"] = contentBytes;
  if (typeof error?.sdkContentState === "string") out["content格"] = error.sdkContentState;
  // [第29/30件] 打的是哪个域（失败时也要有——否则分不清是哪个域回的码）
  if (typeof error?.sdkHostUsed === "string" && /^[a-z0-9.-]{4,60}$/.test(error.sdkHostUsed)) out["打到的域"] = error.sdkHostUsed;
  // [38C] **官方自己那句人话原因**（值已过掩码与截断，见规格表）。打不到这一格＝官方一个字都没给，不是我们没看。
  if (typeof error?.sdkRemoteNote === "string") out["官方那句"] = error.sdkRemoteNote;
  // [39C·C3] `_ip` 那一格为什么空着（我们自己写的中文短句，不是官方话）
  if (typeof error?.sdkIpNote === "string") out["_ip来源"] = error.sdkIpNote;
  const http = Number(error?.httpStatus ?? error?.statusCode);
  if (Number.isFinite(http) && http >= 100 && http <= 599) out.http = http;
  const remote = asFiniteNumber(error?.remoteStatus);
  if (remote !== undefined) out["官方status"] = remote;
  const keys = diagnosticKeyNames(error);
  if (keys.length) out["body键名"] = keys;
  return out;
}

/** 读不到可识别码时那一句人话（读不到就说读不到，不许留空让人以为没发生）。 */
export function loginCodeMissingNote(error) {
  const http = Number(error?.httpStatus ?? error?.statusCode);
  const keys = diagnosticKeyNames(error);
  return "官方没回可识别的码（http=" + (Number.isFinite(http) ? http : "没读到")
    + "，body 键名=" + (keys.length ? keys.join("/") : "没读到") + "）";
}

/** body 的**键名**（只搬键名、不搬值）；官方响应键名是纯 ASCII 短词。 */
function diagnosticKeyNames(error) {
  const out = [];
  for (const field of [error?.responseKeys, error?.dataKeys]) {
    if (!Array.isArray(field)) continue;
    for (const one of field) {
      const text = typeof one === "string" ? one : "";
      if (/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(text) && !out.includes(text)) out.push(text);
      if (out.length >= 12) return out;
    }
  }
  return out;
}

/**
 * [第25件·2026-09-23 B] 这一次登录失败**该怎么处置**（能不能重试、冻结多久）——**唯一判据出口**。
 * 恢复计划（run-recovery）与冻结账本（real-adapter）都调它，不许各写一份。
 *   · 认出 kind（error.loginKind 由 attachLoginOutcome 挂上）⇒ 用码典那一档的策略；
 *   · 认不出 kind、但错误本身确实是**登录层**失败（REAL_SDK_LOGIN_FAILED 这种包装码）⇒
 *     按 unknown 档：**不自动重试、等人工**（绝不许当成 throttle 反复撞）；
 *   · 跟登录无关的错误 ⇒ 返回 null，调用方沿用既有策略。
 */
export function loginOutcomePolicyOf(error) {
  // [第109件·2026-10-03] 世界服给出的**账号级文案裁决**优先点名（现读只有一条：97778 数据异常修复中）。
  // 排第一是因为它曾被 `real-adapter.js` 那条含「登录」的正则抢走、包装成「会话过期，需要重新登录」——
  // 一句话把"官方让你等"说成"你再登一次就好"，正是本仓禁止的那种假话。
  const worldVerdict = worldMsgRiskVerdictOf(error?.serverMsgCode);
  if (worldVerdict) {
    const policy = LOGIN_OUTCOME_POLICIES[worldVerdict.kind] || LOGIN_OUTCOME_POLICIES.blocked;
    // 官方在参数槽里说了多久，就用多久（用户点名的那件事：别人屏上「封禁 5 分钟」是官方给的数）。
    // 读不到才退回码典里的 minutes——并且**如实标来源**，屏上那句会跟着换措辞（"官方说"vs"我们等"）。
    const officialMinutes = clampMinutes(Number(error?.serverMsgHoldMs) / 60000);
    return {
      kind: worldVerdict.kind,
      name: worldVerdict.name,
      code: worldVerdict.code,
      retryable: policy.retryable === true,
      minutes: officialMinutes ?? asFiniteNumber(worldVerdict.minutes) ?? asFiniteNumber(policy.minutes) ?? null,
      minutesSource: officialMinutes ? "官方回包给的" : "我们兜底定的",
      officialHoldMs: officialMinutes ? Math.round(officialMinutes * 60000) : null,
      stopAccount: true,          // 这一族必须写重登冻结（跨进程、跨重启），点启动也撞不到风控
      needsUserAction: true,
      source: "worldMsgVerdict",
    };
  }
  const kind = typeof error?.loginKind === "string" ? error.loginKind : null;
  if (kind && LOGIN_OUTCOME_POLICIES[kind]) {
    const policy = LOGIN_OUTCOME_POLICIES[kind];
    return {
      kind,
      name: typeof error?.loginReason === "string" ? error.loginReason : null,
      // [39A·c] 走 `asFiniteNumber`（先挡 null/undefined/"" 再转）：旧写法 `Number(null) === 0` 会在这里造出假 0。
      //   当前两个消费方都不读 `.code`（real-adapter.js:878 用 `> 0` 判、run-recovery.js:130 用 `|| 15`），
      //   即"关掉一处地雷"，不是"修掉一个已上屏的假 0"。
      code: asFiniteNumber(error?.loginCode) ?? null,
      retryable: policy.retryable === true,
      minutes: asFiniteNumber(policy.minutes) ?? null,
      stopAccount: policy.stopAccount === true,
      needsUserAction: policy.needsUserAction === true,
      source: "loginKind",
    };
  }
  if (isLoginLayerFailure(error)) {
    const policy = LOGIN_OUTCOME_POLICIES.unknown;
    return {
      kind: "unknown",
      name: null,
      // [39A·c] 同上：`asFiniteNumber` 先挡空值，堵掉 `Number(null) === 0` 这一族。
      code: asFiniteNumber(error?.loginCode) ?? null,
      retryable: false,
      minutes: null,
      stopAccount: false,
      needsUserAction: true,
      source: "loginLayerNoCode",
    };
  }
  return null;
}

/** 这一条失败是不是**登录层**的（认不出 kind 时用包装码兜底判）。 */
const LOGIN_LAYER_FAILURE_CODES = Object.freeze(new Set([
  "REAL_SDK_LOGIN_FAILED",
  "REAL_LOGIN_FAILED",
  "REAL_LOGIN_TIMEOUT",
  "REAL_ACCOUNT_BLOCKED",
  "REAL_ACCOUNT_CREDENTIAL_REJECTED",
]));
export function isLoginLayerFailure(error) {
  return LOGIN_LAYER_FAILURE_CODES.has(String(error?.code || ""));
}
