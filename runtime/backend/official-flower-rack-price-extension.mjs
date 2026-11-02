import crypto from 'node:crypto';
import fs from 'node:fs';
import { canonical, freeze, plainObject } from './common.mjs';

export const FLOWER_RACK_PRICE_EXTENSION_ID = 'flower-rack-price-public-data/v1';
const PIN_BYTES = fs.readFileSync(new URL('./contracts/flower-rack-price-source-contract-v1.json', import.meta.url));
const PIN_HASH = '1e40364ee3741a241113415f1ef985c493ffb392b35b10da955bfccb977cc608';
export const FLOWER_RACK_PRICE_SOURCE_PIN = 'sha256:' + PIN_HASH;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const nonnegative = value => Number.isFinite(value) && value >= 0;

export function proveFlowerRackPriceExtensionSource(gameBytes) {
  if (sha256(PIN_BYTES) !== PIN_HASH || !Buffer.isBuffer(gameBytes) || gameBytes.length > 8 * 1024 * 1024) return null;
  let pin;
  try { pin = JSON.parse(PIN_BYTES.toString('utf8')); } catch { return null; }
  if (pin?.schema !== 'flower-rack-price-source-extension/v1' || !Array.isArray(pin.blocks) || pin.blocks.length !== 14) return null;
  const matchedRanges = [];
  for (const row of pin.blocks) {
    if (typeof row.base64 !== 'string' || !Number.isSafeInteger(row.byteLength) || row.byteLength < 1) return null;
    const bytes = Buffer.from(row.base64, 'base64'), offset = gameBytes.indexOf(bytes);
    if (bytes.length !== row.byteLength || sha256(bytes) !== row.sha256 || offset < 0 || gameBytes.indexOf(bytes, offset + 1) >= 0) return null;
    matchedRanges.push({ name: row.name, pinnedStart: row.start, pinnedEnd: row.end, actualStart: offset,
      actualEnd: offset + bytes.length, sha256: row.sha256 });
  }
  return freeze({ extensionId: FLOWER_RACK_PRICE_EXTENSION_ID, sourcePin: FLOWER_RACK_PRICE_SOURCE_PIN,
    sourceReferenceVersion: pin.sourceVersion, sourceReferenceSha256: pin.sourceSha256, gameSha256: sha256(gameBytes), matchedRanges });
}

export function validateFlowerRackPriceExtension({ tables, tableHashes, baseTableHashes, baseDataSnapshotId, bundleRef,
  loginResponseRef, resourceSha256, sourceVersion, sourceProof } = {}) {
  const cfg = tables?.c_gameCfg?.['-1'], skills = tables?.c_flowerAdvanceSkill;
  if (!plainObject(tables) || !plainObject(cfg) || !plainObject(skills) || !plainObject(tableHashes) || !plainObject(baseTableHashes) ||
      !Object.keys(baseTableHashes).length || Object.values(baseTableHashes).some(hash => !/^[a-f0-9]{64}$/.test(hash || '')) ||
      !/^sha256:[a-f0-9]{64}$/.test(baseDataSnapshotId || '') || typeof bundleRef !== 'string' || !bundleRef ||
      typeof loginResponseRef !== 'string' || !loginResponseRef || !/^[a-f0-9]{64}$/.test(resourceSha256 || '') ||
      typeof sourceVersion !== 'string' || !/^[0-9]+(?:\.[0-9]+){1,5}$/.test(sourceVersion) ||
      !/^[a-f0-9]{64}$/.test(tableHashes.c_gameCfg || '') || !/^[a-f0-9]{64}$/.test(tableHashes.c_flowerAdvanceSkill || '') ||
      !nonnegative(cfg.$videoGldAdd) || sourceProof?.extensionId !== FLOWER_RACK_PRICE_EXTENSION_ID ||
      sourceProof?.sourcePin !== FLOWER_RACK_PRICE_SOURCE_PIN || !Array.isArray(sourceProof.matchedRanges) || sourceProof.matchedRanges.length !== 14) return null;
  for (const [key, row] of Object.entries(skills)) {
    if (key === '-1') continue;
    if (!/^[1-9][0-9]*$/.test(key) || !plainObject(row) || row.id !== Number(key) ||
        !Number.isSafeInteger(row.skillType) || row.skillType <= 0 || !Number.isSafeInteger(row.valueType) || row.valueType <= 0 ||
        !['value1','value2','value3'].every(name => row[name] === undefined || nonnegative(row[name]))) return null;
  }
  const data = { extensionId: FLOWER_RACK_PRICE_EXTENSION_ID, sourcePin: FLOWER_RACK_PRICE_SOURCE_PIN, sourceVersion,
    baseDataSnapshotId, bundleRef, loginResponseRef, resourceSha256, baseTableHashes: { ...baseTableHashes },
    tableHashes: { c_gameCfg: tableHashes.c_gameCfg, c_flowerAdvanceSkill: tableHashes.c_flowerAdvanceSkill },
    videoGldAdd: cfg.$videoGldAdd, skills, sourceProof };
  return freeze({ ...data, extensionRef: 'sha256:' + sha256(Buffer.from(canonical(data))) });
}
