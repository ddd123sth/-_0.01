#!/usr/bin/env node
// 无尽夏云服务（本项目专用）备份工具：一致性快照 → AES-256-GCM 加密 → 传另一台服务器 → 恢复校验 → 记账。
//
// 边界（与 AGENTS.md 一致）：
//   · 只服务本项目的库（`WUJINXIA_DB_FILE`），不读、不写、不复制原网页版的库、脚本、服务或备份。
//   · 活库只用 `VACUUM INTO` 做一致性导出，绝不把正在写的主库文件直接 copy 当备份。
//   · 默认 dry-run：不加 `--apply` 时只打印将要执行的命令，不起 scp/ssh、不建远端目录。
//   · 密钥只从 `WUJINXIA_BACKUP_KEY_FILE` 指向的密钥文件读取；密钥值不进命令行、日志、错误信息或 `backups.detail`。
//   · 远端只使用 SSH 别名（禁止写死 IP）。
//
// 用法：node tools/wujinxia-backup.mjs <snapshot|encrypt|transfer|restore-check|record|run> [选项]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const SERVICE = 'wujinxia-app-cloud';
export const DEFAULT_DB_BASENAME = 'wujinxia-cloud.db';
export const ENCRYPT_ALGO = 'aes-256-gcm';
export const PACKAGE_MAGIC = 'WJXBK001';
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const BACKUP_TABLE = 'backups';
// 本仓被版本控制忽略的顶层目录：密钥文件若落在仓库内，只允许放在这些目录里。
export const VCS_IGNORED_TOP_DIRS = ['.runtime', 'node_modules', '.gradle', '.git'];

export class BackupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackupError';
  }
}

export function projectRoot() {
  return path.resolve(import.meta.dirname, '..');
}

// ── 命令行与配置 ──────────────────────────────────────────────────────────

export function parseArgv(argv) {
  const list = Array.isArray(argv) ? argv.slice() : [];
  const command = list.length && !String(list[0]).startsWith('--') ? String(list.shift()) : null;
  const flags = {};
  let apply = false;
  let help = false;
  for (let i = 0; i < list.length; i += 1) {
    const token = String(list[i]);
    if (token === '--apply') { apply = true; continue; }
    if (token === '--help' || token === '-h') { help = true; continue; }
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const next = list[i + 1];
      if (next === undefined || String(next).startsWith('--')) flags[name] = true;
      else { flags[name] = String(next); i += 1; }
      continue;
    }
    throw new BackupError('无法识别的参数：' + token);
  }
  return { command, flags, apply, help };
}

export function resolveConfig(flags = {}, env = process.env, root = projectRoot()) {
  const value = (name, fallback) => {
    const fromFlag = flags[name];
    if (typeof fromFlag === 'string' && fromFlag.trim()) return fromFlag;
    const fromEnv = env[name.replace(/-/g, '_').toUpperCase()];
    if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv;
    return fallback;
  };
  const dataDir = value('data-dir', env.WUJINXIA_DATA_DIR || path.join(root, '.runtime', 'wujinxia-cloud'));
  const dbFile = env.WUJINXIA_DB_FILE
    ? path.resolve(env.WUJINXIA_DB_FILE)
    : (typeof flags.db === 'string' && flags.db ? path.resolve(flags.db) : path.resolve(dataDir, DEFAULT_DB_BASENAME));
  const backupDir = path.resolve(value('out', env.WUJINXIA_BACKUP_DIR || path.join(root, '.runtime', 'wujinxia-backups')));
  const prefix = value('name', env.WUJINXIA_BACKUP_PREFIX || SERVICE);
  const keyFile = env.WUJINXIA_BACKUP_KEY_FILE
    ? path.resolve(env.WUJINXIA_BACKUP_KEY_FILE)
    : (typeof flags['key-file'] === 'string' && flags['key-file'] ? path.resolve(flags['key-file']) : null);
  const remote = value('remote', env.WUJINXIA_BACKUP_REMOTE || '');
  const workDir = path.resolve(value('work', env.WUJINXIA_RESTORE_WORK_DIR || path.join(root, '.runtime', 'wujinxia-restore-check')));
  const reportDir = path.resolve(value('report-dir', env.WUJINXIA_REPORT_DIR || path.join(root, '.runtime', 'wujinxia-backup-reports')));
  const traceFile = env.WUJINXIA_EXEC_TRACE ? path.resolve(env.WUJINXIA_EXEC_TRACE) : null;
  const transportStub = env.WUJINXIA_TRANSPORT_STUB ? path.resolve(env.WUJINXIA_TRANSPORT_STUB) : null;
  return {
    root, dataDir, dbFile, backupDir, prefix, keyFile, remote,
    workDir, reportDir, traceFile, transportStub,
    apply: Boolean(flags.apply),
  };
}

// ── 时间与散列 ────────────────────────────────────────────────────────────

const pad = (n, w = 2) => String(n).padStart(w, '0');

// 日期与时刻必须出自同一个钟表：全用本地时间，避免 UTC 日期配本地时刻生成「昨天的文件名配今天的时刻」。
export function localStamp(date = new Date()) {
  const d = date;
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// ── 数据库读取（一致性快照与清单）────────────────────────────────────────

export function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

export function listUserTables(db) {
  return db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map((row) => String(row.name));
}

export function tableCounts(db, names) {
  const out = [];
  for (const name of names) {
    out.push({ name, rows: Number(db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(name)}`).get().c) });
  }
  return out;
}

export function integrityResult(db) {
  const row = db.prepare('PRAGMA integrity_check').get();
  if (!row) return 'no-result';
  return String(Object.values(row)[0]).toLowerCase();
}

export function openDb(file, { readOnly = false } = {}) {
  if (!fs.existsSync(file)) throw new BackupError('找不到数据库文件：' + file);
  const db = new DatabaseSync(file, readOnly ? { readOnly: true } : {});
  try {
    // 注意：不要设 PRAGMA query_only——VACUUM INTO 需要写目标文件，query_only 会把它打回
    // 「attempt to write a readonly database」，一致性导出就没了（SQLite 只读事务允许 VACUUM INTO）。
    db.exec('PRAGMA busy_timeout=5000');
  } catch (error) {
    try { db.close(); } catch { /* 关闭失败不覆盖原始错误 */ }
    throw new BackupError('打开数据库失败：' + file + '：' + String(error && error.message || error));
  }
  return db;
}

// ── snapshot：VACUUM INTO 一致性导出 ─────────────────────────────────────

export function createSnapshot(config, { now = new Date() } = {}) {
  const { dbFile, backupDir, prefix } = config;
  if (!fs.existsSync(dbFile)) throw new BackupError('找不到数据库文件：' + dbFile);
  fs.mkdirSync(backupDir, { recursive: true });
  const snapshot = path.join(backupDir, `${prefix}-${localStamp(now)}.db`);
  const manifestPath = snapshot.replace(/\.db$/, '.manifest.json');
  if (fs.existsSync(snapshot)) throw new BackupError('快照目标已存在，不覆盖：' + snapshot);

  // 一致性导出：只读连接上执行 VACUUM INTO，能读到自己 WAL 里尚未 checkpoint 的行，
  // 产出单个自洽文件；直接 copy 活库文件会漏掉这部分行，所以不允许那样做。
  const live = openDb(dbFile, { readOnly: true });
  const journalMode = String(live.prepare('PRAGMA journal_mode').get().journal_mode || '').toLowerCase();
  try {
    live.prepare('VACUUM INTO ?').run(snapshot);
  } catch (error) {
    throw new BackupError('VACUUM INTO 一致性导出失败：' + String(error && error.message || error));
  } finally {
    live.close();
  }

  const snap = openDb(snapshot, { readOnly: true });
  let integrity;
  let tables;
  let snapshotTables;
  try {
    integrity = integrityResult(snap);
    tables = listUserTables(snap);
    snapshotTables = tableCounts(snap, tables);
  } finally {
    snap.close();
  }
  if (integrity !== 'ok') {
    throw new BackupError(`快照 integrity_check 回「${integrity}」，这份副本不可信，已中止：${snapshot}`);
  }

  // 现读对平：快照行数和同一时刻活库读到的行数必须一致，否则说明导出期间有并发写落地。
  const liveRead = openDb(dbFile, { readOnly: true });
  let liveTables;
  let liveTableNames;
  try {
    liveTableNames = listUserTables(liveRead);
    liveTables = tableCounts(liveRead, liveTableNames);
  } finally {
    liveRead.close();
  }
  const diffs = compareCounts(snapshotTables, liveTables);
  if (diffs.length) {
    throw new BackupError(
      '快照与活库现读行数不平（导出期间发生并发写），本次快照作废：'
      + formatDiffs(diffs, '快照', '活库'),
    );
  }

  const manifest = {
    kind: 'wujinxia-backup-manifest',
    version: 1,
    service: SERVICE,
    method: 'VACUUM INTO',
    createdAt: now.toISOString(),
    sourceDb: dbFile,
    snapshot: path.basename(snapshot),
    snapshotBytes: fs.statSync(snapshot).size,
    sha256: sha256File(snapshot),
    integrity,
    journalMode,
    tableCount: snapshotTables.length,
    tables: snapshotTables,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { snapshot, manifestPath, manifest };
}

export function compareCounts(left, right) {
  const mapLeft = new Map(left.map((row) => [row.name, Number(row.rows)]));
  const mapRight = new Map(right.map((row) => [row.name, Number(row.rows)]));
  const names = [...new Set([...mapLeft.keys(), ...mapRight.keys()])].sort();
  const diffs = [];
  for (const name of names) {
    const a = mapLeft.get(name);
    const b = mapRight.get(name);
    if (a === undefined || b === undefined || a !== b) diffs.push({ table: name, left: a ?? null, right: b ?? null });
  }
  return diffs;
}

export function formatDiffs(diffs, leftLabel, rightLabel) {
  return diffs.map((d) => `${d.table}（${leftLabel}=${d.left ?? '缺表'}，${rightLabel}=${d.right ?? '缺表'}）`).join('；');
}

// ── 密钥 ─────────────────────────────────────────────────────────────────

export function assertKeyFileLocation(keyFile, root = projectRoot(), platform = process.platform) {
  const abs = path.resolve(keyFile);
  const rel = path.relative(root, abs);
  const insideRepo = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (!insideRepo) return { abs, insideRepo, note: '密钥文件在仓库目录之外' };
  const top = rel.split(path.sep)[0];
  if (!VCS_IGNORED_TOP_DIRS.includes(top)) {
    throw new BackupError(
      '密钥文件不能放在版本控制目录内：' + abs + '（本仓只允许 .runtime/ 之类的忽略目录存放本机临时材料）。'
      + ' 请把密钥移到仓库外，例如 /etc/wujinxia-app-cloud/backup.key。',
    );
  }
  return { abs, insideRepo, note: '密钥文件位于本仓忽略目录 ' + top + '/，不随版本控制或发布件分发' };
}

// 权限闸单独成函数，方便在 Windows 上也对 POSIX 分支做真实断言（Windows 的 st.mode 不反映 POSIX 位）。
export function checkKeyMode(mode, platform = process.platform, file = '') {
  if (platform === 'win32') return;
  if (mode !== 0o600) {
    throw new BackupError('密钥文件权限必须是 0600（只有属主可读写），当前 0' + mode.toString(8) + '：' + file);
  }
}

// 密钥值一旦读入就登记到脱敏池，所有对外输出的行都先过一遍（belt & braces，正常情况下密钥根本不会被拼进消息）。
const REDACTION_POOL = new Set();

export function registerSecretForRedaction(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
  if (text.length >= 4) REDACTION_POOL.add(text);
}

export function loadKeyFile(keyFile, { root = projectRoot(), platform = process.platform } = {}) {
  if (!keyFile) throw new BackupError('缺少密钥文件：请设置 WUJINXIA_BACKUP_KEY_FILE 或用 --key-file 指定');
  const abs = path.resolve(keyFile);
  if (!fs.existsSync(abs)) throw new BackupError('找不到密钥文件：' + abs);
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new BackupError('密钥路径不是普通文件：' + abs);
  checkKeyMode(stat.mode & 0o777, platform, abs);
  const location = assertKeyFileLocation(abs, root, platform);
  const text = fs.readFileSync(abs, 'utf8').trim();
  if (!text) throw new BackupError('密钥文件为空：' + abs);
  let key = null;
  let derived = false;
  if (/^[0-9a-fA-F]{64}$/.test(text)) {
    key = Buffer.from(text, 'hex');
  } else if (/^[A-Za-z0-9+/]{43}=$/.test(text)) {
    const candidate = Buffer.from(text, 'base64');
    if (candidate.length === 32) key = candidate;
  }
  if (!key) {
    // 口令式密钥文件：用 SHA-256 固定派生 32 字节（强度依赖口令本身，不做强度承诺）。
    key = crypto.createHash('sha256').update(text, 'utf8').digest();
    derived = true;
  }
  if (key.length !== 32) throw new BackupError('密钥文件内容不是 32 字节密钥（hex/base64/口令均可）：' + abs);
  const fingerprint = crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
  return { key, fingerprint, derived, location, path: abs };
}

// ── encrypt / decrypt：AES-256-GCM ───────────────────────────────────────

export function packageFilePath(snapshotFile) {
  return snapshotFile + '.enc';
}

export function manifestForPackage(packageFile) {
  return packageFile + '.manifest.json';
}

// 未指定 --in/--package 时取备份目录里最新的一份（按文件名时间戳，本工具命名格式为 <前缀>-YYYYMMDD-HHMMSS.db）。
export function latestByPattern(dir, pattern) {
  if (!fs.existsSync(dir)) return null;
  const hits = fs.readdirSync(dir).filter((name) => pattern.test(name)).sort();
  if (!hits.length) return null;
  return path.join(dir, hits[hits.length - 1]);
}

export function latestSnapshot(backupDir, prefix) {
  const esc = String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return latestByPattern(backupDir, new RegExp('^' + esc + '-\\d{8}-\\d{6}\\.db$'));
}

export function latestPackage(backupDir, prefix) {
  const esc = String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return latestByPattern(backupDir, new RegExp('^' + esc + '-\\d{8}-\\d{6}\\.db\\.enc$'));
}

export function buildPackageBuffer({ snapshotFile, key, fingerprint, manifest, createdAt }) {
  const plain = fs.readFileSync(snapshotFile);
  const iv = crypto.randomBytes(IV_BYTES);
  const header = {
    magic: PACKAGE_MAGIC,
    algo: ENCRYPT_ALGO,
    keyFingerprint: fingerprint,
    iv: iv.toString('base64'),
    tagBytes: TAG_BYTES,
    createdAt,
    snapshot: path.basename(snapshotFile),
    plainBytes: plain.length,
    plainSha256: crypto.createHash('sha256').update(plain).digest('hex'),
    manifestSha256: sha256Text(JSON.stringify(manifest)),
  };
  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const cipher = crypto.createCipheriv(ENCRYPT_ALGO, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(headerBuf);
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(headerBuf.length, 0);
  return { buffer: Buffer.concat([Buffer.from(PACKAGE_MAGIC, 'latin1'), lenBuf, headerBuf, iv, body]), header };
}

export function encryptSnapshot(config, { snapshotFile, manifestFile, now = new Date() } = {}) {
  const snap = snapshotFile ? path.resolve(snapshotFile) : latestSnapshot(config.backupDir, config.prefix);
  if (!snap || !fs.existsSync(snap)) throw new BackupError('找不到待加密快照：' + (snap || '未指定 --in 且备份目录里没有本工具的快照'));
  const mPath = manifestFile ? path.resolve(manifestFile) : snap.replace(/\.db$/, '.manifest.json');
  if (!fs.existsSync(mPath)) throw new BackupError('找不到快照清单：' + mPath);
  const manifest = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  const loaded = loadKeyFile(config.keyFile, { root: config.root });
  fs.mkdirSync(config.backupDir, { recursive: true });
  const out = path.join(config.backupDir, path.basename(snap) + '.enc');
  if (fs.existsSync(out)) throw new BackupError('密文包已存在，不覆盖：' + out);
  const built = buildPackageBuffer({
    snapshotFile: snap,
    key: loaded.key,
    fingerprint: loaded.fingerprint,
    manifest,
    createdAt: now.toISOString(),
  });
  fs.writeFileSync(out, built.buffer);
  const sidecar = manifestForPackage(out);
  fs.writeFileSync(sidecar, JSON.stringify(manifest, null, 2) + '\n');
  loaded.key.fill(0);
  return {
    packageFile: out,
    manifestFile: sidecar,
    header: built.header,
    keyFingerprint: loaded.fingerprint,
    keyDerived: loaded.derived,
    keyLocationNote: loaded.location.note,
    packageSha256: sha256File(out),
    packageBytes: fs.statSync(out).size,
  };
}

export function readPackageHeader(packageFile) {
  const buf = fs.readFileSync(packageFile);
  const magic = buf.subarray(0, 8).toString('latin1');
  if (magic !== PACKAGE_MAGIC) throw new BackupError('密文包魔数不符（不是本工具产出的备份）：' + packageFile);
  const headerLen = buf.readUInt32LE(8);
  const headerStart = 12;
  const headerEnd = headerStart + headerLen;
  if (headerEnd + IV_BYTES + TAG_BYTES > buf.length) throw new BackupError('密文包长度不完整：' + packageFile);
  const headerBuf = buf.subarray(headerStart, headerEnd);
  let header;
  try {
    header = JSON.parse(headerBuf.toString('utf8'));
  } catch {
    throw new BackupError('密文包头解析失败：' + packageFile);
  }
  if (header.algo !== ENCRYPT_ALGO) throw new BackupError('密文包算法不符：' + String(header.algo));
  const iv = buf.subarray(headerEnd, headerEnd + IV_BYTES);
  const body = buf.subarray(headerEnd + IV_BYTES);
  if (body.length < TAG_BYTES) throw new BackupError('密文包缺少认证标签：' + packageFile);
  return { header, headerBuf, iv, body };
}

// 解密到指定文件；GCM 标签不符（密文被改过一个字节也算）直接报错，不落任何部分明文。
export function decryptPackageToFile(packageFile, targetFile, config) {
  const { header, headerBuf, iv, body } = readPackageHeader(packageFile);
  const loaded = loadKeyFile(config.keyFile, { root: config.root });
  if (header.keyFingerprint !== loaded.fingerprint) {
    loaded.key.fill(0);
    throw new BackupError(
      `密钥指纹不符：密文包写的是 ${header.keyFingerprint}，当前密钥文件算出 ${loaded.fingerprint}（备份与密钥不是同一把）`,
    );
  }
  const tag = body.subarray(body.length - TAG_BYTES);
  const cipherBody = body.subarray(0, body.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv(ENCRYPT_ALGO, loaded.key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(headerBuf);
  decipher.setAuthTag(tag);
  let plain;
  try {
    plain = Buffer.concat([decipher.update(cipherBody), decipher.final()]);
  } catch (error) {
    loaded.key.fill(0);
    throw new BackupError(
      '解密失败（GCM 认证标签校验不过，密文被篡改或密钥不符）：'
      + path.basename(packageFile) + '：' + String(error && error.message || error),
    );
  }
  loaded.key.fill(0);
  const got = crypto.createHash('sha256').update(plain).digest('hex');
  if (header.plainSha256 && got !== header.plainSha256) {
    throw new BackupError('解密后明文 sha256 与包头记录不符：' + path.basename(packageFile));
  }
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, plain);
  return { plainBytes: plain.length, sha256: got, header };
}

// ── restore-check：解密 → integrity_check → 逐表行数对平 ──────────────────

export function readManifest(file) {
  if (!fs.existsSync(file)) throw new BackupError('找不到备份清单：' + file);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function restoreCheck(config, { packageFile, manifestFile, now = new Date() } = {}) {
  const pkg = packageFile ? path.resolve(packageFile) : latestPackage(config.backupDir, config.prefix);
  if (!pkg || !fs.existsSync(pkg)) throw new BackupError('找不到密文包：' + (pkg || '未指定 --package 且备份目录里没有加密包'));
  let mFile = manifestFile ? path.resolve(manifestFile) : manifestForPackage(pkg);
  if (!fs.existsSync(mFile)) {
    const legacy = pkg.replace(/\.enc$/, '.manifest.json');
    if (fs.existsSync(legacy)) mFile = legacy;
  }
  const manifest = readManifest(mFile);
  fs.mkdirSync(config.workDir, { recursive: true });
  const workFile = path.join(config.workDir, `restore-${localStamp(now)}-${path.basename(pkg, '.enc')}`);
  const reportPath = path.join(config.reportDir, `restore-check-${localStamp(now)}.json`);
  const report = {
    kind: 'wujinxia-restore-check',
    service: SERVICE,
    checkedAt: now.toISOString(),
    package: path.basename(pkg),
    packageSha256: sha256File(pkg),
    manifest: path.basename(mFile),
    snapshot: manifest.snapshot || null,
    integrity: null,
    tablesChecked: 0,
    diffs: [],
    ok: false,
    error: null,
    plainKept: false,
  };
  try {
    const out = decryptPackageToFile(pkg, workFile, config);
    report.decryptedSha256 = out.sha256;
    report.decryptedBytes = out.plainBytes;
    const db = openDb(workFile, { readOnly: true });
    let integrity;
    let counts;
    try {
      integrity = integrityResult(db);
      counts = tableCounts(db, listUserTables(db));
    } finally {
      db.close();
    }
    report.integrity = integrity;
    report.tablesChecked = counts.length;
    if (integrity !== 'ok') throw new BackupError(`恢复出的库 integrity_check 回「${integrity}」，备份不可用`);
    const diffs = compareCounts(counts, (manifest.tables || []).map((t) => ({ name: t.name, rows: Number(t.rows) })));
    if (diffs.length) {
      report.diffs = diffs;
      throw new BackupError(
        '恢复校验失败：逐表行数与快照清单不平，差异表 ' + diffs.length + ' 张：'
        + formatDiffs(diffs, '实际', '清单'),
      );
    }
    report.ok = true;
  } catch (error) {
    report.error = String(error && error.message || error);
    writeReport(reportPath, report);
    throw error;
  }
  if (config.keepRestoredPlaintext) {
    report.plainKept = true;
    report.plainFile = workFile;
  } else {
    try { fs.rmSync(workFile); } catch { /* 明文临时件删不掉也不影响校验结论 */ }
  }
  writeReport(reportPath, report);
  return { report, reportPath };
}

export function writeReport(reportPath, report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  return reportPath;
}

// ── transfer：scp 到另一台服务器（默认 dry-run）───────────────────────────

export function parseRemote(remote) {
  const text = String(remote || '').trim();
  if (!text) {
    throw new BackupError('缺少传输目标：请设置 WUJINXIA_BACKUP_REMOTE=aliyun-huantong:/var/backups/wujinxia-app-cloud/');
  }
  const match = /^([A-Za-z0-9._-]+):(\/[^\s]*)$/.exec(text);
  if (!match) throw new BackupError('传输目标应为 <ssh别名>:/绝对路径，现得到：' + text);
  const alias = match[1];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(alias)) {
    throw new BackupError('禁止在传输目标里写死 IP（' + alias + '）：请改用 ~/.ssh/config 的别名');
  }
  const dir = match[2].replace(/\/+$/, '') || '/';
  return { alias, dir, raw: `${alias}:${dir}`, label: alias };
}

// 统一的外部命令执行口：dry-run 只返回将执行的命令；真执行前先在 trace 文件落一行，
// 测试据此自证「没有 --apply 时一个 scp/ssh 子进程都没起」。
export function runCommand(options = {}) {
  const {
    argv, apply = false, traceFile = null, transportStub = null,
    label = '', env = process.env, timeoutMs = 240000, cwd = undefined,
  } = options;
  const list = argv.map((a) => String(a));
  const printed = list.join(' ');
  if (!apply) {
    return { dryRun: true, applied: false, argv: list, printed, stdout: '', stderr: '', status: null, label };
  }
  if (traceFile) {
    fs.mkdirSync(path.dirname(traceFile), { recursive: true });
    fs.appendFileSync(traceFile, JSON.stringify({ label, argv: list, at: new Date().toISOString() }) + '\n');
  }
  const [head, ...rest] = list;
  const result = transportStub
    ? spawnSync(process.execPath, [transportStub, JSON.stringify({ label, argv: list })], { encoding: 'utf8', timeout: timeoutMs, env, cwd })
    : spawnSync(head, rest, { encoding: 'utf8', timeout: timeoutMs, env, cwd });
  if (result.error) {
    return { dryRun: false, applied: true, argv: list, printed, stdout: result.stdout || '', stderr: result.stderr || '', status: null, label, error: result.error };
  }
  return {
    dryRun: false, applied: true, argv: list, printed, label,
    stdout: result.stdout || '', stderr: result.stderr || '', status: result.status,
  };
}

export function transferPackage(config, { packageFile, remote, now = new Date() } = {}) {
  const pkg = packageFile ? path.resolve(packageFile) : latestPackage(config.backupDir, config.prefix);
  if (!pkg || !fs.existsSync(pkg)) throw new BackupError('找不到待传输的密文包：' + (pkg || '未指定 --package 且备份目录里没有加密包'));
  const target = parseRemote(remote || config.remote);
  const apply = Boolean(config.apply);
  const files = [pkg];
  const sidecar = manifestForPackage(pkg);
  if (fs.existsSync(sidecar)) files.push(sidecar);
  const planned = [];
  const runner = (argv, label) => {
    const res = runCommand({ argv, apply, traceFile: config.traceFile, transportStub: config.transportStub, label });
    planned.push({ label, argv: res.argv, dryRun: res.dryRun });
    return res;
  };
  const mkDir = runner(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', target.alias,
    `install -d -m 0750 ${JSON.stringify(target.dir)}`], '确保远端备份目录存在');
  if (!apply) planned.push({ label: 'dry-run-note', argv: ['(dry-run: 不建远端目录、不连网)'], dryRun: true });
  // `-O` 走 legacy SCP 协议：接收端的授权密钥被限定成只能执行 `scp -t <备份目录>`，
  // 不给它 sftp 子系统，免得这把密钥变成整台机器的读盘通道。
  const uploads = files.map((file) => runner(['scp', '-O', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20',
    file, `${target.alias}:${target.dir}/${path.basename(file)}`], '上传 ' + path.basename(file)));
  const verify = runner(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', target.alias,
    `sha256sum ${JSON.stringify(path.posix.join(target.dir, path.basename(pkg)))}`], '远端 sha256 复核');

  if (!apply) {
    return {
      dryRun: true, applied: false, remote: target.raw, alias: target.alias, remoteDir: target.dir,
      files: files.map((f) => path.basename(f)), commands: planned, createdAt: now.toISOString(),
      localPackageSha256: sha256File(pkg),
    };
  }
  const failed = [mkDir, ...uploads, verify].find((r) => r.status !== 0);
  if (failed) {
    throw new BackupError('传输失败：命令「' + failed.printed.slice(0, 200) + '」退出码 '
      + String(failed.status ?? (failed.error ? failed.error.message : '未知')) + '；'
      + redact(String(failed.stderr || failed.stdout || '')));
  }
  const localSha = sha256File(pkg);
  const remoteLine = verify.stdout.trim();
  if (!remoteLine.startsWith(localSha)) {
    throw new BackupError('远端 sha256 与本机不一致，备份未确认落盘：远端「' + remoteLine.slice(0, 120) + '」');
  }
  return {
    dryRun: false, applied: true, remote: target.raw, alias: target.alias, remoteDir: target.dir,
    files: files.map((f) => path.basename(f)), commands: planned, createdAt: now.toISOString(),
    localPackageSha256: localSha, remoteVerified: true,
  };
}

// 任何外部命令的输出在回显前都过一道密钥脱敏，保证密钥值不可能出现在日志或错误信息里。
export function redact(text, secrets = []) {
  let out = String(text || '');
  const values = [...REDACTION_POOL, ...secrets];
  for (const secret of values) {
    const value = Buffer.isBuffer(secret) ? secret.toString('utf8') : String(secret || '');
    if (!value) continue;
    for (const form of [value, value.trim(), Buffer.from(value).toString('hex'), Buffer.from(value.trim()).toString('hex')]) {
      if (form) out = out.split(form).join('[已脱敏]');
    }
  }
  return out;
}

// ── record：写 backups 表 ────────────────────────────────────────────────

export function ensureBackupTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${BACKUP_TABLE}(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    ok INTEGER NOT NULL,
    size_bytes INTEGER,
    sha256 TEXT,
    remote TEXT,
    detail TEXT
  )`);
}

export const BACKUP_DETAIL_FORBIDDEN = [
  { pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, label: 'IP 字面量' },
  { pattern: /keyFingerprintHexFull/i, label: '完整密钥指纹' },
];

export function buildBackupDetail({ manifest, encryptInfo, restoreReport, transferInfo }) {
  const summary = (manifest.tables || [])
    .map((t) => `${t.name}=${Number(t.rows)}`)
    .join(',');
  const detail = {
    algo: ENCRYPT_ALGO,
    keyFingerprint: encryptInfo ? encryptInfo.keyFingerprint : null,
    snapshotMethod: manifest.method || 'VACUUM INTO',
    integrity: restoreReport && restoreReport.integrity ? restoreReport.integrity : (manifest.integrity || null),
    tableSummary: summary,
    tableCount: (manifest.tables || []).length,
    snapshot: manifest.snapshot || null,
    package: encryptInfo ? path.basename(encryptInfo.packageFile) : null,
    remote: transferInfo ? transferInfo.remote : null,
    restoreOk: restoreReport ? Boolean(restoreReport.ok) : false,
    dryRun: transferInfo ? Boolean(transferInfo.dryRun) : true,
    // 保留清理只认这条明确标记：手工 record 或旧记录没有它，就不能被当成远端已有成功包。
    applied: transferInfo ? transferInfo.applied === true : false,
  };
  const text = JSON.stringify(detail);
  for (const rule of BACKUP_DETAIL_FORBIDDEN) {
    if (rule.pattern.test(text)) throw new BackupError('backups.detail 含不应出现的敏感值（' + rule.label + '），已拒绝记账');
  }
  return detail;
}

export function recordBackup(config, { detail, ok, sizeBytes, sha256, remote, at = new Date().toISOString() } = {}) {
  const dbFile = config.dbFile;
  if (!fs.existsSync(dbFile)) throw new BackupError('找不到要记账的数据库文件：' + dbFile);
  const detailText = typeof detail === 'string' ? detail : JSON.stringify(detail || {});
  for (const rule of BACKUP_DETAIL_FORBIDDEN) {
    if (rule.pattern.test(detailText)) throw new BackupError('backups.detail 含不应出现的敏感值（' + rule.label + '），已拒绝记账');
  }
  let db;
  try {
    db = openDb(dbFile);
  } catch (error) {
    throw new BackupError('记账打开数据库失败：' + String(error && error.message || error));
  }
  try {
    ensureBackupTable(db);
    db.exec('BEGIN IMMEDIATE');
    try {
      const sha = String(sha256 || '');
      const remoteText = String(remote || '');
      const existing = sha
        ? db.prepare(`SELECT id FROM ${BACKUP_TABLE} WHERE sha256=? AND remote=? ORDER BY id DESC LIMIT 1`)
          .get(sha, remoteText)
        : null;
      let mode;
      let rowId;
      if (existing) {
        db.prepare(`UPDATE ${BACKUP_TABLE} SET at=?, ok=?, size_bytes=?, detail=? WHERE id=?`)
          .run(at, ok ? 1 : 0, Number(sizeBytes) || 0, detailText, existing.id);
        mode = 'updated';
        rowId = Number(existing.id);
      } else {
        const info = db.prepare(`INSERT INTO ${BACKUP_TABLE}(at, ok, size_bytes, sha256, remote, detail) VALUES(?,?,?,?,?,?)`)
          .run(at, ok ? 1 : 0, Number(sizeBytes) || 0, sha, remoteText, detailText);
        mode = 'inserted';
        rowId = Number(info.lastInsertRowid);
      }
      db.exec('COMMIT');
      const row = db.prepare(`SELECT id, at, ok, size_bytes, sha256, remote, detail FROM ${BACKUP_TABLE} WHERE id=?`).get(rowId);
      if (!row) throw new BackupError('记账回读失败：id=' + rowId + ' 的行不在库里');
      return { mode, id: rowId, row, dbFile };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* 回滚失败时保留原始错误 */ }
      throw error;
    }
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError('写入 ' + BACKUP_TABLE + ' 失败：' + String(error && error.message || error));
  } finally {
    db.close();
  }
}

// ── run：串起全流程 ─────────────────────────────────────────────────────

export function runFull(config, { now = new Date(), log = () => {} } = {}) {
  const steps = {};
  steps.snapshot = createSnapshot(config, { now });
  log('snapshot ' + path.basename(steps.snapshot.snapshot));
  steps.encrypt = encryptSnapshot(config, {
    snapshotFile: steps.snapshot.snapshot,
    manifestFile: steps.snapshot.manifestPath,
    now,
  });
  log('encrypt ' + path.basename(steps.encrypt.packageFile) + '（密钥指纹 ' + steps.encrypt.keyFingerprint + '）');
  let transferInfo = null;
  let restoreReport = null;
  let failure = null;
  try {
    transferInfo = transferPackage(config, { packageFile: steps.encrypt.packageFile, now });
    log(transferInfo.dryRun ? 'transfer dry-run（未连网）' : 'transfer 已上传并远端复核');
    restoreReport = restoreCheck(config, { packageFile: steps.encrypt.packageFile, manifestFile: steps.encrypt.manifestFile, now }).report;
    log('restore-check ' + (restoreReport.ok ? 'ok' : '失败'));
  } catch (error) {
    failure = error;
  }
  steps.transfer = transferInfo;
  steps.restore = restoreReport;
  const detail = buildBackupDetail({
    manifest: steps.snapshot.manifest,
    encryptInfo: steps.encrypt,
    restoreReport,
    transferInfo,
  });
  steps.record = recordBackup(config, {
    detail,
    ok: !failure && Boolean(restoreReport && restoreReport.ok),
    sizeBytes: steps.encrypt.packageBytes,
    sha256: steps.encrypt.packageSha256,
    remote: transferInfo ? transferInfo.remote : String(config.remote || ''),
    at: now.toISOString(),
  });
  log('record ' + steps.record.mode + ' #' + steps.record.id);
  // 保留清理只在「本次备份确实落到远端且恢复校验通过」之后执行，新包没成功就一个旧包都不删。
  if (!failure && restoreReport && restoreReport.ok && transferInfo && !transferInfo.dryRun) {
    try {
      const retention = remoteRetention(config, { now });
      steps.retention = retention;
      log('retention 保留 ' + retention.plan.keep.length + ' 份，清理 ' + retention.plan.remove.length + ' 份');
    } catch (error) {
      log('retention 没有完成（本次备份本身已成功）：' + String(error && error.message || error).slice(0, 120));
    }
  }
  if (failure) throw failure;
  return steps;
}

// ── 远端保留清理（P10 的实现缺口）────────────────────────────────────────
// 保留集合＝最近 30 天里每天最后一份校验成功包 ∪ 最近 7 份校验成功包；
// 只有本机 `backups` 账里能拿出完整成功证明的包才可能被删，认不出或证明不足的一律不动。
export const RETENTION_KEEP_DAYS = 30;
export const RETENTION_KEEP_COUNT = 7;
export const RETENTION_TABLE = 'backup_retention';
const PACKAGE_NAME_PATTERN = /^wujinxia-app-cloud-(\d{8})-(\d{6})\.db\.enc$/;
const MANIFEST_SUFFIX = '.manifest.json';

function dayKey(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// 一份远端包算「校验成功」需要同时拿出四样事实：明确真实执行过上传（不是 dry-run，
// 也不是手工补的账）、恢复校验通过、包摘要齐全、且记录的目标就是本次要清理的那个远端。
// 缺任何一项都不进可删集合（宁可多留），历史缺证明的包只被保护、不自动升级资格。
export function successProof(record, { remote = '' } = {}) {
  let detail = {};
  try { detail = JSON.parse(String(record.detail || '{}')); } catch { detail = {}; }
  const pkg = String(detail.package || '');
  const reject = why => ({ ok: false, pkg, why });
  if (Number(record.ok) !== 1) return reject('本机备份账里这条不是成功记录');
  if (!pkg || !PACKAGE_NAME_PATTERN.test(pkg)) return reject('备份账里没有本项目密文包名');
  if (detail.applied !== true) return reject('缺少“已真实执行上传”的明确标记，手工登记或旧记录不能自动取得删除资格');
  if (detail.dryRun !== false) return reject('没有明确的非 dry-run 标记');
  if (detail.restoreOk !== true) return reject('缺少恢复校验通过的事实');
  if (!/^[a-f0-9]{64}$/.test(String(record.sha256 || ''))) return reject('缺少远端包摘要');
  if (remote && String(detail.remote || '') !== String(remote)) return reject('这条记录属于另一个远端目标，不能作为本目标的删除依据');
  return { ok: true, pkg, bytes: Number.isFinite(Number(record.size_bytes)) ? Number(record.size_bytes) : 0 };
}

export function planRetention({ names = [], records = [], now = new Date(), keepDays = RETENTION_KEEP_DAYS, keepCount = RETENTION_KEEP_COUNT, remote = '' } = {}) {
  const packages = [];
  const unrecognized = [];
  for (const name of names.map((item) => String(item || '').trim()).filter(Boolean)) {
    if (name.endsWith(MANIFEST_SUFFIX)) continue;
    const match = PACKAGE_NAME_PATTERN.exec(name);
    if (!match) { unrecognized.push({ name, reason: '命名不属于本项目密文包，保留不动' }); continue; }
    const at = `${match[1].slice(0, 4)}-${match[1].slice(4, 6)}-${match[1].slice(6, 8)}T${match[2].slice(0, 2)}:${match[2].slice(2, 4)}:${match[2].slice(4, 6)}`;
    packages.push({ name, at, day: at.slice(0, 10), timeMs: Date.parse(at) });
  }
  const succeeded = new Set();
  const sizes = new Map();
  const unproven = [];
  for (const record of records) {
    const proof = successProof(record, { remote });
    if (!proof.ok) { if (proof.pkg) unproven.push({ name: proof.pkg, why: proof.why }); continue; }
    succeeded.add(proof.pkg);
    if (proof.bytes) sizes.set(proof.pkg, proof.bytes);
  }
  const ordered = packages
    .filter((item) => Number.isSafeInteger(item.timeMs))
    .sort((a, b) => (b.timeMs - a.timeMs) || (a.name < b.name ? -1 : 1));
  const successful = ordered.filter((item) => succeeded.has(item.name));
  const unrecorded = ordered.filter((item) => !succeeded.has(item.name))
    .map((item) => ({ name: item.name, reason: '本机备份账里拿不出完整成功证明（缺记录、缺恢复校验或只是 dry-run），保留不动' }));
  const reasons = new Map();
  for (const item of successful.slice(0, keepCount)) reasons.set(item.name, `最近 ${keepCount} 份成功包`);
  for (let offset = 0; offset < keepDays; offset += 1) {
    const day = dayKey(now.getTime() - offset * 86_400_000);
    const last = successful.find((item) => item.day === day);
    if (last && !reasons.has(last.name)) reasons.set(last.name, `最近 ${keepDays} 天内 ${day} 的最后一份成功包`);
  }
  const keep = successful.filter((item) => reasons.has(item.name))
    .map((item) => ({ name: item.name, at: item.at, bytes: sizes.get(item.name) || 0, reason: reasons.get(item.name) }));
  const removable = successful.filter((item) => !reasons.has(item.name));
  const note = successful.length <= keepCount ? `成功包共 ${successful.length} 份，未满或刚到 ${keepCount} 份下限，一份都不删` : '';
  const remove = removable.map((item) => ({ name: item.name, at: item.at, bytes: sizes.get(item.name) || 0, reason: '既不在最近 7 份、也不是最近 30 天每日末份' }));
  for (const item of [...remove]) {
    const sidecar = item.name + MANIFEST_SUFFIX;
    if (names.includes(sidecar)) remove.push({ name: sidecar, at: item.at, bytes: 0, reason: '随对应密文包一起清理' });
  }
  return {
    listed: names.length,
    successCount: successful.length,
    keep,
    remove,
    unrecorded,
    unrecognized,
    unproven,
    keepDays,
    keepCount,
    note,
  };
}

export function ensureRetentionTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${RETENTION_TABLE}(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    ok INTEGER NOT NULL,
    kept INTEGER NOT NULL,
    removed INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    reason TEXT NOT NULL,
    detail TEXT
  )`);
}

export function readBackupRecords(config) {
  if (!config.dbFile || !fs.existsSync(config.dbFile)) return [];
  let db;
  try { db = openDb(config.dbFile, { readOnly: true }); } catch { return []; }
  try {
    ensureBackupTable(db);
    // 按远端候选查完整证明，不能只取最近 2,000 条：更老的包一旦掉出这 2,000 条
    // 就永远拿不出证明，会被永久保护，保留规则收敛不了。
    return db.prepare('SELECT at,ok,size_bytes,sha256,detail FROM backups WHERE ok=1 ORDER BY id').all();
  } finally { db.close(); }
}

export function recordRetention(config, { at, ok, plan, removedBytes, detail, actual = null }) {
  if (!config.dbFile || !fs.existsSync(config.dbFile)) throw new BackupError('找不到写保留审计的数据库文件：' + config.dbFile);
  const text = JSON.stringify(detail || {});
  for (const rule of BACKUP_DETAIL_FORBIDDEN) {
    if (rule.pattern.test(text)) throw new BackupError('保留审计含不应出现的值（' + rule.label + '），已拒绝记账');
  }
  // 计划数与实际数分开记：账上的 kept/removed/bytes 取逐文件的实际结果，计划清单只留在正文里。
  const kept = actual && Number.isSafeInteger(Number(actual.kept)) ? Number(actual.kept) : Number(plan.keep?.length || 0);
  const removed = actual && Number.isSafeInteger(Number(actual.removed)) ? Number(actual.removed) : Number(plan.remove?.length || 0);
  const plannedRemoved = Number(plan.remove?.length || 0);
  const db = openDb(config.dbFile);
  try {
    ensureRetentionTable(db);
    db.exec('BEGIN IMMEDIATE');
    try {
      const info = db.prepare(`INSERT INTO ${RETENTION_TABLE}(at,ok,kept,removed,bytes,reason,detail) VALUES(?,?,?,?,?,?,?)`)
        .run(String(at), ok ? 1 : 0, kept, removed,
          Number(removedBytes || 0), String(plan.note || `按最近 ${plan.keepDays || RETENTION_KEEP_DAYS} 天每日末份与最近 ${plan.keepCount || RETENTION_KEEP_COUNT} 份成功包并集保留（计划清理 ${plannedRemoved} 项）`), text);
      db.exec('COMMIT');
      return { id: Number(info.lastInsertRowid), dbFile: config.dbFile };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

// 预览也做真实只读列举：候选恒为空的预览不能称为真实预览。`list` 在接收端是只读命令，
// 不写不删；清理与下载类动作仍然只在 --apply 时才发生。
function readRemoteNames(sshBase, config, commands, label) {
  const listing = runCommand({ argv: [...sshBase, 'list'], apply: true, traceFile: config.traceFile, transportStub: config.transportStub, label });
  commands.push(listing);
  if (listing.error || listing.status !== 0) {
    throw new BackupError('远端备份清单读取失败：' + redact(String(listing.stderr || listing.error?.message || ('退出码 ' + String(listing.status)))).slice(0, 200));
  }
  return String(listing.stdout || '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

export function remoteRetention(config, { now = new Date(), keepDays = RETENTION_KEEP_DAYS, keepCount = RETENTION_KEEP_COUNT } = {}) {
  const target = parseRemote(config.remote);
  const apply = Boolean(config.apply);
  const sshBase = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', target.alias];
  const commands = [];
  const names = readRemoteNames(sshBase, config, commands, '只读列出远端备份收件目录');
  const plan = planRetention({ names, records: readBackupRecords(config), now, keepDays, keepCount, remote: target.raw });
  const plannedBytes = plan.remove.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
  if (!apply) {
    return { dryRun: true, applied: false, remote: target.raw, remoteDir: target.dir, names, plan, removedBytes: 0, plannedBytes, commands, at: now.toISOString() };
  }
  if (!plan.remove.length) {
    const audit = recordRetention(config, {
      at: now.toISOString(), ok: true, plan, removedBytes: 0,
      actual: { kept: plan.keep.length, removed: 0 },
      detail: { status: 'result', remote: target.raw, listed: names.length, keep: plan.keep.map((i) => i.name), planned: [], results: [], note: plan.note || '本轮没有可删候选' },
    });
    return { dryRun: false, applied: true, ok: true, remote: target.raw, remoteDir: target.dir, names, plan, removedBytes: 0, plannedBytes, commands, audit, at: now.toISOString() };
  }
  const planned = plan.remove.map((item) => item.name);
  // 先登记删除意图（含计划清单），再动手；部分失败、超时都有一条前因可核对。
  const intent = recordRetention(config, {
    at: now.toISOString(), ok: false, plan, removedBytes: 0,
    actual: { kept: plan.keep.length, removed: 0 },
    detail: { status: 'intent', remote: target.raw, planned, plannedBytes, listed: names.length },
  });
  const argv = [...sshBase, 'purge ' + planned.map((item) => JSON.stringify(item)).join(' ')];
  const purge = runCommand({ argv, apply: true, traceFile: config.traceFile, transportStub: config.transportStub, label: '按保留清单清理远端备份' });
  commands.push(purge);
  const stdout = String(purge.stdout || '');
  let results;
  let failure = '';
  if (purge.error || purge.status !== 0) {
    // 执行结果不明时不能按计划记账：重新只读列举一次，按远端真实现场逐文件定性。
    failure = redact(String(purge.stderr || purge.error?.message || ('退出码 ' + String(purge.status)))).slice(0, 200);
    let rechecked = null;
    try { rechecked = readRemoteNames(sshBase, config, commands, '清理后复核远端清单'); } catch { rechecked = null; }
    results = planned.map((name) => ({
      name,
      result: rechecked === null ? 'unknown' : (rechecked.includes(name) ? 'retained' : 'removed'),
    }));
  } else {
    // 只认整行 `purged <文件名>`：子串匹配会把清单文件的删除算到密文包头上。
    const purged = new Set(stdout.split(/\r?\n/u).map(line => line.trim()).filter(line => /^purged \S+$/u.test(line)).map(line => line.slice('purged '.length)));
    results = planned.map((name) => ({ name, result: purged.has(name) ? 'removed' : 'failed' }));
    if (!/remaining_packages [1-9]\d*/u.test(stdout)) failure = '远端没有回信剩余包数，按未完成处理';
  }
  const removedNames = results.filter((item) => item.result === 'removed').map((item) => item.name);
  const removedBytes = plan.remove.filter((item) => removedNames.includes(item.name)).reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
  const ok = results.length > 0 && results.every((item) => item.result === 'removed') && !failure;
  const audit = recordRetention(config, {
    at: now.toISOString(), ok, plan, removedBytes,
    actual: { kept: plan.keep.length, removed: removedNames.length },
    detail: {
      status: 'result', intentId: intent.id, remote: target.raw, listed: names.length,
      keep: plan.keep.map((i) => i.name), planned, results,
      removed: removedNames, retained: results.filter((i) => i.result === 'retained').map((i) => i.name),
      undetermined: results.filter((i) => i.result === 'unknown' || i.result === 'failed').map((i) => i.name),
      unrecorded: plan.unrecorded.map((i) => i.name), unrecognized: plan.unrecognized.map((i) => i.name),
      unproven: plan.unproven.map((i) => i.name), note: plan.note || '', failure,
    },
  });
  if (!ok) throw new BackupError('远端保留清理没有全部完成，已按逐文件实际结果记审计：' + (failure || results.filter((i) => i.result !== 'removed').map((i) => i.name + '=' + i.result).join(',')));
  return { dryRun: false, applied: true, ok, remote: target.raw, remoteDir: target.dir, names, plan, removedBytes, plannedBytes, commands, audit, results, at: now.toISOString() };
}

// ── CLI ─────────────────────────────────────────────────────────────────

export const HELP_TEXT = [
  '用法：node tools/wujinxia-backup.mjs <命令> [选项]',
  '',
  '命令：snapshot | encrypt | transfer | restore-check | record | run | retention',
  '选项：--db --out --name --in --manifest --package --remote --key-file --work --report-dir --apply --keep-plain',
  '',
  '环境变量：WUJINXIA_DATA_DIR、WUJINXIA_DB_FILE（默认 <data>/wujinxia-cloud.db）、',
  '  WUJINXIA_BACKUP_DIR、WUJINXIA_BACKUP_KEY_FILE（密钥只从这里读）、',
  '  WUJINXIA_BACKUP_REMOTE=<ssh别名>:/绝对路径（不写死 IP）。',
  '  transfer 与 run 默认 dry-run，必须显式加 --apply 才会起 scp/ssh。',
].join('\n');

export function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const out = deps.log || ((text) => console.log(text));
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    out('[备份] 失败：' + error.message);
    return 2;
  }
  if (parsed.help || !parsed.command) {
    out(HELP_TEXT);
    return parsed.command ? 0 : (parsed.help ? 0 : 2);
  }
  const config = resolveConfig({ ...parsed.flags, apply: parsed.apply }, env);
  if (parsed.flags['keep-plain']) config.keepRestoredPlaintext = true;
  const now = deps.now ? deps.now() : new Date();
  try {
    let result;
    if (parsed.command === 'snapshot') {
      const r = createSnapshot(config, { now });
      out(`[备份] 一致性快照（${r.manifest.method}）：${r.snapshot}`);
      out(`[备份] integrity ${r.manifest.integrity}｜表 ${r.manifest.tableCount} 张｜${r.manifest.snapshotBytes} 字节｜sha256 ${r.manifest.sha256.slice(0, 16)}…`);
      result = { snapshot: r.snapshot, manifest: r.manifestPath, manifestSummary: r.manifest.tables };
    } else if (parsed.command === 'encrypt') {
      const r = encryptSnapshot(config, { snapshotFile: parsed.flags.in ? String(parsed.flags.in) : null, manifestFile: typeof parsed.flags.manifest === 'string' ? parsed.flags.manifest : null, now });
      out(`[备份] 加密包：${r.packageFile}`);
      out(`[备份] ${r.header.algo}｜密钥指纹 ${r.keyFingerprint}｜${r.keyLocationNote}｜密钥值不输出`);
      result = { package: r.packageFile, manifest: r.manifestFile, keyFingerprint: r.keyFingerprint, packageSha256: r.packageSha256 };
    } else if (parsed.command === 'transfer') {
      const r = transferPackage(config, {
        packageFile: parsed.flags.package ? String(parsed.flags.package) : null,
        remote: typeof parsed.flags.remote === 'string' ? parsed.flags.remote : undefined,
        now,
      });
      for (const item of r.commands) out(`[备份] ${item.dryRun ? 'dry-run' : 'exec'} ${item.argv.join(' ')}`);
      out(`[备份] 目标 ${r.remote}｜${r.dryRun ? 'dry-run：没有起 scp/ssh，不建远端目录' : '已执行'}`);
      result = r;
    } else if (parsed.command === 'restore-check') {
      const r = restoreCheck(config, {
        packageFile: parsed.flags.package ? String(parsed.flags.package) : null,
        manifestFile: typeof parsed.flags.manifest === 'string' ? parsed.flags.manifest : null,
        now,
      });
      out(`[备份] 恢复校验通过：integrity ${r.report.integrity}｜表 ${r.report.tablesChecked} 张逐表对平`);
      out('[备份] 报告：' + r.reportPath);
      result = { report: r.reportPath, ok: r.report.ok };
    } else if (parsed.command === 'record') {
      const pkg = parsed.flags.package ? String(parsed.flags.package) : latestPackage(config.backupDir, config.prefix);
      const manifestFile = parsed.flags.manifest ? String(parsed.flags.manifest) : (pkg ? manifestForPackage(pkg) : null);
      const manifest = manifestFile && fs.existsSync(manifestFile) ? readManifest(manifestFile) : { tables: [] };
      const fingerprint = parsed.flags.fingerprint
        ? String(parsed.flags.fingerprint)
        : (pkg && fs.existsSync(pkg) ? readPackageHeader(pkg).header.keyFingerprint : '');
      const detail = buildBackupDetail({
        manifest,
        encryptInfo: pkg && fs.existsSync(pkg) ? { keyFingerprint: fingerprint, packageFile: pkg } : null,
        restoreReport: parsed.flags.report && fs.existsSync(String(parsed.flags.report)) ? JSON.parse(fs.readFileSync(String(parsed.flags.report), 'utf8')) : null,
        transferInfo: parsed.flags.remote || config.remote ? { remote: String(parsed.flags.remote || config.remote), dryRun: !parsed.apply } : null,
      });
      const r = recordBackup(config, {
        detail,
        ok: String(parsed.flags.ok ?? 'true') !== 'false',
        sizeBytes: pkg && fs.existsSync(pkg) ? fs.statSync(pkg).size : Number(parsed.flags.size || 0),
        sha256: pkg && fs.existsSync(pkg) ? sha256File(pkg) : String(parsed.flags.sha256 || ''),
        remote: String(parsed.flags.remote || config.remote || ''),
        at: now.toISOString(),
      });
      out(`[备份] 记账 ${r.mode}：backups#${r.id} at=${r.row.at} ok=${r.row.ok} ${r.row.size_bytes}B`);
      result = { mode: r.mode, id: r.id, db: r.dbFile };
    } else if (parsed.command === 'retention') {
      const r = remoteRetention(config, { now });
      out(`[备份] 远端 ${r.remote} 现读 ${r.names.length} 项，其中校验成功包 ${r.plan.successCount} 份`);
      out(`[备份] 保留 ${r.plan.keep.length} 份（最近 ${r.plan.keepCount} 份与最近 ${r.plan.keepDays} 天每日末份的并集）｜候选删除 ${r.plan.remove.length} 份｜无成功记录不删 ${r.plan.unrecorded.length} 份｜命名不认保留 ${r.plan.unrecognized.length} 份`);
      for (const item of r.plan.keep) out(`[备份] 保留 ${item.name}：${item.reason}`);
      for (const item of r.plan.remove) out(`[备份] 候选删除 ${item.name}：${item.reason}`);
      if (r.plan.note) out('[备份] ' + r.plan.note);
      out(`[备份] ${r.dryRun ? 'dry-run：没有起 ssh，一个文件都不动' : '已按清单清理，审计 backup_retention#' + r.audit.id}`);
      result = { remote: r.remote, listed: r.plan.successCount, keep: r.plan.keep.map((i) => i.name), remove: r.plan.remove.map((i) => i.name), dryRun: r.dryRun, audit: r.audit ? r.audit.id : null };
    } else if (parsed.command === 'run') {
      const steps = runFull(config, { now, log: (t) => out('[备份] ' + t) });
      out(`[备份] 全流程完成：${path.basename(steps.encrypt.packageFile)}，记账 backups#${steps.record.id}（ok=${steps.record.row.ok}）`);
      result = {
        snapshot: steps.snapshot.snapshot,
        package: steps.encrypt.packageFile,
        remote: steps.transfer ? steps.transfer.remote : null,
        transferDryRun: steps.transfer ? steps.transfer.dryRun : null,
        restoreOk: steps.restore ? steps.restore.ok : false,
        recordId: steps.record.id,
      };
    } else {
      out(HELP_TEXT);
      out('[备份] 失败：未知命令 ' + parsed.command);
      return 2;
    }
    out('RESULT_JSON=' + JSON.stringify(result));
    return 0;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    out('[备份] 失败：' + redact(message));
    out('RESULT_JSON=' + JSON.stringify({ ok: false, error: redact(message) }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
