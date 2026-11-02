import { canonical, clone, fingerprint, freeze, newId, parseStored, plainObject } from '../../common.mjs';
import { ledgerJsonFingerprint } from '../../persistence/json-contract.mjs';
import { orderFlowerContext, sameOrderFlowerContext, knownOrderFlowerCell } from './wire-facts.mjs';
import { currentOrderFlowerRows, orderFlowerPlainRow } from './identity.mjs';
import { orderFlowerContent } from './rpc-contract.mjs';
import { ORDER_FLOWER_AUX_POST_READ, auxBagBody, auxNonnegative, auxPositive, orderFlowerAuxiliarySourceSupported } from './auxiliary-contract.mjs';
import { ORDER_FLOWER_REWARD_CONTRACTS, assertOrderFlowerRewardProposal, evaluateOrderFlowerRewardEligibility,
  assertOrderFlowerRewardPreparedOperation, createOrderFlowerRewardVerification } from './reward-contract.mjs';
import { ORDER_FLOWER_ENTER_CONTRACTS, assertOrderFlowerEnterProposal, orderFlowerEnterOpportunity,
  assertOrderFlowerEnterPreparedOperation, createOrderFlowerEnterVerification } from './enter-contract.mjs';
import { ORDER_FLOWER_VIDEO_CONTRACTS, assertOrderFlowerVideoProposal, evaluateOrderFlowerVideoCard,
  orderFlowerVideoPolicy, assertOrderFlowerVideoPreparedOperation, createOrderFlowerVideoVerification } from './video-contract.mjs';
import { createOrderFlowerVideoRequestPreparation } from './video-request-preparation.mjs';
import { isNormalSyncMethod } from '../../facts/normal-sync-contract.mjs';
import { createCurrentNeedReconciler } from '../../execution/current-need.mjs';
import { currentOfficialSourceEvidence } from '../../official-data-evidence.mjs';

const VERSION = 'order-flower-auxiliary-admission/v1';
const KINDS = ['resident', 'satin', 'decorate'];
const sync = value => { if (value?.then) { value.catch?.(() => {}); throw new TypeError('Auxiliary admission ports must be synchronous'); } return value; };
const value = cell => cell?.known === true ? cell.value ?? null : null;
const scalar = cell => knownOrderFlowerCell(cell) && cell.current === true ? cell.value : null;
const equal = (a, b) => canonical(a) === canonical(b);
const fieldFor = proposal => proposal?.orderFlowerVideo ? 'orderFlowerVideo' : proposal?.orderFlowerEnter ? 'orderFlowerEnter' : proposal?.orderFlowerReward ? 'orderFlowerReward' : null;
const definitionFor = proposal => proposal?.orderFlowerVideo ? ORDER_FLOWER_VIDEO_CONTRACTS[proposal.orderFlowerVideo.kind]
  : proposal?.orderFlowerEnter ? ORDER_FLOWER_ENTER_CONTRACTS[proposal.orderFlowerEnter.kind]
  : ORDER_FLOWER_REWARD_CONTRACTS[proposal?.orderFlowerReward?.kind];
const assertProposal = proposal => proposal?.orderFlowerVideo ? assertOrderFlowerVideoProposal(proposal)
  : proposal?.orderFlowerEnter ? assertOrderFlowerEnterProposal(proposal) : assertOrderFlowerRewardProposal(proposal);
const dayBasis = day => day ? Object.fromEntries(['known', 'key', 'startMs', 'endMs', 'proofRef', 'source', 'timezoneProof', 'utcOffsetMinutes']
  .map(key => [key, day[key] ?? null])) : null;
const validSource = (source, context, anchor) => source?.kind === 'response' && source.connectionEpoch === context.connectionEpoch &&
  isNormalSyncMethod(source.method) && Number.isSafeInteger(source.requestSequence) && source.requestSequence > 0 &&
  typeof source.responseRef === 'string' && source.responseRef.length > 0 && source.versionEvidence?.loginResponseRef === anchor?.loginResponseRef &&
  source.versionEvidence?.gameVersion === anchor?.gameVersion && source.versionEvidence?.protocolVersion === anchor?.protocolVersion;
function currentAbsoluteInventory({ context, loginInventory, projection }) {
  const bag = projection?.inventory?.bag, profile = projection?.profile;
  if (projection?.current !== true || projection.identity?.verified !== true || !loginInventory?.versionEvidence ||
      projection.identity?.uid?.presence !== 'present' || projection.identity.uid.state !== 'known' ||
      projection.identity.uid.value !== loginInventory.officialUid ||
      !bag || bag.presence !== 'present' || bag.state !== 'known' || bag.complete !== true || !bag.source ||
      bag.source.connectionEpoch !== context.connectionEpoch || !plainObject(bag.items)) return null;
  const items = {};
  const itemSources = {};
  for (const [id, cell] of Object.entries(bag.items)) {
    if (!/^[1-9]\d*$/.test(id) || cell?.presence !== 'present' || cell.state !== 'known' ||
        !Number.isSafeInteger(cell.value) || cell.value < 0 || !validSource(cell.source, context, loginInventory.versionEvidence)) return null;
    items[id] = cell.value; itemSources[id] = clone(cell.source);
  }
  const fields = { gold: profile?.gold, yb: profile?.yuanbao, level: profile?.level, lvlExp: profile?.lvlExp };
  const fieldValues = {}, fieldSources = {};
  for (const [name, cell] of Object.entries(fields)) {
    if (cell?.presence !== 'present' || cell.state !== 'known' || !Number.isSafeInteger(cell.value) || cell.value < 0 ||
        !validSource(cell.source, context, loginInventory.versionEvidence)) return null;
    fieldValues[name] = cell.value; fieldSources[name] = clone(cell.source);
  }
  const vipExp = profile?.vipExp;
  if (vipExp?.presence === 'present' && vipExp.state === 'known' && Number.isSafeInteger(vipExp.value) && vipExp.value >= 0 &&
      validSource(vipExp.source, context, loginInventory.versionEvidence)) {
    fieldValues.vipExp = vipExp.value; fieldSources.vipExp = clone(vipExp.source);
  }
  if (!auxPositive(fieldValues.level)) return null;
  const positiveItems = auxBagBody(items), sources = { bagSource: clone(bag.source), itemSources, profileSources: fieldSources },
    projectionFingerprint = fingerprint({ items: positiveItems, profile: fieldValues, sources });
  return freeze({ version: 'order-aux-current-inventory/v2', context: clone(context), officialUid: loginInventory.officialUid,
    source: clone(loginInventory.source), versionEvidence: clone(loginInventory.versionEvidence), bagComplete: true,
    bagFingerprint: fingerprint(positiveItems), bagEntries: Object.keys(positiveItems).length, rewardSeedQuantity: items['21068'] || 0,
    profile: fieldValues, fieldSources, itemValues: items, itemSources, bagSource: clone(bag.source),
    baseline: { source: clone(loginInventory.source), fingerprint: loginInventory.bagFingerprint },
    projectionFingerprint });
}

// This adapter owns no sender. Video admission uses a request-only proof or a
// current official card; the shared gateway owns dispatch.
export function createOrderFlowerAuxiliaryRuntime({ store, readAuxiliaryFacts, readView, reconcileIdentities,
  readEligibility, readGenerationFacts, readConfiguration, isCurrent, clock, ledgerView, isolationEvidence,
  validateReadSnapshotLease, appendOutbox, notify, legacyConstraints = null, readLegacyOperation = null,
  requestFreshLogin = null, videoRequestProvider = null, readStockPlanning = null, readCurrentInventory = null,
  currentNeedFacts = null } = {}) {
  for (const fn of [store?.get, store?.run, store?.all, store?.transaction, store?.nowIso, readAuxiliaryFacts, readView, readCurrentInventory,
    reconcileIdentities, readEligibility, readGenerationFacts, readConfiguration, isCurrent, clock, ledgerView?.operation,
    ledgerView?.currentAdmission, validateReadSnapshotLease, appendOutbox, notify]) {
    if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') throw new TypeError('Auxiliary runtime requires synchronous finite ports');
  }
  store.run(`CREATE TABLE IF NOT EXISTS backend_order_flower_enter_opportunities(
    owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,lifecycle_ref TEXT NOT NULL,operation_id TEXT NOT NULL,
    opportunity_fingerprint TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    PRIMARY KEY(owner_ref,subject_ref,lifecycle_ref))`);
  store.run(`CREATE TABLE IF NOT EXISTS backend_order_flower_enter_opportunity_events(
      event_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,lifecycle_ref TEXT NOT NULL,
      previous_operation_id TEXT,new_operation_id TEXT NOT NULL,claim_ref TEXT,reason_code TEXT NOT NULL,evidence_json TEXT NOT NULL,
      evidence_fingerprint TEXT NOT NULL,created_at TEXT NOT NULL)`);
  const currentNeedReconciler = createCurrentNeedReconciler({ store, ledgerView, isolationEvidence });
  function sourceCapability(rawContext) {
    const context = orderFlowerContext(rawContext);
    if (!context || sync(isCurrent(context)) !== true) return null;
    const view = sync(readView(context)), uid = view?.identity?.uid, source = uid?.source, version = source?.version;
    if (view?.current !== true || !knownOrderFlowerCell(uid) || uid.current !== true || source?.kind !== 'response' ||
        source.connectionEpoch !== context.connectionEpoch || source.method !== 'index.login' ||
        source.responseRef !== version?.loginResponseRef || !currentOfficialSourceEvidence(version)) return null;
    const evidence = currentOfficialSourceEvidence(version);
    return Object.freeze({ known: true, supported: orderFlowerAuxiliarySourceSupported(version),
      sourceVersion: version.gameVersion, loginResponseRef: version.loginResponseRef,
      proofFingerprint: evidence.proofFingerprint });
  }
  const isLeaseCurrent = ({ proposal, bridge }) => {
    const result = sync(validateReadSnapshotLease({ leaseRef: bridge?.leaseRef, operationId: proposal.operationId,
      originalContext: bridge?.originalContext, newContext: bridge?.newContext, after: bridge?.after, bridgeFingerprint: bridge?.bridgeFingerprint }));
    return result?.valid === true && result.current === true;
  };
  const validateCapability = input => typeof videoRequestProvider?.validateCapability === 'function' &&
    sync(videoRequestProvider.validateCapability(input)) === true;
  const verifiers = {
    reward: createOrderFlowerRewardVerification({ isLeaseCurrent }), enter: createOrderFlowerEnterVerification({ isLeaseCurrent }),
    video: createOrderFlowerVideoVerification({ isLeaseCurrent, validateCapability })
  };
  const verifierFor = proposal => proposal.orderFlowerVideo ? verifiers.video : proposal.orderFlowerEnter ? verifiers.enter : verifiers.reward;
  const videoRequestPreparation = createOrderFlowerVideoRequestPreparation({ videoRequestProvider, isCurrent,
      validateOriginal: validateVideoRequestPreparationOriginal, validateRequestAdmission: validateVideoRequestAdmissionOriginal, appendOutbox, notify });

  function state(rawContext, ownOperationId = null) {
    const context = orderFlowerContext(rawContext);
    if (!context || sync(isCurrent(context)) !== true) return { context, reasonCode: 'ORDER_AUXILIARY_CURRENT_EXECUTION_REQUIRED' };
    const auxiliary = sync(readAuxiliaryFacts(context)), view = sync(readView(context)), official = sync(readGenerationFacts(context)),
      config = sync(readConfiguration(context)), currentClock = sync(clock(context.subjectRef)), payload = auxiliary?.payload,
      loginInventory = value(payload?.inventory), day = official?.officialDay,
      currentProjection = sync(readCurrentInventory(context)),
      inventory = currentAbsoluteInventory({ context, loginInventory, projection: currentProjection });
    const result = { context, auxiliary, view, official, config, clock: currentClock, inventory, day,
      stockPlanning: typeof readStockPlanning === 'function' ? sync(readStockPlanning(context, ownOperationId)) : null,
      open: sync(readEligibility({ context, view, clock: currentClock })), identities: sync(reconcileIdentities({ context, view })) };
    if (!auxiliary?.current || !sameOrderFlowerContext(auxiliary.context, context) || !view?.available || !view.current ||
      !sameOrderFlowerContext(view.context, context) || !view.identity?.verified || !inventory || !loginInventory ||
      inventory.officialUid !== scalar(view.identity.uid) || auxiliary.source?.officialUid !== inventory.officialUid ||
      view.identity.source?.responseRef !== loginInventory.source.responseRef ||
      !['source', 'gameVersion', 'protocolVersion', 'loginResponseRef'].every(key =>
        auxiliary.source?.versionEvidence?.[key] === loginInventory.versionEvidence?.[key]) ||
      day?.known !== true || day.source?.officialUid !== inventory.officialUid || day.source?.responseRef !== loginInventory.source.responseRef) {
      return { ...result, reasonCode: 'ORDER_AUXILIARY_SAME_CURRENT_LOGIN_FACTS_REQUIRED' };
    }
    if (!currentClock?.available || currentClock.source !== 'official-anchor-monotonic' || currentClock.connectionEpoch !== context.connectionEpoch ||
      !Number.isFinite(currentClock.lowerBoundMs) || !Number.isFinite(currentClock.upperBoundMs) ||
      currentClock.lowerBoundMs > currentClock.upperBoundMs || currentClock.lowerBoundMs < day.startMs || currentClock.upperBoundMs >= day.endMs) {
      return { ...result, reasonCode: 'ORDER_AUXILIARY_CURRENT_OFFICIAL_DAY_REQUIRED' };
    }
    // The absolute bag/profile below comes from the shared projection. Each
    // cell retains its own response source; an unrelated partial answer does
    // not renew untouched cells. The login remains the identity/version/day
    // anchor, while current inventory is allowed to advance independently.
    return { ...result, reasonCode: null };
  }
  const enabled = (current, kind) => current.config?.config?.orders?.[kind]?.enabled === true;
  const currentOpen = (current, kind) => current.open?.current === true && current.open?.officialUid === current.inventory?.officialUid &&
    current.open[kind]?.known === true && current.open[kind].value === true;
  const rewardState = current => {
    const raw = current.auxiliary?.payload?.rewardState;
    return raw?.known === true ? { inventory: value(raw.inventory), stage: value(raw.stage), achievement: value(raw.achievement),
      ownership: value(raw.ownership), counters: (raw.counters || []).map(value) } : null;
  };
  const enterEligibility = (current, kind) => ({ current: currentOpen(current, kind), open: currentOpen(current, kind), kind,
    officialUid: current.inventory.officialUid, context: clone(current.context), basisRef: current.open[kind]?.proofRef ?? null });
  const exactSource = (one, current) => {
    const source = one?.source, anchor = current.inventory?.versionEvidence;
    return one?.known === true && source?.officialUid === current.inventory?.officialUid &&
      source.connectionEpoch === current.context.connectionEpoch && isNormalSyncMethod(source.method) &&
      typeof source.responseRef === 'string' && source.responseRef.length > 0 &&
      source.versionEvidence?.loginResponseRef === anchor?.loginResponseRef &&
      source.versionEvidence?.gameVersion === anchor?.gameVersion && source.versionEvidence?.protocolVersion === anchor?.protocolVersion;
  };
  function completedOpportunityCap(current, actionKey, kind) {
    const day = current.day, clockNow = current.clock?.nowMs;
    if (!day?.known || !auxPositive(day.endMs) || !Number.isFinite(clockNow) || day.endMs <= clockNow ||
        typeof day.proofRef !== 'string' || !day.proofRef) return null;
    const configRevision = current.config?.savedRevision;
    if (!Number.isSafeInteger(configRevision)) return null;
    const cap = (suffix, refs, reasonCode) => ({ state: 'cap-wait', reasonCode, suspension: { kind: 'period-cap',
      quotaKey: 'order-flower:' + kind + ':' + suffix, actionScope: 'order.' + kind + ':' + actionKey,
      periodKind: 'official-day', periodKey: day.key, periodEndOfficialMs: day.endMs, scope: 'official',
      used: 1, limit: 1, proofRefs: [...new Set([day.proofRef, ...refs].filter(value => typeof value === 'string' && value.length > 0))],
      configRevision } });
    const reward = rewardState(current);
    if (actionKey === 'stage-reward') {
      const stage = reward?.stage, counters = reward?.counters;
      if (stage?.uid === current.inventory.officialUid && auxPositive(stage.resetTime) && stage.resetTime >= day.startMs && stage.resetTime < day.endMs &&
          Array.isArray(stage.receivedIds) && [1, 2, 3, 4].every(id => stage.receivedIds.includes(id)) && exactSource({ known: true, source: stage.source }, current) &&
          Array.isArray(counters) && [105, 109, 116].every(id => counters.filter(one => one?.uid === current.inventory.officialUid && one.type === id &&
            auxNonnegative(one.raw) && auxPositive(one.rTime) && one.rTime >= day.startMs && exactSource({ known: true, source: one.source }, current)).length === 1)) {
        return cap('stage-reward', [stage.source.responseRef, ...counters.filter(one => [105, 109, 116].includes(one.type)).map(one => one.source.responseRef)],
          'ORDER_STAGE_REWARD_ALL_DAILY_OPPORTUNITIES_CLAIMED');
      }
    }
    if (actionKey === 'achievement') {
      const achievement = reward?.achievement;
      if (achievement?.uid === current.inventory.officialUid && achievement.groupId === 9 && auxNonnegative(achievement.receivedIndex) &&
          achievement.receivedIndex !== 0 && exactSource({ known: true, source: achievement.source }, current)) {
        return cap('achievement', [achievement.source.responseRef], 'ORDER_ACHIEVEMENT_ALREADY_RECEIVED');
      }
    }
    if (actionKey === 'enter') {
      const beforeState = value(current.auxiliary?.payload?.enterState), board = beforeState?.board, counters = beforeState?.counters;
      if (board?.uid === current.inventory.officialUid && auxPositive(board.resetTime) && board.resetTime >= day.startMs &&
          Array.isArray(counters) && [105, 109, 116, 107].every(id => counters.filter(one => one?.uid === current.inventory.officialUid &&
            one.type === id && auxNonnegative(one.raw) && auxPositive(one.rTime) && one.rTime >= day.startMs &&
            exactSource({ known: true, source: one.source }, current)).length === 1) &&
          exactSource({ known: true, source: board.source }, current) &&
          (kind === 'resident' ? board.residents && typeof board.residents === 'object' : board[kind] !== null)) {
        const opportunity = orderFlowerEnterOpportunity({ context: current.context, kind, officialUid: current.inventory.officialUid,
          day, beforeState, eligibility: enterEligibility(current, kind) });
        if (opportunity.reasonCode === 'ORDER_ENTER_NO_REAL_INITIALIZATION_OPPORTUNITY') {
          return cap('enter', [board.source.responseRef, ...counters.map(one => one.source.responseRef)], 'ORDER_ENTER_NO_CURRENT_INITIALIZATION_OPPORTUNITY');
        }
      }
    }
    return null;
  }
  function videoQuotaCap(current, kind) {
    const day = current.day, clockNow = current.clock?.nowMs, definition = ORDER_FLOWER_VIDEO_CONTRACTS[kind],
      policy = orderFlowerVideoPolicy(kind, current.inventory?.versionEvidence), share = value(current.auxiliary?.payload?.videoShares?.[definition?.shareId]);
    if (!day?.known || !auxPositive(day.endMs) || !Number.isFinite(clockNow) || day.endMs <= clockNow ||
        typeof day.proofRef !== 'string' || !day.proofRef || !policy.known || !share ||
        share.uid !== current.inventory?.officialUid || share.shareId !== definition.shareId || !auxNonnegative(share.recvCnt) ||
        !auxPositive(share.uTime) || !exactSource({ known: true, source: share.source }, current)) return null;
    const used = share.uTime < day.startMs ? 0 : share.recvCnt;
    if (used < policy.limit) return null;
    return { state: 'cap-wait', reasonCode: 'ORDER_VIDEO_DAILY_QUOTA_EXHAUSTED', suspension: { kind: 'period-cap',
      quotaKey: 'order-flower:' + kind + ':video', actionScope: 'order.' + kind + ':video', periodKind: 'official-day',
      periodKey: day.key, periodEndOfficialMs: day.endMs, scope: 'official', used, limit: policy.limit,
      proofRefs: [...new Set([day.proofRef, share.source.responseRef, policy.tableSha256, policy.sourceGameSha256])],
      configRevision: current.config?.savedRevision } };
  }
  const videoPlan = (current, kind, boxId) => current.stockPlanning?.entries?.find(one => one.kind === kind && one.boxId === boxId) ?? null;
  const videoPlanReady = entry => entry?.branch === 'video' && ['capability-observed', 'waiting-capability'].includes(entry.state) &&
    entry.count?.known === true && entry.policyCount?.known === true && Number.isSafeInteger(entry.policyCount.value) &&
    auxPositive(entry.limit) && entry.policyCount.value < entry.limit && entry.butlerStock?.known === true && entry.videoQuota?.known === true;
  const videoPlanBasis = entry => entry ? Object.fromEntries(['kind', 'boxId', 'branch', 'contentFingerprint', 'source', 'count',
    'policyCount', 'limit', 'butlerStock', 'butlerDaily', 'shareId', 'reward', 'videoQuota'].map(key => [key, entry[key] ?? null])) : null;
  function basis(current, proposal) {
    const field = fieldFor(proposal), p = proposal[field], kind = proposal.featureId.slice(6), payload = current.auxiliary?.payload;
    return freeze({ version: VERSION, context: current.context, reasonCode: current.reasonCode,
      identity: current.inventory ? { officialUid: current.inventory.officialUid, source: current.inventory.source,
        versionEvidence: current.inventory.versionEvidence } : null,
      policy: { enabled: current.config?.config?.orders?.[kind]?.enabled ?? null, savedRevision: current.config?.savedRevision ?? null,
        cancelEpoch: current.config?.featureCancelEpochs?.[proposal.featureId] ?? null },
      day: dayBasis(current.day), inventory: current.inventory ?? null,
      eligibility: current.open?.[kind] ?? null,
      target: { semanticKey: proposal.semanticKey, lifecycleRef: p.lifecycleRef, targetFingerprint: p.targetFingerprint },
      facts: field === 'orderFlowerReward' ? rewardState(current) : field === 'orderFlowerEnter' ? value(payload?.enterState)
        : { row: currentOrderFlowerRows(current.view).filter(one => one.row.value.kind === p.kind && one.row.value.boxId === p.boxId)
          .map(one => ({ fields: orderFlowerPlainRow(one.row), source: one.source })),
        occurrence: current.identities?.identities?.find(one => one.kind === p.kind && one.boxId === p.boxId) ?? null,
        share: value(payload?.videoShares?.[ORDER_FLOWER_VIDEO_CONTRACTS[p.kind].shareId]), card: value(payload?.videoCard),
        counters: rewardState(current)?.counters ?? null, videoOpen: current.open?.video?.[p.kind] ?? null,
        stockPlanning: videoPlanBasis(videoPlan(current, p.kind, p.boxId)) } });
  }
  function readFactBasis({ proposal }) {
    assertProposal(proposal);
    return basis(state(proposal, proposal.operationId), proposal);
  }

  function originalPreparation(original) {
    if (original.original_fingerprint !== ledgerJsonFingerprint(original.original) || !equal(original.factBasis, original.original.factBasis)) return null;
    const rows = store.all(`SELECT kind,source,payload_json,payload_fingerprint,observed_at FROM backend_operation_evidence
      WHERE operation_id=? AND source='backend/write-gateway/v2' AND kind IN ('finite-domain-preparation','admitted-operation-contract')`, original.operation_id);
    const decoded = [];
    for (const row of rows) {
      const payload = parseStored(row.payload_json, '订单辅助原准备证据');
      if (ledgerJsonFingerprint({ kind: row.kind, source: row.source, payload, observedAt: row.observed_at }) !== row.payload_fingerprint) return null;
      decoded.push({ kind: row.kind, payload });
    }
    const prepared = decoded.filter(one => one.kind === 'finite-domain-preparation'), contracts = decoded.filter(one => one.kind === 'admitted-operation-contract');
    if (prepared.length !== 1 || contracts.length !== 1) return null;
    const data = prepared[0].payload.preparation, domain = prepared[0].payload.domain,
      family = domain?.startsWith('order-flower-video-') ? 'video' : domain?.startsWith('order-flower-enter-') ? 'enter'
        : domain?.startsWith('order-flower-reward-') ? 'reward' : null;
    const definition = family === 'video' ? ORDER_FLOWER_VIDEO_CONTRACTS[data?.kind] : family === 'enter' ? ORDER_FLOWER_ENTER_CONTRACTS[data?.kind]
      : family === 'reward' ? ORDER_FLOWER_REWARD_CONTRACTS[data?.kind] : null;
    const currentNeedContract = { path: family === 'video' ? 'orderFlowerVideo.currentNeed'
      : family === 'enter' ? 'orderFlowerEnter.currentNeed' : 'orderFlowerReward.currentNeed', required: true };
    const expectedContract = { ...definition, postRead: ORDER_FLOWER_AUX_POST_READ,
      ...(data?.currentNeed ? { currentNeed: currentNeedContract } : {}) };
    if (!definition || domain !== 'order-flower-' + family + '-' + data.kind || original.feature_id !== definition.featureId ||
      original.scope !== definition.scope || original.method !== definition.method || !equal(contracts[0].payload, expectedContract)) return null;
    const assertPrepared = family === 'video' ? assertOrderFlowerVideoPreparedOperation : family === 'enter' ? assertOrderFlowerEnterPreparedOperation : assertOrderFlowerRewardPreparedOperation;
    try { assertPrepared({ original: original.original, preparation: data }); } catch { return null; }
    return { data, family, preparationFingerprint: fingerprint(prepared[0].payload), contractFingerprint: fingerprint(contracts[0].payload) };
  }

  function history(current, proposal, beforeSend) {
    const context = current.context, admission = sync(ledgerView.currentAdmission({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
      targetRefs: proposal.targets.map(target => target.targetRef) }));
    if (!Array.isArray(admission?.unresolvedOperations)) return 'ORDER_AUXILIARY_CURRENT_ADMISSION_REQUIRED';
    if (admission.activeOperation && (!beforeSend || admission.activeOperation.operation_id !== proposal.operationId)) return 'ORDER_AUXILIARY_WRITE_SLOT_OCCUPIED';
    // Enter opportunities are shared by all three features. Feature-local SQL
    // uniqueness must not let another total-order switch repeat the same one.
    if (store.get(`SELECT operation_id FROM backend_operations WHERE owner_ref=? AND subject_ref=? AND semantic_key=?
      AND transport_state!='not_sent' AND operation_id!=? LIMIT 1`, context.ownerRef, context.subjectRef, proposal.semanticKey, proposal.operationId)) {
      return 'ORDER_AUXILIARY_ORIGINAL_SEMANTIC_ALREADY_SENT';
    }
    for (const row of admission.unresolvedOperations) {
      if (row.operation_id === proposal.operationId) continue;
      const original = sync(ledgerView.operation(row.operation_id));
      if (!original || original.original_fingerprint !== ledgerJsonFingerprint(original.original)) return 'ORDER_AUXILIARY_ORIGINAL_AUDIT_UNREADABLE';
      if (original.targets?.some(one => (one.target_ref ?? one.original?.targetRef) === proposal.targets[0].targetRef)) {
        const need = proposal[fieldFor(proposal)]?.currentNeed;
        const reconciled = need?.claimRef && store.get(`SELECT 1 FROM backend_current_need_reconciliations
          WHERE claim_ref=? AND original_operation_id=? AND owner_ref=? AND subject_ref=? AND feature_id=? AND target_ref=? LIMIT 1`,
        need.claimRef, original.operation_id, proposal.ownerRef, proposal.subjectRef, proposal.featureId, proposal.targets[0].targetRef);
        if (reconciled) continue;
        const prepared = originalPreparation(original), previous = prepared?.data, next = proposal[fieldFor(proposal)],
          sameFamily = prepared?.family === (proposal.orderFlowerVideo ? 'video' : proposal.orderFlowerEnter ? 'enter' : 'reward');
        const laterDay = sameFamily && previous.officialUid === next.officialUid && previous.lifecycleRef !== next.lifecycleRef &&
          auxPositive(previous.day?.startMs) && next.day.startMs > previous.day.startMs &&
          (proposal.orderFlowerEnter || proposal.orderFlowerReward?.kind === 'stage');
        const laterVideo = sameFamily && !!proposal.orderFlowerVideo && previous.officialUid === next.officialUid &&
          previous.kind === next.kind && previous.boxId === next.boxId && previous.lifecycleRef !== next.lifecycleRef &&
          auxPositive(previous.beforeOrder?.cTime) && next.beforeOrder.cTime > previous.beforeOrder.cTime && next.occurrence?.identityKnown === true;
        const separated = laterDay || laterVideo;
        const isolation = separated && typeof isolationEvidence?.read === 'function'
          ? sync(isolationEvidence.read({ context, operationId: original.operation_id })) : null;
        if (!separated || isolation?.available !== true || isolation.previousExecution?.closed !== true ||
          typeof ledgerView.recordAdmissionBasis !== 'function') return 'ORDER_AUXILIARY_EXACT_UNRESOLVED_TARGET_HELD';
        sync(ledgerView.recordAdmissionBasis({ operationId: original.operation_id, constraintKey: proposal.targets[0].targetRef,
          basisKey: fingerprint([proposal.semanticKey, proposal.factBasis, isolation.receiptHash]), conclusion: 'permit_current', factBasis: proposal.factBasis,
          affected: { targetRef: proposal.targets[0].targetRef, lifecycleRef: next.lifecycleRef,
            originalOutcomeUnchanged: true, originalResourceFootprintsUnchanged: true },
          evidence: { version: 'order-auxiliary/closed-previous-occurrence/v1', isolation,
            originalPreparationFingerprint: prepared.preparationFingerprint, originalContractFingerprint: prepared.contractFingerprint,
            previousDayStartMs: previous.day.startMs, currentDayStartMs: next.day.startMs,
            previousCreationMs: previous.beforeOrder?.cTime ?? null, currentCreationMs: next.beforeOrder?.cTime ?? null },
          reasonCode: laterVideo ? 'ORDER_AUXILIARY_CLOSED_PREVIOUS_VIDEO_OCCURRENCE' : 'ORDER_AUXILIARY_CLOSED_PREVIOUS_DAY_DISTINCT_OCCURRENCE' }));
      }
    }
    if (!legacyConstraints) return 'ORDER_AUXILIARY_LEGACY_ADMISSION_PORT_REQUIRED';
    const currentNeed = proposal[fieldFor(proposal)]?.currentNeed;
    const sharedSnapshot = typeof currentNeedFacts === 'function' ? sync(currentNeedFacts({ context,
      featureId: proposal.featureId, method: proposal.method, proposal, config: configurationForProposal(proposal) })) : null;
    if (currentNeed?.claimRef && sharedSnapshot?.complete === true && currentNeedReconciler?.reconcileLegacyCandidate) {
      const snapshot = { ...sharedSnapshot, sourceProofs: sharedSnapshot.sourceProofs.map(one => ({ method: one.method,
        responseRef: one.responseRef, requestSequence: one.requestSequence, connectionEpoch: one.connectionEpoch })) };
      const candidateFingerprint = fingerprint({ method: proposal.method, featureId: proposal.featureId,
        targetRef: proposal.targets[0].targetRef, factBasis: proposal.factBasis });
      const separated = sync(currentNeedReconciler.reconcileLegacyCandidate({ context, currentSnapshot: snapshot, currentNeed,
        legacyConstraints, isolationEvidence, rawTargetRefs: [proposal.targets[0].targetRef], rawResourceKeys: [],
        semanticKey: proposal.semanticKey, factBasis: proposal.factBasis, candidateFingerprint, action: proposal.method,
        methodScope: [proposal.method], resourceBaselineRef: admission.resourceBaseline?.baselineRef }));
      if (separated?.accepted !== true) return separated?.reasonCode || 'ORDER_AUXILIARY_LEGACY_CURRENT_NEED_UNPROVEN';
    }
    const candidateFingerprint = fingerprint({ method: proposal.method, featureId: proposal.featureId,
      targetRef: proposal.targets[0].targetRef, factBasis: proposal.factBasis });
    const projection = sync(legacyConstraints.candidateProjection({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
      semanticKey: proposal.semanticKey, rawTargetRefs: [proposal.targets[0].targetRef], rawResourceKeys: [],
      factBasis: proposal.factBasis, candidateFingerprint }));
    if (!projection || projection.ownerRef !== context.ownerRef || projection.subjectRef !== context.subjectRef ||
      !['operations', 'semanticMatches', 'matchedTargets', 'declaredTargetMatches', 'matchedResources', 'unclassifiedOperations']
        .every(key => Array.isArray(projection[key]))) {
      return 'ORDER_AUXILIARY_LEGACY_ADMISSION_UNAVAILABLE';
    }
    if (projection.semanticMatches.length) return 'ORDER_AUXILIARY_LEGACY_EXACT_SEMANTIC_HELD';
    if (proposal.method === 'usr.share' && projection.unclassifiedOperations.some(operation => operation.method === 'usr.share'))
      return 'ORDER_AUXILIARY_LEGACY_UNCLASSIFIED_USR_SHARE_TARGET_UNKNOWN';
    // No flower debit exists in these contracts. Old flower footprints remain
    // held in the resource ledger and cannot turn into a whole-account hold.
    if (projection.matchedTargets.length || projection.declaredTargetMatches.length) return 'ORDER_AUXILIARY_LEGACY_EXACT_TARGET_HELD';
    if (projection.matchedResources.length) return 'ORDER_AUXILIARY_LEGACY_EMPTY_RESOURCE_PROJECTION_CONFLICT';
    return null;
  }
  function enterClaim(current, proposal, beforeSend) {
    if (!proposal.orderFlowerEnter) return null;
    const p = proposal.orderFlowerEnter, context = current.context;
    return store.transaction(() => {
      const row = store.get(`SELECT * FROM backend_order_flower_enter_opportunities WHERE owner_ref=? AND subject_ref=? AND lifecycle_ref=?`,
        context.ownerRef, context.subjectRef, p.lifecycleRef);
      if (row && row.operation_id !== proposal.operationId) {
        const previous = sync(ledgerView.operation(row.operation_id));
        let transferProof = null;
        if (previous && previous.transport_state !== 'not_sent') {
          const need = p.currentNeed;
          transferProof = need?.claimRef ? store.get(`SELECT reconciliation_ref,evidence_fingerprint FROM backend_current_need_reconciliations
            WHERE claim_ref=? AND original_operation_id=? AND owner_ref=? AND subject_ref=? AND feature_id=? AND target_ref=? LIMIT 1`,
          need.claimRef, row.operation_id, context.ownerRef, context.subjectRef, proposal.featureId, proposal.targets[0].targetRef) : null;
          if (!transferProof || previous.business_verdict !== 'unknown' || previous.write_slot !== 0) return 'ORDER_ENTER_SHARED_OPPORTUNITY_ALREADY_CLAIMED';
        }
        if (previous && previous.transport_state === 'not_sent') transferProof = { reasonCode: 'PROVEN_NOT_SENT' };
        store.run(`UPDATE backend_order_flower_enter_opportunities SET operation_id=?,opportunity_fingerprint=?,updated_at=?
          WHERE owner_ref=? AND subject_ref=? AND lifecycle_ref=? AND operation_id=?`, proposal.operationId, fingerprint(p.opportunity), store.nowIso(),
        context.ownerRef, context.subjectRef, p.lifecycleRef, row.operation_id);
        if (transferProof) {
          const evidence = { version: 'order-enter-opportunity-transfer/v1', lifecycleRef: p.lifecycleRef,
            previousOperationId: row.operation_id, newOperationId: proposal.operationId, claimRef: p.currentNeed?.claimRef ?? null,
            reconciliationRef: transferProof.reconciliation_ref ?? null, reconciliationFingerprint: transferProof.evidence_fingerprint ?? null,
            reasonCode: previous?.business_verdict === 'unknown' ? 'CLOSED_UNKNOWN_REASSESSED_FROM_CURRENT_NEED' : 'PROVEN_NOT_SENT' };
          const eventFingerprint = fingerprint(evidence);
          store.run('INSERT OR IGNORE INTO backend_order_flower_enter_opportunity_events VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            'order-enter-opportunity-transfer:' + eventFingerprint, context.ownerRef, context.subjectRef, p.lifecycleRef,
            row.operation_id, proposal.operationId, p.currentNeed?.claimRef ?? null, evidence.reasonCode, canonical(evidence),
            eventFingerprint, store.nowIso());
        }
      } else if (!row) {
        if (beforeSend) return 'ORDER_ENTER_PREPARED_OPPORTUNITY_CLAIM_REQUIRED';
        store.run('INSERT INTO backend_order_flower_enter_opportunities VALUES(?,?,?,?,?,?,?)', context.ownerRef, context.subjectRef,
          p.lifecycleRef, proposal.operationId, fingerprint(p.opportunity), store.nowIso(), store.nowIso());
      } else if (row.opportunity_fingerprint !== fingerprint(p.opportunity)) return 'ORDER_ENTER_ORIGINAL_OPPORTUNITY_CHANGED';
      return null;
    });
  }
  function evaluateAdmission({ proposal, actor, factBasis, boundary, ownReservation = null }) {
    const deny = reasonCode => freeze({ allowed: false, reasonCode, targetsCurrent: false, resourcesCurrent: false });
    try { assertProposal(proposal); } catch (error) { return deny(error.code || 'ORDER_AUXILIARY_PROPOSAL_INVALID'); }
    const context = orderFlowerContext(proposal), beforeSend = boundary === 'before-send', kind = proposal.featureId.slice(6), p = proposal[fieldFor(proposal)];
    if (!sameOrderFlowerContext(context, orderFlowerContext(actor)) || !['before-prepare', 'before-send'].includes(boundary) ||
      beforeSend && (ownReservation?.required !== true || ownReservation.operationId !== proposal.operationId)) return deny('ORDER_AUXILIARY_BOUNDARY_OR_ACTOR_INVALID');
    const current = state(context, beforeSend ? proposal.operationId : null);
    if (current.reasonCode) return deny(current.reasonCode);
    if (!enabled(current, kind) || !currentOpen(current, kind) || current.config.savedRevision !== proposal.configRevision ||
      current.config.featureCancelEpochs?.[proposal.featureId] !== proposal.featureCancelEpoch) return deny('ORDER_AUXILIARY_SAVED_POLICY_OR_OPEN_CHANGED');
    const nextBasis = basis(current, proposal);
    if (!equal(factBasis, nextBasis) || !equal(proposal.factBasis, nextBasis)) return deny('ORDER_AUXILIARY_ORIGINAL_FACTS_CHANGED');
    if (p.source.responseRef !== current.inventory.source.responseRef || p.officialUid !== current.inventory.officialUid ||
      !equal(p.beforeInventory, current.inventory) || !equal(dayBasis(p.day), dayBasis(current.day))) return deny('ORDER_AUXILIARY_ORIGINAL_LOGIN_CHANGED');
    if (beforeSend) {
      const own = sync(ledgerView.operation(proposal.operationId));
      if (!own || own.original_fingerprint !== ledgerJsonFingerprint(own.original) || own.write_slot !== 1 ||
        !sameOrderFlowerContext({ ...own.original, accountRef: own.account_ref }, context) || own.feature_id !== proposal.featureId ||
        own.scope !== proposal.scope || own.method !== proposal.method || own.params_fingerprint !== proposal.paramsFingerprint ||
        !equal(own.original.targets, proposal.targets) || !equal(own.original.resources, []) || !equal(own.original.resourceBindings, [])) {
        return deny('ORDER_AUXILIARY_OWN_ORIGINAL_RESERVATION_INVALID');
      }
    }
    if (proposal.orderFlowerReward) {
      const observed = rewardState(current), eligible = evaluateOrderFlowerRewardEligibility({ kind: p.kind, target: p.target,
        officialUid: p.officialUid, day: current.day, beforeState: observed, versionEvidence: current.inventory.versionEvidence, level: current.inventory.profile.level });
      if (!equal(p.beforeState, observed) || !eligible.known || !eligible.eligible) return deny(eligible.reasonCode || 'ORDER_AUXILIARY_REWARD_NO_LONGER_ELIGIBLE');
    } else if (proposal.orderFlowerEnter) {
      const observed = value(current.auxiliary.payload.enterState), eligibility = enterEligibility(current, kind), opportunity = orderFlowerEnterOpportunity({
        context, kind, officialUid: p.officialUid, day: current.day, beforeState: observed, eligibility });
      if (!equal(p.beforeState, observed) || !equal(p.eligibility, eligibility) || !equal(p.opportunity, opportunity) || !opportunity.eligible) {
        return deny('ORDER_ENTER_CURRENT_OPPORTUNITY_CHANGED');
      }
    } else {
      const definition = ORDER_FLOWER_VIDEO_CONTRACTS[kind], policy = orderFlowerVideoPolicy(kind, current.inventory?.versionEvidence), share = value(current.auxiliary.payload.videoShares?.[definition.shareId]);
      const planned = videoPlan(current, kind, p.boxId);
      if (!videoPlanReady(planned) || !equal(p.stockPlanning, videoPlanBasis(planned))) return deny(planned?.reasonCode || 'ORDER_VIDEO_SHARED_STOCK_PLANNING_REQUIRED');
      if (current.open.video?.[kind]?.known !== true || current.open.video[kind].value !== true || !share || !equal(share, p.beforeShare) ||
        !policy.known || (share.uTime < current.day.startMs ? 0 : share.recvCnt) >= policy.limit) return deny('ORDER_VIDEO_CURRENT_SHARE_OR_OPEN_UNAVAILABLE');
      const match = currentOrderFlowerRows(current.view).find(one => one.row.value.kind === kind && one.row.value.boxId === p.boxId),
        occurrence = current.identities?.identities?.find(one => one.kind === kind && one.boxId === p.boxId);
      if (!match || !equal(orderFlowerPlainRow(match.row), p.beforeOrder) || !equal(occurrence, p.occurrence) ||
        !equal(rewardState(current)?.counters, p.beforeCounters) || p.beforeOrder.cdTime !== null &&
        p.beforeOrder.cdTime > current.clock.lowerBoundMs) return deny('ORDER_VIDEO_CURRENT_OCCURRENCE_OR_COOLDOWN_CHANGED');
      if (p.capability.kind === 'current-official-card6') {
        const evaluated = evaluateOrderFlowerVideoCard({ context, officialUid: p.officialUid, card: value(current.auxiliary.payload.videoCard), clock: current.clock });
        if (!evaluated.valid || !equal(evaluated.card, p.capability.card)) return deny('ORDER_VIDEO_CURRENT_CARD6_EXPIRED_OR_CHANGED');
      } else if (!validateCapability({ proposal, capability: p.capability, phase: boundary })) return deny('ORDER_VIDEO_REQUEST_PROOF_UNAVAILABLE');
    }
    const held = history(current, proposal, beforeSend);
    if (held) return deny(held);
    const claim = enterClaim(current, proposal, beforeSend);
    return claim ? deny(claim) : freeze({ allowed: true, reasonCode: null, targetsCurrent: true, resourcesCurrent: true,
      historicalConstraintsChecked: true, currentInFlightChecked: true });
  }

  function base(current, definition, preparation, params, targetRef, memberKey, semanticKey) {
    const proposal = { ...clone(current.context), operationId: newId(), proposalId: newId(), featureId: definition.featureId,
      scope: definition.scope, method: definition.method, params, paramsFingerprint: fingerprint(params), semanticKey,
      configRevision: current.config.savedRevision, featureCancelEpoch: current.config.featureCancelEpochs[definition.featureId],
      targets: [{ memberKey, targetKind: definition.targetKind, targetRef, lifecycleRef: preparation.lifecycleRef,
        targetFingerprint: preparation.targetFingerprint }], resources: [], resourceBindings: [] };
    const field = definition.method === 'usr.share' ? 'orderFlowerVideo' : definition.method === 'orderFlower.enter' ? 'orderFlowerEnter' : 'orderFlowerReward';
    proposal[field] = preparation;
    return proposal;
  }
  function attachCurrentNeed(proposal) {
    if (typeof currentNeedFacts !== 'function') return null;
    const definition = definitionFor(proposal), targetRef = proposal.targets?.[0]?.targetRef;
    const shared = sync(currentNeedFacts({ context: orderFlowerContext(proposal), featureId: proposal.featureId,
      method: proposal.method, proposal, config: configurationForProposal(proposal) }));
    if (shared?.complete !== true || !Array.isArray(shared.sourceProofs) || !shared.sourceProofs.length) {
      return shared?.reasonCode || 'ORDER_AUXILIARY_CURRENT_NEED_FACTS_NOT_COMPLETE';
    }
    const targetAdmission = sync(ledgerView.currentAdmission({ ownerRef: proposal.ownerRef, subjectRef: proposal.subjectRef,
      targetRefs: [targetRef] }));
    const sharedEnter = proposal.method === 'orderFlower.enter' && targetRef === 'flower-order-enter:' + proposal.subjectRef + ':all';
    const enterFeatures = new Set(['order.resident', 'order.satin', 'order.decorate']);
    const previous = (targetAdmission?.unresolvedOperations || []).map(one => sync(ledgerView.operation(one.operation_id))).filter(one =>
      one?.business_verdict === 'unknown' && (one.feature_id === proposal.featureId || sharedEnter && enterFeatures.has(one.feature_id) &&
        one.method === 'orderFlower.enter') && one.targets?.some(target =>
        (target.target_ref ?? target.original?.targetRef) === targetRef));
    proposal.factBasis = readFactBasis({ proposal });
    const semanticBasis = clone(proposal.factBasis);
    if (semanticBasis.target) delete semanticBasis.target.semanticKey;
    const businessNeedRef = 'business-need:' + fingerprint([proposal.featureId, proposal.method, targetRef,
      proposal[fieldFor(proposal)]?.lifecycleRef]);
    const decisionGeneration = fingerprint({ version: 'order-aux-current-decision/v1', featureId: proposal.featureId,
      targetRef, businessNeedRef, baseSemanticKey: proposal.semanticKey, sourceProofs: shared.sourceProofs });
    const currentNeed = { necessary: true, featureId: proposal.featureId, method: proposal.method,
      ...(sharedEnter ? { sharedOpportunity: 'order-flower-enter-all/v1' } : {}), targetRef, businessNeedRef,
      needRef: 'current-need:' + fingerprint([proposal.featureId, targetRef, businessNeedRef]), decisionGeneration,
      semanticFingerprint: fingerprint({ factBasis: semanticBasis, paramsFingerprint: proposal.paramsFingerprint }),
      basisRefs: [...new Set(shared.sourceProofs.map(one => one.responseRef))] };
    proposal[fieldFor(proposal)].currentNeed = currentNeed;
    const snapshot = { ...shared, sourceProofs: shared.sourceProofs.map(one => ({ method: one.method,
      responseRef: one.responseRef, requestSequence: one.requestSequence, connectionEpoch: one.connectionEpoch })) };
    proposal[fieldFor(proposal)].currentNeed = currentNeed;
    proposal.semanticKey += ':current-need:' + decisionGeneration;
    proposal.factBasis = readFactBasis({ proposal });
    const claimed = sync(currentNeedReconciler.claimCurrent({ context: orderFlowerContext(proposal), currentSnapshot: snapshot, currentNeed }));
    if (claimed?.accepted !== true) return claimed?.reasonCode || 'ORDER_AUXILIARY_CURRENT_NEED_CLAIM_REJECTED';
    currentNeed.claimRef = claimed.claimRef;
    proposal[fieldFor(proposal)].currentNeed = currentNeed;
    for (const original of previous) {
      const closed = typeof isolationEvidence?.read === 'function'
        ? sync(isolationEvidence.read({ context: orderFlowerContext(proposal), operationId: original.operation_id })) : null;
      if (closed?.available !== true || closed.previousExecution?.closed !== true) return 'ORDER_AUXILIARY_EXACT_UNRESOLVED_TARGET_HELD';
      const reconciled = sync(currentNeedReconciler.reconcile({ context: orderFlowerContext(proposal), originalOperationId: original.operation_id,
        currentSnapshot: snapshot, currentNeed, operationId: proposal.operationId }));
      if (reconciled?.accepted !== true) return reconciled?.reasonCode || 'ORDER_AUXILIARY_CURRENT_NEED_RECONCILIATION_REQUIRED';
    }
    return null;
  }
  function configurationForProposal(proposal) {
    return sync(readConfiguration(orderFlowerContext(proposal)))?.config ?? null;
  }
  const common = (current, kind) => ({ kind, officialUid: current.inventory.officialUid, source: clone(current.inventory.source),
    versionEvidence: clone(current.inventory.versionEvidence), day: clone(current.day), beforeInventory: clone(current.inventory) });
  function rewardProposal(current, rewardKind, target = null) {
    const beforeState = rewardState(current), eligibility = evaluateOrderFlowerRewardEligibility({ kind: rewardKind, target,
      officialUid: current.inventory.officialUid, day: current.day, beforeState, versionEvidence: current.inventory.versionEvidence, level: current.inventory.profile.level });
    if (!eligibility.known || !eligibility.eligible) return null;
    const lifecycleRef = rewardKind === 'stage' ? 'order-stage-reward:' + fingerprint([current.context.ownerRef, current.context.subjectRef,
      current.day.key, current.day.startMs, target]) : 'order-resident-achievement:' + fingerprint([current.context.ownerRef, current.context.subjectRef, 90001]);
    const key = rewardKind === 'stage' ? String(target) : '90001', preparation = { ...common(current, rewardKind), beforeState,
      ...(rewardKind === 'stage' ? { target } : { taskId: 90001 }), lifecycleRef,
      targetFingerprint: fingerprint({ kind: rewardKind, target: key, lifecycleRef, eligibility }) };
    return base(current, ORDER_FLOWER_REWARD_CONTRACTS[rewardKind], preparation, rewardKind === 'stage' ? { target } : { id: 90001 },
      'order-flower-reward:' + current.context.subjectRef + ':' + rewardKind + ':' + key, 'order-reward:' + lifecycleRef, 'order-flower-reward:' + lifecycleRef);
  }
  function enterProposal(current, kind) {
    const beforeState = value(current.auxiliary.payload.enterState), eligibility = enterEligibility(current, kind), opportunity = orderFlowerEnterOpportunity({
      context: current.context, kind, officialUid: current.inventory.officialUid, day: current.day, beforeState, eligibility });
    if (!opportunity.eligible) return null;
    const lifecycleRef = opportunity.lifecycleRef, preparation = { ...common(current, kind), beforeState, eligibility, opportunity, lifecycleRef,
      targetFingerprint: fingerprint({ lifecycleRef, reason: opportunity.reason, dayStartMs: current.day.startMs }) };
    return base(current, ORDER_FLOWER_ENTER_CONTRACTS[kind], preparation, {}, 'flower-order-enter:' + current.context.subjectRef + ':' +
      (opportunity.reason === 'official-day-reset' ? 'all' : kind), 'order-enter:' + lifecycleRef, 'order-flower-enter:' + lifecycleRef);
  }
  function validateVideoRequestPreparationOriginal({ proposal }) {
    // Preflight has no capability yet. Do not invoke the full proposal assert
    // until request-only admission has produced its independently held proof.
    const context = orderFlowerContext(proposal), p = proposal?.orderFlowerVideo,
      definition = ORDER_FLOWER_VIDEO_CONTRACTS[p?.kind];
    if (!context || !p || !definition || proposal.featureId !== definition.featureId || proposal.scope !== definition.scope ||
      proposal.method !== definition.method || proposal.semanticKey !== 'order-flower-video:' + p.lifecycleRef) return false;
    const target = proposal.targets?.[0], expectedArgs = { shareId: definition.shareId,
      ext: p.kind === 'resident' ? { opType: 1, id: p.boxId } : { opType: 1 } };
    if (proposal.targets?.length !== 1 || !target || target.memberKey !== 'order-video:' + p.lifecycleRef ||
      target.targetKind !== definition.targetKind || target.targetRef !== 'flower-order-video:' + context.subjectRef + ':' + p.kind + ':' + p.boxId ||
      target.lifecycleRef !== p.lifecycleRef || target.targetFingerprint !== p.targetFingerprint ||
      p.targetFingerprint !== fingerprint({ contentFingerprint: p.contentFingerprint, videoReward: p.videoReward }) ||
      !equal(p.publicArgs, expectedArgs)) return false;
    const current = state(context), kind = p.kind;
    if (current.reasonCode || !sameOrderFlowerContext(current.context, context) || !enabled(current, kind) || !currentOpen(current, kind) ||
      current.config.savedRevision !== proposal.configRevision || current.config.featureCancelEpochs?.[proposal.featureId] !== proposal.featureCancelEpoch ||
      p.officialUid !== current.inventory.officialUid || !equal(p.beforeInventory, current.inventory) ||
      p.source.responseRef !== current.inventory.source.responseRef || !equal(p.versionEvidence, current.inventory.versionEvidence) ||
      !equal(dayBasis(p.day), dayBasis(current.day))) return false;
    const planned = videoPlan(current, kind, p.boxId),
      match = currentOrderFlowerRows(current.view).find(one => one.row.value.kind === kind && one.row.value.boxId === p.boxId),
      occurrence = current.identities?.identities?.find(one => one.kind === kind && one.boxId === p.boxId),
      share = value(current.auxiliary.payload.videoShares?.[definition.shareId]), policy = orderFlowerVideoPolicy(kind, current.inventory?.versionEvidence);
    if (!videoPlanReady(planned) || !equal(p.stockPlanning, videoPlanBasis(planned)) || !match ||
      !equal(orderFlowerPlainRow(match.row), p.beforeOrder) || !equal(occurrence, p.occurrence) || !occurrence?.identityKnown ||
      occurrence.lifecycleRef !== p.lifecycleRef || fingerprint(orderFlowerContent(kind, p.boxId, p.beforeOrder)) !== p.contentFingerprint ||
      current.open.video?.[kind]?.known !== true || current.open.video[kind].value !== true || !share || !policy.known ||
      p.adSlotTag !== policy.tag ||
      !equal(share, p.beforeShare) || (share.uTime < current.day.startMs ? 0 : share.recvCnt) >= policy.limit ||
      !equal(rewardState(current)?.counters, p.beforeCounters) ||
      p.beforeOrder.cdTime !== null && p.beforeOrder.cdTime > current.clock.lowerBoundMs) return false;
    // Bind the original finite basis as well as individual inputs. A callback
    // cannot be rebased onto a later login or a different actor's stock snapshot.
    return equal(proposal.factBasis, basis(current, proposal));
  }
  function validateVideoRequestAdmissionOriginal({ proposal }) {
    if (!validateVideoRequestPreparationOriginal({ proposal })) return false;
    const context = orderFlowerContext(proposal), current = context && state(context);
    return !!current && !current.reasonCode && history(current, proposal, false) === null;
  }
  const diagnosticCode = (code, fallback) => typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(code) ? code : fallback;
  const categoryPlanReason = (current, kind) => current.stockPlanning?.entries?.find(one => one.kind === kind && !Number.isSafeInteger(one.boxId))?.reasonCode;
  function videoProposal(current, kind, match, { diagnose = null } = {}) {
    const report = (state, reasonCode) => diagnose?.({ boxId: Number.isSafeInteger(match?.row?.value?.boxId) ? match.row.value.boxId : null,
      state, reasonCode: diagnosticCode(reasonCode, 'ORDER_VIDEO_DIAGNOSTIC_UNAVAILABLE') });
    const beforeOrder = orderFlowerPlainRow(match.row), boxId = match.row.value.boxId, definition = ORDER_FLOWER_VIDEO_CONTRACTS[kind],
      occurrence = current.identities?.identities?.find(one => one.kind === kind && one.boxId === boxId);
    if (!occurrence?.identityKnown) { report('rejected', 'ORDER_VIDEO_OCCURRENCE_IDENTITY_UNKNOWN'); return null; }
    if (![true, 1].includes(beforeOrder.isVideo)) { report('skipped', 'ORDER_VIDEO_ROW_NOT_VIDEO'); return null; }
    const planned = videoPlan(current, kind, boxId);
    if (!planned) { report('rejected', categoryPlanReason(current, kind) || 'ORDER_VIDEO_STOCK_PLAN_MISSING'); return null; }
    if (!videoPlanReady(planned)) { report('rejected', planned.reasonCode || 'ORDER_VIDEO_STOCK_PLAN_NOT_READY'); return null; }
    const share = value(current.auxiliary.payload.videoShares?.[definition.shareId]), policy = orderFlowerVideoPolicy(kind, current.inventory?.versionEvidence),
      counters = rewardState(current)?.counters;
    if (current.open.video?.[kind]?.known !== true || current.open.video[kind].value !== true) { report('rejected', 'ORDER_VIDEO_OPEN_NOT_CONFIRMED'); return null; }
    if (!share) { report('rejected', 'ORDER_VIDEO_SHARE_UNKNOWN'); return null; }
    if (!policy.known) { report('rejected', 'ORDER_VIDEO_POLICY_UNKNOWN'); return null; }
    if ((share.uTime < current.day.startMs ? 0 : share.recvCnt) >= policy.limit) { report('rejected', 'ORDER_VIDEO_QUOTA_EXHAUSTED'); return null; }
    if (!Array.isArray(counters) || counters.length !== 4 || counters.some(one => !one || one.uid !== current.inventory.officialUid ||
      !exactSource({ known: true, source: one.source }, current))) { report('rejected', 'ORDER_VIDEO_COUNTER_SOURCE_MISMATCH'); return null; }
    if (!beforeOrder.videoRwd || !Object.values(beforeOrder.videoRwd).some(auxPositive)) { report('rejected', 'ORDER_VIDEO_REWARD_NOT_POSITIVE'); return null; }
    if (beforeOrder.cdTime !== null && beforeOrder.cdTime > current.clock.lowerBoundMs) { report('rejected', 'ORDER_VIDEO_COOLDOWN_ACTIVE'); return null; }
    const publicArgs = { shareId: definition.shareId, ext: kind === 'resident' ? { opType: 1, id: boxId } : { opType: 1 } },
      contentFingerprint = fingerprint(orderFlowerContent(kind, boxId, beforeOrder)), lifecycleRef = occurrence.lifecycleRef;
    const preparation = { ...common(current, kind), boxId, beforeOrder, contentFingerprint, occurrence: clone(occurrence), lifecycleRef,
      videoReward: clone(beforeOrder.videoRwd), targetFingerprint: fingerprint({ contentFingerprint, videoReward: beforeOrder.videoRwd }),
      beforeShare: value(current.auxiliary.payload.videoShares?.[definition.shareId]), beforeCounters: rewardState(current)?.counters ?? [],
      publicArgs: clone(publicArgs), adSlotTag: policy.tag, stockPlanning: videoPlanBasis(planned) };
    const proposal = base(current, definition, preparation, clone(publicArgs), 'flower-order-video:' + current.context.subjectRef + ':' + kind + ':' + boxId,
      'order-video:' + lifecycleRef, 'order-flower-video:' + lifecycleRef);
    // No external capability is consumed here. The shared admission stage
    // checks exact historical closure and current-need ownership before send.
    proposal.factBasis = basis(current, proposal);
    const card = evaluateOrderFlowerVideoCard({ context: current.context, officialUid: preparation.officialUid,
      card: value(current.auxiliary.payload.videoCard), clock: current.clock });
    if (card.valid) preparation.capability = card;
    else {
      preparation.wireArgsFingerprint = proposal.paramsFingerprint;
      const queued = videoRequestPreparation.readOrStart({ proposal });
      if (queued.state === 'completed') { report('eligible', 'ORDER_VIDEO_PREPARATION_COMPLETED'); return clone(queued.proposal); }
      // A current request preparation pauses this feature's ordinary fallback.
      report(queued.reasonCode === 'ORDER_VIDEO_REQUEST_PREPARATION_PENDING' ? 'waiting' : 'rejected', queued.reasonCode);
      return { videoRequestPreparationPending: queued.reasonCode === 'ORDER_VIDEO_REQUEST_PREPARATION_PENDING',
        videoRequestPreparationReasonCode: queued.reasonCode };
    }
    preparation.wireArgsFingerprint = proposal.paramsFingerprint;
    report('eligible', 'ORDER_VIDEO_CARD_CAPABILITY_READY');
    return proposal;
  }
  const lastReadiness = new Map();
  async function assess(kind, input, actionKey = null) {
    if (!KINDS.includes(kind)) throw new TypeError('Unknown order category');
    const current = state(input.context), key = current.context && fingerprint([current.context, kind]);
    const videoCandidates = [];
    const saveReadiness = (state, reasonCode, extra = {}) => {
      if (key) lastReadiness.set(key, { kind, state, reasonCode, ...extra, videoCandidates: videoCandidates.slice(0, 6) });
    };
    const addVideoDiagnostic = diagnostic => {
      if (videoCandidates.length < 6) videoCandidates.push(diagnostic);
      saveReadiness('waiting-facts', null);
    };
    const waiting = reasonCode => { saveReadiness('waiting-facts', reasonCode); return null; };
    if (actionKey && actionKey !== 'delivery') {
      const capability = sourceCapability(input.context);
      if (capability?.known === true && capability.supported === false)
        return waiting('ORDER_AUXILIARY_SOURCE_CONTRACT_UNSUPPORTED');
    }
    // Every assessment replaces the prior candidate list so readiness cannot
    // report stale boxes or reasons from another poll.
    saveReadiness('waiting-facts', current.reasonCode || 'ORDER_AUXILIARY_NOT_ASSESSED');
    if (current.reasonCode) {
      if (current.official?.snapshotRefresh?.required && typeof requestFreshLogin === 'function') {
        await requestFreshLogin({ context: current.context, snapshotRef: current.official.snapshotRefresh.snapshotRef, reasonCode: 'CUSTOMER_OFFICIAL_DAY_SNAPSHOT_EXPIRED' });
      }
      return waiting(current.reasonCode);
    }
    if (!enabled(current, kind)) return waiting('ORDER_AUXILIARY_CATEGORY_DISABLED');
    if (!currentOpen(current, kind)) return waiting(current.open?.[kind]?.reasonCode || 'ORDER_AUXILIARY_CATEGORY_NOT_OPEN');
    if (actionKey !== null) {
      const completed = completedOpportunityCap(current, actionKey, kind);
      if (completed) return completed;
      if (actionKey === 'video') {
        const videoCap = videoQuotaCap(current, kind);
        if (videoCap) return videoCap;
      }
    }
    const candidates = [];
    if (actionKey === null || actionKey === 'enter') candidates.push(enterProposal(current, kind));
    if ((actionKey === null || actionKey === 'stage-reward') && kind === 'resident')
      candidates.push(...[1, 2, 3, 4].map(target => rewardProposal(current, 'stage', target)));
    if ((actionKey === null || actionKey === 'achievement') && kind === 'resident') candidates.push(rewardProposal(current, 'achievement'));
    let blocked = null;
    for (const proposal of candidates.filter(Boolean)) {
      try {
        const claimError = attachCurrentNeed(proposal);
        if (claimError) { blocked ||= claimError; continue; }
        proposal.factBasis = readFactBasis({ proposal });
        const admission = evaluateAdmission({ proposal, actor: current.context, factBasis: proposal.factBasis, boundary: 'before-prepare' });
        if (admission.allowed) {
          for (const match of currentOrderFlowerRows(current.view).filter(one => one.row.value.kind === kind).slice(0, 6)) {
            addVideoDiagnostic({ boxId: Number.isSafeInteger(match.row.value.boxId) ? match.row.value.boxId : null,
              state: 'skipped', reasonCode: 'ORDER_VIDEO_SKIPPED_BY_HIGHER_PRIORITY_PROPOSAL' });
          }
          saveReadiness('proposals', null);
          return { state: 'proposals', proposals: [freeze(proposal)], factBasis: proposal.factBasis };
        }
        blocked ||= admission.reasonCode;
      } catch (error) { blocked ||= error.code || 'ORDER_AUXILIARY_PREPARATION_INCOMPLETE'; }
    }
    if (actionKey !== null && actionKey !== 'video') return waiting(blocked || 'ORDER_AUXILIARY_NO_CURRENT_ELIGIBLE_ACTION');
    const refreshDomains = new Set();
    for (const match of currentOrderFlowerRows(current.view).filter(one => one.row.value.kind === kind)) {
      if (![true, 1].includes(orderFlowerPlainRow(match.row).isVideo)) {
        addVideoDiagnostic({ boxId: Number.isSafeInteger(match.row.value.boxId) ? match.row.value.boxId : null,
          state: 'skipped', reasonCode: 'ORDER_VIDEO_ROW_NOT_VIDEO' });
        continue;
      }
      // A video work unit only asks for optional facts after the ordinary
      // board proves that a current video order exists. Missing facts then
      // trigger the shared bounded refresh path; an empty board stays quiet.
      const videoDefinition = ORDER_FLOWER_VIDEO_CONTRACTS[kind], share = current.auxiliary.payload.videoShares?.[videoDefinition.shareId],
        open = current.open?.video?.[kind], counters = rewardState(current)?.counters;
      if (open?.known !== true || !share) refreshDomains.add('order-flower-video-' + kind);
      if (!Array.isArray(counters) || counters.length !== 4 || counters.some(one => !one || one.uid !== current.inventory.officialUid ||
          !exactSource({ known: true, source: one.source }, current))) refreshDomains.add('order-flower-counter');
      if (!current.clock?.available || !Number.isFinite(current.day?.startMs)) refreshDomains.add('clock');
      if (refreshDomains.size) {
        addVideoDiagnostic({ boxId: Number.isSafeInteger(match.row.value.boxId) ? match.row.value.boxId : null,
          state: 'waiting', reasonCode: 'ORDER_VIDEO_OPTIONAL_FACTS_REQUIRED' });
        continue;
      }
      try {
        const proposal = videoProposal(current, kind, match, { diagnose: addVideoDiagnostic });
        if (!proposal) { blocked ||= 'ORDER_VIDEO_CURRENT_CARD6_OR_REQUEST_PROOF_REQUIRED'; continue; }
        if (Object.hasOwn(proposal, 'videoRequestPreparationPending')) {
          blocked ||= proposal.videoRequestPreparationReasonCode;
          if (!proposal.videoRequestPreparationPending) continue;
          const pending = { state: 'waiting-facts', reasonCode: proposal.videoRequestPreparationReasonCode, deviceDueMs: Date.now() + 30000 };
          saveReadiness(pending.state, pending.reasonCode, { deviceDueMs: pending.deviceDueMs });
          return pending;
        }
        const claimError = attachCurrentNeed(proposal);
        if (claimError) { blocked ||= claimError; continue; }
        proposal.factBasis = readFactBasis({ proposal });
        const admission = evaluateAdmission({ proposal, actor: current.context, factBasis: proposal.factBasis, boundary: 'before-prepare' });
        if (admission.allowed) {
          if (videoCandidates.length) videoCandidates[videoCandidates.length - 1] = { ...videoCandidates[videoCandidates.length - 1], state: 'eligible', reasonCode: 'ORDER_VIDEO_ADMISSION_ALLOWED' };
          saveReadiness('proposals', null);
          return { state: 'proposals', proposals: [freeze(proposal)], factBasis: proposal.factBasis };
        }
        if (videoCandidates.length) videoCandidates[videoCandidates.length - 1] = { ...videoCandidates[videoCandidates.length - 1], state: 'rejected',
          reasonCode: diagnosticCode(admission.reasonCode, 'ORDER_VIDEO_ADMISSION_BLOCKED') };
        blocked ||= admission.reasonCode;
      } catch (error) {
        const boxId = Number.isSafeInteger(match.row.value.boxId) ? match.row.value.boxId : null;
        if (videoCandidates.at(-1)?.boxId === boxId) videoCandidates[videoCandidates.length - 1] = { boxId, state: 'rejected',
          reasonCode: diagnosticCode(error?.code, 'ORDER_VIDEO_ASSESSMENT_ERROR') };
        else addVideoDiagnostic({ boxId, state: 'rejected', reasonCode: diagnosticCode(error?.code, 'ORDER_VIDEO_ASSESSMENT_ERROR') });
        saveReadiness('waiting-facts', null);
        blocked ||= error.code || 'ORDER_VIDEO_PREPARATION_INCOMPLETE';
      }
    }
    if (refreshDomains.size) {
      const domains = [...refreshDomains];
      const pending = { state: 'waiting-facts', reasonCode: 'ORDER_VIDEO_OPTIONAL_FACTS_REQUIRED',
        refreshReasonCode: 'ORDER_VIDEO_OPTIONAL_FACTS_REQUIRED', refreshDomains: domains,
        deviceDueMs: Date.now() + 30000 };
      saveReadiness(pending.state, pending.reasonCode, { deviceDueMs: pending.deviceDueMs, refreshDomains: domains });
      return pending;
    }
    return waiting(blocked || 'ORDER_AUXILIARY_NO_CURRENT_ELIGIBLE_ACTION');
  }
  function contractsFor(kind) {
    if (!KINDS.includes(kind)) throw new TypeError('Unknown order category');
    const entries = [[ORDER_FLOWER_ENTER_CONTRACTS[kind], verifiers.enter], [ORDER_FLOWER_VIDEO_CONTRACTS[kind], verifiers.video],
      ...(kind === 'resident' ? Object.values(ORDER_FLOWER_REWARD_CONTRACTS).map(definition => [definition, verifiers.reward]) : [])];
    return Object.freeze(Object.fromEntries(entries.map(([definition, verifier]) => [definition.method, Object.freeze({ ...definition,
      postRead: { ...ORDER_FLOWER_AUX_POST_READ, validateResponseCoverage: verifier.validateResponseCoverage }, validateTargetVerification: verifier.validateTargetVerification })])));
  }
  function consumeCurrentNeed({ proposal } = {}) {
    const currentNeed = proposal?.[fieldFor(proposal)]?.currentNeed;
    if (!currentNeed) return { accepted: false, reasonCode: 'ORDER_AUXILIARY_CURRENT_NEED_REQUIRED' };
    return sync(currentNeedReconciler.consumeCurrentNeed({ claimRef: currentNeed.claimRef, operationId: proposal.operationId,
      decisionGeneration: currentNeed.decisionGeneration, currentNeed, featureId: proposal.featureId }));
  }
  function readiness(context) {
    const actual = orderFlowerContext(context), current = state(actual);
    const videoStatus = typeof videoRequestProvider?.status === 'function' ? sync(videoRequestProvider.status(actual)) :
      { available: false, state: 'unavailable', inFlight: false, terminal: true };
    return freeze({ version: VERSION, context: actual, current: !current.reasonCode, reasonCode: current.reasonCode,
      videoRequest: { requestPortAvailable: videoRequestProvider?.supportsLegacyApiRequest === true &&
          typeof videoRequestProvider?.complete === 'function' && typeof videoRequestProvider?.validateCapability === 'function' &&
          videoRequestProvider.validateCapability.constructor?.name !== 'AsyncFunction',
        status: videoStatus, syntheticTokensPermitted: false },
      videoRequestPreparationCapacity: typeof videoRequestPreparation.status === 'function' ? videoRequestPreparation.status(actual) : null,
      categories: KINDS.map(kind => lastReadiness.get(fingerprint([actual, kind])) ?? { kind, state: 'waiting-facts',
        reasonCode: current.reasonCode || 'ORDER_AUXILIARY_NOT_ASSESSED', videoCandidates: [] }) });
  }
  function onSettled(event) {
    if (!handles(event.proposal)) return;
    if (event.proposal.orderFlowerVideo) videoRequestProvider?.onSettled?.(event);
    appendOutbox({ ownerRef: event.proposal.ownerRef, subjectRef: event.proposal.subjectRef, eventType: 'FlowerOrderAuxiliaryOperationAudited',
      eventKey: event.proposal.operationId, payload: { operationId: event.proposal.operationId, method: event.proposal.method,
        verdict: event.verification.verdict, originalSemanticRetained: true } });
  }
  function handles(proposal) {
    const definition = definitionFor(proposal);
    return !!fieldFor(proposal) && !!definition && proposal.featureId === definition.featureId && proposal.method === definition.method && proposal.scope === definition.scope;
  }
  return Object.freeze({ assess, readFactBasis, evaluateAdmission, contractsFor, handles, onSettled, readiness, sourceCapability,
    consumeCurrentNeed,
    verify: input => verifierFor(input.proposal).verify(input), onCurrentVerified: () => {},
    stop: context => videoRequestPreparation.stop(context),
    shutdown: () => { videoRequestPreparation.shutdown(); videoRequestProvider?.shutdown?.(); } });
}
