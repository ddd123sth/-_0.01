import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectFileCapacity, reclaimFileCapacity, createFileCapacityGovernor,
  FILE_CAPACITY_CLASSES } from '../runtime/backend/observability/file-capacity.mjs';

const UUID_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const UUID_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const UUID_C = 'cccccccc-3333-4333-8333-333333333333';

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-capacity-'));
  const filesDir = path.join(root, 'files');
  fs.mkdirSync(path.join(filesDir, 'data'), { recursive: true });
  return { root, filesDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// Deterministic generation directory with an explicit age, so ordering never
// depends on the filesystem clock resolution.
function generation(filesDir, generationId, { bytes = 1024, ageMs = 60 * 60 * 1000 } = {}) {
  const dir = path.join(filesDir, 'data', 'performance-diagnostics', generationId);
  fs.mkdirSync(dir, { recursive: true });
  const body = Buffer.alloc(bytes, 0x61);
  fs.writeFileSync(path.join(dir, 'events.ndjson'), body);
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(path.join(dir, 'events.ndjson'), at, at);
  fs.utimesSync(dir, at, at);
  return dir;
}

test('reclaim deletes oldest closed generations and keeps the current one', () => {
  const dir = scratch();
  try {
    const now = Date.now();
    const budget = FILE_CAPACITY_CLASSES.find(entry => entry.id === 'runtime-diagnostics').budgetBytes;
    // 12 generations of 1 MiB each: three times the 6 MiB class budget.
    const ids = Array.from({ length: 12 }, (_, index) =>
      `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`);
    ids.forEach((id, index) => generation(dir.filesDir, id, { bytes: 1024 * 1024, ageMs: (12 - index) * 3600_000 }));
    const current = ids.at(-1);
    const receipt = reclaimFileCapacity({ filesDir: dir.filesDir, generation: current, now });
    assert.ok(receipt.beforeTotalBytes >= budget, 'fixture exceeds the class budget');
    assert.ok(receipt.afterTotalBytes <= budget, 'reclaim returns the class to its budget');
    assert.ok(fs.existsSync(path.join(dir.filesDir, 'data', 'performance-diagnostics', current)), 'current generation survives');
    assert.ok(fs.existsSync(path.join(dir.filesDir, 'data', 'performance-diagnostics', ids.at(-2))), 'newest kept generation survives');
    assert.ok(!fs.existsSync(path.join(dir.filesDir, 'data', 'performance-diagnostics', ids[0])), 'oldest generation removed');
    // A second pass with nothing to do must not change the tree.
    const second = reclaimFileCapacity({ filesDir: dir.filesDir, generation: current, now });
    assert.equal(second.reclaimedBytes, 0, 'reclaim is idempotent once inside budget');
    assert.ok(collectFileCapacity({ filesDir: dir.filesDir, generation: current, now }).classes
      .every(entry => entry.bytes <= entry.budgetBytes || entry.id === 'runtime-diagnostics'), 'all classes inside budget');
  } finally { dir.cleanup(); }
});

test('a capture inside its grace window and a protected name are never deleted', () => {
  const dir = scratch();
  try {
    const now = Date.now();
    // 5 MiB units: the oldest is closed and reclaimable, the middle one is
    // already over budget but still inside its grace window.
    generation(dir.filesDir, UUID_A, { bytes: 5 * 1024 * 1024, ageMs: 3 * 24 * 3600_000 });
    generation(dir.filesDir, UUID_B, { bytes: 5 * 1024 * 1024, ageMs: 60_000 });
    generation(dir.filesDir, UUID_C, { bytes: 5 * 1024 * 1024, ageMs: 5000 });
    fs.writeFileSync(path.join(dir.filesDir, 'data', 'keepalive-engine.json'), '{"desired":true}');
    const receipt = reclaimFileCapacity({ filesDir: dir.filesDir, generation: null, now });
    assert.ok(!fs.existsSync(path.join(dir.filesDir, 'data', 'performance-diagnostics', UUID_A)), 'the closed oldest capture is reclaimed');
    assert.ok(fs.existsSync(path.join(dir.filesDir, 'data', 'performance-diagnostics', UUID_B)), 'grace protects a unit that is not the newest');
    assert.ok(fs.existsSync(path.join(dir.filesDir, 'data', 'keepalive-engine.json')), 'protected projection is untouched');
    const runtime = receipt.classes.find(entry => entry.id === 'runtime-diagnostics');
    assert.ok(runtime.decisions.some(entry => entry.reason === 'WITHIN_GRACE'), 'the grace skip is reported, not silent');
  } finally { dir.cleanup(); }
});

test('one capture larger than the whole class budget cannot survive on newest-position alone', () => {
  const dir = scratch();
  try {
    const now = Date.now();
    generation(dir.filesDir, UUID_A, { bytes: 9 * 1024 * 1024, ageMs: 6 * 3600_000 });
    generation(dir.filesDir, UUID_B, { bytes: 1024, ageMs: 60_000 });
    const receipt = reclaimFileCapacity({ filesDir: dir.filesDir, generation: UUID_B, now });
    assert.ok(!fs.existsSync(path.join(dir.filesDir, 'data', 'performance-diagnostics', UUID_A)), 'an oversized closed capture is reclaimed');
    assert.ok(fs.existsSync(path.join(dir.filesDir, 'data', 'performance-diagnostics', UUID_B)), 'the running generation survives');
    assert.ok(receipt.reclaimedBytes > 8 * 1024 * 1024);
  } finally { dir.cleanup(); }
});

test('dry run reports the same reclaim without deleting', () => {
  const dir = scratch();
  try {
    const now = Date.now();
    for (let index = 0; index < 10; index++)
      generation(dir.filesDir, `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
        { bytes: 1024 * 1024, ageMs: (20 - index) * 3600_000 });
    const preview = reclaimFileCapacity({ filesDir: dir.filesDir, generation: null, now, dryRun: true });
    assert.ok(preview.reclaimedBytes > 0);
    const after = collectFileCapacity({ filesDir: dir.filesDir, now });
    assert.equal(after.totalBytes, preview.beforeTotalBytes, 'dry run deletes nothing');
  } finally { dir.cleanup(); }
});

test('the lease serialises two overlapping engine generations', () => {
  const dir = scratch();
  try {
    const first = createFileCapacityGovernor({ filesDir: dir.filesDir, dataDir: path.join(dir.filesDir, 'data'), generation: UUID_A });
    const second = createFileCapacityGovernor({ filesDir: dir.filesDir, dataDir: path.join(dir.filesDir, 'data'), generation: UUID_B });
    // The first governor holds the lease for the duration of its pass; a second
    // governor writing while the lease file exists must skip, not duplicate.
    const leaseFile = path.join(dir.filesDir, 'data', 'file-capacity-lease.json');
    fs.writeFileSync(leaseFile, JSON.stringify({ version: 'file-capacity-lease/v1', pid: process.pid,
      generation: UUID_A, nonce: 'held', atMs: Date.now() }));
    assert.equal(second.scan({ force: true }), null, 'a live lease blocks the second pass');
    assert.ok(second.status().skips >= 1);
    // A dead holder is taken over instead of blocking capacity work forever.
    fs.writeFileSync(leaseFile, JSON.stringify({ version: 'file-capacity-lease/v1', pid: 999999,
      generation: UUID_A, nonce: 'dead', atMs: Date.now() }));
    assert.ok(first.scan({ force: true }) !== null, 'an expired or dead holder is taken over');
    first.close(); second.close();
  } finally { dir.cleanup(); }
});

test('the status projection stays bounded and reports the class budget', () => {
  const dir = scratch();
  try {
    const dataDir = path.join(dir.filesDir, 'data');
    const governor = createFileCapacityGovernor({ filesDir: dir.filesDir, dataDir, generation: UUID_A });
    governor.scan({ force: true });
    const statusFile = path.join(dataDir, 'file-capacity-status.json');
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    assert.equal(status.version, 'file-capacity-status/v1');
    assert.equal(status.generation, UUID_A);
    assert.ok(Array.isArray(status.lastScan.classes));
    assert.ok(fs.statSync(statusFile).size <= 8 * 1024, 'status projection is bounded');
    assert.ok(!fs.existsSync(path.join(dataDir, 'file-capacity-lease.json')), 'the lease is released after the pass');
    governor.close();
  } finally { dir.cleanup(); }
});