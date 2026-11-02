import crypto from 'node:crypto';
import fs from 'node:fs';
import { canonical, freeze, plainObject } from './common.mjs';

export const SPECIAL_ORDERS_EXTENSION_ID = 'special-orders-public-data/v1';
const PIN_BYTES = fs.readFileSync(new URL('./contracts/special-orders-source-contract-v1.json', import.meta.url));
const PIN_HASH = '983c0ddb72cf14209a562f288256268f5201bdbac5097ffa6d545b3ab7f20f25';
export const SPECIAL_ORDERS_SOURCE_PIN = 'sha256:' + PIN_HASH;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;

export function proveSpecialOrdersSource(gameBytes) {
  if (sha(PIN_BYTES) !== PIN_HASH || !Buffer.isBuffer(gameBytes) || gameBytes.length > 8 * 1024 * 1024) return null;
  let pin;
  try { pin = JSON.parse(PIN_BYTES); } catch { return null; }
  if (pin?.schema !== 'special-orders-source-extension/v1' || pin.sourceVersion !== '490.0.5' || pin.blocks?.length !== 12) return null;
  const matchedRanges = [];
  for (const block of pin.blocks) {
    const bytes = Buffer.from(block.base64 || '', 'base64'), offset = gameBytes.indexOf(bytes);
    if (!bytes.length || bytes.length !== block.byteLength || sha(bytes) !== block.sha256 || offset < 0 ||
        gameBytes.indexOf(bytes, offset + 1) >= 0) return null;
    matchedRanges.push({ name: block.name, actualStart: offset, actualEnd: offset + bytes.length, sha256: block.sha256 });
  }
  return freeze({ extensionId: SPECIAL_ORDERS_EXTENSION_ID, sourcePin: SPECIAL_ORDERS_SOURCE_PIN,
    sourceReferenceVersion: pin.sourceVersion, sourceReferenceSha256: pin.sourceSha256,
    gameSha256: sha(gameBytes), matchedRanges });
}

export function validateSpecialOrdersTables({ tables, tableHashes, baseTableHashes, baseDataSnapshotId, bundleRef,
  loginResponseRef, resourceSha256, sourceVersion, sourceProof } = {}) {
  if (!plainObject(tables) || !plainObject(tableHashes) || !plainObject(baseTableHashes) ||
      !/^sha256:[a-f0-9]{64}$/.test(baseDataSnapshotId || '') || !reference(bundleRef) || !reference(loginResponseRef) ||
      !digest(resourceSha256) || !/^[0-9]+(?:\.[0-9]+){1,5}$/.test(sourceVersion || '') ||
      sourceProof?.sourcePin !== SPECIAL_ORDERS_SOURCE_PIN || sourceProof.extensionId !== SPECIAL_ORDERS_EXTENSION_ID ||
      sourceProof.matchedRanges?.length !== 12 || !digest(sourceProof.gameSha256) ||
      !['c_item', 'c_open', 'c_flower', 'c_orderFlower', 'c_orderTeam'].every(name => digest(tableHashes[name])) ||
      !['c_item', 'c_open', 'c_flower', 'c_orderFlower'].every(name => tableHashes[name] === baseTableHashes[name])) return null;
  const metadata = tables.c_orderTeam?.['-1'], palette = {}, quantities = {};
  const open = tables.c_open, palaceHours = tables.c_orderFlower?.['-1']?.$palaceOrderTime;
  if (!plainObject(metadata) || !positive(metadata.$orderTeamTime) || metadata.$orderTeamTime > 86400 ||
      !positive(metadata.$orderMax) || metadata.$orderMax > 1000 || !Number.isSafeInteger(metadata.$buyMax) || metadata.$buyMax < 0 ||
      !Array.isArray(metadata.$orderTeamBuyCost) || metadata.$orderTeamBuyCost.length !== 2 || metadata.$orderTeamBuyCost[0] !== 1 ||
      !Number.isSafeInteger(metadata.$orderTeamBuyCost[1]) || metadata.$orderTeamBuyCost[1] < 0 ||
      !plainObject(open?.sys_orderPalace) || !plainObject(open?.sys_orderTeam) || !plainObject(tables.c_item) || !plainObject(tables.c_flower) ||
      !Array.isArray(palaceHours) || !palaceHours.length || palaceHours.length > 24 || new Set(palaceHours).size !== palaceHours.length ||
      palaceHours.some((hour, index) => !Number.isSafeInteger(hour) || hour < 0 || hour > 23 || index > 0 && hour <= palaceHours[index - 1])) return null;
  for (const [id, row] of Object.entries(tables.c_orderTeam)) {
    if (id === '-1') continue;
    if (!plainObject(row) || String(row.id) !== id || !positive(row.id) || row.id > metadata.$orderMax ||
        !positive(row.flowerNum) || row.flowerNum > 1_000_000) return null;
    quantities[id] = row.flowerNum;
  }
  for (const [id, row] of Object.entries(tables.c_item)) {
    if (!plainObject(row) || !positive(row.id) || String(row.id) !== id) continue;
    if (plainObject(tables.c_flower[id]) && Number.isSafeInteger(row.color) && row.color >= 1 && row.color <= 5) palette[id] = row.color;
  }
  const body = { extensionId: SPECIAL_ORDERS_EXTENSION_ID, sourcePin: SPECIAL_ORDERS_SOURCE_PIN, sourceVersion,
    baseDataSnapshotId, bundleRef, loginResponseRef, resourceSha256, sourceProof,
    tableHashes: Object.fromEntries(['c_item', 'c_open', 'c_flower', 'c_orderFlower', 'c_orderTeam'].map(name => [name, tableHashes[name]])),
    rules: { teamDurationSeconds: metadata.$orderTeamTime, teamOrderMax: metadata.$orderMax, teamBuyMax: metadata.$buyMax,
      teamBuyCurrencyItemId: 1, teamBuyAmount: metadata.$orderTeamBuyCost[1], quantities, palette,
      palaceHours: [...palaceHours], palaceOpenId: 'sys_orderPalace', teamOpenId: 'sys_orderTeam' } };
  return freeze({ ...body, extensionRef: 'sha256:' + sha(Buffer.from(canonical(body))) });
}
