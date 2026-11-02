import { freeze, newId, plainObject, problem, requireText } from '../common.mjs';
import { createLegacyLogPolicyRestorer, createLegacyLogProjection } from './legacy-log-projection.mjs';

const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const safeCode = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
  ? error.code : 'LEGACY_LOG_PROJECTION_UNAVAILABLE';

/** Compatibility composition only. Old pending remains an archived obligation;
 * it is never enqueued into the new pump or counted as a new-cloud ACK.
 */
export function createLegacyLogging({ store, cipher, software, cloudSync } = {}) {
  if (!store?.db?.exec || !store?.transaction || !store?.all || !store?.get || !store?.run
    || typeof software?.status !== 'function' || typeof software?.authorize !== 'function'
    || typeof cloudSync?.status !== 'function' || typeof cloudSync?.setWifiOnly !== 'function' || typeof cloudSync?.policy !== 'function') {
    throw new TypeError('Legacy logging requires the durable store and normal software/current cloud log interfaces');
  }
  const { get, run, transaction, nowIso } = store;
  const hasTable = name => Boolean(get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name));
  const cache = new Map();
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_log_policy_user_choices(
    choice_sequence INTEGER PRIMARY KEY AUTOINCREMENT,choice_ref TEXT NOT NULL UNIQUE,
    owner_ref TEXT NOT NULL,install_id TEXT NOT NULL,identity_epoch INTEGER NOT NULL,
    wifi_only INTEGER NOT NULL,chosen_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS backend_log_policy_user_choice_install ON backend_log_policy_user_choices(install_id,choice_sequence);
    CREATE TRIGGER IF NOT EXISTS backend_log_policy_user_choices_no_update BEFORE UPDATE ON backend_log_policy_user_choices
      BEGIN SELECT RAISE(ABORT,'explicit log policy choice is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_log_policy_user_choices_no_delete BEFORE DELETE ON backend_log_policy_user_choices
      BEGIN SELECT RAISE(ABORT,'explicit log policy choices are append only'); END;`);
  function currentIdentity() {
    const state = software.status();
    return plainObject(state) && state.signedIn === true && typeof state.ownerRef === 'string' && state.ownerRef
      && typeof state.installId === 'string' && state.installId && nonnegative(state.identityEpoch)
      ? { ownerRef: state.ownerRef, installId: state.installId, identityEpoch: state.identityEpoch } : null;
  }
  function authorizeOwner({ ownerRef }) {
    const authorized = software.authorize({ ownerRef });
    const current = currentIdentity();
    if (authorized?.then || authorized !== true && authorized?.authorized !== true || !current || current.ownerRef !== ownerRef) {
      throw problem('LEGACY_LOG_OWNER_REQUIRED', '旧日志观察需要当前正常软件身份', 403);
    }
    return { authorized: true, ...current };
  }
  const projection = createLegacyLogProjection({ store, cipher, authorizeOwner });
  const policyRestorer = createLegacyLogPolicyRestorer({ store, projection, authorizeOwner,
    targetIdentity: () => software.status(), applyWifiOnly: enabled => cloudSync.setWifiOnly(enabled) });
  function sameIdentity(expected) {
    const current = authorizeOwner({ ownerRef: expected.ownerRef });
    if (current.installId !== expected.installId || current.identityEpoch !== expected.identityEpoch) {
      throw problem('LEGACY_LOG_POLICY_IDENTITY_CHANGED', '日志策略保存期间软件身份或安装已变化', 403);
    }
    return current;
  }
  function legacyForOwner(ownerRef) {
    if (!hasTable('backend_migration_imports') || !get('SELECT 1 FROM backend_migration_imports WHERE target_owner_ref=? LIMIT 1', ownerRef)) {
      return { known: true, pending: 0, snapshot: null,
        coverage: { known: true, state: 'no_imports', scope: 'no_legacy_imports_for_owner', completeSourceQueue: true, issues: [] } };
    }
    const latest = hasTable('backend_legacy_log_snapshots') ? get(`SELECT s.* FROM backend_legacy_log_snapshots s
      JOIN backend_migration_imports i ON i.transfer_id=s.transfer_id AND i.state='imported'
      AND i.target_owner_ref=s.owner_ref AND i.target_account_ref=s.account_ref AND i.target_subject_ref=s.subject_ref
      WHERE s.owner_ref=? ORDER BY s.rowid DESC LIMIT 1`, ownerRef) : null;
    if (!latest) return { known: false, snapshot: null,
      coverage: { known: false, state: 'snapshot_missing', scope: 'legacy_imports_without_full_log_snapshot',
        completeSourceQueue: false, issues: ['LEGACY_LOG_FULL_SNAPSHOT_REQUIRED'] } };
    authorizeOwner({ ownerRef });
    let view;
    const cached = cache.get(ownerRef);
    if (cached?.transferId === latest.transfer_id) view = cached.view;
    else {
      view = projection.read({ ownerRef, accountRef: latest.account_ref, subjectRef: latest.subject_ref, transferId: latest.transfer_id });
      cache.set(ownerRef, { transferId: latest.transfer_id, view });
      if (cache.size > 16) cache.delete(cache.keys().next().value);
    }
    const known = view.completeSourceQueue === true && nonnegative(view.pending) && view.unknown === 0
      && Array.isArray(view.issues) && view.issues.length === 0;
    return { known, ...(known ? { pending: view.pending } : {}), snapshot: view,
      coverage: { known, state: known ? 'snapshot_complete' : 'snapshot_unresolved', scope: view.coverage,
        completeSourceQueue: view.completeSourceQueue === true, transferId: latest.transfer_id,
        exportedAt: latest.source_exported_at, policyKnown: view.uploadPolicy?.known === true,
        issues: view.issues.length ? view.issues : known ? [] : ['LEGACY_LOG_SNAPSHOT_UNRESOLVED'] } };
  }
  function queueView(currentQueue = cloudSync.status()) {
    if (!plainObject(currentQueue)) throw problem('LOG_QUEUE_VIEW_INVALID', '当前日志队列观察格式无效', 500);
    const { pending: rawPending, uploadPolicy: rawPolicy, ...current } = currentQueue;
    const currentKnown = nonnegative(rawPending), identity = currentIdentity();
    let legacy;
    if (!identity) legacy = { known: true, pending: 0, snapshot: null,
      coverage: { known: true, state: 'signed_out', scope: 'no_current_owner', completeSourceQueue: true, issues: [] } };
    else {
      try { legacy = legacyForOwner(identity.ownerRef); }
      catch (error) { legacy = { known: false, snapshot: null, coverage: { known: false, state: 'unavailable',
        scope: 'legacy_owner_observation_unavailable', completeSourceQueue: false, issues: [safeCode(error)] } }; }
    }
    const totalKnown = currentKnown && legacy.known && nonnegative(rawPending + legacy.pending);
    const totals = totalKnown ? { pending: rawPending + legacy.pending } : {};
    const policy = plainObject(rawPolicy) ? { ...rawPolicy } : { ...cloudSync.policy() };
    delete policy.pending;
    // The retention root travels with the queue view so a pruner never has to
    // infer consumption from a scan cursor.
    let retention;
    try { retention = cloudSync.retentionView(); }
    catch (error) { retention = { removeThroughLocalId: 0, reason: safeCode(error) }; }
    return freeze({ ...current, ...(currentKnown ? { currentPending: rawPending } : {}), ...totals,
      legacyKnown: legacy.known, ...(legacy.known ? { legacyPending: legacy.pending } : {}), legacyCoverage: legacy.coverage,
      legacySnapshot: legacy.snapshot, retention,
      uploadPolicy: { ...policy, ...(currentKnown ? { currentPending: rawPending } : {}), ...totals,
        legacyCoverage: legacy.coverage } });
  }
  const readAccount = input => projection.read(input);
  const page = input => projection.page(input);
  function restorePolicy(input) {
    for (const key of ['ownerRef', 'accountRef', 'subjectRef', 'transferId', 'commandId', 'expectedTargetInstallId']) requireText(input?.[key], key);
    if (!nonnegative(input.expectedIdentityEpoch)) throw problem('LEGACY_LOG_POLICY_IDENTITY_REQUIRED', '恢复旧日志策略需要明确目标身份代际', 400);
    const expected = { ownerRef: input.ownerRef, installId: input.expectedTargetInstallId, identityEpoch: input.expectedIdentityEpoch };
    return transaction(() => {
      sameIdentity(expected);
      // The setting belongs to the target installation. A human choice made
      // there remains explicit even if its software owner later changes.
      const chosen = get('SELECT choice_ref,chosen_at FROM backend_log_policy_user_choices WHERE install_id=? ORDER BY choice_sequence DESC LIMIT 1', expected.installId);
      if (chosen) return freeze({ applied: false, reason: 'explicit_user_choice', targetInstallId: expected.installId,
        choiceReceiptId: chosen.choice_ref, explicitChoiceAt: chosen.chosen_at, enabled: cloudSync.policy().enabled,
        oldLogsEnqueued: 0, oldCloudAcksPromoted: 0 });
      return freeze({ applied: true, ...policyRestorer.restore(input) });
    });
  }
  function savePolicy(wifiOnly) {
    if (typeof wifiOnly !== 'boolean') throw problem('UPLOAD_POLICY_INVALID', '仅Wi-Fi上传必须为布尔值', 400);
    const identity = currentIdentity();
    if (!identity) throw problem('SOFTWARE_LOGIN_REQUIRED', '保存日志上传选择需要先正常登录软件', 401);
    return transaction(() => {
      sameIdentity(identity);
      const policy = cloudSync.setWifiOnly(wifiOnly);
      if (policy?.then || policy?.enabled !== wifiOnly) throw problem('LOG_POLICY_USER_CHOICE_UNCONFIRMED', '日志策略尚未同步保存，不能记录用户选择成功', 500);
      sameIdentity(identity);
      const choiceRef = newId(), chosenAt = nowIso();
      run(`INSERT INTO backend_log_policy_user_choices(choice_ref,owner_ref,install_id,identity_epoch,wifi_only,chosen_at)
        VALUES(?,?,?,?,?,?)`, choiceRef, identity.ownerRef, identity.installId, identity.identityEpoch, Number(wifiOnly), chosenAt);
      return freeze({ ...queueView(cloudSync.status()).uploadPolicy, explicitChoice: true,
        choiceReceipt: { receiptId: choiceRef, targetInstallId: identity.installId, identityEpoch: identity.identityEpoch,
          enabled: wifiOnly, chosenAt, source: 'explicit_user_choice' } });
    });
  }
  function onImported(input) {
    if (typeof input?.ownerRef === 'string') cache.delete(input.ownerRef);
    else cache.clear();
    return { cacheInvalidated: true, policyApplied: false, oldLogsEnqueued: 0, oldCloudAcksPromoted: 0 };
  }
  return Object.freeze({ queueView, readAccount, page, restorePolicy, savePolicy, onImported });
}
