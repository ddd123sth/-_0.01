/* Mounts the moon presentation layer on top of the formal app state.
   Ownership stays where it was: ui/app.js keeps state, drafts, API, polling, dialog stack and every protection.
   This file only decides what is drawn, routes prototype hooks (data-panel) to the real flows, and renders
   panel bodies from the frozen panel tables with real draft values. */
import { icon } from './icons.js';
import { esc } from './components.js';
import { PAGES } from './pages.js';
import { PANEL_SPECS, PANEL_IDS } from './specs.js';
import { REWARD_PANEL_SPECS, REWARD_PANEL_IDS } from './reward-specs.js';
import { panelMarkup, fieldMarkup, fieldOptions, get } from './panels.js';
import { buildViewModel } from './view-models.js';
import { adaptLivePanelSpec, createLivePanelContext } from './live-panels.js';
import { renderFormalDialog, renderFormalDialogBody, handleFormalDialogClick } from './formal-dialogs.js';
import { compactSettingsSpec } from './settings-panels.js';

// R10 cards are registered before install() walks PANEL_IDS, so their sheets use
// exactly the same config transaction (child draft -> parent save) as the rest.
for (const id of REWARD_PANEL_IDS) {
  if (!PANEL_SPECS[id]) PANEL_SPECS[id] = REWARD_PANEL_SPECS[id];
  if (!PANEL_IDS.includes(id)) PANEL_IDS.push(id);
}

let host = null;
let picker = null;
let selectPopup = null;
let dismissSelectOnScrim = false;
const previewReads = new WeakMap();
const activePreviewReads = new Set();
const readViewSnapshots = new WeakMap();
const logFilterForms = new WeakMap();
const LOG_FILTER_PANELS = new Set(['log-filters', 'log-categories']);
let logFilterSequence = 0;
let mountedRoute = '';

/* 设计源里的按钮动作是示意名（add-preview-account / apply-preview-log-filters …），生成器原样搬进了
   PANEL_SPECS。它们在正式层没有任何分支，以前点下去只会落到最后那句"还没接进这一层"。
   这里按显式表映射到正式动作名；**没有对应实现的就不列**，仍由兜底提示明说，而不是偷偷什么都不做。
   映射后不是另开一条写链：临时按钮带着正式 action/id 冒泡到 document，和真实点击走同一条委托，
   脏检查、账号 ID 校验、确认层、单次提交这些保护全部照常生效。 */
const FORMAL_ACTION = {
  'register-preview': 'switch-auth-mode',
  'add-preview-account': 'add-account',
  'select-preview-account': 'pick-account',
  'start-preview-account': 'start',
  'stop-preview-account': 'stop',
  'remove-preview-account': 'remove-account',
  'refresh-preview': 'refresh',
  'check-preview-license': 'check-license',
  'change-preview-password': 'change-password',
  'logout-preview': 'software-logout',
  'upload-preview-logs': 'upload-logs',
  'claim-preview-data': 'claim-data',
  'discard-preview-draft': 'reload-config',
  'apply-preview-log-filters': 'apply-log-filters',
  'clear-preview-log-filters': 'clear-log-filters',
  'reload-preview-logs': 'reload-logs',
  'clear-preview-network': 'clear-egress',
  'apply-preview-network': 'me-egress',
  'open-background-settings': 'background-settings',
};

const selectedAccountId = () => {
  const one = host?.state?.selectedId;
  return one === undefined || one === null || one === '' ? '' : String(one);
};

/* 这几个入口在正式层本来就是「一次动作」：打开添加表单、切换账号、开始、停止、移除。
   先给用户看一层示意说明再让他点「开始运行（演示）」是多余且误导的，所以直接走正式动作。
   其余面板保留原型的信息层级，只把 primary 动作接到正式流程。 */
const DIRECT_PANEL_ACTIONS = Object.freeze({
  'add-account': 'add-account', 'choose-account': 'pick-account', 'account-start': 'start',
  'account-stop': 'stop', 'remove-account': 'remove-account', password: 'change-password',
  network: 'me-egress', register: 'switch-auth-mode', 'background-settings': 'background-settings',
  'auth-help': 'auth-help',
});
const FORMAL_FORM_IDS = Object.freeze({
  'add-account': 'add-account-form', password: 'software-password-form',
  network: 'egress-form', register: 'auth-register-form',
});

/* 设计源里少量按钮文案自带「（演示）」后缀，正式路径上必须去掉。 */
const cleanLabel = text => String(text || '').replace(/[（(]\s*演示\s*[)）]/g, '').trim();

function invokeFormal(action, id) {
  const probe = document.createElement('button');
  probe.type = 'button';
  probe.dataset.action = action;
  if (id) probe.dataset.id = String(id);
  probe.style.display = 'none';
  document.body.appendChild(probe);
  try { probe.click(); } finally { probe.remove(); }
}

/* A footer's "return to fill in" target must take the same formal route as a page entry.
   Progress/error feedback normally sits above the original protected form. Return to that exact
   connected form rather than rendering a prototype form or creating duplicate form/input IDs. */
function routePanel(id, owner = '', returnToForm = false) {
  const action = DIRECT_PANEL_ACTIONS[id];
  if (!action) {
    if (PANEL_SPECS[id]) return openLayer(id);
    host.openDetail(id);
    return true;
  }
  const formId = FORMAL_FORM_IDS[id];
  if (formId) {
    const form = document.getElementById(formId);
    if (form?.isConnected && form.closest('#dialog-host')) {
      let remaining = host.dialogDepth();
      while (remaining-- > 0 && host.topDialog() && !host.topDialog().contains(form)) host.closeTopDialog();
      if (host.topDialog()?.contains(form)) {
        [...form.elements].find(control => !control.disabled && control.type !== 'hidden' && control.matches('input,select,textarea,button'))?.focus({ preventScroll: true });
        return true;
      }
    }
    if (returnToForm && host.topDialog()) host.closeTopDialog();
  }
  invokeFormal(id === 'choose-account' && host.state.tab === 'logs' ? 'pick-log-scope' : action,
    owner || selectedAccountId());
  return true;
}

const selectedIds = value => [...new Set((Array.isArray(value) ? value : []).map(String))];

/* 父卡「完成」要把子层能改的格子一起合回页面草稿：只列本卡字段会把 plantMode / groupSize /
   plantBlacklistIds / restockCount 这些子层字段留在拷贝里丢掉。沿 action 的 target 递归取
   合法子层字段；仍然只合白名单路径，不做整份草稿覆盖。 */
function pathsOf(spec, seen = new Set()) {
  const own = (spec.fields || []).flatMap(field => [field.key, ...(Array.isArray(field.configPaths) ? field.configPaths : [])]).filter(Boolean);
  const child = (spec.fields || [])
    .filter(field => field.type === 'action' && field.target && !seen.has(field.target))
    .flatMap(field => {
      seen.add(field.target);
      const childSpec = PANEL_SPECS[field.target];
      return childSpec && childSpec.scope === 'config' ? pathsOf(childSpec, seen) : [];
    });
  return [...new Set([...own, ...child])];
}

function catalogItems() {
  const c = host.catalog();
  const qualities = (c.qualities || []).map(one => ({ value: String(typeof one === 'object' ? (one.value ?? one.id ?? '') : one), label: String(typeof one === 'object' ? (one.label ?? one.name ?? one.value ?? one.id ?? '') : one), description: '' }));
  const qualityNames = new Map(qualities.map(one => [one.value, one.label]));
  return {
    flowers: (c.flowers || []).map(one => ({ value: String(host.flowerId(one)), label: String(one?.label ?? one?.name ?? one?.id ?? ''), quality: one?.quality == null ? '' : String(one.quality), description: one?.quality !== undefined && one?.quality !== null ? (qualityNames.get(String(one.quality)) || '品质名称未读取') : String(one?.description ?? '') })),
    qualities,
    arts: (c.flowerArts || []).map(one => {
      const flowers = Array.isArray(one?.flowers) && one.flowers.length > 0
        && one.flowers.every(name => typeof name === 'string' && name.trim())
        ? one.flowers.map(name => name.trim()) : [];
      return { value: String(one?.id ?? ''), quality: one?.quality == null ? '' : String(one.quality),
        label: typeof one?.name === 'string' && one.name.trim() ? one.name.trim()
          : typeof one?.label === 'string' && one.label.trim() ? one.label.trim() : String(one?.id ?? ''),
        description: flowers.length ? flowers.join('／') : '目录未提供完整配花名' };
    }),
  };
}

const values = () => host.sheetDraft() || host.state.draft || {};

const topOverlay = () => host.topDialog()?.closest('.sheet-scrim,.dialog-overlay') || null;
const readIdentity = () => ({
  owner: String(host.softwareInfo()?.user?.id ?? ''), accountId: selectedAccountId(),
  generation: host.state.engine?.generation, instanceId: host.state.engine?.instanceId,
});
const sameReadIdentity = (left, right) => left.owner === right.owner && left.accountId === right.accountId
  && left.generation === right.generation && left.instanceId === right.instanceId;

/* A loading flag belongs to the exact sheet that requested the read. A newly opened sheet may
   observe the shared read, but cannot inherit the old sheet's button/result transaction. */
function rememberReadView(id) {
  if (!id || !activePreviewReads.size) return;
  const identity = readIdentity();
  const remember = () => {
    const overlay = host.sheetOverlay();
    if (host.sheetKey() !== id || !overlay?.isConnected || topOverlay() !== overlay
      || !sameReadIdentity(identity, readIdentity())) return;
    readViewSnapshots.set(overlay, { id, identity, reads: new Set(activePreviewReads) });
  };
  if (host.sheetOverlay()) remember();
  else queueMicrotask(remember); // A new sheet's overlay is assigned after its HTML is built.
}

function projectCurrentReadFacts(completedRead) {
  const overlay = host.sheetOverlay();
  const view = overlay && readViewSnapshots.get(overlay);
  const current = readIdentity();
  if (!view?.reads.has(completedRead) || overlay !== topOverlay() || !overlay.isConnected
    || host.sheetKey() !== view.id || view.identity.owner !== current.owner || view.identity.accountId !== current.accountId
    || !sameReadIdentity(current, readIdentity())) return;
  readViewSnapshots.delete(overlay);
  // No result from the retired layer is passed here. Rebuild only this registered Moon body from
  // the host's current facts and its own unchanged child draft; forms/pickers above it are excluded.
  // A new native generation may now be current. This only repaints facts, never upgrades the
  // original draft token or applies this completed read's old-generation result to that draft.
  host.rerenderSheet();
}

/* Frozen layout metadata is adapted at its production boundary; sample values never become facts. */
function specFor(id) {
  const liveSpec = adaptLivePanelSpec(id, PANEL_SPECS[id] || { title: id, fields: [] }, host, {
    logRecord: host.state.selectedLogRecord,
  });
  const spec = compactSettingsSpec(id, liveSpec, PANEL_SPECS);
  if (spec.scope === 'config' && pathsOf(spec).length === 0) {
    return { ...spec, scope: 'read', primary: { label: '返回', action: 'close' }, secondary: null, tertiary: null };
  }
  return spec;
}

function ctxFor(id, depth) {
  const feedback = host.topMoonFeedback?.();
  const overlay = feedback?.id === id ? feedback.overlay : host.sheetKey() === id ? host.sheetOverlay() : null;
  const refreshing = Boolean(overlay && previewReads.has(overlay));
  rememberReadView(id);
  const context = createLivePanelContext(host, id, {
    values: values(), refreshing, logRecord: host.state.selectedLogRecord,
  });
  return {
    ...context,
    catalogs: catalogItems(),
    refreshing,
    depth: Math.max(1, depth ?? host.dialogDepth()),
    footerNote: specFor(id).scope === 'config' && pathsOf(specFor(id)).length > 0
      ? '完成后在原页面保存。'
      : context.footerNote,
    pickerNote: '选择需要的项目。',
  };
}
/* Options that the app really reads (flower modes, group sizes, catalogues) replace the design examples. */
function realOptions(field) {
  const c = host.catalog();
  const original = new Map((field.options || []).map(one => [String(one.value), one]));
  if (field.key === 'plantMode') return (c.plantModes || []).map(item => {
    const value = typeof item === 'object' ? item.value ?? item.id : item;
    return { value, label: typeof item === 'object' ? item.label ?? item.name : String(item), description: original.get(String(value))?.description || '' };
  });
  if (field.key === 'groupSize') return (c.groupSizes || []).map(item => {
    const value = typeof item === 'object' ? item.value ?? item.id : item;
    return { value, label: original.get(String(value))?.label || `${value} 块地`, description: original.get(String(value))?.description || '' };
  });
  if (field.catalog) return catalogItems()[field.catalog] || [];
  return null;
}

function bindField(field) {
  const options = realOptions(field);
  if (options === null) return field;
  const catalogue = host.catalog();
  const next = { ...field };
  // Keep the art role for the existing selected-value summary: equal product names
  // remain distinguishable by their official flowers after this picker is closed.
  if (field.catalog !== 'arts') delete next.catalog;
  next.options = options;
  if (catalogue.ready !== true || catalogue.loading || !options.length) {
    // A completed, empty catalogue still permits removing previously saved IDs. An unread or
    // failed catalogue is not evidence that those IDs are outside the catalogue.
    next.disabled = !(field.type === 'picker' && catalogue.ready === true && !catalogue.loading
      && selectedIds(get(values(), field.key)).length > 0) || field.disabled;
    next.catalogueUnlistedKnown = catalogue.ready === true && !catalogue.loading;
    next.catalogReadMessage = catalogue.loading ? '正在读取选项目录；已有设置和选择继续保留。'
      : catalogue.ready === true ? '本次已读取目录，这一类当前没有可选项目；已有选择继续保留。'
        : catalogue.error ? `目录读取失败：${catalogue.error} 已有设置和选择继续保留，可在本层重新读取。`
          : '选项目录尚未读到，可在本层重新读取；已有设置和选择继续保留。';
    next.description = next.catalogReadMessage;
  }
  if (field.catalog) next.catalogueUnlistedKnown = catalogue.ready === true && !catalogue.loading;
  return next;
}

/* Log controls keep the frozen fieldset/radio hierarchy. Their values live in this exact overlay,
   not the account config draft; hidden IDs preserve the formal filter action's read contract. */
function logFilterScopes() {
  if (typeof host.logSourceOptions === 'function') return host.logSourceOptions();
  return [{ value: 'device', label: '本机 / 添加记录', description: '软件连接、账号添加与本机异常' },
    ...(host.state.accounts || []).map(one => ({ value: String(one.id), label: host.accountName(one),
      description: one.serverName ? String(one.serverName) : '这个游戏号的运行记录' }))];
}

function sameLogFilterOwner(form) {
  const current = readIdentity();
  return form.owner === current.owner && form.anchorAccountId === current.accountId
    && form.anchorLogsScope === host.state.logsScope;
}

function currentLogFilterForm(node = null) {
  const overlay = node?.closest?.('.sheet-scrim,.dialog-overlay') || host.sheetOverlay();
  const form = overlay && logFilterForms.get(overlay);
  return form && form.overlay === overlay && overlay.isConnected && overlay === topOverlay()
    && host.sheetOverlay() === overlay && LOG_FILTER_PANELS.has(form.panelId)
    && host.sheetKey() === form.panelId ? form : null;
}

function logFilterContextCurrent(form) {
  return sameLogFilterOwner(form) && sameReadIdentity(form.context, readIdentity())
    && logFilterScopes().some(one => one.value === form.scope);
}

function paintLogFilterActions(form) {
  if (currentLogFilterForm() !== form) return;
  const apply = form.overlay.querySelector('[data-panel-action="apply-preview-log-filters"]');
  const clear = form.overlay.querySelector('[data-panel-action="clear-preview-log-filters"]');
  if (apply) apply.disabled = form.status !== 'read' || !logFilterContextCurrent(form);
  if (clear) clear.disabled = !sameLogFilterOwner(form) || !sameReadIdentity(form.context, readIdentity());
}

function renderLogFilterForm(form) {
  if (currentLogFilterForm() !== form) return;
  host.rerenderSheet();
  paintLogFilterActions(form);
}

function failLogFilterForm(form, message) {
  form.status = 'failed'; form.error = message;
  form.reopenRequired = !logFilterContextCurrent(form);
  renderLogFilterForm(form);
}

async function readLogFilterCatalog(form) {
  if (currentLogFilterForm() !== form) return;
  const request = ++form.request;
  if (!sameLogFilterOwner(form)) {
    failLogFilterForm(form, '软件身份或当前日志来源已变化，请关闭后重新打开筛选。'); return;
  }
  if (!logFilterScopes().some(one => one.value === form.scope)) {
    failLogFilterForm(form, '这个游戏号已不在当前名册中，请关闭后重新选择日志来源。'); return;
  }
  if (!sameReadIdentity(form.context, readIdentity())) {
    failLogFilterForm(form, '手机服务连接已变化，请重新打开筛选；已有筛选与游戏设置没有更改。'); return;
  }
  const context = readIdentity(), scope = form.scope;
  form.status = 'loading'; form.error = ''; form.warning = ''; form.reopenRequired = false;
  form.categories = []; form.days = [];
  renderLogFilterForm(form);
  let result;
  try { result = await host.readLogFilterCatalog(scope); }
  catch { result = { status: 'failed', message: '本次日志分类与日期目录未读到，请重新读取。' }; }
  if (form.request !== request) return; // A newer local source selection owns its own read.
  if (!logFilterContextCurrent(form) || form.scope !== scope) {
    failLogFilterForm(form, '连接、软件身份或日志来源已变化，旧目录没有应用，请重新读取。'); return;
  }
  if (currentLogFilterForm() !== form) {
    form.status = 'failed'; form.reopenRequired = false;
    form.error = '读取时本层已离开栈顶，请返回后重新读取目录。'; return;
  }
  if (result?.status !== 'read') {
    failLogFilterForm(form, result?.message || '本次日志分类与日期目录未读到，请重新读取。'); return;
  }
  const source = result.context;
  if (!source || source.softwareUserId !== context.owner || source.generation !== context.generation
    || source.instanceId !== context.instanceId || source.scope !== scope || source.accountId !== (scope === 'device' ? null : scope)
    || !Array.isArray(result.categories) || result.categories.some(one => typeof one !== 'string')
    || !Array.isArray(result.days) || result.days.some(one => typeof one !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(one))) {
    failLogFilterForm(form, '本次日志目录缺少对应来源或完整字段，旧目录没有应用，请重新读取。'); return;
  }
  form.categories = [...new Set(result.categories.filter(Boolean))];
  form.days = [...new Set(result.days.filter(Boolean))];
  if (form.panelId === 'log-categories' && form.day && !form.days.includes(form.day)) {
    // This sheet has no date/source controls. Never silently change either while applying only
    // a category; leave the current date in its hidden field and require the complete filter UI.
    failLogFilterForm(form, '当前日期未在这个来源的本次日志目录中列出，分类没有应用。请返回后点击日期或右上角筛选，在完整筛选中核对日期。');
    return;
  }
  const cleared = [];
  if (form.category && !form.categories.includes(form.category)) { form.category = ''; cleared.push('分类'); }
  if (form.day && !form.days.includes(form.day)) { form.day = ''; cleared.push('日期'); }
  form.warning = cleared.length ? `原筛选${cleared.join('、')}未在此来源的本次目录中列出，本层已改为全部；应用前不会更改已有筛选。` : '';
  form.status = 'read'; form.error = '';
  renderLogFilterForm(form);
}

function logFilterFields(id) {
  const categoriesOnly = id === 'log-categories';
  const overlay = host.sheetKey() === id ? host.sheetOverlay() : null;
  let form = overlay && logFilterForms.get(overlay);
  if (!form) {
    const context = readIdentity(), scopes = logFilterScopes();
    const activeScope = host.logSourceRef?.() || (host.state.logsScope === 'device' ? 'device' : selectedAccountId());
    form = { id: ++logFilterSequence, panelId: id, overlay: null, owner: context.owner, anchorAccountId: context.accountId,
      anchorLogsScope: host.state.logsScope, context,
      scope: categoriesOnly || scopes.some(one => one.value === activeScope) ? activeScope : 'device',
      category: String(host.state.logsCategory || ''), day: String(host.state.logsDay || ''),
      keyword: String(host.state.logsKeyword || ''), level: String(host.state.logsLevel || ''), outcomeState: String(host.state.logsOutcome || ''),
      errorCode: String(host.state.logsErrorCode || ''), operationId: String(host.state.logsOperationId || ''), traceId: String(host.state.logsTraceId || ''),
      categories: [], days: [], status: 'loading', error: '', warning: '', reopenRequired: false, request: 0 };
    const opening = form;
    queueMicrotask(() => {
      const ownOverlay = host.sheetOverlay();
      if (host.sheetKey() !== opening.panelId || ownOverlay !== topOverlay()
        || ownOverlay?.querySelector('[data-moon-log-form]')?.dataset.moonLogForm !== String(opening.id)) return;
      opening.overlay = ownOverlay; logFilterForms.set(ownOverlay, opening);
      void readLogFilterCatalog(opening);
    });
  } else queueMicrotask(() => paintLogFilterActions(form));
  const fields = specFor(id).fields || [];
  const categoryChoices = [{ value: '', label: categoriesOnly ? '全部' : '全部分类' }, ...form.categories.map(value => ({ value, label: value }))];
  const choices = categoriesOnly ? [categoryChoices] : [logFilterScopes(), categoryChoices,
    [{ value: '', label: '全部日期' }, ...form.days.map(value => ({ value, label: value }))]];
  const keys = categoriesOnly ? ['category'] : ['scope', 'category', 'day'];
  const controls = fields.slice(0, keys.length).map((field, index) => {
    const key = keys[index], disabled = key !== 'scope' && (form.status !== 'read' || !logFilterContextCurrent(form));
    const description = field.description || field.help || '';
    return `<fieldset class="field-block panel-fieldset" ${disabled ? 'disabled' : ''}><legend class="field-caption"><strong>${esc(field.label)}</strong></legend><div class="${field.type === 'chips' ? 'panel-choices' : 'option-list'}">${choices[index].map((one, optionIndex) => `<label class="panel-choice"><input type="radio" name="${esc(field.key)}" data-moon-log-filter="${key}" value="${esc(one.value)}" data-option-index="${optionIndex}" data-field-index="${index}" ${String(form[key]) === one.value ? 'checked' : ''}${disabled ? ' disabled' : ''}><span class="option-copy"><strong>${esc(one.label)}</strong>${one.description ? `<small>${esc(one.description)}</small>` : ''}</span></label>`).join('')}</div>${description ? `<p class="field-description">${esc(description)}</p>` : ''}</fieldset>`;
  }).join('');
  const pageNote = fields[keys.length];
  const note = pageNote ? `<div class="panel-note ${esc(pageNote.tone || '')}">${pageNote.label ? `<strong>${esc(pageNote.label)}</strong>` : ''}${esc(pageNote.description || '')}</div>` : '';
  const textControls = categoriesOnly ? '' : `<label class="field-block"><span class="field-caption"><strong>关键词</strong></span><input id="log-filter-keyword" data-moon-log-text="keyword" maxlength="160" value="${esc(form.keyword)}" placeholder="搜索日志内容或错误码"${form.status !== 'read' || !logFilterContextCurrent(form) ? ' disabled' : ''}></label><label class="field-block"><span class="field-caption"><strong>等级</strong></span><select id="log-filter-level" data-moon-log-text="level"${form.status !== 'read' || !logFilterContextCurrent(form) ? ' disabled' : ''}>${[['','全部等级'],['debug','调试'],['info','提示'],['warn','警告'],['error','错误'],['success','成功']].map(([value,label]) => `<option value="${value}"${form.level === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label><label class="field-block"><span class="field-caption"><strong>结果</strong></span><select id="log-filter-outcome" data-moon-log-text="outcomeState"${form.status !== 'read' || !logFilterContextCurrent(form) ? ' disabled' : ''}>${[['','全部结果'],['confirmed','已确认'],['failed','失败'],['rejected','已拒绝'],['unknown','待核查'],['dirty','状态待核'],['scheduled','已安排'],['waiting','等待中']].map(([value,label]) => `<option value="${value}"${form.outcomeState === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>`;
  const readState = form.status === 'loading' ? '<div class="panel-note"><strong>正在读取</strong>正在读取所选日志来源的真实分类与日期。</div>'
    : form.error ? `<p class="field-error" role="alert">${esc(form.error)}</p>${form.reopenRequired
      ? `<button type="button" class="panel-link" data-moon-log-reopen><span>重新打开筛选<small>放弃本层未应用条件，按当前身份与连接重新读取；游戏设置不变。</small></span>${icon('ChevronRight')}</button>`
      : `<button type="button" class="panel-link" data-moon-log-retry><span>重新读取日志目录<small>只读取当前所选来源，不修改已应用筛选或游戏设置。</small></span>${icon('ChevronRight')}</button>`}`
      : form.warning ? `<div class="panel-note warning">${esc(form.warning)}</div>` : '';
  const correlationControls = [['errorCode','error-code','错误码',128],['operationId','operation-id','操作 ID',64],['traceId','trace-id','追踪 ID',64],
    ...(categoriesOnly ? [['keyword','keyword','关键词',160],['level','level','等级',32],['outcomeState','outcome','结果',32]] : [])]
    .map(([key,id,label,limit]) => categoriesOnly
      ? `<input type="hidden" id="log-filter-${id}" value="${esc(form[key])}">`
      : `<label class="field-block"><span class="field-caption"><strong>${label}</strong></span><input id="log-filter-${id}" data-moon-log-text="${key}" maxlength="${limit}" value="${esc(form[key])}" placeholder="留空查看全部"${form.status !== 'read' || !logFilterContextCurrent(form) ? ' disabled' : ''}></label>`).join('');
  return `<input type="hidden" id="log-filter-scope" data-moon-log-form="${form.id}" value="${esc(form.scope)}"><input type="hidden" id="log-filter-category" value="${esc(form.category)}"><input type="hidden" id="log-filter-day" value="${esc(form.day)}">${controls}${textControls}${correlationControls}${note}${readState}`;
}

function handOffLogFilterAction(event, button, name) {
  const form = currentLogFilterForm(button);
  const valid = form && logFilterContextCurrent(form) && (name === 'clear-preview-log-filters'
    || form.status === 'read' && ['', ...form.categories].includes(form.category) && ['', ...form.days].includes(form.day));
  if (!valid) {
    event.preventDefault(); event.stopImmediatePropagation(); delete button.dataset.action;
    if (form) failLogFilterForm(form, logFilterContextCurrent(form)
      ? '筛选目录尚未读回，请重新读取后再应用；已有筛选没有更改。'
      : '软件身份、日志来源或连接已变化，请重新打开筛选；已有筛选没有更改。');
    else host.toast('当前筛选层已经变化，请重新打开后再操作。');
    return;
  }
  // Let this same, owned button bubble to the formal handler. It must read this overlay's hidden
  // inputs, rather than a body-mounted proxy or an older filter layer's duplicate IDs.
  button.dataset.action = FORMAL_ACTION[name];
}

function relatedHTML(spec) {
  // adaptLivePanelSpec owns the production whitelist. Render only those preserved setting/help
  // links, using the frozen related-link shape; gallery scenarios never enter this structure.
  const related = spec.related || [];
  return related.length ? `<div class="design-related"><p>相关设置与说明</p><div>${related.map(one => `<button type="button" data-panel="${esc(one.target || one.id)}">${esc(one.label)}</button>`).join('')}</div></div>` : '';
}

function fieldsHTML(id) {
  const spec = specFor(id);
  if (LOG_FILTER_PANELS.has(id)) return logFilterFields(id) + relatedHTML(spec);
  const frame = { id, spec, values: values(), errors: {} };
  const ctx = ctxFor(id);
  const fields = spec.fields || [];
  const catalogue = host.catalog();
  const unavailable = fields.some(field => { const options = realOptions(field); return options !== null && (catalogue.ready !== true || catalogue.loading || !options.length); });
  return fields.map((field, index) => fieldMarkup(bindField(field), index, frame, ctx)).join('')
    + (spec.settingFacts?.length ? `<details class="settings-facts"><summary>查看当前状态</summary>${spec.settingFacts.map(field => fieldMarkup(field, 0, frame, ctx)).join('')}</details>` : '')
    + (unavailable ? `<button type="button" class="panel-link" data-panel-action="reload-catalog"><span>重新读取选项目录<small>只读取本机目录，不覆盖当前草稿或已有选择。</small></span>${icon('ChevronRight')}</button>` : '')
    + relatedHTML(spec);
}

export function sheetHTML(id, depth) {
  const spec = specFor(id);
  /* 日志筛选是读取面板：它有自己的「查看筛选结果 / 清除筛选」，走正式日志状态，
     不能套配置卡的「取消 / 完成」。 */
  const isConfig = spec.scope === 'config' && pathsOf(spec).length > 0 && !LOG_FILTER_PANELS.has(id);
  const frame = { id, spec, values: values(), errors: {} };
  const ctx = ctxFor(id, depth);
  const scroll = fieldsHTML(id);
  const actions = [spec.secondary, spec.primary, spec.tertiary].filter(Boolean);
  const footer = isConfig
    ? `<div class="panel-actions">${actions.map(action => `<button type="button" class="${action === spec.primary ? 'primary' : 'secondary'} ${action.tone === 'danger' ? 'danger-primary' : ''}" data-panel-action="${esc(action.action || 'close')}" ${action.target ? `data-target="${esc(action.target)}"` : ''}>${esc(action.label || '')}</button>`).join('')}</div><p class="preview-label">${icon('Eye')}${esc(ctx.footerNote)}</p>`
    : LOG_FILTER_PANELS.has(id)
      ? `<div class="panel-actions">${actions.map(action => `<button type="button" class="${action === spec.primary ? 'primary' : 'secondary'} ${action.tone === 'danger' ? 'danger-primary' : ''}" data-panel-action="${esc(action.action || 'close')}" ${action.target ? `data-target="${esc(action.target)}"` : ''}>${esc(cleanLabel(action.label))}</button>`).join('')}</div><p class="preview-label">${icon('Eye')}筛选完整记录，不修改游戏设置。</p>`
      : `<div class="panel-actions">${actions.length ? actions.map(action => `<button type="button" class="${action === spec.primary ? 'primary' : 'secondary'} ${action.tone === 'danger' ? 'danger-primary' : ''}" data-panel-action="${action.action || 'close'}" ${action.target ? `data-target="${action.target}"` : ''}>${cleanLabel(action.label)}</button>`).join('') : '<button type="button" class="primary" data-panel-action="close">知道了</button>'}</div><p class="preview-label">${icon('Eye')}${esc(ctx.footerNote)}</p>`;
  return `<div class="sheet-scrim ${!isConfig && ['dialog', 'confirm'].includes(spec.kind) ? 'confirm-scrim' : ''}" data-scrim><section class="bottom-sheet v2-sheet ${!isConfig && ['dialog', 'confirm'].includes(spec.kind) ? 'confirm-dialog' : ''} moon-dialog" data-settings-compact="${isConfig && spec.compactSettings ? 'true' : 'false'}" role="dialog" aria-modal="true" aria-labelledby="panel-title"><div class="sheet-handle"></div><header class="sheet-header"><div><p class="panel-eyebrow">${esc(spec.group || '无尽夏')}</p><h2 id="panel-title">${esc(ctx.resolveText(spec.title))}</h2></div><button type="button" class="icon-button" aria-label="${ctx.depth > 1 ? '返回上一层' : '关闭'}" data-panel-action="${isConfig ? 'cancel' : 'close'}">${icon(ctx.depth > 1 ? 'ArrowLeft' : 'X')}</button></header>${spec.subtitle ? `<p class="panel-subtitle">${esc(ctx.resolveText(spec.subtitle))}</p>` : ''}<div class="panel-scroll">${scroll}</div><footer class="panel-footer">${footer}</footer></section></div>`;
}

const pickerAllItems = () => [...picker.items, ...picker.unlisted];
function pickerFilteredItems() {
  const search = picker.search.trim().toLowerCase();
  return pickerAllItems().filter(one => (picker.view !== 'selected' || picker.selected.includes(one.value))
    && (!picker.quality || (picker.quality === 'unknown' ? !one.quality : one.quality === picker.quality))
    && `${one.label} ${one.description || ''}`.toLowerCase().includes(search));
}
function pickerQualityLabel(one) {
  return picker.qualities.find(quality => quality.value === one.quality)?.label || '';
}
function pickerControlsHTML() {
  const all = pickerAllItems(), filtered = pickerFilteredItems();
  const knownQualities = new Set(picker.items.map(one => one.quality).filter(Boolean));
  const qualities = picker.qualities.filter(one => knownQualities.has(one.value));
  const selected = new Map(all.map(one => [one.value, one]));
  const chips = picker.selected.slice(0, 3).map(value => {
    const one = selected.get(value) || { value, label: `已保存目录项 #${value}` };
    const quality = pickerQualityLabel(one);
    const detail = quality || (picker.field.catalog === 'arts' ? one.description : '');
    return `<button type="button" class="picker-selected-chip" data-moon-action="pick-remove" data-picker-value="${esc(value)}" aria-label="移除${esc(one.label)}${detail ? `，${esc(detail)}` : ''}"><span class="quality-dot" data-quality="${esc(one.quality || '')}" aria-hidden="true"></span><span>${esc(one.label)}${detail ? ` · ${esc(detail)}` : ''}</span>${icon('X')}</button>`;
  }).join('');
  return `<div class="picker-toolbar"><input class="panel-input" type="search" data-moon-picker-search placeholder="${picker.field.catalog === 'flowers' ? '搜索花名或品质' : '搜索名称或配方'}" value="${esc(picker.search)}" aria-label="搜索目录"><button type="button" data-moon-action="pick-visible"${filtered.length ? '' : ' disabled'}>全选结果</button></div>
    ${qualities.length ? `<div class="picker-quality-filters" role="group" aria-label="按品质筛选"><button type="button" data-moon-action="pick-quality" data-picker-quality="" aria-pressed="${!picker.quality}">全部品质</button>${qualities.map(one => `<button type="button" data-moon-action="pick-quality" data-picker-quality="${esc(one.value)}" aria-pressed="${picker.quality === one.value}"><span class="quality-dot" data-quality="${esc(one.value)}" aria-hidden="true"></span>${esc(one.label)}</button>`).join('')}${all.some(one => !one.quality) ? `<button type="button" data-moon-action="pick-quality" data-picker-quality="unknown" aria-pressed="${picker.quality === 'unknown'}">未标品质</button>` : ''}</div>` : ''}
    <div class="picker-view-tabs" role="group" aria-label="查看范围"><button type="button" data-moon-action="pick-view" data-picker-view="all" aria-pressed="${picker.view === 'all'}">全部项目</button><button type="button" data-moon-action="pick-view" data-picker-view="selected" aria-pressed="${picker.view === 'selected'}">只看已选（${picker.selected.length}）</button><span>匹配 ${filtered.length} 项</span></div>
    <div class="picker-selected-summary"><div class="picker-selected-heading"><strong>已选 ${picker.selected.length} 项</strong><button type="button" data-moon-action="pick-clear"${picker.selected.length ? '' : ' disabled'}>清空已选</button></div>${chips ? `<div class="picker-selected-chips">${chips}</div>${picker.selected.length > 3 ? `<button type="button" class="picker-selected-more" data-moon-action="pick-view" data-picker-view="selected">还有 ${picker.selected.length - 3} 项，点击查看全部已选</button>` : ''}` : '<p>尚未选择，勾选后会在这里显示名称。</p>'}</div>`;
}
function pickerInnerHTML() {
  const filtered = pickerFilteredItems();
  const row = one => `<label class="catalogue-row${picker.selected.includes(one.value) ? ' is-selected' : ''}"><input type="checkbox" data-moon-catalogue="${esc(one.value)}" aria-label="选择${esc(one.label)}${one.description ? `，${esc(one.description)}` : ''}" ${picker.selected.includes(one.value) ? 'checked' : ''}><span class="feature-icon ${picker.field.catalog === 'arts' ? 'lilac' : ''}" data-quality="${esc(one.quality || '')}">${icon(picker.field.catalog === 'arts' ? 'Flower' : 'Flower2')}</span><span class="catalogue-copy"><strong>${esc(one.label)}</strong><small>${one.quality ? `<span class="catalogue-quality" data-quality="${esc(one.quality)}">${esc(pickerQualityLabel(one) || '品质名称未读取')}</span>` : ''}${picker.field.catalog === 'arts' || !one.quality ? esc(one.description || '目录未提供说明') : ''}</small></span>${picker.selected.includes(one.value) ? `<span class="catalogue-selected-mark" aria-hidden="true">${icon('Check')}</span>` : ''}</label>`;
  const listed = new Set(picker.items.map(one => one.value));
  const current = filtered.filter(one => listed.has(one.value)), retained = filtered.filter(one => !listed.has(one.value));
  const empty = picker.view === 'selected' && !picker.selected.length ? '还没有选择项目，切回“全部项目”勾选。' : '没有匹配项目，试试其他名称或品质。已选项目仍然保留。';
  return `${filtered.length ? `<div class="catalogue-list">${current.map(row).join('')}</div>${retained.length ? `<h3 class="panel-heading">已保存、当前目录未列出的项目</h3><div class="catalogue-list">${retained.map(row).join('')}</div>` : ''}` : `<div class="catalogue-empty">${empty}</div>`}${picker.error ? `<p class="field-error" role="alert">${esc(picker.error)}</p>` : ''}`;
}

function pickerSheetHTML() {
  return `<div class="sheet-scrim" data-scrim><section class="bottom-sheet v2-sheet moon-dialog catalog-picker" role="dialog" aria-modal="true" aria-labelledby="panel-title"><div class="sheet-handle"></div><header class="sheet-header"><div><p class="panel-eyebrow">目录选择</p><h2 id="panel-title">${esc(picker.field.label)}</h2></div><button type="button" class="icon-button" aria-label="取消选择" data-moon-action="picker-cancel">${icon('ArrowLeft')}</button></header><div class="picker-controls">${pickerControlsHTML()}</div><div class="panel-scroll picker-results" role="region" aria-label="可选项目列表" tabindex="0">${pickerInnerHTML()}</div><footer class="panel-footer"><div class="panel-actions"><button type="button" class="secondary" data-moon-action="picker-cancel">取消</button><button type="button" class="primary" data-moon-action="picker-apply">完成选择（${picker.selected.length}）</button></div><p class="preview-label">${icon('Eye')}确认后返回设置，保存后才生效。</p></footer></section></div>`;
}

/* 已经开着详情时，再点卡内的行只是往上叠一层：子层有自己的一份草稿拷贝，
   完成只合本层字段，取消/✕/返回丢掉这一层，下层进入前的编辑原样保留。 */
function openLayer(id) {
  if (host.sheetKey()) { host.pushMoonLayer(id); return true; }
  return host.openMoonPanel(id);
}

function openPicker(field, index, id, sourceNode) {
  const bound = bindField(field);
  if (bound.disabled) { host.toast(bound.catalogReadMessage || '当前条件不允许选择这一项。'); return; }
  const items = fieldOptions(bound, catalogItems());
  const selected = selectedIds(get(values(), field.key));
  if (!items.length && !(bound.catalogueUnlistedKnown && selected.length)) { host.toast('这一类目录还没读到，连上手机运行服务后再选。'); return; }
  const token = host.captureDraftTarget(sourceNode);
  const valid = host.validateDraftTarget(token, { merge: false, notify: false });
  if (!valid.ok) { host.toast(valid.message || '当前草稿归属已变化，请返回设置后重新打开。'); return; }
  const listed = new Set(items.map(one => one.value));
  const unlisted = selected.filter(value => !listed.has(value)).map(value => ({
    value, label: `已保存目录项 #${value}`,
    description: '当前目录未列出；保留原选择，可逐项取消，不据此判断可用或库存。',
  }));
  picker = { panel: id, field, index, items, unlisted, qualities: catalogItems().qualities, search: '', quality: '', view: 'all', selected, token, error: '' };
  const openedPicker = picker;
  picker.overlay = host.mountSheet(pickerSheetHTML(), () => {
    if (picker === openedPicker) picker = null;
  });
  openedPicker.onRecovered = renewed => {
    if (picker !== openedPicker || !isCurrentPicker(openedPicker.overlay)) return false;
    openedPicker.token = renewed;
    openedPicker.error = '';
    rerenderPicker();
    return true;
  };
  if (!host.registerDraftPicker(openedPicker.overlay, token, openedPicker.onRecovered)) {
    host.closeDialog();
    host.toast('原设置归属已变化，请返回设置后重新选择。');
  }
}

function rerenderPicker(resetScroll = false) {
  const overlay = picker?.overlay;
  if (!overlay?.isConnected || overlay !== topOverlay()) return;
  const controls = overlay.querySelector('.picker-controls');
  if (controls) controls.innerHTML = pickerControlsHTML();
  const scroll = overlay.querySelector('.picker-results');
  if (scroll) { const top = scroll.scrollTop; scroll.innerHTML = pickerInnerHTML(); scroll.scrollTop = resetScroll ? 0 : top; }
  const apply = overlay.querySelector('[data-moon-action="picker-apply"]');
  if (apply) apply.textContent = `完成选择（${picker.selected.length}）`;
  // The body redraw must retain the formal paused/recheck UI on this same picker frame.
  // Re-registering an already owned token only repaints that frame; it cannot capture another draft.
  host.registerDraftPicker(overlay, picker.token, picker.onRecovered);
}

function isCurrentPicker(node) {
  return Boolean(picker?.overlay?.isConnected && picker.overlay === topOverlay() && picker.overlay.contains(node));
}

function closeSettingsDropdown(restoreFocus = false) {
  const popup = selectPopup;
  selectPopup = null;
  if (!popup) return;
  if (popup.menu.hidePopover && popup.menu.matches(':popover-open')) popup.menu.hidePopover();
  popup.menu.classList.remove('is-floating');
  if (!popup.native) { popup.parent.appendChild(popup.menu); popup.menu.setAttribute('popover', 'auto'); }
  popup.button.setAttribute('aria-expanded', 'false');
  if (restoreFocus && popup.button.isConnected) popup.button.focus({ preventScroll: true });
}

function positionSettingsDropdown() {
  const popup = selectPopup;
  if (!popup) return;
  if (popup.native && !popup.menu.matches(':popover-open')) return;
  if (!popup.button.isConnected || popup.overlay !== host.sheetOverlay()) { closeSettingsDropdown(); return; }
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
  const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
  const anchor = popup.button.getBoundingClientRect();
  const menuWidth = Math.min(Math.max(anchor.width, popup.menu.querySelector('small') ? 250 : 170), width - 16);
  popup.menu.style.width = `${menuWidth}px`;
  const below = top + height - anchor.bottom - 8, above = anchor.top - top - 8;
  const upward = below < Math.min(popup.menu.scrollHeight, 280) && above > below;
  popup.menu.style.maxHeight = `${Math.max(40, Math.min(280, upward ? above : below))}px`;
  const menuHeight = popup.menu.getBoundingClientRect().height;
  popup.menu.style.left = `${Math.max(left + 8, Math.min(anchor.right - menuWidth, left + width - menuWidth - 8))}px`;
  popup.menu.style.top = `${Math.max(top + 8, Math.min(upward ? anchor.top - menuHeight - 6 : anchor.bottom + 6, top + height - menuHeight - 8))}px`;
  popup.menu.dataset.placement = upward ? 'above' : 'below';
  popup.menu.style.visibility = 'visible';
}

function prepareSettingsDropdown(menu, button, native) {
  closeSettingsDropdown();
  if (!button || button.disabled || !host.inSheet(button)) return false;
  const token = host.captureDraftTarget(button);
  if (!host.validateDraftTarget(token, { merge: false, notify: false }).ok) return false;
  selectPopup = { menu, button, native, token, overlay: host.sheetOverlay(), parent: menu.parentElement };
  button.setAttribute('aria-expanded', 'true');
  return true;
}

function onSelectPopover(event) {
  const menu = event.target;
  if (!menu.matches?.('.settings-select-options[popover]')) return;
  if (event.type === 'beforetoggle' && event.newState === 'open') {
    const button = menu.parentElement.querySelector('[data-moon-select-trigger]');
    if (!prepareSettingsDropdown(menu, button, true)) { event.preventDefault(); return; }
    menu.style.visibility = 'hidden';
    queueMicrotask(positionSettingsDropdown);
  } else if (event.type === 'toggle' && event.newState === 'open' && selectPopup?.menu === menu) {
    positionSettingsDropdown();
  } else if (event.type === 'toggle' && event.newState === 'closed' && selectPopup?.menu === menu) {
    closeSettingsDropdown();
  }
}

function onMoonClick(event) {
  if (event.target.matches?.('[data-scrim]') && (dismissSelectOnScrim || selectPopup)) {
    dismissSelectOnScrim = false; closeSettingsDropdown();
    event.preventDefault(); event.stopImmediatePropagation(); return;
  }
  dismissSelectOnScrim = false;
  const dropdown = event.target.closest?.('[data-moon-select-trigger]');
  if (dropdown && typeof HTMLElement.prototype.showPopover !== 'function') {
    event.preventDefault(); event.stopImmediatePropagation();
    if (selectPopup?.button === dropdown) { closeSettingsDropdown(true); return; }
    const menu = dropdown.parentElement.querySelector('.settings-select-options');
    if (menu && prepareSettingsDropdown(menu, dropdown, false)) {
      menu.removeAttribute('popover');
      selectPopup.overlay.appendChild(menu);
      menu.classList.add('is-floating');
      positionSettingsDropdown();
    }
    return;
  }
  if (selectPopup && !selectPopup.native && !selectPopup.menu.contains(event.target)) {
    closeSettingsDropdown(); event.preventDefault(); event.stopImmediatePropagation(); return;
  }
  if (handleFormalDialogClick(event)) return;
  const stepButton = event.target.closest?.('[data-moon-step]');
  if (stepButton) {
    event.preventDefault(); event.stopImmediatePropagation();
    if (stepButton.disabled || !host.inSheet(stepButton)) return;
    const spec = specFor(host.sheetKey());
    const field = spec.fields?.[Number(stepButton.dataset.fieldIndex)];
    if (spec.scope !== 'config' || field?.type !== 'number' || field.key !== stepButton.dataset.moonStep) return;
    const token = host.captureDraftTarget(stepButton);
    const valid = host.validateDraftTarget(token, { merge: false, notify: false });
    if (!valid.ok) { host.toast(valid.message || '当前设置已变化，请重新打开。'); return; }
    const input = stepButton.closest('.number-stepper')?.querySelector('input');
    const raw = input?.value ?? get(values(), field.key);
    const known = raw !== '' && Number.isFinite(Number(raw));
    const current = known ? Number(raw) : 0;
    const direction = Number(stepButton.dataset.direction);
    if (direction !== -1 && direction !== 1) return;
    let next = known ? current + direction : (field.min ?? direction);
    if (field.integer) next = Math.round(next);
    if (field.min !== undefined) next = Math.max(field.min, next);
    if (field.max !== undefined) next = Math.min(field.max, next);
    if (!host.applyDraftValue(token, field.key, next, { merge: false })) return;
    host.updateDirty(); host.rerenderSheet();
    return;
  }
  const logFilter = event.target.closest?.('[data-log-filter]');
  if (logFilter) {
    event.preventDefault(); event.stopImmediatePropagation();
    host.filterLogsByCorrelation?.(logFilter.dataset.logFilter, logFilter.dataset.logValue || '');
    host.closeTopDialog?.(); return;
  }
  const logReopen = event.target.closest?.('[data-moon-log-reopen]');
  if (logReopen) {
    event.preventDefault(); event.stopImmediatePropagation();
    const form = currentLogFilterForm(logReopen);
    if (form) { const id = form.panelId; host.closeTopDialog(); openLayer(id); }
    return;
  }
  const logRetry = event.target.closest?.('[data-moon-log-retry]');
  if (logRetry) {
    event.preventDefault(); event.stopImmediatePropagation();
    const form = currentLogFilterForm(logRetry);
    if (form) void readLogFilterCatalog(form);
    return;
  }
  if (event.target.matches?.('[data-formal-scrim]') && event.target.parentElement?.id === 'dialog-host') {
    event.preventDefault();
    event.stopImmediatePropagation();
    host.closeTopDialog();
    return;
  }
  /* 只有真正落在遮罩空白上才算「点外面关掉」；用 closest() 会把弹层内部的每一次点击
     都当成遮罩点击，详情层里的开关、选择器入口全都自封自关（真机实测：选花器点不开）。 */
  if (event.target.matches?.('[data-scrim]') && event.target.parentElement?.id === 'dialog-host') { host.closeTopDialog(); return; }
  const stab = event.target.closest?.('.settings-context [data-stab]');
  if (stab && !stab.disabled && host.setSettingsTab) {
    event.preventDefault();
    event.stopImmediatePropagation();
    host.setSettingsTab(stab.dataset.stab);
    return;
  }
  const panel = event.target.closest?.('[data-panel]');
  /* 行上同时挂着正式动作时不拦：这些入口要打开真实读数层（授权、同步、出口、退出确认），
     设计表里的同名面板只是示意内容，不能拿它顶替真状态。 */
  if (panel && panel.dataset.action) return;
  if (panel) {
    const id = panel.dataset.panel;
    if (id === 'background-settings') { panel.dataset.action = 'background-settings'; return; }
    const owner = panel.dataset.id ? String(panel.dataset.id) : '';
    /* 卡内「更多」带着该卡的稳定 ID：先切到那个号再开面板。
       不先切的话，面板里的读数和草稿会来自上次选中的账号（审查里"串到旧选中号"那条）。 */
    const withOwner = run => {
      if (owner && String(host.state?.selectedId ?? '') !== owner) {
        Promise.resolve(host.changeAccount(owner))
          .then(() => { if (String(host.state?.selectedId ?? '') === owner) run(); })
          .catch(() => host.toast('切换到这个游戏号失败，先刷新再试。'));
        return;
      }
      run();
    };
    withOwner(() => routePanel(id, owner));
    return;
  }
  const trigger = event.target.closest?.('[data-moon-picker]');
  if (trigger && !trigger.disabled) {
    const id = host.sheetKey();
    const spec = specFor(id);
    const field = (spec?.fields || [])[Number(trigger.dataset.moonPicker)];
    if (field) openPicker(field, Number(trigger.dataset.moonPicker), id, trigger);
    return;
  }
  const action = event.target.closest?.('[data-moon-action]')?.dataset.moonAction;
  if (['pick-quality', 'pick-view', 'pick-remove'].includes(action)) {
    if (!isCurrentPicker(event.target)) return;
    const button = event.target.closest('[data-moon-action]');
    if (action === 'pick-quality') {
      const quality = button.dataset.pickerQuality;
      if (quality && quality !== 'unknown' && !picker.items.some(one => one.quality === quality)) return;
      picker.quality = quality || '';
    } else if (action === 'pick-view') {
      if (!['all', 'selected'].includes(button.dataset.pickerView)) return;
      picker.view = button.dataset.pickerView;
      if (picker.view === 'selected') { picker.search = ''; picker.quality = ''; }
    } else picker.selected = picker.selected.filter(value => value !== button.dataset.pickerValue);
    picker.error = ''; rerenderPicker(action !== 'pick-remove'); return;
  }
  if (action === 'picker-cancel') {
    if (!isCurrentPicker(event.target)) return;
    picker = null; host.closeDialog(); host.rerenderSheet(); return;
  }
  if (action === 'picker-apply') {
    if (!isCurrentPicker(event.target)) return;
    const order = picker.items.map(one => String(one.value));
    /* The current catalogue is not proof that an older saved ID should be deleted. Keep those IDs;
       String identity deduplicates numeric/string variants without changing the DTO's allowed paths. */
    const rank = value => { const index = order.indexOf(value); return index < 0 ? order.length : index; };
    const saved = selectedIds(picker.selected).sort((a, b) => rank(a) - rank(b));
    const valid = host.validateDraftTarget(picker.token, { merge: true, notify: false });
    if (!valid.ok) { picker.error = valid.message || '当前草稿暂不能合并，请保留选择并返回核对。'; rerenderPicker(); return; }
    if (!host.applyDraftValue(picker.token, picker.field.key, saved, { merge: true, notify: false })) {
      picker.error = '草稿归属或读取基准已变化，本次选择没有合入；请返回原设置核对。';
      rerenderPicker(); return;
    }
    picker = null; host.closeDialog(); host.updateDirty(); host.rerenderSheet(); return;
  }
  if (action === 'pick-visible') {
    if (!isCurrentPicker(event.target)) return;
    picker.selected = selectedIds([...picker.selected, ...pickerFilteredItems().map(one => one.value)]);
    picker.error = ''; rerenderPicker(); return;
  }
  if (action === 'pick-clear') {
    if (!isCurrentPicker(event.target)) return;
    picker.selected = []; picker.error = ''; rerenderPicker(); return;
  }
  const panelAction = event.target.closest?.('[data-panel-action]');
  if (!panelAction) return;
  const name = panelAction.dataset.panelAction;
  /* 保活入口：只把请求交给本机，不把“打开了设置页”当成权限已允许。 */
  if (name === 'open-manufacturer-settings') { host.openKeepAliveSettings?.('manufacturer'); return; }
  if (name === 'toggle-screen-keep-on') { host.toggleScreenKeepOn?.(); return; }
  if (name === 'start-keepalive-probe') { host.startKeepAliveProbe?.(); return; }
  if (name === 'cancel-keepalive-probe') { host.cancelKeepAliveProbe?.(); return; }
  if (name === 'open-exact-alarm-settings') { host.openKeepAliveSettings?.('exact-alarm'); return; }
  if (name === 'toggle-keepalive-vpn') { host.toggleKeepAliveVpn?.(); return; }
  if (name === 'open-background-settings' || panelAction.dataset.target === 'background-settings') {
    // Keep the actual source overlay for the asynchronous native result. A body-mounted proxy
    // would lose this origin and could apply a late result above a different sheet.
    panelAction.dataset.action = 'background-settings';
    return;
  }
  if (['apply-preview-log-filters', 'clear-preview-log-filters'].includes(name)
    && panelAction.closest('.sheet-scrim,.dialog-overlay')?.querySelector('[data-moon-log-form]')) {
    handOffLogFilterAction(event, panelAction, name); return;
  }
  if (name === 'view-account-logs') { invokeFormal('account-logs', selectedAccountId()); return; }
  if (name === 'view-device-logs') {
    const overlay = panelAction.closest('.sheet-scrim,.dialog-overlay');
    if (!overlay || overlay !== topOverlay()) {
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    // Preserve the actual source frame for the formal navigation intent. A body-mounted proxy
    // would discard the opening owner/generation and cannot safely choose a new log source.
    panelAction.dataset.action = 'device-logs';
    return;
  }
  if (name === 'view-land') {
    host.navigateMoonSettings(panelAction, { land: true });
    return;
  }
  if (name === 'return-settings') { host.navigateMoonSettings(panelAction); return; }
  if (name === 'enter-accounts') { host.changeTab('accounts'); return; }
  if (name === 'return-login') { host.closeTopDialog(); return; }
  /* 栈顶以上是子面板：完成/取消只退这一层，下面那层的子草稿原样留着（真机实测：
     早先一律走 detailDone，把整张详情连同未合完的编辑一起关掉）。 */
  if (name === 'apply' || name === 'apply-config') {
    /* 共用子草稿的事务：完成把这一层的 paths 合到下一层再退一层；根层才写回页面草稿。 */
    host.detailDone(panelAction); return;
  }
  if (name === 'close' || name === 'cancel' || name === 'back' || name === 'dismiss') {
    if (panelAction.closest('.sheet-scrim,.dialog-overlay') !== topOverlay()) return;
    host.closeTopDialog(); return;
  }
  if (panelAction.dataset.target) { routePanel(panelAction.dataset.target, '', true); return; }
  if (name.startsWith('choose:')) { host.changeAccount(name.slice(7)); return; }
  /* 刷新本机状态：原地重读并保持这一层，不沿用正式弹层的“刷新即关闭”。 */
  if (name === 'refresh-preview' || name === 'reload-catalog') {
    const overlay = panelAction.closest('.sheet-scrim,.dialog-overlay');
    if (!overlay || overlay !== topOverlay()) { host.toast('这层入口已不在最上面，请返回当前页面后重新读取。'); return; }
    if (previewReads.has(overlay)) { host.toast('这一层正在读取，请等待本次结果。'); return; }
    const feedback = host.topMoonFeedback?.(overlay);
    const feedbackStatus = feedback && host.validateMoonFeedback(feedback);
    if (feedback && !feedbackStatus.ok) { host.toast(feedbackStatus.message); return; }
    if ((feedback && name !== 'refresh-preview') || (!feedback && overlay !== host.sheetOverlay())) {
      host.toast('这层没有对应的读取入口，请关闭后从当前页面重新打开。'); return;
    }
    const sheetId = feedback?.id || host.sheetKey();
    const identity = readIdentity();
    const sameLayer = result => overlay?.isConnected && host.topDialog()?.closest('.sheet-scrim,.dialog-overlay') === overlay
      && (feedback ? host.topMoonFeedback?.(overlay) === feedback && host.validateMoonFeedback(feedback).ok
        : host.sheetOverlay() === overlay && host.sheetKey() === sheetId)
      && identity.accountId === selectedAccountId() && identity.owner === String(host.softwareInfo()?.user?.id ?? '')
      && ((!feedback && result?.status === 'reconnecting') || sameReadIdentity(identity, readIdentity()));
    const repaint = () => feedback ? host.rerenderMoonFeedback(feedback) : host.rerenderSheet();
    const label = panelAction.innerHTML;
    const read = { overlay, identity, sheetId, feedback };
    previewReads.set(overlay, read);
    activePreviewReads.add(read);
    repaint();
    // The body-only rerender paints actual loading cards and may replace a catalogue retry
    // button. Keep this transaction's original layer, then acquire its current button.
    const activeButton = overlay?.querySelector(`[data-panel-action="${name}"]`);
    if (activeButton) { activeButton.disabled = true; activeButton.textContent = '正在读取…'; }
    const settle = result => {
      if (previewReads.get(overlay) !== read) return;
      previewReads.delete(overlay);
      activePreviewReads.delete(read);
      // A child may cover this layer while the read finishes. Release only this captured
      // button's busy label under its unchanged owner; projecting facts still requires top.
      const buttonOwnerCurrent = overlay.isConnected && sameReadIdentity(identity, readIdentity())
        && (!feedback || feedback.context.tab === host.state.tab && feedback.context.logsScope === host.state.logsScope);
      if (activeButton?.isConnected && buttonOwnerCurrent) { activeButton.disabled = false; activeButton.innerHTML = label; }
      if (sameLayer(result) && result?.status !== 'stale') {
        readViewSnapshots.delete(overlay);
        repaint();
        host.toast(result?.message || '本次没有取得新的读取结果。');
      } else {
        if (!feedback) projectCurrentReadFacts(read);
        else if (host.topMoonFeedback?.(overlay) === feedback) {
          host.toast(host.validateMoonFeedback(feedback).message || '本次读取归属已变化，请关闭这层反馈后重新读取。');
        }
      }
    };
    Promise.resolve().then(() => sameLayer()
      ? host.refreshNow({ reconnect: name === 'refresh-preview' && ['service-disconnected', 'connection-help'].includes(sheetId) })
      : { status: 'stale', message: '读取开始前当前层级或归属已变化，本次没有发起新的读取。' })
      .then(settle).catch(() => settle({ status: 'failed', message: '本次读取未完成，请稍后重新读取；没有应用新的成功结果。' }));
    return;
  }
  /* 示意动作 → 正式动作（见表）。开始/停止一律带上当前选中号的稳定 ID。 */
  const formal = FORMAL_ACTION[name];
  if (formal) { invokeFormal(formal, panelAction.dataset.id || selectedAccountId()); return; }
  host.toast('这一步要走的业务动作还没接进这一层，这里不代为发起。');
}

function onMoonInput(event) {
  const input = event.target;
  const stepper = input.closest?.('.number-stepper');
  if (stepper && input.matches('input[data-input]')) {
    const known = input.value !== '' && Number.isFinite(Number(input.value));
    for (const button of stepper.querySelectorAll('[data-moon-step]')) {
      const bound = Number(button.dataset.direction) < 0 ? input.min : input.max;
      button.disabled = input.disabled || (known && bound !== '' && (Number(button.dataset.direction) < 0
        ? Number(input.value) <= Number(bound) : Number(input.value) >= Number(bound)));
    }
  }
  if (['keyword','errorCode','operationId','traceId'].includes(input.dataset?.moonLogText)) {
    event.stopImmediatePropagation();
    const form = currentLogFilterForm(input);
    if (!form || !logFilterContextCurrent(form) || form.status !== 'read') return;
    const key = input.dataset.moonLogText;
    form[key] = String(input.value || '').slice(0, key === 'keyword' ? 160 : key === 'errorCode' ? 128 : 64);
    return;
  }
  if (!input.matches?.('[data-moon-picker-search]') || !isCurrentPicker(input)) return;
  const caret = input.selectionStart;
  picker.search = input.value;
  rerenderPicker(true);
  const next = picker.overlay.querySelector('[data-moon-picker-search]');
  if (next) { next.focus(); next.setSelectionRange(caret, caret); }
}

function onMoonChange(event) {
  const input = event.target;
  const textFilter = input.dataset?.moonLogText;
  if (['level', 'outcomeState'].includes(textFilter)) {
    event.stopImmediatePropagation();
    const form = currentLogFilterForm(input);
    const allowed = textFilter === 'level' ? ['', 'debug', 'info', 'warn', 'error', 'success']
      : ['', 'confirmed', 'failed', 'rejected', 'unknown', 'dirty', 'scheduled', 'waiting'];
    if (!form || !logFilterContextCurrent(form) || form.status !== 'read' || !allowed.includes(input.value)) return;
    form[textFilter] = input.value;
    return;
  }
  const logKey = input.dataset?.moonLogFilter;
  if (['scope', 'category', 'day'].includes(logKey) && input.checked) {
    event.stopImmediatePropagation();
    const form = currentLogFilterForm(input);
    if (!form) return;
    const value = input.value;
    if (!sameLogFilterOwner(form)) {
      failLogFilterForm(form, '软件身份或当前日志来源已变化，请关闭后重新打开筛选。'); return;
    }
    if (logKey === 'scope') {
      if (!logFilterScopes().some(one => one.value === value)) {
        failLogFilterForm(form, '这个日志来源已不在当前名册中，请重新打开筛选。'); return;
      }
      if (form.scope === value) return;
      form.scope = value; form.category = ''; form.day = '';
      void readLogFilterCatalog(form);
      return;
    }
    const choices = logKey === 'category' ? form.categories : form.days;
    if (form.status !== 'read' || !logFilterContextCurrent(form) || value && !choices.includes(value)) {
      failLogFilterForm(form, '所选条件不属于此来源的本次目录，请重新读取后再选。'); return;
    }
    form[logKey] = value;
    const hidden = form.overlay.querySelector(logKey === 'category' ? '#log-filter-category' : '#log-filter-day');
    if (hidden) hidden.value = value;
    paintLogFilterActions(form);
    return;
  }
  const radio = input.dataset?.moonRadio || input.dataset?.moonSelect;
  if (radio && (input.checked || input.dataset?.moonSelect)) {
    event.stopImmediatePropagation();
    const raw = input.dataset.moonSelect ? input.value : input.dataset.moonRadioValue;
    const num = Number(raw);
    const token = selectPopup?.menu.contains(input) ? selectPopup.token : host.captureDraftTarget(input);
    const valid = host.validateDraftTarget(token, { merge: false, notify: false });
    if (!valid.ok) { host.toast(valid.message || '当前草稿归属已变化，本次选择没有应用。'); closeSettingsDropdown(); host.rerenderSheet(); return; }
    if (!host.applyDraftValue(token, radio, raw !== '' && Number.isFinite(num) ? num : raw, { merge: false })) {
      closeSettingsDropdown(); host.rerenderSheet(); return;
    }
    closeSettingsDropdown(); host.rerenderSheet();
    return;
  }
  /* Normalized account drafts store ID arrays as strings. Handle only this moon config field here:
     allowing the old generic data-check handler to Number() it makes saved chips look unselected. */
  const check = input.dataset?.check;
  if (check && input.dataset.fieldIndex !== undefined && host.inSheet(input)) {
    const field = specFor(host.sheetKey())?.fields?.[Number(input.dataset.fieldIndex)];
    const split = check.lastIndexOf(':');
    const path = check.slice(0, split), value = check.slice(split + 1);
    if (split > 0 && field?.key === path && PANEL_SPECS[host.sheetKey()]?.scope === 'config') {
      event.stopImmediatePropagation();
      const current = selectedIds(get(values(), path));
      const token = host.captureDraftTarget(input);
      const valid = host.validateDraftTarget(token, { merge: false, notify: false });
      if (!valid.ok) { host.toast(valid.message || '当前草稿归属已变化，本次选择没有应用。'); host.rerenderSheet(); return; }
      if (!host.applyDraftValue(token, path, input.checked ? selectedIds([...current, value]) : current.filter(one => one !== value), { merge: false })) {
        host.rerenderSheet(); return;
      }
      host.updateDirty(); host.rerenderSheet();
      return;
    }
  }
  const catalogue = input.dataset?.moonCatalogue;
  if (catalogue !== undefined) {
    event.stopImmediatePropagation();
    if (!isCurrentPicker(input)) return;
    /* Catalogue and stored IDs share string identity inside the UI; only the existing save payload
       converts numeric DTO IDs. A checkbox must remove the same identity that it preselects. */
    const item = [...picker.items, ...picker.unlisted].find(one => String(one.value) === catalogue);
    if (!item) return;
    const value = String(item.value);
    picker.selected = input.checked ? selectedIds([...picker.selected, value]) : selectedIds(picker.selected).filter(one => one !== value);
    picker.error = '';
    rerenderPicker();
  }
}

export function install(theHost) {
  host = theHost;
  for (const id of PANEL_IDS) {
    const spec = specFor(id);
    /* 日志筛选读写的是日志状态（logsScope/logsCategory/logsDay），不是账号配置草稿：
       注册成只读面板，绝不把这三格合进 state.draft。 */
    const editable = spec.scope === 'config' && pathsOf(spec).length > 0 && !LOG_FILTER_PANELS.has(id);
    host.DETAILS[id] = { moon: true, title: spec.title, config: editable, paths: editable ? pathsOf(spec) : [], body: () => fieldsHTML(id) };
  }
  document.addEventListener('click', onMoonClick, true);
  document.addEventListener('beforetoggle', onSelectPopover, true);
  document.addEventListener('toggle', onSelectPopover, true);
  document.addEventListener('keydown', event => {
    if (selectPopup && event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); closeSettingsDropdown(true);
    }
  }, true);
  document.addEventListener('scroll', event => {
    if (selectPopup && event.target !== selectPopup.menu && !selectPopup.menu.contains(event.target)) closeSettingsDropdown();
  }, true);
  window.visualViewport?.addEventListener('resize', positionSettingsDropdown);
  window.addEventListener('resize', positionSettingsDropdown);
  // Keep a typed value available to the step button before blur repaints its row.
  document.addEventListener('pointerdown', event => {
    dismissSelectOnScrim = Boolean(selectPopup && event.target.matches?.('[data-scrim]'));
    if (event.target.closest?.('[data-moon-step]')) event.preventDefault();
  }, true);
  document.addEventListener('input', onMoonInput, true);
  document.addEventListener('change', onMoonChange, true);
  window.MoonUI = { sheetHTML, fieldsHTML, formalHTML: renderFormalDialog, formalBodyHTML: renderFormalDialogBody };
  window.MoonRender = {
    /* 月色层同时拥有正常、空、加载和错误态；缺少配置不能退回旧展示层。 */
    handles: state => Boolean(window.MoonUI) && host.signedIn?.() === true
      && ['accounts', 'settings', 'logs', 'me'].includes(state.tab),
    mount,
  };
  host.render();
  return { panels: PANEL_IDS.length, config: PANEL_IDS.filter(id => PANEL_SPECS[id].scope === 'config').length };
}

function mount() {
  const vm = buildViewModel(host);
  const page = PAGES[vm.view](vm);
  document.documentElement.classList.add('moon-shell');
  document.body.dataset.identity = 'moon';
  document.body.dataset.layout = 'panel';
  document.body.dataset.view = host.state.tab;
  document.body.dataset.moon = vm.view;
  const chrome = document.getElementById('moon-chrome');
  const dock = document.getElementById('moon-dock');
  const navigation = document.getElementById('navigation');
  if (chrome) chrome.innerHTML = page.chrome;
  if (dock) dock.innerHTML = page.dock || '';
  if (navigation) {
    navigation.className = 'bottom-nav';
    navigation.setAttribute('aria-label', '主导航');
    navigation.innerHTML = page.nav.replace(/^<nav class="bottom-nav" aria-label="主导航">/, '').replace(/<\/nav>$/, '');
  }
  const main = host.main;
  const keep = main.scrollTop;
  const route = `${vm.view}:${vm.accountId || ''}`;
  main.className = vm.view === 'logs' ? 'scroll-area logs-content' : ['land', 'orders', 'art', 'rewards', 'guild'].includes(vm.view) ? 'scroll-area settings-content' : 'scroll-area';
  main.innerHTML = page.content;
  main.scrollTop = mountedRoute === route ? keep : 0;
  mountedRoute = route;
}
