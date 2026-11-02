/* All interaction is presentation-only. No API, engine, storage or device calls. */
"use strict";
(() => {
  const stage = document.getElementById('stage');
  const params = new URLSearchParams(location.search);
  window.CompleteSettings.prepare(window.GARDEN_PANEL_SPECS,window.GARDEN_DESIGN_CATALOGS,window.GARDEN_DESIGN_DEFAULTS);
  const specs = window.GARDEN_PANEL_SPECS || {};
  const catalogs = window.GARDEN_DESIGN_CATALOGS || {};
  const defaults = window.GARDEN_DESIGN_DEFAULTS || {};
  const clone = value => JSON.parse(JSON.stringify(value));
  const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const gardenArt = area => {
    const direction=window.GardenDesignIdentity?.directions[window.GardenDesignIdentity.selected()];
    return (area==='accounts'&&direction?.accountArt)||direction?.art||'assets/garden-dawn.png';
  };
  const I = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${(window.PROTOTYPE_ICONS || {})[name] || ''}</svg>`;
  const get = (object, path) => String(path || '').split('.').reduce((value, key) => value?.[key], object);
  function set(object, path, value) {
    const keys = path.split('.'); const last = keys.pop();
    const target = keys.reduce((node, key) => node[key] ||= {}, object);
    target[last] = value;
  }
  const names = ['我的花园', '向晚花园', '晴天花园'];
  const views = ['login','accounts','logs','me',...window.CompleteSettings.views];
  const state = { view: views.includes(params.get('view')) ? params.get('view') : 'land', account: '我的花园', accounts: [...names], running: new Set(), filter: 'all', pageState: params.get('state') || 'normal', configs: {}, saved: {}, panels: [], category: '全部', logDay: '全部日期', logScope: '当前游戏号', logPage: 1, search: '', passwordVisible: false };
  names.forEach(name => { state.configs[name] = clone(defaults); state.saved[name] = clone(defaults); });
  const cfg = () => state.configs[state.account];
  const dirty = () => JSON.stringify(cfg()) !== JSON.stringify(state.saved[state.account]);
  const current = () => state.panels[state.panels.length - 1];
  let toastTimer;
  let previousFocus;
  const orderInfo = [['resident','居民订单','House',''],['satin','绸缎订单','Spool','lilac'],['decorate','建材订单','Blocks','gold'],['customer','顾客订单','ShoppingBag',''],['palace','宫廷订单','Crown','gold'],['team','组团订单','UsersRound','blue']];
  const iconButton = (name, label, attributes = '', extra = '') => `<button type="button" class="icon-button ${extra}" aria-label="${esc(label)}" ${attributes}>${I(name)}</button>`;
  const avatar = (name = state.account) => `<span class="avatar ${name === '向晚花园' ? 'lilac' : name === '晴天花园' ? 'blue' : ''}">${esc(name.slice(0,1))}</span>`;
  const statusBar = () => `<div class="status-bar"><span>09:41</span><span class="system-icons">${I('Signal')}${I('Wifi')}${I('BatteryFull')}</span></div>`;
  const gesture = () => '<div class="gesture" aria-hidden="true"></div>';
  const nav = active => `<nav class="bottom-nav" aria-label="主导航">${[['accounts','Sprout','游戏号'],['land','SlidersHorizontal','设置'],['logs','ScrollText','日志'],['me','UserRound','我的']].map(([view, icon, label]) => `<button type="button" data-view="${view}" class="${view === active ? 'active' : ''}" ${view === active ? 'aria-current="page"' : ''}><span class="nav-icon">${I(icon)}</span>${label}</button>`).join('')}</nav>${gesture()}`;
  const title = (name, panel = 'app-help', icon = 'CircleHelp') => `<header class="top-title"><h1>${name}</h1>${iconButton(icon,'查看详情',`data-panel="${panel}"`)}</header>`;
  const accountPicker = (compact = false) => compact
    ? `<button type="button" class="compact-account" data-action="choose-account" aria-label="选择当前游戏号">${avatar()}<span>${esc(state.account)}</span>${I('ChevronDown')}</button>`
    : `<button type="button" class="account-choice" data-action="choose-account"><span class="choice-person">${avatar()}<span>${esc(state.account)}<span class="choice-meta">${state.logScope === '本机全部记录' && state.view === 'logs' ? '本机全部记录' : '当前游戏号 · 仅对本账号生效'}</span></span></span>${I('ChevronsUpDown')}</button>`;
  const settingsHeader = tab => window.CompleteSettings.header(tab,{I,esc,accountPicker,iconButton});
  const section = (name, note='') => `<div class="section-label"><h2>${name}</h2><span>${note}</span></div>`;
  const toggle = (key, label, values=cfg(), disabled=false, field=false) => `<button type="button" class="toggle" role="switch" aria-label="${esc(label)}" aria-checked="${get(values,key) === true}" ${field ? 'data-panel-toggle' : 'data-toggle'}="${esc(key)}" ${disabled ? 'disabled' : ''}><span class="toggle-track"></span></button>`;
  const feature = (key,name,desc,icon,tone,panel) => `<div class="feature-row"><button type="button" class="clickable-feature" data-panel="${panel}"><span class="feature-icon ${tone || ''}">${I(icon)}</span><span class="feature-copy"><h2>${name}</h2><p>${desc}</p></span>${I('ChevronRight').replace('class="icon"','class="icon chevron"')}</button>${toggle(key,name,cfg(),['art.firstAlbumClaim','art.firstShareClaim'].includes(key)&&!get(cfg(),'art.makeEnabled'))}</div>`;
  const summary = (label,value,panel) => `<button type="button" class="summary-row" data-panel="${panel}"><span>${label}</span><span>${esc(value)}${I('ChevronRight')}</span></button>`;
  const saveDock = () => `<footer class="save-dock"><div class="save-row"><button type="button" class="primary" data-action="save-config">${I('Check')}${dirty() ? '保存设置' : '设置已保存'}</button><button type="button" class="secondary" data-action="${state.running.has(state.account) ? 'stop-account' : 'start-account'}">${state.running.has(state.account) ? '停止' : '开始'}</button></div><p>保存仅对当前游戏号生效；不会自动开始运行</p></footer>`;
  function pageStateMarkup(area) {
    const value = state.pageState;
    if (value === 'loading') return `<div class="page-empty">${I('LoaderCircle')}<h2>正在读取${area}</h2><p>读取完成前，已有设置与任务意图会保留。</p></div><div class="skeleton"></div><div class="skeleton"></div>`;
    if (value === 'error') return `<div class="page-empty">${I('CloudOff')}<h2>${area}暂时没读到</h2><p>没有把读取失败当作空数据。重新连接后再读取当前状态。</p><button type="button" class="primary" data-action="retry-state">重新读取</button><button type="button" class="advanced-link" data-panel="connection-help">查看连接说明</button></div>`;
    if (value === 'empty') return `<div class="page-empty">${I(area === '日志' ? 'ScrollText' : 'Sprout')}<h2>${area === '日志' ? '这组筛选暂无记录' : '这里还没有游戏号'}</h2><p>${area === '日志' ? '换个分类或日期，也可以清除筛选查看全部。' : '添加你有权使用的游戏号，设置好功能后再开始。'}</p><button type="button" class="primary" ${area === '日志' ? 'data-action="clear-log-filters"' : 'data-panel="add-account"'}>${area === '日志' ? '清除筛选' : '添加游戏号'}</button></div>`;
    return '';
  }
  function login() {
    return `<div class="phone login-phone">${statusBar()}<header class="login-brand"><span class="brand-symbol"><img src="assets/logo-endless-summer.webp" alt="无尽夏原图标"></span><div><h1>无尽夏</h1><p>ENDLESS SUMMER</p></div></header><div class="login-art"><img src="assets/logo-endless-summer.webp" alt="无尽夏：蓝紫绣球原图标"></div><div class="login-content"><h2>花开无尽夏</h2><p class="intro">雨落有晴天</p><div class="login-field">${I('UserRound')}<label><span>软件账号</span><input id="preview-login-user" type="text" placeholder="输入示意账号" aria-label="软件账号" autocomplete="off" maxlength="32"></label></div><div class="login-field">${I('LockKeyhole')}<label><span>登录密码</span><input id="preview-login-password" type="password" placeholder="原型请勿输入真实密码" aria-label="登录密码" autocomplete="off" maxlength="64"></label>${iconButton('Eye','显示或隐藏密码','data-action="reveal-login"')}</div><p class="auth-error" role="alert" hidden></p><button type="button" class="primary" data-action="login-preview">登录，回到花园 ${I('ArrowRight')}</button><p class="login-extra">还没有账号？<button type="button" data-panel="register">立即注册</button></p><button type="button" class="auth-help-link" data-panel="auth-help">登录遇到问题？</button></div><div class="login-bottom">${I('Leaf')}本机执行 · 随时可停</div>${gesture()}</div>`;
  }
  function accounts() {
    const filtered = state.accounts.filter(name => state.filter === 'running' ? state.running.has(name) : state.filter === 'stopped' ? !state.running.has(name) : true);
    return `<div class="phone">${statusBar()}<header class="app-toolbar"><div class="wordmark"><span class="brand-symbol"><img src="assets/logo-endless-summer.webp" alt="无尽夏原图标"></span>无尽夏</div><button type="button" class="toolbar-status" data-panel="service"><i class="dot"></i>本机运行 ${I('ChevronRight')}</button></header><div class="scroll-area"><div class="page-heading"><div><h1>我的游戏号</h1><p>你的每一座小花园，都在这里。</p></div>${iconButton('Plus','添加游戏号','data-panel="add-account"','add')}</div>${state.pageState !== 'normal' ? pageStateMarkup('游戏号') : `<section class="garden-banner"><p class="eyebrow">A LITTLE CARE, EVERY DAY</p><h2>花开无尽夏</h2><p class="banner-slogan">雨落有晴天</p><p class="banner-sub">${state.running.size} 个运行中 &nbsp;·&nbsp; ${state.accounts.length-state.running.size} 个已停止</p><img src="${gardenArt('accounts')}" alt=""></section><div class="filters">${[['all','全部'],['running','运行中'],['stopped','已停止']].map(([key,label])=>`<button type="button" data-filter="${key}" class="${state.filter===key?'active':''}">${label}<span>${key==='all'?state.accounts.length:key==='running'?state.running.size:state.accounts.length-state.running.size}</span></button>`).join('')}</div>${filtered.length ? filtered.map(name => `<article class="account-card ${state.running.has(name)?'running-card':''}"><div class="account-top">${avatar(name)}<div class="account-identity"><h2>${esc(name)}</h2><p>游戏账号 · 手机本地执行</p></div><span class="badge ${state.running.has(name)?'green':''}">${state.running.has(name)?'<i class="dot"></i>运行中':'已停止'}</span><button type="button" class="account-more" aria-label="${esc(name)}更多操作" data-panel="account-more" data-account="${esc(name)}">${I('Ellipsis')}</button></div><p class="account-summary">${I(state.running.has(name)?'Leaf':'Moon')}${state.running.has(name)?'按当前账号设置照料花园':'已停止，等你重新安排'}</p><div class="account-actions"><button type="button" data-view="land" data-account="${esc(name)}">${I('SlidersHorizontal')}设置</button><button type="button" data-view="logs" data-account="${esc(name)}">${I('ScrollText')}日志</button><button type="button" class="primary-small ${state.running.has(name)?'stop-small':''}" data-action="${state.running.has(name)?'stop-account':'start-account'}" data-account="${esc(name)}">${I(state.running.has(name)?'Square':'Play')}${state.running.has(name)?'停止':'开始'}</button></div></article>`).join(''):'<div class="page-empty"><h2>暂无这类游戏号</h2><p>可以切回全部查看。</p></div>'}`}</div>${nav('accounts')}</div>`;
  }
  function land() {
    const c=cfg();
    const modes={least_stock:'库存最少',chosen_flowers:'指定花朵',chosen_quality:'指定品质',chosen_top:'置顶花朵'};
    return `<div class="phone">${statusBar()}${settingsHeader('land')}<div class="scroll-area settings-content">${state.pageState!=='normal'?pageStateMarkup('设置'): `${section('花园日常','点开卡片查看全部设置')}<section class="setting-card">${feature('plantEnabled','自动种花','模式、花种、分组与库存目标','Sprout','','plant-detail')}${summary('种植模式',modes[c.plantMode] || '库存最少','plant-mode')}${summary('每组地块',`${c.groupSize ?? 8} 块`,'plant-detail')}${summary('更多种植设置','品质 / 黑名单 / 数量','plant-detail')}</section><section class="setting-card">${feature('waterEnabled','自动浇水',`保留 ${c.keepWater ?? 0} 滴，低于余量暂不浇水`,'Droplets','blue','water-detail')}</section><section class="setting-card">${feature('harvestEnabled','自动收花','同组全部成熟后，再一起收获','Flower2','lilac','harvest-detail')}</section><button type="button" class="advanced-link" data-panel="settings-help">设置与运行规则 ${I('CircleHelp')}</button>`}</div>${saveDock()}${nav('land')}</div>`;
  }
  function orders() {
    return `<div class="phone">${statusBar()}${settingsHeader('orders')}<div class="scroll-area settings-content">${state.pageState!=='normal'?pageStateMarkup('设置'):`${section('订单自动化','点开各卡查看独立参数')}<section class="setting-card orders-card">${orderInfo.map(([key,name,icon,tone])=>`<div class="order-row"><button type="button" class="order-card-link" data-panel="order-${key}"><span class="feature-icon ${tone}">${I(icon)}</span><span class="feature-copy"><h2>${name}</h2><p>${['resident','satin','decorate'].includes(key)?`每日 ${get(cfg(),`orders.${key}.dailyLimit`) || '不限'} 单 · 视频随本卡启停`:key==='customer'?'档位筛选 · 自动拒单':key==='palace'?'禁交品质筛选':'真实团单 · 免费接单 · 元宝留量'}</p></span>${I('ChevronRight')}</button>${toggle(`orders.${key}.enabled`,name)}</div>`).join('')}<p class="video-hint">${I('Video')}居民、绸缎、建材视频单随所属总开关启停</p></section>${section('每日的小收获','独立开关 · 默认关闭')}<section class="setting-card reward-card">${feature('dailyTaskRewards.enabled','日常任务奖励','已达标才领取，不代做底层任务','Gift','gold','daily-rewards')}</section><p class="reward-footnote">不含活跃度宝箱、周常和其他奖励。</p>`}</div>${saveDock()}${nav('land')}</div>`;
  }
  function art() {
    return `<div class="phone">${statusBar()}${settingsHeader('art')}<div class="scroll-area settings-content">${state.pageState!=='normal'?pageStateMarkup('设置'):`<section class="art-cover"><p>FLOWERS, MADE WITH CARE</p><h2>把花朵，变成心意。</h2><div class="tiny-steps">顾客缺货 ${I('ArrowRight')}制作花艺 ${I('ArrowRight')}确认后交付</div><img src="${gardenArt()}" alt=""></section><section class="setting-card">${feature('art.makeEnabled','自动制作花艺','指定成品、目标库存、自动补货','Flower','lilac','art-detail')}${summary('指定花艺',`${get(cfg(),'art.specifiedArts')?.length || 0} 件已选`,'art-picker')}${summary('成品目标库存',`${get(cfg(),'art.makeBatch') ?? 1} 件`,'art-detail')}</section>${section('首做奖励','各自独立开关')}<section class="setting-card art-reward">${feature('art.firstAlbumClaim','首做图鉴奖励','按花瓶领取金币奖，避免重复','BookOpen','gold','art-album')}${feature('art.firstShareClaim','首做分享奖励','独立开关，不跟订单视频联动','Sparkles','lilac','art-share')}</section><button type="button" class="advanced-link" data-panel="art-dependency">花艺与顾客订单如何配合 ${I('ChevronRight')}</button>`}</div>${saveDock()}${nav('land')}</div>`;
  }
  const logEvents = [
    ['09:41','收花','一组花，收好了','同组花卉均已成熟，已完成本组收获。','完成',''],
    ['09:40','浇水','补一点水，继续生长','已完成浇水，保留设定的水滴余量。','完成',''],
    ['09:38','状态核对','这一步，先等一等','本次必要状态暂未读到，仅等待依赖它的候选。','等待状态','alert'],
    ['09:36','种花','空地迎来了新花','已按当前种植设置完成补种。','完成',''],
    ['09:35','连接','花园已连接','开始按当前账号设置照料花园。','已连接','']
  ];
  function logs() {
    const events=logEvents.filter(one=>state.category==='全部'||one[1]===state.category);
    return `<div class="phone">${statusBar()}${title('运行日志','log-filters','ListFilter')}<div class="scroll-area logs-content">${accountPicker()}<div class="log-filters">${['全部','种花','浇水','收花','更多'].map(cat=>`<button type="button" class="${state.category===cat?'active':''}" ${cat==='更多'?'data-panel="log-filters"':`data-category="${cat}"`}>${cat}</button>`).join('')}</div><div class="log-date"><button type="button" class="log-date-button" data-panel="log-filters">${I('CalendarDays')}${state.logDay==='全部日期'?'全部日期':esc(state.logDay)}${I('ChevronDown')}</button><span>示意记录 · 点击查看详情</span></div>${state.pageState!=='normal'?pageStateMarkup('日志'):events.length?`<div class="timeline">${events.map(([time,cat,name,detail,status,tone],index)=>`<article class="log-event ${tone}"><time class="log-time">${time}</time><div class="timeline-rail" aria-hidden="true"></div><button type="button" class="log-message" data-action="log-detail" data-index="${index}"><header><h2>${name}</h2><span>${status}</span></header><p>${detail}</p></button></article>`).join('')}</div>`:'<div class="page-empty"><h2>该分类暂无示意记录</h2><p>可以清除筛选，查看全部记录。</p><button type="button" class="primary" data-action="clear-log-filters">清除筛选</button></div>'}<div class="logs-pager"><button type="button" data-action="logs-prev" ${state.logPage===1||state.pageState!=='normal'||!events.length?'disabled':''}>上一页</button><span>第 ${state.logPage} 页 · 每页 15 条</span><button type="button" data-action="logs-next" ${state.logPage===2||state.pageState!=='normal'||!events.length?'disabled':''}>下一页</button></div></div>${nav('logs')}</div>`;
  }
  function me() {
    const row=(icon,label,value,panel)=>`<button type="button" class="profile-line" data-panel="${panel}">${I(icon)}${label}<span class="right">${value}${I('ChevronRight')}</span></button>`;
    return `<div class="phone">${statusBar()}${title('我的','app-help','Settings2')}<div class="scroll-area"><button type="button" class="profile-banner" data-panel="software-account"><span class="avatar">园</span><span><h2>我的软件账号</h2><p>软件身份与游戏账号分开管理</p></span>${I('ChevronRight')}</button>${section('软件与授权')}<section class="profile-section">${row('ShieldCheck','软件授权','查看详情','license')}${row('KeyRound','修改密码','','password')}${row('ScrollText','日志同步','查看状态','sync')}</section>${section('本机运行')}<section class="profile-section">${row('Smartphone','运行服务','查看状态','service')}${row('BatteryCharging','后台运行说明','','battery')}${row('Route','网络出口','查看设置','network')}</section><p class="profile-footnote">所有状态为设计示意。<br>账号归属、日志缺口与待核查结果均保留明细入口。</p><button type="button" class="text-exit" data-panel="logout">退出软件账号</button></div>${nav('me')}</div>`;
  }
  const renderers={login,accounts,land,orders,art,logs,me};
  window.CompleteSettings.views.forEach(view=>renderers[view]=()=>window.CompleteSettings.render(view,{I,esc,cfg,get,toggle,statusBar,saveDock,nav,accountPicker,iconButton,section,settingsHeader,state,pageStateMarkup}));
  function condition(rule, values) {
    if (!rule) return true;
    if (typeof rule === 'string') return get(values,rule) === true;
    if (Array.isArray(rule)) return rule.every(one=>condition(one,values));
    const value=get(values,rule.key || rule.path);
    if ('equals' in rule) return value===rule.equals;
    if ('value' in rule) return Array.isArray(rule.value)?rule.value.includes(value):value===rule.value;
    if ('not' in rule) return value!==rule.not;
    return Boolean(value);
  }
  const fieldOptions = field => (field.options || catalogs[field.catalog] || []).map(one=>typeof one==='string'?{value:one,label:one}:one);
  function fieldMarkup(field,index,frame) {
    const custom=window.CompleteSettings.fieldMarkup(field,index,frame,{I,esc,cfg,get,toggle,iconButton,state});if(custom!==null)return custom;
    const values=frame.values;
    if (!condition(field.showWhen,values)) return '';
    const key=field.key || `display-${index}`;
    const value=field.key?get(values,key):(field.value ?? '');
    const disabled=field.disabled || !condition(field.enableWhen,values);
    const description=field.description || field.help || '';
    const help=description?`<p class="field-description">${esc(description)}</p>`:'';
    const label=esc(field.label || '');
    const err=frame.errors?.[key];
    const cap=`<div class="field-caption"><label for="field-${esc(key)}">${label}${field.required?'<span class="required-mark">必填</span>':''}</label>${field.help?`<button type="button" class="field-help-button" data-help="${index}" aria-label="${label}说明">${I('CircleHelp')}</button>`:''}</div>`;
    if(field.type==='divider'||field.type==='heading')return `<h3 class="panel-heading">${I(field.icon||'Leaf')}${label}</h3>`;
    if(field.type==='note')return `<div class="panel-note ${esc(field.tone||'')}">${label?`<strong>${label}</strong>`:''}${esc(description || field.value || '')}</div>`;
    if(field.type==='status')return `<section class="panel-status ${esc(field.tone||'')}">${I(field.icon || (field.tone==='danger'?'CircleAlert':field.tone==='warning'?'Clock3':field.tone==='loading'?'LoaderCircle':'CircleCheck'))}<div>${field.value?`<p class="panel-eyebrow">${label}</p>`:''}<h3>${esc(field.value || field.label || '')}</h3>${description?`<p>${esc(description)}</p>`:''}</div></section>`;
    if(field.type==='list')return `${label?`<h3 class="panel-heading">${label}</h3>`:''}<dl class="panel-kv">${(field.items || field.rows || []).map(one=>typeof one==='string'?`<div><dt>${esc(one)}</dt><dd></dd></div>`:`<div><dt>${esc(one.label || one.name || '')}</dt><dd>${esc(resolveText(one.value ?? one.description ?? ''))}</dd></div>`).join('')}</dl>${help}`;
    if(field.type==='action')return `<button type="button" class="panel-link" ${disabled?'disabled':''} ${field.target?`data-panel="${esc(field.target)}"`:`data-panel-action="${esc(field.action||'close')}"`}>${field.icon?I(field.icon):''}<span>${label}${description?`<small>${esc(description)}</small>`:''}</span>${I('ChevronRight')}</button>`;
    if(field.type==='toggle')return `<div class="panel-toggle ${disabled?'disabled':''}"><div class="field-copy"><h3>${label}</h3>${description?`<p>${esc(description)}</p>`:''}</div>${toggle(key,field.label,values,disabled,true)}</div>`;
    if(field.type==='picker') {
      const options=fieldOptions(field);const list=Array.isArray(value)?value:[];
      const chosen=options.filter(one=>list.includes(one.value)).map(one=>field.catalog==='arts'?`${one.label}（${one.description}）`:one.label);
      return `<div class="field-block">${cap}<button type="button" class="picker-trigger" data-picker="${index}" ${disabled?'disabled':''}><span>${field.placeholder||'点击选择'}</span><span class="picker-count">已选 ${list.length} 项</span>${I('ChevronRight')}</button>${chosen.length?`<p class="selected-values">${chosen.map(esc).join(' · ')}</p>`:''}${help}${err?`<p class="field-error">${esc(err)}</p>`:''}</div>`;
    }
    if(field.type==='select'||field.type==='chips'||field.type==='radio') {
      const multi=(field.type==='chips'&&Array.isArray(value))||field.multiple===true;
      const list=Array.isArray(value)?value:[];
      return `<fieldset class="field-block panel-fieldset" ${disabled?'disabled':''}><legend class="field-caption"><strong>${label}</strong></legend><div class="${field.type==='chips'?'panel-choices':'option-list'}">${fieldOptions(field).map((one,i)=>`<label class="panel-choice"><input type="${multi?'checkbox':'radio'}" name="${esc(key)}" data-panel-choice="${esc(key)}" data-option-index="${i}" data-field-index="${index}" ${multi?list.includes(one.value)?'checked':'':value===one.value?'checked':''}><span class="option-copy"><strong>${esc(one.label)}</strong>${one.description?`<small>${esc(one.description)}</small>`:''}</span></label>`).join('')}</div>${help}${err?`<p class="field-error">${esc(err)}</p>`:''}</fieldset>`;
    }
    const type=['number','password','email','url'].includes(field.type)?field.type:'text';
    const attrs=(type==='number'?[['min',field.min],['max',field.max]]:[['minlength',field.minLength??field.min],['maxlength',field.maxLength??field.max]]).filter(([,v])=>v!==undefined).map(([k,v])=>`${k}="${esc(v)}"`).join(' ');
    const input=`<input class="panel-input" id="field-${esc(key)}" type="${type}" data-panel-input="${esc(key)}" value="${esc(value ?? '')}" placeholder="${esc(field.placeholder || '')}" ${attrs} ${disabled?'disabled':''} ${field.required?'required':''} ${type==='number'?'inputmode="numeric" step="1"':''} ${type==='password'?'autocomplete="off"':'autocomplete="off"'} ${err?'aria-invalid="true"':''}>`;
    return `<div class="field-block">${cap}${type==='password'?`<div class="password-control">${input}${iconButton('Eye','显示或隐藏密码',`data-reveal="${esc(key)}"`)}</div>`:field.unit?`<div class="input-with-unit">${input}<span class="unit">${esc(field.unit)}</span></div>`:input}${help}${err?`<p class="field-error" role="alert">${esc(err)}</p>`:''}</div>`;
  }
  function resolveText(value) { return String(value ?? '').replaceAll('{account}',state.account).replaceAll('{{account}}',state.account); }
  function panelMarkup(frame) {
    if(frame.picker)return pickerMarkup(frame);
    const custom=window.CompleteSettings.panelMarkup(frame,{I,esc,cfg,get,toggle,iconButton,state,fieldMarkup});if(custom!==null)return custom;
    const spec=frame.spec;
    const related=spec.related || [];
    const actions=[spec.secondary,spec.primary,spec.tertiary].filter(Boolean);
    return `<div class="sheet-scrim ${['dialog','confirm'].includes(spec.kind)?'confirm-scrim':''}" data-scrim><section class="bottom-sheet v2-sheet ${['dialog','confirm'].includes(spec.kind)?'confirm-dialog':''}" role="dialog" aria-modal="true" aria-labelledby="panel-title"><div class="sheet-handle"></div><header class="sheet-header"><div><p class="panel-eyebrow">${esc(spec.group||'无尽夏')} · 设计示意</p><h2 id="panel-title">${esc(resolveText(spec.title))}</h2></div>${iconButton(state.panels.length>1?'ArrowLeft':'X',state.panels.length>1?'返回上一层':'关闭','data-action="close-panel"')}</header>${spec.subtitle?`<p class="panel-subtitle">${esc(resolveText(spec.subtitle))}</p>`:''}<div class="panel-scroll">${frame.error?`<p class="field-error" role="alert">${esc(frame.error)}</p>`:''}${(spec.fields || []).map((field,index)=>fieldMarkup(field,index,frame)).join('')}${related.length?`<div class="design-related"><p>设计状态 / 查看其他反馈</p><div>${related.map(one=>`<button type="button" data-panel="${esc(one.target||one.id)}">${esc(one.label)}</button>`).join('')}</div></div>`:''}</div><footer class="panel-footer"><div class="panel-actions">${actions.map(action=>`<button type="button" class="${action===spec.primary?'primary':'secondary'} ${action.tone==='danger'?'danger-primary':''}" data-panel-action="${esc(action.action||'navigate')}" ${action.target?`data-target="${esc(action.target)}"`:''}>${esc(action.label)}</button>`).join('') || '<button type="button" class="primary" data-action="close-panel">知道了</button>'}</div><p class="preview-label">${I('Eye')}设计示意 · 不连接账号，不向设备写入</p></footer></section></div>`;
  }
  function pickerMarkup(frame) {
    const field=frame.field;const items=fieldOptions(field);
    const filtered=items.filter(one=>`${one.label} ${one.description||''}`.toLowerCase().includes(frame.search.toLowerCase()));
    const choices=frame.selected;
    return `<div class="sheet-scrim" data-scrim><section class="bottom-sheet v2-sheet" role="dialog" aria-modal="true" aria-labelledby="panel-title"><div class="sheet-handle"></div><header class="sheet-header"><div><p class="panel-eyebrow">目录选择 · 设计示意</p><h2 id="panel-title">${esc(field.label)}</h2></div>${iconButton('ArrowLeft','取消选择','data-action="close-panel"')}</header><p class="panel-subtitle">名称来自仓内静态目录，不代表当前账号已解锁或有库存。</p><div class="panel-scroll"><div class="picker-toolbar"><input class="panel-input" type="search" data-picker-search placeholder="搜索名称或配方" value="${esc(frame.search)}" aria-label="搜索目录"><button type="button" data-action="pick-visible">全选可见</button></div><div class="picker-meta"><span>找到 ${filtered.length} 项 · 已选 ${choices.length} 项</span><button type="button" data-action="pick-clear">清空已选</button></div><div class="catalogue-list">${filtered.length?filtered.map(one=>`<label class="catalogue-row"><input type="checkbox" data-catalogue-value="${esc(one.value)}" ${choices.includes(one.value)?'checked':''}><span class="feature-icon ${field.catalog==='arts'?'lilac':''}">${I(field.catalog==='arts'?'Flower':'Flower2')}</span><span><strong>${esc(one.label)}</strong><small>${esc(one.description||'')}</small></span></label>`).join(''):'<div class="catalogue-empty">没有找到匹配项目<br>试试其他名称，或清除搜索内容。</div>'}</div></div><footer class="panel-footer"><div class="panel-actions"><button type="button" class="secondary" data-action="close-panel">取消</button><button type="button" class="primary" data-action="apply-picker">完成选择（${choices.length}）</button></div><p class="preview-label">${I('Eye')}只更新当前设置草稿，不执行游戏操作</p></footer></section></div>`;
  }
  function libraryMarkup() {
    const groups={};
    uniqueSpecs().filter(([,s])=>(s.complete||s.completeTool)&&!s.hidden).forEach(([id,spec])=>{if(spec.hidden)return; const group=spec.group||'其他';(groups[group]||=[]).push([id,spec]);});
    return `<aside class="prototype-library"><details open><summary>全部设置目录 <span class="library-count">${uniqueSpecs().filter(([,s])=>(s.complete||s.completeTool)&&!s.hidden).length} 项</span></summary><p class="library-note">按功能查找。参数只在所属详情编辑，名单在选择器里完成。</p><input type="search" class="library-search" aria-label="搜索弹窗目录" placeholder="搜索功能、弹窗或提示" data-library-search value="${esc(state.search)}"><div class="library-results">${Object.entries(groups).map(([group,items])=>`<section class="library-group"><h2>${esc(group)}</h2>${items.map(([id,spec])=>`<button type="button" class="library-entry ${current()?.id===id?'active':''}" data-library-panel="${id}" data-search-text="${esc(`${spec.title} ${group} ${(spec.rackFields||spec.fields||[]).map(f=>f.label).join(" ")}`)}"><span>${esc(spec.title)}</span>${I('ChevronRight')}</button>`).join('')}</section>`).join('')}</div></details></aside>`;
  }
  function render(preserve=false) {
    const oldScroll=preserve?[...stage.querySelectorAll('.scroll-area,.panel-scroll')].map(el=>el.scrollTop):[];
    stage.innerHTML=`<div class="preview-layout"><div class="device">${renderers[state.view]()}</div>${libraryMarkup()}</div>`;
    if(current())stage.querySelector('.phone').insertAdjacentHTML('beforeend',panelMarkup(current()));
    if(preserve)[...stage.querySelectorAll('.scroll-area,.panel-scroll')].forEach((el,i)=>{el.scrollTop=oldScroll[i]||0;});
    document.querySelectorAll('.studio-nav [data-view]').forEach(el=>{if(el.dataset.view===state.view)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
    const selector=document.querySelector('[data-page-state]');if(selector){selector.disabled=['login','me'].includes(state.view);selector.value=state.pageState;}
    filterLibrary();
  }
  function filterLibrary(){stage.querySelectorAll('.library-entry').forEach(el=>el.hidden=!el.dataset.searchText.toLowerCase().includes(state.search.toLowerCase()));stage.querySelectorAll('.library-group').forEach(el=>el.hidden=![...el.querySelectorAll('.library-entry')].some(one=>!one.hidden));}
  function toast(message) {
    clearTimeout(toastTimer);stage.querySelector('.prototype-toast')?.remove();
    const div=document.createElement('div');div.className='prototype-toast';div.setAttribute('role','status');div.textContent=message;stage.querySelector('.phone').append(div);toastTimer=setTimeout(()=>div.remove(),3200);
  }
  function updateUrl(){const url=new URL(location.href);url.searchParams.set('view',state.view);if(current()?.id)url.searchParams.set('panel',current().id);else url.searchParams.delete('panel');url.searchParams.delete('board');history.replaceState(null,'',url);}
  function openPanel(id,replace=false) {
    const spec=specs[id];
    if(!spec){console.warn(`Missing prototype panel: ${id}`);return;}
    previousFocus=document.activeElement;
    const values=spec.scope==='config'?clone(current()?.spec?.scope==='config'?current().values:cfg()):clone(spec.defaults||{});
    for(const field of spec.fields||[])if(field.key&&get(values,field.key)===undefined&&field.value!==undefined)set(values,field.key,clone(field.value));
    if(id==='choose-account')values.selectedAccount=state.account;
    if(id==='log-filters'||id==='log-categories'){values.logCategory=state.category==='全部'?'':state.category;values.logDay=state.logDay==='全部日期'?'':state.logDay;values.logSource=state.logScope==='本机全部记录'?'device':state.account;}
    const frame={id,spec,values,errors:{}};
    if(replace)state.panels=[];
    state.panels.push(frame);updateUrl();render(true);stage.querySelector('.sheet-header button')?.focus();
  }
  function closePanel(){state.panels.pop();updateUrl();render(true);if(current())stage.querySelector('.sheet-header button')?.focus();else if(previousFocus?.isConnected)previousFocus.focus();}
  function validate(frame) {
    const errors={};
    for(const field of frame.spec.fields||[]) {
      if(field.type!=='number'&&(!condition(field.showWhen,frame.values)||!condition(field.enableWhen,frame.values)||field.disabled))continue;
      const value=get(frame.values,field.key);if(!field.key)continue;
      if(field.required&&(value===undefined||value===null||String(value).trim()===''))errors[field.key]=`${field.label}还没有填写`;
      if(field.type==='number') {
        if(value===''||value===null||!Number.isInteger(Number(value)))errors[field.key]=`${field.label}请填写整数`;
        else if(field.min!==undefined&&Number(value)<field.min)errors[field.key]=`${field.label}不能低于 ${field.min}`;
        else if(field.max!==undefined&&Number(value)>field.max)errors[field.key]=`${field.label}不能高于 ${field.max}`;
      }
      const minLength=field.type==='number'?field.minLength:(field.minLength??field.min);
      const maxLength=field.type==='number'?field.maxLength:(field.maxLength??field.max);
      if(minLength&&String(value||'').length<minLength)errors[field.key]=`${field.label}至少 ${minLength} 位`;
      if(maxLength&&String(value||'').length>maxLength)errors[field.key]=`${field.label}最多 ${maxLength} 位`;
    }
    if(frame.spec.complete&&frame.spec.scope==='config'){const keys=new Set(frame.spec.fields.map(f=>f.key));window.CompleteSettings.validate(frame.values).errors.filter(e=>keys.has(e.key)).forEach(e=>errors[e.key]=e.message);}
    frame.errors=errors;return !Object.keys(errors).length;
  }
  // Main-page actions and panel feedback are installed below; every mutation is local.
  function chooseAccount(){openPanel('choose-account');}
  function go(view,account=state.account,force=false){
    if(!force&&dirty()&&(account!==state.account||(!window.CompleteSettings.views.includes(view)&&window.CompleteSettings.views.includes(state.view)))){state.pendingNavigation={view,account};openPanel('unsaved-changes');return;}
    state.account=account;state.view=view;if(view==='logs')state.logScope='当前游戏号';state.panels=[];state.pageState='normal';updateUrl();render();
  }
  function applyPanel(){const frame=current();if(!validate(frame)){render(true);stage.querySelector('[aria-invalid=true]')?.focus();return;}if(frame.spec.scope==='config'){const parent=state.panels[state.panels.length-2];if(parent?.spec?.scope==='config')parent.values=clone(frame.values);else state.configs[state.account]=clone(frame.values);}closePanel();toast('已更新设置草稿，回到页面后再保存。');}
  function validateConfig(){const verdict=window.CompleteSettings.validate(cfg());if(!verdict||verdict.valid===true)return true;const problem=typeof verdict==='string'?verdict:verdict.errors.map(e=>e.message).join('；');showFeedback('设置还不能保存',problem,'warning');return false;}
  function showFeedback(titleText,description,tone='success',actions){
    specs['local-feedback']={title:titleText,group:'交互反馈',kind:'dialog',fields:[{type:'status',label:titleText,description,tone}],primary:actions?.primary||{label:'知道了',action:'close'},secondary:actions?.secondary};openPanel('local-feedback',true);
  }
  function submitPanel(action,target){
    const frame=current();if(!frame)return;
    if(target){openPanel(target);return;}
    const aliases={'start-preview-account':'start-preview','stop-preview-account':'stop-preview','remove-preview-account':'remove-preview','check-preview-license':'check-license','change-preview-password':'change-password-preview','upload-preview-logs':'upload-logs','claim-preview-data':'claim-data','apply-preview-network':'apply-network','clear-preview-network':'clear-network','apply-preview-log-filters':'apply-log-filters','clear-preview-log-filters':'clear-log-filters'};
    action=aliases[action]||action;
    if(action==='close'||action==='cancel'||action==='back'){closePanel();return;}
    if(action==='apply'||action==='apply-config'){applyPanel();return;}
    if(action.startsWith('choose:')){go(state.view,action.slice(7));return;}
    if(action==='discard-navigation'){state.configs[state.account]=clone(state.saved[state.account]);const next=state.pendingNavigation;state.pendingNavigation=null;go(next?.view||'accounts',next?.account||state.account,true);return;}
    if(action==='save-navigation'){if(!validateConfig())return;state.saved[state.account]=clone(cfg());const next=state.pendingNavigation;state.pendingNavigation=null;go(next?.view||'accounts',next?.account||state.account,true);toast('原型示意：草稿已保留在本页内存。');return;}
    if(action==='save-config'){if(!validateConfig())return;state.saved[state.account]=clone(cfg());openPanel('save-success',true);return;}
    if(action==='apply-log-filters'){state.category=frame.values.logCategory||'全部';state.logDay=frame.values.logDay||'全部日期';state.logScope=frame.values.logSource==='device'?'本机全部记录':'当前游戏号';if(names.includes(frame.values.logSource))state.account=frame.values.logSource;state.logPage=1;state.pageState='normal';state.panels=[];state.view='logs';updateUrl();render();return;}
    if(action==='clear-log-filters'){state.category='全部';state.logDay='全部日期';state.logPage=1;state.pageState='normal';state.panels=[];render();return;}
    if(action==='start-preview'||action==='start-account'||action==='confirm-start'){if(dirty()){openPanel('start-unsaved');return;}state.running.add(state.account);showFeedback('已进入运行状态（示意）','正式 App 应先显示连接与恢复进度，再以本机读回状态确认。此原型没有启动真实账号。');return;}
    if(action==='stop-preview'||action==='stop-account'||action==='confirm-stop'){state.running.delete(state.account);showFeedback('已停止安排新任务（示意）','已发出的真实写入应等待结果核对；未知记录保留。此处仅切换原型画面。');return;}
    if(action==='remove-preview'||action==='remove-account'||action==='confirm-remove'){state.running.delete(state.account);state.accounts=state.accounts.filter(name=>name!==state.account);state.account=state.accounts[0]||names[0];state.panels=[];state.view='accounts';state.pageState=state.accounts.length?'normal':'empty';updateUrl();render();toast('仅从原型画面移除，真实账号和记录没有变化。');return;}
    if(action==='logout-preview'||action==='logout'||action==='confirm-logout'){state.running.clear();go('login',state.account,true);toast('原型已返回登录页；没有退出任何真实会话。');return;}
    if(action==='open-settings'||action==='background-settings'){openPanel('background-open-result');return;}
    if(action==='register-preview'||action==='register'||action==='register-submit'){if(!validate(frame)){render(true);return;}openPanel('auth-register-loading',true);return;}
    if(action==='add-preview-account'||action==='add-account-submit'||action==='verify-account'){if(!validate(frame)){render(true);return;}openPanel('add-account-verifying',true);return;}
    if(action==='change-password'||action==='change-password-preview'||action==='password-submit'){if(!validate(frame)){render(true);return;}openPanel('password-busy',true);return;}
    if(action==='apply-network'||action==='save-egress'||action==='network-save'){if(!validate(frame)){render(true);return;}const value=String(frame.values.proxy||'').trim();let valid=false;try{const hasScheme=/^[a-z][a-z0-9+.-]*:\/\//i.test(value);const url=new URL(hasScheme?value:`http://${value}`);const port=Number(url.port||(url.protocol==='https:'?443:80));valid=(hasScheme||value.includes(':'))&&['http:','https:'].includes(url.protocol)&&Boolean(url.hostname)&&port>0&&port<=65535;}catch{}if(!valid){frame.errors.proxy='请填写主机:端口或 HTTP / HTTPS CONNECT 代理地址。';render(true);return;}openPanel('network-loading',true);return;}
    if(action==='clear-network'||action==='clear-egress'){openPanel('network-direct',true);return;}
    if(action==='check-license'){openPanel('license-checking');return;}
    if(action==='upload-logs'){openPanel('sync-busy');return;}
    if(action==='claim-data'){openPanel('data-ownership-busy');return;}
    if(action==='return-login'||action==='login'){go('login',state.account,true);return;}
    if(action==='enter-accounts'){go('accounts',state.account,true);return;}
    if(action==='view-land'){go('land',state.account,true);return;}
    if(action==='select-preview-account'){go(state.view,frame.values.selectedAccount||state.account);return;}
    if(action==='refresh-preview'){state.pageState='normal';state.panels=[];render();toast('已返回正常设计状态，未连接任何真实服务。');return;}
    if(action==='discard-preview-draft'){state.configs[state.account]=clone(state.saved[state.account]);closePanel();return;}
    if(action==='view-device-logs'||action==='view-account-logs'||action==='reload-preview-logs'){if(action!=='reload-preview-logs')state.logScope=action==='view-device-logs'?'本机全部记录':'当前游戏号';state.view='logs';state.pageState='normal';state.panels=[];updateUrl();render();return;}
    if(action==='return-settings'){state.panels=[];state.view='land';updateUrl();render();return;}
    if(specs[action]){openPanel(action);return;}
    showFeedback('原型操作结果',frame.spec.resultDescription||'此操作仅更新当前设计示意。实际连接、状态确认和业务写入均未执行。','info');
  }
  function pickerOpen(index){const frame=current();const field=frame.spec.fields[index];state.panels.push({id:`picker:${field.key}`,picker:true,field,parent:frame,selected:[...(get(frame.values,field.key)||[])],search:''});render(true);stage.querySelector('[data-picker-search]')?.focus();}
  function setField(key,value){const frame=current();if(!frame||frame.picker)return;set(frame.values,key,value);delete frame.errors?.[key];}
  document.addEventListener('input',event=>{
    const input=event.target;
    if(input.matches('[data-library-search]')){state.search=input.value;filterLibrary();return;}
    if(input.matches('[data-panel-input]')){setField(input.dataset.panelInput,input.type==='number'?(input.value===''?'':Number(input.value)):input.value);return;}
    if(input.matches('[data-picker-search]')){const caret=input.selectionStart;current().search=input.value;render(true);const next=stage.querySelector('[data-picker-search]');next.focus();next.setSelectionRange(caret,caret);}
  });
  document.addEventListener('change',event=>{
    const input=event.target;
    if(input.matches('[data-panel-choice]')){const frame=current();const field=frame.spec.fields[Number(input.dataset.fieldIndex)];const option=fieldOptions(field)[Number(input.dataset.optionIndex)];const old=get(frame.values,field.key);setField(field.key,input.type==='checkbox'?(input.checked?[...new Set([...(old||[]),option.value])]:(old||[]).filter(one=>one!==option.value)):option.value);render(true);return;}
    if(input.matches('[data-catalogue-value]')){const frame=current();const item=fieldOptions(frame.field).find(one=>String(one.value)===input.dataset.catalogueValue);if(!item)return;frame.selected=input.checked?[...new Set([...frame.selected,item.value])]:frame.selected.filter(one=>one!==item.value);render(true);return;}
    if(input.matches('[data-page-state]')){state.pageState=input.value;state.panels=[];render();return;}
  });
  document.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    const account=button.dataset.account || state.account;
    if(button.dataset.libraryPanel){state.panels=[];openPanel(button.dataset.libraryPanel);return;}
    if(button.dataset.view){go(button.dataset.view,account);return;}
    if(button.dataset.panel){if(account!==state.account){state.account=account;}openPanel(button.dataset.panel);return;}
    if(button.dataset.toggle){set(cfg(),button.dataset.toggle,!get(cfg(),button.dataset.toggle));render(true);return;}
    if(button.dataset.panelToggle){const frame=current();set(frame.values,button.dataset.panelToggle,!get(frame.values,button.dataset.panelToggle));render(true);return;}
    if(button.dataset.picker!==undefined){pickerOpen(Number(button.dataset.picker));return;}
    if(button.dataset.reveal){const input=stage.querySelector(`[data-panel-input="${button.dataset.reveal}"]`);input.type=input.type==='password'?'text':'password';button.setAttribute('aria-pressed',String(input.type==='text'));return;}
    if(button.dataset.help!==undefined){const field=current().spec.fields[Number(button.dataset.help)];specs['field-help']={title:field.label,group:'设置说明',fields:[{type:'note',description:field.help||field.description}],primary:{label:'知道了',action:'close'}};openPanel('field-help');return;}
    if(button.dataset.panelAction){submitPanel(button.dataset.panelAction,button.dataset.target);return;}
    if(button.dataset.filter){state.filter=button.dataset.filter;render();return;}
    if(button.dataset.category){state.category=button.dataset.category;state.logPage=1;render();return;}
    const action=button.dataset.action;
    if(action==='close-panel'){closePanel();return;}
    if(action==='choose-account'){chooseAccount();return;}
    if(action==='pick-clear'){current().selected=[];render(true);return;}
    if(action==='pick-visible'){const frame=current();const visible=fieldOptions(frame.field).filter(one=>`${one.label} ${one.description||''}`.toLowerCase().includes(frame.search.toLowerCase()));frame.selected=[...new Set([...frame.selected,...visible.map(one=>one.value)])];render(true);return;}
    if(action==='apply-picker'){const frame=current();set(frame.parent.values,frame.field.key,[...frame.selected]);state.panels.pop();render(true);return;}
    if(action==='save-config'){if(!dirty()){toast('当前设置没有未保存的修改。');return;}if(!validateConfig())return;state.saved[state.account]=clone(cfg());openPanel('save-success',true);return;}
    if(action==='start-account'||action==='stop-account'){state.account=account;if(action==='start-account'&&dirty()){openPanel('start-unsaved');return;}if(action==='start-account')openPanel('account-starting',true);else openPanel('account-stopping',true);return;}
    if(action==='clear-log-filters'){state.category='全部';state.logDay='全部日期';state.logPage=1;state.pageState='normal';render();return;}
    if(action==='logs-next'||action==='logs-prev'){state.logPage=action==='logs-next'?2:1;render();toast('分页为原型示意，记录未从官服或日志库读取。');return;}
    if(action==='retry-state'){state.pageState='normal';render();toast('已返回正常设计状态，未连接真实服务。');return;}
    if(action==='reset-prototype'){location.href=location.pathname+'?view=land&identity=moon';return;}
    if(action==='reveal-login'){const input=stage.querySelector('#preview-login-password');input.type=input.type==='password'?'text':'password';return;}
    if(action==='login-preview'){const user=stage.querySelector('#preview-login-user').value;const password=stage.querySelector('#preview-login-password').value;const error=stage.querySelector('.auth-error');if(!user.trim()||!password){error.hidden=false;error.textContent='请填写示意账号和密码；不要使用真实凭据。';return;}go('accounts',state.account,true);toast('仅进入原型画面，没有验证或保存任何凭据。');return;}
    if(action==='log-detail'){const events=logEvents.filter(one=>state.category==='全部'||one[1]===state.category);const row=events[Number(button.dataset.index)];specs['log-entry-detail']={title:row[2],group:'运行记录',fields:[{type:'status',label:row[4],description:row[3],tone:row[5]?'warning':'success'},{type:'list',items:[{label:'游戏号',value:state.account},{label:'分类',value:row[1]},{label:'记录时间',value:`2026-10-20 ${row[0]}（示意）`},{label:'记录来源',value:'本机执行器（设计示意）'}]},{type:'note',label:'核对原则',description:row[5]?'状态未读到不等于失败或没有资格。保留原始记录，不重发旧操作；当前合法候选按本次可信状态安排。':'完成标识在正式 App 中应有业务确认依据，不能仅凭请求已提交。'}],primary:{label:'返回记录',action:'close'}};openPanel('log-entry-detail');}
  });
  document.addEventListener('click',event=>{if(event.target.matches('[data-scrim]'))closePanel();});
  document.addEventListener('keydown',event=>{
    const dialog=stage.querySelector('[role=dialog]');if(!dialog)return;
    if(event.key==='Escape'){event.preventDefault();closePanel();return;}
    if(event.key==='Tab'){const list=[...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]')].filter(el=>el.getClientRects().length);const first=list[0],last=list[list.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
  });
  specs['unsaved-changes']={title:'还有未保存的设置',subtitle:'离开前，选择如何处理当前账号的草稿。',group:'确认与反馈',kind:'dialog',fields:[{type:'note',description:'保存只更新设置，不会自动开始账号。放弃后恢复到本次最后一次保存的内容。',tone:'warning'}],primary:{label:'保存并离开',action:'save-navigation'},secondary:{label:'放弃修改并离开',action:'discard-navigation'},tertiary:{label:'继续编辑',action:'close'}};
  specs['save-pending']={title:'正在保存设置',subtitle:'只对当前游戏号生效，其他游戏号不受影响。',group:'确认与反馈',fields:[{type:'status',label:'正在保存当前账号设置',description:'保留草稿并等待本次结果，不重复提交。',tone:'loading'}],primary:{label:'返回',action:'close'},related:[{label:'保存成功',target:'save-success'},{label:'保存失败',target:'save-error'}]};
  specs['save-success']={title:'设置已保存',group:'确认与反馈',kind:'dialog',fields:[{type:'status',label:'当前账号设置已更新（示意）',description:'保存不会自动启动账号；需要时回到游戏号页面点击开始。',tone:'success'}],primary:{label:'完成',action:'close'}};
  specs['save-error']={title:'设置暂未保存',group:'确认与反馈',kind:'dialog',fields:[{type:'status',label:'保存结果暂未确认',description:'当前草稿仍然保留。先重新读取保存结果，再决定是否重试，避免把提示当作真实落库。',tone:'warning'}],primary:{label:'返回继续编辑',action:'close'}};
  specs['start-unsaved']={title:'先保存，再开始',group:'确认与反馈',kind:'dialog',fields:[{type:'note',label:'当前有未保存的设置',description:'开始运行会使用已保存配置。请先保存这次修改，再点击开始。',tone:'warning'}],primary:{label:'回到设置',action:'return-settings'},secondary:{label:'暂不开始',action:'close'}};
  const links={'app-help':'help','settings-help':'account-settings-guide','connection-help':'service-disconnected','software-account':'license','art-dependency':'customer-art-link','background-open-result':'background-settings'};
  Object.entries(links).forEach(([id,target])=>{if(!specs[id]&&specs[target])specs[id]=specs[target];});
  if(specs['remove-account'])specs['remove-account'].primary.tone='danger';
  if(specs['team-detail']){const field=specs['team-detail'].fields.find(one=>one.key==='orders.team.buyAgainKeepYuanbao');if(field)field.enableWhen=['orders.team.enabled','orders.team.allowBuyAgain'];}
  const resultLinks={'auth-register-loading':['auth-register-success','auth-error'],'add-account-verifying':['add-account-success','add-account-error'],'password-busy':['password-success','password-error'],'sync-busy':['sync-success','sync-error'],'data-ownership-busy':['data-ownership-success','data-ownership-error'],'license-checking':['license-valid','license-error'],'network-loading':['network-proxy','network-error'],'account-starting':['account-runtime','account-action-unknown'],'account-stopping':['account-stopped','account-action-unknown'],'logout-busy':['auth-logged-out','logout-error'],'remove-account-busy':['remove-account-success','remove-account-error']};
  Object.entries(resultLinks).forEach(([id,targets])=>{if(!specs[id])return;specs[id].related=[...(specs[id].related||[]),...targets.filter(target=>specs[target]).map(target=>({label:specs[target].title,target}))];});
  const statebar=document.createElement('div');statebar.className='studio-states';statebar.innerHTML='<label>页面状态<select data-page-state><option value="normal">正常</option><option value="loading">读取中</option><option value="empty">空状态</option><option value="error">读取失败</option></select></label><button type="button" data-action="reset-prototype">重置原型</button><span class="state-note">仅用于交互设计评审 · 所有数据均为示意 · 不输入真实凭据</span>';document.querySelector('.studio-header').after(statebar);
  function uniqueSpecs(){const seen=new Set();return Object.entries(specs).filter(([,spec])=>{if(seen.has(spec))return false;seen.add(spec);return true;});}
  window.GardenDesignPreview={listPanels:()=>uniqueSpecs().map(([id,spec])=>({id,title:spec.title,group:spec.group,kind:spec.kind,fields:(spec.fields||[]).length})),openPanel:id=>openPanel(id,true),navigate:view=>go(view,state.account,true),snapshot:()=>({view:state.view,panel:current()?.id,account:state.account}),references:()=>uniqueSpecs().flatMap(([id,spec])=>[...(spec.fields||[]).filter(one=>one.target).map(one=>({from:id,to:one.target})),...(spec.related||[]).map(one=>({from:id,to:one.target||one.id})),...[spec.primary,spec.secondary].filter(one=>one?.target).map(one=>({from:id,to:one.target}))]).filter(one=>!specs[one.to])};
  window.CompleteSettings.bind({state,cfg,get,set,current,openPanel,closePanel,render,go,toast,setField});
  if(params.has('board')) {
    document.body.classList.add('board-mode');statebar.hidden=true;
    const first=params.get('board')==='1';const list=first?['login','accounts','land']:['orders','art','logs'];
    stage.innerHTML=`<section class="design-board"><header class="board-heading"><div><p class="edition">ENDLESS SUMMER / COMPLETE INTERACTION DESIGN</p><h1>花开无尽夏<span>雨落有晴天</span></h1><p>Android App 高保真原型 · 完整功能入口</p></div><div class="board-swatches"><i></i><i></i><i></i><i></i></div></header><div class="board-grid">${list.map((view,i)=>`<div><div class="device">${renderers[view]()}</div><div class="board-screen-caption"><b>0${i+(first?1:4)}</b><div><h2>${({login:'欢迎回园',accounts:'我的游戏号',land:'种花收花',orders:'交订单',art:'花艺',logs:'运行日志'})[view]}</h2><p>全部卡片可在交互原型内点开</p></div></div></div>`).join('')}</div><footer class="board-bottom"><b>BOTANICAL CALM · COMPLETE FLOWS</b><span>全部状态均为设计示意，非官服截图或测试结果</span><span>2026.10 / ${first?'01':'02'}</span></footer></section>`;
  } else {render();if(params.get('panel'))openPanel(params.get('panel'),true);}
})();
