// Decoders for the official sync subtrees consumed by the reward/upgrade cards.
// Every decoder accepts both the named and the indexed wire form, and reports an
// explicit `present` flag so a sparse frame is never mistaken for "nothing to do".
import { officialDateMs } from '../land/wire-facts.mjs';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (value, key) => isRecord(value) && Object.hasOwn(value, key);
const read = (value, name, index) => has(value, name) ? value[name] : has(value, index) ? value[index] : undefined;
const nonNegative = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const numericId = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value :
  typeof value === 'string' && /^\d{1,18}$/.test(value) ? Number(value) : null;
const entryList = value => {
  if (Array.isArray(value)) return value.map((item, index) => [String(index), item]);
  return isRecord(value) ? Object.entries(value) : [];
};
const timeField = value => {
  if (value === null) return { present: true, value: null };
  const ms = officialDateMs(value);
  return ms === null ? { present: true, value: null, unreadable: true } : { present: true, value: ms };
};

export function decodeMail(value) {
  const root = isRecord(value?.['19']) ? value['19'] : has(value, 'mailTot') ? value.mailTot : null;
  if (!root) return { present: false, listPresent: false, mails: [] };
  const list = has(root, 'list') ? root.list : has(root, '1') ? root['1'] : undefined;
  const red = nonNegative(Number(read(root, 'red', '0')));
  const mailAllPresent = has(root, 'mailAll') || has(root, '3');
  if (list === undefined) return { present: true, listPresent: false, mails: [], red, mailAllPresent };
  const mails = [];
  let malformed = false;
  for (const [index, raw] of entryList(list)) {
    if (!isRecord(raw)) { malformed = true; continue; }
    const msId = numericId(read(raw, 'msId', '1'));
    const allId = numericId(read(raw, 'allId', '2')) ?? 0;
    const items = read(raw, 'items', '13');
    const itemCount = Array.isArray(items) ? items.length : isRecord(items) ? Object.keys(items).length : items == null || items === '' ? 0 : 1;
    const flag = cell => cell === true || cell === 1;
    const isDel = flag(read(raw, 'isDel', '17'));
    const isPick = flag(read(raw, 'isPick', '20'));
    if (positive(msId) === null && positive(allId) === null) { malformed = true; continue; }
    mails.push(Object.freeze({ index, msId: msId ?? 0, allId, itemCount, isDel, isPick }));
  }
  return { present: true, listPresent: true, malformed, mails, red, mailAllPresent,
    claimable: mails.filter(mail => mail.itemCount > 0 && !mail.isDel && !mail.isPick && (mail.msId > 0 || mail.allId > 0)) };
}

export function decodeBenefitBox(value) {
  const root = isRecord(value?.['116']) ? value['116'] : has(value, 'benefitBoxTot') ? value.benefitBoxTot : null;
  if (!root) return { present: false };
  const record = isRecord(root) && isRecord(root['0']) ? root['0'] : isRecord(root) && has(root, 'benefitBox') ? root.benefitBox : root;
  if (!isRecord(record)) return { present: true, readable: false };
  const drawCnt = nonNegative(read(record, 'drawCnt', '1'));
  const uid = positive(read(record, 'uid', '0'));
  return { present: true, readable: drawCnt !== null, uid, drawCnt };
}

export function decodeTasks(value) {
  const root = isRecord(value?.['22']) ? value['22'] : has(value, 'taskTot') ? value.taskTot : null;
  if (!root) return { present: false };
  const out = { present: true, daily: null, weekly: null, main: null };
  const children = entryList(root).filter(([, child]) => isRecord(child));
  const readMap = (record, name, index) => {
    const raw = read(record, name, index);
    return isRecord(raw) ? raw : null;
  };
  const readProgress = record => {
    const raw = read(record, 'progress', '1');
    if (!isRecord(raw)) return null;
    const outmap = {};
    for (const [key, val] of Object.entries(raw)) {
      const id = numericId(key), n = nonNegative(Number(val));
      if (id !== null && n !== null) outmap[id] = n;
    }
    return outmap;
  };
  for (const [key, child] of children) {
    const taskMap = readMap(child, 'taskMap', '100');
    const curTaskId = numericId(read(child, 'curTaskId', '1'));
    const recvMap = readMap(child, 'recvMap', '4');
    const score = nonNegative(read(child, 'score', '4'));
    const boxes = readMap(child, 'boxes', '5');
    if (curTaskId !== null) {
      out.main = { key, curTaskId, curValue: nonNegative(Number(read(child, 'curValue', '2'))),
        curRecord: isRecord(read(child, 'curRecord', '3')) ? read(child, 'curRecord', '3') : null,
        recvMap: recvMap || {}, uid: positive(read(child, 'uid', '0')) };
      continue;
    }
    if (taskMap) {
      const rows = [];
      let malformed = false;
      for (const [mapKey, raw] of entryList(taskMap)) {
        if (!isRecord(raw)) { malformed = true; continue; }
        const taskId = numericId(read(raw, 'taskId', '0')) ?? numericId(mapKey);
        if (taskId === null) { malformed = true; continue; }
        const status = nonNegative(Number(read(raw, 'status', '4')));
        rows.push(Object.freeze({ taskId, targetCount: nonNegative(Number(read(raw, 'targetCnt', '1'))),
          finishCount: nonNegative(Number(read(raw, 'finishCount', '2'))), status }));
      }
      out.daily = { key, taskMap: rows, malformed, recvMap: recvMap || {}, progress: readProgress(child),
        score, boxes: boxes ? Object.keys(boxes).map(Number).filter(Number.isSafeInteger) : null,
        boxesPresent: boxes !== null, uid: positive(read(child, 'uid', '0')) };
      continue;
    }
    if (recvMap) out.weekly = { key, recvMap, progress: readProgress(child), uid: positive(read(child, 'uid', '0')) };
  }
  return out;
}

export function decodeStory(value) {
  const user = isRecord(value?.['7']) ? value['7'] : has(value, 'usrTot') ? value.usrTot : null;
  if (!user) return { present: false };
  const story = isRecord(user['101']) ? user['101'] : isRecord(user.storyMain) ? user.storyMain : null;
  if (!isRecord(story)) return { present: true, readable: false };
  const chapter = positive(numericId(read(story, 'chapter', '1')));
  const sectionIdx = nonNegative(numericId(read(story, 'sectionIdx', '2')));
  return { present: true, readable: chapter !== null && sectionIdx !== null, chapter, sectionIdx };
}

export function decodeGuild(value) {
  const root = isRecord(value?.['25']) ? value['25'] : has(value, 'fmlTot') ? value.fmlTot : null;
  if (!root) return { present: false };
  const fml = isRecord(root['0']) ? root['0'] : isRecord(root.fml) ? root.fml : null;
  const land = isRecord(root['102']) ? root['102'] : isRecord(root.fmlLand) ? root.fmlLand : null;
  const landMap = isRecord(land) && isRecord(land['1']) ? land['1'] : isRecord(land) && isRecord(land.landMap) ? land.landMap : null;
  const build = isRecord(root['133']) ? root['133'] : isRecord(root.fmlBld) ? root.fmlBld : null;
  const member = isRecord(root['1']) ? root['1'] : isRecord(root.mb) ? root.mb : null;
  const buildCount = build && isRecord(build['5']) ? build['5'] : build && isRecord(build.bldCountMap) ? build.bldCountMap : null;
  const rows = [];
  let malformed = false;
  for (const [key, raw] of entryList(landMap)) {
    if (!isRecord(raw)) { malformed = true; continue; }
    const landId = numericId(key) ?? numericId(read(raw, 'landId', '0'));
    if (landId === null) { malformed = true; continue; }
    const flowerId = positive(numericId(read(raw, 'flwId', '1')));
    const lvl = nonNegative(numericId(read(raw, 'lvl', '0')));
    const matureFlwCnt = nonNegative(numericId(read(raw, 'matureFlwCnt', '3')));
    const harvestedFlwCnt = nonNegative(numericId(read(raw, 'harvestedFlwCnt', '4')));
    const startTime = timeField(read(raw, 'startTime', '2'));
    rows.push(Object.freeze({ landId, flowerId, lvl, matureFlwCnt, harvestedFlwCnt, startTime: startTime.value,
      unreadable: startTime.unreadable === true }));
  }
  const shop = isRecord(root['101']) ? root['101'] : null;
  const uid = positive(read(fml, 'uid', '0')) || positive(read(land, 'uid', '0')) || positive(read(build, 'uid', '0')) ||
    positive(read(shop, 'uid', '0'));
  return { present: true, uid, lvl: nonNegative(numericId(read(fml, 'lvl', '6'))),
    flowerTakeCnt: nonNegative(numericId(read(fml, 'flowerTakeCnt', '102'))), landMap: rows, landMalformed: malformed,
    memberPresent: Boolean(uid && (fml || member || land || build || shop)),
    buildCount: buildCount ? Object.fromEntries(entryList(buildCount).map(([key, val]) => [key, nonNegative(Number(val))]).filter(([, val]) => val !== null)) : null,
    memberFid: positive(numericId(read(member, 'fid', '1'))) };
}

export function decodeCultivate(value) {
  const root = isRecord(value?.['101']) ? value['101'] : has(value, 'cultivateTot') ? value.cultivateTot : null;
  if (!root) return { present: false };
  const map = isRecord(root['0']) ? root['0'] : isRecord(root.cultivateMap) ? root.cultivateMap : null;
  if (!map) return { present: true, readable: false, rows: [] };
  const rows = [];
  let malformed = false;
  for (const [key, raw] of entryList(map)) {
    if (!isRecord(raw)) { malformed = true; continue; }
    const flowerId = positive(numericId(read(raw, 'flowerId', '1'))) ?? positive(numericId(key));
    if (flowerId === null) { malformed = true; continue; }
    rows.push(Object.freeze({ key, flowerId, lvl: positive(numericId(read(raw, 'lvl', '2'))),
      status: nonNegative(Number(read(raw, 'status', '4'))), culTime: timeField(read(raw, 'culTime', '3')).value }));
  }
  return { present: true, readable: true, rows, malformed };
}

export function decodeShop(value) {
  const root = isRecord(value?.['113']) ? value['113'] : has(value, 'shopCultivate') ? value.shopCultivate : null;
  if (!root) return { present: false };
  const info = isRecord(root['1']) ? root['1'] : isRecord(root.infoMap) ? root.infoMap : null;
  const record = isRecord(root['6']) ? root['6'] : isRecord(root.bRecord) ? root.bRecord : null;
  const offers = [];
  let malformed = false;
  for (const [key, raw] of entryList(info)) {
    const shopId = positive(numericId(key));
    if (shopId === null || !Array.isArray(raw) || raw.length < 2) { malformed = true; continue; }
    const costItemId = positive(numericId(raw[0])), price = nonNegative(numericId(raw[1]));
    const bought = nonNegative(Number(record?.[key] ?? record?.[shopId] ?? 0));
    if (costItemId === null || price === null || bought === null) { malformed = true; continue; }
    offers.push(Object.freeze({ shopId, costItemId, price, bought }));
  }
  return { present: true, offers, malformed, refreshCount: nonNegative(numericId(read(root, 'mrCount', '4'))),
    resetTime: timeField(read(root, 'lResetTime', '2')).value };
}

export function decodeGiftBag(value) {
  const root = isRecord(value?.['112']) ? value['112'] : has(value, 'shopGiftBag') ? value.shopGiftBag : null;
  if (!root) return { present: false };
  const map = (name, index) => {
    const raw = read(root, name, index);
    if (!isRecord(raw)) return null;
    const out = {};
    for (const [key, val] of Object.entries(raw)) {
      const id = numericId(key);
      if (id === null) continue;
      if (name === 'buyTimeRecord') { const time = timeField(val); if (time.value !== null) out[id] = time.value; }
      else { const n = nonNegative(Number(val)); if (n !== null) out[id] = n; }
    }
    return out;
  };
  return { present: true, dRecord: map('dRecord', '1'), buyTimeRecord: map('buyTimeRecord', '5'),
    rTime: timeField(read(root, 'rTime', '6')).value };
}

export function decodeDoubleCoin(value) {
  const root = isRecord(value?.['118']) ? value['118'] : has(value, 'videoDouble') ? value.videoDouble : null;
  if (!root) return { present: false };
  const uid = positive(read(root, 'uid', '0'));
  const videoCnt = nonNegative(read(root, 'videoCnt', '1'));
  const eTime = timeField(read(root, 'eTime', '2')), uTime = timeField(read(root, 'uTime', '3'));
  return { present: true, uid, videoCnt, eTime: eTime.value, eTimePresent: eTime.present,
    uTime: uTime.value, uTimePresent: uTime.present };
}

export function decodeShareMap(value) {
  const root = isRecord(value?.['31']) ? value['31'] : has(value, 'shareTot') ? value.shareTot : null;
  if (!root) return { present: false, shares: {} };
  const map = isRecord(root['0']) ? root['0'] : isRecord(root.map) ? root.map : null;
  if (!map) return { present: true, shares: {} };
  const shares = {};
  for (const [key, raw] of Object.entries(map)) {
    const shareId = positive(numericId(key));
    if (shareId === null || !isRecord(raw)) continue;
    const recvCnt = nonNegative(Number(read(raw, 'recvCnt', '3')));
    const uTime = timeField(read(raw, 'uTime', '6')).value;
    const shareCnt = nonNegative(Number(read(raw, 'shareCnt', '2')));
    if (recvCnt === null || uTime === null) continue;
    shares[shareId] = Object.freeze({ shareId, recvCnt, shareCnt, uTime, uid: positive(read(raw, 'uid', '0')) });
  }
  return { present: true, shares };
}

export const CLAIM_WIRE = Object.freeze({
  'reward-mail': decodeMail,
  'reward-box': decodeBenefitBox,
  'reward-tasks': decodeTasks,
  'reward-story': decodeStory,
  'reward-guild': decodeGuild,
  'reward-cultivate': decodeCultivate,
  'reward-shop': decodeShop,
  'reward-giftbag': decodeGiftBag,
  'reward-double': decodeDoubleCoin,
  'reward-share': decodeShareMap,
});