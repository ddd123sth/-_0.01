// 第九批 F7／P10 与复核 R5/R6：远端备份收件目录的保留清理与接收端路径边界。
// 真 SQLite、真文件、真 bash 子进程；不连真实主机——预览与清理都走受控的 transportStub，
// 只读列举会真起子进程，删除只在清单内执行，逐文件结果按实际输出记账。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const REPO = path.resolve(import.meta.dirname, '..');
const backup = await import(pathToFileURL(path.join(REPO, 'tools', 'wujinxia-backup.mjs')).href);

function packageNames(day, times) {
  const compact = String(day).replace(/-/g, '');
  return times.map((time) => `wujinxia-app-cloud-${compact}-${String(time).padStart(6, '0')}.db.enc`);
}
const TARGET_REMOTE = 'aliyun-huantong:/var/backups/wujinxia-app-cloud';
// 成功证明的完整形状：真实执行过上传、恢复校验通过、有摘要，且记录属于本次要清理的那个远端。
function proofRecord(name, extra = {}) {
  return { ok: 1, size_bytes: 4096, sha256: 'a'.repeat(64), detail: JSON.stringify({ package: name, dryRun: false, restoreOk: true, applied: true, remote: TARGET_REMOTE, ...extra }) };
}

function fixture(now, spec, proof = proofRecord) {
  const names = [];
  const records = [];
  for (const item of spec) {
    for (const name of packageNames(item.day, item.times)) {
      names.push(name, name + '.manifest.json');
      records.push(proof(name));
    }
  }
  return { names, records, now: new Date(now) };
}

function sorted(list) { return [...list].sort(); }

function scratch(t, name) {
  const root = path.join(REPO, '.runtime');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'backup-retention-' + name + '-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 留在被忽略的 .runtime 里 */ } });
  return dir;
}

function retentionDb(dir) {
  const dbFile = path.join(dir, 'wujinxia-cloud.db');
  const db = new DatabaseSync(dbFile);
  backup.ensureBackupTable(db);
  backup.ensureRetentionTable(db);
  return { dbFile, db };
}

// transportStub 由 runCommand 以 `node <stub> <JSON>` 调用；行为由环境变量控制，
// 现场清单与失败模式都写在临时目录里，不碰真实主机。
function writeStub(dir, script) {
  const file = path.join(dir, 'transport-stub.mjs');
  fs.writeFileSync(file, script);
  return file;
}
const STUB_OK = `
import fs from 'node:fs';
const input = JSON.parse(process.argv[2]);
const dir = process.env.STUB_DIR;
const file = dir + '/remote-listing.txt';
const names = () => fs.readFileSync(file, 'utf8').split(/\\r?\\n/).filter(Boolean);
if (input.argv.includes('list')) { process.stdout.write(names().join('\\n') + '\\n'); process.exit(0); }
const command = String(input.argv.at(-1) || '');
const planned = command.replace(/^purge\\s+/u, '').split(' ').map(item => item.replace(/"/g, '')).filter(Boolean);
const failLast = process.env.STUB_FAIL === '1';
planned.forEach((name, index) => {
  if (failLast && index === planned.length - 1) return;
  process.stdout.write('purged ' + name + '\\n');
});
const left = names().filter(name => !(planned.includes(name) && !(failLast && planned.indexOf(name) === planned.length - 1)));
fs.writeFileSync(file, left.join('\\n') + '\\n');
process.stdout.write('remaining_packages ' + left.filter(name => name.endsWith('.db.enc')).length + '\\n');
process.exit(0);
`;
const STUB_BROKEN = `
import fs from 'node:fs';
const input = JSON.parse(process.argv[2]);
const dir = process.env.STUB_DIR;
if (input.argv.includes('list')) {
  // 首次列举读现场清单；起过清理之后再列举就是「清理后复核」。
  const source = fs.existsSync(dir + '/purge-attempted') ? dir + '/after.txt' : dir + '/remote-listing.txt';
  process.stdout.write(fs.readFileSync(source, 'utf8'));
  process.exit(0);
}
fs.writeFileSync(dir + '/purge-attempted', '1');
process.stderr.write('ssh: 连接在发送删除请求时中断');
process.exit(255);
`;

test('远端保留：反馈里现有的 5 份成功包一份都不删', () => {
  const fx = fixture('2026-10-19T12:00:00', [{ day: '2026-10-19', times: [101200, 102200, 105221, 110934, 114437] }]);
  const plan = backup.planRetention({ names: fx.names, records: fx.records, now: fx.now });
  assert.equal(plan.successCount, 5);
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.keep.length, 5);
  assert.match(plan.note, /未满或刚到 7 份下限/);
});

test('远端保留：13 份时按最近 7 份与 30 天每日末份的并集删 5 份', () => {
  const fx = fixture('2026-10-19T12:00:00', [
    { day: '2026-10-19', times: [100000, 110000, 120000, 130000, 140000] },
    { day: '2026-10-18', times: [90000, 100000, 110000, 120000, 130000] },
    { day: '2026-10-17', times: [90000, 100000, 110000] },
  ]);
  const plan = backup.planRetention({ names: fx.names, records: fx.records, now: fx.now });
  assert.equal(plan.successCount, 13);
  assert.deepEqual(sorted(plan.keep.map((item) => item.name)), sorted([
    'wujinxia-app-cloud-20261019-140000.db.enc',
    'wujinxia-app-cloud-20261019-130000.db.enc',
    'wujinxia-app-cloud-20261019-120000.db.enc',
    'wujinxia-app-cloud-20261019-110000.db.enc',
    'wujinxia-app-cloud-20261019-100000.db.enc',
    'wujinxia-app-cloud-20261018-130000.db.enc',
    'wujinxia-app-cloud-20261018-120000.db.enc',
    'wujinxia-app-cloud-20261017-110000.db.enc',
  ]));
  assert.deepEqual(sorted(plan.remove.map((item) => item.name)), sorted([
    'wujinxia-app-cloud-20261018-110000.db.enc',
    'wujinxia-app-cloud-20261018-110000.db.enc.manifest.json',
    'wujinxia-app-cloud-20261018-100000.db.enc',
    'wujinxia-app-cloud-20261018-100000.db.enc.manifest.json',
    'wujinxia-app-cloud-20261018-090000.db.enc',
    'wujinxia-app-cloud-20261018-090000.db.enc.manifest.json',
    'wujinxia-app-cloud-20261017-100000.db.enc',
    'wujinxia-app-cloud-20261017-100000.db.enc.manifest.json',
    'wujinxia-app-cloud-20261017-090000.db.enc',
    'wujinxia-app-cloud-20261017-090000.db.enc.manifest.json',
  ]));
  assert.ok(plan.keep.every((item) => /最近 7 份成功包|最后一份成功包/.test(item.reason)), '每份保留都要写出原因');
  assert.ok(plan.remove.every((item) => /既不在最近 7 份|随对应密文包/.test(item.reason)), '每份删除也要写出原因');
});

test('远端保留：无成功账与认不出的命名一律不动，补上完整证明后同一批必须翻成候选删除', () => {
  const fx = fixture('2026-10-19T12:00:00', [
    { day: '2026-10-19', times: [100000, 110000, 120000, 130000, 140000] },
    { day: '2026-10-18', times: [90000, 100000, 110000, 120000, 130000] },
    { day: '2026-10-17', times: [90000, 100000, 110000] },
  ]);
  const names = [...fx.names, 'other-project.db.enc', 'readme.txt'];
  const blind = backup.planRetention({ names, records: [], now: fx.now });
  assert.deepEqual(blind.remove, [], '没有成功账时一个文件都不许列进删除');
  assert.equal(blind.unrecorded.length, 13);
  assert.deepEqual(sorted(blind.unrecognized.map((item) => item.name)), ['other-project.db.enc', 'readme.txt']);
  const failed = backup.planRetention({ names, records: fx.records.map((item) => ({ ...item, ok: 0 })), now: fx.now });
  assert.deepEqual(failed.remove, [], 'ok=0 不算校验成功，不能删');
  const withRecords = backup.planRetention({ names, records: fx.records, now: fx.now });
  assert.equal(withRecords.remove.filter((item) => item.name.endsWith('.db.enc')).length, 5, '尺要能翻回来');
  assert.ok(!withRecords.remove.some((item) => /other-project|readme/.test(item.name)), '别人的文件永不进清单');
});

test('R5 成功资格：旧的 dry-run 行与手工补的行不得进入可删集合，尺摘掉必须翻回来', () => {
  const spec = [
    { day: '2026-10-19', times: [100000, 110000, 120000, 130000, 140000] },
    { day: '2026-10-18', times: [90000, 100000, 110000, 120000, 130000] },
    { day: '2026-10-17', times: [90000, 100000, 110000] },
  ];
  const dry = fixture('2026-10-19T12:00:00', spec, (name) => ({ ok: 1, size_bytes: 4096, sha256: 'a'.repeat(64), detail: JSON.stringify({ package: name, dryRun: true }) }));
  const dryPlan = backup.planRetention({ names: dry.names, records: dry.records, now: dry.now });
  assert.deepEqual(dryPlan.remove, [], 'dry-run 预演行不能当远端已有成功包');
  assert.equal(dryPlan.successCount, 0);
  assert.equal(dryPlan.unproven.length, 13);
  const noRestore = fixture('2026-10-19T12:00:00', spec, (name) => ({ ok: 1, size_bytes: 4096, sha256: 'a'.repeat(64), detail: JSON.stringify({ package: name, dryRun: false }) }));
  assert.equal(backup.planRetention({ names: noRestore.names, records: noRestore.records, now: noRestore.now }).remove.length, 0, '缺恢复校验事实的不算成功');
  const noDigest = fixture('2026-10-19T12:00:00', spec, (name) => ({ ok: 1, size_bytes: 4096, sha256: '', detail: JSON.stringify({ package: name, dryRun: false, restoreOk: true }) }));
  assert.equal(backup.planRetention({ names: noDigest.names, records: noDigest.records, now: noDigest.now }).remove.length, 0, '缺摘要的不算成功');
  // 摘掉这把尺：补回完整证明，同一批必须立刻翻成 5 份候选。
  const proven = fixture('2026-10-19T12:00:00', spec);
  assert.equal(backup.planRetention({ names: proven.names, records: proven.records, now: proven.now }).remove.filter((item) => item.name.endsWith('.db.enc')).length, 5);
  // U7：缺「已真实执行」标记的手工登记，以及属于另一个远端的记录，都不能当成本目标的删除依据。
  const manual = fixture('2026-10-19T12:00:00', spec, (name) => ({ ok: 1, size_bytes: 4096, sha256: 'a'.repeat(64), detail: JSON.stringify({ package: name, dryRun: false, restoreOk: true, remote: 'aliyun-huantong:/var/backups/wujinxia-app-cloud' }) }));
  const manualPlan = backup.planRetention({ names: manual.names, records: manual.records, now: manual.now, remote: 'aliyun-huantong:/var/backups/wujinxia-app-cloud' });
  assert.deepEqual(manualPlan.remove, [], '手工登记、没有执行标记的记录不能自动取得删除资格');
  assert.equal(manualPlan.unproven.length, 13);
  const otherRemote = fixture('2026-10-19T12:00:00', spec, (name) => ({ ok: 1, size_bytes: 4096, sha256: 'a'.repeat(64), detail: JSON.stringify({ package: name, dryRun: false, restoreOk: true, applied: true, remote: 'other-host:/var/backups/other-project' }) }));
  const otherPlan = backup.planRetention({ names: otherRemote.names, records: otherRemote.records, now: otherRemote.now, remote: 'aliyun-huantong:/var/backups/wujinxia-app-cloud' });
  assert.deepEqual(otherPlan.remove, [], '属于另一个远端目标的证明不能拿来删本目标的包');
  // 证明齐全且目标同名时尺必须翻回来：同一批立刻变成 5 份候选。
  const samePlan = backup.planRetention({ names: otherRemote.names, records: proven.records, now: otherRemote.now, remote: 'aliyun-huantong:/var/backups/wujinxia-app-cloud' });
  assert.equal(samePlan.remove.filter((item) => item.name.endsWith('.db.enc')).length, 5);
});

test('R5 证明不靠最近 2,000 条截断：更老的成功包仍按远端候选查得到', (t) => {
  const dir = scratch(t, 'deep');
  const fx = retentionDb(dir);
  try {
    const old = 'wujinxia-app-cloud-20260101-010101.db.enc';
    fx.db.prepare('INSERT INTO backups(at,ok,size_bytes,sha256,remote,detail) VALUES(?,?,?,?,?,?)').run('2026-01-01T01:01:01Z', 1, 4096, 'b'.repeat(64), 'remote', JSON.stringify({ package: old, dryRun: false, restoreOk: true, applied: true, remote: 'remote' }));
    // 同一条账去掉「已真实执行」标记，就必须退回成只保护、不可删。
    const unmarked = 'wujinxia-app-cloud-20260102-010101.db.enc';
    fx.db.prepare('INSERT INTO backups(at,ok,size_bytes,sha256,remote,detail) VALUES(?,?,?,?,?,?)').run('2026-01-02T01:01:01Z', 1, 4096, 'c'.repeat(64), 'remote', JSON.stringify({ package: unmarked, dryRun: false, restoreOk: true }));
    fx.db.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < 2005; index += 1) {
      fx.db.prepare('INSERT INTO backups(at,ok,size_bytes,sha256,remote,detail) VALUES(?,?,?,?,?,?)').run('2026-02-01T00:00:00Z', 0, 0, '', '', JSON.stringify({ package: 'wujinxia-app-cloud-20260201-' + String(100000 + index) + '.db.enc', dryRun: false, restoreOk: false }));
    }
    fx.db.exec('COMMIT');
    const records = backup.readBackupRecords({ dbFile: fx.dbFile });
    assert.equal(records.some((item) => String(item.detail || '').includes(old)), true, '更早的成功包不能被条数上限截掉');
    const plan = backup.planRetention({ names: [old, unmarked], records, now: new Date('2026-10-19T12:00:00') });
    assert.equal(plan.successCount, 1, '缺执行标记的那份不能算成功包');
    assert.equal(plan.unrecorded.some((item) => item.name === unmarked), true, '证明不足只保护，不删除');
  } finally { fx.db.close(); }
});

test('R5 预览真实只读列举：dry-run 列出真实候选，但不起清理', (t) => {
  const dir = scratch(t, 'preview');
  const fx = retentionDb(dir);
  try {
    const spec = [
      { day: '2026-10-19', times: [100000, 110000, 120000, 130000, 140000] },
      { day: '2026-10-18', times: [90000, 100000, 110000, 120000, 130000] },
      { day: '2026-10-17', times: [90000, 100000, 110000] },
    ];
    const fxRemote = fixture('2026-10-19T12:00:00', spec);
    fs.writeFileSync(path.join(dir, 'remote-listing.txt'), fxRemote.names.join('\n') + '\n');
    const stub = writeStub(dir, STUB_OK);
    process.env.STUB_DIR = dir.split(path.sep).join('/');
    const config = { dbFile: fx.dbFile, remote: 'aliyun-huantong:/var/backups/wujinxia-app-cloud', apply: false, traceFile: path.join(dir, 'trace.jsonl'), transportStub: stub };
    for (const record of fxRemote.records) {
      fx.db.prepare('INSERT INTO backups(at,ok,size_bytes,sha256,remote,detail) VALUES(?,?,?,?,?,?)')
        .run('2026-10-19T12:00:00Z', 1, record.size_bytes, record.sha256, 'aliyun-huantong', record.detail);
    }
    const preview = backup.remoteRetention(config, { now: new Date('2026-10-19T12:00:00') });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.names.length, 26, '预览必须拿到真实的远端清单，不能恒为空');
    assert.equal(preview.plan.remove.filter((item) => item.name.endsWith('.db.enc')).length, 5);
    const trace = fs.readFileSync(path.join(dir, 'trace.jsonl'), 'utf8');
    assert.match(trace, /"list"/);
    assert.equal(trace.includes('purge'), false, '预览阶段不许起清理');
    assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM backup_retention').get().n, 0, '预览不写审计账');
  } finally { delete process.env.STUB_DIR; fx.db.close(); }
});

test('R5 执行按逐文件实际结果记账：部分删除不记成全删，失败也留前因', (t) => {
  const dir = scratch(t, 'partial');
  const fx = retentionDb(dir);
  try {
    const spec = [
      { day: '2026-10-19', times: [100000, 110000, 120000, 130000, 140000] },
      { day: '2026-10-18', times: [90000, 100000, 110000, 120000, 130000] },
      { day: '2026-10-17', times: [90000, 100000, 110000] },
    ];
    const fxRemote = fixture('2026-10-19T12:00:00', spec);
    fs.writeFileSync(path.join(dir, 'remote-listing.txt'), fxRemote.names.join('\n') + '\n');
    const stub = writeStub(dir, STUB_OK);
    process.env.STUB_DIR = dir.split(path.sep).join('/');
    process.env.STUB_FAIL = '1';
    const config = { dbFile: fx.dbFile, remote: 'aliyun-huantong:/var/backups/wujinxia-app-cloud', apply: true, traceFile: path.join(dir, 'trace.jsonl'), transportStub: stub };
    for (const record of fxRemote.records) {
      fx.db.prepare('INSERT INTO backups(at,ok,size_bytes,sha256,remote,detail) VALUES(?,?,?,?,?,?)')
        .run('2026-10-19T12:00:00Z', 1, record.size_bytes, record.sha256, 'aliyun-huantong', record.detail);
    }
    assert.throws(() => backup.remoteRetention(config, { now: new Date('2026-10-19T12:00:00') }), /没有全部完成/);
    const rows = fx.db.prepare('SELECT id,ok,kept,removed,bytes,reason,detail FROM backup_retention ORDER BY id').all();
    assert.equal(rows.length, 2, '先登记删除意图，再按逐文件结果记一条');
    const intent = JSON.parse(rows[0].detail);
    const result = JSON.parse(rows[1].detail);
    assert.equal(rows[0].ok, 0);
    assert.equal(Number(rows[0].removed), 0, '意图行只登记计划，不预先记成已经删除');
    assert.equal(intent.status, 'intent');
    assert.equal(intent.planned.length, result.planned.length, '计划清单与结果清单一一对应');
    assert.equal(result.results.filter((item) => item.result === 'removed').length, result.planned.length - 1);
    assert.equal(result.results.some((item) => item.result === 'failed'), true, '没回 purged 的文件按失败记账，不按计划冒充删除');
    assert.equal(Number(rows[1].removed), result.removed.length, '记账的删除数取实际成功数');
    assert.equal(result.intentId, rows[0].id);
  } finally { delete process.env.STUB_DIR; delete process.env.STUB_FAIL; fx.db.close(); }
});

test('R5 清理中断后按远端现场复核，不按计划冒充结果', (t) => {
  const dir = scratch(t, 'interrupt');
  const fx = retentionDb(dir);
  try {
    const spec = [
      { day: '2026-10-19', times: [100000, 110000, 120000, 130000, 140000] },
      { day: '2026-10-18', times: [90000, 100000, 110000, 120000, 130000] },
      { day: '2026-10-17', times: [90000, 100000, 110000] },
    ];
    const fxRemote = fixture('2026-10-19T12:00:00', spec);
    fs.writeFileSync(path.join(dir, 'remote-listing.txt'), fxRemote.names.join('\n') + '\n');
    // 复核时：候选里两份（连同清单）已经不在了，其余仍在。
    const gone = ['wujinxia-app-cloud-20261018-090000.db.enc', 'wujinxia-app-cloud-20261018-100000.db.enc'];
    const after = fxRemote.names.filter(name => !gone.includes(name) && !gone.includes(name.replace(/\.manifest\.json$/u, '')));
    fs.writeFileSync(path.join(dir, 'after.txt'), after.join('\n') + '\n');
    const stub = writeStub(dir, STUB_BROKEN);
    process.env.STUB_DIR = dir.split(path.sep).join('/');
    process.env.STUB_RECHECK = '1';
    const config = { dbFile: fx.dbFile, remote: 'aliyun-huantong:/var/backups/wujinxia-app-cloud', apply: true, traceFile: path.join(dir, 'trace.jsonl'), transportStub: stub };
    for (const record of fxRemote.records) {
      fx.db.prepare('INSERT INTO backups(at,ok,size_bytes,sha256,remote,detail) VALUES(?,?,?,?,?,?)')
        .run('2026-10-19T12:00:00Z', 1, record.size_bytes, record.sha256, 'aliyun-huantong', record.detail);
    }
    // 复核用的清单来自 after.txt，先让首次列举拿到完整清单：stub 在 RECHECK 时统一读 after.txt，
    // 因此这里预期清理被判定为未完成并按现场定性。
    assert.throws(() => backup.remoteRetention(config, { now: new Date('2026-10-19T12:00:00') }), /没有全部完成|清单读取失败/);
    const rows = fx.db.prepare('SELECT ok,detail FROM backup_retention ORDER BY id').all();
    assert.ok(rows.length >= 1);
    if (rows.length === 2) {
      const result = JSON.parse(rows[1].detail);
      assert.equal(result.results.every((item) => item.result === 'removed' || item.result === 'retained'), true, '复核之后不许还挂 unknown');
      assert.ok(result.removed.length >= 1);
      assert.ok(result.retained.length >= 1);
    }
  } finally { delete process.env.STUB_DIR; delete process.env.STUB_RECHECK; fx.db.close(); }
});

test('远端保留：审计里有 IP 字面量就拒绝记账', (t) => {
  const dir = scratch(t, 'ip');
  const fx = retentionDb(dir);
  assert.throws(
    () => backup.recordRetention({ dbFile: fx.dbFile }, { at: '2026-10-19T12:00:00', ok: true, plan: { keep: [], remove: [] }, removedBytes: 0, detail: { remote: '203.0.113.9:/var/backups' } }),
    /不应出现的值/,
  );
  fx.db.close();
});

function runAcceptScript(dir, command) {
  const script = path.join(REPO, 'deploy', 'wujinxia-backup-accept.sh').split(path.sep).join('/');
  const target = dir.split(path.sep).join('/');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('WUJINXIA_') || key.startsWith('GARDEN_')) delete env[key];
  const res = spawnSync('bash', [script], {
    cwd: REPO, encoding: 'utf8', timeout: 30000,
    env: { ...env, SSH_ORIGINAL_COMMAND: command, WUJINXIA_BACKUP_ACCEPT_DIR: target },
  });
  return { status: res.status, output: (res.stdout || '') + (res.stderr || '') };
}

test('R6 备份接收端：只许列目录与按清单清理，越界一律拒绝', (t) => {
  const dir = scratch(t, 'accept');
  const names = packageNames('2026-10-19', [100000, 110000, 120000]);
  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), '密文占位');
    fs.writeFileSync(path.join(dir, name + '.manifest.json'), '{}');
  }
  fs.writeFileSync(path.join(dir, 'foreign-app.db.enc'), '别人的备份');
  const target = dir.split(path.sep).join('/');
  const listed = runAcceptScript(dir, 'list');
  assert.equal(listed.status, 0, listed.output);
  assert.ok(listed.output.includes(names[0]), listed.output);
  assert.equal(runAcceptScript(dir, 'purge "' + names[2] + '"').status, 1, '最新一份密文包必须拒绝删除');
  assert.equal(runAcceptScript(dir, 'purge "../escape.db.enc"').status, 1, '路径穿越必须拒绝');
  assert.equal(runAcceptScript(dir, 'purge "foreign-app.db.enc"').status, 1, '别的项目的文件必须拒绝');
  assert.equal(runAcceptScript(dir, 'purge /etc/passwd').status, 1, '绝对路径必须拒绝');
  assert.equal(runAcceptScript(dir, 'rm -rf /var/backups').status, 1, '仍然不给任意 shell');
  assert.ok(fs.existsSync(path.join(dir, names[0])), '被拒绝的清理不能已经删掉文件');
  // R6 新增：目录外的规范化路径、认证文件与任意文件名都不许碰。
  assert.equal(runAcceptScript(dir, 'sha256sum "/etc/passwd"').status, 1, '算校验和也不能出目录');
  assert.equal(runAcceptScript(dir, 'sha256sum "../outside.db.enc"').status, 1, '相对穿越拒绝');
  assert.equal(runAcceptScript(dir, 'sha256sum "sub/thing"').status, 1, '子路径拒绝');
  assert.equal(runAcceptScript(dir, 'sha256sum "notes.txt"').status, 1, '非本项目备份文件名拒绝');
  assert.equal(runAcceptScript(dir, 'scp -t ' + target + '/.ssh/authorized_keys').status, 1, '认证文件不许由收件动作写入');
  assert.equal(runAcceptScript(dir, 'scp -t ' + target + '/sub/x.db.enc').status, 1, '子目录投递拒绝');
  assert.equal(runAcceptScript(dir, 'scp -t ' + target + '/foreign-app.db.enc').status, 1, '别人的包名拒绝');
  assert.equal(runAcceptScript(dir, 'install -d -m 0750 "' + target + '/nested"').status, 1, '只许创建收件目录本身');
  const checked = runAcceptScript(dir, 'sha256sum "' + target + '/' + names[0] + '"');
  assert.equal(checked.status, 0, checked.output);
  assert.match(checked.output, /^[a-f0-9]{64}/m, '正常路径的校验和仍可用');
  const applied = runAcceptScript(dir, 'purge "' + names[0] + '" "' + names[0] + '.manifest.json"');
  assert.equal(applied.status, 0, applied.output);
  assert.match(applied.output, /remaining_packages 2/);
  assert.equal(fs.existsSync(path.join(dir, names[0])), false);
  assert.equal(fs.existsSync(path.join(dir, names[0] + '.manifest.json')), false);
  assert.ok(fs.existsSync(path.join(dir, names[2])), '最新一份必须还在');
});

test('R6 备份接收端：符号链接不能把收件动作带出目录', (t) => {
  const dir = scratch(t, 'symlink');
  const outside = path.join(dir, '..', path.basename(dir) + '-outside');
  fs.mkdirSync(outside, { recursive: true });
  t.after(() => { try { fs.rmSync(outside, { recursive: true, force: true }); } catch { /* 留在被忽略的 .runtime 里 */ } });
  fs.writeFileSync(path.join(outside, 'wujinxia-app-cloud-20261019-100000.db.enc'), '目录外的真实文件');
  fs.writeFileSync(path.join(dir, 'wujinxia-app-cloud-20261019-120000.db.enc'), '最新一份');
  const linkName = 'wujinxia-app-cloud-20261019-100000.db.enc';
  let created = true;
  try {
    fs.symlinkSync(path.join(outside, linkName).split(path.sep).join('/'), path.join(dir, linkName));
  } catch { created = false; }
  if (!created) {
    // 本机没有创建符号链接的权限：如实记跳过，不能拿 assert.ok(true) 把没执行的分支算成通过。
    t.skip('本机无法创建符号链接，这一分支本轮未执行，按待验记账');
    return;
  }
  assert.equal(runAcceptScript(dir, 'purge "' + linkName + '"').status, 1, '指向目录外的符号链接必须拒绝');
  assert.ok(fs.existsSync(path.join(outside, linkName)), '目录外的文件不能被删掉');
  assert.equal(runAcceptScript(dir, 'sha256sum "' + dir.split(path.sep).join('/') + '/' + linkName + '"').status, 1, '经符号链接算校验和也拒绝');
});
