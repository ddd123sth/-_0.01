import { canonical, fingerprint, freeze, parseStored, plainObject, problem, requireText } from '../common.mjs';
import { validateSourceDescriptor } from '../migration/crypto.mjs';
import { resolveArchivedSourceInstallBinding } from '../migration/evidence-digests.mjs';
import { legacyLogTime } from './legacy-log-time.mjs';
import { canonicalLogCategories, canonicalLogCategory, logCategoryAliases } from './log-categories.mjs';

const UNKNOWN_CATEGORY = '历史未分类';
const INVALID_TIME = Number.MIN_SAFE_INTEGER;
const positive = value => Number.isSafeInteger(value) && value > 0;
const safeCode = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
  ? error.code : 'LEGACY_HISTORY_SOURCE_UNPROVED';

// Presentation-only redaction. Keep the original sentence, line breaks and
// result wording; no old event classifier/customerTimelineRow is called.
function redact(value) {
  if (typeof value !== 'string') return null;
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/((?:["']?)(?:password|passwd|pwd|token|[a-z_-]*token|authorization|cookie|credential|secret|client_secret|openid|open_id|mdSession1|session1|session_id|sessionid|signature|sign|uuid|username|user_name|loginname|密码|口令|凭据|游戏账号|登录账号|会话令牌)(?:["']?)\s*[:=：]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;；，。}\]）)]+)/giu, '$1[已隐藏]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;；，。]+/giu, '[已隐藏]')
    .replace(/\b(?:https?|wss?|socks[45]?)\s*:\/\/[^\s，、；。)）"']+/giu, '[网络地址已隐藏]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/gu, '[网络地址已隐藏]')
    .replace(/(?:\[[a-f0-9:]*:[a-f0-9:]+\](?::\d{1,5})?|\b(?:[a-f0-9]{0,4}:){3,}[a-f0-9:]+\b)/giu, '[网络地址已隐藏]')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,63}(?::\d{1,5})?(?:\/[^\s，、；。)）"']*)?/giu, '[网络地址已隐藏]')
    .replace(/\b[a-f0-9]{24,}\b/giu, '[已隐藏]')
    .replace(/\b[A-Za-z0-9+/_=-]{48,}\b/gu, '[已隐藏]');
}
function pageSize(value) {
  const size = Number(value);
  if (!positive(size) || size > 100) throw problem('LOG_PAGE_INVALID', '日志页大小无效', 400);
  return size;
}
function cursor(value) {
  if (value === null || value === undefined || value === '' || value === 0 || value === '0') return null;
  const number = Number(value);
  if (!positive(number)) throw problem('LOG_CURSOR_INVALID', '日志游标无效', 400);
  return number;
}
const escapeLike = value => String(value).replace(/[\\%_]/g, '\\$&');
function timeBound(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) throw problem('LOG_TIME_FILTER_INVALID', `${label}时间范围无效`, 400);
  return new Date(ms).toISOString();
}
function shanghaiDayBounds(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw problem('LOG_DAY_INVALID', '日志日期无效', 400);
  const utcMidnight = Date.parse(day + 'T00:00:00.000Z');
  if (!Number.isFinite(utcMidnight) || new Date(utcMidnight).toISOString().slice(0, 10) !== day) throw problem('LOG_DAY_INVALID', '日志日期无效', 400);
  return [new Date(utcMidnight - 8 * 60 * 60 * 1000).toISOString(), new Date(utcMidnight + 16 * 60 * 60 * 1000).toISOString()];
}

/** Device-only immutable projection of individually sealed original log rows.
 * Archive ownership and normal source-install proof precede decryption. No
 * envelope, account credential, old planner or old business projection is read.
 */
export function createLegacyHistory({ store, cipher, authorizeOwner } = {}) {
  if (!store?.db?.exec || !store?.get || !store?.all || !store?.run || !store?.transaction
    || typeof store?.nowIso !== 'function' || typeof cipher?.decrypt !== 'function' || typeof authorizeOwner !== 'function') {
    throw new TypeError('Legacy history requires a durable device store, row cipher and synchronous owner authorization');
  }
  const { get, all, run, transaction, nowIso } = store;
  const visible = `EXISTS(SELECT 1 FROM backend_legacy_log_history_sources s
    JOIN backend_migration_imports i ON i.transfer_id=s.transfer_id AND i.state='imported'
    JOIN backend_migration_receivers r ON r.session_id=i.session_id AND r.state='imported'
      AND r.target_owner_ref=i.target_owner_ref AND r.source_owner_ref=i.source_owner_ref
    JOIN backend_legacy_archives a ON a.archive_id=s.archive_id AND a.transfer_id=i.transfer_id
    WHERE s.index_id=h.index_id AND s.outcome='indexed' AND s.owner_ref=h.owner_ref
    AND s.account_ref=h.account_ref AND s.subject_ref=h.subject_ref AND s.source_origin_ref=h.source_origin_ref
    AND s.source_row_fingerprint=h.source_row_fingerprint AND a.source_row_fingerprint=h.source_row_fingerprint
    AND i.target_owner_ref=h.owner_ref AND i.target_account_ref=h.account_ref AND i.target_subject_ref=h.subject_ref
    AND a.target_owner_ref=h.owner_ref AND a.target_account_ref=h.account_ref AND a.target_subject_ref=h.subject_ref
    AND a.source_owner_ref=i.source_owner_ref AND a.source_table=h.source_table
    AND a.source_primary_key_json=h.source_primary_key_json)`;
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_legacy_log_history(
    index_id INTEGER PRIMARY KEY AUTOINCREMENT,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    source_origin_ref TEXT NOT NULL,source_install_id TEXT NOT NULL,source_table TEXT NOT NULL,source_primary_key_json TEXT NOT NULL,
    source_row_fingerprint TEXT NOT NULL,source_timestamp_original TEXT,occurred_at TEXT,sort_time_ms INTEGER NOT NULL,
    source_level TEXT,source_category TEXT,display_category TEXT NOT NULL,message TEXT,issues_json TEXT NOT NULL,indexed_at TEXT NOT NULL,
    UNIQUE(owner_ref,account_ref,subject_ref,source_origin_ref,source_table,source_primary_key_json,source_row_fingerprint));
    CREATE INDEX IF NOT EXISTS backend_legacy_log_history_scope ON backend_legacy_log_history(owner_ref,account_ref,subject_ref,sort_time_ms,index_id);
    CREATE INDEX IF NOT EXISTS backend_legacy_log_history_filters ON backend_legacy_log_history(owner_ref,account_ref,subject_ref,display_category,occurred_at);
    CREATE TABLE IF NOT EXISTS backend_legacy_log_history_sources(
    archive_id TEXT PRIMARY KEY,transfer_id TEXT NOT NULL,index_id INTEGER REFERENCES backend_legacy_log_history(index_id),
    owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    source_origin_ref TEXT NOT NULL,source_row_fingerprint TEXT NOT NULL,outcome TEXT NOT NULL,issue_code TEXT,recorded_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS backend_legacy_log_history_sources_scope ON backend_legacy_log_history_sources(owner_ref,account_ref,subject_ref,transfer_id);
    CREATE INDEX IF NOT EXISTS backend_legacy_log_history_sources_index ON backend_legacy_log_history_sources(index_id,outcome);
    CREATE TABLE IF NOT EXISTS backend_legacy_log_history_progress(
    owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,progress_json TEXT NOT NULL,updated_at TEXT NOT NULL,
    PRIMARY KEY(owner_ref,account_ref,subject_ref));
    CREATE TABLE IF NOT EXISTS backend_legacy_log_history_imports(
    transfer_id TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    source_origin_ref TEXT NOT NULL,completed_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS backend_legacy_log_history_no_update BEFORE UPDATE ON backend_legacy_log_history
      BEGIN SELECT RAISE(ABORT,'legacy history index is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_legacy_log_history_no_delete BEFORE DELETE ON backend_legacy_log_history
      BEGIN SELECT RAISE(ABORT,'legacy history index is append only'); END;
    CREATE TRIGGER IF NOT EXISTS backend_legacy_log_history_sources_no_update BEFORE UPDATE ON backend_legacy_log_history_sources
      BEGIN SELECT RAISE(ABORT,'legacy history source receipt is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_legacy_log_history_sources_no_delete BEFORE DELETE ON backend_legacy_log_history_sources
      BEGIN SELECT RAISE(ABORT,'legacy history sources are append only'); END;
    CREATE TRIGGER IF NOT EXISTS backend_legacy_log_history_imports_no_update BEFORE UPDATE ON backend_legacy_log_history_imports
      BEGIN SELECT RAISE(ABORT,'legacy history completed import is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_legacy_log_history_imports_no_delete BEFORE DELETE ON backend_legacy_log_history_imports
      BEGIN SELECT RAISE(ABORT,'legacy history completed imports are append only'); END;`);
  const hasTable = table => Boolean(get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table));
  const jobs = new Map();
  let closed = false, scheduled = null, scheduledKind = null, scheduledAt = 0, archiveIndexesReady = false;
  const scopeKey = input => canonical([input.ownerRef, input.accountRef, input.subjectRef, input.readOnlyArchive === true]);
  const tablesAvailable = () => ['backend_migration_imports', 'backend_migration_receivers', 'backend_legacy_archives', 'backend_migration_pairings'].every(hasTable);
  function authorize(input) {
    if (closed) throw problem('LEGACY_HISTORY_CLOSED', '历史日志索引已关闭', 503);
    for (const key of ['ownerRef', 'accountRef', 'subjectRef']) requireText(input?.[key], key);
    const proof = authorizeOwner({ ownerRef: input.ownerRef, accountRef: input.accountRef, subjectRef: input.subjectRef });
    if (proof?.then || proof !== true && (proof?.authorized !== true || proof.ownerRef !== input.ownerRef)) {
      throw problem('LEGACY_HISTORY_OWNER_REQUIRED', '历史日志需要当前正常软件归属证明', 403);
    }
    const archive = input.includeRemoved === true && input.readOnlyArchive === true;
    if ((input.includeRemoved === true || input.readOnlyArchive === true) && !archive) throw problem('LEGACY_HISTORY_ARCHIVE_SCOPE_INVALID', '历史来源需要明确的只读归档权限', 403);
    const account = get('SELECT subject_ref FROM backend_accounts WHERE owner_ref=? AND account_id=? AND removed_at IS ' + (archive ? 'NOT NULL' : 'NULL'), input.ownerRef, Number(input.accountRef));
    if (!account || account.subject_ref !== input.subjectRef) throw problem('LEGACY_HISTORY_ACCOUNT_OUT_OF_SCOPE', '历史日志不属于当前软件身份和游戏主体', 403);
  }
  function sourceBinding(imported, input) {
    const offer = parseStored(imported.offer_json, '历史日志来源请求');
    if (!plainObject(offer)) throw problem('LEGACY_HISTORY_SOURCE_UNPROVED', '历史日志来源请求不完整', 409);
    const pairing = get(`SELECT descriptor_json,source_authentication_json FROM backend_migration_pairings
      WHERE pairing_ref=? AND target_owner_ref=? AND source_owner_ref=?`, offer.authenticationRef, input.ownerRef, imported.source_owner_ref);
    if (!pairing) throw problem('LEGACY_HISTORY_SOURCE_UNPROVED', '历史日志缺少正常来源配对', 409);
    const descriptor = parseStored(pairing.descriptor_json, '历史日志来源描述');
    const authentication = parseStored(pairing.source_authentication_json, '历史日志来源身份');
    validateSourceDescriptor(descriptor);
    if (!plainObject(authentication) || authentication.signedIn !== true || authentication.authorized !== true
      || authentication.sourceOwnerRef !== imported.source_owner_ref || authentication.transport !== 'authenticated-device-loopback'
      || !authentication.evidenceRef || offer.sessionId !== imported.session_id || offer.targetOwnerRef !== input.ownerRef
      || offer.sourceOwnerRef !== imported.source_owner_ref || descriptor.sourceOwnerRef !== imported.source_owner_ref
      || descriptor.sourceAppId !== offer.sourceAppId || descriptor.sourceCloudRef !== offer.sourceCloudRef
      || descriptor.descriptorFingerprint !== offer.sourceDescriptorFingerprint) {
      throw problem('LEGACY_HISTORY_SOURCE_UNPROVED', '历史日志来源描述与正常迁入归属不符', 409);
    }
    const binding = resolveArchivedSourceInstallBinding({ get, ownerRef: input.ownerRef, transferId: imported.transfer_id,
      offer, descriptor, authentication });
    if (!/^[a-f0-9]{32}$/.test(binding?.installId || '')) throw problem('LEGACY_HISTORY_INSTALL_UNPROVED', '历史日志来源安装尚未核实', 409);
    return { instanceRef: descriptor.sourceInstanceRef, installId: binding.installId,
      originRef: fingerprint({ source_app_id: offer.sourceAppId, source_cloud_ref: offer.sourceCloudRef,
        source_owner_ref: imported.source_owner_ref, source_install_id: binding.installId }) };
  }
  function indexArchive(archive, source, input) {
    let original, pk, failure = null;
    try {
      const text = cipher.decrypt(archive.original_row_ciphertext);
      if (typeof text !== 'string') throw new Error('Invalid plaintext type');
      original = parseStored(text, '历史日志原行');
      pk = parseStored(archive.source_primary_key_json, '历史日志原主键');
      if (!plainObject(original) || fingerprint(original) !== archive.source_row_fingerprint || !plainObject(pk)
        || !positive(original.id) || canonical(pk) !== canonical({ id: original.id }) || !positive(original.account_id)
        || archive.source_table === 'run_logs' && !positive(original.run_id)) failure = 'LEGACY_HISTORY_ROW_INTEGRITY_INVALID';
    } catch { failure = 'LEGACY_HISTORY_ROW_DECRYPT_OR_SHA_INVALID'; }
    if (archive.source_instance_ref !== source.instanceRef) failure = 'LEGACY_HISTORY_SOURCE_INSTANCE_MISMATCH';
    let indexId = null;
    if (!failure) {
      const timestamp = legacyLogTime(original.ts), issues = [];
      if (!timestamp) issues.push('LEGACY_HISTORY_TIMESTAMP_INVALID');
      if (typeof original.message !== 'string') issues.push('LEGACY_HISTORY_MESSAGE_INVALID');
      if (typeof original.level !== 'string') issues.push('LEGACY_HISTORY_LEVEL_MISSING');
      const category = typeof original.category === 'string' && original.category.trim() ? redact(original.category) : null;
      const identity = [input.ownerRef, input.accountRef, input.subjectRef, source.originRef, archive.source_table, canonical(pk), archive.source_row_fingerprint];
      const existing = get(`SELECT index_id FROM backend_legacy_log_history WHERE owner_ref=? AND account_ref=? AND subject_ref=?
        AND source_origin_ref=? AND source_table=? AND source_primary_key_json=? AND source_row_fingerprint=?`, ...identity);
      if (existing) indexId = existing.index_id;
      else {
        const inserted = run(`INSERT INTO backend_legacy_log_history(owner_ref,account_ref,subject_ref,source_origin_ref,source_install_id,source_table,
          source_primary_key_json,source_row_fingerprint,source_timestamp_original,occurred_at,sort_time_ms,source_level,source_category,
          display_category,message,issues_json,indexed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        input.ownerRef, input.accountRef, input.subjectRef, source.originRef, source.installId, archive.source_table, canonical(pk),
        archive.source_row_fingerprint, typeof original.ts === 'string' ? redact(original.ts) : null, timestamp?.iso || null,
        timestamp ? Date.parse(timestamp.iso) : INVALID_TIME, typeof original.level === 'string' ? redact(original.level) : null,
        category, category || UNKNOWN_CATEGORY, redact(original.message), canonical(issues), nowIso());
        indexId = Number(inserted.lastInsertRowid);
      }
    }
    run(`INSERT INTO backend_legacy_log_history_sources(archive_id,transfer_id,index_id,owner_ref,account_ref,subject_ref,
      source_origin_ref,source_row_fingerprint,outcome,issue_code,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, archive.archive_id,
    archive.transfer_id, indexId, input.ownerRef, input.accountRef, input.subjectRef, source.originRef,
    archive.source_row_fingerprint, failure ? 'invalid' : 'indexed', failure, nowIso());
    return { indexId, outcome: failure ? 'invalid' : 'indexed', issueCode: failure };
  }
  const importScope = `i.state='imported' AND i.target_owner_ref=? AND i.target_account_ref=? AND i.target_subject_ref=?
    AND EXISTS(SELECT 1 FROM backend_migration_receivers r WHERE r.session_id=i.session_id AND r.state='imported'
      AND r.target_owner_ref=i.target_owner_ref AND r.source_owner_ref=i.source_owner_ref)
    AND EXISTS(SELECT 1 FROM backend_legacy_archives a WHERE a.transfer_id=i.transfer_id AND a.target_owner_ref=i.target_owner_ref
      AND a.target_account_ref=i.target_account_ref AND a.target_subject_ref=i.target_subject_ref AND a.source_owner_ref=i.source_owner_ref
      AND a.source_table IN ('android_local_logs','run_logs'))`;
  const parameters = input => [input.ownerRef, input.accountRef, input.subjectRef];
  const nextPendingImport = input => get(`SELECT i.rowid AS import_sequence,i.transfer_id FROM backend_migration_imports i WHERE ${importScope}
    AND NOT EXISTS(SELECT 1 FROM backend_legacy_log_history_imports done WHERE done.transfer_id=i.transfer_id
      AND done.owner_ref=i.target_owner_ref AND done.account_ref=i.target_account_ref AND done.subject_ref=i.target_subject_ref)
    ORDER BY i.rowid LIMIT 1`, ...parameters(input));
  function readProgress(input) {
    const row = get('SELECT progress_json FROM backend_legacy_log_history_progress WHERE owner_ref=? AND account_ref=? AND subject_ref=?', ...parameters(input));
    const value = row ? parseStored(row.progress_json, '历史日志索引断点') : null;
    return value?.version === 3 ? value : null;
  }
  function initialProgress() {
    return { version: 3, state: 'indexing', afterImportSequence: 0,
      currentImportSequence: null, currentTransferId: null, currentSourceTable: 'android_local_logs', afterArchiveId: '', importedLogSnapshots: 0,
      processedArchiveRows: 0, indexedArchiveRows: 0, invalidArchiveRows: 0, preservedRows: null,
      conflictKeys: [], issues: [], days: [], categories: [], blockingIssue: null };
  }
  function writeProgress(input, progress) {
    run(`INSERT INTO backend_legacy_log_history_progress(owner_ref,account_ref,subject_ref,progress_json,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(owner_ref,account_ref,subject_ref) DO UPDATE SET progress_json=excluded.progress_json,updated_at=excluded.updated_at`,
    ...parameters(input), canonical(progress), nowIso());
  }
  function coverage(progress) {
    const ready = progress.state === 'ready', issues = [...new Set([...progress.issues, ...(progress.blockingIssue ? [progress.blockingIssue] : [])])];
    if (progress.conflictKeys.length) issues.push('LEGACY_HISTORY_SOURCE_PK_CONFLICT');
    const reason = ready ? issues.length ? 'legacy_history_incomplete' : null
      : progress.state === 'awaiting_source' ? 'legacy_history_source_unproved' : progress.state === 'failed' ? 'legacy_history_index_failed' : 'legacy_history_indexing';
    return { historical: true, live: false, scope: 'imported_account_archives', sourceCoverage: 'legacy_account_selected_export',
      state: ready ? issues.length ? 'incomplete' : 'archived_rows_indexed' : progress.state, reason,
      indexingComplete: ready, completeArchivedRows: ready && !issues.length, importedLogSnapshots: progress.importedLogSnapshots,
      processedArchiveRows: progress.processedArchiveRows, ...(ready ? { archiveRows: progress.processedArchiveRows } : {}),
      indexedArchiveRows: progress.indexedArchiveRows, invalidArchiveRows: progress.invalidArchiveRows,
      ...(progress.preservedRows !== null ? { preservedRows: progress.preservedRows } : {}), conflicts: progress.conflictKeys.length, issues,
      continuation: { required: !ready, reason, retryAfterMs: ready ? null : 1000, restartFromHead: !ready } };
  }
  function clearScheduled() {
    if (scheduled) { if (scheduledKind === 'immediate') clearImmediate(scheduled); else clearTimeout(scheduled); }
    scheduled = null; scheduledKind = null; scheduledAt = 0;
  }
  function arm() {
    if (closed || !jobs.size) { clearScheduled(); return; }
    const due = Math.min(...[...jobs.values()].map(job => job.due));
    if (scheduled && scheduledAt <= due) return;
    clearScheduled(); scheduledAt = due;
    const delay = Math.max(0, due - performance.now());
    scheduledKind = delay ? 'timeout' : 'immediate';
    scheduled = delay ? setTimeout(pump, delay) : setImmediate(pump);
    scheduled.unref?.();
  }
  function wake(input) {
    const key = scopeKey(input), job = jobs.get(key);
    if (job) { job.due = performance.now(); job.progress = null; job.source = null; }
    else jobs.set(key, { input, due: performance.now(), progress: null, source: null });
    arm();
  }
  function rememberRow(progress, row, input) {
    progress.processedArchiveRows++;
    if (row.outcome === 'indexed') {
      progress.indexedArchiveRows++;
      const indexed = get(`SELECT h.occurred_at,h.display_category,EXISTS(SELECT 1 FROM backend_legacy_log_history other
        WHERE other.owner_ref=h.owner_ref AND other.account_ref=h.account_ref AND other.subject_ref=h.subject_ref
        AND other.source_origin_ref=h.source_origin_ref AND other.source_table=h.source_table
        AND other.source_primary_key_json=h.source_primary_key_json AND other.source_row_fingerprint<>h.source_row_fingerprint) AS conflict
        FROM backend_legacy_log_history h WHERE h.index_id=? AND h.owner_ref=? AND h.account_ref=? AND h.subject_ref=?`, row.indexId, ...parameters(input));
      if (indexed) {
        if (!progress.categories.includes(indexed.display_category)) progress.categories.push(indexed.display_category);
        if (indexed.occurred_at) {
          const day = new Date(Date.parse(indexed.occurred_at) + 8 * 3600_000).toISOString().slice(0, 10);
          if (!progress.days.includes(day)) progress.days = [...progress.days, day].sort().reverse().slice(0, 90);
        }
        if (indexed.conflict) {
          const conflictKey = fingerprint([row.sourceOriginRef, row.sourceTable, row.sourcePrimaryKeyJson]);
          if (!progress.conflictKeys.includes(conflictKey)) progress.conflictKeys.push(conflictKey);
        }
      }
    } else {
      progress.invalidArchiveRows++;
      if (row.issueCode && !progress.issues.includes(row.issueCode)) progress.issues.push(row.issueCode);
    }
  }
  function step(job) {
    const input = job.input;
    authorize(input);
    if (!tablesAvailable()) throw problem('LEGACY_HISTORY_ARCHIVES_UNAVAILABLE', '历史日志归档尚未就绪', 409);
    if (!archiveIndexesReady) {
      // These cover source visibility and chunk scans; neither index contains
      // any new plaintext or changes an original archived row.
      store.db.exec(`CREATE INDEX IF NOT EXISTS backend_legacy_log_history_archive_scan ON backend_legacy_archives(transfer_id,source_table,archive_id);
        CREATE INDEX IF NOT EXISTS backend_legacy_log_history_import_scope ON backend_migration_imports(target_owner_ref,target_account_ref,target_subject_ref,state);`);
      archiveIndexesReady = true;
      return;
    }
    if (!job.progress) {
      const next = nextPendingImport(input), previous = readProgress(input);
      job.progress = previous || initialProgress();
      if (previous?.state === 'ready' && !next) return true;
      if (previous?.state === 'ready') {
        job.progress.currentImportSequence = null; job.progress.currentTransferId = null; job.progress.afterArchiveId = '';
      }
      job.progress.state = 'indexing'; job.progress.blockingIssue = null; job.progress.preservedRows = null;
    }
    const progress = job.progress;
    if (!progress.currentTransferId) {
      const next = nextPendingImport(input);
      if (!next) {
        // One indexed count at completion; no per-page full-table aggregates.
        progress.preservedRows = get('SELECT COUNT(*) AS n FROM backend_legacy_log_history WHERE owner_ref=? AND account_ref=? AND subject_ref=?', ...parameters(input)).n;
        progress.state = 'ready'; progress.blockingIssue = null;
        transaction(() => writeProgress(input, progress));
        return true;
      }
      progress.currentTransferId = next.transfer_id; progress.currentImportSequence = next.import_sequence;
      progress.currentSourceTable = 'android_local_logs'; progress.afterArchiveId = '';
      progress.importedLogSnapshots++; job.source = null;
    }
    const imported = get(`SELECT i.transfer_id,i.session_id,i.source_owner_ref,r.offer_json FROM backend_migration_imports i
      JOIN backend_migration_receivers r ON r.session_id=i.session_id AND r.state='imported'
      AND r.target_owner_ref=i.target_owner_ref AND r.source_owner_ref=i.source_owner_ref
      WHERE i.transfer_id=? AND i.state='imported' AND i.target_owner_ref=? AND i.target_account_ref=? AND i.target_subject_ref=?`,
    progress.currentTransferId, ...parameters(input));
    if (!imported) throw problem('LEGACY_HISTORY_IMPORT_CHANGED', '历史日志迁入状态变化，索引已暂停', 409);
    if (!job.source) {
      try { job.source = sourceBinding(imported, input); progress.state = 'indexing'; progress.blockingIssue = null; }
      catch (error) {
        progress.state = 'awaiting_source'; progress.blockingIssue = safeCode(error);
        transaction(() => writeProgress(input, progress)); job.due = performance.now() + 5000; return;
      }
    }
    const batch = all(`SELECT a.*,s.index_id AS saved_index_id,s.outcome AS saved_outcome,s.issue_code AS saved_issue_code
      FROM backend_legacy_archives a LEFT JOIN backend_legacy_log_history_sources s ON s.archive_id=a.archive_id
      AND s.transfer_id=a.transfer_id AND s.owner_ref=a.target_owner_ref AND s.account_ref=a.target_account_ref
      AND s.subject_ref=a.target_subject_ref AND s.source_row_fingerprint=a.source_row_fingerprint AND s.source_origin_ref=?
      WHERE a.transfer_id=? AND a.target_owner_ref=? AND a.target_account_ref=? AND a.target_subject_ref=? AND a.source_owner_ref=?
      AND a.source_table=? AND a.archive_id>? ORDER BY a.archive_id LIMIT 32`,
    job.source.originRef, imported.transfer_id, ...parameters(input), imported.source_owner_ref, progress.currentSourceTable || 'android_local_logs', progress.afterArchiveId);
    const started = performance.now(); let processed = 0;
    const beforeBatch = JSON.parse(canonical(progress));
    try { transaction(() => {
      for (const archive of batch) {
        const row = archive.saved_outcome ? { indexId: archive.saved_index_id, outcome: archive.saved_outcome, issueCode: archive.saved_issue_code }
          : indexArchive(archive, job.source, input);
        rememberRow(progress, { ...row, sourceOriginRef: job.source.originRef, sourceTable: archive.source_table,
          sourcePrimaryKeyJson: archive.source_primary_key_json }, input);
        progress.afterArchiveId = archive.archive_id; processed++;
        if (performance.now() - started >= 8) break;
      }
      if (processed === batch.length && batch.length < 32) {
        if ((progress.currentSourceTable || 'android_local_logs') === 'android_local_logs') {
          progress.currentSourceTable = 'run_logs'; progress.afterArchiveId = '';
        } else {
          run(`INSERT INTO backend_legacy_log_history_imports(transfer_id,owner_ref,account_ref,subject_ref,source_origin_ref,completed_at)
            VALUES(?,?,?,?,?,?)`, progress.currentTransferId, ...parameters(input), job.source.originRef, nowIso());
          progress.afterImportSequence = progress.currentImportSequence; progress.currentImportSequence = null;
          progress.currentTransferId = null; progress.currentSourceTable = 'android_local_logs'; progress.afterArchiveId = ''; job.source = null;
        }
      }
      authorize(input); writeProgress(input, progress);
    }); } catch (error) { job.progress = beforeBatch; throw error; }
  }
  function pump() {
    scheduled = null; scheduledKind = null; scheduledAt = 0;
    if (closed) return;
    const entry = [...jobs].find(([, job]) => job.due <= performance.now());
    if (!entry) { arm(); return; }
    const [key, job] = entry;
    jobs.delete(key);
    try {
      const done = step(job);
      if (!done && !closed) { job.due = Math.max(job.due, performance.now() + 15); jobs.set(key, job); }
    } catch (error) {
      // Authorization/identity changes stop this job. A later authorized page
      // can resume the durable checkpoint, never an old timer on a new owner.
      if (job.progress) {
        job.progress.state = 'failed'; job.progress.blockingIssue = safeCode(error);
        try { writeProgress(job.input, job.progress); } catch { /* No assumed durable progress after a failed commit. */ }
      }
    }
    arm();
  }
  function ensureIndexed(ownerRef, accountRef, subjectRef, access = {}) {
    const input = { ownerRef, accountRef, subjectRef, includeRemoved: access.includeRemoved === true, readOnlyArchive: access.readOnlyArchive === true };
    authorize(input);
    if (!tablesAvailable()) return freeze({ historical: true, live: false, scope: 'imported_account_archives',
      state: 'archives_unavailable', indexingComplete: false, completeArchivedRows: false, reason: 'legacy_history_archives_unavailable',
      continuation: { required: true, reason: 'legacy_history_archives_unavailable', retryAfterMs: 1000, restartFromHead: true },
      issues: ['LEGACY_HISTORY_ARCHIVES_UNAVAILABLE'] });
    const pending = nextPendingImport(input), previous = readProgress(input), active = jobs.get(scopeKey(input));
    if (previous?.state === 'ready' && !pending) return freeze(coverage(previous));
    if (!active) wake(input);
    const progress = active?.progress || previous || initialProgress();
    if (progress.state === 'ready') return freeze(coverage({ ...progress, state: 'indexing', preservedRows: null }));
    return freeze(coverage(progress));
  }
  function project(row) {
    return { id: row.index_id, businessId: row.index_id, at: row.occurred_at, ts: row.occurred_at,
      level: row.source_level, message: row.message ?? '[历史日志原消息格式无效]', category: canonicalLogCategory(row.display_category),
      origin: 'legacy_' + row.source_table, historical: true,
      detail: { historical: true, sourceTable: row.source_table, sourceOriginRef: row.source_origin_ref,
        sourceRowFingerprint: row.source_row_fingerprint, sourcePrimaryKey: parseStored(row.source_primary_key_json, '历史日志主键'),
        sourceTimestampOriginal: row.source_timestamp_original, sourceCategory: row.source_category,
        indexedDisplayCategory: row.display_category, sourceLevel: row.source_level,
        categorySource: row.source_category === null ? 'missing_source_category' : 'original_source_category',
        issues: parseStored(row.issues_json, '历史日志格式观察'), sourceConflict: row.conflict_count > 1 } };
  }
  function selectUploadSources({ ownerRef, accountRef, subjectRef, limit = 10000, ...filters } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw problem('LOG_MANUAL_SELECTION_TOO_LARGE', '历史日志筛选范围超过单次上传上限', 413);
    const selected = [];
    let beforeBusinessId = null;
    for (;;) {
      const result = page({ ownerRef, accountRef, subjectRef, ...filters, limit: Math.min(100, limit - selected.length), beforeBusinessId });
      if (!result.page.complete || !result.page.hasMoreComplete) throw problem('LOG_HISTORY_SELECTION_INCOMPLETE', '历史日志索引尚未完整，不能声称已选择全部匹配记录', 409);
      selected.push(...result.logs.map(row => ({ kind: 'history', indexId: row.id,
        subjectRef, sourceOriginRef: row.detail.sourceOriginRef, sourceRowFingerprint: row.detail.sourceRowFingerprint,
        includeRemoved: filters.includeRemoved === true, readOnlyArchive: filters.readOnlyArchive === true })));
      if (selected.length > limit) throw problem('LOG_MANUAL_SELECTION_TOO_LARGE', '历史日志筛选范围超过单次上传上限', 413);
      if (!result.page.hasMore) break;
      if (selected.length >= limit) throw problem('LOG_MANUAL_SELECTION_TOO_LARGE', '历史日志筛选范围超过单次上传上限', 413);
      beforeBusinessId = result.page.older.businessId;
    }
    return selected;
  }
  function manualUploadRow({ ownerRef, accountRef, subjectRef, indexId, sourceOriginRef, sourceRowFingerprint,
    includeRemoved = false, readOnlyArchive = false } = {}) {
    const input = { ownerRef, accountRef: String(accountRef), subjectRef, includeRemoved, readOnlyArchive };
    authorize(input);
    if (!Number.isSafeInteger(indexId) || indexId < 1 || typeof sourceOriginRef !== 'string' || !sourceOriginRef
      || typeof sourceRowFingerprint !== 'string' || !sourceRowFingerprint) throw problem('LOG_HISTORY_SOURCE_INVALID', '历史日志来源身份无效', 400);
    const row = get(`SELECT h.* FROM backend_legacy_log_history h WHERE h.owner_ref=? AND h.account_ref=? AND h.subject_ref=?
      AND h.index_id=? AND h.source_origin_ref=? AND h.source_row_fingerprint=? AND ${visible}`,
    ownerRef, input.accountRef, subjectRef, indexId, sourceOriginRef, sourceRowFingerprint);
    if (!row) throw problem('LOG_HISTORY_SOURCE_CHANGED', '历史日志原件不再属于当前可见来源', 409);
    const sourceRef = 'legacy:' + row.source_origin_ref + ':' + row.source_table + ':' + row.source_primary_key_json + ':' + row.source_row_fingerprint;
    const projected = { log_id: row.index_id, owner_ref: row.owner_ref, account_ref: row.account_ref,
      occurred_at: row.occurred_at, level: row.source_level, category: canonicalLogCategory(row.display_category),
      message: row.message ?? '[历史日志原消息格式无效]', event_ref: sourceRef, detail_json: '{}',
      error_code: null, trace_id: null, operation_id: null, attempted: null, outcome_state: null,
      event_type: null, phase: null, method: null, run_epoch: null, connection_epoch: null,
      request_sequence: null, retry_at_ms: null, schema_version: null,
      source_origin_ref: row.source_origin_ref, source_row_fingerprint: row.source_row_fingerprint,
      source_table: row.source_table, source_primary_key_json: row.source_primary_key_json };
    authorize(input);
    return projected;
  }
  function page({ ownerRef, accountRef, subjectRef, limit = 15, beforeBusinessId = null, category = null, day = null,
    from = null, to = null, keyword = null, level = null, outcomeState = null, errorCode = null,
    operationId = null, traceId = null, includeRemoved = false, readOnlyArchive = false }) {
    const size = pageSize(limit), before = cursor(beforeBusinessId), input = { ownerRef, accountRef, subjectRef, includeRemoved, readOnlyArchive };
    const historicalCoverage = ensureIndexed(ownerRef, accountRef, subjectRef, input);
    // archive_id is a source identity, not event time. An incomplete random
    // prefix cannot safely form a historical chronological page/cursor.
    if (!historicalCoverage.indexingComplete) return freeze({ logs: [], historicalCoverage, reason: historicalCoverage.reason,
      continuation: historicalCoverage.continuation,
      page: { limit: size, hasMore: false, complete: false, hasMoreComplete: false,
        continuation: historicalCoverage.continuation, older: { localId: null, businessId: before } }, days: [], categories: [] });
    // Missing migration schema means there is no verified legacy source to
    // expose; keep the empty projection explicit without querying absent tables.
    if (!hasTable('backend_migration_imports') || !hasTable('backend_migration_receivers') || !hasTable('backend_legacy_archives')) return freeze({ logs: [], historicalCoverage,
      page: { limit: size, hasMore: false, complete: false, hasMoreComplete: false,
        older: { localId: null, businessId: before } }, days: [], categories: [] });
    const scope = ['h.owner_ref=?', 'h.account_ref=?', 'h.subject_ref=?', visible], params = [ownerRef, accountRef, subjectRef];
    if (before !== null) {
      const anchor = get('SELECT sort_time_ms FROM backend_legacy_log_history WHERE owner_ref=? AND account_ref=? AND subject_ref=? AND index_id=?', ownerRef, accountRef, subjectRef, before);
      if (!anchor) throw problem('LOG_CURSOR_INVALID', '历史日志游标不属于当前来源', 400);
      scope.push('(h.sort_time_ms<? OR (h.sort_time_ms=? AND h.index_id<?))'); params.push(anchor.sort_time_ms, anchor.sort_time_ms, before);
    }
    if (category) {
      requireText(category, 'category');
      const aliases = logCategoryAliases(category);
      scope.push(`h.display_category IN (${aliases.map(() => '?').join(',')})`); params.push(...aliases);
    }
    if (day) {
      const [dayStart, dayEnd] = shanghaiDayBounds(day);
      scope.push('h.occurred_at>=? AND h.occurred_at<?'); params.push(dayStart, dayEnd);
    }
    const since = timeBound(from, '起始'), until = timeBound(to, '结束');
    if (since) { scope.push('h.occurred_at>=?'); params.push(since); }
    if (until) { scope.push('h.occurred_at<?'); params.push(until); }
    if (since && until && since >= until) throw problem('LOG_TIME_FILTER_INVALID', '日志起始时间必须早于结束时间', 400);
    if (keyword !== null && keyword !== '') {
      if (typeof keyword !== 'string' || keyword.length > 160) throw problem('LOG_KEYWORD_INVALID', '日志关键词过长或格式无效', 400);
      const like = '%' + escapeLike(keyword) + '%';
      scope.push("(COALESCE(h.message,'') LIKE ? ESCAPE '\\' OR h.issues_json LIKE ? ESCAPE '\\' OR h.display_category LIKE ? ESCAPE '\\' OR h.source_category LIKE ? ESCAPE '\\' OR h.source_table LIKE ? ESCAPE '\\')");
      params.push(like,like,like,like,like);
    }
    if (level !== null && level !== '') { scope.push('h.source_level=?'); params.push(level); }
    // Legacy archives have no verified structured operation/result metadata.
    // Such rows must not masquerade as a match for modern-only identifiers.
    if (outcomeState || errorCode || operationId || traceId) scope.push('0=1');
    const rows = all(`SELECT h.*,(SELECT COUNT(*) FROM backend_legacy_log_history other WHERE other.owner_ref=h.owner_ref
      AND other.account_ref=h.account_ref AND other.subject_ref=h.subject_ref AND other.source_origin_ref=h.source_origin_ref
      AND other.source_table=h.source_table AND other.source_primary_key_json=h.source_primary_key_json) AS conflict_count
      FROM backend_legacy_log_history h WHERE ${scope.join(' AND ')} ORDER BY h.sort_time_ms DESC,h.index_id DESC LIMIT ?`, ...params, size + 1);
    const selected = rows.slice(0, size);
    const progress = readProgress(input);
    authorize(input);
    return freeze({ logs: selected.map(project), historicalCoverage, reason: historicalCoverage.reason,
      continuation: historicalCoverage.continuation,
      page: { limit: size, hasMore: rows.length > size, complete: historicalCoverage.completeArchivedRows,
        hasMoreComplete: true, continuation: historicalCoverage.continuation,
        older: { localId: null, businessId: selected.at(-1)?.index_id ?? before } },
      days: [...(progress?.days || [])], categories: canonicalLogCategories(progress?.categories), timeZone: 'Asia/Shanghai', utcOffset: '+08:00' });
  }
  function composePage({ currentLogs, beforeLocalId = null, ...input }) {
    if (typeof currentLogs?.page !== 'function') throw new TypeError('Joint history page requires the new observation log page interface');
    const size = pageSize(input.limit ?? 15);
    const localCursor = cursor(beforeLocalId), businessCursor = cursor(input.beforeBusinessId);
    const legacy = page({ ...input, limit: size, beforeBusinessId: businessCursor });
    const current = currentLogs.page({ ...input, limit: size, beforeLocalId: localCursor });
    if (current?.then || !Array.isArray(current?.logs)) throw new TypeError('Current log page must be synchronous');
    const logs = []; let li = 0, bi = 0;
    while (logs.length < size && (li < current.logs.length || bi < legacy.logs.length)) {
      const left = current.logs[li], right = legacy.logs[bi];
      const leftTime = legacyLogTime(left?.at)?.iso, rightTime = legacyLogTime(right?.at)?.iso;
      if (!right || left && (leftTime ? Date.parse(leftTime) : INVALID_TIME) >= (rightTime ? Date.parse(rightTime) : INVALID_TIME)) {
        logs.push({ ...left, historical: false }); li++;
      } else { logs.push(right); bi++; }
    }
    authorize(input);
    return freeze({ logs, historicalCoverage: legacy.historicalCoverage, reason: legacy.reason,
      continuation: legacy.continuation,
      page: { limit: size, hasMore: li < current.logs.length || bi < legacy.logs.length || current.page.hasMore || legacy.page.hasMore,
        complete: legacy.page.complete, hasMoreComplete: legacy.page.hasMoreComplete, continuation: legacy.continuation,
        older: { localId: li ? current.logs[li - 1].id : localCursor, businessId: bi ? legacy.logs[bi - 1].id : businessCursor } },
      days: [...new Set([...current.days, ...legacy.days])].sort().reverse().slice(0, 90),
      categories: canonicalLogCategories([...current.categories, ...legacy.categories]), timeZone: 'Asia/Shanghai', utcOffset: '+08:00' });
  }
  function onImported(input) {
    // The receiver calls inside its transaction, before its imported commit.
    // The next authorized page establishes the completed import and indexes it.
    for (const key of ['transferId', 'ownerRef', 'accountRef', 'subjectRef']) requireText(input?.[key], key);
    if (closed) return freeze({ transferId: input.transferId, indexing: 'closed', automaticallyUploaded: false });
    wake({ ownerRef: input.ownerRef, accountRef: input.accountRef, subjectRef: input.subjectRef });
    return freeze({ transferId: input.transferId, indexing: 'scheduled_after_imported', automaticallyUploaded: false });
  }
  function cancelAll(ownerRef = null) {
    if (ownerRef !== null) requireText(ownerRef, 'ownerRef');
    let stoppedJobs = 0;
    for (const [key, job] of jobs) if (ownerRef === null || job.input.ownerRef === ownerRef) { jobs.delete(key); stoppedJobs++; }
    arm();
    return freeze({ stoppedJobs, checkpointsPreserved: true });
  }
  function shutdown() {
    closed = true; const stoppedJobs = jobs.size; jobs.clear(); clearScheduled();
    return freeze({ closed: true, stoppedJobs, checkpointsPreserved: true });
  }
  return Object.freeze({ onImported, ensureIndexed, page, composePage, selectUploadSources, manualUploadRow, cancelAll, shutdown });
}
