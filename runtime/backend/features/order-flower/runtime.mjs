import { canonical, clone, fingerprint, freeze, newId, parseStored } from '../../common.mjs';
import { ledgerJsonFingerprint } from '../../persistence/json-contract.mjs';
import { knownOrderFlowerCell, orderFlowerContext, sameOrderFlowerContext } from './wire-facts.mjs';
import { createOrderFlowerIdentity, currentOrderFlowerRows, orderFlowerPlainRow } from './identity.mjs';
import { createOrderFlowerIdentityHistory } from './identity-history.mjs';
import { createOrderFlowerEligibility } from './eligibility.mjs';
import { createOrderFlowerLegacyAdmission } from './legacy-admission.mjs';
import { createOrderFlowerDeliveryAccounting } from './delivery-accounting.mjs';
import { ORDER_FLOWER_STORED_CONTRACT, captureOrderFlowerStoredBefore, orderFlowerStoredBasis } from './stored-contract.mjs';
import { planOrderFlowerStock, sourceCurrent } from './planning.mjs';
import { ORDER_FLOWER_CONTRACTS, ORDER_FLOWER_POST_READ, ORDER_FLOWER_CURRENT_NEED_CONTRACT, orderFlowerHistoricalAdmittedContractMatches, assertOrderFlowerProposal,
  orderFlowerContent, orderFlowerRequirements, orderFlowerSafeSource } from './rpc-contract.mjs';
import { createOrderFlowerVerification, validateOrderFlowerSnapshotCoverage, validateOrderFlowerTargetVerification } from './verification.mjs';
import { createCurrentNeedReconciler } from '../../execution/current-need.mjs';
import { createOrderFlowerSourceRetirement } from './source-retirement.mjs';

const VERSION = 'order-flower-ordinary-admission/v1';
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const scalar = cell => knownOrderFlowerCell(cell) ? cell.value : null;
const sync = value => { if (value?.then) throw new TypeError('Order admission port must be synchronous'); return value; };
const KEEP = freeze({ known: true, keep: 0, policyRef: 'current-three-orders/confirmed-stock/no-additional-business-reserve/v1' });
const wait = (reasonCode, factBasis = null) => ({ state: 'waiting-facts', reasonCode, deviceDueMs: Date.now() + 30000,
  ...(factBasis ? { factBasis } : {}) });
const boundedBindingDiagnostic = details => {
  if (details?.diagnosticVersion !== 'order-flower-proposal-binding/v1' || !Array.isArray(details.failedPaths)) return null;
  const validPath = value => typeof value === 'string' && value.length <= 192 && /^order\.(?:counter\.source|beforeGenerationCounter\.source|beforeOtherCounters\[\d+\]\.source)\.version\.sourceProofs\.(?:order\.resident|order\.satin|order\.decorate|unknown)$/.test(value);
  const safeTypes = new Set(['missing', 'null', 'object', 'array', 'string', 'number', 'boolean', 'undefined', 'mismatch']);
  const failedPaths = details.failedPaths.slice(0, 8).filter(one => one && validPath(one.path) && safeTypes.has(one.actualType))
    .map(one => ({ path: one.path, actualType: one.actualType }));
  const failedGateNames = Array.isArray(details.failedGateNames) ? details.failedGateNames.slice(0, 8)
    .filter(one => typeof one === 'string' && /^[A-Za-z][A-Za-z0-9.[\]]{0,95}$/.test(one)) : [];
  return failedPaths.length || failedGateNames.length ? { diagnosticVersion: details.diagnosticVersion, failedGateNames, failedPaths } : null;
};

export function orderFlowerDynamicDomains({ method, proposal, actionKey, kind, auxiliarySupported = null } = {}) {
  if (auxiliarySupported === false && ['enter', 'stage-reward', 'achievement', 'video'].includes(actionKey)) return ['order-flower'];
  const base = ['order-flower', 'order-flower-counter', 'order-flower-eligibility', 'inventory', 'clock', 'profile', 'customer-day'];
  const action = proposal?.orderFlower || proposal?.orderFlowerVideo || proposal?.orderFlowerReward || proposal?.orderFlowerEnter;
  if (actionKey === 'delivery') return [...base, 'order-flower-butler'];
  if (actionKey === 'stage-reward') return [...base, 'order-flower-reward-stage'];
  if (actionKey === 'achievement') return [...base, 'order-flower-reward-achievement'];
  if (actionKey === 'enter') return [...base, 'order-flower-enter-state'];
  // Empty video work units scan only ordinary current inputs. A concrete
  // usr.share proposal adds its exact share/card facts at the send fence.
  if (actionKey === 'video') return [...base, 'order-flower-butler'];
  if (method === 'usr.share' || proposal?.orderFlowerVideo) {
    const kind = proposal?.orderFlowerVideo?.kind || action?.kind;
    const domains = kind && ['resident', 'satin', 'decorate'].includes(kind) ? ['order-flower-video-' + kind]
      : ['order-flower-video-resident', 'order-flower-video-satin', 'order-flower-video-decorate'];
    // Card 6 is a consumed capability only on the current official-card
    // route. The supported legacy API request-only route carries its own
    // exact request proof and must remain usable when card metadata is absent.
    if (proposal?.orderFlowerVideo?.capability?.kind === 'current-official-card6') domains.push('order-flower-card-video');
    return [...base, ...domains];
  }
  if (method === 'orderFlower.recvOrderRwd' || proposal?.orderFlowerReward?.kind === 'stage') return [...base, 'order-flower-reward-stage'];
  if (method === 'taskAch.recv' || proposal?.orderFlowerReward?.kind === 'achievement') return [...base, 'order-flower-reward-achievement'];
  if (method === 'orderFlower.enter' || proposal?.orderFlowerEnter) return [...base, 'order-flower-enter-state'];
  // Planning reads current butler facts to choose between instant delivery
  // and a stored order. Keep that negative/positive branch decision fresh at
  // the send fence as well; actions that did not consult this planner input
  // remain free of the optional domain.
  if (['instant', 'ordinary-ready-order', 'butler-stored-order'].includes(proposal?.orderFlower?.deliveryPath)) return [...base, 'order-flower-butler'];
  return base;
}

export function orderFlowerDailyCapSuspension({ kind, exhausted, officialDay, clock, catalog, config, configRevision } = {}) {
  if (!exhausted || exhausted.reasonCode !== 'ORDER_FLOWER_DAILY_LIMIT_REACHED' || officialDay?.known !== true ||
      !Number.isSafeInteger(officialDay.endMs) || !Number.isFinite(clock?.nowMs) || officialDay.endMs <= clock.nowMs) return null;
  const definition = catalog?.definition?.(kind), configuredLimit = config?.orders?.[kind]?.dailyLimit,
    officialLimit = definition?.officialDailyLimit, catalogIdentity = catalog?.identity?.() ?? null;
  const officialExhausted = Number.isSafeInteger(officialLimit) && exhausted.policyCount?.value >= officialLimit;
  const limit = officialExhausted ? officialLimit : configuredLimit === 0 ? officialLimit : configuredLimit;
  const proofRefs = [officialDay.proofRef, exhausted.count?.dayProofRef, exhausted.count?.source?.responseRef]
    .filter(value => typeof value === 'string' && value.length > 0 && value.length <= 512);
  if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(exhausted.policyCount?.value) ||
      exhausted.policyCount.value < limit || proofRefs.length < 2 || !Number.isSafeInteger(configRevision)) return null;
  return { state: 'cap-wait', reasonCode: 'ORDER_FLOWER_DAILY_LIMIT_REACHED', factBasis: { kind,
    dayKey: officialDay.key, used: exhausted.policyCount.value, limit }, suspension: {
    kind: 'period-cap', quotaKey: 'order-flower:' + kind, actionScope: 'feature', periodKind: 'official-day',
    periodKey: officialDay.key, periodEndOfficialMs: officialDay.endMs,
    scope: officialExhausted ? 'official' : 'local', used: exhausted.policyCount.value, limit,
    proofRefs: [...new Set(proofRefs)], configRevision,
    policySource: { kind: 'versioned-static-catalog', gameVersion: catalogIdentity?.gameVersion ?? null,
      protocolVersion: catalogIdentity?.protocolVersion ?? null, catalogSha256: catalogIdentity?.catalogSha256 ?? null,
      officialLimit } } };
}

export function orderFlowerCurrentNeedAdmissionEvidence({ currentNeedGeneration, isolation, currentOrderSource,
  oldLifecycleRef = null, oldTime = null, currentTime = null, prepared = null, claimRef = null,
  decisionGeneration = null, reconciliationRef = null } = {}) {
  return { version: currentNeedGeneration ? 'order-flower/current-need-after-exact-closed-execution/v1'
    : 'order-flower/later-generation-after-exact-closed-execution/v1', isolation,
  currentOrderSource, oldLifecycleRef: oldLifecycleRef ?? null, oldTime: oldTime ?? null, currentTime: currentTime ?? null,
  ...(currentNeedGeneration ? { claimRef, decisionGeneration, reconciliationRef } : {}),
  originalPreparationFingerprint: prepared?.preparationFingerprint ?? null,
  originalContractFingerprint: prepared?.contractFingerprint ?? null };
}

// Only ordinary completion contracts are defined in this first implementation
// increment. Registry admission remains separate until the shared gateway,
// original-resource coverage and independent verifier are reviewed together.
export function createOrderFlowerRuntime({ store, readModel, readView = input => readModel.snapshot(input), catalog, resources, ledgerView, legacyConstraints,
  isolationEvidence, readLegacyOperation, isCurrent, clock, readGenerationFacts, readCustomerView, validateReadSnapshotLease,
  requestFreshLogin, appendOutbox, dynamicState = null }) {
  const identity = createOrderFlowerIdentity({ store, isCurrent, clock });
  const identityHistory = createOrderFlowerIdentityHistory({ store });
  const sourceRetirement = createOrderFlowerSourceRetirement({ store });
  const eligibility = createOrderFlowerEligibility({ catalog, isCurrent, clock });
  const deliveryAccounting = createOrderFlowerDeliveryAccounting({ store });
  const currentNeedReconciler = createCurrentNeedReconciler({ store, ledgerView, isolationEvidence });
  const legacyAdmission = createOrderFlowerLegacyAdmission({ store, legacyConstraints, isolationEvidence,
    resources, isCurrent, currentNeedReconciler, readCurrentNeedSnapshot: ({ context, proposal }) =>
      currentNeedSnapshot(state(context), proposal), readLegacyOperation });
  const verifier = createOrderFlowerVerification({ isLeaseCurrent: ({ proposal, bridge }) => {
    const result = validateReadSnapshotLease({ leaseRef: bridge.leaseRef, operationId: proposal.operationId,
      originalContext: bridge.originalContext, newContext: bridge.newContext, after: bridge.after, bridgeFingerprint: bridge.bridgeFingerprint });
    return result?.valid === true && result.current === true;
  } });
  function configuration(context) {
    const row = store.get('SELECT subject_ref,dto_json,saved_revision,feature_cancel_json FROM backend_config_heads WHERE owner_ref=? AND account_ref=?', context.ownerRef, context.accountRef);
    return row?.subject_ref === context.subjectRef ? { config: parseStored(row.dto_json, '三类订单配置'), savedRevision: row.saved_revision,
      featureCancelEpochs: parseStored(row.feature_cancel_json, '三类订单取消代际') } : null;
  }
  function state(context, config = configuration(context), ownOperationId = null, { reconcileIdentity = true, demandOnly = false } = {}) {
    const view = readView(context), identities = reconcileIdentity ? identity.reconcile({ context, view }) : null;
    const official = readGenerationFacts(context), currentClock = clock(context.subjectRef);
    const open = eligibility.evaluate({ context, view, clock: currentClock });
    const planning = planOrderFlowerStock({ context, view, config, catalog, resources, eligibility: open,
      clock: currentClock, officialDay: official.officialDay, keepPolicy: KEEP, claimingOperationId: ownOperationId,
      storedOrderContract: ORDER_FLOWER_STORED_CONTRACT, readPolicyCount: deliveryAccounting.readPolicyCount, demandOnly });
    return { context, view, identities, config, official, clock: currentClock, open, planning };
  }
  function demandSnapshot(context, config = configuration(context)) {
    if (!context || isCurrent(context) !== true || !config) return { current: false, reasonCode: 'ORDER_FLOWER_DEMAND_CONTEXT_NOT_CURRENT', entries: [], protectedItems: {} };
    // Shared material consumers may run before ordinary delivery assessment.
    // Materialize identity from this same verified current read instead of
    // depending on the other feature having run first. This sends no request.
    const current = state(context, config, null, { reconcileIdentity: true, demandOnly: true });
    if (!current.view?.current || !current.view?.identity?.verified || !current.planning?.readOnly || current.planning.writeEligible !== false) {
      return { current: false, reasonCode: current.planning?.reasonCode || 'ORDER_FLOWER_DEMAND_PLAN_NOT_CURRENT', entries: [], protectedItems: {} };
    }
    const identities = current.identities;
    if (identities?.current !== true) return { current: false, reasonCode: 'ORDER_FLOWER_DEMAND_IDENTITY_NOT_CURRENT', entries: [], protectedItems: {} };
    const observedRows = new Map(currentOrderFlowerRows(current.view).map(one => [one.row.value.kind + ':' + one.row.value.boxId, one]));
    const entries = [];
    for (const row of current.planning.entries) {
      if (row.reasonCode === 'ORDER_FLOWER_ACTUAL_FLOWER_REQUIREMENTS_UNKNOWN')
        return { current: false, reasonCode: row.reasonCode, entries: [], protectedItems: {} };
      if (row.state !== 'demand') continue;
      if (!Array.isArray(row.requirements) || !row.source || !sourceCurrent({ source: row.source, current: true }, context)) {
        return { current: false, reasonCode: 'ORDER_FLOWER_DEMAND_REQUIREMENTS_UNBOUND', entries: [], protectedItems: {} };
      }
      const observed = observedRows.get(row.kind + ':' + row.boxId), life = identities.identities.find(one => one.kind === row.kind && one.boxId === row.boxId);
      // The wire-content hash includes presence/state, cooldown and video
      // fields. Occurrence identity intentionally uses its separate contract.
      // Bind both to the same actual row instead of comparing unlike hashes.
      if (!observed || observed.row.contentFingerprint !== row.contentFingerprint || observed.source.responseRef !== row.source.responseRef ||
          !life?.identityKnown || life.contentFingerprint !== fingerprint(orderFlowerContent(row.kind, row.boxId, orderFlowerPlainRow(observed.row))))
        return { current: false, reasonCode: 'ORDER_FLOWER_DEMAND_OCCURRENCE_IDENTITY_UNKNOWN', entries: [], protectedItems: {} };
      for (const need of row.requirements) {
        if (!positive(need.itemId) || !positive(need.quantity) || need.known !== true) {
          return { current: false, reasonCode: 'ORDER_FLOWER_DEMAND_QUANTITY_UNKNOWN', entries: [], protectedItems: {} };
        }
        entries.push({ featureId: row.featureId, kind: row.kind, itemId: need.itemId, quantity: need.quantity,
          orderRef: row.contentFingerprint, lifecycleRef: life.lifecycleRef, memberKey: 'order-flower:' + life.lifecycleRef,
          targetRef: 'flower-order:' + context.subjectRef + ':' + row.kind + ':' + row.boxId, sourceRef: row.source.responseRef });
      }
    }
    const protectedItems = {};
    for (const row of entries) protectedItems[row.itemId] = (protectedItems[row.itemId] || 0) + row.quantity;
    return { current: true, reasonCode: null, entries, protectedItems, planRef: current.planning.planRef };
  }
  const selectedRow = (current, kind, boxId) => currentOrderFlowerRows(current.view).find(({ row }) => row.value.kind === kind && row.value.boxId === boxId);
  function counter107(context, kind, boundVersion) {
    const value = readGenerationFacts(context).count107;
    return value?.current ? { uid: value.uid, type: value.type, raw: value.tdyCnt, totCnt: value.totCnt,
      rTime: value.rTimeMs, source: orderFlowerSafeSource(value.source, kind, boundVersion) } : null;
  }
  function factBasis(current, proposal) {
    const kind = proposal.orderFlower.kind, boxId = proposal.orderFlower.boxId, match = selectedRow(current, kind, boxId),
      life = current.identities.identities.find(one => one.kind === kind && one.boxId === boxId),
      candidate = current.planning.entries.find(one => one.kind === kind && one.boxId === boxId),
      definition = ORDER_FLOWER_CONTRACTS[kind], settings = current.config?.config?.orders?.[kind], open = current.open[kind];
    const stored = candidate?.deliveryPath === 'butler-stored-order' ? captureOrderFlowerStoredBefore({ context: current.context,
      view: current.view, accounting: current.planning.butlerAccounting, candidate, clock: current.clock, officialDay: current.official.officialDay }) : null;
    return freeze({ version: VERSION, target: { kind, boxId, lifecycleRef: life?.lifecycleRef ?? null,
      identityKnown: life?.identityKnown === true, contentFingerprint: life?.contentFingerprint ?? null,
      content: match ? orderFlowerContent(kind, boxId, orderFlowerPlainRow(match.row)) : null },
    officialIdentity: { uid: scalar(current.view.identity.uid), gameVersion: current.view.identity.source?.version?.gameVersion ?? null,
      protocolVersion: current.view.identity.source?.version?.protocolVersion ?? null },
    policy: { enabled: settings?.enabled ?? null, dailyLimit: settings?.dailyLimit ?? null,
      cancelEpoch: current.config?.featureCancelEpochs?.[definition.featureId] ?? null, keep: KEEP },
    day: { known: current.official.officialDay.known, key: current.official.officialDay.key ?? null,
      startMs: current.official.officialDay.startMs ?? null, endMs: current.official.officialDay.endMs ?? null,
      proofRef: current.official.officialDay.proofRef ?? null },
    counter: candidate?.count ? { raw: candidate.count.raw, total: candidate.count.total, rTime: candidate.count.rawRTime,
      effective: candidate.count.effective, value: candidate.count.value, limit: candidate.limit } : null,
    policyCount: candidate?.policyCount ? { value: candidate.policyCount.value, confirmedFloor: candidate.policyCount.confirmedFloor,
      floorReceiptRef: candidate.policyCount.floorReceiptRef, proofRef: candidate.policyCount.proofRef } : null,
    stored: orderFlowerStoredBasis(stored),
    eligibility: { known: open?.known === true, value: open?.value ?? null, openId: open?.openId ?? null },
    resources: proposal.resources.map(resource => { const itemId = Number(resource.resourceRef.slice(5)), b = resources.balance({ context: current.context, itemId });
      return { itemId, accountingVersion: b.accountingVersion ?? null }; }) });
  }
  function readFactBasis({ proposal }) {
    assertOrderFlowerProposal(proposal);
    return factBasis(state(orderFlowerContext(proposal)), proposal);
  }
  function currentNeedSnapshot(current, proposal) {
    const order = proposal.orderFlower, context = current.context, login = current.view.identity?.source;
    const shared = dynamicState?.currentNeedSnapshot?.({ context, feature: features.find(one => one.featureId === proposal.featureId),
      config: current.config?.config, method: proposal.method, proposal });
    const candidates = [order.source, order.day.source, ...order.beforeItems.map(one => one.source), order.beforeProfile.source,
      ...Object.values(order.beforeProfile.sources || {}), order.beforeRewards.source,
      ...Object.values(order.beforeRewards.sources || {}), ...(order.beforeLevelRewardItems || []).map(one => one.source),
      order.counter.source, order.beforeGenerationCounter?.source, ...order.beforeOtherCounters.map(one => one.source)]
      .filter(one => one?.kind === 'response' && one.connectionEpoch === context.connectionEpoch &&
        typeof one.responseRef === 'string' && Number.isSafeInteger(one.requestSequence) && one.requestSequence > 0 && typeof one.method === 'string');
    const sourceProofs = [...new Map(candidates.map(one => [canonical({ method: one.method, responseRef: one.responseRef,
      requestSequence: one.requestSequence, connectionEpoch: one.connectionEpoch }), { method: one.method, responseRef: one.responseRef,
      requestSequence: one.requestSequence, connectionEpoch: one.connectionEpoch }])).values()];
    if (login?.kind === 'response' && login.method === 'index.login' && login.connectionEpoch === context.connectionEpoch &&
        Number.isSafeInteger(login.requestSequence) && login.requestSequence > 0 && typeof login.responseRef === 'string') {
      sourceProofs.push({ method: 'index.login', responseRef: login.responseRef, requestSequence: login.requestSequence,
        connectionEpoch: login.connectionEpoch });
    }
    const unique = shared?.sourceProofs?.length ? shared.sourceProofs.filter(one => one.connectionEpoch === context.connectionEpoch)
      .map(one => ({ method: one.method, responseRef: one.responseRef, requestSequence: one.requestSequence, connectionEpoch: one.connectionEpoch }))
      : [...new Map(sourceProofs.map(one => [canonical(one), one])).values()];
    return { complete: (!dynamicState || shared?.complete === true) && current.view?.current === true && current.view.identity?.verified === true && order.occurrence?.identityKnown === true &&
        current.open?.[order.kind]?.known === true && current.official?.officialDay?.known === true && unique.length >= 1,
      identityVerified: current.view?.identity?.verified === true, method: 'index.login', responseRef: login?.responseRef ?? null,
      requestSequence: login?.requestSequence ?? null, connectionEpoch: context.connectionEpoch,
      officialUid: scalar(current.view.identity?.uid), gameVersion: current.view.identity?.source?.version?.gameVersion ?? null,
      protocolVersion: current.view.identity?.source?.version?.protocolVersion ?? null, sourceProofs: unique };
  }
  function savedPreparation(original) {
    if (original.original_fingerprint !== ledgerJsonFingerprint(original.original) || original.factBasis?.version !== VERSION) return null;
    const rows = store.all(`SELECT kind,source,payload_json,payload_fingerprint,observed_at FROM backend_operation_evidence
      WHERE operation_id=? AND source='backend/write-gateway/v2' AND kind IN ('finite-domain-preparation','admitted-operation-contract')`, original.operation_id);
    const decoded = [];
    for (const row of rows) {
      const payload = parseStored(row.payload_json, '鲜花订单原有限准备');
      if (ledgerJsonFingerprint({ kind: row.kind, source: row.source, payload, observedAt: row.observed_at }) !== row.payload_fingerprint) return null;
      decoded.push({ kind: row.kind, payload });
    }
    const preparations = decoded.filter(one => one.kind === 'finite-domain-preparation'), contracts = decoded.filter(one => one.kind === 'admitted-operation-contract');
    if (preparations.length !== 1 || contracts.length !== 1) return null;
    const data = preparations[0].payload.preparation, definition = ORDER_FLOWER_CONTRACTS[data?.kind];
    if (!definition || preparations[0].payload.domain !== 'order-flower-' + data.kind || original.scope !== definition.scope ||
        original.method !== definition.method || original.feature_id !== definition.featureId ||
        !orderFlowerHistoricalAdmittedContractMatches(contracts[0].payload, definition)) return null;
    const reconstructed = { ...original.original, featureCancelEpoch: original.original.cancelEpoch,
      params: data.kind === 'resident' ? { boxId: data.boxId } : {}, orderFlower: data };
    try { assertOrderFlowerProposal(reconstructed); } catch { return null; }
    return { data, preparationFingerprint: fingerprint(preparations[0].payload), contractFingerprint: fingerprint(contracts[0].payload) };
  }
  function modernHistory(current, proposal, basis, beforeSend, ownReservation) {
    const context = current.context, admission = sync(ledgerView.currentAdmission({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
      targetRefs: proposal.targets.map(target => target.targetRef) }));
    if (!Array.isArray(admission?.unresolvedOperations)) return 'ORDER_FLOWER_CURRENT_ADMISSION_UNAVAILABLE';
    if (admission.activeOperation && (!beforeSend || admission.activeOperation.operation_id !== proposal.operationId)) return 'ORDER_FLOWER_CURRENT_WRITE_IN_FLIGHT';
    const duplicate = store.get(`SELECT operation_id FROM backend_operations WHERE owner_ref=? AND subject_ref=? AND feature_id=?
      AND semantic_key=? AND transport_state!='not_sent' AND operation_id!=? LIMIT 1`, context.ownerRef, context.subjectRef, proposal.featureId, proposal.semanticKey, proposal.operationId);
    if (duplicate) return 'ORDER_FLOWER_ORIGINAL_OCCURRENCE_ALREADY_SENT';
    for (const one of admission.unresolvedOperations) {
      if (one.operation_id === proposal.operationId) continue;
      const original = sync(ledgerView.operation(one.operation_id));
      if (!original) return 'ORDER_FLOWER_ORIGINAL_AUDIT_UNREADABLE';
      if (!original.targets?.some(target => (target.target_ref ?? target.original?.targetRef) === proposal.targets[0].targetRef)) continue;
      const prepared = savedPreparation(original), old = prepared?.data;
      const currentNeedGeneration = proposal.orderFlower.currentNeed?.necessary === true &&
        proposal.semanticKey === 'order-flower-finish:' + proposal.orderFlower.lifecycleRef +
          ':current-need:' + proposal.orderFlower.currentNeed.decisionGeneration;
      if (original.owner_ref !== context.ownerRef || original.subject_ref !== context.subjectRef || original.scope !== proposal.scope ||
          original.method !== proposal.method || original.business_verdict !== 'unknown' || original.write_slot !== 0 ||
          original.original_fingerprint !== ledgerJsonFingerprint(original.original) || !currentNeedGeneration &&
          (!positive(old?.beforeOrder?.cTime) || proposal.orderFlower.beforeOrder.cTime <= old.beforeOrder.cTime ||
            old.lifecycleRef === proposal.orderFlower.lifecycleRef)) {
        return 'ORDER_FLOWER_PRIOR_TARGET_OCCURRENCE_UNPROVEN';
      }
      const isolation = sync(isolationEvidence.read({ context, operationId: original.operation_id }));
      if (!isolation?.available || isolation.previousExecution?.closed !== true) return 'ORDER_FLOWER_PRIOR_EXECUTION_CLOSURE_UNPROVEN';
      const reconciliationReason = currentNeedGeneration ? 'ORDER_FLOWER_CURRENT_NEED_AFTER_EXACT_CLOSED_EXECUTION'
        : 'ORDER_FLOWER_GENUINE_LATER_SERVER_OCCURRENCE';
      sync(ledgerView.recordAdmissionBasis({ operationId: original.operation_id, constraintKey: proposal.targets[0].targetRef,
        basisKey: fingerprint([proposal.semanticKey, basis, isolation.receiptHash]), conclusion: 'permit_current', factBasis: basis,
        affected: { targetRef: proposal.targets[0].targetRef, lifecycleRef: proposal.orderFlower.lifecycleRef,
          currentOperationId: proposal.operationId, currentNeedClaimRef: proposal.orderFlower.currentNeed.claimRef,
          currentNeedDecisionGeneration: proposal.orderFlower.currentNeed.decisionGeneration,
          originalOutcomeUnchanged: true, originalResourceFootprintsUnchanged: true },
        evidence: orderFlowerCurrentNeedAdmissionEvidence({ currentNeedGeneration, isolation,
          currentOrderSource: proposal.orderFlower.source, oldLifecycleRef: old?.lifecycleRef ?? null,
          oldTime: old?.beforeOrder?.cTime ?? null, currentTime: proposal.orderFlower.beforeOrder.cTime, prepared,
          claimRef: proposal.orderFlower.currentNeed.claimRef, decisionGeneration: proposal.orderFlower.currentNeed.decisionGeneration,
          reconciliationRef: store.get(`SELECT reconciliation_ref FROM backend_current_need_reconciliations
            WHERE claim_ref=? AND original_operation_id=? ORDER BY recorded_at DESC LIMIT 1`,
          proposal.orderFlower.currentNeed.claimRef, original.operation_id)?.reconciliation_ref ?? null }),
        reasonCode: reconciliationReason }));
    }
    const legacy = legacyAdmission.evaluate({ proposal, actor: context, factBasis: basis,
      boundary: beforeSend ? 'before-send' : 'before-prepare', ownReservation,
      resourceBaselineRef: admission.resourceBaseline?.baselineRef ?? null });
    return legacy.allowed ? null : legacy.reasonCode;
  }
  function evaluateAdmission({ proposal, actor, factBasis: suppliedBasis, boundary, ownReservation, includeBoundaryBasis = false }) {
    try { assertOrderFlowerProposal(proposal); } catch (error) { return freeze({ allowed: false, reasonCode: error.code || 'ORDER_FLOWER_PROPOSAL_INVALID' }); }
    const context = orderFlowerContext(proposal), beforeSend = boundary === 'before-send';
    const deny = reasonCode => freeze({ allowed: false, reasonCode, targetsCurrent: false, resourcesCurrent: false });
    if (!sameOrderFlowerContext(context, orderFlowerContext(actor)) || !isCurrent(context) || !['before-prepare', 'before-send'].includes(boundary) ||
        beforeSend && (ownReservation?.required !== true || ownReservation.operationId !== proposal.operationId)) return deny('ORDER_FLOWER_CURRENT_EXECUTION_OR_BOUNDARY_INVALID');
    const current = state(context, undefined, beforeSend ? proposal.operationId : null), basis = factBasis(current, proposal);
    if (canonical(suppliedBasis) !== canonical(basis) || canonical(proposal.factBasis) !== canonical(basis)) return deny('ORDER_FLOWER_ORIGINAL_FACT_BASIS_CHANGED');
    const currentNeedCheck = sync(currentNeedReconciler.isClaimCurrent({ claimRef: proposal.orderFlower.currentNeed?.claimRef,
      context, currentSnapshot: currentNeedSnapshot(current, proposal), currentNeed: proposal.orderFlower.currentNeed,
      operationId: beforeSend ? proposal.operationId : null }));
    if (currentNeedCheck?.accepted !== true) return deny(currentNeedCheck?.reasonCode || 'ORDER_FLOWER_CURRENT_NEED_NOT_CURRENT');
    const row = selectedRow(current, proposal.orderFlower.kind, proposal.orderFlower.boxId),
      candidate = current.planning.entries.find(one => one.kind === proposal.orderFlower.kind && one.boxId === proposal.orderFlower.boxId),
      life = current.identities.identities.find(one => one.kind === proposal.orderFlower.kind && one.boxId === proposal.orderFlower.boxId);
    if (!row || candidate?.state !== 'stock-candidate' || !life?.identityKnown || life.lifecycleRef !== proposal.orderFlower.lifecycleRef ||
        current.config?.featureCancelEpochs?.[proposal.featureId] !== proposal.featureCancelEpoch) return deny(candidate?.reasonCode || 'ORDER_FLOWER_CURRENT_OCCURRENCE_OR_POLICY_CHANGED');
    if (candidate.deliveryPath !== proposal.orderFlower.deliveryPath ||
        canonical(candidate.policyCount) !== canonical(proposal.orderFlower.policyCount) ||
        canonical(orderFlowerStoredBasis(proposal.orderFlower.beforeStored ?? null)) !== canonical(basis.stored)) {
      return deny('ORDER_FLOWER_ORIGINAL_DELIVERY_PATH_OR_POLICY_CHANGED');
    }
    if (beforeSend) {
      const own = sync(ledgerView.operation(proposal.operationId));
      if (!own || own.owner_ref !== context.ownerRef || own.account_ref !== context.accountRef || own.subject_ref !== context.subjectRef ||
          own.run_epoch !== context.runEpoch || own.connection_epoch !== context.connectionEpoch || own.write_slot !== 1 ||
          own.original_fingerprint !== ledgerJsonFingerprint(own.original) || own.feature_id !== proposal.featureId || own.scope !== proposal.scope ||
          own.method !== proposal.method || own.params_fingerprint !== proposal.paramsFingerprint || canonical(own.original.resources) !== canonical(proposal.resources) ||
          canonical(own.original.targets) !== canonical(proposal.targets) || canonical(own.original.resourceBindings) !== canonical(proposal.resourceBindings)) return deny('ORDER_FLOWER_OWN_ORIGINAL_RESERVATION_INVALID');
    }
    for (const need of orderFlowerRequirements(proposal.orderFlower.beforeOrder.flowers)) {
      const budget = sync(resources.budget({ context, itemId: need.itemId, quantity: need.quantity, keep: KEEP.keep,
        claimingOperationId: beforeSend ? proposal.operationId : null, requireOwnReservation: beforeSend }));
      if (!budget?.known || !budget.allowed || beforeSend && (budget.ownReservation?.valid !== true || budget.ownReservation.quantity !== need.quantity ||
          budget.ownReservation.resources?.length !== 1 || budget.ownReservation.resources[0].resourceKey !== proposal.resources.find(r => r.resourceRef === 'item:' + need.itemId)?.resourceKey)) {
        return deny(budget?.reasonCode || 'ORDER_FLOWER_EXACT_RESOURCE_BUDGET_REQUIRED');
      }
    }
    const history = modernHistory(current, proposal, basis, beforeSend, ownReservation);
    return history ? deny(history) : freeze({ allowed: true, reasonCode: null, targetsCurrent: true, resourcesCurrent: true,
      historicalConstraintsChecked: true, currentInFlightChecked: true, ...(includeBoundaryBasis ? { boundaryFactBasis: basis } : {}) });
  }
  async function assess(kind, input) {
    const definition = ORDER_FLOWER_CONTRACTS[kind];
    if (input.config?.config?.orders?.[kind]?.enabled !== true) return { state: 'disabled', reasonCode: 'ORDER_FLOWER_CATEGORY_DISABLED' };
    if (!isCurrent(input.context)) return wait('ORDER_FLOWER_CURRENT_EXECUTION_REQUIRED');
    const official = readGenerationFacts(input.context);
    if (official.snapshotRefresh?.required) {
      await requestFreshLogin({ context: input.context, snapshotRef: official.snapshotRefresh.snapshotRef, reasonCode: 'CUSTOMER_OFFICIAL_DAY_SNAPSHOT_EXPIRED' });
      return wait('ORDER_FLOWER_OFFICIAL_DAY_SNAPSHOT_REFRESH_REQUESTED');
    }
    const current = state(input.context, input.config), candidates = current.planning.entries.filter(one => one.kind === kind && one.state === 'stock-candidate');
    if (!candidates.length) {
      const exhausted = current.planning.entries.find(one => one.kind === kind && one.reasonCode === 'ORDER_FLOWER_DAILY_LIMIT_REACHED');
      const cap = orderFlowerDailyCapSuspension({ kind, exhausted, officialDay: current.official.officialDay, clock: current.clock,
        catalog, config: input.config?.config, configRevision: input.config.savedRevision });
      if (cap) return cap;
      const pending = current.planning.entries.filter(one => one.kind === kind && one.state === 'waiting-until' &&
        Number.isSafeInteger(one.earliestOfficialMs) && one.earliestOfficialMs > current.clock.nowMs)
        .sort((left, right) => left.earliestOfficialMs - right.earliestOfficialMs)[0];
      return pending ? { state: 'waiting-until', reasonCode: pending.reasonCode, officialDueMs: pending.earliestOfficialMs } : wait(current.planning.entries.find(one => one.kind === kind)?.reasonCode || current.planning.reasonCode);
    }
    let blockedCode = null, blockedFactBasis = null;
    for (const candidate of candidates) {
    const match = selectedRow(current, kind, candidate.boxId), life = current.identities.identities.find(one => one.kind === kind && one.boxId === candidate.boxId);
    if (!life?.identityKnown) { blockedCode ||= 'ORDER_FLOWER_OBSERVED_OCCURRENCE_BOUNDARY_REQUIRED'; continue; }
    const before = orderFlowerPlainRow(match.row), memberKey = 'order-flower:' + life.lifecycleRef,
      needs = orderFlowerRequirements(before.flowers), uid = scalar(current.view.identity.uid), financial = current.view.financial,
      versionEvidence = current.view.identity?.source?.version;
    const reservations = needs.map(need => resources.reservationSpec({ context: input.context, itemId: need.itemId,
      quantity: need.quantity, memberKey, lifecycleRef: life.lifecycleRef }));
    const profile = Object.fromEntries(['gold', 'yb', 'level', 'lvlExp'].map(key => [key, scalar(financial[key])]));
    if (!Object.values(profile).every(nonnegative) || !positive(profile.level)) return wait('ORDER_FLOWER_ABSOLUTE_PROFILE_REQUIRED');
    const proposal = { ...clone(input.context), operationId: newId(), proposalId: newId(), featureId: definition.featureId, scope: definition.scope,
      method: definition.method, params: kind === 'resident' ? { boxId: candidate.boxId } : {},
      semanticKey: 'order-flower-finish:' + life.lifecycleRef, configRevision: input.config.savedRevision,
      featureCancelEpoch: input.config.featureCancelEpochs[definition.featureId],
      targets: [{ memberKey, targetKind: definition.targetKind, targetRef: 'flower-order:' + input.context.subjectRef + ':' + kind + ':' + candidate.boxId,
        lifecycleRef: life.lifecycleRef, targetFingerprint: life.contentFingerprint }], resources: reservations,
      resourceBindings: reservations.map(resource => ({ resourceKey: resource.resourceKey, memberKey, quantity: resource.quantity })),
      orderFlower: { kind, boxId: candidate.boxId, lifecycleRef: life.lifecycleRef, contentFingerprint: life.contentFingerprint,
        occurrence: clone(life), officialUid: uid, versionEvidence: clone(versionEvidence), beforeOrder: before,
        source: orderFlowerSafeSource(match.source), beforeItems: needs.map((need, index) => { const balance = resources.balance({ context: input.context, itemId: need.itemId });
          return { itemId: need.itemId, quantity: balance.base.value, basisRef: reservations[index].basisRef, source: orderFlowerSafeSource(balance.base.source) }; }),
        beforeProfile: { ...profile, source: orderFlowerSafeSource(financial.gold.source),
          sources: Object.fromEntries(['gold', 'yb', 'level', 'lvlExp'].map(key => [key, orderFlowerSafeSource(financial[key].source)])) },
        beforeRewards: { satin: scalar(financial['1106']), decorate: scalar(financial['1340']), source: orderFlowerSafeSource(financial['1106'].source),
          sources: { satin: orderFlowerSafeSource(financial['1106'].source), decorate: orderFlowerSafeSource(financial['1340'].source) } },
        beforeLevelRewardItems: knownOrderFlowerCell(financial.levelRewardItems) && Array.isArray(financial.levelRewardItems.value)
          ? financial.levelRewardItems.value.map(one => ({ ...clone(one), source: orderFlowerSafeSource(one.source || financial.levelRewardItems.source) })) : null,
        deliveryPath: candidate.deliveryPath, policyCount: clone(candidate.policyCount),
        ...(candidate.deliveryPath === 'butler-stored-order' ? { beforeStored: captureOrderFlowerStoredBefore({ context: input.context,
          view: current.view, accounting: current.planning.butlerAccounting, candidate, clock: current.clock, officialDay: current.official.officialDay }) } : {}),
        // Delivery accounting persists and later compares the complete source
        // proof for this official counter. Keep that immutable proof intact;
        // the safe-source projection is for ancillary audit cells only.
        counter: clone(candidate.count), beforeGenerationCounter: counter107(input.context, kind, versionEvidence),
        beforeOtherCounters: [105, 109, 116].filter(id => id !== definition.counterId).flatMap(id => {
          const row = current.view.counters[id];
          return ['uid', 'type', 'tdyCnt', 'totCnt', 'rTime'].every(key => knownOrderFlowerCell(row?.[key]) && row[key].current)
            ? [{ uid: scalar(row.uid), type: id, raw: scalar(row.tdyCnt), totCnt: scalar(row.totCnt), rTime: scalar(row.rTime), source: orderFlowerSafeSource(row.tdyCnt.source, kind, versionEvidence) }] : [];
        }), day: clone(current.official.officialDay), limit: candidate.limit, eligibilityFingerprint: current.open.proofFingerprint, keepPolicy: KEEP } };
    proposal.paramsFingerprint = fingerprint(proposal.params);
    try {
      proposal.factBasis = readFactBasis({ proposal });
      const snapshot = currentNeedSnapshot(current, proposal), targetRef = proposal.targets[0].targetRef;
      const businessNeedRef = 'order-flower-need:' + fingerprint([proposal.featureId, targetRef, life.lifecycleRef]);
      const semanticFingerprint = fingerprint({ featureId: proposal.featureId, targetRef, lifecycleRef: life.lifecycleRef,
        contentFingerprint: life.contentFingerprint, factBasis: proposal.factBasis,
        resources: proposal.resources.map(one => [one.resourceRef, one.quantity]).sort((a, b) => a[0].localeCompare(b[0])) });
      const decisionGeneration = fingerprint({ semanticFingerprint, sourceProofs: snapshot.sourceProofs });
      const currentNeed = { necessary: true, featureId: proposal.featureId, targetRef, businessNeedRef,
        needRef: 'current-need:' + fingerprint([proposal.featureId, targetRef, businessNeedRef]), decisionGeneration,
        semanticFingerprint, basisRefs: [...new Set(snapshot.sourceProofs.map(one => one.responseRef))] };
      proposal.orderFlower.currentNeed = currentNeed;
      proposal.semanticKey += ':current-need:' + decisionGeneration;
      const admission = sync(ledgerView.currentAdmission({ ownerRef: input.context.ownerRef, subjectRef: input.context.subjectRef,
        targetRefs: [targetRef] }));
      const previous = admission?.unresolvedOperations?.map(one => sync(ledgerView.operation(one.operation_id))).filter(one => one &&
        one.business_verdict === 'unknown' && one.feature_id === proposal.featureId && one.method === proposal.method &&
        one.targets?.some(target => (target.target_ref ?? target.original?.targetRef) === targetRef)) || [];
      let claimed;
      if (previous.length) {
        let reconciled = null;
        for (const oldOperation of previous) {
          const exactClose = sync(isolationEvidence.read({ context: input.context, operationId: oldOperation.operation_id }));
          if (exactClose?.available !== true || exactClose.previousExecution?.closed !== true) {
            blockedCode ||= 'ORDER_FLOWER_PRIOR_EXECUTION_CLOSURE_UNPROVEN';
            reconciled = null;
            break;
          }
          const result = currentNeedReconciler.reconcile({ context: input.context, originalOperationId: oldOperation.operation_id,
            currentSnapshot: snapshot, currentNeed, operationId: proposal.operationId });
          if (result?.accepted !== true) {
            blockedCode ||= result?.reasonCode || 'ORDER_FLOWER_CURRENT_NEED_NOT_CLAIMED';
            reconciled = null;
            break;
          }
          reconciled = result;
        }
        claimed = reconciled;
      } else claimed = currentNeedReconciler.claimCurrent({ context: input.context, currentSnapshot: snapshot, currentNeed });
      if (claimed?.accepted !== true) { blockedCode ||= claimed?.reasonCode || 'ORDER_FLOWER_CURRENT_NEED_NOT_CLAIMED'; continue; }
      currentNeed.claimRef = claimed.claimRef;
      proposal.factBasis = readFactBasis({ proposal });
      const allowed = evaluateAdmission({ proposal, actor: input.context, factBasis: proposal.factBasis, boundary: 'before-prepare' });
      if (allowed.allowed) {
        const policy = candidate.policyCount, day = current.official.officialDay;
        const capReleaseProof = policy?.known === true && Number.isSafeInteger(policy.value) && policy.value >= 0 &&
          Number.isSafeInteger(candidate.limit) && candidate.limit > policy.value && day?.known === true &&
          day.key === policy.dayKey && day.officialUid === policy.officialUid && Number.isSafeInteger(day.endMs) && day.endMs > current.clock.nowMs &&
          typeof policy.proofRef === 'string' && typeof day.proofRef === 'string'
          ? { version: 'local-period-cap-release/v1', ownerRef: input.context.ownerRef, accountRef: String(input.context.accountRef),
            subjectRef: input.context.subjectRef, ownerEpoch: input.context.ownerEpoch, runEpoch: input.context.runEpoch,
            connectionEpoch: input.context.connectionEpoch, quotaKey: 'order-flower:' + kind, actionScope: 'feature',
            periodKind: 'official-day', periodKey: day.key, periodEndOfficialMs: day.endMs, used: policy.value, limit: candidate.limit,
            proofRefs: [...new Set([day.proofRef, policy.proofRef, policy.floorReceiptRef, policy.serverCount?.source?.responseRef,
              candidate.source?.responseRef].filter(value => typeof value === 'string' && value.length > 0))] } : null;
        return { state: 'proposals', proposals: [freeze(proposal)], factBasis: proposal.factBasis,
          ...(capReleaseProof ? { capReleaseProofs: [capReleaseProof] } : {}) };
      }
      blockedCode ||= allowed.reasonCode;
    } catch (error) {
      blockedCode ||= error.code || 'ORDER_FLOWER_PROPOSAL_NOT_READY';
      blockedFactBasis ||= boundedBindingDiagnostic(error.details);
    }
    }
    return wait(blockedCode || 'ORDER_FLOWER_NO_ADMITTED_CURRENT_CANDIDATE', blockedFactBasis);
  }
  const features = Object.values(ORDER_FLOWER_CONTRACTS).map(definition => {
    const operationContract = { ...definition, postRead: { ...ORDER_FLOWER_POST_READ, validateResponseCoverage: validateOrderFlowerSnapshotCoverage },
      validateTargetVerification: validateOrderFlowerTargetVerification };
    return Object.freeze({ featureId: definition.featureId,
      consumedDomains: ['order-flower', 'order-flower-counter', 'order-flower-eligibility', 'inventory', 'clock', 'profile'],
      currentNeedContracts: Object.freeze({ [definition.method]: ORDER_FLOWER_CURRENT_NEED_CONTRACT }),
      consumeCurrentNeed: ({ proposal }) => currentNeedReconciler.consumeCurrentNeed({ claimRef: proposal.orderFlower.currentNeed?.claimRef,
        operationId: proposal.operationId, decisionGeneration: proposal.orderFlower.currentNeed?.decisionGeneration,
        currentNeed: proposal.orderFlower.currentNeed, featureId: proposal.featureId }),
      consumedDomainsFor: orderFlowerDynamicDomains,
      scopes: [definition.scope], methods: [definition.method], release: 'validation-only',
      implementationVersion: 'order-flower-ordinary-single/v1', contractRef: definition.contractId, wakeKey: definition.featureId,
      priority: 0, factDomains: ['order-flower', 'land-domain'], factRequirements: [], operationContract,
      assess: input => assess(definition.kind, input), qualify: evaluateAdmission, verify: verifier.verify });
  });
  function onSettled(event) {
    const coverage = resources.planCoverage({ context: orderFlowerContext(event.proposal), operation: event.operation,
      targetSettlement: event.targetSettlement, postRead: event.postReads.at(-1), sendBinding: event.sendBinding, postReadBridge: event.postReadBridge });
    resources.applyCoverage(coverage);
    deliveryAccounting.recordConfirmed({ proposal: event.proposal, verification: event.verification, targetSettlement: event.targetSettlement });
    appendOutbox({ ownerRef: event.proposal.ownerRef, subjectRef: event.proposal.subjectRef, eventType: 'FlowerOrderOperationAudited',
      eventKey: event.proposal.operationId, payload: { operationId: event.proposal.operationId, verdict: event.verification.verdict } });
  }
  function reconcileDeliveryAccounting({ context }) {
    const rows = store.all(`SELECT o.operation_id FROM backend_operations o WHERE o.owner_ref=? AND o.subject_ref=?
      AND o.feature_id IN ('order.resident','order.satin','order.decorate') AND o.business_verdict='confirmed' AND o.write_slot=0
      AND o.method IN ('orderFlower.finishOrder','orderFlower.finishSatinOrder','orderFlower.finishDecorateOrder')
      AND NOT EXISTS(SELECT 1 FROM backend_order_flower_delivery_receipts r WHERE r.operation_id=o.operation_id)
      ORDER BY o.prepared_at,o.operation_id LIMIT 32`, context.ownerRef, context.subjectRef);
    let recorded = 0;
    const blocked = [];
    for (const row of rows) {
      try {
        const result = deliveryAccounting.recordConfirmed({ operationId: row.operation_id });
        if (result.recorded && !result.replayed) recorded += 1;
      } catch (error) { blocked.push({ operationId: row.operation_id, reasonCode: /^[A-Z][A-Z0-9_]{0,95}$/.test(error?.code || '') ? error.code : 'ORDER_DELIVERY_MATERIALIZATION_UNAVAILABLE' }); }
    }
    return freeze({ scanned: rows.length, recorded, blocked, originalOutcomesUnchanged: true, noGameRequestSent: true });
  }
  return Object.freeze({ features, readFactBasis, evaluateAdmission, planning: state, demandSnapshot, readPolicyCount: deliveryAccounting.readPolicyCount,
    consumeCurrentNeed: ({ proposal }) => currentNeedReconciler.consumeCurrentNeed({ claimRef: proposal?.orderFlower?.currentNeed?.claimRef,
      operationId: proposal?.operationId, decisionGeneration: proposal?.orderFlower?.currentNeed?.decisionGeneration,
      currentNeed: proposal?.orderFlower?.currentNeed, featureId: proposal?.featureId }),
    reconcileDeliveryAccounting, retireSources: sourceRetirement.retire, retireIdentities: identityHistory.retire, onSettled, onCurrentVerified: () => {} });
}
