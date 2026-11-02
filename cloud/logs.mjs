// Batch log ingestion: whitelist, second-pass redaction, dedup and conflict rules.
import crypto from 'node:crypto';
import { fail, isPlainObject, validEventId, validInstallId, validIso, boundedString, integerAtLeast } from './common.mjs';
import { redactText, redactDiagnostic } from './redact.mjs';

// diagnostic is accepted alongside the contract keys because the server stores a
// redacted diagnostic_json column and the client is the only source for it.
const ALLOWED_KEYS = new Set([
  'eventId', 'seq', 'installId', 'accountLabel', 'occurredAt', 'level', 'category', 'message',
  'appVersion', 'traceId', 'operationId', 'errorCode', 'outcome', 'outcomeState', 'attempted', 'diagnostic',
]);
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
  return out;
}

function normalizeAccountLabel(label) {
  if (label === undefined || label === null) return null;
  if (!isPlainObject(label)) return 'invalid';
  const out = {};
  for (const key of ['stableId', 'nickname', 'serverName']) {
    const value = label[key];
    if (value === undefined || value === null) continue;
    if (!boundedString(value, 64)) return 'invalid';
    out[key] = value;
  }
  for (const key of Object.keys(label)) if (!['stableId', 'nickname', 'serverName'].includes(key)) return 'invalid';
  return out;
}
function normalizeOutcome(outcome) {
  if (outcome === undefined || outcome === null) return null;
  if (!isPlainObject(outcome)) return 'invalid';
  const out = {};
  for (const key of ['sent', 'confirmed', 'unconfirmed']) {
    const value = outcome[key];
    if (value === undefined || value === null) continue;
    if (!integerAtLeast(value, 0)) return 'invalid';
    out[key] = value;
  }
  for (const key of Object.keys(outcome)) if (!['sent', 'confirmed', 'unconfirmed'].includes(key)) return 'invalid';
  return out;
}

function validateEvent(event) {
  if (!isPlainObject(event)) return { reason: 'EVENT_INVALID', eventId: '' };
  const eventId = event.eventId;
  if (typeof eventId !== 'string' || eventId.length > 64) {
    return { reason: 'EVENT_INVALID', eventId: typeof eventId === 'string' ? eventId : '' };
  }
  for (const key of Object.keys(event)) {
    if (!ALLOWED_KEYS.has(key)) return { fieldNotAllowed: true, eventId };
  }
  const problems = [];
  if (!validEventId(eventId)) problems.push('eventId');
  if (!validInstallId(event.installId)) problems.push('installId');
  if (!validIso(event.occurredAt)) problems.push('occurredAt');
  if (!LEVELS.has(event.level)) problems.push('level');
  if (!boundedString(event.category, 48) || !event.category.length) problems.push('category');
  if (typeof event.message !== 'string') problems.push('message');
  if (event.seq !== undefined && !integerAtLeast(event.seq, 0)) problems.push('seq');
  for (const [key, max] of [['appVersion', 32], ['traceId', 64], ['operationId', 64], ['errorCode', 128], ['outcomeState', 32]]) {
    if (event[key] !== undefined && !boundedString(event[key], max)) problems.push(key);
  }
  if (event.attempted !== undefined && typeof event.attempted !== 'boolean') problems.push('attempted');
  if (event.diagnostic !== undefined && !isPlainObject(event.diagnostic)) problems.push('diagnostic');
  const accountLabel = normalizeAccountLabel(event.accountLabel);
  if (accountLabel === 'invalid') problems.push('accountLabel');
  const outcome = normalizeOutcome(event.outcome);
  if (outcome === 'invalid') problems.push('outcome');
  if (problems.length) return { reason: 'EVENT_INVALID', eventId };

  const message = redactText(event.message);
  const label = accountLabel || {};
  const diagnostic = redactDiagnostic(event.diagnostic);
  const content = {
    seq: event.seq ?? null,
    installId: event.installId,
    occurredAt: event.occurredAt,
    level: event.level,
    category: event.category,
    message,
    stableId: label.stableId ?? null,
    nickname: label.nickname ?? null,
    serverName: label.serverName ?? null,
    appVersion: event.appVersion ?? null,
    traceId: event.traceId ?? null,
    operationId: event.operationId ?? null,
    errorCode: event.errorCode ?? null,
    outcome: outcome ?? null,
    outcomeState: event.outcomeState ?? null,
    attempted: event.attempted ?? null,
    diagnostic,
  };
  const contentSha256 = crypto.createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex');
  // 重要性不能只认 error：未确认与失败的写入必须按重要保留，否则清理会先把「还欠核对的那几笔」删掉，
  // 而客户与运维要查的恰恰就是这些。attempted 一并落列，让它变成可查询事实而不是只进内容指纹。
  const isError = event.level === 'error' || (typeof event.errorCode === 'string' && event.errorCode.length > 0) ? 1 : 0;
  const outcomeState = event.outcomeState ?? null;
  const attempted = typeof event.attempted === 'boolean' ? (event.attempted ? 1 : 0) : null;
  const important = isError === 1 || outcomeState === 'unconfirmed' || outcomeState === 'failed' || Number(outcome?.unconfirmed) > 0;
  return {
    eventId, installId: event.installId, contentSha256, isError, bodyClass: important ? 'important' : 'normal',
    row: {
      message,
      occurredAt: event.occurredAt,
      level: event.level,
      category: event.category,
      stableId: label.stableId ?? null,
      nickname: label.nickname ?? null,
      serverName: label.serverName ?? null,
      appVersion: event.appVersion ?? null,
      traceId: event.traceId ?? null,
      operationId: event.operationId ?? null,
      errorCode: event.errorCode ?? null,
      outcome: outcome ? JSON.stringify(outcome) : null,
      outcomeState,
      attempted,
      diagnostic,
    },
  };
}

// 日志通道的准入预算。窗口按分钟对齐，超了就在响应里带回真实剩余秒数，
// 让客户端按 Retry-After 退避而不是自己猜；这些数字是护栏，不代表实测容量。
function budgetAdmission(store, config, { userId, installId, ip, events, bytes }) {
  const { run, get } = store;
  const budget = config.logBudget;
  const windowStart = Math.floor(Date.now() / 60_000) * 60_000;
  const scopes = [
    ['install', installId, { requests: budget.installRequestsPerMinute, events: budget.installEventsPerMinute, bytes: budget.installBytesPerMinute }],
    ['user', String(userId), { requests: budget.userRequestsPerMinute, events: 0, bytes: 0 }],
    ['ip', String(ip || ''), { requests: budget.ipRequestsPerMinute, events: 0, bytes: 0 }],
  ];
  for (const [scope, key, limits] of scopes) {
    if (!key) continue;
    const row = get('SELECT requests,events,bytes FROM log_budget WHERE scope=? AND key=? AND window_start=?', scope, key, windowStart);
    const used = { requests: Number(row?.requests) || 0, events: Number(row?.events) || 0, bytes: Number(row?.bytes) || 0 };
    if (used.requests + 1 > limits.requests || (limits.events && used.events + events > limits.events) || (limits.bytes && used.bytes + bytes > limits.bytes)) {
      const retryAfter = Math.max(1, Math.ceil((windowStart + 60_000 - Date.now()) / 1000));
      return { retryAfter, scope };
    }
    run(`INSERT INTO log_budget(scope,key,window_start,requests,events,bytes) VALUES(?,?,?,?,?,?)
      ON CONFLICT(scope,key,window_start) DO UPDATE SET requests=requests+1,events=events+excluded.events,bytes=bytes+excluded.bytes`,
      scope, key, windowStart, 1, events, bytes);
  }
  return { ok: true };
}

export function createLogRoutes(deps) {
  const { store, config, sessions } = deps;
  const { run, get, transaction, nowIso } = store;

  function batch(ctx) {
    const resolved = sessions.resolveSession(ctx.bearer, 'user');
    if (resolved.fail) return resolved.fail;
    const user = get('SELECT * FROM software_users WHERE id=?', resolved.session.user_id);
    if (!user) return fail(401, '会话已失效，请重新登录', 'SESSION_REVOKED');
    if (!user.enabled) return fail(403, '软件账号已被停用', 'SOFTWARE_DISABLED');
    const input = ctx.body;
    if (!isPlainObject(input) || !Array.isArray(input.events)) return fail(400, '日志批量格式不正确', 'INPUT_INVALID');
    if (Object.keys(input).some(key => key !== 'events')) return fail(400, '日志批量格式不正确', 'INPUT_INVALID');
    if (input.events.length > config.logBatchMaxEvents) return fail(400, '日志批量超出上限', 'LOG_BATCH_TOO_LARGE');

    for (const event of input.events) {
      if (isPlainObject(event)) {
        for (const key of Object.keys(event)) {
          if (!ALLOWED_KEYS.has(key)) return fail(400, '日志包含不允许的字段', 'LOG_FIELD_NOT_ALLOWED');
        }
      }
    }

    const sessionInstallId = resolved.session.install_id;
    const receivedAt = nowIso();
    const accepted = [];
    const duplicates = [];
    const rejected = [];

    const bytes = Buffer.byteLength(JSON.stringify(input));
    const admission = budgetAdmission(store, config, { userId: user.id, installId: sessionInstallId, ip: ctx.ip, events: input.events.length, bytes });
    if (admission.retryAfter) {
      // 必须带真实剩余秒数：客户端拿到 429 但没有 Retry-After 就只能自己猜，会把预算越踩越乱。
      return {
        status: 429,
        body: { error: '日志上传超过本机这一分钟的预算，请按 Retry-After 稍后再发', code: 'LOG_BUDGET_EXCEEDED', scope: admission.scope },
        headers: { 'Retry-After': String(admission.retryAfter) },
      };
    }

    const windowCutoff = new Date(Date.parse(receivedAt) - config.receiptWindowDays * 86_400_000).toISOString();
    transaction(() => {
      for (const event of input.events) {
        const validated = validateEvent(event);
        if (!validated.contentSha256) { rejected.push({ eventId: validated.eventId || '', reason: validated.reason || 'EVENT_INVALID' }); continue; }
        if (validated.installId !== sessionInstallId) { rejected.push({ eventId: validated.eventId, reason: 'INSTALL_MISMATCH' }); continue; }

        // 判重先读取据、再读正文行：正文按保留期清理甚至整行删掉之后，「这条我们已经收过」这个事实
        // 仍然成立。不能因为正文没了就把同一条重传成新记录，也不能让它换内容。
        const receipt = get('SELECT content_sha256,first_received_at FROM log_receipts WHERE user_id=? AND install_id=? AND event_id=?',
          user.id, sessionInstallId, validated.eventId);
        const existing = get('SELECT content_sha256,received_at FROM run_logs WHERE user_id=? AND install_id=? AND event_id=?',
          user.id, sessionInstallId, validated.eventId);
        const seen = receipt || existing;
        if (!receipt && existing) {
          run(`INSERT INTO log_receipts(user_id,install_id,event_id,content_sha256,occurred_at,first_received_at,body_class)
            VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,install_id,event_id) DO NOTHING`,
            user.id, sessionInstallId, validated.eventId, existing.content_sha256, validated.row.occurredAt, existing.received_at,
            existing.is_error ? 'important' : 'normal');
        }
        if (seen) {
          const known = (receipt || existing).content_sha256;
          if (known === validated.contentSha256) { duplicates.push(validated.eventId); continue; }
          const now = nowIso();
          const conflict = get('SELECT id FROM log_conflicts WHERE user_id=? AND install_id=? AND event_id=?',
            user.id, sessionInstallId, validated.eventId);
          if (conflict) run('UPDATE log_conflicts SET last_seen_at=?,detail=? WHERE id=?', now, 'content_mismatch', conflict.id);
          else run('INSERT INTO log_conflicts(user_id,install_id,event_id,first_seen_at,last_seen_at,detail) VALUES(?,?,?,?,?,?)',
            user.id, sessionInstallId, validated.eventId, now, now, 'content_mismatch');
          rejected.push({ eventId: validated.eventId, reason: 'EVENT_CONFLICT' });
          continue;
        }
        // 窗口外的旧事件明确拒收：不能靠补一个当前接收时刻把它塞进来，也不能伪造首次接收。
        if (validated.row.occurredAt < windowCutoff) { rejected.push({ eventId: validated.eventId, reason: 'EVENT_OUTSIDE_WINDOW' }); continue; }

        const r = validated.row;
        run(`INSERT INTO log_receipts(user_id,install_id,event_id,content_sha256,occurred_at,first_received_at,body_class)
          VALUES(?,?,?,?,?,?,?)`, user.id, sessionInstallId, validated.eventId, validated.contentSha256, r.occurredAt, receivedAt, validated.bodyClass);
        run(`INSERT INTO run_logs(event_id,user_id,install_id,stable_id,nickname,server_name,occurred_at,received_at,
          level,category,message,app_version,trace_id,operation_id,error_code,outcome_json,outcome_state,attempted,
          diagnostic_json,content_sha256,is_error,body_class)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        validated.eventId, user.id, sessionInstallId, r.stableId, r.nickname, r.serverName, r.occurredAt, receivedAt,
        r.level, r.category, r.message, r.appVersion, r.traceId, r.operationId, r.errorCode, r.outcome, r.outcomeState,
        r.attempted, r.diagnostic, validated.contentSha256, validated.isError, validated.bodyClass);
        accepted.push(validated.eventId);
      }
    });

    return { status: 200, body: { accepted, duplicates, rejected, receivedAt } };
  }

  return [{ method: 'POST', path: '/api/logs/batch', handler: batch, maxBody: config.logBatchBodyBytes }];
}
