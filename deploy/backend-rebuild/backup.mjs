import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const service = 'wujinxia-backend-cloud';
const dbFile = '/var/lib/' + service + '/wujinxia-backend-cloud.db';
const root = '/var/backups/' + service;
const keyFile = '/etc/' + service + '/backup.key';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const snapshot = path.join(root, service + '-' + stamp + '.db');
const restored = snapshot + '.restore';
const output = snapshot + '.enc';
const key = fs.readFileSync(keyFile);
if (key.length !== 32 || (fs.statSync(keyFile).mode & 0o077)) throw new Error('Backup key protection invalid');
const live = new DatabaseSync(dbFile, { readOnly: true });
try { live.prepare('VACUUM INTO ?').run(snapshot); } finally { live.close(); }
fs.chmodSync(snapshot, 0o600);
let plain;
try {
  const db = new DatabaseSync(snapshot, { readOnly: true });
  try { if (Object.values(db.prepare('PRAGMA integrity_check').get())[0] !== 'ok') throw new Error('Snapshot integrity failed'); } finally { db.close(); }
  plain = fs.readFileSync(snapshot);
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const envelope = { service, createdAt: new Date().toISOString(), sha256: hash(plain),
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  fs.writeFileSync(output, JSON.stringify(envelope) + '\n', { mode: 0o600, flag: 'wx' });
  const saved = JSON.parse(fs.readFileSync(output, 'utf8'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(saved.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(saved.tag, 'base64'));
  const recovered = Buffer.concat([decipher.update(Buffer.from(saved.data, 'base64')), decipher.final()]);
  try {
    if (hash(recovered) !== saved.sha256) throw new Error('Encrypted backup digest failed');
    fs.writeFileSync(restored, recovered, { mode: 0o600, flag: 'wx' });
    const check = new DatabaseSync(restored, { readOnly: true });
    try { if (Object.values(check.prepare('PRAGMA integrity_check').get())[0] !== 'ok') throw new Error('Restore integrity failed'); } finally { check.close(); }
  } finally { recovered.fill(0); }
  const result = { ok: true, service, createdAt: envelope.createdAt, encryptedFile: output,
    sizeBytes: fs.statSync(output).size, sha256: hash(fs.readFileSync(output)), restoreIntegrity: 'ok', offsite: false };
  const ledger = new DatabaseSync(dbFile);
  try { ledger.prepare('INSERT INTO backups(at,ok,size_bytes,sha256,remote,detail) VALUES(?,1,?,?,?,?)').run(
    result.createdAt, result.sizeBytes, result.sha256, output, 'independent local encrypted backup; decrypted restore integrity ok; offsite not configured'); } finally { ledger.close(); }
  fs.writeFileSync(path.join(root, 'last-result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result));
} finally {
  key.fill(0); plain?.fill(0);
  for (const file of [snapshot, restored]) if (fs.existsSync(file)) fs.unlinkSync(file);
}
