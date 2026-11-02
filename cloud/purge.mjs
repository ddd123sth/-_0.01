// 日志保留与清理的唯一出处：服务调度与命令行必须吃同一份语义，不许两套并存。
// 只依赖注入进来的 store/config，不 import 服务本体——CLI 也要能安全调用。

import { getSettings } from './settings.mjs';

export function createLogPurger({ store, config, bootGeneration = null }) {
// 保留期按「首次云端接收」算，不按事件自己的发生时间：昨天的日志今天才传上来，
// 不能因为 occurred_at 就被当成早已过期删掉。一轮清理只推进有界那么多行、游标持久保存、
// 扫完回绕，不能一条 UPDATE 扫穿整库，把授权与续期挤在同一条写库路上等。
// 到保留期先清正文（message 与 diagnostic），行、事件号、未确认事实与首次接收继续留着；
// 只有正文已清、且发生与首次接收都超过收据窗口，整行才真正删掉。
const DAY_MS = 86_400_000;
function cursorOf(key) { return Number(store.get('SELECT value FROM settings WHERE key=?', key)?.value || 0) || 0; }
function saveCursor(key, value) {
  store.run('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
    key, String(value), new Date().toISOString());
}
function boundedRows(stateKey, whereSql, params, limit) {
  const after = cursorOf(stateKey);
  const rows = store.all(`SELECT id FROM run_logs WHERE id>? AND ${whereSql} ORDER BY id LIMIT ?`, after, ...params, limit);
  saveCursor(stateKey, rows.length ? Number(rows[rows.length - 1].id) : 0);
  return rows;
}
function purgeOnce({ trigger = 'manual' } = {}) {
  const settings = getSettings(store, config);
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const normalCutoff = new Date(startedMs - settings.retention.normalDays * DAY_MS).toISOString();
  const errorCutoff = new Date(startedMs - settings.retention.errorDays * DAY_MS).toISOString();
  const windowCutoff = new Date(startedMs - config.receiptWindowDays * DAY_MS).toISOString();
  const limit = Math.max(1, Math.min(Number(config.maintenanceRows) || 100, 1000));
  let bodyPurgedNormal = 0;
  let bodyPurgedImportant = 0;
  let rowsRemoved = 0;
  let receiptsRemoved = 0;
  let conflictsRemoved = 0;
  let budgetRowsRemoved = 0;
  store.transaction(() => {
    const stamp = new Date().toISOString();
    for (const [stateKey, klass, cutoff, which] of [
      ['purge_cursor_body_normal', 'normal', normalCutoff, 'normal'],
      ['purge_cursor_body_important', 'important', errorCutoff, 'important'],
    ]) {
      let cleared = 0;
      for (const row of boundedRows(stateKey, 'body_purged_at IS NULL AND body_class=? AND received_at<?', [klass, cutoff], limit)) {
        // 只清 bulky 正文：错误码、结果状态、未确认计数、发出尝试这些可查询事实必须留下。
        cleared += store.run('UPDATE run_logs SET message=?, diagnostic_json=NULL, body_purged_at=? WHERE id=? AND body_purged_at IS NULL',
          '[正文已按保留期清理；事件号、时刻与未确认事实仍在账上]', stamp, Number(row.id)).changes;
      }
      if (which === 'normal') bodyPurgedNormal = cleared; else bodyPurgedImportant = cleared;
    }
    for (const row of boundedRows('purge_cursor_rows', 'body_purged_at IS NOT NULL AND received_at<? AND occurred_at<?', [windowCutoff, windowCutoff], limit)) {
      rowsRemoved += store.run('DELETE FROM run_logs WHERE id=?', Number(row.id)).changes;
    }
    const receiptCutoffRows = store.all('SELECT user_id,install_id,event_id FROM log_receipts WHERE first_received_at<? AND occurred_at<? ORDER BY first_received_at LIMIT ?', windowCutoff, windowCutoff, limit);
    for (const row of receiptCutoffRows) {
      receiptsRemoved += store.run('DELETE FROM log_receipts WHERE user_id=? AND install_id=? AND event_id=?',
        Number(row.user_id), String(row.install_id), String(row.event_id)).changes;
    }
    const conflictCutoffRows = store.all('SELECT id FROM log_conflicts WHERE last_seen_at<? ORDER BY id LIMIT ?', windowCutoff, limit);
    for (const row of conflictCutoffRows) conflictsRemoved += store.run('DELETE FROM log_conflicts WHERE id=?', Number(row.id)).changes;
    // 准入计数只保留最近几分钟，否则这张表会随着安装实例数量一直长大。
    budgetRowsRemoved = store.run('DELETE FROM log_budget WHERE window_start < ?', startedMs - 5 * 60_000).changes;
  });
  const removed = bodyPurgedNormal + bodyPurgedImportant + rowsRemoved;
  process.stdout.write(JSON.stringify({
    event: 'log_purge', service: 'wujinxia-app-cloud', pid: process.pid, generation: bootGeneration, trigger,
    scheduledIntervalMinutes: config.purgeIntervalMinutes, startedAt,
    finishedAt: new Date(Date.now()).toISOString(), durationMs: Date.now() - startedMs,
    retentionBasis: 'first_cloud_receipt', maintenanceRowLimit: limit,
    normalDays: settings.retention.normalDays, errorDays: settings.retention.errorDays, receiptWindowDays: config.receiptWindowDays,
    normalCutoff, errorCutoff, windowCutoff,
    bodyPurgedNormal, bodyPurgedImportant, rowsRemoved, receiptsRemoved, conflictsRemoved, budgetRowsRemoved, removed,
  }) + '\n');
  return removed;
}

  return { purgeOnce };
}
