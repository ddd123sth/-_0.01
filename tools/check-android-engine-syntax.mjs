#!/usr/bin/env node
// Validate every staged Android engine .mjs file with the selected Node runtime.
// This is a development/packaging gate; it is not shipped in the customer APK.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const root = path.resolve(arg('--root', '.'));
const node = path.resolve(arg('--node', process.execPath));
const receiptPath = arg('--receipt');
const expectedVersion = arg('--expected-version', 'v18.20.4');
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`);
if (!fs.existsSync(node)) throw new Error(`Node executable not found: ${node}`);

const versionResult = spawnSync(node, ['--version'], { encoding: 'utf8', windowsHide: true });
const nodeVersion = (versionResult.stdout || '').trim();
if (versionResult.status !== 0) throw new Error(`Could not read Node version: ${versionResult.stderr || versionResult.error}`);

const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(full);
  }
}
walk(root);
files.sort((a, b) => a.localeCompare(b));

const checks = [];
for (const file of files) {
  const before = fs.readFileSync(file);
  const sha256 = createHash('sha256').update(before).digest('hex');
  const result = spawnSync(node, ['--check', file], { encoding: 'utf8', windowsHide: true });
  const after = fs.readFileSync(file);
  const unchanged = before.equals(after);
  checks.push({
    file: path.relative(root, file).split(path.sep).join('/'),
    bytes: before.length,
    sha256,
    unchangedDuringCheck: unchanged,
    exitCode: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || (result.error ? String(result.error) : ''),
  });
}
const nodeVersionMatches = nodeVersion === expectedVersion;
const receipt = {
  checkedAtUtc: new Date().toISOString(),
  nodePath: node,
  nodeVersion,
  expectedVersion,
  nodeVersionMatches,
  root,
  moduleCount: checks.length,
  passed: nodeVersionMatches && checks.length > 0 && checks.every((entry) => entry.exitCode === 0 && entry.unchangedDuringCheck),
  checks,
};
if (receiptPath) {
  const output = path.resolve(receiptPath);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
}
console.log(JSON.stringify({ nodeVersion, expectedVersion, nodeVersionMatches, root, moduleCount: checks.length, passed: receipt.passed,
  failures: checks.filter((entry) => entry.exitCode !== 0 || !entry.unchangedDuringCheck) }, null, 2));
if (!receipt.passed) process.exitCode = 1;
