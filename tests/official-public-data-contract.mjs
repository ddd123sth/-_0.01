import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createOfficialPublicDataCache, decodeAvailableGDataTables, decodeOfficialGDataTables, officialGDataUrl, officialIndexCandidates, officialPublicUrl } from '../runtime/backend/official-public-data.mjs';
import { officialDataSnapshotForSourceVersion } from '../runtime/backend/official-data-snapshot.mjs';

const capturedGDataPath = '.runtime/validation/official-public-480.0.46-resources-20261026-01/raw/g-data.480.0.46.ab27c.text';
const capturedGDataUrl = 'https://hygncdn.babigame.cn/assets/resources/native/35/35fc3381-34dc-5c64-ba90-e06c2c6133a8.ab27c.text';
const capturedIndexPath = '.runtime/validation/official-public-480.0.46-index-20261026-01/raw/candidate-1.body';
const capturedConfigPath = '.runtime/validation/official-public-480.0.46-resources-20261026-01/raw/candidate-3.body';

test('normal package metadata locates public index only; URL stays within the fixed HTTPS host set', () => {
  assert.deepEqual(officialIndexCandidates({ source: 'normal-auth-package-hop-public-config/v1', gameVersion: '480.0.46',
    entryUrl: 'https://hygnhf2.babigame.cn/package', cdnList: ['https://hygncdn.babigame.cn/'] }), [
    'https://hygnhf2.babigame.cn/index/index-gn-mix-480.0.46.json',
    'https://hygnhf2.babigame.cn/index/index-480.0.46.json',
    'https://hygncdn.babigame.cn/index/index-gn-mix-480.0.46.json',
    'https://hygncdn.babigame.cn/index/index-480.0.46.json',
  ]);
  assert.equal(officialPublicUrl('http://hygncdn.babigame.cn/index.json'), null);
  assert.equal(officialPublicUrl('https://evil.example/index.json'), null);
  assert.equal(officialPublicUrl('https://hygncdn.babigame.cn/a/../index.json'), null);
});

test('captured public 480.0.46 g-data decodes to the verified static tables and normalized snapshot', () => {
  const raw = fs.readFileSync(capturedGDataPath);
  const decoded = decodeOfficialGDataTables(raw, { tableNames: ['c_item', 'c_farmLand', 'c_flower', 'c_flowerLvl', 'c_flowerLvlCfg', 'c_flowerArt'] });
  const expectedSnapshot = officialDataSnapshotForSourceVersion('480.0.46');
  assert.equal(decoded.dataSnapshotId, expectedSnapshot.dataSnapshotId);
  assert.deepEqual(decoded.tableHashes, expectedSnapshot.tableHashes);
  for (const [name, rows] of Object.entries(decoded.tables)) {
    const dir = name === 'c_flowerArt' ? 'official-customer-480.0.46' : 'official-land-480.0.46';
    assert.deepEqual(rows, JSON.parse(fs.readFileSync(`runtime/backend/catalogs/${dir}/${name}.json`, 'utf8')));
  }
  assert.throws(() => decodeOfficialGDataTables(raw, { tableNames: ['not-an-official-table'] }), { code: 'OFFICIAL_GDATA_TABLE_MISSING' });
});

test('public cache keeps candidate data inactive until schema attestation and preserves the last good pointer on failure', async () => {
  const bytes = fs.readFileSync(capturedGDataPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-public-data-'));
  const store = openBackendStore({ dataDir: root, filename: 'cache.db' });
  try {
    let failFetch = false;
    const cache = createOfficialPublicDataCache({ store, fetchImpl: async () => {
      if (failFetch) throw Object.assign(new Error('network'), { code: 'TEST_NETWORK_DOWN' });
      return new Response(bytes, { status: 200, headers: { 'content-type': 'text/plain', 'content-length': String(bytes.length) } });
    } });
    const candidate = await cache.fetchResource({ sourceKey: 'official-gdata', sourceVersion: '480.0.46', url: capturedGDataUrl });
    assert.equal(candidate.fresh, true);
    assert.equal(candidate.active, false);
    assert.equal(cache.latest('official-gdata'), null);
    assert.throws(() => cache.activate({ sourceKey: 'official-gdata', sourceVersion: '480.0.46', sha256: candidate.sha256 }),
      { code: 'OFFICIAL_PUBLIC_CACHE_OBJECT_UNVALIDATED' });
    const validationRef = cache.validateGDataSnapshot({ sourceKey: 'official-gdata', sourceVersion: '480.0.46', sha256: candidate.sha256 });
    assert.match(validationRef, /^sha256:[a-f0-9]{64}$/);
    const activated = cache.activate({ sourceKey: 'official-gdata', sourceVersion: '480.0.46', sha256: candidate.sha256 });
    assert.equal(activated.active, true);
    assert.equal(activated.dataSnapshotId, decodeAvailableGDataTables(bytes).dataSnapshotId);
    failFetch = true;
    const stale = await cache.fetchResource({ sourceKey: 'official-gdata', sourceVersion: '480.0.46', url: capturedGDataUrl });
    assert.equal(stale.fresh, false);
    assert.equal(stale.stale, true);
    assert.equal(stale.sha256, candidate.sha256);
    assert.equal(cache.latest('official-gdata').sha256, candidate.sha256);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('captured official index → config → g-data chain yields the verified snapshot without executing game code', async () => {
  const index = fs.readFileSync(capturedIndexPath);
  const config = fs.readFileSync(capturedConfigPath);
  const gdata = fs.readFileSync(capturedGDataPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-public-chain-'));
  const store = openBackendStore({ dataDir: root, filename: 'cache.db' });
  try {
    const resources = new Map([
      ['https://hygncdn.babigame.cn/index/index-gn-mix-480.0.46.json', index],
      ['https://hygncdn.babigame.cn/assets/resources/config.603c3.json', config],
      [capturedGDataUrl, gdata],
    ]);
    const cache = createOfficialPublicDataCache({ store, fetchImpl: async url => {
      const body = resources.get(String(url));
      if (!body) return new Response('', { status: 404 });
      const type = String(url).endsWith('.json') ? 'application/json' : 'text/plain';
      return new Response(body, { status: 200, headers: { 'content-type': type, 'content-length': String(body.length) } });
    } });
    assert.equal(officialGDataUrl(JSON.parse(config), 'https://hygncdn.babigame.cn/assets/resources/config.603c3.json'), capturedGDataUrl);
    const result = await cache.fetchAndActivateSnapshot({ sourceKey: 'account3-owner-epoch-1451', publicResources: {
      source: 'normal-auth-package-hop-public-config/v1', gameVersion: '480.0.46',
      entryUrl: 'https://hygncdn.babigame.cn/package', cdnList: [],
    } });
    assert.equal(result.fresh, true);
    assert.equal(result.stale, false);
    assert.equal(result.dataSnapshotId, decodeAvailableGDataTables(gdata).dataSnapshotId);
    assert.equal(cache.latest('account3-owner-epoch-1451:g-data').sha256, result.resourceSha256);
    assert.equal(result.sourceConfigSha256, '506b322b1d89e25e59aa13541ed6e670ec15316489d29e3da2be42628fb4c598');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
