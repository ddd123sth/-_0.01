import { canonical, fingerprint, parseStored } from '../../common.mjs';
import { ledgerJsonFingerprint } from '../../persistence/json-contract.mjs';
import { ORDER_FLOWER_AXES, orderFlowerContextKey } from './wire-facts.mjs';
import { ORDER_FLOWER_AUX_POST_READ } from './auxiliary-contract.mjs';
import { ORDER_FLOWER_VIDEO_CONTRACTS } from './video-contract.mjs';
import { ORDER_FLOWER_REWARD_CONTRACTS } from './reward-contract.mjs';
import { ORDER_FLOWER_ENTER_CONTRACTS } from './enter-contract.mjs';
import { assertOrderFlowerVideoPreparedOperation } from './video-contract.mjs';
import { assertOrderFlowerRewardPreparedOperation } from './reward-contract.mjs';
import { assertOrderFlowerEnterPreparedOperation } from './enter-contract.mjs';
import { projectOrderFlowerAuxiliaryPreparation, projectOrderFlowerAuxiliaryVerification } from './audit-projection.mjs';

const PROOF_VERSION = Object.freeze({ video: 'order-flower-video-after-close-login/v1',
  reward: 'order-flower-reward-after-close-login/v1', enter: 'order-flower-enter-after-close-login/v1' });
const binding = ['connectionEpoch', 'requestSequence', 'wireKey', 'responseRef'];
const axes = value => value && Object.fromEntries(ORDER_FLOWER_AXES.map(key => [key, value[key]]));
const same = (a, b, keys) => !!a && !!b && keys.every(key => a[key] === b[key]);
const parse = (text, label) => { try { return parseStored(text, label); } catch { return null; } };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const pick = (value, names) => value == null ? null : Object.fromEntries(names.filter(key => value && Object.hasOwn(value, key)).map(key => [key, value[key]]));
const finite = () => [
  ...Object.entries(ORDER_FLOWER_VIDEO_CONTRACTS).map(([kind, definition]) => ({ family: 'video', kind,
    domain: 'order-flower-video-' + kind, definition })),
  ...Object.entries(ORDER_FLOWER_REWARD_CONTRACTS).map(([kind, definition]) => ({ family: 'reward', kind,
    domain: 'order-flower-reward-' + kind, definition })),
  ...Object.entries(ORDER_FLOWER_ENTER_CONTRACTS).map(([kind, definition]) => ({ family: 'enter', kind,
    domain: 'order-flower-enter-' + kind, definition }))
];

export function orderFlowerAuxiliaryAuditDomain(operation) {
  return finite().find(one => one.definition.featureId === operation?.feature_id && one.definition.scope === operation?.scope &&
    one.definition.method === operation?.method)?.domain ?? null;
}

/** Re-read immutable ledger/source rows; caller-provided projections are never treated as proof. */
export function readOrderFlowerAuxiliaryAuditTarget({ store, operation, settlement, lease, landPayloadFingerprint } = {}) {
  const missing = [], fail = code => { missing.push(code); return result(false); };
  const result = (complete, extras = {}) => ({ available: true, complete, reasonCode: complete ? 'ORDER_FLOWER_AUX_AUDIT_COMPLETE' : 'ORDER_FLOWER_AUX_AUDIT_INCOMPLETE',
    missing, ...extras });
  try {
    const domain = orderFlowerAuxiliaryAuditDomain(operation), spec = finite().find(one => one.domain === domain);
    if (!store || !operation?.operation_id || !spec) return fail('finite-contract');
    const storedOp = store.get(`SELECT * FROM backend_operations WHERE operation_id=? AND owner_ref=? AND account_ref=? AND subject_ref=?`,
      operation.operation_id, operation.owner_ref, operation.account_ref, operation.subject_ref);
    const original = storedOp && parse(storedOp.original_json, 'auxiliary original proposal');
    if (!storedOp || !original || storedOp.original_fingerprint !== operation.original_fingerprint ||
        ledgerJsonFingerprint(original) !== storedOp.original_fingerprint || original.ownerRef !== storedOp.owner_ref ||
        original.accountRef !== storedOp.account_ref || original.subjectRef !== storedOp.subject_ref) return fail('immutable-original-ledger');
    const targets = store.all(`SELECT member_key,target_kind,target_ref,lifecycle_ref,target_fingerprint,original_json FROM backend_operation_targets WHERE operation_id=?`, storedOp.operation_id);
    if (targets.length !== 1) return fail('single-target-ledger');
    const target = targets[0], targetOriginal = parse(target.original_json, 'auxiliary target original');
    if (!targetOriginal || canonical(targetOriginal) !== canonical(original.targets?.[0]) || target.member_key !== original.targets?.[0]?.memberKey ||
        target.target_kind !== spec.definition.targetKind || target.target_ref !== targetOriginal.targetRef ||
        target.lifecycle_ref !== targetOriginal.lifecycleRef || target.target_fingerprint !== targetOriginal.targetFingerprint) return fail('immutable-target-ledger');

    const evidenceRows = store.all(`SELECT evidence_id,evidence_key,kind,source,payload_json,payload_fingerprint,observed_at FROM backend_operation_evidence
      WHERE operation_id=? AND evidence_key IN ('admitted-operation-contract:v1','finite-domain-preparation:v1')`, storedOp.operation_id);
    const byKey = new Map(evidenceRows.map(row => [row.evidence_key, row]));
    const checkedEvidence = key => {
      const row = byKey.get(key), payload = row && parse(row.payload_json, 'auxiliary operation evidence');
      return row && payload && row.source === 'backend/write-gateway/v2' && row.payload_fingerprint === ledgerJsonFingerprint({
        kind: row.kind, source: row.source, payload, observedAt: row.observed_at }) ? { row, payload } : null;
    };
    const admitted = checkedEvidence('admitted-operation-contract:v1'), prepared = checkedEvidence('finite-domain-preparation:v1');
    const expectedContract = { ...spec.definition, postRead: { ...ORDER_FLOWER_AUX_POST_READ } };
    const preparation = prepared?.payload?.preparation;
    let preparedValid = false;
    try {
      if (preparation && prepared?.payload?.domain === domain) {
        const assertPrepared = spec.family === 'video' ? assertOrderFlowerVideoPreparedOperation :
          spec.family === 'reward' ? assertOrderFlowerRewardPreparedOperation : assertOrderFlowerEnterPreparedOperation;
        assertPrepared({ original, preparation }); preparedValid = true;
      }
    } catch { /* Keep a truthful missing source below. */ }
    if (!admitted || admitted.row.kind !== 'admitted-operation-contract' || canonical(admitted.payload) !== canonical(expectedContract) ||
        !prepared || prepared.row.kind !== 'finite-domain-preparation' || prepared.payload.domain !== domain || !preparedValid) {
      missing.push('admitted-contract-or-preparation-evidence');
    }
    const projectedPreparation = projectOrderFlowerAuxiliaryPreparation(preparation);
    if (projectedPreparation.complete !== true) missing.push('preparation-safe-projection-incomplete');

    const settlementRow = store.get(`SELECT settlement_key,verdict,verification_version,reason_code,evidence_id,result_json,result_fingerprint,recorded_at
      FROM backend_operation_target_settlements WHERE operation_id=? AND member_key=?`, storedOp.operation_id, target.member_key);
    const settlementResult = settlementRow && parse(settlementRow.result_json, 'auxiliary settlement result');
    const suppliedSettlementKey = settlement?.settlement_key ?? settlement?.settlementKey;
    if (!settlementRow || settlementRow.verdict !== 'confirmed' || settlementRow.verdict !== storedOp.business_verdict || storedOp.write_slot !== 0 ||
        storedOp.transport_state !== 'answered' || settlementRow.result_fingerprint !== ledgerJsonFingerprint(settlementResult) ||
        settlementRow.settlement_key !== suppliedSettlementKey || settlement?.result_fingerprint && settlement.result_fingerprint !== settlementRow.result_fingerprint ||
        settlement?.member_key && settlement.member_key !== target.member_key) {
      missing.push('immutable-target-settlement');
    }
    const evidence = settlementResult?.evidence, proof = evidence?.payload;
    const expectedProof = PROOF_VERSION[spec.family];
    const projectedVerification = projectOrderFlowerAuxiliaryVerification(proof);
    if (!proof || !proof.effect || proof.bridge?.version !== expectedProof || proof.operationId !== storedOp.operation_id ||
        proof.targetRef !== target.target_ref || proof.lifecycleRef !== target.lifecycle_ref || proof.targetFingerprint !== target.target_fingerprint ||
        settlementRow?.verification_version !== settlementResult?.verificationVersion || projectedVerification.complete !== true) missing.push('target-proof-binding-or-safe-projection');
    const settlementEvidence = settlementRow && store.get(`SELECT kind,source,payload_json,payload_fingerprint,observed_at FROM backend_operation_evidence
      WHERE operation_id=? AND evidence_id=?`, storedOp.operation_id, settlementRow.evidence_id);
    const settlementEvidencePayload = settlementEvidence && parse(settlementEvidence.payload_json, 'auxiliary target evidence');
    const eventCore = settlementEvidencePayload && Object.fromEntries(Object.entries(settlementEvidencePayload).filter(([key]) =>
      !['member', 'resourceResolutions', 'verificationVersion', 'transportTermination'].includes(key)));
    if (!settlementEvidence || settlementEvidence.kind !== 'domain-verification' || settlementEvidence.source !== 'backend/write-gateway/v2' ||
        settlementEvidence.payload_fingerprint !== ledgerJsonFingerprint({ kind: settlementEvidence.kind, source: settlementEvidence.source,
          payload: settlementEvidencePayload, observedAt: settlementEvidence.observed_at }) ||
        canonical(eventCore) !== canonical(proof) ||
        canonical(settlementEvidencePayload.member) !== canonical(settlementResult?.member) ||
        canonical(settlementEvidencePayload.resourceResolutions) !== canonical(settlementResult?.resourceResolutions) ||
        settlementEvidencePayload.verificationVersion !== settlementResult?.verificationVersion ||
        canonical(settlementEvidencePayload.transportTermination) !== canonical(settlementResult?.transportTermination)) missing.push('immutable-settlement-evidence');

    const answerRow = store.get(`SELECT kind,source,payload_json,payload_fingerprint,observed_at FROM backend_operation_evidence
      WHERE operation_id=? AND kind='official-answer' AND source='backend/write-gateway/v2'`, storedOp.operation_id);
    const answerEvent = answerRow && parse(answerRow.payload_json, 'auxiliary matched RPC answer');
    const answerPermit = store.get(`SELECT operation_id,owner_ref,subject_ref,owner_epoch,run_epoch,connection_epoch,method,params_fingerprint,consumed,wire_key,request_sequence
      FROM backend_send_permits WHERE operation_id=?`, storedOp.operation_id);
    const answerLedgerValid = !!answerRow && !!answerEvent && answerRow.payload_fingerprint === ledgerJsonFingerprint({ kind: answerRow.kind,
      source: answerRow.source, payload: answerEvent, observedAt: answerRow.observed_at }) && answerEvent.method === storedOp.method &&
      answerEvent.connectionEpoch === storedOp.connection_epoch && answerEvent.responseRef === proof?.answer?.responseRef &&
      answerEvent.wireKey === proof?.answer?.wireKey && answerEvent.requestSequence === proof?.answer?.requestSequence &&
      answerPermit?.consumed === 1 && answerPermit.operation_id === storedOp.operation_id && answerPermit.owner_ref === storedOp.owner_ref &&
      answerPermit.subject_ref === storedOp.subject_ref && answerPermit.owner_epoch === original.ownerEpoch && answerPermit.run_epoch === original.runEpoch &&
      answerPermit.connection_epoch === storedOp.connection_epoch && answerPermit.method === storedOp.method &&
      answerPermit.params_fingerprint === storedOp.params_fingerprint && answerPermit.wire_key === answerEvent.wireKey &&
      answerPermit.request_sequence === answerEvent.requestSequence && settlementResult?.transportTermination?.ended === true &&
      settlementResult.transportTermination.source === 'matched-rpc-response' &&
      settlementResult.transportTermination.operationId === storedOp.operation_id &&
      settlementResult.transportTermination.connectionEpoch === storedOp.connection_epoch &&
      settlementResult.transportTermination.wireKey === answerEvent.wireKey &&
      settlementResult.transportTermination.requestSequence === answerEvent.requestSequence &&
      settlementResult.transportTermination.responseRef === answerEvent.responseRef;
    if (!answerLedgerValid) missing.push('matched-answer-ledger-and-permit');

    const leaseRows = store.all(`SELECT lease_ref,operation_id,executor_ref,owner_ref,account_ref,subject_ref,owner_epoch,run_epoch,
      original_connection_epoch,new_connection_epoch,state,active,original_context_json,after_json,bridge_json,bridge_fingerprint
      FROM backend_session_verification_leases WHERE operation_id=? AND owner_ref=? AND account_ref=? AND subject_ref=?`,
    storedOp.operation_id, storedOp.owner_ref, storedOp.account_ref, storedOp.subject_ref);
    const leaseRow = leaseRows.length === 1 ? leaseRows[0] : null;
    const bridge = leaseRow?.bridge_json && parse(leaseRow.bridge_json, 'auxiliary verification bridge');
    const oldContext = leaseRow?.original_context_json && parse(leaseRow.original_context_json, 'auxiliary lease original context');
    const after = leaseRow?.after_json && parse(leaseRow.after_json, 'auxiliary lease answer binding');
    const next = bridge?.newContext, leaseNewLogin = bridge?.newLoginSource, closureRef = bridge?.oldPhysicalCloseReceipt?.closureEvidenceRef;
    const closeRow = closureRef && store.get(`SELECT evidence_ref,owner_ref,account_ref,subject_ref,executor_ref,owner_epoch,run_epoch,connection_epoch,proof_kind,proof_json
      FROM backend_session_connection_closures WHERE evidence_ref=?`, closureRef);
    const closeProof = closeRow?.proof_json && parse(closeRow.proof_json, 'auxiliary physical-close proof');
    const closeValid = !!closeRow && closeRow.evidence_ref === 'session-close:' + fingerprint([leaseRow.executor_ref, storedOp.subject_ref,
      storedOp.connection_epoch, closeRow.proof_kind]) && closeRow.owner_ref === storedOp.owner_ref && closeRow.account_ref === storedOp.account_ref &&
      closeRow.subject_ref === storedOp.subject_ref && closeRow.executor_ref === leaseRow.executor_ref && closeRow.owner_epoch === original.ownerEpoch &&
      closeRow.run_epoch === original.runEpoch && closeRow.connection_epoch === storedOp.connection_epoch &&
      closeRow.proof_kind === 'verification-snapshot-physical-close' && closeProof?.closed === true &&
      closeProof.leaseRef === leaseRow.lease_ref && closeProof.operationId === storedOp.operation_id &&
      closeProof.source === 'verification-snapshot-actual-close' && same(closeProof.after, after, binding);
    const oldLogin = bridge?.oldLoginSource, newLogin = leaseNewLogin;
    const bridgeLoginsValid = oldLogin?.kind === 'response' && oldLogin.transport === 'answered' && oldLogin.method === 'index.login' &&
      oldLogin.connectionEpoch === oldContext?.connectionEpoch && oldLogin.officialUid === bridge?.officialUid &&
      oldLogin.versionEvidence?.source === 'normal-package-hop-and-matched-world-login/v1' &&
      oldLogin.versionEvidence.loginResponseRef === oldLogin.responseRef && newLogin?.kind === 'response' && newLogin.transport === 'answered' &&
      newLogin.method === 'index.login' && newLogin.connectionEpoch === next?.connectionEpoch && newLogin.officialUid === bridge?.officialUid &&
      newLogin.versionEvidence?.source === 'normal-package-hop-and-matched-world-login/v1' &&
      newLogin.versionEvidence.loginResponseRef === newLogin.responseRef &&
      newLogin.versionEvidence.gameVersion === oldLogin.versionEvidence.gameVersion &&
      newLogin.versionEvidence.protocolVersion === oldLogin.versionEvidence.protocolVersion;
    if (!leaseRow || lease?.lease_ref && lease.lease_ref !== leaseRow.lease_ref || !bridge || leaseRow.active !== 0 || !['released', 'recovered-retired'].includes(leaseRow.state) ||
        bridge.leaseRef !== leaseRow.lease_ref || bridge.operationId !== storedOp.operation_id || fingerprint(bridge) !== leaseRow.bridge_fingerprint ||
        !same(oldContext, original, ORDER_FLOWER_AXES) || !same(oldContext, bridge.originalContext, ORDER_FLOWER_AXES) ||
        !same(bridge.after, after, binding) || !next || !same(oldContext, next, ORDER_FLOWER_AXES.slice(0, 5)) ||
        next.connectionEpoch <= oldContext.connectionEpoch || next.connectionEpoch !== leaseRow.new_connection_epoch ||
        bridge.oldPhysicalCloseReceipt?.closed !== true || bridge.oldPhysicalCloseReceipt.connectionEpoch !== oldContext.connectionEpoch ||
        !closeValid || !bridgeLoginsValid || !same(proof?.bridge, bridge, ['leaseRef', 'operationId']) ||
        proof?.bridge?.bridgeFingerprint !== leaseRow.bridge_fingerprint ||
        !same(proof?.bridge?.originalContext, oldContext, ORDER_FLOWER_AXES) || !same(proof?.bridge?.newContext, next, ORDER_FLOWER_AXES) ||
        !same(proof?.bridge?.after, after, binding) ||
        canonical(proof?.bridge?.newLogin) !== canonical({ kind: leaseNewLogin?.kind ?? null, method: leaseNewLogin?.method ?? null,
          connectionEpoch: leaseNewLogin?.connectionEpoch ?? null, requestSequence: leaseNewLogin?.requestSequence ?? null,
          responseRef: leaseNewLogin?.responseRef ?? null, wireKey: leaseNewLogin?.wireKey ?? null,
          gameVersion: leaseNewLogin?.versionEvidence?.gameVersion ?? null, protocolVersion: leaseNewLogin?.versionEvidence?.protocolVersion ?? null,
          loginResponseRef: leaseNewLogin?.versionEvidence?.loginResponseRef ?? null })) missing.push('closed-six-axis-verification-lease');

    const postRead = proof?.postRead;
    const auxTable = store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='backend_order_flower_auxiliary_observations'");
    let freshAux = null, freshPayload = null, freshSource = null;
    if (auxTable && newLogin && next) {
      const rows = store.all(`SELECT observation_ref,context_key,owner_epoch,run_epoch,connection_epoch,source_json,accepted,reason_code,payload_json,payload_fingerprint,recorded_at
        FROM backend_order_flower_auxiliary_observations WHERE owner_ref=? AND account_ref=? AND subject_ref=? AND context_key=?
        AND owner_epoch=? AND run_epoch=? AND connection_epoch=?`, next.ownerRef, next.accountRef, next.subjectRef,
      orderFlowerContextKey(next), next.ownerEpoch, next.runEpoch, next.connectionEpoch);
      const candidates = rows.map(row => ({ row, source: parse(row.source_json, 'auxiliary login source'), payload: parse(row.payload_json, 'auxiliary fresh semantic payload') }))
        .filter(one => one.row.accepted === 1 && one.source?.responseRef === newLogin.responseRef &&
          one.source?.requestSequence === newLogin.requestSequence && one.source?.wireKey === newLogin.wireKey &&
          one.source?.method === 'index.login' && one.source?.transport === 'answered' && one.source?.source === 'response' &&
          one.source?.envelopeOk === true && one.source?.dsName === 'G.ISyncData' &&
          (one.source?.protocolVersion == null || one.source.protocolVersion === '480.0.0') &&
          same(one.source?.context, next, ORDER_FLOWER_AXES) && one.source?.officialUid === bridge.officialUid &&
          one.source?.versionEvidence?.source === 'normal-package-hop-and-matched-world-login/v1' &&
          one.source?.versionEvidence?.gameVersion === '480.0.27' && one.source?.versionEvidence?.protocolVersion === '480.0.0' &&
          one.source?.versionEvidence?.loginResponseRef === newLogin.responseRef &&
          one.row.payload_fingerprint === fingerprint(one.payload));
      if (candidates.length === 1) { freshAux = candidates[0].row; freshPayload = candidates[0].payload; freshSource = candidates[0].source; }
    }
    if (!freshAux || !postRead || postRead.responseRef !== freshSource?.responseRef || postRead.requestSequence !== freshSource?.requestSequence ||
        postRead.wireKey !== freshSource?.wireKey || freshPayload?.inventory?.known !== true ||
        freshPayload.inventory.value?.officialUid !== bridge?.officialUid ||
        freshPayload.inventory.value?.bagFingerprint !== proof?.effect?.inventory?.afterBagFingerprint ||
        !same(freshSource?.context, next, ORDER_FLOWER_AXES)) missing.push('fresh-login-auxiliary-semantic-source');

    const answerSource = proof?.answer, answerObservation = answerSource && store.get(`SELECT observation_ref,accepted,frame_json,payload_fingerprint,recorded_at
      FROM backend_land_domain_observations WHERE owner_ref=? AND account_ref=? AND subject_ref=? AND connection_epoch=?
      AND request_sequence=? AND wire_key=? AND response_ref=?`, storedOp.owner_ref, storedOp.account_ref, storedOp.subject_ref,
    original.connectionEpoch, answerSource.requestSequence, answerSource.wireKey, answerSource.responseRef);
    const answerFrame = answerObservation?.frame_json && parse(answerObservation.frame_json, 'auxiliary matched answer semantic frame');
    let answerHashValid = false;
    if (answerObservation?.accepted === 1 && answerFrame?.admissible && same(answerFrame.context, original, ORDER_FLOWER_AXES) &&
        same(answerFrame.source, answerSource, binding) && typeof landPayloadFingerprint === 'function') {
      try { answerHashValid = landPayloadFingerprint(answerFrame) === answerObservation.payload_fingerprint; } catch { answerHashValid = false; }
    }
    if (!answerHashValid || !answerSource || answerSource.responseRef !== bridge?.after?.responseRef ||
        answerSource.requestSequence !== bridge?.after?.requestSequence || answerSource.wireKey !== bridge?.after?.wireKey) missing.push('matched-answer-land-semantic-source');

    const missingUnique = [...new Set(missing)];
    return result(missingUnique.length === 0, { domain, family: spec.family, kind: spec.kind, operationId: storedOp.operation_id,
      target: pick(targetOriginal, ['memberKey', 'targetKind', 'targetRef', 'lifecycleRef', 'targetFingerprint']),
      admittedEvidence: admitted && { evidenceId: admitted.row.evidence_id, fingerprint: admitted.row.payload_fingerprint, verified: true },
      preparationEvidence: prepared && { evidenceId: prepared.row.evidence_id, fingerprint: prepared.row.payload_fingerprint, verified: true,
        preparation: projectedPreparation.value, projectionComplete: projectedPreparation.complete },
      settlement: settlementRow && { settlementKey: settlementRow.settlement_key, resultFingerprint: settlementRow.result_fingerprint,
        verdict: settlementRow.verdict, verificationVersion: settlementRow.verification_version,
        storedFingerprintVerified: settlementRow.result_fingerprint === ledgerJsonFingerprint(settlementResult),
        evidenceId: settlementRow.evidence_id, evidenceFingerprint: settlementEvidence?.payload_fingerprint },
      lease: leaseRow && { leaseRef: leaseRow.lease_ref, bridgeFingerprint: leaseRow.bridge_fingerprint,
        originalContext: axes(oldContext), newContext: axes(next), closureEvidenceRef: closureRef, closed: closeValid },
      targetProof: projectedVerification.value, verificationProjectionComplete: projectedVerification.complete,
      targetTrace: { settlementKey: settlementRow?.settlement_key ?? null, settlementFingerprint: settlementRow?.result_fingerprint ?? null,
        settlementEvidenceId: settlementRow?.evidence_id ?? null, targetRef: target.target_ref, memberKey: target.member_key },
      matchedAnswerSource: answerHashValid && { observationRef: answerObservation.observation_ref, payloadFingerprint: answerObservation.payload_fingerprint,
        source: pick(answerFrame.source, binding), semanticFrameFingerprint: fingerprint(answerFrame), effect: projectLandEffect(answerFrame) },
      freshLoginSource: freshAux && { observationRef: freshAux.observation_ref, payloadFingerprint: freshAux.payload_fingerprint,
        source: pick(freshSource, ['source', 'transport', 'method', 'connectionEpoch', 'requestSequence', 'wireKey', 'responseRef', 'officialUid', 'versionEvidence']),
        inventoryFingerprint: freshPayload.inventory.value.bagFingerprint, profile: pick(freshPayload.inventory.value.profile, ['gold', 'yb', 'level', 'lvlExp']) },
      actualEffect: projectEffect(proof?.effect), missing: missingUnique });
  } catch {
    if (!missing.length) missing.push('auxiliary-audit-source-read-failed');
    return result(false, { missing: [...new Set(missing)] });
  }
}

function projectLandEffect(frame) {
  const flow = value => {
    const items = value?.items;
    if (!items || typeof items !== 'object' || Array.isArray(items)) return null;
    const entries = Object.entries(items).filter(([id]) => /^[1-9]\d*$/.test(id)).slice(0, 32)
      .map(([id, cell]) => ({ itemId: Number(id), state: cell?.state ?? null, presence: cell?.presence ?? null,
        quantity: Number.isSafeInteger(cell?.value) && cell.value >= 0 ? cell.value : null, sourceRef: cell?.sourceRef ?? null }));
    return { total: Object.keys(items).length, limit: 32, complete: Object.keys(items).length <= 32 && entries.every(one => one.quantity !== null), entries };
  };
  const bag = frame?.bag;
  return { profile: pick(frame?.profile, ['uid', 'gold', 'yuanbao', 'level', 'lvlExp']),
    bag: { presence: bag?.presence ?? null, state: bag?.state ?? null,
      valueFingerprint: bag?.value == null ? null : fingerprint(bag.value) },
    flows: Object.fromEntries(['bi', 'bo', 'bd', 'actBi', 'actBo', 'proxyBi', 'proxyBo'].map(key => [key, flow(frame?.[key])])) };
}

function projectEffect(effect) {
  if (!effect) return null;
  const inventory = effect.inventory;
  return { kind: effect.kind ?? null, boxId: effect.boxId ?? null, opportunity: pick(effect.opportunity, ['kind', 'life', 'reason', 'basisRef']),
    beforeOrder: pick(effect.beforeOrder, ['kind', 'boxId', 'npcId', 'dialogId', 'isVideo', 'cdTime', 'cTime', 'placeIdx', 'finishCnt']),
    afterOrder: pick(effect.afterOrder, ['kind', 'boxId', 'npcId', 'dialogId', 'isVideo', 'cdTime', 'cTime', 'placeIdx', 'finishCnt']),
    reward: effect.reward ? pick(effect.reward, ['kind', 'target', 'taskId', 'expectedReward', 'actualOwnershipTransitionProven', 'actualBagGrantAlternative']) : null,
    inventory: inventory ? { known: inventory.known, beforeBagFingerprint: inventory.beforeBagFingerprint ?? null,
      afterBagFingerprint: inventory.afterBagFingerprint ?? null, gains: inventory.gains ?? null, proxyGains: inventory.proxyGains ?? null,
      profileBefore: pick(inventory.profileBefore, ['gold', 'yb', 'level', 'lvlExp']), profileAfter: pick(inventory.profileAfter, ['gold', 'yb', 'level', 'lvlExp']) } : null,
    shareBefore: pick(effect.shareBefore, ['uid', 'shareId', 'shareCnt', 'recvCnt', 'total', 'uTime']),
    shareAfter: pick(effect.shareAfter, ['uid', 'shareId', 'shareCnt', 'recvCnt', 'total', 'uTime']),
    counters: Array.isArray(effect.counters) ? effect.counters.slice(0, 4).map(one => ({ before: pick(one.before, ['uid', 'type', 'raw', 'total', 'rTime']),
      after: pick(one.after, ['uid', 'type', 'raw', 'total', 'rTime']), changed: one.changed ?? null })) : null,
    capabilityReceiptRef: effect.capability?.receiptRef ?? null, cardReceiptRef: effect.capability?.cardReceiptRef ?? null,
    targetTraceRef: effect.targetTraceRef ?? null, targetFingerprint: effect.targetFingerprint ?? null };
}
