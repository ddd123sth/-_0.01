// 无尽夏安卓端专用管理后台 · 渲染层
// 只把状态拼成 HTML 字符串，不含业务判断与请求；所有来自接口的值一律走 esc()，
// 敏感文本再走 maskSecrets()。不写内联事件属性与内联 style（CSP：script-src 'self'、style-src 'self'）。

import {
  DASH, LOG_LEVELS, NAV, PAGE_SIZE_CHOICES, activeFilterCount, buildHash, describeBackup,
  errorCodeText, esc, formatBytes, formatRelative, formatTime, isErrorRecord, levelText, logAcceptedNotice,
  logDetailRows, logExcerpt, maskSecrets, noRecentLogsNotice, pageRange, pageWindow,
  sourceNote, usernameText,
} from "./console.mjs";

const BRAND_MARK = `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 27V15M16 19C6 21 4 13 5 7c8-1 12 5 11 12Zm0-5c-1-7 4-11 11-10 1 7-3 11-11 10Z"/></svg>`;

export function loginView(state) {
  const error = state.loginError
    ? `<div class="notice error" role="alert">${esc(state.loginError)}</div>`
    : "";
  return `
<div class="login-wrap">
  <div class="login-card">
    <div class="mark">${BRAND_MARK}<h1>无尽夏管理后台</h1></div>
    <p class="sub">无尽夏安卓端的专用后台，只连本项目的云服务；与原网页版后台不是同一个入口，也不共用它的账号、会话与数据。</p>
    ${error}
    <form data-form="login">
      <div class="field"><label for="admin-username">管理员账号</label>
        <input id="admin-username" name="username" type="text" autocomplete="username" spellcheck="false" required></div>
      <div class="field"><label for="admin-password">管理员密码</label>
        <input id="admin-password" name="password" type="password" autocomplete="current-password" spellcheck="false" required></div>
      <button class="btn" type="submit" ${state.busy ? "disabled" : ""}>${state.busy === "login" ? "正在登录…" : "登录"}</button>
    </form>
    <div class="notice info">
      <p>登录令牌只保存在本页内存里，浏览器本地存储不写任何凭据。因此刷新页面或另开标签页后内存就空了，需要重新登录，这不是故障。</p>
      <p>改密或云端撤销会话后同样要重新登录。</p>
    </div>
  </div>
</div>`;
}

export function shellView(state, contentHtml) {
  const nav = NAV.map((item) => {
    const current = item.route === state.route;
    return `<a href="${esc(item.route)}" class="${current ? "current" : ""}"${current ? ' aria-current="page"' : ""}>${esc(item.label)}<span class="nav-tip">${esc(item.tip)}</span></a>`;
  }).join("");
  return `
<div class="shell">
  <aside class="side">
    <div class="side-brand">
      <div class="mark">${BRAND_MARK}<strong>无尽夏</strong></div>
      <div class="role">管理后台</div>
      <div class="sub">安卓端云服务的运维入口</div>
    </div>
    <nav class="side-nav" aria-label="主导航">
      <p class="nav-group">运维</p>
      ${nav}
    </nav>
    <div class="side-foot">
      <p>令牌只在本页内存中，刷新后需重新登录。</p>
      <p>后台不提供远程登录游戏、读取游戏密码、远程改花种、启动游戏任务或接管失联手机的入口。</p>
    </div>
  </aside>
  <div class="main-col">
    <header class="topbar">
      <span class="page-title">${esc(pageTitle(state.route))}</span>
      <span class="spacer"></span>
      <span class="who">当前管理员：<b>${esc(state.session.admin || "管理员")}</b></span>
      <button class="btn ghost small" type="button" data-action="reload-page">重新读取</button>
      <button class="btn danger small" type="button" data-action="logout">退出登录</button>
    </header>
    <main class="content" tabindex="-1">
      ${bannerView(state)}
      ${contentHtml}
    </main>
  </div>
  ${dialogView(state)}
</div>`;
}

function pageTitle(route) {
  const item = NAV.find((entry) => entry.route === route);
  return item ? item.label : NAV[0].label;
}

export function bannerView(state) {
  const notice = state.notice;
  if (!notice || !notice.text) return "";
  const kind = notice.kind || "info";
  return `<div class="notice ${esc(kind)}" role="status">${esc(notice.text)}</div>`;
}

export function dialogView(state) {
  const confirm = state.confirm;
  if (!confirm) return "";
  const reason = confirm.reason ? `<div class="notice warn"><p>${esc(confirm.reason)}</p></div>` : "";
  const form = confirm.kind === "disable"
    ? `<form data-form="confirm-reason" class="form-row">
         <div class="field wide"><label for="disable-reason">停用原因（可选，写进后台审计）</label>
           <input id="disable-reason" name="reason" type="text" maxlength="200" placeholder="例如：用户自己在手机上申请停用" value="${esc(confirm.reason)}"></div>
         <button class="btn ghost" type="submit">填写原因后再停用</button>
       </form>`
    : "";
  return `
<div class="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
  <div class="dialog">
    <h2 id="dialog-title">${confirm.kind === "disable" ? "确认停用这个软件用户吗" : "确认操作"}</h2>
    ${confirm.kind === "disable"
      ? `<p>即将停用：<b>${esc(confirm.name)}</b>（用户标识 ${esc(String(confirm.id))}）。</p>
         <p class="danger-line">停用会撤销该用户的全部会话与刷新凭据：他会立即无法登录与续期，手机侧下一次校验时收到明确停用。</p>
         <p>停用不改写任何在途的未确认操作，也不把未知结果改成成功；云端已有日志继续保留。重新启用只恢复登录资格，不会复活已撤销的会话，更不会替他在手机上开启游戏任务。</p>`
      : `<p>${esc(confirm.text || "")}</p>`}
    ${reason}
    <div class="actions">
      <button class="btn danger" type="button" data-action="confirm-yes">${confirm.kind === "disable" ? "确认停用" : "确认"}</button>
      <button class="btn ghost" type="button" data-action="confirm-no">取消，不改动</button>
    </div>
  </div>
</div>`;
}

/* ================= 用户管理 ================= */

export function usersView(state) {
  const panel = state.users;
  const error = panel.error ? `<div class="notice error" role="alert"><p>${esc(panel.error)}</p></div>` : "";
  const total = panel.data ? Number(panel.data.total) || 0 : 0;
  const items = panel.data && Array.isArray(panel.data.items) ? panel.data.items : [];
  return `
<section class="page-head">
  <h1>用户管理</h1>
  <p>软件用户名册：这里的用户是登录本 App 的软件账号，不是游戏账号。列表只读云端保存的注册信息、启停状态与备注。</p>
  <p class="hint">「查看该用户运行日志」会把用户标识带进运行日志页作筛选条件，路径为软件用户 → 该用户运行日志 → 某个游戏号标签。</p>
</section>
<section class="card">
  <h2>筛选</h2>
  <p class="card-desc">按用户名搜索，翻页浏览；空着的条件不会下发给云端。</p>
  <form data-form="user-filters" class="filters">
    <div class="field wide"><label for="user-q">用户名搜索</label>
      <input id="user-q" name="q" type="search" maxlength="64" placeholder="用户名的部分文字" value="${esc(panel.q)}"></div>
    <div class="field"><label for="user-size">每页条数</label>
      ${pageSizeSelect("user-size", panel.pageSize)}
    </div>
    <div class="actions">
      <button class="btn" type="submit" ${panel.loading ? "disabled" : ""}>${panel.loading ? "正在读取…" : "搜索"}</button>
      <button class="btn ghost" type="button" data-action="clear-user-filters" ${panel.q === "" && panel.page === 1 ? "disabled" : ""}>清空条件</button>
    </div>
  </form>
</section>
${error}
${usersTable(state, items, total)}`;
}

function usersTable(state, items, total) {
  const panel = state.users;
  if (panel.loading && !panel.data) {
    return `<div class="notice info"><p>正在读取用户名册…</p></div>`;
  }
  if (!items.length) {
    return `<div class="card"><div class="empty"><p>没有符合条件的软件用户。</p><p class="cell-note">这只说明按当前条件没读到记录，不代表云端没有用户，也不代表任何用户的使用情况。</p></div></div>`;
  }
  const rows = items.map((user) => userRow(state, user)).join("");
  return `
<section class="card">
  <h2>用户列表</h2>
  <p class="card-desc">共 ${esc(String(total))} 位软件用户；下面显示第 ${esc(String(pageRange(total, panel.page, panel.pageSize).from))} 到 ${esc(String(pageRange(total, panel.page, panel.pageSize).to))} 条。</p>
  <div class="table-scroll">
    <table>
      <thead><tr>
        <th scope="col">软件用户</th>
        <th scope="col" class="time">注册时间</th>
        <th scope="col" class="time">最近登录</th>
        <th scope="col">状态</th>
        <th scope="col" class="num">日志条数</th>
        <th scope="col" class="time">最近日志</th>
        <th scope="col">备注</th>
        <th scope="col">操作</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  ${pager(state, "users", total, panel.page, panel.pageSize, panel.loading)}
</section>`;
}

function userRow(state, user) {
  const id = user.id;
  const open = String(state.users.openId) === String(id);
  const enabled = user.enabled !== false;
  const remark = String(user.remark ?? "").trim();
  const logCount = Number.isFinite(Number(user.logCount)) ? String(Number(user.logCount)) : DASH;
  return `
<tr>
  <td><span class="cell-main">${esc(usernameText(user))}</span><span class="cell-sub">用户标识 ${esc(String(id ?? DASH))}</span></td>
  <td class="time">${esc(formatTime(user.createdAt))}</td>
  <td class="time">${user.lastLoginAt ? esc(formatTime(user.lastLoginAt)) : `<span class="cell-note">还没登录过</span>`}</td>
  <td><span class="tag ${enabled ? "on" : "off"}">${enabled ? "启用中" : "已停用"}</span></td>
  <td class="num">${esc(logCount)}</td>
  <td class="time">${user.latestLogAt ? `<span>${esc(formatTime(user.latestLogAt))}</span><span class="cell-sub">${esc(formatRelative(user.latestLogAt))}</span>` : `<span class="cell-note">没读到日志</span>`}</td>
  <td class="wrap-anywhere">${remark ? esc(maskSecrets(remark)) : `<span class="cell-note">没有备注</span>`}</td>
  <td>
    <div class="actions">
      <button class="btn ${enabled ? "danger" : "secondary"} small" type="button" data-action="${enabled ? "disable-user" : "enable-user"}" data-id="${esc(String(id))}">${enabled ? "停用" : "启用"}</button>
      <a class="btn secondary small" href="${esc(buildHash("#/logs", { userId: String(id) }))}">查看该用户运行日志</a>
      <button class="btn ghost small" type="button" data-action="toggle-user-row" data-id="${esc(String(id))}" aria-expanded="${open ? "true" : "false"}">${open ? "收起" : "密码重置与备注"}</button>
    </div>
  </td>
</tr>
${open ? userDetailRow(user) : ""}`;
}

function userDetailRow(user) {
  const id = user.id;
  const remark = String(user.remark ?? "").trim();
  return `
<tr><td colspan="8">
  <div class="detail">
    <h3>密码重置</h3>
    <p class="cell-note">新密码只在下面的输入框里停留，提交即发给云端；不写浏览器本地存储、不进日志、界面也不回显。成功后云端会撤销该用户的全部会话，他必须重新登录。</p>
    <form data-form="reset-password" data-id="${esc(String(id))}" class="form-row">
      <div class="field wide"><label for="reset-${esc(String(id))}">新密码（8 到 64 个可见 ASCII 字符，且不等于用户名）</label>
        <input id="reset-${esc(String(id))}" name="password" type="password" autocomplete="new-password" spellcheck="false" maxlength="64"></div>
      <button class="btn" type="submit">重置密码</button>
    </form>
    <h3>备注</h3>
    <p class="cell-note">备注最长 200 字，只用于内部排障记录，不要写密码、令牌或联系方式。按开发方案，管理员列表与表单都不回显可能含口令的原文：下面只显示脱敏后的当前内容，保存会整体替换云端已有的备注。</p>
    ${remark ? `<p><span class="cell-main">当前备注（已脱敏）</span><span class="wrap-anywhere">${esc(maskSecrets(remark))}</span></p>` : `<p class="cell-note">云端没有这条备注。</p>`}
    <form data-form="remark" data-id="${esc(String(id))}" class="form-row">
      <div class="field wide"><label for="remark-${esc(String(id))}">新的备注内容（不回填旧值）</label>
        <input id="remark-${esc(String(id))}" name="remark" type="text" maxlength="200" placeholder="重新输入整条备注" autocomplete="off" spellcheck="false"></div>
      <button class="btn secondary" type="submit">保存备注</button>
    </form>
  </div>
</td></tr>`;
}

/* ================= 运行日志 ================= */

export function logsView(state) {
  const panel = state.logs;
  const filters = panel.filters;
  const error = panel.error ? `<div class="notice error" role="alert"><p>${esc(panel.error)}</p></div>` : "";
  const data = panel.data;
  const items = data && Array.isArray(data.items) ? data.items : [];
  const total = data ? Number(data.total) || 0 : 0;
  return `
<section class="page-head">
  <h1>运行日志</h1>
  <p>手机本地运行时上报到云端的运行记录：游戏号添加核验失败、用户启停、种花浇水收花的发出与核验结果、官方错误码、重连与恢复原因、未确认提示以及影响执行的 App 异常。</p>
  <p class="hint">先选软件用户或时间段，再按级别、分类、错误码与关键词缩小范围；行内可以展开完整脱敏诊断与同一次运行的全部事件。</p>
</section>
<section class="notice info">
  <p>${esc(noRecentLogsNotice())}</p>
  <p>${esc(logAcceptedNotice())}</p>
  <p>${esc(sourceNote())}</p>
</section>
<section class="card">
  <h2>筛选</h2>
  <p class="card-desc">已启用 ${esc(String(activeFilterCount(filters)))} 个条件；时间按 ISO 时刻下发，空着的条件不会下发。</p>
  <form data-form="log-filters" class="filters">
    ${textField("log-user", "软件用户标识", "userId", filters.userId, "例如 12")}
    ${textField("log-stable", "游戏号标签：稳定标识", "stableId", filters.stableId, "日志里的 stableId")}
    ${textField("log-nick", "游戏号标签：昵称", "nickname", filters.nickname, "日志里的昵称")}
    ${textField("log-server", "游戏号标签：服务器名", "serverName", filters.serverName, "日志里的服务器名")}
    ${textField("log-from", "发生时间起", "from", filters.from, "", "datetime-local")}
    ${textField("log-to", "发生时间止", "to", filters.to, "", "datetime-local")}
    <div class="field"><label for="log-level">级别</label>
      <select id="log-level" name="level">
        <option value="">全部级别</option>
        ${LOG_LEVELS.map((level) => `<option value="${level}"${filters.level === level ? " selected" : ""}>${esc(level)} · ${esc(levelText(level))}</option>`).join("")}
      </select></div>
    ${textField("log-code", "错误码", "errorCode", filters.errorCode, "例如 SESSION_REVOKED")}
    <div class="field"><label for="log-category">分类</label>
      <select id="log-category" name="category">
        <option value="">全部分类</option>
        ${(data && Array.isArray(data.categories) ? data.categories : []).map((one) => `<option value="${esc(one.category)}"${filters.category === one.category ? " selected" : ""}>${esc(one.category)}${one.legacy ? "（旧分类）" : ""} · ${esc(String(one.count))} 条</option>`).join("")}
      </select></div>
    ${textField("log-trace", "同次运行标识", "traceId", filters.traceId, "traceId")}
    ${textField("log-install", "来源安装标识", "installId", filters.installId, "installId")}
    ${textField("log-operation", "操作标识", "operationId", filters.operationId, "operationId")}
    <div class="field"><label for="log-event-state">事件状态</label><select id="log-event-state" name="eventState">
      <option value="">全部事件状态</option>${["requested", "not-started", "completed", "incomplete", "failed"].map((value) => `<option value="${value}"${filters.eventState === value ? " selected" : ""}>${({ requested: "已请求", "not-started": "未开始", completed: "已完成", incomplete: "未完成", failed: "失败" })[value]}</option>`).join("")}
    </select></div>
    ${textField("log-outcome", "发送结果", "outcomeState", filters.outcomeState, "例如 unconfirmed / failed")}
    <div class="field"><label for="log-attempted">发送尝试</label><select id="log-attempted" name="attempted">
      <option value="">全部</option><option value="true"${filters.attempted === "true" ? " selected" : ""}>已发送</option>
      <option value="false"${filters.attempted === "false" ? " selected" : ""}>未发送</option>
    </select></div>
    ${textField("log-q", "关键词", "q", filters.q, "搜索脱敏消息、错误码、操作标识与诊断", "search", "wide")}
    <div class="field"><label for="log-size">每页条数</label>${pageSizeSelect("log-size", panel.pageSize)}</div>
    <div class="actions">
      <button class="btn" type="submit" ${panel.loading ? "disabled" : ""}>${panel.loading ? "正在读取…" : "查询日志"}</button>
      <button class="btn ghost" type="button" data-action="clear-log-filters" ${activeFilterCount(filters) === 0 ? "disabled" : ""}>清空条件</button>
    </div>
  </form>
</section>
${error}
${logsTable(state, items, total)}
${runPanelView(state)}`;
}

function logsTable(state, items, total) {
  const panel = state.logs;
  if (panel.loading && !panel.data) return `<div class="notice info"><p>正在读取运行日志…</p></div>`;
  if (!items.length) {
    return `<div class="card"><div class="empty"><p>按当前条件没有收到日志记录。</p><p class="cell-note">${esc(noRecentLogsNotice())}</p></div></div>`;
  }
  const rows = items.map((record) => logRow(state, record)).join("");
  return `
<section class="card">
  <h2>日志列表</h2>
  <p class="card-desc">共 ${esc(String(total))} 条；下面显示第 ${esc(String(pageRange(total, panel.page, panel.pageSize).from))} 到 ${esc(String(pageRange(total, panel.page, panel.pageSize).to))} 条，按发生时间倒序。内容与诊断已在显示前再脱敏一次。</p>
  <div class="table-scroll">
    <table>
      <thead><tr>
        <th scope="col" class="time">发生时间</th>
        <th scope="col" class="time">接收时间</th>
        <th scope="col">软件用户</th>
        <th scope="col">游戏号标签</th>
        <th scope="col">级别</th>
        <th scope="col">内容</th>
        <th scope="col">错误码</th>
        <th scope="col">App 版本</th>
        <th scope="col">来源</th>
        <th scope="col">展开</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  ${pager(state, "logs", total, panel.page, panel.pageSize, panel.loading)}
</section>`;
}

function logRow(state, record) {
  const open = panelHas(state.logs.expanded, record.id);
  const errorRow = isErrorRecord(record);
  const label = [record.nickname, record.serverName, record.stableId].filter((value) => String(value ?? "").trim()).map((value) => maskSecrets(String(value))).join(" · ");
  const levelClass = errorRow ? "error" : String(record.level || "").toLowerCase() === "warn" ? "warn" : "info";
  return `
<tr class="${errorRow ? "is-error" : ""}">
  <td class="time">${esc(formatTime(record.occurredAt))}<span class="cell-sub">${esc(maskSecrets(String(record.category || "")))}</span></td>
  <td class="time">${esc(formatTime(record.receivedAt))}</td>
  <td>${record.userId === undefined || record.userId === null ? DASH : `<a class="linklike" href="${esc(buildHash("#/logs", { ...state.logs.filters, userId: String(record.userId) }))}">用户 ${esc(String(record.userId))}</a>`}</td>
  <td class="wrap-anywhere">${label ? esc(label) : `<span class="cell-note">这条记录没有游戏号标签</span>`}</td>
  <td><span class="tag ${levelClass}">${esc(levelText(record.level))}</span></td>
  <td class="wrap-anywhere">${esc(logExcerpt(record))}</td>
  <td>${record.errorCode ? `<span>${esc(errorCodeText(record.errorCode))}</span><span class="cell-sub mono">${esc(String(record.errorCode))}</span>` : DASH}</td>
  <td>${esc(String(record.appVersion || DASH))}</td>
  <td><span class="tag report">手机上报</span><span class="cell-sub mono">${esc(maskSecrets(String(record.installId || "未给出安装标识")))}</span></td>
  <td><button class="btn ghost small" type="button" data-action="toggle-log-detail" data-id="${esc(String(record.id))}" aria-expanded="${open ? "true" : "false"}">${open ? "收起" : "详情"}</button></td>
</tr>
${open ? logDetailRow(record) : ""}`;
}

function logDetailRow(record) {
  const rows = logDetailRows(record);
  const trace = String(record.traceId || "").trim();
  return `
<tr><td colspan="10">
  <div class="detail">
    <h3>完整记录（已脱敏）</h3>
    <dl class="detail-list">
      ${rows.map((row) => `<dt>${esc(row.label)}</dt><dd>${esc(row.value)}</dd>`).join("")}
    </dl>
    <div class="detail-actions">
      ${trace
        ? `<button class="btn secondary small" type="button" data-action="open-run" data-trace="${esc(trace)}" data-user="${esc(String(record.userId ?? ""))}" data-install="${esc(String(record.installId ?? ""))}">展开同次运行</button>
           <button class="btn ghost small" type="button" data-action="filter-by-run" data-trace="${esc(trace)}" data-user="${esc(String(record.userId ?? ""))}" data-install="${esc(String(record.installId ?? ""))}">只看这次运行</button>`
        : `<span class="cell-note">这条记录没有同次运行标识，无法展开同次运行。</span>`}
      <a class="btn ghost small" href="${esc(buildHash("#/logs", { userId: String(record.userId ?? "") }))}">只看这个用户的日志</a>
    </div>
  </div>
</td></tr>`;
}

function runPanelView(state) {
  const run = state.logs.run;
  if (!run.traceId) return "";
  const error = run.error ? `<div class="notice error" role="alert"><p>${esc(run.error)}</p></div>` : "";
  const items = Array.isArray(run.items) ? run.items : [];
  return `
<section class="card">
  <h2>同次运行 ${esc(maskSecrets(run.traceId))}</h2>
  <p class="card-desc">同一 traceId 的全部事件，按发生时间正序；这里只列出云端收到的记录，读不到的步骤界面不会替你补成已完成。</p>
  ${error}
  ${run.loading ? `<div class="notice info"><p>正在读取这次运行的事件…</p></div>` : ""}
  ${items.length
    ? `<ol class="mono event-list">${items.map((item) => `<li>${esc(formatTime(item.occurredAt))} · ${esc(levelText(item.level))} · ${esc(maskSecrets(String(item.category || "")))} · ${esc(logExcerpt(item))}${item.errorCode ? ` · ${esc(errorCodeText(item.errorCode))}` : ""}</li>`).join("")}</ol>`
    : `<div class="empty"><p>这次运行没有读到其他事件。</p></div>`}
  <div class="actions"><button class="btn ghost" type="button" data-action="close-run">收起同次运行</button></div>
</section>`;
}

/* ================= 后台设置 ================= */

export function settingsView(state) {
  const panel = state.settings;
  const data = panel.data || {};
  const retention = data.retention || {};
  const backup = describeBackup(data.backup || {});
  const retentionAudit = data.retentionAudit && typeof data.retentionAudit === "object"
    ? data.retentionAudit : { available: false, items: [] };
  const error = panel.error ? `<div class="notice error" role="alert"><p>${esc(panel.error)}</p></div>` : "";
  const form = panel.form || {};
  const days = form.normalDays ?? retention.normalDays ?? "";
  const errorDays = form.errorDays ?? retention.errorDays ?? "";
  const allow = typeof form.allowRegistration === "boolean" ? form.allowRegistration : data.allowRegistration === true;
  return `
<section class="page-head">
  <h1>后台设置</h1>
  <p>管理员自己的密码、软件注册开关、云端日志保留期限，以及最近一次备份结果。这一页只改本项目云服务的设置，不碰原网页版的后台、配置与数据库。</p>
</section>
${error}
<div class="card-grid">
  <section class="card">
    <h2>管理员修改密码</h2>
    <p class="card-desc">改密要核对当前密码；云端成功后会撤销全部管理员会话，本页面随即回到登录页，需要拿新密码重新登录。新密码不写任何存储，也不会显示在界面上。</p>
    ${panel.passwordMessage ? `<div class="notice ${panel.passwordMessage.kind === "error" ? "error" : "ok"}" role="status"><p>${esc(panel.passwordMessage.text)}</p></div>` : ""}
    <form data-form="admin-password">
      <div class="field"><label for="pwd-current">当前密码</label>
        <input id="pwd-current" name="currentPassword" type="password" autocomplete="current-password" required></div>
      <div class="field"><label for="pwd-next">新密码（8 到 64 个可见 ASCII 字符）</label>
        <input id="pwd-next" name="newPassword" type="password" autocomplete="new-password" maxlength="64" required></div>
      <div class="actions"><button class="btn" type="submit" ${panel.busy === "password" ? "disabled" : ""}>${panel.busy === "password" ? "正在提交…" : "修改密码"}</button></div>
    </form>
  </section>

  <section class="card">
    <h2>软件注册开关</h2>
    <p class="card-desc">关掉后云服务拒绝新的软件注册；已经注册的用户不受影响，仍按各自的启停状态登录。</p>
    <form data-form="settings">
      <label class="checkbox" for="allow-registration"><input id="allow-registration" name="allowRegistration" type="checkbox"${allow ? " checked" : ""}>允许新用户注册</label>
      <h2 class="h-inline">日志保留期限</h2>
      <p class="card-desc">普通记录与错误记录分别保留 1 到 3650 天。手机上的未确认业务账不随云端日志清理。</p>
      <div class="form-row">
        <div class="field"><label for="normal-days">普通记录（天）</label>
          <input id="normal-days" name="normalDays" type="number" min="1" max="3650" step="1" inputmode="numeric" value="${esc(String(days))}"></div>
        <div class="field"><label for="error-days">错误记录（天）</label>
          <input id="error-days" name="errorDays" type="number" min="1" max="3650" step="1" inputmode="numeric" value="${esc(String(errorDays))}"></div>
      </div>
      <div class="actions"><button class="btn" type="submit" ${panel.busy === "settings" ? "disabled" : ""}>${panel.busy === "settings" ? "正在保存…" : "保存设置"}</button>
      <button class="btn ghost" type="button" data-action="reload-settings" ${panel.loading ? "disabled" : ""}>重新读取</button></div>
    </form>
  </section>

  <section class="card">
    <h2>最近备份结果（只读）</h2>
    <p class="card-desc">这里只显示云服务报上来的最近一次备份结论，本后台不触发备份、也不代替恢复演练。</p>
    <dl class="detail-list">
      ${backup.lines.map((line) => `<dt>${esc(line.label)}</dt><dd>${esc(line.value)}</dd>`).join("")}
    </dl>
  </section>

  <section class="card">
    <h2>远端备份保留清单（只读）</h2>
    <p class="card-desc">这里显示备份工具每一轮清理远端时登记的实际结果：留下几份、删掉几份、释放多少，以及那一轮写的依据。后台不触发清理，也不代替恢复演练；云端还没有这张账时如实显示未读到，不拿空表冒充跑过。</p>
    ${retentionAudit.available !== true
    ? '<p class="notice warn">未读到：云端还没有 <code>backup_retention</code> 这张表，说明保留清理至今没有登记过一轮结果。</p>'
    : (retentionAudit.items || []).length === 0
      ? '<p class="notice warn">未读到：表已存在但还没有任何一轮登记（首跑之后才会有行）。</p>'
      : `<table class="table"><thead><tr><th>时刻</th><th>结果</th><th>保留</th><th>删除</th><th>释放</th><th>依据</th></tr></thead><tbody>${retentionAudit.items.map((row) => `<tr><td>${esc(formatTime(row.at))}</td><td>${row.ok === true ? "成功" : row.ok === false ? "失败" : "未读到"}</td><td>${esc(String(Number(row.kept) || 0))} 份</td><td>${esc(String(Number(row.removed) || 0))} 份</td><td>${esc(formatBytes(row.bytes))}</td><td class="cell-note">${esc(String(row.reason || "未读到"))}</td></tr>`).join("")}</tbody></table>`}
  </section>

  <section class="card">
    <h2>当前生效的会话与授权参数（只读）</h2>
    <p class="card-desc">这些值由云服务给出，本页面不修改；读不到就显示未读到，不编默认值。</p>
    <dl class="detail-list">
      <dt>会话有效期</dt><dd>${esc(readNumber(data.sessionTtlMinutes, "分钟"))}</dd>
      <dt>离线宽限</dt><dd>${esc(readNumber(data.graceHours, "小时"))}</dd>
      <dt>授权校验间隔</dt><dd>${esc(readNumber(data.licenseRenewAfterSeconds, "秒"))}</dd>
    </dl>
    <div class="notice info"><p>${esc(noRecentLogsNotice())}</p></div>
  </section>
</div>`;
}

function readNumber(value, unit) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n} ${unit}` : "未读到";
}

/* ================= 公共小块 ================= */

function textField(id, label, name, value, placeholder, type = "text", extraClass = "") {
  return `<div class="field ${extraClass}"><label for="${esc(id)}">${esc(label)}</label>
    <input id="${esc(id)}" name="${esc(name)}" type="${esc(type)}" maxlength="120" placeholder="${esc(placeholder)}" value="${esc(String(value ?? ""))}" autocomplete="off" spellcheck="false"></div>`;
}

function pageSizeSelect(id, value) {
  return `<select id="${esc(id)}" name="pageSize">
    ${PAGE_SIZE_CHOICES.map((size) => `<option value="${size}"${Number(value) === size ? " selected" : ""}>${size} 条</option>`).join("")}
  </select>`;
}

function pager(state, panelKey, total, page, pageSize, loading) {
  const info = pageRange(total, page, pageSize);
  const pages = pageWindow(info.page, info.totalPages);
  const buttons = pages.map((entry, index) => {
    if (entry === 0) return `<span class="ellipsis" aria-hidden="true">…</span>`;
    const current = entry === info.page;
    return `<button class="btn ${current ? "" : "ghost"} small${current ? " current" : ""}" type="button" data-action="page" data-panel="${esc(panelKey)}" data-page="${entry}"${current ? ' aria-current="page"' : ""} ${loading ? "disabled" : ""}>${entry}</button>`;
  }).join("");
  return `<div class="pager">
    <span class="count">第 ${esc(String(info.page))} / ${esc(String(info.totalPages))} 页 · 共 ${esc(String(info.total))} 条 · 每页 ${esc(String(info.pageSize))} 条</span>
    <div class="actions">
      <button class="btn ghost small" type="button" data-action="page" data-panel="${esc(panelKey)}" data-page="${info.page - 1}" ${info.page <= 1 || loading ? "disabled" : ""}>上一页</button>
      <span class="pages">${buttons}</span>
      <button class="btn ghost small" type="button" data-action="page" data-panel="${esc(panelKey)}" data-page="${info.page + 1}" ${info.page >= info.totalPages || loading ? "disabled" : ""}>下一页</button>
    </div>
  </div>`;
}

function panelHas(set, id) {
  if (!set || typeof set.has !== "function") return false;
  return set.has(String(id));
}
