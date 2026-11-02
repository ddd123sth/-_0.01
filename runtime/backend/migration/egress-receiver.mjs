import { canonical, newId, parseStored, plainObject, problem, requireText } from '../common.mjs';
import { generateReceiverKeyPair, MIGRATION_PROTOCOL_VERSION, openMigrationPayload, publicKeyFingerprint,
  validateOffer, validateSourceDescriptor, verifySourceAttestation } from './crypto.mjs';
const EGRESS_MIGRATION_KIND = 'garden-device-egress-v1';

function ownerMapping(proof, sourceOwnerRef, targetOwnerRef) {
  if (proof?.authorized !== true || proof.sourceOwnerRef !== sourceOwnerRef || proof.targetOwnerRef !== targetOwnerRef
    || !proof.mappingRef || !proof.sourceAuthenticationRef || !proof.targetAuthenticationRef) {
    throw problem('EGRESS_OWNER_MAPPING_REQUIRED', '出口迁移双方尚无正常认证的软件身份映射', 403);
  }
  return proof;
}
function encrypt(cipher, value) {
  const result = cipher.encrypt(value);
  if (typeof result !== 'string' || !result || result === value) throw new TypeError('Egress migration needs synchronous protected encryption');
  return result;
}
function publicAddress(proxy) {
  if (typeof proxy !== 'string' || proxy.length > 4096 || proxy !== proxy.trim() || /[\r\n\0]/.test(proxy)) throw problem('EGRESS_MIGRATION_PAYLOAD_INVALID', '出口迁移内容格式无效', 400);
  if (!proxy) return { configured: false, routing: 'direct', host: null, port: null, protocol: null };
  try {
    const parsed = new URL(proxy);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error();
    return { configured: true, routing: 'proxy', host: parsed.hostname,
      port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)), protocol: parsed.protocol.slice(0, -1) };
  } catch { throw problem('EGRESS_MIGRATION_PAYLOAD_INVALID', '出口迁移内容格式无效', 400); }
}

export function createEgressReceiver({ store, cipher, targetInfo, authorizeOwnerMapping, assertStopped, applyEgress, clock = () => Date.now() }) {
  for (const callback of [cipher?.encrypt, cipher?.decrypt, authorizeOwnerMapping, assertStopped, applyEgress]) {
    if (typeof callback !== 'function') throw new TypeError('Egress receiver requires cipher, owner mapping and stopped-route dependencies');
  }
  if ([assertStopped, applyEgress].some(callback => callback.constructor?.name === 'AsyncFunction')) throw new TypeError('Target egress gate and save must be synchronous');
  for (const key of ['appId', 'cloudRef', 'sourceVersion']) requireText(targetInfo?.[key], key);
  const { get, run, transaction, nowIso } = store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_egress_receivers(
    session_id TEXT PRIMARY KEY,target_owner_ref TEXT NOT NULL,source_owner_ref TEXT NOT NULL,
    command_id TEXT NOT NULL,offer_json TEXT NOT NULL,private_key_cipher TEXT,expires_at_ms INTEGER NOT NULL,
    state TEXT NOT NULL,envelope_fingerprint TEXT,result_json TEXT,created_at TEXT NOT NULL,completed_at TEXT,
    UNIQUE(target_owner_ref,command_id));`);
  function session(sessionId, targetOwnerRef) {
    const row = get('SELECT * FROM backend_egress_receivers WHERE session_id=? AND target_owner_ref=?', requireText(sessionId, 'sessionId'), requireText(targetOwnerRef, 'targetOwnerRef'));
    if (!row) throw problem('EGRESS_MIGRATION_SESSION_MISSING', '出口迁移接收会话不存在', 404);
    return row;
  }
  async function createOffer({ targetOwnerRef, sourceOwnerRef, sourceAppId, sourceCloudRef, sourceDescriptor,
    authenticationRef, commandId = newId(), ttlMs = 15 * 60_000 }) {
    for (const [name, value] of Object.entries({ targetOwnerRef, sourceOwnerRef, sourceAppId, sourceCloudRef, authenticationRef, commandId })) requireText(value, name);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 60 * 60_000) throw problem('EGRESS_MIGRATION_EXPIRY_INVALID', '出口接收请求有效期须为1至60分钟', 400);
    validateSourceDescriptor(sourceDescriptor);
    if (sourceDescriptor.sourceOwnerRef !== sourceOwnerRef || sourceDescriptor.sourceAppId !== sourceAppId || sourceDescriptor.sourceCloudRef !== sourceCloudRef) {
      throw problem('EGRESS_MIGRATION_SOURCE_INVALID', '出口来源描述不属于已选择的软件身份', 403);
    }
    ownerMapping(await authorizeOwnerMapping({ purpose: 'create-egress-offer', sourceOwnerRef, targetOwnerRef,
      sourceAppId, sourceCloudRef, sourceDescriptor, authenticationRef, targetInfo }), sourceOwnerRef, targetOwnerRef);
    return transaction(() => {
      const fresh = authorizeOwnerMapping({ purpose: 'commit-egress-offer', sourceOwnerRef, targetOwnerRef,
        sourceAppId, sourceCloudRef, sourceDescriptor, authenticationRef, targetInfo });
      if (fresh && typeof fresh.then === 'function') throw new TypeError('Final egress owner authorization must be synchronous');
      ownerMapping(fresh, sourceOwnerRef, targetOwnerRef);
      const old = get('SELECT * FROM backend_egress_receivers WHERE target_owner_ref=? AND command_id=?', targetOwnerRef, commandId);
      if (old) {
        const offer = parseStored(old.offer_json, '出口接收请求');
        if (offer.sourceDescriptorFingerprint !== sourceDescriptor.descriptorFingerprint || offer.authenticationRef !== authenticationRef
          || offer.sourceOwnerRef !== sourceOwnerRef || offer.sourceAppId !== sourceAppId || offer.sourceCloudRef !== sourceCloudRef) {
          throw problem('EGRESS_MIGRATION_COMMAND_CONFLICT', '同一出口接收指令不能更换来源或身份', 409);
        }
        if (old.state !== 'offered') throw problem('EGRESS_MIGRATION_ALREADY_USED', '出口接收请求已经使用', 409);
        return validateOffer(offer, clock());
      }
      const pair = generateReceiverKeyPair();
      const offer = { protocolVersion: MIGRATION_PROTOCOL_VERSION, kind: EGRESS_MIGRATION_KIND, sessionId: newId(),
        targetOwnerRef, sourceOwnerRef, sourceAppId, sourceCloudRef, targetAppId: targetInfo.appId, targetCloudRef: targetInfo.cloudRef,
        targetVersion: targetInfo.sourceVersion, targetPublicKey: pair.publicKey, targetFingerprint: publicKeyFingerprint(pair.publicKey),
        sourceSignerPublicKey: sourceDescriptor.sourceSignerPublicKey, sourceSignerFingerprint: sourceDescriptor.sourceSignerFingerprint,
        sourceDescriptorFingerprint: sourceDescriptor.descriptorFingerprint, authenticationRef,
        createdAt: new Date(clock()).toISOString(), expiresAtMs: clock() + ttlMs };
      const encrypted = encrypt(cipher, pair.privateKey); pair.privateKey = '';
      run("INSERT INTO backend_egress_receivers VALUES(?,?,?,?,?,?,?,'offered',NULL,NULL,?,NULL)", offer.sessionId,
        targetOwnerRef, sourceOwnerRef, commandId, canonical(offer), encrypted, offer.expiresAtMs, nowIso());
      return offer;
    });
  }
  async function importEnvelope({ targetOwnerRef, sessionId, envelope, expectedPublicAddress = null }) {
    const row = session(sessionId, targetOwnerRef), offer = parseStored(row.offer_json, '出口接收请求');
    if (!plainObject(envelope) || offer.kind !== EGRESS_MIGRATION_KIND || canonical(envelope.offer) !== canonical(offer)
      || offer.targetAppId !== targetInfo.appId || offer.targetCloudRef !== targetInfo.cloudRef
      || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > 128 * 1024) {
      throw problem('EGRESS_MIGRATION_TARGET_INVALID', '出口密文不属于本次目标身份或接收会话', 400);
    }
    const verified = verifySourceAttestation(envelope), envelopeFingerprint = verified.sealedFingerprint;
    const proof = ownerMapping(await authorizeOwnerMapping({ purpose: 'import-device-egress', sourceOwnerRef: offer.sourceOwnerRef,
      targetOwnerRef, sourceAppId: offer.sourceAppId, sourceCloudRef: offer.sourceCloudRef, offer,
      authenticationRef: offer.authenticationRef, sourceAttestation: verified.sourceAttestation, targetInfo }), offer.sourceOwnerRef, targetOwnerRef);
    if (verified.sourceAttestation.sourceAuthenticationRef !== proof.sourceAuthenticationRef) throw problem('EGRESS_MIGRATION_AUTH_CHANGED', '出口来源认证与本次正常配对不一致', 403);
    if (row.state === 'imported') {
      if (row.envelope_fingerprint !== envelopeFingerprint) throw problem('EGRESS_MIGRATION_REPLAY_CONFLICT', '已使用的出口会话不能导入其他密文', 409);
      return { ...parseStored(row.result_json, '出口接收回执'), applied: false, replay: true };
    }
    validateOffer(offer, clock());
    if (row.state !== 'offered' || !row.private_key_cipher) throw problem('EGRESS_MIGRATION_ALREADY_USED', '出口接收私钥已消费', 409);
    let privateKey = cipher.decrypt(row.private_key_cipher), payload;
    try {
      payload = openMigrationPayload(envelope, privateKey);
      if (!plainObject(payload) || payload.protocolVersion !== MIGRATION_PROTOCOL_VERSION || payload.kind !== EGRESS_MIGRATION_KIND
        || payload.source?.ownerRef !== offer.sourceOwnerRef || payload.source?.appId !== offer.sourceAppId || payload.source?.cloudRef !== offer.sourceCloudRef
        || payload.target?.ownerRef !== targetOwnerRef || payload.target?.appId !== offer.targetAppId || payload.target?.cloudRef !== offer.targetCloudRef
        || payload.target?.sessionId !== offer.sessionId || payload.target?.fingerprint !== offer.targetFingerprint || !payload.transferId
        || payload.ownershipProof?.sourceAuthenticationRef !== proof.sourceAuthenticationRef
        || !Array.isArray(payload.stopProofs) || payload.stopProofs.length !== 2 || payload.stopProofs.some(stop => stop.stopped !== true
          || stop.currentInFlight !== false || stop.sourceOwnerRef !== offer.sourceOwnerRef || stop.runningCount !== 0 || stop.pendingCount !== 0 || stop.verificationCount !== 0)) {
        throw problem('EGRESS_MIGRATION_PAYLOAD_INVALID', '出口来源、停止证明或目标身份不完整', 400);
      }
      const address = publicAddress(payload.proxy);
      if (expectedPublicAddress !== null && expectedPublicAddress !== (address.host ? address.host + ':' + address.port : 'direct')) {
        throw problem('EGRESS_MIGRATION_SELECTION_CHANGED', '密文出口与已选择的公开出口不一致', 409);
      }
      return transaction(() => {
        const latest = session(sessionId, targetOwnerRef);
        if (latest.state !== 'offered' || latest.private_key_cipher !== row.private_key_cipher) throw problem('EGRESS_MIGRATION_ALREADY_USED', '出口迁移请求已被其他操作使用', 409);
        validateOffer(offer, clock());
        const fresh = authorizeOwnerMapping({ purpose: 'commit-egress-import', sourceOwnerRef: offer.sourceOwnerRef,
          targetOwnerRef, sourceAppId: offer.sourceAppId, sourceCloudRef: offer.sourceCloudRef, offer,
          authenticationRef: offer.authenticationRef, sourceAttestation: verified.sourceAttestation, targetInfo });
        if (fresh && typeof fresh.then === 'function') throw new TypeError('Final egress owner authorization must be synchronous');
        ownerMapping(fresh, offer.sourceOwnerRef, targetOwnerRef);
        if (fresh.mappingRef !== proof.mappingRef || fresh.sourceAuthenticationRef !== proof.sourceAuthenticationRef
          || fresh.targetAuthenticationRef !== proof.targetAuthenticationRef) throw problem('EGRESS_MIGRATION_AUTH_CHANGED', '保存出口前正常身份映射已变化', 403);
        const stopped = assertStopped({ ownerRef: targetOwnerRef });
        if (stopped && typeof stopped.then === 'function') throw new TypeError('Egress target stop gate must be synchronous');
        const saved = applyEgress({ proxy: payload.proxy });
        if (saved && typeof saved.then === 'function') throw new TypeError('Egress target save must be synchronous');
        if (!saved || saved.hasOverride !== true || saved.configured !== address.configured || saved.routing !== address.routing
          || typeof saved.updatedAt !== 'string' || !Number.isFinite(Date.parse(saved.updatedAt))) {
          throw problem('EGRESS_MIGRATION_SAVE_UNCONFIRMED', '出口保存缺少持久设置回执，本次事务没有消费接收私钥', 503);
        }
        if (address.configured) {
          let actual;
          try { actual = new URL(saved.display); } catch { throw problem('EGRESS_MIGRATION_SAVE_UNCONFIRMED', '出口保存回执未提供可核对公开地址', 503); }
          if (actual.hostname !== address.host || Number(actual.port || (actual.protocol === 'https:' ? 443 : 80)) !== address.port
            || actual.username || actual.password) throw problem('EGRESS_MIGRATION_SAVE_UNCONFIRMED', '出口保存回执公开地址未对平', 503);
        }
        const receipt = { ok: true, applied: true, replay: false, sessionId, transferId: payload.transferId, publicAddress: address,
          sourceOwnerRef: offer.sourceOwnerRef, targetOwnerRef, sourceDescriptorFingerprint: offer.sourceDescriptorFingerprint,
          envelopeFingerprint, sourceProvenanceKind: payload.provenance?.kind || 'not-provided', appliedAt: nowIso() };
        run("UPDATE backend_egress_receivers SET state='imported',private_key_cipher=NULL,envelope_fingerprint=?,result_json=?,completed_at=? WHERE session_id=? AND state='offered'",
          envelopeFingerprint, canonical(receipt), receipt.appliedAt, sessionId);
        return receipt;
      });
    } finally { privateKey = ''; if (payload) payload.proxy = ''; }
  }
  function status({ targetOwnerRef, sessionId }) {
    const row = session(sessionId, targetOwnerRef);
    return { sessionId, state: row.state, expiresAtMs: row.expires_at_ms,
      privateKeyAvailable: Boolean(row.private_key_cipher), receipt: row.result_json ? parseStored(row.result_json, '出口回执') : null };
  }
  return Object.freeze({ createOffer, importEnvelope, status });
}

