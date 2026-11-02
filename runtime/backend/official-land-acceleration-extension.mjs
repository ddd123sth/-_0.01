import crypto from 'node:crypto';
import fs from 'node:fs';
import { canonical, freeze, plainObject } from './common.mjs';

// This extension is deliberately outside official-source-blocks-v1,
// OFFICIAL_CORE_CONTRACT and versionEvidence.sourceProofs. It is bound to the
// already validated base bundle and current login, then checked at its own
// stable source/table namespace.
export const LAND_ACCELERATION_EXTENSION_ID = 'land-acceleration-public-data/v1';
const SOURCE_PIN_BYTES = fs.readFileSync(new URL('./contracts/land-acceleration-extension-v1.json', import.meta.url));
const SOURCE_PIN_SHA256 = '02e23995642bbc2eb4ee7923299e036ff9961dc42fd8bb706b7bd8d95ab6ec23';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const LAND_ACCELERATION_SOURCE_PIN = 'sha256:' + SOURCE_PIN_SHA256;

export function proveLandAccelerationExtensionSource(gameBytes) {
  if (sha256(SOURCE_PIN_BYTES) !== SOURCE_PIN_SHA256 || !Buffer.isBuffer(gameBytes) || gameBytes.length > 8 * 1024 * 1024) return null;
  let contract;
  try { contract = JSON.parse(SOURCE_PIN_BYTES.toString('utf8')); } catch { return null; }
  if (contract?.schema !== 'land-acceleration-source-extension/v1' || !Array.isArray(contract.blocks) || contract.blocks.length !== 7) return null;
  const matchedRanges = [];
  for (const range of contract.blocks) {
    if (typeof range.base64 !== 'string' || !Number.isSafeInteger(range.byteLength) || range.byteLength < 1) return null;
    const block = Buffer.from(range.base64, 'base64');
    if (block.length !== range.byteLength || sha256(block) !== range.sha256) return null;
    const offset = gameBytes.indexOf(block);
    if (offset < 0 || gameBytes.indexOf(block, offset + 1) >= 0) return null;
    matchedRanges.push({ name: range.name, pinnedStart: range.start, pinnedEnd: range.end,
      actualStart: offset, actualEnd: offset + block.length, sha256: range.sha256 });
  }
  return freeze({ extensionId: LAND_ACCELERATION_EXTENSION_ID, sourcePin: LAND_ACCELERATION_SOURCE_PIN,
    sourceReferenceVersion: contract.sourceVersion, sourceReferenceSha256: contract.sourceSha256,
    gameSha256: sha256(gameBytes), matchedRanges });
}

export function validateLandAccelerationTables({ tables, tableHashes, baseDataSnapshotId, loginResponseRef, bundleRef,
  baseTableHashes, resourceSha256, sourceVersion, sourceProof } = {}) {
  if (!plainObject(tables) || !plainObject(tableHashes) || !/^sha256:[a-f0-9]{64}$/.test(baseDataSnapshotId || '') ||
      typeof loginResponseRef !== 'string' || !loginResponseRef || typeof bundleRef !== 'string' || !bundleRef ||
      !/^[a-f0-9]{64}$/.test(resourceSha256 || '') || !sourceVersion || sourceProof?.extensionId !== LAND_ACCELERATION_EXTENSION_ID ||
      sourceProof.sourcePin !== LAND_ACCELERATION_SOURCE_PIN || !/^[a-f0-9]{64}$/.test(sourceProof.gameSha256 || '') ||
      !Array.isArray(sourceProof.matchedRanges) || sourceProof.matchedRanges.length !== 7 || !plainObject(baseTableHashes) ||
      tableHashes.c_item !== baseTableHashes.c_item || tableHashes.c_flower !== baseTableHashes.c_flower) return null;
  const gameCfg = tables.c_gameCfg?.['-1'], flower = tables.c_flower?.['-1'], item = tables.c_item?.['1001'];
  const thresholdSeconds = gameCfg?.$freeSpeedUp;
  const cardItemId = flower?.$growItem;
  if (!Number.isSafeInteger(thresholdSeconds) || thresholdSeconds <= 0 || thresholdSeconds > 3600 || cardItemId !== 1001 ||
      item?.id !== 1001 || item.type !== 1 || ['reset', 'restore', 'limit'].some(key => Object.hasOwn(item, key)) || typeof tableHashes.c_gameCfg !== 'string' ||
      typeof tableHashes.c_flower !== 'string' || typeof tableHashes.c_item !== 'string') return null;
  const data = { extensionId: LAND_ACCELERATION_EXTENSION_ID, sourcePin: LAND_ACCELERATION_SOURCE_PIN,
    sourceVersion, baseDataSnapshotId, bundleRef, loginResponseRef, resourceSha256,
    tableHashes: { c_gameCfg: tableHashes.c_gameCfg, c_flower: tableHashes.c_flower, c_item: tableHashes.c_item },
    thresholdSeconds, cardItemId, staticResetRestoreLimitAbsent: true, sourcePinRef: sourceProof };
  const extensionRef = 'sha256:' + sha256(Buffer.from(canonical(data)));
  return freeze({ ...data, extensionRef });
}
