// This is the current UI's compatibility projection, not the execution allowlist.
// All business interpretation belongs to the new feature contracts.
export const CONFIG_DTO_VERSION = 3;
export const CONFIG_INTERPRETATION_VERSION = 1;
export const PLANT_MODES = Object.freeze(['least_stock', 'chosen_flowers', 'chosen_quality', 'chosen_top']);
export const DAILY_ART_MODES = Object.freeze(['least_stock', 'chosen_quality', 'chosen_arts']);
export const GROUP_SIZES = Object.freeze([4, 8, 16, 32, 64]);

const field = (dtoPath, documentPath, type, defaultValue, featureId, extra = {}) => Object.freeze({
  dtoPath, documentPath, type, defaultValue, featureId, ...extra,
});
const land = (dto, key, type, value, feature, extra) => field(dto, `plant.land_plant.${key}`, type, value, feature, extra);
const order = (group, dto, module, key, type, value, extra) => field(`orders.${group}.${dto}`, `order.${module}.${key}`, type, value, `order.${group}`, extra);
const art = (dto, key, type, value, extra) => field(`art.${dto}`, `plant.flower_art.${key}`, type, value, 'art.make', extra);
const dailyArt = (dto, key, type, value, extra) => field(`art.${dto}`, `plant.flower_art.${key}`, type, value, 'art.daily', extra);
const rack = (dto, key, type, value, extra = {}) => field(`flowerRack.${dto}`, `plant.flower_rack.${key}`, type, value, 'flower-rack', extra);

export const CONFIG_FIELDS = Object.freeze([
  land('plantEnabled', 'auto_plant', 'boolean', false, 'plant'),
  land('plantMode', 'plant_mode', 'enum', 'least_stock', 'plant', { values: PLANT_MODES }),
  land('plantFlowerIds', 'plant_chosen_flowers', 'ids', [], 'plant', { catalog: 'flowerIds' }),
  land('plantQualities', 'plant_chosen_quality', 'ids', [], 'plant', { values: [1, 2, 3, 4, 5] }),
  land('groupSize', 'plots_per_flower', 'enum', 8, 'plant', { values: GROUP_SIZES }),
  land('plantBlacklistIds', 'plant_blacklist', 'ids', [], 'plant', { catalog: 'flowerIds' }),
  land('restockCount', 'restock_count', 'integer', 0, 'plant', { min: 0 }),
  land('harvestEnabled', 'auto_harvest', 'boolean', false, 'harvest'),
  land('waterEnabled', 'auto_water', 'boolean', false, 'water'),
  land('keepWater', 'keep_water', 'integer', 0, 'water', { min: 0 }),
  land('waterwheelEnabled', 'waterwheel_recv_enabled', 'boolean', false, 'waterwheel'),
  land('freeWaterEnabled', 'free_water_recv_enabled', 'boolean', false, 'free-water'),
  rack('enabled', 'enabled', 'boolean', false),
  rack('autoTakeDown', 'auto_take_down', 'boolean', false),
  rack('unlockEnabled', 'unlock_enabled', 'boolean', false),
  rack('sortStrategy', 'sort_strategy', 'enum', 'max_stock', { values: ['max_stock', 'min_stock', 'max_price'] }),
  rack('artIds', 'art_ids', 'ids', [], { catalog: 'artIds' }),
  rack('putCount', 'put_count', 'integer', 1, { min: 1, max: 12 }),
  rack('keepMinutes', 'keep_minutes', 'integer', 20, { min: 1, max: 1440 }),
  rack('unlockKeepGold', 'unlock_keep_gold', 'integer', 0, { min: 0 }),
  land('accelerationMode', 'acceleration_mode', 'enum', 'off', 'land.acceleration', { values: ['off', 'card', 'free'] }),
  land('speedCardKeep', 'acceleration_card_keep', 'integer', 0, 'land.acceleration', { min: 0 }),
  order('resident', 'enabled', 'resident_orders', 'enabled', 'boolean', false),
  order('resident', 'dailyLimit', 'resident_orders', 'daily_finish_limit', 'integer', 1200, { min: 0, max: 1200 }),
  order('satin', 'enabled', 'satin_orders', 'enabled', 'boolean', false),
  order('satin', 'dailyLimit', 'satin_orders', 'satin_finish_limit', 'integer', 120, { min: 0, max: 120 }),
  order('decorate', 'enabled', 'decorate_orders', 'enabled', 'boolean', false),
  order('decorate', 'dailyLimit', 'decorate_orders', 'decorate_finish_limit', 'integer', 120, { min: 0, max: 120 }),
  order('customer', 'enabled', 'customer_orders', 'enabled', 'boolean', false),
  order('customer', 'coinTiers', 'customer_orders', 'flower_shop_coin_amounts', 'ids', [1, 2, 3], { values: [1, 2, 3] }),
  order('customer', 'autoReject', 'customer_orders', 'auto_reject', 'boolean', false),
  order('palace', 'enabled', 'court_order', 'enabled', 'boolean', false),
  order('palace', 'qualityFilter', 'court_order', 'quality_filter', 'ids', [], { values: [1, 2, 3, 4, 5] }),
  order('team', 'enabled', 'team_order', 'enabled', 'boolean', false),
  order('team', 'realWrite', 'team_order', 'real_team_order_write', 'boolean', false),
  order('team', 'allowFreeTake', 'team_order', 'allow_free_take', 'boolean', false),
  order('team', 'allowBuyAgain', 'team_order', 'allow_buy_again', 'boolean', false),
  order('team', 'buyAgainKeepYuanbao', 'team_order', 'buy_again_keep_yuanbao', 'integer', 0, { min: 0 }),
  art('makeEnabled', 'real_flower_art_make', 'boolean', false, { affectedFeatureIds: ['art.customer-batch'] }),
dailyArt('specifiedArts', 'specified_arts', 'ids', [], { catalog: 'artIds' }),
dailyArt('autoReplenish', 'auto_replenish', 'boolean', false),
  dailyArt('dailyMode', 'daily_mode', 'enum', 'least_stock', { values: DAILY_ART_MODES }),
  dailyArt('dailyQualities', 'daily_qualities', 'ids', [], { values: [1, 2, 3, 4, 5] }),
  dailyArt('targetStock', 'target_stock', 'integer', 1, { min: 1, max: 999 }),
  dailyArt('makeBatch', 'make_batch', 'integer', 1, { min: 1, max: 999 }),
  art('firstAlbumClaim', 'first_album_claim', 'boolean', false, { affectedFeatureIds: ['art.first-album'] }),
  art('firstShareClaim', 'first_share_claim', 'boolean', false, { affectedFeatureIds: ['art.first-share'] }),
  dailyArt('dailyMakeEnabled', 'daily_make_enabled', 'boolean', false),
  field('dailyTaskRewards.enabled', 'basic.daily_task.claim_task_rewards', 'boolean', false, 'reward.daily-task'),
  field('mail.enabled', 'basic.mail.enabled', 'boolean', false, 'reward.mail'),
  field('benefitBox.enabled', 'basic.welfare_box.enabled', 'boolean', false, 'reward.benefit-box'),
  field('dailyTaskBox.enabled', 'basic.daily_task_box.enabled', 'boolean', false, 'reward.daily-box'),
  field('weeklyTask.enabled', 'basic.weekly_task.enabled', 'boolean', false, 'reward.weekly-task'),
  field('freeYuanbaoGift.enabled', 'basic.giftbag_free_yuanbao.enabled', 'boolean', false, 'reward.free-gift'),
  field('doubleCoin.enabled', 'basic.double_coin.enabled', 'boolean', false, 'reward.double-coin'),
  field('mainTask.enabled', 'basic.main_task.enabled', 'boolean', false, 'reward.main-task'),
  field('mainTask.maxRewardsPerMinute', 'basic.main_task.max_recv_per_minute', 'integer', 1, 'reward.main-task', { min: 1, max: 30 }),
  field('mainStory.enabled', 'basic.story_main.enabled', 'boolean', false, 'reward.main-story'),
  field('mainStory.maxUnlocksPerDay', 'basic.story_main.max_unlock_per_day', 'integer', 1, 'reward.main-story', { min: 0, max: 30 }),
  field('guildBuild.enabled', 'basic.guild_build.enabled', 'boolean', false, 'guild.build.video', { affectedFeatureIds: ['guild.build.gold', 'guild.build.yuanbao'] }),
  field('guildBuild.videoEnabled', 'basic.guild_build.video_enabled', 'boolean', true, 'guild.build.video'),
  field('guildBuild.goldEnabled', 'basic.guild_build.gold_enabled', 'boolean', true, 'guild.build.gold'),
  field('guildBuild.yuanbaoEnabled', 'basic.guild_build.yuanbao_enabled', 'boolean', false, 'guild.build.yuanbao'),
  field('guildBuild.goldDailyCount', 'basic.guild_build.gold_daily_count', 'integer', 5, 'guild.build.gold', { min: 0, max: 100 }),
  field('guildBuild.yuanbaoTimesPerDay', 'basic.guild_build.yuanbao_daily_count', 'integer', 0, 'guild.build.yuanbao', { min: 0, max: 100 }),
  field('guildLand.enabled', 'guild.land_enabled', 'boolean', false, 'guild.land'),
  field('guildLand.harvestEnabled', 'guild.land_harvest', 'boolean', true, 'guild.land'),
  field('guildLand.plantEnabled', 'guild.land_plant', 'boolean', true, 'guild.land'),
  field('guildLand.upgradeEnabled', 'guild.land_auto_upgrade', 'boolean', false, 'guild.land'),
  field('guildLand.unlockEnabled', 'guild.land_auto_unlock', 'boolean', false, 'guild.land'),
  field('guildLand.unlockKeepGuildCoin', 'guild.land_unlock_keep_guild_coin', 'integer', 0, 'guild.land', { min: 0 }),
  field('guildLand.upgradeKeepGuildCoin', 'guild.land_upgrade_keep_guild_coin', 'integer', 0, 'guild.land', { min: 0 }),
  field('guildLand.plantMode', 'guild.land_plant_mode', 'enum', 'least_stock', 'guild.land', { values: ['least_stock', 'chosen_flowers'] }),
  field('guildLand.plantFlowerIds', 'guild.land_plant_flowers', 'ids', [], 'guild.land', { catalog: 'flowerIds' }),
  field('guildLand.plantBlacklistIds', 'guild.land_plant_blacklist', 'ids', [], 'guild.land', { catalog: 'flowerIds' }),
  field('guildLand.plantQualities', 'guild.land_plant_qualities', 'ids', [], 'guild.land', { values: [1, 2, 3, 4, 5] }),
  field('guildLand.minFlowerLevel', 'guild.land_min_flower_level', 'integer', 1, 'guild.land', { min: 1, max: 70 }),
  field('cultivateUpgrade.enabled', 'basic.cultivate_upgrade.enabled', 'boolean', false, 'cultivate.upgrade'),
  field('cultivateUpgrade.targetLevel', 'basic.cultivate_upgrade.target_level', 'integer', 20, 'cultivate.upgrade', { min: 1, max: 70 }),
  field('materialShop.enabled', 'basic.material_shop.enabled', 'boolean', false, 'cultivate.shop'),
  field('materialShop.freeRefresh', 'basic.material_shop.free_refresh', 'boolean', true, 'cultivate.shop'),
  field('materialShop.maxBuyPerMinute', 'basic.material_shop.max_buy_per_minute', 'integer', 3, 'cultivate.shop', { min: 0, max: 60 }),
  field('materialShop.keepGold', 'basic.material_shop.keep_gold', 'integer', 0, 'cultivate.shop', { min: 0 }),
]);

export const CONFIG_FEATURE_IDS = Object.freeze([...new Set(CONFIG_FIELDS.flatMap(item => [item.featureId, ...(item.affectedFeatureIds || [])]))]);

export class ConfigError extends Error {
  constructor(message, { code = 'CONFIG_INVALID', status = 400, details = null } = {}) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const cloneJson = value => JSON.parse(JSON.stringify(value));
export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export function atPath(root, dotted) {
  let node = root;
  for (const key of dotted.split('.')) {
    if (!isRecord(node) || !Object.hasOwn(node, key)) return { present: false, value: undefined };
    node = node[key];
  }
  return { present: true, value: node };
}

export function putPath(root, dotted, value) {
  const parts = dotted.split('.');
  let node = root;
  for (const key of parts.slice(0, -1)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new ConfigError('设置路径不合法');
    if (!Object.hasOwn(node, key) || !isRecord(node[key])) node[key] = {};
    node = node[key];
  }
  node[parts.at(-1)] = cloneJson(value);
}

export function validateFieldValue(definition, value, catalogs = {}) {
  const invalid = message => { throw new ConfigError(`${definition.dtoPath}：${message}`, { details: { path: definition.dtoPath } }); };
  if (definition.type === 'boolean') {
    if (typeof value !== 'boolean') invalid('必须是明确的开关值');
    return value;
  }
  if (definition.type === 'enum') {
    if (!definition.values.includes(value)) invalid('不在当前可选范围');
    return value;
  }
  if (definition.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < definition.min || (definition.max !== undefined && value > definition.max)) invalid('必须是范围内的安全整数');
    return value;
  }
  if (!Array.isArray(value) || value.some(id => !Number.isSafeInteger(id) || id <= 0)) invalid('必须是正整数ID集合');
  if (definition.values && value.some(id => !definition.values.includes(id))) invalid('含未声明的选项');
  const catalog = definition.catalog && catalogs[definition.catalog];
  if (catalog && value.some(id => !catalog.has(id))) invalid('含当前官方目录不认识的ID');
  // Retain order for the existing UI's exact PUT -> GET comparison. Feature
  // change detection separately compares set semantics for these ID fields.
  return [...new Set(value)];
}

export function factoryConfig() {
  const value = { configVersion: CONFIG_DTO_VERSION };
  for (const definition of CONFIG_FIELDS) putPath(value, definition.dtoPath, definition.defaultValue);
  return value;
}
