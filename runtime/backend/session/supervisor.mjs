import { canonical, fingerprint, freeze, newId, parseStored, plainObject, problem, requireText } from '../common.mjs';
import { REWARD_CARDS } from '../features/rewards/catalog.mjs';
import { publicLoginProfile } from '../facts/official-observations.mjs';
import { ORDER_FLOWER_CONTRACTS, assertOrderFlowerImmutableEvidence } from '../features/order-flower/rpc-contract.mjs';
import { ORDER_FLOWER_VIDEO_CONTRACTS, assertOrderFlowerVideoPreparedOperation } from '../features/order-flower/video-contract.mjs';
import { ORDER_FLOWER_REWARD_CONTRACTS, assertOrderFlowerRewardPreparedOperation } from '../features/order-flower/reward-contract.mjs';
import { ORDER_FLOWER_ENTER_CONTRACTS, assertOrderFlowerEnterPreparedOperation } from '../features/order-flower/enter-contract.mjs';
import { ORDER_FLOWER_AUX_POST_READ } from '../features/order-flower/auxiliary-contract.mjs';
import { WATERWHEEL_DEFINITIONS, WATERWHEEL_POST_READ, WATERWHEEL_METHODS, WATERWHEEL_SCOPES } from '../features/waterwheel/rpc-contract.mjs';
import { FREE_WATER_DEFINITIONS, FREE_WATER_POST_READ, FREE_WATER_METHODS, FREE_WATER_SCOPES } from '../features/free-water/rpc-contract.mjs';
import { FLOWER_RACK_CONTRACT_REF, FLOWER_RACK_DEFINITIONS, FLOWER_RACK_METHODS, FLOWER_RACK_POST_READ, FLOWER_RACK_SCOPES } from '../features/flower-rack/rpc-contract.mjs';
import { FLOWER_RACK_EXTENSION_ID, FLOWER_RACK_SOURCE_PIN } from '../official-flower-rack-extension.mjs';
import { DAILY_ART_CONTRACT, DAILY_ART_POST_READ } from '../features/art/daily-rpc-contract.mjs';
import { ART_FIRST_ALBUM_CONTRACT, ART_FIRST_ALBUM_POST_READ, assertArtFirstAlbumProposal,
  ART_FIRST_SHARE_CONTRACT, ART_FIRST_SHARE_POST_READ, assertArtFirstShareProposal } from '../features/art/first-reward-contract.mjs';
import { CUSTOMER_ART_BATCH_CONTRACT, CUSTOMER_ART_BATCH_POST_READ, assertCustomerArtBatchProposal } from '../features/art/customer-batch-contract.mjs';
import { verifyOfficialServerVersionFrame } from '../official-server-version-contract.mjs';
import { ledgerJsonFingerprint } from '../persistence/json-contract.mjs';
import { classifySessionFailure } from './failure-policy.mjs';
import { resolveNativeExecutorExitProof } from './native-executor-identity.mjs';

const PUBLIC_STATE = Object.freeze({ STOPPED: 'stopped', STARTING: 'starting', CONNECTING: 'starting', SYNCHRONIZING: 'starting',
  RUNNABLE: 'running', WAITING: 'running', WAITING_NETWORK: 'waiting_network', WAITING_LOGIN: 'waiting_login',
  RECOVERING: 'recovering', STOPPING: 'stopping', SUSPENDED: 'waiting_authorization', BLOCKED: 'blocked' });
const FACT_STATES = new Set(['CONNECTING', 'SYNCHRONIZING', 'RUNNABLE', 'WAITING']);
const RECOVERABLE_CLOSE = new Set(['PROTOCOL_CONNECTION_CLOSED', 'PROTOCOL_HEARTBEAT_FAILED', 'PROTOCOL_PING_FAILED', 'PROTOCOL_FRAME_INVALID', 'NATIVE_NETWORK_OFFLINE', 'PROTOCOL_RPC_TIMEOUT', 'PROTOCOL_SEND_FAILED']);
const codeOf = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'SESSION_START_FAILED';
const CONTEXT_FIELDS = ['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch'];
const ORDER_FLOWER_AUXILIARY_OPERATIONS = Object.freeze([
  ...Object.entries(ORDER_FLOWER_VIDEO_CONTRACTS).map(([kind, definition]) => Object.freeze({ ...definition, family: 'video',
    domain: 'order-flower-video-' + kind, preparationField: 'orderFlowerVideo', assertPrepared: assertOrderFlowerVideoPreparedOperation })),
  ...Object.entries(ORDER_FLOWER_REWARD_CONTRACTS).map(([kind, definition]) => Object.freeze({ ...definition, family: 'reward',
    domain: 'order-flower-reward-' + kind, preparationField: 'orderFlowerReward', assertPrepared: assertOrderFlowerRewardPreparedOperation })),
  ...Object.entries(ORDER_FLOWER_ENTER_CONTRACTS).map(([kind, definition]) => Object.freeze({ ...definition, family: 'enter',
    domain: 'order-flower-enter-' + kind, preparationField: 'orderFlowerEnter', assertPrepared: assertOrderFlowerEnterPreparedOperation })),
]);
const positive = value => Number.isSafeInteger(value) && value > 0;
const NATIVE_NETWORK_FIELDS = Object.freeze(['nativeSourceInstance', 'observationSequence', 'nativeObservedAtMs', 'nativeObservedElapsedMs', 'nativeSource']);
function networkObservation(input) {
  if (!plainObject(input) || Object.keys(input).some(key => !['online', 'transport', ...NATIVE_NETWORK_FIELDS].includes(key)) ||
      typeof input.online !== 'boolean' || !['wifi', 'cellular', 'ethernet', 'none', 'unknown'].includes(input.transport)) {
    throw problem('NETWORK_STATE_INVALID', '原生网络事实格式不正确', 400);
  }
  const provided = NATIVE_NETWORK_FIELDS.filter(key => Object.hasOwn(input, key));
  if (!provided.length) return { state: { online: input.online, transport: input.transport }, native: null };
  if (provided.length !== NATIVE_NETWORK_FIELDS.length ||
      typeof input.nativeSourceInstance !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.nativeSourceInstance) ||
      !positive(input.observationSequence) || !positive(input.nativeObservedAtMs) ||
      !Number.isSafeInteger(input.nativeObservedElapsedMs) || input.nativeObservedElapsedMs < 0 ||
      !['default-network-callback', 'periodic-query', 'wifi-state-broadcast'].includes(input.nativeSource)) {
    throw problem('NATIVE_NETWORK_OBSERVATION_INVALID', '原生网络观察实例、序号或诊断时间格式不正确', 400);
  }
  return { state: { online: input.online, transport: input.transport }, native: Object.fromEntries(NATIVE_NETWORK_FIELDS.map(key => [key, input[key]])) };
}
const actorContext = actor => Object.fromEntries(CONTEXT_FIELDS.map(key => [key, key === 'accountRef' ? String(actor[key]) : actor[key]]));
const sameContext = (a, b) => !!a && !!b && CONTEXT_FIELDS.every(key => a[key] === b[key]);
function exactContext(value) {
  if (!value || !['ownerRef', 'subjectRef'].every(key => typeof value[key] === 'string' && value[key] && value[key].length <= 512) ||
      !['ownerEpoch', 'runEpoch', 'connectionEpoch'].every(key => positive(value[key])) || value.accountRef == null) return null;
  const result = actorContext(value);
  return result.accountRef && result.accountRef.length <= 512 ? result : null;
}
function exactAfter(value) {
  if (!value || !positive(value.connectionEpoch) || !positive(value.requestSequence) ||
      typeof value.wireKey !== 'string' || value.wireKey.length > 128 || !/^ws\|\d+\|[1-9]\d*$/.test(value.wireKey) ||
      Number(value.wireKey.split('|').at(-1)) !== value.requestSequence ||
      typeof value.responseRef !== 'string' || !value.responseRef || value.responseRef.length > 512) return null;
  return Object.fromEntries(['connectionEpoch', 'requestSequence', 'wireKey', 'responseRef'].map(key => [key, value[key]]));
}

export function createSubjectSupervisor({ store, appendOutbox, authorize, isolatePreviousExecutor, connect, onConnected, prepareVerificationLogin = null,
  onStop = () => {}, onState = () => {}, onReconnectStateChange = () => {}, appendRecoveryLog = () => {}, revokeWrites = () => ({ captured: false, completion: Promise.resolve({ durableOutcome: true }) }),
  isAccountStopPending = () => false,
  assertCanonicalExecution = null,
  readWriteActivity = () => ({ inFlight: true }), readOfficialClock = () => null,
  authorizeDynamicRefresh = () => false,
  quiesceScheduling = async () => ({ quiesced: false, reasonCode: 'SCHEDULER_QUIESCE_UNAVAILABLE' }),
  cleanupTimeoutMs = 12000, deviceNow = () => Date.now(), monotonicNow = () => Number(process.hrtime.bigint()) / 1_000_000,
  recoveryBaseMs = 5000, recoveryMaxMs = 60000 }) {
  for (const value of [cleanupTimeoutMs, recoveryBaseMs, recoveryMaxMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Session recovery limits must be positive integers');
  }
  if (recoveryMaxMs < recoveryBaseMs || typeof deviceNow !== 'function' || typeof monotonicNow !== 'function') throw new TypeError('Invalid session recovery clock or bounds');
  if (typeof readWriteActivity !== 'function' || typeof readOfficialClock !== 'function' || typeof authorizeDynamicRefresh !== 'function') throw new TypeError('Snapshot refresh requires synchronous read ports');
  const { run: runStatement, get, all, transaction, nowIso } = store;
  let reconnectNotificationQueued = false;
  const run = (sql, ...params) => {
    const result = runStatement(sql, ...params);
    if (result.changes && /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+backend_run_intents\b/i.test(sql)
        && !reconnectNotificationQueued) {
      reconnectNotificationQueued = true;
      // Includes direct retry/START/STOP/restart writes that bypass transition
      // or saveRecovery. Read only after the synchronous outer transaction.
      queueMicrotask(() => {
        reconnectNotificationQueued = false;
        try { onReconnectStateChange(); } catch { /* A projection cannot interrupt recovery or STOP. */ }
      });
    }
    return result;
  };
  // Attempt count is diagnostic; bounded exponential backoff controls delay.
  const nextRecoveryAttempt = value => Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Number(value || 0)) + 1);
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_subject_bindings(
    owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,basis TEXT NOT NULL,
    identity_version TEXT NOT NULL,channel TEXT NOT NULL,evidence_json TEXT NOT NULL,created_at TEXT NOT NULL,
    PRIMARY KEY(owner_ref,account_ref));
    CREATE TABLE IF NOT EXISTS backend_subject_aliases(
    subject_ref TEXT NOT NULL,alias_ref TEXT NOT NULL,basis TEXT NOT NULL,identity_version TEXT NOT NULL,
    evidence_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(subject_ref,alias_ref));
    CREATE TABLE IF NOT EXISTS backend_subject_owners(
    subject_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,executor_ref TEXT NOT NULL,owner_epoch INTEGER NOT NULL,
    active INTEGER NOT NULL,isolation_evidence_json TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS backend_run_intents(
    owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,desired_running INTEGER NOT NULL,
    run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,state TEXT NOT NULL,reason_code TEXT,
    command_id TEXT NOT NULL,retry_at_ms INTEGER,updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,account_ref));
    CREATE TABLE IF NOT EXISTS backend_control_receipts(
    owner_ref TEXT NOT NULL,command_id TEXT NOT NULL,account_ref TEXT NOT NULL,kind TEXT NOT NULL,
    receipt_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(owner_ref,command_id));
    CREATE TABLE IF NOT EXISTS backend_subject_connection_epochs(
    subject_ref TEXT PRIMARY KEY,connection_epoch INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS backend_session_recovery(
      owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,status TEXT NOT NULL,
      attempt INTEGER NOT NULL,max_attempts INTEGER NOT NULL,expected_run_epoch INTEGER NOT NULL,
      expected_connection_epoch INTEGER NOT NULL,retry_at_ms INTEGER,reason_code TEXT NOT NULL,
      error_json TEXT NOT NULL,close_evidence_ref TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,account_ref));
    CREATE TABLE IF NOT EXISTS backend_session_cooldowns(
      owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
      conflict_streak INTEGER NOT NULL,cooldown_until_ms INTEGER NOT NULL,
      last_source TEXT NOT NULL,last_code TEXT,last_connected_ms INTEGER,
      stable_connected_ms INTEGER NOT NULL DEFAULT 0,evidence_generation INTEGER NOT NULL DEFAULT 0,
      last_run_epoch INTEGER,last_connection_epoch INTEGER,updated_at TEXT NOT NULL,
      PRIMARY KEY(owner_ref,account_ref));
    CREATE TABLE IF NOT EXISTS backend_session_cooldown_subjects(
      owner_ref TEXT NOT NULL,subject_scope TEXT NOT NULL,subject_ref TEXT NOT NULL,
      conflict_streak INTEGER NOT NULL,cooldown_until_ms INTEGER NOT NULL,
      last_source TEXT NOT NULL,last_code TEXT,last_connected_ms INTEGER,
      stable_connected_ms INTEGER NOT NULL DEFAULT 0,evidence_generation INTEGER NOT NULL DEFAULT 0,
      last_run_epoch INTEGER,last_connection_epoch INTEGER,updated_at TEXT NOT NULL,
      PRIMARY KEY(owner_ref,subject_scope));
    CREATE TABLE IF NOT EXISTS backend_session_connection_closures(
      evidence_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
      executor_ref TEXT NOT NULL,owner_epoch INTEGER,run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,
      proof_kind TEXT NOT NULL,proof_json TEXT NOT NULL,recorded_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS backend_session_connection_closures_no_update BEFORE UPDATE ON backend_session_connection_closures
      BEGIN SELECT RAISE(ABORT,'connection closure evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_session_connection_closures_no_delete BEFORE DELETE ON backend_session_connection_closures
      BEGIN SELECT RAISE(ABORT,'connection closure evidence is append only'); END;
    CREATE TABLE IF NOT EXISTS backend_session_transport_identity_receipts(
      receipt_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,executor_ref TEXT NOT NULL,
      payload_json TEXT NOT NULL,payload_fingerprint TEXT NOT NULL,recorded_at TEXT NOT NULL,
      UNIQUE(owner_ref,account_ref,subject_ref,owner_epoch,run_epoch,connection_epoch));
    CREATE TRIGGER IF NOT EXISTS backend_session_transport_identity_receipts_no_update BEFORE UPDATE ON backend_session_transport_identity_receipts
      BEGIN SELECT RAISE(ABORT,'transport identity receipts are append only'); END;
    CREATE TRIGGER IF NOT EXISTS backend_session_transport_identity_receipts_no_delete BEFORE DELETE ON backend_session_transport_identity_receipts
      BEGIN SELECT RAISE(ABORT,'transport identity receipts are append only'); END;
    CREATE TABLE IF NOT EXISTS backend_session_network_state(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),online INTEGER NOT NULL,transport TEXT NOT NULL,observed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS backend_native_network_sources(
      executor_ref TEXT PRIMARY KEY,native_source_instance TEXT NOT NULL,last_sequence INTEGER NOT NULL,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS backend_native_network_observations(
      observation_ref TEXT PRIMARY KEY,executor_ref TEXT NOT NULL,native_source_instance TEXT NOT NULL,
      observation_sequence INTEGER NOT NULL,payload_json TEXT NOT NULL,payload_fingerprint TEXT NOT NULL,recorded_at TEXT NOT NULL,
      UNIQUE(executor_ref,native_source_instance,observation_sequence));
    CREATE TRIGGER IF NOT EXISTS backend_native_network_source_identity BEFORE UPDATE OF executor_ref,native_source_instance,created_at
      ON backend_native_network_sources BEGIN SELECT RAISE(ABORT,'native network source identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_native_network_source_sequence BEFORE UPDATE OF last_sequence ON backend_native_network_sources
      WHEN NEW.last_sequence<=OLD.last_sequence BEGIN SELECT RAISE(ABORT,'native network sequence cannot move backwards'); END;
    CREATE TRIGGER IF NOT EXISTS backend_native_network_sources_no_delete BEFORE DELETE ON backend_native_network_sources
      BEGIN SELECT RAISE(ABORT,'native network source bindings are retained'); END;
    CREATE TRIGGER IF NOT EXISTS backend_native_network_observations_no_update BEFORE UPDATE ON backend_native_network_observations
      BEGIN SELECT RAISE(ABORT,'native network observations are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_native_network_observations_no_delete BEFORE DELETE ON backend_native_network_observations
      BEGIN SELECT RAISE(ABORT,'native network observations are append only'); END;
    CREATE TABLE IF NOT EXISTS backend_session_verification_leases(
      lease_ref TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,executor_ref TEXT NOT NULL,
      owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,
      original_connection_epoch INTEGER NOT NULL,new_connection_epoch INTEGER,state TEXT NOT NULL,active INTEGER NOT NULL,
      original_context_json TEXT NOT NULL,after_json TEXT NOT NULL,bridge_json TEXT,bridge_fingerprint TEXT,
      reason_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS backend_session_one_verification_lease ON backend_session_verification_leases(subject_ref) WHERE active=1;
    CREATE TABLE IF NOT EXISTS backend_session_verification_events(
      event_ref TEXT PRIMARY KEY,lease_ref TEXT NOT NULL,event_kind TEXT NOT NULL,receipt_json TEXT NOT NULL,recorded_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS backend_session_verification_events_by_lease_kind_time
      ON backend_session_verification_events(lease_ref,event_kind,recorded_at,event_ref);
    CREATE TRIGGER IF NOT EXISTS backend_session_verification_lease_original BEFORE UPDATE OF
      lease_ref,operation_id,executor_ref,owner_ref,account_ref,subject_ref,owner_epoch,run_epoch,original_connection_epoch,original_context_json,after_json,created_at
      ON backend_session_verification_leases BEGIN SELECT RAISE(ABORT,'verification lease original is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_session_verification_bridge_original BEFORE UPDATE OF bridge_json,bridge_fingerprint
      ON backend_session_verification_leases WHEN OLD.bridge_json IS NOT NULL AND
      (NEW.bridge_json IS NOT OLD.bridge_json OR NEW.bridge_fingerprint IS NOT OLD.bridge_fingerprint)
      BEGIN SELECT RAISE(ABORT,'verification bridge is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_session_verification_lease_no_delete BEFORE DELETE ON backend_session_verification_leases
      BEGIN SELECT RAISE(ABORT,'verification leases are retained'); END;
    CREATE TRIGGER IF NOT EXISTS backend_session_verification_events_no_update BEFORE UPDATE ON backend_session_verification_events
      BEGIN SELECT RAISE(ABORT,'verification events are append only'); END;
    CREATE TRIGGER IF NOT EXISTS backend_session_verification_events_no_delete BEFORE DELETE ON backend_session_verification_events
      BEGIN SELECT RAISE(ABORT,'verification events are append only'); END;
    CREATE TABLE IF NOT EXISTS backend_session_snapshot_refresh_events(
      event_ref TEXT PRIMARY KEY,refresh_ref TEXT NOT NULL,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
      original_context_json TEXT NOT NULL,event_kind TEXT NOT NULL,receipt_json TEXT NOT NULL,recorded_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS backend_session_snapshot_refresh_scope ON backend_session_snapshot_refresh_events(owner_ref,account_ref,recorded_at);
    CREATE TABLE IF NOT EXISTS backend_session_snapshot_refresh_limits(
      owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,official_uid INTEGER NOT NULL,
      anchor_ref TEXT NOT NULL,attempt INTEGER NOT NULL CHECK(attempt>=0 AND attempt<=3),updated_at TEXT NOT NULL,
      PRIMARY KEY(owner_ref,account_ref,subject_ref));
    CREATE TRIGGER IF NOT EXISTS backend_session_snapshot_refresh_events_no_update BEFORE UPDATE ON backend_session_snapshot_refresh_events
      BEGIN SELECT RAISE(ABORT,'snapshot refresh events are append only'); END;
    CREATE TRIGGER IF NOT EXISTS backend_session_snapshot_refresh_events_no_delete BEFORE DELETE ON backend_session_snapshot_refresh_events
      BEGIN SELECT RAISE(ABORT,'snapshot refresh events are append only'); END;`);
  // Migration keeps every existing per-alias floor and mirrors it onto the
  // verified real subject, so a different login alias inherits the same wait
  // instead of finding an empty row.
  if (!all('PRAGMA table_info(backend_session_cooldowns)').some(column => column.name === 'stable_connected_ms'))
    run('ALTER TABLE backend_session_cooldowns ADD COLUMN stable_connected_ms INTEGER NOT NULL DEFAULT 0');
  if (!all('PRAGMA table_info(backend_session_cooldowns)').some(column => column.name === 'evidence_generation'))
    run('ALTER TABLE backend_session_cooldowns ADD COLUMN evidence_generation INTEGER NOT NULL DEFAULT 0');
  if (!all('PRAGMA table_info(backend_session_cooldown_subjects)').some(column => column.name === 'stable_connected_ms'))
    run('ALTER TABLE backend_session_cooldown_subjects ADD COLUMN stable_connected_ms INTEGER NOT NULL DEFAULT 0');
  if (!all('PRAGMA table_info(backend_session_cooldown_subjects)').some(column => column.name === 'evidence_generation'))
    run('ALTER TABLE backend_session_cooldown_subjects ADD COLUMN evidence_generation INTEGER NOT NULL DEFAULT 0');
  transaction(() => {
    const existingSubjects = new Set(all('SELECT owner_ref,subject_scope FROM backend_session_cooldown_subjects')
      .map(row => canonical([row.owner_ref, row.subject_scope])));
    for (const prior of all('SELECT * FROM backend_session_cooldowns')) {
      const scope = verifiedSubjectScope(prior.owner_ref, prior.subject_ref);
      if (!scope) continue;
      // Subjects present before migration retain consumed evidence and reset
      // streaks. Newly created subjects aggregate every legacy alias's maximum
      // streak in the same transaction, independently of alias iteration order.
      run(`INSERT INTO backend_session_cooldown_subjects(owner_ref,subject_scope,subject_ref,conflict_streak,cooldown_until_ms,
        last_source,last_code,last_connected_ms,stable_connected_ms,evidence_generation,last_run_epoch,last_connection_epoch,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(owner_ref,subject_scope) DO UPDATE SET subject_ref=excluded.subject_ref,
        conflict_streak=CASE WHEN ? THEN conflict_streak ELSE max(conflict_streak,excluded.conflict_streak) END,
        cooldown_until_ms=max(cooldown_until_ms,excluded.cooldown_until_ms),
        last_connected_ms=NULLIF(max(COALESCE(last_connected_ms,0),COALESCE(excluded.last_connected_ms,0)),0),updated_at=excluded.updated_at`,
      prior.owner_ref, scope, prior.subject_ref, prior.conflict_streak, prior.cooldown_until_ms, prior.last_source, prior.last_code,
      prior.last_connected_ms ?? null, prior.stable_connected_ms ?? 0, prior.evidence_generation ?? 0,
      prior.last_run_epoch ?? null, prior.last_connection_epoch ?? null, nowIso(),
      existingSubjects.has(canonical([prior.owner_ref, scope])) ? 1 : 0);
    }
  });
  const executorRef = newId();
  const actors = new Map();
  const pending = new Map();
  const cleanupPendingSince = new Map(), cleanupEscalationMs = 5 * 60_000;
  const recoveryTimers = new Map(), recoveryOwners = new Set(), recoveryDeadlines = new Map();
  let shuttingDown = false, restartShutdownPromise = null;
  let recoverySweeps = 0, recoverySweepArmed = 0, recoverySweepLastAtMs = null;
  // Persisted network observations are historical after restart. A fresh native
  // event may establish offline/online; an old row never authorizes a connection.
  const network = { online: null, transport: 'unknown' };
  const bySubject = subjectRef => [...actors.values()].find(actor => actor.subjectRef === subjectRef);
  const keyOf = (ownerRef, accountRef) => canonical([ownerRef, String(accountRef)]);
  const recovery = (ownerRef, accountRef) => get('SELECT * FROM backend_session_recovery WHERE owner_ref=? AND account_ref=?', ownerRef, String(accountRef));
  function captureWriteDrain(actor, reasonCode) {
    if (!actor || actor.ownerEpoch === null) return { captured: false, completion: Promise.resolve({ durableOutcome: true }) };
    if (actor.writeDrainTicket) return actor.writeDrainTicket;
    let ticket;
    try {
      ticket = revokeWrites(actor.verificationLease?.originalContext || actorContext(actor), { reasonCode });
      if (!ticket || typeof ticket.completion?.then !== 'function') throw problem('WRITE_DRAIN_CONTRACT_INVALID', '写入收尾回执不可用');
    } catch (error) { ticket = { captured: true, completion: Promise.resolve({ durableOutcome: false, reasonCode: codeOf(error) }) }; }
    // Capture synchronously, before abort or a rejected reply can finish its
    // gateway flight. A later STOP/recovery must await this same exact ticket.
    actor.writeDrainTicket = ticket;
    ticket.completion.catch(() => {});
    return ticket;
  }
  async function writeDrainComplete(ticket) {
    try { return (await ticket.completion)?.durableOutcome === true; } catch { return false; }
  }
  function cancelRecoveryTimer(ownerRef, accountRef) {
    const key = keyOf(ownerRef, accountRef), timer = recoveryTimers.get(key);
    if (timer) clearTimeout(timer);
    recoveryTimers.delete(key);
  }
  function recoveryDeadline(saved) {
    if (!saved || saved.retry_at_ms === null) return null;
    const key = keyOf(saved.owner_ref, saved.account_ref);
    let deadline = recoveryDeadlines.get(key);
    const retryRevision = `${saved.retry_at_ms}:${saved.attempt}:${saved.status}`;
    if (!deadline || deadline.retryRevision !== retryRevision) {
      let error = {};
      try { error = parseStored(saved.error_json, '会话重试时限依据') || {}; } catch { error = {}; }
      const policy = classifySessionFailure(error), attempts = Math.min(30, Math.max(0, Number(saved.attempt || 0)));
      const ordinaryBound = Math.min(recoveryMaxMs, recoveryBaseMs * 2 ** Math.min(attempts, 30));
      // A persisted policy cooldown is a lower bound, not a suggestion: a
      // restart, a network change or a fresh supervisor may not shorten it.
      const policyBound = Math.max(ordinaryBound, policy.retryAfterMs || 0, cooldownRemaining(saved.owner_ref, saved.account_ref));
      const remaining = Math.min(Math.max(0, saved.retry_at_ms - deviceNow()), policyBound);
      deadline = { retryRevision, dueMono: monotonicNow() + remaining };
      recoveryDeadlines.set(key, deadline);
    }
    return deadline.dueMono;
  }
  const backoff = attempt => Math.min(recoveryMaxMs, recoveryBaseMs * 2 ** Math.min(attempt, 30));
  const SESSION_CONFLICT_BASE_MS = 15_000, SESSION_CONFLICT_MAX_MS = 15 * 60_000, SESSION_CONFLICT_STABLE_MS = 5 * 60_000;
  const CLEANUP_MAX_ATTEMPTS = 8;
  function cooldownInfo(ownerRef, accountRef) {
    return get('SELECT * FROM backend_session_cooldowns WHERE owner_ref=? AND account_ref=?', ownerRef, String(accountRef));
  }
  function boundSubjectRef(ownerRef, accountRef) {
    return get('SELECT subject_ref FROM backend_subject_bindings WHERE owner_ref=? AND account_ref=?', ownerRef, String(accountRef))?.subject_ref ?? null;
  }
  // A cooldown belongs to the verified game subject (server + official UID), not
  // to the local login alias: signing in through another alias of the same
  // character must not find a shorter floor. An identity that was never verified
  // is never normalised by guesswork, so unrelated accounts stay independent.
  function verifiedSubjectScope(ownerRef, subjectRef) {
    if (!subjectRef) return null;
    if (!get(`SELECT name FROM sqlite_master WHERE type='table' AND name='backend_official_subject_identities'`))
      return 'local:' + subjectRef;
    const identity = get('SELECT canonical_ref,server_id,official_uid FROM backend_official_subject_identities WHERE owner_ref=? AND subject_ref=?',
      ownerRef, subjectRef);
    const uid = Number(identity?.official_uid), serverId = Number(identity?.server_id);
    return identity && typeof identity.canonical_ref === 'string' && identity.canonical_ref &&
      Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(serverId) && serverId > 0
      ? 'verified:' + identity.canonical_ref : 'local:' + subjectRef;
  }
  function subjectCooldownInfo(ownerRef, subjectRef) {
    const scope = verifiedSubjectScope(ownerRef, subjectRef);
    return scope ? get('SELECT * FROM backend_session_cooldown_subjects WHERE owner_ref=? AND subject_scope=?', ownerRef, scope) : null;
  }
  // Every alias row that normalises to one verified real subject. The list is
  // bounded by the account roster and is only read inside a transaction.
  function subjectAliases(ownerRef, scope) {
    if (!scope) return [];
    return all('SELECT account_ref,subject_ref FROM backend_session_cooldowns WHERE owner_ref=?', ownerRef)
      .filter(row => verifiedSubjectScope(ownerRef, row.subject_ref) === scope);
  }
  function mergeCooldown(account, subject) {
    const rows = [account, subject].filter(Boolean);
    if (!rows.length) return null;
    // The stricter persisted floor wins; the conflict streak is shared by all
    // aliases of the same real character, so the subject row is authoritative
    // once it exists (an alias row may carry a value from before a reset).
    const strictest = rows.reduce((best, row) => Number(row.cooldown_until_ms) > Number(best.cooldown_until_ms) ? row : best);
    const streakSource = subject ?? account;
    return { conflict_streak: Number(streakSource.conflict_streak) || 0,
      cooldown_until_ms: Number(strictest.cooldown_until_ms), last_source: strictest.last_source, last_code: strictest.last_code,
      last_connected_ms: Math.max(...rows.map(row => Number(row.last_connected_ms) || 0)) || null,
      stable_connected_ms: Math.max(...rows.map(row => Number(row.stable_connected_ms) || 0)),
      last_run_epoch: account?.last_run_epoch ?? null, last_connection_epoch: account?.last_connection_epoch ?? null,
      subject_ref: subject?.subject_ref ?? account?.subject_ref ?? null };
  }
  function cooldownEntry(ownerRef, accountRef) {
    const account = cooldownInfo(ownerRef, accountRef);
    const subjectRef = account?.subject_ref ?? boundSubjectRef(ownerRef, accountRef);
    const subject = subjectRef ? subjectCooldownInfo(ownerRef, subjectRef) : null;
    return { account, subjectRef, subject, merged: mergeCooldown(account, subject) };
  }
  function cooldownUntil(ownerRef, accountRef) {
    const merged = cooldownEntry(ownerRef, accountRef).merged;
    return merged && Number.isSafeInteger(merged.cooldown_until_ms) ? Math.max(0, Number(merged.cooldown_until_ms)) : 0;
  }
  function cooldownRemaining(ownerRef, accountRef) {
    return Math.max(0, cooldownUntil(ownerRef, accountRef) - deviceNow());
  }
  function saveCooldown(ownerRef, accountRef, subjectRef, values) {
    const prior = cooldownInfo(ownerRef, accountRef), at = nowIso();
    const stable = Number.isFinite(values.stableConnectedMs) ? Math.max(0, Math.floor(values.stableConnectedMs)) : null;
    run(`INSERT INTO backend_session_cooldowns(owner_ref,account_ref,subject_ref,conflict_streak,cooldown_until_ms,last_source,last_code,
      last_connected_ms,stable_connected_ms,last_run_epoch,last_connection_epoch,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(owner_ref,account_ref) DO UPDATE SET subject_ref=excluded.subject_ref,conflict_streak=excluded.conflict_streak,
      cooldown_until_ms=max(cooldown_until_ms,excluded.cooldown_until_ms),last_source=excluded.last_source,last_code=excluded.last_code,
      last_connected_ms=excluded.last_connected_ms,stable_connected_ms=excluded.stable_connected_ms,last_run_epoch=excluded.last_run_epoch,
      last_connection_epoch=excluded.last_connection_epoch,updated_at=excluded.updated_at`,
    ownerRef, String(accountRef), subjectRef, values.streak, values.until,
    values.source, values.code, values.lastConnected ?? prior?.last_connected_ms ?? null,
    stable ?? prior?.stable_connected_ms ?? 0,
    values.lastRunEpoch ?? prior?.last_run_epoch ?? null, values.lastConnectionEpoch ?? prior?.last_connection_epoch ?? null, at);
    const scope = verifiedSubjectScope(ownerRef, subjectRef);
    if (!scope) return;
    const subjectPrior = subjectCooldownInfo(ownerRef, subjectRef);
    // Two aliases of one verified character share one floor: a lower value from
    // this alias may never shorten the floor the other alias already reached.
    // The evidence generation is never written here: only a capture or a
    // consumption may move it.
    run(`INSERT INTO backend_session_cooldown_subjects(owner_ref,subject_scope,subject_ref,conflict_streak,cooldown_until_ms,
      last_source,last_code,last_connected_ms,stable_connected_ms,last_run_epoch,last_connection_epoch,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(owner_ref,subject_scope) DO UPDATE SET subject_ref=excluded.subject_ref,conflict_streak=excluded.conflict_streak,
      cooldown_until_ms=max(cooldown_until_ms,excluded.cooldown_until_ms),last_source=excluded.last_source,last_code=excluded.last_code,
      last_connected_ms=excluded.last_connected_ms,stable_connected_ms=excluded.stable_connected_ms,
      last_run_epoch=excluded.last_run_epoch,last_connection_epoch=excluded.last_connection_epoch,updated_at=excluded.updated_at`,
    ownerRef, scope, subjectRef, values.streak, values.until, values.source, values.code,
    values.lastConnected ?? subjectPrior?.last_connected_ms ?? prior?.last_connected_ms ?? null,
    stable ?? subjectPrior?.stable_connected_ms ?? 0,
    values.lastRunEpoch ?? subjectPrior?.last_run_epoch ?? null, values.lastConnectionEpoch ?? subjectPrior?.last_connection_epoch ?? null, at);
    // The shared row is canonical for the streak. Older alias rows are brought
    // to the same value so a restart migration or a direct read cannot revive a
    // count that was already reset for this real subject.
    for (const alias of subjectAliases(ownerRef, scope)) {
      if (String(alias.account_ref) === String(accountRef)) continue;
      run(`UPDATE backend_session_cooldowns SET conflict_streak=?,last_source=?,last_code=?,updated_at=?
        WHERE owner_ref=? AND account_ref=?`, values.streak, values.source, values.code ?? null, at, ownerRef, String(alias.account_ref));
    }
  }
  // Stability evidence belongs to the real subject and may be spent exactly
  // once. Consumption reads the shared row, then zeroes every row of the scope
  // and advances the generation in one transaction, so an alias that captured
  // the same stable session can never reset a second conflict streak, and a
  // restart cannot refill what was already retired.
  function consumeSubjectStability(ownerRef, accountRef, subjectRef) {
    const scope = verifiedSubjectScope(ownerRef, subjectRef), at = nowIso();
    if (!scope) {
      const row = cooldownInfo(ownerRef, accountRef);
      const evidenceMs = Math.max(0, Number(row?.stable_connected_ms) || 0);
      if (row) run('UPDATE backend_session_cooldowns SET stable_connected_ms=0 WHERE owner_ref=? AND account_ref=?', ownerRef, String(accountRef));
      return { scope: null, evidenceMs, generation: 0 };
    }
    const subject = get('SELECT * FROM backend_session_cooldown_subjects WHERE owner_ref=? AND subject_scope=?', ownerRef, scope);
    const generation = Math.max(0, Number(subject?.evidence_generation) || 0) + 1;
    const evidenceMs = Math.max(0, Number(subject?.stable_connected_ms) || 0);
    if (subject)
      run('UPDATE backend_session_cooldown_subjects SET stable_connected_ms=0,evidence_generation=?,updated_at=? WHERE owner_ref=? AND subject_scope=?',
        generation, at, ownerRef, scope);
    for (const alias of subjectAliases(ownerRef, scope))
      run('UPDATE backend_session_cooldowns SET stable_connected_ms=0,evidence_generation=? WHERE owner_ref=? AND account_ref=?',
        generation, ownerRef, String(alias.account_ref));
    return { scope, evidenceMs, generation };
  }
  // Only a positive SDK single-session result is treated as an account conflict.
  // A generic transport close, a world-session error we do not know, or a
  // server code outside the reviewed SDK namespace never escalates this.
  function noteSessionConflict(actor, policy) {
    return transaction(() => {
      const prior = cooldownInfo(actor.ownerRef, actor.accountRef) || {};
      const subjectPrior = subjectCooldownInfo(actor.ownerRef, actor.subjectRef) || {};
      const at = deviceNow();
      if (Number(prior.last_run_epoch) === Number(actor.runEpoch) &&
          Number(prior.last_connection_epoch) === Number(actor.connectionEpoch)) {
        const merged = mergeCooldown(prior, subjectPrior) || {};
        return { streak: merged.conflict_streak, until: merged.cooldown_until_ms,
          delayMs: Math.max(0, Number(merged.cooldown_until_ms || 0) - at), duplicate: true };
      }
      // The shared subject row is the canonical count once it exists; an alias
      // row may still hold a pre-reset value.
      const priorStreak = Math.max(0, Number(subjectPrior ? subjectPrior.conflict_streak : prior.conflict_streak) || 0);
      // Only a confirmed continuous connection interval may retire the streak,
      // and that evidence may be spent once for the whole real subject. The
      // consumption is atomic with this write: a second alias sees 0 here.
      const consumed = consumeSubjectStability(actor.ownerRef, actor.accountRef, actor.subjectRef);
      const stable = consumed.evidenceMs >= SESSION_CONFLICT_STABLE_MS;
      const streak = stable ? 1 : Math.min(64, priorStreak + 1);
      const delayMs = Math.min(SESSION_CONFLICT_MAX_MS, SESSION_CONFLICT_BASE_MS * 2 ** Math.min(streak - 1, 10));
      const until = Math.max(Number(prior.cooldown_until_ms || 0), Number(subjectPrior.cooldown_until_ms || 0), at + delayMs);
      saveCooldown(actor.ownerRef, actor.accountRef, actor.subjectRef, { streak, until, delayMs,
        source: policy.namespace, code: policy.code, lastRunEpoch: actor.runEpoch, lastConnectionEpoch: actor.connectionEpoch,
        stableConnectedMs: 0 });
      return { streak, until, delayMs, duplicate: false, consumedStableMs: consumed.evidenceMs };
    });
  }
  // Existing error strategies (throttle, egress wait, refresh-config, and the
  // SDK single-session base wait) persist their lower bound even when the SDK
  // login never opened a world socket.
  function notePolicyCooldown(actor, policy) {
    const delayMs = Number.isSafeInteger(policy.retryAfterMs) && policy.retryAfterMs > 0 ? policy.retryAfterMs : 0;
    if (!delayMs) return { until: cooldownUntil(actor.ownerRef, actor.accountRef), delayMs: 0 };
    const entry = cooldownEntry(actor.ownerRef, actor.accountRef);
    const prior = mergeCooldown(entry.account, entry.subject) || {};
    const until = Math.max(Number(prior.cooldown_until_ms || 0), deviceNow() + delayMs);
    saveCooldown(actor.ownerRef, actor.accountRef, actor.subjectRef, { streak: Math.max(0, Number(prior.conflict_streak || 0)),
      until, source: policy.namespace, code: policy.code });
    return { until, delayMs };
  }
  function noteSessionConnected(actor) {
    const at = deviceNow(), stamp = nowIso();
    if (cooldownInfo(actor.ownerRef, actor.accountRef)) run('UPDATE backend_session_cooldowns SET last_connected_ms=?,updated_at=? WHERE owner_ref=? AND account_ref=?',
      at, stamp, actor.ownerRef, String(actor.accountRef));
    const scope = verifiedSubjectScope(actor.ownerRef, actor.subjectRef);
    if (scope && get('SELECT 1 AS present FROM backend_session_cooldown_subjects WHERE owner_ref=? AND subject_scope=?', actor.ownerRef, scope))
      run('UPDATE backend_session_cooldown_subjects SET last_connected_ms=?,updated_at=? WHERE owner_ref=? AND subject_scope=?',
        at, stamp, actor.ownerRef, scope);
  }
  // The transport reports heartbeat-confirmed continuous time. That number is
  // the only evidence a later conflict may use to retire the streak, so a short
  // session followed by a long offline wait can never look stable. The capture
  // is tagged with the subject's current evidence generation; a later
  // consumption moves that generation and zeroes every row of the scope.
  function captureConnectionStability(actor) {
    if (!actor) return 0;
    let liveness = null;
    try { liveness = actor.connection?.liveness?.() ?? null; } catch { liveness = null; }
    const span = Number(liveness?.longestContinuousMs);
    if (!Number.isFinite(span) || span <= 0) return 0;
    const confirmed = Math.floor(span), at = nowIso();
    const scope = verifiedSubjectScope(actor.ownerRef, actor.subjectRef);
    return transaction(() => {
      const generation = scope
        ? Math.max(0, Number(get('SELECT evidence_generation FROM backend_session_cooldown_subjects WHERE owner_ref=? AND subject_scope=?',
          actor.ownerRef, scope)?.evidence_generation) || 0) : 0;
      if (cooldownInfo(actor.ownerRef, actor.accountRef))
        run('UPDATE backend_session_cooldowns SET stable_connected_ms=max(stable_connected_ms,?),evidence_generation=?,updated_at=? WHERE owner_ref=? AND account_ref=?',
          confirmed, generation, at, actor.ownerRef, String(actor.accountRef));
      if (scope && get('SELECT 1 AS present FROM backend_session_cooldown_subjects WHERE owner_ref=? AND subject_scope=?', actor.ownerRef, scope))
        run('UPDATE backend_session_cooldown_subjects SET stable_connected_ms=max(stable_connected_ms,?),evidence_generation=?,updated_at=? WHERE owner_ref=? AND subject_scope=?',
          confirmed, generation, at, actor.ownerRef, scope);
      return confirmed;
    });
  }
  function cooldownRejection(ownerRef, accountRef) {
    const remainingMs = cooldownRemaining(ownerRef, accountRef);
    if (remainingMs <= 0) return null;
    const row = cooldownEntry(ownerRef, accountRef).merged || {};
    return Object.assign(problem('SESSION_COOLDOWN_ACTIVE', '该官服账号的既有失败冷却尚未结束，暂不重新登录', 429),
      { retryAfterMs: remainingMs, cooldownUntilMs: row.cooldown_until_ms ?? null,
        conflictStreak: row.conflict_streak ?? null, lastCooldownSource: row.last_source ?? null, lastCooldownCode: row.last_code ?? null });
  }
  const recoveryLogStatuses = new Set(['attempting','cleanup_pending','waiting_network','scheduled','blocked','connected']);
  function saveRecovery(row) {
    const prior = recovery(row.ownerRef, row.accountRef);
    let priorError = {};
    try { priorError = parseStored(prior?.error_json, '恢复事件关联依据') || {}; } catch { priorError = {}; }
    const sameRunIncident = prior && prior.expected_run_epoch === row.runEpoch;
    const automaticRetryIncident = prior && row.reasonCode === 'SESSION_RECOVERY_ATTEMPT' &&
      prior.expected_run_epoch + 1 === row.runEpoch && prior.subject_ref === row.subjectRef;
    const canContinueIncident = (sameRunIncident || automaticRetryIncident) && prior.status !== 'stopped' &&
      prior.status !== 'suspended' && prior.status !== 'connected';
    const recoveryTraceId = typeof row.error?.recoveryTraceId === 'string' && /^sr:[A-Za-z0-9_-]{40,60}$/.test(row.error.recoveryTraceId)
      ? row.error.recoveryTraceId : canContinueIncident && typeof priorError.recoveryTraceId === 'string'
        ? priorError.recoveryTraceId : 'sr:' + fingerprint([row.ownerRef, row.subjectRef, row.runEpoch, row.connectionEpoch]).slice(0, 60);
    const recoveryError = { ...(row.error && typeof row.error === 'object' ? row.error : {}),
      ...(row.status === 'connected' ? {} : { recoveryTraceId }) };
    run(`INSERT INTO backend_session_recovery VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,account_ref)
      DO UPDATE SET subject_ref=excluded.subject_ref,status=excluded.status,attempt=excluded.attempt,max_attempts=excluded.max_attempts,
      expected_run_epoch=excluded.expected_run_epoch,expected_connection_epoch=excluded.expected_connection_epoch,retry_at_ms=excluded.retry_at_ms,
      reason_code=excluded.reason_code,error_json=excluded.error_json,close_evidence_ref=excluded.close_evidence_ref,updated_at=excluded.updated_at`,
    row.ownerRef, String(row.accountRef), row.subjectRef, row.status, row.attempt, 0, row.runEpoch,
    row.connectionEpoch, row.retryAtMs, row.reasonCode, canonical(recoveryError), row.closeEvidenceRef ?? null, nowIso());
    if (recoveryLogStatuses.has(row.status)) {
      const state = row.status === 'attempting' ? 'requested' : row.status === 'connected' ? 'completed'
        : row.status === 'blocked' ? 'failed' : 'incomplete';
      const error = row.error && typeof row.error === 'object' ? row.error : {};
      const eventRef = 'session-recovery:' + fingerprint([row.ownerRef, row.accountRef, row.subjectRef, row.runEpoch,
        row.connectionEpoch, row.status, row.attempt, row.retryAtMs, row.reasonCode, error]);
      appendRecoveryLog({ ownerRef: row.ownerRef, accountRef: row.accountRef, eventRef, traceId: recoveryTraceId,
        attempted: row.connectAttempted === true || error.connectAttempted === true ? true : null,
        runEpoch: row.runEpoch, connectionEpoch: row.connectionEpoch, retryAtMs: row.retryAtMs,
        reasonCode: row.reasonCode, status: row.status, attempt: row.attempt, error,
        eventState: state, closureProven: Boolean(row.closeEvidenceRef) });
    }
  }
  function sameRecoveryIntent(actor) {
    const latest = intent(actor.ownerRef, actor.accountRef);
    return latest?.desired_running === 1 && latest.subject_ref === actor.subjectRef && latest.run_epoch === actor.runEpoch && latest.connection_epoch === actor.connectionEpoch;
  }
  function retryable(error) {
    return classifySessionFailure(error).retryable;
  }
  function closureEvidence(actor, kind, proof) {
    const evidenceRef = 'session-close:' + fingerprint([executorRef, actor.subjectRef, actor.connectionEpoch, kind]);
    run('INSERT OR IGNORE INTO backend_session_connection_closures VALUES(?,?,?,?,?,?,?,?,?,?,?)', evidenceRef,
      actor.ownerRef, String(actor.accountRef), actor.subjectRef, executorRef, actor.ownerEpoch ?? null, actor.runEpoch,
      actor.connectionEpoch, kind, canonical(proof), nowIso());
    actor.closeEvidenceRef = evidenceRef;
    return evidenceRef;
  }
  function rejectedConnectionClosed(actor, error) {
    if (actor.connection) return false;
    if (!actor.connectAttempted) return true;
    if (error?.transportClosed === true && error.closedConnectionEpoch === actor.connectionEpoch) {
      closureEvidence(actor, error.worldSocketOpened === false ? 'http_auth_no_world' : 'transport-closed', { closed: true, connectionEpoch: actor.connectionEpoch,
        source: error.worldSocketOpened === false ? 'protocol-auth-no-world-receipt' : 'connect-rejected-after-physical-close',
        code: codeOf(error), closeEvidenceCode: error.closeEvidenceCode ?? null, worldSocketOpened: error.worldSocketOpened ?? null });
      actor.connectRejectedClosed = true; return true;
    }
    return false;
  }
  function scheduleAfterFailure(actor, error, closed, arm = true) {
    cancelRecoveryTimer(actor.ownerRef, actor.accountRef);
    const failurePolicy = classifySessionFailure(error);
    const result = transaction(() => {
      if (!sameRecoveryIntent(actor)) return null;
      const restarting = shuttingDown && codeOf(error) === 'ENGINE_RESTARTING';
      const old = recovery(actor.ownerRef, actor.accountRef), attempt = restarting ? 0 : Math.max(0, Number(old?.attempt || 0));
      // Only a positive, source-bound SDK single-session result may escalate the
      // per-account conflict cooldown. Every other timed strategy keeps its own
      // lower bound, and a proved-closed transport fault stays recoverable.
      if (!restarting && closed && failurePolicy.action === 'single-session') noteSessionConflict(actor, failurePolicy);
      else if (!restarting && closed) notePolicyCooldown(actor, failurePolicy);
      const cooldownFloor = cooldownUntil(actor.ownerRef, actor.accountRef);
      // A cleanup that repeatedly cannot prove physical close is bounded: after
      // this many attempts only this account is isolated with explicit evidence.
      // It is never reported as closed, and healthy accounts are untouched.
      const isolated = !closed && !restarting && attempt >= CLEANUP_MAX_ATTEMPTS;
      const canRetry = closed && (restarting || failurePolicy.retryable);
      const reasonCode = restarting ? 'ENGINE_RESTARTED' : isolated ? 'SESSION_CLEANUP_UNPROVEN_ISOLATED' :
        !closed ? 'SESSION_RECOVERY_CLEANUP_UNPROVEN' :
        failurePolicy.action === 'needs-credentials' ? 'SESSION_NEEDS_CREDENTIALS' : failurePolicy.action === 'account-disabled' ? 'SESSION_ACCOUNT_DISABLED' :
          failurePolicy.action === 'ownership-conflict' ? 'SESSION_SUBJECT_CONFLICT' : codeOf(error);
      const retryAtMs = restarting ? deviceNow() : isolated ? null :
        !closed ? Math.max(cooldownFloor, deviceNow() + backoff(attempt + 1)) : canRetry ? Math.max(Number(old?.retry_at_ms || 0),
        deviceNow() + (failurePolicy.retryAfterMs || backoff(attempt)), cooldownFloor) : null;
      const errorEvidence = restarting ? { code: 'ENGINE_RESTARTED', transportFailure: true, connectAttempted: actor.connectAttempted } :
        isolated ? { code: 'SESSION_CLEANUP_UNPROVEN_ISOLATED', transportFailure: true, action: 'cleanup-isolation',
          isolationOnly: true, userActionRequired: true, cleanupAttempts: attempt,
          lastFailureCode: codeOf(error), lastFailureTransportFailure: error?.transportFailure === true,
          sourceNamespace: failurePolicy.namespace, phase: failurePolicy.phase, closeEvidenceRef: actor.closeEvidenceRef ?? null } :
        { code: codeOf(error), transportFailure: error?.transportFailure === true, loginKind: failurePolicy.loginKind,
          loginCode: failurePolicy.loginCode, remoteCode: failurePolicy.remoteCode, loginCodeKey: failurePolicy.loginCodeKey,
          transportCode: failurePolicy.transportCode, sourceNamespace: failurePolicy.namespace, phase: failurePolicy.phase, action: failurePolicy.action,
          retryAfterMs: failurePolicy.retryAfterMs, userActionRequired: failurePolicy.userActionRequired,
          conflictStreak: cooldownEntry(actor.ownerRef, actor.accountRef).merged?.conflict_streak ?? null, cooldownUntilMs: cooldownFloor || null };
      saveRecovery({ ...actor, status: restarting ? 'cleanup_pending' : isolated ? 'blocked' : !closed ? 'cleanup_pending' : canRetry ? network.online === false ? 'waiting_network' : 'scheduled' : 'blocked',
        attempt, retryAtMs, reasonCode, error: errorEvidence, closeEvidenceRef: actor.closeEvidenceRef });
      const recoveryStatus = restarting ? 'cleanup_pending' : isolated ? 'blocked' : !closed ? 'cleanup_pending' : canRetry ? network.online === false ? 'waiting_network' : 'scheduled' : 'blocked';
      run('UPDATE backend_run_intents SET state=?,reason_code=?,retry_at_ms=?,updated_at=? WHERE owner_ref=? AND account_ref=? AND desired_running=1 AND run_epoch=? AND connection_epoch=?',
        restarting || !closed ? (isolated ? 'BLOCKED' : 'WAITING_LOGIN') : canRetry ? (failurePolicy.action === 'wait-network' ? 'WAITING_NETWORK' : 'WAITING_LOGIN') : 'BLOCKED',
        reasonCode, retryAtMs, nowIso(), actor.ownerRef, String(actor.accountRef), actor.runEpoch, actor.connectionEpoch);
      return recovery(actor.ownerRef, actor.accountRef);
    });
    if (result && arm) armRecovery(result);
    return result;
  }
  function armRecovery(saved) {
    cancelRecoveryTimer(saved.owner_ref, saved.account_ref);
    if (saved.retry_at_ms === null) recoveryDeadlines.delete(keyOf(saved.owner_ref, saved.account_ref));
    const cleanupPending = saved.status === 'cleanup_pending';
    if (shuttingDown || !recoveryOwners.has(saved.owner_ref) ||
        !(cleanupPending || ['scheduled', 'waiting_network'].includes(saved.status)) || saved.retry_at_ms === null ||
        !cleanupPending && network.online === false) return;
    const key = keyOf(saved.owner_ref, saved.account_ref);
    const dueMono = recoveryDeadline(saved);
    const timer = setTimeout(() => {
      if (recoveryTimers.get(key) !== timer) return;
      recoveryTimers.delete(key);
      if (cleanupPending) {
        const actor = actors.get(key);
        if (actor && sameRecoveryIntent(actor)) {
          const evidence = parseStored(saved.error_json, '会话清理重试依据');
          void requestAutomaticRecovery(actor, Object.assign(problem(evidence?.code || saved.reason_code || 'SESSION_CLEANUP_RETRY', '会话物理清理将自动重试'),
            { transportFailure: evidence?.transportFailure === true, loginKind: evidence?.loginKind ?? null,
              loginCode: evidence?.loginCode ?? null, remoteCode: evidence?.remoteCode ?? null,
              loginCodeKey: evidence?.loginCodeKey ?? null, sourceNamespace: evidence?.sourceNamespace ?? null,
              phase: evidence?.phase ?? null, action: evidence?.action ?? null,
              retryAfterMs: evidence?.retryAfterMs ?? null, userActionRequired: evidence?.userActionRequired === true })).catch(() => {});
        }
      } else void attemptRecovery(saved).catch(() => {});
    }, Math.min(2147483647, Math.max(1, Math.ceil(dueMono - monotonicNow()))));
    timer.unref?.(); recoveryTimers.set(key, timer);
  }
  function pendingSettled(ownerRef, accountRef) {
    const saved = recovery(ownerRef, accountRef);
    if (saved) armRecovery(saved);
  }
  /**
   * Safety net for a retry whose timer is gone. A wake that fires inside a
   * platform-restricted window can consume the appointment and leave the row
   * due with nothing armed (observed under Doze with network access suspended:
   * the delivery reached the process but the attempt could not run, and no app
   * network transition ever arrived to retrigger it). Only a row that has no
   * live timer, a matching desired intent, and an online/unknown network is
   * re-armed, and arming it recomputes the delay from the persisted deadline, so
   * one sweep cannot create a retry loop or shorten a real backoff.
   */
  function sweepDueRecoveries(nowMs = deviceNow()) {
    if (shuttingDown) return 0;
    let armed = 0;
    for (const ownerRef of recoveryOwners) {
      const rows = all(`SELECT * FROM backend_session_recovery WHERE owner_ref=?
        AND retry_at_ms IS NOT NULL AND status IN ('scheduled','waiting_network','cleanup_pending')`, ownerRef);
      for (const row of rows) {
        if (armed >= 16) break;
        const key = keyOf(row.owner_ref, row.account_ref);
        if (recoveryTimers.has(key) || pending.has(key)) continue;
        if (network.online === false) continue;
        // A cleanup that just started is left alone; a cleanup row only becomes
        // sweep-eligible once its own attempt window has clearly passed, so the
        // net cannot turn a hung close into a five-second retry loop.
        if (row.status === 'cleanup_pending') {
          const updatedMs = Date.parse(row.updated_at);
          if (Number.isFinite(updatedMs) && nowMs - updatedMs < 12_000) continue;
        }
        const latest = intent(row.owner_ref, row.account_ref);
        if (!latest || latest.desired_running !== 1 || latest.subject_ref !== row.subject_ref ||
            latest.run_epoch !== row.expected_run_epoch || latest.connection_epoch !== row.expected_connection_epoch) continue;
        armRecovery(row);
        if (recoveryTimers.has(key)) { armed += 1; recoverySweepArmed += 1; }
      }
      if (armed >= 16) break;
    }
    recoverySweeps += 1;
    recoverySweepLastAtMs = nowMs;
    return armed;
  }
  const recoverySweepTimer = setInterval(() => { try { sweepDueRecoveries(); } catch { /* bounded */ } }, 5000);
  recoverySweepTimer.unref?.();
  async function attemptRecovery(captured) {
    const key = keyOf(captured.owner_ref, captured.account_ref);
    if (shuttingDown || pending.has(key)) return;
    const next = transaction(() => {
      if (shuttingDown) return null;
      const saved = recovery(captured.owner_ref, captured.account_ref), latest = intent(captured.owner_ref, captured.account_ref);
      if (!recoveryOwners.has(captured.owner_ref) || !saved || !['scheduled', 'waiting_network'].includes(saved.status) ||
          !latest || latest.desired_running !== 1 || latest.run_epoch !== saved.expected_run_epoch || latest.connection_epoch !== saved.expected_connection_epoch ||
          saved.expected_run_epoch !== captured.expected_run_epoch || saved.expected_connection_epoch !== captured.expected_connection_epoch ||
          saved.retry_at_ms !== captured.retry_at_ms || saved.retry_at_ms === null || recoveryDeadline(saved) > monotonicNow() || network.online === false) return null;
      const retryAtMs = deviceNow() + backoff(saved.attempt + 1);
      saveRecovery({ ownerRef: saved.owner_ref, accountRef: saved.account_ref, subjectRef: saved.subject_ref, status: 'attempting',
        attempt: nextRecoveryAttempt(saved.attempt), runEpoch: latest.run_epoch, connectionEpoch: latest.connection_epoch, retryAtMs,
        reasonCode: 'SESSION_RECOVERY_ATTEMPT', error: parseStored(saved.error_json, '会话恢复依据'), closeEvidenceRef: saved.close_evidence_ref });
      run('UPDATE backend_run_intents SET retry_at_ms=?,updated_at=? WHERE owner_ref=? AND account_ref=? AND desired_running=1 AND run_epoch=? AND connection_epoch=?',
        retryAtMs, nowIso(), saved.owner_ref, saved.account_ref, latest.run_epoch, latest.connection_epoch);
      return { ownerRef: saved.owner_ref, accountRef: saved.account_ref, expectedRunEpoch: latest.run_epoch,
        expectedConnectionEpoch: latest.connection_epoch, commandId: newId(), automatic: true };
    });
    if (!next) {
      const latest = recovery(captured.owner_ref, captured.account_ref), latestIntent = intent(captured.owner_ref, captured.account_ref);
      const stillEligible = !shuttingDown && !pending.has(key) && network.online !== false && recoveryOwners.has(captured.owner_ref) &&
        latest && ['scheduled', 'waiting_network'].includes(latest.status) && latest.retry_at_ms !== null &&
        latest.subject_ref === captured.subject_ref && latest.expected_run_epoch === captured.expected_run_epoch &&
        latest.expected_connection_epoch === captured.expected_connection_epoch && latest.retry_at_ms === captured.retry_at_ms &&
        latestIntent?.desired_running === 1 && latestIntent.subject_ref === latest.subject_ref &&
        latestIntent.run_epoch === latest.expected_run_epoch && latestIntent.connection_epoch === latest.expected_connection_epoch;
      if (stillEligible) armRecovery(latest);
      return;
    }
    const flight = performStart(next).catch(error => {
      // A binding/subject conflict may reject before performStart creates an
      // actor. Retire only this attempted recovery, never the competing owner.
      transaction(() => {
        const latest = intent(next.ownerRef, next.accountRef), saved = recovery(next.ownerRef, next.accountRef);
        if (latest?.desired_running !== 1 || latest.run_epoch !== next.expectedRunEpoch || latest.connection_epoch !== next.expectedConnectionEpoch || saved?.status !== 'attempting') return;
        const policy = classifySessionFailure(error), attempt = nextRecoveryAttempt(saved.attempt);
        const retryable = policy.retryable === true;
        const retryAtMs = retryable ? deviceNow() + (policy.retryAfterMs || backoff(attempt)) : null;
        const reasonCode = policy.action === 'needs-credentials' ? 'SESSION_NEEDS_CREDENTIALS' :
          policy.action === 'account-disabled' ? 'SESSION_ACCOUNT_DISABLED' : policy.action === 'ownership-conflict' ? 'SESSION_SUBJECT_CONFLICT' : codeOf(error);
        saveRecovery({ ownerRef: next.ownerRef, accountRef: next.accountRef, subjectRef: latest.subject_ref,
          status: retryable ? 'scheduled' : 'blocked', attempt, runEpoch: latest.run_epoch, connectionEpoch: latest.connection_epoch,
          retryAtMs, reasonCode, error: { code: codeOf(error), action: policy.action, phase: policy.phase,
            sourceNamespace: policy.namespace, loginKind: policy.loginKind, loginCode: policy.loginCode,
            remoteCode: policy.remoteCode, retryAfterMs: policy.retryAfterMs, userActionRequired: policy.userActionRequired },
          closeEvidenceRef: saved.close_evidence_ref });
        run('UPDATE backend_run_intents SET state=?,reason_code=?,retry_at_ms=?,updated_at=? WHERE owner_ref=? AND account_ref=? AND desired_running=1 AND run_epoch=? AND connection_epoch=?',
          retryable ? policy.action === 'wait-network' ? 'WAITING_NETWORK' : 'WAITING_LOGIN' : 'BLOCKED',
          reasonCode, retryAtMs, nowIso(), next.ownerRef, next.accountRef, next.expectedRunEpoch, next.expectedConnectionEpoch);
      });
      throw error;
    }).finally(() => { if (pending.get(key) === flight) pending.delete(key); pendingSettled(next.ownerRef, next.accountRef); });
    pending.set(key, flight);
    return flight;
  }
  function requestAutomaticRecovery(actor, error) {
    if (actor.recoveryPromise) return actor.recoveryPromise;
    if (shuttingDown) return Promise.resolve();
    const key = keyOf(actor.ownerRef, actor.accountRef), before = pending.get(key);
    const flight = (async () => {
      if (!sameRecoveryIntent(actor) || actors.get(key) !== actor) return;
      transition(actor, 'RECOVERING', codeOf(error));
      transaction(() => {
        if (!sameRecoveryIntent(actor)) return;
        const saved = recovery(actor.ownerRef, actor.accountRef), attempt = Number(saved?.attempt || 0);
        const failurePolicy = classifySessionFailure(error);
        const cleanupAttempt = nextRecoveryAttempt(attempt);
        saveRecovery({ ...actor, status: 'cleanup_pending', attempt: cleanupAttempt, retryAtMs: deviceNow() + backoff(cleanupAttempt),
          reasonCode: codeOf(error), error: { code: codeOf(error), transportFailure: error?.transportFailure === true,
            loginKind: failurePolicy.loginKind, loginCode: failurePolicy.loginCode, remoteCode: failurePolicy.remoteCode,
            loginCodeKey: failurePolicy.loginCodeKey, sourceNamespace: failurePolicy.namespace, phase: failurePolicy.phase,
            action: failurePolicy.action, retryAfterMs: failurePolicy.retryAfterMs, userActionRequired: failurePolicy.userActionRequired },
          closeEvidenceRef: actor.closeEvidenceRef });
      });
      const writeDrain = captureWriteDrain(actor, codeOf(error));
      actor.controller.abort(error);
      let hookComplete = true;
      try { notifyStopped(actor); } catch { hookComplete = false; }
      let timer, closed = false;
      const closing = (async () => {
        if (before) await before.catch(() => {});
        const transportClosed = await closeTransport(actor).catch(() => false);
        const durableOutcome = await writeDrainComplete(writeDrain);
        return transportClosed && durableOutcome && hookComplete;
      })();
      try { closed = await Promise.race([closing, new Promise(resolve => { timer = setTimeout(() => resolve(false), cleanupTimeoutMs); })]); }
      finally { clearTimeout(timer); }
      let ownerChanged = false;
      let nextRecovery = null;
      if (closed) transaction(() => {
        if (actors.get(key) !== actor) return;
        ownerChanged = !ownsSubject(actor);
        run('UPDATE backend_subject_owners SET active=0,updated_at=? WHERE subject_ref=? AND owner_ref=? AND executor_ref=? AND owner_epoch=?', nowIso(), actor.subjectRef, actor.ownerRef, executorRef, actor.ownerEpoch);
        actors.delete(key);
        nextRecovery = scheduleAfterFailure(actor, ownerChanged ? problem('SUBJECT_OWNER_CHANGED', '旧连接清理期间主体执行权已变化') : error, true, false);
      });
      else nextRecovery = scheduleAfterFailure(actor, error, false, false);
      if (nextRecovery) armRecovery(nextRecovery);
      if (!closed) closing.then(provedClosed => {
        if (provedClosed) setTimeout(() => {
          if (sameRecoveryIntent(actor) && actors.get(key) === actor) void requestAutomaticRecovery(actor, error).catch(() => {});
        }, 0);
      });
    })().finally(() => {
      actor.recoveryPromise = null;
      if (pending.get(key) === flight) pending.delete(key);
      pendingSettled(actor.ownerRef, actor.accountRef);
    });
    actor.recoveryPromise = flight; pending.set(key, flight); return flight;
  }
  function recoverStalledSchedulerStage(stage) {
    if (!stage || stage.overdue !== true || typeof stage.ownerRef !== 'string' ||
        typeof stage.accountRef !== 'string' || typeof stage.subjectRef !== 'string' ||
        !Number.isSafeInteger(stage.ownerEpoch) || !Number.isSafeInteger(stage.runEpoch) ||
        !Number.isSafeInteger(stage.connectionEpoch) || typeof stage.stage !== 'string') return false;
    const actor = actors.get(keyOf(stage.ownerRef, stage.accountRef));
    const verificationOriginal = actor?.verificationLease?.operationId === stage.operationId
      ? actor.verificationLease.originalContext : null;
    const exactActorConnection = actor?.connectionEpoch === stage.connectionEpoch;
    const capturedVerification = verificationOriginal && verificationOriginal.ownerRef === stage.ownerRef &&
      String(verificationOriginal.accountRef) === stage.accountRef && verificationOriginal.subjectRef === stage.subjectRef &&
      verificationOriginal.ownerEpoch === stage.ownerEpoch && verificationOriginal.runEpoch === stage.runEpoch &&
      verificationOriginal.connectionEpoch === stage.connectionEpoch;
    if (!actor || actor.subjectRef !== stage.subjectRef || actor.ownerRef !== stage.ownerRef ||
        actor.ownerEpoch !== stage.ownerEpoch || actor.runEpoch !== stage.runEpoch || !(exactActorConnection || capturedVerification) ||
        !sameRecoveryIntent(actor) || !ownsSubject(actor)) return false;
    const error = Object.assign(problem('SCHEDULER_STAGE_STALLED', '单账号业务阶段超过无进展期限，正在隔离该账号并安全恢复'), {
      phase: stage.stage, retryAfterMs: 5000, accountRef: stage.accountRef, featureKey: stage.featureKey,
      stageStartedAtMs: stage.startedAtMs, stageDeadlineAtMs: stage.deadlineAtMs });
    void requestAutomaticRecovery(actor, error).catch(() => {});
    return true;
  }
  function binding(ownerRef, accountRef) {
    const row = get('SELECT * FROM backend_subject_bindings WHERE owner_ref=? AND account_ref=?', ownerRef, String(accountRef));
    if (!row) throw problem('SUBJECT_BINDING_REQUIRED', '游戏主体尚未完成有来源的资料绑定');
    return row;
  }
  function bind(input) {
    for (const name of ['ownerRef', 'subjectRef', 'basis', 'identityVersion', 'channel']) requireText(input[name], name);
    const accountRef = String(input.accountRef); requireText(accountRef, 'accountRef');
    if (!input.evidence?.sourceRef || !input.evidence?.sourceVersion) throw problem('SUBJECT_BINDING_EVIDENCE_REQUIRED', '主体绑定缺少来源与版本', 400);
    return transaction(() => {
      const old = get('SELECT * FROM backend_subject_bindings WHERE owner_ref=? AND account_ref=?', input.ownerRef, accountRef);
      if (old && old.subject_ref !== input.subjectRef) throw problem('SUBJECT_BINDING_CONFLICT', '现有资料主体不能由新标识覆盖');
      run('INSERT OR IGNORE INTO backend_subject_bindings VALUES(?,?,?,?,?,?,?,?)', input.ownerRef, accountRef, input.subjectRef,
        input.basis, input.identityVersion, input.channel, canonical(input.evidence), nowIso());
      for (const alias of input.aliases || []) {
        if (!alias.aliasRef || !alias.basis || !alias.identityVersion || !alias.evidence?.sourceRef) throw problem('SUBJECT_ALIAS_EVIDENCE_REQUIRED', '历史别名缺少关联依据', 400);
        run('INSERT OR IGNORE INTO backend_subject_aliases VALUES(?,?,?,?,?,?)', input.subjectRef, alias.aliasRef, alias.basis, alias.identityVersion, canonical(alias.evidence), nowIso());
      }
      return binding(input.ownerRef, accountRef);
    });
  }
  function intent(ownerRef, accountRef) { return get('SELECT * FROM backend_run_intents WHERE owner_ref=? AND account_ref=?', ownerRef, String(accountRef)); }
  function assertSupervisorOpen() {
    if (shuttingDown) throw problem('ENGINE_RESTARTING', '本机执行器正在安全退出，暂不接受新会话操作', 503);
  }
  function isShuttingDown() { return shuttingDown; }
  function holdForProcessRestart() { shuttingDown = true; clearInterval(recoverySweepTimer); return true; }
  function healthSnapshot() {
    const activeKeys = new Set(), nowMono = monotonicNow();
    const healthyContexts = [...actors.values()].filter(actor => actor.startComplete === true && FACT_STATES.has(actor.state) &&
      matchesIntent(actor) && connectionCurrent(actor)).map(actor => ({ ownerRef: actor.ownerRef, accountRef: String(actor.accountRef),
        subjectRef: actor.subjectRef, ownerEpoch: actor.ownerEpoch, runEpoch: actor.runEpoch, connectionEpoch: actor.connectionEpoch }));
    const pendingCleanup = all(`SELECT r.owner_ref,r.account_ref,r.subject_ref,r.expected_run_epoch,r.expected_connection_epoch,
      r.reason_code FROM backend_session_recovery r JOIN backend_run_intents i
      ON i.owner_ref=r.owner_ref AND i.account_ref=r.account_ref AND i.subject_ref=r.subject_ref
      AND i.run_epoch=r.expected_run_epoch AND i.connection_epoch=r.expected_connection_epoch
      WHERE r.status='cleanup_pending' AND i.desired_running=1`)
      .map(row => {
        const key = keyOf(row.owner_ref, row.account_ref) + ':' + row.expected_run_epoch + ':' + row.expected_connection_epoch;
        activeKeys.add(key);
        if (!cleanupPendingSince.has(key)) cleanupPendingSince.set(key, nowMono);
        const ageMs = Math.max(0, Math.floor(nowMono - cleanupPendingSince.get(key)));
        return { ownerRef: row.owner_ref, accountRef: String(row.account_ref), subjectRef: row.subject_ref,
          runEpoch: row.expected_run_epoch, connectionEpoch: row.expected_connection_epoch,
          reasonCode: row.reason_code, ageMs, escalationLimitMs: cleanupEscalationMs, overdue: ageMs >= cleanupEscalationMs };
      });
    for (const key of cleanupPendingSince.keys()) if (!activeKeys.has(key)) cleanupPendingSince.delete(key);
    // Bounded cleanup: after the attempt bound only the affected account is
    // isolated (never reported as closed). A shared-process restart is still
    // not authorised by one account's cleanup, because other accounts may hold
    // long but valid post-reads.
    const isolatedCleanup = all(`SELECT owner_ref,account_ref,subject_ref,attempt,reason_code,error_json,updated_at
      FROM backend_session_recovery WHERE status='blocked' AND reason_code='SESSION_CLEANUP_UNPROVEN_ISOLATED'`)
      .map(row => {
        let evidence = {};
        try { evidence = parseStored(row.error_json, '清理隔离依据') || {}; } catch { evidence = {}; }
        return { ownerRef: row.owner_ref, accountRef: String(row.account_ref), subjectRef: row.subject_ref,
          attempt: row.attempt, reasonCode: row.reason_code, isolationOnly: evidence.isolationOnly === true,
          cleanupAttempts: evidence.cleanupAttempts ?? null, lastFailureCode: evidence.lastFailureCode ?? null,
          closeEvidenceRef: evidence.closeEvidenceRef ?? null, updatedAt: row.updated_at };
      });
    // A single account's overdue cleanup is not sufficient evidence for a
    // shared-process restart: other accounts may still own long, valid
    // post-reads. Keep the precise account diagnostic visible and leave the
    // account in cleanup_pending until a separately reviewed global drain
    // protocol can safely authorize process-level escalation.
    return { pendingCleanup, overdueCleanupCount: pendingCleanup.filter(row => row.overdue).length,
      isolatedCleanup, healthyContexts, requiresProcessRestart: false,
      recoverySweep: { sweeps: recoverySweeps, armed: recoverySweepArmed, lastAtMs: recoverySweepLastAtMs },
      // Bounded recovery visibility so a stall can be diagnosed without DB access:
      // the row's own status, deadline and whether this process still holds a timer.
      recoveries: all(`SELECT owner_ref,account_ref,status,attempt,retry_at_ms,reason_code,updated_at
        FROM backend_session_recovery ORDER BY account_ref LIMIT 16`).map(row => ({
        accountRef: String(row.account_ref), status: row.status, attempt: row.attempt,
        retryAtMs: row.retry_at_ms, reasonCode: row.reason_code, updatedAt: row.updated_at,
        timerArmed: recoveryTimers.has(keyOf(row.owner_ref, row.account_ref)),
        flightPending: pending.has(keyOf(row.owner_ref, row.account_ref)) })) };
  }
  function matchesIntent(actor) {
    if (actors.get(keyOf(actor.ownerRef, actor.accountRef)) !== actor) return false;
    if (isAccountStopPending({ ownerRef: actor.ownerRef, accountRef: String(actor.accountRef), subjectRef: actor.subjectRef }) === true) return false;
    const row = intent(actor.ownerRef, actor.accountRef);
    return row?.desired_running === 1 && row.subject_ref === actor.subjectRef &&
      row.run_epoch === actor.runEpoch && row.connection_epoch === actor.connectionEpoch;
  }
  const sameOwner = (left, right) => !left && !right || Boolean(left && right && left.owner_ref === right.owner_ref &&
    left.executor_ref === right.executor_ref && left.owner_epoch === right.owner_epoch);
  function ownsSubject(actor) {
    const owner = get('SELECT * FROM backend_subject_owners WHERE subject_ref=?', actor.subjectRef);
    return owner?.owner_ref === actor.ownerRef && owner.executor_ref === executorRef && owner.owner_epoch === actor.ownerEpoch;
  }
  function current(actor) {
    return matchesIntent(actor) && !actor.controller.signal.aborted && ownsSubject(actor) &&
      get('SELECT active FROM backend_subject_owners WHERE subject_ref=?', actor.subjectRef)?.active === 1;
  }
  function connectionCurrent(actor) {
    // Login observations arrive before connect() returns its connection object.
    // A close notification is final even in that window.
    return current(actor) && !actor.transportClosed && FACT_STATES.has(actor.state) &&
      (actor.connection ? actor.connection.isOpen() === true : actor.state === 'CONNECTING');
  }
  function notifyStopped(actor, repeat = false) {
    if (!actor || actor.stopNotified && !repeat || actors.get(keyOf(actor.ownerRef, actor.accountRef)) !== actor || !ownsSubject(actor)) return;
    onStop({ ownerRef: actor.ownerRef, accountRef: actor.accountRef, subjectRef: actor.subjectRef,
      ownerEpoch: actor.ownerEpoch, runEpoch: actor.runEpoch, connectionEpoch: actor.connectionEpoch });
    actor.stopNotified = true;
  }
  async function closeTransport(actor) {
    if (!actor?.connection) return !actor?.connectAttempted || actor.connectRejectedClosed === true;
    // isOpen() alone is not physical-close evidence: it is already false after
    // abort/intent revocation. The transport must acknowledge actual closure.
    const receipt = await actor.connection.close();
    const closed = receipt?.closed === true && receipt.connectionEpoch === actor.connectionEpoch && actor.connection.isOpen() === false;
    if (closed) {
      actor.transportClosed = true;
      captureConnectionStability(actor);
      closureEvidence(actor, 'transport-closed', { closed: true, connectionEpoch: actor.connectionEpoch,
        code: typeof receipt.code === 'string' ? receipt.code.slice(0, 80) : null, source: 'transport-close-receipt' });
    }
    return closed;
  }
  function leaseEvent(leaseRef, kind, receipt) {
    run('INSERT INTO backend_session_verification_events VALUES(?,?,?,?,?)', 'verification-event:' + newId(), leaseRef, kind, canonical(receipt), nowIso());
  }
  function verificationLease({ subjectRef, ownerRef = null } = {}) {
    requireText(subjectRef, 'subjectRef');
    const row = get('SELECT * FROM backend_session_verification_leases WHERE subject_ref=? AND active=1', subjectRef);
    if (!row) return { active: false, leaseRef: null, operationId: null };
    return freeze({ active: true, leaseRef: row.lease_ref, operationId: row.operation_id, ownerRef: row.owner_ref,
      owned: ownerRef === null || ownerRef === row.owner_ref, state: row.state, originalContext: parseStored(row.original_context_json, 'verification original context'),
      newContext: row.new_connection_epoch === null ? null : { ...parseStored(row.original_context_json, 'verification original context'), connectionEpoch: row.new_connection_epoch },
      bridgeFingerprint: row.bridge_fingerprint, reasonCode: row.reason_code });
  }
  function answeredOperation(context, operationId, after, sourceExecutor, requireSlot = false) {
    const operation = get('SELECT * FROM backend_operations WHERE operation_id=?', operationId);
    const ordinaryFlower = operation && Object.values(ORDER_FLOWER_CONTRACTS).find(one => one.featureId === operation.feature_id &&
      one.scope === operation.scope && one.method === operation.method);
    const auxiliaryFlower = operation && ORDER_FLOWER_AUXILIARY_OPERATIONS.find(one => one.featureId === operation.feature_id &&
      one.scope === operation.scope && one.method === operation.method);
    const waterwheelKind = operation && Object.keys(WATERWHEEL_METHODS).find(kind => operation.feature_id === 'waterwheel' &&
      WATERWHEEL_SCOPES[kind] === operation.scope && WATERWHEEL_METHODS[kind] === operation.method);
    const freeWaterKind = operation && Object.keys(FREE_WATER_METHODS).find(kind => operation.feature_id === 'free-water' &&
      FREE_WATER_SCOPES[kind] === operation.scope && FREE_WATER_METHODS[kind] === operation.method);
    const flowerRackKind = operation && Object.keys(FLOWER_RACK_METHODS).find(kind => operation.feature_id === 'flower-rack' &&
      FLOWER_RACK_SCOPES[kind] === operation.scope && FLOWER_RACK_METHODS[kind] === operation.method);
    const dailyArtOperation = operation?.feature_id === DAILY_ART_CONTRACT.featureId && operation.scope === DAILY_ART_CONTRACT.scope &&
      operation.method === DAILY_ART_CONTRACT.method;
    const firstAlbumOperation = operation?.feature_id === ART_FIRST_ALBUM_CONTRACT.featureId && operation.scope === ART_FIRST_ALBUM_CONTRACT.scope &&
      operation.method === ART_FIRST_ALBUM_CONTRACT.method;
    const firstShareOperation = operation?.feature_id === ART_FIRST_SHARE_CONTRACT.featureId && operation.scope === ART_FIRST_SHARE_CONTRACT.scope &&
      operation.method === ART_FIRST_SHARE_CONTRACT.method;
    const customerArtBatchOperation = operation?.feature_id === CUSTOMER_ART_BATCH_CONTRACT.featureId && operation.scope === CUSTOMER_ART_BATCH_CONTRACT.scope &&
      operation.method === CUSTOMER_ART_BATCH_CONTRACT.method;
    // R10 reward/upgrade cards: the exact feature+scope+method triple must match
    // the card declaration; names alone never widen this gate.
    const rewardOperation = operation && REWARD_CARDS.some(card => card.featureId === operation.feature_id &&
      card.methodScopes[operation.method] === operation.scope);
    if (!operation || operation.owner_ref !== context.ownerRef || operation.account_ref !== context.accountRef || operation.subject_ref !== context.subjectRef ||
      operation.run_epoch !== context.runEpoch || operation.connection_epoch !== context.connectionEpoch || after.connectionEpoch !== context.connectionEpoch ||
      !((operation.feature_id === 'order.customer' && operation.scope === 'order-customer' && operation.method === 'orderCustomer.finishOrder') ||
        (operation.feature_id === 'art.make' && operation.scope === 'flower-art-make' && operation.method === 'flowerArt.makeFlowerArt') ||
        (operation.feature_id === 'order.customer' && operation.scope === 'order-reject' && operation.method === 'orderCustomer.rejectOrder') ||
        (operation.feature_id === 'order.customer' && operation.scope === 'order-customer-gen' && operation.method === 'orderCustomer.genOrder') || ordinaryFlower || auxiliaryFlower || waterwheelKind || freeWaterKind || flowerRackKind || dailyArtOperation || firstAlbumOperation || firstShareOperation || customerArtBatchOperation || rewardOperation)) {
      throw problem('VERIFICATION_OPERATION_SCOPE_MISMATCH', '独立核验未绑定原操作与连接');
    }
    const original = parseStored(operation.original_json, 'verification original operation');
    if (ledgerJsonFingerprint(original) !== operation.original_fingerprint || original.ownerEpoch !== context.ownerEpoch || original.executorRef !== sourceExecutor) {
      throw problem('VERIFICATION_OPERATION_ORIGINAL_INVALID', '独立核验原操作指纹或执行权不一致');
    }
    if (ordinaryFlower) {
      // Only these three new ordinary contracts may use this bridge. Rebuild
      // their bounded proposal from exact immutable preparation evidence so
      // merely choosing an allowed method cannot bypass occurrence/day/UID,
      // 107, original profile/reward sources, or every flower reservation.
      const readEvidence = (key, kind) => {
        const row = get(`SELECT kind,source,payload_json,payload_fingerprint,observed_at FROM backend_operation_evidence
          WHERE operation_id=? AND evidence_key=? AND kind=? AND source='backend/write-gateway/v2'`, operationId, key, kind);
        const payload = row ? parseStored(row.payload_json, '普通订单原合同证据') : null;
        if (!row || ledgerJsonFingerprint({ kind: row.kind, source: row.source, payload, observedAt: row.observed_at }) !== row.payload_fingerprint) {
          throw problem('VERIFICATION_OPERATION_CONTRACT_INVALID', '普通订单缺少完整的不可变合同证据');
        }
        return payload;
      };
      const admitted = readEvidence('admitted-operation-contract:v1', 'admitted-operation-contract');
      const prepared = readEvidence('finite-domain-preparation:v1', 'finite-domain-preparation');
      try { assertOrderFlowerImmutableEvidence({ admitted, prepared, definition: ordinaryFlower, original }); }
      catch { throw problem('VERIFICATION_OPERATION_CONTRACT_INVALID', '普通订单关闭后登录合同与原准入不一致'); }
    }
    if (auxiliaryFlower) {
      const readEvidence = (key, kind) => {
        const row = get(`SELECT kind,source,payload_json,payload_fingerprint,observed_at FROM backend_operation_evidence
          WHERE operation_id=? AND evidence_key=? AND kind=? AND source='backend/write-gateway/v2'`, operationId, key, kind);
        const payload = row ? parseStored(row.payload_json, '订单辅助合同证据') : null;
        if (!row || ledgerJsonFingerprint({ kind: row.kind, source: row.source, payload, observedAt: row.observed_at }) !== row.payload_fingerprint) {
          throw problem('VERIFICATION_OPERATION_CONTRACT_INVALID', '订单辅助操作缺少完整的不可变合同证据');
        }
        return payload;
      };
      const admitted = readEvidence('admitted-operation-contract:v1', 'admitted-operation-contract');
      const { family, domain, preparationField, assertPrepared, ...definition } = auxiliaryFlower;
      const expectedContract = { ...definition, postRead: ORDER_FLOWER_AUX_POST_READ };
      if (canonical(admitted) !== canonical(expectedContract)) throw problem('VERIFICATION_OPERATION_CONTRACT_INVALID', '订单辅助后读合同与原准入不一致');
      const prepared = readEvidence('finite-domain-preparation:v1', 'finite-domain-preparation');
      if (prepared?.domain !== domain || original.featureId !== operation.feature_id || original.scope !== operation.scope || original.method !== operation.method) {
        throw problem('VERIFICATION_OPERATION_CONTRACT_INVALID', '订单辅助原业务域或方法绑定不一致');
      }
      assertPrepared({ original, preparation: prepared.preparation });
    }
    if (waterwheelKind) {
      const readEvidence = (key, kind) => {
        const row = get(`SELECT kind,source,payload_json,payload_fingerprint,observed_at FROM backend_operation_evidence
          WHERE operation_id=? AND evidence_key=? AND kind=? AND source='backend/write-gateway/v2'`, operationId, key, kind);
        const payload = row ? parseStored(row.payload_json, '水车不可变后验合同') : null;
        if (!row || ledgerJsonFingerprint({ kind: row.kind, source: row.source, payload, observedAt: row.observed_at }) !== row.payload_fingerprint)
          throw problem('VERIFICATION_OPERATION_CONTRACT_INVALID', '水车缺少完整的不可变准入证据');
        return payload;
      };
      const admitted = readEvidence('admitted-operation-contract:v1', 'admitted-operation-contract');
      const prepared = readEvidence('finite-domain-preparation:v1', 'finite-domain-preparation');
      const { validateResponseCoverage: _coverage, ...postRead } = WATERWHEEL_POST_READ;
      const expected = { featureId: 'waterwheel', scope: operation.scope, method: operation.method,
        contractId: 'waterwheel/official-actions/v1/' + waterwheelKind, targetKind: 'waterwheel',
        params: waterwheelKind === 'share' ? { shareId: 9, ext: { opType: 1 } } : {},
        postRead };
      const prep = prepared?.preparation, target = original.targets?.[0];
      const expectedTargetRef = prep ? `waterwheel:${context.subjectRef}:${prep.generationRef}:${prep.count}:${prep.slot}` : null;
      const sourceReceipt = prep?.sourceRef ? get('SELECT * FROM backend_waterwheel_receipts WHERE response_ref=? AND owner_ref=? AND account_ref=? AND subject_ref=? AND connection_epoch=?',
        prep.sourceRef, context.ownerRef, context.accountRef, context.subjectRef, context.connectionEpoch) : null;
      let sourceValue = null;
      try { sourceValue = sourceReceipt ? parseStored(sourceReceipt.value_json, '水车桥原事实') : null; } catch { sourceValue = null; }
      if (canonical(admitted) !== canonical(expected) || prepared?.domain !== operation.scope || !prep || prep.kind !== waterwheelKind ||
          typeof prep.extensionRef !== 'string' || prep.extensionRef !== 'sha256:' + fingerprint(Object.fromEntries(Object.entries(prep.extension || {}).filter(([key]) => key !== 'extensionRef'))) ||
          prep.extension?.extensionRef !== prep.extensionRef || prep.extension?.loginResponseRef !== prep.loginResponseRef ||
          !positive(prep.uid) || target?.targetKind !== 'waterwheel' ||
          target.targetRef !== expectedTargetRef || target.memberKey !== 'waterwheel:' + fingerprint([prep.generationRef, prep.count, prep.slot]) ||
          target.lifecycleRef !== prep.generationRef || target.targetFingerprint !== fingerprint({ targetRef: expectedTargetRef,
            sourceRef: prep.sourceRef, extensionRef: prep.extensionRef }) || !sourceReceipt ||
          sourceReceipt.value_fingerprint !== fingerprint(sourceValue) || sourceReceipt.method !== prep.sourceMethod ||
          sourceReceipt.value_fingerprint !== prep.sourceFingerprint ||
          sourceValue?.uid !== prep.uid || sourceValue?.count !== prep.before?.count ||
          canonical(sourceValue?.advList) !== canonical(prep.before?.advList) || original.featureId !== 'waterwheel' ||
          original.scope !== operation.scope || original.method !== operation.method)
        throw problem('VERIFICATION_OPERATION_CONTRACT_INVALID', '水车后验合同与原准入、机会或公开来源不一致');
    }
    if (freeWaterKind) {
      const readEvidence = (key, kind) => {
        const row = get(`SELECT kind,source,payload_json,payload_fingerprint,observed_at FROM backend_operation_evidence
          WHERE operation_id=? AND evidence_key=? AND kind=? AND source='backend/write-gateway/v2'`, operationId, key, kind);
        const payload = row ? parseStored(row.payload_json, '每日水滴不可变合同') : null;
        if (!row || ledgerJsonFingerprint({ kind: row.kind, source: row.source, payload, observedAt: row.observed_at }) !== row.payload_fingerprint)
          throw problem('VERIFICATION_OPERATION_CONTRACT_INVALID', '每日水滴缺少完整的不可变准入证据');
        return payload;
      };
      const admitted = readEvidence('admitted-operation-contract:v1', 'admitted-operation-contract');
      const prepared = readEvidence('finite-domain-preparation:v1', 'finite-domain-preparation');
      const { validateResponseCoverage: _coverage, ...postRead } = FREE_WATER_POST_READ;
      const expected = { featureId: 'free-water', scope: operation.scope, method: operation.method,
        contractId: FREE_WATER_DEFINITIONS[freeWaterKind].contractId, targetKind: 'free-water',
        paramsContract: 'free-water-index-0-or-1/v1', postRead };
      const prep = prepared?.preparation, target = original.targets?.[0];
      const targetRef = prep ? `free-water:${context.subjectRef}:${prep.dayKey}:${prep.idx}` : null;
      const row = prep?.sourceRef ? get('SELECT * FROM backend_free_water_receipts WHERE response_ref=? AND owner_ref=? AND account_ref=? AND subject_ref=? AND connection_epoch=?',
        prep.sourceRef, context.ownerRef, context.accountRef, context.subjectRef, context.connectionEpoch) : null;
      let value = null; try { value = row ? parseStored(row.value_json, '每日水滴原始来源') : null; } catch { value = null; }
      const factSnapshot = prep?.factSnapshot, shareSource = factSnapshot?.sources?.share13;
      const shareRow = shareSource?.responseRef ? get('SELECT * FROM backend_free_water_receipts WHERE response_ref=? AND owner_ref=? AND account_ref=? AND subject_ref=? AND connection_epoch=?',
        shareSource.responseRef, context.ownerRef, context.accountRef, context.subjectRef, context.connectionEpoch) : null;
      let shareValue = null; try { shareValue = shareRow ? parseStored(shareRow.value_json, '每日水滴分享来源') : null; } catch { shareValue = null; }
      const factSnapshotValid = plainObject(factSnapshot) && plainObject(factSnapshot.value) && plainObject(factSnapshot.sources) &&
        factSnapshot.fingerprint === prep.sourceFingerprint && factSnapshot.fingerprint === fingerprint({ value: factSnapshot.value, sources: factSnapshot.sources }) &&
        factSnapshot.sources.water?.responseRef === prep.sourceRef && value && canonical(value.water) === canonical(factSnapshot.value.water) &&
        (factSnapshot.value.share13 === null ? !shareSource && !shareRow : shareSource?.responseRef && shareRow && shareValue &&
          canonical(shareValue.share13) === canonical(factSnapshot.value.share13) && shareRow.value_fingerprint === fingerprint(shareValue));
      if (canonical(admitted) !== canonical(expected) || prepared?.domain !== operation.scope || !prep || prep.kind !== freeWaterKind ||
          !Number.isSafeInteger(prep.idx) || (prep.idx !== 0 && prep.idx !== 1) || !Number.isSafeInteger(prep.uid) || prep.uid <= 0 ||
          target?.targetKind !== 'free-water' || target.targetRef !== targetRef ||
          target.memberKey !== 'free-water:' + fingerprint([prep.dayKey, prep.idx]) ||
          target.targetFingerprint !== fingerprint({ targetRef, sourceRef: prep.sourceRef, extensionRef: prep.extensionRef }) || !row ||
          row.value_fingerprint !== fingerprint(value) || !factSnapshotValid || original.featureId !== 'free-water' || original.scope !== operation.scope || original.method !== operation.method ||
          !plainObject(prep.extension) || prep.extension.extensionRef !== prep.extensionRef || prep.extensionRef !== 'sha256:' + fingerprint(Object.fromEntries(Object.entries(prep.extension).filter(([key]) => key !== 'extensionRef'))) ||
          prep.extension.loginResponseRef !== prep.loginResponseRef || !prep.dayProofRef || row.method !== prep.sourceMethod)
        throw problem('VERIFICATION_OPERATION_CONTRACT_INVALID', '每日水滴关闭后登录合同与原操作、索引或来源不一致');
    }
    if (flowerRackKind) {
      const readEvidence = (key, kind) => {
        const row = get(`SELECT kind,source,payload_json,payload_fingerprint,observed_at FROM backend_operation_evidence
          WHERE operation_id=? AND evidence_key=? AND kind=? AND source='backend/write-gateway/v2'`, operationId, key, kind);
        const payload = row ? parseStored(row.payload_json, '花架不可变后验合同') : null;
        if (!row || ledgerJsonFingerprint({ kind: row.kind, source: row.source, payload, observedAt: row.observed_at }) !== row.payload_fingerprint)
          throw problem('VERIFICATION_OPERATION_CONTRACT_INVALID', '花架缺少完整的不可变准入证据');
        return payload;
      };
      const admitted = readEvidence('admitted-operation-contract:v1', 'admitted-operation-contract');
      const prepared = readEvidence('finite-domain-preparation:v1', 'finite-domain-preparation');
      const { validateResponseCoverage: _coverage, ...postRead } = FLOWER_RACK_POST_READ;
      const definition = FLOWER_RACK_DEFINITIONS[flowerRackKind];
      const expected = { ...definition, postRead };
      const prep = prepared?.preparation, extension = prep?.extension, target = original.targets?.[0];
      const extensionBody = extension && Object.fromEntries(Object.entries(extension).filter(([key]) => key !== 'extensionRef'));
      const targetRef = prep ? `flower-rack:${context.subjectRef}:${prep.targetKey}` : null;
      const targetArtId = flowerRackKind === 'unlock' ? 0 : prep?.artId;
      const params = flowerRackKind === 'unlock' ? { standId: prep?.rackId } : flowerRackKind === 'sell'
        ? { rackId: prep?.rackId, iid: prep?.artId, num: prep?.quantity } : { rackId: prep?.rackId };
      const sourceRow = prep?.sourceRef ? get(`SELECT * FROM backend_flower_rack_receipts WHERE response_ref=? AND owner_ref=? AND account_ref=? AND subject_ref=?
        AND owner_epoch=? AND run_epoch=? AND connection_epoch=? AND request_sequence=?`, prep.sourceRef, context.ownerRef, context.accountRef, context.subjectRef,
        context.ownerEpoch, context.runEpoch, context.connectionEpoch, prep.sourceSequence) : null;
      let sourceValue = null; try { sourceValue = sourceRow ? parseStored(sourceRow.value_json, '花架原登录状态') : null; } catch { sourceValue = null; }
      const sourceValid = sourceRow && sourceValue && sourceRow.method === prep?.sourceMethod && sourceRow.value_fingerprint === fingerprint(sourceValue) &&
        sourceRow.value_fingerprint === prep?.sourceFingerprint && sourceValue.uid === prep?.officialUid && canonical(sourceValue.map) === canonical(prep?.sourceMap);
      const extensionValid = extension?.extensionId === FLOWER_RACK_EXTENSION_ID && extension.sourcePin === FLOWER_RACK_SOURCE_PIN &&
        extension.extensionRef === 'sha256:' + fingerprint(extensionBody) && extension.sourceProof?.sourcePin === FLOWER_RACK_SOURCE_PIN &&
        extension.sourceProof?.extensionId === FLOWER_RACK_EXTENSION_ID && extension.sourceProof?.matchedRanges?.length === 8 &&
        extension.loginResponseRef === prep?.loginResponseRef && extension.bundleRef === prep?.bundleRef && !!extension.baseDataSnapshotId;
      const paramsValid = fingerprint(params) === original.paramsFingerprint &&
        original.paramsFingerprint === operation.params_fingerprint;
      const resourceRefs = flowerRackKind === 'sell' ? [`item:${prep?.artId}`] : flowerRackKind === 'unlock' ? ['currency:gold'] : [];
      const resourceRows = Array.isArray(original.resources) ? original.resources : null;
      const resourceBindings = Array.isArray(original.resourceBindings) ? original.resourceBindings : null;
      const resourcesValid = resourceRows && resourceBindings && resourceRows.length === resourceRefs.length && resourceBindings.length === resourceRefs.length &&
        resourceRows.every((resource, index) => resource.resourceRef === resourceRefs[index] && resource.resourceKind === (flowerRackKind === 'unlock' ? 'currency' : 'item') &&
          resource.quantity === prep?.quantity && resource.resourceKey === resourceBindings[index]?.resourceKey &&
          resourceBindings[index]?.memberKey === target?.memberKey && resourceBindings[index]?.quantity === resource.quantity);
      const targetKeyValid = flowerRackKind === 'unlock'
        ? prep?.targetKey === `unlock:uid:${prep?.officialUid}:stand:${prep?.rackId}:locked`
        : flowerRackKind === 'sell' ? new RegExp(`^sell:uid:${prep?.officialUid}:rack:${prep?.rackId}:empty:g[0-9]+$`).test(prep?.targetKey || '')
          : new RegExp(`^${flowerRackKind}:uid:${prep?.officialUid}:rack:${prep?.rackId}:sale:${prep?.artId}:[0-9]+$`).test(prep?.targetKey || '');
      if (canonical(admitted) !== canonical(expected) || prepared?.domain !== operation.scope || !prep || prep.kind !== flowerRackKind ||
          !positive(prep.officialUid) || !positive(prep.rackId) || typeof prep.targetKey !== 'string' || !prep.targetKey || !sourceValid || !extensionValid || !paramsValid ||
          !resourcesValid || !targetKeyValid ||
          original.featureId !== 'flower-rack' || original.scope !== operation.scope || original.method !== operation.method ||
          target?.targetKind !== 'flower-rack' || target.targetRef !== targetRef || target.memberKey !== 'flower-rack:' + fingerprint([prep.targetKey, targetArtId]) ||
          target.lifecycleRef !== prep.bundleRef || target.targetFingerprint !== fingerprint({ targetRef, sourceRef: prep.sourceRef, extensionRef: prep.extensionRef }) ||
          prep.extensionRef !== extension.extensionRef || prep.loginResponseRef !== extension.loginResponseRef ||
          !Array.isArray(original.targets) || original.targets.length !== 1)
        throw problem('VERIFICATION_OPERATION_CONTRACT_INVALID', '花架后验合同与原准入、架位身份、来源或参数不一致');
    }
    if (dailyArtOperation) {
      const readEvidence = (key, kind) => {
        const row = get(`SELECT kind,source,payload_json,payload_fingerprint,observed_at FROM backend_operation_evidence
          WHERE operation_id=? AND evidence_key=? AND kind=? AND source='backend/write-gateway/v2'`, operationId, key, kind);
        const payload = row ? parseStored(row.payload_json, '日常花艺不可变后验合同') : null;
        if (!row || ledgerJsonFingerprint({ kind: row.kind, source: row.source, payload, observedAt: row.observed_at }) !== row.payload_fingerprint)
          throw problem('VERIFICATION_OPERATION_CONTRACT_INVALID', '日常花艺缺少完整的不可变准入证据');
        return payload;
      };
      const admitted = readEvidence('admitted-operation-contract:v1', 'admitted-operation-contract');
      const prepared = readEvidence('finite-domain-preparation:v1', 'finite-domain-preparation');
      const { validateResponseCoverage: _coverage, ...postRead } = DAILY_ART_POST_READ;
      const expected = { ...DAILY_ART_CONTRACT,
        postRead: { contractId: DAILY_ART_POST_READ.contractId, method: DAILY_ART_POST_READ.method, kind: DAILY_ART_POST_READ.kind,
          args: {}, evidenceRef: DAILY_ART_POST_READ.evidenceRef } };
      const prep = prepared?.preparation, target = original.targets?.[0];
      const targetRef = prep ? `art-daily:${context.subjectRef}:${prep.dayKey}:${prep.artId}` : null;
      if (canonical(admitted) !== canonical(expected) || prepared?.domain !== 'art-daily' || !plainObject(prep) ||
          !positive(prep.officialUid) || !positive(prep.artId) || !positive(prep.vaseId) || typeof prep.unitRef !== 'string' || !prep.unitRef || prep.unitRef.length > 512 ||
          !Number.isSafeInteger(prep.batchQuantity) || prep.batchQuantity < 1 || prep.batchQuantity > 999 ||
          !Number.isSafeInteger(prep.targetStock) || prep.targetStock < 1 || prep.targetStock > 999 ||
          !Number.isSafeInteger(prep.quality) || prep.quality < 1 || prep.quality > 5 || prep.outputItemRow?.id !== prep.artId ||
          prep.outputItemRow?.type !== 12 || prep.outputItemRow?.color !== prep.quality ||
          typeof prep.recipeFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(prep.recipeFingerprint) || typeof prep.dayKey !== 'string' || !prep.dayKey || prep.dayKey.length > 512 ||
          !Number.isSafeInteger(prep.unitOrdinal) || prep.unitOrdinal < 1 ||
          target?.targetKind !== DAILY_ART_CONTRACT.targetKind || target.targetRef !== targetRef ||
          target.memberKey !== 'art-daily:' + fingerprint([prep.dayKey, prep.artId, prep.unitOrdinal]) ||
          target.lifecycleRef !== prep.unitRef || target.targetFingerprint !== fingerprint({ targetRef, recipeFingerprint: prep.recipeFingerprint,
            unitRef: prep.unitRef, dayKey: prep.dayKey, batchQuantity: prep.batchQuantity }) || original.featureId !== operation.feature_id || original.scope !== operation.scope ||
          original.method !== operation.method || !Array.isArray(original.targets) || original.targets.length !== 1 ||
          !plainObject(prep.versionEvidence) || prep.versionEvidence.loginResponseRef !== prep.loginResponseRef)
        throw problem('VERIFICATION_OPERATION_CONTRACT_INVALID', '日常花艺关闭后登录合同与原操作、单件目标或来源不一致');
    }
    if (firstAlbumOperation || firstShareOperation || customerArtBatchOperation) {
      const readEvidence = (key, kind) => {
        const row = get(`SELECT kind,source,payload_json,payload_fingerprint,observed_at FROM backend_operation_evidence
          WHERE operation_id=? AND evidence_key=? AND kind=? AND source='backend/write-gateway/v2'`, operationId, key, kind);
        const payload = row ? parseStored(row.payload_json, '花艺独立功能后验合同') : null;
        if (!row || ledgerJsonFingerprint({ kind: row.kind, source: row.source, payload, observedAt: row.observed_at }) !== row.payload_fingerprint)
          throw problem('VERIFICATION_OPERATION_CONTRACT_INVALID', '花艺独立功能缺少完整不可变合同证据');
        return payload;
      };
      const admitted = readEvidence('admitted-operation-contract:v1', 'admitted-operation-contract');
      const envelope = readEvidence('finite-domain-preparation:v1', 'finite-domain-preparation');
      const prep = envelope?.preparation;
      const target = original.targets?.[0];
      if (firstAlbumOperation || firstShareOperation) {
        const album = firstAlbumOperation;
        const contract = album ? ART_FIRST_ALBUM_CONTRACT : ART_FIRST_SHARE_CONTRACT;
        const postRead = album ? ART_FIRST_ALBUM_POST_READ : ART_FIRST_SHARE_POST_READ;
        const assertProposal = album ? assertArtFirstAlbumProposal : assertArtFirstShareProposal;
        const domain = album ? 'art-first-album' : 'art-first-share';
        const { validateResponseCoverage: _coverage, ...postReadEvidence } = postRead;
        const expectedAdmitted = { featureId: contract.featureId, scope: contract.scope, method: contract.method,
          targetKind: contract.targetKind, contractId: contract.contractRef, contractRef: contract.contractRef, domain,
          postRead: { contractId: postReadEvidence.contractId, method: postReadEvidence.method, kind: postReadEvidence.kind,
            args: {}, evidenceRef: postReadEvidence.evidenceRef } };
        const params = album ? { flowerArtId: prep?.vaseId } : { shareId: 6, ext: { opType: 2, id: prep?.artId } };
        const proposal = { ...original, contractRef: contract.contractRef, params, paramsFingerprint: fingerprint(params), artFirstReward: prep };
        try { assertProposal(proposal); } catch { throw problem('VERIFICATION_OPERATION_CONTRACT_INVALID', '花艺首做后验合同与冻结提案不一致'); }
        if (canonical(admitted) !== canonical(expectedAdmitted) || envelope?.domain !== domain || !plainObject(prep) ||
            original.featureId !== contract.featureId || original.scope !== contract.scope || original.method !== contract.method ||
            proposal.paramsFingerprint !== operation.params_fingerprint || original.paramsFingerprint !== operation.params_fingerprint ||
            !Array.isArray(original.targets) || original.targets.length !== 1 ||
            target?.targetKind !== contract.targetKind || target.targetRef !== prep.targetRef || target.memberKey !== prep.memberKey ||
            target.lifecycleRef !== prep.lifecycleRef || target.targetFingerprint !== fingerprint({ targetRef: prep.targetRef, artId: prep.artId,
              vaseId: prep.vaseId, claimSet: prep.claimSetFingerprint || null, claimArtIds: prep.claimArtIds || null }))
          throw problem('VERIFICATION_OPERATION_CONTRACT_INVALID', '花艺首做关闭后登录合同未绑定原参数、目标、来源或准入');
      } else {
        const { validateResponseCoverage: _coverage, ...postReadEvidence } = CUSTOMER_ART_BATCH_POST_READ;
        const expectedAdmitted = { ...CUSTOMER_ART_BATCH_CONTRACT,
          postRead: { contractId: postReadEvidence.contractId, method: postReadEvidence.method, kind: postReadEvidence.kind,
            args: {}, evidenceRef: postReadEvidence.evidenceRef } };
        const params = { vaseId: prep?.vaseId, flowersIds: prep?.flowersIds, num: prep?.batchQuantity };
        const proposal = { ...original, contractRef: CUSTOMER_ART_BATCH_CONTRACT.contractRef, params,
          paramsFingerprint: fingerprint(params), customerArtBatch: prep };
        try { assertCustomerArtBatchProposal(proposal); } catch { throw problem('VERIFICATION_OPERATION_CONTRACT_INVALID', '顾客花艺批量后验合同与冻结提案不一致'); }
        if (canonical(admitted) !== canonical(expectedAdmitted) || envelope?.domain !== 'art-customer-batch' ||
            original.featureId !== CUSTOMER_ART_BATCH_CONTRACT.featureId ||
            original.scope !== CUSTOMER_ART_BATCH_CONTRACT.scope || original.method !== CUSTOMER_ART_BATCH_CONTRACT.method ||
            proposal.paramsFingerprint !== operation.params_fingerprint || original.paramsFingerprint !== operation.params_fingerprint ||
            !Array.isArray(original.targets) || original.targets.length !== 1 ||
            target?.targetFingerprint !== fingerprint({ targetRef: prep?.targetRef, lifecycleRef: prep?.parentLifecycleRef,
              parentDecisionRef: prep?.parentDecisionRef, recipeFingerprint: prep?.recipeFingerprint, batchQuantity: prep?.batchQuantity }))
          throw problem('VERIFICATION_OPERATION_CONTRACT_INVALID', '顾客花艺批量关闭后登录合同未绑定原参数、目标或准入');
      }
    }
    const permit = get('SELECT * FROM backend_send_permits WHERE operation_id=?', operationId);
    if (!permit || permit.consumed !== 1 || permit.owner_ref !== context.ownerRef || permit.subject_ref !== context.subjectRef ||
      permit.owner_epoch !== context.ownerEpoch || permit.run_epoch !== context.runEpoch || permit.connection_epoch !== context.connectionEpoch ||
      permit.method !== operation.method || permit.params_fingerprint !== operation.params_fingerprint ||
      permit.request_sequence !== after.requestSequence || permit.wire_key !== after.wireKey) throw problem('VERIFICATION_WRITE_BINDING_INVALID', '原写入凭证与匹配回包不一致');
    const answers = all("SELECT * FROM backend_operation_evidence WHERE operation_id=? AND kind='official-answer' AND source='backend/write-gateway/v2' ORDER BY evidence_id LIMIT 17", operationId);
    if (answers.length > 16) throw problem('VERIFICATION_ANSWER_EVIDENCE_LIMIT', '原匹配回包证据超出有限核验范围');
    const answer = answers.find(row => {
      const payload = parseStored(row.payload_json, 'verification matched answer');
      return ledgerJsonFingerprint({ kind: row.kind, source: row.source, payload, observedAt: row.observed_at }) === row.payload_fingerprint &&
        payload.method === operation.method && payload.connectionEpoch === after.connectionEpoch && payload.requestSequence === after.requestSequence &&
        payload.wireKey === after.wireKey && payload.responseRef === after.responseRef;
    });
    if (!answer) throw problem('VERIFICATION_MATCHED_ANSWER_MISSING', '独立核验缺少原写真实匹配回包');
    if (requireSlot) {
      const slots = all('SELECT operation_id FROM backend_operations WHERE subject_ref=? AND write_slot=1 LIMIT 2', context.subjectRef);
      if (operation.write_slot !== 1 || operation.transport_state !== 'answered' || operation.business_verdict !== 'unverified' ||
        slots.length !== 1 || slots[0].operation_id !== operationId) throw problem('VERIFICATION_WRITE_SLOT_MISMATCH', '独立核验必须持有本操作唯一当前写位');
    }
    return { operation, answerEvidenceId: Number(answer.evidence_id), answerEvidenceFingerprint: answer.payload_fingerprint };
  }
  function loginSource(observation, serverId) {
    const profile = publicLoginProfile(observation), version = observation?.versionEvidence;
    if (!profile || observation.rejected === true || observation.messagePresent === true && observation.noticeOnly !== true || !positive(serverId) ||
      version?.source !== 'normal-package-hop-and-matched-world-login/v1' || version.loginResponseRef !== observation.responseRef ||
      typeof version.gameVersion !== 'string' || typeof version.protocolVersion !== 'string' ||
      !/^\d+(?:\.\d+){1,5}$/.test(version.gameVersion) || !/^\d+(?:\.\d+){1,5}$/.test(version.protocolVersion) ||
      !exactAfter(observation)) throw problem('VERIFICATION_LOGIN_SOURCE_INVALID', '正常官服登录没有形成可核验主体和版本');
    const versionEvidence = { source: version.source, gameVersion: version.gameVersion, protocolVersion: version.protocolVersion,
      loginResponseRef: version.loginResponseRef, ...(version.serverVersionBinding ? { reportedServerVersion: version.reportedServerVersion,
        serverVersionBinding: version.serverVersionBinding } : {}) };
    const serverVersionBinding = version.serverVersionBinding;
    if (serverVersionBinding && verifyOfficialServerVersionFrame({ versionEvidence: version,
      frameProtocolVersion: observation.protocolVersion,
      frameReportedServerVersion: observation.reportedServerVersion ?? observation.protocolVersion,
      context: serverVersionBinding.context, officialUid: profile.uid })) {
      // The exact four-field legacy projection remains unchanged; only a
      // fully verified semantic adapter adds its independently bound fields.
    } else {
      delete versionEvidence.reportedServerVersion;
      delete versionEvidence.serverVersionBinding;
    }
    return { kind: 'response', transport: 'answered', method: 'index.login', connectionEpoch: observation.connectionEpoch,
      requestSequence: observation.requestSequence, wireKey: observation.wireKey, responseRef: observation.responseRef,
      serverId, officialUid: profile.uid, receivedDeviceMs: Number.isSafeInteger(observation.receivedDeviceMs) ? observation.receivedDeviceMs : null,
      versionEvidence };
  }
  function validateReadSnapshotLease(input = {}) {
    try {
      const row = input.leaseRef ? get('SELECT * FROM backend_session_verification_leases WHERE lease_ref=?', input.leaseRef) :
        get('SELECT * FROM backend_session_verification_leases WHERE operation_id=?', input.operationId || '');
      if (!row || row.operation_id !== input.operationId || !row.bridge_json || !row.bridge_fingerprint) return { valid: false, current: false, reasonCode: 'VERIFICATION_BRIDGE_NOT_READY' };
      const receipt = parseStored(row.bridge_json, 'verification bridge'), original = exactContext(receipt.originalContext), next = exactContext(receipt.newContext), after = exactAfter(receipt.after);
      if (!original || !next || !after || receipt.leaseRef !== row.lease_ref || receipt.operationId !== row.operation_id ||
        fingerprint(receipt) !== row.bridge_fingerprint || input.bridgeFingerprint != null && input.bridgeFingerprint !== row.bridge_fingerprint ||
        input.originalContext && !sameContext(original, exactContext(input.originalContext)) || input.newContext && !sameContext(next, exactContext(input.newContext)) ||
        input.after && fingerprint(after) !== fingerprint(exactAfter(input.after)) ||
        !['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch'].every(key => original[key] === next[key]) || next.connectionEpoch <= original.connectionEpoch ||
        row.new_connection_epoch !== next.connectionEpoch || fingerprint(original) !== fingerprint(parseStored(row.original_context_json, 'verification original context')) ||
        fingerprint(after) !== fingerprint(parseStored(row.after_json, 'verification original answer'))) return { valid: false, current: false, reasonCode: 'VERIFICATION_BRIDGE_BINDING_INVALID' };
      const checked = answeredOperation(original, row.operation_id, after, row.executor_ref);
      if (receipt.answerEvidenceId !== checked.answerEvidenceId || receipt.answerEvidenceFingerprint !== checked.answerEvidenceFingerprint) return { valid: false, current: false, reasonCode: 'VERIFICATION_BRIDGE_ANSWER_CHANGED' };
      const proof = receipt.oldPhysicalCloseReceipt, closure = get('SELECT * FROM backend_session_connection_closures WHERE evidence_ref=?', proof?.closureEvidenceRef || '');
      const closed = closure ? parseStored(closure.proof_json, 'verification physical close') : null;
      if (proof?.closed !== true || proof.connectionEpoch !== original.connectionEpoch || !closure ||
        closure.owner_ref !== original.ownerRef || closure.account_ref !== original.accountRef || closure.subject_ref !== original.subjectRef ||
        closure.executor_ref !== row.executor_ref || closure.owner_epoch !== original.ownerEpoch || closure.run_epoch !== original.runEpoch ||
        closure.connection_epoch !== original.connectionEpoch || closed?.closed !== true || closed.leaseRef !== row.lease_ref || closed.operationId !== row.operation_id ||
        closed.source !== 'verification-snapshot-actual-close' || fingerprint(closed.after) !== fingerprint(after)) return { valid: false, current: false, reasonCode: 'VERIFICATION_PHYSICAL_CLOSE_UNPROVEN' };
      const login = receipt.newLoginSource, old = receipt.oldLoginSource;
      if (login?.kind !== 'response' || login.transport !== 'answered' || login.method !== 'index.login' || login.connectionEpoch !== next.connectionEpoch ||
        !exactAfter(login) || !positive(receipt.officialUid) || login.officialUid !== receipt.officialUid || old?.officialUid !== receipt.officialUid ||
        old.kind !== 'response' || old.transport !== 'answered' || old.method !== 'index.login' || old.connectionEpoch !== original.connectionEpoch ||
        !exactAfter(old) || !positive(login.serverId) || login.serverId !== old.serverId ||
        login.versionEvidence?.source !== 'normal-package-hop-and-matched-world-login/v1' || old.versionEvidence?.source !== login.versionEvidence.source ||
        old.versionEvidence?.loginResponseRef !== old.responseRef || login.versionEvidence?.loginResponseRef !== login.responseRef) return { valid: false, current: false, reasonCode: 'VERIFICATION_NEW_LOGIN_BINDING_INVALID' };
      const actor = actors.get(keyOf(next.ownerRef, next.accountRef));
      const live = row.active === 1 && actor?.verificationLease?.leaseRef === row.lease_ref && sameContext(actorContext(actor), next) &&
        connectionCurrent(actor) && actor.connection?.context?.loginObservation?.responseRef === login.responseRef;
      return freeze({ valid: true, current: Boolean(live), reasonCode: live ? null : 'VERIFICATION_LEASE_NOT_CURRENT',
        leaseRef: row.lease_ref, operationId: row.operation_id, bridgeFingerprint: row.bridge_fingerprint,
        receipt: { ...receipt, bridgeFingerprint: row.bridge_fingerprint } });
    } catch (error) { return { valid: false, current: false, reasonCode: codeOf(error) }; }
  }
  function handleTransportClosed(actor, captured, reason) {
    if (actors.get(keyOf(actor.ownerRef, actor.accountRef)) !== actor || actor.connectionEpoch !== captured.connectionEpoch ||
      reason?.connectionEpoch !== undefined && reason.connectionEpoch !== captured.connectionEpoch) return;
    captureConnectionStability(actor);
    const lease = actor.verificationLease;
    if (actor.snapshotRefresh?.oldClosing && sameContext(captured, actor.snapshotRefresh.originalContext)) {
      // This no-write replacement is owned by refreshCurrent. Its awaited
      // closeTransport receipt, not this notification, proves physical close.
      actor.transportClosed = true; actor.transportCloseReason = { code: codeOf(reason), intentional: true };
      return;
    }
    if (lease?.oldClosing && sameContext(captured, lease.originalContext)) {
      // Logical close arrives before the physical close Promise resolves.
      // The original answered flight owns this deliberate replacement.
      actor.transportClosed = true; actor.transportCloseReason = { code: codeOf(reason), intentional: true };
      return;
    }
    captureWriteDrain(actor, typeof reason?.code === 'string' ? reason.code : 'PROTOCOL_CONNECTION_CLOSED');
    actor.transportClosed = true;
    actor.transportCloseReason = { code: codeOf(reason), intentional: reason?.intentional === true };
    if (lease) {
      const error = Object.assign(problem(codeOf(reason), '独立核验的新连接已结束'), { transportFailure: reason?.intentional !== true });
      lease.failureError = error; actor.controller.abort(error);
      try { notifyStopped(actor); } catch { /* Original drain and lease remain retained. */ }
      return;
    }
    if (current(actor)) {
      transition(actor, 'WAITING_NETWORK', String(reason?.code || 'TRANSPORT_CLOSED')); notifyStopped(actor);
      if (actor.startComplete && reason?.intentional !== true) {
        const reasonCode = typeof reason?.code === 'string' ? reason.code : 'PROTOCOL_CONNECTION_CLOSED';
        const error = Object.assign(problem(reasonCode, '官服连接已撤销，等待有限恢复'),
          { transportFailure: RECOVERABLE_CLOSE.has(reasonCode) || /^SOCKET_\d{1,5}$/.test(reasonCode) });
        void Promise.resolve().then(() => requestAutomaticRecovery(actor, error)).catch(() => {});
      }
    }
  }
  function readSnapshotAfterClose({ context: supplied, operationId, after: suppliedAfter, signal, onProgress = null } = {}) {
    const originalContext = exactContext(supplied), after = exactAfter(suppliedAfter);
    if (!originalContext || !after || typeof operationId !== 'string' || !operationId || operationId.length > 512) return Promise.reject(problem('VERIFICATION_READ_ARGUMENT_INVALID', '独立核验缺少原操作和匹配回包'));
    const actor = actors.get(keyOf(originalContext.ownerRef, originalContext.accountRef));
    if (actor?.verificationPromise) return actor.verificationLease?.operationId === operationId && sameContext(actor.verificationLease.originalContext, originalContext) &&
      fingerprint(actor.verificationLease.after) === fingerprint(after) ? actor.verificationPromise : Promise.reject(problem('SESSION_VERIFICATION_READ_BUSY', '本主体正在核验另一笔原操作'));
    let lease, oldConnection, oldLoginSource;
    try {
      signal?.throwIfAborted();
      if (!actor || !sameContext(actorContext(actor), originalContext) || !connectionCurrent(actor) || !actor.startComplete || !actor.connection?.isOpen()) throw problem('VERIFICATION_ORIGINAL_CONTEXT_REVOKED', '独立核验原会话已撤销');
      oldConnection = actor.connection; oldLoginSource = loginSource(oldConnection.context?.loginObservation, oldConnection.context?.serverId);
      if (oldLoginSource.connectionEpoch !== originalContext.connectionEpoch) throw problem('VERIFICATION_ORIGINAL_LOGIN_MISMATCH', '原会话登录证据不一致');
      lease = transaction(() => {
        if (!current(actor) || !sameContext(actorContext(actor), originalContext)) throw problem('VERIFICATION_ORIGINAL_CONTEXT_REVOKED', '核验租约提交前原会话已撤销');
        const checked = answeredOperation(originalContext, operationId, after, executorRef, true);
        if (get('SELECT 1 FROM backend_session_verification_leases WHERE operation_id=? OR subject_ref=? AND active=1', operationId, originalContext.subjectRef)) throw problem('SESSION_VERIFICATION_READ_BUSY', '原操作已有核验租约，不能重复换连接');
        const leaseRef = 'verification-lease:' + newId();
        run(`INSERT INTO backend_session_verification_leases(lease_ref,operation_id,executor_ref,owner_ref,account_ref,subject_ref,owner_epoch,run_epoch,
          original_connection_epoch,new_connection_epoch,state,active,original_context_json,after_json,bridge_json,bridge_fingerprint,reason_code,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,NULL,'closing',1,?,?,NULL,NULL,NULL,?,?)`, leaseRef, operationId, executorRef,
        originalContext.ownerRef, originalContext.accountRef, originalContext.subjectRef, originalContext.ownerEpoch, originalContext.runEpoch,
        originalContext.connectionEpoch, canonical(originalContext), canonical(after), nowIso(), nowIso());
        leaseEvent(leaseRef, 'created', { operationId, originalContext, after, oldLoginSource,
          answerEvidenceId: checked.answerEvidenceId, answerEvidenceFingerprint: checked.answerEvidenceFingerprint });
        return { leaseRef, operationId, originalContext, after, oldClosing: true, answerEvidenceId: checked.answerEvidenceId, answerEvidenceFingerprint: checked.answerEvidenceFingerprint };
      });
    } catch (error) { return Promise.reject(error); }
    actor.verificationLease = lease; actor.startComplete = false;
    cancelRecoveryTimer(actor.ownerRef, actor.accountRef);
    const abort = () => actor.controller.abort(signal.reason || problem('VERIFICATION_READ_CANCELLED', '独立核验已取消'));
    signal?.addEventListener('abort', abort, { once: true });
    const live = () => {
      signal?.throwIfAborted(); actor.controller.signal.throwIfAborted();
      if (!current(actor) || actor.verificationLease !== lease || !get('SELECT 1 FROM backend_session_verification_leases WHERE lease_ref=? AND active=1', lease.leaseRef)) throw problem('VERIFICATION_LEASE_REVOKED', '独立核验期间运行意愿或归属已撤销');
    };
    const bounded = async promise => {
      let timer;
      try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(problem('VERIFICATION_PHYSICAL_CLOSE_TIMEOUT', '旧连接物理关闭尚未确认')), cleanupTimeoutMs); })]); }
      finally { clearTimeout(timer); }
    };
    const flight = (async () => {
      try {
        live(); await authorize({ ...originalContext, purpose: 'verification-read-session', signal: actor.controller.signal }); live();
        transition(actor, 'RECOVERING', 'AFTER_WRITE_PHYSICAL_CLOSE_SNAPSHOT');
        const actualClose = Promise.resolve(oldConnection.close('VERIFICATION_SNAPSHOT_REPLACE', true)).then(receipt => {
          if (receipt?.closed !== true || receipt.connectionEpoch !== originalContext.connectionEpoch || oldConnection.isOpen() !== false) throw problem('VERIFICATION_PHYSICAL_CLOSE_UNPROVEN', '旧连接没有返回实际关闭证明');
          const code = typeof receipt.code === 'string' ? receipt.code.slice(0, 80) : null;
          const closureEvidenceRef = closureEvidence({ ...originalContext }, 'verification-snapshot-physical-close', {
            closed: true, connectionEpoch: originalContext.connectionEpoch, leaseRef: lease.leaseRef, operationId, after,
            code, source: 'verification-snapshot-actual-close' });
          return { closed: true, connectionEpoch: originalContext.connectionEpoch, closureEvidenceRef, code };
        });
        actualClose.catch(() => {});
        const oldPhysicalCloseReceipt = await bounded(actualClose); live();
        lease.oldClosing = false; actor.closeEvidenceRef = oldPhysicalCloseReceipt.closureEvidenceRef;
        onProgress?.('old-transport-closed');
        // Only retire the old reader/scheduler. Never revoke or await this
        // operation's gateway drain from inside its own verifier.
        onStop(originalContext); actor.stopNotified = true;
        await authorize({ ...originalContext, purpose: 'verification-read-session', signal: actor.controller.signal }); live();
        if (network.online === false) throw Object.assign(problem('NATIVE_NETWORK_OFFLINE', '独立核验期间原生网络为离线'), { transportFailure: true });
        const nextEpoch = transaction(() => {
          live(); answeredOperation(originalContext, operationId, after, executorRef, true);
          const prior = get('SELECT connection_epoch FROM backend_subject_connection_epochs WHERE subject_ref=?', actor.subjectRef);
          const epoch = Math.max(Number(prior?.connection_epoch || 0), actor.connectionEpoch) + 1;
          if (!positive(epoch)) throw problem('SESSION_CONNECTION_EPOCH_EXHAUSTED', '官服连接代际超出范围');
          run('INSERT INTO backend_subject_connection_epochs VALUES(?,?) ON CONFLICT(subject_ref) DO UPDATE SET connection_epoch=excluded.connection_epoch', actor.subjectRef, epoch);
          const changed = run("UPDATE backend_run_intents SET connection_epoch=?,state='CONNECTING',reason_code='AFTER_WRITE_FRESH_LOGIN',updated_at=? WHERE owner_ref=? AND account_ref=? AND desired_running=1 AND run_epoch=? AND connection_epoch=?",
            epoch, nowIso(), actor.ownerRef, actor.accountRef, actor.runEpoch, actor.connectionEpoch).changes;
          if (changed !== 1) throw problem('VERIFICATION_LEASE_REVOKED', '新连接建立前运行意愿已撤销');
          run("UPDATE backend_session_verification_leases SET new_connection_epoch=?,state='connecting',updated_at=? WHERE lease_ref=? AND active=1", epoch, nowIso(), lease.leaseRef);
          leaseEvent(lease.leaseRef, 'old-closed-new-epoch', { oldPhysicalCloseReceipt, newContext: { ...originalContext, connectionEpoch: epoch } });
          return epoch;
        });
        actor.connectionEpoch = nextEpoch; actor.connection = null; actor.transportClosed = false; actor.transportCloseReason = null;
        actor.state = 'CONNECTING'; actor.stopNotified = false; actor.connectAttempted = true; actor.connectRejectedClosed = false;
        const newContext = actorContext(actor);
        actor.connection = await connect({ ...actor, verificationLease: { leaseRef: lease.leaseRef, operationId }, allowEndpointPreference: false, signal: actor.controller.signal,
          isCurrent: () => current(actor) && sameContext(actorContext(actor), newContext) && !actor.transportClosed,
          onClosed: reason => handleTransportClosed(actor, newContext, reason) });
        onProgress?.('new-connection-established');
        live(); assertConnection(actor);
        await authorize({ ...newContext, purpose: 'verification-read-session', signal: actor.controller.signal });
        live(); assertConnection(actor);
        let newLoginObservation = actor.connection.context?.loginObservation;
        if (typeof prepareVerificationLogin === 'function') {
          const projected = await prepareVerificationLogin({ context: newContext, connection: actor.connection,
            observation: newLoginObservation, signal: actor.controller.signal, isCurrent: () => current(actor) && sameContext(actorContext(actor), newContext) });
          live(); assertConnection(actor);
          if (projected) newLoginObservation = projected;
        }
        onProgress?.('new-login-observed');
        const newLoginSource = loginSource(newLoginObservation, actor.connection.context?.serverId);
        if (newLoginSource.connectionEpoch !== newContext.connectionEpoch || newLoginSource.officialUid !== oldLoginSource.officialUid ||
          newLoginSource.serverId !== oldLoginSource.serverId) throw problem('VERIFICATION_FRESH_LOGIN_IDENTITY_CONFLICT', '独立核验新登录主体或区服不一致');
        recordTransportIdentity(actor);
        transition(actor, 'SYNCHRONIZING', 'VERIFICATION_OUTCOME_PENDING');
        const receipt = { version: 'after-physical-close-login/v1', leaseRef: lease.leaseRef, operationId, originalContext, newContext, after,
          oldPhysicalCloseReceipt, oldLoginSource, newLoginSource, officialUid: oldLoginSource.officialUid,
          answerEvidenceId: lease.answerEvidenceId, answerEvidenceFingerprint: lease.answerEvidenceFingerprint };
        const bridgeFingerprint = fingerprint(receipt);
        transaction(() => {
          live();
          run("UPDATE backend_session_verification_leases SET state='ready',bridge_json=?,bridge_fingerprint=?,updated_at=? WHERE lease_ref=? AND active=1",
            canonical(receipt), bridgeFingerprint, nowIso(), lease.leaseRef);
          leaseEvent(lease.leaseRef, 'fresh-login-observed', { bridgeFingerprint, ...receipt });
        });
        onProgress?.('bridge-complete');
        return freeze({ ...receipt, bridgeFingerprint, newLoginObservation });
      } catch (error) {
        lease.failureError = error; lease.oldClosing = false;
        actor.controller.abort(error);
        let failure = error;
        try { transaction(() => {
          run("UPDATE backend_session_verification_leases SET state='failed',reason_code=?,updated_at=? WHERE lease_ref=? AND active=1", codeOf(error), nowIso(), lease.leaseRef);
          leaseEvent(lease.leaseRef, 'failed', { operationId, reasonCode: codeOf(error), originalContext, currentContext: actorContext(actor) });
        }); } catch (persistenceError) { failure = persistenceError; }
        if (actors.get(keyOf(actor.ownerRef, actor.accountRef)) === actor) {
          try { notifyStopped(actor); } catch { /* Preserve original unknown and resource footprints. */ }
          if (!actor.connection) rejectedConnectionClosed(actor, error);
          try { await bounded(closeTransport(actor)); } catch { /* Unproved close cannot become a success receipt. */ }
          if (sameRecoveryIntent(actor)) run("UPDATE backend_run_intents SET state='BLOCKED',reason_code=?,updated_at=? WHERE owner_ref=? AND account_ref=? AND desired_running=1 AND run_epoch=? AND connection_epoch=?",
            codeOf(error), nowIso(), actor.ownerRef, actor.accountRef, actor.runEpoch, actor.connectionEpoch);
        }
        throw Object.assign(failure, { leaseRef: lease.leaseRef, operationId });
      } finally { signal?.removeEventListener('abort', abort); }
    })().finally(() => { if (actor.verificationPromise === flight) actor.verificationPromise = null; });
    actor.verificationPromise = flight;
    return flight;
  }
  async function releaseReadSnapshotLease({ leaseRef = null, operationId, durableOutcome } = {}) {
    const row = leaseRef ? get('SELECT * FROM backend_session_verification_leases WHERE lease_ref=?', leaseRef) :
      get('SELECT * FROM backend_session_verification_leases WHERE operation_id=?', operationId || '');
    if (!row) {
      const operation = typeof operationId === 'string' ? get('SELECT write_slot,business_verdict FROM backend_operations WHERE operation_id=?', operationId) : null;
      return durableOutcome === true && leaseRef === null && operation?.write_slot === 0 && operation.business_verdict !== 'unverified'
        ? { released: true, resumed: false, reasonCode: 'NO_LEASE_ACQUIRED' }
        : { released: false, resumed: false, reasonCode: 'VERIFICATION_LEASE_NOT_FOUND' };
    }
    if (row.operation_id !== operationId) return { released: false, resumed: false, reasonCode: 'VERIFICATION_LEASE_OPERATION_MISMATCH' };
    if (row.active !== 1) return { released: true, resumed: false, alreadyReleased: true, leaseRef: row.lease_ref };
    if (durableOutcome !== true) return { released: false, resumed: false, leaseRef: row.lease_ref, reasonCode: 'VERIFICATION_OUTCOME_NOT_DURABLE' };
    const originalContext = parseStored(row.original_context_json, 'verification original context'), after = parseStored(row.after_json, 'verification original answer');
    const checked = answeredOperation(originalContext, operationId, after, row.executor_ref);
    if (checked.operation.write_slot !== 0 || checked.operation.business_verdict === 'unverified') return { released: false, resumed: false, leaseRef: row.lease_ref, reasonCode: 'VERIFICATION_ORIGINAL_SLOT_NOT_SETTLED' };
    transaction(() => {
      run("UPDATE backend_session_verification_leases SET active=0,state='released',updated_at=? WHERE lease_ref=? AND active=1", nowIso(), row.lease_ref);
      leaseEvent(row.lease_ref, 'durable-outcome-released', { operationId, businessVerdict: checked.operation.business_verdict, originalUnknownAndResourcesUnchanged: true });
    });
    const actor = actors.get(keyOf(row.owner_ref, row.account_ref)), lease = actor?.verificationLease;
    if (!actor || lease?.leaseRef !== row.lease_ref) return { released: true, resumed: false, leaseRef: row.lease_ref, reasonCode: 'VERIFICATION_ACTOR_NOT_CURRENT' };
    actor.verificationLease = null;
    const resumeContext = actorContext(actor), failure = lease.failureError;
    // A macrotask lets the gateway remove its JS flight and resolve the drain
    // before a resumed scheduler may propose another operation.
    actor.verificationResumeHandle = setImmediate(() => {
      actor.verificationResumeHandle = null;
      if (actors.get(keyOf(actor.ownerRef, actor.accountRef)) !== actor || !sameContext(actorContext(actor), resumeContext) || !sameRecoveryIntent(actor)) return;
      if (!current(actor) || !actor.connection?.isOpen() || actor.transportClosed || failure) {
        if (failure && sameRecoveryIntent(actor)) void requestAutomaticRecovery(actor, failure).catch(() => {});
        return;
      }
      void (async () => {
        try {
          await authorize({ ...resumeContext, purpose: 'verification-resume', signal: actor.controller.signal });
          assertConnection(actor);
          await onConnected({ ...actor, isCurrent: () => connectionCurrent(actor), signal: actor.controller.signal,
            verificationResume: { leaseRef: row.lease_ref, operationId } });
          assertConnection(actor); transition(actor, 'WAITING'); actor.startComplete = true;
          transaction(() => {
            if (!current(actor)) throw problem('RUN_INTENT_REVOKED', '核验完成后运行意愿已撤销');
            const saved = recovery(actor.ownerRef, actor.accountRef);
            saveRecovery({ ...actor, status: 'connected', attempt: Number(saved?.attempt || 0), retryAtMs: null,
              reasonCode: 'VERIFICATION_SNAPSHOT_RESUMED', error: {}, closeEvidenceRef: actor.closeEvidenceRef });
          });
        } catch (error) { captureWriteDrain(actor, codeOf(error)); actor.controller.abort(error); void requestAutomaticRecovery(actor, error).catch(() => {}); }
      })();
    });
    return { released: true, resumed: false, resumeScheduled: true, leaseRef: row.lease_ref };
  }
  function retireRecoveredVerificationLeases({ context: supplied } = {}) {
    const checkpoint = exactContext(supplied);
    const actor = checkpoint && actors.get(keyOf(checkpoint.ownerRef, checkpoint.accountRef));
    if (!checkpoint || !actor || !sameContext(actorContext(actor), checkpoint) || !connectionCurrent(actor) || actor.verificationLease || actor.verificationPromise) {
      throw problem('VERIFICATION_RECOVERY_CONTEXT_INVALID', '旧核验租约只能由正常新登录的当前上下文收口');
    }
    const currentLogin = loginSource(actor.connection?.context?.loginObservation, actor.connection?.context?.serverId);
    if (currentLogin.connectionEpoch !== checkpoint.connectionEpoch) throw problem('VERIFICATION_RECOVERY_LOGIN_INVALID', '旧核验租约缺少本次正常登录');
    const selected = all('SELECT * FROM backend_session_verification_leases WHERE subject_ref=? AND active=1 LIMIT 2', checkpoint.subjectRef);
    const hasTable = name => Boolean(get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name));
    function previousExecutionProof(row, original) {
      const epoch = row.new_connection_epoch ?? row.original_connection_epoch;
      for (const closed of all(`SELECT evidence_ref,executor_ref,owner_epoch,run_epoch,connection_epoch,proof_json
        FROM backend_session_connection_closures WHERE owner_ref=? AND account_ref=? AND subject_ref=?
          AND executor_ref=? AND owner_epoch=? AND run_epoch=? AND connection_epoch=? ORDER BY evidence_ref LIMIT 8`,
      original.ownerRef, original.accountRef, original.subjectRef, row.executor_ref, original.ownerEpoch, original.runEpoch, epoch)) {
        const proof = parseStored(closed.proof_json, 'retired verification physical closure');
        if (proof.closed === true && proof.connectionEpoch === epoch && ['transport-close-receipt', 'verification-snapshot-actual-close'].includes(proof.source)) {
          return { kind: 'stored-physical-close', evidenceRef: closed.evidence_ref, executionConnectionEpoch: epoch };
        }
      }
      const own = get('SELECT app_id FROM backend_local_executors WHERE executor_ref=?', executorRef);
      if (!own) return null;
      const native = resolveNativeExecutorExitProof({ store, appId: own.app_id, subjectRef: original.subjectRef,
        executorRef: row.executor_ref, ownerEpoch: original.ownerEpoch });
      return native ? { kind: 'stored-native-executor-exit', evidenceRef: native.evidenceRef, executionConnectionEpoch: epoch } : null;
    }
    return transaction(() => {
      const released = [], held = [];
      if (selected.length > 1) throw problem('VERIFICATION_RECOVERY_LEASE_CONFLICT', '旧核验租约主体唯一约束不一致');
      for (const row of selected) {
        const hold = reasonCode => held.push({ leaseRef: row.lease_ref, operationId: row.operation_id, reasonCode });
        const original = exactContext(parseStored(row.original_context_json, 'retired verification original'));
        if (!original || original.ownerRef !== checkpoint.ownerRef || original.subjectRef !== checkpoint.subjectRef ||
            checkpoint.connectionEpoch <= Math.max(row.original_connection_epoch, row.new_connection_epoch ?? 0)) {
          hold('VERIFICATION_RECOVERY_OWNER_OR_EPOCH_MISMATCH'); continue;
        }
        const created = all("SELECT receipt_json FROM backend_session_verification_events WHERE lease_ref=? AND event_kind='created' LIMIT 2", row.lease_ref);
        const initial = created.length === 1 ? parseStored(created[0].receipt_json, 'retired verification creation') : null;
        const oldLogin = initial?.oldLoginSource;
        if (!oldLogin || oldLogin.connectionEpoch !== original.connectionEpoch || oldLogin.officialUid !== currentLogin.officialUid || oldLogin.serverId !== currentLogin.serverId ||
            oldLogin.versionEvidence?.source !== 'normal-package-hop-and-matched-world-login/v1' ||
            oldLogin.versionEvidence?.loginResponseRef !== oldLogin.responseRef ||
            currentLogin.versionEvidence?.source !== 'normal-package-hop-and-matched-world-login/v1' ||
            currentLogin.versionEvidence?.loginResponseRef !== currentLogin.responseRef) {
          hold('VERIFICATION_RECOVERY_UID_OR_LOGIN_SOURCE_UNPROVEN'); continue;
        }
        const after = exactAfter(parseStored(row.after_json, 'retired verification answer'));
        const checked = after && answeredOperation(original, row.operation_id, after, row.executor_ref);
        if (!checked || checked.operation.write_slot !== 0) { hold('VERIFICATION_RECOVERY_ORIGINAL_SLOT_HELD'); continue; }
        const previousExecution = previousExecutionProof(row, original);
        if (!previousExecution) { hold('VERIFICATION_RECOVERY_PREVIOUS_EXECUTION_UNPROVEN'); continue; }
        let recoveryEvidenceId = null;
        if (checked.operation.business_verdict === 'unverified') {
          // A technical slot recovery deliberately leaves the original verdict
          // unchanged. Require its exact immutable current-login checkpoint.
          const candidates = all("SELECT * FROM backend_operation_evidence WHERE operation_id=? AND kind='historical-write-slot-release' AND source='backend/closed-write-recovery/v1' ORDER BY evidence_id LIMIT 3", row.operation_id);
          const recovered = candidates.find(entry => {
            const payload = parseStored(entry.payload_json, 'retired verification technical recovery');
            return ledgerJsonFingerprint({ kind: entry.kind, source: entry.source, payload, observedAt: entry.observed_at }) === entry.payload_fingerprint &&
              payload.technicalSlotOnly === true && payload.checkpoint?.subjectRef === checkpoint.subjectRef &&
              payload.checkpoint.connectionEpoch === checkpoint.connectionEpoch && payload.checkpoint.runEpoch === checkpoint.runEpoch &&
              payload.checkpoint.checkpointRef === currentLogin.responseRef && payload.checkpoint.factBasis?.officialUid === currentLogin.officialUid &&
              payload.executorIsolation?.executorRef === row.executor_ref && payload.executorIsolation.ownerRef === original.ownerRef &&
              payload.executorIsolation.ownerEpoch === original.ownerEpoch && payload.executorIsolation.runEpoch === original.runEpoch &&
              payload.executorIsolation.connectionEpoch === original.connectionEpoch;
          });
          if (!recovered) { hold('VERIFICATION_RECOVERY_SLOT_CHECKPOINT_UNPROVEN'); continue; }
          recoveryEvidenceId = Number(recovered.evidence_id);
        }
        if (!current(actor) || !sameContext(actorContext(actor), checkpoint)) throw problem('VERIFICATION_RECOVERY_CONTEXT_REVOKED', '收口旧租约前当前运行意愿已撤销');
        run("UPDATE backend_session_verification_leases SET active=0,state='recovered-retired',reason_code='OLD_EXECUTION_CLOSED_CURRENT_LOGIN',updated_at=? WHERE lease_ref=? AND active=1", nowIso(), row.lease_ref);
        leaseEvent(row.lease_ref, 'recovered-technical-isolation-retired', { operationId: row.operation_id, originalContext: original,
          newContext: checkpoint, currentLoginSource: currentLogin, previousExecution, recoveryEvidenceId,
          originalVerdict: checked.operation.business_verdict, originalOutcomeAndResourcesUnchanged: true });
        released.push({ leaseRef: row.lease_ref, operationId: row.operation_id, previousExecution, recoveryEvidenceId });
      }
      return freeze({ released, held, remaining: held.length });
    });
  }
  function assertConnection(actor) {
    if (!current(actor)) throw problem('RUN_INTENT_REVOKED', '连接建立期间运行意愿或执行权已撤销');
    if (!connectionCurrent(actor) || !actor.connection) {
      const reason = actor.transportCloseReason;
      const error = problem(reason?.code || 'SESSION_TRANSPORT_CLOSED', '当前官服连接已经结束');
      error.transportFailure = reason?.intentional === false && (RECOVERABLE_CLOSE.has(reason.code) || /^SOCKET_\d{1,5}$/.test(reason.code));
      throw error;
    }
  }
  function recordTransportIdentity(actor) {
    try {
      if (!actor || !connectionCurrent(actor) || actor.connection?.isOpen() !== true) return false;
      const connection = actor.connection, source = connection.context, login = loginSource(source?.loginObservation, source?.serverId);
      const account = get('SELECT subject_ref,server_id,profile_json FROM backend_accounts WHERE owner_ref=? AND account_id=? AND removed_at IS NULL',
        actor.ownerRef, String(actor.accountRef));
      const profile = account ? parseStored(account.profile_json, 'transport identity account profile') : null;
      const transport = source?.privateEndpointIdentity;
      const parsedEndpointsFingerprint = transport?.parsedEndpointsFingerprint;
      if (!account || account.subject_ref !== actor.subjectRef || !positive(profile?.uid) || profile.uid !== login.officialUid || account.server_id !== login.serverId ||
          login.connectionEpoch !== actor.connectionEpoch || login.method !== 'index.login' ||
          transport?.sourceMethod !== 'index.getGsInfoList' || transport?.parser !== 'parseEndpoints/v1' ||
          !/^[a-f0-9]{64}$/.test(parsedEndpointsFingerprint || '') ||
          !Number.isSafeInteger(Date.parse(transport.observedAt)) ||
          typeof transport.selectedHost !== 'string' || !/^[A-Za-z0-9.-]+$/.test(transport.selectedHost) ||
          !Number.isSafeInteger(transport.selectedPort) || transport.selectedPort < 1 || transport.selectedPort > 65535 ||
          transport?.source !== 'tls-socket-after-matched-world-login/v1') return false;
      const socketTupleComplete = typeof transport.localAddress === 'string' && Number.isSafeInteger(transport.localPort) &&
        transport.localPort > 0 && transport.localPort <= 65535 && typeof transport.remoteAddress === 'string' &&
        Number.isSafeInteger(transport.remotePort) && transport.remotePort > 0 && transport.remotePort <= 65535;
      if (!socketTupleComplete) return false;
      const payload = { schema: 'official-world-transport-identity/v1', source: { method: transport.sourceMethod,
        parser: transport.parser, parsedEndpointsFingerprint,
        observedAt: transport.observedAt }, selectedEndpoint: { host: transport.selectedHost, port: transport.selectedPort },
        captureStatus: transport.proxyConfigured === true ? 'proxy-configured' : socketTupleComplete ? 'captured' : 'socket-tuple-incomplete',
        reasonCode: transport.proxyConfigured === true ? 'TLS_SOCKET_IS_PROXY' : socketTupleComplete ? null : 'TLS_SOCKET_TUPLE_INCOMPLETE',
        tlsSocket: { localAddress: transport.localAddress, localPort: transport.localPort,
          remoteAddress: transport.remoteAddress, remotePort: transport.remotePort, proxyConfigured: transport.proxyConfigured === true },
        loginResponseRef: login.responseRef, officialUid: login.officialUid, serverId: login.serverId,
        ownerRef: actor.ownerRef, accountRef: String(actor.accountRef), subjectRef: actor.subjectRef,
        ownerEpoch: actor.ownerEpoch, runEpoch: actor.runEpoch, connectionEpoch: actor.connectionEpoch,
        executorRef, processPid: process.pid };
      const receipt = canonical(payload);
      if (Buffer.byteLength(receipt, 'utf8') > 4096 || !connectionCurrent(actor) || actor.connection?.isOpen() !== true) return false;
      const receiptRef = 'transport-identity:' + fingerprint([actor.ownerRef, actor.accountRef, actor.subjectRef,
        actor.ownerEpoch, actor.runEpoch, actor.connectionEpoch]);
      return transaction(() => {
        if (!connectionCurrent(actor) || actor.connection?.isOpen() !== true) return false;
        run(`INSERT OR IGNORE INTO backend_session_transport_identity_receipts
          (receipt_ref,owner_ref,account_ref,subject_ref,owner_epoch,run_epoch,connection_epoch,executor_ref,payload_json,payload_fingerprint,recorded_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`, receiptRef, actor.ownerRef, String(actor.accountRef), actor.subjectRef,
          actor.ownerEpoch, actor.runEpoch, actor.connectionEpoch, executorRef, receipt, fingerprint(payload), nowIso());
        const saved = get(`SELECT payload_json,payload_fingerprint FROM backend_session_transport_identity_receipts
          WHERE owner_ref=? AND account_ref=? AND subject_ref=? AND owner_epoch=? AND run_epoch=? AND connection_epoch=?`,
          actor.ownerRef, String(actor.accountRef), actor.subjectRef, actor.ownerEpoch, actor.runEpoch, actor.connectionEpoch);
        if (!saved || saved.payload_fingerprint !== fingerprint(parseStored(saved.payload_json, 'transport identity receipt')) ||
            saved.payload_fingerprint !== fingerprint(payload)) return false;
        return true;
      });
    } catch { return false; }
  }
  function transition(actor, state, reasonCode = null) {
    if (!matchesIntent(actor) || actor.ownerEpoch !== null && !current(actor) || actor.transportClosed && FACT_STATES.has(state)) return false;
    const changed = run(`UPDATE backend_run_intents SET state=?,reason_code=?,updated_at=?
      WHERE owner_ref=? AND account_ref=? AND desired_running=1 AND run_epoch=? AND connection_epoch=?`,
      state, reasonCode, nowIso(), actor.ownerRef, actor.accountRef, actor.runEpoch, actor.connectionEpoch).changes;
    if (changed) {
      actor.state = state;
      try { onState(project(actor.ownerRef, actor.accountRef)); } catch { /* An observer cannot interrupt revocation/cleanup. */ }
    }
    return changed === 1;
  }
  function commandReceipt(ownerRef, commandId, accountRef, kind) {
    const old = get('SELECT * FROM backend_control_receipts WHERE owner_ref=? AND command_id=?', ownerRef, commandId);
    if (!old) return null;
    if (old.account_ref !== String(accountRef) || old.kind !== kind) throw problem('CONTROL_COMMAND_CONFLICT', '同一控制指令标识不能用于另一操作');
    return parseStored(old.receipt_json, '控制回执');
  }
  function saveReceipt(ownerRef, commandId, accountRef, kind, receipt) {
    run('INSERT INTO backend_control_receipts VALUES(?,?,?,?,?,?) ON CONFLICT(owner_ref,command_id) DO UPDATE SET receipt_json=excluded.receipt_json',
      ownerRef, commandId, String(accountRef), kind, canonical(receipt), nowIso());
    return receipt;
  }
  function assertStartSlotAvailable(subjectRef, previous) {
    if (bySubject(subjectRef)) throw problem('SUBJECT_SESSION_BUSY', '同一游戏主体的旧连接尚未清理完成');
    if (previous?.state === 'STOPPING') throw problem('SUBJECT_SESSION_STOPPING', '上一轮停止尚未完成，暂不建立新连接');
  }
  async function performStart({ ownerRef, accountRef, commandId, expectedRunEpoch = null, expectedPriorRunEpoch = null, automatic = false, expectedLogin = null }) {
    assertSupervisorOpen();
    const bound = binding(ownerRef, accountRef);
    // This also covers automatic recovery and snapshot replacement, which do not
    // pass through start(): no login may precede the persisted cooldown floor.
    const cooling = cooldownRejection(ownerRef, accountRef);
    if (cooling) throw cooling;
    if (isAccountStopPending({ ownerRef, accountRef: String(accountRef), subjectRef: bound.subject_ref }) === true) {
      throw problem('ACCOUNT_STOP_PENDING', '本机已保存这个游戏号的停止请求，完成停止前不能重新开始', 409);
    }
    let actor;
    try {
      const context = transaction(() => {
        const previous = intent(ownerRef, accountRef);
        if (expectedPriorRunEpoch !== null && Number(previous?.run_epoch || 0) !== expectedPriorRunEpoch)
          throw problem('RUN_INTENT_CHANGED', '启动请求对应的停止代次已变化，请先刷新账号状态');
        if (expectedRunEpoch !== null && (previous?.desired_running !== 1 || previous.run_epoch !== expectedRunEpoch)) throw problem('RUN_INTENT_REVOKED', '重连等待期间运行意愿已变化');
        assertStartSlotAvailable(bound.subject_ref, previous);
        const previousConnection = get('SELECT connection_epoch FROM backend_subject_connection_epochs WHERE subject_ref=?', bound.subject_ref);
        const connectionEpoch = Math.max(Number(previousConnection?.connection_epoch || 0), Number(previous?.connection_epoch || 0)) + 1;
        run(`INSERT INTO backend_subject_connection_epochs VALUES(?,?) ON CONFLICT(subject_ref)
          DO UPDATE SET connection_epoch=excluded.connection_epoch`, bound.subject_ref, connectionEpoch);
        const next = { ownerRef, accountRef, subjectRef: bound.subject_ref, runEpoch: Number(previous?.run_epoch || 0) + 1,
          connectionEpoch };
        const savedRecovery = recovery(ownerRef, accountRef), retryAtMs = automatic ? savedRecovery?.retry_at_ms ?? null : null;
        run(`INSERT INTO backend_run_intents VALUES(?,?,?,1,?,?,'STARTING',NULL,?,?,?)
          ON CONFLICT(owner_ref,account_ref) DO UPDATE SET desired_running=1,run_epoch=excluded.run_epoch,
          connection_epoch=excluded.connection_epoch,state='STARTING',reason_code=NULL,command_id=excluded.command_id,retry_at_ms=excluded.retry_at_ms,updated_at=excluded.updated_at`,
          ownerRef, accountRef, bound.subject_ref, next.runEpoch, next.connectionEpoch, commandId, retryAtMs, nowIso());
        saveRecovery({ ...next, status: 'attempting', attempt: automatic ? Number(savedRecovery?.attempt || 0) : 0, retryAtMs,
          reasonCode: automatic ? 'SESSION_RECOVERY_ATTEMPT' : 'EXPLICIT_START', error: {}, closeEvidenceRef: savedRecovery?.close_evidence_ref });
        appendOutbox?.({ ownerRef, subjectRef: bound.subject_ref, type: 'StartRequested', payload: next });
        saveReceipt(ownerRef, commandId, accountRef, 'start', { accepted: true, state: 'starting', runEpoch: next.runEpoch, connectionEpoch: next.connectionEpoch });
        return next;
      });
      actor = { ...context, ownerEpoch: null, controller: new AbortController(), connection: null, state: 'STARTING',
        transportClosed: false, stopNotified: false, startComplete: false, connectAttempted: false, connectRejectedClosed: false };
      actors.set(keyOf(ownerRef, accountRef), actor);
      await authorize({ ...context, purpose: 'read-session', signal: actor.controller.signal });
      actor.controller.signal.throwIfAborted();
      const previousOwner = get('SELECT * FROM backend_subject_owners WHERE subject_ref=?', actor.subjectRef);
      const proof = await isolatePreviousExecutor({ ...context, previousOwner, executorRef, signal: actor.controller.signal });
      actor.controller.signal.throwIfAborted();
      if (proof?.isolated !== true || !proof.evidenceRef || !proof.sourceRef || proof.subjectRef !== actor.subjectRef) {
        throw problem('PREVIOUS_EXECUTOR_NOT_ISOLATED', '尚未证明旧执行方停止，本次不建立游戏连接');
      }
      actor.executorIsolation = proof;
      transaction(() => {
        if (!matchesIntent(actor)) throw problem('RUN_INTENT_REVOKED', '运行意愿已撤销');
        const latestOwner = get('SELECT * FROM backend_subject_owners WHERE subject_ref=?', actor.subjectRef);
        // Isolation may mark the captured owner inactive. It cannot authorize
        // taking over a different owner/ref/epoch that appeared while awaiting.
        if (!sameOwner(latestOwner, previousOwner)) throw problem('SUBJECT_OWNER_CHANGED', '主体执行权已改变');
        actor.ownerEpoch = Number(latestOwner?.owner_epoch || 0) + 1;
        run(`INSERT INTO backend_subject_owners VALUES(?,?,?,?,1,?,?) ON CONFLICT(subject_ref) DO UPDATE SET
          owner_ref=excluded.owner_ref,executor_ref=excluded.executor_ref,owner_epoch=excluded.owner_epoch,active=1,
          isolation_evidence_json=excluded.isolation_evidence_json,updated_at=excluded.updated_at`,
          actor.subjectRef, ownerRef, executorRef, actor.ownerEpoch, canonical(proof), nowIso());
      });
      transition(actor, 'CONNECTING');
      if (!current(actor)) throw problem('RUN_INTENT_REVOKED', '连接建立前运行意愿已撤销');
      if (network.online === false) {
        actor.offlineRecoveryRequested = true;
        throw Object.assign(problem('NATIVE_NETWORK_OFFLINE', '当前原生网络事实为离线'), { transportFailure: true });
      }
      actor.connectAttempted = true;
      const connectingContext = actorContext(actor);
      actor.connection = await connect({ ...actor, signal: actor.controller.signal,
        isCurrent: () => current(actor) && sameContext(actorContext(actor), connectingContext) && !actor.transportClosed,
        // Transport routing may record a failed official endpoint only after
        // the physical close event, when connectionCurrent is already false.
        // Keep this separate owner fence strict about the tuple and desired
        // intent, but independent of the retired transportClosed bit.
        isTransportOwnerCurrent: () => !shuttingDown &&
          actors.get(keyOf(actor.ownerRef, actor.accountRef)) === actor && matchesIntent(actor) &&
          sameContext(actorContext(actor), connectingContext) && ownsSubject(actor) &&
          get('SELECT active FROM backend_subject_owners WHERE subject_ref=?', actor.subjectRef)?.active === 1,
        onClosed: reason => handleTransportClosed(actor, connectingContext, reason) });
      assertConnection(actor);
      if (expectedLogin) {
        const fresh = loginSource(actor.connection.context?.loginObservation, actor.connection.context?.serverId);
        if (fresh.connectionEpoch !== actor.connectionEpoch || fresh.officialUid !== expectedLogin.officialUid || fresh.serverId !== expectedLogin.serverId) {
          throw problem('OFFICIAL_REFRESH_IDENTITY_CHANGED', '完整快照刷新未得到原主体的正常登录');
        }
      }
      recordTransportIdentity(actor);
      transition(actor, 'SYNCHRONIZING');
      assertConnection(actor);
      await onConnected({ ...actor, isCurrent: () => connectionCurrent(actor), signal: actor.controller.signal });
      assertConnection(actor);
      transition(actor, 'WAITING');
      assertConnection(actor);
      transaction(() => {
        if (!current(actor)) throw problem('RUN_INTENT_REVOKED', '连接同步完成前运行意愿已变化');
        const saved = recovery(ownerRef, accountRef);
        saveRecovery({ ...actor, status: 'connected', attempt: Number(saved?.attempt || 0), retryAtMs: null,
          reasonCode: 'SESSION_CONNECTED', error: {}, closeEvidenceRef: saved?.close_evidence_ref });
        // The conflict streak is not cleared here. It is retired only when a new
        // conflict arrives after a stable connection, so an immediate re-kick
        // escalates instead of looping at the base delay.
        noteSessionConnected(actor);
        run('UPDATE backend_run_intents SET retry_at_ms=NULL,updated_at=? WHERE owner_ref=? AND account_ref=? AND desired_running=1 AND run_epoch=? AND connection_epoch=?',
          nowIso(), ownerRef, accountRef, actor.runEpoch, actor.connectionEpoch);
      });
      actor.startComplete = true;
      return saveReceipt(ownerRef, commandId, accountRef, 'start', { accepted: true, account: project(ownerRef, accountRef) });
    } catch (error) {
      const restarting = shuttingDown;
      const failureError = restarting ? Object.assign(problem('ENGINE_RESTARTING', '执行器正在退出，保留本次运行意愿并收尾'), { transportFailure: true }) :
        actor?.offlineRecoveryRequested ? Object.assign(problem('NATIVE_NETWORK_OFFLINE', '当前原生网络事实为离线'), { transportFailure: true }) : error;
      const failurePolicy = classifySessionFailure(failureError);
      const failureReason = failurePolicy.action === 'needs-credentials' ? 'SESSION_NEEDS_CREDENTIALS' :
        failurePolicy.action === 'account-disabled' ? 'SESSION_ACCOUNT_DISABLED' : failurePolicy.action === 'ownership-conflict' ? 'SESSION_SUBJECT_CONFLICT' : codeOf(failureError);
      if (actor && !restarting) transition(actor, failurePolicy.retryable ?
        (failurePolicy.action === 'wait-network' || actor.transportClosed ? 'WAITING_NETWORK' : 'WAITING_LOGIN') : 'BLOCKED', failureReason);
      // Owner acquisition can roll back after actor.ownerEpoch was assigned.
      // Such an actor does not own the subject, but its exact current intent
      // must still leave STARTING. Never touch another owner's row to do so.
      if (actor) transaction(() => {
        if (!sameRecoveryIntent(actor)) return;
        const saved = recovery(ownerRef, accountRef), attempt = Number(saved?.attempt || 0);
        saveRecovery({ ...actor, status: restarting || failurePolicy.retryable ? 'cleanup_pending' : 'blocked', attempt: restarting ? 0 : attempt,
          retryAtMs: restarting ? deviceNow() : failurePolicy.retryable ? saved?.retry_at_ms ?? deviceNow() + (failurePolicy.retryAfterMs || backoff(attempt)) : null,
          reasonCode: restarting ? 'ENGINE_RESTARTED' : failureReason, error: { code: restarting ? 'ENGINE_RESTARTED' : codeOf(failureError),
            transportFailure: failureError?.transportFailure === true, loginKind: failurePolicy.loginKind, loginCode: failurePolicy.loginCode,
            remoteCode: failurePolicy.remoteCode, loginCodeKey: failurePolicy.loginCodeKey, sourceNamespace: failurePolicy.namespace,
            phase: failurePolicy.phase, action: failurePolicy.action, retryAfterMs: failurePolicy.retryAfterMs,
            userActionRequired: failurePolicy.userActionRequired, connectAttempted: actor.connectAttempted }, closeEvidenceRef: actor.closeEvidenceRef });
        run('UPDATE backend_run_intents SET state=?,reason_code=?,retry_at_ms=NULL,updated_at=? WHERE owner_ref=? AND account_ref=? AND desired_running=1 AND run_epoch=? AND connection_epoch=?',
          restarting || failurePolicy.retryable ? 'RECOVERING' : 'BLOCKED', restarting ? 'ENGINE_RESTARTED' : failureReason, nowIso(), ownerRef, String(accountRef), actor.runEpoch, actor.connectionEpoch);
      });
      // Process shutdown is not a user revocation. Keep the original actor
      // current while an already-consumed permit gets its matched reply and
      // post-read. The restart path only observes an existing drain ticket;
      // it must never call revokeWrites for an in-flight operation.
      const writeDrain = restarting
        ? actor?.writeDrainTicket || { captured: false, completion: Promise.resolve({ durableOutcome: true }) }
        : captureWriteDrain(actor, codeOf(failureError));
      if (!restarting) actor?.controller.abort(error);
      // An async onConnected may finish after an earlier stop notification;
      // clear any resources it created late, still only for this exact actor.
      if (!restarting) { try { notifyStopped(actor, true); } catch { /* Revocation and socket cleanup still take precedence. */ } }
      const drainDurable = await writeDrainComplete(writeDrain);
      let restartDrained = true;
      if (restarting && actor) {
        const deadline = monotonicNow() + cleanupTimeoutMs;
        while (monotonicNow() < deadline && !drainReady(actor)) await new Promise(resolve => setTimeout(resolve, 25));
        restartDrained = drainReady(actor);
        if (restartDrained) {
          actor.controller.abort(failureError);
          try { notifyStopped(actor, true); } catch { /* Keep the original intent and unknown ledger. */ }
        }
      }
      let closed = !actor || rejectedConnectionClosed(actor, error);
      if (actor?.connection) {
        try { closed = await closeTransport(actor); } catch { closed = false; }
      }
      if (!drainDurable || !restartDrained) closed = false;
      let nextRecovery = null;
      if (actor) transaction(() => {
        if (closed) {
          run('UPDATE backend_subject_owners SET active=0,updated_at=? WHERE subject_ref=? AND owner_ref=? AND executor_ref=? AND owner_epoch=?', nowIso(), actor.subjectRef, actor.ownerRef, executorRef, actor.ownerEpoch);
          if (actors.get(keyOf(ownerRef, accountRef)) === actor) actors.delete(keyOf(ownerRef, accountRef));
        }
        nextRecovery = scheduleAfterFailure(actor, failureError, closed, false);
      });
      if (nextRecovery) armRecovery(nextRecovery);
      if (actor) saveReceipt(ownerRef, commandId, accountRef, 'start', { accepted: true, connected: false,
        reasonCode: codeOf(failureError), transportClosed: closed, account: project(ownerRef, accountRef) });
      throw error;
    }
  }
  function snapshotRefreshEvent(refresh, eventKind, receipt) {
    const eventRef = 'snapshot-refresh-event:' + newId(), context = refresh.originalContext;
    run('INSERT INTO backend_session_snapshot_refresh_events VALUES(?,?,?,?,?,?,?,?,?)', eventRef, refresh.refreshRef,
      context.ownerRef, context.accountRef, context.subjectRef, canonical(context), eventKind, canonical(receipt), nowIso());
    return eventRef;
  }
  function expiredSnapshot(actor, context, snapshotRef) {
    const row = get(`SELECT owner_ref,account_ref,subject_ref,context_key,connection_epoch,request_sequence,response_ref,payload_json,payload_fingerprint
      FROM backend_customer_generation_days WHERE receipt_ref=?`, snapshotRef);
    if (!row || row.owner_ref !== context.ownerRef || row.account_ref !== context.accountRef || row.subject_ref !== context.subjectRef ||
      row.connection_epoch !== context.connectionEpoch || row.context_key !== fingerprint(CONTEXT_FIELDS.map(key => context[key]))) return null;
    const latest = get(`SELECT receipt_ref FROM backend_customer_generation_days WHERE owner_ref=? AND account_ref=? AND subject_ref=? AND context_key=?
      ORDER BY request_sequence DESC LIMIT 1`, context.ownerRef, context.accountRef, context.subjectRef, row.context_key);
    if (latest?.receipt_ref !== snapshotRef) return null;
    const payload = parseStored(row.payload_json, '完整日界快照'), day = payload?.officialDay, source = day?.source;
    const login = loginSource(actor.connection.context?.loginObservation, actor.connection.context?.serverId);
    const c = readOfficialClock(context.subjectRef);
    if (c?.then) { c.catch?.(() => {}); throw new TypeError('Official clock read must be synchronous'); }
    if (fingerprint(payload) !== row.payload_fingerprint || payload.kind !== 'complete-login-day' || !sameContext(exactContext(payload.context), context) ||
      payload.officialUid !== login.officialUid || payload.source?.method !== 'index.login' || payload.source.contextKey !== row.context_key ||
      login.connectionEpoch !== context.connectionEpoch || row.response_ref !== login.responseRef || row.request_sequence !== login.requestSequence ||
      canonical(exactAfter(payload.source)) !== canonical(exactAfter(login)) ||
      day?.version !== 'customer-observed-client-day/v1' || day.sourceContract?.gameVersion !== login.versionEvidence.gameVersion ||
      day.sourceContract?.protocolVersion !== login.versionEvidence.protocolVersion ||
      c?.available !== true || c.source !== 'official-anchor-monotonic' || c.connectionEpoch !== context.connectionEpoch ||
      !positive(c.nowMs) || !Number.isFinite(c.lowerBoundMs) || !Number.isFinite(c.upperBoundMs) || c.lowerBoundMs > c.nowMs || c.upperBoundMs < c.nowMs) return null;
    const expired = day.known === true && positive(day.startMs) && positive(day.endMs) && day.endMs - day.startMs === 86400000 &&
      source?.officialUid === login.officialUid && source.contextKey === row.context_key && source.method === 'index.login' &&
      canonical(exactAfter(source)) === canonical(exactAfter(login)) && source.version?.loginResponseRef === login.responseRef &&
      source.version?.gameVersion === login.versionEvidence.gameVersion && source.version?.protocolVersion === login.versionEvidence.protocolVersion &&
      source.version?.source === login.versionEvidence.source && c.lowerBoundMs >= day.endMs;
    const observed = payload.dayObservationClock;
    const boundaryRetry = day.known === false && day.reasonCode === 'CUSTOMER_DAY_CLOCK_INTERVAL_CROSSES_BOUNDARY' &&
      observed?.source === 'official-anchor-monotonic' && observed.connectionEpoch === context.connectionEpoch && positive(observed.nowMs) &&
      Number.isFinite(observed.lowerBoundMs) && Number.isFinite(observed.upperBoundMs) && observed.lowerBoundMs <= observed.nowMs && observed.upperBoundMs >= observed.nowMs &&
      c.lowerBoundMs >= observed.upperBoundMs + 30000;
    if (!expired && !boundaryRetry) return null;
    return { snapshotRef, snapshotFingerprint: row.payload_fingerprint, officialUid: login.officialUid, login,
      causeCode: expired ? 'EXPIRED_COMPLETE_LOGIN_DAY' : 'CUSTOMER_DAY_CLOCK_INTERVAL_CROSSES_BOUNDARY',
      originalDay: expired ? { key: day.key, startMs: day.startMs, endMs: day.endMs } : null,
      observedClock: { source: c.source, connectionEpoch: c.connectionEpoch, nowMs: c.nowMs, lowerBoundMs: c.lowerBoundMs, upperBoundMs: c.upperBoundMs } };
  }
  // Only an expired day or this exact resolved-boundary clock interval from an
  // immutable complete normal-login snapshot may request this port.
  // It is shared by enabled order features; no customer master switch is read.
  // A dynamic refresh is one normal login that returns a full snapshot, so a
// bounded set covering every registered dynamic domain must fit in a single
// request. Splitting into several logins would both exceed the official pace
// and leave part of the account dirty in between.
  const MAX_REFRESH_DOMAINS = 64;
  function refreshCurrent({ context: supplied, snapshotRef, reasonCode, domains = null, reasons = null, refreshRef = null } = {}) {
    const context = exactContext(supplied), unavailable = code => Promise.resolve({ accepted: false, refreshed: false, reasonCode: code });
    const dynamic = Array.isArray(domains) && domains.length > 0 && Array.isArray(reasons) && reasons.length > 0 &&
      domains.length <= MAX_REFRESH_DOMAINS && reasons.length <= MAX_REFRESH_DOMAINS &&
      domains.every(value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value)) &&
      reasons.every(value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(value));
    if (shuttingDown) return unavailable('ENGINE_RESTARTING');
    if (!context || !(dynamic || typeof snapshotRef === 'string' && snapshotRef && snapshotRef.length <= 512 && reasonCode === 'CUSTOMER_OFFICIAL_DAY_SNAPSHOT_EXPIRED') ||
        dynamic && (new Set(domains).size !== domains.length || new Set(reasons).size !== reasons.length || typeof refreshRef !== 'string' || !refreshRef || refreshRef.length > 128)) {
      return unavailable('SESSION_SNAPSHOT_REFRESH_ARGUMENT_INVALID');
    }
    if (dynamic && authorizeDynamicRefresh({ context, refreshRef, domains, reasons }) !== true) return unavailable('SESSION_DYNAMIC_REFRESH_NOT_AUTHORIZED');
    const key = keyOf(context.ownerRef, context.accountRef), actor = actors.get(key);
    if (actor?.refreshPromise) return sameContext(actor.snapshotRefresh?.originalContext, context)
      ? actor.refreshPromise : unavailable('SESSION_SNAPSHOT_REFRESH_BUSY');
    if (!actor || !sameContext(actorContext(actor), context) || !connectionCurrent(actor) || !actor.startComplete || !actor.connection?.isOpen()) {
      return unavailable('SESSION_SNAPSHOT_REFRESH_CONTEXT_REVOKED');
    }
    if (pending.has(key) || actor.verificationLease || actor.verificationPromise || actor.verificationResumeHandle || actor.recoveryPromise) return unavailable('SESSION_SNAPSHOT_REFRESH_BUSY');
    let proof, refresh;
    try {
      if (dynamic) {
        const currentLogin = loginSource(actor.connection.context?.loginObservation, actor.connection.context?.serverId);
        if (!positive(currentLogin.officialUid) || !currentLogin.versionEvidence?.gameVersion || !currentLogin.versionEvidence?.protocolVersion) {
          return unavailable('SESSION_DYNAMIC_REFRESH_IDENTITY_UNPROVEN');
        }
        proof = { snapshotRef: 'dynamic-state:' + refreshRef, snapshotFingerprint: fingerprint([domains, reasons]),
          officialUid: currentLogin.officialUid, login: currentLogin, causeCode: 'DYNAMIC_FACTS_REQUIRE_REFRESH', domains: [...domains], reasons: [...reasons] };
      } else {
        proof = expiredSnapshot(actor, context, snapshotRef);
        if (!proof) return unavailable('SESSION_SNAPSHOT_REFRESH_EXPIRY_UNPROVEN');
      }
      const activity = readWriteActivity({ subjectRef: context.subjectRef });
      if (activity?.then) { activity.catch?.(() => {}); throw new TypeError('Write activity read must be synchronous'); }
      if (activity?.inFlight !== false || get('SELECT 1 FROM backend_operations WHERE subject_ref=? AND write_slot=1 LIMIT 1', context.subjectRef) ||
        get('SELECT 1 FROM backend_session_verification_leases WHERE subject_ref=? AND active=1 LIMIT 1', context.subjectRef)) return unavailable('SESSION_SNAPSHOT_REFRESH_WRITE_BUSY');
      refresh = { refreshRef: dynamic ? refreshRef : 'snapshot-refresh:' + newId(), snapshotRef: proof.snapshotRef || snapshotRef,
        originalContext: context, oldClosing: true, dynamic, domains: dynamic ? [...domains] : [], reasons: dynamic ? [...reasons] : [] };
      transaction(() => {
        if (!current(actor) || !sameContext(actorContext(actor), context)) throw problem('RUN_INTENT_REVOKED', '完整快照刷新提交前运行意愿已撤销');
        if (!dynamic) {
          run('INSERT OR IGNORE INTO backend_session_snapshot_refresh_limits VALUES(?,?,?,?,?,0,?)', context.ownerRef, context.accountRef,
            context.subjectRef, proof.officialUid, snapshotRef, nowIso());
          const claimed = run(`UPDATE backend_session_snapshot_refresh_limits SET attempt=attempt+1,updated_at=?
            WHERE owner_ref=? AND account_ref=? AND subject_ref=? AND official_uid=?`,
          nowIso(), context.ownerRef, context.accountRef, context.subjectRef, proof.officialUid);
          if (claimed.changes !== 1) throw problem('SESSION_SNAPSHOT_REFRESH_SUBJECT_MISMATCH', '当前完整快照刷新主体不一致');
        }
        snapshotRefreshEvent(refresh, 'requested', { snapshotRef: proof.snapshotRef || snapshotRef, snapshotFingerprint: proof.snapshotFingerprint,
          reasonCode: dynamic ? 'DYNAMIC_FACTS_REQUIRE_REFRESH' : reasonCode, causeCode: proof.causeCode,
          domains: refresh.domains, reasons: refresh.reasons, officialUid: proof.officialUid,
          ...(proof.originalDay === undefined ? {} : { originalDay: proof.originalDay }),
          ...(proof.observedClock === undefined ? {} : { observedClock: proof.observedClock }) });
        const saved = recovery(actor.ownerRef, actor.accountRef);
        // A process exit in this gap resumes through normal executor isolation;
        // the old day receipt never supplies facts for the next day.
        saveRecovery({ ...actor, status: 'cleanup_pending', attempt: Number(saved?.attempt || 0), retryAtMs: null,
          reasonCode: 'SESSION_SNAPSHOT_REFRESH_PENDING', error: { code: 'SESSION_SNAPSHOT_REFRESH_PENDING', transportFailure: true },
          closeEvidenceRef: actor.closeEvidenceRef });
        transition(actor, 'RECOVERING', dynamic ? 'DYNAMIC_FACTS_REQUIRE_REFRESH' : reasonCode);
      });
    } catch (error) { return unavailable(codeOf(error)); }
    actor.snapshotRefresh = refresh; actor.startComplete = false;
    const flight = (async () => {
      let timer;
      try {
        // The state fence above is synchronous with the no-flight/no-slot
        // checks. Stop old feature timers before yielding to physical close.
        notifyStopped(actor);
        const closed = await Promise.race([closeTransport(actor), new Promise(resolve => { timer = setTimeout(() => resolve(false), cleanupTimeoutMs); })]);
        if (!closed) throw Object.assign(problem('SESSION_SNAPSHOT_REFRESH_CLOSE_UNPROVEN', '旧连接物理关闭尚未确认'), { transportFailure: true });
        if (!current(actor) || !sameContext(actorContext(actor), context)) throw problem('RUN_INTENT_REVOKED', '完整快照刷新等待期间运行意愿或执行权已变化');
        snapshotRefreshEvent(refresh, 'physical-close-proved', { closed: true, closureEvidenceRef: actor.closeEvidenceRef, connectionEpoch: context.connectionEpoch });
        // Reuse the ordinary start path: normal authorization, exact owner
        // retirement, new owner/run/connection epochs and a real index.login.
        const result = await start({ ownerRef: context.ownerRef, accountRef: context.accountRef, commandId: refresh.refreshRef }, { actor, expectedLogin: proof.login });
        const next = actors.get(key), nextContext = next && exactContext(actorContext(next));
        const refreshed = result.accepted === true && next !== actor && nextContext && connectionCurrent(next) && next.startComplete;
        snapshotRefreshEvent(refresh, refreshed ? 'fresh-login-established' : 'fresh-login-not-current', { refreshed: !!refreshed,
          closureEvidenceRef: actor.closeEvidenceRef, newContext: refreshed ? nextContext : null,
          domains: refresh.domains, reasons: refresh.reasons,
          loginSource: refreshed ? loginSource(next.connection.context?.loginObservation, next.connection.context?.serverId) : null });
        return freeze({ accepted: true, refreshed: !!refreshed, reasonCode: refreshed ? null : 'SESSION_SNAPSHOT_REFRESH_NOT_CURRENT',
          refreshRef: refresh.refreshRef, snapshotRef: refresh.snapshotRef, originalContext: context, newContext: refreshed ? nextContext : null, closureEvidenceRef: actor.closeEvidenceRef });
      } catch (error) {
        const failed = actor.offlineRecoveryRequested ? Object.assign(problem('NATIVE_NETWORK_OFFLINE', '当前原生网络事实为离线'), { transportFailure: true }) : error;
        snapshotRefreshEvent(refresh, 'failed', { reasonCode: codeOf(failed), closureEvidenceRef: actor.closeEvidenceRef ?? null,
          desiredStillCurrent: sameRecoveryIntent(actor) });
        // A replacement's own start failure already owns bounded recovery.
        // Only this still-owned old actor needs cleanup/retry here.
        if (actors.get(key) === actor && sameRecoveryIntent(actor)) void requestAutomaticRecovery(actor, failed).catch(() => {});
        return { accepted: true, refreshed: false, refreshRef: refresh.refreshRef, snapshotRef, reasonCode: codeOf(failed) };
      } finally {
        clearTimeout(timer); refresh.oldClosing = false;
        if (actor.snapshotRefresh === refresh) actor.snapshotRefresh = null;
        actor.refreshPromise = null;
      }
    })();
    actor.refreshPromise = flight;
    return flight;
  }
  function preflightStart({ ownerRef, accountRef, commandId = null, expectedPriorRunEpoch = null }, replacement = null) {
    accountRef = String(accountRef); requireText(ownerRef, 'ownerRef');
    if (commandId !== null) requireText(commandId, 'commandId');
    if (expectedPriorRunEpoch !== null && (!Number.isSafeInteger(expectedPriorRunEpoch) || expectedPriorRunEpoch < 0))
      throw problem('START_CONTROL_REVISION_INVALID', '启动请求代次格式无效', 400);
    if (shuttingDown) throw problem('ENGINE_RESTARTING', '本机执行器正在安全退出，暂不接受新会话操作', 503);
    const bound = binding(ownerRef, accountRef);
    if (expectedPriorRunEpoch !== null && Number(intent(ownerRef, accountRef)?.run_epoch || 0) !== expectedPriorRunEpoch)
      throw problem('RUN_INTENT_CHANGED', '启动请求对应的停止代次已变化，请先刷新账号状态', 409);
    if (isAccountStopPending({ ownerRef, accountRef, subjectRef: bound.subject_ref }) === true)
      throw problem('ACCOUNT_STOP_PENDING', '本机已保存这个游戏号的停止请求，完成停止前不能重新开始', 409);
    if (assertCanonicalExecution !== null && assertCanonicalExecution({ ownerRef, subjectRef: bound.subject_ref, accountRef }) === false)
      throw problem('OFFICIAL_SUBJECT_ALREADY_RUNNING', '同一官服角色已由另一个登录别名执行，不能同时启动第二写者', 409);
    if (commandId !== null && commandReceipt(ownerRef, commandId, accountRef, 'start')) return true;
    // A user STOP + START, or a plain repeated START, is not evidence that the
    // other client left. Keep the persisted conflict cooldown.
    const cooling = cooldownRejection(ownerRef, accountRef);
    if (cooling) throw cooling;
    const key = keyOf(ownerRef, accountRef);
    const actor = actors.get(key);
    if ((actor?.snapshotRefresh || actor?.refreshPromise) && replacement?.actor !== actor) throw problem('SESSION_SNAPSHOT_REFRESH_BUSY', '本主体正在取得当前完整官服快照');
    if (actor?.verificationLease || actor?.verificationPromise || actor?.verificationResumeHandle) throw problem('SESSION_VERIFICATION_READ_BUSY', '本主体原写入正在独立核验，请等待持久收尾');
    if (!pending.has(key) && actor && !current(actor)) throw problem('SUBJECT_SESSION_CLEANUP_REQUIRED', '旧连接尚未确认结束，请先完成停止');
    if (!pending.has(key) && !actor) assertStartSlotAvailable(bound.subject_ref, intent(ownerRef, accountRef));
    return true;
  }
  function start({ ownerRef, accountRef, commandId = newId(), expectedPriorRunEpoch = null }, replacement = null) {
    accountRef = String(accountRef); requireText(ownerRef, 'ownerRef'); requireText(commandId, 'commandId');
    try { preflightStart({ ownerRef, accountRef, commandId, expectedPriorRunEpoch }, replacement); }
    catch (error) { return Promise.reject(error); }
    const existing = commandReceipt(ownerRef, commandId, accountRef, 'start');
    if (existing) return Promise.resolve(existing);
    const key = keyOf(ownerRef, accountRef), actor = actors.get(key);
    if (pending.has(key)) return pending.get(key);
    recoveryOwners.add(ownerRef);
    cancelRecoveryTimer(ownerRef, accountRef);
    if (actor && current(actor)) {
      if (actor.connection?.isOpen()) return Promise.resolve({ accepted: true, account: project(ownerRef, accountRef) });
      const expectedRunEpoch = actor.runEpoch;
      const reconnect = (async () => {
        // Retire this transport without rewriting the user's desired state.
        // A concurrent stop changes runEpoch; it wins before the replacement.
        transition(actor, 'RECOVERING', 'RECONNECT_CLOSED_TRANSPORT');
        const writeDrain = captureWriteDrain(actor, 'CONNECTION_RETIRED');
        actor.controller.abort(problem('CONNECTION_RETIRED', '旧连接已撤销，准备读取新官服事实'));
        notifyStopped(actor);
        if (!await closeTransport(actor)) throw problem('SUBJECT_SESSION_CLEANUP_REQUIRED', '旧连接尚未确认结束，本次不重连');
        if (!await writeDrainComplete(writeDrain)) throw problem('WRITE_DRAIN_UNCONFIRMED', '旧写入持久收尾尚未确认，本次不重连');
        transaction(() => {
          const latest = intent(ownerRef, accountRef);
          if (latest?.desired_running !== 1 || latest.run_epoch !== expectedRunEpoch || latest.connection_epoch !== actor.connectionEpoch ||
              actors.get(key) !== actor || !ownsSubject(actor)) throw problem('RUN_INTENT_REVOKED', '重连等待期间运行意愿或执行权已变化');
          run('UPDATE backend_subject_owners SET active=0,updated_at=? WHERE subject_ref=? AND owner_ref=? AND executor_ref=? AND owner_epoch=?', nowIso(), actor.subjectRef, ownerRef, executorRef, actor.ownerEpoch);
          if (actors.get(key) === actor) actors.delete(key);
          if (replacement?.actor === actor) {
            // The old execution is physically closed and its owner is now
            // inactive. Persist this narrow ready phase in the same retirement
            // transaction, so a process exit before performStart does not leave
            // cleanup_pending waiting for an already-inactive old executor.
            const saved = recovery(ownerRef, accountRef);
            saveRecovery({ ...actor, status: 'scheduled', attempt: Number(saved?.attempt || 0), retryAtMs: deviceNow(),
              reasonCode: 'SESSION_SNAPSHOT_REFRESH_READY', error: { code: 'SESSION_SNAPSHOT_REFRESH_READY', transportFailure: true },
              closeEvidenceRef: actor.closeEvidenceRef });
          }
        });
        return performStart({ ownerRef, accountRef, commandId, expectedRunEpoch, expectedPriorRunEpoch,
          expectedLogin: replacement?.expectedLogin ?? null });
      })().finally(() => { if (pending.get(key) === reconnect) pending.delete(key); pendingSettled(ownerRef, accountRef); });
      pending.set(key, reconnect); return reconnect;
    }
    const flight = performStart({ ownerRef, accountRef, commandId, expectedPriorRunEpoch })
      .finally(() => { if (pending.get(key) === flight) pending.delete(key); pendingSettled(ownerRef, accountRef); });
    pending.set(key, flight); return flight;
  }
  function drainReady(actor) {
    const activity = readWriteActivity({ subjectRef: actor.subjectRef });
    if (!activity || typeof activity.then === 'function' || activity.inFlight !== false) return false;
    if (get('SELECT 1 FROM backend_operations WHERE subject_ref=? AND write_slot=1 LIMIT 1', actor.subjectRef) ||
        get('SELECT 1 FROM backend_session_verification_leases WHERE subject_ref=? AND active=1 LIMIT 1', actor.subjectRef) ||
        actor.verificationPromise || actor.verificationLease || actor.snapshotRefresh || actor.refreshPromise || actor.recoveryPromise) return false;
    return true;
  }
  async function stop({ ownerRef, accountRef, commandId = newId(), reasonCode = 'USER_STOPPED', preserveDesired = false }) {
    accountRef = String(accountRef); requireText(ownerRef, 'ownerRef'); requireText(commandId, 'commandId');
    const desiredAfter = preserveDesired ? 1 : 0, receiptKind = preserveDesired ? 'suspend' : 'stop';
    const priorReceipt = commandReceipt(ownerRef, commandId, accountRef, receiptKind);
    if (priorReceipt?.cleanupComplete) return priorReceipt;
    const priorIntent = intent(ownerRef, accountRef);
    if (priorReceipt?.stopEpoch && (priorIntent?.run_epoch !== priorReceipt.stopEpoch || priorIntent.desired_running !== desiredAfter)) {
      return { ...priorReceipt, cleanupComplete: false, superseded: true, account: project(ownerRef, accountRef) };
    }
    cancelRecoveryTimer(ownerRef, accountRef);
    const bound = binding(ownerRef, accountRef), key = keyOf(ownerRef, accountRef), actor = actors.get(key);
    const startFlight = pending.get(key), verificationFlight = actor?.verificationPromise, refreshFlight = actor?.refreshPromise;
    if (actor?.verificationResumeHandle) { clearImmediate(actor.verificationResumeHandle); actor.verificationResumeHandle = null; }
    const subjectActor = bySubject(bound.subject_ref);
    const subjectOwner = get('SELECT * FROM backend_subject_owners WHERE subject_ref=?', bound.subject_ref);
    // Stopping an old account alias/owner must not revoke the current alias or
    // another software owner's executor of this same game subject.
    const persistedOwner = subjectOwner?.owner_ref === ownerRef && (!subjectActor || subjectActor === actor) ? subjectOwner : null;
    // No await before the durable stop and revocation event. All send fences read
    // these exact epochs; timers and old callbacks cannot re-grant this intent.
    const stopEpoch = transaction(() => {
      const previous = intent(ownerRef, accountRef);
      if (priorReceipt?.stopEpoch) return priorReceipt.stopEpoch;
      if (preserveDesired && previous?.desired_running !== 1) return null;
      run(`INSERT INTO backend_run_intents VALUES(?,?,?,?,?,?,'STOPPING',?,?,NULL,?) ON CONFLICT(owner_ref,account_ref)
        DO UPDATE SET desired_running=excluded.desired_running,run_epoch=backend_run_intents.run_epoch+1,state='STOPPING',reason_code=excluded.reason_code,
        command_id=excluded.command_id,retry_at_ms=NULL,updated_at=excluded.updated_at`, ownerRef, accountRef, bound.subject_ref,
        desiredAfter, Number(previous?.run_epoch || 0) + 1, Number(previous?.connection_epoch || 0), reasonCode, commandId, nowIso());
      appendOutbox?.({ ownerRef, subjectRef: bound.subject_ref, type: preserveDesired ? 'OwnerSuspended' : 'StopRequested', payload: { accountRef, commandId, reasonCode } });
      const epoch = intent(ownerRef, accountRef).run_epoch;
      const saved = recovery(ownerRef, accountRef);
      saveRecovery({ ownerRef, accountRef, subjectRef: bound.subject_ref, status: preserveDesired ? 'suspended' : 'stopped', attempt: Number(saved?.attempt || 0),
        runEpoch: epoch, connectionEpoch: Number(previous?.connection_epoch || 0), retryAtMs: null,
        reasonCode, error: {}, closeEvidenceRef: saved?.close_evidence_ref });
      saveReceipt(ownerRef, commandId, accountRef, receiptKind, { stopCommitted: true, suspended: preserveDesired,
        newWritesFenced: true, transportClosed: false, cleanupComplete: false, stopEpoch: epoch });
      return epoch;
    });
    if (stopEpoch === null) return { stopCommitted: true, suspended: true, cleanupComplete: true, superseded: true,
      desiredPreserved: false, account: project(ownerRef, accountRef) };
    const writeDrain = captureWriteDrain(actor, reasonCode);
    actor?.controller.abort(problem('RUN_INTENT_REVOKED', '运行意愿已停止'));
    let hookComplete = true;
    try { notifyStopped(actor); } catch { hookComplete = false; }
    let timer;
    let closed = false;
    try {
      const cleanup = (async () => {
        if (actor?.connection && !await closeTransport(actor)) return false;
        if (verificationFlight) await verificationFlight.catch(() => {});
        if (refreshFlight) await refreshFlight.catch(() => {});
        if (startFlight) await startFlight.catch(() => {});
        if (actor && !actor.connection && !await closeTransport(actor)) return false;
        // A timed-out cleanup keeps running. It can only touch actors from
        // before its captured stop epoch, never a later explicit start.
        const latestActor = actors.get(key);
        if (latestActor && latestActor.runEpoch >= stopEpoch) return false;
        if (latestActor && !await closeTransport(latestActor)) return false;
        if (!await writeDrainComplete(writeDrain)) return false;
        if (latestActor && latestActor !== actor && !await writeDrainComplete(captureWriteDrain(latestActor, reasonCode))) return false;
        if (!actor && !latestActor && persistedOwner?.active === 1 && persistedOwner.executor_ref === executorRef) return false;
        if (persistedOwner?.active === 1 && persistedOwner.executor_ref !== executorRef) {
          const latestOwner = get('SELECT * FROM backend_subject_owners WHERE subject_ref=?', bound.subject_ref);
          if (!sameOwner(latestOwner, persistedOwner)) return false;
          const proof = await isolatePreviousExecutor({ ownerRef, accountRef, subjectRef: bound.subject_ref,
            previousOwner: persistedOwner, executorRef, purpose: 'stop-only' });
          return proof?.isolated === true && proof.subjectRef === bound.subject_ref && Boolean(proof.evidenceRef && proof.sourceRef);
        }
        return true;
      })();
      closed = await Promise.race([cleanup, new Promise(resolve => { timer = setTimeout(() => resolve(false), cleanupTimeoutMs); })]);
    } catch { closed = false; }
    finally { clearTimeout(timer); }
    let cleanupComplete = false;
    if (closed && hookComplete) cleanupComplete = transaction(() => {
      const latest = intent(ownerRef, accountRef);
      if (latest?.run_epoch !== stopEpoch || latest.desired_running !== desiredAfter) return false;
      const latestActor = actors.get(key);
      if (latestActor && latestActor.runEpoch >= stopEpoch) return false;
      run("UPDATE backend_run_intents SET state=?,updated_at=? WHERE owner_ref=? AND account_ref=? AND desired_running=? AND run_epoch=?",
        preserveDesired ? 'SUSPENDED' : 'STOPPED', nowIso(), ownerRef, accountRef, desiredAfter, stopEpoch);
      if (persistedOwner) run('UPDATE backend_subject_owners SET active=0,updated_at=? WHERE subject_ref=? AND owner_ref=? AND executor_ref=? AND owner_epoch=?',
        nowIso(), bound.subject_ref, ownerRef, persistedOwner.executor_ref, persistedOwner.owner_epoch);
      if (latestActor) actors.delete(key);
      return true;
    });
    return saveReceipt(ownerRef, commandId, accountRef, receiptKind, { stopCommitted: true, suspended: preserveDesired, newWritesFenced: true,
      transportClosed: closed, cleanupComplete, stopEpoch, superseded: intent(ownerRef, accountRef)?.run_epoch !== stopEpoch,
      inFlightOutcome: 'preserved-in-ledger', writeDrainCaptured: writeDrain.captured === true,
      writeDrainComplete: cleanupComplete, account: project(ownerRef, accountRef) });
  }
  function shutdownForRestart({ timeoutMs = cleanupTimeoutMs } = {}) {
    if (restartShutdownPromise) return restartShutdownPromise;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
      return Promise.reject(problem('ENGINE_RESTART_TIMEOUT_INVALID', '执行器重启收尾期限无效', 400));
    }
    shuttingDown = true;
    clearInterval(recoverySweepTimer);
    for (const [key, timer] of recoveryTimers) { clearTimeout(timer); recoveryTimers.delete(key); recoveryDeadlines.delete(key); }
    const capturedActors = [...actors.values()];
    transaction(() => {
      for (const actor of capturedActors) run(`UPDATE backend_run_intents SET state='RECOVERING',reason_code='ENGINE_RESTART_CLEANUP',retry_at_ms=NULL,updated_at=?
        WHERE owner_ref=? AND account_ref=? AND subject_ref=? AND desired_running=1 AND run_epoch=? AND connection_epoch=?`,
      nowIso(), actor.ownerRef, String(actor.accountRef), actor.subjectRef, actor.runEpoch, actor.connectionEpoch);
    });
    restartShutdownPromise = (async () => {
      let cleanupComplete = true;
      const results = await Promise.allSettled(capturedActors.map(async actor => {
        const key = keyOf(actor.ownerRef, actor.accountRef), context = actorContext(actor), deadline = monotonicNow() + timeoutMs;
        const expected = intent(actor.ownerRef, actor.accountRef);
        if (expected?.desired_running !== 1 || expected.run_epoch !== actor.runEpoch || expected.connection_epoch !== actor.connectionEpoch) return;
        const failure = Object.assign(problem('ENGINE_RESTARTING', '执行器正在退出，原写入进入正常收尾'), { transportFailure: true });
        // Do not revoke an already-consumed permit during an executor restart.
        // Gateway admission is fenced synchronously by shuttingDown; an
        // existing flight remains current until its answer and post-read settle.
        const ticket = actor.writeDrainTicket || { captured: false, completion: Promise.resolve({ durableOutcome: true }) };
        let quiesce;
        try { quiesce = Promise.resolve(quiesceScheduling(context)); }
        catch { quiesce = Promise.resolve({ quiesced: false }); }
        const startFlight = pending.get(key);
        const remaining = () => Math.max(0, deadline - monotonicNow());
        const bounded = async promise => {
          let timer;
          try { return await Promise.race([Promise.resolve(promise).then(value => ({ settled: true, value }), () => ({ settled: true, value: null })),
            new Promise(resolve => { timer = setTimeout(() => resolve({ settled: false, value: null }), remaining()); })]); }
          finally { clearTimeout(timer); }
        };
        const initial = await Promise.all([bounded(quiesce), bounded(writeDrainComplete(ticket))]);
        let drained = initial[0].settled && initial[0].value?.quiesced === true && initial[1].settled && initial[1].value === true;
        if (actors.get(key) !== actor) {
          const latest = intent(actor.ownerRef, actor.accountRef), saved = recovery(actor.ownerRef, actor.accountRef);
          if (latest?.desired_running === 0 || latest?.desired_running === 1 && latest.run_epoch === actor.runEpoch &&
              saved?.status === 'cleanup_pending' && saved.reason_code === 'ENGINE_RESTARTED' && initial[1].value === true) return;
          cleanupComplete = false; return;
        }
        while (drained && monotonicNow() < deadline && !drainReady(actor)) await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining())));
        drained = drained && drainReady(actor) && (!actor.writeDrainTicket || actor.writeDrainTicket === ticket);
        if (!drained) { cleanupComplete = false; return; }
        // Now no gateway flight, write slot, or verification lease can depend
        // on this actor remaining current. Abort any remaining login/read work
        // and let its pending start path finish before taking the close proof.
        actor.controller.abort(failure);
        if (startFlight) {
          const start = await bounded(startFlight);
          if (!start.settled) { cleanupComplete = false; return; }
          if (actors.get(key) !== actor) {
            const latest = intent(actor.ownerRef, actor.accountRef), saved = recovery(actor.ownerRef, actor.accountRef);
            if (latest?.desired_running === 0 || latest?.desired_running === 1 && latest.run_epoch === actor.runEpoch &&
                saved?.status === 'cleanup_pending' && saved.reason_code === 'ENGINE_RESTARTED' && initial[1].value === true) return;
            cleanupComplete = false; return;
          }
          while (monotonicNow() < deadline && !drainReady(actor)) await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining())));
          if (!drainReady(actor)) { cleanupComplete = false; return; }
        }
        try { notifyStopped(actor); } catch { cleanupComplete = false; return; }
        let closed = !actor.connection && (!actor.connectAttempted || actor.connectRejectedClosed);
        if (actor.connection) {
          try { closed = await bounded(closeTransport(actor)).then(result => result.settled && result.value === true); }
          catch { closed = false; }
        }
        if (!closed) { cleanupComplete = false; return; }
        transaction(() => {
          const latest = intent(actor.ownerRef, actor.accountRef);
          if (actors.get(key) !== actor || latest?.desired_running !== 1 || latest.run_epoch !== actor.runEpoch ||
              latest.connection_epoch !== actor.connectionEpoch) throw problem('ENGINE_RESTART_INTENT_CHANGED', '重启收尾期间运行意愿已改变', 409);
          const saved = recovery(actor.ownerRef, actor.accountRef);
          saveRecovery({ ...actor, status: 'cleanup_pending', attempt: 0, retryAtMs: deviceNow(),
            reasonCode: 'ENGINE_RESTARTED', error: { code: 'ENGINE_RESTARTED', transportFailure: true,
              connectAttempted: actor.connectAttempted }, closeEvidenceRef: actor.closeEvidenceRef });
          run(`UPDATE backend_run_intents SET state='WAITING_LOGIN',reason_code='ENGINE_RESTARTED',retry_at_ms=NULL,updated_at=?
            WHERE owner_ref=? AND account_ref=? AND subject_ref=? AND desired_running=1 AND run_epoch=? AND connection_epoch=?`,
          nowIso(), actor.ownerRef, String(actor.accountRef), actor.subjectRef, actor.runEpoch, actor.connectionEpoch);
          if (actors.get(key) === actor) actors.delete(key);
          return saved;
        });
      }));
      if (results.some(result => result.status === 'rejected')) cleanupComplete = false;
      return { cleanupComplete, desiredIntentsPreserved: true, actorsCaptured: capturedActors.length };
    })();
    return restartShutdownPromise;
  }
  function project(ownerRef, accountRef) {
    const row = intent(ownerRef, accountRef);
    const actor = actors.get(keyOf(ownerRef, accountRef));
    const saved = recovery(ownerRef, accountRef);
    const lifecycle = row?.state === 'OFFICIAL_HOST' ? 'WAITING_LOGIN' : row?.state || 'STOPPED';
    const cooldown = cooldownEntry(ownerRef, accountRef).merged;
    return { state: PUBLIC_STATE[lifecycle], lifecycle, desiredRunning: row?.desired_running === 1,
      runEpoch: row?.run_epoch ?? 0, connectionEpoch: row?.connection_epoch ?? 0,
      reasonCode: row?.reason_code ?? null, retryAtMs: row?.retry_at_ms ?? null,
      recovery: saved ? { state: saved.status, attempt: saved.attempt, maxAttempts: null,
        retryAtMs: saved.retry_at_ms, reasonCode: saved.reason_code, closeEvidenceRef: saved.close_evidence_ref } : null,
      cooldown: cooldown ? { conflictStreak: cooldown.conflict_streak, untilMs: cooldown.cooldown_until_ms,
        remainingMs: Math.max(0, Number(cooldown.cooldown_until_ms) - deviceNow()), lastSource: cooldown.last_source,
        lastCode: cooldown.last_code, lastConnectedMs: cooldown.last_connected_ms,
        confirmedStableMs: cooldown.stable_connected_ms } : null,
      connected: Boolean(actor && connectionCurrent(actor) && actor.connection?.isOpen()) };
  }
  function isConnectionCurrent(subjectRef, epoch) { const actor = bySubject(subjectRef); return Boolean(actor && actor.connectionEpoch === epoch && connectionCurrent(actor)); }
  function evidence(ownerRef, accountRef) {
    const bound = binding(ownerRef, accountRef);
    const held = get('SELECT owner_ref,executor_ref,owner_epoch,active FROM backend_subject_owners WHERE subject_ref=?', bound.subject_ref);
    return {
      owner: held?.owner_ref === ownerRef ? { executorRef: held.executor_ref, ownerEpoch: held.owner_epoch, active: held.active === 1 } : null,
      closures: all(`SELECT evidence_ref,executor_ref,owner_epoch,run_epoch,connection_epoch,proof_kind,proof_json,recorded_at
        FROM backend_session_connection_closures WHERE owner_ref=? AND account_ref=? AND subject_ref=? ORDER BY recorded_at DESC LIMIT 12`,
      ownerRef, String(accountRef), bound.subject_ref).map(row => ({ evidenceRef: row.evidence_ref, executorRef: row.executor_ref,
        ownerEpoch: row.owner_epoch, runEpoch: row.run_epoch, connectionEpoch: row.connection_epoch, proofKind: row.proof_kind,
        proof: parseStored(row.proof_json, '连接关闭证明'), recordedAt: row.recorded_at })),
      networkTransitions: all(`SELECT event_id,payload_json,recorded_at FROM backend_outbox
        WHERE owner_ref=? AND subject_ref=? AND event_type='NetworkChanged' ORDER BY event_id DESC LIMIT 12`, ownerRef, bound.subject_ref)
        .map(row => ({ eventId: row.event_id, ...parseStored(row.payload_json, '原生网络事件'), recordedAt: row.recorded_at })),
      nativeNetworkObservations: all(`SELECT observation_ref,native_source_instance,observation_sequence,payload_json,payload_fingerprint,recorded_at
        FROM backend_native_network_observations WHERE executor_ref=? ORDER BY observation_sequence DESC LIMIT 12`, executorRef).map(row => {
        const payload = parseStored(row.payload_json, '原生网络观察'), parsed = networkObservation(payload);
        return { observationRef: row.observation_ref, ...parsed.state, ...parsed.native, recordedAt: row.recorded_at,
          payloadFingerprint: row.payload_fingerprint, storedFingerprintVerified: fingerprint(payload) === row.payload_fingerprint &&
            row.native_source_instance === parsed.native?.nativeSourceInstance && row.observation_sequence === parsed.native?.observationSequence &&
            row.observation_ref === 'native-network-observation:' + fingerprint([executorRef, row.native_source_instance, row.observation_sequence]),
          receiptOnly: true, closeOrDrainEvidenceIncluded: false };
      }),
      snapshotRefreshes: all(`SELECT event_ref,refresh_ref,original_context_json,event_kind,receipt_json,recorded_at
        FROM backend_session_snapshot_refresh_events WHERE owner_ref=? AND account_ref=? AND subject_ref=? ORDER BY rowid DESC LIMIT 12`,
      ownerRef, String(accountRef), bound.subject_ref).map(row => ({ eventRef: row.event_ref, refreshRef: row.refresh_ref,
        originalContext: parseStored(row.original_context_json, '快照刷新原归属'), kind: row.event_kind,
        receipt: parseStored(row.receipt_json, '快照刷新回执'), recordedAt: row.recorded_at })),
    };
  }
  function context(subjectRef) {
    const actor = bySubject(subjectRef);
    if (!actor || !connectionCurrent(actor)) return null;
    const captured = actorContext(actor);
    return { ...actor, isCurrent: () => sameContext(actorContext(actor), captured) && connectionCurrent(actor) };
  }
  function resumeDesired(ownerRef, { reasonCode = 'PROCESS_RESTART_RESUME' } = {}) {
    requireText(ownerRef, 'ownerRef'); recoveryOwners.add(ownerRef);
    const receipts = [];
    if (shuttingDown) return { ownerRef, accounts: receipts, reasonCode: 'ENGINE_RESTARTING' };
    for (const row of all('SELECT * FROM backend_run_intents WHERE owner_ref=? AND desired_running=1', ownerRef)) {
      if (isAccountStopPending({ ownerRef, accountRef: String(row.account_ref), subjectRef: row.subject_ref }) === true) {
        receipts.push({ accountRef: row.account_ref, resumed: false, reasonCode: 'ACCOUNT_STOP_PENDING' }); continue;
      }
      const key = keyOf(ownerRef, row.account_ref);
      if (actors.has(key) || pending.has(key)) continue;
      let saved = recovery(ownerRef, row.account_ref);
      const savedFailure = saved ? parseStored(saved.error_json, '会话恢复依据') || {} : {};
      // A durable BLOCKED marker is a snapshot of the previous failure, not a
      // permanent user stop. Re-evaluate that evidence against the current
      // classifier only while the exact desired intent and subject generation
      // still match. Explicit STOP is represented by desired_running=0 and is
      // filtered by the query above.
      const blockedFailure = saved?.status === 'blocked' ? savedFailure
        : !saved && row.state === 'BLOCKED' ? { code: row.reason_code } : null;
      // A cleanup that could not prove physical close is isolated until the user
      // issues a new explicit START; a process restart is not new evidence.
      const blockedMayResume = !!blockedFailure && blockedFailure.isolationOnly !== true &&
        classifySessionFailure(blockedFailure).retryable === true &&
        (!saved || saved.subject_ref === row.subject_ref && saved.expected_run_epoch === row.run_epoch &&
          saved.expected_connection_epoch === row.connection_epoch);
      const previousOwner = saved?.status === 'cleanup_pending' ? get('SELECT * FROM backend_subject_owners WHERE subject_ref=?', row.subject_ref) : null;
      const interrupted = saved && ['cleanup_pending', 'exhausted'].includes(saved.status)
        ? parseStored(saved.error_json, '会话恢复依据') : null;
      const crashedCleanupMayResume = interrupted && retryable(interrupted) &&
        (previousOwner?.active === 1 && previousOwner.executor_ref !== executorRef || interrupted.connectAttempted === false);
      const retryableExhaustion = saved?.status === 'exhausted' && retryable(interrupted);
      if (saved && (saved.status === 'stopped' || saved.status === 'blocked' && !blockedMayResume ||
          saved.status === 'exhausted' && !retryableExhaustion ||
          saved.status === 'cleanup_pending' && !crashedCleanupMayResume) ||
          !saved && (row.state === 'STOPPING' || row.state === 'BLOCKED' && !blockedMayResume)) {
        receipts.push({ accountRef: row.account_ref, resumed: false, reasonCode: saved?.reason_code || row.reason_code }); continue;
      }
      saved = transaction(() => {
        const latest = intent(ownerRef, row.account_ref);
        if (latest?.desired_running !== 1 || latest.subject_ref !== row.subject_ref ||
            latest.run_epoch !== row.run_epoch || latest.connection_epoch !== row.connection_epoch) return null;
        // Preserve an absolute backoff from the interrupted process, and never
        // shorten a persisted failure-policy cooldown because the network came
        // back, the process restarted, or the user stopped then started again.
        const remainingMs = saved?.retry_at_ms !== null && saved?.retry_at_ms !== undefined
          ? Math.max(0, recoveryDeadline(saved) - monotonicNow()) : 0;
        const retryAtMs = deviceNow() + Math.max(remainingMs, cooldownRemaining(ownerRef, row.account_ref));
        const attempt = Math.max(0, Number(saved?.attempt || 0));
        const previousReason = saved && ['scheduled', 'waiting_network'].includes(saved.status) ? saved.reason_code
          : blockedMayResume ? (saved?.reason_code || row.reason_code || reasonCode) : reasonCode;
        saveRecovery({ ownerRef, accountRef: row.account_ref, subjectRef: row.subject_ref,
          status: network.online === false ? 'waiting_network' : 'scheduled',
          attempt, runEpoch: latest.run_epoch, connectionEpoch: latest.connection_epoch, retryAtMs,
          reasonCode: previousReason,
          error: saved ? parseStored(saved.error_json, '会话恢复依据') : {}, closeEvidenceRef: saved?.close_evidence_ref });
        run('UPDATE backend_run_intents SET state=?,retry_at_ms=?,reason_code=?,updated_at=? WHERE owner_ref=? AND account_ref=? AND desired_running=1 AND run_epoch=? AND connection_epoch=?',
          'WAITING_NETWORK', retryAtMs, previousReason, nowIso(),
          ownerRef, row.account_ref, latest.run_epoch, latest.connection_epoch);
        return recovery(ownerRef, row.account_ref);
      });
      if (saved) {
        armRecovery(saved);
        receipts.push({ accountRef: row.account_ref, resumed: ['scheduled', 'waiting_network'].includes(saved.status), retryAtMs: saved.retry_at_ms, attempt: saved.attempt });
      }
    }
    return { ownerRef, accounts: receipts };
  }
  function networkChanged(input) {
    const { state, native } = networkObservation(input), { online, transport } = state;
    const changed = network.online !== online || network.transport !== transport;
    const payload = native ? { ...state, ...native } : null;
    const payloadFingerprint = payload ? fingerprint(payload) : null;
    const observationRef = native ? 'native-network-observation:' + fingerprint([executorRef, native.nativeSourceInstance, native.observationSequence]) : null;
    const accepted = transaction(() => {
      const bound = get('SELECT * FROM backend_native_network_sources WHERE executor_ref=?', executorRef);
      if (!native && bound) throw problem('NATIVE_NETWORK_METADATA_REQUIRED', '本次原生网络来源已启用精确序号，不能由无序观察覆盖', 409);
      if (native) {
        if (bound && bound.native_source_instance !== native.nativeSourceInstance) {
          throw problem('NATIVE_NETWORK_SOURCE_CONFLICT', '当前执行器的原生网络来源实例不能被另一实例覆盖', 409);
        }
        if (bound) {
          const head = get(`SELECT observation_ref,payload_json,payload_fingerprint FROM backend_native_network_observations
            WHERE executor_ref=? AND native_source_instance=? AND observation_sequence=?`, executorRef, bound.native_source_instance, bound.last_sequence);
          const headPayload = head && parseStored(head.payload_json, '原生网络观察原序列');
          if (!positive(bound.last_sequence) || !head || !plainObject(headPayload) || fingerprint(headPayload) !== head.payload_fingerprint ||
              headPayload.nativeSourceInstance !== bound.native_source_instance || headPayload.observationSequence !== bound.last_sequence ||
              head.observation_ref !== 'native-network-observation:' + fingerprint([executorRef, bound.native_source_instance, bound.last_sequence])) {
            throw problem('NATIVE_NETWORK_SEQUENCE_UNPROVEN', '原生网络原序列与持久观察不一致，不能覆盖', 500);
          }
        }
        const prior = get(`SELECT * FROM backend_native_network_observations
          WHERE executor_ref=? AND native_source_instance=? AND observation_sequence=?`, executorRef, native.nativeSourceInstance, native.observationSequence);
        if (prior) {
          if (!bound) throw problem('NATIVE_NETWORK_SEQUENCE_UNPROVEN', '原生网络原观察缺少同执行器的来源绑定', 500);
          const original = parseStored(prior.payload_json, '原生网络原观察');
          if (prior.observation_ref !== observationRef || fingerprint(original) !== prior.payload_fingerprint ||
              prior.payload_fingerprint !== payloadFingerprint || canonical(original) !== canonical(payload)) {
            throw problem('NATIVE_NETWORK_SEQUENCE_CONFLICT', '同一原生网络序号的原观察不能改变', 409);
          }
          return { replayed: true, recordedAt: prior.recorded_at, currentObservationSequence: bound?.last_sequence ?? native.observationSequence };
        }
        if (bound && native.observationSequence <= bound.last_sequence) {
          throw problem('NATIVE_NETWORK_OBSERVATION_OUT_OF_ORDER', '未记录的旧网络观察不能倒序覆盖当前事实', 409);
        }
      }
      const recordedAt = nowIso();
      if (native) {
        run(`INSERT INTO backend_native_network_observations(observation_ref,executor_ref,native_source_instance,observation_sequence,payload_json,payload_fingerprint,recorded_at)
          VALUES(?,?,?,?,?,?,?)`, observationRef, executorRef, native.nativeSourceInstance, native.observationSequence, canonical(payload), payloadFingerprint, recordedAt);
        run(`INSERT INTO backend_native_network_sources(executor_ref,native_source_instance,last_sequence,created_at,updated_at) VALUES(?,?,?,?,?)
          ON CONFLICT(executor_ref) DO UPDATE SET last_sequence=excluded.last_sequence,updated_at=excluded.updated_at`,
        executorRef, native.nativeSourceInstance, native.observationSequence, recordedAt, recordedAt);
      }
      if (changed || native) run(`INSERT INTO backend_session_network_state VALUES(1,?,?,?) ON CONFLICT(singleton)
        DO UPDATE SET online=excluded.online,transport=excluded.transport,observed_at=excluded.observed_at`, Number(online), transport, recordedAt);
      if (changed) for (const ownerRef of recoveryOwners) for (const row of all('SELECT account_ref,subject_ref,run_epoch,connection_epoch FROM backend_run_intents WHERE owner_ref=? AND desired_running=1', ownerRef)) {
        appendOutbox?.({ ownerRef, subjectRef: row.subject_ref, type: 'NetworkChanged',
          payload: { online, transport, source: 'native-network-event', runEpoch: row.run_epoch, connectionEpoch: row.connection_epoch,
            nativeMetadataProvided: !!native, ...(native ? { ...native, nativeObservationRef: observationRef, nativeObservationFingerprint: payloadFingerprint } : {}) } });
      }
      return { replayed: false, recordedAt, currentObservationSequence: native?.observationSequence ?? null };
    });
    const receipt = (retiring = 0) => freeze({ version: 'native-network-observation-commit/v1',
      changed: !accepted.replayed && changed, online: network.online, transport: network.transport,
      committed: true, replayed: accepted.replayed, nativeMetadataProvided: !!native,
      ...(native ? { nativeSourceInstance: native.nativeSourceInstance, observationSequence: native.observationSequence,
        observationRef, payloadFingerprint, currentObservationSequence: accepted.currentObservationSequence } : {}),
      recordedAt: accepted.recordedAt, retiring, cleanup: 'separate-supervisor-physical-close-and-write-drain', closeOrDrainEvidenceIncluded: false });
    // A replay ACK proves its original intake, not permission to restore an
    // older online value after a later sequence. No game request is replayed.
    if (accepted.replayed) return receipt();
    network.online = online; network.transport = transport;
    if (!changed) return receipt();
    const retiring = [];
    if (!online) {
      for (const ownerRef of recoveryOwners) for (const saved of all('SELECT * FROM backend_session_recovery WHERE owner_ref=?', ownerRef)) cancelRecoveryTimer(ownerRef, saved.account_ref);
      for (const actor of actors.values()) {
        if (!sameRecoveryIntent(actor)) continue;
        const error = Object.assign(problem('NATIVE_NETWORK_OFFLINE', '当前原生网络事实为离线'), { transportFailure: true });
        const activeVerification = actor.verificationLease;
        if (activeVerification) activeVerification.failureError = error;
        // Fence synchronously before the fast commit ACK. A pending start or
        // previous cleanup must not leave old scheduling/writes live while its
        // asynchronous physical close and exact original drain finish.
        actor.offlineRecoveryRequested = true;
        captureWriteDrain(actor, 'NATIVE_NETWORK_OFFLINE');
        actor.controller.abort(error);
        try { notifyStopped(actor); } catch { /* The original drain and STOP retain cleanup ownership. */ }
        if (!activeVerification && actor.startComplete) retiring.push(requestAutomaticRecovery(actor, error));
      }
    } else {
      for (const ownerRef of recoveryOwners) resumeDesired(ownerRef, { reasonCode: 'NATIVE_NETWORK_RESTORED' });
    }
    // Intake ACK never asserts closure or durable settlement. The same existing
    // recovery promises/tickets remain visible to STOP and preserve unknowns.
    void Promise.allSettled(retiring);
    return receipt(retiring.length);
  }
  async function stopAll(ownerRef, reasonCode = 'USER_STOPPED_ALL') {
    recoveryOwners.delete(ownerRef);
    for (const saved of all('SELECT account_ref FROM backend_session_recovery WHERE owner_ref=?', ownerRef)) cancelRecoveryTimer(ownerRef, saved.account_ref);
    const rows = all('SELECT account_ref FROM backend_subject_bindings WHERE owner_ref=?', ownerRef);
    const results = await Promise.allSettled(rows.map(row => stop({ ownerRef, accountRef: row.account_ref, reasonCode })));
    const runningCount = [...actors.values()].filter(actor => actor.ownerRef === ownerRef).length;
    const ok = results.every(result => result.status === 'fulfilled' && result.value.cleanupComplete) && runningCount === 0 &&
      !get('SELECT 1 FROM backend_subject_owners WHERE owner_ref=? AND active=1 LIMIT 1', ownerRef);
    return { ok, stopCommitted: results.every(result => result.status === 'fulfilled' && result.value.stopCommitted),
      cleanupComplete: ok, runningCount, unconfirmed: !ok };
  }
  async function suspendOwner(ownerRef, reasonCode = 'OWNER_AUTHORIZATION_WAIT') {
    requireText(ownerRef, 'ownerRef');
    recoveryOwners.delete(ownerRef);
    for (const saved of all('SELECT account_ref FROM backend_session_recovery WHERE owner_ref=?', ownerRef)) cancelRecoveryTimer(ownerRef, saved.account_ref);
    const rows = all(`SELECT b.account_ref FROM backend_subject_bindings b JOIN backend_run_intents r
      ON r.owner_ref=b.owner_ref AND r.account_ref=b.account_ref WHERE b.owner_ref=? AND r.desired_running=1
      AND (r.state<>'SUSPENDED' OR r.reason_code<>?)`, ownerRef, reasonCode);
    const results = await Promise.allSettled(rows.map(row => stop({ ownerRef, accountRef: row.account_ref,
      reasonCode, preserveDesired: true })));
    const runningCount = [...actors.values()].filter(actor => actor.ownerRef === ownerRef).length;
    const ok = results.every(result => result.status === 'fulfilled' && result.value.cleanupComplete) && runningCount === 0 &&
      !get('SELECT 1 FROM backend_subject_owners WHERE owner_ref=? AND active=1 LIMIT 1', ownerRef);
    return { ok, stopCommitted: results.every(result => result.status === 'fulfilled' && result.value.stopCommitted),
      cleanupComplete: ok, suspended: true, runningCount, unconfirmed: !ok };
  }
  return Object.freeze({ bind, binding, intent, preflightStart, start, stop, stopAll, suspendOwner, project, context, isConnectionCurrent, evidence, networkChanged, resumeDesired,
    readSnapshotAfterClose, validateReadSnapshotLease, releaseReadSnapshotLease, retireRecoveredVerificationLeases, verificationLease, refreshCurrent,
    isShuttingDown, holdForProcessRestart, shutdownForRestart, executorRef, recoverStalledSchedulerStage, sweepDueRecoveries,
    healthSnapshot });
}
