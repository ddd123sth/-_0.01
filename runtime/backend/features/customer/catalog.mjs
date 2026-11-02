import fs from 'node:fs';
import crypto from 'node:crypto';
import { freeze, plainObject, problem } from '../../common.mjs';
import { createOfficialLandCatalog, isTrustedOfficialLandCatalog } from '../land/catalog.mjs';
import { OFFICIAL_GDATA_SCHEMA_CONTRACT_ID } from '../../official-public-data.mjs';
import { officialActionContractId, OFFICIAL_CORE_CONTRACT_ID } from '../../official-version-profile.mjs';

// Public data copied into this repository. Neither ignored preparation files
// nor application code are accessed by the runtime.
const BUNDLES = Object.freeze({
  '480.0.27': Object.freeze({ files: Object.freeze({
    c_flowerArt: new URL('../../catalogs/official-customer-480.0.27/c_flowerArt.json', import.meta.url),
    manifest: new URL('../../catalogs/official-customer-480.0.27/manifest.json', import.meta.url),
  }), hashes: Object.freeze({ c_flowerArt: '636220908e677377ee4902a38a7ab6adb66540f86902199e99141eaff3de66da',
    manifest: 'e3f4b39f41b1e358095174a2ebb3fa2c16c02a60b8bd35c1b377f49641cded2d' }),
    catalogId: 'official-public/customer-480.0.27', itemRuleVersion: 'official-480.0.27/G480-ordinary-flower-art/v1',
    itemTableSha256: '2ad2051ffa3b330438d8d2a0243227950a9b6afc7b75e75098ff9703a82f5f58',
    landManifestSha256: 'eaa7a0c91cc605a3b212f16ba0d2bb503b6cad15263d4ef2991490abaa7d9e37' }),
  '480.0.46': Object.freeze({ files: Object.freeze({
    c_flowerArt: new URL('../../catalogs/official-customer-480.0.46/c_flowerArt.json', import.meta.url),
    manifest: new URL('../../catalogs/official-customer-480.0.46/manifest.json', import.meta.url),
  }), hashes: Object.freeze({ c_flowerArt: '9b75a8ed53b6e7d481bf6d57847b70a275ee4a2af5b7753d27ec972f36555d03',
    manifest: '92d6063a883d09c591346361038c16df35dbb23c4881b0ee3d91814d481c2621' }),
    catalogId: 'official-public/customer-480.0.46', itemRuleVersion: 'official-480.0.46/G480-ordinary-flower-art/v1',
    itemTableSha256: '2c93b367cae5771d7ede9c0797e32773cdb9ab9273677fed51af86a042e1e4d6',
    landManifestSha256: 'e634d96d688cdcae1ad26c64974322d0e1ca516f86f408c53102e01d50d3a0ee' }),
});
const positive = value => Number.isSafeInteger(value) && value > 0;
const noStaticRestoration = item => !['reset', 'restore', 'limit'].some(key => Object.hasOwn(item, key));
const dataByManifest = new Map();
function load(bundle) {
  if (dataByManifest.has(bundle.hashes.manifest)) return dataByManifest.get(bundle.hashes.manifest);
  const loaded = {};
  for (const [name, file] of Object.entries(bundle.files)) {
    const bytes = fs.readFileSync(file);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== bundle.hashes[name]) {
      throw problem('CUSTOMER_CATALOG_INTEGRITY_FAILED', '官方顾客静态目录指纹不一致', 500);
    }
    loaded[name] = JSON.parse(bytes.toString('utf8'));
  }
  if (!plainObject(loaded.c_flowerArt) || Object.keys(loaded.c_flowerArt).length !== 1592
    || Object.entries(loaded.c_flowerArt).filter(([id]) => positive(Number(id))).length !== 1591) {
    throw problem('CUSTOMER_CATALOG_INTEGRITY_FAILED', '官方顾客静态目录分母不一致', 500);
  }
  const data = freeze(loaded);
  dataByManifest.set(bundle.hashes.manifest, data);
  return data;
}

export function createOfficialCustomerCatalog({ landCatalog = createOfficialLandCatalog(), landCatalogForContext = null } = {}) {
  if (typeof landCatalog?.item !== 'function' || typeof landCatalog?.identity !== 'function') {
    throw new TypeError('Official customer catalog requires the audited land item catalog');
  }
  const identity = landCatalog.identity();
  const bundle = BUNDLES[identity.indexVersion] ?? null;
  const dynamic = typeof identity.dataSnapshotId === 'string' && typeof identity.loginResponseRef === 'string' &&
    typeof landCatalog.table === 'function' && plainObject(landCatalog.table('c_flowerArt'));
  if (identity.protocolVersion !== '480.0.0' || (dynamic
    ? identity.contractId !== OFFICIAL_CORE_CONTRACT_ID
      || identity.dataSchemaContractId !== OFFICIAL_GDATA_SCHEMA_CONTRACT_ID
      || !/^[a-f0-9]{64}$/.test(identity.tableSha256?.c_item || '')
      || !/^[a-f0-9]{64}$/.test(identity.tableSha256?.c_flowerArt || '')
      : !bundle || identity.manifestSha256 !== bundle.landManifestSha256 || identity.tableSha256?.c_item !== bundle.itemTableSha256)) {
    throw problem('CUSTOMER_ITEM_CATALOG_VERSION_MISMATCH', '顾客成品与物品静态目录版本不一致', 500);
  }
  const staticTables = dynamic ? null : load(bundle);
  const contextCatalogs = new WeakMap();
  const artTable = dynamic ? landCatalog.table('c_flowerArt') : staticTables.c_flowerArt;
  const customerCatalogId = dynamic ? `official-public/customer-${identity.indexVersion}` : bundle.catalogId;
  const supportedAction = action => {
    if (!dynamic) return true;
    const proof = identity.sourceProofs?.[action];
    return proof?.supported === true && proof.actionContractId === officialActionContractId(action) &&
      proof.coreContractId === OFFICIAL_CORE_CONTRACT_ID && proof.sourceVersion === identity.indexVersion &&
      proof.protocolVersion === identity.protocolVersion && /^[a-f0-9]{64}$/.test(proof.gameSha256 || '') &&
      /^[a-f0-9]{64}$/.test(proof.moSha256 || '');
  };
  const validArtRow = (id, row) => row?.id === id && positive(row.vase) && Array.isArray(row.flowers) &&
    row.flowers.length === 3 && row.flowers.every(positive);
  const art = id => positive(id) && Object.hasOwn(artTable, String(id)) && validArtRow(id, artTable[id])
    ? artTable[id] : null;
  const ordinary = [], rules = new Map();
  const missing = [];
  for (const [key, row] of Object.entries(artTable)) {
    const id = Number(key);
    if (!positive(id)) continue;
    if (!validArtRow(id, row)) continue;
    const item = landCatalog.item(id);
    if (!item) { missing.push(id); continue; }
    if (item.id !== id || item.type !== 12 || !noStaticRestoration(item)) continue;
    ordinary.push(id);
    rules.set(id, freeze({ itemId: id, kind: 'ordinary-flower-art', staticItemType: 12,
      staticResetRestoreLimitAbsent: true, ruleVersion: dynamic ? 'G480/ordinary-flower-art/semantic-v1' : bundle.itemRuleVersion,
      catalogId: customerCatalogId,
      manifestSha256: dynamic ? identity.manifestSha256 : bundle.hashes.manifest,
      dataSnapshotId: dynamic ? identity.dataSnapshotId : null,
      artTableSha256: dynamic ? identity.tableSha256?.c_flowerArt ?? null : bundle.hashes.c_flowerArt,
      itemTableSha256: dynamic ? identity.tableSha256.c_item : bundle.itemTableSha256,
      sourceRefs: ['c_flowerArt:' + id, 'c_item:' + id, ...(dynamic ? ['data-snapshot:' + identity.dataSnapshotId,
        'matched-login:' + identity.loginResponseRef, ...(supportedAction('customer.finish') ? ['source-proof:customer.finish'] : [])] : [])] }));
  }
  if (!dynamic && (ordinary.length !== 1590 || missing.length !== 1 || missing[0] !== 308701)) {
    throw problem('CUSTOMER_CATALOG_INTEGRITY_FAILED', '官方成品与物品交集分母不一致', 500);
  }
  const ids = Object.freeze(ordinary.sort((a, b) => a - b));
  const open = name => {
    if (!dynamic || typeof name !== 'string') return null;
    const table = landCatalog.table('c_open'), row = plainObject(table) ? table[name] : null;
    return row?.id === name ? row : null;
  };
  const generationPolicy = () => {
    if (!dynamic || !supportedAction('customer.generate')) return null;
    const table = landCatalog.table('c_orderCustomerNpc'), meta = table?.['-1'], npcIds = meta?.$npcId;
    if (!plainObject(table) || !Array.isArray(npcIds) || !positive(meta?.$npcMax) || !positive(meta?.$npcMaxDay) ||
      !npcIds.length || npcIds.length > 128 || !npcIds.every(id => positive(id) && positive(table[String(id)]?.maintaskId))) return null;
    const npcs = npcIds.map(id => ({ id, mainTaskId: table[String(id)].maintaskId,
      spokes: table[String(id)].isSpokes === 1 })).sort((a, b) => a.id - b.id);
    return freeze({ gameVersion: identity.indexVersion, protocolVersion: identity.protocolVersion, maxBoard: meta.$npcMax,
      dailyLimit: meta.$npcMaxDay, clientNextTimeOffsetMs: 1000, npcIds: [...npcIds], npcs,
      source: { gameDecodedSha256: identity.sourceProofs?.['customer.generate']?.gameSha256 ?? null,
        npcTableSha256: identity.tableSha256?.c_orderCustomerNpc ?? null, dataSnapshotId: identity.dataSnapshotId,
        loginResponseRef: identity.loginResponseRef, sourceProof: identity.sourceProofs?.['customer.generate'] ?? null,
        maxBoard: meta.$npcMax, dailyLimit: meta.$npcMaxDay, npcs } });
  };

  // Static item-1002 unit metadata only. The caller must separately establish
  // current order identity, quantity, acceptance, and actual official reward.
  function rewardPolicy(artId) {
    const row = art(artId);
    const unavailable = reasonCode => freeze({ known: false, artId: positive(artId) ? artId : null,
      itemId: 1002, quantityPerUnit: null, staticOnly: true, reasonCode });
    if (!row) return unavailable('CUSTOMER_ART_STATIC_ROW_MISSING');
    if (!supportedAction('customer.finish')) return unavailable('CUSTOMER_FINISH_SOURCE_CONTRACT_UNPROVEN');
    const explicit = Array.isArray(row.cPrice) && row.cPrice.length > 0;
    const pairs = explicit ? row.cPrice : [artTable['-1']?.$cPrice];
    if (!Array.isArray(pairs) || pairs.some(pair => !Array.isArray(pair) || pair.length !== 2
      || !positive(pair[0]) || !Number.isSafeInteger(pair[1]) || pair[1] < 0)) {
      return unavailable('CUSTOMER_REWARD_STATIC_RULE_UNREADABLE');
    }
    const matches = pairs.filter(pair => pair[0] === 1002);
    if (matches.length !== 1 || !positive(matches[0][1])) return unavailable('CUSTOMER_REWARD_1002_UNSUPPORTED');
    return freeze({ known: true, artId, itemId: 1002, quantityPerUnit: matches[0][1], staticOnly: true,
      sourceKind: explicit ? 'cPrice' : 'meta.$cPrice', sourceRow: explicit ? 'c_flowerArt:' + artId : 'c_flowerArt:-1',
      catalogId: customerCatalogId, manifestSha256: dynamic ? identity.manifestSha256 : bundle.hashes.manifest,
      dataSnapshotId: dynamic ? identity.dataSnapshotId : null,
      tableSha256: dynamic ? identity.tableSha256?.c_flowerArt ?? null : bundle.hashes.c_flowerArt,
      sourceRuleRef: 'G480/calOrderCustomerRwd/443147:443841', reasonCode: null });
  }
  const facade = { art, open, generationPolicy, identity: () => identity,
    ordinaryArtIds: () => dynamic && !supportedAction('customer.generate') ? Object.freeze([]) : ids,
    supports: (action, versionEvidence = null) => ['customer.generate', 'customer.finish', 'customer.reject'].includes(action) &&
      supportedAction(action) && (!dynamic || landCatalog.sourceBundleCurrent?.() !== false) &&
      (!versionEvidence || versionEvidence.gameVersion === identity.indexVersion &&
        versionEvidence.protocolVersion === identity.protocolVersion && (!dynamic ||
          versionEvidence.loginResponseRef === identity.loginResponseRef && versionEvidence.dataSnapshotId === identity.dataSnapshotId)),
    itemRule: (id, versionEvidence = null) => positive(id) && facade.supports('customer.finish', versionEvidence) ? rules.get(id) || null : null,
    rewardPolicy: (artId, versionEvidence = null) => facade.supports('customer.finish', versionEvidence) ? rewardPolicy(artId)
      : freeze({ known: false, artId: positive(artId) ? artId : null, itemId: 1002, quantityPerUnit: null, staticOnly: true,
        reasonCode: 'CUSTOMER_FINISH_SOURCE_CONTRACT_UNPROVEN' }) };
  if (typeof landCatalogForContext === 'function') facade.forContext = context => {
    const current = landCatalogForContext(context);
    const unavailable = Object.freeze({ art: () => null, ordinaryArtIds: () => Object.freeze([]), itemRule: () => null,
      rewardPolicy: artId => freeze({ known: false, artId: positive(artId) ? artId : null, itemId: 1002,
        quantityPerUnit: null, staticOnly: true, reasonCode: 'CUSTOMER_CURRENT_SOURCE_UNAVAILABLE' }), supports: () => false });
    if (!current) return unavailable;
    const currentIdentity = current.identity?.();
    if (currentIdentity?.manifestSha256 === identity.manifestSha256 && currentIdentity?.loginResponseRef === identity.loginResponseRef &&
      currentIdentity?.indexVersion === identity.indexVersion && currentIdentity?.protocolVersion === identity.protocolVersion &&
      currentIdentity?.bundleRef === identity.bundleRef) return facade;
    const trusted = isTrustedOfficialLandCatalog(current);
    if (trusted) {
      const cached = contextCatalogs.get(current);
      if (cached) return cached;
    }
    try {
      const resolved = createOfficialCustomerCatalog({ landCatalog: current });
      if (trusted) contextCatalogs.set(current, resolved);
      return resolved;
    } catch { return unavailable; }
  };
  return Object.freeze(facade);
}
