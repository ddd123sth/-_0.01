/* Complete settings study. Browser memory only; no service, storage or game calls. */
'use strict';
(() => {
  const views = ['land', 'orders', 'art', 'rewards', 'events', 'mini', 'guild', 'cadence'];
  const groupForView = { land: 'yard', orders: 'order', art: 'craft', rewards: 'reward', events: 'event', mini: 'mini', guild: 'guild', cadence: 'cadence' };
  const viewForGroup = Object.fromEntries(Object.entries(groupForView).map(([view, group]) => [group, view]));
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const read = (value, key) => key.split('.').reduce((node, part) => node?.[part], value);
  const write = (value, key, next) => { const parts = key.split('.'); const last = parts.pop(); const node = parts.reduce((item, part) => item[part] ||= {}, value); node[last] = next; };
  let data, presentation, specStore, catalogStore, bridge;
  let sourceFields = [];
  const ownerSpecs = new Map();
  const fieldOwners = new Map();
  const shareRecords = new Map();
  let shareSequence = 0;
  let bound = false;
  const panelId = id => `complete-${id}`;
  const rackPageId = page => panelId(page === 'sell' ? 'rack-selling' : `rack-${page}`);
  const sections = {
    land: [['花园照料', ['plant', 'water', 'harvest']], ['土地与加速', ['land-unlock', 'land-speedup']], ['水滴补给', ['bucket']]],
    orders: [['订单自动化', ['order-resident', 'order-satin', 'order-decorate', 'order-customer', 'order-palace', 'order-team']]],
    art: [['花艺经营', ['rack-sell', 'flower-market']], ['花朵成长', ['cultivate-start', 'cultivate-upgrade']], ['商店与兑换', ['material-shop', 'flower-shop']]],
    rewards: [['每日与每周', ['daily-task-rewards', 'daily-activity-box', 'weekly-task-rewards', 'daily-sign']], ['成长与剧情', ['road-grow', 'main-task', 'guide-progress', 'story-main']], ['花园福利', ['flower-bounty', 'mail', 'double-coin', 'benefit-box', 'giftbag-free-yuanbao']], ['答题与兑换', ['anti-fraud', 'redeem-code-use']]],
    events: [['长期与周期活动', ['activity', 'elf-pass', 'flower-pass']], ['活动经营与奖励', ['peddler', 'act-story', 'weekly-box']]],
    mini: [['花园互动', ['random-event', 'friend-steal', 'flower-elves']], ['珍珠采集', ['pearl']], ['猫庭日常', ['zoo-pet-care', 'zoo-souvenir', 'zoo-game-2048']]],
    guild: [['公会经营', ['guild-land', 'guild-build-gold', 'guild-shop']], ['成员协作', ['guild-share', 'guild-race']], ['公会日常', ['guild-show-like', 'energy-forest']]]
  };

  function optionsFor(source) {
    const revised = presentation.optionLabels?.[source.key];
    if (revised?.length) return clone(revised);
    if (source.options?.length) return clone(source.options);
    const catalog = source.source?.optionSource || source.metadata?.source;
    return clone(data.catalogs?.[catalog] || []);
  }

  function normalizedField(source) {
    const text = presentation.fields[source.key];
    const field = {
      complete: true, key: source.key, label: text.label, completeHint: text.hint,
      completeSection: text.section || '', originalType: source.type,
      type: source.type === 'switch' ? 'toggle' : source.type === 'multiselect' ? 'picker' : source.type,
      options: optionsFor(source), completeDependencies: clone(source.dependsOn || []),
      min: source.min ?? source.metadata?.min, max: source.max ?? source.metadata?.max,
      required: source.type === 'number', integer: source.type === 'number'
    };
    if (source.type === 'multiselect') {
      field.catalog = source.source?.optionSource || source.metadata?.source || '';
      field.placeholder = field.catalog === 'accounts' ? '选择自己的其他游戏号' : source.key.endsWith('take_member_targets') ? '查看成员名单' : '选择名单';
    }
    return field;
  }

  function prepare(specs, catalogs, defaults) {
    data = window.COMPLETE_SETTINGS_DATA;
    if (!data?.groups || !data?.presentation) throw new Error('Complete settings presentation data is missing');
    presentation = data.presentation;
    specStore = specs; catalogStore = catalogs;
    ownerSpecs.clear(); fieldOwners.clear();
    Object.entries(specs).forEach(([id, spec]) => { if (spec.scope === 'config') delete specs[id]; });
    Object.assign(catalogs, clone(data.catalogs || {}));
    sourceFields = data.groups.flatMap(group => group.items).filter(field => field.type !== 'note');
    sourceFields.forEach(field => write(defaults, field.key, clone(field.default)));
    const grouped = new Map();
    sourceFields.forEach(field => { if (!grouped.has(field.ownerId)) grouped.set(field.ownerId, []); grouped.get(field.ownerId).push(field); });
    function addOwner(id, meta, items, sourceOwnerId = id) {
      const allFields = items.map(normalizedField);
      const spec = {
        title: meta.title, subtitle: meta.summary, group: data.groups.find(group => group.items.some(field => field.ownerId === sourceOwnerId))?.label || '设置',
        complete: true, completeOwnerId: id, sourceOwnerId, scope: 'config', kind: 'sheet',
        primaryKey: meta.primaryKey, icon: meta.icon, tone: meta.tone,
        fields: allFields.filter(field => field.key !== meta.primaryKey),
        primary: { label: '完成', action: 'apply' }, secondary: { label: '取消', action: 'close' }
      };
      specs[panelId(id)] = spec; ownerSpecs.set(id, spec);
      allFields.forEach(field => fieldOwners.set(field.key, { ownerId: id, panelId: panelId(id), location: field.key === meta.primaryKey ? 'home' : 'detail' }));
    }
    for (const [id, items] of grouped) {
      if (id === 'cadence') continue;
      addOwner(id, presentation.owners[id], items);
    }
    presentation.cadenceCards.forEach(card => addOwner(card.id, card, grouped.get('cadence').filter(field => card.keys.includes(field.key)), 'cadence'));
    const rack = ownerSpecs.get('rack-sell');
    const rackFields = rack.fields;
    const rackLabels = { real_flower_art_make: '自动制作花艺', specified_arts: '要做哪些花艺', auto_replenish: '自动补货', make_batch: '每种目标库存', real_rack_sell: '自动上架', rack_specified_arts: '要卖哪些花艺', sort_strategy: '优先上架哪种', put_count: '每个架位摆几件', rack_auto_take_down: '超时自动下架', rack_take_down_minutes: '上架多久后下架', real_rack_unlock: '金币解锁花架', rack_unlock_keep_gold: '解锁后保留金币', first_album_claim: '领取图鉴奖励', first_share_claim: '领取分享奖励' };
    rackFields.forEach(field => { field.label = rackLabels[field.key.split('.').pop()] || field.label; presentation.fields[field.key].label = field.label; });
    rack.rackHub = true;
    rack.rackFields = rackFields;
    rack.fields = [];
    const rackPages = [
      ['make', '做花艺', '制作', 'Flower2'],
      ['sell', '卖花艺', '摆货', 'ShoppingBag'],
      ['rewards', '领取奖励', '领奖', 'Gift']
    ];
    rackPages.forEach(([page, title, section, icon]) => {
      const id = rackPageId(page);
      const fields = rackFields.filter(field => field.completeSection === section);
      specs[id] = { ...rack, title, icon, rackHub: false, rackFields: undefined, rackPage: page, fields, hidden: true };
      fields.forEach(field => fieldOwners.set(field.key, { ownerId: 'rack-sell', panelId: id, location: 'detail' }));
    });
    const aliases = {
      'plant-detail': 'plant', 'plant-mode': 'plant', 'plant-flowers': 'plant', 'plant-qualities': 'plant', 'plant-groups': 'plant', 'plant-blacklist': 'plant', 'plant-target': 'plant',
      'flower-picker': 'plant', 'quality-picker': 'plant', blacklist: 'plant', restock: 'plant',
      'water-detail': 'water', 'harvest-detail': 'harvest', 'resident-detail': 'order-resident', 'satin-detail': 'order-satin', 'decorate-detail': 'order-decorate',
      'customer-detail': 'order-customer', 'palace-detail': 'order-palace', 'team-detail': 'order-team',
      'order-resident': 'order-resident', 'order-satin': 'order-satin', 'order-decorate': 'order-decorate', 'order-customer': 'order-customer', 'order-palace': 'order-palace', 'order-team': 'order-team',
      'daily-detail': 'daily-task-rewards', 'daily-rewards': 'daily-task-rewards', 'daily-status': 'daily-task-rewards', 'daily-reward-status': 'daily-task-rewards', 'daily-protection': 'daily-task-rewards',
      'art-detail': 'rack-sell', 'art-arts': 'rack-sell', 'art-target': 'rack-sell', 'art-replenish': 'rack-sell', 'art-picker': 'rack-sell', 'art-album': 'rack-sell', 'art-share': 'rack-sell', 'art-status': 'rack-sell', 'customer-art-link': 'rack-sell'
    };
    Object.entries(aliases).forEach(([alias, owner]) => { specs[alias] = specs[panelId(owner)]; });
    ['art-arts', 'art-target', 'art-replenish', 'art-picker'].forEach(id => specs[id] = specs[panelId('rack-make')]);
    ['art-album', 'art-share'].forEach(id => specs[id] = specs[panelId('rack-rewards')]);
    specs['complete-categories'] = { complete: true, completeCategories: true, title: '设置分类', group: '设置导航', fields: [], kind: 'sheet', hidden: true };
    specs['orders-state-help'] = { complete: true, completeHelp: '条件不足时等待；状态未读到时继续核对；结果未确认的原操作保留，不重复提交。', title: '运行状态说明', group: '设置说明', fields: [], hidden: true };
    const tool = (title, kind, defaults = {}) => ({ complete: true, completeTool: kind, scope: 'tool', title, group: '复制与分享', fields: [], defaults, kind: 'sheet' });
    specs['complete-tools'] = tool('复制与分享设置', 'tools');
    specs['complete-copy'] = tool('复制其他号设置', 'copy', { sourceAccount: '', keepCadence: false });
    specs['complete-share'] = tool('分享当前设置', 'share', { shareLabel: '' });
    specs['complete-import'] = tool('使用分享码', 'import', { shareCode: '', keepCadence: false });
  }

  function header(view, ctx) {
    const { I, esc, accountPicker } = ctx;
    return `<header class="top-title settings-title"><h1>自动化设置</h1>${accountPicker(true)}</header><div class="settings-context complete-settings-context"><nav class="tabs complete-tabs" aria-label="设置分类">${views.map(item => `<button type="button" data-view="${item}" class="${item === view ? 'active' : ''}" ${item === view ? 'aria-current="page"' : ''}>${esc(data.groups.find(group => group.id === groupForView[item])?.label || '')}</button>`).join('')}</nav><button type="button" class="icon-button complete-category-button" data-complete-action="categories" aria-label="选择设置分类">${I('ListFilter')}</button></div>`;
  }

  function ownerRow(id, ctx) {
    const { I, esc, cfg, toggle } = ctx;
    const spec = ownerSpecs.get(id); if (!spec) return '';
    return `<div class="order-row complete-owner-row"><button type="button" class="order-card-link" data-panel="${panelId(id)}"><span class="feature-icon ${esc(spec.tone || '')}">${I(spec.icon || 'Settings2')}</span><span class="feature-copy"><h2>${esc(spec.title)}</h2><p>${esc(spec.subtitle)}</p></span>${I('ChevronRight')}</button>${spec.primaryKey ? toggle(spec.primaryKey, spec.title, cfg()) : ''}</div>`;
  }

  function render(view, ctx) {
    if (!views.includes(view)) return null;
    const { statusBar, section, saveDock, nav, I, pageStateMarkup, state } = ctx;
    const blocks = view === 'cadence' ? [['账号运行', presentation.cadenceCards.map(card => card.id)]] : sections[view];
    const content = state.pageState !== 'normal' ? pageStateMarkup('设置') : `${blocks.map(([label, ids]) => `${section(label, '')}<section class="setting-card orders-card">${ids.map(id => ownerRow(id, ctx)).join('')}</section>`).join('')}<button type="button" class="advanced-link complete-tools-link" data-panel="complete-tools">复制与分享设置 ${I('ChevronRight')}</button>`;
    return `<div class="phone complete-phone">${statusBar()}${header(view, ctx)}<div class="scroll-area settings-content complete-settings-content">${content}</div>${state.pageState === 'normal' ? saveDock() : ''}${nav('land')}</div>`;
  }

  function fieldDisabled(field, values) {
    return (field.completeDependencies || []).some(rule => {
      if (rule.kind === 'lockedWhen') return rule.semantics?.startsWith('OR:') ? !rule.keys.some(key => read(values, key) === true) : !rule.keys.every(key => read(values, key) === true);
      if (rule.kind === 'exclusiveWith') return read(values, field.key) !== true && read(values, rule.key) === true;
      return false;
    });
  }

  function fieldMarkup(field, index, frame, ctx) {
    if (!field.complete) return null;
    const { I, esc, toggle } = ctx;
    const value = read(frame.values, field.key);
    const disabled = fieldDisabled(field, frame.values);
    const error = frame.errors?.[field.key];
    const help = field.completeHint ? `<button type="button" class="field-help-button complete-help-button" data-complete-help="${esc(field.key)}" aria-label="${esc(field.label)}说明">${I('CircleHelp')}</button>` : '';
    const caption = `<div class="field-caption"><label for="complete-field-${esc(field.key)}">${esc(field.label)}</label>${help}</div>`;
    const errorMarkup = error ? `<p class="field-error" role="alert">${esc(error)}</p>` : '';
    if (field.type === 'toggle') return `<div class="panel-toggle complete-field ${disabled ? 'disabled' : ''}"><div class="field-copy">${caption}</div>${toggle(field.key, field.label, frame.values, disabled, true)}</div>${errorMarkup}`;
    if (field.type === 'picker') {
      if (field.key === 'guild.guild_share.take_member_targets') return `<div class="field-block complete-field">${caption}<textarea class="panel-input complete-member-input" id="complete-field-${esc(field.key)}" data-complete-members="${esc(field.key)}" rows="3" placeholder="输入成员 UID，多个用逗号或换行分隔" ${disabled ? 'disabled' : ''}>${esc(Array.isArray(value) ? value.join('\n') : value || '')}</textarea><p class="complete-field-note">留空不限成员；仅限定可领取分享的成员。</p>${errorMarkup}</div>`;
      if (field.catalog === 'accounts') field.options = ctx.state.accounts.filter(name => name !== ctx.state.account).map(name => ({ value: name, label: name, description: '原型示例游戏号' }));
      const values = Array.isArray(value) ? value : [];
      const options = field.options || catalogStore[field.catalog] || [];
      const chosen = options.filter(option => values.includes(option.value)).map(option => option.label);
      const short = chosen.slice(0, 2).join('、') + (chosen.length > 2 ? ` 等${chosen.length}项` : '');
      return `<div class="field-block complete-field">${caption}<button type="button" class="picker-trigger" data-picker="${index}" ${disabled ? 'disabled' : ''}><span>${esc(short || field.placeholder || '选择名单')}</span><span class="picker-count">${values.length}项</span>${I('ChevronRight')}</button>${!options.length ? '<p class="complete-field-note">名单将在实际运行时读取</p>' : ''}${errorMarkup}</div>`;
    }
    if (field.type === 'select') return `<div class="field-block complete-field">${caption}<select class="panel-input complete-select" id="complete-field-${esc(field.key)}" data-complete-select="${esc(field.key)}" ${disabled ? 'disabled' : ''}>${field.options.map((option, optionIndex) => `<option value="${optionIndex}" ${value === option.value ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select>${errorMarkup}</div>`;
    if (field.type === 'range') return `<fieldset class="field-block complete-field complete-range" ${disabled ? 'disabled' : ''}><legend>${esc(field.label)}${help}</legend><div class="complete-range-inputs"><label><span>最低</span><input class="panel-input" type="number" inputmode="numeric" step="1" min="${field.min ?? 0}" data-complete-range="${esc(field.key)}" data-complete-index="0" value="${esc(value?.[0] ?? '')}" aria-label="${esc(field.label)}最低"></label><span>至</span><label><span>最高</span><input class="panel-input" type="number" inputmode="numeric" step="1" min="${field.min ?? 0}" data-complete-range="${esc(field.key)}" data-complete-index="1" value="${esc(value?.[1] ?? '')}" aria-label="${esc(field.label)}最高"></label></div>${errorMarkup}</fieldset>`;
    if (field.type === 'order') {
      const entries = Array.isArray(value) ? value : [];
      return `<div class="field-block complete-field">${caption}<ol class="complete-order-list">${entries.map((entry, itemIndex) => `<li class="complete-order-row"><span>${esc(entry)}</span><button type="button" class="icon-button" data-complete-order="${esc(field.key)}" data-complete-index="${itemIndex}" data-complete-direction="-1" aria-label="上移${esc(entry)}" ${disabled || itemIndex === 0 ? 'disabled' : ''}>↑</button><button type="button" class="icon-button" data-complete-order="${esc(field.key)}" data-complete-index="${itemIndex}" data-complete-direction="1" aria-label="下移${esc(entry)}" ${disabled || itemIndex === entries.length - 1 ? 'disabled' : ''}>↓</button></li>`).join('')}</ol>${errorMarkup}</div>`;
    }
    return `<div class="field-block complete-field">${caption}<input class="panel-input" id="complete-field-${esc(field.key)}" type="number" inputmode="numeric" step="1" data-panel-input="${esc(field.key)}" value="${esc(value ?? '')}" ${field.min !== undefined ? `min="${field.min}"` : ''} ${field.max !== undefined ? `max="${field.max}"` : ''} ${disabled ? 'disabled' : ''} ${error ? 'aria-invalid="true"' : ''}>${errorMarkup}</div>`;
  }

  function sheet(frame, ctx, content, footer) {
    const { esc, iconButton } = ctx;
    return `<div class="sheet-scrim complete-scrim" data-scrim><section class="bottom-sheet v2-sheet complete-sheet" role="dialog" aria-modal="true" aria-labelledby="panel-title"><div class="sheet-handle"></div><header class="sheet-header"><div><p class="panel-eyebrow">${esc(frame.spec.group || '自动化设置')}</p><h2 id="panel-title">${esc(frame.spec.title)}</h2></div>${iconButton(ctx.state.panels.length > 1 ? 'ArrowLeft' : 'X', ctx.state.panels.length > 1 ? '返回' : '关闭', 'data-action="close-panel"')}</header><div class="panel-scroll complete-panel-scroll">${content}</div><footer class="panel-footer"><div class="panel-actions">${footer || '<button type="button" class="secondary" data-action="close-panel">取消</button><button type="button" class="primary" data-panel-action="apply">完成</button>'}</div><p class="preview-label">原型草稿 · 页面保存后生效</p></footer></section></div>`;
  }

  function rackPanelMarkup(frame, ctx) {
    const { esc, I, toggle } = ctx;
    const spec = frame.spec;
    const key = suffix => `plant.flower_art.${suffix}`;
    if (spec.rackHub) {
      const make = read(frame.values, key('real_flower_art_make'));
      const sell = read(frame.values, key('real_rack_sell'));
      const rewards = ['first_album_claim', 'first_share_claim'].filter(item => read(frame.values, key(item))).length;
      const entries = [
        ['make', '做花艺', '选花艺、设置库存和补货', 'Flower2', make ? '已开启' : '未开启'],
        ['sell', '卖花艺', '摆货顺序、数量与花架管理', 'ShoppingBag', sell ? '已开启' : '未开启'],
        ['rewards', '领取奖励', '首做图鉴、首做分享', 'Gift', rewards ? `已开 ${rewards} 项` : '未开启']
      ];
      return sheet(frame, ctx, `<p class="rack-hub-intro">你想设置哪一部分？</p><div class="rack-hub-list">${entries.map(([page, title, hint, icon, status]) => `<button type="button" class="rack-hub-link" data-panel="${rackPageId(page)}"><span class="feature-icon lilac">${I(icon)}</span><span class="rack-hub-copy"><h3>${title}</h3><p>${hint}</p></span><span class="rack-hub-status">${status}</span>${I('ChevronRight')}</button>`).join('')}</div><p class="rack-summary-note">三个功能分别设置，完成后统一保存。</p>`, '<button type="button" class="secondary" data-action="close-panel">取消</button><button type="button" class="primary" data-panel-action="apply">完成设置</button>');
    }
    if (spec.completeRackRules) {
      const page = specStore[rackPageId(spec.completeRackRules)];
      return sheet(frame, ctx, page.fields.map(field => `<div class="rack-quiet-note"><strong>${esc(field.label)}</strong><p>${esc(field.completeHint)}</p></div>`).join(''), '<button type="button" class="primary" data-action="close-panel">知道了</button>');
    }
    const getField = suffix => spec.fields.find(field => field.key === key(suffix));
    const error = field => frame.errors?.[field.key] ? `<p class="field-error" role="alert">${esc(frame.errors[field.key])}</p>` : '';
    const toggleRow = (suffix, label, hint = '', master = false) => {
      const field = getField(suffix); const disabled = fieldDisabled(field, frame.values);
      return `<div class="rack-form-row ${master ? 'rack-master' : ''} ${disabled ? 'rack-disabled' : ''}"><div class="rack-row-copy"><strong>${label}</strong>${hint ? `<p>${hint}</p>` : ''}</div>${toggle(field.key, label, frame.values, disabled, true)}</div>${error(field)}`;
    };
    const pickerRow = (suffix, label) => {
      const field = getField(suffix); const values = read(frame.values, field.key) || [];
      const chosen = field.options.filter(option => values.includes(option.value));
      const text = chosen.length ? chosen.map(option => option.label).join('、') : '不限花艺';
      return `<button type="button" class="rack-form-row rack-picker ${fieldDisabled(field, frame.values) ? 'rack-disabled' : ''}" data-picker="${spec.fields.indexOf(field)}" ${fieldDisabled(field, frame.values) ? 'disabled' : ''}><span class="rack-row-copy"><strong>${label}</strong><p class="rack-picked-label">${esc(text)}</p></span>${values.length ? `<span class="picker-count">${values.length}种</span>` : ''}${I('ChevronRight')}</button>${error(field)}`;
    };
    const numberRow = (suffix, label, unit, hint = '') => {
      const field = getField(suffix); const disabled = fieldDisabled(field, frame.values);
      return `<div class="rack-form-row ${disabled ? 'rack-disabled' : ''}"><div class="rack-row-copy"><label for="rack-${esc(field.key)}">${label}</label>${hint ? `<p>${hint}</p>` : ''}</div><span class="rack-input-wrap"><input class="rack-number" id="rack-${esc(field.key)}" type="number" inputmode="numeric" step="1" data-panel-input="${esc(field.key)}" value="${esc(read(frame.values, field.key))}" ${field.min !== undefined ? `min="${field.min}"` : ''} ${field.max !== undefined ? `max="${field.max}"` : ''} ${disabled ? 'disabled' : ''} ${frame.errors?.[field.key] ? 'aria-invalid="true"' : ''}><span>${unit}</span></span></div>${error(field)}`;
    };
    const selectRow = () => {
      const field = getField('sort_strategy'); const value = read(frame.values, field.key); const disabled = fieldDisabled(field, frame.values);
      return `<div class="rack-form-row ${disabled ? 'rack-disabled' : ''}"><div class="rack-row-copy"><label for="rack-${esc(field.key)}">优先上架哪种</label></div><select class="rack-select" id="rack-${esc(field.key)}" data-complete-select="${esc(field.key)}" ${disabled ? 'disabled' : ''}>${field.options.map((option, index) => `<option value="${index}" ${option.value === value ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select></div>${error(field)}`;
    };
    let body;
    if (spec.rackPage === 'make') body = `<p class="rack-lead">先选花艺，再决定是否日常补货。</p><section class="rack-form-card">${toggleRow('real_flower_art_make', '自动制作花艺', '', true)}</section><section class="rack-form-card">${pickerRow('specified_arts', '要做哪些花艺')}${toggleRow('auto_replenish', '自动补货', '库存不足时，补到下面的数量')}${numberRow('make_batch', '每种目标库存', '件')}</section>`;
    if (spec.rackPage === 'sell') body = `<p class="rack-lead">从已有成品中，按你的规则摆货。</p><section class="rack-form-card">${toggleRow('real_rack_sell', '自动上架', '', true)}</section><section class="rack-form-card">${pickerRow('rack_specified_arts', '要卖哪些花艺')}${selectRow()}${numberRow('put_count', '每个架位摆几件', '件')}</section><p class="rack-small-heading">未售处理</p><section class="rack-form-card">${toggleRow('rack_auto_take_down', '超时自动下架')}${read(frame.values, key('rack_auto_take_down')) || frame.errors?.[key('rack_take_down_minutes')] ? numberRow('rack_take_down_minutes', '上架多久后下架', '分钟') : ''}</section><p class="rack-small-heading">花架扩展</p><section class="rack-form-card">${toggleRow('real_rack_unlock', '金币解锁花架')}${read(frame.values, key('real_rack_unlock')) || frame.errors?.[key('rack_unlock_keep_gold')] ? numberRow('rack_unlock_keep_gold', '解锁后保留金币', '金币', '0 表示不设保留线') : ''}</section>`;
    if (spec.rackPage === 'rewards') body = `<p class="rack-lead">首做奖励分别领取。</p>${!read(frame.values, key('real_flower_art_make')) ? '<p class="rack-reward-note">先在「做花艺」中开启自动制作，即可设置奖励。</p>' : ''}<section class="rack-form-card">${toggleRow('first_album_claim', '领取图鉴奖励', '首次制作后领取花艺经验')}${toggleRow('first_share_claim', '领取分享奖励', '按游戏当前资格领取')}</section>`;
    return sheet(frame, ctx, `<div class="rack-editor">${body}<button type="button" class="advanced-link" data-complete-action="rack-rules">查看${spec.rackPage === 'make' ? '制作' : spec.rackPage === 'sell' ? '摆货' : '领奖'}规则 ${I('CircleHelp')}</button></div>`);
  }

  function panelMarkup(frame, ctx) {
    if (frame.picker || !frame.spec.complete) return null;
    const { esc, I } = ctx;
    const spec = frame.spec;
    if (spec.rackHub || spec.rackPage || spec.completeRackRules) return rackPanelMarkup(frame, ctx);
    if (spec.completeCategories) return sheet(frame, ctx, `<div class="complete-category-grid">${views.map(view => `<button type="button" class="panel-link" data-complete-action="category" data-complete-view="${view}"><span>${esc(data.groups.find(group => group.id === groupForView[view])?.label)}</span>${I('ChevronRight')}</button>`).join('')}</div>`, '<button type="button" class="primary" data-action="close-panel">返回设置</button>');
    if (spec.completeHelp) return sheet(frame, ctx, `<p class="complete-help-text">${esc(spec.completeHelp)}</p>`, '<button type="button" class="primary" data-action="close-panel">知道了</button>');
    if (spec.completeTool) return toolMarkup(frame, ctx);
    const groups = new Map();
    spec.fields.forEach((field, index) => { const name = field.completeSection || '基本设置'; if (!groups.has(name)) groups.set(name, []); groups.get(name).push([field, index]); });
    const order = presentation.sectionOrder?.[spec.sourceOwnerId] || [...groups.keys()];
    const names = [...order.filter(name => groups.has(name)), ...[...groups.keys()].filter(name => !order.includes(name))];
    const hasSections = names.length > 1 || spec.sourceOwnerId === 'rack-sell';
    frame.openSections ||= names.slice(0, 1);
    const body = names.map((name, groupIndex) => {
      const fields = groups.get(name).map(([field, index]) => fieldMarkup(field, index, frame, ctx)).join('');
      const expanded = frame.openSections.includes(name) || groups.get(name).some(([field]) => frame.errors?.[field.key]);
      return hasSections ? `<details class="complete-section" data-complete-section="${esc(name)}" ${expanded ? 'open' : ''}><summary>${esc(name)}<span>${groups.get(name).length}项</span></summary><div class="complete-section-fields">${fields}</div></details>` : fields;
    }).join('');
    const state = spec.primaryKey ? `<div class="complete-function-state"><span>当前功能</span><strong>${read(frame.values, spec.primaryKey) ? '已开启' : '已关闭'}</strong></div>` : '';
    const empty = !spec.fields.length ? `<p class="complete-help-text">${esc(presentation.fields[spec.primaryKey]?.hint || spec.subtitle)}</p>` : '';
    const notes = spec.completeOwnerId === 'account-rhythm' ? `<details class="complete-section complete-rules"><summary>运行说明${I('CircleHelp')}</summary>${Object.values(presentation.readOnlyNotes || {}).map(note => `<p class="complete-help-text"><strong>${esc(note.label)}</strong> · ${esc(note.text)}</p>`).join('')}</details>` : '';
    return sheet(frame, ctx, `${state}${frame.error ? `<p class="field-error" role="alert">${esc(frame.error)}</p>` : ''}${body}${empty}${notes}`);
  }

  function toolMarkup(frame, ctx) {
    const { esc, I, state } = ctx;
    const tool = frame.spec.completeTool;
    const finish = '<button type="button" class="secondary" data-action="close-panel">返回</button>';
    if (tool === 'tools') return sheet(frame, ctx, [['complete-copy', '复制其他号设置', '选择来源，预览差异后套用'], ['complete-share', '分享当前设置', '生成当前设置的原型分享码'], ['complete-import', '使用分享码', '读取分享设置，预览后套用']].map(([id, title, hint]) => `<button type="button" class="panel-link" data-panel="${id}"><span>${title}<small>${hint}</small></span>${I('ChevronRight')}</button>`).join(''), finish);
    if (tool === 'share') {
      const records = [...shareRecords.values()];
      const list = records.map(record => `<div class="complete-share-row"><span>${esc(record.label || '未命名分享')}<small>${esc(record.code.slice(0, 12))}····</small></span><button type="button" class="advanced-link" data-complete-action="revoke-share" data-complete-code="${esc(record.code)}" ${record.active ? '' : 'disabled'}>${record.active ? '作废' : '已作废'}</button></div>`).join('');
      return sheet(frame, ctx, `<div class="field-block"><label class="field-caption" for="complete-share-label">分享名称</label><input class="panel-input" id="complete-share-label" data-panel-input="shareLabel" maxlength="40" value="${esc(frame.values.shareLabel)}" placeholder="可选，最多40字"></div>${frame.generatedCode ? `<div class="panel-note"><strong>本次分享码</strong><p class="complete-share-code">${esc(frame.generatedCode)}</p></div>` : ''}<p class="complete-field-note">分享码仅在本次原型页面内有效，刷新后清空。</p>${list}`, `${finish}<button type="button" class="primary" data-complete-action="create-share">生成分享码</button>`);
    }
    const others = state.accounts.filter(name => name !== state.account);
    const source = tool === 'copy' ? `<div class="field-block"><label class="field-caption" for="complete-copy-source">从哪个游戏号复制</label><select class="panel-input" id="complete-copy-source" data-complete-tool-select="sourceAccount"><option value="">选择来源游戏号</option>${others.map(name => `<option value="${esc(name)}" ${frame.values.sourceAccount === name ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select></div>` : `<div class="field-block"><label class="field-caption" for="complete-import-code">分享码</label><input class="panel-input" id="complete-import-code" data-complete-transfer-input="shareCode" value="${esc(frame.values.shareCode)}" placeholder="输入此页面生成的原型分享码"></div>`;
    const keep = `<label class="complete-check"><input type="checkbox" data-complete-keep-cadence ${frame.values.keepCadence ? 'checked' : ''}>保留本号运行节奏</label>`;
    const preview = frame.transferPreview ? `<div class="complete-transfer-preview"><h3>将更新${frame.transferPreview.length}项设置</h3><p class="complete-field-note">目标游戏号：${esc(state.account)}</p>${frame.transferPreview.slice(0, 6).map(key => `<p>${esc(presentation.fields[key].label)}</p>`).join('')}${frame.transferPreview.length > 6 ? '<p>其余修改将一并写入本号草稿。</p>' : ''}</div>` : '';
    return sheet(frame, ctx, `${source}${keep}${frame.error ? `<p class="field-error">${esc(frame.error)}</p>` : ''}${preview}`, `${finish}<button type="button" class="${frame.transferCandidate ? 'secondary' : 'primary'}" data-complete-action="preview-transfer">预览差异</button>${frame.transferCandidate ? '<button type="button" class="primary" data-complete-action="apply-transfer">确认套用</button>' : ''}`);
  }

  function validate(config) {
    const errors = [];
    sourceFields.forEach(field => {
      const value = read(config, field.key); const label = presentation.fields[field.key].label;
      const fail = message => errors.push({ key: field.key, message, panelId: fieldOwners.get(field.key)?.panelId });
      if (field.type === 'switch' && typeof value !== 'boolean') fail(`${label}请选择开启或关闭`);
      if (field.type === 'number') {
        const min = field.min ?? field.metadata?.min, max = field.max ?? field.metadata?.max;
        if (typeof value !== 'number' || !Number.isInteger(value)) fail(`${label}请填写整数`);
        else if (min !== undefined && value < min) fail(`${label}不能低于${min}`);
        else if (max !== undefined && value > max) fail(`${label}不能高于${max}`);
      }
      if (field.type === 'range' && (!Array.isArray(value) || value.length !== 2 || value.some(number => !Number.isInteger(number) || number < 0) || value[0] > value[1])) fail(`${label}请填写从低到高的整数范围`);
      if (['multiselect', 'order'].includes(field.type) && !Array.isArray(value)) fail(`${label}请选择有效名单`);
      if (field.key === 'guild.guild_share.take_member_targets' && (!Array.isArray(value) || value.some(uid => !Number.isSafeInteger(uid) || uid <= 0))) fail(`${label}请填写正整数 UID，多个用逗号或换行分隔`);
      const options = optionsFor(field);
      if (field.type === 'select' && options.length && !options.some(option => option.value === value)) fail(`${label}请选择有效选项`);
      if (field.type === 'switch' && value === true && (field.dependsOn || []).some(rule => rule.kind === 'exclusiveWith' && read(config, rule.key) === true)) fail(`${label}与另一项互斥，请保留一项`);
    });
    return { valid: errors.length === 0, errors };
  }

  function bind(nextBridge) {
    bridge = nextBridge; if (bound) return; bound = true;
    document.addEventListener('toggle', event => {
      const details = event.target; const frame = bridge.current();
      if (!details.matches?.('[data-complete-section]') || !frame || !details.isConnected) return;
      const name = details.dataset.completeSection;
      frame.openSections = [...new Set([...(frame.openSections || []).filter(item => item !== name), ...(details.open ? [name] : [])])];
    }, true);
    document.addEventListener('change', event => {
      const input = event.target;
      if (input.matches('[data-complete-select]')) {
        event.stopPropagation(); const field = bridge.current()?.spec.fields.find(item => item.key === input.dataset.completeSelect);
        if (field) { bridge.setField(field.key, clone(field.options[Number(input.value)].value)); bridge.render(true); }
      }
      if (input.matches('[data-complete-tool-select]')) { event.stopPropagation(); bridge.setField(input.dataset.completeToolSelect, input.value); delete bridge.current().transferCandidate; delete bridge.current().transferPreview; bridge.render(true); }
      if (input.matches('[data-complete-keep-cadence]')) { event.stopPropagation(); bridge.setField('keepCadence', input.checked); delete bridge.current().transferCandidate; delete bridge.current().transferPreview; bridge.render(true); }
    }, true);
    document.addEventListener('input', event => {
      const input = event.target;
      if (input.matches('[data-complete-transfer-input]')) { event.stopPropagation(); bridge.setField(input.dataset.completeTransferInput, input.value); delete bridge.current().transferCandidate; delete bridge.current().transferPreview; const dialog = input.closest('[role="dialog"]'); dialog.querySelector('.complete-transfer-preview')?.remove(); dialog.querySelector('[data-complete-action="apply-transfer"]')?.remove(); dialog.querySelector('[data-complete-action="preview-transfer"]')?.classList.replace('secondary', 'primary'); return; }
      if (input.matches('[data-complete-members]')) { event.stopPropagation(); const raw = input.value.trim(); const values = raw ? raw.split(/[,，;；\s]+/).map(Number) : []; bridge.setField(input.dataset.completeMembers, values.every(uid => Number.isSafeInteger(uid) && uid > 0) ? [...new Set(values)] : raw); return; }
      if (!input.matches('[data-complete-range]')) return;
      event.stopPropagation(); const value = clone(read(bridge.current().values, input.dataset.completeRange) || ['', '']); value[Number(input.dataset.completeIndex)] = input.value === '' ? '' : Number(input.value); bridge.setField(input.dataset.completeRange, value);
    }, true);
    document.addEventListener('click', event => {
      const button = event.target.closest('[data-complete-action],[data-complete-help],[data-complete-order]'); if (!button || button.disabled) return;
      event.preventDefault(); event.stopPropagation();
      const frame = bridge.current();
      if (button.dataset.completeHelp) {
        const text = presentation.fields[button.dataset.completeHelp]; specStore['complete-field-help'] = { complete: true, completeHelp: text.hint, title: text.label, group: '设置说明', fields: [], hidden: true }; bridge.openPanel('complete-field-help'); return;
      }
      if (button.dataset.completeOrder) {
        const key = button.dataset.completeOrder, list = clone(read(frame.values, key)); const index = Number(button.dataset.completeIndex), next = index + Number(button.dataset.completeDirection);
        if (next >= 0 && next < list.length) { [list[index], list[next]] = [list[next], list[index]]; bridge.setField(key, list); bridge.render(true); } return;
      }
      const action = button.dataset.completeAction;
      if (action === 'rack-rules') { specStore['complete-rack-rules'] = { complete: true, completeRackRules: frame.spec.rackPage, title: '规则说明', group: frame.spec.title, fields: [], hidden: true }; bridge.openPanel('complete-rack-rules'); return; }
      if (action === 'categories') { bridge.openPanel('complete-categories'); return; }
      if (action === 'category') { bridge.go(button.dataset.completeView); return; }
      if (action === 'create-share') {
        const code = `WJX-DESIGN-${String(++shareSequence).padStart(4, '0')}`; shareRecords.set(code, { code, label: frame.values.shareLabel?.trim().slice(0, 40), config: clone(bridge.cfg()), active: true }); frame.generatedCode = code; bridge.render(true); return;
      }
      if (action === 'revoke-share') { const record = shareRecords.get(button.dataset.completeCode); if (record) record.active = false; if (frame.generatedCode === record?.code) delete frame.generatedCode; bridge.render(true); return; }
      if (action === 'preview-transfer') {
        const source = frame.spec.completeTool === 'copy' ? bridge.state.saved[frame.values.sourceAccount] : (() => { const record = shareRecords.get(String(frame.values.shareCode || '').replace(/\s/g, '')); return record?.active ? record.config : null; })();
        if (!source) { frame.error = frame.spec.completeTool === 'copy' ? '请先选择来源游戏号。' : '分享码不存在、已作废或不属于本次原型页面。'; bridge.render(true); return; }
        const candidate = clone(source);
        if (frame.values.keepCadence) data.groups.find(group => group.id === 'cadence').items.filter(item => item.type !== 'note').forEach(item => write(candidate, item.key, clone(read(bridge.cfg(), item.key))));
        frame.transferCandidate = candidate; frame.transferPreview = sourceFields.filter(field => JSON.stringify(read(candidate, field.key)) !== JSON.stringify(read(bridge.cfg(), field.key))).map(field => field.key); delete frame.error; bridge.render(true); return;
      }
      if (action === 'apply-transfer' && frame.transferCandidate) { bridge.state.configs[bridge.state.account] = clone(frame.transferCandidate); bridge.closePanel(); bridge.toast('已套用到当前游戏号草稿，保存后生效。'); }
    }, true);
  }

  function coverage() {
    const byKey = Object.fromEntries(fieldOwners);
    return { groups: data?.groups.length || 0, businessOwners: [...ownerSpecs.keys()].filter(id => !id.startsWith('account-')).length, cadenceCards: presentation?.cadenceCards.length || 0, editableFields: sourceFields.length, uniqueEditors: fieldOwners.size, homeEditors: [...fieldOwners.values()].filter(owner => owner.location === 'home').length, detailEditors: [...fieldOwners.values()].filter(owner => owner.location === 'detail').length, missing: sourceFields.filter(field => !fieldOwners.has(field.key)).map(field => field.key), byKey, panelIds: [...ownerSpecs.keys()].map(panelId) };
  }
  window.CompleteSettings = { views, prepare, header, render, panelMarkup, fieldMarkup, bind, validate, coverage };
})();
