/* R10 reward/upgrade cards. Presentation only: every field is a real config DTO
   path, and the sheet still merges through the host's parent/child transaction. */
const number = (key, label, description, extra = {}) => ({ type: 'number', key, label, description,
  integer: true, required: true, ...extra });
const toggle = (key, label, description) => ({ type: 'toggle', key, label, description });

export const REWARD_PANEL_SPECS = Object.freeze({
  'reward-main-task': Object.freeze({ title: '领取主线任务奖励', group: '任务福利', kind: 'sheet', scope: 'config',
    subtitle: '只领取当前主线已达标的一环，不代替完成主线任务。',
    fields: Object.freeze([number('mainTask.maxRewardsPerMinute', '每分钟最多领几次主线奖励',
      '按官方分钟窗口计数；到上限后等下一分钟自动继续。', { min: 1, max: 30, unit: '次' })]) }),
  'reward-main-story': Object.freeze({ title: '解锁主线剧情', group: '任务福利', kind: 'sheet', scope: 'config',
    subtitle: '消耗背包里的剧情星星解锁下一节；星星不够时只等待，不会花元宝。',
    fields: Object.freeze([number('mainStory.maxUnlocksPerDay', '每天最多解锁几节',
      '填0时按1节执行；暂停请关闭剧情解锁开关。', { min: 0, max: 30, unit: '节' })]) }),
  'guild-build': Object.freeze({ title: '公会建设', group: '公会', kind: 'sheet', scope: 'config',
    subtitle: '视频、金币、元宝三档各自独立；金币和元宝受官方每日共用次数限制。',
    fields: Object.freeze([
      toggle('guildBuild.videoEnabled', '视频建设', '使用公会建设中的视频建设方式，按游戏可用次数执行。'),
      toggle('guildBuild.goldEnabled', '金币建设', '每次消耗号里的金币，按官方表价。'),
      toggle('guildBuild.yuanbaoEnabled', '元宝建设', '每次消耗号里的元宝；默认关闭。'),
      number('guildBuild.goldDailyCount', '金币建设每天做几次', '超过官方同档每日次数时按官方上限。', { min: 0, max: 100, unit: '次' }),
      number('guildBuild.yuanbaoTimesPerDay', '元宝建设每天做几次', '0 表示不做；元宝只从号内已有余额扣，不充值。', { min: 0, max: 100, unit: '次' }),
    ]) }),
  'guild-land': Object.freeze({ title: '公会地', group: '公会', kind: 'sheet', scope: 'config',
    subtitle: '收获、种植、升级、解锁分开设置；种子和种植不扣公会币。',
    fields: Object.freeze([
      toggle('guildLand.harvestEnabled', '自动收获', '公会地成熟后自动收取。'),
      toggle('guildLand.plantEnabled', '自动种植', '空地按选花策略自动种上。'),
      toggle('guildLand.upgradeEnabled', '自动升级土地', '消耗公会币升级，保留设定余量。'),
      toggle('guildLand.unlockEnabled', '自动解锁土地', '达到公会等级并留够公会币后解锁。'),
      number('guildLand.unlockKeepGuildCoin', '解锁保留公会币', '0 表示不保留。', { min: 0 }),
      number('guildLand.upgradeKeepGuildCoin', '升级保留公会币', '0 表示不保留。', { min: 0 }),
      { type: 'select', key: 'guildLand.plantMode', label: '选花策略',
        options: [{ value: 'least_stock', label: '库存少优先' }, { value: 'chosen_flowers', label: '指定花朵' }] },
      { type: 'picker', key: 'guildLand.plantFlowerIds', label: '指定花朵', catalog: 'flowers',
        description: '仅“指定花朵”策略生效。', showWhen: { key: 'guildLand.plantMode', value: 'chosen_flowers' } },
      { type: 'picker', key: 'guildLand.plantBlacklistIds', label: '黑名单花朵', catalog: 'flowers',
        description: '所有策略都排除这些花。' },
      { type: 'chips', key: 'guildLand.plantQualities', label: '花品质范围', catalog: 'qualities', multiple: true },
      number('guildLand.minFlowerLevel', '最低花等级', '只种达到该等级的已培育花。', { min: 1, max: 70, unit: '级' }),
    ]) }),
  'cultivate-upgrade': Object.freeze({ title: '升级鲜花', group: '花园', kind: 'sheet', scope: 'config',
    subtitle: '用每朵花自己的精华和金币升到目标等级；材料不够时自动等待。',
    fields: Object.freeze([number('cultivateUpgrade.targetLevel', '目标等级',
      '达到目标等级后停止升级；上限按官方表。', { min: 1, max: 70, unit: '级' })]) }),
  'material-shop': Object.freeze({ title: '材料商店', group: '花园', kind: 'sheet', scope: 'config',
    subtitle: '按服务器下发的价格和限购逐格购买；免费刷新只在货架买空时使用。',
    fields: Object.freeze([
      toggle('materialShop.freeRefresh', '免费刷新', '每天官方免费次数内，买空后刷新货架。'),
      number('materialShop.maxBuyPerMinute', '每分钟最多买几次', '按官方分钟窗口计数。', { min: 0, max: 60, unit: '次' }),
      number('materialShop.keepGold', '金币下限', '金币低于该值时不再购买。', { min: 0 }),
    ]) }),
});

export const REWARD_PANEL_IDS = Object.freeze(Object.keys(REWARD_PANEL_SPECS));
