import { plainObject } from '../../common.mjs';

const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const flowers = value => Array.isArray(value) && value.length <= 16 && value.every(pair =>
  Array.isArray(pair) && pair.length === 2 && pair.every(positive));
const reward = value => plainObject(value) && Object.keys(value).length <= 128 && Object.entries(value).every(([id, quantity]) =>
  /^[1-9]\d*$/.test(id) && positive(Number(id)) && nonnegative(quantity));

// G480's video branch reads videoRwd, independently of flower requirements.
// This predicate observes supplied fields only: it never invents flowers or a
// reward map, and it does not decide eligibility, inventory, or write effects.
export function orderFlowerBranchShape(kind, value, { boxId = null } = {}) {
  if (!['resident', 'satin', 'decorate'].includes(kind) || !plainObject(value)) return false;
  if (boxId !== null && (!positive(boxId) || (kind === 'resident' ? boxId > 6 : boxId !== (kind === 'satin' ? 7 : 8)))) return false;
  if (!positive(value.npcId) || !nonnegative(value.dialogId) || !positive(value.cTime) ||
    ![0, 1, false, true].includes(value.isVideo) || !nonnegative(value[kind === 'resident' ? 'placeIdx' : 'finishCnt']) ||
    Object.hasOwn(value, 'cdTime') && value.cdTime !== null && !positive(value.cdTime)) return false;
  const video = value.isVideo === true || value.isVideo === 1;
  if (video) return reward(value.videoRwd) && (!Object.hasOwn(value, 'flowers') || value.flowers === null || flowers(value.flowers));
  return flowers(value.flowers) && (!Object.hasOwn(value, 'videoRwd') || value.videoRwd === null || reward(value.videoRwd));
}

// Preserve omitted/null/unreadable distinctions from the decoded cell frame.
// An unreadable supplied cell stays a present invalid value, never absence.
export function orderFlowerBranchCellShape(kind, boxId, fields) {
  if (!plainObject(fields)) return false;
  const values = Object.fromEntries(Object.entries(fields).filter(([, cell]) => cell?.presence !== 'missing').map(([key, cell]) =>
    [key, cell?.presence === 'present' && cell.state === 'known' ? cell.value : cell?.presence === 'null' ? null : undefined]));
  return orderFlowerBranchShape(kind, values, { boxId });
}
