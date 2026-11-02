// Candidate replacement for cloud/session.mjs. Copy into product only after sole-writer review.
import crypto from 'node:crypto';
import { fail } from './common.mjs';

function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function newToken() { return crypto.randomBytes(32).toString('hex'); }
function addMinutes(iso, minutes) { return new Date(Date.parse(iso) + minutes * 60_000).toISOString(); }
function addDays(iso, days) { return new Date(Date.parse(iso) + days * 86_400_000).toISOString(); }
function canonicalFlat(value) {
  return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])));
}
function receiptKey(oldRefreshToken, context) {
  const salt = crypto.createHash('sha256').update('garden-software-refresh-receipt/v1').digest();
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(oldRefreshToken, 'utf8'), salt,
    Buffer.from(canonicalFlat(context), 'utf8'), 32));
}
function sealReceipt(oldRefreshToken, context, value) {
  const aad = Buffer.from(canonicalFlat({ version: 'software-refresh-receipt/v1', ...context }), 'utf8');
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', receiptKey(oldRefreshToken, context), iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(v => v.toString('base64url')).join('.');
}
function openReceipt(oldRefreshToken, context, encoded) {
  const parts = String(encoded || '').split('.');
  if (parts.length !== 3) throw new Error('Invalid receipt');
  const [iv, tag, ciphertext] = parts.map(v => Buffer.from(v, 'base64url'));
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > 16_384) throw new Error('Invalid receipt');
  const aad = Buffer.from(canonicalFlat({ version: 'software-refresh-receipt/v1', ...context }), 'utf8');
  const decipher = crypto.createDecipheriv('aes-256-gcm', receiptKey(oldRefreshToken, context), iv);
  decipher.setAAD(aad); decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
}
const rejected = () => ({ fail: fail(401, '刷新凭据已失效，请重新登录', 'SESSION_REVOKED') });

export function createSessionManager(store, config) {
  const { run, get, nowIso } = store;
  function issue({ kind, userId = null, adminId = null, installId = '' }) {
    const created = nowIso(), accessExpiresAt = addMinutes(created, config.sessionTtlMinutes),
      refreshExpiresAt = addDays(created, config.refreshTtlDays), accessToken = newToken(), refreshToken = newToken();
    const info = run(`INSERT INTO software_sessions(kind,user_id,admin_id,token_hash,install_id,created_at,expires_at,last_used_at)
      VALUES(?,?,?,?,?,?,?,?)`, kind, userId, adminId, hashToken(accessToken), installId, created, accessExpiresAt, created);
    const sessionId = Number(info.lastInsertRowid);
    run('INSERT INTO refresh_tokens(session_id,token_hash,created_at,expires_at) VALUES(?,?,?,?)',
      sessionId, hashToken(refreshToken), created, refreshExpiresAt);
    return { sessionId, accessToken, refreshToken, accessExpiresAt, refreshExpiresAt, created, kind, installId };
  }
  function revokeSession(sessionId, reason) {
    run('UPDATE software_sessions SET revoked_at=?,revoke_reason=? WHERE id=? AND revoked_at IS NULL', nowIso(), reason, sessionId);
    run(`UPDATE refresh_tokens SET revoked_at=?,revoke_reason=? WHERE session_id=? AND revoked_at IS NULL AND used_at IS NULL`,
      nowIso(), reason, sessionId);
  }
  function revokeAllForUser(userId, reason) {
    for (const row of store.all("SELECT id FROM software_sessions WHERE kind='user' AND user_id=? AND revoked_at IS NULL", userId)) revokeSession(row.id, reason);
  }
  function revokeAllForAdmin(reason) {
    for (const row of store.all("SELECT id FROM software_sessions WHERE kind='admin' AND revoked_at IS NULL")) revokeSession(row.id, reason);
  }
  function resolveSession(bearer, expectedKind) {
    if (typeof bearer !== 'string' || !bearer) return { fail: fail(401, '会话令牌缺失或格式不正确', 'SESSION_INVALID') };
    const session = get('SELECT * FROM software_sessions WHERE token_hash=?', hashToken(bearer));
    if (!session) return { fail: fail(401, '会话无效，请重新登录', 'SESSION_INVALID') };
    if (session.revoked_at) return { fail: fail(401, '会话已失效，请重新登录', 'SESSION_REVOKED') };
    if (Date.parse(session.expires_at) <= Date.parse(nowIso())) return { fail: fail(401, '会话已过期，请重新登录', 'SESSION_EXPIRED') };
    if (session.kind !== expectedKind) return { fail: fail(401, '该令牌无权访问此接口', 'SESSION_INVALID') };
    run('UPDATE software_sessions SET last_used_at=? WHERE id=?', nowIso(), session.id);
    return { session };
  }
  function rotateByRefresh(refreshToken, installId, rotationIdOrPrincipal, maybePrincipalCheck) {
    // Backward-compatible 3-argument API: rotateByRefresh(token, installId, principalCheck).
    const rotationId = typeof rotationIdOrPrincipal === 'string' ? rotationIdOrPrincipal : null;
    const principalCheck = typeof rotationIdOrPrincipal === 'function' ? rotationIdOrPrincipal : maybePrincipalCheck;
    if (typeof refreshToken !== 'string' || !refreshToken) return { fail: fail(401, '刷新凭据缺失', 'SESSION_INVALID') };
    if (rotationId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rotationId)) return { fail: fail(400, '续期标识格式不正确', 'INPUT_INVALID') };
    const record = get('SELECT * FROM refresh_tokens WHERE token_hash=?', hashToken(refreshToken));
    if (!record) return { fail: fail(401, '刷新凭据无效，请重新登录', 'SESSION_REVOKED') };
    const session = get('SELECT * FROM software_sessions WHERE id=?', record.session_id);
    if (!session || session.revoked_at || record.revoked_at) return rejected();
    if (typeof installId === 'string' && installId && session.install_id && installId !== session.install_id) {
      revokeSession(session.id, 'install_mismatch');
      return { fail: fail(401, '安装标识与会话不一致，请重新登录', 'SESSION_INSTALL_MISMATCH') };
    }
    // Intentionally return denials instead of throwing: principalCheck may revoke all disabled-user sessions.
    if (typeof principalCheck === 'function') {
      const denial = principalCheck(session);
      if (denial) return { fail: denial };
    }
    if (record.used_at) {
      if (!rotationId || record.rotation_id !== rotationId) return rejected();
      const receiptRow = get('SELECT * FROM refresh_rotation_receipts WHERE old_refresh_id=? AND session_id=? AND rotation_id=?',
        record.id, session.id, rotationId);
      if (!receiptRow || receiptRow.install_id !== (installId || '')) return rejected();
      const child = get('SELECT * FROM refresh_tokens WHERE id=? AND session_id=?', receiptRow.child_refresh_id, session.id);
      if (!child || child.used_at || child.revoked_at || Date.parse(child.expires_at) <= Date.parse(nowIso())) return rejected();
      if (get('SELECT id FROM refresh_tokens WHERE parent_id=? LIMIT 1', child.id)) return rejected();
      let pair;
      const context = { sessionId: session.id, oldRefreshId: record.id, childRefreshId: child.id,
        rotationId, installId: receiptRow.install_id };
      try { pair = openReceipt(refreshToken, context, receiptRow.receipt_cipher); } catch { return rejected(); }
      if (hashToken(pair.accessToken) !== session.token_hash || hashToken(pair.refreshToken) !== child.token_hash
        || pair.sessionId !== session.id || pair.childRefreshId !== child.id) return rejected();
      // Access expiry is deliberately ignored for replay; a valid child refresh can recover the pair.
      return { rotated: { ...pair, kind: session.kind, installId: session.install_id }, replayed: true };
    }
    // Only an unused old credential is governed by its own expiry. A receipt
    // replay above is governed by the still-live child refresh expiry instead.
    if (Date.parse(record.expires_at) <= Date.parse(nowIso())) return { fail: fail(401, '刷新凭据已过期，请重新登录', 'SESSION_EXPIRED') };
    if (rotationId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rotationId)) {
      return { fail: fail(400, '续期标识格式不正确', 'INPUT_INVALID') };
    }
    // Rotation IDs are unique per session; reject reuse before any write to avoid an INSERT 500.
    if (rotationId && get('SELECT 1 AS present FROM refresh_rotation_receipts WHERE session_id=? AND rotation_id=? LIMIT 1', session.id, rotationId)) return rejected();
    const created = nowIso(), accessExpiresAt = addMinutes(created, config.sessionTtlMinutes),
      refreshExpiresAt = addDays(created, config.refreshTtlDays), accessToken = newToken(), newRefresh = newToken();
    const consumed = run(`UPDATE refresh_tokens SET used_at=?,rotation_id=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL`,
      created, rotationId, record.id);
    if (consumed.changes !== 1) return rejected();
    const sessionUpdated = run('UPDATE software_sessions SET token_hash=?,expires_at=?,last_used_at=? WHERE id=? AND revoked_at IS NULL',
      hashToken(accessToken), accessExpiresAt, created, session.id);
    if (sessionUpdated.changes !== 1) {
      const error = new Error('Refresh rotation lost session CAS');
      error.code = 'SESSION_ROTATION_CONFLICT';
      throw error; // Caller transaction rolls back old-token consumption and all subsequent writes.
    }
    const childInfo = run(`INSERT INTO refresh_tokens(session_id,token_hash,created_at,expires_at,parent_id,rotation_id)
      VALUES(?,?,?,?,?,?)`, session.id, hashToken(newRefresh), created, refreshExpiresAt, record.id, rotationId);
    const childRefreshId = Number(childInfo.lastInsertRowid);
    const rotated = { sessionId: session.id, accessToken, refreshToken: newRefresh, accessExpiresAt,
      refreshExpiresAt, created, childRefreshId };
    if (rotationId) {
      const context = { sessionId: session.id, oldRefreshId: record.id, childRefreshId, rotationId, installId: installId || '' };
      const receipt_cipher = sealReceipt(refreshToken, context, rotated);
      run(`INSERT INTO refresh_rotation_receipts(old_refresh_id,session_id,child_refresh_id,rotation_id,install_id,receipt_cipher,created_at)
        VALUES(?,?,?,?,?,?,?)`, record.id, session.id, childRefreshId, rotationId, installId || '', receipt_cipher, created);
    }
    return { rotated: { ...rotated, kind: session.kind, installId: session.install_id }, replayed: false };
  }
  function revokeByRotationReceipt(refreshToken, rotationId, installId) {
    if (typeof refreshToken !== 'string' || !refreshToken || typeof rotationId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rotationId)
      || typeof installId !== 'string' || !installId) return rejected();
    const record = get('SELECT * FROM refresh_tokens WHERE token_hash=?', hashToken(refreshToken));
    if (!record) return rejected();
    const session = get('SELECT * FROM software_sessions WHERE id=?', record.session_id);
    if (!session || (installId || '') !== (session.install_id || '')) return rejected();
    if (!record.used_at) {
      // An unused exact refresh secret can retire only its own session. This is
      // a reduction operation: it never creates or returns credentials.
      if (get('SELECT id FROM refresh_tokens WHERE parent_id=? LIMIT 1', record.id)) return rejected();
      const sibling = get(`SELECT id FROM refresh_tokens WHERE session_id=? AND id<>?
        AND used_at IS NULL AND revoked_at IS NULL AND expires_at>? LIMIT 1`, session.id, record.id, nowIso());
      if (sibling) return rejected();
      if (session.revoked_at) return { revoked: true, alreadyRevoked: true, sessionId: session.id };
      revokeSession(session.id, 'logout_unused_refresh');
      return { revoked: true, sessionId: session.id };
    }
    if (record.rotation_id !== rotationId) {
      // A clone may try a new attempt after this exact secret was consumed by
      // another attempt. Prove only non-issuance of the requested attempt; never
      // revoke or return credentials from the session that advanced meanwhile.
      if (session.kind !== 'user' || !Number.isSafeInteger(session.user_id) || session.user_id <= 0
        || !get('SELECT id FROM software_users WHERE id=?', session.user_id)
        || typeof record.rotation_id !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.rotation_id)) return rejected();
      const consumed = get('SELECT child_refresh_id FROM refresh_rotation_receipts WHERE old_refresh_id=? AND session_id=? AND rotation_id=? AND install_id=?',
        record.id, session.id, record.rotation_id, installId);
      if (!consumed || !get('SELECT id FROM refresh_tokens WHERE id=? AND session_id=? AND parent_id=?',
        consumed.child_refresh_id, session.id, record.id)) return rejected();
      if (get(`SELECT 1 FROM refresh_rotation_receipts r JOIN software_sessions s ON s.id=r.session_id
        WHERE r.rotation_id=? AND s.install_id=? LIMIT 1`, rotationId, installId)
        || get(`SELECT 1 FROM refresh_tokens r JOIN software_sessions s ON s.id=r.session_id
        WHERE r.rotation_id=? AND s.install_id=? LIMIT 1`, rotationId, installId)) return rejected();
      return { revoked: false, alreadyRevoked: false, proofVersion: 'software-refresh-attempt-terminal/v1',
        attemptSuperseded: true, attemptIssued: false, rotationId, installId, userId: session.user_id };
    }
    const receipt = get('SELECT * FROM refresh_rotation_receipts WHERE old_refresh_id=? AND session_id=? AND rotation_id=? AND install_id=?',
      record.id, session.id, rotationId, installId || '');
    if (!receipt) return rejected();
    const child = get('SELECT * FROM refresh_tokens WHERE id=? AND session_id=?', receipt.child_refresh_id, session.id);
    if (!child || child.used_at || get('SELECT id FROM refresh_tokens WHERE parent_id=? LIMIT 1', child.id)) return rejected();
    try {
      const context = { sessionId: session.id, oldRefreshId: record.id, childRefreshId: child.id, rotationId, installId: installId || '' };
      const pair = openReceipt(refreshToken, context, receipt.receipt_cipher);
      if (hashToken(pair.refreshToken) !== child.token_hash || hashToken(pair.accessToken) !== session.token_hash) return rejected();
    } catch { return rejected(); }
    // Exact receipt validation proves this retired generation. Repeating cleanup
    // is idempotent, while an advanced child generation remains rejected above.
    if (session.revoked_at) return { revoked: true, alreadyRevoked: true, sessionId: session.id };
    revokeSession(session.id, 'logout_rotation_receipt');
    return { revoked: true, sessionId: session.id };
  }
  function revokeCurrent(bearerSessionId, refreshToken) {
    if (typeof refreshToken === 'string' && refreshToken) run(`UPDATE refresh_tokens SET revoked_at=?,revoke_reason=?
      WHERE session_id=? AND token_hash=? AND used_at IS NULL AND revoked_at IS NULL`, nowIso(), 'logout', bearerSessionId, hashToken(refreshToken));
    revokeSession(bearerSessionId, 'logout');
  }
  return { issue, revokeSession, revokeAllForUser, revokeAllForAdmin, resolveSession, rotateByRefresh,
    revokeByRotationReceipt, revokeCurrent, hashToken };
}





