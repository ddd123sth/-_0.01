/* Presentation only. Keep the real config keys, independent switches and draft transactions. */
const INTRO = {
  'plant-detail': '按所选范围自动补种，优先种库存少的花。',
  'plant-mode': '选择参与种植的花种范围。',
  'plant-groups': '同组种同一种花，调整从下一批空地生效。',
  'plant-target': '达到库存目标后停止补种。', restock: '达到库存目标后停止补种。',
  'plant-blacklist': '选中的花不参与任何模式的种植。', blacklist: '选中的花不参与任何模式的种植。',
  'plant-flowers': '选择允许种植的花朵。', 'flower-picker': '选择允许种植的花朵。',
  'plant-qualities': '只种选中品质的花。', 'quality-picker': '只种选中品质的花。',
  'water-detail': '按需浇水，并保留设定的水滴余量。',
  'harvest-detail': '同组花朵全部成熟后，自动一起收获。',
  'resident-detail': '材料充足时，自动交付居民普通单和视频单。',
  'satin-detail': '材料充足时，自动交付绸缎普通单和视频单。',
  'decorate-detail': '材料充足时，自动交付建材普通单和视频单。',
  'customer-detail': '自动交付所选花坊币档位的顾客订单。',
  'palace-detail': '自动交付未被排除品质的宫廷订单，不自动刷新。',
  'team-detail': '自动处理接单、交花、领奖和取回存单。',
  'daily-detail': '自动领取已达标的日常任务奖励，不代做任务。',
  'daily-rewards': '自动领取已达标的日常任务奖励，不代做任务。',
  'art-detail': '顾客缺货时补做成品，也可自动补充日常库存。',
  'art-album': '自动领取花艺首次做成后的图鉴经验奖励。',
  'art-share': '符合游戏资格时，自动领取花艺首做分享奖励。',
  'flower-rack-detail': '自动摆放可售成品，并领取售出收益。',
  'flower-rack-cancel': '保留指定时间后，在游戏允许下架时取回成品。',
  'flower-rack-unlock': '消耗金币解锁新花架，并保留设定余量。',
  'reward-main-task': '从游戏的主线任务中领取已达标奖励；不会自动完成任务要求。',
  'reward-main-story': '在主线剧情中使用背包里的剧情星星解锁下一节；星星不足时等待。',
  'guild-build': '在公会建设中按所选方式自动建设；金币和元宝建设会扣除对应余额。',
  'guild-land': '收获、种植、升级、解锁分开设置；种子和种植不扣公会币。',
  'cultivate-upgrade': '在花朵培养中消耗该花精华和金币，自动升到目标等级；材料不足时等待。',
  'material-shop': '自动购买材料商店中的培养材料，按商店价格扣费，并保留设定的金币。',
};
const HELP = {
  keepWater: '0 表示不保留水滴。', restockCount: '0 表示不限；库存最少模式不使用此目标。',
  groupSize: '从下一批空地生效。', speedCardKeep: '会消耗加速卡；0 表示不保留。',
  'orders.customer.coinTiers': '不选档位时，不接顾客订单。',
  'orders.customer.autoReject': '拒绝未选档位或确认无法补做的订单。',
  'orders.palace.qualityFilter': '选中即不交；不选则均可交。',
  'orders.team.allowBuyAgain': '开启后会消耗元宝。',
  'orders.team.buyAgainKeepYuanbao': '0 表示不保留元宝。',
  'flowerRack.artIds': '不选时，使用全部可售成品。',
  'flowerRack.unlockKeepGold': '0 表示不保留金币。',
  'art.specifiedArts': '仅限制日常补货；指定花艺模式下至少选一项。',
  'mainTask.maxRewardsPerMinute': '达到上限后，下一分钟继续领取已达标奖励。',
  'mainStory.maxUnlocksPerDay': '填0时按1节执行；暂停请关闭“解锁主线剧情”。',
  'cultivateUpgrade.targetLevel': '每朵花达到此等级后停止升级。',
  'materialShop.freeRefresh': '货架买空后，在游戏允许的免费次数内刷新。',
  'materialShop.maxBuyPerMinute': '填0时按3次执行；暂停请关闭材料商店开关。',
  'materialShop.keepGold': '购买后至少保留这些金币；0 表示不保留。',
  'guildBuild.videoEnabled': '使用公会建设中的视频建设方式。',
  'guildBuild.goldEnabled': '按游戏价格消耗金币建设。',
  'guildBuild.yuanbaoEnabled': '按游戏价格消耗元宝建设。',
  'guildBuild.goldDailyCount': '0 表示不做金币建设，实际次数受游戏上限限制。',
  'guildBuild.yuanbaoTimesPerDay': '0 表示不做元宝建设，实际次数受游戏上限限制。',
};
const LABEL = { speedCardKeep: '保留加速卡张数', restockCount: '每种花库存目标',
  'art.targetStock': '补货目标库存', 'art.makeBatch': '每次补货数量',
  'mainTask.maxRewardsPerMinute': '每分钟领奖上限', 'mainStory.maxUnlocksPerDay': '每日解锁上限',
  'guildBuild.goldDailyCount': '每日金币建设次数', 'guildBuild.yuanbaoTimesPerDay': '每日元宝建设次数',
  'materialShop.maxBuyPerMinute': '每分钟购买上限' };
// One owner per switch: these controls already live on the corresponding settings page.
const PAGE_SWITCHES = new Set(['plantEnabled', 'waterEnabled', 'harvestEnabled',
  'waterwheelEnabled', 'freeWaterEnabled', 'dailyTaskRewards.enabled',
  ...['resident', 'satin', 'decorate', 'customer', 'palace', 'team'].map(key => `orders.${key}.enabled`),
  'art.firstAlbumClaim', 'art.firstShareClaim',
  'mainTask.enabled', 'mainStory.enabled', 'guildBuild.enabled', 'guildLand.enabled',
  'cultivateUpgrade.enabled', 'materialShop.enabled']);

export function compactSettingsSpec(id, spec, tables) {
  const canonical = id.startsWith('order-') ? `${id.slice(6)}-detail` : id;
  if (spec.scope !== 'config' || !INTRO[canonical]) return spec;
  // Exclude page-owned switches from both the rendered form and the child draft's merge paths.
  let fields = spec.fields.filter(field => !PAGE_SWITCHES.has(field.key)).map(field => ({ ...field }));
  // Put the existing child controls in the same sheet; paths/validation still belong to the host.
  if (id === 'plant-detail') {
    // The main page owns this switch; completing parameter edits must not merge a stale copy of it.
    const replacements = { 'plant-mode': 'plant-mode', 'plant-groups': 'plant-groups',
      'plant-blacklist': 'plant-blacklist', 'plant-target': 'plant-target' };
    fields = fields.filter(field => field.key !== 'plantEnabled').flatMap(field => replacements[field.target]
      ? tables[replacements[field.target]].fields.filter(child => child.key).map(child => ({ ...child }))
      : [field]);
  }
  const settingFacts = fields.filter(field => field.type === 'status');
  fields = fields.filter(field => !['note', 'status'].includes(field.type)
    && !['orders-state-help', 'daily-protection', 'customer-art-link'].includes(field.target)).map(field => {
    const key = field.key;
    const next = { ...field, compactSettings: true,
      description: HELP[key] || (key?.endsWith('.dailyLimit') ? '0 表示不限。' : ''),
      help: '', options: field.options?.map(option => ({ ...option, description: '' })) };
    if (LABEL[key]) next.label = LABEL[key];
    if (key === 'art.dailyMode') next.options = [
      { value: 'least_stock', label: '库存少优先', description: '从所有花艺中，优先补库存最少的。' },
      { value: 'chosen_quality', label: '按指定品质补货', description: '只补所选品质，优先补库存最少的。' },
      { value: 'chosen_arts', label: '按指定花艺补货', description: '只补所选花艺，优先补库存最少的。' },
    ];
    if (key === 'plantQualities') { next.type = 'chips'; next.multiple = true; next.label = '选择种植品质'; }
    // Hide irrelevant controls without clearing their saved values or tying independent switches together.
    if (['plantFlowerIds', 'plantQualities', 'art.dailyQualities'].includes(key)) next.showWhen = field.enableWhen;
    if (key === 'speedCardKeep') next.showWhen = { key: 'accelerationMode', value: 'card' };
    if (key === 'restockCount') next.showWhen = { any: [
      { key: 'plantMode', value: 'chosen_flowers' }, { key: 'plantMode', value: 'chosen_quality' },
      { key: 'plantMode', value: 'chosen_top' } ] };
    if (key === 'orders.team.buyAgainKeepYuanbao') next.showWhen = 'orders.team.allowBuyAgain';
    if (key === 'art.specifiedArts' && id === 'art-detail') next.showWhen = { key: 'art.dailyMode', value: 'chosen_arts' };
    if (field.type === 'action') next.description = '';
    return next;
  });
  // The top-list mode uses the game's own list, rather than an editable local replacement.
  if (id === 'plant-detail' || id === 'plant-mode') fields.push({ type: 'note', compactSettings: true,
    label: '', description: '置顶花朵在游戏内调整。', showWhen: { key: 'plantMode', value: 'chosen_top' } });
  // Optional factual reads remain accessible without interrupting the settings form.
  const statusLinks = (spec.related || []).filter(link => link.target === 'art-status')
    .map(link => ({ type: 'action', label: '查看当前花艺状态', target: link.target, compactSettings: true }));
  return { ...spec, compactSettings: true, subtitle: INTRO[canonical], fields: [...fields, ...statusLinks], settingFacts, related: [],
    primary: { label: '完成', action: 'apply' }, secondary: null, tertiary: null };
}
