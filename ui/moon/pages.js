/* The seven prototype views, ported from docs/design/20261020/prototype.js renderers (lines 54-86).
   Each page returns the prototype's own layer split: chrome (fixed header) / content (scroll-area body) /
   dock (fixed save area) / nav. Values come from view-models.js; nothing here invents layout. */
import { icon } from './icons.js';
import { esc, iconButton, avatar, nav, title, accountPicker, settingsHeader, section, feature,
  saveDock, pageStateMarkup, toolbarStatus, pageHeading, gardenBanner, filters, accountCard } from './components.js';

export function loginPage(vm) {
  return { layout: 'auth', chrome: '',
    content: `<div class="login-art"><img src="brand/logo-endless-summer.webp" alt="无尽夏：蓝紫绣球原图标"></div><div class="login-content"><h2>花开无尽夏</h2><p class="intro">雨落有晴天</p><div class="login-field">${icon('UserRound')}<label><span>软件账号</span><input id="auth-user" name="username" type="text" placeholder="输入软件账号" aria-label="软件账号" autocomplete="username" maxlength="32"></label></div><div class="login-field">${icon('LockKeyhole')}<label><span>登录密码</span><input id="auth-password" name="password" type="password" placeholder="登录本机执行服务" aria-label="登录密码" autocomplete="current-password" maxlength="64"></label>${iconButton('Eye', '显示或隐藏密码', 'data-action="reveal-login"')}</div><p class="auth-error" role="alert"${vm.authError ? '' : ' hidden'}>${esc(vm.authError)}</p><button type="button" class="primary" data-action="software-login"${vm.busy ? ' disabled' : ''}>登录，回到花园 ${icon('ArrowRight')}</button><p class="login-extra">还没有账号？<button type="button" data-action="auth-mode" data-mode="register">立即注册</button></p><button type="button" class="auth-help-link" data-panel="auth-help">登录遇到问题？</button></div><div class="login-bottom">${icon('Leaf')}本机执行 · 随时可停</div>` };
}

export function accountsPage(vm) {
  const cards = vm.cards.length ? vm.cards.map(accountCard).join('')
    : `<div class="page-empty"><h2>暂无这类游戏号</h2><p>可以切回全部查看。</p></div>`;
  return { layout: 'panel',
    chrome: `<header class="app-toolbar"><div class="wordmark"><span class="brand-symbol"><img src="brand/logo-endless-summer.webp" alt="无尽夏原图标"></span>无尽夏</div>${toolbarStatus(vm)}</header>`,
    content: `${pageHeading(vm)}${vm.pageState !== 'normal' ? pageStateMarkup('游戏号', vm.pageState, { error: vm.accountsError, retryAction: 'refresh' }) : gardenBanner(vm) + filters(vm) + cards}`,
    dock: '', nav: nav('accounts') };
}

const readNumber = (value, unit = '') => typeof value === 'number' && Number.isFinite(value) ? `${value}${unit}` : '未读取';
const readLimit = (value, fallback, unit = '') => readNumber(value === 0 ? fallback : value, unit);
const settingsStateMarkup = vm => pageStateMarkup('设置', vm.pageState, { error: vm.pageError, retryAction: vm.pageRetryAction });
const collectionSwitch = (path, name, description, iconName, checked, tone = 'blue') =>
  `<section class="setting-card">${feature({ path, name, desc: description, icon: iconName, checked, tone })}</section>`;
const panelSwitch = (path, name, description, iconName, panel, checked, tone = '') =>
  `<section class="setting-card">${feature({ path, name, desc: description, icon: iconName, panel, checked, tone })}</section>`;

export function landPage(vm) {
  const c = vm.draft;
  const rows = vm.waterExtraSummary || '';
  return { layout: 'panel',
    chrome: settingsHeader('land', vm),
    content: vm.pageState !== 'normal' ? settingsStateMarkup(vm)
      : `${section('种植与收获', '点开卡片设置花种与余量')}
        <section class="setting-card">${feature({ path: 'plantEnabled', name: '自动种花', desc: '花园土地 · 按所选花种和模式自动补种', icon: 'Sprout', panel: 'plant-detail', checked: c.plantEnabled })}</section>
        <section class="setting-card">${feature({ path: 'waterEnabled', name: '自动浇水', desc: typeof c.keepWater === 'number' ? `花园土地 · 按需浇水，至少保留 ${readNumber(c.keepWater, ' 滴')}` : '花园土地 · 保留水滴余量未读取', icon: 'Droplets', tone: 'blue', panel: 'water-detail', checked: c.waterEnabled })}</section>
        <section class="setting-card">${feature({ path: 'harvestEnabled', name: '自动收花', desc: '花园土地 · 同组花朵全部成熟后一起收获', icon: 'Flower2', tone: 'lilac', checked: c.harvestEnabled })}</section>
        ${section('领取水滴')}
        ${collectionSwitch('waterwheelEnabled', '领取水车水桶', '水车 · 有可领取水桶时自动收取', 'Droplets', c.waterwheelEnabled)}
        ${collectionSwitch('freeWaterEnabled', '领取每日免费水滴', '每日免费水滴 · 到可领取时段自动收取', 'Droplets', c.freeWaterEnabled)}
        ${section('花朵培养与材料', '会消耗精华或金币')}
        ${panelSwitch('cultivateUpgrade.enabled', '升级鲜花', `花朵培养 · 消耗精华和金币，升至 ${readNumber(c.cultivateUpgrade?.targetLevel, ' 级')}`, 'Sprout', 'cultivate-upgrade', c.cultivateUpgrade?.enabled === true)}
        ${panelSwitch('materialShop.enabled', '材料商店', `自动买培养材料 · 每分钟最多 ${readLimit(c.materialShop?.maxBuyPerMinute, 3, ' 次')}`, 'ShoppingBag', 'material-shop', c.materialShop?.enabled === true, 'gold')}
        ${rows}<button type="button" class="advanced-link" data-panel="settings-help">功能分类与保存说明 ${icon('CircleHelp')}</button>`,
    dock: saveDock(vm), nav: nav('land') };
}

const ORDER_INFO = [['resident', '居民订单', 'House', '', 'res'], ['satin', '绸缎订单', 'Spool', 'lilac', 'res'],
  ['decorate', '建材订单', 'Blocks', 'gold', 'res'], ['customer', '顾客订单', 'ShoppingBag', '', 'tier'],
  ['palace', '宫廷订单', 'Crown', 'gold', 'quality'], ['team', '组团订单', 'UsersRound', 'blue', 'team']];

export function ordersPage(vm) {
  const c = vm.draft;
  const get = path => String(path).split('.').reduce((node, key) => node?.[key], c);
  const rows = ORDER_INFO.map(([key, name, iconName, tone, kind]) => {
    const limit = get(`orders.${key}.dailyLimit`);
    const desc = kind === 'res' ? `自动交普通单和视频单 · ${limit === 0 ? '每日不限量' : `每天最多 ${readNumber(limit)} 单`}`
      : kind === 'tier' ? '按花坊币档位交付顾客订单，可设置自动拒单'
        : kind === 'quality' ? '自动交付宫廷订单，可排除不想交的花朵品质'
          : '自动接团单、交花和领奖，可设置元宝加单';
    return `<div class="order-row"><button type="button" class="order-card-link" data-panel="order-${key}"><span class="feature-icon ${tone}">${icon(iconName)}</span><span class="feature-copy"><h2>${name}</h2><p>${esc(desc)}</p></span>${icon('ChevronRight')}</button>${featureToggle(`orders.${key}.enabled`, name, get(`orders.${key}.enabled`) === true)}</div>`;
  }).join('');
  return { layout: 'panel',
    chrome: settingsHeader('orders', vm),
    content: vm.pageState !== 'normal' ? settingsStateMarkup(vm)
      : `${section('自动交订单', '点开卡片设置条件与上限')}<section class="setting-card orders-card">${rows}<p class="video-hint">${icon('Video')}居民、绸缎、建材的普通单和视频单共用本类开关</p></section><button type="button" class="advanced-link" data-panel="orders-state-help">查看订单等待原因 ${icon('ChevronRight')}</button>`,
    dock: saveDock(vm), nav: nav('land') };
}

function featureToggle(path, label, checked) {
  return `<button type="button" class="toggle" role="switch" aria-label="${esc(label)}" aria-checked="${checked}" data-path="${esc(path)}"><span class="toggle-track"></span></button>`;
}

export function artPage(vm) {
  const c = vm.draft;
  const art = c.art || {}, rack = c.flowerRack || {};
  const status = enabled => enabled ? '已开启' : '已关闭';
  const row = (iconName, tone, label, description, panel) => `<div class="order-row"><button type="button" class="order-card-link" data-panel="${esc(panel)}"><span class="feature-icon ${tone || ''}">${icon(iconName)}</span><span class="feature-copy"><h2>${esc(label)}</h2><p>${esc(description)}</p></span>${icon('ChevronRight')}</button></div>`;
  return { layout: 'panel',
    chrome: settingsHeader('art', vm),
    content: vm.pageState !== 'normal' ? settingsStateMarkup(vm)
      : `${section('花艺', '点开卡片查看设置')}<section class="setting-card orders-card">
          ${row('Flower2', '', '花艺制作与自动补货', `顾客优先${status(art.makeEnabled === true)} · 日常补货${status(art.dailyMakeEnabled === true && art.autoReplenish === true)} · 目标 ${readNumber(art.targetStock, ' 件')} · 单次 ${readNumber(art.makeBatch, ' 件')}`, 'art-detail')}
          ${feature({ path: 'art.firstAlbumClaim', name: '首做图鉴奖励', desc: '首次做成后，自动领取图鉴经验', icon: 'Gift', tone: 'gold', checked: art.firstAlbumClaim === true })}
          ${feature({ path: 'art.firstShareClaim', name: '首做分享奖励', desc: '符合游戏资格时，自动领取首做分享奖励', icon: 'BookOpen', tone: 'lilac', checked: art.firstShareClaim === true })}
        </section>
        ${section('花架', '上架、下架与解锁分别设置')}<section class="setting-card orders-card">
          ${row('ShoppingBag', '', '上架与收款', status(rack.enabled === true), 'flower-rack-detail')}
          ${row('Clock3', 'lilac', '自动下架', status(rack.autoTakeDown === true), 'flower-rack-cancel')}
          ${row('KeyRound', 'gold', '解锁花架', status(rack.unlockEnabled === true), 'flower-rack-unlock')}
        </section>`,
    dock: saveDock(vm), nav: nav('land') };
}

const rewardSwitch = (path, name, description, iconName, checked, tone = '') =>
  collectionSwitch(path, name, description, iconName, checked, tone);

export function rewardsPage(vm) {
  const c = vm.draft;
  const get = path => String(path).split('.').reduce((node, key) => node?.[key], c);
  return { layout: 'panel',
    chrome: settingsHeader('rewards', vm),
    content: vm.pageState !== 'normal' ? settingsStateMarkup(vm)
      : `${section('任务领奖', '领取已达标奖励，不代做任务')}
          ${rewardSwitch('dailyTaskRewards.enabled', '领取每日任务奖励', '每日任务 · 达到任务要求后自动领奖', 'Check', get('dailyTaskRewards.enabled') === true)}
          ${rewardSwitch('dailyTaskBox.enabled', '领取活跃度宝箱', '每日任务 · 活跃度达标后领取对应宝箱', 'Sparkles', get('dailyTaskBox.enabled') === true, 'gold')}
          ${rewardSwitch('weeklyTask.enabled', '领取每周任务奖励', '每周任务 · 达到任务要求后自动领奖', 'CalendarDays', get('weeklyTask.enabled') === true, 'lilac')}
          ${panelSwitch('mainTask.enabled', '领取主线任务奖励', `主线任务 · 已达标才领，每分钟最多 ${readNumber(get('mainTask.maxRewardsPerMinute'), ' 次')}`,
            'ScrollText', 'reward-main-task', get('mainTask.enabled') === true)}
        ${section('邮件与福利')}
          ${rewardSwitch('mail.enabled', '领取邮件附件', '邮件 · 自动收取邮件中可领取的物品', 'ScrollText', get('mail.enabled') === true, 'blue')}
          ${rewardSwitch('benefitBox.enabled', '开启福利宝箱', '游戏入口：主界面 → 福利 → 福利宝箱；有宝箱时自动抽取奖励', 'Gift', get('benefitBox.enabled') === true, 'gold')}
          ${rewardSwitch('freeYuanbaoGift.enabled', '领取免费元宝礼包', '游戏入口：礼包商城 → 免费元宝礼包（看广告领取）；可领取时自动领取', 'Gift', get('freeYuanbaoGift.enabled') === true, 'gold')}
        ${section('金币加成')}
          ${rewardSwitch('doubleCoin.enabled', '领取双倍金币加成', '游戏入口：福利 → 双倍金币 → 看视频；加成到期后自动续领', 'Sparkles', get('doubleCoin.enabled') === true, 'gold')}
        ${section('剧情解锁', '会消耗剧情星星')}
          ${panelSwitch('mainStory.enabled', '解锁主线剧情', `主线剧情 · 使用星星解锁，每天最多 ${readLimit(get('mainStory.maxUnlocksPerDay'), 1, ' 节')}`,
            'BookOpen', 'reward-main-story', get('mainStory.enabled') === true, 'lilac')}
        `,
    dock: saveDock(vm), nav: nav('land') };
}

export function guildPage(vm) {
  const c = vm.draft;
  const get = path => String(path).split('.').reduce((node, key) => node?.[key], c);
  const build = c.guildBuild || {}, land = c.guildLand || {};
  const buildSummary = [build.videoEnabled === true ? '视频建设' : '',
    build.goldEnabled === true ? `金币 ${readNumber(build.goldDailyCount, ' 次/天')}` : '',
    build.yuanbaoEnabled === true ? `元宝 ${readNumber(build.yuanbaoTimesPerDay, ' 次/天')}` : '']
    .filter(Boolean).join(' · ') || '选择建设方式与每日次数';
  const landSummary = [[land.harvestEnabled, '收获'], [land.plantEnabled, '种植'],
    [land.upgradeEnabled, '升级'], [land.unlockEnabled, '解锁']]
    .filter(([enabled]) => enabled === true).map(([, label]) => label).join(' · ') || '选择自动操作与花种范围';
  return { layout: 'panel',
    chrome: settingsHeader('guild', vm),
    content: vm.pageState !== 'normal' ? settingsStateMarkup(vm)
      : `${section('公会', '点开卡片查看设置')}
          ${panelSwitch('guildBuild.enabled', '公会建设', buildSummary,
            'Blocks', 'guild-build', get('guildBuild.enabled') === true)}
          ${panelSwitch('guildLand.enabled', '公会地', landSummary,
            'House', 'guild-land', get('guildLand.enabled') === true, 'lilac')}
        `,
    dock: saveDock(vm), nav: nav('land') };
}

export function logsPage(vm) {
  const fixed = ['全部', '种花', '浇水', '收花'];
  const chips = fixed.map(cat => `<button type="button" role="tab" aria-selected="${vm.category === cat}" class="${vm.category === cat ? 'active' : ''}" ${cat === '全部' ? 'data-log-category=""' : `data-log-category="${cat}"`}>${cat}</button>`).join('')
    + `<button type="button" role="tab" aria-selected="${Boolean(vm.moreLabel)}" class="${vm.moreLabel ? 'active' : ''}" data-panel="log-categories">${esc(vm.moreLabel || '更多')}</button>`;
  const notice = vm.logsNotice || (vm.logsPending ? '正在读取历史记录，读取完成后会从第一页显示。' : '');
  const noticeMarkup = notice ? `<div class="panel-note ${vm.logsPending ? 'info' : 'warning'}" role="status"><strong>${vm.logsPending ? '正在读取历史记录' : '历史记录读取提示'}</strong>${esc(notice)}</div>` : '';
  const body = vm.pageState === 'loading' ? `<div class="page-empty" role="status">${icon('LoaderCircle')}<h2>正在读取日志</h2><p>${esc(notice || '正在读取所选来源的日志，请稍候。')}</p></div>`
    : vm.pageState === 'error' ? `<div class="page-empty">${icon('CloudOff')}<h2>日志暂时没读到</h2><p>${esc(vm.logsError || '没有把读取失败当作空数据。')}</p><button type="button" class="primary" data-action="reload-logs">重新读取</button></div>`
      : !vm.events.length ? notice ? `${noticeMarkup}<button type="button" class="primary" data-action="reload-logs">重新读取</button>`
        : pageStateMarkup('日志', vm.pageState === 'logs-empty' ? 'logs-empty' : 'logs-none')
        : `${noticeMarkup}<div class="timeline">${vm.events.map(one => `<article class="log-event ${one.tone}"><time class="log-time"${one.dateTime ? ` datetime="${esc(one.dateTime)}"` : ''} title="${esc(one.timeLabel)}" aria-label="${esc(one.timeLabel)}">${esc(one.time)}</time><div class="timeline-rail" aria-hidden="true"></div><button type="button" class="log-message" data-action="log-detail" data-index="${one.index}"><header><h2>${esc(one.title)}</h2><span>${esc(one.status)}</span></header><p>${esc(one.body)}</p></button></article>`).join('')}</div>`;
  return { layout: 'panel',
    chrome: title('运行日志', 'log-filters', 'ListFilter'),
    content: `${accountPicker(vm)}<div class="log-filters" role="tablist">${chips}</div><div class="log-date"><button type="button" class="log-date-button" data-panel="log-filters">${icon('CalendarDays')}${esc(vm.dayLabel)}${icon('ChevronDown')}</button><span>${esc(vm.dateHint)}</span></div><div class="log-upload-policy"><span>错误与失败自动上传，其余记录保留，可手动选择上传。</span><button type="button" class="button secondary wide" data-action="upload-filtered-logs"${vm.logsUploadBusy || vm.pageState === 'loading' ? ' disabled' : ''}>${vm.logsUploadBusy ? '正在上传当前筛选…' : '上传当前筛选结果（全部匹配记录）'}</button></div>${body}<div class="logs-pager"><button type="button" data-action="logs-prev"${vm.pager.prevDisabled ? ' disabled' : ''}>上一页</button><span>第 ${vm.pager.page} 页 · 每页 15 条</span><button type="button" data-action="logs-next"${vm.pager.nextDisabled ? ' disabled' : ''}>下一页</button></div>`,
    dock: '', nav: nav('logs') };
}

/* data-panel 是原型身份（比对与结构都靠它），data-action 才是正式层的真实入口：
   这些行必须打开真读数弹层，不能拿设计表里的示意内容顶替真实状态。 */
const ME_ACTION = { password: 'change-password', network: 'me-egress',
  'software-account': 'me-software', logout: 'software-logout' };
const profileRow = (iconName, label, value, panel) =>
  `<button type="button" class="profile-line" data-panel="${esc(panel)}"${ME_ACTION[panel] ? ` data-action="${ME_ACTION[panel]}"` : ''}>${icon(iconName)}${esc(label)}<span class="right">${esc(value)}${icon('ChevronRight')}</span></button>`;

export function mePage(vm) {
  return { layout: 'panel',
    chrome: title('我的', 'app-help', 'Settings2'),
    content: `<button type="button" class="profile-banner" data-panel="software-account" data-action="me-software"><span class="avatar">园</span><span><h2>我的软件账号</h2><p>软件身份与游戏账号分开管理</p></span>${icon('ChevronRight')}</button>${section('软件与授权')}<section class="profile-section">${profileRow('ShieldCheck', '软件授权', vm.license, 'license')}${profileRow('KeyRound', '修改密码', '', 'password')}${profileRow('ScrollText', '日志同步', vm.sync, 'sync')}</section>${section('本机运行')}<section class="profile-section">${profileRow('Smartphone', '运行服务', vm.service, 'service')}${profileRow('BatteryCharging', '后台运行说明', '', 'battery')}${profileRow('Route', '网络出口', vm.egress, 'network')}</section><p class="profile-footnote">状态以本机实际读数为准。<br>账号归属、日志缺口与待核查结果均保留明细入口。</p><button type="button" class="text-exit" data-panel="logout" data-action="software-logout">退出软件账号</button>`,
    dock: '', nav: nav('me') };
}

export const PAGES = { login: loginPage, accounts: accountsPage, land: landPage, orders: ordersPage, art: artPage,
  rewards: rewardsPage, guild: guildPage, logs: logsPage, me: mePage };
