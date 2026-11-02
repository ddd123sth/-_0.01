import { canonical, clone, fingerprint, freeze, newId } from '../../common.mjs';
import { artRecipeFingerprint } from './rpc-contract.mjs';
import { createTechnicalHoldReviews } from './technical-hold-review.mjs';
import { CUSTOMER_ART_BATCH_CONTRACT, CUSTOMER_ART_BATCH_POST_READ, assertCustomerArtBatchProposal,
  captureCustomerArtBatchArgs, customerArtBatchAfterCloseLoginProof, customerArtBatchTargetVerification } from './customer-batch-contract.mjs';

const AXES = ['ownerRef','accountRef','subjectRef','ownerEpoch','runEpoch','connectionEpoch'];
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const scalar = cell => cell?.state === 'known' && Object.hasOwn(cell, 'value') ? cell.value : null;
const contextView = context => context && Object.freeze(Object.fromEntries(AXES.map(key => [key, key === 'accountRef' ? String(context[key]) : context[key]])));

export function createCustomerArtBatchRuntime({ store, artRuntime, resources, readProfile, dynamicState, readConfiguration,
  readInputDemand, isCurrent, ledgerView, appendOutbox = () => {} } = {}) {
  for (const fn of [store?.get,store?.run,store?.transaction,store?.nowIso,artRuntime?.customerBatchInputs,
    artRuntime?.customerBatchPostState,resources?.balance,resources?.budget,resources?.reservationSpec,
    resources?.matchedItemFlow,resources?.matchedProfileFlow,readProfile,dynamicState?.snapshot,readConfiguration,readInputDemand,
    isCurrent,ledgerView?.currentAdmission,ledgerView?.operation,appendOutbox])
    if (typeof fn !== 'function') throw new TypeError('Customer art batch requires bounded shared ports');
  const { get, run, nowIso, transaction } = store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_art_technical_holds(
      owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,feature_id TEXT NOT NULL,implementation_version TEXT NOT NULL,
      reason_code TEXT NOT NULL,operation_id TEXT NOT NULL,created_at TEXT NOT NULL,
      PRIMARY KEY(owner_ref,subject_ref,feature_id,implementation_version));
    CREATE TRIGGER IF NOT EXISTS backend_art_technical_holds_no_update BEFORE UPDATE ON backend_art_technical_holds
      BEGIN SELECT RAISE(ABORT,'art technical holds are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_art_technical_holds_no_delete BEFORE DELETE ON backend_art_technical_holds
      BEGIN SELECT RAISE(ABORT,'art technical holds are retained'); END;`);
  const technicalFailure = code => ['VERIFICATION_OPERATION_SCOPE_MISMATCH','VERIFICATION_OPERATION_CONTRACT_INVALID',
    'VERIFICATION_OPERATION_ORIGINAL_INVALID','DYNAMIC_COVERAGE_INVALID','WRITE_POST_READ_COVERAGE_UNPROVEN',
    'PROTOCOL_OBSERVATION_FAILED'].includes(code);
  const implementationVersion = 'art-customer-batch/accepted-parent-v3';
  const technicalHold = context => get(`SELECT reason_code FROM backend_art_technical_holds WHERE owner_ref=? AND subject_ref=? AND feature_id=? AND implementation_version=?`,
    context.ownerRef,context.subjectRef,CUSTOMER_ART_BATCH_CONTRACT.featureId,implementationVersion);
  const holdReviews = createTechnicalHoldReviews({ store });
  const holdKey = context => ({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
    featureId: CUSTOMER_ART_BATCH_CONTRACT.featureId, implementationVersion });
  const reviewKey = proposal => ({ ...holdKey(proposal), ...contextView(proposal), operationId: proposal.operationId });
  function claimTechnicalReview({ proposal } = {}) {
    if (!proposal || proposal.featureId !== CUSTOMER_ART_BATCH_CONTRACT.featureId || !isCurrent(proposal))
      return { accepted: false, reasonCode: 'CUSTOMER_ART_BATCH_CONTEXT_NOT_CURRENT' };
    const key = reviewKey(proposal), hold = holdReviews.state(key);
    if (!hold.held) return { accepted: true };
    const claimed = holdReviews.beginProbe(key);
    return { accepted: Boolean(claimed), reasonCode: claimed ? null : 'CUSTOMER_ART_BATCH_TECHNICAL_HOLD:' + hold.reasonCode };
  }
  function finishTechnicalReview({ proposal } = {}) {
    return proposal ? holdReviews.finishProbe(reviewKey(proposal)) : null;
  }
  const sameContext = (left, right) => !!left && !!right && canonical(contextView(left)) === canonical(contextView(right));
  const operationContracts = Object.freeze({ [CUSTOMER_ART_BATCH_CONTRACT.method]: Object.freeze({ ...CUSTOMER_ART_BATCH_CONTRACT,
    postRead: CUSTOMER_ART_BATCH_POST_READ, validateTargetVerification: customerArtBatchTargetVerification }) });
  const feature = Object.freeze({ featureId: CUSTOMER_ART_BATCH_CONTRACT.featureId, label: '顾客花艺批量制作', phase: 'G3B',
    scopes: [CUSTOMER_ART_BATCH_CONTRACT.scope], methods: [CUSTOMER_ART_BATCH_CONTRACT.method],
    methodScopes: { [CUSTOMER_ART_BATCH_CONTRACT.method]: CUSTOMER_ART_BATCH_CONTRACT.scope }, operationContracts,
    consumedDomains: ['art-inputs','inventory','customer','customer-eligibility','profile','clock'],
    resourceKinds: ['item'], factDomains: ['art-inputs','inventory','customer','customer-eligibility','profile'],
    release: 'validation-only', implementationVersion,
    contractRef: CUSTOMER_ART_BATCH_CONTRACT.contractRef,
    scheduleUnits: [{ scheduleKey: 'art.customer-batch:accepted', wakeKey: 'art.customer-batch:accepted', assess }],
    assess, qualify: evaluateAdmission, verify, readFactBasis, evaluateAdmission, onSettled, onCurrentVerified: () => {},
    claimTechnicalReview, finishTechnicalReview });

  function report(context, config = readConfiguration(context)) { return artRuntime.customerBatchInputs(contextView(context), config); }
  function domains(context, proposal) {
    const snapshot = dynamicState.snapshot({ context: contextView(context), feature, config: readConfiguration(context)?.config || null,
      method: CUSTOMER_ART_BATCH_CONTRACT.method, proposal });
    if (snapshot?.current !== true || !Array.isArray(snapshot.domains)) return null;
    return snapshot.domains.map(domain => Object.fromEntries(['domainId','current','semanticRevision','semanticFingerprint','sourceRef',
      'sourceKind','method','requestSequence','observedAtMs','coverage','sourceProofs','dirty','reasonCode'].map(key => [key, domain[key]])));
  }
  function stableBasis(proposal, actor) {
    if (!actor || !isCurrent(actor)) return { current: false, reasonCode: 'CUSTOMER_ART_BATCH_CONTEXT_NOT_CURRENT' };
    const context = contextView(actor), config = readConfiguration(context), facts = report(context, config), selected =
      facts?.entries?.find(row => row.parentLifecycleRef === proposal?.customerArtBatch?.parentLifecycleRef), d = domains(context, proposal);
    if (!facts?.current || !selected || !d || !facts.context || !sameContext(facts.context, context))
      return { current: false, reasonCode: facts?.reasonCode || 'CUSTOMER_ART_BATCH_FACTS_NOT_CURRENT' };
    return freeze({ current: true, fingerprint: fingerprint({ context, configRevision: config.savedRevision,
      featureCancelEpoch: config.featureCancelEpochs?.[CUSTOMER_ART_BATCH_CONTRACT.featureId] ?? 0,
      domains: d, parent: { lifecycleRef: selected.parentLifecycleRef, decisionRef: selected.parentDecisionRef,
        contentFingerprint: selected.parentContentFingerprint, need: selected.need, allocatedFinishedStock: selected.allocatedFinishedStock,
        actionableShortage: selected.actionableShortage }, recipeFingerprint: selected.recipeFingerprint,
      inputRows: selected.inputRows.map(row => ({ itemId: row.itemId, required: row.required, available: row.available, basisRef: row.basisRef,
        source: row.source })) }) });
  }
  function readFactBasis({ proposal, actor } = {}) { return stableBasis(proposal, actor || proposal); }
  function inputBudget(context, proposal, itemId, quantity, boundary, ownReservation) {
    const targetRef = proposal?.customerArtBatch?.targetRef || proposal?.targets?.[0]?.targetRef;
    const demand = readInputDemand({ context: contextView(context), itemId, excludeTargetRef: targetRef,
      ignoreDemandKinds: ['customer-art-batch'] });
    if (demand?.current !== true || !nonnegative(demand.protectedQuantity)) return null;
    return resources.budget({ context: contextView(context), itemId, quantity, keep: demand.protectedQuantity,
      ...(boundary === 'before-send' ? { claimingOperationId: proposal.operationId, requireOwnReservation: ownReservation?.required === true } : {}) });
  }
  function observedHistory(context,targetRef,artId,excludeOperationId=null){
    const prior=ledgerView.currentAdmission({ownerRef:context.ownerRef,subjectRef:context.subjectRef,targetRefs:[targetRef],featureIds:[CUSTOMER_ART_BATCH_CONTRACT.featureId]});
    if(!Array.isArray(prior?.unresolvedOperations))return null;
    const result=[];
    for(const row of prior.unresolvedOperations){if(row.operation_id===excludeOperationId)continue;
      const old=ledgerView.operation(row.operation_id);
      if(old?.business_verdict!=='unknown'||!old.targets?.some(t=>(t.target_ref??t.original?.targetRef)===targetRef))continue;
      const proof=resources.observedArtCompletion?.({context,operationId:row.operation_id,artId});
      if(!proof||proof.featureId!==CUSTOMER_ART_BATCH_CONTRACT.featureId||proof.targetRef!==targetRef||result.length>=16)return null;
      result.push(proof);
    }
    return result.sort((a,b)=>a.operationId.localeCompare(b.operationId));
  }
  function evaluateAdmission({ proposal, actor, factBasis: supplied, boundary, ownReservation } = {}) {
    if (!proposal || !actor || !isCurrent(actor)) return { allowed: false, reasonCode: 'CUSTOMER_ART_BATCH_CONTEXT_NOT_CURRENT' };
    const context = contextView(actor), config = readConfiguration(context), current = report(context, config), batch = proposal.customerArtBatch,
      row = current?.entries?.find(one => one.parentLifecycleRef === batch?.parentLifecycleRef), basis = stableBasis(proposal, actor);
    const hold=holdReviews.state(reviewKey(proposal));
    if(hold.held && !hold.probeAllowed && !hold.ownedProbe)
      return{allowed:false,reasonCode:'CUSTOMER_ART_BATCH_TECHNICAL_HOLD:'+hold.reasonCode};
    if (config?.config?.art?.makeEnabled !== true || config?.config?.orders?.customer?.enabled !== true || !current?.current || !row ||
        !basis.current || supplied?.fingerprint !== basis.fingerprint || config.savedRevision !== proposal.configRevision ||
        (config.featureCancelEpochs?.[proposal.featureId] ?? 0) !== proposal.featureCancelEpoch ||
        row.parentDecisionRef !== batch.parentDecisionRef || row.parentContentFingerprint !== batch.parentContentFingerprint ||
        row.artId !== batch.artId || row.need !== batch.orderNeed || row.actionableShortage !== batch.batchQuantity || row.recipeFingerprint !== batch.recipeFingerprint ||
        row.actionableShortage !== batch.batchQuantity || canonical(row.recipe.unitInputMultiset) !== canonical(batch.inputMultiset))
      return { allowed: false, reasonCode: 'CUSTOMER_ART_BATCH_ACCEPTED_PARENT_OR_SHORTAGE_CHANGED' };
    const held = ledgerView.currentAdmission({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
      targetRefs: proposal.targets.map(one => one.targetRef), resourceKeys: proposal.resources.map(one => one.resourceKey), featureIds: [proposal.featureId] });
    if (!Array.isArray(held?.unresolvedOperations)) return { allowed: false, reasonCode: 'CUSTOMER_ART_BATCH_HISTORY_UNREADABLE' };
    for (const prior of held.unresolvedOperations) if (prior.operation_id !== proposal.operationId) {
      const old = ledgerView.operation(prior.operation_id);
      if (old?.business_verdict === 'unknown' && old.targets?.some(target => target.target_ref === proposal.targets[0].targetRef)) {
        const proof=resources.observedArtCompletion?.({context,operationId:prior.operation_id,artId:batch.artId});
        if(!proof||proof.targetRef!==proposal.targets[0].targetRef||proof.parentLifecycleRef!==batch.parentLifecycleRef||
            !batch.currentNetNeedBoundaries?.some(saved=>saved.operationId===prior.operation_id&&saved.boundaryRef===proof.boundaryRef))
          return { allowed: false, reasonCode: 'CUSTOMER_ART_BATCH_PRIOR_UNKNOWN_HELD' };
      }
    }
    if (boundary === 'before-send') {
      if (ownReservation?.required !== true || ownReservation.operationId !== proposal.operationId)
        return { allowed: false, reasonCode: 'CUSTOMER_ART_BATCH_RESERVATION_REQUIRED' };
      for (const resource of proposal.resources) {
        const itemId = Number(resource.resourceRef.slice('item:'.length));
        const budget = inputBudget(context, proposal, itemId, resource.quantity, boundary, ownReservation);
        if (budget?.allowed !== true) return { allowed: false, reasonCode: budget?.reasonCode || 'CUSTOMER_ART_BATCH_SHARED_INPUT_BUDGET_DENIED' };
      }
    }
    return { allowed: true, targetsCurrent: true, resourcesCurrent: true, historicalConstraintsChecked: true,
      currentInFlightChecked: true, reasonCode: null };
  }
  function assess(input) {
    const context = contextView(input.context), config = input.config;
    if (config?.config?.art?.makeEnabled !== true || config?.config?.orders?.customer?.enabled !== true)
      return { state: 'disabled', reasonCode: 'CUSTOMER_ART_BATCH_DISABLED' };
    if (!context || !isCurrent(input.context)) return { state: 'waiting-facts', reasonCode: 'CUSTOMER_ART_BATCH_CONTEXT_NOT_CURRENT', deviceDueMs: Date.now() + 15000 };
    const facts = report(context, config);
    if (!facts?.current) return { state: 'waiting-facts', reasonCode: facts?.reasonCode || 'CUSTOMER_ART_BATCH_FACTS_NOT_CURRENT', deviceDueMs: Date.now() + 15000 };
    const hold=holdReviews.state(holdKey(context));
    if(hold.held && !hold.probeAllowed)return{state:'waiting-facts',reasonCode:'CUSTOMER_ART_BATCH_TECHNICAL_HOLD:'+hold.reasonCode,deviceDueMs:hold.nextProbeAtMs||Date.now()+30000};
    for (const row of facts.entries) {
      if (!positive(row.actionableShortage)) continue;
      // Definite physical shortfalls belong to the customer rejection module;
      // this producer waits without creating a partial batch.
      if (row.inputRows.some(one => one.available < one.required)) continue;
      const prior = ledgerView.currentAdmission({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
        targetRefs: [row.targetRef], featureIds: [CUSTOMER_ART_BATCH_CONTRACT.featureId] });
      if (!Array.isArray(prior?.unresolvedOperations)) return { state: 'waiting-facts', reasonCode: 'CUSTOMER_ART_BATCH_HISTORY_UNREADABLE', deviceDueMs: Date.now() + 15000 };
      const currentNetNeedBoundaries=observedHistory(context,row.targetRef,row.artId);
      if(!currentNetNeedBoundaries)continue;
      const result = makeProposal(input, context, row,currentNetNeedBoundaries);
      if (result) return { state: 'proposals', proposals: [result.proposal], factBasis: result.basis };
    }
    return { state: 'waiting-facts', reasonCode: 'CUSTOMER_ART_BATCH_NO_ADMISSIBLE_FULL_SHORTAGE', deviceDueMs: Date.now() + 15000 };
  }
  function makeProposal(input, context, row,currentNetNeedBoundaries=[]) {
    const uid = row.officialUid, art = input.config.config.art, operationId = newId();
      const targetRef = row.targetRef, lifecycleRef = row.parentLifecycleRef,
      memberKey = 'customer-art-batch:' + fingerprint([context.subjectRef, lifecycleRef]),
      target = { memberKey, targetKind: CUSTOMER_ART_BATCH_CONTRACT.targetKind, targetRef, lifecycleRef,
        targetFingerprint: fingerprint({ targetRef, lifecycleRef, parentDecisionRef: row.parentDecisionRef,
          recipeFingerprint: row.recipeFingerprint, batchQuantity: row.actionableShortage }) };
    const reservations = [];
    for (const one of row.inputRows) {
      const budget = inputBudget(context, { targets: [target], customerArtBatch: { targetRef } },
        one.itemId, one.required, 'before-prepare', null);
      if (budget?.allowed !== true) return null;
      reservations.push(resources.reservationSpec({ context, itemId: one.itemId, quantity: one.required, memberKey, lifecycleRef }));
    }
    const profile = readProfile({ context, itemIds: [...new Set([row.artId, ...row.inputRows.map(one => one.itemId)])] });
    if (profile?.current !== true || !sameContext(profile.context, context) || profile.identity?.verified !== true ||
        scalar(profile.identity.uid) !== uid || profile.profile?.gold?.state !== 'known' || !nonnegative(profile.profile.gold.value) ||
        profile.profile?.yuanbao?.state !== 'known' || !nonnegative(profile.profile.yuanbao.value)) return null;
    const params = { vaseId: row.recipe.vaseId, flowersIds: [...row.recipe.flowersIds], num: row.actionableShortage },
      captured = captureCustomerArtBatchArgs(params), epoch = input.config.featureCancelEpochs?.[CUSTOMER_ART_BATCH_CONTRACT.featureId] ?? 0,
      batch = { officialUid: uid, parentLifecycleRef: lifecycleRef, parentDecisionRef: row.parentDecisionRef,
        parentContentFingerprint: row.parentContentFingerprint, parentTargetRef: row.parentTargetRef, targetRef,
        parentNpcId: row.npcId, artId: row.artId,
        orderNeed: row.need, finishedStockAllocated: row.allocatedFinishedStock, batchQuantity: row.actionableShortage,
        vaseId: row.recipe.vaseId, flowersIds: [...row.recipe.flowersIds], recipeFingerprint: row.recipeFingerprint,
        catalogSource: clone(row.recipeSource), recipeRowProof: clone(row.recipeRowProof),
        inputMultiset: row.recipe.unitInputMultiset.map(one => ({ ...one })), inputBalances: row.inputRows.map(one => ({
          itemId: one.itemId, value: one.available, basisRef: one.basisRef, source: one.source })),
        beforeProduct: { value: row.finishedStock, basisRef: row.productBasisRef, source: row.productSource },
        beforeProfile: { gold: profile.profile.gold.value, yuanbao: profile.profile.yuanbao.value,
          goldSource: profile.profile.gold.source, yuanbaoSource: profile.profile.yuanbao.source },
        loginResponseRef: row.recipeSource.loginResponseRef, dataSnapshotId: row.recipeSource.dataSnapshotId,
        versionEvidence: clone(row.versionEvidence),currentNetNeedBoundaries };
    batch.versionEvidence = { ...(batch.versionEvidence || {}), loginResponseRef: batch.loginResponseRef, dataSnapshotId: batch.dataSnapshotId };
    const proposal = { ...context, operationId, proposalId: newId(), featureId: CUSTOMER_ART_BATCH_CONTRACT.featureId,
      scope: CUSTOMER_ART_BATCH_CONTRACT.scope, method: CUSTOMER_ART_BATCH_CONTRACT.method, contractRef: CUSTOMER_ART_BATCH_CONTRACT.contractRef,
      semanticKey: `customer-art-batch:${lifecycleRef}:${row.recipeFingerprint}`+(currentNetNeedBoundaries.length?
        ':current-net-need:'+fingerprint({decisionRef:row.parentDecisionRef,productBasisRef:row.productBasisRef,quantity:row.actionableShortage,
          boundaries:currentNetNeedBoundaries.map(one=>one.boundaryRef)}):''), configRevision: input.config.savedRevision,
      featureCancelEpoch: epoch, params, paramsFingerprint: captured.paramsFingerprint, customerArtBatch: batch,
      targets: [target], resources: reservations, resourceBindings: reservations.map(resource => ({ resourceKey: resource.resourceKey,
        memberKey, quantity: resource.quantity })) };
    proposal.traceId = fingerprint({ featureId: proposal.featureId, semanticKey: proposal.semanticKey, parentDecisionRef: row.parentDecisionRef });
    assertCustomerArtBatchProposal(proposal);
    const basis = stableBasis(proposal, input.context); if (!basis.current) return null;
    proposal.factBasis = basis;
    if (!evaluateAdmission({ proposal, actor: input.context, factBasis: basis, boundary: 'before-prepare' }).allowed) return null;
    return { proposal: freeze(proposal), basis };
  }
  async function verify({ proposal, response, connection } = {}) {
    const batch = proposal?.customerArtBatch, unknown = reasonCode => ({ verdict: 'unknown', reasonCode,
      verificationVersion: 'art-customer-batch/target-postread/v2', evidence: { targetRef: proposal?.targets?.[0]?.targetRef || null,
        parentLifecycleRef: batch?.parentLifecycleRef || null, batchQuantity: batch?.batchQuantity || null }, resourceResolutions: [] });
    let bridge; try { bridge = await connection.readSnapshotAfterClose(); } catch (error) { return unknown(error?.code || 'CUSTOMER_ART_BATCH_POSTREAD_FAILED'); }
    const postLogin = bridge?.newLoginObservation;
    if (bridge?.operationId !== proposal.operationId || bridge.oldPhysicalCloseReceipt?.closed !== true || bridge.officialUid !== batch.officialUid ||
        postLogin?.method !== 'index.login' || postLogin.source !== 'response' || postLogin.transport !== 'answered' || postLogin.envelopeOk !== true ||
        postLogin.dsName !== 'G.ISyncData' || postLogin.rejected === true || postLogin.versionEvidence?.loginResponseRef !== postLogin.responseRef)
      return unknown('CUSTOMER_ART_BATCH_POSTREAD_BRIDGE_INVALID');
    const post = artRuntime.customerBatchPostState(bridge.newContext, batch.artId);
    if (post?.current !== true || post.officialUid !== batch.officialUid || post.loginResponseRef !== postLogin.responseRef ||
      post.recipe.recipeFingerprint !== batch.recipeFingerprint || canonical(post.recipe.unitInputMultiset) !== canonical(batch.inputMultiset) ||
      post.recipe.source?.loginResponseRef !== postLogin.responseRef || post.recipe.rowProof?.loginResponseRef !== postLogin.responseRef)
      return unknown(post?.reasonCode || 'CUSTOMER_ART_BATCH_POST_FACTS_INVALID');
    const postProfile = readProfile({ context: contextView(bridge.newContext), itemIds: [batch.artId, ...batch.inputMultiset.map(one => one.itemId)] });
    if (postProfile?.current !== true || !sameContext(postProfile.context, bridge.newContext) || postProfile.profile?.gold?.state !== 'known' ||
        postProfile.profile.gold.value !== batch.beforeProfile.gold || postProfile.profile?.yuanbao?.state !== 'known' ||
        postProfile.profile.yuanbao.value !== batch.beforeProfile.yuanbao || postProfile.profile.gold.source?.responseRef !== postLogin.responseRef ||
        postProfile.profile.yuanbao.source?.responseRef !== postLogin.responseRef) return unknown('CUSTOMER_ART_BATCH_CURRENCY_DELTA_UNPROVEN');
    const ids = [...new Set([batch.artId, ...batch.inputMultiset.map(one => one.itemId)])], flows = {}, deltas = {}, resolutions = [];
    const flowValue = (cell, coverage) => cell?.state === 'known' && nonnegative(cell.value) ? cell.value :
      !cell && coverage?.presence === 'present' && coverage.state === 'known' && coverage.itemPresent === false ? 0 : null;
    for (const itemId of ids) {
      const flow = resources.matchedItemFlow({ context: proposal, source: response, method: proposal.method, itemId });
      const before = itemId === batch.artId ? batch.beforeProduct : batch.inputBalances.find(one => one.itemId === itemId),
        after = post.balances[itemId], expectedBi = itemId === batch.artId ? batch.batchQuantity : 0,
        inputRow = batch.inputMultiset.find(one => one.itemId === itemId), expectedBo = inputRow ? inputRow.occurrences * batch.batchQuantity : 0;
      const bi = flowValue(flow?.bi, flow?.biCoverage), bo = flowValue(flow?.bo, flow?.boCoverage);
      if (!flow || flow.responseRef !== response.responseRef || flow.method !== proposal.method || flow.connectionEpoch !== response.connectionEpoch ||
          flow.requestSequence !== response.requestSequence || flow.wireKey !== response.wireKey || !before || !after ||
          after.source?.kind !== 'response' || after.source.method !== 'index.login' || after.source.responseRef !== postLogin.responseRef ||
          after.source.connectionEpoch !== postLogin.connectionEpoch || after.source.requestSequence !== postLogin.requestSequence ||
          bi !== expectedBi || bo !== expectedBo ||
          !nonnegative(before.value) || !nonnegative(after.value) || after.value - before.value !== expectedBi - expectedBo ||
          flow.bd?.presence === 'present' && (flow.bd.state !== 'known' || flow.bd.value !== after.value))
        return unknown('CUSTOMER_ART_BATCH_ITEM_FLOW_OR_ABSOLUTE_DELTA_UNPROVEN');
      flows[itemId] = { bi, bo, biRaw: flow.bi || null, boRaw: flow.bo || null, biCoverage: flow.biCoverage || null,
        boCoverage: flow.boCoverage || null, bd: flow.bd || null, frameFingerprint: flow.frameFingerprint,
        observationRef: flow.observationRef, responseRef: flow.responseRef, requestSequence: flow.requestSequence, wireKey: flow.wireKey };
      deltas[itemId] = { before: before.value, after: after.value, delta: after.value - before.value };
      if (expectedBo > 0) {
        const reservation = proposal.resources.find(one => one.resourceRef === `item:${itemId}`);
        if (!reservation || reservation.quantity !== expectedBo) return unknown('CUSTOMER_ART_BATCH_RESOURCE_RESERVATION_UNBOUND');
        resolutions.push({ resourceKey: reservation.resourceKey, state: 'released', quantity: expectedBo, basisRef: before.basisRef,
          postReadRef: postLogin.responseRef, responseRef: response.responseRef, itemId, kind: 'quantity-reflected' });
      }
    }
    const currencyFlows = {};
    for (const [itemId, field] of [[11, 'gold'], [1, 'yuanbao']]) {
      const flow = resources.matchedItemFlow({ context: proposal, source: response, method: proposal.method, itemId });
      const profileFlow = resources.matchedProfileFlow({ context: proposal, source: response, method: proposal.method, field });
      if (!flow || flowValue(flow.bi, flow.biCoverage) !== 0 || flowValue(flow.bo, flow.boCoverage) !== 0 ||
          profileFlow && profileFlow.value !== batch.beforeProfile[field]) return unknown('CUSTOMER_ART_BATCH_CURRENCY_WRITE_FLOW_UNPROVEN');
      currencyFlows[itemId] = { bi: flowValue(flow.bi, flow.biCoverage), bo: flowValue(flow.bo, flow.boCoverage),
        biRaw: flow.bi || null, boRaw: flow.bo || null, biCoverage: flow.biCoverage || null, boCoverage: flow.boCoverage || null,
        profileValue: profileFlow?.value ?? null,
        frameFingerprint: flow.frameFingerprint, responseRef: flow.responseRef, observationRef: flow.observationRef };
    }
    const evidence = { operationId: proposal.operationId, traceId: proposal.traceId, targetRef: proposal.targets[0].targetRef,
      parentLifecycleRef: batch.parentLifecycleRef, parentDecisionRef: batch.parentDecisionRef, batchQuantity: batch.batchQuantity,
      artId: batch.artId, recipeFingerprint: batch.recipeFingerprint, writeResponseRef: response.responseRef, after: bridge.after,
      newLogin: { connectionEpoch: postLogin.connectionEpoch, requestSequence: postLogin.requestSequence,
        wireKey: postLogin.wireKey, responseRef: postLogin.responseRef }, postReadRef: postLogin.responseRef,
      bridgeFingerprint: bridge.bridgeFingerprint, sourceSnapshotRef: batch.dataSnapshotId, postDataSnapshotId: post.versionEvidence.dataSnapshotId,
      postVersionEvidence: post.versionEvidence, postRecipeSource: post.recipe.source, postRowProof: post.recipe.rowProof,
      beforeProduct: batch.beforeProduct, beforeProfile: batch.beforeProfile,
      afterProfile: { gold: postProfile.profile.gold.value, yuanbao: postProfile.profile.yuanbao.value },
      inputBalances: batch.inputBalances, currencyFlows, flows, deltas };
    const proof = customerArtBatchAfterCloseLoginProof({ proposal, response, bridge });
    if (resolutions.length !== proposal.resources.length || resolutions.some(one => !one.resourceKey) ||
        new Set(resolutions.map(one => one.resourceKey)).size !== proposal.resources.length)
      return unknown('CUSTOMER_ART_BATCH_RESOURCE_RESOLUTION_INCOMPLETE');
    return { verdict: 'confirmed', verificationVersion: 'art-customer-batch/target-postread/v2', postReadRef: postLogin.responseRef,
      resourceResolutions: resolutions, evidence: { ...evidence, postReadProof: proof } };
  }
  function onSettled({ proposal, verification } = {}) {
    if (verification?.verdict !== 'confirmed' && technicalFailure(verification?.reasonCode)) run(`INSERT OR IGNORE INTO backend_art_technical_holds
      (owner_ref,subject_ref,feature_id,implementation_version,reason_code,operation_id,created_at) VALUES(?,?,?,?,?,?,?)`,
      proposal.ownerRef,proposal.subjectRef,proposal.featureId,implementationVersion,verification.reasonCode,proposal.operationId,nowIso());
    finishTechnicalReview({ proposal });
    appendOutbox({ ownerRef: proposal.ownerRef, subjectRef: proposal.subjectRef, eventType: 'FeatureSettlement',
      eventKey: 'customer-art-batch:' + proposal.operationId, payload: { operationId: proposal.operationId,
        featureId: proposal.featureId, verdict: verification?.verdict || 'unknown', reasonCode: verification?.reasonCode || null,
        parentLifecycleRef: proposal.customerArtBatch.parentLifecycleRef, batchQuantity: proposal.customerArtBatch.batchQuantity,
        runEpoch: proposal.runEpoch, connectionEpoch: proposal.connectionEpoch, method: proposal.method } });
    return { visibility: 'current' };
  }
  return Object.freeze({ feature, assess, readFactBasis, evaluateAdmission, qualify: evaluateAdmission, verify, onSettled,
    claimTechnicalReview, finishTechnicalReview });
}
