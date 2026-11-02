// 本项目部署与备份工具的真实测试：真 SQLite、真文件、真子进程、真加密。
// 全程只读写 .runtime/ 下的临时目录，绝不发起任何网络或服务器连接（外部命令一律走测试替身）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const REPO = path.resolve(import.meta.dirname, '..');
const BACKUP_TOOL = path.join(REPO, 'tools', 'wujinxia-backup.mjs');
const DEPLOY_TOOL = path.join(REPO, 'tools', 'wujinxia-deploy.mjs');
const backup = await import(pathToFileURL(BACKUP_TOOL).href);
const deploy = await import(pathToFileURL(DEPLOY_TOOL).href);

const SCHEMA = [
  'CREATE TABLE software_users(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)',
  'CREATE TABLE admin_users(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL)',
  'CREATE TABLE sessions(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, kind TEXT, created_at TEXT)',
  'CREATE TABLE run_logs(id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, level TEXT, message TEXT)',
  'CREATE TABLE log_conflicts(id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, reason TEXT)',
  'CREATE TABLE admin_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, admin_username TEXT, action TEXT, at TEXT)',
  'CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE backups(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, ok INTEGER NOT NULL, size_bytes INTEGER, sha256 TEXT, remote TEXT, detail TEXT)',
].join('; ');

const KEY_TEXT = '本轮测试专用密钥口令-不允许出现在任何输出里-42';
const ROWS = 24;

function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('WUJINXIA_') || key.startsWith('GARDEN_')) delete env[key];
  }
  return { ...env, ...overrides };
}

function runTool(tool, args, env = {}) {
  const res = spawnSync(process.execPath, [tool, ...args], {
    cwd: REPO, encoding: 'utf8', env: cleanEnv(env), timeout: 120000,
  });
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  return { status: res.status, stdout, stderr, output: stdout + stderr, result: parseResult(stdout) };
}

function parseResult(stdout) {
  const line = String(stdout).split(/\r?\n/).find((entry) => entry.startsWith('RESULT_JSON='));
  if (!line) return null;
  return JSON.parse(line.slice('RESULT_JSON='.length));
}

function scratch(t, name) {
  const root = path.join(REPO, '.runtime');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'deploy-backup-test-' + name + '-'));
  t.after(() => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        try { fs.readdirSync(dir); } catch { return; }
      }
    }
    // 临时件留在 .runtime/（已被版本控制忽略），不影响结论，只影响磁盘整洁。
  });
  return dir;
}

function backupSchemaWithoutBackups() {
  return SCHEMA.split('; CREATE TABLE backups')[0];
}

// 真 SQLite 活库（WAL），默认保持写入连接打开，模拟服务正在写的状态。
function makeLiveDb(dir, { rows = ROWS, createBackupsTable = true, keepWriterOpen = true } = {}) {
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, 'wujinxia-cloud.db');
  const writer = new DatabaseSync(dbFile);
  writer.exec('PRAGMA journal_mode=WAL');
  writer.exec(createBackupsTable ? SCHEMA : backupSchemaWithoutBackups());
  writer.prepare('INSERT INTO software_users(username,created_at) VALUES(?,?)').run('本机测试账号', new Date().toISOString());
  writer.prepare('INSERT INTO admin_users(username) VALUES(?)').run('admin-local');
  writer.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('allowRegistration', 'false');
  const insert = writer.prepare('INSERT INTO run_logs(event_id,level,message) VALUES(?,?,?)');
  for (let i = 0; i < rows; i += 1) insert.run('evt-' + i, 'info', '真实提交行 ' + i);
  if (!keepWriterOpen) writer.close();
  return { dbFile, dataDir, writer };
}

function writeKey(dir, text = KEY_TEXT) {
  const keyFile = path.join(dir, 'keys', 'backup.key');
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, text);
  return keyFile;
}

function backupEnv(dir, extra = {}) {
  return {
    WUJINXIA_DATA_DIR: path.join(dir, 'data'),
    WUJINXIA_DB_FILE: path.join(dir, 'data', 'wujinxia-cloud.db'),
    WUJINXIA_BACKUP_DIR: path.join(dir, 'backups'),
    WUJINXIA_BACKUP_KEY_FILE: path.join(dir, 'keys', 'backup.key'),
    WUJINXIA_BACKUP_REMOTE: 'aliyun-huantong:/var/backups/wujinxia-app-cloud',
    WUJINXIA_REPORT_DIR: path.join(dir, 'reports'),
    WUJINXIA_RESTORE_WORK_DIR: path.join(dir, 'work'),
    ...extra,
  };
}

function tableCountsOf(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    const out = {};
    for (const name of names) out[name] = Number(db.prepare('SELECT COUNT(*) AS c FROM "' + name + '"').get().c);
    return out;
  } finally {
    db.close();
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readAllTexts(dir, exclude = []) {
  const out = [];
  const skip = new Set(exclude.map((p) => path.resolve(p)));
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!skip.has(path.resolve(full))) out.push(fs.readFileSync(full).toString('latin1'));
    }
  };
  walk(dir);
  return out;
}

// 外部命令替身：一旦被真的执行就在 marker 里留一行，然后必定失败（不连任何服务器）。
function writeTransportStub(dir, name = 'transport') {
  const stub = path.join(dir, name + '-stub.mjs');
  const marker = path.join(dir, name + '-stub.marker');
  fs.writeFileSync(stub, [
    "import fs from 'node:fs';",
    "const marker = process.env.WUJINXIA_TEST_STUB_MARKER;",
    "if (marker) fs.appendFileSync(marker, String(process.argv[2]) + '\\n');",
    "console.error('ssh: Could not resolve hostname wujinxia-no-such-alias: Name or service not known');",
    'process.exit(255);',
    '',
  ].join('\n'));
  return { stub, marker };
}

function deployFixture(t, name, { withDist = true, seed = {} } = {}) {
  const dir = scratch(t, name);
  const src = path.join(dir, 'srcroot');
  fs.mkdirSync(path.join(src, 'cloud'), { recursive: true });
  fs.writeFileSync(path.join(src, 'cloud', 'server.mjs'), 'export const service = "wujinxia-app-cloud";\n');
  fs.writeFileSync(path.join(src, 'cloud', 'db.mjs'), 'export const dbname = "wujinxia-cloud.db";\n');
  fs.mkdirSync(path.join(src, 'cloud', 'routes'), { recursive: true });
  fs.writeFileSync(path.join(src, 'cloud', 'routes', 'health.mjs'), 'export const healthPath = "/api/software/health";\n');
  if (withDist) {
    fs.mkdirSync(path.join(src, 'admin', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(src, 'admin', 'dist', 'index.html'), '<!doctype html><title>无尽夏后台</title>');
    fs.writeFileSync(path.join(src, 'admin', 'dist', 'index.js'), 'console.log("admin");');
  } else {
    fs.mkdirSync(path.join(src, 'admin'), { recursive: true });
  }
  for (const [rel, content] of Object.entries(seed)) {
    const abs = path.join(src, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return { dir, src, out: path.join(dir, 'deploy-out') };
}

function deployEnv(fx, extra = {}) {
  return {
    WUJINXIA_DEPLOY_SOURCE_ROOT: fx.src,
    WUJINXIA_DEPLOY_OUT: fx.out,
    WUJINXIA_DEPLOY_HOST: 'garden-node1',
    WUJINXIA_DEPLOY_PORT: '8091',
    WUJINXIA_DEPLOY_VERSION: '0.1.0',
    WUJINXIA_DEPLOY_DOMAIN: 'app-cloud.example.internal',
    ...extra,
  };
}

// ── 1. snapshot：一致性导出 ───────────────────────────────────────────────

test('snapshot 走 VACUUM INTO：活库有未 checkpoint 的 WAL 行时快照仍完整，而直接复制主库文件会漏', async (t) => {
  const dir = scratch(t, 'snapshot');
  const keyFile = writeKey(dir);
  const live = makeLiveDb(dir);
  assert.ok(fs.existsSync(path.join(dir, 'data', 'wujinxia-cloud.db-wal')), '本用例前提：活库有未落盘的 WAL');

  // 对照实验：只复制主库文件（不带 -wal），读不到 WAL 里已提交的行。
  const naiveCopy = path.join(dir, 'naive-copy.db');
  fs.copyFileSync(live.dbFile, naiveCopy);
  let naiveCounts = null;
  try {
    naiveCounts = tableCountsOf(naiveCopy);
  } catch {
    naiveCounts = null;
  }
  const naiveRows = naiveCounts ? Number(naiveCounts.run_logs ?? 0) : 0;
  const liveRows = Number(live.writer.prepare('SELECT COUNT(*) AS c FROM run_logs').get().c);
  assert.equal(liveRows, ROWS, '活库现读行数');
  assert.ok(naiveRows < liveRows, '直接复制主库文件必须漏行（这正是禁止的做法）：复制件 ' + naiveRows + ' 行 vs 活库 ' + liveRows + ' 行');

  const run = runTool(BACKUP_TOOL, ['snapshot'], backupEnv(dir));
  assert.equal(run.status, 0, run.output);
  const snapshotFile = run.result.snapshot;
  const manifest = readJson(run.result.manifest);

  assert.equal(manifest.method, 'VACUUM INTO');
  assert.equal(manifest.integrity, 'ok');
  const snapCounts = tableCountsOf(snapshotFile);
  assert.equal(Number(snapCounts.run_logs), liveRows, '快照必须带上 WAL 里已提交未落盘的行');
  assert.ok(naiveRows < Number(snapCounts.run_logs), '同一份数据，VACUUM INTO 比复制主库文件多读到行');
  for (const entry of manifest.tables) {
    assert.equal(entry.rows, snapCounts[entry.name], '清单行数与快照现读对平：' + entry.name);
    assert.equal(entry.rows, Number(live.writer.prepare('SELECT COUNT(*) AS c FROM "' + entry.name + '"').get().c), '清单行数与活库现读对平：' + entry.name);
  }
  assert.equal(manifest.sha256, crypto.createHash('sha256').update(fs.readFileSync(snapshotFile)).digest('hex'));
  assert.ok(!readAllTexts(dir, [keyFile]).some((text) => text.includes(KEY_TEXT)), '密钥不得出现在任何产物里');
  live.writer.close();
});

test('snapshot 在活库缺失时报清楚错误，不静默', async (t) => {
  const dir = scratch(t, 'snapshot-missing');
  writeKey(dir);
  const run = runTool(BACKUP_TOOL, ['snapshot'], backupEnv(dir));
  assert.equal(run.status, 1);
  assert.match(run.output, /找不到数据库文件/);
});

// ── 2. encrypt / restore-check 往返 ──────────────────────────────────────

test('encrypt→restore-check 往返：密文里没有明文 sqlite 头，密钥不落任何输出与 backups.detail', async (t) => {
  const dir = scratch(t, 'roundtrip');
  const keyFile = writeKey(dir);
  const live = makeLiveDb(dir);
  const snap = runTool(BACKUP_TOOL, ['snapshot'], backupEnv(dir));
  assert.equal(snap.status, 0, snap.output);
  const enc = runTool(BACKUP_TOOL, ['encrypt', '--in', snap.result.snapshot], backupEnv(dir));
  assert.equal(enc.status, 0, enc.output);
  const packageFile = enc.result.package;
  const packageBytes = fs.readFileSync(packageFile);
  assert.ok(!packageBytes.includes(Buffer.from('SQLite format 3', 'latin1')), '密文里不得出现明文 sqlite 头');
  assert.ok(!packageBytes.includes(Buffer.from('CREATE TABLE', 'latin1')), '密文里不得出现明文建表语句');
  assert.equal(String(enc.result.keyFingerprint).length, 8, '包头只写密钥指纹（sha256 前 8 位）');

  const check = runTool(BACKUP_TOOL, ['restore-check', '--package', packageFile], backupEnv(dir));
  assert.equal(check.status, 0, check.output);
  const report = readJson(check.result.report);
  assert.equal(report.ok, true);
  assert.equal(report.integrity, 'ok');
  assert.ok(report.tablesChecked >= 7, '逐表对平的表数：' + report.tablesChecked);
  assert.deepEqual(report.diffs, []);
  const workDir = path.join(dir, 'work');
  assert.ok(!fs.existsSync(workDir) || fs.readdirSync(workDir).length === 0, '恢复校验的明文临时件默认不留盘');

  const recorded = runTool(BACKUP_TOOL, ['record', '--package', packageFile, '--report', check.result.report], backupEnv(dir));
  assert.equal(recorded.status, 0, recorded.output);
  const detailDb = new DatabaseSync(live.dbFile, { readOnly: true });
  let detailRow;
  try {
    detailRow = detailDb.prepare('SELECT at, ok, size_bytes, sha256, remote, detail FROM backups ORDER BY id DESC LIMIT 1').get();
  } finally {
    detailDb.close();
  }
  assert.equal(Number(detailRow.ok), 1);
  assert.equal(Number(detailRow.size_bytes), fs.statSync(packageFile).size);
  assert.equal(detailRow.sha256, crypto.createHash('sha256').update(packageBytes).digest('hex'));
  assert.equal(detailRow.remote, 'aliyun-huantong:/var/backups/wujinxia-app-cloud');
  const detail = JSON.parse(detailRow.detail);
  assert.equal(detail.algo, 'aes-256-gcm');
  assert.equal(detail.keyFingerprint, enc.result.keyFingerprint);
  assert.match(String(detail.tableSummary), /run_logs=\d+/);

  // 密钥值不得出现在任何输出文件、日志字符串与 detail 里。
  const keyHex = Buffer.from(KEY_TEXT, 'utf8').toString('hex');
  const keyB64 = Buffer.from(KEY_TEXT, 'utf8').toString('base64');
  const corpus = [snap.output, enc.output, check.output, recorded.output, detailRow.detail];
  corpus.push(...readAllTexts(dir, [keyFile]));
  for (const text of corpus) {
    assert.ok(!String(text).includes(KEY_TEXT), '输出里出现密钥明文');
    assert.ok(!String(text).includes(keyHex), '输出里出现密钥 hex');
    assert.ok(!String(text).includes(keyB64), '输出里出现密钥 base64');
  }
  live.writer.close();
});

test('篡改密文一个字节，restore-check 必须因 GCM 认证标签失败', async (t) => {
  const dir = scratch(t, 'tamper');
  writeKey(dir);
  const live = makeLiveDb(dir);
  const snap = runTool(BACKUP_TOOL, ['snapshot'], backupEnv(dir));
  const enc = runTool(BACKUP_TOOL, ['encrypt', '--in', snap.result.snapshot], backupEnv(dir));
  assert.equal(enc.status, 0, enc.output);
  const bytes = fs.readFileSync(enc.result.package);
  const flipped = Buffer.from(bytes);
  const position = bytes.length - 5; // 落在认证标签区
  flipped[position] = flipped[position] ^ 0x01;
  const tampered = path.join(dir, 'tampered.db.enc');
  fs.writeFileSync(tampered, flipped);
  fs.copyFileSync(enc.result.manifest, tampered + '.manifest.json');
  const run = runTool(BACKUP_TOOL, ['restore-check', '--package', tampered], backupEnv(dir));
  assert.equal(run.status, 1);
  assert.match(run.output, /GCM 认证标签/);
  const reports = fs.readdirSync(path.join(dir, 'reports')).filter((n) => n.startsWith('restore-check-'));
  assert.ok(reports.length >= 1, '失败也要留下报告');
  const report = readJson(path.join(dir, 'reports', reports.sort().pop()));
  assert.equal(report.ok, false);
  assert.match(String(report.error), /GCM|篡改/);
  live.writer.close();
});

test('restore-check 的逐表行数与清单不平必须报红并列出差异表名', async (t) => {
  const dir = scratch(t, 'count-diff');
  writeKey(dir);
  const live = makeLiveDb(dir);
  const snap = runTool(BACKUP_TOOL, ['snapshot'], backupEnv(dir));
  const enc = runTool(BACKUP_TOOL, ['encrypt', '--in', snap.result.snapshot], backupEnv(dir));
  const manifest = readJson(enc.result.manifest);
  const runLogs = manifest.tables.find((entry) => entry.name === 'run_logs');
  runLogs.rows = Number(runLogs.rows) + 7;
  manifest.tables.push({ name: 'ghost_table', rows: 3 });
  const fakeManifest = path.join(dir, 'tampered.manifest.json');
  fs.writeFileSync(fakeManifest, JSON.stringify(manifest, null, 2));
  const run = runTool(BACKUP_TOOL, ['restore-check', '--package', enc.result.package, '--manifest', fakeManifest], backupEnv(dir));
  assert.equal(run.status, 1);
  assert.match(run.output, /行数与快照清单不平/);
  assert.match(run.output, /run_logs/);
  assert.match(run.output, /ghost_table/);
  const reports = fs.readdirSync(path.join(dir, 'reports')).filter((n) => n.startsWith('restore-check-'));
  const report = readJson(path.join(dir, 'reports', reports.sort().pop()));
  assert.deepEqual(report.diffs.map((d) => d.table).sort(), ['ghost_table', 'run_logs']);
  live.writer.close();
});

// ── 3. record 幂等 ───────────────────────────────────────────────────────

test('record 写入后 SELECT 回读对平；同一份备份重复 record 只留一行', async (t) => {
  const dir = scratch(t, 'record');
  writeKey(dir);
  const live = makeLiveDb(dir);
  const snap = runTool(BACKUP_TOOL, ['snapshot'], backupEnv(dir));
  const enc = runTool(BACKUP_TOOL, ['encrypt', '--in', snap.result.snapshot], backupEnv(dir));
  const first = runTool(BACKUP_TOOL, ['record', '--package', enc.result.package], backupEnv(dir));
  assert.equal(first.status, 0, first.output);
  assert.equal(first.result.mode, 'inserted');
  const second = runTool(BACKUP_TOOL, ['record', '--package', enc.result.package, '--ok', 'false'], backupEnv(dir));
  assert.equal(second.status, 0, second.output);
  assert.equal(second.result.mode, 'updated');
  assert.equal(second.result.id, first.result.id, '同一份备份不得留下第二行');
  const db = new DatabaseSync(live.dbFile, { readOnly: true });
  const rows = db.prepare('SELECT id, at, ok, size_bytes, sha256, remote, detail FROM backups WHERE sha256=?').all(enc.result.packageSha256);
  assert.equal(rows.length, 1, '重复 record 后行数：' + rows.length);
  assert.equal(Number(rows[0].ok), 0, '第二次 --ok false 要落到同一行');
  assert.equal(rows[0].remote, 'aliyun-huantong:/var/backups/wujinxia-app-cloud');
  assert.ok(!/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(String(rows[0].detail)), 'detail 里不得有 IP');
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM backups').get().c), 1, '不得产生孤儿记账行');
  db.close();
  live.writer.close();
});

test('record 在库文件不存在时报清楚错误，不静默失败', async (t) => {
  const dir = scratch(t, 'record-missing-db');
  writeKey(dir);
  const run = runTool(BACKUP_TOOL, ['record', '--package', path.join(dir, 'nope.enc')], backupEnv(dir, {
    WUJINXIA_DB_FILE: path.join(dir, 'data', 'definitely-missing.db'),
  }));
  assert.equal(run.status, 1);
  assert.match(run.output, /找不到要记账的数据库文件/);
});

test('record 会在没有 backups 表的本项目库里建表再写行', async (t) => {
  const dir = scratch(t, 'record-creates-table');
  writeKey(dir);
  const live = makeLiveDb(dir, { createBackupsTable: false });
  const probe = new DatabaseSync(live.dbFile, { readOnly: true });
  let before;
  try {
    before = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='backups'").get();
  } finally {
    probe.close();
  }
  assert.equal(before, undefined, '前提：库里本来没有 backups 表');
  const snap = runTool(BACKUP_TOOL, ['snapshot'], backupEnv(dir));
  const enc = runTool(BACKUP_TOOL, ['encrypt', '--in', snap.result.snapshot], backupEnv(dir));
  const recorded = runTool(BACKUP_TOOL, ['record', '--package', enc.result.package], backupEnv(dir));
  assert.equal(recorded.status, 0, recorded.output);
  const readDb = new DatabaseSync(live.dbFile, { readOnly: true });
  let row;
  try {
    row = readDb.prepare('SELECT id, at, ok, size_bytes, sha256, remote, detail FROM backups WHERE id=?').get(recorded.result.id);
  } finally {
    readDb.close();
  }
  assert.ok(row);
  assert.equal(row.sha256, enc.result.packageSha256);
  live.writer.close();
});

// ── 4. dry-run 自证 ──────────────────────────────────────────────────────

test('transfer 默认 dry-run：不出现任何 scp/ssh 子进程；加 --apply 才执行且必定失败并报清楚', async (t) => {
  const dir = scratch(t, 'transfer-dryrun');
  writeKey(dir);
  const live = makeLiveDb(dir);
  const { stub, marker } = writeTransportStub(dir);
  const traceFile = path.join(dir, 'exec-trace.jsonl');
  const env = backupEnv(dir, { WUJINXIA_EXEC_TRACE: traceFile, WUJINXIA_TRANSPORT_STUB: stub, WUJINXIA_TEST_STUB_MARKER: marker });
  const snap = runTool(BACKUP_TOOL, ['snapshot'], env);
  const enc = runTool(BACKUP_TOOL, ['encrypt', '--in', snap.result.snapshot], env);

  const dry = runTool(BACKUP_TOOL, ['transfer', '--package', enc.result.package], env);
  assert.equal(dry.status, 0, dry.output);
  assert.match(dry.output, /dry-run/);
  assert.match(dry.output, /scp .*aliyun-huantong:\/var\/backups\/wujinxia-app-cloud/);
  assert.equal(dry.result.dryRun, true);
  assert.ok(!fs.existsSync(traceFile), 'dry-run 不能留下任何执行痕迹');
  assert.ok(!fs.existsSync(marker), 'dry-run 不能起过传输子进程');
  assert.equal(dry.result.files.length, 2, '密文包与清单一起传，远端才恢复得了');

  const applied = runTool(BACKUP_TOOL, ['transfer', '--package', enc.result.package, '--apply'], env);
  assert.notEqual(applied.status, 0, '--apply 面对不存在的别名必须失败');
  assert.match(applied.output, /传输失败/);
  assert.ok(fs.existsSync(traceFile), '--apply 才留执行痕迹');
  const trace = fs.readFileSync(traceFile, 'utf8');
  assert.match(trace, /"scp"/);
  assert.match(trace, /"ssh"/);
  assert.ok(fs.existsSync(marker));
  assert.ok(!applied.output.includes(KEY_TEXT), '失败信息里不得带密钥');
  live.writer.close();
});

test('transfer 拒绝写死 IP 与缺失目标', async (t) => {
  const dir = scratch(t, 'transfer-target');
  writeKey(dir);
  const live = makeLiveDb(dir);
  const snap = runTool(BACKUP_TOOL, ['snapshot'], backupEnv(dir));
  const enc = runTool(BACKUP_TOOL, ['encrypt', '--in', snap.result.snapshot], backupEnv(dir));
  const ipRun = runTool(BACKUP_TOOL, ['transfer', '--package', enc.result.package, '--remote', '39.96.78.175:/var/backups/wujinxia-app-cloud'], backupEnv(dir));
  assert.equal(ipRun.status, 1);
  assert.match(ipRun.output, /禁止在传输目标里写死 IP/);
  const noTarget = runTool(BACKUP_TOOL, ['transfer', '--package', enc.result.package], backupEnv(dir, { WUJINXIA_BACKUP_REMOTE: '' }));
  assert.equal(noTarget.status, 1);
  assert.match(noTarget.output, /缺少传输目标/);
  assert.throws(() => backup.parseRemote('47.93.63.115:/var/backups/x'), /禁止在传输目标里写死 IP/);
  assert.deepEqual(backup.parseRemote('aliyun-huantong:/var/backups/wujinxia-app-cloud/'), {
    alias: 'aliyun-huantong',
    dir: '/var/backups/wujinxia-app-cloud',
    raw: 'aliyun-huantong:/var/backups/wujinxia-app-cloud',
    label: 'aliyun-huantong',
  });
  live.writer.close();
});

test('deploy 默认 dry-run：不起任何外部命令；--apply 用替身目标必定失败且错误不带密钥', async (t) => {
  const fx = deployFixture(t, 'deploy-dryrun');
  const traceFile = path.join(fx.dir, 'deploy-trace.jsonl');
  const { stub, marker } = writeTransportStub(fx.dir);
  const env = deployEnv(fx, { WUJINXIA_EXEC_TRACE: traceFile, WUJINXIA_TRANSPORT_STUB: stub, WUJINXIA_TEST_STUB_MARKER: marker });
  const run = runTool(DEPLOY_TOOL, [], env);
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /dry-run/);
  assert.ok(!fs.existsSync(traceFile), 'dry-run 不得留下执行痕迹');
  assert.ok(!fs.existsSync(marker), 'dry-run 不得起 scp/ssh/curl');
  assert.equal(run.result.executed, 0);
  assert.match(run.result.commands.join(' '), /systemctl restart wujinxia-app-cloud/);
  assert.match(run.result.commands.join(' '), /http:\/\/127\.0\.0\.1:8091\/api\/software\/health/);

  const applied = runTool(DEPLOY_TOOL, ['--apply'], env);
  assert.notEqual(applied.status, 0, '不存在的别名 + --apply 必须失败');
  assert.match(applied.output, /发布中断/);
  assert.ok(fs.existsSync(traceFile), '--apply 才有执行痕迹');
  assert.ok(fs.existsSync(marker));
  assert.ok(!applied.output.includes(KEY_TEXT));
  assert.ok(!applied.output.includes('39.96.78.175'), '输出里不得出现服务器 IP');

  const rollbackTrace = path.join(fx.dir, 'rollback-trace.jsonl');
  const rollbackMarker = path.join(fx.dir, 'rollback.marker');
  const rollback = runTool(DEPLOY_TOOL, ['rollback', '--release', 'deadbeef1234'], deployEnv(fx, {
    WUJINXIA_EXEC_TRACE: rollbackTrace,
    WUJINXIA_TRANSPORT_STUB: stub,
    WUJINXIA_TEST_STUB_MARKER: rollbackMarker,
  }));
  assert.equal(rollback.status, 0, rollback.output);
  assert.match(rollback.output, /dry-run/);
  assert.equal(rollback.result.mode, 'rollback');
  assert.ok(!fs.existsSync(rollbackTrace), '回滚同样默认 dry-run');
  assert.ok(!fs.existsSync(rollbackMarker));
});

// ── 5. deploy 内容校验 ───────────────────────────────────────────────────

test('deploy 校验发布内容：cloud/ 清单与 admin/dist，凭据或库文件出现就拒绝发布', async (t) => {
  const ok = deployFixture(t, 'deploy-ok');
  const run = runTool(DEPLOY_TOOL, [], deployEnv(ok));
  assert.equal(run.status, 0, run.output);
  const manifest = readJson(path.join(ok.out, 'manifest.json'));
  assert.equal(manifest.service, 'wujinxia-app-cloud');
  assert.equal(manifest.fileCount, 5);
  assert.deepEqual(manifest.groups.map((g) => g.name).sort(), ['admin/dist', 'cloud']);
  assert.equal(manifest.distPresent, true);
  const tarFile = path.join(ok.out, manifest.tar);
  const entries = deploy.readTarEntries(tarFile).filter((e) => e.type === '0');
  assert.deepEqual(entries.map((e) => e.name).sort(), manifest.files.map((f) => f.path).sort());
  for (const entry of entries) {
    const abs = path.join(ok.src, ...entry.name.split('/'));
    assert.equal(entry.sha256, crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'), 'tar 内容要与源文件逐字节一致：' + entry.name);
    assert.equal(entry.size, fs.statSync(abs).size);
  }
  assert.ok(fs.statSync(tarFile).size % 512 === 0, 'tar 必须按 512 字节块对齐');
  assert.equal(manifest.tarSha256, crypto.createHash('sha256').update(fs.readFileSync(tarFile)).digest('hex'));

  const secretCases = [
    ['cloud/.env', 'WUJINXIA_ADMIN_PASSWORD=不该上传'],
    ['cloud/wujinxia-cloud.db', 'SQLite format 3 假主库字节'],
    ['cloud/wujinxia-cloud.db-wal', '假 WAL 字节'],
    ['cloud/tls/cloud.pem', '假证书'],
    ['cloud/secrets.json', '{"token":"不该随包分发"}'],
    ['admin/dist/.env.production', '不该随后台构建件上传'],
  ];
  for (const [rel, content] of secretCases) {
    const fx = deployFixture(t, 'deploy-secret');
    const abs = path.join(fx.src, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    const rejected = runTool(DEPLOY_TOOL, [], deployEnv(fx));
    assert.equal(rejected.status, 3, rel + ' 必须被拒绝：' + rejected.output);
    assert.match(rejected.output, /拒绝发布/);
  }

  const pemContent = deployFixture(t, 'deploy-pem-content');
  fs.writeFileSync(path.join(pemContent.src, 'cloud', 'inline.pem-ish.mjs'), 'export const blob = "-----BEGIN PRIVATE KEY-----\\nAAAA";\n');
  const contentRun = runTool(DEPLOY_TOOL, [], deployEnv(pemContent));
  assert.equal(contentRun.status, 3, contentRun.output);
  assert.match(contentRun.output, /私钥/);

  // 发布内容里带原站域名/服务名/目录也要拒绝（文件名之外的第二道闸）。
  const leak = deployFixture(t, 'deploy-site-leak');
  fs.writeFileSync(path.join(leak.src, 'cloud', 'endpoints.mjs'),
    'export const adminApi = "https://wujinxia.ainiannian.online/api/admin/login";\n');
  const leakRun = runTool(DEPLOY_TOOL, [], deployEnv(leak));
  assert.equal(leakRun.status, 3, leakRun.output);
  assert.match(leakRun.output, /内容含原站引用/);

  const leakService = deployFixture(t, 'deploy-service-leak');
  fs.writeFileSync(path.join(leakService.src, 'cloud', 'restart.mjs'),
    'export const legacyService = "systemctl restart garden-node-api";\n');
  const leakServiceRun = runTool(DEPLOY_TOOL, [], deployEnv(leakService));
  assert.equal(leakServiceRun.status, 3, leakServiceRun.output);
  assert.match(leakServiceRun.output, /原站节点 API 服务名/);

  // 本项目自己的源码文件名带 password/session 不该被误拦（cloud/password.mjs 是合法源码）。
  const legit = deployFixture(t, 'deploy-legit-names');
  fs.writeFileSync(path.join(legit.src, 'cloud', 'password.mjs'), 'export function hashPassword(input) { return input; }\n');
  fs.writeFileSync(path.join(legit.src, 'cloud', 'session.mjs'), 'export const accessTokenField = "accessToken";\n');
  const legitRun = runTool(DEPLOY_TOOL, [], deployEnv(legit));
  assert.equal(legitRun.status, 0, legitRun.output);
  assert.ok(legitRun.result.fileCount >= 7);

  const emptyDist = deployFixture(t, 'deploy-empty-dist', { withDist: false });
  fs.mkdirSync(path.join(emptyDist.src, 'admin', 'dist'), { recursive: true });
  const distRun = runTool(DEPLOY_TOOL, [], deployEnv(emptyDist));
  assert.equal(distRun.status, 3, distRun.output);
  assert.match(distRun.output, /admin\/dist\/ 存在但是空目录/);

  const noCloud = deployFixture(t, 'deploy-no-cloud', { withDist: false });
  fs.rmSync(path.join(noCloud.src, 'cloud'), { recursive: true, force: true });
  const cloudRun = runTool(DEPLOY_TOOL, [], deployEnv(noCloud));
  assert.equal(cloudRun.status, 3, cloudRun.output);
  assert.match(cloudRun.output, /找不到本项目云服务源码目录/);

  const noVersion = runTool(DEPLOY_TOOL, [], { ...deployEnv(ok), WUJINXIA_DEPLOY_VERSION: '' });
  assert.equal(noVersion.status, 3, noVersion.output);
  assert.match(noVersion.output, /缺少期望版本/);

  const badPort = runTool(DEPLOY_TOOL, [], deployEnv(ok, { WUJINXIA_DEPLOY_PORT: '80' }));
  assert.equal(badPort.status, 3, badPort.output);
  assert.match(badPort.output, /端口必须是/);

  const ipHost = runTool(DEPLOY_TOOL, [], deployEnv(ok, { WUJINXIA_DEPLOY_HOST: '39.96.78.175' }));
  assert.equal(ipHost.status, 3, ipHost.output);
  assert.match(ipHost.output, /别名/);
});

test('deploy 的 Node 版本要求与打包器单独可断言', () => {
  const low = deploy.nodeVersionCheck('v20.11.0');
  assert.equal(low.ok, false);
  assert.match(low.message, /--experimental-sqlite/);
  assert.equal(deploy.nodeVersionCheck('v22.13.0').ok, true);
  assert.equal(deploy.nodeVersionCheck('v24.16.0').ok, true);
  const dir = path.join(REPO, '.runtime');
  const probe = path.join(dir, 'tar-probe-' + process.pid + '-' + Date.now() + '.tar');
  try {
    const longName = 'cloud/nested/' + 'x'.repeat(80) + '/deep-file.mjs';
    deploy.createTarFile([
      { name: 'cloud/a.mjs', content: Buffer.from('A', 'utf8') },
      { name: longName, content: Buffer.from('B'.repeat(700), 'utf8') },
    ], probe, { mtimeSec: 1730000000 });
    const entries = deploy.readTarEntries(probe).filter((e) => e.type === '0');
    assert.deepEqual(entries.map((e) => e.name).sort(), ['cloud/a.mjs', longName].sort());
    assert.equal(entries.find((e) => e.name === longName).size, 700);
  } finally {
    fs.rmSync(probe, { force: true });
  }
});

// ── 6. 隔离自证 ──────────────────────────────────────────────────────────

test('隔离自证：产物与计划命令只出现本项目名字，原站服务/目录/域名/站点配置为零', async (t) => {
  const fx = deployFixture(t, 'deploy-isolation');
  const run = runTool(DEPLOY_TOOL, [], deployEnv(fx));
  assert.equal(run.status, 0, run.output);
  const unit = fs.readFileSync(path.join(fx.out, 'wujinxia-app-cloud.service'), 'utf8');
  const nginx = fs.readFileSync(path.join(fx.out, 'nginx-wujinxia.conf'), 'utf8');
  const install = fs.readFileSync(path.join(fx.out, 'install.sh'), 'utf8');
  const planText = run.result.commands.join('\n');
  const all = [unit, nginx, install, planText, run.output];

  for (const text of all) {
    assert.deepEqual(deploy.scanForbidden(text), [], '产物或命令里出现原站引用：' + text.slice(0, 120));
    assert.ok(!/nginx\s+-s\s+(reload|restart|stop|quit)/.test(text), '不得自动 reload 共享 nginx：' + text.slice(0, 120));
    assert.ok(!/systemctl\s+(restart|reload|stop)\s+nginx/.test(text), '不得重启共享 nginx');
    assert.deepEqual(deploy.findIpLiterals(text), [], '不得出现服务器 IP 字面量');
  }

  assert.match(unit, /User=wujinxia-app-cloud/);
  assert.match(unit, /Group=wujinxia-app-cloud/);
  assert.match(unit, /WorkingDirectory=\/opt\/wujinxia-app-cloud\/current/);
  assert.match(unit, /StateDirectory=wujinxia-app-cloud/);
  assert.match(unit, /EnvironmentFile=\/etc\/wujinxia-app-cloud\/env/);
  assert.match(unit, /Environment=WUJINXIA_DATA_DIR=\/var\/lib\/wujinxia-app-cloud/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /Environment=WUJINXIA_BIND=127\.0\.0\.1/);
  assert.match(nginx, /server_name app-cloud\.example\.internal/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:8091;/);
  assert.match(nginx, /ssl_certificate \{\{TLS_CERT\}\}|ssl_certificate \/etc\/ssl/);
  assert.match(install, /getent passwd "\$SERVICE" .* \|\| \\\n\s*useradd --system --home-dir \/nonexistent --shell \/usr\/sbin\/nologin "\$SERVICE"/);
  assert.match(install, /install -d -m 0750 -o "\$SERVICE" -g "\$SERVICE" "\$STATE_DIR"/);
  assert.match(install, /\/etc\/nginx\/conf\.d\/wujinxia-app-cloud\.conf/);
  assert.match(planText, /ln -sfn \/opt\/wujinxia-app-cloud\/releases\/[0-9a-f]{16} \/opt\/wujinxia-app-cloud\/current/);
  assert.match(planText, /ss -ltnp .*grep -w ':8091'/);

  // 反证：原站资源确实会被拦掉（不是把禁词写空蒙混）。
  assert.ok(deploy.scanForbidden('systemctl restart garden-node-api').length >= 1);
  assert.ok(deploy.scanForbidden('rsync -a web/dist /opt/garden-world/web/dist').length >= 1);
  assert.ok(deploy.scanForbidden('certbot -d wujinxia.ainiannian.online').length >= 1);
  assert.ok(deploy.scanForbidden('nginx -s reload').length >= 1);
  assert.throws(() => deploy.assertCleanTargets([['ssh', 'garden-node1', 'systemctl restart garden-node-api']], '测试'), /越界目标/);
  assert.throws(() => deploy.assertCleanTargets([['scp', 'a.tar', '39.96.78.175:/tmp/a.tar']], '测试'), /IP 字面量/);
  assert.equal(deploy.assertHost('garden-node1'), 'garden-node1');
  assert.throws(() => deploy.assertHost('garden-node-api'), /原站/);

  const noRelease = runTool(DEPLOY_TOOL, ['rollback'], deployEnv(fx));
  assert.equal(noRelease.status, 3, noRelease.output);
  assert.match(noRelease.output, /--release/);
  const rollbackPlan = deploy.buildRollbackPlan({ host: 'garden-node1', port: 8091, release: 'abc12345', apply: false });
  assert.deepEqual(rollbackPlan.commands.flatMap((step) => deploy.scanForbidden(step.argv.join(' '))), []);
  assert.match(rollbackPlan.commands.map((s) => s.argv.join(' ')).join(' '), /ln -sfn \/opt\/wujinxia-app-cloud\/releases\/abc12345 \/opt\/wujinxia-app-cloud\/current/);
  assert.throws(() => deploy.buildRollbackPlan({ host: 'garden-node1', port: 8091, release: '../etc' }), /十六进制/);
});

// ── 7. 密钥文件闸 ────────────────────────────────────────────────────────

test('密钥文件位置与权限闸：非 win32 要 0600，Windows 下不许落在版本控制目录内', async (t) => {
  const fxRoot = scratch(t, 'key-guard');
  const trackedDir = path.join(fxRoot, 'cloud');
  fs.mkdirSync(trackedDir, { recursive: true });
  const trackedKey = path.join(trackedDir, 'backup.key');
  fs.writeFileSync(trackedKey, KEY_TEXT);
  const ignoredKey = path.join(fxRoot, '.runtime', 'backup.key');
  fs.mkdirSync(path.dirname(ignoredKey), { recursive: true });
  fs.writeFileSync(ignoredKey, KEY_TEXT);
  const outsideKey = path.join(fxRoot, '..', 'outside-key-' + process.pid + '.key');
  fs.writeFileSync(outsideKey, KEY_TEXT);
  t.after(() => { try { fs.rmSync(outsideKey, { force: true }); } catch { /* 忽略 */ } });

  assert.throws(() => backup.assertKeyFileLocation(trackedKey, fxRoot, 'win32'), /版本控制目录内/);
  assert.equal(backup.assertKeyFileLocation(ignoredKey, fxRoot, 'win32').insideRepo, true);
  assert.equal(backup.assertKeyFileLocation(outsideKey, fxRoot, 'win32').insideRepo, false);
  assert.throws(() => backup.loadKeyFile(trackedKey, { root: fxRoot, platform: 'win32' }), /版本控制目录内/);

  backup.checkKeyMode(0o600, 'linux', 'x');
  assert.throws(() => backup.checkKeyMode(0o644, 'linux', 'x'), /0600/);
  assert.throws(() => backup.checkKeyMode(0o640, 'darwin', 'x'), /0600/);
  backup.checkKeyMode(0o666, 'win32', 'x');

  const hexKey = crypto.randomBytes(32).toString('hex');
  const hexFile = path.join(fxRoot, '.runtime', 'hex.key');
  fs.writeFileSync(hexFile, hexKey);
  const loaded = backup.loadKeyFile(hexFile, { root: fxRoot, platform: 'win32' });
  assert.equal(loaded.key.length, 32);
  assert.equal(loaded.derived, false);
  assert.equal(loaded.fingerprint, crypto.createHash('sha256').update(Buffer.from(hexKey, 'hex')).digest('hex').slice(0, 8));
  const passphrase = backup.loadKeyFile(ignoredKey, { root: fxRoot, platform: 'win32' });
  assert.equal(passphrase.derived, true);
  assert.equal(passphrase.key.length, 32);
});

test('encrypt 缺密钥文件时报明确错误，绝不回退到内置或默认密钥', async (t) => {
  const dir = scratch(t, 'no-key');
  const live = makeLiveDb(dir);
  const snap = runTool(BACKUP_TOOL, ['snapshot'], backupEnv(dir));
  const run = runTool(BACKUP_TOOL, ['encrypt', '--in', snap.result.snapshot], backupEnv(dir, { WUJINXIA_BACKUP_KEY_FILE: '' }));
  assert.equal(run.status, 1);
  assert.match(run.output, /缺少密钥文件/);
  const wrongKey = runTool(BACKUP_TOOL, ['restore-check', '--package', snap.result.snapshot + '.nope.enc'], backupEnv(dir));
  assert.equal(wrongKey.status, 1);
  live.writer.close();
});

test('加密包换一把密钥必须被指纹拦下，不静默产出错误恢复结果', async (t) => {
  const dir = scratch(t, 'other-key');
  writeKey(dir);
  const live = makeLiveDb(dir);
  const snap = runTool(BACKUP_TOOL, ['snapshot'], backupEnv(dir));
  const enc = runTool(BACKUP_TOOL, ['encrypt', '--in', snap.result.snapshot], backupEnv(dir));
  fs.writeFileSync(path.join(dir, 'keys', 'backup.key'), '另一把密钥-口令-不许出现在输出-7');
  const run = runTool(BACKUP_TOOL, ['restore-check', '--package', enc.result.package], backupEnv(dir));
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /密钥指纹不符/);
  live.writer.close();
});

// ── 8. run 全流程 ────────────────────────────────────────────────────────

test('run 串起 snapshot→encrypt→transfer→restore-check→record，默认 dry-run 且不留执行痕迹', async (t) => {
  const dir = scratch(t, 'run-full');
  const keyFile = writeKey(dir);
  const live = makeLiveDb(dir);
  const { stub, marker } = writeTransportStub(dir);
  const traceFile = path.join(dir, 'run-trace.jsonl');
  const run = runTool(BACKUP_TOOL, ['run'], backupEnv(dir, { WUJINXIA_EXEC_TRACE: traceFile, WUJINXIA_TRANSPORT_STUB: stub, WUJINXIA_TEST_STUB_MARKER: marker }));
  assert.equal(run.status, 0, run.output);
  assert.equal(run.result.restoreOk, true);
  assert.equal(run.result.transferDryRun, true);
  assert.ok(fs.existsSync(run.result.package));
  const recordDb = new DatabaseSync(live.dbFile, { readOnly: true });
  let row;
  try {
    row = recordDb.prepare('SELECT id, at, ok, size_bytes, sha256, remote, detail FROM backups WHERE id=?').get(run.result.recordId);
  } finally {
    recordDb.close();
  }
  assert.ok(row, '全流程必须留下记账行');
  assert.equal(Number(row.ok), 1);
  assert.equal(row.remote, 'aliyun-huantong:/var/backups/wujinxia-app-cloud');
  const detail = JSON.parse(row.detail);
  assert.equal(detail.algo, 'aes-256-gcm');
  assert.equal(String(detail.keyFingerprint).length, 8);
  assert.ok(!readAllTexts(dir, [keyFile]).some((text) => text.includes(KEY_TEXT)), '全流程任何产物都不许带出密钥');
  assert.ok(!fs.existsSync(traceFile), 'run 默认不连网');
  assert.ok(!fs.existsSync(marker));
  live.writer.close();
});
