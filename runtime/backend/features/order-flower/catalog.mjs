import fs from 'node:fs';
import crypto from 'node:crypto';
import { clone, freeze, plainObject, problem } from '../../common.mjs';
import { officialActionContractId, officialActionContracts, OFFICIAL_CORE_CONTRACT_ID } from '../../official-version-profile.mjs';

const CATALOG_SHA = 'fd329dd26f74bddf05fd7dcf0fb1700444783b5ed73c6517bd0f156396df0041';
const SOURCE_SHA = '87a98fdcfb13e966065f37780f3d12dbd0aae295a8941ae17bbcdfff7e7b417c';
export const ORDER_FLOWER_SOURCE = freeze({ gameVersion: '480.0.27', protocolVersion: '480.0.0',
  gameDecodedSha256: 'fc9970989021e4266301d2a167ae8e827ef71a124ad9d7f23cb922095a22aa69',
  moDecodedSha256: '1cde77350e5472509f695090546ed311d3b0b65618ba681653daa99f0691cf3b',
  orderDS: { range: [95715, 96025], sha256: '4857f4c56796defb96f2e3c3f565dc58a51031a5918e43fa0e2d73b74160db1c' },
  residentDS: { range: [116384, 116608], sha256: 'bda2e7204a062d28695e61a51bcdcf7d60b778cd9a005568cb2472e9f9e687f9' },
  satinDS: { range: [123067, 123205], sha256: 'ce66ea7e1d95229cb0402874257265fbd8d9947e587ef2116626e93d8b1137c9' },
  decorateDS: { range: [126294, 126433], sha256: '3d285322a7b81afdf26fcc3ce6240ab7f51d732b053e2bdb4feb6725d54484e7' },
  shareDS: { range: [33143, 33265], sha256: '8cdeca54b555249861c4953fd2c7d4c26175b00947a31806b19635cf3e429fd3' },
  cardDS: { range: [31878, 32050], sha256: 'f83a2d5e74cbe58028ebd56e949ba05ebc297fa63db596e3f85ffab4dbaf4d35' },
  countRule: { range: [717940, 718075], sha256: '993401e2dc4d58c422d92866e639f5dd9db9b0ddbb8a6cf82ca1ba7a599c16f4' },
  shareRefresh: { range: [208582, 208713], sha256: 'bd42a360b45f8c43f7ab361cc71cf2868efdcc087e6a9d44a4996bf142759533' },
  videoCall: { range: [2337953, 2338165], sha256: 'c40e2caca3932b2250b27afd702f9a1bf6751488b108d9685635928471929d8c' },
  cardValidity: { range: [337945, 338062], sha256: '2178cb9e87df4c2a7be115dd39fb872d489bb7c0f1c82f20bf2328d2f86bcb98' },
  wirePaths: { order: ['105', '0'], resident: ['105', '0', '1'], satin: ['105', '0', '6'], decorate: ['105', '0', '7'],
    butlerStock: ['105', '0', '8'], todayPerBox: ['105', '0', '9'], counts: ['7', '4'], share: ['31', '0'], adCard: ['21', '5', '6'] },
  sourceManifestSha256: SOURCE_SHA, catalogSha256: CATALOG_SHA });
let loaded;
function staticBundle() {
  if (!loaded) {
    const read = (url, expected) => {
      const bytes = fs.readFileSync(url);
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected) throw problem('ORDER_FLOWER_CATALOG_INTEGRITY', '鲜花订单静态来源指纹不一致', 500);
      return JSON.parse(bytes.toString('utf8'));
    };
    const source = read(new URL('./static/source.json', import.meta.url), SOURCE_SHA),
      tables = read(new URL('./static/catalog-480.0.27.json', import.meta.url), CATALOG_SHA);
    if (!plainObject(tables) || source.gameVersion !== '480.0.27' || source.protocolVersion !== '480.0.0' ||
      source.curatedFileSha256 !== CATALOG_SHA || source.applicationCodeExecuted !== false) throw problem('ORDER_FLOWER_CATALOG_VERSION', '鲜花订单静态版本来源不成立', 500);
    loaded = freeze({ source, tables });
  }
  return loaded;
}

const TABLES = Object.freeze(['c_open', 'c_lvl', 'c_orderFlower', 'c_orderFlowerNpc', 'c_share', 'c_butler']);
const ACTIONS = Object.freeze({ resident: 'order.resident', satin: 'order.satin', decorate: 'order.decorate' });
const BUTLER_ACTION = 'order.butler-stock';
const actionContract = action => officialActionContracts()[action];
const positive = value => Number.isSafeInteger(value) && value > 0;
const rowIdMatches = (key, row) => plainObject(row) && (key === '-1' ? row.id === -1 :
  (/^[1-9][0-9]*$/.test(key) && row.id === Number(key)) || (!/^[0-9-]+$/.test(key) && row.id === key));
function createFromLandCatalog(landCatalog, landCatalogForContext = null) {
  const identity = landCatalog?.identity?.();
  const dynamic = identity?.catalogId?.startsWith('official-public/data-snapshot/') === true &&
    typeof identity.dataSnapshotId === 'string' && typeof landCatalog?.table === 'function';
  const bundle = dynamic ? null : staticBundle();
  const tables = dynamic ? Object.fromEntries(TABLES.map(name => [name, landCatalog.table(name)]).filter(([, table]) => plainObject(table))) : bundle.tables;
  const tableHashes = dynamic ? identity.tableSha256 || {} : null;
  const actionSupported = kind => {
    if (!dynamic) return identity?.protocolVersion === '480.0.0';
    const action = ACTIONS[kind], proof = identity.sourceProofs?.[action];
    const requiredTables = actionContract(action)?.tables || [];
    return identity.protocolVersion === '480.0.0' && identity.contractId === OFFICIAL_CORE_CONTRACT_ID &&
      identity.dataSchemaContractId && proof?.supported === true && proof.actionContractId === officialActionContractId(action) &&
      proof.coreContractId === OFFICIAL_CORE_CONTRACT_ID && proof.sourceVersion === identity.indexVersion &&
      proof.protocolVersion === identity.protocolVersion && /^[a-f0-9]{64}$/.test(proof.gameSha256 || '') &&
      /^[a-f0-9]{64}$/.test(proof.moSha256 || '') && requiredTables.length > 0 &&
      requiredTables.every(name => plainObject(tables[name]) && /^[a-f0-9]{64}$/.test(tableHashes[name] || ''));
  };
  const meta = tables.c_orderFlower?.['-1'];
  const butlerMeta = tables.c_butler?.['-1'];
  const butlerSupported = () => dynamic && identity.protocolVersion === '480.0.0' && identity.contractId === OFFICIAL_CORE_CONTRACT_ID &&
    !!identity.dataSchemaContractId && plainObject(butlerMeta) && butlerMeta.id === -1 && Array.isArray(butlerMeta.$maxFlowerOrder) &&
    butlerMeta.$maxFlowerOrder.length === 3 && butlerMeta.$maxFlowerOrder.every(value => Number.isSafeInteger(value) && value > 0) &&
    (actionContract(BUTLER_ACTION)?.tables || []).every(name => plainObject(tables[name]) && /^[a-f0-9]{64}$/.test(tableHashes[name] || '')) &&
    identity.sourceProofs?.[BUTLER_ACTION]?.supported === true &&
    identity.sourceProofs[BUTLER_ACTION].actionContractId === officialActionContractId(BUTLER_ACTION) &&
    identity.sourceProofs[BUTLER_ACTION].coreContractId === OFFICIAL_CORE_CONTRACT_ID &&
    identity.sourceProofs[BUTLER_ACTION].sourceVersion === identity.indexVersion &&
    identity.sourceProofs[BUTLER_ACTION].protocolVersion === identity.protocolVersion;
  const definitions = {};
  const def = (kind, shape) => {
    if (!actionSupported(kind) || !plainObject(meta)) return;
    const limit = meta[shape.limit];
    if (!Number.isSafeInteger(limit) || limit <= 0) return;
    definitions[kind] = freeze({ kind, featureId: 'order.' + kind, boxIds: shape.boxIds, counterId: shape.counterId,
      countOffset: shape.countOffset, shareId: shape.shareId, officialDailyLimit: limit, openId: shape.openId,
      videoOpenId: shape.videoOpenId, methodHint: shape.methodHint, argsShape: shape.argsShape });
  };
  def('resident', { limit: '$dailyMax', boxIds: [1, 2, 3, 4, 5, 6], counterId: 105, countOffset: 0, shareId: 5,
    openId: 'sys_orderFlower', videoOpenId: 'share_Order', methodHint: 'orderFlower.finishOrder', argsShape: ['boxId'] });
  def('satin', { limit: '$dailyMax2', boxIds: [7], counterId: 109, countOffset: 1, shareId: 19,
    openId: 'sys_orderSatins', videoOpenId: 'share_orderSatins', methodHint: 'orderFlower.finishSatinOrder', argsShape: [] });
  def('decorate', { limit: '$dailyMax3', boxIds: [8], counterId: 116, countOffset: 1, shareId: 34,
    openId: 'sys_orderDecorate', videoOpenId: 'share_orderDecorate', methodHint: 'orderFlower.finishDecorateOrder', argsShape: [] });
  const npc = id => {
    const row = tables.c_orderFlowerNpc?.[String(id)], metaRow = tables.c_orderFlowerNpc?.['-1'];
    const listed = ['resident', 'satin', 'decorate'].some(kind => {
      const field = kind === 'resident' ? '$npcId' : kind === 'satin' ? '$satinsNpcId' : '$decorateNpcId';
      return Array.isArray(metaRow?.[field]) && metaRow[field].includes(id);
    });
    return positive(id) && rowIdMatches(String(id), row) && listed ? row : null;
  };
  const level = id => {
    const row = tables.c_lvl?.[String(id)];
    return positive(id) && rowIdMatches(String(id), row) && Number.isSafeInteger(row.orderFlower) && row.orderFlower >= 0 ? row : null;
  };
  const share = id => {
    const row = tables.c_share?.[String(id)];
    return positive(id) && rowIdMatches(String(id), row) && Number.isSafeInteger(row.limit) && row.limit > 0 &&
      row.limitType === 1 && typeof row.openId === 'string' && row.openId.length > 0 && row.openId.length <= 64 ? row : null;
  };
  const open = name => {
    const row = tables.c_open?.[name];
    return typeof name === 'string' && rowIdMatches(name, row) ? row : null;
  };
  const source = dynamic ? freeze({ catalogId: identity.catalogId, manifestSha256: identity.manifestSha256,
    gameVersion: identity.indexVersion, protocolVersion: identity.protocolVersion,
    dataSnapshotId: identity.dataSnapshotId, dataSchemaContractId: identity.dataSchemaContractId,
    loginResponseRef: identity.loginResponseRef, contractId: identity.contractId,
    tableHashes: Object.fromEntries(TABLES.map(name => [name, tableHashes[name] ?? null])),
    sourceProofs: Object.fromEntries([...Object.values(ACTIONS), BUTLER_ACTION].map(action => [action, identity.sourceProofs?.[action] ?? null])) }) : bundle.source;
  const facade = { identity: () => source, definition: kind => definitions[kind] || null,
    metadata: () => plainObject(meta) ? clone(meta) : null,
    butlerPolicy: () => butlerSupported() ? freeze({ maxFlowerOrder: [...butlerMeta.$maxFlowerOrder],
      sourceProof: identity.sourceProofs[BUTLER_ACTION], tableHashes: { c_butler: tableHashes.c_butler, c_orderFlower: tableHashes.c_orderFlower },
      dataSnapshotId: identity.dataSnapshotId, dataSchemaContractId: identity.dataSchemaContractId,
      sourceVersion: identity.indexVersion, loginResponseRef: identity.loginResponseRef }) : null,
    level: id => level(id), npc: id => npc(id), share: id => share(id), open: name => open(name),
    supports: (kind, versionEvidence = null) => !!definitions[kind] && (!dynamic || landCatalog.sourceBundleCurrent?.() !== false) && (!dynamic || (() => {
      const proof = versionEvidence?.sourceProofs?.[ACTIONS[kind]];
      return versionEvidence?.gameVersion === source.gameVersion && versionEvidence?.protocolVersion === source.protocolVersion &&
        versionEvidence?.loginResponseRef === identity.loginResponseRef && versionEvidence?.dataSnapshotId === identity.dataSnapshotId &&
        proof?.supported === true && proof.actionContractId === officialActionContractId(ACTIONS[kind]) &&
        proof.sourceVersion === source.gameVersion && proof.protocolVersion === source.protocolVersion;
    })()) && (!versionEvidence || versionEvidence.gameVersion === source.gameVersion && versionEvidence.protocolVersion === source.protocolVersion),
    readContract: () => freeze({ knownPureCurrentRefresh: false, enter: { method: 'orderFlower.enter', argsShape: [],
      registered: false, pureReadProven: false, mayPopulateOrderBoard: true },
    afterWriteCandidate: { kind: 'after-physical-close-fresh-login', registered: false, currentComplete105CoverageProven: false,
      requiresActualProvidedCompleteOrderProperty: true, requiresCounterAndAbsoluteInventory: true, responseAloneConfirmsNothing: true } }) };
  if (typeof landCatalogForContext === 'function') facade.forContext = context => {
    const current = landCatalogForContext(context);
    if (!current) return null;
    const currentIdentity = current.identity?.();
    if (currentIdentity?.dataSnapshotId === identity?.dataSnapshotId && currentIdentity?.manifestSha256 === identity?.manifestSha256 &&
      currentIdentity?.loginResponseRef === identity?.loginResponseRef && currentIdentity?.indexVersion === identity?.indexVersion &&
      currentIdentity?.protocolVersion === identity?.protocolVersion && currentIdentity?.bundleRef === identity?.bundleRef) return facade;
    try { return createFromLandCatalog(current, landCatalogForContext); } catch { return null; }
  };
  return Object.freeze(facade);
}

export function createOfficialOrderFlowerCatalog({ landCatalog = null, landCatalogForContext = null } = {}) {
  const initial = landCatalog || { identity: () => ORDER_FLOWER_SOURCE };
  return createFromLandCatalog(initial, landCatalogForContext);
}
