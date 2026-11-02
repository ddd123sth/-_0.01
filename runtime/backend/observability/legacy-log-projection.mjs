import { canonical, fingerprint, freeze, newId, parseStored, plainObject, problem, requireText } from '../common.mjs';
import { legacyLogTime } from './legacy-log-time.mjs';

const TABLES = new Set(['android_log_outbox', 'android_log_receipts', 'android_log_sync_state', 'android_log_gaps']);
const positive = value => Number.isSafeInteger(value) && value > 0;
const iso = value => legacyLogTime(value)?.iso || null;
const install = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const code = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : null;
const eventId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Device-only, read-only view of immutable legacy archives, never an uploader.
 * Authorize the current target owner before decrypting any archived log row.
 * A source user is established by the authenticated migration pairing, never
 * by the target cloud's numeric user ID or by a row's self-declared user_id.
 */
export function createLegacyLogProjection({ store, cipher, authorizeOwner, resolveSourceBinding = null } = {}) {
  if (!store?.get || !store?.all || typeof cipher?.decrypt !== 'function' || typeof authorizeOwner !== 'function'
    || resolveSourceBinding !== null && typeof resolveSourceBinding !== 'function') {
    throw new TypeError('Legacy log projection requires device archive decryption and current-owner authorization');
  }
  const { get, all } = store;
  const hasTable = name => Boolean(get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name));
  function authorize(input) {
    for (const key of ['ownerRef', 'accountRef', 'subjectRef']) requireText(input?.[key], key);
    if (input.transferId !== undefined && input.transferId !== null) requireText(input.transferId, 'transferId');
    const result = authorizeOwner({ ownerRef: input.ownerRef, accountRef: input.accountRef, subjectRef: input.subjectRef });
    if (result?.then || result?.authorized !== true || result.ownerRef !== input.ownerRef) {
      throw problem('LEGACY_LOG_OWNER_REQUIRED', '旧日志只读观察缺少当前软件归属证明', 403);
    }
  }
  function pairingBinding(input, imported) {
    if (hasTable('backend_legacy_log_snapshots')) {
      const snapshot = get(`SELECT * FROM backend_legacy_log_snapshots WHERE transfer_id=? AND owner_ref=?
        AND account_ref=? AND subject_ref=? AND source_owner_ref=?`, imported.transfer_id,
      input.ownerRef, input.accountRef, input.subjectRef, imported.source_owner_ref);
      if (snapshot) {
        return { authorized: true, transferId: imported.transfer_id, ownerRef: input.ownerRef, accountRef: input.accountRef,
          subjectRef: input.subjectRef, sourceOwnerRef: imported.source_owner_ref, sourceInstanceRef: snapshot.source_instance_ref,
          sourceUserId: snapshot.source_user_id, sourceInstallId: snapshot.source_install_id,
          evidenceRef: 'signed-device-log-snapshot:' + imported.transfer_id, fullSourceOwnerQueue: true,
          exportedAt: snapshot.source_exported_at, originalTransferId: snapshot.original_transfer_id,
          tablesSummary: parseStored(snapshot.manifest_json, '完整日志快照原表名册') };
      }
    }
    if (!hasTable('backend_migration_pairings') || !hasTable('backend_migration_receivers')) return null;
    const receiver = get("SELECT offer_json FROM backend_migration_receivers WHERE session_id=? AND target_owner_ref=? AND source_owner_ref=? AND state='imported'",
      imported.session_id, input.ownerRef, imported.source_owner_ref);
    if (!receiver) return null;
    const offer = parseStored(receiver.offer_json, '旧日志迁移配对请求');
    const pairing = get('SELECT * FROM backend_migration_pairings WHERE pairing_ref=? AND target_owner_ref=? AND source_owner_ref=?',
      offer.authenticationRef, input.ownerRef, imported.source_owner_ref);
    if (!pairing) return null;
    const source = parseStored(pairing.source_authentication_json, '旧日志来源软件身份');
    const descriptor = parseStored(pairing.descriptor_json, '旧日志来源描述');
    if (source.signedIn !== true || source.authorized !== true || source.sourceOwnerRef !== imported.source_owner_ref
      || source.transport !== 'authenticated-device-loopback' || !source.evidenceRef
      || descriptor.descriptorFingerprint !== offer.sourceDescriptorFingerprint
      || descriptor.sourceOwnerRef !== imported.source_owner_ref || !positive(source.userId)) return null;
    return { authorized: true, transferId: imported.transfer_id, ownerRef: input.ownerRef, accountRef: input.accountRef,
      subjectRef: input.subjectRef, sourceOwnerRef: imported.source_owner_ref, sourceInstanceRef: descriptor.sourceInstanceRef,
      sourceUserId: source.userId, sourceInstallId: source.installId || descriptor.sourceInstallId || null,
      evidenceRef: source.evidenceRef, tablesSummary: null };
  }
  function binding(input, imported) {
    const result = resolveSourceBinding ? resolveSourceBinding({ ownerRef: input.ownerRef, accountRef: input.accountRef,
      subjectRef: input.subjectRef, transferId: imported.transfer_id, sourceOwnerRef: imported.source_owner_ref,
      sessionId: imported.session_id }) : pairingBinding(input, imported);
    if (result?.then) throw problem('LEGACY_LOG_ASYNC_FORBIDDEN', '旧日志归属投影必须同步完成', 500);
    if (!plainObject(result) || result.authorized !== true || result.transferId !== imported.transfer_id
      || result.ownerRef !== input.ownerRef || result.accountRef !== input.accountRef || result.subjectRef !== input.subjectRef
      || result.sourceOwnerRef !== imported.source_owner_ref || typeof result.sourceInstanceRef !== 'string'
      || !result.sourceInstanceRef || !positive(result.sourceUserId) || typeof result.evidenceRef !== 'string' || !result.evidenceRef
      || result.sourceInstallId !== null && result.sourceInstallId !== undefined && !install(result.sourceInstallId)) return null;
    return result;
  }
  function archiveRows(input, imported, sourceBinding) {
    const result = [], issues = new Set();
    let after = '';
    for (;;) {
      const page = all(`SELECT a.* FROM backend_legacy_archives a JOIN backend_migration_imports i ON i.transfer_id=a.transfer_id
        WHERE i.state='imported' AND i.transfer_id=? AND i.target_owner_ref=? AND i.target_account_ref=? AND i.target_subject_ref=?
        AND a.target_owner_ref=i.target_owner_ref AND a.target_account_ref=i.target_account_ref AND a.target_subject_ref=i.target_subject_ref
        AND a.source_owner_ref=i.source_owner_ref AND a.source_table IN ('android_log_outbox','android_log_receipts','android_log_sync_state','android_log_gaps')
        AND a.archive_id>? ORDER BY a.archive_id LIMIT 500`, imported.transfer_id, input.ownerRef, input.accountRef, input.subjectRef, after);
      for (const archive of page) {
        if (!TABLES.has(archive.source_table) || archive.source_instance_ref !== sourceBinding.sourceInstanceRef) {
          issues.add('LEGACY_LOG_SOURCE_INSTANCE_MISMATCH'); continue;
        }
        let row;
        try {
          const text = cipher.decrypt(archive.original_row_ciphertext);
          if (typeof text !== 'string') throw new TypeError('Invalid archive plaintext');
          row = parseStored(text, '旧日志原始归档');
          if (!plainObject(row) || fingerprint(row) !== archive.source_row_fingerprint) throw new TypeError('Archive fingerprint mismatch');
        } catch { issues.add('LEGACY_LOG_ARCHIVE_INVALID'); continue; }
        result.push({ archive, row });
      }
      if (page.length < 500) break;
      after = page.at(-1).archive_id;
    }
    return { rows: result, issues };
  }
  function receiptState(row) {
    if (row.verdict === 'uploaded' && iso(row.uploaded_at)) return 'old_cloud_acknowledged';
    if (row.verdict === 'parked') return 'parked';
    return 'unknown';
  }
  function outboxState(row) {
    if (row.uploaded_at === null) return 'pending';
    if (!iso(row.uploaded_at)) return 'unknown';
    if (['accepted', 'duplicate', 'receipt-uploaded'].includes(row.last_reason)) return 'old_cloud_acknowledged';
    if (row.last_reason === 'receipt-parked' || code(row.last_reason)) return 'parked';
    return 'unknown';
  }
  function collect(input) {
    authorize(input);
    if (!hasTable('backend_legacy_archives') || !hasTable('backend_migration_imports')) {
      return { snapshots: [], records: [], issues: ['LEGACY_LOG_ARCHIVES_UNAVAILABLE'] };
    }
    const imports = all(`SELECT transfer_id,session_id,source_owner_ref FROM backend_migration_imports WHERE state='imported' AND target_owner_ref=?
      AND target_account_ref=? AND target_subject_ref=?${input.transferId ? ' AND transfer_id=?' : ''} ORDER BY transfer_id`,
    input.ownerRef, input.accountRef, input.subjectRef, ...(input.transferId ? [input.transferId] : []));
    const snapshots = [], records = new Map(), issues = new Set();
    for (const imported of imports) {
      const source = binding(input, imported);
      if (!source) { issues.add('LEGACY_LOG_SOURCE_OWNER_UNPROVED'); snapshots.push({ transferId: imported.transfer_id, known: false }); continue; }
      const data = archiveRows(input, imported, source), localIssues = data.issues;
      const outbox = data.rows.filter(item => item.archive.source_table === 'android_log_outbox');
      const receipts = data.rows.filter(item => item.archive.source_table === 'android_log_receipts');
      const states = data.rows.filter(item => item.archive.source_table === 'android_log_sync_state');
      const tableSummary = Array.isArray(source.tablesSummary) ? source.tablesSummary : [];
      if (source.fullSourceOwnerQueue === true) {
        for (const entry of tableSummary) if (!TABLES.has(entry.table) || !['read', 'absent'].includes(entry.status)
          || data.rows.filter(item => item.archive.source_table === entry.table).length !== entry.rowCount) {
          localIssues.add('LEGACY_LOG_SNAPSHOT_COVERAGE_INVALID');
        }
        if (tableSummary.length !== 4) localIssues.add('LEGACY_LOG_SNAPSHOT_COVERAGE_INVALID');
      }
      const ownerRows = outbox.filter(item => item.row.user_id === source.sourceUserId);
      const installIds = new Set(ownerRows.map(item => item.row.install_id).filter(install));
      const sourceInstallId = source.sourceInstallId || (installIds.size === 1 ? [...installIds][0] : null);
      if (installIds.size > 1) localIssues.add('LEGACY_LOG_INSTALL_CONFLICT');
      const add = (row, archive, state, sourceKind) => {
        const ref = fingerprint(['legacy-log', source.sourceInstanceRef, source.sourceOwnerRef, source.sourceUserId, sourceInstallId, row.event_id]);
        const existing = records.get(ref);
        const item = { eventRef: ref, state, sourceKind, newCloudConfirmed: false, retryAuthorized: false,
          occurredAt: iso(row.occurred_at), occurredAtOriginal: typeof row.occurred_at === 'string' ? row.occurred_at : null,
          archivedAt: archive.recorded_at, oldUploadedAt: iso(row.uploaded_at),
          oldUploadedAtOriginal: typeof row.uploaded_at === 'string' ? row.uploaded_at : null, reasonCode: code(row.last_reason),
          attempts: count(row.attempts), sourceBytes: count(row.bytes), evidenceRefs: [archive.archive_id], transferIds: [imported.transfer_id] };
        if (!existing) records.set(ref, item);
        else {
          existing.evidenceRefs.push(archive.archive_id); existing.transferIds.push(imported.transfer_id);
          // A receipt and a body can support the same verdict. Conflicting
          // observations are preserved, never ordered by target import time.
          if (existing.state !== state) { existing.state = 'unknown'; localIssues.add('LEGACY_LOG_VERDICT_CONFLICT'); }
        }
      };
      const acceptedIds = new Set();
      for (const { archive, row } of ownerRows) {
        if (!eventId(row.event_id) || !sourceInstallId || row.install_id !== sourceInstallId) { localIssues.add('LEGACY_LOG_EVENT_BINDING_INVALID'); continue; }
        acceptedIds.add(row.event_id); add(row, archive, outboxState(row), 'outbox');
      }
      for (const { archive, row } of receipts) {
        if (row.user_id !== source.sourceUserId) continue;
        if (!eventId(row.event_id) || !sourceInstallId) { localIssues.add('LEGACY_LOG_RECEIPT_INSTALL_UNPROVED'); continue; }
        // Receipt rows have no install_id. A signed source-install binding or
        // same-event outbox evidence is required; unrelated outbox rows do not
        // establish the installation of a receipt-only event.
        if (!source.sourceInstallId && !acceptedIds.has(row.event_id)) { localIssues.add('LEGACY_LOG_RECEIPT_INSTALL_UNPROVED'); continue; }
        add(row, archive, receiptState(row), 'receipt');
      }
      const policyRows = states.filter(item => item.row.key === 'upload_wifi_only');
      const policyValues = new Set(policyRows.map(item => item.row.value));
      const stateTable = tableSummary.find(item => item.table === 'android_log_sync_state');
      // A proven complete table with this key absent has the reviewed legacy
      // getState('upload_wifi_only') === '' semantics. An unexported table has
      // no such absence proof and must remain unknown.
      const missingKeyDefault = source.fullSourceOwnerQueue === true && stateTable?.status === 'read' && policyRows.length === 0
        && !localIssues.has('LEGACY_LOG_SNAPSHOT_COVERAGE_INVALID') && !localIssues.has('LEGACY_LOG_ARCHIVE_INVALID');
      const policyKnown = missingKeyDefault || policyValues.size === 1 && ['0', '1'].includes([...policyValues][0]);
      if (!policyKnown) localIssues.add(policyRows.length ? 'LEGACY_LOG_WIFI_POLICY_INVALID' : 'LEGACY_LOG_WIFI_POLICY_NOT_ARCHIVED');
      const holdRows = states.filter(item => item.row.key === 'upload_wifi_hold_since');
      const holds = new Set(holdRows.map(item => item.row.value));
      const holdSinceOriginal = holds.size === 1 && typeof [...holds][0] === 'string' ? [...holds][0] : null;
      const holdSince = iso(holdSinceOriginal);
      const manifestOutbox = tableSummary.find(item => item.table === 'android_log_outbox');
      const outboxObserved = outbox.length > 0 || manifestOutbox?.status === 'read' && manifestOutbox.rowCount === 0;
      const fullQueue = source.fullSourceOwnerQueue === true && manifestOutbox?.status === 'read'
        && !localIssues.has('LEGACY_LOG_SNAPSHOT_COVERAGE_INVALID') && !localIssues.has('LEGACY_LOG_ARCHIVE_INVALID')
        && !localIssues.has('LEGACY_LOG_SOURCE_INSTANCE_MISMATCH') && !localIssues.has('LEGACY_LOG_EVENT_BINDING_INVALID');
      snapshots.push({ transferId: imported.transfer_id, known: true, sourceInstanceRef: source.sourceInstanceRef,
        sourceInstallId, installEvidence: source.sourceInstallId ? 'authenticated-source-binding' : sourceInstallId ? 'signed-outbox-rows' : 'unknown',
        coverage: fullQueue ? 'archived_entire_source_owner_queue' : 'archived_selected_account_rows', completeSourceQueue: fullQueue,
        exportedAt: iso(source.exportedAt), exportedAtOriginal: typeof source.exportedAt === 'string' ? source.exportedAt : null,
        originalTransferId: source.originalTransferId || null, outboxObserved,
        archivedOutboxRows: outbox.length, boundOwnerOutboxRows: ownerRows.length, excludedForeignOwnerRows: outbox.length - ownerRows.length,
        archivedReceiptRows: receipts.length, archivedGapRows: data.rows.filter(item => item.archive.source_table === 'android_log_gaps').length,
        uploadPolicy: { known: policyKnown, enabled: policyKnown ? !missingKeyDefault && [...policyValues][0] === '1' : null,
          source: missingKeyDefault ? 'proven-legacy-missing-key-default' : 'archived-legacy-key',
          holdSince, holdSinceOriginal, appliesTo: 'source_installation_snapshot', automaticallyApplied: false,
          evidenceRefs: policyRows.map(item => item.archive.archive_id) },
        issues: [...localIssues] });
      for (const issue of localIssues) issues.add(issue);
    }
    if (!imports.length) issues.add('LEGACY_LOG_NO_IMPORTED_SCOPE');
    // Recheck authorization after in-device decryption before public projection.
    authorize(input);
    return { snapshots, records: [...records.values()].sort((a, b) => a.eventRef.localeCompare(b.eventRef)), issues: [...issues] };
  }
  function read(input) {
    const data = collect(input), counts = { pending: 0, oldCloudAcknowledged: 0, parked: 0, unknown: 0 };
    for (const row of data.records) counts[{ pending: 'pending', old_cloud_acknowledged: 'oldCloudAcknowledged', parked: 'parked', unknown: 'unknown' }[row.state]]++;
    const observed = data.snapshots.length > 0 && data.snapshots.every(item => item.known && item.outboxObserved);
    const completeProjection = observed && !data.issues.some(issue => issue !== 'LEGACY_LOG_WIFI_POLICY_NOT_ARCHIVED');
    const completeSourceQueue = completeProjection && data.snapshots.length === 1 && data.snapshots[0].completeSourceQueue;
    const policies = data.snapshots.filter(item => item.known).map(item => item.uploadPolicy);
    const policyKnown = policies.length > 0 && policies.length === data.snapshots.length && policies.every(item => item.known)
      && policies.every(item => item.enabled === policies[0].enabled);
    return freeze({ source: 'backend_legacy_archives', coverage: completeSourceQueue ? 'archived_entire_source_owner_queue' : 'archived_selected_account_rows', live: false,
      completeSourceQueue, pending: completeProjection ? counts.pending : null, observedPending: counts.pending,
      ...{ oldCloudAcknowledged: counts.oldCloudAcknowledged, parked: counts.parked, unknown: counts.unknown },
      newCloudConfirmed: 0, automaticallyEnqueued: 0, preservedEvents: data.records.length,
      uploadPolicy: { known: policyKnown, enabled: policyKnown ? policies[0].enabled : null, automaticallyApplied: false,
        source: 'legacy_installation_snapshot', holdSince: policyKnown && policies.length === 1 ? policies[0].holdSince : null },
      snapshots: data.snapshots, issues: data.issues });
  }
  function page({ limit = 50, afterEventRef = '', ...input }) {
    if (!positive(limit) || limit > 200 || typeof afterEventRef !== 'string' || afterEventRef && !/^[a-f0-9]{64}$/.test(afterEventRef)) {
      throw problem('LEGACY_LOG_PAGE_INVALID', '旧日志观察页大小或游标无效', 400);
    }
    const data = collect(input), selected = data.records.filter(item => item.eventRef > afterEventRef).slice(0, limit + 1), rows = selected.slice(0, limit);
    return freeze({ logs: rows, nextEventRef: selected.length > limit ? rows.at(-1)?.eventRef || null : null,
      hasMore: selected.length > limit, source: 'legacy_archived_snapshot', live: false, issues: data.issues });
  }
  return Object.freeze({ read, page });
}

/** Explicit source-selection policy migration; never called by read/page.
 * applyWifiOnly must synchronously use this same durable store transaction.
 * The original queue and its old-cloud verdicts are never modified/enqueued.
 */
export function createLegacyLogPolicyRestorer({ store, projection, authorizeOwner, targetIdentity, applyWifiOnly } = {}) {
  if (!store?.db?.exec || !store?.transaction || !store?.get || !store?.run || typeof projection?.read !== 'function'
    || typeof authorizeOwner !== 'function' || typeof targetIdentity !== 'function' || typeof applyWifiOnly !== 'function'
    || applyWifiOnly.constructor?.name === 'AsyncFunction') throw new TypeError('Legacy policy restoration requires explicit current identity and synchronous target policy application');
  const { get, run, transaction, nowIso } = store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_legacy_log_policy_receipts(
    receipt_id TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,command_id TEXT NOT NULL,request_fingerprint TEXT NOT NULL,
    transfer_id TEXT NOT NULL,source_instance_ref TEXT NOT NULL,source_install_id TEXT NOT NULL,
    target_install_id TEXT NOT NULL,target_identity_epoch INTEGER NOT NULL,wifi_only INTEGER NOT NULL,
    source_policy_evidence_json TEXT NOT NULL,applied_at TEXT NOT NULL,UNIQUE(owner_ref,command_id));
    CREATE TRIGGER IF NOT EXISTS backend_legacy_log_policy_no_update BEFORE UPDATE ON backend_legacy_log_policy_receipts
      BEGIN SELECT RAISE(ABORT,'legacy log policy receipt is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_legacy_log_policy_no_delete BEFORE DELETE ON backend_legacy_log_policy_receipts
      BEGIN SELECT RAISE(ABORT,'legacy log policy receipt is append only'); END;`);
  function assertIdentity(input) {
    const proof = authorizeOwner({ ownerRef: input.ownerRef }), identity = targetIdentity();
    if (proof?.then || proof?.authorized !== true || proof.ownerRef !== input.ownerRef || !plainObject(identity) || identity.signedIn !== true
      || identity.ownerRef !== input.ownerRef || identity.installId !== input.expectedTargetInstallId
      || identity.identityEpoch !== input.expectedIdentityEpoch) {
      throw problem('LEGACY_LOG_POLICY_IDENTITY_CHANGED', '恢复旧日志策略前目标软件身份或安装已变化', 403);
    }
  }
  function projected(row, replayed) {
    return freeze({ receiptId: row.receipt_id, ownerRef: row.owner_ref, transferId: row.transfer_id,
      sourceInstanceRef: row.source_instance_ref, sourceInstallId: row.source_install_id,
      targetInstallId: row.target_install_id, targetIdentityEpoch: row.target_identity_epoch,
      enabled: row.wifi_only === 1, appliedAt: row.applied_at, replayed, oldLogsEnqueued: 0, oldCloudAcksPromoted: 0 });
  }
  function restore(input) {
    for (const key of ['ownerRef', 'accountRef', 'subjectRef', 'transferId', 'commandId', 'expectedTargetInstallId']) requireText(input?.[key], key);
    if (!Number.isSafeInteger(input.expectedIdentityEpoch) || input.expectedIdentityEpoch < 0) throw problem('LEGACY_LOG_POLICY_IDENTITY_REQUIRED', '旧策略映射需要明确目标身份代际', 400);
    assertIdentity(input);
    const requestFingerprint = fingerprint({ ownerRef: input.ownerRef, accountRef: input.accountRef, subjectRef: input.subjectRef,
      transferId: input.transferId, expectedTargetInstallId: input.expectedTargetInstallId, expectedIdentityEpoch: input.expectedIdentityEpoch });
    return transaction(() => {
      assertIdentity(input);
      const existing = get('SELECT * FROM backend_legacy_log_policy_receipts WHERE owner_ref=? AND command_id=?', input.ownerRef, input.commandId);
      if (existing) {
        if (existing.request_fingerprint !== requestFingerprint) throw problem('LEGACY_LOG_POLICY_COMMAND_CONFLICT', '同一旧策略映射指令不能选择另一来源或目标安装', 409);
        return projected(existing, true);
      }
      const view = projection.read({ ownerRef: input.ownerRef, accountRef: input.accountRef, subjectRef: input.subjectRef, transferId: input.transferId });
      const source = view.snapshots?.length === 1 ? view.snapshots[0] : null;
      if (!source?.known || !source.completeSourceQueue || !source.sourceInstallId || !source.uploadPolicy?.known
        || typeof source.uploadPolicy.enabled !== 'boolean' || !view.completeSourceQueue) {
        throw problem('LEGACY_LOG_POLICY_SOURCE_UNPROVED', '旧日志策略恢复必须明确选择完整、已验证的源安装日志快照', 409);
      }
      assertIdentity(input);
      const applied = applyWifiOnly(source.uploadPolicy.enabled);
      if (applied?.then || applied?.enabled !== source.uploadPolicy.enabled) throw problem('LEGACY_LOG_POLICY_APPLY_UNCONFIRMED', '目标日志策略尚未同步保存，不能写映射成功收据', 500);
      assertIdentity(input);
      const receiptId = newId();
      run(`INSERT INTO backend_legacy_log_policy_receipts(receipt_id,owner_ref,command_id,request_fingerprint,transfer_id,
        source_instance_ref,source_install_id,target_install_id,target_identity_epoch,wifi_only,source_policy_evidence_json,applied_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, receiptId, input.ownerRef, input.commandId, requestFingerprint, input.transferId,
      source.sourceInstanceRef, source.sourceInstallId, input.expectedTargetInstallId, input.expectedIdentityEpoch,
      Number(source.uploadPolicy.enabled), canonical({ evidenceRefs: source.uploadPolicy.evidenceRefs, source: source.uploadPolicy.source,
        exportedAt: source.exportedAt, originalTransferId: source.originalTransferId }), nowIso());
      return projected(get('SELECT * FROM backend_legacy_log_policy_receipts WHERE receipt_id=?', receiptId), false);
    });
  }
  return Object.freeze({ restore });
}
