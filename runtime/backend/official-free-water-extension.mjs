import crypto from 'node:crypto';
import fs from 'node:fs';
import { canonical, freeze, plainObject } from './common.mjs';

export const FREE_WATER_EXTENSION_ID = 'free-water-public-data/v1';
const PIN_BYTES = fs.readFileSync(new URL('./contracts/free-water-source-contract-v1.json', import.meta.url));
const PIN_HASH = '8de2ffc122e5363e31ea3254359dca8dae192c07cf4362574205ff0c1e4df295';
export const FREE_WATER_SOURCE_PIN = 'sha256:' + PIN_HASH;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

export function proveFreeWaterExtensionSource(gameBytes) {
  if (sha256(PIN_BYTES) !== PIN_HASH || !Buffer.isBuffer(gameBytes) || gameBytes.length > 8 * 1024 * 1024) return null;
  let pin;
  try { pin = JSON.parse(PIN_BYTES.toString('utf8')); } catch { return null; }
  if (pin?.schema !== 'free-water-source-extension/v1' || pin.sourceVersion !== '480.0.46' || !Array.isArray(pin.blocks) || pin.blocks.length !== 13) return null;
  const matchedRanges = [];
  for (const row of pin.blocks) {
    if (typeof row.base64 !== 'string' || !Number.isSafeInteger(row.byteLength) || row.byteLength < 1) return null;
    const bytes = Buffer.from(row.base64, 'base64'), offset = gameBytes.indexOf(bytes);
    if (bytes.length !== row.byteLength || sha256(bytes) !== row.sha256 || offset < 0 || gameBytes.indexOf(bytes, offset + 1) >= 0) return null;
    matchedRanges.push({ name: row.name, pinnedStart: row.start, pinnedEnd: row.end, actualStart: offset,
      actualEnd: offset + bytes.length, sha256: row.sha256 });
  }
  return freeze({ extensionId: FREE_WATER_EXTENSION_ID, sourcePin: FREE_WATER_SOURCE_PIN,
    sourceReferenceVersion: pin.sourceVersion, sourceReferenceSha256: pin.sourceSha256, gameSha256: sha256(gameBytes), matchedRanges });
}

export function validateFreeWaterTables({ tables, tableHashes, baseTableHashes, baseDataSnapshotId, bundleRef,
  loginResponseRef, resourceSha256, sourceVersion, sourceProof } = {}) {
  const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 1000000;
  if (!plainObject(tables) || !plainObject(tableHashes) || !plainObject(baseTableHashes) ||
      !/^sha256:[a-f0-9]{64}$/.test(baseDataSnapshotId || '') || typeof bundleRef !== 'string' || !bundleRef ||
      typeof loginResponseRef !== 'string' || !loginResponseRef || !/^[a-f0-9]{64}$/.test(resourceSha256 || '') ||
      !/^[0-9]+(?:\.[0-9]+){1,5}$/.test(sourceVersion || '') || sourceProof?.extensionId !== FREE_WATER_EXTENSION_ID ||
      sourceProof?.sourcePin !== FREE_WATER_SOURCE_PIN || !/^[a-f0-9]{64}$/.test(sourceProof?.gameSha256 || '') ||
      !Array.isArray(sourceProof?.matchedRanges) || sourceProof.matchedRanges.length !== 13 ||
      !Object.values(baseTableHashes).length || Object.values(baseTableHashes).some(hash => !/^[a-f0-9]{64}$/.test(hash || '')) ||
      !['c_gameCfg', 'c_share', 'c_open'].every(name => /^[a-f0-9]{64}$/.test(tableHashes[name] || ''))) return null;
  const cfg = tables.c_gameCfg?.['-1'], share = tables.c_share?.['13'], open = tables.c_open?.sys_freeWater;
  const amounts = cfg?.$freeWaterNum, windows = cfg?.$freeWaterTime;
  const waterRulesSupported = Array.isArray(amounts) && amounts.length === 2 && amounts[0] === 7 && positive(amounts[1]);
  const validWindows = Array.isArray(windows) && windows.length === 2 && windows.every(row => Array.isArray(row) && row.length === 2 &&
    Number.isSafeInteger(row[0]) && Number.isSafeInteger(row[1]) && row[0] >= 0 && row[1] <= 24 && row[0] < row[1]) && windows[0][1] <= windows[1][0];
  const demandSupported = Array.isArray(cfg?.$freeWaterDmd) && cfg.$freeWaterDmd.length === 2 &&
    cfg.$freeWaterDmd.every(value => Number.isSafeInteger(value) && value >= 0);
  const videoSupported = share?.id === 13 && share.limitType === 1 && positive(share.limit) && share.hasVideo === 1 &&
    typeof share.openId === 'string' && share.openId.length > 0 && share.openId.length <= 64;
  const openSupported = open?.id === 'sys_freeWater' && Array.isArray(open.cnd) && open.cnd.length > 0;
  if (!waterRulesSupported || !validWindows || !openSupported) return null;
  const data = { extensionId: FREE_WATER_EXTENSION_ID, sourcePin: FREE_WATER_SOURCE_PIN, sourceVersion,
    baseDataSnapshotId, bundleRef, loginResponseRef, resourceSha256,
    baseTableHashes: { ...baseTableHashes },
    tableHashes: { c_gameCfg: tableHashes.c_gameCfg, c_share: tableHashes.c_share, c_open: tableHashes.c_open },
    sourceProof, rules: { waterItemId: amounts[0], configuredDisplayAmount: amounts[1], windows: windows.map(row => [...row]),
      ...(demandSupported ? { freeWaterDemand: [...cfg.$freeWaterDmd] } : {}),
      ordinarySupported: true, videoSupported, shareId: 13, dailyVideoLimit: videoSupported ? share.limit : null,
      limitType: videoSupported ? share.limitType : null, hasVideo: videoSupported, openId: videoSupported ? share.openId : null,
      openContractId: open.id } };
  return freeze({ ...data, extensionRef: 'sha256:' + sha256(Buffer.from(canonical(data))) });
}
