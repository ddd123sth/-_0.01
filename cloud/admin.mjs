// Admin routes. Every handler here requires an admin session; a user token is rejected.
import { ok, fail, isPlainObject, validAdminPassword, boundedString, integerAtLeast } from './common.mjs';
import { getSettings, setAllowRegistration, setRetention } from './settings.mjs';

function adminPublic(row) { return { id: Number(row.id), username: row.username }; }
function toBool(value) { return Boolean(value); }

function parsePage(query) {
  let page = Number(query.get('page') || '1');
  let pageSize = Number(query.get('pageSize') || '20');
  if (!Number.isInteger(page) || page < 1) page = 1;
  if (!Number.isInteger(pageSize) || pageSize < 1) pageSize = 20;
  if (pageSize > 100) pageSize = 100;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function mapLogRow(row) {
  let outcome = null;
  let diagnostic = null;
  try { outcome = row.outcome_json ? JSON.parse(row.outcome_json) : null; } catch { outcome = null; }
  try { diagnostic = row.diagnostic_json ? JSON.parse(row.diagnostic_json) : null; } catch { diagnostic = null; }
  return {
    id: Number(row.id), eventId: row.event_id, userId: Number(row.user_id), installId: row.install_id,
    stableId: row.stable_id, nickname: row.nickname, serverName: row.server_name,
    occurredAt: row.occurred_at, receivedAt: row.received_at, level: row.level, category: row.category,
    message: row.message, appVersion: row.app_version, errorCode: row.error_code, traceId: row.trace_id,
    operationId: row.operation_id, outcome, outcomeState: row.outcome_state,
    attempted: row.attempted === null || row.attempted === undefined ? null : toBool(row.attempted),
    diagnostic, isError: toBool(row.is_error),
  };
}

export function createAdminRoutes(deps) {
  const { store, config, hasher, sessions, limiter } = deps;
  const { run, get, all, nowIso } = store;

  function audit(adminUsername, action, target, detail) {
    run('INSERT INTO admin_audit(admin_username,action,target,detail,at) VALUES(?,?,?,?,?)', adminUsername, action, target, detail, nowIso());
  }
  function requireAdmin(ctx) {
    const resolved = sessions.resolveSession(ctx.bearer, 'admin');
    if (resolved.fail) return resolved;
    const admin = get('SELECT * FROM admins WHERE id=?', resolved.session.admin_id);
    if (!admin) return { fail: fail(401, '管理员会话已失效', 'SESSION_REVOKED') };
    if (!admin.enabled) {
      sessions.revokeAllForAdmin('disabled');
      return { fail: fail(403, '管理员已被停用', 'ADMIN_DISABLED') };
    }
    return { admin, session: resolved.session };
  }

  async function login(ctx) {
    const input = ctx.body;
    if (!isPlainObject(input)) return fail(400, '登录信息格式不正确', 'INPUT_INVALID');
    const { username, password } = input;
    const scope = 'admin-login';
    const key = String(username || '').toLowerCase();
    if (limiter.isLocked(scope, key)) return fail(429, '登录尝试过多，请稍后再试', 'LOGIN_THROTTLED');
    const admin = typeof username === 'string' ? get('SELECT * FROM admins WHERE username=?', username) : undefined;
    const okPassword = admin ? await hasher.verify(String(password || ''), admin.password_hash) : false;
    if (!admin || !okPassword) {
      limiter.recordFailure(scope, key);
      return fail(401, '管理员用户名或密码不正确', 'ADMIN_LOGIN_FAILED');
    }
    if (!admin.enabled) return fail(403, '管理员已被停用', 'ADMIN_DISABLED');
    limiter.recordSuccess(scope, key);
    const issued = sessions.issue({ kind: 'admin', adminId: admin.id });
    run('UPDATE admins SET last_login_at=? WHERE id=?', nowIso(), admin.id);
    audit(admin.username, 'login', `admin:${admin.id}`, '');
    return ok({
      accessToken: issued.accessToken, accessExpiresAt: issued.accessExpiresAt,
      refreshToken: issued.refreshToken, refreshExpiresAt: issued.refreshExpiresAt,
      admin: adminPublic(admin),
    });
  }

  function refresh(ctx) {
    const input = ctx.body;
    if (!isPlainObject(input)) return fail(400, '续期信息格式不正确', 'INPUT_INVALID');
    let result;
    store.transaction(() => {
      result = sessions.rotateByRefresh(input.refreshToken, undefined, session => {
        const admin = get('SELECT * FROM admins WHERE id=?', session.admin_id);
        if (!admin) return fail(401, '管理员会话已失效', 'SESSION_REVOKED');
        if (!admin.enabled) { sessions.revokeAllForAdmin('disabled'); return fail(403, '管理员已被停用', 'ADMIN_DISABLED'); }
        return null;
      });
    });
    if (result.fail) return result.fail;
    const issued = result.rotated;
    const admin = get('SELECT * FROM admins WHERE id=?', adminIdFor(issued.sessionId));
    return ok({
      accessToken: issued.accessToken, accessExpiresAt: issued.accessExpiresAt,
      refreshToken: issued.refreshToken, refreshExpiresAt: issued.refreshExpiresAt,
      admin: adminPublic(admin),
    });
  }
  function adminIdFor(sessionId) {
    const session = get('SELECT admin_id FROM software_sessions WHERE id=?', sessionId);
    return session ? session.admin_id : null;
  }

  function logout(ctx) {
    const guard = requireAdmin(ctx);
    if (guard.fail) return guard.fail;
    const refreshToken = isPlainObject(ctx.body) ? ctx.body.refreshToken : undefined;
    sessions.revokeCurrent(guard.session.id, refreshToken);
    return ok({ ok: true });
  }

  async function password(ctx) {
    const guard = requireAdmin(ctx);
    if (guard.fail) return guard.fail;
    const input = ctx.body;
    if (!isPlainObject(input)) return fail(400, '改密信息格式不正确', 'INPUT_INVALID');
    const current = get('SELECT * FROM admins WHERE id=?', guard.admin.id);
    const currentOk = await hasher.verify(String(input.currentPassword || ''), current.password_hash);
    if (!currentOk) return fail(401, '当前密码不正确', 'ADMIN_LOGIN_FAILED');
    if (!validAdminPassword(input.newPassword)) return fail(400, '新密码不符合要求', 'INPUT_INVALID');
    const hash = await hasher.hash(input.newPassword);
    run('UPDATE admins SET password_hash=? WHERE id=?', hash, current.id);
    sessions.revokeAllForAdmin('password_changed');
    audit(current.username, 'password_change', `admin:${current.id}`, '');
    return ok({ ok: true, revoked: true });
  }

  function users(ctx) {
    const guard = requireAdmin(ctx);
    if (guard.fail) return guard.fail;
    const { page, pageSize, offset } = parsePage(ctx.query);
    const q = ctx.query.get('q');
    const like = q ? `%${q}%` : null;
    const where = like ? 'WHERE username LIKE ? COLLATE NOCASE' : '';
    const params = like ? [like] : [];
    const total = get(`SELECT COUNT(*) AS n FROM software_users ${where}`, ...params).n;
    const rows = all(`SELECT u.*, (SELECT COUNT(*) FROM run_logs l WHERE l.user_id=u.id) AS log_count,
      (SELECT MAX(occurred_at) FROM run_logs l WHERE l.user_id=u.id) AS latest_log_at
      FROM software_users u ${where} ORDER BY u.id DESC LIMIT ? OFFSET ?`, ...params, pageSize, offset);
    return ok({
      items: rows.map(row => ({
        id: Number(row.id), username: row.username, enabled: toBool(row.enabled), createdAt: row.created_at,
        lastLoginAt: row.last_login_at ?? null, remark: row.remark ?? '',
        latestLogAt: row.latest_log_at ?? null, logCount: Number(row.log_count),
      })),
      total: Number(total), page, pageSize,
    });
  }

  async function setEnabled(ctx) {
    const guard = requireAdmin(ctx);
    if (guard.fail) return guard.fail;
    const userId = Number(ctx.params.id);
    const user = get('SELECT * FROM software_users WHERE id=?', userId);
    if (!user) return fail(404, '用户不存在', 'USER_NOT_FOUND');
    const input = ctx.body;
    if (!isPlainObject(input) || typeof input.enabled !== 'boolean') return fail(400, '启用状态格式不正确', 'INPUT_INVALID');
    const reason = boundedString(input.reason ?? '', 200) ? String(input.reason ?? '') : '';
    if (input.enabled) {
      run('UPDATE software_users SET enabled=1,disabled_at=NULL,updated_at=? WHERE id=?', nowIso(), userId);
    } else {
      run('UPDATE software_users SET enabled=0,disabled_at=?,updated_at=? WHERE id=?', nowIso(), nowIso(), userId);
      sessions.revokeAllForUser(userId, 'admin_disabled');
    }
    audit(guard.admin.username, input.enabled ? 'user_enable' : 'user_disable', `user:${userId}`, reason);
    return ok({ ok: true, user: { id: userId, username: user.username, enabled: input.enabled } });
  }

  async function resetPassword(ctx) {
    const guard = requireAdmin(ctx);
    if (guard.fail) return guard.fail;
    const userId = Number(ctx.params.id);
    const user = get('SELECT * FROM software_users WHERE id=?', userId);
    if (!user) return fail(404, '用户不存在', 'USER_NOT_FOUND');
    const input = ctx.body;
    if (!isPlainObject(input) || !validAdminPassword(input.password)) return fail(400, '新密码不符合要求', 'INPUT_INVALID');
    const hash = await hasher.hash(input.password);
    run('UPDATE software_users SET password_hash=?,updated_at=? WHERE id=?', hash, nowIso(), userId);
    sessions.revokeAllForUser(userId, 'admin_reset_password');
    audit(guard.admin.username, 'user_reset_password', `user:${userId}`, '');
    return ok({ ok: true, revoked: true });
  }

  function setRemark(ctx) {
    const guard = requireAdmin(ctx);
    if (guard.fail) return guard.fail;
    const userId = Number(ctx.params.id);
    const user = get('SELECT * FROM software_users WHERE id=?', userId);
    if (!user) return fail(404, '用户不存在', 'USER_NOT_FOUND');
    const input = ctx.body;
    if (!isPlainObject(input) || !boundedString(String(input.remark ?? ''), 200)) return fail(400, '备注长度不正确', 'INPUT_INVALID');
    run('UPDATE software_users SET remark=?,updated_at=? WHERE id=?', String(input.remark ?? ''), nowIso(), userId);
    audit(guard.admin.username, 'user_remark', `user:${userId}`, '');
    return ok({ ok: true, remark: String(input.remark ?? '') });
  }

  function logs(ctx) {
    const guard = requireAdmin(ctx);
    if (guard.fail) return guard.fail;
    const { page, pageSize, offset } = parsePage(ctx.query);
    const clauses = [];
    const params = [];
    const eq = (key, column) => { const value = ctx.query.get(key); if (value !== null && value !== '') { clauses.push(`${column}=?`); params.push(value); } };
    // 游戏号昵称与区服按关键词部分匹配（管理员记不全整串），稳定标识仍要求精确。
    const like = (key, column) => {
      const value = ctx.query.get(key);
      if (value === null || value === '') return;
      clauses.push(`${column} LIKE ? ESCAPE '\\'`);
      params.push(`%${value.replace(/[\\%_]/g, char => '\\' + char)}%`);
    };
    eq('userId', 'user_id'); eq('stableId', 'stable_id'); like('nickname', 'nickname'); like('serverName', 'server_name');
    eq('level', 'level'); eq('errorCode', 'error_code'); eq('traceId', 'trace_id'); eq('operationId', 'operation_id');
    eq('installId', 'install_id'); eq('outcomeState', 'outcome_state');
    const eventState = ctx.query.get('eventState');
    if (eventState !== null && ['requested', 'not-started', 'completed', 'incomplete', 'failed'].includes(eventState)) {
      clauses.push("CASE WHEN json_valid(diagnostic_json) THEN json_extract(diagnostic_json, '$.eventState') ELSE NULL END=?");
      params.push(eventState);
    }
    const attempted = ctx.query.get('attempted');
    if (attempted === 'true' || attempted === 'false') { clauses.push('attempted=?'); params.push(attempted === 'true' ? 1 : 0); }
    // 〔K15·2026-10-21 方案第 1、2 条〕分类与级别／错误码同一形状：**在取数那一步下发**，不是先捞一页再在返回里挑
    //   （先分页后过滤会造出「这一类没有记录」的假话）。
    // 这一列的值来自哪里现读记清：由本机上传时按 `runtime/log-view.mjs` 那一份页签名册定档
    //   （收花／浇水／种花／订单／花艺／日常奖励／连接／启停／设置／状态核对／异常／其他）——
    //   与手机日志屏上那 12 个页签一字不差，所以后台筛「浇水」捞到的就是屏上「浇水」页签里那批行。
    // ⚠️ 库里 10-21 之前落的老行是另一套按关键词粗分的英文 slug（`harvest`／`water`／`login`…共 12 种，
    //   出自我仓已删的 `software-hooks.mjs` 那张表），**不迁移、不改写**（改历史行等于造出没发生过的分类）：
    //   下拉里带「旧分类」字样标出来，选了只筛那一批老行，绝不冒充和现在的页签同一口径。
    //   云端这一列没有结构事件名（库里没有 `event` 列），所以细档（六族各一、土地三族分家）在后台算不出来，
    //   后台只按上传时那一份粗档筛——这一条是真边界，不是漏做（要按细档筛得看 run_logs 的结构业务行，属 K16 第 4 条）。
    const categoryValue = ctx.query.get('category');
    const hasCategory = categoryValue !== null && categoryValue !== '';
    if (hasCategory) { clauses.push('category=?'); params.push(categoryValue); }
    const from = ctx.query.get('from'); const to = ctx.query.get('to');
    if (from) { clauses.push('occurred_at>=?'); params.push(from); }
    if (to) { clauses.push('occurred_at<=?'); params.push(to); }
    const q = ctx.query.get('q');
    if (q) {
      const escaped = q.replace(/[\\%_]/g, char => '\\' + char), pattern = `%${escaped}%`;
      clauses.push(`(message LIKE ? ESCAPE '\\' OR error_code LIKE ? ESCAPE '\\' OR trace_id LIKE ? ESCAPE '\\' OR
        operation_id LIKE ? ESCAPE '\\' OR diagnostic_json LIKE ? ESCAPE '\\')`);
      params.push(pattern, pattern, pattern, pattern, pattern);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = get(`SELECT COUNT(*) AS n FROM run_logs ${where}`, ...params).n;
    const rows = all(`SELECT * FROM run_logs ${where} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`, ...params, pageSize, offset);
    // 下拉那份名册现算：按**除分类以外**的同一批条件下 GROUP BY（带着分类筛就会只剩一格，等于把选择器关掉）。
    const facetIndex = clauses.indexOf('category=?');
    const facetClauses = hasCategory ? clauses.filter((_, index) => index !== facetIndex) : clauses;
    const facetParams = hasCategory ? params.filter((_, index) => index !== facetIndex) : params;
    const categories = all(`SELECT category, COUNT(*) AS n FROM run_logs ${facetClauses.length ? `WHERE ${facetClauses.join(' AND ')}` : ''} GROUP BY category ORDER BY n DESC LIMIT 60`,
      ...facetParams).map(row => ({
        category: String(row.category || ''),
        count: Number(row.n),
        // 整串还是当年那套英文 slug ⇒ 是改名前的老行，界面上要明写「旧分类」。
        legacy: /^[a-z][a-z0-9_-]{0,47}$/i.test(String(row.category || '')),
      })).filter(row => row.category !== '');
    return ok({ items: rows.map(mapLogRow), total: Number(total), page, pageSize, categories });
  }

  function runs(ctx) {
    const guard = requireAdmin(ctx);
    if (guard.fail) return guard.fail;
    const traceId = ctx.query.get('traceId');
    if (!traceId) return fail(400, '缺少运行标识', 'INPUT_INVALID');
    const clauses = ['trace_id=?'], params = [traceId];
    const userId = ctx.query.get('userId');
    const installId = ctx.query.get('installId');
    if (userId !== null && /^\d{1,12}$/.test(userId)) { clauses.push('user_id=?'); params.push(Number(userId)); }
    if (installId !== null && /^[A-Za-z0-9_-]{1,64}$/.test(installId)) { clauses.push('install_id=?'); params.push(installId); }
    const rows = all(`SELECT * FROM run_logs WHERE ${clauses.join(' AND ')} ORDER BY occurred_at ASC, id ASC`, ...params);
    return ok({ items: rows.map(mapLogRow), total: rows.length });
  }

  function getSettingsView() {
    const settings = getSettings(store, config);
    const backupRow = get('SELECT * FROM backups ORDER BY id DESC LIMIT 1');
    // 〔K26·2026-10-21〕保留清单必须有人读：`backup_retention` 此前只有写方（备份工具逐轮登记计划与实际），
    //   后台读不到＝「清理到底跑没跑、留了哪几份、删了几份」在客户面上永远空白。这张表由备份工具建，
    //   云端库里可能还没有它——先认表在不在，不在就如实报未读到，绝不编一份空清单冒充跑过。
    const hasRetention = !!get("SELECT name FROM sqlite_master WHERE type='table' AND name='backup_retention'");
    const retentionRows = hasRetention
      ? all('SELECT id,at,ok,kept,removed,bytes,reason,detail FROM backup_retention ORDER BY id DESC LIMIT 14') : [];
    return {
      allowRegistration: settings.allowRegistration,
      retention: settings.retention,
      retentionAudit: {
        available: hasRetention,
        items: retentionRows.map((row) => ({
          id: Number(row.id), at: String(row.at || ''), ok: toBool(row.ok),
          kept: Number(row.kept) || 0, removed: Number(row.removed) || 0, bytes: Number(row.bytes) || 0,
          reason: String(row.reason || ''),
          detail: String(row.detail || '').slice(0, 800),
        })),
      },
      backup: {
        lastAt: backupRow ? backupRow.at : null,
        ok: backupRow ? toBool(backupRow.ok) : null,
        sizeBytes: backupRow ? backupRow.size_bytes ?? null : null,
        sha256: backupRow ? backupRow.sha256 ?? null : null,
        detail: backupRow ? backupRow.detail : '',
      },
      sessionTtlMinutes: config.sessionTtlMinutes,
      graceHours: config.graceHours,
      licenseRenewAfterSeconds: config.licenseRenewAfterSeconds,
    };
  }

  function settings(ctx) {
    const guard = requireAdmin(ctx);
    if (guard.fail) return guard.fail;
    return ok(getSettingsView());
  }

  function updateSettings(ctx) {
    const guard = requireAdmin(ctx);
    if (guard.fail) return guard.fail;
    const input = ctx.body;
    if (!isPlainObject(input)) return fail(400, '设置格式不正确', 'INPUT_INVALID');
    for (const key of Object.keys(input)) {
      if (key !== 'allowRegistration' && key !== 'retention') return fail(400, '包含不允许的设置项', 'SETTINGS_FIELD_NOT_ALLOWED');
    }
    if (input.allowRegistration !== undefined) {
      if (typeof input.allowRegistration !== 'boolean') return fail(400, '注册开关格式不正确', 'INPUT_INVALID');
    }
    if (input.retention !== undefined) {
      if (!isPlainObject(input.retention)) return fail(400, '保留期格式不正确', 'INPUT_INVALID');
      for (const key of Object.keys(input.retention)) if (!['normalDays', 'errorDays'].includes(key)) return fail(400, '包含不允许的保留期项', 'SETTINGS_FIELD_NOT_ALLOWED');
      for (const key of ['normalDays', 'errorDays']) {
        const value = input.retention[key];
        if (value !== undefined && (!integerAtLeast(value, 1) || value > 3650)) return fail(400, '保留天数必须是 1 到 3650 的整数', 'INPUT_INVALID');
      }
    }
    // Validate the entire command before any write. A bad retention field must
    // not leave an already-written registration switch behind.
    store.transaction(() => {
      if (input.allowRegistration !== undefined) setAllowRegistration(store, input.allowRegistration);
      if (input.retention !== undefined) setRetention(store, input.retention);
      audit(guard.admin.username, 'settings_update', 'settings', JSON.stringify(Object.keys(input)));
    });
    return ok(getSettingsView());
  }

  function auditList(ctx) {
    const guard = requireAdmin(ctx);
    if (guard.fail) return guard.fail;
    const { page, pageSize, offset } = parsePage(ctx.query);
    const total = get('SELECT COUNT(*) AS n FROM admin_audit').n;
    const rows = all('SELECT * FROM admin_audit ORDER BY id DESC LIMIT ? OFFSET ?', pageSize, offset);
    return ok({
      items: rows.map(row => ({
        id: Number(row.id), adminUsername: row.admin_username, action: row.action,
        target: row.target, detail: row.detail, at: row.at,
      })),
      total: Number(total), page, pageSize,
    });
  }

  function health(ctx) {
    return ok(deps.health());
  }

  return [
    { method: 'POST', path: '/api/admin/login', handler: login },
    { method: 'POST', path: '/api/admin/refresh', handler: refresh },
    { method: 'POST', path: '/api/admin/logout', handler: logout },
    { method: 'POST', path: '/api/admin/password', handler: password },
    { method: 'GET', path: '/api/admin/users', handler: users },
    { method: 'POST', path: '/api/admin/users/:id/enabled', handler: setEnabled },
    { method: 'POST', path: '/api/admin/users/:id/reset-password', handler: resetPassword },
    { method: 'POST', path: '/api/admin/users/:id/remark', handler: setRemark },
    { method: 'GET', path: '/api/admin/logs', handler: logs },
    { method: 'GET', path: '/api/admin/logs/runs', handler: runs },
    { method: 'GET', path: '/api/admin/settings', handler: settings },
    { method: 'PUT', path: '/api/admin/settings', handler: updateSettings },
    { method: 'GET', path: '/api/admin/audit', handler: auditList },
    { method: 'GET', path: '/api/admin/health', handler: health },
  ];
}
