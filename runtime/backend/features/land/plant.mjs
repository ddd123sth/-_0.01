import { LAND_CONTRACT_REF, LAND_IMPLEMENTATION_VERSION, LAND_METHODS, configValue } from './rpc-contract.mjs';
import { selectPlantCandidates } from './plant-selection.mjs';
import { planStockCapacity } from './stock-budget.mjs';

export function createPlantFeature(ports) {
  async function assess(input) {
    const config = configValue(input.config);
    if (config.plantEnabled !== true) return { state: 'disabled', reasonCode: 'LAND_PLANT_DISABLED' };
    if (config.plantMode === 'chosen_flowers' && config.plantFlowerIds.length === 0 ||
        config.plantMode === 'chosen_quality' && config.plantQualities.length === 0) return { state: 'no-action', reasonCode: 'LAND_EXPLICIT_PLANT_POOL_EMPTY' };
    const prepared = await ports.prepareAssessment(input, 'plant');
    if (prepared.result) return prepared.result;
    const { view, groupView, catalog } = prepared;
    const selection = selectPlantCandidates({ view, config, catalog, resources: ports.resources, groups: groupView, context: input.context });
    if (!selection.known) return ports.wait(selection.reasonCode);
    let probes = 0;
    candidateLoop: for (const candidate of selection.candidates) {
      const estimate = ports.estimateYield({ context: input.context, view, groupView, flowerId: candidate.flowerId });
      const capacity = planStockCapacity({ flowerId: candidate.flowerId,
        target: config.plantMode === 'least_stock' ? 0 : config.restockCount, stockConfirmed: candidate.stockConfirmed,
        yieldExpected: estimate.expected, yieldReserved: estimate.reserved, groupCapacity: candidate.availableCapacity });
      if (!capacity.known || capacity.capacity === 0) continue;
      const excludedLands = [];
      for (let attempt = 0; attempt < 64; attempt += 1) {
        if (probes >= 64) break candidateLoop;
        const ids = ports.newProposalIds();
        const allocation = ports.groups.allocateEmpty({ context: input.context, flowerId: candidate.flowerId,
          capacity: capacity.capacity, configReceipt: input.config, ...ids, predictedYield: estimate.perPlot ?? null, excludeLandIds: excludedLands });
        if (!allocation) break candidateLoop;
        probes += 1;
        let proposal;
        try {
          proposal = ports.buildProposal({ input, featureId: 'plant', ids, land: allocation.land, stage: allocation.stage,
            groupRef: allocation.groupRef, groupMemberKey: allocation.member.memberKey, flowerId: candidate.flowerId,
            selectionConfig: config, poolFingerprint: selection.fingerprint });
        } catch (error) {
          if (error?.code !== 'LAND_CURRENT_NEED_NOT_CURRENT') throw error;
          ports.groups.cancelPlan({ context: input.context, operationId: ids.operationId, reasonCode: error.code });
          excludedLands.push(allocation.land.landId);
          continue;
        }
        const admission = ports.evaluateAdmission({ proposal, actor: input.context, factBasis: proposal.factBasis, boundary: 'before-prepare' });
        if (admission.allowed) return { state: 'proposals', proposals: [proposal], factBasis: proposal.factBasis, reasonCode: null };
        ports.groups.cancelPlan({ context: input.context, operationId: ids.operationId, reasonCode: admission.reasonCode });
        excludedLands.push(allocation.land.landId);
      }
    }
    return ports.wait(selection.reasonCode || 'LAND_PLANT_NO_CURRENT_CANDIDATE');
  }
  return Object.freeze({ featureId: 'plant', consumedDomains: ['land', 'cultivation', 'inventory'],
    currentNeedContracts: Object.freeze({ [LAND_METHODS.plant]: Object.freeze({ path: 'land.currentNeed', required: true }) }),
    consumeCurrentNeed: ({ proposal }) => ports.currentNeedReconciler.consumeCurrentNeed({ claimRef: proposal.land?.currentNeed?.claimRef,
      operationId: proposal.operationId, decisionGeneration: proposal.land?.currentNeed?.decisionGeneration,
      currentNeed: proposal.land?.currentNeed, featureId: proposal.featureId }),
    consumedDomainsFor: ({ config }) => config?.plantMode === 'chosen_top' ? ['land', 'land-top', 'cultivation', 'inventory'] : ['land', 'cultivation', 'inventory'],
    scopes: ['plant'], methods: [LAND_METHODS.plant], release: 'validation-only',
    implementationVersion: LAND_IMPLEMENTATION_VERSION, contractRef: LAND_CONTRACT_REF, wakeKey: 'plant',
    factDomains: ['land-domain', 'land', 'cultivate', 'bag', 'land-groups', 'land-top'], resourceKinds: ['item', 'land'],
    dependencyFeatures: ['harvest'], factRequirements: [], assess,
    qualify: input => ports.qualifyFeature('plant', input), verify: input => ports.verify(input) });
}
