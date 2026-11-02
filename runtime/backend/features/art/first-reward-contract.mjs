import { canonical, fingerprint, plainObject, problem } from '../../common.mjs';

const positive = value => Number.isSafeInteger(value) && value > 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;

export const ART_FIRST_ALBUM_CONTRACT = Object.freeze({ featureId: 'art.first-album', scope: 'vase-album-recv',
  method: 'collectRwd.recvArtCreateRwdByVase', targetKind: 'art-first-album-vase', contractRef: 'art-first-album/by-vase/v1' });
export const ART_FIRST_SHARE_CONTRACT = Object.freeze({ featureId: 'art.first-share', scope: 'art-first-share',
  method: 'usr.share', targetKind: 'art-first-share-art', contractRef: 'art-first-share/share6/v1' });
export const ART_FIRST_ALBUM_POST_READ = Object.freeze({ contractId: 'art-first-album/after-close-login/v1', method: 'index.login',
  kind: 'after-close-login', args: Object.freeze({}), evidenceRef: 'art-first-album/vase-history-and-exp/v1', validateResponseCoverage: artFirstRewardResponseCoverage });
export const ART_FIRST_SHARE_POST_READ = Object.freeze({ contractId: 'art-first-share/after-close-login/v1', method: 'index.login',
  kind: 'after-close-login', args: Object.freeze({}), evidenceRef: 'art-first-share/share-history-and-award/v1', validateResponseCoverage: artFirstRewardResponseCoverage });

export function captureArtFirstAlbumArgs(input) {
  if (!plainObject(input) || canonical(Object.keys(input).sort()) !== canonical(['flowerArtId']) || !positive(input.flowerArtId))
    throw problem('ART_FIRST_ALBUM_ARGUMENTS_INVALID', '图鉴领奖参数必须是本人已拥有的花瓶编号', 400);
  const params = structuredClone(input); return Object.freeze({ params, paramsFingerprint: fingerprint(params) });
}
export function captureArtFirstShareArgs(input) {
  if (!plainObject(input) || canonical(Object.keys(input).sort()) !== canonical(['ext', 'shareId']) || input.shareId !== 6 ||
      !plainObject(input.ext) || canonical(Object.keys(input.ext).sort()) !== canonical(['id', 'opType']) ||
      !positive(input.ext.id) || input.ext.opType !== 2)
    throw problem('ART_FIRST_SHARE_ARGUMENTS_INVALID', '花艺首次分享只允许已核实的share6直接分享参数', 400);
  const params = structuredClone(input); return Object.freeze({ params, paramsFingerprint: fingerprint(params) });
}

function assertProposal(proposal, contract, capture, targetRefPrefix, idField) {
  let captured; try { captured = capture(proposal?.params); } catch { throw problem('ART_FIRST_REWARD_ARGUMENTS_INVALID', '首做奖励参数无效', 400); }
  const action = proposal?.artFirstReward, target = proposal?.targets?.[0], targetRef = `${targetRefPrefix}:${proposal?.subjectRef}:${action?.[idField]}` +
    (contract.featureId === ART_FIRST_ALBUM_CONTRACT.featureId ? `:${action?.claimSetFingerprint || ''}` : '');
  if (!proposal || proposal.featureId !== contract.featureId || proposal.scope !== contract.scope || proposal.method !== contract.method ||
      proposal.contractRef !== contract.contractRef || captured.paramsFingerprint !== proposal.paramsFingerprint ||
      canonical(captured.params) !== canonical(proposal.params) || !plainObject(action) || !positive(action.officialUid) ||
      !positive(action[idField]) || contract.featureId === ART_FIRST_ALBUM_CONTRACT.featureId &&
        (!/^[a-f0-9]{64}$/.test(action.claimSetFingerprint || '') || !Array.isArray(action.claimArtIds) || !action.claimArtIds.length ||
          !action.claimArtIds.every(positive) || canonical(action.claimArtIds) !== canonical([...new Set(action.claimArtIds)].sort((a,b)=>a-b)) ||
          action.claimSetFingerprint !== fingerprint(action.claimArtIds)) ||
      !/^sha256:[a-f0-9]{64}$/.test(action.extensionRef || '') || action.extension?.extensionRef !== action.extensionRef ||
      action.extension?.loginResponseRef !== action.loginResponseRef || action.extension?.baseDataSnapshotId !== action.dataSnapshotId ||
      action.targetRef !== targetRef || target?.targetKind !== contract.targetKind ||
      target.targetRef !== targetRef || target.memberKey !== action.memberKey || target.lifecycleRef !== action.lifecycleRef ||
      !reference(action.lifecycleRef) || !reference(action.memberKey) || !Array.isArray(proposal.targets) || proposal.targets.length !== 1 ||
      (contract.featureId === ART_FIRST_ALBUM_CONTRACT.featureId ? proposal.params.flowerArtId !== action.vaseId :
        proposal.params.ext.id !== action.artId || action.shareRoute?.kind !== 'direct-request-only' || action.shareRoute?.requestOnly !== true ||
          action.shareRoute?.direct !== true || action.shareRoute?.sdkAvailability !== 'unverified'))
    throw problem('ART_FIRST_REWARD_PROPOSAL_INVALID', '首做奖励必须绑定当前本人、唯一目标和精确请求参数', 400);
  return true;
}
export const assertArtFirstAlbumProposal = proposal => assertProposal(proposal, ART_FIRST_ALBUM_CONTRACT, captureArtFirstAlbumArgs,
  'art-first-album', 'vaseId');
export const assertArtFirstShareProposal = proposal => assertProposal(proposal, ART_FIRST_SHARE_CONTRACT, captureArtFirstShareArgs,
  'art-first-share', 'artId');

export function artFirstAlbumAfterCloseLoginProof({ proposal, response, bridge } = {}) {
  return afterCloseProof(proposal, response, bridge, ART_FIRST_ALBUM_CONTRACT, 'art-first-album/after-close-login/v1');
}
export function artFirstRewardResponseCoverage({ proposal, response, observation, bridge } = {}) {
  return [ART_FIRST_ALBUM_CONTRACT.featureId, ART_FIRST_SHARE_CONTRACT.featureId].includes(proposal?.featureId) &&
    response?.method === proposal?.method && response?.transport === 'answered' && reference(response.responseRef) &&
    observation?.method === 'index.login' && observation.source === 'response' && observation.transport === 'answered' &&
    observation.envelopeOk === true && observation.dsName === 'G.ISyncData' && observation.rejected !== true &&
    observation.versionEvidence?.loginResponseRef === observation.responseRef && bridge?.operationId === proposal.operationId &&
    bridge?.newLoginObservation?.responseRef === observation.responseRef && bridge?.oldPhysicalCloseReceipt?.closed === true;
}
export function artFirstShareAfterCloseLoginProof({ proposal, response, bridge } = {}) {
  return afterCloseProof(proposal, response, bridge, ART_FIRST_SHARE_CONTRACT, 'art-first-share/after-close-login/v1');
}
function afterCloseProof(proposal, response, bridge, contract, version) {
  const observation = bridge?.newLoginObservation;
  if (proposal?.featureId !== contract.featureId || response?.method !== proposal.method || response.transport !== 'answered' ||
      observation?.method !== 'index.login' || observation.source !== 'response' || observation.transport !== 'answered' ||
      observation.envelopeOk !== true || observation.dsName !== 'G.ISyncData' || observation.rejected === true ||
      observation.versionEvidence?.loginResponseRef !== observation.responseRef || bridge.oldPhysicalCloseReceipt?.closed !== true ||
      bridge.operationId !== proposal.operationId || bridge.officialUid !== proposal.artFirstReward?.officialUid)
    throw problem('ART_FIRST_REWARD_POSTREAD_INVALID', '首做奖励后验必须绑定原操作和本人关闭后新登录');
  return Object.freeze({ version, operationId: proposal.operationId, targetRef: proposal.targets[0].targetRef,
    after: bridge.after, newLogin: { connectionEpoch: observation.connectionEpoch, requestSequence: observation.requestSequence,
      wireKey: observation.wireKey, responseRef: observation.responseRef }, postReadRef: observation.responseRef,
    bridgeFingerprint: bridge.bridgeFingerprint, officialUid: bridge.officialUid, leaseRef: bridge.leaseRef,
    newContext: bridge.newContext, oldPhysicalCloseReceipt: bridge.oldPhysicalCloseReceipt });
}
export const artFirstAlbumTargetVerification = ({ proposal, verification } = {}) => verification?.verificationVersion === 'art-first-album/target-postread/v1' &&
  verification.evidence?.targetRef === proposal?.targets?.[0]?.targetRef;
export const artFirstShareTargetVerification = ({ proposal, verification } = {}) => verification?.verificationVersion === 'art-first-share/target-postread/v1' &&
  verification.evidence?.targetRef === proposal?.targets?.[0]?.targetRef;
