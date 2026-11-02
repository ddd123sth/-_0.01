import { canonical, fingerprint, plainObject, problem } from '../../common.mjs';
import { GUILD_BUILD_ROWS, REWARD_METHODS, SHARE_IDS } from './catalog.mjs';

export const REWARD_CONTRACT_VERSION = 'rewards/official-actions/v1';

const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const nonNegative = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function captureClaimArgs({ method, params } = {}) {
  if (!plainObject(params)) throw problem('REWARD_ARGUMENT_CONTRACT_INVALID', '奖励动作参数必须是对象', 400);
  const exact = expected => {
    if (canonical(params) !== canonical(expected)) throw problem('REWARD_ARGUMENT_CONTRACT_INVALID', '奖励动作参数与已核官服方法不一致', 400);
    return expected;
  };
  switch (method) {
    case REWARD_METHODS.mailPick: return exact({});
    case REWARD_METHODS.benefitDraw: return exact({});
    case REWARD_METHODS.dailyRecv:
    case REWARD_METHODS.weeklyRecv: {
      if (positive(params.id) === null) throw problem('REWARD_ARGUMENT_CONTRACT_INVALID', '任务号不合法', 400);
      return exact({ id: params.id });
    }
    case REWARD_METHODS.dailyBox: {
      if (nonNegative(params.idx) === null) throw problem('REWARD_ARGUMENT_CONTRACT_INVALID', '宝箱档位不合法', 400);
      return exact({ idx: params.idx });
    }
    case REWARD_METHODS.mainRecv: return exact({});
    case REWARD_METHODS.storyUnlock: return exact({});
    case REWARD_METHODS.guildBuild: {
      const row = positive(params.id);
      if (!row || !Object.values(GUILD_BUILD_ROWS).includes(row)) throw problem('REWARD_ARGUMENT_CONTRACT_INVALID', '公会建设档位不在官方三档内', 400);
      return exact({ id: row });
    }
    case REWARD_METHODS.guildHarvest: return exact({});
    case REWARD_METHODS.guildPlant: {
      const landIds = params.landIds, flwId = positive(params.flwId);
      if (!Array.isArray(landIds) || !landIds.length || landIds.length > 64 ||
          landIds.some(id => positive(id) === null) || new Set(landIds).size !== landIds.length || !flwId)
        throw problem('REWARD_ARGUMENT_CONTRACT_INVALID', '公会地种植参数不合法', 400);
      return exact({ landIds: [...landIds], flwId });
    }
    case REWARD_METHODS.guildUnlock:
    case REWARD_METHODS.guildUpgrade: {
      const landId = positive(params.landId);
      if (!landId) throw problem('REWARD_ARGUMENT_CONTRACT_INVALID', '公会地目标块号不合法', 400);
      return exact({ landId });
    }
    case REWARD_METHODS.cultivateUpgrade: {
      const flowerId = positive(params.flowerId);
      if (!flowerId) throw problem('REWARD_ARGUMENT_CONTRACT_INVALID', '升级鲜花缺少花朵号', 400);
      return exact({ flowerId });
    }
    case REWARD_METHODS.shopBuy: {
      const shopId = positive(params.shopId);
      if (!shopId) throw problem('REWARD_ARGUMENT_CONTRACT_INVALID', '材料商店货架号不合法', 400);
      return exact({ shopId });
    }
    case REWARD_METHODS.shopRefresh: return exact({});
    case REWARD_METHODS.share: {
      const shareId = positive(params.shareId), ext = params.ext;
      if (!shareId || !plainObject(ext) || ext.opType !== 1 || !['double-coin', 'giftbag', 'guild-build'].includes(ext.source ?? '')) {
        // `source` is a private intent marker, never sent to the server: the
        // captured body for shares is exactly {shareId, ext:{opType[,id]}}.
      }
      if (!shareId || !plainObject(ext)) throw problem('REWARD_ARGUMENT_CONTRACT_INVALID', '分享奖励参数不合法', 400);
      const body = { shareId, ext: Object.fromEntries(Object.entries(ext).filter(([key]) => key !== 'source' && key !== 'memberKey')) };
      if (!plainObject(body.ext) || body.ext.opType !== 1 || Object.keys(body.ext).some(key => !['opType', 'id'].includes(key)))
        throw problem('REWARD_ARGUMENT_CONTRACT_INVALID', '分享奖励参数不合法', 400);
      return exact({ shareId, ext: body.ext });
    }
    default: throw problem('REWARD_METHOD_NOT_CONTRACTED', '奖励动作没有登记方法合同', 400);
  }
}

function expectedShare(method, action, params) {
  if (method !== REWARD_METHODS.share) return null;
  if (action === 'renew' || action === 'double-coin') return { shareId: SHARE_IDS.doubleCoin, ext: { opType: 1 } };
  if (action === 'free-gift') return { shareId: params.shareId, ext: { opType: 1, id: params.ext?.id } };
  if (action === 'guild-build-video') return { shareId: SHARE_IDS.guildBuildVideo, ext: { opType: 1, id: GUILD_BUILD_ROWS['guild-build-video'] } };
  return null;
}

export function claimContract(featureId, scope, method, action) {
  return Object.freeze({ contractId: `${REWARD_CONTRACT_VERSION}/${featureId}/${action}`,
    featureId, scope, method, targetKind: `reward:${action}` });
}

export function claimPostRead(featureId, action, mode = 'after-close-login') {
  if (mode === 'mail-list') {
    return Object.freeze({ contractId: 'mail-list/post-write/v1', method: 'mail.getList', kind: 'same-connection',
      args: Object.freeze({}), evidenceRef: `rewards/${featureId}/${action}/mail-list-after-write/v1`,
      validateResponseCoverage: mailListResponseCoverage });
  }
  return Object.freeze({ contractId: 'rewards/after-close-login/v1', method: 'index.login', kind: 'after-close-login',
    args: Object.freeze({}), evidenceRef: `rewards/${featureId}/${action}/independent-after-write/v1`,
    validateResponseCoverage: rewardResponseCoverage });
}

export function mailListResponseCoverage({ proposal, response, observation } = {}) {
  return proposal?.featureId === 'reward.mail' && proposal.method === REWARD_METHODS.mailPick &&
    response?.method === proposal.method && response.transport === 'answered' &&
    observation?.method === 'mail.getList' && observation.source === 'response' && observation.transport === 'answered' &&
    observation.envelopeOk === true && observation.dsName === 'G.ISyncData' && observation.rejected !== true &&
    observation.connectionEpoch === proposal.connectionEpoch &&
    Number.isInteger(observation.requestSequence) && Number.isInteger(response.requestSequence) &&
    observation.requestSequence > response.requestSequence;
}

export function rewardResponseCoverage({ proposal, response, observation, bridge } = {}) {
  const reward = proposal?.reward;
  return !!reward && response?.method === proposal.method && response.transport === 'answered' &&
    typeof response.responseRef === 'string' && response.responseRef.length > 0 &&
    observation?.method === 'index.login' && observation.source === 'response' && observation.transport === 'answered' &&
    observation.envelopeOk === true && observation.dsName === 'G.ISyncData' && observation.rejected !== true &&
    bridge?.newLoginObservation?.responseRef === observation.responseRef &&
    bridge?.oldPhysicalCloseReceipt?.closed === true && bridge.operationId === proposal.operationId;
}

export function rewardAfterCloseLoginProof({ proposal, response, bridge } = {}) {
  const observation = bridge?.newLoginObservation;
  if (!rewardResponseCoverage({ proposal, response, observation, bridge }) ||
      observation?.versionEvidence?.loginResponseRef !== observation.responseRef ||
      bridge?.officialUid !== proposal?.reward?.officialUid || bridge?.newContext?.connectionEpoch !== observation.connectionEpoch)
    throw problem('REWARD_POST_READ_BRIDGE_INVALID', '奖励后验新登录没有通过原操作的物理关闭与身份合同');
  return Object.freeze({ version: 'rewards/after-close-login/v1', operationId: proposal.operationId,
    action: proposal.reward.action, targetKey: proposal.reward.targetKey,
    oldLoginResponseRef: proposal.reward.loginResponseRef, newLoginResponseRef: observation.responseRef,
    newLoginRequestSequence: observation.requestSequence, newLoginWireKey: observation.wireKey,
    newLoginConnectionEpoch: observation.connectionEpoch, postReadRef: observation.responseRef,
    officialUid: bridge.officialUid, leaseRef: bridge.leaseRef, bridgeFingerprint: bridge.bridgeFingerprint,
    oldConnectionEpoch: bridge.originalContext?.connectionEpoch, newConnectionEpoch: bridge.newContext?.connectionEpoch,
    oldPhysicalCloseReceipt: bridge.oldPhysicalCloseReceipt, newContext: bridge.newContext,
    extensionRef: proposal.reward.extensionRef, writeResponseRef: response.responseRef });
}

export function rewardTargetVerification({ proposal, verification } = {}) {
  // A confirmed claim cites the bounded post-read; a rejected one cites the
  // official refusal bound to this exact answered request. Both must still carry
  // the original target identity.
  return (verification?.verificationVersion === 'rewards/claim-postread/v1' ||
      verification?.verificationVersion === 'rewards/official-refusal/v1') &&
    verification.evidence?.targetRef === proposal?.targets?.[0]?.targetRef &&
    verification.evidence?.targetKey === proposal?.reward?.targetKey;
}

export function assertClaimProposal(proposal) {
  const reward = proposal?.reward;
  if (!proposal || !reward || typeof reward.action !== 'string' || typeof reward.targetKey !== 'string' ||
      !Object.values(REWARD_METHODS).includes(proposal.method) || !plainObject(proposal.params) ||
      !Array.isArray(proposal.targets) || proposal.targets.length !== 1 || !Array.isArray(proposal.resources) ||
      !Array.isArray(proposal.resourceBindings))
    throw problem('REWARD_PROPOSAL_INVALID', '奖励提案缺少独立有限动作合同', 400);
  const captured = captureClaimArgs({ method: proposal.method, params: proposal.params });
  const share = expectedShare(proposal.method, reward.action, captured);
  if (share && canonical(share) !== canonical(captured)) throw problem('REWARD_PROPOSAL_INVALID', '分享奖励参数与动作档位不一致', 400);
  if (fingerprint(captured) !== proposal.paramsFingerprint) throw problem('REWARD_PROPOSAL_INVALID', '奖励参数指纹不一致', 400);
  const target = proposal.targets[0];
  const attemptKey = typeof reward.attemptKey === 'string' && reward.attemptKey ? reward.attemptKey : reward.targetKey;
  const expectedTargetRef = `reward:${proposal.subjectRef}:${reward.action}:${attemptKey}`;
  if (target.targetKind !== `reward:${reward.action}` || target.targetRef !== expectedTargetRef ||
      target.memberKey !== 'reward:' + fingerprint([reward.action, attemptKey]) ||
      target.targetFingerprint !== fingerprint({ targetRef: expectedTargetRef, sourceRef: reward.sourceRef, extensionRef: reward.extensionRef }))
    throw problem('REWARD_PROPOSAL_INVALID', '奖励目标未绑定当前官服事实与动作身份', 400);
  if (!Number.isSafeInteger(reward.officialUid) || reward.officialUid <= 0 || typeof reward.sourceRef !== 'string' || !reward.sourceRef ||
      typeof reward.extensionRef !== 'string' || !reward.extensionRef || typeof reward.loginResponseRef !== 'string' || !reward.loginResponseRef ||
      !plainObject(reward.before) || typeof reward.factFingerprint !== 'string' || !reward.factFingerprint)
    throw problem('REWARD_PROPOSAL_INVALID', '奖励提案缺少当前官服主体或来源绑定', 400);
  return true;
}