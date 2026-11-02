/* Turns the browser-dumped prototype panel tables into an ES module the APK can load.
   Content and field order come from docs/design/20261020 unchanged; production code only binds real data. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const raw = readFileSync('.runtime/moon-specs-raw.json', 'utf8');
const specs = JSON.parse(raw);
// Production-only configuration overlays are versioned here rather than in
// the frozen prototype dump. Re-emitting the Moon bundle therefore retains
// the independently implemented acceleration settings.
const productionFields = {
  'water-detail': [
    { type: 'toggle', key: 'waterwheelEnabled', label: '自动领取水车水桶', description: '默认关闭。普通水桶连续领完；有视频桶时按官服结果处理，领取到的水滴以独立后读为准。水车暂时没有桶时，按官服30秒产桶节奏再次检查。' },
    { type: 'toggle', key: 'freeWaterEnabled', label: '自动领取每日水滴', description: '默认关闭。仅在官服开放时段领取当天可领水滴；错过时段时，按官服漏领视频资格单独处理。' },
  ],
  'art-detail': [
    { type: 'toggle', key: 'art.makeEnabled', label: '顾客缺货制作', description: '按顾客订单需要逐件制作。' },
    { type: 'toggle', key: 'art.dailyMakeEnabled', label: '自动补货', description: '与自动补货权限一起开启后，按模式筛选并按成品库存从少到多补做。' },
    { type: 'picker', key: 'art.specifiedArts', label: '日常补货花艺名单', catalog: 'arts', description: '仅影响日常补货；未选择时不补做。' },
    { type: 'number', key: 'art.targetStock', label: '目标库存', min: 1, integer: true, required: true, unit: '件', description: '现有成品库存低于此数量时才补货。' },
    { type: 'number', key: 'art.makeBatch', label: '单次制作数量', min: 1, integer: true, required: true, unit: '件', description: '每次最多制作此数量；配花不足时按可用量减少本次数量。' },
  ],
  'plant-detail': [
    { type: 'select', key: 'accelerationMode', label: '加速方式', description: '默认关闭。仅对本人当前已种植、生长中且官方倒计时可读的地块执行；不改变种植、浇水与收花设置。', options: [
      { value: 'off', label: '关闭' }, { value: 'card', label: '加速卡' }, { value: 'free', label: '免费加速' }] },
    { type: 'number', key: 'speedCardKeep', label: '保留加速卡', min: 0, integer: true, required: true, unit: '张',
      description: '选择加速卡时，背包至少保留此数量；卡费以官服真实扣除为准。' },
  ],
};
specs.specs['flower-rack-detail'] = {
  title: '花架上架与收款', subtitle: '只依据当前本人背包与花架事实操作。', group: '自动化', kind: 'sheet', scope: 'config',
  fields: [
    { type: 'toggle', key: 'flowerRack.enabled', label: '自动上架与领取', description: '默认关闭。开启后按当前可售成品状态上架并领取到款。' },
    { type: 'picker', key: 'flowerRack.artIds', label: '摆货成品名单', catalog: 'arts', description: '候选仅限本人背包中官服标记为可售的成品；当前状态缺失时等待。' },
    { type: 'select', key: 'flowerRack.sortStrategy', label: '排序方式', options: [
      { value: 'max_stock', label: '库存多优先' }, { value: 'min_stock', label: '库存少优先' }, { value: 'max_price', label: '当前售价高优先' }] },
    { type: 'number', key: 'flowerRack.putCount', label: '每次上架数量', min: 1, max: 12, integer: true, required: true, unit: '件' },
    { type: 'note', label: '费用与后态', description: '库存预约、架上物品、退款与收款分别核对；未知结果不会重复发送。' },
  ], primary: { label: '完成设置', action: 'apply' },
};
for (const [panelId, fields] of Object.entries(productionFields)) {
  const panel = specs.specs[panelId];
  if (!panel || !Array.isArray(panel.fields)) throw new Error('production overlay target is missing: ' + panelId);
  const existing = new Set(panel.fields.map(field => field.key).filter(Boolean));
  const added = fields.filter(field => !existing.has(field.key));
  const end = Math.max(0, panel.fields.length - 1);
  panel.fields.splice(end, 0, ...added);
}
const dailyArtSharedInputs = new Set(['art.specifiedArts', 'art.makeBatch', 'art.autoReplenish']);
for (const panelId of ['art-detail', 'art-picker', 'art-target', 'art-replenish', 'art-arts']) {
  const panel = specs.specs[panelId];
  for (const field of panel?.fields || []) {
    if (dailyArtSharedInputs.has(field.key) || field.type === 'action' && ['art-target', 'art-arts'].includes(field.target))
      field.enableWhen = { any: ['art.makeEnabled', 'art.dailyMakeEnabled'] };
    if (field.key === 'art.specifiedArts')
      field.description = '只限制日常补做和自动补货。未选择时不补做；顾客明确需要的成品不受名单限制。';
    if (field.type === 'note' && field.label === '顾客需求优先')
      field.description = '顾客明确需要的成品不受这份名单限制；日常补做需先选择花艺。';
  }
}
const dailyArtToggle = specs.specs['art-detail']?.fields?.find(field => field.key === 'art.dailyMakeEnabled');
if (dailyArtToggle) {
  dailyArtToggle.label = '自动补货';
  dailyArtToggle.description = '默认关闭。按所选花艺补足目标库存；顾客缺货制作由独立开关控制。';
}
const dailyArtsPicker = specs.specs['art-detail']?.fields?.find(field => field.key === 'art.specifiedArts');
if (dailyArtsPicker) dailyArtsPicker.description = '只限制日常补做和自动补货。未选择时不补做；顾客明确需要的成品不受名单限制。';
specs.specs['art-detail'].title = '花艺制作';
specs.specs['art-detail'].subtitle = '顾客缺货制作与日常补货分别控制。';
specs.specs['art-detail'].related = [];
specs.specs['art-detail'].fields = [
  { type: 'toggle', key: 'art.makeEnabled', label: '顾客缺货补做', description: '按订单实际缺口一次制作；不受日常补货条件限制。' },
  { type: 'toggle', key: 'art.dailyMakeEnabled', configPaths: ['art.autoReplenish'], checkedWhen: { all: ['art.dailyMakeEnabled', 'art.autoReplenish'] }, label: '自动补货', description: '按所选方式补足库存；每次请求使用下方单次制作数量。' },
  { type: 'select', key: 'art.dailyMode', label: '补货方式', description: '切换方式会保留名单和品质选择；仅当前方式生效。', options: [
    { value: 'least_stock', label: '库存最少优先' }, { value: 'chosen_quality', label: '指定品质后库存最少优先' },
    { value: 'chosen_arts', label: '指定花艺后库存最少优先' }] },
  { type: 'picker', key: 'art.dailyQualities', label: '花艺品质', catalog: 'qualities', description: '只在指定品质方式下使用。品质取成品花艺本身。', enableWhen: { key: 'art.dailyMode', value: 'chosen_quality' } },
  { type: 'picker', key: 'art.specifiedArts', label: '指定花艺名单', catalog: 'arts', description: '只在指定花艺方式下使用；切换方式后名单仍保留。', enableWhen: { key: 'art.dailyMode', value: 'chosen_arts' } },
  { type: 'number', key: 'art.targetStock', label: '目标库存', min: 1, max: 999, integer: true, required: true, unit: '件', description: '现有成品库存低于此数量时才补货。' },
  { type: 'number', key: 'art.makeBatch', label: '单次制作数量', min: 1, max: 999, integer: true, required: true, unit: '件', description: '本次请求最多制作这些数量；材料不足时按可用量减少。' },
  { type: 'note', label: '保存后生效', description: '完成后在页面底部保存设置。' },
];
specs.specs['flower-rack-detail'].fields = [
  { type: 'toggle', key: 'flowerRack.enabled', label: '自动上架与领取', description: '默认关闭。只处理本人背包中可售的成品。' },
  { type: 'picker', key: 'flowerRack.artIds', label: '摆货成品名单', catalog: 'arts', description: '留空时使用全部当前可售成品；排序方式决定先后。' },
  { type: 'select', key: 'flowerRack.sortStrategy', label: '摆货顺序', options: [
    { value: 'max_stock', label: '库存多优先' }, { value: 'min_stock', label: '库存少优先' }, { value: 'max_price', label: '当前售价高优先' }] },
  { type: 'number', key: 'flowerRack.putCount', label: '每次摆放数量', min: 1, max: 12, integer: true, required: true, unit: '件' },
  { type: 'note', label: '上架与收款', description: '收款以后续官服回包和新登录状态核对。' },
];
specs.specs['flower-rack-cancel'] = { title: '自动下架', subtitle: '下架与上架分别控制。', group: '自动化', kind: 'sheet', scope: 'config', related: [], fields: [
  { type: 'toggle', key: 'flowerRack.autoTakeDown', label: '自动下架', description: '默认关闭；满足保留时长和官服锁定条件后才处理。' },
  { type: 'number', key: 'flowerRack.keepMinutes', label: '上架后保留时间', min: 1, max: 1440, integer: true, required: true, unit: '分钟' },
] };
specs.specs['flower-rack-unlock'] = { title: '解锁花架', subtitle: '解锁需要单独开启。', group: '自动化', kind: 'sheet', scope: 'config', related: [], fields: [
  { type: 'toggle', key: 'flowerRack.unlockEnabled', label: '自动解锁新花架', description: '默认关闭；仅在当前开放、资格和金币余额可核时执行。' },
  { type: 'number', key: 'flowerRack.unlockKeepGold', label: '解锁后至少保留金币', min: 0, integer: true, required: true, unit: '金币' },
] };
for (const [id, title] of [['art-replenish','自动补货'],['art-arts','指定花艺'],['art-target','目标库存']]) {
  if (specs.specs[id]) {
    specs.specs[id].title = title;
    specs.specs[id].fields = [{ type: 'note', label: '设置入口', description: '请在“自动化设置 → 花架与花艺”中打开花艺制作设置。' }];
    specs.specs[id].related = [];
  }
}
// The three rack editors are the only editors for their respective settings.
// The overview uses order-style cards with summaries and no editable switches.
for (const id of ['customer-art-link', 'art-dependency']) {
  const panel = specs.specs[id];
  if (!panel) continue;
  panel.fields = [{ type: 'note', label: '花艺设置', description: '顾客缺货制作、日常补货、首做奖励和花架选项集中在“自动化设置 → 花架与花艺”页面；各开关仍独立生效。' }];
  panel.related = [];
}
specs.defaults = { ...(specs.defaults || {}), accelerationMode: 'off', speedCardKeep: 0, waterwheelEnabled: false, freeWaterEnabled: false,
  flowerRack: { enabled: false, sortStrategy: 'max_stock', artIds: [], autoTakeDown: false, unlockEnabled: false, putCount: 1, keepMinutes: 20, unlockKeepGold: 0 },
  art: { ...(specs.defaults?.art || {}), dailyMakeEnabled: false, dailyMode: 'least_stock', dailyQualities: [], targetStock: 1, makeBatch: 1 } };
const ids = Object.keys(specs.specs).sort();
const index = readFileSync('docs/design/20261020/interaction-index.json', 'utf8');
const parsed = JSON.parse(index);
const listed = (parsed.panels || []).map(one => one.id).filter(Boolean);
const byId = new Map(parsed.panels.map(one => [one.id || one.panel || one.key, one]));

const problems = [];
if (parsed.pages !== 7) problems.push('expected 7 prototype pages, got ' + parsed.pages);
if (listed.length !== new Set(listed).size) problems.push('duplicate ids in interaction index');
if (listed.length !== 121) problems.push('expected 121 interaction index rows, got ' + listed.length);
if (!ids.length) problems.push('panel table empty');
const missing = listed.filter(id => !byId.has(id));
const unmapped = listed.filter(id => !specs.specs[id]);
if (ids.length < 100) problems.push('panel table looks truncated: ' + ids.length);

const header = `/* Generated by tools/moon-specs-emit.mjs from the frozen prototype panel tables
   (docs/design/20261020/settings-panels.js + account-panels.js, read through a 1260x1170 identity=moon render).
   Raw dump sha256 ${createHash('sha256').update(raw).digest('hex')}.
   ${ids.length} panels; interaction-index lists ${parsed.pages + ' pages / ' + listed.length + ' panel entries'}.
   Field order, labels, descriptions and kinds stay as designed; real values are injected by ui/moon/view-models.js.
   Panels whose design value is only an example must render as unread in production. ${unmapped.length ? 'Index ids with no design table entry: ' + unmapped.join(', ') : ''} */
export const PANEL_SPECS = ${JSON.stringify(specs.specs)};
export const PANEL_CATALOGS = ${JSON.stringify(specs.catalogs)};
export const PANEL_DEFAULTS = ${JSON.stringify(specs.defaults)};
export const PANEL_IDS = ${JSON.stringify(ids)};
`;
writeFileSync('ui/moon/specs.js', header);
console.log(JSON.stringify({ ok: problems.length === 0, problems, panels: ids.length, indexPanelEntries: listed.length,
  indexIdsWithoutDesignTable: unmapped, bytes: Buffer.byteLength(header) }, null, 1));
process.exitCode = problems.length ? 1 : 0;
