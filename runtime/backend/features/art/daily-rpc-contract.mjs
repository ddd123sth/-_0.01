import { canonical, fingerprint, plainObject, problem } from '../../common.mjs';
import { artRecipeFingerprint } from './rpc-contract.mjs';

export const DAILY_ART_CONTRACT = Object.freeze({ contractRef: 'art-daily/batched-stock/v2', featureId: 'art.daily',
  scope: 'flower-art-daily', method: 'flowerArt.makeFlowerArt', targetKind: 'flower-art-daily-unit' });
export const DAILY_ART_POST_READ = Object.freeze({ contractId: 'art-daily/after-close-login/v1', method: 'index.login', kind: 'after-close-login',
  args: Object.freeze({}), evidenceRef: 'art-daily/batched-stock-and-inputs/v2', validateResponseCoverage: dailyArtResponseCoverage });

const positive = value => Number.isSafeInteger(value) && value > 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const exactKeys = (value, expected) => plainObject(value) && canonical(Object.keys(value).sort()) === canonical([...expected].sort());

// The historical art.make contract retains its audited num=1 rule. Daily
// replenishment uses this separate bounded batch contract.
export function captureDailyArtMakeArgs(input) {
  if (!exactKeys(input, ['vaseId', 'flowersIds', 'num']) || !positive(input.vaseId) ||
      !Number.isSafeInteger(input.num) || input.num < 1 || input.num > 999 ||
      !Array.isArray(input.flowersIds) || input.flowersIds.length !== 3 || Object.keys(input.flowersIds).length !== 3 ||
      !input.flowersIds.every(positive)) throw problem('DAILY_ART_ARGUMENTS_INVALID', '日常花艺请求参数无效', 400);
  const params = structuredClone(input);
  return Object.freeze({ params, paramsFingerprint: fingerprint(params) });
}

export function assertDailyArtProposal(proposal) {
  const daily = proposal?.dailyArt, target = proposal?.targets?.[0];
  let captured;
  try { captured = captureDailyArtMakeArgs(proposal?.params); } catch { throw problem('DAILY_ART_ARGUMENTS_INVALID', '日常花艺请求参数无效', 400); }
  const targetRef = `art-daily:${proposal.subjectRef}:${daily?.dayKey}:${daily?.artId}`;
  const expectedMember = 'art-daily:' + fingerprint([daily?.dayKey, daily?.artId, daily?.unitOrdinal]);
  if (!proposal || proposal.featureId !== DAILY_ART_CONTRACT.featureId || proposal.scope !== DAILY_ART_CONTRACT.scope ||
      proposal.method !== DAILY_ART_CONTRACT.method || proposal.contractRef !== DAILY_ART_CONTRACT.contractRef ||
      canonical(captured.params) !== canonical(proposal.params) || captured.paramsFingerprint !== proposal.paramsFingerprint ||
      !plainObject(daily) || !positive(daily.officialUid) || !positive(daily.artId) || !positive(daily.vaseId) ||
      !Array.isArray(daily.flowersIds) || daily.flowersIds.length !== 3 || !daily.flowersIds.every(positive) ||
      !positive(daily.batchQuantity) || daily.batchQuantity > 999 || captured.params.num !== daily.batchQuantity ||
      !positive(daily.targetStock) ||
      !Number.isSafeInteger(daily.quality) || daily.quality < 1 || daily.quality > 5 ||
      daily.outputItemRow?.id !== daily.artId || daily.outputItemRow?.type !== 12 || daily.outputItemRow?.color !== daily.quality ||
      daily.recipeFingerprint !== artRecipeFingerprint({ artId: daily.artId, vaseId: daily.vaseId, flowersIds: daily.flowersIds }) ||
      !reference(daily.dayKey) || !reference(daily.unitRef) || !Number.isSafeInteger(daily.unitOrdinal) || daily.unitOrdinal < 1 ||
      !plainObject(daily.beforeProfile) || !Number.isSafeInteger(daily.beforeProfile.gold) || daily.beforeProfile.gold < 0 ||
      !Number.isSafeInteger(daily.beforeProfile.yuanbao) || daily.beforeProfile.yuanbao < 0 || !plainObject(daily.costContract) ||
      daily.costContract.version !== 'art-daily/batched-inputs/v2' || daily.costContract.recipeFingerprint !== daily.recipeFingerprint ||
      daily.costContract.batchQuantity !== daily.batchQuantity || canonical(daily.costContract.unitInputMultiset) !== canonical(
        daily.flowersIds.reduce((rows, itemId) => { const found = rows.find(one => one.itemId === itemId);
          if (found) found.occurrences += 1; else rows.push({ itemId, occurrences: 1 }); return rows; }, []).sort((a, b) => a.itemId - b.itemId)) ||
      !plainObject(daily.beforeBalances) || daily.flowersIds.some(id => !plainObject(daily.beforeBalances[String(id)]) ||
        !Number.isSafeInteger(daily.beforeBalances[String(id)].value) || daily.beforeBalances[String(id)].value < 0) ||
      target?.targetKind !== DAILY_ART_CONTRACT.targetKind || target.targetRef !== targetRef || target.memberKey !== expectedMember ||
      target.lifecycleRef !== daily.unitRef || target.targetFingerprint !== fingerprint({ targetRef, recipeFingerprint: daily.recipeFingerprint,
        unitRef: daily.unitRef, dayKey: daily.dayKey, batchQuantity: daily.batchQuantity }) || !Array.isArray(proposal.targets) || proposal.targets.length !== 1 ||
      !Array.isArray(proposal.resources) || !Array.isArray(proposal.resourceBindings) ||
      /^customer-life:/.test(daily.parentLifecycleRef || '') || Object.hasOwn(daily, 'customerParent'))
    throw problem('DAILY_ART_PROPOSAL_INVALID', '日常制作必须绑定独立库存目标，不得伪造顾客订单父单', 400);
  const expected = daily.flowersIds.reduce((rows, itemId) => {
    const found = rows.find(one => one.itemId === itemId);
    if (found) found.quantity += daily.batchQuantity; else rows.push({ itemId, quantity: daily.batchQuantity });
    return rows;
  }, []);
  if (proposal.resources.length !== expected.length || proposal.resourceBindings.length !== expected.length ||
      !expected.every(one => {
        const resource = proposal.resources.find(row => row.resourceKind === 'item' && row.resourceRef === `item:${one.itemId}`);
        const binding = resource && proposal.resourceBindings.find(row => row.resourceKey === resource.resourceKey);
        return resource?.quantity === one.quantity && binding?.memberKey === target.memberKey && binding.quantity === one.quantity;
      }) || target.targetFingerprint !== fingerprint({ targetRef, recipeFingerprint: daily.recipeFingerprint,
        unitRef: daily.unitRef, dayKey: daily.dayKey, batchQuantity: daily.batchQuantity }))
    throw problem('DAILY_ART_BATCH_RESOURCE_BINDING_INVALID', '单次制作量必须与配花多重集和共享预约一致', 400);
  return true;
}

export function dailyArtResponseCoverage({ proposal, response, observation, bridge } = {}) {
  return proposal?.featureId === 'art.daily' && proposal?.method === 'flowerArt.makeFlowerArt' && response?.method === proposal.method &&
    response?.transport === 'answered' && typeof response.responseRef === 'string' && observation?.method === 'index.login' &&
    observation.source === 'response' && observation.transport === 'answered' && observation.envelopeOk === true &&
    observation.dsName === 'G.ISyncData' && observation.rejected !== true &&
    bridge?.newLoginObservation?.responseRef === observation.responseRef && bridge?.oldPhysicalCloseReceipt?.closed === true &&
    bridge?.operationId === proposal.operationId;
}

export function dailyArtAfterCloseLoginProof({ proposal, response, bridge } = {}) {
  const observation = bridge?.newLoginObservation;
  if (!dailyArtResponseCoverage({ proposal, response, observation, bridge }) ||
      observation?.versionEvidence?.loginResponseRef !== observation.responseRef || bridge?.officialUid !== proposal?.dailyArt?.officialUid ||
      bridge?.newContext?.connectionEpoch !== observation.connectionEpoch)
    throw problem('DAILY_ART_POST_READ_BRIDGE_INVALID', '日常花艺后验登录未绑定本人、原写答复与物理关闭');
  return Object.freeze({ version: 'art-daily/after-close-login/v1', operationId: proposal.operationId,
    after: bridge.after,
    newLogin: { connectionEpoch: observation.connectionEpoch, requestSequence: observation.requestSequence,
      wireKey: observation.wireKey, responseRef: observation.responseRef },
    oldLoginResponseRef: proposal.dailyArt.loginResponseRef, newLoginResponseRef: observation.responseRef,
    newLoginRequestSequence: observation.requestSequence, newLoginWireKey: observation.wireKey,
    newLoginConnectionEpoch: observation.connectionEpoch, postReadRef: observation.responseRef, officialUid: bridge.officialUid,
    leaseRef: bridge.leaseRef, bridgeFingerprint: bridge.bridgeFingerprint, oldConnectionEpoch: bridge.originalContext?.connectionEpoch,
    newConnectionEpoch: bridge.newContext?.connectionEpoch, oldPhysicalCloseReceipt: bridge.oldPhysicalCloseReceipt,
    newContext: bridge.newContext, sourceSnapshotRef: proposal.dailyArt.dataSnapshotId, writeResponseRef: response.responseRef });
}

export function dailyArtTargetVerification({ proposal, verification } = {}) {
  return verification?.verificationVersion === 'art-daily/target-postread/v2' &&
    verification.evidence?.targetRef === proposal?.targets?.[0]?.targetRef &&
    verification.evidence?.recipeFingerprint === proposal?.dailyArt?.recipeFingerprint;
}
