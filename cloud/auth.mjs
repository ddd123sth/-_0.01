// Software-facing routes: register, login, refresh, logout, password, license, health.
import {
  ok, created, fail, isPlainObject, validUsername, validSoftwarePassword, validInstallId, optionalBounded,
} from './common.mjs';
import { getSettings } from './settings.mjs';

function userPublic(row) {
  return { id: Number(row.id), username: row.username, enabled: Boolean(row.enabled), createdAt: row.created_at };
}

export function createSoftwareRoutes(deps) {
  const { store, config, hasher, sessions, limiter, health } = deps;
  const { run, get, nowIso } = store;

  function licenseBody(grantMs) {
    const serverTimeMs = Date.now();
    const grantServerMs = grantMs === undefined ? serverTimeMs : grantMs;
    return {
      state: 'granted',
      grantServerMs,
      serverTimeMs,
      renewAfterMs: config.licenseRenewAfterSeconds * 1000,
      hardDeadlineMs: grantServerMs + config.graceHours * 3_600_000,
    };
  }

  async function register(ctx) {
    const settings = getSettings(store, config);
    if (!settings.allowRegistration) return fail(403, '注册功能已关闭，请联系管理员', 'REGISTRATION_CLOSED');
    if (!limiter.registerAllowed(ctx.ip)) return fail(429, '注册过于频繁，请稍后再试', 'REGISTER_THROTTLED');
    const input = ctx.body;
    if (!isPlainObject(input)) return fail(400, '注册信息格式不正确', 'INPUT_INVALID');
    const { username, password } = input;
    if (!validUsername(username) || !validSoftwarePassword(password, username)) {
      return fail(400, '用户名或密码不符合要求', 'INPUT_INVALID');
    }
    if (get('SELECT id FROM software_users WHERE username=?', username)) {
      return fail(409, '该用户名已被占用', 'USERNAME_TAKEN');
    }
    const passwordHash = await hasher.hash(password);
    const created_at = nowIso();
    let row;
    try {
      const info = run('INSERT INTO software_users(username,password_hash,enabled,remark,created_at,updated_at) VALUES(?,?,1,?,?,?)',
        username, passwordHash, '', created_at, created_at);
      row = get('SELECT * FROM software_users WHERE id=?', Number(info.lastInsertRowid));
    } catch (error) {
      if (String(error.message || '').includes('UNIQUE')) return fail(409, '该用户名已被占用', 'USERNAME_TAKEN');
      throw error;
    }
    limiter.recordRegister(ctx.ip);
    return created({ user: userPublic(row) });
  }

  async function login(ctx) {
    const input = ctx.body;
    if (!isPlainObject(input)) return fail(400, '登录信息格式不正确', 'INPUT_INVALID');
    const { username, password, installId, appVersion } = input;
    if (!validInstallId(installId) || !optionalBounded(appVersion, 32)) {
      return fail(400, '安装标识或版本号不符合要求', 'INPUT_INVALID');
    }
    const scope = 'software-login';
    const key = String(username || '').toLowerCase();
    if (limiter.isLocked(scope, key)) return fail(429, '登录尝试过多，请稍后再试', 'LOGIN_THROTTLED');

    const user = validUsername(username) ? get('SELECT * FROM software_users WHERE username=?', username) : undefined;
    const passwordOk = user ? await hasher.verify(String(password || ''), user.password_hash) : false;
    if (!user || !passwordOk) {
      limiter.recordFailure(scope, key);
      return fail(401, '用户名或密码不正确', 'SOFTWARE_LOGIN_FAILED');
    }
    if (!user.enabled) return fail(403, '软件账号已被停用', 'SOFTWARE_DISABLED');

    limiter.recordSuccess(scope, key);
    const issued = sessions.issue({ kind: 'user', userId: user.id, installId });
    run('UPDATE software_users SET last_login_at=? WHERE id=?', nowIso(), user.id);
    const row = get('SELECT * FROM software_users WHERE id=?', user.id);
    return ok({
      accessToken: issued.accessToken, accessExpiresAt: issued.accessExpiresAt,
      refreshToken: issued.refreshToken, refreshExpiresAt: issued.refreshExpiresAt,
      user: userPublic(row),
      serverTimeMs: Date.parse(issued.created),
      license: licenseBody(),
    });
  }

  async function refresh(ctx) {
    const input = ctx.body;
    if (!isPlainObject(input)) return fail(400, '续期信息格式不正确', 'INPUT_INVALID');
    const { refreshToken, installId, rotationId } = input;
    if (!validInstallId(installId)) return fail(400, '安装标识不符合要求', 'INPUT_INVALID');
    const principalCheck = session => {
      const user = get('SELECT * FROM software_users WHERE id=?', session.user_id);
      if (!user) return fail(401, '会话已失效，请重新登录', 'SESSION_REVOKED');
      if (!user.enabled) {
        sessions.revokeAllForUser(session.user_id, 'disabled');
        return fail(403, '软件账号已被停用', 'SOFTWARE_DISABLED');
      }
      return null;
    };
    if (rotationId !== undefined && (typeof rotationId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rotationId))) {
      return fail(400, '续期标识格式不正确', 'INPUT_INVALID');
    }
    let result;
    store.transaction(() => {
      result = rotationId === undefined
        ? sessions.rotateByRefresh(refreshToken, installId, principalCheck)
        : sessions.rotateByRefresh(refreshToken, installId, rotationId, principalCheck);
    });
    if (result.fail) return result.fail;
    const issued = result.rotated;
    const user = get('SELECT * FROM software_users WHERE id=?', sessionsUserId(issued.sessionId));
    const serverTimeMs = Date.now();
    return ok({
      accessToken: issued.accessToken, accessExpiresAt: issued.accessExpiresAt,
      refreshToken: issued.refreshToken, refreshExpiresAt: issued.refreshExpiresAt,
      user: userPublic(user),
      serverTimeMs,
      license: licenseBody(),
    });
  }
  function refreshRecoveryRevoke(ctx) {
    const input = ctx.body;
    if (!isPlainObject(input) || !validInstallId(input.installId) || typeof input.refreshToken !== 'string' || !input.refreshToken ||
        typeof input.rotationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.rotationId)) {
      return fail(400, '轮换回收凭据格式不正确', 'INPUT_INVALID');
    }
    let result;
    store.transaction(() => { result = sessions.revokeByRotationReceipt(input.refreshToken, input.rotationId, input.installId); });
    if (result.fail) return result.fail;
    return ok({ ok: true, revoked: result.revoked === true, alreadyRevoked: result.alreadyRevoked === true,
      ...(result.attemptSuperseded === true ? { proofVersion: result.proofVersion,
        attemptSuperseded: true, attemptIssued: result.attemptIssued,
        rotationId: result.rotationId, installId: result.installId, userId: result.userId } : {}) });
  }
  function sessionsUserId(sessionId) {
    const session = get('SELECT user_id FROM software_sessions WHERE id=?', sessionId);
    return session ? session.user_id : null;
  }

  async function logout(ctx) {
    const resolved = sessions.resolveSession(ctx.bearer, 'user');
    if (resolved.fail) return resolved.fail;
    const refreshToken = isPlainObject(ctx.body) ? ctx.body.refreshToken : undefined;
    sessions.revokeCurrent(resolved.session.id, refreshToken);
    return ok({ ok: true });
  }

  async function password(ctx) {
    const resolved = sessions.resolveSession(ctx.bearer, 'user');
    if (resolved.fail) return resolved.fail;
    const input = ctx.body;
    if (!isPlainObject(input)) return fail(400, '改密信息格式不正确', 'INPUT_INVALID');
    const { currentPassword, newPassword } = input;
    const user = get('SELECT * FROM software_users WHERE id=?', resolved.session.user_id);
    if (!user) return fail(401, '会话已失效，请重新登录', 'SESSION_REVOKED');
    const currentOk = await hasher.verify(String(currentPassword || ''), user.password_hash);
    if (!currentOk) return fail(401, '当前密码不正确', 'SOFTWARE_LOGIN_FAILED');
    if (!validSoftwarePassword(newPassword, user.username)) return fail(400, '新密码不符合要求', 'INPUT_INVALID');
    const passwordHash = await hasher.hash(newPassword);
    run('UPDATE software_users SET password_hash=?,updated_at=? WHERE id=?', passwordHash, nowIso(), user.id);
    sessions.revokeAllForUser(user.id, 'password_changed');
    return ok({ ok: true, revoked: true });
  }

  function license(ctx) {
    const resolved = sessions.resolveSession(ctx.bearer, 'user');
    if (resolved.fail) return resolved.fail;
    const user = get('SELECT * FROM software_users WHERE id=?', resolved.session.user_id);
    if (!user) return fail(401, '会话已失效，请重新登录', 'SESSION_REVOKED');
    const enabled = Boolean(user.enabled);
    const grant = licenseBody();
    return ok({
      enabled,
      state: enabled ? 'granted' : 'disabled',
      serverTimeMs: grant.serverTimeMs,
      grantServerMs: grant.grantServerMs,
      renewAfterMs: grant.renewAfterMs,
      hardDeadlineMs: grant.hardDeadlineMs,
      user: { id: Number(user.id), username: user.username, enabled },
    });
  }

  function healthCheck() {
    return ok(health());
  }

  return [
    { method: 'POST', path: '/api/software/register', handler: register },
    { method: 'POST', path: '/api/software/login', handler: login },
    { method: 'POST', path: '/api/software/refresh', handler: refresh },
    { method: 'POST', path: '/api/software/refresh-recovery-revoke', handler: refreshRecoveryRevoke },
    { method: 'POST', path: '/api/software/logout', handler: logout },
    { method: 'POST', path: '/api/software/password', handler: password },
    { method: 'GET', path: '/api/software/license', handler: license },
    { method: 'GET', path: '/api/software/health', handler: healthCheck },
  ];
}
