/* Moon presentation components - the prototype's own builders moved into the app.
   Source: docs/design/20261020/prototype.js lines 32-53 (nav, title, accountPicker, settingsHeader, section,
   toggle, feature, summary, saveDock, pageStateMarkup). Class names, parent/child order and attribute shapes stay
   identical; only two things differ by design: the fake system bar / gesture strip never ship, and every control
   carries the formal app bindings (data-path / data-input / data-check / data-panel / data-view / data-action)
   instead of the prototype's in-memory demo state. */
import { icon } from './icons.js';

export const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export function iconButton(name, label, attributes = '', extra = '') {
  return `<button type="button" class="icon-button ${extra}" aria-label="${esc(label)}" ${attributes}>${icon(name)}</button>`;
}

export function avatar(initial, tone = '') {
  return `<span class="avatar ${tone}" aria-hidden="true">${esc(initial || '')}</span>`;
}

/* 主导航只负责主路由，二级分类只在 settings-context 里表达。
   一个按钮同时带 data-tab/data-stab 会被分类委托提前消费，造成只重绘而不切页。 */
export function nav(active) {
  const items = [['accounts', 'Sprout', '游戏号', 'accounts'], ['land', 'SlidersHorizontal', '设置', 'settings'],
    ['logs', 'ScrollText', '日志', 'logs'], ['me', 'UserRound', '我的', 'me']];
  return `<nav class="bottom-nav" aria-label="主导航">${items.map(([view, iconName, label, dataTab]) => {
    const on = view === active;
    return `<button type="button" class="${on ? 'active' : ''}" data-tab="${dataTab}" ${on ? 'aria-current="page"' : ''}><span class="nav-icon">${icon(iconName)}</span>${label}</button>`;
  }).join('')}</nav>`;
}

export function title(name, panel, iconName = 'CircleHelp') {
  return `<header class="top-title"><h1>${esc(name)}</h1>${iconButton(iconName, '查看详情', `data-panel="${esc(panel)}"`)}</header>`;
}

export function accountPicker(vm, compact = false) {
  const one = !compact && vm.view === 'logs' && vm.logSource ? vm.logSource : !compact && vm.logsScope === 'device'
    ? { name: '本机 / 添加记录', initial: '机', meta: '本机全部记录 · 软件连接与账号添加' }
    : vm.account || { name: vm.rosterState === 'loading' ? '正在读取游戏号' : vm.rosterState === 'error' ? '游戏号未读取' : '暂无游戏号', initial: '' };
  const disabled = compact && !vm.account ? ' disabled' : '';
  const logsMeta = !compact && vm.view === 'logs' && vm.logSource ? one.meta : vm.logsScope === 'device' ? one.meta : vm.account ? '当前游戏号 · 仅查看本账号记录' : '请选择本机记录或已有游戏号';
  return compact
    ? `<button type="button" class="compact-account" data-panel="choose-account" aria-label="选择当前游戏号"${disabled}>${avatar(one.initial, one.tone)}<span>${esc(one.name)}</span>${icon('ChevronDown')}</button>`
    : `<button type="button" class="account-choice" data-panel="choose-account" aria-label="选择日志来源"><span class="choice-person">${avatar(one.initial, one.tone)}<span>${esc(one.name)}<span class="choice-meta">${esc(logsMeta)}</span></span></span>${icon('ChevronsUpDown')}</button>`;
}

export function settingsHeader(tab, vm) {
  const cats = [['land', '种花养花'], ['orders', '交订单'], ['art', '花架花艺'], ['rewards', '任务福利'], ['guild', '公会']];
  return `<header class="top-title settings-title"><h1>自动化设置</h1>${accountPicker(vm, true)}</header>`
    + `<div class="settings-context"><nav class="tabs" aria-label="设置分类">${cats.map(([view, label]) =>
      `<button type="button" class="${view === tab ? 'active' : ''}" data-stab="${view}">${label}</button>`).join('')}</nav></div>`;
}

export const section = (name, note = '') => `<div class="section-label"><h2>${esc(name)}</h2><span>${esc(note)}</span></div>`;

/* role=switch on a bare track, exactly as designed; the formal draft path drives aria-checked. */
export function toggle(path, label, checked, disabled = false) {
  return `<button type="button" class="toggle" role="switch" aria-label="${esc(label)}" aria-checked="${checked === true}" data-path="${esc(path)}"${disabled ? ' disabled' : ''}><span class="toggle-track"></span></button>`;
}

export function feature(row) {
  if (!row.panel) return `<div class="feature-row"><div class="clickable-feature"><span class="feature-icon ${row.tone || ''}">${icon(row.icon)}</span><span class="feature-copy"><h2>${esc(row.name)}</h2><p>${esc(row.desc)}</p></span></div>${toggle(row.path, row.name, row.checked, row.disabled)}</div>`;
  return `<div class="feature-row"><button type="button" class="clickable-feature" data-panel="${esc(row.panel)}"><span class="feature-icon ${row.tone || ''}">${icon(row.icon)}</span><span class="feature-copy"><h2>${esc(row.name)}</h2><p>${esc(row.desc)}</p></span>${icon('ChevronRight', 'chevron')}</button>${toggle(row.path, row.name, row.checked, row.disabled)}</div>`;
}

export const summary = (label, value, panel) =>
  `<button type="button" class="summary-row" data-panel="${esc(panel)}"><span>${esc(label)}</span><span>${esc(value)}${icon('ChevronRight')}</span></button>`;

/* 保存区的「开始/停止」必须走正式动作名并带上稳定账号 ID。
   旧实现发的是 start-account / stop-account，而正式层只认 start / stop，且这个按钮没有 data-id：
   点下去既不弹确认也不报错，什么都不发生。正式层的同位置按钮（app.js 的 .save-run）一直是
   data-action="start|stop" + data-id，这里对齐它，缺 ID 时不许假装能点。 */
export function saveDock(vm) {
  const clean = !vm.dirty;
  const ready = vm.configReady === true;
  const saveEnabled = ready && vm.online && !vm.busy;
  /* 等待中的号（启动/连接/恢复/停止）只提供停止，不能再给一个开始按钮。 */
  const stoppable = vm.running || vm.pending;
  const action = stoppable ? 'stop' : 'start';
  const label = (vm.running || vm.pending) ? '停止' : '开始';
  const runnable = vm.accountId && (stoppable ? vm.canStop === true : vm.online && !vm.busy && ready);
  const unavailable = !vm.accountId ? '先添加或选择一个游戏号'
    : stoppable && !vm.canStop ? '这个账号的停止身份尚未核实，先刷新账号状态'
      : !stoppable && !vm.online ? '本机服务未连接，先重新连接'
        : !stoppable && !ready ? '先读取这个游戏号的设置' : '正在处理，请稍后再试';
  const runButton = runnable
    ? `<button type="button" class="secondary" data-action="${action}" data-id="${esc(vm.accountId)}">${label}</button>`
    : `<button type="button" class="secondary" disabled title="${unavailable}">${label}</button>`;
  const saveLabel = ready ? (clean ? '设置已保存' : '保存设置')
    : vm.pageState === 'loading' ? '正在读取设置' : vm.pageState === 'empty' ? '先添加游戏号' : '设置未读取';
  const hint = !vm.accountId && vm.pageState === 'empty' ? '添加游戏号后，才能读取和保存本账号设置。'
    : !ready ? '设置读取完成前，不会保存或自动开始运行。'
      : '保存仅对当前游戏号生效；不会自动开始运行';
  return `<footer class="save-dock"><div class="save-row"><button type="button" class="primary" data-action="save-config" data-clean="${ready && clean}"${saveEnabled ? '' : ' disabled'}>${icon(ready ? 'Check' : vm.pageState === 'loading' ? 'LoaderCircle' : 'SlidersHorizontal')}${saveLabel}</button>${runButton}</div><p>${hint}</p></footer>`;
}

/* Real read states: loading / not-read / empty keep the designed page-empty shape. The prototype's demo copy
   ("示意") is replaced by what actually happened, and a failed read is never presented as empty data. */
export function pageStateMarkup(area, state, details = {}) {
  if (state === 'loading') return `<div class="page-empty">${icon('LoaderCircle')}<h2>正在读取${area}</h2><p>读取完成前，已有设置与任务意图会保留。</p></div><div class="skeleton"></div><div class="skeleton"></div>`;
  if (state === 'error') return `<div class="page-empty">${icon('CloudOff')}<h2>${area}暂时没读到</h2><p>${esc(details.error || '没有把读取失败当作空数据。重新连接后再读取当前状态。')}</p><button type="button" class="primary" data-action="${esc(details.retryAction || (area === '游戏号' ? 'refresh' : 'reload-config'))}">重新读取</button><button type="button" class="advanced-link" data-panel="connection-help">查看连接说明</button></div>`;
  if (state === 'empty') return `<div class="page-empty">${icon('Sprout')}<h2>这里还没有游戏号</h2><p>添加你有权使用的游戏号，设置好功能后再开始。</p><button type="button" class="primary" data-panel="add-account">添加游戏号</button></div>`;
  if (state === 'logs-empty') return `<div class="page-empty">${icon('ScrollText')}<h2>这组筛选暂无记录</h2><p>换个分类或日期，也可以清除筛选查看全部。</p><button type="button" class="primary" data-action="clear-log-filters">清除筛选</button></div>`;
  if (state === 'logs-none') return `<div class="page-empty">${icon('ScrollText')}<h2>这里还没有运行记录</h2><p>当前来源尚无记录；产生新的真实记录后会显示在这里。</p></div>`;
  return '';
}

export const toolbarStatus = vm =>
  `<button type="button" class="toolbar-status" data-panel="service"><i class="dot"></i>${esc(vm.connectionLabel)}${icon('ChevronRight')}</button>`;

export function pageHeading(vm) {
  return `<div class="page-heading"><div><h1>我的游戏号</h1><p>你的每一座小花园，都在这里。</p></div>${iconButton('Plus', '添加游戏号', 'data-panel="add-account"', 'add')}</div>`;
}

export function gardenBanner(vm) {
  return `<section class="garden-banner"><p class="eyebrow">ENDLESS SUMMER</p><h2>花开无尽夏</h2><p class="banner-slogan">雨落有晴天</p><p class="banner-sub">${vm.counts.running} 个运行中 &nbsp;·&nbsp; ${vm.counts.stopped} 个已停止</p><img src="brand/garden-moon.png" alt=""></section>`;
}

export function filters(vm) {
  return `<div class="filters">${[['all', '全部'], ['running', '运行中'], ['stopped', '已停止']].map(([key, label]) =>
    `<button type="button" data-filter="${key}" class="${vm.accountFilter === key ? 'active' : ''}">${label}<span>${vm.counts[key]}</span></button>`).join('')}</div>`;
}

export function accountCard(one) {
  /* 卡片上的开始/停止同样用正式动作名 start / stop，账号 ID 一直带着；
     旧名 start-account / stop-account 在正式层没有任何处理分支。
     启动、连接、等待恢复和正在停止时只能停，不能重复开始。 */
  const stoppable = one.running || one.pending;
  return `<article class="account-card ${one.running ? 'running-card' : ''}"><div class="account-top">${avatar(one.initial, one.tone)}<div class="account-identity"><h2>${esc(one.name)}</h2><p>游戏账号 · 手机本地执行</p></div><span class="badge ${one.running ? 'green' : ''}">${one.badge}</span><button type="button" class="account-more" aria-label="${esc(one.name)}更多操作" data-panel="account-more" data-id="${esc(one.id)}">${icon('Ellipsis')}</button></div><p class="account-summary">${icon(one.summaryIcon)}${esc(one.summary)}</p><div class="account-actions"><button type="button" data-action="account-settings" data-id="${esc(one.id)}">${icon('SlidersHorizontal')}设置</button><button type="button" data-action="account-logs" data-id="${esc(one.id)}">${icon('ScrollText')}日志</button><button type="button" class="primary-small ${stoppable ? 'stop-small' : ''}" data-action="${stoppable ? 'stop' : 'start'}" data-id="${esc(one.id)}"${one.actionDisabled ? ' disabled' : ''}>${icon(stoppable ? 'Square' : 'Play')}${stoppable ? '停止' : '开始'}</button></div></article>`;
}
