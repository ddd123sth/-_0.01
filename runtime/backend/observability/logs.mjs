import { canonical, newId, parseStored, problem } from '../common.mjs';
import { canonicalLogCategory, logCategoryAliases } from './log-categories.mjs';

const CATEGORIES = Object.freeze(['运行状态', '状态核对', '事实恢复', '连接恢复', '配置变更', '种花', '收花', '浇水', '交订单', '广告', '花艺', '日常奖励', '软件账号']);
const EVENT_COLUMNS = Object.freeze({ event_type: 'TEXT', trace_id: 'TEXT', operation_id: 'TEXT', error_code: 'TEXT',
  outcome_state: 'TEXT', attempted: 'INTEGER', run_epoch: 'INTEGER', connection_epoch: 'INTEGER', phase: 'TEXT', method: 'TEXT',
  retry_at_ms: 'INTEGER', schema_version: 'INTEGER NOT NULL DEFAULT 1', truncated: 'INTEGER NOT NULL DEFAULT 0' });
const HEALTH_TIMING_KEYS = new Set(['readiness','progressSnapshots','cleanupAndStableBudgets','globalRecoveryGate','localProcessAndDb','total',
  'controlPlaneHandlerMs','controlPlaneEventLoopLagP99Ms','controlPlaneEventLoopLagMaxMs']);
const HEALTH_DIAGNOSTIC_BOOLEAN_KEYS = new Set(['controlPlaneEventLoopLagAvailable']);
const NATIVE_HEALTH_REQUEST_KEYS = new Set(['healthRequestStartedAtMs','healthRequestFinishedAtMs','healthRequestDurationMs',
  'healthRequestStartedElapsedMs','lastSuccessfulHealthDiagnosticsAtMs']);
const DETAIL_KEYS = new Set(['operationId','traceId','eventType','errorCode','outcomeState','attempted','runEpoch','connectionEpoch','phase','method',
  'retryAtMs','schemaVersion','truncated','visibility','verdict','domains','requestSequence','wireKey','gateDiagnostics','reason','indexedResourceCount',
  'noGameRequestSent','scanned','blocked','blockedCount','hasMore','originalOutcomesUnchanged','originalFootprintsUnchanged',
  'source','state','action','cause','reasonCode','retryable','userActionRequired','loginKind','loginCode','remoteCode','sourceNamespace',
   'nativeRecoveryEventId','nativeRecoveryCause','nativeEventTimeMs','oldGeneration','attempt','httpStatus','reasons','transportCode',
   'healthRequestStartedAtMs','healthRequestFinishedAtMs','healthRequestDurationMs','healthRequestStartedElapsedMs','healthLaneBusy','healthLaneHealthy',
   'lastSuccessfulHealthDiagnosticsAtMs','lastSuccessfulHealthDiagnostics',...HEALTH_TIMING_KEYS,...HEALTH_DIAGNOSTIC_BOOLEAN_KEYS,
  'loginCodeKey','serverMsgCode','code','ok','summary',
  'status','transportFailure','retryAfterMs','retryable','loginCode','closureProven','readFailureKind',
  'responseRef','version','contractVersion','versionEvidence','eventState','gates','failedGateNames','name','path','sourcePath','expectedType','actualType','expected','passed',
  'domainId','difference','changedPaths','removedPaths','addedPaths','storedFingerprint','currentFingerprint','rawAnchorMatches',
  'missing','missingAfter',
  'priorProjectionReceiptAvailable','proofAdvanced',
  'gameVersionPresent','gameVersionEqual','protocolVersionPresent','protocolVersionEqual','loginResponseRefPresent','loginResponseRefEqual','outcomeState']);
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,240}$/.test(value) ? value : null;
const safeErrorCode = value => value === null || value === undefined ? null
  : typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(value) ? value
    : 'LOG_ERROR_CODE_INVALID';
const safeText = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512) : null;
export function safeRecoveryPhase(value) {
  const known = { '官服账号认证': 'v5-account-auth', '渠道会话兑换': 'sdk-session-exchange' };
  if (Object.hasOwn(known, value)) return known[value];
  return typeof value === 'string' && value.length <= 64 && /^[A-Za-z0-9_.:-]+$/.test(value) ? value : null;
}
function safeDetail(value, depth = 0) {
  if (depth > 4) return null;
  if (value === null || ['string','boolean'].includes(typeof value)) return typeof value === 'string' ? safeText(value) : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.slice(0, 64).map(one => safeDetail(one, depth + 1));
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const [key, item] of Object.entries(value)) if (DETAIL_KEYS.has(key) && !/(?:token|password|secret|credential|cookie|openid|payload|body|stack)/i.test(key)) {
    if (HEALTH_TIMING_KEYS.has(key)) { if (typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 120000) result[key] = item; continue; }
    if (HEALTH_DIAGNOSTIC_BOOLEAN_KEYS.has(key)) { if (typeof item === 'boolean') result[key] = item; continue; }
    if (NATIVE_HEALTH_REQUEST_KEYS.has(key)) { if (Number.isSafeInteger(item) && item >= 0) result[key] = item; continue; }
    if (key === 'healthLaneBusy' || key === 'healthLaneHealthy') { if (typeof item === 'boolean') result[key] = item; continue; }
    if (key === 'cause') { const cause = safeCause(item); if (cause !== null) result.cause = cause; continue; }
    if (key === 'eventState') { if (['requested','not-started','completed','incomplete','failed'].includes(item)) result[key] = item; continue; }
    if (['eventType','phase','method','sourceNamespace','loginKind','loginCodeKey','reasonCode','action','remoteCode','transportCode','serverMsgCode','code'].includes(key)) {
      const stringOk = typeof item === 'string' && item.length <= (['reasonCode','remoteCode','transportCode','serverMsgCode','code'].includes(key) ? 128 : 64)
        && /^\$?[A-Za-z0-9_.:-]+$/.test(item);
      if (stringOk || ['remoteCode','transportCode','serverMsgCode','code'].includes(key) && Number.isSafeInteger(item)) result[key] = item;
      continue;
    }
    if (['runEpoch','connectionEpoch','requestSequence','httpStatus','retryAtMs','schemaVersion'].includes(key)) {
      const ok = Number.isSafeInteger(item) && (key === 'httpStatus' ? item >= 100 && item <= 599 : key === 'schemaVersion' ? item > 0 : item >= 0);
      if (ok) result[key] = item;
      continue;
    }
    if (key === 'truncated' || key === 'ok' || key === 'attempted') { if (typeof item === 'boolean') result[key] = item; continue; }
    if (['transportFailure','retryable','userActionRequired','closureProven'].includes(key)) { if (typeof item === 'boolean') result[key] = item; continue; }
    if (key === 'status') { if (['cleanup_pending','waiting_network','scheduled','blocked','connected','stopped','suspended'].includes(item)) result[key] = item; continue; }
    if (key === 'loginCode') {
      if (Number.isSafeInteger(item) || typeof item === 'string' && item.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(item)) result[key] = item;
      continue;
    }
    if (key === 'domainId' || key === 'difference') {
      if (key === 'domainId' && typeof item === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(item)) result[key] = item;
      else if (key === 'difference' && typeof item === 'string' && /^[a-z0-9-]{1,64}$/.test(item)) result[key] = item;
      continue;
    }
    if (key === 'changedPaths') {
      if (Array.isArray(item)) result[key] = item.slice(0, 64).map(one => ({
        ...(typeof one?.path === 'string' && /^[A-Za-z0-9._*-]{1,192}$/.test(one.path) ? { path: one.path } : {}),
        ...(typeof one?.storedFingerprint === 'string' && /^[a-f0-9]{64}$/.test(one.storedFingerprint) ? { storedFingerprint: one.storedFingerprint } : {}),
        ...(typeof one?.currentFingerprint === 'string' && /^[a-f0-9]{64}$/.test(one.currentFingerprint) ? { currentFingerprint: one.currentFingerprint } : {}),
      }));
      continue;
    }
    if (key === 'removedPaths' || key === 'addedPaths') {
      if (Array.isArray(item)) result[key] = item.filter(one => typeof one === 'string' && /^[A-Za-z0-9._*-]{1,192}$/.test(one)).slice(0, 64);
      continue;
    }
    if (key === 'storedFingerprint' || key === 'currentFingerprint') {
      if (typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)) result[key] = item;
      continue;
    }
    if (key === 'rawAnchorMatches' || key === 'priorProjectionReceiptAvailable' || key === 'proofAdvanced') {
      if (typeof item === 'boolean') result[key] = item;
      continue;
    }
    if (['attempt','retryAfterMs'].includes(key)) { if (Number.isSafeInteger(item) && item >= 0) result[key] = item; continue; }
    if (key === 'domains' || key === 'reasons') {
      if (Array.isArray(item)) result[key] = item.filter(entry => typeof entry === 'string' && entry.length <= 64 && /^[A-Za-z0-9_.:-]+$/.test(entry)).slice(0, 16);
      continue;
    }
    if (key === 'summary') { if (typeof item === 'string') result[key] = safeText(item); continue; }
    if (key === 'readFailureKind') { if (typeof item === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(item)) result[key] = item; continue; }
    result[key] = safeDetail(item, depth + 1);
  }
  return result;
}
function detailWasTruncated(value, depth = 0) {
  if (typeof value === 'string') return value.length > 512;
  if (depth > 4) return value !== null && value !== undefined;
  if (Array.isArray(value)) return value.length > 64 || value.slice(0, 64).some(one => detailWasTruncated(one, depth + 1));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, one]) => {
    if (key === 'cause') return safeCause(one) === null;
    if (!DETAIL_KEYS.has(key) || /(?:token|password|secret|credential|cookie|openid|payload|body|stack)/i.test(key)) return true;
    if (HEALTH_TIMING_KEYS.has(key)) return typeof one !== 'number' || !Number.isFinite(one) || one < 0 || one > 120000;
    if (HEALTH_DIAGNOSTIC_BOOLEAN_KEYS.has(key)) return typeof one !== 'boolean';
    if (NATIVE_HEALTH_REQUEST_KEYS.has(key)) return !Number.isSafeInteger(one) || one < 0;
    if (key === 'healthLaneBusy' || key === 'healthLaneHealthy') return typeof one !== 'boolean';
    if (['domains','reasons'].includes(key)) return !Array.isArray(one) || one.length > 16 || one.some(item => typeof item !== 'string' || item.length > 64 || !/^[A-Za-z0-9_.:-]+$/.test(item));
    if (key === 'eventState') return !['requested','not-started','completed','incomplete','failed'].includes(one);
    if (['eventType','phase','method','sourceNamespace','loginKind','loginCodeKey','reasonCode','action','remoteCode','transportCode','serverMsgCode','code'].includes(key)) {
      const strings = ['reasonCode','remoteCode','transportCode','serverMsgCode','code'].includes(key) ? 128 : 64;
      return !(typeof one === 'string' && one.length <= strings && /^\$?[A-Za-z0-9_.:-]+$/.test(one))
        && !(['remoteCode','transportCode','serverMsgCode','code'].includes(key) && Number.isSafeInteger(one));
    }
    if (['runEpoch','connectionEpoch','requestSequence','retryAtMs','schemaVersion'].includes(key)) return !Number.isSafeInteger(one) || one < (key === 'schemaVersion' ? 1 : 0);
    if (key === 'httpStatus') return !Number.isSafeInteger(one) || one < 100 || one > 599;
    if (['truncated','ok','attempted'].includes(key)) return typeof one !== 'boolean';
    if (['transportFailure','retryable','userActionRequired','closureProven'].includes(key)) return typeof one !== 'boolean';
    if (key === 'status') return !['cleanup_pending','waiting_network','scheduled','blocked','connected','stopped','suspended'].includes(one);
    if (key === 'loginCode') return !(Number.isSafeInteger(one) || typeof one === 'string' && one.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(one));
    if (key === 'readFailureKind') return !(typeof one === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(one));
    if (key === 'domainId') return !(typeof one === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(one));
    if (key === 'difference') {
      return !(typeof one === 'string' && /^[a-z0-9-]{1,64}$/.test(one));
    }
    if (key === 'storedFingerprint' || key === 'currentFingerprint') return !(typeof one === 'string' && /^[a-f0-9]{64}$/.test(one));
    if (['rawAnchorMatches','priorProjectionReceiptAvailable','proofAdvanced'].includes(key)) return typeof one !== 'boolean';
    if (key === 'changedPaths') return !Array.isArray(one) || one.length > 64 || one.some(item => !item || typeof item !== 'object' || Array.isArray(item) ||
      Object.keys(item).some(field => !['path','storedFingerprint','currentFingerprint'].includes(field)) ||
      typeof item.path !== 'string' || !/^[A-Za-z0-9._*-]{1,192}$/.test(item.path) ||
      item.storedFingerprint !== null && !(typeof item.storedFingerprint === 'string' && /^[a-f0-9]{64}$/.test(item.storedFingerprint)) ||
      item.currentFingerprint !== null && !(typeof item.currentFingerprint === 'string' && /^[a-f0-9]{64}$/.test(item.currentFingerprint)));
    if (key === 'removedPaths' || key === 'addedPaths') return !Array.isArray(one) || one.length > 64 || one.some(item => typeof item !== 'string' || !/^[A-Za-z0-9._*-]{1,192}$/.test(item));
    if (['attempt','retryAfterMs'].includes(key)) return !Number.isSafeInteger(one) || one < 0;
    return detailWasTruncated(one, depth + 1);
  });
}
const SAFE_CAUSE_KEYS = new Set(['kind','reasonCode','action','phase','source','state','code','version','retryAtMs']);
const safeCause = value => {
  const safeCodeValue = item => typeof item === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(item) ? item : null;
  if (typeof value === 'string') return safeCodeValue(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!SAFE_CAUSE_KEYS.has(key)) continue;
    if (['version','retryAtMs'].includes(key)) { if (Number.isSafeInteger(item) && item >= 0) result[key] = item; }
    else if (typeof item === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(item)) result[key] = item;
  }
  return Object.keys(result).length ? result : null;
};
const utcInstant = (value, label) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw problem('LOG_TIME_FILTER_INVALID', `${label}时间范围无效`, 400);
  return new Date(parsed).toISOString();
};
const escapeLike = value => String(value).replace(/[\\%_]/g, '\\$&');
function shanghaiDayBounds(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw problem('LOG_DAY_INVALID', '日志日期无效', 400);
  const utcMidnight = Date.parse(day + 'T00:00:00.000Z');
  if (!Number.isFinite(utcMidnight) || new Date(utcMidnight).toISOString().slice(0, 10) !== day) throw problem('LOG_DAY_INVALID', '日志日期无效', 400);
  const start = new Date(utcMidnight - 8 * 60 * 60 * 1000).toISOString();
  const end = new Date(utcMidnight + 16 * 60 * 60 * 1000).toISOString();
  return [start, end];
}
export function createObservationLog({ store }) {
  const { run, get, all, transaction, nowIso } = store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_local_logs(
    log_id INTEGER PRIMARY KEY AUTOINCREMENT,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,
    event_ref TEXT NOT NULL UNIQUE,category TEXT NOT NULL,level TEXT NOT NULL,message TEXT NOT NULL,
    detail_json TEXT NOT NULL,occurred_at TEXT NOT NULL,
    event_type TEXT,trace_id TEXT,operation_id TEXT,error_code TEXT,outcome_state TEXT,attempted INTEGER,
    run_epoch INTEGER,connection_epoch INTEGER,phase TEXT,method TEXT,retry_at_ms INTEGER,schema_version INTEGER NOT NULL DEFAULT 1,truncated INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS backend_local_logs_owner ON backend_local_logs(owner_ref,account_ref,log_id);`);
  for (const [column, definition] of Object.entries(EVENT_COLUMNS)) if (!all('PRAGMA table_info(backend_local_logs)').some(item => item.name === column)) {
    run(`ALTER TABLE backend_local_logs ADD COLUMN ${column} ${definition}`);
  }
  function append({ ownerRef, accountRef = '0', category = '运行状态', level = 'info', message, detail = {}, eventRef = newId(),
    eventType = null, traceId = null, operationId = null, errorCode = null, outcomeState = null, attempted = null,
    runEpoch = null, connectionEpoch = null, phase = null, method = null, retryAtMs = null, schemaVersion = 1, truncated = false }) {
    category = canonicalLogCategory(category);
    if (!ownerRef || typeof message !== 'string' || message.length > 1600 || !CATEGORIES.includes(category)) throw problem('LOG_EVENT_INVALID', '运行记录缺少归属或有效内容', 500);
    if (!['info', 'warn', 'error'].includes(level)) throw problem('LOG_LEVEL_INVALID', '日志等级无效', 500);
    const clean = safeDetail(detail) || {}, pick = (explicit, key) => explicit ?? clean?.[key] ?? null;
    const rawErrorCode = pick(errorCode, 'errorCode') ?? pick(null, 'reason');
    const invalidErrorCode = rawErrorCode !== null && rawErrorCode !== undefined
      && !(typeof rawErrorCode === 'string' && rawErrorCode.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(rawErrorCode));
    const sourceErrorCode = safeErrorCode(rawErrorCode);
    if (invalidErrorCode) {
      clean.errorCode = 'LOG_ERROR_CODE_INVALID';
      if (Object.prototype.hasOwnProperty.call(clean, 'reason')) clean.reason = 'LOG_ERROR_CODE_INVALID';
      clean.truncated = true;
    }
    const persistedOutcome = pick(outcomeState, 'outcomeState') ?? (['confirmed','rejected','unknown','failed','dirty','scheduled','waiting'].includes(clean?.verdict) ? clean.verdict : null);
    return transaction(() => run(`INSERT INTO backend_local_logs(owner_ref,account_ref,event_ref,category,level,message,detail_json,occurred_at,
      event_type,trace_id,operation_id,error_code,outcome_state,attempted,run_epoch,connection_epoch,phase,method,retry_at_ms,schema_version,truncated)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ownerRef, String(accountRef), eventRef, category, level, message.slice(0,1600), canonical(clean), nowIso(),
      safeId(pick(eventType,'eventType')), safeId(pick(traceId,'traceId')), safeId(pick(operationId,'operationId')), sourceErrorCode,
      safeId(persistedOutcome), typeof pick(attempted,'attempted') === 'boolean' ? Number(pick(attempted,'attempted')) : null,
      Number.isSafeInteger(pick(runEpoch,'runEpoch')) ? pick(runEpoch,'runEpoch') : null,
      Number.isSafeInteger(pick(connectionEpoch,'connectionEpoch')) ? pick(connectionEpoch,'connectionEpoch') : null,
      safeId(pick(phase,'phase')), safeId(pick(method,'method')), Number.isSafeInteger(pick(retryAtMs,'retryAtMs')) ? pick(retryAtMs,'retryAtMs') : null,
      Number.isSafeInteger(schemaVersion) && schemaVersion > 0 ? schemaVersion : 1, truncated || detailWasTruncated(detail) || clean?.truncated === true ? 1 : 0));
  }
  function page({ ownerRef, accountRef = '0', beforeLocalId = null, beforeLocalAt = null, throughLocalId = null, limit = 15, category = null, day = null, from = null, to = null,
    keyword = null, level = null, outcomeState = null, errorCode = null, operationId = null, traceId = null }) {
    const size = Number(limit);
    if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw problem('LOG_PAGE_INVALID', '日志页大小无效', 400);
    const clauses = ['owner_ref=?', 'account_ref=?'], parameters = [ownerRef, String(accountRef)];
    if (throughLocalId !== null && throughLocalId !== '') {
      const through = Number(throughLocalId);
      if (!Number.isSafeInteger(through) || through < 0) throw problem('LOG_CURSOR_INVALID', '日志高水位无效', 400);
      clauses.push('log_id<=?'); parameters.push(through);
    }
    if (beforeLocalId !== null && beforeLocalId !== '') {
      const before = Number(beforeLocalId);
      if (!Number.isSafeInteger(before) || before < 1) throw problem('LOG_CURSOR_INVALID', '日志游标无效', 400);
      if (beforeLocalAt !== null && beforeLocalAt !== '') {
        const normalized = utcInstant(beforeLocalAt, '分页游标');
        const anchor = get('SELECT occurred_at FROM backend_local_logs WHERE owner_ref=? AND account_ref=? AND log_id=?', ownerRef, String(accountRef), before);
        if (!anchor || anchor.occurred_at !== normalized) throw problem('LOG_CURSOR_INVALID', '日志时间游标与记录不匹配', 400);
        clauses.push('(occurred_at<? OR (occurred_at=? AND log_id<?))'); parameters.push(normalized, normalized, before);
      } else { clauses.push('log_id<?'); parameters.push(before); }
    }
    if (category) {
      const aliases = logCategoryAliases(category);
      clauses.push(`category IN (${aliases.map(() => '?').join(',')})`); parameters.push(...aliases);
    }
    if (day) {
      const [dayStart, dayEnd] = shanghaiDayBounds(day);
      clauses.push('occurred_at>=? AND occurred_at<?'); parameters.push(dayStart, dayEnd);
    }
    const since = utcInstant(from, '起始'), until = utcInstant(to, '结束');
    if (since) { clauses.push('occurred_at>=?'); parameters.push(since); }
    if (until) { clauses.push('occurred_at<?'); parameters.push(until); }
    if (since && until && since >= until) throw problem('LOG_TIME_FILTER_INVALID', '日志起始时间必须早于结束时间', 400);
    if (keyword !== null && keyword !== '') {
      if (typeof keyword !== 'string' || keyword.length > 160) throw problem('LOG_KEYWORD_INVALID', '日志关键词过长或格式无效', 400);
      const like = '%' + escapeLike(keyword) + '%';
      clauses.push("(message LIKE ? ESCAPE '\\' OR detail_json LIKE ? ESCAPE '\\' OR event_type LIKE ? ESCAPE '\\' OR error_code LIKE ? ESCAPE '\\' OR phase LIKE ? ESCAPE '\\' OR method LIKE ? ESCAPE '\\' OR operation_id LIKE ? ESCAPE '\\' OR trace_id LIKE ? ESCAPE '\\')");
      parameters.push(...Array(8).fill(like));
    }
    for (const [value, column, name] of [[level,'level','日志等级'],[outcomeState,'outcome_state','结果'],[errorCode,'error_code','错误码'],
      [operationId,'operation_id','操作ID'],[traceId,'trace_id','追踪ID']]) if (value !== null && value !== '') {
      if (typeof value !== 'string' || value.length > 240) throw problem('LOG_FILTER_INVALID', `${name}筛选格式无效`, 400);
      clauses.push(`${column}=?`); parameters.push(value);
    }
    const rows = all('SELECT * FROM backend_local_logs WHERE ' + clauses.join(' AND ') + ' ORDER BY occurred_at DESC,log_id DESC LIMIT ?', ...parameters, size + 1);
    const selected = rows.slice(0, size);
    return { logs: selected.map(row => ({ id: row.log_id, at: row.occurred_at, ts: row.occurred_at, level: row.level,
      message: row.message, category: canonicalLogCategory(row.category), origin: 'backend_local_logs', detail: parseStored(row.detail_json, '日志附加信息'),
      eventType: row.event_type, traceId: row.trace_id, operationId: row.operation_id, errorCode: row.error_code,
      outcomeState: row.outcome_state, attempted: row.attempted === null ? null : row.attempted === 1, runEpoch: row.run_epoch,
      connectionEpoch: row.connection_epoch, phase: row.phase, method: row.method, retryAtMs: row.retry_at_ms,
      schemaVersion: row.schema_version, truncated: row.truncated === 1 })),
      page: { limit: size, hasMore: rows.length > size, older: { localId: selected.at(-1)?.log_id ?? null,
        localAt: selected.at(-1)?.occurred_at ?? null, businessId: null } },
      days: all("SELECT DISTINCT strftime('%Y-%m-%d',occurred_at,'+08:00') AS day FROM backend_local_logs WHERE owner_ref=? AND account_ref=? ORDER BY day DESC LIMIT 90", ownerRef, String(accountRef)).map(row => row.day),
      categories: [...CATEGORIES], timeZone: 'Asia/Shanghai', utcOffset: '+08:00' };
  }
  function selectIds({ ownerRef, accountRef = '0', ...filters } = {}) {
    const high = get('SELECT COALESCE(MAX(log_id),0) AS high FROM backend_local_logs WHERE owner_ref=? AND account_ref=?', ownerRef, String(accountRef));
    const highWaterLogId = Number(high.high || 0), selected = [];
    let beforeLocalId = null, beforeLocalAt = null;
    for (;;) {
      const result = page({ ownerRef, accountRef, ...filters, limit: 100, throughLocalId: highWaterLogId, beforeLocalId, beforeLocalAt });
      selected.push(...result.logs.map(one => one.id));
      if (selected.length > 10000) throw problem('LOG_MANUAL_SELECTION_TOO_LARGE', '当前筛选结果超过单次手动上传上限，请缩小筛选范围', 413);
      if (!result.page.hasMore) break;
      beforeLocalId = result.page.older.localId; beforeLocalAt = result.page.older.localAt;
      if (!Number.isSafeInteger(beforeLocalId) || beforeLocalId < 1) throw problem('LOG_MANUAL_SELECTION_PAGING_INVALID', '筛选结果分页未能稳定继续', 500);
    }
    return { highWaterLogId, sourceLogIds: [...selected].sort((a, b) => a - b) };
  }
  return Object.freeze({ append, page, selectIds });
}
