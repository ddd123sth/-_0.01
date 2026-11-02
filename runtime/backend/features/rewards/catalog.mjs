// Declarations shared by the 13 R10 cards. Execution lives in runtime.mjs; this
// file is the single place that names a card's feature id, methods, scopes and
// the dynamic facts it consumes.
export const REWARD_METHODS = Object.freeze({
  mailPick: 'mail.pickOneKey',
  benefitDraw: 'benefitBox.draw',
  dailyRecv: 'taskDly.recv',
  dailyBox: 'taskDly.recvBox',
  weeklyRecv: 'taskWeek.recv',
  share: 'usr.share',
  mainRecv: 'taskMain.recv',
  storyUnlock: 'storyMain.unlock',
  guildBuild: 'fml.bld',
  guildHarvest: 'fmlLand.harvestAll',
  guildPlant: 'fmlLand.plant',
  guildUnlock: 'fmlLand.unlock',
  guildUpgrade: 'fmlLand.upgrade',
  cultivateUpgrade: 'cultivate.upgrade',
  shopBuy: 'shopCultivate.buy',
  shopRefresh: 'shopCultivate.refresh',
});

export const SHARE_IDS = Object.freeze({ doubleCoin: 11, guildBuildVideo: 14 });

// One entry per card. `units` is what the scheduler iterates; each unit carries
// the exact scope/method pair the gateway will bind.
export const REWARD_CARDS = Object.freeze([
  Object.freeze({ featureId: 'cultivate.upgrade', label: '升级鲜花', configRoot: 'cultivateUpgrade',
    domains: ['cultivation', 'profile', 'inventory', 'clock'],
    methods: [REWARD_METHODS.cultivateUpgrade], scopes: ['cultivate-upgrade'],
    methodScopes: Object.freeze({ [REWARD_METHODS.cultivateUpgrade]: 'cultivate-upgrade' }),
    units: Object.freeze([{ scheduleKey: 'cultivate-upgrade', action: 'upgrade' }]) }),
  Object.freeze({ featureId: 'cultivate.shop', label: '材料商店', configRoot: 'materialShop',
    domains: ['reward-shop', 'profile', 'inventory', 'clock', 'cultivation'],
    methods: [REWARD_METHODS.shopBuy, REWARD_METHODS.shopRefresh], scopes: ['shop-buy', 'shop-refresh'],
    methodScopes: Object.freeze({ [REWARD_METHODS.shopBuy]: 'shop-buy', [REWARD_METHODS.shopRefresh]: 'shop-refresh' }),
    units: Object.freeze([{ scheduleKey: 'shop-buy', action: 'buy' }, { scheduleKey: 'shop-refresh', action: 'refresh' }]) }),
  Object.freeze({ featureId: 'reward.mail', label: '邮件', configRoot: 'mail', postReadMode: 'mail-list',
    domains: ['reward-mail', 'inventory', 'profile'],
    methods: [REWARD_METHODS.mailPick], scopes: ['mail-pick'],
    methodScopes: Object.freeze({ [REWARD_METHODS.mailPick]: 'mail-pick' }),
    units: Object.freeze([{ scheduleKey: 'mail-pick', action: 'pick' }]) }),
  Object.freeze({ featureId: 'reward.benefit-box', label: '福利宝箱', configRoot: 'benefitBox',
    domains: ['reward-box', 'inventory', 'profile'],
    methods: [REWARD_METHODS.benefitDraw], scopes: ['benefit-box-draw'],
    methodScopes: Object.freeze({ [REWARD_METHODS.benefitDraw]: 'benefit-box-draw' }),
    units: Object.freeze([{ scheduleKey: 'benefit-box-draw', action: 'draw' }]) }),
  Object.freeze({ featureId: 'reward.daily-task', label: '每日任务', configRoot: 'dailyTaskRewards',
    domains: ['reward-tasks', 'profile'],
    methods: [REWARD_METHODS.dailyRecv], scopes: ['daily-task-recv'],
    methodScopes: Object.freeze({ [REWARD_METHODS.dailyRecv]: 'daily-task-recv' }),
    units: Object.freeze([{ scheduleKey: 'daily-task-recv', action: 'recv' }]) }),
  Object.freeze({ featureId: 'reward.daily-box', label: '日常任务宝箱', configRoot: 'dailyTaskBox',
    domains: ['reward-tasks', 'inventory', 'profile'],
    methods: [REWARD_METHODS.dailyBox], scopes: ['daily-box-recv'],
    methodScopes: Object.freeze({ [REWARD_METHODS.dailyBox]: 'daily-box-recv' }),
    units: Object.freeze([{ scheduleKey: 'daily-box-recv', action: 'recv' }]) }),
  Object.freeze({ featureId: 'reward.weekly-task', label: '每周任务', configRoot: 'weeklyTask',
    domains: ['reward-tasks', 'profile'],
    methods: [REWARD_METHODS.weeklyRecv], scopes: ['weekly-task-recv'],
    methodScopes: Object.freeze({ [REWARD_METHODS.weeklyRecv]: 'weekly-task-recv' }),
    units: Object.freeze([{ scheduleKey: 'weekly-task-recv', action: 'recv' }]) }),
  Object.freeze({ featureId: 'reward.free-gift', label: '免费元宝礼包', configRoot: 'freeYuanbaoGift',
    domains: ['reward-giftbag', 'reward-share', 'inventory', 'profile', 'clock'],
    methods: [REWARD_METHODS.share], scopes: ['free-gift-share'],
    methodScopes: Object.freeze({ [REWARD_METHODS.share]: 'free-gift-share' }),
    units: Object.freeze([{ scheduleKey: 'free-gift-share', action: 'claim' }]) }),
  Object.freeze({ featureId: 'reward.double-coin', label: '双倍金币', configRoot: 'doubleCoin',
    domains: ['reward-double', 'reward-share', 'inventory', 'profile', 'clock'],
    methods: [REWARD_METHODS.share], scopes: ['double-coin-share'],
    methodScopes: Object.freeze({ [REWARD_METHODS.share]: 'double-coin-share' }),
    units: Object.freeze([{ scheduleKey: 'double-coin-share', action: 'renew' }]) }),
  Object.freeze({ featureId: 'reward.main-task', label: '主线领奖', configRoot: 'mainTask',
    domains: ['reward-tasks', 'inventory', 'profile', 'clock'],
    methods: [REWARD_METHODS.mainRecv], scopes: ['main-task-recv'],
    methodScopes: Object.freeze({ [REWARD_METHODS.mainRecv]: 'main-task-recv' }),
    units: Object.freeze([{ scheduleKey: 'main-task-recv', action: 'recv' }]) }),
  Object.freeze({ featureId: 'reward.main-story', label: '主线剧情解锁', configRoot: 'mainStory',
    domains: ['reward-story', 'profile', 'clock'],
    methods: [REWARD_METHODS.storyUnlock], scopes: ['story-unlock'],
    methodScopes: Object.freeze({ [REWARD_METHODS.storyUnlock]: 'story-unlock' }),
    units: Object.freeze([{ scheduleKey: 'story-unlock', action: 'unlock' }]) }),
  Object.freeze({ featureId: 'guild.build.video', label: '公会建设', configRoot: 'guildBuild',
    domains: ['reward-guild', 'reward-share', 'inventory', 'profile', 'clock'],
    methods: [REWARD_METHODS.share], scopes: ['guild-build-video'],
    methodScopes: Object.freeze({ [REWARD_METHODS.share]: 'guild-build-video' }),
    units: Object.freeze([{ scheduleKey: 'guild-build-video', action: 'video' }]) }),
  Object.freeze({ featureId: 'guild.build.gold', label: '公会建设', configRoot: 'guildBuild',
    domains: ['reward-guild', 'inventory', 'profile', 'clock'],
    methods: [REWARD_METHODS.guildBuild], scopes: ['guild-build-gold'],
    methodScopes: Object.freeze({ [REWARD_METHODS.guildBuild]: 'guild-build-gold' }),
    units: Object.freeze([{ scheduleKey: 'guild-build-gold', action: 'gold' }]) }),
  Object.freeze({ featureId: 'guild.build.yuanbao', label: '公会建设', configRoot: 'guildBuild',
    domains: ['reward-guild', 'inventory', 'profile', 'clock'],
    methods: [REWARD_METHODS.guildBuild], scopes: ['guild-build-yuanbao'],
    methodScopes: Object.freeze({ [REWARD_METHODS.guildBuild]: 'guild-build-yuanbao' }),
    units: Object.freeze([{ scheduleKey: 'guild-build-yuanbao', action: 'yuanbao' }]) }),
  Object.freeze({ featureId: 'guild.land', label: '公会地', configRoot: 'guildLand',
    domains: ['reward-guild', 'cultivation', 'inventory', 'profile', 'clock'],
    methods: [REWARD_METHODS.guildHarvest, REWARD_METHODS.guildPlant, REWARD_METHODS.guildUnlock, REWARD_METHODS.guildUpgrade],
    scopes: ['guild-harvest', 'guild-plant', 'guild-unlock', 'guild-upgrade'],
    methodScopes: Object.freeze({ [REWARD_METHODS.guildHarvest]: 'guild-harvest', [REWARD_METHODS.guildPlant]: 'guild-plant',
      [REWARD_METHODS.guildUnlock]: 'guild-unlock', [REWARD_METHODS.guildUpgrade]: 'guild-upgrade' }),
    units: Object.freeze([{ scheduleKey: 'guild-harvest', action: 'harvest' }, { scheduleKey: 'guild-plant', action: 'plant' },
      { scheduleKey: 'guild-unlock', action: 'unlock' }, { scheduleKey: 'guild-upgrade', action: 'upgrade' }]) }),
]);

// `fml.bld` serves both gold and yuanbao scopes; the registry requires an exact
// one-to-one scope/method pairing, so a feature with several actions declares
// its pairs explicitly and this table records the double binding for guild
// build (one method, two scopes) for the admission code.
export const GUILD_BUILD_SCOPES = Object.freeze(['guild-build-video', 'guild-build-gold', 'guild-build-yuanbao']);
export const GUILD_BUILD_ROWS = Object.freeze({ 'guild-build-video': 1, 'guild-build-gold': 2, 'guild-build-yuanbao': 3 });
export const GUILD_BUILD_COST_ITEMS = Object.freeze({ gold: 11, yuanbao: 1 });

export const CLAIM_TABLE_NAMES = Object.freeze(['c_task_dly', 'c_task_week', 'c_task_main', 'c_flowerLvl',
  'c_flowerLvlCfg', 'c_shop_cultivate', 'c_shop_giftbag', 'c_fmlBld', 'c_fmlLand', 'c_fmlLandLvl', 'c_share', 'c_item',
  'c_open', 'c_storyMainSection', 'c_storyMainChapter', 'c_gameCfg']);

export const CARD_BY_FEATURE = Object.freeze(Object.fromEntries(REWARD_CARDS.map(card => [card.featureId, card])));
export const CARD_BY_SCHEDULE = Object.freeze(Object.fromEntries(REWARD_CARDS.flatMap(card =>
  card.units.map(unit => [unit.scheduleKey, { card, unit }]))));

export const CONFIG_ENABLED = Object.freeze({
  'cultivate.upgrade': config => config?.cultivateUpgrade?.enabled === true,
  'cultivate.shop': config => config?.materialShop?.enabled === true,
  'reward.mail': config => config?.mail?.enabled === true,
  'reward.benefit-box': config => config?.benefitBox?.enabled === true,
  'reward.daily-task': config => config?.dailyTaskRewards?.enabled === true,
  'reward.daily-box': config => config?.dailyTaskBox?.enabled === true,
  'reward.weekly-task': config => config?.weeklyTask?.enabled === true,
  'reward.free-gift': config => config?.freeYuanbaoGift?.enabled === true,
  'reward.double-coin': config => config?.doubleCoin?.enabled === true,
  'reward.main-task': config => config?.mainTask?.enabled === true,
  'reward.main-story': config => config?.mainStory?.enabled === true,
  'guild.build.video': config => config?.guildBuild?.enabled === true,
  'guild.build.gold': config => config?.guildBuild?.enabled === true,
  'guild.build.yuanbao': config => config?.guildBuild?.enabled === true,
  'guild.land': config => config?.guildLand?.enabled === true,
});