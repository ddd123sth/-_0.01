import { canonical, fingerprint, freeze, newId } from '../../common.mjs';
import { FREE_WATER_CONTRACT_REF, FREE_WATER_DEFINITIONS, FREE_WATER_METHODS, FREE_WATER_SCOPES,
  FREE_WATER_POST_READ, assertFreeWaterProposal, freeWaterTargetVerification } from './rpc-contract.mjs';

const VERSION = 'free-water/1';
const knownNumber = cell => cell?.presence === 'present' && cell.state === 'known' && Number.isSafeInteger(cell.value) && cell.value >= 0;
const AXES = ['ownerRef','accountRef','subjectRef','ownerEpoch','runEpoch','connectionEpoch'];
const exactContext = context => context && AXES.every(key => key === 'accountRef' ? typeof context[key] === 'string' :
  Number.isSafeInteger(context[key]) || typeof context[key] === 'string');
const operationContract = definition => Object.freeze({ ...definition, postRead: FREE_WATER_POST_READ,
  validateTargetVerification: freeWaterTargetVerification });

export function createFreeWaterRuntime({ store, facts, extensionForContext, clock, officialDay, dynamicState, ledgerView, resources,
  isCurrent, readConfiguration, openEligibility, videoOpenEligibility, appendOutbox = () => {} } = {}) {
  for (const fn of [store?.run, store?.get, store?.transaction, facts?.read, extensionForContext, clock, officialDay,
    dynamicState?.snapshot, ledgerView?.currentAdmission, resources?.balance, resources?.matchedItemFlow, isCurrent, readConfiguration, openEligibility])
    if (typeof fn !== 'function') throw new TypeError('Free-water runtime is missing a bounded shared port');
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_free_water_claims(
    owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,day_key TEXT NOT NULL,idx INTEGER NOT NULL CHECK(idx IN (0,1)),
    state TEXT NOT NULL,operation_id TEXT NOT NULL,updated_at TEXT NOT NULL,
    PRIMARY KEY(owner_ref,subject_ref,day_key,idx));
    CREATE TRIGGER IF NOT EXISTS backend_free_water_claims_no_delete BEFORE DELETE ON backend_free_water_claims
      BEGIN SELECT RAISE(ABORT,'free-water claim history is retained'); END;`);
  const { get, run, transaction, nowIso } = store;
  const methodScopes = Object.freeze(Object.fromEntries(Object.entries(FREE_WATER_METHODS).map(([kind, method]) => [method, FREE_WATER_SCOPES[kind]])));
  const operationContracts = Object.freeze(Object.fromEntries(Object.entries(FREE_WATER_DEFINITIONS).map(([kind, definition]) =>
    [definition.method, operationContract(definition)])));
  const clockFor = context => {
    const value = clock(context.subjectRef);
    return value?.available === true && value.connectionEpoch === context.connectionEpoch &&
      Number.isSafeInteger(value.lowerBoundMs) && Number.isSafeInteger(value.upperBoundMs) && value.lowerBoundMs <= value.upperBoundMs ? value : null;
  };
  const dayFor = context => {
    const day = officialDay(context);
    return day?.current === true && typeof day.key === 'string' && Number.isSafeInteger(day.startMs) && Number.isSafeInteger(day.endMs) &&
      day.startMs < day.endMs && typeof day.proofRef === 'string' ? day : null;
  };
  function stateFor(context) {
    const currentFacts = facts.read(context), extension = extensionForContext(context), day = dayFor(context);
    if (currentFacts?.current !== true || !extension || !day || day.proofRef !== extension.loginResponseRef || extension.loginResponseRef !== currentFacts.sources?.water?.responseRef &&
        extension.loginResponseRef !== currentFacts.sources?.share13?.responseRef) return null;
    const water = currentFacts.value?.water, uid = water?.uid ?? currentFacts.value?.share13?.uid;
    if (!Number.isSafeInteger(uid) || uid <= 0 || !Array.isArray(water?.recvIdx) || !water.recvIdx.every(idx => idx === 0 || idx === 1)) return null;
    const clockState = clockFor(context);
    if (!clockState) return null;
    const received = Object.hasOwn(water, 'rTime') && water.rTime === null ? [] :
      !Object.hasOwn(water, 'rTime') ? null : water.rTime < day.startMs ? [] :
        water.rTime >= day.startMs && water.rTime < day.endMs ? water.recvIdx : null;
    if (received === null) return null;
    const share = currentFacts.value.share13;
    const effectiveShareCount = share && Number.isSafeInteger(share.recvCnt) && Number.isSafeInteger(share.uTime)
      ? share.uTime < day.startMs ? 0 : share.uTime >= day.startMs && share.uTime < day.endMs ? share.recvCnt : null : null;
    return { facts: currentFacts, extension, day, clock: clockState, water, uid, received: [...received], share,
      shareCount: effectiveShareCount };
  }
  function currentWindow(state, idx) {
    const [startHour, endHour] = state.extension.rules.windows[idx], startMs = state.day.startMs + startHour * 3600000,
      endMs = state.day.startMs + endHour * 3600000;
    return { startMs, endMs, nowIn: state.clock.lowerBoundMs > startMs && state.clock.upperBoundMs < endMs,
      certainlyBefore: state.clock.upperBoundMs <= startMs, certainlyAfter: state.clock.lowerBoundMs > endMs };
  }
  function readFactBasis({ proposal, actor }) {
    if (!isCurrent(actor)) return { current: false, reasonCode: 'FREE_WATER_CONTEXT_NOT_CURRENT' };
    const state = stateFor(actor);
    if (!state) return { current: false, reasonCode: 'FREE_WATER_CURRENT_FACTS_REQUIRED' };
    const config = readConfiguration(actor), snapshot = dynamicState.snapshot({ context: actor, feature, config,
      method: proposal?.method, proposal });
    if (snapshot?.current !== true) return { current: false, reasonCode: snapshot?.reasonCode || 'FREE_WATER_DYNAMIC_FACTS_NOT_CURRENT' };
    const domains = snapshot.domains.map(domain => Object.fromEntries(['domainId','current','semanticRevision','semanticFingerprint','sourceRef',
      'sourceKind','method','requestSequence','observedAtMs','coverage','sourceProofs','dirty','reasonCode'].map(key => [key, domain[key]])));
    return freeze({ current: true, fingerprint: fingerprint({ context: Object.fromEntries(AXES.map(key => [key, actor[key]])),
      extensionRef: state.extension.extensionRef, dayKey: state.day.key, dayProofRef: state.day.proofRef,
      waterSource: state.facts.sources.water || null, shareSource: state.facts.sources.share13 || null,
      factsFingerprint: state.facts.fingerprint, domains, proposal: proposal?.freeWater || null }) });
  }
  function evaluateAdmission({ proposal, actor, factBasis: suppliedBasis, boundary, ownReservation } = {}) {
    if (!proposal || !actor || !isCurrent(actor)) return { allowed: false, reasonCode: 'FREE_WATER_CONTEXT_NOT_CURRENT' };
    const open = openEligibility(actor), state = stateFor(actor), basis = readFactBasis({ proposal, actor });
    if (open?.known !== true || open.value !== true) return { allowed: false, historicalConstraintsChecked: true,
      currentInFlightChecked: true, reasonCode: open?.reasonCode || 'FREE_WATER_OPEN_NOT_PROVEN' };
    if (proposal.freeWater.kind === 'share') {
      const videoOpen = state && videoOpenEligibility?.(actor, state.extension.rules.openId);
      if (videoOpen?.known !== true || videoOpen.value !== true) return { allowed: false, historicalConstraintsChecked: true,
        currentInFlightChecked: true, reasonCode: videoOpen?.reasonCode || 'FREE_WATER_VIDEO_OPEN_NOT_PROVEN' };
    }
    if (!state || !basis.current || suppliedBasis?.fingerprint !== basis.fingerprint ||
        state.extension.extensionRef !== proposal.freeWater.extensionRef || state.day.key !== proposal.freeWater.dayKey ||
        state.facts.sources.water?.responseRef !== proposal.freeWater.sourceRef || state.uid !== proposal.freeWater.uid)
      return { allowed: false, reasonCode: 'FREE_WATER_FACTS_SUPERSEDED' };
    const idx = proposal.freeWater.idx, kind = proposal.freeWater.kind, period = currentWindow(state, idx);
    if (kind === 'receive' && !period.nowIn || kind === 'share' &&
        (!period.certainlyAfter || state.shareCount === null || state.shareCount >= state.extension.rules.dailyVideoLimit))
      return { allowed: false, historicalConstraintsChecked: true, currentInFlightChecked: true, reasonCode: 'FREE_WATER_WINDOW_OR_LIMIT_CHANGED' };
    const priorClaim = get('SELECT state FROM backend_free_water_claims WHERE owner_ref=? AND subject_ref=? AND day_key=? AND idx=?',
      actor.ownerRef, actor.subjectRef, state.day.key, idx);
    if (priorClaim?.state === 'confirmed' || state.received.includes(idx))
      return { allowed: false, historicalConstraintsChecked: true, currentInFlightChecked: true, reasonCode: 'FREE_WATER_TARGET_ALREADY_CLAIMED' };
    if (priorClaim?.state?.startsWith('unknown-held'))
      return { allowed: false, historicalConstraintsChecked: true, currentInFlightChecked: true, reasonCode: 'FREE_WATER_TARGET_UNRESOLVED' };
    const admission = ledgerView.currentAdmission({ ownerRef: actor.ownerRef, subjectRef: actor.subjectRef,
      targetRefs: proposal.targets.map(target => target.targetRef), featureIds: ['free-water'] });
    const own = boundary === 'before-send' && ownReservation?.operationId === proposal.operationId ? proposal.operationId : null;
    if (!admission || admission.activeOperation && admission.activeOperation.operation_id !== own)
      return { allowed: false, historicalConstraintsChecked: true, currentInFlightChecked: true, reasonCode: 'FREE_WATER_ACTIVE_OPERATION' };
    for (const row of admission.unresolvedOperations || []) if (row.operation_id !== own) {
      const prior = ledgerView.operation?.(row.operation_id);
      if (prior?.targets?.some(target => (target.target_ref ?? target.original?.targetRef) === proposal.targets[0].targetRef))
        return { allowed: false, historicalConstraintsChecked: true, currentInFlightChecked: true, reasonCode: 'FREE_WATER_TARGET_UNRESOLVED' };
    }
    return { allowed: true, targetsCurrent: true, resourcesCurrent: true, historicalConstraintsChecked: true, currentInFlightChecked: true, reasonCode: null };
  }
  function makeProposal(input, state, idx, kind) {
    const method = FREE_WATER_METHODS[kind], params = kind === 'receive' ? { idx } : { shareId: 13, ext: { opType: 1, id: idx } };
    const targetRef = `free-water:${input.context.subjectRef}:${state.day.key}:${idx}`;
    const sourceRef = state.facts.sources.water?.responseRef;
    const target = { memberKey: 'free-water:' + fingerprint([state.day.key, idx]), targetKind: 'free-water', targetRef,
      lifecycleRef: state.day.key, targetFingerprint: fingerprint({ targetRef, sourceRef, extensionRef: state.extension.extensionRef }) };
    const balance = resources.balance({ context: input.context, itemId: 7 });
    const period = currentWindow(state, idx);
    const proposal = { ...input.context, operationId: newId(), proposalId: newId(), featureId: 'free-water', scope: FREE_WATER_SCOPES[kind], method,
      params, paramsFingerprint: fingerprint(params), configRevision: input.config.savedRevision,
      featureCancelEpoch: input.config.featureCancelEpochs['free-water'], semanticKey: `free-water:${state.day.key}:${kind}:${idx}`,
      targets: [target], resources: [], resourceBindings: [], contractRef: FREE_WATER_CONTRACT_REF,
      freeWater: { kind, idx, uid: state.uid, dayKey: state.day.key, dayProofRef: state.day.proofRef,
        windowStartMs: period.startMs, windowEndMs: period.endMs, extensionRef: state.extension.extensionRef,
        extension: state.extension, sourcePin: state.extension.sourcePin, bundleRef: state.extension.bundleRef,
        loginResponseRef: state.extension.loginResponseRef, sourceRef, sourceFingerprint: state.facts.fingerprint,
        factSnapshot: { value: state.facts.value, sources: state.facts.sources, fingerprint: state.facts.fingerprint },
        sourceMethod: state.facts.sources.water?.method || null,
        receivedBefore: [...state.received], shareBefore: state.share ? { ...state.share, effectiveRecvCnt: state.shareCount } : null,
        item7: balance?.base?.known === true ? balance.base.value : null,
        item7Source: balance?.base?.source || null, item7BasisRef: balance?.base?.basisRef || null,
        item7Effective: balance?.effective ? { known: balance.effective.known === true, lowerBound: balance.effective.lowerBound ?? null,
          upperBound: balance.effective.upperBound ?? null, anchorMs: balance.effective.anchorMs ?? null,
          clockRevision: balance.effective.clockRevision ?? null, nextIncreaseOfficialMs: balance.effective.nextIncreaseOfficialMs ?? null } : null } };
    proposal.factBasis = readFactBasis({ proposal, actor: input.context });
    return proposal;
  }
  function assess(input) {
    if (input.config?.config?.freeWaterEnabled !== true) return { state: 'disabled', reasonCode: 'FREE_WATER_DISABLED' };
    if (!isCurrent(input.context) || !exactContext(input.context)) return { state: 'blocked', reasonCode: 'FREE_WATER_CONTEXT_NOT_CURRENT' };
    const open = openEligibility(input.context);
    if (open?.known !== true || open.value !== true) return { state: 'waiting-facts', reasonCode: open?.reasonCode || 'FREE_WATER_OPEN_NOT_PROVEN', deviceDueMs: Date.now() + 30000 };
    const state = stateFor(input.context);
    if (!state) return { state: 'waiting-facts', reasonCode: 'FREE_WATER_CURRENT_FACTS_REQUIRED', deviceDueMs: Date.now() + 30000 };
    if (!state.extension.rules.ordinarySupported) return { state: 'waiting-facts', reasonCode: 'FREE_WATER_ORDINARY_RULE_UNSUPPORTED', deviceDueMs: Date.now() + 30000 };
    const balance = resources.balance({ context: input.context, itemId: 7 });
    if (balance?.base?.known !== true || !Number.isSafeInteger(balance.base.value) || balance.base.source?.connectionEpoch !== input.context.connectionEpoch ||
        balance.effective?.known !== true || !Number.isSafeInteger(balance.effective.lowerBound) || balance.effective.lowerBound !== balance.effective.upperBound)
      return { state: 'waiting-facts', reasonCode: 'FREE_WATER_ITEM7_BALANCE_NOT_CURRENT', deviceDueMs: Date.now() + 15000 };
    let waitingReason = null;
    for (let idx = 0; idx < 2; idx += 1) {
      if (state.received.includes(idx)) continue;
      const claim = get('SELECT state FROM backend_free_water_claims WHERE owner_ref=? AND subject_ref=? AND day_key=? AND idx=?',
        input.context.ownerRef, input.context.subjectRef, state.day.key, idx);
      if (claim?.state === 'confirmed') continue;
      if (claim?.state?.startsWith('unknown-held')) { waitingReason ||= 'FREE_WATER_PRIOR_UNKNOWN_REQUIRES_RECONCILIATION'; continue; }
      const period = currentWindow(state, idx);
      if (period.nowIn) return { state: 'proposals', proposals: [freeze(makeProposal(input, state, idx, 'receive'))], reasonCode: null };
      if (period.certainlyBefore) return { state: 'waiting-until', reasonCode: 'FREE_WATER_WINDOW_NOT_OPEN', officialDueMs: period.startMs,
        deviceDueMs: Date.now() + Math.max(1000, period.startMs - state.clock.upperBoundMs) };
      if (period.certainlyAfter) {
        if (!state.extension.rules.videoSupported) continue;
        const videoOpen = videoOpenEligibility?.(input.context, state.extension.rules.openId);
        if (videoOpen?.known !== true || videoOpen.value !== true) { waitingReason ||= videoOpen?.reasonCode || 'FREE_WATER_VIDEO_OPEN_NOT_PROVEN'; continue; }
        if (!state.share || !Number.isSafeInteger(state.shareCount)) return { state: 'waiting-facts', reasonCode: 'FREE_WATER_SHARE13_NOT_CURRENT',
          refreshDomains: ['free-water-share'], refreshReasonCode: 'FREE_WATER_SHARE13_NOT_CURRENT', deviceDueMs: Date.now() + 15000 };
        if (state.shareCount < state.extension.rules.dailyVideoLimit) return { state: 'proposals', proposals: [freeze(makeProposal(input, state, idx, 'share'))], reasonCode: null };
        continue;
      }
      waitingReason ||= 'FREE_WATER_CLOCK_WINDOW_UNCERTAIN';
    }
    if (waitingReason) return { state: 'waiting-facts', reasonCode: waitingReason, deviceDueMs: Date.now() + 15000 };
    const next = state.day.endMs;
    return { state: 'waiting-until', reasonCode: 'FREE_WATER_DAILY_SLOTS_COMPLETE', officialDueMs: next,
      deviceDueMs: Date.now() + Math.max(1000, next - state.clock.upperBoundMs) };
  }
  async function verify({ proposal, response, connection, signal } = {}) {
    const unknown = reasonCode => ({ verdict: 'unknown', reasonCode, verificationVersion: 'free-water/target-postread/v1',
      evidence: { targetRef: proposal?.targets?.[0]?.targetRef || null, extensionRef: proposal?.freeWater?.extensionRef || null, reasonCode },
      resourceResolutions: [] });
    let bridge;
    try { bridge = await connection.readSnapshotAfterClose(); } catch (error) {
      return unknown(typeof error?.code === 'string' ? error.code : 'FREE_WATER_POSTREAD_FAILED');
    }
    signal?.throwIfAborted?.();
    const post = bridge?.newLoginObservation;
    if (!bridge || bridge.operationId !== proposal.operationId || bridge.oldPhysicalCloseReceipt?.closed !== true ||
        post?.method !== 'index.login' || post.source !== 'response' || post.transport !== 'answered' || post.envelopeOk !== true ||
        post.dsName !== 'G.ISyncData' || bridge.officialUid !== proposal.freeWater.uid)
      return unknown('FREE_WATER_POSTREAD_MISSING');
    const after = facts.read(bridge.newContext), postState = stateFor(bridge.newContext), postExtension = extensionForContext(bridge.newContext), newDay = dayFor(bridge.newContext);
    const body = postExtension && Object.fromEntries(Object.entries(postExtension).filter(([key]) => key !== 'extensionRef'));
    if (!postExtension || !body || postExtension.extensionRef !== 'sha256:' + fingerprint(body) ||
        postExtension.loginResponseRef !== post.responseRef || postExtension.sourcePin !== proposal.freeWater.sourcePin ||
        postExtension.sourceProof?.matchedRanges?.length !== 13 || !newDay || newDay.proofRef !== post.responseRef || newDay.key !== proposal.freeWater.dayKey ||
        after?.current !== true || after.value?.water?.uid !== proposal.freeWater.uid || !Array.isArray(after.value.water.recvIdx) ||
        after.sources?.water?.responseRef !== post.responseRef || (proposal.freeWater.kind === 'share' &&
          after.sources?.share13?.responseRef !== post.responseRef) || !postState)
      return unknown('FREE_WATER_POSTREAD_FACTS_NOT_CURRENT');
    const flow = resources.matchedItemFlow({ context: proposal,
      source: { responseRef: response?.responseRef, wireKey: response?.wireKey, requestSequence: response?.requestSequence,
        connectionEpoch: response?.connectionEpoch }, method: proposal.method, itemId: 7 });
    const gain = flow?.bi?.presence === 'present' && flow.bi.state === 'known' ? flow.bi.value : null;
    const balance = resources.balance({ context: bridge.newContext, itemId: 7 }), postSource = balance?.base?.source;
    const afterAbsolute = balance?.base?.known === true && postSource?.responseRef === post.responseRef &&
      postSource?.connectionEpoch === bridge.newContext.connectionEpoch && postSource?.requestSequence === post.requestSequence ? balance.base.value : null;
    const beforeEffective = proposal.freeWater.item7Effective, afterEffective = balance?.effective;
    const effectiveDelta = beforeEffective?.known === true && beforeEffective.lowerBound === beforeEffective.upperBound &&
      afterEffective?.known === true && afterEffective.lowerBound === afterEffective.upperBound
      ? afterEffective.lowerBound - beforeEffective.lowerBound : null;
    const beforeAbsolute = proposal.freeWater.item7;
    const delta = Number.isSafeInteger(beforeAbsolute) && Number.isSafeInteger(afterAbsolute) ? afterAbsolute - beforeAbsolute : null;
    // matchedItemFlow only returns after it has reloaded the accepted frame and
    // rechecked both the immutable item-frame and land-observation hashes.
    // observationRef is the land observation key, not the RPC responseRef.
    const exactFlow = flow?.method === proposal.method && flow?.responseRef === response?.responseRef &&
      typeof flow?.frameFingerprint === 'string' && flow.frameFingerprint.length === 64 &&
      flow?.requestSequence === response?.requestSequence && flow?.connectionEpoch === response?.connectionEpoch && flow?.wireKey === response?.wireKey;
    const postReceived = postState.received;
    const ordinaryState = Array.isArray(postReceived) && (proposal.freeWater.kind !== 'receive' || postReceived.includes(proposal.freeWater.idx));
    let shareAdvanced = true;
    if (proposal.freeWater.kind === 'share') {
      const share = after.value.share13, old = proposal.freeWater.shareBefore;
      const postShareCount = postState.shareCount;
      shareAdvanced = !!share && !!old && share.uid === proposal.freeWater.uid && Number.isSafeInteger(old.effectiveRecvCnt) &&
        Number.isSafeInteger(postShareCount) && postShareCount === old.effectiveRecvCnt + 1 && Array.isArray(postReceived) &&
        postReceived.includes(proposal.freeWater.idx);
    }
    const debit = flow?.bo?.presence === 'present' && flow.bo.state === 'known' && Number.isSafeInteger(flow.bo.value) ? flow.bo.value :
      flow?.boCoverage?.presence === 'present' && flow.boCoverage.state === 'known' && flow.boCoverage.item7Present === false ? 0 :
        flow?.boCoverage?.presence === 'missing' && flow.boCoverage.state === 'unobserved' ? 0 : null;
    const absoluteFlow = flow?.bd?.presence === 'present' && flow.bd.state === 'known' && Number.isSafeInteger(flow.bd.value)
      ? flow.bd.value === afterAbsolute : flow?.bdCoverage?.presence === 'missing' && flow.bdCoverage.state === 'unobserved' ||
        flow?.bdCoverage?.presence === 'present' && flow.bdCoverage.state === 'known' && flow.bdCoverage.item7Present === false;
    const confirmed = exactFlow && Number.isSafeInteger(gain) && gain > 0 && debit === 0 && Number.isSafeInteger(delta) && delta === gain &&
      effectiveDelta === gain && absoluteFlow && ordinaryState && shareAdvanced;
    if (!confirmed) return unknown('FREE_WATER_EFFECT_UNPROVEN');
    return { verdict: 'confirmed', verificationVersion: 'free-water/target-postread/v1', postReadRef: post.responseRef, resourceResolutions: [], evidence: {
      targetRef: proposal.targets[0].targetRef, extensionRef: proposal.freeWater.extensionRef, dayKey: proposal.freeWater.dayKey,
      postReadRef: post.responseRef, postReadRequestSequence: post.requestSequence, postReadConnectionEpoch: post.connectionEpoch,
      writeResponseRef: response.responseRef, item7Before: beforeAbsolute, item7After: afterAbsolute, item7Gain: gain,
      item7EffectiveDelta: effectiveDelta, receivedIndices: after.value.water.recvIdx,
      share13After: proposal.freeWater.kind === 'share' ? after.value.share13 : null,
      postExtension, postSources: after.sources, officialDay: newDay,
      writeItem7Flow: flow ? { method: flow.method, responseRef: flow.responseRef, requestSequence: flow.requestSequence,
        connectionEpoch: flow.connectionEpoch, wireKey: flow.wireKey, observationRef: flow.observationRef,
        bi: flow.bi, bo: flow.bo, bd: flow.bd, boCoverage: flow.boCoverage, bdCoverage: flow.bdCoverage,
        frameFingerprint: flow.frameFingerprint } : null,
      officialDayProofRef: newDay.proofRef, bridgeFingerprint: bridge.bridgeFingerprint } };
  }
  function onSettled({ proposal, operation, verification } = {}) {
    const free = proposal.freeWater;
    if (verification?.verdict === 'confirmed') transaction(() => run(`INSERT INTO backend_free_water_claims(owner_ref,subject_ref,day_key,idx,state,operation_id,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref,day_key,idx) DO UPDATE SET state=excluded.state,operation_id=excluded.operation_id,updated_at=excluded.updated_at`,
      proposal.ownerRef, proposal.subjectRef, free.dayKey, free.idx, 'confirmed', proposal.operationId, nowIso()));
    else if (verification?.verdict === 'unknown' && operation?.transport_state !== 'not_sent') transaction(() => run(`INSERT OR IGNORE INTO backend_free_water_claims
      (owner_ref,subject_ref,day_key,idx,state,operation_id,updated_at) VALUES(?,?,?,?,?,?,?)`, proposal.ownerRef, proposal.subjectRef,
      free.dayKey, free.idx, 'unknown-held', proposal.operationId, nowIso()));
    appendOutbox({ ownerRef: proposal.ownerRef, subjectRef: proposal.subjectRef, eventType: 'FeatureSettlement',
      eventKey: 'free-water-settlement:' + proposal.operationId, payload: { operationId: operation?.operation_id || proposal.operationId,
        featureId: 'free-water', verdict: verification?.verdict || 'unknown', reasonCode: verification?.reasonCode || null,
        runEpoch: proposal.runEpoch, connectionEpoch: proposal.connectionEpoch, method: proposal.method } });
    return { visibility: 'current' };
  }
  const feature = Object.freeze({ featureId: 'free-water', consumedDomains: ['free-water','free-water-share','free-water-item','customer-day','customer-eligibility','profile','clock'],
    consumedDomainsFor: ({ method, proposal } = {}) => method === 'usr.share' || proposal?.freeWater?.kind === 'share'
      ? ['free-water','free-water-share','free-water-item','customer-day','customer-eligibility','profile','clock']
      : ['free-water','free-water-item','customer-day','customer-eligibility','profile','clock'],
    scopes: Object.values(FREE_WATER_SCOPES), methods: Object.values(FREE_WATER_METHODS), methodScopes,
    operationContracts, operationContract: null, release: 'validation-only', implementationVersion: VERSION,
    contractRef: FREE_WATER_CONTRACT_REF, factDomains: ['free-water','free-water-share'], resourceKinds: ['item'],
    scheduleUnits: Object.freeze([{ scheduleKey: 'free-water:claim', wakeKey: 'free-water:claim', assess }]),
    assess, qualify: evaluateAdmission, verify, readFactBasis, evaluateAdmission, onSettled, onCurrentVerified: () => {} });
  return Object.freeze({ feature, readFactBasis, evaluateAdmission, onSettled, assess });
}
