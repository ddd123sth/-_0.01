import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Preparation/build only: this script never loads the addon or opens a database.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.runtime/native-sqlite');
const downloads = path.join(cache, 'downloads');
const sources = path.join(cache, 'sources');
const ndk = path.join(cache, 'toolchain/android-ndk-r24');
const toolchain = path.join(ndk, 'toolchains/llvm/prebuilt/windows-x86_64');
const nodeMobile = path.join(root, '.runtime/android-toolchain/nodejs-mobile-v18.20.4');
const source = path.join(root, 'native/sqlite/garden_sqlite.c');
const amalgamation = path.join(sources, 'sqlite-amalgamation-3540100');
const versions = Object.freeze({
  ndk: {
    version: '24.0.8215888',
    filename: 'android-ndk-r24-windows.zip',
    url: 'https://dl.google.com/android/repository/android-ndk-r24-windows.zip',
    reference: 'https://github.com/android/ndk/wiki/Unsupported-Downloads',
    bytes: 663076813,
    algorithm: 'sha1',
    digest: '75f9c281c64762d18c84da465f486c60def47829',
  },
  sqlite: {
    version: '3.54.1',
    filename: 'sqlite-amalgamation-3540100.zip',
    url: 'https://www.sqlite.org/2026/sqlite-amalgamation-3540100.zip',
    reference: 'https://www.sqlite.org/download.html',
    bytes: 2990966,
    algorithm: 'sha3-256',
    digest: '92281c86e2957f9b9305890f9ac04204caa7b677cc868dc326d942689df28e30',
  },
});
const targets = Object.freeze({
  'arm64-v8a': { triple: 'aarch64-none-linux-android26', machine: 'AArch64' },
  x86_64: { triple: 'x86_64-none-linux-android26', machine: 'Advanced Micro Devices X86-64' },
});
const definitions = [
  'NAPI_VERSION=8', 'NODE_GYP_MODULE_NAME=garden_sqlite',
  'SQLITE_THREADSAFE=1', 'SQLITE_DQS=0', 'SQLITE_DEFAULT_MEMSTATUS=0',
  'SQLITE_OMIT_LOAD_EXTENSION', 'SQLITE_TEMP_STORE=1', 'SQLITE_DEFAULT_FILE_PERMISSIONS=0600',
];
const flags = ['-std=c11', '-shared', '-fPIC', '-O2', '-fvisibility=hidden',
  '-Wl,--no-undefined', '-Wl,-Bsymbolic', '-Wl,-rpath,$ORIGIN', '-Wl,-z,noexecstack', '-Wl,-z,relro', '-Wl,-z,now',
  '-Wl,-z,max-page-size=16384', '-Wl,-soname,garden_sqlite.node'];

let prepareOnly = false;
let abis = Object.keys(targets);
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--prepare-only') prepareOnly = true;
  else if (arg === '--abi' || arg.startsWith('--abi=')) {
    const value = arg === '--abi' ? process.argv[++i] : arg.slice(6);
    abis = String(value || '').split(',');
    if (!abis.length || abis.some(abi => !Object.hasOwn(targets, abi))) throw new Error('Expected --abi arm64-v8a,x86_64');
    abis = [...new Set(abis)];
  } else if (arg === '--help') {
    console.log('node tools/build-native-sqlite.mjs [--prepare-only] [--abi arm64-v8a,x86_64]');
    process.exit(0);
  } else throw new Error(`Unknown argument: ${arg}`);
}
if (process.platform !== 'win32') throw new Error('The pinned NDK package is for Windows hosts');

function relative(file) { return path.relative(root, file).split(path.sep).join('/'); }
function inCache(file) {
  const rel = path.relative(cache, path.resolve(file));
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Output escaped native-sqlite cache');
  return file;
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(inCache(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
function execute(file, args, { capture = false } = {}) {
  const result = spawnSync(file, args, {
    cwd: root, windowsHide: true, shell: false, encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    if (capture && result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${path.basename(file)} failed (${result.status ?? result.error?.code})`);
  }
  return capture ? result.stdout : '';
}
async function fingerprint(file, algorithms = ['sha256']) {
  const sums = Object.fromEntries(algorithms.map(algorithm => [algorithm, crypto.createHash(algorithm)]));
  for await (const buffer of fs.createReadStream(file)) for (const hash of Object.values(sums)) hash.update(buffer);
  return { path: relative(file), bytes: fs.statSync(file).size,
    ...Object.fromEntries(Object.entries(sums).map(([algorithm, hash]) => [algorithm, hash.digest('hex')])) };
}
async function treeFingerprint(dir) {
  const entries = [];
  async function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) entries.push({ ...await fingerprint(file), relativePath: path.relative(dir, file).split(path.sep).join('/') });
      else throw new Error(`Unexpected non-file in fingerprint tree: ${relative(file)}`);
    }
  }
  await visit(dir);
  entries.sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
  const digest = crypto.createHash('sha256');
  for (const entry of entries) digest.update(`${entry.relativePath}\0${entry.bytes}\0${entry.sha256}\n`);
  return { path: relative(dir), fileCount: entries.length, sha256: digest.digest('hex'), files: entries };
}
async function verifyArchive(file, pin) {
  const record = await fingerprint(file, [...new Set(['sha256', pin.algorithm])]);
  if (record.bytes !== pin.bytes || record[pin.algorithm] !== pin.digest) {
    throw new Error(`${pin.filename} failed pinned size/${pin.algorithm} verification; preserved at ${relative(file)}`);
  }
  return { ...pin, actual: record, verified: true };
}
function download(url, file, resume = true) {
  if (!url.startsWith('https://dl.google.com/android/repository/') && !url.startsWith('https://www.sqlite.org/')) {
    throw new Error('Download source is outside the pinned official origins');
  }
  const args = ['--fail', '--location', '--silent', '--show-error', '--retry', '3', '--retry-all-errors',
    '--connect-timeout', '20', '--max-time', '1800'];
  if (resume) args.push('--continue-at', '-');
  execute('curl.exe', [...args, '--output', inCache(file), url]);
}
async function prepareArchive(pin) {
  const archive = path.join(downloads, pin.filename);
  if (!fs.existsSync(archive)) {
    const partial = archive + '.part';
    try { download(pin.url, partial); }
    catch (error) {
      if (pin !== versions.sqlite) throw error;
      // SQLite publishes the exact product URL in a stable CSV comment. Do not guess a year/version.
      const html = path.join(downloads, 'sqlite-download.html');
      download(pin.reference, html, false);
      const product = fs.readFileSync(html, 'utf8').split(/\r?\n/)
        .map(line => line.split(','))
        .find(row => row[0] === 'PRODUCT' && row[1] === pin.version && row[2]?.endsWith('/' + pin.filename));
      if (!product || Number(product[3]) !== pin.bytes || product[4]?.trim() !== pin.digest) {
        throw new Error('Official SQLite product table does not match pinned version, size and SHA3-256');
      }
      // A failed HTTP response may have left a partial file. Retain it for diagnosis; never append to it.
      const fresh = archive + '.official-product.part';
      download(new URL(product[2], pin.reference).href, fresh, false);
      await verifyArchive(fresh, pin);
      fs.renameSync(fresh, archive);
    }
    if (!fs.existsSync(archive)) {
      await verifyArchive(partial, pin);
      fs.renameSync(partial, archive);
    }
  }
  return await verifyArchive(archive, pin);
}
function extract(archive, output, members = []) {
  fs.mkdirSync(inCache(output), { recursive: true });
  execute('tar.exe', ['-xf', archive, '-C', output, ...members]);
}
function elfChecks(readelf, output, expectedMachine, stage) {
  const sections = {
    header: execute(readelf, ['--file-header', output], { capture: true }),
    dynamic: execute(readelf, ['--dynamic', output], { capture: true }),
    programHeaders: execute(readelf, ['--program-headers', '--wide', output], { capture: true }),
    symbols: execute(readelf, ['--dyn-syms', '--wide', output], { capture: true }),
  };
  for (const [name, content] of Object.entries(sections)) fs.writeFileSync(inCache(path.join(stage, `readelf-${name}.txt`)), content);
  if (!/Class:\s+ELF64/.test(sections.header) || !/Type:\s+DYN/.test(sections.header) || !sections.header.includes(expectedMachine)) {
    throw new Error('Unexpected ELF class, type or machine');
  }
  const needed = [...sections.dynamic.matchAll(/\(NEEDED\).*?\[([^\]]+)\]/g)].map(match => match[1]);
  const allowed = new Set(['libnode.so', 'libm.so', 'libdl.so', 'libc.so']);
  if (!needed.includes('libnode.so') || needed.some(name => !allowed.has(name))) throw new Error(`Unexpected ELF dependencies: ${needed.join(', ')}`);
  const searchPaths = [...sections.dynamic.matchAll(/\((?:RPATH|RUNPATH)\).*?\[([^\]]+)\]/g)].map(match => match[1]);
  if (searchPaths.some(value => value !== '$ORIGIN') || sections.dynamic.includes('(TEXTREL)')) {
    throw new Error('ELF contains host search paths or text relocations');
  }
  if (!/\bGLOBAL\s+DEFAULT\s+\d+\s+napi_register_module_v1\b/.test(sections.symbols)) throw new Error('N-API registration export is missing');
  const undefinedSymbols = sections.symbols.split(/\r?\n/)
    .filter(line => /\bUND\b/.test(line)).map(line => line.trim().split(/\s+/).at(-1)).filter(name => name && name !== 'UND');
  if (!undefinedSymbols.some(name => /^napi_/.test(name))) throw new Error('N-API imports are missing');
  if (undefinedSymbols.some(name => /^(?:sqlite3_|_Z|node_module_register)/.test(name))) throw new Error('Unexpected external SQLite, C++ or Node-ABI symbols');
  const loads = sections.programHeaders.split(/\r?\n/).filter(line => /^\s*LOAD\s/.test(line));
  if (!loads.length || loads.some(line => Number.parseInt(line.trim().split(/\s+/).at(-1), 16) < 16384)) {
    throw new Error('ELF LOAD alignment is below 16 KB');
  }
  const stack = sections.programHeaders.split(/\r?\n/).find(line => /^\s*GNU_STACK\s/.test(line));
  if (!stack || /\bRWE\b/.test(stack)) throw new Error('ELF requests an executable stack');
  return { elf64: true, machine: expectedMachine, dependencies: needed, minimumLoadAlignment: 16384,
    napiVersion: 8, registration: 'napi_register_module_v1', noExternalSqlite: true, noCppRuntime: true,
    noTextRelocations: true, noHostRpath: true, searchPaths, nonExecutableStack: true, undefinedSymbols };
}

for (const dir of [downloads, sources, path.join(cache, 'build')]) fs.mkdirSync(inCache(dir), { recursive: true });
console.log('Verifying pinned official NDK and SQLite archives...');
const archiveRecords = { ndk: await prepareArchive(versions.ndk), sqlite: await prepareArchive(versions.sqlite) };
const clang = path.join(toolchain, 'bin/clang.exe');
const readelf = path.join(toolchain, 'bin/llvm-readelf.exe');
if (!fs.existsSync(clang) || !fs.existsSync(readelf) || !fs.existsSync(path.join(ndk, 'source.properties'))) {
  extract(path.join(downloads, versions.ndk.filename), path.join(cache, 'toolchain'),
    ['android-ndk-r24/toolchains/llvm', 'android-ndk-r24/source.properties']);
}
if (!fs.existsSync(path.join(amalgamation, 'sqlite3.c')) || !fs.existsSync(path.join(amalgamation, 'sqlite3.h'))) {
  extract(path.join(downloads, versions.sqlite.filename), sources);
}
if (!fs.readFileSync(path.join(ndk, 'source.properties'), 'utf8').includes(versions.ndk.version)) throw new Error('Extracted NDK version mismatch');
if (!new RegExp(`#define SQLITE_VERSION\\s+"${versions.sqlite.version.replaceAll('.', '\\.')}"`)
  .test(fs.readFileSync(path.join(amalgamation, 'sqlite3.h'), 'utf8'))) throw new Error('Extracted SQLite version mismatch');

console.log('Fingerprinting toolchain, SQLite sources, and Node Mobile headers...');
const inputs = {
  archives: archiveRecords,
  ndkToolchain: await treeFingerprint(toolchain),
  ndkProperties: await fingerprint(path.join(ndk, 'source.properties')),
  sqliteSources: await treeFingerprint(amalgamation),
  nodeHeaders: await treeFingerprint(path.join(nodeMobile, 'include/node')),
  compilerVersion: execute(clang, ['--version'], { capture: true }).trim(),
  readelfVersion: execute(readelf, ['--version'], { capture: true }).trim(),
};
for (const [abi] of Object.entries(targets)) inputs[`libnode_${abi}`] = await fingerprint(path.join(nodeMobile, 'bin', abi, 'libnode.so'));
const manifest = { schemaVersion: 1, preparationOnly: true, generatedAt: new Date().toISOString(),
  source: 'Pinned official Android NDK r24 and SQLite amalgamation; existing Node Mobile v18.20.4',
  apiLevel: 26, napiVersion: 8, definitions, flags, inputs };
writeJson(path.join(cache, 'sources-manifest.json'), manifest);
if (prepareOnly) {
  console.log(JSON.stringify({ preparationOnly: true, manifest: relative(path.join(cache, 'sources-manifest.json')), compiler: relative(clang), sourceReady: fs.existsSync(source) }));
  process.exit(0);
}
if (!fs.existsSync(source)) throw new Error(`Addon source is not ready: ${relative(source)}; use --prepare-only to prepare dependencies`);
manifest.inputs.addonSource = await fingerprint(source);
manifest.inputs.buildScript = await fingerprint(fileURLToPath(import.meta.url));
manifest.builds = [];
for (const abi of abis) {
  const stage = path.join(cache, 'build', abi);
  fs.mkdirSync(inCache(stage), { recursive: true });
  const output = path.join(stage, 'garden_sqlite.node');
  const args = [`--target=${targets[abi].triple}`, `--sysroot=${path.join(toolchain, 'sysroot')}`, ...flags,
    ...definitions.map(value => '-D' + value), '-I', path.join(nodeMobile, 'include/node'), '-I', amalgamation,
    source, path.join(amalgamation, 'sqlite3.c'), path.join(nodeMobile, 'bin', abi, 'libnode.so'), '-lm', '-ldl', '-o', output];
  writeJson(path.join(stage, 'command.json'), { cwd: root, executable: clang, args });
  console.log(`Compiling ${abi} for Android API 26 / N-API 8...`);
  const compiled = spawnSync(clang, args, { cwd: root, shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const compileLog = path.join(stage, 'compile.log');
  fs.writeFileSync(inCache(compileLog), (compiled.stdout || '') + (compiled.stderr || ''));
  if (compiled.stdout) process.stdout.write(compiled.stdout);
  if (compiled.stderr) process.stderr.write(compiled.stderr);
  if (compiled.error || compiled.status !== 0) throw new Error(`${abi} compilation failed (${compiled.status ?? compiled.error?.code}); see ${relative(compileLog)}`);
  const warnings = (compiled.stderr || '').split(/\r?\n/).filter(line => /\bwarning:/i.test(line));
  if ((await fingerprint(source)).sha256 !== manifest.inputs.addonSource.sha256) throw new Error('Addon source changed during compilation; rebuild from the final source');
  const checks = elfChecks(readelf, output, targets[abi].machine, stage);
  const build = { abi, target: targets[abi].triple, output: await fingerprint(output), compileLog: await fingerprint(compileLog), warnings, checks };
  manifest.builds.push(build);
  console.log(JSON.stringify(build));
}
writeJson(path.join(cache, 'build-manifest.json'), manifest);
console.log(JSON.stringify({ preparationOnly: true, built: manifest.builds.map(build => build.abi),
  manifest: relative(path.join(cache, 'build-manifest.json')), databaseOrAddonExecution: false }));
