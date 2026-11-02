import crypto from 'node:crypto';
import { canonical, freeze, newId, plainObject, problem } from './common.mjs';
import { OFFICIAL_CORE_CONTRACT_ID } from './official-version-profile.mjs';
import { decodeOfficialJsc, proveOfficialSourceActions, sourceProofContractBytesHash } from './official-source-proof.mjs';
import { LAND_ACCELERATION_SOURCE_PIN, proveLandAccelerationExtensionSource, validateLandAccelerationTables } from './official-land-acceleration-extension.mjs';
import { WATERWHEEL_SOURCE_PIN, proveWaterwheelExtensionSource, validateWaterwheelTables } from './official-waterwheel-extension.mjs';
import { FREE_WATER_SOURCE_PIN, proveFreeWaterExtensionSource, validateFreeWaterTables } from './official-free-water-extension.mjs';
import { SPECIAL_ORDERS_SOURCE_PIN, proveSpecialOrdersSource, validateSpecialOrdersTables } from './official-special-orders-extension.mjs';
import { FLOWER_RACK_SOURCE_PIN, proveFlowerRackExtensionSource, validateFlowerRackTables } from './official-flower-rack-extension.mjs';
import { FLOWER_RACK_PRICE_SOURCE_PIN, proveFlowerRackPriceExtensionSource, validateFlowerRackPriceExtension } from './official-flower-rack-price-extension.mjs';
import { ART_FIRST_REWARD_SOURCE_PIN, proveArtFirstRewardExtensionSource, bindArtFirstRewardExtension } from './official-art-first-reward-extension.mjs';
import { SERVER_VERSION_SOURCE_PIN, SERVER_VERSION_PROTOCOL_CONTRACT, bindOfficialServerVersionProofToBundle, proveOfficialServerVersionSemantics }
  from './official-server-version-contract.mjs';

const TRUSTED_HOSTS = new Set(['hygncdn.babigame.cn', 'hygnhf2.babigame.cn']);
const MAX_BYTES = 8 * 1024 * 1024;
// Keep room for current, last-good and one complete candidate bundle (game,
// mo, config, index and gdata) before the new head can be atomically selected.
const MAX_CACHE_BYTES = 48 * 1024 * 1024;
const TIMEOUT_MS = 12_000;
const FLIGHT = new Map();
export const OFFICIAL_GDATA_SCHEMA_CONTRACT_ID = 'sha256:' + crypto.createHash('sha256').update(JSON.stringify({
  schema: 'official-gdata-runtime-schema/v2',
  tables: { c_item: ['id'], c_farmLand: ['id'], c_flower: ['id', 'seedId', 'culCost'],
    c_flowerLvl: ['id'], c_flowerLvlCfg: ['id'], c_flowerArt: ['id', 'vase', 'flowers'], c_open: ['id'],
    c_lvl: ['id', 'orderFlower', 'orderSatinsNum', 'orderDecorateNum', 'orderNum'], c_orderFlower: ['id'],
    c_orderFlowerNpc: ['id'], c_share: ['id', 'limit', 'limitType', 'openId'], c_butler: ['id', '$maxFlowerOrder'] },
})).digest('hex');

export function officialPublicUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  if (/(?:^|\/)(?:\.{1,2}|%2e(?:%2e)?)(?:\/|$)/i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !TRUSTED_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password ||
        url.port || url.search || url.hash || url.pathname.split('/').some(part => part === '..')) return null;
    return url;
  } catch { return null; }
}

export function officialIndexCandidates(publicResources) {
  const version = typeof publicResources?.gameVersion === 'string' && /^[0-9]+(?:\.[0-9]+){1,5}$/.test(publicResources.gameVersion)
    ? publicResources.gameVersion : null;
  if (!version || publicResources?.source !== 'normal-auth-package-hop-public-config/v1') return [];
  const hostCandidates = [];
  for (const candidate of [publicResources.entryUrl, ...(Array.isArray(publicResources.cdnList) ? publicResources.cdnList : [])]) {
    const url = officialPublicUrl(candidate);
    if (url && !hostCandidates.includes(url.hostname)) hostCandidates.push(url.hostname);
  }
  // The fixed host is an observed official public CDN fallback, not a game
  // version capability declaration. Version text only locates its index file.
  if (!hostCandidates.includes('hygncdn.babigame.cn')) hostCandidates.push('hygncdn.babigame.cn');
  return freeze(hostCandidates.flatMap(host => [
    `https://${host}/index/index-gn-mix-${version}.json`,
    `https://${host}/index/index-${version}.json`,
  ]));
}

export function officialResourceConfigCandidates(index, indexUrl) {
  const base = officialPublicUrl(indexUrl);
  if (!base || !plainObject(index?.platformMap) || !plainObject(index.platformMap['*']) ||
      !Array.isArray(index.platformMap['*'].list)) return [];
  const paths = [...new Set(index.platformMap['*'].list.filter(value => typeof value === 'string' &&
    /^assets\/resources\/config\.[a-f0-9]{3,32}\.json$/.test(value)))];
  return freeze(paths.map(path => new URL('/' + path, base.origin).href));
}

export function officialGDataDescriptor(config) {
  if (!plainObject(config) || !plainObject(config.paths) || !(Array.isArray(config.uuids) || plainObject(config.uuids)) ||
      !plainObject(config.versions) || !Array.isArray(config.versions.native)) return null;
  const entries = config.versions.native;
  const versions = new Map();
  for (let index = 0; index + 1 < entries.length; index += 2) {
    if (Number.isSafeInteger(entries[index]) && typeof entries[index + 1] === 'string' && /^[a-f0-9]{3,32}$/.test(entries[index + 1])) {
      versions.set(String(entries[index]), entries[index + 1]);
    }
  }
  const matches = Object.entries(config.paths).filter(([, value]) => Array.isArray(value) && value.length >= 3 &&
    typeof value[0] === 'string' && /^mo\/zh\/data\/g-data$/.test(value[0]));
  if (matches.length !== 1) return null;
  const [id, pathRecord] = matches[0], uuid = config.uuids[id], nativeHash = versions.get(id);
  if (typeof uuid !== 'string' || !/^[0-9a-zA-Z/-]{1,80}$/.test(uuid) || !nativeHash) return null;
  return freeze({ logicalPath: pathRecord[0], uuid, nativeHash, nativeBase: config.nativeBase,
    uuidCompression: 'cocos-compact-uuid-requires-reviewed-expansion/v1' });
}

export function expandOfficialCocosUuid(value) {
  if (typeof value !== 'string') return null;
  const match = /^([0-9a-f]{2})([A-Za-z0-9+/]{20})$/.exec(value);
  if (!match) return null;
  let tail;
  try { tail = Buffer.from(match[2], 'base64'); } catch { return null; }
  if (tail.length !== 15 || tail.toString('base64').replace(/=+$/, '') !== match[2]) return null;
  const hex = match[1] + tail.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function officialGDataUrl(config, configUrl) {
  const descriptor = officialGDataDescriptor(config), base = officialPublicUrl(configUrl);
  if (!descriptor || !base || descriptor.nativeBase !== 'native') return null;
  const uuid = expandOfficialCocosUuid(descriptor.uuid);
  if (!uuid) return null;
  const path = `/assets/resources/native/${uuid.slice(0, 2)}/${uuid}.${descriptor.nativeHash}.text`;
  return new URL(path, base.origin).href;
}

async function boundedGet(url, { fetchImpl, signal, maxBytes = MAX_BYTES } = {}) {
  if (signal?.aborted) throw problem('OFFICIAL_PUBLIC_FETCH_CANCELLED', '官服公开资源读取已取消');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw problem('OFFICIAL_PUBLIC_SIZE_LIMIT_INVALID', '官服公开资源读取上限无效');
  const trusted = officialPublicUrl(url);
  if (!trusted) throw problem('OFFICIAL_PUBLIC_URL_REJECTED', '官服公开资源地址不在固定HTTPS来源范围内');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const relay = () => controller.abort();
  signal?.addEventListener('abort', relay, { once: true });
  try {
    const response = await fetchImpl(trusted.href, { method: 'GET', redirect: 'manual', signal: controller.signal,
      headers: { accept: 'application/json, application/octet-stream, text/plain' } });
    if (response.status >= 300 && response.status < 400) {
      const target = officialPublicUrl(new URL(response.headers.get('location') || '', trusted).href);
      if (!target || target.hostname !== trusted.hostname) throw problem('OFFICIAL_PUBLIC_REDIRECT_REJECTED', '官服公开资源跳转来源不匹配');
      throw problem('OFFICIAL_PUBLIC_REDIRECT_UNSUPPORTED', '官服公开资源发生跳转，需重新解析固定资源路径');
    }
    if (!response.ok) throw problem('OFFICIAL_PUBLIC_HTTP_FAILED', '官服公开资源暂不可用');
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw problem('OFFICIAL_PUBLIC_RESOURCE_TOO_LARGE', '官服公开资源超过读取上限');
    const reader = response.body?.getReader?.();
    if (!reader) throw problem('OFFICIAL_PUBLIC_BODY_MISSING', '官服公开资源没有响应内容');
    const chunks = []; let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw problem('OFFICIAL_PUBLIC_RESOURCE_TOO_LARGE', '官服公开资源超过读取上限'); }
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks, length);
    const contentType = String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (!/^(application\/(json|octet-stream)|text\/(plain|javascript))$/.test(contentType)) {
      throw problem('OFFICIAL_PUBLIC_CONTENT_TYPE_REJECTED', '官服公开资源类型不符合静态数据读取范围');
    }
    return { url: trusted.href, host: trusted.hostname, status: response.status, contentType,
      bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), fetchedAt: new Date().toISOString() };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', relay);
  }
}

function createCache(store) {
  if (!store?.db?.exec || !store.run || !store.get) throw new TypeError('Public-data cache requires backend store');
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_official_public_data_objects(
      sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64),content_type TEXT NOT NULL,source_host TEXT NOT NULL,
      byte_length INTEGER NOT NULL,body BLOB NOT NULL,first_seen TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS backend_official_public_data_objects_immutable_update BEFORE UPDATE ON backend_official_public_data_objects
      BEGIN SELECT RAISE(ABORT,'official public data objects are immutable'); END;
    CREATE TABLE IF NOT EXISTS backend_official_public_data_candidates(
      source_key TEXT NOT NULL,source_version TEXT NOT NULL,sha256 TEXT NOT NULL,observed_at TEXT NOT NULL,
      PRIMARY KEY(source_key,source_version,sha256),FOREIGN KEY(sha256) REFERENCES backend_official_public_data_objects(sha256));
    CREATE TABLE IF NOT EXISTS backend_official_public_data_sources(
      source_key TEXT NOT NULL,source_version TEXT NOT NULL,sha256 TEXT NOT NULL,source_url TEXT NOT NULL,source_host TEXT NOT NULL,
      content_type TEXT NOT NULL,observed_at TEXT NOT NULL,PRIMARY KEY(source_key,source_version,sha256,source_url));
    CREATE TABLE IF NOT EXISTS backend_official_public_data_resource_observations(
      observation_id INTEGER PRIMARY KEY AUTOINCREMENT,source_key TEXT NOT NULL,source_version TEXT NOT NULL,
      sha256 TEXT NOT NULL,source_url TEXT NOT NULL,observed_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS backend_official_public_data_resource_observations_latest
      ON backend_official_public_data_resource_observations(source_key,source_version,observation_id DESC);
    CREATE TRIGGER IF NOT EXISTS backend_official_public_data_resource_observations_no_update BEFORE UPDATE ON backend_official_public_data_resource_observations
      BEGIN SELECT RAISE(ABORT,'official public resource observations are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_official_public_data_resource_observations_no_delete BEFORE DELETE ON backend_official_public_data_resource_observations
      BEGIN SELECT RAISE(ABORT,'official public resource observations are immutable'); END;
    CREATE TABLE IF NOT EXISTS backend_official_public_data_candidate_attempts(
      attempt_ref TEXT PRIMARY KEY,source_key TEXT NOT NULL,source_version TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS backend_official_public_data_candidate_pins(
      attempt_ref TEXT NOT NULL,sha256 TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(attempt_ref,sha256));
    CREATE TABLE IF NOT EXISTS backend_official_public_data_heads(
      source_key TEXT NOT NULL,slot TEXT NOT NULL CHECK(slot IN ('current','last-good')),sha256 TEXT NOT NULL,
      source_version TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(source_key,slot),
      FOREIGN KEY(sha256) REFERENCES backend_official_public_data_objects(sha256));
    CREATE TABLE IF NOT EXISTS backend_official_public_data_validations(
      validation_ref TEXT PRIMARY KEY,source_key TEXT NOT NULL,sha256 TEXT NOT NULL,source_version TEXT NOT NULL,
      data_snapshot_id TEXT NOT NULL,contract_id TEXT NOT NULL,table_hashes_json TEXT NOT NULL,validated_at TEXT NOT NULL,
      FOREIGN KEY(sha256) REFERENCES backend_official_public_data_objects(sha256));
    CREATE TRIGGER IF NOT EXISTS backend_official_public_data_validations_no_update BEFORE UPDATE ON backend_official_public_data_validations
      BEGIN SELECT RAISE(ABORT,'official public data validations are immutable'); END;
    CREATE TABLE IF NOT EXISTS backend_official_public_data_bundles(
      bundle_ref TEXT PRIMARY KEY,source_key TEXT NOT NULL,source_version TEXT NOT NULL,bundle_json TEXT NOT NULL,validated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS backend_official_public_data_bundles_lookup
      ON backend_official_public_data_bundles(source_key,source_version,validated_at DESC);
    CREATE TRIGGER IF NOT EXISTS backend_official_public_data_bundles_no_update BEFORE UPDATE ON backend_official_public_data_bundles
      BEGIN SELECT RAISE(ABORT,'official public data bundles are immutable'); END;
    CREATE TABLE IF NOT EXISTS backend_official_public_data_validation_history(
      validation_ref TEXT PRIMARY KEY,source_key TEXT NOT NULL,sha256 TEXT NOT NULL,source_version TEXT NOT NULL,
      data_snapshot_id TEXT NOT NULL,contract_id TEXT NOT NULL,table_hashes_json TEXT NOT NULL,validated_at TEXT NOT NULL,
      retired_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS backend_official_public_data_validation_history_no_update BEFORE UPDATE ON backend_official_public_data_validation_history
      BEGIN SELECT RAISE(ABORT,'official public data validation history is immutable'); END;
    CREATE TABLE IF NOT EXISTS backend_official_public_data_bundle_history(
      bundle_ref TEXT PRIMARY KEY,source_key TEXT NOT NULL,source_version TEXT NOT NULL,bundle_json TEXT NOT NULL,
      validated_at TEXT NOT NULL,retired_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS backend_official_public_data_bundle_history_no_update BEFORE UPDATE ON backend_official_public_data_bundle_history
      BEGIN SELECT RAISE(ABORT,'official public data bundle history is immutable'); END;
    CREATE TABLE IF NOT EXISTS backend_official_public_data_retirements(
      sha256 TEXT PRIMARY KEY,byte_length INTEGER NOT NULL,reason_code TEXT NOT NULL,retired_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS backend_official_public_data_retirements_no_update BEFORE UPDATE ON backend_official_public_data_retirements
      BEGIN SELECT RAISE(ABORT,'official public data retirement records are immutable'); END;
    `);
  const staleAttemptBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  store.run(`DELETE FROM backend_official_public_data_candidate_pins WHERE attempt_ref IN
    (SELECT attempt_ref FROM backend_official_public_data_candidate_attempts WHERE created_at<?)`, staleAttemptBefore);
  store.run('DELETE FROM backend_official_public_data_candidate_attempts WHERE created_at<?', staleAttemptBefore);
  const latestResourceObservation = (sourceKey, sourceVersion) => {
    const current = store.get(`SELECT source_key,source_version,sha256,source_url,observed_at
      FROM backend_official_public_data_resource_observations WHERE source_key=? AND source_version=? ORDER BY observation_id DESC LIMIT 1`,
    sourceKey, sourceVersion);
    if (current) return current;
    const latestTime = store.get(`SELECT MAX(observed_at) AS observed_at FROM backend_official_public_data_sources
      WHERE source_key=? AND source_version=?`, sourceKey, sourceVersion)?.observed_at;
    if (!latestTime) return null;
    const latest = store.all(`SELECT sha256,MIN(source_url) AS source_url FROM backend_official_public_data_sources
      WHERE source_key=? AND source_version=? AND observed_at=? GROUP BY sha256 ORDER BY sha256`, sourceKey, sourceVersion, latestTime);
    if (latest.length !== 1) return { conflict: true, observedAt: latestTime };
    return { source_key: sourceKey, source_version: sourceVersion, sha256: latest[0].sha256,
      source_url: latest[0].source_url, observed_at: latestTime };
  };
  return Object.freeze({
    put: item => store.transaction(() => {
      const existing = store.get('SELECT byte_length,content_type,source_host FROM backend_official_public_data_objects WHERE sha256=?', item.sha256);
      if (existing) {
        const priorBytes = store.get('SELECT body FROM backend_official_public_data_objects WHERE sha256=?', item.sha256)?.body;
        if (existing.byte_length !== item.bytes.length || !priorBytes || crypto.createHash('sha256').update(priorBytes).digest('hex') !== item.sha256) {
          throw problem('OFFICIAL_PUBLIC_CACHE_CONFLICT', '相同官服公开资源指纹对应不同对象，保留旧缓存并停止应用');
        }
        store.run('INSERT OR IGNORE INTO backend_official_public_data_candidates(source_key,source_version,sha256,observed_at) VALUES(?,?,?,?)',
          item.sourceKey, item.sourceVersion, item.sha256, item.fetchedAt);
        store.run('INSERT OR IGNORE INTO backend_official_public_data_sources(source_key,source_version,sha256,source_url,source_host,content_type,observed_at) VALUES(?,?,?,?,?,?,?)',
          item.sourceKey, item.sourceVersion, item.sha256, item.url, item.host, item.contentType, item.fetchedAt);
        return { sha256: item.sha256, sourceKey: item.sourceKey, sourceVersion: item.sourceVersion };
      }
      const current = store.get('SELECT COALESCE(SUM(byte_length),0) AS bytes FROM backend_official_public_data_objects')?.bytes ?? 0;
      let totalBytes = current;
      if (totalBytes + item.bytes.length > MAX_CACHE_BYTES) {
        const reclaimable = store.all(`SELECT sha256,byte_length FROM backend_official_public_data_objects o
          WHERE NOT EXISTS(SELECT 1 FROM backend_official_public_data_heads h WHERE h.sha256=o.sha256)
          AND NOT EXISTS(SELECT 1 FROM backend_official_public_data_candidate_pins p WHERE p.sha256=o.sha256)
          AND NOT EXISTS(SELECT 1 FROM backend_official_public_data_bundles b WHERE
            json_extract(b.bundle_json,'$.resources.gdata.sha256') IN
              (SELECT sha256 FROM backend_official_public_data_heads WHERE source_key LIKE '%:g-data' AND slot IN ('current','last-good'))
            AND (json_extract(b.bundle_json,'$.resources.index.sha256')=o.sha256 OR
              json_extract(b.bundle_json,'$.resources.game.sha256')=o.sha256 OR
              json_extract(b.bundle_json,'$.resources.mo.sha256')=o.sha256 OR
              json_extract(b.bundle_json,'$.resources.config.sha256')=o.sha256 OR
              json_extract(b.bundle_json,'$.resources.gdata.sha256')=o.sha256))
          ORDER BY first_seen ASC,sha256 ASC`);
        for (const row of reclaimable) {
          if (totalBytes + item.bytes.length <= MAX_CACHE_BYTES) break;
          const retiredAt = store.nowIso();
          for (const validation of store.all(`SELECT * FROM backend_official_public_data_validations WHERE sha256=?`, row.sha256)) {
            store.run(`INSERT OR IGNORE INTO backend_official_public_data_validation_history(validation_ref,source_key,sha256,source_version,
              data_snapshot_id,contract_id,table_hashes_json,validated_at,retired_at) VALUES(?,?,?,?,?,?,?,?,?)`,
            validation.validation_ref, validation.source_key, validation.sha256, validation.source_version, validation.data_snapshot_id,
            validation.contract_id, validation.table_hashes_json, validation.validated_at, retiredAt);
            store.run('DELETE FROM backend_official_public_data_validations WHERE validation_ref=?', validation.validation_ref);
          }
          const bundles = store.all(`SELECT bundle_ref,source_key,source_version,bundle_json,validated_at FROM backend_official_public_data_bundles
            WHERE json_extract(bundle_json,'$.resources.gdata.sha256') NOT IN
              (SELECT sha256 FROM backend_official_public_data_heads WHERE source_key LIKE '%:g-data' AND slot IN ('current','last-good'))
            AND (json_extract(bundle_json,'$.resources.index.sha256')=? OR json_extract(bundle_json,'$.resources.game.sha256')=? OR
              json_extract(bundle_json,'$.resources.mo.sha256')=? OR json_extract(bundle_json,'$.resources.config.sha256')=? OR
              json_extract(bundle_json,'$.resources.gdata.sha256')=?)`, row.sha256, row.sha256, row.sha256, row.sha256, row.sha256);
          for (const bundle of bundles) {
            store.run(`INSERT OR IGNORE INTO backend_official_public_data_bundle_history(bundle_ref,source_key,source_version,bundle_json,validated_at,retired_at)
              VALUES(?,?,?,?,?,?)`, bundle.bundle_ref, bundle.source_key, bundle.source_version, bundle.bundle_json, bundle.validated_at, retiredAt);
            store.run('DELETE FROM backend_official_public_data_bundles WHERE bundle_ref=?', bundle.bundle_ref);
          }
          store.run('INSERT OR IGNORE INTO backend_official_public_data_retirements(sha256,byte_length,reason_code,retired_at) VALUES(?,?,?,?)',
            row.sha256, row.byte_length, 'OFFICIAL_PUBLIC_CACHE_EVICTED_UNREFERENCED', retiredAt);
          store.run('DELETE FROM backend_official_public_data_candidates WHERE sha256=?', row.sha256);
          store.run('DELETE FROM backend_official_public_data_objects WHERE sha256=?', row.sha256);
          totalBytes -= row.byte_length;
        }
      }
      if (totalBytes + item.bytes.length > MAX_CACHE_BYTES) throw problem('OFFICIAL_PUBLIC_CACHE_FULL', '官服静态数据缓存已达到上限，保留现有已验证快照');
      store.run('INSERT OR IGNORE INTO backend_official_public_data_objects(sha256,content_type,source_host,byte_length,body,first_seen) VALUES(?,?,?,?,?,?)',
        item.sha256, item.contentType, item.host, item.bytes.length, item.bytes, item.fetchedAt);
      store.run('INSERT OR IGNORE INTO backend_official_public_data_candidates(source_key,source_version,sha256,observed_at) VALUES(?,?,?,?)',
        item.sourceKey, item.sourceVersion, item.sha256, item.fetchedAt);
      store.run('INSERT OR IGNORE INTO backend_official_public_data_sources(source_key,source_version,sha256,source_url,source_host,content_type,observed_at) VALUES(?,?,?,?,?,?,?)',
        item.sourceKey, item.sourceVersion, item.sha256, item.url, item.host, item.contentType, item.fetchedAt);
      return { sha256: item.sha256, sourceKey: item.sourceKey, sourceVersion: item.sourceVersion };
    }),
    activate: ({ sourceKey, sourceVersion, sha256 } = {}) => store.transaction(() => {
      if (typeof sourceKey !== 'string' || !/^[a-z0-9._:-]{1,128}$/i.test(sourceKey) ||
          typeof sourceVersion !== 'string' || !/^[0-9]+(?:\.[0-9]+){1,5}$/.test(sourceVersion) ||
          typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
        throw problem('OFFICIAL_PUBLIC_ACTIVATION_INVALID', '未验证的官服公开资源不能激活');
      }
      const object = store.get(`SELECT sha256,data_snapshot_id,contract_id FROM backend_official_public_data_validations
        WHERE source_key=? AND source_version=? AND sha256=?`, sourceKey, sourceVersion, sha256);
      if (!object) throw problem('OFFICIAL_PUBLIC_CACHE_OBJECT_UNVALIDATED', '未通过结构与合同校验的官服公开数据不能激活');
      const prior = store.get("SELECT sha256,source_version FROM backend_official_public_data_heads WHERE source_key=? AND slot='current'", sourceKey);
      if (prior && prior.sha256 !== sha256) store.run(`INSERT INTO backend_official_public_data_heads(source_key,slot,sha256,source_version,updated_at)
        VALUES(?,'last-good',?,?,?) ON CONFLICT(source_key,slot) DO UPDATE SET sha256=excluded.sha256,
        source_version=excluded.source_version,updated_at=excluded.updated_at`, sourceKey, prior.sha256, prior.source_version, store.nowIso());
      store.run(`INSERT INTO backend_official_public_data_heads(source_key,slot,sha256,source_version,updated_at)
        VALUES(?,'current',?,?,?) ON CONFLICT(source_key,slot) DO UPDATE SET sha256=excluded.sha256,
        source_version=excluded.source_version,updated_at=excluded.updated_at`, sourceKey, sha256, sourceVersion, store.nowIso());
      return { sourceKey, sourceVersion, sha256, dataSnapshotId: object.data_snapshot_id,
        dataSchemaContractId: object.contract_id, contractId: OFFICIAL_CORE_CONTRACT_ID, active: true };
    }),
    attest: input => store.transaction(() => {
      const candidate = store.get(`SELECT 1 AS ok FROM backend_official_public_data_candidates
        WHERE source_key=? AND source_version=? AND sha256=?`, input.sourceKey, input.sourceVersion, input.sha256);
      if (!candidate) throw problem('OFFICIAL_PUBLIC_CANDIDATE_UNPROVEN', '当前数据对象没有对应的官方来源候选记录');
      const validationRef = 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
      store.run(`INSERT OR IGNORE INTO backend_official_public_data_validations(validation_ref,source_key,sha256,source_version,
        data_snapshot_id,contract_id,table_hashes_json,validated_at) VALUES(?,?,?,?,?,?,?,?)`, validationRef, input.sourceKey,
      input.sha256, input.sourceVersion, input.dataSnapshotId, input.contractId, JSON.stringify(input.tableHashes), store.nowIso());
      return validationRef;
    }),
    attestBundle: input => store.transaction(() => {
      const validId = value => typeof value === 'string' && /^[a-z0-9._:-]{1,128}$/i.test(value);
      const validVersion = value => typeof value === 'string' && /^[0-9]+(?:\.[0-9]+){1,5}$/.test(value);
      const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
      const names = ['index', 'game', 'mo', 'config', 'gdata'];
      const sourceSuffix = { index: 'index', game: 'source-game', mo: 'source-mo', config: 'config', gdata: 'g-data' };
      if (!validId(input?.sourceKey) || !validVersion(input?.sourceVersion) || !plainObject(input?.resources) ||
          names.some(name => !plainObject(input.resources[name]) || !validHash(input.resources[name].sha256) ||
            !validId(input.resources[name].sourceKey) || typeof input.resources[name].url !== 'string' || !officialPublicUrl(input.resources[name].url)) ||
          !plainObject(input?.sourceProofs) || input.contractId !== OFFICIAL_CORE_CONTRACT_ID ||
          input.dataSchemaContractId !== OFFICIAL_GDATA_SCHEMA_CONTRACT_ID || !validHash(input.dataSnapshotId) &&
            !(typeof input.dataSnapshotId === 'string' && /^sha256:[a-f0-9]{64}$/.test(input.dataSnapshotId)) ||
          !plainObject(input.tableHashes) || Object.entries(input.tableHashes).length > 64 ||
          Object.entries(input.tableHashes).some(([name, hash]) => !/^[a-zA-Z0-9_$-]{1,64}$/.test(name) || !validHash(hash)) ||
          !validHash(input.resources.index.sha256) || !validHash(input.sourceBlockContractSha256)) {
        throw problem('OFFICIAL_PUBLIC_BUNDLE_INVALID', '官服公开数据完整来源包缺少严格来源或合同证明');
      }
      for (const name of names) {
        const ref = input.resources[name];
        if (ref.sourceKey !== `${input.sourceKey}:${sourceSuffix[name]}`) throw problem('OFFICIAL_PUBLIC_BUNDLE_SOURCE_MISMATCH', '官服公开资源不属于同一来源包');
        const observed = latestResourceObservation(ref.sourceKey, input.sourceVersion);
        if (observed?.conflict === true || observed && observed.sha256 !== ref.sha256) {
          throw problem('OFFICIAL_PUBLIC_BUNDLE_SUPERSEDED', '当前已观察到更新的官服公开资源，旧来源包不能重新激活');
        }
        const source = store.get(`SELECT 1 AS ok FROM backend_official_public_data_sources
          WHERE source_key=? AND source_version=? AND sha256=? AND source_url=?`, ref.sourceKey, input.sourceVersion, ref.sha256, ref.url);
        const object = store.get('SELECT 1 AS ok FROM backend_official_public_data_objects WHERE sha256=?', ref.sha256);
        if (!source || !object) throw problem('OFFICIAL_PUBLIC_BUNDLE_RESOURCE_MISSING', '官服来源包引用了未缓存的原始公开资源');
      }
      const validation = store.get(`SELECT data_snapshot_id,contract_id,table_hashes_json FROM backend_official_public_data_validations
        WHERE source_key=? AND source_version=? AND sha256=? ORDER BY validated_at DESC LIMIT 1`,
        input.resources.gdata.sourceKey, input.sourceVersion, input.resources.gdata.sha256);
      if (!validation || validation.data_snapshot_id !== input.dataSnapshotId || validation.contract_id !== input.dataSchemaContractId ||
          canonical(JSON.parse(validation.table_hashes_json)) !== canonical(input.tableHashes)) {
        throw problem('OFFICIAL_PUBLIC_BUNDLE_VALIDATION_MISMATCH', '官服来源包与当前静态数据结构校验收据不匹配');
      }
      const bundle = { version: 'official-public-data-bundle/v1', sourceKey: input.sourceKey, sourceVersion: input.sourceVersion,
        resources: input.resources, sourceProofs: input.sourceProofs, contractId: input.contractId,
        dataSchemaContractId: input.dataSchemaContractId, dataSnapshotId: input.dataSnapshotId,
        tableHashes: input.tableHashes, sourceBlockContractSha256: input.sourceBlockContractSha256 };
      const bundleJson = canonical(bundle), bundleRef = 'sha256:' + crypto.createHash('sha256').update(bundleJson).digest('hex');
      store.run(`INSERT OR IGNORE INTO backend_official_public_data_bundles(bundle_ref,source_key,source_version,bundle_json,validated_at)
        VALUES(?,?,?,?,?)`, bundleRef, input.sourceKey, input.sourceVersion, bundleJson, store.nowIso());
      return bundleRef;
    }),
    latestBundle: (sourceKey, sourceVersion, resourceSha256) => {
      const heads = store.all(`SELECT sha256 FROM backend_official_public_data_heads
        WHERE source_key=? AND slot IN ('current','last-good')`, `${sourceKey}:g-data`);
      if (!heads.some(head => head.sha256 === resourceSha256)) return null;
      const rows = store.all(`SELECT bundle_ref,bundle_json,validated_at FROM backend_official_public_data_bundles
        WHERE source_key=? AND source_version=? ORDER BY validated_at DESC,bundle_ref DESC LIMIT 16`, sourceKey, sourceVersion);
      for (const row of rows) {
        if ('sha256:' + crypto.createHash('sha256').update(row.bundle_json).digest('hex') !== row.bundle_ref) continue;
        let bundle;
        try { bundle = JSON.parse(row.bundle_json); } catch { continue; }
        if (bundle?.version !== 'official-public-data-bundle/v1' || bundle.sourceKey !== sourceKey || bundle.sourceVersion !== sourceVersion ||
            bundle.resources?.gdata?.sha256 !== resourceSha256) continue;
        let complete = true;
        for (const name of ['index', 'game', 'mo', 'config', 'gdata']) {
          const ref = bundle.resources?.[name], resource = ref && store.get(`SELECT source_host,content_type,byte_length,body FROM backend_official_public_data_objects WHERE sha256=?`, ref.sha256);
          const observed = ref && latestResourceObservation(ref.sourceKey, sourceVersion);
          const source = ref && store.get(`SELECT 1 AS ok FROM backend_official_public_data_sources
            WHERE source_key=? AND source_version=? AND sha256=? AND source_url=?`, ref.sourceKey, sourceVersion, ref.sha256, ref.url);
          const sourceSuffix = { index: 'index', game: 'source-game', mo: 'source-mo', config: 'config', gdata: 'g-data' };
          if (!ref || ref.sourceKey !== `${sourceKey}:${sourceSuffix[name]}` || observed?.conflict === true ||
              observed && observed.sha256 !== ref.sha256 || !source || !resource || resource.byte_length !== resource.body.length ||
              crypto.createHash('sha256').update(resource.body).digest('hex') !== ref.sha256) { complete = false; break; }
        }
        if (!complete) continue;
        return freeze({ bundleRef: row.bundle_ref, validatedAt: row.validated_at, ...bundle });
      }
      return null;
    },
    bundleByRef: bundleRef => {
      if (typeof bundleRef !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(bundleRef)) return null;
      const row = store.get(`SELECT bundle_ref,source_key,source_version,bundle_json,validated_at,0 AS retired
        FROM backend_official_public_data_bundles WHERE bundle_ref=? UNION ALL
        SELECT bundle_ref,source_key,source_version,bundle_json,validated_at,1 AS retired
        FROM backend_official_public_data_bundle_history WHERE bundle_ref=? LIMIT 1`, bundleRef, bundleRef);
      if (!row || 'sha256:' + crypto.createHash('sha256').update(row.bundle_json).digest('hex') !== row.bundle_ref) return null;
      let bundle;
      try { bundle = JSON.parse(row.bundle_json); } catch { return null; }
      if (bundle?.sourceKey !== row.source_key || bundle?.sourceVersion !== row.source_version) return null;
      return freeze({ bundleRef: row.bundle_ref, validatedAt: row.validated_at, retired: row.retired === 1, ...bundle });
    },
    validationByRef: validationRef => {
      if (typeof validationRef !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(validationRef)) return null;
      const row = store.get(`SELECT validation_ref,source_key,sha256,source_version,data_snapshot_id,contract_id,table_hashes_json,validated_at,0 AS retired
        FROM backend_official_public_data_validations WHERE validation_ref=? UNION ALL
        SELECT validation_ref,source_key,sha256,source_version,data_snapshot_id,contract_id,table_hashes_json,validated_at,1 AS retired
        FROM backend_official_public_data_validation_history WHERE validation_ref=? LIMIT 1`, validationRef, validationRef);
      if (!row) return null;
      let tableHashes;
      try { tableHashes = JSON.parse(row.table_hashes_json); } catch { return null; }
      return freeze({ validationRef: row.validation_ref, sourceKey: row.source_key, sha256: row.sha256,
        sourceVersion: row.source_version, dataSnapshotId: row.data_snapshot_id, contractId: row.contract_id,
        tableHashes, validatedAt: row.validated_at, retired: row.retired === 1 });
    },
    latest: (sourceKey, slot = 'current') => store.get(`SELECT h.source_key,h.sha256,h.source_version,h.updated_at,o.content_type,o.byte_length,o.body,
      (SELECT v.data_snapshot_id FROM backend_official_public_data_validations v WHERE v.source_key=h.source_key AND v.source_version=h.source_version AND v.sha256=h.sha256 ORDER BY v.validated_at DESC LIMIT 1) AS data_snapshot_id,
      (SELECT v.contract_id FROM backend_official_public_data_validations v WHERE v.source_key=h.source_key AND v.source_version=h.source_version AND v.sha256=h.sha256 ORDER BY v.validated_at DESC LIMIT 1) AS contract_id
      FROM backend_official_public_data_heads h JOIN backend_official_public_data_objects o USING(sha256)
      WHERE h.source_key=? AND h.slot=?`, sourceKey, slot),
    activatedHead: (sourceKey, sourceVersion) => {
      for (const slot of ['current', 'last-good']) {
        const row = store.get(`SELECT source_key,sha256,source_version,updated_at FROM backend_official_public_data_heads
          WHERE source_key=? AND slot=?`, sourceKey, slot);
        if (row?.source_version === sourceVersion) return freeze({ ...row, slot });
      }
      return null;
    },
    candidateBody: (sourceKey, sourceVersion, sha256) => {
      const candidate = store.get(`SELECT 1 AS ok FROM backend_official_public_data_candidates
        WHERE source_key=? AND source_version=? AND sha256=?`, sourceKey, sourceVersion, sha256);
      if (!candidate) return null;
      return store.get('SELECT body,content_type,byte_length FROM backend_official_public_data_objects WHERE sha256=?', sha256);
    },
    cachedSource: ({ sourceKey, sourceVersion, url, maxBytes }) => {
      const row = store.get(`SELECT s.sha256,s.source_host,s.content_type,s.observed_at,o.body,o.byte_length
        FROM backend_official_public_data_sources s JOIN backend_official_public_data_objects o USING(sha256)
        WHERE s.source_key=? AND s.source_version=? AND s.source_url=? ORDER BY s.observed_at DESC LIMIT 1`,
      sourceKey, sourceVersion, url);
      if (!row || row.byte_length > maxBytes || !row.body || crypto.createHash('sha256').update(row.body).digest('hex') !== row.sha256) return null;
      return { sourceKey, sourceVersion, sha256: row.sha256, sourceHost: row.source_host, contentType: row.content_type,
        byteLength: row.byte_length, fetchedAt: row.observed_at, url, fresh: false, cached: true, bytes: Buffer.from(row.body) };
    },
    noteResourceObservation: ({ sourceKey, sourceVersion, sha256, url, observedAt }) => {
      if (typeof sourceKey !== 'string' || !/^[a-z0-9._:-]{1,128}$/i.test(sourceKey) ||
          typeof sourceVersion !== 'string' || !/^[0-9]+(?:\.[0-9]+){1,5}$/.test(sourceVersion) ||
          !/^[a-f0-9]{64}$/.test(sha256 || '') || typeof observedAt !== 'string' || !officialPublicUrl(url)) {
        throw problem('OFFICIAL_PUBLIC_INDEX_OBSERVATION_INVALID', '公开索引网络观测记录无效');
      }
      store.run(`INSERT INTO backend_official_public_data_resource_observations(source_key,source_version,sha256,source_url,observed_at)
        VALUES(?,?,?,?,?)`, sourceKey, sourceVersion, sha256, url, observedAt);
      return true;
    },
    beginCandidateAttempt: (sourceKey, sourceVersion) => {
      const attemptRef = newId();
      store.run(`INSERT INTO backend_official_public_data_candidate_attempts(attempt_ref,source_key,source_version,created_at)
        VALUES(?,?,?,?)`, attemptRef, sourceKey, sourceVersion, store.nowIso());
      return attemptRef;
    },
    pinCandidate: (attemptRef, sha256) => {
      if (typeof attemptRef !== 'string' || !/^[a-f0-9-]{36}$/.test(attemptRef) || !/^[a-f0-9]{64}$/.test(sha256 || '') ||
          !store.get('SELECT 1 AS ok FROM backend_official_public_data_candidate_attempts WHERE attempt_ref=?', attemptRef)) return false;
      store.run(`INSERT OR IGNORE INTO backend_official_public_data_candidate_pins(attempt_ref,sha256,created_at) VALUES(?,?,?)`,
        attemptRef, sha256, store.nowIso());
      return true;
    },
    releaseCandidateAttempt: attemptRef => store.transaction(() => {
      store.run('DELETE FROM backend_official_public_data_candidate_pins WHERE attempt_ref=?', attemptRef);
      store.run('DELETE FROM backend_official_public_data_candidate_attempts WHERE attempt_ref=?', attemptRef);
      return true;
    }),
    latestResourceObservation,
  });
}

export function createOfficialPublicDataCache({ store, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Public-data updater requires fetch');
  const cache = createCache(store);
  const landAccelerationDerived = new Map();
  const waterwheelDerived = new Map();
  const freeWaterDerived = new Map();
  const specialOrdersDerived = new Map();
  const flowerRackDerived = new Map();
  const businessTables = new Map();
  const flowerRackPriceDerived = new Map();
  const artFirstRewardDerived = new Map();
  const serverVersionDerived = new Map();
  let synchronousBundleReadScope = null;
  function withSynchronousBundleRead(callback) {
    if (typeof callback !== 'function') throw new TypeError('Bundle-read scope requires a synchronous callback');
    const parent = synchronousBundleReadScope;
    const scope = { entries: new Map() };
    synchronousBundleReadScope = scope;
    try {
      const result = callback();
      if (result?.then) { result.catch?.(() => {}); throw problem('OFFICIAL_PUBLIC_BUNDLE_SCOPE_ASYNC', '官服来源复核作用域必须同步完成', 500); }
      return result;
    } finally {
      scope.entries.clear();
      synchronousBundleReadScope = parent;
      if (parent) parent.entries.clear();
    }
  }
  return Object.freeze({
    async fetchResource({ sourceKey, sourceVersion, url, signal, maxBytes = MAX_BYTES, attemptRef = null } = {}) {
      if (typeof sourceKey !== 'string' || !/^[a-z0-9._:-]{1,128}$/i.test(sourceKey) ||
          typeof sourceVersion !== 'string' || !/^[0-9]+(?:\.[0-9]+){1,5}$/.test(sourceVersion)) {
        throw problem('OFFICIAL_PUBLIC_SOURCE_ID_INVALID', '官服公开资源来源标识不合法');
      }
      const safeUrl = officialPublicUrl(url);
      if (!safeUrl) throw problem('OFFICIAL_PUBLIC_URL_REJECTED', '官服公开资源地址不在固定HTTPS来源范围内');
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw problem('OFFICIAL_PUBLIC_SIZE_LIMIT_INVALID', '官服公开资源读取上限无效');
      const flightKey = safeUrl.href;
      let promise = FLIGHT.get(flightKey);
      if (!promise) {
        // One caller's cancellation/size limit must not cancel or narrow a
        // shared request for other account-scoped subscribers.
        promise = boundedGet(flightKey, { fetchImpl, maxBytes: MAX_BYTES }); FLIGHT.set(flightKey, promise);
        promise.finally(() => { if (FLIGHT.get(flightKey) === promise) FLIGHT.delete(flightKey); }).catch(() => {});
      }
      try {
        const item = await waitForSubscriber(promise, signal);
        if (item.bytes.length > maxBytes) throw problem('OFFICIAL_PUBLIC_RESOURCE_TOO_LARGE', '官服公开资源超过当前读取上限');
        if (attemptRef && !cache.pinCandidate(attemptRef, item.sha256)) throw problem('OFFICIAL_PUBLIC_CANDIDATE_PIN_FAILED', '公开数据候选资源无法在缓存重整期间保留');
        cache.put({ ...item, sourceKey, sourceVersion });
        cache.noteResourceObservation({ sourceKey, sourceVersion, sha256: item.sha256, url: item.url, observedAt: item.fetchedAt });
        return freeze({ sourceKey, sourceVersion, sha256: item.sha256, contentType: item.contentType,
          byteLength: item.bytes.length, fresh: true, active: false, fetchedAt: item.fetchedAt, sourceHost: item.host, url: item.url });
      } catch (error) {
        const previous = cache.latest(sourceKey);
        if (!previous) throw error;
        // Stale data is surfaced as stale and is never rebound as current.
        return freeze({ sourceKey, sha256: previous.sha256, sourceVersion: previous.source_version,
          contentType: previous.content_type, byteLength: previous.byte_length, fresh: false,
          stale: true, reasonCode: typeof error?.code === 'string' ? error.code : 'OFFICIAL_PUBLIC_FETCH_FAILED' });
      }
    },
    async fetchAndActivateSnapshot({ sourceKey, publicResources, signal, isCurrent = null } = {}) {
      const sourceVersion = publicResources?.gameVersion;
      if (typeof sourceKey !== 'string' || !/^[a-z0-9._:-]{1,128}$/i.test(sourceKey) ||
          typeof sourceVersion !== 'string' || !/^[0-9]+(?:\.[0-9]+){1,5}$/.test(sourceVersion) ||
          publicResources?.source !== 'normal-auth-package-hop-public-config/v1') {
        throw problem('OFFICIAL_PUBLIC_SOURCE_EVIDENCE_MISSING', '当前登录没有可核对的官服公开资源来源');
      }
      const assertCurrent = () => {
        if (signal?.aborted) throw problem('OFFICIAL_PUBLIC_FETCH_CANCELLED', '官服公开资源读取已取消');
        if (isCurrent !== null && (typeof isCurrent !== 'function' || isCurrent() !== true)) {
          throw problem('OFFICIAL_PUBLIC_REFRESH_CONTEXT_REVOKED', '旧连接不能激活官服公开数据');
        }
      };
      const attemptRef = cache.beginCandidateAttempt(sourceKey, sourceVersion);
      let indexBoundCacheReusable = false;
      let indexResponseObserved = false;
      let observedIndexSha256 = null;
      const fetchParsed = async (url, kind, maxBytes = 4 * 1024 * 1024) => {
        const resourceKey = `${sourceKey}:${kind}`;
        const previousIndex = kind === 'index' ? cache.cachedSource({ sourceKey: resourceKey, sourceVersion, url, maxBytes }) : null;
        let receipt;
        if (kind === 'index') receipt = await this.fetchResource({ sourceKey: resourceKey, sourceVersion, url, signal, maxBytes, attemptRef });
        else {
          const cached = indexBoundCacheReusable ? cache.cachedSource({ sourceKey: resourceKey, sourceVersion, url, maxBytes }) : null;
          if (cached) cache.pinCandidate(attemptRef, cached.sha256);
          receipt = cached || await this.fetchResource({ sourceKey: resourceKey, sourceVersion, url, signal, maxBytes, attemptRef });
        }
        if ((!receipt.fresh && receipt.cached !== true) || receipt.active) throw problem('OFFICIAL_PUBLIC_RESOURCE_NOT_FRESH', '官服公开资源未取得新的完整来源字节');
        const row = receipt.bytes ? { bytes: receipt.bytes } : this.cachedBody(receipt.sha256);
        if (!row) throw problem('OFFICIAL_PUBLIC_CACHE_BODY_MISSING', '官服公开资源缓存校验失败');
        return { receipt, body: row.bytes, previousSha256: previousIndex?.sha256 ?? null };
      };
      const revalidateCachedBundle = (requiredIndexSha256 = null) => {
        assertCurrent();
        for (const indexUrl of officialIndexCandidates(publicResources)) {
          assertCurrent();
          const indexReceipt = cache.cachedSource({ sourceKey: `${sourceKey}:index`, sourceVersion, url: indexUrl, maxBytes: 512 * 1024 });
          if (!indexReceipt) continue;
          if (requiredIndexSha256 && indexReceipt.sha256 !== requiredIndexSha256) continue;
          const latestObserved = cache.latestResourceObservation(`${sourceKey}:index`, sourceVersion);
          if (latestObserved?.conflict === true || latestObserved && latestObserved.sha256 !== indexReceipt.sha256) continue;
          const index = parseOfficialStaticJson(indexReceipt.bytes, { maxBytes: 512 * 1024 });
          if (!plainObject(index) || index.version !== sourceVersion) continue;
          const moduleVersions = index.platformMap?.['*']?.moduleJscVerMap;
          const readCachedModule = moduleName => {
            const version = moduleVersions?.[moduleName];
            if (typeof version !== 'string' || !/^[a-f0-9]{3,32}$/.test(version)) return null;
            const url = new URL(`/src/assets/scripts/frameworks/${moduleName}/bin/${moduleName}.${version}.jsc`,
              new URL(indexReceipt.url).origin).href;
            const receipt = cache.cachedSource({ sourceKey: `${sourceKey}:source-${moduleName}`, sourceVersion, url, maxBytes: MAX_BYTES });
            if (!receipt) return null;
            cache.pinCandidate(attemptRef, receipt.sha256);
            return { version, receipt, decoded: decodeOfficialJsc(receipt.bytes, index.jk) };
          };
          const game = readCachedModule('game'), mo = readCachedModule('mo');
          if (!game || !mo) continue;
          const sourceProofs = freeze(Object.fromEntries(Object.entries(proveOfficialSourceActions({ gameVersion: sourceVersion,
            protocolVersion: '480.0.0', index, gameBytes: game.decoded, moBytes: mo.decoded, indexSha256: indexReceipt.sha256 }))
            .map(([action, proof]) => [action, freeze({ ...proof, gameResourceSha256: game.receipt.sha256,
              gameModuleVersion: game.version, moResourceSha256: mo.receipt.sha256, moModuleVersion: mo.version,
              sourceBlockContractSha256: sourceProofContractBytesHash() })])));
          const configUrls = officialResourceConfigCandidates(index, indexReceipt.url);
          let configResult = null;
          for (const url of configUrls.slice(0, 4)) {
            const receipt = cache.cachedSource({ sourceKey: `${sourceKey}:config`, sourceVersion, url, maxBytes: 4 * 1024 * 1024 });
            if (!receipt) continue;
            cache.pinCandidate(attemptRef, receipt.sha256);
            const config = parseOfficialStaticJson(receipt.bytes);
            if (officialGDataDescriptor(config)) { configResult = { receipt, config }; break; }
          }
          if (!configResult) continue;
          const dataUrl = officialGDataUrl(configResult.config, configResult.receipt.url);
          if (!dataUrl) continue;
          const dataReceipt = cache.cachedSource({ sourceKey: `${sourceKey}:g-data`, sourceVersion, url: dataUrl, maxBytes: MAX_BYTES });
          if (!dataReceipt) continue;
          cache.pinCandidate(attemptRef, dataReceipt.sha256);
          assertCurrent();
          const validationRef = this.validateGDataSnapshot({ sourceKey: `${sourceKey}:g-data`, sourceVersion, sha256: dataReceipt.sha256 });
          const decoded = this.readValidatedDataSnapshot(`${sourceKey}:g-data`, sourceVersion, dataReceipt.sha256);
          if (!decoded || decoded.dataSchemaContractId !== OFFICIAL_GDATA_SCHEMA_CONTRACT_ID) continue;
          assertCurrent();
          const bundleRef = cache.attestBundle({ sourceKey, sourceVersion, resources: {
            index: { sourceKey: indexReceipt.sourceKey, sha256: indexReceipt.sha256, url: indexReceipt.url },
            game: { sourceKey: game.receipt.sourceKey, sha256: game.receipt.sha256, url: game.receipt.url },
            mo: { sourceKey: mo.receipt.sourceKey, sha256: mo.receipt.sha256, url: mo.receipt.url },
            config: { sourceKey: configResult.receipt.sourceKey, sha256: configResult.receipt.sha256, url: configResult.receipt.url },
            gdata: { sourceKey: dataReceipt.sourceKey, sha256: dataReceipt.sha256, url: dataReceipt.url },
          }, sourceProofs, contractId: OFFICIAL_CORE_CONTRACT_ID, dataSchemaContractId: decoded.dataSchemaContractId,
            dataSnapshotId: decoded.dataSnapshotId, tableHashes: decoded.tableHashes,
            sourceBlockContractSha256: sourceProofContractBytesHash() });
          assertCurrent();
          const activated = this.activate({ sourceKey: `${sourceKey}:g-data`, sourceVersion, sha256: dataReceipt.sha256 });
          return freeze({ ...activated, sourceIndexSha256: indexReceipt.sha256, sourceConfigSha256: configResult.receipt.sha256,
            sourceProofs, resourceSha256: dataReceipt.sha256, validationRef, bundleRef, fresh: false, stale: true,
            usableValidatedCache: true, cacheState: 'revalidated-cache',
            reasonCode: typeof lastError?.code === 'string' ? lastError.code : 'OFFICIAL_PUBLIC_REFRESH_UNAVAILABLE' });
        }
        return null;
      };
      let lastError = null;
      try {
        assertCurrent();
        let indexResult = null;
        for (const url of officialIndexCandidates(publicResources)) {
          try {
            const fetched = await fetchParsed(url, 'index', 512 * 1024);
            if (fetched.receipt.fresh === true && fetched.receipt.cached !== true) {
              indexResponseObserved = true;
              observedIndexSha256 = fetched.receipt.sha256;
            }
            assertCurrent();
            const index = parseOfficialStaticJson(fetched.body, { maxBytes: 512 * 1024 });
            if (!plainObject(index) || index.version !== sourceVersion) throw problem('OFFICIAL_PUBLIC_INDEX_VERSION_MISMATCH', '官服公开索引版本与本次登录来源不匹配');
            indexBoundCacheReusable = fetched.previousSha256 === fetched.receipt.sha256;
            indexResult = { ...fetched, index }; break;
          } catch (error) { lastError = error; }
        }
        if (!indexResult) {
          // Only a transport-unavailable index may use a locally revalidated
          // same-source-version bundle. A successfully observed but rejected
          // index is newer evidence and must never be hidden by an older cache.
          if (!indexResponseObserved) {
            const cached = revalidateCachedBundle();
            if (cached) return cached;
          }
          throw lastError || problem('OFFICIAL_PUBLIC_INDEX_UNAVAILABLE', '官服公开索引暂不可用');
        }
        let sourceProofs = null;
        let game = null, mo = null;
        try {
          const moduleVersions = indexResult.index.platformMap?.['*']?.moduleJscVerMap;
          const readModule = async moduleName => {
            const version = moduleVersions?.[moduleName];
            if (typeof version !== 'string' || !/^[a-f0-9]{3,32}$/.test(version)) {
              throw problem('OFFICIAL_SOURCE_MODULE_NOT_INDEXED', '官服公开索引缺少当前源码模块');
            }
            const url = new URL(`/src/assets/scripts/frameworks/${moduleName}/bin/${moduleName}.${version}.jsc`,
              new URL(indexResult.receipt.url).origin).href;
            const resourceKey = `${sourceKey}:source-${moduleName}`;
            let receipt = indexBoundCacheReusable && cache.cachedSource({ sourceKey: resourceKey, sourceVersion, url, maxBytes: MAX_BYTES });
            if (receipt) cache.pinCandidate(attemptRef, receipt.sha256);
            else receipt = await this.fetchResource({ sourceKey: resourceKey, sourceVersion, url, signal, maxBytes: MAX_BYTES, attemptRef });
            if ((!receipt.fresh && receipt.cached !== true) || receipt.active) throw problem('OFFICIAL_SOURCE_MODULE_NOT_FRESH', '官服源码没有取得可由当前索引证明的公开字节');
            const body = receipt.bytes ? { bytes: receipt.bytes } : this.cachedBody(receipt.sha256);
            if (!body) throw problem('OFFICIAL_SOURCE_MODULE_CACHE_MISSING', '官服源码缓存字节不可读取');
            return { version, receipt, decoded: decodeOfficialJsc(body.bytes, indexResult.index.jk) };
          };
          assertCurrent();
          [game, mo] = await Promise.all([readModule('game'), readModule('mo')]);
          assertCurrent();
          sourceProofs = proveOfficialSourceActions({ gameVersion: sourceVersion, protocolVersion: '480.0.0',
            index: indexResult.index, gameBytes: game.decoded, moBytes: mo.decoded, indexSha256: indexResult.receipt.sha256 });
          sourceProofs = freeze(Object.fromEntries(Object.entries(sourceProofs).map(([action, proof]) => [action, freeze({
            ...proof, gameResourceSha256: game.receipt.sha256, gameModuleVersion: game.version,
            moResourceSha256: mo.receipt.sha256, moModuleVersion: mo.version,
            sourceBlockContractSha256: sourceProofContractBytesHash() })])));
        } catch (error) {
          const reasonCode = typeof error?.code === 'string' ? error.code : 'OFFICIAL_SOURCE_PROOF_UNAVAILABLE';
          sourceProofs = freeze(Object.fromEntries(['land.plant', 'land.water', 'land.harvest'].map(action => [action,
            freeze({ supported: false, reasonCode, sourceVersion, protocolVersion: '480.0.0',
              indexSha256: indexResult.receipt.sha256, sourceBlockContractSha256: sourceProofContractBytesHash() })])));
        }
        const configUrls = officialResourceConfigCandidates(indexResult.index, indexResult.receipt.url);
        if (!configUrls.length) throw problem('OFFICIAL_PUBLIC_CONFIG_NOT_INDEXED', '公开索引没有可验证的资源配置入口');
        let configResult = null;
        for (const url of configUrls.slice(0, 4)) {
          try {
            const fetched = await fetchParsed(url, 'config');
            assertCurrent();
            const config = parseOfficialStaticJson(fetched.body);
            if (!officialGDataDescriptor(config)) throw problem('OFFICIAL_PUBLIC_CONFIG_CONTRACT_UNSUPPORTED', '资源配置缺少已核对的数据表入口');
            configResult = { ...fetched, config }; break;
          } catch (error) { lastError = error; }
        }
        if (!configResult) throw lastError || problem('OFFICIAL_PUBLIC_CONFIG_UNAVAILABLE', '官服资源配置暂不可用');
        const dataUrl = officialGDataUrl(configResult.config, configResult.receipt.url);
        if (!dataUrl) throw problem('OFFICIAL_PUBLIC_GDATA_URL_UNSUPPORTED', '官服数据表资源地址格式尚未纳入固定解析合同');
        const data = await fetchParsed(dataUrl, 'g-data', MAX_BYTES);
        assertCurrent();
        const validationRef = this.validateGDataSnapshot({ sourceKey: `${sourceKey}:g-data`, sourceVersion, sha256: data.receipt.sha256 });
        const decodedData = this.readValidatedDataSnapshot(`${sourceKey}:g-data`, sourceVersion, data.receipt.sha256);
        if (!decodedData || decodedData.dataSchemaContractId !== OFFICIAL_GDATA_SCHEMA_CONTRACT_ID) {
          throw problem('OFFICIAL_PUBLIC_VALIDATION_RECEIPT_MISSING', '本次候选静态数据没有匹配的结构校验收据');
        }
        if (!game?.receipt || !mo?.receipt) throw problem('OFFICIAL_PUBLIC_SOURCE_MODULE_UNAVAILABLE', '当前来源包缺少可校验的game/mo原始模块');
        assertCurrent();
        const bundleRef = cache.attestBundle({ sourceKey, sourceVersion, resources: {
          index: { sourceKey: indexResult.receipt.sourceKey, sha256: indexResult.receipt.sha256, url: indexResult.receipt.url },
          game: { sourceKey: game.receipt.sourceKey, sha256: game.receipt.sha256, url: game.receipt.url },
          mo: { sourceKey: mo.receipt.sourceKey, sha256: mo.receipt.sha256, url: mo.receipt.url },
          config: { sourceKey: configResult.receipt.sourceKey, sha256: configResult.receipt.sha256, url: configResult.receipt.url },
          gdata: { sourceKey: data.receipt.sourceKey, sha256: data.receipt.sha256, url: data.receipt.url },
        }, sourceProofs, contractId: OFFICIAL_CORE_CONTRACT_ID, dataSchemaContractId: OFFICIAL_GDATA_SCHEMA_CONTRACT_ID,
          dataSnapshotId: decodedData.dataSnapshotId,
          tableHashes: decodedData.tableHashes,
          sourceBlockContractSha256: sourceProofContractBytesHash() });
        const activated = this.activate({ sourceKey: `${sourceKey}:g-data`, sourceVersion, sha256: data.receipt.sha256 });
        return freeze({ ...activated, sourceIndexSha256: indexResult.receipt.sha256, sourceProofs,
          sourceConfigSha256: configResult.receipt.sha256, resourceSha256: data.receipt.sha256,
          validationRef, bundleRef, fresh: true, stale: false });
      } catch (error) {
        if (!signal?.aborted && (!isCurrent || isCurrent() === true) && indexResponseObserved && observedIndexSha256) {
          const cached = revalidateCachedBundle(observedIndexSha256);
          if (cached) return cached;
        }
        const previous = this.latest(`${sourceKey}:g-data`) || this.latest(`${sourceKey}:g-data`, 'last-good');
        if (!previous) throw error;
        return freeze({ sourceKey: `${sourceKey}:g-data`, sha256: previous.sha256,
          sourceVersion: previous.source_version, dataSnapshotId: previous.data_snapshot_id ?? null,
          dataSchemaContractId: previous.contract_id ?? null, contractId: OFFICIAL_CORE_CONTRACT_ID,
          fresh: false, stale: true,
          reasonCode: typeof error?.code === 'string' ? error.code : 'OFFICIAL_PUBLIC_REFRESH_FAILED' });
      } finally { cache.releaseCandidateAttempt(attemptRef); }
    },
    activate: cache.activate,
    activatedHead: cache.activatedHead,
    latest: cache.latest,
    withSynchronousBundleRead,
    isCurrentBundleBinding: identity => {
      const scope = synchronousBundleReadScope;
      const scopeKey = JSON.stringify([identity?.bundleSourceKey ?? null, identity?.indexVersion ?? null,
        identity?.bundleRef ?? null, identity?.resourceSha256 ?? null, identity?.sourceIndexSha256 ?? null,
        identity?.loginResponseRef ?? null, identity?.protocolVersion ?? null, identity?.dataSnapshotId ?? null,
        identity?.contractId ?? null, identity?.dataSchemaContractId ?? null]);
      const cached = identity && typeof identity === 'object' ? scope?.entries.get(identity) : null;
      if (cached?.key === scopeKey) return cached.value;
      const current = (() => {
      const sourceKey = identity?.bundleSourceKey, sourceVersion = identity?.indexVersion;
      const bundleRef = identity?.bundleRef, resourceSha256 = identity?.resourceSha256;
      if (typeof sourceKey !== 'string' || typeof sourceVersion !== 'string' ||
          typeof bundleRef !== 'string' || typeof resourceSha256 !== 'string') return false;
      const bundle = cache.bundleByRef(bundleRef);
      if (!bundle || bundle.retired || bundle.sourceKey !== sourceKey || bundle.sourceVersion !== sourceVersion ||
          bundle.sourceBlockContractSha256 !== sourceProofContractBytesHash() || bundle.resources?.gdata?.sha256 !== resourceSha256 ||
          bundle.resources?.index?.sha256 !== identity.sourceIndexSha256) return false;
      const active = cache.activatedHead(`${sourceKey}:g-data`, sourceVersion);
      if (!active || active.sha256 !== resourceSha256) return false;
      for (const name of ['index', 'game', 'mo', 'config', 'gdata']) {
        const resource = bundle.resources[name], observed = cache.latestResourceObservation(resource?.sourceKey, sourceVersion);
        if (!resource || observed?.conflict === true || observed && observed.sha256 !== resource.sha256) return false;
      }
      return true;
      })();
      if (scope && identity && typeof identity === 'object') scope.entries.set(identity, { key: scopeKey, value: current });
      return current;
    },
    validateGDataSnapshot: ({ sourceKey, sourceVersion, sha256 } = {}) => {
      const candidateRow = cache.candidateBody(sourceKey, sourceVersion, sha256);
      const candidate = candidateRow?.body ? { bytes: Buffer.from(candidateRow.body), byteLength: candidateRow.byte_length,
        contentType: candidateRow.content_type, sha256 } : null;
      if (!candidate) throw problem('OFFICIAL_PUBLIC_CACHE_OBJECT_MISSING', '官服公开数据尚未完整进入内容缓存');
      const decoded = decodeAvailableGDataTables(candidate.bytes);
      return cache.attest({ sourceKey, sourceVersion, sha256, dataSnapshotId: decoded.dataSnapshotId,
        contractId: OFFICIAL_GDATA_SCHEMA_CONTRACT_ID, tableHashes: decoded.tableHashes });
    },
    // R10 business tables (tasks/shop/guild/story/cultivate). Decoded from the
    // same activated g-data object and keyed by the exact table-name set, so a
    // bundle change can never reuse another bundle's rows.
    readBusinessTables: ({ sourceKey, sourceVersion, resourceSha256, baseDataSnapshotId, tableNames } = {}) => {
      if (typeof sourceKey !== 'string' || !sourceKey.endsWith(':g-data') || typeof sourceVersion !== 'string' ||
          !/^[a-f0-9]{64}$/.test(resourceSha256 || '') || typeof baseDataSnapshotId !== 'string' || !baseDataSnapshotId ||
          !Array.isArray(tableNames) || !tableNames.length || tableNames.length > 32 ||
          tableNames.some(name => typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name))) return null;
      const active = cache.activatedHead(sourceKey, sourceVersion);
      if (!active || active.sha256 !== resourceSha256) return null;
      const bundle = cache.latestBundle(sourceKey.slice(0, -7), sourceVersion, resourceSha256);
      const body = cachedBody(store, resourceSha256);
      if (!bundle || !body || bundle.resources?.gdata?.sha256 !== resourceSha256 ||
          bundle.dataSnapshotId !== baseDataSnapshotId) return null;
      const derivedKey = `${bundle.bundleRef}:${[...tableNames].sort().join(',')}`;
      let derived = businessTables.get(derivedKey);
      if (!derived) {
        try {
          const base = decodeAvailableGDataTables(body.bytes);
          if (base.dataSnapshotId !== bundle.dataSnapshotId) return null;
        } catch { return null; }
        // Decode one table at a time: an unsupported transform in one business
        // table must disable only the actions that consume it.
        const tables = {}, tableHashes = {}, unsupported = [];
        for (const name of tableNames) {
          try {
            const decoded = decodeOfficialGDataTables(body.bytes, { tableNames: [name] });
            if (!decoded.tables[name]) { unsupported.push(name); continue; }
            tables[name] = decoded.tables[name];
            if (decoded.tableHashes[name]) tableHashes[name] = decoded.tableHashes[name];
          } catch { unsupported.push(name); }
        }
        derived = freeze({ tables: freeze(tables), tableHashes: freeze(tableHashes), unsupported: freeze(unsupported) });
        businessTables.set(derivedKey, derived);
        if (businessTables.size > 8) businessTables.delete(businessTables.keys().next().value);
      }
      return freeze({ ...derived, bundleRef: bundle.bundleRef, sourceVersion, resourceSha256,
        dataSnapshotId: bundle.dataSnapshotId, dataSchemaContractId: bundle.dataSchemaContractId });
    },
    readValidatedDataSnapshot: (sourceKey, sourceVersion, sha256) => {
      const row = store.get(`SELECT data_snapshot_id,contract_id,table_hashes_json FROM backend_official_public_data_validations
        WHERE source_key=? AND source_version=? AND sha256=? ORDER BY validated_at DESC LIMIT 1`, sourceKey, sourceVersion, sha256);
      const body = cachedBody(store, sha256);
      if (!row || !body) return null;
      const decoded = decodeAvailableGDataTables(body.bytes);
      if (decoded.dataSnapshotId !== row.data_snapshot_id || canonical(decoded.tableHashes) !== canonical(JSON.parse(row.table_hashes_json))) return null;
      return freeze({ dataSnapshotId: decoded.dataSnapshotId, dataSchemaContractId: row.contract_id,
        tableHashes: decoded.tableHashes, tables: decoded.tables });
    },
    readActivatedGDataSnapshot: ({ sourceKey, sha256, sourceVersion, sourceProofs = null } = {}) => {
      const current = cache.latest(sourceKey);
      const active = current?.sha256 === sha256 ? current : cache.latest(sourceKey, 'last-good');
      if (!active || active.sha256 !== sha256 || active.source_version !== sourceVersion) return null;
      const validation = store.get(`SELECT data_snapshot_id,contract_id,table_hashes_json FROM backend_official_public_data_validations
        WHERE source_key=? AND source_version=? AND sha256=? ORDER BY validated_at DESC LIMIT 1`, sourceKey, sourceVersion, sha256);
      const body = cachedBody(store, sha256);
      if (!validation || !body) return null;
      const decoded = decodeAvailableGDataTables(body.bytes);
      if (decoded.dataSnapshotId !== validation.data_snapshot_id || canonical(decoded.tableHashes) !== canonical(JSON.parse(validation.table_hashes_json))) return null;
      const bundle = cache.latestBundle(sourceKey.endsWith(':g-data') ? sourceKey.slice(0, -7) : sourceKey, sourceVersion, sha256);
      if (!bundle || bundle.resources.gdata.sha256 !== sha256 || bundle.dataSnapshotId !== decoded.dataSnapshotId ||
          bundle.dataSchemaContractId !== validation.contract_id || bundle.sourceBlockContractSha256 !== sourceProofContractBytesHash() ||
          sourceProofs && canonical(bundle.sourceProofs) !== canonical(sourceProofs)) return null;
      return freeze({ sourceVersion: active.source_version, dataSnapshotId: decoded.dataSnapshotId,
        dataSchemaContractId: validation.contract_id, contractId: OFFICIAL_CORE_CONTRACT_ID,
        tableHashes: decoded.tableHashes, tables: decoded.tables,
        resourceSha256: sha256, sourceKey, bundleSourceKey: bundle.sourceKey, sourceProofs: bundle.sourceProofs,
        sourceIndexSha256: bundle.resources.index.sha256, sourceConfigSha256: bundle.resources.config.sha256,
        bundleRef: bundle.bundleRef, validatedBundle: true });
    },
    readLandAccelerationExtension: ({ sourceKey, sourceVersion, resourceSha256, baseDataSnapshotId, loginResponseRef } = {}) => {
      if (typeof sourceKey !== 'string' || !sourceKey.endsWith(':g-data') || typeof sourceVersion !== 'string' ||
          !/^[a-f0-9]{64}$/.test(resourceSha256 || '') || typeof loginResponseRef !== 'string' || !loginResponseRef) return null;
      const active = cache.activatedHead(sourceKey, sourceVersion);
      if (!active || active.sha256 !== resourceSha256) return null;
      const bundle = cache.latestBundle(sourceKey.slice(0, -7), sourceVersion, resourceSha256);
      const dataBody = cachedBody(store, resourceSha256);
      if (!bundle || !dataBody || bundle.resources?.gdata?.sha256 !== resourceSha256 ||
          bundle.dataSnapshotId !== baseDataSnapshotId || bundle.dataSchemaContractId !== OFFICIAL_GDATA_SCHEMA_CONTRACT_ID ||
          bundle.sourceBlockContractSha256 !== sourceProofContractBytesHash()) return null;
      const gameRef = bundle.resources?.game, indexRef = bundle.resources?.index;
      if (!gameRef || gameRef.sourceKey !== `${bundle.sourceKey}:source-game` || !indexRef ||
          indexRef.sourceKey !== `${bundle.sourceKey}:index`) return null;
      const derivedKey = `${bundle.bundleRef}:${LAND_ACCELERATION_SOURCE_PIN}`;
      let derived = landAccelerationDerived.get(derivedKey);
      if (!derived) {
        const gameBody = cachedBody(store, gameRef.sha256), indexBody = cachedBody(store, indexRef.sha256);
        if (!gameBody || !indexBody) return null;
        let index;
        try { index = parseOfficialStaticJson(indexBody.bytes, { maxBytes: 512 * 1024 }); } catch { return null; }
        const moduleVersion = index?.platformMap?.['*']?.moduleJscVerMap?.game;
        if (!plainObject(index) || index.version !== sourceVersion || typeof index.jk !== 'string' ||
            typeof moduleVersion !== 'string' || !/^[a-f0-9]{3,32}$/.test(moduleVersion)) return null;
        let decodedGame;
        try { decodedGame = decodeOfficialJsc(gameBody.bytes, index.jk); } catch { return null; }
        const sourceProof = proveLandAccelerationExtensionSource(decodedGame);
        if (!sourceProof) return null;
        const base = decodeAvailableGDataTables(dataBody.bytes);
        if (base.dataSnapshotId !== bundle.dataSnapshotId) return null;
        const extensionTables = decodeOfficialGDataTables(dataBody.bytes, { tableNames: ['c_gameCfg', 'c_flower', 'c_item'] });
        derived = { sourceProof, baseDataSnapshotId: base.dataSnapshotId, baseTableHashes: bundle.tableHashes,
          tables: extensionTables.tables, tableHashes: extensionTables.tableHashes };
        landAccelerationDerived.set(derivedKey, derived);
        if (landAccelerationDerived.size > 8) landAccelerationDerived.delete(landAccelerationDerived.keys().next().value);
      }
      return validateLandAccelerationTables({ tables: derived.tables, tableHashes: derived.tableHashes,
        baseTableHashes: derived.baseTableHashes, baseDataSnapshotId: derived.baseDataSnapshotId, loginResponseRef, bundleRef: bundle.bundleRef,
        resourceSha256, sourceVersion, sourceProof: derived.sourceProof });
    },
    readWaterwheelExtension: ({ sourceKey, sourceVersion, resourceSha256, baseDataSnapshotId, loginResponseRef } = {}) => {
      if (typeof sourceKey !== 'string' || !sourceKey.endsWith(':g-data') || typeof sourceVersion !== 'string' ||
          !/^[a-f0-9]{64}$/.test(resourceSha256 || '') || typeof loginResponseRef !== 'string' || !loginResponseRef) return null;
      const active = cache.activatedHead(sourceKey, sourceVersion);
      if (!active || active.sha256 !== resourceSha256) return null;
      const bundle = cache.latestBundle(sourceKey.slice(0, -7), sourceVersion, resourceSha256), dataBody = cachedBody(store, resourceSha256);
      if (!bundle || !dataBody || bundle.resources?.gdata?.sha256 !== resourceSha256 || bundle.dataSnapshotId !== baseDataSnapshotId ||
          bundle.dataSchemaContractId !== OFFICIAL_GDATA_SCHEMA_CONTRACT_ID || bundle.sourceBlockContractSha256 !== sourceProofContractBytesHash()) return null;
      const gameRef = bundle.resources?.game, indexRef = bundle.resources?.index;
      if (!gameRef || gameRef.sourceKey !== `${bundle.sourceKey}:source-game` || !indexRef || indexRef.sourceKey !== `${bundle.sourceKey}:index`) return null;
      const derivedKey = `${bundle.bundleRef}:${WATERWHEEL_SOURCE_PIN}`;
      let derived = waterwheelDerived.get(derivedKey);
      if (!derived) {
        const gameBody = cachedBody(store, gameRef.sha256), indexBody = cachedBody(store, indexRef.sha256);
        if (!gameBody || !indexBody) return null;
        let index;
        try { index = parseOfficialStaticJson(indexBody.bytes, { maxBytes: 512 * 1024 }); } catch { return null; }
        const moduleVersion = index?.platformMap?.['*']?.moduleJscVerMap?.game;
        if (!plainObject(index) || index.version !== sourceVersion || typeof index.jk !== 'string' || typeof moduleVersion !== 'string' ||
            !/^[a-f0-9]{3,32}$/.test(moduleVersion)) return null;
        let decodedGame;
        try { decodedGame = decodeOfficialJsc(gameBody.bytes, index.jk); } catch { return null; }
        const sourceProof = proveWaterwheelExtensionSource(decodedGame);
        if (!sourceProof) return null;
        const base = decodeAvailableGDataTables(dataBody.bytes);
        if (base.dataSnapshotId !== bundle.dataSnapshotId || canonical(base.tableHashes) !== canonical(bundle.tableHashes)) return null;
        const tables = decodeOfficialGDataTables(dataBody.bytes, { tableNames: ['c_waterwheel', 'c_share', 'c_butler'] });
        derived = { sourceProof, baseDataSnapshotId: base.dataSnapshotId, baseTableHashes: bundle.tableHashes,
          tables: tables.tables, tableHashes: tables.tableHashes };
        waterwheelDerived.set(derivedKey, derived);
        if (waterwheelDerived.size > 8) waterwheelDerived.delete(waterwheelDerived.keys().next().value);
      }
      return validateWaterwheelTables({ tables: derived.tables, tableHashes: derived.tableHashes, baseTableHashes: derived.baseTableHashes,
        baseDataSnapshotId: derived.baseDataSnapshotId, loginResponseRef, bundleRef: bundle.bundleRef, resourceSha256,
        sourceVersion, sourceProof: derived.sourceProof });
    },
    readServerVersionSemantics: ({ sourceKey, sourceVersion, resourceSha256, baseDataSnapshotId, bundleRef } = {}) => {
      if (typeof sourceKey !== 'string' || !sourceKey.endsWith(':g-data') || typeof sourceVersion !== 'string' ||
          !/^[a-f0-9]{64}$/.test(resourceSha256 || '') || !/^sha256:[a-f0-9]{64}$/.test(baseDataSnapshotId || '') ||
          !/^sha256:[a-f0-9]{64}$/.test(bundleRef || '')) return null;
      const active = cache.activatedHead(sourceKey, sourceVersion);
      if (!active || active.sha256 !== resourceSha256) return null;
      const bundle = cache.latestBundle(sourceKey.slice(0, -7), sourceVersion, resourceSha256);
      if (!bundle || bundle.bundleRef !== bundleRef || bundle.dataSnapshotId !== baseDataSnapshotId ||
          bundle.dataSchemaContractId !== OFFICIAL_GDATA_SCHEMA_CONTRACT_ID || bundle.contractId !== OFFICIAL_CORE_CONTRACT_ID ||
          bundle.sourceBlockContractSha256 !== sourceProofContractBytesHash()) return null;
      const derivedKey = `${bundle.bundleRef}:${SERVER_VERSION_SOURCE_PIN}`;
      let derived = serverVersionDerived.get(derivedKey);
      if (!derived) {
        const gameRef = bundle.resources?.game, moRef = bundle.resources?.mo, indexRef = bundle.resources?.index;
        if (!gameRef || gameRef.sourceKey !== `${bundle.sourceKey}:source-game` || !moRef || moRef.sourceKey !== `${bundle.sourceKey}:source-mo` ||
            !indexRef || indexRef.sourceKey !== `${bundle.sourceKey}:index`) return null;
        const gameBody = cachedBody(store, gameRef.sha256), moBody = cachedBody(store, moRef.sha256), indexBody = cachedBody(store, indexRef.sha256);
        if (!gameBody || !moBody || !indexBody) return null;
        let index;
        try { index = parseOfficialStaticJson(indexBody.bytes, { maxBytes: 512 * 1024 }); } catch { return null; }
        if (!plainObject(index) || index.version !== sourceVersion || typeof index.jk !== 'string' ||
            index?.platformMap?.['*']?.moduleJscVerMap?.game !== gameRef.moduleVersion && gameRef.moduleVersion !== undefined ||
            index?.platformMap?.['*']?.moduleJscVerMap?.mo !== moRef.moduleVersion && moRef.moduleVersion !== undefined) return null;
        let gameBytes, moBytes;
        try { gameBytes = decodeOfficialJsc(gameBody.bytes, index.jk); moBytes = decodeOfficialJsc(moBody.bytes, index.jk); } catch { return null; }
        const sourceProof = proveOfficialServerVersionSemantics({ gameBytes, moBytes });
        const supportedProofs = Object.values(bundle.sourceProofs || {}).filter(proof => proof?.supported === true);
        if (!sourceProof || sourceProof.coreContractId !== OFFICIAL_CORE_CONTRACT_ID || sourceProof.protocolContractVersion !== SERVER_VERSION_PROTOCOL_CONTRACT ||
            !supportedProofs.length || supportedProofs.some(proof => proof.coreContractId !== OFFICIAL_CORE_CONTRACT_ID ||
              proof.sourceVersion !== sourceVersion || proof.protocolVersion !== SERVER_VERSION_PROTOCOL_CONTRACT ||
              proof.gameSha256 !== sourceProof.gameSha256 || proof.moSha256 !== sourceProof.moSha256 || proof.indexSha256 !== indexRef.sha256)) return null;
        const proof = bindOfficialServerVersionProofToBundle({ proof: sourceProof, bundleRef: bundle.bundleRef, sourceVersion,
          dataSnapshotId: bundle.dataSnapshotId, resourceSha256 });
        if (!proof) return null;
        derived = proof;
        serverVersionDerived.set(derivedKey, derived);
        if (serverVersionDerived.size > 8) serverVersionDerived.delete(serverVersionDerived.keys().next().value);
      }
      return derived;
    },
    readSpecialOrdersExtension: ({ sourceKey, sourceVersion, resourceSha256, baseDataSnapshotId, loginResponseRef } = {}) => {
      if (typeof sourceKey !== 'string' || !sourceKey.endsWith(':g-data') || typeof sourceVersion !== 'string' ||
          !/^[a-f0-9]{64}$/.test(resourceSha256 || '') || typeof loginResponseRef !== 'string' || !loginResponseRef) return null;
      const active = cache.activatedHead(sourceKey, sourceVersion);
      if (!active || active.sha256 !== resourceSha256) return null;
      const bundle = cache.latestBundle(sourceKey.slice(0, -7), sourceVersion, resourceSha256), dataBody = cachedBody(store, resourceSha256);
      if (!bundle || !dataBody || bundle.resources?.gdata?.sha256 !== resourceSha256 || bundle.dataSnapshotId !== baseDataSnapshotId ||
          bundle.dataSchemaContractId !== OFFICIAL_GDATA_SCHEMA_CONTRACT_ID || bundle.sourceBlockContractSha256 !== sourceProofContractBytesHash()) return null;
      const gameRef = bundle.resources?.game, indexRef = bundle.resources?.index;
      if (!gameRef || gameRef.sourceKey !== `${bundle.sourceKey}:source-game` || !indexRef || indexRef.sourceKey !== `${bundle.sourceKey}:index`) return null;
      const derivedKey = `${bundle.bundleRef}:${SPECIAL_ORDERS_SOURCE_PIN}`;
      let derived = specialOrdersDerived.get(derivedKey);
      if (!derived) {
        const gameBody = cachedBody(store, gameRef.sha256), indexBody = cachedBody(store, indexRef.sha256);
        if (!gameBody || !indexBody) return null;
        let index;
        try { index = parseOfficialStaticJson(indexBody.bytes, { maxBytes: 512 * 1024 }); } catch { return null; }
        if (!plainObject(index) || index.version !== sourceVersion || typeof index.jk !== 'string' ||
            !/^[a-f0-9]{3,32}$/.test(index?.platformMap?.['*']?.moduleJscVerMap?.game || '')) return null;
        let game;
        try { game = decodeOfficialJsc(gameBody.bytes, index.jk); } catch { return null; }
        const sourceProof = proveSpecialOrdersSource(game);
        if (!sourceProof) return null;
        const base = decodeAvailableGDataTables(dataBody.bytes);
        if (base.dataSnapshotId !== bundle.dataSnapshotId || canonical(base.tableHashes) !== canonical(bundle.tableHashes)) return null;
        const tables = decodeOfficialGDataTables(dataBody.bytes, { tableNames: ['c_orderTeam', 'c_open', 'c_item', 'c_flower', 'c_orderFlower'] });
        derived = { sourceProof, baseDataSnapshotId: base.dataSnapshotId, baseTableHashes: bundle.tableHashes,
          tables: tables.tables, tableHashes: tables.tableHashes };
        specialOrdersDerived.set(derivedKey, derived);
        if (specialOrdersDerived.size > 4) specialOrdersDerived.delete(specialOrdersDerived.keys().next().value);
      }
      return validateSpecialOrdersTables({ ...derived, bundleRef: bundle.bundleRef, loginResponseRef, resourceSha256, sourceVersion });
    },
    readFreeWaterExtension: ({ sourceKey, sourceVersion, resourceSha256, baseDataSnapshotId, loginResponseRef } = {}) => {
      if (typeof sourceKey !== 'string' || !sourceKey.endsWith(':g-data') || typeof sourceVersion !== 'string' ||
          !/^[a-f0-9]{64}$/.test(resourceSha256 || '') || typeof loginResponseRef !== 'string' || !loginResponseRef) return null;
      const active = cache.activatedHead(sourceKey, sourceVersion);
      if (!active || active.sha256 !== resourceSha256) return null;
      const bundle = cache.latestBundle(sourceKey.slice(0, -7), sourceVersion, resourceSha256), dataBody = cachedBody(store, resourceSha256);
      if (!bundle || !dataBody || bundle.resources?.gdata?.sha256 !== resourceSha256 || bundle.dataSnapshotId !== baseDataSnapshotId ||
          bundle.dataSchemaContractId !== OFFICIAL_GDATA_SCHEMA_CONTRACT_ID || bundle.sourceBlockContractSha256 !== sourceProofContractBytesHash()) return null;
      const gameRef = bundle.resources?.game, indexRef = bundle.resources?.index;
      if (!gameRef || gameRef.sourceKey !== `${bundle.sourceKey}:source-game` || !indexRef || indexRef.sourceKey !== `${bundle.sourceKey}:index`) return null;
      const derivedKey = `${bundle.bundleRef}:${FREE_WATER_SOURCE_PIN}`;
      let derived = freeWaterDerived.get(derivedKey);
      if (!derived) {
        const gameBody = cachedBody(store, gameRef.sha256), indexBody = cachedBody(store, indexRef.sha256);
        if (!gameBody || !indexBody) return null;
        let index;
        try { index = parseOfficialStaticJson(indexBody.bytes, { maxBytes: 512 * 1024 }); } catch { return null; }
        const moduleVersion = index?.platformMap?.['*']?.moduleJscVerMap?.game;
        if (!plainObject(index) || index.version !== sourceVersion || typeof index.jk !== 'string' || typeof moduleVersion !== 'string' ||
            !/^[a-f0-9]{3,32}$/.test(moduleVersion)) return null;
        let decodedGame;
        try { decodedGame = decodeOfficialJsc(gameBody.bytes, index.jk); } catch { return null; }
        const sourceProof = proveFreeWaterExtensionSource(decodedGame);
        if (!sourceProof) return null;
        const base = decodeAvailableGDataTables(dataBody.bytes);
        if (base.dataSnapshotId !== bundle.dataSnapshotId || canonical(base.tableHashes) !== canonical(bundle.tableHashes)) return null;
        const tables = decodeOfficialGDataTables(dataBody.bytes, { tableNames: ['c_gameCfg', 'c_share', 'c_open'] });
        derived = { sourceProof, baseDataSnapshotId: base.dataSnapshotId, baseTableHashes: bundle.tableHashes,
          tables: tables.tables, tableHashes: tables.tableHashes };
        freeWaterDerived.set(derivedKey, derived);
        if (freeWaterDerived.size > 8) freeWaterDerived.delete(freeWaterDerived.keys().next().value);
      }
      return validateFreeWaterTables({ tables: derived.tables, tableHashes: derived.tableHashes, baseTableHashes: derived.baseTableHashes,
        baseDataSnapshotId: derived.baseDataSnapshotId, loginResponseRef, bundleRef: bundle.bundleRef, resourceSha256,
        sourceVersion, sourceProof: derived.sourceProof });
    },
    readFlowerRackExtension: ({ sourceKey, sourceVersion, resourceSha256, baseDataSnapshotId, loginResponseRef } = {}) => {
      if (typeof sourceKey !== 'string' || !sourceKey.endsWith(':g-data') || typeof sourceVersion !== 'string' ||
          !/^[a-f0-9]{64}$/.test(resourceSha256 || '') || typeof loginResponseRef !== 'string' || !loginResponseRef) return null;
      const active = cache.activatedHead(sourceKey, sourceVersion);
      if (!active || active.sha256 !== resourceSha256) return null;
      const bundle = cache.latestBundle(sourceKey.slice(0, -7), sourceVersion, resourceSha256), dataBody = cachedBody(store, resourceSha256);
      if (!bundle || !dataBody || bundle.resources?.gdata?.sha256 !== resourceSha256 || bundle.dataSnapshotId !== baseDataSnapshotId ||
          bundle.dataSchemaContractId !== OFFICIAL_GDATA_SCHEMA_CONTRACT_ID || bundle.sourceBlockContractSha256 !== sourceProofContractBytesHash()) return null;
      const gameRef = bundle.resources?.game, indexRef = bundle.resources?.index;
      if (!gameRef || gameRef.sourceKey !== `${bundle.sourceKey}:source-game` || !indexRef || indexRef.sourceKey !== `${bundle.sourceKey}:index`) return null;
      const derivedKey = `${bundle.bundleRef}:${FLOWER_RACK_SOURCE_PIN}`;
      let derived = flowerRackDerived.get(derivedKey);
      if (!derived) {
        const gameBody = cachedBody(store, gameRef.sha256), indexBody = cachedBody(store, indexRef.sha256);
        if (!gameBody || !indexBody) return null;
        let index;
        try { index = parseOfficialStaticJson(indexBody.bytes, { maxBytes: 512 * 1024 }); } catch { return null; }
        const moduleVersion = index?.platformMap?.['*']?.moduleJscVerMap?.game;
        if (!plainObject(index) || index.version !== sourceVersion || typeof index.jk !== 'string' || typeof moduleVersion !== 'string' ||
            !/^[a-f0-9]{3,32}$/.test(moduleVersion)) return null;
        let decodedGame;
        try { decodedGame = decodeOfficialJsc(gameBody.bytes, index.jk); } catch { return null; }
        const sourceProof = proveFlowerRackExtensionSource(decodedGame);
        if (!sourceProof) return null;
        const base = decodeAvailableGDataTables(dataBody.bytes);
        if (base.dataSnapshotId !== bundle.dataSnapshotId || canonical(base.tableHashes) !== canonical(bundle.tableHashes)) return null;
        const tables = decodeOfficialGDataTables(dataBody.bytes, { tableNames: ['c_flowerRack'] });
        derived = { sourceProof, baseDataSnapshotId: base.dataSnapshotId, baseTableHashes: bundle.tableHashes,
          tables: tables.tables, tableHashes: tables.tableHashes };
        flowerRackDerived.set(derivedKey, derived);
        if (flowerRackDerived.size > 8) flowerRackDerived.delete(flowerRackDerived.keys().next().value);
      }
      return validateFlowerRackTables({ tables: derived.tables, tableHashes: derived.tableHashes, baseTableHashes: derived.baseTableHashes,
        baseDataSnapshotId: derived.baseDataSnapshotId, loginResponseRef, bundleRef: bundle.bundleRef, resourceSha256,
        sourceVersion, sourceProof: derived.sourceProof });
    },
    readFlowerRackPriceExtension: ({ sourceKey, sourceVersion, resourceSha256, baseDataSnapshotId, loginResponseRef } = {}) => {
      if (typeof sourceKey !== 'string' || !sourceKey.endsWith(':g-data') || typeof sourceVersion !== 'string' ||
          !/^[a-f0-9]{64}$/.test(resourceSha256 || '') || typeof loginResponseRef !== 'string' || !loginResponseRef) return null;
      const active = cache.activatedHead(sourceKey, sourceVersion);
      if (!active || active.sha256 !== resourceSha256) return null;
      const bundle = cache.latestBundle(sourceKey.slice(0, -7), sourceVersion, resourceSha256), dataBody = cachedBody(store, resourceSha256);
      if (!bundle || !dataBody || bundle.resources?.gdata?.sha256 !== resourceSha256 || bundle.dataSnapshotId !== baseDataSnapshotId ||
          bundle.dataSchemaContractId !== OFFICIAL_GDATA_SCHEMA_CONTRACT_ID || bundle.sourceBlockContractSha256 !== sourceProofContractBytesHash()) return null;
      const gameRef = bundle.resources?.game, indexRef = bundle.resources?.index;
      if (!gameRef || gameRef.sourceKey !== `${bundle.sourceKey}:source-game` || !indexRef || indexRef.sourceKey !== `${bundle.sourceKey}:index`) return null;
      const derivedKey = `${bundle.bundleRef}:${FLOWER_RACK_PRICE_SOURCE_PIN}`;
      let derived = flowerRackPriceDerived.get(derivedKey);
      if (!derived) {
        const gameBody = cachedBody(store, gameRef.sha256), indexBody = cachedBody(store, indexRef.sha256);
        if (!gameBody || !indexBody) return null;
        let index;
        try { index = parseOfficialStaticJson(indexBody.bytes, { maxBytes: 512 * 1024 }); } catch { return null; }
        const moduleVersion = index?.platformMap?.['*']?.moduleJscVerMap?.game;
        if (!plainObject(index) || index.version !== sourceVersion || typeof index.jk !== 'string' ||
            typeof moduleVersion !== 'string' || !/^[a-f0-9]{3,32}$/.test(moduleVersion)) return null;
        let decodedGame;
        try { decodedGame = decodeOfficialJsc(gameBody.bytes, index.jk); } catch { return null; }
        const sourceProof = proveFlowerRackPriceExtensionSource(decodedGame);
        if (!sourceProof) return null;
        const base = decodeAvailableGDataTables(dataBody.bytes);
        if (base.dataSnapshotId !== bundle.dataSnapshotId || canonical(base.tableHashes) !== canonical(bundle.tableHashes)) return null;
        const tables = decodeOfficialGDataTables(dataBody.bytes, { tableNames: ['c_gameCfg', 'c_flowerAdvanceSkill'] });
        derived = { sourceProof, baseDataSnapshotId: base.dataSnapshotId, baseTableHashes: bundle.tableHashes,
          tables: tables.tables, tableHashes: tables.tableHashes };
        flowerRackPriceDerived.set(derivedKey, derived);
        if (flowerRackPriceDerived.size > 8) flowerRackPriceDerived.delete(flowerRackPriceDerived.keys().next().value);
      }
      return validateFlowerRackPriceExtension({ tables: derived.tables, tableHashes: derived.tableHashes, baseTableHashes: derived.baseTableHashes,
        baseDataSnapshotId: derived.baseDataSnapshotId, loginResponseRef, bundleRef: bundle.bundleRef, resourceSha256,
        sourceVersion, sourceProof: derived.sourceProof });
    },
    readArtFirstRewardExtension: ({ sourceKey, sourceVersion, resourceSha256, baseDataSnapshotId, loginResponseRef } = {}) => {
      if (typeof sourceKey !== 'string' || !sourceKey.endsWith(':g-data') || typeof sourceVersion !== 'string' ||
          !/^[a-f0-9]{64}$/.test(resourceSha256 || '') || typeof loginResponseRef !== 'string' || !loginResponseRef) return null;
      const active = cache.activatedHead(sourceKey, sourceVersion);
      if (!active || active.sha256 !== resourceSha256) return null;
      const bundle = cache.latestBundle(sourceKey.slice(0, -7), sourceVersion, resourceSha256), dataBody = cachedBody(store, resourceSha256);
      if (!bundle || !dataBody || bundle.resources?.gdata?.sha256 !== resourceSha256 || bundle.dataSnapshotId !== baseDataSnapshotId ||
          bundle.dataSchemaContractId !== OFFICIAL_GDATA_SCHEMA_CONTRACT_ID || bundle.sourceBlockContractSha256 !== sourceProofContractBytesHash()) return null;
      const gameRef = bundle.resources?.game, indexRef = bundle.resources?.index;
      if (!gameRef || gameRef.sourceKey !== `${bundle.sourceKey}:source-game` || !indexRef || indexRef.sourceKey !== `${bundle.sourceKey}:index`) return null;
      const derivedKey = `${bundle.bundleRef}:${ART_FIRST_REWARD_SOURCE_PIN}`;
      let sourceProof = artFirstRewardDerived.get(derivedKey);
      if (!sourceProof) {
        const gameBody = cachedBody(store, gameRef.sha256), indexBody = cachedBody(store, indexRef.sha256);
        if (!gameBody || !indexBody) return null;
        let index; try { index = parseOfficialStaticJson(indexBody.bytes, { maxBytes: 512 * 1024 }); } catch { return null; }
        const moduleVersion = index?.platformMap?.['*']?.moduleJscVerMap?.game;
        if (!plainObject(index) || index.version !== sourceVersion || typeof index.jk !== 'string' ||
            typeof moduleVersion !== 'string' || !/^[a-f0-9]{3,32}$/.test(moduleVersion)) return null;
        let decodedGame; try { decodedGame = decodeOfficialJsc(gameBody.bytes, index.jk); } catch { return null; }
        sourceProof = proveArtFirstRewardExtensionSource(decodedGame);
        if (!sourceProof) return null;
        artFirstRewardDerived.set(derivedKey, sourceProof);
        if (artFirstRewardDerived.size > 8) artFirstRewardDerived.delete(artFirstRewardDerived.keys().next().value);
      }
      return bindArtFirstRewardExtension({ baseDataSnapshotId, loginResponseRef, bundleRef: bundle.bundleRef,
        resourceSha256, sourceVersion, sourceProof });
    },
    cachedBody: sha256 => {
      return cachedBody(store, sha256);
    },
  });
}

function waitForSubscriber(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(problem('OFFICIAL_PUBLIC_FETCH_CANCELLED', '官服公开资源读取已取消'));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(problem('OFFICIAL_PUBLIC_FETCH_CANCELLED', '官服公开资源读取已取消')); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

function cachedBody(store, sha256) {
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) return null;
  const row = store.get('SELECT body,content_type,byte_length FROM backend_official_public_data_objects WHERE sha256=?', sha256);
  if (!row || row.body.length !== row.byte_length || crypto.createHash('sha256').update(row.body).digest('hex') !== sha256) return null;
  return Object.freeze({ bytes: Buffer.from(row.body), contentType: row.content_type, byteLength: row.byte_length, sha256 });
}

const PUBLIC_TABLE_REQUIRED_FIELDS = Object.freeze({ c_item: ['id'], c_farmLand: ['id'], c_flower: ['id', 'seedId', 'culCost'],
  c_flowerLvl: ['id'], c_flowerLvlCfg: ['id'], c_flowerArt: ['id', 'vase', 'flowers'], c_open: ['id'],
  c_lvl: ['id', 'orderFlower', 'orderSatinsNum', 'orderDecorateNum', 'orderNum'], c_orderFlower: ['id'],
  c_orderFlowerNpc: ['id'], c_share: ['id', 'limit', 'limitType', 'openId'], c_orderCustomerNpc: ['id'], c_butler: ['id'] });
export const OFFICIAL_PUBLIC_TABLE_NAMES = Object.freeze(Object.keys(PUBLIC_TABLE_REQUIRED_FIELDS));
export function decodeAvailableGDataTables(bytes) {
  const tables = {}, tableHashes = {};
  for (const name of OFFICIAL_PUBLIC_TABLE_NAMES) {
    try {
      const decoded = decodeOfficialGDataTables(bytes, { tableNames: [name] }), rows = decoded.tables[name];
      const entries = plainObject(rows) ? Object.entries(rows).filter(([key]) => key !== '-1') : [];
      const validKey = ([key, row]) => {
        if (!plainObject(row)) return false;
        if (name === 'c_open') return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) && row.id === key;
        return (key === '-1' || /^[1-9][0-9]*$/.test(key)) && Number.isSafeInteger(Number(key)) && row.id === Number(key);
      };
      const validFields = ([key, row]) => (key === '-1' && ['c_lvl', 'c_orderCustomerNpc', 'c_butler'].includes(name)
        ? name === 'c_lvl' ? ['id'] : name === 'c_orderCustomerNpc' ? ['id', '$npcId', '$npcMax', '$npcMaxDay'] : ['id', '$maxFlowerOrder'] : PUBLIC_TABLE_REQUIRED_FIELDS[name]).every(column => Object.hasOwn(row, column));
      const validRows = entries.length > 0 && entries.every(validKey) && entries.every(validFields) &&
        (name !== 'c_lvl' || entries.filter(([key]) => key !== '-1').every(([, row]) =>
          Number.isSafeInteger(row.orderFlower) && row.orderFlower >= 0 && Number.isSafeInteger(row.orderSatinsNum) && row.orderSatinsNum >= 0 &&
          Number.isSafeInteger(row.orderDecorateNum) && row.orderDecorateNum >= 0 && Number.isSafeInteger(row.orderNum) && row.orderNum >= 0)) &&
        (name !== 'c_orderFlower' || (Number.isSafeInteger(rows['-1']?.$dailyMax) && rows['-1'].$dailyMax > 0 &&
          Number.isSafeInteger(rows['-1']?.$dailyMax2) && rows['-1'].$dailyMax2 > 0 && Number.isSafeInteger(rows['-1']?.$dailyMax3) && rows['-1'].$dailyMax3 > 0)) &&
        (name !== 'c_orderFlowerNpc' || (Array.isArray(rows['-1']?.$npcId) && Array.isArray(rows['-1']?.$satinsNpcId) &&
          Array.isArray(rows['-1']?.$decorateNpcId) && [rows['-1'].$npcId, rows['-1'].$satinsNpcId, rows['-1'].$decorateNpcId].every(list =>
            list.length > 0 && list.length <= 4096 && list.every(id => Number.isSafeInteger(id) && id > 0)))) &&
        (name !== 'c_share' || entries.every(([, row]) => Number.isSafeInteger(row.limit) && row.limit > 0 &&
          row.limitType === 1 && typeof row.openId === 'string' && row.openId.length > 0 && row.openId.length <= 64)) &&
        (name !== 'c_orderCustomerNpc' || Array.isArray(rows['-1']?.$npcId) && rows['-1'].$npcId.length > 0 &&
          rows['-1'].$npcId.length <= 128 && rows['-1'].$npcId.every(id => Number.isSafeInteger(id) && id > 0) &&
          Number.isSafeInteger(rows['-1'].$npcMax) && rows['-1'].$npcMax > 0 && Number.isSafeInteger(rows['-1'].$npcMaxDay) &&
          rows['-1'].$npcMaxDay > 0 && rows['-1'].$npcId.every(id => rows[String(id)]?.id === id &&
            Number.isSafeInteger(rows[String(id)]?.maintaskId) && rows[String(id)].maintaskId > 0)) &&
        (name !== 'c_butler' || Array.isArray(rows['-1']?.$maxFlowerOrder) && rows['-1'].$maxFlowerOrder.length === 3 &&
          rows['-1'].$maxFlowerOrder.every(value => Number.isSafeInteger(value) && value > 0)) &&
        (name !== 'c_flower' || entries.every(([, row]) => Number.isSafeInteger(row.seedId) && row.seedId > 0 &&
          (Array.isArray(row.culCost) || typeof row.culCost === 'number' && Number.isFinite(row.culCost) && row.culCost >= 0))) &&
        (name !== 'c_flowerArt' || entries.every(([, row]) => Number.isSafeInteger(row.vase) && row.vase > 0 &&
          Array.isArray(row.flowers) && row.flowers.length === 3 && row.flowers.every(id => Number.isSafeInteger(id) && id > 0))) &&
        (name !== 'c_item' || entries.some(([, row]) => Number.isSafeInteger(row.type)));
      if (!validRows) continue;
      tables[name] = rows; tableHashes[name] = decoded.tableHashes[name];
    } catch { /* An unreadable table disables only actions that consume it. */ }
  }
  if (!Object.keys(tableHashes).length) throw problem('OFFICIAL_PUBLIC_TABLE_CONTRACT_MISMATCH', '官服公开数据没有可用的已核静态表');
  return freeze({ tables: freeze(tables), tableHashes,
    dataSnapshotId: 'sha256:' + crypto.createHash('sha256').update(canonical(tableHashes)).digest('hex') });
}

export function parseOfficialStaticJson(bytes, { maxBytes = 4 * 1024 * 1024 } = {}) {
  const body = Buffer.from(bytes);
  if (!body.length || body.length > maxBytes) throw problem('OFFICIAL_PUBLIC_JSON_SIZE_INVALID', '官服静态JSON为空或超过上限');
  let parsed;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { throw problem('OFFICIAL_PUBLIC_JSON_INVALID', '官服静态JSON格式无效'); }
  if (!plainObject(parsed) && !Array.isArray(parsed)) throw problem('OFFICIAL_PUBLIC_JSON_SHAPE_INVALID', '官服静态JSON根结构不受支持');
  return parsed;
}

const decodeCipher = (text, key) => {
  if (typeof text !== 'string' || !Number.isSafeInteger(key) || key < 0 || key > 0xffff) throw problem('OFFICIAL_GDATA_ENCODING_INVALID', '官服数据表编码元数据无效');
  if (!text) return '';
  const values = text.split(',');
  if (values.length > 100_000 || values.some(value => !/^\d{1,6}$/.test(value))) throw problem('OFFICIAL_GDATA_ENCODING_INVALID', '官服数据表编码字段超过安全范围');
  return values.map(value => String.fromCharCode(Number(value) ^ key)).join('');
};
const xorKey = value => [...value].reduce((result, character) => result ^ character.charCodeAt(0), 0);
const jsRemainder = (value, base) => value - Math.trunc(value / base) * base;
function unshiftNumbers(value, shift, rowId, forcePositive) {
  if (Array.isArray(value)) return value.map(child => unshiftNumbers(child, shift, rowId, forcePositive));
  if (plainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, unshiftNumbers(child, shift, rowId, forcePositive)]));
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 10 || !shift) return value;
  let applied = shift;
  if (rowId < 0 && forcePositive && applied < 0) applied = Math.abs(applied);
  const decoded = value - applied;
  return decoded < 1e8 && !Number.isInteger(decoded) ? Math.floor(1e4 * decoded + 0.5) / 1e4 : decoded;
}

export function decodeOfficialGDataTables(bytes, { tableNames = null, maxRows = 100_000 } = {}) {
  const outer = parseOfficialStaticJson(bytes, { maxBytes: MAX_BYTES });
  if (!plainObject(outer)) throw problem('OFFICIAL_GDATA_SHAPE_INVALID', '官服数据表根目录不是对象');
  const wanted = tableNames === null ? null : new Set(tableNames);
  const tables = {}; let rowCount = 0;
  for (const [encodedName, table] of Object.entries(outer)) {
    if (!plainObject(table) || typeof table.a !== 'string' || !table.a) continue;
    const key = xorKey(table.a), name = decodeCipher(encodedName, xorKey(table.a));
    if (wanted && !wanted.has(name)) continue;
    if (Object.hasOwn(tables, name)) throw problem('OFFICIAL_GDATA_TABLE_DUPLICATE', '官服数据表名称重复');
    if (table.c != null) throw problem('OFFICIAL_GDATA_COLUMN_TRANSFORM_UNSUPPORTED', '官服数据表含未审核列变换，保留旧快照');
    let aliases;
    try { aliases = JSON.parse(decodeCipher(table.m, key)); } catch { throw problem('OFFICIAL_GDATA_ALIAS_INVALID', '官服数据表列映射无效'); }
    if (!plainObject(aliases) || Object.keys(aliases).length > 256 || Object.values(aliases).some(alias => typeof alias !== 'string')) {
      throw problem('OFFICIAL_GDATA_ALIAS_INVALID', '官服数据表列映射超出安全范围');
    }
    const rows = {};
    for (const chunk of Array.isArray(table.list) ? table.list : []) {
      if (!plainObject(chunk) || !plainObject(chunk.v)) throw problem('OFFICIAL_GDATA_CHUNK_INVALID', '官服数据表分块结构无效');
      let defaults = chunk.d;
      if (typeof defaults === 'string') { try { defaults = JSON.parse(decodeCipher(defaults, key)); } catch { throw problem('OFFICIAL_GDATA_DEFAULTS_INVALID', '官服数据表默认值无效'); } }
      if (defaults == null) defaults = {};
      if (!plainObject(defaults)) throw problem('OFFICIAL_GDATA_DEFAULTS_INVALID', '官服数据表默认值不是对象');
      for (const [idText, sourceRow] of Object.entries(chunk.v)) {
        const stringKeyed = name === 'c_open';
        if (Object.hasOwn(rows, idText) || (stringKeyed
          ? !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(idText)
          : !/^-?\d+$/.test(idText) || !Number.isSafeInteger(Number(idText))) ||
            !plainObject(sourceRow) || rowCount >= maxRows) {
          throw problem('OFFICIAL_GDATA_ROW_INVALID', '官服数据表行重复或超出安全范围');
        }
        rowCount += 1;
        // c_open is keyed by its symbolic openId, not a numeric database id.
        // Numeric columns in that table use the table/column shift only.
        const rowId = stringKeyed ? 0 : Number(idText), row = {};
        for (const [column, alias] of Object.entries(aliases)) {
          if (column === '$') continue;
          let value = sourceRow[alias];
          const shift = jsRemainder(jsRemainder(rowId, 100) + jsRemainder([...`${name}#${alias}`].reduce((sum, char) => sum + char.charCodeAt(0), 0), 100), 100);
          value = unshiftNumbers(value, shift, rowId, Boolean(table.f));
          if (value === undefined || value === null) value = defaults[alias];
          if (value !== undefined && value !== null) row[column] = value;
        }
        if (typeof aliases.$ === 'string' && row[aliases.$] == null) row[aliases.$] = stringKeyed ? idText : rowId;
        rows[idText] = row;
      }
    }
    tables[name] = freeze(rows);
  }
  if (wanted && [...wanted].some(name => !Object.hasOwn(tables, name))) throw problem('OFFICIAL_GDATA_TABLE_MISSING', '官服公开数据缺少需要的静态表');
  const tableHashes = Object.fromEntries(Object.entries(tables).sort(([a], [b]) => a.localeCompare(b)).map(([name, rows]) => [name,
    crypto.createHash('sha256').update(canonical(rows)).digest('hex')]));
  return freeze({ tables: freeze(tables), tableHashes, dataSnapshotId: 'sha256:' + crypto.createHash('sha256').update(canonical(tableHashes)).digest('hex') });
}
