// Zero-dependency command line entry: serve, create-admin, purge-logs, put-backup-record.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { createPasswordHasher } from './password.mjs';
import { validAdminPassword } from './common.mjs';

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  // Same reason as server.mjs: the deployed release is reached through the `current` symlink.
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(entry)); }
  catch { return import.meta.url === pathToFileURL(path.resolve(entry)).href; }
}

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[body] = next; index += 1; }
      else flags[body] = true;
    } else {
      positionals.push(token);
    }
  }
  return { command: positionals[0], positionals, flags };
}

// The db and app modules pull in node:sqlite, so they are imported only after this
// check to keep the failure message clean instead of a loader stack.
async function requireSqlite() {
  try { await import('node:sqlite'); }
  catch {
    process.stderr.write('云服务启动失败：当前 Node.js 没有内置 node:sqlite 模块。请升级到 Node 22.13 及以上，或以 --experimental-sqlite 运行后再试。\n');
    process.exit(1);
  }
}
async function openStoreAt(config) {
  await requireSqlite();
  const { openStore } = await import('./db.mjs');
  return openStore({ file: config.dbFile });
}

function readPasswordFromStdin() {
  try {
    const data = fs.readFileSync(0, 'utf8');
    const line = data.split(/\r?\n/u)[0] || '';
    return line.replace(/\r$/u, '');
  } catch { return ''; }
}

// Offline subcommands do not open a socket, so they borrow a placeholder port.
function loadCliConfig() {
  return loadConfig({ ...process.env, WUJINXIA_PORT: process.env.WUJINXIA_PORT || '13999' });
}

async function serve() {
  const config = loadConfig();
  await requireSqlite();
  const { startServer } = await import('./app.mjs');
  const running = await startServer(config);
  const shownHost = running.address.address === '::1' ? '[::1]' : running.address.address;
  process.stdout.write(`WUJINXIA_CLOUD_READY http://${shownHost}:${running.address.port}\n`);
  const shutdown = () => { running.close().finally(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function createAdmin(flags) {
  const config = loadCliConfig();
  const store = await openStoreAt(config);
  try {
    const username = flags.username;
    if (!username || typeof username !== 'string') { process.stderr.write('缺少 --username 参数\n'); process.exit(2); }
    if (store.get('SELECT id FROM admins WHERE username=?', username)) {
      process.stderr.write('该管理员已存在，未覆盖现有口令\n'); process.exit(1);
    }
    const password = process.env.WUJINXIA_ADMIN_PASSWORD || readPasswordFromStdin();
    if (!password) { process.stderr.write('未读取到管理员口令，请设置 WUJINXIA_ADMIN_PASSWORD 或通过标准输入提供\n'); process.exit(2); }
    if (!validAdminPassword(password)) { process.stderr.write('管理员口令长度或字符不符合要求\n'); process.exit(2); }
    const hasher = createPasswordHasher(config.scrypt);
    const hash = await hasher.hash(password);
    store.run('INSERT INTO admins(username,password_hash,enabled,created_at) VALUES(?,?,1,?)', username, hash, store.nowIso());
    store.run('INSERT INTO admin_audit(admin_username,action,target,detail,at) VALUES(?,?,?,?,?)', username, 'create_admin', `username:${username}`, '', store.nowIso());
    process.stdout.write('管理员已创建\n');
  } finally { try { store.db.close(); } catch { /* ignore */ } }
}

async function purgeLogs(flags) {
  // 〔K27·2026-10-20〕这一条以前自己按 `occurred_at` 直接 DELETE，和服务那套「按首次接收算保留期、
  // 先清正文、行与未确认事实继续留着」是两份语义；在生产跑一次就会删掉服务本该留下的行。
  // 现在只许调同一个出处：purge.mjs 的 purgeOnce，且默认干跑，要真删必须显式 --apply。
  const config = loadCliConfig();
  const store = await openStoreAt(config);
  try {
    const { createLogPurger } = await import('./purge.mjs');
    const { purgeOnce } = createLogPurger({ store, config });
    if (flags.apply !== true) {
      process.stdout.write('干跑：这一条不会删任何东西。要真的按服务同一套保留语义清理，请再加 --apply。\n');
      return;
    }
    const removed = purgeOnce({ trigger: 'cli' });
    process.stdout.write(`按服务同一套保留语义清理完成：本轮推进 ${removed} 条（正文清理与整行删除都算在里面，逐类计数见上一行 JSON）。\n`);
  } finally { try { store.db.close(); } catch { /* ignore */ } }
}

async function putBackupRecord(flags) {
  const config = loadCliConfig();
  const store = await openStoreAt(config);
  try {
    const at = typeof flags.at === 'string' ? flags.at : store.nowIso();
    const ok = flags.ok === undefined ? 1
      : (flags.ok === true || String(flags.ok).toLowerCase() === 'true' || flags.ok === '1') ? 1 : 0;
    const sizeBytes = flags.size === undefined ? null : Number(flags.size);
    const sha256 = typeof flags.sha256 === 'string' ? flags.sha256 : null;
    const remote = typeof flags.remote === 'string' ? flags.remote : null;
    const detail = typeof flags.detail === 'string' ? flags.detail : '';
    store.run('INSERT INTO backups(at,ok,size_bytes,sha256,remote,detail) VALUES(?,?,?,?,?,?)', at, ok, sizeBytes, sha256, remote, detail);
    process.stdout.write('备份记录已写入\n');
  } finally { try { store.db.close(); } catch { /* ignore */ } }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  switch (parsed.command) {
    case 'serve': return serve();
    case 'create-admin': return createAdmin(parsed.flags);
    case 'purge-logs': return purgeLogs(parsed.flags);
    case 'put-backup-record': return putBackupRecord(parsed.flags);
    default:
      process.stderr.write('用法：node cloud/cli.mjs <serve|create-admin|purge-logs|put-backup-record> [参数]\n');
      process.exit(2);
  }
}

if (isMainModule()) main();

export { parseArgs };
