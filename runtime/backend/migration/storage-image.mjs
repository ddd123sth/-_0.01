import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BACKEND_LEDGER_SCHEMA_VERSION } from '../persistence/schema.mjs';

const MARKER = 'storage-image-switch.json';
const RESULT = 'storage-image-switch-result.json';
const STAGE = 'garden-r9-stage.db';
const BACKUP = 'garden-r9-before-image.db';
const cleanupStates = new WeakMap();
const fail = message => { throw Object.assign(new Error(message), { code: 'BACKEND_STORAGE_IMAGE_RECOVERY_REQUIRED' }); };
function identity(file) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('Storage image must be a regular private file');
  const fd = fs.openSync(file, 'r'), bytes = Buffer.alloc(100);
  try { if (fs.readSync(fd, bytes, 0, 100, 0) !== 100) return null; } finally { fs.closeSync(fd); }
  if (bytes.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') return null;
  return { bytes: stat.size, headerHex: bytes.toString('hex') };
}
const same = (actual, expected) => !!actual && !!expected && actual.bytes === expected.bytes && actual.headerHex === expected.headerHex;
function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function save(directory, name, value) {
  const file = path.join(directory, name), temporary = file + '.tmp';
  const fd = fs.openSync(temporary, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file); syncDirectory(directory);
}
function seal(file) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare("SELECT detail_json FROM backend_r9_image_progress WHERE task='seal'").get();
    return row ? JSON.parse(row.detail_json) : null;
  } catch { return null; } finally { db?.close(); }
}

// Runs before the application's first database handle exists. Both rename
// interruption points are recoverable, and a changed original always wins.
export function recoverStorageImage({ dataDir }) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new TypeError('Storage image needs an absolute data directory');
  const marker = path.join(dataDir, MARKER);
  if (!fs.existsSync(marker)) return null;
  const main = path.join(dataDir, 'garden.db'), stage = path.join(dataDir, STAGE), backup = path.join(dataDir, BACKUP);
  let request;
  try {
    if (fs.lstatSync(marker).isSymbolicLink() || fs.statSync(marker).size > 65536) fail('Invalid storage switch marker');
    request = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (request.schema !== 'garden-storage-image-switch/v1' || !/^[a-f0-9-]{36}$/.test(request.imageId || '') ||
        !Number.isSafeInteger(request.original?.bytes) || !Number.isSafeInteger(request.compacted?.bytes) ||
        !/^[a-f0-9]{200}$/.test(request.original?.headerHex || '') || !/^[a-f0-9]{200}$/.test(request.compacted?.headerHex || ''))
      fail('Invalid storage switch descriptor');
  } catch (error) {
    if (!identity(main)) throw error;
    save(dataDir, RESULT, { state: 'rejected', reason: 'INVALID_MARKER', at: new Date().toISOString() });
    fs.unlinkSync(marker); syncDirectory(dataDir); return { state: 'rejected' };
  }
  const finish = state => {
    const result = { ...request, state, backupPending: state === 'activated', at: new Date().toISOString() };
    save(dataDir, RESULT, result); fs.unlinkSync(marker); syncDirectory(dataDir); return result;
  };
  const mainIdentity = identity(main), mainSeal = mainIdentity && seal(main);
  if (mainSeal?.imageId === request.imageId && mainSeal.minimumRuntimeSchema > BACKEND_LEDGER_SCHEMA_VERSION)
    fail('Published storage image requires a newer runtime; all current data and backup remain intact');
  if (mainSeal?.imageId === request.imageId && mainSeal?.proofComplete === true && same(mainSeal.original, request.original))
    return finish('activated');
  if (mainIdentity && !same(mainIdentity, request.original)) return finish('source-changed');
  if (mainIdentity && ['garden.db-wal', 'garden.db-journal'].some(name => {
    const file = path.join(dataDir, name); return fs.existsSync(file) && fs.statSync(file).size > 0;
  })) return finish('source-changed');
  const stagedIdentity = identity(stage), stagedSeal = stagedIdentity && seal(stage);
  if (!same(stagedIdentity, request.compacted) || stagedSeal?.imageId !== request.imageId || stagedSeal.proofComplete !== true ||
      stagedSeal.minimumRuntimeSchema > BACKEND_LEDGER_SCHEMA_VERSION || !same(stagedSeal.original, request.original)) {
    if (!mainIdentity && same(identity(backup), request.original)) { fs.renameSync(backup, main); syncDirectory(dataDir); }
    if (!identity(main)) fail('Neither original nor verified storage image is available');
    return finish('rolled-back');
  }
  // Make the recovery descriptor durable before either filename can disappear.
  const fd = fs.openSync(marker, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(dataDir);
  if (mainIdentity) {
    if (fs.existsSync(backup)) {
      // Do not overwrite the earlier image's backup-exit evidence.
      save(dataDir, 'storage-image-switch-rejection.json', { imageId: request.imageId, reason: 'BACKUP_CONFLICT', at: new Date().toISOString() });
      fs.unlinkSync(marker); syncDirectory(dataDir); return { state: 'backup-conflict' };
    }
    fs.renameSync(main, backup); syncDirectory(dataDir);
  } else if (!same(identity(backup), request.original)) fail('Storage image original backup does not match');
  fs.renameSync(stage, main); syncDirectory(dataDir);
  return finish('activated');
}

// The image builder has already proved every row and its exact decoded bytes,
// FK closure and integrity. Only successful backend initialization calls this;
// authentication/network failures do not require retaining a second giant DB.
export async function retireStorageImageBackup({ dataDir, store }) {
  const state = cleanupStates.get(store) || { active: false, nextAt: 0 };
  cleanupStates.set(store, state);
  if (state.active || Date.now() < state.nextAt) return;
  state.active = true; state.nextAt = Date.now() + 60000;
  try {
    const resultFile = path.join(dataDir, RESULT);
    if (!fs.existsSync(resultFile)) return;
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    if (result.state !== 'activated' || result.backupPending !== true) return;
    const row = store.get("SELECT detail_json FROM backend_r9_image_progress WHERE task='seal'");
    const proof = row && JSON.parse(row.detail_json);
    if (proof?.proofComplete !== true || proof.imageId !== result.imageId || proof.minimumRuntimeSchema > BACKEND_LEDGER_SCHEMA_VERSION || !same(proof.original, result.original)) return;
    const backup = path.join(dataDir, BACKUP), actual = identity(backup);
    if (actual && !same(actual, result.original)) fail('Storage image backup changed; preserve it');
    if (actual) await fs.promises.unlink(backup);
    save(dataDir, RESULT, { ...result, backupPending: false, backupRetiredAt: new Date().toISOString() });
  } finally { state.active = false; }
}
