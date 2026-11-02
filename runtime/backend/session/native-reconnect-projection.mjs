import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// A current-intent projection only. No timers, recovery decisions, historical
// operations, configuration reads or writes to the authoritative database.
const VERSION = 'native-reconnect-deadlines/v1';
const MAX_ACCOUNTS = 256;
const MAX_BYTES = 128 * 1024;
const FALLBACK_MS = 15_000;
const RETRY_MS = 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEXT = /^[A-Za-z0-9_.:-]{1,256}$/;
const STATES = new Set(['STOPPED', 'STARTING', 'CONNECTING', 'SYNCHRONIZING', 'RUNNABLE', 'WAITING',
  'WAITING_NETWORK', 'WAITING_LOGIN', 'RECOVERING', 'STOPPING', 'SUSPENDED', 'BLOCKED']);
const IDENTITY_FIELDS = ['scopeRef', 'nativeGeneration', 'instanceId', 'pid', 'processStartToken', 'bootId',
  'ownerRef', 'identityEpoch', 'authorized', 'requiresEngineRestart', 'controlSeq', 'controlKind', 'stopCommitted',
  'stopBlocked', 'publisherState'];
const ROW_FIELDS = ['accountRef', 'scopeHash', 'desiredRunning', 'runEpoch', 'connectionEpoch', 'state', 'needsManualStart', 'retryAtMs'];
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const sameFields = (a, b, fields) => !!a && !!b && fields.every(key => a[key] === b[key]);
const failed = code => Object.assign(new Error(code), { projectionCode: code });

// Exact Java UUID.nameUUIDFromBytes UTF-8 algorithm, not the RFC namespace UUID
// helper: MD5(ownerRef + NUL + accountRef + NUL + subjectRef), v3/variant bits.
function javaScopeHash(ownerRef, accountRef, subjectRef) {
  const bytes = crypto.createHash('md5').update(ownerRef + '\0' + accountRef + '\0' + subjectRef, 'utf8').digest();
  bytes[6] = bytes[6] & 0x0f | 0x30;
  bytes[8] = bytes[8] & 0x3f | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createNativeReconnectProjection({ store, dataDir, readIdentity, onDiagnostic = () => {} }) {
  if (!store?.all || !path.isAbsolute(dataDir || '') || typeof readIdentity !== 'function')
    throw new TypeError('Native reconnect projection requires explicit local storage and identity');
  const file = path.join(dataDir, 'reconnect-deadlines.json');
  const temporary = file + '.tmp';
  const localNow = () => Number(process.hrtime.bigint()) / 1_000_000;
  let closed = false, queued = false, dirty = true, revision = 0, published = null, publishedFile = null;
  let nextProbe = 0, retryAfter = 0, identityHint = null;
  let diagnostic = { state: 'not-published', revision: 0, errorCode: null, publishedAtMs: null };
  const scopes = new Map();
  function fileStamp() {
    try {
      const stat = fs.statSync(file);
      return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, dev: stat.dev } : null;
    } catch { return null; }
  }
  function report(errorCode) {
    const changed = diagnostic.errorCode !== errorCode;
    diagnostic = { ...diagnostic, state: errorCode ? 'unavailable' : 'published', errorCode };
    if (changed) try { onDiagnostic({ state: diagnostic.state, errorCode }); } catch { /* Diagnostics cannot change intent. */ }
  }
  function identity() {
    const value = readIdentity();
    if (!value || typeof value.scopeRef !== 'string' || !/^device:[A-Za-z0-9_.:-]{1,128}$/.test(value.scopeRef)
        || !UUID.test(value.nativeGeneration || '') || value.instanceId !== value.nativeGeneration || !positive(value.pid)
        || !/^\d{1,32}$/.test(value.processStartToken || '') || !UUID.test(value.bootId || '')
        || value.ownerRef !== null && (typeof value.ownerRef !== 'string' || !TEXT.test(value.ownerRef) || value.ownerRef.length > 160)
        || !nonnegative(value.identityEpoch) || typeof value.authorized !== 'boolean' || typeof value.requiresEngineRestart !== 'boolean'
        || !nonnegative(value.controlSeq) || !['NONE', 'USER_START', 'STOP'].includes(value.controlKind)
        || typeof value.stopCommitted !== 'boolean' || typeof value.stopBlocked !== 'boolean'
        || !['initializing', 'ready', 'draining', 'closing'].includes(value.publisherState)) throw failed('IDENTITY_UNAVAILABLE');
    return Object.fromEntries(IDENTITY_FIELDS.map(key => [key, value[key]]));
  }
  function snapshot() {
    const current = identity();
    // An unbound owner is explicit unavailable data, never an authoritative
    // empty roster that could cancel a previously valid account's alarm.
    if (!current.ownerRef) throw failed('OWNER_UNBOUND');
    const rows = store.all(`SELECT a.account_id,a.subject_ref,i.subject_ref AS intent_subject_ref,
      i.desired_running,i.run_epoch,i.connection_epoch,i.state,i.retry_at_ms
      FROM backend_accounts a LEFT JOIN backend_run_intents i
      ON i.owner_ref=a.owner_ref AND i.account_ref=CAST(a.account_id AS TEXT)
      WHERE a.owner_ref=? AND a.removed_at IS NULL ORDER BY a.subject_ref LIMIT ?`, current.ownerRef, MAX_ACCOUNTS + 1);
    if (rows.length > MAX_ACCOUNTS) throw failed('ROSTER_LIMIT_EXCEEDED');
    // The existing partial (owner_ref,subject_ref) index bounds the current
    // roster selection. Sort only the <=256 selected rows for stable ID order.
    rows.sort((a, b) => a.account_id - b.account_id);
    const activeScopes = new Set();
    const accounts = rows.map(row => {
      const accountRef = String(row.account_id);
      if (!positive(row.account_id) || !/^[0-9]{1,20}$/.test(accountRef) || typeof row.subject_ref !== 'string' || !TEXT.test(row.subject_ref))
        throw failed('ROSTER_ROW_INVALID');
      const absent = row.intent_subject_ref === null;
      // Same legacy lifecycle normalization as supervisor.project().
      const state = absent ? 'STOPPED' : row.state === 'OFFICIAL_HOST' ? 'WAITING_LOGIN' : row.state;
      if (!absent && (row.intent_subject_ref !== row.subject_ref || ![0, 1].includes(row.desired_running)
          || !nonnegative(row.run_epoch) || row.desired_running === 1 && !positive(row.run_epoch)
          || !nonnegative(row.connection_epoch) || !STATES.has(state)
          || row.retry_at_ms !== null && !positive(row.retry_at_ms))) throw failed('INTENT_ROW_INVALID');
      const key = current.ownerRef + '\0' + accountRef + '\0' + row.subject_ref;
      activeScopes.add(key);
      if (!scopes.has(key)) scopes.set(key, javaScopeHash(current.ownerRef, accountRef, row.subject_ref));
      const desiredRunning = !absent && row.desired_running === 1;
      return { accountRef, scopeHash: scopes.get(key), desiredRunning, runEpoch: absent ? 0 : row.run_epoch,
        connectionEpoch: absent ? 0 : row.connection_epoch, state,
        needsManualStart: !desiredRunning || state === 'BLOCKED', retryAtMs: absent ? null : row.retry_at_ms };
    });
    for (const key of scopes.keys()) if (!activeScopes.has(key)) scopes.delete(key);
    return { identity: current, accounts };
  }
  function publish() {
    queued = false;
    if (closed || !dirty || localNow() < retryAfter) return;
    dirty = false;
    try {
      const current = snapshot();
      const unchanged = published && sameFields(current.identity, published.identity, IDENTITY_FIELDS)
        && current.accounts.length === published.accounts.length
        && current.accounts.every((row, index) => sameFields(row, published.accounts[index], ROW_FIELDS));
      const currentFile = unchanged ? fileStamp() : null;
      if (unchanged && sameFields(currentFile, publishedFile, ['size', 'mtimeMs', 'ctimeMs', 'ino', 'dev'])) {
        retryAfter = 0; report(null); return;
      }
      if (!Number.isSafeInteger(revision + 1)) throw failed('REVISION_EXHAUSTED');
      const publishedAtMs = Date.now();
      const text = JSON.stringify({ version: VERSION, schemaVersion: 1, complete: true,
        revision: revision + 1, capturedAtMs: publishedAtMs, timeBasis: 'unix-ms-diagnostic-only',
        scopeHashAlgorithm: 'java-name-uuid-md5-utf8-nul/v1', ...current.identity, accounts: current.accounts }) + '\n';
      if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw failed('SNAPSHOT_LIMIT_EXCEEDED');
      // Never truncate a previously complete file, even when rename fails.
      fs.writeFileSync(temporary, text, { mode: 0o600 });
      fs.renameSync(temporary, file);
      revision += 1;
      published = current;
      // A missing or externally changed/truncated file is republished from the
      // authority at the next notification/fallback, without reading/hash on
      // the 300ms maintenance path. Metadata is diagnostic, not freshness proof.
      publishedFile = fileStamp();
      nextProbe = localNow() + FALLBACK_MS;
      retryAfter = 0;
      diagnostic = { state: 'published', revision, errorCode: diagnostic.errorCode, publishedAtMs };
      report(null);
    } catch (error) {
      dirty = true;
      retryAfter = localNow() + RETRY_MS;
      report(error?.projectionCode || (/^[A-Z0-9_]{1,64}$/.test(String(error?.code || '')) ? 'IO_' + error.code : 'PUBLISH_FAILED'));
    }
  }
  function request() {
    if (closed) return;
    dirty = true;
    // SQLite callbacks are synchronous. This runs only after their outer
    // transaction stack has committed/rolled back; no tentative rows escape.
    if (!queued && localNow() >= retryAfter) { queued = true; queueMicrotask(publish); }
  }
  function maintain(hint = null) {
    if (closed) return;
    if (hint && !sameFields(hint, identityHint, ['ownerRef', 'identityEpoch', 'authorized', 'requiresEngineRestart'])) {
      identityHint = { ownerRef: hint.ownerRef, identityEpoch: hint.identityEpoch,
        authorized: hint.authorized, requiresEngineRestart: hint.requiresEngineRestart };
      dirty = true;
    }
    const now = localNow();
    if (now >= nextProbe) { nextProbe = now + FALLBACK_MS; dirty = true; }
    if (dirty && !queued && now >= retryAfter) request();
  }
  return Object.freeze({ request, maintain, status: () => ({ ...diagnostic }),
    close() { closed = true; dirty = false; } });
}
