import { clone, fingerprint, freeze } from '../../common.mjs';
import { customerContext, sameCustomerContext } from './wire-facts.mjs';

const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const synchronous = result => {
  if (result?.then) throw new TypeError('Customer allocation dependencies must be synchronous');
  return result;
};

// Planning only: selecting an order here acquires no resource hold. The root's
// unified ledger must reserve the exact selected quantity at prepare/send.
export function createCustomerAllocation({ resources, isCurrent, readTargetAdmission = null } = {}) {
  if (typeof resources?.budget !== 'function' || typeof isCurrent !== 'function') throw new TypeError('Customer allocation requires shared inventory budgets and current-context guard');
  if (readTargetAdmission !== null && typeof readTargetAdmission !== 'function') throw new TypeError('Target admission must be a finite synchronous reader or null');
  function plan({ context: supplied, identityView, decisions, keepPolicy = null } = {}) {
    const context = customerContext(supplied);
    if (!context) throw new TypeError('Customer allocation requires a full context');
    const result = (known, reasonCode, selected, entries, queueVersion = null) => {
      const body = { context: clone(context), known, reasonCode, selected, entries, queueVersion,
        ruleVersion: 'customer-finished-stock/oldest-completely-actionable/v1',
        writeEligible: false, reservationCreated: false, historicalConstraintsChecked: false, requiresFinalAdmission: true };
      return freeze({ ...body, allocationRef: 'customer-allocation:' + fingerprint(body) });
    };
    if (synchronous(isCurrent(context)) !== true) return result(false, 'CUSTOMER_ALLOCATION_CONTEXT_NOT_CURRENT', null, []);
    if (!identityView?.current || !identityView.complete || !sameCustomerContext(context, identityView.context) ||
      !Array.isArray(identityView.identities) || !Array.isArray(decisions) || decisions.length !== identityView.identities.length) {
      return result(false, 'CUSTOMER_ALLOCATION_COMPLETE_QUEUE_REQUIRED', null, []);
    }
    const identities = new Map(identityView.identities.map(one => [one.npcId, one]));
    if (identities.size !== identityView.identities.length || new Set(decisions.map(one => one?.npcId)).size !== decisions.length ||
      decisions.some(one => !one || !sameCustomerContext(context, one.context) || !identities.has(one.npcId) ||
        one.lifecycleRef !== identities.get(one.npcId).lifecycleRef || one.order?.contentFingerprint !== identities.get(one.npcId).contentFingerprint &&
          one.identityKnown === true)) return result(false, 'CUSTOMER_ALLOCATION_DECISION_SET_INCOMPLETE', null, []);
    if (new Set(decisions.map(one => one.policyFingerprint)).size > 1 ||
      new Set(decisions.map(one => one.featureCancelEpoch)).size > 1) return result(false, 'CUSTOMER_ALLOCATION_POLICY_MISMATCH', null, []);
    const queue = [...decisions].sort((a, b) => (a.firstSeenSequence ?? Number.MAX_SAFE_INTEGER) - (b.firstSeenSequence ?? Number.MAX_SAFE_INTEGER)
      || a.npcId - b.npcId || String(a.lifecycleRef).localeCompare(String(b.lifecycleRef)));
    const queueVersion = fingerprint(queue.map(one => [one.decisionRef, one.lifecycleRef, one.firstSeenSequence, one.verdict]));
    const entries = [];
    let selected = null;
    for (const decision of queue) {
      const identity = identities.get(decision.npcId);
      const entry = { decisionRef: decision.decisionRef, lifecycleRef: decision.lifecycleRef, npcId: decision.npcId,
        artId: decision.order?.artId ?? null, need: decision.order?.need ?? null,
        firstSeenSequence: decision.firstSeenSequence, allocatedQuantity: 0,
        accepted: decision.verdict === 'accepted', reasonCode: decision.reasonCode, budget: null, keepPolicy: null,
        targetAdmission: null, availableDeficit: null, availableDeficitKnown: false, craftingDemandCreated: false, rejectProposed: false };
      if (decision.verdict !== 'accepted') { entries.push(entry); continue; }
      if (identity.identityKnown !== true || identity.current !== true || decision.identityKnown !== true ||
        !positive(decision.firstSeenSequence) || !positive(entry.artId) || !positive(entry.need)) {
        entry.reasonCode = 'CUSTOMER_ALLOCATION_IDENTITY_UNPROVEN'; entries.push(entry); continue;
      }
      if (readTargetAdmission) {
        const target = synchronous(readTargetAdmission({ context: clone(context), identity: clone(identity), decision: clone(decision) }));
        if (!target || typeof target !== 'object') throw new TypeError('Target admission returned no explicit result');
        entry.targetAdmission = clone(target);
        if (target.known !== true || target.allowed !== true) {
          entry.reasonCode = target.reasonCode || 'CUSTOMER_TARGET_ADMISSION_UNPROVEN'; entries.push(entry); continue;
        }
      }
      // Business reserve policy is a separate input from technical holds.
      // An explicit no-extra-reserve policy may supply keep:0 with its source;
      // missing policy is never silently interpreted as that choice.
      const reserve = typeof keepPolicy === 'function' ? synchronous(keepPolicy({ context: clone(context), itemId: entry.artId, purpose: 'customer-finish' })) : keepPolicy;
      if (reserve?.known !== true || !nonnegative(reserve.keep) || typeof reserve.policyRef !== 'string' || !reserve.policyRef) {
        entry.reasonCode = 'CUSTOMER_FINISHED_STOCK_KEEP_POLICY_UNKNOWN'; entries.push(entry); continue;
      }
      entry.keepPolicy = { known: true, keep: reserve.keep, policyRef: reserve.policyRef };
      const budget = synchronous(resources.budget({ context, itemId: entry.artId, keep: reserve.keep, quantity: entry.need,
        claimingOperationId: null, requireOwnReservation: false }));
      if (!budget || typeof budget !== 'object') throw new TypeError('Shared item budget returned no explicit result');
      entry.budget = clone(budget);
      if (budget.known === true && nonnegative(budget.available)) {
        entry.availableDeficitKnown = true; entry.availableDeficit = Math.max(0, entry.need - budget.available);
      }
      if (budget.known !== true || !nonnegative(budget.available) || typeof budget.accountingVersion !== 'string' ||
        !Array.isArray(budget.basisRefs) || !budget.basisRefs.length) entry.reasonCode = budget.reasonCode || 'CUSTOMER_FINISHED_STOCK_UNKNOWN';
      else if (budget.available < entry.need || budget.allowed !== true) entry.reasonCode = nonnegative(budget.effectiveLowerBound) &&
        budget.effectiveLowerBound >= reserve.keep + entry.need ? 'CUSTOMER_WAIT_RESOURCE_RESERVATION' : 'CUSTOMER_WAIT_ART_CAPABILITY';
      else if (selected) entry.reasonCode = 'CUSTOMER_FAIR_ALLOCATION_PENDING_EARLIER_ORDER';
      else {
        entry.reasonCode = 'CUSTOMER_FINISHED_STOCK_ALLOCATED'; entry.allocatedQuantity = entry.need;
        selected = { decisionRef: decision.decisionRef, lifecycleRef: decision.lifecycleRef, npcId: entry.npcId,
          artId: entry.artId, quantity: entry.need, contentFingerprint: identity.contentFingerprint,
          firstSeenSequence: decision.firstSeenSequence, configRevision: decision.configRevision,
          featureCancelEpoch: decision.featureCancelEpoch, policyFingerprint: decision.policyFingerprint,
          accountingVersion: budget.accountingVersion, basisRefs: clone(budget.basisRefs), keepPolicy: clone(entry.keepPolicy),
          resourceKind: 'item', resourceRef: 'item:' + entry.artId, targetAdmission: entry.targetAdmission,
          requiresHistoricalTargetAdmission: entry.targetAdmission?.known !== true || entry.targetAdmission?.allowed !== true };
      }
      entries.push(entry);
    }
    if (synchronous(isCurrent(context)) !== true) return result(false, 'CUSTOMER_ALLOCATION_CONTEXT_NOT_CURRENT', null, []);
    // Later orders are only explanatory entries, never partially reserved.
    return result(true, selected ? 'CUSTOMER_FINISHED_STOCK_SINGLE_SELECTION' : 'CUSTOMER_NO_FULLY_STOCKED_ACCEPTED_ORDER', selected, entries, queueVersion);
  }
  return Object.freeze({ plan });
}
