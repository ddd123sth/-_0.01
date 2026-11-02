import { canonical, clone, fingerprint, freeze, newId, parseStored, problem } from '../../common.mjs';
import { ledgerJsonFingerprint } from '../../persistence/json-contract.mjs';
import { customerContext, sameCustomerContext, knownCustomerCell } from './wire-facts.mjs';
import { customerOrderContent, customerOrderFingerprint } from './identity.mjs';
import { CUSTOMER_REJECT_CONTRACT, CUSTOMER_REJECT_POST_READ, assertCustomerRejectProposal } from './rejection-contract.mjs';
import { createCustomerRejectVerification, validateCustomerRejectSnapshotCoverage, validateCustomerRejectTargetVerification } from './rejection-verification.mjs';
import { assessCustomerImpossibility } from './impossibility.mjs';
import { createCurrentNeedReconciler } from '../../execution/current-need.mjs';
import { NORMAL_SYNC_METHODS } from '../../facts/normal-sync-contract.mjs';
import { currentOfficialDataEvidence } from '../../official-data-evidence.mjs';

const VERSION = 'customer-policy-reject/single-v1';
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const scalar = one => knownCustomerCell(one) ? one.value : null;
const sync = value => { if (value?.then) { value.catch?.(() => {}); throw new TypeError('Customer rejection ports must be synchronous'); } return value; };
const METHODS = new Set(NORMAL_SYNC_METHODS);
const safeSource = one => one ? { kind: one.kind ?? one.sourceKind ?? one.source ?? null, method: one.method ?? null,
  connectionEpoch: one.connectionEpoch ?? null, requestSequence: one.requestSequence ?? null,
  wireKey: one.wireKey ?? null, responseRef: one.responseRef ?? null } : null;
const sourceKnown = (one, context) => safeSource(one)?.kind === 'response' && METHODS.has(one.method) && one.connectionEpoch === context.connectionEpoch &&
  positive(one.requestSequence) && reference(one.wireKey) && reference(one.responseRef);
const denied = reasonCode => freeze({ allowed: false, reasonCode, historicalConstraintsChecked: true, currentInFlightChecked: true });

// Policy filtering and strictly evidenced current physical impossibility are
// separate causes. Unknowns, disabled crafting and technical holds never reject.
export function createCustomerRejection({ store, readModel, identity, acceptance, resources, ledgerView, legacyConstraints,
  isCurrent, readProfile, validateReadSnapshotLease, readArtFeasibility = null, appendOutbox = () => {}, currentNeedFacts = null,
  isolationEvidence = null } = {}) {
  for (const [name, fn] of Object.entries({ get: store?.get, snapshot: readModel?.snapshot, identities: identity?.listCurrent,
    acceptance: acceptance?.evaluate, balance: resources?.balance, operation: ledgerView?.operation,
    currentAdmission: ledgerView?.currentAdmission, candidateProjection: legacyConstraints?.candidateProjection,
    isCurrent, readProfile, validateReadSnapshotLease })) {
    if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') throw new TypeError('Customer rejection requires synchronous port: ' + name);
  }
  if (readArtFeasibility !== null && (typeof readArtFeasibility !== 'function' || readArtFeasibility.constructor?.name === 'AsyncFunction')) throw new TypeError('Art feasibility must be a synchronous current report port');
  const active = context => sync(isCurrent(context)) === true;
  const currentNeedReconciler = createCurrentNeedReconciler({ store, ledgerView, isolationEvidence });
  const wait = reasonCode => ({ state: 'waiting-facts', reasonCode, deviceDueMs: Date.now() + 30000 });
  const verification = createCustomerRejectVerification({ isLeaseCurrent: ({ proposal, bridge }) => {
    const checked = sync(validateReadSnapshotLease({ leaseRef: bridge.leaseRef, operationId: proposal.operationId,
      originalContext: bridge.originalContext, newContext: bridge.newContext, after: bridge.after, bridgeFingerprint: bridge.bridgeFingerprint }));
    return checked?.valid === true && checked.current === true;
  } });
  const operationContract = freeze({ ...CUSTOMER_REJECT_CONTRACT,
    postRead: { ...CUSTOMER_REJECT_POST_READ, validateResponseCoverage: validateCustomerRejectSnapshotCoverage },
    validateTargetVerification: validateCustomerRejectTargetVerification });
  function configuration(context) {
    const row = store.get('SELECT dto_json,saved_revision,feature_cancel_json,subject_ref FROM backend_config_heads WHERE owner_ref=? AND account_ref=?', context.ownerRef, context.accountRef);
    return row?.subject_ref === context.subjectRef ? { config: parseStored(row.dto_json, '政策拒单当前配置'), savedRevision: row.saved_revision,
      featureCancelEpochs: parseStored(row.feature_cancel_json, '政策拒单取消代际') } : null;
  }
  function policy(config) {
    const value = config?.config?.orders?.customer, selected = value?.coinTiers;
    const valid = Array.isArray(selected) && selected.every(one => [1, 2, 3].includes(one)) && new Set(selected).size === selected.length;
    return { enabled: typeof value?.enabled === 'boolean' ? value.enabled : null, autoReject: typeof value?.autoReject === 'boolean' ? value.autoReject : null,
      coinTiers: valid ? [...selected].sort((a, b) => a - b) : null,
      featureCancelEpoch: nonnegative(config?.featureCancelEpochs?.['order.customer']) ? config.featureCancelEpochs['order.customer'] : null };
  }
  function readState(proposal, configOverride = null) {
    assertCustomerRejectProposal(proposal);
    const context = customerContext(proposal);
    if (!context) throw problem('CUSTOMER_REJECT_CONTEXT_INVALID', '政策拒单需要完整当前归属和连接代际');
    const view = sync(readModel.snapshot(context)), identities = sync(identity.listCurrent({ context }));
    const order = view?.orders?.find(one => one.npcId === proposal.params.npcId), life = identities?.identities?.find(one => one.npcId === proposal.params.npcId);
    const config = configOverride || configuration(context), decision = order && life ? sync(acceptance.evaluate({ context, order, identity: life, config })) : null;
    const profile = sync(readProfile({ context, itemIds: [proposal.customer.artId, 1002] }));
    const items = [proposal.customer.artId, 1002].map(itemId => ({ itemId, balance: profile?.items?.[itemId] ?? null }));
    const physical = proposal.customer.rejectCause ? assessCustomerImpossibility({ context, view, order, life, decision, config,
      report: readArtFeasibility ? sync(readArtFeasibility(context, config)) : null }) : null;
    return { context, view, identities, order, life, config, policy: policy(config), decision, profile, items, physical, proposal };
  }
  function basisFor(state) {
    return freeze({ version: state.physical ? 'customer-physical-reject/single-v1' : VERSION, target: { npcId: state.order?.npcId ?? null, lifecycleRef: state.life?.lifecycleRef ?? null,
      contentFingerprint: state.order ? customerOrderFingerprint(state.order) : null,
      content: state.order ? customerOrderContent(state.order) : null, identityKnown: state.life?.identityKnown === true },
      officialIdentity: { uid: scalar(state.view?.identity?.uid), gameVersion: state.view?.versionBinding?.gameVersion ?? null,
        protocolVersion: state.view?.versionBinding?.protocolVersion ?? null }, policy: state.policy,
      ...(state.physical ? { acceptedDecisionRef: state.decision?.decisionRef ?? null } : { filteredDecisionRef: state.decision?.decisionRef ?? null }),
      policyFingerprint: state.decision?.policyFingerprint ?? null,
      balances: state.items.map(({ itemId, balance }) => ({ itemId, known: balance?.base?.known === true,
        quantity: balance?.base?.known === true ? balance.base.value : null, accountingVersion: balance?.accountingVersion ?? null })),
      profile: { gold: scalar(state.profile?.profile?.gold), yb: scalar(state.profile?.profile?.yuanbao) }, currentNeedEvidence: state.proposal?.customer?.currentNeed ?? null,
      ...(state.physical ? { physicalCause: state.physical.impossible ? clone(state.physical.cause.evidence.basis) : null,
        physicalCauseKnown: state.physical.known, physicalReasonCode: state.physical.reasonCode } : {}) });
  }
  function currentSnapshotFor(state) {
    const source = state.view?.identity?.source, version = state.view?.versionBinding;
    const shared = currentNeedFacts?.({ context: state.context, featureId: 'order.customer', method: state.proposal?.method,
      proposal: state.proposal, config: state.config?.config });
    const projectSource = one => one && ({ method: one.method, responseRef: one.responseRef, requestSequence: one.requestSequence,
      connectionEpoch: one.connectionEpoch, ...(one.method === 'index.login' ? { kind: 'login', gameVersion: version?.gameVersion,
        protocolVersion: version?.protocolVersion } : {}) });
    const sourceProofs = shared?.sourceProofs?.length ? shared.sourceProofs.map(projectSource) : [source, state.view?.orderMap?.source, state.order?.source, state.life?.source,
      ...(state.identities?.identities || []).map(one => one?.source), state.profile?.profile?.gold?.source, state.profile?.profile?.yuanbao?.source,
      ...((state.items || []).flatMap(one => [one.source, one.balance?.base?.source, one.balance?.ext?.source]))]
      .filter(one => one?.kind === 'response' && reference(one.responseRef) && reference(one.method) && positive(one.requestSequence) && positive(one.connectionEpoch))
      .map(projectSource)
      .filter((one, index, all) => all.findIndex(other => canonical(other) === canonical(one)) === index);
    return { complete: (!currentNeedFacts || shared?.complete === true) && state.view?.current === true && state.view?.identity?.verified === true && state.identities?.complete === true &&
        state.view?.orderMap?.current === true && state.view.orderMap.state === 'known' && state.view.orderMap.sourceProvidedCollectionComplete === true &&
        state.view.orderMap.returnedComplete === true && state.view.orderMap.truncated === false && state.view.orderMap.total === state.view.orderMap.entries?.length &&
        state.order?.current === true && state.order?.readable === true && state.life?.current === true && state.life?.identityKnown === true &&
        state.profile?.current === true && state.items.every(one => one.balance?.base?.known === true),
      identityVerified: state.view?.identity?.verified === true, method: source?.method, responseRef: source?.responseRef,
      requestSequence: source?.requestSequence, connectionEpoch: source?.connectionEpoch, officialUid: scalar(state.view?.identity?.uid),
      gameVersion: version?.gameVersion, protocolVersion: version?.protocolVersion, sourceProofs };
  }
  function readFactBasis({ proposal } = {}) { return basisFor(readState(proposal)); }
  function currentError(state, proposal) {
    const { context, view, identities, life, order, decision, profile, policy: currentPolicy } = state;
    const map = view?.orderMap, source = map?.source;
    if (!active(context) || !sameCustomerContext(context, view?.context) || view.current !== true || view.identity?.verified !== true ||
      scalar(view.identity.uid) !== proposal.customer.officialUid || !map?.current || map.presence !== 'present' || map.state !== 'known' ||
      map.sourceProvidedCollectionComplete !== true || map.returnedComplete !== true || map.truncated !== false || map.total !== map.entries?.length ||
      !sourceKnown(source, context) ||
      source.version?.protocolVersion !== '480.0.0' || source.version?.loginResponseRef !== source.responseRef ||
      !(source.version?.gameVersion === '480.0.27' || currentOfficialDataEvidence(source.version, 'customer.reject')) ||
      canonical(view.versionBinding) !== canonical(proposal.customer.versionEvidence)) return 'CUSTOMER_REJECT_CURRENT_COMPLETE_BOARD_REQUIRED';
    if (currentPolicy.enabled !== true || currentPolicy.autoReject !== true || currentPolicy.coinTiers === null ||
      currentPolicy.featureCancelEpoch !== proposal.featureCancelEpoch) return 'CUSTOMER_REJECT_POLICY_NOT_ENABLED';
    if (!identities?.current || !identities.complete || !sameCustomerContext(context, identities.context) || !life?.current || !life.identityKnown ||
      !sameCustomerContext(context, life.context) || life.lifecycleRef !== proposal.customer.lifecycleRef ||
      life.contentFingerprint !== proposal.customer.contentFingerprint || !order?.current || !order.readable ||
      customerOrderFingerprint(order) !== life.contentFingerprint || life.source?.responseRef !== order.source?.responseRef ||
      life.source?.connectionEpoch !== order.source?.connectionEpoch || life.source?.requestSequence !== order.source?.requestSequence ||
      decision?.autoRejectKnown !== true || decision.policyFingerprint !== proposal.customer.policyFingerprint) return 'CUSTOMER_REJECT_CURRENT_IDENTITY_REQUIRED';
    if (proposal.customer.rejectCause) {
      if (decision?.verdict !== 'accepted' || decision.accepted !== true || decision.decisionRef !== proposal.customer.acceptedDecisionRef ||
        state.physical?.known !== true || state.physical.impossible !== true ||
        state.physical.cause.reportFingerprint !== proposal.customer.rejectCause.reportFingerprint ||
        state.physical.cause.reasonCode !== proposal.customer.rejectCause.reasonCode) return state.physical?.reasonCode || 'CUSTOMER_PHYSICAL_REJECT_PROOF_CHANGED';
    } else if (decision?.verdict !== 'filtered' || decision.policyRejectionEligible !== true || decision.decisionRef !== proposal.customer.filteredDecisionRef) return 'CUSTOMER_REJECT_EXPLICIT_FILTERED_IDENTITY_REQUIRED';
    if (profile?.current !== true || !sameCustomerContext(profile.context, context) || profile.identity?.verified !== true ||
      scalar(profile.identity.uid) !== proposal.customer.officialUid || !nonnegative(scalar(profile.profile?.gold)) ||
      !nonnegative(scalar(profile.profile?.yuanbao)) || !sourceKnown(profile.profile.gold?.source, context) ||
      !sourceKnown(profile.profile.yuanbao?.source, context)) return 'CUSTOMER_REJECT_PROFILE_BALANCES_UNPROVEN';
    if (scalar(profile.profile.gold) !== proposal.customer.beforeProfile.gold || scalar(profile.profile.yuanbao) !== proposal.customer.beforeProfile.yb) return 'CUSTOMER_REJECT_ORIGINAL_PROFILE_CHANGED';
    for (const { itemId, balance } of state.items) {
      const original = proposal.customer.beforeItems.find(one => one.itemId === itemId);
      if (!balance?.base?.known || !nonnegative(balance.base.value) || !sourceKnown(balance.base.source, context) ||
        !original || original.quantity !== balance.base.value || original.basisRef !== balance.basisRef) return 'CUSTOMER_REJECT_ORIGINAL_ITEM_BALANCE_CHANGED';
    }
    return null;
  }
  function historyError(state, proposal, factBasis, boundary, ownReservation) {
    const beforeSend = boundary === 'before-send', context = state.context;
    if (!['before-prepare', 'before-send'].includes(boundary) || beforeSend &&
      (ownReservation?.required !== true || ownReservation.operationId !== proposal.operationId) || !beforeSend && ownReservation?.required === true) return 'CUSTOMER_REJECT_OWN_OPERATION_BOUNDARY_INVALID';
    const current = sync(ledgerView.currentAdmission({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
      targetRefs: [proposal.targets[0].targetRef, ...(proposal.customer?.artId ? ['flower-art:' + context.subjectRef + ':' + proposal.customer.artId] : [])] }));
    if (!Array.isArray(current?.unresolvedOperations)) return 'CUSTOMER_REJECT_ADMISSION_UNAVAILABLE';
    if (current.activeOperation && (!beforeSend || current.activeOperation.operation_id !== proposal.operationId)) return 'CUSTOMER_REJECT_CURRENT_WRITE_IN_FLIGHT';
    if (beforeSend) {
      const own = sync(ledgerView.operation(proposal.operationId));
      if (!own || own.owner_ref !== context.ownerRef || own.account_ref !== context.accountRef || own.subject_ref !== context.subjectRef ||
        own.run_epoch !== context.runEpoch || own.connection_epoch !== context.connectionEpoch || own.original?.ownerEpoch !== context.ownerEpoch ||
        own.write_slot !== 1 || !['not_started', 'may_have_sent'].includes(own.transport_state) || own.feature_id !== 'order.customer' ||
        own.scope !== 'order-reject' || own.method !== 'orderCustomer.rejectOrder' || own.semantic_key !== proposal.semanticKey ||
        own.params_fingerprint !== proposal.paramsFingerprint || canonical(own.original.targets) !== canonical(proposal.targets) ||
        own.original.resources?.length !== 0 || own.original.resourceBindings?.length !== 0 || own.resources?.length !== 0 || own.resourceBindings?.length !== 0) return 'CUSTOMER_REJECT_OWN_ORIGINAL_OPERATION_CHANGED';
    }
    const currentClaim = sync(currentNeedReconciler.isClaimCurrent({ claimRef: proposal.customer.currentNeed?.claimRef,
      context, currentSnapshot: currentSnapshotFor(state), currentNeed: proposal.customer.currentNeed,
      operationId: boundary === 'before-send' ? proposal.operationId : null }));
    if (currentClaim?.accepted !== true) return currentClaim?.reasonCode || 'CUSTOMER_REJECT_CURRENT_NEED_CLAIM_INVALID';
    const previous = store.get("SELECT operation_id,business_verdict FROM backend_operations WHERE owner_ref=? AND subject_ref=? AND feature_id='order.customer' AND semantic_key IN (?,?) AND transport_state!='not_sent' AND operation_id!=? LIMIT 1",
      context.ownerRef, context.subjectRef, 'customer-finish:' + proposal.customer.lifecycleRef, 'customer-reject:' + proposal.customer.lifecycleRef, proposal.operationId);
    if (previous && !['unverified', 'unknown'].includes(previous.business_verdict)) return 'CUSTOMER_REJECT_ORIGINAL_LIFECYCLE_ALREADY_SETTLED';
    for (const unresolved of current.unresolvedOperations) {
      if (unresolved.operation_id === proposal.operationId) continue;
      if (unresolved.owner_ref !== context.ownerRef || unresolved.subject_ref !== context.subjectRef) continue;
      const original = sync(ledgerView.operation(unresolved.operation_id));
      if (!original) return 'CUSTOMER_REJECT_UNRESOLVED_OPERATION_UNREADABLE';
      const matchingTarget = original.targets?.find(target => (target.target_ref ?? target.original?.targetRef) === proposal.targets[0].targetRef);
      if (matchingTarget) {
        if (original.feature_id !== 'order.customer' || !['order-reject', 'order-customer'].includes(original.scope)) return 'CUSTOMER_REJECT_TARGET_RESULT_UNKNOWN';
        proposal.traceId ||= original.trace_id || original.original?.traceId || original.operation_id;
        const reconciled = sync(currentNeedReconciler.reconcile({ context, originalOperationId: original.operation_id,
            currentSnapshot: currentSnapshotFor(state), currentNeed: proposal.customer.currentNeed, operationId: proposal.operationId }));
        if (reconciled?.accepted !== true) return reconciled?.reasonCode || 'CUSTOMER_REJECT_CURRENT_NEED_RECONCILIATION_UNAVAILABLE';
        sync(appendOutbox({ ownerRef: context.ownerRef, subjectRef: context.subjectRef, eventType: 'CurrentNeedAutomaticallyReconciled',
          eventKey: reconciled.reconciliationRef, payload: { traceId: original.trace_id || original.original?.traceId || original.operation_id,
              operationId: proposal.operationId, originalOperationId: original.operation_id, featureId: proposal.featureId,
              targetRef: proposal.targets[0].targetRef, reasonCode: 'CURRENT_OFFICIAL_SNAPSHOT_PROVES_CUSTOMER_ACTION_NECESSARY',
              reconciliationRef: reconciled.reconciliationRef, attempted: false } }));
      }
      if (proposal.customer.rejectCause && original.feature_id === 'art.make') {
        const productTargetMatches = original.targets?.some(target => (target.target_ref ?? target.original?.targetRef) === 'flower-art:' + context.subjectRef + ':' + proposal.customer.artId);
        const prepared = store.get("SELECT kind,source,payload_json,payload_fingerprint,observed_at FROM backend_operation_evidence WHERE operation_id=? AND kind='finite-domain-preparation' AND source='backend/write-gateway/v2' LIMIT 1", original.operation_id);
        if (!prepared) { if (productTargetMatches) return 'CUSTOMER_PHYSICAL_REJECT_UNKNOWN_ART_PARENT_UNREADABLE'; continue; }
        const payload = parseStored(prepared.payload_json, '原未知制作父单');
        if (ledgerJsonFingerprint({ kind: prepared.kind, source: prepared.source, payload, observedAt: prepared.observed_at }) !== prepared.payload_fingerprint ||
            payload.domain !== 'art' || !/^customer-life:[a-f0-9]{64}$/.test(payload.preparation?.parentLifecycleRef || '')) {
          if (productTargetMatches) return 'CUSTOMER_PHYSICAL_REJECT_UNKNOWN_ART_PARENT_UNREADABLE'; continue;
        }
        if (payload.preparation?.parentLifecycleRef === proposal.customer.lifecycleRef) return 'CUSTOMER_PHYSICAL_REJECT_PARENT_MAKE_RESULT_UNKNOWN';
      }
    }
    const currentAdmission = sync(ledgerView.currentAdmission({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
      targetRefs: [proposal.targets[0].targetRef] }));
    const baselineRef = currentAdmission?.resourceBaseline?.baselineRef ?? null;
    const reconciled = sync(currentNeedReconciler.reconcileLegacyCandidate({ context, currentSnapshot: currentSnapshotFor(state),
      currentNeed: proposal.customer.currentNeed, legacyConstraints, isolationEvidence,
      rawTargetRefs: [proposal.targets[0].targetRef], rawResourceKeys: [], semanticKey: proposal.semanticKey, factBasis,
      candidateFingerprint: fingerprint({ semanticKey: proposal.semanticKey, paramsFingerprint: proposal.paramsFingerprint,
        targets: proposal.targets, factBasis }), action: proposal.method,
      methodScope: ['orderCustomer.finishOrder', 'orderCustomer.rejectOrder'], resourceBaselineRef: baselineRef }));
    if (reconciled?.accepted !== true) return reconciled?.reasonCode || 'CUSTOMER_REJECT_LEGACY_CURRENT_NEED_UNPROVEN';
    const activeLegacy = reconciled.projection;
    if (!Array.isArray(activeLegacy?.operations) || !Array.isArray(activeLegacy.semanticMatches)) return 'CUSTOMER_REJECT_LEGACY_SCOPE_UNREADABLE';
    if (activeLegacy.semanticMatches.length || activeLegacy.operations.some(one => one.scope === 'order-customer' ||
      typeof one.method === 'string' && one.method.startsWith('orderCustomer.') || one.scope === 'order-reject' && !reference(one.method))) return 'CUSTOMER_REJECT_LEGACY_CUSTOMER_TARGET_MAPPING_UNPROVEN';
    return null;
  }
  function evaluateAdmission({ proposal, actor, factBasis, boundary = 'before-prepare', ownReservation = null } = {}) {
    const state = readState(proposal);
    if (!sameCustomerContext(state.context, customerContext(actor))) return denied('CUSTOMER_REJECT_ACTOR_CONTEXT_CHANGED');
    if (canonical(basisFor(state)) !== canonical(factBasis)) return denied('CUSTOMER_REJECT_FACT_BASIS_CHANGED');
    const error = currentError(state, proposal) || historyError(state, proposal, factBasis, boundary, ownReservation);
    if (error) return denied(error);
    if (!active(state.context)) return denied('CUSTOMER_REJECT_CONTEXT_REVOKED');
    return freeze({ allowed: true, historicalConstraintsChecked: true, currentInFlightChecked: true, reasonCode: null,
      candidateFingerprint: fingerprint({ semanticKey: proposal.semanticKey, paramsFingerprint: proposal.paramsFingerprint, targets: proposal.targets, factBasis }) });
  }
  function qualify(input) {
    const checked = evaluateAdmission(input);
    return { ...checked, targetsCurrent: checked.allowed === true, resourcesCurrent: checked.allowed === true };
  }
  async function assess(input) {
    const context = customerContext(input.context), config = input.config, currentPolicy = policy(config);
    if (currentPolicy.enabled !== true || currentPolicy.autoReject !== true) return { state: 'disabled', reasonCode: 'CUSTOMER_POLICY_REJECTION_DISABLED' };
    if (!context || !active(context)) return wait('CUSTOMER_REJECT_CONTEXT_NOT_CURRENT');
    const view = sync(readModel.snapshot(context)), identities = sync(identity.listCurrent({ context }));
    if (!view.current || !identities.current || !identities.complete) return wait('CUSTOMER_REJECT_CURRENT_IDENTITIES_REQUIRED');
    const report = readArtFeasibility && config.config.art?.makeEnabled === true ? sync(readArtFeasibility(context, config)) : null;
    const candidates = view.orders.map(order => ({ order, life: identities.identities.find(one => one.npcId === order.npcId) }))
      .map(one => ({ ...one, decision: sync(acceptance.evaluate({ context, order: one.order, identity: one.life, config })) }))
      .map(one => ({ ...one, physical: one.decision.verdict === 'accepted' ? assessCustomerImpossibility({ context, view, ...one, config, report }) : null }))
      .filter(one => (one.decision.verdict === 'filtered' && one.decision.policyRejectionEligible === true || one.physical?.impossible === true) && one.life?.identityKnown && one.life.current)
      .sort((a, b) => a.life.firstSeenSequence - b.life.firstSeenSequence || a.order.npcId - b.order.npcId);
    let lastReason = 'CUSTOMER_NO_POLICY_FILTERED_REJECT_CANDIDATE';
    for (const candidate of candidates) {
      const { order, life, decision } = candidate, artId = scalar(order.fields.artId), need = scalar(order.fields.num);
      const profile = sync(readProfile({ context, itemIds: [artId, 1002] }));
      if (!profile?.current || !sameCustomerContext(profile.context, context) || profile.identity?.verified !== true ||
        scalar(profile.identity.uid) !== scalar(view.identity.uid) || !profile.items?.[artId]?.base?.known || !profile.items?.[1002]?.base?.known ||
        ![artId, 1002].every(id => nonnegative(profile.items[id].base.value) && sourceKnown(profile.items[id].base.source, context)) ||
        !nonnegative(scalar(profile.profile?.gold)) || !nonnegative(scalar(profile.profile?.yuanbao)) ||
        !sourceKnown(profile.profile.gold?.source, context) || !sourceKnown(profile.profile.yuanbao?.source, context)) {
        lastReason = 'CUSTOMER_REJECT_ORIGINAL_BALANCES_NOT_OBSERVED'; continue;
      }
      const customer = { npcId: order.npcId, artId, need, lifecycleRef: life.lifecycleRef, contentFingerprint: life.contentFingerprint,
        ...(candidate.physical?.impossible ? { acceptedDecisionRef: decision.decisionRef, rejectCause: clone(candidate.physical.cause) } : { filteredDecisionRef: decision.decisionRef }),
        policyFingerprint: decision.policyFingerprint, officialUid: scalar(view.identity.uid),
        versionEvidence: clone(view.versionBinding),
        beforeOrder: { npcId: order.npcId, sourceRef: order.source?.responseRef || null,
          ...Object.fromEntries(Object.entries(order.fields).map(([key, cell]) => [key, scalar(cell)])) },
        beforeItems: [artId, 1002].map(itemId => { const balance = profile.items[itemId]; return { itemId, quantity: balance.base.value,
          basisRef: balance.basisRef, source: safeSource(balance.base.source) }; }),
        beforeProfile: { gold: scalar(profile.profile.gold), yb: scalar(profile.profile.yuanbao),
          goldSource: safeSource(profile.profile.gold.source), ybSource: safeSource(profile.profile.yuanbao.source),
          source: safeSource(profile.profile.gold.source) } };
      const proposal = { ...clone(context), operationId: newId(), proposalId: newId(), featureId: 'order.customer', scope: 'order-reject',
        method: 'orderCustomer.rejectOrder', semanticKey: 'customer-reject:' + life.lifecycleRef,
        configRevision: config.savedRevision, featureCancelEpoch: config.featureCancelEpochs['order.customer'],
        params: { npcId: order.npcId, guestNpcIdList: [] }, customer,
        targets: [{ memberKey: 'customer:' + life.lifecycleRef, targetKind: 'customer-order', targetRef: 'customer-order:' + context.subjectRef + ':' + order.npcId,
          lifecycleRef: life.lifecycleRef, targetFingerprint: life.contentFingerprint }], resources: [], resourceBindings: [] };
      proposal.paramsFingerprint = fingerprint(proposal.params);
      const currentState = { context, view, identities, order, life, profile,
        items: customer.beforeItems.map(one => ({ itemId: one.itemId, balance: profile.items[one.itemId] })) };
      const currentSnapshot = currentSnapshotFor(currentState);
      const decisionGeneration = fingerprint({ ownerRef: context.ownerRef, subjectRef: context.subjectRef, connectionEpoch: context.connectionEpoch,
        snapshot: currentSnapshot.responseRef, targetRef: proposal.targets[0].targetRef, lifecycleRef: life.lifecycleRef,
        contentFingerprint: life.contentFingerprint, decisionRef: decision.decisionRef, policyFingerprint: decision.policyFingerprint,
        balances: customer.beforeItems.map(one => [one.itemId, one.quantity, one.basisRef]), profile: [customer.beforeProfile.gold, customer.beforeProfile.yb],
        physicalCause: customer.rejectCause?.reportFingerprint ?? null });
      const businessNeedRef = 'business-need:' + fingerprint({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
        featureId: proposal.featureId, targetRef: proposal.targets[0].targetRef, lifecycleRef: life.lifecycleRef,
        action: proposal.method });
      customer.currentNeed = { necessary: true, featureId: proposal.featureId, targetRef: proposal.targets[0].targetRef, businessNeedRef,
        decisionGeneration, needRef: 'current-need:' + fingerprint([proposal.featureId, proposal.targets[0].targetRef, businessNeedRef]),
        semanticFingerprint: fingerprint({ decisionGeneration, policyFingerprint: decision.policyFingerprint,
          cause: customer.rejectCause?.reportFingerprint ?? null }),
        basisRefs: [...new Set([currentSnapshot.responseRef, ...customer.beforeItems.map(one => one.basisRef), customer.beforeProfile.goldSource.responseRef,
          customer.beforeProfile.ybSource.responseRef,
          ...currentSnapshot.sourceProofs.map(one => one.responseRef)])] };
      const oldUnknown = sync(ledgerView.currentAdmission({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
        targetRefs: [proposal.targets[0].targetRef] }))?.unresolvedOperations
        ?.map(row => sync(ledgerView.operation(row.operation_id))).find(old => old?.feature_id === proposal.featureId && old.business_verdict === 'unknown' &&
          old.targets?.some(target => (target.target_ref ?? target.original?.targetRef) === proposal.targets[0].targetRef));
      proposal.semanticKey = 'customer-reject:' + life.lifecycleRef + ':' + decisionGeneration;
      const claimed = sync(currentNeedReconciler.claimCurrent({ context, currentSnapshot, currentNeed: customer.currentNeed }));
      if (claimed?.accepted !== true) { lastReason = claimed?.reasonCode || 'CUSTOMER_REJECT_CURRENT_NEED_CLAIM_FAILED'; continue; }
      customer.currentNeed.claimRef = claimed.claimRef;
      proposal.factBasis = readFactBasis({ proposal });
      const admission = evaluateAdmission({ proposal, actor: context, factBasis: proposal.factBasis, boundary: 'before-prepare' });
      if (admission.allowed) return { state: 'proposals', proposals: [freeze(proposal)], factBasis: proposal.factBasis };
      lastReason = admission.reasonCode;
    }
    return wait(lastReason);
  }
  return Object.freeze({ assess, qualify, readFactBasis, evaluateAdmission,
    consumeCurrentNeed: ({ proposal }) => currentNeedReconciler.consumeCurrentNeed({ claimRef: proposal.customer.currentNeed?.claimRef,
      operationId: proposal.operationId, decisionGeneration: proposal.customer.currentNeed?.decisionGeneration,
      currentNeed: proposal.customer.currentNeed, featureId: proposal.featureId }), verify: verification.verify,
    operationContract, postReadContract: CUSTOMER_REJECT_POST_READ });
}
