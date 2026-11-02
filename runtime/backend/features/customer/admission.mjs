import { canonical, clone, fingerprint, freeze, parseStored, problem } from '../../common.mjs';
import { hashLedgerBytes, ledgerJsonFingerprint } from '../../persistence/json-contract.mjs';
import { customerContext, sameCustomerContext, knownCustomerCell } from './wire-facts.mjs';
import { customerOrderContent, customerOrderFingerprint } from './identity.mjs';
import { createOfficialCustomerCatalog } from './catalog.mjs';
import { createCustomerAcceptance } from './acceptance.mjs';
import { assertCustomerFinishProposal } from './rpc-contract.mjs';
import { createCurrentNeedReconciler } from '../../execution/current-need.mjs';
import { NORMAL_SYNC_METHODS } from '../../facts/normal-sync-contract.mjs';
import { currentOfficialDataEvidence } from '../../official-data-evidence.mjs';

const VERSION = 'customer-single-admission/v1';
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sync = value => {
  if (value?.then) { value.catch?.(() => {}); throw new TypeError('Customer admission ports must be synchronous'); }
  return value;
};
const targetRef = (context, npcId) => 'customer-order:' + context.subjectRef + ':' + npcId;
const sourceRef = source => source ? { responseRef: source.responseRef ?? null, wireKey: source.wireKey ?? null,
  connectionEpoch: source.connectionEpoch ?? null, requestSequence: source.requestSequence ?? null,
  method: source.method ?? null, kind: source.kind ?? null } : null;
const currentSource = (source, context, versionBinding) => source?.kind === 'response' && source.transport === 'answered' &&
  NORMAL_SYNC_METHODS.includes(source.method) && source.connectionEpoch === context.connectionEpoch && positive(source.requestSequence) &&
  reference(source.responseRef) && reference(source.wireKey) &&
  source.version?.protocolVersion === '480.0.0' && reference(source.version?.loginResponseRef) &&
  source.version.gameVersion === versionBinding?.gameVersion && source.version.protocolVersion === versionBinding?.protocolVersion &&
  source.version.loginResponseRef === versionBinding?.loginResponseRef &&
  (source.version?.gameVersion === '480.0.27' || currentOfficialDataEvidence(source.version, 'customer.finish') !== null);
const deny = reasonCode => freeze({ allowed: false, reasonCode, historicalConstraintsChecked: true, currentInFlightChecked: true });

// A complete current board stays bound to its accepted login/version anchor,
// while later matched syncs may advance the board's own provenance. This
// component neither opens that read nor changes an old result/hold. The
// optional legacy key port must be the very same mapping used by shared budget.
export function createCustomerAdmission({ store, readModel, identity, resources, ledgerView, legacyConstraints, isCurrent,
  catalog: suppliedCatalog = null, legacyResourceKey = null, appendOutbox = () => {}, currentNeedFacts = null, isolationEvidence = null } = {}) {
  for (const [name, fn] of Object.entries({ get: store?.get, all: store?.all, transaction: store?.transaction,
    snapshot: readModel?.snapshot, identityGet: identity?.get, identityList: identity?.listCurrent,
    balance: resources?.balance, budget: resources?.budget, operation: ledgerView?.operation,
    currentAdmission: ledgerView?.currentAdmission, recordAdmissionBasis: ledgerView?.recordAdmissionBasis,
    candidateProjection: legacyConstraints?.candidateProjection, appendBasis: legacyConstraints?.appendBasis, isCurrent })) {
    if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') throw new TypeError('Customer admission missing synchronous port: ' + name);
  }
  if (legacyResourceKey !== null && typeof legacyResourceKey !== 'function') throw new TypeError('Legacy resource key reader must be a function or null');
  const catalog = suppliedCatalog ?? createOfficialCustomerCatalog(), acceptance = createCustomerAcceptance({ catalog, isCurrent });
  if (isolationEvidence !== null && typeof isolationEvidence?.read !== 'function') throw new TypeError('Customer isolation evidence must expose read');
  const currentNeedReconciler = createCurrentNeedReconciler({ store, ledgerView, isolationEvidence });
  const active = context => sync(isCurrent(context)) === true;

  function configuration(context) {
    const head = store.get('SELECT dto_json,saved_revision,feature_cancel_json,subject_ref FROM backend_config_heads WHERE owner_ref=? AND account_ref=?',
      context.ownerRef, context.accountRef);
    if (!head || head.subject_ref !== context.subjectRef) return null;
    return { config: parseStored(head.dto_json, '顾客当前配置'), savedRevision: head.saved_revision,
      featureCancelEpochs: parseStored(head.feature_cancel_json, '顾客配置取消代际') };
  }
  function policyProjection(config, keepPolicy) {
    const policy = config?.config?.orders?.customer, tiers = policy?.coinTiers;
    const validTiers = Array.isArray(tiers) && tiers.every(value => [1, 2, 3].includes(value)) && new Set(tiers).size === tiers.length;
    return { enabled: typeof policy?.enabled === 'boolean' ? policy.enabled : null,
      coinTiers: validTiers ? [...tiers].sort((a, b) => a - b) : null,
      autoReject: typeof policy?.autoReject === 'boolean' ? policy.autoReject : null,
      featureCancelEpoch: nonnegative(config?.featureCancelEpochs?.['order.customer']) ? config.featureCancelEpochs['order.customer'] : null,
      keepPolicy: keepPolicy?.known === true && nonnegative(keepPolicy.keep) && reference(keepPolicy.policyRef)
        ? { known: true, keep: keepPolicy.keep, policyRef: keepPolicy.policyRef } : null };
  }
  function readState(proposal, { skipContract = false } = {}) {
    if (!skipContract) assertCustomerFinishProposal(proposal);
    const context = customerContext(proposal);
    if (!context) throw problem('CUSTOMER_ADMISSION_CONTEXT_INVALID', '顾客准入需要完整归属和连接代际', 400);
    const view = sync(readModel.snapshot(context)), identities = sync(identity.listCurrent({ context }));
    const order = view?.orderMap?.entries?.find(one => one.npcId === proposal.params.npcId) || null;
    const life = identities?.identities?.find(one => one.npcId === proposal.params.npcId) || null;
    const config = configuration(context), balance = sync(resources.balance({ context, itemId: proposal.customer.artId }));
    const activeCatalog = catalog.forContext?.(context) ?? catalog;
    const rule = activeCatalog.itemRule(proposal.customer.artId, order?.source?.version), policy = policyProjection(config, proposal.customer.keepPolicy);
    return { context, view, identities, order, life, config, balance, rule, policy, proposal };
  }
  function basisFor(state) {
    const { view, identities, order, life, balance, rule, policy } = state;
    return freeze({ version: VERSION, target: { npcId: order?.npcId ?? null, lifecycleRef: life?.lifecycleRef ?? null,
      contentFingerprint: order ? customerOrderFingerprint(order) : null, content: order ? customerOrderContent(order) : null,
      identityKnown: life?.identityKnown === true, firstSeenSequence: life?.firstSeenSequence ?? null },
      officialIdentity: { uid: knownCustomerCell(view?.identity?.uid) ? view.identity.uid.value : null,
        gameVersion: view?.versionBinding?.gameVersion ?? null, protocolVersion: view?.versionBinding?.protocolVersion ?? null },
      catalog: rule ? { catalogId: rule.catalogId, ruleVersion: rule.ruleVersion, manifestSha256: rule.manifestSha256,
        artTableSha256: rule.artTableSha256, itemTableSha256: rule.itemTableSha256 } : null,
      stock: { itemId: balance?.itemId ?? null, accountingVersion: digest(balance?.accountingVersion) ? balance.accountingVersion : null },
      policy, currentNeedEvidence: state.proposal?.customer?.currentNeed ?? null, queue: { complete: identities?.complete === true,
        entries: (identities?.identities || []).map(one => ({ npcId: one.npcId, lifecycleRef: one.lifecycleRef ?? null,
          contentFingerprint: one.contentFingerprint ?? null, identityKnown: one.identityKnown === true,
          firstSeenSequence: one.firstSeenSequence ?? null })).sort((a, b) => a.npcId - b.npcId) } });
  }
  function readFactBasis({ proposal } = {}) { return basisFor(readState(proposal)); }

  function currentSnapshotFor(state) {
    const source = state.view?.identity?.source, version = state.view?.versionBinding;
    const shared = currentNeedFacts?.({ context: state.context, featureId: 'order.customer', method: state.proposal?.method,
      proposal: state.proposal, config: state.config?.config });
    const projectSource = one => one && ({ method: one.method, responseRef: one.responseRef, requestSequence: one.requestSequence,
      connectionEpoch: one.connectionEpoch, ...(one.method === 'index.login' ? { kind: 'login', gameVersion: version?.gameVersion,
        protocolVersion: version?.protocolVersion } : {}) });
    const sourceProofs = shared?.sourceProofs?.length ? shared.sourceProofs.map(projectSource) : [source, state.view?.orderMap?.source, state.order?.source, state.life?.source,
      ...(state.identities?.identities || []).map(one => one?.source),
      state.balance?.base?.source, state.balance?.ext?.source,
      ...(state.profile?.items ? Object.values(state.profile.items).flatMap(one => [one?.base?.source, one?.ext?.source]) : [])]
      .filter(one => one?.kind === 'response' && reference(one.responseRef) && reference(one.method) && positive(one.requestSequence) && positive(one.connectionEpoch))
      .map(projectSource)
      .filter((one, index, all) => all.findIndex(other => canonical(other) === canonical(one)) === index);
    return { complete: (!currentNeedFacts || shared?.complete === true) && state.view?.current === true && state.view?.identity?.verified === true && state.identities?.complete === true &&
        state.view?.orderMap?.current === true && state.view.orderMap.state === 'known' && state.view.orderMap.sourceProvidedCollectionComplete === true &&
        state.view.orderMap.returnedComplete === true && state.view.orderMap.truncated === false && state.view.orderMap.total === state.view.orderMap.entries?.length &&
        state.order?.current === true && state.order?.readable === true && state.life?.current === true && state.life?.identityKnown === true &&
        state.balance?.base?.known === true && state.balance?.ext?.current === true,
      identityVerified: state.view?.identity?.verified === true, method: source?.method, responseRef: source?.responseRef,
      requestSequence: source?.requestSequence, connectionEpoch: source?.connectionEpoch,
      officialUid: knownCustomerCell(state.view?.identity?.uid) ? state.view.identity.uid.value : null,
      gameVersion: version?.gameVersion, protocolVersion: version?.protocolVersion, sourceProofs };
  }
  function claimCurrentNeed({ proposal } = {}) {
    const state = readState(proposal, { skipContract: true });
    const currentSnapshot = currentSnapshotFor(state), currentNeed = proposal.customer.currentNeed;
    currentNeed.basisRefs = [...new Set([...(currentNeed.basisRefs || []), ...currentSnapshot.sourceProofs.map(one => one.responseRef)])];
    return sync(currentNeedReconciler.claimCurrent({ context: state.context, currentSnapshot, currentNeed }));
  }
  function consumeCurrentNeed({ proposal } = {}) {
    const currentNeed = proposal?.customer?.currentNeed;
    return sync(currentNeedReconciler.consumeCurrentNeed({ claimRef: currentNeed?.claimRef,
      operationId: proposal?.operationId, decisionGeneration: currentNeed?.decisionGeneration, currentNeed, featureId: proposal?.featureId }));
  }

  function originalOwnReservation(proposal, context, boundary, ownReservation, admission) {
    const beforeSend = boundary === 'before-send';
    if (!['before-prepare', 'before-send'].includes(boundary) || beforeSend &&
      (ownReservation?.required !== true || ownReservation.operationId !== proposal.operationId) || !beforeSend &&
      (ownReservation?.required === true || ownReservation != null && ownReservation.operationId !== proposal.operationId)) return 'CUSTOMER_OWN_RESERVATION_MISMATCH';
    if (admission.activeOperation && (!beforeSend || admission.activeOperation.operation_id !== proposal.operationId)) return 'CUSTOMER_CURRENT_WRITE_IN_FLIGHT';
    if (!beforeSend) return null;
    const own = sync(ledgerView.operation(proposal.operationId));
    if (!own || own.write_slot !== 1 || !['not_started', 'may_have_sent'].includes(own.transport_state) ||
      own.owner_ref !== context.ownerRef || own.account_ref !== context.accountRef || own.subject_ref !== context.subjectRef ||
      own.run_epoch !== context.runEpoch || own.connection_epoch !== context.connectionEpoch || own.original?.ownerEpoch !== context.ownerEpoch ||
      own.feature_id !== proposal.featureId || own.scope !== proposal.scope || own.method !== proposal.method ||
      own.semantic_key !== proposal.semanticKey || own.params_fingerprint !== proposal.paramsFingerprint ||
      canonical(own.original.targets) !== canonical(proposal.targets) || canonical(own.original.resources) !== canonical(proposal.resources) ||
      canonical(own.original.resourceBindings) !== canonical(proposal.resourceBindings) || own.resources?.length !== 1 ||
      own.resources[0].state !== 'reserved' && own.resources[0].state !== 'in_flight' || own.resourceBindings?.length !== 1 ||
      own.resourceBindings[0].resource_key !== proposal.resources[0].resourceKey ||
      own.resourceBindings[0].member_key !== proposal.targets[0].memberKey || own.resourceBindings[0].quantity !== proposal.customer.need) {
      return 'CUSTOMER_OWN_RESERVATION_MISSING';
    }
    return null;
  }
  function budgetFor(proposal, context, boundary) {
    return sync(resources.budget({ context, itemId: proposal.customer.artId, keep: proposal.customer.keepPolicy.keep,
      quantity: proposal.customer.need, claimingOperationId: boundary === 'before-send' ? proposal.operationId : null,
      requireOwnReservation: boundary === 'before-send' }));
  }
  function exactOwnBudget(proposal, budget, boundary) {
    if (boundary !== 'before-send') return true;
    const own = budget?.ownReservation, rows = own?.resources;
    return own?.valid === true && own.operationId === proposal.operationId && own.quantity === proposal.customer.need &&
      Array.isArray(rows) && rows.length === 1 && rows[0].operationId === proposal.operationId &&
      rows[0].resourceKey === proposal.resources[0].resourceKey && rows[0].quantity === proposal.customer.need &&
      rows[0].unreflectedQuantity === proposal.customer.need && ['reserved', 'in_flight'].includes(rows[0].state);
  }
  function matchedEnded(original) {
    const permit = store.get('SELECT * FROM backend_send_permits WHERE operation_id=?', original.operation_id);
    if (original.write_slot !== 0 || original.transport_state !== 'answered' || permit?.consumed !== 1 ||
      permit.owner_ref !== original.owner_ref || permit.subject_ref !== original.subject_ref ||
      permit.owner_epoch !== original.original?.ownerEpoch || permit.run_epoch !== original.run_epoch ||
      permit.connection_epoch !== original.connection_epoch || permit.method !== original.method ||
      permit.params_fingerprint !== original.params_fingerprint || !positive(permit.request_sequence) || !reference(permit.wire_key)) return null;
    const answers = store.all("SELECT * FROM backend_operation_evidence WHERE operation_id=? AND kind='official-answer' AND source='backend/write-gateway/v2' ORDER BY evidence_id DESC LIMIT 3", original.operation_id);
    for (const event of answers) {
      const payload = parseStored(event.payload_json, '顾客旧请求结束证据');
      if (ledgerJsonFingerprint({ kind: event.kind, source: event.source, payload, observedAt: event.observed_at }) !== event.payload_fingerprint ||
        payload.method !== original.method || payload.connectionEpoch !== original.connection_epoch || payload.wireKey !== permit.wire_key ||
        payload.requestSequence !== permit.request_sequence || !reference(payload.responseRef)) continue;
      return { kind: 'matched-operation-response', requestTerminated: true, evidenceId: event.evidence_id,
        evidenceFingerprint: event.payload_fingerprint, responseRef: payload.responseRef, wireKey: payload.wireKey,
        connectionEpoch: payload.connectionEpoch, requestSequence: payload.requestSequence };
    }
    return null;
  }
  function separation(state, original) {
    const { context, life, view } = state;
    if (original.owner_ref !== context.ownerRef || original.subject_ref !== context.subjectRef || original.feature_id !== 'order.customer' ||
      original.scope !== 'order-customer' || original.method !== 'orderCustomer.finishOrder' || original.targets?.length !== 1) return null;
    const oldTarget = original.targets[0], oldRef = oldTarget.lifecycle_ref ?? oldTarget.original?.lifecycleRef;
    const old = store.get('SELECT * FROM backend_customer_identity_lives WHERE lifecycle_ref=? AND owner_ref=? AND subject_ref=? AND npc_id=?',
      oldRef, context.ownerRef, context.subjectRef, life.npcId);
    if (!old || old.identity_known !== 1 || old.content_fingerprint !== fingerprint(parseStored(old.content_json, '顾客原生命周期内容')) ||
      typeof original.original_json !== 'string' || hashLedgerBytes(original.original_json) !== original.original_fingerprint ||
      original.original_fingerprint !== ledgerJsonFingerprint(original.original) ||
      old.content_fingerprint !== (oldTarget.target_fingerprint ?? oldTarget.original?.targetFingerprint) ||
      original.factBasis?.version !== VERSION || original.factBasis.target?.lifecycleRef !== oldRef ||
      original.factBasis.officialIdentity?.uid !== view.identity.uid.value || oldRef === life.lifecycleRef || old.content_fingerprint === life.contentFingerprint) return null;
    const ended = matchedEnded(original);
    if (!ended) return null;
    // A persisted observed chain is required. Neither a new UUID nor a changed
    // response timestamp may manufacture a second occurrence of the same order.
    let cursor = store.get('SELECT * FROM backend_customer_identity_lives WHERE lifecycle_ref=? AND owner_ref=? AND subject_ref=? AND npc_id=?',
      life.lifecycleRef, context.ownerRef, context.subjectRef, life.npcId);
    const chain = [];
    while (cursor && chain.length < 128 && cursor.lifecycle_ref !== oldRef) {
      if (cursor.identity_known !== 1 || !['observed-content-change', 'observed-after-absence'].includes(cursor.boundary_kind)) return null;
      const anchor = parseStored(cursor.anchor_source_json, '顾客生命周期边界来源');
      if (!digest(cursor.content_fingerprint) || cursor.content_fingerprint !== fingerprint(parseStored(cursor.content_json, '顾客生命周期内容')) ||
        anchor.kind !== 'response' || anchor.transport !== 'answered' || anchor.version?.protocolVersion !== '480.0.0' ||
        !(anchor.version?.gameVersion === '480.0.27' || currentOfficialDataEvidence(anchor.version, 'customer.finish')) ||
        !positive(anchor.requestSequence) || !reference(anchor.responseRef) || !reference(anchor.wireKey)) return null;
      chain.push({ lifecycleRef: cursor.lifecycle_ref, priorLifecycleRef: cursor.prior_lifecycle_ref,
        contentFingerprint: cursor.content_fingerprint, boundaryKind: cursor.boundary_kind, source: sourceRef(anchor) });
      cursor = cursor.prior_lifecycle_ref ? store.get('SELECT * FROM backend_customer_identity_lives WHERE lifecycle_ref=? AND owner_ref=? AND subject_ref=? AND npc_id=?',
        cursor.prior_lifecycle_ref, context.ownerRef, context.subjectRef, life.npcId) : null;
    }
    const anchor = chain[chain.length - 1]?.source;
    if (cursor?.lifecycle_ref !== oldRef || !anchor || anchor.kind !== 'response' || anchor.method !== 'index.login' ||
      anchor.connectionEpoch < ended.connectionEpoch || anchor.connectionEpoch === ended.connectionEpoch && anchor.requestSequence <= ended.requestSequence ||
      original.factBasis.target.contentFingerprint !== old.content_fingerprint) return null;
    return { version: 'customer-observed-lifecycle-separation/v1', originalOperationId: original.operation_id,
      originalFingerprint: original.original_fingerprint, originalLifecycleRef: oldRef, previousExecution: ended,
      currentCheckpoint: clone(context), currentBoard: sourceRef(view.orderMap.source), currentLifecycleRef: life.lifecycleRef,
      chain, officialUid: view.identity.uid.value, originalOutcomeUnchanged: true, originalResourceFootprintsUnchanged: true };
  }
  function checkModern(state, proposal, factBasis, admission, candidateFingerprint, append) {
    for (const one of admission.unresolvedOperations) {
      if (one.operation_id === proposal.operationId) continue;
      const original = sync(ledgerView.operation(one.operation_id));
      if (!original || original.subject_ref !== state.context.subjectRef) return 'CUSTOMER_UNRESOLVED_OPERATION_UNREADABLE';
      const sameTarget = original.targets?.some(target => (target.target_ref ?? target.original?.targetRef) === proposal.targets[0].targetRef);
      if (!sameTarget && !(original.feature_id === proposal.featureId && original.semantic_key === proposal.semanticKey)) continue;
      if (['unknown', 'unverified'].includes(original.business_verdict)) {
        const result = sync(currentNeedReconciler.reconcile({ context: state.context, originalOperationId: original.operation_id,
          currentSnapshot: currentSnapshotFor(state), currentNeed: proposal.customer.currentNeed, operationId: proposal.operationId }));
        if (result?.accepted !== true) return result?.reasonCode || 'CUSTOMER_CURRENT_NEED_RECONCILIATION_UNAVAILABLE';
        proposal.traceId ||= original.trace_id || original.original?.traceId || original.operation_id;
        if (append) sync(appendOutbox({ ownerRef: state.context.ownerRef, subjectRef: state.context.subjectRef,
          eventType: 'CurrentNeedAutomaticallyReconciled', eventKey: result.reconciliationRef,
          payload: { traceId: proposal.traceId || original.trace_id || original.original?.traceId || original.operation_id,
            operationId: proposal.operationId, originalOperationId: original.operation_id, featureId: proposal.featureId,
            targetRef: proposal.targets[0].targetRef, reasonCode: 'CURRENT_OFFICIAL_SNAPSHOT_PROVES_CUSTOMER_DELIVERY_NEEDED',
            reconciliationRef: result.reconciliationRef, attempted: false } }));
        continue;
      }
      if (!sameTarget) continue;
      const evidence = separation(state, original);
      if (!evidence) return 'CUSTOMER_PRIOR_TARGET_LIFECYCLE_OR_REQUEST_END_UNPROVEN';
      if (append) sync(ledgerView.recordAdmissionBasis({ operationId: original.operation_id, constraintKey: proposal.targets[0].targetRef,
        basisKey: 'customer:' + fingerprint([candidateFingerprint, evidence]), conclusion: 'permit_current', factBasis,
        affected: { candidateFingerprint, targetRef: proposal.targets[0].targetRef, lifecycleRef: proposal.customer.lifecycleRef },
        evidence, reasonCode: 'CUSTOMER_GENUINE_NEW_LIFECYCLE_AFTER_ENDED_REQUEST' }));
    }
    return null;
  }
  function checkLegacy(state, proposal, factBasis, budget, candidateFingerprint, append, resourceBaseline = null) {
    // The audited old real-order-cycle supplied no targetRef for this method;
    // action.slot='customer:N' never became a persisted target. Do not invent a
    // raw target mapping. Explicit unknown old-customer scope stays local here.
    const rawTargetRefs = [], rawResourceKeys = ['item:' + proposal.customer.artId];
    const currentNeed = proposal.customer?.currentNeed;
    if (currentNeed?.claimRef && currentNeedReconciler?.reconcileLegacyCandidate) {
      const separated = sync(currentNeedReconciler.reconcileLegacyCandidate({ context: state.context,
        currentSnapshot: currentSnapshotFor(state), currentNeed, legacyConstraints, isolationEvidence,
        rawTargetRefs, rawResourceKeys, semanticKey: proposal.semanticKey, factBasis, candidateFingerprint,
        action: proposal.method, methodScope: ['orderCustomer.finishOrder'], resourceBaselineRef: resourceBaseline?.baselineRef }));
      if (separated?.accepted !== true) return { reasonCode: separated?.reasonCode || 'CUSTOMER_LEGACY_CURRENT_NEED_UNPROVEN', scopeDiagnostics: [] };
    }
    const legacy = sync(legacyConstraints.candidateProjection({ ownerRef: state.context.ownerRef, subjectRef: state.context.subjectRef,
      semanticKey: proposal.semanticKey, rawTargetRefs, rawResourceKeys, factBasis, candidateFingerprint,
      resourceBaselineRef: resourceBaseline?.baselineRef }));
    const customer = legacy.operations.filter(one => one.scope === 'order-customer' || one.method === 'orderCustomer.finishOrder');
    if (legacy.semanticMatches.length || customer.length) return { reasonCode: 'CUSTOMER_LEGACY_TARGET_MAPPING_UNPROVEN', scopeDiagnostics: [] };
    for (const constraint of legacy.matchedResources) {
      const key = legacyResourceKey ? sync(legacyResourceKey({ context: state.context, constraint: clone(constraint) })) : null;
      const retained = reference(key) ? budget.otherUnreflectedReservations?.find(one => one.resourceKey === key &&
        one.operationId === 'legacy:' + constraint.source_origin_key) : null;
      const allowed = nonnegative(constraint.quantity) && budget.known === true && budget.allowed === true && retained &&
        retained.quantity === constraint.quantity && retained.unreflectedQuantity === constraint.quantity;
      const evidence = { version: 'customer-legacy-resource-retention/v1', currentCheckpoint: clone(state.context),
        retainedResource: allowed ? clone(retained) : null, budgetAccountingVersion: budget.accountingVersion ?? null,
        originalOutcomeUnchanged: true, originalResourceFootprintUnchanged: true, oldAcknowledgementPromoted: false };
      if (append) sync(legacyConstraints.appendBasis({ ownerRef: state.context.ownerRef, subjectRef: state.context.subjectRef,
        constraintRef: constraint.constraint_ref, sourceFingerprint: constraint.source_fingerprint,
        basisKey: 'customer:' + fingerprint([candidateFingerprint, constraint.constraint_ref, evidence]),
        conclusion: allowed ? 'permit_current' : 'needs_evidence', factBasis,
        affected: { constraintRef: constraint.constraint_ref, candidateFingerprint, rawTargetRefs, rawResourceKeys }, evidence,
        reasonCode: allowed ? 'CUSTOMER_LEGACY_RESOURCE_RETAINED_IN_SHARED_BUDGET' : 'CUSTOMER_LEGACY_RESOURCE_BINDING_UNPROVEN' }));
      if (!allowed) return { reasonCode: 'CUSTOMER_LEGACY_RESOURCE_BINDING_UNPROVEN', scopeDiagnostics: [] };
    }
    return { reasonCode: null, scopeDiagnostics: legacy.operations.slice(0, 32).map(one => ({ operationRef: one.operation_ref,
      reasonCode: 'CUSTOMER_OTHER_LEGACY_SCOPE_NOT_GLOBAL_HOLD' })) };
  }
  function evaluateAdmission({ proposal, actor, factBasis, boundary = 'before-prepare', ownReservation = null } = {}) {
    const state = readState(proposal), { context, view, order, life, identities, config, balance, rule, policy } = state;
    if (!sameCustomerContext(context, customerContext(actor)) || !active(context) || !sameCustomerContext(context, view?.context) ||
      view.current !== true || view.identity?.verified !== true || !knownCustomerCell(view.identity.uid) ||
      view.identity.uid.value !== proposal.customer.officialUid || !view.orderMap?.current || view.orderMap.state !== 'known' ||
      view.orderMap.sourceProvidedCollectionComplete !== true || view.orderMap.returnedComplete !== true || view.orderMap.truncated !== false ||
      view.orderMap.total !== view.orderMap.entries?.length || !currentSource(view.orderMap.source, context, view.versionBinding)) return deny('CUSTOMER_CURRENT_COMPLETE_LOGIN_BOARD_REQUIRED');
    if (canonical(basisFor(state)) !== canonical(factBasis)) return deny('CUSTOMER_CURRENT_FACT_BASIS_CHANGED');
    if (!identities.current || !identities.complete || !life?.identityKnown || !life.current || !sameCustomerContext(context, life.context) ||
      !order?.readable || !order.current || life.lifecycleRef !== proposal.customer.lifecycleRef ||
      life.contentFingerprint !== proposal.customer.contentFingerprint || customerOrderFingerprint(order) !== life.contentFingerprint ||
      life.source?.responseRef !== order.source?.responseRef || life.source?.requestSequence !== order.source?.requestSequence ||
      life.source?.connectionEpoch !== order.source?.connectionEpoch || !positive(life.firstSeenSequence)) return deny('CUSTOMER_ORIGINAL_ORDER_IDENTITY_NOT_CURRENT');
    if (!rule || !policy.keepPolicy || !balance?.base?.known || !nonnegative(balance.effective?.lowerBound) ||
      balance.ext?.current !== true || !digest(balance.accountingVersion)) return deny('CUSTOMER_FINISHED_STOCK_OR_POLICY_UNPROVEN');
    const decision = sync(acceptance.evaluate({ context, order, identity: life, config }));
    if (!decision.accepted || decision.decisionRef !== proposal.customer.acceptedDecisionRef ||
      decision.featureCancelEpoch !== proposal.featureCancelEpoch || proposal.customer.rewardQuantity !== decision.reward.quantity ||
      proposal.customer.beforeStock?.basisRef !== balance.basisRef || proposal.customer.beforeStock.quantity !== balance.base.value ||
      canonical(proposal.customer.versionEvidence) !== canonical(view.versionBinding)) return deny('CUSTOMER_ACCEPTANCE_ORIGINAL_STOCK_CHANGED');
    const currentClaim = sync(currentNeedReconciler.isClaimCurrent({ claimRef: proposal.customer.currentNeed?.claimRef,
      context, currentSnapshot: currentSnapshotFor(state), currentNeed: proposal.customer.currentNeed,
      operationId: boundary === 'before-send' ? proposal.operationId : null }));
    if (currentClaim?.accepted !== true) return deny(currentClaim?.reasonCode || 'CUSTOMER_CURRENT_NEED_CLAIM_NOT_CURRENT');
    const current = sync(ledgerView.currentAdmission({ subjectRef: context.subjectRef, ownerRef: context.ownerRef,
      targetRefs: [proposal.targets[0].targetRef, ...identities.identities.map(one => targetRef(context, one.npcId))] }));
    const ownError = originalOwnReservation(proposal, context, boundary, ownReservation, current);
    if (ownError) return deny(ownError);
    const previous = store.get("SELECT operation_id,business_verdict FROM backend_operations WHERE subject_ref=? AND feature_id=? AND semantic_key=? AND transport_state!='not_sent' AND operation_id!=? LIMIT 1",
      context.subjectRef, proposal.featureId, proposal.semanticKey, proposal.operationId);
    if (previous && !['unknown', 'unverified'].includes(previous.business_verdict)) return deny('CUSTOMER_ORIGINAL_SEMANTIC_ALREADY_SETTLED');
    const budget = budgetFor(proposal, context, boundary);
    if (!budget?.known || budget.allowed !== true || !exactOwnBudget(proposal, budget, boundary)) return deny(budget?.reasonCode || 'CUSTOMER_OWN_BUDGET_BINDING_INVALID');
    const candidateFingerprint = fingerprint({ semanticKey: proposal.semanticKey, paramsFingerprint: proposal.paramsFingerprint, targets: proposal.targets, factBasis });
    return store.transaction(() => {
      if (!active(context)) return deny('CUSTOMER_ADMISSION_CONTEXT_REVOKED');
      const modernError = checkModern(state, proposal, factBasis, current, candidateFingerprint, true);
      if (modernError) return deny(modernError);
      const legacy = checkLegacy(state, proposal, factBasis, budget, candidateFingerprint, true, current.resourceBaseline);
      if (legacy.reasonCode) return deny(legacy.reasonCode);
      // Do not re-use a pre-prepare budget during the send fence: only this
      // exact operation's original hold is excluded, including earlier slots.
      for (const earlier of identities.identities.filter(one => one.firstSeenSequence < life.firstSeenSequence ||
        one.firstSeenSequence === life.firstSeenSequence && one.npcId < life.npcId)) {
        const row = view.orderMap.entries.find(one => one.npcId === earlier.npcId);
        if (!row) continue;
        const accepted = sync(acceptance.evaluate({ context, order: row, identity: earlier, config }));
        if (!accepted.accepted) continue;
        const seen = store.get("SELECT operation_id FROM backend_operations WHERE subject_ref=? AND feature_id='order.customer' AND semantic_key=? AND transport_state!='not_sent' LIMIT 1",
          context.subjectRef, 'customer-finish:' + earlier.lifecycleRef);
        const busy = current.unresolvedOperations.some(one => {
          if (one.operation_id === proposal.operationId) return false;
          const old = sync(ledgerView.operation(one.operation_id));
          const conflicts = old?.targets?.some(target => (target.target_ref ?? target.original?.targetRef) === targetRef(context, earlier.npcId));
          return conflicts && !separation({ ...state, life: earlier, order: row }, old);
        });
        if (seen || busy) continue;
        const earlierBudget = sync(resources.budget({ context, itemId: accepted.order.artId, quantity: accepted.order.need,
          keep: policy.keepPolicy.keep, claimingOperationId: boundary === 'before-send' ? proposal.operationId : null, requireOwnReservation: false }));
        if (earlierBudget?.known === true && earlierBudget.allowed === true) return deny('CUSTOMER_FAIR_ALLOCATION_EARLIER_ACTIONABLE_ORDER');
      }
      if (!active(context)) return deny('CUSTOMER_ADMISSION_CONTEXT_REVOKED');
      return freeze({ allowed: true, historicalConstraintsChecked: true, currentInFlightChecked: true, candidateFingerprint,
        reasonCode: null, scopeDiagnostics: legacy.scopeDiagnostics, balanceAccountingVersion: balance.accountingVersion,
        budgetAccountingVersion: budget.accountingVersion, basisRefs: clone(budget.basisRefs) });
    });
  }
  return Object.freeze({ readFactBasis, evaluateAdmission, claimCurrentNeed, consumeCurrentNeed });
}
