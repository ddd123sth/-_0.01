import { clone, canonical, fingerprint, freeze, plainObject } from '../../common.mjs';
import { orderFlowerContext, sameOrderFlowerContext } from './wire-facts.mjs';
import { ORDER_FLOWER_CONTRACTS, assertOrderFlowerProposal } from './rpc-contract.mjs';

const VERSION = 'order-flower-legacy/current-candidate-v1';
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sync = value => { if (value?.then) { value.catch?.(() => {}); throw new TypeError('Legacy order admission requires synchronous ports'); } return value; };
const at = (value, path) => { for (const key of path) { if (!plainObject(value) || !Object.hasOwn(value, key)) return null; value = value[key]; } return value; };
const dateMs = value => positive(value) && value >= 1_000_000_000_000 && value <= 8640000000000000 ? value
  : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && positive(Date.parse(value)) &&
    [value, value.replace('Z', '.000Z')].includes(new Date(Date.parse(value)).toISOString()) ? Date.parse(value) : null;

// Same physical archived-item key as the shared resourceAdmission projection;
// uncertain installations retain separate transfer keys, never merge by origin
// alone. A key is not proof of payment, coverage, or a known legacy outcome.
export function orderFlowerLegacyResourceKey(constraint, proof) {
  const previous = proof?.available === true ? proof.previousExecution : null;
  const install = text(previous?.sourceInstallId) && text(previous?.sourceSignerFingerprint)
    ? { installId: previous.sourceInstallId, signerFingerprint: previous.sourceSignerFingerprint }
    : { unprovenTransferId: constraint.transfer_id };
  return 'legacy-item:' + fingerprint([install, constraint.source_origin_key, constraint.raw_ref]);
}

function originalBox(row, definition) {
  if (definition.kind !== 'resident') return definition.kind === 'satin' ? 7 : 8;
  if (!digest(row?.wire_args_fingerprint)) return null;
  // Original format only: vendored rpc-payload-binding.js capture serializes
  // ["rpc-method-args/1", method, args]. No old planner/decision is imported.
  const matches = [1, 2, 3, 4, 5, 6].filter(boxId => row.wire_args_fingerprint ===
    fingerprint(['rpc-method-args/1', definition.method, { boxId }]));
  return matches.length === 1 ? matches[0] : null;
}
function preparedCreation(row, definition, boxId) {
  if (typeof row?.prepared_evidence_json !== 'string' || row.prepared_evidence_json.length > 2_000_000) return null;
  let prepared; try { prepared = JSON.parse(row.prepared_evidence_json); } catch { return null; }
  const bound = prepared?.bound, facts = bound?.facts;
  if (!plainObject(bound) || !plainObject(facts) || !positive(row.connection_epoch) || !positive(row.owner_epoch) ||
    Number(bound.connectionEpoch) !== row.connection_epoch || Number(bound.ownerEpoch) !== row.owner_epoch ||
    !['index.login', 'orderFlower.enter'].includes(bound.sourceMethod ?? facts.sourceMethod)) return null;
  const named = definition.kind === 'resident' ? ['orderMap', String(boxId)] : [definition.kind === 'satin' ? 'orderSatin' : 'orderDecorate'];
  const raw = definition.kind === 'resident' ? ['1', String(boxId)] : [definition.kind === 'satin' ? '6' : '7'];
  const roots = [facts, facts.before].filter(plainObject), values = [];
  for (const root of roots) {
    for (const prefix of [['orderFlowerTot', 'orderFlower'], ['orderFlower']]) {
      const one = at(root, [...prefix, ...named]); if (plainObject(one)) values.push(dateMs(one.cTime));
    }
    const one = at(root, ['105', '0', ...raw]);
    if (plainObject(one)) values.push(dateMs(one[definition.kind === 'resident' ? '5' : '7']));
  }
  const known = [...new Set(values.filter(value => value !== null))];
  return known.length === 1 ? known[0] : null;
}

export function createOrderFlowerLegacyAdmission({ store, legacyConstraints, isolationEvidence, resources, isCurrent,
  currentNeedReconciler = null, readCurrentNeedSnapshot = null,
  readLegacyOperation = null, legacyResourceKey = orderFlowerLegacyResourceKey } = {}) {
  for (const fn of [store?.get, legacyConstraints?.candidateProjection, legacyConstraints?.appendBasis, isolationEvidence?.read,
    resources?.budget, isCurrent, legacyResourceKey]) if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') {
    throw new TypeError('Legacy order admission requires synchronous legacy/isolation/resource/current ports');
  }
  if (readLegacyOperation !== null && (typeof readLegacyOperation !== 'function' || readLegacyOperation.constructor?.name === 'AsyncFunction')) {
    throw new TypeError('Legacy single-row reader must be synchronous');
  }
  function evaluate({ proposal, actor, factBasis, boundary, ownReservation = null, resourceBaselineRef = null } = {}) {
    const diagnostics = [], applied = [];
    const finish = (allowed, reasonCode) => freeze({ allowed, reasonCode, historicalConstraintsChecked: true,
      currentInFlightChecked: false, constraintRefs: applied, scopeDiagnostics: diagnostics });
    try { assertOrderFlowerProposal(proposal); } catch { return finish(false, 'ORDER_FLOWER_LEGACY_PROPOSAL_INVALID'); }
    const context = orderFlowerContext(proposal), beforeSend = boundary === 'before-send';
    if (!sameOrderFlowerContext(context, orderFlowerContext(actor)) || sync(isCurrent(context)) !== true ||
      !['before-prepare', 'before-send'].includes(boundary) || canonical(factBasis) !== canonical(proposal.factBasis) ||
      beforeSend && (ownReservation?.required !== true || ownReservation.operationId !== proposal.operationId)) {
      return finish(false, 'ORDER_FLOWER_LEGACY_CURRENT_CANDIDATE_REQUIRED');
    }
    const target = proposal.targets[0], current = proposal.orderFlower;
    const candidateFingerprint = fingerprint({ semanticKey: proposal.semanticKey, paramsFingerprint: proposal.paramsFingerprint,
      targets: proposal.targets, factBasis });
    const rawTargetRefs = [target.targetRef], rawResourceKeys = proposal.resources.map(one => one.resourceRef);
    const currentNeed = current.currentNeed;
    if (currentNeed?.claimRef && currentNeedReconciler?.reconcileLegacyCandidate) {
      if (typeof readCurrentNeedSnapshot !== 'function') return finish(false, 'ORDER_FLOWER_LEGACY_CURRENT_NEED_SNAPSHOT_PORT_MISSING');
      const reconciled = sync(currentNeedReconciler.reconcileLegacyCandidate({ context,
        currentSnapshot: readCurrentNeedSnapshot({ context, proposal }), currentNeed, legacyConstraints, isolationEvidence,
        rawTargetRefs, rawResourceKeys, semanticKey: proposal.semanticKey, factBasis, candidateFingerprint,
        action: proposal.method, methodScope: [proposal.method], resourceBaselineRef }));
      if (reconciled?.accepted !== true) return finish(false, reconciled?.reasonCode || 'ORDER_FLOWER_LEGACY_CURRENT_NEED_UNPROVEN');
    }
    const projection = sync(legacyConstraints.candidateProjection({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
      semanticKey: proposal.semanticKey, rawTargetRefs, rawResourceKeys, factBasis, candidateFingerprint, resourceBaselineRef }));
    if (!projection || projection.ownerRef !== context.ownerRef || projection.subjectRef !== context.subjectRef ||
      !['operations', 'targets', 'resourceFootprints', 'bases', 'semanticMatches', 'matchedTargets', 'matchedResources', 'declaredTargetMatches']
        .every(key => Array.isArray(projection[key]))) return finish(false, 'ORDER_FLOWER_LEGACY_ADMISSION_UNAVAILABLE');
    const proofCache = new Map();
    const operationFor = ref => projection.operations.find(one => one.operation_ref === ref) || (text(ref)
      ? store.get('SELECT * FROM backend_legacy_operation_index WHERE operation_ref=? AND owner_ref=? AND subject_ref=?',
        ref, context.ownerRef, context.subjectRef) : null);
    function proofFor(operation) {
      if (!operation || !text(operation.operation_ref)) return null;
      if (!proofCache.has(operation.operation_ref)) proofCache.set(operation.operation_ref,
        sync(isolationEvidence.read({ context, legacyOperationRef: operation.operation_ref })));
      const proof = proofCache.get(operation.operation_ref), old = proof?.original, previous = proof?.previousExecution;
      return proof?.available === true && sameOrderFlowerContext(context, proof.currentCheckpoint) &&
        proof.currentCheckpoint.uid === current.officialUid && proof.currentCheckpoint.responseRef === current.source.responseRef &&
        proof.currentCheckpoint.requestSequence === current.source.requestSequence && proof.currentCheckpoint.wireKey === current.source.wireKey &&
        old?.kind === 'legacy' && old.operationRef === operation.operation_ref && old.ownerRef === context.ownerRef &&
        old.subjectRef === context.subjectRef && old.sourceFingerprint === operation.source_fingerprint &&
        previous?.closed === true && previous.executionClosed === true && digest(proof.receiptHash) && text(proof.receiptRef) ? proof : null;
    }
    function append(constraint, allowed, reasonCode, evidence) {
      if (sync(isCurrent(context)) !== true) return false;
      const constraintRef = constraint.constraint_ref ?? constraint.operation_ref;
      if (!text(constraintRef) || !digest(constraint.source_fingerprint)) return false;
      const capsule = { version: VERSION, currentCheckpoint: clone(context), ...evidence,
        originalOutcomeUnchanged: true, originalResourceFootprintsUnchanged: true, oldOperationNeverReplayed: true };
      sync(legacyConstraints.appendBasis({ ownerRef: context.ownerRef, subjectRef: context.subjectRef, constraintRef,
        sourceFingerprint: constraint.source_fingerprint, basisKey: 'order-flower:' + fingerprint([candidateFingerprint, constraintRef, allowed, capsule]),
        conclusion: allowed ? 'permit_current' : 'needs_evidence', factBasis,
        affected: { constraintRef, candidateFingerprint, targetRef: target.targetRef, lifecycleRef: current.lifecycleRef, rawTargetRefs, rawResourceKeys },
        evidence: capsule, reasonCode }));
      applied.push(constraintRef); return true;
    }
    // An original exact semantic match is never made new by config/run/UUID.
    if (projection.semanticMatches.length) return finish(false, 'ORDER_FLOWER_LEGACY_ORIGINAL_SEMANTIC_HELD');
    for (const constraint of projection.matchedTargets) if (!operationFor(constraint.operation_ref)) {
      append(constraint, false, 'ORDER_FLOWER_LEGACY_EXACT_TARGET_ORIGIN_REQUIRED', { originalOperationBindingAvailable: false });
      return finish(false, 'ORDER_FLOWER_LEGACY_EXACT_TARGET_ORIGIN_REQUIRED');
    }
    const explicit = new Set([...projection.matchedTargets, ...projection.declaredTargetMatches].map(one => one.operation_ref));
    for (const operation of projection.operations) {
      const definition = Object.values(ORDER_FLOWER_CONTRACTS).find(one => one.method === operation.method);
      if (!definition && !explicit.has(operation.operation_ref)) continue;
      if (definition && definition.kind !== current.kind && !explicit.has(operation.operation_ref)) continue;
      let row = null;
      // Reading one owner/subject/SHA-bound immutable row establishes a target
      // mapping only. It grants no execution/closure permission. Classify the
      // actual box before asking for isolation of a matching old invocation.
      if (readLegacyOperation) {
        row = sync(readLegacyOperation({ archiveId: operation.archive_id, transferId: operation.transfer_id,
          ownerRef: context.ownerRef, accountRef: operation.account_ref, subjectRef: context.subjectRef,
          sourceTable: 'game_write_operations', expectedFingerprint: operation.source_fingerprint }));
        if (!plainObject(row) || fingerprint(row) !== operation.source_fingerprint || row.operation_id !== operation.source_operation_id ||
          row.method !== operation.method || (typeof row.subject_ref === 'string' ? row.subject_ref : null) !== operation.source_subject_ref) {
          return finish(false, 'ORDER_FLOWER_LEGACY_ORIGINAL_ROW_INVALID');
        }
      }
      const boxId = definition ? originalBox(row, definition) : null;
      const matches = explicit.has(operation.operation_ref) || definition?.kind === current.kind && boxId === current.boxId;
      if (!matches) {
        diagnostics.push({ operationRef: operation.operation_ref, reasonCode: boxId === null
          ? 'ORDER_FLOWER_LEGACY_UNMAPPED_TARGET_NOT_FAMILY_HOLD' : 'ORDER_FLOWER_LEGACY_OTHER_TARGET_NOT_FAMILY_HOLD' });
        continue;
      }
      const proof = proofFor(operation);
      if (!proof) {
        append(operation, false, 'ORDER_FLOWER_LEGACY_EXACT_SOURCE_ISOLATION_REQUIRED', { isolationAvailable: false });
        return finish(false, 'ORDER_FLOWER_LEGACY_EXACT_SOURCE_ISOLATION_REQUIRED');
      }
      const oldCreation = definition && row ? preparedCreation(row, definition, boxId) : null;
      // If the old before is absent, record the first real current target as a
      // conservative boundary. Only a later genuine cTime can separate it;
      // source-device timestamps/fence recordedAt never impersonate server time.
      const prior = projection.bases.find(one => one.constraint_ref === operation.operation_ref && one.source_fingerprint === operation.source_fingerprint &&
        one.evidence?.version === VERSION && one.affected?.targetRef === target.targetRef &&
        positive(one.evidence.baselineTarget?.cTime) && one.evidence.baselineTarget.officialUid === current.officialUid &&
        one.evidence.baselineTarget.source?.method === 'index.login' && text(one.evidence.baselineTarget.source.responseRef));
      const baseline = oldCreation ?? prior?.evidence.baselineTarget.cTime ?? current.beforeOrder.cTime;
      const separated = current.beforeOrder.cTime > baseline;
      const baselineTarget = oldCreation ? { cTime: oldCreation, officialUid: current.officialUid, source: { method: 'original-prepared-before',
        responseRef: operation.source_fingerprint } } : prior?.evidence.baselineTarget ?? {
          cTime: current.beforeOrder.cTime, officialUid: current.officialUid, source: clone(current.source) };
      const reason = separated ? 'ORDER_FLOWER_LEGACY_LATER_CURRENT_SERVER_OCCURRENCE' : 'ORDER_FLOWER_LEGACY_SAME_TARGET_OCCURRENCE_UNPROVEN';
      if (!append(operation, separated, reason, { baselineTarget, oldPreparedCreationMs: oldCreation,
        currentTarget: { kind: current.kind, boxId: current.boxId, cTime: current.beforeOrder.cTime, lifecycleRef: current.lifecycleRef,
          contentFingerprint: current.contentFingerprint, source: clone(current.source) },
        isolationReceiptRef: proof.receiptRef, isolationReceiptHash: proof.receiptHash,
        previousExecution: clone(proof.previousExecution), resourceCoverageProven: false })) return finish(false, 'ORDER_FLOWER_LEGACY_CONTEXT_REVOKED');
      if (!separated) return finish(false, reason);
    }
    for (const constraint of projection.matchedResources) {
      const operation = operationFor(constraint.operation_ref);
      const proof = proofFor(operation), itemId = Number(constraint.raw_ref?.slice(5)), need = proposal.resources.find(one => one.resourceRef === constraint.raw_ref);
      if (!/^item:[1-9]\d*$/.test(constraint.raw_ref || '') || !positive(itemId) || !need) return finish(false, 'ORDER_FLOWER_LEGACY_RESOURCE_MAPPING_REQUIRED');
      const budget = sync(resources.budget({ context, itemId, quantity: need.quantity, keep: current.keepPolicy.keep,
        claimingOperationId: beforeSend ? proposal.operationId : null, requireOwnReservation: beforeSend }));
      const key = sync(legacyResourceKey(constraint, proof));
      const held = budget?.otherUnreflectedReservations?.find(one => one.resourceKey === key && one.operationId === 'legacy:' + constraint.source_origin_key);
      const allowed = !!proof && nonnegative(constraint.quantity) && budget?.known === true && budget.allowed === true && held &&
        held.quantity === constraint.quantity && nonnegative(held.unreflectedQuantity) && held.unreflectedQuantity <= held.quantity &&
        (held.unreflectedQuantity === held.quantity || text(held.currentSeparationRef) && budget.basisRefs?.includes(held.currentSeparationRef));
      const reason = allowed ? 'ORDER_FLOWER_LEGACY_RESOURCE_RETAINED_OR_CURRENT_SEPARATED_IN_SHARED_BUDGET' : 'ORDER_FLOWER_LEGACY_RESOURCE_BASIS_REQUIRED';
      if (!append(constraint, !!allowed, reason, { isolationReceiptRef: proof?.receiptRef ?? null, isolationReceiptHash: proof?.receiptHash ?? null,
        retainedResource: held ? clone(held) : null, budgetAccountingVersion: budget?.accountingVersion ?? null,
        resourceCoverageProven: false, resourceReleased: false })) return finish(false, 'ORDER_FLOWER_LEGACY_CONTEXT_REVOKED');
      if (!allowed) return finish(false, reason);
    }
    return sync(isCurrent(context)) === true ? finish(true, null) : finish(false, 'ORDER_FLOWER_LEGACY_CONTEXT_REVOKED');
  }
  return Object.freeze({ evaluate });
}
