#!/usr/bin/env node
// 无尽夏云服务（本项目专用）备份链——本机段：一致性快照 → sha256 记账 → 本机保留清理。
//
// 为什么是这个新文件，而不是改 tools/wujinxia-backup.mjs：
//   · 生产工具（snapshot|encrypt|transfer|restore-check|record|retention）已存在 1118 行，且已部署到
//     garden-node1 的 /opt/wujinxia-app-cloud/tools/，由 wujinxia-app-cloud-backup.service＋.timer 每日
//     03:20 触发。本文件不替换它、不改它一行，只 import 它的导出。
//   · 现读它的 runFull()（tools/wujinxia-backup.mjs:733）：唯一的清理是 remoteRetention()（:932），
//     只经 ssh 远端收件目录，本机 WUJINXIA_BACKUP_DIR 里的 .db 明文快照与 .db.enc 与清单从来没被删过
//     （整文件只有一处 fs.rmSync，是恢复校验的临时明文件，:513）。
//     cloud/app.mjs 的 purgeOnce()（:104）只清日志相关表，同样不管备份文件——本机目录今天无人清。
//   · 现读 transferPackage()（:571）在没配 WUJINXIA_BACKUP_REMOTE 时直接抛错，所以「默认只落本目录、
//     绝不默认往远端推」这条独立链路今天走不通。本文件补的就是这条只落盘、可离线做恢复演练的本地段。
//
// 边界：
//   · 不 import runCommand、不起 ssh/scp/curl，不读写任何远端；路径、开关、保留数全走环境变量。
//   · 默认 dry-run：不加 --apply 一个文件都不删，只出现读到的计划与原因。
//   · 密钥只从 WUJINXIA_BACKUP_KEY_FILE 指向的文件读；密钥值不进命令行、日志、审计正文（沿用生产脱敏闸）。
//   · 只操作本项目自己的备份目录与库文件，绝不读写原网页版的库、目录、服务或备份。
//   · 自测只在临时目录里的临时 SQLite 上跑；真实验收须由主执行者在装机现场做（见配套文档）。
//
// 用法：node tools/wujinxia-backup-local.mjs <run-local|local-retention|local-status> [--apply]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 生产模块的两种落点：并入 tools/ 后是同目录；还放在草稿目录时回到仓库根的 tools/。
const UPSTREAM_CANDIDATES = [
  path.join(import.meta.dirname, 'wujinxia-backup.mjs'),
  path.resolve(import.meta.dirname, '..', '..', '..', 'tools', 'wujinxia-backup.mjs'),
];

export async function loadUpstream() {
  for (const candidate of UPSTREAM_CANDIDATES) {
    if (fs.existsSync(candidate)) return import(pathToFileURL(candidate).href);
  }
  throw new Error('找不到 tools/wujinxia-backup.mjs：本机段复用它的快照/加密/记账实现，不复制第二份');
}

// ── 环境变量 ────────────────────────────────────────────────────────────
export const LOCAL_ENV = {
  disabled: 'WUJINXIA_BACKUP_LOCAL_DISABLED',
  keepDays: 'WUJINXIA_BACKUP_LOCAL_KEEP_DAYS',
  keepCount: 'WUJINXIA_BACKUP_LOCAL_KEEP_COUNT',
  maxBytes: 'WUJINXIA_BACKUP_LOCAL_MAX_BYTES',
  plainMode: 'WUJINXIA_BACKUP_LOCAL_PLAIN_MODE',
  encrypt: 'WUJINXIA_BACKUP_LOCAL_ENCRYPT',
  record: 'WUJINXIA_BACKUP_LOCAL_RECORD',
  maxDelete: 'WUJINXIA_BACKUP_LOCAL_MAX_DELETE',
};
// 默认值与生产远端策略取同一组数字（RETENTION_KEEP_DAYS/COUNT，:788-789），两条链路各自可覆盖。
export const LOCAL_DEFAULTS = {
  keepDays: 30, keepCount: 7, maxBytes: 0, plainMode: 'sweep', encrypt: true, record: true, maxDelete: 200,
};

function envInt(env, name, def, { min, max }) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return def;
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value)) throw new Error(`环境变量 ${name} 必须是整数`);
  if (value < min || value > max) throw new Error(`环境变量 ${name} 必须在 ${min} 到 ${max} 之间`);
  return value;
}

function envBool(env, name, def) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return def;
  const text = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  throw new Error(`环境变量 ${name} 只能是真/假值`);
}

export function resolveLocalConfig(flags = {}, env = process.env) {
  const plainMode = String(env[LOCAL_ENV.plainMode] || LOCAL_DEFAULTS.plainMode).trim().toLowerCase();
  if (!['keep', 'sweep'].includes(plainMode)) throw new Error(`环境变量 ${LOCAL_ENV.plainMode} 只能是 keep 或 sweep`);
  return {
    keepDays: envInt(env, LOCAL_ENV.keepDays, LOCAL_DEFAULTS.keepDays, { min: 1, max: 3650 }),
    keepCount: envInt(env, LOCAL_ENV.keepCount, LOCAL_DEFAULTS.keepCount, { min: 1, max: 1000 }),
    maxBytes: envInt(env, LOCAL_ENV.maxBytes, LOCAL_DEFAULTS.maxBytes, { min: 0, max: 16 * 1024 * 1024 * 1024 * 1024 }),
    plainMode,
    encrypt: envBool(env, LOCAL_ENV.encrypt, LOCAL_DEFAULTS.encrypt),
    record: envBool(env, LOCAL_ENV.record, LOCAL_DEFAULTS.record),
    disabled: envBool(env, LOCAL_ENV.disabled, false),
    maxDelete: envInt(env, LOCAL_ENV.maxDelete, LOCAL_DEFAULTS.maxDelete, { min: 1, max: 10000 }),
    apply: Boolean(flags.apply),
  };
}

// ── 目录护栏：任何 rm 之前先过这几关 ────────────────────────────────────
// allowCreate 只给「产出快照」这一步用（生产 createSnapshot 自己就会 mkdir）；
// 任何会走到删除的调用都必须用默认 false：目录不存在就什么都不做。
export function assertBackupDirSafe(up, base, { allowCreate = false } = {}) {
  const dir = path.resolve(base.backupDir);
  const dbDir = path.dirname(path.resolve(base.dbFile));
  if (!fs.existsSync(dir)) {
    if (allowCreate) {
      const parent = path.dirname(dir);
      if (!fs.existsSync(parent)) throw new up.BackupError('本机备份目录的上级目录都不存在，先人工建好：' + parent);
      if (fs.lstatSync(parent).isSymbolicLink()) throw new up.BackupError('本机备份目录的上级是符号链接，拒绝创建：' + parent);
      fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
      try { fs.chmodSync(dir, 0o700); } catch { /* Windows 上不生效 */ }
    } else {
      throw new up.BackupError('本机备份目录不存在，不做任何事：' + dir);
    }
  }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) throw new up.BackupError('本机备份路径不是目录：' + dir);
  if (fs.realpathSync(dir) !== dir) throw new up.BackupError('本机备份目录本身是符号链接，拒绝在其中做删除：' + dir);
  const root = path.parse(dir).root;
  if (dir === root || path.dirname(dir) === root) {
    throw new up.BackupError('本机备份目录层级过浅，拒绝在其中做删除：' + dir);
  }
  // 生产单元把库放在 <data>/wujinxia-cloud.db、备份放在另一目录；万一配成同目录，
  // 这个删除循环就贴着活库跑，宁可不干也不冒这个险。
  if (dir === dbDir) throw new up.BackupError('本机备份目录不能与数据库所在目录相同：' + dir);
  return dir;
}

const PACKAGE_NAME = /^wujinxia-app-cloud-(\d{8})-(\d{6})\.db\.enc$/;
const SNAPSHOT_NAME = /^wujinxia-app-cloud-(\d{8})-(\d{6})\.db$/;
const MANIFEST_SUFFIX = '.manifest.json';

const stampToIso = (day, time) =>
  `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;

export function listLocalFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    const regular = stat.isFile() && !stat.isSymbolicLink();
    let kind = 'other';
    let match = null;
    if (regular) {
      if (PACKAGE_NAME.test(name)) { kind = 'package'; match = PACKAGE_NAME.exec(name); }
      else if (SNAPSHOT_NAME.test(name)) { kind = 'snapshot'; match = SNAPSHOT_NAME.exec(name); }
      else if (name.endsWith(MANIFEST_SUFFIX)) kind = 'manifest';
    } else if (stat.isSymbolicLink()) kind = 'symlink';
    else if (stat.isDirectory()) kind = 'directory';
    out.push({
      name,
      full,
      kind,
      at: match ? stampToIso(match[1], match[2]) : null,
      timeMs: match ? Date.parse(stampToIso(match[1], match[2])) : null,
      bytes: regular ? Number(stat.size) : 0,
    });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// 清单归属：把 <主件>.manifest.json 还原到磁盘上真实存在的主件名。
// 快照清单是 <prefix>-<stamp>.manifest.json（生产 createSnapshot :158 去掉 .db 后拼的），
// 密文包清单是 <主件>.db.enc.manifest.json（生产 manifestForPackage :309），两种都要认。
export function manifestRefs(name, present) {
  if (!name.endsWith(MANIFEST_SUFFIX)) return [];
  const main = name.slice(0, -MANIFEST_SUFFIX.length);
  const cands = [main, main + '.db', main + '.db.enc'];
  return [...new Set(cands.filter((item) => present.has(item)))];
}

// ── 成功证明（本机版）───────────────────────────────────────────────────
// 与生产远端版 successProof（tools/wujinxia-backup.mjs:802）判据不同且不外溢：
// 这里判的是「本机磁盘上这个文件」，证据是现读——重算 sha256、重量字节数，与 backups 那一行对上，
// 且那一行带 restoreOk；因此不需要远端才需要的 applied/非 dry-run 标记（远端的落盘不确定性这边没有）。
// 远端删除资格仍只由生产 successProof 判定，本函数不参与、不放宽、不被远端链路调用。
export function localProof(up, file, record) {
  const reject = (why) => ({ ok: false, why });
  if (!record) return reject('本机备份账里没有这一份的记录');
  if (Number(record.ok) !== 1) return reject('记录不是成功记录');
  let detail = {};
  try { detail = JSON.parse(String(record.detail || '{}')); } catch { return reject('记录正文解析不出来'); }
  if (String(detail.package || '') !== file.name) return reject('记录里的包名与磁盘文件不是同一份');
  if (detail.restoreOk !== true) return reject('没有恢复校验通过的事实');
  if (!/^[a-f0-9]{64}$/.test(String(record.sha256 || ''))) return reject('记录缺少 64 位包摘要');
  let onDisk;
  try { onDisk = up.sha256File(file.full); } catch (error) {
    return reject('磁盘文件读不出来：' + String(error && error.message || error).slice(0, 80));
  }
  if (onDisk !== String(record.sha256)) return reject('磁盘文件现读 sha256 与记录不符（内容已变或记错行）');
  let size = Number(fs.statSync(file.full).size);
  if (Number.isFinite(size) && Number(record.size_bytes) !== size) {
    return reject('记录字节数 ' + String(record.size_bytes) + ' 与磁盘 ' + size + ' 不符');
  }
  return { ok: true, sha256: onDisk, bytes: size };
}

export function readAccountRecords(up, base) {
  if (!fs.existsSync(base.dbFile)) return [];
  let db;
  try { db = up.openDb(base.dbFile, { readOnly: true }); } catch { return []; }
  try {
    up.ensureBackupTable(db);
    // 按 ok=1 全量取，不设条数窗口：更老的包一旦掉出窗口就永远拿不出证明、被永久保护，
    // 保留规则收敛不了（与生产 :891 同一取舍）。
    return db.prepare('SELECT at,ok,size_bytes,sha256,detail FROM backups WHERE ok=1 ORDER BY id').all();
  } finally { db.close(); }
}

function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── 计划：纯函数，不碰磁盘删除；摘要核验由注入的 proof 完成 ──────────────
export function planLocalRetention({ files, records, proof, now = new Date(), keepDays, keepCount, maxBytes = 0, plainMode = 'sweep', maxDelete = 200 }) {
  const latest = new Map();
  for (const record of records) {
    let detail = {};
    try { detail = JSON.parse(String(record.detail || '{}')); } catch { continue; }
    const pkg = String(detail.package || '');
    if (pkg) latest.set(pkg, record);
  }
  const present = new Set(files.map((f) => f.name));
  const protectedItems = [];
  const proven = [];
  for (const file of files) {
    if (file.kind === 'other' || file.kind === 'symlink' || file.kind === 'directory') continue;
    if (file.kind === 'manifest') continue;
    if (file.kind === 'package' && !Number.isSafeInteger(file.timeMs)) {
      protectedItems.push({ name: file.name, bytes: file.bytes, reason: '文件名的时间戳读不出来，保留不动' });
      continue;
    }
    if (file.kind === 'snapshot') continue;   // 明文快照跟着同名密文包走，单独判
    const result = proof(file, latest.get(file.name));
    if (result.ok) proven.push({ ...file, sha256: result.sha256, bytes: result.bytes });
    else protectedItems.push({ name: file.name, bytes: file.bytes, reason: result.why });
  }
  const ordered = proven.sort((a, b) => (b.timeMs - a.timeMs) || (a.name < b.name ? -1 : 1));
  const newest = ordered[0] || null;

  const reasons = new Map();
  for (const item of ordered.slice(0, keepCount)) reasons.set(item.name, `最近 ${keepCount} 份校验成功包`);
  for (const day of [...new Set(ordered.map((item) => item.at.slice(0, 10)))]) {
    const dayMs = Date.parse(day + 'T23:59:59');
    const withinWindow = now.getTime() - dayMs <= keepDays * 86_400_000;
    if (!withinWindow) continue;
    const last = ordered.find((item) => item.at.slice(0, 10) === day);
    if (last && !reasons.has(last.name)) reasons.set(last.name, `最近 ${keepDays} 天内 ${day} 的最后一份成功包`);
  }
  const keep = ordered.filter((item) => reasons.has(item.name));
  const candidates = ordered.filter((item) => !reasons.has(item.name));

  const remove = [];
  const notes = [];
  if (ordered.length <= keepCount) notes.push(`本机校验成功包共 ${ordered.length} 份，未满或刚到 ${keepCount} 份下限，密文包一份都不删`);
  let keptBytes = keep.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
  for (const item of candidates) {
    if (ordered.length <= keepCount) break;
    if (remove.length >= maxDelete) { notes.push(`本轮删除条数触顶 ${maxDelete}，其余候选留下一轮`); break; }
    if (newest && item.name === newest.name) continue;
    remove.push({ name: item.name, at: item.at, bytes: item.bytes, reason: '既不在最近成功包、也不是最近每日末份' });
  }
  // 字节顶是第二道压力：清完上面这批还超顶时，从最早的那份开始挤；但「最近 keepCount 份底线」之内
  // 与最新一份绝不为了凑字节数而删，挤不动就报超、继续留着（宁可占盘，不可把该留的证据清了）。
  const totalBytes = ordered.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
  let projected = totalBytes - remove.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
  if (maxBytes > 0 && projected > maxBytes) {
    const floorNames = new Set(ordered.slice(0, keepCount).map((item) => item.name));
    for (const item of [...keep].reverse()) {
      if (projected <= maxBytes || remove.length >= maxDelete) break;
      if (newest && item.name === newest.name) continue;
      if (floorNames.has(item.name)) continue;
      remove.push({ name: item.name, at: item.at, bytes: item.bytes, reason: '为守住本机字节顶：只为每日末份保留、且不在最近份数底线之内' });
      projected -= Number(item.bytes) || 0;
    }
    if (projected > maxBytes) {
      notes.push(`底线内的成功包合计 ${projected} 字节仍高于字节顶 ${maxBytes}：不再多删，请按需要放宽 ${LOCAL_ENV.maxBytes}`);
    }
  }

  // 明文快照：sweep 时清掉「同名密文包已存在且拿得出恢复校验通过记录」的中间件（可用密文包+密钥恢复），
  // 避免明文口令散列与日志长期驻盘。同名密文包不存在或没证明的，明文是唯一副本，绝不动；最新一份的明文也不动。
  const provenNames = new Set(proven.map((item) => item.name));
  const removedNames = new Set(remove.map((item) => item.name));
  for (const file of files) {
    if (file.kind !== 'snapshot') continue;
    const encName = file.name + '.enc';
    if (newest && encName === newest.name) { protectedItems.push({ name: file.name, bytes: file.bytes, reason: '最新一份的明文快照不动' }); continue; }
    if (!present.has(encName)) { protectedItems.push({ name: file.name, bytes: file.bytes, reason: '同名密文包不在目录里，明文是唯一副本，不动' }); continue; }
    if (!provenNames.has(encName)) { protectedItems.push({ name: file.name, bytes: file.bytes, reason: '同名密文包拿不出恢复校验通过记录，明文不动' }); continue; }
    if (plainMode === 'keep') continue;
    if (remove.length >= maxDelete) { notes.push(`本轮删除条数触顶 ${maxDelete}，明文快照留下一轮`); break; }
    remove.push({ name: file.name, at: file.at, bytes: file.bytes, reason: '明文快照只是加密前中间件：同名密文包已有恢复校验通过记录（plainMode=sweep）' });
    removedNames.add(file.name);
  }
  // 清单跟着它的主人件：主人件被删就一起删；主人件留着就留着；认不出主人件的不动。
  for (const file of files) {
    if (file.kind !== 'manifest') continue;
    const refs = manifestRefs(file.name, present);
    if (!refs.length) { protectedItems.push({ name: file.name, bytes: file.bytes, reason: '清单认不出对应主件，不动' }); continue; }
    if (removedNames.has(refs[0])) {
      if (remove.length >= maxDelete) { notes.push(`本轮删除条数触顶 ${maxDelete}，清单留下一轮`); break; }
      remove.push({ name: file.name, at: file.at, bytes: file.bytes, reason: '随对应主件一起清理' });
      removedNames.add(file.name);
    }
  }
  return {
    scope: 'local',
    listed: files.length,
    packageCount: files.filter((f) => f.kind === 'package').length,
    snapshotCount: files.filter((f) => f.kind === 'snapshot').length,
    successCount: ordered.length,
    keep, remove, protectedItems,
    others: files.filter((f) => f.kind === 'other').map((f) => f.name),
    unsafe: files.filter((f) => f.kind === 'symlink' || f.kind === 'directory').map((f) => f.name),
    keptBytes: projected,
    totalBytes,
    keepDays, keepCount, maxBytes, plainMode,
    note: notes.join('；'),
  };
}

// ── 审计：写进生产工具已有的 backup_retention 表，用 detail.scope 区分本机/远端 ──
// 注意：这张表今天没有任何读取方（详见配套文档「谁读这一行」），写它属于留痕，不等于已可用。
export function writeRetentionAudit(up, base, { at, ok, plan, actual, removedBytes, detail }) {
  const text = JSON.stringify(detail || {});
  for (const rule of up.BACKUP_DETAIL_FORBIDDEN) {
    if (rule.pattern.test(text)) throw new up.BackupError('本机保留审计含不应出现的值（' + rule.label + '），已拒绝记账');
  }
  const db = up.openDb(base.dbFile);
  try {
    up.ensureRetentionTable(db);
    db.exec('BEGIN IMMEDIATE');
    try {
      const info = db.prepare('INSERT INTO backup_retention(at,ok,kept,removed,bytes,reason,detail) VALUES(?,?,?,?,?,?,?)')
        .run(String(at), ok ? 1 : 0, Number(actual.kept || 0), Number(actual.removed || 0), Number(removedBytes || 0),
          String(plan.note || `本机按最近 ${plan.keepCount} 份校验成功包与最近 ${plan.keepDays} 天每日末份并集保留（计划清理 ${(plan.remove || []).length} 项）`),
          text);
      db.exec('COMMIT');
      return { id: Number(info.lastInsertRowid) };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

// ── 执行：先登记删除意图，再逐文件删并现读复核，最后按实际结果记审计 ──────
export function runLocalRetention(up, base, local, { now = new Date(), log = () => {} } = {}) {
  assertBackupDirSafe(up, base);
  const files = listLocalFiles(base.backupDir);
  const records = readAccountRecords(up, base);
  const proof = (file, record) => localProof(up, file, record);
  const plan = planLocalRetention({
    files, records, proof, now,
    keepDays: local.keepDays, keepCount: local.keepCount, maxBytes: local.maxBytes,
    plainMode: local.plainMode, maxDelete: local.maxDelete,
  });
  const at = now.toISOString();
  if (!plan.remove.length) {
    const audit = writeRetentionAudit(up, base, {
      at, ok: true, plan, actual: { kept: plan.keep.length, removed: 0 }, removedBytes: 0,
      detail: { scope: 'local', status: 'result', listed: plan.listed, keep: plan.keep.map((i) => i.name), planned: [], results: [], protected: plan.protectedItems.map((i) => i.name), note: plan.note || '本机本轮没有可删候选' },
    });
    return { dryRun: !local.apply, applied: false, plan, results: [], removedBytes: 0, audit };
  }
  const planned = plan.remove.map((item) => item.name);
  if (!local.apply) {
    // 预览也是真实只读列举（上面的 listLocalFiles 与 sha256 现读就是现场），但不写意图、不动文件。
    return { dryRun: true, applied: false, plan, results: [], removedBytes: 0, audit: null, planned };
  }
  const intent = writeRetentionAudit(up, base, {
    at, ok: false, plan, actual: { kept: plan.keep.length, removed: 0 }, removedBytes: 0,
    detail: { scope: 'local', status: 'intent', planned, listed: plan.listed, keep: plan.keep.map((i) => i.name) },
  });
  const results = [];
  let removedBytes = 0;
  for (const item of plan.remove) {
    const full = path.join(base.backupDir, item.name);
    try {
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink() || !st.isFile()) throw new Error('不是本目录内的普通文件');
      fs.unlinkSync(full);
      results.push({ name: item.name, result: fs.existsSync(full) ? 'failed' : 'removed', bytes: Number(item.bytes) || 0 });
    } catch (error) {
      results.push({ name: item.name, result: 'failed', why: String(error && error.message || error).slice(0, 160), bytes: 0 });
    }
  }
  // 删完再现读一次目录：账上的删除数必须与现场一致，且本机必须还留着至少一份密文包。
  const after = listLocalFiles(base.backupDir);
  const stillThere = new Set(after.map((f) => f.name));
  for (const result of results) if (result.result === 'removed' && stillThere.has(result.name)) result.result = 'failed';
  const leftPackages = after.filter((f) => f.kind === 'package').length;
  let failure = '';
  if (leftPackages === 0) failure = '清理后本机一份密文包都不剩，与保留规则矛盾，请人工核对目录';
  const removedCount = results.filter((r) => r.result === 'removed').length;
  removedBytes = results.filter((r) => r.result === 'removed').reduce((sum, r) => sum + (Number(r.bytes) || 0), 0);
  const ok = results.length > 0 && removedCount === results.length && leftPackages > 0;
  if (removedCount !== results.length) failure = failure || '逐文件复核有项目没删掉：' + results.filter((r) => r.result !== 'removed').map((r) => r.name).join(',');
  const audit = writeRetentionAudit(up, base, {
    at, ok, plan, actual: { kept: plan.keep.length, removed: removedCount }, removedBytes,
    detail: {
      scope: 'local', status: 'result', intentId: intent.id, listed: plan.listed,
      keep: plan.keep.map((i) => i.name), planned, results,
      removed: results.filter((r) => r.result === 'removed').map((r) => r.name),
      undetermined: results.filter((r) => r.result !== 'removed').map((r) => r.name),
      protected: plan.protectedItems.map((i) => i.name), leftPackages, note: plan.note || '', failure,
    },
  });
  log('本机保留清理：保留并集 ' + plan.keep.length + ' 份，实删 ' + removedCount + '/' + results.length + ' 项，' + removedBytes + ' 字节');
  return { dryRun: false, applied: true, ok, plan, results, removedBytes, intent, audit, failure };
}

// ── 不加密时也要能独立证明这份副本可用：直接对快照做 integrity + 逐表对平 ──
export function verifySnapshotLocal(up, snapshotFile, manifest) {
  const report = { kind: 'wujinxia-local-snapshot-check', integrity: null, tablesChecked: 0, diffs: [], ok: false, error: null };
  let db;
  try {
    db = up.openDb(snapshotFile, { readOnly: true });
    report.integrity = up.integrityResult(db);
    const counts = up.tableCounts(db, up.listUserTables(db));
    report.tablesChecked = counts.length;
    const diffs = up.compareCounts(counts, (manifest.tables || []).map((t) => ({ name: t.name, rows: Number(t.rows) })));
    report.diffs = diffs;
    if (report.integrity !== 'ok') throw new up.BackupError(`快照 integrity_check 回「${report.integrity}」`);
    if (diffs.length) throw new up.BackupError('快照与清单逐表行数不平：' + up.formatDiffs(diffs, '实际', '清单'));
    report.ok = true;
  } catch (error) {
    report.error = String(error && error.message || error);
  } finally { if (db) { try { db.close(); } catch { /* 忽略 */ } } }
  return report;
}

// ── run-local：快照 →（可选）加密 → 恢复校验 → 记账 → 本机保留清理 ────────
export function runLocal(up, base, local, { now = new Date(), log = () => {} } = {}) {
  // 这一步只产出文件，不删任何东西，所以允许首次创建目录；后面的保留清理仍走严格护栏。
  assertBackupDirSafe(up, base, { allowCreate: true });
  const at = now.toISOString();
  const steps = { scope: 'local' };
  steps.snapshot = up.createSnapshot(base, { now });
  log('一致性快照：' + path.basename(steps.snapshot.snapshot) + '（' + steps.snapshot.manifest.method + '，integrity ' + steps.snapshot.manifest.integrity + '，' + steps.snapshot.manifest.snapshotBytes + ' 字节）');
  let targetFile = steps.snapshot.snapshot;
  if (local.encrypt) {
    steps.encrypt = up.encryptSnapshot(base, {
      snapshotFile: steps.snapshot.snapshot,
      manifestFile: steps.snapshot.manifestPath,
      now,
    });
    targetFile = steps.encrypt.packageFile;
    log('本机加密包：' + path.basename(steps.encrypt.packageFile) + '（密钥指纹 ' + steps.encrypt.keyFingerprint + '，密钥值不输出）');
    steps.restore = up.restoreCheck(base, { packageFile: steps.encrypt.packageFile, manifestFile: steps.encrypt.manifestFile, now }).report;
    log('恢复校验（解密→integrity→逐表对平）：' + (steps.restore.ok ? '通过' : '失败'));
  } else {
    log('WUJINXIA_BACKUP_LOCAL_ENCRYPT=0：只留明文快照，不做加密（只适合临时排障，不要当日常配置）');
    steps.restore = verifySnapshotLocal(up, steps.snapshot.snapshot, steps.snapshot.manifest);
    log('快照校验（integrity＋逐表对平）：' + (steps.restore.ok ? '通过' : '失败'));
  }
  const restoreOk = Boolean(steps.restore && steps.restore.ok);
  const sha256 = up.sha256File(targetFile);
  // 本机段的证明组合与远端不同：没上传，所以 applied=false、dryRun=true、remote 空，
  // 另加 scope=local/localOnly=true，免得后台「最近备份」被读成「已经出机」。
  const detail = {
    ...up.buildBackupDetail({
      manifest: steps.snapshot.manifest,
      encryptInfo: steps.encrypt ? { keyFingerprint: steps.encrypt.keyFingerprint, packageFile: steps.encrypt.packageFile } : null,
      restoreReport: restoreOk ? steps.restore : null,
      transferInfo: null,
    }),
    scope: 'local', localOnly: true, encrypted: Boolean(local.encrypt),
  };
  if (local.record) {
    steps.record = up.recordBackup(base, {
      detail, ok: restoreOk, sizeBytes: Number(fs.statSync(targetFile).size), sha256, remote: '', at,
    });
    log('记账 backups#' + steps.record.id + '（ok=' + steps.record.row.ok + '，本机段：未推远端）');
  } else {
    log('WUJINXIA_BACKUP_LOCAL_RECORD=0：本次不写 backups 账；保留清理因此拿不出成功证明，属预期');
  }
  if (!restoreOk) {
    // 新一份没成功就一份旧的都不删（与生产 runFull :772 同一取舍），并把原因抛出去。
    log('本机保留清理跳过：本次备份没有拿到恢复校验通过，不删任何旧文件');
    throw new up.BackupError('本机备份的恢复校验没过，这份副本不可用于恢复：' + String((steps.restore && steps.restore.error) || '未给出原因').slice(0, 200));
  }
  steps.retention = runLocalRetention(up, base, local, { now, log });
  return steps;
}

// ── CLI ─────────────────────────────────────────────────────────────────
export const HELP_TEXT = [
  '用法：node tools/wujinxia-backup-local.mjs <run-local|local-retention|local-status> [选项]',
  '',
  '本机段：一致性快照→sha256 记账→本机保留清理。不连远端、不起 ssh/scp。',
  '默认 dry-run：必须显式 --apply 才删文件；run-local 未过恢复校验时一个旧文件都不删。',
  '选项：--apply',
  '',
  '路径沿用生产工具的环境变量：WUJINXIA_DATA_DIR、WUJINXIA_DB_FILE（默认 <data>/wujinxia-cloud.db）、',
  '  WUJINXIA_BACKUP_DIR（默认 <root>/.runtime/wujinxia-backups）、WUJINXIA_BACKUP_KEY_FILE、WUJINXIA_BACKUP_PREFIX。',
  '本机段自己的开关（全走环境变量）：',
  `  ${LOCAL_ENV.keepDays}（默认 ${LOCAL_DEFAULTS.keepDays}）、${LOCAL_ENV.keepCount}（默认 ${LOCAL_DEFAULTS.keepCount}）、`,
  `  ${LOCAL_ENV.maxBytes}（默认 ${LOCAL_DEFAULTS.maxBytes}＝不设字节顶）、${LOCAL_ENV.plainMode}=keep|sweep（默认 ${LOCAL_DEFAULTS.plainMode}）、`,
  `  ${LOCAL_ENV.encrypt}、${LOCAL_ENV.record}、${LOCAL_ENV.maxDelete}（默认 ${LOCAL_DEFAULTS.maxDelete}）、${LOCAL_ENV.disabled}。`,
].join('\n');

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const out = deps.log || ((text) => console.log(text));
  const up = await loadUpstream();
  let parsed;
  try { parsed = up.parseArgv(argv); } catch (error) { out('[本机备份] 失败：' + error.message); return 2; }
  if (parsed.help || !parsed.command) { out(HELP_TEXT); return parsed.help ? 0 : 2; }
  const base = up.resolveConfig({ ...parsed.flags, apply: parsed.apply }, env);
  let local;
  // apply 是 parseArgv 单独剥出来的开关，不在 flags 里；漏传就永远停在 dry-run。
  try { local = resolveLocalConfig({ ...parsed.flags, apply: parsed.apply }, env); } catch (error) { out('[本机备份] 失败：' + error.message); return 2; }
  if (local.disabled) { out('[本机备份] ' + LOCAL_ENV.disabled + '=真：本机段已停用，一个文件都不动'); return 0; }
  const now = deps.now ? deps.now() : new Date();
  const summarise = (plan) => [
    `现读 ${plan.listed} 项｜密文包 ${plan.packageCount} 份、明文快照 ${plan.snapshotCount} 份、其中拿得出成功证明 ${plan.successCount} 份`,
    `保留并集 ${plan.keep.length} 份｜候选删除 ${plan.remove.length} 项｜无证明或护栏保护 ${plan.protectedItems.length} 项｜不认识的命名 ${plan.others.length} 个｜非普通文件 ${plan.unsafe.length} 个`,
    `保留集字节 ${plan.keptBytes}｜目录内成功包合计 ${plan.totalBytes}` + (plan.note ? '｜' + plan.note : ''),
  ];
  try {
    if (parsed.command === 'local-status') {
      const plan = planLocalRetention({
        files: (assertBackupDirSafe(up, base), listLocalFiles(base.backupDir)),
        records: readAccountRecords(up, base),
        proof: (file, record) => localProof(up, file, record),
        now, ...local,
      });
      for (const line of summarise(plan)) out('[本机备份] ' + line);
      for (const item of plan.keep) out('[本机备份] 保留 ' + item.name + '：' + item.reason);
      for (const item of plan.remove) out('[本机备份] 候选删除 ' + item.name + '：' + item.reason);
      for (const item of plan.protectedItems) out('[本机备份] 不动 ' + item.name + '：' + item.reason);
      out('RESULT_JSON=' + JSON.stringify({
        dir: base.backupDir, listed: plan.listed, success: plan.successCount,
        keep: plan.keep.map((i) => i.name), remove: plan.remove.map((i) => i.name),
        protected: plan.protectedItems.map((i) => i.name), note: plan.note,
      }));
      return 0;
    }
    if (parsed.command === 'local-retention') {
      const r = runLocalRetention(up, base, local, { now, log: (t) => out('[本机备份] ' + t) });
      for (const line of summarise(r.plan)) out('[本机备份] ' + line);
      out(`[本机备份] ${r.dryRun ? 'dry-run：一个文件都不删' : (r.ok ? '已按清单清理，审计 backup_retention#' + r.audit.id : '清理未全部完成，逐文件实际结果已记审计 #' + r.audit.id + '：' + (r.failure || ''))}`);
      out('RESULT_JSON=' + JSON.stringify({
        dryRun: r.dryRun, ok: r.dryRun ? null : r.ok, keep: r.plan.keep.map((i) => i.name),
        planned: r.plan.remove.map((i) => i.name), results: r.results || [], removedBytes: r.removedBytes,
        audit: r.audit ? r.audit.id : null, failure: r.failure || null,
      }));
      return r.dryRun || r.ok ? 0 : 1;
    }
    if (parsed.command === 'run-local') {
      const steps = runLocal(up, base, local, { now, log: (t) => out('[本机备份] ' + t) });
      out('RESULT_JSON=' + JSON.stringify({
        snapshot: steps.snapshot.snapshot,
        package: steps.encrypt ? steps.encrypt.packageFile : null,
        sha256: up.sha256File(steps.encrypt ? steps.encrypt.packageFile : steps.snapshot.snapshot),
        restoreOk: true, recordId: steps.record ? steps.record.id : null,
        audit: steps.retention && steps.retention.audit ? steps.retention.audit.id : null,
        retentionDryRun: steps.retention ? steps.retention.dryRun : null,
        remote: null, scope: 'local',
      }));
      return 0;
    }
    out(HELP_TEXT);
    out('[本机备份] 失败：未知命令 ' + parsed.command);
    return 2;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    out('[本机备份] 失败：' + up.redact(message));
    out('RESULT_JSON=' + JSON.stringify({ ok: false, error: up.redact(message).slice(0, 300) }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
