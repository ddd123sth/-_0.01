import { canonical, clone, fingerprint, freeze } from '../../common.mjs';
import { sameContext } from './rpc-contract.mjs';
import { knownCell } from './wire-facts.mjs';

// This is the WHOLE received login membership, not a claim that omitted lands
// do not exist on the server. No pagination/truncation or post-write rebuilding.
export function captureLandWriteWorkset({ context, proposal, acceptedLogin, group, selection = null } = {}) {
  const frame = acceptedLogin?.frame, ids = Object.keys(frame?.landBase?.value || {}).sort((a,b)=>Number(a)-Number(b));
  const fail = reasonCode => freeze({ version:'land-write-workset/v1', complete:false, reasonCode });
  if (acceptedLogin?.accepted !== true || !sameContext(frame?.context, context) || frame.source?.kind !== 'response' ||
      frame.source.method !== 'index.login' || !knownCell(frame.landBase) || !knownCell(frame.profile?.uid) ||
      !ids.length || ids.length > 256 || !ids.includes(String(proposal.params.landId))) return fail('W6_LOGIN_MEMBERSHIP_UNPROVEN');
  if (!group || group.groupRef !== proposal.land.groupRef || !Array.isArray(group.members) ||
      !group.members.some(one=>one.landId===proposal.params.landId && one.memberKey===proposal.land.groupMemberKey) ||
      group.members.some(one=>!ids.includes(String(one.landId)))) return fail('W6_COMPLETE_GROUP_UNPROVEN');
  if (proposal.featureId === 'harvest' && (!group.round || group.round.roundRef !== proposal.land.roundRef ||
      !Array.isArray(group.round.members) || !group.round.members.length ||
      group.round.members.some(one=>!ids.includes(String(one.landId))) ||
      !group.round.members.some(one=>one.landId===proposal.params.landId && one.stageRef===proposal.targets[0].lifecycleRef)))
    return fail('W6_FROZEN_ROUND_UNPROVEN');
  if (proposal.featureId === 'plant' && (selection?.known !== true || !selection.poolBasis ||
      selection.fingerprint !== proposal.land.readPoolBasis || fingerprint(selection.poolBasis) !== selection.fingerprint))
    return fail('W6_COMPLETE_SELECTION_UNPROVEN');
  const body = { version:'land-write-workset/v1', complete:true, context:clone(context), officialUid:frame.profile.uid.value,
    loginObservationRef:frame.observationRef, loginResponseRef:frame.source.responseRef,
    loginRequestSequence:frame.source.requestSequence, loginFrameFingerprint:acceptedLogin.frameFingerprint,
    loginReceivedMembers:ids.map(id=>({landId:Number(id), fingerprint:fingerprint(frame.landBase.value[id])})),
    group:clone(group), selection:proposal.featureId==='plant'?clone({ config:proposal.land.selectionConfig,
      poolBasis:selection.poolBasis, candidates:selection.candidates, excluded:selection.excluded }):null,
    target:{landId:proposal.params.landId,lifecycleRef:proposal.targets[0].lifecycleRef},
    before:clone(proposal.land.before) };
  if (Buffer.byteLength(canonical(body)) > 64*1024) return fail('W6_WORKSET_BUDGET_EXCEEDED');
  return freeze({...body,receiptFingerprint:fingerprint(body)});
}

export function landWriteWorksetValid(workset, context, target) {
  if (workset?.version!=='land-write-workset/v1' || workset.complete!==true || !sameContext(workset.context,context) ||
      workset.target?.landId!==target?.landId || target?.lifecycleRef && workset.target.lifecycleRef!==target.lifecycleRef || !Array.isArray(workset.loginReceivedMembers) ||
      !workset.loginReceivedMembers.length || workset.loginReceivedMembers.length>256 ||
      new Set(workset.loginReceivedMembers.map(one=>one.landId)).size!==workset.loginReceivedMembers.length ||
      !workset.loginReceivedMembers.some(one=>one.landId===target.landId)) return false;
  const {receiptFingerprint,...body}=workset;
  return Buffer.byteLength(canonical(body))<=64*1024 && fingerprint(body)===receiptFingerprint;
}
