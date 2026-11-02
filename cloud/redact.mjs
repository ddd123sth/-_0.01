// Server-side second-pass redaction. The client is not trusted for masking.
const MESSAGE_MAX = 1200;
const DIAGNOSTIC_MAX_BYTES = 4000;
const DIAGNOSTIC_KEYS = ['loginCode', 'loginCodeKey', 'serverMsgCode', 'code', 'summary', 'attempted', 'ok', 'status', 'transportFailure', 'retryable', 'userActionRequired', 'closureProven', 'attempt', 'retryAfterMs',
  'cause', 'reasonCode', 'action', 'retryAtMs', 'eventType', 'eventState', 'phase', 'method', 'runEpoch',
  'connectionEpoch', 'requestSequence', 'schemaVersion', 'truncated', 'sourceNamespace', 'loginKind',
  'remoteCode', 'transportCode', 'httpStatus', 'domains', 'reasons', 'readFailureKind', 'domainId', 'path', 'difference',
  'changedPaths', 'removedPaths', 'addedPaths', 'rawAnchorMatches', 'priorProjectionReceiptAvailable', 'proofAdvanced'];

const SECRET_PAIR = /((?:password|passwd|pwd|token|secret|authorization|auth|cookie|api[ _-]?key|access[ _-]?key|session)[^=&\s"']{0,20}\s*[:=]\s*)([^\s&,;"']+)/giu;
const PROXY_CREDS = /([A-Za-z0-9._%+-]+):([^\s:@/]+)@/gu;
const MASK = '[已隐去]';

export function redactText(value) {
  if (typeof value !== 'string') return '';
  let text = value.replace(PROXY_CREDS, `${MASK}@`);
  text = text.replace(SECRET_PAIR, `$1${MASK}`);
  if (text.length > MESSAGE_MAX) text = `${text.slice(0, MESSAGE_MAX - 3)}...`;
  return text;
}

function redactValue(value) {
  return typeof value === 'string' ? redactText(value) : value;
}

export function redactDiagnostic(input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) return null;
  const kept = {};
  for (const key of DIAGNOSTIC_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = input[key];
    if (['cause', 'reasonCode'].includes(key)) {
      if (typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(value)) kept[key] = value;
      continue;
    }
    if (['remoteCode', 'transportCode'].includes(key)) {
      if (Number.isSafeInteger(value) || typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(value)) kept[key] = value;
      continue;
    }
    if (['loginCode','serverMsgCode','code'].includes(key)) {
      if (Number.isSafeInteger(value) || typeof value === 'string' && value.length <= 128 && /^\$?[A-Za-z0-9_.:-]+$/.test(value)) kept[key] = value;
      continue;
    }
    if (key === 'loginCodeKey') {
      if (typeof value === 'string' && value.length <= 64 && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(value)) kept[key] = value;
      continue;
    }
    if (key === 'readFailureKind') {
      if (typeof value === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(value)) kept[key] = value;
      continue;
    }
    if (key === 'domainId') {
      if (typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value)) kept.domainId = value;
      continue;
    }
    if (key === 'path') {
      if (typeof value === 'string' && value.length <= 512 &&
          /^(?:backend\/[A-Za-z0-9_.\/-]+\.mjs:\d+:\d+)(?: > backend\/[A-Za-z0-9_.\/-]+\.mjs:\d+:\d+){0,5}$/.test(value)) kept.path = value;
      continue;
    }
    if (key === 'difference') {
      if (typeof value === 'string' && /^[a-z0-9-]{1,64}$/.test(value)) kept.difference = value;
      continue;
    }
    if (['rawAnchorMatches', 'priorProjectionReceiptAvailable', 'proofAdvanced'].includes(key)) {
      if (typeof value === 'boolean') kept[key] = value;
      continue;
    }
    if (['changedPaths', 'removedPaths', 'addedPaths'].includes(key)) {
      const semanticPath = item => typeof item === 'string' && item.length <= 192 && /^[A-Za-z0-9._*\[\]-]+$/.test(item);
      const values = Array.isArray(value) ? value : [];
      if (key === 'changedPaths') {
        const safe = values.slice(0, 16).flatMap(item => item && typeof item === 'object' && !Array.isArray(item) && semanticPath(item.path) &&
          (item.storedFingerprint === null || typeof item.storedFingerprint === 'string' && /^[a-f0-9]{64}$/.test(item.storedFingerprint)) &&
          (item.currentFingerprint === null || typeof item.currentFingerprint === 'string' && /^[a-f0-9]{64}$/.test(item.currentFingerprint))
          ? [{ path: item.path, storedFingerprint: item.storedFingerprint, currentFingerprint: item.currentFingerprint }] : []);
        kept.changedPaths = safe;
        if (!Array.isArray(value) || values.length > 16 || safe.length !== Math.min(values.length, 16)) kept.truncated = true;
      } else {
        const safe = values.filter(semanticPath).slice(0, 16);
        kept[key] = safe;
        if (!Array.isArray(value) || values.length > 16 || safe.length !== Math.min(values.length, 16)) kept.truncated = true;
      }
      continue;
    }
    if (['eventType', 'phase', 'method', 'sourceNamespace', 'loginKind'].includes(key)) {
      if (typeof value === 'string' && value.length <= 64 && /^[A-Za-z0-9_.:-]+$/.test(value)) kept[key] = value;
      continue;
    }
    if (key === 'eventState') {
      if (['requested', 'not-started', 'completed', 'incomplete', 'failed'].includes(value)) kept.eventState = value;
      continue;
    }
    if (key === 'status') {
      if (['cleanup_pending','waiting_network','scheduled','blocked','connected','stopped','suspended'].includes(value)) kept.status = value;
      continue;
    }
    if (['transportFailure','retryable','userActionRequired','closureProven','attempted','ok'].includes(key)) {
      if (typeof value === 'boolean') kept[key] = value;
      continue;
    }
    if (['attempt','retryAfterMs'].includes(key)) {
      if (Number.isSafeInteger(value) && value >= 0) kept[key] = value;
      continue;
    }
    if (['runEpoch', 'connectionEpoch', 'requestSequence', 'httpStatus'].includes(key)) {
      if (Number.isSafeInteger(value) && value >= 0) kept[key] = value;
      continue;
    }
    if (key === 'schemaVersion') {
      if (Number.isSafeInteger(value) && value > 0) kept.schemaVersion = value;
      continue;
    }
    if (key === 'truncated') {
      if (typeof value === 'boolean') kept.truncated = value;
      continue;
    }
    if (['domains', 'reasons'].includes(key)) {
      if (!Array.isArray(value)) continue;
      const safe = value.filter(item => typeof item === 'string' && item.length <= 64 && /^[A-Za-z0-9_.:-]+$/.test(item)).slice(0, 16);
      if (safe.length) kept[key] = safe;
      if (safe.length !== value.length || value.length > 16) kept.truncated = true;
      continue;
    }
    if (key === 'action') {
      if (typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value)) kept.action = value;
      continue;
    }
    if (key === 'retryAtMs') {
      if (Number.isSafeInteger(value) && value > 0) kept.retryAtMs = value;
      continue;
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
      kept[key] = redactValue(value);
    }
  }
  if (!Object.keys(kept).length) return null;
  let serialized = JSON.stringify(kept);
  if (Buffer.byteLength(serialized, 'utf8') <= DIAGNOSTIC_MAX_BYTES) return serialized;
  // Shrink the free-text field first, then drop remaining keys to stay in range.
  if (typeof kept.summary === 'string') {
    let room = kept.summary.length;
    while (room > 0 && Buffer.byteLength(JSON.stringify(kept), 'utf8') > DIAGNOSTIC_MAX_BYTES) {
      room = Math.floor(room / 2);
      kept.summary = `${kept.summary.slice(0, room)}...`;
    }
    serialized = JSON.stringify(kept);
    if (Buffer.byteLength(serialized, 'utf8') <= DIAGNOSTIC_MAX_BYTES) return serialized;
  }
  for (const key of ['changedPaths', 'addedPaths', 'removedPaths', 'domains', 'reasons', 'path']) {
    if (!Object.hasOwn(kept, key)) continue;
    delete kept[key];
    kept.truncated = true;
    serialized = JSON.stringify(kept);
    if (Buffer.byteLength(serialized, 'utf8') <= DIAGNOSTIC_MAX_BYTES) return Object.keys(kept).length ? serialized : null;
  }
  const essential = new Set(['truncated', 'code', 'reasonCode', 'cause', 'domainId', 'difference', 'rawAnchorMatches', 'priorProjectionReceiptAvailable', 'proofAdvanced']);
  for (const key of Object.keys(kept)) {
    if (essential.has(key)) continue;
    delete kept[key]; kept.truncated = true;
    serialized = JSON.stringify(kept);
    if (Buffer.byteLength(serialized, 'utf8') <= DIAGNOSTIC_MAX_BYTES) return serialized;
  }
  return null;
}

export function messageLimit() { return MESSAGE_MAX; }
