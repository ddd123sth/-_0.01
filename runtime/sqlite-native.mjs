// Android native SQLite adapter. The addon is installed as an APK jni library,
// never loaded from a writable engine archive or replaced by an in-memory VFS.
import fs from 'node:fs';
import path from 'node:path';
import { timedSQLiteCall } from './performance-diagnostics.mjs';

const nativeDirectory = process.env.GARDEN_NATIVE_LIBRARY_DIR;
if (!nativeDirectory || !path.isAbsolute(nativeDirectory)) {
  throw Object.assign(new Error('Android native SQLite library directory is unavailable'), { code: 'NATIVE_SQLITE_LIBRARY_REQUIRED', status: 503 });
}
let nativePath;
const nativeModule = { exports: {} };
try {
  nativePath = path.join(fs.realpathSync(nativeDirectory), 'libgarden_sqlite.so');
  if (!fs.statSync(nativePath).isFile()) throw new Error('Native SQLite library is missing');
  process.dlopen(nativeModule, nativePath);
} catch {
  // Loader errors can include installer paths. Keep the external failure fixed.
  throw Object.assign(new Error('Android native SQLite library could not be loaded'), { code: 'NATIVE_SQLITE_LIBRARY_REQUIRED', status: 503 });
}
const binding = nativeModule.exports;
if (binding.napiVersion !== 8 || binding.sqliteVersion !== '3.54.1' || typeof binding.sqliteSourceId !== 'string' ||
    !['open', 'close', 'exec', 'query'].every(key => typeof binding[key] === 'function')) {
  throw Object.assign(new Error('Android native SQLite binding has an incompatible interface'), { code: 'NATIVE_SQLITE_BINDING_INVALID', status: 503 });
}
export const nativeSQLiteInfo = Object.freeze({ driver: 'garden-sqlite-napi-v1', napiVersion: binding.napiVersion,
  sqliteVersion: binding.sqliteVersion, sqliteSourceId: binding.sqliteSourceId, library: nativePath });

const parameters = args => args.length === 1 && (Array.isArray(args[0]) || args[0] && typeof args[0] === 'object' && !ArrayBuffer.isView(args[0]))
  ? args[0] : args;

export class DatabaseSync {
  #handle;
  #closed = false;
  #failed = null;
  #databaseMode;
  constructor(filename, options = {}) {
    if (typeof filename !== 'string' || !filename || filename.includes('\0') || filename !== ':memory:' && !path.isAbsolute(filename)) {
      throw new TypeError('SQLite filename requires an explicit absolute path');
    }
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('SQLite options must be an object');
    if (options.readOnly !== undefined && typeof options.readOnly !== 'boolean') throw new TypeError('SQLite readOnly must be a boolean');
    const readOnly = options.readOnly === true;
    this.#databaseMode = readOnly ? 'read-only' : 'read-write';
    if (filename !== ':memory:' && !readOnly) fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.#handle = binding.open(filename, readOnly);
  }
  #check() {
    if (this.#closed) throw Object.assign(new Error('SQLite database is closed'), { code: 'ERR_SQLITE_CLOSED' });
    if (this.#failed) throw Object.assign(new Error('SQLite persistence failed; restart required', { cause: this.#failed }),
      { code: 'ERR_SQLITE_PERSISTENCE_FAILED', errcode: this.#failed.errcode });
  }
  #call(callback) {
    this.#check();
    try { return callback(); }
    catch (error) {
      // Also cover raw db.exec/prepare callers outside store.guarded. Fatal
      // SQLite durability/read-image errors cannot be followed by decisions on
      // an assumed committed image. close() remains available for cleanup.
      if ([7, 10, 11, 13, 26].includes(Number(error.errcode) & 0xff) || error.code === 'ERR_NATIVE_SQLITE_NAPI') this.#failed = error;
      throw error;
    }
  }
  exec(sql) {
    return this.#call(() => timedSQLiteCall({ sql, kind: 'exec', mode: 'exec', databaseMode: this.#databaseMode },
      () => binding.exec(this.#handle, sql)));
  }
  prepare(sql) {
    this.#check();
    if (typeof sql !== 'string') throw new TypeError('SQLite SQL must be text');
    const execute = (mode, args) => this.#call(() => timedSQLiteCall({ sql, kind: 'query',
      mode: ['run', 'get', 'all'][mode] || 'unknown', databaseMode: this.#databaseMode,
      rowCount: result => mode === 2 ? Array.isArray(result) ? result.length : null : mode === 1 ? result == null ? 0 : 1 : null },
    () => binding.query(this.#handle, sql, parameters(args), mode)));
    return Object.freeze({ run: (...args) => execute(0, args), get: (...args) => execute(1, args), all: (...args) => execute(2, args) });
  }
  close() { if (this.#closed) return; binding.close(this.#handle); this.#closed = true; }
  statementCacheStats() {
    this.#check();
    return typeof binding.statementCacheInfo === 'function' ? binding.statementCacheInfo(this.#handle) : null;
  }
}
