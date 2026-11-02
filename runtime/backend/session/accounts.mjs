import crypto from 'node:crypto';
import { canonical, fingerprint, newId, parseStored, plainObject, problem, requireText } from '../common.mjs';

function identities(username) {
  const normalized = username.trim().normalize('NFKC').toLowerCase();
  const digest = (...parts) => crypto.createHash('sha256').update(parts.join('\0')).digest('hex');
  return { subjectRef: digest('official', normalized), basedAlias: digest('login-identity-digest', 'official', normalized) };
}

export function createAccountRepository({ store, cipher, config, supervisor, authorize, verifyAccount, projectRuntime, executionState = null,
  assertSubjectAvailable = () => {}, authorizeOwner = null, onRosterChange = () => {} }) {
  if (typeof assertSubjectAvailable !== 'function' || assertSubjectAvailable.constructor?.name === 'AsyncFunction') {
    throw new TypeError('Account subject availability assertion must be synchronous');
  }
  if (authorizeOwner !== null && (typeof authorizeOwner !== 'function' || authorizeOwner.constructor?.name === 'AsyncFunction')) {
    throw new TypeError('Official account identity authorization must be synchronous');
  }
  const { get, all, run, transaction, nowIso } = store;
  let rosterNotificationQueued = false;
  function notifyRosterChanged() {
    if (rosterNotificationQueued) return;
    rosterNotificationQueued = true;
    queueMicrotask(() => {
      rosterNotificationQueued = false;
      try { onRosterChange(); } catch { /* An observer cannot alter account changes. */ }
    });
  }
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_accounts(
    account_id INTEGER PRIMARY KEY AUTOINCREMENT,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    username_cipher TEXT,credential_cipher TEXT,profile_json TEXT NOT NULL,server_id INTEGER NOT NULL,
    source_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,removed_at TEXT,
    migration_key TEXT UNIQUE,verification_ref TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS backend_accounts_current_subject ON backend_accounts(owner_ref,subject_ref) WHERE removed_at IS NULL;
    CREATE TABLE IF NOT EXISTS backend_account_official_identities(
      identity_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
      server_id INTEGER NOT NULL CHECK(server_id>0),official_uid INTEGER NOT NULL CHECK(official_uid>0),
      evidence_ref TEXT NOT NULL,connection_epoch INTEGER NOT NULL CHECK(connection_epoch>0),
      identity_epoch INTEGER NOT NULL CHECK(identity_epoch>=0),inspection_id TEXT,source_method TEXT NOT NULL,
      profile_uid_before_json TEXT NOT NULL,recorded_at TEXT NOT NULL,UNIQUE(owner_ref,account_ref,evidence_ref));
    CREATE INDEX IF NOT EXISTS backend_account_official_identity_subject ON backend_account_official_identities(owner_ref,subject_ref,server_id);
    CREATE TRIGGER IF NOT EXISTS backend_account_official_identities_no_update BEFORE UPDATE ON backend_account_official_identities
      BEGIN SELECT RAISE(ABORT,'official identity evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_account_official_identities_no_delete BEFORE DELETE ON backend_account_official_identities
      BEGIN SELECT RAISE(ABORT,'official identity evidence is append only'); END;
    CREATE TABLE IF NOT EXISTS backend_official_subject_identities(
      owner_ref TEXT NOT NULL, subject_ref TEXT NOT NULL, subject_key TEXT NOT NULL, canonical_ref TEXT NOT NULL,
      primary_subject_ref TEXT NOT NULL, server_id INTEGER NOT NULL CHECK(server_id>0),
      official_uid INTEGER NOT NULL CHECK(official_uid>0), updated_at TEXT NOT NULL,
      PRIMARY KEY(owner_ref, subject_ref));
    CREATE INDEX IF NOT EXISTS backend_official_subject_identities_key ON backend_official_subject_identities(owner_ref, subject_key);`);
  const verifications = new Map();
  function row(ownerRef, accountRef, { includeRemoved = false } = {}) {
    const found = get('SELECT * FROM backend_accounts WHERE owner_ref=? AND account_id=?' + (includeRemoved ? '' : ' AND removed_at IS NULL'), ownerRef, Number(accountRef));
    if (!found) throw problem('ACCOUNT_NOT_FOUND', '找不到这个软件身份下的游戏号', 404);
    return found;
  }
  function stopIdentity(found) {
    const profile = parseStored(found.profile_json, '游戏号安全资料');
    if (!plainObject(profile)) throw problem('BACKEND_STORAGE_CORRUPT', '游戏号安全资料无法读取，原资料已保留', 500);
    const uid = profile.uid ?? null;
    if (uid !== null && (!Number.isSafeInteger(uid) || uid <= 0))
      throw problem('BACKEND_STORAGE_CORRUPT', '已保存的官服UID无效，原资料已保留', 500);
    return { id: found.account_id, ownerRef: found.owner_ref, accountRef: String(found.account_id),
      subjectRef: found.subject_ref, uid };
  }
  function persistentStopIdentity(ownerRef, accountRef) {
    return stopIdentity(row(ownerRef, accountRef));
  }
  function listPersistentStopIdentities(ownerRef) {
    return all('SELECT * FROM backend_accounts WHERE owner_ref=? AND removed_at IS NULL ORDER BY account_id', ownerRef)
      .map(stopIdentity);
  }
  function credentials(ownerRef, accountRef) {
    const found = row(ownerRef, accountRef);
    return { username: cipher.decrypt(found.username_cipher), password: cipher.decrypt(found.credential_cipher), serverId: found.server_id };
  }
  function recordOfficialIdentity({ ownerRef, accountRef, subjectRef, serverId, uid, evidenceRef, connectionEpoch,
    identityEpoch, inspectionId = null, sourceMethod = 'index.login' }) {
    requireText(ownerRef, 'ownerRef'); requireText(subjectRef, 'subjectRef'); requireText(evidenceRef, 'evidenceRef');
    requireText(sourceMethod, 'sourceMethod');
    accountRef = String(accountRef);
    if (!/^[1-9]\d*$/.test(accountRef) || !Number.isSafeInteger(Number(accountRef)) ||
        !Number.isSafeInteger(serverId) || serverId <= 0 || !Number.isSafeInteger(uid) || uid <= 0 ||
        !Number.isSafeInteger(connectionEpoch) || connectionEpoch <= 0 || !Number.isSafeInteger(identityEpoch) || identityEpoch < 0) {
      throw problem('OFFICIAL_IDENTITY_EVIDENCE_INVALID', '官服身份关联缺少实际主体、区服或连接代际', 400);
    }
    if (inspectionId !== null) requireText(inspectionId, 'inspectionId');
    if (!authorizeOwner) throw problem('OFFICIAL_IDENTITY_AUTH_REQUIRED', '官服身份关联尚未接入当前软件身份栅栏', 503);
    return transaction(() => {
      const authorization = authorizeOwner({ ownerRef, accountRef, subjectRef, expectedIdentityEpoch: identityEpoch,
        purpose: 'record-official-identity', connectionEpoch, inspectionId });
      if (authorization && typeof authorization.then === 'function') throw problem('OFFICIAL_IDENTITY_AUTH_MUST_BE_SYNC', '官服身份归属栅栏必须同步核实', 500);
      if (authorization === false || plainObject(authorization) && (authorization.authorized === false ||
          authorization.ownerRef !== undefined && authorization.ownerRef !== ownerRef ||
          authorization.identityEpoch !== undefined && authorization.identityEpoch !== identityEpoch)) {
        throw problem('OFFICIAL_IDENTITY_OWNER_CHANGED', '官服身份对应的软件归属或身份代际已变化', 403);
      }
      const found = row(ownerRef, accountRef);
      if (found.subject_ref !== subjectRef || found.server_id !== serverId) throw problem('OFFICIAL_IDENTITY_ACCOUNT_CHANGED', '实际官服主体或区服与当前资料绑定不一致');
      if (get('SELECT connection_epoch FROM backend_subject_connection_epochs WHERE subject_ref=?', subjectRef)?.connection_epoch !== connectionEpoch) {
        throw problem('OFFICIAL_IDENTITY_CONNECTION_REVOKED', '官服身份依据对应的连接代际已经变化');
      }
      const profile = parseStored(found.profile_json, '游戏号安全资料');
      if (!plainObject(profile)) throw problem('BACKEND_STORAGE_CORRUPT', '游戏号安全资料无法读取，原资料已保留', 500);
      const savedUid = Object.hasOwn(profile, 'uid') && profile.uid !== null ? profile.uid : null;
      if (savedUid !== null && (!Number.isSafeInteger(savedUid) || savedUid <= 0)) throw problem('OFFICIAL_IDENTITY_SAVED_UID_INVALID', '原官服身份值缺少有效依据，原资料已保留');
      if (savedUid !== null && savedUid !== uid || get(`SELECT 1 FROM backend_account_official_identities
          WHERE owner_ref=? AND subject_ref=? AND server_id=? AND official_uid<>? LIMIT 1`, ownerRef, subjectRef, serverId, uid)) {
        throw problem('OFFICIAL_SUBJECT_UID_MISMATCH', '官服实际UID与原主体身份依据不一致，未改写原资料');
      }
      const evidence = { ownerRef, accountRef, subjectRef, serverId, uid, evidenceRef, connectionEpoch, identityEpoch, inspectionId, sourceMethod };
      const identityRef = fingerprint(evidence);
      const previous = get('SELECT identity_ref FROM backend_account_official_identities WHERE owner_ref=? AND account_ref=? AND evidence_ref=?', ownerRef, accountRef, evidenceRef);
      if (previous && previous.identity_ref !== identityRef) throw problem('OFFICIAL_IDENTITY_EVIDENCE_CONFLICT', '同一官服身份回执不能关联另一份主体依据');
      if (!previous) run(`INSERT INTO backend_account_official_identities
        (identity_ref,owner_ref,account_ref,subject_ref,server_id,official_uid,evidence_ref,connection_epoch,identity_epoch,inspection_id,source_method,profile_uid_before_json,recorded_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, identityRef, ownerRef, accountRef, subjectRef, serverId, uid, evidenceRef,
      connectionEpoch, identityEpoch, inspectionId, sourceMethod, canonical(savedUid), nowIso());
      if (savedUid === null) {
        const changed = run(`UPDATE backend_accounts SET profile_json=?,updated_at=? WHERE owner_ref=? AND account_id=?
          AND subject_ref=? AND server_id=? AND profile_json=? AND removed_at IS NULL`, canonical({ ...profile, uid }), nowIso(),
        ownerRef, Number(accountRef), subjectRef, serverId, found.profile_json).changes;
        if (changed !== 1) throw problem('OFFICIAL_IDENTITY_ACCOUNT_CHANGED', '官服身份追加期间资料已变化');
      }
      // Canonical game identity is serverId + official UID, not the login
      // username. Legacy storage namespaces keep their subject_ref; this map
      // lets different usernames for the same real character be recognised as
      // one execution subject while every original record stays untouched.
      const subjectKey = serverId + ':' + uid;
      const existingKey = get(`SELECT * FROM backend_official_subject_identities WHERE subject_key=?
        ORDER BY rowid LIMIT 1`, subjectKey);
      const canonicalRef = existingKey?.canonical_ref || 'official-subject:' + fingerprint([ownerRef, serverId, uid]);
      const primarySubjectRef = existingKey?.primary_subject_ref || subjectRef;
      if (!existingKey) run(`INSERT INTO backend_official_subject_identities
        (owner_ref,subject_ref,subject_key,canonical_ref,primary_subject_ref,server_id,official_uid,updated_at)
        VALUES(?,?,?,?,?,?,?,?)`, ownerRef, subjectRef, subjectKey, canonicalRef, primarySubjectRef, serverId, uid, nowIso());
      else run(`INSERT INTO backend_official_subject_identities
        (owner_ref,subject_ref,subject_key,canonical_ref,primary_subject_ref,server_id,official_uid,updated_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref) DO UPDATE SET
        subject_key=excluded.subject_key,canonical_ref=excluded.canonical_ref,primary_subject_ref=excluded.primary_subject_ref,
        server_id=excluded.server_id,official_uid=excluded.official_uid,updated_at=excluded.updated_at`,
      ownerRef, subjectRef, subjectKey, canonicalRef, primarySubjectRef, serverId, uid, nowIso());
      return { ...evidence, identityRef, appended: !previous, profileBackfilled: savedUid === null,
        officialSubjectNormalization: 'server-uid-v1', canonicalRef, subjectKey, primarySubjectRef,
        aliasOfPrimary: subjectRef !== primarySubjectRef };
    });
  }
  function officialSubject({ ownerRef, subjectRef }) {
    return get('SELECT * FROM backend_official_subject_identities WHERE owner_ref=? AND subject_ref=?', ownerRef, subjectRef) || null;
  }
  // Two software entries that resolve to the same real character may never run
  // at the same time. Access ownership stays per subject_ref; only the unique
  // execution right is shared through the canonical server+UID key.
  function assertUniqueCanonicalExecution({ ownerRef, subjectRef }) {
    const identity = officialSubject({ ownerRef, subjectRef });
    if (!identity) return { enforced: false, reasonCode: 'OFFICIAL_SUBJECT_NOT_YET_OBSERVED' };
    const other = get(`SELECT o.subject_ref FROM backend_subject_owners o JOIN backend_official_subject_identities i
      ON i.owner_ref=o.owner_ref AND i.subject_ref=o.subject_ref
      WHERE o.owner_ref=? AND o.active=1 AND i.subject_key=? AND o.subject_ref<>? LIMIT 1`, ownerRef, identity.subject_key, subjectRef);
    if (other) throw problem('OFFICIAL_SUBJECT_ALREADY_RUNNING', '同一官服角色已由另一个登录别名执行，不能同时启动第二写者', 409,
      { canonicalRef: identity.canonical_ref, primarySubjectRef: identity.primary_subject_ref });
    return { enforced: true, canonicalRef: identity.canonical_ref, subjectKey: identity.subject_key,
      primarySubjectRef: identity.primary_subject_ref, aliasOfPrimary: subjectRef !== identity.primary_subject_ref };
  }
  function publicAccount(found) {
    const profile = parseStored(found.profile_json, '游戏号资料');
    const application = config.read({ ownerRef: found.owner_ref, accountRef: String(found.account_id) });
    const runtime = projectRuntime(found.owner_ref, String(found.account_id));
    const boundary = typeof executionState === 'function' ? executionState(found.owner_ref, String(found.account_id)) : null;
    const intent = get('SELECT run_epoch FROM backend_run_intents WHERE owner_ref=? AND account_ref=?', found.owner_ref, String(found.account_id));
    const officialSubjectRow = officialSubject({ ownerRef: found.owner_ref, subjectRef: found.subject_ref });
    return { id: found.account_id, ownerRef: found.owner_ref, accountRef: String(found.account_id), subjectRef: found.subject_ref,
      name: profile.remark || profile.nickname || '游戏号 ' + found.account_id,
      remark: profile.remark || '', nickname: profile.nickname || '', username: profile.maskedUsername || '',
      serverId: found.server_id, serverName: profile.serverName || '', uid: profile.uid ?? null, level: profile.level ?? null, water: profile.water ?? null,
      gold: profile.gold ?? null, executionBoundary: boundary ? { state: boundary.state, runEpoch: boundary.run_epoch,
        connectionEpoch: boundary.connection_epoch, reasonCode: boundary.reason_code, receiptRef: boundary.receipt_ref, recordedAt: boundary.recorded_at } : null,
      officialSubject: officialSubjectRow ? { subjectKey: officialSubjectRow.subject_key,
        canonicalRef: officialSubjectRow.canonical_ref, primarySubjectRef: officialSubjectRow.primary_subject_ref,
        aliasOfPrimary: found.subject_ref !== officialSubjectRow.primary_subject_ref } : null, running: runtime.desiredRunning && !['stopped', 'blocked'].includes(runtime.state),
      state: runtime.state, desiredRunning: runtime.desiredRunning, runEpoch: Number(intent?.run_epoch || 0),
      retryAt: runtime.retryAtMs === null ? null : new Date(runtime.retryAtMs).toISOString(),
      cooldown: runtime.cooldown ?? null,
      lastError: runtime.reasonCode || '', needsManualStart: !runtime.desiredRunning || runtime.state === 'blocked',
      config: application.config, application: { savedRevision: application.savedRevision, acceptedRevision: application.acceptedRevision,
        plannedRevision: application.plannedRevision, byFeature: application.byFeature, migrationIssues: application.migrationIssues } };
  }
  async function add({ ownerRef, username, password, serverId, remark = '', legacyDocument = null, source = null, signal,
    evidenceRef = null, aliases = [], migrationKey = null }) {
    authorize({ ownerRef }); requireText(username, '游戏登录名'); requireText(password, '游戏凭据');
    if (migrationKey) {
      const old = get('SELECT * FROM backend_accounts WHERE migration_key=?', migrationKey);
      if (old) {
        if (old.owner_ref !== ownerRef || old.removed_at) throw problem('MIGRATION_ACCOUNT_CONFLICT', '原迁移资料归属已变化');
        return { accountRef: String(old.account_id), subjectRef: old.subject_ref, evidenceRef: old.verification_ref,
          authenticationRef: old.verification_ref, account: publicAccount(old), started: false };
      }
    }
    const serverRequested = serverId !== undefined && serverId !== null;
    if (serverRequested && (!Number.isSafeInteger(serverId) || serverId <= 0)) throw problem('GAME_SERVER_ID_INVALID', '官服区服格式不正确', 400);
    if (typeof remark !== 'string' || remark.length > 80) throw problem('GAME_REMARK_INVALID', '备注格式不正确', 400);
    const identity = identities(username);
    if (get('SELECT account_id FROM backend_accounts WHERE owner_ref=? AND subject_ref=? AND removed_at IS NULL', ownerRef, identity.subjectRef)) {
      throw problem('GAME_ACCOUNT_ALREADY_ADDED', '这个游戏号已经添加');
    }
    if (verifications.has(identity.subjectRef)) throw problem('GAME_ACCOUNT_VERIFY_BUSY', '这个游戏号正在核对登录');
    const availability = assertSubjectAvailable({ ownerRef, subjectRef: identity.subjectRef, purpose: 'add-account' });
    if (availability && typeof availability.then === 'function') throw problem('ACCOUNT_SUBJECT_ASSERTION_MUST_BE_SYNC', '账号核对主体栅栏必须同步核实', 500);
    const verificationId = newId();
    const controller = new AbortController();
    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    const abort = () => controller.abort(signal.reason || problem('ACCOUNT_VERIFY_CANCELLED', '账号核对已取消'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    verifications.set(identity.subjectRef, { ownerRef, verificationId, controller, done });
    try {
      const verified = await verifyAccount({ ownerRef, subjectRef: identity.subjectRef, account: { username, password, serverId },
        signal: controller.signal, verificationId, source });
      controller.signal.throwIfAborted(); authorize({ ownerRef });
      if (verified?.verified !== true || !Number.isSafeInteger(verified.serverId) || verified.serverId <= 0 ||
          serverRequested && verified.serverId !== serverId || !verified.evidenceRef || !verified.authenticationRef ||
          verified.transportClosed !== true) throw problem('GAME_ACCOUNT_VERIFY_INCOMPLETE', '官服身份或核对连接关闭尚未确认，账号未保存');
      return transaction(() => {
        const profile = { nickname: verified.nickname || '', remark, serverName: verified.serverName || '', level: verified.level ?? null,
          maskedUsername: username.replace(/.(?=.{4})/g, '*'), water: verified.water ?? null, gold: verified.gold ?? null,
          ...(Number.isSafeInteger(verified.uid) && verified.uid > 0 ? { uid: verified.uid } : {}) };
        const now = nowIso();
        const receipt = run(`INSERT INTO backend_accounts(owner_ref,subject_ref,username_cipher,credential_cipher,profile_json,server_id,source_json,created_at,updated_at,migration_key,verification_ref)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`, ownerRef, identity.subjectRef, cipher.encrypt(username), cipher.encrypt(password), canonical(profile), verified.serverId,
          canonical(source || { kind: 'normal-official-add', authenticationRef: verified.authenticationRef }), now, now, migrationKey, verified.evidenceRef);
        const accountRef = String(receipt.lastInsertRowid);
        supervisor.bind({ ownerRef, accountRef, subjectRef: identity.subjectRef, basis: 'login-identity-digest', identityVersion: 'real-game-lock/nfkc-lower-sha256-v1',
          channel: 'official', evidence: { sourceRef: verified.evidenceRef, sourceVersion: 'backend-account-verification/v1',
            authenticationRef: verified.authenticationRef, officialSubjectNormalization: 'not-proven' },
          aliases: [{ aliasRef: identity.basedAlias, basis: 'login-identity-digest', identityVersion: 'feature-context/basis-prefixed-v1',
            evidence: { sourceRef: 'source:feature-context-and-realGameLockIdentity', sameNormalizedInputs: true } }, ...aliases] });
        let document = legacyDocument;
        if (document === null) {
          const removed = get('SELECT account_id FROM backend_accounts WHERE owner_ref=? AND subject_ref=? AND removed_at IS NOT NULL ORDER BY account_id DESC LIMIT 1', ownerRef, identity.subjectRef);
          document = removed ? config.readDocument({ ownerRef, accountRef: String(removed.account_id) }) : {};
        }
        config.migrate({ ownerRef, accountRef, subjectRef: identity.subjectRef, legacyDocument: document, evidenceRef: evidenceRef || verified.evidenceRef });
        notifyRosterChanged();
        return { accountRef, subjectRef: identity.subjectRef, evidenceRef: verified.evidenceRef, authenticationRef: verified.authenticationRef,
          account: publicAccount(row(ownerRef, accountRef)), started: false };
      });
    } finally {
      username = ''; password = '';
      signal?.removeEventListener('abort', abort);
      if (verifications.get(identity.subjectRef)?.verificationId === verificationId) verifications.delete(identity.subjectRef);
      resolveDone();
    }
  }
  function remove({ ownerRef, accountRef }) {
    const found = row(ownerRef, accountRef), state = projectRuntime(ownerRef, String(accountRef));
    if (state.state !== 'stopped' || state.desiredRunning || supervisor.context(found.subject_ref)) throw problem('ACCOUNT_STOP_REQUIRED', '请先确认这个游戏号已经停止');
    // Removal revokes credentials and the roster entry. All config, identities,
    // operations, legacy archives and unknown outcomes retain their old keys.
    run('UPDATE backend_accounts SET removed_at=?,updated_at=?,username_cipher=NULL,credential_cipher=NULL WHERE owner_ref=? AND account_id=? AND removed_at IS NULL',
      nowIso(), nowIso(), ownerRef, Number(accountRef));
    notifyRosterChanged();
    return { ok: true, archived: true, unknownEvidencePreserved: true };
  }
  async function cancelVerifications(ownerRef) {
    const selected = [...verifications.values()].filter(item => !ownerRef || item.ownerRef === ownerRef);
    for (const one of selected) one.controller.abort(problem('ACCOUNT_VERIFY_CANCELLED', '软件身份或停止意愿已撤销账号核对'));
    // Actual connection closure is owned by verifyAccount. The caller must not
    // report cleanup complete while these entries still exist.
    await Promise.allSettled(selected.map(one => one.done));
    return { pending: [...verifications.values()].filter(item => !ownerRef || item.ownerRef === ownerRef).length };
  }
  return Object.freeze({ row, credentials, add, remove, cancelVerifications, recordOfficialIdentity,
    officialSubject, assertUniqueCanonicalExecution,
    hasVerification: subjectRef => verifications.has(subjectRef), persistentStopIdentity, listPersistentStopIdentities,
    list: ownerRef => all('SELECT * FROM backend_accounts WHERE owner_ref=? AND removed_at IS NULL ORDER BY account_id', ownerRef).map(publicAccount),
    publicAccount: (ownerRef, accountRef) => publicAccount(row(ownerRef, accountRef)),
    verificationCount: ownerRef => [...verifications.values()].filter(item => !ownerRef || item.ownerRef === ownerRef).length });
}
