import { canonical, clone, fingerprint, freeze, newId, problem } from '../../common.mjs';
import { WATERWHEEL_CONTRACT_REF, WATERWHEEL_DEFINITIONS, WATERWHEEL_METHODS, WATERWHEEL_SCOPES,
  WATERWHEEL_POST_READ, waterwheelResponseCoverage, waterwheelTargetVerification } from './rpc-contract.mjs';
import { WATERWHEEL_EXTENSION_ID, WATERWHEEL_SOURCE_PIN } from '../../official-waterwheel-extension.mjs';
import { officialDateMs } from '../land/wire-facts.mjs';
import { createWaterwheelAnchorRetirement } from './anchor-retirement.mjs';

const IMPLEMENTATION = 'waterwheel/1';
const knownCell = cell => cell?.presence === 'present' && cell.state === 'known' && Number.isSafeInteger(cell.value) && cell.value >= 0;
const exactContext = context => context && ['ownerRef','accountRef','subjectRef','ownerEpoch','runEpoch','connectionEpoch']
  .every(key => key === 'accountRef' ? typeof context[key] === 'string' : Number.isSafeInteger(context[key]) || typeof context[key] === 'string');
const currentOperationContract = definition => Object.freeze({ ...definition, postRead: WATERWHEEL_POST_READ,
  validateTargetVerification: waterwheelTargetVerification });

export function createWaterwheelRuntime({ store, facts, extensionForContext, readEnter, clock, officialDay, dynamicState, ledgerView,
  resources, isCurrent, readConfiguration, openEligibility, appendOutbox = () => {} } = {}) {
  for (const fn of [store?.run, store?.get, store?.transaction, facts?.read, extensionForContext, readEnter, clock,
    dynamicState?.snapshot, ledgerView?.currentAdmission, resources?.matchedItemFlow, isCurrent, readConfiguration, openEligibility]) {
    if (typeof fn !== 'function') throw new TypeError('Waterwheel runtime is missing a bounded shared port');
  }
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_waterwheel_generation(
    owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,
    connection_epoch INTEGER NOT NULL,login_response_ref TEXT NOT NULL,enter_response_ref TEXT NOT NULL,extension_ref TEXT NOT NULL,uid INTEGER NOT NULL,
    period_key TEXT NOT NULL,cycle_number INTEGER NOT NULL,last_server_count INTEGER NOT NULL,
    started_at_ms INTEGER NOT NULL,baseline_offline_num INTEGER NOT NULL,offline_growth_baseline INTEGER NOT NULL,calc_time_ms INTEGER,hire_period_key TEXT,
    offline_claimed INTEGER NOT NULL,produced INTEGER NOT NULL,produced_claimed INTEGER NOT NULL,paused INTEGER NOT NULL DEFAULT 0,
    next_due_ms INTEGER NOT NULL,generation_ref TEXT NOT NULL UNIQUE,
    updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref,uid,generation_ref));
    CREATE TRIGGER IF NOT EXISTS backend_waterwheel_generation_no_delete BEFORE DELETE ON backend_waterwheel_generation
      BEGIN SELECT RAISE(ABORT,'waterwheel generation history is retained'); END;
    CREATE TABLE IF NOT EXISTS backend_waterwheel_claim_heads(
      owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,generation_ref TEXT NOT NULL,server_count INTEGER NOT NULL,slot INTEGER NOT NULL,
      state TEXT NOT NULL,operation_id TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref,generation_ref,server_count,slot));
    CREATE TABLE IF NOT EXISTS backend_waterwheel_settlement_receipts(
      operation_id TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,verdict TEXT NOT NULL,recorded_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS backend_waterwheel_held_retirements(
      retirement_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,uid INTEGER NOT NULL,
      generation_ref TEXT NOT NULL,prior_generation_ref TEXT NOT NULL,server_count INTEGER NOT NULL,slot INTEGER NOT NULL,
      claim_state TEXT NOT NULL,claim_operation_id TEXT NOT NULL,reason_code TEXT NOT NULL,evidence_ref TEXT NOT NULL,recorded_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS backend_waterwheel_held_retirements_no_update BEFORE UPDATE ON backend_waterwheel_held_retirements
      BEGIN SELECT RAISE(ABORT,'waterwheel held retirements are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_waterwheel_held_retirements_no_delete BEFORE DELETE ON backend_waterwheel_held_retirements
      BEGIN SELECT RAISE(ABORT,'waterwheel held retirements are retained'); END;
    CREATE TABLE IF NOT EXISTS backend_waterwheel_enter_anchors(
      response_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,request_sequence INTEGER NOT NULL,
      login_response_ref TEXT NOT NULL,bundle_ref TEXT NOT NULL,base_snapshot_id TEXT NOT NULL,extension_ref TEXT NOT NULL,
      uid INTEGER NOT NULL,baseline_response_ref TEXT NOT NULL,baseline_fingerprint TEXT NOT NULL,baseline_sequence INTEGER NOT NULL,
      clock_fingerprint TEXT NOT NULL,clock_evidence_json TEXT NOT NULL,clock_lower_ms INTEGER NOT NULL,clock_upper_ms INTEGER NOT NULL,
      received_device_ms INTEGER NOT NULL,recorded_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS backend_waterwheel_enter_anchors_no_update BEFORE UPDATE ON backend_waterwheel_enter_anchors
      BEGIN SELECT RAISE(ABORT,'waterwheel enter anchors are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_waterwheel_enter_anchors_no_delete BEFORE DELETE ON backend_waterwheel_enter_anchors
      BEGIN SELECT RAISE(ABORT,'waterwheel enter anchors are append only'); END;`);
  const { get, run, transaction, nowIso } = store;
  if (!store.all('PRAGMA table_info(backend_waterwheel_generation)').some(column => column.name === 'baseline_server_offline_num'))
    store.db.exec('ALTER TABLE backend_waterwheel_generation ADD COLUMN baseline_server_offline_num INTEGER NOT NULL DEFAULT 0');
  if (!store.all('PRAGMA table_info(backend_waterwheel_enter_anchors)').some(column => column.name === 'received_device_ms'))
    store.db.exec('ALTER TABLE backend_waterwheel_enter_anchors ADD COLUMN received_device_ms INTEGER NOT NULL DEFAULT 0');
  if (!store.all('PRAGMA table_info(backend_waterwheel_enter_anchors)').some(column => column.name === 'clock_evidence_json'))
    store.db.exec("ALTER TABLE backend_waterwheel_enter_anchors ADD COLUMN clock_evidence_json TEXT NOT NULL DEFAULT '{}'");
  const anchorRetirement = createWaterwheelAnchorRetirement({ store });
  const methodScopes = Object.freeze(Object.fromEntries(Object.entries(WATERWHEEL_METHODS).map(([kind, method]) => [method, WATERWHEEL_SCOPES[kind]])));
  const operationContracts = Object.freeze(Object.fromEntries(Object.entries(WATERWHEEL_DEFINITIONS).map(([kind, definition]) =>
    [definition.method, currentOperationContract(definition)])));
  function clockFor(context) { const value = clock(context.subjectRef); return value?.available === true && value.connectionEpoch === context.connectionEpoch &&
    Number.isSafeInteger(value.nowMs) && Number.isFinite(value.uncertaintyMs) && value.uncertaintyMs >= 0 ? value : null; }
  function anchorFor(context, state = null) {
    if (!state) state = sourceState(context);
    const row = state && get(`SELECT * FROM backend_waterwheel_enter_anchors WHERE owner_ref=? AND account_ref=? AND subject_ref=?
      AND owner_epoch=? AND run_epoch=? AND connection_epoch=? AND login_response_ref=? AND baseline_response_ref=?
      ORDER BY request_sequence DESC LIMIT 1`, context.ownerRef, String(context.accountRef), context.subjectRef, context.ownerEpoch,
      context.runEpoch, context.connectionEpoch, state.extension.loginResponseRef, state.wheel.source.responseRef);
    const day = dayStart(context), clockState = clockFor(context);
    let clockEvidence = null;
    try { clockEvidence = row ? JSON.parse(row.clock_evidence_json) : null; } catch { return null; }
    if (!row || !state || !day?.current || !clockState || row.account_ref !== String(context.accountRef) ||
        row.owner_epoch !== context.ownerEpoch || row.run_epoch !== context.runEpoch || row.connection_epoch !== context.connectionEpoch ||
        row.uid !== state.uid || row.login_response_ref !== state.extension.loginResponseRef || row.bundle_ref !== state.extension.bundleRef ||
        row.base_snapshot_id !== state.extension.baseDataSnapshotId || row.extension_ref !== state.extension.extensionRef ||
        row.baseline_response_ref !== state.wheel.source.responseRef || row.baseline_fingerprint !== state.wheel.fingerprint ||
        row.baseline_sequence !== state.wheel.source.requestSequence || row.request_sequence <= row.baseline_sequence ||
        fingerprint(clockEvidence) !== row.clock_fingerprint || clockEvidence?.connectionEpoch !== context.connectionEpoch ||
        clockEvidence?.evidence?.responseRef !== row.response_ref || clockEvidence?.evidence?.requestSequence !== row.request_sequence ||
        clockEvidence?.evidence?.method !== 'waterwheel.enter' ||
        row.clock_upper_ms < day.startMs || row.clock_lower_ms >= day.endMs) return null;
    return { method: 'waterwheel.enter', responseRef: row.response_ref, requestSequence: row.request_sequence, receivedDeviceMs: row.received_device_ms,
      baselineResponseRef: row.baseline_response_ref, baselineFingerprint: row.baseline_fingerprint };
  }
  function recordEnterAnchor({ context, observation, accepted = false, sourceAccepted = false } = {}) {
    if (!context || !observation || observation.method !== 'waterwheel.enter' || observation.source !== 'response' ||
        observation.transport !== 'answered' || observation.envelopeOk !== true || observation.dsName !== 'G.ISyncData' ||
        observation.rejected === true || sourceAccepted !== true || !isCurrent(context) || observation.connectionEpoch !== context.connectionEpoch ||
        !Number.isSafeInteger(observation.requestSequence) || !Number.isSafeInteger(observation.receivedDeviceMs) || typeof observation.responseRef !== 'string') return { accepted: false, changed: false };
    if (get('SELECT connection_epoch FROM backend_subject_connection_epochs WHERE subject_ref=?', context.subjectRef)?.connection_epoch !== context.connectionEpoch)
      return { accepted: false, changed: false, reasonCode: 'WATERWHEEL_ENTER_CONNECTION_SUPERSEDED' };
    const sync = observation.value;
    const present = sync && (Object.hasOwn(sync, '114') || Object.hasOwn(sync, 'waterwheel'));
    // A sparse ACK is a separate anchor only when the wheel namespace is truly
    // absent. Present-but-invalid values never get downgraded to an ACK.
    if (present || accepted === true) return { accepted: false, changed: false, reasonCode: 'WATERWHEEL_PRESENT_SOURCE_INVALID' };
    const state = sourceState(context), clockState = clockFor(context), day = dayStart(context);
    if (!state || !clockState || !day?.current || !Number.isSafeInteger(clockState.lowerBoundMs) || !Number.isSafeInteger(clockState.upperBoundMs) ||
        state.wheel.source.connectionEpoch !== context.connectionEpoch || observation.requestSequence <= state.wheel.source.requestSequence)
      return { accepted: false, changed: false };
    const clockEvidence = { source: clockState.source ?? null, evidence: clockState.evidence ?? null,
      lowerBoundMs: clockState.lowerBoundMs, upperBoundMs: clockState.upperBoundMs, connectionEpoch: clockState.connectionEpoch };
    if (clockEvidence.evidence?.responseRef !== observation.responseRef || clockEvidence.evidence?.requestSequence !== observation.requestSequence ||
        clockEvidence.evidence?.method !== 'waterwheel.enter' || clockEvidence.evidence?.connectionEpoch !== context.connectionEpoch)
      return { accepted: false, changed: false, reasonCode: 'WATERWHEEL_ENTER_CLOCK_NOT_BOUND' };
    const row = { responseRef: observation.responseRef, ownerRef: context.ownerRef, accountRef: String(context.accountRef), subjectRef: context.subjectRef,
      ownerEpoch: context.ownerEpoch, runEpoch: context.runEpoch, connectionEpoch: context.connectionEpoch,
      requestSequence: observation.requestSequence, loginResponseRef: state.extension.loginResponseRef, bundleRef: state.extension.bundleRef,
      baseSnapshotId: state.extension.baseDataSnapshotId, extensionRef: state.extension.extensionRef, uid: state.uid,
      baselineResponseRef: state.wheel.source.responseRef, baselineFingerprint: state.wheel.fingerprint,
      baselineSequence: state.wheel.source.requestSequence, clockFingerprint: fingerprint(clockEvidence),
      clockLowerMs: clockState.lowerBoundMs, clockUpperMs: clockState.upperBoundMs, receivedDeviceMs: observation.receivedDeviceMs };
    const prior = get('SELECT * FROM backend_waterwheel_enter_anchors WHERE response_ref=?', row.responseRef);
    if (prior) return { accepted: prior.baseline_response_ref === row.baselineResponseRef && prior.extension_ref === row.extensionRef, changed: false };
    run(`INSERT INTO backend_waterwheel_enter_anchors(response_ref,owner_ref,account_ref,subject_ref,owner_epoch,run_epoch,connection_epoch,request_sequence,
      login_response_ref,bundle_ref,base_snapshot_id,extension_ref,uid,baseline_response_ref,baseline_fingerprint,baseline_sequence,
      clock_fingerprint,clock_evidence_json,clock_lower_ms,clock_upper_ms,received_device_ms,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      row.responseRef,row.ownerRef,row.accountRef,row.subjectRef,row.ownerEpoch,row.runEpoch,row.connectionEpoch,row.requestSequence,
      row.loginResponseRef,row.bundleRef,row.baseSnapshotId,row.extensionRef,row.uid,row.baselineResponseRef,row.baselineFingerprint,row.baselineSequence,
      row.clockFingerprint,canonical(clockEvidence),row.clockLowerMs,row.clockUpperMs,row.receivedDeviceMs,nowIso());
    return { accepted: true, changed: true, responseRef: row.responseRef };
  }
  function generationFor(context, source, uid, extension, officialNowMs, offlineNum, offlineGrowth, calcTime, hirePeriodKey, serverCount, dayKey) {
    const old = get('SELECT * FROM backend_waterwheel_generation WHERE owner_ref=? AND subject_ref=? AND uid=? ORDER BY updated_at DESC,generation_ref DESC LIMIT 1',
      context.ownerRef, context.subjectRef, uid);
    const sameAxes = old && old.owner_epoch === context.ownerEpoch && old.run_epoch === context.runEpoch && old.connection_epoch === context.connectionEpoch;
    const dayChanged = old && old.period_key !== dayKey;
    if (dayChanged && source.method !== 'waterwheel.enter') return null;
    const newPeriod = !old || source.method === 'waterwheel.enter' &&
      (dayChanged || serverCount < old.last_server_count);
    if (old && !newPeriod) {
      if (!sameAxes && source.method !== 'waterwheel.enter') return null;
      const update = () => run(`UPDATE backend_waterwheel_generation SET account_ref=?,owner_epoch=?,run_epoch=?,connection_epoch=?,
        login_response_ref=?,enter_response_ref=CASE WHEN ?='waterwheel.enter' THEN ? ELSE enter_response_ref END,extension_ref=?,
        last_server_count=MAX(last_server_count,?),updated_at=? WHERE generation_ref=?`,
        String(context.accountRef), context.ownerEpoch, context.runEpoch, context.connectionEpoch, extension.loginResponseRef,
        source.method, source.responseRef, extension.extensionRef, serverCount, nowIso(), old.generation_ref);
      transaction(update);
      return get('SELECT * FROM backend_waterwheel_generation WHERE generation_ref=?', old.generation_ref);
    }
    if (source.method !== 'waterwheel.enter' || !Number.isSafeInteger(source.receivedDeviceMs) || !Number.isSafeInteger(officialNowMs)) return null;
    const cycleNumber = old ? old.cycle_number + (old.period_key === dayKey ? 1 : 0) : 0;
    const generationRef = 'waterwheel-generation:' + fingerprint([context.ownerRef, context.subjectRef, uid, dayKey, cycleNumber]);
    const due = officialNowMs + extension.rules.createCdSeconds * 1000;
    // Keep locally generated buckets that were already earned but not claimed
    // when the official claim counter/day starts a new cycle.
    const oldHeldProduced = old ? Number(get(`SELECT COUNT(*) AS n FROM backend_waterwheel_claim_heads WHERE generation_ref=? AND state='unknown-held-produced'`,
      old.generation_ref)?.n || 0) : 0;
    const carried = old ? Math.max(0, old.produced - old.produced_claimed - oldHeldProduced) : 0;
    let growthBaseline = offlineGrowth;
    if (old && Number.isSafeInteger(calcTime) && Number.isSafeInteger(old.calc_time_ms) && calcTime < old.calc_time_ms) {
      // A regressed timer cannot establish new offline generation. Carry the
      // prior frozen amount and preserve the source for diagnosis.
      growthBaseline = old.offline_growth_baseline;
    } else if (old && calcTime === old.calc_time_ms) {
      growthBaseline = old.offline_growth_baseline;
    }
    const baselineOffline = Math.min(extension.rules.storageLimit, offlineNum + growthBaseline);
    const effectiveGrowthBaseline = Math.max(0, baselineOffline - offlineNum);
    transaction(() => run(`INSERT OR IGNORE INTO backend_waterwheel_generation(owner_ref,account_ref,subject_ref,owner_epoch,run_epoch,connection_epoch,
      login_response_ref,enter_response_ref,extension_ref,uid,period_key,cycle_number,last_server_count,started_at_ms,baseline_offline_num,offline_growth_baseline,calc_time_ms,hire_period_key,
      offline_claimed,produced,produced_claimed,paused,next_due_ms,generation_ref,updated_at,baseline_server_offline_num)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      context.ownerRef, String(context.accountRef), context.subjectRef, context.ownerEpoch, context.runEpoch, context.connectionEpoch,
      extension.loginResponseRef, source.responseRef, extension.extensionRef, uid, dayKey, cycleNumber, serverCount, source.receivedDeviceMs, baselineOffline,
      effectiveGrowthBaseline, calcTime, hirePeriodKey, 0, carried, 0, 0, due, generationRef, nowIso(), offlineNum));
    return get('SELECT * FROM backend_waterwheel_generation WHERE owner_ref=? AND subject_ref=? AND uid=? ORDER BY updated_at DESC,generation_ref DESC LIMIT 1',
      context.ownerRef, context.subjectRef, uid);
  }
  function sourceState(context) {
    const wheel = facts.read(context);
    if (wheel?.current !== true || !wheel.value || !wheel.source) return null;
    const extension = extensionForContext(context);
    if (!extension || !extension.loginResponseRef || !extension.bundleRef || !extension.extensionRef) return null;
    const uid = wheel.value.uid, count = wheel.value.count, rawOfflineNum = wheel.value.offlineNum;
    if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(rawOfflineNum) || rawOfflineNum < 0 ||
        !Array.isArray(wheel.value.advList)) return null;
    return { wheel, extension, uid, count, offlineNum: Math.min(rawOfflineNum, extension.rules.storageLimit) };
  }
  function offlineAvailability(state, clockState) {
    const rule = state.extension.rules;
    const lower = Number.isFinite(clockState.lowerBoundMs) ? clockState.lowerBoundMs : clockState.nowMs - clockState.uncertaintyMs;
    const upper = Number.isFinite(clockState.upperBoundMs) ? clockState.upperBoundMs : clockState.nowMs + clockState.uncertaintyMs;
    let hired = false, beginMs = null, endMs = null;
    const hire = state.wheel.value.butlerHire;
    if (hire && hire.closed === false && hire.uid === state.uid && hire.type === 1 && hire.bought &&
        Array.isArray(hire.beginMs) && hire.beginMs.length === hire.endMs?.length) {
      const periods = hire.beginMs.map((beginMs, index) => ({ beginMs, endMs: hire.endMs[index] }))
        .filter(period => Number.isSafeInteger(period.beginMs) && Number.isSafeInteger(period.endMs) && period.beginMs < period.endMs);
      const selected = periods.filter(period => lower >= period.beginMs && upper < period.endMs);
      const crosses = periods.some(period => period.beginMs > lower && period.beginMs <= upper || period.endMs > lower && period.endMs <= upper);
      if (!crosses && selected.length === 1 && Number(hire.bought[String(selected[0].beginMs)] || 0) > 0) {
        hired = true; beginMs = selected[0].beginMs; endMs = selected[0].endMs;
      }
    }
    let growth = 0;
    if (hired && Number.isSafeInteger(state.wheel.value.calcTime)) {
      const elapsedUntil = Math.min(lower, endMs);
      growth = Math.max(0, Math.floor((elapsedUntil - state.wheel.value.calcTime) / (rule.createCdSeconds * 1000)));
    }
    return { offlineNum: Math.min(rule.storageLimit, state.offlineNum + growth), growth, hired,
      hirePeriodKey: hired ? String(beginMs) : null, hireEndMs: endMs };
  }
  function viewOpportunity(context, state) {
    const clockState = clockFor(context);
    if (!clockState) return { current: false, reasonCode: 'WATERWHEEL_OFFICIAL_CLOCK_NOT_CURRENT' };
    const day = dayStart(context);
    if (day?.current !== true || typeof day.key !== 'string' || !day.key || !Number.isSafeInteger(day.startMs) || !Number.isSafeInteger(day.endMs))
      return { current: false, reasonCode: 'WATERWHEEL_OFFICIAL_DAY_NOT_CURRENT' };
    const availability = offlineAvailability(state, clockState);
    const dayKey = day.key;
    const enterAnchor = state.wheel.source.method === 'waterwheel.enter' ? state.wheel.source : anchorFor(context, state);
    const generationSource = state.wheel.source.method === 'waterwheel.enter' ? state.wheel.source : enterAnchor;
    if (!generationSource) return { current: false, reasonCode: 'WATERWHEEL_ENTER_REQUIRED' };
    const generation = generationFor(context, generationSource, state.uid, state.extension,
      Number.isFinite(clockState.upperBoundMs) ? clockState.upperBoundMs : clockState.nowMs + clockState.uncertaintyMs,
      state.offlineNum, availability.growth, state.wheel.value.calcTime, availability.hirePeriodKey, state.count, dayKey);
    if (!generation) return { current: false, reasonCode: 'WATERWHEEL_ENTER_REQUIRED' };
    availability.offlineNum = Math.min(state.extension.rules.storageLimit, state.offlineNum + generation.offline_growth_baseline);
    let refreshedGeneration = generation;
    const reflectedOffline = Math.max(0, generation.baseline_server_offline_num - state.offlineNum);
    const pendingOfflineClaims = Math.max(0, generation.offline_claimed - reflectedOffline);
    const held = store.all(`SELECT c.state,COUNT(*) AS n FROM backend_waterwheel_claim_heads c JOIN backend_waterwheel_generation g
      ON g.generation_ref=c.generation_ref WHERE c.owner_ref=? AND c.subject_ref=? AND g.uid=?
      AND c.state IN('unknown-held-offline','unknown-held-produced') GROUP BY c.state`, context.ownerRef, context.subjectRef, state.uid);
    const heldCurrent = store.all(`SELECT state,COUNT(*) AS n FROM backend_waterwheel_claim_heads WHERE owner_ref=? AND subject_ref=? AND generation_ref=?
      AND state IN('unknown-held-offline','unknown-held-produced') GROUP BY state`, context.ownerRef, context.subjectRef, generation.generation_ref);
    const heldOffline = Number(held.find(row => row.state === 'unknown-held-offline')?.n || 0);
    const heldProduced = Number(held.find(row => row.state === 'unknown-held-produced')?.n || 0);
    const heldCurrentOffline = Number(heldCurrent.find(row => row.state === 'unknown-held-offline')?.n || 0);
    const heldCurrentProduced = Number(heldCurrent.find(row => row.state === 'unknown-held-produced')?.n || 0);
    // The current enter/count/bucket state is authoritative. An unknown claim
    // from an older generation is retired from current capacity with an
    // append-only receipt; its original evidence and verdict stay untouched.
    const staleHeld = store.all(`SELECT * FROM backend_waterwheel_claim_heads WHERE owner_ref=? AND subject_ref=?
      AND generation_ref<>? AND state IN('unknown-held-offline','unknown-held-produced')`,
    context.ownerRef, context.subjectRef, generation.generation_ref);
    if (staleHeld.length) transaction(() => {
      for (const claim of staleHeld) {
        const retirementRef = 'waterwheel-held-retirement:' + fingerprint([context.ownerRef, context.subjectRef,
          state.uid, generation.generation_ref, claim.generation_ref, claim.server_count, claim.slot, claim.operation_id]);
        run(`INSERT OR IGNORE INTO backend_waterwheel_held_retirements(retirement_ref,owner_ref,subject_ref,uid,generation_ref,
          prior_generation_ref,server_count,slot,claim_state,claim_operation_id,reason_code,evidence_ref,recorded_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, retirementRef, context.ownerRef, context.subjectRef, state.uid,
        generation.generation_ref, claim.generation_ref, claim.server_count, claim.slot, claim.state, claim.operation_id,
        'SUPERSEDED_BY_CURRENT_GENERATION', generation.enter_response_ref, nowIso());
      }
    });
    const offlineRemaining = Math.max(0, availability.offlineNum - pendingOfflineClaims - heldCurrentOffline);
    let generated = Math.max(0, generation.produced - generation.produced_claimed - heldCurrentProduced);
    const totalCapacity = availability.hired ? state.extension.rules.storageLimit + state.extension.rules.visibleSlots : state.extension.rules.visibleSlots;
    const generationCapacity = Math.max(0, totalCapacity - offlineRemaining - heldCurrentOffline - heldCurrentProduced);
    const capacity = offlineRemaining + generationCapacity;
    const cap = Math.min(capacity, Math.max(0, state.extension.rules.dailyClaimLimit - state.count));
    let total = Math.min(cap, offlineRemaining + generated);
    let paused = generation.paused === 1;
    if (paused && total < cap && total < capacity) {
      const nextDue = clockState.nowMs + state.extension.rules.createCdSeconds * 1000;
      run('UPDATE backend_waterwheel_generation SET paused=0,next_due_ms=?,updated_at=? WHERE owner_ref=? AND subject_ref=? AND uid=? AND generation_ref=?',
        nextDue, nowIso(), context.ownerRef, context.subjectRef, state.uid, generation.generation_ref);
      refreshedGeneration = get('SELECT * FROM backend_waterwheel_generation WHERE generation_ref=?', generation.generation_ref);
      paused = false;
    }
    if (!paused && (total >= cap || generated >= generationCapacity)) {
      run('UPDATE backend_waterwheel_generation SET paused=1,next_due_ms=0,updated_at=? WHERE owner_ref=? AND subject_ref=? AND uid=? AND generation_ref=?',
        nowIso(), context.ownerRef, context.subjectRef, state.uid, generation.generation_ref);
      refreshedGeneration = get('SELECT * FROM backend_waterwheel_generation WHERE generation_ref=?', generation.generation_ref);
      paused = true;
    }
    const clockLower = Number.isFinite(clockState.lowerBoundMs) ? clockState.lowerBoundMs : clockState.nowMs - clockState.uncertaintyMs;
    if (!paused && Number.isSafeInteger(refreshedGeneration.next_due_ms) && clockLower >= refreshedGeneration.next_due_ms &&
        total < cap && generated < generationCapacity) {
      const cadence = state.extension.rules.createCdSeconds * 1000;
      const dueIntervals = Math.floor((clockLower - refreshedGeneration.next_due_ms) / cadence) + 1;
      const produced = Math.min(dueIntervals, cap - total, generationCapacity - generated);
      const nextDue = total + produced >= cap || generated + produced >= generationCapacity ? 0 : refreshedGeneration.next_due_ms + produced * cadence;
      transaction(() => run(`UPDATE backend_waterwheel_generation SET produced=produced+?,next_due_ms=?,updated_at=?
        WHERE owner_ref=? AND subject_ref=? AND generation_ref=? AND produced=? AND next_due_ms=?`, produced, nextDue, nowIso(),
        context.ownerRef, context.subjectRef, generation.generation_ref, refreshedGeneration.produced, refreshedGeneration.next_due_ms));
      refreshedGeneration = get('SELECT * FROM backend_waterwheel_generation WHERE generation_ref=?', generation.generation_ref);
      generated = Math.max(0, refreshedGeneration.produced - refreshedGeneration.produced_claimed - heldCurrentProduced);
      total = Math.min(cap, offlineRemaining + generated);
      if (generated >= generationCapacity || total >= cap) {
        run('UPDATE backend_waterwheel_generation SET paused=1,next_due_ms=0,updated_at=? WHERE generation_ref=?',
          nowIso(), generation.generation_ref);
        refreshedGeneration = get('SELECT * FROM backend_waterwheel_generation WHERE generation_ref=?', generation.generation_ref);
        paused = true;
      }
    }
    const canGenerate = total < cap && generated < generationCapacity;
    const dueMs = canGenerate && refreshedGeneration.paused !== 1 ? refreshedGeneration.next_due_ms : null;
    const bucketAvailable = total > 0;
    const nextDueMs = !bucketAvailable && dueMs && dueMs > clockLower ? dueMs : null;
    return { current: true, clock: clockState, availability, generation: refreshedGeneration, total, bucketAvailable, nextDueMs,
      held: { currentOffline: heldCurrentOffline, currentProduced: heldCurrentProduced,
        retiredFromCapacity: { offline: heldOffline, produced: heldProduced } },
      opportunity: bucketAvailable ? { count: state.count, slot: state.count + 1, offlineRemaining, sourceRef: state.wheel.source.responseRef,
        generationRef: generation.generation_ref, extension: state.extension } : null };
  }
  function dayStart(context) { return typeof officialDay === 'function' ? officialDay(context) : null; }
  function videoEligible(context, state) {
    const share = state.wheel.value.share9, day = dayStart(context), limit = state.extension.rules.dailyVideoLimit;
    if (state.extension.rules.videoSupported !== true || !share?.present || !Number.isSafeInteger(share.uid) || share.uid !== state.uid || !Number.isSafeInteger(share.tmpId) || share.tmpId !== 9 ||
        !Number.isSafeInteger(share.shareCnt) || !Number.isSafeInteger(share.uTime) || !day?.current || !Number.isSafeInteger(day.startMs)) return false;
    const count = share.uTime < day.startMs ? 0 : share.shareCnt;
    return count < limit;
  }
  function buildProposal(input, state, opportunity, kind) {
    const definition = WATERWHEEL_DEFINITIONS[kind], method = definition.method, args = kind === 'share' ? { shareId: 9, ext: { opType: 1 } } : {};
    const item7Balance = kind === 'skip' ? null : resources.balance({ context: input.context, itemId: 7 });
    const targetRef = `waterwheel:${input.context.subjectRef}:${opportunity.generationRef}:${opportunity.count}:${opportunity.slot}`;
    const target = { memberKey: 'waterwheel:' + fingerprint([opportunity.generationRef, opportunity.count, opportunity.slot]),
      targetKind: 'waterwheel', targetRef, lifecycleRef: opportunity.generationRef,
      targetFingerprint: fingerprint({ targetRef, sourceRef: opportunity.sourceRef, extensionRef: state.extension.extensionRef }) };
    const semanticKey = `waterwheel:${kind}:` + fingerprint([input.context.subjectRef, opportunity.generationRef, opportunity.count, opportunity.slot]);
    const proposal = { ...input.context, operationId: newId(), proposalId: newId(), featureId: 'waterwheel', scope: WATERWHEEL_SCOPES[kind], method,
      params: args, paramsFingerprint: fingerprint(args), configRevision: input.config.savedRevision,
      featureCancelEpoch: input.config.featureCancelEpochs.waterwheel, semanticKey, targets: [target], resources: [], resourceBindings: [],
      contractRef: WATERWHEEL_CONTRACT_REF,
      waterwheel: { kind, count: opportunity.count, slot: opportunity.slot, extensionRef: state.extension.extensionRef,
        extension: state.extension, sourcePin: state.extension.sourcePin, bundleRef: state.extension.bundleRef,
        loginResponseRef: state.extension.loginResponseRef, uid: state.uid,
        sourceRef: opportunity.sourceRef, generationRef: opportunity.generationRef,
        sourceMethod: state.wheel.source.method, sourceFingerprint: state.wheel.fingerprint,
        before: { count: state.wheel.value.count, offlineNum: state.wheel.value.offlineNum,
          officialDayKey: dayStart(input.context)?.key ?? null,
          advList: clone(state.wheel.value.advList), share9: clone(state.wheel.value.share9 ?? null),
          shareCountEffective: (() => { const share = state.wheel.value.share9, day = dayStart(input.context);
            return share?.present && day?.current && Number.isSafeInteger(day.startMs) && Number.isSafeInteger(share.uTime) && share.uTime < day.startMs
              ? 0 : share?.shareCnt ?? null; })(),
          item7: kind === 'skip' ? null : item7Balance?.base?.value ?? null, offlineRemaining: opportunity.offlineRemaining,
          item7SourceRef: kind === 'skip' ? null : item7Balance?.base?.source?.responseRef ?? null,
          item7BasisRef: kind === 'skip' ? null : item7Balance?.base?.basisRef ?? null,
          item7Effective: kind === 'skip' ? null : item7Balance?.effective ? { known: item7Balance.effective.known === true,
            lowerBound: item7Balance.effective.lowerBound ?? null, upperBound: item7Balance.effective.upperBound ?? null,
            anchorMs: item7Balance.effective.anchorMs ?? null, clockRevision: item7Balance.effective.clockRevision ?? null,
            extSourceRef: item7Balance.ext?.sourceRef ?? null,
            nextIncreaseOfficialMs: item7Balance.effective.nextIncreaseOfficialMs ?? null } : null } } };
    return proposal;
  }
  function assess(input) {
    if (input.config?.config?.waterwheelEnabled !== true) return { state: 'disabled', reasonCode: 'WATERWHEEL_DISABLED' };
    if (!isCurrent(input.context) || !exactContext(input.context)) return { state: 'blocked', reasonCode: 'WATERWHEEL_CONTEXT_NOT_CURRENT' };
    const open = openEligibility(input.context);
    if (open?.known !== true || open.value !== true) return { state: 'waiting-facts', reasonCode: open?.reasonCode || 'WATERWHEEL_OPEN_NOT_PROVEN' };
    const state = sourceState(input.context);
    if (!state) {
      Promise.resolve(readEnter(input.context)).catch(() => {});
      return { state: 'waiting-facts', reasonCode: 'WATERWHEEL_CURRENT_FACTS_REQUIRED', deviceDueMs: Date.now() + 30000 };
    }
    const view = viewOpportunity(input.context, state);
    if (!view.current) {
      if (view.reasonCode === 'WATERWHEEL_ENTER_REQUIRED') {
        Promise.resolve(readEnter(input.context)).catch(() => {});
        return { state: 'waiting-facts', reasonCode: view.reasonCode, deviceDueMs: Date.now() + 30000 };
      }
      return { state: 'waiting-facts', reasonCode: view.reasonCode, deviceDueMs: Date.now() + 30000 };
    }
    if (!view.bucketAvailable) return { state: 'waiting-until', reasonCode: 'WATERWHEEL_NEXT_BUCKET_DUE',
      officialDueMs: view.nextDueMs, deviceDueMs: Date.now() + 30000 };
    const pending = get(`SELECT state FROM backend_waterwheel_claim_heads WHERE owner_ref=? AND subject_ref=? AND generation_ref=? AND server_count=? AND slot=?`,
      input.context.ownerRef, input.context.subjectRef, view.opportunity.generationRef, view.opportunity.count, view.opportunity.slot);
    if (pending?.state?.startsWith('unknown-held-')) return { state: 'waiting-facts', reasonCode: 'WATERWHEEL_PRIOR_ANSWERED_CLAIM_REQUIRES_RECONCILIATION', deviceDueMs: Date.now() + 30000 };
    const wantsVideo = state.wheel.value.advList.includes(view.opportunity.slot) && videoEligible(input.context, state);
    const kind = pending?.state === 'skip-confirmed' ? (state.extension.rules.ordinarySupported ? 'recv' : null) :
      wantsVideo ? 'share' : state.extension.rules.ordinarySupported ?
        (state.wheel.value.advList.includes(view.opportunity.slot) ? 'skip' : 'recv') : null;
    if (kind === null) return { state: 'waiting-facts', reasonCode: 'WATERWHEEL_ORDINARY_REWARD_TABLE_UNSUPPORTED', deviceDueMs: Date.now() + 30000 };
    if (kind !== 'skip') {
      const balance = resources.balance({ context: input.context, itemId: 7 }), source = balance?.base?.source, effective = balance?.effective;
      if (balance?.base?.known !== true || !Number.isSafeInteger(balance.base.value) || balance.base.value !== state.wheel.value.item7Balance ||
          source?.responseRef !== state.wheel.source.responseRef || source?.connectionEpoch !== input.context.connectionEpoch ||
          source?.requestSequence !== state.wheel.source.requestSequence || effective?.known !== true ||
          !Number.isSafeInteger(effective.lowerBound) || effective.lowerBound !== effective.upperBound)
        return { state: 'waiting-facts', reasonCode: 'WATERWHEEL_ITEM7_BALANCE_NOT_CURRENT', deviceDueMs: Date.now() + 15000 };
    }
    const proposal = buildProposal(input, state, view.opportunity, kind);
    const basis = readFactBasis({ proposal, actor: input.context });
    proposal.factBasis = basis;
    return { state: 'proposals', proposals: [freeze(proposal)], factBasis: basis, reasonCode: null };
  }
  function readFactBasis({ proposal, actor }) {
    if (!isCurrent(actor)) return { current: false, reasonCode: 'WATERWHEEL_CONTEXT_NOT_CURRENT' };
    const state = sourceState(actor);
    if (!state) return { current: false, reasonCode: 'WATERWHEEL_CURRENT_FACTS_REQUIRED' };
    const config = readConfiguration(actor), snapshot = dynamicState.snapshot({ context: actor, feature,
      config, method: proposal?.method, proposal });
    if (snapshot?.current !== true) return { current: false, reasonCode: snapshot?.reasonCode || 'WATERWHEEL_DYNAMIC_FACTS_NOT_CURRENT' };
    const contextBasis = Object.fromEntries(['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch']
      .map(key => [key, actor[key]]));
    const factDomains = snapshot.domains.map(domain => Object.fromEntries(['domainId', 'current', 'semanticRevision',
      'semanticFingerprint', 'sourceRef', 'sourceKind', 'method', 'requestSequence', 'observedAtMs', 'coverage',
      'sourceProofs', 'dirty', 'reasonCode'].map(key => [key, domain[key]])));
    return freeze({ current: true, fingerprint: fingerprint({ context: contextBasis, extensionRef: state.extension.extensionRef,
      sourceRef: state.wheel.source.responseRef, sourceFingerprint: state.wheel.fingerprint, domains: factDomains,
      proposal: proposal ? proposal.waterwheel : null }) });
  }
  function evaluateAdmission({ proposal, actor, factBasis: suppliedBasis, boundary, ownReservation } = {}) {
    if (!proposal || !actor || !isCurrent(actor)) return { allowed: false, reasonCode: 'WATERWHEEL_CONTEXT_NOT_CURRENT' };
    const open = openEligibility(actor);
    if (open?.known !== true || open.value !== true) return { allowed: false, historicalConstraintsChecked: true,
      currentInFlightChecked: true, reasonCode: open?.reasonCode || 'WATERWHEEL_OPEN_NOT_PROVEN' };
    const state = sourceState(actor), currentBasis = readFactBasis({ proposal, actor });
    if (!state || !currentBasis.current || suppliedBasis?.fingerprint !== currentBasis.fingerprint ||
        state.extension.extensionRef !== proposal.waterwheel.extensionRef || state.extension.loginResponseRef !== proposal.waterwheel.loginResponseRef ||
        proposal.waterwheel.count !== state.wheel.value.count ||
        proposal.waterwheel.sourceRef !== state.wheel.source.responseRef) return { allowed: false, reasonCode: 'WATERWHEEL_FACTS_SUPERSEDED' };
    const admission = ledgerView.currentAdmission({ ownerRef: actor.ownerRef, subjectRef: actor.subjectRef,
      targetRefs: proposal.targets.map(target => target.targetRef), featureIds: ['waterwheel'] });
    const ownId = boundary === 'before-send' && ownReservation?.operationId === proposal.operationId ? proposal.operationId : null;
    const active = admission?.activeOperation;
    if (!admission || active && active.operation_id !== ownId)
      return { allowed: false, historicalConstraintsChecked: true, currentInFlightChecked: true, reasonCode: 'WATERWHEEL_ACTIVE_OPERATION' };
    for (const row of admission.unresolvedOperations || []) {
      if (row.operation_id === ownId) continue;
      const prior = ledgerView.operation?.(row.operation_id);
      if (prior?.targets?.some(target => (target.target_ref ?? target.original?.targetRef) === proposal.targets[0].targetRef))
        return { allowed: false, historicalConstraintsChecked: true, currentInFlightChecked: true, reasonCode: 'WATERWHEEL_TARGET_HAS_UNRESOLVED_OPERATION' };
    }
    return { allowed: true, targetsCurrent: true, resourcesCurrent: true, historicalConstraintsChecked: true,
      currentInFlightChecked: true, reasonCode: null };
  }
  async function verify({ proposal, response, connection, signal } = {}) {
    let bridge, post;
    try { bridge = await connection.readSnapshotAfterClose(); post = bridge?.newLoginObservation; }
    catch (error) { return { verdict: 'unknown', reasonCode: typeof error?.code === 'string' ? error.code : 'WATERWHEEL_POSTREAD_FAILED' }; }
    signal?.throwIfAborted?.();
    if (!bridge || bridge.operationId !== proposal.operationId || bridge.oldPhysicalCloseReceipt?.closed !== true ||
        !post || post.method !== 'index.login' || post.source !== 'response' || post.transport !== 'answered' ||
        post.envelopeOk !== true || post.dsName !== 'G.ISyncData' || bridge.officialUid !== proposal.waterwheel.uid)
      return { verdict: 'unknown', reasonCode: 'WATERWHEEL_POSTREAD_MISSING' };
    const afterFacts = facts.read(bridge.newContext);
    const postExtension = extensionForContext(bridge.newContext);
    const postExtensionBody = postExtension && Object.fromEntries(Object.entries(postExtension).filter(([key]) => key !== 'extensionRef'));
    const postExtensionCurrent = postExtension?.extensionId === WATERWHEEL_EXTENSION_ID && postExtension.sourcePin === WATERWHEEL_SOURCE_PIN &&
      postExtension.extensionRef === 'sha256:' + fingerprint(postExtensionBody) && postExtension.loginResponseRef === post.responseRef &&
      typeof postExtension.bundleRef === 'string' && !!postExtension.bundleRef && typeof postExtension.baseDataSnapshotId === 'string' &&
      !!postExtension.baseDataSnapshotId && postExtension.sourceProof?.sourcePin === WATERWHEEL_SOURCE_PIN &&
      postExtension.sourceProof?.matchedRanges?.length === 30 && postExtension.sourceProof?.extensionId === WATERWHEEL_EXTENSION_ID;
    if (!postExtensionCurrent) return { verdict: 'unknown', reasonCode: 'WATERWHEEL_POSTREAD_EXTENSION_NOT_CURRENT' };
    if (afterFacts?.current !== true || afterFacts.source?.responseRef !== post.responseRef || afterFacts.source?.method !== 'index.login')
      return { verdict: 'unknown', reasonCode: 'WATERWHEEL_POSTREAD_FACTS_NOT_CURRENT' };
    const afterWheel = afterFacts.value, afterShare = afterFacts.value.share9 ? { map: { 9: afterFacts.value.share9 } } : null;
    const before = proposal.waterwheel.before, afterCount = afterWheel.count;
    const afterAdvList = afterWheel.advList;
    const skippedVideoSlot = proposal.waterwheel.kind !== 'skip' || Array.isArray(afterAdvList) &&
      before.advList.includes(proposal.waterwheel.slot) && !afterAdvList.includes(proposal.waterwheel.slot);
    const advanced = Number.isSafeInteger(afterCount) && (proposal.waterwheel.kind === 'skip'
      ? afterCount === before.count && skippedVideoSlot : afterCount === before.count + 1);
    const balance = proposal.waterwheel.kind === 'skip' ? null : resources.balance({ context: bridge.newContext, itemId: 7 });
    const afterBalanceSource = balance?.base?.source;
    const afterBalance = balance?.base?.known === true && afterBalanceSource?.responseRef === post.responseRef &&
      afterBalanceSource?.connectionEpoch === bridge.newContext.connectionEpoch && afterBalanceSource?.requestSequence === post.requestSequence
      ? balance.base.value : null;
    const beforeBalance = before.item7;
    const delta = proposal.waterwheel.kind === 'skip' ? 0 : Number.isSafeInteger(afterBalance) && Number.isSafeInteger(beforeBalance) ? afterBalance - beforeBalance : null;
    const flow = proposal.waterwheel.kind === 'skip' ? null : resources.matchedItemFlow({ context: proposal,
      source: { responseRef: response?.responseRef, wireKey: response?.wireKey, requestSequence: response?.requestSequence,
        connectionEpoch: response?.connectionEpoch }, method: proposal.method, itemId: 7 });
    const writeGain = knownCell(flow?.bi) ? flow.bi.value : null, writeCost = knownCell(flow?.bo) ? flow.bo.value : null,
      writeAbsolute = knownCell(flow?.bd) ? flow.bd.value : null;
    const writeCostEvidence = knownCell(flow?.bo) ? (writeCost === 0 ? 'explicit-zero' : null) :
      flow?.boCoverage?.presence === 'present' && flow.boCoverage.state === 'known' && flow.boCoverage.item7Present === false
        ? 'known-map-missing-key' : flow?.boCoverage?.presence === 'missing' && flow.boCoverage.state === 'unobserved'
          ? 'not-reported-net-conservation' : null;
    const beforeEffective = before.item7Effective, afterEffective = balance?.effective;
    const absoluteConsistent = !flow?.bd ? flow?.bdCoverage?.presence === 'missing' && flow.bdCoverage.state === 'unobserved' ||
      flow?.bdCoverage?.presence === 'present' && flow.bdCoverage.state === 'known' && flow.bdCoverage.item7Present === false
      : knownCell(flow.bd) && flow.bd.value === afterBalance;
    const effectiveDelta = beforeEffective?.known === true && afterEffective?.known === true &&
      Number.isSafeInteger(beforeEffective.lowerBound) && beforeEffective.lowerBound === beforeEffective.upperBound &&
      Number.isSafeInteger(afterEffective.lowerBound) && afterEffective.lowerBound === afterEffective.upperBound
      ? afterEffective.lowerBound - beforeEffective.lowerBound : null;
    const awardProven = proposal.waterwheel.kind === 'recv'
      ? Number.isSafeInteger(delta) && delta === effectiveDelta && Number.isSafeInteger(writeGain) && writeGain >= proposal.waterwheel.extension.rules.ordinaryWaterMin &&
        writeGain <= proposal.waterwheel.extension.rules.ordinaryWaterMax && delta === writeGain &&
        writeCostEvidence !== null && absoluteConsistent
      : proposal.waterwheel.kind === 'share' ? Number.isSafeInteger(delta) && delta === effectiveDelta && Number.isSafeInteger(writeGain) &&
        delta === proposal.waterwheel.extension.rules.videoWaterQuantity && writeGain === delta &&
        writeCostEvidence !== null && absoluteConsistent : true;
    const shareRow = afterShare?.map?.[9];
    const observedShareCount = shareRow?.shareCnt ?? shareRow?.['2'], rawShareUTime = shareRow?.uTime ?? shareRow?.['6'];
    const observedShareUTime = Number.isSafeInteger(rawShareUTime) ? rawShareUTime : officialDateMs(rawShareUTime);
    const day = proposal.waterwheel.kind === 'share' ? dayStart(bridge.newContext) : null;
    const shareAdvanced = proposal.waterwheel.kind !== 'share' || Number.isSafeInteger(observedShareCount) &&
      observedShareCount === before.shareCountEffective + 1 && Number.isSafeInteger(observedShareUTime) &&
      day?.current === true && day.key === before.officialDayKey && Number.isSafeInteger(day.startMs) && observedShareUTime >= day.startMs;
    const confirmed = advanced && awardProven && shareAdvanced;
    const evidence = { traceId: proposal.traceId, targetRef: proposal.targets[0].targetRef, extensionRef: proposal.waterwheel.extensionRef,
      postExtension: clone(postExtension),
      writeResponseRef: response?.responseRef ?? null, postReadRef: post.responseRef, beforeCount: before.count,
      afterCount: Number.isSafeInteger(afterCount) ? afterCount : null, beforeItem7: beforeBalance ?? null,
      afterItem7: Number.isSafeInteger(afterBalance) ? afterBalance : null, item7Delta: delta,
      writeItem7Flow: flow ? { observationRef: flow.observationRef, responseRef: flow.responseRef,
        requestSequence: flow.requestSequence, wireKey: flow.wireKey, bi: writeGain, bo: writeCost, bd: writeAbsolute,
        boCoverage: flow.boCoverage, bdCoverage: flow.bdCoverage, boCostEvidence: writeCostEvidence,
        frameFingerprint: flow.frameFingerprint } : null,
      beforeItem7SourceRef: before.item7SourceRef, afterItem7SourceRef: Number.isSafeInteger(afterBalance) ? post.responseRef : null,
      afterBalanceSource: afterBalanceSource ?? null, beforeItem7BasisRef: before.item7BasisRef ?? null,
      beforeItem7Effective: beforeEffective, afterItem7Effective: afterEffective ?? null,
      bridge: { leaseRef: bridge.leaseRef, bridgeFingerprint: bridge.bridgeFingerprint,
        oldConnectionEpoch: bridge.originalContext?.connectionEpoch ?? null, newConnectionEpoch: bridge.newContext?.connectionEpoch ?? null,
        newLoginRequestSequence: post.requestSequence, newLoginWireKey: post.wireKey,
        oldPhysicalCloseReceipt: bridge.oldPhysicalCloseReceipt }, shareAdvanced: Boolean(shareAdvanced) };
    return { verdict: confirmed ? 'confirmed' : 'unknown', reasonCode: confirmed ? null : 'WATERWHEEL_RESULT_NOT_PROVEN',
      verificationVersion: 'waterwheel/target-postread/v1', evidence,
      resourceResolutions: [],
      postRead: { responseRef: post.responseRef, method: post.method, requestSequence: post.requestSequence,
        connectionEpoch: post.connectionEpoch, receivedDeviceMs: post.receivedDeviceMs } };
  }
  function onSettled({ proposal, verification, operation }) {
    const wheel = proposal.waterwheel;
    if (get('SELECT operation_id FROM backend_waterwheel_settlement_receipts WHERE operation_id=?', proposal.operationId))
      return { visibility: 'current', replayed: true };
    run('INSERT INTO backend_waterwheel_settlement_receipts(operation_id,owner_ref,subject_ref,verdict,recorded_at) VALUES(?,?,?,?,?)',
      proposal.operationId, proposal.ownerRef, proposal.subjectRef, verification?.verdict || 'unknown', nowIso());
    if (verification?.verdict === 'confirmed' && ['skip', 'recv', 'share'].includes(wheel.kind)) {
      const nextState = wheel.kind === 'skip' ? 'skip-confirmed' : 'claim-confirmed';
      transaction(() => run(`INSERT INTO backend_waterwheel_claim_heads(owner_ref,subject_ref,generation_ref,server_count,slot,state,operation_id,updated_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref,generation_ref,server_count,slot) DO UPDATE SET state=excluded.state,
        operation_id=excluded.operation_id,updated_at=excluded.updated_at`, proposal.ownerRef, proposal.subjectRef, wheel.generationRef,
        wheel.count, wheel.slot, nextState, proposal.operationId, nowIso()));
    } else if (verification?.verdict === 'unknown' && ['recv', 'share'].includes(wheel.kind) && operation?.transport_state !== 'not_sent') {
      const origin = wheel.before.offlineRemaining > 0 ? 'offline' : 'produced';
      transaction(() => run(`INSERT OR IGNORE INTO backend_waterwheel_claim_heads(owner_ref,subject_ref,generation_ref,server_count,slot,state,operation_id,updated_at)
        VALUES(?,?,?,?,?,?,?,?)`, proposal.ownerRef, proposal.subjectRef, wheel.generationRef, wheel.count, wheel.slot,
        'unknown-held-' + origin, proposal.operationId, nowIso()));
    }
    if (verification?.verdict === 'confirmed' && ['recv', 'share'].includes(proposal.waterwheel.kind)) {
      const origin = proposal.waterwheel.before.offlineRemaining > 0 ? 'offline_claimed' : 'produced_claimed';
      const currentClock = clockFor(proposal), cadence = proposal.waterwheel.extension.rules.createCdSeconds * 1000;
      const state = get('SELECT * FROM backend_waterwheel_generation WHERE generation_ref=? AND owner_ref=? AND subject_ref=? AND uid=?',
        proposal.waterwheel.generationRef, proposal.ownerRef, proposal.subjectRef, proposal.waterwheel.uid);
      const resume = state?.paused === 1 && currentClock ? { paused: 0, nextDue: currentClock.nowMs + cadence } :
        { paused: state?.paused ?? 0, nextDue: state?.next_due_ms ?? 0 };
      run(`UPDATE backend_waterwheel_generation SET ${origin}=${origin}+1,paused=?,next_due_ms=?,updated_at=? WHERE owner_ref=? AND subject_ref=? AND uid=? AND generation_ref=?`,
        resume.paused, resume.nextDue, nowIso(), proposal.ownerRef, proposal.subjectRef, proposal.waterwheel.uid, proposal.waterwheel.generationRef);
    }
    appendOutbox({ ownerRef: proposal.ownerRef, subjectRef: proposal.subjectRef, eventType: 'FeatureSettlement',
      eventKey: 'waterwheel-settlement:' + proposal.operationId,
      payload: { operationId: operation?.operation_id || proposal.operationId, featureId: 'waterwheel',
        verdict: verification?.verdict || 'unknown', reasonCode: verification?.reasonCode || null,
        runEpoch: proposal.runEpoch, connectionEpoch: proposal.connectionEpoch, method: proposal.method } });
    return { visibility: 'current' };
  }
  const feature = Object.freeze({ featureId: 'waterwheel', consumedDomains: ['waterwheel','waterwheel-share','waterwheel-item','inventory','customer-day','customer-eligibility','profile','clock'],
    consumedDomainsFor: ({ method } = {}) => method === 'waterwheel.skip' ? ['waterwheel','customer-eligibility','profile'] :
      method === 'waterwheel.recv' ? ['waterwheel','waterwheel-item','customer-eligibility','profile'] :
        ['waterwheel','waterwheel-share','waterwheel-item','customer-day','clock','customer-eligibility','profile'],
    scopes: Object.values(WATERWHEEL_SCOPES), methods: Object.values(WATERWHEEL_METHODS), methodScopes,
    operationContracts, operationContract: null, release: 'validation-only', implementationVersion: IMPLEMENTATION,
    contractRef: WATERWHEEL_CONTRACT_REF, factDomains: ['waterwheel','waterwheel-share'], resourceKinds: ['waterwheel','item'],
    scheduleUnits: Object.freeze([{ scheduleKey: 'waterwheel:receive', wakeKey: 'waterwheel:receive', assess }]),
    assess, qualify: evaluateAdmission, verify, readFactBasis, evaluateAdmission, onSettled, onCurrentVerified: () => {} });
  return Object.freeze({ feature, readFactBasis, evaluateAdmission, onSettled, assess, recordEnterAnchor, retireAnchors: anchorRetirement.retire, stop: context => {
    if (!context) return;
    // Old generation rows remain as immutable audit history but are never reused across login axes.
  } });
}
