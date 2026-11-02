// Failure-count throttling backed by auth_throttle. Keys never contain a password.
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 8;
const LOCK_MS = 15 * 60_000;
const REGISTER_WINDOW_MS = 60 * 60_000;
const REGISTER_MAX = 10;

export function createRateLimiter(store) {
  const { run, get, nowIso } = store;

  function row(scope, key) {
    return get('SELECT * FROM auth_throttle WHERE scope=? AND key=?', scope, key);
  }
  function ensure(scope, key) {
    const existing = row(scope, key);
    if (existing) return existing;
    run('INSERT INTO auth_throttle(scope,key,failures,updated_at) VALUES(?,?,0,?)', scope, key, nowIso());
    return row(scope, key);
  }

  // A locked scope stays locked until locked_until even if failures would reset.
  function isLocked(scope, key) {
    const current = ensure(scope, key);
    const now = Date.parse(nowIso());
    if (current.locked_until && Date.parse(current.locked_until) > now) return true;
    if (current.locked_until && Date.parse(current.locked_until) <= now) {
      run('UPDATE auth_throttle SET failures=0,locked_until=NULL,updated_at=? WHERE scope=? AND key=?', nowIso(), scope, key);
    }
    return false;
  }

  function recordFailure(scope, key, { windowMs = WINDOW_MS, max = MAX_FAILURES, lockMs = LOCK_MS } = {}) {
    const current = ensure(scope, key);
    const now = Date.parse(nowIso());
    const stale = now - Date.parse(current.updated_at) > windowMs;
    const failures = (stale ? 0 : current.failures) + 1;
    const lockedUntil = failures >= max
      ? new Date(now + lockMs).toISOString()
      : (stale ? null : current.locked_until);
    run('UPDATE auth_throttle SET failures=?,updated_at=?,locked_until=? WHERE scope=? AND key=?',
      failures, nowIso(), lockedUntil, scope, key);
    return failures >= max;
  }

  function recordSuccess(scope, key) {
    run('UPDATE auth_throttle SET failures=0,locked_until=NULL,updated_at=? WHERE scope=? AND key=?', nowIso(), scope, key);
  }

  function registerAllowed(ip) {
    // Register is capped by request volume per hour rather than by failed logins.
    const current = ensure('register', ip);
    const now = Date.parse(nowIso());
    if (now - Date.parse(current.updated_at) > REGISTER_WINDOW_MS) {
      run('UPDATE auth_throttle SET failures=0,locked_until=NULL,updated_at=? WHERE scope=? AND key=?', nowIso(), 'register', ip);
      return true;
    }
    return current.failures < REGISTER_MAX;
  }
  function recordRegister(ip) {
    const current = ensure('register', ip);
    const now = Date.parse(nowIso());
    const stale = now - Date.parse(current.updated_at) > REGISTER_WINDOW_MS;
    const failures = (stale ? 0 : current.failures) + 1;
    run('UPDATE auth_throttle SET failures=?,updated_at=? WHERE scope=? AND key=?', failures, nowIso(), 'register', ip);
  }

  return { isLocked, recordFailure, recordSuccess, registerAllowed, recordRegister,
    codes: { loginWindowMs: WINDOW_MS, loginMax: MAX_FAILURES, registerWindowMs: REGISTER_WINDOW_MS, registerMax: REGISTER_MAX } };
}
