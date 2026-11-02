import { canonical, newId, parseStored, plainObject, problem, requireText } from '../common.mjs';
import { digestText, generateReceiverKeyPair, MIGRATION_PROTOCOL_VERSION, openMigrationPayload, publicKeyFingerprint,
  operationIdentityDigest, validateOffer, validateSourceDescriptor, verifySourceAttestation } from './crypto.mjs';

function encrypted(cipher, value) {
  const result = cipher.encrypt(value);
  if (typeof result !== 'string' || !result || result === value) throw new TypeError('Migration cipher must synchronously return protected ciphertext');
  return result;
}
function decrypted(cipher, value) {
  const result = cipher.decrypt(value);
  if (typeof result !== 'string' || !result) throw new TypeError('Migration cipher must synchronously decrypt in target device memory');
  return result;
}
function mappingProof(proof, sourceOwnerRef, targetOwnerRef) {
  if (proof?.authorized !== true || proof.sourceOwnerRef !== sourceOwnerRef || proof.targetOwnerRef !== targetOwnerRef
    || !proof.mappingRef || !proof.sourceAuthenticationRef || !proof.targetAuthenticationRef) {
    throw problem('MIGRATION_OWNER_MAPPING_REQUIRED', '来源和目标软件身份尚无正常认证映射证明', 403);
  }
  return proof;
}
function migrationStage(stage, action) {
  try { return action(); }
  catch (error) {
    if (error.status && error.code) throw error;
    // Inspect only in memory and emit an allowlisted class. Raw SQLite/OpenSSL
    // messages can contain statement text or values and must never be returned.
    const message = String(error.message || '');
    const category = /\bOOM\b|out of memory|Cannot enlarge memory|allocation failed/i.test(message) ? 'MEMORY_EXHAUSTED'
      : /string or blob too big|too large|SQLITE_TOOBIG/i.test(message) ? 'VALUE_LIMIT'
      : /foreign key/i.test(message) ? 'FOREIGN_KEY'
      : /constraint|unique|not null/i.test(message) ? 'CONSTRAINT'
      : /database is locked|SQLITE_BUSY/i.test(message) ? 'LOCKED'
      : /bind|parameter/i.test(message) ? 'BINDING' : 'UNCLASSIFIED';
    throw problem('MIGRATION_' + stage + '_FAILED', '迁移处理尚未完成，原密文与来源资料已保留', 500,
      { stage, errorClass: /^[A-Za-z]{1,48}$/.test(error.name || '') ? error.name : 'Error', category,
        sqlitePrimaryCode: Number.isSafeInteger(error.errcode) ? error.errcode & 0xff : null });
  }
}

export function createMigrationReceiver({ store, cipher, targetInfo, authorizeOwnerMapping, verifyAndAdd,
  onImported = () => {}, assertOwnerCurrent = () => {}, clock = () => Date.now() }) {
  if (!cipher || typeof cipher.encrypt !== 'function' || typeof cipher.decrypt !== 'function'
    || typeof authorizeOwnerMapping !== 'function' || typeof verifyAndAdd !== 'function' || typeof onImported !== 'function') {
    throw new TypeError('Migration receiver requires target encryption, normal owner authentication and normal official verify/add dependencies');
  }
  if (onImported.constructor?.name === 'AsyncFunction') throw new TypeError('Migration onImported must be synchronous');
  if (typeof assertOwnerCurrent !== 'function' || assertOwnerCurrent.constructor?.name === 'AsyncFunction') throw new TypeError('Migration current owner assertion must be synchronous');
  for (const key of ['appId', 'cloudRef', 'sourceVersion']) requireText(targetInfo?.[key], 'targetInfo.' + key);
  const { get, all, run, transaction, nowIso } = store;
  transaction(() => store.db.exec(`
CREATE TABLE IF NOT EXISTS backend_migration_receivers(
  session_id TEXT PRIMARY KEY,target_owner_ref TEXT NOT NULL,source_owner_ref TEXT NOT NULL,
  target_app_id TEXT NOT NULL,target_cloud_ref TEXT NOT NULL,offer_json TEXT NOT NULL,
  private_key_ciphertext TEXT,expires_at_ms INTEGER NOT NULL,state TEXT NOT NULL,
  envelope_fingerprint TEXT,claimed_at TEXT,completed_at TEXT,created_at TEXT NOT NULL,
  command_id TEXT NOT NULL,UNIQUE(target_owner_ref,command_id));
CREATE TABLE IF NOT EXISTS backend_migration_imports(
  transfer_id TEXT PRIMARY KEY,session_id TEXT NOT NULL UNIQUE REFERENCES backend_migration_receivers(session_id),
  source_owner_ref TEXT NOT NULL,target_owner_ref TEXT NOT NULL,source_account_ref TEXT NOT NULL,
  target_account_ref TEXT,target_subject_ref TEXT,envelope_fingerprint TEXT NOT NULL,
  envelope_ciphertext TEXT NOT NULL,payload_fingerprint TEXT NOT NULL,source_version TEXT NOT NULL,
  mapping_evidence_ciphertext TEXT NOT NULL,state TEXT NOT NULL,verification_ref TEXT,
  last_error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS backend_legacy_archives(
  archive_id TEXT PRIMARY KEY,transfer_id TEXT NOT NULL REFERENCES backend_migration_imports(transfer_id),
  source_instance_ref TEXT NOT NULL,source_version TEXT NOT NULL,source_owner_ref TEXT NOT NULL,
  target_owner_ref TEXT NOT NULL,target_account_ref TEXT NOT NULL,target_subject_ref TEXT NOT NULL,
  source_table TEXT NOT NULL,source_primary_key_json TEXT NOT NULL,source_row_fingerprint TEXT NOT NULL,
  original_row_ciphertext TEXT NOT NULL,recorded_at TEXT NOT NULL,
  UNIQUE(transfer_id,source_table,source_primary_key_json));
CREATE TABLE IF NOT EXISTS backend_migration_supplements(
  session_id TEXT PRIMARY KEY REFERENCES backend_migration_receivers(session_id),original_session_id TEXT NOT NULL,
  original_transfer_id TEXT NOT NULL,target_owner_ref TEXT NOT NULL,source_owner_ref TEXT NOT NULL,
  target_account_ref TEXT NOT NULL,target_subject_ref TEXT NOT NULL,original_verification_ref TEXT NOT NULL,
  binding_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS backend_legacy_log_snapshots(
  transfer_id TEXT PRIMARY KEY REFERENCES backend_migration_imports(transfer_id),original_transfer_id TEXT NOT NULL,
  owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,source_owner_ref TEXT NOT NULL,
  source_instance_ref TEXT NOT NULL,source_user_id INTEGER NOT NULL,source_install_id TEXT NOT NULL,
  source_cloud_ref TEXT NOT NULL,source_app_id TEXT NOT NULL,source_exported_at TEXT NOT NULL,
  manifest_json TEXT NOT NULL,recorded_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS backend_legacy_log_snapshots_no_update BEFORE UPDATE ON backend_legacy_log_snapshots
  BEGIN SELECT RAISE(ABORT,'legacy log snapshot binding is immutable'); END;
CREATE TRIGGER IF NOT EXISTS backend_legacy_log_snapshots_no_delete BEFORE DELETE ON backend_legacy_log_snapshots
  BEGIN SELECT RAISE(ABORT,'legacy log snapshot history is append only'); END;
CREATE TRIGGER IF NOT EXISTS backend_migration_supplements_no_update BEFORE UPDATE ON backend_migration_supplements
  BEGIN SELECT RAISE(ABORT,'supplement identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS backend_migration_supplements_no_delete BEFORE DELETE ON backend_migration_supplements
  BEGIN SELECT RAISE(ABORT,'supplement history is append only'); END;
CREATE TRIGGER IF NOT EXISTS backend_legacy_archives_no_update BEFORE UPDATE ON backend_legacy_archives
  BEGIN SELECT RAISE(ABORT,'legacy migration evidence is append only'); END;
CREATE TRIGGER IF NOT EXISTS backend_legacy_archives_no_delete BEFORE DELETE ON backend_legacy_archives
  BEGIN SELECT RAISE(ABORT,'legacy migration evidence is append only'); END;
`));
  const importing = new Map();
  function assertCurrentOwner(input) {
    const assertion = assertOwnerCurrent(input);
    if (assertion && typeof assertion.then === 'function') throw problem('MIGRATION_OWNER_ASSERTION_MUST_BE_SYNC', '迁移提交的软件归属栅栏必须同步核实', 500);
    if (assertion === false || plainObject(assertion) && assertion.authorized === false) throw problem('MIGRATION_OWNER_CHANGED', '迁移处理期间正常软件身份已变化', 403);
  }
  const requireSession = sessionId => {
    const row = get('SELECT * FROM backend_migration_receivers WHERE session_id=?', requireText(sessionId, 'sessionId'));
    if (!row) throw problem('MIGRATION_SESSION_MISSING', '迁移接收会话不存在', 404);
    if (row.target_app_id !== targetInfo.appId || row.target_cloud_ref !== targetInfo.cloudRef) throw problem('MIGRATION_TARGET_CHANGED', '迁移接收发行身份或云上下文已变化', 409);
    return row;
  };
  function coveredOperations({ targetOwnerRef, sourceOwnerRef, accountRef, subjectRef }) {
    const digests = new Set();
    let after = '';
    for (;;) {
      const page = all(`SELECT a.archive_id,a.original_row_ciphertext,a.source_row_fingerprint FROM backend_legacy_archives a
        JOIN backend_migration_imports i ON i.transfer_id=a.transfer_id WHERE i.state='imported'
        AND i.target_owner_ref=? AND i.source_owner_ref=? AND a.target_account_ref=? AND a.target_subject_ref=?
        AND a.source_table='game_write_operations' AND a.archive_id>? ORDER BY a.archive_id LIMIT 500`,
      targetOwnerRef, sourceOwnerRef, accountRef, subjectRef, after);
      for (const archive of page) {
        const original = parseStored(decrypted(cipher, archive.original_row_ciphertext), '已保全原操作身份');
        if (digestText(canonical(original)) !== archive.source_row_fingerprint) throw problem('MIGRATION_ARCHIVE_FINGERPRINT_MISMATCH', '原已保全操作指纹不一致', 409);
        digests.add(operationIdentityDigest(original.operation_id));
      }
      if (page.length < 500) break;
      after = page.at(-1).archive_id;
    }
    return [...digests].sort();
  }
  function supplementBinding({ supplementOf, targetOwnerRef, sourceOwnerRef, sourceAppId, sourceCloudRef, sourceDescriptor, kind }) {
    const originalReceiver = requireSession(supplementOf);
    const original = get(`SELECT transfer_id,source_account_ref,target_account_ref,target_subject_ref,verification_ref
      FROM backend_migration_imports WHERE session_id=? AND state='imported'`, supplementOf);
    const originalOffer = parseStored(originalReceiver.offer_json, '原迁移接收请求');
    if (!original || originalReceiver.target_owner_ref !== targetOwnerRef || originalReceiver.source_owner_ref !== sourceOwnerRef
      || originalOffer.sourceAppId !== sourceAppId || originalOffer.sourceCloudRef !== sourceCloudRef
      || originalOffer.sourceSignerPublicKey !== sourceDescriptor.sourceSignerPublicKey || originalOffer.supplementOf
      || !original.target_account_ref || !original.target_subject_ref || !original.verification_ref) {
      throw problem('MIGRATION_SUPPLEMENT_ORIGIN_INVALID', '补充证据必须绑定同源同归属的已完成原迁移', 409);
    }
    const accountArchive = get(`SELECT original_row_ciphertext,source_row_fingerprint FROM backend_legacy_archives WHERE transfer_id=?
      AND source_table='accounts' AND target_owner_ref=? AND target_account_ref=? LIMIT 1`, original.transfer_id, targetOwnerRef, original.target_account_ref);
    if (!accountArchive) throw problem('MIGRATION_SUPPLEMENT_IDENTITY_UNAVAILABLE', '原已验证来源账号证据缺失', 409);
    const account = parseStored(decrypted(cipher, accountArchive.original_row_ciphertext), '原已验证来源账号');
    if (digestText(canonical(account)) !== accountArchive.source_row_fingerprint) throw problem('MIGRATION_ARCHIVE_FINGERPRINT_MISMATCH', '原已验证账号指纹不一致', 409);
    if (String(account.id) !== original.source_account_ref || account.panel_token !== sourceOwnerRef
      || !Number.isSafeInteger(account.server_id) || account.server_id < 1) throw problem('MIGRATION_SUPPLEMENT_IDENTITY_UNAVAILABLE', '原账号与区服证据不完整', 409);
    return { originalSessionId: supplementOf, originalTransferId: original.transfer_id,
      targetAccountRef: original.target_account_ref, targetSubjectRef: original.target_subject_ref,
      originalVerificationRef: original.verification_ref, sourceAccountRef: original.source_account_ref, serverId: account.server_id,
      originalTargetFingerprint: originalOffer.targetFingerprint,
      coveredOperationDigests: kind === 'device-log-metadata' ? [] : coveredOperations({ targetOwnerRef, sourceOwnerRef, accountRef: original.target_account_ref, subjectRef: original.target_subject_ref }) };
  }
  function requireSupplement(offer) {
    if (!offer.supplementOf) return null;
    const row = get('SELECT * FROM backend_migration_supplements WHERE session_id=?', offer.sessionId);
    if (!row || row.original_session_id !== offer.supplementOf || row.target_owner_ref !== offer.targetOwnerRef
      || row.source_owner_ref !== offer.sourceOwnerRef || canonical(parseStored(row.binding_json, '补充会话绑定')) !== canonical(offer.supplement)) {
      throw problem('MIGRATION_SUPPLEMENT_BINDING_CHANGED', '补充证据接收绑定已变化', 409);
    }
    const original = get(`SELECT target_account_ref,target_subject_ref,verification_ref
      FROM backend_migration_imports WHERE session_id=? AND state='imported'`, row.original_session_id);
    if (!original || original.target_account_ref !== row.target_account_ref || original.target_subject_ref !== row.target_subject_ref
      || original.verification_ref !== row.original_verification_ref) throw problem('MIGRATION_SUPPLEMENT_ORIGIN_CHANGED', '原已验证迁移身份已变化', 409);
    return { ownerRef: row.target_owner_ref, accountRef: row.target_account_ref, subjectRef: row.target_subject_ref,
      serverId: offer.supplement.serverId, verificationRef: row.original_verification_ref, sourceOwnerRef: row.source_owner_ref,
      sourceAccountRef: offer.supplement.sourceAccountRef, originalSessionId: row.original_session_id,
      originalTransferId: row.original_transfer_id, sourceAppId: offer.sourceAppId, sourceCloudRef: offer.sourceCloudRef };
  }
  function requireIncrementalOperations(payload, offer) {
    if (offer.kind === 'device-log-metadata') return;
    if (!offer.supplementOf) return;
    const current = new Set(coveredOperations({ targetOwnerRef: offer.targetOwnerRef, sourceOwnerRef: offer.sourceOwnerRef,
      accountRef: offer.supplement.targetAccountRef, subjectRef: offer.supplement.targetSubjectRef }));
    const baseline = new Set(offer.supplement.coveredOperationDigests);
    const operations = payload.tables.find(item => item.table === 'game_write_operations')?.rows || [];
    const selection = payload.supplementSelection;
    const aliases = new Set(payload.aliases.map(alias => alias.subjectRef));
    if (!plainObject(selection) || !Array.isArray(selection.accountIds) || !Array.isArray(selection.subjectRefs)
      || !selection.accountIds.includes(payload.account.id)
      || selection.accountIds.some(id => !Number.isSafeInteger(id) || id < 1)
      || !selection.subjectRefs.includes(offer.supplement.targetSubjectRef)
      || selection.subjectRefs.some(subjectRef => !aliases.has(subjectRef))) throw problem('MIGRATION_SUPPLEMENT_SELECTION_INVALID', '补充来源范围不完整', 409);
    if (operations.some(row => baseline.has(operationIdentityDigest(row.operation_id)) || current.has(operationIdentityDigest(row.operation_id))
      || selection.accountIds.includes(row.account_id) || !selection.subjectRefs.includes(row.subject_ref))) {
      throw problem('MIGRATION_SUPPLEMENT_NOT_INCREMENTAL', '补充只能新增原稳定主体遗漏的原操作证据，不能重复原操作', 409);
    }
    const ids = new Set(operations.map(row => row.operation_id));
    for (const table of ['game_write_operation_targets', 'game_write_holds', 'write_evidence_events', 'game_write_supersedes']) {
      if (payload.tables.find(item => item.table === table)?.rows.some(row => !ids.has(row.operation_id))) throw problem('MIGRATION_SUPPLEMENT_CHILD_MISMATCH', '补充目标/资源/证据必须属于本次遗漏原操作', 409);
    }
  }
  async function createOffer({ targetOwnerRef, sourceOwnerRef, sourceAppId, sourceCloudRef, commandId = newId(),
    sourceDescriptor, authenticationRef, ttlMs = 15 * 60_000, supplementOf = null, kind = 'account-history' }) {
    for (const [name, value] of Object.entries({ targetOwnerRef, sourceOwnerRef, sourceAppId, sourceCloudRef, commandId, authenticationRef })) requireText(value, name);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 60 * 60_000) throw problem('MIGRATION_EXPIRY_INVALID', '迁移接收请求有效期须为1至60分钟', 400);
    if (!['account-history', 'device-log-metadata'].includes(kind) || kind === 'device-log-metadata' && !supplementOf) {
      throw problem('MIGRATION_PURPOSE_INVALID', '日志元数据补充必须明确绑定已完成的原迁移', 400);
    }
    validateSourceDescriptor(sourceDescriptor);
    if (sourceDescriptor.sourceOwnerRef !== sourceOwnerRef || sourceDescriptor.sourceAppId !== sourceAppId
      || sourceDescriptor.sourceCloudRef !== sourceCloudRef) throw problem('MIGRATION_SOURCE_DESCRIPTOR_INVALID', '迁移来源描述不属于指定身份', 403);
    const ownership = mappingProof(await authorizeOwnerMapping({ purpose: kind === 'device-log-metadata' ? 'create-device-log-metadata-offer' : 'create-migration-offer', sourceOwnerRef, targetOwnerRef,
      sourceAppId, sourceCloudRef, sourceDescriptor, targetInfo, authenticationRef }), sourceOwnerRef, targetOwnerRef);
    return transaction(() => {
      assertCurrentOwner({ targetOwnerRef, ownershipEvidence: ownership, phase: 'create-offer' });
      const old = get('SELECT * FROM backend_migration_receivers WHERE target_owner_ref=? AND command_id=?', targetOwnerRef, commandId);
      if (old) {
        const offer = parseStored(old.offer_json, '迁移接收请求');
        if (offer.sourceOwnerRef !== sourceOwnerRef || offer.sourceAppId !== sourceAppId || offer.sourceCloudRef !== sourceCloudRef
          || offer.sourceDescriptorFingerprint !== sourceDescriptor.descriptorFingerprint || offer.authenticationRef !== authenticationRef
          || (offer.supplementOf || null) !== supplementOf || (offer.kind || 'account-history') !== kind) throw problem('MIGRATION_COMMAND_CONFLICT', '同一迁移指令包含不同归属', 409);
        if (old.state !== 'offered') throw problem('MIGRATION_SESSION_ALREADY_USED', '迁移接收请求已经使用', 409);
        return validateOffer(offer, clock());
      }
      const keyPair = generateReceiverKeyPair();
      const supplement = supplementOf === null ? null : supplementBinding({ supplementOf: requireText(supplementOf, 'supplementOf'),
        targetOwnerRef, sourceOwnerRef, sourceAppId, sourceCloudRef, sourceDescriptor, kind });
      let logMetadata = null;
      if (kind === 'device-log-metadata') {
        if (!Number.isSafeInteger(ownership.sourceSoftwareUserId) || ownership.sourceSoftwareUserId < 1
          || !/^[a-f0-9]{32}$/.test(ownership.sourceInstallId || '')) {
          throw problem('MIGRATION_LOG_METADATA_SOURCE_IDENTITY_REQUIRED', '设备日志补充缺少正常来源软件用户和安装证明', 403);
        }
        logMetadata = { sourceSoftwareUserId: ownership.sourceSoftwareUserId, sourceInstallId: ownership.sourceInstallId,
          sourceInstanceRef: sourceDescriptor.sourceInstanceRef, originalTransferId: supplement.originalTransferId,
          scope: 'entire-source-software-owner-queue' };
      }
      const offer = { protocolVersion: MIGRATION_PROTOCOL_VERSION, sessionId: newId(), targetOwnerRef, sourceOwnerRef,
        sourceAppId, sourceCloudRef, targetAppId: targetInfo.appId, targetCloudRef: targetInfo.cloudRef, targetVersion: targetInfo.sourceVersion,
        sourceSignerPublicKey: sourceDescriptor.sourceSignerPublicKey, sourceSignerFingerprint: sourceDescriptor.sourceSignerFingerprint,
        sourceDescriptorFingerprint: sourceDescriptor.descriptorFingerprint,
        targetPublicKey: keyPair.publicKey, targetFingerprint: publicKeyFingerprint(keyPair.publicKey), authenticationRef,
        createdAt: new Date(clock()).toISOString(), expiresAtMs: clock() + ttlMs,
        ...(supplement ? { supplementOf, supplement } : {}), ...(kind === 'device-log-metadata' ? { kind, logMetadata } : {}) };
      run('INSERT INTO backend_migration_receivers VALUES(?,?,?,?,?,?,?,?,\'offered\',NULL,NULL,NULL,?,?)', offer.sessionId,
        targetOwnerRef, sourceOwnerRef, targetInfo.appId, targetInfo.cloudRef, canonical(offer), encrypted(cipher, keyPair.privateKey),
        offer.expiresAtMs, nowIso(), commandId);
      if (supplement) run('INSERT INTO backend_migration_supplements VALUES(?,?,?,?,?,?,?,?,?,?)', offer.sessionId, supplementOf,
        supplement.originalTransferId, targetOwnerRef, sourceOwnerRef, supplement.targetAccountRef, supplement.targetSubjectRef,
        supplement.originalVerificationRef, canonical(supplement), nowIso());
      keyPair.privateKey = '';
      return offer;
    });
  }
  function validateLogMetadataPayload(payload, offer) {
    const binding = offer.logMetadata;
    const fields = {
      android_log_outbox: new Set(['id', 'event_id', 'seq', 'user_id', 'install_id', 'occurred_at', 'level', 'category', 'message',
        'app_version', 'trace_id', 'operation_id', 'error_code', 'outcome_json', 'outcome_state', 'attempted', 'account_id',
        'bytes', 'enqueued_at', 'uploaded_at', 'attempts', 'last_reason']),
      android_log_receipts: new Set(['event_id', 'user_id', 'bytes', 'verdict', 'received_at', 'uploaded_at']),
      android_log_sync_state: new Set(['key', 'value', 'updated_at']),
      android_log_gaps: new Set(['id', 'at', 'dropped', 'reason']),
    };
    const payloadKeys = new Set(['protocolVersion', 'kind', 'transferId', 'commandId', 'source', 'target', 'logMetadata',
      'ownershipProof', 'stopProofs', 'account', 'loginCredential', 'aliases', 'supplement', 'tables', 'manifest']);
    const sourceKeys = new Set(['appId', 'cloudRef', 'sourceVersion', 'instanceRef', 'softwareUserId', 'installId', 'ownerRef', 'exportedAt']);
    if (!plainObject(payload) || Object.keys(payload).some(key => !payloadKeys.has(key))
      || payload.kind !== 'device-log-metadata' || payload.protocolVersion !== MIGRATION_PROTOCOL_VERSION
      || !plainObject(payload.source) || !plainObject(payload.target) || !plainObject(binding)
      || Object.keys(payload.source).some(key => !sourceKeys.has(key))
      || payload.account !== null || payload.loginCredential !== null || !Array.isArray(payload.aliases) || payload.aliases.length !== 0
      || !Array.isArray(payload.tables) || payload.tables.length !== 4 || !Array.isArray(payload.manifest) || payload.manifest.length !== 4
      || new Set(payload.tables.map(item => item?.table)).size !== 4
      || canonical(payload.logMetadata) !== canonical(binding) || canonical(payload.supplement) !== canonical(offer.supplement)) {
      throw problem('MIGRATION_LOG_METADATA_PAYLOAD_INVALID', '日志元数据补充只允许四张明确日志表和既有迁移绑定', 400);
    }
    requireText(payload.transferId, 'transferId'); requireText(payload.commandId, 'commandId');
    for (const key of ['sourceVersion', 'instanceRef', 'exportedAt']) requireText(payload.source[key], 'source.' + key);
    if (payload.source.ownerRef !== offer.sourceOwnerRef || payload.source.appId !== offer.sourceAppId || payload.source.cloudRef !== offer.sourceCloudRef
      || payload.source.softwareUserId !== binding.sourceSoftwareUserId || payload.source.installId !== binding.sourceInstallId
      || payload.source.instanceRef !== binding.sourceInstanceRef || !Number.isFinite(Date.parse(payload.source.exportedAt))
      || payload.target.ownerRef !== offer.targetOwnerRef || payload.target.appId !== offer.targetAppId || payload.target.cloudRef !== offer.targetCloudRef
      || payload.target.sessionId !== offer.sessionId || payload.target.fingerprint !== offer.targetFingerprint
      || payload.ownershipProof?.sourceSoftwareUserId !== binding.sourceSoftwareUserId || payload.ownershipProof?.sourceInstallId !== binding.sourceInstallId) {
      throw problem('MIGRATION_LOG_METADATA_IDENTITY_MISMATCH', '日志元数据来源用户、安装或原迁移绑定变化', 403);
    }
    if (!Array.isArray(payload.stopProofs) || payload.stopProofs.length !== 2 || payload.stopProofs.some(proof => proof.stopped !== true
      || proof.currentInFlight !== false || proof.sourceFenceCommitted !== true || proof.sourceOwnerRef !== offer.sourceOwnerRef
      || proof.targetSessionId !== offer.supplementOf || !proof.fenceRef || !proof.evidenceRef)) {
      throw problem('MIGRATION_STOP_PROOF_MISSING', '日志元数据补充缺少原执行方停止和隔离证明', 409);
    }
    const primaryKeys = { android_log_outbox: ['id'], android_log_receipts: ['event_id'], android_log_sync_state: ['key'], android_log_gaps: ['id'] };
    for (const item of payload.tables) {
      const entry = payload.manifest.find(row => row.table === item.table), allowed = fields[item.table];
      if (!allowed || !Array.isArray(item.rows) || !['read', 'absent'].includes(item.status) || item.status === 'absent' && item.rows.length
        || !entry || entry.status !== item.status || entry.rowCount !== item.rows.length || entry.fingerprint !== digestText(canonical(item))
        || canonical(item.primaryKey) !== canonical(item.status === 'absent' ? [] : primaryKeys[item.table])) {
        throw problem('MIGRATION_LOG_METADATA_MANIFEST_INVALID', '日志补充原表、原主键或完整快照名册不一致', 400);
      }
      const keys = new Set();
      for (const row of item.rows) {
        if (!plainObject(row) || Object.keys(row).some(key => !allowed.has(key)) || Object.values(row).some(value => value !== null && typeof value !== 'string'
          && !(typeof value === 'number' && Number.isFinite(value)))) throw problem('MIGRATION_LOG_METADATA_ROW_INVALID', '日志补充只允许已审原始日志字段', 400);
        if ((item.table === 'android_log_outbox' || item.table === 'android_log_receipts') && row.user_id !== binding.sourceSoftwareUserId
          || item.table === 'android_log_outbox' && row.install_id !== binding.sourceInstallId
          || item.table === 'android_log_sync_state' && /:u\d+$/.test(row.key) && !row.key.endsWith(':u' + binding.sourceSoftwareUserId)) {
          throw problem('MIGRATION_LOG_METADATA_OWNER_MISMATCH', '日志补充包含另一软件用户或安装的资料', 403);
        }
        const identity = canonical(primaryKeys[item.table].map(key => row[key]));
        if (keys.has(identity)) throw problem('MIGRATION_LOG_METADATA_DUPLICATE_ROW', '日志快照原主键重复', 400);
        keys.add(identity);
      }
    }
    return payload;
  }
  function validatePayload(payload, offer) {
    if (offer.kind === 'device-log-metadata') return validateLogMetadataPayload(payload, offer);
    if (offer.kind !== undefined && offer.kind !== 'account-history') throw problem('MIGRATION_PURPOSE_INVALID', '迁移请求用途未登记', 400);
    const supplemental = Boolean(offer.supplementOf);
    if (!plainObject(payload) || payload.protocolVersion !== MIGRATION_PROTOCOL_VERSION || !plainObject(payload.source)
      || !plainObject(payload.target) || !plainObject(payload.account) || (supplemental ? payload.loginCredential !== null : !plainObject(payload.loginCredential))
      || !Array.isArray(payload.tables) || !Array.isArray(payload.aliases) || !Array.isArray(payload.manifest)) {
      throw problem('MIGRATION_PAYLOAD_INVALID', '迁移资料结构不完整', 400);
    }
    requireText(payload.transferId, 'transferId'); requireText(payload.source.sourceVersion, 'sourceVersion'); requireText(payload.source.instanceRef, 'instanceRef');
    if (payload.source.ownerRef !== offer.sourceOwnerRef || payload.source.appId !== offer.sourceAppId || payload.source.cloudRef !== offer.sourceCloudRef
      || payload.target.ownerRef !== offer.targetOwnerRef || payload.target.appId !== offer.targetAppId || payload.target.cloudRef !== offer.targetCloudRef
      || payload.target.sessionId !== offer.sessionId || payload.target.fingerprint !== offer.targetFingerprint
      || payload.account.panel_token !== offer.sourceOwnerRef || payload.source.accountId !== payload.account.id
      || !supplemental && payload.loginCredential.username !== payload.account.username) throw problem('MIGRATION_PAYLOAD_IDENTITY_MISMATCH', '迁移资料与接收身份不一致', 403);
    if (supplemental && (canonical(payload.supplement) !== canonical(offer.supplement)
      || String(payload.account.id) !== offer.supplement.sourceAccountRef || payload.account.server_id !== offer.supplement.serverId)) {
      throw problem('MIGRATION_SUPPLEMENT_BINDING_CHANGED', '补充资料必须沿用原已验证的账号/主体/区服', 409);
    }
    if (!Array.isArray(payload.stopProofs) || payload.stopProofs.length !== 2 || payload.stopProofs.some(proof => proof.stopped !== true || proof.currentInFlight !== false
      || proof.sourceFenceCommitted !== true || proof.sourceOwnerRef !== offer.sourceOwnerRef || proof.targetSessionId !== (offer.supplementOf || offer.sessionId) || !proof.fenceRef || !proof.evidenceRef)) {
      throw problem('MIGRATION_STOP_PROOF_MISSING', '迁移资料缺少来源停止及当前在途证明', 409);
    }
    if (!supplemental) requireText(payload.loginCredential.password, 'device-memory-game-password');
    if (!payload.aliases.length || payload.aliases.some(alias => !/^[a-f0-9]{64}$/.test(alias.subjectRef) || !alias.basis || !alias.identityVersion || !alias.sourceRef)) {
      throw problem('MIGRATION_SUBJECT_EVIDENCE_MISSING', '迁移资料缺少原主体及摘要版本', 409);
    }
    if (supplemental && !payload.aliases.some(alias => alias.subjectRef === offer.supplement.targetSubjectRef)) throw problem('MIGRATION_SUPPLEMENT_SUBJECT_MISMATCH', '补充资料缺少原已验证主体', 409);
    if (new Set(payload.tables.map(item => item.table)).size !== payload.tables.length || payload.manifest.length !== payload.tables.length) {
      throw problem('MIGRATION_MANIFEST_INVALID', '迁移表名册缺失或重复', 400);
    }
    const accountTable = payload.tables.find(item => item.table === 'accounts');
    if (!accountTable || accountTable.status !== 'read' || accountTable.rows?.length !== 1
      || canonical(accountTable.rows[0]) !== canonical(payload.account)) throw problem('MIGRATION_ACCOUNT_ARCHIVE_MISMATCH', '迁移账号与原始账号行保全不一致', 400);
    for (const item of payload.tables) {
      const entry = payload.manifest.find(row => row.table === item.table);
      if (!/^[a-z][a-z0-9_]*$/.test(item.table) || !Array.isArray(item.primaryKey) || !Array.isArray(item.rows)
        || !entry || entry.rowCount !== item.rows.length || entry.status !== item.status || entry.fingerprint !== digestText(canonical(item))) {
        throw problem('MIGRATION_MANIFEST_INVALID', '迁移资料指纹或行数不一致', 400);
      }
      if (item.rows.some(row => !plainObject(row) || Object.values(row).some(value => value !== null && typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))))) {
        throw problem('MIGRATION_ROW_INVALID', '迁移原始行包含无法保全的值', 400);
      }
    }
    requireIncrementalOperations(payload, offer);
    return payload;
  }
  async function importOnce({ targetOwnerRef, envelope, commandId = newId(), authenticationRef }) {
    requireText(targetOwnerRef, 'targetOwnerRef'); requireText(commandId, 'commandId'); requireText(authenticationRef, 'authenticationRef');
    const receiver = requireSession(envelope?.offer?.sessionId);
    const offer = parseStored(receiver.offer_json, '迁移接收请求');
    const logMetadataOnly = offer.kind === 'device-log-metadata';
    if (targetOwnerRef !== receiver.target_owner_ref || canonical(envelope.offer) !== canonical(offer)) throw problem('MIGRATION_TARGET_MISMATCH', '迁移密文不属于当前接收请求', 403);
    const envelopeFingerprint = digestText(canonical(envelope));
    const { sourceAttestation, sealedFingerprint } = migrationStage('ATTESTATION', () => verifySourceAttestation(envelope));
    const ownership = mappingProof(await authorizeOwnerMapping({ purpose: logMetadataOnly ? 'import-device-log-metadata' : 'import-account', sourceOwnerRef: offer.sourceOwnerRef,
      targetOwnerRef, sourceAppId: offer.sourceAppId, sourceCloudRef: offer.sourceCloudRef, targetInfo, authenticationRef,
      offer, envelopeFingerprint, sealedFingerprint, sourceAttestation }), offer.sourceOwnerRef, targetOwnerRef);
    if (logMetadataOnly && (ownership.sourceSoftwareUserId !== offer.logMetadata?.sourceSoftwareUserId || ownership.sourceInstallId !== offer.logMetadata?.sourceInstallId)) {
      throw problem('MIGRATION_LOG_METADATA_SOURCE_IDENTITY_REQUIRED', '日志元数据导入不属于当前已配对的源软件用户和安装', 403);
    }
    const existingVerified = requireSupplement(offer);
    // The retained envelope can be tens of MB; replay/status checks need only
    // its fingerprint and metadata, never another JS copy of its ciphertext.
    const previous = get('SELECT state,envelope_fingerprint FROM backend_migration_imports WHERE session_id=?', offer.sessionId);
    if (previous?.state === 'imported') {
      if (previous.envelope_fingerprint !== envelopeFingerprint) throw problem('MIGRATION_SESSION_ALREADY_USED', '一次性接收请求不能接收另一份资料', 409);
      return status({ targetOwnerRef, sessionId: offer.sessionId });
    }
    if (receiver.state === 'offered') validateOffer(offer, clock());
    else if (receiver.envelope_fingerprint !== envelopeFingerprint || !previous) throw problem('MIGRATION_SESSION_ALREADY_USED', '一次性接收请求已绑定另一份资料', 409);
    if (!receiver.private_key_ciphertext) throw problem('MIGRATION_PRIVATE_KEY_UNAVAILABLE', '接收私钥已销毁或不可用', 409);
    const opened = migrationStage('DECRYPTION', () => openMigrationPayload(envelope, decrypted(cipher, receiver.private_key_ciphertext)));
    let payload = migrationStage('PAYLOAD_VALIDATION', () => validatePayload(opened, offer));
    const payloadFingerprint = digestText(canonical(payload));
    migrationStage('CLAIM_PERSISTENCE', () => transaction(() => {
      assertCurrentOwner({ targetOwnerRef, ownershipEvidence: ownership, phase: 'claim', sessionId: offer.sessionId, transferId: payload.transferId });
      const latest = migrationStage('CLAIM_SESSION_READ', () => requireSession(offer.sessionId));
      if (latest.envelope_fingerprint && latest.envelope_fingerprint !== envelopeFingerprint) throw problem('MIGRATION_SESSION_ALREADY_USED', '接收请求已被另一资料占用', 409);
      migrationStage('CLAIM_SESSION_UPDATE', () => run("UPDATE backend_migration_receivers SET state='claimed',envelope_fingerprint=?,claimed_at=COALESCE(claimed_at,?) WHERE session_id=?", envelopeFingerprint, nowIso(), offer.sessionId));
      const existing = migrationStage('CLAIM_TRANSFER_READ', () => get('SELECT session_id,payload_fingerprint FROM backend_migration_imports WHERE transfer_id=?', payload.transferId));
      if (existing && (existing.session_id !== offer.sessionId || existing.payload_fingerprint !== payloadFingerprint)) throw problem('MIGRATION_TRANSFER_CONFLICT', '原迁移身份不能对应另一份资料', 409);
      if (!existing) {
        const envelopeCiphertext = migrationStage('CLAIM_ENVELOPE_ENCRYPTION', () => encrypted(cipher, canonical(envelope)));
        const mappingCiphertext = migrationStage('CLAIM_MAPPING_ENCRYPTION', () => encrypted(cipher, canonical(ownership)));
        migrationStage('CLAIM_ROW_INSERT', () => run(`INSERT INTO backend_migration_imports
          (transfer_id,session_id,source_owner_ref,target_owner_ref,source_account_ref,target_account_ref,target_subject_ref,
          envelope_fingerprint,envelope_ciphertext,payload_fingerprint,source_version,mapping_evidence_ciphertext,
          state,verification_ref,last_error_code,created_at,updated_at)
          VALUES(?,?,?,?,?,NULL,NULL,?,?,?,?,?,'verifying',NULL,NULL,?,?)`,
        payload.transferId, offer.sessionId, offer.sourceOwnerRef, targetOwnerRef, logMetadataOnly ? offer.supplement.sourceAccountRef : String(payload.account.id), envelopeFingerprint,
        envelopeCiphertext, payloadFingerprint, payload.source.sourceVersion, mappingCiphertext, nowIso(), nowIso()));
      }
    }));
    try {
      const verification = logMetadataOnly ? { ...existingVerified, credentialStored: true } : await verifyAndAdd({ migrationKey: payload.transferId, commandId,
        ownerRef: targetOwnerRef, username: payload.account.username, ...(existingVerified ? {} : { password: payload.loginCredential.password }),
        channel: payload.account.channel, serverId: payload.account.server_id, sourceAccount: { ...payload.account },
        aliases: payload.aliases, ownershipEvidence: ownership, sourceInfo: payload.source,
        legacyDocument: payload.account.script_config, stopProofs: payload.stopProofs, sourceAttestation,
        manifest: payload.manifest, existingVerified, supplementOf: offer.supplementOf || null });
      if (!verification || verification.ownerRef !== targetOwnerRef || verification.credentialStored !== true
        || !verification.accountRef || !verification.subjectRef || !verification.verificationRef
        || !logMetadataOnly && !payload.aliases.some(alias => alias.subjectRef === verification.subjectRef) && !verification.identityBindingRef) {
        throw problem('MIGRATION_NORMAL_ADD_UNVERIFIED', '目标必须经正常官服验证和独立加密添加后才能接管资料', 409);
      }
      if (existingVerified && (String(verification.accountRef) !== existingVerified.accountRef || verification.subjectRef !== existingVerified.subjectRef
        || verification.verificationRef !== existingVerified.verificationRef)) throw problem('MIGRATION_SUPPLEMENT_VERIFICATION_CHANGED', '补充证据不得新增身份或改写原官服核验回执', 409);
      // Verification/add is the only async phase. Historical rows, identity
      // receipt and caller config/alias preservation commit synchronously.
      transaction(() => {
        assertCurrentOwner({ targetOwnerRef, ownershipEvidence: ownership, phase: 'finalize', sessionId: offer.sessionId, transferId: payload.transferId });
        requireIncrementalOperations(payload, offer);
        for (const item of payload.tables) for (const originalRow of item.rows) {
          const primaryKey = item.primaryKey.length ? Object.fromEntries(item.primaryKey.map(key => [key, originalRow[key]]))
            : { originalRowFingerprint: digestText(canonical(originalRow)) };
          const primaryKeyJson = canonical(primaryKey), rowFingerprint = digestText(canonical(originalRow));
          const archiveId = digestText(canonical([payload.transferId, item.table, primaryKey]));
          const existing = get('SELECT source_row_fingerprint FROM backend_legacy_archives WHERE archive_id=?', archiveId);
          if (existing && existing.source_row_fingerprint !== rowFingerprint) throw problem('MIGRATION_ARCHIVE_CONFLICT', '原证据行身份不能对应另一内容', 409);
          // Each signed transfer retains its selected original rows. Folding
          // across imports belongs to the proven source-install projection;
          // equal table/PK/content under one software owner is not install proof.
          if (!existing) run('INSERT INTO backend_legacy_archives VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', archiveId, payload.transferId,
            payload.source.instanceRef, payload.source.sourceVersion, offer.sourceOwnerRef, targetOwnerRef,
            String(verification.accountRef), verification.subjectRef, item.table, primaryKeyJson, rowFingerprint,
            encrypted(cipher, canonical(originalRow)), nowIso());
        }
        if (logMetadataOnly) run(`INSERT INTO backend_legacy_log_snapshots(transfer_id,original_transfer_id,owner_ref,account_ref,subject_ref,
          source_owner_ref,source_instance_ref,source_user_id,source_install_id,source_cloud_ref,source_app_id,source_exported_at,manifest_json,recorded_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, payload.transferId, offer.supplement.originalTransferId, targetOwnerRef,
        String(verification.accountRef), verification.subjectRef, offer.sourceOwnerRef, payload.source.instanceRef,
        payload.source.softwareUserId, payload.source.installId, payload.source.cloudRef, payload.source.appId,
        payload.source.exportedAt, canonical(payload.manifest), nowIso());
        const callback = onImported({ transferId: payload.transferId, ownerRef: targetOwnerRef, accountRef: String(verification.accountRef),
          subjectRef: verification.subjectRef, aliases: payload.aliases, legacyDocument: logMetadataOnly ? null : payload.account.script_config,
          source: payload.source, ownershipEvidence: ownership, verificationRef: verification.verificationRef,
          existingVerified, supplementOf: offer.supplementOf || null, kind: logMetadataOnly ? 'device-log-metadata' : 'account-history',
          stopProofs: payload.stopProofs, sourceAttestation, manifest: payload.manifest,
          tablesSummary: payload.tables.map(item => ({ table: item.table, status: item.status, rowCount: item.rows.length,
            primaryKey: item.primaryKey })),
          legacySummary: { operationCount: payload.tables.find(item => item.table === 'game_write_operations')?.rows.length || 0,
            unresolvedOperationCount: payload.tables.find(item => item.table === 'game_write_operations')?.rows.filter(row =>
              ['prepared', 'may_have_sent', 'verifying', 'transport_unknown', 'business_unverified'].includes(row.status)).length || 0,
            unreleasedHoldCount: payload.tables.find(item => item.table === 'game_write_holds')?.rows.filter(row => row.released_at === null).length || 0 } });
        // Returning the illegal thenable lets the common transaction driver
        // roll back and poison this store before any late async continuation.
        if (callback && typeof callback.then === 'function') return callback;
        run("UPDATE backend_migration_imports SET state='imported',target_account_ref=?,target_subject_ref=?,verification_ref=?,last_error_code=NULL,updated_at=? WHERE transfer_id=?",
          String(verification.accountRef), verification.subjectRef, verification.verificationRef, nowIso(), payload.transferId);
        run("UPDATE backend_migration_receivers SET state='imported',private_key_ciphertext=NULL,completed_at=? WHERE session_id=?", nowIso(), offer.sessionId);
      });
      return status({ targetOwnerRef, sessionId: offer.sessionId });
    } catch (error) {
      try {
        run('UPDATE backend_migration_imports SET last_error_code=?,updated_at=? WHERE transfer_id=?', String(error?.code || 'MIGRATION_NORMAL_ADD_FAILED'), nowIso(), payload.transferId);
      } catch (recordError) {
        throw Object.assign(new AggregateError([error, recordError], 'Migration failed and its failure receipt could not be persisted'), { code: 'MIGRATION_PERSISTENCE_FAILED' });
      }
      throw error;
    } finally { if (payload?.loginCredential) payload.loginCredential.password = ''; payload = null; }
  }
  function importEnvelope(input) {
    const sessionId = input?.envelope?.offer?.sessionId;
    const key = canonical([input?.targetOwnerRef ?? null, sessionId ?? null]);
    const fingerprint = digestText(canonical(input?.envelope ?? null));
    const existing = importing.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return Promise.reject(problem('MIGRATION_SESSION_ALREADY_USED', '接收中的一次性请求不能换成另一份密文', 409));
      return existing.promise;
    }
    const pending = { fingerprint, promise: null };
    const promise = importOnce(input).finally(() => { if (importing.get(key) === pending) importing.delete(key); });
    pending.promise = promise; importing.set(key, pending); return promise;
  }
  function status({ targetOwnerRef, sessionId }) {
    const receiver = requireSession(sessionId);
    if (receiver.target_owner_ref !== targetOwnerRef) throw problem('MIGRATION_OWNER_MISMATCH', '迁移状态不属于当前软件身份', 403);
    const imported = get(`SELECT transfer_id,state,target_account_ref,verification_ref,last_error_code
      FROM backend_migration_imports WHERE session_id=?`, sessionId);
    const offer = parseStored(receiver.offer_json, '迁移用途');
    return { sessionId, transferId: imported?.transfer_id || null, kind: offer.kind || 'account-history',
      state: imported?.state || receiver.state, expiresAtMs: receiver.expires_at_ms,
      targetAccountRef: imported?.target_account_ref || null, verificationRef: imported?.verification_ref || null,
      lastErrorCode: imported?.last_error_code || null,
      archivedRows: imported ? Number(get('SELECT COUNT(*) AS n FROM backend_legacy_archives WHERE transfer_id=?', imported.transfer_id).n) : 0 };
  }
  function readLegacyArchives({ targetOwnerRef, targetAccountRef, sourceTable = null, limit = 100, afterArchiveId = '' }) {
    requireText(targetOwnerRef, 'targetOwnerRef'); requireText(targetAccountRef, 'targetAccountRef');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('Invalid archive page size');
    const params = [targetOwnerRef, targetAccountRef, afterArchiveId];
    const tableClause = sourceTable === null ? '' : ' AND source_table=?';
    if (sourceTable !== null) params.push(requireText(sourceTable, 'sourceTable'));
    return all('SELECT * FROM backend_legacy_archives WHERE target_owner_ref=? AND target_account_ref=? AND archive_id>?' + tableClause + ' ORDER BY archive_id LIMIT ?', ...params, limit)
      .map(row => ({ ...row, originalRow: parseStored(decrypted(cipher, row.original_row_ciphertext), '迁移原始证据行') }));
  }
  function retireExpiredOffers() {
    return run("UPDATE backend_migration_receivers SET state='expired',private_key_ciphertext=NULL WHERE state='offered' AND expires_at_ms<=?", clock()).changes;
  }
  return Object.freeze({ createOffer, importEnvelope, status, readLegacyArchives, retireExpiredOffers });
}
