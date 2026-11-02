import { canonical, fingerprint, freeze, parseStored, plainObject, problem, requireText } from '../common.mjs';
import { resolveArchivedSourceInstallBinding } from './evidence-digests.mjs';
import { ORDER_FLOWER_CONTRACTS, ORDER_FLOWER_POST_READ, orderFlowerHistoricalAdmittedContractMatches, assertOrderFlowerProposal } from '../features/order-flower/rpc-contract.mjs';
import { ORDER_FLOWER_AUX_POST_READ } from '../features/order-flower/auxiliary-contract.mjs';
import { ORDER_FLOWER_VIDEO_CONTRACTS, assertOrderFlowerVideoPreparedOperation } from '../features/order-flower/video-contract.mjs';
import { ORDER_FLOWER_REWARD_CONTRACTS, assertOrderFlowerRewardPreparedOperation } from '../features/order-flower/reward-contract.mjs';
import { ORDER_FLOWER_ENTER_CONTRACTS, assertOrderFlowerEnterPreparedOperation } from '../features/order-flower/enter-contract.mjs';
import { FLOWER_RACK_METHODS, FLOWER_RACK_SCOPES } from '../features/flower-rack/rpc-contract.mjs';
import { ledgerJsonFingerprint } from '../persistence/json-contract.mjs';
import { resolveNativeExecutorExitProof } from '../session/native-executor-identity.mjs';
import { resolveExecutionClosureEvidence } from '../session/execution-closure-evidence.mjs';

const positive = value => Number.isSafeInteger(value) && value > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const axes = ['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch'];
const flowerAuxiliary = [
  ...Object.entries(ORDER_FLOWER_VIDEO_CONTRACTS).map(([kind, definition]) => ({ definition, domain: 'order-flower-video-' + kind, assertPrepared: assertOrderFlowerVideoPreparedOperation })),
  ...Object.entries(ORDER_FLOWER_REWARD_CONTRACTS).map(([kind, definition]) => ({ definition, domain: 'order-flower-reward-' + kind, assertPrepared: assertOrderFlowerRewardPreparedOperation })),
  ...Object.entries(ORDER_FLOWER_ENTER_CONTRACTS).map(([kind, definition]) => ({ definition, domain: 'order-flower-enter-' + kind, assertPrepared: assertOrderFlowerEnterPreparedOperation })),
];
const sourceTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
function sync(callback, value) {
  const result = callback(value);
  if (result?.then) {
    result.catch?.(() => {});
    throw problem('ISOLATION_PROOF_ASYNC_PORT_FORBIDDEN', '隔离证据端口必须同步完成', 500);
  }
  return result;
}
const fields = (value, names) => Object.fromEntries(names.filter(name => Object.hasOwn(value || {}, name)).map(name => [name, value[name]]));
const safeTimeText = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value) ? value : null;
function legacyTargetMetadata(row) {
  let prepared = null;
  if (typeof row.prepared_evidence_json === 'string' && row.prepared_evidence_json.length <= 2_000_000) {
    try { prepared = JSON.parse(row.prepared_evidence_json); } catch { /* Preserve malformed historical before as unavailable. */ }
  }
  // Only the immutable prepared.before capsule supplies old target facts. A
  // mutable post-write evidence head is never silently used as its substitute.
  const bound = plainObject(prepared?.bound) ? prepared.bound : null;
  const numericNames = new Set(['landId', 'flowerId', 'state', 'harvestCount', 'harvestCnt', 'plantTime', 'plantTimeMs',
    'nextTime', 'observedAtMs', 'capturedAtMs', 'connectionEpoch', 'ownerEpoch']);
  function projectFacts(input, depth = 0) {
    if (!plainObject(input) || depth > 3) return null;
    const out = {};
    for (const [name, value] of Object.entries(input)) {
      if (numericNames.has(name) && (value === null || Number.isSafeInteger(value) && value >= 0)) out[name] = value;
      else if (['plantTime', 'nextTime'].includes(name) && safeTimeText(value)) out[name] = value;
      else if (name === 'sourceMethod' && typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,95}$/.test(value)) out[name] = value;
      else if (name === 'clockBase' && ['epoch-ms-local', 'official-anchor-monotonic'].includes(value)) out[name] = value;
      else if (['before', 'lands', 'land', 'targets', 'members'].includes(name) || /^[1-9][0-9]{0,8}$/.test(name)) {
        if (Array.isArray(value) && value.length <= 256) out[name] = value.map(one => projectFacts(one, depth + 1)).filter(Boolean);
        else { const child = projectFacts(value, depth + 1); if (child && Object.keys(child).length) out[name] = child; }
      }
    }
    return out;
  }
  const facts = projectFacts(bound?.facts);
  const candidates = [], conflicts = new Set();
  function targetFacts(input) {
    if (!plainObject(input)) return;
    if (positive(input.landId) && ['flowerId', 'state', 'plantTime', 'plantTimeMs', 'harvestCount', 'harvestCnt'].some(name => Object.hasOwn(input, name))) {
      const stamp = input.plantTime ?? input.plantTimeMs;
      const plantTime = Number.isSafeInteger(stamp) && stamp > 0 ? stamp : typeof stamp === 'string' && stamp.endsWith('Z') && sourceTime(stamp) ? Date.parse(stamp) : null;
      const count = input.harvestCnt ?? input.harvestCount;
      candidates.push({ landId: input.landId, flowerId: positive(input.flowerId) ? input.flowerId : null,
        plantTime, harvestCnt: Number.isSafeInteger(count) && count >= 0 ? count : null,
        state: Number.isSafeInteger(input.state) && input.state >= 0 ? input.state : null,
        fieldsPresent: ['flowerId', 'state', 'plantTime', 'plantTimeMs', 'harvestCount', 'harvestCnt'].filter(name => Object.hasOwn(input, name)) });
    }
    for (const value of Object.values(input)) {
      if (Array.isArray(value)) for (const item of value) targetFacts(item);
      else if (plainObject(value)) targetFacts(value);
    }
  }
  if (facts) targetFacts(facts);
  const byLand = new Map();
  for (const target of candidates) {
    const previous = byLand.get(target.landId);
    if (previous && canonical(previous) !== canonical(target)) conflicts.add(target.landId);
    else byLand.set(target.landId, target);
  }
  return { originalDetailsAvailable: true, preparedFactsAvailable: !!facts && Object.keys(facts).length > 0,
    preparedFacts: facts && Object.keys(facts).length ? facts : null,
    targets: [...byLand.values()].filter(target => !conflicts.has(target.landId)), targetFactsConflictLandIds: [...conflicts],
    preparedFactsSource: facts && Object.keys(facts).length ? 'original-prepared_evidence_json.bound.facts' : null,
    sourcePreparedAt: safeTimeText(row.prepared_at), sourceTerminatedAt: safeTimeText(row.terminated_at),
    timeBasis: 'original-source-time-fields-not-a-new-official-after-effect-checkpoint' };
}

// This adapter reads evidence only. A closed executor is neither a verdict for
// its old operation nor proof that a resource cost is reflected in today's bag.
// Domain admission still has to bind its exact current candidate and new stage.
export function createCurrentIsolationEvidence({ store, appId, isCurrent, readCurrentLogin, readLegacyOperation = null, readLegacyConstraint = null }) {
  if (!store?.get || !store?.all || !store?.transaction) throw new TypeError('Current isolation evidence requires a synchronous store');
  for (const callback of [isCurrent, readCurrentLogin]) if (typeof callback !== 'function' || callback.constructor?.name === 'AsyncFunction') {
    throw new TypeError('Current isolation evidence requires synchronous current/login ports');
  }
  if (readLegacyOperation !== null && (typeof readLegacyOperation !== 'function' || readLegacyOperation.constructor?.name === 'AsyncFunction')) {
    throw new TypeError('Legacy operation evidence reader must be synchronous');
  }
  if (readLegacyConstraint !== null && (typeof readLegacyConstraint !== 'function' || readLegacyConstraint.constructor?.name === 'AsyncFunction')) {
    throw new TypeError('Legacy constraint evidence reader must be synchronous');
  }
  const { get, all, transaction } = store;
  const has = name => Boolean(get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name));
  const unavailable = (reasonCode, currentCheckpoint = null, original = null) => freeze({ available: false, reasonCode,
    currentCheckpoint, previousExecution: null, original, receiptRef: null, receiptHash: null,
    outcomeProven: false, resourceCoverageProven: false });

  function currentCheckpoint(context) {
    if (sync(isCurrent, context) !== true) return null;
    const intent = get(`SELECT subject_ref,desired_running,run_epoch,connection_epoch FROM backend_run_intents
      WHERE owner_ref=? AND account_ref=?`, context.ownerRef, String(context.accountRef));
    const owner = get('SELECT owner_ref,owner_epoch,executor_ref,active FROM backend_subject_owners WHERE subject_ref=?', context.subjectRef);
    if (intent?.desired_running !== 1 || intent.subject_ref !== context.subjectRef || intent.run_epoch !== context.runEpoch ||
        intent.connection_epoch !== context.connectionEpoch || owner?.active !== 1 || owner.owner_ref !== context.ownerRef || owner.owner_epoch !== context.ownerEpoch) return null;
    const login = sync(readCurrentLogin, context);
    if (!login || login.source !== 'response' || login.transport !== 'answered' || login.method !== 'index.login' ||
        login.connectionEpoch !== context.connectionEpoch || !positive(login.requestSequence) || !login.responseRef || !login.wireKey ||
        login.envelopeOk !== true || login.dsName !== 'G.ISyncData' || login.rejected === true || !positive(login.receivedDeviceMs)) return null;
    const account = get(`SELECT subject_ref,server_id,profile_json,verification_ref FROM backend_accounts
      WHERE owner_ref=? AND account_id=? AND removed_at IS NULL`, context.ownerRef, Number(context.accountRef));
    const uid = login.value?.['7']?.['0']?.['0'];
    if (!account || account.subject_ref !== context.subjectRef || !positive(account.server_id) || !positive(uid) ||
        !account.verification_ref || parseStored(account.profile_json, '当前官服主体').uid !== uid) return null;
    const identity = has('backend_account_official_identities') && get(`SELECT identity_ref FROM backend_account_official_identities
      WHERE owner_ref=? AND account_ref=? AND subject_ref=? AND server_id=? AND official_uid=? AND evidence_ref=? AND connection_epoch=?`,
    context.ownerRef, String(context.accountRef), context.subjectRef, account.server_id, uid, login.responseRef, context.connectionEpoch);
    const anchor = has('backend_dynamic_login_identity_anchors') && get(`SELECT response_ref,request_sequence,official_uid,connection_epoch,game_version,protocol_version
      FROM backend_dynamic_login_identity_anchors WHERE owner_ref=? AND account_ref=? AND subject_ref=? AND owner_epoch=? AND run_epoch=?
      AND connection_epoch=? AND response_ref=?`, context.ownerRef, String(context.accountRef), context.subjectRef, context.ownerEpoch,
    context.runEpoch, context.connectionEpoch, login.responseRef);
    if (!identity || !anchor || anchor.request_sequence !== login.requestSequence || anchor.official_uid !== uid ||
        typeof anchor.game_version !== 'string' || !anchor.game_version || typeof anchor.protocol_version !== 'string' || !anchor.protocol_version) return null;
    return { ...Object.fromEntries(axes.map(key => [key, key === 'accountRef' ? String(context[key]) : context[key]])),
      source: 'current-matched-official-login', uid, serverId: account.server_id, responseRef: login.responseRef,
      requestSequence: login.requestSequence, wireKey: login.wireKey, receivedDeviceMs: login.receivedDeviceMs,
      gameVersion: anchor.game_version, protocolVersion: anchor.protocol_version,
      observedAt: new Date(login.receivedDeviceMs).toISOString(), identityRef: identity.identity_ref,
      accountVerificationRef: account.verification_ref, executorRef: owner.executor_ref };
  }

  function controlledPhysicalClosure(row, proof, operation, saved, checkpoint) {
    if (!has('backend_session_verification_leases') || !has('backend_send_permits') || !has('backend_operation_evidence') ||
        row.proof_kind !== 'verification-snapshot-physical-close' || proof.source !== 'verification-snapshot-actual-close' ||
        proof.closed !== true || proof.connectionEpoch !== operation.connection_epoch || typeof proof.leaseRef !== 'string' ||
        typeof proof.operationId !== 'string' || row.evidence_ref !== 'session-close:' +
          fingerprint([saved.executorRef, operation.subject_ref, operation.connection_epoch, 'verification-snapshot-physical-close'])) return null;
    const lease = get(`SELECT * FROM backend_session_verification_leases WHERE lease_ref=? AND operation_id=? AND
      owner_ref=? AND account_ref=? AND subject_ref=? AND executor_ref=? AND owner_epoch=? AND run_epoch=? AND original_connection_epoch=?`,
    proof.leaseRef, proof.operationId, operation.owner_ref, operation.account_ref, operation.subject_ref, saved.executorRef,
    saved.ownerEpoch, operation.run_epoch, operation.connection_epoch);
    if (!lease || lease.active !== 0 || !['released', 'recovered-retired'].includes(lease.state) || !lease.bridge_json || !digest(lease.bridge_fingerprint)) return null;
    const bridge = parseStored(lease.bridge_json, '受控关闭原核验桥'), original = parseStored(lease.original_context_json, '受控关闭原代际'),
      after = parseStored(lease.after_json, '受控关闭原回包');
    const same = (left, right) => plainObject(left) && plainObject(right) && axes.every(key => left[key] === right[key]);
    const originalContext = { ownerRef: operation.owner_ref, accountRef: operation.account_ref, subjectRef: operation.subject_ref,
      ownerEpoch: saved.ownerEpoch, runEpoch: operation.run_epoch, connectionEpoch: operation.connection_epoch };
    const bindingKnown = value => plainObject(value) && positive(value.connectionEpoch) && positive(value.requestSequence) &&
      typeof value.responseRef === 'string' && value.responseRef.length > 0 && typeof value.wireKey === 'string' &&
      /^ws\|\d+\|[1-9]\d*$/.test(value.wireKey) && Number(value.wireKey.split('|').at(-1)) === value.requestSequence;
    const next = bridge.newContext, closed = bridge.oldPhysicalCloseReceipt;
    if (fingerprint(bridge) !== lease.bridge_fingerprint || bridge.version !== 'after-physical-close-login/v1' ||
        bridge.leaseRef !== lease.lease_ref || bridge.operationId !== lease.operation_id || !same(original, originalContext) ||
        !same(bridge.originalContext, originalContext) || !plainObject(next) ||
        !axes.slice(0, 5).every(key => next[key] === originalContext[key]) || !positive(next.connectionEpoch) ||
        next.connectionEpoch <= operation.connection_epoch || next.connectionEpoch !== lease.new_connection_epoch ||
        checkpoint.connectionEpoch < next.connectionEpoch || checkpoint.connectionEpoch === next.connectionEpoch && !same(checkpoint, next) ||
        !bindingKnown(after) || after.connectionEpoch !== operation.connection_epoch || canonical(bridge.after) !== canonical(after) || canonical(proof.after) !== canonical(after) ||
        closed?.closed !== true || closed.connectionEpoch !== operation.connection_epoch || closed.closureEvidenceRef !== row.evidence_ref ||
        closed.code !== proof.code || bridge.officialUid !== checkpoint.uid) return null;
    const oldLogin = bridge.oldLoginSource, newLogin = bridge.newLoginSource;
    const loginKnown = (login, epoch) => bindingKnown(login) && login.kind === 'response' && login.transport === 'answered' &&
      login.method === 'index.login' && login.connectionEpoch === epoch && login.officialUid === checkpoint.uid && login.serverId === checkpoint.serverId &&
      login.versionEvidence?.source === 'normal-package-hop-and-matched-world-login/v1' &&
      typeof login.versionEvidence.gameVersion === 'string' && typeof login.versionEvidence.protocolVersion === 'string' &&
      login.versionEvidence.loginResponseRef === login.responseRef;
    if (!loginKnown(oldLogin, operation.connection_epoch) || !loginKnown(newLogin, next.connectionEpoch) || oldLogin.requestSequence >= after.requestSequence ||
        checkpoint.connectionEpoch === next.connectionEpoch && checkpoint.responseRef !== newLogin.responseRef) return null;
    // The invocation which deliberately closed this shared socket can differ
    // from the historical land operation. Both must have the exact same old
    // owner/account/subject/executor/run/connection; this is no subject-wide flag.
    const cause = get(`SELECT operation_id,owner_ref,account_ref,subject_ref,feature_id,scope,method,run_epoch,connection_epoch,
      transport_state,write_slot,params_fingerprint,original_json,original_fingerprint FROM backend_operations WHERE operation_id=?`, lease.operation_id);
    const ordinaryFlower = cause && Object.values(ORDER_FLOWER_CONTRACTS).find(one => one.featureId === cause.feature_id &&
      one.scope === cause.scope && one.method === cause.method);
    const auxiliaryFlower = cause && flowerAuxiliary.find(({ definition }) => definition.featureId === cause.feature_id &&
      definition.scope === cause.scope && definition.method === cause.method);
    const finite = cause && (cause.feature_id === 'order.customer' &&
      ({ 'order-customer': 'orderCustomer.finishOrder', 'order-reject': 'orderCustomer.rejectOrder', 'order-customer-gen': 'orderCustomer.genOrder' })[cause.scope] === cause.method ||
      cause.feature_id === 'art.make' && cause.scope === 'flower-art-make' && cause.method === 'flowerArt.makeFlowerArt' || ordinaryFlower || auxiliaryFlower);
    if (!finite || cause.owner_ref !== operation.owner_ref || cause.account_ref !== operation.account_ref || cause.subject_ref !== operation.subject_ref ||
        cause.run_epoch !== operation.run_epoch || cause.connection_epoch !== operation.connection_epoch || cause.transport_state !== 'answered' || cause.write_slot !== 0) return null;
    const causeOriginal = parseStored(cause.original_json, '受控关闭触发操作');
    if (ledgerJsonFingerprint(causeOriginal) !== cause.original_fingerprint || !same(causeOriginal, originalContext) ||
        causeOriginal.operationId !== lease.operation_id || causeOriginal.executorRef !== saved.executorRef ||
        causeOriginal.featureId !== cause.feature_id || causeOriginal.scope !== cause.scope || causeOriginal.method !== cause.method ||
        causeOriginal.paramsFingerprint !== cause.params_fingerprint) return null;
    let ordinaryEvidence = null;
    if (ordinaryFlower || auxiliaryFlower) {
      const readEvidence = (key, kind) => {
        const row = get(`SELECT evidence_id,kind,source,payload_json,payload_fingerprint,observed_at FROM backend_operation_evidence
          WHERE operation_id=? AND evidence_key=? AND kind=? AND source='backend/write-gateway/v2'`, cause.operation_id, key, kind);
        const payload = row ? parseStored(row.payload_json, '普通订单关闭触发原证据') : null;
        return row && ledgerJsonFingerprint({ kind: row.kind, source: row.source, payload, observedAt: row.observed_at }) === row.payload_fingerprint
          ? { row, payload } : null;
      };
      const contract = readEvidence('admitted-operation-contract:v1', 'admitted-operation-contract');
      const prepared = readEvidence('finite-domain-preparation:v1', 'finite-domain-preparation');
      const definition = ordinaryFlower || auxiliaryFlower.definition,
        postRead = ordinaryFlower ? ORDER_FLOWER_POST_READ : ORDER_FLOWER_AUX_POST_READ,
        domain = ordinaryFlower ? 'order-flower-' + ordinaryFlower.kind : auxiliaryFlower.domain;
      if (!contract || !prepared || !(ordinaryFlower
        ? orderFlowerHistoricalAdmittedContractMatches(contract.payload, definition)
        : canonical(contract.payload) === canonical({ ...definition, postRead })) ||
        prepared.payload?.domain !== domain || ordinaryFlower && prepared.payload.preparation?.kind !== ordinaryFlower.kind) return null;
      // No inferred or method-only bridge capability: original ordinary order,
      // day/107/UID/profile sources and all item holds must still reconstruct.
      try {
        if (ordinaryFlower) assertOrderFlowerProposal({ ...causeOriginal, orderFlower: prepared.payload.preparation,
          params: ordinaryFlower.kind === 'resident' ? { boxId: prepared.payload.preparation.boxId } : {} });
        else auxiliaryFlower.assertPrepared({ original: causeOriginal, preparation: prepared.payload.preparation });
      }
      catch { return null; }
      ordinaryEvidence = { contractEvidenceRef: 'operation-evidence:' + contract.row.evidence_id,
        contractEvidenceHash: contract.row.payload_fingerprint, preparationEvidenceRef: 'operation-evidence:' + prepared.row.evidence_id,
        preparationEvidenceHash: prepared.row.payload_fingerprint };
    }
    const permit = get(`SELECT * FROM backend_send_permits WHERE operation_id=?`, cause.operation_id);
    if (!permit || permit.owner_ref !== operation.owner_ref || permit.subject_ref !== operation.subject_ref || permit.owner_epoch !== saved.ownerEpoch ||
        permit.run_epoch !== operation.run_epoch || permit.connection_epoch !== operation.connection_epoch || permit.consumed !== 1 ||
        permit.method !== cause.method || permit.params_fingerprint !== cause.params_fingerprint || permit.request_sequence !== after.requestSequence || permit.wire_key !== after.wireKey) return null;
    const answer = get(`SELECT evidence_id,kind,source,payload_json,payload_fingerprint,observed_at FROM backend_operation_evidence
      WHERE operation_id=? AND evidence_id=? AND kind='official-answer' AND source='backend/write-gateway/v2'`, cause.operation_id,
    Number.isSafeInteger(bridge.answerEvidenceId) ? bridge.answerEvidenceId : -1);
    if (!answer || answer.payload_fingerprint !== bridge.answerEvidenceFingerprint) return null;
    const payload = parseStored(answer.payload_json, '受控关闭触发操作原匹配回包');
    if (ledgerJsonFingerprint({ kind: answer.kind, source: answer.source, payload, observedAt: answer.observed_at }) !== answer.payload_fingerprint ||
        payload.method !== cause.method || !bindingKnown(payload) ||
        ['connectionEpoch', 'requestSequence', 'wireKey', 'responseRef'].some(key => payload[key] !== after[key])) return null;
    return { leaseRef: lease.lease_ref, bridgeFingerprint: lease.bridge_fingerprint, closingOperationId: cause.operation_id,
      answerEvidenceRef: 'operation-evidence:' + answer.evidence_id, answerEvidenceHash: answer.payload_fingerprint,
      verifiedNewLoginRef: newLogin.responseRef, verifiedNewConnectionEpoch: next.connectionEpoch,
      ...(ordinaryEvidence ? { ordinaryOrderEvidence: ordinaryEvidence } : {}) };
  }

  function backendEvidence(context, checkpoint, operationId) {
    if (!has('backend_operations')) return unavailable('ISOLATION_OPERATION_UNAVAILABLE', checkpoint);
    const operation = get(`SELECT operation_id,owner_ref,account_ref,subject_ref,feature_id,scope,method,params_fingerprint,run_epoch,connection_epoch,original_json,
      original_fingerprint,transport_state,business_verdict,write_slot,prepared_at FROM backend_operations WHERE operation_id=?`, operationId);
    if (!operation || operation.owner_ref !== context.ownerRef || operation.subject_ref !== context.subjectRef) return unavailable('ISOLATION_OPERATION_OUT_OF_SCOPE', checkpoint);
    const saved = parseStored(operation.original_json, '原操作不可变身份');
    if (!plainObject(saved) || ledgerJsonFingerprint(saved) !== operation.original_fingerprint || saved.operationId !== operationId ||
        saved.ownerRef !== operation.owner_ref || saved.accountRef !== operation.account_ref || saved.subjectRef !== operation.subject_ref ||
        saved.runEpoch !== operation.run_epoch || saved.connectionEpoch !== operation.connection_epoch) return unavailable('ISOLATION_OPERATION_FINGERPRINT_INVALID', checkpoint);
    const original = { kind: 'backend', operationId, ownerRef: operation.owner_ref, accountRef: operation.account_ref,
      subjectRef: operation.subject_ref, originalFingerprint: operation.original_fingerprint, semanticKey: saved.semanticKey,
      featureId: saved.featureId, method: saved.method, runEpoch: operation.run_epoch, connectionEpoch: operation.connection_epoch,
      ownerEpoch: saved.ownerEpoch ?? null, executorRef: saved.executorRef ?? null, preparedAt: operation.prepared_at,
      transportState: operation.transport_state, businessVerdict: operation.business_verdict, writeSlot: operation.write_slot,
      lifecycleTargetMetadata: { targets: (saved.targets || []).map(target => fields(target,
        ['memberKey', 'targetKind', 'targetRef', 'lifecycleRef', 'targetFingerprint'])),
      targetBasis: plainObject(saved.factBasis?.target) ? fields(saved.factBasis.target,
        ['landId', 'semanticVersion', 'cropRef', 'lifecycleRef', 'flowerId', 'plantTime', 'harvestCnt', 'status', 'state', 'emptyRef']) : null } };
    function physicalCloseOnly(row, proof) {
      const rackConsumer = operation.feature_id === 'flower-rack' && saved.featureId === operation.feature_id &&
        saved.scope === operation.scope && saved.method === operation.method && saved.paramsFingerprint === operation.params_fingerprint &&
        [[FLOWER_RACK_SCOPES.receive, FLOWER_RACK_METHODS.receive], [FLOWER_RACK_SCOPES.cancel, FLOWER_RACK_METHODS.cancel]]
          .some(([scope, method]) => operation.scope === scope && operation.method === method);
      if (!rackConsumer) return null;
      return resolveExecutionClosureEvidence({ store, operationId, operation, saved, checkpoint, row, proof });
    }
    if (!positive(saved.ownerEpoch) || !saved.executorRef || checkpoint.connectionEpoch < operation.connection_epoch) {
      return unavailable('ISOLATION_OLD_EXECUTION_NOT_SEPARATE', checkpoint, original);
    }
    // A real matching RPC response ends only this invocation. It is useful to
    // domain admission after an independently checked new stage, but proves
    // neither physical executor death nor reflected resource consumption.
    if (checkpoint.connectionEpoch === operation.connection_epoch && operation.transport_state === 'answered' && operation.write_slot === 0 && has('backend_send_permits') &&
        has('backend_operation_evidence') && has('backend_operation_target_settlements')) {
      const settlements = all(`SELECT member_key,verdict,settlement_key FROM backend_operation_target_settlements WHERE operation_id=?`, operationId);
      const permit = get(`SELECT owner_ref,subject_ref,owner_epoch,run_epoch,connection_epoch,method,params_fingerprint,
        consumed,wire_key,request_sequence FROM backend_send_permits WHERE operation_id=?`, operationId);
      if (saved.targets?.length === 1 && settlements.length === 1 && settlements[0].member_key === saved.targets[0].memberKey &&
          settlements[0].verdict === operation.business_verdict && permit?.consumed === 1 && permit.owner_ref === operation.owner_ref && permit.subject_ref === operation.subject_ref &&
          permit.owner_epoch === saved.ownerEpoch && permit.run_epoch === operation.run_epoch && permit.connection_epoch === operation.connection_epoch &&
          permit.method === saved.method && permit.params_fingerprint === saved.paramsFingerprint && positive(permit.request_sequence) && permit.wire_key) {
        for (const row of all(`SELECT evidence_id,kind,source,payload_json,payload_fingerprint,observed_at,recorded_at FROM backend_operation_evidence
          WHERE operation_id=? AND kind='official-answer' AND source='backend/write-gateway/v2' ORDER BY evidence_id LIMIT 16`, operationId)) {
          const answer = parseStored(row.payload_json, '原写匹配回包');
          const originalEvidenceFingerprint = ledgerJsonFingerprint({ kind: row.kind, source: row.source, payload: answer, observedAt: row.observed_at });
          if (originalEvidenceFingerprint === row.payload_fingerprint && answer.method === saved.method && answer.connectionEpoch === operation.connection_epoch &&
              answer.requestSequence === permit.request_sequence && answer.wireKey === permit.wire_key && answer.responseRef && positive(answer.receivedDeviceMs)) {
            return { original, previousExecution: { kind: 'matched-operation-response', closed: false, executionClosed: false,
              operationRequestEnded: true, requestTerminated: true, targetSettlementRef: settlements[0].settlement_key,
              evidenceRef: 'operation-evidence:' + row.evidence_id, evidenceHash: row.payload_fingerprint,
              sourceRef: 'backend/write-gateway/v2', ownerRef: operation.owner_ref, accountRef: operation.account_ref,
              subjectRef: operation.subject_ref, ownerEpoch: saved.ownerEpoch, runEpoch: operation.run_epoch,
              connectionEpoch: operation.connection_epoch, executorRef: saved.executorRef, method: saved.method,
              requestSequence: answer.requestSequence, wireKey: answer.wireKey, responseRef: answer.responseRef,
              receivedDeviceMs: answer.receivedDeviceMs, recordedAt: row.recorded_at,
              independentCurrentAfterReadRequired: true } };
          }
        }
      }
    }
    if (checkpoint.connectionEpoch === operation.connection_epoch) return unavailable('ISOLATION_EXACT_OLD_EXECUTION_CLOSE_UNPROVEN', checkpoint, original);
    if (has('backend_session_connection_closures')) {
      const closures = all(`SELECT evidence_ref,owner_ref,account_ref,subject_ref,executor_ref,owner_epoch,run_epoch,connection_epoch,
        proof_kind,proof_json,recorded_at FROM backend_session_connection_closures
        WHERE subject_ref=? AND owner_ref=? AND account_ref=? AND owner_epoch=? AND run_epoch=? AND connection_epoch=?
        AND executor_ref=? AND proof_kind IN ('transport-closed','verification-snapshot-physical-close') ORDER BY recorded_at DESC,evidence_ref LIMIT 16`,
      context.subjectRef, operation.owner_ref, operation.account_ref, saved.ownerEpoch, operation.run_epoch, operation.connection_epoch, saved.executorRef);
      for (const row of closures) {
        const proof = parseStored(row.proof_json, '原连接关闭证明');
        const controlled = row.proof_kind === 'verification-snapshot-physical-close'
          ? controlledPhysicalClosure(row, proof, operation, saved, checkpoint) : null;
        const closeOnly = row.proof_kind === 'verification-snapshot-physical-close' && !controlled
          ? physicalCloseOnly(row, proof) : null;
        if (closeOnly) return { original, previousExecution: closeOnly };
        if (proof.closed === true && proof.connectionEpoch === operation.connection_epoch &&
            (row.proof_kind === 'transport-closed' && ['transport-close-receipt', 'connect-rejected-after-physical-close'].includes(proof.source) || controlled)) {
          return { original, previousExecution: { kind: 'backend-physical-closure', closed: true, executionClosed: true,
            evidenceRef: row.evidence_ref, evidenceHash: fingerprint(proof), sourceRef: proof.source,
            ownerRef: operation.owner_ref, accountRef: operation.account_ref, subjectRef: operation.subject_ref,
            ownerEpoch: saved.ownerEpoch, runEpoch: operation.run_epoch, connectionEpoch: operation.connection_epoch,
            executorRef: saved.executorRef, recordedAt: row.recorded_at, ...(controlled ? { controlledSnapshot: controlled } : {}) } };
        }
      }
    }
    if (has('backend_executor_isolation') && has('backend_local_executors') && typeof appId === 'string') {
      const native = resolveNativeExecutorExitProof({ store, appId, subjectRef: context.subjectRef,
        executorRef: saved.executorRef, ownerEpoch: saved.ownerEpoch });
      if (native) {
        const row = get('SELECT proof_json FROM backend_executor_isolation WHERE subject_ref=? AND evidence_ref=?', context.subjectRef, native.evidenceRef);
        const proof = row && parseStored(row.proof_json, '原执行方退出证明');
        if (proof && proof.ownerEpoch === saved.ownerEpoch) return { original, previousExecution: { kind: 'backend-native-executor-exit', closed: true, executionClosed: true,
          evidenceRef: native.evidenceRef, evidenceHash: fingerprint(proof), sourceRef: native.sourceRef,
          ownerRef: operation.owner_ref, accountRef: operation.account_ref, subjectRef: operation.subject_ref,
          ownerEpoch: saved.ownerEpoch, runEpoch: operation.run_epoch, connectionEpoch: operation.connection_epoch,
          executorRef: saved.executorRef, recordedAt: native.recordedAt } };
      }
    }
    return unavailable('ISOLATION_EXACT_OLD_EXECUTION_CLOSE_UNPROVEN', checkpoint, original);
  }

  function importedBinding(transferId, context) {
    const imported = get(`SELECT i.transfer_id,i.session_id,i.source_owner_ref,i.target_owner_ref,i.source_account_ref,
      i.target_account_ref,i.target_subject_ref,i.envelope_fingerprint,i.payload_fingerprint,i.source_version,i.verification_ref,
      i.updated_at,r.offer_json,r.envelope_fingerprint AS receiver_envelope_fingerprint,r.completed_at
      FROM backend_migration_imports i JOIN backend_migration_receivers r ON r.session_id=i.session_id
      WHERE i.transfer_id=? AND i.state='imported' AND r.state='imported' AND i.target_owner_ref=? AND i.target_subject_ref=?
      AND r.target_owner_ref=i.target_owner_ref AND r.source_owner_ref=i.source_owner_ref`, transferId, context.ownerRef, context.subjectRef);
    if (!imported || !imported.verification_ref || !digest(imported.envelope_fingerprint) || !digest(imported.payload_fingerprint) ||
        imported.receiver_envelope_fingerprint !== imported.envelope_fingerprint) return null;
    const offer = parseStored(imported.offer_json, '已验证原迁入请求');
    if (!plainObject(offer) || offer.sessionId !== imported.session_id || offer.targetOwnerRef !== context.ownerRef ||
        offer.sourceOwnerRef !== imported.source_owner_ref || offer.kind === 'device-log-metadata') return null;
    const pair = get(`SELECT descriptor_json,source_authentication_json,target_authentication_ref FROM backend_migration_pairings
      WHERE pairing_ref=? AND target_owner_ref=? AND source_owner_ref=?`, offer.authenticationRef, context.ownerRef, imported.source_owner_ref);
    if (!pair?.target_authentication_ref) return null;
    const descriptor = parseStored(pair.descriptor_json, '原迁入来源描述');
    const authentication = parseStored(pair.source_authentication_json, '原迁入来源认证');
    const install = resolveArchivedSourceInstallBinding({ get, ownerRef: context.ownerRef, transferId, offer, descriptor, authentication });
    return { imported, offer, descriptor, authentication, install, pair };
  }

  // A supplemental transfer is a separate immutable import, while its stop
  // fence belongs to the original transfer. supplementOf is a session id;
  // never use it as a transfer id or infer the original from naming.
  function verifiedFenceBinding(binding, context, expectedAccountRef) {
    if (!binding?.offer?.supplementOf) return { binding, fenced: binding };
    if (!has('backend_migration_supplements')) return null;
    const supplement = get(`SELECT original_session_id,original_transfer_id,target_owner_ref,source_owner_ref,target_account_ref,
      target_subject_ref,original_verification_ref,binding_json FROM backend_migration_supplements WHERE session_id=?`, binding.imported.session_id);
    const offerSupplement = binding.offer.supplement;
    if (!supplement || supplement.original_session_id !== binding.offer.supplementOf ||
        supplement.target_owner_ref !== context.ownerRef || supplement.source_owner_ref !== binding.imported.source_owner_ref ||
        String(supplement.target_account_ref) !== String(expectedAccountRef) || supplement.target_subject_ref !== context.subjectRef ||
        supplement.original_verification_ref !== binding.imported.verification_ref ||
        canonical(parseStored(supplement.binding_json, '原补充绑定')) !== canonical(offerSupplement)) return null;
    const fenced = importedBinding(supplement.original_transfer_id, context);
    if (!fenced || fenced.offer.supplementOf || fenced.imported.session_id !== supplement.original_session_id ||
        fenced.imported.source_owner_ref !== binding.imported.source_owner_ref ||
        String(fenced.imported.target_account_ref) !== String(expectedAccountRef) ||
        fenced.imported.target_subject_ref !== context.subjectRef ||
        fenced.imported.verification_ref !== supplement.original_verification_ref ||
        fenced.install.installId !== binding.install.installId ||
        fenced.offer.sourceSignerFingerprint !== binding.offer.sourceSignerFingerprint ||
        fenced.offer.sourceAppId !== binding.offer.sourceAppId || fenced.offer.sourceCloudRef !== binding.offer.sourceCloudRef) return null;
    return { binding, fenced, supplement };
  }

  function signedFence(context, binding, fenced, archive, expectedAccountRef) {
    const fenceArchive = binding.offer.supplementOf
      ? get(`SELECT source_instance_ref FROM backend_legacy_archives WHERE transfer_id=? AND target_owner_ref=? AND target_account_ref=?
        AND target_subject_ref=? AND source_table='accounts' LIMIT 1`, fenced.imported.transfer_id, context.ownerRef,
        String(expectedAccountRef), context.subjectRef)
      : archive;
    if (!fenceArchive) return null;
    const isolation = get('SELECT evidence_ref,source_ref,proof_json,created_at FROM backend_executor_isolation WHERE subject_ref=? AND evidence_ref=?',
      context.subjectRef, 'signed-migration:' + fenced.imported.transfer_id + ':' + context.subjectRef);
    const proof = isolation && parseStored(isolation.proof_json, '原签名迁移栅栏');
    if (!isolation || isolation.source_ref !== 'source:' + fenceArchive.source_instance_ref ||
        proof?.stopped !== true || proof.currentInFlight !== false || proof.sourceFenceCommitted !== true ||
        proof.sourceOwnerRef !== binding.imported.source_owner_ref || proof.targetSessionId !== fenced.imported.session_id ||
        typeof proof.fenceRef !== 'string' || !proof.fenceRef || proof.evidenceRef !== 'source-stop-and-fence:' + proof.fenceRef) return null;
    return { isolation, proof, fenceArchive };
  }

  function legacyEvidence(context, checkpoint, operationRef) {
    for (const table of ['backend_legacy_operation_index', 'backend_legacy_archives', 'backend_migration_imports',
      'backend_migration_receivers', 'backend_migration_pairings', 'backend_executor_isolation']) if (!has(table)) return unavailable('ISOLATION_LEGACY_ORIGIN_UNAVAILABLE', checkpoint);
    const operation = get(`SELECT operation_ref,transfer_id,archive_id,owner_ref,account_ref,subject_ref,source_origin_key,
      source_operation_id,source_subject_ref,source_version,source_fingerprint,semantic_key,feature_id,scope,method,status,
      transport_state,business_verdict,declared_target_ref FROM backend_legacy_operation_index WHERE operation_ref=?`, operationRef);
    if (!operation || operation.owner_ref !== context.ownerRef || operation.subject_ref !== context.subjectRef) return unavailable('ISOLATION_LEGACY_OPERATION_OUT_OF_SCOPE', checkpoint);
    const original = { kind: 'legacy', operationRef, transferId: operation.transfer_id, ownerRef: operation.owner_ref,
      accountRef: operation.account_ref, subjectRef: operation.subject_ref, sourceOperationId: operation.source_operation_id,
      sourceFingerprint: operation.source_fingerprint, sourceOriginKey: operation.source_origin_key,
      semanticKey: operation.semantic_key, featureId: operation.feature_id, scope: operation.scope, method: operation.method,
      status: operation.status, transportState: operation.transport_state, businessVerdict: operation.business_verdict,
      lifecycleTargetMetadata: { declaredTargetRef: operation.declared_target_ref, originalDetailsAvailable: false } };
    const binding = importedBinding(operation.transfer_id, context);
    if (!binding) return unavailable('ISOLATION_LEGACY_IMPORT_BINDING_UNPROVEN', checkpoint, original);
    const { imported, offer, install } = binding;
    const archive = get(`SELECT source_instance_ref,source_version,source_owner_ref,target_owner_ref,target_account_ref,target_subject_ref,
      source_table,source_primary_key_json,source_row_fingerprint,recorded_at FROM backend_legacy_archives WHERE archive_id=? AND transfer_id=?`, operation.archive_id, operation.transfer_id);
    const subjectAliasBound = operation.source_subject_ref === null || operation.source_subject_ref === context.subjectRef ||
      has('backend_subject_aliases') && get('SELECT 1 FROM backend_subject_aliases WHERE subject_ref=? AND alias_ref=?', context.subjectRef, operation.source_subject_ref);
    const archivedAccount = get(`SELECT subject_ref,server_id,profile_json,verification_ref FROM backend_accounts WHERE owner_ref=? AND account_id=?`, context.ownerRef, Number(operation.account_ref));
    const archivedUid = archivedAccount ? parseStored(archivedAccount.profile_json, '原迁入主体').uid : null;
    if (!archive || !archivedAccount || !subjectAliasBound || operation.operation_ref !== fingerprint(['legacy-operation', operation.transfer_id, operation.source_operation_id]) ||
        archive.source_table !== 'game_write_operations' || archive.target_owner_ref !== context.ownerRef ||
        archive.target_subject_ref !== context.subjectRef || String(archive.target_account_ref) !== String(operation.account_ref) ||
        String(imported.target_account_ref) !== String(operation.account_ref) ||
        archivedAccount.subject_ref !== context.subjectRef || archivedAccount.server_id !== checkpoint.serverId ||
        archivedAccount.verification_ref !== imported.verification_ref || archivedUid !== undefined && archivedUid !== null && archivedUid !== checkpoint.uid ||
        archive.source_owner_ref !== imported.source_owner_ref || archive.source_version !== operation.source_version || imported.source_version !== operation.source_version ||
        archive.source_row_fingerprint !== operation.source_fingerprint ||
        parseStored(archive.source_primary_key_json, '原操作主键').operation_id !== operation.source_operation_id ||
        operation.source_origin_key !== fingerprint({ sourceAppId: offer.sourceAppId, sourceCloudRef: offer.sourceCloudRef,
          sourceOwnerRef: imported.source_owner_ref, sourceOperationId: operation.source_operation_id, part: null })) {
      return unavailable('ISOLATION_LEGACY_ORIGINAL_FINGERPRINT_UNPROVEN', checkpoint, original);
    }
    // Supplemental imports retain their own immutable rows, but source fencing
    // deliberately stays bound to the original verified transfer/session.
    const fence = verifiedFenceBinding(binding, context, operation.account_ref);
    if (!fence) return unavailable('ISOLATION_LEGACY_SUPPLEMENT_UNPROVEN', checkpoint, original);
    const fenced = fence.fenced;
    const signed = signedFence(context, binding, fenced, archive, operation.account_ref);
    if (!signed) {
      return unavailable('ISOLATION_LEGACY_EXACT_SIGNED_FENCE_UNPROVEN', checkpoint, original);
    }
    const { isolation, proof } = signed;
    original.originalArchivedAt = archive.recorded_at;
    if (readLegacyOperation) {
      const row = sync(readLegacyOperation, { archiveId: operation.archive_id, transferId: operation.transfer_id,
        ownerRef: context.ownerRef, accountRef: operation.account_ref, subjectRef: context.subjectRef,
        sourceTable: 'game_write_operations', expectedFingerprint: operation.source_fingerprint });
      if (!plainObject(row) || fingerprint(row) !== operation.source_fingerprint || row.operation_id !== operation.source_operation_id ||
          (typeof row.subject_ref === 'string' ? row.subject_ref : null) !== operation.source_subject_ref) {
        return unavailable('ISOLATION_LEGACY_SINGLE_ROW_FINGERPRINT_INVALID', checkpoint, original);
      }
      original.lifecycleTargetMetadata = { declaredTargetRef: operation.declared_target_ref, ...legacyTargetMetadata(row) };
    }
    return { original, previousExecution: { kind: 'legacy-signed-migration-fence', closed: true, executionClosed: true,
      evidenceRef: isolation.evidence_ref, evidenceHash: fingerprint(proof), sourceRef: isolation.source_ref,
      transferId: imported.transfer_id, sessionId: imported.session_id, originalTransferId: fenced.imported.transfer_id,
      originalSessionId: fenced.imported.session_id, envelopeFingerprint: imported.envelope_fingerprint,
      payloadFingerprint: imported.payload_fingerprint, sourceOwnerFingerprint: fingerprint(imported.source_owner_ref),
      sourceAppId: offer.sourceAppId, sourceCloudRef: offer.sourceCloudRef, sourceInstallId: install.installId,
      installBindingRef: install.bindingRef, sourceSignerFingerprint: offer.sourceSignerFingerprint,
      sourceDescriptorFingerprint: offer.sourceDescriptorFingerprint, pairingRef: offer.authenticationRef,
      sourceFenceRef: proof.fenceRef, sourceStopEvidenceRef: proof.evidenceRef, fencedAt: sourceTime(proof.readAt),
      recordedAt: isolation.created_at, importCompletedAt: imported.completed_at,
      sourceSignatureVerification: 'normal-receiver-import-verified', signatureReverifiedDuringRead: false,
      timeBasis: 'source-and-target-device-recorded-times-not-official-clock', verificationRef: imported.verification_ref } };
  }

  // Some archived targets/holds have no corresponding operation row. Keep
  // their identity at the immutable constraint row; never synthesize an
  // operation reference to make the operation reader accept it.
  function legacyConstraintEvidence(context, checkpoint, constraintRef) {
    const row = get(`SELECT constraint_ref,transfer_id,archive_id,source_operation_id,source_origin_key,owner_ref,account_ref,
      subject_ref,kind,raw_ref,quantity,source_fingerprint FROM backend_legacy_constraint_index WHERE constraint_ref=?`, constraintRef);
    if (!row || row.owner_ref !== context.ownerRef || row.subject_ref !== context.subjectRef) {
      return unavailable('ISOLATION_LEGACY_CONSTRAINT_OUT_OF_SCOPE', checkpoint);
    }
    const original = { kind: 'legacy-constraint', constraintRef: row.constraint_ref, transferId: row.transfer_id,
      ownerRef: row.owner_ref, accountRef: row.account_ref, subjectRef: row.subject_ref,
      sourceOperationId: row.source_operation_id, sourceOriginKey: row.source_origin_key,
      sourceFingerprint: row.source_fingerprint, constraintKind: row.kind, rawRef: row.raw_ref };
    if (row.constraint_ref !== fingerprint(['legacy-constraint', row.transfer_id, row.archive_id, row.kind]))
      return unavailable('ISOLATION_LEGACY_CONSTRAINT_REFERENCE_INVALID', checkpoint, original);
    const binding = importedBinding(row.transfer_id, context);
    const archive = get(`SELECT source_instance_ref,source_version,source_owner_ref,target_owner_ref,target_account_ref,target_subject_ref,
      source_table,source_primary_key_json,source_row_fingerprint,recorded_at FROM backend_legacy_archives WHERE archive_id=? AND transfer_id=?`,
    row.archive_id, row.transfer_id);
    const sourceAccount = get('SELECT subject_ref,server_id,profile_json,verification_ref FROM backend_accounts WHERE owner_ref=? AND account_id=?',
      context.ownerRef, Number(row.account_ref));
    const sourceUid = sourceAccount ? parseStored(sourceAccount.profile_json, '原约束迁入主体').uid : null;
    if (!binding || !archive || archive.source_row_fingerprint !== row.source_fingerprint ||
        archive.target_owner_ref !== context.ownerRef || String(archive.target_account_ref) !== String(row.account_ref) ||
        String(binding.imported.target_account_ref) !== String(row.account_ref) || archive.target_subject_ref !== context.subjectRef ||
        binding.imported.target_subject_ref !== context.subjectRef || !sourceAccount || sourceAccount.subject_ref !== context.subjectRef ||
        sourceAccount.server_id !== checkpoint.serverId || sourceAccount.verification_ref !== binding.imported.verification_ref ||
        sourceUid !== undefined && sourceUid !== null && sourceUid !== checkpoint.uid ||
        archive.source_owner_ref !== binding.imported.source_owner_ref || archive.source_version !== binding.imported.source_version ||
        !new Set(['game_write_operation_targets', 'game_write_holds']).has(archive.source_table) ||
        row.source_origin_key !== fingerprint({ sourceAppId: binding.offer.sourceAppId, sourceCloudRef: binding.offer.sourceCloudRef,
          sourceOwnerRef: binding.imported.source_owner_ref, sourceOperationId: row.source_operation_id,
          part: { kind: row.kind, rawRef: row.raw_ref } })) {
      return unavailable('ISOLATION_LEGACY_CONSTRAINT_FINGERPRINT_INVALID', checkpoint, original);
    }
    const primary = parseStored(archive.source_primary_key_json, '原约束主键');
    // game_write_holds is keyed by its immutable row id, not operation_id.
    // The decrypted row below binds that primary key to source_operation_id;
    // requiring operation_id in the PK incorrectly rejects valid orphan
    // constraints imported from the production schema.
    if (!plainObject(primary) ||
        row.kind === 'target' && (archive.source_table !== 'game_write_operation_targets' ||
          primary.operation_id !== row.source_operation_id || primary.target_ref !== row.raw_ref) ||
        row.kind === 'resource' && (archive.source_table !== 'game_write_holds' || !Number.isSafeInteger(primary.id) || primary.id < 1)) {
      return unavailable('ISOLATION_LEGACY_CONSTRAINT_PRIMARY_KEY_INVALID', checkpoint, original);
    }
    if (!readLegacyConstraint) return unavailable('ISOLATION_LEGACY_CONSTRAINT_ARCHIVE_READER_UNAVAILABLE', checkpoint, original);
    const archived = sync(readLegacyConstraint, { archiveId: row.archive_id, transferId: row.transfer_id,
      ownerRef: context.ownerRef, accountRef: row.account_ref, subjectRef: context.subjectRef,
      sourceTable: archive.source_table, expectedFingerprint: row.source_fingerprint, expectedPrimaryKey: primary,
      sourceOperationId: row.source_operation_id, kind: row.kind, rawRef: row.raw_ref, quantity: row.quantity ?? null });
    if (!plainObject(archived) || archived.operation_id !== row.source_operation_id ||
        fingerprint(archived) !== row.source_fingerprint ||
        row.kind === 'target' && archived.target_ref !== row.raw_ref ||
        row.kind === 'resource' && (archived.resource_key !== row.raw_ref || archived.quantity !== row.quantity)) {
      return unavailable('ISOLATION_LEGACY_CONSTRAINT_ARCHIVE_FINGERPRINT_INVALID', checkpoint, original);
    }
    const fence = verifiedFenceBinding(binding, context, row.account_ref);
    if (!fence) return unavailable('ISOLATION_LEGACY_CONSTRAINT_SUPPLEMENT_UNPROVEN', checkpoint, original);
    const fenced = fence.fenced;
    const signed = signedFence(context, binding, fenced, archive, row.account_ref);
    if (!signed) {
      return unavailable('ISOLATION_LEGACY_CONSTRAINT_SOURCE_FENCE_UNPROVEN', checkpoint, original);
    }
    const { isolation, proof } = signed;
    original.originalArchivedAt = archive.recorded_at;
    return { original, previousExecution: { kind: 'legacy-signed-migration-fence', closed: true, executionClosed: true,
      evidenceRef: isolation.evidence_ref, evidenceHash: fingerprint(proof), sourceRef: isolation.source_ref,
      transferId: row.transfer_id, sessionId: binding.imported.session_id, originalTransferId: fenced.imported.transfer_id,
      originalSessionId: fenced.imported.session_id, envelopeFingerprint: binding.imported.envelope_fingerprint,
      payloadFingerprint: binding.imported.payload_fingerprint, sourceOwnerFingerprint: fingerprint(binding.imported.source_owner_ref),
      sourceAppId: binding.offer.sourceAppId, sourceCloudRef: binding.offer.sourceCloudRef, sourceInstallId: binding.install.installId,
      installBindingRef: binding.install.bindingRef, sourceSignerFingerprint: binding.offer.sourceSignerFingerprint,
      sourceDescriptorFingerprint: binding.offer.sourceDescriptorFingerprint, pairingRef: binding.offer.authenticationRef,
      sourceFenceRef: proof.fenceRef, sourceStopEvidenceRef: proof.evidenceRef, fencedAt: sourceTime(proof.readAt),
      recordedAt: isolation.created_at, importCompletedAt: binding.imported.completed_at,
      sourceSignatureVerification: 'normal-receiver-import-verified', signatureReverifiedDuringRead: false,
      timeBasis: 'source-and-target-device-recorded-times-not-official-clock', verificationRef: binding.imported.verification_ref } };
  }

  function read({ context, legacyOperationRef = null, legacyConstraintRef = null, operationId = null } = {}) {
    requireText(context?.ownerRef, 'ownerRef'); requireText(context?.subjectRef, 'subjectRef');
    const selected = [legacyOperationRef, legacyConstraintRef, operationId].filter(value => value !== null);
    if (!positive(Number(context.accountRef)) || !axes.slice(3).every(key => positive(context[key])) || selected.length !== 1)
      throw problem('ISOLATION_PROOF_INPUT_INVALID', '隔离证明需要准确当前代际和唯一原始引用', 400);
    requireText(selected[0], 'originalReference');
    return transaction(() => {
      const checkpoint = currentCheckpoint(context);
      if (!checkpoint) return unavailable('ISOLATION_CURRENT_MATCHED_LOGIN_UNPROVEN');
      let result;
      try { result = legacyOperationRef !== null ? legacyEvidence(context, checkpoint, legacyOperationRef) :
        legacyConstraintRef !== null ? legacyConstraintEvidence(context, checkpoint, legacyConstraintRef) : backendEvidence(context, checkpoint, operationId); }
      catch (error) {
        if (typeof error?.code === 'string' && /^MIGRATION_(DIGEST|INSTALL)_/.test(error.code)) return unavailable(error.code, checkpoint);
        throw error;
      }
      if (result.available === false) return result;
      if (sync(isCurrent, context) !== true) return unavailable('ISOLATION_CURRENT_CONTEXT_CHANGED', checkpoint, result.original);
      const receipt = { version: 'current-execution-isolation/v1', currentCheckpoint: checkpoint,
        previousExecution: result.previousExecution, original: result.original, outcomeProven: false, resourceCoverageProven: false };
      const receiptHash = fingerprint(receipt);
      return freeze({ ...receipt, available: true, reasonCode: null, receiptRef: 'current-isolation:' + receiptHash, receiptHash });
    });
  }
  return Object.freeze({ read });
}
