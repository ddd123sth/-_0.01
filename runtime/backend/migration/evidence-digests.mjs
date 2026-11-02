import crypto from 'node:crypto';
import { canonical, fingerprint, parseStored, plainObject, problem, requireText } from '../common.mjs';
import { sourceDescriptor, validateSourceDescriptor } from './crypto.mjs';

// Preserve the original table and primary-key semantics documented by the
// historical source export and current receiver.importEnvelope(). Digest reads never decrypt envelopes or write SQL;
// only the explicit installation-confirmation POST appends separate receipts.
const TABLE_KEYS = Object.freeze({
  game_write_operations: ['operation_id'],
  game_write_operation_targets: ['operation_id', 'target_ref'],
  game_write_holds: ['id'],
  write_evidence_events: ['id'],
});
const TABLES = Object.keys(TABLE_KEYS);
const identifier = value => {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new TypeError('Invalid evidence digest identifier');
  return '"' + value + '"';
};
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const INSTALL_PROOF_PURPOSE = 'wujinxia/migration/source-install-association/v1';
const INSTALL_PROOF_KEYS = ['protocolVersion', 'purpose', 'pairingRef', 'commandId', 'targetOwnerRef', 'targetAppId', 'targetCloudRef',
  'sourceOwnerRef', 'sourceAppId', 'sourceCloudRef', 'sourceInstallId', 'sourceDescriptorFingerprint', 'sourceSignerFingerprint',
  'sourceAuthenticationRef', 'issuedAt', 'expiresAtMs'];
const installMessage = payload => Buffer.from(INSTALL_PROOF_PURPOSE + '\n' + canonical(payload), 'utf8');
const sameSignerOrigin = (left, right) => ['sourceOwnerRef', 'sourceAppId', 'sourceCloudRef', 'sourceSignerPublicKey', 'sourceSignerFingerprint']
  .every(key => left[key] === right[key]);
function pairingDocuments(row) {
  const descriptor = parseStored(row.descriptor_json, '原迁移来源描述');
  const authentication = parseStored(row.source_authentication_json, '原迁移来源软件身份');
  validateSourceDescriptor(descriptor);
  if (!plainObject(authentication) || authentication.signedIn !== true || authentication.authorized !== true
    || authentication.sourceOwnerRef !== descriptor.sourceOwnerRef || authentication.transport !== 'authenticated-device-loopback'
    || !authentication.evidenceRef) throw problem('MIGRATION_DIGEST_SOURCE_UNPROVED', '原迁移来源缺少正常软件配对证明', 409);
  return { descriptor, authentication };
}
function signedInstallPayload(proof, descriptor) {
  if (!plainObject(proof) || canonical(Object.keys(proof).sort()) !== canonical([...INSTALL_PROOF_KEYS, 'signature'].sort())) {
    throw problem('MIGRATION_INSTALL_PROOF_INVALID', '来源安装证明格式无效', 400);
  }
  const { signature, ...payload } = proof;
  for (const key of INSTALL_PROOF_KEYS.filter(key => !['protocolVersion', 'expiresAtMs'].includes(key))) requireText(payload[key], key);
  if (payload.protocolVersion !== 1 || payload.purpose !== INSTALL_PROOF_PURPOSE
    || !/^[a-f0-9]{32}$/.test(payload.sourceInstallId) || !Number.isSafeInteger(payload.expiresAtMs)
    || !Number.isFinite(Date.parse(payload.issuedAt)) || payload.expiresAtMs <= Date.parse(payload.issuedAt)
    || payload.expiresAtMs - Date.parse(payload.issuedAt) > 5 * 60_000
    || payload.sourceDescriptorFingerprint !== descriptor.descriptorFingerprint
    || payload.sourceSignerFingerprint !== descriptor.sourceSignerFingerprint
    || payload.sourceOwnerRef !== descriptor.sourceOwnerRef || payload.sourceAppId !== descriptor.sourceAppId
    || payload.sourceCloudRef !== descriptor.sourceCloudRef || typeof signature !== 'string'
    || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw problem('MIGRATION_INSTALL_PROOF_INVALID', '来源安装证明与已配对描述不符', 409);
  let verified = false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(descriptor.sourceSignerPublicKey, 'base64'), format: 'der', type: 'spki' });
    verified = key.asymmetricKeyType === 'ed25519' && crypto.verify(null, installMessage(payload), key, Buffer.from(signature, 'base64'));
  } catch { /* No cryptographic values or OpenSSL messages leave this boundary. */ }
  if (!verified) throw problem('MIGRATION_INSTALL_SIGNATURE_INVALID', '来源安装关联未通过原签名公钥验证', 403);
  return payload;
}

export function createSourceInstallProof({ sourceInfo, sourceOwnerRef, sourceSigner, pairingRef, commandId,
  targetOwnerRef, targetAppId, targetCloudRef, expectedInstallId, expectedDescriptorFingerprint, clock = () => Date.now() }) {
  for (const [key, value] of Object.entries({ pairingRef, commandId, targetOwnerRef, targetAppId, targetCloudRef })) requireText(value, key);
  origin({ ...sourceInfo, ownerRef: sourceOwnerRef });
  if (typeof sourceSigner?.sign !== 'function' || !Number.isSafeInteger(sourceInfo.softwareUserId) || sourceInfo.softwareUserId < 1) {
    throw problem('MIGRATION_INSTALL_SOURCE_REQUIRED', '来源需要已有持久签名密钥和当前正常软件身份', 403);
  }
  const descriptor = sourceDescriptor({ sourceInfo, sourceOwnerRef, signerPublicKey: sourceSigner.publicKey });
  if (expectedInstallId !== sourceInfo.installId || expectedDescriptorFingerprint !== descriptor.descriptorFingerprint) {
    throw problem('MIGRATION_INSTALL_SOURCE_CHANGED', '来源安装或当前描述已变化，请正常重新配对', 409);
  }
  const now = clock();
  const payload = { protocolVersion: 1, purpose: INSTALL_PROOF_PURPOSE, pairingRef, commandId, targetOwnerRef, targetAppId, targetCloudRef,
    sourceOwnerRef, sourceAppId: sourceInfo.appId, sourceCloudRef: sourceInfo.cloudRef, sourceInstallId: sourceInfo.installId,
    sourceDescriptorFingerprint: descriptor.descriptorFingerprint, sourceSignerFingerprint: descriptor.sourceSignerFingerprint,
    sourceAuthenticationRef: 'source-software-session:' + sourceInfo.softwareUserId + ':' + sourceInfo.instanceRef,
    issuedAt: new Date(now).toISOString(), expiresAtMs: now + 5 * 60_000 };
  const signed = sourceSigner.sign(installMessage(payload));
  if (signed?.then) throw new TypeError('Source installation proof signer must be synchronous');
  const proof = { ...payload, signature: Buffer.isBuffer(signed) ? signed.toString('base64') : signed };
  signedInstallPayload(proof, descriptor);
  return { proof, descriptorFingerprint: descriptor.descriptorFingerprint, sourceInstallId: sourceInfo.installId, expiresAtMs: payload.expiresAtMs };
}

export function confirmSourceInstallBinding({ store, ownerRef, targetInfo, pairingRef, commandId, expectedInstallId,
  expectedSignerFingerprint, scope, proof, clock = () => Date.now() }) {
  for (const [key, value] of Object.entries({ ownerRef, pairingRef, commandId, expectedInstallId, expectedSignerFingerprint })) requireText(value, key);
  if (scope !== 'same-source-install') throw problem('MIGRATION_INSTALL_SCOPE_REQUIRED', '请明确确认同一原签名来源安装的历史关联范围', 400);
  const { get, all, run, transaction, nowIso } = store;
  const current = get('SELECT * FROM backend_migration_pairings WHERE pairing_ref=? AND target_owner_ref=?', pairingRef, ownerRef);
  if (!current) throw problem('MIGRATION_INSTALL_PAIRING_REQUIRED', '请先通过当前来源正常软件身份和描述建立新配对', 403);
  const { descriptor, authentication } = pairingDocuments(current);
  const payload = signedInstallPayload(proof, descriptor);
  if (payload.pairingRef !== pairingRef || payload.commandId !== commandId || payload.targetOwnerRef !== ownerRef
    || payload.targetAppId !== targetInfo.appId || payload.targetCloudRef !== targetInfo.cloudRef
    || payload.sourceInstallId !== expectedInstallId || payload.sourceSignerFingerprint !== expectedSignerFingerprint
    || authentication.installId !== expectedInstallId || authentication.evidenceRef !== payload.sourceAuthenticationRef
    || current.source_owner_ref !== descriptor.sourceOwnerRef) {
    throw problem('MIGRATION_INSTALL_BINDING_MISMATCH', '当前配对、来源安装签名或明确目标上下文不一致', 409);
  }
  return transaction(() => {
    // Only this explicit confirmation POST creates append-only metadata. The
    // digest GET below never initializes tables or changes original imports.
    store.db.exec(`CREATE TABLE IF NOT EXISTS backend_migration_install_receipts(
      binding_ref TEXT PRIMARY KEY,target_owner_ref TEXT NOT NULL,pairing_ref TEXT NOT NULL,command_id TEXT NOT NULL,
      source_owner_ref TEXT NOT NULL,source_app_id TEXT NOT NULL,source_cloud_ref TEXT NOT NULL,
      source_signer_fingerprint TEXT NOT NULL,source_install_id TEXT NOT NULL,proof_fingerprint TEXT NOT NULL,
      proof_json TEXT NOT NULL,evidence_json TEXT NOT NULL,recorded_at TEXT NOT NULL,UNIQUE(target_owner_ref,command_id));
      CREATE TABLE IF NOT EXISTS backend_migration_install_members(
      transfer_id TEXT PRIMARY KEY REFERENCES backend_migration_imports(transfer_id),target_owner_ref TEXT NOT NULL,
      binding_ref TEXT NOT NULL REFERENCES backend_migration_install_receipts(binding_ref),
      original_pairing_ref TEXT NOT NULL,original_descriptor_fingerprint TEXT NOT NULL,recorded_at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS backend_migration_install_receipts_no_update BEFORE UPDATE ON backend_migration_install_receipts
        BEGIN SELECT RAISE(ABORT,'source install binding receipt is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS backend_migration_install_receipts_no_delete BEFORE DELETE ON backend_migration_install_receipts
        BEGIN SELECT RAISE(ABORT,'source install binding receipt is append only'); END;
      CREATE TRIGGER IF NOT EXISTS backend_migration_install_members_no_update BEFORE UPDATE ON backend_migration_install_members
        BEGIN SELECT RAISE(ABORT,'source install binding member is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS backend_migration_install_members_no_delete BEFORE DELETE ON backend_migration_install_members
        BEGIN SELECT RAISE(ABORT,'source install binding member is append only'); END;`);
    const old = get('SELECT * FROM backend_migration_install_receipts WHERE target_owner_ref=? AND command_id=?', ownerRef, commandId);
    if (old) {
      if (old.proof_fingerprint !== fingerprint(proof) || old.pairing_ref !== pairingRef) throw problem('MIGRATION_INSTALL_COMMAND_CONFLICT', '同一安装关联指令不能改成另一份证明', 409);
      return { ok: true, bindingRef: old.binding_ref, reused: true, sourceInstallId: old.source_install_id,
        ...parseStored(old.evidence_json, '原安装关联收据') };
    }
    const now = clock();
    if (now < Date.parse(payload.issuedAt) - 30_000 || now >= payload.expiresAtMs) throw problem('MIGRATION_INSTALL_PROOF_EXPIRED', '来源当前安装签名已过期，请正常重新读取证明', 409);
    const candidates = all(`SELECT i.transfer_id,i.session_id,r.offer_json FROM backend_migration_imports i
      JOIN backend_migration_receivers r ON r.session_id=i.session_id WHERE i.state='imported' AND r.state='imported'
      AND i.target_owner_ref=? AND r.target_owner_ref=i.target_owner_ref AND i.source_owner_ref=? AND r.source_owner_ref=i.source_owner_ref
      ORDER BY i.transfer_id`, ownerRef, descriptor.sourceOwnerRef);
    const matched = [], excluded = [];
    for (const candidate of candidates) {
      const offer = parseStored(candidate.offer_json, '已导入原迁移请求');
      if (!plainObject(offer)) throw problem('MIGRATION_INSTALL_ORIGINAL_SOURCE_CHANGED', '原迁移请求归属格式无效', 409);
      const originalPair = get('SELECT * FROM backend_migration_pairings WHERE pairing_ref=? AND target_owner_ref=? AND source_owner_ref=?',
        offer.authenticationRef, ownerRef, descriptor.sourceOwnerRef);
      if (!originalPair) throw problem('MIGRATION_INSTALL_ORIGINAL_PAIRING_MISSING', '原已导入来源配对缺失，未关联安装', 409);
      const original = pairingDocuments(originalPair);
      if (offer.sessionId !== candidate.session_id || offer.targetOwnerRef !== ownerRef || offer.sourceOwnerRef !== descriptor.sourceOwnerRef
        || offer.targetAppId !== targetInfo.appId || offer.targetCloudRef !== targetInfo.cloudRef
        || offer.sourceDescriptorFingerprint !== original.descriptor.descriptorFingerprint
        || offer.sourceAppId !== original.descriptor.sourceAppId || offer.sourceCloudRef !== original.descriptor.sourceCloudRef
        || offer.sourceSignerPublicKey !== original.descriptor.sourceSignerPublicKey
        || offer.sourceSignerFingerprint !== original.descriptor.sourceSignerFingerprint) {
        throw problem('MIGRATION_INSTALL_ORIGINAL_SOURCE_CHANGED', '原迁入描述与原配对不一致，未关联安装', 409);
      }
      if (!sameSignerOrigin(original.descriptor, descriptor)) { excluded.push(candidate.transfer_id); continue; }
      if (original.authentication.installId && original.authentication.installId !== expectedInstallId) {
        throw problem('MIGRATION_INSTALL_BINDING_CONFLICT', '同签名来源的原已知安装与当前证明不同，未覆盖原身份', 409);
      }
      const member = get(`SELECT r.source_install_id,r.source_signer_fingerprint,r.source_owner_ref,r.source_app_id,r.source_cloud_ref
        FROM backend_migration_install_members m JOIN backend_migration_install_receipts r ON r.binding_ref=m.binding_ref
        WHERE m.transfer_id=? AND m.target_owner_ref=?`, candidate.transfer_id, ownerRef);
      if (member && (member.source_install_id !== expectedInstallId || member.source_signer_fingerprint !== descriptor.sourceSignerFingerprint
        || member.source_owner_ref !== descriptor.sourceOwnerRef || member.source_app_id !== descriptor.sourceAppId || member.source_cloud_ref !== descriptor.sourceCloudRef)) {
        throw problem('MIGRATION_INSTALL_BINDING_CONFLICT', '原迁入已有另一安装归属收据，未覆盖', 409);
      }
      matched.push({ transferId: candidate.transfer_id, originalPairingRef: offer.authenticationRef,
        originalDescriptorFingerprint: original.descriptor.descriptorFingerprint, alreadyBound: Boolean(member) });
    }
    if (!matched.length) throw problem('MIGRATION_INSTALL_NO_MATCHING_IMPORTS', '没有同来源签名和归属的已导入原资料可关联', 409);
    const evidence = { scope, sourceInstallId: expectedInstallId, sourceSignerFingerprint: descriptor.sourceSignerFingerprint,
      sourceDescriptorFingerprint: descriptor.descriptorFingerprint, matchedTransfers: matched, excludedTransferIds: excluded };
    const bindingRef = fingerprint({ ownerRef, commandId, proofFingerprint: fingerprint(proof) });
    run('INSERT INTO backend_migration_install_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', bindingRef, ownerRef, pairingRef, commandId,
      descriptor.sourceOwnerRef, descriptor.sourceAppId, descriptor.sourceCloudRef, descriptor.sourceSignerFingerprint,
      expectedInstallId, fingerprint(proof), canonical(proof), canonical(evidence), nowIso());
    for (const entry of matched) if (!entry.alreadyBound) run('INSERT INTO backend_migration_install_members VALUES(?,?,?,?,?,?)',
      entry.transferId, ownerRef, bindingRef, entry.originalPairingRef, entry.originalDescriptorFingerprint, nowIso());
    return { ok: true, bindingRef, reused: false, ...evidence };
  });
}

export function resolveArchivedSourceInstallBinding({ get, ownerRef, transferId, offer, descriptor, authentication }) {
  requireText(ownerRef, 'ownerRef'); requireText(transferId, 'transferId');
  validateSourceDescriptor(descriptor);
  if (!plainObject(offer) || !plainObject(authentication) || offer.targetOwnerRef !== ownerRef
    || offer.sourceOwnerRef !== descriptor.sourceOwnerRef || offer.sourceAppId !== descriptor.sourceAppId
    || offer.sourceCloudRef !== descriptor.sourceCloudRef || offer.sourceSignerPublicKey !== descriptor.sourceSignerPublicKey
    || offer.sourceSignerFingerprint !== descriptor.sourceSignerFingerprint || offer.sourceDescriptorFingerprint !== descriptor.descriptorFingerprint
    || authentication.signedIn !== true || authentication.authorized !== true || authentication.sourceOwnerRef !== descriptor.sourceOwnerRef
    || authentication.transport !== 'authenticated-device-loopback' || !authentication.evidenceRef) {
    throw problem('MIGRATION_DIGEST_SOURCE_UNPROVED', '原迁入来源归属与正常配对不符', 409);
  }
  const known = authentication.installId || null;
  if (known && !/^[a-f0-9]{32}$/.test(known)) throw problem('MIGRATION_DIGEST_SOURCE_INSTALL_UNPROVED', '原安装字段无效，不能忽略原身份', 409);
  const hasMembers = get("SELECT name FROM sqlite_master WHERE type='table' AND name='backend_migration_install_members'");
  const receipt = hasMembers && get(`SELECT r.*,m.original_pairing_ref,m.original_descriptor_fingerprint
    FROM backend_migration_install_members m JOIN backend_migration_install_receipts r ON r.binding_ref=m.binding_ref
    WHERE m.transfer_id=? AND m.target_owner_ref=? AND r.target_owner_ref=?`, transferId, ownerRef, ownerRef);
  if (!receipt) {
    if (known) return { installId: known, bindingRef: null };
    throw problem('MIGRATION_DIGEST_SOURCE_INSTALL_UNPROVED', '旧配对缺少安装字段，请用当前原签名来源完成显式关联收据', 409);
  }
  const proof = parseStored(receipt.proof_json, '原安装关联签名证明');
  // The original descriptor may have a different instance/version. Signature
  // verification uses the same public key, then the receipt's current paired
  // descriptor is checked separately; a process UUID is never install proof.
  const currentPair = get('SELECT * FROM backend_migration_pairings WHERE pairing_ref=? AND target_owner_ref=? AND source_owner_ref=?',
    receipt.pairing_ref, ownerRef, descriptor.sourceOwnerRef);
  if (!currentPair) throw problem('MIGRATION_DIGEST_INSTALL_RECEIPT_INVALID', '安装关联收据的当前配对缺失', 409);
  const current = pairingDocuments(currentPair), payload = signedInstallPayload(proof, current.descriptor);
  if (!sameSignerOrigin(descriptor, current.descriptor) || receipt.original_pairing_ref !== offer.authenticationRef
    || receipt.original_descriptor_fingerprint !== descriptor.descriptorFingerprint || receipt.proof_fingerprint !== fingerprint(proof)
    || receipt.source_install_id !== payload.sourceInstallId || current.authentication.installId !== payload.sourceInstallId
    || current.authentication.evidenceRef !== payload.sourceAuthenticationRef || payload.pairingRef !== receipt.pairing_ref
    || payload.commandId !== receipt.command_id || payload.targetOwnerRef !== ownerRef
    || payload.targetAppId !== offer.targetAppId || payload.targetCloudRef !== offer.targetCloudRef
    || receipt.source_owner_ref !== descriptor.sourceOwnerRef || receipt.source_app_id !== descriptor.sourceAppId
    || receipt.source_cloud_ref !== descriptor.sourceCloudRef || receipt.source_signer_fingerprint !== descriptor.sourceSignerFingerprint
    || known && known !== receipt.source_install_id) throw problem('MIGRATION_DIGEST_INSTALL_RECEIPT_INVALID', '安装关联收据与原迁入来源不一致', 409);
  return { installId: receipt.source_install_id, bindingRef: receipt.binding_ref };
}
function origin({ appId, cloudRef, ownerRef, installId }) {
  for (const [key, value] of Object.entries({ appId, cloudRef, ownerRef })) requireText(value, 'source.' + key);
  if (!/^[a-f0-9]{32}$/.test(installId || '')) throw problem('MIGRATION_DIGEST_SOURCE_INSTALL_UNPROVED', '逐行核证缺少原安装归属证明', 409);
  const value = { source_app_id: appId, source_cloud_ref: cloudRef, source_owner_ref: ownerRef, source_install_id: installId };
  return { source_origin_ref: fingerprint(value), ...value };
}
function sourceKey(sourceTable, key) {
  if (!plainObject(key)) throw problem('MIGRATION_DIGEST_PRIMARY_KEY_INVALID', '原主键元数据无效，原资料已保留', 409);
  const names = Object.keys(key).sort(), expected = [...TABLE_KEYS[sourceTable]].sort();
  const fallback = names.length === 1 && names[0] === 'originalRowFingerprint' && /^[a-f0-9]{64}$/.test(key.originalRowFingerprint || '');
  if (!fallback && canonical(names) !== canonical(expected)) throw problem('MIGRATION_DIGEST_PRIMARY_KEY_UNSUPPORTED', '原表主键与已核迁移合同不符，未返回其他原字段', 409);
  if (Object.values(key).some(value => value !== null && typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value)))) {
    throw problem('MIGRATION_DIGEST_PRIMARY_KEY_INVALID', '原主键值类型无效，原资料已保留', 409);
  }
  return canonical(key);
}
function collector() {
  const origins = new Map(), rows = new Map(), identities = new Map();
  let observations = 0;
  function add(source, sourceTable, key, rowFingerprint, snapshotRef) {
    if (!TABLES.includes(sourceTable) || !/^[a-f0-9]{64}$/.test(rowFingerprint || '')) throw problem('MIGRATION_DIGEST_ROW_INVALID', '原证据摘要元数据无效', 409);
    const sourceKeyText = sourceKey(sourceTable, key);
    if (Object.hasOwn(key, 'originalRowFingerprint') && key.originalRowFingerprint !== rowFingerprint) {
      throw problem('MIGRATION_DIGEST_PRIMARY_KEY_INVALID', '无主键原行的身份摘要与行摘要不符', 409);
    }
    origins.set(source.source_origin_ref, source);
    const identity = canonical([source.source_origin_ref, sourceTable, sourceKeyText]);
    const rowIdentity = canonical([identity, rowFingerprint]);
    observations += 1;
    if (!rows.has(rowIdentity)) rows.set(rowIdentity, { source_origin_ref: source.source_origin_ref,
      source_table: sourceTable, source_key: sourceKeyText, source_row_fingerprint: rowFingerprint });
    if (!identities.has(identity)) identities.set(identity, { source_origin_ref: source.source_origin_ref,
      source_table: sourceTable, source_key: sourceKeyText, variants: new Map() });
    const entry = identities.get(identity);
    if (!entry.variants.has(rowFingerprint)) entry.variants.set(rowFingerprint, new Set());
    if (snapshotRef) entry.variants.get(rowFingerprint).add(snapshotRef);
  }
  function finish(extra) {
    const digests = [...rows.values()].sort((left, right) => compare(canonical(left), canonical(right)));
    const conflicts = [...identities.values()].filter(entry => entry.variants.size > 1).map(entry => ({
      source_origin_ref: entry.source_origin_ref, source_table: entry.source_table, source_key: entry.source_key,
      variants: [...entry.variants].sort(([left], [right]) => compare(left, right)).map(([rowFingerprint, refs]) => ({
        source_row_fingerprint: rowFingerprint, snapshot_refs: [...refs].sort(compare) })),
    })).sort((left, right) => compare(canonical(left), canonical(right)));
    return { schemaVersion: 1, readOnly: true, canonicalVersion: 'backend/common.canonical/v1',
      rowFingerprintAlgorithm: 'sha256(canonical(complete_original_row))',
      sourceKeyAlgorithm: 'canonical(primary_key_object_or_originalRowFingerprint_fallback)',
      originAlgorithm: 'sha256(canonical(source_app_cloud_owner_install))',
      ...extra, origins: [...origins.values()].sort((left, right) => compare(left.source_origin_ref, right.source_origin_ref)),
      tables: TABLES.map(sourceTable => {
        const selected = digests.filter(row => row.source_table === sourceTable);
        return { source_table: sourceTable, row_count: selected.length,
          primary_key_count: [...identities.values()].filter(entry => entry.source_table === sourceTable).length,
          fingerprint: fingerprint(selected), rows: selected };
      }), totals: { observed_rows: observations, unique_rows: digests.length, primary_keys: identities.size,
        duplicate_observations: observations - digests.length, conflicts: conflicts.length },
      conflicts, conflictFree: conflicts.length === 0 };
  }
  return { add, finish, registerOrigin: source => origins.set(source.source_origin_ref, source) };
}

export function readSourceEvidenceDigests({ all, get, accountId, sourceOwnerRef, sourceInfo, assertStopped }) {
  if (typeof all !== 'function' || typeof get !== 'function' || typeof assertStopped !== 'function'
    || assertStopped.constructor?.name === 'AsyncFunction') throw new TypeError('Source evidence digests require synchronous read-only dependencies');
  if (!Number.isSafeInteger(accountId) || accountId < 1) throw problem('MIGRATION_ACCOUNT_INVALID', '迁移来源账号无效', 400);
  requireText(sourceOwnerRef, 'sourceOwnerRef');
  const source = origin({ ...sourceInfo, ownerRef: sourceOwnerRef });
  const checkStopped = () => {
    const result = assertStopped({ accountId, sourceOwnerRef });
    if (result?.then || result?.stopped !== true || result?.sourceFenceCommitted !== true || result?.currentInFlight !== false
      || result?.sourceOwnerRef !== sourceOwnerRef || !result?.fenceRef || !/^[a-f0-9]{64}$/.test(result.fenceFingerprint || '')) {
      throw problem('MIGRATION_SOURCE_NOT_STOPPED', '来源尚未证实停止和原栅栏，未读取证据摘要', 409);
    }
    return result;
  };
  const before = checkStopped();
  // Read account identity columns without its password/proxy/config. Derive
  // aliases as the full export (including removed IDs), without a signer.
  const account = get('SELECT id,panel_token,channel,username FROM accounts WHERE id=? AND panel_token=?', accountId, sourceOwnerRef);
  if (!account) throw problem('MIGRATION_ACCOUNT_OUT_OF_SCOPE', '来源账号不属于当前正常认证的软件身份', 403);
  const tableInfo = name => get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name)
    ? all('PRAGMA table_info(' + identifier(name) + ')') : null;
  function visit(name, predicates, onRow) {
    const info = tableInfo(name);
    if (!info) return { table: name, status: 'absent', primaryKey: [] };
    const columns = new Set(info.map(column => column.name));
    const primaryKey = info.filter(column => column.pk).sort((left, right) => left.pk - right.pk).map(column => column.name);
    if (TABLES.includes(name) && primaryKey.length && canonical([...primaryKey].sort()) !== canonical([...TABLE_KEYS[name]].sort())) {
      throw problem('MIGRATION_DIGEST_PRIMARY_KEY_UNSUPPORTED', '来源原表主键尚未核实，未输出其他原字段', 409);
    }
    let selected = false;
    for (const [column, values] of predicates) {
      if (!columns.has(column) || !values.length) continue;
      selected = true;
      for (let offset = 0; offset < values.length; offset += 500) {
        const batch = values.slice(offset, offset + 500);
        const ordering = primaryKey.length ? primaryKey.map(identifier).join(',') : 'rowid';
        for (let pageOffset = 0; ; pageOffset += 500) {
          const page = all('SELECT * FROM ' + identifier(name) + ' WHERE ' + identifier(column)
            + ' IN (' + batch.map(() => '?').join(',') + ') ORDER BY ' + ordering + ' LIMIT 500 OFFSET ?', ...batch, pageOffset);
          for (const row of page) onRow(row, primaryKey);
          if (page.length < 500) break;
        }
      }
    }
    return { table: name, status: selected ? 'read' : 'not-applicable', primaryKey };
  }
  const channel = String(account.channel || '').trim().normalize('NFKC').toLowerCase();
  const username = String(account.username || '').trim().normalize('NFKC').toLowerCase();
  if (!channel || !username) throw problem('MIGRATION_SUBJECT_UNAVAILABLE', '来源登录摘要身份不完整', 409);
  const subjectRefs = new Set([
    fingerprintText(['login-identity-digest', channel, username].join('\0')),
    fingerprintText([channel, username].join('\0')),
  ]);
  visit('game_subject_bindings', [['account_id', [accountId]]], binding => {
    if (binding.subject_ref && (!binding.panel_token || binding.panel_token === sourceOwnerRef)) subjectRefs.add(binding.subject_ref);
  });
  const accountIds = new Set([accountId]);
  visit('android_removed_accounts', [['subject_ref', [...subjectRefs]]], removed => {
    if (removed.panel_token === sourceOwnerRef) accountIds.add(removed.account_id);
  });
  const digest = collector(), operationIds = new Set(), tableReads = [];
  digest.registerOrigin(source);
  const add = (name, row, primaryKey) => {
    const rowFingerprint = fingerprint(row);
    const key = primaryKey.length ? Object.fromEntries(primaryKey.map(column => [column, row[column]]))
      : { originalRowFingerprint: rowFingerprint };
    digest.add(source, name, key, rowFingerprint, sourceInfo.instanceRef);
  };
  tableReads.push(visit('game_write_operations', [['account_id', [...accountIds]], ['subject_ref', [...subjectRefs]]], (row, key) => {
    operationIds.add(row.operation_id); add('game_write_operations', row, key);
  }));
  for (const name of TABLES.slice(1)) tableReads.push(visit(name, [['operation_id', [...operationIds]]], (row, key) => add(name, row, key)));
  const after = checkStopped();
  const latest = get('SELECT id,panel_token,channel,username FROM accounts WHERE id=? AND panel_token=?', accountId, sourceOwnerRef);
  if (canonical(latest) !== canonical(account) || before.fenceRef !== after.fenceRef || before.fenceFingerprint !== after.fenceFingerprint) {
    throw problem('MIGRATION_SOURCE_CHANGED', '摘要读取期间来源归属或原栅栏变化，未签完整性', 409);
  }
  return digest.finish({ side: 'source', accountId, selection: 'exportAccount.full.account_ids_OR_stable_subject_aliases',
    sourceVersion: sourceInfo.sourceVersion, sourceInstanceRef: sourceInfo.instanceRef, tableReads,
    stopped: true, sourceFenceUnchanged: true, originalRowsReturned: false, readAt: new Date().toISOString() });
}

// Keep the byte digest exactly equal to crypto.mjs.digestText without importing
// any signer/receiver helper into the legacy source closure.
const fingerprintText = value => crypto.createHash('sha256').update(value).digest('hex');

export function readImportedEvidenceDigests({ store, ownerRef, accountRef, subjectRef, includeRemoved = false, readOnlyArchive = false }) {
  for (const [key, value] of Object.entries({ ownerRef, accountRef, subjectRef })) requireText(value, key);
  const { all, get } = store;
  const archive = includeRemoved === true && readOnlyArchive === true;
  if ((includeRemoved === true || readOnlyArchive === true) && !archive) throw problem('MIGRATION_DIGEST_ARCHIVE_SCOPE_INVALID', '原证据读取需要明确的只读归档权限', 403);
  const account = get('SELECT subject_ref FROM backend_accounts WHERE owner_ref=? AND account_id=? AND removed_at IS ' + (archive ? 'NOT NULL' : 'NULL'), ownerRef, Number(accountRef));
  if (!account || account.subject_ref !== subjectRef) throw problem('MIGRATION_DIGEST_ACCOUNT_OUT_OF_SCOPE', '原证据不属于当前软件身份和游戏主体', 403);
  const imports = all(`SELECT i.transfer_id,i.session_id,i.source_owner_ref,r.offer_json
    FROM backend_migration_imports i JOIN backend_migration_receivers r ON r.session_id=i.session_id
    WHERE i.state='imported' AND r.state='imported' AND i.target_owner_ref=? AND i.target_account_ref=? AND i.target_subject_ref=?
    AND r.target_owner_ref=i.target_owner_ref AND r.source_owner_ref=i.source_owner_ref ORDER BY i.transfer_id`, ownerRef, accountRef, subjectRef);
  const bindings = new Map(), snapshots = [], digest = collector();
  for (const imported of imports) {
    const offer = parseStored(imported.offer_json, '原迁移请求归属');
    if (!plainObject(offer)) throw problem('MIGRATION_DIGEST_SOURCE_UNPROVED', '原迁移请求归属无效', 409);
    const pairing = get(`SELECT descriptor_json,source_authentication_json FROM backend_migration_pairings
      WHERE pairing_ref=? AND target_owner_ref=? AND source_owner_ref=?`, offer.authenticationRef, ownerRef, imported.source_owner_ref);
    if (!pairing) throw problem('MIGRATION_DIGEST_SOURCE_UNPROVED', '原证据缺少正常软件来源配对，未跨来源折叠', 409);
    const descriptor = parseStored(pairing.descriptor_json, '原迁移来源描述');
    const authentication = parseStored(pairing.source_authentication_json, '原迁移来源软件身份');
    if (!plainObject(descriptor) || !plainObject(authentication)
      || offer.sessionId !== imported.session_id || offer.targetOwnerRef !== ownerRef || offer.sourceOwnerRef !== imported.source_owner_ref
      || descriptor.sourceOwnerRef !== imported.source_owner_ref || descriptor.sourceAppId !== offer.sourceAppId
      || descriptor.sourceCloudRef !== offer.sourceCloudRef || descriptor.descriptorFingerprint !== offer.sourceDescriptorFingerprint
      || authentication.signedIn !== true || authentication.authorized !== true || authentication.sourceOwnerRef !== imported.source_owner_ref
      || authentication.transport !== 'authenticated-device-loopback' || !authentication.evidenceRef) {
      throw problem('MIGRATION_DIGEST_SOURCE_UNPROVED', '原证据来源描述和软件配对不一致，未跨来源折叠', 409);
    }
    const installBinding = resolveArchivedSourceInstallBinding({ get, ownerRef, transferId: imported.transfer_id, offer, descriptor, authentication });
    const source = origin({ appId: offer.sourceAppId, cloudRef: offer.sourceCloudRef, ownerRef: imported.source_owner_ref, installId: installBinding.installId });
    bindings.set(imported.transfer_id, { source, instanceRef: descriptor.sourceInstanceRef });
    digest.registerOrigin(source);
    snapshots.push({ transferId: imported.transfer_id, source_origin_ref: source.source_origin_ref,
      sourceInstanceRef: descriptor.sourceInstanceRef, sourceVersion: descriptor.sourceVersion, installBindingRef: installBinding.bindingRef });
  }
  let after = '';
  for (;;) {
    const page = all(`SELECT a.archive_id,a.transfer_id,a.source_instance_ref,a.source_owner_ref,a.source_table,
      a.source_primary_key_json,a.source_row_fingerprint
      FROM backend_legacy_archives a JOIN backend_migration_imports i ON i.transfer_id=a.transfer_id
      WHERE i.state='imported' AND i.target_owner_ref=? AND i.target_account_ref=? AND i.target_subject_ref=?
      AND a.target_owner_ref=i.target_owner_ref AND a.target_account_ref=i.target_account_ref AND a.target_subject_ref=i.target_subject_ref
      AND a.source_owner_ref=i.source_owner_ref AND a.source_table IN (?,?,?,?) AND a.archive_id>?
      ORDER BY a.archive_id LIMIT 500`, ownerRef, accountRef, subjectRef, ...TABLES, after);
    for (const archive of page) {
      const binding = bindings.get(archive.transfer_id);
      if (!binding || archive.source_instance_ref !== binding.instanceRef) throw problem('MIGRATION_DIGEST_ARCHIVE_SOURCE_CHANGED', '原证据快照来源与已导入配对不符', 409);
      digest.add(binding.source, archive.source_table, parseStored(archive.source_primary_key_json, '原证据主键'), archive.source_row_fingerprint, archive.transfer_id);
    }
    if (page.length < 500) break;
    after = page.at(-1).archive_id;
  }
  return digest.finish({ side: 'target', accountRef, selection: 'imported_exact_owner_account_subject_original_archives', importedSnapshotCount: snapshots.length,
    snapshots, fingerprintBasis: 'immutable_receiver_original_row_fingerprint_metadata',
    decryptedEnvelopes: false, originalRowsReturned: false, readAt: new Date().toISOString() });
}
