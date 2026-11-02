// Pure presentation metadata extracted from the retired engine-backed config
// runtime. This module reads the retained schema but performs no validation,
// normalization, execution or recovery decisions.

const SETTINGS_TABS = Object.freeze(['land', 'orders', 'art']);
const ORDER_GROUPS = Object.freeze(['resident', 'satin', 'decorate', 'customer', 'palace', 'team']);
const VIDEO_ORDER_GROUPS = Object.freeze(['resident', 'satin', 'decorate']);
const ORDER_MODULE = Object.freeze({
  resident: 'resident_orders', satin: 'satin_orders', decorate: 'decorate_orders',
  customer: 'customer_orders', palace: 'court_order', team: 'team_order',
});
const ORDER_FIELDS = Object.freeze([
  { group: 'resident', dto: 'enabled', key: 'enabled', type: 'switch' },
  { group: 'resident', dto: 'dailyLimit', key: 'daily_finish_limit', type: 'count' },
  { group: 'satin', dto: 'enabled', key: 'enabled', type: 'switch' },
  { group: 'satin', dto: 'dailyLimit', key: 'satin_finish_limit', type: 'count' },
  { group: 'decorate', dto: 'enabled', key: 'enabled', type: 'switch' },
  { group: 'decorate', dto: 'dailyLimit', key: 'decorate_finish_limit', type: 'count' },
  { group: 'customer', dto: 'enabled', key: 'enabled', type: 'switch' },
  { group: 'customer', dto: 'coinTiers', key: 'flower_shop_coin_amounts', type: 'qualities' },
  { group: 'customer', dto: 'autoReject', key: 'auto_reject', type: 'switch' },
  { group: 'palace', dto: 'enabled', key: 'enabled', type: 'switch' },
  { group: 'palace', dto: 'qualityFilter', key: 'quality_filter', type: 'qualities' },
  { group: 'team', dto: 'enabled', key: 'enabled', type: 'switch' },
  { group: 'team', dto: 'realWrite', key: 'real_team_order_write', type: 'switch' },
  { group: 'team', dto: 'allowFreeTake', key: 'allow_free_take', type: 'switch' },
  { group: 'team', dto: 'allowBuyAgain', key: 'allow_buy_again', type: 'switch' },
  { group: 'team', dto: 'buyAgainKeepYuanbao', key: 'buy_again_keep_yuanbao', type: 'count' },
]);
const ART_FIELDS = Object.freeze([
  { dto: 'makeEnabled', key: 'real_flower_art_make', type: 'switch' },
  { dto: 'specifiedArts', key: 'specified_arts', type: 'arts' },
  { dto: 'autoReplenish', key: 'auto_replenish', type: 'switch' },
  { dto: 'makeBatch', key: 'make_batch', type: 'count' },
  { dto: 'firstAlbumClaim', key: 'first_album_claim', type: 'switch' },
  { dto: 'firstShareClaim', key: 'first_share_claim', type: 'switch' },
]);

const schemaField = (schema, group, id, key) => {
  const definition = schema.ALL_MODULES.find(module => module.group === group && module.id === id);
  const item = definition?.fields?.find(field => field.key === key);
  if (!item) throw new Error('引擎配置表缺少字段定义：' + group + '.' + id + '.' + key);
  return item;
};
const numberSpec = item => ({
  min: Number(item.min || 0), max: item.max === undefined ? null : Number(item.max),
  default: Number(item.def), label: item.label, hint: item.hint || item.desc || null,
});

/** Presentation labels and ranges sourced from the retained schema. */
export function cardMetadata(schema) {
  const definition = schema.ALL_MODULES.find(module => module.group === 'plant' && module.id === 'land_plant');
  const field = key => definition.fields.find(item => item.key === key);
  const numberRange = key => numberSpec(field(key));
  const mode = field('plant_mode');
  const group = field('plots_per_flower');
  const orders = {};
  for (const name of ORDER_GROUPS) {
    const id = ORDER_MODULE[name], cards = {};
    for (const item of ORDER_FIELDS.filter(one => one.group === name)) {
      const itemDefinition = schemaField(schema, 'order', id, item.key);
      cards[item.dto] = item.type === 'count' ? numberSpec(itemDefinition)
        : item.type === 'select' ? { options: (itemDefinition.options || []).map(option => ({ value: String(option.value), label: option.label })) }
          : item.type === 'switch' ? { label: itemDefinition.label, hint: itemDefinition.hint || itemDefinition.desc || null, lockedWhen: itemDefinition.lockedWhen || null }
            : { label: itemDefinition.label, hint: itemDefinition.hint || itemDefinition.desc || null,
              options: (itemDefinition.options || []).map(option => ({ value: Number(option.value), label: option.label })) };
    }
    orders[name] = { id, label: schema.ALL_MODULES.find(module => module.group === 'order' && module.id === id).label, fields: cards };
  }
  const art = {};
  for (const item of ART_FIELDS) {
    const itemDefinition = schemaField(schema, 'plant', 'flower_art', item.key);
    art[item.dto] = item.type === 'count' ? numberSpec(itemDefinition)
      : item.type === 'switch' ? { label: itemDefinition.label, hint: itemDefinition.hint || itemDefinition.desc || null }
        : { label: itemDefinition.label, hint: itemDefinition.hint || itemDefinition.desc || null, source: itemDefinition.src || null };
  }
  const dailyRewardField = schemaField(schema, 'basic', 'daily_task', 'claim_task_rewards');
  return {
    tabs: SETTINGS_TABS,
    orderGroups: ORDER_GROUPS,
    videoGroups: VIDEO_ORDER_GROUPS,
    orders: { ...orders, videoNote: '开启所属订单总开关即启用该类的视频单流程，不提供独立视频开关。' },
    art,
    dailyTaskRewards: { label: '日常任务奖励', enabled: { label: dailyRewardField.label, hint: dailyRewardField.hint || dailyRewardField.desc || null } },
    plantMode: { options: mode.options.map(option => ({ value: String(option.value), label: option.label })), default: String(mode.def), label: mode.label, hint: mode.desc || null },
    groupSize: { options: group.options.map(option => Number(option.value)), default: Number(group.def), label: group.label, hint: group.hint || null },
    restockCount: numberRange('restock_count'),
    keepWater: numberRange('keep_water'),
    qualities: schema.QUALITIES.map(option => ({ value: Number(option.value), label: option.label })),
    labels: {
      plantEnabled: field('auto_plant').label,
      harvestEnabled: field('auto_harvest').label,
      waterEnabled: field('auto_water').label,
      plantFlowerIds: field('plant_chosen_flowers').label,
      plantFlowerIdsHint: field('plant_chosen_flowers').hint || null,
      plantQualities: field('plant_chosen_quality').label,
      plantQualitiesHint: field('plant_chosen_quality').hint || null,
      plantBlacklistIds: field('plant_blacklist').label,
      plantBlacklistIdsHint: field('plant_blacklist').hint || null,
    },
  };
}
