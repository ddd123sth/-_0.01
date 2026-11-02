# 订单辅助运行时

本模块负责订单事实摄入、候选规划，以及经共享 gateway 执行的 card6 和 legacy request-only 视频业务请求。视频 request-only 仅适用于正常登录证明的 `openAdRewardSdk=false`、`nativeAbSwitch=true` 路由；它不证明播放，也不代表服务端授予免播资格。操作仍受公共业务历史准入、发送许可、单次发送和关闭后独立 fresh-login 核验约束。历史设计与实服记录见[独立广告状态记录](../../../../docs/android-backend-implementation-20261024/standalone-ad-status-20261025.md)。

- `decodeOfficialOrderFlowerObservation({context,observation})`：只接受当前版本正常匹配回包作为可摄入来源；push、迟到、旧序号只追加审计。保留 missing / null / 数值 0，日期只接毫秒或带 Z 的严格 ISO。白名单为 `105.0` 的居民 `1[1..6]`、绸缎 `6`、建材 `7`、管家库存 `8`、每日格数 `9`、奖励及日期，`7.4[105/109/116]`、`31.0[5/19/34]` 和 `21.5[6]`。`21.6` 是充值扩展表，不是广告卡表。
- `createOrderFlowerReadModel({store,isCurrent})`：提供 `ingest({context,observation})`、`snapshot(context)`、`publicView(context)`、`stop(context)`、`shutdown()`。所有读取需要完整六轴；按 owner / 原 account / stable subject 隔离头。正常登录绑定 UID 和版本；新连接不能继承旧当前资格。原审计追加不可改；头是可更新投影。提供的 `orderMap` 属性整体替换，缺属性保留其原来源；坏父域使依赖字段失效。空集合与未提供集合分列。
- `createOfficialOrderFlowerCatalog()`：仅读取本目录 `static/`。`source.json` 保存完整原表指纹、所选行和字段、公开数据及独立静态解码出处；不是整表或全功能覆盖声明。游戏和 mo 的精确 UTF-8 区段及 SHA 在 `ORDER_FLOWER_SOURCE`。
- `planOrderFlowerStock({context,view,config,catalog,resources,eligibility,clock,officialDay,keepPolicy})`：只调用共享 `resources.budget`，不创建操作或预约。普通配花重复项先求和，明确保留量，未知或不足只等待依赖。配置取当前 DTO；每日上限 0 按现有界面“不限”解释，仍受真实官方上限约束。

`eligibility[kind]` 的接口为 `{known,value,context,officialUid,openId,proofRef}`，必须来自该种订单的当前用户、服务器 override、渠道等真实开放输入。视频还需 `eligibility.video[kind]`，openId 分别为 `share_Order/share_orderSatins/share_orderDecorate`。静态 `sys_orderFlower` 的 cultivatedNum 条件、`sys_orderSatins` 的 fashionCoinNum 条件及 `sys_orderDecorate` 等级条件不能单独冒充当前开放证明。本批不另写一套通用 SysOpen 判定器。

当前客户端日数规则为居民 `getTdyCount(105)`、绸缎 `max(getTdyCount(109)-1,0)`、建材 `max(getTdyCount(116)-1,0)`。只在本官方日的正常读取以及已核日界 / 当前单调时钟下派生，原 counter 行不归零。行上的 `finishCnt`、管家 `tdyFinishOrderMap` 均另列原事实，不替代该规则。管家库存可能按雇佣期和 calcTime 随时间增长，本批没有把 raw stockNum 当完整可执行库存；正库存保持独立待合同，所有普通候选均声明写前还需管家库存对账。

视频随居民 / 绸缎 / 建材各自总开关启停，没有另设默认关闭的视频门。官方 UI 分别调用 shareId `5/19/34`，居民再带真实 boxId。当前仅在正常登录读取到精确路由 `openAdRewardSdk=false`、`nativeAbSwitch=true` 时准备一次 request-only `usr.share`：不传 token，不声称播放完成或官服授予免播资格。每笔仍走公共业务历史准入、发送许可与gateway单次发送；只在真实响应和关闭后独立 fresh login 共同满足原订单奖励合同后才确认。其他路由不触发该请求。真实官方卡只按本人当前 `21.5[6]`、isMain 或可信 invalidTime / clock 观察资格；它仍按原卡合同执行。

广告尝试历史与业务请求历史分层：旧 native playback / server-grant 记录只留在原数据库，不当作 `usr.share` 已派发，也不重写或重放；request proof 与 append-only request attempts 由完整原操作、路由、gateway permit 和业务原单绑定。仅有可核实的“未派发”证据才允许同一生命周期建立新 attempt，may-have-sent 或已回答机会不重复发送。关闭后验证沿用旧 request proof 和原统一 operation 审计，不要求重建旧 SDK 执行器。历史问题与实测边界见 [独立广告状态记录](../../../../docs/android-backend-implementation-20261024/standalone-ad-status-20261025.md)。

`orderFlower.enter {}` 是官方界面入口，可能填充 / 推进订单；不能登记为写后刷新。写后核验使用物理关闭后的正常 fresh login。业务准入使用完整原单生命周期、两次检查、精确资源及统一持久历史；内容指纹或格号不能替代生命周期，已派发或结果未知的操作不得重发。此前只读准备阶段及其验收边界保留在上方链接的历史记录中。
