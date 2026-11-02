import crypto from 'node:crypto';
import { canonical, plainObject, problem, requireText } from '../common.mjs';

export const MIGRATION_PROTOCOL_VERSION = 1;
const CONTEXT = 'wujinxia/android/controlled-account-migration/v1';
export const digestText = value => crypto.createHash('sha256').update(value).digest('hex');
export const operationIdentityDigest = operationId => digestText('wujinxia/legacy-operation-id/v1\0' + requireText(operationId, 'sourceOperationId'));
export function signerFingerprint(publicKey) {
  const key = crypto.createPublicKey({ key: Buffer.from(requireText(publicKey, 'sourceSignerPublicKey'), 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw problem('MIGRATION_SIGNER_TYPE_INVALID', '迁移来源签名公钥类型不正确', 400);
  return digestText(key.export({ format: 'der', type: 'spki' }));
}
export function sourceDescriptor({ sourceInfo, sourceOwnerRef, signerPublicKey }) {
  const body = { protocolVersion: MIGRATION_PROTOCOL_VERSION, sourceOwnerRef,
    sourceAppId: sourceInfo.appId, sourceCloudRef: sourceInfo.cloudRef, sourceVersion: sourceInfo.sourceVersion,
    sourceInstanceRef: sourceInfo.instanceRef, sourceSignerPublicKey: signerPublicKey,
    sourceSignerFingerprint: signerFingerprint(signerPublicKey) };
  return { ...body, descriptorFingerprint: digestText(canonical(body)) };
}
export function validateSourceDescriptor(descriptor) {
  if (!plainObject(descriptor) || descriptor.protocolVersion !== MIGRATION_PROTOCOL_VERSION) throw problem('MIGRATION_SOURCE_DESCRIPTOR_INVALID', '迁移来源描述版本无效', 400);
  for (const key of ['sourceOwnerRef', 'sourceAppId', 'sourceCloudRef', 'sourceVersion', 'sourceInstanceRef',
    'sourceSignerPublicKey', 'sourceSignerFingerprint', 'descriptorFingerprint']) requireText(descriptor[key], key);
  const { descriptorFingerprint, ...body } = descriptor;
  if (signerFingerprint(descriptor.sourceSignerPublicKey) !== descriptor.sourceSignerFingerprint
    || digestText(canonical(body)) !== descriptorFingerprint) throw problem('MIGRATION_SOURCE_DESCRIPTOR_INVALID', '迁移来源描述指纹不一致', 400);
  return descriptor;
}
export function signatureMessage({ envelopeFingerprint, offer, signedAt, sourceAuthenticationRef }) {
  return Buffer.from(canonical({ context: CONTEXT + '/source-ed25519', protocolVersion: MIGRATION_PROTOCOL_VERSION,
    envelopeFingerprint, sessionId: offer.sessionId, sourceOwnerRef: offer.sourceOwnerRef,
    targetOwnerRef: offer.targetOwnerRef, targetFingerprint: offer.targetFingerprint,
    sourceDescriptorFingerprint: offer.sourceDescriptorFingerprint, signedAt, sourceAuthenticationRef }), 'utf8');
}
export function verifySourceAttestation(envelope) {
  const { sourceAttestation, ...sealed } = envelope;
  const offer = envelope.offer;
  const envelopeFingerprint = digestText(canonical(sealed));
  if (!plainObject(sourceAttestation) || sourceAttestation.envelopeFingerprint !== envelopeFingerprint
    || sourceAttestation.sourceOwnerRef !== offer.sourceOwnerRef || sourceAttestation.targetOwnerRef !== offer.targetOwnerRef
    || sourceAttestation.sessionId !== offer.sessionId || sourceAttestation.targetFingerprint !== offer.targetFingerprint
    || sourceAttestation.sourceDescriptorFingerprint !== offer.sourceDescriptorFingerprint
    || sourceAttestation.sourceSignerFingerprint !== offer.sourceSignerFingerprint) throw problem('MIGRATION_SOURCE_ATTESTATION_REQUIRED', '迁移密文来源认证绑定不完整', 403);
  requireText(sourceAttestation.sourceAuthenticationRef, 'sourceAuthenticationRef');
  requireText(sourceAttestation.signedAt, 'signedAt');
  if (!Number.isFinite(Date.parse(sourceAttestation.signedAt))) throw problem('MIGRATION_SOURCE_ATTESTATION_INVALID', '迁移来源签名时刻无效', 403);
  const key = crypto.createPublicKey({ key: Buffer.from(offer.sourceSignerPublicKey, 'base64'), format: 'der', type: 'spki' });
  const signature = Buffer.from(requireText(sourceAttestation.signature, 'signature'), 'base64');
  if (signature.length !== 64 || key.asymmetricKeyType !== 'ed25519' || signerFingerprint(offer.sourceSignerPublicKey) !== offer.sourceSignerFingerprint
    || !crypto.verify(null, signatureMessage({ envelopeFingerprint, offer, signedAt: sourceAttestation.signedAt,
      sourceAuthenticationRef: sourceAttestation.sourceAuthenticationRef }), key, signature)) {
    throw problem('MIGRATION_SOURCE_SIGNATURE_INVALID', '迁移密文未通过已配对来源公钥签名验证', 403);
  }
  return { sealedFingerprint: envelopeFingerprint, sourceAttestation };
}
export function publicKeyFingerprint(publicKey) {
  const key = crypto.createPublicKey({ key: Buffer.from(requireText(publicKey, 'publicKey'), 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'x25519') throw problem('MIGRATION_KEY_TYPE_INVALID', '迁移接收公钥类型不正确', 400);
  return digestText(key.export({ format: 'der', type: 'spki' }));
}
export function generateReceiverKeyPair() {
  const pair = crypto.generateKeyPairSync('x25519');
  return { publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') };
}
export function validateOffer(offer, nowMs) {
  if (!plainObject(offer) || offer.protocolVersion !== MIGRATION_PROTOCOL_VERSION) throw problem('MIGRATION_OFFER_INVALID', '迁移接收请求版本不支持', 400);
  for (const key of ['sessionId', 'targetOwnerRef', 'sourceOwnerRef', 'sourceAppId', 'sourceCloudRef', 'targetAppId', 'targetCloudRef', 'targetVersion', 'targetPublicKey', 'targetFingerprint',
    'sourceSignerPublicKey', 'sourceSignerFingerprint', 'sourceDescriptorFingerprint', 'authenticationRef', 'createdAt']) requireText(offer[key], key);
  if (!Number.isSafeInteger(offer.expiresAtMs) || offer.expiresAtMs <= nowMs || !Number.isFinite(Date.parse(offer.createdAt))) {
    throw problem('MIGRATION_OFFER_EXPIRED', '迁移接收请求已过期或时刻无效', 410);
  }
  if (publicKeyFingerprint(offer.targetPublicKey) !== offer.targetFingerprint) throw problem('MIGRATION_KEY_FINGERPRINT_INVALID', '迁移公钥指纹不一致', 400);
  if (signerFingerprint(offer.sourceSignerPublicKey) !== offer.sourceSignerFingerprint) throw problem('MIGRATION_SOURCE_DESCRIPTOR_INVALID', '迁移来源签名公钥指纹不一致', 400);
  if (offer.supplementOf !== undefined && offer.supplementOf !== null) {
    requireText(offer.supplementOf, 'supplementOf');
    const binding = offer.supplement;
    if (!plainObject(binding) || binding.originalSessionId !== offer.supplementOf || !Number.isSafeInteger(binding.serverId) || binding.serverId < 1
      || !Array.isArray(binding.coveredOperationDigests) || binding.coveredOperationDigests.some(value => !/^[a-f0-9]{64}$/.test(value))) {
      throw problem('MIGRATION_SUPPLEMENT_BINDING_INVALID', '补充证据请求缺少原会话和既有身份绑定', 400);
    }
    for (const field of ['targetAccountRef', 'targetSubjectRef', 'originalVerificationRef', 'sourceAccountRef', 'originalTransferId', 'originalTargetFingerprint']) requireText(binding[field], 'supplement.' + field);
  }
  return offer;
}
export function sealMigrationPayload(offer, payload) {
  const ephemeral = crypto.generateKeyPairSync('x25519');
  const receiver = crypto.createPublicKey({ key: Buffer.from(offer.targetPublicKey, 'base64'), format: 'der', type: 'spki' });
  const ephemeralPublicKey = ephemeral.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const salt = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const header = { protocolVersion: MIGRATION_PROTOCOL_VERSION, offer, ephemeralPublicKey,
    salt: salt.toString('base64'), iv: iv.toString('base64') };
  const shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: receiver });
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from(CONTEXT), 32));
  const plaintext = Buffer.from(canonical(payload), 'utf8');
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(canonical(header), 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { ...header, ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  } finally { shared.fill(0); key.fill(0); plaintext.fill(0); }
}
export function openMigrationPayload(envelope, privateKey) {
  if (!plainObject(envelope) || envelope.protocolVersion !== MIGRATION_PROTOCOL_VERSION || !plainObject(envelope.offer)) throw problem('MIGRATION_ENVELOPE_INVALID', '迁移密文格式不正确', 400);
  // Source attestation authenticates the already sealed envelope through the
  // project's trusted identity channel. It is not part of the AEAD header.
  const { ciphertext, tag, sourceAttestation, ...header } = envelope;
  for (const key of ['ephemeralPublicKey', 'salt', 'iv']) requireText(header[key], key);
  const ephemeral = crypto.createPublicKey({ key: Buffer.from(header.ephemeralPublicKey, 'base64'), format: 'der', type: 'spki' });
  if (ephemeral.asymmetricKeyType !== 'x25519') throw problem('MIGRATION_KEY_TYPE_INVALID', '迁移发送公钥类型不正确', 400);
  const secret = crypto.createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  const salt = Buffer.from(header.salt, 'base64'), iv = Buffer.from(header.iv, 'base64'), authTag = Buffer.from(requireText(tag, 'tag'), 'base64');
  if (salt.length !== 32 || iv.length !== 12 || authTag.length !== 16 || typeof ciphertext !== 'string') throw problem('MIGRATION_ENVELOPE_INVALID', '迁移密文参数不正确', 400);
  const shared = crypto.diffieHellman({ privateKey: secret, publicKey: ephemeral });
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from(CONTEXT), 32));
  let plaintext;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(canonical(header), 'utf8')); decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw problem('MIGRATION_AUTHENTICATION_FAILED', '迁移密文认证失败，原资料未修改', 400);
  } finally { shared.fill(0); key.fill(0); plaintext?.fill(0); }
}
