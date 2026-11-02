// [第126件·2026-10-05] 「指定花艺」的选项名单（唯一出处＝官方 `c_flowerArt` × `c_item` 名字）。
//
// 为什么要有这个文件（而不是沿用 `/meta` 里那份 104 条的 `recipes`）：
//   旧 `recipes.json` 的号是**花瓶号**（3001～3104），运行期比的却是**花艺号**（300101～312226，
//   官方表 1472 条配方）——两套号根本不是一家。第77件之前那一格「挑完永远对不上」正是这个错位
//   （本轮现读坐实：`RECIPES` 逐条都不在 `c_flowerArt` 的键里，见工作日志第126件）。
//   这一份直接由官方表算出来：`value`＝花艺号，`label`＝官方成品名＋三朵配花名（同名不同配方的
//   27 个变体靠配花区分，客户在官方客户端里看到的也是「这只瓶×这组合」），搜索按名字命中。
//
// 判据来源分级：全部 [官方数值表实证]。
//   · `c_flowerArt`：{lvl,vase,flowers:[3 朵],sPrice,...}，键即花艺号（`-1` 元行与坏行跳过）；
//   · `c_item`：成品与配花的官方中文名（`$name`；现读 1472 条里 74 条成品没名字——没名字的不进名单，
//     客户挑不到≠做不了：不指定时它们照旧在自由候选里，指定名单只给认得出的那一屏）。

import { loadOfficialCfgTable } from "./official-cfg.js";

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
// [现读钉死] 官方 `c_item` 每行的中文名字段＝`name`（2026-10-05 本轮 `loadOfficialCfgTable("c_item")` 现读
// 第一行键序 `name/sname/desc/icon/color/type`——**不是** `$name`，别信直觉写 `$name` 再拿 `||` 兜底，
// 那会把「字段认错」伪装成「恰好能跑」（同族：字段名写错被 try/catch 吞成静默降级，第125件坑账）。
const nameOf = (itemTable, id) => {
  const row = isRecord(itemTable?.[String(id)]) ? itemTable[String(id)] : null;
  const text = String(row?.name ?? "").trim();
  return text || null;
};

let cache = null;

/**
 * 「指定花艺」可挑名单：`[{ value: 花艺号, label, name, flowers }]`，按名字（中文）→ 花艺号排死，
 * 同一份表每次排出来一字一样。表读不到（缺文件/坏 JSON）⇒ 空数组：
 * 页面那一格会显示「没读到」，保存那条路 fail-closed 拒收（能力卡校验同一份分母）。
 */
export function flowerArtOptions() {
  if (cache) return cache;
  const artTable = loadOfficialCfgTable("c_flowerArt");
  const itemTable = loadOfficialCfgTable("c_item");
  if (!isRecord(artTable) || !isRecord(itemTable)) return [];
  const rows = [];
  for (const [rawId, row] of Object.entries(artTable)) {
    const artId = Number(rawId);
    if (!Number.isInteger(artId) || artId <= 0) continue;
    if (!isRecord(row) || !Array.isArray(row.flowers)) continue;
    const name = nameOf(itemTable, artId);
    if (!name) continue; // 官方没给名字的成品不进名单（客户挑不了一个没有名字的东西）
    const flowers = row.flowers.map((id) => nameOf(itemTable, id));
    const label = flowers.every(Boolean) ? `${name}（${flowers.join("／")}）` : name;
    // Export only a complete named recipe. A missing official name stays unavailable,
    // rather than becoming a partial recipe or the string "null" in the public API.
    const completeFlowers = flowers.length > 0 && flowers.every(Boolean)
      && row.flowers.every((id) => typeof itemTable[String(id)]?.name === "string");
    rows.push({ value: artId, label, name,
      flowers: Object.freeze(completeFlowers ? [...flowers] : []) });
  }
  if (!rows.length) return []; // 一张都没算出来＝表不可用，**不缓存**（补表后下一次就好）
  rows.sort((a, b) => a.name.localeCompare(b.name, "zh") || a.value - b.value);
  cache = Object.freeze(rows);
  return cache;
}

/** 只清缓存（表更新/测试用），不碰任何状态。 */
export function resetFlowerArtCatalogCache() {
  cache = null;
}
