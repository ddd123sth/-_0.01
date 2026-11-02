import { freeze, plainObject, problem, fingerprint } from './common.mjs';

// This is the client implementation contract, not a game-version allowlist.
// Its source ranges and data snapshot are stored separately so harmless table
// changes cannot silently change protocol identity.
const CORE_RANGES = freeze([
  ['ISyncData', 64556, 67818, '8d4c5a6d88ab4deedf91e18551ebe135deae218a6140220ff3813e3cb1258abb'],
  ['IUsr', 29563, 30615, 'ef40e4f15387be812b6599fbab3fd47cd39c3b87000b3f7b10ffa8c7003a2012'],
  ['IUsrTot', 49648, 50215, 'f73dc2b06d3edc0a445647f6c49c0304ed022dd00f4950372dba9fe9a197cced'],
  ['ITaskTot', 50216, 50378, '08a8bd442056a6b3e44baf6929b8edcfbba73ef7d511719b051a63b9bbb1e3b5'],
  ['ITaskMain', 34307, 34461, '909697688d6d2f94b5c926f8f0ef85832d36103448e8e0010e0645ee13bd0cce'],
  ['ICultivateTot', 115969, 116089, '728a33b8316949a4c0e8b2008fd8591e77cde2e0e9b6160471fd6985c9a56c62'],
  ['IShareTot', 59251, 59316, 'b1f95cd89ff62bf7305235836915b29ec193844564817a29f1165d334c10418e'],
  ['IUsrCount', 30974, 31082, 'ade6c575683d0c131a28b2f7d69605c2bfe7daf8640275b4564229b1e829497a'],
  ['IItemExt', 46933, 47015, '5bc8967755336118b4b6c8c2ea914926195c0261c25426e12c63dc2d7128e589'],
  ['IButlerTot', 133602, 133746, 'e38a19bd54f090ea65a667905e51130f8fc082449f53ae0c8089954ff177b92d'],
  ['IRchgTot', 48580, 48812, '6ab5e05b356076035ddccf50aae77c1b36081db83d02ccb85665a2a2b9267057'],
  ['IOrderFlower', 95715, 96024, '9e5d189a38d30f362afeff46b46d466ca0c026da85393b6c8b526c911a2a48d0'],
  ['IFlowerOrder', 116384, 116521, '422a0c9ea6a3d627e91a17a0c87cf1d758f6af978a9e0b0badf6aeef5db5b732'],
  ['IOrderStock', 116522, 116607, 'bee06991301896376cfe19e6bceba066f4bd99c1c68e601571e2f7c7369581a8'],
  ['IOrderFlowerTot', 116608, 116675, '59df661d10ad65e50f81701fa13c261a40c5a6075d12d4bdccff30382343ee75'],
  ['OrderFlowerCtrl', 409544, 410271, '6874c407a3e3b73c26f724a42fff04dd1a032a89c10b2d02de97cd6aa81743ee'],
]);

const ACTION_CONTRACTS = freeze({
  'session.official-day': { sourceEvidence: ['current-day-and-timezone-source', 'official-anchor-clock'],
    requiredCoreRanges: ['ISyncData', 'IUsr'], verifiedSourceRanges: [
      ['day-new-date', 183130, 183156, 'a3f4ca621bc7dcd1ef002fd0409093f83e773d90840131e6c3352bd49bf89407'],
      ['day-other', 47102, 47252, '926f8e2ecccfd71d9b38e011ffc92221a55cc836941a6e71dd59459056f1400f'],
      ['day-refresh-boundary', 195456, 195724, 'e444bf600ffc597e1c4b3ac8498fc216619b5f241a83fa3b21624fc3068155d2'],
      ['day-refresh-default', 196148, 196441, '21bed5e8b112f54179ab50a715550bd6309af518367729af41449648d3add61e'],
      ['day-helper-sync', 240426, 241128, 'e660bc7f1b4ac29f83d6837ba617312a3fe96b163e91fe88202bbb83fc28e2b4'],
      ['day-mo-formatter', 160649, 160991, 'd1a3fa92e134a159e95fd8593d2be2ef1d9d1e9fe6858795457909c80924e2d7'],
      ['day-mo-anchor', 171855, 172388, '74ff74ab7169dcf6f0fa781589840c19d0070997b69d5550101b5a94d93fc1f9'],
      ['day-mo-set-timezone', 173104, 173223, '99be1a955cbfcd3e7ba116e29d11be9503f155c9a59a8f8c5a384d27940608d3'],
    ], request: null, tables: [] },
  'land.plant': { sourceEvidence: ['IUsrLand', 'IUsrLandTot', 'ILand', 'ICultivate', 'ICultivateTot', 'plant-args', 'plant-dispatch'],
    requiredCoreRanges: ['ISyncData', 'IUsr'],
    verifiedSourceRanges: [
      ['IUsrLand', 115322, 115450, 'a124450b508c056d0e3e463810d73337ea469ad715cf76a5b7b1b883ba807215'],
      ['IUsrLandTot', 115833, 115968, 'cbbbad1e28f3e1d86a61f7a1263eafee1cf34060295486b3047313f2a441bb58'],
      ['ILand', 115622, 115773, 'f46b86b033a120cba2afb5a844a13f6178cfdbc0cce1d5239de3bd4b7a9bcae9'],
      ['ICultivate', 95079, 95307, '71452dc17a8c99cb9e498c580fce393154604612252c862d15ec72f466afbc02'], ['ICultivateTot', 115969, 116089, '728a33b8316949a4c0e8b2008fd8591e77cde2e0e9b6160471fd6985c9a56c62'],
      ['plant-args', 180032, 180101, 'b84b66477f4bb025939639f7a03769417d50787f74f4ee68bb9d90b56ce45d2d'], ['plant-dispatch', 402402, 402481, 'afd80d0f8ee3597fb6a5804edddc14046c7978875a268df1ef284c02761e9137']],
    request: { method: 'gs.usrLand.plant', args: ['landId', 'flowerId'] }, tables: ['c_item', 'c_farmLand', 'c_flower', 'c_flowerLvl', 'c_flowerLvlCfg'] },
  'land.water': { sourceEvidence: ['IUsrLand', 'IUsrLandTot', 'ILand', 'ICultivate', 'ICultivateTot', 'water-args', 'water-dispatch', 'water-rule'],
    requiredCoreRanges: ['ISyncData', 'IUsr'],
    verifiedSourceRanges: [
      ['ILand', 115622, 115773, 'f46b86b033a120cba2afb5a844a13f6178cfdbc0cce1d5239de3bd4b7a9bcae9'],
      ['water-args', 180169, 180227, '6ab0cc440530f049b725c245508ef66d0fb8c6e74ed5ca8f6e892b8fb8138114'], ['water-dispatch', 402557, 402623, '2862f02142847c7d994ffb60cec1f1a65f0fd3f8e62b53f70be7e58575a7090a'],
      ['water-rule', 184205, 186098, '80c9c8d04c3e41303327f1192c9078738b92144fa9c136f18f2823d171bdf50b']],
    request: { method: 'gs.usrLand.water', args: ['landId'] }, tables: ['c_item'] },
  'land.harvest': { sourceEvidence: ['IUsrLand', 'IUsrLandTot', 'ILand', 'ICultivate', 'ICultivateTot', 'harvest-args', 'harvest-dispatch'],
    requiredCoreRanges: ['ISyncData', 'IUsr'],
    verifiedSourceRanges: [
      ['ILand', 115622, 115773, 'f46b86b033a120cba2afb5a844a13f6178cfdbc0cce1d5239de3bd4b7a9bcae9'],
      ['harvest-args', 180285, 180345, '510c42f772e975abd33e43008e62c7b3adb0488ccc62c180fb3794d476d4966d'], ['harvest-dispatch', 402747, 402817, 'e857be0e0339bcbe7468d62c0191a20deea4ab12c18c84e3b3824f07549ff668']],
    request: { method: 'gs.usrLand.harvest', args: ['landId'] }, tables: ['c_item', 'c_farmLand', 'c_flower'] },
  'customer.generate': { sourceEvidence: ['IOrderCustomer', 'ICustomerOrder', 'IOrderCustomerTot', 'customer-gen-dispatch'],
    requiredCoreRanges: ['ISyncData', 'IUsr'],
    verifiedSourceRanges: [
      ['customer-controller', 411934, 412554, '8f49fbaeb9c5b28f03b347e295fb1078e47102bed7bc6669944d577b57ffc78d'],
      ['argument-schemas', 172048, 172298, '1f5a8d626ad2319f62b3ed954298d0a61f89545cd391db05b2c2dd34aa63f079'],
      ['customer-order-ds', 117630, 117717, '2ab9f6c4248530fd3a80257389abd28ac984e8fe6b4f501c28da887b1800befb'],
      ['customer-board-ds', 96567, 96776, '95ca29680b61a7c5e146641dbe81d61072898cde883b81ba346a4d72cff44c8c'],
      ['npc-generation', 2363210, 2364567, '5cae729320bf656b9daec0a460b24d972afb1359ca0c242942da4a6b02c9cdad'],
      ['npc-visitor-construction', 2364942, 2366709, '7565509013f51884ace57ff6748b62e00d17d30bc4d53f0fe5a4a7f9f503d212'],
      ['customer-continuation', 2375992, 2376613, '9675d706f19ca0067f9bd1cff593a412de7d16d02fac32da3c5e30aeef0608dd'],
    ], request: { method: 'gs.orderCustomer.genOrder', args: ['guestNpcIdList'] }, tables: ['c_item', 'c_flowerArt', 'c_orderCustomerNpc', 'c_open'] },
  'customer.finish': { sourceEvidence: ['IOrderCustomer', 'ICustomerOrder', 'IOrderCustomerTot', 'customer-finish-dispatch'],
    requiredCoreRanges: ['ISyncData', 'IUsr'],
    verifiedSourceRanges: [
      ['customer-controller', 411934, 412554, '8f49fbaeb9c5b28f03b347e295fb1078e47102bed7bc6669944d577b57ffc78d'],
      ['argument-schemas', 172048, 172298, '1f5a8d626ad2319f62b3ed954298d0a61f89545cd391db05b2c2dd34aa63f079'],
      ['customer-order-ds', 117630, 117717, '2ab9f6c4248530fd3a80257389abd28ac984e8fe6b4f501c28da887b1800befb'],
      ['customer-board-ds', 96567, 96776, '95ca29680b61a7c5e146641dbe81d61072898cde883b81ba346a4d72cff44c8c'],
      ['customer-reward', 443147, 443841, 'ee10cdec8238c6d365cd91719128d0ebfab3445bc4d07d61c4a9cfc39783c43f'],
      ['customer-stock-ui', 2372130, 2372753, '5711cd55fe311350fe43e05b6532a8200cfc2961d1174b07f7e755e4a2d196c8'],
      ['customer-finish', 2374872, 2375326, '6275ab6415c50f17cfc4e659ed1d874b5c52e2f353096878d2a68ed0cce3c7df'],
      ['customer-continuation', 2375992, 2376613, '9675d706f19ca0067f9bd1cff593a412de7d16d02fac32da3c5e30aeef0608dd'],
    ], request: { method: 'gs.orderCustomer.finishOrder', args: ['npcId', 'guestNpcIdList'] }, tables: ['c_item', 'c_flowerArt', 'c_open'] },
  'customer.reject': { sourceEvidence: ['IOrderCustomer', 'ICustomerOrder', 'IOrderCustomerTot', 'customer-reject-dispatch'],
    requiredCoreRanges: ['ISyncData', 'IUsr'],
    verifiedSourceRanges: [
      ['customer-controller', 411934, 412554, '8f49fbaeb9c5b28f03b347e295fb1078e47102bed7bc6669944d577b57ffc78d'],
      ['argument-schemas', 172048, 172298, '1f5a8d626ad2319f62b3ed954298d0a61f89545cd391db05b2c2dd34aa63f079'],
      ['customer-order-ds', 117630, 117717, '2ab9f6c4248530fd3a80257389abd28ac984e8fe6b4f501c28da887b1800befb'],
      ['customer-board-ds', 96567, 96776, '95ca29680b61a7c5e146641dbe81d61072898cde883b81ba346a4d72cff44c8c'],
      ['customer-stock-ui', 2372130, 2372753, '5711cd55fe311350fe43e05b6532a8200cfc2961d1174b07f7e755e4a2d196c8'],
      ['customer-reject', 2373810, 2374119, '6da9ba7b29c56da1e9cf5c506b496ad777ad81789bd7c64c02f6c81ffd127428'],
      ['customer-continuation', 2375992, 2376613, '9675d706f19ca0067f9bd1cff593a412de7d16d02fac32da3c5e30aeef0608dd'],
    ], request: { method: 'gs.orderCustomer.rejectOrder', args: ['npcId', 'guestNpcIdList'] }, tables: ['c_open'] },
  'art.make': { sourceEvidence: ['IFlowerArt', 'make-art-dispatch'],
    requiredCoreRanges: ['ISyncData', 'IUsr'],
    verifiedSourceRanges: [
      ['makeCall', 443841, 443944, 'cad7feb8757e4f4803dbacefb6715e0fdd51cedd620f2c125d9bce152186e7e4'],
      ['makeArguments', 161704, 161792, '1191ac8d8865646d62a84dae8bdd245afbbd145afd48168a6112fedf6f1fc1b1'],
      ['artMember', 95616, 95715, '029b7e30c89301a6fae6767b6d7bc2a0029b9a622b0b0eb4f0f2cd26446d1100'],
      ['artDomain', 116322, 116384, '45c3de017aa518d0ff631e1b30319851d5db0a28ef4265988e5b894ff3f7539e'],
      ['vaseMember', 95427, 95501, '19254773ec09cf5831fab1ea2e056e98a108d1a9088f8ec4052cb263e06f86f0'],
      ['vaseDomain', 116090, 116158, '2499295ffef35b1e85ecf6120ee45d50f363ac48ebdaeab0b3c0cc01432079a9'],
      ['vaseManager', 403846, 404094, '734db7266bb54730e9896c5004c8f9212bc16e2103af6ada99c6ece5bdc16a1c'],
      ['ordinaryMake', 1526512, 1527879, 'c8f87bcec7eb5e64d4c957ff3811a36c6ecb694ac9006238c363d2b0910b7ae7'],
      ['maxMakeQuantity', 1523154, 1523412, 'e7445ea48e6360306e3db6c02a059164efa322f46c9c96ba96ca0bcd078003a2'],
      ['getItemNum', 281846, 281954, '723a01cd21f31fb57befd1b29eb6a9dfb3e476707cbbf72346cd87c6a7f5aa7b'],
      ['itemEffectiveQuantity', 184205, 186098, '80c9c8d04c3e41303327f1192c9078738b92144fa9c136f18f2823d171bdf50b'],
      ['itemFlows', 47252, 47494, 'e3b46138b3672a4879ee0228b1106716926178f8b67e6ddff75af79d154c01d1'],
      ['absoluteBagPatch', 276874, 277948, 'e35083f0abbc5203b9c2935a268bdeffa72c743de7c29debf12e401edc765771'],
    ],
    request: { method: 'gs.flowerArt.makeFlowerArt', args: ['vaseId', 'flowersIds', 'num'] }, tables: ['c_item', 'c_flower', 'c_flowerArt'] },
  'order.resident': { sourceEvidence: ['OrderFlowerCtrl', 'resident-order-ds', 'IOrderFlower', 'IFlowerOrder', 'IOrderStock', 'normal-order-client-branch'],
    requiredCoreRanges: ['ISyncData', 'IUsr'], verifiedSourceRanges: [
      ['OrderFlowerCtrl', 409500, 410300, 'e95eabd0ed64c900f6b6b847780f58848b5a1a8a3f14184f4543deae71b122f0'],
      ['order-args', 172300, 172735, '8d5d32eb7aca0348b814307ef39aa97a2c2a781c1676e6521957f91c6c36830f'],
      ['IOrderFlower', 95715, 96025, '4857f4c56796defb96f2e3c3f565dc58a51031a5918e43fa0e2d73b74160db1c'],
      ['IFlowerOrder-IOrderStock', 116384, 116608, 'bda2e7204a062d28695e61a51bcdcf7d60b778cd9a005568cb2472e9f9e687f9'],
      ['today-order-count', 717940, 718075, '993401e2dc4d58c422d92866e639f5dd9db9b0ddbb8a6cf82ca1ba7a599c16f4'],
      ['getTdyCount-day', 280100, 280475, '933d349477e43ed45b9249c2aef005b27d58d559bdf75ee62f955d55ed1c1511'],
      ['ordinary-order-client', 2334900, 2336080, '9559f9ce69d295c32e9b04a77327953f0b6945f6283197a58619337d3fed60f7'],
    ], request: { method: 'gs.orderFlower.finishOrder', args: ['boxId'] }, tables: ['c_open', 'c_lvl', 'c_orderFlower', 'c_orderFlowerNpc', 'c_share'] },
  'order.satin': { sourceEvidence: ['OrderFlowerCtrl', 'satin-order-ds', 'ISatinOrder', 'IFlowerOrder', 'IOrderStock', 'normal-order-client-branch'],
    requiredCoreRanges: ['ISyncData', 'IUsr'], verifiedSourceRanges: [
      ['OrderFlowerCtrl', 409500, 410300, 'e95eabd0ed64c900f6b6b847780f58848b5a1a8a3f14184f4543deae71b122f0'],
      ['order-args', 172300, 172735, '8d5d32eb7aca0348b814307ef39aa97a2c2a781c1676e6521957f91c6c36830f'],
      ['IFlowerOrder-IOrderStock', 116384, 116608, 'bda2e7204a062d28695e61a51bcdcf7d60b778cd9a005568cb2472e9f9e687f9'],
      ['ISatinOrder', 123067, 123205, 'ce66ea7e1d95229cb0402874257265fbd8d9947e587ef2116626e93d8b1137c9'],
      ['today-order-count', 717940, 718075, '993401e2dc4d58c422d92866e639f5dd9db9b0ddbb8a6cf82ca1ba7a599c16f4'],
      ['getTdyCount-day', 280100, 280475, '933d349477e43ed45b9249c2aef005b27d58d559bdf75ee62f955d55ed1c1511'],
      ['ordinary-order-client', 2334900, 2336080, '9559f9ce69d295c32e9b04a77327953f0b6945f6283197a58619337d3fed60f7'],
    ], request: { method: 'gs.orderFlower.finishSatinOrder', args: [] }, tables: ['c_open', 'c_orderFlower', 'c_orderFlowerNpc', 'c_share'] },
  'order.decorate': { sourceEvidence: ['OrderFlowerCtrl', 'decorate-order-ds', 'ICommonOrder', 'IFlowerOrder', 'IOrderStock', 'normal-order-client-branch'],
    requiredCoreRanges: ['ISyncData', 'IUsr'], verifiedSourceRanges: [
      ['OrderFlowerCtrl', 409500, 410300, 'e95eabd0ed64c900f6b6b847780f58848b5a1a8a3f14184f4543deae71b122f0'],
      ['order-args', 172300, 172735, '8d5d32eb7aca0348b814307ef39aa97a2c2a781c1676e6521957f91c6c36830f'],
      ['IFlowerOrder-IOrderStock', 116384, 116608, 'bda2e7204a062d28695e61a51bcdcf7d60b778cd9a005568cb2472e9f9e687f9'],
      ['ICommonOrder', 126294, 126433, '3d285322a7b81afdf26fcc3ce6240ab7f51d732b053e2bdb4feb6725d54484e7'],
      ['today-order-count', 717940, 718075, '993401e2dc4d58c422d92866e639f5dd9db9b0ddbb8a6cf82ca1ba7a599c16f4'],
      ['getTdyCount-day', 280100, 280475, '933d349477e43ed45b9249c2aef005b27d58d559bdf75ee62f955d55ed1c1511'],
      ['ordinary-order-client', 2334900, 2336080, '9559f9ce69d295c32e9b04a77327953f0b6945f6283197a58619337d3fed60f7'],
    ], request: { method: 'gs.orderFlower.finishDecorateOrder', args: [] }, tables: ['c_open', 'c_orderFlower', 'c_orderFlowerNpc', 'c_share'] },
  'order.butler-stock': { sourceEvidence: ['butler-shared-stock-rules', 'butler-client-stock-accounting', 'butler-actual-hire',
      'butler-setting-ds', 'butler-ordinary-flower-requirement', 'butler-stored-cooldown-only'],
    requiredCoreRanges: ['ISyncData', 'IUsr'], verifiedSourceRanges: [
      ['butler-shared-stock-rules', 394300, 398000, '4ad8469cd494fb886dba12e619b81db236335c0a96d32dc53c4b0a34a7af000f'],
      ['butler-client-stock-accounting', 2482380, 2486800, 'f808138dc852d74da16941b19e145c0720fc549d5169db838ca168136f2ff7c1'],
      ['butler-actual-hire', 1341920, 1342320, '1138936d50cf0d975e088b8c50d26c2f20d87f70eb0d363cf6a59f886ed99f5a'],
      ['butler-setting-ds', 110692, 110928, 'c8f9a2117b1a1a4268998de330cfdcb2c88fae1860ece5145e3687fa422f1759'],
      ['butler-ordinary-flower-requirement', 2335300, 2336080, '3613fe684a09c122bb57fc53fe2e56c745b2d2635741556551bf9c51a638eb23'],
      ['butler-stored-cooldown-only', 2330200, 2332350, '72559abf18b83dcb97703c8c18cfc0bdb674df2cd882198b4cc07a60dabf7aae'],
    ], request: null, tables: ['c_butler', 'c_orderFlower'] },
  'order-flower.normal': { sourceEvidence: ['IOrderFlower', 'IFlowerOrder', 'IOrderStock', 'IOrderFlowerTot', 'OrderFlowerCtrl'],
    request: { method: 'gs.orderFlower.finishOrder', args: 'feature-specific-approved-contract' },
    tables: ['c_open', 'c_lvl', 'c_orderFlower', 'c_orderFlowerNpc', 'c_orderCustomerNpc', 'c_orderCustomerNpcPath', 'c_share'] },
});
const ACTION_CONTRACT_IDS = freeze(Object.fromEntries(Object.entries(ACTION_CONTRACTS).map(([id, contract]) => [id, 'sha256:' + fingerprint(contract)])));

export const OFFICIAL_CORE_CONTRACT_ID = 'sha256:' + fingerprint(CORE_RANGES.map(([name, start, end, sha256]) => ({ name, start, end, sha256 })));
export const OFFICIAL_CORE_CONTRACT = freeze({
  contractSchema: 'official-runtime-contract/v1', contractId: OFFICIAL_CORE_CONTRACT_ID, protocolVersion: '480.0.0',
  rangeEncoding: 'decoded JavaScript UTF-8 bytes, zero-based half-open ranges',
  // These shared declarations are evidence inputs, not an action grant. Each
  // action must match its own consumed fields, RPC shape, data rules and
  // source snapshot before it can be enabled.
  supportedActions: [],
  sourceRanges: CORE_RANGES.map(([name, start, end, sha256]) => ({ name, start, end, sha256 })),
});

const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const pos = value => Number.isSafeInteger(value) && value > 0;

export function resolveOfficialContract(versionEvidence) {
  if (!plainObject(versionEvidence) || versionEvidence.source !== 'normal-package-hop-and-matched-world-login/v1' ||
      versionEvidence.protocolVersion !== OFFICIAL_CORE_CONTRACT.protocolVersion || !text(versionEvidence.loginResponseRef)) return null;
  return OFFICIAL_CORE_CONTRACT;
}

export function bindOfficialContract(versionEvidence, identity) {
  const profile = resolveOfficialContract(versionEvidence);
  if (!profile || !plainObject(identity) || !text(identity.ownerRef) || !text(identity.subjectRef) ||
      !(text(identity.accountRef) || pos(identity.accountRef)) || !pos(identity.ownerEpoch) || !pos(identity.runEpoch) ||
      !pos(identity.connectionEpoch) || !pos(identity.officialUid) || versionEvidence.loginResponseRef !== identity.loginResponseRef ||
      !/^(?:sha256:)?[a-f0-9]{64}$/.test(identity.dataSnapshotId || '')) return null;
  const binding = freeze({ bindingVersion: 'official-contract-binding/v1', contractId: profile.contractId,
    contractFingerprint: fingerprint(profile.sourceRanges), dataSnapshotId: identity.dataSnapshotId,
    ownerRef: identity.ownerRef, accountRef: String(identity.accountRef), subjectRef: identity.subjectRef,
    officialUid: identity.officialUid, ownerEpoch: identity.ownerEpoch, runEpoch: identity.runEpoch,
    connectionEpoch: identity.connectionEpoch, loginResponseRef: identity.loginResponseRef });
  return freeze({ profile, binding });
}

export function contractBindingMatches(evidence, identity) {
  const binding = evidence?.profileBinding;
  return !!resolveOfficialContract(evidence) && plainObject(binding) &&
    binding.bindingVersion === 'official-contract-binding/v1' && binding.contractId === OFFICIAL_CORE_CONTRACT_ID &&
    /^(?:sha256:)?[a-f0-9]{64}$/.test(binding.dataSnapshotId || '') && binding.ownerRef === identity?.ownerRef &&
    binding.accountRef === String(identity?.accountRef) && (text(identity?.accountRef) || pos(identity?.accountRef)) && binding.subjectRef === identity?.subjectRef &&
    binding.officialUid === identity?.officialUid && binding.ownerEpoch === identity?.ownerEpoch &&
    binding.runEpoch === identity?.runEpoch && binding.connectionEpoch === identity?.connectionEpoch &&
    binding.loginResponseRef === evidence.loginResponseRef;
}

export function officialContractCapability(versionEvidence, capability, { sourceProof = null } = {}) {
  const profile = resolveOfficialContract(versionEvidence);
  const contract = ACTION_CONTRACTS[capability];
  // Source ranges are expected content, not permission by themselves. The
  // current public game/mo bytes must locate and match every block at runtime.
  // Customer/art/order entries remain inventory until their own blocks exist.
  const supported = !!profile && (capability.startsWith('land.') || capability.startsWith('customer.') || capability.startsWith('order.') || capability.startsWith('session.')) && !!contract?.verifiedSourceRanges &&
    contract.verifiedSourceRanges.every(([, start, end, sha]) => Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
      end > start && /^[a-f0-9]{64}$/.test(sha)) && sourceProof?.supported === true &&
    sourceProof.actionContractId === ACTION_CONTRACT_IDS[capability] && sourceProof.coreContractId === profile.contractId &&
    sourceProof.sourceVersion === versionEvidence.gameVersion && sourceProof.protocolVersion === versionEvidence.protocolVersion &&
    /^[a-f0-9]{64}$/.test(sourceProof.gameSha256 || '') && /^[a-f0-9]{64}$/.test(sourceProof.moSha256 || '');
  return freeze({ supported, profileId: profile?.contractId ?? null, actionContractId: ACTION_CONTRACT_IDS[capability] ?? null,
    request: contract?.request ?? null, requiredTables: contract?.tables ?? [],
    reasonCode: supported ? null : 'OFFICIAL_ACTION_CONTRACT_UNSUPPORTED', artifactRefs: contract?.sourceEvidence ?? [],
    verifiedSourceRanges: supported ? contract.verifiedSourceRanges : [] });
}

export const officialContracts = () => freeze({ [OFFICIAL_CORE_CONTRACT_ID]: OFFICIAL_CORE_CONTRACT });
export const officialActionContracts = () => ACTION_CONTRACTS;
export const officialActionContractId = capability => ACTION_CONTRACT_IDS[capability] ?? null;
