import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../cloud/cli.mjs';
import { openStore } from '../cloud/db.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(here, '..', 'cloud', 'cli.mjs');

function runCli(args, { env = {}, stdin = null, entry = cliPath } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [entry, ...args], {
      env: { ...process.env, WUJINXIA_ADMIN_PASSWORD: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    if (stdin !== null) child.stdin.end(stdin); else child.stdin.end();
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('parseArgs reads flag=value and flag followed by a value', () => {
  const parsed = parseArgs(['create-admin', '--username=root_admin', '--remark', 'hello', 'extra']);
  assert.equal(parsed.command, 'create-admin');
  assert.equal(parsed.flags.username, 'root_admin');
  assert.equal(parsed.flags.remark, 'hello');
  assert.deepEqual(parsed.positionals, ['create-admin', 'extra']);
});

test('create-admin takes the password only from the environment, refuses to overwrite and audits the create', async () => {
  const dir = fs.mkdtempSync(path.resolve('.runtime/cloud-cli-'));
  const file = path.join(dir, 'cli.db');
  try {
    const created = await runCli(['create-admin', '--username', 'root_admin'], { env: { WUJINXIA_DB_FILE: file, WUJINXIA_ADMIN_PASSWORD: 'Cli-Admin-1', WUJINXIA_SCRYPT_N: '1024' } });
    assert.equal(created.code, 0, created.stderr);
    const store = openStore({ file });
    const admin = store.get('SELECT * FROM admins WHERE username=?', 'root_admin');
    assert.ok(admin);
    assert.equal(admin.password_hash.includes('Cli-Admin-1'), false);
    const audit = store.get('SELECT * FROM admin_audit WHERE action=?', 'create_admin');
    assert.ok(audit);
    store.db.close();

    const duplicate = await runCli(['create-admin', '--username', 'root_admin'], { env: { WUJINXIA_DB_FILE: file, WUJINXIA_ADMIN_PASSWORD: 'Cli-Admin-1', WUJINXIA_SCRYPT_N: '1024' } });
    assert.notEqual(duplicate.code, 0);
    assert.match(duplicate.stderr, /已存在/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('create-admin without any password source exits non-zero and never reads it from argv', async () => {
  const dir = fs.mkdtempSync(path.resolve('.runtime/cloud-cli-'));
  const file = path.join(dir, 'cli.db');
  try {
    const res = await runCli(['create-admin', '--username', 'ghost_admin'], { env: { WUJINXIA_DB_FILE: file, WUJINXIA_SCRYPT_N: '1024' } });
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /口令/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('put-backup-record writes a backups row and purge-logs reports the removed count', async () => {
  const dir = fs.mkdtempSync(path.resolve('.runtime/cloud-cli-'));
  const file = path.join(dir, 'cli.db');
  const env = { WUJINXIA_DB_FILE: file, WUJINXIA_SCRYPT_N: '1024' };
  try {
    const stored = openStore({ file });
    // 〔K27·2026-10-20〕云端这一条按**首次接收时刻**算保留期（与服务同一出处），不是按 occurred_at：
    //   所以 fixture 要造的就是「很久以前就收到的老行」，received_at 也得同样久远——
    //   只把 occurred_at 拨老、received_at 用当下，按现在的语义本来就不该删（前一轮这条断言就是这么红的）。
    const ancient = new Date(Date.now() - 400 * 86_400_000).toISOString();
    stored.run(`INSERT INTO run_logs(event_id,user_id,install_id,occurred_at,received_at,level,category,message,content_sha256,is_error)
      VALUES('evt-old00001',1,'install-aaaa1111',?,?, 'info','plant','row','sha1',0)`,
    ancient, ancient);
    stored.db.close();

    const backup = await runCli(['put-backup-record', '--at', '2026-10-18T00:00:00.000Z', '--ok', 'true', '--size', '1024', '--sha256', 'abc123', '--remote', 'offsite.example', '--detail', 'nightly'], { env });
    assert.equal(backup.code, 0, backup.stderr);
    const verify = openStore({ file });
    const row = verify.get('SELECT * FROM backups ORDER BY id DESC LIMIT 1');
    assert.equal(row.at, '2026-10-18T00:00:00.000Z');
    assert.equal(row.ok, 1);
    assert.equal(row.size_bytes, 1024);
    assert.equal(row.sha256, 'abc123');
    verify.db.close();

    // 〔K27·2026-10-20〕默认干跑：不带 --apply 只报「这一条不会删任何东西」，且不许出现清理完成那句。
    const dry = await runCli(['purge-logs'], { env });
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /干跑/);
    assert.equal(dry.stdout.includes('已清理'), false, '干跑不得报成已经删过');
    const still = openStore({ file });
    assert.equal(still.get('SELECT COUNT(*) AS n FROM run_logs').n, 1, '干跑之后那一行必须还在');
    still.db.close();

    const purge = await runCli(['purge-logs', '--apply'], { env });
    assert.equal(purge.code, 0, purge.stderr);
    // 计数口径与服务同一份：正文清理一条＋整行删除一条＝本轮推进两条（不是「删了两行」）。
    assert.match(purge.stdout, /"bodyPurgedNormal":1/);
    assert.match(purge.stdout, /"rowsRemoved":1/);
    assert.match(purge.stdout, /按服务同一套保留语义清理完成：本轮推进 2 条/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('发布件经 current 软链入口时，命令行仍然执行（服务器上真踩到过的坑）', async () => {
  const dir = fs.mkdtempSync(path.resolve('.runtime/cloud-symlink-'));
  const link = path.join(dir, 'current');
  const file = path.join(dir, 'linked.db');
  try {
    fs.symlinkSync(path.resolve(here, '..'), link, process.platform === 'win32' ? 'junction' : 'dir');
    const throughLink = path.join(link, 'cloud', 'cli.mjs');
    assert.notEqual(path.resolve(throughLink), path.resolve(cliPath), '入口路径要与仓库路径不同，才算走软链');
    assert.equal(fs.realpathSync(throughLink), fs.realpathSync(cliPath), '软链必须真的指向同一份 cli.mjs');
    const created = await runCli(['create-admin', '--username', 'symlink_admin'], {
      entry: throughLink,
      env: { WUJINXIA_DB_FILE: file, WUJINXIA_ADMIN_PASSWORD: 'Cli-Admin-2', WUJINXIA_SCRYPT_N: '1024' },
    });
    // 把入口判断改回「只比 resolve 后的路径」时，这一条必须变红：main() 不执行、库里没有管理员行。
    assert.equal(created.code, 0, created.stderr);
    assert.match(created.stdout, /管理员|admin/i, '走软链时也要有正常输出，不能静默退出');
    const store = openStore({ file });
    assert.ok(store.get('SELECT * FROM admins WHERE username=?', 'symlink_admin'), '软链入口下 create-admin 必须真的写库');
    store.db.close();
    const help = await runCli([], { entry: throughLink, env: { WUJINXIA_DB_FILE: file } });
    assert.match(help.stdout + help.stderr, /create-admin|用法|usage/i, '不带参数时要打印用法');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
