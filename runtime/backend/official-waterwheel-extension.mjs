import crypto from 'node:crypto';
import fs from 'node:fs';
import { canonical, freeze, plainObject } from './common.mjs';

export const WATERWHEEL_EXTENSION_ID = 'waterwheel-public-data/v1';
const SOURCE_PIN_BYTES = fs.readFileSync(new URL('./contracts/waterwheel-extension-v1.json', import.meta.url));
const SOURCE_PIN_SHA256 = '1e1e222a618bc1a815d8fb041118fedcf123ff656da31ff71a595dba2b34857d';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const WATERWHEEL_SOURCE_PIN = 'sha256:' + SOURCE_PIN_SHA256;

export function proveWaterwheelExtensionSource(gameBytes) {
  if (sha256(SOURCE_PIN_BYTES) !== SOURCE_PIN_SHA256 || !Buffer.isBuffer(gameBytes) || gameBytes.length > 8 * 1024 * 1024) return null;
  let contract;
  try { contract = JSON.parse(SOURCE_PIN_BYTES.toString('utf8')); } catch { return null; }
  if (contract?.schema !== 'waterwheel-source-extension/v1' || !Array.isArray(contract.blocks) || contract.blocks.length !== 30) return null;
  const matchedRanges = [];
  for (const range of contract.blocks) {
    if (typeof range.base64 !== 'string' || !Number.isSafeInteger(range.byteLength) || range.byteLength < 1) return null;
    const block = Buffer.from(range.base64, 'base64'), offset = gameBytes.indexOf(block);
    if (block.length !== range.byteLength || sha256(block) !== range.sha256 || offset < 0 || gameBytes.indexOf(block, offset + 1) >= 0) return null;
    matchedRanges.push({ name: range.name, pinnedStart: range.start, pinnedEnd: range.end, actualStart: offset,
      actualEnd: offset + block.length, sha256: range.sha256 });
  }
  return freeze({ extensionId: WATERWHEEL_EXTENSION_ID, sourcePin: WATERWHEEL_SOURCE_PIN,
    sourceReferenceVersion: contract.sourceVersion, sourceReferenceSha256: contract.sourceSha256,
    gameSha256: sha256(gameBytes), matchedRanges });
}

export function validateWaterwheelTables({ tables, tableHashes, baseDataSnapshotId, loginResponseRef, bundleRef,
  baseTableHashes, resourceSha256, sourceVersion, sourceProof } = {}) {
  if (!plainObject(tables) || !plainObject(tableHashes) || !/^sha256:[a-f0-9]{64}$/.test(baseDataSnapshotId || '') ||
      typeof loginResponseRef !== 'string' || !loginResponseRef || typeof bundleRef !== 'string' || !bundleRef ||
      !/^[a-f0-9]{64}$/.test(resourceSha256 || '') || !sourceVersion || sourceProof?.extensionId !== WATERWHEEL_EXTENSION_ID ||
      sourceProof.sourcePin !== WATERWHEEL_SOURCE_PIN || !/^[a-f0-9]{64}$/.test(sourceProof.gameSha256 || '') ||
      !Array.isArray(sourceProof.matchedRanges) || sourceProof.matchedRanges.length !== 30 || !plainObject(baseTableHashes) ||
      !['c_item', 'c_farmLand', 'c_flower', 'c_flowerLvl', 'c_flowerLvlCfg', 'c_flowerArt', 'c_open', 'c_lvl', 'c_orderFlower',
        'c_orderFlowerNpc', 'c_share', 'c_butler'].every(name => /^[a-f0-9]{64}$/.test(baseTableHashes[name] || ''))) return null;
  const wheel = tables.c_waterwheel?.['-1'], share = tables.c_share?.['9'], storage = tables.c_butler?.['3'];
  const positive = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max;
  const ordinaryRows = Array.isArray(wheel?.$bucketWaterNum) && wheel.$bucketWaterNum.length > 0 && wheel.$bucketWaterNum.length <= 64 &&
    wheel.$bucketWaterNum.every(row => Array.isArray(row) && row.length === 3 && row[0] === 7 && positive(row[1], 1000) && positive(row[2], 1000000));
  const ordinarySupported = ordinaryRows;
  const videoAward = Array.isArray(share?.award) && share.award.length === 1 && Array.isArray(share.award[0]) &&
    share.award[0].length === 2 && share.award[0][0] === 7 && positive(share.award[0][1], 1000000);
  const videoSupported = share?.id === 9 && share.limitType === 1 && positive(share.limit, 100000) && share.hasVideo === 1 && videoAward;
  if (wheel?.id !== -1 || !positive(wheel.$bucketCreateCd, 86400) || !positive(wheel.$bucketExistMax, 64) ||
      !positive(wheel.$bucketGetMax, 1000000) || wheel.$bucketShareId !== 9 || !Array.isArray(wheel.$bucketWaterNum) ||
      storage?.id !== 3 || !positive(storage.limitNum, 1000) ||
      !['c_waterwheel', 'c_share', 'c_butler'].every(name => /^[a-f0-9]{64}$/.test(tableHashes[name] || ''))) return null;
  const ordinaryAmounts = ordinarySupported ? wheel.$bucketWaterNum.map(row => row[1]) : [];
  const videoQuantity = videoSupported ? share.award[0][1] : null;
  const data = { extensionId: WATERWHEEL_EXTENSION_ID, sourcePin: WATERWHEEL_SOURCE_PIN,
    sourceVersion, baseDataSnapshotId, bundleRef, loginResponseRef, resourceSha256,
    baseTableHashes: { ...baseTableHashes }, tableHashes: { c_waterwheel: tableHashes.c_waterwheel,
      c_share: tableHashes.c_share, c_butler: tableHashes.c_butler }, sourceProof,
    rules: { createCdSeconds: wheel.$bucketCreateCd, visibleSlots: wheel.$bucketExistMax, dailyClaimLimit: wheel.$bucketGetMax,
      storageLimit: storage.limitNum, ordinarySupported, ordinaryWaterItemId: 7,
      ordinaryWaterMin: ordinaryAmounts.length ? Math.min(...ordinaryAmounts) : null,
      ordinaryWaterMax: ordinaryAmounts.length ? Math.max(...ordinaryAmounts) : null,
      shareId: 9, videoSupported, dailyVideoLimit: videoSupported ? share.limit : null,
      videoWaterItemId: 7, videoWaterQuantity: videoQuantity } };
  const extensionRef = 'sha256:' + sha256(Buffer.from(canonical(data)));
  return freeze({ ...data, extensionRef });
}
