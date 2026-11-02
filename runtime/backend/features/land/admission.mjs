import { canonical, fingerprint, freeze } from '../../common.mjs';
import { assertSingleProposal, field, legacyItemReservationKey, proposalContext, sameContext } from './rpc-contract.mjs';

// A current permission is deliberately narrower than an old result verdict.
// Closing the old invocation alone cannot prove a new crop, stage or cost.
export function proveLandStageSeparation({ context, land, life, proof, action = null, semanticKey = null }) {
  const fail = reasonCode => ({ allowed: false, reasonCode });
  if (proof?.available !== true || !sameContext(context, proof.currentCheckpoint) ||
      proof.original?.ownerRef !== context.ownerRef || proof.original?.subjectRef !== context.subjectRef ||
      !land?.current || !life || life.landId !== land.landId || !sameContext(context, life.context)) return fail('LAND_ISOLATION_PROOF_NOT_CURRENT');
  if (semanticKey && proof.original.semanticKey === semanticKey) return fail('LAND_ORIGINAL_SEMANTIC_RESULT_UNKNOWN');
  const previous = proof.previousExecution, source = land.source;
  if (!source || source.kind !== 'response' || source.connectionEpoch !== context.connectionEpoch ||
      !Number.isSafeInteger(source.requestSequence) || source.requestSequence < proof.currentCheckpoint.requestSequence || !source.responseRef) {
    return fail('LAND_CURRENT_TARGET_MATCHED_SOURCE_REQUIRED');
  }
  if (previous?.kind === 'matched-operation-response') {
    if (previous.operationRequestEnded !== true || previous.requestTerminated !== true ||
        previous.connectionEpoch !== context.connectionEpoch || !Number.isSafeInteger(previous.requestSequence) ||
        source.requestSequence <= previous.requestSequence) return fail('LAND_NEW_STAGE_AFTER_WRITE_READ_REQUIRED');
  } else if (previous?.closed !== true || previous.executionClosed !== true) return fail('LAND_OLD_EXECUTION_END_UNPROVEN');
  const metadata = proof.original.lifecycleTargetMetadata;
  if (metadata?.targetFactsConflictLandIds?.includes(land.landId)) return fail('LAND_ORIGINAL_TARGET_FACTS_CONFLICT');
  const before = proof.original.kind === 'backend' ? metadata?.targetBasis : metadata?.targets?.find(target => target.landId === land.landId);
  if (!before || before.landId !== land.landId) return fail('LAND_ORIGINAL_TARGET_BEFORE_UNAVAILABLE');
  const flower = field(land, 'flowerId'), plantTime = field(land, 'plantTime'), count = field(land, 'harvestCnt'), state = field(land, 'state');
  const oldOccupied = before.status === 'occupied' || Number.isSafeInteger(before.flowerId) && before.flowerId > 0;
  const oldEmpty = before.status === 'empty' || before.flowerId === 0;
  const currentOccupied = land.status === 'occupied' && Number.isSafeInteger(flower) && flower > 0;
  const sameFlower = currentOccupied && oldOccupied && before.flowerId === flower;
  const sameCrop = sameFlower && (before.cropRef && before.cropRef === life.cropRef ||
    Number.isSafeInteger(before.plantTime) && before.plantTime > 0 && before.plantTime === plantTime);
  let transition = null;
  if (land.status === 'empty' && (flower === 0 || state === 0 || land.explicitEmptyObject === true) && oldOccupied) transition = 'occupied-to-explicit-empty';
  else if (currentOccupied && oldEmpty && action !== 'plant') transition = 'explicit-empty-to-current-crop';
  else if (currentOccupied && oldOccupied && before.flowerId !== flower) transition = 'explicit-different-flower-crop';
  else if (sameFlower && Number.isSafeInteger(before.plantTime) && before.plantTime > 0 &&
      Number.isSafeInteger(plantTime) && plantTime > 0 && plantTime !== before.plantTime) transition = 'official-plant-time-changed';
  else if (sameCrop && Number.isSafeInteger(before.harvestCnt) && before.harvestCnt >= 0 &&
      Number.isSafeInteger(count) && count > before.harvestCnt) transition = 'same-crop-harvest-count-advanced';
  else if (sameCrop && before.state === 1 && [2, 3].includes(state) && action !== 'water') transition = 'same-crop-water-stage-advanced';
  if (!transition) return fail('LAND_GENUINE_NEW_TARGET_STAGE_UNPROVEN');
  return freeze({ allowed: true, reasonCode: 'LAND_PREVIOUS_INVOCATION_AND_NEW_STAGE_SEPARATE', transition,
    evidence: { version: 'land-current-stage-separation/v1', isolationReceiptRef: proof.receiptRef, isolationReceiptHash: proof.receiptHash,
      original: proof.original, previousExecution: previous, currentCheckpoint: proof.currentCheckpoint,
      currentTarget: { landId: land.landId, status: land.status, explicitEmptyObject: land.explicitEmptyObject === true,
        flowerId: flower ?? null, plantTime: plantTime ?? null, harvestCnt: count ?? null, state: state ?? null,
        cropRef: life.cropRef ?? null, emptyRef: life.emptyRef ?? null, needWaterStageRef: life.needWaterStageRef ?? null, harvestStageRef: life.harvestStageRef ?? null,
        source: { responseRef: source.responseRef, connectionEpoch: source.connectionEpoch, requestSequence: source.requestSequence, kind: source.kind } },
      transition, originalOutcomeUnchanged: true, originalResourceCoverageUnchanged: true } });
}

export function createLandAdmission({ projection, lifecycles, groups, resources, ledgerView, legacyConstraints, catalog = null, catalogForContext = () => catalog, isCurrent, readPlantPool,
  isolationEvidence, currentNeedReconciler = null, currentNeedSnapshot = null }) {
  function readFactBasis({ proposal }) {
    assertSingleProposal(proposal);
    const context = proposalContext(proposal), view = projection.view(context), land = view.lands[String(proposal.params.landId)];
    const life = lifecycles.get({ subjectRef: context.subjectRef, landId: proposal.params.landId });
    const stage = lifecycles.stageFor({ land: { subjectRef: context.subjectRef, landId: proposal.params.landId }, action: proposal.featureId });
    const base = { version: 'land-single-basis/v1', target: { landId: proposal.params.landId,
      semanticVersion: land?.semanticVersion ?? null, cropRef: life?.cropRef ?? null, lifecycleRef: stage.lifecycleRef ?? null,
      emptyRef: life?.emptyRef ?? null, flowerId: field(land, 'flowerId') ?? null,
      plantTime: field(land, 'plantTime') ?? null, harvestCnt: field(land, 'harvestCnt') ?? null,
      status: land?.status ?? null, state: field(land, 'state') ?? null },
      catalogVersion: catalogForContext(context)?.identity().manifestSha256 ?? null, groupRef: proposal.land.groupRef,
      groupMemberKey: proposal.land.groupMemberKey, roundRef: proposal.land.roundRef ?? null };
    if (proposal.featureId === 'plant') {
      const cultivation = view.cultivates[String(proposal.params.flowerId)];
      base.cultivation = { flowerId: proposal.params.flowerId, semanticVersion: cultivation?.semanticVersion ?? null };
      const pool = readPlantPool(proposal, view);
      base.poolFingerprint = pool.fingerprint ?? null;
      base.pool = pool.poolBasis ?? null;
      base.poolExcluded = pool.excluded;
    }
    if (proposal.featureId === 'water') {
      const balance = resources.balance({ context, itemId: 7 });
      base.waterAccountingVersion = balance.accountingVersion ?? null;
    }
    return freeze(base);
  }
  const denied = reasonCode => ({ allowed: false, historicalConstraintsChecked: true, currentInFlightChecked: true, reasonCode });
  function evaluateAdmission({ proposal, actor, factBasis, boundary = 'before-prepare', ownReservation = null }) {
    assertSingleProposal(proposal);
    const context = proposalContext(proposal), view = projection.view(context);
    if (!sameContext(context, actor) || !isCurrent(context) || !view.current || view.identity?.verified !== true) return denied('LAND_CURRENT_IDENTITY_REQUIRED');
    const projectionNow = ledgerView.currentAdmission({ subjectRef: context.subjectRef, ownerRef: context.ownerRef,
      targetRefs: proposal.targets.map(target => target.targetRef) });
    const ownId = boundary === 'before-send' ? proposal.operationId : null;
    if (boundary === 'before-send' && ownReservation?.operationId !== ownId ||
        boundary !== 'before-send' && ownReservation?.required === true) return denied('LAND_OWN_RESERVATION_MISMATCH');
    const active = projectionNow.activeOperation;
    if (active && active.operation_id !== ownId) return denied('LAND_CURRENT_WRITE_IN_FLIGHT');
    if (boundary === 'before-send') {
      const operation = ledgerView.operation(ownId);
      if (!operation || operation.owner_ref !== proposal.ownerRef || operation.subject_ref !== proposal.subjectRef ||
          operation.account_ref !== proposal.accountRef || operation.run_epoch !== proposal.runEpoch || operation.connection_epoch !== proposal.connectionEpoch ||
          operation.params_fingerprint !== proposal.paramsFingerprint || operation.write_slot !== 1 ||
          canonical(operation.original.targets) !== canonical(proposal.targets) ||
          canonical([...operation.original.resources].sort((a, b) => a.resourceKey.localeCompare(b.resourceKey))) !==
          canonical([...proposal.resources].sort((a, b) => a.resourceKey.localeCompare(b.resourceKey)))) {
        return denied('LAND_OWN_RESERVATION_MISSING');
      }
    }
    const currentNeed = proposal.land?.currentNeed;
    if (currentNeed) {
      if (!currentNeedReconciler || typeof currentNeedSnapshot !== 'function') return denied('LAND_CURRENT_NEED_PORT_MISSING');
      const checked = currentNeedReconciler.isClaimCurrent({ claimRef: currentNeed.claimRef, context,
        currentSnapshot: currentNeedSnapshot(proposal, view), currentNeed, operationId: ownId });
      if (checked?.accepted !== true) return denied(checked?.reasonCode || 'LAND_CURRENT_NEED_NOT_CURRENT');
    }
    const candidateFingerprint = fingerprint({ semanticKey: proposal.semanticKey, paramsFingerprint: proposal.paramsFingerprint,
      targets: proposal.targets, factBasis });
    for (const unresolved of projectionNow.unresolvedOperations) {
      if (unresolved.operation_id === ownId) continue;
      const original = ledgerView.operation(unresolved.operation_id);
      if (original?.semantic_key === proposal.semanticKey && !currentNeed) return denied('LAND_ORIGINAL_SEMANTIC_RESULT_UNKNOWN');
      if (original?.targets?.some(target => (target.target_ref ?? target.original?.targetRef) === proposal.targets[0].targetRef)) {
        const permit = projectionNow.bases.some(basis => basis.operation_id === original.operation_id && basis.basisCurrent === true &&
          basis.conclusion === 'permit_current' && basis.affected?.candidateFingerprint === candidateFingerprint &&
          sameContext(context, basis.evidence?.currentCheckpoint) &&
          canonical(basis.factBasis) === canonical(factBasis));
        if (!permit) {
          const proof = isolationEvidence.read({ context, operationId: original.operation_id });
          if (currentNeed) {
            const reconciled = currentNeedReconciler.reconcile({ context, originalOperationId: original.operation_id,
              currentSnapshot: currentNeedSnapshot(proposal, view), currentNeed, operationId: ownId });
            if (reconciled?.accepted === true) continue;
          }
          const separation = proveLandStageSeparation({ context, land: view.lands[String(proposal.params.landId)],
            life: lifecycles.get({ subjectRef: context.subjectRef, landId: proposal.params.landId }), proof,
            action: proposal.featureId, semanticKey: proposal.semanticKey });
          if (!separation.allowed) return denied(separation.reasonCode);
          ledgerView.recordAdmissionBasis({ operationId: original.operation_id, constraintKey: proposal.targets[0].targetRef,
            basisKey: fingerprint([candidateFingerprint, separation.evidence]), conclusion: 'permit_current', factBasis,
            affected: { candidateFingerprint, targetRef: proposal.targets[0].targetRef, lifecycleRef: proposal.targets[0].lifecycleRef },
            evidence: separation.evidence, reasonCode: separation.reasonCode });
        }
      }
    }
    if (!legacyConstraints?.candidateProjection) return denied('LAND_LEGACY_CONSTRAINT_PORT_MISSING');
    const rawTargetRefs = [`land:${proposal.params.landId}`];
    const rawResourceKeys = proposal.featureId === 'water' ? ['item:7'] : [];
    if (currentNeed && typeof currentNeedReconciler?.reconcileLegacyCandidate === 'function') {
      const reconciled = currentNeedReconciler.reconcileLegacyCandidate({ context, currentSnapshot: currentNeedSnapshot(proposal, view),
        currentNeed, legacyConstraints, isolationEvidence, rawTargetRefs, rawResourceKeys, semanticKey: proposal.semanticKey,
        factBasis, candidateFingerprint, action: proposal.featureId, methodScope: ['usrLand.plant', 'usrLand.water', 'usrLand.harvest'],
        resourceBaselineRef: projectionNow.resourceBaseline?.baselineRef });
      if (reconciled?.accepted !== true) return denied(reconciled?.reasonCode || 'LAND_LEGACY_CURRENT_NEED_UNPROVEN');
    }
    const legacy = legacyConstraints.candidateProjection({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
      semanticKey: proposal.semanticKey, rawTargetRefs, rawResourceKeys, factBasis, candidateFingerprint,
      resourceBaselineRef: projectionNow.resourceBaseline?.baselineRef });
    const scopeDiagnostics = [], metadataMatches = [];
    for (const operation of legacy.unclassifiedOperations) {
      if (!['plant', 'water', 'harvest'].includes(operation.scope)) continue;
      const proof = isolationEvidence.read({ context, legacyOperationRef: operation.operation_ref });
      const targets = proof.original?.lifecycleTargetMetadata?.targets || [];
      if (targets.some(target => target.landId === proposal.params.landId)) metadataMatches.push(operation);
      else scopeDiagnostics.push({ operationRef: operation.operation_ref, scopeGrade: targets.length ? 'explicit-other-target' : 'unresolved-target-scope',
        reasonCode: targets.length ? 'LAND_LEGACY_OTHER_TARGET_NOT_GLOBAL_HOLD' : 'LAND_LEGACY_SCOPE_UNRESOLVED_NOT_GLOBAL_HOLD' });
    }
    const matching = [...legacy.matchedTargets, ...legacy.matchedResources, ...legacy.semanticMatches,
      ...legacy.declaredTargetMatches, ...metadataMatches];
    for (const constraint of new Map(matching.map(item => [item.constraint_ref ?? item.operation_ref, item])).values()) {
      const constraintRef = constraint.constraint_ref ?? constraint.operation_ref;
      const permit = legacy.bases.some(basis => basis.constraint_ref === constraintRef && basis.conclusion === 'permit_current' &&
        basis.basisMatchesCurrentFacts === true && basis.source_fingerprint === constraint.source_fingerprint &&
        sameContext(context, basis.evidence?.currentCheckpoint) &&
        basis.affected?.candidateFingerprint === candidateFingerprint);
      if (!permit) {
        const operationRef = constraint.operation_ref;
        const resourceMatch = legacy.matchedResources.some(item => item.constraint_ref === constraintRef);
        const semanticMatch = legacy.semanticMatches.some(item => item.operation_ref === operationRef);
        const proof = typeof operationRef === 'string' && operationRef ? isolationEvidence.read({ context, legacyOperationRef: operationRef }) :
          { available: false, reasonCode: 'LAND_LEGACY_ORIGINAL_OPERATION_BINDING_UNAVAILABLE', receiptRef: null };
        let separation = !resourceMatch && !semanticMatch ? proveLandStageSeparation({ context,
          land: view.lands[String(proposal.params.landId)], life: lifecycles.get({ subjectRef: context.subjectRef, landId: proposal.params.landId }),
          proof, action: proposal.featureId, semanticKey: proposal.semanticKey }) :
          { allowed: false, reasonCode: resourceMatch ? 'LAND_LEGACY_RESOURCE_COVERAGE_UNPROVEN' : 'LAND_ORIGINAL_SEMANTIC_RESULT_UNKNOWN' };
        if (resourceMatch && !semanticMatch && proof.available === true && sameContext(context, proof.currentCheckpoint) &&
            proof.original?.ownerRef === context.ownerRef && proof.original?.subjectRef === context.subjectRef &&
            (proof.previousExecution?.closed === true && proof.previousExecution.executionClosed === true ||
              proof.previousExecution?.kind === 'matched-operation-response' && proof.previousExecution.requestTerminated === true)) {
          const budget = resources.budget({ context, itemId: 7, quantity: 1, keep: proposal.land.keepWater,
            claimingOperationId: ownId, requireOwnReservation: boundary === 'before-send' });
          const retained = budget.otherUnreflectedReservations.find(item => item.resourceKey === legacyItemReservationKey(constraint, proof));
          if (budget.known && budget.allowed && retained && Number.isSafeInteger(constraint.quantity) && constraint.quantity >= 0 &&
              retained.quantity === constraint.quantity && retained.unreflectedQuantity === constraint.quantity) separation = {
            allowed: true, reasonCode: 'LAND_LEGACY_RESOURCE_RETAINED_IN_CURRENT_BUDGET', evidence: {
              version: 'land-current-resource-retention/v1', isolationReceiptRef: proof.receiptRef, isolationReceiptHash: proof.receiptHash,
              currentCheckpoint: proof.currentCheckpoint, previousExecution: proof.previousExecution,
              retainedResource: retained, budgetAccountingVersion: budget.accountingVersion, available: budget.available,
              originalOutcomeUnchanged: true, resourceCoverageProven: false, originalResourceFootprintUnchanged: true } };
        }
        const evidence = separation.evidence || { source: 'land/admission/v1', currentTarget: factBasis.target,
          isolationReceiptRef: proof.receiptRef ?? null, isolationReasonCode: proof.reasonCode ?? null, previousResultUnchanged: true };
        legacyConstraints.appendBasis({ ownerRef: context.ownerRef, subjectRef: context.subjectRef, constraintRef,
          sourceFingerprint: constraint.source_fingerprint, basisKey: 'land:' + fingerprint([candidateFingerprint, separation.allowed, evidence]),
          conclusion: separation.allowed ? 'permit_current' : 'needs_evidence', factBasis,
          affected: { constraintRef, candidateFingerprint, rawTargetRefs, rawResourceKeys }, evidence, reasonCode: separation.reasonCode });
        if (!separation.allowed) return denied(separation.reasonCode);
      }
    }
    if (proposal.featureId === 'water') {
      const budget = resources.budget({ context, itemId: 7, quantity: 1, keep: proposal.land.keepWater,
        claimingOperationId: ownId, requireOwnReservation: boundary === 'before-send' });
      if (!budget.known || !budget.allowed) return denied(budget.reasonCode || 'LAND_WATER_BUDGET_NOT_CURRENT');
    }
    const land = view.lands[String(proposal.params.landId)];
    if (!land?.current || !catalogForContext(context)?.land(proposal.params.landId)) return denied('LAND_TARGET_NOT_CURRENT');
    return { allowed: true, historicalConstraintsChecked: true, currentInFlightChecked: true, candidateFingerprint, scopeDiagnostics, reasonCode: null };
  }
  return Object.freeze({ readFactBasis, evaluateAdmission });
}
