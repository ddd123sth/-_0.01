import { freeze } from '../../common.mjs';
import { assertSingleProposal, field, landFieldStates, proposalContext, safeSource } from './rpc-contract.mjs';

export function createLandVerification({ projection, lifecycles, isCurrent, readMethodGuard = () => null }) {
  return async function verify({ proposal, response, connection, signal }) {
    assertSingleProposal(proposal);
    const context = proposalContext(proposal), target = proposal.targets[0];
    const result = (verdict, reasonCode, after = null, postRead = null, effect = null) => freeze({ verdict,
      verificationVersion: 'land-single-verification/v1', reasonCode,
      member: { memberKey: target.memberKey, verdict, reasonCode },
      postReadRef: postRead?.responseRef ?? null, postRead: postRead ? safeSource(postRead) : null, targetEffect: effect,
      evidence: { version: 'land-single-verification/v1', reasonCode, targetRef: target.targetRef, lifecycleRef: target.lifecycleRef,
        before: proposal.land.before, answer: safeSource(response), rejected: response?.rejected === true,
        after: after ? { status: after.status, semanticVersion: after.semanticVersion,
          flowerId: field(after, 'flowerId') ?? null, state: field(after, 'state') ?? null,
          harvestCnt: field(after, 'harvestCnt') ?? null, plantTime: field(after, 'plantTime') ?? null,
          fieldStates: landFieldStates(after), source: safeSource(after.source) } : null, postRead: postRead ? safeSource(postRead) : null },
      resourceResolutions: proposal.resources.map(resource => ({ resourceKey: resource.resourceKey,
        state: verdict === 'confirmed' && resource.resourceKind === 'land' ? 'released' : 'historical_footprint',
        basisRefs: postRead?.responseRef ? [postRead.responseRef] : [], coverageRef: null })) });
    if (!isCurrent(context) || !connection?.isOpen()) return result('unknown', 'LAND_VERIFY_CONTEXT_REVOKED');
    let postRead;
    try { signal?.throwIfAborted(); postRead = await connection.read('usrLand.refresh', {}); }
    catch (error) { return result('unknown', String(error?.code || 'LAND_POST_READ_FAILED')); }
    if (!isCurrent(context)) return result('unknown', 'LAND_VERIFY_CONTEXT_REVOKED');
    if (postRead.connectionEpoch !== response.connectionEpoch || postRead.connectionEpoch !== context.connectionEpoch ||
        !Number.isSafeInteger(postRead.requestSequence) || !Number.isSafeInteger(response.requestSequence) ||
        postRead.requestSequence <= response.requestSequence || !postRead.responseRef) return result('unknown', 'LAND_POST_READ_NOT_AFTER_WRITE');
    const view = projection.view(context), after = view.lands[String(proposal.params.landId)];
    if (!view.current || view.identity?.verified !== true || !after?.current || after.source?.responseRef !== postRead.responseRef) {
      return result('unknown', 'LAND_POST_READ_TARGET_NOT_COVERED', after, postRead);
    }
    const before = proposal.land.before, flower = field(after, 'flowerId'), state = field(after, 'state');
    const life = lifecycles.get({ subjectRef: context.subjectRef, landId: proposal.params.landId });
    const sameCrop = life?.cropRef === before.cropRef && flower === before.flowerId &&
      (before.plantTime === null || field(after, 'plantTime') === before.plantTime);
    let confirmed = false, effect = null;
    if (proposal.featureId === 'plant') {
      confirmed = before.status === 'empty' && after.status === 'occupied' && flower === proposal.params.flowerId &&
        [1, 2, 3].includes(state) && typeof life?.cropRef === 'string' && life.cropRef !== before.cropRef;
      effect = confirmed ? { cropRef: life.cropRef, flowerId: flower, empty: false } : null;
    } else if (proposal.featureId === 'water') {
      confirmed = before.state === 1 && sameCrop && [2, 3].includes(state);
      effect = confirmed ? { cropRef: life.cropRef, empty: false } : null;
    } else {
      const count = field(after, 'harvestCnt');
      const advanced = sameCrop && Number.isSafeInteger(before.harvestCnt) && Number.isSafeInteger(count) && count === before.harvestCnt + 1;
      const emptied = before.status === 'occupied' && after.status === 'empty' && response.rejected !== true;
      confirmed = advanced || emptied;
      effect = confirmed ? { cropRef: life?.cropRef ?? before.cropRef, empty: emptied, harvestCnt: count ?? null } : null;
    }
    // A contradictory reject and changed target is retained, never silently
    // turned into either all-success or zero-side-effect failure.
    if (response.rejected === true) return result('unknown', confirmed ? 'LAND_REJECT_CONFLICTS_WITH_TARGET_CHANGE' : 'LAND_REJECTION_EFFECT_UNPROVEN', after, postRead);
    const costGuard = readMethodGuard(context, proposal.featureId);
    if (costGuard?.source?.responseRef === response.responseRef) {
      const unknown = result('unknown', costGuard.reasonCode, after, postRead, effect);
      return freeze({ ...unknown, evidence: { ...unknown.evidence, targetEffectObserved: confirmed, unexpectedCost: costGuard } });
    }
    return result(confirmed ? 'confirmed' : 'unknown', confirmed ? 'LAND_TARGET_EFFECT_CONFIRMED' : 'LAND_TARGET_EFFECT_UNPROVEN', after, postRead, effect);
  };
}
