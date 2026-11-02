import { officialAnswerProtocolChecks } from '../../official-server-version-contract.mjs';
import { createOrderFlowerAuxiliarySourceRetirement } from './auxiliary-source-retirement.mjs';
import { canonical, clone, fingerprint, freeze, parseStored, encodeEvidenceJson } from '../../common.mjs';
import { captureOrderFlowerInventory, captureOrderFlowerCounter, auxAt, auxDate, auxPositive } from './auxiliary-contract.mjs';
import { captureOrderFlowerVideoCard, captureOrderFlowerShare } from './video-contract.mjs';
import { orderFlowerSafeSource } from './rpc-contract.mjs';
import { captureOrderFlowerRewardState, captureOrderFlowerRewardComponents,
  captureOrderFlowerAchievementFieldUpdates } from './reward-contract.mjs';
import { captureOrderFlowerEnterState, captureOrderFlowerEnterBoard, captureOrderFlowerEnterBoardUpdates } from './enter-contract.mjs';
import { ORDER_FLOWER_AXES, orderFlowerContext, orderFlowerContextKey, sameOrderFlowerContext } from './wire-facts.mjs';
import { isNormalSyncMethod } from '../../facts/normal-sync-contract.mjs';
import { mergeOrderFlowerCardCellRow, mergeOrderFlowerShareCellRow } from './canonical-aux-cells.mjs';
import { currentOfficialDataEvidence, currentOfficialSourceEvidence } from '../../official-data-evidence.mjs';

const sync = value => {
  if (value?.then) { value.catch?.(() => {}); throw new TypeError('Order flower auxiliary facts require synchronous ports'); }
  return value;
};
const unknown = reasonCode => ({ known: false, reasonCode });
const cell = (value, reasonCode) => value == null ? unknown(reasonCode) : value?.known === false ? value : { known: true, value };
const safeSource = observation => Object.fromEntries(['source', 'transport', 'method', 'connectionEpoch', 'requestSequence', 'wireKey',
  'responseRef', 'envelopeOk', 'dsName', 'protocolVersion', 'reportedServerVersion'].map(key => [key, observation?.[key] ?? null]));
const ordinaryActions = Object.freeze(['order.resident', 'order.satin', 'order.decorate']);
const orderActionEvidence = versionEvidence => Object.fromEntries(ordinaryActions.map(action => [action,
  currentOfficialDataEvidence(versionEvidence, action)]).filter(([, evidence]) => evidence));
const orderSourceEvidence = versionEvidence => {
  const source = currentOfficialSourceEvidence(versionEvidence), actions = orderActionEvidence(versionEvidence);
  return source && Object.keys(actions).length ? freeze({ ...source, ordinaryActionEvidence: actions }) : null;
};
const sourceRecord = (context, observation, uid) => ({ context: clone(context), officialUid: auxPositive(uid) ? uid : null, ...safeSource(observation),
  receivedDeviceMs: Number.isSafeInteger(observation?.receivedDeviceMs) ? observation.receivedDeviceMs : null,
  receivedMonotonicMs: Number.isFinite(observation?.receivedMonotonicMs) ? observation.receivedMonotonicMs : null,
  versionEvidence: { source: observation?.versionEvidence?.source ?? null, gameVersion: observation?.versionEvidence?.gameVersion ?? null,
    protocolVersion: observation?.versionEvidence?.protocolVersion ?? null, loginResponseRef: observation?.versionEvidence?.loginResponseRef ?? null,
    dataSnapshotId: observation?.versionEvidence?.dataSnapshotId ?? null,
    sourceProofFingerprint: currentOfficialSourceEvidence(observation?.versionEvidence)?.proofFingerprint ?? null },
  dataEvidence: orderSourceEvidence(observation?.versionEvidence) });
const componentSource = (observation, officialUid = auxAt(observation?.value, ['7', '0', '0']).value) => ({ ...orderFlowerSafeSource(observation),
  officialUid: auxPositive(officialUid) ? officialUid : null,
  versionEvidence: { source: observation?.versionEvidence?.source ?? null, gameVersion: observation?.versionEvidence?.gameVersion ?? null,
    protocolVersion: observation?.versionEvidence?.protocolVersion ?? null, loginResponseRef: observation?.versionEvidence?.loginResponseRef ?? null,
    dataSnapshotId: observation?.versionEvidence?.dataSnapshotId ?? null,
    sourceProofFingerprint: currentOfficialSourceEvidence(observation?.versionEvidence)?.proofFingerprint ?? null },
  dataEvidence: orderSourceEvidence(observation?.versionEvidence),
  receivedDeviceMs: Number.isSafeInteger(observation?.receivedDeviceMs) ? observation.receivedDeviceMs : null,
  receivedMonotonicMs: Number.isFinite(observation?.receivedMonotonicMs) ? observation.receivedMonotonicMs : null });
const validVersion = observation => !!orderSourceEvidence(observation?.versionEvidence) &&
  observation.versionEvidence.loginResponseRef === observation.responseRef;
const matchedFrameVersion = (context, observation, officialUid) => {
  const checked = officialAnswerProtocolChecks(observation, observation?.versionEvidence, context, officialUid);
  return checked.versionProtocol === true && checked.frameProtocol === true;
};
const validLogin = (context, observation) => observation?.source === 'response' && observation.transport === 'answered' &&
  observation.method === 'index.login' && observation.connectionEpoch === context.connectionEpoch && auxPositive(observation.requestSequence) &&
  typeof observation.responseRef === 'string' && observation.responseRef.length > 0 && observation.responseRef.length <= 512 &&
  typeof observation.wireKey === 'string' && /^ws\|\d+\|[1-9]\d*$/.test(observation.wireKey) &&
  Number(observation.wireKey.split('|').at(-1)) === observation.requestSequence && observation.envelopeOk === true &&
  observation.dsName === 'G.ISyncData' && observation.rejected !== true &&
  matchedFrameVersion(context, observation, auxAt(observation.value, ['7','0','0']).value) &&
  !(observation.messagePresent === true && observation.noticeOnly !== true) && validVersion(observation) &&
  auxAt(observation.value, ['7', '0', '0']).supplied && auxPositive(auxAt(observation.value, ['7', '0', '0']).value);
const validAcceptedIncrement = (context, observation, head, acceptedProjection) => {
  const anchor = head?.source?.versionEvidence;
  return acceptedProjection === true && observation?.source === 'response' && observation.transport === 'answered' &&
    isNormalSyncMethod(observation.method) && observation.method !== 'index.login' && observation.connectionEpoch === context.connectionEpoch &&
    auxPositive(observation.requestSequence) && typeof observation.responseRef === 'string' && observation.responseRef.length > 0 &&
    typeof observation.wireKey === 'string' && /^ws\|\d+\|[1-9]\d*$/.test(observation.wireKey) &&
    Number(observation.wireKey.split('|').at(-1)) === observation.requestSequence && observation.envelopeOk === true &&
    observation.dsName === 'G.ISyncData' && observation.rejected !== true && !(observation.messagePresent === true && observation.noticeOnly !== true) &&
    observation.versionEvidence?.source === 'normal-package-hop-and-matched-world-login/v1' &&
    observation.versionEvidence.gameVersion === anchor?.gameVersion && observation.versionEvidence.protocolVersion === anchor?.protocolVersion &&
    observation.versionEvidence.loginResponseRef === anchor?.loginResponseRef &&
    currentOfficialSourceEvidence(observation.versionEvidence)?.proofFingerprint === head.source.dataEvidence?.proofFingerprint && auxPositive(head.source.officialUid) &&
    (!auxAt(observation.value, ['7', '0', '0']).supplied || observation.value['7']['0']['0'] === head.source.officialUid) &&
    matchedFrameVersion(context, observation, head.source.officialUid);
};
function captureCardMap({ context, observation, officialUid, id, previous = null }) {
  const map = auxAt(observation?.value, ['21', '5']);
  if (!map.supplied || !map.value || typeof map.value !== 'object' || Array.isArray(map.value) || Object.keys(map.value).length > 128 ||
      Object.keys(map.value).some(key => !/^[1-9]\d*$/.test(key))) return null;
  if (!Object.hasOwn(map.value, String(id))) return null;
  return mergeOrderFlowerCardCellRow({ previous, outerMap: map.value, id, source: componentSource(observation, officialUid), context, officialUid });
}

// Card 1 uses the same complete provided 21.5 map and wire indexes as the
// existing video-card-6 capture. It records facts only; it never buys a card.
export function captureCurrentNobleCard({ context, observation, previous = null } = {}) {
  const actual = orderFlowerContext(context), officialUid = auxAt(observation?.value, ['7', '0', '0']).value,
    source = orderFlowerSafeSource(observation), map = auxAt(observation?.value, ['21', '5']);
  if (!actual || !validLogin(actual, observation) || !map.supplied || !map.value || typeof map.value !== 'object' || Array.isArray(map.value) ||
    Object.keys(map.value).length > 128 || Object.keys(map.value).some(key => !/^[1-9]\d*$/.test(key))) {
    return unknown('ORDER_AUX_NOBLE_COMPLETE_CARD_MAP_MISSING');
  }
  if (!Object.hasOwn(map.value, '1')) return previous ?? unknown('ORDER_AUX_NOBLE_CARD1_NOT_UPDATED');
  return mergeOrderFlowerCardCellRow({ previous, outerMap: map.value, id: 1, source: componentSource(observation, officialUid),
    context: actual, officialUid });
}

const emptyPayload = reasonCode => ({ inventory: unknown(reasonCode), videoCard: unknown(reasonCode), nobleCard: unknown(reasonCode),
  rewardState: unknown(reasonCode), enterState: unknown(reasonCode), videoShares: Object.fromEntries([5, 19, 34].map(id => [id, unknown(reasonCode)])) });

export function createOrderFlowerAuxiliaryFacts({ store, isCurrent } = {}) {
  for (const fn of [store?.run, store?.get, store?.transaction, store?.nowIso, isCurrent]) {
    if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') throw new TypeError('Order flower auxiliary facts require synchronous store/current ports');
  }
  store.run(`CREATE TABLE IF NOT EXISTS backend_order_flower_auxiliary_observations(
    observation_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    context_key TEXT NOT NULL,owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,
    source_json TEXT NOT NULL,accepted INTEGER NOT NULL,reason_code TEXT,payload_json TEXT NOT NULL,payload_fingerprint TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
  store.run(`CREATE TABLE IF NOT EXISTS backend_order_flower_auxiliary_heads(
    owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,context_key TEXT NOT NULL,
    context_json TEXT NOT NULL,payload_json TEXT NOT NULL,payload_fingerprint TEXT NOT NULL,source_json TEXT NOT NULL,
    revision INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,account_ref,subject_ref))`);
  store.run(`CREATE TABLE IF NOT EXISTS backend_order_flower_auxiliary_compatibility_revalidations(
    revalidation_ref TEXT PRIMARY KEY,observation_ref TEXT NOT NULL,raw_payload_fingerprint TEXT NOT NULL,proof_fingerprint TEXT NOT NULL,
    accepted INTEGER NOT NULL,reason_code TEXT,receipt_json TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
  store.run('CREATE UNIQUE INDEX IF NOT EXISTS backend_order_flower_auxiliary_compatibility_revalidation_unique ON backend_order_flower_auxiliary_compatibility_revalidations(observation_ref,proof_fingerprint)');
  for (const action of ['UPDATE', 'DELETE']) store.run(`CREATE TRIGGER IF NOT EXISTS backend_order_flower_auxiliary_observations_no_${action.toLowerCase()}
    BEFORE ${action} ON backend_order_flower_auxiliary_observations BEGIN SELECT RAISE(ABORT,'order flower auxiliary observations are append only'); END`);
  for (const action of ['UPDATE', 'DELETE']) store.run(`CREATE TRIGGER IF NOT EXISTS backend_order_flower_auxiliary_compatibility_revalidations_no_${action.toLowerCase()}
    BEFORE ${action} ON backend_order_flower_auxiliary_compatibility_revalidations BEGIN SELECT RAISE(ABORT,'order flower auxiliary revalidations are append only'); END`);

  const revoked = new Set(); let closed = false;
  const current = context => !closed && !revoked.has(orderFlowerContextKey(context)) && sync(isCurrent(context)) === true;
  const headFor = context => store.get(`SELECT * FROM backend_order_flower_auxiliary_heads WHERE owner_ref=? AND account_ref=? AND subject_ref=?`,
    context.ownerRef, context.accountRef, context.subjectRef);
  const rawAnchorFor = (context, observation) => store.get(`SELECT * FROM backend_dynamic_response_anchors WHERE owner_ref=? AND account_ref=? AND subject_ref=?
    AND owner_epoch=? AND run_epoch=? AND connection_epoch=? AND response_ref=?`, context.ownerRef, context.accountRef, context.subjectRef,
    context.ownerEpoch, context.runEpoch, context.connectionEpoch, observation.responseRef);
  const auditRevalidation = (context, observation, accepted, reasonCode, rawHash) => {
    const observationRef = 'order-flower-auxiliary-observation:' + fingerprint([context, observation.responseRef]),
      proofFingerprint = fingerprint(observation.versionEvidence?.sourceProofs ?? null),
      receipt = { context: clone(context), source: sourceRecord(context, observation, auxAt(observation.value, ['7', '0', '0']).value),
        observationRef, rawAnchorRef: 'dynamic-response-anchor:' + fingerprint([context.ownerRef, context.subjectRef, context.connectionEpoch, observation.responseRef]),
        rawPayloadFingerprint: rawHash, proofFingerprint, accepted: accepted === true, reasonCode: reasonCode || null };
    store.run(`INSERT OR IGNORE INTO backend_order_flower_auxiliary_compatibility_revalidations VALUES(?,?,?,?,?,?,?,?)`,
      'order-auxiliary-compatibility-revalidation:' + fingerprint([observationRef, proofFingerprint]), observationRef,
      rawHash, proofFingerprint, accepted ? 1 : 0, reasonCode || null, canonical(receipt), store.nowIso());
  };
  const readHead = row => {
    if (!row) return null;
    const payload = parseStored(row.payload_json, '订单辅助事实头');
    if (fingerprint(payload) !== row.payload_fingerprint) throw new Error('ORDER_AUXILIARY_HEAD_FINGERPRINT_MISMATCH');
    return { payload, context: parseStored(row.context_json, '订单辅助事实上下文'), source: parseStored(row.source_json, '订单辅助事实来源'), revision: row.revision };
  };
  const audit = (context, observation, payload, accepted, reasonCode, officialUid = null) => {
    const source = sourceRecord(context, observation, officialUid ?? auxAt(observation.value, ['7', '0', '0']).value), payloadJson = canonical(payload), payloadFingerprint = fingerprint(payload),
      observationRef = 'order-flower-auxiliary-observation:' + fingerprint([context, observation.responseRef]);
    store.run(`INSERT OR IGNORE INTO backend_order_flower_auxiliary_observations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, observationRef,
      context.ownerRef, context.accountRef, context.subjectRef, orderFlowerContextKey(context), context.ownerEpoch, context.runEpoch,
      context.connectionEpoch, encodeEvidenceJson(canonical(source)), accepted ? 1 : 0, reasonCode, encodeEvidenceJson(payloadJson), payloadFingerprint, store.nowIso());
    return { observationRef, payloadFingerprint };
  };

  function ingest({ context: rawContext, observation, acceptedProjection = false, flowerView = null, customerView = null } = {}) {
    const context = orderFlowerContext(rawContext);
    if (!context || canonical(Object.keys(rawContext).sort()) !== canonical([...ORDER_FLOWER_AXES].sort())) return freeze({ accepted: false, reasonCode: 'ORDER_AUXILIARY_CONTEXT_INVALID' });
    if (!observation || typeof observation.responseRef !== 'string' || !observation.responseRef) {
      return freeze({ accepted: false, reasonCode: 'ORDER_AUXILIARY_SOURCE_REFERENCE_MISSING' });
    }
    return store.transaction(() => {
      // Retired dependency-free old connections cannot recreate their detail.
      // Referenced CEs still accept late original evidence for unknown writes.
      if (store.get('SELECT connection_epoch FROM backend_subject_connection_epochs WHERE subject_ref=?', context.subjectRef)?.connection_epoch > context.connectionEpoch
          && !store.get('SELECT 1 FROM backend_operations WHERE subject_ref=? AND connection_epoch=? LIMIT 1', context.subjectRef, context.connectionEpoch)
          && !store.get('SELECT 1 FROM backend_session_verification_leases WHERE subject_ref=? AND original_connection_epoch=? LIMIT 1', context.subjectRef, context.connectionEpoch)
          && !store.get('SELECT 1 FROM backend_session_verification_leases WHERE subject_ref=? AND new_connection_epoch=? LIMIT 1', context.subjectRef, context.connectionEpoch))
        return freeze({ accepted: false, replayed: true, sourceIgnored: true, reasonCode: 'ORDER_AUXILIARY_SOURCE_CONNECTION_SUPERSEDED' });
      const observationRef = 'order-flower-auxiliary-observation:' + fingerprint([context, observation.responseRef]),
        rawHash = (() => { try { return observation?.value && typeof observation.value === 'object' ? fingerprint(observation.value) : null; } catch { return null; } })(),
        rawAnchor = rawAnchorFor(context, observation), duplicate = store.get(`SELECT accepted,reason_code,source_json FROM backend_order_flower_auxiliary_observations
          WHERE observation_ref=?`, observationRef), originalSource = duplicate ? parseStored(duplicate.source_json, '订单辅助来源原件') : null,
        proofFingerprint = fingerprint(observation.versionEvidence?.sourceProofs ?? null),
        priorRevalidation = duplicate && store.get(`SELECT 1 FROM backend_order_flower_auxiliary_compatibility_revalidations
          WHERE observation_ref=? AND proof_fingerprint=?`, observationRef, proofFingerprint),
        sourceRevalidation = !!duplicate && duplicate.accepted === 0 && duplicate.reason_code === 'ORDER_AUXILIARY_MATCHED_LOGIN_REQUIRED' &&
          rawAnchor?.raw_value_fingerprint === rawHash && rawHash !== null && rawAnchor?.method === 'index.login' &&
          rawAnchor?.request_sequence === observation.requestSequence && rawAnchor?.wire_key === observation.wireKey &&
          rawAnchor?.official_uid === auxAt(observation.value, ['7', '0', '0']).value &&
          canonical(originalSource?.context) === canonical(context) && validLogin(context, observation) &&
          originalSource?.source === 'response' && originalSource?.transport === 'answered' && originalSource?.method === 'index.login' &&
          originalSource?.connectionEpoch === observation.connectionEpoch && originalSource?.requestSequence === observation.requestSequence &&
          originalSource?.responseRef === observation.responseRef && originalSource?.wireKey === observation.wireKey &&
          originalSource?.receivedDeviceMs === observation.receivedDeviceMs && originalSource?.receivedMonotonicMs === observation.receivedMonotonicMs &&
          originalSource?.officialUid === auxAt(observation.value, ['7', '0', '0']).value &&
          originalSource?.versionEvidence?.gameVersion === observation.versionEvidence?.gameVersion &&
          (originalSource?.versionEvidence?.protocolVersion === observation.versionEvidence?.protocolVersion ||
            originalSource?.versionEvidence?.protocolVersion === originalSource?.protocolVersion &&
            originalSource.protocolVersion === observation.protocolVersion &&
            (originalSource.reportedServerVersion ?? originalSource.protocolVersion) ===
              (observation.reportedServerVersion ?? observation.protocolVersion) &&
            matchedFrameVersion(context, observation, auxAt(observation.value, ['7','0','0']).value)) &&
          originalSource?.versionEvidence?.loginResponseRef === observation.versionEvidence?.loginResponseRef &&
          !priorRevalidation;
      if (duplicate && !sourceRevalidation) {
        return freeze({ accepted: false, replayed: true, observationRef, reasonCode: duplicate.reason_code || 'ORDER_AUXILIARY_SOURCE_ALREADY_SEEN' });
      }
      const row = headFor(context), head = readHead(row), oldContext = head?.context;
      const increment = !!head && validAcceptedIncrement(context, observation, head, acceptedProjection);
      let reasonCode = !current(context) ? 'ORDER_AUXILIARY_CONTEXT_NOT_CURRENT'
        : !validLogin(context, observation) && !increment ? 'ORDER_AUXILIARY_MATCHED_LOGIN_REQUIRED' : null;
      if (!reasonCode && head && context.connectionEpoch < oldContext.connectionEpoch) reasonCode = 'ORDER_AUXILIARY_OLD_CONNECTION_EPOCH';
      if (!reasonCode && head && context.connectionEpoch === oldContext.connectionEpoch && sameOrderFlowerContext(context, oldContext) &&
        observation.requestSequence <= (head.source.requestSequence || 0)) reasonCode = 'ORDER_AUXILIARY_SEQUENCE_NOT_NEWER';
      if (!reasonCode && head && context.connectionEpoch === oldContext.connectionEpoch && !sameOrderFlowerContext(context, oldContext))
        reasonCode = 'ORDER_AUXILIARY_CONTEXT_REBOUND_WITHOUT_NEW_EPOCH';

      let payload = increment ? clone(head.payload) : emptyPayload(reasonCode || 'ORDER_AUXILIARY_CAPTURE_UNAVAILABLE');
      let officialUid = increment ? head?.source?.officialUid ?? null : null;
      if (!reasonCode) {
        const suppliedUid = auxAt(observation.value, ['7', '0', '0']);
        if (suppliedUid.supplied) officialUid = suppliedUid.value;
        if (head && auxPositive(head.source.officialUid) && auxPositive(officialUid) && head.source.officialUid !== officialUid)
          reasonCode = 'ORDER_AUXILIARY_STABLE_UID_CONFLICT';
      }
      if (!reasonCode && !increment) {
        const inventory = captureOrderFlowerInventory({ context, observation });
        payload.inventory = cell(inventory, 'ORDER_AUXILIARY_INVENTORY_CAPTURE_UNAVAILABLE');
        const videoCard = captureOrderFlowerVideoCard({ context, observation, previous: head?.payload?.videoCard });
        if (videoCard) payload.videoCard = { ...videoCard, source: componentSource(observation, officialUid) };
        const nobleCard = captureCurrentNobleCard({ context, observation, previous: head?.payload?.nobleCard });
        if (nobleCard) payload.nobleCard = { ...nobleCard, source: componentSource(observation, officialUid) };
        for (const id of [5, 19, 34]) {
          const prior = head?.payload?.videoShares?.[id];
          const share = captureOrderFlowerShare(observation, id, { context, officialUid,
            previous: prior?.value ?? prior });
          if (share) {
            payload.videoShares[id] = { known: share.known === true, value: share, source: share.source };
          }
        }
        const reward = captureOrderFlowerRewardState({ context, observation });
        if (reward) payload.rewardState = { known: true, inventory: cell(reward.inventory, 'ORDER_AUXILIARY_REWARD_INVENTORY_UNAVAILABLE'),
          stage: cell(reward.stage && { ...reward.stage, source: componentSource(observation, officialUid), fieldSources:
            Object.fromEntries(['uid', 'receivedIds', 'receivedTime', 'resetTime'].map(key => [key, componentSource(observation, officialUid)])) }, 'ORDER_AUXILIARY_STAGE_REWARD_UNAVAILABLE'),
          achievement: cell(reward.achievement && { ...reward.achievement, source: componentSource(observation, officialUid), fieldSources:
            Object.fromEntries(['uid', 'progress', 'receivedIndex', 'achHist', 'progressMapFingerprint', 'otherRecvMapFingerprint',
              'progressPresent', 'recvZeroProvenByCompleteMap'].map(key => [key, componentSource(observation, officialUid)])) }, 'ORDER_AUXILIARY_ACHIEVEMENT_UNAVAILABLE'),
          ownership: cell(reward.ownership && { ...reward.ownership, source: componentSource(observation, officialUid) }, 'ORDER_AUXILIARY_OWNERSHIP_UNAVAILABLE'),
          counters: reward.counters.map((one, index) => cell(one && { ...one, source: componentSource(observation, officialUid),
            fieldSources: Object.fromEntries(['uid', 'type', 'raw', 'total', 'rTime'].map(key => [key, componentSource(observation, officialUid)])) },
          'ORDER_AUXILIARY_COUNTER_' + [105, 109, 116, 107][index] + '_UNAVAILABLE')) };
        const enter = captureOrderFlowerEnterState({ context, observation });
        if (enter) payload.enterState = cell({ ...enter, board: { ...enter.board, source: componentSource(observation, officialUid),
          fieldSources: Object.fromEntries(['uid', 'residents', 'satin', 'decorate', 'receivedIds', 'resetTime']
            .map(key => [key, componentSource(observation, officialUid)])) },
          counters: enter.counters.map(one => ({ ...one, source: componentSource(observation, officialUid),
            fieldSources: Object.fromEntries(['uid', 'type', 'raw', 'total', 'rTime'].map(key => [key, componentSource(observation, officialUid)])) })) },
        'ORDER_AUXILIARY_ENTER_STATE_UNAVAILABLE');
      }
      if (!reasonCode && increment) {
        // Auxiliary components are independent cells. A normal accepted frame
        // refreshes only maps actually present in that frame; omitted sections
        // retain their previous provenance and monotonic age.
        const card6 = captureCardMap({ context, observation, officialUid, id: 6, previous: payload.videoCard });
        if (card6) payload.videoCard = card6;
        const card1 = captureCardMap({ context, observation, officialUid, id: 1, previous: payload.nobleCard });
        if (card1) payload.nobleCard = card1;
        if (payload.rewardState?.known === true && Array.isArray(payload.rewardState.counters)) {
          for (const id of [105, 109, 116, 107]) {
            const index = [105, 109, 116, 107].indexOf(id), counter = captureOrderFlowerCounter(observation, id);
            const row = payload.rewardState.counters[index];
            if (counter) {
              const source = componentSource(observation, officialUid);
              payload.rewardState.counters[index] = { known: true, value: { ...counter, source,
                fieldSources: Object.fromEntries(['uid', 'type', 'raw', 'total', 'rTime'].map(key => [key, source])) } };
              continue;
            }
            // The read model has already accepted and merged this normal frame
            // per field. Copy only cells whose own source is this response; a
            // partial counter frame must not renew the other counter fields.
            const viewRow = id === 107 ? customerView?.eligibilityInputs?.count107 : flowerView?.counters?.[id];
            if (!viewRow || !row?.known || !row.value) continue;
            const fields = { uid: 'uid', type: 'type', raw: id === 107 ? 'tdyCnt' : 'tdyCnt',
              total: 'totCnt', rTime: id === 107 ? 'rTime' : 'rTime' };
            const next = clone(row.value), fieldSources = { ...(next.fieldSources || {}) };
            for (const [key, cellKey] of Object.entries(fields)) {
              const sourceCell = viewRow[cellKey];
              if (sourceCell?.current !== true || sourceCell.source?.responseRef !== observation.responseRef ||
                  sourceCell.source?.connectionEpoch !== context.connectionEpoch || !Object.hasOwn(sourceCell, 'value')) continue;
              next[key] = sourceCell.value;
              fieldSources[key] = componentSource({ ...observation, ...sourceCell.source,
                receivedDeviceMs: sourceCell.source.receivedDeviceMs, receivedMonotonicMs: sourceCell.source.receivedMonotonicMs }, officialUid);
            }
            const requiredFields = ['uid', 'type', 'raw', 'total', 'rTime'];
            if (requiredFields.every(key => Object.hasOwn(next, key) && fieldSources[key]?.responseRef &&
                fieldSources[key]?.connectionEpoch === context.connectionEpoch)) {
              next.fieldSources = fieldSources;
              payload.rewardState.counters[index] = { known: true, value: next };
            }
          }
        }
        // Enter decisions consume the same four current counter facts as the
        // reward actions. Keep one canonical, per-counter source set instead
        // of leaving enterState frozen at its login copy.
        if (payload.enterState?.known === true && payload.rewardState?.known === true &&
            Array.isArray(payload.rewardState.counters) && payload.rewardState.counters.length === 4 &&
            payload.rewardState.counters.every(row => row?.known === true && row.value)) {
          payload.enterState.value = { ...payload.enterState.value,
            counters: payload.rewardState.counters.map(row => clone(row.value)) };
        }
        for (const id of [5, 19, 34]) {
          const prior = payload.videoShares?.[id];
          const share = captureOrderFlowerShare(observation, id, { context, officialUid,
            previous: prior?.value ?? prior });
          if (share) {
            payload.videoShares[id] = { known: share.known === true, value: share, source: share.source };
          }
        }
        // Reward and enter components are sourced independently from the
        // complete login inventory. Refresh only a section actually carried
        // by this accepted response; each updated component gets this frame's
        // own provenance while omitted sections retain their old age.
        const hasPath = path => auxAt(observation.value, path).supplied;
        const uid = officialUid;
        const rewardParts = captureOrderFlowerRewardComponents({ observation, officialUid: uid });
        if (hasPath(['105', '0', '2']) || hasPath(['105', '0', '3']) || hasPath(['105', '0', '10'])) {
          payload.rewardState ||= { known: true, inventory: unknown('ORDER_AUXILIARY_REWARD_INVENTORY_UNAVAILABLE'),
            stage: unknown('ORDER_AUXILIARY_STAGE_REWARD_UNAVAILABLE'), achievement: unknown('ORDER_AUXILIARY_ACHIEVEMENT_UNAVAILABLE'),
            ownership: unknown('ORDER_AUXILIARY_OWNERSHIP_UNAVAILABLE'), counters: [105, 109, 116, 107].map(() => unknown('ORDER_AUXILIARY_COUNTER_UNAVAILABLE')) };
          const old = payload.rewardState.stage?.known === true ? payload.rewardState.stage.value : null;
          const rawStage = auxAt(observation.value, ['105', '0']).value;
          if (rawStage?.['0'] != null && rawStage['0'] !== uid) payload.rewardState.stage = unknown('ORDER_AUXILIARY_STABLE_UID_CONFLICT');
          else if (!old) payload.rewardState.stage = rewardParts?.stage ? { known: true, value: { ...rewardParts.stage,
            source: componentSource(observation, uid), fieldSources: Object.fromEntries(['uid', 'receivedIds', 'receivedTime', 'resetTime']
              .map(key => [key, componentSource(observation, uid)])) } } : unknown('ORDER_AUXILIARY_STAGE_REWARD_UNAVAILABLE');
          else {
            const next = clone(old), fieldSources = { ...(old.fieldSources || {}) }, src = componentSource(observation, uid);
            for (const [wireKey, key, parse] of [['2', 'receivedIds', value => Array.isArray(value) && value.length <= 4 &&
              value.every(id => auxPositive(id) && id <= 4) && new Set(value).size === value.length ? [...value].sort() : null],
              ['3', 'receivedTime', value => value == null ? null : auxPositive(auxDate(value)) ? auxDate(value) : undefined],
              ['10', 'resetTime', value => auxPositive(auxDate(value)) ? auxDate(value) : undefined]]) {
              const entry = auxAt(observation.value, ['105', '0', wireKey]);
              if (!entry.supplied) continue;
              const parsed = parse(entry.value);
              if (parsed === undefined || parsed === null && wireKey !== '3') { payload.rewardState.stage = unknown('ORDER_AUXILIARY_STAGE_REWARD_UNAVAILABLE'); break; }
              next[key] = parsed; fieldSources[key] = src;
            }
            if (payload.rewardState.stage?.known !== false) payload.rewardState.stage = { known: true, value: { ...next, source: src, fieldSources } };
          }
        }
        if (hasPath(['22', '2'])) {
          payload.rewardState ||= { known: true, inventory: unknown('ORDER_AUXILIARY_REWARD_INVENTORY_UNAVAILABLE'),
            stage: unknown('ORDER_AUXILIARY_STAGE_REWARD_UNAVAILABLE'), achievement: unknown('ORDER_AUXILIARY_ACHIEVEMENT_UNAVAILABLE'),
            ownership: unknown('ORDER_AUXILIARY_OWNERSHIP_UNAVAILABLE'), counters: [105, 109, 116, 107].map(() => unknown('ORDER_AUXILIARY_COUNTER_UNAVAILABLE')) };
          const update = captureOrderFlowerAchievementFieldUpdates({ observation, officialUid: uid });
          const prior = payload.rewardState.achievement, previous = prior?.value && typeof prior.value === 'object' ? prior.value : {};
          if (update?.malformed) payload.rewardState.achievement = unknown('ORDER_AUXILIARY_ACHIEVEMENT_UNAVAILABLE');
          else if (update) {
            const next = clone(previous), fieldSources = { ...(next.fieldSources || {}) };
            for (const [key, item] of Object.entries(update.fields)) {
              next[key] = item.value;
              fieldSources[key] = componentSource(observation, uid);
            }
            next.uid ??= uid;
            next.groupId = 9;
            // UID is the already verified login identity anchor unless the
            // response explicitly repeated it; it is not freshened by an
            // unrelated achievement map update.
            if (!fieldSources.uid && prior?.known === true) fieldSources.uid = previous.fieldSources?.uid ||
              previous.source || componentSource(observation, uid);
            next.source = componentSource(observation, uid);
            next.fieldSources = fieldSources;
            const required = ['uid', 'progress', 'receivedIndex', 'achHist', 'progressMapFingerprint',
              'otherRecvMapFingerprint', 'progressPresent', 'recvZeroProvenByCompleteMap'];
            payload.rewardState.achievement = required.every(key => Object.hasOwn(next, key) && fieldSources[key])
              ? { known: true, value: next }
              : { known: false, reasonCode: 'ORDER_AUXILIARY_ACHIEVEMENT_PARTIAL', value: next };
          }
        }
        if (hasPath(['101', '0'])) {
          payload.rewardState ||= { known: true, inventory: unknown('ORDER_AUXILIARY_REWARD_INVENTORY_UNAVAILABLE'),
            stage: unknown('ORDER_AUXILIARY_STAGE_REWARD_UNAVAILABLE'), achievement: unknown('ORDER_AUXILIARY_ACHIEVEMENT_UNAVAILABLE'),
            ownership: unknown('ORDER_AUXILIARY_OWNERSHIP_UNAVAILABLE'), counters: [105, 109, 116, 107].map(() => unknown('ORDER_AUXILIARY_COUNTER_UNAVAILABLE')) };
          if (rewardParts?.ownership) payload.rewardState.ownership = { known: true, value: { ...rewardParts.ownership,
            source: componentSource(observation, uid) } };
        }
        if (hasPath(['105', '0'])) {
          const board = captureOrderFlowerEnterBoard({ observation, officialUid: uid });
          const previous = payload.enterState?.known === true ? payload.enterState.value : null;
          if (board) {
            const counters = payload.rewardState?.counters ?? previous?.counters ?? [];
            const source = componentSource(observation, uid);
            payload.enterState = { known: true, value: { board: { ...board, source, fieldSources:
              Object.fromEntries(['uid', 'residents', 'satin', 'decorate', 'receivedIds', 'resetTime'].map(key => [key, source])) }, counters,
              inventory: previous?.inventory ?? unknown('ORDER_AUXILIARY_INVENTORY_CAPTURE_UNAVAILABLE') } };
          } else {
            const updates = captureOrderFlowerEnterBoardUpdates({ observation, officialUid: uid });
            if (updates?.malformed) payload.enterState = unknown('ORDER_AUXILIARY_ENTER_STATE_UNAVAILABLE');
            else if (updates && previous?.board) {
              const source = componentSource(observation, uid), nextBoard = clone(previous.board);
              const fieldSources = { ...(nextBoard.fieldSources || {}) };
              for (const [key, value] of Object.entries(updates.fields)) { nextBoard[key] = value; fieldSources[key] = source; }
              nextBoard.fieldSources = fieldSources;
              const required = ['uid', 'receivedIds', 'resetTime'];
              if (required.every(key => Object.hasOwn(nextBoard, key) && fieldSources[key]) &&
                  Object.hasOwn(nextBoard, 'residents') && Object.hasOwn(nextBoard, 'satin') && Object.hasOwn(nextBoard, 'decorate')) {
                payload.enterState = { known: true, value: { ...previous, board: nextBoard } };
              } else payload.enterState = { known: false, reasonCode: 'ORDER_AUXILIARY_ENTER_BOARD_PARTIAL', value: { ...previous, board: nextBoard } };
            }
          }
        }
      }
      if (!reasonCode) payload = clone(payload);
      const audited = audit(context, observation, payload, !reasonCode, reasonCode, officialUid);
      if (reasonCode) {
        if (sourceRevalidation) auditRevalidation(context, observation, false, reasonCode, rawHash);
        return freeze({ accepted: false, audited: true, observationRef: audited.observationRef, reasonCode });
      }
      const source = sourceRecord(context, observation, officialUid), revision = (head?.revision || 0) + 1,
        payloadJson = canonical(payload), contextJson = canonical(context), sourceJson = canonical(source), payloadFingerprint = fingerprint(payload);
      store.run(`INSERT INTO backend_order_flower_auxiliary_heads VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(owner_ref,account_ref,subject_ref) DO UPDATE SET context_key=excluded.context_key,context_json=excluded.context_json,
        payload_json=excluded.payload_json,payload_fingerprint=excluded.payload_fingerprint,source_json=excluded.source_json,
        revision=excluded.revision,updated_at=excluded.updated_at`, context.ownerRef, context.accountRef, context.subjectRef,
      orderFlowerContextKey(context), contextJson, encodeEvidenceJson(payloadJson), payloadFingerprint, encodeEvidenceJson(sourceJson), revision, store.nowIso());
      if (sourceRevalidation) auditRevalidation(context, observation, true, null, rawHash);
      return freeze({ accepted: true, audited: true, revalidated: sourceRevalidation, current: true, observationRef: audited.observationRef, payloadFingerprint, revision,
        readOnly: true, writeEligible: false });
    });
  }

  function read(rawContext) {
    const context = orderFlowerContext(rawContext);
    if (!context || canonical(Object.keys(rawContext).sort()) !== canonical([...ORDER_FLOWER_AXES].sort())) return freeze({ current: false, reasonCode: 'ORDER_AUXILIARY_CONTEXT_INVALID', payload: emptyPayload('ORDER_AUXILIARY_CONTEXT_INVALID') });
    const row = headFor(context), head = readHead(row), matches = !!head && row.context_key === orderFlowerContextKey(context) &&
      sameOrderFlowerContext(context, head.context) && current(context);
    if (!matches) return freeze({ current: false, reasonCode: !head ? 'ORDER_AUXILIARY_FACTS_NOT_OBSERVED' : 'ORDER_AUXILIARY_HEAD_NOT_CURRENT',
      context, payload: emptyPayload(!head ? 'ORDER_AUXILIARY_FACTS_NOT_OBSERVED' : 'ORDER_AUXILIARY_HEAD_NOT_CURRENT'), revision: head?.revision || 0,
      readOnly: true, writeEligible: false });
    return freeze({ current: true, reasonCode: null, context, payload: clone(head.payload), source: clone(head.source), revision: head.revision,
      payloadFingerprint: row.payload_fingerprint, readOnly: true, writeEligible: false });
  }

  function stop(rawContext) {
    const context = orderFlowerContext(rawContext);
    if (context && canonical(Object.keys(rawContext).sort()) === canonical([...ORDER_FLOWER_AXES].sort())) revoked.add(orderFlowerContextKey(context));
  }
  function shutdown() { closed = true; revoked.clear(); }
  const sourceRetirement = createOrderFlowerAuxiliarySourceRetirement({ store });
  return Object.freeze({ ingest, read, stop, shutdown, retireSources: sourceRetirement.retire });
}
