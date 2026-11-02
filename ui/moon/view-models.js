/* Projects the formal app state onto the prototype's view shape.
   Nothing here invents a second business state: every value is read from the app's own state, and a field
   without a real source is returned as undefined so the template renders 未读取 instead of an example number. */
import { get } from './panels.js';
import { logPresentation, logReadState } from './live-panels.js';

const UNREAD = '未读取';

const initial = name => String(name || '').slice(0, 1);

function accountTone(index) { return index === 1 ? 'lilac' : index === 2 ? 'blue' : ''; }

export function buildViewModel(host) {
  const state = host.state;
  const selectedAccount = host.selected();
  const accounts = Array.isArray(state.accounts) ? state.accounts : [];
  const rosterState = accountReadState(state);
  const configState = settingsPageState(host, rosterState);
  const logRead = logReadState(host);
  const accountFilter = ['running', 'stopped'].includes(state.accountFilter) ? state.accountFilter : 'all';
  const SETTINGS_VIEWS = ['land', 'orders', 'art', 'rewards', 'guild'];
  const view = state.tab === 'settings'
    ? (SETTINGS_VIEWS.includes(state.settingsTab) ? state.settingsTab : 'land') : state.tab;
  /* 本机服务给的是 state（running/starting/…）与 desiredRunning，没有 status：
     只读 status 会让运行中的号一直画成「已停止」，开始按钮也永远不复位。 */
  const accountStatus = account => String(account?.state || account?.status || account?.runtime?.state || '').toLowerCase();
  const isRunning = account => accountStatus(account) === 'running';
  const isPending = account => {
    if (host.isPending && host.isPending(account)) return true;
    if (account?.desiredRunning === true && !isRunning(account)) return true;
    return ['starting', 'connecting', 'queued', 'recovering', 'waiting_network', 'waiting_login', 'waiting_authorization', 'stopping', 'blocked'].includes(accountStatus(account));
  };
  const canPersistStop = account => Boolean(account && typeof account.ownerRef === 'string' && account.ownerRef &&
    typeof account.accountRef === 'string' && account.accountRef && typeof account.subjectRef === 'string' && account.subjectRef &&
    Number.isSafeInteger(account.uid) && account.uid > 0);
  const running = accounts.filter(isRunning);
  const pending = accounts.filter(account => isPending(account) && !isRunning(account));
  const stopped = Math.max(0, accounts.length - running.length - pending.length);
  const draft = state.draft || {};
  const catalog = host.catalog();

  return {
    identity: 'moon',
    build: host.buildId(),
    settingsTab: ['land', 'orders', 'art', 'rewards', 'guild'].includes(state.settingsTab) ? state.settingsTab : 'land',
    tab: state.tab,
    view,
    dirty: Boolean(state.dirty),
    busy: state.busy || '',
    online: state.online,
    draft,
    rosterState,
    accountsError: state.accountsError || '',
    configReady: configState === 'normal',
    pageError: rosterState === 'error' ? state.accountsError || '游戏号名册暂时无法读取，请重新连接后再试。' : state.configError || '',
    pageRetryAction: rosterState === 'error' ? 'refresh' : 'reload-config',
    /* 保存区/开始按钮要的那两个字段。旧版模板读 vm.running，而这里从来没提供过它，
       于是保存区不管当前号是不是在跑都显示「开始」；accountId 同理，缺了它按钮就没法带账号。 */
    running: Boolean(selectedAccount && isRunning(selectedAccount)),
    pending: Boolean(selectedAccount && isPending(selectedAccount) && !isRunning(selectedAccount)),
    canStop: Boolean(selectedAccount && (isRunning(selectedAccount) || isPending(selectedAccount)) && canPersistStop(selectedAccount)),
    accountId: selectedAccount ? String(selectedAccount.id) : null,
    account: selectedAccount ? {
      id: String(selectedAccount.id), name: host.accountName(selectedAccount), initial: initial(host.accountName(selectedAccount)),
      tone: accountTone(accounts.indexOf(selectedAccount)), meta: '当前游戏号 · 仅对本账号生效',
    } : null,
    counts: { all: accounts.length, running: running.length, stopped },
    connectionLabel: state.online ? (running.length ? `本机运行 · ${running.length} 个在跑` : '本机运行') : '未连接',
    accountFilter,
    pageState: pageStateFor(host, view, rosterState, configState, logRead),
    cards: accounts.map((account, index) => {
      const on = isRunning(account);
      const pendingState = !on && isPending(account);
      const stoppable = on || pendingState;
      const busyForAccount = state.busy === `stop:${account.id}`;
      return {
        id: String(account.id), name: host.accountName(account), initial: initial(host.accountName(account)), tone: accountTone(index),
        running: on, pending: pendingState,
        actionDisabled: stoppable ? !canPersistStop(account) || busyForAccount : !state.online || rosterState !== 'ready' || Boolean(state.busy),
        badge: on ? '<i class="dot"></i>运行中' : pendingState ? `<i class="dot"></i>${host.stateLabel(account)}` : '已停止',
        summaryIcon: on ? 'Leaf' : 'Moon',
        summary: on ? '按当前账号设置照料花园' : pendingState ? host.stateLabel(account) : '已停止，等你重新安排',
      };
    }).filter(card => accountFilter === 'running' ? card.running : accountFilter === 'stopped' ? !card.running && !card.pending : true),
    category: state.logsCategory && state.logsCategory !== '全部' ? state.logsCategory : '全部',
    moreLabel: state.logsCategory && !['', '全部', '种花', '浇水', '收花'].includes(state.logsCategory) ? `更多 · ${state.logsCategory}` : '',
    dayLabel: state.logsDay || '全部日期',
    dateHint: state.logsCategory || state.logsDay || state.logsKeyword || state.logsLevel || state.logsOutcome || state.logsErrorCode || state.logsTraceId || state.logsOperationId
      ? '筛选生效 · 点击查看详情' : host.logSourceView?.().archived ? '历史记录 · 已移除 · 只读' : state.logsScope === 'device' ? '本机记录 · 点击查看详情' : '账号记录 · 点击查看详情',
    logsScope: state.logsScope,
    logsUploadBusy: state.authBusy === true,
    logsKeyword: state.logsKeyword || '', logsLevel: state.logsLevel || '', logsOutcome: state.logsOutcome || '',
    logsErrorCode: state.logsErrorCode || '', logsTraceId: state.logsTraceId || '', logsOperationId: state.logsOperationId || '',
    logSource: host.logSourceView?.() || null,
    logsError: logRead.error,
    logsNotice: logRead.notice,
    logsContinuation: logRead.continuation,
    logsPending: logRead.pending,
    events: (state.logs || []).map(logEventView),
    pager: { page: (state.logsStack || []).length + 1, prevDisabled: !state.logsStack?.length || Boolean(logRead.loading || logRead.error || logRead.pending), nextDisabled: !state.logsHasMore || !state.logsOlder || Boolean(logRead.loading || logRead.error || logRead.pending) },
    /* 「我的」右列按原型只放短读数（一句状态词），完整说明留在各行详情里，避免长句把行高与右列挤走。 */
    license: host.licenseShort ? host.licenseShort() : UNREAD,
    sync: host.syncShort ? host.syncShort() : UNREAD,
    service: host.serviceShort ? host.serviceShort() : UNREAD,
    egress: host.egressShort ? host.egressShort() : UNREAD,
    licenseDetail: host.licenseLabel(), syncDetail: host.syncLabel(), egressDetail: host.egressLabel(),
    catalog,
  };
}

/* 原型的日志卡由标题、事实正文和状态组成。只在原句的语义分隔处拆开，不截字、不补一句
   示意结论；没有可拆的原句就用其真实分类作标题，把完整记录放回正文。详情仍读原始日志。 */
function logEventView(item, index) {
  const message = String(item.messageZh || item.message || item.text || item.summary || '').trim();
  const parts = /^([^：:；;。\n]+[：:；;。\n])([\s\S]+)$/u.exec(message);
  const title = parts ? parts[1].trim() : String(item.category || '运行记录');
  const body = parts ? parts[2].trim() : message || '这条记录暂时没有可显示的说明。';
  const presentation = logPresentation(item);
  return {
    index, title, body, status: presentation.status,
    tone: presentation.alert ? 'alert' : '',
    ...logTimeView(item.at ?? item.ts ?? item.timestamp ?? item.time ?? item.createdAt),
  };
}

/* 37px 时间列只放原型的 HH:mm。跨日的完整时刻保留在语义 time 属性和真实详情中，
   不能把 MM-dd HH:mm 硬塞进该列，再让它折成两行或靠缩字补救。 */
function logTimeView(value) {
  const date = value === undefined || value === null || value === '' ? null : new Date(value);
  if (!date || Number.isNaN(date.getTime())) return { time: '未读取', dateTime: '', timeLabel: '记录时间未读取' };
  const two = number => String(number).padStart(2, '0');
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`;
  return {
    time, dateTime: date.toISOString(),
    timeLabel: `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${time}:${two(date.getSeconds())}`,
  };
}

function accountReadState(state) {
  if (['loading', 'ready', 'error'].includes(state.accountsReadState)) return state.accountsReadState;
  if (state.loading) return 'loading';
  return state.online ? 'ready' : 'error';
}

function pageStateFor(host, view, rosterState, configState, logRead) {
  if (view === 'accounts') {
    const state = host.state;
    if (rosterState !== 'ready') return rosterState;
    return state.accounts?.length ? 'normal' : 'empty';
  }
  if (['land', 'orders', 'art', 'rewards', 'guild'].includes(view)) return configState;
  if (view === 'logs') {
    const state = host.state;
    if (logRead.error) return 'error';
    if (logRead.loading || logRead.pending && !state.logs?.length) return 'loading';
    if (state.logs?.length || logRead.notice) return 'normal';
    return state.logsCategory || state.logsDay || state.logsKeyword || state.logsLevel || state.logsOutcome || state.logsErrorCode || state.logsTraceId || state.logsOperationId || state.logsStack?.length
      ? 'logs-empty' : 'logs-none';
  }
  return 'normal';
}

function settingsPageState(host, rosterState = accountReadState(host.state)) {
  const state = host.state;
  if (rosterState !== 'ready') return rosterState;
  if (!state.accounts?.length) return 'empty';
  if (!host.selected()) return 'loading';
  /* 失败会清空 config/draft，必须先判错误；否则每次失败都会退化成无限加载。 */
  if (state.configError) return 'error';
  if (state.configLoading || !state.config || !state.draft) return 'loading';
  return 'normal';
}

/* Panel values: the draft is the single editing copy; inside a detail layer it is the sheet's own copy. */
export function panelValues(host) {
  return host.sheetDraft() || host.state.draft || {};
}

export { get };
