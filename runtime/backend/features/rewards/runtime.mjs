import { canonical, fingerprint, freeze, newId } from '../../common.mjs';
import { CARD_BY_FEATURE, CONFIG_ENABLED, GUILD_BUILD_ROWS, REWARD_METHODS, SHARE_IDS } from './catalog.mjs';
import { claimContract, claimPostRead, rewardTargetVerification } from './rpc-contract.mjs';
import { classifyOfficialRefusal, REFUSAL_BACKOFF_MS, REJECTION_STATES } from './rejection.mjs';

const VERSION = 'rewards/1';
// Bumped only when the hold-scope derivation changes. A row is examined exactly
// once per version, so a legitimately NULL scope cannot make the batch query
// select it again forever.
const SCOPE_VERSION = 1;
const AXES = ['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch'];
const exactContext = context => Boolean(context) && AXES.every(key => key === 'accountRef'
  ? typeof context[key] === 'string' : Number.isSafeInteger(context[key]) || typeof context[key] === 'string');
const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const nonNegative = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const dayMs = 86400000;
const shanghai = ms => Math.floor((ms + 8 * 3600000) / dayMs);
const itemIdOf = value => typeof value === 'string' && /^item:(\d+)$/.test(value) ? Number(value.slice(5)) : null;
const goldItem = id => id === 11;

function tableRow(tables, name, key) {
  const table = tables?.[name];
  if (!table || !Object.hasOwn(table, String(key))) return null;
  return table[String(key)];
}

export function createRewardRuntime({ store, facts, clock, officialDay, extensionForContext, tablesForContext, dynamicState,
  ledgerView, resources, isCurrent, readConfiguration, readProfile, readBag, appendOutbox = () => {},
  reportBasisMismatch = null } = {}) {
  for (const fn of [store?.run, store?.get, store?.all, store?.transaction, facts?.read, clock, officialDay, extensionForContext,
    tablesForContext, dynamicState?.snapshot, ledgerView?.currentAdmission, resources?.balance, isCurrent, readConfiguration])
    if (typeof fn !== 'function') throw new TypeError('Reward runtime is missing a bounded shared port');
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_reward_claims(
    owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,feature_id TEXT NOT NULL,claim_key TEXT NOT NULL,period_key TEXT NOT NULL,
    state TEXT NOT NULL,operation_id TEXT NOT NULL,params_json TEXT NOT NULL,before_json TEXT NOT NULL,updated_at TEXT NOT NULL,
    PRIMARY KEY(owner_ref,subject_ref,feature_id,claim_key));
    CREATE TRIGGER IF NOT EXISTS backend_reward_claims_no_delete BEFORE DELETE ON backend_reward_claims
      BEGIN SELECT RAISE(ABORT,'reward claim history is retained'); END;
    CREATE TABLE IF NOT EXISTS backend_reward_period_usage(
      owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,feature_id TEXT NOT NULL,quota_key TEXT NOT NULL,period_key TEXT NOT NULL,
      used INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref,feature_id,quota_key,period_key));
    CREATE TRIGGER IF NOT EXISTS backend_reward_period_usage_no_delete BEFORE DELETE ON backend_reward_period_usage
      BEGIN SELECT RAISE(ABORT,'reward period usage is retained'); END;
    CREATE TABLE IF NOT EXISTS backend_reward_usage_charges(
      operation_id TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,feature_id TEXT NOT NULL,
      quota_key TEXT NOT NULL,period_key TEXT NOT NULL,charged_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS backend_reward_usage_charges_no_delete BEFORE DELETE ON backend_reward_usage_charges
      BEGIN SELECT RAISE(ABORT,'reward usage charges are retained'); END;
    CREATE TABLE IF NOT EXISTS backend_reward_claim_migrations(
      migration_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,feature_id TEXT NOT NULL,
      claim_key TEXT NOT NULL,from_state TEXT NOT NULL,to_state TEXT NOT NULL,attempt INTEGER NOT NULL,
      reason_code TEXT NOT NULL,migrated_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS backend_reward_claim_migrations_no_delete BEFORE DELETE ON backend_reward_claim_migrations
      BEGIN SELECT RAISE(ABORT,'reward claim migration receipts are retained'); END;
    CREATE TABLE IF NOT EXISTS backend_reward_reconciliations(
      owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,feature_id TEXT NOT NULL,
      checked_at TEXT NOT NULL,outcome TEXT NOT NULL,detail_json TEXT NOT NULL,
      PRIMARY KEY(owner_ref,subject_ref,feature_id));`);
  const { get, run, transaction, nowIso } = store;
  for (const [name, definition] of [['quota_key', 'TEXT'], ['attempt', 'INTEGER NOT NULL DEFAULT 1'], ['hold_scope', 'TEXT'],
    ['achieved_ref', 'TEXT'], ['achieved_at', 'TEXT'], ['scope_version', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!store.all('PRAGMA table_info(backend_reward_claims)').some(column => column.name === name)) {
      run(`ALTER TABLE backend_reward_claims ADD COLUMN ${name} ${definition}`);
    }
  }
  run(`CREATE INDEX IF NOT EXISTS backend_reward_claims_by_hold_scope
    ON backend_reward_claims(owner_ref,subject_ref,feature_id,hold_scope)`);
  run(`CREATE TABLE IF NOT EXISTS backend_reward_reconcile_cursors(
    owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,feature_id TEXT NOT NULL,last_claim_key TEXT NOT NULL,
    updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref,feature_id))`);

  const clockFor = context => {
    const value = clock(context.subjectRef);
    return value?.available === true && value.connectionEpoch === context.connectionEpoch && Number.isSafeInteger(value.nowMs)
      ? value : null;
  };
  const dayFor = context => {
    const day = officialDay(context);
    return day?.current === true && typeof day.key === 'string' && Number.isSafeInteger(day.startMs) && Number.isSafeInteger(day.endMs) &&
      day.startMs < day.endMs ? day : null;
  };
  function stateFor(context) {
    const currentFacts = facts.read(context);
    if (currentFacts?.current !== true) return null;
    const identity = extensionForContext(context), day = dayFor(context), clockState = clockFor(context), tables = tablesForContext(context);
    if (!identity?.loginResponseRef || !identity.bundleRef || !day || !clockState) return null;
    const profile = readProfile?.(context) || null, bag = readBag?.(context) || null;
    const officialUid = positive(profile?.uid);
    return { facts: currentFacts, values: currentFacts.values, sources: currentFacts.sources, identity, day, clock: clockState,
      tables: tables?.tables ?? null, tableHashes: tables?.tableHashes ?? null, dataSnapshotId: tables?.dataSnapshotId ?? null,
      profile, bag, officialUid };
  }
  const sourceRefOf = (state, domain) => state.sources[domain]?.responseRef || state.identity.loginResponseRef;
  const extensionRefOf = state => 'reward-tables:' + fingerprint({ bundleRef: state.identity.bundleRef,
    dataSnapshotId: state.dataSnapshotId, tableHashes: state.tableHashes });
  function factBasisFor(context, state, domains = null) {
    if (!isCurrent(context)) return { current: false, reasonCode: 'REWARD_CONTEXT_NOT_CURRENT' };
    if (!state) return { current: false, reasonCode: 'REWARD_FACTS_NOT_CURRENT' };
    const scope = Array.isArray(domains) && domains.length
      ? Object.fromEntries(Object.entries(state.values).filter(([domain]) => domains.includes(domain))) : state.values;
    const scopeSources = Array.isArray(domains) && domains.length
      ? Object.fromEntries(Object.entries(state.sources).filter(([domain]) => domains.includes(domain))) : state.sources;
    return freeze({ current: true, version: VERSION, context: Object.fromEntries(AXES.map(key => [key, context[key]])),
      values: scope, sources: scopeSources, identity: { bundleRef: state.identity.bundleRef,
        loginResponseRef: state.identity.loginResponseRef, dataSnapshotId: state.dataSnapshotId },
      tableHashes: state.tableHashes, day: { key: state.day.key, startMs: state.day.startMs, endMs: state.day.endMs } });
  }

  // R10 fix: an unresolved reward write is never released by elapsed local
  // time. Only these states exist for it:
  //   unknown-held    - sent (or possibly sent), business result unproven. Blocks
  //                     the exact official opportunity and, where the action can
  //                     still target a later official period, its hold scope.
  //   unknown-achieved- a later official observation, causally after the write,
  //                     proves the target already reached. Resend is pointless
  //                     and the claim is never credited as this operation's win.
  //   confirmed       - the write's own bounded post-read proved the effect.
  //   rejected-consumed - the official answer for this exact wire request stated
  //                     the target was already obtained (official text table).
  //                     Nothing was credited, the target is closed for good.
  //   rejected-refused - the official answer stated a precondition of this same
  //                     action failed. Nothing was spent and no quota is charged;
  //                     the exact target waits a bounded backoff before a new try.
  // A protocol-proven not-sent operation never reaches this table at all: the
  // gateway settles it through the shared immutable non-send proof.
  const HOLD_STATES = Object.freeze(['unknown-held', 'unknown-retired']);
  const REJECTION_STATE_LIST = Object.freeze(Object.values(REJECTION_STATES));
  // One map from claim action to the dynamic fact domain that carries its
  // post-state, so an achieved reconciliation can bind source and ordering.
  const CLAIM_DOMAIN = Object.freeze({
    pick: 'reward-mail', draw: 'reward-box', recv: 'reward-tasks', 'free-gift': 'reward-giftbag',
    renew: 'reward-double', 'double-coin': 'reward-double', unlock: 'reward-story', 'guild-harvest': 'reward-guild', 'guild-plant': 'reward-guild',
    'guild-unlock': 'reward-guild', 'guild-upgrade': 'reward-guild', 'guild-build-video': 'reward-guild',
    'guild-build-gold': 'reward-guild', 'guild-build-yuanbao': 'reward-guild', upgrade: 'reward-cultivate', buy: 'reward-shop',
    refresh: 'reward-shop',
  });
  // Actions whose claim key embeds the official period while the wire request is
  // period-agnostic: a late request could act on the next period, so the hold
  // must follow the action target, not only the period-scoped claim key. The
  // target is the wire-visible entity, never a local day/generation: a late
  // free-gift share still hits the same gift-bag shop row on the next day, and a
  // late shop purchase still hits the same shelf slot after a refresh re-rolls
  // it, so neither may be re-sent as if the new period made it a new request.
  function holdScopeFor(featureId, claimKey) {
    const key = String(claimKey || '');
    switch (featureId) {
      case 'reward.daily-task':
      case 'reward.weekly-task':
      case 'reward.main-task': {
        const match = /^(?:daily|weekly|main):(\d+):/.exec(key);
        return match ? 'task:' + match[1] : null;
      }
      case 'reward.daily-box': {
        const match = /^dbox:(\d+):/.exec(key);
        return match ? 'box:' + match[1] : null;
      }
      case 'guild.build.video': return /^guild-video:\d+:/.test(key) ? 'build:1' : null;
      case 'guild.build.gold': return /^guild-gold:\d+:/.test(key) ? 'build:2' : null;
      case 'guild.build.yuanbao': return /^guild-yuanbao:\d+:/.test(key) ? 'build:3' : null;
      case 'reward.free-gift': {
        const match = /^gift:(\d+):/.exec(key);
        return match ? 'gift:' + match[1] : null;
      }
      case 'cultivate.shop': {
        if (key.startsWith('refresh:')) return 'refresh';
        const match = /^buy:(\d+):/.exec(key);
        return match ? 'buy:' + match[1] : null;
      }
      default: return null;
    }
  }
  // Legacy rows a previous build wrote after only local quiet time. "Retired"
  // never proved the write did not land, so it is restored to the honest hold
  // state with an append-only migration receipt; the original unknown row, its
  // operation id, bytes, before state and attempt counter stay untouched.
  //
  // Each examined row is stamped with scope_version so the next batch starts
  // after it. Without that stamp a row whose action has no period-independent
  // hold scope (story chapters, mail batches) stays `hold_scope IS NULL` and is
  // selected again by the very next query, which is what starved every row past
  // the first page. A NULL scope remains the real, legitimate value; the stamp
  // only records that the derivation ran.
  function migrateLegacyUnknowns({ limit = 512, maxBatches = 8, ownerRef = null, subjectRef = null } = {}) {
    const pageSize = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 512) : 512;
    const batches = Number.isSafeInteger(maxBatches) && maxBatches > 0 ? Math.min(maxBatches, 32) : 1;
    const filters = ["state IN ('unknown-held','unknown-retired')",
      "(state='unknown-retired' OR scope_version<" + SCOPE_VERSION + ')',
      "(hold_scope IS NULL OR state='unknown-retired')"];
    const params = [];
    if (typeof ownerRef === 'string' && ownerRef) { filters.push('owner_ref=?'); params.push(ownerRef); }
    if (typeof subjectRef === 'string' && subjectRef) { filters.push('subject_ref=?'); params.push(subjectRef); }
    const predicate = filters.join(' AND ');
    const select = `SELECT * FROM backend_reward_claims WHERE ${predicate} ORDER BY rowid LIMIT ?`;
    let migrated = 0, settled = 0, examined = 0;
    // Bounded batches: a large legacy table is fully upgraded across a few
    // transactions without one giant write on engine start.
    for (let batch = 0; batch < batches; batch += 1) {
      const rows = store.all(select, ...params, pageSize);
      if (!rows.length) break;
      const counts = transaction(() => {
        let converted = 0, stamped = 0;
        for (const row of rows) {
          const scope = row.hold_scope ?? holdScopeFor(row.feature_id, row.claim_key);
          if (row.state === 'unknown-retired') {
            const attempt = Number.isSafeInteger(Number(row.attempt)) && Number(row.attempt) > 0 ? Number(row.attempt) : 1;
            run(`INSERT OR IGNORE INTO backend_reward_claim_migrations(migration_ref,owner_ref,subject_ref,feature_id,claim_key,
              from_state,to_state,attempt,reason_code,migrated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
            'reward-claim-migration:' + fingerprint([row.owner_ref, row.subject_ref, row.feature_id, row.claim_key,
              'unknown-retired', attempt]), row.owner_ref, row.subject_ref, row.feature_id, row.claim_key,
            'unknown-retired', 'unknown-held', attempt, 'LOCAL_QUIET_TIME_IS_NOT_NON_EFFECT_PROOF', nowIso());
            converted += run(`UPDATE backend_reward_claims SET state='unknown-held',hold_scope=?,scope_version=?
              WHERE owner_ref=? AND subject_ref=? AND feature_id=? AND claim_key=? AND state='unknown-retired'`,
            scope, SCOPE_VERSION, row.owner_ref, row.subject_ref, row.feature_id, row.claim_key).changes;
          } else {
            stamped += run(`UPDATE backend_reward_claims SET hold_scope=?,scope_version=?
              WHERE owner_ref=? AND subject_ref=? AND feature_id=? AND claim_key=?`,
            scope, SCOPE_VERSION, row.owner_ref, row.subject_ref, row.feature_id, row.claim_key).changes;
          }
          examined += 1;
        }
        return { converted, stamped };
      });
      migrated += counts.converted; settled += counts.stamped;
      if (rows.length < pageSize) break;
    }
    const pending = get(`SELECT 1 AS pending FROM backend_reward_claims WHERE ${predicate} LIMIT 1`, ...params);
    return { migrated, settled, examined, remaining: pending?.pending === 1 };
  }
  // Bounded, one-row-per-card support record of the last reconciliation decision.
  // It writes only when the decision changes, so a healthy card costs nothing and
  // a stuck card can be diagnosed from the device database without logs.
  function recordReconcile(context, featureId, outcome, detail = {}) {
    try {
      const detailJson = canonical(detail);
      const prior = get(`SELECT outcome,detail_json FROM backend_reward_reconciliations
        WHERE owner_ref=? AND subject_ref=? AND feature_id=?`, context.ownerRef, context.subjectRef, featureId);
      if (prior && prior.outcome === outcome && prior.detail_json === detailJson) return;
      run(`INSERT INTO backend_reward_reconciliations(owner_ref,subject_ref,feature_id,checked_at,outcome,detail_json)
        VALUES(?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref,feature_id) DO UPDATE SET
        checked_at=excluded.checked_at,outcome=excluded.outcome,detail_json=excluded.detail_json`,
      context.ownerRef, context.subjectRef, featureId, nowIso(), outcome, detailJson);
    } catch { /* the support record must never change an assessment */ }
  }
  // A later official observation can only close the opportunity as achieved; it
  // never rewrites the operation, never credits the quota and never marks the
  // claim confirmed. One observation proves at most one held attempt, so a
  // single post-state can never be reused to claim several old writes.
  // A bounded page is not enough on its own: the 16 oldest held rows can be the
  // ones no observation will ever prove, and the achievable row behind them then
  // waits forever. A durable per-card cursor rotates the starting point, so every
  // held row is examined within ceil(held/16) assessments.
  function reconcileCursor(context, featureId) {
    return get(`SELECT last_claim_key FROM backend_reward_reconcile_cursors
      WHERE owner_ref=? AND subject_ref=? AND feature_id=?`, context.ownerRef, context.subjectRef, featureId)?.last_claim_key ?? '';
  }
  function setReconcileCursor(context, featureId, claimKey) {
    run(`INSERT INTO backend_reward_reconcile_cursors(owner_ref,subject_ref,feature_id,last_claim_key,updated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref,feature_id) DO UPDATE SET
      last_claim_key=excluded.last_claim_key,updated_at=excluded.updated_at`,
    context.ownerRef, context.subjectRef, featureId, claimKey, nowIso());
  }
  function reconcileFeatureUnknowns(context, featureId, values, sources = {}) {
    try {
      const where = `owner_ref=? AND subject_ref=? AND feature_id=? AND state IN ('unknown-held','unknown-retired')`;
      const cursor = reconcileCursor(context, featureId);
      let rows = store.all(`SELECT * FROM backend_reward_claims WHERE ${where} AND claim_key>? ORDER BY claim_key LIMIT 16`,
        context.ownerRef, context.subjectRef, featureId, cursor);
      if (rows.length < 16 && cursor) rows = rows.concat(store.all(`SELECT * FROM backend_reward_claims WHERE ${where}
        AND claim_key<=? ORDER BY claim_key LIMIT ?`, context.ownerRef, context.subjectRef, featureId, cursor, 16 - rows.length));
      if (!rows.length) { recordReconcile(context, featureId, 'no-held-claim'); return; }
      // One cursor write per assessment, not one per examined row: phone storage
      // commits every write, and the page position only needs to survive a crash.
      const examined = [];
      const commitCursor = () => {
        const last = examined.at(-1);
        if (typeof last === 'string' && last && last !== cursor) setReconcileCursor(context, featureId, last);
      };
      for (const prior of rows) {
        examined.push(prior.claim_key);
        const action = actionOfPrior(prior, featureId);
        if (!action) { recordReconcile(context, featureId, 'action-unknown', { claimKey: prior.claim_key }); continue; }
        const domain = CLAIM_DOMAIN[action] || null;
        const source = domain ? sources[domain] : null;
        if (!source || typeof source.responseRef !== 'string' || !source.responseRef) {
          recordReconcile(context, featureId, 'source-missing', { claimKey: prior.claim_key, domain });
          continue;
        }
        const settledAt = Date.parse(String(prior.updated_at || ''));
        // The observation must be received after the unknown was recorded; a
        // read that could precede the write cannot testify about its effect.
        if (!Number.isFinite(settledAt) || !Number.isSafeInteger(source.receivedDeviceMs) || source.receivedDeviceMs <= settledAt) {
          recordReconcile(context, featureId, 'source-not-after-write', { claimKey: prior.claim_key,
            settledAt: Number.isFinite(settledAt) ? settledAt : null,
            receivedDeviceMs: Number.isSafeInteger(source.receivedDeviceMs) ? source.receivedDeviceMs : null });
          continue;
        }
        let before = null;
        try { before = JSON.parse(prior.before_json); } catch { before = null; }
        // A damaged before state keeps the uncertainty; never read it as "no effect".
        if (!before) { recordReconcile(context, featureId, 'before-damaged', { claimKey: prior.claim_key }); continue; }
        let achieved = false;
        try { achieved = claimedAfter({ reward: { action, before } }, { values }); } catch { achieved = false; }
        if (!achieved) { recordReconcile(context, featureId, 'official-state-not-achieved', { claimKey: prior.claim_key }); continue; }
        const reused = get('SELECT 1 AS used FROM backend_reward_claims WHERE owner_ref=? AND subject_ref=? AND achieved_ref=? LIMIT 1',
          context.ownerRef, context.subjectRef, source.responseRef);
        if (reused) { recordReconcile(context, featureId, 'observation-already-used', { claimKey: prior.claim_key,
          responseRef: source.responseRef }); continue; }
        const changed = transaction(() => run(`UPDATE backend_reward_claims SET state='unknown-achieved',achieved_ref=?,achieved_at=?
          WHERE owner_ref=? AND subject_ref=? AND feature_id=? AND claim_key=? AND state IN ('unknown-held','unknown-retired')`,
        source.responseRef, nowIso(), context.ownerRef, context.subjectRef, featureId, prior.claim_key).changes);
        recordReconcile(context, featureId, changed === 1 ? 'achieved-recorded' : 'achieved-not-applied',
          { claimKey: prior.claim_key, responseRef: source.responseRef });
        commitCursor();
        return;
      }
      commitCursor();
    } catch (error) {
      recordReconcile(context, featureId, 'error', { code: String(error?.code || '').slice(0, 96),
        message: String(error?.message || '').slice(0, 160) });
    }
  }
  // Reuse of one official observation across several attempts is what made the
  // old build credit the same post-state twice; the map above keeps the
  // domain -> action binding in one auditable place.
  function actionOfPrior(prior, featureId) {
    // The claim key prefix encodes the action for every card.
    const key = String(prior.claim_key || '');
    switch (featureId) {
      case 'guild.build.gold': return 'guild-build-gold';
      case 'guild.build.yuanbao': return 'guild-build-yuanbao';
      case 'guild.build.video': return 'guild-build-video';
      case 'reward.mail': return 'pick';
      case 'reward.benefit-box': return 'draw';
      case 'reward.daily-task': return 'recv';
      case 'reward.daily-box': return 'recv';
      case 'reward.weekly-task': return 'recv';
      case 'reward.free-gift': return 'free-gift';
      case 'reward.double-coin': return 'renew';
      case 'reward.main-task': return 'recv';
      case 'reward.main-story': return 'unlock';
      case 'cultivate.upgrade': return 'upgrade';
      case 'cultivate.shop': return key.startsWith('refresh:') ? 'refresh' : 'buy';
      case 'guild.land': return key.startsWith('guild-harvest') ? 'guild-harvest' : key.startsWith('guild-plant') ? 'guild-plant'
        : key.startsWith('guild-unlock') ? 'guild-unlock' : 'guild-upgrade';
      default: return null;
    }
  }
  function priorClaim(context, featureId, claimKey) {
    return get('SELECT * FROM backend_reward_claims WHERE owner_ref=? AND subject_ref=? AND feature_id=? AND claim_key=?',
      context.ownerRef, context.subjectRef, featureId, claimKey);
  }
  // The SQL mirror of holdScopeFor, used only to find rows whose stored scope is
  // still NULL because the bounded migration has not reached them yet. A legacy
  // retired row may legitimately predate the migration on a large database, so
  // admission derives its scope from the claim key instead of trusting the
  // background task to have already touched that row.
  function holdScopeLike(featureId, scope) {
    const text = String(scope || '');
    const task = /^task:(\d+)$/.exec(text);
    if (task) {
      const prefix = { 'reward.daily-task': 'daily:', 'reward.weekly-task': 'weekly:', 'reward.main-task': 'main:' }[featureId];
      return prefix ? prefix + task[1] + ':%' : null;
    }
    const box = /^box:(\d+)$/.exec(text);
    if (box && featureId === 'reward.daily-box') return 'dbox:' + box[1] + ':%';
    if (text === 'build:1' && featureId === 'guild.build.video') return 'guild-video:%';
    if (text === 'build:2' && featureId === 'guild.build.gold') return 'guild-gold:%';
    if (text === 'build:3' && featureId === 'guild.build.yuanbao') return 'guild-yuanbao:%';
    if (text === 'refresh' && featureId === 'cultivate.shop') return 'refresh:%';
    const gift = /^gift:(\d+)$/.exec(text);
    if (gift && featureId === 'reward.free-gift') return 'gift:' + gift[1] + ':%';
    const buy = /^buy:(\d+)$/.exec(text);
    if (buy && featureId === 'cultivate.shop') return 'buy:' + buy[1] + ':%';
    return null;
  }
  // The exact official opportunity first, then the period-independent action
  // target when the request body cannot carry the period it was sent in. A held
  // row is never released by time, restart, re-login or a local attempt counter.
  function unresolvedHold(context, featureId, claimKey, holdScope = undefined) {
    const exact = priorClaim(context, featureId, claimKey);
    if (exact && HOLD_STATES.includes(String(exact.state))) return exact;
    const scope = holdScope === undefined ? holdScopeFor(featureId, claimKey) : holdScope;
    if (!scope) return null;
    const pattern = holdScopeLike(featureId, scope);
    const row = pattern
      ? get(`SELECT * FROM backend_reward_claims WHERE owner_ref=? AND subject_ref=? AND feature_id=?
        AND state IN ('unknown-held','unknown-retired') AND (hold_scope=? OR (hold_scope IS NULL AND claim_key LIKE ?))
        ORDER BY updated_at ASC,claim_key ASC LIMIT 1`,
      context.ownerRef, context.subjectRef, featureId, scope, pattern)
      : get(`SELECT * FROM backend_reward_claims WHERE owner_ref=? AND subject_ref=? AND feature_id=? AND hold_scope=?
        AND state IN ('unknown-held','unknown-retired') ORDER BY updated_at ASC,claim_key ASC LIMIT 1`,
      context.ownerRef, context.subjectRef, featureId, scope);
    return row || null;
  }
  function unknownWait(reasonCode, row) {
    return waiting(reasonCode, { deviceDueMs: Date.now() + 60000, unresolvedOperationRef: row?.operation_id ?? null,
      unresolvedClaimKey: row?.claim_key ?? null });
  }
  // A refusal recorded by the official answer for the exact same target. Only a
// precondition refusal is also matched through the wire-target scope (a cooldown
// reply from an older day must not be sent again for the same shop slot); a
// consumed refusal belongs to the exact opportunity it was answered for and must
// never follow the target into the next day/generation, or the card would be
// closed for good.
  function priorRefusal(context, featureId, claimKey, { withScope = false } = {}) {
    const exact = priorClaim(context, featureId, claimKey);
    if (exact && REJECTION_STATE_LIST.includes(String(exact.state))) return exact;
    if (!withScope) return null;
    const scope = holdScopeFor(featureId, claimKey);
    if (!scope) return null;
    const pattern = holdScopeLike(featureId, scope);
    return pattern
      ? get(`SELECT * FROM backend_reward_claims WHERE owner_ref=? AND subject_ref=? AND feature_id=?
        AND state='rejected-refused' AND (hold_scope=? OR (hold_scope IS NULL AND claim_key LIKE ?))
        ORDER BY updated_at DESC,claim_key ASC LIMIT 1`,
      context.ownerRef, context.subjectRef, featureId, scope, pattern) || null
      : get(`SELECT * FROM backend_reward_claims WHERE owner_ref=? AND subject_ref=? AND feature_id=? AND hold_scope=?
        AND state='rejected-refused' ORDER BY updated_at DESC,claim_key ASC LIMIT 1`,
      context.ownerRef, context.subjectRef, featureId, scope) || null;
  }
  // Returns null when this exact target may be attempted. A consumed refusal is
  // terminal for that exact opportunity; a precondition refusal only waits its
  // short backoff, because the official answer proved nothing was spent but did
  // not prove the opportunity is gone.
  function refusalGate(context, featureId, claimKey, day) {
    const exact = priorRefusal(context, featureId, claimKey);
    if (exact?.state === 'rejected-consumed')
      return { untilMs: day?.endMs ?? Date.now() + REFUSAL_BACKOFF_MS, reason: 'REWARD_TARGET_CONSUMED_BY_OFFICIAL',
        claimKey: exact.claim_key, operationId: exact.operation_id, state: exact.state };
    const row = exact?.state === 'rejected-refused' ? exact : priorRefusal(context, featureId, claimKey, { withScope: true });
    if (!row) return null;
    const at = Date.parse(String(row.updated_at || ''));
    const untilMs = (Number.isFinite(at) ? at : Date.now()) + REFUSAL_BACKOFF_MS;
    if (untilMs <= Date.now()) return null;
    return { untilMs: Math.min(untilMs, day?.endMs ?? untilMs), reason: 'REWARD_TARGET_REFUSED_RETRY_BACKOFF',
      claimKey: row.claim_key, operationId: row.operation_id, state: row.state };
  }
  function refusalWait(gate, reasonPrefix) {
    return until(reasonPrefix || gate.reason, gate.untilMs, { rejectedClaimKey: gate.claimKey,
      rejectedOperationRef: gate.operationId, rejectionState: gate.state });
  }
  function periodUsed(context, featureId, quotaKey, periodKey) {
    const row = get('SELECT used FROM backend_reward_period_usage WHERE owner_ref=? AND subject_ref=? AND feature_id=? AND quota_key=? AND period_key=?',
      context.ownerRef, context.subjectRef, featureId, quotaKey, periodKey);
    return row?.used ?? 0;
  }
  function minutePeriod(nowMs) {
    const start = Math.floor(nowMs / 60000) * 60000;
    return { key: 'm:' + start, startMs: start, endMs: start + 60000 };
  }
  function capResult({ quotaKey, actionScope, periodKind, period, used, limit, configRevision, reasonCode }) {
    return { state: 'cap-wait', reasonCode, suspension: { kind: 'period-cap', quotaKey, actionScope: actionScope || 'feature',
      periodKind, periodKey: period.key, periodEndOfficialMs: period.endMs, scope: periodKind === 'official-day' ? 'official' : 'local',
      used, limit, proofRefs: [period.key], configRevision } };
  }

  // Idempotent: the same legacy database is upgraded to the same hold rows and
  // the same migration receipts however often the runtime restarts. The startup
  // pass is deliberately bounded; a remainder keeps reporting `remaining` and is
  // continued by the per-account maintenance task without a second restart.
  const migratedUnknownClaims = migrateLegacyUnknowns().migrated;

  const builders = {
    'reward.mail': (input, state) => planMail(input, state),
    'reward.benefit-box': (input, state) => planBox(input, state),
    'reward.daily-task': (input, state) => planDailyTask(input, state),
    'reward.daily-box': (input, state) => planDailyBox(input, state),
    'reward.weekly-task': (input, state) => planWeekly(input, state),
    'reward.free-gift': (input, state) => planFreeGift(input, state),
    'reward.double-coin': (input, state) => planDoubleCoin(input, state),
    'reward.main-task': (input, state) => planMain(input, state),
    'reward.main-story': (input, state) => planStory(input, state),
    'guild.build.video': (input, state) => planGuildBuild(input, state, 'video'),
    'guild.build.gold': (input, state) => planGuildBuild(input, state, 'gold'),
    'guild.build.yuanbao': (input, state) => planGuildBuild(input, state, 'yuanbao'),
    'guild.land': (input, state) => planGuildLand(input, state),
    'cultivate.upgrade': (input, state) => planUpgrade(input, state),
    'cultivate.shop': (input, state) => planShop(input, state),
  };

  function waiting(reasonCode, extra = {}) {
    return { state: 'waiting-facts', reasonCode, deviceDueMs: Date.now() + 30000, ...extra };
  }
  function until(reasonCode, dueMs, extra = {}) {
    return { state: 'waiting-until', reasonCode, officialDueMs: dueMs, deviceDueMs: Math.max(Date.now() + 1000,
      dueMs - 2000), ...extra };
  }

  // ---- target/proposal helpers -------------------------------------------
  // Items without a promoted budget still have a provable absolute balance.
  // Synthesize the same five resource fields the ledger requires instead of
  // rejecting every non-budget item outright.
  function itemReservation({ context, itemId, quantity, memberKey, lifecycleRef }) {
    const current = resources.balance({ context, itemId });
    if (current?.base?.known !== true || !Number.isSafeInteger(current.base.value)) {
      throw Object.assign(new Error('物品余量尚未核实'), { code: 'REWARD_ITEM_BALANCE_UNKNOWN', status: 409 });
    }
    const basisRef = typeof current.basisRef === 'string' && current.basisRef
      ? current.basisRef : 'reward-item-basis:' + fingerprint([context.ownerRef, context.subjectRef, itemId,
        current.base.source?.responseRef || null, current.base.value]);
    return freeze({ resourceKey: 'item-reservation:' + fingerprint([context.subjectRef, memberKey, lifecycleRef, itemId]),
      resourceKind: 'item', resourceRef: 'item:' + itemId, basisRef,
      accountingRef: 'item-accounting:' + fingerprint([context.subjectRef, lifecycleRef, itemId]), quantity });
  }
  function makeProposal(input, state, spec) {
    const context = input.context;
    const targetKey = spec.targetKey;
    // The business opportunity identity is the claim key itself and never gains a
    // local generation suffix: an unresolved write stays attached to the target
    // it was sent for, so neither restart, re-login, elapsed time nor a local
    // retry counter can mint a "different" opportunity for the same request.
    const attemptKey = targetKey;
    const sourceRef = sourceRefOf(state, spec.domain);
    const extensionRef = extensionRefOf(state);
    const targetRef = `reward:${context.subjectRef}:${spec.action}:${attemptKey}`;
    const target = { memberKey: 'reward:' + fingerprint([spec.action, attemptKey]), targetKind: `reward:${spec.action}`,
      targetRef, lifecycleRef: spec.lifecycleRef || state.day.key,
      targetFingerprint: fingerprint({ targetRef, sourceRef, extensionRef }) };
    // One post-state vocabulary: every proposal action must have exactly one
    // fact domain, so a later official read can be attributed to this write.
    if (CLAIM_DOMAIN[spec.action] !== spec.domain) {
      throw Object.assign(new Error('奖励动作与后态事实域没有唯一绑定'), { code: 'REWARD_ACTION_DOMAIN_UNBOUND',
        details: { featureId: spec.featureId, action: spec.action, domain: spec.domain } });
    }
    const reservations = spec.resources || [];
    // Period quotas are charged per outgoing attempt (idempotently, by operation
    // id) so an unknown attempt is counted, not silently refunded by a retry.
    const quotaKey = spec.quotaKey ?? null;
    const quotaPeriodKey = spec.quotaPeriodKey ?? (quotaKey === 'shop-buy' || quotaKey === 'main-recv'
      ? minutePeriod(state.clock.nowMs).key : state.day.key);
    const proposal = { ...context, operationId: newId(), proposalId: newId(), featureId: spec.featureId, scope: spec.scope,
      method: spec.method, params: spec.params, paramsFingerprint: fingerprint(spec.params),
      configRevision: input.config.savedRevision, featureCancelEpoch: input.config.featureCancelEpochs[spec.featureId],
      semanticKey: `${VERSION}:${spec.featureId}:${attemptKey}`, contractRef: 'rewards/official-actions/v1',
      targets: [target], resources: reservations,
      resourceBindings: reservations.map(resource => ({ resourceKey: resource.resourceKey, memberKey: target.memberKey, quantity: resource.quantity })),
      reward: { action: spec.action, targetKey, attemptKey, holdScope: holdScopeFor(spec.featureId, targetKey), officialUid: state.officialUid,
        sourceRef, extensionRef, loginResponseRef: state.identity.loginResponseRef,
        versionEvidence: { loginResponseRef: state.identity.loginResponseRef },
        sourceMethod: state.sources[spec.domain]?.method || 'index.login',
        factFingerprint: state.facts.fingerprint, before: spec.before, cost: spec.cost ?? null,
        quotaKey, quotaPeriodKey, quotaKeySecondary: spec.quotaKeySecondary ?? null } };
    proposal.factBasis = factBasisFor(context, state, CARD_BY_FEATURE[spec.featureId]?.domains || null);
    try { canonical(proposal); } catch (error) {
      throw Object.assign(error, { code: 'REWARD_PROPOSAL_VALUE_INVALID',
        details: { ...(error.details || {}), featureId: spec.featureId, action: spec.action, targetKey } });
    }
    return proposal;
  }

  // ---- planners ----------------------------------------------------------
  function planMail(input, state) {
    const value = state.values['reward-mail'];
    // The mail list only comes from mail.getList; the bootstrap prefetch owns
    // that read. Asking for a full reconnect refresh here would loop.
    if (!value) return waiting('REWARD_MAIL_STATE_REQUIRED', { deviceDueMs: Date.now() + 60000 });
    if (!value.listPresent) return waiting('REWARD_MAIL_LIST_NOT_DELIVERED', { deviceDueMs: Date.now() + 60000 });
    if (value.malformed) return waiting('REWARD_MAIL_STATE_MALFORMED', { deviceDueMs: Date.now() + 60000 });
    const claimable = value.claimable || [];
    if (!claimable.length) return waiting('REWARD_MAIL_NOTHING_CLAIMABLE', { deviceDueMs: Date.now() + 900000 });
    const ids = claimable.map(mail => `${mail.msId}:${mail.allId}`).sort();
    // One opportunity key for both the local claim ledger and the proposal.
    // (Previously the planner queried `mail:<fp>` while settlement wrote
    // `all:<fp>`, so a confirmed mail claim could never be seen again.)
    const targetKey = 'all:' + fingerprint(ids);
    const prior = priorClaim(input.context, 'reward.mail', targetKey);
    if (prior?.state === 'confirmed') return until('REWARD_MAIL_ALREADY_CLAIMED', state.day.endMs);
    const held = prior?.state === 'unknown-held' ? prior : unresolvedHold(input.context, 'reward.mail', targetKey);
    if (held) return unknownWait('REWARD_MAIL_PRIOR_UNKNOWN_REQUIRES_TARGET_PROOF', held);
    const refused = refusalGate(input.context, 'reward.mail', targetKey, state.day);
    if (refused) return refusalWait(refused);
    return { state: 'proposals', proposals: [makeProposal(input, state, { featureId: 'reward.mail', scope: 'mail-pick',
      method: REWARD_METHODS.mailPick, action: 'pick', domain: 'reward-mail', targetKey,
      params: {}, before: { ids, mails: claimable.map(mail => ({ msId: mail.msId, allId: mail.allId, itemCount: mail.itemCount })) },
      resources: [] })] };
  }
  function planBox(input, state) {
    const value = state.values['reward-box'];
    if (!value) return waiting('REWARD_BOX_STATE_REQUIRED', { refreshDomains: ['reward-box'] });
    if (!value.readable) return waiting('REWARD_BOX_STATE_UNREADABLE', { refreshDomains: ['reward-box'] });
    if (value.drawCnt <= 0) return until('REWARD_BOX_NO_DRAW_AVAILABLE', state.day.endMs);
    const targetKey = `draw:${value.drawCnt}`;
    const held = unresolvedHold(input.context, 'reward.benefit-box', targetKey);
    if (held) return unknownWait('REWARD_BOX_PRIOR_UNKNOWN_REQUIRES_TARGET_PROOF', held);
    const refused = refusalGate(input.context, 'reward.benefit-box', targetKey, state.day);
    if (refused) return refusalWait(refused);
    return { state: 'proposals', proposals: [makeProposal(input, state, { featureId: 'reward.benefit-box', scope: 'benefit-box-draw',
      method: REWARD_METHODS.benefitDraw, action: 'draw', domain: 'reward-box', targetKey,
      params: {}, before: { drawCnt: value.drawCnt, uid: value.uid }, resources: [] })] };
  }
  function dailyRows(state) {
    const tasks = state.values['reward-tasks'];
    return tasks?.daily || null;
  }
  function planDailyTask(input, state) {
    const daily = dailyRows(state);
    if (!daily) return waiting('REWARD_DAILY_TASK_STATE_REQUIRED', { refreshDomains: ['reward-tasks'] });
    if (daily.malformed) return waiting('REWARD_DAILY_TASK_STATE_MALFORMED', { refreshDomains: ['reward-tasks'] });
    const progress = daily.progress || {};
    const recv = daily.recvMap || {};
    const candidates = [];
    for (const row of daily.taskMap) {
      const type = taskRowType(state, row.taskId);
      const byStatus = row.status === 1;
      const byProgress = type !== null && Number.isSafeInteger(row.targetCount) && row.targetCount > 0 &&
        (progress[type] ?? -1) >= row.targetCount && !recv[String(type)];
      if (!byStatus && !byProgress) continue;
      if (recv[String(type)] || recv[String(row.taskId)]) continue;
      candidates.push({ taskId: row.taskId, type, targetCount: row.targetCount, finishCount: row.finishCount, status: row.status });
    }
    if (!candidates.length) return until('REWARD_DAILY_TASK_NOTHING_CLAIMABLE', state.day.endMs);
    const claimKeyOf = taskId => `daily:${taskId}:${state.day.key}`;
    // A held target only holds itself: another task with its own official
    // progress is a different opportunity and must still be claimable.
    const heldCandidate = candidates.map(candidate => ({ candidate, hold: unresolvedHold(input.context, 'reward.daily-task', claimKeyOf(candidate.taskId)) }))
      .find(entry => entry.hold);
    // A refused/consumed target only holds itself: the other tasks of the card
    // keep their own official progress and must still be claimable.
    const refusedCandidate = candidates.map(candidate => ({ candidate, gate: refusalGate(input.context, 'reward.daily-task', claimKeyOf(candidate.taskId), state.day) }))
      .find(entry => entry.gate);
    const open = candidates.filter(candidate => !unresolvedHold(input.context, 'reward.daily-task', claimKeyOf(candidate.taskId)) &&
      !refusalGate(input.context, 'reward.daily-task', claimKeyOf(candidate.taskId), state.day));
    if (!open.length) return heldCandidate ? unknownWait('REWARD_DAILY_TASK_PRIOR_UNKNOWN_REQUIRES_TARGET_PROOF', heldCandidate.hold)
      : refusedCandidate ? refusalWait(refusedCandidate.gate)
      : until('REWARD_DAILY_TASK_NOTHING_CLAIMABLE', state.day.endMs);
    const chosen = open.sort((left, right) => left.taskId - right.taskId)[0];
    const claimKey = claimKeyOf(chosen.taskId);
    const prior = priorClaim(input.context, 'reward.daily-task', claimKey);
    if (prior?.state === 'confirmed') return until('REWARD_DAILY_TASK_ALREADY_CLAIMED', state.day.endMs);
    return { state: 'proposals', proposals: [makeProposal(input, state, { featureId: 'reward.daily-task', scope: 'daily-task-recv',
      method: REWARD_METHODS.dailyRecv, action: 'recv', domain: 'reward-tasks', targetKey: claimKey,
      params: { id: chosen.taskId }, before: { taskId: chosen.taskId, type: chosen.type, recvBefore: chosen.type === null ? null : (recv[String(chosen.type)] ?? 0) },
      resources: [] })] };
  }
  function taskRowType(state, taskId) {
    const table = state.tables?.c_task_dly;
    const row = tableRow(state.tables, 'c_task_dly', taskId);
    if (row && Number.isSafeInteger(row.type)) return row.type;
    // Without the static table the server-provided status remains authoritative.
    return null;
  }
  function planDailyBox(input, state) {
    const daily = dailyRows(state);
    if (!daily) return waiting('REWARD_DAILY_BOX_STATE_REQUIRED', { refreshDomains: ['reward-tasks'] });
    if (!Number.isSafeInteger(daily.score)) return waiting('REWARD_DAILY_BOX_SCORE_NOT_DELIVERED', { refreshDomains: ['reward-tasks'] });
    const tiers = dailyBoxTiers(state);
    if (!tiers.length) return waiting('REWARD_DAILY_BOX_TABLE_REQUIRED');
    const claimed = new Set(daily.boxes || []);
    const available = tiers.filter(tier => tier.threshold <= daily.score && !claimed.has(tier.idx));
    if (!available.length) return until(claimed.size ? 'REWARD_DAILY_BOX_ALL_CLAIMED' : 'REWARD_DAILY_BOX_SCORE_TOO_LOW', state.day.endMs);
    const claimKeyOf = idx => `dbox:${idx}:${state.day.key}`;
    const heldCandidate = available.map(tier => ({ tier, hold: unresolvedHold(input.context, 'reward.daily-box', claimKeyOf(tier.idx)) }))
      .find(entry => entry.hold);
    const refusedCandidate = available.map(tier => ({ tier, gate: refusalGate(input.context, 'reward.daily-box', claimKeyOf(tier.idx), state.day) }))
      .find(entry => entry.gate);
    const open = available.filter(tier => !unresolvedHold(input.context, 'reward.daily-box', claimKeyOf(tier.idx)) &&
      !refusalGate(input.context, 'reward.daily-box', claimKeyOf(tier.idx), state.day));
    if (!open.length) return heldCandidate ? unknownWait('REWARD_DAILY_BOX_PRIOR_UNKNOWN_REQUIRES_TARGET_PROOF', heldCandidate.hold)
      : refusedCandidate ? refusalWait(refusedCandidate.gate)
      : until('REWARD_DAILY_BOX_ALL_CLAIMED', state.day.endMs);
    const chosen = open.sort((left, right) => left.idx - right.idx)[0];
    const claimKey = claimKeyOf(chosen.idx);
    const prior = priorClaim(input.context, 'reward.daily-box', claimKey);
    if (prior?.state === 'confirmed') return until('REWARD_DAILY_BOX_ALREADY_CLAIMED', state.day.endMs);
    return { state: 'proposals', proposals: [makeProposal(input, state, { featureId: 'reward.daily-box', scope: 'daily-box-recv',
      method: REWARD_METHODS.dailyBox, action: 'recv', domain: 'reward-tasks', targetKey: claimKey,
      params: { idx: chosen.idx }, before: { idx: chosen.idx, threshold: chosen.threshold, score: daily.score, boxes: [...claimed] },
      resources: [] })] };
  }
  function dailyBoxTiers(state) {
    const meta = state.tables?.c_task_dly?.['-1'];
    const raw = meta?.$boxes ?? meta?.boxes;
    if (!Array.isArray(raw)) return [];
    const tiers = [];
    for (const [idx, entry] of raw.entries()) {
      const threshold = Number(Array.isArray(entry) ? entry[0] : entry);
      if (!Number.isSafeInteger(threshold) || threshold <= 0) return [];
      tiers.push({ idx, threshold });
    }
    for (let index = 1; index < tiers.length; index += 1) if (tiers[index].threshold <= tiers[index - 1].threshold) return [];
    return tiers;
  }
  function planWeekly(input, state) {
    const weekly = state.values['reward-tasks']?.weekly;
    if (!weekly) return waiting('REWARD_WEEKLY_STATE_REQUIRED', { refreshDomains: ['reward-tasks'] });
    const table = state.tables?.c_task_week;
    if (!table) return waiting('REWARD_WEEKLY_TABLE_REQUIRED');
    const progress = weekly.progress || {};
    const candidates = [];
    for (const [taskIdText, row] of Object.entries(table)) {
      if (taskIdText === '-1' || !row || typeof row !== 'object') continue;
      const taskId = positive(Number(taskIdText)), type = positive(Number(row.type));
      const target = Array.isArray(row.value) ? positive(Number(row.value[0])) : positive(Number(row.value));
      if (!taskId || !type || !target || weekly.recvMap[String(taskId)]) continue;
      if ((progress[type] ?? -1) < target) continue;
      candidates.push({ taskId, type, target });
    }
    if (!candidates.length) return until('REWARD_WEEKLY_NOTHING_CLAIMABLE', state.day.endMs);
    const weekKey = 'w:' + Math.floor(shanghai(state.day.startMs) / 7);
    const claimKeyOf = taskId => `weekly:${taskId}:${weekKey}`;
    const heldCandidate = candidates.map(candidate => ({ candidate, hold: unresolvedHold(input.context, 'reward.weekly-task', claimKeyOf(candidate.taskId)) }))
      .find(entry => entry.hold);
    const refusedCandidate = candidates.map(candidate => ({ candidate, gate: refusalGate(input.context, 'reward.weekly-task', claimKeyOf(candidate.taskId), state.day) }))
      .find(entry => entry.gate);
    const open = candidates.filter(candidate => !unresolvedHold(input.context, 'reward.weekly-task', claimKeyOf(candidate.taskId)) &&
      !refusalGate(input.context, 'reward.weekly-task', claimKeyOf(candidate.taskId), state.day));
    if (!open.length) return heldCandidate ? unknownWait('REWARD_WEEKLY_PRIOR_UNKNOWN_REQUIRES_TARGET_PROOF', heldCandidate.hold)
      : refusedCandidate ? refusalWait(refusedCandidate.gate)
      : until('REWARD_WEEKLY_NOTHING_CLAIMABLE', state.day.endMs);
    const chosen = open.sort((left, right) => left.taskId - right.taskId)[0];
    const claimKey = claimKeyOf(chosen.taskId);
    const prior = priorClaim(input.context, 'reward.weekly-task', claimKey);
    if (prior?.state === 'confirmed') return until('REWARD_WEEKLY_ALREADY_CLAIMED', state.day.endMs);
    const held = prior?.state === 'unknown-held' ? prior : unresolvedHold(input.context, 'reward.weekly-task', claimKey);
    if (held) return unknownWait('REWARD_WEEKLY_PRIOR_UNKNOWN_REQUIRES_TARGET_PROOF', held);
    return { state: 'proposals', proposals: [makeProposal(input, state, { featureId: 'reward.weekly-task', scope: 'weekly-task-recv',
      method: REWARD_METHODS.weeklyRecv, action: 'recv', domain: 'reward-tasks', targetKey: claimKey,
      params: { id: chosen.taskId }, before: { taskId: chosen.taskId, type: chosen.type, recvBefore: 0 }, resources: [] })] };
  }
  function shareState(state) {
    return state.values['reward-share'] || null;
  }
  function shareUsedToday(state, shareId) {
    const shares = shareState(state)?.shares || {};
    const share = shares[shareId];
    if (!share) return null;
    return share.uTime >= state.day.startMs && share.uTime < state.day.endMs ? share.recvCnt : 0;
  }
  function planFreeGift(input, state) {
    const gift = state.values['reward-giftbag'];
    if (!gift?.present) return waiting('REWARD_GIFT_STATE_REQUIRED', { refreshDomains: ['reward-giftbag'] });
    const table = state.tables?.c_shop_giftbag;
    if (!table) return waiting('REWARD_GIFT_TABLE_REQUIRED');
    const rows = Object.entries(table).filter(([key, row]) => key !== '-1' && row && typeof row === 'object' &&
      positive(Number(row.shareId)) && !row.rchgId && !row.rchgIdAbroat);
    if (!rows.length) return until('REWARD_GIFT_NOT_CONFIGURED', state.day.endMs);
    const [shopIdText, row] = rows.sort((left, right) => Number(left[0]) - Number(right[0]))[0];
    const shopId = positive(Number(shopIdText)), shareId = positive(Number(row.shareId));
    const shareTable = state.tables?.c_share?.[String(shareId)];
    const dailyLimit = Array.isArray(row.dLimit) ? positive(Number(row.dLimit[0])) : null;
    const cdMs = positive(Number(row.cd)) ? Number(row.cd) * 1000 : 0;
    if (!shopId || !shareId || !dailyLimit) return waiting('REWARD_GIFT_CONFIG_UNREADABLE');
    const resetMs = gift.rTime ?? state.day.startMs;
    const used = resetMs >= state.day.startMs ? (gift.dRecord?.[shopId] ?? 0) : 0;
    if (used >= dailyLimit) return until('REWARD_GIFT_DAILY_LIMIT_REACHED', state.day.endMs);
    const lastBuy = gift.buyTimeRecord?.[shopId] ?? null;
    if (lastBuy !== null && lastBuy + cdMs > state.clock.nowMs) {
      return until('REWARD_GIFT_COOLDOWN', Math.min(state.day.endMs, lastBuy + cdMs));
    }
    const shareLimit = positive(Number(shareTable?.limit));
    const usedShare = shareUsedToday(state, shareId);
    if (shareLimit && usedShare !== null && usedShare >= shareLimit) return until('REWARD_GIFT_SHARE_LIMIT_REACHED', state.day.endMs);
    const claimKey = `gift:${shopId}:${state.day.key}:${used}`;
    const held = unresolvedHold(input.context, 'reward.free-gift', claimKey);
    if (held) return unknownWait('REWARD_GIFT_PRIOR_UNKNOWN_REQUIRES_TARGET_PROOF', held);
    const refused = refusalGate(input.context, 'reward.free-gift', claimKey, state.day);
    if (refused) return refusalWait(refused);
    return { state: 'proposals', proposals: [makeProposal(input, state, { featureId: 'reward.free-gift', scope: 'free-gift-share',
      method: REWARD_METHODS.share, action: 'free-gift', domain: 'reward-giftbag', targetKey: claimKey,
      params: { shareId, ext: { opType: 1, id: shopId } }, before: { shopId, shareId, used, lastBuy, dayKey: state.day.key },
      resources: [] })] };
  }
  function planDoubleCoin(input, state) {
    const value = state.values['reward-double'];
    if (!value?.present) return waiting('REWARD_DOUBLE_STATE_REQUIRED', { refreshDomains: ['reward-double'] });
    const share = state.tables?.c_share?.[String(SHARE_IDS.doubleCoin)];
    const limit = positive(Number(share?.limit));
    const used = shareUsedToday(state, SHARE_IDS.doubleCoin);
    if (limit && used !== null && used >= limit) return until('REWARD_DOUBLE_SHARE_LIMIT_REACHED', state.day.endMs);
    const eTime = value.eTime;
    // Official rule: renew only after the privilege expired (`isExist()` is
    // eTime > now). A share sent before expiry is not honoured and only creates
    // an unknown, so never touch the buff while it is still active.
    const expired = eTime === null || !Number.isSafeInteger(eTime) || eTime <= state.clock.nowMs;
    if (!expired) return until('REWARD_DOUBLE_STILL_ACTIVE', Math.min(state.day.endMs, eTime + 1500));
    const claimKey = `double:${state.day.key}:${value.videoCnt ?? 0}:${eTime ?? 0}`;
    const held = unresolvedHold(input.context, 'reward.double-coin', claimKey);
    if (held) return unknownWait('REWARD_DOUBLE_PRIOR_UNKNOWN_REQUIRES_TARGET_PROOF', held);
    const refused = refusalGate(input.context, 'reward.double-coin', claimKey, state.day);
    if (refused) return refusalWait(refused);
    return { state: 'proposals', proposals: [makeProposal(input, state, { featureId: 'reward.double-coin', scope: 'double-coin-share',
      method: REWARD_METHODS.share, action: 'renew', domain: 'reward-double', targetKey: claimKey,
      params: { shareId: SHARE_IDS.doubleCoin, ext: { opType: 1 } },
      before: { eTime, videoCnt: value.videoCnt, used, dayKey: state.day.key }, resources: [] })] };
  }
  function planMain(input, state) {
    const main = state.values['reward-tasks']?.main;
    if (!main) return waiting('REWARD_MAIN_STATE_REQUIRED', { refreshDomains: ['reward-tasks'] });
    const table = state.tables?.c_task_main;
    if (!table) return waiting('REWARD_MAIN_TABLE_REQUIRED');
    const taskId = positive(main.curTaskId);
    if (!taskId) return waiting('REWARD_MAIN_TASK_ID_NOT_DELIVERED', { refreshDomains: ['reward-tasks'] });
    const row = tableRow(state.tables, 'c_task_main', taskId);
    if (!row) return until('REWARD_MAIN_TASK_ROW_MISSING', state.day.endMs);
    const target = positive(Number(row.value));
    const curValue = nonNegative(main.curValue);
    if (main.recvMap?.[String(taskId)]) return until('REWARD_MAIN_ALREADY_CLAIMED', state.day.endMs);
    if (!target || curValue === null || curValue < target) return until('REWARD_MAIN_NOT_COMPLETE', state.day.endMs);
    const config = input.config.config.mainTask || {};
    const limit = positive(config.maxRewardsPerMinute) ?? 1;
    const minute = minutePeriod(state.clock.nowMs);
    const used = periodUsed(input.context, 'reward.main-task', 'main-recv', minute.key);
    if (used >= limit) return capResult({ quotaKey: 'main-recv', actionScope: input.scheduleKey, periodKind: 'local-minute', period: minute, used, limit,
      configRevision: input.config.savedRevision, reasonCode: 'REWARD_MAIN_MINUTE_LIMIT_REACHED' });
    const claimKey = `main:${taskId}:${state.day.key}`;
    const prior = priorClaim(input.context, 'reward.main-task', claimKey);
    if (prior?.state === 'confirmed') return until('REWARD_MAIN_ALREADY_CLAIMED', state.day.endMs);
    const held = prior?.state === 'unknown-held' ? prior : unresolvedHold(input.context, 'reward.main-task', claimKey);
    if (held) return unknownWait('REWARD_MAIN_PRIOR_UNKNOWN_REQUIRES_TARGET_PROOF', held);
    const refused = refusalGate(input.context, 'reward.main-task', claimKey, state.day);
    if (refused) return refusalWait(refused);
    return { state: 'proposals', proposals: [makeProposal(input, state, { featureId: 'reward.main-task', scope: 'main-task-recv',
      method: REWARD_METHODS.mainRecv, action: 'recv', domain: 'reward-tasks', targetKey: claimKey, params: {},
      before: { taskId, curValue, target }, resources: [], quotaKey: 'main-recv' })] };
  }
  function planStory(input, state) {
    const story = state.values['reward-story'];
    if (!story?.present) return waiting('REWARD_STORY_STATE_REQUIRED', { refreshDomains: ['reward-story'] });
    if (!story.readable) return waiting('REWARD_STORY_STATE_UNREADABLE', { refreshDomains: ['reward-story'] });
    const chapterRow = tableRow(state.tables, 'c_storyMainChapter', story.chapter);
    if (!chapterRow) return waiting('REWARD_STORY_TABLE_REQUIRED');
    const sectionIds = chapterRow.sectionId;
    const nextSectionId = Array.isArray(sectionIds) ? sectionIds[story.sectionIdx] : null;
    const sectionRow = nextSectionId ? tableRow(state.tables, 'c_storyMainSection', nextSectionId) : null;
    const cost = Array.isArray(sectionRow?.cost?.[0]) ? sectionRow.cost[0] : null;
    if (!nextSectionId || !cost) return until('REWARD_STORY_CHAPTER_COMPLETE', state.day.endMs);
    const config = input.config.config.mainStory || {};
    const limit = positive(config.maxUnlocksPerDay) ?? 1;
    const used = periodUsed(input.context, 'reward.main-story', 'story-unlock', state.day.key);
    if (used >= limit) return capResult({ quotaKey: 'story-unlock', actionScope: input.scheduleKey, periodKind: 'official-day', period: { key: state.day.key, endMs: state.day.endMs },
      used, limit, configRevision: input.config.savedRevision, reasonCode: 'REWARD_STORY_DAILY_LIMIT_REACHED' });
    const costItemId = positive(Number(cost[0])), costCount = positive(Number(cost[1]));
    if (!costItemId || !costCount) return waiting('REWARD_STORY_COST_UNREADABLE');
    const balance = resources.balance({ context: input.context, itemId: costItemId });
    if (balance?.base?.known !== true || !Number.isSafeInteger(balance.base.value) || balance.base.value < costCount)
      return waiting('REWARD_STORY_STARS_INSUFFICIENT', { deviceDueMs: Date.now() + 600000 });
    const claimKey = `story:${story.chapter}:${story.sectionIdx}:${nextSectionId}`;
    const prior = priorClaim(input.context, 'reward.main-story', claimKey);
    if (prior?.state === 'confirmed') return until('REWARD_STORY_ALREADY_UNLOCKED', state.day.endMs);
    const held = prior?.state === 'unknown-held' ? prior : unresolvedHold(input.context, 'reward.main-story', claimKey);
    if (held) return unknownWait('REWARD_STORY_PRIOR_UNKNOWN_REQUIRES_TARGET_PROOF', held);
    const refused = refusalGate(input.context, 'reward.main-story', claimKey, state.day);
    if (refused) return refusalWait(refused);
    const reservations = [itemReservation({ context: input.context, itemId: costItemId, quantity: costCount,
      memberKey: 'reward:' + claimKey, lifecycleRef: state.day.key })];
    return { state: 'proposals', proposals: [makeProposal(input, state, { featureId: 'reward.main-story', scope: 'story-unlock',
      method: REWARD_METHODS.storyUnlock, action: 'unlock', domain: 'reward-story', targetKey: claimKey, params: {},
      before: { chapter: story.chapter, sectionIdx: story.sectionIdx, nextSectionId, costItemId, costCount },
      resources: reservations, cost: { costItemId, costCount }, quotaKey: 'story-unlock' })] };
  }
  function guildState(state) {
    const guild = state.values['reward-guild'];
    return guild?.present ? guild : null;
  }
  function planGuildBuild(input, state, tier) {
    const guild = guildState(state);
    if (!guild) return waiting('REWARD_GUILD_STATE_REQUIRED', { refreshDomains: ['reward-guild'] });
    if (!guild.memberPresent || !guild.uid) return until('REWARD_GUILD_NOT_MEMBER', state.day.endMs);
    const rowKey = GUILD_BUILD_ROWS['guild-build-' + tier];
    const row = tableRow(state.tables, 'c_fmlBld', rowKey);
    if (!row) return waiting('REWARD_GUILD_BUILD_TABLE_REQUIRED');
    const config = input.config.config.guildBuild || {};
    const used = guild.buildCount?.[String(rowKey)] ?? 0;
    const officialDaily = positive(Number(row.dailyCount));
    const tierEnabled = tier === 'video' ? config.videoEnabled !== false : tier === 'gold' ? config.goldEnabled !== false : config.yuanbaoEnabled === true;
    if (!tierEnabled) return { state: 'disabled', reasonCode: 'REWARD_GUILD_BUILD_TIER_DISABLED' };
    const configDaily = tier === 'video' ? 1 : tier === 'gold' ? (nonNegative(config.goldDailyCount) ?? 0) : (nonNegative(config.yuanbaoTimesPerDay) ?? 0);
    if (configDaily <= 0) return { state: 'disabled', reasonCode: 'REWARD_GUILD_BUILD_TIER_DISABLED' };
    const limit = Math.min(configDaily, officialDaily ?? configDaily);
    if (used >= limit) return until('REWARD_GUILD_BUILD_DAILY_LIMIT_REACHED', state.day.endMs);
    if (tier === 'video') {
      const shareId = positive(Number(row.shareId));
      const shareLimit = positive(Number(state.tables?.c_share?.[String(shareId)]?.limit));
      const usedShare = shareId ? shareUsedToday(state, shareId) : null;
      if (!shareId) return waiting('REWARD_GUILD_BUILD_SHARE_UNREADABLE');
      if (shareLimit && usedShare !== null && usedShare >= shareLimit) return until('REWARD_GUILD_BUILD_VIDEO_LIMIT_REACHED', state.day.endMs);
      const claimKey = `guild-video:${rowKey}:${state.day.key}:${used}`;
      const held = unresolvedHold(input.context, 'guild.build.video', claimKey);
      if (held) return unknownWait('REWARD_GUILD_BUILD_PRIOR_UNKNOWN_REQUIRES_TARGET_PROOF', held);
      const refused = refusalGate(input.context, 'guild.build.video', claimKey, state.day);
      if (refused) return refusalWait(refused);
      return { state: 'proposals', proposals: [makeProposal(input, state, { featureId: 'guild.build.video', scope: 'guild-build-video',
        method: REWARD_METHODS.share, action: 'guild-build-video', domain: 'reward-guild', targetKey: claimKey,
        params: { shareId, ext: { opType: 1, id: rowKey } }, before: { row: rowKey, used, shareId, usedShare }, resources: [] })] };
    }
    const costCell = Array.isArray(row.items?.[0]) ? row.items[0] : null;
    const costItemId = costCell ? positive(Number(costCell[0])) : null, costCount = costCell ? positive(Number(costCell[1])) : null;
    if (!costItemId || !costCount) return waiting('REWARD_GUILD_BUILD_COST_UNREADABLE');
    if (costItemId === 1 && configDaily <= 0) return { state: 'disabled', reasonCode: 'REWARD_GUILD_BUILD_TIER_DISABLED' };
    // Gold is the profile currency; use the same profile cell the planner already
    // reads for level/uid instead of a second, stricter currency projection.
    const owned = costItemId === 11 ? nonNegative(state.profile?.gold)
      : (() => { const current = resources.balance({ context: input.context, itemId: costItemId });
        return current?.base?.known === true && Number.isSafeInteger(current.base.value) ? current.base.value : null; })();
    if (owned === null || owned < costCount)
      return waiting('REWARD_GUILD_BUILD_RESOURCE_INSUFFICIENT', { deviceDueMs: Date.now() + 600000 });
    const claimKey = `guild-${tier}:${rowKey}:${state.day.key}:${used}`;
    const featureId = 'guild.build.' + tier;
    const held = unresolvedHold(input.context, featureId, claimKey);
    if (held) return unknownWait('REWARD_GUILD_BUILD_PRIOR_UNKNOWN_REQUIRES_TARGET_PROOF', held);
    const refused = refusalGate(input.context, featureId, claimKey, state.day);
    if (refused) return refusalWait(refused);
    const reservations = [goldItem(costItemId)
      ? resources.currencyReservationSpec({ context: input.context, amount: costCount, currency: 'gold', memberKey: 'reward:' + claimKey, lifecycleRef: state.day.key })
      : itemReservation({ context: input.context, itemId: costItemId, quantity: costCount, memberKey: 'reward:' + claimKey, lifecycleRef: state.day.key })];
    return { state: 'proposals', proposals: [makeProposal(input, state, { featureId, scope: 'guild-build-' + tier,
      method: REWARD_METHODS.guildBuild, action: 'guild-build-' + tier, domain: 'reward-guild', targetKey: claimKey,
      params: { id: rowKey }, before: { row: rowKey, used, costItemId, costCount }, resources: reservations,
      cost: { costItemId, costCount } })] };
  }
  function planGuildLand(input, state) {
    const guild = guildState(state);
    if (!guild) return waiting('REWARD_GUILD_STATE_REQUIRED', { refreshDomains: ['reward-guild'] });
    if (!guild.memberPresent) return until('REWARD_GUILD_NOT_MEMBER', state.day.endMs);
    const config = input.config.config.guildLand || {};
    const action = input.scheduleKey.replace('guild-', '');
    if (action === 'harvest') {
      if (config.harvestEnabled !== true) return { state: 'disabled', reasonCode: 'REWARD_GUILD_HARVEST_DISABLED' };
      const ready = (guild.landMap || []).filter(row => row.flwId && guildHarvestReady(state, row));
      if (!ready.length) return until('REWARD_GUILD_LAND_NOTHING_MATURE', state.day.endMs);
      // The opportunity is the exact mature set that will be harvested. A key
      // that ignored it would collapse every harvest of the day into one claim
      // and make a single unknown block unrelated harvests.
      const claimKey = `guild-harvest:${state.day.key}:${fingerprint(ready.map(row => [row.landId, row.matureFlwCnt]))}`;
      const held = unresolvedHold(input.context, 'guild.land', claimKey);
      if (held) return unknownWait('REWARD_GUILD_LAND_PRIOR_UNKNOWN_REQUIRES_TARGET_PROOF', held);
      const refused = refusalGate(input.context, 'guild.land', claimKey, state.day);
      if (refused) return refusalWait(refused);
      return { state: 'proposals', proposals: [makeProposal(input, state, { featureId: 'guild.land', scope: 'guild-harvest',
        method: REWARD_METHODS.guildHarvest, action: 'guild-harvest', domain: 'reward-guild', targetKey: claimKey, params: {},
        before: { lands: ready.map(row => ({ landId: row.landId, matureFlwCnt: row.matureFlwCnt, harvestedFlwCnt: row.harvestedFlwCnt })) },
        resources: [] })] };
    }
    if (action === 'plant') {
      if (config.plantEnabled !== true) return { state: 'disabled', reasonCode: 'REWARD_GUILD_PLANT_DISABLED' };
      const empty = (guild.landMap || []).filter(row => !row.flwId).map(row => row.landId).sort((a, b) => a - b);
      if (!empty.length) return until('REWARD_GUILD_LAND_NO_EMPTY_PLOT', state.day.endMs);
      const choice = chooseGuildFlower(input, state, config);
      if (!choice) return waiting('REWARD_GUILD_FLOWER_CHOICE_UNAVAILABLE', { deviceDueMs: Date.now() + 30000 });
      const claimKey = `guild-plant:${state.day.key}:${choice.flowerId}:${fingerprint(empty)}`;
      const held = unresolvedHold(input.context, 'guild.land', claimKey);
      if (held) return unknownWait('REWARD_GUILD_LAND_PRIOR_UNKNOWN_REQUIRES_TARGET_PROOF', held);
      const refused = refusalGate(input.context, 'guild.land', claimKey, state.day);
      if (refused) return refusalWait(refused);
      return { state: 'proposals', proposals: [makeProposal(input, state, { featureId: 'guild.land', scope: 'guild-plant',
        method: REWARD_METHODS.guildPlant, action: 'guild-plant', domain: 'reward-guild', targetKey: claimKey,
        params: { landIds: empty, flwId: choice.flowerId }, before: { landIds: empty, flwId: choice.flowerId,
          cultivationLvl: choice.lvl }, resources: [] })] };
    }
    if (action === 'unlock') {
      if (config.unlockEnabled !== true) return { state: 'disabled', reasonCode: 'REWARD_GUILD_UNLOCK_DISABLED' };
      const landCfg = state.tables?.c_fmlLand;
      if (!landCfg) return waiting('REWARD_GUILD_LAND_TABLE_REQUIRED');
      if (guild.lvl === null || guild.lvl === undefined) return waiting('REWARD_GUILD_LEVEL_NOT_DELIVERED');
      const maxLand = positive(Number(landCfg?.['-1']?.$landMax));
      if (!maxLand) return waiting('REWARD_GUILD_LAND_MAX_UNREADABLE');
      const present = new Set((guild.landMap || []).map(row => row.landId));
      const candidates = [];
      for (let landId = 1; landId <= maxLand; landId += 1) {
        if (present.has(landId)) continue;
        const row = tableRow(state.tables, 'c_fmlLand', landId);
        if (!row) continue;
        const unlockLvl = nonNegative(Number(row.unlockLvl));
        if (unlockLvl === null || (guild.lvl ?? 0) < unlockLvl) continue;
        const cost = Array.isArray(row.unlockCost) ? row.unlockCost : null;
        const costItemId = cost ? positive(Number(cost[0])) : null, costCount = cost ? positive(Number(cost[1])) : null;
        if (!costItemId || !costCount) continue;
        const keep = nonNegative(config.unlockKeepGuildCoin) ?? 0;
        const balance = resources.balance({ context: input.context, itemId: costItemId });
        if (balance?.base?.known !== true || balance.base.value < costCount + keep) continue;
        candidates.push({ landId, costItemId, costCount });
      }
      if (!candidates.length) return waiting('REWARD_GUILD_LAND_NO_UNLOCK_OPPORTUNITY', { deviceDueMs: Date.now() + 600000 });
      const claimKeyOf = candidate => `guild-unlock:${candidate.landId}`;
      const heldCandidate = candidates.map(candidate => ({ candidate, hold: unresolvedHold(input.context, 'guild.land', claimKeyOf(candidate)) }))
        .find(entry => entry.hold);
      const refusedCandidate = candidates.map(candidate => ({ candidate, gate: refusalGate(input.context, 'guild.land', claimKeyOf(candidate), state.day) }))
        .find(entry => entry.gate);
      const open = candidates.filter(candidate => !unresolvedHold(input.context, 'guild.land', claimKeyOf(candidate)) &&
        !refusalGate(input.context, 'guild.land', claimKeyOf(candidate), state.day));
      if (!open.length) return heldCandidate ? unknownWait('REWARD_GUILD_LAND_PRIOR_UNKNOWN_REQUIRES_TARGET_PROOF', heldCandidate.hold)
        : refusedCandidate ? refusalWait(refusedCandidate.gate)
        : until('REWARD_GUILD_LAND_NO_UNLOCK_OPPORTUNITY', state.day.endMs);
      const chosen = open.sort((left, right) => left.landId - right.landId)[0];
      const claimKey = claimKeyOf(chosen);
      const reservations = [itemReservation({ context: input.context, itemId: chosen.costItemId, quantity: chosen.costCount,
        memberKey: 'reward:' + claimKey, lifecycleRef: state.day.key })];
      return { state: 'proposals', proposals: [makeProposal(input, state, { featureId: 'guild.land', scope: 'guild-unlock',
        method: REWARD_METHODS.guildUnlock, action: 'unlock', domain: 'reward-guild', targetKey: claimKey,
        params: { landId: chosen.landId }, before: { landId: chosen.landId, costItemId: chosen.costItemId, costCount: chosen.costCount },
        resources: reservations, cost: { costItemId: chosen.costItemId, costCount: chosen.costCount } })] };
    }
    if (action === 'upgrade') {
      if (config.upgradeEnabled !== true) return { state: 'disabled', reasonCode: 'REWARD_GUILD_UPGRADE_DISABLED' };
      const lvlTable = state.tables?.c_fmlLandLvl;
      if (!lvlTable) return waiting('REWARD_GUILD_LAND_LEVEL_TABLE_REQUIRED');
      const keep = nonNegative(config.upgradeKeepGuildCoin) ?? 0;
      const candidates = [];
      for (const row of guild.landMap || []) {
        if (!row.flwId || nonNegative(row.lvl) === null) continue;
        const current = tableRow(state.tables, 'c_fmlLandLvl', row.lvl);
        const cost = Array.isArray(current?.lvlCost) ? current.lvlCost : null;
        const costItemId = cost ? positive(Number(cost[0])) : null, costCount = cost ? positive(Number(cost[1])) : null;
        if (!costItemId || !costCount) continue;
        const balance = resources.balance({ context: input.context, itemId: costItemId });
        if (balance?.base?.known !== true || balance.base.value < costCount + keep) continue;
        candidates.push({ landId: row.landId, lvl: row.lvl, costItemId, costCount });
      }
      if (!candidates.length) return waiting('REWARD_GUILD_LAND_NO_UPGRADE_OPPORTUNITY', { deviceDueMs: Date.now() + 600000 });
      const claimKeyOf = candidate => `guild-upgrade:${candidate.landId}:${candidate.lvl}`;
      const heldCandidate = candidates.map(candidate => ({ candidate, hold: unresolvedHold(input.context, 'guild.land', claimKeyOf(candidate)) }))
        .find(entry => entry.hold);
      const refusedCandidate = candidates.map(candidate => ({ candidate, gate: refusalGate(input.context, 'guild.land', claimKeyOf(candidate), state.day) }))
        .find(entry => entry.gate);
      const open = candidates.filter(candidate => !unresolvedHold(input.context, 'guild.land', claimKeyOf(candidate)) &&
        !refusalGate(input.context, 'guild.land', claimKeyOf(candidate), state.day));
      if (!open.length) return heldCandidate ? unknownWait('REWARD_GUILD_LAND_PRIOR_UNKNOWN_REQUIRES_TARGET_PROOF', heldCandidate.hold)
        : refusedCandidate ? refusalWait(refusedCandidate.gate)
        : until('REWARD_GUILD_LAND_NO_UPGRADE_OPPORTUNITY', state.day.endMs);
      const chosen = open.sort((left, right) => left.landId - right.landId)[0];
      const claimKey = claimKeyOf(chosen);
      const reservations = [itemReservation({ context: input.context, itemId: chosen.costItemId, quantity: chosen.costCount,
        memberKey: 'reward:' + claimKey, lifecycleRef: state.day.key })];
      return { state: 'proposals', proposals: [makeProposal(input, state, { featureId: 'guild.land', scope: 'guild-upgrade',
        method: REWARD_METHODS.guildUpgrade, action: 'guild-upgrade', domain: 'reward-guild', targetKey: claimKey,
        params: { landId: chosen.landId }, before: { landId: chosen.landId, lvl: chosen.lvl, costItemId: chosen.costItemId, costCount: chosen.costCount },
        resources: reservations, cost: { costItemId: chosen.costItemId, costCount: chosen.costCount } })] };
    }
    return { state: 'disabled', reasonCode: 'REWARD_GUILD_LAND_ACTION_UNKNOWN' };
  }
  function guildHarvestReady(state, row) {
    const stock = positive(Number(tableRow(state.tables, 'c_fmlLandLvl', row.lvl)?.stock));
    const mature = nonNegative(row.matureFlwCnt);
    if (mature === null) return false;
    return stock ? mature >= stock : mature >= 1;
  }
  function chooseGuildFlower(input, state, config) {
    const rows = state.values['reward-cultivate']?.rows || [];
    const allowed = new Set(Array.isArray(config.plantFlowerIds) ? config.plantFlowerIds.filter(id => positive(id)) : []);
    const blacklist = new Set(Array.isArray(config.plantBlacklistIds) ? config.plantBlacklistIds : []);
    const qualities = Array.isArray(config.plantQualities) ? config.plantQualities : [];
    const bag = state.bag?.items || null;
    const catalog = state.tables?.c_flower;
    const picked = rows.filter(row => row.status === 2 && row.flowerId && !blacklist.has(row.flowerId) &&
      (config.plantMode !== 'chosen_flowers' || allowed.has(row.flowerId)) &&
      (config.minFlowerLevel === undefined || config.minFlowerLevel === null || (row.lvl ?? 0) >= config.minFlowerLevel) &&
      (qualities.length === 0 || qualities.includes(flowerQuality(state, row.flowerId))));
    if (!picked.length) return null;
    const stockOf = row => {
      const seedId = positive(Number(catalog?.[String(row.flowerId)]?.seedId));
      const count = bag && seedId ? Number(bag[seedId] ?? 0) : null;
      return Number.isSafeInteger(count) ? count : Number.MAX_SAFE_INTEGER;
    };
    return picked.sort((left, right) => stockOf(left) - stockOf(right) || left.flowerId - right.flowerId)[0];
  }
  function flowerQuality(state, flowerId) {
    const row = state.tables?.c_flower?.[String(flowerId)];
    const quality = Number(row?.quality ?? row?.q ?? row?.type);
    return Number.isSafeInteger(quality) && quality >= 1 && quality <= 5 ? quality : null;
  }
  function planUpgrade(input, state) {
    const config = input.config.config.cultivateUpgrade || {};
    const targetLevel = positive(config.targetLevel) ?? 20;
    const rows = state.values['reward-cultivate']?.rows || [];
    if (!rows.length) return waiting('REWARD_UPGRADE_STATE_REQUIRED', { refreshDomains: ['reward-cultivate'] });
    const lvlCfg = state.tables?.c_flowerLvlCfg;
    if (!lvlCfg) return waiting('REWARD_UPGRADE_TABLE_REQUIRED');
    const lvlMax = positive(Number(state.tables?.c_flowerLvl?.['-1']?.$lvlMax)) ?? 20;
    const bag = state.bag?.items || {}, profile = state.profile || {};
    const gold = nonNegative(profile.gold);
    const candidates = [];
    for (const row of rows) {
      if (row.status !== 2 || !row.flowerId || !row.lvl) continue;
      if (row.lvl >= targetLevel || row.lvl >= lvlMax) continue;
      const cost = upgradeCost(state, row.flowerId, row.lvl);
      if (!cost) continue;
      const material = Number(bag?.[String(cost.itemId)] ?? 0), goldOwned = gold ?? 0;
      if (material < cost.count || goldOwned < cost.gold) continue;
      candidates.push({ flowerId: row.flowerId, lvl: row.lvl, ...cost });
    }
    if (!candidates.length) return waiting('REWARD_UPGRADE_NO_AFFORDABLE_FLOWER', { deviceDueMs: Date.now() + 600000 });
    const claimKeyOf = candidate => `upgrade:${candidate.flowerId}:${candidate.lvl}`;
    const heldCandidate = candidates.map(candidate => ({ candidate, hold: unresolvedHold(input.context, 'cultivate.upgrade', claimKeyOf(candidate)) }))
      .find(entry => entry.hold);
    const refusedCandidate = candidates.map(candidate => ({ candidate, gate: refusalGate(input.context, 'cultivate.upgrade', claimKeyOf(candidate), state.day) }))
      .find(entry => entry.gate);
    const open = candidates.filter(candidate => !unresolvedHold(input.context, 'cultivate.upgrade', claimKeyOf(candidate)) &&
      !refusalGate(input.context, 'cultivate.upgrade', claimKeyOf(candidate), state.day));
    if (!open.length) return heldCandidate ? unknownWait('REWARD_UPGRADE_PRIOR_UNKNOWN_REQUIRES_TARGET_PROOF', heldCandidate.hold)
      : refusedCandidate ? refusalWait(refusedCandidate.gate)
      : until('REWARD_UPGRADE_NO_AFFORDABLE_FLOWER', state.day.endMs);
    const chosen = open.sort((left, right) => left.flowerId - right.flowerId)[0];
    const claimKey = claimKeyOf(chosen);
    const prior = priorClaim(input.context, 'cultivate.upgrade', claimKey);
    if (prior?.state === 'confirmed') return until('REWARD_UPGRADE_ALREADY_APPLIED', state.day.endMs);
    const reservations = [resources.currencyReservationSpec({ context: input.context, amount: chosen.gold, currency: 'gold',
      memberKey: 'reward:' + claimKey, lifecycleRef: state.day.key }),
    itemReservation({ context: input.context, itemId: chosen.itemId, quantity: chosen.count, memberKey: 'reward:' + claimKey,
      lifecycleRef: state.day.key })];
    return { state: 'proposals', proposals: [makeProposal(input, state, { featureId: 'cultivate.upgrade', scope: 'cultivate-upgrade',
      method: REWARD_METHODS.cultivateUpgrade, action: 'upgrade', domain: 'reward-cultivate', targetKey: claimKey,
      params: { flowerId: chosen.flowerId }, before: { flowerId: chosen.flowerId, lvl: chosen.lvl, gold: chosen.gold,
        itemId: chosen.itemId, count: chosen.count }, resources: reservations,
      cost: { gold: chosen.gold, itemId: chosen.itemId, count: chosen.count } })] };
  }
  function upgradeCost(state, flowerId, level) {
    const direct = state.tables?.c_flowerLvl?.[String(flowerId) + String(level).padStart(2, '0')];
    const base = state.tables?.c_flowerLvl?.[String(flowerId)];
    const cfg = state.tables?.c_flowerLvlCfg?.[String(level)];
    const first = state.tables?.c_flowerLvlCfg?.['1'];
    if (direct) {
      const gold = nonNegative(Number(direct.gldCost));
      const count = nonNegative(Number(Array.isArray(direct.lvlUpCost) ? direct.lvlUpCost[1] : direct.lvlUpCost));
      if (gold === null || !count) return null;
      return { gold, itemId: flowerId - 1000, count };
    }
    if (!base || !cfg || !first) return null;
    const gold = Math.round(Number(base.gldCost) * (Number(cfg.gldCost) / Number(first.gldCost)));
    const count = nonNegative(Number(cfg.lvlUpCost));
    if (!Number.isFinite(gold) || gold < 0 || !count) return null;
    return { gold, itemId: flowerId - 1000, count };
  }
  function planShop(input, state) {
    const shop = state.values['reward-shop'];
    if (!shop?.present) return waiting('REWARD_SHOP_STATE_REQUIRED', { refreshDomains: ['reward-shop'] });
    const config = input.config.config.materialShop || {};
    const table = state.tables?.c_shop_cultivate;
    if (!table) return waiting('REWARD_SHOP_TABLE_REQUIRED');
    const action = input.scheduleKey === 'shop-refresh' ? 'refresh' : 'buy';
    if (action === 'refresh') {
      if (config.freeRefresh !== true) return { state: 'disabled', reasonCode: 'REWARD_SHOP_REFRESH_DISABLED' };
      const meta = table?.['-1'];
      const freeLimit = positive(Number(meta?.$frTimes ?? meta?.frTimes));
      if (!freeLimit) return waiting('REWARD_SHOP_REFRESH_LIMIT_UNREADABLE');
      const used = nonNegative(shop.refreshCount) ?? 0;
      if (used >= freeLimit) return until('REWARD_SHOP_REFRESH_DAILY_LIMIT_REACHED', state.day.endMs);
      const exhausted = shop.offers.length > 0 && shop.offers.every(offer => offer.bought >= (positive(Number(Array.isArray(table[String(offer.shopId)]?.bLimit) ? table[String(offer.shopId)].bLimit[0] : 1)) ?? 1));
      if (!exhausted) return until('REWARD_SHOP_REFRESH_NOT_NEEDED', state.day.endMs);
      const claimKey = `refresh:${state.day.key}:${used}`;
      const held = unresolvedHold(input.context, 'cultivate.shop', claimKey);
      if (held) return unknownWait('REWARD_SHOP_PRIOR_UNKNOWN_REQUIRES_TARGET_PROOF', held);
      const refused = refusalGate(input.context, 'cultivate.shop', claimKey, state.day);
      if (refused) return refusalWait(refused);
      return { state: 'proposals', proposals: [makeProposal(input, state, { featureId: 'cultivate.shop', scope: 'shop-refresh',
        method: REWARD_METHODS.shopRefresh, action: 'refresh', domain: 'reward-shop', targetKey: claimKey, params: {},
        before: { refreshCount: used, offers: shop.offers }, resources: [] })] };
    }
    const keepGold = nonNegative(config.keepGold) ?? 0;
    const limit = positive(config.maxBuyPerMinute) ?? 3;
    const minute = minutePeriod(state.clock.nowMs);
    const used = periodUsed(input.context, 'cultivate.shop', 'shop-buy', minute.key);
    if (used >= limit) return capResult({ quotaKey: 'shop-buy', actionScope: input.scheduleKey, periodKind: 'local-minute', period: minute, used, limit,
      configRevision: input.config.savedRevision, reasonCode: 'REWARD_SHOP_MINUTE_LIMIT_REACHED' });
    const gold = nonNegative(state.profile?.gold);
    const bag = state.bag?.items || {};
    const level = positive(state.profile?.level);
    const offers = [];
    for (const offer of shop.offers) {
      const row = tableRow(state.tables, 'c_shop_cultivate', offer.shopId);
      const bLimit = positive(Number(Array.isArray(row?.bLimit) ? row.bLimit[0] : row?.bLimit));
      const unlock = nonNegative(Number(row?.unlock_lvl));
      if (!bLimit || offer.bought >= bLimit) continue;
      if (level !== null && unlock !== null && level < unlock) continue;
      if (offer.costItemId === 11) {
        if (gold === null || gold < offer.price + keepGold) continue;
      } else if (Number(bag?.[String(offer.costItemId)] ?? 0) < offer.price) continue;
      offers.push(offer);
    }
    if (!offers.length) return waiting('REWARD_SHOP_NO_AFFORDABLE_OFFER', { deviceDueMs: Date.now() + 600000 });
    // A free refresh resets the per-slot bought counter, so the same shopId can
    // legitimately be bought again in the next shelf generation. The official
    // mrCount is that generation; without it a re-rolled slot would look like a
    // duplicate of the previous confirmed buy forever.
    const refreshGeneration = nonNegative(shop.refreshCount) ?? 0;
    const claimKeyOf = offer => `buy:${offer.shopId}:${offer.bought}:r${refreshGeneration}`;
    const heldCandidate = offers.map(offer => ({ offer, hold: unresolvedHold(input.context, 'cultivate.shop', claimKeyOf(offer)) }))
      .find(entry => entry.hold);
    // The refusal is per shelf slot: a refused/consumed slot must not stall the
    // other slots of the same shelf, which are independent wire targets.
    const refusedCandidate = offers.map(offer => ({ offer, gate: refusalGate(input.context, 'cultivate.shop', claimKeyOf(offer), state.day) }))
      .find(entry => entry.gate);
    const open = offers.filter(offer => !unresolvedHold(input.context, 'cultivate.shop', claimKeyOf(offer)) &&
      !refusalGate(input.context, 'cultivate.shop', claimKeyOf(offer), state.day));
    if (!open.length) return heldCandidate ? unknownWait('REWARD_SHOP_PRIOR_UNKNOWN_REQUIRES_TARGET_PROOF', heldCandidate.hold)
      : refusedCandidate ? refusalWait(refusedCandidate.gate)
      : until('REWARD_SHOP_NO_AFFORDABLE_OFFER', state.day.endMs);
    const chosen = open.sort((left, right) => left.price - right.price || left.shopId - right.shopId)[0];
    const claimKey = claimKeyOf(chosen);
    const prior = priorClaim(input.context, 'cultivate.shop', claimKey);
    if (prior?.state === 'confirmed') return until('REWARD_SHOP_ALREADY_BOUGHT', state.day.endMs);
    const reservations = [goldItem(chosen.costItemId)
      ? resources.currencyReservationSpec({ context: input.context, amount: chosen.price, currency: 'gold', memberKey: 'reward:' + claimKey, lifecycleRef: state.day.key })
      : itemReservation({ context: input.context, itemId: chosen.costItemId, quantity: chosen.price, memberKey: 'reward:' + claimKey, lifecycleRef: state.day.key })];
    return { state: 'proposals', proposals: [makeProposal(input, state, { featureId: 'cultivate.shop', scope: 'shop-buy',
      method: REWARD_METHODS.shopBuy, action: 'buy', domain: 'reward-shop', targetKey: claimKey,
      params: { shopId: chosen.shopId }, before: { shopId: chosen.shopId, bought: chosen.bought, costItemId: chosen.costItemId,
        price: chosen.price, keepGold, generation: refreshGeneration }, resources: reservations, cost: { costItemId: chosen.costItemId, price: chosen.price },
      quotaKey: 'shop-buy' })] };
  }

  // ---- admission ---------------------------------------------------------
  function evaluateAdmission({ proposal, actor, factBasis: suppliedBasis, boundary, ownReservation } = {}) {
    if (!proposal || !actor || !isCurrent(actor)) return { allowed: false, reasonCode: 'REWARD_CONTEXT_NOT_CURRENT' };
    const state = stateFor(actor);
    if (!state) {
      const missing = [];
      if (facts.read(actor)?.current !== true) missing.push('FACTS');
      if (!extensionForContext(actor)?.loginResponseRef) missing.push('IDENTITY');
      if (!dayFor(actor)) missing.push('DAY');
      if (!clockFor(actor)) missing.push('CLOCK');
      if (!tablesForContext(actor)) missing.push('TABLES');
      return { allowed: false, reasonCode: 'REWARD_CURRENT_FACTS_REQUIRED_' + (missing.join('_') || 'UNKNOWN') };
    }
    const basis = factBasisFor(actor, state, CARD_BY_FEATURE[proposal.featureId]?.domains || null);
    // Claim decisions depend on the observed values, identity and official day.
    // A strictly newer response carrying the same values (for example the
    // post-login mail prefetch) must not invalidate an otherwise current
    // proposal; the gateway's semantic dynamic token separately proves coverage
    // and freshness for the exact consumed domains.
    const decisionBasis = value => value && ({ version: value.version, values: value.values,
      identity: { bundleRef: value.identity?.bundleRef, dataSnapshotId: value.identity?.dataSnapshotId },
      tableHashes: value.tableHashes, day: value.day });
    if (!basis.current || suppliedBasis?.version !== VERSION ||
        fingerprint(decisionBasis(suppliedBasis)) !== fingerprint(decisionBasis(basis))) {
      const original = decisionBasis(suppliedBasis) || {}, current = decisionBasis(basis) || {};
      const diff = ['version', 'values', 'identity', 'tableHashes', 'day']
        .filter(key => fingerprint(current[key]) !== fingerprint(original[key]));
      if (reportBasisMismatch) try {
        reportBasisMismatch({ ownerRef: proposal.ownerRef, accountRef: proposal.accountRef, featureId: proposal.featureId,
          action: proposal.reward?.action || null, boundary, diff,
          current: { domains: Object.keys(current.values || {}), tableHashes: current.tableHashes && Object.keys(current.tableHashes),
            day: current.day },
          original: { domains: Object.keys(original.values || {}), tableHashes: original.tableHashes && Object.keys(original.tableHashes),
            day: original.day } });
      } catch { /* diagnostics only */ }
      return { allowed: false, reasonCode: 'REWARD_FACTS_SUPERSEDED_' + (diff.join('_') || (basis.current ? 'VERSION' : 'NOT_CURRENT')) };
    }
    const reward = proposal.reward;
    if (state.officialUid !== reward.officialUid || extensionRefOf(state) !== reward.extensionRef)
      return { allowed: false, reasonCode: 'REWARD_IDENTITY_SUPERSEDED' };
    // Read this card's unresolved history without a target filter so a legacy
    // ":gN" generation row (written by the old build for the same business
    // opportunity) is still visible for the exact same target identity.
    const admission = ledgerView.currentAdmission({ ownerRef: actor.ownerRef, subjectRef: actor.subjectRef,
      targetRefs: null, featureIds: [proposal.featureId] });
    const own = boundary === 'before-send' && ownReservation?.operationId === proposal.operationId ? proposal.operationId : null;
    if (!admission || admission.activeOperation && admission.activeOperation.operation_id !== own)
      return { allowed: false, historicalConstraintsChecked: true, currentInFlightChecked: true, reasonCode: 'REWARD_ACTIVE_OPERATION' };
    for (const row of admission.unresolvedOperations || []) if (row.operation_id !== own) {
      const prior = ledgerView.operation?.(row.operation_id);
      const targetRef = proposal.targets[0].targetRef;
      // A legacy ":gN" target is the old build's re-labelled copy of the same
      // business opportunity; it must not be invisible to this admission.
      if (prior?.targets?.some(target => {
        const ref = target.target_ref ?? target.original?.targetRef;
        return ref === targetRef || typeof ref === 'string' && ref.startsWith(targetRef + ':g');
      })) return { allowed: false, historicalConstraintsChecked: true, currentInFlightChecked: true, reasonCode: 'REWARD_TARGET_UNRESOLVED' };
    }
    // A proposal drafted before an earlier attempt settled must not slip past the
    // claim-level hold: the ledger only knows the exact target ref, while a held
    // period-scoped row also covers the next official period.
    const exactPrior = priorClaim(actor, proposal.featureId, reward.targetKey);
    if (exactPrior && HOLD_STATES.includes(String(exactPrior.state)) && exactPrior.operation_id !== proposal.operationId)
      return { allowed: false, historicalConstraintsChecked: true, currentInFlightChecked: true, reasonCode: 'REWARD_OPPORTUNITY_UNRESOLVED' };
    // A proposal drafted before the official answer arrived must not be sent once
    // that answer proved the target consumed or refused for the exact same wire
    // request. It carries its own operation id, so only the target can stop it.
    const exactRefusal = exactPrior && REJECTION_STATE_LIST.includes(String(exactPrior.state)) ? exactPrior : null;
    if (exactRefusal) {
      const refusedAt = Date.parse(String(exactRefusal.updated_at || ''));
      const stillWaiting = exactRefusal.state === 'rejected-consumed' ||
        Number.isFinite(refusedAt) && refusedAt + REFUSAL_BACKOFF_MS > Date.now();
      if (stillWaiting && exactRefusal.operation_id !== proposal.operationId)
        return { allowed: false, historicalConstraintsChecked: true, currentInFlightChecked: true,
          reasonCode: exactRefusal.state === 'rejected-consumed' ? 'REWARD_TARGET_CONSUMED_BY_OFFICIAL' : 'REWARD_TARGET_REFUSED_RETRY_BACKOFF' };
    }
    const scopedHold = unresolvedHold(actor, proposal.featureId, reward.targetKey, reward.holdScope ?? undefined);
    if (scopedHold && scopedHold.operation_id !== proposal.operationId)
      return { allowed: false, historicalConstraintsChecked: true, currentInFlightChecked: true, reasonCode: 'REWARD_OPPORTUNITY_UNRESOLVED' };
    if (!stillClaimable(proposal, state))
      return { allowed: false, historicalConstraintsChecked: true, currentInFlightChecked: true, reasonCode: 'REWARD_OPPORTUNITY_CHANGED' };
    return { allowed: true, targetsCurrent: true, resourcesCurrent: true, historicalConstraintsChecked: true, currentInFlightChecked: true, reasonCode: null };
  }
  function stillClaimable(proposal, state) {
    const before = proposal.reward?.before;
    if (!before) return false;
    switch (proposal.reward.action) {
      case 'pick': {
        const mails = state.values['reward-mail']?.claimable || [];
        const ids = new Set(mails.map(mail => `${mail.msId}:${mail.allId}`));
        return (before.ids || []).every(id => ids.has(id));
      }
      case 'draw': return (state.values['reward-box']?.drawCnt ?? -1) === before.drawCnt;
      case 'recv': {
        const tasks = state.values['reward-tasks'];
        // The daily task box and the task-list receipts share one action name in
        // the contract, so the proposal's own before shape decides which post
        // state has to be unchanged.
        if (Number.isSafeInteger(before.idx)) return (tasks?.daily?.score ?? -1) >= before.threshold &&
          !(tasks?.daily?.boxes || []).includes(before.idx);
        if (before.type !== null && before.type !== undefined)
          return !(tasks?.daily?.recvMap?.[String(before.type)]) && !(tasks?.weekly?.recvMap?.[String(before.taskId)]);
        if (Number.isSafeInteger(before.taskId)) return !(tasks?.main?.recvMap?.[String(before.taskId)]);
        return true;
      }
      case 'claim':
      case 'free-gift': {
        // `claim` is the declared unit action; proposals carry `free-gift`. Both
        // must re-read the same official day counter, otherwise a proposal
        // drafted before the day limit changed would still be sent.
        const gift = state.values['reward-giftbag'];
        const used = (gift?.rTime ?? state.day.startMs) >= state.day.startMs ? (gift?.dRecord?.[before.shopId] ?? 0) : 0;
        return used === before.used;
      }
      case 'renew': return (state.values['reward-double']?.eTime ?? null) === before.eTime;
      case 'unlock': {
        const story = state.values['reward-story'];
        return story?.readable === true && story.chapter === before.chapter && story.sectionIdx === before.sectionIdx;
      }
      case 'guild-build-video':
      case 'guild-build-gold':
      case 'guild-build-yuanbao':
        return (state.values['reward-guild']?.buildCount?.[String(before.row)] ?? 0) === before.used;
      case 'guild-harvest': {
        const rows = new Map((state.values['reward-guild']?.landMap || []).map(row => [row.landId, row]));
        return (before.lands || []).every(land => rows.get(land.landId)?.matureFlwCnt === land.matureFlwCnt);
      }
      case 'guild-plant': {
        const rows = new Map((state.values['reward-guild']?.landMap || []).map(row => [row.landId, row]));
        return (before.landIds || []).every(landId => rows.get(landId) && !rows.get(landId).flwId);
      }
      case 'guild-unlock': {
        const present = new Set((state.values['reward-guild']?.landMap || []).map(row => row.landId));
        return !present.has(before.landId);
      }
      case 'guild-upgrade': {
        const row = (state.values['reward-guild']?.landMap || []).find(one => one.landId === before.landId);
        return row?.lvl === before.lvl;
      }
      case 'upgrade': {
        const row = (state.values['reward-cultivate']?.rows || []).find(one => one.flowerId === before.flowerId);
        return row?.lvl === before.lvl;
      }
      case 'buy': {
        // A free refresh re-rolls the shelf and resets the per-slot counter; a
        // proposal drafted in an earlier generation must not be sent into the
        // new one, even if the counter happens to read the same.
        if (Number.isSafeInteger(before.generation) && (state.values['reward-shop']?.refreshCount ?? 0) !== before.generation) return false;
        const offer = (state.values['reward-shop']?.offers || []).find(one => one.shopId === before.shopId);
        return offer?.bought === before.bought && offer?.price === before.price;
      }
      case 'refresh': return (state.values['reward-shop']?.refreshCount ?? 0) === before.refreshCount;
      default: return true;
    }
  }

  // ---- verification ------------------------------------------------------
  function claimedAfter(proposal, after, afterState) {
    const reward = proposal.reward, before = reward.before;
    const values = after.values || {};
    switch (reward.action) {
      case 'pick': {
        const mails = values['reward-mail']?.mails || [];
        return (before.ids || []).every(id => {
          const [msId, allId] = id.split(':').map(Number);
          const row = mails.find(mail => mail.msId === msId && mail.allId === allId);
          return !row || row.isPick === true || row.isDel === true || row.itemCount === 0;
        });
      }
      case 'draw': {
        const drawCnt = values['reward-box']?.drawCnt;
        return Number.isSafeInteger(drawCnt) && drawCnt < before.drawCnt;
      }
      case 'recv': {
        const tasks = values['reward-tasks'];
        if (!tasks) return false;
        // Daily task box: its own official post-state is the claimed tier list.
        if (Number.isSafeInteger(reward.before?.idx)) return (tasks.daily?.boxes || []).includes(before.idx);
        if (before.type !== null && before.type !== undefined) {
          const recv = tasks.daily?.recvMap?.[String(before.type)] ?? tasks.weekly?.recvMap?.[String(before.taskId)];
          if (recv) return true;
        }
        if (before.curValue !== undefined) {
          const main = tasks.main;
          return !!main && (main.recvMap?.[String(before.taskId)] === true || (main.curTaskId ?? null) !== before.taskId);
        }
        return false;
      }
      case 'free-gift': {
        const gift = values['reward-giftbag'];
        const used = gift?.dRecord?.[before.shopId] ?? 0;
        if (used >= before.used + 1) return true;
        // A late request can land on the next official day, where dRecord was
        // reset to a value below the old day's count. The official purchase time
        // for the same shop row moving past the recorded one is the day-crossing
        // witness: it can only move when a purchase by this subject succeeded.
        const buyTime = gift?.buyTimeRecord?.[before.shopId] ?? null;
        return Number.isSafeInteger(buyTime) && (before.lastBuy === null || before.lastBuy === undefined || buyTime > before.lastBuy);
      }
      case 'renew': {
        const value = values['reward-double'];
        if (!value) return false;
        if (Number.isSafeInteger(value.eTime) && (!Number.isSafeInteger(before.eTime) || value.eTime > before.eTime)) return true;
        return Number.isSafeInteger(value.videoCnt) && Number.isSafeInteger(before.videoCnt) && value.videoCnt > before.videoCnt;
      }
      case 'unlock': {
        const story = values['reward-story'];
        if (!story?.readable) return false;
        return story.chapter > before.chapter || story.chapter === before.chapter && story.sectionIdx > before.sectionIdx;
      }
      case 'guild-build-video':
      case 'guild-build-gold':
      case 'guild-build-yuanbao': {
        const count = values['reward-guild']?.buildCount?.[String(before.row)];
        return Number.isSafeInteger(count) && count >= before.used + 1;
      }
      case 'guild-harvest': {
        const rows = new Map((values['reward-guild']?.landMap || []).map(row => [row.landId, row]));
        return (before.lands || []).every(land => {
          const row = rows.get(land.landId);
          if (!row) return true;
          return (Number.isSafeInteger(row.matureFlwCnt) && Number.isSafeInteger(land.matureFlwCnt) && row.matureFlwCnt < land.matureFlwCnt) ||
            (Number.isSafeInteger(row.harvestedFlwCnt) && Number.isSafeInteger(land.harvestedFlwCnt) && row.harvestedFlwCnt > land.harvestedFlwCnt) ||
            !row.flwId;
        });
      }
      case 'guild-plant': {
        const rows = new Map((values['reward-guild']?.landMap || []).map(row => [row.landId, row]));
        return (before.landIds || []).every(landId => rows.get(landId)?.flwId === before.flwId);
      }
      case 'guild-unlock': {
        const rows = new Map((values['reward-guild']?.landMap || []).map(row => [row.landId, row]));
        return rows.has(before.landId);
      }
      case 'guild-upgrade': {
        const row = (values['reward-guild']?.landMap || []).find(one => one.landId === before.landId);
        return Number.isSafeInteger(row?.lvl) && row.lvl > before.lvl;
      }
      case 'upgrade': {
        const row = (values['reward-cultivate']?.rows || []).find(one => one.flowerId === before.flowerId);
        return Number.isSafeInteger(row?.lvl) && row.lvl > before.lvl;
      }
      case 'buy': {
        // The shelf generation resets the per-slot bought counter. A counter in a
        // later generation says nothing about the write that was sent in the
        // earlier one, so it must not be read as proof of that write.
        if (Number.isSafeInteger(before.generation) && values['reward-shop']?.refreshCount !== before.generation) return false;
        const offer = (values['reward-shop']?.offers || []).find(one => one.shopId === before.shopId);
        return Number.isSafeInteger(offer?.bought) && offer.bought >= before.bought + 1;
      }
      case 'refresh': {
        const count = values['reward-shop']?.refreshCount;
        return Number.isSafeInteger(count) && count > before.refreshCount;
      }
      default: return false;
    }
  }

  async function verify({ proposal, response, connection, signal } = {}) {
    const footprint = () => (proposal?.resources || []).map(resource => ({ resourceKey: resource.resourceKey, state: 'historical_footprint' }));
    const released = () => (proposal?.resources || []).map(resource => ({ resourceKey: resource.resourceKey, state: 'released' }));
    const unknown = reasonCode => ({ verdict: 'unknown', reasonCode, verificationVersion: 'rewards/claim-postread/v1',
      evidence: { targetRef: proposal?.targets?.[0]?.targetRef || null, targetKey: proposal?.reward?.targetKey || null, reasonCode },
      resourceResolutions: footprint() });
    // An official answer that names a precondition of this exact method is the
    // only refusal exit. It is bound to the matched reply the gateway already
    // validated (method, wire key, request sequence, connection epoch), so a
    // push or another operation's message can never be applied here.
    const refusal = classifyOfficialRefusal({ method: proposal?.method, action: proposal?.reward?.action, response });
    if (refusal) return { verdict: 'rejected', reasonCode: refusal.reasonCode, verificationVersion: refusal.rejection.version,
      rejection: refusal.rejection, rejectionClass: refusal.class,
      evidence: { targetRef: proposal.targets[0].targetRef, targetKey: proposal.reward.targetKey, action: proposal.reward.action,
        method: proposal.method, refusal: refusal.rejection, before: proposal.reward.before },
      resourceResolutions: released() };
    let bridge, sameRead = null;
    if (proposal.featureId === 'reward.mail') {
      try { sameRead = await connection.read('mail.getList', {}); } catch (error) {
        return unknown(typeof error?.code === 'string' ? error.code : 'REWARD_MAIL_POSTREAD_FAILED');
      }
      signal?.throwIfAborted?.();
      const after = facts.read(proposal.featureId === 'reward.mail' ? { ...proposal } : null);
      if (!sameRead || sameRead.transport !== 'answered' || sameRead.envelopeOk !== true || sameRead.rejected === true ||
          sameRead.dsName !== 'G.ISyncData' || !after?.current || !after.values['reward-mail'])
        return unknown('REWARD_MAIL_POSTREAD_FACTS_NOT_CURRENT');
      const afterState = { values: after.values, sources: after.sources };
      if (!claimedAfter(proposal, after, afterState)) return unknown('REWARD_EFFECT_UNPROVEN');
      return { verdict: 'confirmed', verificationVersion: 'rewards/claim-postread/v1', postReadRef: sameRead.responseRef,
        resourceResolutions: released(), evidence: { targetRef: proposal.targets[0].targetRef, targetKey: proposal.reward.targetKey,
          action: proposal.reward.action, postReadRef: sameRead.responseRef, postReadRequestSequence: sameRead.requestSequence,
          postReadConnectionEpoch: sameRead.connectionEpoch, writeResponseRef: response?.responseRef || null,
          before: proposal.reward.before, afterMails: after.values['reward-mail']?.mails || [] } };
    }
    try { bridge = await connection.readSnapshotAfterClose(); } catch (error) {
      return unknown(typeof error?.code === 'string' ? error.code : 'REWARD_POSTREAD_FAILED');
    }
    signal?.throwIfAborted?.();
    const post = bridge?.newLoginObservation;
    if (!bridge || bridge.operationId !== proposal.operationId || bridge.oldPhysicalCloseReceipt?.closed !== true ||
        post?.method !== 'index.login' || post.source !== 'response' || post.transport !== 'answered' ||
        post.envelopeOk !== true || post.rejected === true || post.dsName !== 'G.ISyncData' || bridge.officialUid !== proposal.reward.officialUid)
      return unknown('REWARD_POSTREAD_MISSING');
    const after = facts.read(bridge.newContext), identity = extensionForContext(bridge.newContext);
    if (!after?.current || !identity || identity.loginResponseRef !== post.responseRef)
      return unknown('REWARD_POSTREAD_FACTS_NOT_CURRENT');
    const afterState = { values: after.values, sources: after.sources, identity, day: dayFor(bridge.newContext),
      clock: clockFor(bridge.newContext), tables: tablesForContext(bridge.newContext)?.tables ?? null, officialUid: bridge.officialUid };
    if (!claimedAfter(proposal, after, afterState)) return unknown('REWARD_EFFECT_UNPROVEN');
    return { verdict: 'confirmed', verificationVersion: 'rewards/claim-postread/v1', postReadRef: post.responseRef,
      resourceResolutions: released(), evidence: { targetRef: proposal.targets[0].targetRef, targetKey: proposal.reward.targetKey,
        action: proposal.reward.action, postReadRef: post.responseRef, postReadRequestSequence: post.requestSequence,
        postReadConnectionEpoch: post.connectionEpoch, writeResponseRef: response?.responseRef || null,
        before: proposal.reward.before, after: Object.fromEntries(Object.entries(after.values).map(([key, value]) => [key, value])),
        bridgeFingerprint: bridge.bridgeFingerprint } };
  }

  // Quota is charged once per outgoing operation, keyed by operation id, so an
  // unknown attempt is neither refunded by a retry nor counted twice when the
  // same effect is later observed. A protocol-proven not-sent attempt never
  // reaches onSettled and therefore never consumes an allowance.
  function chargeQuota(proposal) {
    const quota = proposal.reward?.quotaKey;
    if (!quota) return;
    const periodKey = proposal.reward.quotaPeriodKey || (quota === 'shop-buy' || quota === 'main-recv'
      ? minutePeriod(Date.now()).key : proposal.targets[0].lifecycleRef);
    transaction(() => {
      const charged = run(`INSERT OR IGNORE INTO backend_reward_usage_charges(operation_id,owner_ref,subject_ref,feature_id,
        quota_key,period_key,charged_at) VALUES(?,?,?,?,?,?,?)`, proposal.operationId, proposal.ownerRef, proposal.subjectRef,
      proposal.featureId, quota, periodKey, nowIso()).changes;
      if (charged !== 1) return;
      run(`INSERT INTO backend_reward_period_usage(owner_ref,subject_ref,feature_id,quota_key,period_key,used,updated_at)
        VALUES(?,?,?,?,?,1,?) ON CONFLICT(owner_ref,subject_ref,feature_id,quota_key,period_key)
        DO UPDATE SET used=used+1,updated_at=excluded.updated_at`,
      proposal.ownerRef, proposal.subjectRef, proposal.featureId, quota, periodKey, nowIso());
    });
  }

  function onSettled({ proposal, operation, verification } = {}) {
    const reward = proposal.reward, featureId = proposal.featureId;
    const paramsJson = canonical(proposal.params), beforeJson = canonical(reward.before || null);
    const periodKey = reward.before?.dayKey || proposal.targets[0].lifecycleRef;
    const holdScope = reward.holdScope ?? holdScopeFor(featureId, reward.targetKey);
    if (verification?.verdict === 'confirmed') {
      transaction(() => run(`INSERT INTO backend_reward_claims(owner_ref,subject_ref,feature_id,claim_key,period_key,state,operation_id,
        params_json,before_json,quota_key,hold_scope,scope_version,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref,feature_id,claim_key) DO UPDATE SET
        state=excluded.state,operation_id=excluded.operation_id,params_json=excluded.params_json,before_json=excluded.before_json,
        quota_key=excluded.quota_key,hold_scope=excluded.hold_scope,scope_version=excluded.scope_version,updated_at=excluded.updated_at`,
      proposal.ownerRef, proposal.subjectRef, featureId, reward.targetKey, periodKey, 'confirmed', proposal.operationId, paramsJson,
      beforeJson, reward.quotaKey || null, holdScope, SCOPE_VERSION, nowIso()));
    } else if (verification?.verdict === 'unknown' && operation?.transport_state !== 'not_sent') {
      // The original unknown row keeps its operation id, request bytes, before
      // state and attempt counter. Only the observation timestamp moves so the
      // achieved-reconciliation can order a later official read after it.
      transaction(() => run(`INSERT INTO backend_reward_claims(owner_ref,subject_ref,feature_id,claim_key,period_key,state,operation_id,
        params_json,before_json,quota_key,hold_scope,scope_version,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref,feature_id,claim_key) DO UPDATE SET
        state='unknown-held',operation_id=excluded.operation_id,params_json=excluded.params_json,
        before_json=excluded.before_json,quota_key=excluded.quota_key,hold_scope=excluded.hold_scope,
        scope_version=excluded.scope_version,updated_at=excluded.updated_at`,
      proposal.ownerRef, proposal.subjectRef, featureId, reward.targetKey, periodKey, 'unknown-held', proposal.operationId, paramsJson,
      beforeJson, reward.quotaKey || null, holdScope, SCOPE_VERSION, nowIso()));
    } else if (verification?.verdict === 'rejected') {
      // The official answer proved this exact request had no effect. The claim is
      // never credited and no quota is charged; only the target's future is
      // recorded: consumed for good, or a bounded backoff for a precondition.
      const state = REJECTION_STATES[verification.rejectionClass] || REJECTION_STATES.refused;
      const prior = priorClaim(proposal, featureId, reward.targetKey);
      // An unresolved sent write of the same target stays the authoritative row:
      // a refusal cannot prove anything about an earlier request.
      if (!prior || !HOLD_STATES.includes(String(prior.state))) transaction(() => run(
        `INSERT INTO backend_reward_claims(owner_ref,subject_ref,feature_id,claim_key,period_key,state,operation_id,
        params_json,before_json,quota_key,hold_scope,scope_version,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref,feature_id,claim_key) DO UPDATE SET
        state=excluded.state,operation_id=excluded.operation_id,params_json=excluded.params_json,
        before_json=excluded.before_json,quota_key=excluded.quota_key,hold_scope=excluded.hold_scope,
        scope_version=excluded.scope_version,updated_at=excluded.updated_at`,
      proposal.ownerRef, proposal.subjectRef, featureId, reward.targetKey, periodKey, state, proposal.operationId, paramsJson,
      beforeJson, reward.quotaKey || null, holdScope, SCOPE_VERSION, nowIso()));
    }
    if (verification?.verdict === 'confirmed' || verification?.verdict === 'unknown' && operation?.transport_state !== 'not_sent') {
      chargeQuota(proposal);
    }
    appendOutbox({ ownerRef: proposal.ownerRef, subjectRef: proposal.subjectRef, eventType: 'FeatureSettlement',
      eventKey: 'reward-settlement:' + proposal.operationId, payload: { operationId: operation?.operation_id || proposal.operationId,
        featureId, action: reward.action, verdict: verification?.verdict || 'unknown',
        reasonCode: verification?.reasonCode || null, runEpoch: proposal.runEpoch, connectionEpoch: proposal.connectionEpoch, method: proposal.method } });
    return { visibility: 'current' };
  }

  const features = [];
  for (const card of Object.values(CARD_BY_FEATURE)) {
    const contractRef = 'rewards/official-actions/v1';
    const operationContracts = Object.freeze(Object.fromEntries(card.methods.map(method => {
      const scope = card.methodScopes[method];
      const action = card.units.find(unit => unit.scheduleKey === scope)?.action || card.units[0].action;
      return [method, Object.freeze({ ...claimContract(card.featureId, scope, method, action),
        postRead: claimPostRead(card.featureId, action, card.postReadMode), validateTargetVerification: rewardTargetVerification })];
    })));
    const assessUnit = scheduleKey => input => {
      const enabled = CONFIG_ENABLED[card.featureId];
      if (typeof enabled === 'function' && enabled(input.config?.config) !== true) return { state: 'disabled', reasonCode: 'REWARD_CARD_DISABLED' };
      if (!isCurrent(input.context) || !exactContext(input.context)) return { state: 'blocked', reasonCode: 'REWARD_CONTEXT_NOT_CURRENT' };
      const state = stateFor(input.context);
      if (!state) return waiting('REWARD_CURRENT_FACTS_REQUIRED', { refreshDomains: card.domains });
      if (!state.officialUid) return waiting('REWARD_OFFICIAL_UID_REQUIRED', { deviceDueMs: Date.now() + 30000 });
      const builder = builders[card.featureId];
      if (!builder) return { state: 'blocked', reasonCode: 'REWARD_PLANNER_MISSING' };
      reconcileFeatureUnknowns(input.context, card.featureId, state.values, state.sources);
      return builder({ ...input, scheduleKey }, state);
    };
    const assess = assessUnit(card.units[0].scheduleKey);
    const scheduleUnits = Object.freeze(card.units.map(unit => {
      const method = Object.entries(card.methodScopes).find(([, scope]) => scope === unit.scheduleKey)?.[0];
      if (!method) throw new TypeError('Reward card unit has no bound method: ' + card.featureId + ':' + unit.scheduleKey);
      return Object.freeze({ scheduleKey: unit.scheduleKey, wakeKey: unit.scheduleKey, allowedMethods: [method],
        allowedScopes: [unit.scheduleKey], assess: assessUnit(unit.scheduleKey) });
    }));
    const feature = Object.freeze({ featureId: card.featureId, label: card.label, consumedDomains: card.domains,
      scopes: card.scopes, methods: card.methods, methodScopes: card.methodScopes, operationContracts, operationContract: null,
      release: 'validation-only', implementationVersion: VERSION, contractRef, factDomains: card.domains,
      resourceKinds: ['item', 'currency'], scheduleUnits, assess,
      qualify: input => evaluateAdmission({ ...input, proposal: input?.proposal ?? null }),
      evaluateAdmission: input => evaluateAdmission(input),
      verify, readFactBasis: ({ proposal, actor }) => {
        const basis = factBasisFor(actor, stateFor(actor), card.domains);
        if (reportBasisMismatch && proposal?.factBasis && fingerprint(basis) !== fingerprint(proposal.factBasis)) {
          try {
            const keys = ['context', 'values', 'sources', 'identity', 'tableHashes', 'day'];
            reportBasisMismatch({ ownerRef: proposal.ownerRef, accountRef: proposal.accountRef,
              featureId: card.featureId, action: proposal.reward?.action || null,
              diff: keys.filter(key => fingerprint(basis[key]) !== fingerprint(proposal.factBasis[key])),
              current: { domains: Object.keys(basis.values), sources: Object.fromEntries(Object.entries(basis.sources)
                .map(([domain, source]) => [domain, [source.responseRef, source.requestSequence]])) },
              original: { domains: Object.keys(proposal.factBasis.values), sources: Object.fromEntries(Object.entries(proposal.factBasis.sources)
                .map(([domain, source]) => [domain, [source.responseRef, source.requestSequence]])) } });
          } catch { /* diagnostics only */ }
        }
        return basis;
      },
      onSettled, onCurrentVerified: () => {} });
    features.push(feature);
  }
  // Maintenance entry points used by the shared scheduler. Both are bounded and
  // neither sends a game request: one continues the legacy upgrade for a single
  // account, the other re-reads post-states for held claims whose card may be
  // suspended by its own business cap (a suspended card is not reassessed, so
  // its old unknowns would otherwise wait for the next official day).
  function reconcileHeldClaims({ context, featureIds = null } = {}) {
    if (!context || !exactContext(context)) return { current: false, reasonCode: 'REWARD_CONTEXT_NOT_CURRENT', checked: 0 };
    const anyHeld = get(`SELECT 1 AS held FROM backend_reward_claims WHERE owner_ref=? AND subject_ref=?
      AND state IN ('unknown-held','unknown-retired') LIMIT 1`, context.ownerRef, context.subjectRef);
    if (!anyHeld) return { current: true, checked: 0 };
    let state = null;
    try { state = stateFor(context); } catch { state = null; }
    if (!state) return { current: false, reasonCode: 'REWARD_CURRENT_FACTS_REQUIRED', checked: 0 };
    const ids = Array.isArray(featureIds) ? featureIds : Object.keys(CARD_BY_FEATURE);
    let checked = 0;
    for (const featureId of ids) {
      if (!CARD_BY_FEATURE[featureId]) continue;
      const held = get(`SELECT 1 AS held FROM backend_reward_claims WHERE owner_ref=? AND subject_ref=? AND feature_id=?
        AND state IN ('unknown-held','unknown-retired') LIMIT 1`, context.ownerRef, context.subjectRef, featureId);
      if (!held) continue;
      reconcileFeatureUnknowns(context, featureId, state.values, state.sources);
      checked += 1;
    }
    return { current: true, checked };
  }
  const readFactBasis = ({ proposal, actor }) => {
    const card = proposal ? CARD_BY_FEATURE[proposal.featureId] : null;
    const basis = factBasisFor(actor, stateFor(actor), card?.domains || null);
    if (reportBasisMismatch && card && proposal?.factBasis && fingerprint(basis) !== fingerprint(proposal.factBasis)) {
      try {
        const keys = ['context', 'values', 'sources', 'identity', 'tableHashes', 'day'];
        reportBasisMismatch({ ownerRef: proposal.ownerRef, accountRef: proposal.accountRef, featureId: card.featureId,
          action: proposal.reward?.action || null, diff: keys.filter(key => fingerprint(basis[key]) !== fingerprint(proposal.factBasis[key])),
          current: { domains: Object.keys(basis.values), sources: Object.fromEntries(Object.entries(basis.sources)
            .map(([domain, source]) => [domain, [source.responseRef, source.requestSequence]])) },
          original: { domains: Object.keys(proposal.factBasis.values), sources: Object.fromEntries(Object.entries(proposal.factBasis.sources)
            .map(([domain, source]) => [domain, [source.responseRef, source.requestSequence]])) } });
      } catch { /* diagnostics only */ }
    }
    return basis;
  };
  return Object.freeze({ features: Object.freeze(features), evaluateAdmission, readFactBasis, onSettled, assess: null,
    migrateLegacyUnknowns, reconcileHeldClaims, migratedUnknownClaims });
}