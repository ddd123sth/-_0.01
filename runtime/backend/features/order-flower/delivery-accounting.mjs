import { canonical, clone, fingerprint, freeze, gatewayVerificationEvidencePayload, parseStored, problem } from '../../common.mjs';
import { knownOrderFlowerCell, orderFlowerContext, orderFlowerContextKey, orderFlowerSourceProofValid, sameOrderFlowerContext } from './wire-facts.mjs';
import { ORDER_FLOWER_CONTRACTS, orderFlowerHistoricalAdmittedContractMatches, assertOrderFlowerProposal } from './rpc-contract.mjs';
import { ledgerJsonFingerprint } from '../../persistence/json-contract.mjs';
import { isNormalSyncMethod } from '../../facts/normal-sync-contract.mjs';
import { resolveOrderFlowerObservationEvidence } from './read-model.mjs';
import { createOrderFlowerDeliveryRoot } from './delivery-root.mjs';
import { measureSyncCost } from '../../execution/sync-costs.mjs';

const VERSION = 'order-flower-delivery-policy-count/v1';
const RECEIPT_VERSION = 'order-flower-confirmed-delivery-floor/v1';
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const scalar = cell => knownOrderFlowerCell(cell) ? cell.value : null;
const fail = code => { throw problem(code, '三类订单实际交付计数来源或原账不完整', 409); };
const withoutProof = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'proofRef'));
const sourceFields = ['kind', 'method', 'connectionEpoch', 'requestSequence', 'responseRef', 'wireKey'];
const sameSource = (a, b) => !!a && !!b && sourceFields.every(key => a[key] === b[key]);

// This journal is a local lower bound on actual CONFIRMED deliveries, not a
// replacement for official generated/finished counters. max(server,floor)
// avoids counting the same confirmed ordinary delivery twice. Unknown writes
// stay in their original ledger and never become confirmed floor receipts.
export function createOrderFlowerDeliveryAccounting({ store } = {}) {
  for (const fn of [store?.run, store?.get, store?.all, store?.transaction, store?.nowIso]) {
    if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') throw new TypeError('Delivery accounting requires synchronous persistent store ports');
  }
  const { run, get, transaction, nowIso } = store;
  run(`CREATE TABLE IF NOT EXISTS backend_order_flower_delivery_receipts(receipt_ref TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL UNIQUE REFERENCES backend_operations(operation_id),owner_ref TEXT NOT NULL,
    subject_ref TEXT NOT NULL,kind TEXT NOT NULL,official_uid INTEGER NOT NULL,day_key TEXT NOT NULL,
    day_start_ms INTEGER NOT NULL,day_end_ms INTEGER NOT NULL,policy_count_after INTEGER NOT NULL,
    receipt_json TEXT NOT NULL,receipt_fingerprint TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
  run(`CREATE INDEX IF NOT EXISTS backend_order_flower_delivery_day ON backend_order_flower_delivery_receipts
    (owner_ref,subject_ref,kind,day_start_ms,day_end_ms,policy_count_after DESC,receipt_ref)`);
  for (const action of ['UPDATE', 'DELETE']) run(`CREATE TRIGGER IF NOT EXISTS backend_order_flower_delivery_no_${action.toLowerCase()}
    BEFORE ${action} ON backend_order_flower_delivery_receipts BEGIN SELECT RAISE(ABORT,'confirmed delivery receipts are append only'); END`);
  const validated = new Map();
  const recoveryRoot=createOrderFlowerDeliveryRoot({store});

  function originalDay(context, day) {
    if (day?.known !== true || !reference(day.proofRef) || !reference(day.key) || !positive(day.startMs) ||
        day.endMs - day.startMs !== 86400000 || !Number.isSafeInteger(day.utcOffsetMinutes) || Math.abs(day.utcOffsetMinutes) > 840 ||
        !day.source || day.source.method !== 'index.login' || day.source.connectionEpoch !== context.connectionEpoch ||
        day.source.contextKey !== orderFlowerContextKey(context) || !positive(day.source.officialUid)) fail('ORDER_DELIVERY_OFFICIAL_DAY_REQUIRED');
    const row = get(`SELECT * FROM backend_customer_generation_days WHERE owner_ref=? AND account_ref=? AND subject_ref=?
      AND context_key=? AND response_ref=? ORDER BY request_sequence DESC LIMIT 1`, context.ownerRef, context.accountRef,
    context.subjectRef, orderFlowerContextKey(context), day.source.responseRef);
    const payload = row && parseStored(row.payload_json, '三类订单日界原证明');
    if (!row || fingerprint(payload) !== row.payload_fingerprint || payload.kind !== 'complete-login-day' ||
        !sameOrderFlowerContext(payload.context, context) || payload.officialUid !== day.source.officialUid ||
        canonical(payload.officialDay) !== canonical(day)) fail('ORDER_DELIVERY_OFFICIAL_DAY_SOURCE_UNPROVEN');
    return { key: day.key, startMs: day.startMs, endMs: day.endMs, utcOffsetMinutes: day.utcOffsetMinutes,
      dayKey: fingerprint([day.key, day.startMs, day.endMs, day.utcOffsetMinutes]), officialUid: day.source.officialUid,
      source: clone(day.source), originalDayReceiptRef: row.receipt_ref, originalDayFingerprint: row.payload_fingerprint, proofRef: day.proofRef };
  }
  function serverCounter(context, kind, day, supplied) {
    const definition = ORDER_FLOWER_CONTRACTS[kind], s = supplied?.source;
    if (!definition || supplied?.known !== true || supplied.counterId !== definition.counterId || !s || s.kind !== 'response' || !isNormalSyncMethod(s.method) ||
        s.connectionEpoch !== context.connectionEpoch || !positive(s.requestSequence) ||
        !reference(s.wireKey) || !reference(s.responseRef)) fail('ORDER_DELIVERY_CURRENT_SERVER_COUNTER_REQUIRED');
    const loginAnchor = get(`SELECT payload_json,payload_fingerprint FROM backend_customer_generation_days
      WHERE receipt_ref=? AND owner_ref=? AND subject_ref=?`, day.originalDayReceiptRef, context.ownerRef, context.subjectRef);
    const loginEvidence = loginAnchor && parseStored(loginAnchor.payload_json, '三类订单登录身份锚');
    const loginSource = loginEvidence?.source, daySource = loginEvidence?.officialDay?.source;
    // Older immutable day receipts kept the matched version tuple under
    // officialDay.source but did not duplicate it onto packet.source. Reuse
    // that tuple only when both source records identify the same exact login
    // response; never rewrite or enrich the stored receipt.
    const sameLoginSource = loginSource && daySource && loginSource.method === daySource.method &&
      loginSource.connectionEpoch === daySource.connectionEpoch && loginSource.requestSequence === daySource.requestSequence &&
      loginSource.wireKey === daySource.wireKey && loginSource.responseRef === daySource.responseRef &&
      loginSource.contextKey === daySource.contextKey;
    const loginVersion = loginSource?.version ?? (sameLoginSource ? daySource?.version : null);
    if (!loginAnchor || fingerprint(loginEvidence) !== loginAnchor.payload_fingerprint || loginEvidence.kind !== 'complete-login-day' ||
        !sameOrderFlowerContext(loginEvidence.context, context) || loginEvidence.source?.responseRef !== day.source.responseRef ||
        !sameLoginSource || !orderFlowerSourceProofValid(loginVersion, kind) || loginVersion?.protocolVersion !== '480.0.0' ||
        loginVersion?.loginResponseRef !== loginEvidence.source?.responseRef) {
      fail('ORDER_DELIVERY_LOGIN_VERSION_ANCHOR_UNPROVEN');
    }
    const readCell = (proof, group, key) => {
      const source = proof?.source;
      if (!proof || !source || source.kind !== 'response' ||
          source.transport !== 'answered' || !isNormalSyncMethod(source.method) || source.contextKey !== orderFlowerContextKey(context) ||
          source.connectionEpoch !== context.connectionEpoch || !positive(source.requestSequence) || !reference(source.responseRef) ||
          !orderFlowerSourceProofValid(source.version, kind) || source.version?.protocolVersion !== loginVersion?.protocolVersion ||
          source.version?.loginResponseRef !== day.source.responseRef) return null;
      const resolved = resolveOrderFlowerObservationEvidence({ store, context, requestSequence: source.requestSequence, responseRef: source.responseRef });
      const row = resolved?.row, frame = resolved?.frame;
      const cell = group === 'counters' ? frame?.payload?.counters?.[definition.counterId]?.[key]
        : frame?.payload?.fields?.[kind]?.value?.fields?.[key];
      if (!row || resolved.wholeFrameFingerprint !== row.payload_fingerprint || resolved.payloadFingerprint !== frame.payloadFingerprint ||
          !resolved.accepted || !frame.admissible || !sameOrderFlowerContext(frame.context, context) ||
          !sameSource(frame.source, source) || frame.source.transport !== 'answered' || !orderFlowerSourceProofValid(frame.source.version, kind) || frame.source.version?.protocolVersion !== loginVersion?.protocolVersion ||
          frame.source.version?.loginResponseRef !== day.source.responseRef || !positive(frame.source.serverMs) ||
          frame.source.serverMs < day.startMs || frame.source.serverMs >= day.endMs || !knownOrderFlowerCell(cell) ||
          canonical(cell.value) !== canonical(proof.value)) return null;
      return { value: cell.value, source: clone(frame.source), frame };
    };
    let entry, legacyCounterFrame = null, legacyCounterRow = null;
    if (supplied.cellProofs && typeof supplied.cellProofs === 'object') {
      entry = Object.fromEntries(['uid', 'type', 'tdyCnt', 'totCnt', 'rTime'].map(key => [key,
        readCell(supplied.cellProofs[key], 'counters', key)]));
      if (Object.values(entry).some(cell => !cell)) fail('ORDER_DELIVERY_SERVER_COUNTER_SOURCE_UNPROVEN');
      if (entry.uid.value !== day.source.officialUid || entry.type.value !== definition.counterId) fail('ORDER_DELIVERY_SERVER_COUNTER_IDENTITY_CONFLICT');
    } else {
      // Legacy confirmed receipts were created before per-cell source proofs.
      // Accept their exact login-frame form without changing their original bytes.
      if (s.method !== 'index.login' || s.responseRef !== day.source.responseRef) fail('ORDER_DELIVERY_SERVER_COUNTER_CELL_PROOFS_REQUIRED');
      const resolved = resolveOrderFlowerObservationEvidence({ store, context, requestSequence: s.requestSequence, responseRef: s.responseRef });
      const row = resolved?.row, frame = resolved?.frame;
      legacyCounterFrame = frame; legacyCounterRow = row;
      entry = frame?.payload?.counters?.[definition.counterId];
      if (!row || resolved.wholeFrameFingerprint !== row.payload_fingerprint || resolved.payloadFingerprint !== frame.payloadFingerprint ||
          !resolved.accepted || !frame.admissible || !sameOrderFlowerContext(frame.context, context) ||
          !sameSource(frame.source, s) || !orderFlowerSourceProofValid(frame.source.version, kind) || frame.source.version?.protocolVersion !== loginVersion?.protocolVersion ||
          frame.source.version?.loginResponseRef !== frame.source.responseRef || !positive(frame.source.serverMs) ||
          frame.source.serverMs < day.startMs || frame.source.serverMs >= day.endMs ||
          !['uid', 'type', 'tdyCnt', 'totCnt', 'rTime'].every(key => knownOrderFlowerCell(entry?.[key]))) {
        fail('ORDER_DELIVERY_SERVER_COUNTER_SOURCE_UNPROVEN');
      }
      entry = Object.fromEntries(['uid', 'type', 'tdyCnt', 'totCnt', 'rTime'].map(key => [key, { value: scalar(entry[key]), source: clone(frame.source) }]));
    }
    // Both the modern per-cell proof and the immutable legacy login-frame
    // adapter must enforce the official identity and counter type. Legacy
    // receipt compatibility cannot weaken a known conflict.
    if (entry.uid?.value !== day.source.officialUid || entry.type?.value !== definition.counterId) {
      fail('ORDER_DELIVERY_SERVER_COUNTER_IDENTITY_CONFLICT');
    }
    const raw = entry.tdyCnt.value, total = entry.totCnt.value, rTime = entry.rTime.value, effective = rTime < day.startMs ? 0 : raw;
    let offset = 0;
    if (kind !== 'resident') {
      let created;
      if (supplied.generatedOrderTimeProof) created = readCell(supplied.generatedOrderTimeProof, 'fields', 'cTime');
      else if (s.method === 'index.login' && s.responseRef === day.source.responseRef) {
        const resolved = resolveOrderFlowerObservationEvidence({ store, context, requestSequence: s.requestSequence, responseRef: s.responseRef });
        const loginRow = resolved?.row, loginFrame = resolved?.frame;
        const cell = loginFrame?.payload?.fields?.[kind]?.value?.fields?.cTime;
        if (loginRow && resolved.wholeFrameFingerprint === loginRow.payload_fingerprint && resolved.payloadFingerprint === loginFrame.payloadFingerprint &&
            resolved.accepted && loginFrame.admissible &&
            sameOrderFlowerContext(loginFrame.context, context) && sameSource(loginFrame.source, s) && loginFrame.source.transport === 'answered' &&
            orderFlowerSourceProofValid(loginFrame.source.version, kind) && loginFrame.source.version?.protocolVersion === loginVersion?.protocolVersion &&
            loginFrame.source.version?.loginResponseRef === loginFrame.source.responseRef && positive(loginFrame.source.serverMs) &&
            loginFrame.source.serverMs >= day.startMs && loginFrame.source.serverMs < day.endMs && knownOrderFlowerCell(cell)) created = { value: cell.value };
      }
      if (!created || !positive(created.value)) fail('ORDER_DELIVERY_GENERATED_ORDER_TIME_REQUIRED');
      offset = created.value >= day.startMs ? 1 : 0;
    }
    const count = Math.max(effective - offset, 0);
    if (supplied.raw !== raw || supplied.total !== total || supplied.rawRTime !== rTime || supplied.value !== count) fail('ORDER_DELIVERY_SERVER_COUNT_BINDING_CONFLICT');
    return { known: true, counterId: definition.counterId, raw, total, rawRTime: rTime, effective, offset, value: count,
      source: clone(legacyCounterFrame?.source ?? s), cellProofs: clone(supplied.cellProofs ?? null),
      ...(supplied.generatedOrderTimeProof ? { generatedOrderTimeProof: clone(supplied.generatedOrderTimeProof) } : {}),
      sourceObservationRef: legacyCounterRow?.observation_ref ?? s.responseRef,
      sourceFingerprint: legacyCounterRow?.payload_fingerprint ?? fingerprint([s, supplied.cellProofs ?? null]),
      originalOfficialCounterUnchanged: true };
  }
  function evidence(row) {
    if (!row) return null;
    const payload = parseStored(row.payload_json, '三类订单原证据');
    return ledgerJsonFingerprint({ kind: row.kind, source: row.source, payload, observedAt: row.observed_at }) === row.payload_fingerprint ? payload : null;
  }
  function confirmedOperation(operationId) {
    const op = get('SELECT * FROM backend_operations WHERE operation_id=?', operationId), original = op && parseStored(op.original_json, '三类订单原操作');
    const definition = op && Object.values(ORDER_FLOWER_CONTRACTS).find(one => one.featureId === op.feature_id && one.scope === op.scope && one.method === op.method);
    if (!definition || op.business_verdict !== 'confirmed' || op.write_slot !== 0 || op.transport_state !== 'answered' ||
        ledgerJsonFingerprint(original) !== op.original_fingerprint || !Array.isArray(original.targets) || original.targets.length !== 1) fail('ORDER_DELIVERY_CONFIRMED_ORIGINAL_REQUIRED');
    const prepRow = get(`SELECT * FROM backend_operation_evidence WHERE operation_id=? AND kind='finite-domain-preparation'
      AND source='backend/write-gateway/v2' AND evidence_key='finite-domain-preparation:v1'`, operationId), preparation = evidence(prepRow);
    const contractRow = get(`SELECT * FROM backend_operation_evidence WHERE operation_id=? AND kind='admitted-operation-contract'
      AND source='backend/write-gateway/v2' AND evidence_key='admitted-operation-contract:v1'`, operationId), contract = evidence(contractRow);
    if (preparation?.domain !== 'order-flower-' + definition.kind || preparation.preparation?.kind !== definition.kind ||
        !orderFlowerHistoricalAdmittedContractMatches(contract, definition)) fail('ORDER_DELIVERY_FINITE_ORIGINAL_PREPARATION_REQUIRED');
    const proposal = { ...original, featureCancelEpoch: original.cancelEpoch,
      params: definition.kind === 'resident' ? { boxId: preparation.preparation.boxId } : {}, orderFlower: preparation.preparation };
    assertOrderFlowerProposal(proposal);
    const settlement = get('SELECT * FROM backend_operation_target_settlements WHERE operation_id=? AND member_key=?', operationId, original.targets[0].memberKey),
      result = settlement && parseStored(settlement.result_json, '三类订单原目标结算'), proof = result?.evidence?.payload;
    if (!settlement || settlement.verdict !== 'confirmed' || ledgerJsonFingerprint(result) !== settlement.result_fingerprint ||
        settlement.verification_version !== 'order-flower-ordinary-verification/after-close-v1' || op.verification_version !== settlement.verification_version ||
        result.verificationVersion !== settlement.verification_version || result.member?.verdict !== 'confirmed' ||
        result.member.memberKey !== original.targets[0].memberKey || result.evidence?.kind !== 'domain-verification' ||
        result.evidence.source !== 'backend/write-gateway/v2' || proof?.operationId !== operationId || proof.lifecycleRef !== proposal.orderFlower.lifecycleRef ||
        proof.contentFingerprint !== proposal.orderFlower.contentFingerprint || canonical(proof.beforeOrder) !== canonical(proposal.orderFlower.beforeOrder)) fail('ORDER_DELIVERY_CONFIRMED_TARGET_REQUIRED');
    const targetEvent = get('SELECT * FROM backend_operation_evidence WHERE operation_id=? AND evidence_id=?', operationId, settlement.evidence_id), targetPayload = evidence(targetEvent);
    if (targetEvent?.kind !== 'domain-verification' || targetEvent.source !== 'backend/write-gateway/v2' || !targetPayload ||
        canonical(targetPayload) !== canonical({ ...proof, member: result.member, verificationVersion: result.verificationVersion,
          resourceResolutions: result.resourceResolutions, transportTermination: result.transportTermination })) fail('ORDER_DELIVERY_TARGET_EVIDENCE_HASH_REQUIRED');
    const context = orderFlowerContext(proposal);
    if (!context || op.owner_ref !== context.ownerRef || op.account_ref !== context.accountRef || op.subject_ref !== context.subjectRef ||
        op.connection_epoch !== context.connectionEpoch || op.run_epoch !== context.runEpoch) fail('ORDER_DELIVERY_ORIGINAL_CONTEXT_CONFLICT');
    return { op, proposal, definition, settlement, proof, targetEvent, preparationRow: prepRow, context };
  }
  function receiptValue(row, seen = new Set()) {
    if (!row || seen.has(row.receipt_ref) || seen.size >= 4096) fail('ORDER_DELIVERY_FLOOR_CHAIN_INVALID');
    const receipt = parseStored(row.receipt_json, '三类订单实际交付下界'), hash = fingerprint(receipt);
    if (hash !== row.receipt_fingerprint || row.receipt_ref !== 'order-delivery-floor:' + hash || receipt.version !== RECEIPT_VERSION ||
        receipt.operationId !== row.operation_id || receipt.ownerRef !== row.owner_ref || receipt.subjectRef !== row.subject_ref || receipt.kind !== row.kind ||
        receipt.officialUid !== row.official_uid || receipt.day.dayKey !== row.day_key || receipt.day.startMs !== row.day_start_ms || receipt.day.endMs !== row.day_end_ms ||
        receipt.policyCountAfter !== row.policy_count_after) fail('ORDER_DELIVERY_FLOOR_RECEIPT_CORRUPT');
    const original = confirmedOperation(receipt.operationId);
    if (receipt.originalFingerprint !== original.op.original_fingerprint || receipt.settlementFingerprint !== original.settlement.result_fingerprint ||
        receipt.targetEvidenceFingerprint !== original.targetEvent.payload_fingerprint || receipt.preparationFingerprint !== original.preparationRow.payload_fingerprint ||
        original.context.ownerRef !== receipt.ownerRef || original.context.subjectRef !== receipt.subjectRef || original.definition.kind !== receipt.kind ||
        original.proposal.orderFlower.officialUid !== receipt.officialUid) fail('ORDER_DELIVERY_FLOOR_ORIGINAL_CONFLICT');
    if (recoveryRoot.matches(row,original)) {measureSyncCost(store,'delivery.root-hit',()=>null);return receipt;}
    if (validated.get(row.receipt_ref) === hash) return receipt;
    seen.add(row.receipt_ref);
    const {expectedDay,official}=measureSyncCost(store,'delivery.historical-source',()=>{
      const expectedDay=originalDay(original.context,original.proposal.orderFlower.day);
      return {expectedDay,official:serverCounter(original.context,original.definition.kind,expectedDay,original.proposal.orderFlower.counter)};
    });
    if (canonical(receipt.day) !== canonical(expectedDay) || canonical(receipt.serverCount) !== canonical(official)) fail('ORDER_DELIVERY_FLOOR_SOURCE_CONFLICT');
    let parentFloor = 0;
    if (receipt.parentFloorReceiptRef !== null) {
      const parentRow = get('SELECT * FROM backend_order_flower_delivery_receipts WHERE receipt_ref=?', receipt.parentFloorReceiptRef), parent = receiptValue(parentRow, seen);
      if (parent.ownerRef !== receipt.ownerRef || parent.subjectRef !== receipt.subjectRef || parent.kind !== receipt.kind || parent.day.dayKey !== receipt.day.dayKey ||
          parent.officialUid !== receipt.officialUid || parentRow.receipt_fingerprint !== receipt.parentFloorFingerprint) fail('ORDER_DELIVERY_FLOOR_PARENT_SCOPE_CONFLICT');
      parentFloor = parent.policyCountAfter;
    }
    const before = Math.max(official.value, parentFloor);
    if (receipt.policyCountBefore !== before || receipt.policyCountAfter !== before + 1 || !nonnegative(receipt.policyCountAfter)) fail('ORDER_DELIVERY_FLOOR_COUNT_CONFLICT');
    if(!validated.has(row.receipt_ref)&&validated.size>=64)validated.delete(validated.keys().next().value);
    validated.set(row.receipt_ref, hash);
    return receipt;
  }
  function latestFloor(context, kind, day) {
    const row = get(`SELECT * FROM backend_order_flower_delivery_receipts WHERE owner_ref=? AND subject_ref=? AND kind=?
      AND day_start_ms=? AND day_end_ms=? ORDER BY policy_count_after DESC,receipt_ref LIMIT 1`, context.ownerRef, context.subjectRef, kind, day.startMs, day.endMs);
    if (!row) return { value: 0, receiptRef: null, fingerprint: null };
    const receipt = receiptValue(row);
    if (receipt.day.dayKey !== day.dayKey || receipt.officialUid !== day.officialUid) fail('ORDER_DELIVERY_CURRENT_DAY_SCOPE_CONFLICT');
    return { value: receipt.policyCountAfter, receiptRef: row.receipt_ref, fingerprint: row.receipt_fingerprint };
  }
  function readPolicyCount({ context: supplied, kind, officialDay, serverCount } = {}) {
    const context = orderFlowerContext(supplied);
    if (!context || !ORDER_FLOWER_CONTRACTS[kind]) return freeze({ known: false, reasonCode: 'ORDER_DELIVERY_CURRENT_CONTEXT_REQUIRED' });
    const day = originalDay(context, officialDay), official = serverCounter(context, kind, day, serverCount), floor = latestFloor(context, kind, day);
    const body = { version: VERSION, known: true, context, kind, officialUid: day.officialUid, day, dayKey: day.dayKey,
      value: Math.max(official.value, floor.value), serverCount: official, confirmedFloor: floor.value,
      floorReceiptRef: floor.receiptRef, floorFingerprint: floor.fingerprint, originalOfficialCounterUnchanged: true,
      unknownCountedAsConfirmed: false, currentAdmissionRecheckRequired: true, readOnly: true, writeEligible: false };
    return freeze({ ...body, proofRef: 'order-delivery-policy-count:' + fingerprint(body) });
  }
  function recordConfirmed({ proposal: supplied = null, operationId: suppliedOperationId = null, verification = null, targetSettlement = null } = {}) {
    const operationId = supplied?.operationId ?? suppliedOperationId;
    if (!reference(operationId)) fail('ORDER_DELIVERY_ORIGINAL_OPERATION_REQUIRED');
    if (suppliedOperationId !== null && suppliedOperationId !== operationId) fail('ORDER_DELIVERY_ORIGINAL_OPERATION_CONFLICT');
    const row = get('SELECT business_verdict FROM backend_operations WHERE operation_id=?', operationId);
    if (!row || row.business_verdict !== 'confirmed') return freeze({ recorded: false, reasonCode: 'ORDER_DELIVERY_UNCONFIRMED_NOT_COUNTED', originalOutcomeUnchanged: true });
    return transaction(() => {
      const original = confirmedOperation(operationId), order = original.proposal.orderFlower, kind = original.definition.kind, context = original.context;
      if (supplied && (canonical(supplied.orderFlower) !== canonical(order) || !sameOrderFlowerContext(orderFlowerContext(supplied), context)) ||
          verification && (verification.verdict !== 'confirmed' || canonical(gatewayVerificationEvidencePayload(supplied?.traceId ?? original.proposal.traceId,
            verification.evidence)) !== canonical(original.proof)) ||
          targetSettlement && targetSettlement.settlement_key !== original.settlement.settlement_key) fail('ORDER_DELIVERY_CALLER_ORIGINAL_CONFLICT');
      const previous = get('SELECT * FROM backend_order_flower_delivery_receipts WHERE operation_id=?', operationId);
      if (previous) { const receipt = receiptValue(previous); return freeze({ recorded: true, replayed: true, receiptRef: previous.receipt_ref,
        policyCountAfter: receipt.policyCountAfter, officialCounterUnchanged: true }); }
      const day = originalDay(context, order.day), official = serverCounter(context, kind, day, order.counter), policy = order.policyCount;
      let parent = { value: 0, receiptRef: null, fingerprint: null };
      if (policy != null) {
        if (policy.version !== VERSION || policy.known !== true || policy.proofRef !== 'order-delivery-policy-count:' + fingerprint(withoutProof(policy)) ||
            !sameOrderFlowerContext(policy.context, context) || policy.kind !== kind || policy.officialUid !== day.officialUid || canonical(policy.day) !== canonical(day) ||
            canonical(policy.serverCount) !== canonical(official)) fail('ORDER_DELIVERY_ORIGINAL_POLICY_PROOF_INVALID');
        if (policy.floorReceiptRef !== null) {
          const parentRow = get('SELECT * FROM backend_order_flower_delivery_receipts WHERE receipt_ref=?', policy.floorReceiptRef), receipt = receiptValue(parentRow);
          if (receipt.ownerRef !== context.ownerRef || receipt.subjectRef !== context.subjectRef || receipt.kind !== kind || receipt.day.dayKey !== day.dayKey ||
              receipt.officialUid !== day.officialUid || parentRow.receipt_fingerprint !== policy.floorFingerprint || receipt.policyCountAfter !== policy.confirmedFloor) fail('ORDER_DELIVERY_ORIGINAL_POLICY_PARENT_INVALID');
          parent = { value: receipt.policyCountAfter, receiptRef: parentRow.receipt_ref, fingerprint: parentRow.receipt_fingerprint };
        } else if (policy.confirmedFloor !== 0 || policy.floorFingerprint !== null) fail('ORDER_DELIVERY_EMPTY_POLICY_FLOOR_INVALID');
        if (policy.value !== Math.max(official.value, parent.value)) fail('ORDER_DELIVERY_ORIGINAL_POLICY_VALUE_CONFLICT');
      } else if (order.deliveryPath === 'butler-stored-order') fail('ORDER_DELIVERY_STORED_POLICY_PROOF_REQUIRED');
      // Old already-confirmed ordinary operations without the new proof can
      // contribute only their sourceCount+1 lower bound. Never add them onto
      // today's latest floor and accidentally recount historical operations.
      const before = Math.max(official.value, parent.value), after = before + 1;
      if (!nonnegative(after)) fail('ORDER_DELIVERY_POLICY_COUNT_OVERFLOW');
      const receipt = { version: RECEIPT_VERSION, operationId, ownerRef: context.ownerRef, subjectRef: context.subjectRef, kind, officialUid: day.officialUid,
        day, serverCount: official, parentFloorReceiptRef: parent.receiptRef, parentFloorFingerprint: parent.fingerprint,
        policyCountBefore: before, policyCountAfter: after, originalFingerprint: original.op.original_fingerprint,
        preparationFingerprint: original.preparationRow.payload_fingerprint, settlementKey: original.settlement.settlement_key,
        settlementFingerprint: original.settlement.result_fingerprint, targetEvidenceFingerprint: original.targetEvent.payload_fingerprint,
        localConfirmedDeliveryIncrement: 1, officialCounterUnchanged: true, unknownCountedAsConfirmed: false };
      const hash = fingerprint(receipt), receiptRef = 'order-delivery-floor:' + hash;
      run('INSERT INTO backend_order_flower_delivery_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', receiptRef, operationId, context.ownerRef, context.subjectRef,
        kind, day.officialUid, day.dayKey, day.startMs, day.endMs, after, canonical(receipt), hash, nowIso());
      recoveryRoot.record(get('SELECT * FROM backend_order_flower_delivery_receipts WHERE receipt_ref=?',receiptRef),original);
      return freeze({ recorded: true, replayed: false, receiptRef, policyCountAfter: after, officialCounterUnchanged: true });
    });
  }
  return Object.freeze({ readPolicyCount, recordConfirmed });
}
