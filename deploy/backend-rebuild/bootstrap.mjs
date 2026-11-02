import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function bootstrapAdmin(release, env) {
  const passwordFile = '/root/wujinxia-backend-cloud-admin.txt';
  if (fs.existsSync(passwordFile)) throw new Error('New cloud administrator source already exists; inspect provenance before retrying.');
  const password = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(passwordFile, password + '\n', { mode: 0o600, flag: 'wx' });
  const result = spawnSync(process.execPath, [release + '/cloud/cli.mjs', 'create-admin', '--username', 'backend-admin'], {
    env: { ...process.env, ...env }, input: password + '\n', encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error('New cloud administrator bootstrap failed; protected source retained at ' + passwordFile);
  return { username: 'backend-admin', passwordFile, created: true };
}
