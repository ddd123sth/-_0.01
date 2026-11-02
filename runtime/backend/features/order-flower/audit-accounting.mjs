import { canonical, fingerprint, parseStored, plainObject } from '../../common.mjs';
import { ledgerJsonFingerprint } from '../../persistence/json-contract.mjs';
import { ORDER_FLOWER_AXES, orderFlowerContextKey, knownOrderFlowerCell, orderFlowerSourceProofValid } from './wire-facts.mjs';
import { ORDER_FLOWER_CONTRACTS, orderFlowerHistoricalAdmittedContractMatches, assertOrderFlowerProposal } from './rpc-contract.mjs';
import { assertOrderFlowerStoredPreparation } from './stored-contract.mjs';
import { resolveOrderFlowerObservationEvidence } from './read-model.mjs';
import { currentOfficialDataEvidence } from '../../official-data-evidence.mjs';
import { isNormalSyncMethod } from '../../facts/normal-sync-contract.mjs';
import { readVerifiedOrderFlowerDeliveryRoot } from './delivery-root.mjs';
import { officialVersionAuditExtras } from '../../official-version-audit.mjs';

const pick = (value, names) => value === null ? null : Object.fromEntries(names.filter(key => value && Object.hasOwn(value, key)).map(key => [key, value[key]]));
const list = (value, limit, project) => Array.isArray(value) ? value.slice(0, limit).map(project) : value === null ? null : [];
const same = (a, b, keys) => !!a && !!b && keys.every(key => a[key] === b[key]);
const source = value => {
  if (value == null) return value ?? null;
  const out = pick(value, ['kind', 'sourceKind', 'source', 'transport', 'method', 'contextKey', 'connectionEpoch', 'requestSequence', 'wireKey',
    'responseRef', 'serverMs', 'serverRespondedMs', 'receivedDeviceMs', 'receivedMonotonicMs', 'officialUid', 'observationRef', 'sourceObservationRef', 'sourceFingerprint']);
  const versionFields = ['source', 'gameVersion', 'protocolVersion', 'loginResponseRef', 'sourceProofFingerprint', 'dayClockProofFingerprint',
    'dataSnapshotId', 'moSha256', 'contractId', 'dataSchemaContractId', 'profileBinding', 'resourceSha256', 'sourceConfigSha256',
    'sourceDataVersion', 'sourceIndexSha256', 'sourceProofs', 'tableHashes', 'staticArtifactRefs', 'sourceBlockContractSha256'];
  for (const key of ['version', 'versionEvidence']) if (Object.hasOwn(value, key)) out[key] = value[key]===null?null:
    {...pick(value[key], versionFields),...officialVersionAuditExtras(value[key])};
  return out;
};
const withSource = (value, names) => ({ ...pick(value, names), ...(value && Object.hasOwn(value, 'source') ? { source: source(value.source) } : {}) });
const time = value => pick(value, ['presence', 'value']);
const rawStock = value => value === null ? null : { ...pick(value, ['boxId', 'stockNum', 'absentInProvidedCompleteMap']), calcTime: time(value?.calcTime), maxStockTime: time(value?.maxStockTime) };
const count = value => value === null ? null : withSource(value, ['counterId', 'uid', 'raw', 'total', 'rTime']);
const box = value => withSource(value, ['boxId', 'kind', 'known', 'reasonCode', 'rawStockNum', 'rawRowPresent', 'rawPresence', 'rawCalcTime', 'rawMaxStockTime',
  'effectiveStockNum', 'generatedSinceSnapshot', 'calcTime', 'maxStockTime', 'nextChangeAt', 'capacity', 'cdSeconds', 'branch', 'hireProofRef',
  'ordinaryDeliveryStillRequiresFlowers', 'rawMapFingerprint', 'basisRef']);
const daily = value => withSource(value, ['known', 'counterId', 'rawGenCount', 'effectiveGenCount', 'finishedCount', 'currentGeneratedOrderOffset', 'uiDisplayCount',
  'rawRTime', 'meaning', 'dayKey', 'dayProofRef', 'originalCounterUnchanged', 'storedCount', 'officialLimit', 'remainingForGeneration', 'countRule', 'reasonCode']);
const hire = value => {
  const out = withSource(value, ['known', 'hired', 'boughtQuantity', 'reasonCode', 'openProofRef', 'buyPeriodMissingKeyMeansZero', 'statusWasNotUsedAsHire']);
  if (value && Object.hasOwn(value, 'period')) out.period = pick(value.period, ['beginMs', 'endMs']);
  if (value && Object.hasOwn(value, 'periodSource')) out.periodSource = source(value.periodSource);
  return out;
};
const smallDay = value => pick(value, ['known', 'key', 'startMs', 'endMs', 'proofRef']);
const storedBasis = value => value === null ? null : { ...pick(value, ['version', 'contract', 'kind', 'boxId', 'officialUid', 'rawStockFingerprint', 'accountingBasisRef',
  'selectedBoxBasisRef', 'effectiveStockNum', 'dailyFingerprint', 'hireFingerprint', 'officialDayProofRef', 'basisRef']),
  context: pick(value?.context, ORDER_FLOWER_AXES), stockSource: source(value?.stockSource) };
const stockTimes = value => value === null ? null : { ...pick(value, ['maxTimeClassification', 'sourceCadenceSeconds', 'futureClockOrPauseNotInvented']),
  ...Object.fromEntries(['calcTimeBefore', 'calcTimeAfter', 'maxStockTimeBefore', 'maxStockTimeAfter'].filter(key => value && Object.hasOwn(value, key)).map(key => [key, time(value[key])])) };

export function projectOrderFlowerStoredBefore(value) {
  if (value == null) return { value: value ?? null, complete: value === null, storedFingerprintVerified: false };
  const out = pick(value, ['version', 'contract', 'kind', 'boxId', 'officialUid', 'rawStockFingerprint', 'accountingBasisRef',
    'actualFlowersStillRequired', 'stockProjectionAloneConfirmsNothing', 'fingerprint']);
  out.context = pick(value.context, ORDER_FLOWER_AXES); out.stockSource = source(value.stockSource);
  out.rawStocks = list(value.rawStocks, 8, rawStock); out.selectedBox = box(value.selectedBox); out.groupBoxes = list(value.groupBoxes, 6, box);
  out.daily = daily(value.daily); out.hire = hire(value.hire); out.counters = list(value.counters, 3, count);
  out.rawTdys = list(value.rawTdys, 8, one => pick(one, ['boxId', 'count'])); out.day = smallDay(value.day);
  out.clock = pick(value.clock, ['source', 'connectionEpoch', 'nowMs', 'lowerBoundMs', 'upperBoundMs', 'revision']);
  out.sourceContract = pick(value.sourceContract, ['sha256', 'gameDecodedSha256', 'fullButlerTableSha256']);
  if (value.sourceContract && Object.hasOwn(value.sourceContract, 'ranges')) out.sourceContract.ranges = Object.fromEntries(
    ['sharedStockRules', 'clientStockAccounting', 'actualHire', 'settingDS', 'ordinaryStillRequiresFlowers', 'storedBypassesOnlyCooldown']
      .filter(key => Object.hasOwn(value.sourceContract.ranges || {}, key)).map(key => [key, pick(value.sourceContract.ranges[key], ['range', 'sha256'])]));
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'fingerprint'));
  const verified = fingerprint(body) === value.fingerprint && fingerprint(value.rawStocks) === value.rawStockFingerprint;
  return { value: out, complete: verified && canonical(out) === canonical(value), storedFingerprintVerified: verified,
    limits: { stocks: 8, groupBoxes: 6, counters: 3, tdys: 8 } };
}

export function projectOrderFlowerStoredEffect(value) {
  if (value == null) return { value: value ?? null, complete: value === null, storedFingerprintVerified: false };
  const out = pick(value, ['version', 'contract', 'kind', 'boxId', 'beforeFingerprint', 'ownStockConsumption', 'residentRemainingForGenerationAtBefore',
    'storedOrderStillConsumesActualFlowers', 'financialAndOriginalOrderTransitionMustAlsoPass', 'serviceDeliveryCounterClaimed', 'serverAllocationAlgorithmClaimedEquivalent', 'fingerprint']);
  out.beforeBasis = storedBasis(value.beforeBasis);
  out.counterEvidence = list(value.counterEvidence, 3, one => ({ ...pick(one, ['answerFieldProvided', 'rawDelta', 'totalDelta', 'effectiveBefore', 'effectiveAfter',
    'effectiveDelta', 'classification', 'generatedCountIsNotDeliveryCount']), before: count(one.before), answer: count(one.answer), after: count(one.after) }));
  out.stockEvidence = list(value.stockEvidence, 6, one => {
    const projected = pick(one, ['boxId', 'beforeEffective', 'answerStockFieldProvided', 'ownConsumption', 'actuallyObservedGrowthBeforeAnswer',
      'actuallyObservedGrowthAfterAnswer', 'maximumAdditionalCadenceTicksWholeInterval', 'maximumAdditionalCadenceTicksBeforeAnswer', 'maximumAdditionalCadenceTicksAfterAnswer']);
    for (const key of ['beforeRaw', 'answerRaw', 'afterRaw']) if (Object.hasOwn(one, key)) projected[key] = rawStock(one[key]);
    for (const key of ['directPostTimes', 'answerTimes', 'postTimes']) if (Object.hasOwn(one, key)) projected[key] = stockTimes(one[key]);
    return projected;
  });
  out.tdyEvidence = { ...pick(value.tdyEvidence, ['targetBefore', 'targetAnswer', 'targetAfter', 'tdyAloneConfirmsNothing']),
    ...Object.fromEntries(['before', 'answer', 'after'].map(key => [key, list(value.tdyEvidence?.[key], 8, one => pick(one, ['boxId', 'count']))])) };
  out.actualSource = { answer: source(value.actualSource?.answer), postRead: source(value.actualSource?.postRead) };
  out.observedGrowth = pick(value.observedGrowth, ['beforeAnswer', 'afterAnswer']);
  const verified = fingerprint(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'fingerprint'))) === value.fingerprint;
  return { value: out, complete: verified && canonical(out) === canonical(value), storedFingerprintVerified: verified };
}

const floorDay = value => ({ ...pick(value, ['key', 'startMs', 'endMs', 'utcOffsetMinutes', 'dayKey', 'officialUid', 'originalDayReceiptRef', 'originalDayFingerprint', 'proofRef']),
  ...(value && Object.hasOwn(value, 'source') ? { source: source(value.source) } : {}) });
const serverCount = value => {
  const out = withSource(value, ['known', 'counterId', 'raw', 'total', 'rawRTime', 'effective', 'offset', 'value',
    'sourceObservationRef', 'sourceFingerprint', 'originalOfficialCounterUnchanged', 'cellProofs']);
  if (value && Object.hasOwn(value, 'generatedOrderTimeProof')) out.generatedOrderTimeProof = {
    value: value.generatedOrderTimeProof?.value ?? null, source: source(value.generatedOrderTimeProof?.source) };
  return out;
};
const floorReceipt = value => ({ ...pick(value, ['version', 'operationId', 'ownerRef', 'subjectRef', 'kind', 'officialUid', 'parentFloorReceiptRef',
  'parentFloorFingerprint', 'policyCountBefore', 'policyCountAfter', 'originalFingerprint', 'preparationFingerprint', 'settlementKey', 'settlementFingerprint',
  'targetEvidenceFingerprint', 'localConfirmedDeliveryIncrement', 'officialCounterUnchanged', 'unknownCountedAsConfirmed']),
  day: floorDay(value?.day), serverCount: serverCount(value?.serverCount) });

// Bound every receipt to its original confirmed operation and sources. This
// reader never calls the accounting service constructor or recordConfirmed:
// reading an audit must not create tables, seed floors or change a counter.
export function readOrderFlowerDeliveryAudit({ store, operation, preparation, limit = 128 } = {}) {
  const has = name => !!store.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name);
  const applicable = !!ORDER_FLOWER_CONTRACTS[preparation?.kind], missing = [], rows = [], seen = new Map();
  const required = preparation?.policyCount != null || preparation?.deliveryPath === 'butler-stored-order';
  if (!applicable || !Number.isSafeInteger(limit) || limit < 1 || limit > 256) return { applicable, required, available: false, complete: false,
    reasonCode: 'ORDER_DELIVERY_AUDIT_ARGUMENT_INVALID', limit, rows, missing };
  if (!has('backend_order_flower_delivery_receipts')) return { applicable, required, available: false, complete: !required,
    reasonCode: 'ORDER_DELIVERY_AUDIT_TABLE_UNAVAILABLE', limit, rows, missing };
  const parse = text => { try { return parseStored(text, '订单交付审计有限原件'); } catch { return null; } };
  const definition = ORDER_FLOWER_CONTRACTS[preparation.kind], uid = preparation.officialUid, originalDay = preparation.day;
  const dayKey = fingerprint([originalDay.key, originalDay.startMs, originalDay.endMs, originalDay.utcOffsetMinutes]);
  const scope = value => value?.ownerRef === operation.owner_ref && value.subjectRef === operation.subject_ref && value.kind === definition.kind &&
    value.officialUid === uid && value.day?.dayKey === dayKey && value.day.startMs === originalDay.startMs && value.day.endMs === originalDay.endMs;
  const own = store.get(`SELECT receipt_ref FROM backend_order_flower_delivery_receipts WHERE operation_id=? AND owner_ref=? AND subject_ref=? AND kind=?`,
    operation.operation_id, operation.owner_ref, operation.subject_ref, definition.kind);
  const pending = [...new Set([own?.receipt_ref, preparation.policyCount?.floorReceiptRef].filter(value => typeof value === 'string'))];
  const readEvidence = (operationId, key, kind) => {
    const row = store.get(`SELECT evidence_id,kind,source,payload_json,payload_fingerprint,observed_at FROM backend_operation_evidence
      WHERE operation_id=? AND evidence_key=? AND kind=? AND source='backend/write-gateway/v2'`, operationId, key, kind), payload = row && parse(row.payload_json);
    return row && payload && ledgerJsonFingerprint({ kind: row.kind, source: row.source, payload, observedAt: row.observed_at }) === row.payload_fingerprint
      ? { row, payload } : null;
  };
  while (pending.length && rows.length < limit) {
    const ref = pending.shift(); if (seen.has(ref)) continue;
    const row = store.get(`SELECT receipt_ref,operation_id,owner_ref,subject_ref,kind,official_uid,day_key,day_start_ms,day_end_ms,
      policy_count_after,receipt_json,receipt_fingerprint,recorded_at FROM backend_order_flower_delivery_receipts
      WHERE receipt_ref=? AND owner_ref=? AND subject_ref=? AND kind=?`, ref, operation.owner_ref, operation.subject_ref, definition.kind), body = row && parse(row.receipt_json);
    if (!row || !plainObject(body) || !plainObject(body.day) || !plainObject(body.serverCount)) { missing.push('delivery-floor:' + ref); continue; }
    seen.set(ref, body);
    const issues = [], projected = floorReceipt(body), hash = fingerprint(body);
    const stored = hash === row.receipt_fingerprint && ref === 'order-delivery-floor:' + hash && scope(body) &&
      body.version === 'order-flower-confirmed-delivery-floor/v1' && body.operationId === row.operation_id && body.policyCountAfter === row.policy_count_after &&
      body.officialUid === row.official_uid && body.day.dayKey === row.day_key && body.day.startMs === row.day_start_ms && body.day.endMs === row.day_end_ms;
    if (!stored) issues.push('receipt-hash-or-scope');
    if (!stored) {
      rows.push({ ...pick(row, ['receipt_ref', 'operation_id', 'receipt_fingerprint', 'recorded_at']), receipt: projected,
        storedFingerprintVerified: false, payloadProjectionComplete: canonical(projected) === canonical(body), originalSources: null, issues });
      continue;
    }
    const op = store.get('SELECT * FROM backend_operations WHERE operation_id=? AND owner_ref=? AND subject_ref=? AND feature_id=? AND scope=? AND method=?',
      body.operationId, operation.owner_ref, operation.subject_ref, definition.featureId, definition.scope, definition.method), original = op && parse(op.original_json);
    const prepared = readEvidence(body.operationId, 'finite-domain-preparation:v1', 'finite-domain-preparation'), admitted = readEvidence(body.operationId, 'admitted-operation-contract:v1', 'admitted-operation-contract');
    let bound = false;
    if (op && original && op.business_verdict === 'confirmed' && op.write_slot === 0 && op.transport_state === 'answered' &&
        ledgerJsonFingerprint(original) === op.original_fingerprint && op.original_fingerprint === body.originalFingerprint && prepared && admitted &&
        prepared.payload.domain === 'order-flower-' + definition.kind && prepared.row.payload_fingerprint === body.preparationFingerprint &&
        orderFlowerHistoricalAdmittedContractMatches(admitted.payload, definition)) {
      try { const proposal = { ...original, orderFlower: prepared.payload.preparation, params: definition.kind === 'resident' ? { boxId: prepared.payload.preparation.boxId } : {} };
        assertOrderFlowerProposal(proposal); assertOrderFlowerStoredPreparation(proposal); bound = true;
      } catch { /* Record an explicit incomplete source, never invent a floor. */ }
    }
    if (!bound) issues.push('original-operation-or-preparation');
    const target = original?.targets?.[0], settlement = target && store.get(`SELECT settlement_key,result_json,result_fingerprint,evidence_id,verdict
      FROM backend_operation_target_settlements WHERE operation_id=? AND member_key=?`, body.operationId, target.memberKey), result = settlement && parse(settlement.result_json);
    const targetEvent = settlement && store.get('SELECT kind,source,payload_json,payload_fingerprint,observed_at FROM backend_operation_evidence WHERE operation_id=? AND evidence_id=?', body.operationId, settlement.evidence_id), targetPayload = targetEvent && parse(targetEvent.payload_json);
    const settlementValid = settlement?.verdict === 'confirmed' && result?.member?.verdict === 'confirmed' && result.member.memberKey === target?.memberKey &&
      ledgerJsonFingerprint(result) === settlement.result_fingerprint && settlement.result_fingerprint === body.settlementFingerprint && settlement.settlement_key === body.settlementKey &&
      targetEvent?.kind === 'domain-verification' && targetEvent.source === 'backend/write-gateway/v2' && targetEvent.payload_fingerprint === body.targetEvidenceFingerprint &&
      ledgerJsonFingerprint({ kind: targetEvent.kind, source: targetEvent.source, payload: targetPayload, observedAt: targetEvent.observed_at }) === targetEvent.payload_fingerprint &&
      canonical(targetPayload) === canonical({ ...result.evidence?.payload, member: result.member, verificationVersion: result.verificationVersion,
        resourceResolutions: result.resourceResolutions, transportTermination: result.transportTermination });
    if (!settlementValid) issues.push('target-settlement-or-evidence');
    const recoveryRoot=stored&&bound&&settlementValid?readVerifiedOrderFlowerDeliveryRoot({store,row,hashes:{
      originalFingerprint:op.original_fingerprint,preparationFingerprint:prepared.row.payload_fingerprint,
      settlementFingerprint:settlement.result_fingerprint,targetEvidenceFingerprint:targetEvent.payload_fingerprint}}):null;
    const dayRow = has('backend_customer_generation_days') && store.get('SELECT receipt_ref,payload_json,payload_fingerprint FROM backend_customer_generation_days WHERE receipt_ref=? AND owner_ref=? AND account_ref=? AND subject_ref=?',
      body.day.originalDayReceiptRef ?? '', operation.owner_ref, op?.account_ref ?? operation.account_ref, operation.subject_ref), dayPayload = dayRow && parse(dayRow.payload_json);
    const dayValid = dayRow && dayPayload && fingerprint(dayPayload) === dayRow.payload_fingerprint && dayRow.payload_fingerprint === body.day.originalDayFingerprint &&
      dayPayload.kind === 'complete-login-day' && same(dayPayload.context, original, ORDER_FLOWER_AXES) && dayPayload.officialUid === uid && prepared?.payload?.preparation?.day &&
      canonical(dayPayload.officialDay) === canonical(prepared.payload.preparation.day) && canonical(body.day) === canonical({ key: dayPayload.officialDay.key,
        startMs: dayPayload.officialDay.startMs, endMs: dayPayload.officialDay.endMs, utcOffsetMinutes: dayPayload.officialDay.utcOffsetMinutes,
        dayKey: fingerprint([dayPayload.officialDay.key, dayPayload.officialDay.startMs, dayPayload.officialDay.endMs, dayPayload.officialDay.utcOffsetMinutes]),
        officialUid: dayPayload.officialUid, originalDayReceiptRef: dayRow.receipt_ref, originalDayFingerprint: dayRow.payload_fingerprint,
        proofRef: dayPayload.officialDay.proofRef, source: source(dayPayload.officialDay.source) });
    if (!dayValid&&!recoveryRoot) issues.push('original-official-day-source');
    const s = body.serverCount?.source, resolvedCounter = s && resolveOrderFlowerObservationEvidence({ store, context: original,
      requestSequence: s.requestSequence, responseRef: s.responseRef }), sourceRow = resolvedCounter?.row, frame = resolvedCounter?.frame;
    const counter = frame?.payload?.counters?.[definition.counterId];
    let serverValid = false;
    const cellKeys = ['domain', 'uid', 'type', 'tdyCnt', 'totCnt', 'rTime'];
    const cellProofs = body.serverCount?.cellProofs;
    const perCell = plainObject(cellProofs) && Object.keys(cellProofs).length === cellKeys.length && cellKeys.every(key => {
      const proof = cellProofs[key], cellSource = proof?.source;
      const resolved = plainObject(cellSource) && resolveOrderFlowerObservationEvidence({ store, context: original,
        requestSequence: cellSource.requestSequence, responseRef: cellSource.responseRef });
      const cellFrame = resolved?.frame, cell = cellFrame?.payload?.counters?.[definition.counterId]?.[key];
      return !!resolved && resolved.accepted === true && resolved.wholeFrameFingerprint === resolved.row?.payload_fingerprint &&
        resolved.payloadFingerprint === cellFrame?.payloadFingerprint && cellFrame?.admissible === true &&
        same(cellFrame.context, original, ORDER_FLOWER_AXES) && canonical(cellFrame.source) === canonical(cellSource) &&
        cellSource.kind === 'response' && cellSource.transport === 'answered' && cellSource.contextKey === orderFlowerContextKey(original) &&
        cellSource.connectionEpoch === original.connectionEpoch && isNormalSyncMethod(cellSource.method) && cellSource.version?.source === 'normal-package-hop-and-matched-world-login/v1' &&
        cellSource.version?.loginResponseRef === dayPayload?.source?.responseRef &&
        cellSource.version?.protocolVersion === frame?.source?.version?.protocolVersion && orderFlowerSourceProofValid(cellSource.version, definition.kind) &&
        (currentOfficialDataEvidence(cellSource.version, `order.${definition.kind}`) ||
          cellSource.version?.gameVersion === '480.0.27' && orderFlowerSourceProofValid(cellSource.version, definition.kind)) &&
        Number.isSafeInteger(cellSource.serverMs) && cellSource.serverMs >= body.day.startMs && cellSource.serverMs < body.day.endMs && knownOrderFlowerCell(cell) &&
        plainObject(proof) && canonical(proof.value) === canonical(cell.value);
    });
    const modernSourceFingerprint = plainObject(cellProofs) ? fingerprint([s, cellProofs]) : null;
    // Modern counters are six independently typed cells from one admitted
    // response. Their source ref is the wire response ref and their fingerprint
    // is the production accounting contract, not the raw whole-frame hash.
    const sourceFingerprintValid = plainObject(cellProofs)
      ? sourceRow?.response_ref === body.serverCount.sourceObservationRef && body.serverCount.sourceFingerprint === modernSourceFingerprint && perCell
      : sourceRow?.observation_ref === body.serverCount.sourceObservationRef && body.serverCount.sourceFingerprint === sourceRow?.payload_fingerprint;
    const actionDataProof = frame?.source?.version && (currentOfficialDataEvidence(frame.source.version, `order.${definition.kind}`) ||
      frame.source.version.gameVersion === '480.0.27' && orderFlowerSourceProofValid(frame.source.version, definition.kind));
    const modern = plainObject(cellProofs);
    const countValues = modern ? Object.fromEntries(cellKeys.map(key => [key, cellProofs[key]?.value]))
      : Object.fromEntries(cellKeys.map(key => [key, counter?.[key]?.value]));
    const counterCellsKnown = modern ? perCell : cellKeys.every(key => knownOrderFlowerCell(counter?.[key]));
    const loginRef = dayPayload?.source?.responseRef;
    const mainSourceValid = frame?.source?.version && isNormalSyncMethod(frame.source.method) &&
      frame.source.version.loginResponseRef === loginRef && frame.source.version.protocolVersion === '480.0.0';
    if (resolvedCounter?.accepted === true && frame?.admissible && sourceRow?.payload_fingerprint === resolvedCounter.wholeFrameFingerprint &&
        sourceFingerprintValid && actionDataProof &&
        same(frame.context, original, ORDER_FLOWER_AXES) && frame.source.contextKey === orderFlowerContextKey(frame.context) &&
        frame.source.kind === 'response' && frame.source.transport === 'answered' && canonical(frame.source) === canonical(s) && mainSourceValid &&
        Number.isSafeInteger(frame.source.serverMs) && frame.source.serverMs >= body.day.startMs && frame.source.serverMs < body.day.endMs &&
        (modern || frame.source.method === 'index.login' && frame.source.version.loginResponseRef === frame.source.responseRef) && counterCellsKnown &&
        ['uid', 'type', 'tdyCnt', 'totCnt', 'rTime'].every(key => Number.isSafeInteger(countValues[key])) &&
        countValues.uid === uid && countValues.type === definition.counterId) {
      const raw = countValues.tdyCnt, total = countValues.totCnt, rTime = countValues.rTime, effective = rTime < body.day.startMs ? 0 : raw;
      let created = frame.payload.fields?.[definition.kind]?.value?.fields?.cTime;
      if (modern && definition.kind !== 'resident') {
        const proof = body.serverCount.generatedOrderTimeProof, timeSource = proof?.source;
        if (proof && timeSource) {
          const resolvedTime = resolveOrderFlowerObservationEvidence({ store, context: original,
            requestSequence: timeSource.requestSequence, responseRef: timeSource.responseRef });
          const timeFrame = resolvedTime?.frame, timeCell = timeFrame?.payload?.fields?.[definition.kind]?.value?.fields?.cTime;
          const timeActionProof = timeFrame?.source?.version && (currentOfficialDataEvidence(timeFrame.source.version, `order.${definition.kind}`) ||
            timeFrame.source.version.gameVersion === '480.0.27' && orderFlowerSourceProofValid(timeFrame.source.version, definition.kind));
          created = resolvedTime?.accepted === true && resolvedTime.wholeFrameFingerprint === resolvedTime.row?.payload_fingerprint &&
            resolvedTime.payloadFingerprint === timeFrame?.payloadFingerprint && timeFrame?.admissible === true &&
            same(timeFrame.context, original, ORDER_FLOWER_AXES) && canonical(timeFrame.source) === canonical(timeSource) &&
            isNormalSyncMethod(timeSource.method) && timeSource.version?.loginResponseRef === loginRef && timeActionProof &&
            Number.isSafeInteger(timeSource.serverMs) && timeSource.serverMs >= body.day.startMs && timeSource.serverMs < body.day.endMs &&
            knownOrderFlowerCell(timeCell) && canonical(timeCell.value) === canonical(proof.value) ? timeCell : null;
        } else if (frame.source.method === 'index.login' && frame.source.responseRef === loginRef) {
          created = knownOrderFlowerCell(created) ? created : null;
        } else created = null;
      }
      const offsetKnown = definition.kind === 'resident' || knownOrderFlowerCell(created), offset = definition.kind === 'resident' ? 0 : Number(created?.value >= body.day.startMs);
      serverValid = offsetKnown && body.serverCount.raw === raw && body.serverCount.total === total && body.serverCount.rawRTime === rTime &&
        body.serverCount.effective === effective && body.serverCount.offset === offset && body.serverCount.value === Math.max(effective - offset, 0) &&
        body.serverCount.originalOfficialCounterUnchanged === true;
    }
    if (!serverValid&&!recoveryRoot) issues.push('original-official-counter-source');
    if (recoveryRoot&&row.receipt_ref===own?.receipt_ref&&preparation.policyCount?.floorReceiptRef===body.parentFloorReceiptRef
        &&preparation.policyCount?.floorFingerprint===body.parentFloorFingerprint){
      for(let i=pending.length-1;i>=0;i--)if(pending[i]===body.parentFloorReceiptRef)pending.splice(i,1);
    }
    if (!recoveryRoot&&body.parentFloorReceiptRef !== null) {
      if (typeof body.parentFloorReceiptRef !== 'string' || body.parentFloorReceiptRef === ref) issues.push('parent-cycle-or-reference');
      else if (!seen.has(body.parentFloorReceiptRef)) pending.push(body.parentFloorReceiptRef);
    }
    const projectionComplete = canonical(projected) === canonical(body);
    if (!projectionComplete) issues.push('receipt-whitelist');
    rows.push({ ...pick(row, ['receipt_ref', 'operation_id', 'owner_ref', 'subject_ref', 'kind', 'official_uid', 'day_key', 'day_start_ms', 'day_end_ms',
      'policy_count_after', 'receipt_fingerprint', 'recorded_at']), receipt: projected, storedFingerprintVerified: stored, payloadProjectionComplete: projectionComplete,
      recoveryRoot,
      originalSources: { originalFingerprint: op?.original_fingerprint ?? null, preparationEvidenceId: prepared?.row.evidence_id ?? null,
        admittedEvidenceId: admitted?.row.evidence_id ?? null, settlementKey: settlement?.settlement_key ?? null,
        dayReceiptRef: dayRow?.receipt_ref ?? null, dayFingerprint: dayRow?.payload_fingerprint ?? null,
        counterObservationRef: sourceRow?.observation_ref ?? null, counterFingerprint: sourceRow?.payload_fingerprint ?? null,
        rawDaySourceVerified:!!dayValid,rawCounterSourceVerified:!!serverValid,verifiedRootReplacesParentChain:!!recoveryRoot }, issues });
  }
  for (const row of rows) {
    const body = seen.get(row.receipt_ref), parent = body.parentFloorReceiptRef === null ? null : seen.get(body.parentFloorReceiptRef),
      expected = Math.max(body.serverCount.value, parent?.policyCountAfter ?? 0);
    if (!row.recoveryRoot&&(body.parentFloorReceiptRef !== null && (!parent || !scope(parent) || fingerprint(parent) !== body.parentFloorFingerprint ||
        parent.policyCountAfter >= body.policyCountAfter) || body.policyCountBefore !== expected)
        || row.recoveryRoot&&body.policyCountBefore<body.serverCount.value || body.policyCountAfter !== body.policyCountBefore + 1 ||
        body.localConfirmedDeliveryIncrement !== 1 || body.officialCounterUnchanged !== true || body.unknownCountedAsConfirmed !== false) row.issues.push('parent-chain-or-policy-count');
    for (const issue of row.issues) missing.push('delivery-floor:' + row.receipt_ref + ':' + issue);
  }
  if (pending.length) missing.push('delivery-floor:chain-limit');
  if (required && !own) missing.push('delivery-floor:current-operation-receipt');
  return { applicable, required, available: true, complete: !missing.length, reasonCode: missing.length ? 'ORDER_DELIVERY_AUDIT_INCOMPLETE' : 'ORDER_DELIVERY_AUDIT_COMPLETE',
    originalOperationReceiptRef: own?.receipt_ref ?? null, originalPolicyFloorRef: preparation.policyCount?.floorReceiptRef ?? null,
    sourcePolicyProofPresent: preparation.policyCount != null, originalOperationReceiptPresent: !!own,
    limit, returned: rows.length, chainExhausted: pending.length === 0, nextReceiptRef: pending[0] ?? null, rows, missing };
}
