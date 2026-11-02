import { orderFlowerDynamicDomains } from './runtime.mjs';

// Keep bootstrap composition and offline integration fixtures on the same
// production registration path. This function only composes existing ports;
// it does not add test behavior or business decisions.
export function composeOrderFlowerFeature({ feature, orderFlowerRuntime, auxiliaryRuntime, actionRuntime }) {
  const kind = feature.featureId.slice(6), operationContracts = Object.freeze({
    [feature.operationContract.method]: feature.operationContract, ...auxiliaryRuntime.contractsFor(kind) });
  const actionMethods = Object.freeze({ delivery: [feature.operationContract.method], enter: ['orderFlower.enter'],
    'stage-reward': ['orderFlower.recvOrderRwd'], achievement: ['taskAch.recv'], video: ['usr.share'] });
  const actionScopes = Object.freeze(Object.fromEntries(Object.entries(actionMethods).map(([actionKey, methods]) =>
    [actionKey, methods.map(method => operationContracts[method]?.scope).filter(Boolean)])));
  const unit = (actionKey, assess, priority = 0) => Object.freeze({ scheduleKey: feature.featureId + ':' + actionKey,
    allowedMethods: actionMethods[actionKey], allowedScopes: actionScopes[actionKey],
    quotaKeys: actionKey === 'delivery' ? ['order-flower:' + kind]
      : actionKey === 'video' ? ['order-flower:' + kind, 'order-flower:' + kind + ':video']
      : ['enter', 'stage-reward', 'achievement'].includes(actionKey) ? ['order-flower:' + kind + ':' + actionKey] : [],
    consumedDomains: feature.consumedDomains, consumedDomainsFor: input => {
      const capability = actionKey === 'delivery' ? null : auxiliaryRuntime.sourceCapability(input?.context);
      return orderFlowerDynamicDomains({ ...input, actionKey, kind,
        auxiliarySupported: capability?.known === true ? capability.supported : null });
    },
    ...(actionKey !== 'delivery' ? { sourceCapability: ({ context }) => auxiliaryRuntime.sourceCapability(context) } : {}),
    factDomains: ['order-flower', 'land-domain'], resourceKinds: ['inventory'], priority,
    assess: async input => {
      const result = await assess(input) || { state: 'waiting-facts',
        reasonCode: auxiliaryRuntime.readiness(input.context)?.reasonCode || 'ORDER_AUXILIARY_NO_CURRENT_ELIGIBLE_ACTION' };
      if (result?.state === 'cap-wait') return { ...result,
        suspension: { ...result.suspension, actionScope: feature.featureId + ':' + actionKey } };
      if (Array.isArray(result?.capReleaseProofs)) return { ...result, capReleaseProofs: result.capReleaseProofs.map(proof => ({
        ...proof, actionScope: feature.featureId + ':' + actionKey })) };
      return result;
    } });
  const scheduleUnits = [unit('delivery', feature.assess), unit('enter', input => auxiliaryRuntime.assess(kind, input, 'enter'), 1),
    ...(kind === 'resident' ? [unit('stage-reward', input => auxiliaryRuntime.assess(kind, input, 'stage-reward'), 1),
      unit('achievement', input => auxiliaryRuntime.assess(kind, input, 'achievement'), 1)] : []),
    unit('video', input => auxiliaryRuntime.assess(kind, input, 'video'), -1)];
  return { ...feature, primaryActionKey: feature.featureId + ':delivery',
    scopes: Object.values(operationContracts).map(one => one.scope), methods: Object.keys(operationContracts),
    methodScopes: Object.fromEntries(Object.values(operationContracts).map(one => [one.method, one.scope])), operationContracts,
    currentNeedContracts: Object.freeze(Object.fromEntries(Object.values(operationContracts).map(one => [one.method,
      Object.freeze({ path: one.method === 'usr.share' ? 'orderFlowerVideo.currentNeed'
        : one.method === 'orderFlower.recvOrderRwd' || one.method === 'taskAch.recv' ? 'orderFlowerReward.currentNeed'
          : one.method === 'orderFlower.enter' ? 'orderFlowerEnter.currentNeed' : 'orderFlower.currentNeed', required: true })]))),
    consumeCurrentNeed: input => auxiliaryRuntime.handles(input?.proposal)
      ? auxiliaryRuntime.consumeCurrentNeed(input) : orderFlowerRuntime.consumeCurrentNeed(input),
    implementationVersion: 'order-flower-composed-current-facts/v1', contractRef: 'order-three/current-singles-and-auxiliary/v1',
    scheduleUnits: Object.freeze(scheduleUnits),
    assess: async input => await auxiliaryRuntime.assess(kind, input) || feature.assess(input),
    // Share the exact admission function identity so the gateway can reuse
    // this boundary's result instead of running the same guard twice.
    qualify: actionRuntime.evaluateAdmission,
    verify: input => auxiliaryRuntime.handles(input.proposal) ? auxiliaryRuntime.verify(input) : feature.verify(input) };
}
