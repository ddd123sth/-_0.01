import crypto from 'node:crypto';
import fs from 'node:fs';
import { canonical, freeze, plainObject } from './common.mjs';

export const ART_FIRST_REWARD_EXTENSION_ID = 'art-first-reward-public-source/v1';
const PIN_BYTES = fs.readFileSync(new URL('./contracts/art-first-reward-source-contract-v1.json', import.meta.url));
const PIN_HASH = 'fa6b9f8d718e525d92155494e9dc3477ca8c413150ea8119b2e44b79a892a4aa';
export const ART_FIRST_REWARD_SOURCE_PIN = 'sha256:' + PIN_HASH;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

export function proveArtFirstRewardExtensionSource(gameBytes) {
  if (sha256(PIN_BYTES) !== PIN_HASH || !Buffer.isBuffer(gameBytes) || gameBytes.length > 8 * 1024 * 1024) return null;
  let pin; try { pin = JSON.parse(PIN_BYTES.toString('utf8')); } catch { return null; }
  if (pin?.schema !== 'official-art-first-reward-source-extension/v1' || pin.sourceVersion !== '480.0.46' ||
      !Array.isArray(pin.blocks) || pin.blocks.length !== 13) return null;
  const matchedRanges = [];
  for (const row of pin.blocks) {
    if (typeof row.base64 !== 'string' || !Number.isSafeInteger(row.byteLength) || row.byteLength < 1) return null;
    const bytes = Buffer.from(row.base64, 'base64'), offset = gameBytes.indexOf(bytes);
    if (bytes.length !== row.byteLength || sha256(bytes) !== row.sha256 || offset < 0 || gameBytes.indexOf(bytes, offset + 1) >= 0) return null;
    matchedRanges.push({ name: row.name, pinnedStart: row.start, pinnedEnd: row.end, actualStart: offset,
      actualEnd: offset + bytes.length, sha256: row.sha256 });
  }
  return freeze({ extensionId: ART_FIRST_REWARD_EXTENSION_ID, sourcePin: ART_FIRST_REWARD_SOURCE_PIN,
    sourceReferenceVersion: pin.sourceVersion, sourceReferenceSha256: pin.sourceSha256, gameSha256: sha256(gameBytes), matchedRanges });
}

export function bindArtFirstRewardExtension({ baseDataSnapshotId, bundleRef, loginResponseRef, resourceSha256, sourceVersion, sourceProof } = {}) {
  if (!/^sha256:[a-f0-9]{64}$/.test(baseDataSnapshotId || '') || typeof bundleRef !== 'string' || !bundleRef ||
      typeof loginResponseRef !== 'string' || !loginResponseRef || !/^[a-f0-9]{64}$/.test(resourceSha256 || '') ||
      typeof sourceVersion !== 'string' || !/^[0-9]+(?:\.[0-9]+){1,5}$/.test(sourceVersion) ||
      sourceProof?.extensionId !== ART_FIRST_REWARD_EXTENSION_ID || sourceProof?.sourcePin !== ART_FIRST_REWARD_SOURCE_PIN ||
      !Array.isArray(sourceProof.matchedRanges) || sourceProof.matchedRanges.length !== 13) return null;
  const data = { extensionId: ART_FIRST_REWARD_EXTENSION_ID, sourcePin: ART_FIRST_REWARD_SOURCE_PIN, sourceVersion,
    baseDataSnapshotId, bundleRef, loginResponseRef, resourceSha256, sourceProof,
    actions: { album: { method: 'collectRwd.recvArtCreateRwdByVase', argField: 'flowerArtId', meaning: 'vaseId' },
      share: { method: 'usr.share', shareId: 6, allowedDirectOpType: 2, meaning: 'request-only-no-sdk-token' } } };
  return freeze({ ...data, extensionRef: 'sha256:' + sha256(Buffer.from(canonical(data))) });
}
