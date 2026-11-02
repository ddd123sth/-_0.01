import { createHash, randomUUID } from 'node:crypto';
import {
  CONFIG_FEATURE_IDS, CONFIG_INTERPRETATION_VERSION, ConfigError, cloneJson, factoryConfig, isRecord,
} from './fields.mjs';
import {
  changedConfigFeatures, mergeProjectionIntoDocument, projectLegacyDocument, validateConfigProjection,
} from './projection.mjs';

const stable = value => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const fingerprint = value => createHash('sha256').update(stable(value)).digest('hex');
const json = value => JSON.stringify(value);
const decode = value => JSON.parse(value);
const ref = (value, name) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new ConfigError(`${name}缺失或无效`);
  return value;
};
const revisionValue = (value, name = 'revision') => {
  if (!Number.isSafeInteger(value) || value < 1) throw new ConfigError(`${name}必须是正整数`);
  return value;
};

export function initializeConfigSchema(store) {
  store.run(`CREATE TABLE IF NOT EXISTS backend_config_heads (
    owner_ref TEXT NOT NULL, account_ref TEXT NOT NULL, subject_ref TEXT,
    saved_revision INTEGER NOT NULL, accepted_revision INTEGER,
    cancel_epoch INTEGER NOT NULL, feature_cancel_json TEXT NOT NULL,
    planned_json TEXT NOT NULL, dto_json TEXT NOT NULL, document_json TEXT NOT NULL,
    migration_issues_json TEXT NOT NULL, field_origins_json TEXT NOT NULL,
    archive_ref TEXT NOT NULL, interpretation_version INTEGER NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(owner_ref, account_ref)
  )`);
  store.run(`CREATE TABLE IF NOT EXISTS backend_config_history (
    owner_ref TEXT NOT NULL, account_ref TEXT NOT NULL, revision INTEGER NOT NULL,
    subject_ref TEXT, dto_json TEXT NOT NULL, document_json TEXT NOT NULL,
    feature_cancel_json TEXT NOT NULL, changed_paths_json TEXT NOT NULL,
    migration_issues_json TEXT NOT NULL, concurrency_mode TEXT NOT NULL,
    command_id TEXT, evidence_ref TEXT, saved_at TEXT NOT NULL,
    PRIMARY KEY(owner_ref, account_ref, revision)
  )`);
  store.run(`CREATE TABLE IF NOT EXISTS backend_config_archives (
    archive_ref TEXT PRIMARY KEY, owner_ref TEXT NOT NULL, account_ref TEXT NOT NULL,
    subject_ref TEXT, original_json TEXT NOT NULL, source_type TEXT NOT NULL,
    evidence_ref TEXT, recorded_at TEXT NOT NULL
  )`);
  store.run(`CREATE TABLE IF NOT EXISTS backend_config_receipts (
    owner_ref TEXT NOT NULL, account_ref TEXT NOT NULL, command_id TEXT NOT NULL,
    operation_type TEXT NOT NULL, request_fingerprint TEXT NOT NULL,
    receipt_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
    PRIMARY KEY(owner_ref, account_ref, command_id)
  )`);
}

function projectRow(row) {
  if (!row) return null;
  const config = decode(row.dto_json);
  // Older immutable config heads predate the acceleration extension. Project
  // its explicit safe defaults without rewriting their stored DTO/document.
  if (!Object.hasOwn(config, 'accelerationMode')) config.accelerationMode = 'off';
  if (!Object.hasOwn(config, 'speedCardKeep')) config.speedCardKeep = 0;
  if (!Object.hasOwn(config, 'waterwheelEnabled')) config.waterwheelEnabled = false;
  if (!Object.hasOwn(config, 'freeWaterEnabled')) config.freeWaterEnabled = false;
  if (!Object.hasOwn(config, 'art') || !config.art || typeof config.art !== 'object') config.art = {};
  if (!Object.hasOwn(config.art, 'dailyMakeEnabled')) config.art.dailyMakeEnabled = false;
  if (!Object.hasOwn(config.art, 'dailyMode')) config.art.dailyMode = 'least_stock';
  if (!Object.hasOwn(config.art, 'dailyQualities')) config.art.dailyQualities = [];
  // Prior releases used makeBatch as the desired stock threshold and always
  // sent num=1. Preserve that threshold while giving the new field its own
  // single-request batch size. The immutable stored DTO is not rewritten here.
  if (!Object.hasOwn(config.art, 'targetStock')) {
    config.art.targetStock = Number.isSafeInteger(config.art.makeBatch) && config.art.makeBatch > 0 ? config.art.makeBatch : 1;
    config.art.makeBatch = 1;
  }
  if (!Object.hasOwn(config.art, 'makeBatch')) config.art.makeBatch = 1;
  if (!Object.hasOwn(config, 'flowerRack') || !config.flowerRack || typeof config.flowerRack !== 'object') config.flowerRack = {};
  const rackDefaults = { enabled: false, autoTakeDown: false, unlockEnabled: false, sortStrategy: 'max_stock', artIds: [], putCount: 1, keepMinutes: 20, unlockKeepGold: 0 };
  for (const [key, value] of Object.entries(rackDefaults)) if (!Object.hasOwn(config.flowerRack, key)) config.flowerRack[key] = value;
  // Older immutable heads predate the R10 reward/upgrade cards. Project their
  // documented defaults; the stored DTO is never rewritten here.
  const factory = factoryConfig();
  for (const root of ['mail', 'benefitBox', 'dailyTaskBox', 'weeklyTask', 'freeYuanbaoGift', 'doubleCoin',
    'mainTask', 'mainStory', 'guildBuild', 'guildLand', 'cultivateUpgrade', 'materialShop']) {
    if (!Object.hasOwn(config, root) || !config[root] || typeof config[root] !== 'object') config[root] = {};
    for (const [key, value] of Object.entries(factory[root] || {})) if (!Object.hasOwn(config[root], key)) config[root][key] = value;
  }
  const byFeature = decode(row.planned_json);
  const processed = Object.values(byFeature).map(item => item.plannedRevision).filter(Number.isSafeInteger);
  return {
    ownerRef: row.owner_ref, accountRef: row.account_ref, subjectRef: row.subject_ref,
    config,
    savedRevision: row.saved_revision, acceptedRevision: row.accepted_revision,
    // Only features actually evaluated participate. Unimplemented features do
    // not hold every other feature's observed progress at revision zero.
    plannedRevision: processed.length ? Math.min(...processed) : null,
    cancelEpoch: row.cancel_epoch, featureCancelEpochs: decode(row.feature_cancel_json),
    byFeature, migrationIssues: decode(row.migration_issues_json),
    fieldOrigins: decode(row.field_origins_json), archiveRef: row.archive_ref,
    interpretationVersion: row.interpretation_version, updatedAt: row.updated_at,
  };
}

/**
 * A synchronous config store. The injected outbox writer must use the same
 * store transaction; no network, old runner, old normalizer, or actor start is
 * reachable from this component.
 */
export function createConfigService({ store, appendOutbox, catalogs = {}, clock = null } = {}) {
  if (!store || !['run', 'get', 'all', 'transaction'].every(key => typeof store[key] === 'function')) throw new TypeError('config requires a synchronous SQL store');
  if (typeof appendOutbox !== 'function') throw new TypeError('config requires the shared transactional appendOutbox');
  const now = () => {
    const value = clock ? clock() : typeof store.nowIso === 'function' ? store.nowIso() : new Date().toISOString();
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new ConfigError('配置时钟无效', { code: 'CONFIG_CLOCK_INVALID', status: 500 });
    return value;
  };
  initializeConfigSchema(store);

  function identity(input) {
    return { ownerRef: ref(input.ownerRef, 'ownerRef'), accountRef: ref(input.accountRef, 'accountRef') };
  }
  function head(input) {
    const key = identity(input);
    return store.get('SELECT * FROM backend_config_heads WHERE owner_ref=? AND account_ref=?', key.ownerRef, key.accountRef);
  }
  function requiredHead(input) {
    const row = head(input);
    if (!row) throw new ConfigError('配置尚未迁移或初始化', { code: 'CONFIG_NOT_FOUND', status: 404 });
    return row;
  }
  function emit(event) {
    const result = appendOutbox(event);
    if (result && typeof result.then === 'function') throw new TypeError('appendOutbox must be synchronous and share the store transaction');
    return result;
  }
  function previousReceipt(input, operationType, request) {
    if (input.commandId === undefined || input.commandId === null) return null;
    const commandId = ref(input.commandId, 'commandId');
    const row = store.get('SELECT * FROM backend_config_receipts WHERE owner_ref=? AND account_ref=? AND command_id=?', input.ownerRef, input.accountRef, commandId);
    if (!row) return null;
    if (row.operation_type !== operationType || row.request_fingerprint !== fingerprint(request)) {
      throw new ConfigError('相同配置命令ID带有不同内容', { code: 'CONFIG_COMMAND_CONFLICT', status: 409 });
    }
    return { ...decode(row.receipt_json), duplicate: true };
  }
  function saveReceipt(input, operationType, request, receipt, at) {
    if (input.commandId !== undefined && input.commandId !== null) {
      store.run('INSERT INTO backend_config_receipts(owner_ref,account_ref,command_id,operation_type,request_fingerprint,receipt_json,recorded_at) VALUES(?,?,?,?,?,?,?)',
        input.ownerRef, input.accountRef, ref(input.commandId, 'commandId'), operationType, fingerprint(request), json(receipt), at);
    }
    return receipt;
  }
  function history(row, { changedPaths = [], concurrencyMode, commandId = null, evidenceRef = null }) {
    store.run(`INSERT INTO backend_config_history(owner_ref,account_ref,revision,subject_ref,dto_json,document_json,
      feature_cancel_json,changed_paths_json,migration_issues_json,concurrency_mode,command_id,evidence_ref,saved_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, row.owner_ref, row.account_ref, row.saved_revision, row.subject_ref,
    row.dto_json, row.document_json, row.feature_cancel_json, json(changedPaths), row.migration_issues_json,
    concurrencyMode, commandId, evidenceRef, row.updated_at);
  }

  function read(input) {
    return projectRow(head(input));
  }

  function migrate(input) {
    const key = identity(input);
    const subjectRef = input.subjectRef === undefined || input.subjectRef === null ? null : ref(input.subjectRef, 'subjectRef');
    const projected = projectLegacyDocument(input.legacyDocument);
    const request = { legacyDocument: projected.originalText, subjectRef, evidenceRef: input.evidenceRef ?? null };
    return store.transaction(() => {
      const duplicate = previousReceipt({ ...input, ...key }, 'migrate', request);
      if (duplicate) return duplicate;
      const existing = head(key);
      if (existing) {
        if (existing.subject_ref !== subjectRef) throw new ConfigError('配置主体与现有资料不一致', { code: 'CONFIG_SUBJECT_CONFLICT', status: 409 });
        return { ...projectRow(existing), alreadyMigrated: true };
      }
      const at = now();
      const archiveRef = `config-archive:${randomUUID()}`;
      const epochs = Object.fromEntries(CONFIG_FEATURE_IDS.map(featureId => [featureId, 0]));
      store.run('INSERT INTO backend_config_archives(archive_ref,owner_ref,account_ref,subject_ref,original_json,source_type,evidence_ref,recorded_at) VALUES(?,?,?,?,?,?,?,?)',
        archiveRef, key.ownerRef, key.accountRef, subjectRef, projected.originalText, projected.legacyShape, input.evidenceRef ?? null, at);
      store.run(`INSERT INTO backend_config_heads(owner_ref,account_ref,subject_ref,saved_revision,accepted_revision,cancel_epoch,
        feature_cancel_json,planned_json,dto_json,document_json,migration_issues_json,field_origins_json,archive_ref,
        interpretation_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      key.ownerRef, key.accountRef, subjectRef, 1, null, 0, json(epochs), '{}', json(projected.config), json(projected.document),
      json(projected.migrationIssues), json(projected.fieldOrigins), archiveRef, CONFIG_INTERPRETATION_VERSION, at, at);
      const row = requiredHead(key);
      history(row, { concurrencyMode: 'migration', commandId: input.commandId, evidenceRef: input.evidenceRef });
      emit({ ownerRef: key.ownerRef, subjectRef, eventType: 'ConfigMigrated', eventKey: `${key.accountRef}:revision:1`,
        payload: { accountRef: key.accountRef, savedRevision: 1, archiveRef, migrationIssueCount: projected.migrationIssues.length }, configRevision: 1, occurredAt: at });
      return saveReceipt({ ...input, ...key }, 'migrate', request, { ...projectRow(row), changedFeatures: [], changedPaths: [] }, at);
    });
  }

  function save(input) {
    const key = identity(input);
    if (input.expectedRevision !== undefined && input.expectedRevision !== null) revisionValue(input.expectedRevision, 'expectedRevision');
    const request = { config: input.config, expectedRevision: input.expectedRevision ?? null };
    return store.transaction(() => {
      const duplicate = previousReceipt({ ...input, ...key }, 'save', request);
      if (duplicate) return duplicate;
      const row = requiredHead(key);
      if (input.expectedRevision !== undefined && input.expectedRevision !== null && input.expectedRevision !== row.saved_revision) {
        throw new ConfigError('配置已被更新，请读取最新值后再保存', { code: 'CONFIG_REVISION_CONFLICT', status: 409, details: { expectedRevision: input.expectedRevision, actualRevision: row.saved_revision } });
      }
      // Compare and preserve against the read projection so older stored DTOs
      // and clients that omit the new flower-art fields share the same
      // read-only migration semantics as GET. The immutable head stays raw.
      const before = projectRow(row).config;
      const validated = validateConfigProjection(input.config, { current: before, catalogs });
      const { changedFeatures, changedPaths } = changedConfigFeatures(before, validated.config);
      const epochs = decode(row.feature_cancel_json);
      for (const featureId of changedFeatures) {
        epochs[featureId] = (epochs[featureId] || 0) + 1;
        if (!Number.isSafeInteger(epochs[featureId])) throw new ConfigError('配置取消代际已超出安全整数范围', { code: 'CONFIG_EPOCH_EXHAUSTED', status: 500 });
      }
      const origins = decode(row.field_origins_json);
      for (const definition of Object.keys(origins)) if (!validated.preservedCompatibilityPaths.includes(definition)) {
        origins[definition] = { source: 'user-save', savedRevision: row.saved_revision + 1 };
      }
      const preservedPaths = new Set(validated.preservedCompatibilityPaths);
      const issues = decode(row.migration_issues_json).filter(issue => preservedPaths.has(issue.path));
      const document = mergeProjectionIntoDocument(decode(row.document_json), validated.config, { excludedPaths: validated.preservedCompatibilityPaths });
      const at = now();
      const revision = row.saved_revision + 1;
      if (!Number.isSafeInteger(revision)) throw new ConfigError('配置版本已超出安全整数范围', { code: 'CONFIG_REVISION_EXHAUSTED', status: 500 });
      const concurrencyMode = input.expectedRevision === undefined || input.expectedRevision === null ? 'legacy-serialized-write' : 'expected-revision';
      store.run(`UPDATE backend_config_heads SET saved_revision=?,cancel_epoch=?,feature_cancel_json=?,dto_json=?,document_json=?,
        migration_issues_json=?,field_origins_json=?,updated_at=? WHERE owner_ref=? AND account_ref=?`,
      revision, row.cancel_epoch + (changedFeatures.length ? 1 : 0), json(epochs), json(validated.config), json(document), json(issues), json(origins), at, key.ownerRef, key.accountRef);
      const saved = requiredHead(key);
      history(saved, { changedPaths, concurrencyMode, commandId: input.commandId });
      emit({ ownerRef: key.ownerRef, subjectRef: row.subject_ref, eventType: 'ConfigChanged', eventKey: `${key.accountRef}:revision:${revision}`,
        payload: { accountRef: key.accountRef, savedRevision: revision, changedFeatures, changedPaths, featureCancelEpochs: epochs, concurrencyMode }, configRevision: revision, occurredAt: at });
      return saveReceipt({ ...input, ...key }, 'save', request, {
        ...projectRow(saved), changedFeatures, changedPaths, concurrencyMode, commandId: input.commandId ?? null,
        ignoredCompatibilityPaths: validated.ignoredCompatibilityPaths, preservedCompatibilityPaths: validated.preservedCompatibilityPaths,
      }, at);
    });
  }

  function accept(input) {
    const key = identity(input);
    const revision = revisionValue(input.revision);
    // Acceptance is an actor's durable receipt, not configuration save or readiness.
    const actorRef = ref(input.actorRef, 'actorRef');
    const request = { revision, actorRef, evidenceRef: input.evidenceRef ?? null };
    const receiptInput = { ...input, ...key, commandId: input.commandId ?? `actor-accept:${fingerprint(request)}` };
    return store.transaction(() => {
      const duplicate = previousReceipt(receiptInput, 'accept', request);
      if (duplicate) return duplicate;
      const row = requiredHead(key);
      if (revision !== row.saved_revision) throw new ConfigError('只能接受当前保存版本', { code: 'CONFIG_REVISION_CONFLICT', status: 409 });
      const at = now();
      store.run('UPDATE backend_config_heads SET accepted_revision=?,updated_at=? WHERE owner_ref=? AND account_ref=?', revision, at, key.ownerRef, key.accountRef);
      emit({ ownerRef: key.ownerRef, subjectRef: row.subject_ref, eventType: 'ConfigAccepted', eventKey: `${key.accountRef}:accept:${fingerprint(request)}`,
        payload: { accountRef: key.accountRef, acceptedRevision: revision, actorRef, evidenceRef: input.evidenceRef ?? null }, configRevision: revision, occurredAt: at });
      return saveReceipt(receiptInput, 'accept', request, projectRow(requiredHead(key)), at);
    });
  }

  function recordPlan(input) {
    const key = identity(input);
    const revision = revisionValue(input.revision);
    const featureId = ref(input.featureId, 'featureId');
    const actionKey = input.actionKey === undefined || input.actionKey === null ? null : ref(input.actionKey, 'actionKey');
    const primaryActionKey = input.primaryActionKey === undefined || input.primaryActionKey === null ? null : ref(input.primaryActionKey, 'primaryActionKey');
    if (!CONFIG_FEATURE_IDS.includes(featureId)) throw new ConfigError('未声明的配置功能');
    if (primaryActionKey && (!actionKey || !primaryActionKey.startsWith(featureId + ':'))) throw new ConfigError('主计划动作必须属于已拆分的功能单元');
    const states = ['no-action', 'waiting-facts', 'waiting-until', 'blocked', 'unimplemented', 'proposals', 'disabled', 'cap-wait'];
    if (!states.includes(input.state)) throw new ConfigError('计划结果状态无效');
    if (typeof input.reasonCode !== 'string' || !input.reasonCode) throw new ConfigError('计划必须给出明确原因');
    const request = { revision, featureId, ...(actionKey ? { actionKey } : {}), ...(primaryActionKey ? { primaryActionKey } : {}),
      state: input.state, reasonCode: input.reasonCode, evidenceRef: input.evidenceRef ?? null };
    return store.transaction(() => {
      const duplicate = previousReceipt({ ...input, ...key }, 'recordPlan', request);
      if (duplicate) return duplicate;
      const row = requiredHead(key);
      if (revision !== row.saved_revision || revision !== row.accepted_revision) throw new ConfigError('只能评估当前已接受的配置版本', { code: 'CONFIG_REVISION_CONFLICT', status: 409 });
      const at = now();
      const plans = decode(row.planned_json);
      const plan = { plannedRevision: revision, state: input.state, reasonCode: input.reasonCode, evidenceRef: input.evidenceRef ?? null, plannedAt: at };
      if (actionKey && actionKey !== featureId) {
        const previous = plans[featureId] || {};
        const actions = { ...(previous.actions || {}), [actionKey]: plan };
        const currentActions = Object.values(actions).filter(value => value.plannedRevision === revision);
        const states = currentActions.map(value => value.state);
        const primary = primaryActionKey && actions[primaryActionKey]?.plannedRevision === revision ? actions[primaryActionKey] : null;
        const selected = primaryActionKey ? primary || { plannedRevision: revision, state: 'waiting-facts', reasonCode: 'PRIMARY_ACTION_PENDING',
          evidenceRef: 'primary-action:' + primaryActionKey, plannedAt: at }
          : states.includes('proposals') ? currentActions.find(value => value.state === 'proposals') :
            currentActions.find(value => value.state === 'waiting-facts' || value.state === 'waiting-until') ||
            (states.length > 0 && states.every(state => state === 'disabled') ? currentActions.find(value => value.state === 'disabled') :
              states.length > 0 && states.every(state => state === 'cap-wait') ? currentActions.find(value => value.state === 'cap-wait') : plan);
        plans[featureId] = { ...selected, plannedRevision: revision, actions };
      } else plans[featureId] = plan;
      store.run('UPDATE backend_config_heads SET planned_json=?,updated_at=? WHERE owner_ref=? AND account_ref=?', json(plans), at, key.ownerRef, key.accountRef);
      return saveReceipt({ ...input, ...key }, 'recordPlan', request, projectRow(requiredHead(key)), at);
    });
  }

  // Internal-only data access, intentionally separate from the UI read DTO.
  function readDocument(input) { return cloneJson(decode(requiredHead(input).document_json)); }
  function listHistory(input) {
    const key = identity(input);
    const limit = input.limit === undefined ? 50 : input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new ConfigError('配置历史分页无效');
    return store.all('SELECT revision,concurrency_mode,command_id,evidence_ref,saved_at,changed_paths_json FROM backend_config_history WHERE owner_ref=? AND account_ref=? ORDER BY revision DESC LIMIT ?', key.ownerRef, key.accountRef, limit)
      .map(row => ({ revision: row.revision, concurrencyMode: row.concurrency_mode, commandId: row.command_id, evidenceRef: row.evidence_ref, savedAt: row.saved_at, changedPaths: decode(row.changed_paths_json) }));
  }

  return Object.freeze({ read, migrate, save, accept, recordPlan, readDocument, listHistory });
}
