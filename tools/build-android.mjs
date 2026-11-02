// Portable Android build. Only the runtime import closure enters the APK.
import fs from 'node:fs';
import path from 'node:path';
import buildCrypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { androidEngineFiles, androidPayloadProblems, androidRebuildGraph, REBUILD_BUILD_ID_TOKEN, REBUILD_APPLICATION_ID } from './android-payload.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = root;
const tools = path.join(root, '.runtime', 'android-toolchain');
const args = new Set(process.argv.slice(2));
const stageOnly = args.has('--stage-only');
const stageRoot = path.join(root, '.runtime');
const stageOption = process.argv.slice(2).find(one => one.startsWith('--stage-dir='));
const stage = stageOption ? path.resolve(root, stageOption.slice('--stage-dir='.length)) : path.join(stageRoot, 'android-engine');
const stageRelative = path.relative(stageRoot, stage);
if (stageRelative === '..' || stageRelative.startsWith('..' + path.sep) || path.isAbsolute(stageRelative) || !stageRelative) {
  throw new Error('Android stage directory must stay inside .runtime.');
}
// Keep accepting --backend-rebuild for existing invocations. This project now has
// one Android runtime: the isolated rebuilt backend; the reference server is not a build target.
const cloudUrlOption = process.argv.slice(2).find(one => one.startsWith('--cloud-url='));
const cloudUrl = cloudUrlOption === undefined ? '' : cloudUrlOption.slice('--cloud-url='.length).trim();
if (!cloudUrlOption || !cloudUrl) throw new Error('The rebuilt backend requires an explicit --cloud-url=https://<independent-new-cloud>.');
let parsedCloud;
try { parsedCloud = new URL(cloudUrl); } catch { throw new Error('Invalid rebuilt-backend cloud URL.'); }
const cloudHost = parsedCloud.hostname.toLowerCase().replace(/\.$/, '');
const cloudPath = parsedCloud.pathname.replace(/\/+$/, '');
if (parsedCloud.protocol !== 'https:' || parsedCloud.username || parsedCloud.password || parsedCloud.search || parsedCloud.hash
  || cloudHost === 'wujinxia.ainiannian.online'
  || (cloudHost === 'wujinxia01.ainiannian.online' && cloudPath !== '/backend-v2')) {
  throw new Error('The rebuilt backend requires a separate HTTPS cloud entry without URL credentials, query or fragment.');
}
function execute(command, argv, options = {}) {
  const result = spawnSync(command, argv, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(path.basename(command) + ' failed: ' + result.status);
}
function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); }
function cleanStage(relative) {
  const target = path.resolve(stage, relative);
  const withinStage = path.relative(stage, target);
  if (!withinStage || withinStage.startsWith('..') || path.isAbsolute(withinStage)) throw new Error('Unsafe build-stage cleanup target.');
  if (fs.existsSync(target)) {
    const physical = path.relative(fs.realpathSync(stage), fs.realpathSync(target));
    if (!physical || physical === '..' || physical.startsWith('..' + path.sep) || path.isAbsolute(physical)) {
      throw new Error('Build-stage cleanup follows a link outside its intended directory.');
    }
  }
  fs.rmSync(target, { recursive: true, force: true });
}

const androidAbis = ['arm64-v8a', 'x86_64'];
const digestOf = file => buildCrypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function verifyRecordedFile(record, file) {
  if (!record || !/^[a-f0-9]{64}$/.test(record.sha256 || '') || !fs.statSync(file).isFile()
    || fs.statSync(file).size !== record.bytes || digestOf(file) !== record.sha256) {
    throw new Error('Native SQLite source or artifact fingerprint does not match its build manifest.');
  }
}
function verifyRecordedTree(record, directory) {
  if (!Array.isArray(record?.files) || record.files.length !== record.fileCount || !record.files.length) {
    throw new Error('Native SQLite input tree fingerprint is missing.');
  }
  for (const file of record.files) {
    if (typeof file.relativePath !== 'string' || !file.relativePath) throw new Error('Invalid native SQLite input path.');
    const target = path.resolve(directory, file.relativePath);
    const relative = path.relative(directory, target);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Native SQLite input path leaves its source directory.');
    verifyRecordedFile(file, target);
  }
}
function verifyNativeSqliteBuild() {
  const file = path.join(root, '.runtime/native-sqlite/build-manifest.json');
  const native = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (native.schemaVersion !== 1 || native.napiVersion !== 8 || native.apiLevel !== 26
    || native.inputs?.archives?.sqlite?.version !== '3.54.1' || !Array.isArray(native.builds)) {
    throw new Error('Native SQLite build manifest has an incompatible contract.');
  }
  verifyRecordedFile(native.inputs.addonSource, path.join(root, 'native/sqlite/garden_sqlite.c'));
  verifyRecordedFile(native.inputs.buildScript, path.join(root, 'tools/build-native-sqlite.mjs'));
  verifyRecordedTree(native.inputs.nodeHeaders, path.join(tools, 'nodejs-mobile-v18.20.4/include/node'));
  verifyRecordedTree(native.inputs.sqliteSources, path.join(root, '.runtime/native-sqlite/sources/sqlite-amalgamation-3540100'));
  const libraries = androidAbis.map(abi => {
    const matches = native.builds.filter(build => build.abi === abi);
    if (matches.length !== 1) throw new Error('Native SQLite build manifest must contain both Android ABIs exactly once.');
    const built = matches[0], checks = built.checks;
    const machine = abi === 'arm64-v8a' ? 'AArch64' : 'Advanced Micro Devices X86-64';
    if (!checks || checks.machine !== machine || checks.napiVersion !== 8 || checks.minimumLoadAlignment < 16384
      || !['elf64', 'noExternalSqlite', 'noCppRuntime', 'noTextRelocations', 'noHostRpath', 'nonExecutableStack'].every(key => checks[key] === true)
      || checks.registration !== 'napi_register_module_v1'
      || !Array.isArray(checks.dependencies) || !checks.dependencies.includes('libnode.so')
      || checks.dependencies.some(name => !['libnode.so', 'libm.so', 'libdl.so', 'libc.so'].includes(name))
      || !Array.isArray(checks.searchPaths) || checks.searchPaths.length !== 1 || checks.searchPaths[0] !== '$ORIGIN') {
      throw new Error('Native SQLite ELF static gate is incomplete.');
    }
    const source = path.join(root, '.runtime/native-sqlite/build', abi, 'garden_sqlite.node');
    verifyRecordedFile(built.output, source);
    verifyRecordedFile(native.inputs['libnode_' + abi], path.join(tools, 'nodejs-mobile-v18.20.4/bin', abi, 'libnode.so'));
    return { abi, source, file: 'lib/' + abi + '/libgarden_sqlite.so', bytes: fs.statSync(source).size,
      sha256: digestOf(source), driver: 'garden-sqlite-napi-v1', sqliteVersion: '3.54.1', napiVersion: 8 };
  });
  return { libraries, manifestSha256: digestOf(file) };
}
let nativeSqliteBuild = null;
if (!stageOnly) {
  try { nativeSqliteBuild = verifyNativeSqliteBuild(); }
  catch {
    console.log('Preparing native SQLite from the pinned source build; no addon or database execution.');
    execute(process.execPath, [path.join(root, 'tools/build-native-sqlite.mjs')]);
    nativeSqliteBuild = verifyNativeSqliteBuild();
  }
}
const nativeLibraries = stageOnly ? [] : androidAbis.flatMap(abi => {
  const dependencies = [
    { name: 'libnode.so', source: path.join(tools, 'nodejs-mobile-v18.20.4/bin', abi, 'libnode.so') },
    { name: 'libc++_shared.so', source: path.join(tools, 'ndk-r24-cxx', abi, 'libc++_shared.so') },
  ].map(({ name, source }) => ({ abi, source, file: 'lib/' + abi + '/' + name,
    bytes: fs.statSync(source).size, sha256: digestOf(source) }));
  return [...dependencies, ...(nativeSqliteBuild?.libraries.filter(library => library.abi === abi) || [])];
});

fs.mkdirSync(stageRoot, { recursive: true });
const physicalRoot = fs.realpathSync(root);
const physicalStageRoot = fs.realpathSync(stageRoot);
const physicalRuntimeRelative = path.relative(physicalRoot, physicalStageRoot);
if (!physicalRuntimeRelative || physicalRuntimeRelative === '..' || physicalRuntimeRelative.startsWith('..' + path.sep) || path.isAbsolute(physicalRuntimeRelative)) {
  throw new Error('Android .runtime directory must resolve inside the repository.');
}
fs.mkdirSync(stage, { recursive: true });
const physicalStage = fs.realpathSync(stage);
const physicalStageRelative = path.relative(physicalStageRoot, physicalStage);
if (!physicalStageRelative || physicalStageRelative === '..' || physicalStageRelative.startsWith('..' + path.sep) || path.isAbsolute(physicalStageRelative)) {
  throw new Error('Android stage directory must resolve inside .runtime.');
}
const manifest = {
  name: 'garden-android-engine', version: '0.1.0', private: true, type: 'module',
  dependencies: { 'https-proxy-agent': '7.0.6', ws: '8.21.3' },
};
const stagedPackagePath = path.join(stage, 'package.json'), stagedLockPath = path.join(stage, 'package-lock.json');
const previousPackage = fs.existsSync(stagedPackagePath) ? JSON.parse(fs.readFileSync(stagedPackagePath, 'utf8')) : null;
const previousLock = fs.existsSync(stagedLockPath) ? JSON.parse(fs.readFileSync(stagedLockPath, 'utf8')) : null;
function sameDependencyContract(actual, expected) {
  return actual && Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([name, version]) => actual[name] === version);
}
if (args.has('--skip-npm') && (!sameDependencyContract(previousPackage?.dependencies, manifest.dependencies) ||
    !sameDependencyContract(previousLock?.packages?.['']?.dependencies, manifest.dependencies))) {
  throw new Error('Cannot skip npm when the staged dependency contract is missing or stale; rebuild without --skip-npm to prune obsolete packages.');
}
write(stagedPackagePath, JSON.stringify(manifest, null, 2) + '\n');
const rebuildGraph = androidRebuildGraph(root);
const engineFiles = androidEngineFiles(root);
cleanStage('server/src');
cleanStage('server/data');
cleanStage('android');
cleanStage('config');
cleanStage('node_modules/sql.js');
const stagedTargets = new Map(rebuildGraph.map(item => [item.source, item.target]));
const staticImport = /(?:^|\n)[ \t]*(?:import\s[^'";]*?from|import|export\s[^'";]*?from|require\s*\()\s*['"]([^'"]+)['"]/g;
const dynamicImport = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
for (const item of rebuildGraph) {
  if (!/\.(?:mjs|js|cjs)$/.test(item.source)) { copy(item.source, path.join(stage, item.target)); continue; }
  let source = fs.readFileSync(item.source, 'utf8');
  const rewrite = (statement, spec) => {
    const dependency = item.dependencies.find(one => one.spec === spec && !one.engineLoader);
    if (!dependency) return statement;
    const target = stagedTargets.get(dependency.source);
    if (!target) throw new Error('No staged destination for a rebuild import.');
    let relative = path.posix.relative(path.posix.dirname(item.target), target);
    if (!relative.startsWith('.')) relative = './' + relative;
    return statement.replace(/(['"])([^'"]+)\1$/, (_whole, quote) => quote + relative + quote)
      .replace(/(['"])([^'"]+)\1(\s*\))$/, (_whole, quote, _spec, suffix) => quote + relative + quote + suffix);
  };
  source = source.replace(staticImport, rewrite).replace(dynamicImport, rewrite);
  write(path.join(stage, item.target), source);
}
write(path.join(stage, 'android/server.mjs'), "// Android native entry for the rebuilt backend.\nimport './backend/server.mjs';\n");
console.log('Engine payload: ' + engineFiles.length + ' files reachable from the Android runtime; the rest of the imported snapshot stays out of the APK.');
// 换皮批次会新增和替换 ui 素材，而 cpSync 是合并复制：旧主题素材会留在 engine.zip 里。
// 这个删除只针对 .runtime/android-engine/ui/ 这一份构建暂存，不碰设备资料与数据库。
cleanStage('ui');
copy(path.join(project, 'ui'), path.join(stage, 'ui'));
for (const name of ['flowers.json', 'recipes.json', 'gs-arg-schemas.json', 'gs-ds-schemas.json', 'gs-wire-methods.json', 'land-layout-evidence.json', 'official-cfg']) {
  copy(path.join(root, 'vendor/garden-engine/server/data', name), path.join(stage, 'server/data', name));
}
// Node Mobile v18 has no node:sqlite. Adapt every reached storage import,
// including new backend persistence modules, to the audited Android driver.
function adaptSqlite(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { adaptSqlite(file); continue; }
    if (!/\.(?:mjs|js|cjs)$/.test(entry.name)) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (!/['"]node:sqlite['"]/.test(source)) continue;
    let relative = path.relative(path.dirname(file), path.join(stage, 'android', 'sqlite-native.mjs')).split(path.sep).join('/');
    if (!relative.startsWith('.')) relative = './' + relative;
    write(file, source.replace(/(['"])node:sqlite\1/g, (_whole, quote) => quote + relative + quote));
  }
}
adaptSqlite(stage);

if (!stageOnly && !args.has('--skip-npm')) {
  // Each release uses a fresh stage. Resolve and save the exact dependency tree,
  // then install that tree with npm ci before computing the payload identity.
  const packageManager = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm';
  const npmArgs = process.platform === 'win32' ? ['/d', '/c'] : [];
  const invokeNpm = (args, options) => process.platform === 'win32'
    ? execute(packageManager, [...npmArgs, 'npm.cmd', ...args], options)
    : execute(packageManager, args, options);
  invokeNpm(['install', '--package-lock-only', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage });
  invokeNpm(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage });
}

/* 〔2026-10-19〕本次构建的无秘密标识：按**注入前**的暂存资源（稳定相对路径＋实际摘要）算一个 buildId，
   再把它分别烙进引擎与界面的实际执行入口——运行标记必须各自来自那份真被加载的代码；
   旧 JS 读到磁盘上的新 JSON 也不算新版，所以不靠清单、靠代码里烙着的那一串。
   清单在注入之后生成，只用于设备文件对平，不参与标识计算（避免自引用）。 */
function walk(directory, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, path.join(prefix, entry.name)));
    else out.push({ file: path.join(prefix, entry.name).split(path.sep).join('/'), bytes: fs.statSync(full).size, sha256: digestOf(full) });
  }
  return out;
}
const preInjectFiles = walk(stage);
// Bind the APK identity to the native Android sources and build wiring as well as
// the generated engine payload. Keep this list deliberately narrow: assets/engine.zip,
// jniLibs and private SDK configuration are generated/private inputs, not source inputs.
function collectNativeSourceInputs(relativePath, optional = false) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    if (optional) return [];
    throw new Error('Required Android build source is missing: ' + relativePath);
  }
  const stat = fs.lstatSync(absolutePath);
  if (stat.isSymbolicLink()) throw new Error('Unexpected symlink in Android build source: ' + relativePath);
  if (stat.isDirectory()) {
    return fs.readdirSync(absolutePath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .flatMap(entry => collectNativeSourceInputs(path.posix.join(relativePath.replaceAll('\\', '/'), entry.name)));
  }
  return [{ file: relativePath.replaceAll('\\', '/'), bytes: stat.size, sha256: digestOf(absolutePath) }];
}
const nativeSourceInputs = [
  ...collectNativeSourceInputs('app/src/main/java'),
  ...collectNativeSourceInputs('app/src/main/res'),
  ...[
    'app/src/main/AndroidManifest.xml', 'app/build.gradle', 'build.gradle',
    'settings.gradle', 'gradle.properties', 'tools/build-android.mjs', 'tools/android-payload.mjs',
  ].flatMap(file => collectNativeSourceInputs(file)),
].sort((left, right) => left.file.localeCompare(right.file));
const buildId = buildCrypto.createHash('sha256')
  .update(preInjectFiles.map(one => one.file + '\u0000' + one.sha256).join('\n'))
  .update('\nnative-libraries\n' + nativeLibraries.map(one => one.file + '\u0000' + one.sha256).sort().join('\n'))
  .update('\nnative-source-inputs\n' + nativeSourceInputs.map(one => one.file + '\u0000' + one.sha256).join('\n'))
  .digest('hex').slice(0, 16);
// 烙进引擎实际加载的那份模块：构建标识写进引擎侧的 android-auth.js，运行中的进程报的就是它自己导入的值。
// （不写进 runtime/*.mjs——那几个文件必须与源码逐字节一致，本机检查靠摘要对平证明跑的是本轮代码。）
const marker = path.join(stage, 'android/backend/build-info.mjs');
if (!fs.existsSync(marker)) throw new Error('Rebuild composition root must import backend/build-info.mjs.');
const markerSource = fs.readFileSync(marker, 'utf8');
if (markerSource.split(REBUILD_BUILD_ID_TOKEN).length !== 2) throw new Error('Rebuild build-info.mjs must contain exactly one build-id placeholder.');
write(marker, markerSource.replace(REBUILD_BUILD_ID_TOKEN, buildId));
// 烙进界面入口：WebView 加载的就是这一份 app.js，屏上那串来自它自己。
const uiEntry = path.join(stage, 'ui/app.js');
const uiSource = fs.readFileSync(uiEntry, 'utf8');
const uiToken = 'GARDEN_CLIENT_BUILD_ID_PLACEHOLDER';
if (uiSource.split(uiToken).length !== 2) throw new Error('界面构建标识注入点变了，先核对 ui/app.js 的 CLIENT_BUILD_ID');
write(uiEntry, uiSource.replace(uiToken, buildId));
console.log('Build id ' + buildId + ' baked into the engine entry and the panel entry (' + preInjectFiles.length + ' staged inputs).');

const payloadProblems = androidPayloadProblems(root, stage).problems;
if (payloadProblems.length) {
  throw new Error('Android payload isolation gate failed (' + payloadProblems.length + ' problems):\n' + payloadProblems.slice(0, 20).join('\n'));
}
console.log('Android payload isolation gate: no reference-project server code or endpoints, every staged import resolves.');
if (stageOnly) {
  console.log('Stage-only complete; no APK assets, native libraries, Gradle output, or device installation were produced.');
  process.exit(0);
}

for (const [name, version] of Object.entries(manifest.dependencies)) {
  const installedManifest = path.join(stage, 'node_modules', name, 'package.json');
  if (!fs.existsSync(installedManifest) || JSON.parse(fs.readFileSync(installedManifest, 'utf8')).version !== version) {
    throw new Error('Pinned Android dependency is missing or changed: ' + name + '. Build again without --skip-npm.');
  }
}
// Refuse stale or accidental production assets before making an archive.
function inspect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Unexpected symlink in Android payload: ' + entry.name);
    if (entry.isDirectory()) inspect(full);
    else if (/garden\.db|\.env$|credential-key|android_session|android_device_profile|\.pem$|\.key$/i.test(entry.name))
      throw new Error('Private file must not enter APK: ' + entry.name);
  }
}
inspect(stage);
// 设备文件对平清单：注入后的最终摘要（清单不参与标识计算，避免自引用）。
const finalFiles = walk(stage);
write(path.join(root, '.runtime/android-build/manifest.json'), JSON.stringify({
  buildId, cloudUrlDefault: cloudUrl, backendRebuild: true,
  applicationId: REBUILD_APPLICATION_ID,
  generatedAt: new Date().toISOString(), engineFiles: engineFiles.length,
  nativeSourceInputs,
  nativeLibraries: nativeLibraries.map(({ source, ...library }) => library),
  ...(nativeSqliteBuild ? { nativeSqliteBuildManifestSha256: nativeSqliteBuild.manifestSha256 } : {}),
  files: finalFiles.map(one => ({ file: one.file, bytes: one.bytes, sha256: one.sha256 })),
}, null, 2) + '\n');
console.log('Build manifest: ' + finalFiles.length + ' staged files listed for device reconciliation.');
const javaHome = fs.readFileSync(path.join(tools, 'java-home.txt'), 'utf8').trim();
const assets = path.join(project, 'app/src/main/assets'); fs.mkdirSync(assets, { recursive: true });
copy(path.join(root, 'ui/brand/logo-endless-summer.webp'), path.join(assets, 'brand/logo-endless-summer.webp'));
execute(path.join(javaHome, 'bin', 'jar.exe'), ['--create', '--no-manifest', '--file', path.join(assets, 'engine.zip'), '-C', stage, '.']);
for (const abi of androidAbis) {
  const nativeRoot = path.join(project, 'app/src/main/jniLibs', abi);
  for (const library of nativeLibraries.filter(one => one.abi === abi)) {
    const target = path.join(nativeRoot, path.posix.basename(library.file));
    copy(library.source, target);
    if (digestOf(target) !== library.sha256) throw new Error('Staged Android native library fingerprint changed during copying.');
  }
}
write(path.join(project, 'local.properties'), 'sdk.dir=' + path.join(tools, 'sdk').replaceAll('\\', '/') + '\n');
console.log('Android payload prepared; no game accounts or credentials were included.');
if (!args.has('--prepare-only')) {
  const gradle = path.join(tools, 'gradle-8.9/bin/gradle.bat');
  const buildEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GARDEN_'))), JAVA_HOME: javaHome, ANDROID_HOME: path.join(tools, 'sdk'), GRADLE_USER_HOME: path.join(tools, 'gradle-cache') };
  for (const kind of ['STORE', 'KEY']) {
    const name = 'WUJINXIA_REBUILD_' + kind + '_PASSWORD';
    if (!buildEnv[name] && buildEnv[name + '_FILE']) buildEnv[name] = fs.readFileSync(buildEnv[name + '_FILE'], 'utf8').trim();
    if (!buildEnv[name]) throw new Error('Rebuild signing password is missing; use protected environment or password files.');
  }
  const keyStore = buildEnv.WUJINXIA_REBUILD_KEYSTORE;
  if (!keyStore || !fs.existsSync(keyStore) || !buildEnv.WUJINXIA_REBUILD_KEY_ALIAS) throw new Error('Rebuild signing requires a protected existing keystore and alias.');
  // Invoke the known batch executable with shell handling; all paths remain separate arguments.
  const gradleArgs = ['--no-daemon', ':app:assembleDebug'];
  if (cloudUrl) gradleArgs.push('-PcloudUrl=' + cloudUrl);
  if (cloudUrl) console.log('Cloud default baked for this build: ' + cloudUrl);
  const result = spawnSync(gradle, gradleArgs, { cwd: project, env: buildEnv, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('APK build failed: ' + result.status);
  const artifact = path.join(project, 'app/build/outputs/apk/debug/app-debug.apk');
  const output = path.join(root, '.runtime/android-output', 'garden-backend-rebuild-debug.apk');
  copy(artifact, output);
  console.log('APK: ' + output);
}
