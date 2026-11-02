/* Panel layer ported from docs/design/20261020/prototype.js lines 88-144 (condition, fieldOptions,
   fieldMarkup, panelMarkup, pickerMarkup). Markup, class names and footer structure are the prototype's.
   Two deliberate production changes: the demo copy ("设计示意 / 不连接账号") is replaced by what the formal
   app really does, and values that have no real source render as 未读取 instead of an example number. */
import { icon } from './icons.js';
import { esc, iconButton } from './components.js';

export const get = (object, path) => String(path || '').split('.').reduce((value, key) => value?.[key], object);

export function set(object, path, value) {
  const keys = path.split('.'); const last = keys.pop();
  const target = keys.reduce((node, key) => node[key] ||= {}, object);
  target[last] = value;
}

export function condition(rule, values) {
  if (!rule) return true;
  if (typeof rule === 'string') return get(values, rule) === true;
  if (Array.isArray(rule)) return rule.every(one => condition(one, values));
  if (Array.isArray(rule.any)) return rule.any.some(one => condition(one, values));
  if (Array.isArray(rule.all)) return rule.all.every(one => condition(one, values));
  const value = get(values, rule.key || rule.path);
  if ('equals' in rule) return value === rule.equals;
  if ('value' in rule) return Array.isArray(rule.value) ? rule.value.includes(value) : value === rule.value;
  if ('not' in rule) return value !== rule.not;
  return Boolean(value);
}

const UNREAD = '未读取';
let selectSequence = 0;

export function fieldOptions(field, catalogs) {
  return (field.options || catalogs[field.catalog] || []).map(one => {
    const option = typeof one === 'object' && one !== null ? one : { value: one, label: String(one) };
    return { ...option, value: String(option.value) };
  });
}

/* A panel field becomes a formal control: same DOM as the prototype, but writes go through the draft
   paths the app already protects (子草稿 only until 完成, and never a business write from a read-only layer). */
export function fieldMarkup(field, index, frame, ctx) {
  if (typeof ctx.resolveField === 'function') field = ctx.resolveField(field);
  const values = frame.values;
  if (!condition(field.showWhen, values)) return '';
  const key = field.key || `display-${index}`;
  const value = field.key ? get(values, key) : (ctx.resolve ? ctx.resolve(field) : (field.value ?? ''));
  const disabled = field.disabled || !condition(field.enableWhen, values);
  const description = (typeof ctx.resolveDescription === 'function'
    ? ctx.resolveDescription(field)
    : (field.description || field.help)) || '';
  const help = description ? `<p class="field-description">${esc(description)}</p>` : '';
  const label = esc(field.label || '');
  const err = frame.errors?.[key];
  const cap = `<div class="field-caption"><label for="field-${esc(key)}">${label}${field.required ? '<span class="required-mark">必填</span>' : ''}</label>${field.help ? `<button type="button" class="field-help-button" data-moon-help="${index}" aria-label="${label}说明">${icon('CircleHelp')}</button>` : ''}</div>`;
  if (field.type === 'divider' || field.type === 'heading') return `<h3 class="panel-heading">${icon(field.icon || 'Leaf')}${label}</h3>`;
  if (field.type === 'note') return `<div class="panel-note ${esc(field.tone || '')}">${label ? `<strong>${label}</strong>` : ''}${esc(description || (ctx.resolve ? ctx.resolve(field) : field.value) || '')}</div>`;
  if (field.type === 'status') {
    const shown = ctx.resolve ? ctx.resolve(field) : (field.value || field.label || '');
    return `<section class="panel-status ${esc(field.tone || '')}">${icon(field.icon || (field.tone === 'danger' ? 'CircleAlert' : field.tone === 'warning' ? 'Clock3' : field.tone === 'loading' ? 'LoaderCircle' : 'CircleCheck'))}<div>${field.value ? `<p class="panel-eyebrow">${label}</p>` : ''}<h3>${esc(shown || UNREAD)}</h3>${description ? `<p>${esc(description)}</p>` : ''}</div></section>`;
  }
  if (field.type === 'list') {
    const rows = (ctx.resolve && ctx.resolve(field)) || field.items || field.rows || [];
    return `${label ? `<h3 class="panel-heading">${label}</h3>` : ''}<dl class="panel-kv">${rows.map(one => typeof one === 'string' ? `<div><dt>${esc(one)}</dt><dd>${UNREAD}</dd></div>`
      : `<div><dt>${esc(one.label || one.name || '')}</dt><dd>${esc(one.value ?? one.description ?? UNREAD)}${one.filterKey && typeof one.value === 'string' ? ` <button type="button" class="panel-link" data-log-filter="${esc(one.filterKey)}" data-log-value="${esc(one.value)}">筛选关联记录</button>` : ''}</dd></div>`).join('')}</dl>${help}`;
  }
  if (field.type === 'action') return `<button type="button" class="panel-link" ${disabled ? 'disabled' : ''} ${field.target ? `data-panel="${esc(field.target)}"` : `data-panel-action="${esc(field.action || 'close')}"`}>${field.icon ? icon(field.icon) : ''}<span>${label}${description ? `<small>${esc(description)}</small>` : ''}</span>${icon('ChevronRight')}</button>`;
  if (field.type === 'toggle') return `<div class="panel-toggle ${disabled ? 'disabled' : ''}"><div class="field-copy"><h3>${label}</h3>${description ? `<p>${esc(description)}</p>` : ''}</div><button type="button" class="toggle" role="switch" aria-label="${esc(field.label || '')}" aria-checked="${condition(field.checkedWhen, values) && (field.checkedWhen ? true : get(values, key) === true)}" data-path="${esc(key)}"${disabled ? ' disabled' : ''}><span class="toggle-track"></span></button></div>`;
  if (field.type === 'picker') {
    const options = fieldOptions(field, ctx.catalogs); const list = [...new Set(Array.isArray(value) ? value.map(String) : [])];
    const chosen = options.filter(one => list.includes(one.value)).map(one => field.catalog === 'arts' ? `${one.label}（${one.description}）` : one.label);
    const listed = new Set(options.map(one => one.value));
    const missing = list.filter(one => !listed.has(one)).map(one => `已保存目录项 #${one}（${field.catalogueUnlistedKnown ? '当前目录未列出' : '目录名称未读取'}）`);
    chosen.push(...missing);
    if (field.compactSettings) {
      return `<div class="field-block compact-picker"><div class="compact-field-row"><span class="compact-picker-label">${label}</span><button type="button" class="picker-trigger" data-moon-picker="${index}" ${disabled ? 'disabled' : ''} aria-label="${label}，已选 ${list.length} 项${chosen.length ? `，${esc(chosen.join('、'))}` : ''}"><span class="picker-count">${list.length ? `已选 ${list.length} 项` : '点击选择'}</span>${icon('ChevronRight')}</button></div>${chosen.length ? `<p class="picker-selection-summary">${chosen.slice(0, 3).map(esc).join('、')}${chosen.length > 3 ? ` 等 ${chosen.length} 项` : ''}</p>` : ''}${help}${err ? `<p class="field-error">${esc(err)}</p>` : ''}</div>`;
    }
    return `<div class="field-block">${cap}<button type="button" class="picker-trigger" data-moon-picker="${index}" ${disabled ? 'disabled' : ''}><span>${esc(field.placeholder || '点击选择')}</span><span class="picker-count">已选 ${list.length} 项</span>${icon('ChevronRight')}</button>${chosen.length ? `<p class="selected-values">${chosen.map(esc).join(' · ')}</p>` : ''}${help}${err ? `<p class="field-error">${esc(err)}</p>` : ''}</div>`;
  }
  if (field.type === 'select' || field.type === 'chips' || field.type === 'radio') {
    if (field.type === 'select' && field.compactSettings) {
      const options = fieldOptions(field, ctx.catalogs);
      const selected = options.find(one => one.value === String(value));
      const popupId = `settings-select-${++selectSequence}`;
      return `<div class="field-block compact-select"><div class="settings-select"><span class="settings-select-label">${label}</span><button type="button" class="settings-select-value" popovertarget="${popupId}" data-moon-select-trigger="${popupId}" aria-label="${label}：${esc(selected?.label || '请选择')}" aria-expanded="false"${disabled ? ' disabled' : ''}>${esc(selected?.label || '请选择')}${icon('ChevronDown')}</button><div id="${popupId}" class="settings-select-options" popover="auto" role="group" aria-label="${label}">${options.map(one => `<label class="panel-choice"><input type="radio" name="${esc(key)}" data-moon-radio="${esc(key)}" data-moon-radio-value="${esc(one.value)}"${String(value) === one.value ? ' checked' : ''}${disabled ? ' disabled' : ''}><span class="option-copy"><strong>${esc(one.label)}</strong>${one.description ? `<small>${esc(one.description)}</small>` : ''}</span></label>`).join('')}</div></div>${help}${err ? `<p class="field-error">${esc(err)}</p>` : ''}</div>`;
    }
    const multi = (field.type === 'chips' && Array.isArray(value)) || field.multiple === true;
    const list = Array.isArray(value) ? value.map(String) : [];
    return `<fieldset class="field-block panel-fieldset" ${disabled ? 'disabled' : ''}><legend class="field-caption"><strong>${label}</strong></legend><div class="${field.type === 'chips' ? 'panel-choices' : 'option-list'}">${fieldOptions(field, ctx.catalogs).map((one, i) => `<label class="panel-choice"><input type="${multi ? 'checkbox' : 'radio'}" name="${esc(key)}" data-option-index="${i}" data-field-index="${index}" ${multi ? `data-check="${esc(key)}:${esc(one.value)}"` : `data-moon-radio="${esc(key)}" data-moon-radio-value="${esc(one.value)}"`} ${multi ? (list.includes(one.value) ? 'checked' : '') : String(value) === String(one.value) ? 'checked' : ''}${disabled ? ' disabled' : ''}><span class="option-copy"><strong>${esc(one.label)}</strong>${one.description ? `<small>${esc(one.description)}</small>` : ''}</span></label>`).join('')}</div>${help}${err ? `<p class="field-error">${esc(err)}</p>` : ''}</fieldset>`;
  }
  const type = ['number', 'password', 'email', 'url'].includes(field.type) ? field.type : 'text';
  const attrs = (type === 'number' ? [['min', field.min], ['max', field.max]] : [['minlength', field.minLength ?? field.min], ['maxlength', field.maxLength ?? field.max]])
    .filter(([, v]) => v !== undefined).map(([k, v]) => `${k}="${esc(v)}"`).join(' ');
  const shown = value === undefined || value === null ? '' : value;
  const input = `<input class="panel-input" id="field-${esc(key)}" type="${type}" data-input="${esc(key)}" value="${esc(shown)}" placeholder="${esc(field.placeholder || '')}" ${attrs} ${disabled ? 'disabled' : ''} ${field.required ? 'required' : ''} ${type === 'number' ? 'inputmode="numeric" step="1"' : ''} autocomplete="off" ${err ? 'aria-invalid="true"' : ''}>`;
  if (type === 'number' && frame.spec?.scope === 'config') {
    const known = shown !== '' && Number.isFinite(Number(shown));
    const step = (direction, glyph) => `<button type="button" class="number-step" data-moon-step="${esc(key)}" data-field-index="${index}" data-direction="${direction}" aria-label="${direction < 0 ? '减少' : '增加'}${label}"${disabled || (known && (direction < 0 ? field.min !== undefined && Number(shown) <= field.min : field.max !== undefined && Number(shown) >= field.max)) ? ' disabled' : ''}>${glyph}</button>`;
    return `<div class="field-block numeric-field"><div class="numeric-row">${cap}<div class="number-control"><div class="number-stepper">${step(-1, '−')}${input}${step(1, '+')}</div>${field.unit ? `<span class="number-unit">${esc(field.unit)}</span>` : ''}</div></div>${help}${err ? `<p class="field-error" role="alert">${esc(err)}</p>` : ''}</div>`;
  }
  return `<div class="field-block">${cap}${type === 'password' ? `<div class="password-control">${input}${iconButton('Eye', '显示或隐藏密码', `data-moon-reveal="${esc(key)}"`)}</div>` : field.unit ? `<div class="input-with-unit">${input}<span class="unit">${esc(field.unit)}</span></div>` : input}${help}${err ? `<p class="field-error" role="alert">${esc(err)}</p>` : ''}</div>`;
}

export function panelMarkup(frame, ctx) {
  if (frame.picker) return pickerMarkup(frame, ctx);
  const spec = frame.spec;
  const related = spec.related || [];
  const actions = [spec.secondary, spec.primary, spec.tertiary].filter(Boolean);
  const depth = ctx.depth ?? 1;
  return `<div class="sheet-scrim ${['dialog', 'confirm'].includes(spec.kind) ? 'confirm-scrim' : ''}" data-scrim><section class="bottom-sheet v2-sheet ${['dialog', 'confirm'].includes(spec.kind) ? 'confirm-dialog' : ''}" role="dialog" aria-modal="true" aria-labelledby="panel-title"><div class="sheet-handle"></div><header class="sheet-header"><div><p class="panel-eyebrow">${esc(spec.group || '无尽夏')}</p><h2 id="panel-title">${esc(ctx.resolveText(spec.title))}</h2></div>${iconButton(depth > 1 ? 'ArrowLeft' : 'X', depth > 1 ? '返回上一层' : '关闭', 'data-action="close-panel"')}</header>${spec.subtitle ? `<p class="panel-subtitle">${esc(ctx.resolveText(spec.subtitle))}</p>` : ''}<div class="panel-scroll">${frame.error ? `<p class="field-error" role="alert">${esc(frame.error)}</p>` : ''}${(spec.fields || []).map((field, index) => fieldMarkup(field, index, frame, ctx)).join('')}${related.length ? `<div class="design-related"><p>相关状态 / 查看其他反馈</p><div>${related.map(one => `<button type="button" data-panel="${esc(one.target || one.id)}">${esc(one.label)}</button>`).join('')}</div></div>` : ''}</div><footer class="panel-footer"><div class="panel-actions">${actions.map(action => `<button type="button" class="${action === spec.primary ? 'primary' : 'secondary'} ${action.tone === 'danger' ? 'danger-primary' : ''}" data-panel-action="${esc(action.action || 'navigate')}" ${action.target ? `data-target="${esc(action.target)}"` : ''} ${action.action === 'refresh-preview' && ctx.refreshing ? 'disabled' : ''}>${esc(action.action === 'refresh-preview' && ctx.refreshing ? '正在读取…' : action.label)}</button>`).join('') || '<button type="button" class="primary" data-action="close-panel">知道了</button>'}</div><p class="preview-label">${icon('Eye')}${esc(ctx.footerNote || '仅更新当前设置草稿，保存后才对本账号生效')}</p></footer></section></div>`;
}

export function pickerMarkup(frame, ctx) {
  const field = frame.field;
  const items = fieldOptions(field, ctx.catalogs);
  const filtered = items.filter(one => `${one.label} ${one.description || ''}`.toLowerCase().includes(frame.search.toLowerCase()));
  const choices = Array.isArray(frame.selected) ? frame.selected.map(String) : [];
  return `<div class="sheet-scrim" data-scrim><section class="bottom-sheet v2-sheet" role="dialog" aria-modal="true" aria-labelledby="panel-title"><div class="sheet-handle"></div><header class="sheet-header"><div><p class="panel-eyebrow">目录选择</p><h2 id="panel-title">${esc(field.label)}</h2></div>${iconButton('ArrowLeft', '取消选择', 'data-action="close-panel"')}</header><p class="panel-subtitle">${esc(ctx.pickerNote || '名称来自本机目录读数；没有读到的项目不会当作已解锁或有库存。')}</p><div class="panel-scroll"><div class="picker-toolbar"><input class="panel-input" type="search" data-moon-picker-search placeholder="搜索名称或配方" value="${esc(frame.search)}" aria-label="搜索目录"><button type="button" data-action="pick-visible">全选可见</button></div><div class="picker-meta"><span>找到 ${filtered.length} 项 · 已选 ${choices.length} 项</span><button type="button" data-action="pick-clear">清空已选</button></div><div class="catalogue-list">${filtered.length ? filtered.map(one => `<label class="catalogue-row"><input type="checkbox" data-moon-catalogue="${esc(one.value)}" ${choices.includes(one.value) ? 'checked' : ''}><span class="feature-icon ${field.catalog === 'arts' ? 'lilac' : ''}">${icon(field.catalog === 'arts' ? 'Flower' : 'Flower2')}</span><span><strong>${esc(one.label)}</strong><small>${esc(one.description || '目录未提供说明')}</small></span></label>`).join('') : '<div class="catalogue-empty">没有找到匹配项目<br>试试其他名称，或清除搜索内容。</div>'}</div></div><footer class="panel-footer"><div class="panel-actions"><button type="button" class="secondary" data-action="close-panel">取消</button><button type="button" class="primary" data-action="apply-picker">完成选择（${choices.length}）</button></div><p class="preview-label">${icon('Eye')}只更新当前设置草稿，不执行游戏操作</p></footer></section></div>`;
}
