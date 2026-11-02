import { LAND_CONTRACT_REF, LAND_IMPLEMENTATION_VERSION, LAND_METHODS, configValue } from './rpc-contract.mjs';

export function createHarvestFeature(ports) {
  async function assess(input) {
    if (configValue(input.config).harvestEnabled !== true) return { state: 'disabled', reasonCode: 'LAND_HARVEST_DISABLED' };
    const prepared = await ports.prepareAssessment(input, 'harvest');
    if (prepared.result) return prepared.result;
    let dueMs = null;
    for (const existing of prepared.groupView.groups) {
      const frozen = ports.groups.freezeHarvestRound({ context: input.context, groupRef: existing.groupRef, clock: ports.clock(input.context.subjectRef) });
      if (!frozen.ready) { if (Number.isSafeInteger(frozen.dueMs)) dueMs = Math.min(dueMs ?? frozen.dueMs, frozen.dueMs); continue; }
      const group = frozen.group;
      for (const member of group.round.members.filter(item => item.state === 'pending').sort((a, b) => a.landId - b.landId)) {
        if (group.members.find(original => original.memberKey === member.memberKey)?.currentBinding?.state === 'historical') continue;
        const land = prepared.view.lands[String(member.landId)];
        const stage = ports.lifecycles.stageFor({ land: { subjectRef: input.context.subjectRef, landId: member.landId }, action: 'harvest' });
        if (!stage.known || stage.lifecycleRef !== member.stageRef) continue;
        let proposal;
        try {
          proposal = ports.buildProposal({ input, featureId: 'harvest', land, stage, groupRef: group.groupRef,
            groupMemberKey: member.memberKey, roundRef: group.round.roundRef });
        } catch (error) {
          if (error?.code !== 'LAND_CURRENT_NEED_NOT_CURRENT') throw error;
          continue;
        }
        const admission = ports.evaluateAdmission({ proposal, actor: input.context, factBasis: proposal.factBasis, boundary: 'before-prepare' });
        if (admission.allowed) return { state: 'proposals', proposals: [proposal], factBasis: proposal.factBasis, reasonCode: null };
      }
    }
    return ports.wait(dueMs ? 'LAND_GROUP_MATURITY_PENDING' : 'LAND_HARVEST_NO_ELIGIBLE_ROUND', ports.clock(input.context.subjectRef), dueMs);
  }
  // Harvest admission reads a frozen land round, maturity clock and one land
  // reservation. It neither reads nor spends bag/itemExt balances. Its writes
  // STILL invalidate inventory for consumers such as plant/water/art/orders.
  return Object.freeze({ featureId: 'harvest', consumedDomains: ['land', 'clock'],
    currentNeedContracts: Object.freeze({ [LAND_METHODS.harvest]: Object.freeze({ path: 'land.currentNeed', required: true }) }),
    consumeCurrentNeed: ({ proposal }) => ports.currentNeedReconciler.consumeCurrentNeed({ claimRef: proposal.land?.currentNeed?.claimRef,
      operationId: proposal.operationId, decisionGeneration: proposal.land?.currentNeed?.decisionGeneration,
      currentNeed: proposal.land?.currentNeed, featureId: proposal.featureId }),
    scopes: ['harvest'], methods: [LAND_METHODS.harvest], release: 'validation-only',
    implementationVersion: LAND_IMPLEMENTATION_VERSION, contractRef: LAND_CONTRACT_REF, wakeKey: 'harvest',
    factDomains: ['land-domain', 'land', 'land-groups'], resourceKinds: ['land'], dependencyFeatures: ['plant', 'water'], factRequirements: [], assess,
    qualify: input => ports.qualifyFeature('harvest', input), verify: input => ports.verify(input) });
}
