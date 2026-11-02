const SDK_LOGIN_CODES = Object.freeze({
  '2001': 'single-session', '2002': 'single-session', '2006': 'single-session',
  '2011': 'needs-credentials', '2012': 'needs-credentials',
  '2004': 'account-disabled', '2017': 'account-disabled', '902053': 'account-disabled',
  '902051': 'wait-time', '902050': 'wait-egress',
  '2037': 'refresh-config',
});
const OWNERSHIP_CONFLICT_CODES = new Set(['OFFICIAL_IDENTITY_OWNER_CHANGED', 'OFFICIAL_IDENTITY_ACCOUNT_CHANGED',
  'OFFICIAL_SUBJECT_UID_MISMATCH', 'SUBJECT_BINDING_CONFLICT', 'SUBJECT_OWNER_CHANGED', 'MIGRATION_ACCOUNT_CONFLICT']);
const safeCode = value => typeof value === 'string' && /^[A-Z0-9_]{1,80}$/.test(value) ? value : null;
const safeRetry = value => Number.isSafeInteger(value) && value >= 1000 && value <= 86400000 ? value : null;

// V5 account-service codes and SDKLOGIN codes are intentionally separate.
// Unknown results remain recoverable diagnostics; only positive, source-bound
// evidence can request new credentials or mark an account disabled.
export function classifySessionFailure(error = {}) {
  const code = safeCode(error.code) || 'SESSION_START_FAILED';
  const phase = typeof error.phase === 'string' && error.phase.length <= 80 ? error.phase : null;
  const namespace = ['sdk-login', 'v5-account', 'world-session', 'transport'].includes(error.sourceNamespace)
    ? error.sourceNamespace : error.transportFailure === true ? 'transport'
      : /官服账号认证/.test(phase || '') ? 'v5-account' : /渠道会话兑换/.test(phase || '') ? 'sdk-login' : 'unknown';
  const loginCode = Number.isSafeInteger(error.loginCode) && error.loginCode > 0 ? error.loginCode : null;
  const remoteCode = Number.isSafeInteger(error.remoteCode) && error.remoteCode > 0 ? error.remoteCode : null;
  let action = 'retry', delayMs = safeRetry(error.retryAfterMs);
  if (OWNERSHIP_CONFLICT_CODES.has(code)) action = 'ownership-conflict';
  else if (code === 'PROTOCOL_CREDENTIALS_MISSING') action = 'needs-credentials';
  else if (['SOFTWARE_USER_DISABLED', 'ACCOUNT_DISABLED'].includes(code)) action = 'account-disabled';
  else if (namespace === 'sdk-login' && loginCode !== null && SDK_LOGIN_CODES[String(loginCode)]) {
    action = SDK_LOGIN_CODES[String(loginCode)];
    if (action === 'single-session' && delayMs === null) delayMs = 15000;
    if (action === 'wait-time' && delayMs === null) delayMs = 180000;
    if (action === 'wait-egress' && delayMs === null) delayMs = 3600000;
    if (action === 'refresh-config' && delayMs === null) delayMs = 30000;
  } else if (namespace === 'sdk-login' && error.loginKind === 'credential' && [2011, 2012].includes(loginCode)) action = 'needs-credentials';
  else if (namespace === 'sdk-login' && error.loginKind === 'blocked' && [2004, 2017, 902053].includes(loginCode)) action = 'account-disabled';
  else if (namespace === 'sdk-login' && error.loginKind === 'single_session') { action = 'single-session'; delayMs ??= 15000; }
  else if (namespace === 'sdk-login' && error.loginKind === 'throttle') { action = 'wait-time'; delayMs ??= 180000; }
  else if (namespace === 'v5-account' && remoteCode !== null) {
    // V5 codes are not SDKLOGIN codes. Preserve the source and retry unknown
    // V5 denials through the normal bounded recovery path.
    action = remoteCode === 14101 ? 'refresh-config' : 'retry';
    if (action === 'refresh-config') delayMs ??= 30000;
  }
  if (error.loginKind === 'credential' && namespace === 'sdk-login' && loginCode === null) action = 'retry';
  const needsUserAction = action === 'needs-credentials' || action === 'account-disabled' || action === 'ownership-conflict';
  return Object.freeze({ version: 'session-failure-policy/v1', namespace, phase, action,
    retryable: !needsUserAction && action !== 'ownership-conflict', retryAfterMs: delayMs,
    code, loginCode, remoteCode, loginCodeKey: typeof error.loginCodeKey === 'string' && /^[A-Za-z_][A-Za-z0-9_.]{1,40}$/.test(error.loginCodeKey) ? error.loginCodeKey : null,
    loginKind: typeof error.loginKind === 'string' && /^[a-z_]{2,40}$/.test(error.loginKind) ? error.loginKind : null,
    transportCode: safeCode(error.transportCode), userActionRequired: needsUserAction });
}
