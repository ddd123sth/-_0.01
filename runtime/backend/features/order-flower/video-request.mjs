import { canonical, clone, fingerprint, freeze, newId, parseStored, problem } from '../../common.mjs';
import { ledgerJsonFingerprint } from '../../persistence/json-contract.mjs';
import { orderFlowerContext, sameOrderFlowerContext } from './wire-facts.mjs';
import { auxiliarySemanticKeyBinding } from './auxiliary-contract.mjs';
import { createPersistedCurrentNeedBindingValidator } from '../../execution/current-need-binding.mjs';

const REQUEST_KIND = 'legacy-api-request';
const LEGACY_REQUEST_COLUMNS = 'request_ref,owner_ref,subject_ref,operation_id,official_uid,day_start_ms,day_end_ms,day_offset,opportunity_key,binding_json,binding_fingerprint,state,reason_code,created_at,updated_at';
const requestFeature = shareId => ({ 5: ['order.resident', 'order-resident-video'], 19: ['order.satin', 'order-satin-video'], 34: ['order.decorate', 'order-decorate-video'] })[shareId] || null;
const same = (a, b) => canonical(a) === canonical(b);
const fail = code => problem(code, '本次官方视频订单请求未获准');
const routeOf = value => {
  if (value?.known !== true || value.source !== 'official-sdk-effective-ad-route/v1' ||
    value.openAdRewardSdk?.known !== true || typeof value.openAdRewardSdk.value !== 'boolean' ||
    value.nativeAbSwitch?.known !== true || typeof value.nativeAbSwitch.value !== 'boolean') return null;
  const proofRef = typeof value.proofRef === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value.proofRef) ? value.proofRef : null;
  return proofRef ? { source: value.source, proofRef, openAdRewardSdk: { known: true, value: value.openAdRewardSdk.value },
    nativeAbSwitch: { known: true, value: value.nativeAbSwitch.value } } : null;
};
const exactRequestRoute = route => route?.source === 'official-sdk-effective-ad-route/v1' &&
  route.openAdRewardSdk?.value === false && route.nativeAbSwitch?.value === true;

function binding(input) {
  const p = input.preparation, context = orderFlowerContext(input.context);
  if (!context || !p || ![5, 19, 34].includes(input.shareId) || p.publicArgs?.shareId !== input.shareId ||
    p.officialUid !== input.officialUid || !Number.isSafeInteger(p.day?.startMs) || !Number.isSafeInteger(p.day?.endMs) ||
    p.day.endMs <= p.day.startMs || !Number.isFinite(p.day.utcOffsetMinutes) || !p.day.proofRef ||
    !Array.isArray(input.targets) || input.targets.length !== 1 || input.targets[0].lifecycleRef !== p.lifecycleRef ||
    !same(p.context ?? context, context) || p.adSlotTag !== input.adSlotTag || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.adSlotTag || ''))
    throw fail('ORDER_VIDEO_REQUEST_ORIGINAL_BINDING_INVALID');
  return { context, officialUid: input.officialUid, operationId: input.operationId, semanticKey: input.semanticKey,
    targets: clone(input.targets), shareId: input.shareId, adSlotTag: input.adSlotTag, lifecycleRef: p.lifecycleRef,
    contentFingerprint: p.contentFingerprint, targetFingerprint: p.targetFingerprint, configRevision: input.configRevision,
    featureCancelEpoch: input.featureCancelEpoch, day: clone(p.day), source: clone(p.source), versionEvidence: clone(p.versionEvidence),
    publicArgs: clone(p.publicArgs), inventoryFingerprint: fingerprint(p.beforeInventory), stockPlanningFingerprint: fingerprint(p.stockPlanning) };
}
function proposalBinding(proposal) {
  return binding({ ...proposal, context: orderFlowerContext(proposal), officialUid: proposal.orderFlowerVideo?.officialUid,
    shareId: proposal.orderFlowerVideo?.publicArgs?.shareId, adSlotTag: proposal.orderFlowerVideo?.adSlotTag,
    preparation: proposal.orderFlowerVideo });
}

export function createOrderFlowerVideoRequests({ store, ledgerView, isCurrent, connectionFor, readGenerationFacts } = {}) {
  for (const fn of [store?.run, store?.get, store?.all, store?.transaction, ledgerView?.operation, isCurrent, connectionFor,
    readGenerationFacts]) {
    if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') throw new TypeError('Video request provider requires synchronous persistence and guard ports');
  }
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_order_legacy_api_requests(
    request_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,operation_id TEXT NOT NULL,official_uid INTEGER NOT NULL,
    day_start_ms INTEGER NOT NULL,day_end_ms INTEGER NOT NULL,day_offset REAL NOT NULL,opportunity_key TEXT NOT NULL,
    binding_json TEXT NOT NULL,binding_fingerprint TEXT NOT NULL,state TEXT NOT NULL,reason_code TEXT,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    UNIQUE(owner_ref,subject_ref,official_uid,day_start_ms,day_end_ms,day_offset,opportunity_key));
    CREATE UNIQUE INDEX IF NOT EXISTS backend_order_legacy_api_request_opportunity_unique
      ON backend_order_legacy_api_requests(owner_ref,subject_ref,official_uid,opportunity_key);
    CREATE TRIGGER IF NOT EXISTS backend_order_legacy_api_request_proof_immutable BEFORE UPDATE OF request_ref,owner_ref,subject_ref,operation_id,
      official_uid,day_start_ms,day_end_ms,day_offset,opportunity_key,binding_json,binding_fingerprint ON backend_order_legacy_api_requests
      BEGIN SELECT RAISE(ABORT,'legacy API request proof is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_order_legacy_api_request_no_delete BEFORE DELETE ON backend_order_legacy_api_requests
      BEGIN SELECT RAISE(ABORT,'legacy API request proof cannot be deleted'); END;
    CREATE TABLE IF NOT EXISTS backend_order_legacy_api_request_attempts(
      request_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE,official_uid INTEGER NOT NULL,
      day_start_ms INTEGER NOT NULL,day_end_ms INTEGER NOT NULL,day_offset REAL NOT NULL,opportunity_key TEXT NOT NULL,
      binding_json TEXT NOT NULL,binding_fingerprint TEXT NOT NULL,state TEXT NOT NULL,reason_code TEXT,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS backend_order_legacy_api_request_attempts_opportunity
      ON backend_order_legacy_api_request_attempts(owner_ref,subject_ref,official_uid,opportunity_key,created_at);
    CREATE TRIGGER IF NOT EXISTS backend_order_legacy_api_request_attempt_proof_immutable BEFORE UPDATE OF request_ref,owner_ref,subject_ref,operation_id,
      official_uid,day_start_ms,day_end_ms,day_offset,opportunity_key,binding_json,binding_fingerprint ON backend_order_legacy_api_request_attempts
      BEGIN SELECT RAISE(ABORT,'legacy API request attempt proof is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_order_legacy_api_request_attempt_no_delete BEFORE DELETE ON backend_order_legacy_api_request_attempts
      BEGIN SELECT RAISE(ABORT,'legacy API request attempt proof cannot be deleted'); END;`);
  const validatePersistedNeed = createPersistedCurrentNeedBindingValidator({ store, ledgerView });
  function storedOperationPreparation(operationId) {
    const rows = store.all('SELECT kind,source,payload_json,payload_fingerprint,observed_at FROM backend_operation_evidence WHERE operation_id=? AND kind=? AND source=?',
      operationId, 'finite-domain-preparation', 'backend/write-gateway/v2');
    if (rows.length !== 1) return null;
    try {
      const row = rows[0], payload = parseStored(row.payload_json, 'stored video preparation');
      if (ledgerJsonFingerprint({ kind: row.kind, source: row.source, payload, observedAt: row.observed_at }) !== row.payload_fingerprint ||
          !payload?.domain?.startsWith('order-flower-video-') || !payload.preparation) return null;
      return { domain: payload.domain, preparation: payload.preparation };
    } catch { return null; }
  }
  function currentNeedMatchesOperation({ operation, original, proofBinding, phase, expectedNeed = null }) {
    const stored = storedOperationPreparation(operation.operation_id), prep = stored?.preparation, need = prep?.currentNeed;
    if (!stored || stored.domain !== 'order-flower-video-' + prep.kind ||
        prep.officialUid !== proofBinding.officialUid || prep.lifecycleRef !== proofBinding.lifecycleRef ||
        prep.targetFingerprint !== proofBinding.targetFingerprint || prep.adSlotTag !== proofBinding.adSlotTag ||
        !same(prep.publicArgs, proofBinding.publicArgs) || expectedNeed && !same(need, expectedNeed)) return false;
    const matched = auxiliarySemanticKeyBinding({ ...original, semanticKey: operation.semantic_key,
      featureId: operation.feature_id, targets: original.targets, orderFlowerVideo: { currentNeed: need } },
      'orderFlowerVideo', proofBinding.semanticKey);
    if (!matched.valid || matched.phase !== 'claimed') return false;
    return validatePersistedNeed({ currentNeed: need,
      context: { ownerRef: operation.owner_ref, accountRef: original.accountRef, subjectRef: operation.subject_ref,
        ownerEpoch: original.ownerEpoch, runEpoch: original.runEpoch, connectionEpoch: original.connectionEpoch },
      featureId: operation.feature_id, targetRef: original.targets?.[0]?.targetRef, operationId: operation.operation_id,
      baseSemanticKey: proofBinding.semanticKey, phase });
  }
  let closed = false;
  const requestRow = ref => store.get(`SELECT * FROM backend_order_legacy_api_requests WHERE request_ref=?
    UNION ALL SELECT * FROM backend_order_legacy_api_request_attempts WHERE request_ref=? LIMIT 1`, ref, ref);
  const allRequestRows = (where, ...params) => store.all(`SELECT * FROM (SELECT ${LEGACY_REQUEST_COLUMNS} FROM backend_order_legacy_api_requests
    UNION ALL SELECT ${LEGACY_REQUEST_COLUMNS} FROM backend_order_legacy_api_request_attempts) WHERE ${where}`, ...params);
  function classifyRequestDispatch(row, { currentBinding = null, isOriginalCurrent = null, isRequestAdmissionCurrent = null } = {}) {
    try {
      if (!row) return { provenNotSent: false, reasonCode: 'ORDER_VIDEO_REQUEST_ROW_MISSING' };
      const proof = parseStored(row.binding_json, 'legacy API request proof'), b = proof?.binding, context = orderFlowerContext(b?.context);
      if (!context || fingerprint(proof) !== row.binding_fingerprint || proof.version !== 'legacy-api-request/v1' ||
        proof.opportunityKey !== row.opportunity_key || b.operationId !== row.operation_id || b.officialUid !== row.official_uid ||
        context.ownerRef !== row.owner_ref || context.subjectRef !== row.subject_ref || b.day?.startMs !== row.day_start_ms ||
        b.day?.endMs !== row.day_end_ms || b.day?.utcOffsetMinutes !== row.day_offset || ![5, 19, 34].includes(b.shareId) ||
        !exactRequestRoute(proof.routing) || b.publicArgs?.shareId !== b.shareId || Object.hasOwn(b.publicArgs?.ext || {}, 'token') ||
        !Array.isArray(b.targets) || b.targets.length !== 1 || b.targets[0].lifecycleRef !== b.lifecycleRef ||
        b.targets[0].targetFingerprint !== b.targetFingerprint || !['prepared', 'unknown'].includes(row.state) ||
        !same(row.opportunity_key, fingerprint([row.owner_ref, row.subject_ref, row.official_uid, b.shareId, b.lifecycleRef,
          b.targetFingerprint, b.adSlotTag]))) return { provenNotSent: false, reasonCode: 'ORDER_VIDEO_REQUEST_BINDING_UNVERIFIED' };
      const operation = store.get('SELECT * FROM backend_operations WHERE operation_id=?', row.operation_id);
      if (!operation) {
        const orphanPermit = store.get('SELECT operation_id FROM backend_send_permits WHERE operation_id=?', row.operation_id);
        if (orphanPermit || !['prepared', 'unknown'].includes(row.state))
          return { provenNotSent: false, reasonCode: 'ORDER_VIDEO_REQUEST_GATEWAY_OPERATION_ABSENT_BUT_PERMIT_OR_STATE_PRESENT' };
        const oldContextEnded = isCurrent(context) !== true;
        const oldPolicySuperseded = currentBinding &&
          (b.configRevision !== currentBinding.configRevision || b.featureCancelEpoch !== currentBinding.featureCancelEpoch) &&
          typeof isOriginalCurrent === 'function' && isOriginalCurrent() === true &&
          typeof isRequestAdmissionCurrent === 'function' && isRequestAdmissionCurrent() === true;
        return oldContextEnded || oldPolicySuperseded
          ? { provenNotSent: true, reasonCode: oldContextEnded ? 'ORDER_VIDEO_REQUEST_GATEWAY_OPERATION_ABSENT_AFTER_CONTEXT_END'
            : 'ORDER_VIDEO_REQUEST_GATEWAY_OPERATION_ABSENT_AFTER_POLICY_SUPERSESSION', evidence: { requestRef: row.request_ref,
              operationId: row.operation_id, bindingFingerprint: row.binding_fingerprint, oldConfigRevision: b.configRevision,
              oldFeatureCancelEpoch: b.featureCancelEpoch, supersedingOperationId: currentBinding?.operationId ?? null,
              currentConfigRevision: currentBinding?.configRevision ?? null, currentFeatureCancelEpoch: currentBinding?.featureCancelEpoch ?? null } }
          : { provenNotSent: false, reasonCode: 'ORDER_VIDEO_REQUEST_GATEWAY_OPERATION_ABSENT_CURRENT_OR_INCONSISTENT' };
      }
      const original = JSON.parse(operation.original_json), featureScope = requestFeature(b.shareId);
      const ordinaryBaseKey = original.semanticKey === b.semanticKey && operation.semantic_key === b.semanticKey;
      const needBound = !ordinaryBaseKey && currentNeedMatchesOperation({ operation, original, proofBinding: b, phase: 'operation-owned' });
      if (operation.original_fingerprint !== ledgerJsonFingerprint(original) || !featureScope || operation.owner_ref !== row.owner_ref ||
        operation.subject_ref !== row.subject_ref || operation.operation_id !== row.operation_id || operation.method !== 'usr.share' ||
        operation.feature_id !== featureScope[0] || operation.scope !== featureScope[1] || !(ordinaryBaseKey || needBound) ||
        operation.params_fingerprint !== fingerprint(b.publicArgs) || original.operationId !== row.operation_id ||
        original.ownerRef !== row.owner_ref || original.subjectRef !== row.subject_ref || original.method !== 'usr.share' ||
        original.featureId !== featureScope[0] || original.scope !== featureScope[1] ||
        !(ordinaryBaseKey || needBound) || original.accountRef !== context.accountRef ||
        original.ownerEpoch !== context.ownerEpoch || original.runEpoch !== context.runEpoch ||
        original.connectionEpoch !== context.connectionEpoch || original.configRevision !== b.configRevision ||
        original.cancelEpoch !== b.featureCancelEpoch || original.paramsFingerprint !== fingerprint(b.publicArgs) ||
        !same(original.targets, b.targets)) return { provenNotSent: false, reasonCode: 'ORDER_VIDEO_REQUEST_GATEWAY_BINDING_MISMATCH' };
      const permit = store.get('SELECT * FROM backend_send_permits WHERE operation_id=?', row.operation_id);
      if (!permit || permit.owner_ref !== row.owner_ref || permit.subject_ref !== row.subject_ref || permit.owner_epoch !== context.ownerEpoch ||
        permit.run_epoch !== context.runEpoch || permit.connection_epoch !== context.connectionEpoch || permit.method !== 'usr.share' ||
        permit.params_fingerprint !== fingerprint(b.publicArgs) || permit.consumed !== 0 || permit.wire_key !== null || permit.request_sequence !== null)
        return { provenNotSent: false, reasonCode: 'ORDER_VIDEO_REQUEST_SEND_PERMIT_NOT_PROVEN_UNUSED' };
      if (operation.transport_state !== 'not_sent' || operation.business_verdict !== 'not_applicable' || operation.write_slot !== 0)
        return { provenNotSent: false, reasonCode: 'ORDER_VIDEO_REQUEST_GATEWAY_OUTCOME_NOT_PROVEN_UNSENT' };
      const events = store.all(`SELECT evidence_id,kind,source,payload_json,payload_fingerprint,observed_at FROM backend_operation_evidence
        WHERE operation_id=? ORDER BY evidence_id DESC`, row.operation_id);
      const proofEvent = events.find(event => {
        const payload = JSON.parse(event.payload_json);
        return event.kind === 'blocked-before-send' && event.source === 'backend/write-gateway/v2' &&
          ledgerJsonFingerprint({ kind: event.kind, source: event.source, payload, observedAt: event.observed_at }) === event.payload_fingerprint &&
          payload.nonSendProof?.permitConsumed === false && payload.nonSendProof?.byteSendStarted === false &&
          payload.nonSendProof?.source === 'same-process-permit-never-consumed';
      });
      return proofEvent ? { provenNotSent: true, reasonCode: 'ORDER_VIDEO_REQUEST_GATEWAY_PROVED_NOT_SENT',
        evidence: { requestRef: row.request_ref, operationId: row.operation_id, operationRevision: operation.revision,
          operationFingerprint: operation.original_fingerprint, nonSendEvidenceFingerprint: proofEvent.payload_fingerprint,
          nonSendEvidenceId: proofEvent.evidence_id } }
        : { provenNotSent: false, reasonCode: 'ORDER_VIDEO_REQUEST_NON_SEND_EVIDENCE_MISSING' };
    } catch { return { provenNotSent: false, reasonCode: 'ORDER_VIDEO_REQUEST_DISPATCH_CLASSIFICATION_UNVERIFIED' }; }
  }
  function legacyApiRequest({ binding: b, connection, signal, isOriginalCurrent, isRequestAdmissionCurrent } = {}) {
    const context = orderFlowerContext(b?.context), route = connection?.orderVideoRequestRouting?.();
    if (!b || !context || !sameOrderFlowerContext(context, b.context) || closed || signal?.aborted ||
      !connection?.isOpen?.() || !exactRequestRoute(routeOf(route)) || isCurrent(context) !== true ||
      typeof isOriginalCurrent !== 'function' || isOriginalCurrent() !== true ||
      typeof isRequestAdmissionCurrent !== 'function' || isRequestAdmissionCurrent() !== true)
      throw fail('ORDER_VIDEO_LEGACY_REQUEST_ROUTE_ORIGINAL_UNAVAILABLE');
    const routeProof = routeOf(route), requestBinding = { version: 'legacy-api-request/v1', binding: clone(b), routing: routeProof };
    const opportunityKey = fingerprint([context.ownerRef, context.subjectRef, b.officialUid, b.shareId,
      b.lifecycleRef, b.targetFingerprint, b.adSlotTag]);
    requestBinding.opportunityKey = opportunityKey;
    return store.transaction(() => {
      if (closed || signal.aborted || isCurrent(context) !== true || isOriginalCurrent() !== true ||
        isRequestAdmissionCurrent() !== true || !connection.isOpen?.() || !exactRequestRoute(routeOf(connection.orderVideoRequestRouting?.())))
        throw fail('ORDER_VIDEO_LEGACY_REQUEST_ORIGINAL_REVOKED');
      const priorNotSent = [];
      const priorRows = allRequestRows('owner_ref=? AND subject_ref=? AND official_uid=? AND opportunity_key=?',
        context.ownerRef, context.subjectRef, b.officialUid, opportunityKey);
      for (const row of priorRows) {
        const dispatch = classifyRequestDispatch(row, { currentBinding: b, isOriginalCurrent, isRequestAdmissionCurrent });
        if (!dispatch.provenNotSent) throw fail('ORDER_VIDEO_LEGACY_REQUEST_OPPORTUNITY_ALREADY_USED');
        priorNotSent.push({ ...dispatch.evidence, reasonCode: dispatch.reasonCode });
      }
      requestBinding.previousNotSent = priorNotSent;
      const requestRef = `legacy-api-request:${newId()}`, now = store.nowIso(), serialized = canonical(requestBinding);
      store.run('INSERT INTO backend_order_legacy_api_request_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', requestRef,
        context.ownerRef, context.subjectRef, b.operationId, b.officialUid, b.day.startMs, b.day.endMs, b.day.utcOffsetMinutes,
        opportunityKey, serialized, fingerprint(requestBinding), 'prepared', null, now, now);
      const receiptRef = 'legacy-api-request-proof:' + fingerprint(requestBinding);
      return { capability: freeze({ kind: REQUEST_KIND, context, officialUid: b.officialUid, requestRef, receiptRef,
        operationId: b.operationId, shareId: b.shareId, lifecycleRef: b.lifecycleRef, sourceKind: 'legacy-api-request-only',
        requestOnly: true, playbackClaimed: false, tokenPresent: false }), params: clone(b.publicArgs) };
    });
  }
  function validateCapability({ proposal, capability, phase } = {}) {
    try {
      if (capability?.kind !== REQUEST_KIND || Object.keys(capability).sort().join('|') !== ['kind', 'context', 'officialUid', 'requestRef', 'receiptRef',
        'operationId', 'shareId', 'lifecycleRef', 'sourceKind', 'requestOnly', 'playbackClaimed', 'tokenPresent'].sort().join('|') ||
        capability.requestOnly !== true || capability.playbackClaimed !== false || capability.tokenPresent !== false ||
        capability.sourceKind !== 'legacy-api-request-only' || !sameOrderFlowerContext(capability.context, orderFlowerContext(proposal)) ||
        capability.operationId !== proposal.operationId) return false;
      const row = requestRow(capability.requestRef);
      if (!row || !['prepared', 'confirmed', 'refused', 'unknown'].includes(row.state) || row.owner_ref !== proposal.ownerRef ||
        row.subject_ref !== proposal.subjectRef || row.official_uid !== capability.officialUid ||
        row.day_start_ms !== proposal.orderFlowerVideo?.day?.startMs || row.day_end_ms !== proposal.orderFlowerVideo?.day?.endMs ||
        row.day_offset !== proposal.orderFlowerVideo?.day?.utcOffsetMinutes ||
        row.opportunity_key !== fingerprint([proposal.ownerRef, proposal.subjectRef, capability.officialUid, capability.shareId,
          capability.lifecycleRef, proposal.orderFlowerVideo?.targetFingerprint, proposal.orderFlowerVideo?.adSlotTag])) return false;
      const proof = parseStored(row.binding_json, 'legacy API request proof');
      const keyBinding = auxiliarySemanticKeyBinding(proposal, 'orderFlowerVideo', proof.binding?.semanticKey);
      const proposalProofBinding = { ...proposalBinding(proposal), semanticKey: proof.binding?.semanticKey };
      if (fingerprint(proof) !== row.binding_fingerprint || capability.receiptRef !== 'legacy-api-request-proof:' + fingerprint(proof) ||
        proof.version !== 'legacy-api-request/v1' || proof.opportunityKey !== row.opportunity_key || !keyBinding.valid ||
        !same(proof.binding, proposalProofBinding) || proof.binding.operationId !== proposal.operationId ||
        proof.binding.shareId !== capability.shareId || proof.binding.lifecycleRef !== capability.lifecycleRef ||
        proof.binding.officialUid !== capability.officialUid || !exactRequestRoute(proof.routing) ||
        !same(proposal.params, proof.binding.publicArgs) || Object.hasOwn(proposal.params?.ext || {}, 'token')) return false;
      if (keyBinding.phase === 'claimed') {
        if (phase === 'original-verification') {
          const operation = store.get('SELECT * FROM backend_operations WHERE operation_id=?', capability.operationId);
          if (!operation) return false;
          const operationOriginal = parseStored(operation.original_json, 'video request gateway original');
          if (operation.operation_id !== proposal.operationId || operation.method !== 'usr.share' ||
              operation.original_fingerprint !== ledgerJsonFingerprint(operationOriginal) ||
              operation.semantic_key !== proposal.semanticKey || operationOriginal.semanticKey !== proposal.semanticKey ||
              operation.params_fingerprint !== fingerprint(proposal.params) || !same(operationOriginal.targets, proposal.targets) ||
              !currentNeedMatchesOperation({ operation, original: operationOriginal, expectedNeed: proposal.orderFlowerVideo?.currentNeed,
                proofBinding: proof.binding, phase: 'operation-owned' })) return false;
        } else {
          const need = proposal.orderFlowerVideo.currentNeed;
          if (!validatePersistedNeed({ currentNeed: need, context: orderFlowerContext(proposal),
              featureId: proposal.featureId, targetRef: proposal.targets?.[0]?.targetRef,
              operationId: proposal.operationId, baseSemanticKey: proof.binding.semanticKey, phase: 'prepare' })) return false;
        }
      }
      if (phase === 'original-verification') return true;
      const connection = connectionFor(proof.binding.context), route = routeOf(connection?.orderVideoRequestRouting?.());
      return !closed && row.state === 'prepared' && isCurrent(proof.binding.context) === true && connection?.isOpen?.() === true &&
        exactRequestRoute(route) && same(route, proof.routing);
    } catch { return false; }
  }
  function status(rawContext) {
    const context = orderFlowerContext(rawContext);
    if (!context) return freeze({ available: true, state: 'not-attempted', inFlight: false, terminal: true, requestRef: null });
    const connection = connectionFor(context), route = routeOf(connection?.orderVideoRequestRouting?.()), day = readGenerationFacts(context)?.officialDay;
    const rows = day?.startMs ? allRequestRows('owner_ref=? AND subject_ref=? AND day_start_ms=? AND day_end_ms=? AND day_offset=? ORDER BY created_at DESC LIMIT 1',
      context.ownerRef, context.subjectRef, day.startMs, day.endMs, day.utcOffsetMinutes) : [];
    const row = rows[0] ?? null, dispatch = row && ['prepared', 'unknown'].includes(row.state) ? classifyRequestDispatch(row) : null;
    return freeze({ available: true, routeEligible: exactRequestRoute(route), state: row?.state ?? 'not-attempted',
      inFlight: row?.state === 'prepared', terminal: row?.state !== 'prepared', requestOnly: true, playbackClaimed: false,
      retryable: dispatch?.provenNotSent === true, requestAnswered: ['confirmed', 'refused'].includes(row?.state),
      requestRef: row?.request_ref ?? null, operationId: row?.operation_id ?? null,
      reasonCode: dispatch?.reasonCode ?? row?.reason_code ?? null, updatedAt: row?.updated_at ?? null });
  }
  const onSettled = event => {
    const capability = event?.proposal?.orderFlowerVideo?.capability;
    if (capability?.kind !== REQUEST_KIND) return;
    const verdict = event.verification?.verdict === 'confirmed' ? 'confirmed'
      : event.verification?.verdict === 'rejected' ? 'refused' : 'unknown';
    const reason = verdict === 'confirmed' ? null : event.verification?.reasonCode || 'ORDER_VIDEO_LEGACY_REQUEST_EFFECT_UNPROVEN';
    for (const table of ['backend_order_legacy_api_requests', 'backend_order_legacy_api_request_attempts'])
      store.run(`UPDATE ${table} SET state=?,reason_code=?,updated_at=? WHERE request_ref=? AND operation_id=?
        AND state IN ('prepared','unknown','refused')`, verdict, reason, store.nowIso(), capability.requestRef, capability.operationId);
  };
  const shutdown = () => { closed = true; };
  return Object.freeze({ supportsLegacyApiRequest: true, complete(input) {
    const b = binding(input), context = b.context;
    if (closed || input.signal?.aborted || isCurrent(context) !== true || typeof input.isOriginalCurrent !== 'function' || input.isOriginalCurrent() !== true)
      throw fail('ORDER_VIDEO_LEGACY_REQUEST_ORIGINAL_REVOKED');
    const connection = connectionFor(context), route = connection?.orderVideoRequestRouting?.();
    if (!connection?.isOpen?.() || !route || route.known !== true) throw fail('ORDER_VIDEO_LEGACY_REQUEST_ROUTE_UNKNOWN');
    if (route.openAdRewardSdk.value !== false || route.nativeAbSwitch.value !== true) throw fail('ORDER_VIDEO_LEGACY_REQUEST_ROUTE_UNSUPPORTED');
    return legacyApiRequest({ binding: b, connection, signal: input.signal, isOriginalCurrent: input.isOriginalCurrent,
      isRequestAdmissionCurrent: input.isRequestAdmissionCurrent });
  }, validateCapability, status, onSettled, shutdown });
}
