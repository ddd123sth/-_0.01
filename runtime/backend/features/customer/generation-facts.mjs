import { clone, fingerprint, freeze, parseStored, plainObject } from '../../common.mjs';
import { customerContext, customerContextKey, customerDateMs, knownCustomerCell, sameCustomerContext } from './wire-facts.mjs';
import { deriveCustomerOfficialDay } from './official-day.mjs';
import { isNormalSyncMethod } from '../../facts/normal-sync-contract.mjs';
import { currentOfficialSourceEvidence } from '../../official-data-evidence.mjs';
import { verifyOfficialServerVersionFrame, SERVER_VERSION_PROTOCOL_CONTRACT } from '../../official-server-version-contract.mjs';

const DAY = 86400000;
const scalar = cell => cell?.current && knownCustomerCell(cell) ? cell.value : null;
const positive = value => Number.isSafeInteger(value) && value > 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const safeScalar = value => typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' ? value : null;
const rawType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const COUNTER_FIELDS = Object.freeze(['domain', 'uid', 'type', 'tdyCnt', 'rTime']);
const TZ_FIELDS = Object.freeze(['type', 'ms', 'secNum', 'tzo']);
const TZ_YEAR_LIMIT = 16, TZ_ANCHOR_LIMIT = 16;
function timezoneTableProjection(tz) {
  const raw = tz.splitMap, keys = plainObject(raw) ? Object.keys(raw) : [];
  const validYears = keys.filter(key => /^(?:19[7-9]\d|[2-9]\d{3})$/.test(key)).sort((a, b) => Number(a) - Number(b));
  const years = validYears.slice(0, TZ_YEAR_LIMIT).map(key => {
    const value = raw[key], rows = Array.isArray(value) ? value.slice(0, TZ_ANCHOR_LIMIT) : [];
    const anchors = rows.map(row => {
      const object = plainObject(row), fieldsPresent = object ? TZ_FIELDS.filter(field => Object.hasOwn(row, field)) : [];
      return { ...Object.fromEntries(TZ_FIELDS.map(field => [field,
        object && typeof row[field] === 'number' && Number.isFinite(row[field]) ? row[field] : null])),
      fieldsPresent, numericFieldsValid: object && fieldsPresent.length === TZ_FIELDS.length &&
        TZ_FIELDS.every(field => typeof row[field] === 'number' && Number.isFinite(row[field])) };
    });
    return { year: Number(key), rawType: rawType(value), totalAnchors: Array.isArray(value) ? value.length : null,
      returnedAnchors: anchors.length, limit: TZ_ANCHOR_LIMIT,
      complete: Array.isArray(value) && value.length <= TZ_ANCHOR_LIMIT && anchors.every(row => row.numericFieldsValid), anchors };
  });
  return { presence: raw === undefined ? 'missing' : raw === null ? 'null' : 'present', type: rawType(raw),
    totalYears: plainObject(raw) ? keys.length : null, returnedYears: years.length, limit: TZ_YEAR_LIMIT,
    invalidYearCount: keys.length - validYears.length, years,
    complete: plainObject(raw) && keys.length === validYears.length && keys.length <= TZ_YEAR_LIMIT && years.every(row => row.complete) };
}

// HelperCtrl installs other.tzInfo || {} on every normal response carrying ms.
// Preserve only its finite timezone inputs, never an arbitrary Other payload.
// Missing/null/empty and a normal object without a usable anchor have the same
// formatter fallback. A malformed/unsupported shape must not become fallback.
function timezoneState(raw) {
  const input = { presence: raw === undefined ? 'missing' : raw === null ? 'null' : 'present', type: rawType(raw),
    normal: null, transitionYearCount: null, splitMap: null };
  const unavailable = reasonCode => ({ known: false, reasonCode, input,
    effective: { kind: 'unreadable', reasonCode, type: input.type, normal: input.normal,
      transitionYearCount: input.transitionYearCount, splitMap: input.splitMap } });
  if (raw !== null && raw !== undefined && !plainObject(raw)) return unavailable('CUSTOMER_DAY_TIMEZONE_SHAPE_UNREADABLE');
  const tz = raw || {};
  const normal = tz.normal;
  if (plainObject(normal)) input.normal = Object.fromEntries(TZ_FIELDS.map(key => [key,
    { rawType: rawType(normal[key]), value: safeScalar(normal[key]) }]));
  input.splitMap = timezoneTableProjection(tz);
  let emptyTransitionYears = [];
  if (tz.splitMap !== null && tz.splitMap !== undefined) {
    if (!plainObject(tz.splitMap)) return unavailable('CUSTOMER_DAY_TRANSITION_MAP_UNREADABLE');
    input.transitionYearCount = Object.keys(tz.splitMap).length;
    // The current official login supplies listed years whose arrays are all
    // empty. mo's selector visits no anchor in those arrays and uses normal.
    // Nonempty/unreadable/over-limit tables remain outside this adapter.
    if (input.transitionYearCount) {
      if (!input.splitMap.complete || input.splitMap.years.some(year => year.totalAnchors !== 0)) return unavailable('CUSTOMER_DAY_TRANSITIONS_NOT_IN_FINITE_SCOPE');
      emptyTransitionYears = input.splitMap.years.map(year => year.year);
    }
  }
  if (normal === null || normal === undefined || plainObject(normal) && (!normal.ms || !normal.secNum)) {
    return { known: true, reasonCode: null, input, effective: { kind: 'same-process-date-fallback', emptyTransitionYears } };
  }
  if (!plainObject(normal) || normal.type !== 0 || !positive(normal.ms) || !positive(normal.secNum) ||
      !/^\d{14}$/.test(String(normal.secNum)) || Object.hasOwn(normal, 'tzo') && !Number.isSafeInteger(normal.tzo)) {
    return unavailable('CUSTOMER_DAY_NORMAL_ANCHOR_UNREADABLE');
  }
  return { known: true, reasonCode: null, input, effective: { kind: 'normal-anchor', type: 0, ms: normal.ms,
    secNum: normal.secNum, tzoPresent: Object.hasOwn(normal, 'tzo'), tzo: Object.hasOwn(normal, 'tzo') ? normal.tzo : null,
    emptyTransitionYears } };
}

function sameSource(source, expected, context) {
  return !!source && !!expected && source.contextKey === customerContextKey(context) && source.kind === 'response' &&
    source.transport === 'answered' && source.connectionEpoch === context.connectionEpoch &&
    source.method === expected.method && source.requestSequence === expected.requestSequence &&
    source.wireKey === expected.wireKey && source.responseRef === expected.responseRef;
}
function completeSnapshot(view, context, source, uid) {
  const cell = one => {
    const observed = one?.source;
    return one?.current === true && knownCustomerCell(one) && !!observed && observed.contextKey === customerContextKey(context) &&
      observed.kind === 'response' && observed.transport === 'answered' && observed.connectionEpoch === context.connectionEpoch &&
      (sameSource(observed, source, context) || isNormalSyncMethod(observed.method));
  };
  const collection = one => one?.current === true && one.presence === 'present' && one.state === 'known' &&
    one.complete === true && one.truncated === false && one.sourceProvidedCollectionComplete === true &&
    one.decodedComplete === true && cell(one);
  const counter = view?.eligibilityInputs?.count107;
  return view?.current === true && view.identity?.verified === true && sameCustomerContext(view.context, context) &&
    cell(view.identity.uid) && scalar(view.identity.uid) === uid && cell(view.uid) && scalar(view.uid) === uid &&
    collection(view.orderMap) && collection(view.orderStockList) && !!counter &&
    COUNTER_FIELDS.every(key => cell(counter[key])) && scalar(counter.uid) === uid && scalar(counter.type) === 107;
}

export function createCustomerGenerationFacts({ store, isCurrent, clock, readView, verificationLease }) {
  store.run(`CREATE TABLE IF NOT EXISTS backend_customer_generation_days(
    receipt_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    context_key TEXT NOT NULL,connection_epoch INTEGER NOT NULL,request_sequence INTEGER NOT NULL,
    response_ref TEXT NOT NULL,payload_json TEXT NOT NULL,payload_fingerprint TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
  // Every day/identity read is bounded by its exact execution context or
  // matched response. Avoid scanning historical login payloads on each read.
  store.run(`CREATE INDEX IF NOT EXISTS backend_customer_generation_day_context ON backend_customer_generation_days(
    owner_ref,account_ref,subject_ref,context_key,request_sequence DESC)`);
  store.run(`CREATE INDEX IF NOT EXISTS backend_customer_generation_day_response ON backend_customer_generation_days(
    owner_ref,account_ref,subject_ref,response_ref)`);
  store.run(`CREATE TABLE IF NOT EXISTS backend_session_snapshot_refresh_limits(
    owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,official_uid INTEGER NOT NULL,
    anchor_ref TEXT NOT NULL,attempt INTEGER NOT NULL CHECK(attempt>=0 AND attempt<=3),updated_at TEXT NOT NULL,
    PRIMARY KEY(owner_ref,account_ref,subject_ref))`);
  for (const action of ['UPDATE', 'DELETE']) store.run(`CREATE TRIGGER IF NOT EXISTS backend_customer_generation_days_no_${action.toLowerCase()}
    BEFORE ${action} ON backend_customer_generation_days BEGIN SELECT RAISE(ABORT,'customer day evidence is append only'); END`);
  const actorCurrent = context => {
    const result = isCurrent(context);
    if (result?.then) throw new TypeError('Customer day current-context guard must be synchronous');
    return result === true;
  };
  const currentLoginBinding = (version, context, uid) => {
    const binding = version?.profileBinding;
    return plainObject(binding) && binding.contractId === version.contractId && binding.ownerRef === context.ownerRef &&
      binding.accountRef === String(context.accountRef) && binding.subjectRef === context.subjectRef &&
      binding.ownerEpoch === context.ownerEpoch && binding.runEpoch === context.runEpoch &&
      binding.connectionEpoch === context.connectionEpoch && binding.officialUid === uid &&
      binding.loginResponseRef === version.loginResponseRef && positive(uid);
  };
  function latest(context) {
    const row = store.get('SELECT * FROM backend_customer_generation_days WHERE owner_ref=? AND account_ref=? AND subject_ref=? AND context_key=? ORDER BY request_sequence DESC LIMIT 1',
      context.ownerRef, context.accountRef, context.subjectRef, customerContextKey(context));
    const payload = row ? parseStored(row.payload_json, '顾客生成日期来源') : null;
    return { row, payload, intact: !!payload && fingerprint(payload) === row.payload_fingerprint && sameCustomerContext(payload.context, context) };
  }
  function append(context, observation, payload) {
    const hash = fingerprint(payload), receiptRef = 'customer-generation-day:' + hash;
    store.transaction(() => {
      store.run('INSERT OR IGNORE INTO backend_customer_generation_days VALUES(?,?,?,?,?,?,?,?,?,?,?)', receiptRef,
        context.ownerRef, context.accountRef, context.subjectRef, customerContextKey(context), context.connectionEpoch,
        observation.requestSequence, observation.responseRef, JSON.stringify(payload), hash, store.nowIso());
      if (payload.kind === 'complete-login-day' && payload.officialDay.known === true) {
        // Only a real complete normal login with a proved current day resets
        // this technical retry budget. Partial frames and caller time cannot.
        store.run(`INSERT INTO backend_session_snapshot_refresh_limits VALUES(?,?,?,?,?,0,?) ON CONFLICT(owner_ref,account_ref,subject_ref)
          DO UPDATE SET official_uid=excluded.official_uid,anchor_ref=excluded.anchor_ref,attempt=0,updated_at=excluded.updated_at`,
        context.ownerRef, context.accountRef, context.subjectRef, payload.officialUid, receiptRef, store.nowIso());
      }
    });
    return { accepted: true, changed: true, receiptRef, known: payload.officialDay.known, reasonCode: payload.officialDay.reasonCode };
  }
  function ingest({ context: supplied, observation }) {
    const context = customerContext(supplied);
    const version = observation?.versionEvidence, value = observation?.value;
    if (!context || !actorCurrent(context) || observation?.source !== 'response' || observation.transport !== 'answered' ||
        observation.envelopeOk !== true || observation.dsName !== 'G.ISyncData' || observation.rejected === true ||
        observation.messagePresent === true && observation.noticeOnly !== true || !plainObject(value) || !plainObject(value['2']) ||
        observation.connectionEpoch !== context.connectionEpoch || !positive(observation.requestSequence) || !reference(observation.responseRef) ||
        typeof observation.method !== 'string' || !/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(observation.method) ||
        typeof observation.wireKey !== 'string' || observation.wireKey.length > 128 || !/^ws\|\d+\|[1-9]\d*$/.test(observation.wireKey) ||
        Number(observation.wireKey.split('|').at(-1)) !== observation.requestSequence ||
        !currentOfficialSourceEvidence(version) || version.protocolVersion !== SERVER_VERSION_PROTOCOL_CONTRACT || !reference(version.loginResponseRef) ||
        observation.protocolVersion != null && observation.protocolVersion !== version.protocolVersion &&
          !(observation.reportedServerVersion === observation.protocolVersion &&
            verifyOfficialServerVersionFrame({ versionEvidence: version, frameProtocolVersion: observation.protocolVersion,
              frameReportedServerVersion: observation.reportedServerVersion, context, officialUid: version.profileBinding?.officialUid })) ||
        !positive(value['2']['3']) || observation.serverMs !== value['2']['3']) return { accepted: false };
    const view = readView(context), currentClock = clock(context.subjectRef);
    const profile = value['7']?.['0'], uid = version?.profileBinding?.officialUid;
    if (!currentLoginBinding(version, context, uid) ||
        plainObject(profile) && Object.hasOwn(profile, '0') && profile['0'] !== uid ||
        observation.method === 'index.login' && (profile?.['0'] !== uid || version.loginResponseRef !== observation.responseRef)) return { accepted: false };
    const previous = latest(context);
    if (previous.row && observation.requestSequence <= previous.row.request_sequence) return { accepted: false, replayed: true };
    const tz = timezoneState(value['2']['11']), timezoneFingerprint = fingerprint(tz.effective);
    const source = { contextKey: customerContextKey(context), method: observation.method, connectionEpoch: observation.connectionEpoch,
      requestSequence: observation.requestSequence, wireKey: observation.wireKey, responseRef: observation.responseRef,
      version: clone(version), dataSourceProofFingerprint: currentOfficialSourceEvidence(version).proofFingerprint };
    const completeLogin = observation.method === 'index.login' && version.loginResponseRef === observation.responseRef &&
      profile?.['0'] === uid && completeSnapshot(view, context, observation, uid);
    const completeDayLogin = observation.method === 'index.login' && version.loginResponseRef === observation.responseRef &&
      profile?.['0'] === uid;
    if (!completeDayLogin) {
      if (!previous.intact) return { accepted: false, reasonCode: 'CUSTOMER_GENERATION_FRESH_LOGIN_REQUIRED' };
      if (previous.payload.timezoneFingerprint === timezoneFingerprint && tz.known) return observation.method === 'index.login'
        ? { accepted: false, reasonCode: 'CUSTOMER_GENERATION_COMPLETE_LOGIN_REQUIRED' }
        : { accepted: true, changed: false, receiptRef: previous.row.receipt_ref,
          known: previous.payload.officialDay.known, reasonCode: previous.payload.officialDay.reasonCode };
      // This is metadata-only invalidation. It cannot derive a day or UID from
      // a partial reply, and later matching inputs cannot resurrect the proof.
      const reasonCode = tz.known ? 'CUSTOMER_GENERATION_TIMEZONE_CHANGED_FRESH_LOGIN_REQUIRED' : tz.reasonCode;
      if (previous.payload.kind === 'timezone-invalidation' && previous.payload.timezoneFingerprint === timezoneFingerprint) {
        return { accepted: true, changed: false, receiptRef: previous.row.receipt_ref, known: false, reasonCode };
      }
      const officialDay = { known: false, reasonCode, currentRecheckRequired: true, serverResetPerformed: false,
        invalidatedDayReceiptRef: previous.payload.officialDay.invalidatedDayReceiptRef ?? previous.row.receipt_ref };
      return append(context, observation, { kind: 'timezone-invalidation', context, officialUid: uid, officialDay,
        runtimeOffsetEvidence: null, timezoneInput: tz.input, timezoneEffective: tz.effective, timezoneFingerprint,
        source, observedOfficialUid: plainObject(profile) && Object.hasOwn(profile, '0') ? profile['0'] : null,
        rawCountPreserved: true, noServerResetPerformed: true });
    }
    let runtimeOffsetEvidence = null;
    if (positive(currentClock.nowMs)) {
      const offsetMinutes = new Date(currentClock.nowMs).getTimezoneOffset();
      const start = Math.floor((currentClock.nowMs - offsetMinutes * 60000) / DAY) * DAY + offsetMinutes * 60000;
      const body = { kind: 'same-process-date-runtime-offset/v1', context, responseRef: observation.responseRef,
        sampledAtMs: currentClock.nowMs, offsetMinutes, dayStartOffsetMinutes: new Date(start).getTimezoneOffset(),
        dayEndOffsetMinutes: new Date(start + DAY - 1).getTimezoneOffset() };
      runtimeOffsetEvidence = { ...body, proofRef: 'device-node-date-offset:' + fingerprint(body) };
    }
    const rTimeMs = customerDateMs(observation.value?.['7']?.['4']?.['107']?.['4']);
    const officialDay = deriveCustomerOfficialDay({ context, observation, clock: currentClock, rTimeMs, runtimeOffsetEvidence });
    const payload = { kind: 'complete-login-day', context, officialUid: uid, officialDay, runtimeOffsetEvidence,
      customerSnapshotComplete: completeLogin,
      timezoneInput: tz.input, timezoneEffective: tz.effective, timezoneFingerprint, source,
      dayObservationClock: currentClock.available === true && currentClock.source === 'official-anchor-monotonic' &&
        currentClock.connectionEpoch === context.connectionEpoch && positive(currentClock.nowMs) &&
        Number.isFinite(currentClock.lowerBoundMs) && Number.isFinite(currentClock.upperBoundMs) ? {
          source: currentClock.source, connectionEpoch: currentClock.connectionEpoch, nowMs: currentClock.nowMs,
          lowerBoundMs: currentClock.lowerBoundMs, upperBoundMs: currentClock.upperBoundMs } : null,
      rawCountPreserved: true, noServerResetPerformed: true };
    return append(context, observation, payload);
  }
  function read(supplied, suppliedView = null) {
    const context = customerContext(supplied), current = !!context && actorCurrent(context);
    if (!context) return freeze({ current: false, officialDay: { known: false, reasonCode: 'CUSTOMER_GENERATION_CONTEXT_REQUIRED' }, count107: null,
      snapshotRefresh: { required: false, snapshotRef: null, reasonCode: 'CUSTOMER_GENERATION_CONTEXT_REQUIRED', causeCode: null,
        retryAttempt: 0, maxAttempts: null, retryNotBeforeOfficialMs: null, originalDayEndMs: null } });
    const { row, payload, intact } = latest(context);
    // Assessment may pass its already-current snapshot for this synchronous
    // read only. The full context comparison prevents reuse across epochs.
    const view = suppliedView && sameCustomerContext(suppliedView.context, context) ? suppliedView : readView(context),
      counter = view.eligibilityInputs?.count107, c = clock(context.subjectRef);
    const officialDay = intact ? clone(payload.officialDay) : { known: false, reasonCode: 'CUSTOMER_GENERATION_DAY_NOT_OBSERVED' };
    const daySource = officialDay.source;
    const sourceEvidence = currentOfficialSourceEvidence(payload?.source?.version);
    const loginSnapshotCurrent = intact && payload.kind === 'complete-login-day' && payload.officialUid === payload.source?.version?.profileBinding?.officialUid &&
      currentLoginBinding(payload.source?.version, context, payload.officialUid) &&
      payload.source?.method === 'index.login' && payload.source?.dataSourceProofFingerprint === sourceEvidence?.proofFingerprint &&
      payload.source?.version?.loginResponseRef === payload.source?.responseRef;
    const sourceCurrent = loginSnapshotCurrent &&
      daySource?.contextKey === customerContextKey(context) && daySource.officialUid === payload.officialUid &&
      daySource.method === 'index.login' && daySource.responseRef === payload.source.responseRef &&
      daySource.connectionEpoch === payload.source.connectionEpoch &&
      sameSource({ ...payload.source, kind: 'response', transport: 'answered' }, daySource, context) &&
      daySource.version?.sourceProofFingerprint === sourceEvidence?.proofFingerprint;
    const dayCurrent = current && sourceCurrent && c.available && c.source === 'official-anchor-monotonic' && c.connectionEpoch === context.connectionEpoch && officialDay.known
      && positive(c.nowMs) && Number.isFinite(c.lowerBoundMs) && Number.isFinite(c.upperBoundMs) && c.lowerBoundMs <= c.nowMs && c.upperBoundMs >= c.nowMs
      && c.lowerBoundMs >= officialDay.startMs && c.upperBoundMs < officialDay.endMs
      && (officialDay.timezoneProof?.kind !== 'same-process-date-runtime-offset/v1'
        || new Date(c.nowMs).getTimezoneOffset() === officialDay.timezoneProof.timezoneOffsetMinutes);
    // Expiry never derives a replacement date from an old login. The finite
    // supervisor port must obtain a new normal complete login snapshot instead.
    // Requiring the lower clock bound past midnight avoids closing a connection
    // merely because its uncertainty interval touches the next day.
    const snapshotExpired = current && sourceCurrent && officialDay.known === true && positive(officialDay.endMs) &&
      c.available === true && c.source === 'official-anchor-monotonic' && c.connectionEpoch === context.connectionEpoch &&
      positive(c.nowMs) && Number.isFinite(c.lowerBoundMs) && Number.isFinite(c.upperBoundMs) &&
      c.lowerBoundMs <= c.nowMs && c.upperBoundMs >= c.nowMs && c.lowerBoundMs >= officialDay.endMs;
    const observedClock = payload?.dayObservationClock;
    const boundaryRetryEligible = loginSnapshotCurrent && officialDay.known === false &&
      officialDay.reasonCode === 'CUSTOMER_DAY_CLOCK_INTERVAL_CROSSES_BOUNDARY' &&
      observedClock?.source === 'official-anchor-monotonic' && observedClock.connectionEpoch === context.connectionEpoch &&
      positive(observedClock.nowMs) && Number.isFinite(observedClock.lowerBoundMs) && Number.isFinite(observedClock.upperBoundMs) &&
      observedClock.lowerBoundMs <= observedClock.nowMs && observedClock.upperBoundMs >= observedClock.nowMs;
    const boundaryReady = current && boundaryRetryEligible && c.available === true && c.source === 'official-anchor-monotonic' &&
      c.connectionEpoch === context.connectionEpoch && positive(c.nowMs) && Number.isFinite(c.lowerBoundMs) && Number.isFinite(c.upperBoundMs) &&
      c.lowerBoundMs <= c.nowMs && c.upperBoundMs >= c.nowMs && c.lowerBoundMs >= observedClock.upperBoundMs + 30000;
    const limit = store.get('SELECT official_uid,attempt FROM backend_session_snapshot_refresh_limits WHERE owner_ref=? AND account_ref=? AND subject_ref=?',
      context.ownerRef, context.accountRef, context.subjectRef);
    const attempts = limit ? positive(payload?.officialUid) && limit.official_uid === payload.officialUid ? limit.attempt : 3 : 0;
    const refreshNeeded = snapshotExpired || boundaryReady;
    const snapshotRefresh = { required: !!refreshNeeded, snapshotRef: loginSnapshotCurrent ? row.receipt_ref : null,
      reasonCode: refreshNeeded ? 'CUSTOMER_OFFICIAL_DAY_SNAPSHOT_EXPIRED'
        : !current ? 'CUSTOMER_GENERATION_CONTEXT_NOT_CURRENT' : !loginSnapshotCurrent ? 'CUSTOMER_GENERATION_COMPLETE_LOGIN_REQUIRED'
        : boundaryRetryEligible ? 'CUSTOMER_DAY_BOUNDARY_RETRY_NOT_DUE' : null,
      causeCode: snapshotExpired ? 'EXPIRED_COMPLETE_LOGIN_DAY' : boundaryRetryEligible ? 'CUSTOMER_DAY_CLOCK_INTERVAL_CROSSES_BOUNDARY' : null,
      retryAttempt: attempts, maxAttempts: null,
      retryNotBeforeOfficialMs: boundaryRetryEligible ? observedClock.upperBoundMs + 30000 : null,
      originalDayEndMs: sourceCurrent && positive(officialDay.endMs) ? officialDay.endMs : null };
    if (!dayCurrent && officialDay.known) Object.assign(officialDay, { known: false, reasonCode: 'CUSTOMER_GENERATION_DAY_CURRENT_READ_REQUIRED' });
    const countCurrent = current && counter && COUNTER_FIELDS.every(key => counter[key]?.current && knownCustomerCell(counter[key]) &&
      counter[key].source?.connectionEpoch === context.connectionEpoch && isNormalSyncMethod(counter[key].source?.method))
      && scalar(counter.uid) === scalar(view.identity.uid) && scalar(counter.type) === 107;
    const count107 = { current: !!countCurrent, uid: scalar(counter?.uid), type: scalar(counter?.type), tdyCnt: scalar(counter?.tdyCnt),
      totCnt: scalar(counter?.totCnt), rTimeMs: scalar(counter?.rTime), source: counter?.tdyCnt?.source ?? null };
    const noCurrentWrite = current && !verificationLease({ subjectRef: context.subjectRef, ownerRef: context.ownerRef }).active
      && !store.get('SELECT 1 FROM backend_operations WHERE subject_ref=? AND write_slot=1 LIMIT 1', context.subjectRef);
    return freeze({ current, officialDay, count107, snapshotRefresh, dayReceiptRef: intact ? row.receipt_ref : null,
      customerSnapshotComplete: !!(loginSnapshotCurrent && payload.customerSnapshotComplete === true &&
        completeSnapshot(view, context, payload.source, payload.officialUid)),
      daySource: intact ? { receiptRef: row.receipt_ref, payloadFingerprint: row.payload_fingerprint,
        timezoneInput: payload.timezoneInput, timezoneEffective: payload.timezoneEffective ?? null,
        runtimeOffsetEvidence: payload.runtimeOffsetEvidence } : null,
      localSession: { context, current, noPendingButlerReport: true, noCurrentWrite,
        proofRef: 'new-kernel/no-butler-report-producer/finite-registered-methods/v1' },
      guestState: { context, current, mode: 'headless-no-synthetic-roaming', ids: [],
        proofRef: 'G480/OrderNpcMgr.constructor/visitNpcIds-empty+new-kernel-no-roaming-producer/v1' } });
  }
  return Object.freeze({ ingest, read });
}
