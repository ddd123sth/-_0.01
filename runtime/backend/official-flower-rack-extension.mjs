import crypto from 'node:crypto';
import fs from 'node:fs';
import { canonical, freeze, plainObject } from './common.mjs';

export const FLOWER_RACK_EXTENSION_ID = 'flower-rack-public-data/v1';
const PIN_BYTES = fs.readFileSync(new URL('./contracts/flower-rack-source-contract-v1.json', import.meta.url));
const PIN_HASH = '313c6f1eae53ff3307a11ea101db2dcf3e5ad5a484f7a71201b319de461fb69b';
export const FLOWER_RACK_SOURCE_PIN = 'sha256:' + PIN_HASH;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const positive = value => Number.isSafeInteger(value) && value > 0;

export function proveFlowerRackExtensionSource(gameBytes) {
  if (sha256(PIN_BYTES) !== PIN_HASH || !Buffer.isBuffer(gameBytes) || gameBytes.length > 8 * 1024 * 1024) return null;
  let pin;
  try { pin = JSON.parse(PIN_BYTES.toString('utf8')); } catch { return null; }
  if (pin?.schema !== 'flower-rack-source-extension/v1' || !Array.isArray(pin.blocks) || pin.blocks.length !== 8) return null;
  const matchedRanges = [];
  for (const row of pin.blocks) {
    if (typeof row.base64 !== 'string' || !Number.isSafeInteger(row.byteLength) || row.byteLength < 1) return null;
    const bytes = Buffer.from(row.base64, 'base64'), offset = gameBytes.indexOf(bytes);
    if (bytes.length !== row.byteLength || sha256(bytes) !== row.sha256 || offset < 0 || gameBytes.indexOf(bytes, offset + 1) >= 0) return null;
    matchedRanges.push({ name: row.name, pinnedStart: row.start, pinnedEnd: row.end, actualStart: offset,
      actualEnd: offset + bytes.length, sha256: row.sha256 });
  }
  return freeze({ extensionId: FLOWER_RACK_EXTENSION_ID, sourcePin: FLOWER_RACK_SOURCE_PIN,
    sourceReferenceVersion: pin.sourceVersion, sourceReferenceSha256: pin.sourceSha256, gameSha256: sha256(gameBytes), matchedRanges });
}

export function validateFlowerRackTables({ tables, tableHashes, baseTableHashes, baseDataSnapshotId, bundleRef,
  loginResponseRef, resourceSha256, sourceVersion, sourceProof } = {}) {
  if (!plainObject(tables) || !plainObject(tables.c_flowerRack) || !plainObject(tableHashes) ||
      !plainObject(baseTableHashes) || !Object.values(baseTableHashes).length ||
      Object.values(baseTableHashes).some(hash => !/^[a-f0-9]{64}$/.test(hash || '')) ||
      !/^sha256:[a-f0-9]{64}$/.test(baseDataSnapshotId || '') || typeof bundleRef !== 'string' || !bundleRef ||
      typeof loginResponseRef !== 'string' || !loginResponseRef || !/^[a-f0-9]{64}$/.test(resourceSha256 || '') ||
      typeof sourceVersion !== 'string' || !/^[0-9]+(?:\.[0-9]+){1,5}$/.test(sourceVersion) ||
      !/^[a-f0-9]{64}$/.test(tableHashes.c_flowerRack || '') || sourceProof?.extensionId !== FLOWER_RACK_EXTENSION_ID ||
      sourceProof?.sourcePin !== FLOWER_RACK_SOURCE_PIN || !Array.isArray(sourceProof.matchedRanges) || sourceProof.matchedRanges.length !== 8)
    return null;
  const rows = tables.c_flowerRack, meta = rows['-1'];
  if (!plainObject(meta) || !positive(meta.$initStage) || !positive(meta.$sellNum) || !positive(meta.$sellTime) || !positive(meta.$lockTime)) return null;
  const stands = {};
  for (const [key, row] of Object.entries(rows)) {
    if (key === '-1') continue;
    const id = Number(key);
    if (!positive(id) || !plainObject(row) || row.id !== id || !Array.isArray(row.rack) || !row.rack.length ||
        row.rack.length > 64 || !row.rack.every(positive) || new Set(row.rack).size !== row.rack.length) return null;
    const unlockLevel = row.unlockLvl === undefined ? null : row.unlockLvl;
    const unlockCost = row.unlockCost === undefined ? null : row.unlockCost;
    if (unlockLevel !== null && !positive(unlockLevel) || unlockCost !== null &&
        (!Array.isArray(unlockCost) || unlockCost.length !== 2 || !positive(unlockCost[0]) || !Number.isSafeInteger(unlockCost[1]) || unlockCost[1] < 0)) return null;
    stands[id] = { standId: id, rackIds: [...row.rack], unlockLevel, unlockCost: unlockCost ? [...unlockCost] : null };
  }
  if (!Object.keys(stands).length) return null;
  const data = { extensionId: FLOWER_RACK_EXTENSION_ID, sourcePin: FLOWER_RACK_SOURCE_PIN, sourceVersion,
    baseDataSnapshotId, bundleRef, loginResponseRef, resourceSha256, baseTableHashes: { ...baseTableHashes },
    tableHashes: { c_flowerRack: tableHashes.c_flowerRack }, sourceProof,
    rules: { initialStage: meta.$initStage, maxSellNum: meta.$sellNum, sellTimeSeconds: meta.$sellTime,
      lockTimeSeconds: meta.$lockTime, stands } };
  return freeze({ ...data, extensionRef: 'sha256:' + sha256(Buffer.from(canonical(data))) });
}
