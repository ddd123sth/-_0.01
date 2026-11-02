/**
 * 官方数值配置表的**唯一**挂载点。
 *
 * 背景：这些表（`c_fmlLandLvl` / `c_shop_fml` / `c_item` …）原先被判定为「离线不可得」，
 * 该结论已于 2026-09-09 推翻：官方把它们打成一张 Cocos bundle 资源 `g-data`（4,516,196B，
 * sha256 前 16 位 cb36fa78cb2842f1），表名与字段名用官方 `mo.CRYPTO.enCharCode`（逐字符 XOR）
 * 混淆。 `tools/extract-official-gdata.mjs` 从官方 CDN 拉取并与雷电设备镜像逐字节比对一致后，
 * 解码出 294 张可用表，导出的正是本挂载点登记的这几张。
 *
 * 判据仍然 fail-closed：拿到表按官方语义算，拿不到就一条都不发并显式回报缺口；
 * 「用常见值猜」等于按错误的判据向官方发包，那正是封号要撞的东西。
 *
 * 之前这套机制散在两处各写一遍（一处按 `import.meta.url` 解析、一处按进程 cwd 解析
 * `path.resolve("server/data/official-cfg")`），后者会让「从别的目录起服务」静默变成
 * 「所有表都缺」。这里收敛成一处，并且：
 *   - 未登记的表名直接抛错，不允许凭拼写动态读盘（防止有人往目录里随手丢文件当“有表”）；
 *   - 表存在但解析失败 / 不是对象 / 是空对象，都判为不可用，并留下可回报的 reason 码；
 *   - 对外只暴露**形态与计数**，绝不回表内容，避免把官方数据写进日志或面板响应。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const OFFICIAL_CFG_DIR_ENV = "GARDEN_OFFICIAL_CFG_DIR";
export const OFFICIAL_CFG_DEFAULT_DIR = path.resolve(HERE, "..", "..", "data", "official-cfg");

/** 表不可用时统一使用的缺口原因码（会进 plan.gaps / notImplemented，可被面板看见）。 */
export const OFFICIAL_CFG_GAP_REASON = "OFFICIAL_CFG_TABLE_MISSING";
/** 表已经在、动作却没接。以前两种情况共用一句「缺表」，
 * 2026-09-09 十五张表全部导出之后，那句就成了假话。 */
export const OFFICIAL_CFG_NOT_WIRED_REASON = "OFFICIAL_CFG_TABLE_READY_NOT_WIRED";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 登记表：只列**本仓库代码真的拿它做判据**的表。
 * consumers 是真实写 scope / 动作名，effect 是「有表之后会解锁什么」，
 * 这两列合起来就是补表清单的验收标准——补错文件不会让任何动作变可用。
 */
export const OFFICIAL_CFG_TABLES = Object.freeze(Object.fromEntries(Object.entries({
  c_fmlLand: {
    consumers: ["guild-unlock"],
    effect: "公会土地解锁消耗与开放序列；缺则 unlock 只报目标槽位不发请求。",
    gapField: "fmlLand.unlock",
    gapDetail: "公会土地解锁消耗与开放序列在官方表 c_fmlLand 里；本仓库挂载点上现在没有这张表（缺文件、坏 JSON 或形态不对都算没有）时一条解锁都不发。",
  },
  c_fmlLandLvl: {
    consumers: ["guild-harvest", "guild-upgrade"],
    effect: "每级满仓阈值（官方红点 stock）与升级成本 lvlCost；缺则收获降级为「服务器计数>=1 即收」、升级不发。",
    gapField: "fmlLand.upgrade",
    gapDetail: "升级成本 lvlCost 与满仓阈值 stock 在官方表 c_fmlLandLvl 里；本仓库挂载点上现在没有这张表（缺文件、坏 JSON 或形态不对都算没有）时不发升级，收获退回较宽的判据。",
  },
  c_shop_fml: {
    consumers: ["guild-shop-refresh"],
    effect: "公会商店元数据行三条真值（2026-09-11 全部进判据）：$frLimit=0 基础免费刷新次数、nrCosts=[53,50] 付费刷新价（官方在已用过一次付费后按 floor(50/2)=25 显示半价）、$unlockCost=[53,\"calGuildShopUnlock\"] 解锁下一格的消耗。缺表则刷新与解锁都判不出，一条都不刷。",
    gapField: "shopFmlUsr.refresh",
    gapDetail: "公会商店的免费刷新基础次数（$frLimit）、付费刷新价目（nrCosts）与解锁报价（$unlockCost）都在官方表 c_shop_fml 的元数据行里；本仓库挂载点上现在没有这张表（缺文件、坏 JSON 或形态不对都算没有）时宁可让货架烂着也不发。",
  },
  c_item: {
    consumers: ["guild-shop-buy"],
    effect: "物品中文名 -> itemId 映射；缺则面板「商品顺序」无法按名字执行（当前按折后单价升序）。",
    gapField: "guild.guild_shop.shop_item_rules",
    gapDetail: "缺 c_item 中文名到 itemId 的映射，商品顺序配置不生效，已作为缺口回报而非静默改序。",
  },
  c_task_dly: {
    consumers: ["daily-task-rewards", "daily-activity-box"],
    effect: "日常任务类型映射，以及元数据行 -1 里的活跃度宝箱档位 $boxes（2026-09-09 起就是 taskDly.recvBox 的判据来源）。",
    gapField: "c_task_dly.$boxes",
    gapDetail: "缺 c_task_dly 就同时失去两样东西：宝箱档位 $boxes（一条都不发），以及按类型枚举行。",
  },
  // [第57件·2026-09-27 用户「居民订单完成后的进度奖励也需要自动领」] 花坊任务（成就）表：
  //   组号 s＝floor(行号/1e4)，居民订单＝组 9；档位链与门槛 value、奖励内容都在这张表，
  //   `taskAch.recv` 的 id 也必须是本表真实行号（官方 UI 同款取法 `POrderFlower...`→`taskCtrl_ach.recv(t.id)`，
  //   出处 scripts/game.js @1961548；可领判据 _updateAchRedCtrl @1135866 区段逐字：progress[s] >= value 才亮领取）。
  c_task_ach: {
    consumers: ["order-resident-ach"],
    effect: "花坊任务（成就）每组的档位行号、达标阈值 value 与奖励内容；居民订单进度奖励领取（gs.taskAch.recv）的 id 与判据全出自这张表——缺表一条都不发。",
    gapField: "c_task_ach.$classifications",
    gapDetail: "缺 c_task_ach 就拿不到真实行号与阈值（raw 导出的行号/数值是混淆态，不得当判据），居民订单进度奖励一条都不发。",
  },
  c_sign: {
    consumers: ["daily-sign"],
    effect: "签到连续档位奖励阈值；缺则只签当日一次，不领档位奖励。",
    gapField: "sign.recvGradeRwd",
    gapDetail: "档位阈值在官方表 c_sign 里；本仓库挂载点上现在没有这张表（缺文件、坏 JSON 或形态不对都算没有）时只签当日一次，不领档位奖励。",
  },
  c_gameCfg: {
    consumers: ["free-water-recv", "land-speedfree"],
    effect: "全局开关与时间窗（如限时水滴 freeWaterTime）；缺则限时水滴不接。免费档催熟的窗口也在这张表里：$freeSpeedUp（今天实读 60 秒），表读不到时退回 60 秒出厂值。",
    gapField: "freeWater.recv",
    gapDetail: "限时水滴需要 c_gameCfg.$freeWaterTime 时间窗。",
  },
  c_shop_giftbag: {
    // [第103件·2026-10-02 用户点名「礼包商城那个免费元宝礼包给我对接上」] 这张表从「零消费方」变有了读它的人：
    // 执行器 `giftbag-ad-cycle.js` 按官方 `getContentList` 的过滤式子筛出**带 shareId 且两份充值价格号都没有**
    // 的行（现读全表 20 行只有 id=1 满足 ⇒ 「免费元宝礼包」），再从同一行取 `dLimit[0]`（每天几次）、
    // `cd`（两次之间隔多久）、`shareId`（发哪一条点位）、`items[已领次数]`（这一档标着什么，只上屏报数）。
    // ⚠️ 带 `rchgId` 的那 19 档＝花充值来的元宝/人民币，**一行都不碰**（真钱红线；本仓也从未接过 `shopGiftbag.buy`）。
    // 旧措辞「缺则无法判定哪一项是零成本免费礼包，礼包购买不接」是 09-18 的账：当时确实判不出，
    // 现在判据＝表上那两个式子（不是猜价格），所以「哪一项零成本」有出处了——但**买的那一支仍然没接**，
    // 接的只有「看广告免费领」这一档（用户点名的就是它）。
    consumers: ["giftbag-free-yuanbao"],
    effect: "礼包商城 20 行（本仓只消费 1 行）：行 1「免费元宝礼包」现读 shareId=8、dLimit=[\"4\"]、cd=7200、"
      + "items=[[1,5],[1,6],[1,7],[1,8]]（物品号 1 在 c_item 现读＝元宝；四档＝今天第 1/2/3/4 次各给哪一档，"
      + "官方展示式子 common@1923684 逐字 `if(n.shareId){u.push(h[hasBuy])}`）。其余 19 行全带 rchgId ⇒ 一律不读不写。",
    gapField: "basic.giftbag_shop.enabled",
    gapDetail: "缺 c_shop_giftbag 就不知道这一档每天让领几次、隔多久、发哪个点位号 ⇒ 礼包商城这一档一次都不发"
      + "（几个数只从这张表读，不写在代码里；真上限在服务器，读不到表时宁可全停）。",
  },
  c_fml: {
    consumers: [],
    effect: "公会通用参数（如摸花每日上限 $likeNum、分享槽位 $shareMax）；缺则摸花/分享的剩余次数算不出来。",
    gapField: "fmlTot.cfg",
    gapDetail: "摸花与分享的每日次数上限在官方表 c_fml 的元数据行里；本仓库挂载点上现在没有这张表（缺文件、坏 JSON 或形态不对都算没有）时一条领取都不发。",
  },
  c_fmlPos: {
    consumers: ["forest-collect"],
    effect: "职位权限 p_forest 是官方 isForestOpen 的第二条前置；2026-09-11 实算 5 个职位（会长/副会长/理事/菁英/成员）p_forest 全为 1 ⇒ 这一条对普通成员不拦人，真正拦人的是公会等级门槛。",
    gapField: "fmlForest.openGate",
    gapDetail: "森林是否开放的官方前置之一（c_fmlPos.p_forest）缺表，已改以更直接事实替代。",
  },
  c_flowerArt: {
    // [W19·09-18 花瓶图鉴奖励接线] 消费方回填：vase-album-cycle.js 真读这张表的 `vase` 列
    //（「这一件成品属于哪只花瓶」＝领奖实参的口径来源）与 `artExpAdd` 列（只用于播报金币数）。
    // 表本身是硬闸门：读不到就认不出成品属于哪只花瓶，一份奖都不领。
    consumers: ["plant", "vase-album-recv"],
    effect: "顾客订单要的是花艺成品 artId，本表给出它的三朵配花；有表才能把「顾客要一个成品」翻译成「该种哪几种花」。另：`vase` 列＝这件成品属于哪只花瓶（花瓶图鉴奖励发出去的那一格用它），`artExpAdd` 列＝官方界面在首做奖励飘字里显示的数量（只用于播报）。",
    gapField: "usrLand.plant.customerArt",
    gapDetail: "缺 c_flowerArt 时顾客订单的花艺成品无法换算成种花需求，只按居民/宫廷的直接需求种花；花瓶图鉴奖励也认不出成品属于哪只花瓶，一份都不领。",
  },
  c_flower: {
    // [W14·09-18 花市接线] 消费方回填：flower-market-cycle.js 真读这张表的两列——
    // `sellRange`（三档价格：买家看到的单价必须**原样命中**其中一档，否则整格跳过）与 `colorType`
    // （面板「扫货品质」对表）。现读 588/588 行都带 len=3 的 sellRange。
    consumers: ["market-buy"],
    effect: "每朵花的培育代价 culCost（四格＝药/肥/土/光各一种）、耗时 culTime、产出 exp/gld、以及它对应的种子 seedId。有表才算得出「解锁这朵还没培育出来的花要花什么」，培育执行器才有判据；2026-09-09 18:15 已证实还原后 588/588 行的材料全部命中 c_item。",
    gapField: "cultivate.cultivate.cost",
    gapDetail: "缺 c_flower 就算不出培育代价（材料/时间/金币），培育一条都不发。旧结论「83 个材料 id 查无此行 ⇒ 代价不闭合」是读到未还原的 raw 导出造成的误判，已作废。",
  },
  c_flowerLvl: {
    consumers: ["cultivate-upgrade"],
    effect: "每朵花的等级行：直配主键=花id+两位等级（升到该级要吃这朵花自己的道具 lvlUpCost=[花id-1000, 数量] 与金币 gldCost），5 位主键是该花的公式基准行，元行 -1 里的 $lvlMax 是满级。有表才判得出「这朵还能不能升、升一级要付什么」。",
    gapField: "cultivate.upgrade",
    gapDetail: "缺 c_flowerLvl 就算不出升级代价与满级上限（官方红点判据 d.lvl != $lvlMax），鲜花升级一条都不发；27 个主线环卡在这里。",
  },
  c_flowerLvlCfg: {
    consumers: ["cultivate-upgrade"],
    effect: "通用成长表（实算 20 级）：官方 getFlowerLvlCfg 在直配行缺失时用它 + 花基准行按 Math.round(基准*(目标列/第1级列)) 现算 gldCost/cd，lvlUpCost 取本表数量。同时它也是「$lvlMax 有没有读错成 raw」的结构对照。",
    gapField: "cultivate.upgrade.formula",
    gapDetail: "缺 c_flowerLvlCfg 时，没有直配行的花算不出升级代价，那几朵一条都不发。",
  },
  c_flowerRack: {
    // [v6 C1 2026-09-28] 补登记 rack-unlock：花架解锁的花费判据（阶段行 unlockCost=[11,金币数]，
    // 现读阶段 2＝[11,2000]、阶段 3＝[11,10000]）本来就只从这张表取（readFlowerRackStands），
    // 保留金币新闸的「要花」一项也走同一条现读——登记补上，消掉「表在用、名册没写」的账实不符。
    consumers: ["rack-sell", "rack-recv", "rack-unlock"],
    effect: "花架规则：元行 -1 里的 \$sellTime（每朵卖多久，实算 240 秒）与 \$sellNum（单次上架上限，实算 12 朵）是官方 getRackState 三态与上架数量的唯一判据来源；阶段行的 rack 数组给出架位编号，unlockLvl/unlockCost 是「开这一阶段要几级、花多少金币」的唯一出处（解锁与保留金币闸都据它，代码里不写死数字）。",
    gapField: "flowerRack.sell",
    gapDetail: "缺 c_flowerRack 就判不出「这一架卖完了没有」，也定不了一次能上几朵，上架与收钱一条都不发；72 个主线环（花架售花 67 + 5）卡在这里。缺表时解锁同样一条不发（花费读不到＝判不了＝不发）。",
  },
  c_randomEvent: {
    // 2026-09-11 接线完成：执行器已进真实链路（写 scope random-event-do），所以这里登记消费者。
    // 表本身仍然是硬闸门——认不出 eventId 就一条都不发（官方自己也按这张表决定要不要生成 NPC）。
    consumers: ["random-event-do"],
    effect: "随机事件（和小动物互动）的合法 eventId 清单与同时在场上限 $eventMax；缺表时官方判据少一半，一条互动都不发。",
    gapField: "randomEvent.doAffair",
    gapDetail: "缺 c_randomEvent 就认不出 eventId 是不是官方有的事件（官方自己也按它决定是否生成 NPC），随机事件一条都不发。",
  },
  c_fmlForest: {
    consumers: ["forest-collect"],
    effect: "元数据行 $lvlLimit=4 是官方 FmlDefine.isForestOpen（common@2122798）三条前置里的等级门槛，2026-09-11 起由 forestGateState() 逐字复刻：三条里任何一条明确不成立就一条 collectEnergy 都不发，只有读不到状态源时才退回「服务器已下发可收能量」这条间接事实。",
    gapField: "fmlForest.lvlLimit",
    gapDetail: "森林开放的公会等级门槛（c_fmlForest.$lvlLimit）在官方表的元数据行里；本仓库挂载点上现在没有这张表（缺文件、坏 JSON 或形态不对都算没有）时无法核对官方前置，只能退回间接判据。",
  },
  c_fmlShopSkill: {
    consumers: ["guild-shop-refresh"],
    effect: "公会建设技能表：官方 ShopFmlUsrCtrl.getMaxFreeRefreshCount 把 skillType=102 的 value[0] 累加到 c_shop_fml.$frLimit 上，getMaxPaidRefreshCount 把 skillType=103 的 value[0] 累加成付费刷新上限。2026-09-11 实算 13 行：101 九行（折扣出现概率）、102 两行（id 11、12，各 +1 次免费刷新）、103 一行（id 10，官方文案写着「首次刷新半价」但代码把它当付费刷新上限用）。缺表时：没有已建技能仍可回落到基础值，一旦有已建技能就算不出加成，一条刷新都不发。",
    gapField: "shopFmlUsr.refresh.skill",
    gapDetail: "已建公会技能的刷新次数加成在官方表 c_fmlShopSkill 里；本仓库挂载点上现在没有这张表（缺文件、坏 JSON 或形态不对都算没有）且有已建技能时算不出次数，一条刷新都不发。",
  },
  c_task_main: {
    consumers: [],
    effect: "主线每一环要做什么（type/已渲染好的中文文案/阈值/下一环）。有表才能把「现在该干什么」说清：种哪种花、买什么材料、还差几步。",
    gapField: "taskTot.main.curTaskId",
    gapDetail: "缺 c_task_main 时主线只能报任务号，说不出这一环要什么，也不会据此调整种花选择。",
  },
  c_task_type: {
    consumers: ["daily-task-rewards"],
    effect: "任务类型 id -> 处理器 code 与文案模板（日常/周常/主线任务类型名的共同权威来源）。2026-09-09 实算：主线 700 环用到的 27 个 type 全部能在本表查到 code，此前「主线 type 不在这张表的 id 空间里」的结论是没还原 g-data 数值偏移造成的误判；主线能力表因此改以官方 code 为键。",
    gapField: "taskTot.dly.progress",
    gapDetail: "缺表时日常任务名回落到参考站映射，未登记的类型只报编号不猜名字。",
  },
  c_farmLand: {
    // 2026-09-11：这条 consumers 早上被撤过一次，因为那时 "land-unlock" 确实是个不存在的动作
    // （自家土地解锁没有执行器、真实写名单里也没有它，被「consumers 只能是真实存在的动作名」当场抓到）。
    // 现在执行器真的落地了（land-unlock-cycle.js + 写 scope + 面板子开关 + 进程名单），才重新登记。
    // 实算依据：本表 openLvl<=29 的地块恰好 44 块，与实服 run 52 计划快照 occupancy.total=44 相等
    // ⇒ 现号（29 级）把当前等级能开的地全开完了，下一批 1045-1048 要 30 级、每块 200000 金币（不是 2 万，
    //   上一条注释抄漏了一个 0，已按表逐行核对：cost=[11,200000]）。
    consumers: ["land-unlock"],
    effect: "自家土地的开放等级与解锁费用；有表才能判断下一块该不该解、扣什么、扣多少。执行器已接，缺表时一块都不开。",
    gapField: "usrLand.unlockLand",
    gapDetail: "自家土地解锁执行器已接线但一次真实写都没发过：现号 29 级，本表 openLvl 够得着的 44 块已全部开完，下一批要 30 级、每块 200000 金币。",
  },
  c_waterwheel: {
    consumers: ["waterwheel-recv"],
    effect: "水车水桶的生成冷却、同时在场地上的桶数、每日可领上限与每次给水量；有表才知道今天还能领几桶、第几桶是广告档不该碰。",
    gapField: "waterwheel.recv",
    gapDetail: "水桶每日上限与冷却在官方表 c_waterwheel 的元数据行里；本仓库挂载点上现在没有这张表（缺文件、坏 JSON 或形态不对都算没有）时一条领取都不发，绝不按猜测次数领水。",
  },
  c_shop_cultivate: {
    consumers: ["cultivate-shop-buy", "cultivate-shop-refresh"],
    effect: "材料商店每个槽位的限购次数 bLimit 与商品 id；缺表时限额无从判断，一条购买都不发。注意 costs 这一列**不作为判据**（实服 infoMap 的货币 id 全是 11=金币，而表里 32 个 costs[0] 有 26 个在 c_item 查无）。",
    gapField: "shop_buy.buy",
    gapDetail: "每槽限购次数 bLimit 在官方表 c_shop_cultivate 里；本仓库挂载点上现在没有这张表（缺文件、坏 JSON 或形态不对都算没有）时宁可一条不买也不猜限额。",
  },
  // 2026-09-11 花坊兑换鲜花（主线缺口里最大的 5 环）取证时登记。两张表都是官方 g-data 里的真名字：
  // c_shop 是「商店模板」总表（tempId -> 规则），c_shop_item_6 是「花坊」那一家店的货。
  // ⚠️ 一手坑（本轮实测抓出）：官方 c_task_type[3012] 的 jumpTo=18，而 18 号店是**万圣节商店**；
  //    花坊的真实 tempId 是 6，出处是 c_open 里 shop_item_6 的 title=花坊 + ShopMgr.getItemIdList() 读的正是 d.tempId。
  //    照 jumpTo 去买就会往另一家店里花钱 ⇒ 本表登记的作用之一就是把这个对应关系钉死在数据里。
  c_shop: {
    // 2026-09-11：花坊执行器落地（flower-shop-cycle.js），这张表终于有主了。
    // 它唯一被读的列是 isStatic：静态店才可拿本地 c_shop_item_6 当货架清单（官方 getItemIdList 同判据）。
    consumers: ["flower-shop-buy"],
    effect: "商店模板总表：每家店的重置时刻 resetTime、自动刷新档 arTimes、是否静态店 isStatic。花坊(tempId=6) 是 isStatic=1 ⇒ 官方 ShopCtrl.getItemIdList 的判据是「服务器下发的 list 为空 且 isStatic=1」才把货单取成 c_shop_item_6 的行号（实服帧里店 6 的 list 确实为空）。",
    // gapField 全项目唯一：两张表都叫 shop.buy 会被面板按 field 去重吞掉一条（守卫 test:official-cfg 逐字管这件事）。
    gapField: "shop.staticRule",
    gapDetail: "缺 c_shop 时读不出这家店是不是静态店、什么时候重置，判不出该信本地表还是信服务器清单，花坊一条购买都不发。",
  },
  // 2026-09-11 公会地收花第一枪被服务器拒、而手机上「错误内容」印成 `[object Object]` 之后登记的**观测层表**。
  // consumers 为空是刻意的：这张表不驱动任何动作，唯一用途是把服务器给的文案号翻回官方中文，
  // 让客户时间线与管理端溯源都说得清「服务器到底说了什么」（消费方 = server/src/game/server-msg.js）。
  c_msgCode: {
    consumers: [],
    effect: "官方客户端全部提示文案的号 -> 中文模板（1408 行，形如 {text,type}）。世界服响应信封的 m 字段回的就是这个号；只输出「号 + 官方模板」，模板里的参数槽可能装玩家昵称，一律不回填服务器给的参数值。",
    gapField: "serverMsg.translate",
    gapDetail: "缺 c_msgCode 时服务器文案号只能报号、报不出字（面板与溯源会明说「本机没有官方文案表，翻不出文字」），错误仍然可见但不成人话。",
  },
  c_pearl: {
    // 2026-09-11 珍珠执行器（pearl-cycle.js）接线时登记：这张表不是锦上添花，是**没有它就一条都不能发**。
    consumers: ["pearl-daily-free", "pearl-recv", "pearl-hire"],
    effect: "珍珠玩法全部规则数值：$hireTime=7200 一单劳作多久（官方 canRecvNum 用它反推开始时刻，缺它算不出该有几颗）、$hireItem=1003 雇一发吃掉的道具（缺它连余额查哪一格都不知道）、$dailyFree=[1003,2] 每天白送的两张、$placeMax=4 采集位上限、每一格的解锁价 cost 与 mCardUnlock。",
    gapField: "pearl.hire",
    gapDetail: "雇佣耗时、雇佣消耗的道具号、每天白送几张、采集位上限都在官方表 c_pearl 的元数据行里；本仓库挂载点上现在没有这张表（缺文件、坏 JSON 或形态不对都算没有）时收与雇一条都不发，绝不按猜测常数算颗数。",
  },
  c_pearlEvent: {
    consumers: ["pearl-recv", "pearl-hire"],
    effect: "$gatherCd=180 每 180 秒算一次采集（官方「可收颗数」的除数）、$pearlId=1006 收上来的道具号（一键收的确认通道读的就是它的进账）；四行事件文案与 pearlRwd 区间只影响提示，不参与判据。",
    gapField: "pearl.gatherCd",
    gapDetail: "采集间隔与收获物道具号在官方表 c_pearlEvent 的元数据行里；本仓库挂载点上现在没有这张表（缺文件、坏 JSON 或形态不对都算没有）时算不出该收几颗，收与雇都不发。",
  },
  // [L16c·09-15 凌晨 B4 竞赛线地基] 两表随四合一勘察解码入册（真数由官方管线解出，sha 记录在工作日志）；
  // 消费方 takeTask/finishTask 尚未接写（明日采样＋首写档）——在此之前它们只被竞赛候选生成器与判据展示读。
  // [L16c-A1·09-15 凌晨] 半月四活动＋活动总表五件登记先行（解码件已入库、cfg:extract 可复现）；
  // 写动作（recvTaskRwd/recv/recvOrderRwd）未接线，consumers 到位后回填——在此之前零消费零影响。
  // [顾客订单解锁·09-15] 客人名单与主线门槛（genOrder 实参与自动拒单判据的权威来源；官方 _getCurOpenNpcIds 逐字同款读法）
  c_orderCustomerNpc: {
    consumers: ["order-customer", "order-reject"],
    effect: "10 位顾客客人：$npcId 全集（genOrder 实参的候选池）＋每行 maintaskId＝该客人解锁所需主线环号（官方判据 curTaskId>=maintaskId 才出现在开店名单）；name/dialogText 只作播报人话用。"
,    gapField: "customer.npcTable",
    gapDetail: "缺这张表就凑不出 genOrder 的客人名单（官方源＝此表＋主线环号，二者缺一按不刷单处理，绝不瞎发 id）；自动拒单也缺判据（哪些客人在场决定 npcId 合法性）。",
  },
  c_orderCustomerNpcPath: {
    consumers: [], // 路径点是本地场景动画数据，服务器判据不读——登记仅备查，一期零使用
    effect: "客人走动/待机路径（客户端场景动画数据）。执行器一律不读：刷单与拒单的服务器判据只认 c_orderCustomerNpc 与镜像。"
,    gapField: "customer.npcPath",
    gapDetail: "无判据依赖，缺表不影响任何写。",
  },
  c_act: {
    // [09-18 W3 接线回填] 五个白拿动作的**身份闸**都读它：activity-cycle.js 拿服务器下发的 tmpType
    // 来这张表核对「4001~4004 是不是官方活动」，认不出就一条都不发（不是装饰性读取）。
    consumers: ["act-honey-recv", "act-note-recv", "act-note-task", "act-story-recv", "act-vase-recv"],
    effect: "每张活动一行的元数据：id/tmpType/开关与档期字段；配合 actTot 镜像（模块 23）认「当前是哪期、进行到哪」。"
,    gapField: "activity.round",
    gapDetail: "缺 c_act 认不出活动身份，一切活动自动化不发。",
  },
  c_actCyclicNote: {
    // [09-18 W3 接线回填] 花笺集芳两条白拿动作真读它：宝箱那一路与任务领奖那一路的「要多少进度」
    // 就是 D.get("c_actCyclicNote", taskId).value（官方 Red_actCyclicNote 逐字，common@58198）。
    consumers: ["act-note-recv", "act-note-task"],
    effect: "花笺集芳任务池 35 行（type 3015/3014 等语义、value 达标数、reward、weight、finishCost 金币价）＋元行 $refreshCost 每次 2 金币/$taskNum 档位/$dailyFinishTimes。"
,    gapField: "activity.cyclicNote",
    gapDetail: "缺表则任务白拿档与刷新成本都无从判断，一条不发。",
  },
  c_actCyclicStory: {
    consumers: [],
    effect: "莳花纪闻订单型玩法 4 组：items/cost（1108×N 与价）＋元行 $groupRandom/$qualityValue/$expValue/$goldValue/$refreshCd/$refreshCost/$cancelCdCost/$dailyTimes。"
,    gapField: "activity.cyclicStory",
    gapDetail: "同上；耗付费档在成本判据核对前不接。",
  },
  c_actHoney: {
    consumers: [],
    effect: "百花成蜜（客户口中蜜罐）产出权重表＋元行 $moneyId=1103/$honeyRate 五档换算。"
,    gapField: "activity.honey",
    gapDetail: "缺表算不出采集与兑换档，一期只接 recv 白拿也必须有它。",
  },
  c_flowerVase: {
    consumers: [], // 碎玉成瓶＝拼瓶玩法表（3002 配方含 23436——与 146 环同源已记工作日志）
    effect: "108 个瓶型：flowers 三层配花组、flowerVaseType/坐标缩放（UI 向，自动化不读）、$initVase/$produceTime 元行。"
,    gapField: "activity.vase",
    gapDetail: "一期只读它核对「目标瓶缺哪几朵花」，摆放坐标类字段不做判据。",
  },
  c_fmlRace: {
    consumers: ["guild-race-take"], // [B4 一期·09-15] 接线批回填：接取余额的档位 taskNum 由 guild-race-cycle.js 真读（交任务不读表）。
    effect: "公会竞赛四档（丁丙甲王）赛制参数：每档 taskNum 每日任务数、taskBuyNum 可购次数、taskCost 购一次价、robotMatch 匹配、promotionCoefficient/maintain/up/demote 升降档判据；元行 $maxLv/$prizecost/$fmlBox 是奖励兑换口。",
    gapField: "race.daily",
    gapDetail: "缺 c_fmlRace 就不知道当天该做几条任务、购买次数与价钱，竞赛自动化一条不发。",
  },
  c_fmlRaceTask: {
    consumers: ["guild-race-take"], // [B4 一期·09-15] 接线批回填：任务行的 type=3036 门槛与 parm 花池核对由 guild-race-cycle.js 真读。
    effect: "竞赛任务池 116 行：type 语义（3036＝收获某花，与主线 type 同族）、parm 花号池、valueRange 数量档、point/competitionCoin 分值（$pointId=1010、$competitionCoinId=1009）、$refresh/$refreshCost 刷新价、$giveUpTime/$deleteTime 放弃与删除冷却、$upgradeMultiple 升级倍数。",
    gapField: "race.pointFloor",
    gapDetail: "客户要的『多少分以上值得做/放出来』判据全在这张表的 point 值域里；缺表时只认镜像现值，不自造分档。",
  },
  c_shop_item_6: {
    // 2026-09-11：花坊执行器落地（flower-shop-cycle.js）后开始真被当判据读（价格/限购/隐藏/排序）。
    consumers: ["flower-shop-buy"],
    effect: "花坊（官方界面代码把店号写死为 6：gMgr.shopMgr.getMb(6)）每一件货：卖哪个物品 items、收哪种货币多少 costs、限购 tLimit/dLimit/wLimit/mLimit/bLimit、排序 sort、是否隐藏 isHide。2026-09-11 逐行实测 117 行：每一行都只带 tLimit 且值就是 1，costs 全是花坊币配一个纯数字价格 ⇒ 花坊这一家不需要 c_formula 也算得清价与限购（官方 calCosts 遇到非数字格子是直接抛「配置表数据有误」的，一条都没有）。",
    gapField: "shop.buy",
    gapDetail: "缺 c_shop_item_6 时不知道该买哪一件、付什么、还能不能再买，花坊一条购买都不发。",
  },
  // [2026-09-18 自动化补线批] 四张表随「周常任务 / 每周防诈骗答题 / 组团订单 / 云游商人」四条待接自动化线
  // 一起登记并导出（数字由 tools/extract-official-gdata.mjs 从官方 g-data 还原，不是手抄）。
  // 登记时 consumers 还是空的——执行器接线那一批必须回来把动作名补上，否则 test:official-cfg 会按
  // 「登记了却没有消费方」的方向对账；这里刻意留空而不是先写一个还没落地的动作名。
  c_task_week: {
    consumers: ["weekly-task-rewards"],
    effect: "每周任务 5 行（30260001~30260005）与元行 -1：type（官方 c_task_type 的处理器 code，3026＝本周活跃度）、value（达标数）、rewards（奖励）、idx 与 $classifications（档位/分类）。",
    gapField: "taskWeek.recv",
    gapDetail: "缺 c_task_week 就算不出每一档周任务的达标阈值与奖励内容，镜像里就算显示可领也不敢替客户发领奖请求。",
  },
  c_antiFraudQA: {
    // [W2 接线·防诈骗答题] 消费方＝两条真实写动作，都由 anti-fraud-cycle.js 真读这张表：
    // 题干与「正确选项」是答题那一步的前置闸（读不出就一条都不发），奖励编号是领奖那一步的到账判据。
    consumers: ["anti-fraud-answer", "anti-fraud-recv"],
    effect: "每周防诈骗答题 11 行（10 道题 ＋ 元行 -1）：title 题干、answerRight/answerWrong 两个选项文案，元行带 $count（每周题数）与 $reward（奖励）。",
    gapField: "antiFraud.answer",
    gapDetail: "题库不在手上时答不出题，答题与领奖一条都不发（答案只取官方表，绝不自编）。",
  },
  c_orderTeam: {
    // [W9·09-18 组团订单接线] 消费方回填：order-team-cycle.js 真的拿这张表当判据——
    // 元行的 `$orderMaxSecond`＝一天最多做几团（读不到就整族不发），行内 `flowerNum`＝这一团要交几朵
    //（**行键＝orderNum**，common@1548337 逐字）。四条动作名逐条在写名单里，登记处与执行器同源。
    // 表本身仍是硬闸门：缺这张表就算不出日上限与朵数，组团一条都不发。
    consumers: ["order-team-take", "order-team-submit", "order-team-recv", "order-team-takestored", "order-team-buy-again"],
    effect: "组团订单 161 键＝160 行数据 ＋ 元行 -1：行内 flowerNum（这一团要多少朵）、wgtAll（权重池）、magnification/magnificationShow（倍数与展示值）；元行现读 $orderNeed=[50,100]（客户原话「50 和 100 次」）、$orderMaxSecond=4（一天最多几团）、$orderTeamTime=50（这一团的秒级时限）、$orderMax=160（到顶的团号）、$orderTeamBuyCost=[1,60]（花 60 元宝加一次 ⇒ 真钱红线，脚本永不自动做）、$storeTime=1800（存单冻结时长）。",
    gapField: "orderTeam.deliver",
    gapDetail: "缺 c_orderTeam 就算不出组团订单要交什么、交多少，也算不出一共能做几团，组团一条都不发。",
  },
  c_orderFlower: {
    // [第81件·2026-09-30 登记（用户点名「居民订单的上限是1200，绸缎和建材订单的上限是120，这些都是游戏固定的」）]
    // 花订单族（居民/绸缎/建材）三档每日上限的那把尺。判据逐字＝反解 common@1370073 `_checkOrder`：
    //   居民＝getTdyCount(105) 对 $dailyMax；绸缎＝getTdyCount(109)−1 对 $dailyMax2；建材＝getTdyCount(116)−1 对 $dailyMax3
    //   （计数类型号 105/109/116 与偏移 0/−1/−1 与 order-reward-cycle.js ORDER_PROGRESS_COUNT_TYPES 同源互证）。
    // ⚠️ 铁律 4：同一张表未还原 raw（.runtime/gdata/tables/）里是 $dailyMax=1260/$dailyMax2=181/$dailyMax3=182，
    //   与还原值无一相同——只许用本目录这份（还原值恰与客户口述 1200/120/120 逐字吻合）。
    // 本件登记用途＝给面板三格上限（daily_finish_limit/satin_finish_limit/decorate_finish_limit）的出厂值与 max 供出处
    //   （schema 常量带本行注释＋restoration 钉桩）；**运行期执行器此刻仍不读表**（截单照旧吃面板用户值×官方当日计数），
    //   consumers 诚实留空，接线批再回填。
    consumers: [],
    effect: "花订单族元行表：6 行解锁 ＋ 元行 -1。元行现读（还原）：$dailyMax=1200（居民一天最多做完）、$dailyMax2=120（绸缎）、$dailyMax3=120（建材）、$orderMax=6（居民在场单槽位数）、$orderCd=42/$orderCd2=60/$orderCd3=60（三族交单后的冷却秒数）、$guideOrder=23001、$palaceOrderTime=[7,14,21]／$palaceOrderCost=[1,10]（宫廷刷新档）、$videoOrderRwd 各族＝看广告订单的奖励（广告红线，脚本不做）。",
    gapField: "order.flower.dailyLimit",
    gapDetail: "缺 c_orderFlower 就定不出居民/绸缎/建材三族面板上限格的官方出处（1200/120/120），三格的出厂值与 max 就成了没来由的自设数；运行期截单本身吃面板值×官方当日计数，不依赖本表，所以缺表不拦任何真实写。",
  },
  c_peddler: {
    // [W8·09-18 云游商人接线] 消费方回填：peddler-cycle.js 真的拿这张表的**元行 -1** 当判据
    //（`$termMax` 判到期、`$openTime` 算每周开放窗口），读不到就一条都不发。
    // ⚠️ 同族的 `peddler.invest`（第 1 期投入 / 第 >1 期续投）确实也要读 `$principal` 与
    // `interestRate`，但它**真花元宝**，是红线，连动作号都没有 ⇒ 这一格永远只登记 `peddler-claim`。
    consumers: ["peddler-claim"],
    effect: "云游商人 5 档 ＋ 元行 -1：interestRate（每期收益倍率：1–4 期现读 [[4200,100]]＝42%，第 5 期 [[0,100]]＝0 ⇒ 第 5 期就是结算期）、$itemId（投入物，现读 1＝元宝）、$principal（起投额，现读 [100,100]）、$openTime（每周开放时刻，现读 [9,24] ⇒ 周一 09:00–24:00）、$termMax（满几期结算，现读 5）。",
    gapField: "peddler.recv",
    gapDetail: "缺 c_peddler 就算不出满几期结算与每周几点开门，到期领取一条都不发（期数不写死在代码里，只从这张表现读）；元宝投入本身是真钱红线，永不自动做。",
  },
  // [2026-09-18 自动化补线批·第二批] 订单进度宝箱与猫庭纪念品两张表（同一批登记 + cfg:extract 导出）。
  c_orderRwd: {
    // [W5·09-18 订单进度宝箱接线] 消费方回填：order-reward-cycle.js 真的拿这张表的元行当可领门槛。
    consumers: ["order-reward-recv"],
    effect: "订单进度宝箱的四档门槛与奖励：元行 -1 的 $targetNum 现读 **还原值 [15,30,45,60]**（⚠️ 同一张表在 `.runtime/gdata/tables/` 那份未还原 raw 里是 [49,64,79,94]，两个数无一相同——按铁律 4 只许用本目录这份），就是官方界面 common@1409812 里 `getMCfg(\"c_orderRwd\").$targetNum[i-1]` 逐字取的那一条；261 行是每档奖励内容（items/typeNum/itemNum，只用于播报）。",
    gapField: "order.reward.target",
    gapDetail: "缺 c_orderRwd 就取不到四档门槛，进度到了也不敢发领取请求（官方自己也是按这张表的 $targetNum 判可领）。",
  },
  // [第83件·2026-09-30 用户点名「居民订单做完出的那格免费领元宝必须对接」] 视频点位表登记。
  // 消费方＝看视频单三条新写（order-video-resident / -satin / -decorate）：规划器拿
  // 行 5/19/34 的 `limit` 判「今天这族还让不让看」，不写死任何数字（读不到表＝三条一律不发）。
  // 判据出处（逐字）：官方 `UT_SHARE` 的 `shareOverRwd`（scripts@1167432 `function o`）＝
  // `shareMgr.getMb(shareId).recvCnt >= c_share.limit`；limitType=1 的日复位式子（scripts@969544）
  // ＝uTime 落在今天 0 点之前就按 0 计。还原核对：行 5/19/34 的 limit 现读 **5/5/5**，
  // 与用户屏上「2/5」的进度点逐字吻合（2026-09-30 实屏）；数字全部 <10，按还原算子
  // （extract-official-gdata.mjs:122 `value<10` 原样返回）raw 与还原同值——但判据只吃本目录这份（铁律 4）。
  c_share: {
    // [第83件·接线完成回填] 三条看视频写已落地（规划器 order-param-resolver.js `videoShareBudget`
    // 读 limit 当每日档；写通道在 real-order-cycle.js `usr.share` 一族三条 scope）——consumers 如实回填。
    // [第103件·2026-10-02 追加第四个消费方] 礼包商城免费元宝那一档走的是**同一条官方请求、另一个点位行**
    // （`giftbag-ad-cycle.js` 的 `readGiftbagShareBudget` 现读行 8 的 limit 当「这条通道今天还能用几次」），
    // 所以这一张表现在有四个消费方、四条不同的行——一行只管一家，互不翻别人的抽屉。
    // [2026-10-02 追加第五个消费方] 公会建设·视频档（`guild-build-cycle.js` 的 `readVideoSharePlan`
    // 现读行 14「公会视频建设」的 limit 与 openId；写通道同一条 `usr.share`、第五个 scope）。
    // ⚠️ 这一行与上面四行**互不重叠**：五行五家，谁也不读别人那一行。
    // [第141件·2026-10-08 追加第六、七个消费方] 猫庭视频档两发（`zoo-pet-care-cycle.js` 的
    // `readZooShareGrant` 现读**行 22「小动物走失找回」与行 23「小动物手动处理事件」**的 limit，
    // 判「这一档今天还能用几次」＋认「shareCnt 恰好 +1」）；两行两发、与前五行互不重叠。
    // ⚠️ 台账现读**仍不全**：珍珠 #10（第130件）／水车 #9 与补领 #13（第120件）／双倍金币 #11（第121件）／
    //    首做花艺 #6（第140件）这几家实际也在读这张表，却还没回填进本条 consumers——那是各批的欠账，
    //    本批只补自己这两行，不替别人猜消费方（登记第 141 件工作日志的遗留项）。
    consumers: ["order-video-resident", "order-video-satin", "order-video-decorate", "giftbag-free-yuanbao", "guild-build-video",
      "zoo-recall-ad-grant", "zoo-event-ad-grant"],
    effect: "全游戏看视频/分享点位 71 行（本仓逐行分家消费）：行 5「鲜花订单看视频」（居民订单格 isVideo 单，tag sharingOrder）、行 19「绸缎看视频」、行 34「工坊看视频」——三行现读 hasVideo=1、limitType=1、limit=5（＝每族每天最多看 5 次，过零点由官方自己清）；行 8「商城礼包看视频免费领元宝」（tag sharingShopFreeDmd、openId share_ShopFreeDmd、limit=20、cd=180）＝第103件那一家读的正是这一行；行 14「公会视频建设」（tag sharingFmlBld、limitType=1、limit=1、hasVideo=1、openId share_FmlBld）＝公会建设视频档读的是这一行，官方界面上那句「今日视频建设 1/1」就是它；行 22「小动物走失找回」（tag sharingZooEventFind、limitType=1、limit=999、hasVideo=1、openId share_ZooEventFind）与行 23「小动物手动处理事件」（tag sharingZooEventHandleEvt、limit=999、hasVideo=1、openId share_ZooEventHandleEvt）＝第141件猫庭视频档读的两行——**这两行没有 award、也没有 cd**，好处不在分享那一发里，而在随后 `zoo.findPet{isShareVideo:1}`／`zoo.handleEvent{agree:1,isShareVideo:1}` 把元宝／赔偿**免掉**（官方 `_freeHandleEvt` 逐字）。openId 各道闸（share_Order / share_orderSatins / share_orderDecorate / share_ShopFreeDmd / share_FmlBld / share_ZooEventFind / share_ZooEventHandleEvt）由 open-registry 那份唯一解读器判，确知没开放才拦。其余行（含花艺图鉴分享 #6 这类）在本条台账里还没回填。",
    gapField: "order.video.shareLimit",
    gapDetail: "缺 c_share 就拿不到每天可看几次的上限，看视频单三条一条都不发（上限只从这张表现读，不写在代码里；官方真上限在服务器，读不到表时宁可全停）。",
  },
  c_zooSouvenirCollect: {
    // [W6·09-18] 猫庭纪念品奖励执行器已接线（写 scope zoo-souvenir-recv），所以这里登记消费者。
    // 表本身仍是硬闸门：读不到就不知道每一档要集齐几件，一条都不发（判据逐字见 zoo-souvenir-cycle.js 文件头）。
    consumers: ["zoo-souvenir-recv"],
    effect: "猫猫庭院纪念品收集档 30 行：value＝这一档要集齐几件纪念品、reward＝奖励（[[货币,数量],…]）、desc＝官方文案。官方面板判「能不能领」用的就是这一行的 value。",
    gapField: "zoo.souvenirCollect",
    gapDetail: "缺这张表就不知道每一档的门槛与奖励，纪念品领取一条都不发。",
  },
  // [2026-09-18 03:2x·猫庭「自家养猫」线] 三张表登记（判据逐条在 `.runtime/r6-zoo-pet-care-spec.md`）。
  // 登记动机是那次只读勘察**推翻了旧结论**：此前记的「c_zoo 族只在 .runtime/gdata/tables 那份未还原 raw 里、
  // 数值不可用」——自证后确认那份就是 `--raw` 导出（重跑 294/294 逐字节相同），而**用与 official-cfg
  // 同一份还原管线现算，c_zoo 族 14 张全部解出且与 restored 逐字节一致** ⇒ 不需要 CDN 侦察、不需要新工具，
  // 登记 + `npm run cfg:extract` 即得。
  // consumers 先留空：执行器（`zoo-pet-care-cycle.js`）还没接线；「登记了却没有消费方」在这一族里是**如实**的
  // ——罚的是「有消费方却没登记」，不是「登记了但还没接」（同 c_flowerElves 那族的处置口径）。
  // [W22·09-18 猫庭自家养猫接线] consumers 回填：真被 `zoo-pet-care-cycle.js` 读到的两张回填动作名；
  // `c_zooFood` **保持空**——本执行器一格都不读它（添几份由「盆容量 − 盆里现有」与「背包里实际几份」
  // 决定，satiety/mood 只在官方界面显示），所以它至今零消费方，这是如实登记而不是漏填。
  c_zoo: {
    consumers: ["zoo-add-food", "zoo-stroke"],
    effect: "猫庭元数据（只有元行 -1，27 个键）：$moodMax1=85 是**抚摸上限**（⚠️ 不是 $moodMax=100，那是心情条刻度）、$strokeTimeCd=3600 抚摸冷却秒数、$catBasinMax=30 食盆最多放几份、$satietyMax=150 饱腹上限、$stayTime=90 外出基准秒（×2＝「外出玩耍 3 小时」）、$moodMinuteAdd/$stroke/$hunger/$eat/$unhappy/$dairyMax/$friendFeedingNum 等其余键。",
    gapField: "zoo.meta",
    gapDetail: "缺 c_zoo 就算不出抚摸上限与冷却、食盆上限、饱腹上限，猫庭养猫这一族一条都不发。",
  },
  c_zooState: {
    consumers: ["zoo-stroke"],
    effect: "猫庭宠物状态 12 行（1 瞌睡／2 平静／3 开心／4 兴奋…）：`isTouch`＝这个状态下**能不能抚摸**（0＝不能）、`isEat`＝能不能喂、`stateName` 中文名、`priority/stateRnd/outRate/isAngry` 是官方自己的状态机参数。官方的红点判据 logic_petItemCanFondle 第一件事就是查这一行的 isTouch。",
    gapField: "zoo.state",
    gapDetail: "缺 c_zooState 就不知道某个状态下能不能抚摸（isTouch），抚摸这一发一律不发。",
  },
  c_zooFood: {
    consumers: [],
    effect: "猫庭食物与道具 4 行（1501 猫粮 satiety=10／1502 小鱼干 satiety=20 mood=5／1503 毛线球 mood=30／1504 猫薄荷 mood=100）：`type` 1＝食物 2＝道具、`satiety` 加多少饱腹、`mood` 加多少心情、`unuseState/useState` 是可用状态。与 c_item 的 name/desc 两表互证。",
    gapField: "zoo.food",
    gapDetail: "缺 c_zooFood 就算不出一份粮食能加多少饱腹/心情，加粮这一发不发（元宝道具更是永不发）。",
  },
  // [第132件·2026-10-06 猫庭全点接线] 登记动机＝「自动购买猫粮」与「自动处理外出事件」两条新写的判据表。
  // 10-05 两路勘察（全量落盘 `.runtime/_zoo1005_full.json`；计划 `memory/plan-1005-zoo-cat-full.md`）：
  // 两表在 d0a90/fc336 两尺经同一管线现算逐键一致（fc336 多 3 行纪念品事件，以导出为准）。
  c_zooEvent: {
    consumers: ["zoo-handle-event", "zoo-event-ad"],
    effect: "猫庭外出事件 190 行（fc336 现算）：元行 -1（$firstTimes/$specialEventTimes）；1001 引导｜2001-2100 好事（官方对 gain 型只打已读、根本不发 handleEvent）｜3001-3013 坏事（3001-3004 单选、3005-3008 只扣心情/饱腹、3009-3011 赔花或按公式 `calZooBadEventReward2` 赔金币、3012/3013 看大夫与洗澡各 3 元宝）｜4001/5001 走失/出走（找回＝10 元宝或看一次视频）｜6001/7001/8001/9001/9002 记录与占位（红点硬名单排除）。关键列：text（含「|」＝两按钮，`g[0]`→agree=1、`g[1]`→agree=0，官方没有第三个「选项序号」格）、reward1/reward2（币种 1＝元宝、-1/-2＝扣花、-3＝公式扣钱）、outTime（逾期分钟）、ifLater、**sharedId（22＝走失找回那一档、23＝手动处理事件那一档——第141件读的就是这两列：23 行的九条（3001/3002/3003/3004/3009/3010/3011/3012/3013）才是「能用视频免单」的那批，其中 3012/3013 要元宝 ⇒ 不进自动档）**、souvenirId+conditions（纪念品事件闸门）。",
    gapField: "zoo.event",
    gapDetail: "缺 c_zooEvent 就分不清哪条外出事件是免费认了的、哪条要赔花赔钱看大夫、哪一条官方给了看视频免单那一档，处理事件与免单那两发一律不发。",
  },
  c_shop_item_9: {
    consumers: ["zoo-buy-food"],
    effect: "宠物商店（店号 9，静态店——官方对静态店不发 shop.enter、客户端本地合成店态）5 行：90001 猫粮 `items[[1501,1]]` `costs[[\"11\",\"100\"]]`（11＝金币）`dLimit[\"30\"]`——**行号 90001 就是 `shop.buy` 的 itemId，不是物品号 1501**（四路逐字一致，判据书 §3.3）；90002-90004 小鱼干/毛线球/猫薄荷 costs 币种 1＝元宝（永不自动买）。",
    gapField: "zoo.foodShop",
    gapDetail: "缺 c_shop_item_9 就不知道猫粮橱窗的行号、单价与每日上限，自动买粮这一发一律不发。",
  },
  // [2026-09-18 自动化补线批·第三批] 花灵（客户 09-14 18:25–18:26 三条点名）九张表一次性登记并导出。
  // 登记时 consumers 仍是空的：接线那一批（自家侧三条零消耗领取）落地后回来逐张回填动作名；
  // 在此之前它们零消费零影响，绝不许在卡面上冒充「已经能跑」。
  // [W7·09-18 花灵线一期接线] consumers 回填：真被 flower-elves-cycle.js 读到的四张回填动作名，
  // 一期没接的四张（BookDraw/BookLvl/Pass/PassTask/PassTerm）与只作时程序的 Time 继续保持空——
  // 「登记了却没有消费方」在这一族里是**如实**的：罚的是「有消费方却没登记」，不是「登记了但还没接」。
  c_flowerElves: {
    // 派遣位行号（1..5）＝ placeMap 的键域，$dispatchRange 是派遣数量上下限：派遣与收货两条都靠它。
    consumers: ["elf-dispatch", "elf-recv"],
    effect: "花灵本体元数据：$elvesRate（每小时产出率）、$harvestMax/$addHarvestMax（仓库上限与单次加成上限）、$sneakMax（摸花上限）、$dispatchRange（派遣范围）、$friendHelpNum/$helpMax/$friendAddRate/$friendTime（好友互助的份数与冷却）、$unlock（解锁档）、$elvesLimit 与 cost 列。",
    gapField: "flowerElves.meta",
    gapDetail: "缺 c_flowerElves 就算不出花灵产出速率、仓库上限与派遣范围，花灵自动化一条都不发。",
  },
  c_flowerElvesBook: {
    // 花灵道具号 → 图鉴号 = 减 10000（官方 UT.elvesId2BookId）；派遣候选要图鉴行才认得出这是不是花灵。
    consumers: ["elf-dispatch"],
    effect: "花灵图鉴 183 行：mainFlower/secondaryFlower（主花与副花）、type/res/resMain、expId、series/sort（系列与排序）。客户说的「每个月都出新花灵主花和副花」就是这张表的行在变——面板的黑名单要跟着它更新。",
    gapField: "flowerElves.book",
    gapDetail: "缺这张图鉴就认不出哪朵花属于哪个花灵、主副花怎么配，摸花/派遣的按花过滤全都做不了。",
  },
  c_flowerElvesBookDraw: {
    consumers: [],
    effect: "花灵图鉴抽取/兑换 183 行：periods（期数）、bookId、wgt1/wgt2（两档权重）、transItems/trans2Items（兑换材料）、hiddenItems、$roundCnt/$wgt1Num/$grandPrize 元数据。",
    gapField: "flowerElves.bookDraw",
    gapDetail: "缺这张表就算不出抽取权重与兑换材料；抽取属消耗档，一期只登记不接。",
  },
  c_flowerElvesBookLvl: {
    consumers: [],
    effect: "图鉴等级 11 行：rateAdd/rateAdd2（每级加成）、upCost/upCost20/goldCost1..goldCost20（升级材料与金币价）、元行 $lvMax/$lvMax2。",
    gapField: "flowerElves.bookLvl",
    gapDetail: "缺这张表就算不出升级代价与满级，图鉴升级一条都不发。",
  },
  c_flowerElvesMoney: {
    // 派遣要带当期期次号（`iid`）：`getDispatchFlowerElvesMoneyIds` 用 startTime/playEndTime 与当前秒比。
    consumers: ["elf-dispatch"],
    effect: "花灵币（客户原话「花灵币」）四个期次行：termId、startTime/endTime/playEndTime（期次时间窗）、元行 $change。",
    gapField: "flowerElves.money",
    gapDetail: "缺这张表认不出花灵币当期期次与结算窗，收货与兑换判不出该不该发。",
  },
  c_flowerElvesPass: {
    consumers: [],
    effect: "花灵通行证 561 行（等级 × 档位）：lvl/time（等级与所需经验）、freeReward（免费档奖励）、payReward/addPayReward（付费档奖励）、元行 $exp/$stay/$buyCost/$buyLvl/$rchg1..3/$discount。",
    gapField: "flowerElves.pass",
    gapDetail: "缺这张表算不出通行证等级门槛与免费档奖励；付费档与直购一律是红线，永不自动做。",
  },
  c_flowerElvesPassTask: {
    consumers: [],
    effect: "通行证任务池 16 行：taskType/type/value（任务类型与达标数）、exp（给的通行证经验）、weight（权重）、元行 $taskNum/$pointId。",
    gapField: "flowerElves.passTask",
    gapDetail: "缺这张表就不知道通行证任务要做什么、给多少经验，任务领取判据整条落空。",
  },
  c_flowerElvesPassTerm: {
    // [W18·09-18 花灵密令接线] 消费方回填：flower-pass-cycle.js 的花灵那一半逐期读这张表——
    //   ① 门牌对账：`c_flowerElvesPassTerm[bid]` 存在 ⟺ 这一期是官方认的期次
    //      （官方 `logic_passRwd` 第一条 `if(!e.D.c_flowerElvesPassTerm(a)) return false`，common@193658 现读）；
    //   ② 满级上限 `lvlMax`（现读 15 行里 #1 是 40）与期次名 `name`（现读 #1 =「花灵密令」）。
    // ⚠️ 同族的 c_flowerElvesPass / c_flowerElvesPassTask 仍然**零消费方**：一期只做等级奖励一键领取
    //（奖励内容由服务端结算，我们不需要自己算奖；任务领取 taskDone 排在第二批，判据未证实）。
    consumers: ["elf-pass-recv"],
    effect: "通行证期次 15 行：name/itemShow（期次名与展示物）、pay1/pay2/pay4/pay5Reward（各档奖励）、lvlMax、elves/elvesScale/elvesBig/posX/posXbuy（展示用）。",
    gapField: "flowerElves.passTerm",
    gapDetail: "缺这张表认不出当期通行证与各档奖励；展示字段（坐标/缩放）自动化一律不读。",
  },
  c_flowerElvesTime: {
    consumers: [],
    effect: "花灵期次时间表 15 行：time（时刻）、termId（对应期次）、isOld（是否过期）。用来判「现在是哪一期、这一期结束了没有」。",
    gapField: "flowerElves.time",
    gapDetail: "缺这张表判不出当期是第几期、有没有过期，跨期领取会被服务器拒。",
  },
  // [2026-09-18 自动化补线批·第四批] 四条待接线的表（公会建设金币档 / 主线剧情解锁 / 花市）——
  // 同批登记 + cfg:extract 导出；数字一律取本目录这份还原值（raw 那份可以整组对不上，本批又有实证）。
  // 接线那一批落地后回来把 consumers 逐张回填。
  c_fmlBld: {
    // [W12·09-18 一期 → 2026-10-02 三档接齐] 消费方回填：guild-build-cycle.js 真读元行 `$dailyCountMap`
    // 的**两格**（"1"＝视频档每日次数、"2"＝金币＋元宝共用池）与三行各自的 `items[0][1]`／`shareId`。
    // 三格都不写死在代码里，读不到表就那一档不动。
    consumers: ["guild-build-video", "guild-build-gold", "guild-build-yuanbao"],
    effect: "公会建设四行（name/type/dailyCount/items/ctb/wealth/score/shareId）＋元行 $dailyCountMap：金币档与元宝档**共用同一个每日次数池**（官方 logic_fmlBuild 逐字把两档已用次数相加再比上限），所以判据必须两档一起算——只看自己那一档会把「今天还能捐几次」算多；视频档另有一格独立上限（现读 1），与那个池互不影响。⚠️ 一期曾把视频档（#1 走广告分享）与元宝档（#3 花元宝）当红线常量钉死「永久不代做」，**该口径已由用户 2026-10-02 点名接齐三档而作废**，现在三行都是真消费方。",
    gapField: "guild.bld.daily",
    gapDetail: "缺 c_fmlBld 就算不出每档的每日次数与消耗（金币与元宝共用同一个池），公会建设一条都不发。",
  },
  c_storyMainSection: {
    // [W13·09-18] 消费方回填：story-main-cycle.js 真的拿这张表的 cost 算「解锁这一节要花几颗星星」。
    consumers: ["story-main-unlock"],
    effect: "主线剧情每一节（name/icon/cost/dialogueID）：cost 形如 [[货币, 数量]]，解锁下一节要付的就是它——官方 storyMain.unlock 是零参数协议，所以「付多少」只能查这张表，读不到就一条都不发。",
    gapField: "storyMain.unlock",
    gapDetail: "缺 c_storyMainSection 就算不出解锁这一节要花多少星星（消耗不可逆、协议又没有幂等键），一条都不发。",
  },
  c_storyMainChapter: {
    // [W13·09-18] 同上：这一张给的是「当前这一章有哪几节」与元行的总章数 / 每日星星上限。
    consumers: ["story-main-unlock"],
    effect: "主线剧情每一章（name/sectionId/reward）＋元行（每日星星上限、总章数）：星星来自收花，今日已获要看账号同步态的计数，三者缺一不发。",
    gapField: "storyMain.chapter",
    gapDetail: "缺 c_storyMainChapter 认不出当前是第几章、每日星星上限是多少，解锁判据不完整就不发。",
  },
  c_flowerMarket: {
    // [W14·09-18 花市接线] 消费方回填：flower-market-cycle.js 的「买好友摊位上的花」真读这张表——
    // 元行的 $shelvesMax（架位号只认 1..N，官方界面就是 for a=1..$shelvesMax）、$saleFlowerMax（自证行）。
    // 「取自家货款」那一条**不读这张表**（它只认 127.1.2 的 pendingIncome），所以不列在这里。
    // 表读不到 ⇒ 买花这一族一条都不发（架位号无从判定）。
    consumers: ["market-buy"],
    effect: "花市元数据（架位数、单次上架上限、指定费、开局免费额度、重置时刻、每行 saleMax）：买别人架子上的花与自家摊位都按它判；⚠️ 表里若干档要元宝，属真钱红线，代码不许碰。",
    gapField: "flowerMarket.buy",
    gapDetail: "缺 c_flowerMarket 算不出架位与上架上限、也认不出哪些档要元宝，花市一条都不发。",
  },
  // [2026-09-18 自动化补线批·第五批] 成长之路（客户 09-14 18:17 点名的那一类「达标就领」的成长任务）。
  c_task_roadGrow: {
    // [W15·09-18 成长之路接线] 消费方回填：road-grow-cycle.js 真的拿这张表当两条写的判据源——
    // 每一档的达标数（行里的 value）、档位先后（行里的 idx）、任务中文描述（行里的 desc），
    // 以及积分宝箱的四档门槛（元行的 $grade）。读不到这张表就两条通道都不发。
    consumers: ["road-grow-recv", "road-grow-recvbox"],
    effect: "成长之路 64 行任务 ＋ 元行 -1：每行 label（面板第几个页签＝第几天解锁）/type（分类清单里的号）/desc（官方中文目标描述，如「等级达到6级」）/value（达标数）/rewards/score/idx（全表面板次序）/jumpTo/jumpQuick（跳转入口，UI 用）。元行 $grade=[10,25,60,100] 是四只积分宝箱的积分门槛、$gradeReward=[[11,10000],[1008,1],[1008,1],[21282,1]] 是四只宝箱给什么（1008 经 c_item 现读＝「VIP特权卡(1天)」，是**白送的奖励**不是月卡门槛）、$labelMax=7、$classifications 是 39 个分类号。领取走 gs.roadGrow 的 recv(id)/recvBox(idx) 两条零参数写。⚠️ 现读这张表**只有 64 行任务**（加上元行才 65 个键），不是 65 行任务。",
    gapField: "roadGrow.recv",
    gapDetail: "缺 c_task_roadGrow 就算不出每一档的达标阈值与奖励，成长之路一条都不发。",
  },
  // [W18·09-18 花之密令/花灵密令接线] 第六批：登记一张期次表，两个密令共用同一条读取路径。
  c_flowerPassTerm: {
    // 消费方回填：flower-pass-cycle.js 真的逐期读这张表——
    //   ① 门牌对账：`c_flowerPassTerm[bid]` 存在 ⟺ 这一期是官方认的期次（官方
    //      `logic_passRwd` 第一条就是 `if(!e.D.c_flowerElvesPassTerm(a)) return false`，common@193658 现读）；
    //   ② 满级上限 `lvlMax`（现读 16 行里恒为 40）与期次名 `name`（现读恒为「花之密令」）用于对账与播报。
    // 花灵那一半的对应表 `c_flowerElvesPassTerm`（15 行）在 09-18 花灵九张那一批已经落盘，
    // 本执行器两族都读，但只在这里登记新加的这一张（另一张早已登记在 §花灵那一批）。
    consumers: ["flower-pass-recv", "elf-pass-recv"],
    effect: "花之密令期次表 16 行（含 -1 元行）：`name`（现读恒为「花之密令」）、`lvlMax`（现读恒为 40）、"
      + "`show1/show2`（展示图标，自动化不读）、`pay1/pay2/pay4/pay5Reward`（付费档奖励，红线不读）。"
      + "⚠️ 等级奖励的**内容**在 `c_flowerPass`（未登记，一期不需要：一键领取由服务端结算，我们不自己算奖）；"
      + "本表只回答「这一期是不是官方认的期次」与「满级多少」两件事。",
    gapField: "flowerPass.passTerm",
    gapDetail: "缺 c_flowerPassTerm 就认不出当期是不是官方在开的期次（官方红点第一条就查这张表），"
      + "花之密令的等级奖励一个都不领；花灵密令那一半用的是它自己那张 c_flowerElvesPassTerm，不受影响。",
  },
  // [S0·2026-09-21 自动化地基批] 第八批：登记四张（`c_open`／`c_openCnd`／`c_frd`／`c_shop_item_16`），
  // 61 → **65**。四张都由**同一条还原管线**从缓存 g-data 解出（`.runtime/gdata/restored/` → `server/data/official-cfg/`，
  // 两侧逐字节一致），**consumers 诚实留空**（登记先行：读取方是 S1/S2 的闸门层，接线那一批回填）。
  // 为什么要这四张：`c_open`(443 行) ＋ `c_openCnd`(15 行) 是**官方解锁闸门与门槛话术的唯一权威**——
  // 「这张功能卡这个号能不能用」的判据只能来自它，客户端 `isOpened()` 的判定链已逐行反解在册
  // （scripts@1022581：`openMap[名] || 表行` → `closed` 短路 → `_extCheck` 渠道 → `isOr`/`isCndOr` 两层 → `$lvl/$vip/$mainTask/…`）；
  // `c_frd` 是好友族元行（好友上限/申请与刷新规则），偷花与「好友通过」两条判据都缺它；
  // `c_shop_item_16` 是时装商店（绸缎的消耗场所），绸缎订单那一族的产出侧要靠它说清去处。
  c_open: {
    consumers: [],
    effect: "官方功能开关总表 443 行：每行 `sysNumber/title/desc/sysName`（官方中文名）＋"
      + "`lvl`(216 行)／`vip`(4 行)／`cnd`(186 行)／`isOr`(1 行 `act_drawRecall`)／`isCndOr`(1 行 `usrBubble`)／"
      + "`closed`(117 行)／`ext`(13 行，渠道白/黑名单)。判定链照客户端 `isOpened()`："
      + "先取「快照 openMap 优先、缺了回落本表」，再 `closed` 短路、`_extCheck` 查渠道，最后把 "
      + "`lvl`/`vip`/`cnd` 合成条件表按 `isOr`（顶层或）与 `isCndOr`（cnd 内或）判。"
      + "⚠️ 快照 `openMap` 是**稀疏下发**（实服 80 条、十个玩法闸一条都没有）⇒ 回落本表是常态。",
    gapField: "gate.open",
    gapDetail: "缺 c_open 就只剩快照 openMap 那一份稀疏数据：没在 openMap 里的功能一律**判不出门槛**，"
      + "「这条要主线第 N 环才开」这类官方话术也一个字都给不出（只能显示「读不到」）。",
  },
  c_openCnd: {
    consumers: [],
    effect: "解锁条件字典 15 行：每个条件一行 `id/comment`（官方中文说明）/`argsNum/msgCode/mcParams`，"
      + "复合条件另带 `multi`（子条件模板）与 `isOr`。`msgCode` 指 `c_msgCode` 里的官话模板、"
      + "`mcParams` 是「取第几个实参填进模板」——`#mainTask` 那条把 `c_msgCode[214]` 的 `{index}` 换成 "
      + "`c_task_main[环号].index`（客户端 fMsgMgr 现读）。头号兜底话术是 `defaultFailedMsg = 109`。",
    gapField: "gate.openCnd",
    gapDetail: "缺 c_openCnd 就算得出「没解锁」也算不出**为什么**：条件 id 认不出、中文说明与话术模板都取不到，"
      + "灰显那一行只能说「读不到官方门槛」（铁律 8：不许编一句像官方的话骗客户）。",
  },
  c_frd: {
    consumers: [],
    effect: "好友族元行（单行 -1）：`$friendsLimit=170`（好友上限）、`$applyLimit=311`/`$applyExpireHours=130`"
      + "（申请上限与过期小时）、`$recInterval=6`/`$recIsAuto=0`（推荐间隔与是否自动）、"
      + "`$refreshLimit=10033`/`$refreshCosts=[[1,2]]`（刷新上限与消耗）、`$likeRwdMax=0`/`$likeMax=2`（点赞）等。"
      + "偷花（`steal`）与「好友通过」两条判据都要它。",
    gapField: "friendSteal.frdMeta",
    gapDetail: "缺 c_frd 就没有好友上限与申请/刷新规则：偷花的「能摘谁的地」与好友通过态只能靠猜，"
      + "而这两件事都会真的改变别人的账号状态，宁可一条都不发。",
  },
  c_shop_item_16: {
    consumers: [],
    effect: "时装商店 80 行（`tempId=16`）：每行 `type/items/costs/sort/unlock/unlock_shopLvl`——"
      + "这是**绸缎的消耗场所**（`costs` 里出现绸缎 id 的行），绸缎订单那一族的产出侧要靠它说清「绸缎花到哪去」；"
      + "`unlock` 用的是 `$fashionCoinNum`（花坊币历史累计）等条件，与 c_open 同一套条件字典。",
    gapField: "satinOrder.shopItem16",
    gapDetail: "缺 c_shop_item_16 就说不出绸缎花在哪：绸缎订单的产出侧只知「拿到绸缎」不知「绸缎去处」，"
      + "依赖链（订单→绸缎→时装商店）断在最后一跳。",
  },
  // [2026-09-21 22:5x 挂账批] 第九批：登记新手引导两张（`c_guide` 引导步骤／`c_guide_soft` 软引导锚点），
  // 65 -> 67。来由＝一条**长期挂着的追问**：「新号第 2 环那四样培育料（1401/1420/1424/1435）从哪来」。
  // 此前只在 `.runtime/gdata/tables/` 那份**未还原 raw** 里见过这两张表名，按铁律 4 不敢拿 raw 当判据；
  // 现按与 official-cfg 同一份还原管线导出（`node tools/extract-official-gdata.mjs --no-net`，
  // 源＝缓存 `g-data.d0a90.text` sha256 前 16 位 cb36fa78cb2842f1），两侧逐字节一致后才登记。
  // consumers **诚实留空**：当前没有任何写通道读它们（它们是「新手期哪一步发了什么」的追问来源，
  // 读取方＝`.runtime/_guide_newbie_scan.mjs` 这类一次性只读取证），
  // 「登记了却没有消费方」在这里是如实的，不是漏登记（同 c_zooFood／c_flowerElves 那两族的处置口径）。
  c_guide: {
    consumers: [],
    effect: "新手引导步骤 306 行：每行 `layer`（FarmMap／FarmPlantDlg…）＋`type`＋`beforeShow`／`afterShow`"
      + "（如 `1001_0 = {layer:FarmMap, type:1, beforeShow:dialog:1001, afterShow:goNext}`），"
      + "元行 -1 带 `$spokeGuideMap`（已说过的步骤表）——它描述**引导流程本身**（先点哪里、再说哪句），"
      + "奖励与发放在对话／任务那几张表里，这张表本身不写「发了几件什么」。",
    gapField: "newbieGuide.steps",
    gapDetail: "缺 c_guide 就答不出「新手期第几步教了什么」，"
      + "「新号那几样料是哪一步给的」只能继续靠猜。",
  },
  c_guide_soft: {
    consumers: [],
    effect: "软引导锚点 139 行：`{key, layer, node}`（如 `2 = {key:plant2, layer:FarmPlantDlg, node:\"getPlantFlower:lst_plant,${'$'}{iid}\"}`）——"
      + "官方用它把「该点哪个控件」指到具体节点上；与 c_guide 合起来才能把「第几步」落到「哪个界面哪个按钮」。",
    gapField: "newbieGuide.softAnchors",
    gapDetail: "缺 c_guide_soft 就只能说「第几步」，说不出「在哪一屏的哪个控件上」——"
      + "复现新手路径时仍然要人去猜。",
  },
  // [2026-09-26 第52件 A 挂号] 第十批：培育「元宝补料」的两张价目表。
  // 来由＝用户实屏（培育面板 除螨液 5/6、黏土 5/6，各挂一枚「5」元宝按钮）＋实服只读实录
  // （`.runtime/_52b_mod20.json`：模块 20 的 `map[5].list` 是**行号数组**、`map[4].bRecord={"10021"}`）。
  // 两张表按与 official-cfg 同一份还原管线导出（源＝`.runtime/gdata/g-data.fc336.text`，
  // `node tools/extract-official-gdata.mjs --src <那份> --no-net --all`）——**不是**旧版 raw：
  // 旧版 `c_shop_item_4` 里 1403 那行根本不存在、1424 还挂在 10003 上；行号就是 `shop.buy` 的
  // itemId，错一位就是买错东西（本批的血，见 memory/recurring-mistakes 第 35/36 条）。
  c_shop_item_4: {
    consumers: ["direct-buy"],
    effect: "培育材料元宝通道（`tempId=4`、静态店）53 行：每行 `type/items[[材料id,数量]]/costs[[币种id,单价]]`。"
      + "非贵族买料买的就是这一表里的行（官方 `PCultivateNeedItem._tap_btn_buy` 逐字：`l?d.shopId:d.itemShopId`，"
      + "非贵族那支取 `itemShopId`＝**本表行号**）——行号即 `shop.buy` 的 itemId，单价即服务器扣的钱。",
    gapField: "directBuy.shopItem4",
    gapDetail: "缺 c_shop_item_4 就没有「买哪一条、多少钱」：元宝补料会一条都不发"
      + "（退回「读服务器在架结构」那条路 09-26 已证伪——服务器下发的 list 只有行号，不带物品与价）。",
  },
  c_shop_item_5: {
    consumers: ["direct-buy"],
    effect: "培育材料**货架**（`tempId=5`、会刷新）73 行：`items`／`costs`／`priceMax`。"
      + "官方把「这一刻货架上有什么」下发成店 5 的 `list`（行号数组），行号要过本表才知道是**哪一样材料**；"
      + "客户端显示价＝非贵族取 `priceMax`（原价）、贵族取 `costs` 里的折扣价。",
    gapField: "directBuy.shopItem5",
    gapDetail: "缺 c_shop_item_5 就认不出货架行号是哪样材料："
      + "「这材料这一刻能不能买」判不出来，元宝补料一条都不发（宁可不动，也不会买错）。",
  },
}).map(([name, entry]) => Object.freeze([name, Object.freeze({
  name,
  fileName: `${name}.json`,
  consumers: Object.freeze([...entry.consumers]),
  effect: entry.effect,
  gapField: entry.gapField,
  gapDetail: entry.gapDetail,
})]))));

export function officialCfgTableNames() {
  return Object.freeze(Object.keys(OFFICIAL_CFG_TABLES));
}

/**
 * 表目录：环境变量优先，其次仓库 `server/data/official-cfg`。
 * 不接受相对入参当默认值——按进程 cwd 解析正是上一版最坑的那个写法。
 */
export function officialCfgDir(options = {}) {
  if (typeof options.dir === "string" && options.dir.trim()) return path.resolve(options.dir.trim());
  const fromEnv = process.env[OFFICIAL_CFG_DIR_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return OFFICIAL_CFG_DEFAULT_DIR;
}

const cache = new Map();

export function resetOfficialCfgCache() {
  cache.clear();
}

function statFile(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    return { size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
  } catch {
    return null;
  }
}

function readTable(name, dir) {
  const entry = OFFICIAL_CFG_TABLES[name];
  if (!entry) {
    const error = new Error(`未登记的官方配置表：${name}`);
    error.code = "OFFICIAL_CFG_TABLE_UNKNOWN";
    throw error;
  }
  const file = path.join(dir, entry.fileName);
  const stamp = statFile(file);
  if (!stamp) return { table: null, reason: "FILE_MISSING", path: file, size: 0, keyCount: 0 };
  const cached = cache.get(file);
  if (cached && cached.stamp.size === stamp.size && cached.stamp.mtimeMs === stamp.mtimeMs) {
    return { ...cached.result, stamp };
  }
  let result;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    if (!isRecord(parsed)) result = { table: null, reason: "NOT_RECORD", keyCount: 0 };
    else if (Object.keys(parsed).length === 0) result = { table: null, reason: "EMPTY_TABLE", keyCount: 0 };
    else result = { table: parsed, reason: null, keyCount: Object.keys(parsed).length };
  } catch {
    result = { table: null, reason: "PARSE_ERROR", keyCount: 0 };
  }
  const stored = { ...result, path: file, size: stamp.size };
  cache.set(file, { stamp, result: stored });
  return { ...stored, stamp };
}

/**
 * 读取一张官方数值表。**任何**异常都返回 null，由调用方 fail-closed。
 * 返回的仍是表对象，但它是缓存引用：调用方只读，不得改写。
 */
export function loadOfficialCfgTable(name, options = {}) {
  return readTable(name, officialCfgDir(options)).table;
}

/** 脱敏状态：只报「有没有、能不能用、多少条」，不回表内容与任何数值。 */
export function officialCfgTableStatus(name, options = {}) {
  const entry = OFFICIAL_CFG_TABLES[name];
  if (!entry) {
    const error = new Error(`未登记的官方配置表：${name}`);
    error.code = "OFFICIAL_CFG_TABLE_UNKNOWN";
    throw error;
  }
  const dir = officialCfgDir(options);
  const read = readTable(name, dir);
  const dirExists = (() => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } })();
  return Object.freeze({
    table: name,
    fileName: entry.fileName,
    available: read.table !== null,
    present: read.reason !== "FILE_MISSING",
    reason: read.reason,
    keyCount: read.keyCount,
    sizeBytes: read.size,
    dirExists,
    consumers: entry.consumers,
  });
}

export function officialCfgStatus(options = {}) {
  return Object.freeze(officialCfgTableNames().map((name) => officialCfgTableStatus(name, options)));
}

/**
 * 供执行器塞进 notImplemented / plan.gaps 的一条缺口（与表登记同源，不再手抄文案）。
 * **表在不在，决定这句话是不是真话**：旧实现不管读得到读不到都写「缺表」，十五张表全部
 * 到手之后，四条日常缺口就集体变成假话——明明只差接线，却报成「等谁去补一个文件」。
 * 现在按当前状态二选一，并把判断结果一起回传（`tableAvailable`），面板不必猜。
 */
export function officialCfgGap(name, override = {}, options = {}) {
  const entry = OFFICIAL_CFG_TABLES[name];
  if (!entry) {
    const error = new Error(`未登记的官方配置表：${name}`);
    error.code = "OFFICIAL_CFG_TABLE_UNKNOWN";
    throw error;
  }
  const status = officialCfgTableStatus(name, options);
  const pick = (whenReady, whenMissing) => (status.available ? whenReady : whenMissing);
  return Object.freeze({
    field: override.field || entry.gapField,
    reason: pick(override.reasonWhenReady, override.reason)
      || pick(OFFICIAL_CFG_NOT_WIRED_REASON, OFFICIAL_CFG_GAP_REASON),
    detail: pick(override.detailWhenReady, override.detail) || pick(
      `${entry.effect} 表已到位（${status.keyCount} 条），这一项缺的是执行器/接线，不是配置文件。`,
      `${entry.gapDetail} 期望文件：${entry.fileName}（放 ${OFFICIAL_CFG_DIR_ENV} 指定目录或 server/data/official-cfg/）。`,
    ),
    table: name,
    tableAvailable: status.available,
    consumers: entry.consumers,
  });
}

/** 一次给出多张表的缺口，自动去重（同一 field 只留第一条）。 */
export function officialCfgGaps(names, overrides = {}, options = {}) {
  const seen = new Set();
  const result = [];
  for (const name of names) {
    const gap = officialCfgGap(name, overrides[name] || {}, options);
    if (seen.has(gap.field)) continue;
    seen.add(gap.field);
    result.push(gap);
  }
  return Object.freeze(result);
}

/** 给日志/诊断用的一行摘要：只报计数。 */
export function describeOfficialCfg(options = {}) {
  const status = officialCfgStatus(options);
  const ok = status.filter((item) => item.available).length;
  const missing = status.filter((item) => !item.available && !item.present).map((item) => item.table);
  const broken = status.filter((item) => !item.available && item.present).map((item) => `${item.table}:${item.reason}`);
  return `official-cfg ${ok}/${status.length} 可用`
    + (missing.length ? ` 缺表=${missing.join(",")}` : "")
    + (broken.length ? ` 有表但不可用=${broken.join(",")}` : "");
}