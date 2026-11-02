/* The formal flows own their forms, validation, requests and dialog stack. This adapter only replaces
   their presentation with the selected prototype's panelMarkup/fieldMarkup structure (source:
   docs/design/20261020/prototype.js). It never reads prototype field.value or creates action results. */
import { icon } from './icons.js';
import { esc } from './components.js';
import { PANEL_SPECS } from './specs.js';

/* Only identity/kind/group metadata is used. Production text and readouts never fall back to
   spec.fields/value. In particular, starting/stopping confirmations are bottom sheets in this design. */
const mapped = (panel, details = {}) => ({ panel, kind: PANEL_SPECS[panel]?.kind || 'sheet',
  group: PANEL_SPECS[panel]?.group || '无尽夏', ...details });
const accountLayout = (panel, subtitle, details = {}) => mapped(panel, {
  accountSubtitle: true, subtitle, ...details,
});

/* Explicit identities let a comparison locate the corresponding frozen prototype panel. A mapping
   means structure has been adapted, not that device geometry or any live action has passed. */
export const FORMAL_DIALOG_LAYOUTS = Object.freeze({
  '添加游戏号': mapped('add-account', { title: '添加游戏号', subtitle: '先核对官服身份，再保存到本机', introLabel: '添加流程',
    introText: '添加时会使用填写的账号密码登录游戏一次，核对成功后保存；区服由游戏服务器确认，无需手选。',
    footerNote: '添加会核对并保存，不会自动开始运行。' }),
  '修改软件账号密码': mapped('password', { title: '修改软件账号密码', subtitle: '这里修改软件密码，和游戏密码无关', introLabel: '改密后需要重新登录',
    introText: '本机软件会话全部作废，正在运行的任务会先停止。', introTone: 'warning',
    footerNote: '提交后修改软件密码，并使旧软件会话退出。' }),
  '网络出口': mapped('network', { title: '统一网络出口', subtitle: '全部游戏号共用这台手机的出口设置', footerNote: '保存统一出口，不会自动开始游戏任务。' }),
  '统一网络出口': mapped('network', { title: '统一网络出口', subtitle: '全部游戏号共用这台手机的出口设置', footerNote: '保存统一出口，不会自动开始游戏任务。' }),
  /* Production-only disclosure for an existing setting, rather than a gallery state selector. */
  '日志上传网络': { panel: 'upload-policy', group: '我的', kind: 'sheet', subtitle: '只影响运行日志的上传时机' },
  '我的软件账号': mapped('software-account', { title: '软件授权', subtitle: '软件身份与运行资格' }),
  '软件授权': mapped('license', { title: '软件授权', subtitle: '软件身份与运行资格' }),
  '日志同步': mapped('sync', { title: '日志同步', subtitle: '本机队列状态' }),
  '运行服务': mapped('service', { title: '手机运行服务', subtitle: '数据以本机实际读取为准' }),
  '运行记录': mapped('log-detail', { title: '运行记录', subtitle: '记录内容与所属来源', log: true }),
  '退出软件账号': mapped('logout', { title: '退出软件账号？', subtitle: '退出前会先停止本机任务', protection: 'logout', footerNote: '确认后停止本机任务并退出软件账号。' }),
  '退出软件账号？': mapped('logout', { title: '退出软件账号？', subtitle: '退出前会先停止本机任务', protection: 'logout', footerNote: '确认后停止本机任务并退出软件账号。' }),
  '移除这个游戏号': mapped('remove-account', { title: '移除这个游戏号？', subtitle: '仅影响当前本机游戏号', protection: 'remove' }),
  '改用本机网络': mapped('network-clear'),
  '设置还没有保存': mapped('unsaved-settings'),
  '还有未保存的设置': mapped('unsaved-changes', { prototypeShell: true, subtitle: '离开前，选择如何处理当前账号的草稿。', introTone: 'warning',
    footerNote: '保存只更新当前设置，不会自动开始运行。' }),
  '开始照料花园': accountLayout('account-start', '开始请求与运行状态分开展示'),
  '停止当前任务': accountLayout('account-stop', '随时撤销当前运行意图'),
  '正在启动': accountLayout('account-starting', '开始请求已提交，按实际读回更新状态'),
  '正在停止': accountLayout('account-stopping', '停止请求已提交，等待实际停止状态'),
  '任务已停止': accountLayout('account-stopped', '已读回这个游戏号的实际停止状态'),
  '结果暂时无法确认': accountLayout('account-action-unknown', '启停请求结果待核对'),
  '欢迎回园': mapped('auth-login-success'),
  '先保存，再开始': mapped('start-unsaved'),
});

const FORMAL_DIALOG_KINDS = Object.freeze({
  'account-picker-sheet': mapped('choose-account', { nativeChoices: true, title: '选择游戏号',
    subtitle: '仅切换当前查看对象', footerNote: '仅切换查看对象，不改变已有运行安排。' }),
  'log-scope-picker-sheet': mapped('choose-account', { nativeChoices: true, title: '选择日志来源',
    subtitle: '查看本机记录或单个游戏号的运行日志', footerNote: '切换日志来源会回到第一页，不改变运行安排。' }),
  'account-starting-sheet': accountLayout('account-starting', '开始请求已提交，按实际读回更新状态'),
  'account-stopping-sheet': accountLayout('account-stopping', '停止请求已提交，等待实际停止状态'),
  /* Real request phases reuse the frozen account sheets. Their text comes from the request and
     subsequent GET, never the design's example state. A rejected request is distinct from unknown. */
  'account-action-start-request': accountLayout('account-starting', '正在等待本次启动请求响应', { actionFeedback: 'pending' }),
  'account-action-stop-request': accountLayout('account-stopping', '正在等待本次停止请求响应', { actionFeedback: 'pending' }),
  'account-action-start-state': accountLayout('account-starting', '按实际读回核对启动状态'),
  'account-action-stop-state': accountLayout('account-stopping', '按实际读回核对停止状态'),
  'account-action-error-sheet': accountLayout('account-starting', '本次请求未完成，查看实际原因', { actionFeedback: 'error' }),
  'account-action-unknown-sheet': accountLayout('account-action-unknown', '本次请求结果待核对，不重复提交', { actionFeedback: 'unknown' }),
  'account-action-stopped-sheet': accountLayout('account-stopped', '已读回这个游戏号的实际停止状态'),
});
function formalLayout(title, kind) {
  if (FORMAL_DIALOG_KINDS[kind]) return FORMAL_DIALOG_KINDS[kind];
  return FORMAL_DIALOG_LAYOUTS[title] || { group: '无尽夏', kind: kind === 'confirm' ? 'confirm' : 'sheet' };
}

const make = (tag, className = '') => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
};
const withIcon = (name, className) => {
  const fragment = make('span');
  fragment.innerHTML = icon(name, className);
  return fragment.firstElementChild;
};
function replaceTag(node, tag, className) {
  const next = make(tag, className);
  for (const attr of node.attributes) if (attr.name !== 'class') next.setAttribute(attr.name, attr.value);
  while (node.firstChild) next.append(node.firstChild);
  node.replaceWith(next);
  return next;
}
function note(label, content, tone = '') {
  const result = make('div', `panel-note${tone ? ` ${tone}` : ''}`);
  if (label) { const title = make('strong'); title.textContent = label; result.append(title); }
  if (typeof content === 'string') result.append(document.createTextNode(content));
  else if (content) result.append(content);
  return result;
}
function status(label, content, description = '', tone = '') {
  const result = make('section', `panel-status${tone ? ` ${tone}` : ''}`);
  result.append(withIcon(tone === 'danger' ? 'CircleAlert' : tone === 'warning' ? 'Clock3' : 'CircleCheck'));
  const copy = make('div');
  const caption = make('p', 'panel-eyebrow'); caption.textContent = label;
  const value = make('h3');
  if (typeof content === 'string') value.textContent = content;
  else if (content) value.append(content);
  copy.append(caption, value);
  if (description) { const detail = make('p'); detail.textContent = description; copy.append(detail); }
  result.append(copy);
  return result;
}

function presentationButton(button, placement = 'body') {
  /* Keep the original type/form/name/value, disabled flag, ID and action attributes. Event handlers
     are attached by the formal caller after this HTML has been inserted. */
  const primary = button.classList.contains('primary-button') || button.classList.contains('primary')
    || button.type === 'submit' || button.classList.contains('danger');
  const danger = button.classList.contains('danger');
  // Retire the old visual identity when adopting panel-link; its delegated action and all
  // non-class attributes stay on this same button. Keeping rules-row also kept its 7px gap
  // and 17px SVG override instead of the frozen panel-link's 12px gap and 16px icon.
  button.classList.remove('button', 'primary-button', 'wide', 'text-button', 'rules-row');
  if (placement === 'footer') {
    /* A submit button may previously have been secondary (the network inline submit is one).
       Keeping both semantic classes lets secondary styling override the actual primary action. */
    button.classList.remove('panel-link', 'primary', 'secondary', 'danger');
    button.classList.add(primary ? 'primary' : 'secondary');
    if (danger) button.classList.add('danger-primary');
    return;
  }
  if (button.classList.contains('toggle') || button.classList.contains('icon-button')) return;
  button.classList.remove('primary', 'secondary', 'danger');
  button.classList.add('panel-link');
  const copy = make('span');
  while (button.firstChild) copy.append(button.firstChild);
  button.append(copy, withIcon('ChevronRight'));
}

function adaptFields(root, serial) {
  let fieldIndex = 0;
  for (const label of [...root.querySelectorAll('label.field')]) {
    const input = label.querySelector('input, select, textarea');
    if (!input || ['checkbox', 'radio', 'hidden'].includes(input.type)) continue;
    const block = make('div', 'field-block');
    for (const attr of label.attributes) if (!['class', 'for'].includes(attr.name)) block.setAttribute(attr.name, attr.value);
    const caption = make('div', 'field-caption');
    const actualLabel = make('label');
    if (!input.id) input.id = `formal-field-${serial}-${++fieldIndex}`;
    actualLabel.htmlFor = input.id;
    const text = label.querySelector(':scope > span');
    if (text) while (text.firstChild) actualLabel.append(text.firstChild);
    else actualLabel.textContent = input.getAttribute('aria-label') || '';
    if (input.required || input.dataset.formalRequired === 'true' || ['currentPassword', 'newPassword'].includes(input.name)) { const mark = make('span', 'required-mark'); mark.textContent = '必填'; actualLabel.append(mark); }
    caption.append(actualLabel); block.append(caption);
    input.classList.add('panel-input');
    if (input.type === 'password') {
      const control = make('div', 'password-control'); control.append(input, revealButton(input.id)); block.append(control);
    } else block.append(input);
    /* Keep any validation/help nodes carried inside the old label. */
    text?.remove();
    while (label.firstChild) block.append(label.firstChild);
    label.replaceWith(block);
  }
  for (const input of root.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=hidden]), select, textarea')) input.classList.add('panel-input');
  for (const error of root.querySelectorAll('.form-error,.notice.error')) error.classList.add('field-error');
}

function revealButton(id) {
  const result = make('button', 'icon-button');
  result.type = 'button'; result.dataset.formalReveal = id;
  result.setAttribute('aria-label', '显示密码');
  result.setAttribute('aria-controls', id); result.setAttribute('aria-pressed', 'false');
  result.append(withIcon('Eye'));
  return result;
}

function adaptProtection(root, layout) {
  const intro = root.querySelector('.dialog-intro');
  if (!intro || !layout.protection) return;
  const text = intro.textContent || '';
  const split = layout.protection === 'logout' ? text.indexOf('游戏密码') : text.indexOf('历史操作记录');
  if (split < 1) return; // Keep unfamiliar current copy complete rather than guessing a split.
  const first = note(layout.protection === 'logout' ? '将撤销运行安排' : '将从本机移除', text.slice(0, split), layout.protection === 'logout' ? 'warning' : 'danger');
  const second = note(layout.protection === 'logout' ? '本机资料继续保留' : '历史记录仍保留', text.slice(split));
  intro.replaceWith(first, second);
}

function adaptFacts(root, layout) {
  /* dl rows are genuine values already escaped by the formal renderer, never design examples. */
  for (const list of [...root.querySelectorAll('dl.detail-list')]) {
    const rows = [...list.children];
    if (!rows.every(row => row.querySelector(':scope > dt') && row.querySelector(':scope > dd'))) {
      list.classList.add('panel-kv'); continue;
    }
    const values = document.createDocumentFragment();
    for (const row of rows) {
      const label = row.querySelector(':scope > dt').textContent;
      const value = row.querySelector(':scope > dd');
      const contents = document.createDocumentFragment();
      while (value.firstChild) contents.append(value.firstChild);
      values.append(status(label, contents));
    }
    list.replaceWith(values);
  }
  for (const card of [...root.querySelectorAll('section.infocard')]) {
    const heading = card.querySelector(':scope > .infocard-top strong');
    const body = card.querySelector(':scope > p');
    if (!heading || !body || card.querySelector('input,button,form')) continue;
    const label = heading.textContent || '';
    if (layout.log && ['记录时间', '所属游戏号', '分类'].includes(label)) {
      card.replaceWith(status(label, body.textContent));
    } else if (layout.log && label.startsWith('状态 · ')) {
      const value = label.slice('状态 · '.length);
      card.replaceWith(status('状态', value, body.textContent, /需要处理|失败/.test(value) ? 'danger' : /留意|等待/.test(value) ? 'warning' : ''));
    } else if (body.querySelector('strong')) {
      const headline = body.querySelector('strong');
      const description = body.textContent.slice(headline.textContent.length).trim();
      const actionTone = card.hasAttribute('data-account-action-result') && layout.actionFeedback
        ? layout.actionFeedback === 'error' ? 'danger' : 'warning' : '';
      card.replaceWith(status(label, headline.textContent, description, actionTone || (/等待|正在|暂时/.test(headline.textContent) ? 'warning' : '')));
    } else {
      const contents = document.createDocumentFragment(); while (body.firstChild) contents.append(body.firstChild);
      card.replaceWith(note(label, contents, card.classList.contains('warn') ? 'warning' : ''));
    }
  }
}

function adaptNetwork(root, footer) {
  const form = root.querySelector('#egress-form');
  const input = form?.querySelector('#egress-input');
  if (!form || !input) return;
  if (form.dataset.formalFields === 'network') {
    const current = root.querySelector('[data-formal-network-status]');
    if (current) current.replaceWith(status('当前方式', current.textContent,
      '已配置代理时显示脱敏地址；敏感账号密码不回显。'));
    return;
  }
  const label = form.querySelector('label[for=egress-input]');
  const row = form.querySelector('.egress-input-row');
  const apply = row?.querySelector('button[type=submit]');
  const clear = row?.querySelector('[data-action=clear-egress]');
  const route = form.querySelector('.egress-status');
  if (route) { form.before(status('当前方式', route.textContent)); route.remove(); }
  const field = make('div', 'field-block');
  const caption = make('div', 'field-caption');
  const fieldLabel = label || make('label');
  fieldLabel.htmlFor = input.id; fieldLabel.textContent = '出口 IP / 代理地址';
  const required = make('span', 'required-mark'); required.textContent = '必填'; fieldLabel.append(required);
  caption.append(fieldLabel);
  const control = make('div', 'password-control');
  input.classList.add('panel-input'); control.append(input, revealButton(input.id));
  field.append(caption, control); form.prepend(field);
  if (apply && footer) {
    apply.setAttribute('form', form.id);
    if (apply.textContent.trim() === '应用') apply.textContent = '应用到所有账号';
    presentationButton(apply, 'footer');
    const actions = footer.querySelector('.panel-actions');
    if (actions) actions.append(apply);
    else { const actions = make('div', 'panel-actions'); actions.append(apply); footer.append(actions); }
  }
  if (clear) { clear.textContent = '改用本机网络'; form.after(clear); }
  if (row && !row.children.length) row.remove();
  for (const card of [...root.querySelectorAll('.egress-block')]) {
    const fragment = document.createDocumentFragment(); while (card.firstChild) fragment.append(card.firstChild); card.replaceWith(fragment);
  }
}

/* Native form ownership is independent of visual containment. Keep the formal form ID/listeners,
   FormData/reportValidity/reset and Enter submission, while fields/notes become the same visible
   panel-scroll children as the prototype. The empty hidden owner is never a displayed component. */
function exposeFormalFields(root, layout) {
  const id = ({ 'add-account': 'add-account-form', password: 'software-password-form', network: 'egress-form' })[layout.panel];
  const form = id && root.querySelector(`#${id}`);
  if (!form) return;
  for (const control of form.querySelectorAll('input,select,textarea,button')) {
    if (!control.hasAttribute('form')) control.setAttribute('form', form.id);
  }
  const contents = document.createDocumentFragment();
  while (form.firstChild) contents.append(form.firstChild);
  form.before(contents);
  form.hidden = true;
}

function adaptBody(root, layout, serial, footer) {
  // Only the account request family promotes this explicit target/context paragraph to
  // the frozen subtitle slot. Its status, reasons and protection fields remain in the body.
  if (layout.accountSubtitle) root.querySelector('[data-account-subtitle]')?.remove();
  adaptProtection(root, layout);
  const logIntro = layout.log && root.querySelector('.dialog-intro');
  if (logIntro && logIntro.textContent.trim() === '展示信息层级，不伪造官服结果。') logIntro.remove();
  if (layout.panel === 'network') adaptNetwork(root, footer);
  adaptFields(root, serial);
  adaptFacts(root, layout);
  if (layout.panel === 'add-account') {
    const help = root.querySelector('#add-account-form > p.small');
    if (help) {
      const text = help.textContent || '';
      /* The waiting-time sentence is already the note heading in the frozen design. Repeating it
         below the heading added a whole line. Keep the actual ownership/password warning. */
      const start = text.indexOf('只添加你有权使用的账号');
      const warning = start >= 0 ? text.slice(start).replace('密码不会显示在账号列表', '密码不会显示在游戏号列表') : text;
      help.replaceWith(note('核对期间请等待', warning));
    }
  }
  const footerAction = ({ 'software-account': 'check-license', license: 'check-license', sync: 'upload-logs' })[layout.panel];
  if (footerAction) {
    const action = root.querySelector(`button[data-action="${footerAction}"]`);
    if (action && footer) { presentationButton(action, 'footer'); footer.querySelector('.panel-actions')?.append(action); }
  }
  for (const intro of [...root.querySelectorAll('.dialog-intro')]) {
    const next = replaceTag(intro, 'div', `panel-note${layout.introTone ? ` ${layout.introTone}` : ''}`);
    /* These two mapped texts are the prototype's real production rules, not its demo notes. */
    if (layout.introText) next.textContent = layout.introText;
    if (layout.introLabel) { const label = make('strong'); label.textContent = layout.introLabel; next.prepend(label); }
  }
  for (const paragraph of root.querySelectorAll('p.small.muted,p.prow-note,p.row-note')) {
    paragraph.classList.remove('small', 'muted', 'prow-note', 'row-note'); paragraph.classList.add('field-description');
  }
  for (const notice of [...root.querySelectorAll('.notice:not(.error)')]) {
    replaceTag(notice, 'div', `panel-note${notice.classList.contains('warning') ? ' warning' : ''}`);
  }
  for (const row of root.querySelectorAll('.switch-row')) {
    row.classList.add('panel-toggle');
    row.querySelector('.switch-copy')?.classList.add('field-copy');
    const title = row.querySelector('.switch-copy > strong');
    if (title) replaceTag(title, 'h3', '');
    const button = row.querySelector('.switch-button');
    if (button) { button.classList.remove('switch-button'); button.classList.add('toggle'); }
    const track = button?.querySelector('.switch-track');
    if (track) { track.classList.remove('switch-track'); track.classList.add('toggle-track'); }
  }
  for (const button of root.querySelectorAll('button.button,button.rules-row,button.text-button')) presentationButton(button);
  for (const actions of root.querySelectorAll('.dialog-actions')) {
    actions.classList.remove('dialog-actions'); actions.classList.add('formal-links');
  }
  for (const card of root.querySelectorAll('section.card')) {
    card.classList.remove('card'); card.classList.add('formal-group');
    const heading = card.querySelector(':scope > .section-head');
    if (heading) { heading.classList.add('formal-group-heading'); heading.querySelector('h2')?.classList.add('panel-heading'); }
  }
  exposeFormalFields(root, layout);
}

function adaptFooter(raw) {
  const template = make('template'); template.innerHTML = String(raw || '');
  const result = make('footer', 'panel-footer');
  const actions = template.content.querySelector('.dialog-actions');
  if (actions) { actions.classList.remove('dialog-actions'); actions.classList.add('panel-actions'); }
  for (const button of template.content.querySelectorAll('button')) presentationButton(button, 'footer');
  result.append(template.content);
  return result;
}

/* A live status refresh can replace only .panel-scroll's innerHTML, preserving the formal stack,
   header, listeners, focused action and fixed footer. No new action response or state is produced. */
export function renderFormalDialogBody({ title, body, kind = '', index = 1 }) {
  const layout = formalLayout(title, kind);
  const serial = String(index).replace(/[^a-zA-Z0-9_-]/g, '') || '1';
  const raw = make('template'); raw.innerHTML = String(body || '');
  /* During a body-only refresh controls cannot be moved to a discarded temporary footer. */
  adaptBody(raw.content, layout, serial, null);
  const contents = make('div'); contents.append(raw.content);
  return contents.innerHTML;
}

export function renderFormalDialog({ title, body, footer = '', kind = '', index = 1 }) {
  const layout = formalLayout(title, kind);
  const serial = String(index).replace(/[^a-zA-Z0-9_-]/g, '') || '1';
  const titleId = `formal-dialog-title-${serial}`;
  const isConfirm = ['confirm', 'dialog'].includes(layout.kind);
  const raw = make('template'); raw.innerHTML = String(body || '');
  const subtitle = layout.accountSubtitle
    ? raw.content.querySelector('[data-account-subtitle]')?.textContent || layout.subtitle
    : layout.subtitle;
  const renderedFooter = adaptFooter(footer);
  adaptBody(raw.content, layout, serial, renderedFooter);
  const close = renderedFooter.querySelector('[data-action=close-dialog]');
  if (close && ['software-account', 'license', 'sync', 'network'].includes(layout.panel)) close.textContent = layout.panel === 'network' ? '取消' : '返回';
  // Every frozen panel includes this footer caption. Keep production-specific copy first;
  // only panels with an actual prototype spec receive the shared factual fallback.
  const footerNote = layout.footerNote || (PANEL_SPECS[layout.panel] ? '实际结果以本机读数为准。' : '');
  if (footerNote && !renderedFooter.querySelector('.preview-label')) {
    const caption = make('p', 'preview-label'); caption.append(withIcon('Eye'), document.createTextNode(footerNote));
    renderedFooter.append(caption);
  }
  const bodyNode = make('div', 'panel-scroll dialog-body'); bodyNode.append(raw.content);
  /* .dialog/.dialog-body and the original kind remain as compatibility selectors for formal dynamic
     updates. formal-dialogs.css overrides their old box rules using this specific class. */
  const safeKind = String(kind || '').split(/\s+/).filter(value => /^[a-zA-Z0-9_-]+$/.test(value)).join(' ');
  /* These two formal flows already supply the frozen radio fieldset/note markup. Keep the
     native prototype sheet classes, without legacy .dialog/.dialog-body/formal-dialog boxes:
     they would otherwise reapply text-input sizing to the radio controls. The moon-dialog
     marker remains for the real dialog stack, focus management and native Back handling. */
  if (layout.nativeChoices || layout.prototypeShell) return `<div class="sheet-scrim${isConfirm ? ' confirm-scrim' : ''}" data-formal-scrim><section class="bottom-sheet v2-sheet moon-dialog${isConfirm ? ' confirm-dialog' : ''}${safeKind ? ` ${safeKind}` : ''}" role="dialog" aria-modal="true" aria-labelledby="${titleId}" data-formal-panel="${esc(layout.panel)}"><div class="sheet-handle"></div><header class="sheet-header"><div><p class="panel-eyebrow">${esc(layout.group)}</p><h2 id="${titleId}">${esc(layout.title || title)}</h2></div><button type="button" class="icon-button" aria-label="关闭" data-action="close-dialog">${icon('X')}</button></header>${subtitle ? `<p class="panel-subtitle">${esc(subtitle)}</p>` : ''}<div class="panel-scroll">${bodyNode.innerHTML}</div>${renderedFooter.outerHTML}</section></div>`;
  return `<div class="sheet-scrim formal-dialog-scrim${isConfirm ? ' confirm-scrim' : ''}" data-formal-scrim><section class="bottom-sheet v2-sheet moon-dialog formal-dialog dialog${isConfirm ? ' confirm-dialog' : ''}${safeKind ? ` ${safeKind}` : ''}" role="dialog" aria-modal="true" aria-labelledby="${titleId}"${layout.panel ? ` data-formal-panel="${esc(layout.panel)}"` : ''}><div class="sheet-handle"></div><header class="sheet-header"><div><p class="panel-eyebrow">${esc(layout.group)}</p><h2 id="${titleId}">${esc(layout.title || title)}</h2></div><button type="button" class="icon-button" aria-label="关闭" data-action="close-dialog">${icon('X')}</button></header>${subtitle ? `<p class="panel-subtitle">${esc(subtitle)}</p>` : ''}${bodyNode.outerHTML}${renderedFooter.outerHTML}</section></div>`;
}

/* Call at the beginning of the moon capture handler. A handled click is consumed once; it cannot
   submit a form or bubble into the formal action delegate. No input value is read or copied. */
export function handleFormalDialogClick(event) {
  const button = event.target.closest?.('[data-formal-reveal]');
  if (!button || !button.closest('.formal-dialog')) return false;
  event.preventDefault(); event.stopPropagation();
  const input = document.getElementById(button.dataset.formalReveal);
  if (!input || !button.closest('.formal-dialog').contains(input) || input.disabled) return true;
  const visible = input.type === 'password';
  input.type = visible ? 'text' : 'password';
  button.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
  button.setAttribute('aria-pressed', String(visible));
  /* The frozen icon set contains Eye; keep that original path rather than inventing an EyeOff. */
  button.innerHTML = icon('Eye');
  return true;
}
