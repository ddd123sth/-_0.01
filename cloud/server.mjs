// Production entry point. Guards the Node 22 sqlite requirement, then starts the API.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';

// The release is switched by a `current` symlink, so the entry path and this module's
// URL only match after both are resolved to their real paths.
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(entry)); }
  catch { return import.meta.url === pathToFileURL(path.resolve(entry)).href; }
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(`云服务启动失败：${error?.message || '配置不正确'}\n`);
    process.exit(1);
  }

  try {
    await import('node:sqlite');
  } catch {
    process.stderr.write('云服务启动失败：当前 Node.js 没有内置 node:sqlite 模块。请升级到 Node 22.13 及以上，或以 --experimental-sqlite 运行后再试。\n');
    process.exit(1);
  }

  // Import only after the guard so a missing sqlite module cannot crash the loader first.
  const { startServer } = await import('./app.mjs');

  try {
    const running = await startServer(config);
    const address = running.address;
    const shownHost = address.address === '::1' ? '[::1]' : address.address;
    process.stdout.write(`WUJINXIA_CLOUD_READY http://${shownHost}:${address.port}\n`);
    const shutdown = () => { running.close().finally(() => process.exit(0)); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    process.stderr.write(`云服务启动失败：${error?.message || '无法监听端口'}\n`);
    process.exit(1);
  }
}

if (isMainModule()) main();
