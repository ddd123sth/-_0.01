import { canonical, clone, fingerprint, freeze, newId, parseStored, problem } from '../../common.mjs';
import { customerContext, knownCustomerCell } from './wire-facts.mjs';
import { customerOrderFingerprint } from './identity.mjs';
import { CUSTOMER_FINISH_CONTRACT } from './rpc-contract.mjs';
import { createCustomerAdmission } from './admission.mjs';
import { evaluateCustomerEligibility } from './eligibility.mjs';
import { createCustomerVerification, hasProvenCustomerUnexpectedDebit, validateCustomerSnapshotCoverage, validateCustomerTargetVerification } from './verification.mjs';
import { createCustomerRejection } from './rejection.mjs';
import { createCustomerGeneration } from './generation-runtime.mjs';

export const CUSTOMER_POST_READ = Object.freeze({ contractId: 'customer-fresh-login/after-physical-close/v1', kind: 'after-close-login',
  method: 'index.login', args: {}, evidenceRef: 'g3a/normal-fresh-login/provided-109-and-absolute-bag/v1' });
const keepPolicy = Object.freeze({ known: true, keep: 0, policyRef: 'customer.md/4+8.1/G3A-finished-stock/no-extra-business-reserve' });
const scalar = cell => knownCustomerCell(cell) ? cell.value : null;
const source = value => value ? { ...Object.fromEntries(['method', 'responseRef', 'wireKey', 'connectionEpoch', 'requestSequence'].map(key => [key, value[key] ?? null])),
  kind: value.kind ?? value.sourceKind ?? value.source ?? null } : null;

export function createCustomerRuntime({ store, readModel, identity, acceptance, allocation, resources, catalog,
  ledgerView, legacyConstraints, isolationEvidence, isCurrent, clock, validateReadSnapshotLease, readProfile, readGenerationFacts, readArtFeasibility, requestFreshLogin, appendOutbox,
  dynamicState = null, currentNeedFacts = null }) {
  const admission = createCustomerAdmission({ store, readModel, identity, resources, ledgerView, legacyConstraints, isCurrent,
    catalog, appendOutbox, currentNeedFacts, isolationEvidence });
  const rejection = createCustomerRejection({ store, readModel, identity, acceptance, resources, ledgerView, legacyConstraints,
    isCurrent, readProfile, validateReadSnapshotLease, readArtFeasibility, appendOutbox, currentNeedFacts, isolationEvidence });
  const generation = createCustomerGeneration({ store, readModel, identity, isCurrent, clock, readGenerationFacts, catalog,
    eligibility: (context, config, view = null) => view
      ? evaluateCustomerEligibility({ context, view, clock: clock(context.subjectRef), catalog: catalog.forContext?.(context) ?? catalog })
      : plan(context, config).eligibility, ledgerView, legacyConstraints, isolationEvidence, readProfile,
    validateReadSnapshotLease, requestFreshLogin, appendOutbox, currentNeedFacts });
  const domainRuntime = method => method === 'orderCustomer.rejectOrder' ? rejection : method === 'orderCustomer.genOrder' ? generation : admission;
  const verification = createCustomerVerification({ isLeaseCurrent: ({ proposal, response, bridge }) => {
    const proof = validateReadSnapshotLease({ leaseRef: bridge.leaseRef, operationId: proposal.operationId,
      originalContext: bridge.originalContext, newContext: bridge.newContext, after: bridge.after, bridgeFingerprint: bridge.bridgeFingerprint });
    return proof?.valid === true && proof.current === true;
  } });
  store.run(`CREATE TABLE IF NOT EXISTS backend_customer_action_guards(owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    reason_code TEXT NOT NULL,evidence_json TEXT NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref))`);
  store.run(`CREATE TABLE IF NOT EXISTS backend_customer_cost_guard_events(guard_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    method TEXT NOT NULL,contract_id TEXT NOT NULL,art_id INTEGER NOT NULL,operation_id TEXT NOT NULL,evidence_json TEXT NOT NULL,
    evidence_fingerprint TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
  store.run('CREATE INDEX IF NOT EXISTS backend_customer_cost_guard_lookup ON backend_customer_cost_guard_events(owner_ref,subject_ref,method,contract_id,art_id)');
  for (const action of ['UPDATE', 'DELETE']) store.run(`CREATE TRIGGER IF NOT EXISTS backend_customer_cost_guard_events_no_${action.toLowerCase()} BEFORE ${action} ON backend_customer_cost_guard_events
    BEGIN SELECT RAISE(ABORT,'customer cost guard events are append only'); END`);
  function customerCostGuard(context, artId) {
    const rows = store.all(`SELECT evidence_json FROM backend_customer_cost_guard_events WHERE owner_ref=? AND subject_ref=?
      AND method='orderCustomer.finishOrder' AND contract_id=? AND art_id=?`, context.ownerRef, context.subjectRef,
    CUSTOMER_FINISH_CONTRACT.contractId, artId);
    return rows.some(row => {
      const proof = parseStored(row.evidence_json, '顾客交付成本限制证据');
      return proof.method === 'orderCustomer.finishOrder' && proof.contractId === CUSTOMER_FINISH_CONTRACT.contractId &&
        Number.isSafeInteger(proof.artId) && proof.artId === artId && hasProvenCustomerUnexpectedDebit(proof.evidence);
    });
  }
  const wait = reasonCode => ({ state: 'waiting-facts', reasonCode, deviceDueMs: Date.now() + 30000 });
  function plan(context, config) {
    const view = readModel.snapshot(context), identities = identity.listCurrent({ context });
    const currentCatalog = catalog.forContext?.(context) ?? catalog;
    const decisions = view.orders.map(order => acceptance.evaluate({ context, order,
      identity: identities.identities.find(one => one.npcId === order.npcId), config }));
    return { view, identities, decisions, allocation: allocation.plan({ context, identityView: identities, decisions, keepPolicy }),
      eligibility: evaluateCustomerEligibility({ context, view, clock: clock(context.subjectRef), catalog: currentCatalog }) };
  }
  function demandSnapshot(context, config) {
    const finish = (current, reasonCode = null, entries = []) => ({ current, reasonCode, entries,
      protectedItems: Object.fromEntries(entries.reduce((map, row) => map.set(row.artId, (map.get(row.artId) || 0) + row.quantity), new Map())) });
    if (!context || isCurrent(context) !== true) return finish(false, 'CUSTOMER_DEMAND_CONTEXT_NOT_CURRENT');
    const policy = config?.config?.orders?.customer;
    if (typeof policy?.enabled !== 'boolean') return finish(false, 'CUSTOMER_DEMAND_CONFIG_UNKNOWN');
    if (policy.enabled !== true) return finish(true);
    const view = readModel.snapshot(context), identities = identity.listCurrent({ context });
    const currentCatalog = catalog.forContext?.(context) ?? catalog;
    const decisions = view.orders.map(order => acceptance.evaluate({ context, order,
      identity: identities.identities.find(one => one.npcId === order.npcId), config }));
    const open = evaluateCustomerEligibility({ context, view, clock: clock(context.subjectRef), catalog: currentCatalog }).customerOpen;
    if (open?.known !== true || open.value !== true) {
      return finish(false, open?.reasonCode || 'CUSTOMER_DEMAND_OPEN_INPUTS_UNKNOWN');
    }
    const entries = [];
    for (const decision of decisions) {
      if (decision.verdict !== 'accepted' || decision.accepted !== true) continue;
      const identity = identities.identities.find(one => one.npcId === decision.npcId);
      const order = view.orders.find(one => one.npcId === decision.npcId);
      if (!identity || identity.current !== true || identity.identityKnown !== true || identity.lifecycleRef !== decision.lifecycleRef ||
          order?.current !== true || order.readable !== true || customerOrderFingerprint(order) !== decision.order?.contentFingerprint ||
          identity.contentFingerprint !== decision.order?.contentFingerprint ||
          !Number.isSafeInteger(decision.order?.artId) || decision.order.artId <= 0 ||
          !Number.isSafeInteger(decision.order?.need) || decision.order.need <= 0 ||
          decision.configRevision !== config.savedRevision || decision.featureCancelEpoch !== config.featureCancelEpochs?.['order.customer']) {
        return finish(false, 'CUSTOMER_DEMAND_ACCEPTED_ORDER_BINDING_INVALID');
      }
      entries.push({ artId: decision.order.artId, quantity: decision.order.need, npcId: decision.npcId,
        memberKey: 'customer:' + decision.lifecycleRef, targetRef: 'customer-order:' + context.subjectRef + ':' + decision.npcId,
        lifecycleRef: decision.lifecycleRef,
        decisionRef: decision.decisionRef, contentFingerprint: decision.order.contentFingerprint,
        orderSourceRef: order.source?.responseRef || null });
    }
    return finish(true, null, entries);
  }
  function evaluateAdditionalOpen(context, name) {
    const view = readModel.snapshot(context), currentCatalog = catalog.forContext?.(context) ?? catalog;
    return evaluateCustomerEligibility({ context, view, clock: clock(context.subjectRef), catalog: currentCatalog,
      additionalOpenId: name }).additionalOpen;
  }
  function selectedOrder(plan, npcId) { return plan.view.orders.find(order => order.npcId === npcId); }
  async function assess(input, actionKey = null) {
    if (input.config.config.orders.customer.enabled !== true) return { state: 'disabled', reasonCode: 'CUSTOMER_DISABLED' };
    if (!isCurrent(input.context)) return wait('CUSTOMER_CONTEXT_NOT_CURRENT');
    if (actionKey === null || actionKey === 'generate') {
      const refreshed = await generation.refreshExpiredSnapshot(input);
      if (refreshed) return refreshed;
    }
    // Historical unexpected-cost receipts remain recorded below, but a
    // subject-wide guard would incorrectly block independent rejection and
    // generation actions. The current branch must pass its own typed facts,
    // resource budget and before-send admission checks.
    const current = plan(input.context, input.config);
    if (!current.eligibility.customerOpen.known || current.eligibility.customerOpen.value !== true) return wait(current.eligibility.customerOpen.reasonCode || 'CUSTOMER_OPEN_UNPROVEN');
    const selected = current.allocation.selected;
    if (actionKey === 'generate') return selected ? { state: 'no-action', reasonCode: 'CUSTOMER_DELIVERY_HAS_PRIORITY' } : generation.assess(input);
    if (actionKey === 'reject') {
      if (selected || input.config.config.orders.customer.autoReject !== true) return { state: 'no-action', reasonCode: 'CUSTOMER_REJECTION_NOT_CURRENTLY_ELIGIBLE' };
      return await rejection.assess(input) || { state: 'no-action', reasonCode: 'CUSTOMER_REJECTION_NO_CURRENT_CANDIDATE' };
    }
    if (!selected) {
      if (actionKey === 'delivery') return { state: 'no-action', reasonCode: 'CUSTOMER_NO_CURRENT_DELIVERY_CANDIDATE' };
      const rejected = input.config.config.orders.customer.autoReject === true ? await rejection.assess(input) : null;
      if (rejected?.state === 'proposals') return rejected;
      const generated = await generation.assess(input);
      return generated.state === 'no-action' ? rejected || wait(current.allocation.reasonCode || 'CUSTOMER_WAIT_CONFIRMED_STOCK') : generated;
    }
    if (customerCostGuard(input.context, selected.artId)) return wait('CUSTOMER_FINISH_COST_CONTRACT_REQUIRES_VERIFIED_UPDATE');
    const order = selectedOrder(current, selected.npcId), memberKey = 'customer:' + selected.lifecycleRef;
    const balance = resources.balance({ context: input.context, itemId: selected.artId });
    const reservation = resources.reservationSpec({ context: input.context, itemId: selected.artId, quantity: selected.quantity,
      memberKey, lifecycleRef: selected.lifecycleRef });
    const decision = current.decisions.find(one => one.npcId === selected.npcId);
    const proposal = { ...clone(input.context), operationId: newId(), proposalId: newId(), featureId: 'order.customer', scope: 'order-customer',
      method: 'orderCustomer.finishOrder', params: { npcId: selected.npcId, guestNpcIdList: [] },
      semanticKey: 'customer-finish:' + selected.lifecycleRef, configRevision: input.config.savedRevision,
      featureCancelEpoch: input.config.featureCancelEpochs['order.customer'],
      targets: [{ memberKey, targetKind: 'customer-order', targetRef: 'customer-order:' + input.context.subjectRef + ':' + selected.npcId,
        lifecycleRef: selected.lifecycleRef, targetFingerprint: selected.contentFingerprint }],
      resources: [reservation], resourceBindings: [{ resourceKey: reservation.resourceKey, memberKey, quantity: selected.quantity }],
      customer: { npcId: selected.npcId, artId: selected.artId, need: selected.quantity, lifecycleRef: selected.lifecycleRef,
        contentFingerprint: selected.contentFingerprint, acceptedDecisionRef: selected.decisionRef, allocationRef: current.allocation.allocationRef,
        officialUid: scalar(current.view.identity.uid), versionEvidence: clone(current.view.versionBinding), keepPolicy,
        beforeOrder: { npcId: selected.npcId, ...Object.fromEntries(Object.entries(order.fields).map(([key, cell]) => [key, scalar(cell)])) },
        beforeStock: { itemId: selected.artId, quantity: balance.base.value, basisRef: reservation.basisRef, source: source(balance.base.source) },
        rewardQuantity: decision.reward.quantity, eligibilityProof: current.eligibility.proofFingerprint } };
    proposal.paramsFingerprint = fingerprint(proposal.params);
    const businessNeedRef = 'business-need:' + fingerprint({ ownerRef: input.context.ownerRef, subjectRef: input.context.subjectRef,
      featureId: proposal.featureId, targetRef: proposal.targets[0].targetRef, lifecycleRef: selected.lifecycleRef, action: proposal.method });
    const oldUnknown = ledgerView.currentAdmission({ ownerRef: input.context.ownerRef, subjectRef: input.context.subjectRef,
      targetRefs: [proposal.targets[0].targetRef] })?.unresolvedOperations
      ?.map(row => ledgerView.operation(row.operation_id)).find(old => old?.feature_id === proposal.featureId && old.business_verdict === 'unknown' &&
        old.targets?.some(target => (target.target_ref ?? target.original?.targetRef) === proposal.targets[0].targetRef));
    const decisionGeneration = fingerprint({ ownerRef: input.context.ownerRef, subjectRef: input.context.subjectRef,
      connectionEpoch: input.context.connectionEpoch, loginResponseRef: current.view.identity.source?.responseRef,
      lifecycleRef: selected.lifecycleRef, contentFingerprint: selected.contentFingerprint, decisionRef: selected.decisionRef,
      stock: [balance.base.value, balance.basisRef, balance.accountingVersion], quantity: selected.quantity,
      eligibility: current.eligibility.proofFingerprint });
    proposal.customer.currentNeed = { necessary: true, featureId: proposal.featureId, targetRef: proposal.targets[0].targetRef,
      businessNeedRef, decisionGeneration, needRef: 'current-need:' + fingerprint([proposal.featureId, proposal.targets[0].targetRef, businessNeedRef]),
      semanticFingerprint: fingerprint({ decisionGeneration, shortage: selected.quantity, accepted: true }),
      basisRefs: [current.view.identity.source.responseRef, balance.basisRef] };
    proposal.semanticKey = 'customer-finish:' + selected.lifecycleRef + ':' + decisionGeneration;
    const needClaim = admission.claimCurrentNeed({ proposal });
    if (needClaim?.accepted !== true) return wait(needClaim?.reasonCode || 'CUSTOMER_CURRENT_NEED_CLAIM_FAILED');
    proposal.customer.currentNeed.claimRef = needClaim.claimRef;
    if (oldUnknown) proposal.traceId = oldUnknown.trace_id || oldUnknown.original?.traceId || oldUnknown.operation_id;
    proposal.factBasis = admission.readFactBasis({ proposal, actor: input.context, boundary: 'before-prepare' });
    const allowed = admission.evaluateAdmission({ proposal, actor: input.context, factBasis: proposal.factBasis, boundary: 'before-prepare' });
    return allowed.allowed ? { state: 'proposals', proposals: [freeze(proposal)], factBasis: proposal.factBasis } : wait(allowed.reasonCode);
  }
  function qualify({ proposal, actor, config, factBasis, boundary, ownReservation }) {
    if (proposal.method === 'orderCustomer.genOrder') return generation.qualify({ proposal, actor, config, factBasis, boundary, ownReservation });
    if (proposal.method === 'orderCustomer.rejectOrder') {
      const open = plan(customerContext(proposal), config).eligibility.customerOpen;
      if (!open.known || open.value !== true) return { allowed: false, targetsCurrent: false, resourcesCurrent: false,
        reasonCode: open.reasonCode || 'CUSTOMER_OPEN_UNPROVEN' };
      return rejection.qualify({ proposal, actor, config, factBasis, boundary, ownReservation });
    }
    if (customerCostGuard(customerContext(proposal), proposal.customer.artId)) return { allowed: false, targetsCurrent: false,
      resourcesCurrent: false, reasonCode: 'CUSTOMER_FINISH_COST_CONTRACT_REQUIRES_VERIFIED_UPDATE' };
    const context = customerContext(proposal), current = plan(context, config), order = selectedOrder(current, proposal.params.npcId);
    const decision = current.decisions.find(one => one.npcId === proposal.params.npcId);
    const validTarget = isCurrent(context) && current.view.current && order?.current && order.readable && decision?.accepted === true &&
      decision.lifecycleRef === proposal.targets[0].lifecycleRef && decision.order.contentFingerprint === proposal.targets[0].targetFingerprint &&
      current.eligibility.customerOpen.known && current.eligibility.customerOpen.value === true;
    const budget = resources.budget({ context, itemId: proposal.customer.artId, quantity: proposal.customer.need, keep: keepPolicy.keep,
      claimingOperationId: boundary === 'before-send' ? proposal.operationId : null, requireOwnReservation: boundary === 'before-send' });
    return { allowed: !!validTarget && budget.known && budget.allowed, targetsCurrent: !!validTarget,
      resourcesCurrent: budget.known && budget.allowed, reasonCode: !validTarget ? 'CUSTOMER_CURRENT_ORDER_OR_POLICY_CHANGED' : budget.reasonCode };
  }
  const finishContract = { ...CUSTOMER_FINISH_CONTRACT, postRead: { ...CUSTOMER_POST_READ, validateResponseCoverage: validateCustomerSnapshotCoverage },
    validateTargetVerification: validateCustomerTargetVerification };
  const feature = Object.freeze({ featureId: 'order.customer', consumedDomains: ['customer', 'customer-eligibility', 'profile', 'inventory', 'clock', 'customer-day'],
    currentNeedContracts: Object.freeze({ 'orderCustomer.finishOrder': Object.freeze({ path: 'customer.currentNeed', required: true }),
      'orderCustomer.rejectOrder': Object.freeze({ path: 'customer.currentNeed', required: true }),
      'orderCustomer.genOrder': Object.freeze({ path: 'customer.currentNeed', required: true }) }),
    consumeCurrentNeed: input => input?.proposal?.method === 'orderCustomer.rejectOrder'
      ? rejection.consumeCurrentNeed(input) : input?.proposal?.method === 'orderCustomer.finishOrder' ? admission.consumeCurrentNeed(input)
        : input?.proposal?.method === 'orderCustomer.genOrder' ? generation.consumeCurrentNeed(input) : { accepted: false, reasonCode: 'CUSTOMER_CURRENT_NEED_METHOD_UNSUPPORTED' },
    consumedDomainsFor: ({ method, actionKey }) => method === 'orderCustomer.genOrder' || actionKey === 'generate'
      ? ['customer', 'customer-eligibility', 'profile', 'customer-day', 'inventory', 'clock']
      : ['customer', 'customer-eligibility', 'profile', 'inventory', 'clock'],
    scheduleUnits: Object.freeze([
      Object.freeze({ scheduleKey: 'order.customer:delivery', allowedMethods: ['orderCustomer.finishOrder'], allowedScopes: ['order-customer'], consumedDomains: ['customer', 'customer-eligibility', 'profile', 'inventory', 'clock'],
        consumedDomainsFor: () => ['customer', 'customer-eligibility', 'profile', 'inventory', 'clock'], assess: input => assess(input, 'delivery') }),
      Object.freeze({ scheduleKey: 'order.customer:reject', allowedMethods: ['orderCustomer.rejectOrder'], allowedScopes: ['order-reject'], consumedDomains: ['customer', 'customer-eligibility', 'profile', 'clock'],
        consumedDomainsFor: () => ['customer', 'customer-eligibility', 'profile', 'clock'], assess: input => assess(input, 'reject') }),
      Object.freeze({ scheduleKey: 'order.customer:generation', allowedMethods: ['orderCustomer.genOrder'], allowedScopes: ['order-customer-gen'], quotaKeys: ['order.customer:generation'],
        consumedDomains: ['customer', 'customer-eligibility', 'profile', 'inventory', 'clock', 'customer-day'],
        consumedDomainsFor: () => ['customer', 'customer-eligibility', 'profile', 'inventory', 'clock', 'customer-day'],
        assess: input => assess(input, 'generate') }),
    ]),
    scopes: ['order-customer', 'order-reject', 'order-customer-gen'], methods: ['orderCustomer.finishOrder', 'orderCustomer.rejectOrder', 'orderCustomer.genOrder'],
    methodScopes: Object.freeze({ 'orderCustomer.finishOrder': 'order-customer', 'orderCustomer.rejectOrder': 'order-reject', 'orderCustomer.genOrder': 'order-customer-gen' }),
    release: 'validation-only', implementationVersion: 'customer-stock-single/v1', contractRef: 'customer.md/G3A-stock+after-physical-close-login/v1',
    wakeKey: 'order.customer', priority: 0, factDomains: ['customer', 'inventory', 'bag', 'land-domain'], factRequirements: [],
    operationContract: finishContract, operationContracts: { 'orderCustomer.finishOrder': finishContract, 'orderCustomer.rejectOrder': rejection.operationContract,
      'orderCustomer.genOrder': generation.operationContract },
    assess, assessAction: assess, qualify, verify: input => (input.proposal.method === 'orderCustomer.rejectOrder' ? rejection : input.proposal.method === 'orderCustomer.genOrder' ? generation : verification).verify(input) });
  function onSettled(event) {
    if (event.proposal.featureId !== 'order.customer') throw problem('CUSTOMER_SETTLEMENT_SCOPE_INVALID', '原交付结算不属于顾客域');
    if (event.proposal.method !== 'orderCustomer.finishOrder') {
      appendOutbox({ ownerRef: event.proposal.ownerRef, subjectRef: event.proposal.subjectRef, eventType: event.proposal.method === 'orderCustomer.genOrder' ? 'CustomerGenerationAudited' : 'CustomerRejectionAudited',
        eventKey: event.proposal.operationId, payload: { operationId: event.proposal.operationId, verdict: event.verification.verdict,
          originalConnectionEpoch: event.proposal.connectionEpoch, currentEffectsPublished: false } });
      return;
    }
    const coverage = resources.planCoverage({ context: customerContext(event.proposal), operation: event.operation,
      targetSettlement: event.targetSettlement, postRead: event.postReads.at(-1), sendBinding: event.sendBinding, postReadBridge: event.postReadBridge });
    resources.applyCoverage(coverage);
    if (event.verification.reasonCode === 'CUSTOMER_FINISH_UNEXPECTED_COST' &&
        hasProvenCustomerUnexpectedDebit(event.verification.evidence)) {
      const proof = { version: 'customer-finish-cost-contract-guard/v1', method: 'orderCustomer.finishOrder',
        contractId: CUSTOMER_FINISH_CONTRACT.contractId, artId: event.proposal.customer.artId,
        operationId: event.proposal.operationId, evidence: event.verification.evidence };
      const guardRef = 'customer-cost-guard:' + fingerprint({ ownerRef: event.proposal.ownerRef, subjectRef: event.proposal.subjectRef,
        method: proof.method, contractId: proof.contractId, artId: proof.artId, operationId: proof.operationId, evidence: proof.evidence });
      store.run('INSERT OR IGNORE INTO backend_customer_cost_guard_events VALUES(?,?,?,?,?,?,?,?,?,?)', guardRef, event.proposal.ownerRef,
        event.proposal.subjectRef, proof.method, proof.contractId, proof.artId, event.proposal.operationId, canonical(proof), fingerprint(proof), store.nowIso());
    }
    appendOutbox({ ownerRef: event.proposal.ownerRef, subjectRef: event.proposal.subjectRef, eventType: 'CustomerOperationAudited',
      eventKey: event.proposal.operationId, payload: { operationId: event.proposal.operationId, verdict: event.verification.verdict,
        originalConnectionEpoch: event.proposal.connectionEpoch, currentEffectsPublished: false } });
  }
  return Object.freeze({ feature,
    readFactBasis: input => domainRuntime(input.proposal.method).readFactBasis(input),
    evaluateAdmission: input => domainRuntime(input.proposal.method).evaluateAdmission(input), onSettled,
    onCurrentVerified: () => {}, planning: plan, demandSnapshot, evaluateAdditionalOpen });
}
