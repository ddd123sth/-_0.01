// 打包隔离闸：安卓载荷只带新后端可达的协议文件，且不带遗留执行链与管理服务端。
// 纯静态检查，不建账号、不连官服、不造回包。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORBIDDEN_ENGINE_FILES, FORBIDDEN_ENGINE_TEXT, androidEngineRoots, androidEngineFiles, androidPayloadProblems } from '../tools/android-payload.mjs';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function syntheticProject(files, runtimeLoad) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-payload-'));
  const src = path.join(root, 'vendor/garden-engine/server/src');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(path.join(root, 'runtime/backend'), { recursive: true });
  fs.writeFileSync(path.join(root, 'runtime/backend/server.mjs'), "const load = r => import('../../vendor/garden-engine/server/src/' + r);\nload('" + runtimeLoad + "');\n");
  for (const [name, text] of Object.entries(files)) {
    const full = path.join(src, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  const stage = path.join(root, '.runtime/android-engine');
  fs.mkdirSync(path.join(stage, 'server/src'), { recursive: true });
  fs.mkdirSync(path.join(stage, 'android/backend'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'android/backend/server.mjs'), 'export {};\n');
  fs.writeFileSync(path.join(stage, 'android/server.mjs'), "// Android native entry for the rebuilt backend.\nimport './backend/server.mjs';\n");
  return { root, src, stage };
}
function stageEngine(stage, src, names) {
  for (const name of names) {
    const to = path.join(stage, 'server/src', name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, name), to);
  }
}

test('后端运行时根全部来自 runtime/backend 的字面量 load，且都能在协议快照里找到', () => {
  const roots = androidEngineRoots(projectRoot);
  assert.ok(roots.length > 0, 'roots ' + roots.length);
  const src = path.join(projectRoot, 'vendor/garden-engine/server/src');
  for (const rel of roots) assert.ok(fs.existsSync(path.join(src, rel)), '缺失运行时根 ' + rel);
  assert.deepEqual(new Set(roots), new Set([
    'game/android-auth.js', 'game/android-login-context.js', 'game/client-profile.js', 'game/client.js',
    'game/login-error-codes.js', 'game/net-race.js', 'game/runtime-paths.js', 'game/v5-official-fields.js',
  ]));
});

test('退役执行链与管理服务端不在安卓可达闭包内', () => {
  const files = androidEngineFiles(projectRoot);
  const set = new Set(files);
  for (const forbidden of FORBIDDEN_ENGINE_FILES) {
    assert.ok(!set.has(forbidden), '闭包竟含原站服务端文件 ' + forbidden);
  }
  assert.ok(files.length < 227, '闭包应小于整份快照 ' + files.length);
});

test('安卓可达闭包里不出现旧服务域名和支付网关', () => {
  const src = path.join(projectRoot, 'vendor/garden-engine/server/src');
  for (const rel of androidEngineFiles(projectRoot)) {
    const text = fs.readFileSync(path.join(src, rel), 'utf8');
    for (const { pattern, label } of FORBIDDEN_ENGINE_TEXT) {
      assert.ok(!pattern.test(text), rel + ' 含' + label);
    }
  }
});

test('一旦闭包触到退役执行链或管理服务文件，隔离闸直接拒绝', () => {
  const { root, src } = syntheticProject({
    'a.js': 'import { x } from "./api-admin.js";\nexport const y = x;\n',
    'api-admin.js': 'export const x = 1;\n',
  }, 'a.js');
  assert.throws(() => androidEngineFiles(root), /retired execution\/decision chain/u);
  fs.writeFileSync(path.join(src, 'a.js'), 'export const y = 1;\n');
  assert.deepEqual(androidEngineFiles(root), ['a.js']);
});

test('载荷检查放行正确载荷，并对多带文件、漏带文件、断掉的 import 分别翻红', () => {
  const { root, src, stage } = syntheticProject({
    'a.js': 'import { b } from "./b.js";\nexport const c = b;\n',
    'b.js': 'import { d } from "./game/d.js";\nexport const b = d;\n',
    'game/d.js': 'export const d = 1;\n',
    'api-admin.js': 'export const admin = 1;\n',
    'orphan.js': 'import { z } from "./missing.js";\nexport const o = z;\n',
  }, 'a.js');
  assert.deepEqual(androidEngineFiles(root), ['a.js', 'b.js', 'game/d.js']);

  stageEngine(stage, src, ['a.js', 'b.js', 'game/d.js']);
  assert.deepEqual(androidPayloadProblems(root, stage).problems, []);

  stageEngine(stage, src, ['api-admin.js']);
  const extra = androidPayloadProblems(root, stage).problems;
  assert.ok(extra.some(line => line.includes('outside the Android allowlist')), extra.join('\n'));
  assert.ok(extra.some(line => line.includes('reference-project server file')), extra.join('\n'));

  fs.rmSync(path.join(stage, 'server/src/game/d.js'));
  const missing = androidPayloadProblems(root, stage).problems;
  assert.ok(missing.some(line => line.includes('missing allowlisted engine file')), missing.join('\n'));

  stageEngine(stage, src, ['game/d.js']);
  fs.writeFileSync(path.join(stage, 'server/src/a.js'), 'import { q } from "./pruned.js";\nexport const c = q;\n');
  const broken = androidPayloadProblems(root, stage).problems;
  assert.ok(broken.some(line => line.includes('import cannot resolve') && line.includes('pruned.js')), broken.join('\n'));
});

test('暂存载荷与白名单一致时隔离闸零问题', () => {
  const stage = path.join(projectRoot, '.runtime/android-engine');
  assert.ok(fs.existsSync(path.join(stage, 'server/src')), '先跑一次 node tools/build-android.mjs 产出暂存载荷');
  const { problems, allowlist, staged } = androidPayloadProblems(projectRoot, stage);
  assert.deepEqual(problems, []);
  assert.equal(staged.length, allowlist.length);
  assert.ok(staged.length > 0, '暂存协议文件 ' + staged.length);
});
