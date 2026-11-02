// Local development service, bound to loopback with a separate local database.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = spawnSync(process.execPath, ['tools/build-admin.mjs'], { cwd: root, stdio: 'inherit', windowsHide: true });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status || 1);
const server = spawnSync(process.execPath, ['cloud/server.mjs'], {
  cwd: root, stdio: 'inherit', windowsHide: true,
  env: { ...process.env, WUJINXIA_BIND: '127.0.0.1', WUJINXIA_PORT: process.env.WUJINXIA_PORT || '8092' },
});
if (server.error) throw server.error;
process.exit(server.status || 0);
