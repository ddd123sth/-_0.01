import { canonical, clone, fingerprint, freeze, newId, parseStored, plainObject, problem } from '../../common.mjs';
import { ledgerJsonFingerprint } from '../../persistence/json-contract.mjs';
import { customerContext, knownCustomerCell, sameCustomerContext } from '../customer/wire-facts.mjs';
import { customerOrderFingerprint } from '../customer/identity.mjs';
import { createArtPlanning } from './planning.mjs';
import { ART_MAKE_CONTRACT, artRecipeFingerprint, artTargetFingerprint, assertArtMakeProposal } from './rpc-contract.mjs';
import { createArtVerification, validateArtSnapshotCoverage, validateArtTargetVerification } from './verification.mjs';
import { createArtProductionUnits } from './production-units.mjs';
import { createCurrentNeedReconciler } from '../../execution/current-need.mjs';
import { NORMAL_SYNC_METHODS } from '../../facts/normal-sync-contract.mjs';
import { timedSyncPhase } from '../../../performance-diagnostics.mjs';

export const ART_POST_READ = Object.freeze({ contractId: 'art-fresh-login/after-physical-close/v1', kind: 'after-close-login',
  method: 'index.login', args: {}, evidenceRef: 'g3b/normal-fresh-login/provided-102-106-and-absolute-bag/v1' });
const VERSION = 'art-necessary-single-cost-observation/v1';
const KEEP = Object.freeze({ known: true, keep: 0, policyRef: 'customer.md/4+8.1/G3B-necessary-art/dependent-inputs/no-extra-business-reserve' });
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const scalar = cell => knownCustomerCell(cell) ? cell.value : null;
const sync = value => {
  if (value?.then) { value.catch?.(() => {}); throw new TypeError('Art runtime persistence and readers must be synchronous'); }
  return value;
};
const METHODS = new Set(NORMAL_SYNC_METHODS);
const source = one => one ? { kind: one.kind ?? one.sourceKind ?? one.source ?? null, method: one.method ?? null,
  connectionEpoch: one.connectionEpoch ?? null, requestSequence: one.requestSequence ?? null,
  wireKey: one.wireKey ?? null, responseRef: one.responseRef ?? null } : null;
const validSource = (one, context) => source(one)?.kind === 'response' && METHODS.has(one.method) &&
  one.connectionEpoch === context.connectionEpoch && positive(one.requestSequence) && reference(one.wireKey) && reference(one.responseRef);
export function currentAbsoluteSourceAfterBaseline(baseline, observedSource, context) {
  const base = source(baseline?.source), observed = source(observedSource);
  return baseline?.known === true && base?.kind === 'response' && base.method === 'index.login' &&
    base.connectionEpoch === context?.connectionEpoch && positive(base.requestSequence) && reference(base.responseRef) &&
    validSource(observed, context) && observed.requestSequence >= base.requestSequence;
}
const deny = reasonCode => freeze({ allowed: false, reasonCode, historicalConstraintsChecked: true, currentInFlightChecked: true });

// First observations keep their permanent quota. Normal necessary production
// uses separately persisted parent/recipe/ordinal units and independently
// rederives the exact observed cost authority before each new send.
export function createArtRuntime({ store, catalog, resources, readView, readProfile, customerPlanning, ledgerView,
  legacyConstraints, isolationEvidence, isCurrent, clock, validateReadSnapshotLease, appendOutbox, dynamicState = null,
  readShareEligibility = null, readShareOfficialDay = null, readProfileBatch = readProfile } = {}) {
  for (const [name, fn] of Object.entries({ run: store?.run, get: store?.get, all: store?.all, transaction: store?.transaction,
    nowIso: store?.nowIso, recipe: catalog?.recipe, balance: resources?.balance, budget: resources?.budget,
    reservationSpec: resources?.reservationSpec, planCoverage: resources?.planCoverage, readView, readProfile, customerPlanning,
    operation: ledgerView?.operation, currentAdmission: ledgerView?.currentAdmission,
    candidateProjection: legacyConstraints?.candidateProjection, isCurrent, clock, validateReadSnapshotLease, appendOutbox, readShareEligibility, readShareOfficialDay,
    readProfileBatch })) {
    if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') throw new TypeError('Art runtime requires synchronous port: ' + name);
  }
  const planner = createArtPlanning({ catalog, resources, isCurrent });
  const verification = createArtVerification({ isLeaseCurrent: ({ proposal, bridge }) => {
    const receipt = sync(validateReadSnapshotLease({ leaseRef: bridge.leaseRef, operationId: proposal.operationId,
      originalContext: bridge.originalContext, newContext: bridge.newContext, after: bridge.after, bridgeFingerprint: bridge.bridgeFingerprint }));
    return receipt?.valid === true && receipt.current === true;
  } });
  store.run(`CREATE TABLE IF NOT EXISTS backend_art_cost_observation_quotas(
    quota_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    game_version TEXT NOT NULL,protocol_version TEXT NOT NULL,recipe_fingerprint TEXT NOT NULL,art_id INTEGER NOT NULL,
    unit_ref TEXT NOT NULL UNIQUE,demand_ref TEXT NOT NULL,parent_lifecycle_ref TEXT NOT NULL,
    operation_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('claimed','armed','settled')),
    binding_json TEXT NOT NULL,binding_fingerprint TEXT NOT NULL,verdict TEXT,receipt_json TEXT,receipt_fingerprint TEXT,
    revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    UNIQUE(owner_ref,subject_ref,game_version,protocol_version,recipe_fingerprint))`);
  store.run(`CREATE TABLE IF NOT EXISTS backend_art_cost_observation_events(
    event_key TEXT PRIMARY KEY,quota_ref TEXT NOT NULL,operation_id TEXT NOT NULL,kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,payload_fingerprint TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
  store.run(`CREATE TABLE IF NOT EXISTS backend_art_cost_observation_attempts(
    attempt_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    game_version TEXT NOT NULL,protocol_version TEXT NOT NULL,recipe_fingerprint TEXT NOT NULL,art_id INTEGER NOT NULL,
    unit_ref TEXT NOT NULL UNIQUE,demand_ref TEXT NOT NULL,parent_lifecycle_ref TEXT NOT NULL,operation_id TEXT NOT NULL,
    claim_ref TEXT NOT NULL UNIQUE,current_snapshot_ref TEXT NOT NULL,decision_generation TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('claimed','armed','settled')),binding_json TEXT NOT NULL,binding_fingerprint TEXT NOT NULL,
    verdict TEXT,receipt_json TEXT,receipt_fingerprint TEXT,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
  store.run('CREATE INDEX IF NOT EXISTS backend_art_cost_attempt_lookup ON backend_art_cost_observation_attempts(owner_ref,subject_ref,recipe_fingerprint,state)');
  store.run(`CREATE TRIGGER IF NOT EXISTS backend_art_cost_attempt_identity_immutable BEFORE UPDATE OF attempt_ref,owner_ref,subject_ref,
      game_version,protocol_version,recipe_fingerprint,art_id,unit_ref,demand_ref,parent_lifecycle_ref,claim_ref,current_snapshot_ref,decision_generation
      ON backend_art_cost_observation_attempts BEGIN SELECT RAISE(ABORT,'art cost attempt identity is immutable'); END`);
  store.run(`CREATE TRIGGER IF NOT EXISTS backend_art_cost_attempt_no_delete BEFORE DELETE ON backend_art_cost_observation_attempts
      BEGIN SELECT RAISE(ABORT,'art cost attempts are retained'); END`);
  for (const action of ['UPDATE', 'DELETE']) store.run(`CREATE TRIGGER IF NOT EXISTS backend_art_cost_events_no_${action.toLowerCase()}
    BEFORE ${action} ON backend_art_cost_observation_events BEGIN SELECT RAISE(ABORT,'art cost observation evidence is append only'); END`);
  const productionUnits = createArtProductionUnits({ store, resources, ledgerView, isCurrent });
  const currentNeedReconciler = createCurrentNeedReconciler({ store, ledgerView, isolationEvidence });
  const active = context => sync(isCurrent(context)) === true;
  const wait = reasonCode => ({ state: 'waiting-facts', reasonCode, deviceDueMs: Date.now() + 30000 });
  function configuration(context) {
    const row = store.get('SELECT dto_json,saved_revision,feature_cancel_json,subject_ref FROM backend_config_heads WHERE owner_ref=? AND account_ref=?',
      context.ownerRef, context.accountRef);
    return row?.subject_ref === context.subjectRef ? { config: parseStored(row.dto_json, '必要花艺当前配置'), savedRevision: row.saved_revision,
      featureCancelEpochs: parseStored(row.feature_cancel_json, '必要花艺取消代际') } : null;
  }
  function policy(config) {
    const dto = config?.config, customer = dto?.orders?.customer, art = dto?.art;
    const tiers = Array.isArray(customer?.coinTiers) && customer.coinTiers.every(one => [1, 2, 3].includes(one)) &&
      new Set(customer.coinTiers).size === customer.coinTiers.length ? [...customer.coinTiers].sort((a, b) => a - b) : null;
    const booleans = [];
    function visit(node, path = '') {
      if (!plainObject(node)) return;
      for (const [key, value] of Object.entries(node)) {
        const name = path ? path + '.' + key : key;
        if (typeof value === 'boolean') booleans.push([name, value]);
        else if (plainObject(value)) visit(value, name);
      }
    }
    visit(dto); booleans.sort((a, b) => a[0].localeCompare(b[0]));
    const isolated = booleans.length > 0 && booleans.every(([key, value]) =>
      ['orders.customer.enabled', 'art.makeEnabled'].includes(key) ? value === true : value === false);
    return { customerEnabled: typeof customer?.enabled === 'boolean' ? customer.enabled : null,
      artEnabled: typeof art?.makeEnabled === 'boolean' ? art.makeEnabled : null, coinTiers: tiers,
      autoReject: typeof customer?.autoReject === 'boolean' ? customer.autoReject : null,
      artCancelEpoch: nonnegative(config?.featureCancelEpochs?.['art.make']) ? config.featureCancelEpochs['art.make'] : null,
      customerCancelEpoch: nonnegative(config?.featureCancelEpochs?.['order.customer']) ? config.featureCancelEpochs['order.customer'] : null,
      isolated, booleans, keepPolicy: KEEP };
  }
  function planning(context, config, requestLocalCustomerPlan = null) {
    const sameContext = requestLocalCustomerPlan && requestLocalCustomerPlan.view?.current === true &&
      sameCustomerContext(context, requestLocalCustomerPlan.view.context) && requestLocalCustomerPlan.identities?.current === true &&
      sameCustomerContext(context, requestLocalCustomerPlan.identities.context) && requestLocalCustomerPlan.eligibility?.current === true &&
      sameCustomerContext(context, requestLocalCustomerPlan.eligibility.context);
    const view = sameContext ? requestLocalCustomerPlan.view : sync(readView(context));
    const customerPlan = sameContext ? requestLocalCustomerPlan : sync(customerPlanning(context, config));
    return planner.plan({ context, view, config, customerPlan, keepPolicy: KEEP });
  }
  function currentSnapshotFor(state) {
    const sourceRow = state.view?.identity?.source;
    const absoluteBaseline = state.profile?.completeBagFingerprint;
    const shared = dynamicState?.currentNeedSnapshot?.({ context: state.context, feature, config: state.config,
      method: state.proposal?.method, proposal: state.proposal });
    const sourceProofs = shared?.sourceProofs?.length ? shared.sourceProofs.map(one => ({ method: one.method,
      responseRef: one.responseRef, requestSequence: one.requestSequence, connectionEpoch: one.connectionEpoch })) : [sourceRow, state.order?.source, state.parent?.order?.source, state.vase?.before?.source,
      state.beforeProfile?.source, state.profile?.profile?.gold?.source, state.profile?.profile?.yuanbao?.source,
      ...(state.items || []).flatMap(one => [one.balance?.base?.source, one.balance?.ext?.source])]
      .filter(one => one && one.kind === 'response' && reference(one.responseRef) && reference(one.method) &&
        positive(one.requestSequence) && positive(one.connectionEpoch))
      .map(one => ({ method: one.method, responseRef: one.responseRef, requestSequence: one.requestSequence, connectionEpoch: one.connectionEpoch }))
      .filter((one, index, all) => all.findIndex(other => canonical(other) === canonical(one)) === index);
    return { complete: (!dynamicState || shared?.complete === true) && state.view?.current === true && state.view.identity?.verified === true &&
        currentAbsoluteSourceAfterBaseline(absoluteBaseline, absoluteBaseline?.source, state.context),
      identityVerified: state.view?.identity?.verified === true, method: sourceRow?.method ?? null,
      responseRef: sourceRow?.responseRef ?? null, requestSequence: sourceRow?.requestSequence ?? null,
      connectionEpoch: sourceRow?.connectionEpoch ?? null, officialUid: state.uid,
      gameVersion: state.view?.versionBinding?.gameVersion ?? null, protocolVersion: state.view?.versionBinding?.protocolVersion ?? null, sourceProofs };
  }
  function event(quota, operationId, kind, payload) {
    const key = 'art-cost-event:' + fingerprint([quota.quota_ref, operationId, kind, payload]);
    const json = canonical(payload), hash = fingerprint(payload), existing = store.get('SELECT payload_fingerprint FROM backend_art_cost_observation_events WHERE event_key=?', key);
    if (existing && existing.payload_fingerprint !== hash) throw problem('ART_COST_EVENT_CONFLICT', '原花艺成本观察回执不能覆盖');
    if (!existing) store.run('INSERT INTO backend_art_cost_observation_events VALUES(?,?,?,?,?,?,?)', key, quota.quota_ref, operationId, kind, json, hash, store.nowIso());
    return key;
  }
  function nonSendProof(operationId) {
    const original = sync(ledgerView.operation(operationId));
    if (!original) return { known: true, kind: 'no-prepared-operation', operationId };
    const permit = store.get('SELECT consumed FROM backend_send_permits WHERE operation_id=?', operationId);
    if (original.transport_state !== 'not_sent' || original.business_verdict !== 'not_applicable' || original.write_slot !== 0 || permit?.consumed === 1) return null;
    for (const row of store.all('SELECT * FROM backend_operation_evidence WHERE operation_id=? ORDER BY evidence_id DESC', operationId)) {
      const payload = parseStored(row.payload_json, '花艺原未发送回执');
      if (payload.nonSendProof?.permitConsumed !== false || payload.nonSendProof?.byteSendStarted !== false ||
        ledgerJsonFingerprint({ kind: row.kind, source: row.source, payload, observedAt: row.observed_at }) !== row.payload_fingerprint) continue;
      return { known: true, kind: 'persisted-proved-not-sent', operationId,
        originalFingerprint: original.original_fingerprint, evidenceId: row.evidence_id, evidenceFingerprint: row.payload_fingerprint };
    }
    return null;
  }
  function quotaFor(context, recipeFingerprint, observation = null) {
    if (typeof observation?.quotaRef === 'string' && observation.quotaRef.startsWith('art-cost-attempt:')) {
      const row = store.get('SELECT * FROM backend_art_cost_observation_attempts WHERE attempt_ref=? AND owner_ref=? AND account_ref=? AND subject_ref=? AND recipe_fingerprint=?',
        observation.quotaRef, context.ownerRef, context.accountRef, context.subjectRef, recipeFingerprint);
      return row ? { ...row, quota_ref: row.attempt_ref, source_kind: 'attempt' } : null;
    }
    return store.get('SELECT * FROM backend_art_cost_observation_quotas WHERE owner_ref=? AND subject_ref=? AND recipe_fingerprint=? ORDER BY created_at LIMIT 1',
      context.ownerRef, context.subjectRef, recipeFingerprint);
  }
  function claim(context, selected, recipeFingerprint, operationId, currentNeed, currentSnapshot) {
    if (!active(context)) return null;
    const prior = quotaFor(context, recipeFingerprint);
    if (prior?.state === 'settled') {
      if (prior.verdict !== 'unknown' || !currentNeed?.claimRef || !currentNeed?.decisionGeneration || !currentSnapshot?.complete) return null;
      // claimRef is derived only from the accepted current official source set
      // and stable business need, so local policy changes cannot mint a second
      // attempt against the same snapshot.
      const currentSnapshotRef = currentNeed.claimRef;
      const attemptRef = 'art-cost-attempt:' + fingerprint([context.ownerRef, context.subjectRef, recipeFingerprint, currentNeed.claimRef]);
      const unitRef = 'art-cost-unit:' + fingerprint([attemptRef, currentNeed.claimRef]);
      const demandRef = 'art-demand:' + fingerprint({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
        parentLifecycleRef: selected.parent.lifecycleRef, artId: selected.artId });
      const existing = store.get('SELECT * FROM backend_art_cost_observation_attempts WHERE attempt_ref=?', attemptRef);
      if (existing) {
        if (existing.claim_ref !== currentNeed.claimRef || existing.current_snapshot_ref !== currentSnapshotRef ||
            existing.recipe_fingerprint !== recipeFingerprint) return null;
        if (existing.state === 'settled') return null;
        const proof = nonSendProof(existing.operation_id);
        if (!proof) return null;
        const updated = store.run(`UPDATE backend_art_cost_observation_attempts SET account_ref=?,operation_id=?,state='claimed',binding_json='{}',
          binding_fingerprint=?,revision=revision+1,updated_at=? WHERE attempt_ref=? AND operation_id=? AND revision=? AND state!='settled'`,
        context.accountRef, operationId, fingerprint({}), store.nowIso(), attemptRef, existing.operation_id, existing.revision);
        if (Number(updated.changes) !== 1) return null;
        const row = quotaFor(context, recipeFingerprint, { quotaRef: attemptRef });
        event(row, operationId, 'current-need-cost-attempt-replanned', { attemptRef, claimRef: currentNeed.claimRef,
          currentSnapshotRef, decisionGeneration: currentNeed.decisionGeneration, priorNonSendProof: proof, originalOutcomesUnchanged: true });
        return row;
      }
      const at = store.nowIso();
      store.run('INSERT INTO backend_art_cost_observation_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        attemptRef, context.ownerRef, context.accountRef, context.subjectRef, selected.recipe.source.gameVersion, '480.0.0', recipeFingerprint, selected.artId,
        unitRef, demandRef, selected.parent.lifecycleRef, operationId, currentNeed.claimRef, currentSnapshotRef,
        currentNeed.decisionGeneration, 'claimed', '{}', fingerprint({}), null, null, null, 1, at, at);
      const row = quotaFor(context, recipeFingerprint, { quotaRef: attemptRef });
      event(row, operationId, 'current-need-cost-attempt-claimed', { attemptRef, claimRef: currentNeed.claimRef,
        currentSnapshotRef, decisionGeneration: currentNeed.decisionGeneration, parentLifecycleRef: selected.parent.lifecycleRef,
        recipeFingerprint, priorUnknownCostQuotaRef: prior.quota_ref, originalOutcomeUnchanged: true });
      return row;
    }
    const quotaRef = prior?.quota_ref || 'art-cost-quota:' + fingerprint({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
      gameVersion: '480.0.27', protocolVersion: '480.0.0', recipeFingerprint });
    const unitRef = prior?.unit_ref || 'art-unit:' + fingerprint([quotaRef, 1]);
    const demandRef = 'art-demand:' + fingerprint({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
      parentLifecycleRef: selected.parent.lifecycleRef, artId: selected.artId });
    const proof = prior ? nonSendProof(prior.operation_id) : null;
    if (prior && (prior.state === 'settled' || !proof)) return null;
    const at = store.nowIso();
    if (!prior) store.run(`INSERT INTO backend_art_cost_observation_quotas VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      quotaRef, context.ownerRef, context.accountRef, context.subjectRef, selected.recipe.source.gameVersion, '480.0.0', recipeFingerprint, selected.artId,
      unitRef, demandRef, selected.parent.lifecycleRef, operationId, 'claimed', '{}', fingerprint({}), null, null, null, 1, at, at);
    else {
      const updated = store.run(`UPDATE backend_art_cost_observation_quotas SET account_ref=?,demand_ref=?,parent_lifecycle_ref=?,
        operation_id=?,state='claimed',binding_json='{}',binding_fingerprint=?,revision=revision+1,updated_at=?
        WHERE quota_ref=? AND operation_id=? AND revision=? AND state!='settled'`, context.accountRef, demandRef,
        selected.parent.lifecycleRef, operationId, fingerprint({}), at, quotaRef, prior.operation_id, prior.revision);
      if (Number(updated.changes) !== 1) return null;
    }
    const quota = quotaFor(context, recipeFingerprint);
    event(quota, operationId, prior ? 'unsent-unit-replanned' : 'single-cost-unit-claimed', { quotaRef, unitRef, demandRef,
      parentLifecycleRef: selected.parent.lifecycleRef, recipeFingerprint, priorNonSendProof: proof, originalOutcomesUnchanged: true });
    return quota;
  }
  function vaseFor(view, context, artId, vaseId, uid) {
    const inputs = view?.artEligibilityInputs, map = inputs?.vases?.map;
    const row = map?.entries?.find(one => one.vaseId === vaseId), fields = row?.fields;
    const history = inputs?.flowerArt?.makeList, list = history?.value;
    const mapComplete = map?.current === true && knownCustomerCell(map) && map.sourceProvidedMapComplete === true && map.decodedComplete === true &&
      map.complete === true && map.truncated === false && Array.isArray(map.entries) && map.entries.every(one => one?.current === true &&
        one.uidMatchesCurrentLogin === true && one.vaseIdMatchesKey === true && positive(scalar(one.fields?.uid)) &&
        scalar(one.fields?.uid) === uid && positive(scalar(one.fields?.vaseId)) && scalar(one.fields?.vaseId) === one.vaseId &&
        validSource(source(one.source), context));
    const domainCurrent = inputs?.flowerArt?.domain?.current === true && knownCustomerCell(inputs.flowerArt.domain) &&
      inputs.flowerArt.uidMatchesCurrentLogin === true && scalar(inputs.flowerArt.uid) === uid && inputs.flowerArt.uid.current === true &&
      history?.current === true && knownCustomerCell(history) && validSource(history.source, context) && list?.complete === true &&
      list.truncated === false && Array.isArray(list.entries) && list.total === list.entries.length && list.entries.every(positive);
    const known = mapComplete && domainCurrent;
    const owned = known && row?.current === true && row.uidMatchesCurrentLogin === true && row.vaseIdMatchesKey === true &&
      scalar(fields?.uid) === uid && scalar(fields?.vaseId) === vaseId && positive(scalar(fields?.uTime)) && positive(scalar(fields?.cTime)) &&
      validSource(source(row.source), context);
    return { known, owned, reasonCode: !known ? 'ART_VASE_OWNERSHIP_OR_SOURCE_UNKNOWN' : owned ? null : 'ART_VASE_PROVEN_NOT_OWNED',
      before: owned ? { uid, vaseId, uTime: scalar(fields.uTime), cTime: scalar(fields.cTime), source: source(row.source) } : null,
      ownershipSource: known ? { map: source(map.source), domain: source(inputs.flowerArt.domain.source), uid: source(inputs.flowerArt.uid.source),
        makeList: source(history.source), completeMapFingerprint: fingerprint(map.entries.map(one => one.vaseId).sort((a, b) => a - b)) } : null,
      alreadyMade: owned ? list.entries.includes(artId) : null };
  }
  function stateFor(proposal, configOverride = null) {
    const contract = assertArtMakeProposal(proposal), context = customerContext(proposal);
    if (!context) throw problem('ART_CURRENT_CONTEXT_INVALID', '必要花艺必须有完整归属及连接代际');
    const config = configOverride || configuration(context), currentPolicy = policy(config), view = sync(readView(context));
    const customer = config ? sync(customerPlanning(context, config)) : null;
    const ids = [...contract.expectedConsumptions.map(one => one.itemId), proposal.art.artId];
    const profile = sync(readProfile({ context, itemIds: ids }));
    const uid = scalar(view?.identity?.uid), order = view?.orders?.find(one => one.npcId === proposal.art.parentNpcId);
    const parent = customer?.decisions?.find(one => one.npcId === proposal.art.parentNpcId && one.lifecycleRef === proposal.art.parentLifecycleRef);
    const life = customer?.identities?.identities?.find(one => one.npcId === proposal.art.parentNpcId);
    const vase = vaseFor(view, context, proposal.art.artId, proposal.art.vaseId, uid);
    const items = ids.map(itemId => ({ itemId, balance: profile?.items?.[itemId] ?? null }));
    const product = items.find(one => one.itemId === proposal.art.artId)?.balance;
    const gold = scalar(profile?.profile?.gold), yb = scalar(profile?.profile?.yuanbao);
    const goldSource = source(profile?.profile?.gold?.source), ybSource = source(profile?.profile?.yuanbao?.source);
    const profileKnown = profile?.current === true && sameCustomerContext(profile.context, context) && profile.identity?.verified === true &&
      scalar(profile.identity.uid) === uid && nonnegative(gold) && nonnegative(yb) && validSource(goldSource, context) &&
      validSource(ybSource, context);
    const normal = !proposal.art.costObservation;
      const authorization = normal ? productionUnits.costFor({ context, recipeFingerprint: proposal.art.recipeFingerprint, artId: proposal.art.artId,
        currentCatalogSource: proposal.art.catalogSource, currentRowProof: proposal.art.recipeSourceProof }) : null;
    return { contract, context, config, policy: currentPolicy, view, customer, uid, order, parent, life, vase, items, product,
      normal, authorization, proposal,
      profileKnown, beforeProfile: profileKnown ? { gold, yb, source: goldSource, goldSource, ybSource } : null,
      quota: quotaFor(context, proposal.art.recipeFingerprint, proposal.art.costObservation) };
  }
  function basisFor(state) {
    const { context, policy: currentPolicy, parent, life, uid, vase, items, product } = state;
    const relatedPolicy = state.normal ? Object.fromEntries(Object.entries(currentPolicy).filter(([key]) => !['isolated', 'booleans'].includes(key))) : currentPolicy;
    return freeze({ version: state.normal ? 'art-necessary-normal-single/v1' : VERSION, context, officialIdentity: { uid: positive(uid) ? uid : null,
      gameVersion: state.view?.versionBinding?.gameVersion ?? null, protocolVersion: state.view?.versionBinding?.protocolVersion ?? null },
      parent: { npcId: parent?.npcId ?? null, lifecycleRef: parent?.lifecycleRef ?? null, contentFingerprint: parent?.order?.contentFingerprint ?? null,
        need: parent?.order?.need ?? null, accepted: parent?.accepted === true, firstSeenSequence: life?.firstSeenSequence ?? null,
        finishedStockLowerBound: product?.effective?.lowerBound ?? null },
      recipeFingerprint: state.proposal.art.recipeFingerprint, unitRef: state.proposal.art.unitRef,
      demandRef: state.proposal.art.demandRef, quotaRef: state.normal ? null : state.quota?.quota_ref ?? null,
      productionUnit: state.normal ? { ordinal: state.proposal.art.productionUnit?.ordinal ?? null,
        authorizationRef: state.authorization?.known === true ? state.authorization.authorizationRef : null,
        costReceiptRef: state.authorization?.known === true ? state.authorization.costContract.receiptRef : null } : null,
      vase: vase.before ? { uid: vase.before.uid, vaseId: vase.before.vaseId, uTime: vase.before.uTime, cTime: vase.before.cTime } : null,
      firstMake: { known: vase.known, alreadyMade: vase.alreadyMade },
      currentNeed: state.proposal.art.currentNeed ?? null,
      items: items.map(({ itemId, balance }) => ({ itemId, quantity: balance?.base?.known ? balance.base.value : null,
        accountingVersion: digest(balance?.accountingVersion) ? balance.accountingVersion : null,
        effectiveLowerBound: balance?.effective?.lowerBound ?? null, extCurrent: balance?.ext?.current === true })),
      profile: state.beforeProfile ? { gold: state.beforeProfile.gold, yb: state.beforeProfile.yb,
        goldSource: state.beforeProfile.goldSource, ybSource: state.beforeProfile.ybSource } : null, policy: relatedPolicy });
  }
  function readFactBasis({ proposal } = {}) { return basisFor(stateFor(proposal)); }
  function parentError(state, proposal) {
    const { context, view, customer, uid, order, parent, life, policy: currentPolicy, product, profileKnown, vase } = state;
    if (!active(context) || !sameCustomerContext(context, view?.context) || view?.current !== true || view.identity?.verified !== true ||
      !positive(uid) || uid !== proposal.art.officialUid || !knownCustomerCell(view.identity.uid) || !validSource(view.identity.source, context) ||
      view.identity.source.method !== 'index.login' || canonical(view.versionBinding) !== canonical(proposal.art.versionEvidence)) return 'ART_CURRENT_OFFICIAL_IDENTITY_UNPROVEN';
    if (!currentPolicy.customerEnabled || !currentPolicy.artEnabled || currentPolicy.artCancelEpoch !== proposal.featureCancelEpoch ||
      currentPolicy.customerCancelEpoch !== proposal.art.customerCancelEpoch) return 'ART_NECESSARY_PARENT_OR_MAKE_INTENT_CHANGED';
    if (!customer?.view?.current || !sameCustomerContext(customer.view.context, context) || customer.identities?.current !== true ||
      customer.identities.complete !== true || !sameCustomerContext(customer.identities.context, context) ||
      customer.eligibility?.current !== true || !sameCustomerContext(customer.eligibility.context, context) ||
      customer.eligibility.customerOpen?.known !== true || customer.eligibility.customerOpen.value !== true ||
      !parent?.accepted || parent.verdict !== 'accepted' || !sameCustomerContext(parent.context, context) ||
      parent.identityKnown !== true || parent.featureCancelEpoch !== proposal.art.customerCancelEpoch ||
      parent.policyFingerprint !== proposal.art.parentPolicyFingerprint || !life?.current || !life.identityKnown ||
      !sameCustomerContext(life.context, context) || life.lifecycleRef !== proposal.art.parentLifecycleRef ||
      life.contentFingerprint !== proposal.art.parentContentFingerprint || parent.order?.contentFingerprint !== life.contentFingerprint ||
      !order?.current || order.readable !== true || customerOrderFingerprint(order) !== life.contentFingerprint ||
      parent.order.artId !== proposal.art.artId || parent.order.need !== proposal.art.parentNeed ||
      parent.decisionRef !== proposal.art.acceptedDecisionRef || parent.firstSeenSequence !== life.firstSeenSequence) return 'ART_ACCEPTED_PARENT_LIFECYCLE_CHANGED';
    if (customer.allocation?.known !== true || !sameCustomerContext(customer.allocation.context, context)) return 'ART_CUSTOMER_FINISHED_STOCK_UNKNOWN';
    if (customer.allocation.selected) return 'ART_CUSTOMER_FINISHED_STOCK_DELIVERY_FIRST';
    if (!product?.base?.known || !nonnegative(product.effective?.lowerBound) || product.ext?.current !== true) return 'ART_CURRENT_PRODUCT_QUANTITY_UNKNOWN';
    if (product.effective.lowerBound >= parent.order.need) return 'ART_FINISHED_STOCK_RESERVED_NOT_A_REAL_SHORTAGE';
    if (!vase.known || !profileKnown) return 'ART_ORIGINAL_VASE_OR_CURRENCY_FACTS_UNKNOWN';
    for (const { itemId, balance } of state.items) {
      const initial = proposal.art.beforeItems.find(one => one.itemId === itemId);
      if (!balance?.base?.known || !nonnegative(balance.base.value) || !digest(balance.accountingVersion) || balance.ext?.current !== true ||
        !sameCustomerContext(balance.context, context) || !validSource(balance.base.source, context) || !initial ||
        initial.quantity !== balance.base.value || initial.basisRef !== balance.basisRef) return 'ART_ORIGINAL_ABSOLUTE_ITEM_BASIS_CHANGED';
    }
    if (state.beforeProfile.gold !== proposal.art.beforeProfile.gold || state.beforeProfile.yb !== proposal.art.beforeProfile.yb ||
      canonical({ ...state.vase.before, source: null }) !== canonical({ ...proposal.art.beforeVase, source: null })) return 'ART_ORIGINAL_PROFILE_OR_VASE_CHANGED';
    return null;
  }
  function ownError(state, proposal, boundary, ownReservation, admission) {
    const beforeSend = boundary === 'before-send';
    if (!['before-prepare', 'before-send'].includes(boundary) || beforeSend &&
      (ownReservation?.required !== true || ownReservation.operationId !== proposal.operationId) || !beforeSend && ownReservation?.required === true) return 'ART_OWN_RESERVATION_BOUNDARY_INVALID';
    if (admission.activeOperation && (!beforeSend || admission.activeOperation.operation_id !== proposal.operationId)) return 'ART_CURRENT_WRITE_IN_FLIGHT';
    if (!beforeSend) return null;
    const own = sync(ledgerView.operation(proposal.operationId));
    if (!own || own.write_slot !== 1 || !['not_started', 'may_have_sent'].includes(own.transport_state) || own.owner_ref !== state.context.ownerRef ||
      own.account_ref !== state.context.accountRef || own.subject_ref !== state.context.subjectRef || own.original?.ownerEpoch !== state.context.ownerEpoch ||
      own.run_epoch !== state.context.runEpoch || own.connection_epoch !== state.context.connectionEpoch || own.feature_id !== proposal.featureId ||
      own.scope !== proposal.scope || own.method !== proposal.method || own.semantic_key !== proposal.semanticKey ||
      own.params_fingerprint !== proposal.paramsFingerprint || canonical(own.original.targets) !== canonical(proposal.targets) ||
      canonical(own.original.resources) !== canonical(proposal.resources) || canonical(own.original.resourceBindings) !== canonical(proposal.resourceBindings) ||
      own.resources?.length !== proposal.resources.length || own.resourceBindings?.length !== proposal.resourceBindings.length) return 'ART_OWN_IMMUTABLE_RESERVATION_CHANGED';
    return null;
  }
  function budgetsFor(state, proposal, boundary) {
    return state.contract.expectedConsumptions.map(one => ({ itemId: one.itemId,
      budget: sync(resources.budget({ context: state.context, itemId: one.itemId, quantity: one.quantity, keep: KEEP.keep,
        claimingOperationId: boundary === 'before-send' ? proposal.operationId : null, requireOwnReservation: boundary === 'before-send' })) }));
  }
  function budgetError(proposal, budgets, boundary) {
    for (const { itemId, budget } of budgets) {
      if (budget?.known !== true || budget.allowed !== true) return budget?.reasonCode || 'ART_INPUT_BUDGET_UNPROVEN';
      if (boundary !== 'before-send') continue;
      const resource = proposal.resources.find(one => one.resourceRef === 'item:' + itemId), own = budget.ownReservation, rows = own?.resources;
      if (own?.valid !== true || own.operationId !== proposal.operationId || own.quantity !== resource.quantity ||
        !Array.isArray(rows) || rows.length !== 1 || rows[0].operationId !== proposal.operationId || rows[0].resourceKey !== resource.resourceKey ||
        rows[0].quantity !== resource.quantity || rows[0].unreflectedQuantity !== resource.quantity ||
        !['reserved', 'in_flight'].includes(rows[0].state)) return 'ART_EXACT_OWN_INPUT_RESERVATION_MISSING';
    }
    return null;
  }
  function quotaError(state, proposal) {
    if (productionUnits.hasCostGuard(state.context, proposal.art.recipeFingerprint)) return 'ART_RECIPE_OBSERVED_COST_GUARD';
    if (state.normal) {
      const checked = productionUnits.validate({ context: state.context, proposal, binding: bindingFor(proposal) });
      return checked.known ? null : checked.reasonCode;
    }
    const quota = state.quota;
    if (proposal.art.costObservation?.kind !== 'validation-single-cost-observation' || !quota || quota.state === 'settled' ||
      quota.owner_ref !== proposal.ownerRef || quota.account_ref !== proposal.accountRef || quota.subject_ref !== proposal.subjectRef ||
      quota.operation_id !== proposal.operationId || quota.quota_ref !== proposal.art.costObservation.quotaRef || quota.unit_ref !== proposal.art.unitRef ||
      quota.demand_ref !== proposal.art.demandRef || quota.parent_lifecycle_ref !== proposal.art.parentLifecycleRef ||
      quota.recipe_fingerprint !== artRecipeFingerprint(proposal.art) || quota.binding_fingerprint !== fingerprint(bindingFor(proposal)) ||
      fingerprint(parseStored(quota.binding_json, '花艺观察原单件')) !== quota.binding_fingerprint) return 'ART_SINGLE_COST_OBSERVATION_QUOTA_NOT_OWNED';
    const prior = store.get("SELECT operation_id FROM backend_operations WHERE owner_ref=? AND subject_ref=? AND feature_id='art.make' AND semantic_key=? AND operation_id!=? AND transport_state!='not_sent' LIMIT 1",
      proposal.ownerRef, proposal.subjectRef, proposal.semanticKey, proposal.operationId);
    return prior ? 'ART_SINGLE_COST_OBSERVATION_ORIGINAL_MAY_HAVE_SENT' : null;
  }
  function historyError(state, proposal, factBasis, admission) {
    for (const row of admission.unresolvedOperations) {
      if (row.operation_id === proposal.operationId) continue;
      const old = sync(ledgerView.operation(row.operation_id));
      if (!old || old.owner_ref !== state.context.ownerRef || old.subject_ref !== state.context.subjectRef) return 'ART_CURRENT_HISTORY_SCOPE_UNREADABLE';
      if (old.feature_id === 'art.make' && (old.semantic_key === proposal.semanticKey || old.targets?.some(target =>
        (target.target_ref ?? target.original?.targetRef) === proposal.targets[0].targetRef))) {
        if (old.semantic_key === proposal.semanticKey || !closedArtNeedCanBeReassessed(old, proposal, state)) return 'ART_ORIGINAL_RECIPE_OR_UNIT_RESULT_UNKNOWN';
        const reconciled = sync(currentNeedReconciler.reconcile({ context: state.context, originalOperationId: old.operation_id,
          currentSnapshot: currentSnapshotFor(state),
          currentNeed: proposal.art.currentNeed, operationId: proposal.operationId }));
        if (reconciled?.accepted !== true) return reconciled?.reasonCode || 'ART_CURRENT_NEED_RECONCILIATION_UNAVAILABLE';
        sync(appendOutbox({ ownerRef: state.context.ownerRef, subjectRef: state.context.subjectRef,
          eventType: 'CurrentNeedAutomaticallyReconciled', eventKey: reconciled.reconciliationRef,
          payload: { traceId: proposal.traceId || old.trace_id || old.original?.traceId || old.operation_id,
            operationId: proposal.operationId, originalOperationId: old.operation_id, featureId: proposal.featureId,
            targetRef: proposal.targets[0].targetRef, reasonCode: 'CURRENT_OFFICIAL_SNAPSHOT_STILL_PROVES_NECESSARY_ART',
            reconciliationRef: reconciled.reconciliationRef, attempted: false } }));
      }
    }
    const rawResourceKeys = state.contract.expectedConsumptions.map(one => 'item:' + one.itemId);
    const currentNeed = proposal.art?.currentNeed;
    if (currentNeed?.claimRef && currentNeedReconciler?.reconcileLegacyCandidate) {
      const currentSnapshot = currentSnapshotFor(state);
      const candidateFingerprint = fingerprint({ featureId: proposal.featureId, method: proposal.method,
        targetRef: proposal.targets[0]?.targetRef ?? null, factBasis });
      const separated = sync(currentNeedReconciler.reconcileLegacyCandidate({ context: state.context, currentSnapshot,
        currentNeed, legacyConstraints, isolationEvidence, rawTargetRefs: proposal.targets.map(one => one.targetRef),
        rawResourceKeys, semanticKey: proposal.semanticKey, factBasis, candidateFingerprint, action: proposal.method,
        methodScope: ['flowerArt.makeFlowerArt'], resourceBaselineRef: admission.resourceBaseline?.baselineRef }));
      if (separated?.accepted !== true) return separated?.reasonCode || 'ART_LEGACY_CURRENT_NEED_UNPROVEN';
    }
    const legacy = sync(legacyConstraints.candidateProjection({ ownerRef: state.context.ownerRef, subjectRef: state.context.subjectRef,
      semanticKey: proposal.semanticKey, rawTargetRefs: proposal.targets.map(one => one.targetRef), rawResourceKeys, factBasis,
      candidateFingerprint: fingerprint({ featureId: proposal.featureId, method: proposal.method,
        targetRef: proposal.targets[0]?.targetRef ?? null, factBasis }), resourceBaselineRef: admission.resourceBaseline?.baselineRef }));
    if (!Array.isArray(legacy?.operations) || !Array.isArray(legacy.semanticMatches) || !Array.isArray(legacy.matchedResources)) return 'ART_LEGACY_LOCAL_SCOPE_UNREADABLE';
    if (legacy.semanticMatches.length || legacy.operations.some(one => one.scope === 'flower-art-make' ||
      one.method === 'flowerArt.makeFlowerArt' || one.feature_id === 'art.make')) return 'ART_LEGACY_MAKE_LIFECYCLE_MAPPING_UNPROVEN';
    // No guessed old target or installation/resource-key mapping. This only
    // gates dependent input items; unrelated old harvests are not account locks.
    return legacy.matchedResources.length ? 'ART_LEGACY_INPUT_RESOURCE_MAPPING_UNPROVEN' : null;
  }
  function closedArtNeedCanBeReassessed(old, proposal, state) {
    const original = old.original;
    if (old.business_verdict !== 'unknown' || old.write_slot !== 0 || !original || original.ownerRef !== state.context.ownerRef ||
      original.subjectRef !== state.context.subjectRef || original.connectionEpoch !== old.connection_epoch ||
      !positive(state.view?.identity?.source?.requestSequence) || state.view.identity.source.kind !== 'response' ||
      state.view.identity.source.method !== 'index.login' || state.view.identity.source.connectionEpoch !== state.context.connectionEpoch ||
      state.context.connectionEpoch <= old.connection_epoch || proposal.art.parentLifecycleRef !== state.parent?.lifecycleRef ||
      proposal.art.currentNeed?.necessary !== true) return false;
    const baseline = state.profile?.completeBagFingerprint;
    const sources = [...(proposal.art.beforeItems || []).map(one => one.source), proposal.art.beforeVase?.source,
      proposal.art.beforeProfile?.goldSource, proposal.art.beforeProfile?.ybSource];
    return sources.every(one => currentAbsoluteSourceAfterBaseline(baseline, one, state.context));
  }
  function bindingFor(proposal) {
    return { version: VERSION, context: customerContext(proposal), operationId: proposal.operationId, semanticKey: proposal.semanticKey,
      art: clone(proposal.art), paramsFingerprint: proposal.paramsFingerprint, targets: clone(proposal.targets),
      resources: clone(proposal.resources), resourceBindings: clone(proposal.resourceBindings) };
  }
  function evaluateAdmission({ proposal, actor, factBasis, boundary = 'before-prepare', ownReservation = null } = {}) {
    const state = stateFor(proposal);
    if (!sameCustomerContext(state.context, customerContext(actor))) return deny('ART_ACTOR_BINDING_CHANGED');
    if (canonical(basisFor(state)) !== canonical(factBasis)) return deny('ART_FACT_BASIS_CHANGED');
    const error = parentError(state, proposal) || quotaError(state, proposal);
    if (error) return deny(error);
    const currentNeedClaim = sync(currentNeedReconciler.isClaimCurrent({ claimRef: proposal.art.currentNeed?.claimRef,
      context: state.context, currentSnapshot: currentSnapshotFor(state), currentNeed: proposal.art.currentNeed,
      operationId: boundary === 'before-send' ? proposal.operationId : null }));
    if (currentNeedClaim?.accepted !== true) return deny(currentNeedClaim?.reasonCode || 'ART_CURRENT_NEED_CLAIM_NOT_CURRENT');
    const admission = sync(ledgerView.currentAdmission({ ownerRef: state.context.ownerRef, subjectRef: state.context.subjectRef,
      targetRefs: proposal.targets.map(target => target.targetRef) }));
    if (!Array.isArray(admission?.unresolvedOperations)) return deny('ART_CURRENT_ADMISSION_UNAVAILABLE');
    const budgetRows = budgetsFor(state, proposal, boundary);
    const blocked = ownError(state, proposal, boundary, ownReservation, admission) || budgetError(proposal, budgetRows, boundary) ||
      historyError(state, proposal, factBasis, admission);
    if (blocked) return deny(blocked);
    return store.transaction(() => {
      if (!active(state.context) || quotaError({ ...state, quota: quotaFor(state.context, proposal.art.recipeFingerprint,
        proposal.art.costObservation) }, proposal)) return deny('ART_OBSERVATION_QUOTA_OR_CONTEXT_REVOKED');
      if (boundary === 'before-send') {
        if (state.normal) {
          const armed = productionUnits.arm({ context: state.context, proposal, binding: bindingFor(proposal) });
          if (!armed.known) return deny(armed.reasonCode);
        } else {
          const table = state.quota.source_kind === 'attempt' ? 'backend_art_cost_observation_attempts' : 'backend_art_cost_observation_quotas';
          const key = state.quota.source_kind === 'attempt' ? 'attempt_ref' : 'quota_ref';
          const updated = store.run(`UPDATE ${table} SET state='armed',revision=revision+1,updated_at=? WHERE ${key}=? AND operation_id=? AND state IN ('claimed','armed')`,
            store.nowIso(), state.quota.quota_ref, proposal.operationId);
          if (Number(updated.changes) !== 1) return deny('ART_OBSERVATION_QUOTA_CAS_FAILED');
        }
      }
      const candidateFingerprint = fingerprint({ semanticKey: proposal.semanticKey, paramsFingerprint: proposal.paramsFingerprint, targets: proposal.targets, factBasis });
      if (!state.normal) event(state.quota, proposal.operationId, boundary, { candidateFingerprint, quotaRef: state.quota.quota_ref,
        parentLifecycleRef: proposal.art.parentLifecycleRef, demandRef: proposal.art.demandRef, unitRef: proposal.art.unitRef,
        exactOwnReservationChecked: boundary === 'before-send', inputResourceKeys: proposal.resources.map(one => one.resourceKey) });
      return freeze({ allowed: true, reasonCode: null, historicalConstraintsChecked: true, currentInFlightChecked: true,
        candidateFingerprint, costObservationOnly: !state.normal, quotaRef: state.normal ? null : state.quota.quota_ref });
    });
  }
  async function assess(input) {
    if (input.config?.config?.art?.makeEnabled !== true) return { state: 'disabled', reasonCode: 'ART_MAKING_NOT_ENABLED' };
    // New accepted work has a dedicated batched v2 executor. Keep this v1
    // single-unit route available only for historical verification/recovery.
    return wait('ART_CUSTOMER_BATCH_EXECUTOR_OWNS_NEW_WORK');
    if (!active(input.context)) return wait('ART_CONTEXT_NOT_CURRENT');
    const current = planning(input.context, input.config);
    if (current.customer?.deliveryFirst) return wait('ART_CUSTOMER_FINISHED_STOCK_DELIVERY_FIRST');
    const candidates = (current.customer?.entries || []).filter(one => one.clientInputFeasible === true && one.parent && one.recipe);
    if (!candidates.length) return wait(current.customer?.reasonCode || 'ART_ACCEPTED_CUSTOMER_NET_SHORTAGE_UNPROVEN');
    let reasonCode = 'ART_ACCEPTED_CUSTOMER_NET_SHORTAGE_UNPROVEN';
    for (const selected of candidates) {
      const authorization = productionUnits.costFor({ context: input.context, artId: selected.artId,
        recipeFingerprint: artRecipeFingerprint(selected.recipe), currentCatalogSource: selected.recipe.source, currentRowProof: selected.recipe.rowProof });
      // A verified excess debit is scoped to this exact recipe. Do not convert
      // the guard into another cost-observation attempt; keep considering other
      // currently feasible recipes and let unrelated customer delivery run.
      if (authorization.reasonCode === 'ART_RECIPE_OBSERVED_COST_GUARD') {
        reasonCode = authorization.reasonCode;
        continue;
      }
      const assessed = await assessSelected(input, selected, authorization);
      if (assessed.state === 'proposals') return assessed;
      reasonCode = assessed.reasonCode || reasonCode;
    }
    return wait(reasonCode);
  }
  function assessSelected(input, selected, authorization) {
    return store.transaction(() => {
      const context = customerContext(input.context), operationId = newId(), recipeFingerprint = artRecipeFingerprint(selected.recipe);
      const normal = authorization.known === true;
      const ids = [...selected.recipe.unitInputMultiset.map(one => one.itemId), selected.artId];
      const profile = sync(readProfile({ context, itemIds: ids })), view = sync(readView(context));
      const currentSnapshotValid = view?.current === true && view.identity?.verified === true && positive(scalar(view.identity.uid)) &&
        view.identity.source?.kind === 'response' && view.identity.source.method === 'index.login' &&
        view.identity.source.connectionEpoch === context.connectionEpoch && positive(view.identity.source.requestSequence) &&
        view.versionBinding?.loginResponseRef === view.identity.source.responseRef &&
        profile?.current === true && sameCustomerContext(profile.context, context) && profile.identity?.verified === true &&
        currentAbsoluteSourceAfterBaseline(profile.completeBagFingerprint, profile.completeBagFingerprint.source, context) &&
        scalar(profile.identity.uid) === scalar(view.identity.uid) && ids.every(id => profile.items?.[id]?.base?.known === true &&
          nonnegative(profile.items[id].base.value) && currentAbsoluteSourceAfterBaseline(profile.completeBagFingerprint, profile.items[id].base.source, context)) && nonnegative(scalar(profile.profile?.gold)) &&
        nonnegative(scalar(profile.profile?.yuanbao)) && validSource(source(profile.profile.gold?.source), context) &&
        validSource(source(profile.profile.yuanbao?.source), context) &&
        currentAbsoluteSourceAfterBaseline(profile.completeBagFingerprint, profile.profile.gold.source, context) &&
        currentAbsoluteSourceAfterBaseline(profile.completeBagFingerprint, profile.profile.yuanbao.source, context);
      if (!currentSnapshotValid) return wait('ART_CURRENT_NEED_ABSOLUTE_SNAPSHOT_REQUIRED');
      const decisionGeneration = fingerprint({ version: 'art-current-need/v1', ownerRef: context.ownerRef, subjectRef: context.subjectRef,
        connectionEpoch: context.connectionEpoch, loginResponseRef: view.versionBinding?.loginResponseRef,
        officialUid: scalar(view.identity.uid), parentLifecycleRef: selected.parent.lifecycleRef, parentDecisionRef: selected.parent.decisionRef,
        netShortage: selected.parent.netShortage, recipeFingerprint,
        balances: ids.map(id => [id, profile.items[id].base.value, profile.items[id].basisRef]),
        profile: [scalar(profile.profile?.gold), scalar(profile.profile?.yuanbao)] });
      const parentPlan = sync(customerPlanning(context, input.config));
      const decision = parentPlan.decisions.find(one => one.lifecycleRef === selected.parent.lifecycleRef && one.npcId === selected.parent.npcId);
      const vase = vaseFor(view, context, selected.artId, selected.recipe.vaseId, scalar(view.identity.uid));
      if (!vase.known) return wait('ART_ORIGINAL_VASE_FACTS_UNPROVEN');
      const targetRef = 'flower-art:' + context.subjectRef + ':' + selected.artId;
      const needSemanticFingerprint = fingerprint({ decisionGeneration, targetRef, need: selected.parent.netShortage,
        parentLifecycleRef: selected.parent.lifecycleRef, recipeFingerprint, inputs: ids.map(id => [id, profile.items[id].base.value]) });
      const businessNeedRef = 'business-need:' + fingerprint({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
        featureId: ART_MAKE_CONTRACT.featureId, targetRef, parentLifecycleRef: selected.parent.lifecycleRef, recipeFingerprint });
      const snapshotState = { context, view, uid: scalar(view.identity.uid), profile,
        items: ids.map(itemId => ({ itemId, balance: profile.items[itemId] })),
        beforeProfile: { gold: scalar(profile.profile.gold), yb: scalar(profile.profile.yuanbao), source: source(profile.profile.gold.source),
          goldSource: source(profile.profile.gold.source), ybSource: source(profile.profile.yuanbao.source) },
        vase, parent: selected.parent, order: decision };
      const currentSnapshot = currentSnapshotFor(snapshotState);
      const currentNeed = { necessary: true, featureId: ART_MAKE_CONTRACT.featureId, targetRef, businessNeedRef, decisionGeneration,
        needRef: 'current-need:' + fingerprint([ART_MAKE_CONTRACT.featureId, targetRef, businessNeedRef]),
        semanticFingerprint: needSemanticFingerprint, basisRefs: [...new Set([view.identity.source.responseRef,
          ...ids.map(id => profile.items[id].basisRef), ...currentSnapshot.sourceProofs.map(one => one.responseRef)])] };
      const currentNeedClaim = currentNeedReconciler.claimCurrent({ context, currentSnapshot, currentNeed });
      if (currentNeedClaim?.accepted !== true) return wait(currentNeedClaim?.reasonCode || 'ART_CURRENT_NEED_CLAIM_FAILED');
      currentNeed.claimRef = currentNeedClaim.claimRef;
      const production = normal ? productionUnits.claim({ context, parent: selected.parent, recipeFingerprint, artId: selected.artId,
        operationId, authorization, decisionGeneration, currentCatalogSource: selected.recipe.source,
        currentRowProof: selected.recipe.rowProof }) : null;
      const quota = normal ? production?.row : claim(context, selected, recipeFingerprint, operationId, currentNeed, currentSnapshot);
      if (!quota) return wait(production?.reasonCode || authorization.reasonCode || 'ART_VERSIONED_RECIPE_COST_OBSERVATION_ALREADY_CLAIMED');
      const memberKey = 'art:' + quota.unit_ref;
      const reservations = selected.recipe.unitInputMultiset.map(one => sync(resources.reservationSpec({ context, itemId: one.itemId,
        quantity: one.occurrences, memberKey, lifecycleRef: quota.unit_ref })));
      const art = { artId: selected.artId, vaseId: selected.recipe.vaseId, flowersIds: [...selected.recipe.flowersIds], num: 1,
        parentNpcId: selected.parent.npcId, parentLifecycleRef: selected.parent.lifecycleRef,
        parentContentFingerprint: selected.parent.contentFingerprint, parentNeed: selected.parent.need,
        parentPolicyFingerprint: decision.policyFingerprint, acceptedDecisionRef: decision.decisionRef,
        customerCancelEpoch: input.config.featureCancelEpochs['order.customer'], demandRef: quota.demand_ref, unitRef: quota.unit_ref,
        officialUid: scalar(view.identity.uid), versionEvidence: clone(view.versionBinding), recipeFingerprint,
        recipeSourceProof: clone(selected.recipe.rowProof), catalogSource: clone(selected.recipe.source),
        keepPolicy: KEEP, beforeItems: ids.map(itemId => { const balance = profile.items[itemId]; return {
          itemId, quantity: balance.base.known ? balance.base.value : null, basisRef: balance.basisRef, source: source(balance.base.source) }; }),
        beforeProfile: { gold: scalar(profile.profile.gold), yb: scalar(profile.profile.yuanbao), source: source(profile.profile.gold.source),
          goldSource: source(profile.profile.gold.source), ybSource: source(profile.profile.yuanbao.source) },
        beforeVase: vase.before,
        ...(normal ? { costContract: clone(production.authorization.costContract), productionUnit: { unitRef: quota.unit_ref,
          ordinal: quota.ordinal, authorizationRef: production.authorization.authorizationRef,
          sourceCostReceiptRef: production.authorization.costContract.receiptRef,
          compatibilityLink: clone(production.authorization.compatibilityLink) } } : {
          costObservation: { kind: 'validation-single-cost-observation', unitRef: quota.unit_ref,
            quotaRef: quota.quota_ref, gameVersion: view.versionBinding.gameVersion, protocolVersion: view.versionBinding.protocolVersion, recipeFingerprint } }) };
      const proposal = { ...clone(context), operationId, proposalId: newId(), featureId: ART_MAKE_CONTRACT.featureId,
        scope: ART_MAKE_CONTRACT.scope, method: ART_MAKE_CONTRACT.method, semanticKey: 'art-make:' + quota.unit_ref,
        configRevision: input.config.savedRevision, featureCancelEpoch: input.config.featureCancelEpochs['art.make'],
        params: { vaseId: art.vaseId, flowersIds: [...art.flowersIds], num: 1 }, art: { ...art, currentNeed },
        targets: [{ memberKey, targetKind: ART_MAKE_CONTRACT.targetKind, targetRef: 'flower-art:' + context.subjectRef + ':' + art.artId,
          lifecycleRef: quota.unit_ref, targetFingerprint: artTargetFingerprint(art) }], resources: reservations,
        resourceBindings: reservations.map(one => ({ resourceKey: one.resourceKey, memberKey, quantity: one.quantity })) };
      const unresolved = sync(ledgerView.currentAdmission({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
        targetRefs: [targetRef] }))?.unresolvedOperations || [];
      const relatedUnknown = unresolved.map(one => sync(ledgerView.operation(one.operation_id))).find(old => old?.feature_id === proposal.featureId &&
        old.business_verdict === 'unknown' && old.targets?.some(target => (target.target_ref ?? target.original?.targetRef) === targetRef));
      proposal.traceId = relatedUnknown?.trace_id || relatedUnknown?.original?.traceId || relatedUnknown?.operation_id || businessNeedRef;
      proposal.paramsFingerprint = fingerprint(proposal.params);
      assertArtMakeProposal(proposal);
      const binding = bindingFor(proposal);
      if (normal) productionUnits.bind({ context, unitRef: quota.unit_ref, operationId, binding });
      else {
        const table = quota.source_kind === 'attempt' ? 'backend_art_cost_observation_attempts' : 'backend_art_cost_observation_quotas';
        const key = quota.source_kind === 'attempt' ? 'attempt_ref' : 'quota_ref';
        const updated = store.run(`UPDATE ${table} SET binding_json=?,binding_fingerprint=?,revision=revision+1,updated_at=? WHERE ${key}=? AND operation_id=? AND state=?`,
          canonical(binding), fingerprint(binding), store.nowIso(), quota.quota_ref, operationId, 'claimed');
        if (Number(updated.changes) !== 1) throw problem('ART_COST_QUOTA_BINDING_CAS_FAILED', '花艺单件观察身份未能持久绑定');
      }
      proposal.factBasis = readFactBasis({ proposal });
      const admitted = evaluateAdmission({ proposal, actor: context, factBasis: proposal.factBasis, boundary: 'before-prepare' });
      return admitted.allowed ? { state: 'proposals', proposals: [freeze(proposal)], factBasis: proposal.factBasis } : wait(admitted.reasonCode);
    });
  }
  function qualify({ proposal, actor, config, factBasis, boundary = 'before-prepare', ownReservation = null }) {
    const state = stateFor(proposal, config), currentBasis = basisFor(state);
    const allowed = sameCustomerContext(state.context, customerContext(actor)) && active(state.context) &&
      canonical(currentBasis) === canonical(factBasis) && !parentError(state, proposal) && !quotaError(state, proposal) &&
      !budgetError(proposal, budgetsFor(state, proposal, boundary), boundary) &&
      (boundary !== 'before-send' || ownReservation?.required === true && ownReservation.operationId === proposal.operationId);
    return { allowed: !!allowed, targetsCurrent: !!allowed, resourcesCurrent: !!allowed,
      reasonCode: allowed ? null : 'ART_CURRENT_PARENT_RECIPE_OR_INPUTS_CHANGED' };
  }
  const feature = Object.freeze({ featureId: 'art.make', consumedDomains: ['art-inputs', 'inventory', 'customer', 'customer-eligibility', 'profile', 'clock'], scopes: ['flower-art-make'], methods: ['flowerArt.makeFlowerArt'],
    currentNeedContracts: Object.freeze({ 'flowerArt.makeFlowerArt': Object.freeze({ path: 'art.currentNeed', required: true }) }),
    consumeCurrentNeed: ({ proposal }) => currentNeedReconciler.consumeCurrentNeed({ claimRef: proposal.art.currentNeed?.claimRef,
      operationId: proposal.operationId, decisionGeneration: proposal.art.currentNeed?.decisionGeneration,
      currentNeed: proposal.art.currentNeed, featureId: proposal.featureId }), release: 'validation-only',
    implementationVersion: 'art-necessary-single/cost-observation-and-observed-production/v2', contractRef: 'customer.md/necessary-art+official-480.0.27/single-cost-observation/v1',
    wakeKey: 'art.make', priority: 1, factDomains: ['customer', 'inventory', 'bag', 'land-domain'], factRequirements: [],
    operationContract: { ...ART_MAKE_CONTRACT, postRead: { ...ART_POST_READ, validateResponseCoverage: validateArtSnapshotCoverage },
      validateTargetVerification: validateArtTargetVerification }, assess, qualify, verify: verification.verify });
  function onSettled(input) {
    const { proposal, verification: result, operation } = input;
    assertArtMakeProposal(proposal);
    if (!proposal.art.costObservation) {
      const settled = productionUnits.settle({ proposal, operation, verification: result, binding: bindingFor(proposal) });
      sync(appendOutbox({ ownerRef: proposal.ownerRef, subjectRef: proposal.subjectRef, eventType: 'ArtNecessaryUnitAudited',
        eventKey: proposal.operationId, payload: { operationId: proposal.operationId, unitRef: settled.unitRef,
          parentLifecycleRef: settled.parentLifecycleRef, ordinal: settled.ordinal, verdict: result.verdict,
          originalConnectionEpoch: proposal.connectionEpoch, currentEffectsPublished: false } }));
      return;
    }
    const quota = quotaFor(customerContext(proposal), proposal.art.recipeFingerprint, proposal.art.costObservation);
    if (!quota || quota.operation_id !== proposal.operationId || quota.binding_fingerprint !== fingerprint(bindingFor(proposal)) ||
      operation?.operation_id !== proposal.operationId || operation.owner_ref !== proposal.ownerRef || operation.subject_ref !== proposal.subjectRef) {
      throw problem('ART_COST_SETTLEMENT_BINDING_INVALID', '原花艺成本观察结算不能转移到另一归属或单件');
    }
    let receipt = null;
    if (result.observedCostReceipt) {
      const { receiptRef, receiptFingerprint, ...body } = result.observedCostReceipt;
      if (result.verdict !== 'confirmed' || body.operationId !== proposal.operationId || body.unitRef !== proposal.art.unitRef ||
        body.quotaRef !== quota.quota_ref || body.recipeFingerprint !== proposal.art.recipeFingerprint || fingerprint(body) !== receiptFingerprint ||
        receiptRef !== 'art-observed-cost:' + receiptFingerprint) throw problem('ART_OBSERVED_COST_RECEIPT_INVALID', '真实单件成本回执与原配方不符');
      receipt = clone(result.observedCostReceipt);
    }
    const settled = { version: VERSION, operationId: proposal.operationId, quotaRef: quota.quota_ref, unitRef: quota.unit_ref,
      parentLifecycleRef: quota.parent_lifecycle_ref, demandRef: quota.demand_ref, recipeFingerprint: quota.recipe_fingerprint,
      verdict: result.verdict, reasonCode: result.reasonCode ?? null, originalConnectionEpoch: proposal.connectionEpoch,
      postReadRef: result.postReadRef ?? null, observedCostReceipt: receipt,
      quotaConsumedPermanently: true, resourceFootprintsRetained: true, resourceCoverageApplied: false,
      currentEffectsPublished: false };
    const hash = fingerprint(settled);
    if (quota.state === 'settled' && quota.receipt_fingerprint !== hash) throw problem('ART_COST_SETTLEMENT_CONFLICT', '原单件花艺结算回执不能覆盖');
    if (quota.state !== 'settled') {
      const table = quota.source_kind === 'attempt' ? 'backend_art_cost_observation_attempts' : 'backend_art_cost_observation_quotas';
      const key = quota.source_kind === 'attempt' ? 'attempt_ref' : 'quota_ref';
      store.run(`UPDATE ${table} SET state='settled',verdict=?,receipt_json=?,receipt_fingerprint=?,revision=revision+1,updated_at=? WHERE ${key}=? AND operation_id=? AND state!='settled'`,
        result.verdict, canonical(settled), hash, store.nowIso(), quota.quota_ref, proposal.operationId);
    }
    productionUnits.recordUnexpectedCostGuard({ ownerRef: proposal.ownerRef, subjectRef: proposal.subjectRef,
      recipeFingerprint: proposal.art.recipeFingerprint, operationId: proposal.operationId, unitRef: proposal.art.unitRef,
      verification: result, operation });
    event(quota, proposal.operationId, 'cost-observation-settled', settled);
    // No coverage or hold release is inferred here, including confirmed writes.
    // The later known-cost capability needs a separately admitted accounting contract.
    sync(appendOutbox({ ownerRef: proposal.ownerRef, subjectRef: proposal.subjectRef, eventType: 'ArtCostObservationAudited',
      eventKey: proposal.operationId, payload: { operationId: proposal.operationId, quotaRef: quota.quota_ref,
        unitRef: quota.unit_ref, verdict: result.verdict, costReceiptRef: receipt?.receiptRef ?? null,
        originalConnectionEpoch: proposal.connectionEpoch, currentEffectsPublished: false } }));
  }
  function publicView({ ownerRef, accountRef, subjectRef, context = null, config = null } = {}) {
    const rows = store.all(`SELECT quota_ref,account_ref,art_id,unit_ref,demand_ref,parent_lifecycle_ref,operation_id,state,
      game_version,protocol_version,recipe_fingerprint,verdict,receipt_fingerprint FROM backend_art_cost_observation_quotas
      WHERE owner_ref=? AND subject_ref=? ORDER BY quota_ref`, ownerRef, subjectRef);
    const attempts = store.all(`SELECT attempt_ref AS quota_ref,account_ref,art_id,unit_ref,demand_ref,parent_lifecycle_ref,operation_id,state,
      game_version,protocol_version,recipe_fingerprint,verdict,receipt_fingerprint,claim_ref,current_snapshot_ref,decision_generation
      FROM backend_art_cost_observation_attempts WHERE owner_ref=? AND subject_ref=? ORDER BY created_at,attempt_ref`, ownerRef, subjectRef);
    return freeze({ source: 'rebuilt-art', current: !!context && active(context) && context.ownerRef === ownerRef &&
      context.accountRef === String(accountRef) && context.subjectRef === subjectRef, phase: 'necessary-single-unit-with-versioned-observed-cost',
      automaticKnownCostProductionEnabled: true, onlyObservedVersionRecipeEligible: true, unrelatedRecipeFeeProven: false,
      costObservationQuotas: rows.map(clone), costObservationAttempts: attempts.map(clone), productionUnits: productionUnits.publicView({ ownerRef, subjectRef }),
      planning: context && config && active(context) && context.ownerRef === ownerRef && context.accountRef === String(accountRef) && context.subjectRef === subjectRef
        ? planning(context, config) : null });
  }
  function customerFeasibility(context, config) {
    const view = planning(context, config), rawItems = {}, costContracts = {};
    for (const entry of (view.customer?.entries || []).slice(0, 4096)) {
      if (!positive(entry.artId) || !entry.recipeKnown || !entry.recipe) continue;
      for (const itemId of [entry.artId, ...(entry.recipe.flowersIds || [])]) {
        if (positive(itemId) && !Object.hasOwn(rawItems, itemId)) rawItems[itemId] = sync(resources.balance({ context, itemId }));
      }
      const authority = productionUnits.costFor({ context, artId: entry.artId, recipeFingerprint: artRecipeFingerprint(entry.recipe),
        currentCatalogSource: entry.recipe.source, currentRowProof: entry.recipe.rowProof });
      if (authority.known === true) costContracts[entry.artId] = clone(authority.costContract);
    }
    const customerBatch = customerBatchInputs(context, config, view, rawItems);
    return freeze({ planning: view, rawItems, costContracts, customerBatch });
  }
  // Current accepted customer work is allocated against the complete queue
  // once, then translated to ingredient demand using the current recipe's
  // multiset. This report is read-only: it creates no production unit or hold.
  function customerBatchInputs(context, config, _existingPlanning = null, existingRawItems = null) {
    const stable = customerContext(context), art = config?.config?.art, orderPolicy = config?.config?.orders?.customer;
    const unavailable = reasonCode => freeze({ version: 'art-customer-batch-inputs/v2', current: false, reasonCode,
      context: stable, entries: [], inputDemands: [], rawItems: {} });
    if (!stable || !active(stable)) return unavailable('ART_CUSTOMER_BATCH_CONTEXT_NOT_CURRENT');
    if (art?.makeEnabled !== true || orderPolicy?.enabled !== true) return freeze({ version: 'art-customer-batch-inputs/v2',
      current: true, reasonCode: null, context: stable, entries: [], inputDemands: [], rawItems: {} });
    const customer = sync(customerPlanning(stable, config)), view = customer?.view, catalogView = catalog.forContext?.(stable) || catalog,
      rawItems = existingRawItems || {}, loginRef = view?.identity?.source?.responseRef, uid = scalar(view?.identity?.uid);
    if (!view?.current || !sameCustomerContext(view.context, stable) || view.identity?.verified !== true || !positive(uid) ||
        view.versionBinding?.loginResponseRef !== loginRef || customer.identities?.current !== true || customer.identities.complete !== true ||
        !sameCustomerContext(customer.identities.context, stable) || customer.eligibility?.current !== true ||
        customer.eligibility.customerOpen?.known !== true || customer.eligibility.customerOpen.value !== true ||
        !Array.isArray(customer.decisions) || customer.decisions.length > 4096) return unavailable('ART_CUSTOMER_BATCH_QUEUE_NOT_CURRENT');
    const accepted = customer.decisions.filter(one => one?.verdict === 'accepted').sort((a, b) =>
      (a.firstSeenSequence ?? Number.MAX_SAFE_INTEGER) - (b.firstSeenSequence ?? Number.MAX_SAFE_INTEGER) || a.npcId - b.npcId);
    const rows = [], inputDemands = [], availableStockByArt = new Map();
    for (const decision of accepted) {
      const identity = customer.identities.identities.find(one => one.npcId === decision.npcId), order = view.orders.find(one => one.npcId === decision.npcId);
      if (!identity || identity.current !== true || identity.identityKnown !== true || !sameCustomerContext(identity.context, stable) ||
          decision.identityKnown !== true || !sameCustomerContext(decision.context, stable) || decision.lifecycleRef !== identity.lifecycleRef ||
          decision.order?.contentFingerprint !== identity.contentFingerprint || decision.configRevision !== config.savedRevision ||
          decision.featureCancelEpoch !== config.featureCancelEpochs?.['order.customer'] || !positive(decision.order?.artId) ||
          !positive(decision.order?.need) || order?.current !== true || order.readable !== true || customerOrderFingerprint(order) !== identity.contentFingerprint)
        return unavailable('ART_CUSTOMER_BATCH_ACCEPTED_PARENT_UNPROVEN');
      const artId = decision.order.artId, recipeResult = sync(catalogView.recipe(artId));
      if (recipeResult?.known !== true || recipeResult.artId !== artId || !positive(recipeResult.vaseId) ||
          !Array.isArray(recipeResult.flowersIds) || recipeResult.flowersIds.length !== 3 || !recipeResult.flowersIds.every(positive) ||
          !Array.isArray(recipeResult.unitInputMultiset) || recipeResult.unitInputMultiset.length < 1 || recipeResult.unitInputMultiset.length > 3 ||
          recipeResult.unitInputMultiset.some(one => !positive(one.itemId) || !positive(one.occurrences)) ||
          recipeResult.source?.loginResponseRef !== loginRef || recipeResult.source?.dataSnapshotId !== view.versionBinding?.dataSnapshotId ||
          recipeResult.source?.gameVersion !== view.versionBinding?.gameVersion || recipeResult.source?.protocolVersion !== view.versionBinding?.protocolVersion ||
          recipeResult.rowProof?.loginResponseRef !== loginRef) return unavailable(recipeResult?.reasonCode || 'ART_CUSTOMER_BATCH_RECIPE_UNKNOWN');
      const recipe = { artId, vaseId: recipeResult.vaseId, flowersIds: [...recipeResult.flowersIds],
        unitInputMultiset: clone(recipeResult.unitInputMultiset) };
      const vase = vaseFor(view, stable, artId, recipe.vaseId, uid);
      // A missing/unknown vase only makes this parent ineligible for a batch;
      // it must not discard unrelated accepted parents from the current report.
      // The customer rejection path independently proves a complete-map vase absence.
      if (!vase.known || vase.owned !== true) continue;
      const product = rawItems[artId] || (rawItems[artId] = sync(resources.balance({ context: stable, itemId: artId })));
      if (!sameCustomerContext(product?.context, stable) || product.itemId !== artId || product.base?.known !== true ||
          !nonnegative(product.base.value) || !validSource(source(product.base.source), stable) || !reference(product.basisRef))
        return unavailable('ART_CUSTOMER_BATCH_PRODUCT_STOCK_UNKNOWN');
      if (!availableStockByArt.has(artId)) {
        const stockBudget = sync(resources.budget({ context: stable, itemId: artId, quantity: 0, keep: 0 }));
        if (stockBudget?.known !== true || !nonnegative(stockBudget.available)) return unavailable(stockBudget?.reasonCode || 'ART_CUSTOMER_BATCH_PRODUCT_BUDGET_UNKNOWN');
        availableStockByArt.set(artId, stockBudget.available);
      }
      const assignedStock = Math.min(decision.order.need, availableStockByArt.get(artId));
      availableStockByArt.set(artId, availableStockByArt.get(artId) - assignedStock);
      const actionableShortage = decision.order.need - assignedStock;
      // Queue allocation is a scheduling decision; it is not physical
      // consumption. A parent can be physically feasible even when an earlier
      // accepted parent has priority for the same finished stock.
      const physicalShortage = Math.max(0, decision.order.need - product.base.value);
      if (!actionableShortage) continue;
      const inputRows = [];
      for (const one of recipe.unitInputMultiset) {
        if (!Object.hasOwn(rawItems, one.itemId)) rawItems[one.itemId] = sync(resources.balance({ context: stable, itemId: one.itemId }));
        const balance = rawItems[one.itemId];
        if (!sameCustomerContext(balance?.context, stable) || balance.itemId !== one.itemId || balance.base?.known !== true ||
            !nonnegative(balance.base.value) || !validSource(source(balance.base.source), stable) || !reference(balance.basisRef))
          return unavailable('ART_CUSTOMER_BATCH_RAW_INPUT_UNKNOWN');
        inputRows.push({ itemId: one.itemId, occurrences: one.occurrences, required: one.occurrences * actionableShortage,
          physicalRequired: one.occurrences * physicalShortage, available: balance.base.value, basisRef: balance.basisRef,
          source: source(balance.base.source) });
      }
      if (!Number.isSafeInteger(actionableShortage * Math.max(...inputRows.map(one => one.occurrences)))) return unavailable('ART_CUSTOMER_BATCH_QUANTITY_OVERFLOW');
      const shortage = inputRows.filter(one => one.available < one.physicalRequired).map(one => ({ itemId: one.itemId, need: one.physicalRequired,
        available: one.available, shortfall: one.physicalRequired - one.available }));
      const row = { artId, npcId: decision.npcId, need: decision.order.need, finishedStock: product.base.value,
        productBasisRef: product.basisRef, productSource: source(product.base.source), netShortage: physicalShortage,
        actionableShortage, allocatedFinishedStock: assignedStock, parentLifecycleRef: identity.lifecycleRef,
        parentDecisionRef: decision.decisionRef, parentContentFingerprint: identity.contentFingerprint,
        lifecycleRef: identity.lifecycleRef, decisionRef: decision.decisionRef,
        contentFingerprint: identity.contentFingerprint, parentTargetRef: 'customer-order:' + stable.subjectRef + ':' + decision.npcId,
        targetRef: `customer-art-batch:${stable.subjectRef}:${identity.lifecycleRef}`, officialUid: uid,
        recipeFingerprint: artRecipeFingerprint(recipe),
        memberKey: 'customer-art-batch:' + fingerprint([stable.subjectRef, identity.lifecycleRef]),
        recipe, recipeSource: clone(recipeResult.source), vase: clone(vase.before),
        recipeRowProof: clone(recipeResult.rowProof), versionEvidence: clone(view.versionBinding),
        inputRows, shortage, sourceRef: order.source?.responseRef || null };
      rows.push(row);
      for (const input of inputRows) inputDemands.push({ kind: 'customer-art-batch', itemId: input.itemId, quantity: input.required,
        targetRef: row.targetRef, parentTargetRef: row.parentTargetRef, memberKey: row.memberKey,
        memberKey: row.memberKey, lifecycleRef: row.lifecycleRef, decisionRef: row.decisionRef,
        contentFingerprint: row.contentFingerprint, recipeFingerprint: artRecipeFingerprint(recipe), sourceRef: row.sourceRef });
    }
    return freeze({ version: 'art-customer-batch-inputs/v2', current: active(stable), reasonCode: null, context: stable,
      entries: rows, inputDemands, rawItems });
  }
  function dailyInputs(context, config, targetArtId = null, { postWrite = false } = {}) {
    return timedSyncPhase('art.dailyInputs', () => {
      // New work uses the live switch. A bounded read of an already answered
      // original art must survive that switch being turned off during postread.
      if (!active(context) || (!postWrite && config?.config?.art?.dailyMakeEnabled !== true))
        return freeze({ current: false, reasonCode: 'DAILY_ART_DISABLED', entries: [] });
      if (postWrite && !positive(targetArtId)) return freeze({ current: false, reasonCode: 'DAILY_ART_POSTWRITE_TARGET_REQUIRED', entries: [] });
      const view = timedSyncPhase('art.dailyInputs.readView', () => sync(readView(context)));
      const catalogView = timedSyncPhase('art.catalog', () => catalog.forContext?.(context) || catalog);
      const build = () => dailyInputsWithCatalog(context, config, targetArtId, view, catalogView);
      return typeof catalogView?.withSourceReadiness === 'function'
        ? catalogView.withSourceReadiness(build) : build();
    });
  }
  function dailyInputsWithCatalog(context, config, targetArtId, view, catalogView) {
    const identity = view?.identity, version = view?.versionBinding, uid = scalar(identity?.uid);
    const identitySource = source(identity?.source);
    if (view?.current !== true || identity?.verified !== true || !positive(uid) || identitySource?.kind !== 'response' ||
        identitySource.method !== 'index.login' || identitySource.connectionEpoch !== context.connectionEpoch ||
        version?.loginResponseRef !== identitySource.responseRef)
      return freeze({ current: false, reasonCode: 'DAILY_ART_LOGIN_OR_CATALOG_NOT_CURRENT', entries: [] });
    const art = config.config.art, mode = art.dailyMode;
    const artIds = positive(targetArtId) ? [targetArtId] : mode === 'chosen_arts' ? art.specifiedArts : catalogView.artIds?.();
    if (!['least_stock', 'chosen_quality', 'chosen_arts'].includes(mode) || !Array.isArray(artIds) || !artIds.length ||
        !artIds.every(positive) || new Set(artIds).size !== artIds.length || !positive(art.targetStock) || art.targetStock > 999 ||
        !positive(art.makeBatch) || art.makeBatch > 999 || mode === 'chosen_quality' && (!Array.isArray(art.dailyQualities) ||
          !art.dailyQualities.length || !art.dailyQualities.every(value => Number.isSafeInteger(value) && value >= 1 && value <= 5)))
      return freeze({ current: false, reasonCode: 'DAILY_ART_TARGET_CONFIGURATION_INVALID', entries: [] });
    const entries = [], pending = [], itemIds = new Set(), versionEvidence = clone(version);
    timedSyncPhase('art.dailyInputs.recipeEnumeration', () => {
      for (const artId of artIds) {
        const recipe = sync(catalogView.recipe(artId));
        if (recipe?.known !== true || recipe.artId !== artId || !recipe.rowProof || recipe.rowProof.loginResponseRef !== version.loginResponseRef ||
            recipe.source?.dataSnapshotId !== version.dataSnapshotId) {
          entries.push({ artId, known: false, reasonCode: recipe?.reasonCode || 'DAILY_ART_RECIPE_SOURCE_NOT_CURRENT' }); continue;
        }
        const outputItem = catalogView.item?.(artId);
        if (!outputItem || outputItem.id !== artId || outputItem.type !== 12 || !Number.isSafeInteger(outputItem.color) ||
            outputItem.color < 1 || outputItem.color > 5 || mode === 'chosen_quality' && !art.dailyQualities.includes(outputItem.color)) continue;
        const vase = vaseFor(view, context, artId, recipe.vaseId, uid);
        if (vase.known !== true || vase.owned !== true) {
          entries.push({ artId, quality: outputItem.color, known: false, reasonCode: vase.reasonCode || 'DAILY_ART_VASE_OWNERSHIP_UNKNOWN',
            recipe: null, vase: vase.known ? vase.before : null, balances: null, cost: null,
            officialUid: uid, loginResponseRef: version.loginResponseRef, dataSnapshotId: version.dataSnapshotId,
            versionEvidence, source: identitySource });
          continue;
        }
        pending.push({ artId, recipe, outputItem, vase });
        itemIds.add(artId);
        for (const one of recipe.unitInputMultiset) itemIds.add(one.itemId);
      }
    });
    const profile = timedSyncPhase('art.dailyInputs.profileBatch', () => pending.length
      ? sync(readProfileBatch({ context, itemIds: [...itemIds].sort((a, b) => a - b) })) : null);
    timedSyncPhase('art.dailyInputs.pendingEntryProofLoop', () => {
      for (const { artId, recipe, outputItem, vase } of pending) {
        const ids = [...new Set([artId, ...recipe.unitInputMultiset.map(one => one.itemId)])];
        const snapshotValid = profile?.current === true && sameCustomerContext(profile.context, context) && profile.identity?.verified === true &&
          scalar(profile.identity.uid) === uid && currentAbsoluteSourceAfterBaseline(profile.completeBagFingerprint, profile.completeBagFingerprint?.source, context) &&
          ids.every(id => profile.items?.[id]?.base?.known === true && nonnegative(profile.items[id].base.value) &&
            currentAbsoluteSourceAfterBaseline(profile.completeBagFingerprint, profile.items[id].base.source, context)) &&
          nonnegative(scalar(profile.profile?.gold)) && nonnegative(scalar(profile.profile?.yuanbao)) &&
          validSource(source(profile.profile?.gold?.source), context) && validSource(source(profile.profile?.yuanbao?.source), context) &&
          currentAbsoluteSourceAfterBaseline(profile.completeBagFingerprint, profile.profile.gold.source, context) &&
          currentAbsoluteSourceAfterBaseline(profile.completeBagFingerprint, profile.profile.yuanbao.source, context);
        // New daily batches are authorized by the current recipe, owned vase,
        // exact material multiset and shared budgets. Historical single-unit
        // observations are not a prerequisite for this separate v2 contract.
        const cost = snapshotValid ? { known: true, costContract: { version: 'art-daily/batched-inputs/v2',
          recipeFingerprint: artRecipeFingerprint(recipe), unitInputMultiset: recipe.unitInputMultiset.map(one => ({ ...one })) } }
          : { known: false, reasonCode: 'DAILY_ART_ABSOLUTE_ITEM_SNAPSHOT_REQUIRED' };
        // Source truth remains readable after the last required input is spent.
        // Affordability is evaluated separately at assessment/before-send.
        const known = snapshotValid && vase.known && vase.owned === true && cost?.known === true;
        entries.push({ artId, quality: outputItem.color, known, reasonCode: known ? null : vase.known && vase.owned !== true ? vase.reasonCode :
          cost?.reasonCode || 'DAILY_ART_INPUTS_OR_STOCK_NOT_CURRENT',
          recipe: known ? { artId, vaseId: recipe.vaseId, flowersIds: [...recipe.flowersIds], unitInputMultiset: recipe.unitInputMultiset,
            quality: outputItem.color, outputItemRow: recipe.outputItemRow,
            recipeFingerprint: artRecipeFingerprint(recipe), rowProof: recipe.rowProof, catalogSource: recipe.source } : null,
          vase: known ? vase.before : null, balances: known ? Object.fromEntries(ids.map(id => [id, profile.items[id].base])) : null,
          beforeProfile: known ? { gold: scalar(profile.profile.gold), yuanbao: scalar(profile.profile.yuanbao),
            goldSource: source(profile.profile.gold.source), yuanbaoSource: source(profile.profile.yuanbao.source) } : null,
          cost: known ? cost : null,
          officialUid: uid, loginResponseRef: version.loginResponseRef, dataSnapshotId: version.dataSnapshotId,
          versionEvidence, source: identitySource });
      }
    });
    return timedSyncPhase('art.dailyInputs.finalFreeze', () => freeze({ current: active(context) && view?.current === true, context: customerContext(context), entries,
      source: identitySource, officialUid: uid, dataSnapshotId: version.dataSnapshotId, loginResponseRef: version.loginResponseRef,
      configRevision: config.savedRevision, cancelEpoch: config.featureCancelEpochs?.['art.daily'] ?? null }));
  }
  function firstRewardBalances(context, itemIds) {
    const stable = customerContext(context), view = stable && sync(readView(stable)), identity = view?.identity,
      version = view?.versionBinding, uid = scalar(identity?.uid);
    if (!stable || !active(stable) || view?.current !== true || identity?.verified !== true || !positive(uid) ||
        identity.source?.method !== 'index.login' || identity.source?.connectionEpoch !== stable.connectionEpoch ||
        version?.loginResponseRef !== identity.source.responseRef || !Array.isArray(itemIds) || !itemIds.every(positive)) return null;
    const currencyFields = { 1: 'yuanbao', 11: 'gold' }, currencyIds = itemIds.filter(id => currencyFields[id]);
    const profile = currencyIds.length ? sync(readProfile({ context: stable, itemIds: [...new Set(currencyIds)] })) : null;
    if (currencyIds.length && (profile?.current !== true || !sameCustomerContext(profile.context, stable) ||
        profile.identity?.verified !== true || scalar(profile.identity.uid) !== uid ||
        !currentAbsoluteSourceAfterBaseline(profile.completeBagFingerprint, profile.completeBagFingerprint?.source, stable))) return null;
    const balances = [];
    for (const itemId of [...new Set(itemIds)]) {
      const field = currencyFields[itemId];
      if (field) {
        const cell = profile.profile?.[field], observedSource = source(cell?.source);
        if (!knownCustomerCell(cell) || !nonnegative(cell.value) || !currentAbsoluteSourceAfterBaseline(profile.completeBagFingerprint, cell.source, stable)) return null;
        balances.push({ itemId, value: cell.value, basisRef: observedSource.responseRef,
          source: observedSource, resourceKind: 'profile', field });
      } else {
        const balance = sync(resources.balance({ context: stable, itemId }));
        const observedSource = source(balance?.base?.source);
        if (!sameCustomerContext(balance?.context, stable) || balance.itemId !== itemId || balance.base?.known !== true ||
            !nonnegative(balance.base.value) || !validSource(observedSource, stable) || observedSource.requestSequence < identity.source.requestSequence ||
            !reference(balance.basisRef)) return null;
        balances.push({ itemId, value: balance.base.value, basisRef: balance.basisRef, source: observedSource, resourceKind: 'bag' });
      }
    }
    return freeze({ current: true, context: stable, officialUid: uid, loginResponseRef: identity.source.responseRef,
      dataSnapshotId: version.dataSnapshotId, balances });
  }
  function firstRewardInputs(context, readShareOpen = readShareEligibility) {
    const stable = customerContext(context), unavailable = reasonCode => freeze({ current: false, reasonCode, context: stable, entries: [] });
    if (!stable || !active(stable)) return unavailable('ART_FIRST_REWARD_CONTEXT_NOT_CURRENT');
    const view = sync(readView(stable)), catalogView = catalog.forContext?.(stable) || catalog;
    const identity = view?.identity, version = view?.versionBinding, uid = scalar(identity?.uid), art = view?.artEligibilityInputs;
    const loginSource = identity?.source;
    if (view?.current !== true || identity?.verified !== true || !positive(uid) || loginSource?.kind !== 'response' ||
        loginSource.method !== 'index.login' || loginSource.connectionEpoch !== stable.connectionEpoch || version?.loginResponseRef !== loginSource.responseRef ||
        !sameCustomerContext(view.context, stable)) return unavailable('ART_FIRST_REWARD_LOGIN_NOT_CURRENT');
    const flower = art?.flowerArt, makeList = flower?.makeList;
    const vases = art?.vases?.map, collect = art?.collectRwd, collectMap = collect?.map;
    const artCurrent = flower?.domain?.current === true && knownCustomerCell(flower.domain) && flower.uidMatchesCurrentLogin === true &&
      scalar(flower.uid) === uid && makeList?.current === true && knownCustomerCell(makeList) && makeList.value?.complete === true &&
      Array.isArray(makeList.value.entries) && !makeList.value.truncated;
    if (!artCurrent || vases?.current !== true || !knownCustomerCell(vases) || vases.complete !== true || vases.truncated === true ||
        !Array.isArray(vases.entries)) return unavailable('ART_FIRST_REWARD_ART_OR_VASE_SOURCE_NOT_CURRENT');
    const collectCurrent = collect?.domain?.current === true && knownCustomerCell(collect.domain) && collectMap?.current === true &&
      knownCustomerCell(collectMap) && collectMap.sourceProvidedMapComplete === true && collectMap.decodedComplete === true;
    const type13Present = collectCurrent && collect.type13Present === true;
    const albumClaimList = type13Present && collect.uidMatchesCurrentLogin === true && scalar(collect.uid) === uid &&
      collect.artCreateRwdList?.current === true && knownCustomerCell(collect.artCreateRwdList) && collect.artCreateRwdList.value?.complete === true
        ? collect.artCreateRwdList.value.entries : collectCurrent && !type13Present && collect.artCreateRwdListDefault?.current === true ? [] :
          type13Present && collect.uidMatchesCurrentLogin === true && scalar(collect.uid) === uid && collect.artCreateRwdList?.presence === 'missing'
            ? [] : null;
    const rawShareClaims = flower.sRecvList;
    const shareClaimList = rawShareClaims?.current === true && knownCustomerCell(rawShareClaims) && Array.isArray(rawShareClaims.value) &&
      rawShareClaims.value.length <= 4096 && rawShareClaims.value.every(positive)
      ? rawShareClaims.value : flower.sRecvListDefault?.current === true ? [] : null;
    const share = catalogView.share?.(6) || null, shareMap = art?.shareTot?.map, shareDomain = art?.shareTot?.domain;
    const shareMapCurrent = shareDomain?.current === true && knownCustomerCell(shareDomain) && shareMap?.current === true &&
      knownCustomerCell(shareMap) && shareMap.sourceProvidedMapComplete === true;
    const shareCounter = shareMapCurrent ? shareMap.entries?.['6'] || null : null;
    const quotaLimit = share?.limit, shareDay = share?.limitType === 1 ? readShareOfficialDay?.(stable) || null : null,
      shareCounterOwned = shareCounter?.current === true && knownCustomerCell(shareCounter) &&
        shareCounter.value?.uid?.value === uid && shareCounter.value?.tmpId?.value === 6 && knownCustomerCell(shareCounter.value.recvCnt),
      memberUTime = shareCounter?.value?.uTime,
      dayCurrent = share?.limitType !== 1 || shareDay?.current === true && shareDay.officialDay?.known === true &&
        shareDay.officialDay.source?.responseRef === loginSource.responseRef && shareDay.officialDay.source?.connectionEpoch === stable.connectionEpoch &&
        Number.isSafeInteger(shareDay.officialDay.startMs) && Number.isSafeInteger(shareDay.officialDay.endMs) &&
        clock(stable.subjectRef)?.connectionEpoch === stable.connectionEpoch && clock(stable.subjectRef)?.lowerBoundMs >= shareDay.officialDay.startMs &&
        clock(stable.subjectRef)?.upperBoundMs < shareDay.officialDay.endMs,
      quotaRecvCount = shareMapCurrent && !shareCounter ? 0 : shareCounterOwned && (share?.limitType !== 1 ||
        dayCurrent && knownCustomerCell(memberUTime) && memberUTime.value <= clock(stable.subjectRef).upperBoundMs)
        ? share?.limitType === 1 && memberUTime.value < shareDay.officialDay.startMs ? 0 : shareCounter.value.recvCnt.value : null;
    const shareOpen = readShareOpen?.(stable, share?.openId) || null;
    const changeVideoOpen = readShareOpen?.(stable, 'shareChangeVideo') || null;
    const shareQuotaKnown = positive(quotaLimit) && Number.isSafeInteger(quotaRecvCount) && quotaRecvCount >= 0;
    const requestOpen = shareOpen?.known === true && shareOpen.value === true;
    const quotaAvailable = shareQuotaKnown && quotaRecvCount < quotaLimit;
    const shareChangeVideoClosed = changeVideoOpen?.known === true && changeVideoOpen.value === false;
    const shareConversionKnown = share?.shareVideoConv === 0 || share?.shareVideoConv === 1 || typeof share?.shareVideoConv === 'boolean';
    const hasVideoProvided = !!share && Object.hasOwn(share, 'hasVideo');
    const shareHasVideoKnown = !hasVideoProvided || share.hasVideo === 0 || share.hasVideo === 1;
    const directRoute = shareHasVideoKnown && shareConversionKnown && requestOpen && quotaAvailable && shareChangeVideoClosed &&
      (!hasVideoProvided || share.hasVideo === 0) && (share.shareVideoConv === 1 || share.shareVideoConv === true);
    const routeEvidence = { current: shareQuotaKnown && requestOpen && changeVideoOpen?.known === true && shareConversionKnown && shareHasVideoKnown,
      kind: directRoute ? 'direct-request-only' : null, requestOnly: directRoute, sdkAvailability: 'unverified',
      direct: directRoute, shareOpen, changeVideoOpen, quota: { limit: positive(quotaLimit) ? quotaLimit : null,
        recvCount: Number.isSafeInteger(quotaRecvCount) ? quotaRecvCount : null, available: quotaAvailable,
        source: shareCounter?.source || (shareMapCurrent && !shareCounter ? shareMap.source : null) },
      row: share ? { id: share.id, hasVideo: share.hasVideo ?? null, shareVideoConv: share.shareVideoConv ?? null,
        limit: share.limit, limitType: share.limitType, openId: share.openId, hasVideoProvided, source: share.source } : null,
      reasonCode: !shareQuotaKnown ? 'ART_FIRST_SHARE_QUOTA_NOT_CURRENT' : !requestOpen ? 'ART_FIRST_SHARE_OPEN_NOT_CURRENT' :
        !changeVideoOpen?.known ? 'ART_FIRST_SHARE_ROUTE_GATE_NOT_CURRENT' : !shareConversionKnown || !shareHasVideoKnown ?
          'ART_FIRST_SHARE_ROUTE_SOURCE_INCOMPLETE' : !directRoute ? 'ART_FIRST_SHARE_DIRECT_ROUTE_UNAVAILABLE' : null };
    const entries = [], shareBalanceCache = new Map(), albumClaimsByVase = {};
    let albumSetCurrent = Array.isArray(albumClaimList), albumMapUnknownArts = [];
    const made = new Set(makeList.value.entries);
    for (const artId of [...made].sort((a, b) => a - b)) {
      if (!positive(artId)) { albumSetCurrent = false; continue; }
      const recipe = sync(catalogView.recipe(artId));
      const recipeCurrent = recipe?.known === true && recipe.artId === artId && positive(recipe.vaseId) &&
        recipe.source?.loginResponseRef === version.loginResponseRef && recipe.source?.dataSnapshotId === version.dataSnapshotId &&
        recipe.rowProof?.loginResponseRef === version.loginResponseRef;
      if (!recipeCurrent) { albumSetCurrent = false; albumMapUnknownArts.push(artId); }
      const vase = recipeCurrent ? vaseFor(view, stable, artId, recipe.vaseId, uid) : null;
      if (recipeCurrent && Array.isArray(albumClaimList) && !albumClaimList.includes(artId)) {
        const key = String(recipe.vaseId); (albumClaimsByVase[key] ||= []).push(artId);
      }
      let shareBalances = null;
      if (share?.id === 6 && Array.isArray(share.award) && share.award.length &&
          share.award.every(one => Array.isArray(one) && positive(one[0]) && positive(one[1]))) {
        const currentBalances = [];
        for (const [itemId] of share.award) {
          if (!shareBalanceCache.has(itemId)) {
            const balances = firstRewardBalances(stable, [itemId]);
            const balance = balances?.current ? balances.balances[0] : null;
            shareBalanceCache.set(itemId, balance || null);
          }
          const balance = shareBalanceCache.get(itemId);
          if (!balance) { currentBalances.length = 0; break; }
          currentBalances.push(clone(balance));
        }
        if (currentBalances.length === share.award.length) shareBalances = currentBalances;
      }
      const expCell = collect?.exp?.current === true && knownCustomerCell(collect.exp) ? collect.exp
        : collect?.expDefault?.current === true ? { presence: 'present', state: 'known', current: true, value: 0,
          source: collect.expDefault.source, derivedDefault: true, derivationRule: collect.expDefault.rule } : collect?.exp;
      const expSource = source(expCell?.source);
      const expKnown = expCell?.current === true && knownCustomerCell(expCell) && nonnegative(scalar(expCell)) && validSource(expSource, stable) &&
        expSource.method === loginSource.method && expSource.requestSequence === loginSource.requestSequence && expSource.responseRef === loginSource.responseRef;
      const item = catalogView.item?.(artId), shareEntryCurrent = item?.id === artId && item.type === 12 &&
        shareClaimList !== null && routeEvidence.current;
      entries.push({ artId, vaseId: recipeCurrent ? recipe.vaseId : null,
        recipeFingerprint: recipeCurrent ? artRecipeFingerprint(recipe) : null, recipe: recipeCurrent ? recipe.rowProof : null,
        officialUid: uid, loginResponseRef: loginSource.responseRef, versionEvidence: clone(version), dataSnapshotId: version.dataSnapshotId,
        exp: expKnown ? scalar(expCell) : null, expKnown, vase,
        albumClaimed: albumSetCurrent && recipeCurrent && Array.isArray(albumClaimList) ? albumClaimList.includes(artId) : null,
        shareClaimed: shareEntryCurrent ? shareClaimList.includes(artId) : null, shareEntryCurrent,
        shareEligible: shareEntryCurrent && routeEvidence.current && routeEvidence.direct && share?.id === 6 &&
          Array.isArray(share.award) && share.award.length > 0 && share.award.every(one => Array.isArray(one) && positive(one[0]) && positive(one[1])) &&
          shareBalances?.length === share.award.length,
        shareRoute: routeEvidence, shareRow: share, shareBalances, sourceRefs: { makeList: makeList.source, vase: vase?.before?.source || vase?.ownershipSource || null,
          albumHistory: type13Present ? collect?.artCreateRwdList?.source || null : collectMap?.source || collect?.domain?.source || null,
          shareHistory: flower.sRecvList?.current ? flower.sRecvList.source : flower.sRecvListDefault?.source || null,
          shareQuota: shareCounter?.source || (shareMapCurrent && !shareCounter ? shareMap.source : null),
          shareEligibility: { shareOpen: shareOpen?.source || null, changeVideoOpen: changeVideoOpen?.source || null },
          experience: expKnown ? source(expCell.source) : null } });
    }
    for (const ids of Object.values(albumClaimsByVase)) ids.sort((a, b) => a - b);
    const albumReady = Array.isArray(albumClaimList) && albumSetCurrent;
    const shareReady = Array.isArray(shareClaimList) && routeEvidence.current;
    return freeze({ current: active(stable) && view?.current === true, albumReady, albumSetCurrent,
      albumMapUnknownArts, albumClaimsByVase, shareReady, shareRoute: routeEvidence,
      albumReasonCode: albumReady ? null : !Array.isArray(albumClaimList) ? 'ART_FIRST_ALBUM_HISTORY_NOT_CURRENT' : 'ART_FIRST_ALBUM_CLAIM_SET_NOT_COMPLETE',
      shareReasonCode: shareReady ? null : !Array.isArray(shareClaimList) ? 'ART_FIRST_SHARE_HISTORY_NOT_CURRENT' : routeEvidence.reasonCode,
      context: stable, officialUid: uid, loginResponseRef: loginSource.responseRef,
      versionEvidence: clone(version), dataSnapshotId: version.dataSnapshotId, entries });
  }
  function customerBatchPostState(context, artId) {
    const stable = customerContext(context), view = stable && sync(readView(stable)), catalogView = stable && (catalog.forContext?.(stable) || catalog),
      version = view?.versionBinding, loginRef = view?.identity?.source?.responseRef, uid = scalar(view?.identity?.uid);
    if (!stable || !active(stable) || view?.current !== true || view.identity?.verified !== true || !positive(uid) ||
        view.identity.source?.method !== 'index.login' || view.identity.source?.connectionEpoch !== stable.connectionEpoch ||
        version?.loginResponseRef !== loginRef) return freeze({ current: false, reasonCode: 'ART_CUSTOMER_BATCH_POST_LOGIN_UNKNOWN', context: stable });
    const recipeResult = sync(catalogView.recipe(artId));
    if (recipeResult?.known !== true || recipeResult.artId !== artId || !positive(recipeResult.vaseId) ||
        recipeResult.source?.loginResponseRef !== loginRef || recipeResult.source?.dataSnapshotId !== version.dataSnapshotId ||
        recipeResult.source?.gameVersion !== version.gameVersion || recipeResult.source?.protocolVersion !== version.protocolVersion ||
        recipeResult.rowProof?.loginResponseRef !== loginRef) return freeze({ current: false, reasonCode: 'ART_CUSTOMER_BATCH_POST_RECIPE_UNKNOWN', context: stable });
    const vase = vaseFor(view, stable, artId, recipeResult.vaseId, uid);
    if (!vase.known || vase.owned !== true) return freeze({ current: false, reasonCode: vase.reasonCode || 'ART_CUSTOMER_BATCH_POST_VASE_UNKNOWN', context: stable });
    const itemIds = [...new Set([artId, ...recipeResult.unitInputMultiset.map(one => one.itemId)])], balances = {};
    for (const itemId of itemIds) {
      const balance = sync(resources.balance({ context: stable, itemId }));
      if (!sameCustomerContext(balance?.context, stable) || balance.itemId !== itemId || balance.base?.known !== true ||
          !nonnegative(balance.base.value) || !validSource(source(balance.base.source), stable) || !reference(balance.basisRef))
        return freeze({ current: false, reasonCode: 'ART_CUSTOMER_BATCH_POST_ITEM_UNKNOWN', context: stable });
      balances[itemId] = { value: balance.base.value, basisRef: balance.basisRef, source: source(balance.base.source) };
    }
    return freeze({ current: active(stable), context: stable, officialUid: uid, loginResponseRef: loginRef,
      versionEvidence: clone(version), recipe: { artId, vaseId: recipeResult.vaseId, flowersIds: [...recipeResult.flowersIds],
        unitInputMultiset: clone(recipeResult.unitInputMultiset), recipeFingerprint: artRecipeFingerprint(recipeResult),
        rowProof: clone(recipeResult.rowProof), source: clone(recipeResult.source) }, vase: clone(vase.before), balances });
  }
  return Object.freeze({ feature, readFactBasis, evaluateAdmission, onSettled, onCurrentVerified: () => {}, planning, publicView,
    customerFeasibility, customerBatchInputs: (context, config) => customerBatchInputs(context, config), customerBatchPostState, dailyInputs,
    dailyPostWriteInputs: (context, config, targetArtId) => dailyInputs(context, config, targetArtId, { postWrite: true }),
    firstRewardBalances, firstRewardInputs });
}
