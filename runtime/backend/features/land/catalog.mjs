import fs from 'node:fs';
import crypto from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { canonical, clone, freeze, plainObject, problem } from '../../common.mjs';
import { NORMAL_SYNC_METHODS } from '../../facts/normal-sync-contract.mjs';
import { officialDataSnapshotForSourceVersion } from '../../official-data-snapshot.mjs';
import { OFFICIAL_GDATA_SCHEMA_CONTRACT_ID, OFFICIAL_PUBLIC_TABLE_NAMES } from '../../official-public-data.mjs';
import { OFFICIAL_CORE_CONTRACT_ID } from '../../official-version-profile.mjs';
import { verifyOfficialServerVersionFrame } from '../../official-server-version-contract.mjs';

// Independent copies selected by the normal package hop's exact public game
// version. The historical APK catalog remains separate, never silently unioned.
const BUNDLES = Object.freeze({
 '480.0.27': Object.freeze({ gameVersion: '480.0.27', directory: 'official-land-480.0.27', protocolVersion: '480.0.0', manifestSha256: 'eaa7a0c91cc605a3b212f16ba0d2bb503b6cad15263d4ef2991490abaa7d9e37', files: Object.freeze({
   c_item: new URL('../../catalogs/official-land-480.0.27/c_item.json', import.meta.url),
   c_farmLand: new URL('../../catalogs/official-land-480.0.27/c_farmLand.json', import.meta.url),
   c_flower: new URL('../../catalogs/official-land-480.0.27/c_flower.json', import.meta.url),
   c_flowerLvl: new URL('../../catalogs/official-land-480.0.27/c_flowerLvl.json', import.meta.url),
   c_flowerLvlCfg: new URL('../../catalogs/official-land-480.0.27/c_flowerLvlCfg.json', import.meta.url),
   manifest: new URL('../../catalogs/official-land-480.0.27/manifest.json', import.meta.url),
 }), hashes: Object.freeze({
  c_item: '2ad2051ffa3b330438d8d2a0243227950a9b6afc7b75e75098ff9703a82f5f58',
  c_farmLand: 'fdae8edc9d22b071987de1aba21ee8ebab46cbcadbe68a1ff31ef0198da8d098',
  c_flower: '7c57fbd1af83c20b4ed0c74aeca50d50a376a731a67990482215aadb76f6fc2c',
  c_flowerLvl: 'cd8e64fd41f5f0a9fc320d65a202a3a3181bb1f5d669d8a7c9460d2a103f7cd2',
  c_flowerLvlCfg: '88247f9e34b887fdd474f68a58f124dbe5b6bd28fd43a9b2489f70bc94bfa290',
 }) }),
 '480.0.46': Object.freeze({ gameVersion: '480.0.46', directory: 'official-land-480.0.46', protocolVersion: '480.0.0', manifestSha256: 'e634d96d688cdcae1ad26c64974322d0e1ca516f86f408c53102e01d50d3a0ee', files: Object.freeze({
   c_item: new URL('../../catalogs/official-land-480.0.46/c_item.json', import.meta.url),
   c_farmLand: new URL('../../catalogs/official-land-480.0.46/c_farmLand.json', import.meta.url),
   c_flower: new URL('../../catalogs/official-land-480.0.46/c_flower.json', import.meta.url),
   c_flowerLvl: new URL('../../catalogs/official-land-480.0.46/c_flowerLvl.json', import.meta.url),
   c_flowerLvlCfg: new URL('../../catalogs/official-land-480.0.46/c_flowerLvlCfg.json', import.meta.url),
   manifest: new URL('../../catalogs/official-land-480.0.46/manifest.json', import.meta.url),
 }), hashes: Object.freeze({
   c_item: '2c93b367cae5771d7ede9c0797e32773cdb9ab9273677fed51af86a042e1e4d6',
   c_farmLand: 'fdae8edc9d22b071987de1aba21ee8ebab46cbcadbe68a1ff31ef0198da8d098',
   c_flower: 'fab2310163f1f034fe688af1179c6165bdbaff4c640477b5251a42962599fbfd',
   c_flowerLvl: 'cd8e64fd41f5f0a9fc320d65a202a3a3181bb1f5d669d8a7c9460d2a103f7cd2',
   c_flowerLvlCfg: '88247f9e34b887fdd474f68a58f124dbe5b6bd28fd43a9b2489f70bc94bfa290',
 }) }),
});
const COUNTS = { c_item: 7446, c_farmLand: 65, c_flower: 658, c_flowerLvl: 6091, c_flowerLvlCfg: 20 };
const AUDITED_FIELDS = freeze({ plant: ['id', 'color'], yield: ['cropGets', 'frequencys'], water: ['id', 'reset', 'restore', 'limit'] });
const SYNC_METHODS = new Set(NORMAL_SYNC_METHODS);
const STATIC_TABLE_NAMES = Object.freeze(['c_item', 'c_farmLand', 'c_flower', 'c_flowerLvl', 'c_flowerLvlCfg']);
const CATALOG_TABLE_NAMES = new Set([...STATIC_TABLE_NAMES, ...OFFICIAL_PUBLIC_TABLE_NAMES]);
const dataByVersion = new Map();
const trustedImmutableTables = new WeakSet();
const trustedOfficialLandCatalogs = new WeakSet();
function isDeepFrozenData(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (utilTypes.isProxy(value)) return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !isDeepFrozenData(descriptor.value, seen)) return false;
  }
  return true;
}
export function isTrustedOfficialLandCatalog(catalog) {
  return !!catalog && trustedOfficialLandCatalogs.has(catalog);
}
function load(bundle) {
  if (dataByVersion.has(bundle.directory)) return dataByVersion.get(bundle.directory);
  const loaded = {};
  for (const name of Object.keys(bundle.hashes)) {
    const file = bundle.files[name];
    const bytes = fs.readFileSync(file);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== bundle.hashes[name]) {
      throw problem('LAND_CATALOG_INTEGRITY_FAILED', '官方土地静态目录指纹不一致', 500);
    }
    loaded[name] = JSON.parse(bytes.toString('utf8'));
    if (COUNTS[name] !== undefined && Object.keys(loaded[name]).length !== COUNTS[name]) {
      throw problem('LAND_CATALOG_INTEGRITY_FAILED', '官方土地静态目录分母不一致', 500);
    }
  }
  const manifestBytes = fs.readFileSync(bundle.files.manifest);
  if (crypto.createHash('sha256').update(manifestBytes).digest('hex') !== bundle.manifestSha256) {
    throw problem('LAND_CATALOG_INTEGRITY_FAILED', '官方土地来源清单指纹不一致', 500);
  }
  loaded.manifest = JSON.parse(manifestBytes.toString('utf8'));
  const data = freeze(loaded);
  trustedImmutableTables.add(data);
  dataByVersion.set(bundle.directory, data);
  return data;
}
const positive = value => Number.isSafeInteger(value) && value > 0;

function createCatalog(bundle, { capabilityPolicy = null, sourceReadiness = null, sourceReadinessScope = null, verifiedTables = null, snapshot = null } = {}) {
  const tables = verifiedTables || load(bundle);
  const trustedTables = trustedImmutableTables.has(tables) || isDeepFrozenData(tables);
  if (trustedTables) trustedImmutableTables.add(tables);
  const sourceSnapshot = snapshot || officialDataSnapshotForSourceVersion(bundle.gameVersion);
  const row = (name, id) => positive(id) && plainObject(tables[name]) && Object.hasOwn(tables[name], String(id)) ? tables[name][id] : null;
  const identity = freeze({ catalogId: snapshot ? 'official-public/data-snapshot/' + snapshot.dataSnapshotId : tables.manifest.catalogId,
    apkSha256: null, indexVersion: snapshot?.sourceVersion ?? bundle.gameVersion, protocolVersion: snapshot?.protocolVersion ?? bundle.protocolVersion,
    dataSnapshotId: sourceSnapshot?.dataSnapshotId ?? null, contractId: snapshot?.contractId ?? OFFICIAL_CORE_CONTRACT_ID,
    dataSchemaContractId: snapshot?.dataSchemaContractId ?? null, loginResponseRef: snapshot?.loginResponseRef ?? null,
    sourceProofs: snapshot?.sourceProofs ?? null,
    ...(snapshot?.bundleSourceKey ? { bundleSourceKey: snapshot.bundleSourceKey } : {}),
    ...(snapshot?.bundleRef ? { bundleRef: snapshot.bundleRef } : {}),
    ...(snapshot?.resourceSha256 ? { resourceSha256: snapshot.resourceSha256 } : {}),
    ...(snapshot?.sourceIndexSha256 ? { sourceIndexSha256: snapshot.sourceIndexSha256 } : {}),
    ...(snapshot?.sourceConfigSha256 ? { sourceConfigSha256: snapshot.sourceConfigSha256 } : {}),
    manifestSha256: snapshot ? snapshot.dataSnapshotId.replace(/^sha256:/, '') : bundle.manifestSha256,
    // Static consumers historically pin the exact checked-in JSON bytes;
    // fetched snapshots carry normalized table-content hashes instead.
    tableSha256: snapshot?.tableHashes ?? bundle.hashes,
    currentHotUpdateProven: true, currentServerCatalogProven: false });
  const auditedFields = purpose => typeof purpose === 'string' ? AUDITED_FIELDS[purpose] || freeze([]) : AUDITED_FIELDS;
  function sourcePolicy({ gameVersion, protocolVersion, observation } = {}) {
    const version = observation?.versionEvidence;
    const profileBinding = version?.profileBinding;
    const frameVersionCompatible = observation?.protocolVersion == null || observation.protocolVersion === protocolVersion ||
      profileBinding?.connectionEpoch === observation?.connectionEpoch && verifyOfficialServerVersionFrame({ versionEvidence: version,
        frameProtocolVersion: observation.protocolVersion,
        frameReportedServerVersion: observation.reportedServerVersion ?? observation.protocolVersion,
        context: profileBinding, officialUid: profileBinding?.officialUid });
    const reasonCode = !version || version.gameVersion !== gameVersion || version.protocolVersion !== protocolVersion || protocolVersion !== identity.protocolVersion
        || typeof version.loginResponseRef !== 'string' || !version.loginResponseRef ? 'LAND_SOURCE_VERSION_BINDING_MISSING'
      : !frameVersionCompatible ? 'LAND_SOURCE_FRAME_VERSION_CONFLICT'
      : observation?.source !== 'response' || observation?.envelopeOk !== true || observation?.rejected === true
        || observation?.dsName !== 'G.ISyncData' || !SYNC_METHODS.has(observation?.method)
        || !positive(observation?.connectionEpoch) || !positive(observation?.requestSequence)
        || typeof observation?.wireKey !== 'string' || !observation.wireKey
        || typeof observation?.responseRef !== 'string' || !observation.responseRef
        || !plainObject(observation?.value) ? 'LAND_SOURCE_NOT_MATCHED_NORMAL_SYNC' : null;
    const usr = observation?.value?.['7']?.['0'];
    const providedMap = key => plainObject(usr) && Object.hasOwn(usr, key) && plainObject(usr[key]);
    const sourceFingerprint = identity.manifestSha256 || identity.dataSnapshotId || null;
    const evidenceRef = 'official-source-policy:' + identity.dataSnapshotId + ':' + sourceFingerprint;
    return freeze({ supported: reasonCode === null, reasonCode, catalogId: identity.catalogId, manifestSha256: sourceFingerprint,
      versionEvidenceRefs: reasonCode === null ? [evidenceRef, version.loginResponseRef] : [], fieldsByPurpose: AUDITED_FIELDS,
      coverage: { landMapComplete: false, bagComplete: reasonCode === null && providedMap('32'),
        itemExtComplete: reasonCode === null && providedMap('33'), evidenceRef: reasonCode === null ? evidenceRef : null } });
  }
  function flowerLevel(flowerId, level) {
    if (!row('c_flower', flowerId) || !positive(level) || level > 99) return freeze({ known: false, value: null, sourceRows: [], reasonCode: 'LAND_FLOWER_LEVEL_UNKNOWN' });
    const exactId = Number(String(flowerId) + String(level).padStart(2, '0'));
    const exact = row('c_flowerLvl', exactId);
    if (exact) return freeze({ known: true, value: clone(exact), sourceRows: ['c_flowerLvl:' + exactId], formulaVersion: 'G480/382433/exact', issues: [] });
    const base = row('c_flowerLvl', flowerId), cfg = row('c_flowerLvlCfg', level), first = row('c_flowerLvlCfg', 1);
    if (!base || !cfg || !first) return freeze({ known: false, value: null, sourceRows: [], reasonCode: 'LAND_FLOWER_LEVEL_ROW_MISSING' });
    const value = { fLvl: level };
    for (const [key, one] of Object.entries(cfg)) {
      if (key === 'id') continue;
      if (key === 'gldCost' || key === 'cd') {
        if (![base[key], one, first[key]].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0) || first[key] === 0) {
          return freeze({ known: false, value: null, sourceRows: [], reasonCode: 'LAND_FLOWER_LEVEL_FORMULA_UNSUPPORTED' });
        }
        const result = Math.round(base[key] * (one / first[key]));
        if (!Number.isSafeInteger(result)) return freeze({ known: false, value: null, sourceRows: [], reasonCode: 'LAND_FLOWER_LEVEL_OVERFLOW' });
        value[key] = result;
      } else if (key === 'lvlUpCost') value[key] = [flowerId - 1000, one];
      else value[key] = clone(one);
    }
    return freeze({ known: true, value, sourceRows: ['c_flowerLvl:' + flowerId, 'c_flowerLvlCfg:' + level, 'c_flowerLvlCfg:1'],
      formulaVersion: 'G480/382433+8317+8380/ratio', issues: [] });
  }
  function supports({ purpose = 'land', flowerId = null, fields = [] } = {}) {
    if (!Object.hasOwn(AUDITED_FIELDS, purpose) || !Array.isArray(fields) || fields.some(field => !AUDITED_FIELDS[purpose].includes(field))) {
      return freeze({ supported: false, reasonCode: 'LAND_CATALOG_FIELDS_UNAUDITED', versionEvidenceRefs: [] });
    }
    if (flowerId !== null && !row('c_flower', flowerId)) return freeze({ supported: false, reasonCode: 'LAND_CATALOG_FLOWER_UNSUPPORTED', versionEvidenceRefs: [] });
    if (typeof capabilityPolicy === 'function') {
      const result = capabilityPolicy(freeze({ purpose, flowerId, fields: [...fields], catalogIdentity: identity }));
      if (result?.then) throw problem('LAND_CATALOG_POLICY_ASYNC', '目录能力核对必须同步', 500);
      return freeze({ supported: result?.supported === true, reasonCode: result?.reasonCode || (result?.supported === true ? null : 'LAND_CURRENT_CATALOG_UNVERIFIED'),
        versionEvidenceRefs: Array.isArray(result?.versionEvidenceRefs) ? result.versionEvidenceRefs.filter(ref => typeof ref === 'string').map(ref => ref.slice(0, 512)) : [] });
    }
    return freeze({ supported: false, reasonCode: 'LAND_CURRENT_CATALOG_UNVERIFIED', staticKnown: flowerId === null || !!row('c_flower', flowerId), versionEvidenceRefs: [] });
  }
  const sourceBundleCurrent = () => !identity.bundleRef || !sourceReadiness || sourceReadiness(identity) === true;
  function withSourceReadiness(callback) {
    if (typeof callback !== 'function') throw new TypeError('Land source-readiness scope requires a callback');
    const result = typeof sourceReadinessScope === 'function' ? sourceReadinessScope(callback) : callback();
    if (result?.then) { result.catch?.(() => {}); throw problem('LAND_SOURCE_READINESS_SCOPE_ASYNC', '土地目录来源作用域必须同步完成', 500); }
    return result;
  }
  const facade = Object.freeze({ identity: () => identity, sourcePolicy, auditedFields, sourceBundleCurrent, withSourceReadiness,
    flower: id => row('c_flower', id), item: id => row('c_item', id), land: id => row('c_farmLand', id), flowerLevel,
    table: name => CATALOG_TABLE_NAMES.has(name) ? tables[name] ?? null : null,
    flowerQuality: id => { const one = row('c_item', id); return one && Number.isSafeInteger(one.color) && one.color >= 1 && one.color <= 5 ? one.color : null; },
    supports, ordinaryFlowerIds: () => Object.keys(tables.c_flower || {}).map(Number).filter(positive).sort((a, b) => a - b) });
  if (trustedTables && isDeepFrozenData(identity)) trustedOfficialLandCatalogs.add(facade);
  return facade;
}

export function createOfficialLandCatalog({ capabilityPolicy = null, sourceReadiness = null, sourceReadinessScope = null } = {}) {
  return createCatalog(BUNDLES['480.0.27'], { capabilityPolicy, sourceReadiness, sourceReadinessScope });
}

export function createOfficialLandCatalogRegistry({ capabilityPolicy = null, sourceReadiness = null, sourceReadinessScope = null } = {}) {
  const catalogs = new Map(Object.entries(BUNDLES).map(([gameVersion, bundle]) => [gameVersion,
    createCatalog(bundle, { capabilityPolicy, sourceReadiness, sourceReadinessScope })]));
  const bySnapshot = new Map();
  for (const [gameVersion, bundle] of Object.entries(BUNDLES)) {
    const staticCatalog = catalogs.get(gameVersion);
    const snapshot = officialDataSnapshotForSourceVersion(gameVersion);
    const snapshotId = staticCatalog.identity().dataSnapshotId;
    if (snapshotId && snapshot) bySnapshot.set(snapshotId, { tables: load(bundle), tableHashes: snapshot.tableHashes,
      contractId: OFFICIAL_CORE_CONTRACT_ID, dataSchemaContractId: OFFICIAL_GDATA_SCHEMA_CONTRACT_ID });
  }
  return Object.freeze({
    resolve: (gameVersion, protocolVersion) => {
      const catalog = catalogs.get(gameVersion);
      return catalog?.identity().protocolVersion === protocolVersion ? catalog : null;
    },
    identity: (gameVersion, protocolVersion) => catalogs.get(gameVersion)?.identity().protocolVersion === protocolVersion
      ? catalogs.get(gameVersion).identity() : null,
    resolveSnapshot: versionEvidence => {
      const dataSnapshotId = versionEvidence?.dataSnapshotId;
      const source = bySnapshot.get(dataSnapshotId);
      const protocolVersion = versionEvidence?.protocolVersion;
      const sourceVersion = versionEvidence?.gameVersion;
      const loginResponseRef = versionEvidence?.loginResponseRef;
      if (!source || protocolVersion !== '480.0.0' || !/^[0-9]+(?:\.[0-9]+){1,5}$/.test(sourceVersion || '') ||
          typeof loginResponseRef !== 'string' || !loginResponseRef || versionEvidence.source !== 'normal-package-hop-and-matched-world-login/v1' ||
          versionEvidence.sourceDataVersion !== sourceVersion || !plainObject(versionEvidence.profileBinding) ||
          versionEvidence.profileBinding.dataSnapshotId !== dataSnapshotId ||
          versionEvidence.profileBinding.loginResponseRef !== loginResponseRef ||
          versionEvidence.profileBinding.contractId !== source.contractId ||
          versionEvidence.contractId !== source.contractId || versionEvidence.dataSchemaContractId !== source.dataSchemaContractId ||
          canonical(versionEvidence.tableHashes) !== canonical(source.tableHashes) ||
          !plainObject(versionEvidence.sourceProofs) || !/^[a-f0-9]{64}$/.test(versionEvidence.resourceSha256 || '') ||
          !/^[a-f0-9]{64}$/.test(versionEvidence.sourceIndexSha256 || '') ||
          !/^[a-f0-9]{64}$/.test(versionEvidence.sourceConfigSha256 || '')) return null;
      const bundle = { gameVersion: sourceVersion, protocolVersion, directory: 'official-public-data-snapshot' };
      return createCatalog(bundle, { capabilityPolicy, sourceReadiness, sourceReadinessScope, verifiedTables: source.tables,
        snapshot: { dataSnapshotId, sourceVersion, protocolVersion, tableHashes: source.tableHashes,
          contractId: source.contractId, dataSchemaContractId: source.dataSchemaContractId, loginResponseRef,
          sourceProofs: versionEvidence.sourceProofs, resourceSha256: versionEvidence.resourceSha256,
          sourceIndexSha256: versionEvidence.sourceIndexSha256, sourceConfigSha256: versionEvidence.sourceConfigSha256,
          sourceBlockContractSha256: versionEvidence.sourceBlockContractSha256,
          bundleSourceKey: versionEvidence.bundleSourceKey, bundleRef: versionEvidence.bundleRef } });
    },
    registerDataSnapshot: ({ tables, dataSnapshotId, tableHashes, sourceVersion, protocolVersion, contractId,
      dataSchemaContractId, loginResponseRef, sourceProofs = null, bundleSourceKey = null, bundleRef = null,
      resourceSha256 = null, sourceIndexSha256 = null, sourceConfigSha256 = null } = {}) => {
      if (!plainObject(tables) || !/^(?:sha256:)?[a-f0-9]{64}$/.test(dataSnapshotId || '') ||
          !/^\d+(?:\.\d+){1,5}$/.test(sourceVersion || '') || protocolVersion !== '480.0.0' ||
          typeof loginResponseRef !== 'string' || !loginResponseRef ||
          typeof dataSchemaContractId !== 'string' || !dataSchemaContractId ||
          contractId !== OFFICIAL_CORE_CONTRACT_ID || !plainObject(tableHashes) || !Object.keys(tableHashes).length ||
          Object.keys(tableHashes).some(name => !OFFICIAL_PUBLIC_TABLE_NAMES.includes(name) ||
            !plainObject(tables[name]) || !/^[a-f0-9]{64}$/.test(tableHashes[name] || ''))) return null;
      const bundle = { gameVersion: sourceVersion, protocolVersion, directory: 'official-public-data-snapshot' };
      // The normalized table set is immutable and shared by snapshot ID. The
      // login proof belongs to a live connection, so each registration gets
      // its own catalog view and never writes that proof into the shared entry.
      const previous = bySnapshot.get(dataSnapshotId);
      if (previous && (canonical(previous.tableHashes) !== canonical(tableHashes) || previous.contractId !== contractId ||
          previous.dataSchemaContractId !== dataSchemaContractId)) return null;
      const source = { tables, tableHashes, contractId, dataSchemaContractId };
      bySnapshot.set(dataSnapshotId, source);
      const catalog = createCatalog(bundle, { capabilityPolicy, sourceReadiness, sourceReadinessScope, verifiedTables: tables,
        snapshot: { dataSnapshotId, tableHashes, sourceVersion, protocolVersion, contractId, dataSchemaContractId, loginResponseRef,
          sourceProofs, bundleSourceKey, bundleRef, resourceSha256, sourceIndexSha256, sourceConfigSha256 } });
      return catalog;
    },
  });
}
