import { LAND_CONTRACT_REF, LAND_IMPLEMENTATION_VERSION, LAND_METHODS, configValue, field, landEntries } from './rpc-contract.mjs';

export function createWaterFeature(ports) {
  async function assess(input) {
    const config = configValue(input.config);
    if (config.waterEnabled !== true) return { state: 'disabled', reasonCode: 'LAND_WATER_DISABLED' };
    const prepared = await ports.prepareAssessment(input, 'water');
    if (prepared.result) return prepared.result;
    const budget = ports.resources.budget({ context: input.context, itemId: 7, keep: config.keepWater, quantity: 1,
      claimingOperationId: null, requireOwnReservation: false });
    if (!budget.known || !budget.allowed) return ports.wait(budget.reasonCode || 'LAND_WATER_BUDGET_INSUFFICIENT',
      ports.clock(input.context.subjectRef), budget.nextIncreaseOfficialMs ?? null);
    const members = prepared.groupView.groups.filter(group => group.currentBinding?.state !== 'historical').flatMap(group =>
      group.members.filter(member => member.currentBinding?.state !== 'historical').map(member => ({ group, member })));
    const candidates = landEntries(prepared.view).filter(land => land.current && field(land, 'state') === 1)
      .map(land => ({ land, binding: members.find(item => item.member.landId === land.landId &&
        (item.member.state === 'confirmed' || item.member.state === 'unknown' && item.member.currentUnknownFeature === 'water')) }))
      .filter(item => item.binding).sort((a, b) =>
        (a.binding.member.needWaterObservedAt || '').localeCompare(b.binding.member.needWaterObservedAt || '') || a.land.landId - b.land.landId);
    for (const { land, binding } of candidates) {
      const stage = ports.lifecycles.stageFor({ land: { subjectRef: input.context.subjectRef, landId: land.landId }, action: 'water' });
      if (!stage.known) continue;
      let proposal;
      try {
        proposal = ports.buildProposal({ input, featureId: 'water', land, stage,
          groupRef: binding.group.groupRef, groupMemberKey: binding.member.memberKey });
      } catch (error) {
        if (error?.code !== 'LAND_CURRENT_NEED_NOT_CURRENT') throw error;
        continue;
      }
      const admission = ports.evaluateAdmission({ proposal, actor: input.context, factBasis: proposal.factBasis, boundary: 'before-prepare' });
      if (admission.allowed) return { state: 'proposals', proposals: [proposal], factBasis: proposal.factBasis, reasonCode: null };
    }
    return ports.wait(candidates.length ? 'LAND_WATER_TARGETS_WAITING_EVIDENCE' : 'LAND_NO_CURRENT_NEED_WATER');
  }
  return Object.freeze({ featureId: 'water', consumedDomains: ['land', 'inventory', 'clock', 'profile'],
    currentNeedContracts: Object.freeze({ [LAND_METHODS.water]: Object.freeze({ path: 'land.currentNeed', required: true }) }),
    consumeCurrentNeed: ({ proposal }) => ports.currentNeedReconciler.consumeCurrentNeed({ claimRef: proposal.land?.currentNeed?.claimRef,
      operationId: proposal.operationId, decisionGeneration: proposal.land?.currentNeed?.decisionGeneration,
      currentNeed: proposal.land?.currentNeed, featureId: proposal.featureId }),
    scopes: ['water'], methods: [LAND_METHODS.water], release: 'validation-only',
    implementationVersion: LAND_IMPLEMENTATION_VERSION, contractRef: LAND_CONTRACT_REF, wakeKey: 'water',
    factDomains: ['land-domain', 'land', 'bag', 'item-ext', 'land-groups'], resourceKinds: ['item', 'land'],
    dependencyFeatures: ['plant', 'harvest'], factRequirements: [], assess,
    qualify: input => ports.qualifyFeature('water', input), verify: input => ports.verify(input) });
}
