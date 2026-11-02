// SQLite store for the wujinxia cloud service. Tables and column names here
// are what the API contract and the other two modules depend on.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DIR_MODE, FILE_MODE } from './config.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS software_users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  remark TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT,
  last_login_at TEXT,
  disabled_at TEXT);
CREATE TABLE IF NOT EXISTS admins(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_login_at TEXT);
CREATE TABLE IF NOT EXISTS software_sessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('user','admin')),
  user_id INTEGER,
  admin_id INTEGER,
  token_hash TEXT NOT NULL UNIQUE,
  install_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  revoke_reason TEXT NOT NULL DEFAULT '',
  CHECK((kind='user' AND user_id IS NOT NULL) OR (kind='admin' AND admin_id IS NOT NULL)));
CREATE TABLE IF NOT EXISTS refresh_tokens(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  revoke_reason TEXT NOT NULL DEFAULT '',
  parent_id INTEGER,
  rotation_id TEXT);
CREATE TABLE IF NOT EXISTS refresh_rotation_receipts(
  old_refresh_id INTEGER NOT NULL,
  session_id INTEGER NOT NULL,
  child_refresh_id INTEGER NOT NULL,
  rotation_id TEXT NOT NULL,
  install_id TEXT NOT NULL DEFAULT '',
  receipt_cipher TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(old_refresh_id,session_id,rotation_id),
  UNIQUE(session_id,rotation_id));
CREATE TABLE IF NOT EXISTS run_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  install_id TEXT NOT NULL,
  stable_id TEXT,
  nickname TEXT,
  server_name TEXT,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  level TEXT NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  app_version TEXT,
  trace_id TEXT,
  operation_id TEXT,
  error_code TEXT,
  outcome_json TEXT,
  outcome_state TEXT,
  attempted INTEGER,
  diagnostic_json TEXT,
  content_sha256 TEXT NOT NULL,
  is_error INTEGER NOT NULL DEFAULT 0,
  body_class TEXT NOT NULL DEFAULT 'normal',
  body_purged_at TEXT,
  UNIQUE(user_id, install_id, event_id));
-- 正文到期清理后，「这一条我们什么时候第一次收到、内容指纹是什么」必须还能回答，
-- 否则同一事件重传会被当成新记录复活，过期窗口也守不住。收据与正文是两套生命周期。
CREATE TABLE IF NOT EXISTS log_receipts(
  user_id INTEGER NOT NULL,
  install_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  first_received_at TEXT NOT NULL,
  body_class TEXT NOT NULL DEFAULT 'normal',
  PRIMARY KEY(user_id, install_id, event_id));
CREATE TABLE IF NOT EXISTS log_conflicts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  install_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS admin_audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_username TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS backups(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  size_bytes INTEGER,
  sha256 TEXT,
  remote TEXT,
  detail TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS auth_throttle(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  locked_until TEXT,
  UNIQUE(scope,key));
-- 日志通道的分钟级准入计数：请求数、事件数、字节数分开统计，
-- 单靠请求条数拦不住「一次塞满字节」的那种超量。
CREATE TABLE IF NOT EXISTS log_budget(
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  events INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(scope,key,window_start));
CREATE INDEX IF NOT EXISTS run_logs_occurred_at_idx ON run_logs(occurred_at);
CREATE INDEX IF NOT EXISTS run_logs_user_idx ON run_logs(user_id);
CREATE INDEX IF NOT EXISTS run_logs_trace_idx ON run_logs(trace_id);
CREATE INDEX IF NOT EXISTS run_logs_level_idx ON run_logs(level);
CREATE INDEX IF NOT EXISTS run_logs_error_code_idx ON run_logs(error_code);
CREATE INDEX IF NOT EXISTS software_sessions_expires_idx ON software_sessions(expires_at);
`;

function ensurePrivateDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE }); } catch { /* best effort */ }
  try { fs.chmodSync(dir, DIR_MODE); } catch { /* windows or foreign fs */ }
}

export function openStore({ file = ':memory:', createDirectory = true } = {}) {
  if (file !== ':memory:') {
    ensurePrivateDir(path.dirname(file));
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  // 旧库里 run_logs 已经存在，CREATE TABLE IF NOT EXISTS 不会补列；不迁移的话
  // 新写入的 outcome_state/attempted/body_class 会直接报错，或者被当成「没有这一栏」。
  db.exec(SCHEMA);
  // Additive migration for refresh lineage. Existing refresh rows remain valid
  // roots; no historical token is assigned a synthetic parent or rotation.
  const refreshColumns = new Set(db.prepare('PRAGMA table_info(refresh_tokens)').all().map(c => c.name));
  for (const [name, ddl] of [['parent_id', 'ALTER TABLE refresh_tokens ADD COLUMN parent_id INTEGER'],
    ['rotation_id', 'ALTER TABLE refresh_tokens ADD COLUMN rotation_id TEXT']]) {
    if (!refreshColumns.has(name)) db.exec(ddl);
  }
  db.exec('CREATE INDEX IF NOT EXISTS refresh_tokens_parent_idx ON refresh_tokens(parent_id);');
  const columns = new Set(db.prepare('PRAGMA table_info(run_logs)').all().map(c => c.name));
  for (const [name, ddl] of [
    ['outcome_state', 'ALTER TABLE run_logs ADD COLUMN outcome_state TEXT'],
    ['attempted', 'ALTER TABLE run_logs ADD COLUMN attempted INTEGER'],
    ['body_class', "ALTER TABLE run_logs ADD COLUMN body_class TEXT NOT NULL DEFAULT 'normal'"],
    ['body_purged_at', 'ALTER TABLE run_logs ADD COLUMN body_purged_at TEXT'],
  ]) {
    if (!columns.has(name)) db.exec(ddl);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS run_logs_received_at_idx ON run_logs(received_at);
    CREATE INDEX IF NOT EXISTS run_logs_purge_idx ON run_logs(body_class, received_at, id);
    CREATE INDEX IF NOT EXISTS log_receipts_received_idx ON log_receipts(first_received_at, occurred_at)`);
  if (file !== ':memory:') {
    try { fs.chmodSync(file, FILE_MODE); } catch { /* ignore */ }
    for (const suffix of ['-wal', '-shm']) {
      try { fs.chmodSync(file + suffix, FILE_MODE); } catch { /* ignore */ }
    }
  }

  const run = (sql, ...values) => db.prepare(sql).run(...values);
  const get = (sql, ...values) => db.prepare(sql).get(...values);
  const all = (sql, ...values) => db.prepare(sql).all(...values);
  const exec = sql => db.exec(sql);
  function transaction(callback) {
    db.exec('BEGIN IMMEDIATE');
    try { const value = callback(); db.exec('COMMIT'); return value; }
    catch (error) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw error; }
  }
  const nowIso = () => new Date().toISOString();

  return { db, run, get, all, exec, transaction, nowIso, file };
}
