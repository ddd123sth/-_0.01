import {
  CONFIG_DTO_VERSION, CONFIG_FIELDS, ConfigError, atPath, cloneJson, factoryConfig,
  isRecord, putPath, validateFieldValue,
} from './fields.mjs';

const ALLOWED_CHILDREN = new Map();
for (const definition of CONFIG_FIELDS) {
  const parts = definition.dtoPath.split('.');
  for (let index = 0; index < parts.length; index += 1) {
    const parent = parts.slice(0, index).join('.');
    if (!ALLOWED_CHILDREN.has(parent)) ALLOWED_CHILDREN.set(parent, new Set());
    ALLOWED_CHILDREN.get(parent).add(parts[index]);
  }
}
ALLOWED_CHILDREN.get('').add('configVersion');

// app.js currently includes this zero-valued UI row-template property in these
// groups. It has no active DTO/document path and cannot restore retired limits.
const LEGACY_ZERO_ONLY = new Set(['orders.customer.dailyLimit', 'orders.palace.dailyLimit', 'orders.team.dailyLimit']);

// R10 reward/upgrade cards: an older client that does not send these roots keeps
// the stored value (or the documented default) instead of failing the save.
export const REWARD_CONFIG_ROOTS = Object.freeze(['mail', 'benefitBox', 'dailyTaskBox', 'weeklyTask', 'freeYuanbaoGift',
  'doubleCoin', 'mainTask', 'mainStory', 'guildBuild', 'guildLand', 'cultivateUpgrade', 'materialShop']);

function inspectShape(value, path = '', ignored = []) {
  if (!isRecord(value)) throw new ConfigError(`${path || '设置'}必须是对象`);
  const allowed = ALLOWED_CHILDREN.get(path) || new Set();
  for (const key of Object.keys(value)) {
    const child = path ? `${path}.${key}` : key;
    if (LEGACY_ZERO_ONLY.has(child)) {
      if (value[key] !== 0) throw new ConfigError(`${child}不是本版本负责的配置字段`);
      ignored.push(child);
      continue;
    }
    if (!allowed.has(key)) throw new ConfigError(`${child}不是本版本认识的配置字段`);
    if (ALLOWED_CHILDREN.has(child)) inspectShape(value[key], child, ignored);
  }
  return ignored;
}

export function validateConfigProjection(input, { current = null, catalogs = {}, allowLegacyOmittedGroups = true } = {}) {
  // Older clients used art.makeBatch as the desired stock threshold and did
  // not send targetStock. Translate that payload at the boundary: keep the
  // old threshold, while preserving the current/new single-call batch cap.
  let compatibleInput = input;
  if (isRecord(input?.art) && !Object.hasOwn(input.art, 'targetStock') && Object.hasOwn(input.art, 'makeBatch')) {
    compatibleInput = cloneJson(input);
    const legacyTarget = input.art.makeBatch;
    const currentTarget = atPath(current, 'art.targetStock');
    const currentBatch = atPath(current, 'art.makeBatch');
    compatibleInput.art.targetStock = legacyTarget;
    compatibleInput.art.makeBatch = currentTarget.present && currentBatch.present ? currentBatch.value : 1;
  }
  const ignoredCompatibilityPaths = inspectShape(compatibleInput);
  if (Object.hasOwn(compatibleInput, 'configVersion') && compatibleInput.configVersion !== CONFIG_DTO_VERSION) {
    throw new ConfigError('设置版本不受支持', { code: 'CONFIG_VERSION_UNSUPPORTED' });
  }
  const config = { configVersion: CONFIG_DTO_VERSION };
  const preservedCompatibilityPaths = [];
  for (const definition of CONFIG_FIELDS) {
    let entry = atPath(compatibleInput, definition.dtoPath);
    let preserved = false;
    const root = definition.dtoPath.split('.')[0];
    if (!entry.present && (['accelerationMode', 'speedCardKeep', 'waterwheelEnabled', 'freeWaterEnabled',
      'art.dailyMakeEnabled', 'art.dailyMode', 'art.dailyQualities', 'art.targetStock',
      'flowerRack.enabled', 'flowerRack.autoTakeDown', 'flowerRack.unlockEnabled',
      'flowerRack.sortStrategy', 'flowerRack.artIds', 'flowerRack.putCount', 'flowerRack.keepMinutes',
      'flowerRack.unlockKeepGold'].includes(definition.dtoPath) ||
      REWARD_CONFIG_ROOTS.some(root => definition.dtoPath === root || definition.dtoPath.startsWith(root + '.')))) {
      const prior = current ? atPath(current, definition.dtoPath) : { present: false };
      if (prior.present) { entry = prior; preserved = true; preservedCompatibilityPaths.push(definition.dtoPath); }
      else entry = { present: true, value: definition.defaultValue };
    }
    if (!entry.present && allowLegacyOmittedGroups && ['orders', 'art', 'dailyTaskRewards', 'flowerRack', ...REWARD_CONFIG_ROOTS].includes(root)
      && !Object.hasOwn(compatibleInput, root) && current) {
      entry = atPath(current, definition.dtoPath);
      if (entry.present) {
        preservedCompatibilityPaths.push(definition.dtoPath);
        preserved = true;
      } else {
        entry = { present: true, value: definition.defaultValue };
      }
    }
    if (!entry.present) throw new ConfigError(`${definition.dtoPath}缺失`, { details: { path: definition.dtoPath } });
    // An omitted old-client group is not a new declaration. Preserve its
    // uninterpretable/null state and migration issue without preventing an
    // independent, valid land save or laundering it into a new default.
    putPath(config, definition.dtoPath, preserved ? entry.value : validateFieldValue(definition, entry.value, catalogs));
  }
  return { config, ignoredCompatibilityPaths, preservedCompatibilityPaths };
}

export function parseLegacyDocument(legacyDocument) {
  const originalText = typeof legacyDocument === 'string' ? legacyDocument : JSON.stringify(legacyDocument);
  try {
    const document = typeof legacyDocument === 'string' ? JSON.parse(legacyDocument) : cloneJson(legacyDocument);
    if (!isRecord(document)) throw new Error('not-object');
    return { document, originalText, documentValid: true };
  } catch {
    return { document: {}, originalText: originalText ?? 'null', documentValid: false };
  }
}

export function projectLegacyDocument(legacyDocument) {
  const parsed = parseLegacyDocument(legacyDocument);
  const config = { configVersion: CONFIG_DTO_VERSION };
  const migrationIssues = [];
  const fieldOrigins = {};
  // Original installations sometimes stored only plant.land_plant's payload.
  const landOnly = !Object.hasOwn(parsed.document, 'plant')
    && ['auto_plant', 'plant_mode', 'auto_water', 'auto_harvest'].some(key => Object.hasOwn(parsed.document, key));
  if (!parsed.documentValid) migrationIssues.push({ path: '$document', code: 'LEGACY_DOCUMENT_UNREADABLE', severity: 'error' });
  for (const definition of CONFIG_FIELDS) {
    const legacyPath = landOnly && definition.documentPath.startsWith('plant.land_plant.')
      ? definition.documentPath.slice('plant.land_plant.'.length) : definition.documentPath;
    const entry = atPath(parsed.document, legacyPath);
    if (!entry.present && parsed.documentValid) {
      putPath(config, definition.dtoPath, definition.defaultValue);
      fieldOrigins[definition.dtoPath] = { source: 'missing-key-default', originalPath: legacyPath };
      migrationIssues.push({ path: definition.dtoPath, code: 'MISSING_KEY_DEFAULT_RECORDED', severity: 'info', originalPath: legacyPath });
      continue;
    }
    fieldOrigins[definition.dtoPath] = { source: parsed.documentValid ? 'legacy-value' : 'unreadable-document', originalPath: legacyPath };
    try {
      if (!parsed.documentValid) throw new Error('unreadable');
      // Migration never prunes a saved ID because a new catalog is incomplete.
      putPath(config, definition.dtoPath, validateFieldValue(definition, entry.value));
    } catch {
      putPath(config, definition.dtoPath, null);
      migrationIssues.push({ path: definition.dtoPath, code: 'LEGACY_VALUE_UNINTERPRETABLE', severity: 'error', originalPath: legacyPath });
    }
  }
  const historicalStockGoal = atPath(parsed.document, 'plant.flower_art.make_batch');
  const historicalTargetStock = atPath(parsed.document, 'plant.flower_art.target_stock');
  if (!historicalTargetStock.present && historicalStockGoal.present && Number.isSafeInteger(historicalStockGoal.value) && historicalStockGoal.value > 0) {
    putPath(config, 'art.targetStock', historicalStockGoal.value);
    putPath(config, 'art.makeBatch', 1);
    fieldOrigins['art.targetStock'] = { source: 'legacy-make-batch-stock-target', originalPath: 'plant.flower_art.make_batch' };
    fieldOrigins['art.makeBatch'] = { source: 'legacy-single-call-default', originalPath: 'plant.flower_art.make_batch' };
  }
  return { ...parsed, config, migrationIssues, fieldOrigins, legacyShape: landOnly ? 'land-only' : 'full-engine-document' };
}

export function mergeProjectionIntoDocument(document, config, { excludedPaths = [] } = {}) {
  const merged = isRecord(document) ? cloneJson(document) : {};
  const excluded = new Set(excludedPaths);
  for (const definition of CONFIG_FIELDS) {
    if (!excluded.has(definition.dtoPath)) putPath(merged, definition.documentPath, atPath(config, definition.dtoPath).value);
  }
  // Do not derive hidden gates or mutate fields outside the 33-field projection.
  // New features consume DTO intent and capability separately, never these old gates.
  return merged;
}

export function changedConfigFeatures(before, after) {
  const changedPaths = [];
  const changedFeatures = new Set();
  for (const definition of CONFIG_FIELDS) {
    const semantic = value => definition.type === 'ids' && Array.isArray(value) ? [...new Set(value)].sort((a, b) => a - b) : value;
    if (JSON.stringify(semantic(atPath(before, definition.dtoPath).value)) !== JSON.stringify(semantic(atPath(after, definition.dtoPath).value))) {
      changedPaths.push(definition.dtoPath);
      changedFeatures.add(definition.featureId);
      for (const featureId of definition.affectedFeatureIds || []) changedFeatures.add(featureId);
    }
  }
  return { changedPaths, changedFeatures: [...changedFeatures] };
}

export { factoryConfig };
