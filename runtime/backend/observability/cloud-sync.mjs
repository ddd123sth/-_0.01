import { canonical, clone, fingerprint, freeze, newId, parseStored, plainObject, problem } from '../common.mjs';

const EVENT_LIMIT = 100;
const REQUEST_LIMIT_BYTES = 64 * 1024;
const BASELINE_MS = 120000;
const COOLDOWN_MS = 60000;
const BACKLOG_COOLDOWN_MS = 20000;
const BACKLOG_THRESHOLD = EVENT_LIMIT;
const POLL_MS = 30000;
const BACKOFF_MS = Object.freeze([60000, 120000, 240000, 480000, 900000]);
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const OUTCOMES = new Set(['confirmed', 'unconfirmed', 'failed']);
const AUTO_ERROR_SQL = `(level='error' OR outcome_state IN ('failed','rejected') OR
  CASE WHEN json_valid(detail_json) THEN COALESCE(NULLIF(outcome_state,''),json_extract(detail_json,'$.outcomeState'),json_extract(detail_json,'$.verdict')) END IN ('failed','rejected'))`;
const PERMANENT = new Set(['LOG_FIELD_NOT_ALLOWED', 'LOG_BATCH_TOO_LARGE', 'INSTALL_MISMATCH', 'EVENT_CONFLICT', 'EVENT_INVALID', 'EVENT_OUTSIDE_WINDOW']);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value);
const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : 'LOG_UPLOAD_FAILED';
const safeInteger = value => Number.isSafeInteger(value) && value >= 0;
const validIso = value => typeof value === 'string' && value.length <= 64 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const bounded = (value, length) => typeof value === 'string' && value.length <= length;

// Independently reviewed against cloud/redact.mjs and cloud/logs.mjs. Never
// import the old log pump, its ownership migration, or an arbitrary detail body.
function maskText(value) {
  return value
    .replace(/([A-Za-z0-9._%+-]+):([^\s:@/]+)@/gu, '[已隐去]@')
    .replace(/((?:password|passwd|pwd|token|secret|authorization|auth|cookie|api[ _-]?key|access[ _-]?key|session)[^=&\s"']{0,20}\s*[:=]\s*)([^\s&,;"']+)/giu, '$1[已隐去]')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/gu, '[已隐去]');
}

/**
 * A dedicated uploader for append-only backend_local_logs.
 *
 * sourceInstallId is an explicit composition-root attestation that this new
 * source database belongs to installId; it is durably pinned, never migrated
 * or reassigned by this module. Initialize createObservationLog first.
 *
 * identity(): software.status(), containing signedIn/ownerRef/installId and
 * identityEpoch. sendLogs({ownerRef,identityEpoch,installId,events}) must check
 * that exact context before using its private token. It returns the cloud's
 * {accepted,duplicates,rejected,receivedAt}; the uploader checks context again.
 */
export function createCloudLogSync({ store, cloudRef, installId, sourceInstallId, appVersion,
  identity, sendLogs, network = () => ({ transport: 'unknown' }),
  labelForAccount = null, readHistoricalSource = null, redactText = maskText } = {}) {
  if (!store?.transaction || !store?.get || !store?.run || !store?.all || !store?.db?.exec
    || typeof identity !== 'function' || typeof sendLogs !== 'function' || typeof network !== 'function'
    || typeof redactText !== 'function' || labelForAccount !== null && typeof labelForAccount !== 'function'
    || readHistoricalSource !== null && typeof readHistoricalSource !== 'function') {
    throw new TypeError('Cloud log sync requires the durable store, identity and private sender');
  }
  if (typeof cloudRef !== 'string' || !/^[a-f0-9]{64}$/.test(cloudRef) || !identifier(installId)
    || sourceInstallId !== installId || !bounded(appVersion, 32) || !appVersion) {
    throw problem('LOG_SOURCE_BINDING_REQUIRED', '新运行日志缺少明确的云、安装来源或版本绑定', 500);
  }
  const { get, run, all, transaction, nowIso } = store;
  if (!get("SELECT name FROM sqlite_master WHERE type='table' AND name='backend_local_logs'")) {
    throw problem('LOG_SOURCE_MISSING', '新后端运行日志源尚未初始化', 500);
  }
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS backend_log_sync_source(
      source_name TEXT PRIMARY KEY,cloud_ref TEXT NOT NULL,install_id TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS backend_log_sync_install(
      cloud_ref TEXT NOT NULL,install_id TEXT NOT NULL,wifi_only INTEGER NOT NULL DEFAULT 0,
      hold_since TEXT,next_send_ms INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,
      PRIMARY KEY(cloud_ref,install_id));
    CREATE TABLE IF NOT EXISTS backend_log_sync_cursors(
      cloud_ref TEXT NOT NULL,owner_ref TEXT NOT NULL,install_id TEXT NOT NULL,last_log_id INTEGER NOT NULL DEFAULT 0,
      selection_log_id INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,retry_at_ms INTEGER NOT NULL DEFAULT 0,auto_due_ms INTEGER NOT NULL,
      last_success_at TEXT,last_code TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(cloud_ref,owner_ref,install_id));
    CREATE TABLE IF NOT EXISTS backend_log_sync_batches(
      batch_id TEXT PRIMARY KEY,cloud_ref TEXT NOT NULL,owner_ref TEXT NOT NULL,install_id TEXT NOT NULL,
      from_log_id INTEGER NOT NULL,through_log_id INTEGER NOT NULL,events_json TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'legacy',selection_ref TEXT,source_ids_json TEXT,
      attempt_ref TEXT,attempt_identity_epoch INTEGER,last_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS backend_log_auto_scans(
      cloud_ref TEXT NOT NULL,owner_ref TEXT NOT NULL,install_id TEXT NOT NULL,high_water_log_id INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,PRIMARY KEY(cloud_ref,owner_ref,install_id));
    CREATE TABLE IF NOT EXISTS backend_log_sync_selections(
      selection_ref TEXT PRIMARY KEY,cloud_ref TEXT NOT NULL,owner_ref TEXT NOT NULL,install_id TEXT NOT NULL,
      account_ref TEXT NOT NULL,identity_epoch INTEGER NOT NULL,high_water_log_id INTEGER NOT NULL,source_ids_json TEXT NOT NULL,
      next_index INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS backend_log_sync_selection_identity_immutable BEFORE UPDATE OF
      selection_ref,cloud_ref,owner_ref,install_id,account_ref,identity_epoch,high_water_log_id,source_ids_json,created_at
      ON backend_log_sync_selections BEGIN SELECT RAISE(ABORT,'log selection identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_log_sync_selection_no_delete BEFORE DELETE ON backend_log_sync_selections
      BEGIN SELECT RAISE(ABORT,'log selection is append only'); END;
    CREATE TABLE IF NOT EXISTS backend_log_sync_quarantines(
      quarantine_id TEXT PRIMARY KEY,batch_id TEXT NOT NULL UNIQUE,cloud_ref TEXT NOT NULL,owner_ref TEXT NOT NULL,install_id TEXT NOT NULL,
      from_log_id INTEGER NOT NULL,through_log_id INTEGER NOT NULL,event_count INTEGER NOT NULL,content_sha256 TEXT NOT NULL,
      attempt_ref TEXT,identity_epoch INTEGER,reason TEXT NOT NULL,recorded_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS backend_log_sync_quarantine_owner ON backend_log_sync_quarantines(cloud_ref,owner_ref,install_id);
    CREATE TABLE IF NOT EXISTS backend_log_sync_quarantined_events(
      quarantine_ref TEXT PRIMARY KEY,cloud_ref TEXT NOT NULL,owner_ref TEXT NOT NULL,install_id TEXT NOT NULL,
      source_log_id INTEGER NOT NULL,event_ref TEXT NOT NULL,raw_source_json TEXT NOT NULL,raw_content_sha256 TEXT NOT NULL,
      reason TEXT NOT NULL,attempt_ref TEXT,recorded_at TEXT NOT NULL,UNIQUE(cloud_ref,owner_ref,install_id,source_log_id,raw_content_sha256));
    CREATE INDEX IF NOT EXISTS backend_log_sync_quarantined_event_owner ON backend_log_sync_quarantined_events(cloud_ref,owner_ref,install_id,source_log_id);
    CREATE TRIGGER IF NOT EXISTS backend_log_sync_quarantined_events_no_update BEFORE UPDATE ON backend_log_sync_quarantined_events
      BEGIN SELECT RAISE(ABORT,'quarantined log event is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_log_sync_quarantined_events_no_delete BEFORE DELETE ON backend_log_sync_quarantined_events
      BEGIN SELECT RAISE(ABORT,'quarantined log event is append only'); END;

    CREATE INDEX IF NOT EXISTS backend_log_sync_batch_history ON backend_log_sync_batches(cloud_ref,owner_ref,install_id,state,through_log_id);
    CREATE TRIGGER IF NOT EXISTS backend_log_sync_quarantine_no_update BEFORE UPDATE ON backend_log_sync_quarantines
      BEGIN SELECT RAISE(ABORT,'log quarantine evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_log_sync_quarantine_no_delete BEFORE DELETE ON backend_log_sync_quarantines
      BEGIN SELECT RAISE(ABORT,'log quarantine evidence is append only'); END;
    CREATE TABLE IF NOT EXISTS backend_log_sync_receipts(
      receipt_id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,cloud_ref TEXT NOT NULL,owner_ref TEXT NOT NULL,install_id TEXT NOT NULL,
      identity_epoch INTEGER NOT NULL,attempt_ref TEXT NOT NULL,receipt_state TEXT NOT NULL,
      accepted_json TEXT NOT NULL,duplicates_json TEXT NOT NULL,rejected_json TEXT NOT NULL,
      received_at TEXT,recorded_at TEXT NOT NULL,UNIQUE(batch_id,attempt_ref));`);
  // The selection cursor may pass a preserved rejection; the acknowledged
  // prefix cannot. Upgrade our earlier schema without rewriting its evidence.
  transaction(() => {
    if (!all('PRAGMA table_info(backend_log_sync_selections)').some(row => row.name === 'next_index'))
      run('ALTER TABLE backend_log_sync_selections ADD COLUMN next_index INTEGER NOT NULL DEFAULT 0');
    for (const [column, definition] of [['mode', "TEXT NOT NULL DEFAULT 'legacy'"], ['selection_ref', 'TEXT'], ['source_ids_json', 'TEXT']]) {
      if (!all('PRAGMA table_info(backend_log_sync_batches)').some(row => row.name === column)) run(`ALTER TABLE backend_log_sync_batches ADD COLUMN ${column} ${definition}`);
    }
    if (!all('PRAGMA table_info(backend_log_sync_cursors)').some(row => row.name === 'selection_log_id')) {
      run('ALTER TABLE backend_log_sync_cursors ADD COLUMN selection_log_id INTEGER NOT NULL DEFAULT 0');
    }
    run('UPDATE backend_log_sync_cursors SET selection_log_id=last_log_id WHERE selection_log_id<last_log_id');
    for (const batch of all("SELECT * FROM backend_log_sync_batches WHERE mode='legacy' AND state IN ('pending','sending','unknown','rejected')")) {
      const assessment = legacyBatchAssessment(batch);
      if (assessment.kind === 'corrupt') run("UPDATE backend_log_sync_batches SET state='held-corrupt',last_code='LOG_BATCH_CORRUPT',updated_at=? WHERE batch_id=?",
        nowIso(), batch.batch_id);
      else if (assessment.kind === 'mixed') run("UPDATE backend_log_sync_batches SET state='held-policy',last_code='AUTO_UPLOAD_POLICY_CHANGED',updated_at=? WHERE batch_id=?",
        nowIso(), batch.batch_id);
    }
    store.db.exec(`DROP INDEX IF EXISTS backend_log_sync_active_batch;
      CREATE UNIQUE INDEX backend_log_sync_active_batch ON backend_log_sync_batches(cloud_ref,owner_ref,install_id)
      WHERE state IN ('pending','sending','unknown');`);
  });
  const ownerPrefix = 'cloud:' + cloudRef + ':software:';
  const stagger = Math.round(BASELINE_MS * (0.8 + parseInt(fingerprint(installId).slice(0, 8), 16) / 0xffffffff * 0.4));
  let flight = null, timer = null, running = false, closed = false;
  transaction(() => {
    const source = get('SELECT * FROM backend_log_sync_source WHERE source_name=?', 'backend_local_logs');
    if (source && (source.cloud_ref !== cloudRef || source.install_id !== installId)) {
      throw problem('LOG_SOURCE_INSTALL_MISMATCH', '原运行日志属于另一云或安装实例，不能自动重新认领', 409);
    }
    if (!source) run('INSERT INTO backend_log_sync_source VALUES(?,?,?,?)', 'backend_local_logs', cloudRef, installId, nowIso());
    run('INSERT OR IGNORE INTO backend_log_sync_install(cloud_ref,install_id,updated_at) VALUES(?,?,?)', cloudRef, installId, nowIso());
    for (const batch of all("SELECT * FROM backend_log_sync_batches WHERE cloud_ref=? AND install_id=? AND state='rejected'", cloudRef, installId)) {
      if (PERMANENT.has(batch.last_code)) {
        const assessment = legacyBatchAssessment(batch);
        if (assessment.kind === 'corrupt') run("UPDATE backend_log_sync_batches SET state='held-corrupt',last_code='LOG_BATCH_CORRUPT',updated_at=? WHERE batch_id=?", nowIso(), batch.batch_id);
        else quarantine(batch, batch.last_code);
      }
    }
  });

  function captureIdentity() {
    const value = identity();
    if (!plainObject(value) || value.signedIn !== true || typeof value.ownerRef !== 'string'
      || !value.ownerRef.startsWith(ownerPrefix) || !/^[1-9]\d*$/.test(value.ownerRef.slice(ownerPrefix.length))
      || !safeInteger(value.identityEpoch) || value.installId !== installId) return null;
    return Object.freeze({ ownerRef: value.ownerRef, identityEpoch: value.identityEpoch, installId });
  }
  function current(context) {
    if (closed) return false;
    const now = captureIdentity();
    return now !== null && now.ownerRef === context.ownerRef && now.identityEpoch === context.identityEpoch && now.installId === context.installId;
  }
  function cursor(ownerRef) {
    run(`INSERT OR IGNORE INTO backend_log_sync_cursors(cloud_ref,owner_ref,install_id,auto_due_ms,updated_at)
      VALUES(?,?,?,?,?)`, cloudRef, ownerRef, installId, Date.now() + stagger, nowIso());
    return get('SELECT * FROM backend_log_sync_cursors WHERE cloud_ref=? AND owner_ref=? AND install_id=?', cloudRef, ownerRef, installId);
  }
  const installState = () => get('SELECT * FROM backend_log_sync_install WHERE cloud_ref=? AND install_id=?', cloudRef, installId);
  const activeBatch = ownerRef => get(`SELECT * FROM backend_log_sync_batches WHERE cloud_ref=? AND owner_ref=? AND install_id=? AND state IN ('pending','sending','unknown')`, cloudRef, ownerRef, installId);
  const quarantineCounts = ownerRef => {
    const batches = get(`SELECT COUNT(*) AS n FROM backend_log_sync_quarantines WHERE cloud_ref=? AND owner_ref=? AND install_id=?`, cloudRef, ownerRef, installId);
    const batchEvents = get(`SELECT COALESCE(SUM(event_count),0) AS n FROM backend_log_sync_quarantines WHERE cloud_ref=? AND owner_ref=? AND install_id=?`, cloudRef, ownerRef, installId);
    const eventRows = get(`SELECT COUNT(*) AS n FROM backend_log_sync_quarantined_events WHERE cloud_ref=? AND owner_ref=? AND install_id=?`, cloudRef, ownerRef, installId);
    return { batches: Number(batches.n), events: Number(batchEvents.n) + Number(eventRows.n) };
  };
  function countPending(context) {
    if (!context) return 0;
    const scan = get('SELECT high_water_log_id FROM backend_log_auto_scans WHERE cloud_ref=? AND owner_ref=? AND install_id=?', cloudRef, context.ownerRef, installId);
    const high = Number(scan?.high_water_log_id || 0);
    const automatic = Number(get(`SELECT COUNT(*) AS n FROM backend_local_logs WHERE owner_ref=? AND log_id>? AND ${AUTO_ERROR_SQL}`,
      context.ownerRef, high).n);
    const selections = all(`SELECT source_ids_json,next_index FROM backend_log_sync_selections WHERE cloud_ref=? AND owner_ref=? AND install_id=?
      AND identity_epoch=? AND state IN ('selected','sending')`, cloudRef, context.ownerRef, installId, context.identityEpoch);
    const manual = selections.reduce((total, row) => {
      const ids = parseStored(row.source_ids_json, '待上传的手动日志选择');
      return total + (Array.isArray(ids) ? Math.max(0, ids.length - Number(row.next_index || 0)) : 0);
    }, 0);
    const active = activeBatch(context.ownerRef);
    let activeAutomatic = 0;
    if (active?.mode === 'auto-error') {
      try { activeAutomatic = parseStored(active.events_json, '待发送自动错误日志')?.length || 1; }
      catch { activeAutomatic = 1; }
    }
    const rejectedLegacy = all(`SELECT * FROM backend_log_sync_batches WHERE cloud_ref=? AND owner_ref=? AND install_id=? AND mode='legacy' AND state='rejected'`,
      cloudRef, context.ownerRef, installId).reduce((sum, batch) => sum + (legacyBatchAssessment(batch).kind === 'error-only' ? legacyBatchAssessment(batch).eventCount : 0), 0);
    return automatic + manual + activeAutomatic + rejectedLegacy;
  }
  function quarantine(batch, reason) {
    const events = parseStored(batch.events_json, '拒收日志原批次');
    if (!Array.isArray(events) || events.length < 1 || events.length > EVENT_LIMIT || fingerprint(events) !== batch.content_sha256
      || !safeInteger(batch.from_log_id) || !safeInteger(batch.through_log_id) || batch.through_log_id <= batch.from_log_id
      || events.some((event, index) => !plainObject(event) || event.installId !== installId || !identifier(event.eventId)
        || !safeInteger(event.seq) || event.seq <= (index ? events[index - 1].seq : batch.from_log_id) || event.seq > batch.through_log_id)
      || events.at(-1).seq !== batch.through_log_id) {
      throw problem('LOG_BATCH_CORRUPT', '拒收批次原文无法核对，不能跳过原资料', 500);
    }
    const head = cursor(batch.owner_ref);
    if (batch.mode === 'legacy' && head.selection_log_id !== batch.from_log_id) throw problem('LOG_QUARANTINE_RANGE_MISMATCH', '拒收隔离范围不属于当前选择游标', 500);
    run(`INSERT OR IGNORE INTO backend_log_sync_quarantines(quarantine_id,batch_id,cloud_ref,owner_ref,install_id,
      from_log_id,through_log_id,event_count,content_sha256,attempt_ref,identity_epoch,reason,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    newId(), batch.batch_id, cloudRef, batch.owner_ref, installId, batch.from_log_id, batch.through_log_id,
    events.length, batch.content_sha256, batch.attempt_ref, batch.attempt_identity_epoch, reason, nowIso());
    run("UPDATE backend_log_sync_batches SET state='quarantined',last_code=?,updated_at=? WHERE batch_id=?", reason, nowIso(), batch.batch_id);
    if (batch.mode === 'legacy') run(`UPDATE backend_log_sync_cursors SET selection_log_id=?,failures=0,retry_at_ms=0,auto_due_ms=?,last_code=?,updated_at=?
      WHERE cloud_ref=? AND owner_ref=? AND install_id=? AND selection_log_id=?`,
    batch.through_log_id, Date.now() + stagger, reason, nowIso(), cloudRef, batch.owner_ref, installId, batch.from_log_id);
    if (batch.selection_ref) run("UPDATE backend_log_sync_selections SET state='quarantined',updated_at=? WHERE selection_ref=?", nowIso(), batch.selection_ref);
    return true;
  }
  function quarantineSourceRow(row, context, reason, { mode = 'legacy', selectionRef = null } = {}) {
    const head = mode === 'legacy' ? cursor(context.ownerRef) : null;
    if (!safeInteger(row?.log_id) || row.log_id < 1 || mode === 'legacy' && row.log_id <= head.selection_log_id || row.owner_ref !== context.ownerRef)
      throw problem('LOG_SOURCE_QUARANTINE_BINDING', '坏日志原行与当前归属无法绑定', 500);
    const rawSource = Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
    const raw = canonical(rawSource), rawHash = fingerprint(raw), why = safeCode(reason);
    run(`INSERT OR IGNORE INTO backend_log_sync_quarantined_events(quarantine_ref,cloud_ref,owner_ref,install_id,
      source_log_id,event_ref,raw_source_json,raw_content_sha256,reason,attempt_ref,recorded_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, newId(), cloudRef, context.ownerRef, installId, row.log_id,
      typeof row.event_ref === 'string' && row.event_ref.length ? row.event_ref : `invalid-log-${row.log_id}`,
      raw, rawHash, why, null, nowIso());
    let advanced;
    if (mode === 'legacy') advanced = run(`UPDATE backend_log_sync_cursors SET selection_log_id=?,failures=0,retry_at_ms=0,
      auto_due_ms=?,last_code=?,updated_at=? WHERE cloud_ref=? AND owner_ref=? AND install_id=? AND selection_log_id=?`,
      row.log_id, Date.now() + stagger, why, nowIso(), cloudRef, context.ownerRef, installId, head.selection_log_id);
    else if (mode === 'auto-error') advanced = run(`UPDATE backend_log_auto_scans SET high_water_log_id=?,updated_at=?
      WHERE cloud_ref=? AND owner_ref=? AND install_id=? AND high_water_log_id<?`, row.log_id, nowIso(), cloudRef, context.ownerRef, installId, row.log_id);
    else if (mode === 'manual-selection' && selectionRef) advanced = run(`UPDATE backend_log_sync_selections SET next_index=next_index+1,state='selected',updated_at=?
      WHERE selection_ref=? AND cloud_ref=? AND owner_ref=? AND install_id=? AND state IN ('selected','sending')`,
      nowIso(), selectionRef, cloudRef, context.ownerRef, installId);
    if (!advanced?.changes) throw problem('LOG_SOURCE_QUARANTINE_RACE', '日志隔离范围已变化，原行仍保留', 409);
    return { sourceLogId: row.log_id, eventRef: row.event_ref, reason: why, rawSha256: rawHash };
  }
  function transport() {
    try { const value = network(); return plainObject(value) && typeof value.transport === 'string' ? value.transport : 'unknown'; }
    catch { return 'unknown'; }
  }
  function policy() {
    const context = captureIdentity(), state = installState(), pending = countPending(context);
    const held = state.wifi_only === 1 && transport() !== 'wifi' && pending > 0;
    const holdSince = held ? state.hold_since || nowIso() : null;
    if (holdSince !== state.hold_since) run('UPDATE backend_log_sync_install SET hold_since=?,updated_at=? WHERE cloud_ref=? AND install_id=?', holdSince, nowIso(), cloudRef, installId);
    return { enabled: state.wifi_only === 1, holdSince, pending };
  }
  function setWifiOnly(enabled) {
    if (typeof enabled !== 'boolean') throw problem('LOG_UPLOAD_POLICY_INVALID', '仅Wi-Fi上传必须为布尔值', 400);
    if (closed) throw problem('LOG_SYNC_CLOSED', '日志同步服务已停止', 503);
    run('UPDATE backend_log_sync_install SET wifi_only=?,hold_since=NULL,updated_at=? WHERE cloud_ref=? AND install_id=?', Number(enabled), nowIso(), cloudRef, installId);
    return policy();
  }
  function redacted(value, limit) {
    const result = redactText(value);
    if (typeof result !== 'string') throw problem('LOG_REDACTION_INVALID', '日志脱敏没有形成可上传文本', 500);
    return maskText(result).slice(0, limit);
  }
  function eventFor(row) {
    if (!safeInteger(row.log_id) || row.log_id < 1 || !validIso(row.occurred_at) || !LEVELS.has(row.level)
      || !bounded(row.category, 48) || !row.category || typeof row.message !== 'string' || typeof row.event_ref !== 'string') {
      throw problem('LOG_SOURCE_EVENT_INVALID', '新运行日志原始字段不符合上传合同，原记录已保留', 500);
    }
    const detail = parseStored(row.detail_json, '运行日志上传详情');
    if (!plainObject(detail)) throw problem('LOG_SOURCE_DETAIL_INVALID', '运行日志详情不是可审对象，原记录已保留', 500);
    const sourceErrorCode = row.error_code ?? detail.errorCode;
    if (sourceErrorCode !== null && sourceErrorCode !== undefined
      && (typeof sourceErrorCode !== 'string' || sourceErrorCode.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(sourceErrorCode))) {
      throw problem('LOG_SOURCE_ERROR_CODE_INVALID', '本地日志错误码超出云端128字符合同，原始日志已保留', 500);
    }
    const event = {
      eventId: 'b2_' + fingerprint([cloudRef, row.owner_ref, installId, row.log_id, row.event_ref]).slice(0, 61),
      seq: row.log_id, installId, occurredAt: row.occurred_at, level: row.level,
      category: row.category, message: redacted(row.message, 1200), appVersion,
    };
    if (row.account_ref !== '0') {
      event.accountLabel = { stableId: fingerprint([row.owner_ref, row.account_ref]) };
      if (labelForAccount) {
        const label = labelForAccount({ ownerRef: row.owner_ref, accountRef: row.account_ref });
        if (label && typeof label.then === 'function') throw problem('LOG_LABEL_ASYNC_FORBIDDEN', '日志归属投影必须同步完成', 500);
        if (plainObject(label)) for (const key of ['nickname', 'serverName']) {
          if (typeof label[key] === 'string') event.accountLabel[key] = redacted(label[key], 64);
        }
      }
    }
    for (const [key, limit, column] of [['traceId', 64, 'trace_id'], ['operationId', 64, 'operation_id'], ['errorCode', 128, 'error_code']]) {
      const value = key === 'errorCode' ? sourceErrorCode : (row[column] || detail[key]);
      if (value !== null && value !== undefined && bounded(value, limit) && /^[A-Za-z0-9_.:-]+$/.test(value)) event[key] = value;
    }
    if (typeof detail.attempted === 'boolean' || row.attempted === 0 || row.attempted === 1) event.attempted = typeof detail.attempted === 'boolean' ? detail.attempted : row.attempted === 1;
    const localOutcome = row.outcome_state || detail.outcomeState || detail.verdict;
    const outcomeState = localOutcome === 'unknown' || localOutcome === 'rejected' ?
      (localOutcome === 'unknown' ? 'unconfirmed' : 'failed') : localOutcome;
    if (OUTCOMES.has(outcomeState)) event.outcomeState = outcomeState;
    if (plainObject(detail.outcome)) {
      const outcome = {};
      for (const key of ['sent', 'confirmed', 'unconfirmed']) if (safeInteger(detail.outcome[key])) outcome[key] = detail.outcome[key];
      if (Object.keys(outcome).length) event.outcome = outcome;
    }
    // Only protocol codes and primitive booleans are copied; arbitrary request,
    // credentials, official body and free diagnostic objects never leave here.
    const diagnostic = {};
    for (const key of ['loginCode', 'loginCodeKey', 'serverMsgCode', 'code', 'readFailureKind']) {
      const value = detail[key];
      if (key === 'readFailureKind' ? typeof value === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(value)
        : safeInteger(value) || typeof value === 'string' && value.length <= (key === 'loginCodeKey' ? 64 : 128) && /^\$?[A-Za-z0-9_.:-]+$/.test(value)) diagnostic[key] = value;
    }
    for (const key of ['attempted', 'ok']) if (typeof detail[key] === 'boolean') diagnostic[key] = detail[key];
    for (const key of ['transportFailure','retryable','userActionRequired','closureProven']) if (typeof detail[key] === 'boolean') diagnostic[key] = detail[key];
    if (['cleanup_pending','waiting_network','scheduled','blocked','connected','stopped','suspended'].includes(detail.status)) diagnostic.status = detail.status;
    for (const key of ['attempt','retryAfterMs']) if (safeInteger(detail[key])) diagnostic[key] = detail[key];
    for (const key of ['cause', 'reasonCode']) if (typeof detail[key] === 'string' && detail[key].length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(detail[key])) diagnostic[key] = detail[key];
    if (typeof detail.action === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(detail.action)) diagnostic.action = detail.action;
    if (safeInteger(detail.retryAtMs) && detail.retryAtMs > 0) diagnostic.retryAtMs = detail.retryAtMs;
    const symbol = value => typeof value === 'string' && value.length <= 64 && /^[A-Za-z0-9_.:-]+$/.test(value);
    const integerField = (key, column) => {
      const value = row[column] ?? detail[key];
      if (safeInteger(value) && value >= 0) diagnostic[key] = value;
    };
    for (const [key, column] of [['eventType', 'event_type'], ['phase', 'phase'], ['method', 'method']]) {
      const value = row[column] || detail[key];
      if (symbol(value)) diagnostic[key] = value;
    }
    const state = detail.eventState;
    if (['requested', 'not-started', 'completed', 'incomplete', 'failed'].includes(state)) diagnostic.eventState = state;
    integerField('runEpoch', 'run_epoch'); integerField('connectionEpoch', 'connection_epoch');
    integerField('requestSequence', 'request_sequence'); integerField('retryAtMs', 'retry_at_ms');
    const schemaVersion = row.schema_version ?? detail.schemaVersion;
    if (safeInteger(schemaVersion) && schemaVersion > 0) diagnostic.schemaVersion = schemaVersion;
    if (Number.isSafeInteger(detail.httpStatus) && detail.httpStatus >= 100 && detail.httpStatus <= 599) diagnostic.httpStatus = detail.httpStatus;
    const namespace = detail.sourceNamespace;
    if (symbol(namespace)) diagnostic.sourceNamespace = namespace;
    if (symbol(detail.loginKind)) diagnostic.loginKind = detail.loginKind;
    let truncated = row.truncated === 1 || detail.truncated === true;
    const safeSemanticPath = value => typeof value === 'string' && value.length <= 192 && /^[A-Za-z0-9._*\[\]-]+$/.test(value);
    const safeStackPath = value => typeof value === 'string' && value.length <= 512 &&
      /^(?:backend\/[A-Za-z0-9_.\/-]+\.mjs:\d+:\d+)(?: > backend\/[A-Za-z0-9_.\/-]+\.mjs:\d+:\d+){0,5}$/.test(value);
    if (typeof detail.domainId === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(detail.domainId)) diagnostic.domainId = detail.domainId;
    if (safeStackPath(detail.path)) diagnostic.path = detail.path;
    if (typeof detail.difference === 'string' && /^[a-z0-9-]{1,64}$/.test(detail.difference)) diagnostic.difference = detail.difference;
    for (const key of ['rawAnchorMatches', 'priorProjectionReceiptAvailable', 'proofAdvanced']) {
      if (typeof detail[key] === 'boolean') diagnostic[key] = detail[key];
    }
    for (const key of ['changedPaths', 'removedPaths', 'addedPaths']) {
      if (detail[key] === undefined) continue;
      const values = Array.isArray(detail[key]) ? detail[key] : [];
      if (key === 'changedPaths') {
        const valid = values.slice(0, 16).flatMap(one => plainObject(one) && safeSemanticPath(one.path) &&
          (one.storedFingerprint === null || /^[a-f0-9]{64}$/.test(one.storedFingerprint || '')) &&
          (one.currentFingerprint === null || /^[a-f0-9]{64}$/.test(one.currentFingerprint || ''))
          ? [{ path: one.path, storedFingerprint: one.storedFingerprint, currentFingerprint: one.currentFingerprint }] : []);
        diagnostic.changedPaths = valid;
        if (!Array.isArray(detail[key]) || values.length > 16 || valid.length !== Math.min(values.length, 16)) truncated = true;
      } else {
        const valid = values.filter(safeSemanticPath).slice(0, 16);
        diagnostic[key] = valid;
        if (!Array.isArray(detail[key]) || values.length > 16 || valid.length !== Math.min(values.length, 16)) truncated = true;
      }
    }
    for (const key of ['remoteCode', 'transportCode']) {
      const value = detail[key];
      if (typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(value) || Number.isSafeInteger(value)) diagnostic[key] = value;
    }
    for (const key of ['domains', 'reasons']) {
      if (detail[key] === undefined) continue;
      const values = Array.isArray(detail[key]) ? detail[key] : [];
      const valid = values.filter(symbol).slice(0, 16);
      if (valid.length) diagnostic[key] = valid;
      if (!Array.isArray(detail[key]) || values.length > 16 || valid.length !== values.length) truncated = true;
    }
    if (truncated) diagnostic.truncated = true;
    if (Buffer.byteLength(JSON.stringify(diagnostic), 'utf8') > 4000) {
      for (const key of ['changedPaths', 'addedPaths', 'removedPaths', 'domains', 'reasons', 'path']) delete diagnostic[key];
      diagnostic.truncated = true;
    }
    while (Object.keys(diagnostic).length && Buffer.byteLength(JSON.stringify(diagnostic), 'utf8') > 4000) {
      const removable = Object.keys(diagnostic).find(key => !['eventState','eventType','phase','method','runEpoch','connectionEpoch','requestSequence','retryAtMs','schemaVersion','truncated',
        'code','reasonCode','cause','domainId','difference','rawAnchorMatches','priorProjectionReceiptAvailable','proofAdvanced'].includes(key));
      if (!removable) break;
      delete diagnostic[removable]; diagnostic.truncated = true;
    }
    if (Object.keys(diagnostic).length) event.diagnostic = diagnostic;
    return event;
  }
  function previouslyAcknowledgedEvent(row) {
    const eventId = 'b2_' + fingerprint([cloudRef, row.owner_ref, installId, row.log_id, row.event_ref]).slice(0, 61);
    const candidates = all(`SELECT b.*,r.receipt_state,r.identity_epoch AS receipt_identity_epoch,
      r.accepted_json,r.duplicates_json,r.rejected_json,r.received_at
      FROM backend_log_sync_batches b JOIN backend_log_sync_receipts r ON r.batch_id=b.batch_id
      WHERE b.cloud_ref=? AND b.owner_ref=? AND b.install_id=? AND b.state='acknowledged'
        AND r.cloud_ref=? AND r.owner_ref=? AND r.install_id=? AND r.receipt_state='acknowledged'
        AND r.attempt_ref=b.attempt_ref AND r.identity_epoch=b.attempt_identity_epoch
        AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(b.events_json) THEN b.events_json ELSE '[]' END) e
          WHERE json_extract(e.value,'$.eventId')=? AND CAST(json_extract(e.value,'$.seq') AS INTEGER)=?)
      ORDER BY b.created_at DESC,b.batch_id DESC LIMIT 8`,
    cloudRef, row.owner_ref, installId, cloudRef, row.owner_ref, installId, eventId, row.log_id);
    for (const batch of candidates) {
      if (legacyBatchAssessment(batch).kind === 'corrupt') continue;
      let events, accepted, duplicates, rejected;
      try {
        events = parseStored(batch.events_json, '已确认日志原批次');
        accepted = parseStored(batch.accepted_json, '已确认日志接受回执');
        duplicates = parseStored(batch.duplicates_json, '已确认日志重复回执');
        rejected = parseStored(batch.rejected_json, '已确认日志拒收回执');
      } catch { continue; }
      if (!Array.isArray(events) || !Array.isArray(accepted) || !Array.isArray(duplicates) || !Array.isArray(rejected)) continue;
      const event = events.find(item => item.eventId === eventId && item.seq === row.log_id && item.installId === installId);
      const verifiedReceipt = validateReceipt({ accepted, duplicates, rejected, receivedAt: batch.received_at }, events);
      if (!event || !verifiedReceipt?.complete || ![...verifiedReceipt.accepted, ...verifiedReceipt.duplicates].includes(eventId)) continue;
      return clone(event);
    }
    return null;
  }
  function automaticError(row) {
    if (row?.level === 'error' || row?.outcome_state === 'failed' || row?.outcome_state === 'rejected') return true;
    try {
      const detail = parseStored(row?.detail_json, '自动日志资格');
      const outcome = row?.outcome_state || detail?.outcomeState || detail?.verdict;
      return outcome === 'failed' || outcome === 'rejected';
    } catch { return false; }
  }
  function legacyBatchAssessment(batch) {
    let events;
    try { events = parseStored(batch?.events_json, '历史待传日志'); } catch { return { kind: 'corrupt', eventCount: 0 }; }
    if (!Array.isArray(events) || !events.length || events.length > EVENT_LIMIT || fingerprint(events) !== batch.content_sha256
      || events.some(event => !plainObject(event) || !identifier(event.eventId) || event.installId !== installId || !safeInteger(event.seq)))
      return { kind: 'corrupt', eventCount: 0 };
    return events.every(event => event.level === 'error' || event.outcomeState === 'failed')
      ? { kind: 'error-only', eventCount: events.length } : { kind: 'mixed', eventCount: events.length };
  }
  function pendingBatch(context, selectionRef = null) {
    return transaction(() => {
      const existing = activeBatch(context.ownerRef);
      if (existing) {
        if (selectionRef && existing.selection_ref !== selectionRef) throw problem('LOG_UPLOAD_OTHER_BATCH_ACTIVE', '另一日志批次正在等待回执，请稍后重试', 409);
        return existing;
      }
      if (selectionRef) {
        const selection = get('SELECT * FROM backend_log_sync_selections WHERE selection_ref=? AND cloud_ref=? AND owner_ref=? AND install_id=?',
          selectionRef, cloudRef, context.ownerRef, installId);
        if (!selection || selection.identity_epoch !== context.identityEpoch || !['selected','sending'].includes(selection.state))
          throw problem('LOG_MANUAL_SELECTION_STALE', '手动日志选择已失效，请重新按当前筛选选择', 409);
        const ids = parseStored(selection.source_ids_json, '手动日志选择原件');
        if (!Array.isArray(ids) || ids.length > 10000 || ids.some(item => !plainObject(item)
          || item.kind === 'local' && (!safeInteger(item.logId) || item.logId < 1 || item.logId > selection.high_water_log_id)
          || item.kind === 'history' && (!safeInteger(item.indexId) || item.indexId < 1 || typeof item.sourceOriginRef !== 'string'
            || typeof item.subjectRef !== 'string' || !item.subjectRef || typeof item.sourceRowFingerprint !== 'string' || typeof item.includeRemoved !== 'boolean'
            || typeof item.readOnlyArchive !== 'boolean' || item.includeRemoved !== item.readOnlyArchive) || !['local','history'].includes(item.kind)))
          throw problem('LOG_MANUAL_SELECTION_CORRUPT', '手动日志选择清单无法核对', 500);
        const remaining = ids.slice(selection.next_index, selection.next_index + EVENT_LIMIT);
        if (!remaining.length) {
          run("UPDATE backend_log_sync_selections SET state='acknowledged',updated_at=? WHERE selection_ref=?", nowIso(), selectionRef);
          return null;
        }
        const events = [], picked = [];
        const batchSourceKind = remaining[0]?.kind;
        for (const descriptor of remaining) {
          if (descriptor.kind !== batchSourceKind) break;
          let row;
          if (descriptor.kind === 'local') {
            row = get('SELECT * FROM backend_local_logs WHERE owner_ref=? AND account_ref=? AND log_id=? AND log_id<=?',
              context.ownerRef, selection.account_ref, descriptor.logId, selection.high_water_log_id);
            if (!row || row.log_id !== descriptor.logId) throw problem('LOG_MANUAL_SOURCE_CHANGED', '筛选日志原行已变化或不再属于此来源', 409);
          } else {
            if (!readHistoricalSource) throw problem('LOG_HISTORY_UPLOAD_UNAVAILABLE', '历史日志手动上传来源尚未接入', 501);
            row = readHistoricalSource({ ownerRef: context.ownerRef, accountRef: selection.account_ref, subjectRef: descriptor.subjectRef,
              indexId: descriptor.indexId, sourceOriginRef: descriptor.sourceOriginRef,
              sourceRowFingerprint: descriptor.sourceRowFingerprint, includeRemoved: descriptor.includeRemoved,
              readOnlyArchive: descriptor.readOnlyArchive });
            if (!row || row.log_id !== descriptor.indexId || row.owner_ref !== context.ownerRef || row.account_ref !== selection.account_ref)
              throw problem('LOG_MANUAL_SOURCE_CHANGED', '历史筛选日志原件已变化或不再属于此来源', 409);
          }
          let event;
          try { event = previouslyAcknowledgedEvent(row) || eventFor(row); }
          catch (error) {
            if (events.length) break;
            quarantineSourceRow(row, context, error?.code || 'LOG_SOURCE_EVENT_INVALID', { mode: 'manual-selection', selectionRef });
            return null;
          }
          const next = [...events, event];
          if (Buffer.byteLength(canonical({ events: next }), 'utf8') > REQUEST_LIMIT_BYTES) {
            if (!events.length) {
              quarantineSourceRow(row, context, 'LOG_EVENT_TOO_LARGE', { mode: 'manual-selection', selectionRef });
              return null;
            }
            break;
          }
          events.push(event); picked.push(descriptor);
          if (events.length >= EVENT_LIMIT) break;
        }
        if (!events.length) return null;
        const encoded = canonical(events), from = Math.max(0, events[0].seq - 1), through = events.at(-1).seq, batchId = newId();
        run(`INSERT INTO backend_log_sync_batches(batch_id,cloud_ref,owner_ref,install_id,from_log_id,through_log_id,
          events_json,content_sha256,state,mode,selection_ref,source_ids_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        batchId, cloudRef, context.ownerRef, installId, from, through, encoded, fingerprint(events), 'pending', 'manual-selection', selectionRef,
        canonical(picked), nowIso(), nowIso());
        run("UPDATE backend_log_sync_selections SET state='sending',updated_at=? WHERE selection_ref=?", nowIso(), selectionRef);
        return activeBatch(context.ownerRef);
      }
      const rejectedLegacy = get(`SELECT * FROM backend_log_sync_batches WHERE cloud_ref=? AND owner_ref=? AND install_id=?
        AND mode='legacy' AND state='rejected' ORDER BY created_at,batch_id LIMIT 1`, cloudRef, context.ownerRef, installId);
      if (rejectedLegacy) {
        const assessment = legacyBatchAssessment(rejectedLegacy);
        if (assessment.kind !== 'error-only') {
          const state = assessment.kind === 'corrupt' ? 'held-corrupt' : 'held-policy';
          run('UPDATE backend_log_sync_batches SET state=?,last_code=?,updated_at=? WHERE batch_id=? AND state=\'rejected\'',
            state, assessment.kind === 'corrupt' ? 'LOG_BATCH_CORRUPT' : 'AUTO_UPLOAD_POLICY_CHANGED', nowIso(), rejectedLegacy.batch_id);
        } else {
          run("UPDATE backend_log_sync_batches SET state='pending',updated_at=? WHERE batch_id=? AND state='rejected'", nowIso(), rejectedLegacy.batch_id);
          return activeBatch(context.ownerRef);
        }
      }
      const acknowledgedPrefix = Number(cursor(context.ownerRef).last_log_id || 0);
      run('INSERT OR IGNORE INTO backend_log_auto_scans(cloud_ref,owner_ref,install_id,high_water_log_id,updated_at) VALUES(?,?,?,?,?)',
        cloudRef, context.ownerRef, installId, acknowledgedPrefix, nowIso());
      const scan = get('SELECT * FROM backend_log_auto_scans WHERE cloud_ref=? AND owner_ref=? AND install_id=?', cloudRef, context.ownerRef, installId);
      const rows = all(`SELECT * FROM backend_local_logs WHERE owner_ref=? AND log_id>? AND ${AUTO_ERROR_SQL} ORDER BY log_id LIMIT ?`,
        context.ownerRef, scan.high_water_log_id, EVENT_LIMIT);
      if (!rows.length) {
        const high = Number(get('SELECT COALESCE(MAX(log_id),0) AS high FROM backend_local_logs WHERE owner_ref=?', context.ownerRef).high || 0);
        if (high > scan.high_water_log_id) run('UPDATE backend_log_auto_scans SET high_water_log_id=?,updated_at=? WHERE cloud_ref=? AND owner_ref=? AND install_id=? AND high_water_log_id=?',
          high, nowIso(), cloudRef, context.ownerRef, installId, scan.high_water_log_id);
        return null;
      }
      const events = [];
      const sourceIds = [];
      let scannedThrough = scan.high_water_log_id;
      for (const row of rows) {
        if (!automaticError(row)) { scannedThrough = row.log_id; continue; }
        let event;
        try { event = eventFor(row); }
        catch (error) {
          if (!events.length) {
            quarantineSourceRow(row, context, error?.code || 'LOG_SOURCE_EVENT_INVALID', { mode: 'auto-error' });
            return null;
          }
          break;
        }
        const next = [...events, event];
        if (Buffer.byteLength(canonical({ events: next }), 'utf8') > REQUEST_LIMIT_BYTES) {
          if (!events.length) {
            quarantineSourceRow(row, context, 'LOG_EVENT_TOO_LARGE', { mode: 'auto-error' });
            return null;
          }
          break;
        }
        events.push(event); sourceIds.push(row.log_id); scannedThrough = row.log_id;
      }
      if (!events.length) {
        run('UPDATE backend_log_auto_scans SET high_water_log_id=?,updated_at=? WHERE cloud_ref=? AND owner_ref=? AND install_id=? AND high_water_log_id=?',
          scannedThrough, nowIso(), cloudRef, context.ownerRef, installId, scan.high_water_log_id);
        return null;
      }
      const through = events.at(-1).seq, from = events[0].seq - 1;
      const batchId = newId(), encoded = canonical(events);
      run(`INSERT INTO backend_log_sync_batches(batch_id,cloud_ref,owner_ref,install_id,from_log_id,through_log_id,
        events_json,content_sha256,state,mode,source_ids_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      batchId, cloudRef, context.ownerRef, installId, from, through, encoded, fingerprint(events), 'pending', 'auto-error', canonical(sourceIds), nowIso(), nowIso());
      run('UPDATE backend_log_auto_scans SET high_water_log_id=?,updated_at=? WHERE cloud_ref=? AND owner_ref=? AND install_id=? AND high_water_log_id=?',
        scannedThrough, nowIso(), cloudRef, context.ownerRef, installId, scan.high_water_log_id);
      return activeBatch(context.ownerRef);
    });
  }
  function createManualSelection({ accountRef, sourceLogIds = [], sourceRefs = [], highWaterLogId } = {}) {
    const context = captureIdentity();
    const descriptors = [...sourceLogIds.map(logId => ({ kind: 'local', logId })), ...[...sourceRefs].sort((a, b) => a.indexId - b.indexId)];
    if (!context || closed) throw problem('LOG_MANUAL_SELECTION_IDENTITY_REQUIRED', '当前软件身份不可用于日志上传', 401);
    if (typeof accountRef !== 'string' || !/^(?:0|[1-9]\d*)$/.test(accountRef) || !safeInteger(highWaterLogId) ||
        !Array.isArray(sourceLogIds) || !Array.isArray(sourceRefs) || descriptors.length < 1 || descriptors.length > 10000 ||
        sourceLogIds.some((id, index) => !safeInteger(id) || id < 1 || id > highWaterLogId || index > 0 && id <= sourceLogIds[index - 1]) ||
        sourceRefs.some(one => !plainObject(one) || one.kind !== 'history' || !safeInteger(one.indexId) || one.indexId < 1
          || typeof one.sourceOriginRef !== 'string' || one.sourceOriginRef.length > 256
          || typeof one.subjectRef !== 'string' || !one.subjectRef || one.subjectRef.length > 256
          || typeof one.sourceRowFingerprint !== 'string' || one.sourceRowFingerprint.length > 128
          || typeof one.includeRemoved !== 'boolean' || typeof one.readOnlyArchive !== 'boolean' || one.includeRemoved !== one.readOnlyArchive))
      throw problem('LOG_MANUAL_SELECTION_INVALID', '筛选范围或来源日志编号无效', 400);
    const selectionRef = newId();
    transaction(() => run(`INSERT INTO backend_log_sync_selections(selection_ref,cloud_ref,owner_ref,install_id,account_ref,
      identity_epoch,high_water_log_id,source_ids_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    selectionRef, cloudRef, context.ownerRef, installId, accountRef, context.identityEpoch, highWaterLogId,
    canonical(descriptors), 'selected', nowIso(), nowIso()));
    return { selectionRef, selected: descriptors.length, highWaterLogId };
  }
  function validateReceipt(reply, events) {
    if (!plainObject(reply) || !Array.isArray(reply.accepted) || !Array.isArray(reply.duplicates) || !Array.isArray(reply.rejected) || !validIso(reply.receivedAt)) return null;
    const expected = new Set(events.map(event => event.eventId)), seen = new Set();
    for (const id of [...reply.accepted, ...reply.duplicates]) {
      if (!identifier(id) || !expected.has(id) || seen.has(id)) return null;
      seen.add(id);
    }
    const rejected = [];
    for (const entry of reply.rejected) {
      if (!plainObject(entry) || !expected.has(entry.eventId) || seen.has(entry.eventId) || safeCode(entry.reason) !== entry.reason) return null;
      seen.add(entry.eventId); rejected.push({ eventId: entry.eventId, reason: entry.reason });
    }
    return { accounted: seen.size === events.length, complete: seen.size === events.length && rejected.length === 0,
      accepted: [...reply.accepted], duplicates: [...reply.duplicates], rejected, receivedAt: reply.receivedAt };
  }
  function recordFailure(batch, context, attemptRef, code, retryAfterMs = null, rejected = null) {
    return transaction(() => {
      const latest = get('SELECT * FROM backend_log_sync_batches WHERE batch_id=?', batch.batch_id);
      if (!latest || latest.attempt_ref !== attemptRef || ['acknowledged', 'quarantined'].includes(latest.state)) return false;
      const reason = safeCode(code), permanent = PERMANENT.has(reason) || rejected?.some(entry => PERMANENT.has(entry.reason));
      if (permanent && current(context)) return quarantine(latest, rejected?.find(entry => PERMANENT.has(entry.reason))?.reason || reason);
      run('UPDATE backend_log_sync_batches SET state=?,last_code=?,updated_at=? WHERE batch_id=? AND attempt_ref=?',
        'unknown', reason, nowIso(), batch.batch_id, attemptRef);
      if (!current(context)) return false;
      const head = cursor(context.ownerRef), failures = head.failures + 1;
      const wait = Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? Math.min(86400000, Math.ceil(retryAfterMs)) : BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
      run('UPDATE backend_log_sync_cursors SET failures=?,retry_at_ms=?,last_code=?,updated_at=? WHERE cloud_ref=? AND owner_ref=? AND install_id=?',
        failures, Date.now() + wait, reason, nowIso(), cloudRef, context.ownerRef, installId);
      return false;
    });
  }
  function quarantineRejectedEvents(batch, context, attemptRef, result) {
    if (!result.accounted || !result.rejected.length || result.rejected.some(entry => !PERMANENT.has(entry.reason))) return false;
    return transaction(() => {
      const latest = activeBatch(context.ownerRef), head = cursor(context.ownerRef);
      if (!latest || latest.batch_id !== batch.batch_id || latest.attempt_ref !== attemptRef
        || batch.mode === 'legacy' && head.selection_log_id !== batch.from_log_id || !current(context)) return false;
      const events = parseStored(batch.events_json, '逐事件隔离原批次');
      const byId = new Map(events.map(event => [event.eventId, event]));
      const descriptors = batch.mode === 'manual-selection' ? parseStored(batch.source_ids_json, '手动日志隔离来源') : null;
      for (const rejected of result.rejected) {
        const event = byId.get(rejected.eventId);
        if (!event || !safeInteger(event.seq)) throw problem('LOG_EVENT_QUARANTINE_MISMATCH', '拒收事件无法绑定原始本地日志', 500);
        const eventIndex = events.findIndex(one => one.eventId === rejected.eventId);
        const descriptor = Array.isArray(descriptors) ? descriptors[eventIndex] : null;
        let source;
        if (descriptor?.kind === 'history' && readHistoricalSource) {
          const selection = get('SELECT account_ref FROM backend_log_sync_selections WHERE selection_ref=? AND owner_ref=? AND install_id=?',
            batch.selection_ref, context.ownerRef, installId);
          const account = selection && get('SELECT subject_ref FROM backend_accounts WHERE owner_ref=? AND account_id=?', context.ownerRef, Number(selection.account_ref));
          source = account && account.subject_ref === descriptor.subjectRef ? readHistoricalSource({ ownerRef: context.ownerRef, accountRef: selection.account_ref,
            subjectRef: descriptor.subjectRef, indexId: descriptor.indexId, sourceOriginRef: descriptor.sourceOriginRef,
            sourceRowFingerprint: descriptor.sourceRowFingerprint, includeRemoved: descriptor.includeRemoved,
            readOnlyArchive: descriptor.readOnlyArchive }) : null;
        } else source = get('SELECT * FROM backend_local_logs WHERE owner_ref=? AND log_id=?', context.ownerRef, event.seq);
        const raw = canonical({ sourceRow: source, submittedEvent: event });
        run(`INSERT OR IGNORE INTO backend_log_sync_quarantined_events(quarantine_ref,cloud_ref,owner_ref,install_id,
          source_log_id,event_ref,raw_source_json,raw_content_sha256,reason,attempt_ref,recorded_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`, newId(), cloudRef, context.ownerRef, installId, event.seq,
          source?.event_ref || rejected.eventId, raw, fingerprint(raw), rejected.reason, attemptRef, nowIso());
      }
      receipt(batch, context, attemptRef, result, 'partial_quarantine');
      run(`UPDATE backend_log_sync_batches SET state='partially_quarantined',last_code=?,updated_at=?
        WHERE batch_id=? AND attempt_ref=?`, result.rejected[0].reason, nowIso(), batch.batch_id, attemptRef);
      if (batch.mode === 'legacy') run(`UPDATE backend_log_sync_cursors SET selection_log_id=?,failures=0,retry_at_ms=0,auto_due_ms=?,
        last_code=?,updated_at=? WHERE cloud_ref=? AND owner_ref=? AND install_id=? AND selection_log_id=?`,
        batch.through_log_id, Date.now() + stagger, result.rejected[0].reason, nowIso(), cloudRef, context.ownerRef, installId, batch.from_log_id);
      if (batch.selection_ref) run("UPDATE backend_log_sync_selections SET state='partially_quarantined',updated_at=? WHERE selection_ref=?", nowIso(), batch.selection_ref);
      return true;
    });
  }
  function receipt(batch, context, attemptRef, result, state) {
    run(`INSERT INTO backend_log_sync_receipts(receipt_id,batch_id,cloud_ref,owner_ref,install_id,identity_epoch,attempt_ref,
      receipt_state,accepted_json,duplicates_json,rejected_json,received_at,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    newId(), batch.batch_id, cloudRef, context.ownerRef, installId, context.identityEpoch, attemptRef, state,
    canonical(result.accepted), canonical(result.duplicates), canonical(result.rejected), result.receivedAt, nowIso());
  }
  async function upload(context, manual, selectionRef = null) {
    const held = policy();
    if (!current(context)) return { sent: 0, reason: 'identity_changed' };
    if (held.holdSince) return { sent: 0, reason: 'wifi_only', holdSince: held.holdSince, pending: held.pending };
    const head = cursor(context.ownerRef), state = installState(), now = Date.now();
    if (head.retry_at_ms > now) return { sent: 0, reason: 'backoff', retryAt: new Date(head.retry_at_ms).toISOString() };
    if (state.next_send_ms > now) return { sent: 0, reason: 'cooldown' };
    if (!manual && head.auto_due_ms > now) return { sent: 0, reason: 'not_due' };
    if (manual && !selectionRef) return { sent: 0, reason: 'selection_required' };
    const batch = pendingBatch(context, selectionRef);
    if (!batch) {
      const isolated = quarantineCounts(context.ownerRef);
      return Number(isolated.events) > 0
        ? { sent: 0, confirmed: false, reason: 'receipt_quarantined', quarantined: true,
          quarantinedEvents: Number(isolated.events), unconfirmed: Number(isolated.events) }
        : { sent: 0, reason: 'empty' };
    }
    const events = parseStored(batch.events_json, '日志上传原批次');
    if (!Array.isArray(events) || events.length < 1 || events.length > EVENT_LIMIT || fingerprint(events) !== batch.content_sha256
      || events.some(event => event.installId !== installId || !identifier(event.eventId))) throw problem('LOG_BATCH_CORRUPT', '日志原批次内容无法核对，原资料已保留', 500);
    const attemptRef = newId();
    transaction(() => {
      if (!current(context)) throw problem('LOG_UPLOAD_CONTEXT_CHANGED', '日志发送前身份已经变化');
      const currentBatch = activeBatch(context.ownerRef), currentCursor = cursor(context.ownerRef), currentInstall = installState();
      if (currentBatch?.batch_id !== batch.batch_id || currentBatch.content_sha256 !== batch.content_sha256
        || batch.mode === 'legacy' && currentCursor.selection_log_id !== batch.from_log_id || currentInstall.next_send_ms > Date.now()) throw problem('LOG_UPLOAD_BATCH_CHANGED', '日志待传批次或发送额度已经变化');
      run('UPDATE backend_log_sync_batches SET state=?,attempts=attempts+1,attempt_ref=?,attempt_identity_epoch=?,updated_at=? WHERE batch_id=?',
        'sending', attemptRef, context.identityEpoch, nowIso(), batch.batch_id);
      const backlogAfterBatch = Math.max(0, Number(held.pending || 0) - events.length);
      const sendGateMs = backlogAfterBatch > BACKLOG_THRESHOLD ? BACKLOG_COOLDOWN_MS : COOLDOWN_MS;
      run('UPDATE backend_log_sync_install SET next_send_ms=?,updated_at=? WHERE cloud_ref=? AND install_id=?', Date.now() + sendGateMs, nowIso(), cloudRef, installId);
    });
    try {
      // No await between the last identity check and this private sender entry.
      // The sender repeats the context check before taking its private token.
      if (!current(context)) throw problem('LOG_UPLOAD_CONTEXT_CHANGED', '日志发送前身份已经变化');
      const reply = await sendLogs({ ...context, events: freeze(clone(events)) });
      const result = validateReceipt(reply, events);
      if (!current(context)) {
        transaction(() => { if (result) receipt(batch, context, attemptRef, result, 'late'); });
        recordFailure(batch, context, attemptRef, 'LOG_ACK_LATE');
        return { sent: 0, attempted: events.length, reason: 'identity_changed', code: 'LOG_ACK_LATE', confirmed: false };
      }
      if (!result) {
        recordFailure(batch, context, attemptRef, 'LOG_ACK_INCOMPLETE');
        return { sent: 0, attempted: events.length, reason: 'receipt_incomplete', code: 'LOG_ACK_INCOMPLETE', confirmed: false };
      }
      if (result.accounted && !result.complete && result.rejected.length && result.rejected.every(entry => PERMANENT.has(entry.reason))) {
        const quarantined = quarantineRejectedEvents(batch, context, attemptRef, result);
        if (quarantined) return { sent: result.accepted.length + result.duplicates.length, attempted: events.length,
          accepted: result.accepted.length, duplicates: result.duplicates.length, rejected: result.rejected.length,
          confirmed: false, quarantined: true, quarantinedEvents: result.rejected.length,
          reason: 'partial_event_quarantine', code: result.rejected[0].reason, batchId: batch.batch_id };
      }
      transaction(() => {
        if (!current(context)) throw problem('LOG_UPLOAD_CONTEXT_CHANGED', '日志回执落账前身份已经变化');
        const latest = activeBatch(context.ownerRef), original = cursor(context.ownerRef);
        if (latest?.batch_id !== batch.batch_id || latest.attempt_ref !== attemptRef
          || latest.attempt_identity_epoch !== context.identityEpoch || batch.mode === 'legacy' && original.selection_log_id !== batch.from_log_id) {
          throw problem('LOG_ACK_CONTEXT_MISMATCH', '日志回执不属于当前待传批次');
        }
        receipt(batch, context, attemptRef, result, result.complete ? 'acknowledged' : 'incomplete');
        if (!result.complete) return;
        run('UPDATE backend_log_sync_batches SET state=?,last_code=NULL,updated_at=? WHERE batch_id=? AND attempt_ref=?', 'acknowledged', nowIso(), batch.batch_id, attemptRef);
        if (batch.mode === 'legacy') run(`UPDATE backend_log_sync_cursors SET last_log_id=CASE WHEN last_log_id=? THEN ? ELSE last_log_id END,
          selection_log_id=?,failures=0,retry_at_ms=0,auto_due_ms=?,last_success_at=?,last_code=NULL,updated_at=?
          WHERE cloud_ref=? AND owner_ref=? AND install_id=? AND selection_log_id=?`,
          batch.from_log_id, batch.through_log_id, batch.through_log_id,
          Date.now() + (Math.max(0, Number(held.pending || 0) - events.length) > BACKLOG_THRESHOLD ? BACKLOG_COOLDOWN_MS : stagger),
          nowIso(), nowIso(), cloudRef, context.ownerRef, installId, batch.from_log_id);
        if (batch.mode === 'legacy') run(`UPDATE backend_log_auto_scans SET high_water_log_id=MAX(high_water_log_id,?),updated_at=?
          WHERE cloud_ref=? AND owner_ref=? AND install_id=?`, batch.through_log_id, nowIso(), cloudRef, context.ownerRef, installId);
        else run('UPDATE backend_log_sync_cursors SET failures=0,retry_at_ms=0,auto_due_ms=?,last_success_at=?,last_code=NULL,updated_at=? WHERE cloud_ref=? AND owner_ref=? AND install_id=?',
          Date.now() + stagger, nowIso(), nowIso(), cloudRef, context.ownerRef, installId);
        if (batch.selection_ref) {
          const selection = get('SELECT source_ids_json,next_index FROM backend_log_sync_selections WHERE selection_ref=?', batch.selection_ref);
          const ids = selection ? parseStored(selection.source_ids_json, '手动日志选择原件') : [];
          const nextIndex = Number(selection?.next_index || 0) + events.length;
          run('UPDATE backend_log_sync_selections SET next_index=?,state=?,updated_at=? WHERE selection_ref=?',
            nextIndex, nextIndex >= ids.length ? 'acknowledged' : 'selected', nowIso(), batch.selection_ref);
        }
      });
      if (!result.complete) {
        const reason = result.accounted ? result.rejected[0]?.reason || 'LOG_ACK_INCOMPLETE' : 'LOG_ACK_INCOMPLETE';
        // A partial receipt cannot prove that any omitted event was delivered.
        // Retry the immutable batch; the cloud event IDs make already accepted
        // entries idempotent. Never route this case into batch quarantine.
        const quarantined = recordFailure(batch, context, attemptRef, 'LOG_ACK_INCOMPLETE');
        return { sent: 0, attempted: events.length, accepted: result.accepted.length, duplicates: result.duplicates.length, rejected: result.rejected.length,
          confirmed: false, quarantined, reason: quarantined ? 'receipt_quarantined' : 'receipt_incomplete', code: reason, batchId: batch.batch_id };
      }
      return { sent: events.length, attempted: events.length, accepted: result.accepted.length, duplicates: result.duplicates.length, rejected: 0,
        confirmed: true, batchId: batch.batch_id, throughLocalId: batch.through_log_id,
        ...(batch.selection_ref ? { selectionRef: batch.selection_ref } : {}) };
    } catch (error) {
      const code = safeCode(error?.code);
      const quarantined = recordFailure(batch, context, attemptRef, code, error?.retryAfterMs);
      return { sent: 0, attempted: events.length, confirmed: false, quarantined, reason: quarantined ? 'receipt_quarantined' : 'upload_unconfirmed', code, batchId: batch.batch_id };
    }
  }
  function flush({ manual = false, selectionRef = null } = {}) {
    if (typeof manual !== 'boolean' || manual && !identifier(selectionRef)) return Promise.reject(problem('LOG_UPLOAD_MODE_INVALID', '日志同步方式或手动选择标识无效', 400));
    if (closed) return Promise.resolve({ sent: 0, reason: 'stopped' });
    const context = captureIdentity();
    if (!context) return Promise.resolve({ sent: 0, reason: 'signed_out' });
    if (flight) {
      if (flight.context.ownerRef !== context.ownerRef || flight.context.identityEpoch !== context.identityEpoch)
        return Promise.resolve({ sent: 0, reason: 'previous_identity_in_flight' });
      if (flight.manual === manual && (!manual || flight.selectionRef === selectionRef)) return flight.promise;
      return Promise.resolve({ sent: 0, reason: 'queued_behind_other_batch', queued: true,
        activeMode: flight.manual ? 'manual-selection' : 'automatic-error', activeSelectionRef: flight.selectionRef });
    }
    const item = { context, promise: null, manual, selectionRef };
    const promise = Promise.resolve().then(() => upload(context, manual, selectionRef)).catch(error => {
      // A malformed local row cannot be skipped just to move the cursor. Make
      // the blocked source visible even when the automatic timer called us.
      if (current(context) && typeof error?.code === 'string' && error.code.startsWith('LOG_')) {
        const head = cursor(context.ownerRef), failures = head.failures + 1;
        run('UPDATE backend_log_sync_cursors SET failures=?,retry_at_ms=?,last_code=?,updated_at=? WHERE cloud_ref=? AND owner_ref=? AND install_id=?',
          failures, Date.now() + BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)], safeCode(error.code), nowIso(), cloudRef, context.ownerRef, installId);
      }
      throw error;
    }).finally(() => { if (flight === item) flight = null; });
    item.promise = promise; flight = item;
    return promise;
  }
  function nextManualSelection(context) {
    return get(`SELECT selection_ref FROM backend_log_sync_selections WHERE cloud_ref=? AND owner_ref=? AND install_id=?
      AND identity_epoch=? AND state IN ('selected','sending') ORDER BY created_at,selection_ref LIMIT 1`,
      cloudRef, context.ownerRef, installId, context.identityEpoch)?.selection_ref || null;
  }
  function schedule() {
    if (!running || closed || timer) return;
    const context = captureIdentity();
    let delay = POLL_MS;
    if (context) {
      const policyNow = policy();
      const manualSelection = nextManualSelection(context);
      if ((policyNow.pending > 0 || manualSelection) && !policyNow.holdSince) {
        const head = cursor(context.ownerRef), install = installState(), now = Date.now();
        const due = Math.max(head.retry_at_ms || 0, manualSelection ? 0 : head.auto_due_ms || 0, install.next_send_ms || 0);
        delay = due > now ? Math.min(POLL_MS, due - now) : Math.min(POLL_MS, Number(policyNow.pending) > BACKLOG_THRESHOLD ? BACKLOG_COOLDOWN_MS : POLL_MS);
      }
    }
    timer = setTimeout(async () => {
      timer = null;
      try {
        const active = context ? activeBatch(context.ownerRef) : null;
        const selectionRef = active
          ? active.mode === 'manual-selection' ? active.selection_ref : null
          : context ? nextManualSelection(context) : null;
        if (selectionRef) await flush({ manual: true, selectionRef }); else await flush();
      } catch { /* Source/storage errors remain local and never advance a cursor. */ }
      finally { schedule(); }
    }, delay);
    timer.unref?.();
  }
  function start() {
    if (closed) throw problem('LOG_SYNC_CLOSED', '日志同步服务已停止', 503);
    running = true; schedule();
    return status();
  }
  async function stop() {
    closed = true; running = false; if (timer) clearTimeout(timer); timer = null;
    if (flight) await flight.promise.catch(() => {});
    return { stopped: true };
  }
  function status() {
    const context = captureIdentity(), uploadPolicy = policy();
    const head = context ? cursor(context.ownerRef) : null, batch = context ? activeBatch(context.ownerRef) : null;
    const isolated = context ? quarantineCounts(context.ownerRef) : { batches: 0, events: 0 };
    const acknowledged = context ? get(`SELECT MAX(through_log_id) AS through_id FROM backend_log_sync_batches
      WHERE cloud_ref=? AND owner_ref=? AND install_id=? AND state='acknowledged'`, cloudRef, context.ownerRef, installId) : null;
    return { source: 'backend_local_logs', pending: uploadPolicy.pending, inFlight: Boolean(flight), running: running && !closed,
      lastUploadedLocalId: head?.last_log_id ?? 0, lastSuccessAt: head?.last_success_at ?? null, lastUploadAt: head?.last_success_at ?? null, lastCode: head?.last_code ?? null,
      selectionLocalId: head?.selection_log_id ?? 0, lastAcknowledgedRangeLocalId: acknowledged?.through_id ?? 0,
      quarantinedBatches: Number(isolated.batches), quarantinedEvents: Number(isolated.events),
      unconfirmed: uploadPolicy.pending + Number(isolated.events), acknowledgedPrefixComplete: Number(isolated.events) === 0,
      baselineMs: BASELINE_MS, cooldownMs: COOLDOWN_MS, backlogCooldownMs: BACKLOG_COOLDOWN_MS, backlogThreshold: BACKLOG_THRESHOLD,
      nextAttemptAt: head && head.retry_at_ms > Date.now() ? new Date(head.retry_at_ms).toISOString() : null,
      batch: batch ? { batchId: batch.batch_id, state: batch.state, attempts: batch.attempts, code: batch.last_code,
        fromLocalId: batch.from_log_id, throughLocalId: batch.through_log_id } : null, uploadPolicy };
  }

  /**
   * The retention root: how far source rows may be removed without losing an
   * unconfirmed event. A scan cursor is progress, not consumption, so this reads
   * only acknowledged batches and subtracts every known gap:
   *   - a quarantined event at or below the acknowledged prefix,
   *   - a batch still pending/sending/unknown,
   *   - an eligible (error/failed) source row inside the claimed range that no
   *     acknowledged batch actually covers.
   * `removeThroughLocalId` is the only value a pruner may use.
   */
  function retentionView() {
    const context = captureIdentity();
    if (!context) return { ownerRef: null, removeThroughLocalId: 0, reason: 'IDENTITY_UNAVAILABLE' };
    const acknowledged = get(`SELECT MAX(through_log_id) AS through_id FROM backend_log_sync_batches
      WHERE cloud_ref=? AND owner_ref=? AND install_id=? AND state='acknowledged'`, cloudRef, context.ownerRef, installId);
    const acknowledgedThrough = Number(acknowledged?.through_id || 0);
    const quarantined = get(`SELECT MIN(source_log_id) AS first_id FROM backend_log_sync_quarantined_events
      WHERE cloud_ref=? AND owner_ref=? AND install_id=?`, cloudRef, context.ownerRef, installId);
    const quarantineFloor = quarantined?.first_id === null || quarantined?.first_id === undefined ? null : Number(quarantined.first_id) - 1;
    const openBatch = get(`SELECT MIN(from_log_id) AS first_id FROM backend_log_sync_batches
      WHERE cloud_ref=? AND owner_ref=? AND install_id=? AND state IN ('pending','sending','unknown')`, cloudRef, context.ownerRef, installId);
    const openFloor = openBatch?.first_id === null || openBatch?.first_id === undefined ? null : Number(openBatch.first_id) - 1;
    const uncovered = acknowledgedThrough > 0 ? get(`SELECT MIN(l.log_id) AS first_id FROM backend_local_logs l
      WHERE l.owner_ref=? AND l.log_id<=?
        AND (l.level='error' OR l.outcome_state IN ('failed','rejected')
          OR CASE WHEN json_valid(l.detail_json) THEN COALESCE(NULLIF(l.outcome_state,''),json_extract(l.detail_json,'$.outcomeState'),json_extract(l.detail_json,'$.verdict')) END IN ('failed','rejected'))
        AND NOT EXISTS (SELECT 1 FROM backend_log_sync_batches b WHERE b.cloud_ref=? AND b.owner_ref=? AND b.install_id=?
          AND b.state='acknowledged' AND l.log_id BETWEEN b.from_log_id AND b.through_log_id)`,
    context.ownerRef, acknowledgedThrough, cloudRef, context.ownerRef, installId) : null;
    const uncoveredFloor = uncovered?.first_id === null || uncovered?.first_id === undefined ? null : Number(uncovered.first_id) - 1;
    const floors = [acknowledgedThrough, quarantineFloor, openFloor, uncoveredFloor].filter(value => value !== null);
    const removeThroughLocalId = Math.max(0, Math.min(...floors));
    return { ownerRef: context.ownerRef, identityEpoch: context.identityEpoch, installId,
      acknowledgedThroughLocalId: acknowledgedThrough, quarantineFloorLocalId: quarantineFloor,
      openBatchFloorLocalId: openFloor, uncoveredEligibleFloorLocalId: uncoveredFloor,
      removeThroughLocalId, pending: policy().pending, quarantinedEvents: Number(quarantineCounts(context.ownerRef).events),
      reason: removeThroughLocalId < acknowledgedThrough ? 'GAP_ABOVE_PREFIX' : 'NONE',
      consumerSuccess: 'validated receipt covering every event of an acknowledged batch; a scan cursor never advances this value' };
  }
  return Object.freeze({ flush, start, stop, status, setWifiOnly, policy, createManualSelection, retentionView });
}
