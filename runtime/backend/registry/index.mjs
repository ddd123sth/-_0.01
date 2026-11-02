import fs from 'node:fs';
import { clone, freeze, plainObject, problem } from '../common.mjs';
import { affectedDomainsForWrite, consumedDomains } from '../facts/dynamic-state.mjs';
import { SPECIAL_ORDER_DEFINITIONS } from '../features/special-orders/rpc-contract.mjs';
import { REWARD_CARDS } from '../features/rewards/catalog.mjs';

const inventory = JSON.parse(fs.readFileSync(new URL('./inventory.json', import.meta.url), 'utf8'));
const CURRENT_FEATURES = Object.freeze([
  ['plant', '种花', 'G2', ['plant'], ['usrLand.plant', 'usrLand.plantBatch']],
  ['harvest', '收花', 'G2', ['harvest'], ['usrLand.harvest']],
  ['water', '浇水', 'G2', ['water'], ['usrLand.water', 'usrLand.waterBatch']],
  ['waterwheel', '水车水桶', 'G4', ['waterwheel-recv', 'waterwheel-skip', 'waterwheel-ad-bucket'], ['waterwheel.recv', 'waterwheel.skip', 'usr.share']],
  ['free-water', '每日水滴', 'G4', ['free-water-recv', 'free-water-fallback'], ['freeWater.recv', 'usr.share']],
  ['flower-rack', '花架管理', 'G4', ['rack-unlock', 'rack-sell', 'rack-recv', 'rack-cancel'],
    ['flowerRack.unlockStand', 'flowerRack.sell', 'flowerRack.recvSellMoney', 'flowerRack.cancelSell']],
  ['art.daily', '日常花艺制作', 'G4', ['flower-art-daily'], ['flowerArt.makeFlowerArt']],
  ['land.acceleration', '土地加速', 'G2', ['land-speedup', 'land-speedfree'], ['usrLand.speedUp', 'usrLand.speedUpFree']],
  ['order.customer', '顾客订单', 'G3A', ['order-customer', 'order-reject', 'order-customer-gen'], ['orderCustomer.finishOrder', 'orderCustomer.rejectOrder', 'orderCustomer.genOrder']], ['art.make', '花艺制作', 'G3B', ['flower-art-make'], ['flowerArt.makeFlowerArt']],
  ['art.customer-batch', '顾客花艺批量制作', 'G3B', ['flower-art-customer-batch'], ['flowerArt.makeFlowerArt']],
  ['art.first-album', '花艺图鉴奖励', 'G4', ['vase-album-recv'], ['collectRwd.recvArtCreateRwdByVase']],
  ['art.first-share', '花艺首次分享奖励', 'G4', ['art-first-share'], ['usr.share']],
  ['order.resident', '居民订单', 'G4', ['order-resident', 'order-resident-video', 'order-resident-reward', 'order-resident-achievement', 'order-resident-enter'],
    ['orderFlower.finishOrder', 'usr.share', 'orderFlower.recvOrderRwd', 'taskAch.recv', 'orderFlower.enter']],
  ['order.satin', '绸缎订单', 'G4', ['order-satin', 'order-satin-video', 'order-satin-enter'],
    ['orderFlower.finishSatinOrder', 'usr.share', 'orderFlower.enter']],
  ['order.decorate', '建材订单', 'G4', ['order-decorate', 'order-decorate-video', 'order-decorate-enter'],
    ['orderFlower.finishDecorateOrder', 'usr.share', 'orderFlower.enter']],
  ...['palace','team'].map(kind => ['order.' + kind, kind === 'palace' ? '宫廷订单' : '组团订单', 'G4',
    Object.values(SPECIAL_ORDER_DEFINITIONS).filter(one => one.kind === kind).map(one => one.scope),
    Object.values(SPECIAL_ORDER_DEFINITIONS).filter(one => one.kind === kind).map(one => one.method)]),
  ['reward.mail', '邮件', 'G4', ['mail-pick'], ['mail.pickOneKey']],
  ['reward.benefit-box', '福利宝箱', 'G4', ['benefit-box-draw'], ['benefitBox.draw']],
  ['reward.daily-task', '每日任务', 'G4', ['daily-task-recv'], ['taskDly.recv']],
  ['reward.daily-box', '日常任务宝箱', 'G4', ['daily-box-recv'], ['taskDly.recvBox']],
  ['reward.weekly-task', '每周任务', 'G4', ['weekly-task-recv'], ['taskWeek.recv']],
  ['reward.free-gift', '免费元宝礼包', 'G4', ['free-gift-share'], ['usr.share']],
  ['reward.double-coin', '双倍金币', 'G4', ['double-coin-share'], ['usr.share']],
  ['reward.main-task', '主线领奖', 'G4', ['main-task-recv'], ['taskMain.recv']],
  ['reward.main-story', '主线剧情解锁', 'G4', ['story-unlock'], ['storyMain.unlock']],
  ['guild.build.video', '公会建设', 'G4', ['guild-build-video'], ['usr.share']],
  ['guild.build.gold', '公会建设', 'G4', ['guild-build-gold'], ['fml.bld']],
  ['guild.build.yuanbao', '公会建设', 'G4', ['guild-build-yuanbao'], ['fml.bld']],
  ['guild.land', '公会地', 'G4', ['guild-harvest', 'guild-plant', 'guild-unlock', 'guild-upgrade'],
    ['fmlLand.harvestAll', 'fmlLand.plant', 'fmlLand.unlock', 'fmlLand.upgrade']],
  ['cultivate.upgrade', '升级鲜花', 'G4', ['cultivate-upgrade'], ['cultivate.upgrade']],
  ['cultivate.shop', '材料商店', 'G4', ['shop-buy', 'shop-refresh'], ['shopCultivate.buy', 'shopCultivate.refresh']],
]);
const ORDINARY_FLOWER_READS = Object.freeze([
  ['order.resident', 'order-resident', 'orderFlower.finishOrder'],
  ['order.satin', 'order-satin', 'orderFlower.finishSatinOrder'],
  ['order.decorate', 'order-decorate', 'orderFlower.finishDecorateOrder'],
].map(one => Object.freeze(one)));
const FLOWER_OPERATION_SCOPES = Object.freeze({
  'order.resident': Object.freeze({ 'orderFlower.finishOrder': 'order-resident', 'usr.share': 'order-resident-video',
    'orderFlower.recvOrderRwd': 'order-resident-reward', 'taskAch.recv': 'order-resident-achievement', 'orderFlower.enter': 'order-resident-enter' }),
  'order.satin': Object.freeze({ 'orderFlower.finishSatinOrder': 'order-satin', 'usr.share': 'order-satin-video', 'orderFlower.enter': 'order-satin-enter' }),
  'order.decorate': Object.freeze({ 'orderFlower.finishDecorateOrder': 'order-decorate', 'usr.share': 'order-decorate-video', 'orderFlower.enter': 'order-decorate-enter' }),
});
const WATERWHEEL_OPERATION_SCOPES = Object.freeze({ 'waterwheel.recv': 'waterwheel-recv', 'waterwheel.skip': 'waterwheel-skip', 'usr.share': 'waterwheel-ad-bucket' });
const FREE_WATER_OPERATION_SCOPES = Object.freeze({ 'freeWater.recv': 'free-water-recv', 'usr.share': 'free-water-fallback' });
const FLOWER_RACK_OPERATION_SCOPES = Object.freeze({ 'flowerRack.unlockStand': 'rack-unlock', 'flowerRack.sell': 'rack-sell',
  'flowerRack.recvSellMoney': 'rack-recv', 'flowerRack.cancelSell': 'rack-cancel' });
const DAILY_ART_OPERATION_SCOPES = Object.freeze({ 'flowerArt.makeFlowerArt': 'flower-art-daily' });
const CUSTOMER_ART_BATCH_OPERATION_SCOPES = Object.freeze({ 'flowerArt.makeFlowerArt': 'flower-art-customer-batch' });
const ART_FIRST_ALBUM_OPERATION_SCOPES = Object.freeze({ 'collectRwd.recvArtCreateRwdByVase': 'vase-album-recv' });
const ART_FIRST_SHARE_OPERATION_SCOPES = Object.freeze({ 'usr.share': 'art-first-share' });
const FLOWER_AUX_READS = Object.freeze(Object.entries(FLOWER_OPERATION_SCOPES).flatMap(([featureId, methods]) =>
  Object.entries(methods).filter(([method]) => !method.startsWith('orderFlower.finish')).map(([method, scope]) =>
    Object.freeze({ featureId, scope, method }))));

const REWARD_SCOPE_MAPS = Object.freeze(Object.fromEntries(REWARD_CARDS.map(card => [card.featureId, card.methodScopes])));

export function createFeatureRegistry() {
  const features = new Map(CURRENT_FEATURES.map(([featureId, label, phase, scopes, methods]) => [featureId,
    freeze({ featureId, label, phase, declaredScopes: scopes, declaredMethods: methods, implementation: 'unimplemented',
      release: 'unreleased', reasonCode: 'FEATURE_NOT_REBUILT', enabledScopes: [], enabledMethods: [] })]));
  const modules = new Map();
  function register(definition) {
    if (!definition?.featureId || !features.has(definition.featureId) || modules.has(definition.featureId)) throw problem('FEATURE_REGISTRATION_INVALID', '新功能登记不在当前合同中或已重复登记', 500);
    if (typeof definition.assess !== 'function' || typeof definition.qualify !== 'function' || typeof definition.verify !== 'function' || !definition.implementationVersion || !definition.contractRef) {
      throw problem('FEATURE_CONTRACT_INCOMPLETE', '功能缺少判断、核验或合同版本', 500);
    }
    consumedDomains(definition);
    if (definition.primaryActionKey !== undefined && definition.primaryActionKey !== null &&
        (typeof definition.primaryActionKey !== 'string' || !Array.isArray(definition.scheduleUnits) ||
          !definition.scheduleUnits.some(unit => unit?.scheduleKey === definition.primaryActionKey))) {
      throw problem('FEATURE_PRIMARY_ACTION_INVALID', '主计划动作必须匹配功能登记的调度单元', 500);
    }
    const original = features.get(definition.featureId);
    if (!['validation-only', 'released'].includes(definition.release)) throw problem('FEATURE_ADMISSION_MISSING', '新功能未声明限定验收或准出能力', 500);
    if (!Array.isArray(definition.methods) || !Array.isArray(definition.scopes) || !definition.methods.length || !definition.scopes.length) {
      throw problem('FEATURE_METHOD_NOT_CONTRACTED', '新功能缺少显式方法和scope合同', 500);
    }
    if (definition.currentNeedContracts !== undefined) {
      const invalidNeed = value => !plainObject(value) || typeof value.path !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9]*\.currentNeed$/.test(value.path) || typeof value.required !== 'boolean';
      const asyncConsumer = typeof definition.consumeCurrentNeed === 'function' &&
        definition.consumeCurrentNeed.constructor?.name === 'AsyncFunction';
      if (!plainObject(definition.currentNeedContracts) || Object.keys(definition.currentNeedContracts).some(method => !definition.methods.includes(method)) ||
          Object.values(definition.currentNeedContracts).some(invalidNeed) ||
          Object.values(definition.currentNeedContracts).some(value => value.required) && typeof definition.consumeCurrentNeed !== 'function' ||
          asyncConsumer) {
        throw problem('FEATURE_CURRENT_NEED_CONTRACT_INVALID', '当前需求字段路径必须按已登记方法声明并提供共享单次准入端口', 500);
      }
    }
    for (const scope of definition.scopes) if (!original.declaredScopes.includes(scope)) throw problem('FEATURE_SCOPE_NOT_CONTRACTED', 'scope不在当前功能合同内', 500);
    for (const method of definition.methods) if (!original.declaredMethods.includes(method)) throw problem('FEATURE_METHOD_NOT_CONTRACTED', '方法不在当前功能合同内', 500);
    for (const method of definition.methods) affectedDomainsForWrite(definition.featureId, method);
    const exact = definition.featureId === 'land.acceleration' ? { 'usrLand.speedUp': 'land-speedup', 'usrLand.speedUpFree': 'land-speedfree' }
      : definition.featureId === 'order.customer' ? { 'orderCustomer.finishOrder': 'order-customer', 'orderCustomer.rejectOrder': 'order-reject', 'orderCustomer.genOrder': 'order-customer-gen' }
      : FLOWER_OPERATION_SCOPES[definition.featureId] || (definition.featureId === 'waterwheel' ? WATERWHEEL_OPERATION_SCOPES
        : definition.featureId === 'free-water' ? FREE_WATER_OPERATION_SCOPES : definition.featureId === 'flower-rack' ? FLOWER_RACK_OPERATION_SCOPES
          : definition.featureId === 'art.daily' ? DAILY_ART_OPERATION_SCOPES
            : definition.featureId === 'art.customer-batch' ? CUSTOMER_ART_BATCH_OPERATION_SCOPES
              : definition.featureId === 'art.first-album' ? ART_FIRST_ALBUM_OPERATION_SCOPES
                : definition.featureId === 'art.first-share' ? ART_FIRST_SHARE_OPERATION_SCOPES
                  : ['order.palace','order.team'].includes(definition.featureId)
                    ? Object.fromEntries(Object.values(SPECIAL_ORDER_DEFINITIONS).filter(one => one.featureId === definition.featureId).map(one => [one.method, one.scope])) : REWARD_SCOPE_MAPS[definition.featureId] || null);
    if (definition.scopes.length !== 1 || FLOWER_OPERATION_SCOPES[definition.featureId] && definition.methods.length > 1) {
      if (!exact || !definition.methodScopes || definition.methods.some(method => definition.methodScopes[method] !== exact[method])
        || Object.keys(definition.methodScopes).length !== definition.methods.length ||
        definition.methods.some(method => !definition.scopes.includes(definition.methodScopes[method])) ||
        definition.scopes.some(scope => !definition.methods.some(method => definition.methodScopes[method] === scope))) {
        throw problem('FEATURE_SCOPE_BINDING_REQUIRED', '多scope功能须先登记逐方法配对合同', 500);
      }
    }
    modules.set(definition.featureId, Object.freeze({ ...definition }));
    features.set(definition.featureId, freeze({ ...original, implementation: 'implemented', release: definition.release,
      reasonCode: definition.release === 'released' ? null : 'LIMITED_OFFICIAL_VALIDATION', enabledScopes: [...definition.scopes], enabledMethods: [...definition.methods],
      contractRef: definition.contractRef, implementationVersion: definition.implementationVersion }));
  }
  const rewardAdmitsRead = input => REWARD_CARDS.some(card => {
    if (!modules.has(card.featureId) || input.featureId !== card.featureId || card.methodScopes[input.writeMethod] !== input.scope) return false;
    const action = card.units.find(unit => unit.scheduleKey === input.scope)?.action || card.units[0].action;
    if (card.postReadMode === 'mail-list') return input.readKind === 'same-connection' && input.readMethod === 'mail.getList' &&
      input.readContractId === 'mail-list/post-write/v1' && input.evidenceRef === `rewards/${card.featureId}/${action}/mail-list-after-write/v1`;
    return input.readKind === 'after-close-login' && input.readMethod === 'index.login' &&
      input.readContractId === 'rewards/after-close-login/v1' &&
      input.evidenceRef === `rewards/${card.featureId}/${action}/independent-after-write/v1`;
  });
  return Object.freeze({ register, get: id => modules.get(id) || null,
    definitions: () => [...features.values()].map(clone),
    availability: (id, desired = null) => ({ ...clone(features.get(id) || { featureId: id, implementation: 'unimplemented', release: 'unreleased', reasonCode: 'FEATURE_NOT_REBUILT', enabledScopes: [], enabledMethods: [] }), desired }),
    permits: (featureId, scope, method) => Boolean(features.get(featureId)?.enabledScopes.includes(scope) && features.get(featureId)?.enabledMethods.includes(method)
      && (!modules.get(featureId)?.methodScopes || modules.get(featureId).methodScopes[method] === scope)),
    permitsRead: input => Boolean(rewardAdmitsRead(input) || Object.values(SPECIAL_ORDER_DEFINITIONS).some(one => modules.has(one.featureId) && input.featureId === one.featureId &&
      input.scope === one.scope && input.writeMethod === one.method && input.readKind === 'after-close-login' && input.readMethod === 'index.login' &&
      input.readContractId === 'special-orders/after-close-login/v1' && input.evidenceRef === 'special-orders/independent-order-and-inventory/v1') ||
      modules.has('order.customer') && input.featureId === 'order.customer' && input.scope === 'order-customer'
      && input.writeMethod === 'orderCustomer.finishOrder' && input.readKind === 'after-close-login' && input.readMethod === 'index.login'
      && input.readContractId === 'customer-fresh-login/after-physical-close/v1'
      && input.evidenceRef === 'g3a/normal-fresh-login/provided-109-and-absolute-bag/v1'
      || modules.has('order.customer') && input.featureId === 'order.customer' && input.scope === 'order-reject'
      && input.writeMethod === 'orderCustomer.rejectOrder' && input.readKind === 'after-close-login' && input.readMethod === 'index.login'
      && input.readContractId === 'customer-reject-fresh-login/after-physical-close/v1'
      && input.evidenceRef === 'g3a/normal-fresh-login/reject-original-order-and-no-delivery-effect/v1'
      || modules.has('order.customer') && input.featureId === 'order.customer' && input.scope === 'order-customer-gen'
      && input.writeMethod === 'orderCustomer.genOrder' && input.readKind === 'after-close-login' && input.readMethod === 'index.login'
      && input.readContractId === 'customer-generation-fresh-login/after-physical-close/v1'
      && input.evidenceRef === 'g3a/normal-fresh-login/generation-complete109-count107-and-bag/v1'
      || modules.has('art.make') && input.featureId === 'art.make' && input.scope === 'flower-art-make'
      && input.writeMethod === 'flowerArt.makeFlowerArt' && input.readKind === 'after-close-login' && input.readMethod === 'index.login'
      && input.readContractId === 'art-fresh-login/after-physical-close/v1'
      && input.evidenceRef === 'g3b/normal-fresh-login/provided-102-106-and-absolute-bag/v1'
      || modules.has('flower-rack') && input.featureId === 'flower-rack' && FLOWER_RACK_OPERATION_SCOPES[input.writeMethod] === input.scope &&
        input.readKind === 'after-close-login' && input.readMethod === 'index.login' &&
        input.readContractId === 'flower-rack/after-close-login/v1' && input.evidenceRef === 'flower-rack/independent-rack-and-bag-state/v1'
      || modules.has('art.daily') && input.featureId === 'art.daily' && input.scope === 'flower-art-daily' &&
        input.writeMethod === 'flowerArt.makeFlowerArt' && input.readKind === 'after-close-login' && input.readMethod === 'index.login' &&
        input.readContractId === 'art-daily/after-close-login/v1' && input.evidenceRef === 'art-daily/batched-stock-and-inputs/v2'
      || modules.has('art.customer-batch') && input.featureId === 'art.customer-batch' && input.scope === 'flower-art-customer-batch' &&
        input.writeMethod === 'flowerArt.makeFlowerArt' && input.readKind === 'after-close-login' && input.readMethod === 'index.login' &&
        input.readContractId === 'art-customer-batch/after-close-login/v2' && input.evidenceRef === 'art-customer-batch/accepted-order-and-inputs/v2'
      || modules.has('art.first-album') && input.featureId === 'art.first-album' && input.scope === 'vase-album-recv' &&
        input.writeMethod === 'collectRwd.recvArtCreateRwdByVase' && input.readKind === 'after-close-login' && input.readMethod === 'index.login' &&
        input.readContractId === 'art-first-album/after-close-login/v1' && input.evidenceRef === 'art-first-album/vase-history-and-exp/v1'
      || modules.has('art.first-share') && input.featureId === 'art.first-share' && input.scope === 'art-first-share' &&
        input.writeMethod === 'usr.share' && input.readKind === 'after-close-login' && input.readMethod === 'index.login' &&
        input.readContractId === 'art-first-share/after-close-login/v1' && input.evidenceRef === 'art-first-share/share-history-and-award/v1'
      || modules.has('waterwheel') && input.featureId === 'waterwheel' &&
        ['waterwheel-recv', 'waterwheel-skip', 'waterwheel-ad-bucket'].includes(input.scope) &&
        ['waterwheel.recv', 'waterwheel.skip', 'usr.share'].includes(input.writeMethod) &&
        input.readKind === 'after-close-login' && input.readMethod === 'index.login' &&
        input.readContractId === 'waterwheel/after-close-login/v1' && input.evidenceRef === 'waterwheel/independent-after-write-state/v1'
      || modules.has('free-water') && input.featureId === 'free-water' && ['free-water-recv','free-water-fallback'].includes(input.scope) &&
        ['freeWater.recv','usr.share'].includes(input.writeMethod) && input.readKind === 'after-close-login' && input.readMethod === 'index.login' &&
        input.readContractId === 'free-water/after-close-login/v1' && input.evidenceRef === 'free-water/independent-after-write-state/v1'
      || ORDINARY_FLOWER_READS.some(([featureId, scope, method]) => modules.has(featureId) && input.featureId === featureId && input.scope === scope &&
        input.writeMethod === method && input.readKind === 'after-close-login' && input.readMethod === 'index.login' &&
        input.readContractId === 'order-flower-fresh-login/after-physical-close/v1' &&
        input.evidenceRef === 'g4/normal-fresh-login/provided-105-counter-and-absolute-bag/v1') ||
      FLOWER_AUX_READS.some(({ featureId, scope, method }) => modules.has(featureId) && input.featureId === featureId && input.scope === scope &&
        input.writeMethod === method && input.readKind === 'after-close-login' && input.readMethod === 'index.login' &&
        input.readContractId === 'order-flower-auxiliary/fresh-login-after-close/v1' &&
        input.evidenceRef === 'g4/official-auxiliary/actual-close-fresh-login/v1') ||
      modules.has('land.acceleration') && input.featureId === 'land.acceleration' &&
        ['land-speedup', 'land-speedfree'].includes(input.scope) &&
        ['usrLand.speedUp', 'usrLand.speedUpFree'].includes(input.writeMethod) &&
        input.readKind === 'same-connection' && input.readMethod === 'usrLand.refresh' &&
        input.readContractId === 'land-refresh/post-write-v1' &&
        input.evidenceRef === 'land-acceleration/partial-target-refresh/v1'),
    inventory: () => clone(inventory), modules: () => [...modules.values()] });
}
