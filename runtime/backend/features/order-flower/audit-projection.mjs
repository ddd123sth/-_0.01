import { canonical, fingerprint, parseStored, plainObject } from '../../common.mjs';
import { ORDER_FLOWER_CONTRACTS, orderFlowerHistoricalAdmittedContractMatches, assertOrderFlowerProposal } from './rpc-contract.mjs';
import { ORDER_FLOWER_LEVEL_REWARD_ITEM_IDS } from './level-catalog.mjs';
import { ORDER_FLOWER_AXES } from './wire-facts.mjs';
import { hashLedgerBytes, ledgerJsonFingerprint } from '../../persistence/json-contract.mjs';
import { assertOrderFlowerStoredPreparation } from './stored-contract.mjs';
import { projectOrderFlowerStoredBefore, projectOrderFlowerStoredEffect } from './audit-accounting.mjs';
import { resolveNativeExecutorExitProof } from '../../session/native-executor-identity.mjs';
import { resolveOrderFlowerObservationEvidence } from './read-model.mjs';
import { resolveAcceptedCustomerObservationEvidence } from '../customer/projection.mjs';
import { officialVersionAuditExtras } from '../../official-version-audit.mjs';

// This module reads immutable, already-decoded cells only. It neither decodes
// whole user payloads nor changes outcomes, reservations or coverage links.
const pick = (value, names) => value === null ? null : Object.fromEntries(names.filter(key => value && Object.hasOwn(value, key)).map(key => [key, value[key]]));
const same = (a, b, names) => !!a && !!b && names.every(key => a[key] === b[key]);
const BINDING = ['connectionEpoch', 'requestSequence', 'wireKey', 'responseRef'];
const VERSION = ['source', 'gameVersion', 'protocolVersion', 'loginResponseRef', 'sourceProofFingerprint', 'dayClockProofFingerprint',
  'dataSnapshotId', 'moSha256', 'contractId', 'dataSchemaContractId', 'profileBinding', 'resourceSha256', 'sourceConfigSha256',
  'sourceDataVersion', 'sourceIndexSha256', 'sourceProofs', 'tableHashes', 'staticArtifactRefs', 'sourceBlockContractSha256'];
const CELL = ['presence', 'state', 'value', 'reasonCode', 'rawType', 'sourceRef', 'rawValue'];

function currentNeedClosureStoredMatches(store, oldOperation, original, evidence) {
  if (typeof evidence?.closureEvidenceRef !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.closureFingerprint || '')) return false;
  if (evidence.closureKind === 'backend-physical-closure' || evidence.closureKind === undefined) {
    const row = store.get(`SELECT owner_ref,account_ref,subject_ref,owner_epoch,run_epoch,connection_epoch,executor_ref,proof_kind,proof_json
      FROM backend_session_connection_closures WHERE evidence_ref=?`, evidence.closureEvidenceRef);
    if (!row || row.owner_ref !== oldOperation.owner_ref || String(row.account_ref) !== String(oldOperation.account_ref) ||
        row.subject_ref !== oldOperation.subject_ref || row.owner_epoch !== original.ownerEpoch || row.run_epoch !== oldOperation.run_epoch ||
        row.connection_epoch !== oldOperation.connection_epoch || row.executor_ref !== original.executorRef) return false;
    const proof = parseStored(row.proof_json, '当前需求关闭原件');
    return fingerprint(proof) === evidence.closureFingerprint && proof.closed === true && proof.connectionEpoch === oldOperation.connection_epoch &&
      (row.proof_kind === 'transport-closed' && ['transport-close-receipt', 'connect-rejected-after-physical-close'].includes(proof.source) ||
        row.proof_kind === 'verification-snapshot-physical-close' && proof.source === 'verification-snapshot-actual-close' &&
          proof.operationId === oldOperation.operation_id);
  }
  if (evidence.closureKind === 'backend-native-executor-exit') {
    const executor = store.get('SELECT app_id FROM backend_local_executors WHERE executor_ref=?', original.executorRef);
    const proof = resolveNativeExecutorExitProof({ store, appId: executor?.app_id, subjectRef: oldOperation.subject_ref,
      executorRef: original.executorRef, ownerEpoch: original.ownerEpoch });
    return proof?.evidenceRef === evidence.closureEvidenceRef && proof.proofFingerprint === evidence.closureFingerprint;
  }
  return false;
}
const known = value => value?.presence === 'present' && value.state === 'known';
const bounded = (value, limit, project) => Array.isArray(value) ? value.slice(0, limit).map(project) : value === null ? null : [];
const scalarCell = value => {
  if (value == null) return value ?? null;
  const out = pick(value, CELL);
  // Scalar cells cannot be used to smuggle an unreviewed object/map.
  if (out.value !== null && typeof out.value === 'object') out.value = null;
  if (out.rawValue !== null && typeof out.rawValue === 'object') out.rawValue = null;
  return out;
};
export const orderFlowerAuditSource = value => {
  if (value == null) return value ?? null;
  const out = pick(value, ['kind', 'sourceKind', 'source', 'transport', 'method', 'contextKey', ...BINDING,
    'observationRef', 'sourceObservationRef', 'sourceFingerprint', 'serverId', 'officialUid', 'receivedDeviceMs', 'serverMs', 'serverRespondedMs',
    'sentMonotonicMs', 'receivedMonotonicMs', 'decodeVersion']);
  for (const key of ['version', 'versionEvidence']) if (Object.hasOwn(value, key)) out[key] = value[key]===null?null:
    {...pick(value[key], VERSION),...officialVersionAuditExtras(value[key])};
  return out;
};
const projectSourceFields = (value, names) => {
  const out = pick(value, names);
  if (value && Object.hasOwn(value, 'source')) out.source = orderFlowerAuditSource(value.source);
  return out;
};
const projectServerCount = value => {
  const out = projectSourceFields(value, ['known', 'counterId', 'raw', 'total', 'rawRTime', 'effective', 'offset', 'value',
    'sourceObservationRef', 'sourceFingerprint', 'originalOfficialCounterUnchanged', 'cellProofs']);
  if (value && Object.hasOwn(value, 'generatedOrderTimeProof')) out.generatedOrderTimeProof = {
    value: value.generatedOrderTimeProof?.value ?? null, source: orderFlowerAuditSource(value.generatedOrderTimeProof?.source) };
  return out;
};
const plainOrder = value => {
  const out = pick(value, ['kind', 'boxId', 'npcId', 'dialogId', 'flowers', 'isVideo', 'cdTime', 'cTime', 'placeIdx', 'finishCnt']);
  if (value && Object.hasOwn(value, 'videoRwd')) out.videoRwd = value.videoRwd === null ? null : plainObject(value.videoRwd) &&
    Object.entries(value.videoRwd).every(([id, quantity]) => /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) && Number.isSafeInteger(quantity) && quantity >= 0)
    ? Object.fromEntries(Object.entries(value.videoRwd).slice(0, 32)) : null;
  return out;
};
const sourceContract = value => {
  const out = pick(value, ['gameVersion', 'protocolVersion', 'gameSha256', 'moSha256']);
  if (typeof value?.sourceAction === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value.sourceAction)) out.sourceAction = value.sourceAction;
  if (plainObject(value?.sourceBlocks) && Object.keys(value.sourceBlocks).length <= 64 &&
      Object.entries(value.sourceBlocks).every(([name, hash]) => /^[A-Za-z0-9_.-]{1,96}$/.test(name) && /^[a-f0-9]{64}$/.test(hash || '')))
    out.sourceBlocks = { ...value.sourceBlocks };
  for (const key of ['newDateMode', 'other', 'refreshBoundary', 'refreshDefault', 'helperSync', 'moFormatter', 'moAnchor', 'moSetTimezone']) {
    if (value && Object.hasOwn(value, key)) out[key] = pick(value[key], ['range', 'sha256']);
  }
  return out;
};
const day = value => {
  if (value == null) return value ?? null;
  const out = pick(value, ['version', 'context', 'known', 'readOnly', 'currentRecheckRequired', 'serverResetPerformed', 'serverAbsoluteResetProven',
    'key', 'startMs', 'endMs', 'utcOffsetMinutes', 'resetHour', 'resetMinute', 'reasonCode', 'proofRef']);
  if (Object.hasOwn(value, 'context')) out.context = pick(value.context, ORDER_FLOWER_AXES);
  if (Object.hasOwn(value, 'source')) out.source = orderFlowerAuditSource(value.source);
  if (Object.hasOwn(value, 'sourceContract')) out.sourceContract = sourceContract(value.sourceContract);
  if (Object.hasOwn(value, 'refresh')) out.refresh = pick(value.refresh, ['known', 'rTimeMs', 'needsRefresh']);
  if (Object.hasOwn(value, 'timezoneProof')) {
    const proof = value.timezoneProof, projected = pick(proof, ['kind', 'path', 'selection', 'proofRef', 'responseRef', 'sampledAtMs',
      'timezoneOffsetMinutes', 'dayStartOffsetMinutes', 'dayEndOffsetMinutes', 'tzInfoPresence', 'officialClientFallback']);
    if (proof && Object.hasOwn(proof, 'context')) projected.context = pick(proof.context, ORDER_FLOWER_AXES);
    if (proof && Object.hasOwn(proof, 'normal')) projected.normal = pick(proof.normal, ['type', 'ms', 'secNum', 'tzo']);
    if (proof && Object.hasOwn(proof, 'splitMap')) projected.splitMap = { ...pick(proof.splitMap,
      ['presence', 'complete', 'totalYears', 'totalAnchors', 'fingerprint']), years: bounded(proof.splitMap?.years, 16, one => pick(one, ['year', 'anchorCount'])) };
    out.timezoneProof = projected;
  }
  return out;
};

// Auxiliary evidence is projected field by field. A missing field stays missing;
// unknown keys, oversized collections and non-scalar leaves are never copied.
const AUX_KINDS = new Set(['resident', 'satin', 'decorate', 'stage', 'achievement']);
const auxScalar = value => value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ||
  typeof value === 'string' && value.length <= 4096 ? value : null;
const auxObject = (value, names = [], nested = {}) => {
  if (value === null) return null;
  if (!plainObject(value)) return null;
  const out = Object.fromEntries(names.filter(key => Object.hasOwn(value, key)).map(key => [key, auxScalar(value[key])]));
  for (const [key, project] of Object.entries(nested)) if (Object.hasOwn(value, key)) out[key] = project(value[key]);
  return out;
};
const auxList = (limit, project = auxScalar) => value => value === null ? null : Array.isArray(value) ? value.slice(0, limit).map(project) : null;
const auxContext = value => auxObject(value, ORDER_FLOWER_AXES);
const auxVersion = value => auxObject(value, [...VERSION, 'clientChannel']);
const auxSource = value => auxObject(value, ['kind', 'sourceKind', 'source', 'transport', 'method', 'contextKey', ...BINDING,
  'observationRef', 'sourceObservationRef', 'sourceFingerprint', 'serverId', 'officialUid', 'receivedDeviceMs', 'serverMs', 'serverRespondedMs',
  'sentMonotonicMs', 'receivedMonotonicMs', 'decodeVersion'], { version: auxVersion, versionEvidence: auxVersion });
const auxLoginSource = value => {
  const out = auxSource(value);
  if (out === null) return out;
  return { ...out, ...auxObject(value, ['gameVersion', 'protocolVersion', 'loginResponseRef']) };
};
const auxNumMap = (value, maximum = 256) => plainObject(value) ? Object.fromEntries(Object.entries(value)
  .filter(([id, quantity]) => /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) && Number.isSafeInteger(quantity) && quantity >= 0)
  .slice(0, maximum)) : value === null ? null : null;
const auxPairs = auxList(16, auxList(2));
const auxOrder = value => auxObject(value, ['kind', 'boxId', 'npcId', 'dialogId', 'isVideo', 'cdTime', 'cTime', 'placeIdx', 'finishCnt'],
  { flowers: auxPairs, videoRwd: one => auxNumMap(one, 128) });
const auxProfile = value => auxObject(value, ['gold', 'yb', 'level', 'lvlExp']);
const auxInventory = value => auxObject(value, ['version', 'officialUid', 'bagComplete', 'bagFingerprint', 'bagEntries', 'rewardSeedQuantity',
  'projectionFingerprint'], { context: auxContext, source: auxSource, versionEvidence: auxVersion, profile: auxProfile,
  fieldSources: value?.version === 'order-aux-current-inventory/v2' ? one => plainObject(one) ? Object.fromEntries(
    Object.entries(one).filter(([key]) => ['gold', 'yb', 'level', 'lvlExp'].includes(key)).map(([key, source]) => [key, auxSource(source)])) : null : undefined,
  sourceProofs: value?.version === 'order-aux-current-inventory/v2' ? one => auxList(4096, auxSource)(one) : undefined,
  baseline: value?.version === 'order-aux-current-inventory/v2' ? one => auxObject(one, ['fingerprint'], { source: auxSource }) : undefined });
const auxCounter = value => auxObject(value, ['uid', 'type', 'raw', 'total', 'rTime'], { source: auxSource });
const auxShare = value => auxObject(value, ['uid', 'shareId', 'shareCnt', 'recvCnt', 'total', 'recvTime', 'uTime'], { source: auxSource });
const auxStage = value => auxObject(value, ['uid', 'receivedTime', 'resetTime'], { receivedIds: auxList(4), source: auxSource });
const auxAchievement = value => auxObject(value, ['uid', 'groupId', 'progress', 'receivedIndex', 'achHist',
  'progressMapFingerprint', 'otherRecvMapFingerprint', 'progressPresent', 'recvZeroProvenByCompleteMap'], { source: auxSource });
const auxOwnership = value => auxObject(value, ['uid', 'flowerId', 'itemId', 'present', 'completePropertyProvided', 'level', 'status'], { source: auxSource });
const auxEnterBoard = value => auxObject(value, ['uid', 'resetTime'], { receivedIds: auxList(4), source: auxSource,
  residents: residents => plainObject(residents) ? Object.fromEntries(Object.entries(residents).filter(([id]) => /^[1-6]$/.test(id))
    .slice(0, 6).map(([id, row]) => [id, auxOrder(row)])) : null, satin: auxOrder, decorate: auxOrder });
const auxBeforeState = value => auxObject(value, [], { inventory: auxInventory, stage: auxStage, achievement: auxAchievement,
  ownership: auxOwnership, board: auxEnterBoard, counters: auxList(4, auxCounter) });
const auxRange = value => auxObject(value, ['sha256'], { range: auxList(2) });
const auxDayContract = value => auxObject(value, ['gameVersion', 'protocolVersion', 'gameSha256', 'moSha256'],
  Object.fromEntries(['newDateMode', 'other', 'refreshBoundary', 'refreshDefault', 'helperSync', 'moFormatter', 'moAnchor', 'moSetTimezone']
    .map(key => [key, auxRange])));
const auxDay = value => auxObject(value, ['version', 'known', 'readOnly', 'currentRecheckRequired', 'serverResetPerformed', 'serverAbsoluteResetProven',
  'key', 'startMs', 'endMs', 'utcOffsetMinutes', 'resetHour', 'resetMinute', 'reasonCode', 'proofRef'], {
  context: auxContext, source: auxSource, sourceContract: auxDayContract,
  refresh: one => auxObject(one, ['known', 'rTimeMs', 'needsRefresh']),
  timezoneProof: one => auxObject(one, ['kind', 'selection', 'proofRef', 'responseRef', 'sampledAtMs',
    'timezoneOffsetMinutes', 'dayStartOffsetMinutes', 'dayEndOffsetMinutes', 'tzInfoPresence', 'officialClientFallback'], {
    path: auxList(8), context: auxContext, normal: row => auxObject(row, ['type', 'ms', 'secNum', 'tzo']),
    splitMap: row => auxObject(row, ['presence', 'complete', 'totalYears', 'totalAnchors', 'fingerprint'], {
      years: auxList(16, year => auxObject(year, ['year', 'anchorCount'])) }) }) });
const auxOpportunity = value => auxObject(value, ['known', 'eligible', 'reason', 'kind', 'lifecycleRef', 'reasonCode'], {
  basis: one => auxObject(one, ['officialUid', 'previousResetTime', 'currentDayStartMs', 'missingKind', 'eligibilityRef'], { boardSource: auxSource }) });
const auxEligibility = value => auxObject(value, ['current', 'open', 'kind', 'officialUid', 'basisRef'], { context: auxContext });
const auxOccurrence = value => auxObject(value, ['kind', 'boxId', 'lifecycleRef', 'contentFingerprint', 'identityKnown', 'priorLifecycleRef', 'boundaryKind'],
  { firstSource: auxSource, source: auxSource, context: auxContext });
const auxCard = value => auxObject(value, ['known', 'presence', 'officialUid', 'type', 'isMain', 'invalidTime'], { context: auxContext, source: auxSource });
const auxCapability = value => auxObject(value, ['kind', 'officialUid', 'receiptRef', 'completed', 'shareId', 'sourceKind', 'completionRef', 'tokenPresent', 'valid',
  'attemptRef', 'operationId', 'lifecycleRef', 'rewardStatus', 'sourceRef', 'requestRef', 'requestOnly', 'playbackClaimed'],
  { context: auxContext, card: auxCard, clockBasis: one => auxObject(one, ['available', 'source', 'connectionEpoch', 'lowerBoundMs', 'upperBoundMs']) });
const auxCount = value => auxObject(value, ['known', 'counterId', 'raw', 'total', 'rawRTime', 'effective', 'value', 'offset', 'uiDisplayValue',
  'countRule', 'dayKey', 'dayProofRef', 'originalCounterUnchanged', 'sourceObservationRef', 'sourceFingerprint', 'originalOfficialCounterUnchanged'],
  { source: auxSource });
const auxPolicyDay = value => auxObject(value, ['key', 'startMs', 'endMs', 'utcOffsetMinutes', 'dayKey', 'officialUid', 'originalDayReceiptRef',
  'originalDayFingerprint', 'proofRef']);
const auxPolicyCount = value => auxObject(value, ['version', 'known', 'kind', 'officialUid', 'dayKey', 'value', 'confirmedFloor', 'floorReceiptRef',
  'floorFingerprint', 'originalOfficialCounterUnchanged', 'unknownCountedAsConfirmed', 'currentAdmissionRecheckRequired', 'readOnly', 'writeEligible', 'proofRef',
  'serverOnly', 'reasonCode'], { context: auxContext, day: auxPolicyDay, serverCount: auxCount });
const auxButlerStock = value => auxObject(value, ['boxId', 'kind', 'known', 'reasonCode', 'rawStockNum', 'rawRowPresent', 'rawPresence', 'rawCalcTime',
  'rawMaxStockTime', 'effectiveStockNum', 'generatedSinceSnapshot', 'calcTime', 'maxStockTime', 'nextChangeAt', 'capacity', 'cdSeconds', 'branch',
  'hireProofRef', 'ordinaryDeliveryStillRequiresFlowers', 'rawMapFingerprint', 'basisRef'], { source: auxSource });
const auxButlerDaily = value => auxObject(value, ['known', 'reasonCode', 'counterId', 'rawGenCount', 'effectiveGenCount', 'finishedCount',
  'currentGeneratedOrderOffset', 'uiDisplayCount', 'rawRTime', 'meaning', 'dayKey', 'dayProofRef', 'originalCounterUnchanged', 'storedCount', 'officialLimit',
  'remainingForGeneration', 'countRule'], { source: auxSource });
const auxStockPlanning = value => auxObject(value, ['kind', 'boxId', 'branch', 'contentFingerprint', 'limit', 'shareId'], {
  source: auxSource, count: auxCount, policyCount: auxPolicyCount, butlerStock: auxButlerStock, butlerDaily: auxButlerDaily,
  reward: one => auxNumMap(one, 128), videoQuota: one => auxObject(one, ['known', 'rawRecvCnt', 'effectiveRecvCnt', 'limit', 'originalRowUnchanged']) });
const auxStagePolicy = value => auxObject(value, ['known', 'reasonCode', 'target', 'level', 'requiredCount', 'typeNum', 'itemNum', 'candidatePoolOnly',
  'randomDistributionProvenByStaticNames', 'tableRowId', 'tableSha256', 'sourceGameSha256'], { poolItemIds: auxList(128) });
const auxSharePolicy = value => auxObject(value, ['known', 'reasonCode', 'id', 'openId', 'hasVideo', 'limitType', 'limit', 'tag', 'tableSha256', 'sourceGameSha256']);
const auxExperienceSource = value => auxObject(value, ['version', 'gameVersion', 'protocolVersion', 'catalogSha256', 'table', 'tableSha256',
  'gameDecodedSha256', 'tableDecodeSourceSha256', 'tableDecodeHelperSha256', 'rewardSemantics'], {
  experienceRule: one => auxObject(one, ['rangeConvention', 'start', 'end', 'sha256']) });
const auxExperience = value => auxObject(value, ['known', 'reasonCode', 'experienceQuantity', 'candidatePresenceProvesNoGrant'], {
  before: one => auxObject(one, ['level', 'lvlExp', 'coordinate']), after: one => auxObject(one, ['level', 'lvlExp', 'coordinate']),
  crossedLevels: auxList(65), rewardCandidates: auxList(118, one => auxObject(one, ['itemId', 'maximumQuantity'])), source: auxExperienceSource });
const auxInventoryEffect = value => auxObject(value, ['known', 'reasonCode', 'beforeBagFingerprint', 'afterBagFingerprint', 'zeroItemCost'], {
  gains: auxNumMap, proxyGains: auxNumMap, profileBefore: auxProfile, profileAfter: auxProfile, experienceTransition: auxExperience,
  zeroItemCostProof: one => auxObject(one, ['kind', 'gainMapFingerprint', 'costMapSupplied', 'costMapReadable',
    'completeBagDifferenceChecked', 'currencyAndExperienceDifferenceChecked']),
  answer: auxSource, postRead: auxSource });
const auxRewardEffect = value => auxObject(value, ['kind', 'target', 'taskId', 'actualDistributionIsNotPredictedFromNames',
  'theoreticalRandomQuantityGuaranteeClaimed', 'actualOwnershipTransitionProven', 'actualBagGrantAlternative'], {
  expectedReward: auxList(4, auxList(2)), policy: auxStagePolicy,
  before: one => Object.hasOwn(one || {}, 'receivedIds') ? auxStage(one) : auxAchievement(one),
  after: one => Object.hasOwn(one || {}, 'receivedIds') ? auxStage(one) : auxAchievement(one),
  ownershipBefore: auxOwnership, ownershipAfter: auxOwnership });
const auxEffect = value => auxObject(value, ['kind', 'boxId', 'originalUnderlyingBusinessCountersUnchanged',
  'businessCounterOrClaimFlagAloneConfirmsNothing', 'newOccurrenceIdentityCreatedByVerifier', 'serverRawCountersNeverLocallyReset'], {
  beforeOrder: auxOrder, afterOrder: auxOrder, expectedVideoReward: one => auxNumMap(one, 128), sharePolicy: auxSharePolicy,
  shareBefore: auxShare, shareAfter: auxShare,
  counters: auxList(4, one => auxObject(one, ['changed', 'deliveryCountSemanticsClaimed'], { before: auxCounter, after: auxCounter })),
  inventory: auxInventoryEffect, reward: auxRewardEffect, opportunity: auxOpportunity,
  beforeBoard: auxEnterBoard, afterBoard: auxEnterBoard, capability: auxCapability });
const auxProof = value => auxObject(value, ['version', 'leaseRef', 'operationId', 'bridgeFingerprint', 'officialUid'], {
  originalContext: auxContext, newContext: auxContext, after: one => auxObject(one, BINDING),
  oldPhysicalCloseReceipt: one => auxObject(one, ['closed', 'connectionEpoch', 'closureEvidenceRef']), newLogin: auxLoginSource });
const auxEvidence = value => auxObject(value, ['version', 'operationId', 'targetRef', 'lifecycleRef', 'targetFingerprint', 'reasonCode',
  'businessCounterOrClaimFlagAloneConfirmsNothing', 'verificationVersion', 'businessVerdict'], {
  answer: auxSource, postRead: auxSource, bridge: auxProof, effect: auxEffect,
  member: one => auxObject(one, ['memberKey', 'verdict', 'reasonCode']), resourceResolutions: auxList(0),
  transportTermination: one => auxObject(one, ['ended', 'source', 'operationId', ...BINDING]) });
const auxVerificationVersion = value => typeof value === 'string' &&
  /^order-flower-(video|reward|enter)-verification\/after-close-v1$/.test(value);

export function projectOrderFlowerAuxiliaryPreparation(value) {
  if (!plainObject(value) || !AUX_KINDS.has(value.kind) || !value.beforeInventory) return { value: null, complete: false };
  const out = auxObject(value, ['kind', 'officialUid', 'lifecycleRef', 'targetFingerprint', 'contentFingerprint', 'boxId', 'target',
    'wireArgsFingerprint', 'taskId', 'adSlotTag'], { source: auxSource, versionEvidence: auxVersion, day: auxDay, beforeInventory: auxInventory,
    beforeOrder: auxOrder, videoReward: one => auxNumMap(one, 128), beforeShare: auxShare, beforeCounters: auxList(4, auxCounter),
    beforeState: auxBeforeState, opportunity: auxOpportunity, eligibility: auxEligibility, occurrence: auxOccurrence, capability: auxCapability,
    stockPlanning: auxStockPlanning, publicArgs: one => auxObject(one, ['shareId'], { ext: ext => auxObject(ext, ['opType', 'id']) }) });
  return { value: out, complete: canonical(out) === canonical(value) };
}

export function projectOrderFlowerAuxiliaryVerification(value) {
  if (value == null) return { value: value ?? null, complete: value === null };
  if (!plainObject(value)) return { value: null, complete: false };
  const out = Object.hasOwn(value, 'evidence') ? auxObject(value, ['verdict', 'verificationVersion', 'reasonCode', 'postReadRef'], {
    member: one => auxObject(one, ['memberKey', 'verdict', 'reasonCode']), resourceResolutions: auxList(0), evidence: auxEvidence }) : auxEvidence(value);
  return { value: out, complete: canonical(out) === canonical(value) };
}

export function orderFlowerAuditDomain(operation) {
  const definition = Object.values(ORDER_FLOWER_CONTRACTS).find(one => one.featureId === operation?.feature_id &&
    one.scope === operation.scope && one.method === operation.method);
  return definition ? 'order-flower-' + definition.kind : null;
}

const LATER_ORDER_BASIS = 'order-flower/later-generation-after-exact-closed-execution/v1';
const CURRENT_NEED_ORDER_BASIS = 'order-flower/current-need-after-exact-closed-execution/v1';
const admissionCheckpoint = value => auxObject(value, [...ORDER_FLOWER_AXES, 'executorRef', 'source', 'uid', 'serverId',
  'requestSequence', 'responseRef', 'wireKey', 'receivedDeviceMs', 'receivedMonotonicMs', 'serverRespondedMs', 'observedAt',
  'identityRef', 'accountVerificationRef', 'verificationRef']);
const admissionOriginal = value => auxObject(value, ['kind', 'operationId', 'ownerRef', 'accountRef', 'subjectRef', 'originalFingerprint',
  'semanticKey', 'featureId', 'method', 'runEpoch', 'connectionEpoch', 'ownerEpoch', 'executorRef', 'preparedAt', 'transportState', 'businessVerdict', 'writeSlot'], {
  lifecycleTargetMetadata: one => auxObject(one, [], {
    targets: auxList(6, target => auxObject(target, ['memberKey', 'targetKind', 'targetRef', 'lifecycleRef', 'targetFingerprint'])),
    targetBasis: target => auxObject(target, ['landId', 'semanticVersion', 'cropRef', 'lifecycleRef', 'flowerId', 'plantTime', 'harvestCnt', 'status', 'state', 'emptyRef']) }) });
const admissionPrevious = value => auxObject(value, ['kind', 'closed', 'executionClosed', ...ORDER_FLOWER_AXES, 'executorRef',
  'evidenceRef', 'evidenceHash', 'sourceRef', 'recordedAt'], { controlledSnapshot: one => auxObject(one,
  ['leaseRef', 'bridgeFingerprint', 'closingOperationId', 'answerEvidenceRef', 'answerEvidenceHash', 'verifiedNewLoginRef', 'verifiedNewConnectionEpoch'], {
    ordinaryOrderEvidence: row => auxObject(row, ['domain', 'contractEvidenceRef', 'contractEvidenceHash', 'preparationEvidenceRef', 'preparationEvidenceHash']) }) });
const admissionIsolation = value => auxObject(value, ['version', 'available', 'reasonCode', 'receiptRef', 'receiptHash', 'outcomeProven', 'resourceCoverageProven'], {
  currentCheckpoint: admissionCheckpoint, previousExecution: admissionPrevious, original: admissionOriginal });

// Read-only projection for a fresh current-need association. Old optional
// preparation metadata remains absent; the new claim and exact reconciliation
// receipt prove only a new current decision, never historical success.
export function projectOrderFlowerCurrentNeedAdmission({ store, operation, basisRow, affected, evidence,
  referenceOriginalJson, referenceOriginalFingerprint } = {}) {
  const unavailable = reasonCode => ({ associated: false, complete: false, reasonCode });
  try {
    const current = operation?.original, old = parseStored(referenceOriginalJson, '当前需求关联原操作');
    // Business preparations are append-only gateway evidence, not part of the
    // ledger's generic immutable original. Read the actual production shape
    // and verify its stored evidence fingerprint before trusting currentNeed.
    const currentEvidenceRows = current && operation?.operation_id ? store.all(`SELECT kind,source,payload_json,payload_fingerprint,observed_at
      FROM backend_operation_evidence WHERE operation_id=? AND source='backend/write-gateway/v2'
      AND kind IN ('finite-domain-preparation','admitted-operation-contract') ORDER BY evidence_id`, operation.operation_id) : [];
    const currentEvidence = currentEvidenceRows.map(row => {
      const payload = parseStored(row.payload_json, '当前订单准备证据');
      if (ledgerJsonFingerprint({ kind: row.kind, source: row.source, payload, observedAt: row.observed_at }) !== row.payload_fingerprint) {
        throw new Error('CURRENT_PREPARATION_FINGERPRINT_INVALID');
      }
      return { kind: row.kind, payload };
    });
    const currentPreparations = currentEvidence.filter(one => one.kind === 'finite-domain-preparation');
    const currentContracts = currentEvidence.filter(one => one.kind === 'admitted-operation-contract');
    const currentPreparation = currentPreparations.length === 1 ? currentPreparations[0].payload : null;
    const currentContract = currentContracts.length === 1 ? currentContracts[0].payload : null;
    const preparedOrder = currentPreparation?.preparation;
    const definition = ORDER_FLOWER_CONTRACTS[preparedOrder?.kind];
    const preparationValid = !!(definition && currentPreparation?.domain === 'order-flower-' + preparedOrder.kind && currentContract?.contractId === definition.contractId &&
      current?.featureId === definition.featureId && current?.scope === definition.scope && current?.method === definition.method &&
      preparedOrder.lifecycleRef === current?.targets?.[0]?.lifecycleRef && preparedOrder.currentNeed?.necessary === true &&
      preparedOrder.currentNeed?.featureId === definition.featureId && preparedOrder.currentNeed?.targetRef === current?.targets?.[0]?.targetRef &&
      preparedOrder.currentNeed?.claimRef && preparedOrder.currentNeed?.decisionGeneration);
    const need = preparationValid ? preparedOrder.currentNeed : null;
    const target = current?.targets?.[0];
    const oldOperation = old?.operationId && store.get(`SELECT operation_id,owner_ref,account_ref,subject_ref,run_epoch,connection_epoch,feature_id,scope,method,
      params_fingerprint,original_json,original_fingerprint,business_verdict,write_slot,transport_state FROM backend_operations WHERE operation_id=?`, old.operationId);
    if (!current || !target || current.targets.length !== 1 || ledgerJsonFingerprint(current) !== operation.original_fingerprint ||
      ledgerJsonFingerprint(old) !== referenceOriginalFingerprint || old.operationId !== basisRow.operation_id || !oldOperation ||
      hashLedgerBytes(oldOperation.original_json) !== referenceOriginalFingerprint ||
      ledgerJsonFingerprint(parseStored(oldOperation.original_json, '当前需求账本原件')) !== referenceOriginalFingerprint ||
      oldOperation.business_verdict !== 'unknown' || oldOperation.write_slot !== 0 ||
      !['answered', 'terminated', 'unknown'].includes(oldOperation.transport_state) ||
      oldOperation.owner_ref !== current.ownerRef || oldOperation.subject_ref !== current.subjectRef ||
      oldOperation.feature_id !== current.featureId || oldOperation.scope !== current.scope || oldOperation.method !== current.method ||
      old.ownerRef !== current.ownerRef || old.subjectRef !== current.subjectRef || old.featureId !== current.featureId ||
      old.scope !== current.scope || old.method !== current.method ||
      basisRow.reason_code !== 'ORDER_FLOWER_CURRENT_NEED_AFTER_EXACT_CLOSED_EXECUTION' || basisRow.conclusion !== 'permit_current' ||
      basisRow.subject_ref !== current.subjectRef || evidence?.version !== CURRENT_NEED_ORDER_BASIS || !need || need.necessary !== true ||
      current.semanticKey !== 'order-flower-finish:' + preparedOrder.lifecycleRef + ':current-need:' + need.decisionGeneration ||
      evidence.claimRef !== need.claimRef || evidence.decisionGeneration !== need.decisionGeneration ||
      affected?.currentOperationId !== operation.operation_id || affected.currentNeedClaimRef !== need.claimRef ||
      affected.currentNeedDecisionGeneration !== need.decisionGeneration || affected.targetRef !== target.targetRef ||
      affected.lifecycleRef !== target.lifecycleRef || target.lifecycleRef !== preparedOrder.lifecycleRef || affected.originalOutcomeUnchanged !== true ||
      affected.originalResourceFootprintsUnchanged !== true || basisRow.constraint_key !== target.targetRef ||
      old.targets?.some(one => one.target_ref === target.targetRef || one.targetRef === target.targetRef) !== true) {
      return unavailable('ORDER_ADMISSION_CURRENT_NEED_BINDING_INVALID');
    }
    const claim = store.get('SELECT * FROM backend_current_need_claims WHERE claim_ref=?', need.claimRef);
    const ownershipEvents = store.all(`SELECT event_ref,decision_generation,evidence_json,evidence_fingerprint FROM backend_current_need_claim_owner_events
      WHERE claim_ref=? AND new_operation_id=? AND decision_generation=? ORDER BY recorded_at`, need.claimRef, operation.operation_id, need.decisionGeneration);
    const hadOwnership = ownershipEvents.some(row => {
      const event = parseStored(row.evidence_json, '当前需求所有权历史');
      return event.claimRef === need.claimRef && event.operationId === operation.operation_id &&
        event.decisionGeneration === need.decisionGeneration && fingerprint(event) === row.evidence_fingerprint &&
        row.event_ref === 'current-need-claim-use:' + row.evidence_fingerprint;
    });
    const reconciliation = store.get(`SELECT * FROM backend_current_need_reconciliations
      WHERE claim_ref=? AND original_operation_id=?`, need.claimRef, old.operationId);
    if (!claim || claim.owner_ref !== current.ownerRef || claim.subject_ref !== current.subjectRef || claim.account_ref !== String(current.accountRef) ||
      claim.feature_id !== current.featureId || claim.target_ref !== target.targetRef || claim.business_need_ref !== need.businessNeedRef ||
      !hadOwnership || !reconciliation ||
      reconciliation.original_fingerprint !== referenceOriginalFingerprint || reconciliation.target_ref !== target.targetRef ||
      reconciliation.feature_id !== current.featureId || reconciliation.current_need_ref !== need.needRef ||
      reconciliation.current_snapshot_ref !== claim.current_snapshot_ref || evidence.reconciliationRef !== reconciliation.reconciliation_ref) return unavailable('ORDER_ADMISSION_CURRENT_NEED_RECEIPT_MISSING');
    const reconciliationEvidence = parseStored(reconciliation.evidence_json, '当前需求旧操作关联');
    if (fingerprint(reconciliationEvidence) !== reconciliation.evidence_fingerprint || reconciliationEvidence.claimRef !== need.claimRef ||
      reconciliationEvidence.originalOperationId !== old.operationId || reconciliationEvidence.originalFingerprint !== referenceOriginalFingerprint ||
      reconciliationEvidence.originalVerdictUnchanged !== 'unknown' || reconciliationEvidence.currentDecisionSnapshotRef !== claim.current_snapshot_ref) {
      return unavailable('ORDER_ADMISSION_CURRENT_NEED_RECEIPT_INVALID');
    }
    const legacyReconciliation = [undefined, 'current-need-reconciliation/v1'].includes(reconciliationEvidence.version) &&
      reconciliationEvidence.closureKind === undefined && reconciliationEvidence.isolationReceiptHash === undefined;
    if (!currentNeedClosureStoredMatches(store, oldOperation, old, reconciliationEvidence) || !legacyReconciliation &&
        (!/^[a-f0-9]{64}$/.test(reconciliationEvidence.isolationReceiptHash || '') ||
          !/^current-isolation:[a-f0-9]{64}$/.test(reconciliationEvidence.isolationReceiptRef || ''))) {
      return unavailable('ORDER_ADMISSION_CURRENT_NEED_CLOSURE_INVALID');
    }
    const projectedAffected = auxObject(affected, ['targetRef', 'lifecycleRef', 'currentOperationId', 'currentNeedClaimRef',
      'currentNeedDecisionGeneration', 'originalOutcomeUnchanged', 'originalResourceFootprintsUnchanged']);
    const projectedEvidence = auxObject(evidence, ['version', 'oldLifecycleRef', 'oldTime', 'currentTime', 'claimRef',
      'decisionGeneration', 'reconciliationRef', 'originalPreparationFingerprint', 'originalContractFingerprint'], {
      isolation: admissionIsolation, currentOrderSource: auxSource });
    const complete = canonical(projectedAffected) === canonical(affected) && canonical(projectedEvidence) === canonical(evidence);
    return { associated: true, complete, reasonCode: complete ? null : 'ORDER_ADMISSION_CURRENT_NEED_PROJECTION_INCOMPLETE',
      affected: projectedAffected, evidence: projectedEvidence, associationContract: CURRENT_NEED_ORDER_BASIS,
      priorPreparationMetadataAvailable: Number.isSafeInteger(evidence.oldTime) };
  } catch { return unavailable('ORDER_ADMISSION_CURRENT_NEED_EVIDENCE_UNREADABLE'); }
}

// A read-only association for the exact finite modern order basis. This does
// not admit a write, modify an old basis, or turn isolation into a verdict.
export function projectOrderFlowerLaterAdmission({ store, operation, preparation, basisRow, factBasis, affected, evidence,
  referenceOriginalJson, referenceOriginalFingerprint } = {}) {
  const unavailable = reasonCode => ({ associated: false, complete: false, reasonCode });
  try {
    const definition = ORDER_FLOWER_CONTRACTS[preparation?.kind], target = operation?.original?.targets?.[0],
      own = operation?.original, old = parseStored(referenceOriginalJson, '订单准入原引用'), iso = evidence?.isolation;
    if (!definition || orderFlowerAuditDomain(operation) !== 'order-flower-' + preparation.kind || !target || own.targets.length !== 1 ||
      ledgerJsonFingerprint(own) !== operation.original_fingerprint || ledgerJsonFingerprint(old) !== referenceOriginalFingerprint ||
      !same(old, own, ['ownerRef', 'subjectRef', 'featureId', 'scope', 'method']) || old.operationId !== basisRow.operation_id ||
      basisRow.subject_ref !== own.subjectRef || canonical(factBasis) !== canonical(operation.factBasis) || canonical(own.factBasis) !== canonical(factBasis) ||
      Object.hasOwn(affected || {}, 'candidateFingerprint') || affected?.targetRef !== target.targetRef || affected.lifecycleRef !== target.lifecycleRef ||
      affected.originalOutcomeUnchanged !== true || affected.originalResourceFootprintsUnchanged !== true ||
      !old.targets?.some(one => one.targetRef === target.targetRef && one.lifecycleRef !== target.lifecycleRef) ||
      basisRow.constraint_key !== target.targetRef || basisRow.conclusion !== 'permit_current' ||
      basisRow.reason_code !== 'ORDER_FLOWER_GENUINE_LATER_SERVER_OCCURRENCE' || evidence?.version !== LATER_ORDER_BASIS) return unavailable('ORDER_ADMISSION_FINITE_CANDIDATE_MISMATCH');
    assertOrderFlowerProposal({ ...own, featureCancelEpoch: own.cancelEpoch, params: preparation.kind === 'resident' ? { boxId: preparation.boxId } : {}, orderFlower: preparation });
    const rows = store.all(`SELECT kind,source,payload_json,payload_fingerprint,observed_at FROM backend_operation_evidence
      WHERE operation_id=? AND source='backend/write-gateway/v2' AND kind IN ('finite-domain-preparation','admitted-operation-contract') LIMIT 3`, old.operationId);
    const decoded = rows.map(row => ({ ...row, payload: parseStored(row.payload_json, '订单准入原有限证据') }));
    if (decoded.some(row => ledgerJsonFingerprint({ kind: row.kind, source: row.source, payload: row.payload, observedAt: row.observed_at }) !== row.payload_fingerprint)) return unavailable('ORDER_ADMISSION_ORIGINAL_EVIDENCE_HASH_INVALID');
    const prepared = decoded.filter(row => row.kind === 'finite-domain-preparation'), contracts = decoded.filter(row => row.kind === 'admitted-operation-contract'), previous = prepared[0]?.payload?.preparation;
    if (prepared.length !== 1 || contracts.length !== 1 || prepared[0].payload.domain !== 'order-flower-' + preparation.kind ||
      !orderFlowerHistoricalAdmittedContractMatches(contracts[0].payload, definition) ||
      fingerprint(prepared[0].payload) !== evidence.originalPreparationFingerprint || fingerprint(contracts[0].payload) !== evidence.originalContractFingerprint ||
      previous?.lifecycleRef !== evidence.oldLifecycleRef || previous.lifecycleRef === preparation.lifecycleRef ||
      previous.beforeOrder?.cTime !== evidence.oldTime || preparation.beforeOrder.cTime !== evidence.currentTime ||
      !Number.isSafeInteger(evidence.oldTime) || evidence.oldTime <= 0 || evidence.currentTime <= evidence.oldTime ||
      canonical(evidence.currentOrderSource) !== canonical(preparation.source)) return unavailable('ORDER_ADMISSION_ORIGINAL_PREPARATION_BINDING_INVALID');
    assertOrderFlowerProposal({ ...old, featureCancelEpoch: old.cancelEpoch, params: preparation.kind === 'resident' ? { boxId: previous.boxId } : {}, orderFlower: previous });
    const checkpoint = iso?.currentCheckpoint, previousExecution = iso?.previousExecution;
    if (iso?.version !== 'current-execution-isolation/v1' || iso.available !== true || iso.reasonCode !== null ||
      iso.outcomeProven !== false || iso.resourceCoverageProven !== false || !same(checkpoint, own, ORDER_FLOWER_AXES) ||
      checkpoint.executorRef !== own.executorRef || checkpoint.source !== 'current-matched-official-login' || checkpoint.uid !== preparation.officialUid ||
      !same(checkpoint, preparation.source, BINDING) || previousExecution?.closed !== true || previousExecution.executionClosed !== true ||
      !same(previousExecution, old, [...ORDER_FLOWER_AXES, 'executorRef']) ||
      !['backend-physical-closure', 'backend-native-executor-exit'].includes(previousExecution.kind) ||
      iso.original?.kind !== 'backend' || iso.original.operationId !== old.operationId || iso.original.originalFingerprint !== referenceOriginalFingerprint ||
      !same(iso.original, old, [...ORDER_FLOWER_AXES, 'executorRef', 'semanticKey', 'featureId', 'method'])) return unavailable('ORDER_ADMISSION_EXACT_ISOLATION_BINDING_INVALID');
    const receipt = pick(iso, ['version', 'currentCheckpoint', 'previousExecution', 'original', 'outcomeProven', 'resourceCoverageProven']);
    if (iso.receiptHash !== fingerprint(receipt) || iso.receiptRef !== 'current-isolation:' + iso.receiptHash ||
      basisRow.basis_key !== fingerprint([own.semanticKey, factBasis, iso.receiptHash])) return unavailable('ORDER_ADMISSION_ISOLATION_RECEIPT_HASH_INVALID');
    if (previousExecution.kind === 'backend-physical-closure') {
      const closure = store.get(`SELECT proof_kind,proof_json FROM backend_session_connection_closures
        WHERE evidence_ref=? AND owner_ref=? AND account_ref=? AND subject_ref=? AND owner_epoch=? AND run_epoch=? AND connection_epoch=? AND executor_ref=?`,
      previousExecution.evidenceRef, old.ownerRef, old.accountRef, old.subjectRef, old.ownerEpoch, old.runEpoch, old.connectionEpoch, old.executorRef);
      const proof = closure && parseStored(closure.proof_json, '订单原连接关闭审计依据');
      if (!proof || !['transport-closed', 'verification-snapshot-physical-close'].includes(closure.proof_kind) || proof.closed !== true ||
        proof.connectionEpoch !== old.connectionEpoch || proof.source !== previousExecution.sourceRef || fingerprint(proof) !== previousExecution.evidenceHash) {
        return unavailable('ORDER_ADMISSION_PHYSICAL_CLOSE_SOURCE_UNPROVEN');
      }
    } else {
      const isolation = store.get('SELECT source_ref,proof_json FROM backend_executor_isolation WHERE subject_ref=? AND evidence_ref=?',
        old.subjectRef, previousExecution.evidenceRef), proof = isolation && parseStored(isolation.proof_json, '订单原执行方退出审计依据');
      if (!proof || isolation.source_ref !== previousExecution.sourceRef || fingerprint(proof) !== previousExecution.evidenceHash ||
        proof.nativeExecutorExited !== true || proof.stopped !== true || proof.currentInFlight !== false ||
        proof.executorRef !== old.executorRef || proof.ownerEpoch !== old.ownerEpoch) return unavailable('ORDER_ADMISSION_EXECUTOR_EXIT_SOURCE_UNPROVEN');
    }
    const projectedAffected = auxObject(affected, ['targetRef', 'lifecycleRef', 'originalOutcomeUnchanged', 'originalResourceFootprintsUnchanged']);
    const projectedProof = auxObject(evidence, ['version', 'oldLifecycleRef', 'oldTime', 'currentTime', 'originalPreparationFingerprint', 'originalContractFingerprint'],
      { isolation: admissionIsolation, currentOrderSource: auxSource });
    const complete = canonical(projectedAffected) === canonical(affected) && canonical(projectedProof) === canonical(evidence);
    return { associated: true, complete, reasonCode: complete ? null : 'ORDER_ADMISSION_FINITE_PROJECTION_INCOMPLETE',
      affected: projectedAffected, evidence: projectedProof, associationContract: LATER_ORDER_BASIS };
  } catch { return unavailable('ORDER_ADMISSION_FINITE_EVIDENCE_UNREADABLE'); }
}

export function projectOrderFlowerPreparation(value) {
  if (value == null) return { value: null, complete: false, beforeLevelRewardItems: { total: 0, returned: 0, limit: 118, complete: false } };
  if (value.beforeInventory && AUX_KINDS.has(value.kind)) return projectOrderFlowerAuxiliaryPreparation(value);
  const out = pick(value, ['kind', 'boxId', 'lifecycleRef', 'contentFingerprint', 'officialUid', 'limit', 'eligibilityFingerprint', 'deliveryPath']);
  let accountingComplete = true;
  if (Object.hasOwn(value, 'beforeStored')) { const projected = projectOrderFlowerStoredBefore(value.beforeStored);
    out.beforeStored = projected.value; accountingComplete = projected.complete; }
  out.beforeOrder = plainOrder(value.beforeOrder);
  out.source = orderFlowerAuditSource(value.source);
  out.versionEvidence = pick(value.versionEvidence, VERSION);
  out.beforeItems = bounded(value.beforeItems, 16, one => projectSourceFields(one, ['itemId', 'quantity', 'basisRef']));
  for (const [key, names] of Object.entries({ beforeProfile: ['gold', 'yb', 'level', 'lvlExp'], beforeRewards: ['satin', 'decorate'] })) {
    out[key] = projectSourceFields(value[key], names);
    if (value[key] && Object.hasOwn(value[key], 'sources')) out[key].sources = Object.fromEntries(names.filter(name =>
      Object.hasOwn(value[key].sources || {}, name)).map(name => [name, orderFlowerAuditSource(value[key].sources[name])]));
  }
  // The complete source catalog contains 118 distinct reward IDs. Preserve
  // every original item/source in original order; public 32-row limits do not
  // apply to this immutable before-basis.
  out.beforeLevelRewardItems = bounded(value.beforeLevelRewardItems, 118, one => projectSourceFields(one, ['itemId', 'quantity']));
  const levelComplete = Array.isArray(value.beforeLevelRewardItems) && value.beforeLevelRewardItems.length === ORDER_FLOWER_LEVEL_REWARD_ITEM_IDS.length &&
    new Set(value.beforeLevelRewardItems.map(one => one?.itemId)).size === ORDER_FLOWER_LEVEL_REWARD_ITEM_IDS.length &&
    value.beforeLevelRewardItems.every(one => ORDER_FLOWER_LEVEL_REWARD_ITEM_IDS.includes(one?.itemId));
  out.counter = projectSourceFields(value.counter, ['known', 'counterId', 'raw', 'total', 'rawRTime', 'effective', 'value', 'offset', 'uiDisplayValue',
    'countRule', 'dayKey', 'dayProofRef', 'originalCounterUnchanged']);
  if (value.counter && Object.hasOwn(value.counter, 'cellProofs') && plainObject(value.counter.cellProofs) && Object.keys(value.counter.cellProofs).length <= 8) {
    out.counter.cellProofs = Object.fromEntries(Object.entries(value.counter.cellProofs).filter(([key, proof]) => /^[A-Za-z0-9_.-]{1,64}$/.test(key) &&
      plainObject(proof) && Object.hasOwn(proof, 'value') && Object.hasOwn(proof, 'source')).map(([key, proof]) =>
      [key, { value: proof.value, source: orderFlowerAuditSource(proof.source) }]));
  }
  if (Object.hasOwn(value, 'currentNeed')) {
    out.currentNeed = pick(value.currentNeed, ['necessary', 'featureId', 'targetRef', 'businessNeedRef', 'needRef', 'decisionGeneration', 'semanticFingerprint', 'claimRef']);
    if (Object.hasOwn(value.currentNeed || {}, 'basisRefs')) out.currentNeed.basisRefs = bounded(value.currentNeed.basisRefs, 16,
      one => typeof one === 'string' && one.length <= 512 ? one : null);
  }
  out.beforeGenerationCounter = projectSourceFields(value.beforeGenerationCounter, ['uid', 'type', 'raw', 'totCnt', 'rTime']);
  out.beforeOtherCounters = bounded(value.beforeOtherCounters, 2, one => projectSourceFields(one, ['uid', 'type', 'raw', 'totCnt', 'rTime']));
  out.keepPolicy = pick(value.keepPolicy, ['known', 'keep', 'policyRef']);
  out.day = day(value.day);
  if (value.occurrence) out.occurrence = { ...pick(value.occurrence, ['kind', 'boxId', 'lifecycleRef', 'contentFingerprint', 'identityKnown', 'priorLifecycleRef', 'boundaryKind']),
    firstSource: orderFlowerAuditSource(value.occurrence.firstSource), source: orderFlowerAuditSource(value.occurrence.source),
    context: pick(value.occurrence.context, ORDER_FLOWER_AXES) };
  if (Object.hasOwn(value, 'policyCount')) {
    const policy = value.policyCount;
    out.policyCount = { ...pick(policy, ['version', 'known', 'kind', 'officialUid', 'dayKey', 'value', 'confirmedFloor', 'floorReceiptRef', 'floorFingerprint',
      'originalOfficialCounterUnchanged', 'unknownCountedAsConfirmed', 'currentAdmissionRecheckRequired', 'readOnly', 'writeEligible', 'proofRef']),
      context: pick(policy?.context, ORDER_FLOWER_AXES), day: pick(policy?.day, ['key', 'startMs', 'endMs', 'utcOffsetMinutes', 'dayKey', 'officialUid',
        'originalDayReceiptRef', 'originalDayFingerprint', 'proofRef', 'source']), serverCount: projectServerCount(policy?.serverCount) };
  }
  return { value: out, complete: accountingComplete && levelComplete && canonical(out) === canonical(value),
    beforeLevelRewardItems: { total: Array.isArray(value.beforeLevelRewardItems) ? value.beforeLevelRewardItems.length : null,
      returned: out.beforeLevelRewardItems?.length ?? 0, limit: 118, complete: levelComplete } };
}

export function projectOrderFlowerVerification(value) {
  if (value == null) return { value: value ?? null, complete: value === null };
  if (auxVerificationVersion(value.version) || auxVerificationVersion(value.verificationVersion) && auxVerificationVersion(value.evidence?.version)) {
    return projectOrderFlowerAuxiliaryVerification(value);
  }
  const out = pick(value, ['version', 'operationId', 'reasonCode', 'kind', 'boxId', 'targetRef', 'lifecycleRef', 'contentFingerprint',
    'counterOrOrderChangeAloneConfirmsNothing', 'resourceCoverageApplied', 'verificationVersion', 'businessVerdict']);
  if (Object.hasOwn(value, 'traceId') && typeof value.traceId === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value.traceId)) out.traceId = value.traceId;
  let accountingComplete = true;
  if (Object.hasOwn(value, 'storedAccounting')) { const projected = projectOrderFlowerStoredEffect(value.storedAccounting);
    out.storedAccounting = projected.value; accountingComplete = projected.complete; }
  if (Object.hasOwn(value, 'member')) out.member = pick(value.member, ['memberKey', 'verdict', 'reasonCode']);
  if (Object.hasOwn(value, 'resourceResolutions')) out.resourceResolutions = bounded(value.resourceResolutions, 16,
    one => pick(one, ['resourceKey', 'state', 'basisRefs', 'coverageRef']));
  if (Object.hasOwn(value, 'transportTermination')) out.transportTermination = pick(value.transportTermination,
    ['ended', 'operationId', 'source', ...BINDING]);
  for (const key of ['beforeOrder', 'afterOrder']) if (Object.hasOwn(value, key)) out[key] = plainOrder(value[key]);
  for (const key of ['answer', 'postRead']) if (Object.hasOwn(value, key)) out[key] = orderFlowerAuditSource(value[key]);
  if (Object.hasOwn(value, 'flows')) out.flows = value.flows === null ? null : Object.fromEntries(['bi', 'bo', 'bd', 'actBi', 'actBo', 'proxyBi', 'proxyBo']
    .filter(key => Object.hasOwn(value.flows || {}, key)).map(key => [key, { ...pick(value.flows[key],
      ['supplied', 'readable', 'totalPositiveEntries', 'complete', 'mapFingerprint']), entries: bounded(value.flows[key]?.entries, 32, one => pick(one, ['itemId', 'quantity'])) }]));
  if (Object.hasOwn(value, 'costs')) out.costs = value.costs === null ? null : bounded(value.costs, 16, one => projectSourceFields(one,
    ['itemId', 'quantity', 'before', 'after', 'bo', 'bi', 'bd', 'basisRef']));
  if (Object.hasOwn(value, 'rewards')) {
    const rewards = value.rewards;
    out.rewards = rewards === null ? null : pick(rewards, ['mainItemId', 'mainQuantity', 'experienceQuantity', 'mainQuantityScope']);
    if (rewards) {
      out.rewards.ordinaryMainQuantityRange = pick(rewards.ordinaryMainQuantityRange, ['lowerBound', 'upperBound']);
      const transition = rewards.experienceTransition;
      out.rewards.experienceTransition = { ...pick(transition, ['known', 'reasonCode', 'experienceQuantity', 'crossedLevels', 'candidatePresenceProvesNoGrant']),
        before: pick(transition?.before, ['level', 'lvlExp', 'coordinate']), after: pick(transition?.after, ['level', 'lvlExp', 'coordinate']),
        rewardCandidates: bounded(transition?.rewardCandidates, 118, one => pick(one, ['itemId', 'maximumQuantity'])),
        source: { ...pick(transition?.source, ['version', 'gameVersion', 'protocolVersion', 'catalogSha256', 'table', 'tableSha256',
          'gameDecodedSha256', 'tableDecodeSourceSha256', 'tableDecodeHelperSha256', 'rewardSemantics']),
          experienceRule: pick(transition?.source?.experienceRule, ['rangeConvention', 'start', 'end', 'sha256']) } };
      out.rewards.observedLevelRewards = bounded(rewards.observedLevelRewards, 118, one => projectSourceFields(one,
        ['itemId', 'quantity', 'maximumQuantity', 'before', 'after', 'spent', 'bd']));
      out.rewards.profile = { before: pick(rewards.profile?.before, ['gold', 'yb', 'level', 'lvlExp']), after: pick(rewards.profile?.after, ['gold', 'yb', 'level', 'lvlExp']) };
      for (const key of ['satin', 'decorate']) out.rewards[key] = pick(rewards[key], ['before', 'after']);
      out.rewards.propertyMappings = pick(rewards.propertyMappings, ['1', '2', '11']);
    }
  }
  if (Object.hasOwn(value, 'counts')) {
    const counts = value.counts, projectCount = one => pick(one, ['uid', 'type', 'raw', 'total', 'totCnt', 'rTime', 'effective', 'offset', 'value', 'uiDisplayValue']);
    out.counts = counts === null ? null : { ...pick(counts, ['counterId', 'projectionKind', 'projectionDelta', 'rawGenerationIncrement', 'serviceDeliveryCounterClaimed']),
      before: projectCount(counts.before), after: projectCount(counts.after), generationBefore: projectCount(counts.generationBefore), generationAfter: projectCount(counts.generationAfter),
      otherCounters: bounded(counts.otherCounters, 2, one => ({ before: projectCount(one.before), after: projectCount(one.after) })) };
  }
  if (Object.hasOwn(value, 'targetEffect')) out.targetEffect = value.targetEffect === null ? null : pick(value.targetEffect, ['kind', 'boxId', 'originalLifecycleRef',
    'originalContentFingerprint', 'newContentFingerprint', 'cooldownBefore', 'cooldownAfter', 'newOccurrenceIdentityCreatedByVerifier']);
  if (Object.hasOwn(value, 'day')) out.day = pick(value.day, ['key', 'startMs', 'endMs', 'proofRef', 'timezoneProofFingerprint']);
  if (Object.hasOwn(value, 'bridge')) out.bridge = pick(value.bridge, ['leaseRef', 'bridgeFingerprint', 'closureEvidenceRef', 'originalConnectionEpoch',
    'newConnectionEpoch', 'writeResponseRef', 'newLoginResponseRef']);
  return { value: out, complete: accountingComplete && canonical(out) === canonical(value) };
}

function row(value) {
  if (value == null) return value ?? null;
  const out = pick(value, ['presence', 'state', 'reasonCode', 'rawType', 'readable', 'contentFingerprint', 'fingerprintKind']);
  if (value.value === null) out.value = null;
  else if (value.value) {
    const cells = value.value.fields || {};
    out.value = { ...pick(value.value, ['kind', 'boxId']), fields: Object.fromEntries(['npcId', 'dialogId', 'isVideo', 'cdTime', 'cTime', 'placeIdx', 'finishCnt']
      .filter(key => Object.hasOwn(cells, key)).map(key => [key, scalarCell(cells[key])])) };
    if (Object.hasOwn(cells, 'flowers')) out.value.fields.flowers = { ...pick(cells.flowers, CELL), value: bounded(cells.flowers.value, 16,
      pair => Array.isArray(pair) ? pair.slice(0, 2) : null) };
    // Video reward maps are outside this ordinary branch. Their presence and
    // hash remain visible without leaking an unrelated collection.
    if (Object.hasOwn(cells, 'videoRwd')) out.value.fields.videoRwd = { ...pick(cells.videoRwd, ['presence', 'state', 'reasonCode', 'rawType']),
      valueFingerprint: fingerprint(cells.videoRwd.value) };
  }
  return out;
}

export function readOrderFlowerTargetAudit({ store, operation, preparation, settlement, receipt, lease, bridgeEvidence, landPayloadFingerprint } = {}) {
  const missing = [], fail = label => { missing.push(label); return { observation: null, missing }; };
  const label = 'target-post-observation:' + settlement?.member_key;
  const definition = ORDER_FLOWER_CONTRACTS[preparation?.kind], target = operation?.targets?.find(one => one.member_key === settlement?.member_key)?.original;
  if (!definition || !target || !receipt || !lease || !bridgeEvidence || typeof landPayloadFingerprint !== 'function') return fail(label + ':finite-contract');
  if (ledgerJsonFingerprint(settlement.result) !== settlement.result_fingerprint) return fail(label + ':settlement-hash');
  const has = name => !!store.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name);
  const read = (text, name) => { try { return parseStored(text, name); } catch { return null; } };
  const evidenceValid = entry => {
    const payload = entry && read(entry.payload_json, '普通订单原证据');
    return payload && ledgerJsonFingerprint({ kind: entry.kind, source: entry.source, payload, observedAt: entry.observed_at }) === entry.payload_fingerprint ? payload : null;
  };
  const admittedRow = store.get(`SELECT kind,source,payload_json,payload_fingerprint,observed_at,evidence_id FROM backend_operation_evidence
    WHERE operation_id=? AND evidence_key='admitted-operation-contract:v1' AND kind='admitted-operation-contract' AND source='backend/write-gateway/v2'`, operation.operation_id);
  const preparedRow = store.get(`SELECT kind,source,payload_json,payload_fingerprint,observed_at,evidence_id FROM backend_operation_evidence
    WHERE operation_id=? AND evidence_key='finite-domain-preparation:v1' AND kind='finite-domain-preparation' AND source='backend/write-gateway/v2'`, operation.operation_id);
  const admitted = evidenceValid(admittedRow), prepared = evidenceValid(preparedRow);
  if (!orderFlowerHistoricalAdmittedContractMatches(admitted, definition) ||
    prepared?.domain !== 'order-flower-' + definition.kind || canonical(prepared.preparation) !== canonical(preparation) ||
    ledgerJsonFingerprint(operation.original) !== operation.original_fingerprint) return fail(label + ':original-preparation-hash');
  try { const proposal = { ...operation.original, orderFlower: preparation,
    params: definition.kind === 'resident' ? { boxId: preparation.boxId } : {} };
    assertOrderFlowerProposal(proposal); assertOrderFlowerStoredPreparation(proposal); }
  catch { return fail(label + ':original-preparation-binding'); }
  const next = receipt.newContext, login = receipt.newLoginSource;
  if (!same(receipt.originalContext, operation.original, ORDER_FLOWER_AXES) || !next || !login ||
      next.accountRef !== operation.account_ref || receipt.officialUid !== preparation.officialUid) return fail(label + ':original-subject');
  if (!has('backend_order_flower_observations') || !has('backend_land_domain_observations')) return fail(label + ':source-tables');
  const effectiveOrder = resolveOrderFlowerObservationEvidence({ store, context: next, requestSequence: login.requestSequence, responseRef: login.responseRef });
  const order = effectiveOrder?.row ?? null, frame = effectiveOrder?.frame ?? null;
  const payload = frame?.payload;
  if (!effectiveOrder?.accepted || !order || !frame?.admissible || !same(frame.context, next, ORDER_FLOWER_AXES) ||
      !same(frame.source, login, BINDING) || frame.source.method !== 'index.login' || frame.source.kind !== 'response' || frame.source.transport !== 'answered' ||
      effectiveOrder.wholeFrameFingerprint !== order.payload_fingerprint || effectiveOrder.payloadFingerprint !== frame.payloadFingerprint ||
      fingerprint(payload) !== frame.payloadFingerprint ||
      !known(payload?.profileUid) || !known(payload?.fields?.uid) || payload.profileUid.value !== receipt.officialUid || payload.fields.uid.value !== receipt.officialUid) {
    return fail(label + ':order-source-hash-or-identity');
  }
  const resident = payload.fields.residentMap, stock = payload.fields.stockMap, tdy = payload.fields.tdyMap;
  const completeMap = (cell, limit) => known(cell) && cell.value?.complete === true && Array.isArray(cell.value.entries) &&
    cell.value.total === cell.value.entries.length && cell.value.entries.length <= limit;
  if (!completeMap(resident, 6) || resident.value.decodedComplete !== true || !completeMap(stock, 8) || !completeMap(tdy, 8)) {
    return fail(label + ':provided-order-maps');
  }
  const selected = definition.kind === 'resident' ? resident.value.entries.find(one => one.value?.boxId === preparation.boxId) || null : payload.fields[definition.kind];
  if (definition.kind !== 'resident' && (!selected || selected.presence === 'missing')) return fail(label + ':scalar-property-not-supplied');
  const selectLand = (context, binding, method) => {
    const found = store.get(`SELECT observation_ref,payload_fingerprint,accepted,frame_json,recorded_at FROM backend_land_domain_observations
      WHERE owner_ref=? AND account_ref=? AND subject_ref=? AND connection_epoch=? AND request_sequence=? AND wire_key=? AND response_ref=?`,
    context.ownerRef, context.accountRef, context.subjectRef, context.connectionEpoch, binding.requestSequence, binding.wireKey, binding.responseRef);
    const decoded = found && read(found.frame_json, '普通订单物品白名单帧'), hash = landPayloadFingerprint(decoded);
    if (!found || found.accepted !== 1 || !decoded?.admissible || !same(decoded.context, context, ORDER_FLOWER_AXES) ||
        !same(decoded.source, binding, BINDING) || decoded.source.method !== method || decoded.source.kind !== 'response' || hash !== found.payload_fingerprint) return null;
    return { row: found, frame: decoded, hash };
  };
  const before = receipt.originalContext, answer = selectLand(before, receipt.after, operation.method), fresh = selectLand(next, login, 'index.login');
  if (!answer || !fresh) return fail(label + ':matched-item-source-hash');
  const bag = fresh.frame.bag, completeBag = known(bag) && fresh.frame.coverage?.bagComplete === true;
  const itemIds = [...new Set([...preparation.beforeItems.map(one => one.itemId), ...ORDER_FLOWER_LEVEL_REWARD_ITEM_IDS, 1106, 1340])].sort((a, b) => a - b);
  if (!completeBag || !known(fresh.frame.profile?.uid) || fresh.frame.profile.uid.value !== receipt.officialUid || itemIds.length > 136) return fail(label + ':absolute-bag');
  const items = itemIds.map(itemId => ({ itemId, cell: scalarCell(bag.items?.[itemId]),
    missingKeyProvenZero: !Object.hasOwn(bag.items || {}, String(itemId)) }));
  if (items.some(one => !one.missingKeyProvenZero && (!known(one.cell) || !Number.isSafeInteger(one.cell.value) || one.cell.value < 0))) return fail(label + ':absolute-items');
  const projectFlow = value => {
    const entries = plainObject(value?.items) ? Object.entries(value.items).map(([id, one]) => ({ itemId: Number(id), cell: scalarCell(one) })) : [];
    return { map: pick(value, ['presence', 'state', 'reasonCode', 'sourceRef']), valueFingerprint: value?.value == null ? null : fingerprint(value.value), total: entries.length, limit: 160,
      complete: entries.length <= 160, entries: entries.slice(0, 160) };
  };
  const itemSource = found => ({ observationRef: found.row.observation_ref, source: orderFlowerAuditSource(found.frame.source),
    accepted: true, recordedAt: found.row.recorded_at, payloadFingerprint: found.row.payload_fingerprint,
    derivedPayloadFingerprint: found.hash, storedFingerprintVerified: true, payloadHashContract: 'backend-land-domain/semantic-observation-v1',
    profile: Object.fromEntries(['uid', 'gold', 'yuanbao', 'level', 'lvlExp'].filter(key => Object.hasOwn(found.frame.profile || {}, key))
      .map(key => [key, scalarCell(found.frame.profile[key])])),
    flows: Object.fromEntries(['bi', 'bo', 'bd'].map(key => [key, projectFlow(found.frame[key])])) });
  const answerProjection = itemSource(answer), freshProjection = itemSource(fresh);
  if ([answerProjection, freshProjection].some(one => Object.values(one.flows).some(flow => !flow.complete))) missing.push(label + ':flow-limit');
  freshProjection.bag = { map: pick(bag, ['presence', 'state', 'reasonCode', 'sourceRef']), providedComplete: true,
    selectedItemCount: itemIds.length, limit: 136, complete: true, items };
  const projectedPreparation = projectOrderFlowerPreparation(preparation);
  if (!projectedPreparation.complete) missing.push(label + ':preparation-whitelist');
  const counter = value => Object.fromEntries(['domain', 'uid', 'type', 'tdyCnt', 'totCnt', 'rTime', 'uTime', 'cTime']
    .filter(key => Object.hasOwn(value || {}, key)).map(key => [key, scalarCell(value[key])]));
  const level = payload.financial?.levelRewardItems;
  const levelItems = known(level) && Array.isArray(level.value) ? level.value : [];
  const levelComplete = levelItems.length === 118 && new Set(levelItems.map(one => one?.itemId)).size === 118 &&
    levelItems.every(one => ORDER_FLOWER_LEVEL_REWARD_ITEM_IDS.includes(one?.itemId));
  if (!levelComplete) missing.push(label + ':level-reward-items');
  let generationCounter = null;
  if (has('backend_customer_observations')) {
    const customer = resolveAcceptedCustomerObservationEvidence({ store, context: next, requestSequence: login.requestSequence, responseRef: login.responseRef });
    const decoded = customer?.frame, count107 = decoded?.payload?.eligibilityInputs?.count107;
    if (customer?.accepted === true && decoded?.admissible && same(decoded.context, next, ORDER_FLOWER_AXES) && same(decoded.source, login, BINDING) &&
        fingerprint(decoded.payload) === customer.row.payload_fingerprint && ['domain', 'uid', 'type', 'tdyCnt', 'totCnt', 'rTime'].every(key => known(count107?.[key])) &&
        count107.uid.value === receipt.officialUid && count107.type.value === 107) {
      generationCounter = { observationRef: customer.row.observation_ref, recordedAt: customer.row.recorded_at, source: orderFlowerAuditSource(decoded.source),
        payloadFingerprint: customer.row.payload_fingerprint, storedFingerprintVerified: true, compatibilityRevalidationRef: customer.compatibilityRef ?? null,
        count107: counter(count107) };
    }
  }
  if (!generationCounter) missing.push(label + ':generation-counter-source');
  return { missing, observation: { kind: 'after-close-login', domain: 'order-flower-' + definition.kind, memberKey: settlement.member_key,
    target: pick(target, ['memberKey', 'targetKind', 'targetRef', 'lifecycleRef', 'targetFingerprint']), leaseRef: lease.lease_ref,
    bridgeFingerprint: lease.bridge_fingerprint, officialUid: receipt.officialUid,
    originalContext: pick(before, ORDER_FLOWER_AXES), newContext: pick(next, ORDER_FLOWER_AXES), write: pick(receipt.after, BINDING),
    newLogin: orderFlowerAuditSource(login), physicalClose: pick(receipt.oldPhysicalCloseReceipt, ['closed', 'connectionEpoch', 'closureEvidenceRef', 'code']),
    bridgeEvidenceId: bridgeEvidence.evidence_id, bridgeEvidenceFingerprint: bridgeEvidence.payload_fingerprint,
    settlementRef: settlement.settlement_key, settlementFingerprint: settlement.result_fingerprint,
    originalPreparation: { admittedEvidenceId: admittedRow.evidence_id, admittedFingerprint: admittedRow.payload_fingerprint,
      preparationEvidenceId: preparedRow.evidence_id, preparationFingerprint: preparedRow.payload_fingerprint, storedFingerprintsVerified: true,
      contractMatches: true, proposalBindingVerified: true, ...projectedPreparation },
    orderObservation: { observationRef: order.observation_ref, source: orderFlowerAuditSource(frame.source), accepted: true, recordedAt: order.recorded_at,
      storedFrameFingerprint: order.payload_fingerprint, payloadFingerprint: frame.payloadFingerprint, storedFingerprintVerified: true,
      uid: scalarCell(payload.fields.uid), profileUid: scalarCell(payload.profileUid), domain: scalarCell(payload.domain),
      selectedOrder: row(selected), targetAbsentInProvidedMap: definition.kind === 'resident' && selected === null,
      residentMap: { map: pick(resident, ['presence', 'state', 'reasonCode']), total: resident.value.total, complete: true, decodedComplete: true,
        // At most six ordinary rows; preserve their order and presence.
        entries: resident.value.entries.map(row) },
      stockMap: { ...pick(stock, ['presence', 'state', 'reasonCode']), total: stock.value.total, complete: true,
        entries: stock.value.entries.map(one => ({ boxId: one.boxId, ...Object.fromEntries(['domain', 'stockNum', 'calcTime', 'maxStockTime']
          .filter(key => Object.hasOwn(one, key)).map(key => [key, scalarCell(one[key])])) })) },
      tdyMap: { ...pick(tdy, ['presence', 'state', 'reasonCode']), total: tdy.value.total, complete: true,
        entries: tdy.value.entries.map(one => ({ boxId: one.boxId, count: scalarCell(one.count) })) },
      counters: Object.fromEntries([105, 109, 116].map(id => [id, counter(payload.counters?.[id])])),
      financial: { ...Object.fromEntries(['bag', 'gold', 'yb', 'level', 'lvlExp', '1106', '1340'].map(key =>
        [key, key === 'bag' ? { ...pick(payload.financial?.[key], ['presence', 'state', 'reasonCode']), value: pick(payload.financial?.[key]?.value, ['complete', 'total', 'fingerprint']) }
          : scalarCell(payload.financial?.[key])])), levelRewardItems: { ...pick(level, ['presence', 'state', 'reasonCode']), total: levelItems.length,
        returned: Math.min(levelItems.length, 118), limit: 118, complete: levelComplete, value: levelItems.slice(0, 118).map(one => pick(one, ['itemId', 'quantity'])) } } },
    generationCounterObservation: generationCounter, answerItemObservation: answerProjection, itemObservation: freshProjection } };
}
