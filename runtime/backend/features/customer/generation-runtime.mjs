import { canonical, clone, fingerprint, freeze, newId, parseStored } from '../../common.mjs';
import { hashLedgerBytes, ledgerJsonFingerprint } from '../../persistence/json-contract.mjs';
import { customerContext, knownCustomerCell, sameCustomerContext } from './wire-facts.mjs';
import { customerOrderFingerprint } from './identity.mjs';
import { evaluateCustomerGeneration, CUSTOMER_GENERATION_STATIC } from './generation.mjs';
import { CUSTOMER_GENERATION_CONTRACT, CUSTOMER_GENERATION_POST_READ, GENERATION_ORDER_FIELDS,
  assertCustomerGenerationProposal, generationSource, generationSourceKnown, generationOpenNpcPolicy,
  CUSTOMER_GENERATION_OPEN_NPC_SOURCE } from './generation-contract.mjs';
import { createCustomerGenerationVerification } from './generation-verification.mjs';
import { createCurrentNeedReconciler } from '../../execution/current-need.mjs';

const VERSION = 'customer-generation-admission/headless-empty-stock-v1';
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const scalar = one => knownCustomerCell(one) ? one.value : null;
const sync = value => { if (value?.then) { value.catch?.(() => {}); throw new TypeError('Generation ports must be synchronous'); } return value; };
const deny = reasonCode => freeze({ allowed: false, reasonCode, historicalConstraintsChecked: true, currentInFlightChecked: true });
const wait = (reasonCode, officialDueMs = null) => ({ state: officialDueMs === null ? 'waiting-facts' : 'waiting-until', reasonCode,
  ...(officialDueMs === null ? { deviceDueMs: Date.now() + 30000 } : { officialDueMs }) });

export function customerGenerationCapSuspension({ decision, state, configRevision, staticPolicy = CUSTOMER_GENERATION_STATIC } = {}) {
  const { context, view, facts } = state || {}, day = facts?.officialDay, count = facts?.count107,
    currentClock = state?.clock, uid = scalar(view?.identity?.uid), board = view?.orderMap, stock = view?.orderStockList;
  if (decision?.state !== 'no-action' || decision.reasonCode !== 'CUSTOMER_GENERATION_DAILY_OPPORTUNITY_EXHAUSTED' ||
      view?.current !== true || view.identity?.verified !== true || !positive(uid) || !day?.known || !positive(day.startMs) ||
      !positive(day.endMs) || day.endMs <= day.startMs || !positive(day.endMs) || !Number.isFinite(currentClock?.nowMs) ||
      currentClock.available !== true || currentClock.source !== 'official-anchor-monotonic' || currentClock.connectionEpoch !== context?.connectionEpoch ||
      currentClock.nowMs < day.startMs || currentClock.nowMs >= day.endMs || typeof day.key !== 'string' || !day.key ||
      typeof day.proofRef !== 'string' || !day.proofRef || day.source?.officialUid !== uid ||
      !count || count.current !== true || count.uid !== uid || count.type !== 107 || !nonnegative(count.tdyCnt) || !positive(count.rTimeMs) ||
      !reference(count.source?.responseRef) ||
      board?.complete !== true || !Array.isArray(board.entries) || board.total !== board.entries.length ||
      stock?.complete !== true || stock.total !== 0 || stock.reportedEmpty !== true || !Array.isArray(decision.sources) || !decision.sources.length ||
      !positive(configRevision) || !positive(staticPolicy.dailyLimit)) return null;
  const effectiveCount = count.rTimeMs < day.startMs ? 0 : count.tdyCnt, used = effectiveCount + board.total + stock.total;
  if (!nonnegative(used) || used < staticPolicy.dailyLimit) return null;
  return { state: 'cap-wait', reasonCode: decision.reasonCode, suspension: { kind: 'period-cap', quotaKey: 'order.customer:generation',
    actionScope: 'order.customer:generation', periodKind: 'official-day', periodKey: day.key, periodEndOfficialMs: day.endMs,
    scope: 'official', used, limit: staticPolicy.dailyLimit, proofRefs: [...new Set([day.proofRef, count.source.responseRef,
      board.source?.responseRef, stock.source?.responseRef, staticPolicy.source?.gameDecodedSha256,
      staticPolicy.source?.sourceProof?.indexSha256, staticPolicy.source?.sourceProof?.gameSha256,
      staticPolicy.source?.sourceProof?.moSha256, staticPolicy.source?.dataSnapshotId, staticPolicy.source?.npcTableSha256]
      .filter(value => typeof value === 'string' && value.length > 0))], configRevision } };
}

export function createCustomerGeneration({ store, readModel, identity, isCurrent, clock, readGenerationFacts, eligibility, catalog,
  ledgerView, legacyConstraints, isolationEvidence = null, readLegacyOperation = null, readProfile, validateReadSnapshotLease,
  requestFreshLogin = null, appendOutbox = () => {}, currentNeedFacts = null } = {}) {
  for (const [name, fn] of Object.entries({ get: store?.get, snapshot: readModel?.snapshot, identities: identity?.listCurrent,
    isCurrent, clock, readGenerationFacts, eligibility, operation: ledgerView?.operation, currentAdmission: ledgerView?.currentAdmission,
    recordAdmissionBasis: ledgerView?.recordAdmissionBasis,
    legacyProjection: legacyConstraints?.candidateProjection, legacyAppendBasis: legacyConstraints?.appendBasis, readProfile, validateReadSnapshotLease })) {
    if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') throw new TypeError('Generation requires synchronous port: ' + name);
  }
  if (requestFreshLogin !== null && typeof requestFreshLogin !== 'function') throw new TypeError('Generation snapshot refresh port must be a function');
  if (isolationEvidence !== null && typeof isolationEvidence.read !== 'function') throw new TypeError('Generation isolation evidence must expose read');
  if (readLegacyOperation !== null && typeof readLegacyOperation !== 'function') throw new TypeError('Generation legacy operation reader must be a function');
  const active = context => sync(isCurrent(context)) === true;
  const currentNeedReconciler = createCurrentNeedReconciler({ store, ledgerView, isolationEvidence });
  function configuration(context) {
    const row = store.get('SELECT dto_json,saved_revision,feature_cancel_json,subject_ref FROM backend_config_heads WHERE owner_ref=? AND account_ref=?', context.ownerRef, context.accountRef);
    return row?.subject_ref === context.subjectRef ? { config: parseStored(row.dto_json, '顾客生成当前配置'), savedRevision: row.saved_revision,
      featureCancelEpochs: parseStored(row.feature_cancel_json, '顾客生成取消代际') } : null;
  }
  function stateFor(context, configOverride = null) {
    const config = configOverride || configuration(context), view = sync(readModel.snapshot(context)),
      facts = sync(readGenerationFacts(context, view)), open = sync(eligibility(context, config, view));
    const currentClock = sync(clock(context.subjectRef));
    const activeCatalog = catalog?.forContext?.(context) ?? catalog;
    const policy = activeCatalog?.generationPolicy?.() ?? (view?.versionBinding?.gameVersion === CUSTOMER_GENERATION_STATIC.gameVersion ? CUSTOMER_GENERATION_STATIC : null);
    const decision = evaluateCustomerGeneration({ context, view, config, eligibility: open, clock: currentClock, generationFacts: facts, staticPolicy: policy });
    const lives = sync(identity.listCurrent({ context })), profile = sync(readProfile({ context, itemIds: [] }));
    const board = (view.orderMap?.entries || []).map(row => ({ npcId: row.npcId,
      ...Object.fromEntries(GENERATION_ORDER_FIELDS.map(key => [key, scalar(row.fields[key])])), contentFingerprint: customerOrderFingerprint(row),
      lifecycleRef: lives.identities?.find(one => one.npcId === row.npcId)?.lifecycleRef ?? null }));
    return { context, config, view, facts, open, decision, lives, profile, board, policy };
  }
  function openNpcPolicy(state) {
    const task = state.view.eligibilityInputs?.mainTask;
    return generationOpenNpcPolicy({ context: state.context, mainTaskId: scalar(task?.curTaskId), source: task?.curTaskId?.source,
      staticPolicy: state.policy });
  }
  function currentSnapshotFor(state) {
    const { context, view, facts, profile } = state, identitySource = generationSource(view?.identity?.source),
      shared = currentNeedFacts?.({ context, featureId: 'order.customer', method: 'orderCustomer.genOrder', config: state.config?.config }),
      sourceRows = [identitySource, generationSource(view?.orderMap?.source), generationSource(view?.orderStockList?.source),
        generationSource(facts?.officialDay?.source), generationSource(facts?.count107?.source),
        generationSource(view?.eligibilityInputs?.mainTask?.curTaskId?.source), generationSource(view?.nextGenTime?.source),
        generationSource(profile?.profile?.gold?.source), generationSource(profile?.profile?.yuanbao?.source),
        generationSource(profile?.completeBagFingerprint?.source)].filter(one => generationSourceKnown(one, context)),
      sourceProofs = shared?.sourceProofs?.length ? shared.sourceProofs.map(one => ({ method: one.method,
        responseRef: one.responseRef, requestSequence: one.requestSequence, connectionEpoch: one.connectionEpoch })) : sourceRows.map(one => ({ method: one.method, responseRef: one.responseRef,
        requestSequence: one.requestSequence, connectionEpoch: one.connectionEpoch }))
        .filter((one, index, all) => all.findIndex(other => canonical(other) === canonical(one)) === index),
      version = view?.versionBinding;
    return { complete: (!currentNeedFacts || shared?.complete === true) && currentError(state) === null && view?.orderMap?.complete === true && view?.orderStockList?.complete === true &&
        view.orderStockList.reportedEmpty === true && sourceProofs.length > 0,
      identityVerified: view?.identity?.verified === true, method: identitySource?.method, responseRef: identitySource?.responseRef,
      requestSequence: identitySource?.requestSequence, connectionEpoch: identitySource?.connectionEpoch,
      officialUid: scalar(view?.identity?.uid), gameVersion: version?.gameVersion, protocolVersion: version?.protocolVersion, sourceProofs };
  }
  function currentNeedFor(state, proposal, decisionGeneration) {
    const currentSnapshot = currentSnapshotFor(state), targetRef = proposal.targets[0].targetRef,
      businessNeedRef = 'business-need:' + fingerprint({ ownerRef: state.context.ownerRef, subjectRef: state.context.subjectRef,
        featureId: proposal.featureId, targetRef, officialDay: proposal.generation.day.key, action: proposal.method });
    const currentNeed = { necessary: true, featureId: proposal.featureId, targetRef, businessNeedRef, decisionGeneration,
      needRef: 'current-need:' + fingerprint([proposal.featureId, targetRef, businessNeedRef]),
      semanticFingerprint: fingerprint({ decisionGeneration, opportunity: proposal.generation.businessFingerprint,
        remainingDailyOpportunity: proposal.generation.remainingDailyOpportunity, openRegularNpcIds: proposal.generation.openRegularNpcIds }),
      basisRefs: currentSnapshot.sourceProofs.map(one => one.responseRef) };
    return { currentSnapshot, currentNeed };
  }
  // This is the stable candidate basis. No clock sample, response/observation
  // ref, day proofRef, assessment ref, or random UUID may manufacture a second
  // opportunity or make an unchanged candidate supersede itself.
  function basisFor(state) {
    const { config, facts, profile, decision } = state, count = facts?.count107, day = facts?.officialDay;
    return freeze({ version: VERSION, opportunity: decision.opportunity?.businessFingerprint ?? null, state: decision.state,
      policy: { enabled: config?.config?.orders?.customer?.enabled ?? null, cancelEpoch: config?.featureCancelEpochs?.['order.customer'] ?? null },
      officialIdentity: { uid: scalar(state.view.identity?.uid), gameVersion: state.view.versionBinding?.gameVersion ?? null,
        protocolVersion: state.view.versionBinding?.protocolVersion ?? null },
      openNpcSet: { policyVersion: CUSTOMER_GENERATION_OPEN_NPC_SOURCE.version,
        mainTaskId: scalar(state.view.eligibilityInputs?.mainTask?.curTaskId),
        openNpcIds: decision.opportunity?.openNpcIds ?? [] },
      day: { known: day?.known === true, key: day?.key ?? null, startMs: day?.startMs ?? null, endMs: day?.endMs ?? null, utcOffsetMinutes: day?.utcOffsetMinutes ?? null },
      count107: { current: count?.current === true, uid: count?.uid ?? null, type: count?.type ?? null, rawTdyCnt: count?.tdyCnt ?? null,
        totCnt: count?.totCnt ?? null, rTimeMs: count?.rTimeMs ?? null },
      board: state.board, stock: { total: state.view.orderStockList?.total ?? null, complete: state.view.orderStockList?.complete === true },
      profile: { current: profile?.current === true, gold: scalar(profile?.profile?.gold), yb: scalar(profile?.profile?.yuanbao),
        completeBagKnown: profile?.completeBagFingerprint?.known === true, completeBagFingerprint: profile?.completeBagFingerprint?.fingerprint ?? null },
      currentNeedEvidence: state.currentNeed ?? null });
  }
  function currentError(state, proposal = null) {
    const { context, view, profile, facts, lives, decision } = state;
    if (!active(context) || !sameCustomerContext(context, view?.context) || view.current !== true || view.identity?.verified !== true) return 'CUSTOMER_GENERATION_CURRENT_IDENTITY_REQUIRED';
    if (decision.state !== 'opportunity') return decision.reasonCode;
    if (view.orderStockList.total !== 0 || view.orderStockList.reportedEmpty !== true) return 'CUSTOMER_GENERATION_FIRST_SCOPE_REQUIRES_EXPLICIT_EMPTY_STOCK';
    if (!lives.current || !lives.complete || !sameCustomerContext(context, lives.context) || state.board.some(row => {
      const life = lives.identities.find(one => one.npcId === row.npcId);
      return !life?.current || !life.identityKnown || !sameCustomerContext(context, life.context) || life.contentFingerprint !== row.contentFingerprint;
    })) return 'CUSTOMER_GENERATION_ORIGINAL_BOARD_IDENTITIES_REQUIRED';
    if (!nonnegative(facts.count107?.totCnt) || facts.officialDay?.source?.method !== 'index.login' ||
        facts.officialDay?.source?.officialUid !== scalar(view.identity.uid)) return 'CUSTOMER_GENERATION_DAY_COUNT_AND_BOARD_SNAPSHOT_REQUIRED';
    const bag = profile?.completeBagFingerprint;
    if (!profile?.current || !sameCustomerContext(context, profile.context) || profile.identity?.verified !== true || scalar(profile.identity.uid) !== scalar(view.identity.uid) ||
        !nonnegative(scalar(profile.profile?.gold)) || !nonnegative(scalar(profile.profile?.yuanbao)) ||
        !generationSourceKnown(profile.profile.gold?.source, context) || !generationSourceKnown(profile.profile.yuanbao?.source, context) ||
        bag?.known !== true || !digest(bag.fingerprint) || !nonnegative(bag.positiveItemCount) || bag.rule !== 'complete-absolute-bag-positive-integer-counts/zero-and-missing-equivalent/v1' ||
        !generationSourceKnown(bag.source, context)) return 'CUSTOMER_GENERATION_ORIGINAL_ABSOLUTE_PROFILE_REQUIRED';
    if (proposal && (decision.opportunity.businessFingerprint !== proposal.generation.businessFingerprint ||
        canonical(view.versionBinding) !== canonical(proposal.generation.versionEvidence) || scalar(view.identity.uid) !== proposal.generation.officialUid ||
        state.config.featureCancelEpochs['order.customer'] !== proposal.featureCancelEpoch ||
        ['key', 'startMs', 'endMs', 'utcOffsetMinutes'].some(key => facts.officialDay[key] !== proposal.generation.day[key]) ||
        facts.count107.tdyCnt !== proposal.generation.beforeCount.rawTdyCnt || facts.count107.totCnt !== proposal.generation.beforeCount.totCnt ||
        facts.count107.rTimeMs !== proposal.generation.beforeCount.rTimeMs || decision.opportunity.count107.effectiveValue !== proposal.generation.beforeCount.effectiveCount ||
        decision.opportunity.remainingDailyOpportunity !== proposal.generation.remainingDailyOpportunity ||
        canonical(decision.opportunity.availableRegularNpcIds) !== canonical(proposal.generation.openRegularNpcIds) ||
        scalar(profile.profile.gold) !== proposal.generation.beforeProfile.gold || scalar(profile.profile.yuanbao) !== proposal.generation.beforeProfile.yb ||
        bag.fingerprint !== proposal.generation.beforeProfile.completeBagFingerprint.fingerprint ||
        canonical(state.board) !== canonical(proposal.generation.beforeBoard))) return 'CUSTOMER_GENERATION_ORIGINAL_OPPORTUNITY_CHANGED';
    if (proposal?.generation.openNpcPolicy && canonical(openNpcPolicy(state)) !== canonical(proposal.generation.openNpcPolicy)) return 'CUSTOMER_GENERATION_COMPLETE_OPEN_NPC_SOURCE_CHANGED';
    return null;
  }
  function historyError(state, proposal, boundary, ownReservation, factBasis) {
    const context = state.context, beforeSend = boundary === 'before-send';
    if (!['before-prepare', 'before-send'].includes(boundary) || beforeSend &&
        (ownReservation?.required !== true || ownReservation.operationId !== proposal.operationId) || !beforeSend && ownReservation?.required === true) return 'CUSTOMER_GENERATION_OWN_OPERATION_BOUNDARY_INVALID';
    const current = sync(ledgerView.currentAdmission({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
      targetRefs: [proposal.targets[0].targetRef] }));
    if (!Array.isArray(current?.unresolvedOperations)) return 'CUSTOMER_GENERATION_ADMISSION_UNAVAILABLE';
    if (current.activeOperation && (!beforeSend || current.activeOperation.operation_id !== proposal.operationId)) return 'CUSTOMER_GENERATION_CURRENT_WRITE_IN_FLIGHT';
    if (beforeSend) {
      const own = sync(ledgerView.operation(proposal.operationId));
      if (!own || own.owner_ref !== context.ownerRef || own.account_ref !== context.accountRef || own.subject_ref !== context.subjectRef ||
          own.original?.ownerEpoch !== context.ownerEpoch || own.run_epoch !== context.runEpoch || own.connection_epoch !== context.connectionEpoch ||
          own.write_slot !== 1 || !['not_started', 'may_have_sent'].includes(own.transport_state) || own.feature_id !== 'order.customer' ||
          own.scope !== 'order-customer-gen' || own.method !== 'orderCustomer.genOrder' || own.semantic_key !== proposal.semanticKey ||
          own.params_fingerprint !== proposal.paramsFingerprint || typeof own.original_json !== 'string' ||
          hashLedgerBytes(own.original_json) !== own.original_fingerprint || own.original_fingerprint !== ledgerJsonFingerprint(own.original) ||
          canonical(own.original.targets) !== canonical(proposal.targets) || canonical(own.factBasis) !== canonical(proposal.factBasis) ||
          own.original.resources?.length !== 0 || own.original.resourceBindings?.length !== 0 || own.resources?.length !== 0 || own.resourceBindings?.length !== 0) return 'CUSTOMER_GENERATION_OWN_ORIGINAL_OPERATION_CHANGED';
    }
    const previous = store.get("SELECT operation_id,business_verdict FROM backend_operations WHERE owner_ref=? AND subject_ref=? AND feature_id='order.customer' AND semantic_key=? AND transport_state!='not_sent' AND operation_id!=? LIMIT 1",
      context.ownerRef, context.subjectRef, proposal.semanticKey, proposal.operationId);
    if (previous) return ['unverified', 'unknown'].includes(previous.business_verdict) ? 'CUSTOMER_GENERATION_ORIGINAL_OPPORTUNITY_UNKNOWN' : 'CUSTOMER_GENERATION_ORIGINAL_OPPORTUNITY_ALREADY_SETTLED';
    for (const unresolved of current.unresolvedOperations) {
      if (unresolved.operation_id === proposal.operationId) continue;
      if (unresolved.owner_ref !== context.ownerRef || unresolved.subject_ref !== context.subjectRef ||
          unresolved.feature_id !== 'order.customer' || unresolved.method !== 'orderCustomer.genOrder' && unresolved.scope !== 'order-customer-gen') continue;
      const original = sync(ledgerView.operation(unresolved.operation_id));
      if (!original || original.semantic_key === proposal.semanticKey) return 'CUSTOMER_GENERATION_EXACT_PRIOR_CUSTOMER_FLOW_ISOLATION_REQUIRED';
      const reconciled = sync(currentNeedReconciler.reconcile({ context, originalOperationId: original.operation_id,
        currentSnapshot: currentSnapshotFor(state), currentNeed: proposal.customer.currentNeed, operationId: proposal.operationId }));
      if (reconciled?.accepted !== true) return reconciled?.reasonCode || 'CUSTOMER_GENERATION_CURRENT_NEED_RECONCILIATION_UNAVAILABLE';
      proposal.traceId = original.trace_id || original.original?.traceId || original.operation_id;
      sync(appendOutbox({ ownerRef: context.ownerRef, subjectRef: context.subjectRef, eventType: 'CurrentNeedAutomaticallyReconciled',
        eventKey: reconciled.reconciliationRef, payload: { traceId: proposal.traceId, operationId: proposal.operationId,
          originalOperationId: original.operation_id, featureId: proposal.featureId, targetRef: proposal.targets[0].targetRef,
          reasonCode: 'CURRENT_OFFICIAL_SNAPSHOT_STILL_PROVES_CUSTOMER_GENERATION_NEEDED',
          reconciliationRef: reconciled.reconciliationRef, attempted: false } }));
      const candidateFingerprint = fingerprint({ semanticKey: proposal.semanticKey, paramsFingerprint: proposal.paramsFingerprint,
        targets: proposal.targets, factBasis });
      const separation = { version: 'customer-generation-current-need-separation/v1',
        reconciliationRef: reconciled.reconciliationRef, claimRef: reconciled.claimRef,
        originalOperationId: original.operation_id, originalFingerprint: original.original_fingerprint,
        originalOutcomeUnchanged: true, originalResourceFootprintsUnchanged: true };
      sync(ledgerView.recordAdmissionBasis({ operationId: original.operation_id,
        constraintKey: 'generation-opportunity:' + proposal.generation.businessFingerprint,
        basisKey: fingerprint([candidateFingerprint, separation]), conclusion: 'permit_current', factBasis,
        affected: { candidateFingerprint, semanticKey: proposal.semanticKey, targetRef: proposal.targets[0].targetRef,
          lifecycleRef: proposal.targets[0].lifecycleRef, originalOperationId: original.operation_id,
          originalOutcomeUnchanged: true, originalResourceFootprintsUnchanged: true }, evidence: separation,
        reasonCode: 'CUSTOMER_GENERATION_FRESH_OPPORTUNITY_AFTER_RETIRED_ZERO_RESOURCE_FLOW' }));
    }
    const currentAdmission = sync(ledgerView.currentAdmission({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
      targetRefs: proposal.targets.map(one => one.targetRef) }));
    const candidateFingerprint = fingerprint({ semanticKey: proposal.semanticKey, paramsFingerprint: proposal.paramsFingerprint,
      targets: proposal.targets, factBasis });
    const reconciled = sync(currentNeedReconciler.reconcileLegacyCandidate({ context, currentSnapshot: currentSnapshotFor(state),
      currentNeed: proposal.customer.currentNeed, legacyConstraints, isolationEvidence,
      rawTargetRefs: proposal.targets.map(one => one.targetRef), rawResourceKeys: [], semanticKey: proposal.semanticKey,
      factBasis, candidateFingerprint, action: proposal.method, methodScope: ['orderCustomer.genOrder'],
      resourceBaselineRef: currentAdmission?.resourceBaseline?.baselineRef ?? null }));
    if (reconciled?.accepted !== true) return reconciled?.reasonCode || 'CUSTOMER_GENERATION_LEGACY_CURRENT_NEED_UNPROVEN';
    const activeLegacy = reconciled.projection;
    if (!Array.isArray(activeLegacy?.operations) || !Array.isArray(activeLegacy.semanticMatches)) return 'CUSTOMER_GENERATION_LEGACY_SCOPE_UNREADABLE';
    if (activeLegacy.operations.some(row => row.method === 'orderCustomer.genOrder' || row.scope === 'order-customer-gen') ||
        activeLegacy.semanticMatches.length) return 'CUSTOMER_GENERATION_LEGACY_CURRENT_NEED_UNRESOLVED';
    return null;
  }
  function readFactBasis({ proposal } = {}) {
    assertCustomerGenerationProposal(proposal); const state = stateFor(customerContext(proposal));
    state.currentNeed = proposal.customer?.currentNeed ?? null; return basisFor(state);
  }
  function evaluateAdmission({ proposal, actor, factBasis, boundary = 'before-prepare', ownReservation = null } = {}) {
    assertCustomerGenerationProposal(proposal);
    const context = customerContext(proposal), state = stateFor(context);
    if (!sameCustomerContext(context, customerContext(actor))) return deny('CUSTOMER_GENERATION_ACTOR_CHANGED');
    state.currentNeed = proposal.customer?.currentNeed ?? null;
    if (canonical(basisFor(state)) !== canonical(factBasis)) return deny('CUSTOMER_GENERATION_FACT_BASIS_CHANGED');
    const claim = sync(currentNeedReconciler.isClaimCurrent({ claimRef: proposal.customer?.currentNeed?.claimRef, context,
      currentSnapshot: currentSnapshotFor(state), currentNeed: proposal.customer?.currentNeed,
      operationId: boundary === 'before-send' ? proposal.operationId : null }));
    if (claim?.accepted !== true) return deny(claim?.reasonCode || 'CUSTOMER_GENERATION_CURRENT_NEED_CLAIM_NOT_CURRENT');
    const error = currentError(state, proposal) || historyError(state, proposal, boundary, ownReservation, factBasis);
    if (error) return deny(error);
    if (!active(context)) return deny('CUSTOMER_GENERATION_CONTEXT_REVOKED');
    return freeze({ allowed: true, reasonCode: null, historicalConstraintsChecked: true, currentInFlightChecked: true,
      candidateFingerprint: fingerprint({ semanticKey: proposal.semanticKey, paramsFingerprint: proposal.paramsFingerprint, targets: proposal.targets, factBasis }) });
  }
  function qualify(input) {
    const checked = evaluateAdmission(input);
    return { ...checked, targetsCurrent: checked.allowed, resourcesCurrent: checked.allowed };
  }
  async function refreshExpiredSnapshot(input) {
    const context = customerContext(input?.context);
    if (!context || !active(context)) return null;
    const facts = sync(readGenerationFacts(context)), requirement = facts?.snapshotRefresh;
    if (requirement?.required !== true || requirement.reasonCode !== 'CUSTOMER_OFFICIAL_DAY_SNAPSHOT_EXPIRED' ||
      typeof requirement.snapshotRef !== 'string' || !requirement.snapshotRef) return null;
    if (!requestFreshLogin) return wait('CUSTOMER_GENERATION_FRESH_LOGIN_PORT_UNAVAILABLE');
    const result = await requestFreshLogin({ context, snapshotRef: requirement.snapshotRef, reasonCode: requirement.reasonCode });
    // The old scheduler context is invalid as soon as refresh is accepted. Its
    // caller still checks current after every await; no old proposal survives.
    return wait(result?.refreshed === true ? 'CUSTOMER_GENERATION_FRESH_LOGIN_ESTABLISHED' : result?.reasonCode || 'CUSTOMER_GENERATION_FRESH_LOGIN_PENDING');
  }
  async function assess(input) {
    if (input.config?.config?.orders?.customer?.enabled !== true) return { state: 'disabled', reasonCode: 'CUSTOMER_DISABLED' };
    const context = customerContext(input.context);
    if (!context || !active(context)) return wait('CUSTOMER_GENERATION_CONTEXT_NOT_CURRENT');
    const refreshed = await refreshExpiredSnapshot(input); if (refreshed) return refreshed;
    if (!active(context)) return wait('CUSTOMER_GENERATION_CONTEXT_NOT_CURRENT');
    const state = stateFor(context, input.config), decision = state.decision;
    if (decision.state !== 'opportunity') {
      const cap = customerGenerationCapSuspension({ decision, state: { ...state, clock: sync(clock(context.subjectRef)) },
        configRevision: input.config.savedRevision, staticPolicy: state.policy });
      if (cap) return cap;
      return decision.earliestOfficialMs !== null && decision.earliestOfficialMs > sync(clock(context.subjectRef)).nowMs
      ? wait(decision.reasonCode, decision.earliestOfficialMs) : wait(decision.reasonCode);
    }
    const error = currentError(state); if (error) return wait(error);
    const opportunity = decision.opportunity, businessFingerprint = opportunity.businessFingerprint, lifecycleRef = 'customer-generation-life:' + businessFingerprint;
    const count = state.facts.count107, profile = state.profile;
    const proposal = { ...clone(context), operationId: newId(), proposalId: newId(), featureId: 'order.customer', scope: 'order-customer-gen', method: 'orderCustomer.genOrder',
      semanticKey: null, configRevision: input.config.savedRevision, featureCancelEpoch: input.config.featureCancelEpochs['order.customer'],
      params: { guestNpcIdList: [] }, targets: [{ memberKey: 'customer-generation:' + businessFingerprint, targetKind: 'customer-generation',
        targetRef: 'customer-generation:' + context.subjectRef + ':' + state.facts.officialDay.key, lifecycleRef, targetFingerprint: businessFingerprint }],
      resources: [], resourceBindings: [], generation: { businessFingerprint, lifecycleRef, day: clone(state.facts.officialDay),
        beforeBoard: clone(state.board), beforeStock: [], boardSource: generationSource(state.view.orderMap.source),
        policy: clone(state.policy),
        beforeCount: { rawTdyCnt: count.tdyCnt, totCnt: count.totCnt, rTimeMs: count.rTimeMs, effectiveCount: opportunity.count107.effectiveValue, source: generationSource(count.source) },
        openRegularNpcIds: [...opportunity.availableRegularNpcIds], openNpcPolicy: openNpcPolicy(state),
        officialUid: scalar(state.view.identity.uid), versionEvidence: clone(state.view.versionBinding),
        beforeProfile: { gold: scalar(profile.profile.gold), yb: scalar(profile.profile.yuanbao), source: generationSource(profile.profile.gold.source),
          goldSource: generationSource(profile.profile.gold.source), ybSource: generationSource(profile.profile.yuanbao.source),
          completeBagFingerprint: { known: true, fingerprint: profile.completeBagFingerprint.fingerprint, positiveItemCount: profile.completeBagFingerprint.positiveItemCount,
            rule: profile.completeBagFingerprint.rule, source: generationSource(profile.completeBagFingerprint.source) } },
        remainingDailyOpportunity: opportunity.remainingDailyOpportunity, localReportProofRef: opportunity.localReportProofRef, guestScopeProofRef: opportunity.guestScopeProofRef } };
    const identitySources = currentSnapshotFor(state).sourceProofs;
    const decisionGeneration = fingerprint({ businessFingerprint, sourceProofs: identitySources, officialUid: scalar(state.view.identity.uid) });
    proposal.generation.decisionGeneration = decisionGeneration;
    proposal.semanticKey = 'customer-generation:' + businessFingerprint + ':' + decisionGeneration;
    const { currentSnapshot, currentNeed } = currentNeedFor(state, proposal, decisionGeneration);
    if (currentSnapshot.complete !== true) return wait('CUSTOMER_GENERATION_CURRENT_NEED_SNAPSHOT_INCOMPLETE');
    proposal.customer = { currentNeed };
    const claimed = sync(currentNeedReconciler.claimCurrent({ context, currentSnapshot, currentNeed }));
    if (claimed?.accepted !== true) return wait(claimed?.reasonCode || 'CUSTOMER_GENERATION_CURRENT_NEED_CLAIM_FAILED');
    proposal.customer.currentNeed.claimRef = claimed.claimRef;
    proposal.paramsFingerprint = fingerprint(proposal.params);
    proposal.factBasis = readFactBasis({ proposal });
    const checked = evaluateAdmission({ proposal, actor: context, factBasis: proposal.factBasis, boundary: 'before-prepare' });
    return checked.allowed ? { state: 'proposals', proposals: [freeze(proposal)], factBasis: proposal.factBasis } : wait(checked.reasonCode);
  }
  const verification = createCustomerGenerationVerification({ readGenerationFacts, isLeaseCurrent: ({ proposal, bridge }) => {
    const checked = sync(validateReadSnapshotLease({ leaseRef: bridge.leaseRef, operationId: proposal.operationId,
      originalContext: bridge.originalContext, newContext: bridge.newContext, after: bridge.after, bridgeFingerprint: bridge.bridgeFingerprint }));
    return checked?.valid === true && checked.current === true;
  } });
  const operationContract = freeze({ ...CUSTOMER_GENERATION_CONTRACT,
    postRead: { ...CUSTOMER_GENERATION_POST_READ, validateResponseCoverage: verification.validateResponseCoverage },
    validateTargetVerification: verification.validateTargetVerification });
  return Object.freeze({ assess, refreshExpiredSnapshot, qualify, readFactBasis, evaluateAdmission, verify: verification.verify,
    consumeCurrentNeed: ({ proposal }) => currentNeedReconciler.consumeCurrentNeed({ claimRef: proposal.customer?.currentNeed?.claimRef,
      operationId: proposal.operationId, decisionGeneration: proposal.customer?.currentNeed?.decisionGeneration,
      currentNeed: proposal.customer?.currentNeed, featureId: proposal.featureId }),
    operationContract, postReadContract: CUSTOMER_GENERATION_POST_READ });
}
