import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { freeze, plainObject } from '../../common.mjs';

const raw = readFileSync(new URL('./level-thresholds-480.0.27.json', import.meta.url));
const sha256 = createHash('sha256').update(raw).digest('hex');
if (sha256 !== 'a93c4dc9277323104787ac76a70900c1e2b8a0ef10de5c04b58319a22c85e4ae') throw new Error('Order flower level catalog hash mismatch');
const table = JSON.parse(raw.toString('utf8'));
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
if (table.gameVersion !== '480.0.27' || table.protocolVersion !== '480.0.0' || table.maxLevel !== 65 || !Array.isArray(table.rows) || table.rows.length !== 65 ||
  !table.rows.every((row, index) => plainObject(row) && row.level === index + 1 && (row.level === 65 ? row.exp === null : positive(row.exp)) &&
    Array.isArray(row.items) && row.items.length <= 7 && row.items.every(one => Array.isArray(one) && one.length === 2 && positive(one[0]) && positive(one[1])))) {
  throw new Error('Order flower level catalog shape mismatch');
}
export const ORDER_FLOWER_LEVEL_SOURCE = freeze({ version: table.version, gameVersion: table.gameVersion,
  protocolVersion: table.protocolVersion, catalogSha256: sha256, ...table.source });
export const ORDER_FLOWER_LEVEL_REWARD_ITEM_IDS = freeze([...new Set(table.rows.flatMap(row => row.items.map(one => one[0])))].sort((a, b) => a - b));

// This is a conserved coordinate for an OBSERVED level and remaining exp.
// It neither predicts nor requests an upgrade, and never requires exp < the
// current level threshold (the official client can show a pending upgrade).
export function orderFlowerExperienceTransition({ before, after, experience } = {}) {
  const unavailable = reasonCode => freeze({ known: false, reasonCode, source: ORDER_FLOWER_LEVEL_SOURCE });
  if (![before, after].every(one => positive(one?.level) && one.level <= table.maxLevel && nonnegative(one.lvlExp)) ||
    !nonnegative(experience) || after.level < before.level) return unavailable('ORDER_FLOWER_EXPERIENCE_LEVEL_TRANSITION_UNPROVEN');
  const coordinate = one => {
    let value = BigInt(one.lvlExp);
    for (let level = 1; level < one.level; level++) value += BigInt(table.rows[level - 1].exp);
    return value;
  };
  const start = coordinate(before), end = coordinate(after);
  if (end - start !== BigInt(experience)) return unavailable('ORDER_FLOWER_EXPERIENCE_LEVEL_TRANSITION_UNPROVEN');
  const candidates = new Map(), crossedLevels = [];
  for (let level = before.level + 1; level <= after.level; level++) {
    crossedLevels.push(level);
    for (const [itemId, quantity] of table.rows[level - 1].items) candidates.set(itemId, (candidates.get(itemId) || 0) + quantity);
  }
  return freeze({ known: true, reasonCode: null, before: { level: before.level, lvlExp: before.lvlExp, coordinate: start.toString() },
    after: { level: after.level, lvlExp: after.lvlExp, coordinate: end.toString() }, experienceQuantity: experience,
    crossedLevels, rewardCandidates: [...candidates].sort((a, b) => a[0] - b[0]).map(([itemId, quantity]) => ({ itemId, maximumQuantity: quantity })),
    candidatePresenceProvesNoGrant: true, source: ORDER_FLOWER_LEVEL_SOURCE });
}
