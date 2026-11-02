import { encodeEvidenceJson, canonical, clone, fingerprint, freeze, newId, parseStored, problem } from '../../common.mjs';
import { storeLandSourcePolicy, LAND_POLICY_OBJECT_SCHEMA } from './source-policy-storage.mjs';
import { SPECIAL_ORDER_DEFINITIONS } from '../special-orders/rpc-contract.mjs';
import { isLandAccelerationMethod, isNormalSyncMethod } from '../../facts/normal-sync-contract.mjs';
import { createLandProjection } from './projection.mjs';
import { resolveAcceptedLandObservationEvidence } from './compatibility-evidence.mjs';
import { captureLandWriteWorkset } from './write-workset.mjs';
import { decodeOfficialLandObservation } from './wire-facts.mjs';
import { createLandLifecycles } from './lifecycles.mjs';
import { createKnownLandHistory } from './known-history.mjs';
import { createLandHistoryRetirement } from './history-retirement.mjs';
import { createOfficialItemResources } from '../../resources/official-items.mjs';
import { createLandGroups } from './groups.mjs';
import { createLandReadCoordinator } from './read-coordinator.mjs';
import { createLandAdmission } from './admission.mjs';
import { createLandVerification } from './verification.mjs';
import { createCurrentNeedReconciler } from '../../execution/current-need.mjs';
import { selectPlantCandidates } from './plant-selection.mjs';
import { planStockCapacity } from './stock-budget.mjs';
import { createPlantFeature } from './plant.mjs';
import { hashLedgerBytes, ledgerJsonFingerprint } from '../../persistence/json-contract.mjs';
import { verifyOfficialServerVersionFrame } from '../../official-server-version-contract.mjs';
import { createWaterFeature } from './water.mjs';
import { createHarvestFeature } from './harvest.mjs';
import { createLandAccelerationFeature } from './acceleration.mjs';
import { captureLandAccelerationArgs, assertLandAccelerationProposal } from './acceleration-contract.mjs';
import { createLandAccelerationVerification } from './acceleration-verification.mjs';
import { assertSingleProposal, captureLandArgs, configValue, field, LAND_METHODS, landEntries, landFieldStates, legacyItemReservationKey,
  contextKey, positiveId, proposalContext, safeSource, sameContext, valueOf } from './rpc-contract.mjs';

// Legacy operation closure and its resource constraint intentionally have
// different origin keys: one identifies part:null, the other a resource part.
// Their immutable parent operation reference is the binding between them.
export function legacyConstraintHasClosedSourceOperation(constraint, proof, context) {
  const operationBound = proof?.original?.kind === 'legacy' && proof.original.operationRef === constraint?.operation_ref;
  const constraintBound = proof?.original?.kind === 'legacy-constraint' && proof.original.constraintRef === constraint?.constraint_ref &&
    proof.original.sourceOperationId === constraint?.source_operation_id && proof.original.rawRef === constraint?.raw_ref &&
    proof.original.sourceOriginKey === constraint?.source_origin_key && proof.original.sourceFingerprint === constraint?.source_fingerprint;
  return proof?.available === true && (operationBound || constraintBound) &&
    proof.original?.sourceOperationId === constraint?.source_operation_id &&
    proof.original?.ownerRef === context?.ownerRef && proof.original?.subjectRef === context?.subjectRef &&
    proof.previousExecution?.closed === true && proof.previousExecution?.executionClosed === true &&
    typeof proof.previousExecution?.sourceFenceRef === 'string' && typeof proof.previousExecution?.evidenceRef === 'string' &&
    typeof proof.previousExecution?.sourceInstallId === 'string' && typeof proof.previousExecution?.sourceSignerFingerprint === 'string';
}

export function provenLandUnexpectedCosts(frame, featureId) {
  if (!frame || frame.source?.kind !== 'response' || !['plant', 'water', 'harvest', 'land.acceleration'].includes(featureId)) return [];
  return Object.entries(frame.bo?.items || {}).filter(([id, cell]) => cell?.state === 'known' &&
    Number.isSafeInteger(cell.value) && cell.value > 0 && !(featureId === 'water' && id === '7' && cell.value === 1) &&
    !(featureId === 'land.acceleration' && frame.source.method === 'usrLand.speedUp' && id === '1001' && cell.value === 1))
    .map(([id, cell]) => ({ itemId: Number(id), quantity: cell.value, evidence: 'known-positive-official-bo' }));
}

// The catalog owns the verified tables. Evidence carries their immutable hashes
// and source identity; copying multi-megabyte tables into each login proof made
// every later historical assessment parse and hash the same tables again.
export function landSnapshotVersionEvidence(versionEvidence, snapshot, protocolVersion, loginResponseRef) {
  const { tables: oldTables, ...previous } = versionEvidence;
  const { tables: snapshotTables, ...metadata } = snapshot;
  return { ...previous, ...metadata, source: versionEvidence.source,
    gameVersion: snapshot.sourceVersion, protocolVersion, loginResponseRef };
}

export function createLandRuntime({ store, catalog, catalogRegistry = null, facts, ledgerView, legacyConstraints, readCurrent, isCurrent: isExecutionCurrent,
  appendOutbox, isolationEvidence, capabilities = {}, additionalItemRule = null, accelerationExtensionForContext = () => null,
  waterwheelExtensionForContext = () => null, artFirstRewardExtensionForContext = () => null,
  validatePostReadBridge = null, dynamicState = null }) {
  const versionBindings = new Map(), catalogBindings = new Map(), versionStates = new Map();
  const independentWriteScopes = Object.freeze({
    ...Object.fromEntries(Object.values(SPECIAL_ORDER_DEFINITIONS).map(one => [one.method,
      { featureId: one.featureId, scope: one.scope, contractId: one.contractId }])),
    'freeWater.recv': Object.freeze({ featureId: 'free-water', scope: 'free-water-recv', contractId: 'free-water/official-actions/v1/receive' }),
    'flowerRack.unlockStand': Object.freeze({ featureId: 'flower-rack', scope: 'rack-unlock', contractId: 'flower-rack/official-actions/v1/unlock' }),
    'flowerRack.sell': Object.freeze({ featureId: 'flower-rack', scope: 'rack-sell', contractId: 'flower-rack/official-actions/v1/sell' }),
    'flowerRack.recvSellMoney': Object.freeze({ featureId: 'flower-rack', scope: 'rack-recv', contractId: 'flower-rack/official-actions/v1/receive' }),
    'flowerRack.cancelSell': Object.freeze({ featureId: 'flower-rack', scope: 'rack-cancel', contractId: 'flower-rack/official-actions/v1/cancel' }),
    'collectRwd.recvArtCreateRwdByVase': Object.freeze({ featureId: 'art.first-album', scope: 'vase-album-recv', contractId: 'art-first-album/by-vase/v1', domain: 'art-first-album' }),
  });
  const resolveCatalog = catalogRegistry?.resolve ?? ((gameVersion, protocolVersion) =>
    catalog?.identity?.().indexVersion === gameVersion && catalog?.identity?.().protocolVersion === protocolVersion ? catalog : null);
  function readIndependentOperationContract(operationId, expected) {
    if (!operationId || !expected) return null;
    const read = (evidenceKey, kind) => {
      const row = store.get(`SELECT kind,source,payload_json,payload_fingerprint,observed_at FROM backend_operation_evidence
        WHERE operation_id=? AND evidence_key=? AND kind=? AND source='backend/write-gateway/v2'`, operationId, evidenceKey, kind);
      const payload = row ? parseStored(row.payload_json, '独立功能不可变合同证据') : null;
      if (!row || ledgerJsonFingerprint({ kind: row.kind, source: row.source, payload, observedAt: row.observed_at }) !== row.payload_fingerprint) return null;
      return payload;
    };
    const admitted = read('admitted-operation-contract:v1', 'admitted-operation-contract');
    const prepared = read('finite-domain-preparation:v1', 'finite-domain-preparation');
    if (!admitted || !prepared || admitted.contractId !== expected.contractId || admitted.featureId !== expected.featureId ||
        admitted.scope !== expected.scope || admitted.method !== expected.method || prepared.domain !== (expected.domain || expected.scope) || !prepared.preparation ||
        !['free-water-recv', 'free-water-fallback', 'rack-unlock', 'rack-sell', 'rack-recv', 'rack-cancel', 'art-first-album', 'art-first-share',
          ...Object.values(SPECIAL_ORDER_DEFINITIONS).map(one => one.scope)].includes(prepared.domain)) return null;
    return prepared.preparation;
  }
  const catalogForContext = context => {
    const binding = versionBindings.get(contextKey(context));
    return binding ? catalogBindings.get(contextKey(context)) || catalogRegistry?.resolveSnapshot?.(binding.versionEvidence) ||
      resolveCatalog(binding.gameVersion, binding.protocolVersion) : null;
  };
  const catalogForVersionEvidence = versionEvidence => catalogRegistry?.resolveSnapshot?.(versionEvidence) || null;
  const isCurrent = context => isExecutionCurrent(context) === true && versionStates.get(contextKey(context))?.supported === true;
  for (const [name, fn] of Object.entries({ clock: facts?.clock, operation: ledgerView?.operation,
    currentAdmission: ledgerView?.currentAdmission, recordAdmissionBasis: ledgerView?.recordAdmissionBasis, candidateProjection: legacyConstraints?.candidateProjection,
    legacyCurrentAdmission: legacyConstraints?.currentAdmission, appendBasis: legacyConstraints?.appendBasis,
    isolationEvidence: isolationEvidence?.read, readCurrent, isCurrent: isExecutionCurrent, appendOutbox })) if (typeof fn !== 'function') throw new TypeError('Land runtime missing finite port: ' + name);
  if (!store?.transaction || !catalog?.supports || !catalog?.identity || typeof catalog?.sourcePolicy !== 'function') throw new TypeError('Land runtime requires storage and an audited version-bound catalog');
  store.db.exec(LAND_POLICY_OBJECT_SCHEMA);
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_land_cost_contract_guards(
    owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,feature_id TEXT NOT NULL,receipt_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref,feature_id));
    CREATE TRIGGER IF NOT EXISTS backend_land_cost_guards_immutable BEFORE UPDATE ON backend_land_cost_contract_guards
      BEGIN SELECT RAISE(ABORT,'land cost evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_land_cost_guards_append_only BEFORE DELETE ON backend_land_cost_contract_guards
      BEGIN SELECT RAISE(ABORT,'land cost evidence is append only'); END;
    CREATE TABLE IF NOT EXISTS backend_land_cost_contract_guard_events(
      guard_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,feature_id TEXT NOT NULL,method TEXT NOT NULL,
      receipt_json TEXT NOT NULL,recorded_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS backend_land_cost_guard_events_lookup ON backend_land_cost_contract_guard_events(owner_ref,subject_ref,feature_id);
    CREATE TRIGGER IF NOT EXISTS backend_land_cost_guard_events_no_update BEFORE UPDATE ON backend_land_cost_contract_guard_events
      BEGIN SELECT RAISE(ABORT,'land cost guard events are append only'); END;
    CREATE TRIGGER IF NOT EXISTS backend_land_cost_guard_events_no_delete BEFORE DELETE ON backend_land_cost_contract_guard_events
      BEGIN SELECT RAISE(ABORT,'land cost guard events are append only'); END;
    CREATE TABLE IF NOT EXISTS backend_land_source_policy_bindings(binding_ref TEXT PRIMARY KEY,binding_json TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS backend_land_source_bindings_no_update BEFORE UPDATE ON backend_land_source_policy_bindings
      BEGIN SELECT RAISE(ABORT,'land source binding is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_land_source_bindings_no_delete BEFORE DELETE ON backend_land_source_policy_bindings
      BEGIN SELECT RAISE(ABORT,'land source binding is retained while receipts depend on it'); END;
    CREATE TABLE IF NOT EXISTS backend_land_source_policy_receipts(
      receipt_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,connection_epoch INTEGER NOT NULL,
      response_ref TEXT,receipt_json TEXT NOT NULL,recorded_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS backend_land_source_policy_response
      ON backend_land_source_policy_receipts(owner_ref,subject_ref,connection_epoch,response_ref,recorded_at,receipt_ref);
    CREATE TRIGGER IF NOT EXISTS backend_land_source_policy_no_update BEFORE UPDATE ON backend_land_source_policy_receipts
      BEGIN SELECT RAISE(ABORT,'land source policy evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_land_source_policy_no_delete BEFORE DELETE ON backend_land_source_policy_receipts
      BEGIN SELECT RAISE(ABORT,'land source policy evidence is append only'); END;`);
  const clock = subjectRef => facts.clock(subjectRef);
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_legacy_resource_budget_baseline_links(
    baseline_ref TEXT NOT NULL,constraint_ref TEXT NOT NULL,source_origin_key TEXT NOT NULL,raw_ref TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,resource_key TEXT NOT NULL,source_fence_ref TEXT NOT NULL,source_fence_fingerprint TEXT NOT NULL,
    evidence_json TEXT NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(baseline_ref,constraint_ref));
    CREATE INDEX IF NOT EXISTS backend_legacy_resource_baseline_lookup ON backend_legacy_resource_budget_baseline_links(constraint_ref,baseline_ref);
    CREATE TRIGGER IF NOT EXISTS backend_legacy_resource_baseline_links_no_update BEFORE UPDATE ON backend_legacy_resource_budget_baseline_links
      BEGIN SELECT RAISE(ABORT,'legacy resource baseline links are append only'); END;
    CREATE TRIGGER IF NOT EXISTS backend_legacy_resource_baseline_links_no_delete BEFORE DELETE ON backend_legacy_resource_budget_baseline_links
      BEGIN SELECT RAISE(ABORT,'legacy resource baseline links are append only'); END`);
  const projection = createLandProjection({ store, catalog, catalogForContext, isCurrent, appendOutbox });
  const lifecycles = createLandLifecycles({ store, projection });
  const lifecycleHistory = createLandHistoryRetirement({ store });
  function resourceAdmission({ context, itemIds = null }) {
    const admission = ledgerView.currentAdmission({ subjectRef: context.subjectRef, ownerRef: context.ownerRef, targetRefs: [] });
    const baseline = admission.resourceBaseline;
    const historicalInput = { ownerRef: context.ownerRef, subjectRef: context.subjectRef,
      resourceBaselineRef: baseline?.baselineRef ?? null };
    const historical = typeof legacyConstraints.resourceFootprints === 'function'
      ? { resourceFootprints: legacyConstraints.resourceFootprints({ ...historicalInput,
        resourceRefs: itemIds?.map(id => 'item:' + id) ?? null }) }
      : legacyConstraints.currentAdmission(historicalInput);
    const items = new Map();
    for (const constraint of historical.resourceFootprints) {
      if (!/^item:[1-9][0-9]*$/.test(constraint.raw_ref || '')) continue;
      // Resource rebasing must authenticate this exact archived constraint.
      // Parent references may be absent, dangling, or already resolved; none
      // of those states changes the source identity of the resource row.
      const proof = isolationEvidence.read({ context, legacyConstraintRef: constraint.constraint_ref });
      const key = legacyItemReservationKey(constraint, proof), previous = items.get(key);
      // The isolation proof is operation-scoped (part:null), while each
      // legacy resource constraint has its own part:{kind,rawRef} origin.
      // Bind the resource through the exact immutable operation_ref and
      // source operation id; the two origin keys are expected to differ.
      const priorBaselineLink = store.get(`SELECT baseline_ref,source_origin_key,raw_ref,source_fingerprint,resource_key,source_fence_ref,
        source_fence_fingerprint,evidence_json FROM backend_legacy_resource_budget_baseline_links
        WHERE constraint_ref=? AND source_origin_key=? AND raw_ref=? AND source_fingerprint=? ORDER BY recorded_at,baseline_ref LIMIT 1`,
      constraint.constraint_ref, constraint.source_origin_key, constraint.raw_ref, constraint.source_fingerprint);
      let priorBaselineLinkValid = false;
      if (priorBaselineLink) {
        const priorEvidence = parseStored(priorBaselineLink.evidence_json, '旧资源预算分离原证据');
        priorBaselineLinkValid = priorBaselineLink.resource_key === key && priorEvidence.version === 'legacy-resource-budget-baseline/closed-source-fence-current-complete-login-bag/v2' &&
          priorEvidence.constraintRef === constraint.constraint_ref && priorEvidence.constraintSourceOriginKey === constraint.source_origin_key &&
          priorEvidence.sourceFingerprint === constraint.source_fingerprint && priorEvidence.resourceKey === key &&
          priorEvidence.sourceFenceRef === priorBaselineLink.source_fence_ref &&
          priorEvidence.sourceFenceFingerprint === priorBaselineLink.source_fence_fingerprint;
      }
      if (!priorBaselineLink && baseline?.baselineRef && legacyConstraintHasClosedSourceOperation(constraint, proof, context)) {
        const evidence = { version: 'legacy-resource-budget-baseline/closed-source-fence-current-complete-login-bag/v2',
          baselineRef: baseline.baselineRef, constraintRef: constraint.constraint_ref,
          constraintSourceOriginKey: constraint.source_origin_key, operationSourceOriginKey: proof.original.sourceOriginKey ?? null,
          operationRef: proof.original.operationRef ?? null, sourceOperationId: proof.original.sourceOperationId,
          sourceFingerprint: constraint.source_fingerprint, resourceKey: key, rawRef: constraint.raw_ref,
          sourceFenceRef: proof.previousExecution.sourceFenceRef, sourceFenceEvidenceRef: proof.previousExecution.evidenceRef,
          sourceFenceFingerprint: proof.previousExecution.evidenceHash, sourceInstallId: proof.previousExecution.sourceInstallId,
          sourceSignerFingerprint: proof.previousExecution.sourceSignerFingerprint,
          proves: ['current-resource-budget-only', 'source-execution-closed', 'source-fence-committed'],
          explicitlyDoesNotProve: ['historical-charge', 'historical-success', 'uid-or-game-version-continuity', 'replay-authorization'] };
        const payload = JSON.stringify(evidence);
        const prior = store.get('SELECT source_fingerprint,resource_key,source_fence_ref,source_fence_fingerprint,evidence_json FROM backend_legacy_resource_budget_baseline_links WHERE baseline_ref=? AND constraint_ref=?',
          baseline.baselineRef, constraint.constraint_ref);
        if (prior && (prior.source_fingerprint !== constraint.source_fingerprint || prior.resource_key !== key ||
            prior.source_fence_ref !== proof.previousExecution.sourceFenceRef || prior.source_fence_fingerprint !== proof.previousExecution.evidenceHash ||
            prior.evidence_json !== payload)) throw Object.assign(new Error('legacy current resource link conflicts with immutable evidence'), { code: 'LEGACY_RESOURCE_BASELINE_CONFLICT' });
        if (!prior) store.run('INSERT INTO backend_legacy_resource_budget_baseline_links VALUES(?,?,?,?,?,?,?,?,?,?)', baseline.baselineRef,
          constraint.constraint_ref, constraint.source_origin_key, constraint.raw_ref, constraint.source_fingerprint, key,
          proof.previousExecution.sourceFenceRef, proof.previousExecution.evidenceHash, payload, store.nowIso());
      }
      const separated = priorBaselineLinkValid ? { resource_key: priorBaselineLink.resource_key } :
        baseline?.baselineRef ? store.get('SELECT resource_key FROM backend_legacy_resource_budget_baseline_links WHERE baseline_ref=? AND constraint_ref=?',
          baseline.baselineRef, constraint.constraint_ref) : null;
      if (separated?.resource_key === key) continue;
      // Repeated immutable transfer snapshots of the same original hold are
      // one footprint. Conflicting quantities remain unusable, never summed
      // or silently chosen. No live operation/hold is imported or released.
      items.set(key, { operation_id: 'legacy:' + constraint.source_origin_key, resource_key: key,
        resource_ref: constraint.raw_ref, resource_kind: 'item', state: 'historical_footprint',
        quantity: previous && previous.quantity !== constraint.quantity ? null : previous?.quantity === null ? null : constraint.quantity,
        footprintKind: 'legacy-archived-resource', sourceOriginKey: constraint.source_origin_key,
        sourceInstallId: proof?.available === true ? proof.previousExecution?.sourceInstallId ?? null : null,
        sourceSignerFingerprint: proof?.available === true ? proof.previousExecution?.sourceSignerFingerprint ?? null : null,
        transferIds: [...new Set([...(previous?.transferIds || []), constraint.transfer_id])].sort(),
        sourceFingerprints: [...new Set([...(previous?.sourceFingerprints || []), constraint.source_fingerprint])].sort(),
        constraintRefs: [...new Set([...(previous?.constraintRefs || []), constraint.constraint_ref])].sort() });
    }
    return { ...admission, resourceFootprints: [...admission.resourceFootprints, ...items.values()] };
  }
  const resources = createOfficialItemResources({ store, catalog, catalogForContext, catalogForVersionEvidence, projection, clock,
    readAdmission: resourceAdmission, appendOutbox, additionalItemRule, validatePostReadBridge });
  const groups = createLandGroups({ store, projection, lifecycles, ledgerView, appendOutbox, isolationEvidence, clock,
    isCurrent: isExecutionCurrent });
  const currentNeedReconciler = createCurrentNeedReconciler({ store, ledgerView, isolationEvidence });
  // Reading remains possible after a rejected/uninterpretable reply revoked
  // current domain facts. Only a new normally matched supported read can
  // restore them; no new session or business write is created here.
  const coordinator = createLandReadCoordinator({ readCurrent, isCurrent: isExecutionCurrent, projection });
  const verification = createLandVerification({ projection, lifecycles, isCurrent: isExecutionCurrent, readMethodGuard });
  const accelerationVerification = createLandAccelerationVerification({ projection, lifecycles, resources, clock,
    readMethodGuard, isCurrent: isExecutionCurrent });
  let closed = false;
  const contexts = new Map();
  const contextHeadKey = context => fingerprint([context.ownerRef, context.subjectRef]);
  const reusableLandView = (context, candidate) => candidate?.current === true && candidate.identity?.verified === true &&
    candidate.context && sameContext(context, candidate.context) && isExecutionCurrent(context) ? candidate : null;
  const readGroupView = (context, excludeOperationId = null, candidateView = null) => {
    const current = reusableLandView(context, candidateView) || projection.view(context), value = groups.view(context);
    return { groups: value.groups, flowerOccupancy: flowerId => new Set([
      ...landEntries(current).filter(land => land.current && land.status === 'occupied' && field(land, 'flowerId') === flowerId).map(land => land.landId),
      ...value.groups.flatMap(group => group.flowerId === flowerId && group.currentBinding?.state !== 'historical' ? group.members.filter(member =>
        member.currentBinding?.state !== 'historical' && !['finished', 'cancelled'].includes(member.state) &&
        member.operationId !== excludeOperationId).map(member => member.landId) : [])]).size };
  };
  const readPlantPool = (proposal, candidateView = null) => {
    const context = proposalContext(proposal), activeCatalog = catalogForContext(context), view = reusableLandView(context, candidateView) || projection.view(context);
    return activeCatalog ? selectPlantCandidates({ view, config: proposal.land.selectionConfig,
      catalog: activeCatalog, resources, groups: readGroupView(context, proposal.operationId, view), context }) :
      { known: false, reasonCode: 'LAND_SOURCE_VERSION_UNSUPPORTED', candidates: [], excluded: [], fingerprint: null };
  };
  function currentNeedSnapshot(proposal, candidateView = null) {
    const context = proposalContext(proposal), actionLandId = proposal.featureId === 'land.acceleration' ? proposal.acceleration?.targetLandId : proposal.params.landId,
      view = reusableLandView(context, candidateView) || projection.view(context), land = view.lands[String(actionLandId)],
      identitySource = view.identity?.source, targetSource = land?.source, sources = [targetSource],
      life = lifecycles.get({ subjectRef: context.subjectRef, landId: actionLandId });
    const actionLandFields = proposal.featureId === 'plant' ? ['state', 'flowerId', 'plantTime'] :
      proposal.featureId === 'water' ? ['state', 'flowerId', 'plantTime'] : proposal.featureId === 'land.acceleration' ?
        ['state', 'flowerId', 'plantTime', 'nextTime'] : ['state', 'flowerId', 'plantTime', 'harvestCnt', 'nextTime'];
    sources.push(...actionLandFields.map(name => land?.fields?.[name]?.source));
    let necessary = false;
    if (proposal.featureId === 'water') {
      const operation = ledgerView.operation(proposal.operationId), ownsReservation = operation?.write_slot === 1;
      const balance = resources.balance({ context, itemId: 7 }), budget = resources.budget({ context, itemId: 7, quantity: 1,
        keep: proposal.land.keepWater, claimingOperationId: ownsReservation ? proposal.operationId : null,
        requireOwnReservation: ownsReservation });
      const currentClock = clock(context.subjectRef), clockEvidence = currentClock?.evidence;
      sources.push(balance?.base?.source, view.inventory?.itemExt?.items?.['7']?.source, view.profile?.cTime?.source, clockEvidence);
      necessary = land?.current === true && field(land, 'state') === 1 && !!life?.cropRef && budget?.known === true && budget.allowed === true;
    } else if (proposal.featureId === 'plant') {
      const pool = readPlantPool(proposal, view), cultivation = view.cultivates[String(proposal.params.flowerId)];
      sources.push(cultivation?.source, view.inventory?.bag?.source, view.inventory?.itemExt?.source,
        view.profile?.gold?.source, view.profile?.yuanbao?.source);
      necessary = land?.current === true && land.status === 'empty' && pool.known === true &&
        pool.candidates.some(item => item.flowerId === proposal.params.flowerId);
    } else if (proposal.featureId === 'land.acceleration') {
      const mode = proposal.acceleration?.mode, currentClock = clock(context.subjectRef), balance = mode === 'card' ? resources.balance({ context, itemId: 1001 }) : null;
      sources.push(currentClock?.evidence, balance?.base?.source, view.inventory?.itemExt?.items?.['1001']?.source);
      necessary = land?.current === true && land.status === 'occupied' && field(land, 'state') === 2 &&
        lifecycles.get({ subjectRef: context.subjectRef, landId: proposal.acceleration.targetLandId })?.cropRef === proposal.acceleration.cropRef &&
        (mode === 'free' || mode === 'card' && balance?.effective?.known === true);
    } else {
      const currentClock = clock(context.subjectRef), maturity = lifecycles.ripeness({ land, clock: currentClock });
      sources.push(currentClock?.evidence);
      necessary = land?.current === true && maturity.known === true && maturity.mature === true && life?.cropRef === proposal.land.before.cropRef;
    }
    const sourceProofs = [...new Map(sources.filter(one => ['response', 'login', 'official-response', 'official-read'].includes(one?.kind) && one.connectionEpoch === context.connectionEpoch &&
      typeof one.responseRef === 'string' && Number.isSafeInteger(one.requestSequence) && one.requestSequence > 0 && typeof one.method === 'string')
      .map(one => [canonical({ method: one.method, responseRef: one.responseRef, requestSequence: one.requestSequence,
        connectionEpoch: one.connectionEpoch }), { method: one.method, responseRef: one.responseRef,
        requestSequence: one.requestSequence, connectionEpoch: one.connectionEpoch }])).values()];
    const login = identitySource?.kind === 'response' && identitySource.method === 'index.login' ? identitySource : null;
    if (login && login.connectionEpoch === context.connectionEpoch && Number.isSafeInteger(login.requestSequence) && login.requestSequence > 0 &&
        typeof login.responseRef === 'string') sourceProofs.push({ method: 'index.login', responseRef: login.responseRef,
      requestSequence: login.requestSequence, connectionEpoch: login.connectionEpoch });
    const sharedFeature = features.find(one => one.featureId === proposal.featureId);
      const shared = dynamicState?.currentNeedSnapshot?.({ context, feature: sharedFeature,
      config: { plantMode: proposal.land?.selectionConfig?.plantMode }, method: proposal.method, proposal });
    const sharedCurrent = !dynamicState || shared?.complete === true;
    const unique = shared?.complete === true ? shared.sourceProofs.filter(one => one.connectionEpoch === context.connectionEpoch)
      .map(one => ({ method: one.method, responseRef: one.responseRef, requestSequence: one.requestSequence,
        connectionEpoch: one.connectionEpoch })) : [...new Map(sourceProofs.map(one => [canonical(one), one])).values()];
    const version = versionBindings.get(contextKey(context));
    const valueProof = cell => cell?.presence === 'present' && cell.state === 'known' && cell.source?.kind === 'response' &&
      cell.source.connectionEpoch === context.connectionEpoch && Number.isSafeInteger(cell.source.requestSequence) &&
      typeof cell.source.responseRef === 'string' && unique.some(one => one.responseRef === cell.source.responseRef &&
        one.requestSequence === cell.source.requestSequence && one.connectionEpoch === cell.source.connectionEpoch);
    const sourceProof = source => ['response', 'login', 'official-response', 'official-read'].includes(source?.kind) && source.connectionEpoch === context.connectionEpoch &&
      Number.isSafeInteger(source.requestSequence) && typeof source.responseRef === 'string' && unique.some(one =>
        one.responseRef === source.responseRef && one.requestSequence === source.requestSequence && one.connectionEpoch === source.connectionEpoch);
    const fieldProof = cell => valueProof(cell) || ['missing', 'null'].includes(cell?.presence) && sourceProof(cell?.source);
    const waterExt = view.inventory?.itemExt?.items?.['7'];
    const waterExtCovered = fieldProof(waterExt?.fields?.limit) || !waterExt &&
      view.inventory?.itemExt?.complete === true && view.inventory?.itemExt?.state === 'known' && sourceProof(view.inventory.itemExt.source);
    const requiredValueCoverage = proposal.featureId === 'land.acceleration' ?
      actionLandFields.every(name => fieldProof(land?.fields?.[name])) && sourceProof(clock(context.subjectRef)?.evidence) &&
        (proposal.acceleration.mode !== 'card' || valueProof(view.inventory?.bag?.items?.['1001']) &&
          (!view.inventory?.itemExt?.items?.['1001'] || fieldProof(view.inventory.itemExt.items['1001']?.fields?.limit))) : proposal.featureId === 'water' ?
      actionLandFields.every(name => fieldProof(land?.fields?.[name])) && valueProof(view.inventory?.bag?.items?.['7']) && waterExtCovered && valueProof(view.profile?.cTime) &&
        sourceProof(clock(context.subjectRef)?.evidence) : proposal.featureId === 'plant' ?
        actionLandFields.every(name => fieldProof(land?.fields?.[name])) && valueProof(view.cultivates[String(proposal.params.flowerId)]?.fields?.lvl) && view.inventory?.bag?.complete === true &&
        view.inventory?.bag?.state === 'known' && !!view.inventory.bag.source && view.inventory?.itemExt?.complete === true &&
        view.inventory?.itemExt?.state === 'known' && !!view.inventory.itemExt.source :
        actionLandFields.every(name => fieldProof(land?.fields?.[name])) &&
          (sourceProof(clock(context.subjectRef)?.evidence) || ['missing', 'null'].includes(land?.fields?.nextTime?.presence));
    const uid = valueOf(view.identity?.uid);
    return { complete: necessary && requiredValueCoverage && sharedCurrent && sourceProof(targetSource) && view.current === true &&
        view.identity?.verified === true && positiveId(uid) && !!login && unique.length > 0,
      identityVerified: view.identity?.verified === true, method: 'index.login', responseRef: login?.responseRef ?? null,
      requestSequence: login?.requestSequence ?? null, connectionEpoch: context.connectionEpoch,
      officialUid: uid ?? null, gameVersion: version?.gameVersion ?? null, protocolVersion: version?.protocolVersion ?? null,
      sourceProofs: unique };
  }
  function attachCurrentNeed(proposal) {
    const context = proposalContext(proposal), targetRef = proposal.targets[0].targetRef,
      admission = ledgerView.currentAdmission({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
        targetRefs: proposal.targets.map(target => target.targetRef) });
    const previous = (admission?.unresolvedOperations || []).map(row => ledgerView.operation(row.operation_id)).filter(one => one &&
      one.business_verdict === 'unknown' && one.feature_id === proposal.featureId && one.method === proposal.method &&
      one.targets?.some(target => (target.target_ref ?? target.original?.targetRef) === targetRef));
    const snapshot = currentNeedSnapshot(proposal), basisRefs = [...new Set(snapshot.sourceProofs.map(one => one.responseRef))];
    const semanticFingerprint = fingerprint({ featureId: proposal.featureId, targetRef, lifecycleRef: proposal.targets[0].lifecycleRef,
      factBasis: proposal.factBasis, resources: proposal.resources.map(one => [one.resourceRef, one.quantity]).sort((a, b) => a[0].localeCompare(b[0])) });
    const businessNeedRef = 'land-need:' + fingerprint([proposal.featureId, targetRef, proposal.targets[0].lifecycleRef]);
    const currentNeed = { necessary: true, featureId: proposal.featureId, targetRef, businessNeedRef,
      needRef: 'current-need:' + fingerprint([proposal.featureId, targetRef, businessNeedRef]),
      decisionGeneration: fingerprint({ semanticFingerprint, sourceProofs: snapshot.sourceProofs }), semanticFingerprint, basisRefs };
    if (snapshot.complete !== true) return null;
    let reconciliation = null;
    if (previous.length) {
      for (const old of previous) {
        const proof = isolationEvidence.read({ context, operationId: old.operation_id });
        if (proof?.available !== true || proof.previousExecution?.closed !== true) return null;
        reconciliation = currentNeedReconciler.reconcile({ context, originalOperationId: old.operation_id,
          currentSnapshot: snapshot, currentNeed, operationId: proposal.operationId });
        if (reconciliation?.accepted !== true) return null;
      }
    } else {
      reconciliation = currentNeedReconciler.claimCurrent({ context, currentSnapshot: snapshot, currentNeed });
    }
    if (reconciliation?.accepted !== true) return null;
    currentNeed.claimRef = reconciliation.claimRef;
    proposal.semanticKey += ':current-need:' + currentNeed.decisionGeneration;
    proposal.land.currentNeed = currentNeed;
    return currentNeed;
  }
  const admission = createLandAdmission({ projection, lifecycles, groups, resources, ledgerView, legacyConstraints, catalogForContext, isCurrent, isolationEvidence,
    readPlantPool, currentNeedReconciler, currentNeedSnapshot });

  function readMethodGuard(context, featureId) {
    const rows = store.all('SELECT receipt_json FROM backend_land_cost_contract_guard_events WHERE owner_ref=? AND subject_ref=? AND feature_id=?',
      context.ownerRef, context.subjectRef, featureId);
    if (rows.some(row => parseStored(row.receipt_json, '土地费用合同证据').costs?.some(cost =>
      Number.isSafeInteger(cost.itemId) && cost.itemId > 0 && Number.isSafeInteger(cost.quantity) && cost.quantity > 0)))
      return { reasonCode: 'LAND_UNDECLARED_COST_OBSERVED' };
    const row = store.get('SELECT receipt_json FROM backend_land_cost_contract_guards WHERE owner_ref=? AND subject_ref=? AND feature_id=?',
      context.ownerRef, context.subjectRef, featureId);
    const legacy = row ? parseStored(row.receipt_json, '土地费用合同证据') : null;
    // Preserve old uncertainty receipts as audit while allowing a fresh
    // matched read to repair missing coverage. Only known positive quantities
    // in the legacy evidence remain an active cost-contract restriction.
    return legacy?.costs?.some(cost => cost.known === true && Number.isSafeInteger(cost.quantity) && cost.quantity > 0) ? legacy : null;
  }
  function recordUnexpectedCost(context, frame) {
    const featureId = Object.keys(LAND_METHODS).find(id => LAND_METHODS[id] === frame.source.method) ||
      (['usrLand.speedUp', 'usrLand.speedUpFree'].includes(frame.source.method) ? 'land.acceleration' : null);
    if (!featureId || frame.source.kind !== 'response' || readMethodGuard(context, featureId)) return false;
    // Missing or unreadable post-write flow coverage is an uncertainty, not
    // proof that the official cost contract charged an extra resource.
    const costs = provenLandUnexpectedCosts(frame, featureId);
    if (!costs.length) return false;
    const receipt = { reasonCode: 'LAND_UNDECLARED_COST_OBSERVED', featureId, costs, source: safeSource(frame.source),
      currentOperationOutcomeUnchanged: true };
    const guardRef = 'land-cost-guard:' + fingerprint({ ownerRef: context.ownerRef, subjectRef: context.subjectRef, featureId,
      method: frame.source.method, responseRef: frame.source.responseRef, costs });
    store.run('INSERT OR IGNORE INTO backend_land_cost_contract_guard_events VALUES(?,?,?,?,?,?,?)', guardRef, context.ownerRef,
      context.subjectRef, featureId, frame.source.method, encodeEvidenceJson(JSON.stringify(receipt)), store.nowIso());
    appendOutbox({ ownerRef: context.ownerRef, subjectRef: context.subjectRef, eventType: 'FactsChanged',
      eventKey: 'land-cost-guard:' + frame.observationRef, payload: { domain: 'land-domain', featureId,
        reasonCode: receipt.reasonCode, responseRef: frame.source.responseRef } });
    return true;
  }

  function ingest({ context, observation }) {
    if (closed || !isExecutionCurrent(context)) return { accepted: false, changed: false, reasonCode: 'LAND_OBSERVATION_CONTEXT_REVOKED' };
    context = proposalContext(context);
    if (observation?.connectionEpoch !== context.connectionEpoch) return { accepted: false, changed: false, reasonCode: 'LAND_OBSERVATION_CONNECTION_MISMATCH' };
    const key = contextKey(context), version = observation?.versionEvidence;
    const selectedCatalog = catalogForContext(context) ||
      catalogRegistry?.resolveSnapshot?.(version) ||
      resolveCatalog(version?.gameVersion, version?.protocolVersion);
    const accelerationMethod = isLandAccelerationMethod(observation?.method);
    const accelerationExtension = accelerationMethod ? accelerationExtensionForContext(context) : null;
    const wheelMethod = ['waterwheel.enter', 'waterwheel.recv', 'waterwheel.skip'].includes(observation?.method);
    const waterwheelExtension = wheelMethod ? waterwheelExtensionForContext(context) : null;
    const candidateOperation = observation?.operationId ? ledgerView?.operation?.(observation.operationId) : null;
    const candidateOriginal = candidateOperation?.original;
    const independentWrite = independentWriteScopes[observation?.method] ||
      (observation?.method === 'usr.share' && candidateOriginal?.featureId === 'art.first-share' && candidateOriginal?.scope === 'art-first-share'
        ? { featureId: 'art.first-share', scope: 'art-first-share', contractId: 'art-first-share/share6/v1', domain: 'art-first-share' } : null);
    const currentIndependentExtension = ['art.first-album', 'art.first-share'].includes(independentWrite?.featureId)
      ? artFirstRewardExtensionForContext(context) : null;
    const operation = independentWrite ? candidateOperation : null;
    const original = operation?.original;
    const selectedIdentity = selectedCatalog?.identity?.();
    const frozenPreparation = independentWrite && observation?.operationId
      ? readIndependentOperationContract(observation.operationId, { featureId: independentWrite.featureId, scope: independentWrite.scope,
        method: observation.method, contractId: independentWrite.contractId, domain: independentWrite.domain }) : null;
    const frozenExtension = frozenPreparation?.extension;
    const frozenExtensionBody = frozenExtension && Object.fromEntries(Object.entries(frozenExtension).filter(([name]) => name !== 'extensionRef'));
    const independentExtensionCurrent = !!frozenExtension && !!frozenExtensionBody &&
      frozenExtension.extensionRef === 'sha256:' + fingerprint(frozenExtensionBody) &&
      frozenExtension.bundleRef === selectedIdentity?.bundleRef && frozenExtension.sourceVersion === selectedIdentity?.indexVersion &&
      frozenExtension.resourceSha256 === selectedIdentity?.resourceSha256 && frozenExtension.baseDataSnapshotId === selectedIdentity?.dataSnapshotId &&
      frozenExtension.loginResponseRef === selectedIdentity?.loginResponseRef &&
      (!['art.first-album', 'art.first-share'].includes(independentWrite?.featureId) ||
        currentIndependentExtension?.extensionRef === frozenExtension.extensionRef);
    const independentWriteCurrent = !!independentWrite && !!operation && operation.feature_id === independentWrite.featureId &&
      operation.operation_id === observation.operationId && operation.owner_ref === context.ownerRef &&
      operation.account_ref === String(context.accountRef) && operation.subject_ref === context.subjectRef &&
      hashLedgerBytes(operation.original_json) === operation.original_fingerprint && original?.ownerEpoch === context.ownerEpoch && operation.run_epoch === context.runEpoch &&
      operation.connection_epoch === context.connectionEpoch && original?.method === observation.method &&
      original?.featureId === independentWrite.featureId && original?.scope === independentWrite.scope &&
      original?.operationId === observation.operationId && independentExtensionCurrent;
    const accelerationSourceCurrent = !!accelerationExtension && version?.gameVersion === accelerationExtension.sourceVersion &&
      version?.loginResponseRef === accelerationExtension.loginResponseRef && selectedIdentity?.loginResponseRef === accelerationExtension.loginResponseRef &&
      selectedIdentity?.dataSnapshotId === accelerationExtension.baseDataSnapshotId && selectedIdentity?.resourceSha256 === accelerationExtension.resourceSha256 &&
      selectedIdentity?.bundleRef === accelerationExtension.bundleRef;
    const waterwheelSourceCurrent = !!waterwheelExtension && version?.gameVersion === waterwheelExtension.sourceVersion &&
      version?.loginResponseRef === waterwheelExtension.loginResponseRef && selectedIdentity?.loginResponseRef === waterwheelExtension.loginResponseRef &&
      selectedIdentity?.dataSnapshotId === waterwheelExtension.baseDataSnapshotId && selectedIdentity?.resourceSha256 === waterwheelExtension.resourceSha256 &&
      selectedIdentity?.bundleRef === waterwheelExtension.bundleRef;
    const independentSourceCurrent = independentWriteCurrent && independentExtensionCurrent && observation?.source === 'response' &&
      observation?.transport === 'answered' && observation?.envelopeOk === true && observation?.dsName === 'G.ISyncData' &&
      observation?.rejected !== true && version?.gameVersion === selectedIdentity?.indexVersion &&
      version?.protocolVersion === selectedIdentity?.protocolVersion &&
      verifyOfficialServerVersionFrame({ versionEvidence: version, frameProtocolVersion: observation?.protocolVersion,
        frameReportedServerVersion: observation?.reportedServerVersion ?? observation?.protocolVersion,
        context: version?.profileBinding, officialUid: frozenPreparation?.officialUid ?? frozenPreparation?.uid }) &&
      version?.loginResponseRef === selectedIdentity?.loginResponseRef && selectedIdentity?.dataSnapshotId === frozenExtension?.baseDataSnapshotId &&
      selectedIdentity?.resourceSha256 === frozenExtension?.resourceSha256 && selectedIdentity?.bundleRef === frozenExtension?.bundleRef;
    let policy = accelerationSourceCurrent || waterwheelSourceCurrent || independentSourceCurrent ? { supported: true, reasonCode: null,
      coverage: { landMapComplete: false, bagComplete: false, itemExtComplete: false,
        evidenceRef: accelerationSourceCurrent ? accelerationExtension.extensionRef : waterwheelSourceCurrent ? waterwheelExtension.extensionRef :
          'admitted-operation-contract:' + operation.operation_id + ':' + independentWrite.scope } } :
      selectedCatalog?.sourcePolicy({ gameVersion: version?.gameVersion, protocolVersion: version?.protocolVersion, observation }) ??
      { supported: false, reasonCode: 'LAND_SOURCE_VERSION_UNSUPPORTED', coverage: {} };
    if (!policy || typeof policy.then === 'function') throw problem('LAND_SOURCE_POLICY_MUST_BE_SYNC', '官服土地版本核验必须同步完成', 500);
    const applicable = observation?.source === 'response' && (isNormalSyncMethod(observation.method) || accelerationSourceCurrent ||
      waterwheelSourceCurrent || independentWriteCurrent);
    const previousBinding = versionBindings.get(key), previousState = versionStates.get(key);
    let binding = previousBinding;
    if (applicable && policy.supported === true && previousState?.requiresNewLogin === true) policy = {
      ...policy, supported: false, reasonCode: previousState.reasonCode,
      coverage: { landMapComplete: false, bagComplete: false, itemExtComplete: false, evidenceRef: null } };
    if (applicable && policy.supported === true) {
      // A freshly fetched catalog is bound to this connection's original
      // matched login response. That source observation may predate the fetch
      // and therefore carry no dataSnapshotId; reuse the ID only when its
      // login proof still equals this connection's immutable binding.
      // The matched login proves account/session identity; it is not the
      // authority for which public-data snapshot this live connection has
      // since activated. Prefer a snapshot explicitly bound to this same
      // login response (including when the login's older static binding had a
      // different ID). Never let a replay from another login replace it.
      const currentDataSnapshotId = previousBinding && version?.loginResponseRef === previousBinding.loginResponseRef
        ? previousBinding.dataSnapshotId
        : version?.profileBinding?.dataSnapshotId ?? version?.dataSnapshotId ?? null;
      const sameVersions = previousBinding && version.protocolVersion === previousBinding.protocolVersion &&
        (currentDataSnapshotId === previousBinding.dataSnapshotId || (!currentDataSnapshotId && !previousBinding.dataSnapshotId));
      const login = observation.method === 'index.login';
      const valid = login ? version.loginResponseRef === observation.responseRef &&
        (!previousBinding || sameVersions && version.loginResponseRef === previousBinding.loginResponseRef) :
        sameVersions && version.loginResponseRef === previousBinding.loginResponseRef;
      if (!valid) policy = { ...policy, supported: false, reasonCode: 'LAND_SOURCE_CURRENT_LOGIN_BINDING_UNPROVEN',
        coverage: { landMapComplete: false, bagComplete: false, itemExtComplete: false, evidenceRef: null } };
      else if (login && !previousBinding) binding = { gameVersion: version.gameVersion,
        protocolVersion: version.protocolVersion, dataSnapshotId: currentDataSnapshotId,
        loginResponseRef: observation.responseRef, versionEvidence: version };
    }
    const requiresNewLogin = applicable && (previousState?.requiresNewLogin === true || [
      'LAND_SOURCE_FRAME_VERSION_CONFLICT', 'LAND_SOURCE_VERSION_BINDING_MISSING',
      'LAND_SOURCE_CURRENT_LOGIN_BINDING_UNPROVEN'].includes(policy.reasonCode));
    const safePolicy = { supported: applicable && policy.supported === true, reasonCode: policy.reasonCode ?? null, requiresNewLogin,
      catalogId: policy.catalogId ?? null, manifestSha256: policy.manifestSha256 ?? null,
      versionEvidenceRefs: Array.isArray(policy.versionEvidenceRefs) ? policy.versionEvidenceRefs.filter(value => typeof value === 'string').map(value => value.slice(0, 512)) : [],
      coverage: { landMapComplete: false, bagComplete: applicable && policy.supported === true && policy.coverage?.bagComplete === true,
        itemExtComplete: applicable && policy.supported === true && policy.coverage?.itemExtComplete === true,
        evidenceRef: typeof policy.coverage?.evidenceRef === 'string' ? policy.coverage.evidenceRef.slice(0, 512) : null } };
    const decoded = decodeOfficialLandObservation({ context, observation, capabilities: { ...capabilities, ...safePolicy.coverage } });
    if (!applicable && !decoded) return { accepted: false, changed: false, reasonCode: 'LAND_OBSERVATION_NOT_APPLICABLE' };
    const frame = decoded && (!applicable || !safePolicy.supported) ? freeze({ ...decoded, admissible: false,
      reasonCode: applicable ? safePolicy.reasonCode || 'LAND_SOURCE_VERSION_UNSUPPORTED' : 'LAND_OBSERVATION_NOT_APPLICABLE' }) : decoded;
    const stateChanged = applicable && Boolean(previousState?.supported) !== safePolicy.supported;
    const receipt = { version: 'land-source-policy/v1', context, source: safeSource(observation), applicable,
      supplied: Object.fromEntries(['gameVersion', 'protocolVersion', 'loginResponseRef'].map(name => [name,
        typeof version?.[name] === 'string' ? version[name].slice(0, name === 'loginResponseRef' ? 512 : 128) : null])),
      policy: safePolicy, binding: binding ?? null };
    // Compatibility promotion consumes policy evidence only for the matched
    // index.login (see buildLandCompatibilityRevalidation). Normal reads and
    // writes already retain their own immutable observation/effect evidence;
    // persisting another policy+binding copy for them has no recovery reader.
    const receiptRef = observation.method === 'index.login' ? 'land-source-policy:' + fingerprint(receipt) : null;
    try { return store.transaction(() => {
      if (!isExecutionCurrent(context)) throw problem('LAND_OBSERVATION_CONTEXT_REVOKED', '旧连接不更新土地事实');
      if (receiptRef) store.run('INSERT OR IGNORE INTO backend_land_source_policy_receipts VALUES(?,?,?,?,?,?,?)', receiptRef, context.ownerRef,
        context.subjectRef, context.connectionEpoch, observation?.responseRef ?? null, storeLandSourcePolicy(store, receipt), store.nowIso());
      if (applicable) {
        if (binding) versionBindings.set(key, freeze(binding));
        versionStates.set(key, freeze({ ...safePolicy, receiptRef }));
        contexts.set(contextHeadKey(context), Object.freeze({ ...context }));
      }
      if (!frame) return { accepted: false, changed: stateChanged, reasonCode: safePolicy.reasonCode || 'LAND_OBSERVATION_NOT_APPLICABLE', sourcePolicy: safePolicy };
      const result = projection.ingest(frame, { sourcePolicyRef: receiptRef });
      if (result?.coverageReplay === true) return { ...result, accepted: false, changed: false, sourcePolicy: safePolicy };
      resources.ingest(frame);
      const guardChanged = result?.accepted === true && recordUnexpectedCost(context, frame);
      if (result?.accepted === true) lifecycles.reconcile({ context, changedLandIds: result.observedLandIds ?? [] });
      return { ...result, accepted: result?.accepted === true, changed: result?.changed === true || guardChanged || stateChanged,
        sourcePolicy: safePolicy };
    }); } catch (error) {
      if (previousBinding) versionBindings.set(key, previousBinding); else versionBindings.delete(key);
      if (previousState) versionStates.set(key, previousState); else versionStates.delete(key);
      throw error;
    }
  }
  function wait(reasonCode, officialClock = null, dueMs = null) {
    const now = Date.now(), extra = Number.isFinite(officialClock?.uncertaintyMs) && officialClock.uncertaintyMs >= 0 ? Math.ceil(officialClock.uncertaintyMs) : 0;
    const officialDueMs = officialClock?.available && Number.isSafeInteger(dueMs) && dueMs + extra + 1 > officialClock.nowMs
      ? dueMs + extra + 1 : null;
    return { state: officialDueMs === null ? 'waiting-facts' : 'waiting-until', reasonCode,
      deviceDueMs: now + 30000, officialDueMs };
  }
  async function prepareAssessment(input, featureId) {
    if (closed || !isExecutionCurrent(input.context)) return { result: { state: 'blocked', reasonCode: 'LAND_CONTEXT_REVOKED' } };
    const guard = readMethodGuard(input.context, featureId);
    if (guard) return { result: { state: 'blocked', reasonCode: guard.reasonCode } };
    await coordinator.refresh({ context: input.context, reason: 'assessment:' + featureId });
    if (!isExecutionCurrent(input.context)) return { result: { state: 'blocked', reasonCode: 'LAND_CONTEXT_REVOKED' } };
    const view = projection.view(input.context);
    if (!view.current || view.identity?.verified !== true) return { result: wait(versionStates.get(contextKey(input.context))?.reasonCode || 'LAND_CURRENT_IDENTITY_REQUIRED') };
    const activeCatalog = catalogForContext(input.context);
    if (!activeCatalog) return { result: wait('LAND_SOURCE_VERSION_UNSUPPORTED') };
    groups.reconcile({ context: input.context, configReceipt: input.config, currentView: view });
    return { view, groupView: readGroupView(input.context, null, view), catalog: activeCatalog };
  }
  function estimateYield({ context, view, groupView, flowerId, excludeOperationId = null }) {
    const activeCatalog = catalogForContext(context);
    const cultivation = view.cultivates[String(flowerId)], level = field(cultivation, 'lvl');
    const row = Number.isSafeInteger(level) && level > 0 ? activeCatalog?.flowerLevel(flowerId, level) : null;
    const params = row?.known ? row.value : null;
    const support = activeCatalog?.supports({ purpose: 'yield', flowerId, fields: ['cropGets', 'frequencys'] });
    const perPlot = support?.supported && Number.isFinite(params?.cropGets) && params.cropGets > 0 &&
      Number.isSafeInteger(params?.frequencys) && params.frequencys > 0 ? params.cropGets * params.frequencys : null;
    let expected = 0, reserved = 0, expectedKnown = true, reservedKnown = true;
    const seen = new Set();
    for (const land of landEntries(view)) {
      if (land.status !== 'occupied' || field(land, 'flowerId') !== flowerId) continue;
      seen.add(land.landId);
      const landLevel = field(land, 'lvl'), count = field(land, 'harvestCnt'), skills = field(land, 'skills');
      const stolen = field(land, 'stealUids'), elvesStolen = field(land, 'elvesStealUids');
      const levelData = Number.isSafeInteger(landLevel) && landLevel > 0 ? activeCatalog?.flowerLevel(flowerId, landLevel) : null;
      const rule = levelData?.known ? levelData.value : null;
      if (!land.current || !Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(rule?.frequencys) ||
          !Number.isFinite(rule?.cropGets) || !Array.isArray(skills) || skills.length || !Array.isArray(stolen) || stolen.length ||
          !Array.isArray(elvesStolen) || elvesStolen.length || support?.supported !== true) { expectedKnown = false; continue; }
      expected += Math.max(0, rule.frequencys - count) * rule.cropGets;
    }
    for (const group of groupView.groups) if (group.flowerId === flowerId && group.currentBinding?.state !== 'historical') for (const member of group.members) {
      if (member.currentBinding?.state === 'historical') continue;
      if (member.operationId === excludeOperationId || ['finished', 'cancelled'].includes(member.state) || seen.has(member.landId)) continue;
      if (!Number.isFinite(member.predictedYield) || member.predictedYield < 0) reservedKnown = false;
      else reserved += member.predictedYield;
    }
    return { perPlot, expected: { known: expectedKnown, value: expected, perPlot }, reserved: { known: reservedKnown, value: reserved, perPlot } };
  }
  function buildProposal({ input, featureId, ids = null, land, stage, groupRef, groupMemberKey, roundRef = null,
    flowerId = null, selectionConfig = null, poolFingerprint = null }) {
    if (!isCurrent(input.context) || !stage?.known || !land?.current) throw problem('LAND_PROPOSAL_CONTEXT_INVALID', '不能从旧地况创建提案');
    ids ||= { operationId: newId(), proposalId: newId() };
    const params = featureId === 'plant' ? { landId: land.landId, flowerId } : { landId: land.landId };
    const captured = captureLandArgs({ method: LAND_METHODS[featureId], input: params });
    const config = configValue(input.config), life = lifecycles.get({ subjectRef: input.context.subjectRef, landId: land.landId });
    const memberKey = featureId + ':' + fingerprint([land.landId, stage.lifecycleRef, featureId === 'plant' ? flowerId : null]);
    const target = { memberKey, targetKind: 'land', targetRef: `land:${input.context.subjectRef}:${land.landId}`, lifecycleRef: stage.lifecycleRef,
      targetFingerprint: fingerprint({ landId: land.landId, lifecycleRef: stage.lifecycleRef, flowerId: featureId === 'plant' ? flowerId : life?.flowerId ?? null }) };
    const technical = { resourceKey: 'land:' + fingerprint([land.landId, stage.lifecycleRef]), resourceKind: 'land',
      resourceRef: target.targetRef, quantity: 1, basisRef: fingerprint([land.semanticVersion, stage.lifecycleRef]), accountingRef: stage.lifecycleRef };
    const reservation = [technical];
    if (featureId === 'water') reservation.push(resources.reservationSpec({ context: input.context, itemId: 7,
      quantity: 1, memberKey, lifecycleRef: stage.lifecycleRef }));
    const proposal = { ...input.context, ...ids, featureId, scope: featureId, method: captured.method, params: captured.params,
      paramsFingerprint: captured.paramsFingerprint, configRevision: input.config.savedRevision,
      featureCancelEpoch: input.config.featureCancelEpochs[featureId],
      semanticKey: featureId + ':' + fingerprint([input.context.subjectRef, land.landId, stage.lifecycleRef, featureId === 'plant' ? flowerId : null]),
      targets: [target], resources: reservation,
      resourceBindings: reservation.map(resource => ({ resourceKey: resource.resourceKey, memberKey, quantity: resource.quantity })),
      land: { groupRef, groupMemberKey, roundRef, selectionConfig: featureId === 'plant' ? clone(selectionConfig) : null,
        readPoolBasis: poolFingerprint, keepWater: featureId === 'water' ? config.keepWater : null,
        before: { landId: land.landId, status: land.status, semanticVersion: land.semanticVersion, cropRef: life?.cropRef ?? null,
          emptyRef: life?.emptyRef ?? null, flowerId: field(land, 'flowerId') ?? null, state: field(land, 'state') ?? null,
          harvestCnt: field(land, 'harvestCnt') ?? null, plantTime: field(land, 'plantTime') ?? null,
          fieldStates: landFieldStates(land), source: safeSource(land.source) } } };
    proposal.factBasis = admission.readFactBasis({ proposal, actor: input.context });
    if (!attachCurrentNeed(proposal)) throw problem('LAND_CURRENT_NEED_NOT_CURRENT', '当前土地需求未绑定到已接收的事实来源');
    const proofView = projection.view(input.context), loginRef = proofView.identity?.source?.observationRef;
    const acceptedLogin = typeof loginRef === 'string' ? resolveAcceptedLandObservationEvidence({ store,
      context: input.context, observationRef: loginRef }) : null;
    const proofGroup = readGroupView(input.context, proposal.operationId, proofView).groups.find(one=>one.groupRef===groupRef);
    proposal.land.proofWorkset = captureLandWriteWorkset({ context:proposalContext(proposal), proposal, acceptedLogin,
      group:proofGroup, selection:featureId==='plant'?readPlantPool(proposal,proofView):null });
    return freeze(proposal);
  }
  function buildAccelerationProposal({ input, mode, land, stage, extension, reservation = null, trustedClock, due }) {
    const context = proposalContext(input.context), life = lifecycles.get({ subjectRef: context.subjectRef, landId: land.landId });
    if (!isCurrent(context) || !land?.current || !stage?.known || !life?.cropRef || !extension ||
        life.flowerId !== field(land, 'flowerId') || life.plantTime !== field(land, 'plantTime'))
      throw problem('LAND_ACCELERATION_CONTEXT_INVALID', '加速候选不属于当前可识别作物');
    const ids = { operationId: newId(), proposalId: newId() };
    const params = mode === 'card' ? { landId: land.landId } : {};
    const captured = captureLandAccelerationArgs({ mode, params, targetLandId: land.landId });
    const memberKey = `land.acceleration:${fingerprint([land.landId, stage.lifecycleRef, mode])}`;
    const target = { memberKey, targetKind: 'land', targetRef: `land:${context.subjectRef}:${land.landId}`,
      lifecycleRef: stage.lifecycleRef, targetFingerprint: fingerprint({ landId: land.landId, lifecycleRef: stage.lifecycleRef, cropRef: life.cropRef,
        flowerId: life.flowerId, plantTime: life.plantTime, mode }) };
    const resourcesForAction = [{ resourceKey: 'land:' + fingerprint([land.landId, stage.lifecycleRef]), resourceKind: 'land',
      resourceRef: target.targetRef, quantity: 1, basisRef: fingerprint([land.semanticVersion, stage.lifecycleRef]), accountingRef: stage.lifecycleRef }];
    if (mode === 'card') resourcesForAction.push(reservation);
    const config = configValue(input.config), balance = mode === 'card' ? resources.balance({ context, itemId: 1001 }) : null;
    const before = { landId: land.landId, status: land.status, semanticVersion: land.semanticVersion, cropRef: life.cropRef,
      flowerId: field(land, 'flowerId') ?? null, state: field(land, 'state') ?? null, plantTime: field(land, 'plantTime') ?? null,
      nextTime: field(land, 'nextTime') ?? null, source: safeSource(land.source) };
    const proposal = { ...context, ...ids, featureId: 'land.acceleration', scope: captured.scope, method: captured.method, params: captured.params,
      paramsFingerprint: captured.paramsFingerprint, configRevision: input.config.savedRevision,
      featureCancelEpoch: input.config.featureCancelEpochs['land.acceleration'],
      semanticKey: 'land.acceleration:' + fingerprint([context.subjectRef, land.landId, stage.lifecycleRef, mode]),
      targets: [target], resources: resourcesForAction,
      resourceBindings: resourcesForAction.map(resource => ({ resourceKey: resource.resourceKey, memberKey, quantity: resource.quantity })),
      land: { before }, acceleration: { mode, contractId: captured.contractId, targetLandId: land.landId, cropRef: life.cropRef,
        flowerId: life.flowerId, plantTime: life.plantTime, originalNextTime: due, extension, extensionRef: extension.extensionRef,
        baseDataSnapshotId: extension.baseDataSnapshotId, bundleRef: extension.bundleRef, loginResponseRef: extension.loginResponseRef,
        connectionEpoch: context.connectionEpoch, trustedClock, cardBalanceBefore: balance?.base?.known ? balance.base.value : null } };
    assertLandAccelerationProposal(proposal);
    proposal.factBasis = accelerationFactBasis(proposal);
    if (!attachCurrentNeed(proposal)) throw problem('LAND_ACCELERATION_CURRENT_NEED_NOT_CURRENT', '加速需求未绑定当前共同事实');
    return freeze(proposal);
  }
  function qualifyAcceleration({ proposal, config, boundary = 'before-prepare', ownReservation = null }) {
    try { assertLandAccelerationProposal(proposal); } catch (error) { return { allowed: false, targetsCurrent: false, resourcesCurrent: false, reasonCode: error.code }; }
    const context = proposalContext(proposal), view = projection.view(context), land = view.lands[String(proposal.acceleration.targetLandId)],
      mode = proposal.acceleration.mode, extension = accelerationExtensionForContext(context), life = lifecycles.get({ subjectRef: context.subjectRef, landId: proposal.acceleration.targetLandId });
    const deny = reasonCode => ({ allowed: false, targetsCurrent: false, resourcesCurrent: false, reasonCode });
    if (closed || !isCurrent(context) || !view.current || view.identity?.verified !== true || !land?.current || !extension ||
        extension.extensionRef !== proposal.acceleration.extensionRef || extension.bundleRef !== proposal.acceleration.bundleRef ||
        extension.loginResponseRef !== proposal.acceleration.loginResponseRef || extension.baseDataSnapshotId !== proposal.acceleration.baseDataSnapshotId ||
        !life || life.cropRef !== proposal.acceleration.cropRef || life.flowerId !== proposal.acceleration.flowerId ||
        life.plantTime !== proposal.acceleration.plantTime || land.status !== 'occupied' || field(land, 'state') !== 2 ||
        field(land, 'flowerId') !== proposal.acceleration.flowerId || field(land, 'plantTime') !== proposal.acceleration.plantTime ||
        field(land, 'nextTime') !== proposal.acceleration.originalNextTime) return deny('LAND_ACCELERATION_TARGET_OR_EXTENSION_CHANGED');
    const now = clock(context.subjectRef), lower = now?.nowMs - now?.uncertaintyMs, upper = now?.nowMs + now?.uncertaintyMs;
    if (now?.available !== true || now.connectionEpoch !== context.connectionEpoch || !Number.isFinite(lower) ||
        !Number.isSafeInteger(proposal.acceleration.originalNextTime) || proposal.acceleration.originalNextTime <= upper) return deny('LAND_ACCELERATION_CLOCK_OR_DUE_CHANGED');
    if (mode === 'free' && proposal.acceleration.originalNextTime - lower > extension.thresholdSeconds * 1000 ||
        mode === 'card' && proposal.acceleration.originalNextTime - lower <= 20 * 60 * 1000) return deny('LAND_ACCELERATION_MODE_WINDOW_CHANGED');
    let resourceCurrent = true;
    if (mode === 'card') {
      const budget = resources.budget({ context, itemId: 1001, keep: configValue(config).speedCardKeep, quantity: 1,
        claimingOperationId: boundary === 'before-send' ? proposal.operationId : null, requireOwnReservation: boundary === 'before-send' });
      resourceCurrent = budget.known === true && budget.allowed === true;
      if (boundary === 'before-send' && ownReservation?.operationId !== proposal.operationId) resourceCurrent = false;
    }
    return resourceCurrent ? { allowed: true, targetsCurrent: true, resourcesCurrent: true, reasonCode: null }
      : deny('LAND_ACCELERATION_CARD_BUDGET_CHANGED');
  }
  function evaluateAccelerationAdmission({ proposal, actor, boundary, ownReservation }) {
    const context = proposalContext(proposal), current = ledgerView.currentAdmission({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
      targetRefs: proposal.targets.map(target => target.targetRef) });
    const active = current.activeOperation;
    if (!sameContext(context, actor) || !isCurrent(context) || active && active.operation_id !== (boundary === 'before-send' ? proposal.operationId : null))
      return { allowed: false, historicalConstraintsChecked: true, currentInFlightChecked: true, reasonCode: 'LAND_ACCELERATION_ACTIVE_OPERATION' };
    if ((current.unresolvedOperations || []).some(row => row.operation_id !== proposal.operationId && row.targets?.some(target =>
        (target.target_ref ?? target.original?.targetRef) === proposal.targets[0].targetRef)))
      return { allowed: false, historicalConstraintsChecked: true, currentInFlightChecked: true, reasonCode: 'LAND_ACCELERATION_TARGET_HAS_UNRESOLVED_OPERATION' };
    const need = proposal.land?.currentNeed;
    if (!need || !currentNeedReconciler?.isClaimCurrent({ claimRef: need.claimRef, context,
      currentSnapshot: currentNeedSnapshot(proposal), currentNeed: need, operationId: boundary === 'before-send' ? proposal.operationId : null })?.accepted)
      return { allowed: false, historicalConstraintsChecked: true, currentInFlightChecked: true, reasonCode: 'LAND_ACCELERATION_CURRENT_NEED_CHANGED' };
    for (const row of current.unresolvedOperations || []) {
      if (row.operation_id === proposal.operationId) continue;
      const prior = ledgerView.operation(row.operation_id);
      if (!prior?.targets?.some(target => (target.target_ref ?? target.original?.targetRef) === proposal.targets[0].targetRef)) continue;
      const proof = isolationEvidence.read({ context, operationId: row.operation_id });
      if (proof?.available !== true || proof.previousExecution?.closed !== true ||
          currentNeedReconciler.isClaimCurrent({ claimRef: need.claimRef, context, currentSnapshot: currentNeedSnapshot(proposal),
            currentNeed: need, operationId: boundary === 'before-send' ? proposal.operationId : null })?.accepted !== true)
        return { allowed: false, historicalConstraintsChecked: true, currentInFlightChecked: true, reasonCode: 'LAND_ACCELERATION_PRIOR_TARGET_NOT_ISOLATED' };
    }
    return { allowed: true, historicalConstraintsChecked: true, currentInFlightChecked: true, reasonCode: null };
  }
  function accelerationFactBasis(proposal) {
    const context = proposalContext(proposal), land = projection.view(context).lands[String(proposal.acceleration.targetLandId)],
      now = clock(context.subjectRef), balance = proposal.acceleration.mode === 'card' ? resources.balance({ context, itemId: 1001 }) : null,
      extension = accelerationExtensionForContext(context);
    return { version: 'land-acceleration-basis/v1', context: contextKey(context), mode: proposal.acceleration.mode,
      target: land ? { landId: land.landId, status: land.status, semanticVersion: land.semanticVersion,
        cropRef: lifecycles.get({ subjectRef: context.subjectRef, landId: land.landId })?.cropRef ?? null,
        flowerId: field(land, 'flowerId') ?? null, state: field(land, 'state') ?? null,
        plantTime: field(land, 'plantTime') ?? null, nextTime: field(land, 'nextTime') ?? null, source: safeSource(land.source) } : null,
      clock: { revision: now?.revision ?? null, uncertaintyMs: now?.uncertaintyMs ?? null,
        evidenceRef: now?.evidence?.responseRef ?? null, connectionEpoch: now?.connectionEpoch ?? null },
      extensionRef: extension?.extensionRef ?? null, baseDataSnapshotId: extension?.baseDataSnapshotId ?? null,
      bundleRef: extension?.bundleRef ?? null, cardAccountingVersion: balance?.accountingVersion ?? null };
  }
  function qualifyFeature(featureId, { proposal, config, boundary = 'before-prepare', ownReservation = null }) {
    assertSingleProposal(proposal);
    const context = proposalContext(proposal), saved = configValue(config), current = projection.view(context), target = current.lands[String(proposal.params.landId)];
    const deny = reasonCode => ({ allowed: false, targetsCurrent: false, resourcesCurrent: false, reasonCode });
    const activeCatalog = catalogForContext(context);
    if (!activeCatalog) return deny('LAND_SOURCE_VERSION_UNSUPPORTED');
    const guard = readMethodGuard(context, featureId);
    if (guard) return deny(guard.reasonCode);
    if (closed || !isCurrent(context) || !current.current || current.identity?.verified !== true || saved[featureId + 'Enabled'] !== true || !target?.current) return deny('LAND_QUALIFICATION_CONTEXT_INVALID');
    const stage = lifecycles.stageFor({ land: { subjectRef: context.subjectRef, landId: target.landId }, action: featureId });
    if (!stage.known || stage.lifecycleRef !== proposal.targets[0].lifecycleRef) return deny('LAND_TARGET_STAGE_CHANGED');
    const groupView = readGroupView(context, proposal.operationId), group = groupView.groups.find(item => item.groupRef === proposal.land.groupRef);
    if (!group || group.currentBinding?.state === 'historical' || !group.members.some(member => member.currentBinding?.state !== 'historical' &&
      member.memberKey === proposal.land.groupMemberKey && member.landId === target.landId)) return deny('LAND_GROUP_BINDING_CHANGED');
    if (featureId === 'plant') {
      if (target.status !== 'empty') return deny('LAND_TARGET_NO_LONGER_EMPTY');
      const selection = readPlantPool(proposal), candidate = selection.candidates.find(item => item.flowerId === proposal.params.flowerId);
      if (!selection.known || !candidate || selection.fingerprint !== proposal.land.readPoolBasis) return deny('LAND_PLANT_POOL_CHANGED');
      const estimate = estimateYield({ context, view: current, groupView, flowerId: candidate.flowerId, excludeOperationId: proposal.operationId });
      const capacity = planStockCapacity({ flowerId: candidate.flowerId, target: saved.plantMode === 'least_stock' ? 0 : saved.restockCount,
        stockConfirmed: candidate.stockConfirmed, yieldExpected: estimate.expected, yieldReserved: estimate.reserved, groupCapacity: candidate.availableCapacity });
      if (!capacity.known || capacity.capacity < 1) return deny(capacity.reasonCode || 'LAND_PLANT_TARGET_REACHED');
    } else if (featureId === 'water') {
      if (field(target, 'state') !== 1) return deny('LAND_TARGET_NO_LONGER_NEEDS_WATER');
      const budget = resources.budget({ context, itemId: 7, keep: saved.keepWater, quantity: 1,
        claimingOperationId: boundary === 'before-send' ? proposal.operationId : null, requireOwnReservation: boundary === 'before-send' });
      if (!budget.known || !budget.allowed) return deny(budget.reasonCode || 'LAND_WATER_BUDGET_CHANGED');
    } else {
      if (proposal.resources?.length!==1 || proposal.resources[0].resourceKind!=='land' || proposal.resources[0].quantity!==1 ||
          proposal.resources[0].resourceRef!==proposal.targets[0].targetRef) return deny('LAND_HARVEST_RESOURCE_CONTRACT_CHANGED');
      const round = group.round;
      if (round?.roundRef !== proposal.land.roundRef || !round.members.some(member => member.landId === target.landId && member.stageRef === stage.lifecycleRef && member.state === 'pending')) return deny('LAND_HARVEST_ROUND_CHANGED');
      const maturity = lifecycles.ripeness({ land: target, clock: clock(context.subjectRef) });
      if (!maturity.known || !maturity.mature) return deny(maturity.reasonCode || 'LAND_TARGET_NO_LONGER_MATURE');
    }
    return { allowed: true, targetsCurrent: true, resourcesCurrent: true, reasonCode: null };
  }
  function onSettled({ proposal, verification: result, operation, targetSettlement, visibility, sendBinding, postReads = [] }) {
    const context = proposalContext(proposal);
    if (proposal.featureId !== 'land.acceleration') groups.applyTargetSettlement({ context, proposal, member: result.member || { memberKey: proposal.targets[0].memberKey,
      verdict: result.verdict, reasonCode: result.reasonCode }, settlementRef: targetSettlement?.settlement_key ?? targetSettlement?.settlementKey ?? null,
    postRead: result.postRead, effect: result.targetEffect });
    const coverage = resources.planCoverage({ context, operation, targetSettlement, sendBinding, postRead: postReads.at(-1) ?? result.postRead });
    resources.applyCoverage(coverage);
    // Audit-only settlement never publishes current heads or rearms business.
    return { groupRecorded: proposal.featureId !== 'land.acceleration', visibility, coverageLinks: coverage?.links?.length ?? 0 };
  }
  function onCurrentVerified({ proposal, verification: result }) {
    const context = proposalContext(proposal);
    if (closed || !isCurrent(context)) throw problem('LAND_CURRENT_PUBLICATION_REVOKED', '旧结论不能叫醒当前业务');
    if (result.verdict === 'confirmed' && proposal.featureId !== 'land.acceleration') groups.announce(context, proposal);
  }
  function publicView({ ownerRef, accountRef, subjectRef, config = null }) {
    const context = contexts.get(contextHeadKey({ ownerRef, subjectRef }));
    const sourcePolicy = context ? versionStates.get(contextKey(context)) ?? null : null;
    if (!context || context.accountRef !== String(accountRef) || !isCurrent(context)) return freeze({ available: false, current: false,
      source: 'rebuilt-land', lands: [], groups: [], plantable: { known: false, count: null }, empty: { known: false, count: null },
      sourcePolicy: clone(sourcePolicy), reasonCode: sourcePolicy?.reasonCode || 'LAND_CURRENT_FACTS_UNAVAILABLE' });
    const view = projection.view(context), groupView = groups.view(context);
    const settings = config ? configValue(config) : null;
    const activeCatalog = catalogForContext(context);
    const plantPool = settings && activeCatalog ? selectPlantCandidates({ view, config: settings, catalog: activeCatalog, resources, groups: groupView, context }) : null;
    const stockPlans = plantPool?.known ? plantPool.candidates.map(candidate => {
      const estimate = estimateYield({ context, view, groupView, flowerId: candidate.flowerId });
      return { flowerId: candidate.flowerId, estimate, capacity: planStockCapacity({ flowerId: candidate.flowerId,
        target: settings.plantMode === 'least_stock' ? 0 : settings.restockCount, stockConfirmed: candidate.stockConfirmed,
        yieldExpected: estimate.expected, yieldReserved: estimate.reserved, groupCapacity: candidate.availableCapacity }) };
    }) : [];
    return freeze({ available: view.current === true, current: view.current === true, source: 'rebuilt-land', catalog: activeCatalog?.identity() ?? null, sourcePolicy: clone(sourcePolicy),
      lands: landEntries(view).map(land => ({ landId: land.landId, state: field(land, 'state') ?? null, status: land.status,
        flowerId: field(land, 'flowerId') ?? null, harvestCnt: field(land, 'harvestCnt') ?? null,
        nextTime: field(land, 'nextTime') ?? null, current: land.current, semanticVersion: land.semanticVersion,
        cropRef: lifecycles.get({ subjectRef, landId: land.landId })?.cropRef ?? null, source: safeSource(land.source), issues: clone(land.issues || []) })),
      groups: clone(groupView.groups),
      plantable: { known: false, count: null, observedCount: Object.values(view.cultivates).filter(item => item.current && item.valid === true && field(item, 'status') === 2).length },
      empty: { known: false, count: null, observedCount: landEntries(view).filter(item => item.current && item.status === 'empty').length },
      resources: resources.view({ context, itemIds: [7] }),
      waterBudget: settings ? resources.budget({ context, itemId: 7, keep: settings.keepWater, quantity: 1 }) : null,
      planning: { readOnly: true, plantPool, stockPlans },
      reasonCode: view.current ? null : 'LAND_CURRENT_FACTS_UNAVAILABLE' });
  }
  const ports = { catalog, catalogForContext, resources, groups, lifecycles, clock, prepareAssessment, estimateYield, buildProposal, qualifyFeature,
    evaluateAdmission: admission.evaluateAdmission, currentNeedReconciler, verify: verification, wait,
    newProposalIds: () => ({ operationId: newId(), proposalId: newId() }),
    accelerationExtension: accelerationExtensionForContext, landField: field,
    consumeCurrentNeed: proposal => { const need = proposal?.land?.currentNeed; return currentNeedReconciler.consumeCurrentNeed({
      claimRef: need?.claimRef, operationId: proposal?.operationId, decisionGeneration: need?.decisionGeneration,
      currentNeed: need, featureId: proposal?.featureId }); },
    accelerationStage: (context, land) => lifecycles.stageFor({ land: { subjectRef: context.subjectRef, landId: land.landId }, action: 'acceleration' }),
    buildAccelerationProposal, evaluateAccelerationAdmission, qualifyAcceleration, verifyAcceleration: accelerationVerification };
  const features = Object.freeze([createPlantFeature(ports), createWaterFeature(ports), createHarvestFeature(ports), createLandAccelerationFeature(ports)]);
  function stop(context) {
    coordinator.cancel(context); projection.invalidate(context);
    versionBindings.delete(contextKey(context)); catalogBindings.delete(contextKey(context)); versionStates.delete(contextKey(context));
    if (sameContext(contexts.get(contextHeadKey(context)), context)) contexts.delete(contextHeadKey(context));
  }
  function shutdown() { closed = true; coordinator.shutdown(); projection.disposeCache(); contexts.clear(); versionBindings.clear(); catalogBindings.clear(); versionStates.clear(); }
  function artSourceFacts({ context, itemIds = [] }) {
    if (!Array.isArray(itemIds) || itemIds.length > 8 || itemIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw problem('ART_FACT_ITEMS_INVALID', '花艺事实仅接收有限物品名单');
    return artSourceFactsBatch({ context, itemIds });
  }
  function artSourceFactsBatch({ context, itemIds = [] }) {
    if (!Array.isArray(itemIds) || itemIds.length > 8192 || itemIds.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(itemIds).size !== itemIds.length)
      throw problem('ART_FACT_BATCH_ITEMS_INVALID', '花艺共享快照物品名单超出有界范围');
    return resources.balanceBatch({ context, itemIds });
  }
  let knownHistory=null;
  const retireKnownHistory=()=>{
    // Initialize after the complete backend (gateway/accounts included) exists.
    // Existing append-only guards remain installed until this atomic upgrade.
    knownHistory ||= createKnownLandHistory({store,ledgerView,currentContexts:()=>[...contexts.values()],isCurrent:isExecutionCurrent,projection});
    return knownHistory.retire();
  };
  return Object.freeze({ features, resources, ingest, retireHistory: lifecycleHistory.retire, retireGroupReceipts: groups.retireReceipts,
    retireKnownHistory,knownHistoryStatus:()=>knownHistory?.snapshot()||{state:'not-initialized',retired:0},
    readFactBasis: input => input.proposal.featureId === 'land.acceleration' ? accelerationFactBasis(input.proposal) : admission.readFactBasis(input),
    evaluateAdmission: input => input.proposal.featureId === 'land.acceleration' ? evaluateAccelerationAdmission(input) : admission.evaluateAdmission(input),
    onSettled, onCurrentVerified, publicView, catalogForContext,
    bindDataSnapshot: ({ context, snapshot, versionEvidence, loginResponseRef } = {}) => {
      if (!context || !snapshot || !isExecutionCurrent(context) || typeof catalogRegistry?.registerDataSnapshot !== 'function') return null;
      const protocolVersion = versionEvidence?.protocolVersion ?? context.protocolVersion;
      if (typeof loginResponseRef !== 'string' || !loginResponseRef ||
          loginResponseRef !== versionEvidence?.loginResponseRef ||
          snapshot.sourceVersion !== versionEvidence?.gameVersion || protocolVersion !== versionEvidence?.protocolVersion) return null;
      const registered = catalogRegistry.registerDataSnapshot({ ...snapshot, protocolVersion, loginResponseRef });
      if (!registered || !isExecutionCurrent(context)) return null;
      catalogBindings.set(contextKey(context), registered);
      versionBindings.set(contextKey(context), { gameVersion: snapshot.sourceVersion, protocolVersion,
        dataSnapshotId: snapshot.dataSnapshotId,
        loginResponseRef, versionEvidence: landSnapshotVersionEvidence(versionEvidence, snapshot, protocolVersion, loginResponseRef) });
      return registered;
    },
    dynamicView: context => projection.view(proposalContext(context)), artSourceFacts, artSourceFactsBatch, stop, shutdown });
}
