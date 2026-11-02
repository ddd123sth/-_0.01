import { fingerprint, freeze, plainObject } from '../../common.mjs';
import { customerContext, customerContextKey, sameCustomerContext } from './wire-facts.mjs';
import { currentOfficialSourceEvidence } from '../../official-data-evidence.mjs';
import { officialActionContractId } from '../../official-version-profile.mjs';

const DAY_MS = 86400000;
const positive = value => Number.isSafeInteger(value) && value > 0;
const offset = value => Number.isSafeInteger(value) && Math.abs(value) <= 14 * 60;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;

// Reviewed source-block hashes are located at runtime; offsets and source
// release labels never authorize this shared clock fact by themselves.
export const CUSTOMER_DAY_SOURCE = freeze({
  sourceAction: 'session.official-day',
  protocolVersion: '480.0.0',
  sourceBlocks: { newDateMode: 'a3f4ca621bc7dcd1ef002fd0409093f83e773d90840131e6c3352bd49bf89407',
    other: '926f8e2ecccfd71d9b38e011ffc92221a55cc836941a6e71dd59459056f1400f',
    refreshBoundary: 'e444bf600ffc597e1c4b3ac8498fc216619b5f241a83fa3b21624fc3068155d2',
    refreshDefault: '21bed5e8b112f54179ab50a715550bd6309af518367729af41449648d3add61e',
    helperSync: 'e660bc7f1b4ac29f83d6837ba617312a3fe96b163e91fe88202bbb83fc28e2b4',
    moFormatter: 'd1a3fa92e134a159e95fd8593d2be2ef1d9d1e9fe6858795457909c80924e2d7',
    moAnchor: '74ff74ab7169dcf6f0fa781589840c19d0070997b69d5550101b5a94d93fc1f9',
    moSetTimezone: '99be1a955cbfcd3e7ba116e29d11be9503f155c9a59a8f8c5a384d27940608d3' }
});

function wallClockMs(secNum) {
  if (!Number.isSafeInteger(secNum) || !/^\d{14}$/.test(String(secNum))) return null;
  const text = String(secNum), parts = [text.slice(0, 4), text.slice(4, 6), text.slice(6, 8),
    text.slice(8, 10), text.slice(10, 12), text.slice(12, 14)].map(Number);
  const [year, month, day, hour, minute, second] = parts;
  if (year < 1970 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second), date = new Date(ms);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day &&
    date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second ? ms : null;
}

// Exactly the finite normal-anchor branch. mo Ae scans sorted year keys and
// each year's array for an actual start/end anchor. Nonempty year KEYS with
// empty arrays leave both anchors null, so Ae then selects normal. This is not
// evidence of a DST transition and must not be rejected as one. Actual listed
// transition anchors remain outside this fixed-24h adapter; they are never
// ignored or converted to local-device fallback. ms_sto/utc/IUsr.tzOffset are NOT new-mode
// formatter authority: HelperCtrl installs other.tzInfo || {}, then mo.DATE
// fmt selects a usable anchor or falls back to the process's local Date.
function timezoneAnchor(other) {
  const present = Object.hasOwn(other, '11'), raw = present ? other['11'] : null;
  if (raw !== null && raw !== undefined && !plainObject(raw)) return { error: 'CUSTOMER_DAY_TIMEZONE_SHAPE_UNREADABLE' };
  const tz = raw || {};
  let splitMapProof = { presence: 'missing', complete: true, totalYears: 0, totalAnchors: 0, years: [], fingerprint: null };
  if (Object.hasOwn(tz, 'splitMap') && tz.splitMap !== null && tz.splitMap !== undefined) {
    if (!plainObject(tz.splitMap)) return { error: 'CUSTOMER_DAY_TRANSITION_MAP_UNREADABLE' };
    const years = Object.keys(tz.splitMap).sort();
    if (years.length > 16 || years.some(year => !/^\d{4}$/.test(year) || Number(year) < 1970 || Number(year) > 9999)) {
      return { error: 'CUSTOMER_DAY_TRANSITION_YEARS_UNREADABLE_OR_LIMIT' };
    }
    // Validate every original array; never inspect a truncated public summary
    // or mistake a malformed member for an empty year. The actual c5 normal
    // login provided 2022..2028, all seven arrays explicitly empty.
    if (years.some(year => !Array.isArray(tz.splitMap[year]) || tz.splitMap[year].length > 16)) {
      return { error: 'CUSTOMER_DAY_TRANSITION_ARRAY_UNREADABLE_OR_LIMIT' };
    }
    const totalAnchors = years.reduce((sum, year) => sum + tz.splitMap[year].length, 0);
    if (totalAnchors !== 0) return { error: 'CUSTOMER_DAY_TRANSITIONS_NOT_IN_FINITE_SCOPE' };
    splitMapProof = { presence: 'present', complete: true, totalYears: years.length, totalAnchors,
      years: years.map(year => ({ year: Number(year), anchorCount: 0 })), fingerprint: fingerprint(tz.splitMap) };
  } else if (Object.hasOwn(tz, 'splitMap')) {
    splitMapProof.presence = tz.splitMap === null ? 'null' : 'undefined';
  }
  const normal = tz.normal;
  // The actual formatter only uses normal when both ms and secNum are truthy.
  if (normal === null || normal === undefined || plainObject(normal) && (!normal.ms || !normal.secNum)) {
    return { fallback: true, presence: !present ? 'missing' : raw === null ? 'null' : 'present-no-usable-anchor', splitMapProof };
  }
  if (!plainObject(normal) || normal.type !== 0 || !positive(normal.ms)) return { error: 'CUSTOMER_DAY_NORMAL_ANCHOR_UNREADABLE' };
  const wallMs = wallClockMs(normal.secNum), utcOffsetMinutes = wallMs === null ? null : (wallMs - normal.ms) / 60000;
  if (!offset(utcOffsetMinutes) || Object.hasOwn(normal, 'tzo') && normal.tzo !== -utcOffsetMinutes) return { error: 'CUSTOMER_DAY_NORMAL_ANCHOR_OFFSET_INVALID' };
  return { utcOffsetMinutes, proof: { kind: 'matched-other-tzinfo-normal/v1', path: ['2', '11'],
    normal: { type: 0, ms: normal.ms, secNum: normal.secNum, tzo: Object.hasOwn(normal, 'tzo') ? normal.tzo : null },
    splitMap: splitMapProof, selection: 'no-listed-start-or-end-anchor-then-normal' } };
}

// Pure derivation only. observation is an already accepted normal ingress for
// context, not an arbitrary archived response. The caller must recheck current
// ownership before using the receipt. Only 2.3, 2.11 and 7.0.0 are inspected.
// For the actual official-client fallback, runtimeOffsetEvidence MUST be made
// by the current Android Node process (never the workstation), using:
//   offsetMinutes = new Date(clock.nowMs).getTimezoneOffset();
//   start = floor((clock.nowMs - offsetMinutes*60000)/DAY_MS)*DAY_MS
//           + offsetMinutes*60000;
//   dayStartOffsetMinutes = new Date(start).getTimezoneOffset();
//   dayEndOffsetMinutes = new Date(start+DAY_MS-1).getTimezoneOffset();
// Bind these readings to the exact current response/context/proofRef. The
// explicit interval-edge readings exclude an unsupported DST transition day.
export function deriveCustomerOfficialDay({ context: supplied, observation, clock, rTimeMs = null, runtimeOffsetEvidence = null } = {}) {
  const context = customerContext(supplied);
  const initial = { version: 'customer-observed-client-day/v1', context, known: false, readOnly: true,
    currentRecheckRequired: true, serverResetPerformed: false, serverAbsoluteResetProven: false,
    sourceContract: CUSTOMER_DAY_SOURCE, key: null, startMs: null, endMs: null, utcOffsetMinutes: null,
    refresh: { known: false, rTimeMs: positive(rTimeMs) ? rTimeMs : null, needsRefresh: null } };
  const unknown = reasonCode => freeze({ ...initial, reasonCode, proofRef: null });
  const value = observation?.value, version = observation?.versionEvidence,
    currentSource = currentOfficialSourceEvidence(version), clockSourceProof = version?.sourceProofs?.['session.official-day'];
  const binding = version?.profileBinding, uid = value?.['7']?.['0']?.['0'];
  const bindingCurrent = binding?.ownerRef === context?.ownerRef && binding.accountRef === String(context?.accountRef) &&
    binding.subjectRef === context?.subjectRef && binding.ownerEpoch === context?.ownerEpoch &&
    binding.runEpoch === context?.runEpoch && binding.connectionEpoch === context?.connectionEpoch &&
    binding.officialUid === uid && binding.loginResponseRef === version?.loginResponseRef &&
    binding.dataSnapshotId === version?.dataSnapshotId;
  if (!context || observation?.connectionEpoch !== context.connectionEpoch || observation.source !== 'response' || observation.transport !== 'answered' ||
      observation.envelopeOk !== true || observation.dsName !== 'G.ISyncData' || observation.rejected === true ||
      observation.messagePresent === true && observation.noticeOnly !== true || !plainObject(value) || !plainObject(value['2']) ||
      !positive(uid) || !bindingCurrent || !positive(observation.requestSequence) || !reference(observation.responseRef) ||
      typeof observation.wireKey !== 'string' || observation.wireKey.length > 128 || !/^ws\|\d+\|[1-9]\d*$/.test(observation.wireKey) ||
      Number(observation.wireKey.split('|').at(-1)) !== observation.requestSequence ||
      typeof observation.method !== 'string' || !/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(observation.method) ||
      !currentSource || version.protocolVersion !== CUSTOMER_DAY_SOURCE.protocolVersion || !reference(version.loginResponseRef) ||
      clockSourceProof?.supported !== true || clockSourceProof.actionContractId !== officialActionContractId('session.official-day') ||
      clockSourceProof.coreContractId !== currentSource.contractId || clockSourceProof.sourceVersion !== version.gameVersion ||
      clockSourceProof.protocolVersion !== version.protocolVersion ||
      clockSourceProof.matchedBlocks?.filter(block => block.name.startsWith('day-')).length !== Object.keys(CUSTOMER_DAY_SOURCE.sourceBlocks).length) {
    return unknown('CUSTOMER_DAY_CURRENT_MATCHED_SOURCE_REQUIRED');
  }
  if (clock?.available !== true || clock.source !== 'official-anchor-monotonic' || clock.connectionEpoch !== context.connectionEpoch ||
      !positive(clock.nowMs) || !Number.isFinite(clock.lowerBoundMs) || !Number.isFinite(clock.upperBoundMs) ||
      clock.lowerBoundMs > clock.nowMs || clock.upperBoundMs < clock.nowMs) return unknown('CUSTOMER_DAY_CURRENT_OFFICIAL_CLOCK_REQUIRED');
  const other = value['2'], serverMs = other['3'];
  if (!positive(serverMs) || observation.serverMs !== serverMs || serverMs > clock.upperBoundMs) return unknown('CUSTOMER_DAY_OBSERVED_SERVER_TIME_REQUIRED');
  const source = { contextKey: customerContextKey(context), connectionEpoch: context.connectionEpoch, responseRef: observation.responseRef,
    requestSequence: observation.requestSequence, wireKey: observation.wireKey, method: observation.method, officialUid: value['7']['0']['0'],
    serverMs, serverRespondedMs: positive(observation.serverRespondedMs) ? observation.serverRespondedMs : null,
    version: { source: version.source, gameVersion: version.gameVersion, protocolVersion: version.protocolVersion,
      loginResponseRef: version.loginResponseRef, sourceProofFingerprint: currentSource.proofFingerprint,
      dayClockProofFingerprint: fingerprint(clockSourceProof), dataSnapshotId: version.dataSnapshotId,
      moSha256: clockSourceProof.moSha256 } };
  const anchor = timezoneAnchor(other);
  if (anchor.error) return unknown(anchor.error);
  let utcOffsetMinutes = anchor.utcOffsetMinutes, timezoneProof = anchor.proof;
  if (anchor.fallback) {
    const evidence = runtimeOffsetEvidence;
    if (!evidence || evidence.kind !== 'same-process-date-runtime-offset/v1' || !sameCustomerContext(context, customerContext(evidence.context)) ||
        evidence.responseRef !== observation.responseRef || !reference(evidence.proofRef) || evidence.sampledAtMs !== clock.nowMs || !offset(evidence.offsetMinutes) ||
        evidence.dayStartOffsetMinutes !== evidence.offsetMinutes || evidence.dayEndOffsetMinutes !== evidence.offsetMinutes) return unknown('CUSTOMER_DAY_SAME_PROCESS_RUNTIME_OFFSET_REQUIRED');
    utcOffsetMinutes = -evidence.offsetMinutes;
    timezoneProof = { kind: evidence.kind, proofRef: evidence.proofRef, responseRef: evidence.responseRef, sampledAtMs: evidence.sampledAtMs,
      context, timezoneOffsetMinutes: evidence.offsetMinutes, dayStartOffsetMinutes: evidence.dayStartOffsetMinutes,
      dayEndOffsetMinutes: evidence.dayEndOffsetMinutes, tzInfoPresence: anchor.presence, splitMap: anchor.splitMapProof, officialClientFallback: true };
  }
  const startMs = Math.floor((clock.nowMs + utcOffsetMinutes * 60000) / DAY_MS) * DAY_MS - utcOffsetMinutes * 60000;
  const endMs = startMs + DAY_MS;
  if (!positive(startMs) || clock.lowerBoundMs < startMs || clock.upperBoundMs >= endMs) return unknown('CUSTOMER_DAY_CLOCK_INTERVAL_CROSSES_BOUNDARY');
  if (serverMs < startMs || serverMs >= endMs || source.serverRespondedMs !== null &&
      (source.serverRespondedMs < startMs || source.serverRespondedMs >= endMs || source.serverRespondedMs > clock.upperBoundMs)) return unknown('CUSTOMER_DAY_NORMAL_READ_THIS_DAY_REQUIRED');
  const key = new Date(startMs + utcOffsetMinutes * 60000).toISOString().slice(0, 10);
  const refresh = !positive(rTimeMs) ? initial.refresh : rTimeMs > clock.upperBoundMs ? { known: false, rTimeMs, needsRefresh: null }
    : { known: true, rTimeMs, needsRefresh: startMs > rTimeMs };
  const body = { ...initial, known: true, reasonCode: anchor.fallback ? 'CUSTOMER_DAY_OBSERVED_CLIENT_RUNTIME_FALLBACK' : 'CUSTOMER_DAY_OBSERVED_SERVER_TIMEZONE_ANCHOR',
    key, startMs, endMs, utcOffsetMinutes, resetHour: 0, resetMinute: 0, source, timezoneProof, refresh };
  return freeze({ ...body, proofRef: 'customer-official-client-day:' + fingerprint(body) });
}
