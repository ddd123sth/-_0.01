// Windows developer entry: prepare local tools and a private signing key, then build.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log('node tools/build-local.mjs [--cloud-url=https://your-cloud/path] [--setup-only]');
  process.exit(0);
}
if (process.platform !== 'win32') throw new Error('Android build currently supports Windows x64.');
if (argv.some(arg => arg !== '--setup-only' && !arg.startsWith('--cloud-url='))) throw new Error('Unknown build option.');
const cloudUrl = argv.find(arg => arg.startsWith('--cloud-url='))?.slice(12)
  || 'https://wujinxia01.ainiannian.online/backend-v2';
const parsed = new URL(cloudUrl);
if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Use an HTTPS cloud URL without credentials.');
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status}).`);
}
for (const command of ['pwsh', 'python']) {
  const check = spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (check.error || check.status !== 0) throw new Error(`Install ${command} and add it to PATH first (see README.md).`);
}
const tools = path.join(root, '.runtime/android-toolchain');
const components = {
  Jdk: 'java-home.txt', Gradle: 'gradle-8.9/bin/gradle.bat',
  Sdk: 'sdk/platforms/android-35/source.properties',
  Node: 'nodejs-mobile-v18.20.4/bin/arm64-v8a/libnode.so',
  Cxx: 'ndk-r24-cxx/arm64-v8a/libc++_shared.so',
};
for (const [component, marker] of Object.entries(components)) {
  if (!fs.existsSync(path.join(tools, marker))) {
    run('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'tools/android-toolchain.ps1', '-Component', component]);
  }
}
run(process.execPath, ['tools/backend-cloud-deploy.mjs', '--prepare-keys']);
if (argv.includes('--setup-only')) process.exit(0);
const signing = JSON.parse(fs.readFileSync(path.join(root, '.runtime/backend-rebuild/signing-manifest.json'), 'utf8'));
run(process.execPath, ['tools/build-android.mjs', '--backend-rebuild', `--cloud-url=${cloudUrl}`], {
  ...process.env,
  WUJINXIA_REBUILD_KEYSTORE: signing.keystore,
  WUJINXIA_REBUILD_KEY_ALIAS: signing.alias,
  WUJINXIA_REBUILD_STORE_PASSWORD_FILE: signing.storePasswordFile,
  WUJINXIA_REBUILD_KEY_PASSWORD_FILE: signing.keyPasswordFile,
});
