import { clone, fingerprint, freeze } from '../../common.mjs';
import { customerContext, sameCustomerContext, knownCustomerCell } from './wire-facts.mjs';
import { customerOrderFingerprint } from './identity.mjs';

const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const synchronous = result => {
  if (result?.then) throw new TypeError('Customer acceptance dependencies must be synchronous');
  return result;
};

// Acceptance is a local policy decision. This module has no RPC, reservation,
// rejection executor, generation, crafting, or persistent write side effect.
export function createCustomerAcceptance({ catalog, isCurrent } = {}) {
  if (typeof catalog?.rewardPolicy !== 'function' || typeof isCurrent !== 'function') throw new TypeError('Customer acceptance requires an audited reward catalog and current-context guard');
  function evaluate({ context: supplied, order, identity, config } = {}) {
    const context = customerContext(supplied);
    if (!context) throw new TypeError('Customer acceptance requires a full context');
    const activeCatalog = catalog.forContext?.(context) ?? catalog;
    const dto = config?.config ?? config, policy = dto?.orders?.customer;
    const revision = positive(config?.savedRevision) ? config.savedRevision : null;
    const cancelEpoch = nonnegative(config?.featureCancelEpochs?.['order.customer']) ? config.featureCancelEpochs['order.customer'] : null;
    const tierValid = Array.isArray(policy?.coinTiers) && policy.coinTiers.every(one => [1, 2, 3].includes(one)) && new Set(policy.coinTiers).size === policy.coinTiers.length;
    const tiers = tierValid ? [...policy.coinTiers].sort((a, b) => a - b) : null;
    const policyFingerprint = fingerprint({ enabled: typeof policy?.enabled === 'boolean' ? policy.enabled : null,
      coinTiers: tiers, autoReject: typeof policy?.autoReject === 'boolean' ? policy.autoReject : null });
    const npcId = positive(order?.npcId) ? order.npcId : positive(identity?.npcId) ? identity.npcId : null;
    const artId = knownCustomerCell(order?.fields?.artId) && positive(order.fields.artId.value) ? order.fields.artId.value : null;
    const need = knownCustomerCell(order?.fields?.num) && positive(order.fields.num.value) ? order.fields.num.value : null;
    const contentFingerprint = customerOrderFingerprint(order);
    const base = { context: clone(context), npcId, lifecycleRef: identity?.lifecycleRef ?? null,
      firstSeenSequence: positive(identity?.firstSeenSequence) ? identity.firstSeenSequence : null,
      order: { npcId, artId, need, contentFingerprint }, configRevision: revision, featureCancelEpoch: cancelEpoch,
      policyFingerprint, coinTiers: tiers, autoRejectKnown: typeof policy?.autoReject === 'boolean',
      source: order?.source ? clone(order.source) : null, identitySource: identity?.source ? clone(identity.source) : null,
      identityKnown: identity?.identityKnown === true, officialOrderIdProven: false,
      writeEligible: false, historicalConstraintsChecked: false, resourceAllocated: false,
      craftingDemandCreated: false, rejectionImplemented: false, generationImplemented: false };
    const finish = (verdict, reasonCode, reward = { known: false, itemId: 1002, quantity: null, reasonCode: 'CUSTOMER_REWARD_NOT_EVALUATED' }) => {
      const body = { ...base, verdict, reasonCode, reward, accepted: verdict === 'accepted',
        // This expresses explicit policy plus intent only. An actual reject
        // still requires its own current target/admission/RPC/post-read contract.
        policyRejectionEligible: verdict === 'filtered' && policy?.enabled === true && policy?.autoReject === true,
        rejectionReasonCode: verdict === 'filtered' ? reasonCode : null };
      const { source: ignoredSource, identitySource: ignoredIdentitySource, configRevision: ignoredRevision, ...semantic } = body;
      return freeze({ ...body, decisionRef: 'customer-decision:' + fingerprint(semantic) });
    };
    if (synchronous(isCurrent(context)) !== true) return finish('unknown', 'CUSTOMER_ACCEPTANCE_CONTEXT_NOT_CURRENT');
    if (typeof policy?.enabled !== 'boolean' || !tierValid || revision === null || cancelEpoch === null) return finish('unknown', 'CUSTOMER_ACCEPTANCE_CONFIG_UNREADABLE');
    if (policy.enabled === false) return finish('disabled', 'CUSTOMER_DISABLED');
    if (!sameCustomerContext(context, identity?.context) || identity.current !== true || identity.identityKnown !== true ||
      !positive(identity.firstSeenSequence) || typeof identity.lifecycleRef !== 'string' || identity.lifecycleRef.length === 0 ||
      order?.current !== true || order.readable !== true || order.state !== 'known' ||
      !contentFingerprint || identity.contentFingerprint !== contentFingerprint || identity.npcId !== npcId || artId === null || need === null) {
      return finish('unknown', identity?.reasonCode || 'CUSTOMER_ORDER_IDENTITY_UNPROVEN');
    }
    const source = order.source;
    if (source?.kind !== 'response' || source.transport !== 'answered' || source.connectionEpoch !== context.connectionEpoch ||
      !positive(source.requestSequence) || !/^[0-9]+(?:\.[0-9]+){1,5}$/.test(source.version?.gameVersion || '') || source.version.protocolVersion !== '480.0.0' ||
      typeof source.version.loginResponseRef !== 'string' || !source.version.loginResponseRef) return finish('unknown', 'CUSTOMER_REWARD_SOURCE_VERSION_UNSUPPORTED');
    if (identity.source?.responseRef !== source.responseRef || identity.source?.requestSequence !== source.requestSequence ||
      identity.source?.connectionEpoch !== source.connectionEpoch) return finish('unknown', 'CUSTOMER_IDENTITY_OBSERVATION_NOT_RECONCILED');
    // An explicitly empty selection excludes this order without inventing a
    // zero-valued reward. It remains different from a missing/invalid selection.
    if (tiers.length === 0) return finish('filtered', 'CUSTOMER_COIN_TIERS_EMPTY');
    if (typeof activeCatalog.supports === 'function' && activeCatalog.supports('customer.finish', source.version) !== true) {
      return finish('unknown', 'CUSTOMER_FINISH_SOURCE_CONTRACT_UNPROVEN');
    }
    const unit = synchronous(activeCatalog.rewardPolicy(artId, source.version));
    if (!unit?.known || unit.itemId !== 1002 || !positive(unit.quantityPerUnit) || unit.catalogId !== `official-public/customer-${source.version.gameVersion}`) {
      return finish('unknown', unit?.reasonCode || 'CUSTOMER_REWARD_POLICY_UNPROVEN');
    }
    const amount = unit.quantityPerUnit * need;
    if (!positive(amount)) return finish('unknown', 'CUSTOMER_REWARD_QUANTITY_OVERFLOW');
    const reward = { known: true, itemId: 1002, quantity: amount, quantityPerUnit: unit.quantityPerUnit,
      sourceKind: 'audited-versioned-calculation', predicted: true, officialGainObserved: false,
      catalogId: unit.catalogId, manifestSha256: unit.manifestSha256 ?? null, tableSha256: unit.tableSha256 ?? null,
      sourceRow: unit.sourceRow ?? null, sourceRuleRef: unit.sourceRuleRef ?? null, reasonCode: null };
    if (synchronous(isCurrent(context)) !== true) return finish('unknown', 'CUSTOMER_ACCEPTANCE_CONTEXT_NOT_CURRENT', reward);
    return tiers.includes(amount) ? finish('accepted', 'CUSTOMER_REWARD_TIER_ACCEPTED', reward) : finish('filtered', 'CUSTOMER_REWARD_TIER_FILTERED', reward);
  }
  return Object.freeze({ evaluate });
}
