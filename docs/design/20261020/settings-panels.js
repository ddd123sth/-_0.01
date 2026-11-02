/*
 * 花园世界 · 高保真交互原型的完整设置面板。
 * 所有配置、状态与修改均为浏览器内设计示意，不调用设备、本机服务或官服，不执行业务。
 * DTO 与语义来源：ui/app.js:191–588、942–1002、1052–1092；runtime/config.mjs:18–61。
 * 枚举/量程来源：vendor/garden-engine/server/src/schema.js:269–274、1641–1735、1853–1877、2009、2046、2057、2177–2183。
 * 花种名字/编号/品质来自 vendor/garden-engine/server/data/flowers.json；
 * 花艺名字与配方来自同目录 official-cfg/c_flowerArt.json × c_item.json。
 * 这里只摘取少量真实静态目录用于展示选择器，不声称当前游戏号已经解锁、拥有或做成。
 */
(() => {
  'use strict';

  const qualities = [
    { value: 1, label: '凡品', description: '品质第 1 档' },
    { value: 2, label: '普品', description: '品质第 2 档' },
    { value: 3, label: '珍品', description: '品质第 3 档' },
    { value: 4, label: '华品', description: '品质第 4 档' },
    { value: 5, label: '仙品', description: '品质第 5 档' }
  ];
  const flowers = [
    { value: 23001, label: '白百合', description: '凡品', quality: 1 },
    { value: 23002, label: '康乃馨', description: '凡品', quality: 1 },
    { value: 23011, label: '红玫瑰', description: '凡品', quality: 1 },
    { value: 23016, label: '紫绣球', description: '凡品', quality: 1 },
    { value: 23067, label: '淡粉矮牵牛', description: '普品', quality: 2 },
    { value: 23068, label: '明黄矮牵牛', description: '普品', quality: 2 },
    { value: 23066, label: '冰蓝矮牵牛', description: '珍品', quality: 3 },
    { value: 23080, label: '粉樱月见草', description: '珍品', quality: 3 },
    { value: 23079, label: '宝珠玉兰', description: '华品', quality: 4 },
    { value: 23094, label: '星槎仙舟', description: '华品', quality: 4 },
    { value: 23078, label: '星河映蕊', description: '仙品', quality: 5 },
    { value: 23093, label: '金鳞飞渡', description: '仙品', quality: 5 }
  ];
  const arts = [
    { value: 300101, label: '百合瓷韵', description: '配花：白百合／康乃馨／铃兰' },
    { value: 300102, label: '百合瓷韵', description: '配花：白百合／康乃馨／紫罗兰' },
    { value: 300201, label: '素蓝青釉', description: '配花：黄郁金香／蝴蝶兰／铃兰' },
    { value: 300301, label: '复古瑰瓶', description: '配花：红玫瑰／雏菊／蓝星花' },
    { value: 300401, label: '锦簇花篮', description: '配花：紫绣球／山茶花／小苍兰' },
    { value: 300501, label: '浮舟木樽', description: '配花：向日葵／蓝星花／水仙花' },
    { value: 300601, label: '琉璃花盏', description: '配花：红马蹄莲／风铃花／蒲公英' },
    { value: 300701, label: '瓷语花心', description: '配花：紫色风信子／风铃花／康乃馨' }
  ];
  const plantModes = [
    { value: 'least_stock', label: '库存最少', description: '从所有已培育花种中挑选，库存少的先补。' },
    { value: 'chosen_flowers', label: '指定花朵', description: '只种指定名单里的花，仍按库存从少到多安排。' },
    { value: 'chosen_quality', label: '指定品质', description: '只种选中品质的花，仍按库存从少到多安排。' },
    { value: 'chosen_top', label: '置顶花朵', description: '读取游戏里的置顶名单；请在游戏内修改置顶。' }
  ];
  const groupSizes = [4, 8, 16, 32, 64].map(value => ({
    value, label: `${value} 块地`, description: `每片种同一种花，每片 ${value} 块。`
  }));
  window.GARDEN_DESIGN_CATALOGS = { flowers, qualities, arts };

  // 与新装默认口径一致：业务开关均关闭。示例目录选择不代表任何真实账号资料。
  window.GARDEN_DESIGN_DEFAULTS = {
    configVersion: 3,
    plantEnabled: false, plantMode: 'least_stock', plantFlowerIds: [], plantQualities: [],
    groupSize: 8, plantBlacklistIds: [], restockCount: 0,
    harvestEnabled: false, waterEnabled: false, keepWater: 0,
    orders: {
      resident: { enabled: false, dailyLimit: 1200 },
      satin: { enabled: false, dailyLimit: 120 },
      decorate: { enabled: false, dailyLimit: 120 },
      customer: { enabled: false, coinTiers: [1, 2, 3], autoReject: false },
      palace: { enabled: false, qualityFilter: [] },
      team: { enabled: false, realWrite: false, allowFreeTake: false, allowBuyAgain: false, buyAgainKeepYuanbao: 0 }
    },
    dailyTaskRewards: { enabled: false },
    art: { makeEnabled: false, specifiedArts: [], autoReplenish: false, makeBatch: 1, firstAlbumClaim: false, firstShareClaim: false }
  };

  const panel = (title, subtitle, fields, extra = {}) => ({
    title, subtitle, group: '自动化', kind: 'sheet', scope: 'config', fields,
    primary: { label: '完成设置', action: 'apply' }, ...extra
  });
  const note = (label, description, tone) => ({ type: 'note', label, description, ...(tone ? { tone } : {}) });
  const action = (label, target, description, extra = {}) => ({ type: 'action', label, target, description, ...extra });
  const toggle = (key, label, description, extra = {}) => ({ type: 'toggle', key, label, description, ...extra });
  const number = (key, label, min, max, unit, description, extra = {}) => ({ type: 'number', key, label, min, ...(max === null ? {} : { max }), integer: true, required: true, unit, description, ...extra });
  const picker = (key, label, catalog, description, extra = {}) => ({ type: 'picker', key, label, catalog, description, ...extra });
  const status = (label, description) => ({ type: 'status', label, description });
  const videoNote = note('视频单随订单开关启停', '开启这类订单时同时启用本类视频单；关闭后普通单和视频单都不再新发。视频单没有独立开关。');
  const draftNote = note('保存后生效', '这里先修改当前游戏号的草稿，完成后还需在页面底部保存设置。开关不会自动启动游戏号。');
  const currentState = status('当前现场', '设计原型未连接官服。订单数量、库存、进度和下次检查时间均需运行时读取。');
  const plantModeField = { type: 'select', key: 'plantMode', label: '种植模式', description: '四种模式都按现有库存从少到多安排，区别在允许种哪些花。', options: plantModes };
  const flowerField = picker('plantFlowerIds', '指定花朵', 'flowers', '仅“指定花朵”模式生效。切换模式保留名单；其他模式不会使用这份选择。', { enableWhen: { key: 'plantMode', value: 'chosen_flowers' } });
  const qualityField = picker('plantQualities', '指定品质', 'qualities', '仅“指定品质”模式生效。可以选择多个品质，库存少的先补。', { enableWhen: { key: 'plantMode', value: 'chosen_quality' } });
  const groupField = { type: 'select', key: 'groupSize', label: '种植分组', description: '每片只种一种花。修改分组从下一批腾空的空地生效，正在生长的花不会被替换。', options: groupSizes };
  const blacklistField = picker('plantBlacklistIds', '种植黑名单', 'flowers', '黑名单中的花不参与任何模式的种植；订单或任务需要它时也不会种。');
  const targetField = number('restockCount', '种植数量', 0, null, '枝', '填 0 表示不设目标。指定花朵、指定品质、置顶花朵会补到此库存；全部达标后空地留白。库存最少模式不使用这个目标。');
  const artTarget = number('art.makeBatch', '成品目标库存', 1, 999, '件', '日常补货按每种成品的目标库存补足；真正制作仍一次一件。顾客订单缺几件就做几件，不受此目标限制。', { enableWhen: 'art.makeEnabled' });
  const artPicker = picker('art.specifiedArts', '指定花艺', 'arts', '只限制日常补做和自动补货。未指定时按官方目录和库存挑选；顾客明确需要的成品不受名单限制。', { enableWhen: 'art.makeEnabled' });

  const specs = {
    'plant-detail': panel('自动种花', '从花种、分组到补货目标，都由当前游戏号独立保存。', [
      toggle('plantEnabled', '自动种花', '开启后，按空地和当前模式安排种植。'),
      action('种植模式', 'plant-mode', '选择允许参与种植的花种范围。'),
      flowerField, qualityField,
      note('置顶名单来自游戏', '此模式直接读取游戏内置顶花朵。要换花，请到游戏内调整置顶。', null),
      action('种植分组', 'plant-groups', '每片地只种一种花，从下一批空地生效。'),
      action('种植黑名单', 'plant-blacklist', '所有模式均排除名单中的花。'),
      action('种植数量', 'plant-target', '为指定范围设置库存目标；0 表示不设。'),
      draftNote
    ]),
    'plant-mode': panel('种植模式', '每种模式都先补库存少的花，只改变候选花种。', [
      plantModeField,
      note('名单互不混用', '切换模式后，之前选过的花朵和品质仍会保存，但只有对应模式才会使用。'),
      action('选择指定花朵', 'plant-flowers', '可搜索、多选、查看已选项。', { enableWhen: { key: 'plantMode', value: 'chosen_flowers' } }),
      action('选择指定品质', 'plant-qualities', '五档品质可以多选。', { enableWhen: { key: 'plantMode', value: 'chosen_quality' } }),
      note('置顶花朵', '置顶花朵不需要在本 App 再选一遍，请在游戏里修改置顶名单。')
    ]),
    'plant-flowers': panel('指定花朵', '选择允许种植的花种，按库存从少到多补。', [
      flowerField,
      note('仅在对应模式生效', '先将种植模式切换为“指定花朵”。切走后名单保留并停用，不会清空。')
    ]),
    'plant-qualities': panel('指定品质', '只种选中品质的花。', [
      qualityField,
      note('仅在对应模式生效', '先将种植模式切换为“指定品质”。未选中的品质不会参与这个模式。')
    ]),
    'plant-groups': panel('种植分组', '每片种同一种花，让花田保持规整。', [
      groupField,
      note('以 64 块地为例', '每片 4 / 8 / 16 / 32 / 64 块时，可同时摆放 16 / 8 / 4 / 2 / 1 种花。地块总数以游戏现场为准。'),
      note('从下一批空地开始', '游戏没有铲除操作。调整不会移走或替换正在生长的花。')
    ]),
    'plant-blacklist': panel('种植黑名单', '被排除的花不会参与任何种植模式。', [
      blacklistField,
      note('可能影响订单交付', '如果订单需要的花在黑名单里，这张订单可能持续等待；运行日志会说明等待的花种与订单。', 'warning')
    ]),
    'plant-target': panel('种植数量', '为指定范围设定库存目标，达到目标后留空。', [
      targetField,
      note('适用的种植模式', '指定花朵、指定品质、置顶花朵使用这个数量；库存最少模式不受此目标限制。'),
      note('0 表示不设目标', '不设置补货停止线，空地会继续参与种植。填写 0 或正整数。')
    ]),
    'harvest-detail': panel('自动收花', '同一个种植组的这一批花全部成熟后，一起收获。', [
      toggle('harvestEnabled', '自动收花', '每个种植组单独判断是否全部成熟。'),
      note('整组全熟再收', '一组还有花未成熟时，会等这一批全部成熟。成熟后的执行仍以游戏现场状态为准。'),
      note('独立控制', '收花与种花、浇水分别保存开关；收花没有额外的延迟档位。'),
      draftNote
    ]),
    'water-detail': panel('自动浇水', '按游戏现场需要浇水，并保留你设定的水滴余量。', [
      toggle('waterEnabled', '自动浇水', '浇水会消耗游戏内水滴。'),
      number('keepWater', '保留水滴', 0, null, '滴', '低于这个数时暂不再浇。填 0 表示不设保留线，可以用到见底。'),
      note('可以提前填写', '关闭自动浇水后，保留数量仍保存在设置里；重新开启时继续使用。'),
      draftNote
    ]),
    'resident-detail': panel('居民订单', '材料够就交单，普通单与本类视频单随总开关启停。', [
      toggle('orders.resident.enabled', '居民订单', '按官服当前订单和材料状态交付。'),
      number('orders.resident.dailyLimit', '居民订单每日上限', 0, 1200, '单', '当日已交数量从官服读取。0 表示不额外限制；填写正数后，达到上限不再新交。', { enableWhen: 'orders.resident.enabled' }),
      videoNote, currentState,
      action('订单执行说明', 'orders-state-help', '查看等待、状态未读到与结果待核对的区别。'),
      draftNote
    ]),
    'satin-detail': panel('绸缎订单', '交单次数与下一次检查时间独立安排。', [
      toggle('orders.satin.enabled', '绸缎订单', '按官服当前绸缎订单判断并交付。'),
      number('orders.satin.dailyLimit', '绸缎订单每日上限', 0, 120, '单', '当日已交数量从官服读取。0 表示不额外限制；达到设定数量不再新交。', { enableWhen: 'orders.satin.enabled' }),
      videoNote, currentState, draftNote
    ]),
    'decorate-detail': panel('建材订单', '建材订单有独立计数与检查安排。', [
      toggle('orders.decorate.enabled', '建材订单', '按官服当前建材订单判断并交付。'),
      number('orders.decorate.dailyLimit', '建材订单每日上限', 0, 120, '单', '当日已交数量从官服读取。0 表示不额外限制；达到设定数量不再新交。', { enableWhen: 'orders.decorate.enabled' }),
      videoNote, currentState, draftNote
    ]),
    'customer-detail': panel('顾客订单', '先等花艺补齐成品，再交付顾客需要的订单。', [
      toggle('orders.customer.enabled', '顾客订单', '只交你选择的花坊币档位。顾客订单不设每日数量上限。'),
      { type: 'chips', key: 'orders.customer.coinTiers', label: '花坊币档位', description: '可选择多档；全部不选时，一张顾客订单也不会做。', options: [
        { value: 1, label: '1 档' }, { value: 2, label: '2 档' }, { value: 3, label: '3 档' }
      ] },
      toggle('orders.customer.autoReject', '自动拒单', '只在确认做不了、花艺也确实无法补做时拒单。配花、花瓶或库存没读到时等待核对，不据此拒单。', { enableWhen: 'orders.customer.enabled' }),
      action('顾客缺成品时怎么处理', 'customer-art-link', '查看顾客订单与花艺之间的执行顺序。'),
      currentState, draftNote
    ]),
    'customer-art-link': panel('顾客订单与花艺', '缺成品时先补做，官方确认成品入库后再交付。', [
      status('1 · 识别需求', '从当前顾客订单读取缺少的成品与数量。'),
      status('2 · 花艺优先制作', '做花艺开着时，优先处理顾客需求；不受日常指定名单和目标库存限制。'),
      status('3 · 确认后交付', '收到官方确认后，叫醒顾客订单继续交付。'),
      note('状态缺失时等待', '配花、花瓶、库存读不到不等于做不了。只有确实无法制作且自动拒单开启，才执行拒单。'),
      action('查看花艺制作设置', 'art-detail', '制作有自己的开关，独立于顾客订单。')
    ]),
    'palace-detail': panel('宫廷订单', '选择不交的品质，未过滤的订单按现场状态交付。', [
      toggle('orders.palace.enabled', '宫廷订单', '按本类独立的检查安排读取和交付。'),
      { type: 'chips', key: 'orders.palace.qualityFilter', label: '不交的品质', description: '勾中的品质会被排除；一个都不选表示不过滤，全部品质都可交。', options: qualities },
      note('品质过滤是排除名单', '这里选中的品质表示“不交”，与种植设置里的“指定品质”含义不同。'),
      note('本版本仅交单', '免费刷新所需的可信次数判据尚未核清，当前不自动发刷新。'),
      currentState, draftNote
    ]),
    'team-detail': panel('组团订单', '按当前团状态依次接单、交花、领奖、取回存单。', [
      toggle('orders.team.enabled', '组团订单', '本类功能的总开关。'),
      toggle('orders.team.realWrite', '允许团单操作', '这一项关闭时，团状态也不读取，接单、交花、领奖和取存单均不执行。', { enableWhen: 'orders.team.enabled' }),
      toggle('orders.team.allowFreeTake', '自动接免费团单', '游戏派来免费团单时自动接下；关闭后，已有团仍可按当前状态继续交花和领奖。', { enableWhen: 'orders.team.enabled' }),
      toggle('orders.team.allowBuyAgain', '允许元宝再加单', '领完当前团奖励后，按游戏提供的资格再开一单。会扣除游戏内元宝，默认关闭。', { enableWhen: 'orders.team.enabled' }),
      number('orders.team.buyAgainKeepYuanbao', '加单后保留元宝', 0, null, '元宝', '支付加单费用后，余额至少保留这个数；0 表示不设保留线。实际费用和是否可加单以官方当前状态为准。', { enableWhen: 'orders.team.allowBuyAgain' }),
      note('每一步确认后才继续', '接单、交花、领奖和取存单分别核对。未确认的原操作保留记录，不重发。', 'warning'),
      currentState, draftNote
    ]),
    'daily-detail': panel('日常任务奖励', '只领取已经达标、尚未领取的日常任务奖励。', [
      toggle('dailyTaskRewards.enabled', '自动领取日常任务奖励', '独立开关，默认关闭。关闭后不再发新的领取。'),
      note('领取范围', '只包含日常任务奖励，不包含活跃度宝箱、周常或其他奖励；不会为了领奖自动执行底层任务。'),
      action('查看奖励状态', 'daily-status', '查看可领、未达标、已领与待核对状态的展示方式。'),
      action('领取保护说明', 'daily-protection', '按当天任务状态判重，保留未确认操作。'),
      draftNote
    ]),
    'daily-status': panel('日常奖励状态', '下面展示各状态的设计文案，均非当前账号的官服结果。', [
      status('已关闭 · 状态示例', '自动领取已关闭。任务进度可查看，不再发新的领取。按钮：返回设置。'),
      status('待达标 · 状态示例', '任务尚未完成，继续等待。不会为了领奖自动执行任务需要的业务。'),
      status('可领取 · 状态示例', '官服确认已达标且尚未领取，等待本类检查安排。保持自动领取开关开启即可。'),
      status('已领取 · 状态示例', '今日该项奖励已确认领取，不再重复领取。切换日期时重新读取当天任务账。'),
      status('结果待核对 · 状态示例', '这一笔领取尚未确认，原记录已保留，不重发。通过正常连接读取当前状态，再判断当前可执行事项。'),
      note('下次检查', '开启后由日常奖励自己的持久醒点安排；时间读取不到时显示“待获取”。以上状态卡仅供原型评审。')
    ]),
    'daily-protection': panel('领取保护', '按当前官服状态判断领取资格，原操作记录持续保留。', [
      note('避免重复领取', '必要任务字段必须读全；跨日时读取当天任务，不能把昨天的已领结果沿用到今天。'),
      note('确认来自真实结果', '发出请求或收到 RPC 回话不等于奖励到账；业务确认后才记为已确认。'),
      note('结果未知时', '不重发原领取，不删除旧账，也不把未知改成成功；重新连接并读取当前可信状态后独立判断当前资格。', 'warning')
    ]),
    'orders-state-help': panel('订单状态说明', '读数、执行与确认分别展示，方便理解等待原因。', [
      status('等待条件', '当前条件尚未满足，例如材料不足、等待成品或达到当日上限。'),
      status('状态待获取', '这次没读到必要状态；只限制依赖该状态的候选，不把未读到显示成 0。'),
      status('结果待核对', '原操作保留且不重发；重新连接读取当前可信状态，再规划当前合法业务。'),
      status('下次检查', '各类订单有独立安排，缺时间时显示“待获取”。'),
      note('当前在途串行', '同一游戏号真正正在进行的写操作保持串行，历史审计记录与当前执行资格分开。')
    ]),
    'art-detail': panel('花艺制作', '顾客需求优先，日常补货按指定名单和目标库存安排。', [
      toggle('art.makeEnabled', '做花艺', '开启后按官方配方逐件制作；一件需要消耗配花，做成后无法撤回。'),
      artPicker,
      action('成品目标库存', 'art-target', '日常补货到目标数量后停止。', { enableWhen: 'art.makeEnabled' }),
      toggle('art.autoReplenish', '自动补货', '顾客需求处理完后，低于目标库存的成品才补做；关闭后不为日常库存制作。', { enableWhen: 'art.makeEnabled' }),
      action('首做图鉴奖励', 'art-album', '按花瓶维度领取首做金币奖。'),
      action('首做分享奖励', 'art-share', '保留独立开关，不随订单视频单联动。'),
      action('顾客需求与库存状态', 'art-status', '区分没有需求和暂未读到需求。'),
      note('关闭制作后', '已经做好的成品仍可按顾客订单设置交付；只是不再继续生产。'),
      draftNote
    ]),
    'art-arts': panel('指定花艺', '日常补做和自动补货只在你指定的成品范围内进行。', [
      artPicker,
      note('配方用于区分同名成品', '同名花艺可能使用不同配花。选择时同时显示配方，避免混淆。'),
      note('顾客需求优先', '顾客明确需要的成品不受这份名单限制；空名单表示日常选品不设额外限制。')
    ]),
    'art-target': panel('成品目标库存', '每种成品保持多少件余量。', [
      artTarget,
      note('目标库存不是单次制作数量', '每件仍单独制作、确认后再安排下一件；日常补做达到目标即停。'),
      note('顾客缺货优先', '顾客订单缺几件就按实际需求补做，不受这个库存目标限制。')
    ]),
    'art-replenish': panel('自动补货', '顾客需求处理完后，再补日常库存。', [
      toggle('art.autoReplenish', '自动补货', '在可制作的花艺中按当前配花库存选择；每做完一件重新判断。', { enableWhen: 'art.makeEnabled' }),
      artTarget,
      action('指定补货范围', 'art-arts', '选择日常允许补做的花艺。', { enableWhen: 'art.makeEnabled' }),
      note('制作会消耗配花', '开启后，配花会持续转为成品，直到满足目标或不再具备制作条件。关闭不影响已有成品。', 'warning')
    ]),
    'art-album': panel('首做图鉴奖励', '每样花艺首次做成后，领取对应花瓶图鉴金币奖。', [
      toggle('art.firstAlbumClaim', '首做图鉴自动领', '需要“做花艺”开启；按花瓶维度判断，已领过的不重复领取。', { enableWhen: 'art.makeEnabled' }),
      note('领取后无法撤回', '领取不会消耗账号内道具；领取结果仍以官方确认作为依据。'),
      status('领取情况', '设计原型未读取官方花瓶图鉴，不虚构已领或可领数量。'),
      draftNote
    ]),
    'art-share': panel('首做分享奖励', '花艺首做分享使用自己的开关。', [
      toggle('art.firstShareClaim', '首做分享自动领取', '需要“做花艺”开启；不跟居民、绸缎或建材的视频单联动。', { enableWhen: 'art.makeEnabled' }),
      note('首次制作后判断', '每样新花艺的首次分享资格从官服确认；已经领取的不再重复领取。'),
      note('需要手动分享时', '官服不认可本次操作时停止这一笔，并明确显示“需要你手动分享”，不重复发送。', 'warning'),
      status('领取情况', '设计原型未连接官服，实际奖励和资格以当前官方结果为准。'),
      draftNote
    ]),
    'art-status': panel('花艺现场状态', '状态来源与当前需求一起展示。', [
      status('顾客等待', '当前未连接官服（设计原型），不声称存在或不存在缺货订单。'),
      status('已检查且没有需求', '正式 App 在本次查过顾客单且无缺成品时，才显示“当前没有待制作需求”。'),
      status('需求待获取', '尚未走到订单检查或名单未返回时，显示“尚未读到顾客需求”。'),
      status('库存读数', '区分本次读取、上一轮数据与尚未读取；没读到配花、花瓶或库存不等于做不了。'),
      note('优先顺序', '顾客订单缺货优先于日常自动补货。官方确认成品做成后，再叫醒订单交付。')
    ])
  };

  // 置顶说明仅在该模式显示；指定名单的模式门使用禁用态，保留已有选择。
  specs['plant-detail'].fields[4].showWhen = { key: 'plantMode', value: 'chosen_top' };
  specs['plant-mode'].fields[4].showWhen = { key: 'plantMode', value: 'chosen_top' };

  // 主屏入口使用短名称；旧描述性 ID 同样保留，子面板跳转不会失效。
  const aliases = {
    'flower-picker': 'plant-flowers', 'quality-picker': 'plant-qualities',
    blacklist: 'plant-blacklist', restock: 'plant-target',
    'order-resident': 'resident-detail', 'order-satin': 'satin-detail',
    'order-decorate': 'decorate-detail', 'order-customer': 'customer-detail',
    'order-palace': 'palace-detail', 'order-team': 'team-detail',
    'daily-rewards': 'daily-detail', 'daily-reward-status': 'daily-status',
    'art-picker': 'art-arts'
  };
  Object.entries(aliases).forEach(([alias, original]) => { specs[alias] = specs[original]; });
  specs['daily-detail'].related = [
    { label: '奖励状态示例', target: 'daily-reward-status' },
    { label: '领取保护', target: 'daily-protection' }
  ];
  specs['art-detail'].related = [
    { label: '自动补货', target: 'art-replenish' },
    { label: '顾客依赖', target: 'customer-art-link' },
    { label: '现场状态', target: 'art-status' }
  ];

  window.GARDEN_PANEL_SPECS = Object.assign(window.GARDEN_PANEL_SPECS || {}, specs);
})();
