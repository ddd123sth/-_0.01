/* Production semantics for the frozen moon panel layout.
 * Design specifications describe layout, rules and input paths; their value/examples are never facts.
 * This adapter reads only the formal host state. It performs no fetch, mutation or business action.
 * Keep fields in their original order: picker indices are part of the sheet transaction contract. */

const UNREAD = '未读取';
const NO_RESULT = '当前没有这一步的操作结果';
const get = (value, path) => String(path || '').split('.').reduce((one, key) => one?.[key], value);
const knownNumber = value => value === null || value === undefined || value === '' || typeof value === 'boolean'
  ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const count = (value, unit) => knownNumber(value) === null ? UNREAD : `${Number(value)} ${unit}`;
const boolean = (value, yes, no) => value === true ? yes : value === false ? no : UNREAD;
const list = value => Array.isArray(value) ? value : null;

/* A business result and a log level are different facts. Share this projection
 * between timeline cards and their exact-record details; neither view may turn
 * a blocked candidate into an ordinary message or infer success from `info`. */
export function logPresentation(record = {}) {
  const level = String(record.level || record.severity || '').toLowerCase();
  const result = String(record.result || '').toLowerCase();
  const outcome = {
    ok: { status: '完成', tone: 'success' },
    fail: { status: '需核查', tone: 'danger' },
    skipped: { status: '未执行', tone: '' },
    blocked: { status: '被拦下', tone: 'warning' },
  }[result];
  const shown = outcome || (level === 'error' ? { status: '需要处理', tone: 'danger' }
    : ['warn', 'warning'].includes(level) ? { status: '提醒', tone: 'warning' }
      : { status: '已记录', tone: '' });
  return { ...shown, alert: ['danger', 'warning'].includes(shown.tone) };
}

/* A completed HTTP read can still be waiting for historical rows. Read the
 * formal host's continuation instead of treating that interval as empty. */
export function logReadState(host = {}) {
  const state = host.state || {}, metadata = host.logMeta?.() || {};
  const continuation = metadata.continuation ?? state.logsContinuation ?? null;
  return { loading: Boolean(metadata.loading ?? state.logsLoading),
    error: safeText(metadata.error ?? state.logsError, ''),
    notice: safeText(metadata.notice ?? state.logsNotice, ''), continuation,
    pending: continuation?.required === true };
}

function at(value) {
  if (value === null || value === undefined || value === '') return UNREAD;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? UNREAD : date.toLocaleString('zh-CN', {
    hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/* Only customer-facing text belongs here. Arbitrary error objects, URLs and credential-like details
 * must not leak through a spec description or an operation result. The formal API supplies safe copy. */
function safeText(value, fallback = UNREAD) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const text = value.trim();
  if (text.length > 600 || /https?:|(?:password|authorization|secret|token)\s*[:=]|\bat\s+\S+\s*\(/i.test(text)) return fallback;
  return text;
}

function backgroundResult(host) {
  const result = host.state?.backgroundSettings;
  return result && result.softwareUserId === String(software(host)?.user?.id ?? '')
    && result.engineGeneration === host.state?.engine?.generation && result.engineInstance === host.state?.engine?.instanceId
    ? result : null;
}

function backgroundResultText(host) {
  const result = backgroundResult(host);
  if (!result) return '当前没有这次打开请求的确认结果';
  if (result.status === 'intent-accepted') return '系统已受理打开请求';
  if (result.status === 'pending') return '正在等待系统处理';
  if (result.status === 'unknown') return '本次打开结果尚未确认';
  if (result.reason === 'all-intents-failed') {
    const targets = { 'battery-request': '电池优化申请页', 'app-details': '应用详情页' };
    const attempted = (Array.isArray(result.attempts) ? result.attempts : []).map(attempt => targets[attempt.target]).filter(Boolean);
    return attempted.length ? `${attempted.join('、')}：打开请求未受理` : '本次系统设置打开请求未受理';
  }
  const reasons = {
    'bridge-unavailable': '当前页面无法请求系统设置',
    'request-context-unavailable': '当前页面状态尚未核实，未请求打开设置',
  };
  return reasons[result.reason] || '本次系统设置请求没有取得可用结果';
}

function backgroundResultDescription(host) {
  const result = backgroundResult(host);
  if (!result) return '可从后台运行说明重新尝试；尚未确认设置页是否打开。';
  if (result.status === 'unknown') return '未收到本次打开结果，无法确认设置页是否打开；请先查看手机设置，避免重复打开。';
  const targets = { 'battery-request': '电池优化申请页', 'app-details': '应用详情页' };
  const reasons = { 'activity-not-found': '系统未提供此入口', 'security-denied': '系统安全策略拒绝打开', 'launch-failed': '系统启动此入口失败' };
  const attempts = (Array.isArray(result.attempts) ? result.attempts : []).map(attempt => `${targets[attempt.target] || '系统入口'}：${attempt.result === 'intent-accepted' ? '打开请求已受理' : reasons[attempt.reason] || '未取得打开结果'}`);
  const boundary = result.status === 'intent-accepted'
    ? '返回 App 后重新读取通知和电池权限，以实际结果为准。'
    : '可从手机设置进入无尽夏，检查通知、电池和后台活动。';
  return [...attempts, boundary].join('；');
}

const LICENSE = {
  signed_out: '未登录', granted: '授权有效', needs_renew: '授权有效，等待联网复核',
  grace_expired: '离线宽限已到期', disabled: '软件账号已停用', unverified: '授权期限待核实',
};
const ORDER_IDS = Object.freeze({
  'resident-detail': 'resident', 'satin-detail': 'satin', 'decorate-detail': 'decorate',
  'customer-detail': 'customer', 'palace-detail': 'palace', 'team-detail': 'team',
  'order-resident': 'resident', 'order-satin': 'satin', 'order-decorate': 'decorate',
  'order-customer': 'customer', 'order-palace': 'palace', 'order-team': 'team',
});
const RULE_PANELS = new Set(['orders-state-help', 'customer-art-link', 'art-dependency', 'account-runtime']);
const DAILY_PANELS = new Set(['daily-status', 'daily-reward-status']);
const SOFTWARE_PANELS = new Set(['license', 'software-account']);
const SERVICE_PANELS = new Set(['service', 'service-loading', 'service-disconnected', 'service-unread', 'connection-help']);
const SERVICE_CONNECTION_FIELDS = new Set(['手机服务', '本机服务', '本机连接']);

function software(host) { return host.softwareInfo?.() || host.state?.software || null; }
function account(host) { return host.selected?.() || null; }
function accountName(host, one = account(host)) {
  return one ? safeText(host.accountName?.(one) || one.remark || one.nickname || one.name, '游戏号') : '尚未选择游戏号';
}
function accountLine(host) {
  const one = account(host);
  return one ? `${accountName(host, one)}${one.serverName ? ` · ${safeText(one.serverName)}` : ''}` : '尚未选择游戏号';
}

/* Optional operation facts are written by the existing formal action after its real response.
 * They must be scoped to the affected account, not inferred from which gallery state was opened.
 * An absent fact is not an unsuccessful operation, nor proof of success. */
function operation(host, id) {
  const result = host.state?.panelResults?.[id];
  if (!result || typeof result !== 'object') return null;
  const selectedId = host.state?.selectedId;
  if (result.accountId !== undefined && String(result.accountId) !== String(selectedId ?? '')) return null;
  if (result.softwareUserId !== undefined && String(result.softwareUserId) !== String(software(host)?.user?.id ?? '')) return null;
  return result;
}

function operationText(result) {
  if (!result) return NO_RESULT;
  if (result.status === 'pending') return safeText(result.message, '正在处理，请等待本次结果');
  if (result.status === 'success') return safeText(result.message, '本次操作已完成');
  if (result.status === 'error') return safeText(result.message || result.error, '本次操作未完成，请重试');
  if (result.status === 'unknown') return safeText(result.message, '本次结果尚未确认，请先重新读取');
  return safeText(result.message, '本次结果尚未确认');
}

function resultText(host, id) { return operationText(operation(host, id)); }

/* Login and registration share an error sheet, but never an operation. A completed registration
 * fact may remain in its own slots after a new login starts. Match the formal current marker and
 * sequence instead of global authBusy, timestamps, or whichever old result happens to exist. */
function authMarker(host) {
  const marker = host.state?.authOperation;
  return marker && ['login', 'register'].includes(marker.kind) ? marker : null;
}
function authResult(host, id, kind) {
  const marker = authMarker(host), result = operation(host, id);
  if (!marker || marker.kind !== kind || !result || result.family !== kind) return null;
  if (!Number.isSafeInteger(marker.sequence) || result.sequence !== marker.sequence) return null;
  if (marker.status !== result.status) return null;
  return result;
}
function authFailure(host) {
  const marker = authMarker(host), kind = marker?.kind || 'login';
  const result = authResult(host, 'auth-error', kind);
  if (result && ['error', 'unknown'].includes(result.status)) return { kind, result, text: operationText(result) };
  /* A rejected local form submission has no request result. The host clears the shared error
   * fact and selects login/idle before validating, so its actual inline explanation is current. */
  if (kind === 'login' && (!marker || marker.status === 'idle')) {
    const text = safeText(host.state?.authError, '');
    if (text) return { kind, result: { status: 'error' }, text };
  }
  return { kind, result: null, text: kind === 'register' ? '当前没有这次注册的失败结果' : '当前没有这次登录的失败结果' };
}
function authProgress(host, kind) {
  const result = authResult(host, `auth-${kind}-loading`, kind);
  return result ? operationText(result) : kind === 'register' ? '当前没有进行中的注册请求' : '当前没有进行中的登录请求';
}

function addResult(host, id) {
  const result = operation(host, id), latest = operation(host, 'add-account-verifying');
  return result?.family === 'add' && Number.isSafeInteger(result.sequence)
    && latest?.family === 'add' && latest.sequence === result.sequence ? result : null;
}
function addStatus(host, id, field) {
  const result = addResult(host, id);
  if (!result) return NO_RESULT;
  const facts = result.facts || {};
  if (id === 'add-account-error') {
    if (field.label === '登录结果') return result.status === 'unknown' ? operationText(result)
      : safeText(facts.summary, operationText(result));
    if (field.label === '官方登录码') return Number.isSafeInteger(facts.loginCode)
      ? `${facts.loginCode}${facts.loginCodeKey ? `（${facts.loginCodeKey}）` : ''}` : '官服未提供登录码';
    if (field.label === '官方游戏码 / 返回码') {
      const codes = [];
      if (Number.isSafeInteger(facts.serverMsgCode)) codes.push(`游戏码：${facts.serverMsgCode}${facts.serverMsgKey ? `（${facts.serverMsgKey}）` : ''}`);
      if (Number.isSafeInteger(facts.remoteCode)) codes.push(`返回码：${facts.remoteCode}`);
      return codes.length ? codes.join('；') : '官服未提供游戏码或返回码';
    }
    // This exact bounded text has already passed the backend's public diagnostic projection and
    // the action's add-facts whitelist/redaction. Preserve its full 1600-character public body.
    if (field.label === '官方原文') return typeof facts.officialMessage === 'string' && facts.officialMessage.trim()
      ? facts.officialMessage : '官服未提供原文';
  }
  if (['add-account-success', 'add-account-partial'].includes(id)) {
    if (['身份核对', '登录核对'].includes(field.label)) return facts.identityVerified === true
      ? facts.rosterReadBack === true ? '官服身份已核对，并已在本机名册读回' : '官服身份已核对，本机保存结果尚未读回'
      : '本次官服身份核对尚未确认';
    if (field.label === '游戏号') return `${safeText(facts.verifiedNickname, '官服未提供昵称')} · ${safeText(facts.verifiedServer, '官服未提供区服')}`;
    if (field.label === '运行安排') return facts.running === true ? '游戏号正在运行'
      : facts.desiredRunning === true ? '已保留运行安排，请查看当前游戏号状态'
        : facts.running === false && facts.desiredRunning === false ? '尚未开始运行' : '运行安排尚未读取';
    if (field.label === '本次未读到') {
      if (!Array.isArray(facts.missing)) return '本次缺项名单尚未取得';
      const missing = facts.missing.map(one => safeText(one, '')).filter(Boolean);
      if (facts.missingComplete !== true) return missing.length ? `${missing.join('、')}；缺项名单尚未完整取得` : '本次缺项名单尚未完整取得';
      return missing.length ? missing.join('、') : '本次返回没有附加状态缺项';
    }
  }
  if (id === 'add-account-unverified' && field.label === '保存结果') return facts.rosterReadBack === true
    ? '已在本机名册读回；本次官服身份核对尚未确认' : '本次保存结果尚未在名册读回';
  return operationText(result);
}

function grace(info) {
  const remaining = knownNumber(info?.graceRemainingMs);
  if (remaining === null || info?.licenseState === 'unverified') return '期限待核实';
  if (remaining <= 0) return '已到期';
  return remaining < 60000 ? '不足 1 分钟' : `${Math.ceil(remaining / 60000)} 分钟`;
}

function ownership(info, field) {
  if (!info) return UNREAD;
  if (field.label === '当前软件账号') return safeText(info.user?.username, '未登录');
  if (field.label === '待确认游戏号') {
    const n = knownNumber(info.unownedAccountCount ?? info.ownership?.pendingAccounts);
    if (n !== null) return `${n} 个`;
    if (info.claimRequired === false) return '无需确认归属';
    return info.claimRequired === true ? '有资料待确认（数量未读取）' : UNREAD;
  }
  if (field.label === '未归属日志') return count(info.queue?.unowned, '条');
  return UNREAD;
}

function serviceConnection(host, refreshing) {
  const state = host.state || {};
  const engine = state.engine || {};
  const phase = engine.phase;
  if (refreshing) return { value: '正在读取…', tone: 'loading', description: '正在等待本次本机服务读取结果，请稍候；读取结束前不会把上次状态当成本次结果。' };
  if (phase === 'failed') {
    const message = safeText(engine.message, '手机运行服务未能完成本机就绪确认，登录没有提交。请点击重新连接后重试。');
    return { value: /超时/.test(message) ? '本机连接超时' : '本机服务未就绪', tone: 'danger', description: message };
  }
  if (['starting', 'stopping', 'binding'].includes(phase)) return {
    value: phase === 'stopping' ? '正在重新连接…' : phase === 'binding' ? '正在核对身份…' : '正在启动…',
    tone: 'loading',
    description: safeText(engine.message, '正在等待手机运行服务与当前软件身份完成本次就绪确认；就绪前不能提交登录。'),
  };
  if (state.loading) return { value: '正在读取…', tone: 'loading', description: '正在等待本次本机服务读取结果，请稍候。' };
  return state.online === true
    ? { value: '已连接', tone: 'success', description: '本次已连接手机运行服务；运行数量与系统权限分别按实际读数显示。' }
    : { value: '未连接', tone: 'warning', description: '尚未确认手机运行服务连接。请点击重新连接，等待本次本机就绪确认后再操作。' };
}

function serviceValue(host, field, refreshing) {
  const state = host.state || {};
  const facts = host.serviceFacts?.() || {};
  if (SERVICE_CONNECTION_FIELDS.has(field.label)) return serviceConnection(host, refreshing).value;
  if (field.label === '软件身份') return state.loading ? '正在读取软件身份…'
    : software(host)?.signedIn === true ? safeText(software(host)?.user?.username, '已登录')
      : software(host)?.signedIn === false ? '未登录' : UNREAD;
  /* Counts are valid only after a successful roster read; a disconnected cached array is not a zero. */
  if (field.label === '游戏已连接') return state.online === true && state.loading !== true ? count(facts.running, '个账号') : UNREAD;
  if (field.label === '待连接或恢复') return state.online === true && state.loading !== true ? count(facts.pending, '个账号') : UNREAD;
  if (field.label === '后台运行服务') return boolean(facts.service, '已启动', '未启动');
  if (field.label === '持续运行通知') return boolean(facts.foreground, '已开启', '未开启');
  if (field.label === '通知权限') return boolean(facts.notifications, '已允许', '未允许');
  if (field.label === '电池优化') return boolean(facts.battery, '已允许持续运行', '仍受系统优化限制');
  if (field.label === '手机型号') return safeText(facts.model);
  if (field.label === '系统版本') return facts.android ? `Android ${safeText(String(facts.android))}` : UNREAD;
  if (field.label === '最近读取') return at(facts.lastRead);
  /* 保活读数：没读到就是未读取，不拿“应该已允许”补值。 */
  if (field.label === '精确闹钟') return boolean(facts.exactAlarms, '已允许', '未允许');
  if (field.label === '可选 VPN 增强') return facts.vpnActive === true ? '已开启并在连接'
    : facts.vpnEnabled === true ? '已勾选，当前未连接'
      : facts.vpnEnabled === false ? '未开启' : UNREAD;
  if (field.label === '最近自动恢复') return Number.isFinite(facts.lastRecoveryAtMs) && facts.lastRecoveryAtMs > 0
    ? `${at(facts.lastRecoveryAtMs)} · ${recoveryText(facts)}`
    : Number.isFinite(facts.lastRecoveryAtMs) ? '还没有自动恢复记录' : UNREAD;
  if (field.label === '下次自检') return facts.selfCheckScheduled === true && Number.isFinite(facts.nextSelfCheckAtMs) && facts.nextSelfCheckAtMs > 0
    ? at(facts.nextSelfCheckAtMs) : facts.selfCheckScheduled === false ? '未排定' : UNREAD;
  if (field.label === '界面心跳') return boolean(facts.uiHeartbeatActive, '界面在前台', '界面不在前台');
  if (field.label === '屏幕常亮') return boolean(facts.screenKeepOn, '已开启', '未开启');
  if (field.label === '通知频道') {
    const channel = facts.notificationChannel;
    if (!channel || channel.known !== true) return UNREAD;
    return channel.blocked === true ? '已关闭' : '已允许';
  }
  if (field.label === '五分钟自检') return probeValue(facts.probe);
  if (field.label === '下次重连唤醒') return Number.isFinite(facts.reconnectWakeAtMs) && facts.reconnectWakeAtMs > 0 ? at(facts.reconnectWakeAtMs) : '当前没有排定的重连';
  return UNREAD;
}

function probeValue(probe) {
  const status = probe?.status;
  if (!status) return '未开始';
  const seconds = value => Math.max(0, Math.round(Number(value || 0) / 1000));
  if (status === 'running') return `进行中（${seconds(probe.elapsedMs)} 秒，锁屏 ${seconds(probe.screenOffTotalMs)} 秒）`;
  if (status === 'passed') return `通过（锁屏 ${seconds(probe.screenOffTotalMs)} 秒，心跳最大间隔 ${seconds(probe.maxHeartbeatGapMs)} 秒）`;
  const labels = { failed: '未通过', 'not-locked': '未锁屏，不算通过', cancelled: '已取消', interrupted: '已中断' };
  return `${labels[status] || status}${probe.reason ? `（${probe.reason}）` : ''}`;
}

/* 恢复原因用本机写下的固定枚举翻译；未知码照原样显示，不猜成成功。 */
const RECOVERY_REASONS = {
  boot: '开机或解锁后恢复', self_check: '定时自检恢复', engine_exited: '执行器结束后恢复',
  engine_start_failed: '执行器启动失败', health_transport_failure: '健康接口读取失败',
  health_mismatch: '健康核对未匹配', database_unhealthy: '数据库未就绪', progress_stalled: '任务阶段持续超期',
  initialization_failed: '初始化失败', startup_stalled: '启动超时', binding_stalled: '绑定超时',
  engine_restart_required: '软件身份要求重启', forced_exit_deadline: '强退兜底', restart_request_failed: '重启请求未确认',
};
function recoveryText(facts) {
  const reason = String(facts.lastRecoveryReason || '');
  const outcome = String(facts.lastRecoveryOutcome || '');
  const label = RECOVERY_REASONS[reason] || (reason || '原因未记录');
  if (outcome === 'background-start-denied') return `${label}（系统拒绝后台自启，需打开应用）`;
  if (outcome === 'started') return `${label}（已提交恢复）`;
  return label;
}

function queueValue(host, field) {
  const info = software(host);
  const queue = info?.queue;
  if (!queue) return UNREAD;
  if (field.label === '待传日志') return count(queue.pending, '条');
  if (field.label === '未归属日志') return count(queue.unowned, '条');
  if (field.label === '日志缺口') return count(queue.gapEvents, '条');
  if (field.label === '上次同步') return queue.lastUploadAt ? at(queue.lastUploadAt) : '还没有同步过';
  if (field.label === '同步节奏') return knownNumber(queue.baselineMs) === null ? UNREAD : `约 ${Math.round(Number(queue.baselineMs) / 1000)} 秒基准`;
  if (field.label === '同步配额') {
    const pending = knownNumber(queue.pending), quota = knownNumber(queue.quotaEvents);
    return pending === null || quota === null ? UNREAD : `待传 ${pending} 条 / 上限 ${quota} 条${queue.quotaWarning === true ? ' · 已达八成' : ''}`;
  }
  return UNREAD;
}

/* Only an explicit unavailable result can explain why this domain was not read. A stopped
 * card or another domain's reason never invalidates an existing readable observation. */
function unavailableValue(facts, fallback, daily = false) {
  if (facts?.available !== false) return fallback;
  let reason = '';
  if (daily && facts.reason === 'DAILY_TASK_STATE_UNAVAILABLE') {
    const names = { 'taskTot.dly.progress': '任务进度', 'taskTot.dly.recvMap': '领取记录', 'taskTot.dly.taskMap': '任务目录' };
    const missing = [...new Set((Array.isArray(facts.unknownPaths) ? facts.unknownPaths : [])
      .filter(path => Object.hasOwn(names, path)).map(path => names[path]))];
    reason = missing.length ? `尚未读到${missing.join('、')}` : '日常任务状态尚未读全';
  } else {
    const text = safeText(facts.reason, '');
    if (/[\u3400-\u9fff]/.test(text)) reason = text;
  }
  return reason ? `${fallback}：${reason}` : fallback;
}

function dailyValue(host, field, values) {
  const facts = host.state?.observations?.dailyTaskRewards;
  const tasks = facts?.available === true ? list(facts.tasks) : null;
  const enabled = get(values, 'dailyTaskRewards.enabled');
  const label = field.label || '';
  if (label.startsWith('已关闭')) return boolean(enabled, '已开启自动领取', '已关闭自动领取');
  if (label.startsWith('待达标')) {
    if (!tasks) return unavailableValue(facts, '任务进度尚未读全', true);
    const below = tasks.filter(one => one.basis === 'below-target').length;
    const unread = tasks.filter(one => String(one.basis || '').startsWith('no-')).length;
    return `${below} 项确认未达标${unread ? ` · ${unread} 项条件未读全` : ''}`;
  }
  if (label.startsWith('可领取')) return facts?.available === true ? count(facts.claimableCount, '项可领取') : unavailableValue(facts, '领取资格尚未读全', true);
  if (label.startsWith('已领取')) return tasks ? count(tasks.filter(one => one.claimed === true).length, '项已确认领取') : unavailableValue(facts, '今日领取状态尚未读全', true);
  if (label.startsWith('结果待核对')) {
    const rows = list(facts?.lastResult?.unverified);
    return rows ? count(rows.length, '笔待核对') : unavailableValue(facts, '最近领取结果未读取', true);
  }
  return UNREAD;
}

function artValue(host, field) {
  const facts = host.state?.observations?.art;
  if (!facts || facts.available !== true) return unavailableValue(facts, '花艺现场尚未读取');
  if (field.label === '顾客等待') {
    if (facts.wantsState === 'none') return '当前没有待制作需求';
    const wants = facts.wantsState === 'reported' ? list(facts.pendingWants) : null;
    if (!wants) return '尚未读到顾客需求';
    const arts = host.catalog?.().flowerArts || [];
    return wants.length ? wants.map(one => {
      const entry = arts.find(item => String(item.id) === String(one.artId));
      const name = safeText(entry?.label || entry?.name, '成品名称未读取');
      return `${name} × ${knownNumber(one.quantity) === null ? '数量未读取' : one.quantity}`;
    }).join('；') : '已读取需求名单，等待订单复核';
  }
  if (field.label === '已检查且没有需求') return facts.wantsState === 'none' ? '已检查，当前没有缺货订单'
    : facts.wantsState === 'reported' ? '已读到顾客制作需求' : '尚未检查顾客需求';
  if (field.label === '需求待获取') return facts.wantsState === 'unchecked' ? '尚未读到顾客需求'
    : ['none', 'reported'].includes(facts.wantsState) ? '需求名单已读取' : UNREAD;
  if (field.label === '库存读数') {
    const reading = facts.rackView;
    return reading?.state === 'fresh' ? '本轮已读取花艺现场'
      : reading?.state === 'stale' ? '保留上一轮读数，本轮尚未重读' : '库存尚未读取';
  }
  return UNREAD;
}

function artReward(host, id) {
  const writes = list(host.state?.observations?.recentWrites);
  const feature = id === 'art-album' ? 'vase-album-recv' : 'art-first-share';
  const rows = writes?.filter(one => one.scope === feature || one.featureId === feature);
  /* This bounded audit window describes only recent operations; it is not an album inventory or a
   * total reward count. Do not turn an empty recent-write list into "all claimed" or "nothing to claim". */
  if (!rows?.length) return '首做奖励资格尚未读取';
  const one = rows[0];
  return one.status === 'confirmed' ? '最近一笔领取已确认'
    : one.transport === 'unresolved' || ['business_unverified', 'may_have_sent', 'verifying'].includes(one.status)
      ? '最近一笔领取结果待核对' : '已记录最近一笔领取，结果尚待核实';
}

function logRecord(host, supplied) { return supplied || host.state?.selectedLogRecord || null; }
function logMessage(record) {
  const text = record?.messageZh || record?.message || record?.text || record?.summary;
  /* Log API is the formal, already redacted source. Keep the complete record, including long
   * explanations; do not replace it with the layout example or silently truncate to a caption. */
  return typeof text === 'string' && text ? text : '这条记录没有可显示的说明。';
}
function logMetadata(record) {
  if (!record) return [];
  const rows = [];
  const origin = { run_logs: '游戏运行记录', android_local_logs: '手机运行服务记录' }[record.origin];
  if (origin) rows.push({ label: '记录来源', value: origin });
  if (Number.isSafeInteger(Number(record.id)) && Number(record.id) > 0) rows.push({ label: '记录编号', value: String(record.id) });
  const detail = record.detail && typeof record.detail === 'object' ? record.detail : {};
  const diagnostic = record.diagnostic && typeof record.diagnostic === 'object' ? record.diagnostic : {};
  for (const [key, label] of [['phase','阶段'], ['eventState','事件状态'], ['status','连接状态'], ['cause','原因'], ['reasonCode','原因码'], ['action','后续动作'], ['retryAtMs','下次重试'],
    ['traceId','追踪标识'], ['operationId','操作标识'], ['eventType','事件类型'], ['method','方法'], ['sourceNamespace','来源'], ['httpStatus','本机HTTP状态'],
    ['remoteCode','官服错误码（原值）'], ['transportCode','传输错误码（原值）'], ['loginCode','登录码（原值）'], ['loginCodeKey','登录码字段'],
    ['serverMsgCode','服务端消息码（原值）'], ['code','来源码（原值）'], ['loginKind','登录类型'], ['runEpoch','运行代次'],
    ['readFailureKind','健康读取异常类型'],
    ['connectionEpoch','连接代次'], ['requestSequence','请求序号'], ['schemaVersion','诊断版本'], ['summary','安全摘要'], ['domains','涉及域'], ['reasons','原因码'],
    ['retryable','可自动重试'], ['userActionRequired','需要人工处理'], ['transportFailure','传输失败'], ['closureProven','连接已确认关闭'], ['truncated','详情有截断']]) {
    const value = record[key] ?? detail[key] ?? diagnostic[key];
    if (value === undefined || value === null || value === '') continue;
    const stateNames = { requested: '已请求', 'not-started': '未开始', completed: '已完成', incomplete: '未完成', failed: '失败' };
    const phaseNames = { 'v5-account-auth': '官服账号认证', 'sdk-session-exchange': '渠道会话兑换', health: '本机健康检查', connect: '连接建立' };
    const actionNames = { retry: '安排重试', restart: '请求重启', wait: '等待后复查', login: '重新登录',
      'needs-credentials': '需要更新登录凭据', 'account-disabled': '账号需要人工处理', 'ownership-conflict': '主体归属冲突需处理',
      'single-session': '等待旧会话释放', 'wait-network': '等待网络恢复', 'wait-time': '等待限流时间结束',
      'wait-egress': '等待网络出口恢复', 'refresh-config': '刷新登录配置后重试' };
    rows.push({ label, value: key === 'retryAtMs' ? at(Number(value)) : key === 'eventState' ? (stateNames[value] || String(value))
      : key === 'phase' ? (phaseNames[value] || String(value))
        : ['retryable','userActionRequired','transportFailure','closureProven'].includes(key) ? (value ? '是' : '否')
      : key === 'action' ? (actionNames[value] || String(value)) : Array.isArray(value) ? value.join('、') : String(value),
      ...(['traceId','operationId'].includes(key) ? { filterKey: key } : {}) });
  }
  if (record.attempted !== undefined && record.attempted !== null) rows.push({ label: '是否已尝试', value: record.attempted ? '是' : '否' });
  if (record.outcomeState) rows.push({ label: '业务结果', value: String(record.outcomeState) });
  return rows;
}
function logValue(host, field, supplied) {
  const record = logRecord(host, supplied);
  if (!record) return '尚未选择记录';
  if (field.label === '记录时间') return at(record.at || record.ts || record.timestamp || record.time || record.createdAt);
  if (field.label === '所属游戏号') {
    if (record.scope === 'device' || record.accountId === null) return '本机 / 添加记录';
    const id = record.accountId ?? record.account_id;
    const one = id === undefined ? null : host.state?.accounts?.find(item => String(item.id) === String(id));
    return safeText(record.accountName || record.nickname, one ? accountName(host, one) : '归属名称未读取');
  }
  if (field.label === '分类') return safeText(record.category, '未分类');
  if (field.label === '状态') return logPresentation(record).status;
  return UNREAD;
}

function routeValue(host) {
  const route = host.state?.egress;
  if (!route) return '出口设置尚未读取';
  if (route.routing === 'direct') return '本机网络';
  /* display is the formal backend's masked presentation. Never read a raw proxy/address property. */
  if (route.routing === 'proxy') return safeText(route.display, '已配置代理出口');
  return '尚未设置统一出口';
}

function hasPrototypeCopy(text) { return /原型|设计示意|设计说明|排版示意|版式示例|状态示例|仅为布局|示意时间|示意值|示例游戏号|阅读记录详情示例/.test(String(text || '')); }

function readingText(host, id, field, value) {
  const state = host.state || {};
  const networkFact = ['network', 'network-proxy', 'network-direct', 'network-unread'].includes(id) && field.label !== '敏感输入';
  const observedFact = Boolean(ORDER_IDS[id]) || ['art-status', 'art-album', 'art-share'].includes(id)
    || DAILY_PANELS.has(id) && !String(field.label).startsWith('已关闭');
  const cachedFact = SOFTWARE_PANELS.has(id) || ['license-valid', 'license-unactivated', 'license-expired', 'license-disabled', 'license-offline', 'license-unverified'].includes(id)
    || ['sync', 'sync-empty', 'sync-warning', 'data-ownership'].includes(id)
    || networkFact || observedFact;
  const hasCachedSource = networkFact ? Boolean(state.egress) : observedFact ? Boolean(state.observations) : Boolean(software(host));
  if (observedFact) {
    const read = state.observationsRead;
    const current = read && read.softwareUserId === String(software(host)?.user?.id ?? '')
      && read.accountId === String(state.selectedId ?? '') && read.generation === state.engine?.generation
      && read.instanceId === state.engine?.instanceId;
    if (hasCachedSource && !current) return '现场读取归属尚未核实，请重新读取';
    if (current && read.status === 'failed') {
      const reason = safeText(read.error, '现场读取未完成，请重新读取');
      return hasCachedSource && read.readAt
        ? `${value}（上次读取；本次读取失败：${reason}）`
        : `${value}（本次读取失败：${reason}）`;
    }
    if (current && read.status === 'loading' && hasCachedSource && read.readAt) return `${value}（上次读取，正在更新）`;
  }
  if (!cachedFact || state.online === true && !(networkFact && state.egressError) || value === UNREAD || value === NO_RESULT || !hasCachedSource) return value;
  return `${value}（上次读取）`;
}

/* Text overrides are semantic mappings, not a global removal of the word "示意". In particular,
 * useful rules about draft persistence, unknown operations and demand priority remain untouched. */
const FIELD_COPY = {
  'settings-help': {
    '三个设置分类': ['功能分类', '种花养花管种植、收花、浇水、培养和材料；交订单管订单；花架花艺管制作和售卖；任务福利管任务领奖、邮件、福利及剧情；公会管建设和公会地。'],
  },
  register: { '请勿输入真实凭据': ['软件账号注册', '注册提交到本项目的软件云服务；软件账号与游戏账号分开管理。'] },
  'auth-help': { '云服务尚未配置': ['软件云服务配置', '查看当前设备的软件云服务配置和实际登录条件。'] },
  'add-account': {
    '添加流程': ['添加流程', '添加时会使用填写的账号密码登录游戏一次，核对成功后保存；区服由游戏服务器确认，无需手选。'],
    '原型演示': ['账号资料保护', '游戏凭据保存在本机受保护存储中，不会因为添加账号自动开始任务。'],
  },
  password: { '设计原型': ['密码保护', '通过本项目正常认证流程修改软件密码；敏感输入不写入日志，关闭后清空。'] },
  'account-more': { '当前游戏号': ['当前游戏号', '以下操作作用于这张卡对应的游戏号。'] },
  'art-album': {
    '领取情况': ['领取情况', '首做资格和经验到账以官服花瓶图鉴及独立后验读取为准；最近领取记录不代表全部已领或当前可领数量。'],
    '领取后无法撤回': ['花艺经验奖励', '首次做成后可独立开启图鉴经验自动领取；不要求先开启自动制作。领取结果以官服确认和后续读取为准。'],
  },
  'art-status': {
    '顾客等待': ['顾客等待', '当前游戏号最近一次报回的顾客成品需求。'],
    '已检查且没有需求': ['需求检查', '只有实际检查并确认空名单，才显示没有需求。'],
    '需求待获取': ['需求读取', '尚未检查与已确认没有需求分别显示。'],
  },
  'auth-cloud-missing': { '处理方式': ['处理方式', '设备需要配置本项目的软件云服务。配置恢复后从登录页重试，不借用其他项目的身份。'] },
  'logs-account': {
    '阅读记录详情示例': ['选择一条运行记录', ''],
    '记录标签': ['记录标签', '标签优先显示这条记录的实际结果：完成、需核查、未执行或被拦下；没有业务结论时按记录等级显示提醒、需要处理或已记录。点击记录可查看完整原因。'],
  },
  'log-detail': {
    '记录时间': ['记录时间', ''],
    '所属游戏号': ['所属游戏号', ''],
    '分类': ['分类', ''],
    '状态': ['记录状态', ''],
    '记录内容示例': ['记录内容', ''],
    '完整记录': ['记录详情', ''],
  },
  'network-direct': { '全部账号使用': ['全部账号使用', '读取本机当前统一出口设置。'] },
  network: {
    '出口 IP / 代理地址': ['出口 IP / 代理地址', '输入只用于本机统一出口配置；保存后仅显示脱敏结果，不回显口令。'],
    '查看代理已配置状态': ['查看当前出口', '读取当前统一出口方式与脱敏地址。'],
  },
  'save-success': { '当前账号设置已更新（示意）': ['保存结果', '保存不会自动启动游戏号；运行前仍使用已经确认保存的配置。'] },
  'daily-detail': { '查看奖励状态': ['查看奖励状态', '查看当前游戏号的任务进度、可领奖励和最近领取结果。'] },
  'daily-rewards': { '查看奖励状态': ['查看奖励状态', '查看当前游戏号的任务进度、可领奖励和最近领取结果。'] },
  'daily-protection': { '确认来自真实结果': ['领取确认', '仅在官服确认奖励到账后记为已领取；请求已经发出不代表奖励到账。'] },
  'auth-login-loading': {
    '登录状态': ['登录状态', '请等待当前身份核对结果；重连手机服务不会自动重新提交登录。'],
    '稍候再试': ['等待本次结果', '登录完成后读取这个软件账号的游戏号，已有游戏任务不会自动开始。'],
  },
  'auth-error': {
    '连接结果': ['登录结果', '核对本次登录原因；本机连接、云端网络与账号口令错误会分别提示。'],
    '表单校验': ['重试前核对', '请输入软件账号和密码；手机服务就绪后才可提交。游戏账号和软件账号分别管理。'],
  },
  'palace-detail': { '本版本仅交单': ['仅自动交单', '当前仅自动交付符合设置的宫廷订单，不自动刷新订单。'] },
  'order-palace': { '本版本仅交单': ['仅自动交单', '当前仅自动交付符合设置的宫廷订单，不自动刷新订单。'] },
  'art-share': {
    '领取情况': ['领取情况', '首做分享资格与领取结果以官方确认为准；未读到资格时不推定可领取。'],
    '首次制作后判断': ['独立奖励资格', '首做分享奖励使用自己的开关；开启后按官服实际资格领取并独立核对奖励到账，不依赖自动制作开关。'],
    '需要手动分享时': ['分享奖励处理', '只提交官服认可的领奖请求并核对实际到账；不会代替游戏内分享，也不会要求你手动分享来完成本功能。'],
  },
  'add-account-success': {
    '身份核对': ['身份核对', '核对结果来自这次官服登录。'],
    '游戏号': ['游戏号', '昵称和区服来自本次核对结果；保存后可在游戏号列表查看。'],
    '运行安排': ['运行安排', '添加不会自动开始；先选择功能、保存设置，再点击开始。'],
  },
  'add-account-partial': {
    '登录核对': ['登录核对', '已确认的身份和未读到的状态分别保留；缺少必要状态的操作暂缓。'],
    '本次未读到': ['本次未读到', '这里只列本次核对实际缺少的状态；没有取得结果时不推定缺项。'],
  },
  'add-account-unverified': { '保存结果': ['保存结果', '保存和官服身份核对分别确认；尚未完成核对时，请先查看游戏号的实际状态。'] },
  'add-account-error': {
    '登录结果': ['登录结果', '本次失败原因与添加记录一致；重试前请核对账号输入。'],
    '官方登录码': ['官方登录码', '官服提供了登录码时在此保留；未提供时不补造编号。'],
    '官方游戏码 / 返回码': ['官方游戏码 / 返回码', '仅记录本次官服实际返回的结果，网络请求成功不代表游戏登录成功。'],
    '官方原文': ['官方原文', '保留官服实际返回的说明，凭据和敏感地址已隐藏。'],
  },
  'account-start': {
    '即将使用': ['即将使用', '开始后使用这个游戏号已经保存的设置；保存不会自动开始。'],
    '开始之后': ['开始之后', '先连接游戏，再按现场状态安排任务；可在游戏号卡片查看进度并随时停止。'],
  },
  'account-starting': {
    '当前状态': ['当前状态', '以下为这个游戏号最近读取的状态；连接完成后才会按设置执行。'],
    '任务还没开始？': ['连接与等待', '等待网络或允许登录时，运行安排仍会保留。无需反复开始，也可以点击停止撤销安排。'],
  },
  'account-stopped': { '当前状态': ['当前状态', '停止状态与是否保留运行安排，以这个游戏号最近读取的结果为准。'] },
  'account-runtime': {
    '正在启动 / 连接': ['正在启动 / 连接', '正在建立游戏连接，等待连接结果；可以随时停止。'],
    '等待运行 / 正在恢复': ['等待运行 / 正在恢复', '已保留运行安排，满足恢复条件后继续核对。可在游戏号卡片查看下次尝试时间。'],
    '运行中断 / 已暂停': ['运行中断 / 已暂停', '查看当前中断原因。重新连接后按最新游戏状态安排，不重复发送历史未知操作。'],
    '状态未读到': ['状态未读到', '先重新连接并读取实际状态；未读到不代表没有账号、库存为零或已经停止。'],
  },
  'orders-state-help': {
    '状态待获取': ['状态待获取', '必要的材料、订单或库存状态尚未读到时，先等待对应检查；其他条件明确的功能仍按设置安排。'],
    '下次检查': ['下次检查', '各类订单分别安排检查，可在订单现场读数中查看下一次时间。'],
  },
  'remove-account-error': { '移除结果': ['移除结果', '移除未确认完成时，保留这个游戏号并重新读取列表后再处理。'] },
  'license-valid': { '离线剩余': ['离线剩余', '可信宽限截止前可按授权条件继续；联网后会重新核对。'] },
  'license-unactivated': { '授权状态': ['授权状态', '运行资格由软件云服务确认；未取得资格时先联网核对。'] },
  'license-expired': { '离线剩余': ['离线剩余', '宽限到期后需重新联网核对授权，才能继续开始游戏任务。'] },
  'license-disabled': { '当前资格': ['当前资格', '若软件账号已停用，请联系管理员核对；暂停期间不开始新的游戏任务。'] },
  'license-unverified': { '不会猜测剩余时间': ['期限需要核实', '无法核实宽限期限时先联网核对，本机游戏资料与未确认记录继续保留。'] },
  'license-error': { '核对结果': ['核对结果', '查看本次授权核对原因；无法核实资格时暂不开始新的游戏任务。'] },
  'password-error': { '修改结果': ['修改结果', '查看本次修改失败的原因，核对当前密码和新密码后再试。'] },
  'sync-empty': {
    '待传日志': ['待传日志', '当前软件账号尚未送出的日志数量。'],
    '上次同步': ['上次同步', '最近一次实际上传的时间；从未上传时保留空记录。'],
  },
  'sync-warning': {
    '同步配额': ['同步配额', '当前队列接近上限时会提示，请联网同步并检查未归属资料。'],
    '日志缺口': ['日志缺口', '日志缺口保留记录；缺口数量不会计作已成功上传。'],
    '上传节奏': ['上传节奏', '立即上传仍遵守同步额度；本次送出数量与剩余队列分别统计。'],
  },
  'sync-error': { '本次同步': ['本次同步', '未确认送出的日志继续保存在手机队列，网络与授权恢复后按正常同步流程核对。'] },
  'data-ownership-error': { '确认结果': ['确认结果', '请核对当前软件身份与本次失败原因；未归属记录仍保留在手机上。'] },
  'data-ownership-success': {
    '重新连接执行器': ['重新连接手机服务', '软件身份归属变化后，App 会重新连接手机服务并读取对应资料；就绪前不开始任务。'],
  },
  'service-disconnected': { '连接校验失效': ['连接校验失效', 'App 会重新核对手机服务连接。就绪前不能提交登录；这不会重复发送游戏操作。'] },
  'connection-help': { '连接校验失效': ['连接校验失效', 'App 会重新核对手机服务连接。就绪前不能提交登录；这不会重复发送游戏操作。'] },
  battery: { '需要按设备验证': ['系统可能限制后台活动', '不同手机的后台设置名称和限制不同；请允许通知及必要的后台活动，强行停止后需重新打开 App。'] },
  'background-settings-error': { '跳转结果': ['跳转结果', '若系统设置未能打开，可从手机设置中找到无尽夏，检查通知、电池和后台活动。'] },
  'network-error': {
    '保存结果': ['保存结果', '请核对出口地址格式与本次失败原因，修改后重新提交。'],
    '不改变显示结果': ['原有出口继续保留', '保存未确认完成时保留原配置；重新读取当前出口后再判断是否需要重试。'],
  },
  'save-error': { '保存结果暂未确认': ['保存结果暂未确认', '当前草稿仍保留。请先重新读取实际保存结果，再决定是否重试。'] },
  'log-filters': { '日期': ['日期', '可选日期来自这个日志来源已经保存的记录。'] },
  'log-categories': { '类别来源': ['类别来源', '按当前来源的日志分类筛选全部记录，切换分类后回到第一页。'] },
  'logs-loading': { '当前读取': ['当前读取', '正在读取期间暂不能翻页，请等待本次读取完成。'] },
  'logs-error': {
    '读取结果': ['读取结果', '请检查本次失败原因，恢复手机服务连接后重新读取。'],
    '分页状态': ['重新读取后再翻页', '本次失败后的下一页尚未确认，重新读到记录后才能继续翻页。'],
  },
  'logs-pagination': {
    '第一页': ['当前页', '查看最新记录时可自动刷新；查看旧页时会保留当前页。'],
    '最后一页': ['更早记录', '有更早记录时才允许继续翻页。'],
    '读取中': ['读取状态', '读取期间暂不能翻页，避免混入其他来源或筛选结果。'],
  },
};

const SUBTITLE = {
  'auth-login-loading': '连接软件云服务，核对当前软件身份。',
  'auth-register-loading': '正在提交软件账号注册，请等待本次结果。',
  'auth-register-success': '查看这次注册结果，再返回登录。',
  'auth-login-success': '软件登录和游戏号运行分别控制。',
  'auth-error': '核对本次失败原因，再从登录表单重试。',
  'auth-cloud-missing': '软件登录需要先连接本 App 的软件云服务。',
  'add-account-verifying': '核对官服身份、昵称和区服后，再保存到手机。',
  'add-account-success': '身份核对和保存结果以本次返回为准。',
  'add-account-partial': '身份核对与附加状态分别确认。',
  'add-account-unverified': '保存到手机不等于已经通过官服身份核对。',
  'add-account-error': '查看这次添加的实际错误和官服返回。',
  'account-more': '以下操作只作用于当前游戏号。',
  'account-settings-guide': '种花收花、交订单和花艺共用这个游戏号的设置。',
  'settings-help': '五个分类共用当前游戏号的设置；切换分类保留未保存的修改。',
  'choose-account': '切换当前查看对象，不改变已有运行安排。',
  'account-start': '使用这个游戏号已保存的设置开始照料。',
  'account-stop': '撤销这个游戏号的运行和恢复安排。',
  'account-starting': '当前状态以手机服务最近读取的结果为准。',
  'account-stopping': '核对当前停止状态，保留已经发生的游戏结果。',
  'account-stopped': '查看当前停止状态和后续安排。',
  'account-action-unknown': '先重新读取实际状态，不重复提交来猜测结果。',
  'account-runtime': '运行状态含义说明；当前状态显示在游戏号卡片中。',
  'account-protection': '当前执行保护与历史记录分别处理。',
  'remove-account': '仅移除这台手机上的对应游戏号资料。',
  'remove-account-busy': '等待这次移除结果，不重复提交。',
  'remove-account-success': '查看这次移除的实际结果。',
  'remove-account-error': '先核对实际列表，再决定下一步。',
  'accounts-empty': '添加游戏号后，再选择需要自动执行的功能。',
  'accounts-unreadable': '重新连接手机服务，读取当前软件身份下的名册。',
  'daily-status': '当前游戏号的任务读数；没有读全时不判断领取资格。',
  'daily-reward-status': '当前游戏号的任务读数；没有读全时不判断领取资格。',
  'logs-account': '进入当前游戏号的真实运行日志。',
  'logs-device': '软件操作、账号添加和手机运行服务的记录。',
  'log-detail': '被选中记录的原始时间、归属和内容。',
  'logs-loading': '读取完成前保留当前来源和筛选。',
  'logs-empty': '当前来源的记录由实际操作产生。',
  'logs-filter-empty': '更换条件或清除筛选，历史记录仍然保留。',
  'logs-error': '读取失败与没有记录分别处理。',
  'log-categories': '筛选当前来源的完整记录。',
  'logs-pagination': '每页 15 条；以下显示当前分页状态。',
  'license-valid': '当前软件身份的运行资格与离线宽限。',
  'license-unactivated': '登录确认身份，授权决定是否可以开始游戏任务。',
  'license-expired': '宽限期限以本机可信授权读数为准。',
  'license-disabled': '软件账号停用原因由管理员核对。',
  'license-offline': '离线宽限来自当前授权读数；无法核实就不猜剩余时间。',
  'license-unverified': '联网读取可信授权期限。',
  'license-checking': '等待本次授权核对结果，不重复提交。',
  'license-error': '核对失败不清除游戏号和历史记录。',
  'password-busy': '等待本次密码修改结果。',
  'password-success': '查看修改结果，再重新登录软件账号。',
  'password-error': '核对当前密码、新密码和本次失败原因。',
  'logout-busy': '先确认本机任务停止，再退出软件身份。',
  'logout-error': '重新读取软件身份和停止状态，不假报退出完成。',
  sync: '当前软件账号的待传队列与最近同步时间。',
  'sync-empty': '当前队列数量以最近读取结果为准。',
  'sync-warning': '联网同步并检查归属，避免待传队列持续积压。',
  'sync-busy': '等待本次同步结果，不重复提交。',
  'sync-success': '这次送出数量与剩余队列分别统计。',
  'sync-error': '未确认送出的日志继续保存在手机队列中。',
  'data-ownership': '确认当前软件身份与本机历史资料的归属。',
  'data-ownership-busy': '等待这次归属确认，保留原操作记录。',
  'data-ownership-success': '确认归属不会自动开始游戏任务。',
  'data-ownership-empty': '是否仍有待确认资料，以本次读取为准。',
  'data-ownership-error': '查看这次失败原因，原资料与日志继续保留。',
  service: '读取手机服务连接、系统权限与游戏号运行数量。',
  'service-loading': '手机服务与软件身份分别核对。',
  'service-disconnected': '重新建立手机连接，再读取游戏号运行状态。',
  'service-unread': '单项权限未读取时不会判断为已允许。',
  'connection-help': '重新建立手机连接，再读取当前软件身份与名册。',
  'background-settings': '在手机系统设置中管理通知、电池与后台权限。',
  'background-open-result': '系统已受理打开请求，返回后重新读取实际权限。',
  'background-settings-error': '可从手机系统设置手动进入无尽夏。',
  'network-clear': '本机所有游戏号将共用手机当前网络。',
  'network-loading': '等待本次保存结果，随后重新读取当前出口。',
  'network-proxy': '仅保留当前出口的脱敏读数。',
  'network-direct': '当前出口方式以本次读取为准。',
  'network-error': '核对输入和保存结果，敏感信息不会出现在提示中。',
  'network-unread': '先读取当前出口，再修改统一网络设置。',
};

function dynamicDescription(host, id, field, supplied, refreshing = false) {
  // A bound control's current catalogue read/error is authoritative over the frozen help text.
  if (field.catalogReadMessage) return field.catalogReadMessage;
  if (field.compactSettings) return field.description || '';
  if (id === 'background-settings-error' && field.label === '跳转结果') return backgroundResultDescription(host);
  if (id === 'background-open-result') {
    if (field.label === '在正式 Android App 中') return backgroundResultDescription(host);
    if (field.label === '返回 App 后') return '返回时重新读取当前设备的通知权限和电池策略，系统是否允许以实际读数为准。';
    if (field.label === '浏览器原型') return '系统受理打开请求后，后台和通知权限仍以实际读取结果为准。';
  }
  if (id === 'add-account-error') {
    const facts = addResult(host, id)?.facts;
    if (field.label === '登录结果' && facts) {
      const details = [FIELD_COPY[id]?.[field.label]?.[1]];
      if (facts.code) details.push(`本机错误码：${facts.code}。`);
      if (Number.isSafeInteger(facts.httpStatus)) details.push(`网络响应：HTTP ${facts.httpStatus}，与官服登录码分别记录。`);
      return details.filter(Boolean).join(' ');
    }
    if (field.label === '官方原文' && facts) {
      const notes = ['保留本次官服实际提供的说明。'];
      if (facts.redacted === true) notes.push('其中敏感值已隐藏。');
      if (facts.truncated === true) notes.push('原文过长，公开诊断已截断。');
      return notes.join('');
    }
  }
  if (id === 'auth-error' && authFailure(host).kind === 'register') {
    if (field.label === '连接结果') return '查看这次软件账号注册的实际结果；结果尚未确认时不会自动重复提交。';
    if (field.label === '表单校验') return '软件账号和密码由注册表单核对；若提示账号已存在，请返回登录，不重复注册。';
  }
  if (ORDER_IDS[id] && field.label === '当前现场') return '来自当前游戏号的订单观察；未读到单板、库存或进度时不推定为零。';
  if (id === 'auth-cloud-missing') {
    const configured = software(host)?.cloudConfigured;
    if (field.label === '云服务地址') return configured === true ? '软件云服务地址已经配置，登录结果仍以当前认证请求为准。'
      : configured === false ? '这台手机还没有配置软件云服务地址，暂时无法登录。' : '先连接手机运行服务，读取当前云服务配置。';
    if (field.label === '处理方式') return configured === true
      ? '软件云服务地址已配置；若登录失败，请查看登录页的本次原因和重试时间。游戏网络出口单独设置。'
      : configured === false ? '请联系管理员确认此设备的软件云服务配置，再返回登录重试。'
        : '等待手机服务连接就绪后重新读取配置；尚未读到不等于未配置。';
  }
  const override = FIELD_COPY[id]?.[field.label];
  if (override) {
    if (id === 'log-detail' && field.label === '记录内容示例') {
      const record = logRecord(host, supplied);
      return record ? logMessage(record) : '请先在运行日志中选择一条记录。';
    }
    return override[1];
  }
  if (DAILY_PANELS.has(id)) {
    if (field.label.startsWith('已关闭')) return '这里只显示当前草稿开关；完成后还需保存才影响执行。';
    if (field.label.startsWith('待达标')) return '从本次完整任务账统计未达标且尚未领取的任务；不会为了领奖执行底层业务。';
    if (field.label.startsWith('可领取')) return '只有官服确认已达标且尚未领取的任务才计入。';
    if (field.label.startsWith('已领取')) return '只统计当前任务账中已确认领取的项，不沿用昨天的结果。';
    if (field.label.startsWith('结果待核对')) return '最近一轮领取中仍未确认的原操作保留，不重发、不清账。';
    if (field.label === '下次检查') {
      const wake = host.state?.observations?.wakes?.['reward.daily-task'];
      return wake?.enabled === false ? '当前未安排日常奖励检查。'
        : `日常奖励有独立检查安排；下次检查：${at(wake?.nextCheckAtMs)}。`;
    }
  }
  if (SOFTWARE_PANELS.has(id) || id.startsWith('license-')) {
    if (['授权状态', '当前资格'].includes(field.label)) return '来自当前软件身份的授权状态；等待续期不等于账号停用。';
    if (field.label === '软件账号') return '软件登录身份，与游戏昵称和后台管理员身份分开。';
    if (field.label === '最近核对') return '最近一次实际核对软件授权的时间。';
    if (['剩余离线宽限', '离线剩余', '离线宽限'].includes(field.label)) return '使用本机授权服务给出的可信剩余时间；不以目标时长代替现场读数。';
  }
  if (id.startsWith('sync')) {
    if (field.label === '待传日志') return '当前软件用户的本机待传队列。';
    if (field.label === '日志缺口') return '保留无法补齐的日志缺口记录；缺口数量不计作已上传。';
    if (field.label === '上次同步') return '最近一次实际上传日志的时间。';
    if (field.label === '确认本机资料归属') return '待归属资料需先确认所属软件账号，才会进入对应的同步队列。';
    if (field.label === '同步节奏') return '本机日志队列给出的基准间隔，实际发送还受网络和额度影响。';
    if (field.label === '同步配额') return '当前待传数与本机实际配额上限。';
    if (field.label === '这次送出') return '只显示本次实际上传结果，不代表清空所有队列。';
  }
  if (id.startsWith('data-ownership') && ['待确认游戏号', '确认结果'].includes(field.label)) return '核对当前软件账号与这次归属结果；已经确认的资料不会重复迁入。';
  if (SERVICE_PANELS.has(id) && field.type === 'status') return SERVICE_CONNECTION_FIELDS.has(field.label) ? serviceConnection(host, refreshing).description
    : field.label === '最近读取' ? '最近一次成功读取本机服务的时间。'
    : field.label === '手机型号' || field.label === '系统版本' ? '来自当前设备实际读数。'
    : ['精确闹钟', '可选 VPN 增强', '最近自动恢复', '下次自检', '界面心跳', '屏幕常亮', '通知频道', '五分钟自检', '下次重连唤醒'].includes(field.label) ? (field.description || '来自本机实际读数；未读取不会显示成已允许。')
    : '来自本机服务或系统权限；未知与未允许分开。';
  if (id === 'logs-pagination' && field.label === '中间页') return '每次翻页读取对应记录；查看旧页时不会自动跳回最新页。';
  if (id === 'help' || id === 'app-help') {
    if (field.label === '原型数据') return '账号、设置、运行和日志分别来自本机服务；未读取、读取失败与确认为零分别显示。';
  }
  if (id.startsWith('background-') && field.label === '浏览器原型') return '系统权限只能由 Android 系统设置；返回后重新读取实际状态。';
  if (id.startsWith('background-') && field.label === '在正式 Android App 中') return '打开当前手机的系统设置，检查通知、后台活动和电池限制；设置名称以本机系统为准。';
  if (hasPrototypeCopy(field.description || field.help)) return field.type === 'status'
    ? '当前读数以本机服务实际返回为准；没有取得时显示未读取。'
    : '通过当前 App 的正常入口操作，实际结果以本次返回为准。';
  return field.description || field.help || '';
}

function resolveStatus(host, id, field, options) {
  const state = host.state || {}, info = software(host);
  if (id.startsWith('add-account-')) return addStatus(host, id, field);
  if (RULE_PANELS.has(id)) return field.label || UNREAD;
  if (DAILY_PANELS.has(id)) return dailyValue(host, field, options.values || {});
  if (ORDER_IDS[id] && field.label === '当前现场') return safeText(host.orderStatus?.(ORDER_IDS[id]), '当前订单现场尚未读取');
  if (id === 'daily-rewards' || id === 'daily-detail') return get(options.values || {}, 'dailyTaskRewards.enabled') === false ? '自动领取已关闭'
    : state.observations?.dailyTaskRewards?.available === true ? count(state.observations.dailyTaskRewards.claimableCount, '项可领取') : '任务状态尚未读全';
  if (id === 'art-status') return artValue(host, field);
  if (['art-album', 'art-share'].includes(id)) return artReward(host, id);
  if (id === 'account-more') return accountLine(host);
  if (SOFTWARE_PANELS.has(id)) {
    if (field.label === '软件账号') return safeText(info?.user?.username, info?.signedIn === false ? '未登录' : UNREAD);
    if (field.label === '授权状态') return LICENSE[info?.licenseState] || UNREAD;
    if (field.label === '最近核对') return at(info?.licenseCheckedAt || info?.lastLicenseCheckedAt);
  }
  if (id.startsWith('license-')) {
    if (['剩余离线宽限', '离线剩余', '离线宽限'].includes(field.label)) return grace(info);
    if (['当前资格', '授权状态'].includes(field.label)) return LICENSE[info?.licenseState] || UNREAD;
    if (id === 'license-checking') return state.busy === 'check-license' ? '正在核对授权…' : resultText(host, id);
    return resultText(host, id);
  }
  if (id === 'sync' || id === 'sync-empty' || id === 'sync-warning') return queueValue(host, field);
  if (id === 'data-ownership') return ownership(info, field);
  if (id === 'data-ownership-empty') return info?.claimRequired === false ? '当前无需确认历史资料归属'
    : info?.claimRequired === true ? '仍有历史资料待确认归属' : UNREAD;
  if (id === 'data-ownership-success' && info?.claim?.status === 'confirmed'
      && info?.user?.id !== undefined && String(info.claim.confirmedUserId) === String(info.user.id)) return '资料已确认归属到当前软件账号';
  if (SERVICE_PANELS.has(id)) return serviceValue(host, field, options.refreshing);
  if (id === 'battery') {
    const facts = host.serviceFacts?.() || {};
    if (field.label === '通知权限') return boolean(facts.notifications, '已允许', '未允许');
    if (field.label === '电池策略') return boolean(facts.battery, '不限制', '仍受系统优化限制');
  }
  if (id === 'log-detail') return logValue(host, field, options.logRecord);
  if (['network', 'network-proxy', 'network-direct', 'network-unread'].includes(id)) return field.label === '敏感输入'
    ? state.egressDraft ? '存在尚未提交的输入' : '输入框为空' : routeValue(host);
  if (['logs-pagination', 'logs-loading', 'logs-error'].includes(id)) {
    const read = logReadState(host), waiting = read.loading || read.pending;
    if (id === 'logs-loading') return read.error ? '运行日志读取失败' : waiting ? read.notice || '正在读取运行日志…' : read.notice || '当前没有进行中的日志读取';
    if (id === 'logs-error') return read.error || '当前没有日志读取错误';
    if (field.label === '第一页') return `当前第 ${(state.logsStack?.length || 0) + 1} 页`;
    if (field.label === '中间页') return waiting ? '正在读取，暂不能翻页' : state.logsStack?.length ? '上一页可用' : '当前已是第一页';
    if (field.label === '最后一页') return waiting ? '正在确认是否还有记录' : state.logsHasMore === true && state.logsOlder ? '还有更旧记录' : '当前没有可用的下一页';
    if (field.label === '读取中') return read.error ? '本次读取失败' : waiting ? read.notice || '正在读取运行日志…' : read.notice || '当前读取已结束';
  }
  if (id === 'auth-cloud-missing') return info?.cloudConfigured === true ? '已配置本项目云服务' : info?.cloudConfigured === false ? '未配置本项目云服务' : UNREAD;
  if (id === 'auth-error') return authFailure(host).text;
  if (id === 'auth-login-loading') return authProgress(host, 'login');
  if (id === 'auth-register-loading') return authProgress(host, 'register');
  if (id === 'auth-register-success') {
    const result = authResult(host, id, 'register');
    if (!result) return '当前没有已确认成功的注册结果';
    return result.status === 'pending' ? '注册请求仍在处理中，尚未确认成功' : operationText(result);
  }
  if (id === 'auth-login-success') return info?.signedIn === true ? '软件账号已登录' : '当前未登录';
  if (id.startsWith('account-') && ['account-starting', 'account-stopping', 'account-stopped', 'account-action-unknown'].includes(id)) {
    const one = account(host);
    return one ? safeText(host.stateLabel?.(one), '状态尚未读取') : '尚未选择游戏号';
  }
  if (id === 'accounts-unreadable') return state.loading ? '正在读取本机游戏号…' : state.online ? '本机服务已连接，请查看游戏号列表' : '当前无法确认游戏号状态';
  if (id === 'background-open-result' || id === 'background-settings-error') return backgroundResultText(host);
  if (id.startsWith('background-')) return typeof window !== 'undefined' && window.AndroidBridge ? '请在手机系统设置中查看实际权限' : '请在 Android App 中打开系统设置';
  if (id === 'save-pending') return state.busy === 'save' ? '正在保存当前游戏号设置…' : '当前没有进行中的保存';
  /* No design field.value fallback. Success, failure and busy screens require the corresponding
   * formal action result; opening a state-help link never creates an operation result. */
  return resultText(host, id);
}

/** Clone layout metadata and explicitly replace production-only semantics. Never mutate specs.js. */
export function adaptLivePanelSpec(id, spec, host, options = {}) {
  const next = { ...spec, fields: (spec.fields || []).map(field => ({ ...field })) };
  // These two account-scoped flower-rack cards own editable config paths but the frozen
  // layout metadata omitted their apply action. Without it the real Moon sheet can edit only
  // a detached child draft and has no way to merge that draft back to the settings page.
  if (id === 'flower-rack-cancel' || id === 'flower-rack-unlock') {
    next.primary = { label: '完成设置', action: 'apply' };
  }
    next.fields = next.fields.map((field, index) => {
    field.liveSourceLabel = spec.fields[index]?.label || '';
    field.description = dynamicDescription(host, id, field, options.logRecord, options.refreshing);
    const override = FIELD_COPY[id]?.[field.label];
    if (override) field.label = override[0];
    // First-reward claimers are independent account settings. The production
    // fallback owns their runtime config keys, so the Moon adapter must not
    // inherit the frozen prototype's art.makeEnabled dependency.
    if (['art-album', 'art-share'].includes(id) && field.type === 'toggle') {
      delete field.enableWhen;
      field.description = id === 'art-album'
        ? '独立设置；开启后按官服图鉴的首做资格领取经验奖励，不依赖自动制作开关。'
        : '独立设置；开启后按官服首做分享资格请求奖励并核对到账，不依赖自动制作开关。';
    }
    return field;
  });
  if (id === 'art-album') next.subtitle = '每种花艺首次做成后，可独立领取对应图鉴经验奖励。';
  if (id === 'art-share') next.subtitle = '首做分享奖励独立开启；按官服资格请求并核对实际奖励到账。';
  /* 保活状态与入口都挂在「运行服务」面板里：状态读本机实际值，入口只负责跳转/请求，
     打开设置页本身不会把权限标成已允许。追加放在字段映射之后，liveSourceLabel 不能被覆盖。 */
  if (id === 'service') {
    next.fields.push(
      { type: 'status', label: '精确闹钟', value: '未读取', liveSourceLabel: '精确闹钟', description: '未授权时自检闹钟可能被系统推迟，且后台启动可能被拒绝。' },
      { type: 'status', label: '可选 VPN 增强', value: '未读取', liveSourceLabel: '可选 VPN 增强', description: '可选增强，只维持后台生命周期，不接管游戏流量。' },
      { type: 'status', label: '最近自动恢复', value: '未读取', liveSourceLabel: '最近自动恢复', description: '记录最近一次被动恢复的原因与结果，不代表当前任务一定在跑。' },
      { type: 'status', label: '下次自检', value: '未读取', liveSourceLabel: '下次自检', description: '周期巡检只负责把丢失的执行器找回来；任务是否在跑仍看上面的数量。' },
      { type: 'status', label: '界面心跳', value: '未读取', liveSourceLabel: '界面心跳', description: '界面心跳只说明页面是否在前台；界面消失不等于引擎失活。' },
      { type: 'status', label: '屏幕常亮', value: '未读取', liveSourceLabel: '屏幕常亮', description: '可选的屏幕常亮模式，默认关闭；与 CPU 唤醒锁分开。' },
      { type: 'status', label: '通知频道', value: '未读取', liveSourceLabel: '通知频道', description: '通知总开关与“本机自动化运行状态”频道分开读取；频道关闭时通知不可见。' },
      { type: 'status', label: '五分钟自检', value: '未读取', liveSourceLabel: '五分钟自检', description: '需要真实锁屏至少两分钟；只收到闹钟不算通过，也不会停止正式业务。' },
      { type: 'status', label: '下次重连唤醒', value: '未读取', liveSourceLabel: '下次重连唤醒', description: '按各游戏号最早的合法重连截止排定；没有截止时撤销。' },
      { type: 'action', label: '屏幕常亮', action: 'toggle-screen-keep-on', description: '默认关闭；只影响屏幕是否保持点亮，不替代 CPU 锁。' },
      { type: 'action', label: '运行五分钟自检', action: 'start-keepalive-probe', description: '开始后请锁屏至少两分钟；自检不会停止或重启业务。' },
      { type: 'action', label: '取消五分钟自检', action: 'cancel-keepalive-probe', description: '取消本次自检，不影响正式执行器。' },
      { type: 'action', label: '可选 VPN 增强', action: 'toggle-keepalive-vpn', description: '需要系统授权；拒绝或被撤销后按实际读数显示。' },
      { type: 'action', label: '厂家自启动设置', action: 'open-manufacturer-settings', description: '厂家开关无法读取，跳转后需你手动允许。' },
      { type: 'action', label: '精确闹钟授权', action: 'open-exact-alarm-settings', description: '授权后自检闹钟可按时唤醒本机。' }
    );
  }
  if (id === 'log-detail') {
    const metadata = logMetadata(logRecord(host, options.logRecord));
    // This read-only layer has no control indices. Do not pad a real record with
    // layout instructions; show its optional metadata only when actually supplied.
    next.fields = next.fields.flatMap(field => field.liveSourceLabel !== '完整记录' ? [field]
      : metadata.length ? [{ ...field, type: 'list', items: metadata, description: '' }] : []);
  }
  /* Gallery links choose an illustration of a state, rather than doing an operation. They are not
   * production routes. Genuine state transitions come from the formal action's response instead. */
  /* Keep real settings and read-only help links. State-gallery links still never
   * enter production: success/failure/progress must come from an actual action. */
  const relatedTargets = {
    'art-detail': ['art-replenish', 'customer-art-link', 'art-status'],
    'log-filters': ['logs-pagination'],
  }[id] || [];
  next.related = (spec.related || []).filter(one => relatedTargets.includes(one.target || one.id));
  next.scenarios = [];
  if (DAILY_PANELS.has(id)) next.fields.forEach(field => { field.label = field.label.replace(' · 状态示例', ''); });
  if (id === 'help' || id === 'app-help') next.fields.forEach(field => { if (field.liveSourceLabel === '原型数据') field.label = '数据来源'; });
  if (id.startsWith('background-')) next.fields.forEach(field => { if (field.liveSourceLabel === '浏览器原型') field.label = '权限读取'; });
  if (id === 'background-open-result') next.fields.forEach(field => {
    if (field.liveSourceLabel === '在正式 Android App 中') field.label = '系统设置启动';
    if (field.liveSourceLabel === '浏览器原型') field.label = '打开结果';
  });
  if (id === 'log-detail') next.fields.forEach(field => { if (field.liveSourceLabel === '记录内容示例') field.label = '记录内容'; });
  if (id === 'logs-account') next.fields.forEach(field => {
    if (field.target === 'log-detail') { field.target = ''; field.action = 'view-account-logs'; }
  });
  if (id === 'logs-device') next.fields.forEach(field => {
    if (field.target === 'logs-error') { field.label = '重新读取本机日志'; field.target = ''; field.action = 'view-device-logs'; }
  });
  if (SOFTWARE_PANELS.has(id)) next.subtitle = '数据来自当前软件会话；游戏号运行仍由你手动开始。';
  else if (SUBTITLE[id]) next.subtitle = SUBTITLE[id];
  else if (hasPrototypeCopy(next.subtitle)) next.subtitle = RULE_PANELS.has(id) ? '以下说明各状态的含义，不代表当前游戏号同时处于这些状态。'
    : spec.scope === 'config' ? '设置按当前游戏号独立保存。' : '数据以本次实际读取和操作结果为准。';
  if (id === 'license-offline') next.title = '离线宽限';
  if (id.startsWith('license-') && !['license-checking', 'license-error', 'license-offline'].includes(id)) next.title = '软件授权状态';
  if (id.startsWith('sync-')) next.title = '日志同步状态';
  if (id.startsWith('data-ownership-')) next.title = '本机资料归属状态';
  if (['service-loading', 'service-disconnected', 'service-unread'].includes(id)) next.title = '手机运行服务';
  if (id === 'connection-help') next.title = '手机服务连接';
  if (id === 'auth-cloud-missing') next.title = '软件云服务配置';
  if (id.startsWith('auth-login-') || id === 'auth-error') next.title = '软件登录状态';
  if (id.startsWith('auth-register-')) next.title = '软件注册状态';
  if (id === 'auth-error' && authFailure(host).kind === 'register') {
    next.title = '软件注册状态';
    next.subtitle = '核对这次注册的实际原因，再返回注册表单处理。';
    next.fields.forEach(field => { if (field.liveSourceLabel === '连接结果') field.label = '注册结果'; });
  }
  if (id.startsWith('add-account-')) next.title = '游戏号核对状态';
  if (['account-starting', 'account-stopping', 'account-stopped', 'account-action-unknown'].includes(id)) next.title = '游戏号当前状态';
  if (id.startsWith('remove-account-')) next.title = '游戏号移除状态';
  if (id.startsWith('password-')) next.title = '软件密码修改状态';
  if (id.startsWith('logout-')) next.title = '软件退出状态';
  if (id.startsWith('network-') && id !== 'network-clear') next.title = '统一网络出口状态';
  if (id.startsWith('save-')) next.title = '设置保存状态';
  if (id.startsWith('background-') && id !== 'background-settings') next.title = '手机系统设置';
  if (id === 'background-settings-error') next.title = backgroundResult(host)?.status === 'unknown' ? '系统设置打开结果未确认' : '设置页面未能打开';
  if (id === 'log-detail' && !logRecord(host, options.logRecord)) next.subtitle = '请在运行日志中点击一条记录，再查看详情。';
  for (const key of ['primary', 'secondary', 'tertiary']) {
    if (next[key]) next[key] = { ...next[key], label: String(next[key].label || '').replace(/[（(]\s*演示\s*[)）]/g, '').trim() };
  }
  if (id === 'battery' && next.primary) {
    next.primary = { ...next.primary, action: 'open-background-settings' };
    delete next.primary.target;
  }
  if (['auth-login-loading', 'auth-register-loading', 'add-account-verifying'].includes(id)) {
    // A progress layer cannot navigate to a made-up success response. The formal
    // request owns the next state; closing this explanation never marks it complete.
    next.primary = { label: '返回查看进度', action: 'close' };
    delete next.secondary;
    delete next.tertiary;
  }
  return next;
}

/** Context hooks consumed by fieldMarkup/panelMarkup and the formal sheet shell.
 * `values` is the active child draft, supplied by entry.js; never read a design default.
 * `logRecord` must be the exact clicked record. Missing binding stays explicit, not first-row fallback. */
export function createLivePanelContext(host, id, options = {}) {
  const sourceField = field => ({ ...field, label: field.liveSourceLabel ?? field.label });
  return {
    resolve(field) {
      const source = sourceField(field);
      if (field.key) return get(options.values || {}, field.key);
      if (field.type === 'list') return field.items || field.rows || [];
      if (field.type === 'status') return readingText(host, id, source, resolveStatus(host, id, source, options));
      if (field.type === 'note') return dynamicDescription(host, id, source, options.logRecord, options.refreshing);
      return '';
    },
    resolveDescription: field => dynamicDescription(host, id, sourceField(field), options.logRecord, options.refreshing),
    resolveField(field) {
      const description = dynamicDescription(host, id, sourceField(field), options.logRecord, options.refreshing);
      const next = { ...field, description };
      /* Prevent a stale static success icon from claiming an unobserved success. The exact result
       * tone is derived from the same operation fact as its text, not from the selected gallery ID. */
      if (field.type === 'status' && !RULE_PANELS.has(id)) {
        const authKind = id.startsWith('auth-register-') ? 'register' : id.startsWith('auth-login-') ? 'login' : null;
        const result = id === 'auth-error' ? authFailure(host).result : authKind ? authResult(host, id, authKind)
          : id.startsWith('add-account-') ? addResult(host, id) : operation(host, id);
        if (result) next.tone = result.status === 'success' ? 'success' : result.status === 'error' ? 'danger' : result.status === 'pending' ? 'loading' : 'warning';
        else if (id.startsWith('license-') || SOFTWARE_PANELS.has(id)) next.tone = host.state?.online === true && ['granted', 'needs_renew'].includes(software(host)?.licenseState) ? 'success' : 'warning';
        else next.tone = '';
        if (SERVICE_PANELS.has(id) && SERVICE_CONNECTION_FIELDS.has(field.liveSourceLabel || field.label)) next.tone = serviceConnection(host, options.refreshing).tone;
        if (['background-open-result', 'background-settings-error'].includes(id)) {
          const status = backgroundResult(host)?.status;
          next.tone = status === 'intent-accepted' ? 'info' : status === 'pending' ? 'loading' : status ? 'warning' : '';
        }
        if (id === 'log-detail' && (field.liveSourceLabel || field.label) === '状态') {
          next.tone = logPresentation(logRecord(host, options.logRecord) || {}).tone;
        }
      }
      return next;
    },
    resolveText(text) {
      return String(text ?? '').replaceAll('{{account}}', accountName(host)).replaceAll('{account}', accountName(host));
    },
    footerNote: RULE_PANELS.has(id) ? '状态说明，实际结果以本机读数为准。'
      : ['log-detail', 'logs-account', 'logs-device'].includes(id) ? '记录保留实际内容，不提供修改结果的入口。'
        : '状态来自本机读数，未读取与零分别显示。',
  };
}
