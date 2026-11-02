import { clone, fingerprint, freeze } from '../../common.mjs';
import { customerContext, customerContextKey, knownCustomerCell, sameCustomerContext } from '../customer/wire-facts.mjs';
import { NORMAL_SYNC_METHODS } from '../../facts/normal-sync-contract.mjs';
import { timedSyncPhase } from '../../../performance-diagnostics.mjs';

const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const sync = value => {
  if (value?.then) { value.catch?.(() => {}); throw new TypeError('Art planning readers must be synchronous'); }
  return value;
};
const INPUT_METHODS = new Set([...NORMAL_SYNC_METHODS, 'index.reLogin', 'usr.lazySync']);
const artSourceProofValid = version => {
  const proof = version?.sourceProofs?.['art.make'];
  return version?.gameVersion === '480.0.27' && version?.protocolVersion === '480.0.0' ||
    proof?.supported === true && proof.sourceVersion === version?.gameVersion && proof.protocolVersion === version?.protocolVersion &&
      /^[a-f0-9]{64}$/.test(proof.gameSha256 || '') && /^[a-f0-9]{64}$/.test(proof.moSha256 || '');
};
const sourceRef = value => value ? { method: value.method ?? null, responseRef: value.responseRef ?? null, wireKey: value.wireKey ?? null,
  connectionEpoch: value.connectionEpoch ?? null, requestSequence: value.requestSequence ?? null, observationRef: value.observationRef ?? null } : null;

// The sole inventory reader is the existing shared resource service. This
// planner creates no operation, reservation, RPC args, reward claim or demand.
// G3B selects only one unit for a current accepted customer's net shortage.
export function createArtPlanning({ catalog, resources, isCurrent } = {}) {
  if (typeof catalog?.recipe !== 'function' || typeof resources?.budget !== 'function' ||
      typeof resources?.planningReader !== 'function' || typeof isCurrent !== 'function') {
    throw new TypeError('Art planning requires the audited recipe catalog, shared item budgets and current guard');
  }
  function plan(input = {}) {
    return timedSyncPhase('art.plan', () => {
      const context = customerContext(input.context);
      if (!context) throw new TypeError('Art planning requires a complete context');
      const activeCatalog = timedSyncPhase('art.catalog', () => catalog.forContext?.(context) ?? catalog);
      const run = () => planWithCatalog({ ...input, context }, activeCatalog);
      return typeof activeCatalog?.withSourceReadiness === 'function'
        ? activeCatalog.withSourceReadiness(run) : run();
    });
  }
  function planWithCatalog({ context: supplied, view, config, customerPlan = null, keepPolicy = null } = {}, activeCatalog) {
    const context = customerContext(supplied);
    if (!context) throw new TypeError('Art planning requires a complete context');
    const dto = config?.config ?? config, art = dto?.art;
    const configRevision = positive(config?.savedRevision) ? config.savedRevision : null;
    const artCancelEpoch = nonnegative(config?.featureCancelEpochs?.['art.make']) ? config.featureCancelEpochs['art.make'] : null;
    const customerCancelEpoch = nonnegative(config?.featureCancelEpochs?.['order.customer']) ? config.featureCancelEpochs['order.customer'] : null;
    const specified = Array.isArray(art?.specifiedArts) && art.specifiedArts.length <= 4096 && art.specifiedArts.every(positive) &&
      new Set(art.specifiedArts).size === art.specifiedArts.length ? [...art.specifiedArts] : null;
    const policyKnown = !!art && typeof art.makeEnabled === 'boolean' && configRevision !== null && artCancelEpoch !== null;
    const dailyMode = ['least_stock','chosen_quality','chosen_arts'].includes(art?.dailyMode) ? art.dailyMode : null;
    const dailyQualities = Array.isArray(art?.dailyQualities) && art.dailyQualities.every(one => Number.isSafeInteger(one) && one >= 1 && one <= 5)
      ? [...art.dailyQualities] : null;
    const replenishPolicyKnown = policyKnown && typeof art.autoReplenish === 'boolean' && typeof art.dailyMakeEnabled === 'boolean' && dailyMode !== null &&
      dailyQualities !== null && positive(art.targetStock) && art.targetStock <= 999 && positive(art.makeBatch) && art.makeBatch <= 999 &&
      (dailyMode !== 'chosen_arts' || specified !== null) && (dailyMode !== 'chosen_quality' || dailyQualities.length > 0);
    const policy = { known: policyKnown, replenishmentKnown: replenishPolicyKnown,
      firstRewardsKnown: typeof art?.firstAlbumClaim === 'boolean' && typeof art?.firstShareClaim === 'boolean', configRevision, artCancelEpoch, customerCancelEpoch,
      makeEnabled: typeof art?.makeEnabled === 'boolean' ? art.makeEnabled : null, specifiedArts: specified,
      autoReplenish: typeof art?.autoReplenish === 'boolean' ? art.autoReplenish : null, dailyMakeEnabled: typeof art?.dailyMakeEnabled === 'boolean' ? art.dailyMakeEnabled : null,
      dailyMode, dailyQualities, targetStock: positive(art?.targetStock) ? art.targetStock : null, makeBatch: positive(art?.makeBatch) ? art.makeBatch : null,
      firstAlbumClaim: typeof art?.firstAlbumClaim === 'boolean' ? art.firstAlbumClaim : null,
      firstShareClaim: typeof art?.firstShareClaim === 'boolean' ? art.firstShareClaim : null };
    const inputs = view?.artEligibilityInputs, officialUid = view?.identity?.uid?.value;
    const sourceCurrent = source => source?.kind === 'response' && source.transport === 'answered' && INPUT_METHODS.has(source.method) &&
      source.contextKey === customerContextKey(context) && source.connectionEpoch === context.connectionEpoch && positive(source.requestSequence) &&
      reference(source.responseRef) && artSourceProofValid(source.version) && source.version.protocolVersion === '480.0.0' &&
      source.version.source === 'normal-package-hop-and-matched-world-login/v1' && source.version.loginResponseRef === view?.identity?.source?.responseRef &&
      source.version.dataSnapshotId === view?.versionBinding?.dataSnapshotId;
    const currentCell = cell => cell?.current === true && knownCustomerCell(cell) && sourceCurrent(cell.source);
    const current = sync(isCurrent(context)) === true && sameCustomerContext(context, view?.context) && view?.identity?.verified === true &&
      currentCell(view.identity.uid) && positive(officialUid) && sourceCurrent(view.identity.source) && view.identity.source.method === 'index.login';
    // observations is a synchronous, read-only preview. Reuse only this
    // invocation's current land model and resource admission snapshot; no
    // closure escapes the returned plan or crosses an await/request boundary.
    let resourceReader = null;
    function reader() {
      if (!resourceReader) resourceReader = sync(resources.planningReader({ context }));
      return resourceReader;
    }
    const ownArtKnown = !!current && currentCell(inputs?.flowerArt?.domain) && currentCell(inputs?.flowerArt?.uid) &&
      inputs.flowerArt.uid.value === officialUid && inputs.flowerArt.uidMatchesCurrentLogin === true;
    function history(artId) {
      const cell = inputs?.flowerArt?.makeList, list = cell?.value;
      const known = ownArtKnown && currentCell(cell) && list?.complete === true && list.truncated === false && Array.isArray(list.entries) &&
        list.total === list.entries.length && list.entries.every(positive);
      return { known: !!known, alreadyMade: known ? list.entries.includes(artId) : null, source: sourceRef(cell?.source),
        meaning: 'first-make-history-not-product-quantity', reasonCode: known ? null : 'ART_FIRST_MAKE_HISTORY_UNKNOWN',
        rewardClaimProposed: false, shareProposed: false };
    }
    function vase(vaseId) {
      const domain = inputs?.vases?.domain, map = inputs?.vases?.map;
      const validMap = currentCell(domain) && currentCell(map) && map.sourceProvidedMapComplete === true && Array.isArray(map.entries);
      const row = validMap ? map.entries.find(one => one.vaseId === vaseId) : null;
      const rowKnown = !!row && row.current === true && sourceCurrent(row.source) && row.uidMatchesCurrentLogin === true && row.vaseIdMatchesKey === true &&
        knownCustomerCell(row.fields?.uid) && row.fields.uid.value === officialUid && knownCustomerCell(row.fields?.vaseId) && row.fields.vaseId.value === vaseId;
      const absentProven = !row && validMap && map.returnedComplete === true && map.truncated === false && map.total === map.entries.length;
      return { known: rowKnown || !!absentProven, owned: rowKnown ? true : absentProven ? false : null, vaseId,
        source: sourceRef(map?.source), rowSource: sourceRef(row?.source),
        reasonCode: rowKnown ? null : absentProven ? 'ART_REQUIRED_VASE_NOT_OWNED_CURRENT' : 'ART_REQUIRED_VASE_OWNERSHIP_UNKNOWN' };
    }
    function reserve(itemId, purpose, artId) {
      const value = typeof keepPolicy === 'function' ? sync(keepPolicy({ context: clone(context), itemId, artId, purpose })) : keepPolicy;
      return value?.known === true && nonnegative(value.keep) && reference(value.policyRef)
        ? { known: true, keep: value.keep, policyRef: value.policyRef } : { known: false, keep: null, policyRef: null };
    }
    function budget(itemId, quantity, purpose, artId) {
      const keep = reserve(itemId, purpose, artId);
      if (!keep.known) return { itemId, quantity, known: false, allowed: false, keepPolicy: keep, budget: null, reasonCode: 'ART_INPUT_KEEP_POLICY_UNKNOWN' };
      const result = sync(reader().budget({ itemId, quantity, keep: keep.keep, claimingOperationId: null, requireOwnReservation: false }));
      const known = result?.known === true && nonnegative(result.available) && reference(result.accountingVersion) && Array.isArray(result.basisRefs) && result.basisRefs.length > 0 && result.basisRefs.every(reference);
      return { itemId, quantity, known: !!known, allowed: !!known && result.allowed === true && result.available >= quantity,
        keepPolicy: keep, budget: result ? clone(result) : null, reasonCode: known ? result.allowed ? null : 'ART_WAIT_INPUT_KEEP_OR_RESERVATIONS' : result?.reasonCode || 'ART_INPUT_BALANCE_UNKNOWN' };
    }
    function inspect(artId, purpose, parent = null) {
      const recipe = sync(activeCatalog.recipe(artId)), firstMake = history(artId);
      const entry = { artId, purpose, parent, requestedUnits: 1, recipeKnown: recipe?.known === true, recipeSource: recipe?.source ?? null,
        sourceRows: recipe?.sourceRows ?? [], vase: null, inputs: [], firstMake, clientInputFeasible: false,
        actualCostContractKnown: recipe?.fees?.known === true, actualOutputProven: false, requiresFinalAdmission: true,
        reservationCreated: false, rpcCreated: false, rejectProposed: false, reasonCode: recipe?.reasonCode || null };
      if (!recipe?.known || recipe.artId !== artId || !artSourceProofValid({ gameVersion: recipe.source?.gameVersion,
          protocolVersion: recipe.source?.protocolVersion, sourceProofs: { 'art.make': recipe.source?.sourceProof } }) || recipe.source.protocolVersion !== '480.0.0' ||
          !positive(recipe.vaseId) || !Array.isArray(recipe.flowersIds) || recipe.flowersIds.length !== 3 || !recipe.flowersIds.every(positive) ||
          !Array.isArray(recipe.unitInputMultiset) || !recipe.unitInputMultiset.length ||
          recipe.unitInputMultiset.some(one => !positive(one.itemId) || !positive(one.occurrences))) {
        entry.reasonCode = recipe?.reasonCode || 'ART_RECIPE_UNREADABLE'; return entry;
      }
      entry.vase = vase(recipe.vaseId);
      entry.inputs = recipe.unitInputMultiset.map(one => budget(one.itemId, one.occurrences, 'art-input-flower', artId));
      entry.clientInputFeasible = current && ownArtKnown && entry.vase.known && entry.vase.owned === true && entry.inputs.every(one => one.known && one.allowed);
      entry.reasonCode = !current ? 'ART_CONTEXT_NOT_CURRENT' : !ownArtKnown ? 'ART_OWN_PROFILE_UID_UNKNOWN' : entry.vase.owned !== true ? entry.vase.reasonCode
        : entry.inputs.find(one => !one.known || !one.allowed)?.reasonCode || 'ART_SINGLE_UNIT_CLIENT_INPUTS_READY';
      // Recipe positions/multiplicity are facts for a later bounded builder;
      // no method/params/operation or item hold is produced here.
      entry.recipe = { artId, vaseId: recipe.vaseId, flowersIds: [...recipe.flowersIds], unitInputMultiset: clone(recipe.unitInputMultiset) };
      return entry;
    }
    const customer = { enabled: dto?.orders?.customer?.enabled === true, known: false, deliveryFirst: false, entries: [], selected: null,
      reasonCode: 'ART_CUSTOMER_DEMAND_NOT_OBSERVED' };
    const customerScope = current && customer.enabled && customerCancelEpoch !== null && customerPlan?.view?.current === true &&
      sameCustomerContext(context, customerPlan.view.context) && customerPlan.identities?.current === true && customerPlan.identities.complete === true &&
      sameCustomerContext(context, customerPlan.identities.context) && Array.isArray(customerPlan.identities.identities) && Array.isArray(customerPlan.decisions) && customerPlan.decisions.length <= 4096 &&
      Array.isArray(customerPlan.allocation?.entries) && customerPlan.allocation.known === true && sameCustomerContext(context, customerPlan.allocation.context) &&
      customerPlan.eligibility?.current === true && sameCustomerContext(context, customerPlan.eligibility.context) &&
      customerPlan.eligibility.customerOpen?.known === true && customerPlan.eligibility.customerOpen.value === true;
    if (customerScope) {
      customer.known = true; customer.deliveryFirst = !!customerPlan.allocation.selected;
      const accepted = customerPlan.decisions.filter(one => one?.verdict === 'accepted').sort((a, b) =>
        (a.firstSeenSequence ?? Number.MAX_SAFE_INTEGER) - (b.firstSeenSequence ?? Number.MAX_SAFE_INTEGER) || a.npcId - b.npcId);
      for (const decision of accepted) {
        const identity = customerPlan.identities.identities.find(one => one.npcId === decision.npcId);
        const allocation = customerPlan.allocation.entries.find(one => one.npcId === decision.npcId && one.decisionRef === decision.decisionRef);
        const valid = sameCustomerContext(context, decision.context) && decision.identityKnown === true && identity?.current === true && identity.identityKnown === true &&
          sameCustomerContext(context, identity.context) && sourceCurrent(identity.source) && decision.lifecycleRef === identity.lifecycleRef && decision.order?.contentFingerprint === identity.contentFingerprint &&
          decision.configRevision === configRevision && decision.featureCancelEpoch === customerCancelEpoch && positive(decision.firstSeenSequence) &&
          positive(decision.order?.artId) && positive(decision.order?.need) && allocation?.accepted === true && allocation.lifecycleRef === decision.lifecycleRef &&
          allocation.artId === decision.order.artId && allocation.need === decision.order.need && allocation.availableDeficitKnown === true &&
          nonnegative(allocation.availableDeficit) && allocation.availableDeficit <= decision.order.need;
        if (!valid) { customer.entries.push({ npcId: decision.npcId ?? null, lifecycleRef: decision.lifecycleRef ?? null,
          reasonCode: 'ART_ACCEPTED_PARENT_OR_NET_SHORTAGE_UNKNOWN', rejectProposed: false }); continue; }
        if (allocation.availableDeficit === 0) { customer.entries.push({ npcId: decision.npcId, lifecycleRef: decision.lifecycleRef,
          artId: decision.order.artId, netShortage: 0, reasonCode: 'ART_CUSTOMER_ALREADY_HAS_FINISHED_STOCK', rejectProposed: false }); continue; }
        const parent = { npcId: decision.npcId, lifecycleRef: decision.lifecycleRef, decisionRef: decision.decisionRef,
          contentFingerprint: identity.contentFingerprint, firstSeenSequence: decision.firstSeenSequence, need: decision.order.need,
          netShortage: allocation.availableDeficit, configRevision, customerCancelEpoch, source: sourceRef(identity.source) };
        const entry = inspect(decision.order.artId, 'accepted-customer-net-shortage', parent);
        customer.entries.push(entry);
        if (!customer.selected && !customer.deliveryFirst && policyKnown && art.makeEnabled && entry.clientInputFeasible) customer.selected = entry;
      }
      customer.reasonCode = customer.deliveryFirst ? 'ART_CUSTOMER_FINISHED_STOCK_DELIVERY_FIRST' : !policyKnown ? 'ART_CONFIG_UNREADABLE' : !art.makeEnabled ? 'ART_MAKING_NOT_ENABLED'
        : customer.selected ? 'ART_CUSTOMER_SINGLE_UNIT_READONLY_SELECTION' : 'ART_CUSTOMER_WAIT_DEPENDENT_FACTS_OR_NO_SHORTAGE';
    } else if (!customer.enabled) { customer.known = typeof dto?.orders?.customer?.enabled === 'boolean'; customer.reasonCode = 'ART_CUSTOMER_INTENT_DISABLED'; }
    const replenishment = { enabled: art?.dailyMakeEnabled === true && art?.autoReplenish === true, known: replenishPolicyKnown, phase: 'G4-readonly-preview', targetStock: policy.targetStock,
      selectionOrderImplemented: false, selected: null, entries: [], causesG3BCrafting: false };
    const dailyCandidates = dailyMode === 'chosen_arts' ? specified || [] : activeCatalog.artIds?.() || [];
    if (current && replenishPolicyKnown && art.dailyMakeEnabled && art.autoReplenish) for (const artId of dailyCandidates) {
      const recipe = sync(activeCatalog.recipe(artId));
      if (!recipe?.known || dailyMode === 'chosen_quality' && !dailyQualities.includes(recipe.quality)) continue;
      const stock = budget(artId, 0, 'art-product-replenishment', artId);
      const absolute = sync(reader().balance({ itemId: artId }));
      const actualStock = absolute?.base?.known === true && nonnegative(absolute.base.value) ? absolute.base.value : null;
      const shortage = actualStock !== null ? Math.max(0, art.targetStock - actualStock) : null;
      const entry = shortage > 0 ? inspect(artId, 'specified-stock-replenishment-preview') : { artId, purpose: 'specified-stock-replenishment-preview',
        firstMake: history(artId), reasonCode: shortage === 0 ? 'ART_REPLENISHMENT_TARGET_MET' : stock.reasonCode, rejectProposed: false };
      replenishment.entries.push({ ...entry, quality: recipe.quality, targetStock: art.targetStock, stock, actualStock, netShortage: shortage, executionImplemented: false });
    }
    const firstRewards = { phase: 'G4-independent-intent-only', albumClaimEnabled: policy.firstAlbumClaim, shareClaimEnabled: policy.firstShareClaim,
      automaticallyMakeUnseenRecipes: false, claimProposed: false, shareProposed: false, executionImplemented: false };
    const stillCurrent = current && sync(isCurrent(context)) === true;
    if (!stillCurrent) { customer.selected = null; customer.known = false; customer.reasonCode = 'ART_CONTEXT_REVOKED_DURING_PLANNING'; }
    const body = { version: 'art-planning/480.0.27/batched-daily-readonly-v2', context, current: stillCurrent, officialUid: positive(officialUid) ? officialUid : null,
      policy, customer, replenishment, firstRewards, selected: customer.selected,
      readOnly: true, writeEligible: false, rpcCreated: false, reservationCreated: false, generationCreated: false, rejectProposed: false,
      requiresOfficialCostContract: true, requiresFinalTargetAndResourceAdmission: true };
    return freeze({ ...body, planRef: 'art-plan:' + fingerprint(body) });
  }
  return Object.freeze({ plan });
}
