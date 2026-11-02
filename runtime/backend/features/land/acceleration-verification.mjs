import { freeze } from '../../common.mjs';
import { field, proposalContext, safeSource } from './rpc-contract.mjs';

export function createLandAccelerationVerification({ projection, lifecycles, resources, clock, isCurrent, readMethodGuard = () => null }) {
  return async function verify({ proposal, response, connection, signal }) {
    const context = proposalContext(proposal), target = proposal.targets[0], mode = proposal.acceleration.mode;
    const result = (verdict, reasonCode, after = null, postRead = null, cardAfter = null) => freeze({ verdict,
      verificationVersion: 'land-acceleration/independent-postread/v1', reasonCode,
      member: { memberKey: target.memberKey, verdict, reasonCode }, postReadRef: postRead?.responseRef ?? null,
      postRead: postRead ? safeSource(postRead) : null,
      targetEffect: verdict === 'confirmed' ? { cropRef: proposal.acceleration.cropRef, flowerId: proposal.acceleration.flowerId,
        state: field(after, 'state') ?? null, nextTime: field(after, 'nextTime') ?? null } : null,
      evidence: { version: 'land-acceleration/independent-postread/v1', mode, reasonCode,
        contractId: proposal.acceleration.contractId, extensionRef: proposal.acceleration.extensionRef,
        targetRef: target.targetRef, before: proposal.land.before, answer: safeSource(response), rejected: response?.rejected === true,
        after: after ? { state: field(after, 'state') ?? null, flowerId: field(after, 'flowerId') ?? null,
          plantTime: field(after, 'plantTime') ?? null, nextTime: field(after, 'nextTime') ?? null, source: safeSource(after.source) } : null,
        postRead: postRead ? safeSource(postRead) : null, cardBefore: proposal.acceleration.cardBalanceBefore ?? null,
        cardAfter, baseDataSnapshotId: proposal.acceleration.baseDataSnapshotId, bundleRef: proposal.acceleration.bundleRef,
        loginResponseRef: proposal.acceleration.loginResponseRef, trustedClock: proposal.acceleration.trustedClock },
      resourceResolutions: proposal.resources.map(resource => ({ resourceKey: resource.resourceKey,
        state: verdict === 'confirmed' ? 'released' : 'historical_footprint',
        basisRefs: postRead?.responseRef ? [postRead.responseRef] : [], coverageRef: null })) });
    if (!isCurrent(context) || !connection?.isOpen()) return result('unknown', 'LAND_ACCELERATION_VERIFY_CONTEXT_REVOKED');
    let postRead;
    try { signal?.throwIfAborted(); postRead = await connection.read('usrLand.refresh', {}); }
    catch (error) { return result('unknown', String(error?.code || 'LAND_ACCELERATION_POST_READ_FAILED')); }
    if (!isCurrent(context)) return result('unknown', 'LAND_ACCELERATION_VERIFY_CONTEXT_REVOKED');
    if (postRead.connectionEpoch !== response.connectionEpoch || postRead.connectionEpoch !== context.connectionEpoch ||
        !Number.isSafeInteger(postRead.requestSequence) || !Number.isSafeInteger(response.requestSequence) ||
        postRead.requestSequence <= response.requestSequence || !postRead.responseRef) return result('unknown', 'LAND_ACCELERATION_POST_READ_NOT_AFTER_WRITE');
    const view = projection.view(context), after = view.lands[String(proposal.acceleration.targetLandId)];
    if (!view.current || view.identity?.verified !== true || !after?.current || after.source?.responseRef !== postRead.responseRef)
      return result('unknown', 'LAND_ACCELERATION_TARGET_NOT_COVERED', after, postRead);
    const life = lifecycles.get({ subjectRef: context.subjectRef, landId: proposal.acceleration.targetLandId });
    const sameCrop = life?.cropRef === proposal.acceleration.cropRef && field(after, 'flowerId') === proposal.acceleration.flowerId &&
      field(after, 'plantTime') === proposal.acceleration.plantTime;
    const due = proposal.acceleration.originalNextTime, state = field(after, 'state'), nextTime = field(after, 'nextTime');
    if (response.rejected === true) return result('unknown', 'LAND_ACCELERATION_REJECTION_REQUIRES_RECONCILIATION', after, postRead);
    const postClock = clock(context.subjectRef), postUpper = postClock?.nowMs + postClock?.uncertaintyMs;
    const timelyPostRead = postClock?.available === true && postClock.connectionEpoch === context.connectionEpoch &&
      Number.isFinite(postUpper) && postUpper < due;
    const effect = sameCrop && (state === 3 || Number.isSafeInteger(nextTime) && nextTime < due);
    if (!timelyPostRead) return result('unknown', 'LAND_ACCELERATION_NATURAL_DUE_PASSED', after, postRead);
    let cardAfter = null;
    if (mode === 'card') {
      const debit = resources.landAccelerationDebitEvidence({ context, proposal, response, postRead });
      cardAfter = debit?.known ? debit.after : null;
      if (debit?.known !== true) return result('unknown', debit?.reasonCode || 'LAND_ACCELERATION_CARD_DEDUCTION_UNPROVEN', after, postRead, cardAfter);
    }
    const costGuard = readMethodGuard(context, 'land.acceleration');
    if (costGuard?.source?.responseRef === response.responseRef)
      return result('unknown', costGuard.reasonCode || 'LAND_UNDECLARED_COST_OBSERVED', after, postRead, cardAfter);
    const confirmed = sameCrop && effect && response.rejected !== true;
    return result(confirmed ? 'confirmed' : 'unknown', confirmed ? 'LAND_ACCELERATION_EFFECT_CONFIRMED' : 'LAND_ACCELERATION_EFFECT_UNPROVEN',
      after, postRead, cardAfter);
  };
}
