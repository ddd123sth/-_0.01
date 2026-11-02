import { canonical, fingerprint, freeze, newId, problem } from '../../common.mjs';
import { artRecipeFingerprint } from './rpc-contract.mjs';
import { DAILY_ART_CONTRACT, DAILY_ART_POST_READ, assertDailyArtProposal, dailyArtTargetVerification } from './daily-rpc-contract.mjs';
import { timedSyncPhase } from '../../../performance-diagnostics.mjs';
import { createDailyArtHistory } from './daily-history.mjs';

const AXES = ['ownerRef','accountRef','subjectRef','ownerEpoch','runEpoch','connectionEpoch'];
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const contextView = context => Object.fromEntries(AXES.map(key => [key, key === 'accountRef' ? String(context[key]) : context[key]]));
const operationContracts = Object.freeze({ [DAILY_ART_CONTRACT.method]: Object.freeze({ ...DAILY_ART_CONTRACT,
  postRead: DAILY_ART_POST_READ, validateTargetVerification: dailyArtTargetVerification }) });

export function createDailyArtRuntime({ store, artRuntime, dynamicState, clock, officialDay, resources, readProfile, readConfiguration,
  readInputDemand, readInputDemandBatch = null, isCurrent, ledgerView, contextFor = () => null, readHistoryDay = () => null,
  inFlight = () => ({ inFlight: true }), appendOutbox = () => {} } = {}) {
  for (const fn of [store?.run,store?.get,store?.transaction,store?.nowIso,artRuntime?.dailyInputs,
    dynamicState?.snapshot,clock,officialDay,resources?.budget,resources?.reservationSpec,resources?.matchedItemFlow,resources?.balance,
    resources?.matchedProfileFlow,
    readProfile,readConfiguration,readInputDemand,readInputDemandBatch || (() => null),isCurrent,ledgerView?.currentAdmission,ledgerView?.operation,inFlight,appendOutbox])
    if (typeof fn !== 'function') throw new TypeError('Daily art runtime requires bounded shared ports');
  const { run, get, transaction, nowIso } = store;
  const sameCustomerContext = (left, right) => !!left && !!right && canonical(contextView(left)) === canonical(contextView(right));
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_daily_art_units(
    owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,day_key TEXT NOT NULL,art_id INTEGER NOT NULL,ordinal INTEGER NOT NULL,
    unit_ref TEXT NOT NULL,operation_id TEXT NOT NULL,state TEXT NOT NULL,updated_at TEXT NOT NULL,
    PRIMARY KEY(owner_ref,subject_ref,day_key,art_id,ordinal),UNIQUE(owner_ref,subject_ref,unit_ref));
    CREATE TRIGGER IF NOT EXISTS backend_daily_art_units_no_delete BEFORE DELETE ON backend_daily_art_units
      BEGIN SELECT RAISE(ABORT,'daily art unit history is retained'); END;`);
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_daily_art_unit_recoveries(
    recovery_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,official_uid INTEGER NOT NULL,
    day_key TEXT NOT NULL,art_id INTEGER NOT NULL,ordinal INTEGER NOT NULL,unit_ref TEXT NOT NULL,operation_id TEXT NOT NULL,
    login_response_ref TEXT NOT NULL,recipe_fingerprint TEXT NOT NULL,source_fingerprint TEXT NOT NULL,
    config_revision INTEGER NOT NULL,recorded_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS backend_daily_art_unit_recoveries_no_update BEFORE UPDATE ON backend_daily_art_unit_recoveries
      BEGIN SELECT RAISE(ABORT,'daily art unit recovery receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_daily_art_unit_recoveries_no_delete BEFORE DELETE ON backend_daily_art_unit_recoveries
      BEGIN SELECT RAISE(ABORT,'daily art unit recovery receipts are retained'); END;`);
  // One append-only row per prepare attempt. The unit row above is only the
  // current attempt pointer, so releasing a proven-not-sent attempt never
  // erases what was prepared or why it was abandoned.
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_daily_art_unit_attempts(
    attempt_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,day_key TEXT NOT NULL,
    art_id INTEGER NOT NULL,ordinal INTEGER NOT NULL,attempt INTEGER NOT NULL,unit_ref TEXT NOT NULL,
    operation_id TEXT NOT NULL,state TEXT NOT NULL,reason_code TEXT,recorded_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS backend_daily_art_unit_attempts_key ON backend_daily_art_unit_attempts(owner_ref,subject_ref,day_key,art_id,ordinal);
    CREATE TRIGGER IF NOT EXISTS backend_daily_art_unit_attempts_no_update BEFORE UPDATE ON backend_daily_art_unit_attempts
      BEGIN SELECT RAISE(ABORT,'daily art attempt history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_daily_art_unit_attempts_no_delete BEFORE DELETE ON backend_daily_art_unit_attempts
      BEGIN SELECT RAISE(ABORT,'daily art attempt history is retained'); END;`);
  const clockFor = context => {
    const value = clock(context.subjectRef);
    return value?.available === true && value.connectionEpoch === context.connectionEpoch &&
      Number.isSafeInteger(value.lowerBoundMs) && Number.isSafeInteger(value.upperBoundMs) && value.lowerBoundMs <= value.upperBoundMs ? value : null;
  };
  const dayFor = context => {
    const value = officialDay(context);
    return value?.current === true && typeof value.key === 'string' && Number.isSafeInteger(value.startMs) &&
      Number.isSafeInteger(value.endMs) && value.startMs < value.endMs && value.proofRef ? value : null;
  };
  function inputs(context, config, targetArtId = null) { return artRuntime.dailyInputs(context, config, targetArtId); }
  function domains(context, proposal) {
    const snapshot = dynamicState.snapshot({ context, feature, config: readConfiguration(context)?.config || null,
      method: proposal?.method || DAILY_ART_CONTRACT.method, proposal });
    if (snapshot?.current !== true || !Array.isArray(snapshot.domains)) return null;
    return snapshot.domains.map(domain => Object.fromEntries(['domainId','current','semanticRevision','semanticFingerprint','sourceRef',
      'sourceKind','method','requestSequence','observedAtMs','coverage','sourceProofs','dirty','reasonCode'].map(key => [key, domain[key]])));
  }
  function readFactBasis({ proposal, actor } = {}) {
    if (!actor || !isCurrent(actor)) return { current: false, reasonCode: 'DAILY_ART_CONTEXT_NOT_CURRENT' };
    const context = contextView(actor);
    const config = readConfiguration(context), source = inputs(context, config, proposal?.dailyArt?.artId), day = dayFor(context), time = clockFor(context), d = domains(context, proposal);
    return readFactBasisFromInputs({ proposal, actor, context, source, day, time, domains: d });
  }
  function readFactBasisFromInputs({ proposal, actor, context, source, day, time, domains: currentDomains } = {}) {
    if (!actor || !isCurrent(actor) || !source?.current || !day || !time || !currentDomains)
      return { current: false, reasonCode: 'DAILY_ART_FACTS_NOT_CURRENT' };
    return freeze({ current: true, fingerprint: fingerprint({ context: contextView(actor), source, day: { key: day.key, startMs: day.startMs,
      endMs: day.endMs, proofRef: day.proofRef }, domains: currentDomains, target: proposal?.dailyArt || null }) });
  }
  function relatedDemand(context, itemId) {
    const value = readInputDemand({ context, itemId });
    return value?.current === true && nonnegative(value.protectedQuantity) ? value : null;
  }
  function observedHistory(context, targetRef, artId, excludeOperationId = null) {
    const history = ledgerView.currentAdmission({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
      targetRefs: [targetRef], featureIds: [DAILY_ART_CONTRACT.featureId] });
    if (!Array.isArray(history?.unresolvedOperations)) return null;
    const boundaries = [];
    for (const row of history.unresolvedOperations) {
      if (row.operation_id === excludeOperationId) continue;
      const old = ledgerView.operation(row.operation_id);
      if (old?.business_verdict !== 'unknown' || !old.targets?.some(one => one.target_ref === targetRef)) continue;
      const proof = resources.observedArtCompletion?.({ context, operationId: row.operation_id, artId });
      if (!proof || proof.featureId !== DAILY_ART_CONTRACT.featureId || proof.targetRef !== targetRef || boundaries.length >= 16) return null;
      boundaries.push(proof);
    }
    return boundaries.sort((a, b) => a.operationId.localeCompare(b.operationId));
  }
  function evaluateAdmission({ proposal, actor, factBasis: supplied, boundary, ownReservation, allowFreshUnclaimed = false } = {}) {
    const flags = { historicalConstraintsChecked: true, currentInFlightChecked: true };
    if (!proposal || !actor || !isCurrent(actor)) return { ...flags, allowed: false, reasonCode: 'DAILY_ART_CONTEXT_NOT_CURRENT' };
    const context = contextView(actor);
    const config = readConfiguration(context), source = inputs(context, config, proposal?.dailyArt?.artId), day = dayFor(context), time = clockFor(context),
      currentDomains = domains(context, proposal);
    const basis = readFactBasisFromInputs({ proposal, actor, context, source, day, time, domains: currentDomains });
    if (!isCurrent(actor)) return { ...flags, allowed: false, reasonCode: 'DAILY_ART_CONTEXT_NOT_CURRENT' };
    const daily = proposal.dailyArt, entry = source?.entries?.find(one => one.artId === daily?.artId), unit = get(`SELECT * FROM backend_daily_art_units
      WHERE owner_ref=? AND subject_ref=? AND day_key=? AND art_id=? AND ordinal=?`, actor.ownerRef, actor.subjectRef, daily?.dayKey, daily?.artId, daily?.unitOrdinal);
    const priorUnit = allowFreshUnclaimed && !unit ? get(`SELECT ordinal,state,operation_id FROM backend_daily_art_units
      WHERE owner_ref=? AND subject_ref=? AND day_key=? AND art_id=? ORDER BY ordinal DESC LIMIT 1`,
      actor.ownerRef, actor.subjectRef, daily?.dayKey, daily?.artId) : null;
    const priorObserved = priorUnit?.state === 'unknown-held' && resources.observedArtCompletion?.({ context,
      operationId: priorUnit.operation_id, artId: daily?.artId });
    const priorCompleted = priorObserved && priorObserved.featureId === DAILY_ART_CONTRACT.featureId &&
      priorObserved.dayKey === daily?.dayKey && priorObserved.unitOrdinal === priorUnit.ordinal &&
      daily.currentNetNeedBoundaries?.some(one => one.operationId === priorUnit.operation_id && one.boundaryRef === priorObserved.boundaryRef);
    const freshClaimAvailable = allowFreshUnclaimed && (
      !unit && !priorUnit && daily?.unitOrdinal === 1 ||
      !unit && priorUnit?.ordinal === daily?.unitOrdinal - 1 && (priorUnit.state === 'confirmed' || priorCompleted) ||
      // A proven-not-sent attempt released its claim; the same ordinal may be
      // prepared again as this business opportunity's next attempt.
      unit && unit.state === 'not_sent' && unit.ordinal === daily?.unitOrdinal);
    if (config?.config?.art?.dailyMakeEnabled !== true || config?.config?.art?.autoReplenish !== true || !basis.current || supplied?.fingerprint !== basis.fingerprint || !day || day.key !== daily?.dayKey ||
        source?.current !== true || source.officialUid !== daily?.officialUid || !time || time.lowerBoundMs < day.startMs || time.upperBoundMs >= day.endMs ||
        !entry?.known || entry.recipe.recipeFingerprint !== daily.recipeFingerprint ||
        daily.mode !== config?.config?.art?.dailyMode || daily.targetStock !== config?.config?.art?.targetStock ||
        daily.batchQuantity !== proposal.params?.num ||
        daily.mode === 'chosen_quality' && !config?.config?.art?.dailyQualities?.includes(entry.quality) ||
        daily.mode === 'chosen_arts' && !config?.config?.art?.specifiedArts?.includes(daily.artId) ||
        !(unit?.unit_ref === daily.unitRef && unit.operation_id === proposal.operationId && unit.state === 'claimed') && !freshClaimAvailable)
      return { ...flags, allowed: false, reasonCode: 'DAILY_ART_FACTS_OR_TARGET_CHANGED' };
    const targetStock = daily.targetStock, actualStock = entry?.balances?.[String(daily.artId)]?.value;
    if (!nonnegative(actualStock) || Math.max(0, targetStock - actualStock) < daily.batchQuantity)
      return { ...flags, allowed: false, reasonCode: 'DAILY_ART_TARGET_STOCK_MET_OR_CHANGED' };
    if (boundary === 'before-send') for (const reservation of proposal.resources) {
      const inputId = Number(reservation.resourceRef.slice('item:'.length)), demand = relatedDemand(context, inputId);
      if (!demand) return { ...flags, allowed: false, reasonCode: 'DAILY_ART_RELATED_DEMAND_NOT_CURRENT' };
      const budget = resources.budget({ context, itemId: inputId, quantity: reservation.quantity, keep: demand.protectedQuantity,
        claimingOperationId: proposal.operationId, requireOwnReservation: ownReservation?.required === true });
      if (budget?.allowed !== true) return { ...flags, allowed: false, reasonCode: budget?.reasonCode || 'DAILY_ART_SHARED_INPUT_BUDGET_DENIED' };
    }
    const admission = ledgerView.currentAdmission({ ownerRef: actor.ownerRef, subjectRef: actor.subjectRef,
      targetRefs: proposal.targets.map(one => one.targetRef), resourceKeys: proposal.resources.map(one => one.resourceKey), featureIds: ['art.daily'] });
    if (!Array.isArray(admission?.unresolvedOperations)) return { ...flags, allowed: false, reasonCode: 'DAILY_ART_HISTORY_UNREADABLE' };
    for (const row of admission.unresolvedOperations) if (row.operation_id !== proposal.operationId) {
      const prior = ledgerView.operation(row.operation_id);
      if (prior?.business_verdict === 'unknown' && prior.targets?.some(one => one.target_ref === proposal.targets[0].targetRef)) {
        const proof = resources.observedArtCompletion?.({ context, operationId: row.operation_id, artId: daily.artId });
        if (!proof || proof.featureId !== DAILY_ART_CONTRACT.featureId || proof.targetRef !== proposal.targets[0].targetRef ||
            !daily.currentNetNeedBoundaries?.some(one => one.operationId === row.operation_id && one.boundaryRef === proof.boundaryRef))
          return { ...flags, allowed: false, reasonCode: 'DAILY_ART_PRIOR_UNKNOWN_HELD' };
      }
    }
    return { ...flags, allowed: true, targetsCurrent: true, resourcesCurrent: true, reasonCode: null };
  }
  function orphanClaim(input, source, sourceFingerprint, day, entry, previous) {
    if (!previous || previous.state !== 'claimed') return { recovered: null, reasonCode: 'DAILY_ART_PRIOR_UNIT_STATE_NOT_CLAIMED' };
    if (!positive(previous.ordinal) || typeof previous.operation_id !== 'string' || !previous.operation_id)
      return { recovered: null, reasonCode: 'DAILY_ART_PRIOR_UNIT_IDENTITY_INVALID' };
    const expectedUnitRef = 'art-daily-unit:' + fingerprint([input.context.ownerRef, input.context.subjectRef, day.key, entry.artId, previous.ordinal]);
    if (previous.unit_ref !== expectedUnitRef) return { recovered: null, reasonCode: 'DAILY_ART_PRIOR_UNIT_IDENTITY_MISMATCH' };
    const flight = inFlight({ subjectRef: input.context.subjectRef });
    if (!flight || flight.inFlight !== false) return { recovered: null, reasonCode: 'DAILY_ART_PRIOR_UNIT_ACTIVE_OPERATION' };
    // A prior claim is recoverable only while every durable prepare/send surface
    // is absent. SQL errors intentionally propagate; they are never treated as absence.
    const evidence = get(`SELECT
      EXISTS(SELECT 1 FROM backend_operations WHERE operation_id=?) AS operation,
      EXISTS(SELECT 1 FROM backend_operation_targets WHERE operation_id=? OR lifecycle_ref=?) AS target,
      EXISTS(SELECT 1 FROM backend_operation_resources WHERE operation_id=?) AS resource,
      EXISTS(SELECT 1 FROM backend_send_permits WHERE operation_id=?) AS permit`,
      previous.operation_id, previous.operation_id, previous.unit_ref, previous.operation_id, previous.operation_id);
    if (!evidence) return { recovered: null, reasonCode: 'DAILY_ART_PRIOR_UNIT_EVIDENCE_UNAVAILABLE' };
    if (evidence.operation || evidence.target || evidence.resource || evidence.permit)
      return { recovered: null, reasonCode: 'DAILY_ART_PRIOR_UNIT_PREPARE_EVIDENCE_PRESENT' };
    return { recovered: { ordinal: previous.ordinal, unitRef: expectedUnitRef, operationId: previous.operation_id,
      sourceFingerprint }, reasonCode: null };
  }
  function makeProposal(input, source, sourceFingerprint, day, entry, batchQuantity) {
    const context = contextView(input.context);
    const targetRef = `art-daily:${context.subjectRef}:${day.key}:${entry.artId}`;
    const currentNetNeedBoundaries = observedHistory(context, targetRef, entry.artId);
    if (!currentNetNeedBoundaries) return { proposal: null, reasonCode: 'DAILY_ART_PRIOR_UNKNOWN_HELD' };
    const previous = get(`SELECT ordinal,state,unit_ref,operation_id FROM backend_daily_art_units WHERE owner_ref=? AND subject_ref=? AND day_key=? AND art_id=? ORDER BY ordinal DESC LIMIT 1`,
      context.ownerRef, context.subjectRef, day.key, entry.artId);
    const notSent = previous?.state === 'not_sent' ? previous : null;
    const previousObserved = previous?.state === 'unknown-held' && currentNetNeedBoundaries.some(one =>
      one.operationId === previous.operation_id && one.dayKey === day.key && one.unitOrdinal === previous.ordinal);
    const orphan = previous && previous.state !== 'confirmed' && !notSent && !previousObserved ? orphanClaim(input, source, sourceFingerprint, day, entry, previous) : null;
    const recovered = orphan?.recovered || null;
    if (previous && previous.state !== 'confirmed' && !notSent && !recovered && !previousObserved) return { proposal: null, unitRef: previous.unit_ref || null,
      operationId: previous.operation_id || null, reasonCode: orphan?.reasonCode || 'DAILY_ART_PRIOR_UNIT_NOT_RECOVERABLE' };
    const retryAttempt = notSent ? Math.max(1, Number(get(`SELECT MAX(attempt) AS attempt FROM backend_daily_art_unit_attempts
      WHERE owner_ref=? AND subject_ref=? AND day_key=? AND art_id=? AND ordinal=?`, context.ownerRef, context.subjectRef, day.key,
      entry.artId, previous.ordinal)?.attempt || 0)) + 1 : 1;
    const ordinal = recovered?.ordinal ?? (notSent ? previous.ordinal : (previous?.ordinal || 0) + 1);
    const unitRef = recovered?.unitRef ?? (notSent
      ? 'art-daily-unit:' + fingerprint([input.context.ownerRef, input.context.subjectRef, day.key, entry.artId, ordinal, 'attempt', retryAttempt])
      : 'art-daily-unit:' + fingerprint([input.context.ownerRef, input.context.subjectRef, day.key, entry.artId, ordinal]));
    const operationId = recovered?.operationId ?? newId(), memberKey = 'art-daily:' + fingerprint([day.key, entry.artId, ordinal]);
    const proposalSourceFingerprint = recovered?.sourceFingerprint ?? sourceFingerprint;
    const target = { memberKey, targetKind: DAILY_ART_CONTRACT.targetKind, targetRef, lifecycleRef: unitRef,
      targetFingerprint: fingerprint({ targetRef, recipeFingerprint: entry.recipe.recipeFingerprint, unitRef, dayKey: day.key, batchQuantity }) };
    const reservations = entry.recipe.unitInputMultiset.map(one => resources.reservationSpec({ context, itemId: one.itemId,
      quantity: one.occurrences * batchQuantity, memberKey, lifecycleRef: unitRef }));
    const params = { vaseId: entry.recipe.vaseId, flowersIds: [...entry.recipe.flowersIds], num: batchQuantity };
    const proposal = { ...context, operationId, proposalId: newId(), featureId: DAILY_ART_CONTRACT.featureId, scope: DAILY_ART_CONTRACT.scope,
      method: DAILY_ART_CONTRACT.method, params, paramsFingerprint: fingerprint(params), contractRef: DAILY_ART_CONTRACT.contractRef,
      semanticKey: `art-daily:${day.key}:${entry.artId}:${ordinal}`, configRevision: input.config.savedRevision,
      featureCancelEpoch: input.config.featureCancelEpochs['art.daily'], targets: [target], resources: reservations,
      resourceBindings: reservations.map(one => ({ resourceKey: one.resourceKey, memberKey, quantity: one.quantity })),
      dailyArt: { dayKey: day.key, dayProofRef: day.proofRef, officialUid: source.officialUid, artId: entry.artId, vaseId: entry.recipe.vaseId,
        flowersIds: [...entry.recipe.flowersIds], recipeFingerprint: entry.recipe.recipeFingerprint, unitRef, unitOrdinal: ordinal,
        loginResponseRef: source.loginResponseRef, versionEvidence: entry.versionEvidence, dataSnapshotId: source.dataSnapshotId,
         sourceRef: source.source.responseRef, sourceFingerprint: proposalSourceFingerprint, rowProof: entry.recipe.rowProof,
        catalogSource: entry.recipe.catalogSource, outputItemRow: entry.recipe.outputItemRow, costContract: entry.cost.costContract,
        beforeBalances: Object.fromEntries(Object.entries(entry.balances).map(([id, value]) => [id, { value: value.value, basisRef: value.basisRef,
          source: value.source }])), beforeVase: entry.vase, targetStock: input.config.config.art.targetStock,
        batchQuantity, mode: input.config.config.art.dailyMode, quality: entry.quality, currentNetNeedBoundaries } };
    proposal.dailyArt.beforeProfile = entry.beforeProfile;
    proposal.dailyArt.costContract = entry.cost?.costContract ? { ...entry.cost.costContract, batchQuantity } : null;
    proposal.traceId = fingerprint({ featureId: proposal.featureId, semanticKey: proposal.semanticKey, sourceRef: proposal.dailyArt.sourceRef });
    assertDailyArtProposal(proposal);
    const basis = readFactBasis({ proposal, actor: input.context });
    if (!basis.current) return { proposal: null, recovered: null, unitRef, operationId,
      reasonCode: 'DAILY_ART_FACTS_NOT_CURRENT' };
    proposal.factBasis = basis;
    return { proposal: freeze(proposal), recovered, retry: notSent ? { ordinal, attempt: retryAttempt,
      previousOperationId: previous.operation_id, releasedUnitRef: previous.unit_ref } : null };
  }
  function maximumBatch(entry, targetStock, requested, itemBudgets) {
    const actualStock = entry.balances?.[String(entry.artId)]?.value;
    if (!nonnegative(actualStock)) return null;
    const shortage = Math.max(0, targetStock - actualStock);
    if (!shortage) return 0;
    let quantity = Math.min(shortage, requested);
    for (const one of entry.recipe.unitInputMultiset) {
      const budget = itemBudgets.get(one.itemId);
      if (budget?.known !== true || !nonnegative(budget.available)) return null;
      quantity = Math.min(quantity, Math.floor(budget.available / one.occurrences));
    }
    return { quantity, stock: actualStock };
  }
  function assess(input) {
    return timedSyncPhase('art.daily.assess', () => assessInPhase(input));
  }
  function assessInPhase(input) {
    if (input.config?.config?.art?.dailyMakeEnabled !== true || input.config?.config?.art?.autoReplenish !== true)
      return { state: 'disabled', reasonCode: 'DAILY_ART_REPLENISH_DISABLED' };
    if (!isCurrent(input.context)) return { state: 'waiting-facts', reasonCode: 'DAILY_ART_CONTEXT_NOT_CURRENT', deviceDueMs: Date.now() + 15000 };
    const context = contextView(input.context);
    const source = inputs(context, input.config), day = dayFor(context), time = clockFor(context);
    if (!source?.current || !day || !time || time.lowerBoundMs < day.startMs || time.upperBoundMs >= day.endMs)
      return { state: 'waiting-facts', reasonCode: 'DAILY_ART_CURRENT_DAY_OR_SOURCE_NOT_PROVEN', deviceDueMs: Date.now() + 15000 };
    const artConfig = input.config.config.art;
    const candidates = (source.entries || []).filter(entry => entry.known && entry.recipe);
    if (artConfig.dailyMode === 'chosen_quality') {
      const qualities = artConfig.dailyQualities;
      if (!Array.isArray(qualities) || !qualities.length) return { state: 'waiting-facts', reasonCode: 'DAILY_ART_QUALITY_SELECTION_REQUIRED', deviceDueMs: Date.now() + 30000 };
      for (let index = candidates.length - 1; index >= 0; index--) if (!qualities.includes(candidates[index].quality)) candidates.splice(index, 1);
    } else if (artConfig.dailyMode === 'chosen_arts') {
      const chosen = new Set(artConfig.specifiedArts || []);
      for (let index = candidates.length - 1; index >= 0; index--) if (!chosen.has(candidates[index].artId)) candidates.splice(index, 1);
    } else if (artConfig.dailyMode !== 'least_stock') {
      return { state: 'waiting-facts', reasonCode: 'DAILY_ART_MODE_UNSUPPORTED', deviceDueMs: Date.now() + 30000 };
    }
    const itemIds = [...new Set(candidates.flatMap(entry => entry.recipe.unitInputMultiset.map(one => one.itemId)))].sort((a,b)=>a-b);
    const demandSnapshot = readInputDemandBatch({ context, itemIds });
    const itemBudgets = new Map();
    const demandDiagnostics = [];
    for (const itemId of itemIds) {
      const demand = demandSnapshot?.items?.[String(itemId)];
      if (demand?.current === true && nonnegative(demand.protectedQuantity) && demand.budget?.known === true &&
          demand.budget.keep === demand.protectedQuantity && nonnegative(demand.budget.available)) {
        const budget = demand.budget;
        itemBudgets.set(itemId, budget);
        demandDiagnostics.push({ itemId, current: budget?.known === true, reasonCode: budget?.reasonCode || null,
          protectedQuantity: demand.protectedQuantity, available: nonnegative(budget?.available) ? budget.available : null });
      } else demandDiagnostics.push({ itemId, current: false, reasonCode: demand?.reasonCode || demandSnapshot?.reasonCode || demand?.budget?.reasonCode || 'ART_DAILY_RELATED_DEMAND_NOT_CURRENT',
        protectedQuantity: null, available: null });
    }
    const ranked = [], candidateDiagnostics = [];
    for (const entry of candidates) {
      const quantity = maximumBatch(entry, artConfig.targetStock, artConfig.makeBatch, itemBudgets);
      if (quantity === null) continue;
      if (quantity.quantity > 0) ranked.push({ entry, quantity: quantity.quantity, stock: quantity.stock });
    }
    ranked.sort((left, right) => left.stock - right.stock || left.entry.artId - right.entry.artId);
    let sourceFingerprint;
    for (const candidate of ranked) {
      const { entry, quantity } = candidate;
      if (sourceFingerprint === undefined) sourceFingerprint = timedSyncPhase('art.daily.sourceFingerprint', () => fingerprint(source));
      const built = makeProposal(input, source, sourceFingerprint, day, entry, quantity);
      if (built.proposal) {
        const admission = evaluateAdmission({ proposal: built.proposal, actor: input.context, factBasis: built.proposal.factBasis,
          boundary: 'before-prepare', allowFreshUnclaimed: !built.recovered });
        if (admission.allowed) {
          if (built.recovered) {
            const recoveryRef = 'art-daily-unit-recovery:' + fingerprint([built.proposal.ownerRef, built.proposal.accountRef,
              built.proposal.subjectRef, built.proposal.ownerEpoch, built.proposal.runEpoch, built.proposal.connectionEpoch,
              built.proposal.dailyArt.unitRef, built.proposal.operationId, built.proposal.dailyArt.officialUid,
              built.proposal.dailyArt.loginResponseRef, built.proposal.configRevision, built.proposal.dailyArt.recipeFingerprint,
              built.recovered.sourceFingerprint]);
            transaction(() => run(`INSERT OR IGNORE INTO backend_daily_art_unit_recoveries
              (recovery_ref,owner_ref,account_ref,subject_ref,owner_epoch,run_epoch,connection_epoch,official_uid,day_key,art_id,ordinal,unit_ref,
               operation_id,login_response_ref,recipe_fingerprint,source_fingerprint,config_revision,recorded_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, recoveryRef, built.proposal.ownerRef, built.proposal.accountRef, built.proposal.subjectRef,
              built.proposal.ownerEpoch, built.proposal.runEpoch, built.proposal.connectionEpoch, built.proposal.dailyArt.officialUid, day.key, entry.artId,
              built.proposal.dailyArt.unitOrdinal, built.proposal.dailyArt.unitRef, built.proposal.operationId,
              built.proposal.dailyArt.loginResponseRef,
              built.proposal.dailyArt.recipeFingerprint, built.recovered.sourceFingerprint, built.proposal.configRevision, nowIso()));
            const receipt = get(`SELECT recovery_ref,owner_ref,account_ref,subject_ref,owner_epoch,run_epoch,connection_epoch,official_uid,day_key,art_id,
              ordinal,unit_ref,operation_id,login_response_ref,recipe_fingerprint,source_fingerprint,config_revision
              FROM backend_daily_art_unit_recoveries WHERE recovery_ref=?`, recoveryRef);
            if (!receipt || receipt.owner_ref !== built.proposal.ownerRef || receipt.account_ref !== built.proposal.accountRef || receipt.subject_ref !== built.proposal.subjectRef ||
                receipt.owner_epoch !== built.proposal.ownerEpoch || receipt.run_epoch !== built.proposal.runEpoch || receipt.connection_epoch !== built.proposal.connectionEpoch ||
                receipt.official_uid !== built.proposal.dailyArt.officialUid || receipt.login_response_ref !== built.proposal.dailyArt.loginResponseRef ||
                receipt.day_key !== day.key || receipt.art_id !== entry.artId || receipt.ordinal !== built.proposal.dailyArt.unitOrdinal ||
                receipt.unit_ref !== built.proposal.dailyArt.unitRef || receipt.operation_id !== built.proposal.operationId ||
                receipt.recipe_fingerprint !== built.proposal.dailyArt.recipeFingerprint || receipt.source_fingerprint !== built.recovered.sourceFingerprint ||
                receipt.config_revision !== built.proposal.configRevision)
              throw problem('DAILY_ART_RECOVERY_RECEIPT_CONFLICT', '日常制作恢复依据不一致');
          } else {
            const attemptRef = 'art-daily-attempt:' + fingerprint([built.proposal.ownerRef, built.proposal.subjectRef, day.key, entry.artId,
              built.proposal.dailyArt.unitOrdinal, built.retry?.attempt || 1, built.proposal.dailyArt.unitRef, built.proposal.operationId]);
            if (built.retry) {
              transaction(() => {
                const changed = run(`UPDATE backend_daily_art_units SET unit_ref=?,operation_id=?,state='claimed',updated_at=?
                  WHERE owner_ref=? AND subject_ref=? AND day_key=? AND art_id=? AND ordinal=? AND state='not_sent' AND operation_id=?`,
                built.proposal.dailyArt.unitRef, built.proposal.operationId, nowIso(), built.proposal.ownerRef, built.proposal.subjectRef,
                day.key, entry.artId, built.proposal.dailyArt.unitOrdinal, built.retry.previousOperationId).changes;
                if (changed !== 1) throw problem('DAILY_ART_UNIT_CLAIM_CHANGED', '日常制作的上一未发尝试已变化，不能重新占用同一机会');
                run(`INSERT INTO backend_daily_art_unit_attempts(attempt_ref,owner_ref,subject_ref,day_key,art_id,ordinal,attempt,unit_ref,
                  operation_id,state,reason_code,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, attemptRef, built.proposal.ownerRef,
                built.proposal.subjectRef, day.key, entry.artId, built.proposal.dailyArt.unitOrdinal, built.retry.attempt,
                built.proposal.dailyArt.unitRef, built.proposal.operationId, 'claimed', 'DAILY_ART_PRIOR_ATTEMPT_PROVEN_NOT_SENT', nowIso());
              });
            } else transaction(() => {
              run(`INSERT INTO backend_daily_art_units(owner_ref,subject_ref,day_key,art_id,ordinal,unit_ref,operation_id,state,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?)`, built.proposal.ownerRef, built.proposal.subjectRef, day.key, entry.artId,
              built.proposal.dailyArt.unitOrdinal, built.proposal.dailyArt.unitRef, built.proposal.operationId, 'claimed', nowIso());
              run(`INSERT INTO backend_daily_art_unit_attempts(attempt_ref,owner_ref,subject_ref,day_key,art_id,ordinal,attempt,unit_ref,
                operation_id,state,reason_code,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, attemptRef, built.proposal.ownerRef,
              built.proposal.subjectRef, day.key, entry.artId, built.proposal.dailyArt.unitOrdinal, 1, built.proposal.dailyArt.unitRef,
              built.proposal.operationId, 'claimed', null, nowIso());
            });
          }
          return { state: 'proposals', proposals: [built.proposal], factBasis: built.proposal.factBasis };
        }
        candidateDiagnostics.push({ artId: entry.artId, unitRef: built.proposal.dailyArt.unitRef, operationId: built.proposal.operationId,
          reasonCode: admission.reasonCode || 'DAILY_ART_ADMISSION_DENIED' });
      } else {
        candidateDiagnostics.push({ artId: entry.artId, ...(built.unitRef ? { unitRef: built.unitRef } : {}),
          ...(built.operationId ? { operationId: built.operationId } : {}), reasonCode: built.reasonCode || 'DAILY_ART_PROPOSAL_UNAVAILABLE' });
      }
    }
    const failedDemand = demandSnapshot?.current !== true ? demandSnapshot?.reasonCode || 'ART_DAILY_RELATED_DEMAND_NOT_CURRENT'
      : demandDiagnostics.find(one => one.current !== true)?.reasonCode || null;
    const knownShortageButUnavailable = !failedDemand && demandDiagnostics.some(one => one.current && one.available === 0);
    return { state: 'waiting-facts', reasonCode: failedDemand || candidateDiagnostics[0]?.reasonCode || (knownShortageButUnavailable
      ? 'DAILY_ART_INPUT_BUDGET_UNAVAILABLE_OR_RESERVED' : 'DAILY_ART_NO_VERIFIED_STOCK_SHORTAGE'),
      factBasis: { demandSnapshotCurrent: demandSnapshot?.current === true, demandReasonCode: demandSnapshot?.reasonCode || null,
        itemDiagnostics: demandDiagnostics.slice(0, 32), candidateCount: candidates.length, candidateDiagnostics: candidateDiagnostics.slice(0, 32),
        candidateSamples: candidates.slice(0, 12).map(entry => ({ artId: entry.artId, vaseId: entry.recipe.vaseId,
          stock: nonnegative(entry.balances?.[String(entry.artId)]?.value) ? entry.balances[String(entry.artId)].value : null })) },
      deviceDueMs: Date.now() + 30000 };
  }
  async function verify({ proposal, response, connection } = {}) {
    const unknown = reasonCode => ({ verdict: 'unknown', reasonCode, verificationVersion: 'art-daily/target-postread/v2',
      evidence: { targetRef: proposal?.targets?.[0]?.targetRef || null, recipeFingerprint: proposal?.dailyArt?.recipeFingerprint || null,
        reasonCode, traceId: proposal?.traceId || null },
      resourceResolutions: (proposal?.resources || []).map(resource => ({ resourceKey: resource.resourceKey, state: 'historical_footprint' })) });
    let bridge; try { bridge = await connection.readSnapshotAfterClose(); } catch (error) { return unknown(error?.code || 'DAILY_ART_POSTREAD_FAILED'); }
    const post = bridge?.newLoginObservation, daily = proposal.dailyArt;
    if (bridge?.operationId !== proposal.operationId || bridge.oldPhysicalCloseReceipt?.closed !== true || post?.method !== 'index.login' ||
        post.source !== 'response' || post.transport !== 'answered' || post.envelopeOk !== true || post.dsName !== 'G.ISyncData' || bridge.officialUid !== daily.officialUid)
      return unknown('DAILY_ART_POSTREAD_INVALID');
    const config = readConfiguration(bridge.newContext);
    if (!config?.config?.art) return unknown('DAILY_ART_POSTREAD_CONFIGURATION_UNAVAILABLE');
    // The send is already answered. A later UI selection/cancellation cannot
    // change which original recipe needs verification, or hide its fresh facts.
    // Keep all current actor/source checks and inspect only that actual art.
    const verificationConfig = { ...config, config: { ...config.config, art: { ...config.config.art,
      dailyMode: 'chosen_arts', specifiedArts: [daily.artId], targetStock: daily.targetStock, makeBatch: daily.batchQuantity } } };
    const source = artRuntime.dailyPostWriteInputs(bridge.newContext, verificationConfig, daily.artId), day = dayFor(bridge.newContext);
    const entry = source?.entries?.find(one => one.artId === daily.artId);
    if (!source?.current || !day || day.key !== daily.dayKey || source.loginResponseRef !== post.responseRef || !entry?.known ||
        entry.recipe.recipeFingerprint !== daily.recipeFingerprint || entry.recipe.artId !== daily.artId || entry.recipe.vaseId !== daily.vaseId ||
        canonical(entry.recipe.flowersIds) !== canonical(daily.flowersIds) || entry.quality !== daily.quality ||
        canonical(entry.recipe.outputItemRow) !== canonical(daily.outputItemRow))
      return unknown('DAILY_ART_POSTREAD_RECIPE_OR_DAY_CHANGED');
    const knownOrMissingZero = (cell, coverage) => cell?.state === 'known' && Number.isSafeInteger(cell.value) && cell.value >= 0 ? cell.value :
      coverage?.presence === 'present' && coverage.state === 'known' && coverage.itemPresent === false ? 0 : null;
    const itemIds = [...new Set([daily.artId, ...daily.flowersIds])], flows = {}, deltas = {};
    for (const itemId of itemIds) {
      const flow = resources.matchedItemFlow({ context: proposal, source: response, method: proposal.method, itemId });
      const after = entry.balances?.[itemId], before = daily.beforeBalances?.[itemId];
      const gain = knownOrMissingZero(flow?.bi, flow?.biCoverage), debit = knownOrMissingZero(flow?.bo, flow?.boCoverage);
      if (!flow || flow.responseRef !== response.responseRef || flow.method !== proposal.method || flow.connectionEpoch !== response.connectionEpoch ||
          flow.requestSequence !== response.requestSequence || flow.wireKey !== response.wireKey || !after || !before ||
          !Number.isSafeInteger(gain) || !Number.isSafeInteger(debit)) return unknown('DAILY_ART_MATCHED_ITEM_FLOW_INCOMPLETE');
      const delta = after.value - before.value;
      const expectedGain = itemId === daily.artId ? daily.batchQuantity : 0;
      const expectedDebit = daily.flowersIds.filter(id => id === itemId).length * daily.batchQuantity;
      const bdSupplied = flow.bd?.presence === 'present';
      if (gain !== expectedGain || debit !== expectedDebit || delta !== gain - debit) return unknown('DAILY_ART_ITEM_DELTA_NOT_PROVEN');
      if (bdSupplied && (flow.bd?.state !== 'known' || !Number.isSafeInteger(flow.bd.value) || flow.bd.value !== after.value))
        return unknown('DAILY_ART_WRITE_ABSOLUTE_BALANCE_CONFLICT');
      flows[itemId] = { bi: gain, bo: debit, bd: flow.bd || null, frameFingerprint: flow.frameFingerprint, observationRef: flow.observationRef,
        requestSequence: flow.requestSequence, wireKey: flow.wireKey, responseRef: flow.responseRef };
      deltas[itemId] = { before: before.value, after: after.value, delta };
    }
    const beforeProfile = daily.beforeProfile, costContract = daily.costContract;
    const postProfile = readProfile({ context: bridge.newContext, itemIds: [daily.artId, ...daily.flowersIds] });
    if (!beforeProfile || !costContract || costContract.version !== 'art-daily/batched-inputs/v2' ||
        costContract.recipeFingerprint !== daily.recipeFingerprint || costContract.batchQuantity !== daily.batchQuantity ||
        canonical(costContract.unitInputMultiset) !== canonical(entry.recipe.unitInputMultiset) ||
        postProfile?.current !== true || !sameCustomerContext(postProfile.context, bridge.newContext) ||
        postProfile.profile?.gold?.state !== 'known' || postProfile.profile.gold.value !== beforeProfile.gold ||
        postProfile.profile?.yuanbao?.state !== 'known' || postProfile.profile.yuanbao.value !== beforeProfile.yuanbao ||
        postProfile.profile.gold.source?.responseRef !== post.responseRef || postProfile.profile.yuanbao.source?.responseRef !== post.responseRef)
      return unknown('DAILY_ART_CURRENCY_OR_ADDITIONAL_COST_UNPROVEN');
    const currencyFlows = {};
    for (const [itemId, field] of [[11, 'gold'], [1, 'yuanbao']]) {
      const flow = resources.matchedItemFlow({ context: proposal, source: response, method: proposal.method, itemId });
      const writeValue = knownOrMissingZero(flow?.bi, flow?.biCoverage), spendValue = knownOrMissingZero(flow?.bo, flow?.boCoverage);
      const profileFlow = resources.matchedProfileFlow({ context: proposal, source: response, method: proposal.method, field });
      if (!flow || writeValue !== 0 || spendValue !== 0 || profileFlow && profileFlow.value !== beforeProfile[field])
        return unknown('DAILY_ART_CURRENCY_WRITE_FLOW_UNPROVEN');
      currencyFlows[itemId] = { bi: writeValue, bo: spendValue, biCoverage: flow.biCoverage, boCoverage: flow.boCoverage,
        profileValue: profileFlow?.value ?? null, frameFingerprint: flow.frameFingerprint, responseRef: flow.responseRef,
        observationRef: flow.observationRef, requestSequence: flow.requestSequence, wireKey: flow.wireKey };
    }
    const evidence = { operationId: proposal.operationId, traceId: proposal.traceId, targetRef: proposal.targets[0].targetRef, recipeFingerprint: daily.recipeFingerprint, unitRef: daily.unitRef,
      dayKey: daily.dayKey, writeResponseRef: response.responseRef,
      after: bridge.after,
      newLogin: { connectionEpoch: post.connectionEpoch, requestSequence: post.requestSequence, wireKey: post.wireKey, responseRef: post.responseRef },
      postRead: { connectionEpoch: post.connectionEpoch, requestSequence: post.requestSequence, wireKey: post.wireKey, responseRef: post.responseRef },
      postReadRef: post.responseRef, bridgeFingerprint: bridge.bridgeFingerprint,
      dailyDataSnapshotId: daily.dataSnapshotId, postDataSnapshotId: source.dataSnapshotId, postLoginResponseRef: source.loginResponseRef,
      postVersionEvidence: entry.versionEvidence, postRowProof: entry.recipe.rowProof, postCatalogSource: entry.recipe.catalogSource,
      beforeProfile, afterProfile: { gold: postProfile.profile.gold.value, yuanbao: postProfile.profile.yuanbao.value },
      costContract, currencyFlows, flows, deltas };
    const resourceResolutions = proposal.resources.map(resource => {
      const itemId = Number(String(resource.resourceRef || '').replace(/^item:/, ''));
      const before = daily.beforeBalances?.[itemId], after = entry.balances?.[itemId], flow = flows[itemId];
      const occurrences = daily.flowersIds.filter(id => id === itemId).length;
      const quantity = occurrences * daily.batchQuantity;
      if (!Number.isSafeInteger(itemId) || itemId <= 0 || quantity <= 0 || resource.quantity !== quantity ||
          !before?.basisRef || !after?.source?.responseRef || after.source.responseRef !== post.responseRef || !flow || flow.bo !== quantity) return null;
      return { resourceKey: resource.resourceKey, state: 'released', quantity, basisRef: before.basisRef,
        postReadRef: post.responseRef, responseRef: response.responseRef, itemId, kind: 'quantity-reflected' };
    });
    if (resourceResolutions.length !== proposal.resources.length || resourceResolutions.some(one => !one?.resourceKey) ||
        new Set(resourceResolutions.map(one => one.resourceKey)).size !== proposal.resources.length)
      return unknown('DAILY_ART_RESOURCE_CONSUMPTION_UNBOUND');
    return { verdict: 'confirmed', verificationVersion: 'art-daily/target-postread/v2', postReadRef: post.responseRef,
      resourceResolutions, evidence: { ...evidence, resourceResolutions } };
  }
  function onNotSent({ proposal, operation } = {}) {
    if (!proposal || proposal.featureId !== DAILY_ART_CONTRACT.featureId || !proposal.dailyArt) return false;
    if (!operation || operation.operation_id !== proposal.operationId || operation.transport_state !== 'not_sent' ||
        operation.business_verdict !== 'not_applicable' || operation.write_slot !== 0) return false;
    const daily = proposal.dailyArt;
    return transaction(() => {
      const changed = run(`UPDATE backend_daily_art_units SET state='not_sent',updated_at=? WHERE owner_ref=? AND subject_ref=?
        AND day_key=? AND art_id=? AND ordinal=? AND operation_id=? AND state='claimed'`, nowIso(), proposal.ownerRef,
      proposal.subjectRef, daily.dayKey, daily.artId, daily.unitOrdinal, proposal.operationId).changes;
      if (changed !== 1) return false;
      const attempt = Math.max(1, Number(get(`SELECT MAX(attempt) AS attempt FROM backend_daily_art_unit_attempts WHERE owner_ref=?
        AND subject_ref=? AND day_key=? AND art_id=? AND ordinal=?`, proposal.ownerRef, proposal.subjectRef, daily.dayKey,
      daily.artId, daily.unitOrdinal)?.attempt || 1));
      const attemptRef = 'art-daily-attempt-release:' + fingerprint([proposal.ownerRef, proposal.subjectRef, daily.dayKey,
        daily.artId, daily.unitOrdinal, attempt, daily.unitRef, proposal.operationId]);
      run(`INSERT OR IGNORE INTO backend_daily_art_unit_attempts(attempt_ref,owner_ref,subject_ref,day_key,art_id,ordinal,attempt,unit_ref,
        operation_id,state,reason_code,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, attemptRef, proposal.ownerRef,
      proposal.subjectRef, daily.dayKey, daily.artId, daily.unitOrdinal, attempt, daily.unitRef, proposal.operationId,
      'not_sent', 'PROVEN_NOT_SENT', nowIso());
      appendOutbox({ ownerRef: proposal.ownerRef, subjectRef: proposal.subjectRef, eventType: 'FeatureNotSent',
        eventKey: 'daily-art-not-sent:' + proposal.operationId, payload: { operationId: proposal.operationId,
          featureId: DAILY_ART_CONTRACT.featureId, dayKey: daily.dayKey, artId: daily.artId, ordinal: daily.unitOrdinal,
          attempt, reasonCode: 'PROVEN_NOT_SENT' } });
      return true;
    });
  }
  function onSettled({ proposal, operation, verification } = {}) {
    const state = verification?.verdict === 'confirmed' ? 'confirmed' : operation?.transport_state === 'not_sent' ? 'not_sent' : 'unknown-held';
    transaction(() => run(`UPDATE backend_daily_art_units SET state=?,updated_at=? WHERE owner_ref=? AND subject_ref=? AND day_key=? AND art_id=? AND ordinal=? AND operation_id=?`,
      state, nowIso(), proposal.ownerRef, proposal.subjectRef, proposal.dailyArt.dayKey, proposal.dailyArt.artId, proposal.dailyArt.unitOrdinal, proposal.operationId));
    appendOutbox({ ownerRef: proposal.ownerRef, subjectRef: proposal.subjectRef, eventType: 'FeatureSettlement',
      eventKey: 'daily-art-settlement:' + proposal.operationId, payload: { operationId: proposal.operationId, featureId: DAILY_ART_CONTRACT.featureId,
        verdict: verification?.verdict || 'unknown', reasonCode: verification?.reasonCode || null, runEpoch: proposal.runEpoch,
        connectionEpoch: proposal.connectionEpoch, method: proposal.method } });
    return { visibility: 'current' };
  }
  const consumedDomainsFor = ({ config } = {}) => {
    const settings = config?.config ?? config ?? {}, orders = settings.orders || {};
    const domains = ['art-inputs','inventory','profile','clock'];
    if (orders.customer?.enabled === true) domains.push('customer','customer-eligibility');
    if (['resident','satin','decorate'].some(key => orders[key]?.enabled === true))
      domains.push('order-flower','order-flower-counter','order-flower-eligibility','order-flower-butler');
    return [...new Set(domains)];
  };
  const feature = Object.freeze({ featureId: DAILY_ART_CONTRACT.featureId, label: '日常花艺制作', phase: 'G4', scopes: [DAILY_ART_CONTRACT.scope],
    methods: [DAILY_ART_CONTRACT.method], methodScopes: { [DAILY_ART_CONTRACT.method]: DAILY_ART_CONTRACT.scope },
    consumedDomains: ['art-inputs','inventory','profile','clock','customer','customer-eligibility','order-flower','order-flower-counter',
      'order-flower-eligibility','order-flower-butler'], consumedDomainsFor, operationContracts, contractRef: DAILY_ART_CONTRACT.contractRef,
    resourceKinds: ['item'], factDomains: ['art-inputs','inventory','profile'], release: 'validation-only',
    implementationVersion: 'art-daily/independent-current-stock-unit/v1', scheduleUnits: [{ scheduleKey: 'art.daily:stock', wakeKey: 'art.daily:stock', assess }],
    assess, qualify: evaluateAdmission, verify, readFactBasis, evaluateAdmission, onSettled, onNotSent, onCurrentVerified: () => {} });
  const history = createDailyArtHistory({ store, ledgerView, readLiveScope: subjectRef => {
    const actor = contextFor(subjectRef);
    if (!actor || !isCurrent(actor)) return null;
    const context = contextView(actor);
    return { context, day: readHistoryDay(context), clock: clockFor(context) };
  } });
  return Object.freeze({ feature, assess, readFactBasis, evaluateAdmission, verify, onSettled, onNotSent, retireHistory: history.retire });
}
