import { LAND_ACCELERATION_METHODS, LAND_ACCELERATION_SCOPES } from './acceleration-contract.mjs';

export const LAND_ACCELERATION_IMPLEMENTATION = 'land-acceleration/1';
export const LAND_ACCELERATION_FEATURE_CONTRACT = 'land-acceleration/independent-opportunity/v1';

export function createLandAccelerationFeature(ports) {
  const modes = ['card', 'free'];
  const methods = modes.map(mode => LAND_ACCELERATION_METHODS[mode]);
  const scopes = modes.map(mode => LAND_ACCELERATION_SCOPES[mode]);
  const methodScopes = Object.fromEntries(modes.map(mode => [LAND_ACCELERATION_METHODS[mode], LAND_ACCELERATION_SCOPES[mode]]));
  const assessMode = mode => async input => {
    if (input.config?.config?.accelerationMode !== mode) return { state: 'disabled', reasonCode: 'LAND_ACCELERATION_MODE_DISABLED' };
    const prepared = await ports.prepareAssessment(input, 'land.acceleration');
    if (prepared.result) return prepared.result;
    const extension = ports.accelerationExtension(input.context);
    if (!extension) return ports.wait('LAND_ACCELERATION_EXTENSION_NOT_CURRENT');
    const clock = ports.clock(input.context.subjectRef);
    if (clock?.available !== true || !Number.isFinite(clock.nowMs) || !Number.isFinite(clock.uncertaintyMs) ||
        clock.uncertaintyMs < 0 || clock.connectionEpoch !== input.context.connectionEpoch) return ports.wait('LAND_ACCELERATION_CLOCK_NOT_CURRENT');
    const lowerNow = clock.nowMs - clock.uncertaintyMs, upperNow = clock.nowMs + clock.uncertaintyMs;
    const cutoffMs = mode === 'free' ? extension.thresholdSeconds * 1000 : 20 * 60 * 1000;
    let nextDueMs = null;
    const candidates = [];
    for (const land of Object.values(prepared.view.lands || {})) {
      const state = ports.landField(land, 'state'), due = ports.landField(land, 'nextTime');
      if (!land.current || land.status !== 'occupied' || state !== 2 || !Number.isSafeInteger(due) || due <= upperNow) continue;
      const conservativeRemaining = due - lowerNow;
      if (mode === 'free' && conservativeRemaining > cutoffMs) {
        const thresholdDue = due - cutoffMs + clock.uncertaintyMs;
        if (thresholdDue > clock.nowMs) nextDueMs = Math.min(nextDueMs ?? thresholdDue, thresholdDue);
        continue;
      }
      if (mode === 'card' && conservativeRemaining <= cutoffMs) {
        const naturalDue = due + clock.uncertaintyMs;
        if (naturalDue > clock.nowMs) nextDueMs = Math.min(nextDueMs ?? naturalDue, naturalDue);
        continue;
      }
      const stage = ports.accelerationStage(input.context, land);
      if (!stage?.known) continue;
      candidates.push({ land, stage, due });
    }
    candidates.sort((a, b) => a.due - b.due || a.land.landId - b.land.landId);
    for (const { land, stage, due } of candidates) {
      let reservation = null;
      if (mode === 'card') {
        const budget = ports.resources.budget({ context: input.context, itemId: extension.cardItemId,
          keep: input.config.config.speedCardKeep, quantity: 1, claimingOperationId: null, requireOwnReservation: false });
        if (!budget.known || !budget.allowed) continue;
        reservation = ports.resources.reservationSpec({ context: input.context, itemId: extension.cardItemId,
          quantity: 1, memberKey: 'land-acceleration:' + land.landId + ':' + stage.lifecycleRef, lifecycleRef: stage.lifecycleRef });
      }
      const proposal = ports.buildAccelerationProposal({ input, mode, land, stage, extension, reservation,
        trustedClock: { nowMs: clock.nowMs, uncertaintyMs: clock.uncertaintyMs, revision: clock.revision }, due });
      const admission = ports.evaluateAccelerationAdmission({ proposal, actor: input.context, boundary: 'before-prepare' });
      if (admission.allowed) return { state: 'proposals', proposals: [proposal], factBasis: proposal.factBasis, reasonCode: null };
    }
    if (nextDueMs !== null) return ports.wait('LAND_ACCELERATION_NOT_IN_WINDOW', clock, nextDueMs);
    return ports.wait(candidates.length ? 'LAND_ACCELERATION_RESOURCE_OR_ADMISSION_WAIT' : 'LAND_ACCELERATION_NO_CURRENT_CANDIDATE');
  };
  const scheduleUnits = modes.map(mode => Object.freeze({ scheduleKey: `land.acceleration.${mode}`,
    wakeKey: `land.acceleration.${mode}`, mode, assess: assessMode(mode) }));
  return Object.freeze({ featureId: 'land.acceleration', consumedDomains: ['land', 'inventory', 'clock'],
    consumedDomainsFor: ({ method, config, proposal } = {}) => method === LAND_ACCELERATION_METHODS.free ||
      (proposal?.acceleration?.mode ?? config?.accelerationMode ?? config?.land?.accelerationMode) === 'free' ? ['land', 'clock'] : ['land', 'inventory', 'clock'], scopes, methods, methodScopes,
    allowedScopes: scopes, allowedMethods: methods, release: 'validation-only',
    implementationVersion: LAND_ACCELERATION_IMPLEMENTATION, contractRef: LAND_ACCELERATION_FEATURE_CONTRACT,
    scheduleUnits, factDomains: ['land-domain', 'land', 'bag', 'item-ext'], resourceKinds: ['item', 'land'],
    currentNeedContracts: Object.freeze(Object.fromEntries(methods.map(method => [method,
      Object.freeze({ path: 'land.currentNeed', required: true })]))),
    consumeCurrentNeed: ({ proposal }) => ports.consumeCurrentNeed(proposal),
    assess: assessMode('card'), qualify: input => ports.qualifyAcceleration(input), verify: input => ports.verifyAcceleration(input) });
}
