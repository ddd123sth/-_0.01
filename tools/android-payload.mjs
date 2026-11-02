// Android engine payload: only files the on-device runtime can reach, never the reference project's server surfaces.
import fs from 'node:fs';
import path from 'node:path';

const ENGINE_ROOT = ['vendor', 'garden-engine', 'server', 'src'];

export const REBUILD_BUILD_ID_TOKEN = 'GARDEN_BACKEND_BUILD_ID_PLACEHOLDER';
export const REBUILD_APPLICATION_ID = 'online.ainiannian.wujinxia';
// These files contain the replaced execution/decision chain, not protocol tools.
export const FORBIDDEN_REBUILD_FILES = [
  'game/real-harvest-runner.js', 'game/real-worker-policy.js',
  'game/feature-registry.js', 'game/ad-token-issuer.js',
  'game/real-adapter.js', 'game/android-launcher.js',
];

// The reference web project's admin/user HTTP layer, node cluster and production seed config.
export const FORBIDDEN_ENGINE_FILES = [
  'admin-security.js', 'api-admin.js', 'api-nodes.js', 'api-user.js', 'auth-routes.js',
  'manual-actions.js', 'node-sync.js', 'nodes.js', 'seed.js', 'security-guard.js',
  'worker-lifecycle.js', 'worker.js',
];

export const FORBIDDEN_ENGINE_TEXT = [
  { pattern: /wdhysj\.cn/i, label: '原网页版后端域名' },
  { pattern: /xunhupay/i, label: '原网页版支付网关' },
];

const IMPORT_RE = /(?:^|\n)[ \t]*(?:import\s[^'";]*?from|import|export\s[^'";]*?from|require\s*\()\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function engineDir(projectRoot) { return path.join(projectRoot, ...ENGINE_ROOT); }
function toPosix(rel) { return rel.split(path.sep).join('/'); }

function inside(parent, file) {
  const relative = path.relative(parent, file);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function importsOf(source) {
  return [IMPORT_RE, DYNAMIC_IMPORT_RE].flatMap(re => [...source.matchAll(re)].map(match => match[1]));
}

function resolveSource(spec, fromFile) {
  const base = path.resolve(path.dirname(fromFile), spec);
  return [base, base + '.mjs', base + '.js', path.join(base, 'index.mjs'), path.join(base, 'index.js')]
    .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

// Only the composition root and its transitive imports enter a rebuild APK.
// Runtime and vendor source paths have different destinations in engine.zip.
export function androidRebuildGraph(projectRoot) {
  const runtime = path.join(projectRoot, 'runtime');
  const engine = engineDir(projectRoot);
  const data = path.join(projectRoot, 'vendor/garden-engine/server/data');
  const entry = path.join(runtime, 'backend/server.mjs');
  const queue = [entry];
  const seen = new Map();
  const problems = [];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    if (!fs.existsSync(file)) { problems.push('Missing rebuild source: ' + toPosix(path.relative(projectRoot, file))); continue; }
    const physical = fs.realpathSync(file);
    if (![runtime, engine, data].some(directory => inside(fs.realpathSync(directory), physical))) {
      problems.push('Rebuild source symlink leaves the project payload boundary: ' + toPosix(path.relative(projectRoot, file))); continue;
    }
    let target;
    if (inside(runtime, file)) target = 'android/' + toPosix(path.relative(runtime, file));
    else if (inside(engine, file)) target = 'server/src/' + toPosix(path.relative(engine, file));
    else if (inside(data, file)) target = 'server/data/' + toPosix(path.relative(data, file));
    else { problems.push('Rebuild import leaves this project runtime/protocol boundary: ' + toPosix(path.relative(projectRoot, file))); continue; }
    const relativeEngine = inside(engine, file) ? toPosix(path.relative(engine, file)) : null;
    if (file === path.join(runtime, 'server.mjs') || file === path.join(runtime, 'sqlite-compat.mjs') || (relativeEngine && (
      FORBIDDEN_ENGINE_FILES.includes(relativeEngine) || FORBIDDEN_REBUILD_FILES.includes(relativeEngine)
      || /(?:^|[-_/])(?:cycle|planner|runner)(?:[-_.]|$)/i.test(relativeEngine)
    ))) problems.push('Rebuild reaches the retired execution/decision chain: ' + toPosix(path.relative(projectRoot, file)));
    const source = /\.(?:mjs|js|cjs)$/.test(file) ? fs.readFileSync(file, 'utf8') : '';
    const dependencies = [];
    for (const spec of importsOf(source)) {
      if (spec === 'node:sqlite') {
        const dependency = path.join(runtime, 'sqlite-native.mjs');
        dependencies.push({ spec, source: dependency }); queue.push(dependency); continue;
      }
      if (!spec.startsWith('.')) {
        if (spec.startsWith('file:') || path.isAbsolute(spec)) problems.push('Absolute import is forbidden in a rebuild APK: ' + target);
        continue;
      }
      const dependency = resolveSource(spec, file);
      if (!dependency) { problems.push('Unresolved rebuild import: ' + target + ' -> ' + spec); continue; }
      dependencies.push({ spec, source: dependency }); queue.push(dependency);
    }
    for (const re of [/\bload\(\s*['"]([^'"]+)['"]\s*\)/g, /\bengineUrl\(\s*['"]([^'"]+)['"]\s*\)/g]) {
      for (const match of source.matchAll(re)) {
        const dependency = path.resolve(engine, match[1]);
        if (!inside(engine, dependency)) { problems.push('Engine loader leaves protocol snapshot: ' + target); continue; }
        dependencies.push({ spec: match[1], source: dependency, engineLoader: true }); queue.push(dependency);
      }
    }
    if (inside(path.join(runtime, 'backend'), file)) {
      for (const match of source.matchAll(/\bnew\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) {
        const spec = match[1];
        if (!spec.startsWith('.')) { problems.push('Rebuild asset URL must be relative to its backend module: ' + target); continue; }
        const dependency = resolveSource(spec, file);
        if (!dependency || !inside(path.join(runtime, 'backend'), dependency)) {
          problems.push('Rebuild asset is missing or outside runtime/backend: ' + target + ' -> ' + spec); continue;
        }
        dependencies.push({ spec, source: dependency, asset: true }); queue.push(dependency);
      }
    }
    seen.set(file, { source: file, target, dependencies });
  }
  if (problems.length) throw new Error('Rebuild source closure rejected:\n' + [...new Set(problems)].join('\n'));
  return [...seen.values()].sort((left, right) => left.target.localeCompare(right.target));
}

function listEngineFiles(dir, base = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listEngineFiles(full, base));
    else if (entry.name.endsWith('.js')) out.push(toPosix(path.relative(base, full)));
  }
  return out;
}

export function androidEngineRoots(projectRoot) {
  return androidRebuildGraph(projectRoot)
    .filter(item => item.target.startsWith('server/src/')).map(item => item.target.slice('server/src/'.length));
}

export function androidEngineFiles(projectRoot) { return androidEngineRoots(projectRoot); }

function* walkFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else yield full;
  }
}

// Runs against the staged payload before any APK artifact is produced.
export function androidPayloadProblems(projectRoot, stageDir) {
  const problems = [];
  const allowlist = androidEngineFiles(projectRoot);
  const allowed = new Set(allowlist);
  const stagedEngine = path.join(stageDir, 'server', 'src');
  const staged = listEngineFiles(stagedEngine);
  for (const rel of staged) {
    if (!allowed.has(rel)) problems.push('Payload contains engine file outside the Android allowlist: ' + rel);
    if (FORBIDDEN_ENGINE_FILES.includes(rel)) problems.push('Payload contains reference-project server file: ' + rel);
  }
  for (const rel of allowlist) {
    if (!fs.existsSync(path.join(stagedEngine, rel))) problems.push('Payload is missing allowlisted engine file: ' + rel);
  }
  const graph = androidRebuildGraph(projectRoot);
  const runtimeAllowed = new Set(graph.filter(item => item.target.startsWith('android/')).map(item => item.target));
  runtimeAllowed.add('android/server.mjs');
  for (const file of walkFiles(path.join(stageDir, 'android'))) {
    const relative = toPosix(path.relative(stageDir, file));
    if (!runtimeAllowed.has(relative)) problems.push('Rebuild contains an unreachable runtime file: ' + relative);
  }
  for (const item of graph) {
    if (!fs.existsSync(path.join(stageDir, item.target))) problems.push('Rebuild payload is missing source: ' + item.target);
  }
  const bridge = path.join(stageDir, 'android/server.mjs');
  if (!fs.existsSync(bridge) || fs.readFileSync(bridge, 'utf8') !== "// Android native entry for the rebuilt backend.\nimport './backend/server.mjs';\n") {
    problems.push('Rebuild native entry must exclusively import the new composition root');
  }
  if (fs.existsSync(path.join(stageDir, 'android/sqlite-compat.mjs')) || fs.existsSync(path.join(stageDir, 'node_modules/sql.js'))) {
    problems.push('Rebuild must use native SQLite without the legacy sql.js driver');
  }
  for (const file of walkFiles(stageDir)) {
    if (!/\.(js|mjs|cjs)$/.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (/['"]node:sqlite['"]/.test(text)) problems.push('Rebuild SQLite import was not adapted for Node Mobile: ' + toPosix(path.relative(stageDir, file)));
    for (const { pattern, label } of FORBIDDEN_ENGINE_TEXT) {
      if (pattern.test(text)) problems.push('Payload leaks ' + label + ': ' + toPosix(path.relative(stageDir, file)));
    }
    for (const re of [IMPORT_RE, DYNAMIC_IMPORT_RE]) {
      for (const match of text.matchAll(re)) {
        const spec = match[1];
        if (!spec.startsWith('.')) continue;
        if (!fs.existsSync(path.resolve(path.dirname(file), spec))) {
          problems.push('Payload import cannot resolve: ' + toPosix(path.relative(stageDir, file)) + ' -> ' + spec);
        }
      }
    }
  }
  return { problems, allowlist, staged };
}
