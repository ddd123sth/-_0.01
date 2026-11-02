// 自动化脚本配置 Schema —— 与站点「设置」面板一一对应
// type: switch | number | select | range | multiselect | time | order | text | textarea
//
// [2026-09-23 第 21 件·补] 节奏那四格「填 0 是什么意思」的说法由下面几个助手现算，数字取自
// `human-pacing.js` 的档位表（**绝不手写**：改了档位表，屏上跟着变）。客户屏不许出现
// 「闸门／拟人／进程」这类行话（customer-copy 的禁用词表在管），所以统一说「操作节奏」。
import { GAP_FLOOR_MS, HUMAN_POLICY_PRESETS } from "./game/human-pacing.js";
// [第119件·B5·2026-10-06] 「公会竞赛」卡面上那些数字（各档接取名额、元宝刷三档价钱与保底竞赛币、
// 视频每日上限、买名额单价与上限、升级冷却分钟数、最高分数档）**一律从官方还原表现读**（判据出处
// `memory/plan-1004-guild-race-full.md` 第 0 节＋附录：c_fmlRace／c_fmlRaceTask 元行／c_share／c_flower），
// 与上面节奏那四格「从 HUMAN_POLICY_PRESETS 现算」同一先例——表一改版，屏上那句话跟着变，绝不手写裸数字。
// 表读不到 ⇒ 对应句子改说「读不到」，不许把上一次的数字冻进源码（铁律 8 第 5 条：读不到就说读不到）。
import { loadOfficialCfgTable } from "./game/official-cfg.js";

/**
 * [第119件·B5] 公会竞赛卡面取数（一次读齐，逐键 fail-closed：任何一格缺／脏 ⇒ 该键 null）。
 * 数字含义与出处：$refreshCost／$pondShow＝`c_fmlRaceTask` 元行（官方 2515/2516 逐字：那两个保底数是
 * **竞赛币**、不是分数——旧标签写「保底14分」是假话，本批连标签一起改）；$refresh＝视频刷新那条
 * `c_share` 的行号（不写死 18）；$giveUpTime＝放开冷却分钟；taskNum／taskBuyNum／taskCost＝`c_fmlRace` 档位行；
 * topScore＝`c_flower.fmlRacePoint` 去重档位的最高一档（2551 那句「满N分好牌」里的 N 现读）。
 */
function guildRaceCfg() {
  const fml = loadOfficialCfgTable("c_fmlRace");
  const raceTask = loadOfficialCfgTable("c_fmlRaceTask");
  const shareTable = loadOfficialCfgTable("c_share");
  const flowerTable = loadOfficialCfgTable("c_flower");
  const meta = raceTask && typeof raceTask === "object" ? raceTask["-1"] : null;
  const intArray = (value) => (Array.isArray(value) && value.every((one) => Number.isInteger(one) && one > 0) ? value : null);
  const refreshCost = intArray(meta?.$refreshCost);
  const pondShow = intArray(meta?.$pondShow);
  const shareId = Number.isInteger(Number(meta?.$refresh)) && Number(meta.$refresh) > 0 ? Number(meta.$refresh) : null;
  const shareRow = shareId !== null && shareTable && typeof shareTable === "object" ? shareTable[String(shareId)] : null;
  const shareLimit = Number.isInteger(Number(shareRow?.limit)) && Number(shareRow.limit) > 0 ? Number(shareRow.limit) : null;
  const giveUpMin = Number.isInteger(Number(meta?.$giveUpTime)) && Number(meta.$giveUpTime) > 0 ? Number(meta.$giveUpTime) : null;
  const tierNames = [];
  const tierCounts = [];
  if (fml && typeof fml === "object") {
    for (let lvl = 1; lvl <= 4; lvl += 1) {
      const row = fml[String(lvl)];
      tierNames.push(row && typeof row.raceRankName === "string" && row.raceRankName ? row.raceRankName : null);
      const n = Number(row?.taskNum);
      tierCounts.push(Number.isInteger(n) && n > 0 ? n : null);
    }
  }
  const tierQuotaSentence = tierNames.every(Boolean) && tierCounts.every((one) => one !== null)
    ? "游戏给的条数：" + tierNames.map((name, index) => `${name}级 ${tierCounts[index]} 条`).join("、")
    : null;
  const row1 = fml && typeof fml === "object" ? fml["1"] : null;
  const taskBuyNum = Number.isInteger(Number(row1?.taskBuyNum)) && Number(row1.taskBuyNum) > 0 ? Number(row1.taskBuyNum) : null;
  const taskCost = Number.isInteger(Number(row1?.taskCost)) && Number(row1.taskCost) > 0 ? Number(row1.taskCost) : null;
  let topScore = null;
  if (flowerTable && typeof flowerTable === "object") {
    const bands = new Set();
    for (const row of Object.values(flowerTable)) {
      const n = Number(row && row.fmlRacePoint);
      if (Number.isInteger(n) && n > 0) bands.add(n);
    }
    if (bands.size > 0) topScore = Math.max(...bands);
  }
  return { refreshCost, pondShow, shareLimit, giveUpMin, tierQuotaSentence, taskBuyNum, taskCost, topScore };
}
const RACE_CFG = guildRaceCfg();
/** 竞赛卡面句子用的「满N分」：现读最高分数档；读不到就说「最高那一档」，绝不显 0（铁律 8 第 5 条）。 */
const RACE_TOP_SCORE_ZH = RACE_CFG.topScore !== null ? `满 ${RACE_CFG.topScore} 分` : "满最高那一档";
/** 三档价钱与保底竞赛币那句（§5.1「用元宝刷新」行的数字全部现读）。 */
function raceRefreshPriceZh() {
  const { refreshCost, pondShow } = RACE_CFG;
  if (!refreshCost || !pondShow || refreshCost.length < 3 || pondShow.length < 2) {
    return "三档价钱与保底竞赛币的数这一刻没从游戏表里读到——没读到就一档都不自动刷，屏上会照实说「没读到」";
  }
  return `三档价格从游戏表里读：${refreshCost[0]} 元宝随意重刷；${refreshCost[1]} 元宝必定刷出不低于 ${pondShow[0]} 个竞赛币的；${refreshCost[2]} 元宝必定刷出不低于 ${pondShow[1]} 个竞赛币的`;
}
/** 放开冷却那句（$giveUpTime 现读；读不到就说「要等一会儿」，不显 0）。 */
const RACE_GIVEUP_COOLDOWN_ZH = RACE_CFG.giveUpMin !== null ? `每放一次要等 ${RACE_CFG.giveUpMin} 分钟才能再放第二条` : "每放一次要等一会儿才能再放第二条（冷却分钟数这一刻没读到）";
/** 买名额单价与每档上限（`c_fmlRace` 行现读；读不到就不写数）。 */
function raceBuyPriceZh() {
  const { taskCost, taskBuyNum } = RACE_CFG;
  if (taskCost === null || taskBuyNum === null) {
    return "买一次多一个名额，收多少元宝、每档最多买几次，这一刻没从游戏表里读到——读不到就一次都不买";
  }
  return `买一次多一个名额，游戏收 ${taskCost} 元宝，每一档最多买 ${taskBuyNum} 次`;
}
/**
 * [第119件·定案 C] 「可以买哪些东西」的候选池＝官方材料商店（shopCultivate）上架的全部货品，
 * 物品名从 `c_item` 现读。**id 空间＝背包物品号**（与 `race-goal-map.js` 的白名单闸同一把尺）；
 * 物品号→货架行号（`shopCultivate.buy` 的实参）的映射判据待实服取证（计划册 §8 W0 第 5 条同源），
 * 取证落地前这一格只当「相不相」的白名单用，真买的发写形状归 W 批。表读不到 ⇒ 选项空＝一格都勾不了
 * （fail-closed：勾不了就不会被买；行上的「没读到」由 emptyNote 说清）。
 */
function racePurchasableOptions() {
  const shop = loadOfficialCfgTable("c_shop_cultivate");
  const items = loadOfficialCfgTable("c_item");
  if (!shop || typeof shop !== "object" || !items || typeof items !== "object") return [];
  const seen = new Map();
  for (const [rowId, row] of Object.entries(shop)) {
    if (rowId === "-1" || !row || !Array.isArray(row.items)) continue;
    for (const pair of row.items) {
      const itemId = Array.isArray(pair) ? Number(pair[0]) : NaN;
      if (!Number.isInteger(itemId) || itemId <= 0 || seen.has(itemId)) continue;
      const name = String(items[String(itemId)]?.name || "").trim();
      seen.set(itemId, name !== "" ? name : "物品 " + itemId);
    }
  }
  return [...seen.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([value, label]) => Object.freeze({ value, label }));
}
const RACE_PURCHASABLE_OPTIONS = Object.freeze(racePurchasableOptions());

/** 〔10-07 追记24 用户令「有些号只想接某一些花的任务／培育、升级鲜花、好友偷花这一类」〕
 *  「只接这几类任务」的名单：现读 `c_fmlRaceTask` 的 type 列（现读恰 13 个）＋ `c_task_type` 的官方中文名。
 *  表读不到 ⇒ 空名单＝那一格没得勾（不按类型挑，fail-open 回旧行为——宁可少一格选择，不挡住接取）。 */
function raceTaskTypeOptions() {
  const raceTask = loadOfficialCfgTable("c_fmlRaceTask");
  const typeTable = loadOfficialCfgTable("c_task_type");
  if (!raceTask || typeof raceTask !== "object" || !typeTable || typeof typeTable !== "object") return [];
  const ids = [...new Set(Object.entries(raceTask)
    .filter(([rowId]) => rowId !== "-1")
    .map(([, row]) => Number(row && row.type))
    .filter((one) => Number.isInteger(one) && one > 0))].sort((a, b) => a - b);
  return ids.map((id) => {
    const name = String(typeTable[String(id)]?.name || "").trim();
    return Object.freeze({ value: id, label: name !== "" ? name : "任务类型 " + id });
  });
}
const RACE_TASK_TYPE_OPTIONS = Object.freeze(raceTaskTypeOptions());

/* ── 公会竞赛「?」弹层定稿文案（唯一出处＝`memory/plan-1004-guild-race-full.md` §5.1；
 *    两处刻意的与定稿不同，逐条写在行上注释里：①定稿里带身份称谓的那句（验收 5 禁这类字样，
 *    定案 G 的口径就是面板上不认身份只认勾了哪几把）改成中性说法、含义一字不差；②「好任务也照样重刷」那格
 *    **管满最高分档**——旧注释说「不含满最高分档（定案 J 停＋报）」已作废：停手档 10-06 深夜退役后
 *    官方 2551 确认框回到自己名下（B3 实现为准：三档警告一把尺），句子照事实写。── */
const RACE_TAKE_HINT = "每次先看今天还剩几个接取名额（"
  + (RACE_CFG.tierQuotaSentence !== null ? RACE_CFG.tierQuotaSentence + "，另外买的不算在内" : "游戏给的条数从表里读，这一刻没读到就一条都不接")
  + "），再从公会的任务池里挑一条接。挑的时候三样一起看：这朵花你解锁了没有、分数落在你填的范围里、这一条在它给的时间里你做得完做不完。做不完就不接——接了做不动会白占一个名额直到过期。接取不看成员名单：这一期开始之后才进公会的新号也照常能接（游戏只在放弃那一下把任务刷成低分——放弃侧的规矩写在「把这条放给自家号做」那格）。别人花元宝升级过的任务一律不接（你 10-06 定的规矩）；只有自家号升级放出来的那一条才优先接。";
const RACE_FINISH_HINT = "手上这条做到游戏要求的个数就交回去，游戏把积分和奖励发给你。没做完不交：交过去游戏不认，还白占着名额。";
const RACE_UPGRADE_HINT = "花的是充值来的元宝。升一级要多少是游戏自己算的：升完多给几分，就收三倍的元宝。你号里剩下的元宝必须高于下面填的那条线，不到就不升。⚠️ 这一格打开不等于一定要花钱：还得「每天最多升几条」填了数才动。";
const RACE_UPGRADE_MAX_HINT = "你自己定的今天目标，填 0 就一条都不升。升一条花多少元宝按上面那条规矩当场算，算不出价（表里查不到这一档）就不升，并告诉你为什么。";
const RACE_UPGRADE_KEEP_HINT = "升完这一条之后，号里剩下的元宝不能低于这个数。留不够就一条都不升。这一格只管升级花的元宝；刷新花的元宝有它自己的一格「刷新后元宝至少留」，两格的数互不影响。";
const RACE_GIVEUP_HINT = "这一把和「花元宝把任务升级」「用元宝刷新」是三件各自独立的事：只勾升级不勾这把，就是自己升完自己做；只勾刷新也是自用；勾上这把才会把这条推出去。放出去就是把这条放回公会的任务池：游戏会在行上标好是你升过的，并且保留已经做出来的进度，自家号接住就能接着做。三条游戏的规矩得提前知道：一、" + RACE_GIVEUP_COOLDOWN_ZH
  + "；二、这个号如果是这一期开始之后才进公会的，放出去会被游戏直接刷成低分任务，那这笔元宝就白花了，所以这种号一条都不放；三、已经做完的任务不能放，只能交。"
  + "⚠️ 这一把和「优先接自家号放出来的任务」只能开一个：一个号只管一个方向——把升级过的任务放出去，或者接住自家号放出来的任务，一放一接分开放在两个号上，谁在放、谁在接一眼就看得清。那边开着的时候这一把会锁住点不动；要换过来，先把那边关掉。";
const RACE_RELAY_TAKE_HINT = "先去接自家号升级过、还没人接的那一条，再接别的。公会的任务池是全公会共用的一份，别的会友也可能同时来抢；抢不到会在屏上照实说这一条被谁接走了，不会偷偷换成别的凑数。别人花元宝升级过的任务这一格也永远不接——它只找自家放出来的那一条。⚠️ 这一把和「升完就放给绑定的自家号」只能开一个——那边开着的时候这一把会锁住点不动；要换过来，先把那边关掉。";
/** 〔10-07 用户实屏裁定「他不就应该互斥吗，开了这个不能开那个，这样客户看着才合理啊」〕
 *  「升完就放」与「优先接自家号放出来的任务」共用的**互斥说明**（机制照 09-25 加速卡那一对的先例）。
 *  唯一出处就是这里：被锁住那一行「为什么点不动」画的是这一句（`hosting-model.js`/`capabilities.js`
 *  的 `exclusiveNote` 通道），保存那一路把对方落回关时回报的也是这一句（`api-user.js` → `clearExclusiveRival`）。
 *  ⚠️ 纯中文、无行话（铁律 8 第 1 条）；「为什么只能开一个」的原因必须写进来（第 3 条）。 */
const RACE_ROLE_EXCLUSIVE_NOTE = "「升完就放给绑定的自家号」和「优先接自家号放出来的任务」只能开一个：一个号只管一个方向——把升级过的任务放出去，或者接住自家号放出来的任务，一放一接分开放在两个号上，谁在放、谁在接一眼就看得清。要换过来，先把开着的那一把关掉，这一把就能勾了。";
const RACE_REFRESH_COIN_HINT = raceRefreshPriceZh() + "。⚠️ 花的是元宝。⚠️ 游戏里这个按钮只能重刷自己已经接住的这一条——手上没任务时点它没有反应，所以刷之前要先占住一个接取位，不能站在池子里挑。如果这条已经升过、已经做了一部分，或者本来就是"
  + RACE_TOP_SCORE_ZH + "的好牌，游戏都会先问你一句确定要重刷吗——重刷就是把这些丢掉，所以这几种情况默认不动；要动请另外打开下面那一格。刷是自己用，放给别人做是「升完就放给绑定的自家号」那一格，两件事互不牵连。";
const RACE_IGNORE_WARN_HINT = "打开就等于替你把游戏那句“确定要重刷吗”点了确定：已经升级过的、已经做了一半的、已经是最高分档的，都照样重刷。开着这一格时刷坏了不算程序出错，屏上会照实记当时是哪一种。"
  + "⚠️ 重刷升级过的行＝把那笔升级丢掉；这三类要不要放行由你自己定。";
const RACE_SCORE_MIN_HINT = "先接住一条，分数低于这个数就重刷手上这条，到了就不刷、照做照交；填 0 就是不设线，接到哪条做哪条。三件事要知道：一、这是拿一个接取位去换重掷机会（游戏只能刷自己手上那条）；二、每刷一次按你选的档花元宝，三档价钱从游戏表里读；三、还没够线之前这条是没做完的，别为了等一条理想的把今天能接的几次都刷光。到了当天次数上限还没够线，就把现在这条做完交掉。";
const RACE_REFRESH_KEEP_HINT = "刷完之后号里的元宝不能低于这个数；留不够，这一次就不刷。这一格只管刷新花的元宝；升级花的元宝有它自己的一格「升级后元宝至少留」，两格的数互不影响。";
/** 〔10-07 追记23 用户令「这里需要是复选框，可以选择多种条件」〕多选档位的「?」说明。
 *  梯子规则与 `guild-race-refresh.js` 的 `pickRaceRefreshTier` 逐字同源（改口径必须两处一起改）。 */
const RACE_REFRESH_IDX_HINT = "勾一档或多档都行：只勾一档＝每次都按这一档刷；勾了多档＝第一次用最便宜的那档，每刷一次升一档，升到最贵那档就保持——便宜的先试手气，贵的在后面保底。一个都不勾＝不用元宝刷。三档的价钱与「必定刷出不低于几个竞赛币」那句都从游戏表里现读，表改了这句跟着变；这一刻读不到就按读不到办（不自动刷）。";
const RACE_REFRESH_LIMIT_HINT = "你自己定的止损：到次数就停手，即使还没刷到达标线。出厂 0＝一次都不刷（这族动作默认关）。「今天已经刷了几次」按当天已认账的笔数算，重启接着数、不会重头来。";
const RACE_AD_FIRST_HINT = "这一格是视频刷新的准入：不勾它，一次视频都不看、只用元宝那一档；勾上它，先"
  + (RACE_CFG.shareLimit !== null ? "把每天那 " + RACE_CFG.shareLimit + " 次不要钱的视频刷用完" : "把每天不要钱的视频刷用完（每天几次这一刻没从表里读到——读不到就一次都不看）")
  + "，还不够再动元宝。⚠️ 开着它等于让脚本替你点游戏里“看一段视频”那个按钮——这是你点过名的动作；每天能看几次由游戏自己算，读不到就一次都不看。";
const RACE_REFRESH_AD_HINT = "走游戏里“看一段视频刷新一次”那个口子，每天最多"
  + (RACE_CFG.shareLimit !== null ? " " + RACE_CFG.shareLimit + " 次（这个数从游戏表里读，不是我们定的）" : "（每天几次这一刻没从表里读到——读不到就一次都不看）")
  + "。这一档不花元宝；能不能看由游戏决定，游戏说今天不能看了就今天一次都不刷。要真去看，上面「先用每天免费的视频次数」那一格也得开着（它是视频档的准入）。";
const RACE_BUY_NUM_HINT = "一个号每天能接几条是游戏给的，" + raceBuyPriceZh() + "。⚠️ 花的是元宝。「每天最多买几个接取名额」填 0 就一次都不买；名额还没用完时也不会去买。";
const RACE_BUY_MAX_HINT = "你自己定的目标：填 0 就一发都不买。游戏每一档最多买几次、一次买几发的上限都从表里读，读不到就一次都不发；单次发数取「游戏剩余额度」与「这格还剩几个」里的小的那个，两个数屏上都看得见。";
const RACE_BOX_HINT = "开着它，做竞赛任务攒下来的宝箱会被自动点开——开箱不花号里任何东西，一次开一只。";
const RACE_PURCHASE_HINT = "有两类竞赛任务要求你到商店买几次东西。买东西这件事默认不替你决定：你勾了哪几样，它才可能为了完成那一类任务去买那几样；一个都不勾，这一类任务直接不接，屏上会说清为什么没接。每买一次记一笔账：买了几件、花了什么、为哪一条任务。⚠️ 其中“到贵宾商店买”的那一类，我们暂时没有这条商店通道，勾了也不接，屏上照实说。";
/** 〔10-07 追记24 用户令〕接取挑单三格的「?」：花朵白/黑名单（只对「指定收获」那类按花号筛）＋类型白名单。 */
const RACE_TASK_FLOWER_ALLOW_HINT = "勾了它，竞赛只接这些花的任务（按任务上写的那朵花算）；一个都不勾＝所有花的任务都接。和你在种花那儿愿意种的花对齐，就不会接到做不出来的任务。⚠️ 只看「指定收获」这一类——「制作花艺品」那些任务挂在花瓶上，读不出是哪几朵花，不吃这份名单。";
const RACE_TASK_FLOWER_DENY_HINT = "勾上的花，竞赛一条都不接它的任务。同一朵花两边（这里和「只接这些花的任务」）都勾着时以这里为准：不接，屏上会照实说。";
const RACE_TASK_TYPES_ALLOW_HINT = "勾了哪几类，就只接哪几类任务；一个都不勾＝不按类型挑（每一类照它自己的通道卡走：那类卡开着才接）。⚠️ 勾了不等于一定接得到：有的类整条通道还没接（比如去贵宾商店买东西那一类），勾了也一条都不接；也有时候是池子里暂时没有这一类可做的。";
const RACE_BUY_HINT = "接取名额用完了才用元宝买（自隐购）：没到上限一次都不花。「每天最多买几个接取名额」填 0＝一发都不买；买一次花多少按表现读，买完当场记账。";
/** 〔10-07 追记23 用户令「这里需要是复选框，可以选择多种条件」〕「用哪些元宝刷新」**三档多选**（原来单选四档、
 *  含一条「不使用」）：价钱与保底竞赛币从 `c_fmlRaceTask` 元行现读（§0：那两个数是**竞赛币**不是分）。
 *  多选语义：勾几档＝允许这几档；每次实际用哪档＝`guild-race-refresh.js` 的 `pickRaceRefreshTier`（逐档加码）。
 *  一个都不勾＝不用元宝刷（就是从前那条「不使用」，不再单列一颗复选框）。 */
function raceRefreshIdxOptions() {
  const { refreshCost, pondShow } = RACE_CFG;
  const cost = (i) => (refreshCost && Number.isInteger(refreshCost[i]) && refreshCost[i] > 0 ? refreshCost[i] : null);
  const pond = (i) => (pondShow && Number.isInteger(pondShow[i]) && pondShow[i] > 0 ? pondShow[i] : null);
  const c0 = cost(0); const c1 = cost(1); const c2 = cost(2); const p0 = pond(0); const p1 = pond(1);
  return Object.freeze([
    Object.freeze({ label: c0 !== null ? `随意重刷（${c0} 元宝）` : "随意重刷（价钱这一刻没读到）", value: "normal" }),
    Object.freeze({ label: c1 !== null && p0 !== null ? `必定刷出不低于 ${p0} 个竞赛币（${c1} 元宝）` : "保底竞赛币档（价钱这一刻没读到）", value: "high8" }),
    Object.freeze({ label: c2 !== null && p1 !== null ? `必定刷出不低于 ${p1} 个竞赛币（${c2} 元宝）` : "更高保底档（价钱这一刻没读到）", value: "high16" }),
  ]);
}
const RACE_REFRESH_IDX_OPTIONS = raceRefreshIdxOptions();
const RACE_MODULE_DESC = "按游戏里那个竞赛任务页办事：接任务、把做完的交回去；也能花元宝把一条任务升得更值钱、用元宝或看视频重刷手上这一条、买接取名额、开攒出来的竞赛宝箱。"
  + "「普通任务／原金任务」的分数范围只管还没接的行：两头都填 0 表示这一类先不接；只填下限＝只接不低于它的；只填上限＝只接不高于它的。"
  + "自家号升级放出来接着做的那一条不受这两档限制；别人花元宝升级过的任务一律不接（这是你定的规矩）。重刷碰上「已经升级过、已经做了一半、或已到满档」这一类好牌，默认先不动、屏上说清挡在哪一样；要照样重刷，得打开「好任务也照样重刷」那一格。";

/** 三档节奏的中文名（与下面 `sel("human_preset")` 的选项名同源）。 */
const CADENCE_ZH = Object.freeze([["conservative", "保守"], ["balanced", "均衡"], ["brisk", "激进"]]);
/** 「保守 N／均衡 M／激进 K」——逐档从档位表现算。 */
function cadenceByPreset(field) {
  return CADENCE_ZH.map(([key, zh]) => zh + " " + Number(HUMAN_POLICY_PRESETS[key][field])).join("／");
}
/** 毫秒 → 客户话的时长（「5 分钟」／「30 秒」）；只读档位表，不手写数字。 */
function cadenceMsZh(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "一会儿";
  if (value % 60000 === 0) return (value / 60000) + " 分钟";
  return Math.round(value / 1000) + " 秒";
}
/** 「保守 30 秒／均衡 5 分钟／激进 2 分钟」——从档位表现算（`reloginMinIntervalMs`）。 */
function cadenceReloginZh() {
  return CADENCE_ZH.map(([key, zh]) => zh + " " + cadenceMsZh(HUMAN_POLICY_PRESETS[key].reloginMinIntervalMs)).join("／");
}
/**
 * 毫秒 → 客户话（亚秒留两位、整秒留一位）。
 * `cadenceMsZh` 会把 180ms 四舍五入成「0 秒」——那种数正好都在一秒以下，所以另开一把。
 */
function gapMsZh(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "没这么算过";
  if (value < 1000) return (Math.round(value) / 1000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "") + " 秒";
  return (Math.round(value / 100) / 10) + " 秒";
}
/**
 * 「保守 0.32 秒／均衡 0.18 秒／激进 0.12 秒」——从档位表**实际生效那一元**（数组第一元＝下限）现算。
 * ⚠️ 10-02 用户当面抓到旧写法把 `GAP_FLOOR_MS`（clamp 下界）当成实际停顿值印上屏：
 *   那句写「动手操作最快 0.3 秒」，而均衡档真判据是 `writeGapMs[0]`＝**0.9 秒**（保守 1.6／激进 0.5）。
 *   clamp 下界只有在客户自己往面板里填数时才拦得住，没填数时一个字都不参与，印它就是假话。
 */
function gapPerPresetZh(field) {
  return CADENCE_ZH.map(([key, zh]) => zh + " " + gapMsZh(HUMAN_POLICY_PRESETS[key][field]?.[0])).join("／");
}

/** 格子名后缀：0 到底是什么意思（写进 label，客户屏上那行小字就是它）。 */
function cadenceZeroLabel(field, unit) {
  return "（0＝跟着上面选的操作节奏走：" + cadenceByPreset(field) + " " + unit + "）";
}
/** 同一件事的完整说法（配在 desc 上，管理端与接口消费方读得到）。 */
function cadenceZeroDesc(field, unit, per) {
  return "填 0＝不单独限制这一项，跟着上面选的操作节奏走（"
    + CADENCE_ZH.map(([key, zh]) => zh + " " + Number(HUMAN_POLICY_PRESETS[key][field]) + " " + unit + "/" + per).join("、")
    + "）。这几个数是照操作节奏表算出来的，换节奏这里跟着变；填一个正数＝单独按这个数限制（与节奏无关）。";
}
// [第22件·2026-09-23] 「防封节奏」的**总开关**路径：下面所有子格都挂 `showWhen` 指它——
// 关着时那些子格在客户面**不出现**（模型层按这个键过滤，见 web/src/hosting/hosting-model.js）。
const CADENCE_MASTER_KEY = "basic.anti_detect.enabled";
const cadenceChild = (extra = {}) => ({ ...extra, showWhen: CADENCE_MASTER_KEY });
// 每日休息时长那两格的出厂值：下面那格「取消每日休息时段」的说明要用同一对数字（不另抄一份）。
const SLEEP_HOURS_MIN_DEF = 6;
const SLEEP_HOURS_MAX_DEF = 9;

// 品质五档 · 全项目品质名字的唯一出处（`/meta` 下发、各张卡的品质多选、值校验用的都是这一份）。
// 〔2026-10-09 用户点名纠正，原话「品质应该是凡普珍华仙啊，你怎么是甲乙丙丁」〕
// 改前这一份只有四档，名字是「丁级／丙级／乙级／甲级」＝我们自己编的，而且少一档：
// 官方最高档「仙品」在面板上根本选不出来（种植指定品质、花市扫货、公会放／拿花、订单不提交、
// 上架、偷花六处品质过滤全被这只缺档卡死）。数字↔名字的一手证据（按铁律 4 的判据分层取）：
//   ① 官方帮助表 `c_help#act_flowersFall` 逐字的升序阶梯：凡品 20%＜普品 30%＜珍品 40%＜华品 45%＜仙品 50%；
//     同族帮助文本里的样式号 txt_color_51／52／53／54／55 与这五档一档一号同序（52 挨着普品、54 挨着华品、55 挨着仙品）；
//   ② 官方界面自己（用户 2026-10-09 实屏截图）：种植列表顶上那排档 chip 是 全／凡／普／珍／华／仙，
//     正好是这五个名字的单字缩写，顺序也是这个序；置顶弹窗里的品质标也是同一套颜色序（凡绿→仙红）。
//   ③ 数字本体＝官方道具表 `c_item` 里那朵花的 `color`。官方点名的「限定仙品鲜花·飞花似梦」＝23511，现读 color＝5；
//     同批点名的花屿闲趣／花涧听泉／星垂绮夜三朵大奖也都是 5；起步花 23001 白百合＝1。
// ⚠️ 订正一处出错的出处（写下当天即被自己推翻，留在这儿防复发）：本批最初还把 ① 记成「客户端 bundle
//   `_ref/index-DGT06e1X.js` 里的官方品质字典」——**那份文件不是官方客户端**，现读里面有「退出这个空闲脚本」
//   「导出价格配置」「新建配置模版」这类文案，是第三方脚本面板的打包产物（它自带一份从官方表抽出来的花朵目录，
//   字典里的档名与 ①② 逐字相同，可当旁证）。因此**它给的那五个十六进制色值不算官方定案**，
//   界面要用颜色时按 ② 那张官方实屏的观感另定，别照抄第三方面板的色板。
// ⚠️ 品质**不是** `c_flower` 的 `colorType`：那是图鉴的「配色」筛子（官方源码把它的每个值展开成 flowerType 2 的筛选项），
//   与品质是两回事。现读 588 支花里 501 支的品质数字根本不在自己的 colorType 里；反例：仙品花 23511 的 colorType 是 3。
//   这个错以前把花市与公会分享两处过滤带偏了，同批改判据见 `flower-market-cycle.js`／`guild-share-cycle.js`。
export const QUALITIES = [
  { label: "凡品", value: 1 },
  { label: "普品", value: 2 },
  { label: "珍品", value: 3 },
  { label: "华品", value: 4 },
  { label: "仙品", value: 5 },
];

/**
 * 「培育选花模式」的四个可勾项——**全项目只此一份**（schema 定义、执行器判据、`/meta` 下发给客户面的名单、
 * 上屏那句中文都读它；第二处自己抄一份迟早写歪，`reason-zh.js` 头注的同一族教训）。
 *
 * 用户 2026-09-24 口径（原话）：「培育新花这里，选花模式要做成多选的，不是下拉　允许自动解锁的花这个就不要了，
 * 前面已经改成多选了，不精分到具体那朵花，单轮最多发几条培育写，这个也不好，代码里的限制也都要去掉」
 *
 * 语义（执行器 `cultivate-cycle.js` 的 `planCultivations` 逐条照此判）：
 *   · 勾了 `any` ⇒ **只看材料够不够**（其余三勾不起作用）——就是旧的「材料够就培」那一档；
 *   · 没勾 `any` ⇒ 只培育勾了的那几类来源要的花（需求侧按来源分类，见 `plant-demand.js` 的类别标签）；
 *   · **一项都不勾 ⇒ 一朵都不培育**（培育会真扣四格材料，不勾＝不想让它自动培育）。
 * 出厂默认＝前三项（`order`／`flower_art`／`main_task`）⇒ 与旧的 `prefer:"demand"` 逐字等价（零漂移）。
 */
export const CULTIVATE_FOR_OPTIONS = Object.freeze([
  Object.freeze({ value: "order", label: "订单要的" }),
  Object.freeze({ value: "flower_art", label: "花艺要的" }),
  Object.freeze({ value: "main_task", label: "主线要的" }),
  // [09-24 补第五项] 公会竞赛任务要的花在需求表里本来就算一类（`plant-demand` 的 DEMAND_CATEGORIES），
  // 四个可勾项里没有它的位置 ⇒ 默认那三项下它会**悄悄不再被培育**（旧 `prefer="demand"` 是会培的）。
  // 把这一类摆上页面、并进出厂默认 ⇒ 既让客户看得见，又保证行为零漂移。
  Object.freeze({ value: "guild_race", label: "公会竞赛要的" }),
  Object.freeze({ value: "any", label: "材料够就培（不看有没有人要）" }),
]);
/** 出厂勾哪几项：要花的四类都勾（与旧 `prefer:"demand"` 同一档行为，零漂移）。 */
export const CULTIVATE_FOR_DEFAULT = Object.freeze(["order", "flower_art", "main_task", "guild_race"]);

export const CHANNELS = [
  { id: "official", name: "官服/App/微信小游戏", login: "password", comingSoon: false },
  { id: "alipay", name: "支付宝", login: "qrcode", comingSoon: false },
  { id: "douyin", name: "抖音", login: "qrcode", comingSoon: false },
  { id: "xiaomi", name: "小米", login: "password", comingSoon: true },
  { id: "oppo", name: "OPPO", login: "password", comingSoon: true },
  { id: "vivo", name: "VIVO", login: "sms", comingSoon: true },
];

const sw = (key, label, def = false, extra = {}) => ({ key, label, type: "switch", def, ...extra });
const num = (key, label, def, extra = {}) => ({ key, label, type: "number", def, ...extra });
const sel = (key, label, def, options, extra = {}) => ({ key, label, type: "select", def, options, ...extra });
const rng = (key, label, defMin, defMax) => ({ key, label, type: "range", def: [defMin, defMax] });
const multi = (key, label, def = [], extra = {}) => ({ key, label, type: "multiselect", def, ...extra });
const time = (key, label, def = "") => ({ key, label, type: "time", def });
// [第22件·2026-09-23] 只读说明行：`note` 不在 EDITABLE_TYPES 里 ⇒ 渲染层不画控件；
// 文案写在 label 上（客户面渲染的就是 label），**不给勾、不给数值格**。
const note = (key, label) => ({ key, label, type: "note" });

/**
 * [09-25 用户实屏「免费加速跟加速卡催熟是互斥的，这两个只能开一个」] 那两格共用的**互斥说明**。
 * 唯一出处就是这里：客户面上那两行「为什么点不动」画的是这一句（`hosting-model.js` 的 `lockedText`），
 * 保存那条路把另一格关掉时回报的也是这一句（`api-user.js` 的 `/settings` → `clearExclusiveRival`）。
 * 两句各写一份迟早分叉（一边改了名字另一边还念旧的），所以做成常量、两处都引它。
 * ⚠️ 纯中文、无英文码、无行话（铁律 8 第 1 条）；「为什么只能开一个」的原因必须写进来（第 3 条）。
 */
const SPEEDUP_EXCLUSIVE_NOTE = "「用加速卡催熟」和「免费加速」只能开一个：你开了加速卡，地块在剩不到一分钟之前就已经被卡催熟了，那 55-60 秒的免费档根本轮不到。";
/**
 * 面板上的开关**一律默认关**：一张卡、一项防护都不预先替用户勾。
 * 口径来自用户 2026-09-11 两次明确要求——
 *   16:30「个人版的功能，默认应该全部是关闭的，自己根据自己的选择打开」，补充「就是给用户看的界面上」；
 *   17:50「然后把所有账号的所有功能都默认关掉」。
 * 历史上这张表有过 10 条例外（16:30 那一版留的：防封节奏／保持游戏在线／
 * 礼仪分监控／异常自动复工 4 条防护，加「仅已培育」「避开已有花灵的土地」「保留原金任务」等 6 条收窄过滤器），
 * 17:50 按新口径一并清空，存量两个账号（#11 模拟演示 / #12 真实托管）同日用 tools/normalize-default-off.mjs 落回关。
 * 谁要往这里加东西：先拿到用户明确点头，再同步改 tests/panel-defaults-off.mjs 里对应断言，否则守卫直接红。
 * 新开关一律 def=false（sw(key,label) 省略第三参即可）。
 *
 * [第55件·§5 撤账登记 2026-09-26] 09-16 晚用户当面点名的四条默认开例外（「没培育出来的花，直接就默认拒绝」
 * 一组：auto_reject_unmet 与三把档位子闸）随那批分档拒单格整体退场而**撤销**——点名它们的那条口径
 * （分档细拒）已被用户 09-26 的口径（②一把粗拒「简单粗暴」）取代。这是**用户撤销自己的旧点头**，
 * 不是代理放宽：本表回到铁律 5 的出厂口径——**空表，一条例外都没有**。
 * ⚠️ 撤销只动**出厂侧**；三个号的存量值一个字不动（#16/#19 烘着的那四把 true 随格子下架一起变成没人读的死值，
 *   如实记在 PARKED_FIELDS 第55件段与工作日志「遗留」）。
 */
export const DEFAULT_ON_EXCEPTIONS = Object.freeze({});

/** 面板里的某个开关是否属于「允许默认开」的例外（路径写法：组.模块.字段）。空表＝一条都没有。 */
export function isDefaultOnException(path) {
  return Object.prototype.hasOwnProperty.call(DEFAULT_ON_EXCEPTIONS, path);
}

/* ────────────── 下架留档名单（2026-09-20 立，判据见下方注释） ──────────────
 * **是什么**：界面上不再出现、但 schema 定义与存量数据一个字都不动的两份名单。
 * **判据（只有一条）**：这一行自己的标签或说明里写着「不生效／还没接／不代做／本期不做／只在预演」。
 *   ⇒ 留着它就是一枚**假开关**：客户勾了不会有任何动作，还以为自己安排好了（铁律 8 判死的形状）。
 * **为什么下架而不是删**：① 老存档里烘着的那份值要留着（删列会让存量配置漂移）；
 *   ② 这些格子大部分**将来要开发**（见 memory/config-ux-and-runtime-plan-2026-09.md §15 逐条前置），
 *      删了就等于把待办抹掉；③ 解除下架必须是"带判据＋带测试"的一次真改动，不是顺手改口。
 * **怎么解除**：从下面两份名单里摘掉那一行，同时把它的标签/说明里那句"不生效"改成真实说法。
 * **自 policing**：`tests/parked-switches.mjs` 反向扫全表——凡标签/说明自述不生效却不在名单里 ⇒ 红。
 */
export const PARKED_MODULES = Object.freeze([
  // ↓ `basic.flower_bounty` 已**解除下架**（第63件·2026-09-27 用户点名「花坊悬赏怎么没自动领取」）：
  //   从本名单摘行 ＋ 说明改成真实说法（下面 basic 段那一行），执行器落在 `task-ach-cycle.js`。
  //   解除依据＝表里现读对得上用户截图（组 1/2 累计登录、组 3 种植鲜花、组 17 主线任务已到档）。
  // ↓ `basic.double_coin` 已**解除下架**（第121件·2026-10-05 用户点名「双倍金币这个功能必须要对接的，
  //   需要看广告，而且需要开始运行游戏托管的时候，就先做这个，如果此时还没过期，需要记录下次看广告的时候，
  //   到点直接开始看广告」）：从本名单摘行 ＋ 说明改成真实说法（下面 basic 段那一行）。
  //   执行器＝`double-coin-cycle.js`（官方那一发 `usr.share{shareId: c_share 行 11, ext:{opType:1}}`），
  //   判据与取值表＝`memory/plan-1004-double-gold-ad.md` §1/§4。存量对账：各号这一格都是出厂 false ⇒ 零迁移。
  "basic.share_reward", "basic.first_craft",
  // ↓ `basic.redeem_code` 已**解除下架**（2026-10-04 用户点名「把这个领码的功能给我彻底对接好」）：
  //   从本名单摘行＋说明改成真实说法（下面 basic 段那一行）。执行器＝`redeem-code-cycle.js`（09-18 暂存件搬回），
  //   码源＝中央码库（`tools/live-code-watcher.mjs` 挂场读直播间 → 自动入库；管理端也可手动录），
  //   确认＝官方「兑换码奖励」邮件（模板 100）。方案＝memory/plan-1001-redeem-code-autoclaim.md。
  "basic.friend_accept", "guild.guild_redpacket", "activity.act_flower_note",
  // ↓ `activity.act_flower_news`（莳花纪闻）已**解除下架**（2026-09-29 二期·用户点名「完全自动化运行」）：
  //   从本名单摘行 ＋ 说明改成真实说法（下面 activity 段那一行），执行器接在 `activity-cycle.js` 的
  //   交订单（actCyclicStory.recvOrderRwd）与商店（gs.act.buy）两条通道上，各配一把真实写闸（def=false）。
  "activity.act_bubble", "activity.act_red_rain", "activity.act_welcome",
  "activity.act_call_zi", "activity.act_money_tree", "activity.act_lantern", "activity.act_jade_vase",
  "activity.act_home", "activity.act_honor",
  // ↓ 09-20 刀2 收口「其他设置」时补的三张：整模块**没有任何卡管**、且**今天没有任何读取方**，
  //   留在界面上就是一个勾了不做事的假开关（§16.5 第 6 条当场拔掉）。依据逐条：
  //   · `basic.vip_shop`——VIP 商店购买「未接真实写」是 `flower-shop-cycle.js` 注释里的原话；
  //     真正被读的"花坊币保留"是 `basic.flower_shop.flower_coin_reserve`（那一条照旧在屏上），
  //     这个模块下的同名字段没人读 ⇒ 保留额只认 flower_shop 那一格。
  //   · `activity.act_fish_granary` 丰仓鱼干——卡名册里没有这张卡，全仓零读取方。
  //   · `activity.act_flower_garden` 花香满园——同上；⚠️ `seed.js:148` 给演示号显式开着它，
  //     下架**只摘渲染、不改存量数据**（那一份 true 照旧留在库里），恢复它必须同批带写链路与判据。
  "basic.vip_shop", "activity.act_fish_granary", "activity.act_flower_garden",
  // ↓ [第59件·2026-09-27 用户实屏裁决] 「订单进度宝箱」整模块下架：那一格开关交给「居民订单」卡
  //   （用户：「只要居民任务开了，那就需要自动去领进度宝箱」）。判据＝**运行期零读取方**
  //   （`normalizeRealOrderRewardConfig` 改读 `order.resident_orders.enabled`，全仓不再读这个模块）；
  //   定义与存量值一字不动（旧 true/false 变成没人读的死值，不写迁移脚本、不回写）。
  //   解除条件＝用户重新点名要它独立开关，同批带判据与测试（守卫 tests/order-reward-follows-resident.mjs）。
  "order.order_reward",
  // ↓ [第59件·2026-09-27 用户追补] 「居民订单进度奖励」整模块下架：同上，那一格开关交给「居民订单」卡
  //   （用户：「那就只保留一个开关就行，给个备注，不要这么复杂」）。判据＝**运行期零读取方**
  //   （`normalizeRealResidentOrderAchConfig` 改读 `order.resident_orders.enabled`，全仓不再读这个模块）；
  //   定义与存量值一字不动（旧 true/false 变成没人读的死值，不写迁移脚本、不回写）。
  //   解除条件＝用户重新点名要它独立开关，同批带判据与测试（守卫 tests/order-reward-follows-resident.mjs）。
  "order.resident_order_ach",
  // ↓ [v6 批·2026-09-28 执行体 A] 「礼仪分监控」整模块下架（任务书逐行复核样例 :404）。判据＝**运行期零读取方**：
  //   · `enabled`——全仓唯一摸到它的两处都不读配置值（api-user.js 的 `kind === "guild_race_monitor"` 分支
  //     与 worker.js 的模拟演示日志行都是造数，与这一格的值无关）；屏上那行「礼仪分当前 N」只属演示号假读数。
  //   · `score_threshold`——第 22 件就已单格下架（下面 PARKED_FIELDS 第 22 件段，标签自认「暂不生效」）。
  //   两格皆死 ⇒ 与 09-20 刀2「整模块没有任何卡管、今天没有任何读取方 ⇒ 假开关」同一形状，整块下架。
  //   定义与存量值一字不动；解除条件＝真接上「查官方礼仪分并按分数办事」的链路，同批带判据与测试。
  "basic.guild_race_monitor",
  // 〔第140件·2026-10-07 整模块下架留档〕「花瓶图鉴奖励」并进「花架与花艺」格5：模块 `plant.vase_album`
  //   两格（enabled／real_vase_album_reward）全部 PARKED、归一化改读 plant.flower_art（格1×格5）——
  //   名册无卡声明此模块 ⇒ 模块级下架（先例＝basic.guild_race_monitor／order.resident_order_ach：
  //   定义与存量值一字不动，解除条件＝用户重新点名要独立卡，同批带判据与测试）。
  "plant.vase_album",
]);

export const PARKED_FIELDS = Object.freeze([
  // [第22件·2026-09-23 死开关守卫 `test:dead-switches` 抓到并在此留档的三格]
  //   判据＝**在 server/src 里零读取方**（客户勾了不会有任何动作）。三格逐条：
  //   · `basic.road_grow.claim_vip_rewards`——它自己的标签就写着「本项不单独生效：含特权卡的那几只宝箱
  //     由上面「真的去领积分宝箱」一并领」；实际读取方是那一格，这格从来没被人读过。
  //   · `plant.vase_album.album_reward`——标签写着「分享/看广告，脚本不代做，本项不生效」。
  //   · `plant.flower_market.auto_unlock_shelf`——模块说明写着「上架那一半本期不做（要花元宝买上架位）」，
  //     可它自己的标签**没写**「暂不生效」⇒ 客户能勾、勾了没动作（正是这个守卫要抓的形状）。
  "basic.road_grow.claim_vip_rewards",
  "plant.vase_album.album_reward",
  "plant.flower_market.auto_unlock_shelf",
  "basic.guild_race_monitor.score_threshold", "basic.pearl.enable_auto_draw", "basic.pearl.enable_protect",
  "basic.pearl.enable_auto_buy_ticket", "basic.pearl.hire_book_tier", "basic.pearl.buy_ticket_yuanbao_limit",
  // ⚠️ 材料商店名下那格旧标签「视频礼包（暂不生效）」的零读取方残留格**已被整格删除**（不在此名单里，
  //   也不在面板字段里）：用户 2026-10-02 点名「材料商店跟礼包商城，不是一个地方啊，而且材料商店没有视频礼包啊」。
  //   它当年是给礼包商城留的坑，却留在材料商店（官方 `shopCultivate`）家门口、且全仓零读取方。
  //   现在的家＝下面 `giftbag_shop` 那一格的键名（官方 `shopGiftbag`＝同步模块 112 那一家，
  //   执行器 `giftbag-ad-cycle.js`）。⚠️ 按本仓既有纪律这里**不写出那个旧键名**——读取方扫描器把
  //   `server/src/**` 里出现的字段名字面量（连注释也算）当成真读取方，写上去旧账就再也查不出来
  //   （同形状的先例见 `real-harvest-runner.js` 里花瓶图鉴那段注释）。删除前存量对账：各号那格都是出厂
  //   false ⇒ 零迁移、不动库；台账 `tests/fixtures/config-reader-whitelist.json` 那一行同步删掉（留痕见当月工作日志）。
  "basic.shop_buy.refresh_wait_minutes",
  "basic.vip_shop.water_daily_purchase_limit", "basic.vip_shop.speed_card_daily_purchase_limit",
  // [第132件·2026-10-06 用户点名「猫庭养猫所有点做出来、做成可配置项」] `basic.zoo.auto_handle_event`
  //   ／`basic.zoo.auto_recall`／`basic.zoo.auto_buy_food` 三格从这里**出列**：10-05 两路勘察证明
  //   处理事件与找回都有纯免费档、买粮花的是金币不是元宝（定案逐字见 memory/plan-1005-zoo-cat-full.md），
  //   三格已在 `zoo-pet-care-cycle.js` 接成真开关（执行器 normalizeRealZooPetCareConfig 现读它们）。
  //   同族形状先例＝第50件 `yuanbao_buy_material` 出列。**`auto_buy_food_on_demand` 留在册**：
  //   官方没有第二种买法，那格没有真读者，出列它就是在造第二个假开关（铁律 16）。
  "basic.zoo.auto_buy_food_on_demand",
  // 〔第17件·续 2026-10-16〕`plant.cultivate.video_speed` 从这里**出列转正**：这一格从 09-18 起挂着
  //   「暂不生效」，本批接上真读者（`cultivate-cycle.js` 的 `normalizeRealCultivateConfig.videoSpeedReduce`
  //   ＋`planVideoReduceCultivate`），判据逐字＝`common/game.js` latin1@1773890
  //   `PCultivateAdItem._tap_btn_ad`：`n&&!o&&e.UT.share(2,{opType:1,id:n},…)`（shareId 按 `c_share.tag`
  //   现读＝sharingCulReduce，编号不写死）；认账只认模块 101 里这一朵的完成时刻变早了。
  //   出列必须配真读者（同族先例＝第50件 `yuanbao_buy_material`、第146件 M3 `restock_count`）。
  "plant.cultivate.target_flower_ids", "plant.cultivate.auto_share_reward",
  // [第50件追加·2026-09-26] `plant.cultivate.yuanbao_buy_material` 从这里**出列**：用户实屏拍板
  //   「培育缺料可以直接用元宝购齐」（黄土获取途径弹窗逐字「元宝购买 15 元宝/块 ⇒ 买」），
  //   该格已在 direct-buy-cycle 接成真开关（判据＝服务器在架 consume，实帧抓包 shop.buy{count,itemId,tempId}
  //   ＋响应带模块 7/20）。同时在 basic.shop_buy 组加「元宝直购」总闸与「保留元宝线」两格。
  "plant.cultivate.yuanbao_speedup", "plant.cultivate.yuanbao_target_flower_ids",
  "plant.cultivate.yuanbao_limit", "plant.land_plant.video_speed", "plant.land_plant.grouped_plant_enabled",
  "plant.land_plant.top_restock_count",
  // 〔第146件 M3·10-09〕`restock_count` **出列转正**：09-18 挂「暂不生效」起就在册，本批接上真读者
  //   （`real-land-cycle.js` 归一化＋分配器，语义＝用户 v3 定稿的「种植数量」）——出列必须配真读者，
  //   同族先例＝第50件 yuanbao_buy_material、第132件猫庭三格（`dead-switches` 的反向账）。
  // 〔第146件 M3·10-09〕`plant_whitelist` 进册：用户原话「白名单就不要了，直接删除」——功能被「指定花朵」
  //   档整档覆盖，两格并存会打架；现读 7 个真实号全是空名单 ⇒ 零迁移零影响。
  "plant.land_plant.plant_whitelist",
  "plant.friend_steal.target_steal_friend_names", "plant.friend_steal.exclude_steal_friend_names",
  "plant.friend_steal.target_qualities", "plant.friend_steal.buy_attempts", "plant.friend_steal.buy_count",
  "plant.friend_steal.forbidden_start", "plant.friend_steal.forbidden_end", "plant.friend_steal.use_remaining_at_night",
  "plant.friend_steal.steal_elves", "plant.friend_steal.steal_elf_ids", "plant.friend_steal.target_elf_friend_names",
  "plant.friend_steal.exclude_elf_friend_names", "plant.friend_steal.avoid_elf_land",
  "plant.friend_steal.disable_normal_steal_until_elves_full", "plant.flower_elves.selected_elves_id",
  "plant.flower_elves.elves_main_count", "plant.flower_elves.plant_time_start", "plant.flower_elves.plant_time_end",
  "plant.flower_elves.max_assist_friend", "plant.flower_art.auto_put", "plant.flower_art.flower_art_exp",
  "plant.flower_art.album_reward", "plant.flower_market.auto_put", "plant.flower_market.only_cultivated",
  "plant.flower_market.target_flower_ids", "plant.flower_market.target_qualities", "plant.flower_market.exclude_flower_ids",
  "plant.flower_market.price_strategy", "plant.flower_market.shop_target_friend_names",
  "plant.flower_market.shop_exclude_friend_names", "plant.flower_market.shop_password",
  "plant.flower_market.min_duration", "plant.flower_market.shop_continuous_duration",
  "order.team_order.buy_again", "order.team_order.skip_submit_flower", "order.team_order.only_cultivated",
  "order.team_order.min_bag_reserve", "order.team_order.exclude_flower_ids", "guild.guild_build.build_video",
  // 〔2026-10-02 出列复活〕`guild.guild_build.build_yuanbao_count` 原来在这里（当时元宝档是红线常量钉死的
  // 永不做）。用户点名接齐三档后它重新成为真读取格，**必须离开这份名单**——留在名单里会被
  // `test:cell-ownership`／`config-reader` 那套账本当成「已下架但仍被读」＝隐形闸（错误清单第 19 形）。
  "guild.guild_share.share_auto_unlock", "guild.guild_race.race_upgrade_uids",
  // 〔第119件·B5·2026-10-06 复活出列（解除条件已到＝真读者与判据同批落地，§13 格子去向总表）〕
  //   `race_refresh_take_score_min`（「刷到多少分才罢手」分数线·读取方 `guild-race-refresh.js`）、
  //   `race_refresh_yuanbao_limit`／`race_refresh_yuanbao_keep`（「手上这条每天最多重刷几次」「刷新后元宝至少留」·同上）
  //   三格从这份名单**摘行**：10-04 用户定案 F 点名要的分数线与三件止损，10-06 判据层（B3）已按路径读它们
  //   ——留在名单里＝屏上没有这一格而运行期有人取值（隐形闸，错误清单第 19 形；`test:parked-fields-value` 的 Ⅱ 类形状）。
  //   `race_buy_task_max` **不出列**（2026-10-06 本批自查改判）：计划档 §5 格子表说这一格由新键
  //   `race_buy_num_max` 替（执行器 `guild-race-cycle.js` 读的就是 num_max，C-exec 已落地），§13 表却说「复活 task_max」
  //   ——两行打架 ⇒ 以执行器真实读取的键为准：num_max 上屏、task_max 连定义带存量**回架**（留着它就是
  //   标签自认暂不生效却不在名单里的假格子，parked 自查必红）。差异逐字见报告 §5。
  "guild.guild_race.race_buy_task_max",
  "guild.guild_race.race_avoid_in_progress",
  "guild.guild_race.race_refresh_take_score_max", "guild.guild_race.race_refresh_yuanbao_max",
  "guild.guild_race.race_refresh_stop_origin_gold_score", "guild.guild_race.race_refresh_stop_flower_ids",
  "guild.guild_race.race_refresh_stop_score", "guild.guild_race.race_refresh_stop_not_vip_shop",
  "guild.guild_race.race_refresh_give_up", "guild.guild_race.race_refresh_give_up_upgrade_flower_ids",
  "guild.guild_race.race_refresh_give_up_upgrade_score", "guild.guild_race.race_auto_do_task",
  "guild.guild_race.race_upgrade_give_up_mode", "guild.guild_race.race_upgrade_give_up_flower_ids",
  "guild.guild_race.race_delete_score_min", "guild.guild_race.race_delete_score_max",
  "guild.guild_race.race_delete_flower_ids", "guild.guild_race.race_delete_time_start",
  "guild.guild_race.race_delete_time_end", "guild.guild_race.race_keep_origin_gold",
  "guild.guild_race.race_keep_upgraded", "guild.guild_race.race_priority",
  "guild.guild_race.race_speed_card_clear_non_task", "guild.guild_race.race_video_speed_threshold",
  "guild.guild_race.race_video_speed_allow_non_task", "guild.guild_race.race_land_harvest_mode",
  "guild.guild_race.race_land_harvest_include_ids", "guild.guild_race.race_land_harvest_exclude_ids",
  "activity.act_fish_granary.fast_game", "activity.act_fish_granary.show_result", "activity.act_fish_granary.fail_restart",
  "activity.act_cat_match.auto_game", "activity.act_cat_match.claim_energy", "activity.act_cat_match.game_reward_box",
  "activity.act_cat_match.total_box", "activity.act_cat_match.solve_mode", "activity.act_cat_match.game_speed",
  // ↓ 09-21 刀2 补的 11 格：**逐格查过读取方**才下的手（"勾了不做事"是体验上最坏的一种欺骗，铁律 8）。
  //   规矩照 §15／§16.5 第 6 条：只摘渲染、不删定义、不改存量数据；要回来的那天必须同批带写链路与判据。
  //   · 零读取方那一族（三处探针＋人工复核过：属性式读取、驼峰、字符串字面量三种姿势都零命中）——
  //     `plant.land_plant.unlock_land`（真闸是隔壁 `real_land_unlock`，`land-unlock-cycle.js` 的归一化只读
  //       `enabled` + `real_land_unlock`；这一格只在注释里被点名"模拟路径那个不算授权"），
  //     `plant.cultivate.auto_cultivate`／`plant.cultivate.flower_upgrade`（真闸分别是
  //       `real_cultivate_start`／`real_cultivate_upgrade`，`cultivate-cycle.js` 的归一化一眼可证），
  //     `plant.cultivate.auto_harvest`（这一格在本模块零读取方；同名的 `plant.land_plant.auto_harvest` 才有人读），
  //     `guild.guild_land.flower_level`（`guild-land-cycle.js` 把它列进"同步态读不到没法过滤"的缺口名单，
  //       值从未被读；同名的 `plant.land_plant.flower_level` 照旧生效、不在此列），
  //     `plant.water_drops.free_water`（真闸是 `real_free_water_recv`）、
  //     `plant.water_drops.water_bucket_fallback_time`（[第120件·2026-10-04] 过点补领已按官方两张表自动做
  //       ——`c_gameCfg.$freeWaterTime` 两个窗过点 ＋ `c_share#13.limit=3` 没用满，闸是 `real_free_water_fallback`；
  //       客户不再需要填一个「兜底领取时间」的旋钮，这一格按铁律 16 留在下架名单、永不复活）。
  //   · "读了不用"那一族（归一化搬进局部变量后**全仓再无消费点**，等于设了不生效）——
  //     `plant.water_drops.water_bucket_mode`（原注释自认"只为了如实告诉用户"，实际连回报都没用到它）、
  //     `plant.water_drops.water_bucket_threshold`、`plant.water_drops.free_water_threshold`
  //     （两格由 `water-supply-cycle.js` 读成 `waterBucketThreshold`／`freeWaterThreshold` 后无人消费；
  //       要真生效得让补领判据去消费它——那是运行期行为改动，留给后续批次，留档在此）。
  //   · ~~`basic.anti_detect.enabled`~~ —— **[第23件·2026-09-23 已解除下架，不在本名单里]**
  //     它原来被当"假开关"摘了渲染（标签自认"不控制任何行为：限速一直生效"），而第 22 件又把它
  //     **接成了真总开关**（`humanPolicyFromConfig` 读它 → `limitsEnabled` → `HumanRiskGuard.evaluate`
  //     整段跳过）⇒ 判据链通了、客户面却没有入口：屏上不画这一格，组说明却指着"第一格总开关"，
  //     客户想开也找不到地方（错误清单第 23 条那种"半拉子改造"）。
  //     ⇒ 从下架名单里摘掉、正常渲染；守卫 `test:panel-referral` 从此钉住两件事：
  //     ①「说明/指针指着的那一格必须真在客户面上」②「有读取方的一格不许留在下架名单里」。
  "plant.land_plant.unlock_land", "plant.cultivate.auto_cultivate", "plant.cultivate.auto_harvest",
  "plant.cultivate.flower_upgrade", "guild.guild_land.flower_level", "plant.water_drops.free_water",
  "plant.water_drops.water_bucket_fallback_time", "plant.water_drops.water_bucket_mode",
  "plant.water_drops.water_bucket_threshold", "plant.water_drops.free_water_threshold",
  // ↓ 〔第158件·2026-10-10 用户定稿「这两个合并成一个 领水，保留两个按钮」〕领水这一族的两把**细闸**下架：
  //   · `real_water_bucket_ad`（广告桶看视频领）——并进「领水车水桶」那把按钮（用户原话「默认看广告」）；
  //   · `real_free_water_fallback`（过点后自动补领）——并进「领限时水滴」那把按钮（原话「开启之后就是默认过点领取」）。
  //   按铁律 19 的下架手续：定义与存量值留着（不写库），**运行期读取点同批删净**
  //   （`water-supply-cycle.js` 的归一化不再读这两格，两发的闸改由上面那两把按钮各自说话），
  //   指向这两格的四句屏上话术同批改口（指着一格客户屏上根本没有的开关＝假话，铁律 8 第 4 条）。
  //   ⚠️ 代价照铁律 8 第 3 条摆明（写在两把按钮的「?」里）：合并之后**没有"只领桶、不走看视频那一发"这一档**，
  //   要躲开那一发只能整项关掉；这一族两发在服务器账上都记成"某广告位完成"，程序并不真的播放广告。
  "plant.water_drops.real_water_bucket_ad", "plant.water_drops.real_free_water_fallback",
  // ↓ 09-24 用户点名「我不要总开关啊」——**六处"组总闸"整批下架**（只摘渲染，定义与存量值不动）：
  //   它们原来是两到五张卡共用的一个格子，被搬到分组顶上画成「这一组共用的总开关」，
  //   客户读不出"哪一格才是这张卡的"，而且任何一张卡被打开都会顺手把它点亮、关掉最后一张卡它也不熄。
  //   现在每张卡只由自己的写闸说话：组总闸改由这一族自己的子开关推出来（判据唯一出处
  //   `server/src/game/module-gate.js`），`ACTION_GATES` 里那六条组总闸条目同时摘掉
  //   （`capability-deps.js` 的共用闸声明由 7 处收敛到 1 处）。改完这六格在 `server/src` 零读取方。
  //   ⚠️ 存量号里这几格照旧留着（`mergeDefaults` 也照旧补），只是没有任何人再读它。
  "basic.daily_task.enabled", "guild.guild_land.enabled", "plant.cultivate.enabled",
  "plant.flower_art.enabled", "plant.land_plant.enabled", "plant.water_drops.enabled",
  // ↓ 09-24 用户实屏第三问：「任务优先和种植模式冲突了」——**确实冲突**（归一化把两者 OR 成同一件事，
  //   本仓自己的映射表注释也写着「与 plant_mode="task" 同义」）⇒ 这一格下架留档、**不再有任何读取方**，
  //   语义由「种植模式」那一档独担。存量核对（2026-09-24 现读）：三个号全是 false ⇒ 零迁移。
  "plant.land_plant.task_priority",
  // ↓ 09-24 用户实屏第五问「这不也是重复项吗／这两个有什么用」——加速卡那一族四个旋钮整批下架：
  //   ~~`use_speed_card`（与 `real_land_speedup` 重复）~~ ← **[09-25 已解除下架，不在本名单里]**：
  //     用户 09-25 实屏「加速卡这里还是不对」把它要了回来，但**换了个身份**——它不再是「与真实写重复的意愿格」，
  //     而是这一张卡的**总闸**（客户面读作「这一张卡现在能不能替你动手」，下面那两格互斥、只能开一个）。
  //     解除下架的同时，它进了 `ACTION_GATES` 两条链的第一环、被归一化真读、由卡头那把开关代表
  //     （判据与理由见下面 `use_speed_card` 那一格的声明与 `capabilities.js` 的 `autoGatePath`）。
  //   `free_speedup_window_sec`（固定 55-60 秒随机触发）／
  //   `speed_card_threshold`（固定"剩不到 20 分钟就熟的不烧卡"）／`speed_limit`（固定一轮最多 5 块）。
  //   剩下三个只摘渲染、读数处回到出厂默认 ⇒ 零漂移；留下的客户可调项只有 `speed_card_keep`。
  "plant.land_plant.free_speedup_window_sec",
  "plant.land_plant.speed_card_threshold", "plant.land_plant.speed_limit",
  // ↓ 09-24 用户点名的「培育新花」那一批（原话见 `CULTIVATE_FOR_OPTIONS` 头注）——三格逐条：
  //   · `plant.cultivate.unlock_flower_ids`（允许自动解锁的花）：**不精分到具体哪朵花**了，自动解锁的许可
  //     改由「培育选花模式」那份多选决定（勾中的来源里要的花才可能被自动解锁）。
  //   · `plant.cultivate.max_actions_per_cycle`（单轮最多发几条培育写）：页面上不再有这一格，
  //     代码里那道上限（`CULTIVATE_ACTION_CAP` 与切片）同批删除（铁律 16）⇒ 培育候选一轮全部发完。
  //   · `plant.cultivate.prefer`（旧下拉）：语义由 `cultivate_for` 那份多选独担（出厂三项＝旧的 demand 档）。
  //   三格一律只摘渲染：存量值照旧留在库里，定义也留着（要回来的那天必须同批带判据与测试）。
  "plant.cultivate.unlock_flower_ids", "plant.cultivate.max_actions_per_cycle", "plant.cultivate.prefer",
  // ↓ 09-24 用户实屏「做花艺成品」那一批（原话：「这一项现在能不能替你动手和自动做花艺成品和真的去做花艺成品
  //   这三个难道不是一个意思吗，为什么要单独拆分成三个开关，单轮最多做几朵成品是什么意思，怎么算一轮」）——
  //   两格逐条：
  //   · `plant.flower_art.auto_make`（自动做花艺成品）与 `real_flower_art_make`（真的去做花艺成品）说的是
  //     **同一件事**、两个控件写的是同一格子 ⇒ **合并成一格**（`real_flower_art_make` 留下），旧的那格下架留档。
  //     合并后这一张卡只剩一格里子 ⇒ 按 `hiddenSwitches` 的既有规则由卡头那把「自动执行」代表
  //     （与「催熟/加速卡」那批同一形状）。
  //   · `plant.flower_art.make_per_cycle`（单轮最多做几朵成品）：页面上不再有这一格，代码里那道上限
  //     （`ART_MAKE_ACTION_CAP` 与切片）同批删除（铁律 16：页面上摸不到的那一格限制，代码里也不许留）
  //     ⇒ 能做几朵就做几朵，候选有多少做多少，**不另设新上限**。
  //   两格一律只摘渲染：存量值照旧留在库里，定义也留着（要回来的那天必须同批带判据与测试）。
  "plant.flower_art.auto_make", "plant.flower_art.make_per_cycle",
  // ↓ 第77件（2026-09-29 用户对着「花架经营」这张卡实屏点名）：「指定花艺不要了，每分钟最多上架几件的限制也不要」
  //   两格逐条，**都是"渲染与运行期同批退场"**（不是只摘渲染——那正是错误清单里
  //   [[parked-switch-still-live-hazard]] 那条：下架还在读＝客户自己也关不掉的隐形闸）：
  //   · `plant.flower_art.specified_arts`（指定花艺）：读取方 `flower-rack-cycle.js` 的
  //     `specifiedArts`（上架挑哪几件＋制作候选限定）整条删净 ⇒ 一律按「先摆哪一件」从官方配方挑；
  //     ⚠️〔第126件·2026-10-05 按用户点名下账〕原话「花艺这里需要能指定制作那个花艺，可以最大限额制作999个花艺」
  //     ⇒ **本条从这份名单出列**，走它自己写的归来的手续（「要回来的那天必须同批带判据与测试」——本批已带：
  //     判据＝`flower-art-cycle.js` 的 `planArtMakeActions` 收窄，且只挂制作侧、不再碰「先摆哪一件」；
  //     测试＝`tests/flower-art-specify.mjs` 一族；当年的另一半病根（选项源挂的是**花瓶号**名单）改挂新源
  //     `flower_arts` 修死，见本文件那一格的第126件注释）。`max_actions_per_cycle` 那一半**继续下架**，不受本批影响。
  //   · `plant.flower_art.max_actions_per_cycle`（每分钟最多上架几件）：`RACK_ACTION_CAP` 常量、
  //     `maxActionsPerCycle` 的读法与 `candidates.slice(...)` 那道切片同批删净 ⇒ 有多少空架位摆多少，
  //     第74件那份名册 `cycle-cap-roster-74.json` 里这一项从「有格子」改登记为「已拆」。
  //   两格的**定义与出厂值一字不动**（存量库里值照旧留着，要回来的那天必须同批带判据与测试）。
  "plant.flower_art.max_actions_per_cycle",
  // ↓ 〔第140件·2026-10-07 用户定稿「花艺＋花架三卡合一」〕两格下架留档（只摘渲染、读数处同批改口，
  //   不许隐形仍在读＝错误清单「下架却还在读」同族纪律）：
  //   · `plant.flower_art.real_rack_recv`（收卖货的钱）：**行为并进格7「上架」**——开着上架，卖掉的自动收，
  //     不设单独开关。迁移＝旧 sell 或 recv 任一为真 ⇒ 格7 真（`tools/migrate-1007-rack-art-merge.mjs`），
  //     跑完本文件与 `flower-rack-cycle.js` 的 `normalizeRealRackConfig` 对该格**零读取**（守卫钉）。
  //   · `plant.vase_album.real_vase_album_reward`（自动领取图鉴奖励）：「花瓶图鉴奖励」整卡撤下，
  //     并入「花架与花艺」格5 `first_album_claim`（新闸在屏、旧闸留档）。迁移＝旧两把**都真**才为真。
  //   ⚠️ 同批**定义删除**（不是留档）的三格：`make_always`／`sell_for_task_only`／`make_choice`——
  //   用户定稿「格、码、判据链整条删净」，先例＝材料商店死格整格删除；旧值成孤键、无任何读法，
  //   所以它们**不进这份名单**（名单只记「摘渲染不删定义」的留档格），对账见当月工作日志第140件。
  "plant.flower_art.real_rack_recv",
  "plant.vase_album.real_vase_album_reward",
  // ↓ 第54件（2026-09-26 上午批次）先下了两格；同日第55件按用户 22:0x 口径重排这张卡——账两条各记一段：
  //   · `order.customer_orders.flower_shop_coin_amounts`（旧灰多选格）——第54件以「灰着却真生效＋档位无稳定表源」
  //     下架；第55件用户③点名「这个需要有，要让用户能去选择」⇒ **换形做回**为阈值数字格
  //     `flower_shop_coin_min`；**第58件按用户 09-27 口径②再换形回多选**（「花坊币只有123三个选项，要做成复选框，
  //     客户自己决定做多少花坊币的顾客订单」）⇒ 本条**从名单出列**，选项固定 1/2/3 三项（出处＝用户当面裁决，
  //     不挂 source、前端不从 /meta 取名单——当初灰格的病根就是名单没有稳定来源，这次从形状上绕开）；
  //     同时 `flower_shop_coin_min` 退场进下方第58件段（同一件事两个控件＝第54件点名的"两套分母"，绝不允许同屏）。
  //   · `order.customer_orders.auto_reject`——第54件把它下架是为三层同名控件消歧；第55件用户②点名它**做回**
  //     全卡唯一拒单闸（简单粗暴：花不够就拒），于是**从本名单出列**（见下方第55件段说明）。
  // ↓ 第55件（2026-09-26 晚·用户口径①②）八格逐条。判据唯一出处＝real-order-cycle.js 的
  //   REJECTABLE_SKIP_REASONS 头注与 normalizeRealOrderConfig 收口注释；git 锚点 40ec6a1 有全套原文。
  //   ⚠️ 这八格与第54件的 auto_reject 不同：那条当年是「只摘渲染、旧路径仍真判据」（Ⅱ 类），
  //   这八格是**渲染与运行期一起退场**（运行期零读取方，panel-referral 扫描必须命中不了它们）：
  //   · `auto_generate`（用户①）：开卡即允许喊客人挂单，单独意愿档取消；
  //   · `auto_reject_unmet`＋`reject_unlocked_empty`/`reject_cultivating`/`reject_scheduled`/`reject_locked_unplanned`
  //     （用户②）：分档细拒整体退场，拒单只剩 auto_reject 一把粗闸；那四条 09-16 的「默认开例外」同步撤销
  //     （DEFAULT_ON_EXCEPTIONS 回到空表——存量号烘着的 true 变成没人读的死值，一个都不回写）；
  //   · `shortfall_flower`（用户②同族）：不再为订单缺花烧加速卡（土地加速段回到自然顺序）；
  //   · `order.customer_orders.missing_flower`（用户②同族）：缺成品固定「跳过、不记培育需求」；
  //     ⚠️ 居民组同名字段 `order.resident_orders.missing_flower` 本条登记时**照旧渲染照旧生效**（不连坐）——
  //     该口径到第56件为止：居民组自己被裁决收成一把开关，那一格随下方五格一起退场（两族各自写死，各有各的依据）。
  //   要回来的条件：用户重新点名分档拒/烧卡/记培育——同批带判据、测试与 git 锚点 40ec6a1 的对照。
  "order.customer_orders.auto_generate",
  "order.customer_orders.auto_reject_unmet", "order.customer_orders.reject_unlocked_empty",
  "order.customer_orders.reject_cultivating", "order.customer_orders.reject_scheduled",
  "order.customer_orders.reject_locked_unplanned", "order.customer_orders.shortfall_flower",
  "order.customer_orders.missing_flower",
  // ↓ 第56件（2026-09-27 用户裁决「居民订单只保留一个开关」五条）五格逐条。判据唯一出处＝
  //   real-order-cycle.js GROUPS.resident 的三个旗标与 normalizeRealOrderConfig 的收口注释：
  //   · `daily_finish_limit`（裁决2：不限制数量）——**已于 2026-09-30 第79件恢复**（见下方恢复段），本段只剩四格；
  //   · `quality_filter`（裁决3：不做品质过滤）——qualityApplicable 改 false（对照顾客组既有形状）；
  //   · `missing_flower`（裁决4：居民订单**不能拒绝也不能弃单**——缺花只有「留着等种」一条路，
  //     库存不足就去种那条链本来就在（plant-demand 无条件计订单需求），不重建）——归一化写死 "skip"；
  //   · `execute_time_start`／`execute_time_end`（裁决1：开关打开就一直做）——windowApplicable:false，
  //     归一化居民恒空窗＝恒在时段内；**别组的时段判定一条不删**。
  //   这四格与第55件那批同类：渲染与运行期**同时**退场（守卫 tests/resident-order-single-switch.mjs 判据⑤
  //   源码面扫零运行期读取方带正断言）；定义与存量值不动（读取方删净后存量值即无害，不写迁移脚本）。
  //   要回来的条件＝用户重新点名要这四道闸，同批带判据与测试。
  "order.resident_orders.quality_filter",
  "order.resident_orders.missing_flower", "order.resident_orders.execute_time_start",
  "order.resident_orders.execute_time_end",
  // ↑ 第79件·恢复（2026-09-30 用户点名，屏上原话：「居民订单需要加个配置，让用户输入做多少单，
  //   根据顾客输入的次数去自动做单」）——第56件裁决2 的解除条件正是「用户重新点名」，本次由用户自己改口。
  //   `order.resident_orders.daily_finish_limit` 自本行起**从下架名单出列**：渲染与运行期同时回来，
  //   判据唯一出处＝real-order-cycle.js GROUPS.resident.limitField（改回本列名）＋ applyDailyLimits 通用截单，
  //   「今天做到第几单」吃的是官方当日计数（statistics.resident，与顾客对账第62件同一只读源）——不是本地累加。
  //   出厂 200（远高于官方每日一屏做得完的量）＝填前行为零漂移；0＝不限（applyDailyLimits 里 limit>0 才拦）。
  //   同批改靶：tests/resident-order-single-switch.mjs（五格→四格＋恢复正断言）、tests/real-order-cycle.mjs
  //   （「居民组不该再有上限停手记录」→ 设了上限该拦、默认不拦）。绸缎/建材同族格与本格同源不同家（各读各的）。
  // ↓ 第58件（2026-09-27 用户口径：顾客订单「去每日上限」＋「花坊币档做回 1/2/3 三个复选框」）两格逐条。
  //   判据唯一出处＝real-order-cycle.js GROUPS.customer 与 normalizeRealOrderConfig 的收口注释；
  //   与第56件居民侧同形状、同一把尺（渲染与运行期同时退场、运行期零读取方）：
  //   · `order.customer_orders.daily_finish_limit`（用户①「顾客订单不要上限，做多少都可以」）——
  //     GROUPS.customer.limitField 改 null，applyDailyLimits 自然放行；**居民第56件已自删其上限、
  //     绸缎/建材各自的上限格照旧渲染照旧生效——本格只摘顾客这一侧，一组都不连坐**。
  //   · `order.customer_orders.flower_shop_coin_min`（第55件的阈值数字格）——用户②点名换成 1/2/3 复选框，
  //     于是这格退场：运行期改读 `flower_shop_coin_amounts`（本批从下架名单出列、做回静态多选），
  //     两格不同时在客户面、也不同时被读（同一件事两套控件＝第54件点名的病，绝不允许）。
  //   两格定义与存量值一字不动（读取方删净后存量值即无害，不写迁移脚本）；要回来＝用户重新点名，同批带判据与测试。
  "order.customer_orders.daily_finish_limit",
  "order.customer_orders.flower_shop_coin_min",
  // ↓ 第81件（2026-09-30 用户点名「需要把绸缎订单的时间限制去掉，随时都能做」）绸缎时段两格下架留档。
  //   判据唯一出处＝real-order-cycle.js `GROUPS.satin.windowApplicable:false`（照第56件居民组先例）——
  //   归一化绸缎恒空窗＝恒在时段内；**别组（decorate/customer/palace）的时段判定一条不删，一组都不连坐**。
  //   定义与存量值不动（读取方随旗标删净后存量值即无害）；测试换靶：resident-order-single-switch 里
  //   绸缎 hostile 时段样本退役，刀改按 `satin_finish_limit` 活闸见血。要回来＝用户重新点名要时段。
  "order.satin_orders.execute_time_start",
  "order.satin_orders.execute_time_end",
  // ↓ 第87件（2026-10-01 用户点名「把绸缎订单，建材订单和组团订单接好，然后时间段限制都不要」）
  //   ① **建材两格时段**下架：判据唯一出处＝real-order-cycle.js `GROUPS.decorate.windowApplicable:false`
  //     （照第56件居民组、第81件绸缎组同一把尺）——归一化恒空窗＝恒在时段内，开关打开就一直做。
  //     同批把本文件 `decorate_orders` 块里那句「建材时段两格照旧是真闸」改口（不改口就是谎话）。
  //   ② **组团两格时段**下架：这一族的执行器 `order-team-cycle.js` 现读**只读三键**
  //     （enabled／real_team_order_write／allow_free_take），两格从来零读取方 ⇒ 上屏不驱动＝假控件
  //     （错误清单「下架但仍在读＝隐形闸」的反面同族：在屏却没人读），按同一规矩摘渲染。
  //   ③ **组团的品质过滤**同批下架：与②同形状——卡上画着「已选 0 项」，运行期一个都不读。
  //     ⚠️ 刻意**不去实现它**：客户现在选的是 0 项，一旦真驱动就变成"一单都不接"，与用户点名的「接好」相反；
  //     要它生效＝用户重新点名并带判据（届时先定"0 项＝全不接还是全接"这条语义，别拿猜的去拦单）。
  //   三格定义与存量值一字不动（读取方删净后存量值即无害，不写迁移脚本）。
  //   ⚠️ 本批之后**订单五族再没有任何一族读时段格**（resident/satin/decorate 恒空窗，customer/palace 从未声明），
  //     `withinExecuteWindow` 对订单族整体惰性——机制与判据留着不删（哪天点名要回来，摘旗标即生效），
  //     并由守卫 tests/order-window-retired.mjs 钉死「谁把时段请回订单族、没挂新格＝当场红」。
  "order.decorate_orders.execute_time_start", "order.decorate_orders.execute_time_end",
  "order.team_order.execute_time_start", "order.team_order.execute_time_end",
  "order.team_order.quality_filter",
  // ↓ v6 批（2026-09-28 · 托管设置页整批整改·执行体 A）下架留档，三段逐条。规矩照旧：
  //   **只摘渲染，定义与存量值一字不动**；「去向」＝这格退场后由哪一格说话。
  //   ⚠️ 同族如实记账（坑 16：下架但仍在读的格＝隐形闸）——本批每格动手前都 grep 了 server/src 全部读取方，
  //   读取方逐条清单已写进 `.runtime/_v6_A_ledger.md` 与本批最终报告，**运行期摘读归同批 C1/C3 负责**
  //   （dispatch 原文：「执行侧不再读它由 C1 负责」「执行侧 C3 负责」）。
  //   ① 意愿格并入真实写（照 09-24 花架 auto_make 先例）——zoo 两格与 flower_market 两格的执行器归一化
  //     **已经不再读意愿**（zoo-pet-care-cycle.js 与 flower-market-cycle.js 里「v6 合并」注释为证），
  //     现读残余读取方只剩 capabilities.js 的 ACTION_GATES 链首几环（待 C1 摘）：
  "plant.flower_art.auto_unlock_rack",            // 去向＝real_rack_unlock（本卡唯一真实写闸）
  "basic.zoo.auto_feed",                          // 去向＝real_zoo_add_food（意愿并入真实写）
  "basic.zoo.auto_stroke",                        // 去向＝real_zoo_stroke（意愿并入真实写）
  "plant.flower_market.recv_income",              // 去向＝real_market_recv_income（意愿并入真实写）
  "plant.flower_market.friend_shop",              // 去向＝real_market_buy（意愿并入真实写）
  //   ② 单写卡的 `enabled`（附录一 a 类 11 格）：这张卡只剩**一条真实写**，总开关与那把写闸说的是
  //     同一件事（两张控件一条链＝重复格，判据①）；去向逐格＝该卡唯一真实写闸。
  //     ⚠️ 现读：每格的读取方只有两处——本卡自己的 ACTION_GATES 链首环＋本卡 cycle 的归一化
  //     （**没有**被同模块其他卡或其他写闸链共用）；链首环与归一化的摘除同批归 C 系列。
  //     卡头那把「自动执行」走 enableAction 写整条链（capabilities.js buildAutoConfig），下架渲染后
  //     手机端开卡照旧能点亮这一格 ⇒ 过渡期不会出现「永远关不掉也永远开不起」的死卡。
  "basic.main_task.enabled",                      // 去向＝claim_main_rewards
  "basic.guide_progress.enabled",                 // 去向＝real_guide_progress
  "basic.story_main.enabled",                     // 去向＝real_story_main_unlock
  "basic.flower_shop.enabled",                    // 去向＝real_flower_shop_buy
  "basic.zoo_souvenir.enabled",                   // 去向＝real_zoo_souvenir_recv
  "basic.zoo_game_2048.enabled",                  // 去向＝real_2048_write
  //     ⚠️ 派工单给 friend_steal 写的去向名是 `real_steal_elf_write`——该名**只存在于
  //     friend-steal-cycle.js 的归一化**（它读的是面板上从没定义过的那本账，永远 fail-closed，见该文件
  //     :1027 注释「现在面板上还没有这两格」）；schema.js 里 friend_steal 唯一的真实写闸是
  //     `real_steal_write` ⇒ 去向按现读登记为 real_steal_write，差异已写进本批报告。
  "plant.friend_steal.enabled",                   // 去向＝real_steal_write（派工单名 real_steal_elf_write 在面板上无定义，见上）
  "plant.flower_token.enabled",                   // 去向＝real_flower_pass_recv
  "plant.spirit_token.enabled",                   // 去向＝real_elf_pass_recv
  "plant.vase_album.enabled",                     // 去向＝real_vase_album_reward
  "guild.guild_like.enabled",                     // 去向＝real_guild_show_like
  //   ③ 花灵（多动作共用一条真实写）：卡头改由 real_flower_elves_write 代表、做哪几件由各 auto_* 子闸
  //     决定（派工单原文，执行侧摘读归 C3）。elf-recv／elf-dispatch／elf-aid-req／elf-aid-recv 四条链
  //     同属**一张卡**（capabilities.js :1126），不构成「被其他卡共用」的停手条件。
  "plant.flower_elves.enabled",
  //   ④ 判据②逐行清扫（任务 7）：本批对**每个仍在渲染的格**问了一遍「勾了会有任何反应吗」，
  //     以下 14 格在 server/src **逐键 grep 确认零读取方**才下的手（坑 16 的反向纪律：先确认没人读、
  //     再摘渲染；不是照抄 09-21 名单——那批把同族里带「暂不生效」字样的摘了，**没带字样但同样没人读**
  //     的这一族一直留在屏上）。定义与存量值一字不动；要回来的那天必须同批带判据与写链路。
  //     · 好友偷花：friend-steal-cycle.js 的归一化现读只认 enabled／real_steal_write／real_steal_elf_write，
  //       这三格（挑地用的模式与两张花朵名单）连 camelCase 姿势都零命中：
  "plant.friend_steal.mode", "plant.friend_steal.target_flower_ids", "plant.friend_steal.exclude_flower_ids",
  //     · 花灵：flower-elves-cycle.js:390-391 注释逐字自认这六把「本期不驱动任何写」＋
  //       `harvest_delay_minutes`（同名的 `plant.land_plant.harvest_delay_minutes` 才有人读，见 :254 同款勘误先例）：
  "plant.flower_elves.auto_plant_elf", "plant.flower_elves.auto_unlock_place",
  "plant.flower_elves.auto_upgrade_book", "plant.flower_elves.auto_draw_elves",
  "plant.flower_elves.auto_assist_friend", "plant.flower_elves.auto_speed_dispatch",
  "plant.flower_elves.harvest_delay_minutes",
  //     · 花市上架侧收尾：模块说明写着「上架那一半本期不做（要花元宝买上架位）」，09-21 摘了带
  //       「暂不生效」字样的那批，这格没带字样但同样零读取方（flower-market-cycle 的归一化现读
  //       只认 enabled／shop_*（扫货侧）／real_market_*；strategy 是它归一化后的局部变量名，不是面板格）：
  "plant.flower_market.strategy", "plant.flower_market.put_count",
  "plant.flower_market.password", "plant.flower_market.buy_put_limit",
  // ↓ 09-28 用户点名「补种的设置这里」收成两项（原话＝唯一出处）：
  //   「定制的那三个不需要，客户根本用不上这些东西太麻烦了，种植黑名单也不要，花朵等级范围也不要，
  //    每分钟种几块也不要，**只保留种植模式和是否启用开关**」＋「**出厂默认改需求优先**」。
  //   再加一条产品口径（同批用户裁定）：**种花是这个游戏的核心循环，地必须种满**——
  //   旧的每遍块数上限、品质区间、黑名单、定制名单都是「客户摸不到真实效果」的限制
  //   （铁律 16：页面上没有那一格，代码里也不许存在）。
  //   这一族**渲染与运行期同退场**（照第56件居民订单、第58件顾客订单那两批同一把尺）：
  //   · `plant_group_size`（每分钟种几块）——只在「这一遍种几块」上做减法；退场后没有本地块数旋钮。
  //   · `flower_level`（花朵等级范围）／`plant_blacklist`（种植黑名单）——两格都只在「种哪一朵」的
  //     候选层做减法；退场后候选＝官方那份能种的花，黑名单里那几种花照样能被种上（**这就是代价**：
  //     以前靠黑名单躲开的花，现在会按「种植模式」被选到；用户 09-28 明确说这套他不用）。
  //   · `custom_plant_enabled`（特需定制）／`custom_plant_lands`（定制土地）／`custom_plant_flowers`（定制花朵）
  //     ——三格是一套名单：勾上之后「只在这几块地上种这几种花」，两张名单缺一张就一朵都不种。
  //     代价（也是用户下架的理由）：名单选了又忘了改，地就会一直空着——正是「太麻烦、用不上」那一样。
  //   · `grouped_plant_enabled`（规整种植·按档铺地）**早在 09-21 那批就已进本名单**（见上面那一行），
  //     本批不重复登记；它那条路只在预演里跑过、真实链路从未走过，运行期读取随本批一起删净。
  //   ⚠️ 同族照旧在册、同样不重复登记的两格：`restock_count`／`top_restock_count`（09-18 就标了
  //     「暂不生效」，与 `plant_group_size` 是同一维度的旧旋钮）。
  //   七格定义与出厂值一字不动、**零迁移**（读取方删净后存量值即无害）；界面上不会出现「能勾但无效」的格子
  //   ——运行期读取方与本批同批删除（唯一出处 `server/src/game/real-land-cycle.js` 的归一化）。
  //   要回来的条件＝用户重新点名要名单式限定／按档铺地，同批带判据、写链路与测试。
  //   ⚠️〔第92件·2026-10-01 条件已兑现一格〕**`plant.land_plant.plant_blacklist`（种植黑名单）已按用户点名"出列"回到界面**
  //     （原话：「种花这里需要增加一个黑名单和白名单功能，黑名单的花朵永远不参与种植」）——同批带回判据、读取链路与测试，
  //     并新增同族的白名单格 `plant_whitelist`。剩下五格（每分钟种几块／花朵等级范围／特需定制三格）**照旧在册未回**。
  "plant.land_plant.plant_group_size", "plant.land_plant.flower_level",
  "plant.land_plant.custom_plant_enabled",
  "plant.land_plant.custom_plant_lands", "plant.land_plant.custom_plant_flowers",
  // ↓ [09-30 批·P1/P4·工位A] `order.customer_orders.cultivable_only`（做花艺只用已培育的花）**下架留档**。
  //   用户裁决原话（本条唯一出处）：「用掉它，先把这一单做成」＋「做花艺只用已培育的花……这个按钮在这不是多此一举吗」。
  //   为什么"多此一举"＝官方两条判据：
  //   ① 官方反解源码 `_ref/game_src/common/common/game.js@356989`——鲜花入选＝**背包有 或 已培育**（两者是"或"）：
  //      `s&&11===s.type ? r.usrCtrl.getItemNum(o)>0 || r.cultivateMgr.hasMb(o) : i.haveItem(o)`；
  //      背包里现成的花本来就够做，勾不勾"只用已培育"官方都认——这一格拦掉的是"能做而不做"。
  //   ② 官方花艺表 `server/data/official-cfg/c_flowerArt.json`（本轮命令现读：顶层 `{id:行}` 共 1473 行，
  //      字段 `lvl,cOrder,wgt,vase,flowers,sPrice,cPrice,createRwd,artExpAdd`）——**没有**「需已培育」这一旗标。
  //   存量现读（09-30 本轮复核）：#11/#16/#19 三号的 leaf 读数与整列 SCAN **双读全 false** ⇒ **零迁移**。
  //   **定义与出厂值 `false` 一个字不动**（下面 `order.customer_orders` 组内那一格原样留着）；
  //   本批摘的是**渲染与归属**（客户面不再出现这一格，`SHARED_ROW_OWNER` 同批出列）；
  //   运行期摘读归同批工位B（`flower-rack-cycle.js` 的用料过滤与那一族"花没培育出来"的理由码同批退场）。
  "order.customer_orders.cultivable_only",
  // ↓ [2026-10-02·用户实屏「莳花纪闻」] 四格下架留档，两件事分开看：
  //   用户原话（本条唯一出处）：「是否启用就应该包含了 自动交订单和自动领宝箱　商店自动买货和每遍买几格不要，不替客户进行购买」
  //   ① `real_act_story_deliver`（自动交订单）＋ `real_act_story_box`（自动领宝箱）——**并入卡头那把「是否启用」**，
  //      不再是第二道闸。这两件事本来就是这张卡存在的理由（不交单不领箱，开这张卡还能做什么）。
  //      ⚠️ 合并带来的真实行为变化（据实，不是零风险）：**凡是「是否启用」开着的号，从本批起直接开始交订单**
  //      ——以前它还得再勾一把子闸，现在不用了。交订单每一发都从背包真扣掉这一单要的花（不可逆），
  //      所以代价照铁律 8 第 3 条写在卡面上，不藏在「?」里。
  //   ② `real_act_story_shop`（商店自动买货）＋ `story_shop_per_cycle`（每遍买几格）——**整条通道退役**。
  //      脚本不再在任何商店里替客户下单（它花的虽是活动里挣的花史残页、一分元宝不动，但用户口径是
  //      「不替客户进行购买」——买货这个动作本身归客户）。残页照旧攒着，只是不花。
  //      运行期**渲染与读取同退场**（照第56件居民、第77件花架那两批同一把尺）：解析层 `readShopRows`／
  //      `pickShopRecord`／`storyBoughtMap` 与 DS 路径 23.4 的读取、商店计划段、商店回带核验分支、
  //      写名单里那条 `act-story-shop` 全部同批删净，不留「读一下再忽略」。
  //   四格定义与出厂值一字不动、**零迁移**（读取方删净后存量值即无害：开着商店那格的号从此不再买货＝安全方向）。
  //   要回来的条件＝用户重新点名，同批带判据、写链路与测试。
  "activity.act_flower_news.real_act_story_deliver",
  "activity.act_flower_news.real_act_story_box",
  "activity.act_flower_news.real_act_story_shop",
  "activity.act_flower_news.story_shop_per_cycle",
  // ↓ [第111件·2026-10-03 用户点名「先把公会地收花对接好……可以随时换花朵，这个需要单独一个计算」]
  //   公会土地名下这一格「种植模式」（`guild.guild_land` 的那一格，与自家花田同名的另一格不相干）
  //   **下架留档**：定义与出厂值一字未动、只摘渲染、存量值照旧。两档分别为什么留不住：
  //   ① `race`（跟随公会任务）**从来没生效过**——真号日志逐字：
  //      「配置项 guild.guild_land.plant_mode=race 当前不会生效：要先解析公会竞赛任务的指定花朵，
  //       两者都还没有权威读法；该模式下一律不自动种」（出处＝`guild-land-cycle.js` 那份
  //       「不生效声明」，与它并列的那条 `notImplemented` 随本批一起退场）。
  //      ⇒ 客户勾了它**一块都不会种**，正是铁律 8 判死的「页面上摸得到的假选项」。
  //   ② `specific`（指定花朵）这一档的语义**由新格 `land_flower_pick` 的同名档接管**：
  //      新格第三档「只种下面指定的花」读的还是原来那一格「指定花朵」的名单
  //      （`specific_flower_ids` 定义、出厂值、选项来源一个字都没动、照旧被读）。
  //   ⚠️ 存量迁移判断（本条要留得住，否则就是"摘了一格、把号的行为改了"）：
  //   号 16 存的这一格现读是 `"race"` —— 摘掉渲染后新格 `land_flower_pick` 出厂 `demand`，
  //   看着像"这个号突然换了一种挑法"。**实际不会让任何一个号突然开始种花**：
  //   「自动种植」那把总闸（`land_plant`）在号 16 上是**关着**的，而这一族所有种花都排在它后面；
  //   加上 2026-10-03 现读号 16 的公会地 `landCount:13／emptyCount:0`（13 块全种满、没有空地可挑），
  //   这一刻连一块要挑花的空地都没有 ⇒ **零漂移**，本批不做数据回写（照本仓口径：存量值照旧不动）。
  //   运行期**所有读取点同批删净**（不留「读一下再忽略」那种隐形闸），改的是
  //   `server/src/game/guild-land-cycle.js`；理由码 `GUILD_PLANT_MODE_UNSUPPORTED` 同批摘掉，
  //   不留在 `reason-zh.js` 里当孤儿条目。
  //   要回来的条件＝用户重新点名要「按公会竞赛任务挑花」这一档，且那天**先有**竞赛指定花朵的权威读法，
  //   同批带判据、读取链路与测试（照本名单一贯规矩：不许留一枚勾了什么都不做的格子）。
  "guild.guild_land.plant_mode",
  // ↓ 〔10-07 用户令「设置太杂乱、该合并的合并，不要一个功能需要两个按钮；名字要简洁易懂」〕
  //   公会竞赛卡二批下架，两类逐条：
  //   · **八对「意愿×真实写」的同名 twin**（说的是同一件事、两个控件写同一动作）：合并成一把开关后，
  //     各留那把意愿格（`race_auto_take`／`race_auto_finish`／`race_auto_upgrade`／`race_upgrade_give_up`／
  //     `race_auto_refresh`／`race_refresh_use_ad`／`race_auto_buy_task`／`race_box`），下面八个 twin 只摘渲染、
  //     存量值照旧留在库里、定义也留着（要拆回来的那天必须同批带判据与测试，并与能力面 ACTION_GATES 一起改）。
  //   · **四格「开着也不发」的空壳**（下架留档，理由走它们各自的登记）：`race_delete_low_score`／
  //     `race_delete_vip_shop`（删任务这一档「不代做」＝产品决定，不摆开关）、`race_use_speed_card`
  //     （种植任务联动加速卡＝后批编排）、`race_video_speed`（要看广告，未点名点位）。
  "guild.guild_race.real_guild_race_take",
  "guild.guild_race.real_guild_race_finish",
  "guild.guild_race.real_guild_race_upgrade",
  "guild.guild_race.real_guild_race_give_up",
  "guild.guild_race.real_guild_race_refresh",
  "guild.guild_race.real_guild_race_refresh_ad",
  "guild.guild_race.real_guild_race_buy_num",
  "guild.guild_race.real_guild_race_box",
  "guild.guild_race.race_delete_low_score",
  "guild.guild_race.race_delete_vip_shop",
  "guild.guild_race.race_use_speed_card",
  "guild.guild_race.race_video_speed",
  // ↓ 〔第206件·2026-10-16 用户裁决「每组每茬等齐是固定流程，独立『等齐再收』按钮取消」〕
  //   `plant.land_plant.harvest_wait_all` 渲染与运行期**同批退场**：等齐从此是固定流程（同一分组每茬
  //   全部成熟并满足收花延迟后统一收获；历史日志里「保留关闭档／关闭后允许先收」的口径已撤回，不许沿用）。
  //   按仓规只摘渲染：定义与出厂值（false）留着、不写库（存量键有家，同第55/56件各段口径）；
  //   运行期读取点同批删净（`real-land-cycle.js` 的归一化、收获裁决、补种闸门三处，见当月工单），
  //   指向这一格的屏上句子同批改口（reason-zh 两条、收获/补种留痕句、hint 那句、归属表行）。
  //   「是否启用收花」（auto_harvest）与「延迟收花」（harvest_delay_minutes）两格**照旧原样有效**，本批一字未动。
  "plant.land_plant.harvest_wait_all",
]);

const PARKED_MODULE_SET = new Set(PARKED_MODULES);
const PARKED_FIELD_SET = new Set(PARKED_FIELDS);

/** 这个模块（`组.模块`）是否整块下架。 */
export function isParkedModule(moduleKey) {
  return PARKED_MODULE_SET.has(String(moduleKey || ""));
}
/** 这一格（`组.模块.字段`）是否下架。 */
export function isParkedField(path) {
  return PARKED_FIELD_SET.has(String(path || ""));
}

/**
 * 〔2026-10-05 用户令「把没做好的禁用，保留已经对接好的」〕**禁用格**（与下架两回事，一字不差地分开）：
 *   · 下架（PARKED_FIELDS）＝这一格是假开关／死格：屏上不画、**运行期读取点同批删净**；
 *   · 禁用（HELD_FIELDS）＝这一格背后的功能**接通了、判据也在**，但还没在真号上跑通过 ⇒
 *     屏上**照旧画出来、灰显、点不动**（理由就在行上），运行期**强制按关处理**（存成 true 也不发），
 *     保存路由拒写。代码与判据一个字不删——用户点名开放时，把这一表里那条摘掉即可（守卫会盯着四道闸一起松）。
 * 值＝给客户看的那句理由（铁律 8：禁用的代价与原因写在屏上，不许藏在注释里）。
 */
export const HELD_FIELDS = Object.freeze({
  "guild.guild_land.land_auto_unlock": "开新块这一件还没在你的任何一个号上真跑通过，先禁着；要开放说一声就开",
  "guild.guild_land.land_auto_upgrade": "升级这一件还没在你的任何一个号上真跑通过，先禁着；要开放说一声就开",
});
const HELD_FIELD_SET = new Set(Object.keys(HELD_FIELDS));
/** 这一格是否被禁用（屏上灰显＋运行期强制关＋保存拒写，四道闸共用这一个出处）。 */
export function isHeldField(path) {
  return HELD_FIELD_SET.has(String(path || ""));
}
/** 禁用格给客户看的那句理由（查不到回 null）。 */
export function heldFieldReason(path) {
  return HELD_FIELDS[String(path || "")] || null;
}
/**
 * 保存整棵配置前把**禁用开关格**强制落回关（数值格不动——它们只是参数，运行期根本读不到）。
 * 与运行期 `normalize` 的强制关同一立场：屏上灰显点不动只是一半，不走界面直接发也不许留下
 * 「存成 true」的状态（铁律 5/12 同源：只允许少发写）。幂等：本来就是 false 的号一个字节不改。
 * @returns {string[]} 被强制落回的格（空数组＝这份配置本来就干净）
 */
export function stripHeldSwitches(cfg) {
  const forced = [];
  if (!cfg || typeof cfg !== "object") return forced;
  for (const key of Object.keys(HELD_FIELDS)) {
    const [g, m, f] = key.split(".");
    const field = ALL_MODULES.find((mod) => mod.group === g && mod.id === m)?.fields?.find((one) => one.key === f);
    if (field?.type !== "switch") continue;
    if (cfg[g]?.[m]?.[f] === true) {
      cfg[g][m][f] = false;
      forced.push(key);
    }
  }
  return forced;
}

// ⚠️ 下面两份「顺序」常量是**参考站面板的原始口径，保留备查用**：本仓没有任何读取方
// （09-18 由 tests/config-reader-guard.mjs 系的扫描 + 人工复核确认），面板上那两格拖拽排序
// 也已经撤掉（手机端拖不动，留着就是假开关）。客户要的「0 点后先做每日任务 / 竞赛最优先」
// 改用两个真开关实现：`basic.daily_task.daily_first` 与 `guild.guild_race.race_first`
// （判据与次序口径见 server/src/game/run-priority.js 与 tests/run-priority.mjs）。
export const DAILY_TASK_ORDER = [
  "居民订单", "浇水", "花架出售花艺品", "顾客订单", "材料商店购买", "宫廷特供",
  "珍珠采集雇佣", "摘取好友鲜花", "观看视频", "小动物互动", "消耗剧情星星",
];

export const MAIN_TASK_ORDER = [
  "种植任意鲜花", "收获任意鲜花", "收获指定花朵", "培育指定花朵", "累计培育花种",
  "珍珠采集雇佣", "居民订单", "绸缎订单", "建材订单", "顾客订单", "制作花艺品",
  "售卖花艺品", "花坊兑换鲜花", "解锁花架", "浇水土地", "材料商店购买", "升级鲜花",
  "领取水桶", "解锁土地",
];

export const GUILD_SHOP_ITEMS = [
  "杀虫剂", "抑菌剂", "除螨液", "烟叶水", "硫磺剂", "甘草液", "农家肥", "草木灰",
  "石灰粉", "兽骨粉", "蒜皮液", "鱼粉", "木醋液", "贝壳粉", "松针肥", "酒糟肥",
  "海藻肥", "加速卡", "花坊币", "水滴",
];

export const SCRIPT_GROUPS = [
  {
    id: "basic",
    label: "基础配置",
    // ⚠️ 这一棵树上的每个 label/desc/选项名都会**原样**发到客户手机（`GET /meta` 直发 SCRIPT_GROUPS，
    // 手机端「详细设置」页逐字渲染）。所以：只写客户读得懂的话，工程词（档位/阈值/闸门/执行器/拟人）
    // 一律换掉——2026-09-17 按用户实屏口径「整个手机端都不要有不应该给客户看的东西」逐条改过一遍，
    // 守卫见 `tests/customer-copy.mjs` 的行话表与本次新增的 /meta 用例（tests/proxy-pool.mjs 另扫线路那一面）。
    // 英文（VIP／活动名里的 call）是游戏里就有的官方说法，不算行话，保留。
    modules: [
      { id: "guild_race_monitor", label: "礼仪分监控", desc: "运行过程中持续检查礼仪分状态。", fields: [
        // 2026-09-11 17:50 起默认关（用户口径：面板上一律默认关，防护类不豁免）。真实链路查无读取方，关掉不改变行为。
        sw("enabled", "开关", false), num("score_threshold", "礼仪分低于多少要处理（暂不生效）", 80, { min: 0, max: 200 }),
      ]},
      // 这个名字改了三回口径才落地（AGENTS.md 2026-09-11）：它管的是**整轮任务出错之后
      // 重新登录开工**，而世界那条连接自己断开时走的是另一套（每 10 秒自动接回、不重登账号，
      // 见 server/src/game/world-reconnect.js）。两个都叫「自动重连」，用户连着问了一个星期。
      // 配置键 id 仍是 reconnect：它是存量 script_config 里的路径，改名字要迁移数据，收益不值。
      // 〔第147件 块 C·2026-10-09 用户③④原话「连续失败最多自动复工这个看不懂啥意思」＋「三个设置再优化
      //   一下，解释要写明明白，什么时候会自动用这里的设置」〕三格的行名与说明**逐字**取
      //   `memory/plan-1009-softblock-log-and-autorecovery.md` §4.1 终稿：行名只留短名（10-08 口径），
      //   详细说明全部进这一行控件右边的「?」（`hint`，`hosting-model.js` 的可编辑格优先吃它），
      //   整段"这一组什么时候参与"留在模块标题右边那个「?」（`desc`）。
      // ⚠️ 三格的**唯一读取方**是 `game/run-recovery.js` 的 `realReconnectPolicy`（铁律 19 P1 一格一家）——
      //   本批只改说法，键名／id／出厂值一个字没动（仍是 enabled/delay_minutes/max_attempts ＝ false/5/3）。
      // ⚠️ 与 §4.1 终稿的唯一差别＝「这一趟／同一趟」按本仓 09-28 点名的调度单位禁词换成
      //   「这一次／同一次」（禁词表与替换表唯一出处 `game/customer-copy.js` 的 `CUSTOMER_CYCLE_WORDS`／
      //   `CYCLE_UNIT_REPLACEMENTS`，判据 `tests/settings-cycle-copy.mjs` 判据② 扫 schema 的 label/desc/hint）。
      //   改的只是说法，四段事实（什么时候用／怎么算／数的是什么／填 0 会怎样）一字未删。
      { id: "reconnect", label: "异常自动复工", desc: "任务出错、或者官方不让我们登录之后，隔多久自己再登一次、最多再登几回，都由下面三格说了算。\n三格什么时候自动用上：只有在这一次托管「停下来了」的时候——中途报错、被官方把登录拦下、连接出问题时。\n一切正常干活的时候，这里一个数字都不参与。\n游戏里那条连接自己断掉不算这里：它十几秒内会自己接上，也不用重新登录。", fields: [
        // 2026-09-11 17:50 起默认关：关掉＝任务出错之后不自动复工，停在失败态等用户点「启动托管」。
        // 判据是真的（run-recovery.js 的 realReconnectPolicy 读 enabled !== false），不是装饰性开关。
        sw("enabled", "出错后自动重新登录", false, {
          hint: "打开之后：这一次托管中途出错、或者被官方拦下不让登录时，到点我们自己重新登录、接着干，你不用回到页面点「启动」。关掉（出厂就是关的）：出一次错就停住，日志会写清为什么停，等你自己点「启动」。游戏里那条连接自己断掉不算这里——它十几秒内会自己接上，也不用重新登录。\n〔每天会用上一次〕过了零点，游戏那边「今天已经做了多少」那本账要重新上线才拿得到（一直挂在线上不会自己刷新）。所以每天第一次醒来时，它会自己重新登录一次去取今天的账——开着这格才会发生，代价就是每天多一次上下线（约十几秒，期间不做任何操作）；关着这格：过了零点就拿不到今天的数，水桶、限时水滴、每日订单这些按天算的会一直报「今天的账没拿到」并一条都不发，直到你手动点一次「启动」。",
        }),
        // 〔第147件 §3.6·铁律 19 P4〕后两格挂 `lockedWhen`：总闸关着时到点根本不会去试，这两格就不该还点得动
        //   （本仓判死的「客户自己也关不掉的隐形闸」形状）。**只灰显、不改写客户存过的值**（P4 明令），
        //   后端判据链一字未动——`planRealRunRecovery` 里「门排在次数上限之前」本来就成立。
        //   声明形状照本文件 `real_land_speedup` 那两格的先例（锁的判据只一处在 `capability-deps.js`／
        //   `hosting-model.js` 的 `buildRow`，两侧对账由 `tests/gate-locks-card-cells.mjs` 钉）。
        num("delay_minutes", "出错后先等几分钟再登", 5, {
          min: 1, max: 120,
          lockedWhen: "basic.reconnect.enabled",
          hint: "什么时候自动用上这里：① 这一次托管中途出错、要重新登录时；② 官方把这个号的登录拦下（它回一句「数据异常，正在修复中」那类）时。算法＝先把官方要我们等的那段时间等满，再在这上面加这个分钟数，到点才发登录。举例：官方说还要 5 分钟，这里填 5 ⇒ 约 10 分钟后自己再试；填 30 ⇒ 约 35 分钟后再试。填大一点更稳；填太小就是拿着同一个号反复去撞官方。每一次「被拦到几点、下一次几点试」都写在日志那一行上。上一行「出错后自动重新登录」关着时这一格点不动，因为到点根本不会去试。",
        }),
        num("max_attempts", "一次托管最多自己重试几回", 3, {
          min: 0, max: 20,
          lockedWhen: "basic.reconnect.enabled",
          hint: "数的是「这一次托管里，我们自己动手重新登录了几回」，不是失败的动作数，也不是失败的分钟数。每次到点去重登就记 1 回；这一回用满就停下，日志会写「已经自己试过 3 回都没进去，先停下等你看一眼」，要你在页面上重新点「启动」。登回来之后这数不清零（防的是同一次里反复撞）。填 0 ＝ 出错后一次都不自己重试，等于把上一行的等待时间作废；出厂 3 回。",
        }),
      ]},
      // 〔2026-10-13 用户令「你要避免这种ip封禁的事情再次发生」〕出口线路级连坐**单独成一组**，不塞进上面那三格：
      //   第147件按用户③④原话把「异常自动复工」那一组的行名·键名·出厂值·后两格的 `lockedWhen` 逐字钉死在
      //   `tests/world-reconnect.mjs`（「现读必须正好三条」），往那一组加第四格＝替他把钉过的口径改口。
      //   两件事实本来也不同：那三格管「这一次托管停下来了之后怎么复工」，这一格管「同一条出口上的号都别再撞
      //   官方已经判过的那道」——而且手动点「启动」也要过它，所以它**不许**被「出错后自动重新登录」灰掉。
      //   出厂 60 的出处＝`login-error-codes.js` 里 risk_ip 那一档写死的 `minutes: 60`（第147件定档）：
      //   这里只是把同一个判定从"这个号"扩到"同一条出口"，不是我今天新编的数。
      //   唯一读取方＝`game/egress-risk.js`（一格一家，钉在 `tests/egress-risk-hold.mjs` 判据②）。
      { id: "egress_guard", label: "出口网络连坐", desc: "官方那句「登录有风险」有时判的是出去的网络，不是某一个号（它回「请更换网络后再试」那一类，902049 那族）。\n这一格管的是：同一条出口上有一个号被它拦下之后，其余号在等满下面这个时间之前都不再去撞它。\n换着号接着撞，只会让官方更确定这是机器在干活；想立刻继续，换一条网络（手机热点／代理线路）再点「启动」。", fields: [
        num("egress_minutes", "同一条出口上被官方拦下一个号之后，其余号先等多久再试", 60, {
          min: 0, max: 1440,
          hint: "什么时候自动用上这里：官方把某个号判成「出口网络有风险」（它回「请更换网络后再试」那一类）之后——同一条出口线路上（没绑代理线路时就是这台机器）的其他号，在等满这个时间之前都不再发起登录，页面上会直接把这句话与还要等多久说给你。为什么要有：官方判的是网络出口，不是号；换一个号接着撞只会让它更确定这是机器在干活。填 0 ＝ 不连坐，各号照旧各试各的（默认不是 0）。出厂 60 分钟，出处与号级那把「风控类不自动重试 60 分钟」的尺同一把。想立刻放开：换一条网络（手机热点/代理线路）再点「启动」。",
        }),
      ]},
      { id: "anti_detect", label: "防封节奏",
        desc: "真实挂机时的操作快慢与在线时长约束；越保守越像真人，但做完同样的事要更久。这一组由第一格总开关统一管："
          + "关着时下面的操作节奏与各项上限都不生效（不限次数、不自己休息），打开后按你选的节奏执行。",
        fields: [
        // [第22件·2026-09-23 重构] 这一格以前是**死行**：`humanPolicyFromConfig` 从不读它，
        // 标签还自认「不控制任何行为」——一条改不动任何东西的假开关（已入错误清单第 19 条那种形状）。
        // 现在它是**真总开关**，判据链：本格 → `humanPolicyFromConfig`（读 `basic.anti_detect.enabled`）
        // → `createHumanPolicy.limitsEnabled` → `HumanRiskGuard.evaluate`（额度/休息/睡窗整段跳过）。
        // 关（出厂）＝不限次数、不自己休息；开＝下面的档位与四个上限全部生效。
        // ⚠️ 底线三项**不挂在这把开关上**（动作最小间隔／登录后只读核查窗／写后不重发与单会话），
        //    它们写在下一节「脚本永远会做的四件事」里，只读、不给勾。
        sw("enabled", "开启节奏限制（关着＝不限次数、不自己休息；打开＝按下面的操作节奏与各项上限执行）", false, {
          desc: "这一格是这一组的总开关。关着（出厂就是这样）＝脚本不按次数给自己设限、也不会自己下线休息；"
            + "打开＝下面的「操作节奏」与四个上限、以及每天那一觉全部生效。"
            + "两种情况下，账号安全的几条底线都照旧（见下一节「脚本永远会做的四件事」）。",
        }),
        sel("human_preset", "操作节奏", "balanced", [
          { label: "保守（最像真人，速度最慢）", value: "conservative" },
          { label: "均衡（推荐）", value: "balanced" },
          { label: "激进（速度快，风险高）", value: "brisk" },
        ], cadenceChild()),
        // [2026-09-23 第 21 件·补] 这四格出厂都是 0，而 0 从来没人说清是什么意思（客户以为"一个都不许写"）。
        // 现在逐格写明「0＝跟着上面选的操作节奏走」并把**现算的**三档数印出来；数字一律从档位表取。
        num("max_writes_per_hour", "每小时最多操作多少次" + cadenceZeroLabel("maxWritesPerHour", "次")
          + "（不是“无限制”，也不是“一次都不许”）", 0,
          cadenceChild({ min: 0, max: 3000, desc: cadenceZeroDesc("maxWritesPerHour", "次", "小时") })),
        num("max_writes_per_day", "每天最多操作多少次" + cadenceZeroLabel("maxWritesPerDay", "次")
          + "（不是“无限制”，也不是“一次都不许”）", 0,
          cadenceChild({ min: 0, max: 20000, desc: cadenceZeroDesc("maxWritesPerDay", "次", "天") })),
        num("max_actions_per_minute", "每分钟动作上限" + cadenceZeroLabel("maxActionsPerMinute", "个")
          + "（不是“无限制”，也不是“一次都不许”）", 0,
          cadenceChild({ min: 0, max: 300, desc: cadenceZeroDesc("maxActionsPerMinute", "个", "分钟") })),
        num("daily_max_online_minutes", "每日最长在线（分钟）" + cadenceZeroLabel("dailyMaxOnlineMinutes", "分钟")
          + "（不是“无限制”，也不是“一次都不许”）", 0,
          cadenceChild({ min: 0, max: 1440, desc: cadenceZeroDesc("dailyMaxOnlineMinutes", "分钟", "天") })),
        // 2026-09-10 起睡眠起点收进深夜带（00:00–03:00 抽起点、睡 6–9 小时）。
        // 旧写法是从全天 1440 分钟里抽，实测官服 2280 那个号 16:09 就"睡下"、00:02 才醒，
        // 整个傍晚到午夜停着不动；现在这条文案可以说「深夜」了，旧的「任意时间」说法一并作废。
        // [2026-09-23 第 21 件·补] 这句话必须在 **label** 里：客户面只渲染 label（括号那截会降成第二行小字），
        // `desc` 目前不上屏（现读：设置行只带 label/hint，field.desc 没有渲染落点）。所以两处都写，
        // 屏上看 label、接口消费方看 desc——**同一个数（6~9 小时）来自同一对常量**，不各写一份。
        sw("disable_sleep_window", "取消每日休息时段（不推荐；关着＝本号每天要睡 "
          + SLEEP_HOURS_MIN_DEF + "~" + SLEEP_HOURS_MAX_DEF
          + " 小时：深夜自己挑个起点下线、睡到自然醒才继续，这期间不扣费；打开＝24 小时不下线）", false, {
          desc: "关着（出厂就是这样）＝本号每天要睡 " + SLEEP_HOURS_MIN_DEF + "~" + SLEEP_HOURS_MAX_DEF
            + " 小时：脚本会在深夜自己挑个起点下线，睡到自然醒才继续（这期间不扣费、也不用你再点启动）。"
            + "打开＝这一觉取消，账号 24 小时不下线——更像机器，风险自负。"
            + "（这一格只在上面总开关打开后才有意义：总开关关着时，脚本压根不睡。）",
          showWhen: CADENCE_MASTER_KEY,
        }),
        // [L14 值守排程·09-14] 作息三控点（数值字段，默认值＝现行行为，零改变；调了才生效）。
        // 休息起点带刻意不开放：全天带实测会让账号在傍晚「睡下」（官服 2280 的 16:09 事故），锁死深夜带是唯一的安全阀。
        num("sleep_hours_min", "每日休息时长·最少（小时）", SLEEP_HOURS_MIN_DEF, cadenceChild({ min: 2, max: 12 })),
        num("sleep_hours_max", "每日休息时长·最多（小时，按天随机落在最少～最多之间）", SLEEP_HOURS_MAX_DEF, cadenceChild({ min: 2, max: 14 })),
        num("session_rest_minutes", "两次上线之间歇口气（分钟，0＝跟着上面的操作节奏走）", 0, cadenceChild({ min: 0, max: 240 })),
        sw("sdk_heartbeat", "保持游戏一直在线（防掉线）", false), // 真判据：关掉＝不发 SDK 心跳，世界连接更容易掉线、重连要重新排队
        // [第45件 C 块·§5.2.2] 「最长多久巡一遍」：睡到最近一个到点时刻之后，没事时最迟隔这么久也全体检一次。
        // 这是防睡过头的**安全垫**，不是限速闸——它不受上面「开启节奏限制」总开关管（总开关管的是发写的快慢与额度，
        // 这一格只管「多久重新看一遍号上的事」），所以不走 `cadenceChild()`。出厂 5 分钟＝取值理由见工作日志。
        // 真判据：`real-harvest-runner.js` 的 `wakePatrolCapMs()` 每轮现读这一格（改完最迟下一循环生效）。
        num("wake_patrol_cap_minutes", "最长多久巡一遍（没到点的事时，最迟隔这么久也全体检一次）", 5, {
          min: 1, max: 60, suffix: "分钟",
          hint: "到点会提前醒（比如地熟了就去收）；这一格是「没事时也别看漏」的兜底：最迟隔这么多分钟重新看一遍号上的事。不是限速，也不受总开关影响。",
        }),
      ]},
      // ── [第22件·2026-09-23 立] 账号安全的底线：**不挂任何开关**，所以单独成一节，只读 ──
      // 为什么单列：这几条在任何档位、任何开关下都成立（包括上面那格总开关关着的时候）。
      // 以前它们混在「防封节奏」那一组里、和可调的额度摆在一起，客户会以为"关掉这一组就什么都不管了"——
      // 用户 09-23 的口径正是要把它拆出来：**能关的（节奏）与不能关的（底线）分开写**。
      // `type: "note"`＝只读说明行：渲染层不画控件、也不显示值（见 web/src/pages/ConfigGroups.jsx 的 note 分支）。
      { id: "always_on", label: "脚本永远会做的四件事",
        desc: "这四条不受上面任何开关影响——它们保的是账号安全，我们没有给你关掉它们的口子。",
        fields: [
          // 〔10-02 用户当面抓到那句假话〕旧写法把 `createHumanPolicy` 里 clamp 的**下界**（读 60／写 300 毫秒）
          // 当成"实际停顿"印上屏，而运行期真正拦那一发的是 `policy.writeGapMs[0]`——均衡档 = **900 毫秒**
          // （`human-pacing.js` 档位表 + `evaluate()` 的 `min-gap` 那一支取的都是第一元）。
          // 下界只有在客户自己往面板里填数时才起作用，没填数时它一个字都不参与，印上屏就是「屏上的数
          // 与判据用的数不同源」（铁律 13 第 2 条）。现在三档全从**同一张档位表**现算，关着那一档从
          // `GAP_FLOOR_MS` 现算——改了档位表或改了地板，这句话自己跟着变，代码里再也没有第三个数。
          // 〔第146件 M2·zcode 单 S2 改口〕旧句把两件事揉进一句：「每一步之间都会等一下，绝不会连着发」——
          //   而运行期「同目标有一条写在飞绝不发第二条」自本批起是 **常开底线**（`HumanPacer` in-flight 门闩，
          //   不随「操作节奏」那格关），"会不会等一下"才归那一格。一句顶两件事＝客户关着那格时屏上说的
          //   与后台做的对不上（10-02 同族形状），拆成两句与行为逐一对齐。
          note("red_line_min_gap", "① 同一件事绝不重复发，有一条还没等到回话，就不会对它发第二条"
            + "（这一条一直生效，关掉上面那格也不松）；每一步之间会不会等一下：开着上面「操作节奏」那格时，"
            + "读最快 " + gapPerPresetZh("readGapMs") + "、动手最快 " + gapPerPresetZh("writeGapMs")
            + "（跟着你选的那一档走）；把那格关掉之后只剩这一条底线：读最快 " + gapMsZh(GAP_FLOOR_MS.read(false))
            + "、动手最快 " + gapMsZh(GAP_FLOOR_MS.write(false)) + "。"),
          note("red_line_login_readonly", "② 刚登录的一段时间里只看不动：先看看号上的状态，确认稳定了再开始动手"),
          // 〔10-02 页面实测抓到破句〕手机端一行主句最长 16 字（`hosting-model.js` 的 `ROW_LABEL_MAIN_MAX`），
          // 超出部分并进右边那枚「?」。旧写法「送出去没等到服务器回话就不再送那一条」被截成
          // 「③ 送出去没等到服务器回话就不再」——半截话（"就不再"后面没了）。这一族的每一句都要把
          // **前 16 字之内落一个句内标点**当作写法（判据在 `tests/pacing-master.mjs` ⑦：四行逐条量）。
          note("red_line_no_resend", "③ 没等到服务器回话就不重发，送出去的那一条绝不补发第二遍；"
            + "同一个号同一时间只在一台客户端在线（不会和你的游戏撞号）"),
          // [第32件·2026-09-23 用户点名] 第四条底线：**两次登录之间会隔一会儿**。
          // 它不挂在「开启节奏限制」总开关上（`limitsEnabled` 只管额度与休息那一族，见
          // `human-pacing.js:591-645`；重登间隔的判定在 `:767`，**没有** `limitsOn` 前缀）。
          // 数字从档位表现算：`human-pacing.js:74` 均衡 300000ms、`:110` 底线表名字、`:176` 激进 120000ms。
          note("red_line_relogin_interval",
            "④ 两次登录之间会隔一会儿再试：现在是 " + cadenceReloginZh()
              + "（按上面选的操作节奏走）。这条也不受总开关影响——连着顶号最容易被判成脚本，所以它一直在。"),
        ]},
      { id: "daily_task", label: "每日任务", desc: "自动领取每日任务奖励和日常任务宝箱。", fields: [
        sw("enabled", "开关", false),
        // 〔2026-10-07 用户令「直接删掉这个功能和相关的代码逻辑」〕原 `claim_salary`（自动领取每日俸禄）
        // 一格随每日俸禄整卡退役：官方现版本已下掉该功能（客户端零调用点＋奖励公式归零＋任务池 0 行）。
        sw("claim_task_rewards", "自动领取任务奖励", false),
        sw("claim_activity_box", "自动领取日常任务宝箱", false),
        // [任务优先级·09-18 客户点名] 客户原话「任务是任务，种地是种地」「每天过了 0 点后先完成每日任务」。
        // 这一格原来放的是参考站那份**拖拽排序数组**（type: "order"）：本仓从来没有读取方，
        // 手机端也只能显示「顺序已调好（共 N 项）」而不能拖 ⇒ 是个假开关。改成布尔优先级：
        // 开了就把「日常」这一段提到每轮最前面（默认关＝与今天逐字一致，铁律 5）。
        sw("daily_first", "过了 0 点先做每日任务（做完再回地里干活）", false),
      ]},
      { id: "weekly_task", label: "每周任务", desc: "自动领取每周任务奖励。", fields: [sw("enabled", "开关", false)] },
      // [W15·09-18 成长之路接线] 两条写各挂一把自己的真实写闸（两把都 def=false，铁律 5 零例外）：
      // 总开关＝这件事的意愿，下面两把＝真的动手。只开总开关＝只出计划，一个包都不发。
      // ⚠️ 原来那一格 `claim_vip_rewards` 按铁律 8 第 1/2/4 条**改口说真话**：
      // 施工单原先的口径是「要月卡」，现读证据反过来——积分宝箱里给的 VIP 特权卡是**白送的奖励**
      // （官方还原表 c_task_roadGrow 元行 $gradeReward 第 2、3 档＝物品 1008「VIP特权卡(1天)」，
      // c_item 逐字；官方红点判据 Red_roadGrow.logic_rwdBox 里没有任何 VIP 判定），
      // 不是「要月卡才能领」。所以它不单独生效、也没有第二条通道：那几只箱子由下面
      // 「真的去领积分宝箱」一并覆盖。**不能把一句与事实相反的话写上客户屏。**
      { id: "road_grow", label: "成长之路", desc: "自动领取成长之路里已达标的任务奖励和积分宝箱。这一项不花你号里任何东西（领奖不下任何代价），但领到的奖收不回来，所以分成两个开关、各管一条。", fields: [
        sw("enabled", "开关", false),
        sw("real_road_grow_recv", "自动领取已达标的奖励（关掉就一个都不领）", false),
        sw("real_road_grow_box", "自动领取积分宝箱（里面那张「特权卡」是白送的奖励，不用月卡）", false),
        sw("claim_vip_rewards", "本项不单独生效：含特权卡的那几只宝箱由上面「真的去领积分宝箱」一并领（不是要月卡）", false),
      ]},
      // 主线动作的次序由**官方环序**决定（`MAIN_TASK_ORDER` 那份参考站数组没有任何读取方，
      // 手机端也拖不动），所以这里不再摆一格假开关——要调先后请用「任务执行顺序」之外的真开关。
      { id: "main_task", label: "主线任务", desc: "完成主线任务并领取奖励（每一环做什么由官方的环序决定，不提供自定义顺序）", fields: [
        // [44D·铁律 16 二期] 原来是死槽：代码读 max_recv_per_cycle、schema 里没有它 ⇒ 常量上页面（默认 1＝MAIN_TASK_ACTION_CAP）。
        num("max_recv_per_cycle", "每分钟最多领几次主线奖励", 1, { min: 1, max: 5, hint: "按滚动的一分钟算（不按整点分）：这一分钟领过的次数都算数，包括计划里带上、后来没发出去的那一发。" }),
        sw("enabled", "开关", false),
        sw("claim_main_rewards", "达标后自动领取主线奖励", false),
      ]},
      // [2026-09-22] 引导进度上报（用户点名补的那条官方写）。**单独一张卡**、单独一个模块，
      // 因为它的实服证据档位与本卡其它项不同（这条一次都没真发过 ⇒ 卡级徽标只能是「已接通·待复验」，
      // 折进「主线任务」那张已打通的卡里会把没验过的写说成验过的，铁律 12）。
      // 两把闸都 def=false：总开关＝这件事的意愿，真实写闸＝真去发。卡面把代价与不勾的后果写清（铁律 8）。
      { id: "guide_progress", label: "引导进度上报", desc: "把「刚领完那一环」对应的引导步告诉服务器，让你自己登录游戏时那只新手手指能往前挪（我们不发它就一直停在原地）。它只在你这一环的奖励真的领到手之后才报，不按进度猜、也不会替你假装走过引导；报的值只会从官方主线表那一行里取，取不到就整条不发。关掉它：引导手指停在原地，其余功能一律不受影响。", fields: [
        sw("enabled", "开关", false),
        sw("real_guide_progress", "自动把引导进度上报给服务器（关掉就一条都不报）", false),
      ]},
      // [W13·09-18] 主线剧情解锁接线。这一发**零参数、不可逆**：官方 `gs.storyMain.unlock` 的实参表是
      // 空对象（`G.GS.storyMainIface.IArg_unlock {}`），服务器按它自己那份进度扣星星并往前推，
      // 花掉的星星**退不回来**。所以两把闸分开：总开关＝这件事的意愿，真实写闸＝真去花星星。
      // 「每天最多解锁几节」是**我们自己加的节奏闸**（官方没有这个数，官方的真闸是星星够不够 +
      // 每天最多获得 600 颗），出厂按最保守的 1 节。卡片说明里把这三件事逐条写清（铁律 8 第 3/4 条）。
      { id: "story_main", label: "主线剧情", desc: "花剧情星星解锁主线剧情的下一节。星星靠收花慢慢攒（每收一朵花给一颗，每天最多 600 颗），解锁要先花掉星星；花出去的星星不会退回来。这一项只做「解锁」这一件事，不替你做主线任务、也不代领每章通关的奖励。", fields: [
        sw("enabled", "开关", false),
        sw("real_story_main_unlock", "自动花星星去解锁剧情（关掉就一颗星星都不花）", false),
        num("max_unlocks_per_day", "每天最多解锁几节（这条上限是我们加的，游戏本身没有这个数）", 1, { min: 1, max: 20 }),
      ]},
      { id: "flower_bounty", label: "花坊悬赏", desc: "每次帮你在花坊悬赏里领一档已经够条件的奖励（没到条件的档一律不碰，一次最多领一档）。三件不做：要看完广告的「观看视频」、要花元宝的「使用元宝」，两样都不代做；还有「居民订单」那一组——它由「居民订单」那张卡负责，这一张不重复领，免得同一档发两次请求。每一档一生只能领一次，领过就再也不会有。", fields: [sw("enabled", "开关", false)] },
      { id: "mail", label: "邮件配置", desc: "自动同步邮件并领取可领取附件。", fields: [sw("enabled", "开关", false)] },
      // [第121件·2026-10-05 用户点名] 「双倍金币这个功能必须要对接的，需要看广告，而且需要开始运行游戏托管
      //   的时候，就先做这个，如果此时还没过期，需要记录下次看广告的时候，到点直接开始看广告。」
      //   ⇒ 这一格从「本项当前不生效」的下架留档里**解除**（它是铁律 9 §C 点名接入的第三案）。
      //   一格单开关卡（格名照本仓既有形状叫 enabled）；判据与取值表在 `double-coin-cycle.js` 头注
      //   与 `memory/plan-1004-double-gold-ad.md` §1/§4：**只在特权到期时才发**（官方 UI 在生效中
      //   根本不画那个按钮），发出之后只认服务器把分享账记上；提前点会被吃、续到几点以服务器下发的
      //   到期时刻为准（一次续多久由游戏里那张表定）。
      { id: "double_coin", label: "双倍金币", desc: "游戏里看一段视频能领的「4 小时金币翻倍」。在游戏里原本要点开一段广告——脚本不看广告，直接发官方那一发领取请求；到点自动续，特权没过期时一次都不发（游戏里这时本来也没那个按钮）。", fields: [
        sw("enabled", "开关", false, {
          hint: "续「双倍金币」的特权：领到之后这几小时里，收花卖花、交订单拿到的金币翻倍"
            + "（翻倍是游戏按特权结算的，脚本不自己算钱）。一次续多久、每天最多续几次，都按游戏里那张表算，这里没写死。"
            + "⚠️ 这一格原本要点开一段广告——脚本不看广告，直接发官方那一发领取请求；"
            + "服务器收不收这种请求不是猜的，2026-10-01 起同一条请求在真号上已验过多族认账（订单视频单、礼包商城、水车水桶）。"
            + "⚠️ 特权还在生效时不重复发（提前点会被吃掉、白白浪费一次机会）：脚本会记住到期时刻，到点自动续。",
        }),
      ]},
      { id: "welfare_box", label: "福利宝箱", desc: "自动领取福利宝箱奖励。", fields: [sw("enabled", "开关", false)] },
      { id: "share_reward", label: "分享奖励", desc: "本项当前不生效：分享要真人操作，脚本不代做。", fields: [sw("enabled", "开关", false)] },
      { id: "first_craft", label: "花艺首做", desc: "本项当前不生效：花艺首做的那份奖励要走分享，脚本不代做；只想做花艺请用「花艺成品」那张卡。", fields: [sw("enabled", "开关", false)] },
      // [W2 接线] 每周防诈骗答题：总开关之外两步各一把真实写闸（铁律 5：新增开关一律默认关）。
      // 答题那一步只是把「答完了」告诉服务器（零参数、不扣任何东西）；领奖那一步拿走奖励。
      // 两把分开是为了让「只答不领」做得到——领奖一旦有争议，用户可以只关这一把。
      { id: "anti_fraud", label: "防骗宝箱", desc: "自动完成反诈问答。", fields: [
        sw("enabled", "开关", false),
        sw("real_anti_fraud_answer", "答完每周防诈骗题", false),
        sw("real_anti_fraud_recv", "领取防诈骗答题奖励", false),
      ] },
      // [W3 接线] 半月四活动「白拿档」：百花成蜜 / 花笺集芳 / 碎玉成瓶三个活动的零消耗领取（领箱子、领任务花笺）。
      // ★ [09-29 用户点名「进度奖励也要能领取」] 莳花纪闻的分数宝箱已迁到「莳花纪闻」那张卡上
      //   （scope act-story-recv 的 ACTION_GATES 同批改指）——这一张只管其余三个。
      //   〔2026-10-02〕那张卡上的宝箱与交订单现在都由卡头「是否启用」一把说话（子闸已下架，见 PARKED_FIELDS）。
      // ★ 有代价的那几档刻意不接，卡面上如实写清楚：立即完成要花道具、买礼包/换任务/开槽要扣元宝——一条都不自动发。
      // 上限那一格是我们自己的节奏闸门（一轮最多四发），**不是**官方数值，所以注释里不假冒出处。
      { id: "activity", label: "半月四活动（白拿档）", desc: "百花成蜜、花笺集芳、碎玉成瓶三个半月活动里，只领零消耗的宝箱与任务奖励；要花道具或元宝的那几档一律不自动做。莳花纪闻（交订单/领宝箱/元宝刷单）在它自己那张卡上。", fields: [
        sw("enabled", "开关", false),
        num("max_claims_per_cycle", "每分钟最多领几发", 4, { min: 1, max: 4, hint: "按滚动的一分钟算（不按整点分）：这一分钟领过的次数都算数，包括计划里带上、后来没发出去的那一发。" }),
      ]},
      // 随机事件（官方叫「和小动物互动」）：日常任务池 11 条之一，刷到这一条时没有执行器就只能干等。
      // 上限那一格不许超过官方 $eventMax=2（执行器自己也会再夹一次，这里夹是免得面板上能填出个假的 5）。
      { id: "random_event", label: "小动物互动", desc: "场上刷出小动物时过去互动一次，推进日常任务「和小动物互动」，不消耗任何东西。", fields: [
        sw("enabled", "开关", false),
        num("max_events_per_cycle", "每分钟最多互动几只", 2, { min: 1, max: 2, hint: "按滚动的一分钟算（不按整点分）：这一分钟互动过的次数都算数，包括计划里带上、后来没发出去的那一发。" }),
      ]},
      { id: "sign_in", label: "自动签到", desc: "自动完成每日签到(每日祈愿)。", fields: [
        sw("enabled", "开关", false), sw("auto_makeup_sign", "自动补签", false),
        sw("shop_cultivate", "自动花费元宝补签漏签日期（需先开启自动签到）", false),
      ]},
      { id: "pearl", label: "珍珠配置", desc: "自动领取每日免费雇佣书、收珍珠、往空位上雇人——雇人只用免费的雇佣书；开新的采集位要单独勾（扣号里的元宝，官方表里第 2 格 50、第 3 格 200，最后一格要月卡所以永不碰）；元宝买书、自动抽奖这些一律不替你做。", fields: [
        sw("enabled", "开关", false),
        // 2026-09-11 珍珠执行器接线：这三格是执行器真正读的开关，一格管一件事，
        // 「只收不雇」「只雇不收」都必须做得到（与花架、水滴补给同一纪律）。
        sw("enable_free_pearl", "每日免费领取雇佣书", false),
        sw("enable_recv", "一键收珍珠", false),
        sw("enable_hire", "雇佣劳工", false),
        // [第130件·2026-10-05 用户点名「珍珠有两个看广告领取的功能，把这个给我对接上，留一个开关」]
        //   勘察定案（见工作日志第130件）：官方珍珠模块**只有一条**看广告通道——珍珠页那个「看视频领珍珠」
        //   （分享号 10 由官方 c_pearl 元行 $freeShareId 指认、每天 2 次、每次 500 颗，采集/雇佣两个页签
        //   画的是同一个按钮同一个额度——屏上看着像两处，代码里是一家）。
        //   与第83件视频单、第103件礼包、第120件水车广告桶同族第 7 例：不发广告 token、直发领取包，
        //   服务器认账已在真号上定性（第83件 8 笔全认）。铁律 9 §C：看广告＝逐案点名，本案只点名珍珠这一条。
        sw("real_pearl_ad_pearl", "看视频领珍珠（每天最多 2 次）", false, { hint: "看一段视频领 500 颗珍珠，每天最多 2 次，不扣号里任何东西。\n勾上自动领，用满当天不再发，明天接着。\n不勾＝一条不发（想自己领的就保持不勾）。"
          + "\n「采集」「雇佣」两个页签各有一个这按钮——同一个功能，共享这 2 次。" }),
        // 三条来源都已接进真实链路（2026-09-11 补最后一条「世界推荐」）：它不在登录下发的那份状态里，
        // 执行器会像官方客户端一样另外发一条只读请求去问名单，问到人才雇。
        sel("hire_source", "雇佣来源", "friend", [
          { label: "好友列表", value: "friend" }, { label: "冤家列表", value: "enemy" },
          { label: "世界推荐（另外问服务器要一份名单）", value: "world" },
        ]),
        // 官方一共四格采集位，第四格要月卡（脚本读不出月卡态就不碰），所以一轮三发就是上限。
        num("max_hires_per_cycle", "每分钟最多雇佣次数", 3, { min: 1, max: 3, hint: "官方一共四格采集位，第四格要月卡（脚本读不出月卡态就不碰），所以这一分钟最多三发。按滚动的一分钟算（不按整点分）：计划里带上、后来没发出去的那一发也算用掉。" }),
        num("hire_reserve_count", "至少保留雇佣书", 0, { min: 0, max: 99 }),
        // 〔第191件·H09 第二档〕开新的采集位：官方表里第 2、3 格写明扣元宝 50/200（c_pearl 现读 cost=[1,50]／[1,200]），
        //   第 4 格没有价格、只有 mCardUnlock=1（月卡＝真实付款那一环，永不接）。这一发扣号里真实的东西 ⇒ 出厂关着（铁律 5）。
        sw("real_pearl_unlock_place", "开新的采集位（花号里的元宝）", false, {
          hint: "珍珠馆里空着的采集位，官方表写死了价：第 2 格 50 元宝、第 3 格 200 元宝（最后一格要月卡，脚本不碰月卡那一步）。\n勾上才会开，只开还没成的那几格，官方已经记着的格子不再花第二遍。\n代价：这是号里真实扣掉的元宝，扣了就回不来。不勾＝一格都不开（想自己开的就保持不勾）。",
        }),
        // 保留线排在「扣」之前判（先扣后判＝同一趟开两格不能吃同一笔钱）；0＝不设底线，与别的保留线格同一条口径。
        num("unlock_place_keep_yuanbao", "开位之后元宝至少留多少", 0, { min: 0, max: 99999, hint: "留着不花的底线：扣完这一格要是比这个数还少，那一格就不开。填 0＝不设底线。" }),
        // 以下三格刻意留着但**不会驱动任何真实写**：开珍珠与买雇佣书要花东西、护身符会影响别人，
        // 全部由玩家自己在游戏里按。
        // [W10 09-18] 等级范围已接进真链路：执行器会另外发一条只读查人请求去问这批人几级
        // （oppt.getOppts，官方客户端雇佣页也是另外发的），按这个范围挑人。
        // 默认 1~50 是官方客户端的默认值，等于「不设等级门槛」，所以默认档下那条请求一条都不发。
        rng("hire_level_min", "雇佣等级范围（会另外问一次服务器；问不到等级的人不雇）", 1, 50),
        // [W10 09-18] 每天雇佣书使用上限：这是**本地花销闸**（我们自己的账），不是游戏状态判据——
        // 官方表里没有这一格，所以它只用来「别把雇佣书一天花光」，绝不拿它推断服务器状态。
        // 口径与既有数值闸一致：0＝不限（默认），填了 N 就表示今天最多再雇 N 本。
        num("hire_book_daily_limit", "每天最多用几本雇佣书（0＝不限）", 0, { min: 0, max: 999 }),
        sw("enable_auto_draw", "自动开珍珠（暂不生效：要扣东西）（暂不生效）", false),
        sw("enable_protect", "防身符（暂不生效：会影响别人）（暂不生效）", false),
        sw("enable_auto_buy_ticket", "买雇佣书（暂不生效：花元宝）（暂不生效）", false),
        sel("hire_book_tier", "买哪种雇佣书（暂不生效）", "big", [
          { label: "小包雇佣书（5本 / 25元宝）", value: "small" },
          { label: "中包雇佣书（10本 / 45元宝）", value: "middle" },
          { label: "大包雇佣书（20本 / 80元宝）", value: "big" },
        ]),
        num("buy_ticket_yuanbao_limit", "元宝上限（暂不生效）", 500, { min: 0, max: 99999 }),
      ]},
      { id: "shop_buy", label: "材料商店", desc: "买培育材料，并可每日免费刷新一次货架。", fields: [
        // [44D] 原来是死槽 ⇒ 常量上页面（默认 3＝CULTIVATE_SHOP_ACTION_CAP）。
        num("max_buys_per_cycle", "每分钟最多买几次", 3, { min: 1, max: 20, hint: "按滚动的一分钟算（不按整点分）：这一分钟买过的次数都算数，包括计划里带上、后来没发出去的那一发。" }),
        sw("enabled", "开关", false),
        sw("shop", "材料商店", false), sw("free_refresh", "免费刷新", false),
        num("refresh_wait_minutes", "刷新间隔多久一次（暂不生效）", 10, { min: 0, max: 120, suffix: "分钟" }),
        num("gold_limit", "金币下限", 100000, { min: 0 }),
        // [第50件追加·2026-09-26 实屏口径收口] 元宝直购**不在这张卡上**：用户原话「培育鲜花这里，
        //   增加一个选项，是否使用元宝直接补充培育材料」⇒ 开关与保留线都归「培育新花」卡（见下）。
        //   上一版曾在这里放一把"总闸"＋一条保留线（四格串联），实屏现读证伪：材料商店卡在卡序里
        //   排在培育卡前面，前端「先到先得」把培育卡上那格认领走了 ⇒ 客户在培育卡上根本看不到
        //   自己勾的那一项（铁律 12 §3）。四格串联连同这两格一并退场，留档见 worklog。
      ]},
      // [第103件·2026-10-02 用户当面点名] 「礼包商城里面，有个免费的元宝礼包，每天可以领取四次，需要看广告，
      //   这个给我对接上，设置里面需要预留开关」＋同日纠正「材料商店跟礼包商城，不是一个地方啊，
      //   而且材料商店没有视频礼包啊」⇒ **礼包商城自己成一个家**（官方 `shopGiftbag`＝同步模块 112，
      //   与材料商店 `shopCultivate`＝113 两表两 RPC 两模块），这一族的格一格都不许再留在材料商店名下。
      //   判据与红线见 `server/src/game/giftbag-ad-cycle.js` 头注（四段官方式子逐字抄在那儿）。
      { id: "giftbag_shop", label: "礼包商城", desc: "游戏里「礼包商城」那一页：只领看广告免费送的那一档。", fields: [
        // 一把开关、格名照本仓既有形状叫 `enabled`（单开关卡同一口径：`flower_bounty`/`welfare_box`/`mail`…）——
        // 守卫 `tests/hosting-directory.mjs` 判据①③⑤⑥ 认的就是「署名卡的那一格由卡头那把「自动执行」代表」，
        // 自造一个 `real_*` 键名会让这一格既不在 hiddenSwitches 也没铺出来＝客户连开它的地方都找不到。
        sw("enabled", "开关", false, {
          hint: "领游戏里「礼包商城」那一页每天四次的免费元宝礼包：不花你号里任何东西，领到的是元宝。"
            + "每领一次要隔两小时才有下一次（四次这个数与两小时这个间隔，都按游戏里那张表算，这里没写死）。"
            + "⚠️ 这一档游戏里原本要点开一段广告——脚本不看广告，直接发官方那一发领取请求；"
            + "服务器收不收这种请求不是猜的，2026-10-01 在真号上已验过同一发请求认账（那是订单里那一格）。"
            + "礼包商城里其余那些档都要花充值换来的元宝/人民币，这张卡一档都不碰（要真掏人民币的那种更不碰）。",
        }),
      ]},
      { id: "vip_shop", label: "VIP商店购买", desc: "每日使用花坊币购买水滴和加速卡，仅对有效VIP账号生效。", fields: [
        sw("enabled", "开关", false),
        num("water_daily_purchase_limit", "水滴每日购买上限（暂不生效）", 10, { min: 0, max: 99 }),
        num("speed_card_daily_purchase_limit", "加速卡每日购买上限（暂不生效）", 5, { min: 0, max: 99 }),
        num("flower_coin_reserve", "花坊币保留", 100, { min: 0 }),
      ]},
      // 花坊（官方店号 6，界面代码里写死）：顾客订单攒的花坊币换鲜花，每种终身限购一次。
      // ⚠️ 主线任务表里那两环的 jumpTo=18 是另一家店，照它跳就会往别家花钱——店号只认执行器里的 6。
      { id: "flower_shop", label: "花坊兑换鲜花", desc: "用顾客订单攒的花坊币换鲜花（每种终身只换一次）。一次请求换一件；每次动手换几件跟着你选的那一档走——选「只换主线任务要的」就最多排到主线这一环还差的那几次。", fields: [
        sw("enabled", "开关", false),
        // 花坊币是消耗资源，真实写默认关：不点头就永远只出计划，一条都不发。
        sw("real_flower_shop_buy", "自动花坊兑换鲜花（花坊币花出去退不回来）", false),
        // [第63件·2026-09-27] 「什么时候自动换花」——旧行为「换得起就换」由这一格接管。
        //   病根：花坊币是顾客订单攒来的**消耗**资源，而官方主线表里花坊兑换一共只有 5 环
        //   （`c_task_main` 现读：490001＝累计兑 1 次、1050001＝2 次、1370001＝3 次，另有两环 type=3012）；
        //   把当前这一环要的次数用完之后再换，就是替后面几环**预支**花坊币。
        //   ⇒ 出厂＝「不自动换」（铁律 5：新格一律不许默认开）；要动手得用户自己选「只换主线任务要的」。
        //   运行期判据在 `flower-shop-cycle.js` 的 `judgeFlowerShopPurpose`：只认这一档，
        //   键不在／值认不出来一律当「没选目的」（fail-closed，一枚币都不动）；「还差几次」当场从
        //   官方表 `c_task_main.value` 与同步态 `taskTot.main.curValue` 算，**代码零写死**。
        //   代价句（铁律 8 第 3/4 条）提前摆出来：行上那截括号进「?」，`desc` 进「?」弹层
        //   （`web/src/hosting/hosting-model.js` 的 `explain` 取的就是 field.desc）。
        sel("sel", "什么时候自动换花（⚠️ 它只管「什么时候换」，不管「换多少」：主线那一环要几次就换几次，一次至多一件。⚠️ 花坊币是顾客订单攒来的消耗品，每种花官方只让换一次，换错换不回来）", "不自动换", [
          { label: "不自动换（出厂；这一档下脚本一枚花坊币都不动）", value: "不自动换" },
          { label: "只换主线任务要的（主线那一环要兑换几次才换几次；主线不要花坊兑换时一枚币都不动）", value: "只换主线任务要的" },
        ], {
          desc: "换花坊这件事有三笔代价，先说清再决定：① 花坊币是完成顾客订单攒来的消耗品，换掉就没了；"
            + "② 每种花官方只让换一次（终身限购），换错换不回来；"
            + "③ 官方主线任务表里花坊兑换一共只有 5 环，主线不要它的时候换，等于替后面几环提前把币花掉。"
            + "所以出厂是「不自动换」，要动手请自己选「只换主线任务要的」：那一档只在主线这一环真要做花坊兑换、"
            + "而且按你的进度还差至少 1 次时才换，一次至多一件。"
            + "这一格决定的是「什么时候换」，不是「换多少」——换几件由主线那一环要的次数决定。",
        }),
        // 保留额是给 VIP 商店留的：两家店花的是同一种币（面板 basic.vip_shop 也扣 1002）。
        num("flower_coin_reserve", "花坊币保留", 0, { min: 0 }),
      ]},
      { id: "redeem_code", label: "兑换码", desc:
        // 10-04 真实说法（解除下架）：链路已接线——码从码库来（自动看播收录／管理端手动录），
        // 号在跑的轮里一次最多兑一枚、每号每码只兑一次（发过永不重发，含没等到回话的）。
        // 两条依赖明写（铁律 8 第 4 条）：①奖励走系统邮件，要领奖请另勾「邮件」；
        // ②晚 8/9/10 点的短效码有时效，只有那一刻号正在跑的才吃得到；7 点常驻码当晚随时启动都能补兑。
        "自动兑换码（一次只兑一枚，每号每码只兑一次，兑过绝不重发）。码从码库来：自动看播收录直播间的公开码，也可在管理端手动录入。注意：奖励走系统邮件附件，要顺手领奖请同时打开「邮件」；晚上 8/9/10 点的限时码只有那一刻正在跑的号吃得到。",
        fields: [
          sw("enabled", "要自动兑码（直播间公布的兑换码，号在跑的时候自动兑）", false),
          sw("real_redeem_use", "真的把码交给游戏去兑（关掉就只出计划，一条都不发）", false),
          num("send_interval_min", "两码之间至少隔几分钟", 30, { min: 1, max: 240 }),
        ] },
      // [09-16 深夜·撞 id 修复] 这里原有一行 { id: "random_event", label: "随机事件", fields:[sw(enabled)] }：
      // 与上面 :142「小动物互动」共用同一个 id——defaultScriptConfig 后写覆盖前写，把真实模块的
      // max_events_per_cycle 默认值整个抹掉（面板那格空白、执行器靠 ?? 上限兜底），设置页两行还互相顶。
      // 它的 enabled 与真实模块是同一条路径（basic.random_event.enabled），删行零迁移、零读取方受损。
      // [W22 接线·09-18 ＋ 第132件全点接线·10-06] 猫庭自家养猫（客户 09-14 点名添粮与抚摸；
      // 10-06 用户令「把这个功能对接上……彻底把官方这个功能的所有点都做出来，并且做成可配置项」）。
      // **一格一事**（铁律 19 台账）：五把真写格各管一件——
      //   real_zoo_add_food 添粮 ／ real_zoo_stroke 抚摸 ／ auto_buy_food 买猫粮（金币）
      //   ／ auto_recall 接猫回家（只「主人回来」免费线） ／ auto_handle_event 处理事件（只免费档）。
      // 旧「本项不生效」的定性被 10-05 两路勘察推翻（定案逐字＝`memory/plan-1005-zoo-cat-full.md`）：
      //   · 买猫粮花的是**金币**（100/个、官方日限 30），不撞真钱红线 ⇒ 接；
      //   · 外出事件与找回**都有纯免费档** ⇒ 只接免费档；
      //   · 要花钱的档（赔花/赔钱/看大夫 3 元宝/普通走失 10 元宝/看视频免单）留在客户自己点，
      //     格面上把代价写清（铁律 8 第 3 条），**不做成可勾的假承诺**。
      // 全部 def=false（铁律 5 零例外）。抚摸的代价写在格上：摸完兴奋、当场外出三小时、那期间喂不了摸不了。
      { id: "zoo", label: "喂猫撸猫", desc: "管自家的猫：往盆里添粮、抚摸、猫粮自动买（花金币，可勾每天买满）、你太久没上线它出走时接它回家、走丢的猫看一段视频叫回来、在外面办的事替它认（不花东西的那种直接认，要赔的看视频免掉）。每件事各一把闸，全部默认关；卡头「开关」不打开，下面每一格都不动。", fields: [
        sw("enabled", "开关", false),
        sw("auto_handle_event", "自动处理外出事件（只认不花钱的那种）", false, { hint: "开＝猫在外面办的事，只有「不用花任何东西、认了就完」那一档才替它认（每次最多一条）。\n关＝一条都不替它认。\n要赔东西的那几单不归这一格——那是旁边「外出事件自动看视频免单」那格管的事。\n要元宝的那两行（看大夫、洗澡）永远不自动：那是号里的元宝，你没点名要脚本替你花。" }),
        sw("auto_handle_event_by_video", "外出事件自动看视频免单（要赔东西的那几单）", false, {
          hint: "开＝猫在外面闯的祸要赔东西时（赔偿鲜花两到五朵、或者逾期扣金币），脚本按官方那个「看视频」的按钮先发一条攒额度、再发一条把这一单免掉认了——一样东西都不出。\n关＝这一档一条不认，等你自己在游戏里点。\n代价说清：这用的是官方给这个号的看视频次数（一天上限很高），不是你的花、不是你的金币。\n「带它看大夫」「带它去洗澡」那两行官方要的是元宝（号里的钱），脚本不碰，也不拿它试视频能不能免。",
        }),
        sw("auto_recall", "自动召回（只接免费那条：接出走的猫回家）", false, { hint: "开＝你太久没上线、猫一气之下出走时，发一条请求把它接回家，不花任何东西。\n关＝不接。\n猫自己跑出去走丢的那种不归这一格——那是旁边「走丢的猫自动看视频叫回来」那格管的事。" }),
        sw("auto_recall_by_video", "走丢的猫自动看视频叫回来", false, {
          hint: "开＝猫是自己跑出去走丢的（不是太久没上线那种）时，按官方那条「看视频」的路：先发一条攒额度、再发一条把它叫回来，不花你的元宝、不扣你任何东西。\n关＝这种猫一条不发，屏上如实说它是走丢的、等你自己在游戏里点。\n代价先摆明：万一官方那一次不认这段视频，这一档会改吃十个元宝（号里的元宝）。脚本的自保是先看到服务器把这个号的视频次数记上了才发那一发；没看到就一条不发。\n不看视频、直接点「马上行动」那条路（明吃十个元宝）永远不自动。",
        }),
        sw("auto_buy_food", "自动购买猫粮（花金币）", false, { hint: "代价先摆明：猫粮一个 100 金币，官方一天最多买 30 个（一天最多花 3000 金币）。\n开＝什么时候买由旁边「每天把官方额度买满」那一格决定：不勾＝只在「盆还放得下、背包里猫粮又见底」时才买；勾上＝每天官方还剩多少额度就买多少。\n关＝一个金币都不为猫粮花。\n至于小鱼干、毛线球、猫薄荷这三样，要花的可是号里的元宝——不买。" }),
        // [第141件·用户当面点名「每天可以买30次猫粮，这个30次要自动买。不能等猫盆见底」]
        // 官方日限 30 是「个数」不是「次数」（源码 `PZooFoodPanel._buyDlg` 与真号 10-07 那两笔 29＋1 互证），
        // 买法二档各归各：不勾＝第132件那条「见底才买」原样留着（存量号零漂移），勾上＝每天买满额度。
        sw("buy_food_fill_daily", "每天把官方额度买满（不等猫盆见底）", false, {
          lockedWhen: "basic.zoo.auto_buy_food",
          hint: "开＝每天官方还能买几个就买几个（上限由官方那张表说话：现读一天 30 个＝最多 3000 金币），不看盆满不满、也不看背包里还有多少。\n关＝照老规矩：只有「盆还放得下、背包里猫粮又见底」时才补。\n买回来的粮盆里装不下就先放背包（猫粮没有过期这一说，官方那张表只写它能加饱腹）。\n怕花多了就在「买完猫粮，金币至少留多少」那一格填个数——那一格是这道闸的第二把尺，两个数不够就少买或不买。",
        }),
        sw("auto_buy_food_on_demand", "按需购买猫粮（本项不生效：和「自动购买猫粮」是同一件事）", false, { hint: "「自动购买猫粮」本来就是缺了才买（见它那格的说明），游戏里没有第二种买法，这一格留着只会让你多勾一个没用的开关。要「不等见底、每天买满」请勾旁边那一格「每天把官方额度买满」。" }),
        sw("auto_feed", "自动喂猫", false),
        sw("auto_stroke", "自动撸猫", false),
        sw("real_zoo_add_food", "自动往猫粮盆添粮", false, { hint: "开＝盆没满就把背包里的猫粮放进盆（一次最多添满盆，背包有多少放多少）。\n关＝不添。放的是你背包里的存货，不花金币。" }),
        sw("real_zoo_stroke", "自动抚摸猫咪", false, { hint: "开＝它心情低于下面设的数、又在家能摸时，摸一下。\n代价：摸完它会兴奋、当场跑出去玩三个小时，那期间喂不了也摸不了——所以脚本永远先把盆添够再摸。\n关＝不摸。" }),
        // 数值格：前两格出厂值与 09-18 上线时完全一致（零漂移）——
        // 85 就是官方表 $moodMax1（抚摸上限），0 就是「背包里不留底、能添多少添多少」。
        num("stroke_mood_floor", "心情低于这个数才去摸（官方上限 85）", 85, { min: 0, max: 100 }),
        num("keep_foodstuff", "背包里至少留几个猫粮不动", 0, { min: 0 }),
        // [第132件] 买粮专用：0＝不设线；填 N＝买完之后金币还得有 N（形状照第50件「保留元宝线」）。
        num("buy_food_gold_floor", "买完猫粮，金币至少留多少（0＝不设线）", 0, { min: 0 }),
      ]},
      // [W6 接线·09-18] 猫庭纪念品奖励（客户 09-14 18:46–18:48 点名猫庭）。**刻意另起一个模块**，
      // 不塞进上面那组「喂猫撸猫」：那一组七个开关（喂猫/买猫粮/撸猫/召回…）本期一个都没接写，
      // 把纪念品领取挂进它的 enabled 会变成「开喂猫＝顺带领纪念品」这种客户没点过的连带动作。
      // 两把闸都默认关（铁律 5 零例外）：总开关＝这件事的意愿，真实写闸＝真去点「领取」。
      // 代价写在卡面上（铁律 8 第 3 条）：领奖不可逆，一轮最多领一档，认不到服务器记账就整场停手。
      { id: "zoo_souvenir", label: "猫庭纪念品奖励", desc: "猫庭的纪念品集齐一档，就替你领那一档的奖励；每次最多领一档，领取不花任何东西。", fields: [
        sw("enabled", "开关", false),
        sw("real_zoo_souvenir_recv", "自动领取猫庭纪念品奖励", false),
      ]},
      // [W23·09-18] 猫庭院 2048（客户 09-14 18:48「猫猫庭院里面有三个小游戏。也要搞。有喵币」；二期第一件）。
      // **刻意另起一个模块**，与上面「喂猫撸猫」「纪念品」都不共用开关：开喂猫不等于替他玩游戏。
      // 三把闸全部 def=false（铁律 5 零例外）：总开关（愿不愿意玩）→ 意愿位 → 真实写位；
      // 只开意愿时只出计划、一条写都不发（执行器 `normalizeRealZooGame2048Config` 读的就是这两格）。
      // 代价写在卡面上（铁律 8 第 3 条），逐条都是真的：
      //   ① 玩一局要真发帧，一局几十手 ⇒ 手数与节奏由脚本自己压着（一轮一手、两次滑动之间留间隔）；
      //   ② 局内的道具（消除喵 1513 / 偷换喵 1514）与元宝档**一律不碰**，所以分数可能不高；
      //   ③ 「服务器会不会逐步核对每一步」到现在**没有证实**——所以第一版只按最小步子来，
      //      并且要有人在旁边看一整局、拿到服务器记账之后才谈放开。
      { id: "zoo_game_2048", label: "猫庭院2048", desc: "替你玩猫庭院里的「2048 小鱼干」：每一手都先读服务器发下来的棋盘再滑，每次最多一手、两次滑动之间留出间隔；局内的道具与元宝档一律不碰。本项默认关。", fields: [
        sw("enabled", "开关", false),
        sw("real_2048_write", "自动替玩 2048（每次最多滑一手）", false),
      ]},
      { id: "friend_accept", label: "好友通过", desc: "自动通过好友申请。带「暂不生效」的那几格（启动时全拒、好友数量上限、自动清理不活跃好友）本期还没接，填了不会有动作。", fields: [
        sw("enabled", "开关", false), sw("reject_all_on_startup", "启动时先拒绝全部申请（暂不生效）", false),
        num("max_friend_count", "好友数上限（暂不生效）", 200, { min: 0, max: 300 }),
        num("auto_delete_minutes", "自动清理等待（分钟）（暂不生效）", 0, { min: 0 }),
        num("auto_delete_inactive_days", "自动删除不活跃好友（天）（暂不生效）", 0, { min: 0 }),
      ]},
    ],
  },
  {
    id: "plant",
    label: "种植",
    modules: [
      // [2026-09-24 用户口径·培育选花模式改多选] 本模块这一批动了三格（原话见 `CULTIVATE_FOR_OPTIONS` 头注）：
      //   ① 新增 `cultivate_for`（多选，出厂＝前三项）：勾哪几类就只培育那几类要的花；勾「材料够就培」＝不看有没有人要；
      //      **一项都不勾＝一朵都不培育**（培育真扣四格材料，不勾就是不培）——代价写在字段说明上，客户自己定。
      //   ② `unlock_flower_ids`（允许自动解锁的花）**整格下架**：不精分到具体哪朵花，许可改由上面那份多选决定
      //      （在勾中的那几类来源里要的花才可能被自动解锁）。存量值一个字节不动。
      //   ③ `max_actions_per_cycle`（单轮最多发几条培育写）**整格下架**：代码里的那道上限一并删掉
      //      （铁律 16：页面上摸不到的那一格限制，代码里也不许留）。
      //   ④ `prefer`（旧下拉）被 `cultivate_for` 取代 ⇒ 下架留档（它已不再有任何读取方，留着就是假开关）。
      { id: "cultivate", label: "培育配置", desc: "自动执行培育相关流程。在「培育选花模式」里勾上你要的几类（订单要的／花艺要的／主线要的／公会竞赛要的），缺花时脚本就自动培育解锁；勾「材料够就培」＝不看有没有人要，材料够就培。⚠️ 一项都不勾＝一朵都不培育。", fields: [
        // [44D·2026-09-24 铁律 16 二期下的架] 「单轮最多发几条培育写」这一格按用户点名整格下架
        //   （存量值照旧留着、读数处不再读它）：培育候选现在**一轮里全部发完**，不再切片。
        num("max_actions_per_cycle", "单次最多发几条培育写（本项已下架：一次全部培育，不再按条数截）", 1, { min: 1, max: 20 }),
        sw("enabled", "开关", false), sw("auto_cultivate", "自动培育（以「真的开始培育」那一格为准）", false),
        multi("target_flower_ids", "指定培育花朵（暂不生效）", [], { source: "flowers" }),
        sw("auto_harvest", "自动收获", false), sw("auto_share_reward", "自动领取分享奖励（暂不生效）", false),
        // 〔第17件·续 2026-10-16〕这一格原来只挂着「视频加速（暂不生效）」，现在真接上了（出列理由见上面
        //   PARKED_FIELDS 那一段）。行名与说明按官方那一屏的实际形状写：**只对正在培育中的那一朵有效**，
        //   而且同一朵这一次培育只减一次（官方点完就把那一格标成不可再点）。
        sw("video_speed", "看视频减培育时间", false, {
          lockedWhen: "plant.cultivate.real_cultivate_start",
          hint: "什么时候自动用上这里：这一朵正在培育、而且还没到点的时候，替您点官方那个「看一段视频减一点时间」的按钮；一朵花的这一次培育只点一次，减了也不会连着减第二遍。"
            + "代价：这一发不扣花、不扣金币、不花元宝，只花掉一次「今天看过视频」的次数（次数上限由游戏自己的表给，现读 999 次，我们不另设次数）。"
            + "做没做成怎么知道：日志里按服务器改前、改后两个完成时刻报出「缩短了多少秒」；服务器没改口就照实说没改成，这一朵这一场不再重复点。"
            + "不勾＝培育该多久就多久，一切照旧。",
        }),
        sw("yuanbao_speedup", "元宝加速（暂不生效）", false),
        // [第50件追加·2026-09-26 用户实屏拍板] 这一格原写「元宝购买材料（暂不生效）」——现在真生效：
        //   培育缺料时去元宝直购通道把缺的料买齐（判据＝服务器在架 consume；实帧抓包 shop.buy）。
        //   代价＝每笔的元宝数以**在架显示价**为准（写前现读、留痕），受下面「保留元宝线」与余额闸约束。
        //   ⚠️ 上一版还要客户另开「礼包与材料商店 → 元宝直购」（四格串联）——按用户口径收掉：
        //     这一格本身就是这条通道的开关，卡头上那把「自动执行」（＝真的开始培育）是它的前置。
        //   默认关（元宝是充值来的货币，铁律 5）。
        sw("yuanbao_buy_material", "培育缺料时用元宝补齐（花的是充值元宝，单价以游戏内显示的为准）", false),
        // [第51件] 元宝直接完成培育（清培育冷却）：官方客户端那颗按钮的做事方式——
        //   `gs.cultivate.clearCulCd {flowerId}`，价由客户端公式算 `max(ceil(剩余秒/360),1)` 元宝
        //   （源码逐字；按钮只在「培育中」那一刻出现，点之前只查元宝够不够）。
        //   代价＝真钱（充值来的元宝）＋花完不能低于同卡的「保留元宝线」。默认关（铁律 5）。
        sw("yuanbao_finish_cultivate", "到点前用元宝直接完成培育（按剩余时间扣元宝，每 6 分钟 1 个、不足 6 分钟也算 1 个）", false),
        // [第50件追加] 保留元宝线：与开关同卡（用户口径「只需要增加开关，和保留线即可」）。
        //   0＝不设线（买得起就买）；判据在 direct-buy-cycle.js 的 planDirectBuy（低于线一笔都不花）。
        num("yuanbao_retain", "保留元宝线", 0, { min: 0, hint: "元宝余额低于这条线就一笔都不花。填 0＝不设保留线（只要买得起就买）。" }),
        multi("yuanbao_target_flower_ids", "元宝加速指定花朵（暂不生效）", [], { source: "flowers" }),
        num("yuanbao_limit", "元宝上限（暂不生效）", 500, { min: 0 }),
        sw("flower_upgrade", "自动升级鲜花", false),
        // max＝官方真值（2026-09-30 用户报「卡在 10 存不上」后订正）：`c_flowerLvl` 元行现读 `$lvlMax=20`，
        // 成长表也只有 20 行（flower-lvl.js 的结构判据：$lvlMax 超过成长表级数＝误用 raw）。
        // 旧的 max:10 没有官方出处，属铁律 16 要拆的自设限制；执行器的硬顶本来就是官方 $lvlMax，这格只是输入护栏。
        num("target_level", "目标等级", 5, { min: 1, max: 20 }),
        // 以下四项只在真实模式生效，默认全关：培育会真扣四格材料、升级会吃掉本花精华，都不可逆。
        sw("real_cultivate_start", "自动培育新花", false),
        sw("real_cultivate_recv", "自动领取培育结果", false),
        sw("real_cultivate_upgrade", "自动升级鲜花", false),
        // [2026-09-22 第 17 件 B → 2026-09-24 整格下架] 「允许自动解锁的花」：本批起**不再精分到具体哪朵花**，
        //   自动解锁的许可改由上面的「培育选花模式」决定（勾中的那几类来源里要的花才可能被自动解锁）。
        //   存量账号里这一列的值照旧留着、没有任何人再读它 ⇒ 进 `PARKED_FIELDS` 下架留档（只摘渲染）。
        multi("unlock_flower_ids", "允许自动解锁的花（本项已下架：解锁许可改由「培育选花模式」决定）", [], { source: "flowers" }),
        // [2026-09-24 用户口径] 选花模式从下拉改成多选：四个选项与语义的唯一出处＝`CULTIVATE_FOR_OPTIONS`。
        // ⚠️ 代价那句写在**标签的括号里**（行上就看得到，与 `custom_plant_flowers` 那条「一朵都不选＝一朵都不种」同一形状）——
        //    `desc` 进的是行上的「?」弹层，代价不许只藏在弹层里（铁律 8 第 3/4 条）。
        multi("cultivate_for", "培育选花模式（可多选；一项都不勾＝一朵都不培育）", [...CULTIVATE_FOR_DEFAULT], {
          source: "cultivate_sources",
          desc: "勾哪几类，就只培育那几类要的花（「订单要的」「花艺要的」「主线要的」都勾上＝只培育有人要的花）。"
            + "勾「材料够就培」＝不看有没有人要，材料够就培育（勾了它，前面三项就不起作用）。"
            + "⚠️ 四项都不勾＝一朵都不培育（培育会花掉四格材料，所以不勾就是不培）。",
        }),
        sel("prefer", "培育选花模式（旧的下拉，本项已下架）", "demand", [
          // 2026-09-21：需求侧多了「本环主线要培育的那一朵」（官方 c_task_main type 3005），
          // 标签跟着说全——不勾这一档就是「材料够就培」，勾了才只培有人要的那几朵。
          { label: "只培订单/花艺/主线要的", value: "demand" },
          { label: "材料够就培", value: "any" },
        ]),
      ]},
      { id: "water_drops", label: "水桶补给", desc: "自动领取水车水桶与限时水滴（都是白拿的水滴，不花任何东西）。", fields: [
        sw("enabled", "开关", false),
        // 〔第158件·2026-10-10 用户定稿〕领水这一族在客户面上就是**两把按钮**：「领水车水桶」与「领限时水滴」，
        //   两张卡并成一张「领水」。原来那两把细闸（广告桶／过点补领）整格下架、各自并进本行这把按钮
        //   （下架账与手续逐字见本文件 `PARKED_FIELDS` 第158件段）。代价照铁律 8 第 3 条写进「?」。
        sw("real_water_bucket_recv", "领水车水桶", false, {
          hint: "一桶一桶接着领：上一桶服务器认了账，才发下一桶，每天最多 60 桶。\n"
            + "〔第158件·用户定稿〕每桶之间固定隔 30 秒，不给设置（用户原话「间隔默认就是代码里面写死30秒，"
            + "不能让客户自己去设置了」）＝从第一桶到领满 59 桶要约半小时；这一串只拖时间，"
            + "不多领也不少领：当天能领几桶仍由服务器那本账说话，领满就停，明天接着。\n"
            + "〔第158件起〕撞上广告桶时按官方「看视频」那一发一起去领（每桶另给 30 滴、每天最多 6 次）——"
            + "用户定稿「默认看广告」，所以这一档不再有单独的勾。\n"
            + "⚠️ 代价两条：① 这一发在服务器账上记成「某广告位完成」，程序并不真的播放广告；"
            + "② 合并之后没有「只领普通桶、不碰广告桶」这一档，要躲开那一发只能把这一项整个关掉。\n"
            + "只认服务器把当天桶数记成 +1 才算领到；没带回话就停手，绝不重发。",
        }),
        // [第120件·2026-10-04 用户点名接广告档] 〔第158件·10-10 整格下架〕这一格并进上面那把按钮：
        //   定义与存量值留着（不写库），运行期**零读取方**——判据见 `water-supply-cycle.js` 归一化那一段。
        //   官方形状留着备查：撞广告桶时发**一发** `gs.usr.share{shareId: c_waterwheel.$bucketShareId(表现读 9), ext:{opType:1}}`
        //   （common 字节 1518368 `PWaterWheelAdDlg._tap_btn_ad` 逐字；回调里**没有**第二次 `waterwheel.recv`、也没有 `skip`）。
        sw("real_water_bucket_ad", "广告桶看视频领（本项已并进上面「领水车水桶」，这一格不再单独生效）", false),
        // 〔第154件·P2-4 曾在这里加过一格「每桶之间至少隔多少秒」；**第158件·10-10 23:3x 用户令整格撤掉**〕
        //   原话：「不要给设置功能啊，间隔默认就是代码里面写死30秒，不能让客户自己去设置了」。
        //   ⇒ 领桶那一圈固定隔 30 秒，常量与判据在 `water-supply-cycle.js`（`BUCKET_GAP_MS`），**这一格不在本 schema 里、
        //   以后也不许加回来**：守卫 `tests/water-supply-cycle.mjs` 那条接线自证已从"页面上摸不到的限制不许存在"
        //   （铁律 16，第154件立它时用的正是这句）翻成**反向钉**——schema 里再出现这一格＝当场红。
        //   ⚠️ 这一族为什么慢 30 分钟才领得满，写在上面「领水车水桶」那把按钮的「?」里（约束要提前说，铁律 8 第 4 条）。
        sw("real_free_water_recv", "领限时水滴", false, {
          hint: "中午 11 点到 14 点、傍晚 17 点到 21 点各一份，开放的时间里是白拿的一发（不花号里任何东西）。\n"
            + "〔第158件起〕过了点的那一份也一起补——官方过点只留「看视频补领」这一条路（每天最多 3 次），"
            + "用户定稿「开启之后就是默认过点领取」，所以这一档不再有单独的勾。\n"
            + "⚠️ 代价：补领那一发在服务器账上记成「某广告位完成」，程序并不真的播放广告；"
            + "合并之后没有「只领开放时间里那一份、不补过点那一份」这一档，要躲开它只能把这一项整个关掉。\n"
            + "只认服务器把已领档位随回包带回来才算收；没带回话就停手，绝不重发。",
        }),
        // [第120件·2026-10-04 用户点名接补领档] 〔第158件·10-10 整格下架〕并进上面那把按钮：定义与存量值留着、运行期零读取方。
        //   官方形状留着备查：`_receiveWater(true)`＝`UT.share(13,{opType:1,id:recvIdx})`（common 字节 1568242／1568358 逐字），
        //   每天最多 `c_share#13.limit` 次（现读 3）。过点后官方只能靠这一条补领。
        sw("real_free_water_fallback", "过点后自动补领（本项已并进上面「领限时水滴」，这一格不再单独生效）", false),

        sel("water_bucket_mode", "领取模式", "normal", [
          { label: "普通领取", value: "normal" }, { label: "兜底领取", value: "fallback" },
        ]),
        time("water_bucket_fallback_time", "兜底领取时间", "22:00"),
        sw("free_water", "限时水滴", false),
        num("free_water_threshold", "水滴少于多少就领", 0, { min: 0 }),
        num("water_bucket_threshold", "水桶少于多少就补", 0, { min: 0 }),
      ]},
      // [09-28 用户点名「只保留种植模式和是否启用开关」] 这一句原来结尾指着「每分钟种几块」那一格，
      //   那一格本批已下架留档 ⇒ 指针同批摘净（说明里不能指着一格客户屏上根本没有的东西，铁律 8 第 4 条）。
      { id: "land_plant", label: "种花配置", desc: "自动种植、收获和补地。官方是一块一块地发的，脚本也按空地一块块补；先种哪一朵由下面「种植模式」那一格决定。", fields: [
        sw("enabled", "开关", false), sw("unlock_land", "解锁土地", false),
        // 2026-09-22：这一格是**花金币且不可逆**的真实写（开完那块地退不回来），而客户屏上原先
        // 只有「（真的会动手）」——代价那句本来只写在卡的 `detail` 里，而 `detail` 在客户面**根本不上屏**
        // （全站 57 条 detail 一条都没渲染，属另一处欠账，已记档）。按铁律 8 第 3 条「有代价必须摆明」，
        // 把代价并进这一格的名字里（客户层会把括号那截降成第二行小字，一个字不丢）。
        sw("real_land_unlock", "自动解锁土地（要花金币、开完退不回来，每次只开一块）", false),
        // [09-24 用户点名] 保留金币：解锁之后剩下的钱必须不低于这个数，否则一块都不开。
        // 0＝不限（＝出厂零漂移，出厂行为与从前逐字一致）。判据在 `land-unlock-cycle.js`：
        // `gold − 这块地的价钱 < 保留数` ⇒ 不发写，并在播报里把这笔账念出来（铁律 13）。
        num("unlock_keep_gold", "解锁后至少留这么多金币（留不够就不开；0＝不限）", 0, { min: 0 }),
        sw("auto_harvest", "自动收获", false),
        num("harvest_delay_minutes", "延迟收花", 0, { min: 0, max: 720, suffix: "分钟" }),
        // 〔第146件 M4·用户 10-08 定稿→第206件·用户 10-16 裁决退场〕这一格当年是"开着才等齐"的开关；
        //   第206件按用户裁决把等齐做成**固定流程**（同一分组每茬全部成熟并满足收花延迟后统一收获），
        //   独立按钮取消——**渲染与运行期同批退场**（登记见 `PARKED_FIELDS` 第206件段）。
        //   按仓规定义与出厂值（false）留着、不写库（存量键有家）；屏上指向这一格的句子同批改口，不许留假话。
        sw("harvest_wait_all", "等齐再收（同一种花全熟才一起收；熟得早的要多等一会儿）", false),
        sw("auto_water", "自动浇水", false),
        sw("auto_plant", "自动种植", false),
        // 〔第17件·续 2026-10-16〕这一格**仍然没有读取方**（留在 PARKED_FIELDS 里，名字也照旧写「暂不生效」）：
        //   官方那一发（`usr.share` shareId 3「养花视频加速」）在反解源码里成功分支只做了关灵动岛通知＋刷新一屏
        //   （`common@1194835`），既没有 land 写、`c_share` 行 3 也没有 `award` ⇒ 客户端证明不了服务器改了地块状态，
        //   按「读不到就不做」这条尺，本仓不发这一发（取证与判据见当月工作日志第17件·续条）。
        //   ⚠️ 台账一处必须说明：`tests/config-reader-guard.mjs` 那把尺按**叶子键名**匹配，而它与培育那张卡的
        //   `plant.cultivate.video_speed`（本批刚接上真读者）同名 ⇒ 扫描会把培育那处的读取算到这一格头上。
        //   因此这一格已从「零读取方」账本里摘出（挂着就成了谎话），真实状态以这一段注释为准：**零读取方**。
        sw("video_speed", "视频加速（暂不生效）", false),
        // [09-18 接线·客户 17:42「加速卡……免费加速」那一条的配套] 这一格原来是「视频加速等待时间」
        // （`free_speedup_threshold`，全仓零引用、名字还误导人：它跟看广告没关系）。现在换成
        // **免费加速的触发窗口**：某块地剩余成熟时间 ≤ 这个秒数，才去点那个不花任何东西的免费催熟按钮。
        // 上限 60 秒＝官方 c_gameCfg.$freeSpeedUp（表实读，超过官方也不会出现按钮）；填 0＝干脆不用；
        // 默认 60＝现状零漂移。
        // ⚠️ 换了个新键名而不是沿用旧键：老账号存档里烘着 `free_speedup_threshold: 30`（旧单位是**分钟**、
        // 而且从来没被读过），沿用旧键会让它突然变成「30 秒」，那是没人要求过的行为变化。
        // [09-24 用户实屏第五问] 这一族的四个"旋钮"按用户口径收掉，只留「保留张数」：
        //   · 「免费加速触发窗口」——用户原话「直接默认就是 55-60 秒内，随机直接触发」⇒ 不再让客户填，
        //     固定成**每轮随机取 [55,60] 秒**（官方免费档只在剩余 ≤60 秒时给按钮，够不着 60 秒以外）；
        //   · 「使用加速卡」（意愿）——与下面那格「使用加速卡催熟（真实写）」**是同一件事**（用户点名重复），
        //     合并成一格：`real_land_speedup` 自己说了算；
        //   · 「加速卡等待时间」——它的真实语义是**别浪费卡**（剩不到这么多分钟就熟的地等它自然熟），
        //     用户问"这有什么用" ⇒ 按固定行为写进卡面（20 分钟），不再让客户填；
        //   · 「加速上限」——一轮最多烧几张，同样固定（5 张）并写进卡面。
        //   四格一律 **只摘渲染**（进 PARKED_FIELDS，定义与存量值不动），读数处一律回到出厂默认 ⇒ 行为零漂移。
        num("free_speedup_window_sec", "免费加速触发时长（已下线：固定 55-60 秒随机触发）", 60, { min: 0, max: 60, suffix: "秒" }),
        // [09-25 用户实屏「加速卡这里还是不对」·从下架名单放回来，但换了身份]
        // 这一格现在**不是**「与真实写重复的意愿格」，而是这一张卡（催熟/加速卡）的**总闸**：
        //   ① 客户面上它就是卡头那把「这一项现在能不能替你动手」——开着，下面那两格才给勾；
        //      关着，下面两格灰显、点不动，并写明「先打开上面那把开关」。
        //   ② 它是 `ACTION_GATES` 两条链的**第一环**（烧卡那条与免费那条各挂一次），
        //      归一化里两发写的判据都要求它 `=== true`（`real-land-cycle.js`）——**真判据，不是摆设**。
        //   ③ 它自己**不进** `moduleGateLive`（土地这五段共用的派生总闸）：混进去会让「关掉加速」
        //      连带把收花／浇水／补种／解锁一起关掉，那不是用户要的。
        // 铁律 5 一字不动：`def=false`，出厂一律关；存量核对（09-25 本机 `garden.db` 现读）：
        // `#11`（模拟演示）／`#16`／`#19` 三行的 `use_speed_card` 全 `false`，下面两格真实写也全 `false`
        // ⇒ 本批（放回这一格 + 两格互斥）**不改变任何号的现状**。
        sw("use_speed_card", "总开关（打开后下面才能勾选）", false),
        num("speed_card_threshold", "加速卡等待时间（已下线：固定「剩不到 20 分钟就熟的不烧卡」）", 20, { min: 0, max: 600, suffix: "分钟" }),
        num("speed_limit", "加速上限（已下线：固定一次最多 5 块）", 5, { min: 0, max: 50 }),
        // [B7 卡保留上限·09-15 客户需求（用多少留多少）] 默认 0＝现状零漂移：可动用卡数＝背包实数−保留数。
        // 用户点名要留下的那一格（「只留下加速卡保留张数不就行了」）：可动卡数＝背包实数−保留数。
        // ⚠️ 固定行为的两个数写在这里（页面上没有它们的旋钮了，就在这一格的说明里说清）：
        //   剩不到 20 分钟就熟的地等它自然熟、不烧卡；一轮最多催熟 5 块。
        // [2026-09-30 用户报「别人都好几万的加速卡，怎么最高只能 5000」] 去掉 max:5000——
        //   官方 `c_item` 6293 行全字段无道具堆叠上限，反解源码 4 处 maxCount 均是别的模块（合成订单/音频引用计数）；
        //   5000 与前一族「10／9」同病＝护栏没有出处（铁律 16：删，不是调大）。
        //   无上限天然安全：保留数大于背包实数＝一张都不烧（可动卡数=max(0, 实数−保留)，见 real-land-cycle）。
        num("speed_card_keep", "加速卡保留张数（这部分永远不动；其余一次最多催熟 5 块、剩不到 20 分钟就熟的不烧）", 0, { min: 0 }),
        // 铁律 5：真实写一律 def=false；总闸（上面那格）也开了才发那一发。
        // [09-25 用户原话] 「用加速卡催熟控制的是用加速卡催熟，也就是地块种完，浇完水之后，等待成熟的时候，
        //   直接就用加速卡完成催熟」——标签按这句改准，代价（一块吃一张卡、退不回来）照旧摆在行上。
        // `lockedWhen`＝总闸关着时这一行灰显、点不动（判据层算、渲染层只读，见 hosting-model.js）。
        // `exclusiveWith`＝与「免费加速」互斥，只能开一个（服务端保存那条路同批挡，见 api-user.js 的
        //   `/settings` 与 capabilities.js 的 `clearExclusiveRival`）。
        sw("real_land_speedup", "用加速卡催熟（地块种完、浇完水之后等成熟的那些地，直接用一张加速卡催熟；一块吃一张卡、退不回来）", false,
          { lockedWhen: "plant.land_plant.use_speed_card", exclusiveWith: "plant.land_plant.real_land_speedfree", exclusiveNote: SPEEDUP_EXCLUSIVE_NOTE }),
        // [B6 免费加速·09-15 客户清单快赢批] 官方免费催熟档：剩余 ≤ c_gameCfg.$freeSpeedUp（表实读 60 秒）的地块，
        // 官方有个不花任何东西的按钮（反解 common@1193609 refBtn 与 scripts@1187516 speedUpFree 双证）。
        // 这条同样 def=false，且**不进 DEFAULT_ON_EXCEPTIONS**（铁律 5 零例外）。
        // [09-25 用户原话] 「应该是即将成熟的地块，在时间剩余 55-60 秒时随机使用官方免费催熟，不花任何东西」
        // ——标签按这句改准（此前写「剩 55-60 秒就熟的地」，把「即将成熟的地块」这一层意思丢了）。
        // 互斥与总闸同上一格：两件只能开一个（开了加速卡，地块根本轮不到免费档那个窗口）。
        sw("real_land_speedfree", "免费加速（即将成熟的地块，在时间剩余 55-60 秒时随机使用官方免费催熟，不花任何东西）", false,
          { lockedWhen: "plant.land_plant.use_speed_card", exclusiveWith: "plant.land_plant.real_land_speedup", exclusiveNote: SPEEDUP_EXCLUSIVE_NOTE }),
        num("keep_water", "保留水滴", 0, { min: 0 }),
        // 〔第146件 M3·2026-10-09 用户定稿（`memory/plan-1008-plant-card-redesign.md` v3）〕
        // 「任务优先」随需求驱动整体退场（用户原话「种植就不依赖于任何任务了，因为你一直在补库存，
        //   自然而然的其他的所有需要用到花的地方就不缺了」）⇒ 读取方删净、渲染退场，进 `PARKED_FIELDS`
        //   （09-24 段在册）；按 parked 规矩**定义与出厂值一字不动**（`parked-fields-value` 钉这条）。
        sw("task_priority", "任务优先", false),
        // 〔第146件 M3〕种植模式四档，全部**统一按实时库存最低起排**（用户原话「三种种植模式，都默认按照
        //   库存最少开始种吧」）；各档只差"候选池"：全部能种的／指定的几样／选中的品质／游戏里置顶的那几样。
        // 「需求优先」整档退场（上档 09-28 定的出厂值 task 作废）；老存档里的 "task"/"least_stock"/"specific"
        //   运行期统一落到 least_stock（归一化唯一出处 `real-land-cycle.js`，零迁移）。
        sel("plant_mode", "种植模式", "least_stock", [
          { label: "库存最少", value: "least_stock" },
          { label: "指定花朵", value: "chosen_flowers" },
          { label: "指定品质", value: "chosen_quality" },
          { label: "置顶花朵", value: "chosen_top" },
        ], {
          // 判据与四档语义（真实行为，铁律 8：不写做不到的承诺）——每档都"从库存最低的开始种、腾空时重新比"，
          // 差别只在"谁能参与"；置顶档名单在游戏里设置、这里直接读过来，没有名单框。
          desc: "四档都按手里剩下多少枝排、最少的那种先种（出厂默认＝库存最少）；腾出来的空地归谁，收出来那一刻现比。"
            + "区别只在能种谁：库存最少＝所有培育好的花；指定花朵/指定品质＝只圈选中的那几样/那个品质；"
            + "置顶花朵＝用你在游戏里置顶的那几样（这边没勾没选）。切了模式，别的档里存着的名单和品质一律不算数（互不掺和）。"
            + "这一格不管种几块：一种花占几块地看下面「种植分组」；补到什么枝数就留白不种，看「种植数量」。",
        }),
        // 〔第146件 M3〕指定花朵：仅模式＝指定花朵时生效。**模式隔离已由归一化层强制**
        //   （`real-land-cycle.js` 的 `normalizeRealLandConfig`：非当前模式的名单丢成空数组，planner 物理拿不到）——
        //   这正是用户 10-08 原话要的「切换了模式，不管选没选中，都不能种」。
        // 〔第146件 M8·2026-10-09 用户当面点名「选择框只有种植模式选择对应的时候才能点击，不然就要禁用掉按钮」〕
        //   ⇒ 界面上加**第五道锁＝等值门**（`lockedUnlessEquals`）：门格不等于声明的那一档 ⇒ 这一行灰显、
        //   「选择」按钮点不动，并把「要切到哪一格哪一档」写在行上（名字两侧都从这份 meta 现取，不许手抄）。
        //   ⚠️ 做的是**禁用、不是隐藏**（用户原话"禁用掉按钮"）：客户要能看见自己存过的名单还在
        //   （铁律 19 P4「不许靠藏/改写客户存过的值来实现」），也要看得见为什么点不动（铁律 8 第 4 条）。
        //   与 `lockedWhen` 同档：**只管界面能不能点**——单格保存那条路今天不吃任何行级锁（那口径本批不扩权）。
        multi("plant_chosen_flowers", "指定花朵", [], {
          source: "flowers",
          lockedUnlessEquals: { key: "plant.land_plant.plant_mode", value: "chosen_flowers" },
          hint: "只种这几样（只在「种植模式＝指定花朵」时生效，切走就不算数）：谁手里枝数最少谁先补，设了「种植数量」就挨个补到不低于它。",
        }),
        // 〔第146件 M3〕指定品质：品质多选（1~5），候选池＝解锁且品质在选中档的花，其余与指定花朵逐字相同。
        // 〔第146件 M8〕等值门同上：只有「种植模式＝指定品质」时这把选择框才点得动。
        multi("plant_chosen_quality", "指定品质", [], {
          source: "qualities",
          lockedUnlessEquals: { key: "plant.land_plant.plant_mode", value: "chosen_quality" },
          hint: "只种选中品质的花（品质从低到高五档：凡品／普品／珍品／华品／仙品；只在「种植模式＝指定品质」时生效，切走就不算数）：其余跟「指定花朵」一样，枝数最少的先补。",
        }),
        // 〔第146件 M3·原「多少块地种一种花」（第80/91/137件）精简为「种植分组」〕
        // 下拉五值 4/8/16/32/64（去掉 0＝不限：分组是"地里整齐"的地基，所有模式都依赖它——用户原话
        //   「后面所有的种植模式都要依赖于这个」）；存量 8/64 原值保留，0 运行期归到出厂 8（零迁移，归一化兜）。
        // 语义（v3）：一片＝这个块数、一片只种一种花、一种一片；腾出来的空地照库存最低补满这片，
        //   这片满了/这朵够数了才轮到下一片。
        sel("plots_per_flower", "种植分组", 8, [
          { label: "4 块", value: 4 },
          { label: "8 块", value: 8 },
          { label: "16 块", value: 16 },
          { label: "32 块", value: 32 },
          { label: "64 块", value: 64 },
        ], {
          hint: "一种花占这么多块地（一片），一片里只种一种；64 块地 ÷ 这个数＝地里同时摆几种。"
            + "地里正长的换不掉（游戏没有铲除），改这个数从下一批腾空的空地生效。",
        }),
        // 〔第146件 M3·白名单退场（用户原话「白名单就不要了，直接删除」）〕
        // 第92件那格整格下架：功能被「指定花朵」档整档覆盖，两格并存会打架。现读 7 个真实号全是空名单＝零影响。
        // ——原 sw/multi("plant_whitelist", …) 已删行，依据逐字见 `PARKED_FIELDS` 10-09 段。
        // 〔第92件→146件·黑名单保留〕
        // ——「白名单」定义按 parked 规矩留在原处、一字不动（渲染与运行期读取随本批删净；理由与用户原话逐字见 `PARKED_FIELDS` 10-09 段）。
        multi("plant_whitelist", "白名单", [], {
          source: "flowers",
          hint: "这几样花的种植优先级最高：先把订单、任务缺的花补够，之后腾出来的空地只种白名单里的花"
            + "（白名单内部按手里剩下多少枝排，最少的那种先种，等级高的不插队），一直种到你设的「多少块地种一种花」占满为止。"
            + "留空＝不启用（默认，跟从前一样按种植模式铺）。"
            + "⚠️ 代价：白名单里那几种花全部占满之后，剩下的空地这次不种，要等这批地收出来才继续排——"
            + "白名单选得太窄，地就会一直空着。",
        }),
        multi("plant_blacklist", "黑名单", [], {
          source: "flowers",
          hint: "这几样花永远不参与种植，订单、任务在等它也不种。"
            + "⚠️ 代价：被拉黑的花如果正是某张单要的花，那一单就一直交不上——日志会点名是哪一朵、哪一单在等它，不会闷声丢单。",
        }),
        sw("grouped_plant_enabled", "规整种植（只在预演里生效）", false),
        // [09-18 改口·客户 17:42「种植数量」那一条] 这一格就是「一轮最多种几块」：填 0＝不限（跟着我们自己的
        // 拟人上限走）；真发的时候一轮最多 6 块（LIVE_PLANT_ACTIONS_PER_CYCLE），所以填大了也只到 6。
        num("plant_group_size", "每分钟种几块（0＝不限）", 0, { min: 0, max: 36, suffix: "块" }),
        rng("flower_level", "花朵等级范围", 1, 5),
        // 〔第146件 M3·「特需定制」三格 09-28 已裁决退场，`PARKED_FIELDS` 在册〕定义与出厂值按 parked 规矩一字不动，
        //   渲染由 `field.parked` 旗摘掉；「指定花朵」的名单格是新键 `plant_chosen_flowers`，不继承旧键（旧键三号现读皆空，零迁移）。
        sw("custom_plant_enabled", "特需定制（勾上＝连地一起限定：只在这几块地上种这几种花）", false),
        multi("custom_plant_lands", "定制土地（只在这几块地上补种；一块都不选＝这次一块都不种）", [],
          { source: "lands" }),
        multi("custom_plant_flowers", "定制花朵（只种这几种花；「指定花朵」模式与「特需定制」都用它，一朵都不选＝一朵都不种）", [], { source: "flowers" }),
        // 〔第146件 M3·「种植数量」出列转正〕这格 09-18 起就挂着「暂不生效」——本批接上真读者
        //   （`real-land-cycle.js` 的归一化与分配器），语义按用户 v3 定稿逐字：
        //   「如果设置了数量，种到不低于指定的数量之后就不种了」＋「没设置的也要一直种」。
        //   只对"指定花朵/指定品质/置顶花朵"三档生效（§0 第 5 条确认）；0＝不设＝没刹车。
        num("restock_count", "种植数量（0＝不设）", 0, {
          min: 0,
          hint: "设了＝只补手里低于这个枝数的，全补到位后空地留白不种；不设＝没刹车，一直种。",
        }),
        // top_restock_count：09-18 与「每分钟种几块」重复那一族，维持下架（`PARKED_FIELDS` 在册）。
      ]},
      { id: "friend_steal", label: "好友偷花", desc: "按配置自动偷取好友花朵。", fields: [
        sw("enabled", "开关", false),
        // [W21·09-18] 真实写闸（**本批新增**，def=false，铁律 5 零例外）：摘的是**别人地里的花**、
        // 发出去收不回来，所以除了上面那把意愿总开关，还要单独准许一次才会真的发。
        // 缺它＝只出计划，一朵都不摘。⚠️ 摘好友花灵（另一个动作号 `steal-elves`）**本批不登记**：
        // 它与摘花共用同一个接口、只差一个参数（1=摘花灵），等摘花这条实服验证过再谈。
        sw("real_steal_write", "自动摘好友的花（摘的是别人地里的花，摘了收不回来）", false),
        multi("target_steal_friend_names", "目标好友（暂不生效：游戏只给好友编号，没有昵称这一栏可填）", []),
        multi("exclude_steal_friend_names", "排除好友（暂不生效：同上，没有昵称可填）", []),
        sel("mode", "偷取模式（只影响挑哪几块地，不影响游戏规则）", "quality", [
          { label: "指定品质", value: "quality" }, { label: "指定花朵", value: "flower" },
          { label: "排除花朵", value: "exclude" },
        ]),
        multi("target_qualities", "目标品质（本项当前不生效：只影响挑哪几块地，还没接）", [], { source: "qualities" }),
        multi("target_flower_ids", "目标花朵（只影响挑哪几块地）", [], { source: "flowers" }),
        multi("exclude_flower_ids", "排除花朵（只影响挑哪几块地）", [], { source: "flowers" }),
        sw("buy_attempts", "次数不够时买次数（暂不生效：本期不接这条写）", false),
        num("buy_count", "购买次数（暂不生效）", 0, { min: 0, max: 10 }),
        time("forbidden_start", "避开时段·开始（暂不生效：官方没有分时段规则）", ""),
        time("forbidden_end", "避开时段·结束（暂不生效：官方没有分时段规则）", ""),
        sw("use_remaining_at_night", "夜间用剩余次数（暂不生效：次数每天 0 点清零，留不到明天）", false),
        // [W21 改口·09-18] 下面三格按判定书 §5 改口：名词错位/语义反了/官方没有这条规则。
        // 只动 label（客户读到的那一行），**键名一个字节都不动**（存量存档与读取方账本都按键名走），
        // 也**不动默认值**（仍是 false，铁律 5 零例外）。
        //   steal_elves：官方的第三格参数是「顺手摘走好友地里的花灵」（我摘走别人的），
        //     与「协助好友花灵」是两件事；替好友按协助按钮（动别人账号）本项目永远不做。
        sw("steal_elves", "顺手摘走好友地里的花灵（本项当前不生效：摘花灵还没接线）", false),
        multi("steal_elf_ids", "指定花灵（本项当前不生效：摘花灵按概率掉落，挑不了具体哪一只）", [], { source: "elves" }),
        multi("target_elf_friend_names", "花灵目标好友（本项当前不生效：同上）", []),
        multi("exclude_elf_friend_names", "花灵排除好友（本项当前不生效：同上）", []),
        sw("avoid_elf_land", "（本项不生效）有花灵的地只能摘花灵、摘不了花——这是游戏规则，不是开关", false),
        sw("disable_normal_steal_until_elves_full", "（本项不生效）摘花灵与摘花各算各的次数，游戏里没有互相让路这回事", false),
      ]},
      // [W7 接线·09-18] 客户 09-14 18:25–18:26 三条点名花灵。这一组开关早就在（上面那批），
      // 本批只**加一把真实写闸**并回填每一条的落点，绝不改任何一个默认值（铁律 5 零例外）：
      //   `enabled`                     → 这件事的意愿
      //   `real_flower_elves_write`     → 真去操作（**本次新增**，四条写共用这一把，缺它则四条全是计划）
      //   `auto_dispatch`               → 派遣花灵（客户原话「自动派遣花灵开关」）
      //   `auto_recv_dispatch_reward`   → 收花灵币（客户原话「自动收取派遣完的花灵币开关」）
      //   `auto_request_assist`         → 自家侧申请协助（客户原话「协助自动申请开关」）
      //   `auto_recv_assist`            → 自家侧领取协助
      // 代价写在卡面上（铁律 8 第 3 条）：派遣会把背包里的花灵放进派遣位（干完活连本带利回来），
      // 认不到服务器回带就整场停手；「自动种植花灵」这一件本期没接（判据没钉到，见花灵执行器的不做清单）。
      // ⚠️ `auto_assist_friend`（自动协助好友）**永远不驱动任何写**：它对应的官方方法会把效果落在
      //    **好友的账号**上（唯一调用点传的是好友列表那一格的 uid），一期明确不做，开关留着只是照原样保留。
      { id: "flower_elves", label: "花灵", desc: "自动派遣花灵、收取奖励、请求与领取好友协助（替好友按的那一下不做——那是动别人账号的事）。", fields: [
        sw("enabled", "开关", false), sw("auto_plant_elf", "自动种植花灵", false),
        multi("selected_elves_id", "指定花灵（暂不生效）", [], { source: "elves" }),
        num("elves_main_count", "主花灵数量（暂不生效）", 1, { min: 1, max: 6 }),
        num("harvest_delay_minutes", "延迟收取", 0, { min: 0, max: 720, suffix: "分钟" }),
        time("plant_time_start", "执行时间段（开始）（暂不生效）", ""),
        time("plant_time_end", "执行时间段（结束）（暂不生效）", ""),
        sw("auto_unlock_place", "自动解锁位置", false),
        sw("auto_upgrade_book", "自动升级图鉴", false),
        sw("auto_draw_elves", "自动抽取花灵", false),
        sw("auto_request_assist", "自动请求协助", false),
        sw("auto_recv_assist", "自动领取协助", false),
        sw("auto_assist_friend", "自动协助好友", false),
        num("max_assist_friend", "每日协助上限（暂不生效）", 10, { min: 0, max: 50 }),
        sw("auto_dispatch", "自动派遣花灵", false),
        sw("dispatch_double_only", "仅派遣双倍奖励", false),
        num("dispatch_elves_count", "派遣数量", 3, { min: 1, max: 6 }),
        sw("auto_speed_dispatch", "自动加速派遣", false),
        sw("auto_recv_dispatch_reward", "自动领取派遣奖励", false),
        sw("real_flower_elves_write", "自动执行花灵操作（派遣、收奖励、领协助都算）", false),
      ]},
      // [W18·09-18 花之密令/花灵密令接线] 两张卡各自两把闸：意愿（enabled）＋真实写
      //（real_*_pass_recv，都 def=false，铁律 5 零例外）。
      // 没有第二把闸的后果是**静默死通道**：`ACTION_GATES` 里指向的那一格在面板配置里不存在 ⇒
      // 取不到值 ⇒ 判据永远判「不许发」，看板上只写「没做」，谁都不像坏了（09-09 培育那次同形）。
      // ⚠️ 两格的名字按官方表族对应，**别按英文字面推**：
      //   `spirit_token`（花灵）＝活动类型 4601「花灵密令」，走 c_flowerElvesPass* 与同步模块 132；
      //   `flower_token`（花之）＝活动类型 4501「花之密令」，走 c_flowerPass* 与同步模块 131。
      // 判据出处见 flower-pass-cycle.js 文件头。
      { id: "spirit_token", label: "花灵密令", desc: "把花灵密令里已经达标的等级奖励领回来。任务进度来自你已经在跑的动作（种植、收获、订单、花架出售……），本卡只负责领；买等级、礼包、刷任务一律不做，「协助好友花灵」「摘好友花灵」两条任务脚本也不做（那要动别人的账号）。", fields: [
        sw("enabled", "开关", false),
        sw("real_elf_pass_recv", "自动领取已达标的等级奖励", false),
      ]},
      { id: "flower_token", label: "花之密令", desc: "把花之密令里已经达标的等级奖励领回来。任务进度来自你已经在跑的动作（种植、收获、订单、花架出售……），本卡只负责领；买等级、礼包、刷任务一律不做。", fields: [
        sw("enabled", "开关", false),
        sw("real_flower_pass_recv", "自动领取已达标的等级奖励", false),
      ]},
      // [2026-09-22 第 13 件·命名串链轻档①] 旧名「花艺上架」一个「上架」罩着两件事（做成品 / 摆上花架卖），
      // 客户读不出这张卡到底管什么，且与「花市上架卖鲜花」那条链的字面撞车。新名把两件事都点出来，
      // desc 逐件事说明、并写清各自不勾会怎样（铁律 8 第 3/4 条）。⚠️ **键 `flower_art` 一字不动**——
      // 存量配置全挂在它上面。格数也不许变（本批 13 格，前后逐格对过）。
      // 〔第140件·2026-10-07 用户定稿覆盖本段旧令〕「花艺制作」「花架经营」「花瓶图鉴奖励」三卡并成一张
      //   「花架与花艺」，两把闸各领一块（格1 做花艺／格7 上架），格2–6 跟格1、格8–14 跟格7。
      //   格数 13→**14**（第13件的「格数不许变」随本批作废，逐格对过＝施工单 §3）。
      //   键的纪律：real_flower_art_make／specified_arts／make_batch／real_rack_sell／rack_specified_arts／
      //   sort_strategy／put_count／real_rack_unlock／rack_unlock_keep_gold **九键一字不动**（存量全挂在它们上面）；
      //   新键 auto_replenish／first_album_claim／first_share_claim／rack_auto_take_down／rack_take_down_minutes
      //   出厂一律 false／保守档（铁律 5 零例外，`DEFAULT_ON_EXCEPTIONS` 保持空表）。
      //   整条删净（格、码、判据链；下架纪律＝不许隐形仍在读）：`make_always`／`sell_for_task_only`／`make_choice`
      //   三格定义**删除**（先例＝材料商店那格死格整格删除，存量库旧值成孤键、没有任何读法）。
      //   按用户点名走 PARKED 留档：`real_rack_recv`（行为并进格7，迁移＝旧 sell 或 recv 任一为真 ⇒ 格7 真）。
      //   格12 的下限＝官方 `c_flowerRack` 元行 `-1` 的 `$lockTime`（现读 240 秒＝4 分钟）**换算取用**：
      //   `officialFloor: "rack_lock_minutes"`（校验层按官方值现算，4 不许写成常量），运行期归一化同尺夹一次。
      { id: "flower_art", label: "花架与花艺", desc: "帮你把花架经营起来，两块各一把开关，先花艺后花架。做花艺：订单、主线缺的照单做；架卖的缺货按名单/缺啥补啥补做；开着自动补货时闲也不空转。上架：把货按次序摆上花架，卖掉自动收钱，卖不动的到有货接位时自动下架，架位不够可花金币开新阶段。做一件扣三朵配花，做出来收不回；哪块没开关，那块零动作。", fields: [
        // ── 〔第140件·2026-10-07 用户定稿〕十四格＝▍花艺块（格1–6，门＝格1）＋▍花架块（格7–14，门＝格7）。
        //   卡面文字逐字照施工单 §3（改字要留痕）；判据链门排在最前（P4），门关⇒子格锁由 lockedWhen 说话。
        sw("real_flower_art_make", "做花艺", false, {
          hint: "打开这块才动手做货：①订单、主线在等的缺几件做几件，缺什么做什么，下面的名单拦不住兜底；②花架卖断货时按「指定花艺（做什么）」「每次做几件」补做；③「自动补货」开着才吃闲料。做一件扣三朵配花，做出来收不回。「上架」关着时做出来的攒仓库，等架位。",
        }),
        // [第126件立／第140件改口] 名单管「补做与自动补货」，**拦不住兜底**：订单、主线在等的花艺不吃这一格
        //   （旧「订单要的花艺没在名单里就不为它做」那条规矩随第140件作废）。认不出的号（老存档花瓶号残留）
        //   照旧忽略不挡路＋ART_SPECIFIED_UNKNOWN 逐条点名；挑的全认不出＝一条都不做（fail-closed，绝不回自由挑）。
        multi("specified_arts", "指定花艺（做什么）", [], {
          source: "flower_arts",
          lockedWhen: "plant.flower_art.real_flower_art_make",
          hint: "勾了＝补做和自动补货只在这几样里做，每样补到「每次做几件」；架上卖断的是别的样也不改目标——做什么这格说了算。\n不勾＝不设限制：卖断哪种补哪种（缺啥补什么），自动补货按短板家底挑。\n订单、主线在等的花艺不吃这一格。",
        }),
        // [第140件·新键] 自动补货：兜底与补做都排空才开工；短板家底选品、每做完一件现读重比、不凑批不粘着；
        //   无件数顶（顶就是料——页面上没有那一格，代码里就不许有那道闸，铁律16）；代价上屏（配花持续变成品）。
        sw("auto_replenish", "自动补货", false, {
          lockedWhen: "plant.flower_art.real_flower_art_make",
          hint: "别的活（兜底、缺货补做）都排空时它才开工：从做得出的花艺里挑「最不禁用的那支配花、谁家囤得最多」的那样先做（短板家底）；每做完一件现读重比，不再是家底最厚立刻换——不凑批、不粘着。\n代价：开着它，仓库配花会持续变成成品；上架开着边做边卖，上架关着成品堆仓库。不想清仓就别开。\n勾了名单只在名单里比。「架上一个在售的都没有」的新号起步也由它管。",
        }),
        // [第140件·语义改] `make_batch` 键不动、语义由「凑满一批才换」（批次粘性）改「目标库存位」：
        //   补做/自动补货把每样做到 N 件余量就停（宁少不多）；订单、主线缺几件做几件不吃这一格。
        num("make_batch", "每次做几件", 1, {
          min: 1, max: 999,
          lockedWhen: "plant.flower_art.real_flower_art_make",
          hint: "补做/自动补货把每样做到这么多件就停（目标库存位）；仓库低于这个数才补、到了就不做。\n订单、主线缺几件做几件，不吃这一格。做一件＝扣三朵配花。",
        }),
        // [第140件·新键] 首做图鉴自动领：旧「花瓶图鉴奖励」卡的写闸并入这一格
        //   （迁移＝旧 enabled 与 real_vase_album_reward **两把都真**才为真，tools/migrate-1007-rack-art-merge.mjs）。
        sw("first_album_claim", "首做图鉴自动领", false, {
          lockedWhen: "plant.flower_art.real_flower_art_make",
          hint: "每样花艺第一次做成，那份花瓶图鉴金币奖自动领掉。不花你号里任何东西，领了收不回。",
        }),
        // [第140件·新键] 首做分享自动领元宝：usr.share 家族点名案（先例 83件 shareId5/19/34、103件 8、120件 9/13、121件 11）。
        //   判据现读 `server/data/official-cfg/c_share.json` 键"6"：name=首次制作花艺品分享、tag=sharingArtProduce、
        //   hasShare=1、limitType=1、limit=999、award=[[7,5],[1,5],[11,10000]]（道具7水滴／1元宝／11金币），该行**无 cd 无 hasVideo**。
        //   发送形状现读 common@544445 一带（PFlowerArtFinishDlg._tap_btn_share 逐字）：usr.share{shareId:6, ext:{opType:2, id:花艺号}}。
        //   写后不重发；官方不认＝罢手并上屏「需要你手动分享」，不白烧次数（完成度据实分级）。
        sw("first_share_claim", "首做分享自动领元宝", false, {
          lockedWhen: "plant.flower_art.real_flower_art_make",
          hint: "每样新花艺首次做成，官方分享奖 5 元宝＋5 水滴＋10000 金币，每样一次。脚本替你点这一发；官方服务器不认时自动罢手，屏上说「需要你手动分享」，不白烧次数。",
        }),
        // ── ▍花架块（门＝格7「上架」）──
        // [第140件·收钱并进] 旧「收卖货的钱」（`real_rack_recv`）下架留档（PARKED），行为并进这一把闸：
        //   开「上架」＝卖完自动收钱（含架上遗留挂账，不设单独开关）。
        //   迁移＝旧 sell 或 recv 任一为真 ⇒ 这一格真（别把只开收钱的号弄丢功能）。
        sw("real_rack_sell", "上架", false, {
          hint: "打开这块才管架：摆货、卖掉自动收钱、超时且有货接位才自动下架、可勾开新阶段。\n开着它＋做花艺也开着，卖断货才会自动补做；只开这块＝只卖现存的。成品摆上花架后，卖出去之前拿不回来。",
        }),
        // [第127件立／第140件改文字] 上架自己的名单：只管摆；⚠️两本名单对不上的僵局代价明写在 hint（铁律 8 第 3/4 条）。
        //   〔改字留痕〕施工单 §3 格8 原句「只摆B、做的是A时…」含会被翻译层抹掉的单个拉丁字母（上屏必裂），
        //   按客户面守卫改写成等义的纯中文说法；语义一字不差：架空、货停、要两边都勾。
        multi("rack_specified_arts", "指定花艺（摆什么）", [], {
          source: "flower_arts",
          lockedWhen: "plant.flower_art.real_rack_sell",
          hint: "勾了＝架只摆这几样，别的成品有货也不摆；什么都不勾＝仓库全部花艺库存都是货。\n这一格只管摆，做哪几样看「做什么」。\n⚠️代价：「摆什么」和「做什么」是两本名单，对不上会僵——卖断的样架上空着、做好的货又不再补——想让卖断的也能自动补做，把它的名字也勾进「做什么」。",
        }),
        sel("sort_strategy", "先挑哪一件", "max_stock", [
          { label: "库存最多", value: "max_stock" }, { label: "库存最少", value: "min_stock" },
          { label: "价格最高", value: "max_price" },
        ], { lockedWhen: "plant.flower_art.real_rack_sell",
          hint: "只管摆货——仓库几样都有现货时，空架位先摆哪样（库存最多/库存最少/价格最高）；只在「指定花艺（摆什么）」勾中范围里排。\n补做哪样、自动补货先做哪样都不看这一格。", }),
        num("put_count", "每次摆几件", 1, { min: 1, max: 12, lockedWhen: "plant.flower_art.real_rack_sell",
          hint: "一个架位一次摆几件同款。官方一个架位最多 12 件（这个上限从官方花架表现读，不写死），多填也按 12 摆。", }),
        // [第140件·新键] 自动下架（写＝`flowerRack.cancelSell`，第5件旧「刻意不发」名单里的那一条随用户点名退役）。
        //   有货接位才下（用户拍板②）：没货接位不下、摆着继续卖，屏上说清（永动机形状由测试钉死）。
        sw("rack_auto_take_down", "自动下架", false, {
          lockedWhen: "plant.flower_art.real_rack_sell",
          hint: "摆上超过保留时间还没卖出的收回仓库——只在仓库有货接位（或补做目标等架位）时才下；没货接位不下，摆着继续卖，屏上说清。收回不损失东西；重新上架要等空位。",
        }),
        // [第140件·新键] 在架保留时间（分钟）。下限＝官方 `c_flowerRack` 元行 `-1` 的 `$lockTime` 现读换算
        //   （现读 240 秒＝4 分钟；`officialFloor: "rack_lock_minutes"` 由保存校验与运行期归一化**同一把尺**取用，
        //   4 不许写死在任何常量里——官方改了表，页面下限与判据自己跟着走）。格11 关着这格灰显（门关子格锁）。
        num("rack_take_down_minutes", "在架保留时间（分钟）", 20, { min: 1, max: 1440,
          officialFloor: "rack_lock_minutes",
          lockedWhen: "plant.flower_art.rack_auto_take_down",
          hint: "摆上满这么多分钟还没卖出才可能收回。\n官方规定上架后 4 分钟内下不了架——这一格的最低值按官方锁定时长现算，不写死。", }),
        sw("real_rack_unlock", "自动开新花架阶段", false, {
          lockedWhen: "plant.flower_art.real_rack_sell",
          hint: "架位摆满了还想继续摆时，花金币开下一阶段。不勾＝永远不动你的金币：摆满就罢手，货留仓库。",
        }),
        num("rack_unlock_keep_gold", "开新阶段后至少留金币", 0, { min: 0,
          lockedWhen: "plant.flower_art.real_rack_sell",
          hint: "交完解锁金币后剩的少于这个数就不解锁。0＝不限。", }),
        // ── 以下为「下架留档」定义（只摘渲染、存量值不动、运行期零读取；逐条在 PARKED_FIELDS 有账）──
        // [第140件] `make_always`／`sell_for_task_only`／`make_choice` 按用户定稿**格、码、判据链整条删净**，
        //   定义不再保留（先例＝材料商店死格整格删除）：存量库里旧值成孤键，没有任何读法。
        sw("enabled", "开关（已下线：这一张卡下面的格各自说了算）", false),
        // [v6 C1 两格合一] 意愿格下架留档：去向＝real_rack_unlock。
        sw("auto_unlock_rack", "自动开新花架阶段（只出计划；真要动手还要勾下面那格）", false),
        sw("auto_put", "一键上架（暂不生效）", false),
        sw("auto_make", "自动做花艺成品（已下线：与「做花艺成品」那一格合并成一格）", false),
        // [09-24 用户实屏点名] 单轮上限整格下架（代码里的 ART_MAKE_ACTION_CAP 同批删净，铁律 16）。
        num("make_per_cycle", "单次最多做几朵成品（本项已下架：能做几朵就做几朵，不再按条数截）", 6, { min: 1, max: 20 }),
        // [第77件 用户点名] 每分钟上架件数整格下架（RACK_ACTION_CAP 与切片同批删净，铁律 16）。
        num("max_actions_per_cycle", "每分钟最多上架几件（本项已下架：有多少空架位就摆多少，不再按件数截）", 6, { min: 1, max: 20 }),
        sw("flower_art_exp", "花艺经验（暂不生效）", false),
        sw("album_reward", "图鉴奖励（分享/看广告，脚本不代做，本项不生效）", false),
        // [第140件 用户点名 PARKED] 收卖货的钱：行为并进格7「上架」；迁移脚本把旧值 OR 进格7 后此格零读取。
        sw("real_rack_recv", "收卖货的钱（已下线：并进「上架」——开着上架，卖掉的自动收）", false),
      ]},
      // [W19·09-18 立卡／第140件·2026-10-07 撤卡并入格5] 「花瓶图鉴奖励」退出客户名册：领首做图鉴金币奖
      //   并进「花架与花艺」格5「首做图鉴自动领」（写闸键＝plant.flower_art.first_album_claim，门＝格1）。
      //   迁移＝旧 enabled 与 real_vase_album_reward **两把都真** ⇒ 格5 才为真
      //   （tools/migrate-1007-rack-art-merge.mjs，写前拍快照、写回现读对账）。
      //   两格定义与存量值留档（PARKED_FIELDS 在册），运行期归一化改读格5（vase-album-cycle.js）。
      { id: "vase_album", label: "花瓶图鉴奖励（已下线：并入「花架与花艺」格5）", desc: "这张卡已并进「花架与花艺」：每样花艺第一次做成，那份花瓶图鉴金币奖按格5「首做图鉴自动领」领取；不花你号里任何东西，领了收不回。", fields: [
        sw("enabled", "开关（已下线：并入「花架与花艺」格5）", false),
        sw("real_vase_album_reward", "自动领取图鉴奖励（已下线：并入「花架与花艺」格5）", false),
      ]},
      { id: "flower_market", label: "花贸市场", desc: "自动收取自家摊位货款、去好友摊位上买花（花的是金币，不是元宝）。自己上架卖花这一半不做（上架位要花元宝买，花元宝的事托管不替你做）。", fields: [
        sw("enabled", "开关", false), sw("recv_income", "自动收取收益", false),
        // [W14·09-18 花市一期接线] 两条真实写各挂一把独立子闸（客户 09-14 18:34 原话
        // 「自动买花功能，去买别人架子。这个一定一定要有开关」）。都默认关（铁律 5 零例外）：
        //   real_market_recv_income 准「把自家摊位的货款取回来」（白拿，但仍是一条真写）；
        //   real_market_buy         准「买好友摊位上的花」（花金币，付出去不退）——客户点名的那一把。
        sw("real_market_recv_income", "自动收取自家摊位收益", false),
        sw("auto_unlock_shelf", "自动解锁货架", false),
        sw("auto_put", "自动上架（暂不生效）", false), sw("only_cultivated", "仅上架已培育花朵（暂不生效）", false),
        sel("strategy", "上架策略", "all", [
          { label: "全部花朵", value: "all" }, { label: "指定花朵", value: "flower" }, { label: "指定品质", value: "quality" },
        ]),
        multi("target_flower_ids", "上架花朵（暂不生效）", [], { source: "flowers" }),
        multi("target_qualities", "上架品质（暂不生效）", [], { source: "qualities" }),
        multi("exclude_flower_ids", "排除花朵（暂不生效）", [], { source: "flowers" }),
        sel("price_strategy", "价格策略（暂不生效）", "market", [
          { label: "跟随市场最低价", value: "market" }, { label: "固定价格", value: "fixed" },
          { label: "高于最低价 10%", value: "plus10" },
        ]),
        num("put_count", "上架次数", 3, { min: 1, max: 20 }),
        num("password", "上架密码", 0, { min: 0, max: 9999 }),
        num("buy_put_limit", "元宝购买上架次数上限", 0, { min: 0, max: 20 }),
        sw("friend_shop", "自动购买好友摊位", false),
        // [W14·09-18 花市一期接线] 客户点名的那把开关：买好友摊位上的花＝真花金币（道具 11），
        // 付出去退不回来，所以「意愿」之外还要单独准许真实写；只开左边那一格时只出计划、一枚金币不花。
        // 卡面把代价与「一轮最多买一格」写清楚（铁律 8 第 3 条），见 capabilities 的 flower-market 卡。
        // ⚠️ 标签里只许用「（真实写）」这一种写法：手机端那一层会把它换成客户话「（真的会动手）」
        //（capabilities.js 的 `plainForCustomerSafe`）；写成「（真实写·花金币）」换不掉，
        // 守卫 tests/mobile-capabilities.mjs 会当场判「卡面印了工程口径」。花金币这件事写在卡面 detail 里。
        sw("real_market_buy", "自动买好友摊位的花（花的是金币，付出去退不回来）", false),
        sel("shop_strategy", "扫货策略", "all", [
          { label: "全部花朵", value: "all" }, { label: "指定花朵", value: "flower" }, { label: "指定品质", value: "quality" },
        ]),
        multi("shop_target_flower_ids", "扫货花朵", [], { source: "flowers" }),
        multi("shop_target_qualities", "扫货品质", [], { source: "qualities" }),
        multi("shop_exclude_flower_ids", "扫货排除花朵", [], { source: "flowers" }),
        // ⚠️ 下面三格**本期不生效**（卡面已逐条写明，不是「还没做完」而是「这一期脚本不碰」）：
        //   好友昵称两格：脚本还读不到好友昵称（要另一条只读链）⇒ 只要你填了，买花整条不下手，绝不假装按它筛过；
        //   购买密码一格：脚本永不拿密码去试别人的摊位（红线）⇒ 填了同样整条不下手。
        multi("shop_target_friend_names", "扫货好友昵称（本期不生效）", []),
        multi("shop_exclude_friend_names", "扫货排除好友（本期不生效）", []),
        num("shop_password", "购买密码（本期不生效·脚本不试别人的密码）", 0, { min: 0, max: 9999 }),
        num("min_duration", "最短持续时间（暂不生效）", 0, { min: 0, max: 300, suffix: "秒" }),
        num("shop_continuous_duration", "持续扫货时长（暂不生效）", 0, { min: 0, max: 300, suffix: "秒" }),
      ]},
    ],
  },
  {
    id: "order",
    label: "订单",
    modules: [
      // [第56件·2026-09-27 用户裁决] 这张卡只剩一个开关：打开就一直做、不限量、不滤品质、
      //   缺花不弃不拒（留着等种，库存不足就去种——那条链本来就在）。下面四道闸的格子**全部下架留档**
      //   （PARKED_FIELDS 第56件段；定义与存量值一字不动，卡面收成扁平形态＝与「做花艺成品」同形状）。
      { id: "resident_orders", label: "居民订单", desc: "自动完成居民订单，提交花朵获取奖励。", fields: [
        sw("enabled", "开关", false),
        // [第79件·2026-09-30 用户点名恢复 → 第81件同日订正] 这格从 PARKED 出列；运行期读取方＝
        //   real-order-cycle.js GROUPS.resident.limitField（唯一），截单吃官方当日计数。
        // ⚠️ 第79件把出厂判成 200＝「事实上不限」——**判错了，本批订正**：官方日上限是千级
        //   （c_orderFlower 还原元行 $dailyMax=1200，出处 common@1370073 `_checkOrder` 对 getTdyCount(105)；
        //   raw 态 1260 不作判据），200 会真拦掉 200 单以后的合法订单。现出厂＝官方值：游戏自己到数就停，
        //   这一格因此只在用户往下收紧时生效；max＝官方值（页面上的顶要有出处——与第80件 plots_per_flower 同形状）。
        num("daily_finish_limit", "居民订单每日上限", 1200, { min: 0, max: 1200, hint: "一天最多做几单，做到就停；今天做到第几单按游戏自己的计数算，过了零点会重新上线取今天那份。填 0＝不限。出厂＝官方每日上限 1200（游戏自己做到数会停，这一格用来往下收紧，比如填 100＝每天最多做 100 单）。" }),
        multi("quality_filter", "以下品质的花朵不提交", [], { source: "qualities", hint: "不填则提交所有品质" }),
        // [L12 缺花处置三态·09-14 用户立项，默认＝跳（＝现行行为零漂移）]
        // [第56件·裁决4] 这格随本批下架：居民订单**没有"放弃这张单"这条路**——缺花只留着等种。
        sel("missing_flower", "遇到没有的花", "skip", [
          { label: "跳过——这单先放着，稍后再看（默认，与从前行为一致）", value: "skip" },
          { label: "培育——记下这朵缺花，供培育排花优先参考（要真培请自己开「培育开始」卡；与培育的联动逐步开放）", value: "cultivate" },
          { label: "放弃——这次托管期间不再碰这张单（换了新花会重新评估）", value: "abandon" },
        ]),
        time("execute_time_start", "执行时间段（开始）", ""), time("execute_time_end", "执行时间段（结束）", ""),
        // [第83件·2026-09-30 用户点名「居民订单做完会出这个免费领元宝，这个也需要对接；
        //   不看完，这一格就一直卡着不刷新居民订单」] 看视频单意愿闸（与卡头 `enabled` 是两把闸：
        //   enabled＝做不做居民交花单，这一格＝要不要顺手把「只能看视频做」的格也做掉）。
        //   出厂 false（铁律 5 零例外）；代价按铁律 8 第 3 条摆明在行右那枚「?」里
        //   〔第95件·补2 用户点名「『看视频单也自动做完』这几个字直接简写成视频单」⇒ 行名缩到三个字，
        //   整段解释一个字不删地搬进「?」——与 09-25 全局口径、第94件「白名单／黑名单」同一姿势〕
        sw("real_order_video_share", "视频单", false, { lockedWhen: "order.resident_orders.enabled", hint: "勾了才做那种「订单格上标着免费领元宝」的单——它只能用看视频完成，不看完这一格就一直卡着不出新单；每族官方每天限看 5 次（这个数从游戏自己的表里现读，不是我们写死的），这一发只花次数、不扣花不扣金币，奖励是格上标的那份元宝；服务器哪次拒了就不硬闯、如实记，绝不重发。不勾＝这一格整格跳过，它会一直卡着不出下一单。" }),
      ]},
      // [第57件·2026-09-27 用户「居民订单完成后的进度奖励也需要自动领」] 花坊任务（成就）里的居民订单组：
      //   累计完成居民订单到一档（门槛从官方表 c_task_ach 现读，本批现取＝400 次）时面板上亮「领取」，
      //   这一格就是准不准替客户点那一下。**零消耗**（不花金币/元宝），与隔壁「订单进度宝箱」是两件事
      //   （那一条按**今天**订单数分四档、过零点重来；这一条按**累计**次数、一档一生只领一次）。
      //   代价写在卡面上：发出去要等游戏把这一档记进成就已领名单才算数，等不到本次托管期内不再领——
      //   成就没有「明天再领同一档」的侥幸语义。判据与红线逐条出处见 task-ach-cycle.js 文件头。
      { id: "resident_order_ach", label: "居民订单进度奖励", desc: "累计完成居民订单到档就领掉这份进度奖励。", fields: [
        // [第59件·2026-09-27 用户追补「那就只保留一个开关就行，给个备注，不要这么复杂」] 这一格随整模块
        //   **下架留档**（进 PARKED_MODULES）：它并进了「居民订单」那张卡，跟着那张卡的开关一起走；
        //   一句话的备注（哪两样跟着领、各到什么档）写在居民订单卡的卡头「?」里，不铺在标签上（用户点名要简单）。
        sw("enabled", "自动领取居民订单进度奖励"),
      ]},
      { id: "satin_orders", label: "绸缎订单", desc: "自动完成绸缎订单。", fields: [
        sw("enabled", "开关", false),
        // [第81件·2026-09-30 用户点名「绸缎和建材订单的上限是120…加上居民订单的那个——让用户设置的每天做多少单」]
        //   出厂/max＝c_orderFlower 还原元行 $dailyMax2=120（判据 common@1370073 `_checkOrder`：
        //   getTdyCount(109)−1 对 $dailyMax2；raw 态 181 不作判据）。旧出厂 100 会真拦 100 单以后的合法订单，本批订正。
        //   ⚠️ 本组的两格「执行时间段」同批下架（用户点名「把绸缎订单的时间限制去掉，随时都能做」，
        //   见 PARKED_FIELDS 第81件段＋GROUPS.satin.windowApplicable:false）——绸缎卡上只剩开关与这一格。
        num("satin_finish_limit", "绸缎订单每日上限", 120, { min: 0, max: 120, hint: "一天最多做几单，做到就停；今天做到第几单按游戏自己的计数算，过了零点会重新上线取今天那份。填 0＝不限。出厂＝官方每日上限 120（游戏自己做到数会停，这一格用来往下收紧，比如填 50＝每天最多做 50 单）。" }),
        // [第83件·2026-09-30 用户点名「免费领元宝那格必须对接」] 绸缎那一格（官方叫「绸缎看视频」，
        //   c_share#19，同样每天 5 次）：与居民同一把尺、同一句代价，只是这是绸缎卡自己的格（一格一家）。
        sw("real_order_video_share", "视频单", false, { lockedWhen: "order.satin_orders.enabled", hint: "勾了才做那种「绸缎格上标着免费领元宝」的单——只能用看视频完成，不看完就一直卡着不出新单；官方每天限看 5 次，这一发只花次数、不扣花不扣金币；服务器哪次拒了就不硬闯、如实记，绝不重发。不勾＝这一格整格跳过，它会一直卡着不出下一单。" }),
      ]},
      { id: "decorate_orders", label: "建材订单", desc: "自动完成建材订单。", fields: [
        sw("enabled", "开关", false),
        // [第81件] 出厂/max＝c_orderFlower 还原元行 $dailyMax3=120（判据同上：getTdyCount(116)−1 对 $dailyMax3；
        //   raw 态 182 不作判据）。〔第87件改口〕本组**时段两格同批下架**（用户点名「时间段限制都不要」）：
        //   这句原先写「建材时段两格照旧是真闸——用户只点名绸缎去时段」，那是第81件的形状，留着就是谎话。
        //   判据出处＝GROUPS.decorate.windowApplicable:false；名单见本文件 PARKED_FIELDS 第87件段。
        num("decorate_finish_limit", "建材订单每日上限", 120, { min: 0, max: 120, hint: "一天最多做几单，做到就停；今天做到第几单按游戏自己的计数算，过了零点会重新上线取今天那份。填 0＝不限。出厂＝官方每日上限 120（游戏自己做到数会停，这一格用来往下收紧，比如填 50＝每天最多做 50 单）。" }),
        time("execute_time_start", "执行时间段（开始）", ""), time("execute_time_end", "执行时间段（结束）", ""),
        // [第83件·2026-09-30] 建材那一格（官方叫「工坊看视频」，c_share#34，每天 5 次）：同一把尺。
        // 〔第95件·2026-10-01〕这句话里原先写「工坊格上标着…」——本卡从头到尾叫「建材订单」，屏上再冒出
        //   第三个名字（卡面建材／日志装饰／这一格工坊）客户就得自己猜它们是不是同一处，统一到卡名。
        sw("real_order_video_share", "视频单", false, { lockedWhen: "order.decorate_orders.enabled", hint: "勾了才做那种「建材格上标着免费领元宝」的单——只能用看视频完成，不看完就一直卡着不出新单；官方每天限看 5 次，这一发只花次数、不扣花不扣金币；服务器哪次拒了就不硬闯、如实记，绝不重发。不勾＝这一格整格跳过，它会一直卡着不出下一单。" }),
      ]},
      { id: "customer_orders", label: "顾客订单", desc: "自动完成顾客订单。", fields: [
        // [第55件·2026-09-26 用户口径①②④] 开卡＝交付＋主动喊客人挂单一起生效（用户①：「只要开启了顾客订单，
        //   那就肯定要自动叫客人挂单」）；「自动拒单」是全卡**唯一**的拒单闸（用户②：「背包的花不够完成订单就
        //   直接拒，就这么简单粗暴」）。
        // [第58件·2026-09-27 用户口径①②] 这张卡的活格子＝卡开关＋一把自动拒单＋一个花坊币复选框：
        //   ①「顾客订单不要上限，做多少都可以」→ `daily_finish_limit` 下架留档（定义照抄在下面第58件段，
        //     运行期连读都不读，GROUPS.customer.limitField 已改 null）。
        //     〔第156件·这里从前写的"每轮至多交 1 单"那道节奏约束**已整条拆掉**〕旧写法把它说成"不是上限、
        //     是收口证据的边界"，理由是"官方顾客交付不回带、当日完成数+1 是唯一凭据"——**这个理由被真号现读否证**：
        //     2026-10-10 run 335/336 四发交付每一发都各自带回出账（#9 扣 302505×2／#4 扣 300420×3／
        //     #7 扣 300201×3／run336 #4 扣 301503×2）⇒ 凭据在每一发身上。页面上从来没有"每轮交几单"这一格
        //     （铁律 16：客户摸不到的限制不许存在于代码里），闸与理由码同批摘（`real-order-cycle.js
        //     #orderActionsForRound`＋`reason-zh.js`），卡面「?」换成拆完之后真正的收口规矩：一次全交、
        //     逐单各自认账、没带回话的那一单只停它自己且不补发。
        //   ②「花坊币只有123三个选项，要做成复选框，客户自己决定做多少花坊币的顾客订单」→
        //     `flower_shop_coin_amounts` 从下架名单**出列复活**，选项**固定且只有 1/2/3 三项**——
        //     名单的唯一出处＝用户②当面裁决（下方 options），不挂 source、前端不许再从 /meta 取名单
        //     （当初灰格的病根就是名单没有稳定来源；抄第二份必漂）。第55件的阈值数字格
        //     `flower_shop_coin_min` 随之退场（同一件事两个控件＝"两套分母"，绝不允许同屏/同读）。
        //   第54件逐档单选行与 09-16 分档四子闸等依旧下架（PARKED_FIELDS 第54/55件段；运行期零读取方）。
        sw("enabled", "开关", false),
        // 复选框这一格只做一件事：把**不在勾选档位里**的单标成「这一单不做」（skip）；
        // **拒不拒一律由「自动拒单」那把唯一的闸说话**（第55件用户④口径一字未改：闸关＝只跳过、下轮再看；
        // 闸开＝拒）——本格在任何代码路径里都不许发起拒单（守卫 tests/order-coin-checkbox.mjs 判据③钉死）。
        // 全勾（出厂 [1,2,3]）＝官方现读的 1/2/3 枚单全做＝与第55件出厂阈值 0「不限档」逐条同判（零漂移基线
        // tests/fixtures/order-coin-checkbox-baseline-57.json 钉）；全不勾＝一张都不做（用户自己决定，同「培育选花
        // 模式」一项不勾＝一朵都不培的先例）。币值认不出（表缺/行缺/无 1002 分量）＝**不拦**（认不出≠不许）。
        // ⚠️ 代价句（铁律 8 第 3 条，摆进标签括号＝格右边「?」，一字不许省）：
        multi("flower_shop_coin_amounts", "只做勾了的花坊币的单（不在勾里的单只是不做——要不要拒，看「自动拒单」那一格；⚠️ 只有 1/2/3 三枚可选，4 枚及以上的单永远不在可勾范围里：自动拒单开着时它会被拒、关着时它只被跳过——想做 4 枚以上的单，这张卡给不了这个选择）", [1, 2, 3], {
          // 选项名单的唯一出处＝用户②当面裁决（2026-09-27「花坊币只有123三个选项」）。前端直接画这三个复选框。
          // ⚠️ 这句从 10-02 起由本格自己带（原来写死在前端那一行，被公会建设那格原样借用＝对上屏说假话）。
          emptyNote: "一个都没勾＝顾客订单一概不做",
          options: [
            { value: 1, label: "1 枚" },
            { value: 2, label: "2 枚" },
            { value: 3, label: "3 枚" },
          ],
        }),
        // [第55件·B] 唯一拒单闸（用户②原话命名）。def=false 照旧、不进任何默认开例外。
        //   代价句摆进标签括号（进格右边「?」，09-25 口径）：粗闸比第54件的分档闸狠——等料中的单也拒。
        // 〔第150件〕名字跟着判据走：开着这把闸也不再"缺料就拒"——缺成品的单先报给花艺照单做，
        //   做得了就留着等它；只有花艺说这一刻做不出来才走到拒。代价句照旧摆明（拒了就退不回来）。
        sw("auto_reject", "自动拒单（开着时：缺成品的单先让「做花艺」照这一单去做，做好了自动来交；只有花艺说这一刻做不出来——配花不够、装它的花瓶还没解锁、或「做花艺」没开——才把它拒掉，拒了就退不回来）", false),
        // [第54件·C → 09-30 下架] 这格管做花艺的用料，历史上画在「做花艺成品」卡上。
        //   **本批已进 `PARKED_FIELDS` 下架留档**（09-30 批·用户裁决「这个按钮在这不是多此一举吗」，
        //   官方两条判据逐字写在那一段）：定义与出厂值一个字不动、存量零迁移（#11/#16/#19 现读全 false）；
        //   渲染与归属同批退场（`SHARED_ROW_OWNER` 出列），运行期摘读归工位B。
        sw("cultivable_only", "做花艺只用已培育的花（勾上＝培育还没长出来的花，就算材料齐了也不拿它做花艺）", false),
        // ↓ [第58件·用户①②] 这两格**下架留档**（渲染与运行期同时退场，逐条依据见 PARKED_FIELDS 第58件段）：
        //   定义与出厂值一字不动，存量值无害（#19 烘着的 coin_min=0 与三号的 daily=100 都没人读了）。
        //   · `daily_finish_limit`（用户①去上限）——GROUPS.customer.limitField 改 null 后运行期连读都不读；
        //   · `flower_shop_coin_min`（第55件的阈值数字格）——被上面那三个复选框整格取代，normalize 不再读它。
        num("daily_finish_limit", "顾客订单每日上限（本项已下架：做多少都可以，不设每日上限）", 100, { min: 0, max: 300 }),
        num("flower_shop_coin_min", "只做这么多花坊币及以上的单（本项已下架：改由上面「只做勾了的花坊币的单」三个复选框决定）", 0, { min: 0, max: 99 }),
        // ↓ [第55件·B／第54件·E] 以下各格**下架留档**：屏上不画、运行期零读取方（逐条依据见 PARKED_FIELDS 第55件段）。
        //   这四把拒单闸的 def 同时改回 false——**出厂一律默认关**（空例外表的口径），这不是改语义：格子已没人读；
        //   存量值照旧不动（#16/#19 烘着的 true 变成没人读的死值，一个都不回写）。
        sw("auto_generate", "自动喊客人挂单（真实写）", false),
        sw("auto_reject_unmet", "自动拒补不齐的单（真实写）", false),
        sw("reject_unlocked_empty", "缺的花已解锁但背包里没有（能种，还没种）时自动拒", false),
        sw("reject_cultivating", "缺的花正在培育中时自动拒（等到就能做，拒掉需自己承担）", false),
        sw("reject_scheduled", "缺的花已排进培育建议、还没开始培时自动拒（同上）", false),
        sw("reject_locked_unplanned", "缺的花没解锁、也没排培育（短期做不出来）时自动拒", false),
        sel("shortfall_flower", "缺已经培育出来的花时", "wait", [
          { label: "等着种——照常种下、成熟收了再做（默认，一张卡都不烧）", value: "wait" },
          { label: "加速补库存——那块正在长的地一张加速卡催熟（吃一张卡，和你号里别的用途抢卡）", value: "speedup" },
        ]),
        sel("missing_flower", "遇到没有的花", "skip", [
          { label: "跳过——这单先放着，稍后再看（默认，与从前行为一致）", value: "skip" },
          { label: "培育——记下这朵缺花，供培育排花优先参考（要真培请自己开「培育开始」卡；与培育的联动逐步开放）", value: "cultivate" },
          { label: "放弃——这次托管期间不再碰这张单（换了新花会重新评估）", value: "abandon" },
        ]),
      ]},
      { id: "court_order", label: "宫廷订单", desc: "自动完成宫廷特供订单。", fields: [
        sw("enabled", "开关", false), multi("quality_filter", "品质过滤", [], { source: "qualities" }),
        sw("free_refresh_on_filtered", "被过滤时刷新", false),
      ]},
      // [W5·09-18] 订单进度宝箱 —— [第59件·2026-09-27 **整模块下架留档**]
      //   用户实屏原话：「订单进度宝箱，是居民订单的那个任务宝箱吗？如果是的话，那就不要这个
      //   单独的开关了，只要居民任务开了，那就需要自动去领进度宝箱」。
      //   落地＝闸改读「居民订单」那张卡的开关（`order.resident_orders.enabled`）；本模块连同它
      //   唯一那一格 `enabled` 进 `PARKED_MODULES`（整块下架：定义与存量值一字不动、界面不画、
      //   运行期零读取方；`test:dead-switches` 按 PARKED_MODULES 前缀认整块）。
      //   依据（三条现读，逐字可复核）：① 任务码 `c_task_type.3006` 名字就叫「居民订单」、
      //   描述「去完成${value}次居民订单」，四档门槛 [15,30,45,60] 挂在它下面；
      //   ② 宝箱界面 `OrderFlowerRwdDlg` 长在 `home/orderFlower/`（居民订单那一族的控制器）；
      //   ③ 官方进度式子第一项（不减 1 的那一项）就是居民订单今日计数。
      //   执行器与判据一字未动（做法见 order-reward-cycle.js 文件头；守卫 tests/order-reward-follows-resident.mjs）。
      { id: "order_reward", label: "订单进度宝箱", desc: "订单进度到档位就领掉那几个免费宝箱。", fields: [
        sw("enabled", "自动领取订单进度宝箱"),
      ]},
      // [W9·09-18] 组团订单（客户 09-14 18:42「订单 50 和 100 次的时候，分别会触发一次免费团单……
      // 一天最多共四次」）。一期**只做免费档**四件事：接一张待确认的免费团单、把手上这一团的花交上去、
      // 领这一团的奖、取回一张没过期的存单。两把新闸都默认关（铁律 5 零例外）：
      //   real_team_order_write ＝ 准不准真发写（关着只出计划）；
      //   allow_free_take       ＝ 准不准**主动去接**免费团单（关着时手上已有的那一团照样能交花、能领奖）。
      // 〔第180件·H09-1 改口〕"元宝＝真钱"这句在本仓作废（2026-10-14 用户裁决：元宝是号内游戏币）。
      //   现在卡面上说的代价是**事实**：`takeOrder` 带 `isCost:true` 有两支——
      //   ①「花元宝再加一次」（价格只从官方表读 `$orderTeamBuyCost`，现读 60 元宝，扣了不退）；
      //   ②「拒绝」那一支**也**带 `isCost:true`（common@1561488 逐字）——这一支我们**永不发**，
      //     因为我们根本不打开官方那个框，没有「替客户点拒绝」这件事。
      //   ①只在客户自己勾了 `allow_buy_again` 之后才可能发，且要过六道前置（见 order-team-cycle.js 注释）。
      //   超时那一团官方自己就不给这个框（`cantBuy:true`，@1220783），脚本也不会替你想别的出路。
      // 上面那几把老开关（buy_again / skip_submit_flower / only_cultivated / min_bag_reserve /
      // quality_filter / exclude_flower_ids / 执行时段）本期照旧**一个都不读**：
      // 它们要么我们还没有对得上的判据，要么读了就等于替客户点头。
      { id: "team_order", label: "组团订单", desc: "自动处理组团订单：接免费的那一档、交花、领奖。领完这一团之后要不要「花元宝再加一次」由你勾（默认不勾，一次固定扣表里那个数、不退）；跳过提交、买次数这些我们还没有对得上的依据，托管不替你做。", fields: [
        sw("enabled", "开关", false), sw("buy_again", "完成后自动购买新的组团订单（暂不生效）", false),
        sw("skip_submit_flower", "不自动交花（暂不生效）", false), sw("only_cultivated", "仅已培育（暂不生效）", false),
        num("min_bag_reserve", "背包保留下限（暂不生效）", 0, { min: 0 }),
        multi("quality_filter", "品质过滤", [], { source: "qualities" }),
        multi("exclude_flower_ids", "排除花朵（暂不生效）", [], { source: "flowers" }),
        time("execute_time_start", "执行时间段（开始）", ""), time("execute_time_end", "执行时间段（结束）", ""),
        sw("real_team_order_write", "自动接单、交花、领奖（关掉就一件都不动手）", false),
        sw("allow_free_take", "接免费团单（游戏派来一张不花元宝的团单时自动接下来）", false),
        // 〔第180件·H09-1〕「花元宝再加一次」这一档**接进来了**，但要客户自己点头：
        //   allow_buy_again 不勾 ⇒ 一件都不动；buy_again_keep_yuanbao ＝ 扣完之后号里至少留这么多（0＝不限）。
        //   代价逐字写在 hint 里（铁律 8 第 3 条）：一次固定扣 60 元宝（价格只从官方表读，代码不写死）、不可退。
        sw("allow_buy_again", "花元宝再加一次团单（领完这一团奖励、游戏问你要不要再开一局时）", false),
        num("buy_again_keep_yuanbao", "扣完之后元宝至少留", 0, { min: 0 }),
      ]},
    ],
  },
  {
    id: "guild",
    label: "公会",
    modules: [
      { id: "guild_land", label: "公会土地", desc: "自动收获、种植公会土地；开新块与升级这两件会花你的公会币，目前先禁着（理由写在行上）。", fields: [
        sw("enabled", "开关", false), sw("land_harvest", "自动收获", false),
        sw("land_plant", "自动种植", false),
        // [2026-10-05 用户令「把没做好的禁用，保留已经对接好的」] 这两格随 HELD_FIELDS 上屏禁用：
        //   `held` 文案的唯一出处就是上面那张 HELD_FIELDS 表（这里只引用，不许另抄一份）。
        sw("land_auto_upgrade", "自动升级土地", false, { held: HELD_FIELDS["guild.guild_land.land_auto_upgrade"] }),
        sw("land_auto_unlock", "自动解锁新土地", false, { held: HELD_FIELDS["guild.guild_land.land_auto_unlock"] }),
        // [第118件·10-04 用户点名「第二个也需要做」] 开新块与升级从今天起**真发请求**了。
        //   官方那一边每花一次公会币都要玩家亲手确认一下（`_tap_grp_land` 的 MSG 2006、
        //   `_tap_btn_upgrade` 的 checkItemEnough）；我们把这个"当场问一句"换成两格客户自己填的
        //   **保留线**：花完剩下的公会币低于这一格就不许花（0＝不设线，与官方一致——官方没这一格）。
        //   两格各归各的链（铁律 19 P1 一格一家）：开地与升级是两发、两种价，不共用一把尺。
        //   门（各自那把开关）关着 ⇒ 子格灰显并给中文理由（P4），判据一处算、渲染层只读。
        num("unlock_keep_coin", "开一块新地后公会币至少留这么多（留不够就不开；0＝不限）", 0, { min: 0, lockedWhen: "guild.guild_land.land_auto_unlock" }),
        num("upgrade_keep_coin", "升一级后公会币至少留这么多（留不够就不升；0＝不限）", 0, { min: 0, lockedWhen: "guild.guild_land.land_auto_upgrade" }),
        // [第111件·2026-10-03 用户点名「公会的土地到点就能收获，不用浇水，可以随时换花朵，这个需要单独一个计算」]
        //   公会地的**选花**从原来那一格「种植模式」里独立出来：单独一格、单独一套算法。
        // 为什么单独一套（不共用自家花田那套「这一遍种哪几块」的算法）——三处实打实的差别，条条有官方出处
        // （逐条写在 `server/src/game/guild-plant-choice.js` 文件头）：
        //   · 官方 `fmlLandIface` 只有 harvest / harvestAll / plant / unlock / upgrade 五个方法，
        //     **没有铲除、没有换花**，地块的 `flwId` 种上就长期挂着 ⇒「随时换花朵」在公会地这边做不到，
        //     只有**还没种的空地**能挑新的；这句必须写在客户面上，不许含糊（铁律 8 第 3/4 条）。
        //   · 公会地不靠浇水生长：按地块等级每 `c_fmlLandLvl[lvl].time` 秒自己产一份（0 级 900 秒／份、
        //     攒满 `stock`=6 才算熟），收完接着产。
        //   · 能种的花＝本号**已培育解锁**的花（官方选花弹窗的数据源读的就是培育那一块）；
        //     种花本身不扣道具、不花钱（官方判据逐字 `!!land && !land.flwId`）。
        // 出厂值为什么是 `demand`（**不是**随手挑一个，也**不是**放宽铁律 5）：
        //   铁律 5 那条「默认一律关」管的是**开关格**（勾了会真动手、会花东西的那种）；这一格是枚举，
        //   它自己**不驱动任何一发写**——动不动手归上面「自动种植」那把闸（出厂关）。
        //   在这一族里挑「今天的行为」＝零漂移：原来那一格「种植模式」两档中，`race`（跟随公会任务）
        //   **从来没有生效过**（真号日志逐字：该模式下一律不自动种），`specific`（指定花朵）在号上的存量
        //   也只被那条「不生效」的路当过数；所以新格出厂 `demand` 不会让任何一个号突然开始种花
        //   （2026-10-03 现读号 16：`land_plant` 关着、13 块地全种满、空地 0 块）。依据逐条见本文件
        //   `PARKED_FIELDS` 的第111件段。
        sel("land_flower_pick", "公会地种哪朵（选花算法）", "demand", [
          { label: "先种有人要的", value: "demand" },
          { label: "先种背包里最少的", value: "least_stock" },
          { label: "只种下面指定的花", value: "specific" },
        ], {
          // 整段说明走行右边那枚「?」（09-25 全局口径：描述性内容不直接印在行上，一个字不删、只换位置）。
          hint: "这一格只管一件事：还没种的空地先种哪一朵。"
            + "先种有人要的＝先看公会竞赛、顾客订单、居民订单、主线这几处正缺哪几种花，被要得多的先种；"
            + "一样多时再看背包里有几枝，枝数少的先种。"
            + "先种背包里最少的＝不管有没有人在要，从头到尾都按背包里有几枝排，最少的那种先种；"
            + "那一枝这一刻没读到的排到最后，不会当成「零枝」抢在前面。"
            + "只种下面指定的花＝只在下面「指定花朵」那一格里挑，那一格留空就一块都不种。"
            + "⚠️ 两件硬的事请先看到：一块公会地种下去就一直种这一朵，游戏里没有铲除或换花的按钮，"
            + "脚本也不会有这一动作，只有还没种的空地能挑新的；能种的只有你已经培育出来的那几种花，"
            + "一朵都没培育出来时一块都不种，不会替你挑一朵。"
            + "一个号最多 18 块公会地，已经种上的那些不受这一格影响。",
        }),
        // [第111件] 这一格「种植模式」**下架留档**：定义与出厂值一字未动、只摘渲染、存量值照旧。
        //   `race` 那一档从来没生效过＝页面上摸得到却什么都不做的假选项；`specific` 那一档的语义由上面
        //   新格 `land_flower_pick` 的同名档接管（「指定花朵」那一格不动、照旧被读）。
        //   依据、代价与存量迁移判断逐条写在下面 `PARKED_FIELDS` 的第111件段；
        //   运行期所有读取点同批删净（唯一出处 `server/src/game/guild-land-cycle.js`）。
        sel("plant_mode", "种植模式", "specific", [
          { label: "指定花朵", value: "specific" }, { label: "跟随公会任务", value: "race" },
        ]),
        multi("specific_flower_ids", "指定花朵", [], { source: "flowers" }),
        multi("plant_blacklist", "种植黑名单", [], { source: "flowers" }),
        rng("flower_level", "花朵等级范围", 1, 5),
        multi("quality_filter", "品质过滤", [], { source: "qualities" }),
      ]},
      // [W12·09-18 一期 → 2026-10-02 三档接齐] 公会建设。客户原话两条说的是同一件事：
      //   09-14 18:43「公会建设，视频建设，金币建设，元宝建设分别设置开关和次数」
      //   10-02     「一般人都是选择 1 次视频，5 次金币。有的人会 1 次视频 5 次元宝。你设置筛选条件。」
      // 一期只做了金币那一档，另两档被当时的红线常量钉死、这两格进 PARKED。现在按点名接齐，
      // 「筛选条件」落成一格**档位多选**（值＝官方 c_fmlBld 的行号 1/2/3，不另造一套标识）：
      //   · 勾哪几档就做哪几档；**一格都不勾＝一次都不捐**（同「花坊币只做勾了的单」「选花模式一项不勾＝一朵不培」）；
      //   · 没勾的那一档**连它的次数格都不读**（铁律 19 P3：没报量就按 0，不替客户编目标次数）；
      //   · 视频档**没有次数格**：官方每天就给 1 次（`c_fmlBld` 元行 `$dailyCountMap[1]` 现读 1），勾了就做满那一次。
      // ⚠️ 三件代价（铁律 8 第 3 条，摆明之后由用户自己决定，不许替他决定也不许藏在注释里）：
      //   ① 金币档一次花一笔金币、元宝档一次花一笔元宝，**捐出去退不回来**，而且公会币/公会财富进的是
      //      全公会可见的池子；具体数额由官方数值表说了算（现读 10000 金币／10 元宝），代码与本页都不写死；
      //   ② 元宝是**充值来的货币**：这一档出厂不勾、次数出厂 0，要它得客户自己勾；
      //   ③ 金币与元宝**共用官方每天 5 次**这一个池（官方 logic_fmlBuild 逐字两档相加），
      //      所以那两个「每天做几次」不各自是一份独立额度，真上限永远看服务器。
      // 卡级门（`enabled`）照旧：门没开时上面那把真实写闸灰显＋中文理由，判据链里门排在最前。
      { id: "guild_build", label: "公会建设", desc: "替公会捐建设，换回公会币和公会财富。官方一共三档（视频／金币／元宝），下面勾哪几档就做哪几档；一格都不勾就一次都不捐。", fields: [
        sw("enabled", "开关", false),
        // 真实写闸（def=false，铁律 5 零例外）：动的是「捐出去退不回来的钱」，所以「看着它列计划」与
        // 「真去点」必须分得开。出厂关＝客户自己点头才会真捐。
        sw("real_guild_build", "自动公会建设（三档里勾了的都会真捐出去，退不回来）", false),
        multi("build_tiers", "做哪几档建设（一格都不勾＝一次都不捐）", [], {
          // 选项名单的唯一出处＝官方 c_fmlBld 的三个行号（用户 2026-10-02 点名要的那三档）。
          // ⚠️ 标签里**不写具体数额**：数额由官方表说了算，写死会让表一改版这句话就变成假话；
          //    运行期屏上那一句「一次 X 金币／Y 元宝」才是现读的数。
          // ⚠️ 空勾选那句**必须由这一格自己带**（前端 10-02 起不再写死，见 ConfigGroups.jsx 那处注释）。
          emptyNote: "一个都没勾＝公会建设一概不做",
          options: [
            { value: 1, label: "视频建设（每天一次，走官方看视频那个口子）" },
            { value: 2, label: "金币建设（每次花号里的金币）" },
            { value: 3, label: "元宝建设（每次花号里的元宝，元宝是充值来的）" },
          ],
        }),
        num("build_gold_count", "金币建设每天做几次", 3, {
          min: 0, max: 10, suffix: "次",
          // ⚠️ 这里**不写池子的次数**（10-03 改）：那个数是官方表元行 `$dailyCountMap` 里的，版本会动；
          // 写死在文案里就是一句迟早撒谎的话。实际几个数、超没超，由那一格行上的现算句子说（唯一出处
          // guild-build-cycle.js 的 guildBuildPoolNote，保存回执读同一份）。
          hint: "这是你自己定的每天目标，不是独立额度：金币建设和元宝建设合起来共用官方每天那一个次数池，池子里有几次以游戏为准（填超了会在下面那一格当场说清多做不成几次）。一批发一次，几批下来做到这个数为止。",
        }),
        num("build_yuanbao_count", "元宝建设每天做几次", 0, {
          min: 0, max: 10, suffix: "次",
          hint: "出厂 0＝不花元宝。填了数、并且在上面勾了「元宝建设」这一档，才会真花；元宝是充值来的货币，捐出去退不回来。与金币档共用官方每天那一个次数池，金币档先挑、元宝档吃剩下的（填超了会在这一格当场说清多做不成几次）。",
        }),
        // 〔2026-10-02〕这一格已被上面「做哪几档建设」里的那一项取代（视频档官方每天就 1 次，不需要次数格）。
        // 定义与出厂值一字未动、继续留在 PARKED_FIELDS 里只摘渲染：存量存档里有这一键，删定义会留孤儿键。
        sw("build_video", "视频建设（已并入上面「做哪几档建设」那一格）", false, {
          hint: "这一格不再单独生效：视频建设改由上面「做哪几档建设」里勾不勾决定。",
        }),
      ]},
      { id: "guild_shop", label: "公会商店", desc: "按商品、库存、折扣和优先级自动购买公会商店商品。", fields: [
        sw("enabled", "开关", false), num("shop_coin_reserve", "公会币保留", 0, { min: 0 }),
        sw("shop_auto_unlock", "自动解锁货架", false),
        num("shop_unlock_target", "解锁目标货架", 0, { min: 0, max: 40 }),
        sel("shop_refresh_mode", "刷新策略", "none", [
          { label: "不自动刷新", value: "none" }, { label: "仅使用免费刷新", value: "free_only" },
          { label: "免费刷新后允许付费刷新", value: "free_and_paid" },
        ]),
        num("shop_paid_refresh_limit", "每日付费刷新上限", 0, { min: 0, max: 20, suffix: "次" }),
        { key: "shop_item_rules", label: "商品购买顺序", type: "order", def: GUILD_SHOP_ITEMS },
      ]},
      { id: "guild_share", label: "公会分享", desc: "把自己种的花放进公会分享位、领回自己分享位的奖励、拿别人分享位上的花。三件事是三件不同的事，各有各的开关，互不代替。", fields: [
        sw("enabled", "开关", false),
        // 意愿位：想不想做这三件事。真实写另有各自的一把子闸（都 def=false，铁律 5 零例外）。
        sw("share_auto", "自动分享（把花放进分享位）", false, {
          hint: "这一格只是「我想做」；要真把花放出去，请再勾下面的「放花到分享位」。"
            + "⚠️ 代价摆在这里：放进分享位的花会被公会成员拿走、也可能被居民收购，放出去就拿不回来了。",
        }),
        sw("recv_rwd", "领回自己分享位的奖励", false, {
          hint: "分享奖励要等你那一格摆过夜（过了当晚 0 点）才出现；有奖励时它会替你领回来。零消耗、不花任何东西。",
        }),
        sw("take_others", "拿别人分享位上的花", false, {
          hint: "拿的是公会成员公开摆出来给成员拿的花。每天能拿几次由游戏说了算，同一天拿不完的留到明天。",
        }),
        // 真实写三闸（全部 def=false，且不进 DEFAULT_ON_EXCEPTIONS）。面板把这三件事分开，
        // 是因为官方就是三条不同的链：领回自己的奖励与拿别人的花在游戏里是两个不同的按钮。
        sw("real_guild_share_put", "放花到分享位", false, {
          hint: "开着时：一次放花等级的 12 倍那么多朵（最多 180 朵），从你自己种出来的花里扣，扣了拿不回来。",
        }),
        sw("real_guild_share_recv", "领回自己的奖励", false, {
          hint: "开着时：每次最多领一次；领完没等到游戏回话，本次挂机期内不再领。零消耗。",
        }),
        sw("real_guild_share_take", "拿别人的花", false, {
          hint: "开着时：每次最多拿一格；「今天总共能拿几次」读不到时，一条都不拿。",
        }),
        // 下面六格是**脚本自己**挑花/挑人的条件（游戏里没有「按花筛」「按品质筛」这套机制），
        // 卡面必须这么说，不许冒充游戏设置（铁律 8 第 1/2 条）。
        sel("share_mode", "挑哪朵花去分享（脚本自己的条件）", "specific", [
          { label: "只放下面勾选的花", value: "specific" }, { label: "所有培育好的花里挑", value: "all" },
        ]),
        multi("share_flower_ids", "要分享的花（脚本自己的条件）", [], { source: "flowers" }),
        sel("take_mode", "拿花的挑法（脚本自己的条件）", "specific", [
          { label: "只拿下面勾选的花", value: "specific" }, { label: "别人的花都行", value: "all" },
        ]),
        multi("take_flower_ids", "要拿的花（脚本自己的条件）", [], { source: "flowers" }),
        multi("take_member_targets", "只拿这些成员摆的花（脚本自己的条件）", []),
        multi("share_quality_filter", "只放这些品质的花（脚本自己的条件）", [], { source: "qualities" }),
        multi("take_quality_filter", "只拿这些品质的花（脚本自己的条件）", [], { source: "qualities" }),
        // 元宝红线：这一格**永久不生效**，写在卡面上而不是藏在注释里（铁律 8 第 4 条）。
        sw("share_auto_unlock", "自动花费元宝解锁分享槽位（本项永久不生效：花的是充值元宝）", false, {
          hint: "这一格打开也不会有任何反应：解锁分享位要扣号里的元宝（一个位置 50），这一档脚本还没接上，也不会替你花这份元宝。"
            + "想开位置请你自己在游戏里点。",
        }),
      ]},
      { id: "guild_race", label: "公会竞赛", desc: RACE_MODULE_DESC, fields: [
        sw("enabled", "开关", false), sw("race_auto_take", "自动接取任务", false, { hint: RACE_TAKE_HINT }),
        // [B4 一期·09-15] 「自动接取任务」是意愿，这一条才是允许往官方发 fmlRace.takeTask 的真实写闸。
        // 铁律 5：一律 def=false，且不进 DEFAULT_ON_EXCEPTIONS（零例外）——领任务会占用当日接取名额，
        // 只有面板显式两把都勾了才发。〔第119件·10-06 更新〕当年那句「refresh/buyTaskNum/upgrade/del/giveUp 一律不接」
        // 已随本批逐格作废：升级／放开／元宝刷／视频刷／买次数／开宝箱各有了自己的闸（§13 六把真实写闸），
        // 删任务与竞赛币兑换两档才是「主动不做」（卡面问号外、每轮随计划照实报，B6 收口）。
        sw("real_guild_race_take", "自动接取竞赛任务", false, { hint: RACE_TAKE_HINT }),
        // [第119件·定案 G/I·10-06 用户点名接力] 「优先接自家号放出来的任务」：意愿格，不花钱、独立说话，
        //   不受升级/刷新任何一把管（§5.1 门关锁子格末条）。读取方＝本卡 DTO 那句接力账说明
        //   （`capabilities.js`）；能不能接仍以每一遍现读的同步态为准——接力表只当线索，不是事实源。
        // [10-07 用户实屏裁定] 与「升完就放」互斥：一个号只管一个方向（机制照 09-25 加速卡先例，
        //   `exclusiveWith`＋`exclusiveNote`；保存那一路由 `clearExclusiveRival` 把对方落回关）。
        sw("race_relay_take", "优先接自家号放出来的任务", false, {
          hint: RACE_RELAY_TAKE_HINT,
          exclusiveWith: "guild.guild_race.race_upgrade_give_up",
          exclusiveNote: RACE_ROLE_EXCLUSIVE_NOTE,
        }),
        // [任务优先级·09-18 客户点名] 客户原话：「设置一个优先竞赛的开关。**开了之后，竞赛任务最优先**」。
        // 开了就把「竞赛」这一段提到每轮最前面（竞赛任务带时限、占当日接取名额，先跑它更不容易错过）；
        // 默认关＝与今天逐字一致（铁律 5）。次序口径与测试见 server/src/game/run-priority.js。
        sw("race_first", "竞赛任务最优先", false, { hint: "每次开头先跑竞赛，再干别的。" }),
        num("race_normal_min", "普通任务最低分", 0, { min: 0, max: 30, hint: "低于这个分不接（0＝不限）。" }),
        num("race_normal_max", "普通任务最高分", 0, { min: 0, max: 30, hint: "高于这个分不接（0＝不限）。两头都填 0＝这一类先不接。" }),
        num("race_gold_min", "原金任务最低分", 0, { min: 0, max: 30, hint: "低于这个分不接（0＝不限）。" }),
        num("race_gold_max", "原金任务最高分", 0, { min: 0, max: 30, hint: "高于这个分不接（0＝不限）。两头都填 0＝这一类先不接。" }),
        // 〔10-07 追记24 用户令「有些号只想接某一些花的任务／培育、升级鲜花、好友偷花这一类，需要设计并打通」〕
        //   接取挑单三格：花朵白/黑名单（对「指定收获」那类按任务上的花号筛；3034 挂花瓶号读不出花，不吃）
        //   ＋类型白名单（现读 13 类官方名单）。**空勾＝不设这条**（照旧），黑名单优先。
        //   读取方＝`planGuildRaceWrites` 接取闸（guild-race-cycle.js 的 RACE_TASK_FLOWER_*／RACE_TASK_TYPE_NOT_CHOSEN）。
        multi("race_task_flower_allow", "只接这些花的任务", [], {
          source: "flowers",
          emptyNote: "一个都不勾＝所有花的任务都接",
          hint: RACE_TASK_FLOWER_ALLOW_HINT,
        }),
        multi("race_task_flower_deny", "这些花的任务不接", [], {
          source: "flowers",
          emptyNote: "一个都不勾＝没有花被排除",
          hint: RACE_TASK_FLOWER_DENY_HINT,
        }),
        multi("race_task_types_allow", "只接这几类任务", [], {
          options: RACE_TASK_TYPE_OPTIONS,
          emptyNote: "一个都不勾＝不按类型挑",
          hint: RACE_TASK_TYPES_ALLOW_HINT,
        }),
        multi("race_upgrade_uids", "仅接取指定升级者（暂不生效）", []),
        // 〔10-07 凌晨 用户令：绑定要能设置、一对多、被 A 绑了就不能被 D 绑（原话带的那族字样按定案 G 不上屏）〕
        // 本格＝接收方视角的「绑定的自家号」（一对多）；被绑方→绑定方的反查唯一（写入侧挡互斥）。
        // 运行期用途：被绑方放出的升级任务在接力登记时**点名交给绑定的号接**（to_account_id）；
        // 接收方接任务时只认「点名给自己」或「公行」的放出行（createHasReleasedRelayPredicate 原有判据）。
        // ⚠️ 措辞按第119件定案 G：本面零那族字样（cell-ownership 判据⑥ 扫这里）。
        multi("bound_small_ids", "绑定的自家号", [], {
          source: "accounts",
          desc: "在这一格勾上要接你放出的升级任务的自家号（可多选）。规矩：一个号只能被一个号绑定——已经被别的号绑走的，在这里勾不上（会提示被谁绑着）。"
            + "绑好之后：你放出的升级任务点名交给绑定的号，别人不接；没绑的放出＝全公会谁先接算谁。"
            + "⚠️ 影响范围就这一件事：只决定「放出去的任务点名给谁」。接任务、做任务、交任务、升级这些流程一个字都不受影响，"
            + "被绑定那边的号即便绑着，屏幕上看到的行为也和没绑时一模一样（所以那边不会有任何新按钮、新提示冒出来）。",
        }),
        num("race_take_delay", "出现后等一会儿再接", 0, { min: 0, max: 60, suffix: "秒", hint: "任务刚冒出来的头几秒不抢，像人多看一眼。填 0＝出现就接。" }),

        multi("race_purchasable_items", "可以代买的东西（买东西的任务只买勾中的）", [], {
          emptyNote: "一个都不勾＝要求去商店买东西的那两类竞赛任务一条都不接（屏上会说清为什么没接）",
          hint: RACE_PURCHASE_HINT,
          options: RACE_PURCHASABLE_OPTIONS,
        }),

        // ── 交任务（白拿分；和接取一路） ──
        sw("race_auto_finish", "自动交任务", false, { hint: RACE_FINISH_HINT }),
        // 〔10-07 归整〕「自动提交」那把的 twin（真实写）已下架；本行就是全部闸。
        sw("race_avoid_in_progress", "避开接有进度的任务（暂不生效）", false),
        // ══ 刷新族（第119件·B3 判据 10-06 落地＋本批逐格上屏；§13：三件止损格复活、档格变真读者）══
        // [第119件·B5·复活出列] `race_auto_refresh` 从报告型变意愿行（读取方＝`guild-race-refresh.js` 归一化）；
        //   旧标签「自动接取刷新任务」是报告型时代的错名（刷新不接取、只重掷手上这一条），一起改人话。
        sw("race_auto_refresh", "用元宝刷新任务", false, { hint: RACE_REFRESH_COIN_HINT }),
        sw("real_guild_race_refresh", "用元宝刷新手上的任务", false, { hint: RACE_REFRESH_COIN_HINT }),
        // [第119件·定案 F・§12.1 第 9 行] 档格复活为真读者：`refreshTask` 的档位一律从这一格取，不读客户端本地存储——
        //   官方那份只记在那台手机上，这一格替你记在这个号上，是**有意替你记住**，不是偏差。价钱与保底竞赛币从表现读。
        // 〔10-07 追记23 用户令「这里需要是复选框，可以选择多种条件」〕单选（用哪种）⇒ **多选复选框**（用哪些）；
        //   梯子语义与逐档加码写在 RACE_REFRESH_IDX_HINT；旧库存量值是字符串（normal/high8/high16），
        //   归一与渲染层都做了兼容（照旧点亮对应那一颗），见 guild-race-refresh.js 与 ConfigGroups.jsx。
        multi("race_refresh_yuanbao_idx", "用哪些元宝刷新", [], {
          options: RACE_REFRESH_IDX_OPTIONS,
          lockedWhen: "guild.guild_race.race_auto_refresh",
          hint: RACE_REFRESH_IDX_HINT,
        }),
        // [第119件·定案 F·§10 自查第 15 条] 用户点名的分数线＝**既有键** `race_refresh_take_score_min` 复活，不新造同义格。
        // [铁律 19·P4·门关⇒子格锁] 两把刷新闸都关着 ⇒ 灰显（没有可重掷的对象，线无处生效）。
        num("race_refresh_take_score_min", "刷到多少分才罢手", 0, {
          min: 0, max: 30,
          lockedWhen: ["guild.guild_race.race_auto_refresh", "guild.guild_race.race_refresh_use_ad"],
          hint: RACE_SCORE_MIN_HINT,
        }),
        // [10-07 用户实屏「买几次和刷几次是什么区别」] 旧名「每天最多刷几次」没说刷的是什么 ⇒ 点名「手上这条」。
        num("race_refresh_yuanbao_limit", "手上这条每天最多重刷几次（元宝档）", 0, { min: 0, max: 100, lockedWhen: "guild.guild_race.race_auto_refresh", hint: RACE_REFRESH_LIMIT_HINT }),
        // [10-07 用户实屏「这两个这不是一个意思吗」] 原名「元宝刷新保留线」⇒ 与升级那格成平行名（那边＝「升级后元宝至少留」）。
        num("race_refresh_yuanbao_keep", "刷新后元宝至少留", 0, { min: 0, lockedWhen: "guild.guild_race.race_auto_refresh", hint: RACE_REFRESH_KEEP_HINT }),
        // [第119件·B5] 视频档三行：`race_refresh_ad_first` 是**准入**（B3 判据：不勾＝只用元宝档，视频两格开着也不看），
        //   不只是先后顺序——卡面这句按 B3 报告 §5-2 的形状写。
        sw("race_refresh_ad_first", "先用每天免费的视频次数", false, {
          lockedWhen: "guild.guild_race.race_refresh_use_ad", hint: RACE_AD_FIRST_HINT,
        }),
        sw("race_refresh_use_ad", "看视频刷新任务（免费）", false, { hint: RACE_REFRESH_AD_HINT }),
        sw("real_guild_race_refresh_ad", "看视频刷新手上的任务", false, { hint: RACE_REFRESH_AD_HINT }),
        // [第119件·§10 自查第 1 条] 官方弹「确定刷新？」的三档情况（已升过／已有进度／满最高分档）默认都拦；越过=另勾这一格（出厂 false）。
        //   〔10-07 现读校正·改名〕旧注释写的「满最高分档不在这一格管得到（定案 J 停＋报）」**已作废**——
        //   停手档 10-06 深夜整段退役后，官方 2551 满档确认框回到自己名下（guild-race-refresh.js 那句
        //   「越过只认面板 ignore_warnings」），三档一把尺、都由这一格放开；测试「【停手档退役】满档行…」钉死。
        //   〔10-07 用户令〕旧标签「这三种情况也照样刷新」没人看得懂 ⇒ 改名并把三种点名进括号。
        sw("race_refresh_ignore_warnings", "好任务也照样重刷（升级过的、做了一半的、最高分档的）", false, {
          lockedWhen: ["guild.guild_race.race_auto_refresh", "guild.guild_race.race_refresh_use_ad"],
          hint: RACE_IGNORE_WARN_HINT,
        }),
        // [第119件·§13 逐格对账·10-06 本会话自查补回] 下面九格**继续留在架上**（PARKED_FIELDS 在册）：
        //   刷新这一族只有下限有意义（`race_refresh_take_score_max` 上限造了＝给客户摆没用的旋钮）；
        //   「停刷条件」四格与「刷到达标」是同一件事的两种写法（`race_refresh_stop_*`，两套分母必红）；
        //   「刷到达标后放开」两格与复活的放开闸重复（`race_refresh_give_up*`）。
        //   ⚠️ 定义与出厂值一字不动（老存档里烘着的值不许漂）——这是 `PARKED_FIELDS` 那份名单的立档纪律。
        num("race_refresh_take_score_max", "刷料接收上限分数（暂不生效）", 0, { min: 0, max: 30 }),
        num("race_refresh_yuanbao_max", "元宝刷新上限（暂不生效）", 0, { min: 0, max: 100 }),
        num("race_refresh_stop_origin_gold_score", "停止条件：原金分数 ≥（暂不生效）", 0, { min: 0, max: 30 }),
        multi("race_refresh_stop_flower_ids", "停止条件：指定花朵种植任务（暂不生效）", [], { source: "flowers" }),
        num("race_refresh_stop_score", "停止条件：当前分数 ≥（暂不生效）", 0, { min: 0, max: 30 }),
        sw("race_refresh_stop_not_vip_shop", "非VIP商店购买任务（暂不生效）", false),
        sw("race_refresh_give_up", "刷到达标任务后放弃回任务池（暂不生效）", false),
        multi("race_refresh_give_up_upgrade_flower_ids", "升级条件：指定花朵种植任务（暂不生效）", [], { source: "flowers" }),
        num("race_refresh_give_up_upgrade_score", "升级条件：当前分数 ≥（暂不生效）", 0, { min: 0, max: 30 }),
        // [B4 一期] 「自动提交」是意愿，这一条是允许发 fmlRace.finishTask 的真实写闸（同样 def=false）。
        // 只有镜像两边（25.110 手上记录 + 25.114 行）的 finishCnt 都到 targetCnt 才发，没达标一条不发。
        sw("real_guild_race_finish", "自动提交竞赛任务", false, { hint: RACE_FINISH_HINT }),
        // ══ 升级与放开（第119件·定案 A/G・B2 判据已接）══
        // [§13] 旧格 `race_auto_do_task` 继续留在架上：它想表达的「自动执行任务」就是这一整批在做的事，
        //   再留一格只会让人以为还有另一把总开关。
        sw("race_auto_do_task", "自动执行任务（暂不生效）", false),
        sw("race_auto_upgrade", "元宝升级任务（分数翻倍）", false, { hint: RACE_UPGRADE_HINT }),
        sw("real_guild_race_upgrade", "花元宝把任务升级", false, { hint: RACE_UPGRADE_HINT }),
        num("race_upgrade_max_per_day", "每天最多升几条", 0, { min: 0, max: 99, lockedWhen: "guild.guild_race.race_auto_upgrade", hint: RACE_UPGRADE_MAX_HINT }),
        // [10-07 用户实屏「这两个这不是一个意思吗」] 两格保留线原叫「元宝刷新保留线」/「元宝留多少不动」——
        //   看着像同一件事说两遍。实际是**两个不同花钱家庭的底线**（刷新/升级各一把，买次数故意不给第三把，
        //   派单口径见 guild-race-cycle.js 文件头）⇒ 改成平行名，各自点名行动。
        num("race_upgrade_keep_yuanbao", "升级后元宝至少留", 0, { min: 0, lockedWhen: "guild.guild_race.race_auto_upgrade", hint: RACE_UPGRADE_KEEP_HINT }),
        // [第119件·定案 G·用户 10-04 当面纠正] 原复合闸「升级后放弃任务」拆成两把独立闸：意愿用**既有键**
        //   `race_upgrade_give_up`（§10 自查第 15 条：面板早就有这一格，不新造同义键），标签改人话、与「必须先升级」脱钩；
        //   真实写另加 `real_guild_race_give_up`（def=false）。⚠️ 这一族**不受升级管**（§5.1 门关锁子格）：
        //   没升级也可以直接把手上这条放出去；「刷新」「升级」永不连带放开。
        // [10-07 用户实屏裁定] 与「优先接自家号放出来的任务」互斥：两把只能开一个，另一把锁住点不动
        //   （机制＝`exclusiveWith`＋`exclusiveNote`，保存那一路 `clearExclusiveRival` 落回对方并留痕）。
        sw("race_upgrade_give_up", "升完就放给绑定的自家号", false, {
          hint: RACE_GIVEUP_HINT,
          exclusiveWith: "guild.guild_race.race_relay_take",
          exclusiveNote: RACE_ROLE_EXCLUSIVE_NOTE,
        }),
        sw("real_guild_race_give_up", "真的把这条放出去", false, {
          hint: "这一格与「花元宝把任务升级」互不牵连：没升级也可以直接把手上这条放回公会的任务池，行上会标好是你放过的、保留已做进度。"
            + "冷却多久、这一期才入会的号为什么一条都不放、做完的为什么只能交——三条游戏的规矩写在上面「把这条放给自家号做」的问号里。",
        }),
        sel("race_upgrade_give_up_mode", "种植任务放弃规则（暂不生效）", "all", [
          { label: "全部放弃", value: "all" }, { label: "只放弃以下花朵的种植任务", value: "only" },
          { label: "不放弃以下花朵的种植任务", value: "keep" },
        ]),
        multi("race_upgrade_give_up_flower_ids", "规则花朵列表（暂不生效）", [], { source: "flowers" }),
        // [第119件·定案 D] 删任务=**主动不做**：删掉的那一行是全公会共用的一份，官方删除确认里写明「90 分钟后刷新出新任务」
        //   ＝让所有会友一起少一条可选；而且只有会长和副会长位才有这权限。两格定义与存量留在原处（不删定义），
        //   「不做」随每一轮计划照实报（收口批把这两格连同执行器那条一起进下架名单——见当月工作日志，本批不拆一半）。
        sw("race_delete_low_score", "删除指定分数范围的任务", false),
        num("race_delete_score_min", "删除分数下限（暂不生效）", 0, { min: 0, max: 30 }),
        num("race_delete_score_max", "删除分数上限（暂不生效）", 0, { min: 0, max: 30 }),
        multi("race_delete_flower_ids", "删除指定花朵（暂不生效）", [], { source: "flowers" }),
        sw("race_delete_vip_shop", "删除VIP商店购买任务", false),
        time("race_delete_time_start", "删除时间段（开始）（暂不生效）", ""), time("race_delete_time_end", "删除时间段（结束）（暂不生效）", ""),
        sw("race_keep_origin_gold", "保留原金任务（暂不生效）", false), sw("race_keep_upgraded", "保留已升级任务（暂不生效）", false),
        // ══ 宝箱与买次数（第119件·定案 A・§13：意愿变真读者＋真实写各加一把）══
        sw("race_box", "自动开竞赛宝箱", false, { hint: RACE_BOX_HINT }),
        sw("real_guild_race_box", "自动开竞赛宝箱", false, { hint: RACE_BOX_HINT }),
        // [10-07 用户实屏「买几次和刷几次是什么区别」] 买族用词统一到「接取名额」（旧名「名额用完自动买次数」里的「次数」与下面数字格的那格说法分家），
        //   与本卡提示里「接了做不动会白占一个名额」同一套词。
        sw("race_auto_buy_task", "名额用完自动买", false, { hint: RACE_BUY_HINT }),
        sw("real_guild_race_buy_num", "用元宝买接取名额", false, { hint: RACE_BUY_NUM_HINT }),
        // [第119件·定案 A] 「每天最多买几个接取名额」按**计划档 §5 格子表逐字的键**上架＝`race_buy_num_max`：
        //   运行期读取方（`guild-race-cycle.js` 的 `normalizeRealGuildRaceConfig.buyMaxPerDay`，C-exec 已落地）
        //   读的就是这一把键；§13 表把这一格写成「复活 race_buy_task_max」＝同一只旋钮的两种说法，两行打架时
        //   **以执行器真实读取的键为准**（勾了的格子必须真有人读，否则＝假开关，铁律 8 判死的形状；差异写进报告 §5）。
        //   旧键 `race_buy_task_max` 连同定义一起回下架名单（存量值不动，见 PARKED_FIELDS 第119件段）。
        num("race_buy_num_max", "每天最多买几个接取名额", 0, { min: 0, max: 20, lockedWhen: "guild.guild_race.race_auto_buy_task", hint: RACE_BUY_MAX_HINT }),
        num("race_buy_task_max", "购买上限（暂不生效）", 0, { min: 0, max: 20 }),
        // [第119件·定案 C·10-04 用户原话「可以买，但必须留一格让客户自己圈定可以买什么」] 成员制多选（先例＝培育选花／花坊币档位）：
        //   **空勾选＝要求去商店买东西的那两类竞赛任务直接不接**；每一次真买落一条账（买了几件／花了什么／为哪一条）。
        //   候选池＝官方材料商店上架货（物品号＋`c_item` 中文名现读）；「到贵宾商店买」那一类本仓暂无通道，勾了也不相
        //   （读取方＝`race-goal-map.js` 的白名单闸；真买形状待实服取证，逐条见报告）。
        num("race_priority", "任务优先级（暂不生效）", 1, { min: 1, max: 5 }),
        sw("race_use_speed_card", "种植任务用加速卡", false),
        num("race_speed_card_clear_non_task", "加速卡清空非任务土地（暂不生效）", 0, { min: 0, max: 36 }),
        sw("race_video_speed", "使用视频加速快速完成任务", false),
        num("race_video_speed_threshold", "所有任务花剩余生长时间超过此值才触发（暂不生效）", 30, { min: 0, max: 600, suffix: "分钟" }),
        sw("race_video_speed_allow_non_task", "允许含非任务花的土地一起加速（暂不生效）", false),
        sel("race_land_harvest_mode", "收获模式（暂不生效）", "all", [
          { label: "全部收获", value: "all" }, { label: "只收获以下花朵", value: "include" }, { label: "不收获以下花朵", value: "exclude" },
        ]),
        multi("race_land_harvest_include_ids", "要收的花朵（暂不生效）", [], { source: "flowers" }),
        multi("race_land_harvest_exclude_ids", "不收的花朵（暂不生效）", [], { source: "flowers" }),
      ]},
      { id: "guild_like", label: "公会花展点赞", desc: "去公会成员的花展上点一个赞。⚠️ 这件事在游戏里叫「花展」，每天最多赞 10 次、同一个人每周只能赞 1 次，而且赞出去撤不回来（游戏原文「点赞后不可撤回」）；它不给你任何奖励——只是社交动作，只改对方花展上的赞数。", fields: [
        sw("enabled", "开关", false),
        // 真实写闸（def=false，铁律 5 零例外）：「看着它列计划」与「真去别人的花展上留个赞」必须分得开。
        sw("real_guild_show_like", "自动去点赞", false, {
          hint: "开着时：每次最多赞一位，赞出去撤不回来（游戏里没有撤回这个按钮）。"
            + "「今天总共能赞几次」与「这周赞过谁」这两格读不到时，它一个都不赞。",
        }),
      ]},
      { id: "guild_redpacket", label: "公会红包", desc: "本项当前不生效：这个玩法脚本还没接，打开也不会有任何动作。", fields: [sw("enabled", "开关", false)] },
      { id: "energy_forest", label: "能量森林", desc: "自动收取公会能量森林能量。", fields: [// [44D] 原来是死槽 ⇒ 常量上页面（默认 3＝FOREST_ACTION_CAP）。
        num("forest_max_types_per_cycle", "每分钟最多收几类能量", 3, { min: 1, max: 10 }),
        sw("enabled", "开关", false)] },
    ],
  },
  {
    id: "activity",
    label: "活动",
    modules: [
      // [W8·09-18] 云游商人一期 = **只做「到期领取」**（官方 `peddler.investAccount`，零参数，不扣任何东西）。
      // desc 按铁律 8 逐字改对：**元宝投入与续投永不自动做**——官方 `invest` 的第 1 期前置就是
      // `checkItemEnough(1, principal)`（物品 1 ＝ 元宝，真查本金够不够），第 >1 期是「把上一期本息
      // 继续押进去」，两条都动真钱，属红线（判据出处见 peddler-cycle.js 文件头）。
      // 旧的三格一并删掉，每一格都删得有理由，不留「点了没用的假开关」：
      //   · `profit_strategy`（含 `reinvest` 选项）＝ **把红线做成了选项**（官方 4686 文案逐字
      //     「继续投资，将以第${period}期收益作为本金」），而脚本永远不续投 ⇒ 谁点它谁被骗；
      //   · `yuanbao_reserve`（元宝保留 1000）＝ 名字就在说「脚本会按保留额花元宝」，与本期口径直接矛盾；
      //   · `auto_restart`（失败重启）＝ 全仓零读取方，在本功能里没有任何后果。
      // 存量账号存档里可能存过 `reinvest`：由 `peddler-cycle.js` 的 `normalizeRealPeddlerConfig`
      // 按**非法值保守落 claim_only**（只领取），并每轮如实回报一次「旧值已忽略」，不是静默丢弃。
      { id: "peddler", label: "云游商人", desc: "周一开放时自动领取到期收益；元宝投入与续投永不自动做。", fields: [
        sw("enabled", "开关", false),
        sw("real_peddler_claim", "自动领取到期收益", false),
      ]},
      { id: "act_flower_note", label: "花笺集芳", desc: "本项当前不生效：半月活动的白拿档统一在「半月四活动（白拿档）」那张卡里做，这一格打开不会有额外动作。", fields: [sw("enabled", "开关", false)] },
      // [09-29 二期] 死卡复活成真卡：莳花纪闻（半月活动之一，本期在开）。每条会动东西的通道
      // 都各配一把真实写闸（铁律 5：一律默认关），代价逐字写在闸名上（铁律 8 第 3 条）。
      // [09-29 用户追补] 分数宝箱从「半月四活动（白拿档）」迁到本卡（用户：「上面的进度奖励也需要能领取」，
      // 界面就该在活动自己这张卡上）；元宝刷单接上留开关（用户：「这里还能靠元宝刷新，这个也要对接上留一个开关」）。
      // [09-30 用户点名「按钮名称和描述太粗糙，应该精简名称＋后面详细解释」] 名称一律收成短词，
      // 代价与机制全部写进 `hint`（界面既有标准：09-25 口径——描述进控件右边的「?」弹层，不占行）。
      // ★[2026-10-02 用户实屏点名·本段是唯一出处]「是否启用就应该包含了 自动交订单和自动领宝箱
      //   商店自动买货和每遍买几格不要，不替客户进行购买」⇒
      //   · 交订单与领宝箱两把子闸**并入卡头**：开了这张卡就做，不再要第二道勾（四格已进 PARKED_FIELDS，
      //     上面那段登记里写清了合并的真实代价：**已开卡的号从此直接开始扣花交单**）；
      //   · 商店那一整条通道退役：脚本不替客户在任何商店下单，残页只攒不花。
      //   留下的三格是「交单怎么扣花」（花朵留底）与「要不要花元宝跳过冷却」（刷新＋当日预算）——
      //   都不是"要不要做交单"这道授权，而是做的时候的边界，所以留在卡面上。
      { id: "act_flower_news", label: "莳花纪闻", desc: "半月活动「莳花纪闻」：打开这张卡就自动交订单、自动领进度宝箱。⚠️ 交订单每一单都会从你背包里真扣掉它要的花（换回活动残页、金币与经验），怕把主力花交光就在「花朵留底」填个数。商店买货脚本不替你做，残页只攒不花，想买请自己在游戏里点。订单冷却时是否花元宝立即刷新，由下面那把闸单独说了算，默认不花。", fields: [
        sw("enabled", "开关", false),
        // ★[2026-10-02] 下面四格**只摘渲染**（进 PARKED_FIELDS）：定义与出厂值一字不动、存量零迁移。
        //   前两格的动作并入卡头那把「是否启用」，后两格随商店那条通道一起退役（运行期读取点同批删净）。
        sw("real_act_story_deliver", "自动交订单（已下线：打开上面「是否启用」就交单）", false, { hint: "拿背包里的花去交这一期的活动订单：每单真扣掉这一单要的花，换来花史残页、金币与经验（经验每号最多 400 单）。不想扣花就别勾。" }),
        num("story_flower_reserve", "花朵留底", 0, { min: 0, max: 999, hint: "每种花在背包里至少保留几朵，这几朵绝不参与交单；0＝不留，够单就交。怕把主力花交光就填个数。" }),
        // [第128件·2026-10-05 用户点名「这个莳花记闻。设置个上限。3800单就做完了。有的人想要金币会继续做」]
        //   上限按**活动积分**计（与卡上进度宝箱 1000/2100/3800 同一把尺，也是客户在活动页看到的那个数）：
        //   用户嘴里的「3800 单」＝顶档宝箱的 3800 分——分到了，宝箱拿全，交单对他就只剩花不值钱。
        //   0＝不限＝老行为逐字零漂移（想要金币的人继续交）。到限后：交单停、元宝刷单也停
        //   （刷单就是为了接新单继续交，到限再刷就是白花元宝）；**领宝箱不受影响**。
        num("story_score_limit", "交单上限（积分）", 0, {
          min: 0, max: 99999,
          hint: "0＝不限：有花就一直交（每单换回花史残页、金币与经验），想要金币的人保持 0；"
            + "填个数（比如 3800＝顶档进度宝箱的分数）：本期活动分一到这个数就停止交单，"
            + "也停止花元宝刷单（刷单就是为了继续交），进度宝箱照领。到没到线读的是活动页上那个分数。",
        }),
        sw("real_act_story_box", "自动领宝箱（已下线：打开上面「是否启用」就领）", false, { hint: "活动页顶上那排进度宝箱（1000/2100/3800 分）：积分到档就点领取，零消耗，到多少领多少。" }),
        sw("real_act_story_shop", "商店自动买货（已下线：脚本不替客户购买）", false, { hint: "只花交订单挣来的花史残页去「莳花商店」买货（加速卡、水滴这类）；一分元宝不动，残页不够就不点。" }),
        num("story_shop_per_cycle", "每次买几格（已下线：随「商店自动买货」一起）", 1, { min: 1, max: 4, hint: "商店一次最多买几种货（一共四格）；默认 1，攒了残页稍后再买下一格。" }),
        sw("real_act_story_refresh", "元宝刷新订单", false, { hint: "订单交完有约 25 分钟冷却：勾了这条会花元宝跳过冷却、立刻接新单继续交。价格＝剩余冷却每 5 分钟 1 元宝（不足 5 分钟按 1 算，剩 16 分钟就是 4 元宝）。不勾就等冷却自然到点，不花一分元宝。" }),
        num("story_refresh_daily_budget", "当天刷单预算", 0, { min: 0, max: 500, hint: "一天最多花多少元宝刷订单，用满当天自动改回等冷却；0＝就算开了上面那把刷新，也一分元宝不花。" }),
      ]},
      { id: "act_fish_granary", label: "丰仓鱼干", desc: "自动参与丰仓鱼干活动。", fields: [
        sw("enabled", "开关", false), sw("fast_game", "快速游戏（暂不生效）", false),
        sw("show_result", "显示结果（暂不生效）", false), sw("fail_restart", "失败重启（暂不生效）", false),
      ]},
      { id: "act_bubble", label: "奇妙泡泡", desc: "本项当前不生效：这个活动脚本还没接（历次活动的残留卡），打开也不会有动作。", fields: [sw("enabled", "开关", false)] },
      { id: "act_flower_garden", label: "花香满园", desc: "自动参与花香满园活动。", fields: [sw("enabled", "开关", false)] },
      // ── 荣誉殿认的那六件「每周小活动」（客户 09-14 18:16「每周也有一个小活动，四五个循环」）──
      // [W20·09-18] 这六张卡原来只有一格 `enabled`、**零读取方**（勾了没反应＝假开关）。
      // 现在两格都是真判据（读取方＝weekly-box-cycle.js 的 normalizeRealWeeklyBoxConfig）：
      //   `enabled`   ＝「这一族我关心」（意愿闸）；
      //   `claim_box` ＝「真去开」（真实写闸，def=false，铁律 5 零例外）。
      // ★ desc 一字不落地改成实话：**本卡只做「开已经攒到的奖励宝箱」**，玩游戏本身（消消乐/2048/
      //   做甜糕/引线/解棋盘/合成）是真人玩法、还要烧体力，脚本一律不做（铁律 8 第 4 条：约束提前说）。
      //   `claim_box` 这一格是**零消耗**：箱子开出来的东西进背包，不开反而会在活动展示期结束后
      //   按 1:180 折成金币（官方帮助逐字），所以「不开才亏」。
      { id: "act_fish_fun", label: "鱼乐无穷", desc: "只开这一期已经攒到的奖励宝箱（不花任何东西）；玩 2048 本身要真人操作、要花体力，脚本不做。", fields: [
        sw("enabled", "开关", false),
        sw("claim_box", "自动开奖励宝箱", false),
      ]},
      { id: "act_flower_story", label: "花漾物语", desc: "只开这一期已经攒到的奖励宝箱（不花任何东西）；消消乐本身要真人操作、要花体力，脚本不做。", fields: [
        sw("enabled", "开关", false),
        sw("claim_box", "自动开奖励宝箱", false),
      ]},
      { id: "act_cat_match", label: "喵铺消消", desc: "只领这一期已经攒到的奖励宝箱；替你把棋盘玩掉、用道具、买体力这些本卡不做。", fields: [
        sw("enabled", "开关", false), sw("auto_game", "自动游戏（暂不生效）", false),
        sw("claim_energy", "体力领取（暂不生效）", false), sw("game_reward_box", "游戏奖励箱（暂不生效）", false),
        sw("total_box", "累计宝箱（暂不生效）", false),
        sw("claim_box", "自动开奖励宝箱", false),
        sel("solve_mode", "求解模式（暂不生效）", "fast", [
          { label: "高分慢速模式", value: "slow" }, { label: "快速模式", value: "fast" },
        ]),
        sel("game_speed", "游戏倍速（暂不生效）", "normal", [
          { label: "普通（1体力/步）", value: "normal" }, { label: "快速（2体力/步）", value: "fast" },
        ]),
      ]},
      { id: "act_red_rain", label: "红包雨", desc: "本项当前不生效：这个活动脚本还没接（历次活动的残留卡），打开也不会有动作。", fields: [sw("enabled", "开关", false)] },
      { id: "act_welcome", label: "迎新接福", desc: "本项当前不生效：这个活动脚本还没接（历次活动的残留卡），打开也不会有动作。", fields: [sw("enabled", "开关", false)] },
      { id: "act_call_zi", label: "为紫打call", desc: "本项当前不生效：这个活动脚本还没接（历次活动的残留卡），打开也不会有动作。", fields: [sw("enabled", "开关", false)] },
      { id: "act_money_tree", label: "摇钱树", desc: "本项当前不生效：这个活动脚本还没接（历次活动的残留卡），打开也不会有动作。", fields: [sw("enabled", "开关", false)] },
      { id: "act_lantern", label: "元宵灯谜", desc: "本项当前不生效：这个活动脚本还没接（历次活动的残留卡），打开也不会有动作。", fields: [sw("enabled", "开关", false)] },
      { id: "act_cake", label: "香卉甜糕", desc: "只开这一期已经攒到的奖励宝箱（不花任何东西）；做甜糕本身要真人操作、要花体力，脚本不做。", fields: [
        sw("enabled", "开关", false),
        sw("claim_box", "自动开奖励宝箱", false),
      ]},
      { id: "act_field", label: "田园奇趣", desc: "只开这一期已经攒到的奖励宝箱；合成棋盘、交订单、买卖棋子这些要花材料或棋子的动作脚本不做。", fields: [
        sw("enabled", "开关", false),
        sw("claim_box", "自动开奖励宝箱", false),
      ]},
      { id: "act_jade_vase", label: "碎玉成瓶", desc: "本项当前不生效：半月活动的白拿档统一在「半月四活动（白拿档）」那张卡里做，这一格打开不会有额外动作。", fields: [sw("enabled", "开关", false)] },
      { id: "act_home", label: "助力家业", desc: "本项当前不生效：这个活动脚本还没接（历次活动的残留卡），打开也不会有动作。", fields: [sw("enabled", "开关", false)] },
      { id: "act_thread", label: "梳丝引线", desc: "只开这一期已经攒到的奖励宝箱（不花任何东西）；引线玩法本身要真人操作、要花体力，脚本不做。", fields: [
        sw("enabled", "开关", false),
        sw("claim_box", "自动开奖励宝箱", false),
      ]},
      { id: "act_honor", label: "荣誉殿", desc: "本项当前不生效：荣誉殿点赞脚本不代做（点赞是社交动作，而且官方不给任何奖励）。", fields: [sw("enabled", "开关", false)] },
    ],
  },
];

// 把「下架」与「账号与节奏」两份归属落到定义上：`/meta` 随字段一起下发这两个旗标，
// 前端只认 `parked`／`cadence` 两个布尔，**绝不在前端再抄一份名单**（两份名单迟早分叉）。
// ⚠️ 这里只加旗标，**不删字段、不改默认值、不动任何一格的值**——下架是渲染层的事。
const CADENCE_MODULES = new Set([
  "basic.anti_detect", "basic.reconnect", "basic.guild_race_monitor",
  // 〔2026-10-13〕「出口网络连坐」也归这一节：它不属于任何一张功能卡（连手动点「启动」都要过），
  //   又不许挂到「异常自动复工」那三格上（第147件把那一组逐字钉死了）。不归有主的一节就会掉进「其他设置」，
  //   而那一桶的目标是 0。
  "basic.egress_guard",
  // [第22件·2026-09-23] 「脚本永远会做的三件事」也进「账号与节奏」那一节：
  //   它讲的就是账号的节奏与底线，与防封节奏同一节读最顺；而且这一桶是"有主的家"，
  //   不会掉进「未归类（待收口）」——那一桶的目标是 0（`hosting-open-all` 当场就会红）。
  "basic.always_on",
]);
for (const group of SCRIPT_GROUPS) {
  for (const mod of group.modules || []) {
    const moduleKey = group.id + "." + mod.id;
    if (isParkedModule(moduleKey)) mod.parked = true;
    if (CADENCE_MODULES.has(moduleKey)) mod.cadence = true;
    for (const field of mod.fields || []) {
      if (isParkedField(moduleKey + "." + field.key)) field.parked = true;
    }
  }
}

export const ALL_MODULES = SCRIPT_GROUPS.flatMap((g) => g.modules.map((m) => ({ ...m, group: g.id })));

/**
 * [09-16 深夜·用户当面拍板「手机端设置要跟电脑端的一致」] 设置能改什么的正面清单＝schema 全部路径。
 * 电脑端「保存配置」写的就是这一整棵树（PUT /config 全树覆盖）；手机端单字段保存放行的面与之完全相同，
 * 不多一格、不少一格。白名单从这张表推导，不手抄第二份清单（同 capabilityEditableSettingKeys 的家规）。
 * 09-16 傍晚那版白名单只放「卡面显示出来的行」，防封节奏等卡面外字段进不去——那是「设置藏在 35 张卡里」
 * 那一版的过渡口径，用户看了不满意，已由独立设置页取代。
 */
let settingSchemaPathsCache = null;
export function settingSchemaPaths() {
  if (!settingSchemaPathsCache) {
    settingSchemaPathsCache = new Set(
      ALL_MODULES.flatMap((m) => (m.fields || []).map((f) => m.group + "." + m.id + "." + f.key)),
    );
  }
  return settingSchemaPathsCache;
}

export function defaultScriptConfig() {
  const cfg = {};
  for (const g of SCRIPT_GROUPS) {
    cfg[g.id] = {};
    for (const m of g.modules) {
      cfg[g.id][m.id] = { _label: m.label };
      for (const f of m.fields) {
        // [第22件] 只读说明行（`type: "note"`）**没有值**：不往配置里写键，免得存量配置里多出一堆 undefined。
        if (f.type === "note") continue;
        cfg[g.id][m.id][f.key] = structuredClone(f.def);
      }
    }
  }
  return cfg;
}

export function mergeDefaults(cfg) {
  const base = defaultScriptConfig();
  if (!cfg || typeof cfg !== "object") return base;
  for (const g of SCRIPT_GROUPS) {
    const groupSrc = cfg[g.id];
    if (groupSrc && typeof groupSrc === "object") {
      for (const key of Object.keys(groupSrc)) {
        if (!(key in base[g.id])) base[g.id][key] = structuredClone(groupSrc[key]);
      }
    }
    for (const m of g.modules) {
      const src = cfg[g.id]?.[m.id];
      if (src && typeof src === "object") {
        for (const key of Object.keys(src)) {
          if (!(key in base[g.id][m.id])) base[g.id][m.id][key] = structuredClone(src[key]);
        }
        for (const f of m.fields) {
          if (src[f.key] !== undefined) base[g.id][m.id][f.key] = src[f.key];
        }
      }
    }
  }
  return base;
}

export function enabledModules(cfg) {
  const out = [];
  for (const g of SCRIPT_GROUPS) {
    for (const m of g.modules) {
      if (cfg?.[g.id]?.[m.id]?.enabled) out.push({ group: g, module: m });
    }
  }
  return out;
}

/**
 * 面板设置项的中文名索引：`module.field`、`group.module.field`、以及全库唯一的裸 `field`。
 * 为什么要有它：客户屏「这些配置本轮不会生效」那一栏以前印的是 `customer_orders.cultivable_only`，
 * 一句工程路径对客户等于没说；名字必须取面板同一份 schema，另抄一张表就一定漏。
 */
let settingLabelIndex = null;
function ensureSettingLabelIndex() {
  if (settingLabelIndex) return settingLabelIndex;
  const paths = new Map();
  const options = new Map();
  const fieldAlone = new Map();
  for (const m of ALL_MODULES) {
    paths.set(m.id, m.label);
    paths.set(m.group + "." + m.id, m.label);
    for (const f of m.fields || []) {
      const label = m.label + " · " + f.label;
      paths.set(m.id + "." + f.key, label);
      paths.set(m.group + "." + m.id + "." + f.key, label);
      for (const o of f.options || []) options.set(m.id + "." + f.key + "=" + o.value, o.label);
      // [第47件] 多选格子按 `source` 从 meta 取选项（如培育选花模式的 `cultivate_sources`）——
      //   这些值也要能在保存回执里翻成人话（run 166 现读：屏上曾印「flower_art,main_task」英文）。
      //   唯一出处仍是各 SOURCE_OPTIONS 常量，这里只是把同一张表登记进值→中文索引。
      for (const o of (MULTI_SOURCE_OPTIONS[f.source] || [])) options.set(m.id + "." + f.key + "=" + o.value, o.label);
      if (fieldAlone.has(f.key)) { if (fieldAlone.get(f.key) !== label) fieldAlone.set(f.key, ""); }
      else fieldAlone.set(f.key, label);
    }
  }
  settingLabelIndex = { paths, options, fieldAlone };
  return settingLabelIndex;
}

/** 设置路径 → 人话（`guild.guild_land.plant_mode` → 「公会土地 · 种植模式」）；查不到返回 null。 */
/** [第47件] source 名 → 选项表（与前端 `optionsForSource` 同源的常量，这里只做回执翻译登记）。 */
const MULTI_SOURCE_OPTIONS = Object.freeze({
  cultivate_sources: CULTIVATE_FOR_OPTIONS,
});

export function settingLabelZh(path) {
  const key = String(path || "").trim();
  if (!key) return null;
  const index = ensureSettingLabelIndex();
  const direct = index.paths.get(key);
  if (direct) return direct;
  const segs = key.split(".");
  if (segs.length === 1) return index.fieldAlone.get(key) || null;
  // 「组.模块.字段」写成「模块.字段」或反过来都算：取模块名在后的一段再试一次。
  const tail = segs.slice(-2).join(".");
  return index.paths.get(tail) || null;
}

/** 设置路径 + 当前选中的值 → 选项中文名（`plant_mode`=`race` → 「跟随公会任务」）；查不到返回 null。 */
export function settingOptionLabelZh(path, value) {
  const field = String(path || "").trim().split(".").slice(-2).join(".");
  const label = ensureSettingLabelIndex().options.get(field + "=" + String(value).trim());
  return label || null;
}
