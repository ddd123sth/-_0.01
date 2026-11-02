import { canonical, fingerprint, plainObject, problem } from '../../common.mjs';
import { artRecipeFingerprint } from './rpc-contract.mjs';

export const CUSTOMER_ART_BATCH_CONTRACT = Object.freeze({ contractRef: 'art-customer/accepted-parent-batch/v2',
  featureId: 'art.customer-batch', scope: 'flower-art-customer-batch', method: 'flowerArt.makeFlowerArt',
  targetKind: 'flower-art-customer-batch' });
export const CUSTOMER_ART_BATCH_POST_READ = Object.freeze({ contractId: 'art-customer-batch/after-close-login/v2',
  method: 'index.login', kind: 'after-close-login', args: Object.freeze({}),
  evidenceRef: 'art-customer-batch/accepted-order-and-inputs/v2', validateResponseCoverage: customerArtBatchResponseCoverage });
const positive = value => Number.isSafeInteger(value) && value > 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const exactKeys = (value, keys) => plainObject(value) && canonical(Object.keys(value).sort()) === canonical([...keys].sort());

export function captureCustomerArtBatchArgs(input) {
  if (!exactKeys(input, ['vaseId', 'flowersIds', 'num']) || !positive(input.vaseId) || !positive(input.num) || input.num > 999 ||
      !Array.isArray(input.flowersIds) || input.flowersIds.length !== 3 || Object.keys(input.flowersIds).length !== 3 ||
      !input.flowersIds.every(positive)) throw problem('CUSTOMER_ART_BATCH_ARGUMENTS_INVALID', '顾客花艺批量参数无效', 400);
  const params = structuredClone(input);
  return Object.freeze({ params, paramsFingerprint: fingerprint(params) });
}

export function assertCustomerArtBatchProposal(proposal) {
  const batch = proposal?.customerArtBatch, target = proposal?.targets?.[0], contract = CUSTOMER_ART_BATCH_CONTRACT;
  let captured;
  try { captured = captureCustomerArtBatchArgs(proposal?.params); } catch { throw problem('CUSTOMER_ART_BATCH_ARGUMENTS_INVALID', '顾客花艺批量参数无效', 400); }
  const targetRef = `customer-art-batch:${proposal?.subjectRef}:${batch?.parentLifecycleRef}`;
  const memberKey = 'customer-art-batch:' + fingerprint([proposal?.subjectRef, batch?.parentLifecycleRef]);
  const counts = batch?.flowersIds?.reduce((rows, itemId) => {
    const found = rows.find(one => one.itemId === itemId);
    if (found) found.occurrences += 1; else rows.push({ itemId, occurrences: 1 });
    return rows;
  }, []) || [];
  counts.sort((left, right) => left.itemId - right.itemId);
  if (!proposal || proposal.featureId !== contract.featureId || proposal.scope !== contract.scope || proposal.method !== contract.method ||
      proposal.contractRef !== contract.contractRef || captured.paramsFingerprint !== proposal.paramsFingerprint ||
      canonical(captured.params) !== canonical(proposal.params) || !plainObject(batch) || !positive(batch.officialUid) ||
      !reference(batch.parentLifecycleRef) || !reference(batch.parentDecisionRef) || !reference(batch.parentContentFingerprint) ||
      !positive(batch.parentNpcId) || !positive(batch.artId) || !positive(batch.orderNeed) ||
      !Number.isSafeInteger(batch.finishedStockAllocated) || batch.finishedStockAllocated < 0 ||
      !positive(batch.batchQuantity) || batch.batchQuantity !== proposal.params.num ||
      batch.batchQuantity !== batch.orderNeed - batch.finishedStockAllocated ||
      batch.recipeFingerprint !== artRecipeFingerprint({ artId: batch.artId, vaseId: batch.vaseId, flowersIds: batch.flowersIds }) ||
      !positive(batch.vaseId) || !Array.isArray(batch.flowersIds) || batch.flowersIds.length !== 3 || !batch.flowersIds.every(positive) ||
      !plainObject(batch.catalogSource) || batch.catalogSource.loginResponseRef !== batch.loginResponseRef ||
      batch.catalogSource.dataSnapshotId !== batch.dataSnapshotId || !plainObject(batch.recipeRowProof) ||
      batch.recipeRowProof.loginResponseRef !== batch.loginResponseRef ||
      !reference(batch.loginResponseRef) || !reference(batch.dataSnapshotId) || !plainObject(batch.versionEvidence) ||
      batch.versionEvidence.loginResponseRef !== batch.loginResponseRef || batch.versionEvidence.dataSnapshotId !== batch.dataSnapshotId ||
      !Array.isArray(batch.inputBalances) || !Array.isArray(batch.inputMultiset) || canonical(batch.inputMultiset) !== canonical(counts) ||
      target?.targetKind !== contract.targetKind || target.targetRef !== targetRef || target.memberKey !== memberKey ||
      target.lifecycleRef !== batch.parentLifecycleRef || !Array.isArray(proposal.targets) || proposal.targets.length !== 1 ||
      !Array.isArray(proposal.resources) || !Array.isArray(proposal.resourceBindings))
    throw problem('CUSTOMER_ART_BATCH_PROPOSAL_INVALID', '顾客批量花艺必须绑定当前接受的订单、配方与完整剩余数量', 400);
  const expected = counts.map(one => ({ itemId: one.itemId, quantity: one.occurrences * batch.batchQuantity }));
  if (proposal.resources.length !== expected.length || proposal.resourceBindings.length !== expected.length ||
      !expected.every(one => {
        const resource = proposal.resources.find(row => row.resourceKind === 'item' && row.resourceRef === `item:${one.itemId}`);
        const binding = resource && proposal.resourceBindings.find(row => row.resourceKey === resource.resourceKey);
        return resource?.quantity === one.quantity && binding?.memberKey === memberKey && binding.quantity === one.quantity;
      }) || batch.inputBalances.length !== expected.length || !expected.every(one => batch.inputBalances.some(row =>
        row.itemId === one.itemId && row.value >= one.quantity && reference(row.basisRef))))
    throw problem('CUSTOMER_ART_BATCH_RESERVATION_INVALID', '顾客花艺整批配料必须与实际多重集及共享预约一致', 400);
  return true;
}

export function customerArtBatchResponseCoverage({ proposal, response, observation, bridge } = {}) {
  return proposal?.featureId === CUSTOMER_ART_BATCH_CONTRACT.featureId && proposal?.method === CUSTOMER_ART_BATCH_CONTRACT.method &&
    response?.method === proposal.method && response?.transport === 'answered' && reference(response.responseRef) &&
    observation?.method === 'index.login' && observation.source === 'response' && observation.transport === 'answered' &&
    observation.envelopeOk === true && observation.dsName === 'G.ISyncData' && observation.rejected !== true &&
    bridge?.newLoginObservation?.responseRef === observation.responseRef && bridge.oldPhysicalCloseReceipt?.closed === true &&
    bridge.operationId === proposal.operationId;
}

export function customerArtBatchAfterCloseLoginProof({ proposal, response, bridge } = {}) {
  const observation = bridge?.newLoginObservation, batch = proposal?.customerArtBatch;
  if (!customerArtBatchResponseCoverage({ proposal, response, observation, bridge }) ||
      bridge.officialUid !== batch?.officialUid || observation?.versionEvidence?.loginResponseRef !== observation.responseRef ||
      bridge.newContext?.connectionEpoch !== observation.connectionEpoch)
    throw problem('CUSTOMER_ART_BATCH_POSTREAD_BRIDGE_INVALID', '顾客批量花艺后验登录未绑定原写入、本人和物理关闭');
  return Object.freeze({ version: 'art-customer-batch/after-close-login/v2', operationId: proposal.operationId,
    after: bridge.after, newLogin: { connectionEpoch: observation.connectionEpoch, requestSequence: observation.requestSequence,
      wireKey: observation.wireKey, responseRef: observation.responseRef },
    newLoginResponseRef: observation.responseRef, newLoginRequestSequence: observation.requestSequence,
    newLoginWireKey: observation.wireKey, newLoginConnectionEpoch: observation.connectionEpoch, postReadRef: observation.responseRef,
    officialUid: bridge.officialUid, leaseRef: bridge.leaseRef, bridgeFingerprint: bridge.bridgeFingerprint,
    oldConnectionEpoch: bridge.originalContext?.connectionEpoch, newConnectionEpoch: bridge.newContext?.connectionEpoch,
    oldPhysicalCloseReceipt: bridge.oldPhysicalCloseReceipt, newContext: bridge.newContext,
    writeResponseRef: response.responseRef, parentLifecycleRef: batch.parentLifecycleRef,
    sourceSnapshotRef: batch.dataSnapshotId });
}

export function customerArtBatchTargetVerification({ proposal, verification } = {}) {
  return verification?.verificationVersion === 'art-customer-batch/target-postread/v2' &&
    verification.evidence?.targetRef === proposal?.targets?.[0]?.targetRef &&
    verification.evidence?.parentLifecycleRef === proposal?.customerArtBatch?.parentLifecycleRef &&
    verification.evidence?.batchQuantity === proposal?.customerArtBatch?.batchQuantity;
}
