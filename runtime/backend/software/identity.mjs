import crypto from 'node:crypto';
import { createSoftwareApi } from '../../software-api.mjs';
import { canonical, parseStored, problem } from '../common.mjs';

const POLL_MS = 20_000;
const PROCESS_INSTANCE_REF = crypto.randomUUID();
const REVOKED_CODES = new Set(['SESSION_REVOKED', 'SESSION_INVALID', 'SESSION_INSTALL_MISMATCH']);
const TOKEN = /^[\x21-\x7e]{16,8192}$/;
const isToken = value => typeof value === 'string' && TOKEN.test(value);
const isTimestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const mono = () => Number(process.hrtime.bigint()) / 1_000_000;
const safeCode = error => /^[A-Z0-9_]{1,80}$/.test(String(error?.code || '')) ? String(error.code) : 'SOFTWARE_REQUEST_FAILED';
function usernameOf(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{3,32}$/.test(value.trim())) throw problem('INPUT_INVALID', '软件账号格式不正确', 400);
  return value.trim();
}
function passwordOf(value) {
  if (typeof value !== 'string' || !/^[\x20-\x7e]{8,64}$/.test(value)) throw problem('INPUT_INVALID', '软件密码格式不正确', 400);
  return value;
}
function userOf(value) {
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.id) || value.id <= 0
    || typeof value.enabled !== 'boolean') throw problem('SOFTWARE_AUTH_INCOMPLETE', '云服务身份确认不完整', 502);
  return { id: value.id, username: usernameOf(value.username), enabled: value.enabled,
    ...(typeof value.createdAt === 'string' ? { createdAt: value.createdAt.slice(0, 40) } : {}) };
}
function completeGrant(payload, startedAt, now) {
  const grant = payload?.license || payload;
  const { grantServerMs, serverTimeMs, hardDeadlineMs, renewAfterMs } = grant || {};
  if (grant?.state !== 'granted' || ![grantServerMs, serverTimeMs, hardDeadlineMs, renewAfterMs].every(Number.isSafeInteger)
    || grantServerMs <= 0 || serverTimeMs < grantServerMs || hardDeadlineMs <= serverTimeMs || renewAfterMs <= 0
    || !Number.isFinite(new Date(hardDeadlineMs).getTime())
    || (payload?.license && (!Number.isSafeInteger(payload.serverTimeMs) || payload.serverTimeMs <= 0))) {
    throw problem('SOFTWARE_LICENSE_INCOMPLETE', '云服务授权回执不完整，原有记录已保留', 502);
  }
  const requestElapsed = Math.max(0, now - startedAt);
  const remaining = hardDeadlineMs - serverTimeMs - requestElapsed;
  if (remaining <= 0) throw problem('SOFTWARE_GRANT_EXPIRED', '云服务授权在接收前已到期', 403);
  return { grantServerMs, serverTimeMs, hardDeadlineMs, renewAfterMs,
    receivedMono: now, remainingMs: remaining,
    renewRemainingMs: Math.max(0, renewAfterMs - (serverTimeMs - grantServerMs) - requestElapsed) };
}
function authPayload(payload, requestedUsername, expectedUserId, startedAt) {
  const user = userOf(payload?.user);
  if (!user.enabled) throw problem('SOFTWARE_DISABLED', '软件账号已停用', 403);
  if ((requestedUsername && user.username !== requestedUsername)
    || (expectedUserId !== null && user.id !== expectedUserId)) throw problem('SOFTWARE_AUTH_IDENTITY_MISMATCH', '云服务返回的身份与本次请求不一致', 502);
  if (!isToken(payload?.accessToken) || !isToken(payload?.refreshToken)
    || !isTimestamp(payload?.accessExpiresAt) || !isTimestamp(payload?.refreshExpiresAt)
    || Date.parse(payload.accessExpiresAt) <= payload.serverTimeMs || Date.parse(payload.refreshExpiresAt) <= payload.serverTimeMs) {
    throw problem('SOFTWARE_AUTH_INCOMPLETE', '云服务会话确认不完整', 502);
  }
  return { session: { user, accessToken: payload.accessToken, refreshToken: payload.refreshToken,
    accessExpiresAt: payload.accessExpiresAt, refreshExpiresAt: payload.refreshExpiresAt },
    grant: completeGrant(payload, startedAt, mono()) };
}

export function createSoftwareIdentity({ store, cipher, baseUrl, fetchImpl, stopAll, suspendOwner, onAuthorized = () => {}, appVersion = '0.2.0-backend', log = () => {}, processInstanceRef = PROCESS_INSTANCE_REF }) {
  if (!store?.transaction || typeof cipher?.encrypt !== 'function' || typeof cipher?.decrypt !== 'function' || typeof stopAll !== 'function' || typeof suspendOwner !== 'function') {
    throw new TypeError('Software identity requires a durable store, credential cipher and stopAll');
  }
  let base;
  try { base = new URL(String(baseUrl || '').trim()); } catch { throw problem('SOFTWARE_BASE_URL_INVALID', '尚未配置独立新云入口', 503); }
  const cloudHost = base.hostname.toLowerCase().replace(/\.$/, '');
  const cloudPath = base.pathname.replace(/\/+$/, '');
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
    || cloudHost === 'wujinxia.ainiannian.online'
    || (cloudHost === 'wujinxia01.ainiannian.online' && cloudPath !== '/backend-v2')) {
    throw problem('SOFTWARE_BASE_URL_INVALID', '新后端必须使用独立新云HTTPS入口', 503);
  }
  const api = createSoftwareApi({ baseUrl: base.href.replace(/\/+$/, ''), appVersion, fetchImpl });
  const cloudRef = crypto.createHash('sha256').update(api.origin).digest('hex');
  const { get, run, transaction, nowIso } = store;
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS backend_software_state(
      cloud_ref TEXT PRIMARY KEY,install_id TEXT NOT NULL,identity_epoch INTEGER NOT NULL,
      credential_revision INTEGER NOT NULL,revoke_epoch INTEGER NOT NULL,session_cipher TEXT,
      state TEXT NOT NULL,stop_pending INTEGER NOT NULL,last_code TEXT,updated_at TEXT NOT NULL,pending_auth_cipher TEXT,rotation_pending_cipher TEXT,cloud_logout_pending INTEGER NOT NULL DEFAULT 0,logout_pending_cipher TEXT);
    CREATE TABLE IF NOT EXISTS backend_software_owners(
      owner_ref TEXT PRIMARY KEY,cloud_ref TEXT NOT NULL,user_id INTEGER NOT NULL,
      username TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(cloud_ref,user_id));
    CREATE TABLE IF NOT EXISTS backend_software_audit(
      audit_id INTEGER PRIMARY KEY AUTOINCREMENT,cloud_ref TEXT NOT NULL,owner_ref TEXT,
      identity_epoch INTEGER NOT NULL,revoke_epoch INTEGER NOT NULL,event_type TEXT NOT NULL,
      code TEXT NOT NULL,created_at TEXT NOT NULL);`);
  if (!store.all('PRAGMA table_info(backend_software_state)').some(column => column.name === 'pending_auth_cipher')) store.db.exec('ALTER TABLE backend_software_state ADD COLUMN pending_auth_cipher TEXT');
  if (!store.all('PRAGMA table_info(backend_software_state)').some(column => column.name === 'rotation_pending_cipher')) store.db.exec('ALTER TABLE backend_software_state ADD COLUMN rotation_pending_cipher TEXT');
  if (!store.all('PRAGMA table_info(backend_software_state)').some(column => column.name === 'cloud_logout_pending')) store.db.exec('ALTER TABLE backend_software_state ADD COLUMN cloud_logout_pending INTEGER NOT NULL DEFAULT 0');
  if (!store.all('PRAGMA table_info(backend_software_state)').some(column => column.name === 'logout_pending_cipher')) store.db.exec('ALTER TABLE backend_software_state ADD COLUMN logout_pending_cipher TEXT');
  transaction(() => {
    if (!get('SELECT cloud_ref FROM backend_software_state WHERE cloud_ref=?', cloudRef)) run(
      `INSERT INTO backend_software_state(cloud_ref,install_id,identity_epoch,credential_revision,revoke_epoch,session_cipher,state,stop_pending,last_code,updated_at,pending_auth_cipher)
        VALUES(?,?,0,0,0,NULL,?,0,NULL,?,NULL)`,
      cloudRef, crypto.randomBytes(16).toString('hex'), 'signed_out', nowIso());
  });
  let row = readRow();
  let session = decode(row.session_cipher);
  let pendingAuth = decodePending(row.pending_auth_cipher);
  let rotationPending = decodeRotation(row.rotation_pending_cipher);
  let logoutPending = decodeRotation(row.logout_pending_cipher);
  let liveGrant = null;
  let closed = false, initialized = false, authBusy = false;
  let refreshFlight = null, licenseFlight = null, stopFlight = null;
  let pollTimer = null, deadlineTimer = null;
  // A persisted grant is historical evidence. A new process must refresh before use.
  let licenseState = session ? (['disabled', 'signed_out', 'reauth_required', 'ownership_conflict'].includes(row.state) ? row.state : 'unverified') : 'signed_out';
  const engineOwner = ownerRef();
  function readRow() { return get('SELECT * FROM backend_software_state WHERE cloud_ref=?', cloudRef); }
  function decode(value) {
    if (!value) return null;
    try {
      const plain = cipher.decrypt(value);
      if (typeof plain !== 'string') throw new Error('Invalid cipher result');
      const decoded = parseStored(plain, '软件身份密文');
      const user = userOf(decoded.user);
      if (!isToken(decoded.accessToken) || !isToken(decoded.refreshToken)) throw new Error('Incomplete saved session');
      return { ...decoded, user };
    } catch { throw problem('SOFTWARE_STORE_UNREADABLE', '本机软件身份无法安全读取，原记录已保留', 503); }
  }
  function decodeRotation(value) {
    if (!value) return null;
    try { const decoded = parseStored(cipher.decrypt(value), '软件刷新轮换密文');
      if (decoded?.version !== 'software-refresh-rotation/v1' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decoded.rotationId)
        || !decoded.ownerRef || !Number.isSafeInteger(decoded.userId) || !Number.isSafeInteger(decoded.identityEpoch)
        || !Number.isSafeInteger(decoded.credentialRevision) || !decoded.installId || !isToken(decoded.oldRefreshToken)
        || !['awaiting_refresh','pair_committed_pending_retire'].includes(decoded.phase)
        || !isTimestamp(decoded.createdAt) || (decoded.phase === 'pair_committed_pending_retire' && !Number.isSafeInteger(decoded.postCommitCredentialRevision))) throw new Error('invalid rotation intent');
      return decoded;
    } catch { throw problem('SOFTWARE_STORE_UNREADABLE', '待恢复的软件刷新资料无法安全读取，原记录已保留', 503); }
  }
  function decodePending(value) {
    if (!value) return null;
    try {
      const plain = cipher.decrypt(value), decoded = parseStored(plain, '软件待授权密文');
      if (decoded?.version !== 'software-pending-auth/v1' || typeof decoded.ownerRef !== 'string' ||
          !Number.isSafeInteger(decoded.identityEpoch) || !Number.isSafeInteger(decoded.credentialRevision) ||
          !decoded.session || !decoded.grant || !Number.isSafeInteger(decoded.grant.hardDeadlineMs)) throw new Error('Invalid pending grant');
      return decoded;
    } catch { throw problem('SOFTWARE_STORE_UNREADABLE', '本机待授权资料无法安全读取，原记录已保留', 503); }
  }
  function encoded(value) {
    if (!value) return null;
    const plain = canonical(value), encrypted = cipher.encrypt(plain);
    if (typeof encrypted !== 'string' || !encrypted || encrypted === plain) throw problem('SOFTWARE_CIPHER_INVALID', '软件会话加密失败', 503);
    return encrypted;
  }
  function ownerFor(userId) { return 'cloud:' + cloudRef + ':software:' + userId; }
  function assertOpen() { if (closed) throw problem('SOFTWARE_CLOSED', '软件身份服务已停止', 503); }
  function ownerRef() { return session ? ownerFor(session.user.id) : null; }
  function context() { return { identityEpoch: row.identity_epoch, credentialRevision: row.credential_revision, ownerRef: ownerRef(), userId: session?.user.id ?? null, installId: row.install_id }; }
  function current(value) { return !closed && value.identityEpoch === row.identity_epoch && value.credentialRevision === row.credential_revision && value.ownerRef === ownerRef() && value.userId === (session?.user.id ?? null) && value.installId === row.install_id; }
  function audit(type, code, owner = ownerRef()) {
    run('INSERT INTO backend_software_audit(cloud_ref,owner_ref,identity_epoch,revoke_epoch,event_type,code,created_at) VALUES(?,?,?,?,?,?,?)',
      cloudRef, owner, row.identity_epoch, row.revoke_epoch, type, code, nowIso());
  }
  function changed() { row = readRow(); pendingAuth = decodePending(row.pending_auth_cipher); rotationPending = decodeRotation(row.rotation_pending_cipher); logoutPending = decodeRotation(row.logout_pending_cipher); }
  function clearDeadline() { if (deadlineTimer) clearTimeout(deadlineTimer); deadlineTimer = null; }
  function grantState() {
    if (!session) return 'signed_out';
    if (closed) return 'unverified';
    if (licenseState === 'signed_out') return 'signed_out';
    if (licenseState === 'reauth_required') return 'reauth_required';
    if (licenseState === 'ownership_conflict') return 'ownership_conflict';
    if (licenseState === 'disabled') return 'disabled';
    if (!liveGrant || row.stop_pending) return licenseState === 'grace_expired' ? 'grace_expired' : 'unverified';
    const elapsed = Math.max(0, mono() - liveGrant.receivedMono);
    if (elapsed >= liveGrant.remainingMs) return 'grace_expired';
    return elapsed >= liveGrant.renewRemainingMs ? 'needs_renew' : 'granted';
  }
  function status() {
    const state = grantState();
    const remaining = liveGrant ? Math.max(0, liveGrant.remainingMs - Math.max(0, mono() - liveGrant.receivedMono)) : null;
    return {
      signedIn: Boolean(session) && state !== 'signed_out', user: session && state !== 'signed_out' ? { ...session.user, enabled: state === 'disabled' ? false : session.user.enabled, accessExpiresAt: session.accessExpiresAt, refreshExpiresAt: session.refreshExpiresAt } : null,
      userId: state === 'signed_out' ? null : session?.user.id ?? null, installId: row.install_id, ownerRef: ownerRef(), panelToken: ownerRef(),
      cloudConfigured: true, licenseState: state, authorized: ['granted', 'needs_renew'].includes(state),
      renewAfterMs: liveGrant?.renewAfterMs ?? POLL_MS, graceRemainingMs: remaining,
      graceExpiresAt: remaining === null ? null : new Date(Date.now() + remaining).toISOString(),
      licenseHardDeadlineAt: liveGrant ? new Date(liveGrant.hardDeadlineMs).toISOString() : null,
      licenseCheckedAt: liveGrant?.checkedAt ?? null, revokedRunIntents: row.revoke_epoch > 0,
      identityEpoch: row.identity_epoch, credentialRevision: row.credential_revision, revokeEpoch: row.revoke_epoch,
      stopPending: row.stop_pending === 1, cloudLogoutPending: row.cloud_logout_pending === 1, code: row.last_code || null, updatedAt: row.updated_at,
      claim: { status: 'none', confirmedUserId: null, at: null }, unownedData: { count: 0, ownership: 'explicit-owner-schema' }, claimRequired: false,
      pendingAuthorization: Boolean(pendingAuth),
      rotationRecovery: {
        pending: Boolean(rotationPending), rotationId: rotationPending?.rotationId ?? null,
        phase: rotationPending?.phase ?? null, createdAt: rotationPending?.createdAt ?? null,
        identityEpoch: rotationPending?.identityEpoch ?? null,
        credentialRevision: rotationPending?.credentialRevision ?? null,
      },
      requiresEngineRestart: engineOwner !== ownerRef(), queue: null, uploadPolicy: null,
    };
  }
  function scheduleDeadline() {
    clearDeadline();
    if (!liveGrant || !session) return;
    const original = liveGrant, captured = context();
    const remaining = Math.max(1, original.remainingMs - (mono() - original.receivedMono));
    deadlineTimer = setTimeout(() => {
      deadlineTimer = null;
      if (!current(captured) || original !== liveGrant) return;
      if (grantState() !== 'grace_expired') { scheduleDeadline(); return; }
      void suspendForAuthorizationWait('SOFTWARE_GRACE_EXPIRED').catch(() => log('软件授权待重新核验，执行连接正在安全收尾', 'SOFTWARE_SUSPEND_PENDING'));
    }, Math.min(remaining, 2_147_000_000));
    deadlineTimer.unref?.();
  }
  async function finishStop() {
    if (!row.stop_pending) return { ok: true };
    if (stopFlight) { const result = await stopFlight; return row.stop_pending ? finishStop() : result; }
    const captured = { epoch: row.identity_epoch, revokeEpoch: row.revoke_epoch, owner: ownerRef() };
    const flight = (async () => {
      const result = await stopAll({ ownerRef: captured.owner, reasonCode: row.last_code || 'SOFTWARE_REVOKED',
        identityEpoch: captured.epoch, revokeEpoch: captured.revokeEpoch });
      if (!result || typeof result !== 'object' || result.stopCommitted !== true
        || (result.ok !== true && result.cleanupComplete !== true) || result.cleanupComplete === false || result.unconfirmed === true) {
        throw problem('SOFTWARE_STOP_INCOMPLETE', '软件资格已撤销，游戏连接停止尚未完成', 503);
      }
      if (row.identity_epoch === captured.epoch && row.revoke_epoch === captured.revokeEpoch) {
        transaction(() => { run('UPDATE backend_software_state SET stop_pending=0,updated_at=? WHERE cloud_ref=? AND identity_epoch=? AND revoke_epoch=?',
          nowIso(), cloudRef, captured.epoch, captured.revokeEpoch); changed(); audit('stop-confirmed', 'SOFTWARE_STOP_CONFIRMED', captured.owner); });
      }
      return result;
    })().finally(() => { if (stopFlight === flight) stopFlight = null; });
    stopFlight = flight;
    const result = await flight;
    return row.stop_pending ? finishStop() : result;
  }
  async function revoke(code, { state = 'signed_out', clear = false } = {}) {
    clearDeadline();
    liveGrant = null;
    const previousOwner = ownerRef();
    transaction(() => {
      run('UPDATE backend_software_state SET identity_epoch=identity_epoch+1,revoke_epoch=revoke_epoch+1,state=?,stop_pending=1,last_code=?,pending_auth_cipher=NULL,updated_at=? WHERE cloud_ref=?',
        state, code, nowIso(), cloudRef); changed(); audit('revoked', code, previousOwner);
    });
    const revocationEpoch = row.identity_epoch;
    licenseState = state;
    // Stop uses the old owner before any credentials are cleared.
    await finishStop();
    if (clear && row.identity_epoch === revocationEpoch && ownerRef() === previousOwner) {
      clearSavedSession(code, previousOwner);
    }
    return status();
  }
  async function suspendForAuthorizationWait(code = 'SOFTWARE_AUTH_RECHECK_REQUIRED', { state = 'unverified' } = {}) {
    clearDeadline();
    liveGrant = null;
    licenseState = state;
    transaction(() => {
      run('UPDATE backend_software_state SET state=?,last_code=?,updated_at=? WHERE cloud_ref=? AND state<>?',
        state, code, nowIso(), cloudRef, 'signed_out');
      changed();
      audit('authorization-wait', code, ownerRef());
    });
    const owner = ownerRef();
    if (owner) {
      const receipt = await suspendOwner(owner, code);
      if (!receipt?.stopCommitted || receipt.cleanupComplete !== true) {
        log('软件授权待重新核验，执行连接正在安全收尾', 'SOFTWARE_SUSPEND_PENDING');
        return { ...status(), suspensionPending: true };
      }
    }
    log('软件授权待重新核验，账号运行意愿已保留', code);
    return { ...status(), suspensionPending: false };
  }
  async function confirmSuspensionBeforeResume(captured) {
    if (!current(captured)) throw problem('SOFTWARE_AUTH_STALE', '软件授权核验期间身份已变化');
    if (!['SOFTWARE_GRACE_EXPIRED', 'SOFTWARE_AUTH_RECHECK_REQUIRED', 'SOFTWARE_DISABLED', 'SOFTWARE_CREDENTIALS_REAUTH_REQUIRED'].includes(row.last_code)) return;
    const owner = captured.ownerRef;
    if (!owner) return;
    const receipt = await suspendOwner(owner, row.last_code);
    if (!current(captured) || ownerRef() !== owner) throw problem('SOFTWARE_AUTH_STALE', '软件身份在连接收尾期间已变化');
    if (!receipt?.stopCommitted || receipt.cleanupComplete !== true) {
      throw problem('SOFTWARE_SUSPEND_PENDING', '软件授权已恢复，游戏连接仍在安全收尾', 503);
    }
  }
  function clearSavedSession(code, previousOwner = ownerRef()) {
    transaction(() => { run('UPDATE backend_software_state SET session_cipher=NULL,pending_auth_cipher=NULL,rotation_pending_cipher=NULL,logout_pending_cipher=NULL,state=?,credential_revision=credential_revision+1,updated_at=? WHERE cloud_ref=? AND stop_pending=0 AND cloud_logout_pending=0',
      'signed_out', nowIso(), cloudRef); changed();
      if (row.stop_pending) throw problem('SOFTWARE_STOP_INCOMPLETE', '停止尚未完成，原身份资料保持保全', 503);
      audit('signed-out', code, previousOwner); });
    session = null; licenseState = 'signed_out';
  }
  function commitSession(nextSession, grant, { newIdentity = false, credentialChanged = true, event = 'refreshed' } = {}) {
    if (rotationPending) throw problem('SOFTWARE_ROTATION_RECOVERY_PENDING', '待恢复刷新轮换尚未收敛，禁止覆盖当前软件凭据', 503);
    if (!grant || !Number.isSafeInteger(grant.hardDeadlineMs) || !Number.isSafeInteger(grant.serverTimeMs))
      throw problem('SOFTWARE_LICENSE_INCOMPLETE', '授权提交必须保留完整license grant', 502);
    const encrypted = encoded(nextSession), nextOwner = ownerFor(nextSession.user.id);
    const expectedEpoch = row.identity_epoch, expectedRevision = row.credential_revision;
    try { transaction(() => {
      run('INSERT OR IGNORE INTO backend_software_owners VALUES(?,?,?,?,?)', nextOwner, cloudRef, nextSession.user.id, nextSession.user.username, nowIso());
      const changedRows = run('UPDATE backend_software_state SET identity_epoch=identity_epoch+?,credential_revision=credential_revision+?,session_cipher=?,pending_auth_cipher=NULL,state=?,last_code=NULL,updated_at=? WHERE cloud_ref=? AND identity_epoch=? AND credential_revision=? AND stop_pending=0 AND cloud_logout_pending=0',
        newIdentity ? 1 : 0, credentialChanged ? 1 : 0, encrypted, 'granted', nowIso(), cloudRef, expectedEpoch, expectedRevision).changes;
      if (changedRows !== 1) throw problem('SOFTWARE_AUTH_STALE', '软件凭据提交CAS失败，身份原记录保留');
      changed();
      if (row.stop_pending) throw problem('SOFTWARE_STOP_INCOMPLETE', '前一个身份的停止尚未闭合', 503);
      audit(event, 'SOFTWARE_AUTH_CONFIRMED', nextOwner);
    }); } catch (error) { liveGrant = null; licenseState = 'unverified'; clearDeadline(); throw error; }
    session = nextSession;
    licenseState = 'granted'; liveGrant = { ...grant, checkedAt: nowIso() }; scheduleDeadline();
  }
  function savePendingAuthorization(nextSession, grant, captured, { credentialChanged = true, newIdentity = false, event = 'refreshed' } = {}) {
    if (!current(captured) || ownerFor(nextSession.user.id) !== captured.ownerRef) throw problem('SOFTWARE_AUTH_STALE', '待授权资料与当前软件身份不匹配');
    const value = { version: 'software-pending-auth/v1', ownerRef: captured.ownerRef, identityEpoch: captured.identityEpoch,
      credentialRevision: captured.credentialRevision, credentialChanged, newIdentity, event, session: nextSession,
      grant: { grantServerMs: grant.grantServerMs, serverTimeMs: grant.serverTimeMs, hardDeadlineMs: grant.hardDeadlineMs,
      renewAfterMs: grant.renewAfterMs, remainingMs: grant.remainingMs, renewRemainingMs: grant.renewRemainingMs,
        receivedMono: grant.receivedMono }, processInstanceRef };
    const encrypted = encoded(value);
    transaction(() => {
      const changedRows = run(`UPDATE backend_software_state SET pending_auth_cipher=?,updated_at=? WHERE cloud_ref=?
        AND identity_epoch=? AND credential_revision=? AND stop_pending=0`, encrypted, nowIso(), cloudRef,
      captured.identityEpoch, captured.credentialRevision).changes;
      if (changedRows !== 1) throw problem('SOFTWARE_AUTH_STALE', '身份或停止意愿改变，待授权资料没有替换当前会话');
      changed(); audit('authorization-pending', 'SOFTWARE_AUTH_PENDING_CLEANUP', captured.ownerRef);
    });
  }
  async function resumePendingAuthorization(captured = context()) {
    const pendingValue = pendingAuth;
    if (!pendingValue) return false;
    if (!current(captured) || pendingValue.ownerRef !== captured.ownerRef || pendingValue.identityEpoch !== captured.identityEpoch ||
        pendingValue.credentialRevision !== captured.credentialRevision || ownerFor(pendingValue.session.user.id) !== captured.ownerRef) {
      throw problem('SOFTWARE_AUTH_STALE', '待授权资料与当前软件身份或凭据代际不匹配');
    }
    await confirmSuspensionBeforeResume(captured);
    if (!current(captured) || !pendingAuth || canonical(pendingAuth) !== canonical(pendingValue)) throw problem('SOFTWARE_AUTH_STALE', '待授权期间软件身份已经变化');
    const sameProcess = pendingValue.processInstanceRef === processInstanceRef && Number.isFinite(pendingValue.grant.receivedMono);
    const elapsed = sameProcess ? Math.max(0, mono() - pendingValue.grant.receivedMono) : Number.POSITIVE_INFINITY;
    const remainingMs = Math.max(0, pendingValue.grant.remainingMs - elapsed);
    if (!sameProcess || remainingMs <= 0) {
      // A pending grant is evidence only within the process that received it.
      // Across a restart (or after its monotonic deadline), preserve the newly
      // rotated encrypted session, then obtain a fresh cloud license decision.
      const encrypted = encoded(pendingValue.session);
      transaction(() => {
        const changedRows = run(`UPDATE backend_software_state SET session_cipher=?,pending_auth_cipher=NULL,state='unverified',
          last_code='SOFTWARE_AUTH_RECHECK_REQUIRED',credential_revision=credential_revision+1,updated_at=? WHERE cloud_ref=?
          AND identity_epoch=? AND credential_revision=? AND stop_pending=0`, encrypted, nowIso(), cloudRef,
        captured.identityEpoch, captured.credentialRevision).changes;
        if (changedRows !== 1) throw problem('SOFTWARE_AUTH_STALE', '新软件凭据未能安全写入当前身份');
        changed(); audit('authorization-credentials-preserved', 'SOFTWARE_AUTH_RECHECK_REQUIRED', captured.ownerRef);
      });
      session = pendingValue.session;
      liveGrant = null; licenseState = 'unverified'; clearDeadline();
      return false;
    }
    const grant = { ...pendingValue.grant, receivedMono: mono(), remainingMs,
      renewRemainingMs: Math.max(0, pendingValue.grant.renewRemainingMs - elapsed) };
    commitSession(pendingValue.session, grant, { credentialChanged: pendingValue.credentialChanged,
      newIdentity: pendingValue.newIdentity, event: 'pending-' + pendingValue.event });
    notifyAuthorizedForCapturedOwner(captured);
    return true;
  }
  function notifyAuthorizedForCapturedOwner(captured) {
    const authorized = context();
    if (authorized.ownerRef !== captured.ownerRef || authorized.identityEpoch !== captured.identityEpoch ||
        !session || !liveGrant || !status().authorized || row.stop_pending) return false;
    try { onAuthorized({ ownerRef: authorized.ownerRef, identityEpoch: authorized.identityEpoch,
      credentialRevision: authorized.credentialRevision }); } catch { /* Durable bootstrap polling retries projection. */ }
    return true;
  }
  function disabled(error) { return error?.code === 'SOFTWARE_DISABLED'; }
  function loss(error) { return disabled(error) || REVOKED_CODES.has(error?.code); }
  function transient(error) { return Number(error?.status || 0) === 0 || Number(error?.status) >= 500 || Number(error?.status) === 429; }
  async function handleFailure(error, captured) {
    if (!current(captured)) return;
    if (disabled(error)) await suspendForAuthorizationWait('SOFTWARE_DISABLED', { state: 'disabled' });
    else if (loss(error)) await suspendForAuthorizationWait('SOFTWARE_CREDENTIALS_REAUTH_REQUIRED', { state: 'reauth_required' });
    else if (error?.code === 'SOFTWARE_AUTH_IDENTITY_MISMATCH') await suspendForAuthorizationWait('SOFTWARE_OWNER_CONFLICT', { state: 'ownership_conflict' });
    else if (grantState() === 'grace_expired') await suspendForAuthorizationWait('SOFTWARE_GRACE_EXPIRED');
  }
  function persistRotationIntent(captured) {
    const expectedEpoch = captured.identityEpoch, expectedRevision = captured.credentialRevision;
    if (rotationPending) {
      if (rotationPending.ownerRef !== captured.ownerRef || rotationPending.userId !== captured.userId
        || rotationPending.installId !== captured.installId || rotationPending.identityEpoch !== expectedEpoch
        || rotationPending.credentialRevision !== expectedRevision || rotationPending.oldRefreshToken !== session?.refreshToken)
        throw problem('SOFTWARE_ROTATION_RECOVERY_PENDING', '待恢复轮换与当前身份或凭据代际不一致', 409);
      return rotationPending;
    }
    const value = { version: 'software-refresh-rotation/v1', phase: 'awaiting_refresh', rotationId: crypto.randomUUID(),
      ownerRef: captured.ownerRef, userId: captured.userId, installId: captured.installId,
      identityEpoch: expectedEpoch, credentialRevision: expectedRevision, oldRefreshToken: session.refreshToken, createdAt: nowIso() };
    transaction(() => {
      const n = run(`UPDATE backend_software_state SET rotation_pending_cipher=?,updated_at=?
        WHERE cloud_ref=? AND identity_epoch=? AND credential_revision=? AND install_id=? AND stop_pending=0`,
      encoded(value), nowIso(), cloudRef, expectedEpoch, expectedRevision, captured.installId).changes;
      if (n !== 1) throw problem('SOFTWARE_AUTH_STALE', '身份或凭据代际变化，未发送刷新请求');
      changed(); audit('rotation-intent-persisted', 'SOFTWARE_ROTATION_PENDING', captured.ownerRef);
    });
    return rotationPending;
  }
  function validateRotatedPair(payload, captured) {
    const user = userOf(payload?.user);
    if (user.id !== captured.userId) throw problem('SOFTWARE_AUTH_IDENTITY_MISMATCH', '刷新回执不属于当前软件用户', 502);
    if (!isToken(payload?.accessToken) || !isToken(payload?.refreshToken) || !isTimestamp(payload?.accessExpiresAt)
      || !isTimestamp(payload?.refreshExpiresAt) || !Number.isSafeInteger(payload?.serverTimeMs) || payload.serverTimeMs <= 0
      || Date.parse(payload.refreshExpiresAt) <= payload.serverTimeMs) throw problem('SOFTWARE_AUTH_INCOMPLETE', '刷新回执缺少有效凭据', 502);
    return { user, session: { user, accessToken: payload.accessToken, refreshToken: payload.refreshToken,
      accessExpiresAt: payload.accessExpiresAt, refreshExpiresAt: payload.refreshExpiresAt } };
  }
  function commitRotatedPair(nextSession, captured, intent, preserveForRetirement = false) {
    const expectedEpoch = intent.identityEpoch, expectedRevision = intent.credentialRevision;
    if (!current(captured) || captured.userId !== intent.userId || captured.ownerRef !== intent.ownerRef
      || captured.installId !== intent.installId || row.identity_epoch !== expectedEpoch || row.credential_revision !== expectedRevision
      || ownerFor(nextSession.user.id) !== intent.ownerRef || row.stop_pending === 1 || row.state === 'signed_out')
      throw problem('SOFTWARE_AUTH_STALE', '刷新凭据跨越身份/停止代际，原意图保留');
    const nextIntent = preserveForRetirement ? { ...intent, phase: 'pair_committed_pending_retire',
      postCommitCredentialRevision: expectedRevision + 1 } : null;
    const expectedIntentCipher = row.rotation_pending_cipher;
    if (!expectedIntentCipher || rotationPending?.rotationId !== intent.rotationId)
      throw problem('SOFTWARE_ROTATION_RECOVERY_PENDING', '当前持久轮换意图与响应不一致');
    transaction(() => {
      const n = run(`UPDATE backend_software_state SET session_cipher=?,rotation_pending_cipher=?,
        credential_revision=credential_revision+1,state='unverified',last_code='SOFTWARE_AUTH_RECHECK_REQUIRED',updated_at=?
        WHERE cloud_ref=? AND identity_epoch=? AND credential_revision=? AND install_id=? AND rotation_pending_cipher=? AND stop_pending=0`,
      encoded(nextSession), nextIntent ? encoded(nextIntent) : null, nowIso(), cloudRef, expectedEpoch, expectedRevision, intent.installId, expectedIntentCipher).changes;
      if (n !== 1) throw problem('SOFTWARE_AUTH_STALE', '刷新凭据CAS失败，原轮换意图保留');
      changed(); audit('rotation-credentials-preserved', 'SOFTWARE_AUTH_RECHECK_REQUIRED', intent.ownerRef);
    });
    session = nextSession; liveGrant = null; licenseState = nextSession.user.enabled ? 'unverified' : 'disabled'; clearDeadline();
    return context();
  }
  async function resolveRotationBeforeLogin() {
    if (pendingAuth) {
      const old = context(), resumed = await resumePendingAuthorization(old);
      if (!resumed || pendingAuth) throw problem('SOFTWARE_AUTH_PENDING', '待授权核验未完成，新登录暂停', 503);
    }
    const intent = rotationPending;
    if (!intent) return;
    const captured = context(), expectedEpoch = captured.identityEpoch, expectedRevision = captured.credentialRevision;
    if (row.stop_pending || row.cloud_logout_pending === 1 || intent.ownerRef !== captured.ownerRef || intent.userId !== captured.userId
      || intent.installId !== captured.installId || intent.identityEpoch !== expectedEpoch
      || (intent.phase === 'awaiting_refresh' && intent.credentialRevision !== expectedRevision)
      || (intent.phase === 'pair_committed_pending_retire' && intent.postCommitCredentialRevision !== expectedRevision))
      throw problem('SOFTWARE_ROTATION_RECOVERY_PENDING', '待回收轮换代际不匹配，新登录暂停', 503);
    // The reduction endpoint proves/retires either an unused exact refresh secret
    // or its matching unadvanced rotation receipt, including an already-revoked
    // session. Replaying refresh first would reject that session forever and
    // prevent an ordinary password login from reaching the cloud login endpoint.
    const post = captured, retiring = intent, retiringCipher = row.rotation_pending_cipher;
    if (!retiringCipher || typeof api.refreshRecoveryRevoke !== 'function')
      throw problem('SOFTWARE_ROTATION_RECOVERY_PENDING', '旧令牌精确回收仍待处理');
    const suspension = await suspendForAuthorizationWait('SOFTWARE_CREDENTIALS_REAUTH_REQUIRED', { state: 'reauth_required' });
    if (suspension?.suspensionPending) throw problem('SOFTWARE_SUSPEND_PENDING', '旧owner清理尚未确认，原运行意愿保持待恢复');
    if (!current(post)) throw problem('SOFTWARE_AUTH_STALE', '旧owner清理期间身份已变化');
    const receipt = await api.refreshRecoveryRevoke({ refreshToken: retiring.oldRefreshToken,
      installId: retiring.installId, rotationId: retiring.rotationId });
    const supersededWithoutIssue = retiring.phase === 'awaiting_refresh'
      && receipt?.proofVersion === 'software-refresh-attempt-terminal/v1'
      && receipt.attemptSuperseded === true && receipt.attemptIssued === false && receipt.revoked === false
      && receipt.rotationId === retiring.rotationId && receipt.installId === retiring.installId && receipt.userId === retiring.userId;
    if (!current(post) || receipt?.ok !== true || (receipt?.revoked !== true && !supersededWithoutIssue))
      throw problem('SOFTWARE_ROTATION_RECOVERY_PENDING', '旧令牌未取得精确回收回执');
    transaction(() => {
      const n = run('UPDATE backend_software_state SET rotation_pending_cipher=NULL,state=?,credential_revision=credential_revision+1,last_code=?,updated_at=? WHERE cloud_ref=? AND identity_epoch=? AND credential_revision=? AND install_id=? AND rotation_pending_cipher=? AND stop_pending=0',
        'reauth_required', 'SOFTWARE_CREDENTIALS_REAUTH_REQUIRED', nowIso(), cloudRef,
        post.identityEpoch, post.credentialRevision, post.installId, retiringCipher).changes;
      if (n !== 1) throw problem('SOFTWARE_AUTH_STALE', '旧令牌回收回执已过期，原owner资料保留');
      changed(); audit(supersededWithoutIssue ? 'rotation-attempt-superseded' : 'rotation-recovered-before-login',
        supersededWithoutIssue ? 'SOFTWARE_ROTATION_SUPERSEDED_WITHOUT_ISSUE' : 'SOFTWARE_ROTATION_RECOVERED', retiring.ownerRef);
    });
    // Keep prior owner and execution intent so ordinary login can distinguish
    // same-owner renewal from a real owner change.
    rotationPending = null; pendingAuth = null; liveGrant = null; licenseState = 'reauth_required';
  }

  async function refresh() {
    if (refreshFlight) return refreshFlight;
    assertOpen();
    const flight = (async () => {
      if (rotationPending?.phase === 'pair_committed_pending_retire') {
        await resolveRotationBeforeLogin();
        throw problem('SOFTWARE_LOGIN_REQUIRED', '旧轮换已安全回收，请重新登录软件账号', 401);
      }
      if (row.cloud_logout_pending === 1) throw problem('SOFTWARE_LOGOUT_RECOVERY_PENDING', '旧云会话回收尚未确认，暂不能替换身份', 503);
      if (!session || row.state === 'signed_out') throw problem('SOFTWARE_LOGIN_REQUIRED', '请先登录软件账号', 401);
      if (pendingAuth) {
        const captured = context(), resumed = await resumePendingAuthorization(captured);
        if (resumed) return status();
        setTimeout(() => { void checkLicense().catch(error => log('软件待授权核对未完成', safeCode(error))); }, 0).unref?.();
        return status();
      }
      if (row.stop_pending) await finishStop();
      const captured = context(), expectedEpoch = captured.identityEpoch, expectedRevision = captured.credentialRevision;
      await confirmSuspensionBeforeResume(captured);
      if (!current(captured) || row.stop_pending || row.state === 'signed_out') throw problem('SOFTWARE_AUTH_STALE', '续期前身份或停止状态已变化');
      const intent = persistRotationIntent(captured), started = mono();
      let postCommit = null;
      try {
        const payload = await api.refresh({ refreshToken: intent.oldRefreshToken, installId: intent.installId, rotationId: intent.rotationId });
        if (!current(captured) || row.identity_epoch !== expectedEpoch || row.credential_revision !== expectedRevision
          || row.install_id !== intent.installId || rotationPending?.rotationId !== intent.rotationId)
          throw problem('SOFTWARE_AUTH_STALE', '迟到刷新响应跨越身份/凭据代际');
        const confirmed = validateRotatedPair(payload, captured);
        postCommit = commitRotatedPair(confirmed.session, captured, intent);
        if (!confirmed.user.enabled) { await suspendForAuthorizationWait('SOFTWARE_DISABLED', { state: 'disabled' }); return status(); }
        if (Date.parse(confirmed.session.accessExpiresAt) <= payload.serverTimeMs) {
          await suspendForAuthorizationWait('SOFTWARE_AUTH_RECHECK_REQUIRED');
          setTimeout(() => { void refresh().catch(error => log('软件凭据恢复续期未完成', safeCode(error))); }, 0).unref?.();
          return status();
        }
        const grant = completeGrant(payload, started, mono());
        savePendingAuthorization(confirmed.session, grant, postCommit,
          { credentialChanged: false, newIdentity: false, event: 'refresh-confirmed' });
        await resumePendingAuthorization(postCommit);
        return status();
      } catch (error) {
        const failureContext = postCommit || captured;
        if (current(failureContext)) {
          if (error?.code === 'SOFTWARE_AUTH_IDENTITY_MISMATCH') await suspendForAuthorizationWait('SOFTWARE_OWNER_CONFLICT', { state: 'ownership_conflict' });
          else if (['SOFTWARE_AUTH_INCOMPLETE','SOFTWARE_LICENSE_INCOMPLETE','SOFTWARE_GRANT_EXPIRED'].includes(error?.code))
            await suspendForAuthorizationWait('SOFTWARE_AUTH_RECHECK_REQUIRED');
          else await handleFailure(error, failureContext);
        }
        throw error;
      }
    })().finally(() => { if (refreshFlight === flight) refreshFlight = null; });
    refreshFlight = flight; return flight;
  }

  async function checkLicense() {
    if (licenseFlight) return licenseFlight;
    if (refreshFlight) return refreshFlight;
    if (!session || closed || row.state === 'signed_out') return status();
    if (row.state === 'reauth_required' || row.state === 'ownership_conflict') return status();
    if (pendingAuth) return resumePendingAuthorization(context()).then(resumed => resumed ? status() : checkLicense());
    if (!liveGrant && licenseState !== 'disabled' && row.last_code !== 'SOFTWARE_AUTH_RECHECK_REQUIRED') return refresh();
    const flight = (async () => {
      await finishStop();
      if (!session || closed) return status();
      const captured = context(), accessToken = session.accessToken, started = mono();
      try {
        const payload = await api.license({ accessToken });
        if (!current(captured)) return status();
        if (payload?.enabled === false || payload?.state === 'disabled') {
          await suspendForAuthorizationWait('SOFTWARE_DISABLED', { state: 'disabled' }); return status();
        }
        const user = userOf(payload?.user);
        if (user.id !== session.user.id) throw problem('SOFTWARE_AUTH_IDENTITY_MISMATCH', '授权回执不属于当前软件身份', 502);
        if (user.enabled === false) {
          await suspendForAuthorizationWait('SOFTWARE_DISABLED', { state: 'disabled' }); return status();
        }
        if (payload.enabled !== true) throw problem('SOFTWARE_LICENSE_INCOMPLETE', '授权资格字段缺失', 502);
        const grant = completeGrant(payload, started, mono());
        savePendingAuthorization({ ...session, user }, grant, captured, { credentialChanged: false, event: 'license-confirmed' });
        await resumePendingAuthorization(captured);
        return status();
      } catch (error) {
        if (!current(captured)) return status();
        if (Number(error.status) === 401 && error.code === 'SESSION_EXPIRED') return refresh();
        await handleFailure(error, captured);
        throw error;
      }
    })().finally(() => { if (licenseFlight === flight) licenseFlight = null; });
    licenseFlight = flight; return flight;
  }
  async function login(input) {
    assertOpen();
    if (row.cloud_logout_pending === 1) throw problem('SOFTWARE_LOGOUT_RECOVERY_PENDING', '旧云会话回收尚未确认，暂不能登录新身份', 503);
    if (authBusy) throw problem('SOFTWARE_AUTH_BUSY', '已有身份操作正在处理，请稍后再试');
    const username = usernameOf(input?.username), password = passwordOf(input?.password);
    authBusy = true;
    try {
      await finishStop();
      await resolveRotationBeforeLogin();
      const captured = context(), started = mono();
      const payload = await api.login({ username, password, installId: row.install_id });
      if (!current(captured)) throw problem('SOFTWARE_AUTH_STALE', '软件身份已变化，迟到的登录结果已丢弃');
      const confirmed = authPayload(payload, username, null, started);
      const before = ownerRef();
      const nextOwner = ownerFor(confirmed.session.user.id), sameOwner = before === nextOwner;
      if (session && !sameOwner) await revoke('SOFTWARE_IDENTITY_REBOUND', { state: 'unverified' });
      else {
        await finishStop();
      }
      const expectedEpoch = captured.identityEpoch + (before && !sameOwner ? 1 : 0);
      if (closed || row.identity_epoch !== expectedEpoch || ownerRef() !== before) throw problem('SOFTWARE_AUTH_STALE', '登录期间身份已经变化');
      if (sameOwner) {
        savePendingAuthorization(confirmed.session, confirmed.grant, captured, { event: 'login-confirmed' });
        await resumePendingAuthorization(captured);
        log('软件账号登录成功，游戏任务保持原运行意愿', 'SOFTWARE_AUTH_CONFIRMED');
        return { ok: true, status: status(), autoStarted: false, requiresEngineRestart: status().requiresEngineRestart };
      }
      commitSession(confirmed.session, confirmed.grant, { newIdentity: !sameOwner, event: 'login-confirmed' });
      log('软件账号登录成功，游戏任务保持原停止意图', 'SOFTWARE_AUTH_CONFIRMED');
      return { ok: true, status: status(), autoStarted: false, requiresEngineRestart: status().requiresEngineRestart };
    } finally { authBusy = false; }
  }
  async function register(input) {
    assertOpen();
    const username = usernameOf(input?.username), password = passwordOf(input?.password);
    if (username === password) throw problem('INPUT_INVALID', '软件密码不能与账号相同', 400);
    if (authBusy) throw problem('SOFTWARE_AUTH_BUSY', '已有身份操作正在处理，请稍后再试');
    authBusy = true;
    try {
      const result = await api.register({ username, password });
      let user;
      try { user = userOf(result?.user); if (user.username !== username) throw new Error('Identity mismatch'); }
      catch { throw problem('SOFTWARE_REGISTER_UNCONFIRMED', '注册身份确认不完整，可能已注册，请先正常登录核对', 502); }
      return { ok: true, registrationConfirmed: true, user, status: status() };
    } finally { authBusy = false; }
  }
  let logoutRecoveryFlight = null;
  async function recoverLogoutCloud() {
    if (logoutRecoveryFlight) return logoutRecoveryFlight;
    if (row.cloud_logout_pending !== 1 || !logoutPending) return { ok: true, revoked: true };
    const expectedCipher = row.logout_pending_cipher;
    const expectedEpoch = row.identity_epoch;
    const expectedInstallId = row.install_id || '';
    const retirementAtStart = logoutPending;
    const flight = (async () => {
      if (refreshFlight) { try { await refreshFlight; } catch { /* durable exact intent is replayed below */ } }
      const retirement = retirementAtStart;
      if (row.cloud_logout_pending !== 1 || row.logout_pending_cipher !== expectedCipher || row.identity_epoch !== expectedEpoch
        || (row.install_id || '') !== expectedInstallId || !retirement || typeof api.refreshRecoveryRevoke !== 'function')
        throw problem('SOFTWARE_LOGOUT_RECOVERY_PENDING', '精确云回收材料尚不可用');
      // Re-send the exact encrypted intent. A lost refresh response replays its
      // exact pair; pair tokens are never installed in the locally signed-out state.
      let result = null;
      // Try the narrow receipt cleanup first. This remains valid when the exact
      // generation is already revoked, disabled, or expired; it never restores it.
      try {
        const receipt = await api.refreshRecoveryRevoke({ refreshToken: retirement.oldRefreshToken,
          installId: retirement.installId, rotationId: retirement.rotationId });
        if (receipt?.ok === true && receipt?.revoked === true) result = receipt;
      } catch { /* a not-yet-consumed intent has no receipt; exact rotation follows */ }
      if (!result) {
        const refreshed = await api.refresh({ refreshToken: retirement.oldRefreshToken,
          installId: retirement.installId, rotationId: retirement.rotationId });
        const stableUser = userOf(refreshed?.user);
        if (stableUser.id !== retirement.userId || !isToken(refreshed?.accessToken) || !isToken(refreshed?.refreshToken))
          throw problem('SOFTWARE_LOGOUT_RECOVERY_PENDING', '回收重放没有返回同一软件主体的有效receipt');
        result = await api.refreshRecoveryRevoke({ refreshToken: retirement.oldRefreshToken,
          installId: retirement.installId, rotationId: retirement.rotationId });
      }
      if (result?.ok !== true || result?.revoked !== true)
        throw problem('SOFTWARE_LOGOUT_RECOVERY_PENDING', '旧云会话尚未取得回收确认');
      transaction(() => {
        const n = run("UPDATE backend_software_state SET session_cipher=NULL,pending_auth_cipher=NULL,rotation_pending_cipher=NULL,logout_pending_cipher=NULL,cloud_logout_pending=0,state='signed_out',updated_at=? WHERE cloud_ref=? AND cloud_logout_pending=1 AND logout_pending_cipher=? AND identity_epoch=? AND install_id=? AND stop_pending=0",
          nowIso(), cloudRef, expectedCipher, expectedEpoch, expectedInstallId).changes;
        if (n !== 1) throw problem('SOFTWARE_AUTH_STALE', '云回收回执对应旧注销代际，原本地保护继续保留');
        changed(); audit('cloud-logout-confirmed', 'SOFTWARE_LOGGED_OUT', retirement.ownerRef);
      });
      session = null; pendingAuth = null; rotationPending = null; logoutPending = null;
      liveGrant = null; licenseState = 'signed_out';
      return { ok: true, revoked: true, alreadyRevoked: result.alreadyRevoked === true };
    })().finally(() => { if (logoutRecoveryFlight === flight) logoutRecoveryFlight = null; });
    logoutRecoveryFlight = flight;
    return flight;
  }
  async function logout() {
    assertOpen();
    if (row.stop_pending) await finishStop();
    if (row.cloud_logout_pending === 1) {
      if (row.stop_pending) await finishStop();
      session = null; liveGrant = null; licenseState = 'signed_out';
      void recoverLogoutCloud().catch(error => log('云端注销回收仍待重试', safeCode(error)));
      return { ok: true, localSignedOut: true, cloudRevoked: false, status: status(), requiresEngineRestart: true };
    }
    const previousOwner = ownerRef(), captured = context();
    if (session && !rotationPending) persistRotationIntent(captured);
    const retirement = rotationPending;
    if (session && (!retirement || retirement.ownerRef !== previousOwner || retirement.userId !== captured.userId
      || retirement.installId !== captured.installId || retirement.identityEpoch !== captured.identityEpoch))
      throw problem('SOFTWARE_LOGOUT_RECOVERY_PENDING', '退出所需的精确旧会话回收材料无法绑定当前身份');
    const logoutValue = retirement ? { ...retirement, logoutOwnerRef: previousOwner,
      logoutIdentityEpoch: row.identity_epoch + 1, logoutStartedAt: nowIso() } : null;
    transaction(() => {
      const n = run("UPDATE backend_software_state SET identity_epoch=identity_epoch+1,revoke_epoch=revoke_epoch+1,state='signed_out',stop_pending=1,cloud_logout_pending=?,logout_pending_cipher=?,last_code='SOFTWARE_LOGGED_OUT',updated_at=? WHERE cloud_ref=? AND identity_epoch=? AND credential_revision=? AND stop_pending=0 AND cloud_logout_pending=0",
        logoutValue ? 1 : 0, logoutValue ? encoded(logoutValue) : null, nowIso(), cloudRef, captured.identityEpoch, captured.credentialRevision).changes;
      if (n !== 1) throw problem('SOFTWARE_AUTH_STALE', '退出身份CAS失败，保留当前本地会话');
      changed(); audit('logout-started', 'SOFTWARE_LOGGED_OUT', previousOwner);
    });
    liveGrant = null; licenseState = 'signed_out'; clearDeadline();
    await finishStop(); // physical local drain is required; network cleanup is not.
    session = null;
    if (logoutValue) {
      void recoverLogoutCloud().catch(error => log('云端注销回收仍待重试，密文凭据已保留', safeCode(error)));
      return { ok: true, localSignedOut: true, cloudRevoked: false, status: status(), requiresEngineRestart: true };
    }
    return { ok: true, localSignedOut: true, cloudRevoked: true, status: status(), requiresEngineRestart: true };
  }

  async function changePassword(input) {
    assertOpen();
    if (!session) throw problem('SOFTWARE_LOGIN_REQUIRED', '请先登录软件账号', 401);
    if (authBusy) throw problem('SOFTWARE_AUTH_BUSY', '已有身份操作正在处理，请稍后再试');
    authBusy = true;
    const captured = context(), accessToken = session.accessToken;
    try {
      const result = await api.changePassword({ accessToken, currentPassword: passwordOf(input?.currentPassword), newPassword: passwordOf(input?.newPassword) });
      if (!current(captured)) throw problem('SOFTWARE_AUTH_STALE', '软件身份已变化，旧改密回执没有应用到新身份');
      if (result?.ok !== true || result?.revoked !== true) throw problem('SOFTWARE_PASSWORD_UNCONFIRMED', '改密缺少会话撤销确认，请正常登录核对', 502);
      await revoke('SOFTWARE_PASSWORD_CHANGED', { state: 'signed_out', clear: true });
      return { ok: true, revoked: true, status: status(), requiresEngineRestart: true };
    } catch (error) {
      if (current(captured) && (error.code === 'SOFTWARE_PASSWORD_UNCONFIRMED' || transient(error))) {
        await suspendForAuthorizationWait('SOFTWARE_PASSWORD_UNCONFIRMED');
      } else if (error.code !== 'SOFTWARE_LOGIN_FAILED') await handleFailure(error, captured);
      throw error;
    } finally { authBusy = false; }
  }
  function schedulePoll(delay = POLL_MS) {
    if (closed || pollTimer) return;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      const started = mono();
      try {
        if (row.stop_pending) await finishStop();
        if (row.cloud_logout_pending === 1) { session = null; liveGrant = null; licenseState = 'signed_out'; await recoverLogoutCloud(); }
        else if (session && row.state === 'signed_out') clearSavedSession(row.last_code || 'SOFTWARE_LOGGED_OUT');
        else if (session) await checkLicense();
      }
      catch (error) { log(transient(error) ? '云授权本次暂未核实，按现有有效期限处理' : '云授权核对未完成', safeCode(error)); }
      finally { schedulePoll(Math.max(1, POLL_MS - (mono() - started))); }
    }, delay);
    pollTimer.unref?.();
  }
  async function initialize() {
    if (initialized) return status();
    initialized = true;
    try {
      await finishStop();
      if (row.cloud_logout_pending === 1) {
        session = null; pendingAuth = null; rotationPending = null; liveGrant = null; licenseState = 'signed_out';
        void recoverLogoutCloud().catch(error => log('云端注销回收仍待重试', safeCode(error)));
      } else if (session && row.state === 'signed_out') clearSavedSession(row.last_code || 'SOFTWARE_LOGGED_OUT');
      else if (session) {
        if (pendingAuth) {
          const resumed = await resumePendingAuthorization(context());
          if (!resumed && session) await checkLicense();
        }
        else if (licenseState === 'disabled' || licenseState === 'reauth_required' || row.last_code === 'SOFTWARE_AUTH_RECHECK_REQUIRED') await checkLicense();
        else await refresh();
      }
    }
    catch (error) { log('软件身份恢复尚未核实，游戏业务准入保持受限', safeCode(error)); }
    finally { schedulePoll(); }
    return status();
  }
  function authorize(input = {}) {
    if (closed || !initialized) throw problem('SOFTWARE_NOT_READY', '软件身份尚未就绪', 503);
    const snapshot = status();
    if (input.ownerRef && input.ownerRef !== ownerRef()) throw problem('SOFTWARE_OWNER_CHANGED', '游戏资料归属与当前软件身份不一致', 403);
    if (snapshot.requiresEngineRestart) throw problem('SOFTWARE_ENGINE_REBIND_REQUIRED', '软件身份已切换，等待本机执行器正常重绑', 409);
    if (!snapshot.authorized) throw problem('SOFTWARE_WRITE_REQUIRED', '软件授权尚未核实或已到期，请先正常联网核对', 403);
    return true;
  }
  async function sendLogsForOwner({ ownerRef: expectedOwner, identityEpoch, installId, events }) {
    assertOpen();
    authorize({ ownerRef: expectedOwner });
    if (identityEpoch !== row.identity_epoch || installId !== row.install_id) throw problem('SOFTWARE_LOG_IDENTITY_CHANGED', '日志上传身份已变化，原队列保留');
    const captured = context();
    try {
      const receipt = await api.sendLogs({ accessToken: session.accessToken, events });
      if (!current(captured)) throw problem('SOFTWARE_LOG_IDENTITY_CHANGED', '日志回执对应旧身份，原队列保留');
      return receipt;
    } catch (error) {
      if (current(captured) && (REVOKED_CODES.has(error.code) || error.code === 'SOFTWARE_DISABLED')) await handleFailure(error, captured);
      throw error;
    }
  }
  async function shutdown() {
    closed = true;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null; clearDeadline();
    if (stopFlight) await stopFlight;
  }
  const routes = { async handle(route, method, input) {
    if (route.startsWith('/software')) route = route.slice('/software'.length);
    if (route === '/status' && method === 'GET') return { status: 200, payload: status() };
    if (route === '/login' && method === 'POST') return { status: 200, payload: await login(input) };
    if (route === '/register' && method === 'POST') return { status: 201, payload: await register(input) };
    if (route === '/logout' && method === 'POST') return { status: 200, payload: await logout() };
    if (route === '/password' && method === 'POST') return { status: 200, payload: await changePassword(input) };
    if (route === '/license' && ['POST', 'GET'].includes(method)) return { status: 200, payload: { ok: true, status: await checkLicense() } };
    if (route === '/claim' && method === 'POST') {
      authorize();
      return { status: 200, payload: { ok: true, moved: 0, status: status(), requiresEngineRestart: false } };
    }
    if (route === '/logs' && method === 'POST') throw problem('SOFTWARE_LOG_SYNC_NOT_INTEGRATED', '新云日志同步尚未接入', 501);
    if (route === '/cloud-health' && method === 'GET') return { status: 200, payload: { ok: true, health: await api.health() } };
    return null;
  } };
  return Object.freeze({ initialize, status, statusPayload: status, ownerRef, owner: ownerRef, authorize, routes, shutdown,
    login, register, logout, changePassword, refresh, checkLicense, sendLogsForOwner, cloudRef, installId: row.install_id });
}
