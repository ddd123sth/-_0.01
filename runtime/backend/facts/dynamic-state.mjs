import { canonical, fingerprint, newId, parseStored, plainObject, problem } from '../common.mjs';
import { isLandAccelerationMethod, isNormalSyncMethod } from './normal-sync-contract.mjs';
import { postWriteCoverage } from './typed-coverage.mjs';
import { landWriteTarget } from '../features/land/projection.mjs';
import { REWARD_CARDS } from '../features/rewards/catalog.mjs';
import { landWriteWorksetValid } from '../features/land/write-workset.mjs';
import { resolveAcceptedLandObservationEvidence } from '../features/land/compatibility-evidence.mjs';
import { LAND_METHODS } from '../features/land/rpc-contract.mjs';
import { currentOfficialSourceEvidence } from '../official-data-evidence.mjs';
import { contractBindingMatches, OFFICIAL_CORE_CONTRACT } from '../official-version-profile.mjs';
import { hashLedgerBytes, ledgerJsonFingerprint } from '../persistence/json-contract.mjs';
import { SPECIAL_ORDER_DEFINITIONS } from '../features/special-orders/rpc-contract.mjs';

export const DYNAMIC_DOMAIN_MANIFEST = Object.freeze({
  'special-order-palace': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: ['special-order-palace.uid'] }),
  'special-order-team': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: ['special-order-team.uid'] }),
  'land': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'land-top': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'waterwheel': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: ['waterwheel.fields.count', 'waterwheel.fields.advList'] }),
    'waterwheel-share': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: ['waterwheel-share.share9.shareCnt', 'waterwheel-share.share9.uTime'] }),
  'waterwheel-item': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: ['waterwheel-item.item7.balance'] }),
  'free-water': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: ['free-water.fields.recvIdx'] }),
  'free-water-share': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'free-water-item': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: ['free-water-item.item7.balance'] }),
  'flower-rack': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: ['flower-rack.fields.rackMap'] }),
  'inventory': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'profile': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'customer': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'customer-eligibility': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'customer-day': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'order-flower': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'order-flower-counter': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'order-flower-eligibility': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'order-flower-video': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'order-flower-video-resident': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'order-flower-video-satin': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'order-flower-video-decorate': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'order-flower-card-video': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'order-flower-card-noble': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'order-flower-butler': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'order-flower-reward-state': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'order-flower-reward-stage': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'order-flower-reward-achievement': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'order-flower-enter-state': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'order-flower-card': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'order-auxiliary': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'art-inputs': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'art-album': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: ['art-album.flowerArt.domain', 'art-album.flowerArt.uid',
    'art-album.flowerArt.makeList', 'art-album.collectRwd.domain', 'art-album.collectRwd.map', 'art-album.collectRwd.exp',
    'art-album.collectRwd.artCreateRwdList'] }),
  'art-share': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: ['art-share.flowerArt.domain', 'art-share.flowerArt.uid',
    'art-share.flowerArt.makeList', 'art-share.flowerArt.sRecvList'] }),
  'clock': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'tasks': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'counters': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'cultivation': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'reward-mail': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'reward-box': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'reward-tasks': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'reward-story': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'reward-guild': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'reward-cultivate': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'reward-shop': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'reward-giftbag': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'reward-double': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
  'reward-share': Object.freeze({ maxAgeMs: 120000, dynamic: true, requiredPaths: [] }),
});

export const FEATURE_DOMAINS = Object.freeze({
  'order.palace': Object.freeze(['special-order-palace','inventory','profile','clock','customer-eligibility','customer-day']),
  'order.team': Object.freeze(['special-order-team','inventory','profile','clock','customer-eligibility','customer-day']),
  plant: Object.freeze(['land', 'land-top', 'cultivation', 'inventory']),
  water: Object.freeze(['land', 'inventory', 'clock', 'profile']),
  waterwheel: Object.freeze(['waterwheel', 'waterwheel-share', 'waterwheel-item', 'inventory', 'customer-day', 'clock', 'customer-eligibility', 'profile']),
  'free-water': Object.freeze(['free-water', 'free-water-share', 'free-water-item', 'customer-day', 'customer-eligibility', 'profile', 'clock']),
  'flower-rack': Object.freeze(['flower-rack', 'inventory', 'art-inputs', 'profile', 'clock', 'customer', 'customer-eligibility',
    'order-flower', 'order-flower-counter', 'order-flower-eligibility', 'order-flower-butler']),
  'art.daily': Object.freeze(['art-inputs', 'inventory', 'profile', 'clock', 'customer', 'customer-eligibility',
    'order-flower', 'order-flower-counter', 'order-flower-eligibility', 'order-flower-butler']),
  harvest: Object.freeze(['land', 'inventory', 'clock']),
  'land.acceleration': Object.freeze(['land', 'inventory', 'clock']),
  'order.customer': Object.freeze(['customer', 'customer-eligibility', 'profile', 'customer-day', 'inventory', 'clock']),
  'art.make': Object.freeze(['art-inputs', 'inventory', 'customer', 'customer-eligibility', 'profile', 'clock']),
  'art.customer-batch': Object.freeze(['art-inputs', 'inventory', 'customer', 'customer-eligibility', 'profile', 'clock']),
  'art.first-album': Object.freeze(['art-album', 'inventory', 'profile', 'clock']),
  'art.first-share': Object.freeze(['art-share', 'inventory', 'profile', 'clock', 'customer-eligibility']),
  'order.resident': Object.freeze(['order-flower', 'order-flower-counter', 'order-flower-eligibility', 'order-flower-butler', 'order-flower-video-resident', 'order-flower-video-satin', 'order-flower-video-decorate', 'order-flower-card-video', 'order-flower-card-noble', 'order-flower-reward-stage', 'order-flower-reward-achievement', 'order-flower-enter-state', 'inventory', 'customer-day', 'clock', 'profile']),
  'order.satin': Object.freeze(['order-flower', 'order-flower-counter', 'order-flower-eligibility', 'order-flower-butler', 'order-flower-video-resident', 'order-flower-video-satin', 'order-flower-video-decorate', 'order-flower-card-video', 'order-flower-card-noble', 'order-flower-reward-stage', 'order-flower-reward-achievement', 'order-flower-enter-state', 'inventory', 'customer-day', 'clock', 'profile']),
  'order.decorate': Object.freeze(['order-flower', 'order-flower-counter', 'order-flower-eligibility', 'order-flower-butler', 'order-flower-video-resident', 'order-flower-video-satin', 'order-flower-video-decorate', 'order-flower-card-video', 'order-flower-card-noble', 'order-flower-reward-stage', 'order-flower-reward-achievement', 'order-flower-enter-state', 'inventory', 'customer-day', 'clock', 'profile']),
  'reward.mail': Object.freeze(['reward-mail', 'inventory', 'profile', 'tasks', 'counters']),
  'reward.benefit-box': Object.freeze(['reward-box', 'inventory', 'profile', 'tasks', 'counters']),
  'reward.daily-task': Object.freeze(['reward-tasks', 'inventory', 'profile', 'tasks', 'counters']),
  'reward.daily-box': Object.freeze(['reward-tasks', 'inventory', 'profile', 'tasks', 'counters']),
  'reward.weekly-task': Object.freeze(['reward-tasks', 'inventory', 'profile', 'tasks', 'counters']),
  'reward.free-gift': Object.freeze(['reward-giftbag', 'reward-share', 'inventory', 'profile', 'clock', 'tasks', 'counters']),
  'reward.double-coin': Object.freeze(['reward-double', 'reward-share', 'inventory', 'profile', 'clock', 'tasks', 'counters']),
  'reward.main-task': Object.freeze(['reward-tasks', 'inventory', 'profile', 'clock', 'tasks', 'counters']),
  'reward.main-story': Object.freeze(['reward-story', 'inventory', 'profile', 'clock', 'tasks', 'counters']),
  'guild.build.video': Object.freeze(['reward-guild', 'reward-share', 'inventory', 'profile', 'clock', 'tasks', 'counters']),
  'guild.build.gold': Object.freeze(['reward-guild', 'inventory', 'profile', 'clock', 'tasks', 'counters']),
  'guild.build.yuanbao': Object.freeze(['reward-guild', 'inventory', 'profile', 'clock', 'tasks', 'counters']),
  'guild.land': Object.freeze(['reward-guild', 'reward-cultivate', 'cultivation', 'inventory', 'profile', 'clock', 'tasks', 'counters']),
  'cultivate.upgrade': Object.freeze(['reward-cultivate', 'cultivation', 'inventory', 'profile', 'clock', 'tasks', 'counters']),
  'cultivate.shop': Object.freeze(['reward-shop', 'inventory', 'profile', 'clock', 'cultivation', 'tasks', 'counters']),
});

export function dynamicTokenMatches(current, proposed) {
  return current?.current === true && Array.isArray(current.domains) && Array.isArray(proposed?.domains) &&
    fingerprint(current.domains) === fingerprint(proposed.domains);
}

const METHOD_DOMAINS = Object.freeze({
  ...Object.fromEntries(Object.values(SPECIAL_ORDER_DEFINITIONS).map(one => [one.method, ['special-order-' + one.kind,'inventory','profile','tasks','counters']])),
  'usrLand.plant': ['land', 'land-top', 'inventory', 'profile', 'tasks', 'counters', 'cultivation'],
  'usrLand.plantBatch': ['land', 'land-top', 'inventory', 'profile', 'tasks', 'counters', 'cultivation'],
  'usrLand.water': ['land', 'land-top', 'inventory', 'profile', 'tasks', 'counters', 'cultivation'],
  'usrLand.waterBatch': ['land', 'land-top', 'inventory', 'profile', 'tasks', 'counters', 'cultivation'],
  'usrLand.harvest': ['land', 'land-top', 'inventory', 'profile', 'tasks', 'counters', 'cultivation'],
  'usrLand.speedUp': ['land', 'land-top', 'inventory', 'profile', 'tasks', 'counters', 'cultivation'],
  'usrLand.speedUpFree': ['land', 'land-top', 'inventory', 'profile', 'tasks', 'counters', 'cultivation'],
  'waterwheel.recv': ['waterwheel', 'waterwheel-item', 'inventory', 'profile', 'tasks', 'counters'],
  'waterwheel.skip': ['waterwheel'],
  'freeWater.recv': ['free-water', 'free-water-item', 'profile', 'tasks', 'counters'],
  'flowerRack.unlockStand': ['flower-rack', 'profile', 'tasks', 'counters'],
  'flowerRack.sell': ['flower-rack', 'inventory', 'profile', 'tasks', 'counters'],
  'flowerRack.recvSellMoney': ['flower-rack', 'profile', 'tasks', 'counters'],
  'flowerRack.cancelSell': ['flower-rack', 'inventory', 'profile', 'tasks', 'counters'],
  'orderCustomer.finishOrder': ['customer', 'customer-eligibility', 'inventory', 'profile', 'art-inputs', 'tasks', 'counters'],
  'orderCustomer.rejectOrder': ['customer', 'customer-eligibility', 'profile', 'customer-day', 'tasks', 'counters'],
  'orderCustomer.genOrder': ['customer', 'customer-eligibility', 'customer-day', 'profile', 'tasks', 'counters'],
  'flowerArt.makeFlowerArt': ['art-inputs', 'inventory', 'customer', 'customer-eligibility', 'profile', 'tasks', 'counters'],
  'collectRwd.recvArtCreateRwdByVase': ['art-album', 'profile', 'tasks', 'counters'],
  'orderFlower.finishOrder': ['order-flower', 'order-flower-counter', 'order-flower-eligibility', 'order-flower-butler', 'inventory', 'profile', 'customer-day', 'tasks', 'counters'],
  'orderFlower.finishSatinOrder': ['order-flower', 'order-flower-counter', 'order-flower-eligibility', 'order-flower-butler', 'inventory', 'profile', 'customer-day', 'tasks', 'counters'],
  'orderFlower.finishDecorateOrder': ['order-flower', 'order-flower-counter', 'order-flower-eligibility', 'order-flower-butler', 'inventory', 'profile', 'customer-day', 'tasks', 'counters'],
  'usr.share': ['order-flower', 'order-flower-counter', 'order-flower-eligibility', 'order-flower-video-resident', 'order-flower-video-satin', 'order-flower-video-decorate', 'order-flower-card-video', 'order-flower-card-noble', 'inventory', 'profile', 'customer-day', 'tasks', 'counters'],
  'orderFlower.recvOrderRwd': ['order-flower', 'order-flower-counter', 'order-flower-eligibility', 'order-flower-reward-stage', 'inventory', 'profile', 'customer-day', 'tasks', 'counters'],
  'taskAch.recv': ['order-flower', 'order-flower-counter', 'order-flower-eligibility', 'order-flower-reward-achievement', 'inventory', 'profile', 'customer-day', 'tasks', 'counters'],
  'orderFlower.enter': ['order-flower', 'order-flower-eligibility', 'order-flower-enter-state', 'customer-day', 'tasks', 'counters'],
  'mail.pickOneKey': ['reward-mail', 'inventory', 'profile', 'tasks', 'counters'],
  'benefitBox.draw': ['reward-box', 'inventory', 'profile', 'tasks', 'counters'],
  'taskDly.recv': ['reward-tasks', 'inventory', 'profile', 'tasks', 'counters'],
  'taskDly.recvBox': ['reward-tasks', 'inventory', 'profile', 'tasks', 'counters'],
  'taskWeek.recv': ['reward-tasks', 'inventory', 'profile', 'tasks', 'counters'],
  'taskMain.recv': ['reward-tasks', 'inventory', 'profile', 'tasks', 'counters'],
  'storyMain.unlock': ['reward-story', 'inventory', 'profile', 'tasks', 'counters'],
  'fml.bld': ['reward-guild', 'inventory', 'profile', 'tasks', 'counters'],
  'fmlLand.harvestAll': ['reward-guild', 'reward-cultivate', 'cultivation', 'inventory', 'profile', 'tasks', 'counters'],
  'fmlLand.plant': ['reward-guild', 'reward-cultivate', 'cultivation', 'inventory', 'profile', 'tasks', 'counters'],
  'fmlLand.unlock': ['reward-guild', 'reward-cultivate', 'cultivation', 'inventory', 'profile', 'tasks', 'counters'],
  'fmlLand.upgrade': ['reward-guild', 'reward-cultivate', 'cultivation', 'inventory', 'profile', 'tasks', 'counters'],
  'cultivate.upgrade': ['reward-cultivate', 'cultivation', 'inventory', 'profile', 'tasks', 'counters'],
  'shopCultivate.buy': ['reward-shop', 'inventory', 'profile', 'tasks', 'counters'],
  'shopCultivate.refresh': ['reward-shop', 'inventory', 'profile', 'tasks', 'counters'],
});
const REWARD_METHOD_DOMAINS = Object.freeze({
  'mail.pickOneKey': METHOD_DOMAINS['mail.pickOneKey'],
  'benefitBox.draw': METHOD_DOMAINS['benefitBox.draw'],
  'taskDly.recv': METHOD_DOMAINS['taskDly.recv'],
  'taskDly.recvBox': METHOD_DOMAINS['taskDly.recvBox'],
  'taskWeek.recv': METHOD_DOMAINS['taskWeek.recv'],
  'taskMain.recv': METHOD_DOMAINS['taskMain.recv'],
  'storyMain.unlock': METHOD_DOMAINS['storyMain.unlock'],
  'fml.bld': METHOD_DOMAINS['fml.bld'],
  'fmlLand.harvestAll': METHOD_DOMAINS['fmlLand.harvestAll'],
  'fmlLand.plant': METHOD_DOMAINS['fmlLand.plant'],
  'fmlLand.unlock': METHOD_DOMAINS['fmlLand.unlock'],
  'fmlLand.upgrade': METHOD_DOMAINS['fmlLand.upgrade'],
  'cultivate.upgrade': METHOD_DOMAINS['cultivate.upgrade'],
  'shopCultivate.buy': METHOD_DOMAINS['shopCultivate.buy'],
  'shopCultivate.refresh': METHOD_DOMAINS['shopCultivate.refresh'],
});
const REWARD_EXTRA_DOMAINS = Object.freeze({
  'reward.mail': ['reward-mail', 'inventory', 'profile'],
  'reward.benefit-box': ['reward-box', 'inventory', 'profile'],
  'reward.daily-task': ['reward-tasks', 'inventory', 'profile'],
  'reward.daily-box': ['reward-tasks', 'inventory', 'profile'],
  'reward.weekly-task': ['reward-tasks', 'inventory', 'profile'],
  'reward.free-gift': ['reward-giftbag', 'reward-share', 'inventory', 'profile'],
  'reward.double-coin': ['reward-double', 'reward-share', 'inventory', 'profile'],
  'reward.main-task': ['reward-tasks', 'inventory', 'profile'],
  'reward.main-story': ['reward-story', 'inventory', 'profile'],
  'guild.build.video': ['reward-guild', 'reward-share', 'inventory', 'profile'],
  'guild.build.gold': ['reward-guild', 'inventory', 'profile'],
  'guild.build.yuanbao': ['reward-guild', 'inventory', 'profile'],
  'guild.land': ['reward-guild', 'reward-cultivate', 'cultivation', 'inventory', 'profile'],
  'cultivate.upgrade': ['reward-cultivate', 'cultivation', 'inventory', 'profile'],
  'cultivate.shop': ['reward-shop', 'inventory', 'profile'],
});
export const REWARD_AFFECTED_DOMAINS = Object.freeze(Object.fromEntries(REWARD_CARDS.map(card => [card.featureId,
  Object.freeze(Object.fromEntries(card.methods.map(method => [method, REWARD_EXTRA_DOMAINS[card.featureId] ||
    REWARD_METHOD_DOMAINS[method] || METHOD_DOMAINS[method]]))) ])));

// Write invalidation domains describe what the action can change. A matched
// answer may also carry a separately accepted, typed source projection. Keep
// that source-coverage allowance distinct so a newly registered action cannot
// widen the domains it invalidates. Land acceleration responses are also
// consumed by the shared customer eligibility projection (sdkChannel only).
const METHOD_OBSERVATION_DOMAINS = Object.freeze({
  'usrLand.speedUp': Object.freeze([...METHOD_DOMAINS['usrLand.speedUp'], 'customer-eligibility']),
  'usrLand.speedUpFree': Object.freeze([...METHOD_DOMAINS['usrLand.speedUpFree'], 'customer-eligibility']),
  'freeWater.recv': Object.freeze(['free-water', 'free-water-item', 'customer-eligibility', 'profile']),
  'flowerRack.unlockStand': Object.freeze(['flower-rack', 'profile', 'customer-eligibility']),
  'flowerRack.sell': Object.freeze(['flower-rack', 'inventory', 'profile', 'customer-eligibility']),
  'flowerRack.recvSellMoney': Object.freeze(['flower-rack', 'profile', 'customer-eligibility']),
  'flowerRack.cancelSell': Object.freeze(['flower-rack', 'inventory', 'profile', 'customer-eligibility']),
  'flowerArt.makeFlowerArt': Object.freeze(['art-inputs', 'inventory', 'profile', 'customer-eligibility']),
  'collectRwd.recvArtCreateRwdByVase': Object.freeze(['art-album', 'profile', 'customer-eligibility']),
  'usr.share': Object.freeze([...new Set([...(METHOD_DOMAINS['usr.share'] || []), 'art-share'])]),
  'mail.pickOneKey': Object.freeze(['reward-mail', 'inventory', 'profile']),
  'benefitBox.draw': Object.freeze(['reward-box', 'inventory', 'profile']),
  'taskDly.recv': Object.freeze(['reward-tasks', 'inventory', 'profile']),
  'taskDly.recvBox': Object.freeze(['reward-tasks', 'inventory', 'profile']),
  'taskWeek.recv': Object.freeze(['reward-tasks', 'inventory', 'profile']),
  'taskMain.recv': Object.freeze(['reward-tasks', 'inventory', 'profile']),
  'storyMain.unlock': Object.freeze(['reward-story', 'inventory', 'profile']),
  'fml.bld': Object.freeze(['reward-guild', 'inventory', 'profile']),
  'fmlLand.harvestAll': Object.freeze(['reward-guild', 'inventory', 'profile']),
  'fmlLand.plant': Object.freeze(['reward-guild', 'inventory', 'profile']),
  'fmlLand.unlock': Object.freeze(['reward-guild', 'inventory', 'profile']),
  'fmlLand.upgrade': Object.freeze(['reward-guild', 'inventory', 'profile']),
  'cultivate.upgrade': Object.freeze(['reward-cultivate', 'cultivation', 'inventory', 'profile']),
  'shopCultivate.buy': Object.freeze(['reward-shop', 'inventory', 'profile']),
  'shopCultivate.refresh': Object.freeze(['reward-shop', 'inventory', 'profile']),
});
const READ_SOURCE_DOMAINS = Object.freeze({
  'orderPalace.enter': ['special-order-palace'],
  'mail.getList': ['reward-mail'],
  'usr.heartTick': Object.keys(DYNAMIC_DOMAIN_MANIFEST),
  'usrLand.refresh': ['land', 'land-top', 'inventory', 'cultivation'],
  'waterwheel.enter': ['waterwheel', 'waterwheel-share', 'waterwheel-item'],
});
const WATERWHEEL_SOURCE_DOMAINS = Object.freeze(['land', 'land-top', 'cultivation', 'inventory', 'profile', 'tasks', 'counters',
  'waterwheel', 'waterwheel-share', 'waterwheel-item', 'customer-eligibility']);
const FREE_WATER_SOURCE_DOMAINS = Object.freeze(['free-water', 'free-water-share', 'free-water-item', 'profile', 'customer-eligibility']);
const FLOWER_RACK_SOURCE_SCOPES = Object.freeze({ 'flowerRack.unlockStand': 'rack-unlock', 'flowerRack.sell': 'rack-sell',
  'flowerRack.recvSellMoney': 'rack-recv', 'flowerRack.cancelSell': 'rack-cancel' });
// Action projections deliberately name only the facts consumed by that action.
// Collection completeness is a cell of its own: it proves that a missing item
// key means zero, while unrelated item rows do not age the whole inventory.
function actionRequiredPaths(feature, config, method, proposal) {
  const operation = method || proposal?.method || feature?.operationContract?.method || feature?.allowedMethods?.[0] || feature?.methods?.[0];
  const landId = proposal?.acceleration?.targetLandId ?? proposal?.params?.landId ?? proposal?.land?.landId;
  const itemPaths = ['inventory.bag.complete', 'inventory.itemExt.complete'];
  if (['order.palace','order.team'].includes(feature?.featureId)) {
    const domain = feature.featureId === 'order.palace' ? 'special-order-palace' : 'special-order-team';
    const required = { [domain]: [domain + '.uid'], profile: ['profile.uid'], inventory: itemPaths,
      clock: ['official-clock.lowerBoundMs','official-clock.upperBoundMs'],
      'customer-day': ['official-day.dayKey','official-day.startMs','official-day.endMs'] };
    if (proposal?.specialOrder?.itemId) required.inventory = [...itemPaths, 'inventory.bag.items.' + proposal.specialOrder.itemId];
    return required;
  }
  if (feature?.featureId === 'free-water') {
    const required = { 'free-water': ['free-water.fields.recvIdx'],
      'customer-day': ['official-day.dayKey', 'official-day.startMs', 'official-day.endMs'],
      profile: ['profile.uid'], clock: ['official-clock.lowerBoundMs', 'official-clock.upperBoundMs'] };
    if (method === 'freeWater.recv' || proposal?.freeWater?.kind === 'receive') required['free-water-item'] = ['free-water-item.item7.balance'];
    if (method === 'usr.share' || proposal?.freeWater?.kind === 'share') {
      required['free-water-share'] = ['free-water-share.share13.recvCnt', 'free-water-share.share13.uTime'];
      required['free-water-item'] = ['free-water-item.item7.balance'];
    }
    return required;
  }
  if (feature?.featureId === 'waterwheel') {
    const method = proposal?.method || feature?.method;
    const required = { waterwheel: ['waterwheel.fields.count', 'waterwheel.fields.advList'] };
    if (method === 'waterwheel.recv' || method === 'usr.share') required['waterwheel-item'] = ['waterwheel-item.item7.balance'];
    if (method === 'usr.share') {
      required['waterwheel-share'] = ['waterwheel-share.share9.shareCnt', 'waterwheel-share.share9.uTime'];
      required['customer-day'] = ['official-day.dayKey', 'official-day.endMs'];
      required.clock = ['official-clock.lowerBoundMs', 'official-clock.upperBoundMs'];
    }
    return required;
  }
  if (['usrLand.plant', 'usrLand.plantBatch'].includes(operation)) {
    const id = proposal?.params?.flowerId, target = Number.isSafeInteger(landId) ? landId : '*';
    return { land: [`land.lands.${target}.fields.state`, `land.lands.${target}.fields.flowerId`,
      `land.lands.${target}.fields.plantTime`],
      cultivation: Number.isSafeInteger(id) ? [`cultivation.cultivates.${id}.fields.lvl`, `cultivation.cultivates.${id}.fields.status`]
        : ['cultivation.cultivates.*.fields.lvl', 'cultivation.cultivates.*.fields.status'],
      'land-top': (config?.plantMode ?? config?.land?.plantMode) === 'chosen_top' ? ['land-top.top'] : [],
      inventory: itemPaths };
  }
  if (['usrLand.water', 'usrLand.waterBatch', 'usrLand.harvest'].includes(operation)) {
    const harvest = operation === 'usrLand.harvest';
    const target = Number.isSafeInteger(landId) ? landId : '*';
    return { land: [`land.lands.${target}.fields.state`, `land.lands.${target}.fields.flowerId`,
      `land.lands.${target}.fields.plantTime`, ...(harvest ? [`land.lands.${target}.fields.harvestCnt`, `land.lands.${target}.fields.nextTime`] : [])],
      ...(!harvest ? { inventory: [...itemPaths, 'inventory.bag.items.7', 'inventory.itemExt.items.7'] } : {}),
      'land-top': [],
      clock: ['official-clock.lowerBoundMs', 'official-clock.upperBoundMs'],
      ...(!harvest ? { profile: ['profile.cTime'] } : {}) };
  }
  if (['usrLand.speedUp', 'usrLand.speedUpFree'].includes(operation)) {
    const target = Number.isSafeInteger(landId) ? landId : '*', card = operation === 'usrLand.speedUp';
    return { land: [`land.lands.${target}.fields.state`, `land.lands.${target}.fields.flowerId`,
      `land.lands.${target}.fields.plantTime`, `land.lands.${target}.fields.nextTime`],
      ...(card ? { inventory: [...itemPaths, 'inventory.bag.items.1001', 'inventory.itemExt.items.1001'] } : {}),
      'land-top': [], clock: ['official-clock.lowerBoundMs', 'official-clock.upperBoundMs'] };
  }
  if (operation === 'orderCustomer.finishOrder' || operation === 'orderCustomer.rejectOrder') {
    return { customer: ['customer.orderMap', 'customer.orderMapComplete'], ...(operation === 'orderCustomer.finishOrder' ? { inventory: itemPaths } : {}),
      'customer-eligibility': ['customer-eligibility.profile.level', 'customer-eligibility.profile.vip', 'customer-eligibility.sdkChannel',
        'customer-eligibility.serverOpenMap.sys_orderCustomer', 'customer-eligibility.mainTask.domain',
        'customer-eligibility.mainTask.uid', 'customer-eligibility.mainTask.curTaskId'], profile: ['profile.uid'],
      clock: ['official-clock.lowerBoundMs', 'official-clock.upperBoundMs'] };
  }
  if (operation === 'orderCustomer.genOrder') return { customer: ['customer.orderMap', 'customer.orderMapComplete', 'customer.orderStockList',
      'customer.orderStockListComplete', 'customer.nextGenTime',
      'customer.uTime', 'customer.cTime', 'customer.createCount', 'customer.isOrderStockInit'],
    'customer-day': ['official-day.dayKey', 'official-day.endMs', 'official-day.count107Uid', 'official-day.count107Type',
      'official-day.count107Today', 'official-day.count107Total', 'official-day.count107ResetTime'],
    'customer-eligibility': ['customer-eligibility.profile.level', 'customer-eligibility.profile.vip', 'customer-eligibility.sdkChannel',
      'customer-eligibility.serverOpenMap.sys_orderCustomer', 'customer-eligibility.mainTask.domain',
      'customer-eligibility.mainTask.uid', 'customer-eligibility.mainTask.curTaskId'], profile: ['profile.uid'],
    clock: ['official-clock.lowerBoundMs', 'official-clock.upperBoundMs'] };
  if (operation === 'flowerArt.makeFlowerArt') return { 'art-inputs': ['art-inputs.vases.domain', 'art-inputs.vases.map', 'art-inputs.vases.mapComplete',
    'art-inputs.flowerArt.domain', 'art-inputs.flowerArt.uid', 'art-inputs.flowerArt.makeList'], inventory: itemPaths,
    ...(feature?.featureId === 'art.daily' && (config?.config ?? config)?.orders?.customer?.enabled === false
      ? {} : { customer: ['customer.orderMap'] }),
    profile: ['profile.uid'], clock: ['official-clock.lowerBoundMs', 'official-clock.upperBoundMs'] };
  if (['orderFlower.finishOrder', 'orderFlower.finishSatinOrder', 'orderFlower.finishDecorateOrder'].includes(operation)) {
    const counterId = operation === 'orderFlower.finishOrder' ? 105 : operation === 'orderFlower.finishSatinOrder' ? 109 : 116,
      row = operation === 'orderFlower.finishOrder' ? 'residentMap' : operation === 'orderFlower.finishSatinOrder' ? 'satin' : 'decorate';
    return { 'order-flower': ['order-flower.domain', 'order-flower.fields.uid', `order-flower.fields.${row}`],
      'order-flower-counter': ['uid', 'type', 'tdyCnt', 'totCnt', 'rTime'].map(field => `order-flower-counter.counters.${counterId}.${field}`),
      'order-flower-butler': ['order-flower-butler.stockMap'],
      'customer-day': ['official-day.dayKey', 'official-day.endMs'],
      inventory: itemPaths, profile: ['profile.uid'], clock: ['official-clock.lowerBoundMs', 'official-clock.upperBoundMs'] };
  }
  return null;
}
const matchesRequiredPath = (path, pattern) => {
  const actual = path.split('.'), expected = pattern.split('.');
  return actual.length === expected.length && expected.every((part, index) => part === '*' || part === actual[index]);
};
const domainsForObservation = observation => observation.method === 'index.login' || isNormalSyncMethod(observation.method)
  ? Object.keys(DYNAMIC_DOMAIN_MANIFEST)
  : observation.operationId ? METHOD_OBSERVATION_DOMAINS[observation.method] || METHOD_DOMAINS[observation.method] || []
    : READ_SOURCE_DOMAINS[observation.method] || [];
// A late or unsolicited push has no causal sequence, so its facts stay audit
// only. The domains it can affect are still attributable from the wire fields
// actually present; an unrecognised frame falls back to every dynamic domain.
export function unorderedObservationDomains(value) {
  if (!plainObject(value)) return [];
  const present = path => {
    let node = value;
    for (const key of path) {
      if (!plainObject(node) || !Object.hasOwn(node, key)) return false;
      node = node[key];
    }
    return true;
  };
  const out = new Set();
  let recognised = false;
  if (present(['7', '0'])) {
    recognised = true;
    for (const key of ['0', '5', '34', '41', '44']) if (present(['7', '0', key])) out.add('profile');
    if (present(['7', '0', '32'])) out.add('inventory');
  }
  if (present(['7', '2'])) { recognised = true; out.add('tasks'); out.add('counters'); }
  if (present(['7', '3'])) { recognised = true; out.add('land-top'); }
  if (present(['100']) || present(['101'])) {
    recognised = true;
    for (const domain of ['land', 'land-top', 'cultivation', 'tasks', 'counters']) out.add(domain);
  }
  if (!recognised) return [];
  return [...out].filter(domain => Object.hasOwn(DYNAMIC_DOMAIN_MANIFEST, domain) && DYNAMIC_DOMAIN_MANIFEST[domain].dynamic);
}

const POSITIVE = value => Number.isSafeInteger(value) && value > 0;
const sameContext = (left, right) => left && right && ['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch']
  .every(key => key === 'accountRef' ? String(left[key]) === String(right[key]) : left[key] === right[key]);
const validContext = value => value && typeof value.ownerRef === 'string' && value.ownerRef.length > 0 &&
  typeof value.subjectRef === 'string' && value.subjectRef.length > 0 &&
  (typeof value.accountRef === 'string' || Number.isSafeInteger(value.accountRef)) &&
  Number.isSafeInteger(value.ownerEpoch) && value.ownerEpoch > 0 && Number.isSafeInteger(value.runEpoch) && value.runEpoch > 0 &&
  Number.isSafeInteger(value.connectionEpoch) && value.connectionEpoch > 0;

export function consumedDomains(feature, config = null, method = null, proposal = null, extraDomains = []) {
  const declared = feature?.consumedDomains;
  const expected = FEATURE_DOMAINS[feature?.featureId];
  const selected = typeof feature?.consumedDomainsFor === 'function' ? feature.consumedDomainsFor({ config, method, proposal }) : declared;
  const combined = [...(Array.isArray(selected) ? selected : []), ...(Array.isArray(extraDomains) ? extraDomains : [])];
  if (!expected || !Array.isArray(declared) || !Array.isArray(selected) || !selected.length || !Array.isArray(extraDomains) ||
      new Set(combined).size !== combined.length ||
      declared.some(domain => !expected.includes(domain)) || selected.some(domain => !expected.includes(domain) || !Object.hasOwn(DYNAMIC_DOMAIN_MANIFEST, domain))) {
    throw problem('DYNAMIC_FEATURE_DOMAIN_UNDECLARED', '已注册功能没有完整登记动态事实域', 500);
  }
  if (extraDomains.some(domain => !expected.includes(domain) || !Object.hasOwn(DYNAMIC_DOMAIN_MANIFEST, domain))) {
    throw problem('DYNAMIC_FEATURE_DOMAIN_UNDECLARED', '动作补充事实域没有预先登记', 500);
  }
  return combined;
}

export function affectedDomainsForWrite(featureId, method, declared = null) {
  const waterwheelDomains = featureId === 'waterwheel' ? Object.freeze({
    'waterwheel.recv': ['waterwheel', 'waterwheel-item'],
    'waterwheel.skip': ['waterwheel'],
    'usr.share': ['waterwheel', 'waterwheel-share', 'waterwheel-item'],
  }) : null;
  const freeWaterDomains = featureId === 'free-water' ? Object.freeze({
    'freeWater.recv': ['free-water', 'free-water-item'],
    'usr.share': ['free-water', 'free-water-share', 'free-water-item'],
  }) : null;
  const flowerRackDomains = featureId === 'flower-rack' ? Object.freeze({
    'flowerRack.unlockStand': ['flower-rack', 'profile'],
    'flowerRack.sell': ['flower-rack', 'inventory'],
    'flowerRack.recvSellMoney': ['flower-rack', 'profile'],
    'flowerRack.cancelSell': ['flower-rack', 'inventory'],
  }) : null;
  const specialDefinition = Object.values(SPECIAL_ORDER_DEFINITIONS).find(one => one.featureId === featureId && one.method === method);
  const rewardDomains = REWARD_AFFECTED_DOMAINS[featureId]?.[method] || null;
  const expected = rewardDomains || (specialDefinition ? ['special-order-' + specialDefinition.kind,'inventory','profile'] : null) || waterwheelDomains?.[method] || freeWaterDomains?.[method] || flowerRackDomains?.[method] ||
    (featureId === 'art.customer-batch' && method === 'flowerArt.makeFlowerArt' ? ['art-inputs', 'inventory', 'customer', 'customer-eligibility', 'profile'] : null) ||
    (featureId === 'art.daily' && method === 'flowerArt.makeFlowerArt' ? ['art-inputs', 'inventory', 'profile'] : METHOD_DOMAINS[method]);
  if (!expected || !FEATURE_DOMAINS[featureId] || declared !== null &&
      canonical([...declared].sort()) !== canonical([...expected].sort())) {
    throw problem('DYNAMIC_WRITE_DOMAIN_UNDECLARED', '已注册写方法没有完整登记受影响事实域', 500);
  }
  return expected;
}

export function createDynamicStateCoordinator({ store, isCurrent, notify = () => {}, emit = () => {}, deviceNow = () => Date.now(),
  monotonicNow = () => Number(process.hrtime.bigint()) / 1e6, requestRefresh = null, defaultMaxAgeMs = 120000,
  refreshRetryBaseMs = 30000, refreshRetryMaxMs = 300000, refreshBusyRetryMs = 1000 } = {}) {
  for (const value of [store?.run, store?.get, store?.all, store?.transaction, isCurrent, notify, emit, deviceNow, monotonicNow]) {
    if (typeof value !== 'function') throw new TypeError('Dynamic state coordinator requires synchronous persistence and currentness ports');
  }
  if (requestRefresh !== null && typeof requestRefresh !== 'function') throw new TypeError('Dynamic state refresh port must be a function');
  if (!POSITIVE(defaultMaxAgeMs) || !POSITIVE(refreshRetryBaseMs) || !POSITIVE(refreshRetryMaxMs) ||
      !POSITIVE(refreshBusyRetryMs) || refreshRetryMaxMs < refreshRetryBaseMs) {
    throw new TypeError('Dynamic state freshness and retry intervals must be positive');
  }
  const { run, get, all, transaction, nowIso } = store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_dynamic_domain_heads(
    owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,domain_id TEXT NOT NULL,
    owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,
    semantic_revision INTEGER NOT NULL,semantic_fingerprint TEXT NOT NULL,coverage_json TEXT NOT NULL,
    source_ref TEXT NOT NULL,source_kind TEXT NOT NULL,source_method TEXT,request_sequence INTEGER,
    observed_at_ms INTEGER NOT NULL,next_check_at_ms INTEGER NOT NULL,updated_at TEXT NOT NULL,complete INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(owner_ref,subject_ref,domain_id));
    CREATE TABLE IF NOT EXISTS backend_dynamic_domain_dirty(
    owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,domain_id TEXT NOT NULL,
    owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,
    reason_code TEXT NOT NULL,operation_id TEXT,request_sequence INTEGER,request_method TEXT,dirty_at_ms INTEGER NOT NULL,
    PRIMARY KEY(owner_ref,subject_ref,domain_id));
    CREATE TABLE IF NOT EXISTS backend_dynamic_domain_cells(
    owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,domain_id TEXT NOT NULL,path TEXT NOT NULL,
    owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,semantic_fingerprint TEXT NOT NULL,
    source_ref TEXT NOT NULL,source_method TEXT,request_sequence INTEGER,observed_at_ms INTEGER NOT NULL,updated_at TEXT NOT NULL,
    observed_monotonic_ms REAL NOT NULL DEFAULT 0,instance_ref TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(owner_ref,subject_ref,domain_id,path));
    CREATE TABLE IF NOT EXISTS backend_dynamic_refresh_events(
    refresh_ref TEXT NOT NULL,event_kind TEXT NOT NULL,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,
    subject_ref TEXT NOT NULL,run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,
    domains_json TEXT NOT NULL,reasons_json TEXT NOT NULL,receipt_json TEXT NOT NULL,recorded_at TEXT NOT NULL,
    PRIMARY KEY(refresh_ref,event_kind));`);
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_dynamic_refresh_domain_retry(
    owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,domain_id TEXT NOT NULL,attempt INTEGER NOT NULL,
    retry_at_ms INTEGER NOT NULL,last_response_ref TEXT,reason_code TEXT NOT NULL,updated_at TEXT NOT NULL,
    PRIMARY KEY(owner_ref,subject_ref,domain_id));`);
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_dynamic_refresh_subject_retry(
    owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,attempt INTEGER NOT NULL,retry_at_ms INTEGER NOT NULL,
    reason_code TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref));`);
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_dynamic_login_identity_anchors(
    owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,
    connection_epoch INTEGER NOT NULL,response_ref TEXT NOT NULL,request_sequence INTEGER NOT NULL,official_uid INTEGER NOT NULL,
    game_version TEXT,protocol_version TEXT,recorded_at TEXT NOT NULL,
    PRIMARY KEY(owner_ref,subject_ref,connection_epoch,response_ref));
    CREATE TRIGGER IF NOT EXISTS backend_dynamic_login_identity_anchors_no_update BEFORE UPDATE ON backend_dynamic_login_identity_anchors
      BEGIN SELECT RAISE(ABORT,'dynamic login identity anchors are append only'); END;
    CREATE TRIGGER IF NOT EXISTS backend_dynamic_login_identity_anchors_no_delete BEFORE DELETE ON backend_dynamic_login_identity_anchors
      BEGIN SELECT RAISE(ABORT,'dynamic login identity anchors are append only'); END;`);
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_dynamic_response_anchors(
    anchor_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,response_ref TEXT NOT NULL,
    method TEXT NOT NULL,request_sequence INTEGER NOT NULL,wire_key TEXT NOT NULL,official_uid INTEGER NOT NULL,
    raw_value_fingerprint TEXT NOT NULL,recorded_at TEXT NOT NULL,
    UNIQUE(owner_ref,subject_ref,connection_epoch,response_ref));
    CREATE TABLE IF NOT EXISTS backend_dynamic_projection_receipts(
    receipt_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,response_ref TEXT NOT NULL,
    domain_id TEXT NOT NULL,request_sequence INTEGER NOT NULL,wire_key TEXT NOT NULL,official_uid INTEGER NOT NULL,
    raw_value_fingerprint TEXT NOT NULL,source_proof_fingerprint TEXT,paths_json TEXT NOT NULL,
    semantic_fingerprint TEXT NOT NULL,complete INTEGER NOT NULL,recorded_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS backend_dynamic_projection_receipts_lookup ON backend_dynamic_projection_receipts(
      owner_ref,subject_ref,connection_epoch,response_ref,domain_id,recorded_at);
    CREATE TRIGGER IF NOT EXISTS backend_dynamic_response_anchors_no_update BEFORE UPDATE ON backend_dynamic_response_anchors
      BEGIN SELECT RAISE(ABORT,'dynamic raw response anchors are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_dynamic_response_anchors_no_delete BEFORE DELETE ON backend_dynamic_response_anchors
      BEGIN SELECT RAISE(ABORT,'dynamic raw response anchors are append only'); END;
    CREATE TRIGGER IF NOT EXISTS backend_dynamic_projection_receipts_no_update BEFORE UPDATE ON backend_dynamic_projection_receipts
      BEGIN SELECT RAISE(ABORT,'dynamic projection receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_dynamic_projection_receipts_no_delete BEFORE DELETE ON backend_dynamic_projection_receipts
      BEGIN SELECT RAISE(ABORT,'dynamic projection receipts are append only'); END;`);
  if (!all('PRAGMA table_info(backend_dynamic_domain_heads)').some(column => column.name === 'complete')) {
    run('ALTER TABLE backend_dynamic_domain_heads ADD COLUMN complete INTEGER NOT NULL DEFAULT 0');
  }
  if (!all('PRAGMA table_info(backend_dynamic_domain_dirty)').some(column => column.name === 'request_method')) {
    run('ALTER TABLE backend_dynamic_domain_dirty ADD COLUMN request_method TEXT');
  }
  for (const [column, declaration] of [['observed_monotonic_ms', 'REAL NOT NULL DEFAULT 0'], ['instance_ref', "TEXT NOT NULL DEFAULT ''"]]) {
    if (!all('PRAGMA table_info(backend_dynamic_domain_cells)').some(one => one.name === column)) {
      run(`ALTER TABLE backend_dynamic_domain_cells ADD COLUMN ${column} ${declaration}`);
    }
  }
  const instanceRef = 'dynamic-instance:' + newId();
  const flights = new Map();
  const retryDeadlines = new Map();
  const subjectRetryDeadlines = new Map();
  const emitSafely = event => { try { emit(event); } catch { /* Diagnostics never controls business admission. */ } };
  const notifySafely = (context, domains = []) => { try { notify(context, domains); } catch { /* Durable scheduler deadlines retry missed wakes. */ } };
  const key = context => canonical([context.ownerRef, context.subjectRef]);
  const head = (context, domainId) => get('SELECT * FROM backend_dynamic_domain_heads WHERE owner_ref=? AND subject_ref=? AND domain_id=?',
    context.ownerRef, context.subjectRef, domainId);
  const dirty = (context, domainId) => get('SELECT * FROM backend_dynamic_domain_dirty WHERE owner_ref=? AND subject_ref=? AND domain_id=?',
    context.ownerRef, context.subjectRef, domainId);
  const loginUidOf = observation => observation?.value?.['7']?.['0']?.['0'];
  const rawLoginFingerprint = observation => {
    try { return fingerprint(observation?.value); } catch { return null; }
  };
  const verifiedLoginProofFingerprint = (context, observation, uid) => {
    const version = observation?.versionEvidence, binding = version?.profileBinding;
    if (!binding || binding.ownerRef !== context.ownerRef || binding.accountRef !== String(context.accountRef) ||
        binding.subjectRef !== context.subjectRef || binding.ownerEpoch !== context.ownerEpoch || binding.runEpoch !== context.runEpoch ||
        binding.connectionEpoch !== context.connectionEpoch || binding.officialUid !== uid ||
        binding.loginResponseRef !== observation.responseRef || version.loginResponseRef !== observation.responseRef) return null;
    return currentOfficialSourceEvidence(version)?.proofFingerprint ?? null;
  };
  const verifiedLegacyLoginAnchor = (context, observation, uid) => {
    const version = observation?.versionEvidence;
    const protocol = OFFICIAL_CORE_CONTRACT.protocolVersion;
    const reported = observation?.reportedServerVersion ?? observation?.protocolVersion ?? version?.reportedServerVersion ?? null;
    if (version?.source !== 'normal-package-hop-and-matched-world-login/v1' || version.gameVersion !== '480.0.27' ||
        version.protocolVersion !== protocol || version.loginResponseRef !== observation?.responseRef ||
        version.profileBinding?.dataSnapshotId !== version.dataSnapshotId ||
        (observation?.protocolVersion != null && observation.protocolVersion !== protocol) ||
        (reported !== null && reported !== protocol)) return false;
    return contractBindingMatches(version, { ...context, officialUid: uid, loginResponseRef: observation.responseRef });
  };
  const dynamicResponseAnchor = (context, responseRef) => get(`SELECT * FROM backend_dynamic_response_anchors
    WHERE owner_ref=? AND subject_ref=? AND connection_epoch=? AND response_ref=?`,
  context.ownerRef, context.subjectRef, context.connectionEpoch, responseRef);
  const hasDynamicHeadForResponse = (context, responseRef) => !!get(`SELECT 1 FROM backend_dynamic_domain_heads
    WHERE owner_ref=? AND subject_ref=? AND connection_epoch=? AND source_ref=? LIMIT 1`,
  context.ownerRef, context.subjectRef, context.connectionEpoch, responseRef);
  const recordProjectionReceipt = (context, observation, uid, rawFingerprint, sourceProofFingerprint, item) => {
    const paths = [...item.paths].sort(), receiptRef = 'dynamic-projection:' + fingerprint({ ownerRef: context.ownerRef,
      subjectRef: context.subjectRef, connectionEpoch: context.connectionEpoch, responseRef: observation.responseRef,
      domainId: item.domainId, requestSequence: observation.requestSequence, proof: sourceProofFingerprint,
      paths, semanticFingerprint: item.semanticFingerprint, complete: item.complete });
    run(`INSERT OR IGNORE INTO backend_dynamic_projection_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, receiptRef,
      context.ownerRef, String(context.accountRef), context.subjectRef, context.ownerEpoch, context.runEpoch, context.connectionEpoch,
      observation.responseRef, item.domainId, observation.requestSequence, observation.wireKey, uid, rawFingerprint,
      sourceProofFingerprint, canonical(paths), item.semanticFingerprint, Number(item.complete), nowIso());
  };
  function recordEvent(refreshRef, eventKind, context, domains, reasons, receipt) {
    run('INSERT OR IGNORE INTO backend_dynamic_refresh_events VALUES(?,?,?,?,?,?,?,?,?,?,?)', refreshRef, eventKind, context.ownerRef,
      String(context.accountRef), context.subjectRef, context.runEpoch, context.connectionEpoch, canonical([...domains].sort()),
      canonical([...reasons].sort()), canonical(receipt), nowIso());
    emitSafely({ context, eventType: 'dynamic-refresh-' + eventKind, traceId: refreshRef, operationId: null,
      outcomeState: eventKind, attempted: eventKind === 'requested', runEpoch: context.runEpoch,
      connectionEpoch: context.connectionEpoch, phase: eventKind, retryAtMs: receipt.retryAtMs ?? null,
      errorCode: receipt.reasonCode ?? null, detail: { domains: [...domains].sort(), reasons: [...reasons].sort(),
        ...(Array.isArray(receipt.missing) ? { missing: receipt.missing.slice(0, 16) } : {}),
        ...(Array.isArray(receipt.missingAfter) ? { missingAfter: receipt.missingAfter.slice(0, 16) } : {}) } });
  }
  function markDirty(context, domainId, reasonCode, { operationId = null, requestSequence = null, requestMethod = null } = {}) {
    if (!Object.hasOwn(DYNAMIC_DOMAIN_MANIFEST, domainId)) throw problem('DYNAMIC_DOMAIN_UNKNOWN', '未知动态事实域不能静默失效', 500);
    run(`INSERT INTO backend_dynamic_domain_dirty(owner_ref,account_ref,subject_ref,domain_id,owner_epoch,run_epoch,connection_epoch,reason_code,operation_id,request_sequence,request_method,dirty_at_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref,domain_id)
      DO UPDATE SET account_ref=excluded.account_ref,owner_epoch=excluded.owner_epoch,run_epoch=excluded.run_epoch,
      connection_epoch=excluded.connection_epoch,reason_code=excluded.reason_code,operation_id=excluded.operation_id,
      request_sequence=excluded.request_sequence,request_method=excluded.request_method,dirty_at_ms=excluded.dirty_at_ms
      WHERE (excluded.operation_id IS NULL AND excluded.request_sequence IS NULL)
        OR backend_dynamic_domain_dirty.account_ref IS NOT excluded.account_ref
        OR backend_dynamic_domain_dirty.owner_epoch IS NOT excluded.owner_epoch
        OR backend_dynamic_domain_dirty.run_epoch IS NOT excluded.run_epoch
        OR backend_dynamic_domain_dirty.connection_epoch IS NOT excluded.connection_epoch
        OR backend_dynamic_domain_dirty.reason_code IS NOT excluded.reason_code
        OR backend_dynamic_domain_dirty.operation_id IS NOT excluded.operation_id
        OR backend_dynamic_domain_dirty.request_sequence IS NOT excluded.request_sequence
        OR backend_dynamic_domain_dirty.request_method IS NOT excluded.request_method`, context.ownerRef, String(context.accountRef), context.subjectRef,
    domainId, context.ownerEpoch, context.runEpoch, context.connectionEpoch, reasonCode, operationId, requestSequence, requestMethod, deviceNow());
  }
  // --- Post-write continuity receipts (qproof/v2) --------------------------
  // Continuity alone never clears a barrier. R8's separate land certificate
  // additionally requires raw values and the complete immutable workset.
  // Keys carry full axes because connectionEpoch is per-subject, not global.
  const PROOF_CONTRACT_VERSION = 'qproof/v2';
  const PROOF_DOMAINS = new Set(['land', 'land-top', 'inventory', 'profile', 'tasks', 'counters', 'cultivation']);
  // REVIEW 01: a shadow dispatch row is written only for the three fixed land
  // actions. Rack, art and customer writes also dirty inventory/profile/tasks/
  // counters, and keying those too would widen the same chain to methods whose
  // post-read contract is not proven. The real dirty rows are unchanged.
  const isLandProofAction = (featureId, scope, method) => Object.hasOwn(LAND_METHODS, featureId) &&
    scope === featureId && method === LAND_METHODS[featureId];
  // Conflicts are remembered in a bounded set because the events table is
  // append-only here and no schema may be added: a poisoned ref has to make a
  // later continuity read unprovable, not silently stay invisible.
  const PROOF_CONFLICT_MEMORY_MAX = 512;
  const proofConflicts = new Set();
  // accountRef is part of the key on purpose: connectionEpoch is per subject, so
  // owner/subject/epoch alone could collide across the two roster accounts that
  // share a subject after a rebind. Only accountRef is normalised, with the
  // existing String() contract; ownerRef/subjectRef must already be non-empty
  // text, otherwise a coerced "undefined" could be hashed into a shared key.
  const strictText = value => typeof value === 'string' && value.length > 0 ? value : null;
  const positiveEpoch = value => Number.isSafeInteger(value) && value > 0;
  function proofAxes(context, domainId) {
    const ownerRef = strictText(context?.ownerRef), subjectRef = strictText(context?.subjectRef);
    const accountRef = context?.accountRef;
    if (!ownerRef || !subjectRef || accountRef === null || accountRef === undefined || accountRef === '') return null;
    if (!positiveEpoch(context.ownerEpoch) || !positiveEpoch(context.runEpoch) || !positiveEpoch(context.connectionEpoch)) return null;
    if (!strictText(domainId)) return null;
    return [ownerRef, String(accountRef), subjectRef, context.ownerEpoch, context.runEpoch, context.connectionEpoch, domainId];
  }
  const proofRef = (kind, axes, operationId = null) =>
    axes ? PROOF_CONTRACT_VERSION + ':' + kind + ':' + fingerprint([...axes, operationId]) : null;
  // Continuous review 02 final: a conflict must outlive this process. The marker
  // is a deterministic row in the existing events table (new event_kind, no
  // schema change, nothing deleted), keyed off the poisoned reference itself, so
  // any later continuity read can find it with one primary-key lookup. The
  // in-memory set stays only as a fast path, never as the authority.
  const conflictRefFor = ref => PROOF_CONTRACT_VERSION + ':conflict:' + fingerprint([ref]);
  // false = no marker, true = marker present, unknown = the lookup itself failed.
  const conflictMarkerState = ref => {
    if (!strictText(ref)) return false;
    try { return !!get('SELECT 1 FROM backend_dynamic_refresh_events WHERE refresh_ref=? AND event_kind=? LIMIT 1',
      conflictRefFor(ref), 'proof-conflict'); }
    catch { degradeProofStore('PROOF_MARKER_READ_FAILED'); return 'unknown'; }
  };
  // The reason a reference is poisoned is reported separately, so "the marker row
  // says conflict" and "the marker lookup itself failed" never collapse into one
  // another — the second one is a storage failure, not evidence of cleanliness.
  const poisonCode = (ref, label) => {
    if (!strictText(ref)) return null;
    const state = conflictMarkerState(ref);
    if (proofConflicts.has(ref) || state === true) return label + '_EVENT_CONTENT_CONFLICT';
    return state === 'unknown' ? label + '_CONFLICT_LOOKUP_UNAVAILABLE' : null;
  };
  // Continuous review 03/04: a failed proof write or read is a fact about the
  // whole proof facility, not about one key, so it is remembered as ONE sticky
  // process-level state - never evicted, never sized, never reset by a later
  // success. A bounded Map was rejected because eviction would silently restore
  // the ability to report proven. From here on every proof entry point may only
  // report unavailable.
  let proofStoreFailure = null;
  const degradeProofStore = code => { if (!proofStoreFailure) proofStoreFailure = String(code || 'PROOF_STORE_FAILED').slice(0, 96); };
  const proofStoreUnreliable = () => proofStoreFailure !== null;
  // Seven proof domains is the whole set; a feature that ever declares more must
  // not fan the diagnostics out beyond it.
  const PROOF_DOMAIN_LIMIT = PROOF_DOMAINS.size;
  const proofTargets = domains => [...new Set(domains)].filter(one => PROOF_DOMAINS.has(one)).slice(0, PROOF_DOMAIN_LIMIT);
  const dirtyFingerprint = row => row ? fingerprint({ accountRef: String(row.account_ref), ownerEpoch: row.owner_epoch,
    runEpoch: row.run_epoch, connectionEpoch: row.connection_epoch, reasonCode: row.reason_code,
    operationId: row.operation_id ?? null, requestSequence: row.request_sequence ?? null,
    requestMethod: row.request_method ?? null, dirtyAtMs: row.dirty_at_ms }) : null;
  function readProofReceipt(kind, ref) {
    if (typeof ref !== 'string' || !ref) return null;
    let row;
    // A failed receipt read is a storage failure, latched for the process; reading
    // it as "missing" without the latch would let the next attempt look clean.
    try { row = get('SELECT receipt_json FROM backend_dynamic_refresh_events WHERE refresh_ref=? AND event_kind=?', ref, 'proof-' + kind); }
    catch { degradeProofStore('PROOF_RECEIPT_READ_FAILED'); return null; }
    if (!row) return null;
    // An unparseable receipt is a broken proof record, not an absent one: latch so
    // no later domain can be certified on top of unreadable evidence.
    try { return parseStored(row.receipt_json, 'proof ' + kind); }
    catch { degradeProofStore('PROOF_RECEIPT_PARSE_FAILED'); return null; }
  }
  function recordProofEvent(kind, context, domainId, operationId, receipt) {
    // Every proof entry point re-checks currentness; a stale context may not write
    // a receipt that a later read would treat as part of its own chain.
    if (!isCurrent(context)) {
      emitSafely({ context, eventType: 'domain-write-proof-event-unprovable', traceId: null, operationId: operationId ?? null,
        outcomeState: 'unprovable', attempted: false, runEpoch: context?.runEpoch ?? null,
        connectionEpoch: context?.connectionEpoch ?? null, phase: 'post-write-proof',
        errorCode: 'PROOF_CONTEXT_NOT_CURRENT', detail: { kind, domainId: strictText(domainId) ?? null } });
      return { ref: null, duplicate: false, conflict: false, unprovable: 'PROOF_CONTEXT_NOT_CURRENT' };
    }
    const refreshRef = proofRef(kind, proofAxes(context, domainId), operationId);
    if (!refreshRef) {
      // Fail closed: an unusable identity is never written and never claimed.
      emitSafely({ context, eventType: 'domain-write-proof-event-unprovable', traceId: null, operationId: operationId ?? null,
        outcomeState: 'unprovable', attempted: false, runEpoch: context?.runEpoch ?? null,
        connectionEpoch: context?.connectionEpoch ?? null, phase: 'post-write-proof',
        errorCode: 'PROOF_AXES_INVALID', detail: { kind, domainId: strictText(domainId) ?? null } });
      return { ref: null, duplicate: false, conflict: false, unprovable: 'PROOF_AXES_INVALID' };
    }
    const body = canonical({ contractVersion: PROOF_CONTRACT_VERSION, kind, domainId, operationId: operationId ?? null,
      ownerRef: context.ownerRef, accountRef: String(context.accountRef), subjectRef: context.subjectRef,
      ownerEpoch: context.ownerEpoch, runEpoch: context.runEpoch,
      connectionEpoch: context.connectionEpoch, ...receipt });
    const eventKind = 'proof-' + kind;
    let existing = null;
    // The duplicate/conflict read is a storage read too: it must latch on failure,
    // not merely make this one diagnostic unavailable.
    try { existing = get('SELECT receipt_json FROM backend_dynamic_refresh_events WHERE refresh_ref=? AND event_kind=?', refreshRef, eventKind); }
    catch {
      degradeProofStore('PROOF_EXISTENCE_READ_FAILED');
      emitSafely({ context, eventType: 'domain-write-proof-event-unprovable', traceId: refreshRef, operationId,
        outcomeState: 'unprovable', attempted: false, runEpoch: context.runEpoch, connectionEpoch: context.connectionEpoch,
        phase: 'post-write-proof', errorCode: 'PROOF_EXISTENCE_READ_FAILED',
        detail: { kind, domainId, resultKind: 'event-integrity', contractVersion: PROOF_CONTRACT_VERSION } });
      return { ref: null, duplicate: false, conflict: false, unprovable: 'PROOF_EXISTENCE_READ_FAILED' };
    }
    if (existing) {
      if (existing.receipt_json === body) return { ref: refreshRef, duplicate: true, conflict: false };
      // A same-key different-content write is a conflict, never a success, and
      // poisons the ref so continuity cannot report proven afterwards. The poison
      // is persisted deterministically; if that write itself fails, continuity
      // treats the reference as unprovable rather than forgetting the conflict.
      if (proofConflicts.size >= PROOF_CONFLICT_MEMORY_MAX) proofConflicts.delete(proofConflicts.values().next().value);
      proofConflicts.add(refreshRef);
      let markerWritten = false;
      // Named columns, not positional VALUES: the events table has no owner_epoch
      // column, and an axis shifted into run_epoch would silently store a row that
      // no later lookup can address.
      try {
        run(`INSERT OR IGNORE INTO backend_dynamic_refresh_events(refresh_ref,event_kind,owner_ref,account_ref,subject_ref,
          run_epoch,connection_epoch,domains_json,reasons_json,receipt_json,recorded_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`, conflictRefFor(refreshRef), 'proof-conflict', context.ownerRef,
          String(context.accountRef), context.subjectRef, context.runEpoch, context.connectionEpoch,
          canonical([domainId]), canonical(['POST_WRITE_DIAGNOSTIC']),
          canonical({ contractVersion: PROOF_CONTRACT_VERSION, kind: 'conflict', poisonedRef: refreshRef, poisonedKind: kind,
            domainId, ownerRef: context.ownerRef, accountRef: String(context.accountRef), subjectRef: context.subjectRef,
            ownerEpoch: context.ownerEpoch, runEpoch: context.runEpoch, connectionEpoch: context.connectionEpoch,
            firstReceiptFingerprint: fingerprint(existing.receipt_json), attemptedReceiptFingerprint: fingerprint(body) }),
          nowIso());
        markerWritten = true;
      } catch { markerWritten = false; degradeProofStore('PROOF_MARKER_WRITE_FAILED'); }
      // A conflict whose marker could not be persisted must not be recoverable by
      // the later absence of a marker: the whole proof facility is now unreliable.
      emitSafely({ context, eventType: 'domain-write-proof-event-conflict', traceId: refreshRef, operationId,
        outcomeState: 'conflict', attempted: false, runEpoch: context.runEpoch, connectionEpoch: context.connectionEpoch,
        phase: 'post-write-proof', errorCode: 'PROOF_EVENT_CONTENT_CONFLICT', detail: { kind, domainId,
          poisoned: true, markerWritten, contractVersion: PROOF_CONTRACT_VERSION,
          channelDegraded: !markerWritten, resultKind: 'event-integrity' } });
      return { ref: refreshRef, duplicate: false, conflict: true };
    }
    try {
      run(`INSERT INTO backend_dynamic_refresh_events(refresh_ref,event_kind,owner_ref,account_ref,subject_ref,
        run_epoch,connection_epoch,domains_json,reasons_json,receipt_json,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        refreshRef, eventKind, context.ownerRef, String(context.accountRef), context.subjectRef, context.runEpoch,
        context.connectionEpoch, canonical([domainId]), canonical(['POST_WRITE_DIAGNOSTIC']), body, nowIso());
    } catch (error) {
      degradeProofStore('PROOF_RECEIPT_WRITE_' + String(error?.code || 'FAILED').slice(0, 40));
      emitSafely({ context, eventType: 'domain-write-proof-event-unprovable', traceId: refreshRef, operationId,
        outcomeState: 'unprovable', attempted: false, runEpoch: context.runEpoch, connectionEpoch: context.connectionEpoch,
        phase: 'post-write-proof', errorCode: 'PROOF_RECEIPT_WRITE_' + String(error?.code || 'FAILED').slice(0, 40),
        detail: { kind, domainId, resultKind: 'event-integrity', contractVersion: PROOF_CONTRACT_VERSION } });
      return { ref: null, duplicate: false, conflict: false, unprovable: 'PROOF_RECEIPT_WRITE_FAILED' };
    }
    return { ref: refreshRef, duplicate: false, conflict: false };
  }
  // Bounded continuity read: dispatch event + baseline event + current dirty row
  // = 3 rows per domain. The stored original hash, the send permit row and this
  // context's recorded full login anchor do not depend on the domain, so they are
  // read once per matched response instead of once per domain, and there is still
  // no history scan and no full-DTO hashing. Continuous review 02: the whole
  // diagnostic preparation is isolated here — a failing diagnostic query is
  // recorded as unavailable and must not escape into the observe/login
  // transaction or alter the original business handling.
  const loginAnchorOf = context => {
    const ownerRef = strictText(context?.ownerRef), subjectRef = strictText(context?.subjectRef);
    if (!ownerRef || !subjectRef || context?.accountRef === null || context?.accountRef === undefined
        || context.accountRef === '' || !positiveEpoch(context.ownerEpoch) || !positiveEpoch(context.runEpoch) ||
        !positiveEpoch(context.connectionEpoch)) return null;
    return get(`SELECT * FROM backend_dynamic_login_identity_anchors WHERE owner_ref=? AND account_ref=? AND subject_ref=?
      AND owner_epoch=? AND run_epoch=? AND connection_epoch=? ORDER BY request_sequence DESC LIMIT 1`,
    ownerRef, String(context.accountRef), subjectRef, context.ownerEpoch, context.runEpoch, context.connectionEpoch);
  };
  const loginAnchorUsable = anchor => !!anchor && anchor.official_uid >= 1 && !!strictText(anchor.response_ref) &&
    Number.isSafeInteger(anchor.request_sequence) && anchor.request_sequence >= 1;
  function readProofResponseFacts(context, observation, operationRow) {
    if (!operationRow) return { unavailable: 'PROOF_OPERATION_ROW_ABSENT', originalHashVerified: false,
      paramsFingerprint: null, permit: null, loginAnchor: null, loginResponseAnchor: null };
    return {
      unavailable: null,
      originalHashVerified: hashLedgerBytes(operationRow.original_json) === operationRow.original_fingerprint,
      paramsFingerprint: strictText(operationRow.params_fingerprint),
      permit: strictText(observation.operationId) ? get(`SELECT owner_ref,account_ref,subject_ref,owner_epoch,run_epoch,
        connection_epoch,method,params_fingerprint,consumed,wire_key,request_sequence FROM backend_send_permits WHERE operation_id=?`,
      observation.operationId) : null,
      loginAnchor: loginAnchorOf(context),
      // The response anchor carries the method, sequence, wire key and uid that
      // were really recorded for that login response, so the baseline cannot
      // simply assert its own login method.
      loginResponseAnchor: null,
    };
  }
  function proofResponseFacts(context, observation, operationRow) {
    try {
      const facts = readProofResponseFacts(context, observation, operationRow);
      if (!facts.unavailable && facts.loginAnchor && loginAnchorUsable(facts.loginAnchor)) {
        try { facts.loginResponseAnchor = dynamicResponseAnchor(context, facts.loginAnchor.response_ref); }
        catch { facts.loginResponseAnchor = null; degradeProofStore('PROOF_RESPONSE_ANCHOR_READ_FAILED'); }
      }
      return facts;
    } catch (error) {
      const code = 'PROOF_RESPONSE_FACTS_' + String(error?.code || 'QUERY_FAILED').slice(0, 48);
      degradeProofStore(code);
      return { unavailable: code,
        originalHashVerified: false, paramsFingerprint: null, permit: null, loginAnchor: null, loginResponseAnchor: null };
    }
  }
  function proofContinuity(context, domainId, observation, item, dispatchRef, facts) {
    const gaps = [];
    if (facts.unavailable) gaps.push(facts.unavailable);
    // Once the proof storage has failed anywhere in this process, no domain may be
    // certified again here; only a new login baseline in a new generation can.
    if (proofStoreUnreliable()) gaps.push('PROOF_STORE_UNRELIABLE');
    if (!isCurrent(context)) gaps.push('PROOF_CONTEXT_NOT_CURRENT');
    if (!dispatchRef) return { resultKind: 'chain-continuity', domainId, proven: false, code: gaps[0] ?? 'PROOF_AXES_INVALID',
      gaps: (gaps.length ? gaps : ['PROOF_AXES_INVALID']).slice(0, 8), dispatchRef: null, baselineRef: null,
      requestSequence: observation.requestSequence ?? null, claimedDomains: [domainId], allDomainsCurrent: false };
    const dispatch = readProofReceipt('dispatch', dispatchRef);
    const baselineRef = dispatch?.baselineRef ?? null;
    const baseline = baselineRef ? readProofReceipt('baseline', baselineRef) : null;
    const dispatchPoison = poisonCode(dispatchRef, 'DISPATCH');
    if (dispatchPoison) gaps.push(dispatchPoison);
    if (!dispatch) gaps.push('DISPATCH_EVENT_MISSING');
    else if (dispatch.contractVersion !== PROOF_CONTRACT_VERSION) gaps.push('PROOF_CONTRACT_VERSION_MISMATCH');
    if (dispatch && !baselineRef) gaps.push('BASELINE_REFERENCE_MISSING');
    else if (dispatch && !baseline) gaps.push('BASELINE_EVENT_MISSING');
    const baselinePoison = poisonCode(baselineRef, 'BASELINE');
    if (baselinePoison) gaps.push(baselinePoison);
    if (baseline && baseline.contractVersion !== PROOF_CONTRACT_VERSION) gaps.push('BASELINE_CONTRACT_VERSION_MISMATCH');
    // The baseline is a login projection, so it has to bind the whole context,
    // this exact domain, its completeness and the login response it came from —
    // and that response has to be the full login this context really anchored,
    // including the method actually recorded for it. ownerRef/subjectRef are
    // compared as text, never String()-relaxed; only accountRef keeps its
    // existing textual normalisation.
    const sameText = (left, right) => !!strictText(left) && !!strictText(right) && left === right;
    if (baseline) {
      if (baseline.domainId !== domainId) gaps.push('BASELINE_DOMAIN_MISMATCH');
      if (baseline.sourceKind !== 'login') gaps.push('BASELINE_SOURCE_NOT_LOGIN');
      if (baseline.complete !== true) gaps.push('BASELINE_COVERAGE_INCOMPLETE');
      if (!strictText(baseline.loginResponseRef)) gaps.push('BASELINE_LOGIN_RESPONSE_REF_MISSING');
      if (!sameText(baseline.ownerRef, context.ownerRef) || !sameText(baseline.subjectRef, context.subjectRef) ||
          String(baseline.accountRef) !== String(context.accountRef) || baseline.ownerEpoch !== context.ownerEpoch ||
          baseline.runEpoch !== context.runEpoch || baseline.connectionEpoch !== context.connectionEpoch) gaps.push('BASELINE_AXES_MISMATCH');
      if (!positiveEpoch(baseline.requestSequence)) gaps.push('BASELINE_REQUEST_SEQUENCE_INVALID');
      if (facts.unavailable) gaps.push('BASELINE_LOGIN_SOURCE_UNPROVABLE');
      else if (!facts.loginAnchor) gaps.push('BASELINE_LOGIN_ANCHOR_ABSENT');
      else if (!loginAnchorUsable(facts.loginAnchor)) gaps.push('BASELINE_LOGIN_ANCHOR_INVALID');
      else if (strictText(baseline.loginResponseRef) !== facts.loginAnchor.response_ref) gaps.push('BASELINE_LOGIN_RESPONSE_NOT_ANCHORED');
      else if (baseline.requestSequence !== facts.loginAnchor.request_sequence) gaps.push('BASELINE_LOGIN_SEQUENCE_NOT_ANCHORED');
      else if (baseline.officialUid !== facts.loginAnchor.official_uid) gaps.push('BASELINE_LOGIN_UID_NOT_ANCHORED');
      else if (!facts.loginResponseAnchor) gaps.push('BASELINE_LOGIN_METHOD_ANCHOR_ABSENT');
      else if (!sameText(baseline.loginMethod, facts.loginResponseAnchor.method)) gaps.push('BASELINE_LOGIN_METHOD_NOT_ANCHORED');
      else if (!strictText(facts.loginResponseAnchor.wire_key)) gaps.push('BASELINE_LOGIN_WIRE_KEY_UNANCHORED');
      // Response and identity bind to each other: the login response anchor must
      // carry the same official uid, the same axes and its own raw fingerprint.
      else if (Number(facts.loginResponseAnchor.official_uid) !== Number(facts.loginAnchor.official_uid)) gaps.push('IDENTITY_ANCHOR_UID_MISMATCH');
      else if (!Number.isSafeInteger(facts.loginResponseAnchor.official_uid) || facts.loginResponseAnchor.official_uid < 1) gaps.push('IDENTITY_ANCHOR_UID_INVALID');
      else if (!sameText(facts.loginResponseAnchor.owner_ref, context.ownerRef) ||
               !sameText(facts.loginResponseAnchor.subject_ref, context.subjectRef) ||
               String(facts.loginResponseAnchor.account_ref) !== String(context.accountRef) ||
               facts.loginResponseAnchor.owner_epoch !== context.ownerEpoch ||
               facts.loginResponseAnchor.run_epoch !== context.runEpoch ||
               facts.loginResponseAnchor.connection_epoch !== context.connectionEpoch) gaps.push('IDENTITY_ANCHOR_AXES_MISMATCH');
      else if (!strictText(facts.loginResponseAnchor.raw_value_fingerprint)) gaps.push('IDENTITY_ANCHOR_RAW_ABSENT');
      // And the baseline must carry the same identity the anchor recorded, so the
      // new chain is bound to a real full login rather than to a self-description.
      else if (!sameText(baseline.loginWireKey, facts.loginResponseAnchor.wire_key)) gaps.push('IDENTITY_ANCHOR_WIRE_KEY_MISMATCH');
      else if (!sameText(baseline.loginRawValueFingerprint, facts.loginResponseAnchor.raw_value_fingerprint)) gaps.push('IDENTITY_ANCHOR_RAW_MISMATCH');
      else if (!sameText(baseline.loginResponseRef, facts.loginResponseAnchor.response_ref)) gaps.push('IDENTITY_ANCHOR_RESPONSE_MISMATCH');
      // The two anchors must describe the same login request, not merely the same
      // method and uid.
      else if (facts.loginResponseAnchor.request_sequence !== facts.loginAnchor.request_sequence) gaps.push('IDENTITY_ANCHOR_SEQUENCE_MISMATCH');
    }
    if (dispatch && dispatch.priorGap === true) {
      gaps.push('PRIOR_GAP_PRESENT');
      if (!dispatch.priorGapRef || !readProofReceipt('prior-gap', dispatch.priorGapRef)) gaps.push('PRIOR_GAP_REFERENCE_MISSING');
      else { const priorPoison = poisonCode(dispatch.priorGapRef, 'PRIOR_GAP'); if (priorPoison) gaps.push(priorPoison); }
    }
    // Four-way binding: permit row ↔ dispatch event ↔ matched observation ↔ the
    // login anchor behind the baseline. A matched response without its own wire
    // key is reported, not skipped.
    const observedWireKey = strictText(observation.wireKey);
    if (!observedWireKey) gaps.push('OBSERVATION_WIRE_KEY_MISSING');
    if (dispatch && strictText(dispatch.wireKey) !== dispatch.wireKey) gaps.push('DISPATCH_WIRE_KEY_INVALID');
    else if (dispatch && observedWireKey && dispatch.wireKey !== observedWireKey) gaps.push('DISPATCH_WIRE_KEY_OBSERVATION_MISMATCH');
    if (dispatch && dispatch.paramsFingerprint !== facts.paramsFingerprint) gaps.push('DISPATCH_PARAMS_MISMATCH');
    const permit = facts.permit;
    if (!permit && !facts.unavailable) gaps.push('SEND_PERMIT_MISSING');
    if (permit) {
      if (!sameText(permit.owner_ref, context.ownerRef) || !sameText(permit.subject_ref, context.subjectRef) ||
          String(permit.account_ref) !== String(context.accountRef) || permit.owner_epoch !== context.ownerEpoch ||
          permit.run_epoch !== context.runEpoch || permit.connection_epoch !== context.connectionEpoch) gaps.push('SEND_PERMIT_AXES_MISMATCH');
      if (permit.method !== observation.method) gaps.push('SEND_PERMIT_OBSERVATION_METHOD_MISMATCH');
      if (observedWireKey && strictText(permit.wire_key) !== observedWireKey) gaps.push('SEND_PERMIT_WIRE_KEY_OBSERVATION_MISMATCH');
      if (permit.consumed !== 1) gaps.push('SEND_PERMIT_NOT_CONSUMED');
      const wireKey = strictText(permit.wire_key);
      if (!wireKey || !Number.isSafeInteger(permit.request_sequence)) gaps.push('SEND_PERMIT_NOT_BOUND');
      else {
        if (dispatch && wireKey !== dispatch.wireKey) gaps.push('SEND_PERMIT_WIRE_KEY_MISMATCH');
        if (dispatch && permit.request_sequence !== dispatch.requestSequence) gaps.push('SEND_PERMIT_DISPATCH_SEQUENCE_MISMATCH');
        if (dispatch && permit.method !== dispatch.method) gaps.push('SEND_PERMIT_DISPATCH_METHOD_MISMATCH');
        if (dispatch && strictText(permit.params_fingerprint) !== strictText(dispatch.paramsFingerprint)) gaps.push('SEND_PERMIT_DISPATCH_PARAMS_MISMATCH');
      }
      if (permit.request_sequence !== observation.requestSequence) gaps.push('SEND_PERMIT_SEQUENCE_MISMATCH');
      if (facts.paramsFingerprint && permit.params_fingerprint !== facts.paramsFingerprint) gaps.push('SEND_PERMIT_PARAMS_MISMATCH');
    }
    if (!facts.unavailable && !facts.originalHashVerified) gaps.push('ORIGINAL_BYTES_HASH_MISMATCH');
    let currentFingerprint = null, dirtyReadFailed = false;
    try { currentFingerprint = dirtyFingerprint(dirty(context, domainId)); }
    catch { dirtyReadFailed = true; degradeProofStore('PROOF_DIRTY_ROW_READ_FAILED'); }
    if (dirtyReadFailed) gaps.push('DIRTY_ROW_READ_UNAVAILABLE');
    else if (!dispatch || !currentFingerprint || currentFingerprint !== dispatch.dirtyFingerprint) gaps.push('DIRTY_FINGERPRINT_CHANGED');
    if (dispatch && dispatch.requestSequence !== observation.requestSequence) gaps.push('DISPATCH_SEQUENCE_MISMATCH');
    if (item.complete !== true) gaps.push('DOMAIN_COVERAGE_INCOMPLETE');
    return { resultKind: 'chain-continuity', domainId, proven: gaps.length === 0, code: gaps[0] ?? null,
      gaps: gaps.slice(0, 8), dispatchRef, baselineRef, requestSequence: observation.requestSequence,
      claimedDomains: [domainId], allDomainsCurrent: false };
  }

  function landValueCertificate(context, observation, target, fieldProof, continuity, facts, operationRow, barrier, domainId = 'land') {
    const workset=target?.workset;
    if (!fieldProof?.proven || !continuity?.proven || !facts?.originalHashVerified ||
        !landWriteWorksetValid(workset,context,target) || facts.loginAnchor?.response_ref!==workset.loginResponseRef ||
        facts.loginAnchor?.request_sequence!==workset.loginRequestSequence || facts.loginAnchor?.official_uid!==workset.officialUid ||
        barrier?.operation_id!==observation.operationId || barrier.request_method!==observation.method ||
        barrier.request_sequence!==observation.requestSequence || barrier.connection_epoch!==context.connectionEpoch ||
        barrier.reason_code!=='WRITE_MAY_HAVE_CHANGED_DOMAIN') return null;
    const accepted=resolveAcceptedLandObservationEvidence({store,context,observationRef:workset.loginObservationRef});
    if (accepted?.accepted!==true || accepted.frameFingerprint!==workset.loginFrameFingerprint ||
        accepted.frame.source?.responseRef!==workset.loginResponseRef || !accepted.frame.landBase?.value) return null;
    const members=Object.keys(accepted.frame.landBase.value).sort((a,b)=>Number(a)-Number(b))
      .map(id=>({landId:Number(id),fingerprint:fingerprint(accepted.frame.landBase.value[id])}));
    if (canonical(members)!==canonical(workset.loginReceivedMembers)) return null;
    return {version:domainId === 'land' ? 'land-write-value-certificate/v1' : domainId === 'inventory' ? 'inventory-write-value-certificate/v1' : 'unchanged-write-value-certificate/v1',domainId,operationId:observation.operationId,
      context:{...workset.context},originalFingerprint:operationRow.original_fingerprint,worksetFingerprint:workset.receiptFingerprint,
      loginFrameFingerprint:workset.loginFrameFingerprint,loginResponseRef:workset.loginResponseRef,
      responseRef:observation.responseRef,requestSequence:observation.requestSequence,wireKey:observation.wireKey,
      rawValueFingerprint:fingerprint(observation.value),target:{landId:target.landId,lifecycleRef:target.lifecycleRef},
      provenPaths:fieldProof.paths,coverageBasis:fieldProof.basis,dispatchRef:continuity.dispatchRef,baselineRef:continuity.baselineRef,
      dirtyFingerprint:dirtyFingerprint(barrier),priorGapAbsent:true};
  }

  function invalidate({ context, domains, reasonCode, operationId = null, requestSequence = null } = {}) {
    if (!validContext(context) || !Array.isArray(domains) || typeof reasonCode !== 'string' || !reasonCode) throw problem('DYNAMIC_CONTEXT_INVALID', '动态事实失效缺少精确代际或原因', 500);
    const unique = [...new Set(domains || [])];
    for (const domainId of unique) markDirty(context, domainId, reasonCode, { operationId, requestSequence });
    if (unique.length) notifySafely(context, unique);
    return { invalidated: unique };
  }
  function beforeDispatch({ context, proposal, binding } = {}) {
    if (!sameContext(context, proposal) || !isCurrent(context) || !POSITIVE(binding?.requestSequence) ||
        binding.connectionEpoch !== context.connectionEpoch || typeof binding.wireKey !== 'string' || !binding.wireKey) {
      throw problem('DYNAMIC_WRITE_DISPATCH_CONTEXT_INVALID', '动态事实屏障未绑定当前请求发送序号', 500);
    }
    const domains = affectedDomainsForWrite(proposal.featureId, proposal.method, proposal.affectedDomains);
    // REVIEW 01: the shadow dispatch chain is opened only by plant/water/harvest
    // with their fixed feature+method+scope triple. Every write still marks its
    // own affected domains dirty exactly as before.
    const landProof = isLandProofAction(proposal.featureId, proposal.scope, proposal.method);
    // Deduplicated and capped at the seven proof domains: a feature that ever
    // declares more must not fan the diagnostics out further. The real dirty rows
    // below still cover every affected domain.
    const proofSet = landProof ? new Set(proofTargets(domains)) : new Set();
    transaction(() => {
      for (const domainId of domains) {
        const axes = proofSet.has(domainId) ? proofAxes(context, domainId) : null;
        // Continuous review 02 final: this extra pre-write read is part of the new
        // shadow diagnostics, so it gets its own isolation while keeping its order
        // before markDirty. The real markDirty/fence stays outside any catch — its
        // own failure must still propagate.
        let prior = null, priorReadFailure = null;
        if (axes) {
          try { prior = dirty(context, domainId); }
          catch (error) { priorReadFailure = String(error?.code || 'PRIOR_ROW_READ_FAILED').slice(0, 48); degradeProofStore('PROOF_PRIOR_ROW_READ_FAILED'); }
        }
        markDirty(context, domainId, 'WRITE_MAY_HAVE_CHANGED_DOMAIN', {
          operationId: proposal.operationId, requestSequence: binding.requestSequence, requestMethod: proposal.method });
        if (!axes) continue;
        if (priorReadFailure) {
          // Without the pre-write row the chain cannot be closed for this domain;
          // record it and skip the dispatch row so continuity says unprovable.
          emitSafely({ context, eventType: 'domain-write-proof-event-unprovable', traceId: proposal.operationId,
            operationId: proposal.operationId, outcomeState: 'unprovable', attempted: false, runEpoch: context.runEpoch,
            connectionEpoch: context.connectionEpoch, phase: 'post-write-proof',
            errorCode: 'PRIOR_ROW_READ_' + priorReadFailure,
            detail: { kind: 'dispatch', domainId, resultKind: 'event-integrity', contractVersion: PROOF_CONTRACT_VERSION } });
          continue;
        }
        try {
          const priorGap = prior ? recordProofEvent('prior-gap', context, domainId, proposal.operationId, {
            priorFingerprint: dirtyFingerprint(prior), priorReason: prior.reason_code,
            priorOperationId: prior.operation_id ?? null, requestSequence: binding.requestSequence, method: proposal.method }) : null;
          if (priorGap?.conflict || priorGap?.unprovable) continue;
          recordProofEvent('dispatch', context, domainId, proposal.operationId, {
            featureId: proposal.featureId, scope: proposal.scope,
            requestSequence: binding.requestSequence, method: proposal.method, wireKey: binding.wireKey,
            paramsFingerprint: strictText(proposal.paramsFingerprint),
            priorGap: !!prior, priorFingerprint: prior ? dirtyFingerprint(prior) : null,
            priorGapRef: priorGap?.ref ?? null,
            dirtyFingerprint: dirtyFingerprint(dirty(context, domainId)),
            baselineRef: proofRef('baseline', axes, null) });
        } catch {
          // A failed shadow write is a proof storage failure; latch it, but never block
          // dispatch or change the send/STOP policy.
          degradeProofStore('PROOF_DISPATCH_WRITE_FAILED');
        }
      }
    });
    emitSafely({ context, eventType: 'domain-write-barrier', traceId: proposal.traceId || proposal.operationId,
      operationId: proposal.operationId, outcomeState: 'may-have-changed', attempted: true,
      runEpoch: context.runEpoch, connectionEpoch: context.connectionEpoch, phase: 'before-byte-send', method: proposal.method,
      detail: { domains, requestSequence: binding.requestSequence, wireKey: binding.wireKey } });
    return domains;
  }
  function observe({ context, observation, coverage = [], acceptedLandObservation = false } = {}) {
    if (!validContext(context) || !observation || !sameContext(context, observation.context || context) ||
        observation.connectionEpoch !== context.connectionEpoch || !isCurrent(context)) return { accepted: false, reasonCode: 'DYNAMIC_OBSERVATION_CONTEXT_STALE' };
    if (observation.source === 'late' || observation.source === 'push' || observation.transport === 'push') {
      const everyDomain = Object.keys(DYNAMIC_DOMAIN_MANIFEST).filter(domain => DYNAMIC_DOMAIN_MANIFEST[domain].dynamic);
      const fullSync = observation.method === 'index.login' || isNormalSyncMethod(observation.method);
      const methodDomains = !fullSync && typeof observation.method === 'string'
        ? METHOD_OBSERVATION_DOMAINS[observation.method] || METHOD_DOMAINS[observation.method] || READ_SOURCE_DOMAINS[observation.method] || null
        : null;
      const pathDomains = unorderedObservationDomains(observation.value);
      // Full synchronisation frames may carry anything; a recognised action or
      // wire field narrows the invalidation to what the frame can actually
      // touch. Unrecognised frames keep the conservative whole-domain fallback
      // instead of silently leaving a changed domain looking current.
      const domains = fullSync ? everyDomain : methodDomains?.length ? [...new Set(methodDomains)]
        : pathDomains.length ? pathDomains : everyDomain;
      const attribution = fullSync ? 'full-sync' : methodDomains?.length ? 'method' : pathDomains.length ? 'wire-paths' : 'unrecognised-fallback';
      transaction(() => { for (const domainId of domains) markDirty(context, domainId, 'UNORDERED_PUSH_OR_LATE_OBSERVATION'); });
      emitSafely({ context, eventType: 'dynamic-domain-dirty', traceId: observation.responseRef || newId(), operationId: null,
        outcomeState: 'dirty', attempted: false, runEpoch: context.runEpoch, connectionEpoch: context.connectionEpoch,
        phase: 'observation', method: observation.method || null, errorCode: 'UNORDERED_PUSH_OR_LATE_OBSERVATION',
        detail: { domains, attribution } });
      notifySafely(context, domains);
      return { accepted: true, dirty: domains, attribution, reasonCode: 'UNORDERED_PUSH_OR_LATE_OBSERVATION' };
    }
    if (observation.transport !== 'answered' || observation.source !== 'response' || observation.envelopeOk !== true ||
        observation.dsName !== 'G.ISyncData' || observation.rejected === true || observation.connectionEpoch !== context.connectionEpoch ||
        !POSITIVE(observation.requestSequence) || typeof observation.responseRef !== 'string' || !observation.responseRef) {
      return { accepted: false, reasonCode: 'DYNAMIC_OBSERVATION_NOT_MATCHED_RESPONSE' };
    }
    if (!Array.isArray(coverage)) throw new TypeError('Dynamic domain coverage must be a list');
    const sourceKind = observation.method === 'index.login' ? 'login' : 'response';
    const operationRow = observation.operationId ? get(`SELECT feature_id,scope,method,params_fingerprint,owner_ref,account_ref,subject_ref,
      run_epoch,connection_epoch,original_json,original_fingerprint FROM backend_operations WHERE operation_id=?`, observation.operationId) : null;
    const operationFeature = operationRow?.feature_id ?? null;
    const operationOriginal = operationRow?.original_json ? parseStored(operationRow.original_json, 'operation.original') : null;
    // Strict single-target binding (diagnostics only, never admission). Any
    // mismatch drops the candidate and the domain keeps the refresh path.
    const writeTarget = sourceKind === 'response' && observation.operationId && operationOriginal && operationRow
      ? landWriteTarget({ original: operationOriginal, operationRow, context, observation }) : null;
    // REVIEW 01: the original-bytes hash and the send permit row are per
    // response, not per domain; reading them once keeps a seven-domain write from
    // repeating the same two queries while every domain still gets its own
    // baseline/dirty chain read.
    const proofFacts = writeTarget ? proofResponseFacts(context, observation, operationRow) : null;
    // A sparse extension can prevent an inventory projection entirely. Retain
    // the diagnostic from this exact response even in that case, rather than
    // losing the reason together with the unavailable typed projection.
    if (writeTarget) {
      const inventoryCoverage = coverage.find(item => item.domainId === 'inventory') ??
        { domainId: 'inventory', complete: false, paths: [], semanticValue: {}, cellSources: {} };
      const effectCoverage = postWriteCoverage({ domainId: 'inventory', item: inventoryCoverage, observation, target: writeTarget });
      if (effectCoverage) recordEvent('w6-inventory-effects:' + fingerprint([context, observation.responseRef, effectCoverage]),
        'write-inventory-effects', context, ['inventory'], [], {
          version: 'land-write-inventory-effects/v1', operationId: observation.operationId,
          originalFingerprint: operationRow.original_fingerprint, responseRef: observation.responseRef,
          requestSequence: observation.requestSequence, wireKey: observation.wireKey ?? null,
          coverage: effectCoverage, admission: 'none' });
    }
    const waterwheelOperation = operationFeature === 'waterwheel' && ['waterwheel.recv', 'waterwheel.skip', 'usr.share'].includes(observation.method);
    const albumPreparationRow = operationFeature === 'art.first-album' && observation.operationId ? get(`SELECT kind,source,payload_json,payload_fingerprint,observed_at
      FROM backend_operation_evidence WHERE operation_id=? AND evidence_key='finite-domain-preparation:v1' AND kind='finite-domain-preparation'
      AND source='backend/write-gateway/v2'`, observation.operationId) : null;
    const albumAdmittedRow = operationFeature === 'art.first-album' && observation.operationId ? get(`SELECT kind,source,payload_json,payload_fingerprint,observed_at
      FROM backend_operation_evidence WHERE operation_id=? AND evidence_key='admitted-operation-contract:v1' AND kind='admitted-operation-contract'
      AND source='backend/write-gateway/v2'`, observation.operationId) : null;
    let albumPreparedEvidence = null, albumAdmittedEvidence = null;
    try {
      if (albumPreparationRow) {
        const payload = parseStored(albumPreparationRow.payload_json, 'album finite preparation');
        if (ledgerJsonFingerprint({ kind: albumPreparationRow.kind, source: albumPreparationRow.source, payload, observedAt: albumPreparationRow.observed_at }) ===
            albumPreparationRow.payload_fingerprint) albumPreparedEvidence = payload;
      }
      if (albumAdmittedRow) {
        const payload = parseStored(albumAdmittedRow.payload_json, 'album admitted contract');
        if (ledgerJsonFingerprint({ kind: albumAdmittedRow.kind, source: albumAdmittedRow.source, payload, observedAt: albumAdmittedRow.observed_at }) ===
            albumAdmittedRow.payload_fingerprint) albumAdmittedEvidence = payload;
      }
    } catch { /* corrupted immutable evidence keeps the one action unaccepted */ }
    const albumAction = albumPreparedEvidence?.domain === 'art-first-album' ? albumPreparedEvidence.preparation : null,
      albumExtension = albumAction?.extension,
      albumExtensionBody = albumExtension && Object.fromEntries(Object.entries(albumExtension).filter(([key]) => key !== 'extensionRef')),
      albumContract = albumAdmittedEvidence;
    const artAlbumOperation = acceptedLandObservation === true && operationFeature === 'art.first-album' &&
      observation.method === 'collectRwd.recvArtCreateRwdByVase' && operationRow.owner_ref === context.ownerRef &&
      operationRow.account_ref === String(context.accountRef) && operationRow.subject_ref === context.subjectRef &&
      hashLedgerBytes(operationRow.original_json) === operationRow.original_fingerprint && operationOriginal?.featureId === 'art.first-album' &&
      operationOriginal?.scope === 'vase-album-recv' && operationOriginal?.method === observation.method &&
      albumAdmittedEvidence?.domain === 'art-first-album' && albumContract?.contractId === 'art-first-album/by-vase/v1' &&
      albumContract?.featureId === 'art.first-album' && albumContract?.scope === 'vase-album-recv' && albumContract?.method === observation.method &&
      operationOriginal?.ownerEpoch === context.ownerEpoch &&
      operationRow.run_epoch === context.runEpoch && operationRow.connection_epoch === context.connectionEpoch &&
      operationOriginal?.operationId === observation.operationId && typeof albumAction?.extensionRef === 'string' &&
      albumExtension?.extensionRef === albumAction?.extensionRef && albumExtension?.extensionRef === 'sha256:' + fingerprint(albumExtensionBody) &&
      albumExtension?.loginResponseRef === albumAction?.loginResponseRef && albumExtension?.baseDataSnapshotId === albumAction?.dataSnapshotId;
    const freeWaterScope = observation.method === 'freeWater.recv' ? 'free-water-recv' : observation.method === 'usr.share' ? 'free-water-fallback' : null;
    const freeWaterOperation = acceptedLandObservation === true && operationFeature === 'free-water' && !!freeWaterScope &&
      operationRow.owner_ref === context.ownerRef && operationRow.account_ref === String(context.accountRef) &&
      operationRow.subject_ref === context.subjectRef && hashLedgerBytes(operationRow.original_json) === operationRow.original_fingerprint &&
      operationOriginal?.ownerEpoch === context.ownerEpoch &&
      operationRow.run_epoch === context.runEpoch && operationRow.connection_epoch === context.connectionEpoch &&
      operationOriginal?.operationId === observation.operationId && operationOriginal?.featureId === 'free-water' &&
      operationOriginal?.method === observation.method && operationOriginal?.scope === freeWaterScope;
    const rackScope = FLOWER_RACK_SOURCE_SCOPES[observation.method];
    const flowerRackOperation = acceptedLandObservation === true && operationFeature === 'flower-rack' && !!rackScope &&
      operationRow.owner_ref === context.ownerRef && operationRow.account_ref === String(context.accountRef) &&
      operationRow.subject_ref === context.subjectRef && hashLedgerBytes(operationRow.original_json) === operationRow.original_fingerprint &&
      operationOriginal?.ownerEpoch === context.ownerEpoch &&
      operationRow.run_epoch === context.runEpoch && operationRow.connection_epoch === context.connectionEpoch &&
      operationOriginal?.operationId === observation.operationId && operationOriginal?.method === observation.method &&
      operationOriginal?.featureId === 'flower-rack' && operationOriginal?.scope === rackScope;
    const specialDefinition = Object.values(SPECIAL_ORDER_DEFINITIONS).find(one => one.method === observation.method && one.featureId === operationFeature);
    const specialOrderOperation = acceptedLandObservation === true && !!specialDefinition && operationRow.owner_ref === context.ownerRef &&
      operationRow.account_ref === String(context.accountRef) && operationRow.subject_ref === context.subjectRef &&
      hashLedgerBytes(operationRow.original_json) === operationRow.original_fingerprint && operationOriginal?.ownerEpoch === context.ownerEpoch &&
      operationRow.run_epoch === context.runEpoch && operationRow.connection_epoch === context.connectionEpoch &&
      operationOriginal?.operationId === observation.operationId && operationOriginal?.method === observation.method &&
      operationOriginal?.scope === specialDefinition.scope;
    const specialOrderRead = observation.method === 'orderPalace.enter' && !observation.operationId;
    const waterwheelEnterRead = observation.method === 'waterwheel.enter' && !observation.operationId;
    const freeWaterObservationDomains = Object.freeze(['free-water', 'free-water-share', 'free-water-item', 'customer-eligibility', 'profile']);
    const flowerRackObservationDomains = Object.freeze(['flower-rack', 'inventory', 'profile']);
    const albumObservationDomains = Object.freeze(['art-album', 'art-inputs', 'art-share', 'profile', 'customer-eligibility']);
    // A bounded mail-list read publishes only the mail domain; it is neither a
    // normal sync nor a business write, so name it explicitly.
    const mailListRead = observation.method === 'mail.getList' && !observation.operationId &&
      observation.source === 'response' && observation.transport === 'answered';
    const rewardOperation = sourceKind === 'response' && observation.operationId && typeof operationFeature === 'string' &&
      Boolean(REWARD_AFFECTED_DOMAINS[operationFeature]?.[observation.method]);
    const rewardObservationDomains = rewardOperation ? REWARD_AFFECTED_DOMAINS[operationFeature][observation.method] : [];
    const allowedDomains = artAlbumOperation ? [...new Set([...domainsForObservation(observation), ...albumObservationDomains])] :
      flowerRackOperation ? [...new Set([...domainsForObservation(observation), ...flowerRackObservationDomains])] :
      freeWaterOperation ? [...new Set([...domainsForObservation(observation), ...freeWaterObservationDomains])] : waterwheelOperation || waterwheelEnterRead
      ? [...new Set([...domainsForObservation(observation), ...WATERWHEEL_SOURCE_DOMAINS])]
      : rewardOperation ? [...new Set([...domainsForObservation(observation), ...rewardObservationDomains])] : domainsForObservation(observation);
    const loginUid = sourceKind === 'login' && observation.currentIdentity?.verified === true &&
      observation.currentIdentity.responseRef === observation.responseRef ? observation.currentIdentity.officialUid : null;
    let rawValueFingerprint = null, loginProofFingerprint = null, loginAnchor = null;
    if (sourceKind === 'login') {
      const wireUid = loginUidOf(observation);
      rawValueFingerprint = rawLoginFingerprint(observation);
      loginProofFingerprint = verifiedLoginProofFingerprint(context, observation, loginUid);
      loginAnchor = dynamicResponseAnchor(context, observation.responseRef);
      const wirePattern = new RegExp('^ws\\|\\d+\\|' + observation.requestSequence + '$');
      if (!POSITIVE(loginUid) || wireUid !== loginUid || !rawValueFingerprint || typeof observation.wireKey !== 'string' ||
          observation.wireKey.length > 128 || !wirePattern.test(observation.wireKey)) {
        throw problem('DYNAMIC_LOGIN_RAW_ANCHOR_INVALID', '当前登录缺少可核的原始响应指纹或UID', 409,
          { domainId: null, difference: 'login-identity-or-raw-fingerprint-invalid' });
      }
      if (loginAnchor) {
        const sameAxes = loginAnchor.owner_ref === context.ownerRef && loginAnchor.account_ref === String(context.accountRef) &&
          loginAnchor.subject_ref === context.subjectRef && loginAnchor.owner_epoch === context.ownerEpoch &&
          loginAnchor.run_epoch === context.runEpoch && loginAnchor.connection_epoch === context.connectionEpoch &&
          loginAnchor.response_ref === observation.responseRef && loginAnchor.method === observation.method &&
          loginAnchor.request_sequence === observation.requestSequence && loginAnchor.wire_key === observation.wireKey &&
          loginAnchor.official_uid === loginUid;
        if (!sameAxes || loginAnchor.raw_value_fingerprint !== rawValueFingerprint) {
          throw problem('DYNAMIC_RAW_RESPONSE_CONFLICT', '相同登录响应引用的原始响应或身份请求轴不一致', 409,
            { domainId: null, difference: !sameAxes ? 'identity-or-request-axis-changed' : 'raw-value-fingerprint-changed',
              storedRawFingerprint: loginAnchor.raw_value_fingerprint, currentRawFingerprint: rawValueFingerprint });
        }
      } else if (hasDynamicHeadForResponse(context, observation.responseRef)) {
        emitSafely({ context, eventType: 'dynamic-domain-dirty', traceId: observation.responseRef, operationId: null,
          outcomeState: 'incomplete', attempted: false, runEpoch: context.runEpoch, connectionEpoch: context.connectionEpoch,
          phase: 'observation', method: observation.method, errorCode: 'DYNAMIC_RESPONSE_REF_BASELINE_MISSING',
          detail: { responseRef: observation.responseRef, reason: 'historical-raw-fingerprint-unavailable' } });
        return { accepted: false, reasonCode: 'DYNAMIC_RESPONSE_REF_BASELINE_MISSING' };
      }
    }
    const establishedUid = sourceKind === 'login' ? get(`SELECT semantic_fingerprint FROM backend_dynamic_domain_cells
      WHERE owner_ref=? AND subject_ref=? AND domain_id='profile' AND path='profile.uid'`, context.ownerRef, context.subjectRef) : null;
    if (establishedUid && (!Number.isSafeInteger(loginUid) || loginUid <= 0 || establishedUid.semantic_fingerprint !== fingerprint(loginUid))) {
      return { accepted: false, reasonCode: 'DYNAMIC_STABLE_UID_MISMATCH' };
    }
    const published = [], unresolved = [];
    // Bounded per response: at most the seven proof domains get a continuity read.
    let proofContinuityReads = 0;
    transaction(() => {
      if (sourceKind === 'login' && !loginAnchor && coverage.length) {
        const anchorRef = 'dynamic-response-anchor:' + fingerprint([context.ownerRef, context.subjectRef,
          context.connectionEpoch, observation.responseRef]);
        run(`INSERT OR IGNORE INTO backend_dynamic_response_anchors VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, anchorRef,
          context.ownerRef, String(context.accountRef), context.subjectRef, context.ownerEpoch, context.runEpoch,
          context.connectionEpoch, observation.responseRef, observation.method, observation.requestSequence,
          observation.wireKey, loginUid, rawValueFingerprint, nowIso());
      }
      for (const item of coverage) {
        const policy = item && DYNAMIC_DOMAIN_MANIFEST[item.domainId];
        if (!item || !policy || typeof item.complete !== 'boolean' || !Array.isArray(item.paths) || !item.paths.length ||
            item.paths.some(path => typeof path !== 'string') || item.complete && !policy.requiredPaths.every(path => item.paths.includes(path)) ||
            !item.semanticValue || item.semanticFingerprint !== fingerprint(item.semanticValue) || !item.cellSources ||
            !['login', 'response', 'sync', 'read'].includes(item.sourceKind || sourceKind) ||
            !(observation.method === 'index.login' || isNormalSyncMethod(observation.method) ||
              observation.operationId && isLandAccelerationMethod(observation.method) || waterwheelOperation || freeWaterOperation || flowerRackOperation ||
              artAlbumOperation || waterwheelEnterRead || specialOrderOperation || specialOrderRead || mailListRead || rewardOperation) || !allowedDomains.includes(item.domainId)) {
          throw problem('DYNAMIC_COVERAGE_INVALID', '事实投影未提供完整覆盖声明', 500,
            { domainId: typeof item?.domainId === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(item.domainId) ? item.domainId : null });
        }
        const replaceCollections = item.replaceCollections ?? [];
        const allowedReplacementCollections = new Set(['inventory.bag.items', 'inventory.itemExt.items',
          'order-flower-card-video.card', 'order-flower-card-noble.card']);
        if (!Array.isArray(replaceCollections) || replaceCollections.some(prefix => !allowedReplacementCollections.has(prefix)) ||
            replaceCollections.length && (!item.complete || replaceCollections.some(prefix => {
              if (prefix.startsWith('inventory.bag.')) return item.domainId !== 'inventory' || !item.paths.includes('inventory.bag.complete');
              if (prefix.startsWith('inventory.itemExt.')) return item.domainId !== 'inventory' || !item.paths.includes('inventory.itemExt.complete');
              const [domainId, collection] = prefix.split('.');
              return item.domainId !== domainId || collection !== 'card' || !item.paths.includes(domainId + '.card.present') ||
                item.semanticValue[domainId + '.card.present'] !== false;
            }))) {
          throw problem('DYNAMIC_COLLECTION_REPLACEMENT_INVALID', '集合替换声明不符合完整绝对资源快照合同', 500);
        }
        const domainId = item.domainId, previous = head(context, domainId), barrier = dirty(context, domainId);
        const sameResponseProjection = previous?.source_ref === observation.responseRef && previous.owner_epoch === context.ownerEpoch &&
          previous.run_epoch === context.runEpoch && previous.connection_epoch === context.connectionEpoch;
        if (sameResponseProjection) {
          const priorProjections = all(`SELECT * FROM backend_dynamic_projection_receipts WHERE owner_ref=? AND subject_ref=? AND
            connection_epoch=? AND response_ref=? AND domain_id=? ORDER BY recorded_at DESC,receipt_ref DESC`,
          context.ownerRef, context.subjectRef, context.connectionEpoch, observation.responseRef, domainId);
          const requestedPaths = new Set(item.paths), storedCells = all(`SELECT path,account_ref,owner_epoch,run_epoch,connection_epoch,
            source_ref,source_method,request_sequence,observed_at_ms,observed_monotonic_ms,instance_ref,semantic_fingerprint
            FROM backend_dynamic_domain_cells WHERE owner_ref=? AND subject_ref=? AND domain_id=? AND source_ref=? AND
            owner_epoch=? AND run_epoch=? AND connection_epoch=?`, context.ownerRef, context.subjectRef, domainId, observation.responseRef,
          context.ownerEpoch, context.runEpoch, context.connectionEpoch);
          const sourceAnchor = storedCells[0] ?? null;
          const storedByPath = new Map(storedCells.map(one => [one.path, one]));
          const changedPaths = [], addedPaths = [];
          for (const path of item.paths) {
            const stored = get(`SELECT path,account_ref,owner_epoch,run_epoch,connection_epoch,source_ref,source_method,request_sequence,
              observed_at_ms,observed_monotonic_ms,instance_ref,semantic_fingerprint
              FROM backend_dynamic_domain_cells WHERE owner_ref=? AND subject_ref=? AND domain_id=? AND path=?`,
            context.ownerRef, context.subjectRef, domainId, path);
            const source = item.cellSources[path];
            if (!stored || stored.account_ref === String(context.accountRef) &&
                stored.owner_epoch <= context.ownerEpoch && stored.run_epoch <= context.runEpoch &&
                stored.connection_epoch <= context.connectionEpoch &&
                (stored.owner_epoch < context.ownerEpoch || stored.run_epoch < context.runEpoch || stored.connection_epoch < context.connectionEpoch)) {
              addedPaths.push(path); continue;
            }
            if (stored.source_ref !== source?.sourceRef || stored.source_method !== source?.method ||
                stored.account_ref !== String(context.accountRef) || stored.owner_epoch !== context.ownerEpoch ||
                stored.run_epoch !== context.runEpoch ||
                stored.request_sequence !== source?.requestSequence || stored.connection_epoch !== source?.connectionEpoch ||
                stored.observed_at_ms !== source?.observedAtMs || stored.observed_monotonic_ms !== source?.observedMonotonicMs ||
                stored.instance_ref !== instanceRef ||
                stored.semantic_fingerprint !== fingerprint(item.semanticValue[path])) changedPaths.push(path);
          }
          const removedPaths = storedCells.map(one => one.path).filter(path => !requestedPaths.has(path));
          const completenessChanged = Number(previous.complete) !== Number(item.complete);
          const storedPathList = storedCells.map(one => one.path).sort();
          const priorProjection = priorProjections.find(receipt => {
            const paths = parseStored(receipt.paths_json, '动态投影覆盖路径');
            return Array.isArray(paths) && paths.length === storedPathList.length &&
              paths.every((path, index) => path === storedPathList[index]);
          }) ?? null;
          const priorPaths = priorProjection ? parseStored(priorProjection.paths_json, '动态投影覆盖路径') : null;
          const rawAnchorMatches = loginAnchor && loginAnchor.raw_value_fingerprint === rawValueFingerprint &&
            loginAnchor.official_uid === loginUid && loginAnchor.method === observation.method &&
            loginAnchor.request_sequence === observation.requestSequence && loginAnchor.wire_key === observation.wireKey &&
            loginAnchor.owner_epoch === context.ownerEpoch && loginAnchor.run_epoch === context.runEpoch &&
            loginAnchor.connection_epoch === context.connectionEpoch;
          const receiptMatches = priorProjection && priorProjection.owner_ref === context.ownerRef &&
            priorProjection.account_ref === String(context.accountRef) && priorProjection.subject_ref === context.subjectRef &&
            priorProjection.owner_epoch === context.ownerEpoch && priorProjection.run_epoch === context.runEpoch &&
            priorProjection.connection_epoch === context.connectionEpoch && priorProjection.response_ref === observation.responseRef &&
            priorProjection.domain_id === domainId && priorProjection.request_sequence === observation.requestSequence &&
            priorProjection.wire_key === observation.wireKey && priorProjection.official_uid === loginUid &&
            priorProjection.raw_value_fingerprint === rawValueFingerprint && Array.isArray(priorPaths) &&
            priorPaths.length === storedPathList.length && priorPaths.every((path, index) => path === storedPathList[index]);
          const proofAdvanced = loginProofFingerprint && receiptMatches && priorProjection.source_proof_fingerprint !== loginProofFingerprint;
          const sourceAnchorStable = sourceAnchor && storedCells.every(cell => cell.observed_at_ms === sourceAnchor.observed_at_ms &&
            cell.observed_monotonic_ms === sourceAnchor.observed_monotonic_ms && cell.instance_ref === sourceAnchor.instance_ref) &&
            sourceAnchor.observed_at_ms === observation.receivedDeviceMs && sourceAnchor.observed_monotonic_ms === observation.receivedMonotonicMs &&
            sourceAnchor.instance_ref === instanceRef;
          const exactSubsetReplay = removedPaths.length > 0 && changedPaths.length === 0 && addedPaths.length === 0 &&
            !completenessChanged && replaceCollections.length === 0 && sourceKind === 'login' && !!rawAnchorMatches &&
            !!receiptMatches && !!sourceAnchorStable;
          if (exactSubsetReplay) continue;
          if (changedPaths.length || removedPaths.length || previous.complete === 1 && !item.complete) {
            throw problem('DYNAMIC_RESPONSE_REF_CONFLICT', '相同官服响应引用的已发布事实值、来源或集合发生变化', 409,
              { domainId, changedPaths: changedPaths.slice(0, 64).map(path => ({ path,
                storedFingerprint: storedByPath.get(path)?.semantic_fingerprint ?? null,
                currentFingerprint: fingerprint(item.semanticValue[path]) })), removedPaths: removedPaths.slice(0, 64),
                replacementRequested: false });
          }
          const projectionExtends = addedPaths.length > 0 || completenessChanged;
          if (!projectionExtends) continue;
          if (sourceKind !== 'login' || !rawAnchorMatches || !receiptMatches || !proofAdvanced || !sourceAnchorStable) {
            throw problem('DYNAMIC_RESPONSE_REF_BASELINE_MISSING', '相同登录响应的新增事实缺少已验证原文锚或兼容证明修订', 409,
              { domainId, addedPaths: addedPaths.slice(0, 64), completenessChanged, rawAnchorMatches: !!rawAnchorMatches,
                priorProjectionReceiptAvailable: !!priorProjection, priorProjectionMatches: !!receiptMatches, proofAdvanced: !!proofAdvanced,
                sourceAnchorStable: !!sourceAnchorStable });
          }
          for (const path of addedPaths) {
            item.cellSources[path].observedAtMs = sourceAnchor.observed_at_ms;
            item.cellSources[path].observedMonotonicMs = sourceAnchor.observed_monotonic_ms;
          }
        }
        if (previous && previous.connection_epoch === observation.connectionEpoch &&
            Number.isSafeInteger(previous.request_sequence) && observation.requestSequence <= previous.request_sequence && previous.source_ref !== observation.responseRef) {
          unresolved.push(domainId); continue;
        }
        const newEpochLogin = sourceKind === 'login' && observation.connectionEpoch > (barrier?.connection_epoch ?? 0) &&
          barrier?.owner_epoch <= context.ownerEpoch && loginUid !== null && Number.isSafeInteger(loginUid) && loginUid > 0;
        // R8 permits only the value-bound land certificate below. Other domains
        // retain their barriers unless independently proved by a later login.
        const writeProofCandidate = writeTarget ? postWriteCoverage({ domainId, item, observation, target: writeTarget }) : null;
        if (writeProofCandidate) recordEvent('w6-fields:' + fingerprint([context, observation.responseRef, domainId, writeProofCandidate]),
          'write-field-coverage', context, [domainId], [], {
            version: 'land-write-field-coverage/v1', operationId: observation.operationId,
            originalFingerprint: operationRow.original_fingerprint, responseRef: observation.responseRef,
            requestSequence: observation.requestSequence, wireKey: observation.wireKey ?? null,
            coverage: writeProofCandidate, admission: 'none' });
        if (writeProofCandidate) emitSafely({ context, eventType: 'domain-write-field-coverage',
          traceId: observation.responseRef, operationId: observation.operationId,
          outcomeState: writeProofCandidate.proven === true ? 'coverage-proven' : 'coverage-unproven', attempted: false,
          // The log layer keeps only its whitelisted detail keys, so the verdict and
          // the gap list are carried in keys that actually reach the row instead of
          // only in keys a reader would never see. Full receipts stay in
          // backend_dynamic_refresh_events.receipt_json.
          errorCode: writeProofCandidate.proven === true ? null
            : String(writeProofCandidate.gaps[0] ?? 'FIELD_COVERAGE_UNPROVEN').slice(0, 128),
          runEpoch: context.runEpoch, connectionEpoch: context.connectionEpoch, phase: 'post-write-proof', method: observation.method,
          detail: { resultKind: 'field-coverage', domainId, ok: writeProofCandidate.proven === true,
            missing: writeProofCandidate.gaps.slice(0, 8),
            passed: writeProofCandidate.paths.slice(0, 16), contractVersion: PROOF_CONTRACT_VERSION,
            claimedDomains: [domainId], allDomainsCurrent: false,
            basis: writeProofCandidate.basis, admission: writeProofCandidate.admission,
            proven: writeProofCandidate.proven === true,
            ...(writeProofCandidate.detail ? { detail: writeProofCandidate.detail } : {}),
            requestSequence: observation.requestSequence } });
        let continuity=null;
        if (writeTarget && PROOF_DOMAINS.has(domainId) && proofContinuityReads < PROOF_DOMAIN_LIMIT) {
          proofContinuityReads += 1;
          try { continuity = proofContinuity(context, domainId, observation, item,
            proofRef('dispatch', proofAxes(context, domainId), observation.operationId), proofFacts); }
          catch (error) {
            degradeProofStore('PROOF_CONTINUITY_READ_FAILED');
            continuity = { resultKind: 'chain-continuity', domainId, proven: false, code: 'CONTINUITY_DIAGNOSTIC_UNAVAILABLE',
              gaps: [String(error?.code || 'QUERY_FAILED').slice(0, 64)], requestSequence: observation.requestSequence,
              claimedDomains: [domainId], allDomainsCurrent: false };
          }
          emitSafely({ context, eventType: 'domain-write-chain-continuity', traceId: observation.responseRef,
            operationId: observation.operationId, outcomeState: continuity.proven ? 'proven' : 'unprovable', attempted: false,
            runEpoch: context.runEpoch, connectionEpoch: context.connectionEpoch, phase: 'post-write-proof', method: observation.method,
            errorCode: continuity.code ?? null,
            detail: { admission: 'none', ok: continuity.proven === true, contractVersion: PROOF_CONTRACT_VERSION,
              missing: continuity.gaps, ...continuity } });
        }
        let landCertificate=null;
        if (domainId==='land' && barrier && writeTarget && item.complete) {
          landCertificate=landValueCertificate(context,observation,writeTarget,writeProofCandidate,continuity,proofFacts,operationRow,barrier);
          if (landCertificate) recordEvent('w6-land:'+fingerprint(landCertificate),'write-certificate',context,['land'],[],landCertificate);
        }
        let inventoryCertificate = null;
        if (domainId === 'inventory' && ['plant','water'].includes(writeTarget?.featureId) && barrier && item.complete &&
            (writeTarget.featureId !== 'plant' || writeProofCandidate?.basis === 'inventory-plant-no-update/v1' &&
              previous?.semantic_fingerprint === fingerprint([...item.paths].sort().map(path => [path, fingerprint(item.semanticValue[path])])))) {
          inventoryCertificate = landValueCertificate(context, observation, writeTarget, writeProofCandidate,
            continuity, proofFacts, operationRow, barrier, 'inventory');
          if (inventoryCertificate) recordEvent('w6-inventory:' + fingerprint(inventoryCertificate),
            'write-certificate', context, ['inventory'], [], inventoryCertificate);
        }
        let unchangedCertificate = null;
        if (['profile','cultivation','land-top'].includes(domainId) && ['plant','water'].includes(writeTarget?.featureId) &&
            barrier && item.complete && writeProofCandidate?.basis === domainId + '-no-update/v1' &&
            previous?.semantic_fingerprint === fingerprint([...item.paths].sort().map(path => [path, fingerprint(item.semanticValue[path])]))) {
          unchangedCertificate = landValueCertificate(context, observation, writeTarget, writeProofCandidate,
            continuity, proofFacts, operationRow, barrier, domainId);
          if (unchangedCertificate) recordEvent('w6-unchanged:' + fingerprint(unchangedCertificate),
            'write-certificate', context, [domainId], [], unchangedCertificate);
        }
        // A matched read that causally follows the write (same connection, later
        // request sequence, or a newer connection) covers the domain with the
        // server's current state and is sufficient to retire its barrier. This is
        // required for domains whose only source is a specific read (mail list):
        // a login frame may never carry them.
        const newerReadCoverage = !!barrier && item.complete && sourceKind !== 'login' &&
          (observation.connectionEpoch > barrier.connection_epoch ||
            observation.connectionEpoch === barrier.connection_epoch && Number.isInteger(observation.requestSequence) &&
            Number.isInteger(barrier.request_sequence) && observation.requestSequence > barrier.request_sequence);
        const clearsBarrier = item.complete && (!barrier || newEpochLogin || newerReadCoverage ||
          !!landCertificate || !!inventoryCertificate || !!unchangedCertificate);
        const maxAge = DYNAMIC_DOMAIN_MANIFEST[domainId].maxAgeMs ?? defaultMaxAgeMs;
        if (item.maxAgeMs !== undefined && item.maxAgeMs !== maxAge) throw problem('DYNAMIC_FRESHNESS_POLICY_INVALID', '投影不能延长事实域新鲜期', 500);
        if (!POSITIVE(maxAge)) throw problem('DYNAMIC_FRESHNESS_POLICY_INVALID', '事实域最大新鲜期无效', 500);
        const cellProvenance = item.paths.map(path => item.cellSources[path]);
        if (item.paths.some((path, index) => !Object.hasOwn(item.semanticValue, path) || !cellProvenance[index] ||
            typeof cellProvenance[index].sourceRef !== 'string' || !cellProvenance[index].sourceRef ||
            cellProvenance[index].connectionEpoch !== context.connectionEpoch || !POSITIVE(cellProvenance[index].requestSequence) ||
            !Number.isSafeInteger(cellProvenance[index].observedAtMs) || cellProvenance[index].observedAtMs < 0 ||
            !Number.isFinite(cellProvenance[index].observedMonotonicMs) ||
            cellProvenance[index].observedMonotonicMs < 0 || cellProvenance[index].observedMonotonicMs > monotonicNow())) {
          throw problem('DYNAMIC_TYPED_CELL_PROVENANCE_INVALID', 'typed单元缺少精确来源代际或到达时间', 500);
        }
        const observedAt = Math.min(...cellProvenance.map(one => one.observedAtMs));
        for (const prefix of sameResponseProjection ? [] : replaceCollections) {
          run(`DELETE FROM backend_dynamic_domain_cells WHERE owner_ref=? AND subject_ref=? AND domain_id=?
            AND substr(path,1,?)=?`, context.ownerRef, context.subjectRef, domainId, prefix.length + 1, prefix + '.');
        }
        for (const path of item.paths) {
          const source = item.cellSources[path];
          run(`INSERT INTO backend_dynamic_domain_cells(owner_ref,account_ref,subject_ref,domain_id,path,owner_epoch,run_epoch,connection_epoch,
            semantic_fingerprint,source_ref,source_method,request_sequence,observed_at_ms,updated_at,observed_monotonic_ms,instance_ref)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref,domain_id,path)
            DO UPDATE SET account_ref=excluded.account_ref,owner_epoch=excluded.owner_epoch,run_epoch=excluded.run_epoch,
            connection_epoch=excluded.connection_epoch,semantic_fingerprint=excluded.semantic_fingerprint,source_ref=excluded.source_ref,
            source_method=excluded.source_method,request_sequence=excluded.request_sequence,observed_at_ms=excluded.observed_at_ms,updated_at=excluded.updated_at,
            observed_monotonic_ms=excluded.observed_monotonic_ms,instance_ref=excluded.instance_ref`,
          context.ownerRef, String(context.accountRef), context.subjectRef, domainId, path, context.ownerEpoch, context.runEpoch,
          context.connectionEpoch, fingerprint(item.semanticValue[path]), source.sourceRef, source.method, source.requestSequence,
          source.observedAtMs, nowIso(), source.observedMonotonicMs, instanceRef);
        }
        const cellsNow = all(`SELECT path,semantic_fingerprint FROM backend_dynamic_domain_cells WHERE owner_ref=? AND subject_ref=? AND domain_id=?
          AND owner_epoch=? AND run_epoch=? AND connection_epoch=? ORDER BY path`, context.ownerRef, context.subjectRef, domainId,
        context.ownerEpoch, context.runEpoch, context.connectionEpoch);
        const aggregateSemantic = fingerprint(cellsNow.map(cell => [cell.path, cell.semantic_fingerprint]));
        const cellPaths = cellsNow.map(cell => cell.path);
        const semanticChanged = !previous || previous.semantic_fingerprint !== aggregateSemantic;
        const revision = Number(previous?.semantic_revision || 0) + Number(semanticChanged);
        run(`INSERT INTO backend_dynamic_domain_heads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref,domain_id)
          DO UPDATE SET account_ref=excluded.account_ref,owner_epoch=excluded.owner_epoch,run_epoch=excluded.run_epoch,
          connection_epoch=excluded.connection_epoch,semantic_revision=excluded.semantic_revision,semantic_fingerprint=excluded.semantic_fingerprint,
          coverage_json=excluded.coverage_json,source_ref=excluded.source_ref,source_kind=excluded.source_kind,source_method=excluded.source_method,
          request_sequence=excluded.request_sequence,observed_at_ms=excluded.observed_at_ms,next_check_at_ms=excluded.next_check_at_ms,updated_at=excluded.updated_at,
          complete=excluded.complete`,
        context.ownerRef, String(context.accountRef), context.subjectRef, domainId, context.ownerEpoch, context.runEpoch, context.connectionEpoch,
        revision, aggregateSemantic, canonical(cellPaths), observation.responseRef, item.sourceKind || sourceKind,
        observation.method, observation.requestSequence, observedAt, observedAt + maxAge, nowIso(), Number(item.complete));
        if (sourceKind === 'login') recordProjectionReceipt(context, observation, loginUid, rawValueFingerprint, loginProofFingerprint, item);
        if (sourceKind === 'login' && PROOF_DOMAINS.has(domainId)) {
          try { recordProofEvent('baseline', context, domainId, null, { requestSequence: observation.requestSequence,
            sourceKind: 'login', loginMethod: observation.method, loginResponseRef: observation.responseRef,
            loginWireKey: observation.wireKey ?? null, loginRawValueFingerprint: rawValueFingerprint ?? null,
            officialUid: Number.isSafeInteger(loginUid) && loginUid > 0 ? loginUid : null,
            complete: item.complete === true, semanticFingerprint: aggregateSemantic,
            pathCount: cellPaths.length, pathsTruncated: cellPaths.length > 64, paths: cellPaths.slice(0, 64) }); }
          catch { degradeProofStore('PROOF_BASELINE_WRITE_FAILED'); /* never blocks the login path */ }
        }
        if (clearsBarrier) {
          if (barrier) run(`DELETE FROM backend_dynamic_domain_dirty WHERE owner_ref=? AND subject_ref=? AND domain_id=? AND account_ref=?
            AND owner_epoch=? AND run_epoch=? AND connection_epoch=? AND reason_code=? AND request_sequence IS ? AND request_method IS ?`,
          context.ownerRef, context.subjectRef, domainId, String(barrier.account_ref), barrier.owner_epoch, barrier.run_epoch,
          barrier.connection_epoch, barrier.reason_code, barrier.request_sequence, barrier.request_method);
          // Shadow record of the existing new-epoch-login retirement only; this
          // is not a second DELETE branch and has no admission effect.
          if (barrier && newEpochLogin && PROOF_DOMAINS.has(domainId)) {
            // Continuous review 02: the reference preparation itself is inside the
            // isolation, so a failing diagnostic read cannot escape the login
            // transaction; it is recorded as unavailable and the existing
            // retirement behaviour is untouched.
            try {
              const barrierAxes = proofAxes({ ownerRef: barrier.owner_ref, accountRef: barrier.account_ref,
                subjectRef: barrier.subject_ref, ownerEpoch: barrier.owner_epoch, runEpoch: barrier.run_epoch,
                connectionEpoch: barrier.connection_epoch }, domainId);
              const oldDispatchRef = barrier.operation_id ? proofRef('dispatch', barrierAxes, barrier.operation_id) : null;
              const oldDispatch = oldDispatchRef ? readProofReceipt('dispatch', oldDispatchRef) : null;
              const oldDispatchCode = !barrier.operation_id ? 'BARRIER_OPERATION_ABSENT'
                : !barrierAxes ? 'BARRIER_AXES_INVALID'
                : !oldDispatchRef ? 'OLD_DISPATCH_KEY_UNPROVABLE'
                : !oldDispatch ? 'OLD_DISPATCH_EVENT_ABSENT' : null;
              recordProofEvent('retire', context, domainId, barrier.operation_id ?? null, {
                resultKind: 'barrier-retirement', barrierFingerprint: dirtyFingerprint(barrier), barrierReason: barrier.reason_code,
                retiredBy: 'new-epoch-login',
                retiredGeneration: { ownerRef: barrier.owner_ref, accountRef: String(barrier.account_ref),
                  subjectRef: barrier.subject_ref, ownerEpoch: barrier.owner_epoch, runEpoch: barrier.run_epoch,
                  connectionEpoch: barrier.connection_epoch },
                replacementGeneration: { ownerRef: context.ownerRef, accountRef: String(context.accountRef),
                  subjectRef: context.subjectRef, ownerEpoch: context.ownerEpoch, runEpoch: context.runEpoch,
                  connectionEpoch: context.connectionEpoch },
                generationsMerged: false,
                dispatchRef: oldDispatchRef,
                dispatchReference: oldDispatchCode ? 'unprovable' : 'resolved',
                dispatchUnprovableCode: oldDispatchCode,
                oldDispatchContractVersion: oldDispatch?.contractVersion ?? null,
                replacementBaselineRef: proofRef('baseline', proofAxes(context, domainId), null),
                replacementBaselineIdentity: 'new-epoch-login' });
            } catch (error) {
              degradeProofStore('PROOF_RETIRE_REFERENCE_FAILED');
              emitSafely({ context, eventType: 'domain-write-proof-event-unprovable', traceId: null,
                operationId: barrier.operation_id ?? null, outcomeState: 'unprovable', attempted: false,
                runEpoch: context.runEpoch, connectionEpoch: context.connectionEpoch, phase: 'post-write-proof',
                errorCode: 'RETIRE_REFERENCE_' + String(error?.code || 'QUERY_FAILED').slice(0, 48),
                detail: { kind: 'retire', domainId, resultKind: 'event-integrity' } });
            }
          }
          published.push(domainId);
        }
        else if (barrier || !item.complete) {
          if (!barrier) markDirty(context, domainId, 'DYNAMIC_DOMAIN_COVERAGE_INCOMPLETE', { requestSequence: observation.requestSequence });
          if (barrier && barrier.operation_id === observation.operationId && barrier.request_method === observation.method &&
              barrier.connection_epoch === observation.connectionEpoch && barrier.request_sequence === observation.requestSequence)
            emitSafely({ context, eventType: 'domain-write-barrier-retained', traceId: observation.responseRef,
              operationId: observation.operationId, outcomeState: 'retained', attempted: false, runEpoch: context.runEpoch,
              connectionEpoch: context.connectionEpoch, phase: 'post-write-proof', method: observation.method,
              errorCode: domainId==='land' && writeTarget ? writeTarget.workset?.reasonCode || 'W6_LAND_CERTIFICATE_UNPROVEN'
                : writeProofCandidate ? 'DOMAIN_WRITE_CERTIFICATE_UNAVAILABLE' : 'POST_WRITE_COVERAGE_UNPROVEN',
              detail: { domainId, requestSequence: observation.requestSequence, complete: item.complete === true } });
          unresolved.push(domainId);
        }
      }
      if (sourceKind === 'login' && Number.isSafeInteger(loginUid) && loginUid > 0 &&
          (loginProofFingerprint !== null || verifiedLegacyLoginAnchor(context, observation, loginUid))) {
        run(`INSERT OR IGNORE INTO backend_dynamic_login_identity_anchors(owner_ref,account_ref,subject_ref,owner_epoch,run_epoch,
          connection_epoch,response_ref,request_sequence,official_uid,game_version,protocol_version,recorded_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, context.ownerRef, String(context.accountRef), context.subjectRef, context.ownerEpoch,
        context.runEpoch, context.connectionEpoch, observation.responseRef, observation.requestSequence, loginUid,
        observation.versionEvidence?.gameVersion ?? null, observation.versionEvidence?.protocolVersion ?? null, nowIso());
      }
    });
    for (const domainId of published) clearRefreshRetry(context, domainId);
    if (published.length) notifySafely(context, published);
    return { accepted: true, published, unresolved };
  }
  function snapshot({ context, feature, config = null, method = null, proposal = null, extraDomains = [], at = 'assessment' } = {}) {
    if (!validContext(context) || !isCurrent(context)) return { current: false, reasonCode: 'DYNAMIC_CONTEXT_NOT_CURRENT', domains: [] };
    const required = consumedDomains(feature, config, method, proposal, extraDomains);
    const actionPaths = actionRequiredPaths(feature, config, method, proposal);
    return snapshotRequirements(context, required, actionPaths, at);
  }
  // Private entry point: every merged requirement originated in a validated
  // feature snapshot. A late join never borrows another feature's declaration.
  function snapshotRequirements(context, required, actionPaths, at = 'refresh-coverage') {
    if (!validContext(context) || !isCurrent(context)) return { current: false, reasonCode: 'DYNAMIC_CONTEXT_NOT_CURRENT', domains: [] };
    const now = deviceNow(), monotonic = monotonicNow();
    const domains = required.map(domainId => {
      const row = head(context, domainId), held = dirty(context, domainId), policy = DYNAMIC_DOMAIN_MANIFEST[domainId];
      const actionDomainPaths = actionPaths?.[domainId];
      if (Array.isArray(actionDomainPaths) && actionDomainPaths.length === 0) return { domainId, current: true,
        semanticRevision: row?.semantic_revision ?? 0, semanticFingerprint: fingerprint([]), sourceRef: null, sourceKind: null,
        method: null, requestSequence: null, observedAtMs: null, nextCheckAtMs: now, coverage: [], sourceProofs: [], dirty: null, reasonCode: null };
      const maxAge = policy.maxAgeMs ?? defaultMaxAgeMs;
      const cells = all(`SELECT * FROM backend_dynamic_domain_cells WHERE owner_ref=? AND subject_ref=? AND domain_id=?
        AND owner_epoch=? AND run_epoch=? AND connection_epoch=? ORDER BY path`, context.ownerRef, context.subjectRef, domainId,
      context.ownerEpoch, context.runEpoch, context.connectionEpoch);
      const allActiveCells = cells.filter(cell => cell.instance_ref === instanceRef);
      const patterns = actionDomainPaths;
      const activeCells = Array.isArray(patterns) ? allActiveCells.filter(cell => patterns.some(pattern => matchesRequiredPath(cell.path, pattern))) : allActiveCells;
      const missingRequired = Array.isArray(patterns) && patterns.some(pattern => !activeCells.some(cell => matchesRequiredPath(cell.path, pattern)) &&
        !(domainId === 'inventory' && pattern.includes('.items.') && activeCells.some(cell => cell.path === pattern.split('.items.')[0] + '.complete')));
      // Coverage-incomplete is a soft domain-wide summary emitted when some
      // other action's optional collection is absent. Scoped actions still
      // require every named cell below; write/push/identity barriers remain hard.
      const effectiveHeld = Array.isArray(patterns) && held?.reason_code === 'DYNAMIC_DOMAIN_COVERAGE_INCOMPLETE' ? null : held;
      const validCells = activeCells.filter(cell => cell.observed_monotonic_ms + maxAge > monotonic);
      const fresh = row && row.owner_epoch === context.ownerEpoch && row.run_epoch === context.runEpoch && row.connection_epoch === context.connectionEpoch &&
        validCells.length > 0 && validCells.length === activeCells.length && !missingRequired && !effectiveHeld &&
        (Array.isArray(patterns) || row.complete === 1);
      const semanticFingerprint = fingerprint(validCells.map(cell => [cell.path, cell.semantic_fingerprint]).sort(([left], [right]) => left.localeCompare(right)));
      const reasonCode = effectiveHeld?.reason_code || !row ? (effectiveHeld?.reason_code || 'DYNAMIC_DOMAIN_NOT_OBSERVED')
        : row.owner_epoch !== context.ownerEpoch || row.run_epoch !== context.runEpoch || row.connection_epoch !== context.connectionEpoch ? 'DYNAMIC_DOMAIN_CONNECTION_STALE'
        : !activeCells.length || missingRequired ? 'DYNAMIC_DOMAIN_COVERAGE_INCOMPLETE'
        : validCells.length !== activeCells.length ? 'DYNAMIC_DOMAIN_CELL_MAX_AGE_EXCEEDED'
        : !Array.isArray(patterns) && row.complete !== 1 ? 'DYNAMIC_DOMAIN_COVERAGE_INCOMPLETE' : null;
      const sourceProofs = [...new Map(validCells.map(cell => {
        const proof = { kind: cell.source_method === 'index.login' ? 'login' : 'response', method: cell.source_method,
          responseRef: cell.source_ref, requestSequence: cell.request_sequence, connectionEpoch: cell.connection_epoch,
          domainId, path: cell.path, semanticFingerprint: cell.semantic_fingerprint };
        return [canonical({ method: proof.method, responseRef: proof.responseRef, requestSequence: proof.requestSequence,
          connectionEpoch: proof.connectionEpoch }), proof];
      })).values()];
      return { domainId, current: !!fresh, semanticRevision: row?.semantic_revision ?? 0,
        semanticFingerprint,
        sourceRef: row?.source_ref ?? null, sourceKind: row?.source_kind ?? null, method: row?.source_method ?? null,
        requestSequence: row?.request_sequence ?? null, observedAtMs: validCells.length ? Math.min(...validCells.map(cell => cell.observed_at_ms)) : row?.observed_at_ms ?? null,
        nextCheckAtMs: validCells.length ? Math.ceil(deviceNow() + Math.max(0, Math.min(...validCells.map(cell => cell.observed_monotonic_ms + maxAge)) - monotonic)) : row?.next_check_at_ms ?? now,
        coverage: validCells.map(cell => cell.path),
        sourceProofs,
        dirty: effectiveHeld ? { reasonCode: effectiveHeld.reason_code, operationId: effectiveHeld.operation_id, requestSequence: effectiveHeld.request_sequence } : null,
        reasonCode };
    });
    return { current: domains.every(one => one.current), reasonCode: domains.find(one => !one.current)?.reasonCode ?? null,
      nextCheckAtMs: domains.length ? Math.min(...domains.map(one => one.nextCheckAtMs).filter(Number.isSafeInteger)) : null, domains, at };
  }
  function currentNeedSnapshot(input = {}) {
    const { context, feature, config = null, method = null, proposal = null, extraDomains = [] } = input;
    const state = snapshot({ context, feature, config, method, proposal, extraDomains, at: 'current-need' });
    if (!state.current) return { complete: false, reasonCode: state.reasonCode || 'DYNAMIC_CURRENT_NEED_FACTS_NOT_CURRENT',
      identityVerified: false, connectionEpoch: context?.connectionEpoch ?? null, sourceProofs: [] };
    const anchor = get(`SELECT * FROM backend_dynamic_login_identity_anchors WHERE owner_ref=? AND account_ref=? AND subject_ref=?
      AND owner_epoch=? AND run_epoch=? AND connection_epoch=? ORDER BY request_sequence DESC LIMIT 1`, context.ownerRef, String(context.accountRef),
    context.subjectRef, context.ownerEpoch, context.runEpoch, context.connectionEpoch);
    if (!anchor || anchor.official_uid < 1 ||
        !Number.isSafeInteger(anchor.request_sequence) || anchor.request_sequence < 1 || !anchor.response_ref ||
        !anchor.game_version || !anchor.protocol_version) return { complete: false, reasonCode: 'DYNAMIC_CURRENT_NEED_LOGIN_ANCHOR_MISSING',
      identityVerified: false, method: 'index.login', connectionEpoch: context.connectionEpoch, sourceProofs: [] };
    const sourceProofs = [{ kind: 'login', method: 'index.login', responseRef: anchor.response_ref,
      requestSequence: anchor.request_sequence, connectionEpoch: anchor.connection_epoch, officialUid: anchor.official_uid,
      gameVersion: anchor.game_version, protocolVersion: anchor.protocol_version }];
    for (const domain of state.domains) sourceProofs.push(...domain.sourceProofs);
    const unique = [...new Map(sourceProofs.map(one => [canonical({ method: one.method, responseRef: one.responseRef,
      requestSequence: one.requestSequence, connectionEpoch: one.connectionEpoch }), one])).values()]
      .sort((a, b) => a.connectionEpoch - b.connectionEpoch || a.requestSequence - b.requestSequence || a.responseRef.localeCompare(b.responseRef));
    return { complete: true, identityVerified: true, method: 'index.login', responseRef: anchor.response_ref,
      requestSequence: anchor.request_sequence, connectionEpoch: context.connectionEpoch, officialUid: anchor.official_uid,
      gameVersion: anchor.game_version, protocolVersion: anchor.protocol_version, sourceProofs: unique,
      snapshotFingerprint: fingerprint({ context: { ownerRef: context.ownerRef, subjectRef: context.subjectRef,
        ownerEpoch: context.ownerEpoch, runEpoch: context.runEpoch, connectionEpoch: context.connectionEpoch },
        domains: state.domains.map(one => ({ domainId: one.domainId, semanticFingerprint: one.semanticFingerprint,
          coverage: one.coverage, sourceProofs: one.sourceProofs })) }) };
  }
  function semanticToken({ context, feature, config = null, method = null, proposal = null } = {}) {
    const state = snapshot({ context, feature, config, method, proposal });
    return { current: state.current, reasonCode: state.reasonCode, domains: state.domains.map(one => ({ domainId: one.domainId,
      current: one.current, semanticRevision: one.semanticRevision, semanticFingerprint: one.semanticFingerprint,
      coverage: one.coverage, dirty: !!one.dirty })) };
  }
  function clearRefreshRetry(context, domainId) {
    run('DELETE FROM backend_dynamic_refresh_domain_retry WHERE owner_ref=? AND subject_ref=? AND domain_id=?', context.ownerRef, context.subjectRef, domainId);
    retryDeadlines.delete(canonical([context.ownerRef, context.subjectRef, domainId]));
  }
  function recordRefreshRetry(context, domain, responseRef = null, incrementAttempt = true) {
    const id = canonical([context.ownerRef, context.subjectRef, domain.domainId]), old = get(`SELECT attempt FROM backend_dynamic_refresh_domain_retry
      WHERE owner_ref=? AND subject_ref=? AND domain_id=?`, context.ownerRef, context.subjectRef, domain.domainId);
    const attempt = Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Number(old?.attempt || 0) + (incrementAttempt ? 1 : 0))),
      delay = Math.min(refreshRetryMaxMs, refreshRetryBaseMs * (2 ** Math.min(4, attempt - 1)));
    const deadline = monotonicNow() + delay, retryAtMs = Math.ceil(deviceNow() + delay);
    retryDeadlines.set(id, { instanceRef, deadline });
    run(`INSERT INTO backend_dynamic_refresh_domain_retry VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref,domain_id)
      DO UPDATE SET attempt=excluded.attempt,retry_at_ms=excluded.retry_at_ms,last_response_ref=excluded.last_response_ref,
      reason_code=excluded.reason_code,updated_at=excluded.updated_at`, context.ownerRef, context.subjectRef, domain.domainId,
    attempt, retryAtMs, responseRef, domain.reasonCode || 'DYNAMIC_REFRESH_COVERAGE_STILL_MISSING', nowIso());
    return retryAtMs;
  }
  function retryDeadline(context, domainId) {
    const row = get('SELECT retry_at_ms,reason_code FROM backend_dynamic_refresh_domain_retry WHERE owner_ref=? AND subject_ref=? AND domain_id=?',
      context.ownerRef, context.subjectRef, domainId);
    if (!row) return null;
    const id = canonical([context.ownerRef, context.subjectRef, domainId]), cached = retryDeadlines.get(id);
    if (cached?.instanceRef === instanceRef) return { mono: cached.deadline, wall: Math.ceil(deviceNow() + Math.max(0, cached.deadline - monotonicNow())), reasonCode: row.reason_code };
    const maxDelay = refreshRetryMaxMs, remaining = Math.max(0, Math.min(maxDelay, Number(row.retry_at_ms) - deviceNow()));
    const deadline = monotonicNow() + remaining;
    retryDeadlines.set(id, { instanceRef, deadline });
    return { mono: deadline, wall: Math.ceil(deviceNow() + remaining), reasonCode: row.reason_code };
  }
  function recordSubjectRetry(context, reasonCode, incrementAttempt = true) {
    const old = get('SELECT attempt FROM backend_dynamic_refresh_subject_retry WHERE owner_ref=? AND subject_ref=?',
      context.ownerRef, context.subjectRef);
    const attempt = incrementAttempt ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Number(old?.attempt || 0) + 1)) : 1;
    const delay = Math.min(refreshRetryMaxMs, refreshRetryBaseMs * (2 ** Math.min(4, attempt - 1)));
    const deadline = monotonicNow() + delay, retryAtMs = Math.ceil(deviceNow() + delay);
    subjectRetryDeadlines.set(key(context), { instanceRef, deadline });
    run(`INSERT INTO backend_dynamic_refresh_subject_retry VALUES(?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref)
      DO UPDATE SET attempt=excluded.attempt,retry_at_ms=excluded.retry_at_ms,reason_code=excluded.reason_code,updated_at=excluded.updated_at`,
    context.ownerRef, context.subjectRef, attempt, retryAtMs, reasonCode || 'DYNAMIC_REFRESH_INCOMPLETE', nowIso());
    return retryAtMs;
  }
  function subjectRetryDeadline(context) {
    const row = get('SELECT retry_at_ms,reason_code FROM backend_dynamic_refresh_subject_retry WHERE owner_ref=? AND subject_ref=?',
      context.ownerRef, context.subjectRef);
    if (!row) return null;
    const id = key(context), cached = subjectRetryDeadlines.get(id);
    if (cached?.instanceRef === instanceRef) return { mono: cached.deadline,
      wall: Math.ceil(deviceNow() + Math.max(0, cached.deadline - monotonicNow())), reasonCode: row.reason_code };
    const remaining = Math.max(0, Math.min(refreshRetryMaxMs, Number(row.retry_at_ms) - deviceNow()));
    const deadline = monotonicNow() + remaining;
    subjectRetryDeadlines.set(id, { instanceRef, deadline });
    return { mono: deadline, wall: Math.ceil(deviceNow() + remaining), reasonCode: row.reason_code };
  }
  function recordBusyRetry(context, domains, reasonCode) {
    const retryAtMs = Math.ceil(deviceNow() + refreshBusyRetryMs), deadline = monotonicNow() + refreshBusyRetryMs;
    for (const id of domains) {
      const row = get('SELECT attempt FROM backend_dynamic_refresh_domain_retry WHERE owner_ref=? AND subject_ref=? AND domain_id=?',
        context.ownerRef, context.subjectRef, id);
      const attempt = Math.max(0, Number(row?.attempt || 0) - 1), key = canonical([context.ownerRef, context.subjectRef, id]);
      retryDeadlines.set(key, { instanceRef, deadline });
      run(`INSERT INTO backend_dynamic_refresh_domain_retry VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref,domain_id)
        DO UPDATE SET attempt=excluded.attempt,retry_at_ms=excluded.retry_at_ms,last_response_ref=NULL,
        reason_code=excluded.reason_code,updated_at=excluded.updated_at`, context.ownerRef, context.subjectRef, id, attempt,
      retryAtMs, null, 'DYNAMIC_REFRESH_BUSY:' + String(reasonCode || 'UNAVAILABLE').slice(0, 64), nowIso());
    }
    return retryAtMs;
  }
  function recordMissingRefresh(context, refreshedState, domains, responseRef = null) {
    const due = [];
    for (const id of domains) {
      const domain = refreshedState.domains.find(one => one.domainId === id);
      if (domain?.current) clearRefreshRetry(context, id);
      else if (domain) due.push(recordRefreshRetry(context, domain, responseRef, false));
    }
    return due.length ? Math.min(...due) : null;
  }
  function mergeRefreshDemand(flight, input, missing) {
    const paths = actionRequiredPaths(input.feature, input.config, input.method, input.proposal);
    for (const domain of missing) {
      const id = domain.domainId, selected = paths?.[id];
      flight.domains.add(id); flight.reasons.add(domain.reasonCode || input.reasonCode || 'DYNAMIC_DOMAIN_NOT_CURRENT');
      const prior = flight.requirements.get(id);
      // No path subset means the complete domain. Full coverage dominates a
      // subset; otherwise all requested paths must be covered, not just the
      // paths captured by the first caller at dispatch time.
      if (!Array.isArray(selected) || prior === null) flight.requirements.set(id, null);
      else flight.requirements.set(id, new Set([...(prior || []), ...selected]));
    }
  }
  function refreshCoverage(flight, context) {
    const requested = [...flight.domains].sort();
    const paths = Object.fromEntries([...flight.requirements].filter(([, value]) => value !== null)
      .map(([id, value]) => [id, [...value].sort()]));
    const state = snapshotRequirements(context, requested, paths);
    return { state, receipt: { requested, dispatched: [...flight.dispatched].sort(),
      covered: state.domains.filter(one => one.current).map(one => one.domainId).sort(),
      pending: requested.filter(id => !state.domains.some(one => one.domainId === id && one.current)) } };
  }
  async function ensureCurrent(input = {}) {
    const { context, feature, config = null, method = null, proposal = null, extraDomains = [], reasonCode = 'DYNAMIC_DOMAIN_NOT_CURRENT', signal } = input;
    const state = snapshot({ context, feature, config, method, proposal, extraDomains });
    for (const domain of state.domains) if (domain.current) clearRefreshRetry(context, domain.domainId);
    if (state.current) {
      return { current: true, refreshed: false, snapshot: state };
    }
    if (!requestRefresh) return { current: false, refreshed: false, reasonCode: 'DYNAMIC_REFRESH_PORT_UNAVAILABLE', snapshot: state };
    if (!isCurrent(context) || signal?.aborted) return { current: false, refreshed: false, reasonCode: 'DYNAMIC_REFRESH_CANCELLED', snapshot: state };
    const flightKey = key(context), previous = flights.get(flightKey);
    if (previous) {
      const requested = state.domains.filter(domain => !domain.current);
      mergeRefreshDemand(previous, input, requested);
      const joined = await previous.promise;
      if (signal?.aborted) return { current: false, refreshed: false, reasonCode: 'DYNAMIC_REFRESH_CANCELLED', snapshot: state };
      const joinedContext = joined?.newContext && isCurrent(joined.newContext) && joined.newContext.ownerRef === context.ownerRef &&
        joined.newContext.subjectRef === context.subjectRef ? joined.newContext : isCurrent(context) ? context : null;
      if (!joinedContext) return { current: false, refreshed: false, reasonCode: 'DYNAMIC_REFRESH_CANCELLED', snapshot: state };
      const joinedState = snapshot({ context: joinedContext, feature, config, method, proposal, extraDomains });
      const retryAtMs = recordMissingRefresh(joinedContext, joinedState, requested.map(one => one.domainId), joined.refreshRef ?? null);
      return { current: joinedState.current, refreshed: joined?.refreshed === true, newContext: joinedContext,
        refreshCoverage: joined?.refreshCoverage ?? null,
        reasonCode: joinedState.reasonCode || reasonCode, retryAtMs, snapshot: { ...joinedState, nextCheckAtMs: retryAtMs ?? joinedState.nextCheckAtMs } };
    }
    const missing = state.domains.filter(domain => !domain.current), dueDomains = [], waiting = [];
    const subjectRetry = subjectRetryDeadline(context);
    if (subjectRetry && subjectRetry.mono > monotonicNow()) {
      return { current: false, refreshed: false, reasonCode: 'DYNAMIC_DOMAIN_REFRESH_BACKOFF', retryAtMs: subjectRetry.wall,
        snapshot: { ...state, nextCheckAtMs: subjectRetry.wall } };
    }
    for (const domain of missing) {
      const retry = retryDeadline(context, domain.domainId);
      if (!retry) dueDomains.push(domain);
      else if (retry.mono <= monotonicNow()) dueDomains.push(domain);
      else waiting.push(retry);
    }
    if (waiting.length && !dueDomains.length) {
      const retryAtMs = Math.min(...waiting.map(one => one.wall));
      return { current: false, refreshed: false, reasonCode: 'DYNAMIC_DOMAIN_REFRESH_BACKOFF', retryAtMs,
        snapshot: { ...state, nextCheckAtMs: retryAtMs } };
    }
    const flight = { context, domains: new Set(dueDomains.map(one => one.domainId)),
      reasons: new Set(dueDomains.map(one => one.reasonCode || reasonCode)), requirements: new Map(), dispatched: new Set(), promise: null };
    mergeRefreshDemand(flight, input, dueDomains);
    for (const domain of dueDomains) recordRefreshRetry(context, domain, null, true);
    const refreshRef = 'dynamic-refresh:' + newId();
    flight.promise = Promise.resolve().then(async () => {
      const domains = [...flight.domains], reasons = [...flight.reasons];
      flight.dispatched = new Set(domains);
      const missingDetail = domains.map(id => { const h = head(context, id), d = dirty(context, id); return [id,
        h ? h.complete === 1 : false, h?.source_method || '-', d?.reason_code || '-'].join(':'); });
      recordEvent(refreshRef, 'requested', context, domains, reasons, { reasonCode, attempted: true, missing: missingDetail });
      try {
        const result = await requestRefresh({ context, refreshRef, domains, reasons, proposal });
        if (result?.accepted === false) {
          const retryAtMs = recordBusyRetry(context, [...flight.domains], result.reasonCode);
          const reason = typeof result.reasonCode === 'string' ? result.reasonCode : 'DYNAMIC_REFRESH_NOT_STARTED';
          recordEvent(refreshRef, 'not-started', context, domains, reasons, { reasonCode: reason, attempted: false, retryAtMs });
          return { current: false, refreshed: false, newContext: null, refreshRef, retryAtMs, reasonCode: reason,
            snapshot: { ...snapshot({ context, feature, config, method, proposal, extraDomains }), nextCheckAtMs: retryAtMs } };
        }
        const newContext = result?.newContext;
        if (!newContext || newContext.subjectRef !== context.subjectRef || newContext.ownerRef !== context.ownerRef ||
            newContext.connectionEpoch <= context.connectionEpoch || !validContext(newContext) || !isCurrent(newContext)) {
          const retryAtMs = recordSubjectRetry(context, result?.reasonCode || 'DYNAMIC_REFRESH_NOT_CURRENT');
          return { current: false, refreshed: false, newContext: null, refreshRef, retryAtMs,
            reasonCode: 'DYNAMIC_REFRESH_CANCELLED', snapshot: { ...snapshot({ context, feature }), nextCheckAtMs: retryAtMs } };
        }
        const refreshedState = snapshot({ context: newContext, feature, config, method, proposal, extraDomains });
        const coverage = refreshCoverage(flight, newContext);
        const retryAtMs = recordMissingRefresh(newContext, coverage.state, [...flight.domains], result?.responseRef ?? null);
        const subjectRetryAtMs = recordSubjectRetry(newContext,
          refreshedState.current ? 'DYNAMIC_REFRESH_COMPLETED' : result?.reasonCode || refreshedState.reasonCode || 'DYNAMIC_REFRESH_INCOMPLETE',
          !refreshedState.current);
        const nextCheckAtMs = subjectRetryAtMs ?? retryAtMs;
        const missingAfter = coverage.receipt.pending.map(id => {
          const domain = coverage.state.domains.find(one => one.domainId === id); return [id, false, '-', domain?.reasonCode || '-'].join(':'); });
        recordEvent(refreshRef, result?.refreshed && coverage.state.current ? 'completed' : 'incomplete', context, [...flight.domains], [...flight.reasons],
          { reasonCode: result?.reasonCode ?? coverage.state.reasonCode, refreshed: result?.refreshed === true, retryAtMs: nextCheckAtMs,
            refreshCoverage: coverage.receipt, missingAfter });
        return { current: refreshedState.current, refreshed: result?.refreshed === true, newContext, refreshRef,
          refreshCoverage: coverage.receipt,
          reasonCode: refreshedState.reasonCode, retryAtMs: nextCheckAtMs, snapshot: { ...refreshedState, nextCheckAtMs: nextCheckAtMs ?? refreshedState.nextCheckAtMs } };
      } catch (error) {
        const failedState = snapshot({ context, feature, config, method, proposal, extraDomains });
        const failedCoverage = refreshCoverage(flight, context);
        const retryAtMs = recordMissingRefresh(context, failedCoverage.state, [...flight.domains], null);
        const subjectRetryAtMs = recordSubjectRetry(context, error?.code || 'DYNAMIC_REFRESH_FAILED');
        recordEvent(refreshRef, 'failed', context, [...flight.domains], [...flight.reasons], { reasonCode: error?.code || 'DYNAMIC_REFRESH_FAILED', attempted: true,
          refreshCoverage: failedCoverage.receipt, retryAtMs: subjectRetryAtMs });
        return { current: false, refreshed: false, newContext: null, refreshRef, retryAtMs: subjectRetryAtMs,
          reasonCode: error?.code || 'DYNAMIC_REFRESH_FAILED', snapshot: { ...failedState, nextCheckAtMs: subjectRetryAtMs } };
      } finally { if (flights.get(flightKey) === flight) flights.delete(flightKey); }
    });
    flights.set(flightKey, flight);
    const completed = await flight.promise;
    if (signal?.aborted) return { current: false, refreshed: false, reasonCode: 'DYNAMIC_REFRESH_CANCELLED', snapshot: state };
    return completed;
  }
  function dueDomains(context) {
    const mono = monotonicNow(), device = deviceNow();
    return Object.keys(DYNAMIC_DOMAIN_MANIFEST).map(domainId => {
      const row = head(context, domainId), held = dirty(context, domainId), policy = DYNAMIC_DOMAIN_MANIFEST[domainId], maxAge = policy.maxAgeMs ?? defaultMaxAgeMs;
      const cells = all(`SELECT observed_monotonic_ms FROM backend_dynamic_domain_cells WHERE owner_ref=? AND subject_ref=? AND domain_id=?
        AND owner_epoch=? AND run_epoch=? AND connection_epoch=? AND instance_ref=?`, context.ownerRef, context.subjectRef, domainId,
      context.ownerEpoch, context.runEpoch, context.connectionEpoch, instanceRef);
      const monoDue = !cells.length || cells.some(cell => cell.observed_monotonic_ms + maxAge <= mono);
      const deadline = cells.length ? device + Math.max(0, Math.min(...cells.map(cell => cell.observed_monotonic_ms + maxAge)) - mono) : device;
      return { domainId, row, dirty: held, monoDue, deadline };
    })
      .filter(one => one.dirty || !one.row || one.row.owner_epoch !== context.ownerEpoch || one.row.run_epoch !== context.runEpoch ||
        one.row.connection_epoch !== context.connectionEpoch || one.monoDue)
      .map(one => ({ domainId: one.domainId, nextCheckAtMs: one.deadline, dirty: !!one.dirty,
        reasonCode: one.dirty?.reason_code || (!one.row ? 'DYNAMIC_DOMAIN_NOT_OBSERVED' : 'DYNAMIC_DOMAIN_PERIODIC_CHECK_DUE') }));
  }
  function authorizeRefreshRequest({ context, refreshRef, domains, reasons } = {}) {
    if (!validContext(context) || !isCurrent(context) || typeof refreshRef !== 'string' || !Array.isArray(domains) || !Array.isArray(reasons)) return false;
    const row = get(`SELECT * FROM backend_dynamic_refresh_events WHERE refresh_ref=? AND event_kind='requested' AND owner_ref=?
      AND account_ref=? AND subject_ref=? AND run_epoch=? AND connection_epoch=?`, refreshRef, context.ownerRef, String(context.accountRef),
    context.subjectRef, context.runEpoch, context.connectionEpoch);
    return !!row && canonical(parseStored(row.domains_json, '动态刷新域')) === canonical([...domains].sort()) &&
      canonical(parseStored(row.reasons_json, '动态刷新原因')) === canonical([...reasons].sort());
  }
  return Object.freeze({ snapshot, currentNeedSnapshot, semanticToken, observe, invalidate, beforeDispatch, ensureCurrent, dueDomains, authorizeRefreshRequest,
    head: (context, domainId) => head(context, domainId),
    dirty: (context, domainId) => dirty(context, domainId), manifest: DYNAMIC_DOMAIN_MANIFEST });
}
