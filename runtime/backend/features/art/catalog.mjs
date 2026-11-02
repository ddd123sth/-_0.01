import { fingerprint, freeze, problem } from '../../common.mjs';
import { OFFICIAL_GDATA_SCHEMA_CONTRACT_ID } from '../../official-public-data.mjs';
import { officialActionContractId, OFFICIAL_CORE_CONTRACT_ID } from '../../official-version-profile.mjs';

// Only public current-version metadata is queried through the existing
// catalogs. No request, ledger write, source-policy change or art feature is
// registered here. In particular these source facts do not admit G3B writes.
const SOURCE_27 = freeze({ gameVersion: '480.0.27', protocolVersion: '480.0.0',
  gameDecodedSha256: 'fc9970989021e4266301d2a167ae8e827ef71a124ad9d7f23cb922095a22aa69',
  artTableSha256: '636220908e677377ee4902a38a7ab6adb66540f86902199e99141eaff3de66da',
  itemTableSha256: '2ad2051ffa3b330438d8d2a0243227950a9b6afc7b75e75098ff9703a82f5f58',
  flowerTableSha256: '7c57fbd1af83c20b4ed0c74aeca50d50a376a731a67990482215aadb76f6fc2c',
  rangeConvention: 'zero-based UTF-8 decoded bytes, exclusive end',
  ranges: {
    makeCall: { start: 443841, end: 443947, sha256: '90e062df88aff58dd4138c560f3aa3b10f67ac854b007c27bd1dae6d3db9e399' },
    makeArguments: { start: 161704, end: 161792, sha256: '1191ac8d8865646d62a84dae8bdd245afbbd145afd48168a6112fedf6f1fc1b1' },
    ordinaryMake: { start: 1526512, end: 1527879, sha256: 'c8f87bcec7eb5e64d4c957ff3811a36c6ecb694ac9006238c363d2b0910b7ae7' },
    maxMakeQuantity: { start: 1523154, end: 1523412, sha256: 'e7445ea48e6360306e3db6c02a059164efa322f46c9c96ba96ca0bcd078003a2' },
    customerStockState: { start: 2372130, end: 2372753, sha256: '5711cd55fe311350fe43e05b6532a8200cfc2961d1174b07f7e755e4a2d196c8' },
    vaseManager: { start: 403846, end: 404094, sha256: '734db7266bb54730e9896c5004c8f9212bc16e2103af6ada99c6ece5bdc16a1c' },
    vaseMember: { start: 95427, end: 95501, sha256: '19254773ec09cf5831fab1ea2e056e98a108d1a9088f8ec4052cb263e06f86f0' },
    vaseDomain: { start: 116090, end: 116158, sha256: '2499295ffef35b1e85ecf6120ee45d50f363ac48ebdaeab0b3c0cc01432079a9' },
    artMember: { start: 95616, end: 95715, sha256: '029b7e30c89301a6fae6767b6d7bc2a0029b9a622b0b0eb4f0f2cd26446d1100' },
    artDomain: { start: 116322, end: 116384, sha256: '45c3de017aa518d0ff631e1b30319851d5db0a28ef4265988e5b894ff3f7539e' },
    getItemNum: { start: 281846, end: 281954, sha256: '723a01cd21f31fb57befd1b29eb6a9dfb3e476707cbbf72346cd87c6a7f5aa7b' },
    itemEffectiveQuantity: { start: 184205, end: 186098, sha256: '80c9c8d04c3e41303327f1192c9078738b92144fa9c136f18f2823d171bdf50b' },
    itemFlows: { start: 47252, end: 47494, sha256: 'e3b46138b3672a4879ee0228b1106716926178f8b67e6ddff75af79d154c01d1' },
    absoluteBagPatch: { start: 276874, end: 277948, sha256: 'e35083f0abbc5203b9c2935a268bdeffa72c743de7c29debf12e401edc765771' },
  } });
const SOURCE_46 = freeze({ gameVersion: '480.0.46', protocolVersion: '480.0.0',
  profileId: 'official-game-480.0.46-world-480.0.0/v1',
  gameDecodedSha256: 'bf21efb47a54dca0ab5e249062da828d2ec8981388977ebfc1524c75236c9845',
  artTableSha256: '9b75a8ed53b6e7d481bf6d57847b70a275ee4a2af5b7753d27ec972f36555d03',
  itemTableSha256: '2c93b367cae5771d7ede9c0797e32773cdb9ab9273677fed51af86a042e1e4d6',
  flowerTableSha256: 'fab2310163f1f034fe688af1179c6165bdbaff4c640477b5251a42962599fbfd',
  compatibilityManifestSha256: '422874daaa9f4bc4bc9e39223b4e8a1ba7ab8a8aa710c5ec3ee0947be941b899',
  sharedCodeContract: 'G480 art rules are reused only for source ranges verified byte-identical against 480.0.46; visual c_flowerArt fields are not used for business rules',
  rangeConvention: 'zero-based UTF-8 decoded bytes, exclusive end',
  ranges: { makeCall: { start: 443841, end: 443944, sha256: 'cad7feb8757e4f4803dbacefb6715e0fdd51cedd620f2c125d9bce152186e7e4' } } });
const positive = value => Number.isSafeInteger(value) && value > 0;

export function createOfficialArtCatalog({ customerCatalog, landCatalog, landCatalogForContext = null } = {}) {
  if (typeof customerCatalog?.art !== 'function' || typeof landCatalog?.item !== 'function'
    || typeof landCatalog?.flower !== 'function' || typeof landCatalog?.identity !== 'function') {
    throw new TypeError('Official art catalog requires the current customer art and land catalogs');
  }
  const identity = landCatalog.identity();
  const dynamic = identity?.catalogId?.startsWith('official-public/data-snapshot/') === true &&
    typeof identity.dataSnapshotId === 'string' && typeof landCatalog.table === 'function';
  const source = dynamic ? { gameVersion: identity.indexVersion, protocolVersion: identity.protocolVersion,
    dataSnapshotId: identity.dataSnapshotId, loginResponseRef: identity.loginResponseRef, contractId: identity.contractId, dataSchemaContractId: identity.dataSchemaContractId,
    itemTableSha256: identity.tableSha256?.c_item, flowerTableSha256: identity.tableSha256?.c_flower,
    artTableSha256: identity.tableSha256?.c_flowerArt, sourceProof: identity.sourceProofs?.['art.make'] ?? null }
    : identity?.indexVersion === '480.0.27' ? SOURCE_27 : identity?.indexVersion === '480.0.46' ? SOURCE_46 : null;
  if (!source || identity?.protocolVersion !== '480.0.0' || (dynamic
    ? identity.contractId !== OFFICIAL_CORE_CONTRACT_ID || identity.dataSchemaContractId !== OFFICIAL_GDATA_SCHEMA_CONTRACT_ID ||
      !/^[a-f0-9]{64}$/.test(source.itemTableSha256 || '') || !/^[a-f0-9]{64}$/.test(source.flowerTableSha256 || '') ||
      !/^[a-f0-9]{64}$/.test(source.artTableSha256 || '')
    : identity?.tableSha256?.c_item !== source.itemTableSha256 || identity?.tableSha256?.c_flower !== source.flowerTableSha256)) {
    throw problem('ART_CATALOG_VERSION_MISMATCH', '花艺配方与当前物品及花材静态目录版本不一致', 500);
  }
  let activeRecipeScope = null;
  function buildRecipe(artId) {
    const unavailable = reasonCode => freeze({ known: false, artId: positive(artId) ? artId : null,
      staticOnly: true, runtimeEligibilityProven: false, reasonCode, source });
    if (dynamic) {
      if (landCatalog.sourceBundleCurrent?.() === false) return unavailable('OFFICIAL_PUBLIC_SOURCE_REFRESH_PENDING');
      const proof = source.sourceProof;
      if (proof?.supported !== true || proof.actionContractId !== officialActionContractId('art.make') ||
          proof.coreContractId !== OFFICIAL_CORE_CONTRACT_ID || proof.sourceVersion !== identity.indexVersion ||
          proof.protocolVersion !== identity.protocolVersion || !/^[a-f0-9]{64}$/.test(proof.gameSha256 || '') ||
          !/^[a-f0-9]{64}$/.test(proof.moSha256 || '')) return unavailable('ART_SOURCE_CONTRACT_UNPROVEN');
    }
    const row = positive(artId) ? customerCatalog.art(artId) : null;
    if (!row || row.id !== artId) return unavailable('ART_RECIPE_NOT_IN_CURRENT_CATALOG');
    const output = landCatalog.item(artId);
    if (!output || output.id !== artId || output.type !== 12
      || ['reset', 'restore', 'limit'].some(key => Object.hasOwn(output, key))) return unavailable('ART_OUTPUT_ITEM_RULE_UNSUPPORTED');
    // vase is an actual c_flowerArt column. The client passes it directly for
    // an existing art: never infer a vase from floor(artId / 100).
    if (!positive(row.vase)) return unavailable('ART_RECIPE_VASE_UNREADABLE');
    if (!Array.isArray(row.flowers) || row.flowers.length !== 3 || row.flowers.some(id => !positive(id)
      || landCatalog.flower(id)?.id !== id || landCatalog.item(id)?.id !== id)) {
      return unavailable('ART_RECIPE_FLOWERS_UNSUPPORTED');
    }
    const flowersIds = [...row.flowers], counts = new Map();
    // Preserve every request position, including multiplicity. The audited
    // current 1591 rows happen to have three distinct entries; that observation
    // is not a generic hard-coded three-item fee vector.
    for (const itemId of flowersIds) counts.set(itemId, (counts.get(itemId) || 0) + 1);
    const unitInputMultiset = [...counts].sort(([a], [b]) => a - b).map(([itemId, occurrences]) => ({ itemId, occurrences }));
    const rowProof = dynamic ? { sourceVersion: identity.indexVersion, protocolVersion: identity.protocolVersion,
      dataSnapshotId: identity.dataSnapshotId, loginResponseRef: identity.loginResponseRef,
      tableSha256: identity.tableSha256?.c_flowerArt, row: { id: row.id, vase: row.vase, flowers: [...flowersIds] },
      fingerprint: fingerprint({ id: row.id, vase: row.vase, flowers: [...flowersIds] }) } : null;
    return freeze({ known: true, staticOnly: true, runtimeEligibilityProven: false, artId, vaseId: row.vase, flowersIds,
      quality: Number.isSafeInteger(output.color) && output.color >= 1 && output.color <= 5 ? output.color : null,
      outputItemRow: { id: output.id, type: output.type, color: Number.isSafeInteger(output.color) ? output.color : null }, rowProof,
      unitInputMultiset, unitRequest: { vaseId: row.vase, flowersIds: [...flowersIds], num: 1 },
      fees: { known: false, actualConsumptionProven: false, reasonCode: 'ART_MAKE_OFFICIAL_COST_NOT_OBSERVED',
        clientExpectedFlowerConsumption: unitInputMultiset.map(({ itemId, occurrences }) => ({ itemId, quantity: occurrences })),
        expectationBasis: 'ordered recipe input plus current client per-flower quantity guards; not a server debit receipt',
        additionalCurrencyCostKnown: false, vaseConsumptionProven: false,
        sourceRefs: ['G480/makeCall', 'G480/makeArguments', 'G480/maxMakeQuantity', 'G480/customerStockState',
          'G480/getItemNum', 'G480/itemEffectiveQuantity', 'G480/itemFlows', 'G480/absoluteBagPatch'],
        requiredOfficialEvidence: ['matched-make-response/7.2.1:bo', 'matched-make-response/7.2.2:bd-or-explicit-absolute-bag',
          'same-connection-independent-new-read/absolute-consumed-and-produced-items'] },
      expectedProduct: { itemId: artId, requestedQuantity: 1, actualOutputProven: false },
      liveRequirements: {
        vase: { mapPath: '102.0', memberKey: String(row.vase), uidPath: '102.0[vaseId].0', vaseIdPath: '102.0[vaseId].1',
          meaning: 'current positive owned-vase member with matching current official UID and vaseId; not a bag count' },
        ownArt: { uidPath: '106.0.0', makeListPath: '106.0.2', meaning: 'makeList is first-make history, not product quantity' },
        inventory: { bagPath: '7.0.32', itemExtPath: '7.0.33', gainPath: '7.2.0', consumePath: '7.2.1', absolutePatchPath: '7.2.2',
          meaning: 'bi/bo are flows; bd is absolute and must not be subtracted again' },
      }, sourceRows: ['c_flowerArt:' + artId, 'c_item:' + artId, ...flowersIds.map(id => 'c_flower:' + id)],
      source: dynamic ? { ...source, sourceProof: { actionContractId: source.sourceProof.actionContractId,
        supported: source.sourceProof.supported, sourceVersion: source.sourceProof.sourceVersion,
        protocolVersion: source.sourceProof.protocolVersion, coreContractId: source.sourceProof.coreContractId,
        indexSha256: source.sourceProof.indexSha256, gameSha256: source.sourceProof.gameSha256,
        moSha256: source.sourceProof.moSha256, matchedBlocks: source.sourceProof.matchedBlocks } } : source,
      reasonCode: null });
  }
  function recipe(artId) {
    const scope = activeRecipeScope;
    if (scope?.has(artId)) return scope.get(artId);
    const value = buildRecipe(artId);
    if (scope) scope.set(artId, value);
    return value;
  }
  const facade = { recipe,
    item: id => landCatalog.item(id),
    share: id => {
      if (!positive(id) || landCatalog.sourceBundleCurrent?.() === false) return null;
      const row = landCatalog.table?.('c_share')?.[id];
      if (!row || row.id !== id) return null;
      return freeze({ ...row, source: { gameVersion: identity.indexVersion, protocolVersion: identity.protocolVersion,
        dataSnapshotId: identity.dataSnapshotId, loginResponseRef: identity.loginResponseRef, bundleRef: identity.bundleRef,
        tableSha256: identity.tableSha256?.c_share || null } });
    },
    artIds: () => {
      const rows = landCatalog.table?.('c_flowerArt');
      return rows && typeof rows === 'object' ? Object.keys(rows).map(Number).filter(positive).sort((a, b) => a - b) : [];
    } };
  facade.withSourceReadiness = callback => {
    if (typeof callback !== 'function') throw new TypeError('Art source-readiness scope requires a callback');
    const run = () => {
      const parent = activeRecipeScope, scope = new Map();
      activeRecipeScope = scope;
      try {
        const result = callback();
        if (result?.then) { result.catch?.(() => {}); throw new TypeError('Art source-readiness scope must be synchronous'); }
        return result;
      } finally {
        scope.clear();
        activeRecipeScope = parent;
        if (parent) parent.clear();
      }
    };
    return typeof landCatalog.withSourceReadiness === 'function' ? landCatalog.withSourceReadiness(run) : run();
  };
  if (typeof landCatalogForContext === 'function') facade.forContext = context => {
    const currentLand = landCatalogForContext(context), currentCustomer = customerCatalog.forContext?.(context);
    if (!currentLand || !currentCustomer) return null;
    const currentIdentity = currentLand.identity?.();
    if (currentIdentity?.manifestSha256 === identity.manifestSha256 && currentIdentity?.loginResponseRef === identity.loginResponseRef &&
      currentIdentity?.indexVersion === identity.indexVersion && currentIdentity?.protocolVersion === identity.protocolVersion &&
      currentIdentity?.bundleRef === identity.bundleRef) return facade;
    return createOfficialArtCatalog({ customerCatalog: currentCustomer, landCatalog: currentLand });
  };
  return Object.freeze(facade);
}
