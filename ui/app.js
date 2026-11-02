/* Local-only Android panel. All game actions are performed by the local API.
   No credential, session token or account config is written to browser storage. */
"use strict";
(() => {
  /* 启动期脚本错误要能被看见：直接写一条到屏上，别只留白屏。 */
  window.addEventListener("error", event => {
    try {
      const box = document.createElement("pre");
      box.id = "boot-error";
      box.style.cssText = "position:fixed;z-index:99;left:0;right:0;top:0;margin:0;padding:12px;background:#fff;color:#8f4356;font-size:13px;white-space:pre-wrap";
      box.textContent = "界面脚本报错：" + (event.message || "") + " @" + (event.filename || "").split("/").pop() + ":" + (event.lineno || "");
      document.body.appendChild(box);
    } catch { /* 连报错框都建不出来时保持原样 */ }
  });
  const $ = (selector, root = document) => root.querySelector(selector);
  // 本次 WebView 实际加载的那份 app.js 自己的构建标识：由打包脚本在生成产物时替换成真实值，
  // 旧 JS 不会带着新值——它读到的仍是自己那份里烙着的旧串（运行标记必须来自各自加载的代码）。
  const CLIENT_BUILD_ID = "GARDEN_CLIENT_BUILD_ID_PLACEHOLDER";
  const main = $("#main");
  const state = {
    tab: "accounts", online: false, loading: true, refreshing: false,
    status: {}, accounts: [], accountsReadState: "loading", accountsError: "", selectedId: "", device: {}, flowers: [],
    metadata: {}, groupSizes: [], plantModes: [], qualities: [], catalogReady: false, catalogLoading: false, catalogError: "", catalogSource: null,
    config: null, draft: null, configError: "", configLoading: false,
    /* 设置页**内层**的分类：切分类不重新请求默认值、不清未保存标记（底部导航仍是 state.tab）。 */
    settingsTab: "land",
    flowerArts: [],
    /* 「?」展开的说明键，只放内存：重开页面回到全部收起，不落本地存储。 */
    help: new Set(),
    observations: null, observationsRead: null,
    logs: [], logsError: "", logsLoading: false, logsScope: "account", logsNotice: "", logsContinuation: null,
    logsCategory: "", logsDay: "", logsKeyword: "", logsLevel: "", logsOutcome: "", logsErrorCode: "", logsTraceId: "", logsOperationId: "", logDays: [], logCategories: [],
    archivedLogSources: [], archivedLogSourcesLoading: false, archivedLogSourcesError: "",
    logsStack: [], logsHasMore: false, logsOlder: null,
    dirty: false, busy: "",
    /* 游戏号页的筛选页签：全部／运行中／已停止（只影响列表显示，不改任何真实状态）。 */
    accountFilter: "all",
    egress: null, egressDraft: "", egressEditing: false, egressError: "",
    /* 软件账号只在内存里：不写浏览器本地存储，刷新页面就重新登录。 */
    software: null, authDraft: { username: "", password: "" }, authBusy: false, authError: "", authErrorMeta: null, authRetryAt: 0, registerRetryAt: 0, authRevealed: false,
    engine: { generation: 0, phase: window.AndroidBridge ? "starting" : "ready", instanceId: "", message: "正在准备手机运行服务…" },
    panelResults: {}, authOperation: null, backgroundSettings: null,
    lastUpdated: null,
  };
  const icons = {
    leaf: '<path d="M12 21V11M12 15C4 17 3 10 4 5c6-1 9 4 8 10Zm0-4c-1-6 3-9 9-8 1 6-3 9-9 8Z"/>',
    accounts: '<rect x="3" y="5" width="18" height="16" rx="4"/><path d="M8 3v4m8-4v4M3 10h18m-13 5h3m3 0h2"/>',
    settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2" fill="currentColor"/><circle cx="16" cy="12" r="2" fill="currentColor"/><circle cx="8" cy="18" r="2" fill="currentColor"/>',
    logs: '<path d="M7 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h1Zm8 0v5h4M9 12h6m-6 4h6"/>',
    me: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a7 7 0 0 1 7-6h2a7 7 0 0 1 7 6v2"/>',
    add: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    play: '<path d="m8 5 11 7-11 7V5Z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="m3 3 18 18M10.6 5.1A11 11 0 0 1 12 5c6.5 0 10 7 10 7a20 20 0 0 1-3.2 4.1M6.1 6.1C3.4 8.3 2 12 2 12s3.5 7 10 7c2.1 0 4-.7 5.6-1.7M10 10a3 3 0 0 0 4 4"/>',
    lock: '<rect x="5" y="10" width="14" height="10" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    more: '<circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/>',
    box: '<rect x="4" y="4" width="16" height="16" rx="4"/>',
    book: '<path d="M4 5a2 2 0 0 1 2-2h5v18H6a2 2 0 0 1-2-2V5Zm16 0a2 2 0 0 0-2-2h-5v18h5a2 2 0 0 0 2-2V5Z"/>',
    spark: '<path d="M12 3v6m0 6v6M3 12h6m6 0h6M6.5 6.5l3 3m5 5 3 3m0-11-3 3m-5 5-3 3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    sprout: '<path d="M12 21v-7M12 14c0-3-2-5-5-5 0 3 2 5 5 5Zm0 0c0-3 2-5 5-5 0 3-2 5-5 5Z"/>',
    bloom: '<circle cx="12" cy="9" r="3"/><path d="M12 12v9M8 18c2 0 3-1 4-2 1 1 2 2 4 2"/>',
    drop: '<path d="M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11Z"/>',
    moon: '<path d="M20 15.5A8 8 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>',
    listFilter: '<path d="M2 5h20M6 12h12M9 19h6"/>',
    calendar: '<path d="M8 2v4M16 2v4"/><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    chevronsUpDown: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  };
  function icon(name) { return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.leaf}</svg>`; }
  function esc(value) { return String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char])); }
  function sameId(a, b) { return String(a) === String(b); }
  function selected() { return state.accounts.find(account => sameId(account.id, state.selectedId)) || null; }
  function accountName(account) { const raw = account.remark || account.nickname || account.name || "游戏账号"; return String(raw).replace(/^s\d+\./,""); }
  function accountState(account) { return String(account.state || account.status || account.runtime?.state || (account.running === true ? "running" : "unknown")); }
  const pendingStates = new Set(["starting", "connecting", "queued", "recovering", "waiting_network", "waiting_login", "waiting_authorization", "stopping"]);
  function isPending(account) {
    const status = accountState(account);
    /* 只要还有运行意图，就不是「已停止」：blocked/failed 也必须只给停止，
       否则弹层关掉后卡片会错误地再给一个开始按钮。 */
    return pendingStates.has(status) || (account.desiredRunning === true && status !== "running");
  }
  // A waiting task still owns the user's run intent. Its only action is stop;
  // it must never display a second start button or count as a connected game.
  function canStop(account) { return account.desiredRunning === true || account.running === true || ["running", "stopping", "cleanup-required"].includes(accountState(account)) || isPending(account); }
  function canPersistAccountStop(account) { return Boolean(account && typeof account.ownerRef === "string" && account.ownerRef
    && typeof account.accountRef === "string" && account.accountRef && typeof account.subjectRef === "string" && account.subjectRef
    && Number.isSafeInteger(account.uid) && account.uid > 0); }
  function stateLabel(account) {
    const status = accountState(account);
    if (isPending(account) && ["stopped", "idle", "unknown"].includes(status)) return "等待恢复";
    return ({running:"运行中",starting:"正在启动",connecting:"正在连接",stopping:"正在停止",stopped:"已停止",idle:"未运行",queued:"等待运行",failed:"运行中断",error:"运行中断",recovering:"正在恢复",waiting_network:"等待网络恢复",waiting_login:"等待允许登录",waiting_authorization:"等待软件授权核验","cleanup-required":"需要重新停止",blocked:"已暂停",unknown:"状态未读到"})[status] || "状态未读到";
  }
  function runningCount() { return state.accounts.filter(account => accountState(account) === "running").length; }
  function pendingCount() {
    const reported = state.status.runtime?.pendingCount;
    return Number.isInteger(reported) && reported >= 0 ? reported : state.accounts.filter(isPending).length;
  }
  function accountNote(account) {
    const note = account.lastError || account.latestMessage || account.message || account.runtime?.message;
    const status = accountState(account);
    const fallback = isPending(account) ? "已保留运行安排，条件满足后会核对游戏状态再继续；你可以随时停止。" : status === "running" ? "按当前账号设置照料花园" : ["stopped","idle"].includes(status) ? "已停止，等你重新安排" : "选择需要的功能，保存后即可开始。";
    const retryAt = isPending(account) && account.retryAt ? ` 下次尝试：${dateText(account.retryAt)}。` : "";
    return String(note || fallback) + retryAt;
  }
  function bridgeCall(name) {
    try {
      const bridge = window.AndroidBridge;
      if (!bridge || typeof bridge[name] !== "function") return null;
      const value = bridge[name]();
      if (typeof value === "string" && value.startsWith("{")) { try { return JSON.parse(value); } catch { return value; } }
      return value;
    } catch { return null; }
  }
  let nativeReconnectRequested = false;
  let acceptedNativeWindow = null;
  let pendingAuthHandoff = null;
  const randomRequestHex = () => {
    try { return [...window.crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, "0")).join(""); }
    catch { return ""; }
  };
  const newStopCommandId = () => {
    const hex = randomRequestHex();
    return hex ? `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-${((parseInt(hex[16],16)&3)|8).toString(16)}${hex.slice(17,20)}-${hex.slice(20,32)}` : "";
  };
  const backgroundPageNonce = randomRequestHex();
  let backgroundSettingsPending = null, backgroundAuthEpoch = 0;
  const panelOperations = new Map();
  let panelOperationSequence = 0;
  const apiControllers = new Set();
  function localFailure(message, code = "LOCAL_ENGINE_BINDING") { return Object.assign(new Error(message), { code, scope: "local-engine" }); }
  function engineReady() { return !pendingAuthHandoff && state.engine.phase === "ready"; }
  function applyEngineState(next) {
    if (!next || !Number.isInteger(Number(next.generation)) || Number(next.generation) < state.engine.generation) return;
    const changed = Number(next.generation) !== state.engine.generation || (state.engine.instanceId && next.instanceId !== state.engine.instanceId);
    const previousPhase = state.engine.phase;
    state.engine = { generation: Number(next.generation), phase: String(next.phase || "starting"), instanceId: String(next.instanceId || ""), message: safeError({ message: next.message }, "正在重新连接手机运行服务…") };
    if (changed) {
      invalidateBackgroundSettings(true);
      invalidateOptionalStatusReads();
      pauseDraftTransactions("手机服务已更换连接，当前页面中的编辑继续保留；就绪后请重新核对同一游戏号的设置。");
      configRequest++; configRead=null; state.configLoading=false;
      for (const controller of apiControllers) controller.abort("engine-generation-changed");
      panelOperations.clear(); state.panelResults = {}; state.authOperation = null; state.busy = ""; state.authBusy = false;
      state.online = false; state.accountsReadState = "loading"; state.accountsError = "";
      state.config = null; state.draft = null; clearObservations();
      invalidateLogRead(); state.logs = []; state.logsError = ""; state.logDays = []; state.logCategories = []; resetLogsPage();
      state.catalogReady = false; state.catalogLoading = false; state.catalogError = ""; state.catalogSource = null;
      state.authError = ""; state.authErrorMeta = null;
    }
    if (!["binding", "ready"].includes(state.engine.phase)) {
      state.online = false;
      pauseDraftTransactions(state.engine.message || "手机服务连接暂未就绪，编辑继续保留，请重新连接后核对设置。");
    }
    renderConnection();
    if ($("#software-auth-form")) syncAuth();
    repaintCurrentNativeServiceReadLayer();
    updateDraftTransactionUI();
    if (state.engine.phase === "binding" && previousPhase !== "binding") void refresh({ quiet: true });
  }
  const NATIVE_SERVICE_READ_IDS = new Set(["service", "service-loading", "service-disconnected", "service-unread", "connection-help"]);
  function nativeServiceReadContext(overlay = null) {
    const frame = dialogFrames[dialogFrames.length - 1];
    if (!frame?.nativeServiceRead || !frame.overlay?.isConnected || overlay && overlay !== frame.overlay
      || frame.nativeServiceRead.softwareUserId !== softwareUserId()) return null;
    return { frame, overlay: frame.overlay, generation: state.engine.generation,
      instanceId: state.engine.instanceId, softwareUserId: softwareUserId() };
  }
  function sameNativeServiceReadContext(context) {
    return Boolean(context && dialogFrames[dialogFrames.length - 1] === context.frame
      && context.frame.overlay === context.overlay && context.overlay.isConnected
      && softwareUserId() === context.softwareUserId && context.frame.nativeServiceRead?.softwareUserId === context.softwareUserId
      && state.engine.generation === context.generation && state.engine.instanceId === context.instanceId);
  }
  function bindNativeServiceReadLayer(overlay, id, repaint = null) {
    if (!NATIVE_SERVICE_READ_IDS.has(id)) return;
    const frame = dialogFrames.find(one => one.overlay === overlay);
    if (!frame) return;
    frame.nativeServiceRead = { id, softwareUserId: softwareUserId(), repaint: repaint || (isCurrent => {
      const scroll = overlay.querySelector(".panel-scroll");
      if (!scroll || scroll.querySelector('form,input,textarea,select,[contenteditable="true"]')) return;
      const next = window.MoonUI?.fieldsHTML?.(id);
      if (typeof next !== "string" || !isCurrent()) return;
      const keep = scroll.scrollTop, signature = focusSignature(document.activeElement);
      scroll.innerHTML = next; scroll.scrollTop = keep;
      if (isCurrent()) restoreFocus(overlay, signature);
    }) };
  }
  function repaintCurrentNativeServiceReadLayer() {
    const context = nativeServiceReadContext();
    if (!context) return;
    // The accepted callback owns this synchronous paint. Do not bind the layer forever to
    // its opening generation: a normal reconnect must be able to show its new real phase.
    context.frame.nativeServiceRead.repaint(() => sameNativeServiceReadContext(context));
  }
  function readNativeEngineState() {
    const next = bridgeCall("engineState");
    if (next && typeof next === "object") applyEngineState(next);
    return state.engine;
  }
  window.onGardenEngineState = applyEngineState;
  function reconnectNativeEngine(explicit = false) {
    if (nativeReconnectRequested && !explicit) return;
    if (!window.AndroidBridge || typeof window.AndroidBridge.reconnectEngine !== "function") return;
    nativeReconnectRequested = true;
    bridgeCall("reconnectEngine");
  }
  function safeError(error, fallback = "操作未完成，请稍后重试。") {
    if (error?.diagnostic && typeof error.message === "string") return error.message;
    const message = error?.messageZh || error?.message || "";
    // Server diagnostics stay out of the panel. Only short Chinese copy is eligible.
    if (typeof message === "string" && /[\u3400-\u9fff]/.test(message) && message.length <= 180 && !/(password|token|secret|stack|https?:|\bat\s|authorization)/i.test(message)) return message;
    return fallback;
  }
  const PANEL_FAMILIES = {
    save: ["save-pending", "save-success", "save-error"],
    sync: ["sync-busy", "sync-success", "sync-error", "sync-empty"],
    license: ["license-checking", "license-error"],
    ownership: ["data-ownership-busy", "data-ownership-success", "data-ownership-error", "data-ownership-empty"],
    network: ["network-loading", "network-proxy", "network-direct", "network-error"],
    add: ["add-account-verifying", "add-account-success", "add-account-partial", "add-account-unverified", "add-account-error"],
    remove: ["remove-account-busy", "remove-account-success", "remove-account-error"],
    password: ["password-busy", "password-success", "password-error"],
    logout: ["logout-busy", "logout-error"],
    login: ["auth-login-loading", "auth-login-success", "auth-error"],
    register: ["auth-register-loading", "auth-register-success", "auth-error"],
  };
  function softwareUserId() { return String(state.software?.user?.id ?? ""); }
  function beginPanelOperation(family, pendingId, message, accountId) {
    if (["login", "register", "logout", "password"].includes(family)) {
      backgroundAuthEpoch++; invalidateBackgroundSettings(true); invalidateDirtyNavigation();
    }
    const operation = { family, sequence: ++panelOperationSequence, generation: state.engine.generation,
      instanceId: state.engine.instanceId, softwareUserId: softwareUserId(),
      ...(accountId === undefined ? {} : { accountId: String(accountId) }), dismissed: false, overlay: null };
    panelOperations.set(family, operation);
    for (const id of PANEL_FAMILIES[family] || []) delete state.panelResults[id];
    if (family === "login" || family === "register") state.authOperation = { kind: family, sequence: operation.sequence, status: "pending", at: new Date().toISOString() };
    recordPanelOperation(operation, "pending", message, undefined, [pendingId]);
    return operation;
  }
  function currentPanelOperation(operation) {
    return panelOperations.get(operation.family) === operation && operation.generation === state.engine.generation
      && operation.instanceId === state.engine.instanceId && operation.softwareUserId === softwareUserId();
  }
  function publicAddPanelFacts(value, secretValues = []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const facts = {};
    let redacted = value.redacted === true, truncated = value.truncated === true;
    const text = (raw, limit) => {
      if (typeof raw !== "string" || !raw.trim()) return undefined;
      let clean = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
      for (const secret of secretValues) if (typeof secret === "string" && secret && clean.includes(secret)) {
        clean = clean.split(secret).join("[已隐藏]"); redacted = true;
      }
      clean = clean.replace(/\b(?:https?|socks[45]?):\/\/[^\s，。；]+/gi, () => { redacted = true; return "[地址已隐藏]"; });
      clean = clean.replace(/((?:password|passwd|pwd|token|authorization|cookie|credential|secret|proxy|username|密码|口令)\s*[:=：]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;，；。]+)/gi,
        (_match, key) => { redacted = true; return key + "[已隐藏]"; });
      if (clean.length > limit) { clean = clean.slice(0, limit - 7) + "…（已截断）"; truncated = true; }
      return clean || undefined;
    };
    for (const key of ["code", "loginCodeKey", "serverMsgKey"]) {
      if (typeof value[key] === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(value[key])) facts[key] = value[key];
    }
    for (const key of ["loginCode", "serverMsgCode", "remoteCode", "httpStatus"]) {
      const raw = value[key];
      if (raw !== null && raw !== undefined && raw !== "" && typeof raw !== "boolean" && Number.isSafeInteger(Number(raw))) {
        const n = Number(raw);
        if ((key !== "httpStatus" || n >= 100 && n <= 599) && (key !== "loginCode" || n !== 0)) facts[key] = n;
      }
    }
    for (const [key, limit] of [["summary", 400], ["officialMessage", 1600], ["verifiedNickname", 80], ["verifiedServer", 80]]) {
      const clean = text(value[key], limit); if (clean) facts[key] = clean;
    }
    for (const key of ["identityVerified", "rosterReadBack", "running", "desiredRunning"]) if (typeof value[key] === "boolean") facts[key] = value[key];
    if (Array.isArray(value.missing)) {
      facts.missing = [...new Set(value.missing.slice(0, 32).map(one => text(one, 40)).filter(Boolean))];
      facts.missingComplete = value.missing.length <= 32 && value.missing.every(one => typeof one === "string" && one.trim() && one.length <= 40);
    }
    facts.redacted = redacted; facts.truncated = truncated;
    return facts;
  }
  function recordPanelOperation(operation, status, message, count, ids = PANEL_FAMILIES[operation.family], facts = null, secretValues = []) {
    if (!currentPanelOperation(operation)) return false;
    // Only short customer copy is stored. No response object, request body, address or credential is retained.
    const panelMessage = operation.family === "add" ? publicAddPanelFacts({ summary: message }, secretValues)?.summary : message;
    const safeMessage = typeof panelMessage === "string" && panelMessage.length <= 400
      && !/https?:|(?:password|authorization|secret|token)\s*[:=]|[^\s:]+:[^@\s]+@/i.test(panelMessage)
      ? panelMessage : "这一步的结果请从当前实际状态核对。";
    const addFacts = operation.family === "add" ? publicAddPanelFacts(facts, secretValues) : null;
    const result = { family: operation.family, sequence: operation.sequence, status, at: new Date().toISOString(), softwareUserId: operation.softwareUserId,
      ...(operation.accountId === undefined ? {} : { accountId: operation.accountId }), message: safeMessage,
      ...(Number.isFinite(count) && count >= 0 ? { count } : {}), ...(addFacts ? { facts: addFacts } : {}) };
    for (const id of ids || []) state.panelResults[id] = { ...result };
    if ((operation.family === "login" || operation.family === "register") && state.authOperation?.sequence === operation.sequence) {
      state.authOperation = { kind: operation.family, sequence: operation.sequence, status, at: result.at, message: result.message };
    }
    return true;
  }
  function uncertainOperation(error) {
    return !error?.status || Number(error.status) >= 500 || /TIMEOUT|STALE|LATE|UNKNOWN/.test(String(error.code || ""));
  }
  function showPanelProgress(operation, id) {
    if (!window.MoonUI?.sheetHTML || !currentPanelOperation(operation)) return;
    operation.overlay = showMoonSheet(window.MoonUI.sheetHTML(id, dialogFrames.length + 1), () => {
      if (!operation.replacing) { operation.dismissed = true; operation.onDismiss?.(); }
    });
  }
  function finishPanelFeedback(operation, id, onClose = null) {
    if (!currentPanelOperation(operation) || operation.dismissed || !operation.overlay?.isConnected
      || dialogFrames[dialogFrames.length - 1]?.overlay !== operation.overlay
      || operation.accountId !== undefined && !sameId(operation.accountId, state.selectedId)) return false;
    operation.replacing = true;
    closeDialog();
    operation.replacing = false;
    if (id && window.MoonUI?.sheetHTML) showMoonFeedback(id, onClose);
    return true;
  }
  async function api(path, options = {}) {
    readNativeEngineState();
    if (options.expectedContext && !sameReadContext(options.expectedContext)) throw localFailure("软件身份或手机服务连接已变化，本次请求没有提交。", "LOCAL_REQUEST_STALE");
    if (pendingAuthHandoff && !["/status", "/software/status"].includes(path)) throw localFailure(pendingAuthHandoff.message, "LOCAL_AUTH_HANDOFF");
    if (window.AndroidBridge && !["binding", "ready"].includes(state.engine.phase)) throw localFailure(state.engine.message || "手机运行服务尚未就绪，登录没有提交。");
    if (window.AndroidBridge && options.method && options.method !== "GET" && !engineReady()) throw localFailure("正在核对当前软件身份，连接就绪后即可操作；本次没有提交。");
    const requestGeneration = state.engine.generation;
    const requestInstance = state.engine.instanceId;
    const controller = new AbortController();
    apiControllers.add(controller);
    const abortFromCaller = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abortFromCaller();
    else options.signal?.addEventListener("abort", abortFromCaller,{once:true});
    const timer = window.setTimeout(() => controller.abort(), Number(options.timeoutMs) || 25000);
    const headers = { Accept: "application/json" };
    const token = bridgeCall("sessionToken");
    if (typeof token === "string" && token) headers.Authorization = `Bearer ${token}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    try {
      const response = await fetch(`/api/local${path}`, {
        method: options.method || "GET", headers, cache: "no-store",
        credentials: "same-origin", signal: controller.signal,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      let data;
      try { data = await response.json(); } catch { throw new Error("手机运行服务返回的数据暂时无法读取，请刷新。 "); }
      readNativeEngineState();
      if (requestGeneration !== state.engine.generation || requestInstance !== state.engine.instanceId) throw localFailure("手机运行服务已换到新连接，旧请求结果没有应用。", "LOCAL_REQUEST_STALE");
      if (options.expectedContext && !sameReadContext(options.expectedContext)) throw localFailure("软件身份或手机服务连接已变化，旧请求结果没有应用。", "LOCAL_REQUEST_STALE");
      if (!response.ok || data?.ok === false) {
        const error = new Error(safeError({ message: data?.messageZh || data?.message || data?.error?.message || data?.error }, response.status === 401 ? "连接校验已失效，请重新打开 App。" : "操作未完成，请刷新后重试。"));
        error.status = response.status;
        error.code = typeof data?.code === "string" ? data.code : "LOCAL_REQUEST_FAILED";
        error.scope = ["local-engine", "software-local", "software-cloud"].includes(data?.scope) ? data.scope : path.startsWith("/software/") ? "software-local" : "local-engine";
        if (data?.retryAfterMs != null && Number.isFinite(Number(data.retryAfterMs))) error.retryAfterMs = Math.max(0, Number(data.retryAfterMs));
        if (typeof data?.requestId === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(data.requestId)) error.requestId = data.requestId;
        if (data?.diagnostic && typeof data.diagnostic === "object") {
          error.diagnostic = data.diagnostic;
          const details = data.diagnostic;
          const lines = [String(data.error || details.summary || error.message)];
          if (details.loginCode !== undefined) lines.push(`官方登录码：${details.loginCode}${details.loginCodeKey ? `（${details.loginCodeKey}）` : ""}`);
          if (details.serverMsgCode !== undefined) lines.push(`官方游戏码：${details.serverMsgCode}${details.serverMsgKey ? `（${details.serverMsgKey}）` : ""}`);
          if (details.remoteCode !== undefined && details.remoteCode !== details.loginCode) lines.push(`官方返回码：${details.remoteCode}`);
          if (details.httpStatus !== undefined) lines.push(`HTTP 状态：${details.httpStatus}`);
          lines.push(details.officialMessage ? `官方原文：${details.officialMessage}` : "官方未提供原文。");
          if (details.redacted || details.truncated) lines.push([details.redacted ? "原文中的凭据已隐藏" : "", details.truncated ? "超长原文已截断" : ""].filter(Boolean).join("；"));
          error.message = [...new Set(lines)].join("\n");
        }
        throw error;
      }
      return data;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (requestGeneration !== state.engine.generation || requestInstance !== state.engine.instanceId || controller.signal.reason === "engine-generation-changed") throw localFailure("手机运行服务正在切换，旧请求已停止；没有自动重提。", "LOCAL_REQUEST_STALE");
      if (error.name === "AbortError" || error instanceof TypeError || error.code === "LOCAL_TOKEN_INVALID") {
        // Secondary GETs report their own read error. They must not turn a verified
        // /status handshake back into binding merely because one optional read is slow.
        if (!options.optionalRead || !["GET", "HEAD"].includes(options.method || "GET")) reconnectNativeEngine();
        if (error.name === "AbortError") throw localFailure("手机运行服务没有及时返回，请重新连接后核对实际结果；不会自动重复提交。", "LOCAL_ENGINE_TIMEOUT");
        if (error instanceof TypeError) throw localFailure("手机运行服务连接中断，正在重新检查；尚不能判断本次是否送达云端。", "LOCAL_ENGINE_UNREACHABLE");
      }
      throw error;
    } finally { apiControllers.delete(controller); window.clearTimeout(timer); options.signal?.removeEventListener("abort",abortFromCaller); }
  }
  let toastTimer;
  function toast(message) {
    const element = $("#toast");
    element.textContent = message; element.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { element.hidden = true; }, 4000);
  }
  function renderNavigation() {
    // 原型底部导航：游戏号用一株芽、设置用滑块、日志用单据、我的用人形。
    const tabs = [["accounts", "游戏号", "sprout"], ["settings", "设置", "settings"], ["logs", "日志", "logs"], ["me", "我的", "me"]];
    $("#navigation").innerHTML = tabs.map(([key, label, iconName]) => `<button class="tab" type="button" data-tab="${key}" ${state.tab === key ? 'aria-current="page"' : ""}><span class="tab-icon">${icon(iconName)}</span><span>${label}</span></button>`).join("");
  }
  function renderConnection() {
    const element = $("#connection");
    if (!element) return;
    element.className = `connection${state.online ? " is-ready" : state.loading ? "" : " is-error"}`;
    element.textContent = state.loading ? "正在连接"
      : state.online ? (runningCount() ? `本机运行 · ${runningCount()} 个在跑` : "本机运行")
        : "未连接 · 点此刷新";
  }
  /* 视图头部：原型是「大号衬线标题＋一句副标题」在左，右上一个控件（添加／账号胶囊／筛选）。 */
  function pageHead(title, caption, right = "") {
    return `<div class="view-head"><div><h1>${esc(title)}</h1><p class="head-sub">${esc(caption)}</p></div>${right ? `<div class="head-slot">${right}</div>` : ""}</div>`;
  }
  /* 分组行：左组名、右提示，原型在每张卡上面给一句「点开卡片查看全部设置」。 */
  function sectionRow(title, hint) { return `<div class="section-row"><h2>${esc(title)}</h2>${hint ? `<span>${esc(hint)}</span>` : ""}</div>`; }
  function accountPill() {
    const account = selected();
    const name = account ? accountName(account) : "还没选账号";
    return `<button class="acct-pill" type="button" data-action="pick-account" aria-label="切换当前游戏号"><span class="avatar" aria-hidden="true">${esc(name.slice(0, 1))}</span><span class="acct-name">${esc(name)}</span></button>`;
  }
  function accountPickerSheet() {
    showAccountChoice(false);
  }
  function accountChoiceContext() {
    return { ...readContext(), tab: state.tab, selectedId: String(state.selectedId), logsScope: state.logsScope };
  }
  function accountChoiceProblem(context, value, logs) {
    if (!context.softwareUserId || !sameReadContext(context) || signedIn() !== true || !engineReady()) return "软件身份或手机服务连接已变化，请关闭后在连接就绪时重新选择。";
    if (context.tab !== state.tab || context.selectedId !== String(state.selectedId) || context.logsScope !== state.logsScope)
      return "当前查看对象已变化，这次选择没有应用，请重新打开。";
    if (state.busy || state.authBusy) return "当前操作尚未结束，请等待实际结果后再切换查看对象。";
    if (logs && value === "device") return "";
    if (logs && isArchivedLogRef(value)) return logScopeProblem(value);
    if (state.accountsReadState !== "ready") return state.accountsReadState === "error"
      ? state.accountsError || "游戏号名册读取失败，请重新连接后再选择。" : "游戏号名册正在读取，请读取完成后重新选择。";
    if (!value || !state.accounts.some(account => sameId(account.id, value))) return "这个游戏号已不在当前名册中，请重新读取后再选择。";
    return "";
  }
  async function showAccountChoice(logs) {
    const context = accountChoiceContext();
    if (logs) {
      await loadArchivedLogSources({ force: true });
      if (!sameReadContext(context) || context.tab !== state.tab || context.selectedId !== String(state.selectedId) || context.logsScope !== state.logsScope) return;
    }
    const rows = logs ? [{ value: "device", label: "本机 / 添加记录", description: "这台手机与添加游戏号的过程" }] : [];
    if (state.accountsReadState === "ready") for (const account of state.accounts) {
      rows.push({ value: String(account.id), label: accountName(account), description:
        `${account.serverName || (account.serverId ? `${account.serverId} 服` : "区服未读到")} · ${stateLabel(account)}` });
    }
    if (logs) rows.push(...logSourceOptions().filter(one => isArchivedLogRef(one.value)));
    let pending = logs ? logSourceRef() : String(state.selectedId);
    if (!rows.some(one => one.value === pending)) pending = "";
    const rosterNote = [state.accountsReadState === "ready" ? (!state.accounts.length ? "这台手机还没有添加游戏号。" : "")
      : state.accountsReadState === "error" ? state.accountsError || "游戏号名册读取失败，请重新连接后再选择。"
        : "正在读取当前软件账号的游戏号名册，请读取完成后重新打开。", logs ? state.archivedLogSourcesError : ""].filter(Boolean).join(" ");
    const name = `account-choice-${dialogFrames.length + 1}`;
    const body = `<fieldset class="field-block panel-fieldset"><legend class="field-caption"><strong>${logs ? "日志来源" : "当前游戏号"}</strong></legend><div class="option-list">${rows.map(one => `<label class="panel-choice"><input type="radio" name="${name}" value="${esc(one.value)}" data-account-choice ${one.value === pending ? "checked" : ""}><span class="option-copy"><strong>${esc(one.label)}</strong><small>${esc(one.description)}</small></span></label>`).join("")}</div></fieldset>
      ${rosterNote ? `<div class="panel-note"><strong>${logs ? "日志来源读取状态" : "名册读取状态"}</strong>${esc(rosterNote)}</div>` : ""}
      <div class="panel-note"><strong>切换范围</strong>${logs ? "只切换当前查看的日志来源，分类与日期筛选继续保留；切换后从第一页读取。已有运行安排不会改变。" : "设置与日志只展示所选账号。已有运行安排不会因切换查看对象而改变。"}</div><p class="field-error" role="alert" hidden></p>`;
    let alive = true, submitted = false;
    const overlay = showDialog(logs ? "选择日志来源" : "选择游戏号", body, dialogActions(
      '<button class="button secondary" type="button" data-account-choice-cancel>取消</button>',
      `<button class="button primary-button" type="button" data-account-choice-apply>${logs ? "切换来源" : "切换账号"}</button>`),
      logs ? "log-scope-picker-sheet" : "account-picker-sheet", () => {
        alive = false;
        overlay.removeEventListener("change", onChange);
        overlay.removeEventListener("click", onClick);
      });
    const apply = overlay.querySelector("[data-account-choice-apply]");
    const error = overlay.querySelector(".field-error");
    const isTop = () => alive && overlay.isConnected && dialogFrames[dialogFrames.length - 1]?.overlay === overlay;
    const fail = message => { error.textContent = message; error.hidden = false; apply.disabled = true; };
    function onChange(event) {
      const input = event.target.closest?.("[data-account-choice]");
      if (!input || !isTop() || submitted || !input.checked) return;
      pending = input.value;
      const problem = accountChoiceProblem(context, pending, logs);
      if (problem) fail(problem); else { error.hidden = true; error.textContent = ""; apply.disabled = false; }
    }
    function onClick(event) {
      const button = event.target.closest?.("[data-account-choice-apply],[data-account-choice-cancel]");
      if (!button || !isTop()) return;
      event.preventDefault(); event.stopPropagation();
      if (button.hasAttribute("data-account-choice-cancel")) { closeDialog(); return; }
      if (submitted) return;
      const problem = accountChoiceProblem(context, pending, logs);
      if (problem) { fail(problem); return; }
      submitted = true; apply.disabled = true;
      const unchanged = logs ? pending === logSourceRef() : sameId(pending, state.selectedId);
      closeDialog();
      if (unchanged) return;
      const intent = { context, ...(logs ? { logs: { scope: pending, category: state.logsCategory, day: state.logsDay,
        traceId: "", operationId: "", errorCode: state.logsErrorCode, keyword: state.logsKeyword, level: state.logsLevel, outcomeState: state.logsOutcome } } : {}) };
      void changeTab(logs ? "logs" : context.tab, logs && (pending === "device" || isArchivedLogRef(pending)) ? undefined : pending, intent);
    }
    overlay.addEventListener("change", onChange);
    overlay.addEventListener("click", onClick);
    apply.disabled = !pending || Boolean(accountChoiceProblem(context, pending, logs));
  }
  function emptyAccount(caption = "先添加一个游戏号") { return `<section class="card empty"><div class="empty-symbol">${icon("leaf")}</div><h2>${caption}</h2><p>把账号保存在这台手机，再选择要自动执行的种花、浇水和收花。</p><button class="button" type="button" data-action="add-account">${icon("add")}添加游戏号</button></section>`; }
  function unreadableCard() { return `<section class="card empty"><div class="empty-symbol">${icon("leaf")}</div><h2>手机服务未连接</h2><p>账号状态暂时无法确认；先重新连接本机执行器，再查看游戏号是否仍在运行。</p><div class="dialog-actions"><button class="button" type="button" data-action="refresh">重新连接</button><button class="button secondary" type="button" data-action="service-help">连接帮助</button></div></section>`; }
  /* 花庭横幅：只用真实读数说这一台手机上现在有几个号在跑、几个停着。 */
  function gardenBanner() {
    const total = state.accounts.length;
    const running = runningCount();
    const stopped = Math.max(0, total - running - state.accounts.filter(isPending).length);
    const sub = !state.online ? "手机运行服务未连接，状态暂时读不到" : total ? `${running} 个运行中 · ${stopped} 个已停止` : "还没有添加游戏号";
    return `<section class="card garden-banner"><img src="brand/garden-moon.png" alt=""><p class="eyebrow">ENDLESS SUMMER</p><h2>花开无尽夏</h2><p class="banner-slogan">雨落有晴天</p><p class="banner-sub">${esc(sub)}</p></section>`;
  }
  function accountFilterTabs() {
    const total = state.accounts.length;
    const running = runningCount();
    const waiting = state.accounts.filter(isPending).length;
    const stopped = Math.max(0, total - running - waiting);
    const tabs = [["all", "全部", total], ["running", "运行中", running], ["stopped", "已停止", stopped]];
    return `<div class="filter-tabs" role="tablist">${tabs.map(([key, label, count]) => `<button class="filter-tab${state.accountFilter === key ? " is-active" : ""}" type="button" role="tab" aria-selected="${state.accountFilter === key}" data-filter="${key}">${esc(label)}<b>${count}</b></button>`).join("")}</div>`;
  }
  function filteredAccounts() {
    if (state.accountFilter === "running") return state.accounts.filter(account => accountState(account) === "running");
    if (state.accountFilter === "stopped") return state.accounts.filter(account => accountState(account) !== "running" && !isPending(account));
    return state.accounts;
  }
  function accountCard(account) {
    const running = canStop(account);
    const status = accountState(account);
    const pending = isPending(account);
    const busy = sameId(state.busy.split(":")[1], account.id);
    const actionDisabled = running ? !canPersistAccountStop(account) || state.busy === `stop:${account.id}` : !state.online || busy;
    return `<article class="acard"><div class="acard-top"><div class="avatar" aria-hidden="true">${esc(accountName(account).slice(0,1))}</div><div class="account-info"><h2>${esc(accountName(account))}</h2><p class="account-sub">游戏账号 · 手机本地执行</p></div><span class="badge ${pending ? "pending" : status === "running" ? "running" : ["failed","error","blocked"].includes(status) ? "failed" : ""}">${esc(stateLabel(account))}</span><button class="acard-link" type="button" data-action="account-menu" data-id="${esc(account.id)}" data-name="${esc(accountName(account))}" aria-label="更多操作">${icon("more")}</button></div><p class="acard-note">${icon(running ? "sprout" : "moon")}<span>${esc(accountNote(account))}</span></p><div class="acard-actions"><button class="acard-link" type="button" data-action="account-settings" data-id="${esc(account.id)}">${icon("settings")}设置</button><button class="acard-link" type="button" data-action="account-logs" data-id="${esc(account.id)}">${icon("logs")}日志</button><button class="acard-run ${running ? "danger" : ""}" type="button" data-action="${running ? "stop" : "start"}" data-id="${esc(account.id)}" ${actionDisabled ? "disabled" : ""}>${icon(running ? "stop" : "play")}${busy ? "处理中" : running ? "停止" : "开始"}</button></div></article>`;
  }
  function accountMenuDialog(id, name) {
    showDialog(name, `<p class="dialog-intro">要对这个游戏号做什么？设置与日志也可以从卡片里那两格直接进。</p><div class="picker-list"><button class="acct-card" type="button" data-action="account-settings" data-id="${esc(id)}"><span><strong>设置</strong><p>种花收花、交订单与花艺</p></span><span class="chevron">›</span></button><button class="acct-card" type="button" data-action="account-logs" data-id="${esc(id)}"><span><strong>日志</strong><p>看这个号做过什么</p></span><span class="chevron">›</span></button><button class="acct-card" type="button" data-action="account-runtime" data-id="${esc(id)}"><span><strong>账号运行状态</strong><p>运行、等待、停止与未读到各表示什么</p></span><span class="chevron">›</span></button><button class="acct-card" type="button" data-action="account-protection" data-id="${esc(id)}"><span><strong>本机资料与执行保护</strong><p>同号单会话、未确认记录与移除说明</p></span><span class="chevron">›</span></button><button class="acct-card" type="button" data-action="remove-account" data-id="${esc(id)}" data-name="${esc(name)}"><span><strong>移除这个游戏号</strong><p>账号资料从本机移除，历史操作记录单独保留</p></span><span class="chevron">›</span></button></div>`,
      dialogActions('<button class="button secondary" type="button" data-action="close-dialog">先不动</button>'), "picker-dialog");
  }
  function renderAccounts() {
    const controls = `<button class="round-add" type="button" data-action="add-account" ${state.online && !state.busy ? "" : "disabled"} aria-label="添加游戏号">${icon("add")}</button>`;
    let content = pageHead("我的游戏号", "你的每一座小花园，都在这里。", controls) + gardenBanner();
    if (state.loading && !state.accounts.length) return content + '<div class="card skeleton">正在读取游戏号…</div>';
    if (!state.online && !state.accounts.length) return content + unreadableCard();
    if (!state.accounts.length) return content + emptyAccount();
    content += accountFilterTabs();
    const shown = filteredAccounts();
    if (!shown.length) return content + `<section class="card empty"><div class="empty-symbol">${icon("leaf")}</div><h2>这一档现在没有游戏号</h2><p>换一格看：全部 ${state.accounts.length} 个 · 运行 ${runningCount()} · 等待 ${pendingCount()}。</p></section>`;
    return content + shown.map(accountCard).join("");
  }
  /* 统一出口只有一份实现：游戏号页与「我的」共用 state.egressDraft 与 saveEgress()。 */
  function egressCard(route, routeText, disabled) {
    return `<section class="card egress-block"><form id="egress-form" class="egress-form"><label for="egress-input">统一出口 IP / 代理地址</label><div class="egress-input-row"><input id="egress-input" type="password" autocomplete="off" spellcheck="false" enterkeyhint="done" aria-label="统一出口IP或代理地址" placeholder="IP:端口 或 http://代理地址" value="${esc(state.egressDraft)}" ${disabled ? "disabled" : ""}><button class="button secondary" type="submit" ${disabled ? "disabled" : ""}>${state.busy === "egress" ? "应用中" : "应用"}</button>${route?.configured ? '<button class="text-button" type="button" data-action="clear-egress">清除</button>' : ""}</div><span class="egress-status">${esc(routeText)}</span></form>${state.egressError ? `<p class="notice error">${esc(state.egressError)}</p>` : ""}<p class="prow-note">已配置出口的口令不会回显；换地址请重新输入完整代理地址（含鉴权）。清除会移除现有代理配置。</p></section>`;
  }
  /* 上传策略卡与统一出口都收进「我的」；游戏号页只留名册（原型 accounts 板）。 */
  function wifiPolicyCard() {
    const policy = state.status?.software?.uploadPolicy || null;
    const transportZh = ({ wifi: "Wi-Fi", cellular: "移动数据", ethernet: "有线网络", none: "没有可用网络" })[state.status?.network?.transport] || "线路暂时没读到";
    const policyNote = policy
    ? `当前线路：${transportZh}｜${policy.holdSince ? `压着等 Wi-Fi 的运行日志 ${Number(policy.pending || 0)} 条` : "没有压着的日志"}`
    : "手机运行服务还没连上，这一格暂时读不到。";
    return `<section class="card"><div class="card-head"><div class="switch-row"><div class="switch-copy"><strong>运行日志只在 Wi-Fi 下上传</strong><p>开着时：手机走移动数据或有线网络，运行日志先留在这台手机，等回到 Wi-Fi 再按原来的时间上传；关着时：任何线路都按原来的时间上传。这一格只管运行日志的上传，种花、浇水、收花照常在这台手机上执行。</p></div><button class="switch-button" type="button" role="switch" aria-checked="${policy?.enabled === true ? "true" : "false"}" aria-label="运行日志只在 Wi-Fi 下上传" data-action="toggle-upload-policy" ${!state.online || !policy || state.busy ? "disabled" : ""}><span class="switch-track"></span></button></div></div><p class="row-note">${esc(policyNote)}</p></section>`;
  }

  /* ───────────── 三张功能卡：配置形状、目录读取与本机 API 契约逐字对齐 ─────────────
     config = { plantEnabled, plantMode, plantFlowerIds, plantQualities, groupSize,
                plantBlacklistIds, restockCount, harvestEnabled, waterEnabled, keepWater }
     收花没有延迟这一档：成熟即按固定流程收，界面上也不再出现这个键。
     界面只管填这一份、整份 PUT；卡关掉也照常预填，绝不因为关卡把用户存过的值清零。 */
  const DEFAULT_PLANT_MODE = "least_stock";
  const MODE_CHOSEN_FLOWERS = "chosen_flowers";
  const MODE_CHOSEN_QUALITY = "chosen_quality";
  const MODE_CHOSEN_TOP = "chosen_top";
  const asArray = value => Array.isArray(value) ? value.map(String) : [];
  const asNumberOrNull = value => {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  function normalizeConfig(config) {
    return {
      plantEnabled: config?.plantEnabled === true,
      plantMode: typeof config?.plantMode === "string" && config.plantMode ? config.plantMode : DEFAULT_PLANT_MODE,
      plantFlowerIds: asArray(config?.plantFlowerIds),
      plantQualities: asArray(config?.plantQualities),
      groupSize: asNumberOrNull(config?.groupSize),
      plantBlacklistIds: asArray(config?.plantBlacklistIds),
      restockCount: asNumberOrNull(config?.restockCount),
      harvestEnabled: config?.harvestEnabled === true,
      waterEnabled: config?.waterEnabled === true,
      keepWater: asNumberOrNull(config?.keepWater),
      waterwheelEnabled: config?.waterwheelEnabled === true,
      freeWaterEnabled: config?.freeWaterEnabled === true,
      flowerRack: normalizeFlowerRack(config?.flowerRack),
      accelerationMode: ["off", "card", "free"].includes(config?.accelerationMode) ? config.accelerationMode : "off",
      speedCardKeep: asNumberOrNull(config?.speedCardKeep) ?? 0,
      /* 三个 Tab 共用同一份草稿：订单与花艺按引擎读回的实存值原样带上，切 Tab 不重新取默认。 */
      orders: normalizeFeature(config?.orders, ORDER_KEYS, ORDER_SWITCH_ONLY_VIDEO),
      art: normalizeArt(config?.art),
      dailyTaskRewards: { enabled: config?.dailyTaskRewards?.enabled === true },
      ...normalizeRewardCards(config),
      configVersion: Number.isFinite(Number(config?.configVersion)) ? Number(config.configVersion) : 3,
    };
  }
  /* R10 cards: pass-through shape for the new config roots. Defaults are only
     applied when the engine has not delivered the field yet. */
  function normalizeRewardCards(config) {
    const bool = (node, key, fallback) => typeof node?.[key] === "boolean" ? node[key] : fallback;
    const int = (node, key, min, max) => Number.isInteger(node?.[key]) && node[key] >= min && node[key] <= max ? node[key] : min;
    const ids = (node, key) => Array.isArray(node?.[key]) ? node[key].map(Number).filter(id => Number.isSafeInteger(id) && id > 0) : [];
    return {
      mail: { enabled: bool(config?.mail, "enabled", false) },
      benefitBox: { enabled: bool(config?.benefitBox, "enabled", false) },
      dailyTaskBox: { enabled: bool(config?.dailyTaskBox, "enabled", false) },
      weeklyTask: { enabled: bool(config?.weeklyTask, "enabled", false) },
      freeYuanbaoGift: { enabled: bool(config?.freeYuanbaoGift, "enabled", false) },
      doubleCoin: { enabled: bool(config?.doubleCoin, "enabled", false) },
      mainTask: { enabled: bool(config?.mainTask, "enabled", false),
        maxRewardsPerMinute: int(config?.mainTask, "maxRewardsPerMinute", 1, 30) },
      mainStory: { enabled: bool(config?.mainStory, "enabled", false),
        maxUnlocksPerDay: int(config?.mainStory, "maxUnlocksPerDay", 0, 30) },
      guildBuild: { enabled: bool(config?.guildBuild, "enabled", false),
        videoEnabled: bool(config?.guildBuild, "videoEnabled", true), goldEnabled: bool(config?.guildBuild, "goldEnabled", true),
        yuanbaoEnabled: bool(config?.guildBuild, "yuanbaoEnabled", false),
        goldDailyCount: int(config?.guildBuild, "goldDailyCount", 0, 100),
        yuanbaoTimesPerDay: int(config?.guildBuild, "yuanbaoTimesPerDay", 0, 100) },
      guildLand: { enabled: bool(config?.guildLand, "enabled", false),
        harvestEnabled: bool(config?.guildLand, "harvestEnabled", true), plantEnabled: bool(config?.guildLand, "plantEnabled", true),
        upgradeEnabled: bool(config?.guildLand, "upgradeEnabled", false), unlockEnabled: bool(config?.guildLand, "unlockEnabled", false),
        unlockKeepGuildCoin: int(config?.guildLand, "unlockKeepGuildCoin", 0, 100000000),
        upgradeKeepGuildCoin: int(config?.guildLand, "upgradeKeepGuildCoin", 0, 100000000),
        plantMode: ["least_stock", "chosen_flowers"].includes(config?.guildLand?.plantMode) ? config.guildLand.plantMode : "least_stock",
        plantFlowerIds: ids(config?.guildLand, "plantFlowerIds"), plantBlacklistIds: ids(config?.guildLand, "plantBlacklistIds"),
        plantQualities: Array.isArray(config?.guildLand?.plantQualities) ? config.guildLand.plantQualities.map(Number)
          .filter(q => [1, 2, 3, 4, 5].includes(q)) : [],
        minFlowerLevel: int(config?.guildLand, "minFlowerLevel", 1, 70) },
      cultivateUpgrade: { enabled: bool(config?.cultivateUpgrade, "enabled", false),
        targetLevel: int(config?.cultivateUpgrade, "targetLevel", 1, 70) },
      materialShop: { enabled: bool(config?.materialShop, "enabled", false),
        freeRefresh: bool(config?.materialShop, "freeRefresh", true),
        maxBuyPerMinute: int(config?.materialShop, "maxBuyPerMinute", 0, 60),
        keepGold: int(config?.materialShop, "keepGold", 0, 100000000) },
    };
  }
  const ORDER_KEYS = ["resident", "satin", "decorate", "customer", "palace", "team"];
  const ORDER_SWITCH_ONLY_VIDEO = ["resident", "satin", "decorate"];
  function normalizeFeature(orders, keys, videoKeys) {
    const source = orders && typeof orders === "object" ? orders : {};
    const out = {};
    for (const key of keys) {
      const row = source[key] && typeof source[key] === "object" ? source[key] : {};
      out[key] = {
        enabled: row.enabled === true,
        dailyLimit: Number.isFinite(Number(row.dailyLimit)) ? Number(row.dailyLimit) : 0,
        coinTiers: asArray(row.coinTiers), qualityFilter: asArray(row.qualityFilter),
        autoReject: row.autoReject === true, realWrite: row.realWrite === true,
        allowFreeTake: row.allowFreeTake === true, allowBuyAgain: row.allowBuyAgain === true,
        buyAgainKeepYuanbao: Number.isFinite(Number(row.buyAgainKeepYuanbao)) ? Number(row.buyAgainKeepYuanbao) : 0,
        videoEnabled: videoKeys.includes(key) ? row.enabled === true : false,
      };
    }
    return out;
  }
  function normalizeArt(art) {
    const row = art && typeof art === "object" ? art : {};
    return {
      makeEnabled: row.makeEnabled === true, specifiedArts: asArray(row.specifiedArts),
      autoReplenish: row.autoReplenish === true,
      dailyMode: ["least_stock","chosen_quality","chosen_arts"].includes(row.dailyMode) ? row.dailyMode : "least_stock",
      dailyQualities: asArray(row.dailyQualities),
      targetStock: Number.isFinite(Number(row.targetStock)) ? Number(row.targetStock) : (Number.isFinite(Number(row.makeBatch)) ? Number(row.makeBatch) : 1),
      makeBatch: Number.isFinite(Number(row.targetStock)) ? (Number.isFinite(Number(row.makeBatch)) ? Number(row.makeBatch) : 1) : 1,
      firstAlbumClaim: row.firstAlbumClaim === true, firstShareClaim: row.firstShareClaim === true,
      dailyMakeEnabled: row.dailyMakeEnabled === true,
    };
  }
  function normalizeFlowerRack(rack) {
    const row = rack && typeof rack === "object" ? rack : {};
    return { enabled: row.enabled === true, sortStrategy: ["max_stock","min_stock","max_price"].includes(row.sortStrategy) ? row.sortStrategy : "max_stock",
      artIds: asArray(row.artIds), autoTakeDown: row.autoTakeDown === true, unlockEnabled: row.unlockEnabled === true, putCount: Number.isInteger(row.putCount) ? row.putCount : 1,
      keepMinutes: Number.isInteger(row.keepMinutes) ? row.keepMinutes : 20,
      unlockKeepGold: Number.isInteger(row.unlockKeepGold) ? row.unlockKeepGold : 0 };
  }
  function validConfigShape(config) {
    return config && typeof config === "object"
      && ["plantEnabled","harvestEnabled","waterEnabled","waterwheelEnabled","freeWaterEnabled"].every(key => typeof config[key] === "boolean")
      && ["off","card","free"].includes(config.accelerationMode) && Number.isSafeInteger(config.speedCardKeep) && config.speedCardKeep >= 0
      && typeof config.plantMode === "string" && config.plantMode
      && Array.isArray(config.plantFlowerIds) && Array.isArray(config.plantQualities) && Array.isArray(config.plantBlacklistIds)
      && ORDER_KEYS.every(key => config.orders?.[key] && typeof config.orders[key].enabled === "boolean")
      && config.dailyTaskRewards && typeof config.dailyTaskRewards.enabled === "boolean"
      && config.art && typeof config.art.makeEnabled === "boolean" && typeof config.art.dailyMakeEnabled === "boolean" && Array.isArray(config.art.specifiedArts)
      && typeof config.art.autoReplenish === "boolean" && ["least_stock","chosen_quality","chosen_arts"].includes(config.art.dailyMode)
      && Array.isArray(config.art.dailyQualities) && Number.isInteger(config.art.targetStock) && config.art.targetStock >= 1 && config.art.targetStock <= 999
      && Number.isInteger(config.art.makeBatch) && config.art.makeBatch >= 1 && config.art.makeBatch <= 999
      && config.flowerRack && typeof config.flowerRack.enabled === "boolean" && Array.isArray(config.flowerRack.artIds) && typeof config.flowerRack.autoTakeDown === "boolean" && typeof config.flowerRack.unlockEnabled === "boolean"
      && ["max_stock","min_stock","max_price"].includes(config.flowerRack.sortStrategy)
      && Number.isInteger(config.flowerRack.putCount) && config.flowerRack.putCount >= 1 && config.flowerRack.putCount <= 12
      && Number.isInteger(config.flowerRack.keepMinutes) && config.flowerRack.keepMinutes >= 1 && config.flowerRack.keepMinutes <= 1440
      && Number.isSafeInteger(config.flowerRack.unlockKeepGold) && config.flowerRack.unlockKeepGold >= 0;
  }
  /* 内层分类的读写：草稿只有一份，切分类不重新请求、不覆盖编辑中的值。
     详情弹层打开时读写的是那一份子副本（sheet.draft），父草稿在点「完成」前一字不动。 */
  function getPath(root, path) { return String(path).split(".").reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), root); }
  function setPath(root, path, value) {
    if (!root || typeof root !== "object" || Array.isArray(root)) return false;
    const parts = String(path).split("."); let node = root;
    if (parts.some(key => !key || ["__proto__", "prototype", "constructor"].includes(key))) return false;
    for (const key of parts.slice(0, -1)) {
      if (!Object.hasOwn(node,key) || !node[key] || typeof node[key] !== "object" || Array.isArray(node[key])) return false;
      node = node[key];
    }
    if (!Object.hasOwn(node,parts[parts.length - 1])) return false;
    node[parts[parts.length - 1]] = value;
    return true;
  }
  let sheet = null;
  /* 嵌套层栈：每一层持有进入时的深拷贝，只有「完成」才把这一层名下的格子合到下一层。
     取消、✕、原生返回直接丢掉整份拷贝；共用同一个 draft 对象会让取消变成只关窗。 */
  let moonLayers = [];
  const topMoonLayer = () => moonLayers[moonLayers.length - 1] || null;
  const currentSheet = () => topMoonLayer() || sheet;
  let draftTransactionSequence = 0, draftEditSequence = 0;
  let pageDraftTransaction = null;
  const cloneDraftValue = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const sameDraftValue = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  const configLayers = () => [sheet,...moonLayers].filter(layer => layer && (layer.spec.paths || []).length);
  const currentConfigLayer = () => configLayers().at(-1) || null;
  const draftContext = () => ({ generation:state.engine.generation,instanceId:state.engine.instanceId,
    softwareUserId:softwareUserId(),accountId:String(state.selectedId) });
  const sameDraftContext = context => context && context.generation===state.engine.generation && context.instanceId===state.engine.instanceId
    && context.softwareUserId===softwareUserId() && context.accountId===String(state.selectedId);
  function installConfigBaseline(config, draft = normalizeConfig(config)) {
    const base = normalizeConfig(config);
    state.config=base; state.draft=draft; state.configError="";
    pageDraftTransaction={ id:++draftTransactionSequence,...draftContext(),base,baseSnapshot:cloneDraftValue(base),
      draft,revision:0,recoveryVersion:0,paused:false,reason:"",rechecking:false };
    updateDirty();
    return pageDraftTransaction;
  }
  function pauseDraftTransactions(message) {
    const roots=new Set([pageDraftTransaction,...configLayers().map(layer=>layer.transaction)].filter(Boolean));
    for(const root of roots){root.paused=true;root.reason=message;}
  }
  function adoptSoftwareInfo(info) {
    if (String(info?.user?.id ?? "") !== softwareUserId() || info?.signedIn !== state.software?.signedIn) {
      backgroundAuthEpoch++; invalidateBackgroundSettings(true);
      state.authError = ""; state.authErrorMeta = null;
    }
    if(String(info?.user?.id ?? "")!==softwareUserId()){
      invalidateOptionalStatusReads();
      pauseDraftTransactions("软件账号已变化，原编辑仍保留在原详情中，没有应用到当前软件账号。");
      configRequest++;configRead=null;state.configLoading=false;
      state.config=null;state.draft=null;state.dirty=false;clearObservations();
      invalidateLogRead();state.logs=[];state.logsError="";state.logDays=[];state.logCategories=[];resetLogsPage();
    }
    state.software=info;
    updateDraftTransactionUI();
  }
  function draftProblem(code,message) { return {ok:false,code,message}; }
  function rootDraftStatus(root, merge) {
    if(!root || !root.draft || !root.base) return draftProblem("DRAFT_UNREAD","这个游戏号的设置尚未读取，原编辑没有应用。");
    if(root.softwareUserId!==softwareUserId()) return draftProblem("DRAFT_OWNER_CHANGED","软件账号已变化，这份编辑仍属于原软件账号，不能合入当前设置。");
    if(root.accountId!==String(state.selectedId)) return draftProblem("DRAFT_ACCOUNT_CHANGED","当前游戏号已变化，这份编辑没有应用到其他游戏号。");
    if(!merge) return {ok:true};
    if(state.busy==="save")return draftProblem("DRAFT_SAVE_PENDING","这份设置正在保存并等待实际读回，原编辑继续保留，请等待本次结果。");
    if(root.rechecking) return draftProblem("DRAFT_CHECKING","正在重新读取这个游戏号的设置，原编辑继续保留，请等待本次核对。");
    if(root.paused || !sameDraftContext(root) || !engineReady() || !state.online)
      return draftProblem("DRAFT_CONNECTION_CHANGED",root.reason || "手机服务连接尚未核对，原编辑已保留；请连接就绪后重新核对设置。");
    if(pageDraftTransaction!==root || state.draft!==root.draft || state.config!==root.base)
      return draftProblem("DRAFT_BASE_REPLACED","页面设置基准已变化，原编辑继续保留，不能直接覆盖后来读取的草稿。");
    if(!sameDraftValue(state.config,root.baseSnapshot)) return draftProblem("DRAFT_BASE_CHANGED","已读取的设置基准已变化，原编辑未应用，请重新核对。");
    return {ok:true};
  }
  function layerDraftStatus(layer) {
    const layers=configLayers(), seen=new Set();
    for(let one=layer;one;one=one.parentLayer){
      if(seen.has(one)||!layers.includes(one)||!one.overlay?.isConnected||one.transaction!==layer.transaction)
        return draftProblem("DRAFT_PARENT_CLOSED","发起这次编辑的详情层已经关闭，原编辑未应用。");
      seen.add(one);
      const parent=one.parentLayer;
      if(parent && (layers.indexOf(parent)>=layers.indexOf(one)||parent.draft!==one.parentDraftRef)
        || !parent && one.parentDraftRef!==one.transaction?.draft)
        return draftProblem("DRAFT_PARENT_REPLACED","父草稿已变化，原编辑继续保留，不能合入另一份设置。");
    }
    return {ok:true};
  }
  function captureDraftTarget(sourceNode=null) {
    const layer=currentConfigLayer();
    if(sourceNode && sourceNode.closest?.("#dialog-host") && (!layer || !layer.overlay?.contains(sourceNode))) return null;
    if(sourceNode && !sourceNode.closest?.("#dialog-host") && hasDialog()) return null;
    const root=layer?.transaction || pageDraftTransaction, draft=layer?.draft || state.draft;
    if(!root || !draft) return null;
    return Object.freeze({root,layer,draft,revision:layer?.revision ?? root.revision,transactionId:root.id,
      generation:state.engine.generation,instanceId:state.engine.instanceId,recoveryVersion:root.recoveryVersion});
  }
  function validateDraftTarget(token,{merge=false,notify=false}={}) {
    let status=rootDraftStatus(token?.root,merge);
    if(status.ok && token.transactionId!==token.root.id) status=draftProblem("DRAFT_TRANSACTION_CHANGED","这次编辑已经失效，原选择没有应用。");
    if(status.ok && token.layer) {
      status=layerDraftStatus(token.layer);
      if(status.ok && token.layer.draft!==token.draft) status=draftProblem("DRAFT_TARGET_REPLACED","发起选择的草稿已变化，原选择没有应用。");
    } else if(status.ok && (pageDraftTransaction!==token.root || state.draft!==token.draft))
      status=draftProblem("DRAFT_TARGET_REPLACED","页面草稿已变化，原选择没有应用。");
    if(status.ok && (token.layer?.revision ?? token.root.revision)!==token.revision)
      status=draftProblem("DRAFT_EDIT_CHANGED","发起选择后草稿已有其他修改，请取消本次选择后重新打开，已有编辑仍保留。");
    if(status.ok && merge && (token.generation!==state.engine.generation || token.instanceId!==state.engine.instanceId
      || token.recoveryVersion!==token.root.recoveryVersion))
      status=draftProblem("DRAFT_PICKER_RECHECK_REQUIRED","这次选择仍属于核对前的连接，请在本层重新核对后再完成；勾选继续保留。");
    if(!status.ok && notify){updateDraftTransactionUI();toast(status.message);}
    return status;
  }
  function applyDraftValue(token,path,value,{merge=false,notify=true}={}) {
    const status=validateDraftTarget(token,{merge,notify});
    if(!status.ok) return false;
    if(token.layer && !(token.layer.spec.paths || []).includes(path)) {if(notify)toast("这一格不属于当前详情，原选择没有应用。");return false;}
    if(!setPath(token.draft,path,cloneDraftValue(value))){if(notify)toast("这个设置字段已经变化，原编辑没有应用。");return false;}
    if(token.layer)token.layer.revision++;else token.root.revision++;
    draftEditSequence++;
    updateDraftTransactionUI();
    return true;
  }
  /* A picker keeps its exact initiating draft while the host paints the same recovery UI used by
     formal selectors. Registration changes no field or DOM in the normal state. */
  function registerDraftPicker(overlay,target,onRecovered=null) {
    const frame=dialogFrames.at(-1);
    if(!overlay?.isConnected || frame?.overlay!==overlay || !target
      || frame.draftTarget && frame.draftTarget!==target)return false;
    if(!frame.draftTarget && (!validateDraftTarget(target).ok || currentConfigLayer()!==target.layer))return false;
    frame.draftTarget=target;
    if(typeof onRecovered==="function")frame.onDraftTargetRecovered=onRecovered;
    updateDraftTransactionUI();
    return true;
  }
  function recoverDraftPickerTarget(frame,target,root) {
    if(!frame || dialogFrames.at(-1)!==frame || !frame.overlay.isConnected || frame.draftTarget!==target
      || target?.root!==root || !validateDraftTarget(target).ok || !rootDraftStatus(root,true).ok)return false;
    const renewed=Object.freeze({...target,generation:state.engine.generation,instanceId:state.engine.instanceId,
      recoveryVersion:root.recoveryVersion});
    frame.draftTarget=renewed;
    // Only the successful, current explicit GET may replace this picker callback's old token.
    // No current/global draft is captured and no pending checkbox selection is applied here.
    if(frame.onDraftTargetRecovered?.(renewed)===false){frame.draftTarget=target;return false;}
    return true;
  }
  function makeConfigLayer(key,spec,focus="") {
    if(!(spec.paths || []).length) return {key,spec,focus,draft:cloneDraftValue(draftRoot() || {}),overlay:null};
    const candidate=currentConfigLayer();
    // A linked different card must not be merged into a parent that will never
    // commit those paths. Ordinary nested selectors stay inside their own card.
    const parentLayer=candidate && (spec.paths || []).every(path=>(candidate.spec.paths || []).includes(path))?candidate:null;
    const transaction=candidate?.transaction || pageDraftTransaction;
    const status=rootDraftStatus(transaction,false);
    if(!status.ok){toast(status.message);return null;}
    const parentDraftRef=parentLayer?.draft || transaction.draft;
    return {key,spec,focus,transaction,parentLayer,parentDraftRef,parentSnapshot:cloneDraftValue(parentDraftRef),
      openingDraft:cloneDraftValue(parentDraftRef),draft:cloneDraftValue(parentDraftRef),revision:0,overlay:null};
  }
  function changedLayerPaths(layer) { return (layer.spec.paths || []).filter(path=>!sameDraftValue(getPath(layer.openingDraft,path),getPath(layer.draft,path))); }
  function layerMergeStatus(layer) {
    const status=rootDraftStatus(layer?.transaction,true);
    if(!status.ok)return status;
    const ancestry=layerDraftStatus(layer);if(!ancestry.ok)return ancestry;
    for(const path of changedLayerPaths(layer)) if(!sameDraftValue(getPath(layer.parentDraftRef,path),getPath(layer.parentSnapshot,path)))
      return draftProblem("DRAFT_PARENT_EDITED","父草稿的同一项已有其他修改，本层编辑继续保留，不能直接覆盖。");
    return {ok:true};
  }
  function draftTransactionForNode(node) {
    const layer=configLayers().find(one=>one.overlay?.contains(node));
    const frame=dialogFrames.find(one=>one.overlay.contains(node)&&one.draftTarget);
    return layer?.transaction || frame?.draftTarget?.root || pageDraftTransaction;
  }
  function paintDraftNotice(container,status,root) {
    if(!container)return;
    let note=container.querySelector(":scope > [data-draft-transaction-note]");
    if(status.ok){note?.remove();return;}
    if(!note){note=document.createElement("div");note.className="panel-note warning";note.dataset.draftTransactionNote="";note.setAttribute("role","status");container.prepend(note);}
    const canCheck=root && root.softwareUserId===softwareUserId() && root.accountId===String(state.selectedId);
    const html=`<p>${esc(status.message)}</p>${canCheck?`<button type="button" class="panel-link" data-action="resume-config-draft" data-draft-transaction="${root.id}" ${root.rechecking||!engineReady()||!state.online?"disabled":""}>${root.rechecking?"正在核对…":"重新核对后继续编辑"}</button>${!engineReady()||!state.online?'<button type="button" class="panel-link" data-action="service-help-offline">查看手机连接原因</button>':""}`:""}`;
    if(note.innerHTML!==html)note.innerHTML=html;
  }
  function updateDraftTransactionUI() {
    for(const layer of configLayers()){
      if(!layer.overlay?.isConnected)continue;
      const status=layerMergeStatus(layer);
      paintDraftNotice(layer.overlay.querySelector(".panel-scroll,.dialog-body"),status,layer.transaction);
      for(const button of layer.overlay.querySelectorAll('[data-panel-action="apply"],[data-panel-action="apply-config"],[data-action="detail-done"]'))
        button.disabled=!status.ok;
    }
    for(const frame of dialogFrames){
      if(!frame.draftTarget || !frame.overlay.isConnected)continue;
      const status=validateDraftTarget(frame.draftTarget,{merge:true});
      paintDraftNotice(frame.overlay.querySelector(".panel-scroll,.dialog-body"),status,frame.draftTarget.root);
      const button=frame.overlay.querySelector('#picker-save,[data-moon-action="picker-apply"]');if(button)button.disabled=!status.ok;
    }
    if(state.tab==="settings" && pageDraftTransaction){
      const status=rootDraftStatus(pageDraftTransaction,true),dock=document.querySelector("#moon-dock .save-dock,#main .save-dock");
      paintDraftNotice(dock,status,pageDraftTransaction);
      if(!status.ok){const button=dock?.querySelector('[data-action="save-config"]');if(button){button.disabled=true;button.dataset.clean="false";
        for(const node of [...button.childNodes])if(node.nodeType===Node.TEXT_NODE)node.remove();button.append(document.createTextNode("等待核对设置"));}}
    }
  }
  async function resumeDraftTransaction(root,sourceNode=null) {
    if(!root || root.rechecking)return false;
    if(root.softwareUserId!==softwareUserId() || root.accountId!==String(state.selectedId)){toast("软件账号或游戏号已经变化，原编辑未应用。");return false;}
    if(!engineReady()||!state.online){toast("请先重新连接手机服务；原编辑继续保留。");return false;}
    const context=draftContext(),revision=root.revision,origin=sourceNode?.closest(".sheet-scrim,.dialog-overlay") || null;
    const originFrame=origin?dialogFrames.find(frame=>frame.overlay===origin):null,pickerTarget=originFrame?.draftTarget || null;
    const originCurrent=()=>origin?origin.isConnected && dialogFrames.at(-1)===originFrame
      :!hasDialog() && state.tab==="settings" && pageDraftTransaction===root;
    if(!originCurrent())return false;
    root.rechecking=true;updateDraftTransactionUI();
    try{
      const result=await api(`/accounts/${encodeURIComponent(root.accountId)}/config`);
      if(!originCurrent())return false;
      if(!sameDraftContext(context)||root.revision!==revision)throw localFailure("核对期间连接或父草稿又有变化，原编辑继续保留。","DRAFT_RECHECK_STALE");
      const actual=result?.config || result;if(!validConfigShape(actual))throw localFailure("本次未读到完整设置，原编辑继续保留。","DRAFT_RECHECK_INCOMPLETE");
      if(!sameDraftValue(normalizeConfig(actual),root.baseSnapshot))throw localFailure("这个游戏号已保存的设置有变化，本层编辑继续保留；请取消后按最新设置重新编辑。","DRAFT_BASE_CONFLICT");
      for(const layer of configLayers().filter(one=>one.transaction===root)){
        const status=layerDraftStatus(layer);if(!status.ok)throw localFailure(status.message,status.code);
        for(const path of changedLayerPaths(layer))if(!sameDraftValue(getPath(layer.parentDraftRef,path),getPath(layer.parentSnapshot,path)))
          throw localFailure("父草稿的同一项已有其他修改，本层编辑继续保留。","DRAFT_PARENT_EDITED");
      }
      const live=pageDraftTransaction;
      if(live!==root && live && (live.softwareUserId!==root.softwareUserId || live.accountId!==root.accountId || live.revision!==0 || !sameDraftValue(live.draft,live.base)))
        throw localFailure("页面已经有另一份编辑，原详情没有合入新草稿。","DRAFT_NEW_PARENT_EDITED");
      if(pageDraftTransaction!==root && !configLayers().some(one=>one.transaction===root))return false;
      state.config=normalizeConfig(actual);state.draft=root.draft;pageDraftTransaction=root;
      Object.assign(root,context,{base:state.config,paused:false,reason:"",rechecking:false,recoveryVersion:root.recoveryVersion+1});
      state.configError="";if(result.metadata)state.metadata={...state.metadata,...result.metadata};
      if(pickerTarget)recoverDraftPickerTarget(originFrame,pickerTarget,root);
      updateDirty();toast("已重新读取并核对同一份设置，可以继续编辑；尚未保存或开始任务。");return true;
    }catch(error){if(sameDraftContext(context)&&originCurrent()){root.paused=true;root.reason=safeError(error,"本次设置核对没有完成，原编辑继续保留。");toast(root.reason);}return false;}
    finally{root.rechecking=false;updateDraftTransactionUI();if(!hasDialog())render();}
  }
  function belowDraft() {
    const layer=currentConfigLayer();if(layer)return layer.parentDraftRef;
    if (moonLayers.length > 1) return moonLayers[moonLayers.length - 2].draft;
    if (moonLayers.length === 1) return sheet?.draft || state.draft;
    return state.draft;
  }
  function draftRoot() {
    const layer = topMoonLayer();
    if (layer) return layer.draft;
    return sheet ? sheet.draft : state.draft;
  }
  function draftGet(path) { return getPath(draftRoot(), path); }
  function parentGet(path) { return getPath(belowDraft(), path); }
  function draftSet(path, value, token=captureDraftTarget()) { return applyDraftValue(token,path,value); }
  function parentSet(path, value) {
    const layer=currentConfigLayer(),status=layerMergeStatus(layer);
    if(!status.ok || !(layer.spec.paths || []).includes(path)){toast(status.message || "这一格不属于当前详情。");return false;}
    if(!setPath(layer.parentDraftRef,path,cloneDraftValue(value)))return false;
    if(layer.parentLayer)layer.parentLayer.revision++;else layer.transaction.revision++;
    draftEditSequence++;return true;
  }
  function resetSheetState() { moonLayers = []; sheet = null; }

  /* 目录（唯一出处 GET /api/local/catalog，前端不硬编码花名表/品质表/模式表）。 */
  function flowerId(flower) { return String(flower.id ?? flower.flowerId ?? ""); }
  function flowerName(flower) { return flower.name || flower.nameZh || "未命名花种"; }
  function sortedFlowers() {
    return [...state.flowers].sort((left, right) => {
      const q = (Number(left.quality) || 0) - (Number(right.quality) || 0);
      if (q) return q;
      return flowerName(left).localeCompare(flowerName(right), "zh");
    });
  }
  function modeOptions() { return Array.isArray(state.plantModes) ? state.plantModes : []; }
  function qualityOptions() { return Array.isArray(state.qualities) ? state.qualities : []; }
  function groupOptionValues() {
    const list = (Array.isArray(state.groupSizes) ? state.groupSizes : [])
      .map(value => typeof value === "object" ? value.value ?? value.id : value)
      .filter(value => Number.isFinite(Number(value)) && Number(value) > 0)
      .map(Number);
    const current = Number(draftRoot()?.groupSize);
    if (Number.isFinite(current) && !list.includes(current)) list.push(current);
    return [...new Set(list)].sort((a, b) => a - b);
  }
  function modeLabel(value) { const hit = modeOptions().find(one => sameId(one.value, value)); return hit ? String(hit.label) : (value ? String(value) : "未读到"); }
  function qualityName(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "品质没读到";
    const hit = qualityOptions().find(one => Number(one.value) === n);
    return hit ? String(hit.label) : `第 ${n} 档（名字没对上）`;
  }
  function flowerNameById(id) { const hit = state.flowers.find(flower => sameId(flowerId(flower), id)); return hit ? flowerName(hit) : "已保存花种"; }

  /* 多选：花朵与黑名单走「搜索 + 多选弹层 + 选中反馈」，品质走同一弹层（短名单，无需搜索框）。
     等值门＝禁用不是隐藏：非当前模式时这一格灰显、按钮点不动，但存过的名单照旧显示在行上。 */
  const PICKERS = {
    plantFlowerIds: { title: "指定花朵", unit: "一支", source: "flowers", searchable: true, gateMode: MODE_CHOSEN_FLOWERS,
      hint: "只种这几样（只在「种植模式＝指定花朵」时生效，切走就不算数）：谁手里枝数最少谁先补，设了「种植数量」就挨个补到不低于它。" },
    plantBlacklistIds: { title: "种植黑名单", unit: "一支", source: "flowers", searchable: true, gateMode: null,
      hint: "这几样花永远不参与种植，订单、任务在等它也不种。被拉黑的花如果正是某张单要的花，那一单就一直交不上——日志会点名是哪一朵、哪一单在等它。" },
    plantQualities: { title: "指定品质", unit: "一档", source: "qualities", searchable: false, gateMode: MODE_CHOSEN_QUALITY,
      hint: "只种选中品质的花（品质从低到高五档：凡品／普品／珍品／华品／仙品；只在「种植模式＝指定品质」时生效，切走就不算数）：其余跟「指定花朵」一样，枝数最少的先补。" },
  };
  function pickerChoices(source) {
    if (source === "qualities") return qualityOptions().map(one => ({ id: String(one.value), label: String(one.label), quality: null }));
    return sortedFlowers().map(one => ({ id: flowerId(one), label: flowerName(one), quality: Number(one.quality) || null }));
  }
  function pickerGateOff(key) { const gate = PICKERS[key]?.gateMode; return Boolean(gate) && String(draftGet("plantMode")) !== String(gate); }
  function pickerDisabled(key) { return !PICKERS[key] || pickerGateOff(key) || Boolean(state.busy) || !state.online || !state.draft; }
  function pickerSummary(key) {
    const ids = draftGet(key) || [];
    if (!ids.length) return "还没有选择，这一项先不管。";
    const names = ids.slice(0,4).map(id => key === "plantQualities" ? qualityName(id) : flowerNameById(id));
    return `已选 ${ids.length} 项：${names.join("、")}${ids.length > 4 ? " …" : ""}`;
  }
  function gateNote(key) {
    const gate = PICKERS[key]?.gateMode;
    if (!gate) return "";
    return `先把上面「种植模式」切到「${modeLabel(gate)}」，才能在这里改；现在这一档没用它，上面存的名单先留着、不算数。`;
  }

  /* 通用控件行（数字/下拉），说明文字照抄源端中文语义，卡关闭也不清空、仍可预填。
     行上只留「字段名 + 控件 + ?」，说明默认收着，点 ? 才显示，再点收起。 */
  const HELP_LABEL = "这条是干什么的";
  function helpButton(key) {
    const open = state.help.has(key);
    return `<button class="help-toggle" type="button" data-help="${esc(key)}" aria-expanded="${open}" aria-controls="help-${esc(key)}" aria-label="${esc(HELP_LABEL)}" title="${esc(HELP_LABEL)}">?</button>`;
  }
  function helpText(key, text) {
    if (!text) return "";
    const open = state.help.has(key);
    return `<p class="help" id="help-${esc(key)}"${open ? "" : " hidden"}>${esc(text)}</p>`;
  }
  function fieldHead(title, key, controlId = "") {
    const name = controlId
      ? `<label class="field-title" for="${esc(controlId)}">${esc(title)}</label>`
      : `<span class="field-title">${esc(title)}</span>`;
    return `<div class="field-head">${name}${helpButton(key)}</div>`;
  }
  function toggleHelp(key) {
    if (!key) return;
    if (state.help.has(key)) state.help.delete(key); else state.help.add(key);
    if (renderSheet()) return;
    render();
    // The panel re-renders, so hand focus back to the same "?" the user just pressed.
    for (const node of document.querySelectorAll("[data-help]")) if (node.dataset.help === key) { node.focus(); return; }
  }
  function pickerField(key) {
    const spec = PICKERS[key];
    const off = pickerGateOff(key);
    const disabled = pickerDisabled(key);
    const count = (draftGet(key) || []).length;
    const row = `<div class="picker-row"><button class="button secondary" type="button" data-picker="${key}" ${disabled ? "disabled" : ""}>选择</button><span class="count">已选 ${count} 项</span></div><p class="selected-summary">${esc(pickerSummary(key))}</p>`;
    const desc = off ? `${spec.hint} ${gateNote(key)}` : spec.hint;
    return fieldBlock(spec.title, desc, "", row, key);
  }

  const PLANT_MODE_HELP = "四档都按手里剩下多少枝排、最少的那种先种（默认＝库存最少）。区别只在能种哪几样：库存最少＝所有培育好的花；指定花朵／指定品质＝只圈你选中的那几样／那个品质；置顶花朵＝用你在游戏里置顶的那几样（这边不用勾）。切了模式，别的档里存着的名单和品质一律不算数。";
  const GROUP_HELP = "一种花占这么多块地（一片），一片里只种一种；地数 ÷ 这个数＝地里同时摆几种。地里正长的花换不掉（游戏没有铲除），改这个数从下一批腾空的空地才生效。";
  const RESTOCK_HELP = "设了＝只补手里低于这个枝数的，全补到位后空地留白不种；填 0＝不设目标，一直种。适用范围：库存最少档不参与数量限制；指定花朵／指定品质／置顶花朵这三档才用它（0＝不设）。";
  const TOP_NOTE = "「置顶花朵」这一档没有名单要选：花种直接来自你在游戏里置顶的那几样，这边不勾不选；要换花请在游戏里改置顶。";

  function plantFields() {
    const modes = modeOptions();
    const mode = draftGet("plantMode");
    const modeBlock = modes.length
      ? fieldBlock("种植模式", PLANT_MODE_HELP, "", `<select id="plant-mode" ${state.busy || !state.online ? "disabled" : ""}>${modes.map(one => `<option value="${esc(one.value)}" ${sameId(one.value,mode) ? "selected" : ""}>${esc(one.label)}</option>`).join("")}${modes.some(one => sameId(one.value,mode)) ? "" : `<option value="${esc(mode)}" selected>${esc(modeLabel(mode))}</option>`}</select>`, "plant-mode")
      : `<div class="notice warning">种植模式还没读到，连上手机运行服务后再设置。</div>`;
    const groups = groupOptionValues();
    const groupBlock = groups.length
      ? fieldBlock("种植分组（每片几块地）", GROUP_HELP, "", `<select id="group-size" ${state.busy || !state.online ? "disabled" : ""}>${groups.map(value => `<option value="${esc(value)}" ${sameId(value,draftGet("groupSize")) ? "selected" : ""}>${esc(value)} 块</option>`).join("")}</select>`, "group-size")
      : `<div class="notice warning">种植分组档位还没读到，连上手机运行服务后再设置。</div>`;
    const restockRule = state.metadata.restockCount || {};
    const restock = draftGet("restockCount");
    const restockBlock = fieldBlock("种植数量（枝）", RESTOCK_HELP, "", `<div class="input-unit"><input id="restock-count" type="number" inputmode="numeric" value="${Number.isFinite(Number(restock)) ? esc(restock) : ""}" min="${Number.isFinite(restockRule.min) ? esc(restockRule.min) : 0}" ${state.busy || !state.online ? "disabled" : ""}><span class="unit">枝</span></div>`, "restock-count");
    return featureSwitch("plantEnabled", "自动种花", "开启后，按空地和当前模式安排种植。", false) + `${modeBlock}
      ${mode === MODE_CHOSEN_TOP ? fieldBlock("置顶花朵", TOP_NOTE, "", "", "chosen-top-note") : ""}
      ${pickerField("plantFlowerIds")}
      ${pickerField("plantQualities")}
      ${groupBlock}
      ${pickerField("plantBlacklistIds")}
      ${restockBlock}`;
  }
  /* 摘要行与「设置详情」入口：主页面只报当前值，字段一律点进详情层改。
     读数照旧：没读到就写未读取，不拿 0 或上一份值冒充。 */
  function knownNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }
  /* 卡片骨架与行式入口：卡头是「图标＋标题＋副标题＋箭头＋开关」，卡内每一行都点得进详情，
     并带着要聚焦的那一格，进去就停在该字段上。 */
  function pcardHead(iconName, title, sub, detailKey, switchPath, switchDisabled) {
    return `<div class="pcard-head"><span class="icon-dot">${icon(iconName)}</span><div class="pcard-copy"><strong>${esc(title)}</strong>${sub ? `<p>${esc(sub)}</p>` : ""}</div>${detailKey ? `<button class="acard-link" type="button" data-detail="${esc(detailKey)}" aria-label="打开${esc(title)}设置"><span class="chevron">›</span></button>` : ""}${switchPath ? switchControl(switchPath, title, switchDisabled) : ""}</div>`;
  }
  function prow(label, value, detailKey, focusKey) {
    const missing = value === "未读取" || value === "没读到" || value === "未选择";
    return `<button class="prow" type="button" data-detail="${esc(detailKey)}" data-focus="${esc(focusKey || "")}"><span class="prow-label">${esc(label)}</span><span class="prow-value${missing ? " missing" : ""}">${esc(value)}</span><span class="chevron">›</span></button>`;
  }
  function rulesRow(label, action = "settings-rules") { return `<button class="rules-row" type="button" data-action="${esc(action)}">${icon("book")}${esc(label)}</button>`; }
  function plantCard() {
    const group = knownNumber(state.draft.groupSize);
    return `<section class="pcard">${pcardHead("sprout", "自动种花", "模式、分组与库存目标", "plant", "plantEnabled")}
      ${prow("种植模式", modeLabel(state.draft.plantMode), "plant", "plant-mode")}
      ${prow("每组地块", group === null ? "未读取" : `${group} 块`, "plant", "group-size")}
      ${prow("更多种植设置", "品质 / 黑名单 / 数量", "plant", "plantFlowerIds")}
    </section>`;
  }
  function waterCard() {
    const keep = knownNumber(state.draft.keepWater);
    return `<section class="pcard">${pcardHead("drop", "自动浇水", keep === null ? "保留水滴未读取" : keep === 0 ? "保留 0 滴，用到见底为止" : `保留 ${keep} 滴，低于余量暂不浇水`, "water", "waterEnabled")}
      ${prow("保留水滴", keep === null ? "未读取" : keep === 0 ? "0（不限）" : `${keep} 滴`, "water", "keep-water")}
    </section>`;
  }
  function harvestCard() {
    return `<section class="pcard">${pcardHead("bloom", "自动收花", "同组全部成熟后，再一起收获", "harvest", "harvestEnabled")}</section>`;
  }
  function harvestFields() {
    return featureSwitch("harvestEnabled", "自动收花", "每个种植组单独判断是否全部成熟。", false)
      + `<section class="infocard"><div class="infocard-top">${icon("bloom")}<strong>整组全熟再收</strong></div><p>一组还有花未成熟时，会等这一批全部成熟。成熟后的执行仍以游戏现场状态为准。</p></section>`
      + `<section class="infocard"><div class="infocard-top">${icon("check")}<strong>独立控制</strong></div><p>收花与种花、浇水分别保存开关；收花没有额外的延迟档位。</p></section>`
      + `<section class="infocard"><div class="infocard-top">${icon("clock")}<strong>保存后生效</strong></div><p>这里先修改当前游戏号的草稿，完成后还需在页面底部保存设置。开关不会自动启动游戏号。</p></section>`;
  }
  function waterFields() {
    const rule = state.metadata.keepWater || {};
    const min = Number.isFinite(rule.min) ? rule.min : 0;
    const keep = draftGet("keepWater");
    const box = `<div class="input-unit"><input id="keep-water" type="number" inputmode="numeric" value="${Number.isFinite(Number(keep)) ? esc(keep) : ""}" min="${esc(min)}" ${state.busy || !state.online ? "disabled" : ""}><span class="unit">滴</span></div>`;
    return featureSwitch("waterEnabled", "自动浇水", "开着时按地块需要浇水；低于保留余量就暂时不浇。", false)
      + fieldBlock("保留水滴", "浇水时给手里留这么多水滴作余量：低于这个数就暂时不再浇。填 0＝不限，一直用到见底为止。", "", box, "keep-water")
      + featureSwitch("waterwheelEnabled", "自动领取水车水桶（含视频）", "默认关闭。普通桶连续领取；视频桶按官服结果处理。水车没有桶时按官服30秒节奏醒来复查。", false)
      + featureSwitch("freeWaterEnabled", "自动领取每日水滴", "默认关闭。仅按官服时段和当日领取状态执行；漏领视频按官服资格处理。", false);
  }
    function artLabel(item) {
    const id = item && typeof item === "object" ? item.artId : item;
    const hit = state.flowerArts.find(one => Number(one.id) === Number(id));
    return hit?.label || hit?.name || "成品 " + id;
  }
  const ORDER_CARD_ZH = Object.freeze({
    resident: ["居民订单", "箱子里挂着的那张单：材料够就交出去。这一族的视频单随本卡开关一起启用。"],
    satin: ["绸缎订单", "绸缎那一族的单，交单次数与换单时刻都独立记。视频单随本卡开关一起启用。"],
    decorate: ["建材订单", "建材那一族的单，交单次数与换单时刻都独立记。视频单随本卡开关一起启用。"],
    customer: ["顾客订单", "按所选花坊币档位筛选顾客单；有现货先交，缺货等花艺补齐。自动拒单处理明确排除的档位，资料未知或制作关闭时继续保留。"],
    palace: ["宫廷订单", "宫廷那一张单。下面勾选的品质是「不交」的品质，一个都不勾＝不过滤。这一族没有官方到点提醒，按自己那一格的复查期限巡检。"],
    team: ["组团订单", "团里的单：接免费团、交花、领奖、取存单都按官方当前团状态逐步走，每步确认后才进下一步。"],
  });
  const ORDER_ICONS = Object.freeze({ resident: "leaf", satin: "bloom", decorate: "box", customer: "check", palace: "spark", team: "accounts" });
  /* 卡内每一行对应详情层里的哪一格：点行进去就直接停在那一格上。 */
  const ORDER_SUMMARY_PATHS = Object.freeze({
    resident: ["orders.resident.dailyLimit"], satin: ["orders.satin.dailyLimit"], decorate: ["orders.decorate.dailyLimit"],
    customer: ["orders.customer.coinTiers", "orders.customer.autoReject"], palace: ["orders.palace.qualityFilter"],
    team: ["orders.team.realWrite", "orders.team.allowFreeTake", "orders.team.allowBuyAgain", "orders.team.buyAgainKeepYuanbao"],
  });
  function artLabel(item) {
    const id = item && typeof item === "object" ? item.artId : item;
    const hit = state.flowerArts.find(one => Number(one.id) === Number(id));
    return hit?.label || hit?.name || "成品 " + id;
  }
  const VIDEO_NOTE = "视频单不设独立开关：本卡开关开着就启用这一族的视频单，关掉时普通单和视频单都不再新发。";
  // 设置分类只切换当前账号草稿的展示，不重新读取或覆盖配置。
  const SETTINGS_TABS = Object.freeze([["land", "种花养花"], ["orders", "交订单"], ["art", "花架花艺"], ["rewards", "任务福利"], ["guild", "公会"]]);

  function settingsTabsBar() {
    // 两端运行标记同屏可见：这一串由**本份 app.js 自己**带着，引擎那一串由引擎进程自己报，各自代表各自加载的代码。
    const engine = state.status?.buildId ? String(state.status.buildId) : "引擎版本没读到";
    const client = CLIENT_BUILD_ID.includes("PLACEHOLDER") ? "本包标识未注入" : CLIENT_BUILD_ID;
    return `<div class="subtabs" role="tablist">${SETTINGS_TABS.map(([key, label]) => `<button class="subtab${state.settingsTab === key ? " is-active" : ""}" type="button" role="tab" aria-selected="${state.settingsTab === key}" data-stab="${key}">${esc(label)}</button>`).join("")}</div>`;
  }
  /* 详情层字段块：原型是「粗标签＋整段说明在左，控件在右或在下」，说明不再收进「?」。
     控件仍走同一份 data-path／data-input／data-check 路径，改的是当前层的草稿。 */
  function fieldBlock(title, desc, control, below, focus) {
    return `<div class="field-block"${focus ? ` data-focus-to="${esc(focus)}"` : ""}><div class="fb-head"><div class="fb-copy"><strong>${esc(title)}</strong>${desc ? `<p>${esc(desc)}</p>` : ""}</div>${control ? `<div class="fb-control">${control}</div>` : ""}</div>${below || ""}</div>`;
  }
  function switchControl(path, label, disabled) {
    const on = path === "art.dailyMakeEnabled"
      ? draftGet("art.dailyMakeEnabled") === true && draftGet("art.autoReplenish") === true
      : draftGet(path) === true;
    return `<button class="switch-button" type="button" role="switch" aria-checked="${on}" aria-label="${esc(label)}" data-path="${esc(path)}" ${state.busy || !state.online || disabled ? "disabled" : ""}><span class="switch-track"></span></button>`;
  }
  function featureSwitch(path, label, hint, disabled) {
    return fieldBlock(label, hint, switchControl(path, label, disabled), "", path);
  }
  function featureNumber(path, label, { min, max, suffix, note, disabled }) {
    const value = draftGet(path);
    const known = Number.isFinite(Number(value));
    const attrs = [["min", min], ["max", max]].filter(([, one]) => Number.isFinite(one)).map(([name, one]) => `${name}="${esc(one)}"`).join(" ");
    const id = `in-${String(path).replace(/\./g, "-")}`;
    const box = `<div class="input-unit"><input id="${id}" type="number" inputmode="numeric" data-input="${esc(path)}" value="${known ? esc(value) : ""}" ${attrs} ${state.busy || !state.online || disabled ? "disabled" : ""}><span class="unit">${esc(suffix || "")}</span></div>`;
    return fieldBlock(label, note, "", box, path);
  }
  function featureChecks(path, label, options, note) {
    const chosen = (draftGet(path) || []).map(Number);
    const chips = `<div class="chip-row">${options.map(one => `<label class="chip${chosen.includes(Number(one.value)) ? " is-selected" : ""}"><input type="checkbox" data-check="${esc(path)}:${esc(one.value)}" ${chosen.includes(Number(one.value)) ? "checked" : ""} ${state.busy || !state.online ? "disabled" : ""}>${esc(one.label)}</label>`).join("")}</div>`;
    return fieldBlock(label, note, "", chips, path);
  }
  function orderFieldBlock(group) {
    const meta = state.metadata?.orders?.[group]?.fields || {};
    /* 详情层里第一格就是这张卡自己的开关（原型 customer 板）：本层改、本层生效，完成时一起合入。 */
    const owenable = featureSwitch(`orders.${group}.enabled`, ORDER_CARD_ZH[group][0], ORDER_CARD_ZH[group][1], false);
    const on = draftGet(`orders.${group}.enabled`) === true;
    if (group === "resident" || group === "satin" || group === "decorate") {
      const label = ORDER_CARD_ZH[group][0];
      return owenable + featureNumber(`orders.${group}.dailyLimit`, meta.dailyLimit?.label || `${label}每日数量上限`,
        { min: Number.isFinite(meta.dailyLimit?.min) ? meta.dailyLimit.min : 0, max: Number.isFinite(meta.dailyLimit?.max) ? meta.dailyLimit.max : null, suffix: "单", note: `当日已交多少由官服统计现读；填 0＝不限，填正数＝达到就不再新交。关掉本卡普通单与视频单都不再新发。`, disabled: !on });
    }
    if (group === "customer") {
      return owenable + featureChecks(`orders.customer.coinTiers`, meta.coinTiers?.label || "花坊币档位",
        [{ value: 1, label: "1 档" }, { value: 2, label: "2 档" }, { value: 3, label: "3 档" }],
        "只交档位在你勾里的顾客单；三个都不勾＝一张都不做。档位读不到时按官服那一单的币数如实判，不替你决定。")
        + featureSwitch("orders.customer.autoReject", meta.autoReject?.label || "自动拒单", "拒绝未选档位或已确认缺料、缺瓶而当前无法制作的订单；读不到资料或关闭制作时等待。", !on);
    }
    if (group === "palace") {
      return owenable + featureChecks("orders.palace.qualityFilter", meta.qualityFilter?.label || "品质过滤",
        qualityOptions().map(one => ({ value: one.value, label: one.label })),
        "勾中的品质＝这一档的宫廷单不交；一个都不勾＝不过滤，什么品质都照交。")
        + `<p class="prow-note">宫廷的免费刷新需要可信的免费次数判据，现在还没核清，本版本不自动发刷新（只交单）。</p>`;
    }
    return owenable + featureSwitch("orders.team.realWrite", meta.realWrite?.label || "允许真实团单操作", "关闭后不主动核对或操作团单。开启后按当前团状态接团、交花和领奖。", !on)
      + featureSwitch("orders.team.allowFreeTake", meta.allowFreeTake?.label || "接免费团单", "只接不要钱的团，接了才往下交花。", !on)
      + featureSwitch("orders.team.allowBuyAgain", meta.allowBuyAgain?.label || "允许元宝再加单", "开这一格会花掉游戏内元宝，默认关。", !on)
      /* 额度跟随**当前这一层**的「允许元宝再加单」：详情里当场打开就能当场改，取消仍不动父草稿。 */
      + featureNumber("orders.team.buyAgainKeepYuanbao", meta.buyAgainKeepYuanbao?.label || "元宝保留额度", { min: 0, suffix: "元宝", note: "余额低于这个数就不再花元宝加单。", disabled: !on || draftGet("orders.team.allowBuyAgain") !== true });
  }
  /* 现场读数只说执行器真读到的事；读不到与没有分开说，也供详情层「当前现场」卡复用。 */
  function orderStatusText(group) {
    const facts = state.observations?.orders?.[group];
    const wake = state.observations?.wakes?.[{resident:"order.resident",satin:"order.satin",decorate:"order.decorate",customer:"order.customer",palace:"order.palace",team:"order.team"}[group]];
    if (!facts) return state.observations?.available === false ? `现场订单还没读到：${state.observations?.orders?.reason || "这个游戏号当前没有运行"}。` : "";
    // 组团不是「板上几张单」那一族：官方 107.0 给的是一个当前团位加一张存单表。
    const board = group === "team"
      ? [facts.boardState === "read" ? `团状态现读：${facts.statusWord || "读到一态"}`
          : facts.boardState === "unreadable" ? "组团状态读不到（不是没有团）" : "这一拍没读组团状态",
        Number.isInteger(facts.storedReadyCount) ? `存单 ${facts.storedReadyCount} 张可取` : "",
        facts.dailyReadable === true && Number.isInteger(facts.dailyCount)
          ? `今天已做 ${facts.dailyCount}${Number.isInteger(facts.dailyMax) ? "／上限 " + facts.dailyMax : ""} 团` : ""]
        .filter(Boolean).join("；")
      : Number.isInteger(facts.boardCount) ? `板上现读 ${facts.boardCount} 张` : facts.available === false ? "单板读不到（不是空板）" : "这一拍没有读单";
    const video = ORDER_SWITCH_ONLY_VIDEO.includes(group) ? `；视频单${facts.videoEnabled === true ? "随本卡启用" : "随本卡停用"}` : "";
    const next = wake && wake.enabled === true && Number.isFinite(Number(wake.nextCheckAtMs)) ? `；下一次该动是 ${new Date(Number(wake.nextCheckAtMs)).toLocaleTimeString("zh-CN", { hour12: false })}` : wake && wake.enabled === true ? "；下一次时间没读到" : "";
    return `${board}${video}${next}。`;
  }
  function orderStatusLine(group) {
    const text = orderStatusText(group);
    return text ? `<p class="prow-note">${esc(text)}</p>` : "";
  }
  function orderSummary(group) {
    const one = state.draft.orders[group] || {};
    if (group === "resident" || group === "satin" || group === "decorate") {
      const limit = knownNumber(one.dailyLimit);
      return [["每日上限", limit === null ? "未读取" : limit === 0 ? "0（不限）" : `${limit} 单`]];
    }
    if (group === "customer") return [["花坊币档位", (one.coinTiers || []).length ? `${(one.coinTiers || []).map(Number).join("、")} 档` : "一个都不勾＝一张都不做"], ["自动拒单", displayBoolean(one.autoReject, "开着", "关着")]];
    if (group === "palace") { const list = (one.qualityFilter || []).map(Number); return [["不交的品质", list.length ? list.map(value => qualityName(value)).join("、") : "不过滤，什么品质都照交"]]; }
    return [["允许真实团单操作", displayBoolean(one.realWrite, "开着", "关着")],
      ["接免费团单", displayBoolean(one.allowFreeTake, "开着", "关着")],
      ["元宝再加单", displayBoolean(one.allowBuyAgain, "开着", "关着")],
      ["元宝保留额度", Number.isFinite(Number(one.buyAgainKeepYuanbao)) ? `${one.buyAgainKeepYuanbao} 元宝` : "未读取"]];
  }
  function orderCard(group) {
    const [label] = ORDER_CARD_ZH[group];
    const on = state.draft.orders[group].enabled === true;
    const one = state.draft.orders[group];
    const limit = knownNumber(one.dailyLimit);
    const copy = ["resident","satin","decorate"].includes(group)
      ? `每日 ${limit === null ? "上限未读取" : limit === 0 ? "不限" : limit + " 单"} · 视频随本卡启停`
      : group === "customer" ? "档位筛选 · 自动拒单"
      : group === "palace" ? "禁交品质筛选"
      : "真实团单 · 免费换单 · 元宝留量";
    return pcardHead(ORDER_ICONS[group], label, copy, group, `orders.${group}.enabled`);
  }
  function ordersTab() {
    return sectionRow("自动交订单", "点开卡片设置条件与上限") + `<section class="pcard order-list">${ORDER_KEYS.map(orderCard).join("")}</section>` + rulesRow("查看订单等待原因", "orders-state-help");
  }
  function dailyTaskRewardsCard() {
    const meta = state.metadata?.dailyTaskRewards || {};
    const facts = state.observations?.dailyTaskRewards;
    const wake = state.observations?.wakes?.["reward.daily-task"];
    const reading = facts?.available === true
      ? `官服任务现读 ${Array.isArray(facts.tasks) ? facts.tasks.length : "没读到"} 项；当前可领 ${Number.isInteger(facts.claimableCount) ? facts.claimableCount : "没读到"} 项`
      : "官服任务账尚未读全，不能判断可领数量";
    const next = wake?.enabled === true && Number(wake.nextCheckAtMs) > 0
      ? `；下次检查 ${new Date(Number(wake.nextCheckAtMs)).toLocaleTimeString("zh-CN", { hour12: false })}` : "";
    const uncertain = (facts?.lastResult?.unverified || []).length ? "；有领取未确认，已保留原账并停止后续领取" : "";
    const note = uncertain ? `<p class="prow-note">${esc(uncertain.replace(/^；/,""))}</p>` : "";
    return `<section class="pcard">${pcardHead("box", meta.label || "日常任务奖励", "已达标才领取，不代做底层任务", "dailyTaskRewards", "dailyTaskRewards.enabled")}</section>${note}<p class="prow-note">不含活跃度宝箱、周常和其他奖励。</p>${rulesRow("领取保护", "daily-protection")}`;
  }
  function artFields() {
    const meta = state.metadata?.art || {};
    const makeOn = draftGet("art.makeEnabled") === true;
    const dailyOn = draftGet("art.dailyMakeEnabled") === true && draftGet("art.autoReplenish") === true;
    const on = makeOn || dailyOn;
    const chosen = (draftGet("art.specifiedArts") || []).map(Number);
    // 同名不同配方在花艺里有一族（三只配花不同），只报名字会让几行看起来一模一样；官方名单的 label 自带配花。
    const artLabel = (id) => {
      const item = state.flowerArts.find(one => Number(one.id) === Number(id));
      return item?.label || item?.name || "成品 " + id;
    };
    const names = chosen.map(id => artLabel(id)).join("、");
    const sw = featureSwitch("art.makeEnabled", meta.makeEnabled?.label || "顾客缺货补做", "顾客订单缺少成品时单独处理；不受日常补货模式、目标库存和数量限制。", false);
    return sw + featureSwitch("art.dailyMakeEnabled", "自动补货", "默认关闭。按所选花艺补足目标库存；关闭后不为库存做货。顾客缺货补做由上方独立控制。", false)
      + fieldBlock("补货方式", "切换方式会保留花艺名单和品质选择；只使用当前所选条件。", `<select data-config-choice="art.dailyMode" ${state.busy || !state.online ? "disabled" : ""}><option value="least_stock" ${state.draft.art.dailyMode === "least_stock" ? "selected" : ""}>库存最少优先</option><option value="chosen_quality" ${state.draft.art.dailyMode === "chosen_quality" ? "selected" : ""}>指定品质后库存最少优先</option><option value="chosen_arts" ${state.draft.art.dailyMode === "chosen_arts" ? "selected" : ""}>指定花艺后库存最少优先</option></select>`, "", "art.dailyMode")
      + (state.draft.art.dailyMode === "chosen_quality" ? `<div class="field-block" data-focus-to="art.dailyQualities"><div class="fb-head"><div class="fb-copy"><strong>花艺品质</strong><p>按成品花艺的品质筛选，再从库存较少的开始补做。</p></div></div><div class="picker-row"><button class="button secondary" type="button" data-action="pick-art-qualities" ${state.busy || !state.online ? "disabled" : ""}>选择品质</button><span class="count">已选 ${state.draft.art.dailyQualities.length} 档</span></div></div>` : "")
      + (state.draft.art.dailyMode === "chosen_arts" ? `<div class="field-block" data-focus-to="art.specifiedArts"><div class="fb-head"><div class="fb-copy"><strong>指定花艺</strong><p>只从此名单中挑选，库存较少的优先；切换方式后名单仍会保留。</p></div></div><div class="picker-row"><button class="button secondary" type="button" data-action="pick-arts" ${!on || state.busy || !state.online ? "disabled" : ""}>选择</button><span class="count">已选 ${chosen.length} 件</span></div><p class="selected-summary">${esc(names || "请选择要补做的花艺")}</p></div>` : "")
      + featureNumber("art.targetStock", "目标库存", { min: 1, max: 999, suffix: "件", note: "低于目标时才补货。", disabled: !on })
      + featureNumber("art.makeBatch", "单次制作数量", { min: 1, max: 999, suffix: "件", note: "每次请求最多制作这些数量；配花不足时会按实际可用量减少本次数量。", disabled: !on })
      + '<button class="rules-row" type="button" data-action="art-status">顾客需求与库存状态</button>';
  }
  function flowerRackSellFields() {
    const rack = state.draft.flowerRack, ids = rack.artIds.map(Number);
    const names = ids.map(id => state.flowerArts.find(one => Number(one.id) === id)?.label || `成品 ${id}`).join("、");
    return featureSwitch("flowerRack.enabled", "自动上架与领取", "默认关闭。仅使用本人背包中官服标记可售的成品。", false)
      + `<div class="field-block" data-focus-to="flowerRack.artIds"><div class="fb-head"><div class="fb-copy"><strong>摆货名单</strong><p>只选择花架可售的成品；运行时还会用本人背包与官服类型再次筛选。</p></div></div><div class="picker-row"><button class="button secondary" type="button" data-action="pick-rack-arts" ${state.busy || !state.online ? "disabled" : ""}>选择</button><span class="count">已选 ${ids.length} 件</span></div><p class="selected-summary">${esc(names || "未指定")}</p></div>`
      + fieldBlock("排序方式", "只影响当前候选顺序；不改变官服价格或库存。", `<select data-config-choice="flowerRack.sortStrategy" ${state.busy || !state.online ? "disabled" : ""}><option value="max_stock" ${rack.sortStrategy === "max_stock" ? "selected" : ""}>库存多优先</option><option value="min_stock" ${rack.sortStrategy === "min_stock" ? "selected" : ""}>库存少优先</option><option value="max_price" ${rack.sortStrategy === "max_price" ? "selected" : ""}>当前售价高优先</option></select>`, "", "flowerRack.sortStrategy")
      + featureNumber("flowerRack.putCount", "每次上架数量", { min: 1, max: 12, suffix: "件", note: "每次最多按当前版本花架表与开放格数量限制；缺表时不猜上限。" })
      + '<p class="prow-note">花架余额、在架物品、取消退款和收款分别按官服回包核验；未知状态不会当成空架或免费操作。</p>';
  }
  function flowerRackCancelFields() {
    const rack = state.draft.flowerRack;
    return featureSwitch("flowerRack.autoTakeDown", "自动下架", "默认关闭。达到保留时长并满足官服锁定条件后才处理。", false)
      + featureNumber("flowerRack.keepMinutes", "上架后保留时间", { min: 1, max: 1440, suffix: "分钟" });
  }
  function flowerRackUnlockFields() {
    return featureSwitch("flowerRack.unlockEnabled", "自动解锁新花架", "默认关闭；只在资格、费用和金币预算可核时执行。", false)
      + featureNumber("flowerRack.unlockKeepGold", "解锁后至少保留金币", { min: 0, suffix: "金币" });
  }
  function artSummary() {
    const one = state.draft.art || {};
    const chosen = (one.specifiedArts || []).map(Number);
    const batch = knownNumber(one.makeBatch);
    return [["指定花艺", chosen.length ? `已选 ${chosen.length} 件` : "未限定名单"],
      ["目标库存", knownNumber(one.targetStock) === null ? "未读取" : `${one.targetStock} 件`],
      ["单次制作数量", batch === null ? "未读取" : `${batch} 件`],
      ["自动补货", displayBoolean(one.autoReplenish, "开着", "关着")],
      ["首做图鉴自动领", displayBoolean(one.firstAlbumClaim, "开着", "关着")],
      ["首做分享奖励", displayBoolean(one.firstShareClaim, "开着", "关着")]];
  }
  function artTab() {
    if (!state.draft) return "";
    const art = state.draft.art, rack = state.draft.flowerRack;
    const row = (name, description, panel, glyph) => `<div class="order-row"><button class="order-card-link" type="button" data-panel="${panel}"><span class="feature-icon">${icon(glyph)}</span><span class="feature-copy"><h2>${esc(name)}</h2><p>${esc(description)}</p></span>${icon("ChevronRight")}</button></div>`;
    const on = value => value === true ? "已开启" : "已关闭";
    return `${sectionRow("花艺", "点开卡片查看设置")}<section class="pcard orders-card">
      ${row("花艺制作与自动补货", `顾客制作${on(art.makeEnabled)} · 自动补货${on(art.dailyMakeEnabled === true && art.autoReplenish === true)}`, "art-detail", "Flower")}
      ${row("首做图鉴奖励", on(art.firstAlbumClaim), "art-album", "Gift")}
      ${row("首做分享奖励", on(art.firstShareClaim), "art-share", "BookOpen")}
    </section>${sectionRow("花架", "上架、下架与解锁分别设置")}<section class="pcard orders-card">
      ${row("上架与收款", on(rack.enabled), "flower-rack-detail", "ShoppingBag")}
      ${row("自动下架", on(rack.autoTakeDown), "flower-rack-cancel", "Clock3")}
      ${row("解锁花架", on(rack.unlockEnabled), "flower-rack-unlock", "KeyRound")}
    </section>`;
  }
  function artPickerDialog(sourceNode=null, path="art.specifiedArts", title="指定花艺") {
    let draftTarget=captureDraftTarget(sourceNode);
    if(!validateDraftTarget(draftTarget,{notify:true}).ok)return;
    const choices = path === "art.dailyQualities" ? qualityOptions().map(one => ({ id: String(one.value), label: String(one.label) })) : state.flowerArts;
    if (!choices.length) { toast(path === "art.dailyQualities" ? "品质选项还没读到，连上手机运行服务后再选。 " : "花艺成品目录还没读到，连上手机运行服务后再选。 "); return; }
    const chosen = new Set((getPath(draftTarget.draft,path) || []).map(String));
    const overlay=showDialog(title, `
      <input class="search" id="picker-search" type="search" aria-label="搜索成品名" placeholder="搜索成品名称" enterkeyhint="search">
      <p class="picker-count" id="picker-count">已选 ${chosen.size} 件</p>
      <div class="flower-grid" id="picker-results"></div>`, dialogActions(
      '<button class="button secondary" type="button" data-action="close-dialog">不存，关掉</button>',
      '<button class="button primary-button" type="button" id="picker-save">保存</button>'), "picker-dialog");
    const frame=dialogFrames.find(one=>one.overlay===overlay);
    if(!registerDraftPicker(overlay,draftTarget,next=>{draftTarget=next;return true;})){closeDialog();toast("原设置归属已变化，请返回设置后重新选择。");return;}
    const grid = overlay.querySelector("#picker-results");
    const renderGrid = () => {
      const term = (overlay.querySelector("#picker-search")?.value || "").trim().toLocaleLowerCase();
      const list = choices.filter(one => !term || String(one.label || one.name || "").toLocaleLowerCase().includes(term));
      const onTop = list.filter(one => chosen.has(String(one.id)));
      const rest = list.filter(one => !chosen.has(String(one.id)));
      const card = one => `<label class="flower-option${chosen.has(String(one.id)) ? " is-selected" : ""}"><input type="checkbox" data-pick="${esc(one.id)}" ${chosen.has(String(one.id)) ? "checked" : ""}><span><strong>${esc(one.label || one.name)}</strong></span></label>`;
      grid.innerHTML = (onTop.length + rest.length)
        ? `${onTop.length ? '<p class="group-title">已选</p>' + onTop.map(card).join("") : ""}<p class="group-title">可选项</p>${rest.map(card).join("")}`
        : '<p class="small muted">没有找到匹配项，换个关键词试试。</p>';
      overlay.querySelector("#picker-count").textContent = `已选 ${chosen.size} 件`;
    };
    renderGrid();
    grid.addEventListener("change", event => {
      const id = event.target.dataset?.pick; if (id === undefined) return;
      if (event.target.checked) chosen.add(String(id)); else chosen.delete(String(id));
      renderGrid();
    });
    overlay.querySelector("#picker-search")?.addEventListener("input", renderGrid);
    overlay.querySelector("#picker-save").addEventListener("click", () => {
      if(!overlay.isConnected || dialogFrames.at(-1)!==frame)return;
      const known=new Set(choices.map(one=>String(one.id)));
      const saved=[...choices.filter(one=>chosen.has(String(one.id))).map(one=>String(one.id)),...[...chosen].filter(id=>!known.has(id))];
      if(!applyDraftValue(draftTarget,path,saved,{merge:true}))return;
      updateDirty(); closeDialog(); if (!renderSheet()) render();
    });
  }

  /* 详情弹层一览：paths 就是这张卡在草稿里名下的格子，取消/返回一律不回写父草稿。
     选择器（选花、选品质、选花艺）在详情层里再开一层，栈保住下面那层的输入与滚动。 */
  const DETAILS = {
    plant: { title: "自动种花设置", paths: ["plantEnabled","plantMode","plantFlowerIds","plantQualities","groupSize","plantBlacklistIds","restockCount"], body: () => plantFields() },
    water: { title: "浇水与水车设置", paths: ["waterEnabled","keepWater","waterwheelEnabled","freeWaterEnabled"], body: () => waterFields() },
    harvest: { title: "自动收花", paths: ["harvestEnabled"], body: () => harvestFields() },
    art: { title: "花架与花艺", paths: [], body: () => '<p class="prow-note">请从上方卡片打开唯一设置入口。</p>' },
    "art-detail": { title: "花艺制作", paths: ["art.makeEnabled","art.dailyMakeEnabled","art.dailyMode","art.dailyQualities","art.specifiedArts","art.targetStock","art.makeBatch","art.autoReplenish"], body: () => artFields() },
    "art-album": { title: "首做图鉴奖励", paths: ["art.firstAlbumClaim"], body: () => featureSwitch("art.firstAlbumClaim", "首做图鉴奖励", "按官服图鉴领取花艺经验；已领取的不会重复操作。", false) },
    "art-share": { title: "首做分享奖励", paths: ["art.firstShareClaim"], body: () => featureSwitch("art.firstShareClaim", "首做分享奖励", "只按当前官服分享资格处理；资格未核实时等待。", false) },
    "flower-rack-detail": { title: "上架与收款", paths: ["flowerRack.enabled","flowerRack.artIds","flowerRack.sortStrategy","flowerRack.putCount"], body: () => flowerRackSellFields() },
    "flower-rack-cancel": { title: "自动下架", paths: ["flowerRack.autoTakeDown","flowerRack.keepMinutes"], body: () => flowerRackCancelFields() },
    "flower-rack-unlock": { title: "解锁花架", paths: ["flowerRack.unlockEnabled","flowerRack.unlockKeepGold"], body: () => flowerRackUnlockFields() },
    "art-replenish": { title: "花艺补货说明", paths: [], body: () => '<p class="prow-note">花艺名单和目标库存集中在“花架与花艺”下的花艺制作设置中。</p>' },
    "art-arts": { title: "花艺名单说明", paths: [], body: () => '<p class="prow-note">请从“花架与花艺”下的花艺制作设置选择花艺。</p>' },
  };
  const ORDER_DETAIL_PATHS = {
    resident: ["orders.resident.enabled","orders.resident.dailyLimit"], satin: ["orders.satin.enabled","orders.satin.dailyLimit"], decorate: ["orders.decorate.enabled","orders.decorate.dailyLimit"],
    customer: ["orders.customer.enabled","orders.customer.coinTiers","orders.customer.autoReject"], palace: ["orders.palace.enabled","orders.palace.qualityFilter"],
    team: ["orders.team.enabled","orders.team.realWrite","orders.team.allowFreeTake","orders.team.allowBuyAgain","orders.team.buyAgainKeepYuanbao"],
  };
  for (const group of ORDER_KEYS) DETAILS[group] = { title: ORDER_CARD_ZH[group][0] + "设置", paths: ORDER_DETAIL_PATHS[group], body: () => orderFieldBlock(group) };
  DETAILS.dailyTaskRewards = { title: "日常任务奖励", paths: ["dailyTaskRewards.enabled"], body: () =>
    fieldBlock("自动领取日常任务奖励", "独立开关，默认关闭。关闭后不再发新的领取。", switchControl("dailyTaskRewards.enabled", "自动领取日常任务奖励"), "", "dailyTaskRewards.enabled")
    + `<section class="infocard"><div class="infocard-top">${icon("check")}<strong>领取范围</strong></div><p>只包含日常任务奖励，不包含活跃度宝箱、周常或其他奖励；不会为了领奖自动执行底层任务。</p></section>`
    + `<button class="rules-row" type="button" data-action="daily-status">查看奖励状态</button>`
    + `<button class="rules-row" type="button" data-action="daily-protection">领取保护说明</button>`
    + `<p class="prow-note">改完点「完成设置」只合入本卡草稿；页面底部保存才写本机，不会自动开始运行。</p>` };
  const SHEET_INTRO = { harvest: "同一个种植组的这一批花全部成熟后，一起收获。" };
  const sheetIntro = key => `<p class="dialog-intro">${esc(SHEET_INTRO[key] || ORDER_CARD_ZH[key]?.[1] || "改完点「完成设置」才会合进这一页的设置；点右上角 ✕ 或按返回键退出都不生效。")}</p>`;
  function sheetHead() {
    const account = selected();
    return `<div class="sheet-handle" aria-hidden="true"></div><p class="sheet-eyebrow">自动化 · ${esc(account ? accountName(account) : "当前游戏号")}</p>`;
  }
  function sheetChanged() {
    const layer = currentSheet();
    return Boolean(layer) && (layer.spec.paths || []).some(path => !sameDraftValue(getPath(layer.openingDraft,path),getPath(layer.draft,path)));
  }
  function detailFooter() {
    return `<div class="sheet-foot"><button class="button primary-button" type="button" data-action="detail-done">完成设置</button><p class="sheet-note">这里只改当前游戏号的草稿；完成后还要在页面底部保存设置。开关不会自动启动游戏号。</p></div>`;
  }
  /* 「当前现场」只报这一拍真读到的东西：账号没在跑就照实说没读到，不拿空值冒充「没有」。 */
  function sheetFacts(key) {
    const account = selected();
    const lines = [];
    if (account) lines.push(`这个号现在：${stateLabel(account)}${account.serverName ? `｜${account.serverName}` : ""}。`);
    if (ORDER_KEYS.includes(key)) { const text = orderStatusText(key); if (text) lines.push(text); }
    if (key === "art") {
      const facts = state.observations?.art;
      const wants = Array.isArray(facts?.pendingWants) ? facts.pendingWants : [];
      lines.push(wants.length ? `顾客还在等 ${wants.length} 件成品。` : facts?.wantsState === "none" ? "这一拍查过顾客单：没有缺成品的单。" : "这一拍没读到顾客缺什么。");
      if (facts?.rackView && facts.rackView.state !== "fresh") lines.push(`花艺现场${facts.rackView.state === "stale" ? "是上一拍那一份" : "这一拍还没报回"}：${facts.rackView.reason || "没读到"}。`);
    }
    return `<section class="infocard"><div class="infocard-top">${icon("check")}<strong>当前现场</strong></div><p>${esc(lines.join(" ") || "这一拍没有读到现场信息：账号不在运行时这里就是空的，不拿「没读到」说成「没有」。")}</p></section>`;
  }
  /* 重画同一层时把焦点送回原来那一格：先记住 id 或本仓自定义属性的值，重画后按值找回。 */
  const FOCUS_ATTRS = ["data-picker","data-help","data-input","data-check","data-path","data-detail","data-action"];
  function focusSignature(el) {
    if (!el || el === document.body || el === document.documentElement) return null;
    if (el.id) return { id: el.id };
    for (const attr of FOCUS_ATTRS) { const value = el.getAttribute(attr); if (value !== null) return { attr, value }; }
    return null;
  }
  function restoreFocus(root, signature) {
    if (!root || !signature) return;
    for (const node of root.querySelectorAll(signature.id ? "[id]" : `[${signature.attr}]`)) {
      if (signature.id ? node.id === signature.id : node.getAttribute(signature.attr) === signature.value) { node.focus(); return; }
    }
  }
  function openDetail(key, focus) {
    const spec = DETAILS[key];
    if (!spec) return;
    if (!state.draft && !currentConfigLayer()) { toast("这个账号的设置还没读到，连上手机运行服务后再改。"); return; }
    const layer=makeConfigLayer(key,spec,focus || "");
    if(!layer)return;
    if(sheet)moonLayers.push(layer);else sheet=layer;
    showDialog(spec.title, `${sheetHead()}${sheetIntro(key)}${spec.body()}${sheetFacts(key)}`, detailFooter(), "detail-dialog");
    layer.overlay = $("#dialog-host").lastElementChild;
    const done = layer.overlay.querySelector('[data-action="detail-done"]');
    if (done) done.disabled = !layerMergeStatus(layer).ok;
    updateDraftTransactionUI();
    focusSheetField();
  }
  /* 从卡片某一行进来的，进去就滚到那一格并给它焦点；自己再重画时不抢用户正在填的那一格。 */
  function focusSheetField() {
    const layer=currentSheet();
    if (!layer || !layer.focus || !layer.overlay) return;
    let target = null;
    for (const node of layer.overlay.querySelectorAll("[data-focus-to]")) if (node.dataset.focusTo === layer.focus) { target = node; break; }
    if (!target) target = layer.overlay.querySelector(`input[id="${layer.focus}"],select[id="${layer.focus}"]`);
    if (!target) return;
    try { target.scrollIntoView({ block: "center" }); } catch { /* 老内核不支持参数写法时退回默认滚动 */ }
    const control = ["INPUT", "SELECT", "BUTTON"].includes(target.tagName) ? target : target.querySelector("input,select,button");
    control?.focus({ preventScroll: true });
  }
  /* 详情层自己重画自己：只换正文与「完成」的可点状态，保住滚动位置和正在输入的那一格。 */
  function renderSheet() {
    const layer = currentSheet();
    if (!layer?.overlay?.isConnected) { if (layer) resetSheetState(); return false; }
    if (layer.spec?.moon) {
      const moonScroll = layer.overlay.querySelector(".panel-scroll");
      if (!moonScroll) { resetSheetState(); return false; }
      const moonSignature = focusSignature(document.activeElement);
      const moonTop = moonScroll.scrollTop;
      moonScroll.innerHTML = layer.spec.body();
      const apply = layer.overlay.querySelector('[data-panel-action="apply"]');
      if (apply) apply.disabled = (layer.spec.paths || []).length>0 && !layerMergeStatus(layer).ok;
      moonScroll.scrollTop = moonTop;
      restoreFocus(layer.overlay, moonSignature);
      updateDraftTransactionUI();
      return true;
    }
    const body = layer.overlay.querySelector(".dialog-body");
    const signature = focusSignature(document.activeElement);
    const scroll = body.scrollTop;
    body.innerHTML = `${sheetHead()}${sheetIntro(layer.key)}${layer.spec.body()}${sheetFacts(layer.key)}`;
    const done = layer.overlay.querySelector('[data-action="detail-done"]');
    if (done) done.disabled = (layer.spec.paths || []).length>0 && !layerMergeStatus(layer).ok;
    body.scrollTop = scroll;
    restoreFocus(layer.overlay, signature);
    updateDraftTransactionUI();
    return true;
  }
  /* 详情层里的控件改的是子副本：改完只重画详情层，「完成」当场跟着子草稿差异走，
     主页面的开关仍走整页重绘。子副本在点「完成」之前不会写进父草稿。
     嵌套层同样算「在弹层里」：只认根 sheet 会让子层的数字/勾选改了却不进子草稿。 */
  function inSheet(node) {
    if (!sheet) return false;
    if (sheet.overlay?.contains(node)) return true;
    return moonLayers.some(layer => layer.overlay?.contains(node) === true);
  }
  function afterDraftChange(node) {
    updateDirty();
    if (inSheet(node)) { if (!renderSheet()) render(); return; }
    render();
  }
  function detailDone(sourceNode=null) {
    const layer = currentSheet();
    if (!layer) return;
    if(dialogFrames.at(-1)?.overlay!==layer.overlay || sourceNode && !layer.overlay.contains(sourceNode))return;
    if((layer.spec.paths || []).length){
      const status=layerMergeStatus(layer);
      if(!status.ok){updateDraftTransactionUI();toast(status.message);return;}
      const paths=changedLayerPaths(layer),candidate=cloneDraftValue(layer.parentDraftRef);
      for(const path of paths)if(!setPath(candidate,path,cloneDraftValue(getPath(layer.draft,path)))){toast("设置字段已变化，本层编辑未应用。");return;}
      // Preflight the entire patch before touching the exact captured parent.
      for(const path of paths)setPath(layer.parentDraftRef,path,cloneDraftValue(getPath(candidate,path)));
      if(paths.length){if(layer.parentLayer)layer.parentLayer.revision++;else layer.transaction.revision++;draftEditSequence++;}
    }
    if (moonLayers.length) {
      moonLayers.pop();
      closeDialog();
      updateDirty();
      if (currentSheet()) renderSheet(); else render();
      return;
    }
    resetSheetState();
    closeDialog(); updateDirty(); render();
  }
  /* 取消/✕/返回只丢这一层：上层（父卡）在进入子层之前的草稿原样保留。 */
  function detailCancel() {
    if (moonLayers.length) {
      moonLayers.pop();
      closeDialog();
      if (currentSheet()) renderSheet(); else render();
      return;
    }
    resetSheetState();
    closeDialog(); render();
  }
  /* 关掉最上面这一层：详情层自己的 ✕ 等同「取消」（子副本整份丢弃）；
     详情层上面再开的选择器只退选择器这一层，下面那层就地重画，不重刷页面。 */
  function closeTopDialog() {
    const top = dialogFrames[dialogFrames.length - 1];
    const layer = currentSheet();
    if (layer && top && top.overlay === layer.overlay) { detailCancel(); return; }
    closeDialog();
    if (currentSheet()) renderSheet();
  }
  /* 「设置与运行规则」：只说这份面板真的会做什么、不做什么。 */
  function showRulesSheet() {
    showDialog("当前游戏号设置", `<p class="dialog-intro">设置按账号独立保存。</p>
      <section class="infocard"><div class="infocard-top">${icon("check")}<strong>三个设置分类</strong></div><p>种花收花、交订单、花艺共用当前账号的一份草稿；切换分类不清空未保存修改。</p></section>
      <section class="infocard"><div class="infocard-top">${icon("play")}<strong>保存与开始</strong></div><p>开关只修改草稿，保存不自动启动游戏号；保存后由你点击开始。</p></section>`,
      dialogActions('<button class="button primary-button" type="button" data-action="close-dialog">知道了</button>'));
  }
  /* 领取保护：只讲领奖时怎么防重复、怎么确认到账、未知怎么办；不改任何字段。 */
  function showDailyStatusSheet() {
    const facts = state.observations?.dailyTaskRewards;
    const wake = state.observations?.wakes?.["reward.daily-task"];
    const off = draftGet("dailyTaskRewards.enabled") !== true;
    const available = facts?.available === true;
    const claimable = Number.isInteger(facts?.claimableCount) ? facts.claimableCount : null;
    const tasks = Array.isArray(facts?.tasks) ? facts.tasks : [];
    const allClaimed = tasks.length > 0 && tasks.every(task => task && task.claimed === true);
    const unverified = Array.isArray(facts?.lastResult?.unverified) ? facts.lastResult.unverified.length : 0;
    const current = off ? "已关闭" : !available || claimable === null ? "状态未读全" : unverified > 0 ? "结果待核对" : claimable > 0 ? "可领取" : allClaimed ? "已领取" : "待达标";
    const cards = [
      ["已关闭", "自动领取已关闭。任务进度可查看，不再发新的领取。"],
      ["待达标", "任务尚未完成，继续等待。不会为了领奖自动执行任务需要的业务。"],
      ["可领取", "官服确认已达标且尚未领取，等待本类检查安排。保持自动领取开关开启即可。"],
      ["已领取", "今日该项奖励已确认领取，不再重复领取。切换日期时重新读取当天任务账。"],
      ["结果待核对", "这一笔领取尚未确认，原记录已保留，不重发。通过正常连接读取当前状态，再判断当前可执行事项。"]
    ];
    const next = wake?.enabled === true && Number(wake.nextCheckAtMs) > 0 ? new Date(Number(wake.nextCheckAtMs)).toLocaleTimeString("zh-CN", { hour12: false }) : "待获取";
    showDialog("日常奖励状态", `<p class="dialog-intro">这一拍读到：${esc(current)}。下面列出各状态的含义，不把未读到当成 0。</p>${cards.map(([label, text]) => `<section class="infocard"><div class="infocard-top">${icon("clock")}<strong>${esc(label)}</strong></div><p>${esc(text)}</p></section>`).join("")}<p class="prow-note">下次检查：${esc(next)}。以上是状态说明，不是当前账号每一项的官服结果。</p>`,
      dialogActions('<button class="button primary-button" type="button" data-action="close-dialog">知道了</button>'));
  }
  function showDailyProtectionSheet() {
    showDialog("领取保护", `<p class="dialog-intro">按当前官服状态判断领取资格，原操作记录持续保留。</p>
      <section class="infocard"><div class="infocard-top">${icon("check")}<strong>避免重复领取</strong></div><p>必要任务字段必须读全；跨日时读取当天任务，不能把昨天的已领结果沿用到今天。</p></section>
      <section class="infocard"><div class="infocard-top">${icon("check")}<strong>确认来自真实结果</strong></div><p>发出请求或收到 RPC 回话不等于奖励到账；业务确认后才记为已确认。</p></section>
      <section class="infocard"><div class="infocard-top">${icon("clock")}<strong>结果未知时</strong></div><p>不重发原领取，不删除旧账，也不把未知改成成功；重新连接并读取当前可信状态后独立判断当前资格。</p></section>`,
      dialogActions('<button class="button primary-button" type="button" data-action="close-dialog">知道了</button>'));
  }
  /* 花艺与顾客订单如何配合：只讲固定配合顺序，不伪造官服结果；开关仍各归各卡。 */
  function showCustomerArtSheet() {
    showDialog("顾客订单与花艺", `<p class="dialog-intro">缺成品时先补做，官方确认成品入库后再交付。</p>
      <section class="infocard"><div class="infocard-top">${icon("check")}<strong>1 · 识别需求</strong></div><p>从当前顾客订单读取缺少的成品与数量。</p></section>
      <section class="infocard"><div class="infocard-top">${icon("check")}<strong>2 · 花艺优先制作</strong></div><p>做花艺开着时，优先处理顾客需求；不受日常指定名单和目标库存限制。</p></section>
      <section class="infocard"><div class="infocard-top">${icon("check")}<strong>3 · 确认后交付</strong></div><p>收到官方确认后，叫醒顾客订单继续交付。</p></section>
      <section class="infocard"><div class="infocard-top">${icon("bloom")}<strong>状态缺失时等待</strong></div><p>配花、花瓶、库存读不到不等于做不了。只有确实无法制作且自动拒单开启，才执行拒单。</p></section>
      <button class="rules-row" type="button" data-action="open-art-detail">${icon("bloom")}查看花艺制作设置</button>`,
      dialogActions('<button class="button primary-button" type="button" data-action="close-dialog">知道了</button>'));
  }
  /* 一条运行记录的详情：只展开这一条的原话与归属，不给改结果的入口。 */
  function showLogDetail(index) {
    const item = state.logs[index];
    if (!item) return;
    state.selectedLogRecord = {
      ...item,
      scope: state.logsScope,
      accountId: state.logsScope === "device" ? null : isArchivedLogRef(state.logsScope) ? state.logsScope.slice(8) : state.selectedId,
      accountName: logSourceView().name,
      archivedAccount: isArchivedLogRef(state.logsScope),
    };
    if (window.MoonUI && DETAILS["log-detail"]?.moon) { openMoonPanel("log-detail"); return; }
    const level = item.level || item.severity;
    const levelLabel = ({error: "需要处理", warn: "请留意", warning: "请留意", success: "已完成", info: "运行记录"})[level] || "运行记录";
    const message = item.messageZh || item.message || item.text || item.summary || "这条记录暂时没有可显示的说明。";
    const category = typeof item.category === "string" && item.category.trim() ? item.category.trim() : "未分类";
    const account = logSourceView().name;
    const at = item.at || item.ts || item.timestamp || item.time || item.createdAt;
    const principle = ["warn", "warning"].includes(level)
      ? "状态未读到不等于失败或没有资格。保留原始记录，不重发旧操作；当前合法候选按本次可信状态安排。"
      : "完成标识以业务确认为依据，不能仅凭请求已提交。记录内容保留，不提供修改操作结果的入口。";
    const diagnostic = [item.eventType && `事件：${item.eventType}`, item.phase && `阶段：${item.phase}`,
      item.method && `方法：${item.method}`, item.errorCode && `错误码：${item.errorCode}`,
      item.outcomeState && `结果：${item.outcomeState}`, item.operationId && `操作：${item.operationId}`,
      item.traceId && `追踪：${item.traceId}`, Number.isSafeInteger(item.connectionEpoch) && `连接代次：${item.connectionEpoch}`,
      Number.isSafeInteger(item.runEpoch) && `运行代次：${item.runEpoch}`,
      item.detail?.gateDiagnostics && `核验条件：${JSON.stringify(item.detail.gateDiagnostics)}`].filter(Boolean).join(" · ");
    showDialog("运行记录", `<p class="dialog-intro">查看这条记录的时间、归属与完整内容。</p>
      <section class="infocard"><div class="infocard-top">${icon("clock")}<strong>记录时间</strong></div><p>${esc(dateText(at))}</p></section>
      <section class="infocard"><div class="infocard-top">${icon("accounts")}<strong>所属游戏号</strong></div><p>${esc(account)}</p></section>
      <section class="infocard"><div class="infocard-top">${icon("logs")}<strong>分类</strong></div><p>${esc(category)}</p></section>
      <section class="infocard"><div class="infocard-top">${icon(level === "error" || ["warn", "warning"].includes(level) ? "clock" : "check")}<strong>状态 · ${esc(levelLabel)}</strong></div><p>${esc(levelLabel)}，以这条记录的实际内容为准。</p></section>
      <section class="infocard"><div class="infocard-top">${icon("logs")}<strong>记录内容</strong></div><p>${esc(message)}</p></section>
      ${diagnostic ? `<section class="infocard"><div class="infocard-top">${icon("book")}<strong>阶段与核验详情</strong></div><p>${esc(diagnostic)}</p></section>` : ""}
      <section class="infocard"><div class="infocard-top">${icon("book")}<strong>核对原则</strong></div><p>${esc(principle)}</p></section>`,
      dialogActions('<button class="button primary-button" type="button" data-action="close-dialog">知道了</button>'));
  }
  function saveDock() {
    const account = selected();
    const stoppable = account && canStop(account);
    const actionDisabled = stoppable ? !canPersistAccountStop(account) || state.busy === `stop:${state.selectedId}` : !state.online || state.busy;
    return `<div class="save-dock"><div class="save-row"><button class="button ${state.dirty ? "primary-button" : "secondary"} save-main" type="button" data-action="save-config" ${!state.online || state.busy || !state.dirty ? "disabled" : ""}>${state.busy === "save" ? "正在保存…" : state.dirty ? "保存设置" : "✓ 设置已保存"}</button><button class="acard-run save-run ${stoppable ? "danger" : ""}" type="button" data-action="${stoppable ? "stop" : "start"}" data-id="${esc(state.selectedId)}" ${actionDisabled ? "disabled" : ""}>${account && isPending(account) ? "停止" : stoppable ? "停止" : "开始"}</button></div><p class="save-hint">${state.dirty ? "有尚未保存的修改；保存只写这一份草稿，不会替你启动账号。" : "保存仅对当前游戏号生效；不会自动开始运行。"}</p></div>`;
  }
  function renderSettings() {
    let content = pageHead("自动化设置", "按账号设置种花收花、交订单与花艺。", accountPill());
    if (!state.accounts.length) return content + (state.online ? emptyAccount() : unreadableCard());
    if (state.configLoading) return content + '<div class="card skeleton">正在读取这个账号的设置…</div>';
    if (state.configError || !state.draft) return content + `<div class="notice error">${esc(state.configError || "账号设置未读取，请重试。")}</div><div class="dialog-actions"><button class="button" type="button" data-action="reload-config">重新读取设置</button><button class="button secondary" type="button" data-action="service-help-offline">连接帮助</button></div>`;
    if (!state.catalogReady) content += `<div class="notice warning">${esc(state.catalogError || "花种与选项目录正在读取…")}</div>`;
    content += settingsTabsBar();
    if (state.settingsTab === "land") content += sectionRow("花园日常", "点开卡片查看全部设置") + plantCard() + waterCard() + harvestCard() + rulesRow("设置与运行规则");
    else if (state.settingsTab === "orders") content += ordersTab() + rulesRow("设置与运行规则");
    else if (state.settingsTab === "rewards" || state.settingsTab === "guild") content += '<div class="infocard"><p>这一类设置由当前正式设置层显示；如果这里出现空白，请返回后重新进入。</p></div>';
    else content += artTab();
    return content + saveDock();
  }

  function dateText(value) {
    if (value === null || value === undefined || value === "") return "时间未读到";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "时间未读到" : date.toLocaleString("zh-CN", {timeZone:"Asia/Shanghai",hour12:false,month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"});
  }
  const LOG_PAGE_SIZE = 15;
  function logsPager() {
    const busy = state.logsLoading || Boolean(state.logsContinuation);
    const prevOff = !state.logsStack.length || busy;
    const nextOff = !state.logsHasMore || !state.logsOlder || busy;
    return `<div class="log-pager"><button class="button secondary" type="button" data-action="logs-prev" ${prevOff ? "disabled" : ""}>上一页</button><p class="pager-note">第 ${state.logsStack.length + 1} 页 · 每页 ${LOG_PAGE_SIZE} 条</p><button class="button secondary" type="button" data-action="logs-next" ${nextOff ? "disabled" : ""}>下一页</button></div>`;
  }
  /* 一条记录拆成「一句话标题＋后面的事实」；拆不出来就原样当标题，不硬造第二行。 */
  function logHeadline(message) {
    const text = String(message || "").trim();
    const cut = /^(.{2,20}?)([，,；;：:。])([\s\S]{4,})$/.exec(text);
    if (cut) return { title: cut[1], body: cut[3].trim() };
    if (text.length > 26) return { title: text.slice(0, 24) + "…", body: "" };
    return { title: text, body: "" };
  }
  function shortTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "时间未读到";
    const formatter = new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false});
    const parts = input => Object.fromEntries(formatter.formatToParts(input).map(part => [part.type, part.value]));
    const shown = parts(date), today = parts(new Date()), hhmm = `${shown.hour}:${shown.minute}`;
    return shown.year === today.year && shown.month === today.month && shown.day === today.day ? hhmm : `${shown.month}-${shown.day} ${hhmm}`;
  }
  function logScopeSheet() {
    showAccountChoice(true);
  }
  /* 原型日志页的筛选不是把 12 个分类平铺成一条，而是「全部/种花/浇水/收花/更多」，
     更多与右上角、日期行都打开同一张完整筛选层：来源、分类、日期一次改完再重读。 */
  function logFilterSheet() {
    const scopeValue = logSourceRef();
    const scopes = logSourceOptions();
    const categories = ["", ...(state.logCategories || [])];
    const days = ["", ...(state.logDays || [])];
    const levels = ["", "debug", "info", "warn", "warning", "error", "success"], outcomes = ["", "confirmed", "rejected", "unknown", "failed", "dirty", "scheduled", "waiting"];
    const body = `<form id="log-filter-form" class="log-filter-form">
      <label class="field"><span>查看记录</span><select id="log-filter-scope" aria-label="查看哪一份记录">${scopes.map(one => `<option value="${esc(one.value)}" ${one.value === scopeValue ? "selected" : ""}>${esc(one.label)}</option>`).join("")}</select></label>
      <label class="field"><span>分类</span><select id="log-filter-category" aria-label="按分类筛选">${categories.map(one => `<option value="${esc(one)}" ${one === state.logsCategory ? "selected" : ""}>${esc(one || "全部分类")}</option>`).join("")}</select></label>
      <label class="field"><span>日期</span><select id="log-filter-day" aria-label="按日期筛选">${days.map(one => `<option value="${esc(one)}" ${one === state.logsDay ? "selected" : ""}>${esc(one || "全部日期")}</option>`).join("")}</select></label>
      <label class="field"><span>关键词</span><input id="log-filter-keyword" maxlength="160" value="${esc(state.logsKeyword)}" placeholder="搜索日志内容或错误码"></label>
      <label class="field"><span>错误码</span><input id="log-filter-error-code" maxlength="128" value="${esc(state.logsErrorCode)}" placeholder="完整错误码，留空查看全部"></label>
      <label class="field"><span>操作 ID</span><input id="log-filter-operation-id" maxlength="64" value="${esc(state.logsOperationId)}" placeholder="留空查看全部操作"></label>
      <label class="field"><span>追踪 ID</span><input id="log-filter-trace-id" maxlength="64" value="${esc(state.logsTraceId)}" placeholder="留空查看全部追踪"></label>
      <label class="field"><span>等级</span><select id="log-filter-level" aria-label="按日志等级筛选">${levels.map(one => `<option value="${one}" ${one === state.logsLevel ? "selected" : ""}>${({"":"全部等级",debug:"调试",info:"提示",warn:"警告",warning:"警告",error:"错误",success:"成功"})[one]}</option>`).join("")}</select></label>
      <label class="field"><span>结果</span><select id="log-filter-outcome" aria-label="按结果筛选">${outcomes.map(one => `<option value="${one}" ${one === state.logsOutcome ? "selected" : ""}>${esc(one || "全部结果")}</option>`).join("")}</select></label>
      <p class="small muted">每页 15 条；筛选在完整记录中生效，更换条件会回到第一页。</p>
    </form>`;
    showDialog("筛选运行日志", body, dialogActions(
      '<button class="button secondary" type="button" data-action="clear-log-filters">清除筛选</button>',
      '<button class="button primary-button" type="button" data-action="apply-log-filters">查看筛选结果</button>'), "form-dialog");
  }
  function renderLogs() {
    const account = selected();
    const logSource = logSourceView(), scopeLabel = logSource.name;
    const headFilter = `<button class="logs-filter-button" type="button" data-action="logs-filter-open" aria-label="筛选运行日志">${icon("listFilter")}</button>`;
    let content = pageHead("运行日志", "", headFilter);
    content += `<button class="acct-card logs-scope" type="button" data-action="pick-log-scope"><span class="avatar" aria-hidden="true">${esc(scopeLabel.slice(0, 1))}</span><span class="scope-copy"><strong>${esc(scopeLabel)}</strong><p>${esc(logSource.meta)}</p></span><span class="chevrons" aria-hidden="true">${icon("chevronsUpDown")}</span></button>`;
    const fixed = ["", "种花", "浇水", "收花"];
    const extra = state.logsCategory && !fixed.includes(state.logsCategory) ? state.logsCategory : "";
    content += `<div class="chip-tabs" role="tablist">${fixed.map(name => `<button class="chip-tab${state.logsCategory === name ? " is-active" : ""}" type="button" role="tab" aria-selected="${state.logsCategory === name}" data-log-category="${esc(name)}">${esc(name || "全部")}</button>`).join("")}<button class="chip-tab${extra ? " is-active" : ""}" type="button" role="tab" aria-selected="${Boolean(extra)}" data-action="logs-filter-open">${extra ? `更多 · ${esc(extra)}` : "更多"}</button></div>`;
    const scopeHint = logSource.archived ? "历史记录 · 已移除 · 只读" : state.logsScope === "device" ? "本机记录" : "账号记录";
    const activeFilters = Boolean(state.logsCategory || state.logsDay || state.logsKeyword || state.logsLevel || state.logsOutcome || state.logsErrorCode || state.logsTraceId || state.logsOperationId);
    content += `<div class="date-row">${icon("calendar")}<button class="log-date-button" type="button" data-action="logs-filter-open">${esc(state.logsDay || "全部日期")}${icon("chevronDown")}</button><span class="log-date-hint">${activeFilters ? "筛选生效 · 点此查看详情" : `${scopeHint} · 点此查看详情`}</span></div>`;
    content += `<div class="log-date-hint">错误/失败日志自动上传，其余记录仅在你从这里明确选择后上传。</div>`;
    content += `<button class="button secondary wide" type="button" data-action="upload-filtered-logs">上传当前筛选结果（全部匹配记录）</button>`;
    if (state.logsTraceId || state.logsOperationId) content += `<div class="log-date-hint">正在按${state.logsTraceId ? `追踪标识 ${esc(state.logsTraceId)}` : `操作标识 ${esc(state.logsOperationId)}`}筛选 <button class="button secondary" type="button" data-action="clear-log-filters">清除筛选</button></div>`;
    if (state.logsLoading) return content + '<div class="card skeleton">正在读取运行日志…</div>';
    if (state.logsError) return content + `<div class="notice error">${esc(state.logsError)}</div><button class="button" type="button" data-action="reload-logs">重新读取</button>`;
    if (state.logsNotice) content += `<div class="notice" role="status">${esc(state.logsNotice)}</div>`;
    if (!state.logs.length && state.logsNotice) return content + '<button class="button secondary" type="button" data-action="reload-logs">重新读取</button>';
    if (!state.logs.length) return content + `<section class="logs-empty"><div class="empty-symbol">${icon("logs")}</div><h2>${state.logsCategory || state.logsDay ? "这组筛选没有记录" : "还没有记录"}</h2><p>${state.logsCategory || state.logsDay ? "换个分类、换个日期，或用右上角筛选清除；已发生的记录不会因为筛选而消失。" : "账号添加失败、连接异常和实际操作进度会保存在对应记录中。"}</p></section>` + (state.logsStack.length ? logsPager() : "");
    content += `<ol class="timeline">${state.logs.map((item, index) => {
      const level = item.level || item.severity;
      const kind = level === "error" ? "is-error" : ["warn", "warning"].includes(level) ? "is-warn" : "";
      const label = ({error: "需要处理", warn: "等待状态", warning: "等待状态", success: "完成", info: "已记录"})[level] || "已记录";
      const message = item.messageZh || item.message || item.text || item.summary || "这条记录暂时没有可显示的说明。";
      const { title, body } = logHeadline(message);
      return `<li class="tl-item ${kind}"><span class="tl-time">${esc(shortTime(item.at || item.ts || item.timestamp || item.time || item.createdAt))}</span><span class="tl-rail" aria-hidden="true"></span><button class="tl-card" type="button" data-action="log-detail" data-index="${index}"><span class="tl-card-top"><strong class="tl-title">${esc(title)}</strong><span class="tl-tag">${esc(label)}</span></span>${body ? `<span class="tl-body">${esc(body)}</span>` : ""}</button></li>`;
    }).join("")}</ol>` + logsPager();
    return content;
  }
  function displayBoolean(value, yes, no) { return value === true ? yes : value === false ? no : "未读取"; }
  function probeText(probe) {
    const status = probe?.status;
    if (!status) return "未开始";
    const labels = { running: "进行中", passed: "通过", failed: "未通过", "not-locked": "未锁屏，不算通过", cancelled: "已取消", interrupted: "已中断" };
    if (status === "running") return `${labels.running}（已进行 ${Math.round((probe.elapsedMs || 0) / 1000)} 秒，锁屏 ${Math.round((probe.screenOffTotalMs || 0) / 1000)} 秒）`;
    if (status === "passed") return `通过（锁屏 ${Math.round((probe.screenOffTotalMs || 0) / 1000)} 秒，心跳最大间隔 ${Math.round((probe.maxHeartbeatGapMs || 0) / 1000)} 秒）`;
    return `${labels[status] || status}${probe.reason ? `（${probe.reason}）` : ""}`;
  }
  function stopConfirmationText(value) {
    if (!value || typeof value !== "object") return "未读取";
    if (value.residualDesired === true) return "本机服务已耐久确认停止；本地停止标记未写入，后台恢复已拦截";
    if (value.source === "backend-control-record") return value.cleanupComplete === true
      ? `本机服务已确认停止（控制记录 #${value.controlSeq || "?"}，已排空）`
      : `停止意愿已耐久确认（控制记录 #${value.controlSeq || "?"}），排空未完成`;
    if (value.source === "local-latch") return "停止意愿已落盘，等待本机服务排空确认";
    return "没有待处理的停止请求";
  }
  function softwareCard() {
    const info = softwareInfo();
    if (!info) return '<section class="card"><h2>软件账号</h2><p class="small muted">软件账号状态没有读到，请刷新后再看。</p></section>';
    const authorized = info.authorized === true;
    const rows = [
      ["软件账号", info.user && info.user.username ? info.user.username : "未登录"],
      ["授权状态", authorized ? "有效" : LICENSE_COPY[info.licenseState] || "已暂停"],
      ["离线剩余", Number.isFinite(Number(info.graceRemainingMs)) ? `${Math.max(0, Math.round(Number(info.graceRemainingMs) / 60000))} 分钟` : "未读到"],
      ["待传日志", Number.isFinite(Number(info.queue?.pending)) ? `${info.queue.pending} 条` : "未读到"],
      ["未归属日志", Number.isFinite(Number(info.queue?.unowned)) ? `${info.queue.unowned} 条` : "未读到"],
      ["日志缺口", Number.isFinite(Number(info.queue?.gapEvents)) ? `${info.queue.gapEvents} 条` : "未读到"],
      ["上次同步", info.queue && info.queue.lastUploadAt ? dateText(info.queue.lastUploadAt) : "还没有同步过"],
      ["同步节奏", Number.isFinite(Number(info.queue?.baselineMs)) ? `约 ${Math.round(Number(info.queue.baselineMs) / 1000)} 秒一批，全部日志共用 ${Math.max(1, Math.round(Number(info.queue.cooldownMs || 60000) / 60000))} 分钟发送额度` : "未读到"],
      ["同步配额", Number.isFinite(Number(info.queue?.quotaEvents)) ? (info.queue.quotaWarning === true ? `待传 ${info.queue.pending || 0} 条，已达上限 ${info.queue.quotaEvents} 条的八成` : `待传 ${info.queue.pending || 0} 条，未达上限 ${info.queue.quotaEvents} 条的八成`) : "未读到"],
    ];
    const claim = info.claimRequired ? '<p class="notice">本机还有没有确认归属的历史资料。确认之前不会恢复旧任务，也不会上传记录。</p><button class="button wide" type="button" data-action="claim-data">确认归属到当前软件账号</button>' : "";
    return `<section class="card"><div class="section-head"><h2>软件账号</h2><span class="count">${esc(info.updatedAt ? dateText(info.updatedAt) : (info.user && info.user.username ? "已登录" : "未读到"))}</span></div><p class="body-copy">${esc(licenseLine())}</p><dl class="detail-list">${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>${claim}<div class="dialog-actions"><button class="button secondary" type="button" data-action="check-license">立即核对授权</button><button class="button secondary" type="button" data-action="upload-logs">查看日志并选择上传</button></div><div class="dialog-actions"><button class="button secondary" type="button" data-action="change-password">修改密码</button><button class="button danger" type="button" data-action="software-logout">退出登录</button></div></section>`;
  }
  function renderMe() {
    const info = softwareInfo();
    const route = state.egress;
    const routeText = route?.routing === "proxy" ? `所有账号使用：${route.display}` : route?.routing === "direct" ? "所有账号使用本机网络" : "尚未设置统一出口";
    const license = info ? (LICENSE_COPY[info.licenseState] || "状态未读到") : "状态未读到";
    return pageHead("我的", "", `<button class="logs-filter-button" type="button" data-action="help" aria-label="使用说明">${icon("settings")}</button>`)
      + `<button class="acct-card me-account-card" type="button" data-action="me-software"><span class="avatar" aria-hidden="true">园</span><span><strong>我的软件账号</strong><p>软件身份与游戏账号分开管理</p></span><span class="chevron">›</span></button>`
      + sectionRow("软件与授权", "")
      + `<section class="pcard me-list">
          ${meRow("check", "软件授权", license, "me-license", "查看详情")}
          ${meRow("lock", "修改密码", "改密后本机会话全部作废", "change-password")}
          ${meRow("logs", "日志同步", "待传、缺口与上次同步", "me-sync", "查看状态")}
        </section>`
      + sectionRow("本机运行", "")
      + `<section class="pcard me-list">
          ${meRow("play", "运行服务", "执行器与后台运行状态", "me-runtime", "查看状态")}
          ${meRow("clock", "后台运行说明", "通知、电池与强行停止", "me-background")}
          ${meRow("settings", "网络出口", routeText, "me-egress", "查看设置")}
        </section>`
      + `<p class="prow-note me-note">账号归属、日志缺口与待核查结果都保留在各自详情里。</p>`
      + `<button class="text-button me-logout" type="button" data-action="software-logout">退出软件账号</button>`;
  }
  function meRow(iconName, title, sub, action, value) {
    return `<button class="prow me-row" type="button" data-action="${esc(action)}"><span class="icon-dot">${icon(iconName)}</span><span class="prow-label">${esc(title)}</span><span class="prow-value">${esc(value || "")}</span><span class="chevron">›</span></button>`;
  }
  /* 我的：每个分组行都打开对应详情，真实读数与按钮沿用原接口，不把旧大卡整块留在首页。 */
  function openProductionReadSheet(id) {
    if (!window.MoonUI?.sheetHTML || !DETAILS[id]?.moon || DETAILS[id].config) return false;
    // Reuse the migrated prototype structure with live facts. A read-only child must not reset
    // the configuration transaction underneath it; its empty path list never writes a draft.
    return currentSheet() ? pushMoonLayer(id) : openMoonPanel(id);
  }
  function showSoftwareSheet() {
    if (openProductionReadSheet("software-account")) return;
    showDialog("我的软件账号", softwareCard() + '<button class="rules-row" type="button" data-action="me-ownership">资料归属 · 本机资料归到哪个软件账号</button><p class="prow-note">软件身份与游戏账号分开管理；退出不会删除本机游戏号或历史记录。</p>',
      dialogActions('<button class="button secondary" type="button" data-action="close-dialog">关掉</button>'));
  }
  function showLicenseSheet() {
    if (openProductionReadSheet("license")) return;
    const info = softwareInfo();
    if (!info) { toast("软件账号状态还没读到，请刷新后再看。"); return; }
    const rows = [["软件账号", info.user && info.user.username ? info.user.username : "未登录"], ["授权状态", LICENSE_COPY[info.licenseState] || "状态未读到"], ["离线剩余", Number.isFinite(Number(info.graceRemainingMs)) ? `${Math.max(0, Math.round(Number(info.graceRemainingMs) / 60000))} 分钟` : "未读到"]];
    showDialog("软件授权", `<p class="dialog-intro">${esc(licenseLine())}</p><dl class="detail-list">${rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl><button class="button secondary wide" type="button" data-action="check-license">立即核对授权</button>`,
      dialogActions('<button class="button secondary" type="button" data-action="close-dialog">关掉</button>'));
  }
  function showLogSyncSheet() {
    if (openProductionReadSheet("sync")) return;
    const info = softwareInfo();
    if (!info) { toast("软件账号状态还没读到，请刷新后再看。"); return; }
    const queue = info.queue || {};
    const rows = [["待传日志", Number.isFinite(Number(queue.pending)) ? `${queue.pending} 条` : "未读到"], ["未归属日志", Number.isFinite(Number(queue.unowned)) ? `${queue.unowned} 条` : "未读到"], ["日志缺口", Number.isFinite(Number(queue.gapEvents)) ? `${queue.gapEvents} 条` : "未读到"], ["上次同步", queue.lastUploadAt ? dateText(queue.lastUploadAt) : "还没有同步过"], ["同步配额", Number.isFinite(Number(queue.quotaEvents)) ? (queue.quotaWarning === true ? `待传 ${queue.pending || 0} 条，已达上限 ${queue.quotaEvents} 条的八成` : `待传 ${queue.pending || 0} 条，未达上限 ${queue.quotaEvents} 条的八成`) : "未读到"]];
    showDialog("日志同步", `<p class="dialog-intro">错误或失败记录自动上传；其他日志保留在本机，需在运行日志页按当前筛选明确选择后上传。</p><dl class="detail-list">${rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl><button class="button secondary wide" type="button" data-action="upload-logs">查看日志并选择上传</button>`,
      dialogActions('<button class="button secondary" type="button" data-action="close-dialog">关掉</button>'));
  }
  function showRuntimeSheet() {
    if (openProductionReadSheet("service")) return;
    const device = {...state.status.device,...state.device};
    const runtime = state.status.runtime || {};
    const service = device.serviceRunning ?? runtime.serviceRunning ?? runtime.running;
    const foreground = device.foregroundServiceRunning ?? device.foregroundService ?? runtime.foregroundService;
    const battery = device.batteryOptimizationExempt ?? device.ignoringBatteryOptimizations ?? device.batteryUnrestricted;
    const notifications = device.notificationsEnabled ?? device.notificationPermission;
    const android = device.androidVersion ?? device.release;
    const model = device.model || device.deviceModel;
    let keepAlive = device.keepAlive && typeof device.keepAlive === "object" ? device.keepAlive : {};
    // Read the live confirmation at open time; a cached panel snapshot can
    // predate a STOP whose local preference write failed.
    try {
      const live = JSON.parse(window.AndroidBridge?.keepAliveStatus?.() || "null");
      if (live && typeof live === "object") keepAlive = live;
    } catch { /* keep the last rendered facts */ }
    const rows = [["手机型号", model || "未读取"], ["系统版本", android ? `Android ${android}` : "未读取"], ["后台运行服务", displayBoolean(service, "已启动", "未启动")], ["停止确认", stopConfirmationText(keepAlive.stopConfirmation)], ["持续运行通知", displayBoolean(foreground, "已开启", "未开启")], ["通知权限", displayBoolean(notifications, "已允许", "未允许")], ["电池优化", displayBoolean(battery, "已允许持续运行", "仍受系统优化限制")],
      ["精确闹钟", displayBoolean(keepAlive.exactAlarmsAllowed, "已允许", "未允许")],
      ["可选 VPN 增强", keepAlive.vpn?.active === true ? "已开启并在连接" : keepAlive.vpn?.enabled === true ? "已勾选，当前未连接" : keepAlive.vpn?.enabled === false ? "未开启" : "未读取"],
      ["最近自动恢复", Number.isFinite(keepAlive.lastRecoveryAtMs) && keepAlive.lastRecoveryAtMs > 0 ? `${dateText(keepAlive.lastRecoveryAtMs)} · ${keepAlive.lastRecoveryReason || "原因未记录"}` : Number.isFinite(keepAlive.lastRecoveryAtMs) ? "还没有自动恢复记录" : "未读取"],
      ["下次自检", keepAlive.selfCheckScheduled === true && Number.isFinite(keepAlive.nextSelfCheckAtMs) && keepAlive.nextSelfCheckAtMs > 0 ? dateText(keepAlive.nextSelfCheckAtMs) : keepAlive.selfCheckScheduled === false ? "未排定" : "未读取"],
      ["界面心跳", displayBoolean(keepAlive.uiHeartbeat?.active, "界面在前台", "界面不在前台")],
      ["通知频道", keepAlive.notificationChannel?.known === true ? (keepAlive.notificationChannel.blocked === true ? "已关闭" : "已允许") : "未读取"],
      ["屏幕常亮", displayBoolean(keepAlive.screenKeepOn, "已开启", "未开启")],
      ["五分钟自检", probeText(keepAlive.probe)],
      ["下次重连唤醒", keepAlive.engine?.reconnectWakeAtMs > 0 ? dateText(keepAlive.engine.reconnectWakeAtMs) : "当前没有排定的重连"]];
    const engine = state.status?.buildId ? String(state.status.buildId) : "引擎版本没读到";
    const client = CLIENT_BUILD_ID.includes("PLACEHOLDER") ? "本包标识未注入" : CLIENT_BUILD_ID;
    showDialog("运行服务", `<p class="dialog-intro">运行状态以手机实际读取结果为准；这里不替你判断保活是否成功。</p><dl class="detail-list">${rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl><div class="dialog-actions"><button class="button secondary" type="button" data-action="background-settings">打开手机后台设置</button><button class="button secondary" type="button" data-action="open-manufacturer-settings">厂家自启动设置</button><button class="button secondary" type="button" data-action="open-exact-alarm-settings">精确闹钟授权</button><button class="button secondary" type="button" data-action="toggle-keepalive-vpn">${keepAlive.vpn?.enabled === true ? "关闭 VPN 增强" : "开启 VPN 增强"}</button><button class="button secondary" type="button" data-action="toggle-screen-keep-on">${keepAlive.screenKeepOn === true ? "关闭屏幕常亮" : "开启屏幕常亮"}</button><button class="button secondary" type="button" data-action="start-keepalive-probe">运行五分钟自检</button><button class="button secondary" type="button" data-action="cancel-keepalive-probe">取消自检</button><button class="button secondary" type="button" data-action="service-help">连接帮助</button></div><p class="prow-note">界面版本 ${esc(client)}｜引擎 ${esc(engine)}</p>`,
      dialogActions('<button class="button secondary" type="button" data-action="close-dialog">关掉</button>'));
  }
  function showBackgroundSheet() {
    if (openProductionReadSheet("battery")) return;
    const device = {...state.status.device,...state.device};
    const runtime = state.status.runtime || {};
    const notifications = device.notificationsEnabled ?? device.notificationPermission;
    const battery = device.batteryOptimizationExempt ?? device.ignoringBatteryOptimizations ?? device.batteryUnrestricted;
    showDialog("前往手机系统设置", `<p class="dialog-intro">点击后打开手机系统的后台运行设置。按该系统的名称检查通知、后台活动和电池限制。</p>
      <section class="infocard"><div class="infocard-top">${icon("settings")}<strong>在正式 Android App 中</strong></div><p>点击后打开手机系统的后台运行设置。按该系统的名称检查通知、后台活动和电池限制。</p></section>
      <section class="infocard"><div class="infocard-top">${icon("check")}<strong>返回 App 后</strong></div><p>重新读取设备状态，显示实际是否已允许；不因为打开了设置页就标记成功。当前通知权限：${esc(displayBoolean(notifications,"已允许","未允许"))}；电池优化：${esc(displayBoolean(battery,"已允许持续运行","仍受系统优化限制"))}。</p></section>
      <section class="infocard"><div class="infocard-top">${icon("clock")}<strong>强行停止会怎样</strong></div><p>系统中的「强行停止」会停下 App，之后要你重新打开。运行状态以手机实际读取结果为准。</p></section>
      <button class="button secondary wide" type="button" data-action="background-settings">打开手机后台设置</button>`,
      dialogActions('<button class="button secondary" type="button" data-action="close-dialog">关掉</button>'));
  }
  function showServiceDisconnectedSheet(forceOffline = false) {
    if (openProductionReadSheet("connection-help")) return;
    const online = forceOffline ? false : state.online === true;
    const title = online ? "手机服务连接" : "手机服务未连接";
    const intro = online ? "本机执行器当前已连接；下面是连接异常时的处理方式。" : "当前不能确认账号运行状态。";
    showDialog(title, `<p class="dialog-intro">${esc(intro)}</p>
      <section class="infocard"><div class="infocard-top">${icon("clock")}<strong>本机连接</strong></div><p>${online ? "当前已连接；如需重新核对，可点下方「重新连接」。" : "请先重新连接服务，再查看游戏号是否仍在运行。"}</p></section>
      <section class="infocard"><div class="infocard-top">${icon("check")}<strong>重新连接</strong></div><p>App 会尝试重新连接本机执行器；网络、超时或连接校验失效时，仍以重新读取的实际结果为准。</p></section>
      <section class="infocard"><div class="infocard-top">${icon("lock")}<strong>连接校验失效</strong></div><p>若显示连接校验已失效，请重新打开 App。不会直接重新发送游戏操作。</p></section>`,
      dialogActions('<button class="button primary-button" type="button" data-action="refresh">重新连接</button>', '<button class="button secondary" type="button" data-action="close-dialog">先关掉</button>'));
  }
  function showOwnershipSheet() {
    if (openProductionReadSheet("data-ownership")) return;
    const info = softwareInfo();
    if (!info) { toast("软件账号状态还没读到，请刷新后再看。"); return; }
    const claim = info.claim || {};
    const queue = info.queue || {};
    const confirmed = claim.status === "confirmed";
    const rows = [["本机资料归属", confirmed ? "已确认归属到当前软件账号" : info.claimRequired ? "还有资料待确认归属" : "没有待确认的资料"], ["确认时间", claim.at ? dateText(claim.at) : "未读到"], ["未归属日志", Number.isFinite(Number(queue.unowned)) ? `${queue.unowned} 条` : "未读到"], ["日志缺口", Number.isFinite(Number(queue.gapEvents)) ? `${queue.gapEvents} 条` : "未读到"]];
    showDialog("资料归属", `<p class="dialog-intro">归属只决定本机资料记到哪个软件账号，不会改动官服角色。</p><dl class="detail-list">${rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>${info.claimRequired ? '<button class="button wide" type="button" data-action="claim-data">确认归属到当前软件账号</button>' : '<p class="prow-note">当前没有需要确认的归属；历史记录仍保留。</p>'}`,
      dialogActions('<button class="button secondary" type="button" data-action="close-dialog">关掉</button>'));
  }
  function showEgressClearConfirm() {
    showDialog("改用本机网络", `<section class="infocard"><div class="infocard-top">${icon("settings")}<strong>影响所有游戏号</strong></div><p>清除统一代理配置后，本机所有游戏号使用手机当前网络。</p></section>`,
      dialogActions('<button class="button secondary" type="button" data-action="close-dialog">取消</button>', '<button class="button primary-button" type="button" data-action="clear-egress-confirmed">改用本机网络</button>'));
  }
  function showEgressSheet() {
    const route = state.egress;
    const routeText = route?.routing === "proxy" ? typeof route.display === "string" && route.display ? `所有账号使用：${route.display}` : "已配置代理出口，脱敏地址尚未读取" : route?.routing === "direct" ? "所有账号使用本机网络" : route ? "尚未设置统一出口" : "出口设置尚未读取";
    const disabled = !state.online || !route || Boolean(state.busy);
    const policy = state.status?.software?.uploadPolicy;
    const policyLabel = policy?.enabled === true ? "当前仅在 Wi-Fi 上传运行日志" : policy?.enabled === false ? "当前允许任意线路上传运行日志" : "当前策略尚未读取";
    showDialog("网络出口", `<div data-formal-network-status>${esc(routeText)}</div>
      <form id="egress-form" class="egress-form" data-formal-fields="network"><label class="field"><span>出口 IP / 代理地址</span><input id="egress-input" type="password" data-formal-required="true" autocomplete="off" spellcheck="false" enterkeyhint="done" aria-label="统一出口IP或代理地址" placeholder="IP:端口 或 http://代理地址" value="${esc(state.egressDraft)}" ${disabled ? "disabled" : ""}><p class="field-description">保存后只显示脱敏出口；原有口令不会回显，换地址时请重新填写完整代理地址。</p></label></form>
      ${state.egressError ? `<p class="field-error" role="alert">${esc(state.egressError)}</p>` : ""}
      <div class="panel-note"><strong>适用范围</strong>应用到本机所有游戏号。地址留空不能提交；使用「改用本机网络」清除已配置出口。</div>
      <button class="button secondary" type="button" data-action="clear-egress" ${disabled || route?.configured !== true ? "disabled" : ""}>改用本机网络<small>清除统一代理配置</small></button>
      <button class="button secondary" type="button" id="network-upload-policy">日志上传网络<small>${esc(policyLabel)}；查看并调整上传策略</small></button>`,
      dialogActions('<button class="button secondary" type="button" data-action="close-dialog">取消</button>',
        `<button class="button primary-button" type="submit" form="egress-form" ${disabled ? "disabled" : ""}>${state.busy === "egress" ? "应用中" : "应用到所有账号"}</button>`));
    $("#network-upload-policy")?.addEventListener("click", () => {
      const current = state.status?.software?.uploadPolicy || null;
      const transport = ({ wifi: "Wi-Fi", cellular: "移动数据", ethernet: "有线网络", none: "没有可用网络" })[state.status?.network?.transport] || "线路暂时没读到";
      const pending = typeof current?.pending === "number" && Number.isFinite(current.pending) && current.pending >= 0 ? ` ${current.pending} 条` : "未读取";
      const held = current?.holdSince ? `正在等待 Wi-Fi；待传数量${pending}` : current ? "当前没有等待 Wi-Fi 的上传安排" : "上传策略尚未读取";
      showDialog("日志上传网络", `<div class="panel-toggle"><div class="field-copy"><h3>运行日志只在 Wi-Fi 下上传</h3><p>开启后，其他线路下的运行日志先保存在手机，回到 Wi-Fi 后按原同步安排上传；关闭后允许任何线路上传。此设置不影响种花、浇水和收花。</p></div><button class="toggle" type="button" role="switch" aria-checked="${current?.enabled === true}" aria-label="运行日志只在 Wi-Fi 下上传" data-action="toggle-upload-policy" ${!state.online || !current || state.busy ? "disabled" : ""}><span class="toggle-track"></span></button></div><div class="panel-note" data-upload-policy-facts><strong>当前读数</strong>${esc(`当前线路：${transport}；${held}。`)}</div>`,
        dialogActions('<button class="button secondary" type="button" data-action="close-dialog">返回出口设置</button>'));
    });
  }
  function showUsageSheet() {
    showDialog("使用说明", `<p class="dialog-intro">软件身份、游戏号与本机运行各有入口。</p>
      <div class="picker-list">
        <button class="acct-card" type="button" data-action="help-auth"><span><strong>登录与注册</strong><p>软件账号的登录、注册与找回说明</p></span><span class="chevron">›</span></button>
        <button class="acct-card" type="button" data-action="help-protection"><span><strong>游戏号与执行保护</strong><p>同号单会话、未确认记录与移除</p></span><span class="chevron">›</span></button>
        <button class="acct-card" type="button" data-action="help-license"><span><strong>授权与离线宽限</strong><p>授权状态与核对入口</p></span><span class="chevron">›</span></button>
        <button class="acct-card" type="button" data-action="help-sync"><span><strong>日志同步与资料归属</strong><p>待传、缺口、上次同步与归属</p></span><span class="chevron">›</span></button>
        <button class="acct-card" type="button" data-action="help-battery"><span><strong>后台运行与系统设置</strong><p>通知、电池与后台设置说明</p></span><span class="chevron">›</span></button>
      </div>`,
      dialogActions('<button class="button secondary" type="button" data-action="close-dialog">关掉</button>'));
  }
  function showStartUnsaved() {
    showDialog("先保存，再开始", `<section class="infocard"><div class="infocard-top">${icon("clock")}<strong>当前有未保存的设置</strong></div><p>开始运行会使用已保存配置。请先保存这次修改，再点击开始。</p></section>`,
      dialogActions('<button class="button primary-button" type="button" data-action="close-dialog">回到设置</button>', '<button class="button secondary" type="button" data-action="close-dialog">暂不开始</button>'));
  }
  function showAccountRuntimeSheet(id) {
    const account = state.accounts.find(one => sameId(one.id, id)) || selected();
    const current = account ? `这个号现在：${stateLabel(account)}${account.serverName ? `｜${account.serverName}` : ""}。` : "还没读到这个号。";
    const rows = [["运行中", "已连接游戏，按已保存且开启的功能安排执行。"], ["正在启动 / 连接", "保留运行安排，不显示第二个开始按钮。"], ["等待运行 / 正在恢复", "条件满足后核对当前状态再继续，可随时停止。"], ["等待网络 / 允许登录", "暂未连接游戏，等待不等同运行中。"], ["正在停止 / 需要重新停止", "继续核对实际停止结果，不清除未确认记录。"], ["运行中断 / 已暂停", "按本次具体原因处理，不用历史未确认永久拦号。"], ["未运行 / 已停止", "可按保存设置开始；先保存当前修改。"], ["状态未读到", "刷新读取当前状态；缺失只限制依赖它的候选。"]];
    showDialog("账号运行状态", `<p class="dialog-intro">${esc(current)}</p><dl class="detail-list">${rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>`,
      dialogActions('<button class="button secondary" type="button" data-action="close-dialog">关掉</button>'));
  }
  function accountStatusCard(iconName, label, title, text) {
    return `<section class="infocard"><div class="infocard-top">${icon(iconName)}<strong>${esc(label)}</strong></div><p><strong>${esc(title)}</strong><br>${esc(text)}</p></section>`;
  }
  function accountSheetTarget(account, id) {
    return `${account ? accountName(account) : "游戏号"}（游戏号 #${String(id)}）`;
  }
  function showTransientSheet({ title, label, status, text }) {
    showDialog(title, accountStatusCard("clock", label, status, text),
      dialogActions('<button class="button secondary" type="button" data-action="close-dialog">返回</button>'), "transient-sheet");
  }
  function closeTransientSheet() {
    const top = topDialog();
    if (top && top.classList.contains("transient-sheet")) closeDialog();
  }
  let startingSheetAccountId = "";
  function startingSheetHeadline(account, settled = false) {
    const status = accountState(account);
    if (status === "running") return "已开始运行";
    if (["failed", "error", "blocked"].includes(status)) return "启动未完成";
    /* 刚提交的那一拍还可能是上一份 stopped 读数；等到第二拍仍是 stopped 且没有运行意图，才判启动未完成。 */
    if (settled && ["stopped", "idle"].includes(status) && !isPending(account)) return "启动未完成";
    return "正在启动";
  }
  function startingSheetBody(account, id) {
    const label = account ? stateLabel(account) : "状态未读到";
    const text = account ? accountNote(account) : "还没读到这个游戏号，返回账号页刷新后再看。";
    return `<p class="dialog-intro" data-account-subtitle>${esc(accountSheetTarget(account, id))} · 启动请求已提交，按实际读回更新状态。</p>${accountStatusCard("clock", "当前状态", label, text)}<section class="infocard"><div class="infocard-top">${icon("clock")}<strong>任务还没开始？</strong></div><p>连接、排队与恢复仍属于保留运行安排，账号卡片会显示停止任务，不重复提供另一个开始按钮。</p></section><button class="button secondary wide" type="button" data-action="account-logs" data-id="${esc(id)}">查看运行记录</button>`;
  }
  function showAccountStartingSheet(id) {
    startingSheetAccountId = String(id);
    const account = state.accounts.find(one => sameId(one.id, id));
    showDialog(startingSheetHeadline(account), startingSheetBody(account, id),
      dialogActions('<button class="button primary-button" type="button" data-action="close-dialog">返回查看状态</button>'), "account-starting-sheet");
  }
  /* 启动弹层可能比轮询活得更久（连接官服会慢于十几秒）。每次刷新都把它接回真实状态：
     到 running 自动收起并重画卡片；仍在等待就更新弹层里的当前状态。 */
  function syncStartingSheetFromState() {
    if (!startingSheetAccountId || !$(".dialog.account-starting-sheet")) return;
    const account = state.accounts.find(one => sameId(one.id, startingSheetAccountId));
    if (account && accountState(account) === "running") {
      if (closeStartingSheetIfTop()) { render(); toast("已连接游戏，正在运行。"); }
      else updateStartingSheet(startingSheetAccountId, true);
      return;
    }
    updateStartingSheet(startingSheetAccountId, true);
  }
  /* 启动后在同一个弹层里更新真实状态：连接慢时用户看得到当前到哪一步，
     到了 running 才自动收掉弹层，避免旧版一直停在「正在连接」的静态画面。 */
  function updateStartingSheet(id, settled = false) {
    const dialog = $(".dialog.account-starting-sheet");
    if (!dialog) return false;
    const account = state.accounts.find(one => sameId(one.id, id));
    const title = dialog.querySelector("h2"); if (title) title.textContent = startingSheetHeadline(account, settled);
    const body = dialog.querySelector(".dialog-body");
    if (body) body.innerHTML = window.MoonUI?.formalBodyHTML
      ? window.MoonUI.formalBodyHTML({ title: startingSheetHeadline(account, settled), body: startingSheetBody(account, id), kind: "account-starting-sheet" })
      : startingSheetBody(account, id);
    return true;
  }
  function closeStartingSheetIfTop() {
    if (topDialog()?.classList.contains("account-starting-sheet")) { closeDialog(); return true; }
    return false;
  }
  function showAccountStoppingSheet(id) {
    const account = state.accounts.find(one => sameId(one.id, id));
    showDialog("正在停止", `<p class="dialog-intro" data-account-subtitle>${esc(accountSheetTarget(account, id))} · 停止请求已提交，等待实际停止状态。</p>${accountStatusCard("clock", "当前状态", "正在停止任务…", "等待手机服务读回实际停止状态。")}<section class="infocard"><div class="infocard-top">${icon("logs")}<strong>保留记录</strong></div><p>已发生的游戏结果不回滚，未确认记录不清除。</p></section>`,
      dialogActions('<button class="button primary-button" type="button" data-action="close-dialog">返回查看状态</button>'), "account-stopping-sheet");
  }
  function showAccountStoppedSheet(id) {
    const account = state.accounts.find(one => sameId(one.id, id));
    showDialog("任务已停止", `<p class="dialog-intro" data-account-subtitle>${esc(accountSheetTarget(account, id))} · 已读回实际停止状态。</p>${accountStatusCard("check", "当前状态", "已停止", "当前游戏号不再保留本次运行安排。")}<section class="infocard"><div class="infocard-top">${icon("clock")}<strong>重新开始</strong></div><p>需要继续时，核对保存设置后手动开始。</p></section>`,
      dialogActions('<button class="button primary-button" type="button" data-action="close-dialog">知道了</button>'));
  }
  function showAccountStartSheet(id) {
    const account = state.accounts.find(one => sameId(one.id,id));
    showDialog("开始照料花园", `<p class="dialog-intro" data-account-subtitle>${esc(accountSheetTarget(account, id))} · 开始请求与运行状态分开展示。</p>${accountStatusCard("play", "即将使用", "当前账号已保存的设置", "保存本身不会开始；点击后仍须读取实际连接与执行状态。")}<section class="infocard"><div class="infocard-top">${icon("clock")}<strong>开始之后</strong></div><p>先连接游戏，再根据当前状态安排任务。启动、连接和等待恢复都会显示在账号卡片上。</p></section><button class="rules-row" type="button" data-action="account-protection" data-id="${esc(id)}">本机执行与身份保护</button>`,
      dialogActions('<button class="button secondary" type="button" data-action="close-dialog">取消</button>', `<button class="button primary-button" type="button" data-action="confirm-start" data-id="${esc(id)}">开始运行</button>`));
  }
  function showAccountStopSheet(id) {
    const account = state.accounts.find(one => sameId(one.id,id));
    showDialog("停止当前任务", `<p class="dialog-intro" data-account-subtitle>${esc(accountSheetTarget(account, id))} · 随时撤销当前运行意图。</p>${accountStatusCard("stop", "停止范围", "当前游戏号", "停止本机任务并撤销该号的运行安排。")}<section class="infocard"><div class="infocard-top">${icon("clock")}<strong>当前在途</strong></div><p>以真实返回与实际停止状态为准；未确认的操作记录继续保留。</p></section><section class="infocard"><div class="infocard-top">${icon("check")}<strong>等待中的账号也能停止</strong></div><p>正在启动、连接、排队、恢复、等待网络与允许登录时，都提供停止任务。</p></section>`,
      dialogActions('<button class="button secondary" type="button" data-action="close-dialog">取消</button>', `<button class="button primary-button" type="button" data-action="confirm-stop" data-id="${esc(id)}">停止任务</button>`));
  }
  function showAccountUnknownSheet(id, action, reason = "") {
    const account = state.accounts.find(one => sameId(one.id, id));
    const what = action === "start" ? "启动" : "停止";
    const text = reason ? `${reason} 请求可能已经到达手机服务，不重复提交来猜测结果。`
      : `${what}请求可能已经到达手机服务，页面没有拿到确定结果；不重复提交来猜测结果。`;
    showDialog("结果暂时无法确认", `<p class="dialog-intro" data-account-subtitle>${esc(accountSheetTarget(account, id))} · ${what}请求结果待核对。</p>${accountStatusCard("clock", "处理结果", "先刷新查看实际状态", text)}<div class="dialog-actions"><button class="button secondary" type="button" data-action="service-help">查看手机服务</button><button class="button secondary" type="button" data-action="account-logs" data-id="${esc(id)}">查看当前账号记录</button></div>`,
      dialogActions('<button class="button secondary" type="button" data-action="close-dialog">返回查看状态</button>', '<button class="button primary-button" type="button" data-action="refresh">刷新状态</button>'));
  }
  function showAccountProtectionSheet(id) {
    const notes = [["一个游戏号，一个执行会话", "接管前核对旧执行方已停止；当前真正的在途操作仍须串行。"], ["未确认记录会保留", "保留原操作与证据，不重发、不清账、不把未知改成成功。"], ["历史审计与当前执行分开", "正常连接后重新读取当前官服状态，合法业务按本次可信状态规划。"], ["只限制当前依赖", "缺少资格或必要状态时，仅限制依赖它的候选，不永久连坐整号。"], ["移除不是清账", "移除本机游戏号后，历史操作记录仍单独保留；删除重加不能绕过当前在途保护。"]];
    showDialog("本机资料与执行保护", `<p class="dialog-intro">这些规则对本机所有游戏号生效。</p>${notes.map(([title, text]) => `<section class="infocard"><div class="infocard-top">${icon("check")}<strong>${esc(title)}</strong></div><p>${esc(text)}</p></section>`).join("")}<button class="button secondary wide" type="button" data-action="account-logs" data-id="${esc(id)}">查看当前账号日志</button>`,
      dialogActions('<button class="button secondary" type="button" data-action="close-dialog">关掉</button>'));
  }
  function showOrdersStateSheet() {
    const rows = [["等待条件", "当前条件尚未满足，例如材料不足、等待成品或达到当日上限。"], ["状态待获取", "这次没读到必要状态；只限制依赖该状态的候选，不把未读到显示成 0。"], ["结果待核对", "原操作保留且不重发；重新连接读取当前可信状态，再规划当前合法业务。"], ["下次检查", "各类订单有独立安排，缺时间时显示「待获取」。"]];
    showDialog("订单状态说明", `<p class="dialog-intro">读数、执行与确认分别展示，方便理解等待原因。</p><dl class="detail-list">${rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl><section class="infocard"><div class="infocard-top">${icon("clock")}<strong>当前在途串行</strong></div><p>同一游戏号真正正在进行的写操作保持串行，历史审计记录与当前执行资格分开。</p></section>`,
      dialogActions('<button class="button secondary" type="button" data-action="close-dialog">关掉</button>'));
  }
  function showArtStatusSheet() {
    const facts = state.observations?.art;
    const wants = Array.isArray(facts?.pendingWants) ? facts.pendingWants : [];
    const stateText = wants.length ? `顾客还在等 ${wants.length} 件成品。` : facts?.wantsState === "none" ? "这一拍查过顾客单：没有缺成品的单。" : "这一拍没读到顾客缺什么；不把未读到说成没有。";
    const rows = [["有需求", "按顾客订单缺的成品与数量优先制作。"], ["没有需求", "这一拍确实查过顾客单，没有缺成品的单。"], ["暂未读到", "订单段还没走到或没报回名单；只限制依赖它的候选。"]];
    showDialog("花艺现场状态", `<p class="dialog-intro">${esc(stateText)}</p><dl class="detail-list">${rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl><p class="prow-note">制作仍按自动制作花艺的开关、指定名单与目标库存执行。</p>`,
      dialogActions('<button class="button secondary" type="button" data-action="close-dialog">关掉</button>'));
  }
  const LICENSE_COPY = {
    signed_out: "还需要登录本项目的软件账号。",
    granted: "软件授权有效，可以开始种花、浇水和收花。",
    needs_renew: "软件授权有效，稍后会再向服务器核一次。",
    grace_expired: "离线宽限已到期，需要重新联网登录才能继续运行。",
    disabled: "这个软件账号已被停用，本机不再接受新的游戏写入。",
    unverified: "离线宽限期限无法核实，已暂停新的游戏写入，请先联网核对。",
  };
  const LICENSE_SHORT = Object.freeze({
    signed_out: "未登录", granted: "有效", needs_renew: "有效待核",
    grace_expired: "宽限已到期", disabled: "已停用", unverified: "期限待核实",
  });
  function softwareInfo() { return state.software && typeof state.software === "object" ? state.software : null; }
  function signedIn() { const info = softwareInfo(); return info ? info.signedIn === true : null; }
  function licenseLine() {
    const info = softwareInfo();
    if (!info) return "软件账号状态未读到。";
    const copy = LICENSE_COPY[info.licenseState] || "软件授权状态未读到。";
    const counted = ["granted", "needs_renew", "grace_expired"].includes(info.licenseState);
    const remaining = info.graceRemainingMs;
    const left = counted && Number.isFinite(Number(remaining)) ? ` 本机离线还约可继续 ${Math.max(0, Math.round(Number(remaining) / 60000))} 分钟。` : "";
    return copy + left;
  }
  /* 认证壳只建一次：标题、按钮文字、错误与禁用态就地更新，
     输入节点、焦点、光标和输入法组合状态因此不会被整页重建打断。 */
  /* 登录页图标用原型 icons.js 的原路径；正式层的通用图标集里 UserRound/LockKeyhole/Eye/Leaf 形状不同，
     会把字段图标缩小、染色不同，并让「登录」按钮少一个箭头。 */
  const AUTH_ICON = {
    user: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/></svg>',
    lock: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="16" r="1"/><rect x="3" y="10" width="18" height="12" rx="2"/><path d="M7 10V7a5 5 0 0 1 10 0v3"/></svg>',
    eye: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>',
    arrow: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>',
    leaf: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/></svg>',
    close: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  };
  const AUTH_TEXT = {
    /* switch 只放动作本身：模板里已经写了「还没有账号？」这个前缀，
       旧值把整句塞进来，屏幕上就成了「还没有账号？ 还没有账号？ 立即注册」。 */
    login: {title:"花开无尽夏", sub:"雨落有晴天", submit:"登录，回到花园", switch:"立即注册"},
  };
  function authShell() {
    /* 登录/注册按 03 原型的同构结构迁入（login-brand / login-art / login-content / login-field / login-bottom），
       但每个可交互节点仍沿用正式层原有 id 与 data-action：首帧只建一次、就地更新文字与禁用态那条修复不能因为换壳丢掉的
       输入、光标与输入法组合状态继续保住。 */
    return `<section class="auth-sheet"><div class="phone login-phone auth-login"><header class="login-brand"><span class="brand-symbol"><img src="brand/logo-endless-summer.webp" alt="无尽夏原图标"></span><div><h1>无尽夏</h1><p>ENDLESS SUMMER</p></div></header><div class="login-art"><img src="brand/logo-endless-summer.webp" alt="无尽夏：蓝紫绣球原图标"></div><div class="login-content"><h2 id="auth-title"></h2><p class="intro" id="auth-sub"></p><form class="auth-form" id="software-auth-form" autocomplete="off" novalidate><div class="login-field">${AUTH_ICON.user}<label><span>软件账号</span><input id="software-username" name="username" type="text" autocomplete="username" inputmode="text" maxlength="32" placeholder="输入软件账号" aria-label="软件账号"></label></div><div class="login-field">${AUTH_ICON.lock}<label><span>登录密码</span><input id="software-password" name="password" type="password" maxlength="64" autocomplete="current-password" placeholder="请输入密码" aria-label="登录密码"></label><button class="icon-button auth-reveal" type="button" data-action="reveal-password" aria-label="显示密码" aria-pressed="false">${AUTH_ICON.eye}</button></div><p class="auth-error" id="auth-error" role="alert" hidden></p><p class="auth-note" id="auth-note" hidden></p><button class="primary auth-submit" id="auth-submit" type="submit"></button><p class="login-extra">还没有账号？<button type="button" id="auth-switch" data-action="switch-auth-mode"></button></p><button class="auth-help-link" type="button" data-action="auth-help">登录遇到问题？</button><p class="auth-cloud-missing" id="auth-cloud" hidden>这台手机还没有配置本项目的云服务地址，暂时无法登录。</p></form></div><div class="login-bottom">${AUTH_ICON.leaf}本机执行 · 随时可停</div></div></section>`;
  }
  function loadingSheet() {
    const copy = state.loading ? "正在读取本机运行服务…" : state.online ? "正在读取软件账号状态…" : "手机运行服务未连接，请重新连接后再试。";
    return `<section class="loading-sheet"><img src="brand/logo-endless-summer.webp" alt="无尽夏"><p>${esc(copy)}</p><button class="button secondary" type="button" data-action="refresh">重新连接</button></section>`;
  }
  /* 离开月色场景时的整体清理。旧实现只删 data-moon，而月色挂载时会同时写
     moon-chrome / moon-dock 的内容、navigation 的 innerHTML、main 的滚动类、html.moon-shell；
     热退出回登录（不重建 WebView）就会带着上一屏的标题条、保存区和滚动位置，
     表现为"登录页上面还有一条业务页的页头"。登录、加载、退出都走这一套。 */
  function leaveMoonScene() {
    const body = document.body;
    delete body.dataset.moon;
    delete body.dataset.view;
    document.documentElement.classList.remove("moon-shell");
    for (const id of ["moon-chrome", "moon-dock"]) {
      const node = document.getElementById(id);
      if (node) { node.innerHTML = ""; node.removeAttribute("class"); node.removeAttribute("style"); }
    }
    const navigation = $("#navigation");
    if (navigation) { navigation.innerHTML = ""; navigation.className = "tabbar"; navigation.setAttribute("aria-label", "主导航"); }
    const host = $("#dialog-host");
    if (host) host.innerHTML = "";
    main.className = "main";
    main.scrollTop = 0;
  }
  function setLayout(mode) {
    const body = document.body;
    /* 同时看 dataset 与 class：月色 mount() 会自己写 body.dataset.layout，
       若只看 dataset 就会认为"已经是 panel"而跳过，body 上残留的 layout-auth 类便一直留着，
       而 layout-auth 的 .main 是 padding:0 + overflow:hidden + 透明背景 ——
       业务页会既滚不动又露底，这跟原生有没有缩进是两回事。 */
    if (body.dataset.layout === mode && body.classList.contains(`layout-${mode}`)) return;
    body.dataset.layout = mode;
    body.classList.remove("layout-loading","layout-auth","layout-panel");
    body.classList.add(`layout-${mode}`);
    try { window.AndroidBridge?.setPageMode?.(mode); } catch { /* browser reference has no native canvas */ }
    if (mode !== "panel") leaveMoonScene();
    main.classList.remove("settings-page");
    main.scrollTop = 0;
    $("#navigation").hidden = mode !== "panel";
  }
  function ensureAuthShell() {
    if ($("#software-auth-form")) return;
    main.innerHTML = authShell();
    $("#software-username").value = state.authDraft.username;
    $("#software-password").value = state.authDraft.password;
  }
  function syncAuth() {
    ensureAuthShell();
    const text = AUTH_TEXT.login;
    const serviceWaiting = !engineReady();
    const rateWaiting = state.authRetryAt > Date.now();
    const busy = state.authBusy || serviceWaiting || rateWaiting;
    $("#auth-title").textContent = text.title;
    $("#auth-sub").textContent = text.sub;
    const submit = $("#auth-submit");
    submit.innerHTML = pendingAuthHandoff ? "请先关闭上方提示" : state.authBusy ? "正在登录…" : serviceWaiting ? (state.engine.phase === "failed" ? "手机服务未连接" : "正在连接手机服务…") : rateWaiting ? `请在 ${Math.max(1, Math.ceil((state.authRetryAt - Date.now()) / 1000))} 秒后重试` : text.submit + AUTH_ICON.arrow;
    submit.disabled = busy;
    $("#auth-switch").textContent = text.switch;
    const username = $("#software-username"), password = $("#software-password");
    if (document.activeElement !== username && username.value !== state.authDraft.username) username.value = state.authDraft.username;
    if (document.activeElement !== password && password.value !== state.authDraft.password) password.value = state.authDraft.password;
    // A rebind replaces the WebView; do not invite typing into the outgoing form.
    username.disabled = state.authBusy || serviceWaiting; password.disabled = state.authBusy || serviceWaiting;
    const reveal = $("[data-action=reveal-password]");
    if (reveal) { reveal.innerHTML = state.authRevealed ? icon("eyeOff") : AUTH_ICON.eye; reveal.setAttribute("aria-label", state.authRevealed ? "隐藏密码" : "显示密码"); reveal.setAttribute("aria-pressed", String(state.authRevealed)); reveal.disabled = busy; }
    password.autocomplete = "current-password";
    password.placeholder = "请输入密码";
    $("#auth-switch").disabled = busy;
    if (password.type !== (state.authRevealed ? "text" : "password")) password.type = state.authRevealed ? "text" : "password";
    const error = $("#auth-error");
    error.textContent = state.authError || "";
    error.hidden = !state.authError;
    const note = $("#auth-note");
    if (note) {
      note.textContent = pendingAuthHandoff?.message || (serviceWaiting ? state.engine.message || "正在重新连接手机运行服务，就绪后即可登录。" : text.note || "");
      note.hidden = !note.textContent;
      note.setAttribute("role", "status"); note.setAttribute("aria-live", "polite");
    }
    let reconnect = $("#auth-reconnect");
    if (!reconnect) {
      reconnect = document.createElement("button"); reconnect.id = "auth-reconnect"; reconnect.type = "button";
      reconnect.className = "auth-help-link"; reconnect.dataset.action = "auth-reconnect";
      error.insertAdjacentElement("afterend", reconnect);
    }
    reconnect.hidden = !(state.engine.phase === "failed" || state.authErrorMeta?.scope === "local-engine");
    reconnect.textContent = "重新连接手机服务"; reconnect.disabled = state.authBusy;
    let diagnostics = $("#auth-diagnostics");
    if (!diagnostics) {
      diagnostics = document.createElement("details"); diagnostics.id = "auth-diagnostics"; diagnostics.className = "auth-diagnostics";
      reconnect.insertAdjacentElement("afterend", diagnostics);
    }
    const meta = state.authErrorMeta;
    diagnostics.hidden = !meta;
    if (meta) diagnostics.innerHTML = `<summary>查看连接原因</summary><p>${esc(meta.scope === "software-cloud" ? "软件云服务" : meta.scope === "software-local" ? "本机软件身份" : "手机运行服务")} · ${esc(meta.code)}${meta.status ? ` · HTTP ${esc(meta.status)}` : ""}${meta.requestId ? `<br>关联号：${esc(meta.requestId)}` : ""}</p>`;
    const cloud = $("#auth-cloud");
    const info = softwareInfo();
    cloud.hidden = !(info && info.cloudConfigured === false);
  }
  function revealPassword() {
    const input = $("#software-password"); if (!input) return;
    const focused = document.activeElement === input;
    let start = null, end = null, direction = "none";
    if (focused) { try { start = input.selectionStart; end = input.selectionEnd; direction = input.selectionDirection; } catch { /* the engine may hide caret data for passwords */ } }
    state.authRevealed = !state.authRevealed;
    input.type = state.authRevealed ? "text" : "password";
    const reveal = $("[data-action=reveal-password]");
    if (reveal) { reveal.innerHTML = state.authRevealed ? icon("eyeOff") : AUTH_ICON.eye; reveal.setAttribute("aria-label", state.authRevealed ? "隐藏密码" : "显示密码"); reveal.setAttribute("aria-pressed", String(state.authRevealed)); }
    if (focused) {
      const type = input.type;
      const restore = () => {
        if (!input.isConnected || document.activeElement !== input || input.type !== type) return;
        try { if (start !== null) input.setSelectionRange(start, end, direction); } catch { /* retain the value if this WebView restricts selection */ }
      };
      input.focus({preventScroll:true}); restore();
      // Android may reset the selection while rebuilding its input connection for
      // the new type. Restore after that update as well as in the click handler.
      requestAnimationFrame(restore);
    }
  }
  function render() {
    if (pendingAuthHandoff) { setLayout("auth"); syncAuth(); return; }
    /* 弹层被正式动作（例如应用日志筛选）直接关掉时，overlay 已不在 DOM；草稿栈必须一起清，
       否则之后页面上的开关会写进一个已经消失的 sheet 拷贝。 */
    if (sheet && !currentSheet()?.overlay?.isConnected) resetSheetState();
    /* 月色展示层接管业务面板那一屏：状态、草稿、API、轮询与各项保护仍在这里，只是画面改由
       ui/moon 按原型同构结构产出。模块没加载成功时继续走旧模板，界面不会空白。 */
    if (window.MoonRender?.handles(state)) {
      /* 接管前先把正式层的 layout 切到 panel：mount() 只写 dataset.layout 不换 class，
         不切的话业务页会继续套着 layout-auth 的 .main（padding:0/overflow:hidden/透明）。 */
      setLayout("panel");
      document.body.dataset.view = state.tab;
      const mounted=window.MoonRender.mount();updateDraftTransactionUI();return mounted;
    }
    delete document.body.dataset.moon;
    const authed = signedIn();
    if (authed === false) { setLayout("auth"); syncAuth(); return; }
    /* 软件身份还没读到（含本机服务未连上）：稳定品牌加真实加载状态，不闪业务面板。 */
    if (authed === null && !(state.online && state.software)) { setLayout("loading"); if (!($(".loading-sheet"))) main.innerHTML = loadingSheet(); return; }
    if (main.querySelector(".loading-sheet")) main.replaceChildren();
    setLayout("panel");
    document.body.dataset.view = state.tab;
    renderNavigation();
    renderConnection();
    main.classList.toggle("settings-page", state.tab === "settings");
    const pages = {accounts:renderAccounts,settings:renderSettings,logs:renderLogs,me:renderMe};
    // 自动刷新（约每 10 秒）会整片重画：不保住滚动位置，客户正翻到下面那几张卡就被弹回顶部，
    // 底下那个号的「开始」根本点不到（本轮实测踩到：第三张卡的按钮反复点不中）。
    // 切页/翻页那些**故意**要回顶的地方仍在自己的流程里显式归零，不受这里影响。
    const keepScrollTop = main.scrollTop;
    main.innerHTML = pages[state.tab]();
    main.scrollTop = keepScrollTop;
    updateDraftTransactionUI();
  }
  /* 后台轮询到点要刷新读数，但不能在用户正动手的那一秒重画整页：
     真机实测——账号运行中点「选择」，弹层刚要开就被轮询换掉节点，那一下点击就丢了。
     弹层开着、焦点还在输入框/下拉里时，只刷顶部连接条，整页等下一次空闲轮询。 */
  function renderIfIdle() {
    if (hasDialog()) { renderConnection(); return; }
    const active = document.activeElement;
    const editing = active && main.contains(active) && ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName);
    if (editing) { renderConnection(); return; }
    render();
  }
  let statusRead = null;
  let catalogRead = null;
  let userRead = null;
  let egressRead = null;
  const optionalStatusReads = new Map();
  const readContext = () => ({ generation: state.engine.generation, instanceId: state.engine.instanceId, softwareUserId: softwareUserId() });
  const sameReadContext = request => request.generation === state.engine.generation && request.instanceId === state.engine.instanceId
    && request.softwareUserId === softwareUserId();
  function invalidateOptionalStatusReads() { optionalStatusReads.clear(); egressRead = null; }
  function refreshViewContext() {
    return { ...readContext(),accountId:String(state.selectedId),tab:state.tab,
      logsScope:state.logsScope,logsCategory:state.logsCategory,logsDay:state.logsDay,logsKeyword:state.logsKeyword,logsLevel:state.logsLevel,
      logsOutcome:state.logsOutcome,logsErrorCode:state.logsErrorCode,logsTraceId:state.logsTraceId,logsOperationId:state.logsOperationId,logsStack:JSON.stringify(state.logsStack) };
  }
  function sameRefreshView(context) {
    return sameReadContext(context) && context.accountId===String(state.selectedId) && context.tab===state.tab
      && context.logsScope===state.logsScope && context.logsCategory===state.logsCategory && context.logsDay===state.logsDay
      && context.logsKeyword===state.logsKeyword && context.logsLevel===state.logsLevel && context.logsOutcome===state.logsOutcome
      && context.logsTraceId===state.logsTraceId && context.logsOperationId===state.logsOperationId
      && context.logsErrorCode===state.logsErrorCode
      && context.logsStack===JSON.stringify(state.logsStack);
  }
  async function readEgressForStatus(context) {
    if (!sameReadContext(context)) return {status:"stale"};
    if (state.busy==="egress" || state.egressEditing) return {status:"skipped"};
    if (egressRead && sameReadContext(egressRead)) return egressRead.promise;
    const request={generation:context.generation,instanceId:context.instanceId,softwareUserId:context.softwareUserId,promise:null};
    egressRead=request;
    const current=()=>egressRead===request && sameReadContext(request) && state.busy!=="egress" && !state.egressEditing;
    request.promise=(async()=>{try {
      const result=await api("/egress",{expectedContext:request,optionalRead:true});
      if (!current()) return {status:"stale"};
      if (!result || typeof result!=="object" || Array.isArray(result)) throw new Error("出口设置暂时无法读取。");
      state.egress=result;state.egressError="";
      return {status:"read"};
    } catch(error) {
      if (!current()) return {status:"stale"};
      const message=safeError(error,"出口设置暂时无法读取。");state.egressError=message;
      return {status:"failed",message};
    } finally {
      if (egressRead===request) {egressRead=null;if(sameReadContext(request))renderIfIdle();}
    }})();
    return request.promise;
  }
  function readOptionalStatusDetails(context,options,rosterSelectionChanged) {
    if (!sameReadContext(context)) return Promise.resolve({status:"stale",warnings:[]});
    const view=refreshViewContext(),wantLogs=view.tab==="logs" && signedIn()===true && (options.includeDetails===true || rosterSelectionChanged);
    const key=JSON.stringify({...view,wantLogs});
    if (optionalStatusReads.has(key)) return optionalStatusReads.get(key).promise;
    const request={...view,wantLogs,promise:null};optionalStatusReads.set(key,request);
    request.promise=(async()=>{try {
      const egressPromise=readEgressForStatus(request);
      const pagePromise=(async()=>{
        const warnings=[];
        if (!sameRefreshView(request)||signedIn()!==true) return warnings;
        if (request.wantLogs) {
          await loadLogs();
          if (sameRefreshView(request)&&state.logsError) warnings.push(state.logsError);
        }
        if (request.tab==="settings") {
          if (!state.draft && request.accountId!=="") {
            const config=await loadConfig();
            if (!sameRefreshView(request)) return warnings;
            if (config?.status==="failed"&&state.configError) warnings.push(state.configError);
          }
          if (!sameRefreshView(request)) return warnings;
          const observations=await loadObservations();
          if (sameRefreshView(request)&&observations?.status==="failed") warnings.push(observations.message);
        }
        return warnings;
      })();
      const [egress,pageWarnings]=await Promise.all([egressPromise,pagePromise]);
      if (!sameReadContext(request)) return {status:"stale",warnings:[]};
      const warnings=[...(egress?.status==="failed"?[egress.message]:[]),...(sameRefreshView(request)?pageWarnings:[])].filter(Boolean);
      return {status:warnings.length?"partial":"read",warnings};
    } catch(error) {
      if (!sameReadContext(request)) return {status:"stale",warnings:[]};
      // A settings/log/observation failure is not evidence that /status or login failed.
      return {status:"partial",warnings:[safeError(error,"部分页面读数暂时无法读取，请在对应页面重试。") ]};
    } finally {if(optionalStatusReads.get(key)===request)optionalStatusReads.delete(key);}})();
    return request.promise;
  }
  async function refresh(options = {}) {
    // The authenticated welcome layer hands off once on close. Do not repaint its old roster meanwhile.
    if (pendingAuthHandoff) return { status: "skipped", message: "请先进入花园，等待当前软件身份重新连接。" };
    if (statusRead && sameReadContext(statusRead)) return { status: "busy", message: "另一次本机状态读取尚未结束。" };
    const request = { ...readContext(), promise: null };
    statusRead = request;
    state.refreshing = true; renderConnection();
    request.promise = (async () => { try {
      if (options.explicit) reconnectNativeEngine(true);
      const result = await api("/status",{expectedContext:request});
      if (statusRead !== request || !sameReadContext(request)) return { status: "stale", message: "连接或软件身份已变化，旧读取结果未应用。" };
      if (result?.engineReadiness?.requiresEngineRestart === true && window.AndroidBridge) {
        // A request may have completed after its UI timeout. Reconcile the actual
        // current identity and bind its roster; never replay the authentication POST.
        if (result?.software) adoptSoftwareInfo(result.software);
        restartNativeEngine(); return { status: "reconnecting", message: "正在按当前软件身份重新连接手机服务，请就绪后重新读取。" };
      }
      if (result?.engineReadiness?.ready === false || result?.rosterReady === false) throw localFailure("手机运行服务正在核对当前软件身份，名册尚未就绪。");
      if (!Array.isArray(result?.accounts)) throw localFailure("手机运行服务没有返回可读取的游戏号名册，请重新读取。", "LOCAL_ROSTER_UNREADABLE");
      if (!result?.software || typeof result.software!=="object" || typeof result.software.signedIn!=="boolean") throw localFailure("软件身份尚未完整读取，请重新连接后核对。", "LOCAL_SOFTWARE_UNREADABLE");
      if (window.AndroidBridge && (result?.engineReadiness?.ready!==true || result.rosterReady!==true || result.engineReadiness.ownerBound!==true
        ||result.engineReadiness.softwareInitialized!==true || result.engineReadiness.instanceId!==request.instanceId || !["binding","ready"].includes(state.engine.phase)))
        throw localFailure("手机运行服务与当前软件身份尚未核对一致，请重新连接。", "LOCAL_REQUEST_STALE");
      const owner = String(result?.software?.user?.id ?? request.softwareUserId);
      if (request.softwareUserId && owner !== request.softwareUserId) throw localFailure("软件身份已变化，请重新连接后读取对应资料。", "LOCAL_REQUEST_STALE");
      state.status = result || {};
      if (result?.software && typeof result.software === "object") adoptSoftwareInfo(result.software);
      const adoptedOwner = request.softwareUserId !== softwareUserId();
      request.softwareUserId = softwareUserId();
      state.accounts = result.accounts;
      state.accountsReadState = "ready"; state.accountsError = "";
      nativeReconnectRequested = false;
      state.online = true; state.lastUpdated = new Date().toISOString();
      syncStartingSheetFromState();
      let rosterSelectionChanged = false;
      if (!state.accounts.some(account => sameId(account.id,state.selectedId))) {
        pauseDraftTransactions("当前游戏号名册已变化，原详情编辑没有应用到其他游戏号。");
        configRequest++;configRead=null;state.configLoading=false;
        const nextSelectedId = state.accounts[0]?.id ?? "";
        rosterSelectionChanged = !sameId(state.selectedId, nextSelectedId);
        state.selectedId = nextSelectedId;
        state.config = null; state.draft = null; state.dirty = false; clearObservations();
        if (rosterSelectionChanged) {
          invalidateLogRead();state.logs=[];state.logsError="";state.logDays=[];state.logCategories=[];resetLogsPage();
        }
      }
      if (result?.metadata) state.metadata = {...state.metadata,...result.metadata};
      const device = bridgeCall("deviceInfo");
      if (device && typeof device === "object") state.device = device;
      if (statusRead !== request || !sameReadContext(request)) return { status: "stale", message: "连接或软件身份已变化，旧读取结果未应用。" };
      // A verified identity/instance and its ready roster are sufficient to render and
      // complete this page handshake. Egress, settings and observations are independent.
      state.loading=false;renderIfIdle();
      if (window.AndroidBridge && result?.engineReadiness?.ready === true && result.engineReadiness.instanceId === state.engine.instanceId) {
        try { window.AndroidBridge.pageReady?.(state.engine.instanceId, state.engine.generation); } catch { /* Native status remains non-ready until a valid handshake. */ }
      }
      if (statusRead!==request || !sameReadContext(request)) return {status:"stale",message:"连接或软件身份已变化，旧读取结果未应用。"};
      const verifiedContext=readContext(),verifiedAt=state.lastUpdated;
      // Start secondary reads after this core transaction releases its lock. Even a
      // synchronous secondary setup error cannot enter the /status failure branch.
      request.detailsPromise=Promise.resolve().then(()=>{
        if (!sameReadContext(request)) return {status:"stale",warnings:[]};
        if (adoptedOwner) void loadCatalog();
        return readOptionalStatusDetails(request,options,rosterSelectionChanged);
      }).catch(error=>({status:sameReadContext(request)?"partial":"stale",warnings:sameReadContext(request)?[safeError(error,"部分页面读数暂时无法读取，请在对应页面重试。")]:[]}));
      return { status: "read", ...verifiedContext, at: verifiedAt, warnings:[], message:"已重新读取本机状态。" };
    } catch (error) {
      if (statusRead !== request || !sameReadContext(request)) return { status: "stale", message: "连接或软件身份已变化，旧读取结果未应用。" };
      state.online = false;
      pauseDraftTransactions(safeError(error,"手机服务连接暂时中断，原编辑继续保留，请重新连接后核对设置。"));
      updateDraftTransactionUI();
      state.accountsReadState = "error"; state.accountsError = safeError(error, "游戏号名册读取失败，请重新连接手机服务。");
      if (error.scope === "local-engine") reconnectNativeEngine();
      if (!options.quiet) toast(safeError(error,"连接不到手机运行服务，请稍后刷新。"));
      return { status: "failed", ...readContext(), message: state.accountsError };
    } finally {
      if (statusRead === request) { statusRead = null; state.refreshing = false; if (sameReadContext(request)) { state.loading = false; renderIfIdle(); } }
    } })();
    const result=await request.promise;
    if (!options.waitForDetails || result?.status!=="read" || !request.detailsPromise) return result;
    const details=await request.detailsPromise;
    if (!sameReadContext(request)) return {status:"stale",message:"连接或软件身份已变化，旧页面读数未应用。"};
    const warnings=details?.warnings||[];
    return {...result,warnings,message:warnings.length?`本机状态已读取；${warnings.join("；")}`:result.message};
  }
  async function loadCatalog() {
    if (catalogRead && sameReadContext(catalogRead)) return catalogRead.promise;
    const request = { ...readContext(), promise: null };
    catalogRead = request;
    state.catalogLoading = true; state.catalogReady = false; state.catalogError = "";
    request.promise = (async () => { try {
      const result = await api("/catalog",{expectedContext:request,optionalRead:true});
      if (catalogRead !== request || !sameReadContext(request)) return { status: "stale", message: "连接或软件身份已变化，旧目录未应用。" };
      if (!["flowers", "groupSizes", "plantModes", "qualities", "flowerArts"].every(key => Array.isArray(result?.[key]))
        || !result?.metadata || typeof result.metadata !== "object" || Array.isArray(result.metadata)) {
        throw localFailure("花种与选项目录返回不完整，请重新读取；已有设置继续保留。", "LOCAL_CATALOG_INCOMPLETE");
      }
      state.flowers = result.flowers.filter(flower => flower && flowerId(flower));
      state.groupSizes = result.groupSizes;
      state.plantModes = result.plantModes;
      state.qualities = result.qualities;
      // 花艺成品目录来自官方表现算（引擎那一份），页面不手写第二套名单。
      state.flowerArts = result.flowerArts;
      state.metadata = {...state.metadata, ...result.metadata};
      state.catalogReady = true;
      state.catalogSource = { ...readContext(), at: new Date().toISOString() };
      state.catalogError = "";
      return { status: "read", ...state.catalogSource, message: "已重新读取花种与选项目录。" };
    } catch (error) {
      if (catalogRead !== request || !sameReadContext(request)) return { status: "stale", message: "连接或软件身份已变化，旧目录错误未应用。" };
      state.catalogReady = false; state.catalogError = safeError(error,"花种与选项目录暂时无法读取，请刷新后重试。");
      return { status: "failed", ...readContext(), message: state.catalogError };
    } finally {
      if (catalogRead === request) { catalogRead = null; state.catalogLoading = false; if (sameReadContext(request) && state.tab === "settings") renderIfIdle(); }
    } })();
    return request.promise;
  }
  async function refreshFromUser({ reconnect = false } = {}) {
    if (userRead && sameReadContext(userRead)) return userRead.promise;
    const request = { ...readContext(), promise: null };
    userRead = request;
    request.promise = (async () => { try {
      // Wait for the actual background read, then perform this user's read. A busy lock is never
      // evidence that the button read anything, and repeated clicks share this one transaction.
      if (statusRead?.promise) await statusRead.promise;
      if (!sameReadContext(request)) return { status: "stale", message: "连接或软件身份已变化，请在当前页面重新读取。" };
      const status = await refresh({ includeDetails: true, quiet: true, explicit: reconnect, waitForDetails:true });
      if (!sameReadContext(request)) return { status: reconnect ? "reconnecting" : "stale", message: "手机服务正在切换连接，请就绪后重新读取。" };
      if (status?.status !== "read") return status || { status: "failed", message: "本次没有取得新的本机状态。" };
      const catalog = await loadCatalog();
      if (!sameReadContext(request)) return { status: "stale", message: "连接或软件身份已变化，旧刷新结果未应用。" };
      const problems = [...(status.warnings || []), ...(catalog?.status === "read" ? [] : [catalog?.message || "选项目录尚未读回。"])];
      return { ...status, status: problems.length ? "partial" : "read", catalog,
        message: problems.length ? `本机状态已读取；${problems.join("；")}` : "已重新读取本机状态和选项目录。" };
    } finally { if (userRead === request) userRead = null; } })();
    return request.promise;
  }
  let obsRequest = 0, observationsPending = null;
  function clearObservations() {
    obsRequest++;
    observationsPending = null;
    state.observations = null;
    state.observationsRead = null;
  }
  function sameObservationContext(context) {
    return Boolean(context) && sameReadContext(context) && context.accountId === String(state.selectedId);
  }
  async function readObservations() {
    if (state.selectedId === "") { clearObservations(); return { status: "skipped" }; }
    // Initial, manual and periodic reads of this exact owner share one real GET. A slow
    // response must settle instead of being made stale by each later polling callback.
    if (observationsPending && sameObservationContext(observationsPending)) return observationsPending.promise;
    if (observationsPending || state.observationsRead && !sameObservationContext(state.observationsRead)
      || state.observations && !sameObservationContext(state.observationsRead)) clearObservations();
    const request = { ...readContext(), accountId: String(state.selectedId), sequence: ++obsRequest };
    const pending = { ...request, promise: null };
    observationsPending = pending;
    // Changing only the visible tab does not change these read-only facts' owner. Let the
    // same account's real GET settle its metadata, without repainting a different page.
    const current = () => observationsPending === pending && request.sequence === obsRequest && sameObservationContext(request);
    const readAt = sameObservationContext(state.observationsRead) ? state.observationsRead.readAt : null;
    const attemptedAt = new Date().toISOString();
    state.observationsRead = { ...request, status: "loading", attemptedAt, readAt, failedAt: null, error: "" };
    pending.promise = (async () => { try {
      const result = await api(`/accounts/${encodeURIComponent(request.accountId)}/observations?view=summary`, { expectedContext: request, optionalRead:true });
      if (!current()) return { status: "stale" };
      if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.available !== "boolean") {
        throw new Error("现场读取没有返回可辨识结果，请重新读取。");
      }
      state.observations = result;
      state.observationsRead = { ...request, status: "read", attemptedAt, readAt: new Date().toISOString(), failedAt: null, error: "" };
      if (state.tab === "settings") renderIfIdle();
      return { status: "read", ...request, at: state.observationsRead.readAt };
    } catch (error) {
      if (!current()) return { status: "stale" };
      // Keep only the same owner's last successful facts. An observation-only failure must
      // neither erase that cache nor let /status remaining online imply a fresh observation.
      const message = safeError(error, "现场读取失败，请重新读取；上次读数仍保留。");
      state.observationsRead = { ...request, status: "failed", attemptedAt, readAt, failedAt: new Date().toISOString(), error: message };
      if (state.tab === "settings") renderIfIdle();
      return { status: "failed", ...request, message };
    } finally { if (observationsPending === pending) observationsPending = null; } })();
    return pending.promise;
  }
  function loadObservations() { return readObservations(); }
  async function refreshObservations() {
    if (state.tab !== "settings" || state.selectedId === "" || state.busy || state.dirty || hasDialog()) return;
    return readObservations();
  }
  let configRequest = 0, configRead = null;
  async function loadConfig() {
    if (state.selectedId === "") return;
    const id = String(state.selectedId),request={sequence:++configRequest,...draftContext(),transaction:pageDraftTransaction,
      draft:state.draft,config:state.config,editSequence:draftEditSequence};
    configRead=request;
    const current=()=>configRead===request && request.sequence===configRequest && sameDraftContext(request);
    const sameEditor=()=>pageDraftTransaction===request.transaction && state.draft===request.draft && state.config===request.config && draftEditSequence===request.editSequence;
    state.configLoading = true; state.configError = ""; renderIfIdle();
    try {
      const result = await api(`/accounts/${encodeURIComponent(id)}/config`,{expectedContext:request,optionalRead:true});
      if (!current() || !sameEditor()) return {status:"stale"};
      const config = result?.config || result;
      if (!validConfigShape(config)) throw new Error("这个账号的设置暂时无法读取，请重新读取。 ");
      if(configLayers().length){
        pauseDraftTransactions("设置已重新读取，详情里的编辑仍保留；请点「重新核对后继续编辑」确认基准后再完成。");
        updateDraftTransactionUI();return {status:"retained"};
      }
      if(state.dirty){toast("读取期间页面仍有未保存修改，已有草稿继续保留。");return {status:"retained"};}
      installConfigBaseline(config);
      if (result.metadata) state.metadata = {...state.metadata,...result.metadata};
      return {status:"read"};
    } catch (error) { if (current() && sameEditor()) { state.configError = safeError(error,"账号设置暂时无法读取，已有编辑继续保留，请重新读取。"); return {status:"failed"}; } }
    finally { if (current()) { configRead=null;state.configLoading = false;updateDraftTransactionUI();renderIfIdle(); } }
  }
  let logRequest = 0, logRetryTimer = null, logContinuationScope = null, logRestartPending = false;
  let logCatalogRequest = 0, logCatalogWait = null;
  let archivedSourcesContext = null, archivedSourcesRead = null;
  const isArchivedLogRef = value => typeof value === "string" && /^archive:[1-9]\d*$/.test(value);
  function archivedSources() { return archivedSourcesContext && sameReadContext(archivedSourcesContext) ? state.archivedLogSources : []; }
  function logSourceRef() { return state.logsScope === "account" ? String(state.selectedId) : state.logsScope; }
  function logSourceOptions() {
    return [{ value: "device", label: "本机 / 添加记录", description: "软件连接、账号添加与本机异常" },
      ...state.accounts.map(one => ({ value: String(one.id), label: accountName(one), description: one.serverName || "这个游戏号的运行记录" })),
      ...archivedSources().map(one => ({ value: one.sourceRef, label: `${one.name}（已移除）`,
        description: `${one.serverId} 服 · 只读历史记录 · 原编号 ${one.archivedAccountRef}${one.currentAccountRefs?.includes(String(state.selectedId)) ? " · 当前游戏号的历史来源" : ""}` }))];
  }
  function logSourceView() {
    const reference = logSourceRef(), archived = isArchivedLogRef(reference) ? archivedSources().find(one => one.sourceRef === reference) : null;
    if (isArchivedLogRef(reference)) return { ref: reference, archived: true,
      name: archived ? `${archived.name}（已移除 · #${archived.archivedAccountRef}）` : "历史记录来源未读取",
      meta: "已移除的游戏号 · 只读历史记录", initial: (archived?.name || "史").slice(0, 1) };
    if (reference === "device") return { ref: reference, archived: false, name: "本机 / 添加记录", meta: "本机全部记录 · 软件连接与账号添加", initial: "机" };
    const account = state.accounts.find(one => sameId(one.id, reference));
    const name = account ? accountName(account) : "当前游戏号";
    return { ref: reference, archived: false, name, meta: "当前游戏号 · 仅查看本账号记录", initial: name.slice(0, 1) };
  }
  function logSourcePath(reference) {
    if (reference === "device") return "/logs";
    if (isArchivedLogRef(reference)) return `/archived-accounts/${encodeURIComponent(reference.slice(8))}/logs`;
    return `/accounts/${encodeURIComponent(reference)}/logs`;
  }
  async function loadArchivedLogSources({ force = false } = {}) {
    if (archivedSourcesRead && sameReadContext(archivedSourcesRead.context)) return archivedSourcesRead.promise;
    if (!force && archivedSourcesContext && sameReadContext(archivedSourcesContext)) return { status: "read" };
    const request = { context: readContext(), promise: null };
    const current = () => archivedSourcesRead === request && sameReadContext(request.context) && signedIn() === true && engineReady();
    archivedSourcesRead = request; state.archivedLogSourcesLoading = true;
    request.promise = (async () => {
      try {
        const sources = []; let after = null;
        for (;;) {
          if (!current()) return { status: "stale" };
          const result = await api(`/archived-accounts?limit=100${after ? `&afterArchivedAccountRef=${encodeURIComponent(after)}` : ""}`,
            { expectedContext: request.context, optionalRead: true });
          if (!current()) return { status: "stale" };
          if (!Array.isArray(result?.sources) || result.sources.some(one => one?.kind !== "archived-account" || one.readOnly !== true
            || !isArchivedLogRef(one.sourceRef) || one.sourceRef !== `archive:${one.archivedAccountRef}` || typeof one.name !== "string")) throw new Error("历史来源列表没有返回完整的只读身份。");
          sources.push(...result.sources);
          if (result.page?.hasMore !== true) break;
          const next = result.page.afterArchivedAccountRef;
          if (!/^[1-9]\d*$/.test(String(next)) || Number(next) <= Number(after || 0)) throw new Error("历史来源分页未能继续，已有资料保持不变。");
          after = String(next);
        }
        state.archivedLogSources = sources; state.archivedLogSourcesError = ""; archivedSourcesContext = request.context;
        return { status: "read" };
      } catch (error) {
        if (!current()) return { status: "stale" };
        state.archivedLogSourcesError = safeError(error, "历史来源暂时无法读取，请重新打开来源选择。");
        return { status: "failed", message: state.archivedLogSourcesError };
      } finally { if (archivedSourcesRead === request) { archivedSourcesRead = null; state.archivedLogSourcesLoading = false; } }
    })();
    return request.promise;
  }
  function clearLogRetry() { if (logRetryTimer !== null) window.clearTimeout(logRetryTimer); logRetryTimer = null; }
  function cancelLogCatalogWait() {
    const waiting = logCatalogWait; logCatalogWait = null;
    if (waiting) { window.clearTimeout(waiting.timer); waiting.resolve(false); }
  }
  function invalidateLogRead() {
    logRequest++; logCatalogRequest++; clearLogRetry(); cancelLogCatalogWait();
    logContinuationScope = null; logRestartPending = false;
    state.logsLoading = false; state.logsNotice = ""; state.logsContinuation = null;
  }
  function resetLogsPage() { state.logsStack = []; state.logsHasMore = false; state.logsOlder = null; }
  function onFirstLogsPage() { return state.logsStack.length === 0; }
  function logContinuation(result) {
    const page = result?.page || {}, coverage = result?.historicalCoverage || {};
    const continuation = result?.continuation || page.continuation || coverage.continuation || {};
    if (continuation.required !== true && page.hasMoreComplete !== false && coverage.indexingComplete !== false) return null;
    const requestedDelay = Number(continuation.retryAfterMs);
    return { required: true, reason: continuation.reason || result?.reason || coverage.reason || "legacy_history_indexing",
      retryAfterMs: Number.isFinite(requestedDelay) && requestedDelay > 0 ? Math.max(250, Math.min(requestedDelay, 30000)) : 1000,
      restartFromHead: continuation.restartFromHead !== false };
  }
  function logReadNotice(result, continuation) {
    if (continuation?.reason === "legacy_history_source_unproved") return "历史记录的来源尚未确认，确认后会继续读取。";
    if (continuation) return "正在读取历史记录，读取完成后会从第一页显示。";
    return result?.page?.complete === false || result?.historicalCoverage?.completeArchivedRows === false
      ? "部分历史记录尚未完整核实，原资料继续保留；当前显示已读到的记录。" : "";
  }
  function logScopeProblem(scope) {
    if (typeof scope !== "string" || !scope) return "请选择要读取的日志来源。";
    if (scope === "device") return "";
    if (isArchivedLogRef(scope)) return archivedSources().some(one => one.sourceRef === scope) ? "" : "这份历史来源尚未读回，请重新打开日志来源选择。";
    if (state.accountsReadState !== "ready") return state.accountsReadState === "error"
      ? state.accountsError || "游戏号名册读取失败，请重新连接后读取日志。" : "游戏号名册尚未读取完成，请稍后重新选择。";
    return state.accounts.some(account => sameId(account.id, scope)) ? "" : "所选游戏号已不在当前名册中，请重新读取后选择。";
  }
  async function readLogFilterCatalog(scope) {
    const request = ++logCatalogRequest; cancelLogCatalogWait();
    const problem = logScopeProblem(scope);
    if (problem) return { status: "failed", message: problem };
    const context = { ...readContext(), scope, accountId: scope === "device" ? null : scope,
      tab: state.tab, selectedId: String(state.selectedId), logsScope: state.logsScope, category: state.logsCategory, day: state.logsDay,
      keyword: state.logsKeyword, level: state.logsLevel, outcome: state.logsOutcome, errorCode: state.logsErrorCode, traceId: state.logsTraceId, operationId: state.logsOperationId };
    const overlay = dialogFrames.at(-1)?.overlay || null;
    const current = () => request === logCatalogRequest && Boolean(context.softwareUserId) && sameReadContext(context)
      && signedIn() === true && engineReady() && state.tab === context.tab && String(state.selectedId) === context.selectedId
      && state.logsScope === context.logsScope && state.logsCategory === context.category && state.logsDay === context.day
      && state.logsKeyword === context.keyword && state.logsLevel === context.level && state.logsOutcome === context.outcome
      && state.logsTraceId === context.traceId && state.logsOperationId === context.operationId
      && state.logsErrorCode === context.errorCode
      && !logScopeProblem(scope) && (!overlay || overlay.isConnected && dialogFrames.at(-1)?.overlay === overlay);
    if (!current() || !engineReady()) return { status: "failed", context, message: "当前软件身份或手机服务尚未就绪，日志目录没有读取。" };
    try {
      for (;;) {
        if (!current()) return { status: "stale", context, message: "软件身份、连接或日志来源已变化，旧目录没有应用。" };
        const result = await api(`${logSourcePath(scope)}?limit=1`,
          { expectedContext: context, optionalRead: true });
        if (!current()) return { status: "stale", context, message: "软件身份、连接或日志来源已变化，旧目录没有应用。" };
        const continuation = logContinuation(result);
        if (continuation) {
          // Keep the existing filter form's loading state. A partial empty
          // catalogue cannot clear a saved category/day or enable Apply.
          const resumed = await new Promise(resolve => {
            const waiting = { resolve, timer: null };
            waiting.timer = window.setTimeout(() => {
              if (logCatalogWait === waiting) logCatalogWait = null;
              resolve(current());
            }, continuation.retryAfterMs);
            logCatalogWait = waiting;
          });
          if (!resumed) return { status: "stale", context, message: "日志目录读取已离开当前上下文，请重新读取。" };
          continue;
        }
        if (result?.page?.complete === false || result?.historicalCoverage?.completeArchivedRows === false)
          return { status: "failed", context, message: "部分历史记录尚未完整核实，分类与日期目录暂不完整；已有筛选保持不变。" };
        if (!Array.isArray(result?.categories) || !result.categories.every(value => typeof value === "string")
          || !Array.isArray(result?.days) || !result.days.every(value => typeof value === "string"))
          return { status: "failed", context, message: "手机服务未返回完整的日志分类与日期目录，请重新读取。" };
        return { status: "read", context, categories: [...new Set(result.categories)], days: [...new Set(result.days)] };
      }
    } catch (error) {
      if (!current()) return { status: "stale", context, message: "软件身份、连接或日志来源已变化，旧目录错误没有应用。" };
      return { status: "failed", context, message: safeError(error, "日志分类与日期目录暂时无法读取，请重新读取。") };
    }
  }
  function logsQuery(cursor, category = state.logsCategory, day = state.logsDay) {
    const parts = [`limit=${LOG_PAGE_SIZE}`];
    if (cursor?.localId !== null && cursor?.localId !== undefined) parts.push(`beforeLocalId=${encodeURIComponent(cursor.localId)}`);
    if (cursor?.businessId !== null && cursor?.businessId !== undefined) parts.push(`beforeBusinessId=${encodeURIComponent(cursor.businessId)}`);
    if (category) parts.push(`category=${encodeURIComponent(category)}`);
    if (day) parts.push(`day=${encodeURIComponent(day)}`);
    if (state.logsKeyword) parts.push(`keyword=${encodeURIComponent(state.logsKeyword)}`);
    if (state.logsLevel) parts.push(`level=${encodeURIComponent(state.logsLevel)}`);
    if (state.logsOutcome) parts.push(`outcomeState=${encodeURIComponent(state.logsOutcome)}`);
    if (state.logsErrorCode) parts.push(`errorCode=${encodeURIComponent(state.logsErrorCode)}`);
    if (state.logsTraceId) parts.push(`traceId=${encodeURIComponent(state.logsTraceId)}`);
    if (state.logsOperationId) parts.push(`operationId=${encodeURIComponent(state.logsOperationId)}`);
    return parts.join("&");
  }
  async function uploadFilteredLogs() {
    if (state.authBusy || !engineReady()) return;
    const scope = logSourceRef();
    const archived = isArchivedLogRef(scope), accountRef = scope === "device" ? "0" : archived
      ? scope.slice(8) : String(state.selectedId || "");
    if (scope !== "device" && !/^[1-9]\d*$/.test(accountRef)) { toast("请先选择游戏号的日志来源。"); return; }
    const path = scope === "device" ? "/logs/upload-selection" : archived
      ? `/archived-accounts/${encodeURIComponent(accountRef)}/logs/upload-selection`
      : `/accounts/${encodeURIComponent(accountRef)}/logs/upload-selection`;
    const filters = { category: state.logsCategory || null, day: state.logsDay || null, keyword: state.logsKeyword || null,
      level: state.logsLevel || null, outcomeState: state.logsOutcome || null, errorCode: state.logsErrorCode || null,
      operationId: state.logsOperationId || null, traceId: state.logsTraceId || null };
    const expectedContext = readContext();
    const operation = beginPanelOperation("sync", PANEL_FAMILIES.sync[0], "正在冻结当前完整筛选结果…");
    state.authBusy = true; showPanelProgress(operation, PANEL_FAMILIES.sync[0]);
    try {
      const result = await api(path, { method: "POST", body: filters, timeoutMs: 60000, expectedContext });
      if (!currentPanelOperation(operation)) return;
      const info = await api("/software/status", { expectedContext });
      if (!currentPanelOperation(operation)) return;
      adoptSoftwareInfo(info);
      if (result.reason === "empty_selection") {
        recordPanelOperation(operation, "success", "当前完整筛选范围没有可上传的记录。", 0);
      } else if (result.sent > 0 && result.accepted + result.duplicates === result.sent && result.rejected === 0) {
        recordPanelOperation(operation, "success", `当前完整筛选范围已冻结；本批 ${result.sent} 条得到服务器确认，后续批次由同一队列继续处理。`, result.sent);
      } else {
        recordPanelOperation(operation, result.reason === "empty" ? "unknown" : "unknown",
          "当前筛选选择已持久保存；本批没有取得完整确认，结果和原日志仍可在同步状态中核对。", result.sent || 0);
      }
      finishPanelFeedback(operation, result.confirmed === true ? "sync-success" : "sync-error");
    } catch (error) {
      if (!currentPanelOperation(operation)) return;
      recordPanelOperation(operation, "error", safeError(error, "当前筛选范围上传没有取得确认。"));
      finishPanelFeedback(operation, "sync-error");
    } finally { if (currentPanelOperation(operation)) state.authBusy = false; }
  }
  async function loadLogs() {
    clearLogRetry();
    if (state.logsScope === "account" && state.selectedId === "") state.logsScope = "device";
    const id = String(state.selectedId), scope = state.logsScope, request = ++logRequest, context = { ...readContext(), tab: state.tab };
    const category = state.logsCategory, day = state.logsDay;
    const sourceRef = logSourceRef();
    const queryFilters = [state.logsKeyword, state.logsLevel, state.logsOutcome, state.logsTraceId, state.logsOperationId, state.logsErrorCode];
    const continuationScope = JSON.stringify([context.softwareUserId, context.generation, context.instanceId, context.tab, id, scope, category, day, ...queryFilters]);
    if (continuationScope !== logContinuationScope) {
      logContinuationScope = continuationScope; logRestartPending = false; state.logsNotice = ""; state.logsContinuation = null;
    }
    const cursor = state.logsStack.length ? { ...state.logsStack[state.logsStack.length - 1] } : null;
    const current = () => request === logRequest && sameReadContext(context) && signedIn() === true
      && engineReady() && state.tab === context.tab && sameId(id, state.selectedId) && scope === state.logsScope && category === state.logsCategory && day === state.logsDay
      && queryFilters[0] === state.logsKeyword && queryFilters[1] === state.logsLevel && queryFilters[2] === state.logsOutcome
      && queryFilters[3] === state.logsTraceId && queryFilters[4] === state.logsOperationId
      && queryFilters[5] === state.logsErrorCode
      && sourceRef === logSourceRef();
    state.logsLoading = true; state.logsError = ""; render();
    try {
      await loadArchivedLogSources();
      if (!current()) return;
      const sourceProblem = logScopeProblem(sourceRef);
      if (sourceProblem) throw localFailure(sourceProblem, "LOG_SOURCE_UNAVAILABLE");
      const query = logsQuery(cursor, category, day);
      const result = await api(`${logSourcePath(sourceRef)}?${query}`,{expectedContext:context,optionalRead:true});
      if (!current()) return;
      if (!engineReady()) throw localFailure(state.engine.message || "手机运行服务尚未就绪，日志没有更新。");
      const continuation = logContinuation(result);
      if (!continuation && logRestartPending) {
        logRestartPending = false; state.logsContinuation = null;
        const hadCursor = state.logsStack.length > 0;
        resetLogsPage();
        if (hadCursor) { await loadLogs(); return; }
      }
      state.logs = Array.isArray(result) ? result : Array.isArray(result?.logs) ? result.logs : [];
      const page = result?.page && typeof result.page === "object" ? result.page : {};
      state.logsContinuation = continuation; state.logsNotice = logReadNotice(result, continuation);
      state.logsHasMore = !continuation && page.hasMore === true;
      state.logsOlder = !continuation && page.older && typeof page.older === "object" ? page.older : null;
      if (continuation) {
        logRestartPending = logRestartPending || continuation.restartFromHead;
        const timer = window.setTimeout(() => {
          if (logRetryTimer !== timer) return;
          logRetryTimer = null;
          if (current() && !logScopeProblem(sourceRef)) void loadLogs();
        }, continuation.retryAfterMs);
        logRetryTimer = timer;
        return;
      }
      // 「日期」那一格只列真有过记录的日子（名册由服务端现读两本账给，屏上不手输空白天）。
      if (Array.isArray(result?.days)) state.logDays = result.days;
      // 〔K15·2026-10-21〕分类下拉读服务端随读数给的那一份名册，界面不再自己抄一张表。
      if (Array.isArray(result?.categories)) state.logCategories = result.categories;
    } catch (error) { if (current()) { state.logsError = safeError(error,"运行日志暂时无法读取，请重新读取。"); state.logsHasMore = false; state.logsOlder = null; } }
    finally { if (request === logRequest) { state.logsLoading = false; if (current()) renderIfIdle(); } }
  }
  async function logsOlderPage() {
    if (state.logsLoading || state.logsContinuation || state.busy || !state.logsHasMore || !state.logsOlder) return;
    state.logsStack.push(state.logsScope === "device" ? { localId: state.logsOlder.localId } : { localId: state.logsOlder.localId, businessId: state.logsOlder.businessId });
    await loadLogs(); main.scrollTop = 0;
  }
  async function logsNewerPage() {
    if (state.logsLoading || state.logsContinuation || state.busy || !state.logsStack.length) return;
    state.logsStack.pop();
    await loadLogs(); main.scrollTop = 0;
  }
  function updateDirty() {
    const root=state.draft?pageDraftTransaction:currentConfigLayer()?.transaction || pageDraftTransaction;
    state.dirty=Boolean(root && root.softwareUserId===softwareUserId() && root.accountId===String(state.selectedId)
      && !sameDraftValue(root.baseSnapshot,root.draft));
  }
  function navigationIntentProblem(intent) {
    if (!intent) return "";
    const context = intent.context;
    if (!context?.softwareUserId || !sameReadContext(context) || signedIn() !== true || !engineReady()) return "软件身份或手机服务连接已变化，本次切换没有应用，请重新选择。";
    if (context.tab !== state.tab || context.selectedId !== String(state.selectedId) || context.logsScope !== state.logsScope)
      return "当前查看对象已变化，本次切换没有应用，请重新选择。";
    if (state.busy || state.authBusy) return "当前操作尚未结束，本次切换没有应用，请等待实际结果后重新选择。";
    if (intent.targetId !== undefined && (state.accountsReadState !== "ready" || !state.accounts.some(account => sameId(account.id, intent.targetId))))
      return "所选游戏号已不在当前名册中，本次切换没有应用，已有编辑继续保留。";
    return intent.logs ? logScopeProblem(intent.logs.scope) : "";
  }
  let dirtyNavigationSequence = 0, dirtyNavigation = null;
  function invalidateDirtyNavigation() {
    if (dirtyNavigation) dirtyNavigation.active = false;
    dirtyNavigation = null;
  }
  function dirtyNavigationProblem(transaction, baseline = null) {
    if (!transaction?.active || dirtyNavigation !== transaction) return "这次离开请求已失效，已有编辑没有应用到其他页面。";
    const problem = navigationIntentProblem(transaction.intent);
    if (problem) return problem;
    if (state.settingsTab !== transaction.settingsTab || configLayers().length) return "当前设置层级已变化，这次离开没有应用，请关闭详情后重新选择。";
    if (baseline) {
      if (pageDraftTransaction !== baseline.root || state.draft !== baseline.draft || state.config !== baseline.config
        || baseline.root.revision !== baseline.revision || state.dirty || !sameDraftValue(baseline.root.baseSnapshot, state.draft))
        return "保存后又有新的编辑，当前页面和草稿继续保留，请重新选择离开方式。";
    } else if (pageDraftTransaction !== transaction.root || state.draft !== transaction.draft || state.config !== transaction.config
      || transaction.root.revision !== transaction.revision || !sameDraftValue(transaction.root.baseSnapshot, transaction.baseSnapshot)
      || !sameDraftValue(transaction.draft, transaction.draftSnapshot)) return "草稿在确认期间已变化，请重新选择离开方式；已有编辑继续保留。";
    return "";
  }
  function showUnsavedNavigation(tab, id, intent, source) {
    const root = source?.root;
    if (!root || !source.draft) return;
    const context = intent?.context || source.context;
    const guardedIntent = { ...intent, context: { ...context },
      ...(intent?.logs ? { logs: { ...intent.logs } } : {}),
      ...(id === undefined ? {} : { targetId: String(id) }) };
    const transaction = { sequence: ++dirtyNavigationSequence, active: true, phase: "confirm", tab,
      id: id === undefined ? undefined : String(id), intent: guardedIntent, settingsTab: source.settingsTab,
      ...source, overlay: null };
    dirtyNavigation = transaction;
    const openingProblem = dirtyNavigationProblem(transaction);
    if (openingProblem) { invalidateDirtyNavigation(); toast(openingProblem); return; }
    transaction.overlay = showDialog("还有未保存的设置", '<p class="dialog-intro">保存只更新设置，不会自动开始账号。放弃后恢复到本次最后一次保存的内容。</p>', dialogActions(
      '<button class="button secondary" type="button" data-navigation-choice="discard">放弃修改并离开</button>',
      '<button class="button primary-button" type="button" data-navigation-choice="save">保存并离开</button>',
      '<button class="button secondary" type="button" data-navigation-choice="continue">继续编辑</button>'), "", () => {
        if (dirtyNavigation === transaction && transaction.phase === "confirm") invalidateDirtyNavigation();
      });
    transaction.overlay.addEventListener("click", async event => {
      const button = event.target.closest?.("[data-navigation-choice]");
      if (!button || !transaction.overlay.contains(button)) return;
      event.preventDefault(); event.stopPropagation();
      if (transaction.phase !== "confirm" || dialogFrames.at(-1)?.overlay !== transaction.overlay) return;
      if (button.dataset.navigationChoice === "continue") { closeDialog(); return; }
      const problem = dirtyNavigationProblem(transaction);
      if (problem) { toast(problem); return; }
      if (button.dataset.navigationChoice === "discard") {
        transaction.phase = "committing";
        installConfigBaseline(transaction.config);
        closeDialog(); invalidateDirtyNavigation();
        void changeTab(transaction.tab, transaction.id, transaction.intent);
        return;
      }
      if (button.dataset.navigationChoice !== "save") return;
      transaction.phase = "saving";
      closeDialog();
      const result = await saveConfig({ navigation: transaction });
      if (dirtyNavigation !== transaction || !transaction.active) return;
      const saved = result?.status === "saved" && result.baselineInstalled === true
        && result.sourceRootId === transaction.root.id && result.sourceRevision === transaction.revision
        && result.accountId === transaction.intent.context.selectedId && result.softwareUserId === transaction.intent.context.softwareUserId
        && result.generation === transaction.intent.context.generation && result.instanceId === transaction.intent.context.instanceId;
      const afterProblem = saved ? dirtyNavigationProblem(transaction, result.baselineToken) : "";
      const feedback = result?.feedbackOverlay;
      if (!saved || afterProblem || !feedback?.isConnected || dialogFrames.at(-1)?.overlay !== feedback) {
        invalidateDirtyNavigation();
        if (afterProblem) toast(afterProblem);
        return;
      }
      transaction.phase = "committing";
      closeDialog(); invalidateDirtyNavigation();
      void changeTab(transaction.tab, transaction.id, transaction.intent);
    });
  }
  async function changeTab(tab, id, intent = null) {
    if (!Object.hasOwn({accounts:1,settings:1,logs:1,me:1},tab)) return;
    if (tab === "logs" && isArchivedLogRef(intent?.logs?.scope || id)) id = undefined;
    invalidateBackgroundSettings();
    invalidateDirtyNavigation();
    if (intent && id !== undefined) intent = { ...intent, targetId: String(id) };
    const intentProblem = navigationIntentProblem(intent);
    if (intentProblem) { toast(intentProblem); return; }
    const changesAccount = id !== undefined && !sameId(id,state.selectedId);
    if(tab==="settings" && state.tab==="settings" && !changesAccount)return;
    // Capture the source before closing any read-only overlay can run its onClose callback.
    const dirtySource = state.dirty && pageDraftTransaction ? { context: accountChoiceContext(),
      settingsTab: state.settingsTab, root: pageDraftTransaction, draft: state.draft, config: state.config,
      revision: pageDraftTransaction.revision, baseSnapshot: cloneDraftValue(pageDraftTransaction.baseSnapshot),
      draftSnapshot: cloneDraftValue(state.draft) } : null;
    if (sheet && configLayers().some(layer=>changedLayerPaths(layer).length) && (changesAccount || tab !== "settings")) {
      const guardedIntent = { ...intent, context: { ...(intent?.context || accountChoiceContext()) },
        ...(intent?.logs ? { logs: { ...intent.logs } } : {}), ...(id === undefined ? {} : { targetId: String(id) }) };
      const frames = [...dialogFrames], layers = configLayers().map(layer => ({ layer, draft: layer.draft,
        revision: layer.revision, root: layer.transaction, rootRevision: layer.transaction?.revision }));
      showConfirm("设置还没有保存", "详情里的改动还没点「完成」，离开就丢掉，已保存的设置不受影响。", "丢掉并离开", () => {
        const problem = navigationIntentProblem(guardedIntent); if (problem) { toast(problem); return; }
        const current = configLayers();
        if (dialogFrames.length !== frames.length || frames.some((frame, index) => dialogFrames[index] !== frame)
          || current.length !== layers.length || layers.some((source, index) => current[index] !== source.layer
            || source.layer.draft !== source.draft || source.layer.revision !== source.revision
            || source.layer.transaction !== source.root || source.root?.revision !== source.rootRevision)) {
          toast("详情在确认期间已变化，已有编辑继续保留，请重新选择离开方式。"); return;
        }
        sheet = null; closeAllDialogs(); void changeTab(tab,id,guardedIntent);
      });
      return;
    }
    if (sheet) { sheet = null; closeAllDialogs(); }
    if (dialogFrames.length) closeAllDialogs();
    if (state.dirty && (changesAccount || tab !== "settings")) {
      showUnsavedNavigation(tab, id, intent, dirtySource);
      return;
    }
    if (tab === "logs" && id !== undefined) state.logsScope = "account";
    if (tab === "logs" && !intent?.logs) { state.logsTraceId = ""; state.logsOperationId = ""; }
    if (tab === "logs" && intent?.logs) {
      state.logsScope = isArchivedLogRef(intent.logs.scope) ? intent.logs.scope : intent.logs.scope === "device" ? "device" : "account";
      state.logsCategory = intent.logs.category; state.logsDay = intent.logs.day;
      state.logsKeyword = intent.logs.keyword || ""; state.logsLevel = intent.logs.level || ""; state.logsOutcome = intent.logs.outcomeState || "";
      state.logsErrorCode = intent.logs.errorCode || "";
      state.logsTraceId = intent.logs.traceId || ""; state.logsOperationId = intent.logs.operationId || "";
    }
    if (changesAccount) {
      state.logsTraceId = ""; state.logsOperationId = "";
      pauseDraftTransactions("当前游戏号已经切换，原编辑没有应用到其他游戏号。");
      configRequest++;configRead=null;state.configLoading=false;
      state.selectedId = id; state.config = null; state.draft = null; clearObservations(); state.logs = [];
      pageDraftTransaction=null;
      resetLogsPage();
    }
    if (tab === "logs" || state.tab === "logs" || changesAccount) {
      invalidateLogRead();state.logs=[];state.logsError="";state.logDays=[];state.logCategories=[];resetLogsPage();
    }
    state.tab = tab; render(); main.scrollTop = 0;
    if (tab === "settings" && state.selectedId !== "") { await loadConfig(); await loadObservations(); }
    if (tab === "logs") {
      resetLogsPage();
      const logNavigation = { ...accountChoiceContext(), request: logRequest, category: state.logsCategory, day: state.logsDay,
        keyword: state.logsKeyword, level: state.logsLevel, outcome: state.logsOutcome, errorCode: state.logsErrorCode, traceId: state.logsTraceId, operationId: state.logsOperationId };
      await loadArchivedLogSources({ force: true });
      if (sameReadContext(logNavigation) && logNavigation.request === logRequest && state.tab === "logs"
        && logNavigation.selectedId === String(state.selectedId) && logNavigation.logsScope === state.logsScope
        && logNavigation.category === state.logsCategory && logNavigation.day === state.logsDay
        && logNavigation.keyword === state.logsKeyword && logNavigation.level === state.logsLevel && logNavigation.outcome === state.logsOutcome
        && logNavigation.traceId === state.logsTraceId && logNavigation.operationId === state.logsOperationId
        && logNavigation.errorCode === state.logsErrorCode) await loadLogs();
    }
    if (tab === "me") {
      const device = bridgeCall("deviceInfo"); if (device && typeof device === "object") state.device = device;
      render();
    }
  }
  async function saveConfig({ navigation = null } = {}) {
    const context = { ...readContext(), accountId: String(state.selectedId) };
    const blocked = (message, code = "SAVE_BLOCKED") => {
      if (message) toast(message);
      return { status: "blocked", ...context, baselineInstalled: false, code, message };
    };
    if (!state.draft) return blocked("这个游戏号的设置尚未读取，当前没有可保存的草稿。");
    if (state.busy) return blocked("当前操作尚未结束，这次保存没有提交。");
    if (!state.dirty) return { status: "unchanged", ...context, baselineInstalled: false, message: "当前没有需要保存的修改。" };
    const saveRoot=pageDraftTransaction,saveStatus=rootDraftStatus(saveRoot,true);
    if(!saveStatus.ok){updateDraftTransactionUI();return blocked(saveStatus.message,saveStatus.code);}
    if(configLayers().length)return blocked("请先完成或取消详情里的修改，再保存页面设置。");
    const saveRevision=saveRoot.revision,saveDraft=state.draft;
    const receipt = (status, message, extra = {}) => ({ status, ...context, sourceRootId: saveRoot.id,
      sourceRevision: saveRevision, baselineInstalled: false, message, ...extra });
    const invalidInt = value => value === null || !Number.isInteger(value) || value < 0;
    if (state.draft.plantEnabled) {
      const groups = groupOptionValues();
      if (!Number.isInteger(state.draft.groupSize) || !groups.some(value => sameId(value,state.draft.groupSize))) return blocked("种植分组档位尚未读取或不在可选范围里，请刷新后再保存。 ");
      if (invalidInt(state.draft.restockCount)) return blocked("种植数量请填 0 或正整数（0＝不设目标）。 ");
    }
    if (state.draft.waterEnabled) {
      const rule = state.metadata.keepWater || {};
      const min = Number.isFinite(rule.min) ? rule.min : 0;
      if (!Number.isInteger(state.draft.keepWater) || state.draft.keepWater < min) return blocked(`保留水滴请填不低于 ${min} 的整数。 `);
    }
    const toNumber = value => /^\d+$/.test(String(value)) ? Number(value) : value;
    // 订单与花艺的数值先按页面读到的量程拦一道，服务端仍会逐字段再校验（两把尺都只认 schema 的数）。
    for (const group of ORDER_SWITCH_ONLY_VIDEO) {
      const rule = state.metadata?.orders?.[group]?.fields?.dailyLimit || {};
      const value = state.draft.orders[group].dailyLimit;
      if (!Number.isInteger(value) || value < (Number.isFinite(rule.min) ? rule.min : 0)
        || (Number.isFinite(rule.max) && value > rule.max)) return blocked(`${ORDER_CARD_ZH[group][0]}每日上限请填 ${Number.isFinite(rule.max) ? `${rule.min ?? 0} 至 ${rule.max}` : `不低于 ${rule.min ?? 0}`} 的整数（0＝不限）。 `);
    }
    const batchRule = state.metadata?.art?.makeBatch || {}, targetRule = state.metadata?.art?.targetStock || {};
    for (const [key, rule, label] of [["makeBatch", batchRule, "单次制作数量"], ["targetStock", targetRule, "目标库存"]]) {
      const value = state.draft.art[key];
      if (!Number.isInteger(value) || value < (Number.isFinite(rule.min) ? rule.min : 1)
        || (Number.isFinite(rule.max) && value > rule.max)) return blocked(`${label}请填 ${rule.min ?? 1} 至 ${rule.max ?? "不限"} 之间的整数。 `);
    }
    const payload = {
      plantEnabled: state.draft.plantEnabled, plantMode: state.draft.plantMode,
      plantFlowerIds: state.draft.plantFlowerIds.map(toNumber), plantQualities: state.draft.plantQualities.map(toNumber),
      groupSize: state.draft.groupSize === null ? null : Number(state.draft.groupSize),
      plantBlacklistIds: state.draft.plantBlacklistIds.map(toNumber), restockCount: state.draft.restockCount,
      harvestEnabled: state.draft.harvestEnabled,
      waterEnabled: state.draft.waterEnabled, keepWater: state.draft.keepWater,
      waterwheelEnabled: state.draft.waterwheelEnabled,
      freeWaterEnabled: state.draft.freeWaterEnabled,
      accelerationMode: state.draft.accelerationMode, speedCardKeep: state.draft.speedCardKeep,
      // 一次保存带上三个 Tab 的完整草稿；服务端只映射允许的土地/订单/花艺字段。
      // 每组只提交自己那一格：服务端按分组校验，别组键不送也不该送。
      orders: ORDER_KEYS.reduce((out, group) => {
        const row = state.draft.orders[group];
        const own = { enabled: row.enabled === true };
        if (Number.isFinite(Number(row.dailyLimit))) own.dailyLimit = Number(row.dailyLimit) || 0;
        if (group === "customer") { own.coinTiers = (row.coinTiers || []).map(Number); own.autoReject = row.autoReject === true; }
        if (group === "palace") own.qualityFilter = (row.qualityFilter || []).map(Number);
        if (group === "team") { own.realWrite = row.realWrite === true; own.allowFreeTake = row.allowFreeTake === true;
          own.allowBuyAgain = row.allowBuyAgain === true; own.buyAgainKeepYuanbao = Number(row.buyAgainKeepYuanbao) || 0; }
        out[group] = own;
        return out;
      }, {}),
      art: { makeEnabled: state.draft.art.makeEnabled === true, dailyMakeEnabled: state.draft.art.dailyMakeEnabled === true,
        specifiedArts: state.draft.art.specifiedArts.map(toNumber),
        autoReplenish: state.draft.art.autoReplenish === true, dailyMode: state.draft.art.dailyMode,
        dailyQualities: state.draft.art.dailyQualities.map(toNumber), targetStock: Number(state.draft.art.targetStock), makeBatch: Number(state.draft.art.makeBatch),
        firstAlbumClaim: state.draft.art.firstAlbumClaim === true, firstShareClaim: state.draft.art.firstShareClaim === true },
      flowerRack: { enabled: state.draft.flowerRack.enabled === true, autoTakeDown: state.draft.flowerRack.autoTakeDown === true,
        unlockEnabled: state.draft.flowerRack.unlockEnabled === true, sortStrategy: state.draft.flowerRack.sortStrategy,
        artIds: state.draft.flowerRack.artIds.map(toNumber), putCount: Number(state.draft.flowerRack.putCount),
        keepMinutes: Number(state.draft.flowerRack.keepMinutes), unlockKeepGold: Number(state.draft.flowerRack.unlockKeepGold) },
      dailyTaskRewards: { enabled: state.draft.dailyTaskRewards.enabled === true },
      mail: { enabled: state.draft.mail.enabled === true },
      benefitBox: { enabled: state.draft.benefitBox.enabled === true },
      dailyTaskBox: { enabled: state.draft.dailyTaskBox.enabled === true },
      weeklyTask: { enabled: state.draft.weeklyTask.enabled === true },
      freeYuanbaoGift: { enabled: state.draft.freeYuanbaoGift.enabled === true },
      doubleCoin: { enabled: state.draft.doubleCoin.enabled === true },
      mainTask: { enabled: state.draft.mainTask.enabled === true, maxRewardsPerMinute: Number(state.draft.mainTask.maxRewardsPerMinute) },
      mainStory: { enabled: state.draft.mainStory.enabled === true, maxUnlocksPerDay: Number(state.draft.mainStory.maxUnlocksPerDay) },
      guildBuild: { enabled: state.draft.guildBuild.enabled === true, videoEnabled: state.draft.guildBuild.videoEnabled === true,
        goldEnabled: state.draft.guildBuild.goldEnabled === true, yuanbaoEnabled: state.draft.guildBuild.yuanbaoEnabled === true,
        goldDailyCount: Number(state.draft.guildBuild.goldDailyCount), yuanbaoTimesPerDay: Number(state.draft.guildBuild.yuanbaoTimesPerDay) },
      guildLand: { enabled: state.draft.guildLand.enabled === true, harvestEnabled: state.draft.guildLand.harvestEnabled === true,
        plantEnabled: state.draft.guildLand.plantEnabled === true, upgradeEnabled: state.draft.guildLand.upgradeEnabled === true,
        unlockEnabled: state.draft.guildLand.unlockEnabled === true,
        unlockKeepGuildCoin: Number(state.draft.guildLand.unlockKeepGuildCoin), upgradeKeepGuildCoin: Number(state.draft.guildLand.upgradeKeepGuildCoin),
        plantMode: state.draft.guildLand.plantMode, plantFlowerIds: (state.draft.guildLand.plantFlowerIds || []).map(toNumber),
        plantBlacklistIds: (state.draft.guildLand.plantBlacklistIds || []).map(toNumber),
        plantQualities: (state.draft.guildLand.plantQualities || []).map(toNumber), minFlowerLevel: Number(state.draft.guildLand.minFlowerLevel) },
      cultivateUpgrade: { enabled: state.draft.cultivateUpgrade.enabled === true, targetLevel: Number(state.draft.cultivateUpgrade.targetLevel) },
      materialShop: { enabled: state.draft.materialShop.enabled === true, freeRefresh: state.draft.materialShop.freeRefresh === true,
        maxBuyPerMinute: Number(state.draft.materialShop.maxBuyPerMinute), keepGold: Number(state.draft.materialShop.keepGold) },
      configVersion: Number(state.draft.configVersion) || 3,
    };
    // A retry of this same save must carry the same command id so the engine
    // can replay the stored receipt instead of writing a second revision.
    const saveCommandId = crypto.randomUUID();
    payload.commandId = saveCommandId;
    const accountId = String(state.selectedId);
    const expected = normalizeConfig(state.draft);
    const operation = beginPanelOperation("save", "save-pending", "正在保存当前游戏号设置…", accountId);
    operation.onDismiss = () => { if (dirtyNavigation === navigation) invalidateDirtyNavigation(); };
    let accepted = false;
    state.busy = "save"; render();
    showPanelProgress(operation, "save-pending");
    try {
      const result = await api(`/accounts/${encodeURIComponent(accountId)}/config`,{method:"PUT",body:payload,expectedContext:operation});
      if (result?.commandId !== saveCommandId || result?.application?.commandId !== saveCommandId)
        throw localFailure("保存回执与本次命令编号不一致，未按已保存处理，请重新读取设置核对。", "CONFIG_COMMAND_MISMATCH");
      accepted = true;
      // Re-read the persisted config rather than claiming the local draft was saved.
      const stored = await api(`/accounts/${encodeURIComponent(accountId)}/config`,{expectedContext:operation});
      if (!currentPanelOperation(operation)) return receipt("stale", "连接或软件身份已变化，旧保存结果未用于离开页面。");
      if (!validConfigShape(stored?.config || stored)) throw new Error("保存结果暂时无法确认，请重新读取设置。 ");
      const actual = normalizeConfig(stored.config || stored);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw localFailure("读回的设置与本次修改不一致，请先核对实际保存结果。", "CONFIG_READBACK_MISMATCH");
      let baselineToken = null;
      if (sameId(accountId, state.selectedId)) {
        if(pageDraftTransaction===saveRoot && state.draft===saveDraft && saveRoot.revision===saveRevision && !configLayers().length) {
          const root = installConfigBaseline(actual);
          baselineToken = { root, draft: state.draft, config: state.config, revision: root.revision };
        } else if (pageDraftTransaction === saveRoot) {pauseDraftTransactions("保存结果已读回，但草稿在保存期间另有修改，已有编辑继续保留，请重新核对后再操作。");updateDraftTransactionUI();}
        if (result?.metadata) state.metadata = {...state.metadata,...result.metadata};
      }
      recordPanelOperation(operation, "success", baselineToken ? "已重新读取并核对，本次设置已保存；不会自动开始运行。"
        : "本次发送的设置已保存并读回；当前编辑归属另有变化，现有草稿继续保留，没有自动离开。");
      const feedbackShown = finishPanelFeedback(operation, "save-success");
      return receipt(baselineToken ? "saved" : "retained", baselineToken
        ? "本次设置已保存并读回核对。" : "保存已确认，但当前编辑归属已变化，页面继续保留。", {
        operationSequence: operation.sequence, baselineInstalled: Boolean(baselineToken), baselineToken,
        feedbackOverlay: feedbackShown ? dialogFrames.at(-1)?.overlay : null });
    } catch (error) {
      if (!currentPanelOperation(operation)) return receipt("stale", "连接或软件身份已变化，旧保存结果未用于离开页面。");
      const unknown = accepted || uncertainOperation(error);
      if(unknown && pageDraftTransaction===saveRoot)pauseDraftTransactions("本次保存结果尚未确认，已有草稿继续保留；请先重新读取并核对，不会自动重提。");
      if (recordPanelOperation(operation, unknown ? "unknown" : "error", unknown
        ? "保存结果尚未确认，草稿已保留。请先重新读取实际设置，不会自动重提。"
        : safeError(error, "本次设置未保存，草稿仍保留，请核对后重试。"))) finishPanelFeedback(operation, "save-error");
      return receipt(unknown ? "unknown" : "error", unknown ? "保存结果尚未确认，草稿继续保留，请先重新核对。"
        : safeError(error, "本次设置未保存，草稿继续保留。"), { operationSequence: operation.sequence });
    }
    finally { if (currentPanelOperation(operation)) { state.busy = ""; render(); void loadObservations(); } }
  }
  /* 后台轮询可能在动作用力刷新的那一刻占着 refreshing；等它收尾再发，避免这次刷新被静默跳过。 */
  async function refreshForAction() {
    for (let i = 0; i < 20 && state.refreshing; i++) await new Promise(resolve => setTimeout(resolve, 100));
    await refresh({quiet:true});
  }
  let accountActionSequence = 0;
  let currentAccountAction = null;
  function sameAccountActionContext(operation) {
    return currentAccountAction === operation && operation.generation === state.engine.generation
      && operation.instanceId === state.engine.instanceId && operation.softwareUserId === softwareUserId();
  }
  function accountActionFrame(operation) {
    return !operation.dismissed && operation.overlay?.isConnected
      ? dialogFrames.find(frame => frame.overlay === operation.overlay) : null;
  }
  function accountActionReason(error, fallback) {
    // Retain only escaped customer copy and whitelisted metadata, never the error/response object.
    return publicAddPanelFacts({ summary: safeError(error, fallback) })?.summary || fallback;
  }
  function accountActionBody(operation, { status, reason, result = false, protection = "" }) {
    const what = operation.action === "start" ? "启动" : "停止";
    const readback = operation.readback;
    const current = readback ? `${readback.label}${typeof readback.desiredRunning === "boolean" ? `；${readback.desiredRunning ? "保留运行安排" : "未保留运行安排"}` : ""}` : "本次尚未读回";
    const currentNote = readback ? `${readback.note}（${dateText(readback.at)}）${operation.readbackError ? `；${operation.readbackError}` : ""}`
      : operation.readbackError || "请求响应不代表游戏号已运行或已停止；状态需要另行读取。";
    const facts = operation.failure;
    const response = facts ? [facts.source, facts.httpStatus ? `HTTP ${facts.httpStatus}` : "",
      facts.code ? `错误码：${facts.code}` : "", facts.requestId ? `请求编号：${facts.requestId}` : ""].filter(Boolean).join("；") : "";
    const reading = operation.reading || Boolean(operation.readPromise);
    const links = result ? `<button class="button secondary wide" type="button" data-account-action-link="settings">返回这个号的设置</button><button class="button secondary wide" type="button" data-account-action-link="logs">查看这个号的日志</button><button class="button secondary wide" type="button" data-account-action-link="read" aria-busy="${reading ? "true" : "false"}"${!operation.finished || reading ? " disabled" : ""}>${reading ? "正在读取状态…" : "重新读取状态"}</button>` : "";
    return `<p class="dialog-intro" data-account-subtitle>${esc(operation.name)}（游戏号 #${esc(operation.accountId)}） · 本次${what}请求与实际读回分别核对。</p>${accountStatusCard("clock", `本次${what}请求`, status, reason).replace('<section class="infocard">', '<section class="infocard" data-account-action-result>')}${accountStatusCard("clock", operation.readbackError && readback ? "上次读回" : "最新读回", current, currentNote)}${response ? `<div class="panel-note"><strong>本次响应</strong>${esc(response)}</div>` : ""}${protection ? `<div class="panel-note"><strong>结果与保护</strong>${esc(protection)}</div>` : ""}${links}`;
  }
  function paintAccountActionDialog(operation, view, allowRetired = false) {
    const frame = accountActionFrame(operation);
    if (!frame || !allowRetired && !sameAccountActionContext(operation)) return false;
    const dialog = frame.overlay.querySelector(".dialog,.moon-dialog");
    if (!dialog || frame.overlay.dataset.accountActionSequence !== String(operation.sequence)) return false;
    operation.view = view;
    const body = accountActionBody(operation, view);
    const footer = dialogActions('<button class="button primary-button" type="button" data-action="close-dialog">关闭</button>');
    const active = document.activeElement;
    const wasFocused = dialog.contains(active);
    const focusAction = wasFocused ? active?.dataset.accountActionLink || active?.dataset.action : "";
    const coveredFocus = dialogFrames.filter(one => one !== frame && dialog.contains(one.previousFocus))
      .map(one => ({ frame: one, action: one.previousFocus?.dataset.accountActionLink || one.previousFocus?.dataset.action }));
    const scrollTop = dialog.querySelector(".dialog-body")?.scrollTop || 0;
    if (window.MoonUI?.formalHTML) {
      const template = document.createElement("template");
      template.innerHTML = window.MoonUI.formalHTML({ title: view.title, body, footer, kind: view.kind, index: dialogFrames.indexOf(frame) + 1 });
      const replacement = template.content.querySelector(".dialog,.moon-dialog");
      if (!replacement) return false;
      dialog.replaceWith(replacement);
    } else {
      const heading = dialog.querySelector("h2"); if (heading) heading.textContent = view.title;
      const contents = dialog.querySelector(".dialog-body"); if (contents) contents.innerHTML = body;
      dialog.querySelector(":scope > .dialog-actions")?.remove();
      dialog.insertAdjacentHTML("beforeend", footer);
    }
    // Updating our own covered layer must not close, replace or steal focus from a newer form.
    syncDialogAria();
    const scroll = frame.overlay.querySelector(".dialog-body"); if (scroll) scroll.scrollTop = scrollTop;
    const controls = [...frame.overlay.querySelectorAll("button")];
    const restoreControl = action => controls.find(button => (button.dataset.accountActionLink || button.dataset.action) === action)
      || controls.find(button => button.dataset.action === "close-dialog");
    for (const restore of coveredFocus) restore.frame.previousFocus = restoreControl(restore.action) || restore.frame.previousFocus;
    if (wasFocused && dialogFrames[dialogFrames.length - 1] === frame) {
      restoreControl(focusAction)?.focus({ preventScroll: true });
    }
    return true;
  }
  function retireAccountActionDialog(operation) {
    operation.readback = null;
    operation.readbackError = "连接或软件身份已变化，请在当前身份下重新读取；这里不应用旧请求的状态。";
    operation.failure = null;
    paintAccountActionDialog(operation, { title: "本次结果待核对", status: "旧连接的结果未应用", reason: "本次请求属于先前连接，不会自动重复提交。", kind: "account-action-unknown-sheet", protection: "这里不重提请求、不清除未确认记录。旧请求是否已改变运行安排，请在当前身份下重新读取核对。" }, true);
  }
  function showAccountActionRequest(operation) {
    const what = operation.action === "start" ? "启动" : "停止";
    const view = { title: `正在提交${what}请求`, status: "等待请求响应", reason: "正在等待手机运行服务返回；此时不判定游戏号已运行或已停止。", kind: `account-action-${operation.action}-request` };
    const footer = dialogActions('<button class="button secondary" type="button" data-action="close-dialog">返回查看状态</button>');
    operation.overlay = showDialog(view.title, accountActionBody(operation, view), footer, view.kind, () => { operation.dismissed = true; });
    operation.overlay.dataset.accountActionSequence = String(operation.sequence);
    operation.overlay.addEventListener("click", event => {
      const button = event.target.closest("[data-account-action-link]");
      if (!button || !operation.overlay.contains(button)) return;
      event.preventDefault(); event.stopPropagation();
      if (!sameAccountActionContext(operation)) { retireAccountActionDialog(operation); return; }
      if (dialogFrames[dialogFrames.length - 1]?.overlay !== operation.overlay) return;
      const link = button.dataset.accountActionLink;
      if (link === "settings" || link === "logs") { void changeTab(link, operation.accountId); return; }
      if (link === "read" && operation.finished && !operation.reading) {
        operation.reading = true; button.disabled = true; button.textContent = "正在读取状态…"; button.setAttribute("aria-busy", "true");
        void readAccountActionState(operation).then(account => {
          if (sameAccountActionContext(operation) && account && !operation.failure) operation.view = accountActionReadbackView(operation);
        }).catch(error => {
          if (!sameAccountActionContext(operation)) return;
          operation.readbackError = accountActionReason(error, "本次状态读取未完成，请稍后重新读取。 ");
          if (!operation.failure) operation.view = { title: "当前状态待重新读取", status: "本次重新读取未完成", reason: operation.readbackError,
            kind: "account-action-unknown-sheet", result: true, protection: "保留上次读回的时间与状态；本次读取失败不改变运行安排，也不会重新发起启动或停止。" };
        }).finally(() => {
          operation.reading = false;
          if (!sameAccountActionContext(operation)) { retireAccountActionDialog(operation); return; }
          if (operation.view) paintAccountActionDialog(operation, operation.view);
        });
      }
    });
    operation.view = view;
  }
  async function readAccountActionState(operation) {
    if (!sameAccountActionContext(operation)) return null;
    if (operation.readPromise) return operation.readPromise;
    // This exact target GET is independent of the background refresh lock. Never confirm from an
    // older roster, the POST's HTTP status, or a different selected game account.
    const pending = (async () => {
      const result = await api(`/accounts/${encodeURIComponent(operation.accountId)}`);
      if (!sameAccountActionContext(operation)) return null;
      const account = result?.account;
      if (!account || !sameId(account.id, operation.accountId)) throw localFailure("没有读回这个游戏号的完整状态，本次结果仍待核对。", "ACCOUNT_ACTION_READBACK_UNCONFIRMED");
      operation.readback = { at: new Date().toISOString(), label: stateLabel(account), state: accountState(account), desiredRunning: account.desiredRunning, pending: isPending(account),
        note: accountActionReason({ message: accountNote(account) }, "以这个游戏号本次读取的实际状态为准。") };
      operation.readbackError = "";
      state.accounts = state.accounts.map(one => sameId(one.id, operation.accountId) ? account : one);
      renderIfIdle();
      return account;
    })();
    operation.readPromise = pending;
    try { return await pending; }
    finally { if (operation.readPromise === pending) operation.readPromise = null; }
  }
  function accountActionReadbackView(operation, settled = true) {
    const current = operation.readback;
    const started = operation.action === "start" && current.state === "running";
    const stopped = operation.action === "stop" && current.state === "stopped" && current.desiredRunning === false;
    const startEnded = operation.action === "start" && (["failed", "error", "blocked"].includes(current.state)
      || settled && ["stopped", "idle"].includes(current.state) && !current.pending);
    const what = operation.action === "start" ? "启动" : "停止";
    return { title: started ? "已开始照料" : stopped ? "任务已停止" : startEnded ? "启动未完成" : `正在核对${what}状态`,
      status: started || stopped || startEnded ? current.label : "请求已受理，正在读取状态", reason: current.note,
      kind: stopped ? "account-action-stopped-sheet" : `account-action-${operation.action}-state`, result: true,
      protection: "只按实际读回展示运行状态；未确认记录继续保留，不会自动重复发起本次请求。", terminal: started || stopped || startEnded };
  }
  function showAccountActionFailure(operation, error) {
    const unknown = operation.accepted || uncertainOperation(error);
    const what = operation.action === "start" ? "启动" : "停止";
    const status = Number(error?.status);
    operation.failure = {
      unknown,
      source: ({ "software-cloud": "软件云服务", "software-local": "本机软件服务", "local-engine": "手机运行服务" })[error?.scope] || "手机运行服务",
      ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {}),
      ...(typeof error?.code === "string" && error.code !== "LOCAL_REQUEST_FAILED" && /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(error.code) ? { code: error.code } : {}),
      ...(typeof error?.requestId === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(error.requestId) ? { requestId: error.requestId } : {}),
    };
    return paintAccountActionDialog(operation, { title: unknown ? `${what}结果待核对` : `${what}请求未完成`, status: unknown ? "结果尚未确认" : "手机服务返回未完成原因",
      reason: accountActionReason(error, unknown ? "尚未确认本次请求是否完成，请先读取实际状态。" : "这一步未完成，请核对实际设置与运行记录。"),
      kind: unknown ? "account-action-unknown-sheet" : "account-action-error-sheet", result: true,
      protection: "页面不会自动重复提交。关闭或查看此提示不会改变运行安排，未确认记录继续保留；本次请求是否改变状态，以重新读取为准。" });
  }
  async function runAction(id, action) {
    if (state.busy && action !== "stop" || !state.online && action !== "stop") return;
    if (action === "start" && state.dirty && sameId(id,state.selectedId)) { toast("请先保存当前设置，再开始运行。 "); return; }
    const target = state.accounts.find(one => sameId(one.id, id));
    if (!["start", "stop"].includes(action) || !target) { toast("没有找到本次操作的游戏号，请先刷新游戏号列表。 "); return; }
    let stopBody = {};
    if (action === "stop") {
      const commandId = newStopCommandId();
      if (!commandId) { toast("本机没有生成停止请求编号；未提交停止请求，请重新点停止。 "); return; }
      stopBody = { commandId };
      if (window.AndroidBridge) {
        const request = { latchId: commandId, commandId, ownerRef: String(target.ownerRef || ""),
          accountRef: String(target.accountRef || target.id), subjectRef: String(target.subjectRef || ""), officialUid: Number(target.uid) };
        let persisted = null;
        try { const raw = window.AndroidBridge.persistAccountStopRequest(JSON.stringify(request)); persisted = typeof raw === "string" ? JSON.parse(raw) : raw; }
        catch { persisted = null; }
        if (persisted?.saved !== true || persisted.latchId !== commandId) {
          toast("本机没有确认保存这条停止请求；未提交停止，请重新读取账号后再试。 "); return;
        }
      }
      stopBody = { commandId };
    }
    const operation = { sequence: ++accountActionSequence, accountId: String(target.id), name: accountName(target), action,
      generation: state.engine.generation, instanceId: state.engine.instanceId, softwareUserId: softwareUserId(),
      busyToken: `${action}:${target.id}`, commandId: action === "stop" ? stopBody.commandId : null,
      nativeStopPersisted: action === "stop" && !!window.AndroidBridge,
      overlay: null, dismissed: false, accepted: false, readback: null, reading: false, finished: false };
    currentAccountAction = operation;
    state.busy = operation.busyToken; render();
    try {
      showAccountActionRequest(operation);
      if (action === "stop" && !state.online && operation.nativeStopPersisted) {
        operation.finished = true;
        state.busy = "";
        showDialog("停止请求已保存", `<p class="dialog-intro">${esc(accountSheetTarget(target, operation.accountId))} · 停止请求已写入本机，等待运行服务接收。</p>${accountStatusCard("clock", "当前状态", "正在等待停止", "服务恢复后会按同一请求编号完成排空；这里尚未读回实际停止状态。未确认的操作记录继续保留。")}`,
          dialogActions('<button class="button primary-button" type="button" data-action="close-dialog">返回查看状态</button>'), "account-stopping-sheet");
        return;
      }
      let expectedPriorRunEpoch = null;
      if (action === "start") {
        expectedPriorRunEpoch = target.runEpoch;
        if (!Number.isSafeInteger(expectedPriorRunEpoch) || expectedPriorRunEpoch < 0) {
          const invalid = localFailure("账号运行代次尚未读取完整；请刷新账号状态后重新确认启动。", "START_RUN_EPOCH_UNAVAILABLE");
          invalid.status = 409; throw invalid;
        }
        const latest = await api(`/accounts/${encodeURIComponent(operation.accountId)}`);
        if (!sameAccountActionContext(operation)) { retireAccountActionDialog(operation); return; }
        const fresh = latest?.account;
        const sameIdentity = fresh && sameId(fresh.id, operation.accountId)
          && String(fresh.ownerRef || "") === String(target.ownerRef || "")
          && String(fresh.accountRef || fresh.id) === String(target.accountRef || target.id)
          && String(fresh.subjectRef || "") === String(target.subjectRef || "")
          && (fresh.uid == null ? null : String(fresh.uid)) === (target.uid == null ? null : String(target.uid));
        if (!sameIdentity || fresh.runEpoch !== expectedPriorRunEpoch) {
          const changed = localFailure("账号身份或停止代次已变化；没有提交启动，请刷新账号状态后重新确认。", "START_RUN_INTENT_CHANGED");
          changed.status = 409; throw changed;
        }
      }
      const startBody = action === "start" ? { expectedPriorRunEpoch } : stopBody;
      const response = await api(`/accounts/${encodeURIComponent(operation.accountId)}/${action}`, {method:"POST",body:action === "stop" ? stopBody : startBody});
      if (!sameAccountActionContext(operation)) { retireAccountActionDialog(operation); return; }
      operation.accepted = true;
      if (!response?.account || !sameId(response.account.id, operation.accountId)
        || (action === "start" ? response.accepted !== true : response.ok !== true || response.commandId !== operation.commandId
          || operation.nativeStopPersisted && response.latchAcknowledged !== true)) {
        throw localFailure("请求响应尚未完整确认，请先重新读取这个游戏号的状态；不会自动重提。", "ACCOUNT_ACTION_RESPONSE_UNCONFIRMED");
      }
      for (let i = 0; i < (action === "start" ? 14 : 10); i++) {
        const account = await readAccountActionState(operation);
        if (!sameAccountActionContext(operation)) { retireAccountActionDialog(operation); return; }
        if (!account) throw localFailure("本次没有读回这个游戏号的状态。", "ACCOUNT_ACTION_READBACK_UNCONFIRMED");
        const view = accountActionReadbackView(operation, i >= 1);
        paintAccountActionDialog(operation, view);
        if (view.terminal || operation.dismissed) break;
        await new Promise(resolve => setTimeout(resolve, 700));
        if (!sameAccountActionContext(operation)) { retireAccountActionDialog(operation); return; }
        if (operation.dismissed) break;
      }
    } catch (error) {
      if (!sameAccountActionContext(operation)) { retireAccountActionDialog(operation); return; }
      showAccountActionFailure(operation, error);
      try { await readAccountActionState(operation); }
      catch (readError) { if (sameAccountActionContext(operation)) operation.readbackError = accountActionReason(readError, "本次状态未读回，请重新读取后核对。 "); }
      if (!sameAccountActionContext(operation)) { retireAccountActionDialog(operation); return; }
      if (operation.view) paintAccountActionDialog(operation, operation.view);
    }
    finally {
      operation.finished = true;
      if (sameAccountActionContext(operation) && state.busy === operation.busyToken) {
        state.busy = "";
        if (operation.view) paintAccountActionDialog(operation, operation.view);
        renderIfIdle();
      }
    }
  }
  async function saveEgress(clear = false) {
    if (state.busy || !state.online) return;
    if (!clear && !state.egressDraft.trim()) { toast("请输入出口 IP:端口或完整代理地址。"); return; }
    const payload = {proxy: clear ? "" : state.egressDraft.trim()};
    const operation = beginPanelOperation("network", "network-loading", "正在保存统一网络出口，完成后重新读取当前配置。");
    let accepted = false;
    // An older optional GET cannot overwrite this write's eventual verified readback.
    egressRead=null;
    state.busy = "egress"; state.egressError = ""; render();
    showPanelProgress(operation, "network-loading");
    try {
      const saved = await api("/egress",{method:"PUT",body:payload}); accepted = true;
      const actual = await api("/egress");
      if (!currentPanelOperation(operation)) return;
      if (!actual || actual.routing !== (clear ? "direct" : "proxy") || actual.configured !== !clear
        || saved?.routing !== actual.routing || saved?.configured !== actual.configured) {
        throw localFailure("出口保存后的读数尚未对齐，请先重新读取。", "EGRESS_READBACK_MISMATCH");
      }
      state.egress = actual;
      state.egressDraft = ""; state.egressEditing = false;
      recordPanelOperation(operation, "success", clear ? "已读回当前配置，全部游戏号改用本机网络。" : "已读回当前配置，全部游戏号使用统一代理出口；不代表已连通官服。");
      finishPanelFeedback(operation, clear ? "network-direct" : "network-proxy");
    } catch (error) {
      if (!currentPanelOperation(operation)) return;
      const unknown = accepted || uncertainOperation(error);
      state.egressError = unknown ? "出口保存结果尚未确认，请重新读取后再决定是否重试。"
        : Number(error.status) === 409 ? "请先停止全部游戏号和添加核对，再修改网络出口。"
          : "出口设置未保存，请检查地址格式后重试。";
      recordPanelOperation(operation, unknown ? "unknown" : "error", state.egressError);
      finishPanelFeedback(operation, "network-error");
    }
    finally { payload.proxy = ""; if (currentPanelOperation(operation)) { state.busy = ""; render(); } }
  }
  // 〔K17.5〕设备级一格里外两件事：这一格只改「运行日志什么时候上传」，不碰业务开关；保存后立刻回读状态。
  async function toggleUploadPolicy(sourceButton) {
    if (state.busy || !state.online) return;
    const priorPolicy = state.status?.software?.uploadPolicy;
    if (typeof priorPolicy?.enabled !== 'boolean') { toast("上传网络设置尚未读到，请先重新读取。"); return; }
    const generation = state.engine.generation, instanceId = state.engine.instanceId, owner = softwareUserId();
    const expectedContext = readContext(); let submitted = false;
    const sourceDialog = sourceButton?.closest(".dialog,.moon-dialog");
    const sourceOverlay = dialogFrames.find(frame => frame.overlay.contains(sourceButton))?.overlay;
    const networkEntry = $("#network-upload-policy");
    const sameContext = () => generation === state.engine.generation && instanceId === state.engine.instanceId && owner === softwareUserId();
    const mayNotify = () => sameContext() && (!sourceOverlay || sourceOverlay.isConnected);
    const next = !priorPolicy.enabled;
    state.busy = "upload-policy"; render();
    if (sourceButton?.isConnected) { sourceButton.disabled = true; sourceButton.setAttribute("aria-busy", "true"); }
    try {
      await api("/upload-policy", { method: "PUT", body: { wifiOnly: next }, expectedContext }); submitted = true;
      const actualPolicy = await api("/upload-policy", { expectedContext, optionalRead: true });
      if (!sameContext()) return;
      if (actualPolicy?.enabled !== next) throw localFailure("上传网络设置已提交，但回读尚未一致，请重新读取后确认。", "UPLOAD_POLICY_READBACK_MISMATCH");
      if (state.status?.software) state.status.software = { ...state.status.software, uploadPolicy: actualPolicy };
      if (mayNotify()) toast(next ? "已设为只在 Wi-Fi 下上传运行日志。" : "已取消：任何线路都按原来的时间上传。");
      await refresh({ includeDetails: true });
    } catch (error) { if (mayNotify()) toast(submitted ? "上传设置已提交，回读结果尚未确认；请重新读取后核对。" : safeError(error, "上传设置未得到保存确认，请重新读取后核对。")); }
    finally {
      if (sameContext() && state.busy === "upload-policy") {
        state.busy = "";
        render();
        /* Update only the controls captured by this click. Preserve the parent form, its sensitive
           unsubmitted input and any newer dialog. A dismissed disclosure is never reopened. */
        const policy = state.status?.software?.uploadPolicy;
        if (sourceButton?.isConnected) {
          sourceButton.disabled = !state.online || !policy;
          sourceButton.setAttribute("aria-checked", String(policy?.enabled === true));
          sourceButton.removeAttribute("aria-busy");
        }
        if (sourceDialog?.isConnected) {
          const facts = sourceDialog.querySelector("[data-upload-policy-facts]");
          if (facts) {
            const transport = ({ wifi: "Wi-Fi", cellular: "移动数据", ethernet: "有线网络", none: "没有可用网络" })[state.status?.network?.transport] || "线路暂时没读到";
            const pending = typeof policy?.pending === "number" && Number.isFinite(policy.pending) && policy.pending >= 0 ? ` ${policy.pending} 条` : "未读取";
            const held = policy?.holdSince ? `正在等待 Wi-Fi；待传数量${pending}` : policy ? "当前没有等待 Wi-Fi 的上传安排" : "上传策略尚未读取";
            const heading = document.createElement("strong"); heading.textContent = "当前读数";
            facts.replaceChildren(heading, document.createTextNode(`当前线路：${transport}；${held}。`));
          }
        }
        if (networkEntry?.isConnected) {
          const label = policy?.enabled === true ? "当前仅在 Wi-Fi 上传运行日志" : policy?.enabled === false ? "当前允许任意线路上传运行日志" : "当前策略尚未读取";
          const caption = networkEntry.querySelector("small");
          if (caption) caption.textContent = `${label}；查看并调整上传策略`;
        }
      }
    }
  }
  let previousFocus = null;
  let activeDialogRequest = null;
  /* 弹层栈：每层保住自己的 DOM、焦点和滚动位置，原生返回一次只退一层，不退 App。
     关闭只摘最上面那一层；下面那层（例如详情弹层里再开的选择器）继续活着。 */
  const dialogFrames = [];
  /* 栈顶那层才是当前可交互的一层：焦点约束、原生返回、可访问性都跟着栈顶走，不再取第一层。 */
  function topDialog() { const frame = dialogFrames[dialogFrames.length - 1]; return frame?.overlay.querySelector(".dialog,.moon-dialog") || null; }
  function hasDialog() { return dialogFrames.length > 0 || Boolean($("#dialog-host .dialog")); }
  function syncDialogAria() {
    const top = dialogFrames[dialogFrames.length - 1];
    for (const frame of dialogFrames) {
      const section = frame.overlay.querySelector(".dialog,.moon-dialog");
      if (!section) continue;
      if (frame === top) section.removeAttribute("aria-hidden"); else section.setAttribute("aria-hidden", "true");
    }
  }
  function closeDialog() {
    activeDialogRequest?.abort(); activeDialogRequest = null;
    const frame = dialogFrames.pop();
    if (frame) {
      if (backgroundSettingsPending?.overlay === frame.overlay) invalidateBackgroundSettings();
      /* 关掉的若正是当前子层，栈也要一起弹：只摘 DOM 而留下 layer 会让下一次重绘
         把整份草稿栈当成已断开而重置，父卡跟着消失。 */
      if (topMoonLayer() && topMoonLayer().overlay === frame.overlay) moonLayers.pop();
      frame.overlay.remove();
      for (const input of frame.sensitiveInputs || []) input.value = "";
      frame.onClose?.();
      if (sheet && !sheet.overlay.isConnected) sheet = null;
      if (!dialogFrames.length) {
        state.egressEditing = false;
        main.style.overflow = "";
        const form = $("#add-account-form"); if (form) form.reset();
      }
      syncDialogAria();
      if (frame.previousFocus?.isConnected) frame.previousFocus.focus();
      /* 弹层开着时页面不重画（避免换掉用户正点的节点），但弹层里等到的真实状态
         要在关掉这一层后立刻落到卡片上，不能等下一次轮询。 */
      if (!dialogFrames.length) renderIfIdle();
      return;
    }
    $("#dialog-host").replaceChildren();
    sheet = null;
    main.style.overflow = "";
    const form = $("#add-account-form"); if (form) form.reset();
    if (previousFocus?.isConnected) previousFocus.focus();
    renderIfIdle();
  }
  function closeAllDialogs() { while (dialogFrames.length) closeDialog(); resetSheetState(); }
  /* 弹层固定标题/关闭与底部操作，中间只有一个内容滚动层。 */
  function showDialog(title, body, footer = "", kind = "", onClose = null) {
    invalidateBackgroundSettings();
    activeDialogRequest?.abort(); activeDialogRequest = null;
    const host = $("#dialog-host");
    const html = window.MoonUI?.formalHTML ? window.MoonUI.formalHTML({ title, body, footer, kind, index: dialogFrames.length + 1 }) : `<div class="dialog-overlay"><section class="dialog${kind ? ` ${kind}` : ""}" role="dialog" aria-modal="true" aria-labelledby="dialog-title-${dialogFrames.length + 1}"><div class="dialog-head"><h2 id="dialog-title-${dialogFrames.length + 1}">${esc(title)}</h2><button class="icon-button" type="button" data-action="close-dialog" aria-label="关闭">${icon("close")}</button></div><div class="dialog-body">${body}</div>${footer}</section></div>`;
    host.insertAdjacentHTML("beforeend", html);
    const overlay = host.lastElementChild;
    dialogFrames.push({ overlay, previousFocus: document.activeElement, onClose, viewContext: accountChoiceContext(),
      sensitiveInputs: [...overlay.querySelectorAll('input[type="password"]')] });
    previousFocus = dialogFrames[0].previousFocus;
    main.style.overflow = "hidden";
    syncDialogAria();
    window.setTimeout(() => overlay.querySelector("input, button:not([data-action=close-dialog])")?.focus({ preventScroll: true }), 0);
    return overlay;
  }
  /* 原型的弹层自带遮罩与卡片结构，仍挂进同一个弹层栈：栈顶、焦点归还、原生返回逐层退沿用现有规则。 */
  function showMoonSheet(html, onClose = null) {
    invalidateBackgroundSettings();
    activeDialogRequest?.abort(); activeDialogRequest = null;
    const hostEl = $("#dialog-host");
    hostEl.insertAdjacentHTML("beforeend", html);
    const overlay = hostEl.lastElementChild;
    dialogFrames.push({ overlay, previousFocus: document.activeElement, onClose, viewContext: accountChoiceContext() });
    previousFocus = dialogFrames[0].previousFocus;
    main.style.overflow = "hidden";
    syncDialogAria();
    window.setTimeout(() => (overlay.querySelector("input") || overlay.querySelector("button:not([data-action=close-panel])"))?.focus({ preventScroll: true }), 0);
    return overlay;
  }
  /* Action feedback is a read-only dialog frame, separate from the configuration layer stack.
     Keep its exact opening identity so a retry can read facts without borrowing the sheet below. */
  function showMoonFeedback(id, onClose = null) {
    if (!window.MoonUI?.sheetHTML || !DETAILS[id]?.moon || DETAILS[id].config) return null;
    const overlay = showMoonSheet(window.MoonUI.sheetHTML(id, dialogFrames.length + 1), onClose);
    const frame = dialogFrames.at(-1);
    frame.moonFeedback = Object.freeze({ id, overlay, context: Object.freeze({ ...frame.viewContext }) });
    return overlay;
  }
  function topMoonFeedback(overlay = null) {
    const frame = dialogFrames.at(-1), feedback = frame?.moonFeedback;
    return feedback && frame.overlay.isConnected && feedback.overlay === frame.overlay
      && (!overlay || overlay === frame.overlay) ? feedback : null;
  }
  function moonFeedbackProblem(feedback) {
    if (!feedback || topMoonFeedback(feedback.overlay) !== feedback) return "这层反馈已不在最上面，请返回当前页面后重新读取。";
    const context = feedback.context;
    if (!sameReadContext(context)) return "手机服务连接或软件身份已变化，请关闭这层反馈后重新读取。";
    if (context.tab !== state.tab || context.selectedId !== String(state.selectedId) || context.logsScope !== state.logsScope)
      return "当前查看对象已变化，请关闭这层反馈后重新读取。";
    return "";
  }
  function rerenderMoonFeedback(feedback) {
    if (moonFeedbackProblem(feedback)) return false;
    const scroll = feedback.overlay.querySelector(".panel-scroll");
    if (!scroll || scroll.querySelector('form,input,textarea,select,[contenteditable="true"]')) return false;
    const html = window.MoonUI?.fieldsHTML?.(feedback.id);
    if (typeof html !== "string" || moonFeedbackProblem(feedback)) return false;
    const keep = scroll.scrollTop, signature = focusSignature(document.activeElement);
    scroll.innerHTML = html; scroll.scrollTop = keep;
    if (!moonFeedbackProblem(feedback)) restoreFocus(feedback.overlay, signature);
    return true;
  }
  function navigateMoonSettings(source, { land = false } = {}) {
    const overlay = source?.closest?.(".sheet-scrim,.dialog-overlay"), frame = dialogFrames.at(-1);
    if (!source?.isConnected || !overlay || frame?.overlay !== overlay) {
      toast("这层入口已不在最上面，请返回当前页面后重新选择。"); return false;
    }
    const feedback = frame.moonFeedback;
    const intent = { context: feedback?.context || frame.viewContext, targetId: String(state.selectedId) };
    const problem = (feedback ? moonFeedbackProblem(feedback) : "") || navigationIntentProblem(intent);
    if (problem) { toast(problem); return false; }
    // Close only the owned source layer. A same-account settings navigation can then safely
    // return early without leaving this feedback above the page or discarding a lower draft.
    closeTopDialog();
    const afterProblem = navigationIntentProblem(intent);
    if (afterProblem) { toast(afterProblem); return false; }
    if (land) { state.settingsTab = "land"; render(); main.scrollTop = 0; }
    void changeTab("settings", intent.targetId, intent);
    return true;
  }
  /* 月色详情层：打开时深拷贝子草稿，「完成」只合本卡 paths，取消/✕/返回整份丢弃；
     只读层 paths 为空、也不强依赖已读到的配置草稿（账号页会清空 draft）。 */
  function openMoonPanel(id) {
    const spec = DETAILS[id];
    if (!spec) return false;
    if (spec.config && !state.draft) { toast("这个账号的设置还没读到，连上手机运行服务后再改。"); return false; }
    resetSheetState();
    sheet = makeConfigLayer(id,spec);
    if(!sheet)return false;
    sheet.overlay = showMoonSheet(window.MoonUI.sheetHTML(id, 1));
    bindNativeServiceReadLayer(sheet.overlay, id);
    const apply = sheet.overlay.querySelector('[data-panel-action="apply"]');
    if (apply) apply.disabled = (sheet.spec.paths || []).length>0 && !layerMergeStatus(sheet).ok;
    updateDraftTransactionUI();
    return true;
  }
  /* 子层：进入时再拷一份，完成只合这一层的 paths 到下层；取消/返回整份丢弃。 */
  function pushMoonLayer(id) {
    const spec = DETAILS[id];
    if (!spec) return false;
    if (!currentSheet()) return openMoonPanel(id);
    const layer = makeConfigLayer(id,spec);
    if(!layer)return false;
    moonLayers.push(layer);
    layer.overlay = showMoonSheet(window.MoonUI.sheetHTML(id, moonLayers.length + 1));
    bindNativeServiceReadLayer(layer.overlay, id);
    const apply = layer.overlay.querySelector('[data-panel-action="apply"]');
    if (apply) apply.disabled = (layer.spec.paths || []).length>0 && !layerMergeStatus(layer).ok;
    updateDraftTransactionUI();
    return true;
  }
  function dialogActions(...buttons) { return `<div class="dialog-actions">${buttons.join("")}</div>`; }
  function showConfirm(title,copy,actionLabel,callback) {
    showDialog(title, `<p class="dialog-intro">${esc(copy)}</p>`, dialogActions(
      `<button id="confirm-cancel" class="button secondary" type="button">${title === "设置还没有保存" ? "继续编辑" : "取消"}</button>`,
      `<button id="confirm-accept" class="button primary-button" type="button">${esc(actionLabel)}</button>`));
    $("#confirm-cancel").addEventListener("click",closeDialog);
    $("#confirm-accept").addEventListener("click",() => {closeDialog();callback();});
  }
  /* 搜索 + 多选弹层 + 选中反馈（沿用安卓面板既有 dialog 与 flower-grid 样式）。
     已选置顶、按目录顺序保存（两台手机选出同一份），点一下选上、再点一下取消。 */
  function openMultiPicker(key,sourceNode=null) {
    let draftTarget=captureDraftTarget(sourceNode);
    if(!validateDraftTarget(draftTarget,{notify:true}).ok)return;
    const spec = PICKERS[key];
    if (!spec || pickerDisabled(key)) return;
    const choices = pickerChoices(spec.source);
    if (!choices.length) { toast(spec.source === "qualities" ? "品质目录还没读到，连上手机运行服务后再选。 " : "花种目录还没读到，连上手机运行服务后再选。 "); return; }
    const chosen = new Set((getPath(draftTarget.draft,key) || []).map(String));
    const overlay=showDialog(spec.title, `
      ${spec.searchable ? '<input class="search" id="picker-search" type="search" aria-label="搜索花名" placeholder="搜索花种名称" enterkeyhint="search">' : ""}
      <p class="picker-count" id="picker-count">已选 ${chosen.size} 项</p>
      <div class="flower-grid" id="picker-results"></div>`, dialogActions(
      '<button class="button secondary" type="button" data-action="close-dialog">不存，关掉</button>',
      '<button class="button primary-button" type="button" id="picker-save">保存</button>'), "picker-dialog");
    const frame=dialogFrames.find(one=>one.overlay===overlay);
    if(!registerDraftPicker(overlay,draftTarget,next=>{draftTarget=next;return true;})){closeDialog();toast("原设置归属已变化，请返回设置后重新选择。");return;}
    const grid = overlay.querySelector("#picker-results");
    const renderGrid = () => {
      const term = (overlay.querySelector("#picker-search")?.value || "").trim().toLocaleLowerCase();
      const onTop = choices.filter(one => chosen.has(String(one.id)));
      const rest = choices.filter(one => !chosen.has(String(one.id)) && (!term || `${one.label} ${one.quality ? qualityName(one.quality) : ""}`.toLocaleLowerCase().includes(term)));
      const card = one => {
        const on = chosen.has(String(one.id));
        const tail = one.quality ? qualityName(one.quality) : "";
        return `<label class="flower-option ${on ? "is-selected" : ""}"><input type="checkbox" data-pick="${esc(one.id)}" ${on ? "checked" : ""}><span><strong>${esc(one.label)}</strong>${tail ? `<small>${esc(tail)}</small>` : ""}</span></label>`;
      };
      const total = onTop.length + rest.length;
      grid.innerHTML = total
        ? `${onTop.length ? '<p class="group-title">已选</p>' + onTop.map(card).join("") : ""}<p class="group-title">可选项</p>${rest.map(card).join("")}`
        : '<p class="small muted">没有找到匹配项，换个关键词试试。</p>';
      overlay.querySelector("#picker-count").textContent = `已选 ${chosen.size} 项`;
    };
    renderGrid();
    grid.addEventListener("change", event => {
      const id = event.target.dataset?.pick; if (id === undefined) return;
      if (event.target.checked) chosen.add(id); else chosen.delete(id);
      renderGrid();
    });
    overlay.querySelector("#picker-search")?.addEventListener("input", renderGrid);
    overlay.querySelector("#picker-save").addEventListener("click", () => {
      if(!overlay.isConnected || dialogFrames.at(-1)!==frame)return;
      const known=new Set(choices.map(one=>String(one.id)));
      const saved=[...choices.filter(one=>chosen.has(String(one.id))).map(one=>String(one.id)),...[...chosen].filter(id=>!known.has(id))];
      if(!applyDraftValue(draftTarget,key,saved,{merge:true}))return;
      updateDirty(); closeDialog(); if (!renderSheet()) render();
    });
  }
  function addAccountDialog() {
    if (!state.online) { toast("请先连接手机运行服务。 "); return; }
    showDialog("添加游戏号", `<p class="dialog-intro">添加时会使用填写的账号密码登录游戏一次，核对成功后保存；区服由游戏服务器确认，无需手选。</p><form id="add-account-form"><label class="field"><span>游戏账号</span><input name="username" type="text" autocomplete="username" enterkeyhint="next" required maxlength="160" placeholder="输入官服登录账号"></label><label class="field"><span>登录密码</span><input name="password" type="password" autocomplete="current-password" enterkeyhint="done" required maxlength="256" placeholder="输入游戏登录密码"></label><label class="field"><span>账号备注</span><input name="nickname" type="text" maxlength="40" placeholder="方便自己识别，选填"></label><div id="account-error" class="form-error" role="alert" hidden></div><p class="small muted">核对期间请等待。只添加你有权使用的账号。密码不会显示在账号列表或运行日志中。</p><div class="panel-note"><strong>账号资料保护</strong>游戏凭据保存在本机受保护存储中，不会因为添加账号自动开始任务。</div></form>`, dialogActions(
      '<button class="button secondary" type="button" data-action="close-dialog">先不添加</button>',
      '<button class="button primary-button" type="submit" form="add-account-form" id="add-account-save">登录核对并保存</button>'));
    $("#add-account-form").addEventListener("submit",async event => {
      event.preventDefault(); const form = event.currentTarget;
      if (!form.reportValidity()) return;
      const fields = new FormData(form);
      const body = {username:String(fields.get("username") || "").trim(),password:String(fields.get("password") || "")};
      if (!body.username || !body.password) return;
      const nickname = String(fields.get("nickname") || "").trim();
      if (nickname) { body.nickname = nickname; body.remark = nickname; }
      const submit = $("#add-account-save"); if (!submit) return;
      submit.disabled = true; submit.textContent = "正在登录游戏核对…";
      const requestController = new AbortController();
      const operation = beginPanelOperation("add", "add-account-verifying", "正在登录官服核对游戏身份；成功后才保存到手机。");
      operation.onDismiss = () => { const password = form.elements.namedItem("password"); if (password) password.value = ""; };
      showPanelProgress(operation, "add-account-verifying");
      activeDialogRequest = requestController;
      $("#account-error").hidden = true;
      let accepted = false;
      try {
        // Official login takes tens of seconds; the default 25s budget would abort a healthy check.
        const result = await api("/accounts",{method:"POST",body,timeoutMs:130000,signal:requestController.signal});
        accepted = true;
        if (!currentPanelOperation(operation)) return;
        if (requestController.signal.aborted || !form.isConnected) throw localFailure("添加核对已关闭，请先查看名册与记录，再判断结果。", "ADD_RESULT_UNKNOWN");
        if (activeDialogRequest === requestController) activeDialogRequest = null;
        const id = result.account?.id ?? result.id;
        const roster = await api("/accounts");
        if (!currentPanelOperation(operation)) return;
        const addedAccount = Array.isArray(roster?.accounts) ? roster.accounts.find(one => sameId(one.id, id)) : null;
        if (id === undefined || !addedAccount) {
          throw localFailure("添加结果尚未在本机名册读回，请先核对，不会自动重新添加。", "ADD_READBACK_MISMATCH");
        }
        state.accounts = roster.accounts; state.accountsReadState = "ready"; state.accountsError = "";
        const verified = result.verify?.attempted === true && result.verify?.ok === true;
        const partial = verified && Array.isArray(result.verify.missing) && result.verify.missing.length > 0;
        const feedbackId = verified ? partial ? "add-account-partial" : "add-account-success" : "add-account-unverified";
        recordPanelOperation(operation, verified ? "success" : "unknown", verified
          ? partial ? "官服身份已核对，且已读回本机名册；部分附加状态未取得，不推定为零。" : "官服身份已核对，且已读回本机名册；尚未开始任何运行安排。"
          : "已读回本机名册，但本次返回没有完整的官服身份核对证据。", 1, undefined, {
            identityVerified: verified, rosterReadBack: true,
            // A missing official nickname is persisted using the optional user remark. Do not
            // mislabel that fallback (or the masked login name) as a verified game identity.
            verifiedNickname: verified && Array.isArray(result.verify?.missing) && !result.verify.missing.includes("昵称") ? result.account?.nickname : undefined,
            verifiedServer: verified ? result.account?.serverName : undefined,
            missing: result.verify?.missing,
            running: addedAccount.running, desiredRunning: addedAccount.desiredRunning,
          }, [body.username, body.password]);
        if (!operation.dismissed && dialogFrames[dialogFrames.length - 1]?.overlay === operation.overlay) {
          operation.replacing = true; closeDialog(); operation.replacing = false;
          if (form.isConnected && topDialog()?.contains(form)) { form.reset(); closeDialog(); }
          await changeTab("settings", id);
          if (currentPanelOperation(operation) && !hasDialog() && state.tab === "settings" && sameId(state.selectedId,id)) {
            showMoonFeedback(feedbackId);
          }
        }
      } catch (error) {
        if (!currentPanelOperation(operation)) return;
        if (activeDialogRequest === requestController) activeDialogRequest = null;
        const unknown = accepted || requestController.signal.aborted || uncertainOperation(error);
        const message = unknown ? "本次添加结果尚未确认，请先查看名册和添加记录，不要重复添加。" : safeError(error,"这次没登进去，账号没有保存。");
        const diagnostic = error.diagnostic;
        recordPanelOperation(operation, unknown ? "unknown" : "error", message, undefined, undefined, {
          code: diagnostic?.code || error.code, summary: diagnostic?.summary,
          loginCode: diagnostic?.loginCode, loginCodeKey: diagnostic?.loginCodeKey,
          serverMsgCode: diagnostic?.serverMsgCode, serverMsgKey: diagnostic?.serverMsgKey,
          remoteCode: diagnostic?.remoteCode, httpStatus: diagnostic?.httpStatus,
          officialMessage: diagnostic?.officialMessage,
          redacted: diagnostic?.redacted, truncated: diagnostic?.truncated,
        }, [body.username, body.password]);
        finishPanelFeedback(operation, "add-account-error");
        if (form.isConnected) {
          form.elements.namedItem("password").value = "";
          const area = $("#account-error");
          area.replaceChildren();
          const explanation = document.createElement("p"); explanation.textContent = message; area.append(explanation);
          const logsButton = document.createElement("button"); logsButton.type = "button"; logsButton.className = "text-button"; logsButton.dataset.action = "device-logs"; logsButton.textContent = "查看本机 / 添加记录"; area.append(logsButton); area.hidden = false;
        }
      } finally {
        body.password = "";
        if (activeDialogRequest === requestController) activeDialogRequest = null;
        if (submit.isConnected) { submit.disabled = false; submit.textContent = "登录核对并保存"; }
      }
    });
  }
  let removeRequest = null;
  function removeAccountDialog(id) {
    readNativeEngineState();
    if (removeRequest) { toast("已有移除操作正在等待读回，请先核对这次结果，不会重复提交。"); return; }
    const targetId = String(id ?? "");
    if (!targetId) { toast("没有指定要移除的游戏号，请返回列表重新选择。"); return; }
    const context = accountChoiceContext();
    const intent = { context, targetId };
    const problem = navigationIntentProblem(intent);
    if (problem || !state.online) { toast(problem || "请先连接手机运行服务后重新读取名册。"); return; }
    const target = state.accounts.find(account => sameId(account.id, targetId));
    if (!target) { toast("当前名册中找不到这个游戏号，请重新读取后再选择。"); return; }
    const displayName = account => accountName(account).trim() || `游戏号 #${targetId}`;
    const name = displayName(target);
    const overlay = showDialog("移除这个游戏号", `<p class="dialog-intro">要把「${esc(name)}」从这台手机上移除吗？账号密码、设置和运行安排会从本机移除，历史操作记录单独保留。</p><p class="field-error" role="alert" hidden></p>`, dialogActions(
      '<button class="button secondary" type="button" data-action="close-dialog">先不删</button>',
      '<button class="button danger" type="button" id="confirm-remove">确认移除</button>'));
    const button = overlay.querySelector("#confirm-remove");
    button.addEventListener("click",async () => {
      readNativeEngineState();
      if (button.disabled || !overlay.isConnected || dialogFrames[dialogFrames.length - 1]?.overlay !== overlay) return;
      const currentTarget = state.accounts.find(account => sameId(account.id, targetId));
      const stale = navigationIntentProblem(intent) || (removeRequest ? "已有移除操作正在等待读回，本次没有重复提交。" : "")
        || (!state.online ? "手机服务连接尚未核对，本次移除没有提交，请重新连接后确认。" : "")
        || (!currentTarget ? "这个游戏号已不在当前名册中，本次移除没有提交。" : displayName(currentTarget) !== name ? "这个游戏号的名称已经更新，请关闭后重新核对移除对象。" : "");
      if (stale) {
        const error = overlay.querySelector(".field-error"); error.textContent = stale; error.hidden = false; button.disabled = true; return;
      }
      button.disabled = true; button.textContent = "正在移除…";
      // Roster operations belong to the software user. The removed ID is only used for this readback;
      // no other selected account can be mistaken for the deletion target.
      const operation = beginPanelOperation("remove", "remove-account-busy", "正在移除所指定的本机游戏号，历史记录继续保留。");
      const request = { context, targetId, operation }; removeRequest = request;
      const formOverlay = overlay;
      let accepted = false;
      try {
        showPanelProgress(operation, "remove-account-busy");
        await api(`/accounts/${encodeURIComponent(targetId)}`,{method:"DELETE",timeoutMs:40000,expectedContext:context});
        accepted = true;
        if (!currentPanelOperation(operation)) return;
        const roster = await api("/accounts",{expectedContext:context});
        if (!currentPanelOperation(operation)) return;
        if (!Array.isArray(roster?.accounts) || roster.accounts.some(one => sameId(one.id,targetId))) throw localFailure("名册中的移除结果尚未确认，请先重新读取。", "REMOVE_READBACK_MISMATCH");
        recordPanelOperation(operation, "success", "已读回名册，所指定的游戏号已从本机移除；历史记录和未确认操作继续保留。", 1);
        if (!operation.dismissed && dialogFrames[dialogFrames.length - 1]?.overlay === operation.overlay) {
          operation.replacing = true; closeDialog(); operation.replacing = false;
          if (dialogFrames[dialogFrames.length - 1]?.overlay === formOverlay) closeDialog();
          await refreshForAction();
          if (currentPanelOperation(operation) && !hasDialog()) showMoonFeedback("remove-account-success");
        } else await refreshForAction();
      } catch (error) {
        if (!currentPanelOperation(operation)) return;
        recordPanelOperation(operation, accepted || uncertainOperation(error) ? "unknown" : "error", safeError(error,"本次移除结果尚未确认，请先重新读取名册。"));
        finishPanelFeedback(operation, "remove-account-error");
        if (button.isConnected) { button.disabled = false; button.textContent = "确认移除"; }
      } finally {
        if (removeRequest === request) removeRequest = null;
      }
    });
  }
  function releaseBackgroundSettingsPending(pending) {
    window.clearTimeout(pending?.timer);
    if (pending?.button?.isConnected) { pending.button.disabled = pending.wasDisabled; pending.button.innerHTML = pending.html; }
    if (backgroundSettingsPending === pending) backgroundSettingsPending = null;
  }
  function invalidateBackgroundSettings(clearResult = false) {
    const pending = backgroundSettingsPending;
    if (pending) releaseBackgroundSettingsPending(pending);
    if (clearResult || pending && state.backgroundSettings?.requestId === pending.request.requestId
      && state.backgroundSettings.status === "pending") state.backgroundSettings = null;
  }
  function sameBackgroundSettingsContext(pending) {
    if (!pending || backgroundSettingsPending !== pending || pending.authEpoch !== backgroundAuthEpoch || pendingAuthHandoff
      || pending.request.pageNonce !== backgroundPageNonce || pending.request.softwareUserId !== softwareUserId()
      || pending.signedIn !== softwareInfo()?.signedIn || pending.request.engineGeneration !== state.engine.generation
      || pending.request.engineInstance !== state.engine.instanceId) return false;
    return pending.overlay ? pending.overlay.isConnected && dialogFrames.at(-1)?.overlay === pending.overlay
      : !hasDialog() && pending.tab === state.tab;
  }
  function validBackgroundSettingsResult(result, request) {
    if (!result || typeof result !== "object" || Array.isArray(result)) return false;
    const keys = ["schemaVersion", "requestId", "pageNonce", "softwareUserId", "engineGeneration", "engineInstance", "result", "target", "attempts", "reason"];
    if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))
      || Object.keys(request).some(key => result[key] !== request[key]) || !Array.isArray(result.attempts)
      || ![1, 2].includes(result.attempts.length)) return false;
    const targets = ["battery-request", "app-details"], reasons = ["activity-not-found", "security-denied", "launch-failed"];
    if (result.attempts.some(attempt => !attempt || typeof attempt !== "object" || Array.isArray(attempt)
      || Object.keys(attempt).length !== 3 || !["target", "result", "reason"].every(key => Object.hasOwn(attempt, key))
      || !targets.includes(attempt.target) || !["intent-accepted", "failed"].includes(attempt.result)
      || (attempt.result === "intent-accepted" ? attempt.reason !== null : !reasons.includes(attempt.reason)))) return false;
    const first = result.attempts[0], last = result.attempts.at(-1);
    const directDetails = result.attempts.length === 1 && first.target === "app-details";
    if (result.attempts.length === 2 && (first.target !== "battery-request" || first.result !== "failed" || last.target !== "app-details")) return false;
    if (result.result === "intent-accepted") return result.reason === null
      && result.target === last.target && last.result === "intent-accepted";
    return result.result === "failed" && result.target === null && result.reason === "all-intents-failed"
      && (result.attempts.length === 2 || directDetails) && result.attempts.every(attempt => attempt.result === "failed");
  }
  function finishBackgroundSettings(pending, outcome) {
    if (!sameBackgroundSettingsContext(pending)) { if (backgroundSettingsPending === pending) invalidateBackgroundSettings(); return; }
    releaseBackgroundSettingsPending(pending);
    state.backgroundSettings = { ...pending.request, ...outcome, at: new Date().toISOString() };
    const device = bridgeCall("deviceInfo");
    if (device && typeof device === "object") state.device = device;
    const id = outcome.status === "intent-accepted" ? "background-open-result" : "background-settings-error";
    if (window.MoonUI?.sheetHTML) showMoonFeedback(id);
    else showDialog(outcome.status === "intent-accepted" ? "系统已受理打开请求" : "系统设置打开结果", '<p class="dialog-intro">请从手机设置进入无尽夏，查看通知、电池和后台活动。返回后重新读取权限，以实际结果为准。</p>',
      dialogActions('<button class="button primary-button" type="button" data-action="close-dialog">知道了</button>'));
  }
  window.onGardenBackgroundSettingsResult = result => {
    const pending = backgroundSettingsPending;
    if (!pending || !validBackgroundSettingsResult(result, pending.request)) return;
    readNativeEngineState();
    if (!sameBackgroundSettingsContext(pending)) return;
    finishBackgroundSettings(pending, { status: result.result, target: result.target, reason: result.reason,
      attempts: result.attempts.map(attempt => ({ ...attempt })), source: "native-callback" });
  };
  function openBackgroundSettings(button = null) {
    const overlay = button?.closest?.(".sheet-scrim,.dialog-overlay") || null;
    if (!button?.isConnected || (overlay ? dialogFrames.at(-1)?.overlay !== overlay : hasDialog())) return;
    readNativeEngineState();
    if (backgroundSettingsPending && sameBackgroundSettingsContext(backgroundSettingsPending)) return;
    invalidateBackgroundSettings();
    const request = { schemaVersion: 1, requestId: randomRequestHex(), pageNonce: backgroundPageNonce,
      softwareUserId: softwareUserId(), engineGeneration: state.engine.generation, engineInstance: state.engine.instanceId };
    const pending = { request, overlay, button, html: button.innerHTML, wasDisabled: button.disabled,
      signedIn: softwareInfo()?.signedIn, authEpoch: backgroundAuthEpoch, tab: state.tab, timer: null };
    backgroundSettingsPending = pending;
    if (!sameBackgroundSettingsContext(pending)) { invalidateBackgroundSettings(); return; }
    const json = JSON.stringify(request);
    if (!/^[0-9a-f]{32}$/.test(request.requestId) || !/^[0-9a-f]{32}$/.test(request.pageNonce)
      || !/^(?:|[1-9][0-9]{0,18})$/.test(request.softwareUserId) || !Number.isSafeInteger(request.engineGeneration)
      || typeof request.engineInstance !== "string" || json.length > 1024) {
      finishBackgroundSettings(pending, { status: "failed", source: "javascript", reason: "request-context-unavailable", target: null, attempts: [] }); return;
    }
    const bridge = window.AndroidBridge;
    if (!bridge || typeof bridge.requestBackgroundSettings !== "function") {
      finishBackgroundSettings(pending, { status: "failed", source: "javascript", reason: "bridge-unavailable", target: null, attempts: [] }); return;
    }
    state.backgroundSettings = { ...request, status: "pending", at: new Date().toISOString() };
    button.disabled = true; button.textContent = "正在请求系统设置…";
    pending.timer = window.setTimeout(() => finishBackgroundSettings(pending, {
      status: "unknown", source: "javascript", reason: "callback-timeout", target: null, attempts: [],
    }), 10000);
    // bridgeCall intentionally takes no arguments. Pass this validated JSON explicitly; a void
    // return is never launch evidence, and the legacy no-callback bridge is not a success fallback.
    try { bridge.requestBackgroundSettings(json); }
    catch { finishBackgroundSettings(pending, { status: "unknown", source: "javascript", reason: "bridge-call-unconfirmed", target: null, attempts: [] }); }
  }
  /* 保活入口只负责把请求交给本机；结果以返回后的实际读数为准，
     打开设置页本身不算权限已允许。 */
  function openKeepAliveSettings(kind) {
    const bridge = window.AndroidBridge;
    const method = kind === "manufacturer" ? "openManufacturerSettings" : kind === "exact-alarm" ? "openExactAlarmSettings" : "";
    if (!method || !bridge || typeof bridge[method] !== "function") { toast("这个入口不在当前本机页面里，请更新 App 后再试。"); return; }
    try { bridge[method](); }
    catch { toast("系统设置未能打开，可从手机设置手动进入。"); return; }
    toast(kind === "manufacturer"
      ? "已请求打开厂家后台设置；自启动开关需你手动确认，返回后按实际读数显示。"
      : "已请求打开精确闹钟授权页；返回后按实际读数显示。");
  }
  function setKeepAliveVpn(enabled, facts = {}) {
    const bridge = window.AndroidBridge;
    if (!bridge || typeof bridge.setKeepAliveVpn !== "function") { toast("这个入口不在当前本机页面里，请更新 App 后再试。"); return; }
    try { bridge.setKeepAliveVpn(Boolean(enabled)); }
    catch { toast(enabled ? "VPN 增强未能提交。" : "关闭 VPN 增强未能提交。"); return; }
    toast(!enabled ? "已请求关闭 VPN 增强。"
      : facts.vpnEnabled === true ? "正在重新建立 VPN 增强连接…" : "正在请求系统 VPN 授权…");
  }
  window.onGardenKeepAliveResult = result => {
    if (!result || typeof result !== "object" || Array.isArray(result)) return;
    const device = bridgeCall("deviceInfo");
    if (device && typeof device === "object") state.device = device;
    toast(result.result === "intent-accepted" ? "系统已受理打开请求；返回后按实际读数显示。"
      : "系统设置未能打开，可从手机设置手动进入。");
  };
  function restartNativeEngine() {
    if (window.AndroidBridge && typeof window.AndroidBridge.restartEngine === "function") {
      try {
        // Gate the form synchronously, before the asynchronous native restart can
        // clear its token and before any polling response can repaint old ownership.
        applyEngineState({ generation: state.engine.generation + 1, phase: "stopping", instanceId: "", message: "正在重新连接手机运行服务，身份与游戏号就绪后即可登录。" });
        window.AndroidBridge.restartEngine(); toast("正在重新连接手机运行服务…"); return;
      } catch { /* fall back to the manual hint */ }
    }
    toast("请重新打开 App，让本机执行器按新的软件账号重新连接。");
  }
  async function softwareCall(path, { body = {}, busy = "正在处理…", done = "已完成。" } = {}) {
    if (state.authBusy || !engineReady()) return;
    const family = ({ "/software/license": "license", "/software/logs": "sync", "/software/claim": "ownership", "/software/logout": "logout" })[path];
    if (!family) return;
    const pendingId = PANEL_FAMILIES[family][0];
    const operation = beginPanelOperation(family, pendingId, busy);
    state.authBusy = true;
    showPanelProgress(operation, pendingId);
    try {
      const result = await api(path, { method: "POST", body, timeoutMs: 30000 });
      if (!currentPanelOperation(operation)) return;
      const info = await api("/software/status");
      if (!currentPanelOperation(operation)) return;
      if (!info || typeof info !== "object") throw localFailure("软件状态暂未读回，请核对实际结果。", "SOFTWARE_READBACK_MISSING");
      if (family === "logout") {
        if (info.signedIn !== false) throw localFailure("退出结果尚未确认，请重新读取当前身份。", "LOGOUT_READBACK_MISMATCH");
        recordPanelOperation(operation, "success", "已读回退出状态，本机资料和未确认记录继续保留。");
        finishPanelFeedback(operation, null);
        adoptSoftwareInfo(info);
      } else {
        if (String(info.user?.id ?? "") !== operation.softwareUserId) throw localFailure("软件身份已变化，旧操作结果没有应用。", "LOCAL_REQUEST_STALE");
        adoptSoftwareInfo(info);
        if (family === "ownership") {
          const empty = result.moved === 0 && info.claimRequired === false;
          const confirmed = info.claim?.status === "confirmed" && String(info.claim.confirmedUserId ?? "") === operation.softwareUserId;
          if (!empty && !confirmed) throw localFailure("资料归属结果尚未确认，请重新读取。", "CLAIM_READBACK_MISMATCH");
          const count = typeof result.moved === "number" && Number.isFinite(result.moved) ? result.moved : undefined;
          recordPanelOperation(operation, "success", empty ? "本机没有待确认的历史资料。" : `已读回归属确认${count === undefined ? "" : `，本次归属 ${count} 个游戏号`}；不会自动开始运行。`, count);
          finishPanelFeedback(operation, empty ? "data-ownership-empty" : "data-ownership-success");
        } else if (family === "sync") {
          const sent = typeof result.sent === "number" && Number.isInteger(result.sent) && result.sent >= 0 ? result.sent : null;
          const accepted = typeof result.accepted === "number" && Number.isInteger(result.accepted) ? result.accepted : null;
          const duplicates = typeof result.duplicates === "number" && Number.isInteger(result.duplicates) ? result.duplicates : null;
          const rejected = typeof result.rejected === "number" && Number.isInteger(result.rejected) ? result.rejected : null;
          if (sent > 0 && accepted !== null && duplicates !== null && rejected === 0 && accepted + duplicates === sent) {
            recordPanelOperation(operation, "success", `本次 ${sent} 条记录已获得服务器确认；不代表全部队列已清空。`, sent);
            finishPanelFeedback(operation, "sync-success");
          } else if (sent === 0 && result.reason === "empty" && info.queue?.pending === 0) {
            recordPanelOperation(operation, "success", "本次没有待传记录，没有制造新的上传结果。", 0);
            finishPanelFeedback(operation, "sync-empty");
          } else {
            const reasons = { wifi_only: "当前上传策略正在等待 Wi-Fi，记录仍保留在本机。", cooldown: "本次发送额度尚未到，记录仍在队列中。", not_due: "本次尚未到上传时间，记录仍在队列中。", signed_out: "软件身份已退出，本次未发送记录。", session_changed: "软件身份已经变化，本次结果需重新核对。", session_renewed: "软件会话已续期，本次没有重发日志。" };
            const message = rejected > 0 ? `本次有 ${rejected} 条记录未获接收，已确认与未确认的记录分别保留。`
              : reasons[result.reason] || "本次同步没有取得完整确认，队列仍保留，请查看实际状态。";
            recordPanelOperation(operation, rejected > 0 ? "error" : "unknown", message,
              accepted !== null && duplicates !== null ? accepted + duplicates : undefined);
            finishPanelFeedback(operation, "sync-error");
          }
        } else {
          const known = typeof info.authorized === "boolean" && typeof info.licenseState === "string";
          recordPanelOperation(operation, known ? (info.authorized ? "success" : "error") : "unknown",
            known ? licenseLine() : "授权核对请求已返回，当前资格尚未完整读回。");
          finishPanelFeedback(operation, known ? "license" : "license-error");
        }
      }
      if (result?.requiresEngineRestart === true) { restartNativeEngine(); return; }
    } catch (error) {
      const panel = ({ license: "license-error", sync: "sync-error", ownership: "data-ownership-error", logout: "logout-error" })[family];
      if (recordPanelOperation(operation, uncertainOperation(error) ? "unknown" : "error", safeError(error, "本次操作结果尚未确认，请先重新读取；不会自动重复提交。"))) finishPanelFeedback(operation, panel);
    }
    finally {
      if (panelOperations.get(operation.family) === operation && operation.generation === state.engine.generation
        && operation.instanceId === state.engine.instanceId) {
        state.authBusy = false; if (engineReady()) await refresh({ quiet: true }); else render();
      }
    }
  }
  function softwareLogout() {
    showConfirm("退出软件账号", "退出前会先停止本机正在执行的任务并撤销运行安排。游戏密码、设置和历史记录仍留在这台手机上，未确认的操作记录不会被清除。", "确认退出", () => {
      void softwareCall("/software/logout", { busy: "正在退出…", done: "已退出软件账号。" });
    });
  }
  function softwarePasswordDialog() {
    let clearPasswordFields = () => {};
    const overlay = showDialog("修改软件账号密码", `<p class="dialog-intro">改密之后本机的软件会话全部作废，需要重新登录。正在运行的任务会先停止。</p><form id="software-password-form" novalidate><label class="field"><span>当前密码</span><input name="currentPassword" type="password" required maxlength="64" autocomplete="off" enterkeyhint="next" placeholder="输入当前软件密码" aria-describedby="software-password-current-error"><p class="field-error" id="software-password-current-error" role="alert" hidden></p></label><label class="field"><span>新密码</span><input name="newPassword" type="password" required minlength="8" maxlength="64" autocomplete="off" enterkeyhint="done" placeholder="设置新密码（8 至 64 位）" aria-describedby="software-password-new-error"><p class="field-error" id="software-password-new-error" role="alert" hidden></p></label><div class="panel-note"><strong>密码保护</strong>通过软件账号认证修改密码；敏感输入不写入日志，关闭后清空。</div></form>`, dialogActions(
      '<button class="button secondary" type="button" data-action="close-dialog">先不改</button>',
      '<button class="button primary-button" id="software-password-submit" type="submit" form="software-password-form">确认修改</button>'), "", () => clearPasswordFields());
    const form = overlay.querySelector("#software-password-form");
    if (!form) return;
    const currentInput = form.elements.namedItem("currentPassword");
    const newInput = form.elements.namedItem("newPassword");
    const fields = [
      { input: currentInput, error: overlay.querySelector("#software-password-current-error") },
      { input: newInput, error: overlay.querySelector("#software-password-new-error") },
    ];
    const fieldError = (field, message = "") => {
      if (field.error) { field.error.textContent = message; field.error.hidden = !message; }
      field.input.setCustomValidity(message);
      if (message) field.input.setAttribute("aria-invalid", "true"); else field.input.removeAttribute("aria-invalid");
    };
    for (const field of fields) field.input.addEventListener("input", () => fieldError(field));
    form.addEventListener("reset", () => fields.forEach(field => fieldError(field)));
    // The visual controls are associated with a hidden form owner. Keep exact input references so
    // closing this layer clears them even after removal, without touching a newer password form.
    clearPasswordFields = () => {
      form.reset();
      for (const field of fields) { field.input.value = ""; fieldError(field); }
    };
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const current = currentInput.value;
      const next = newInput.value;
      const submit = overlay.querySelector("#software-password-submit");
      if (!submit || submit.disabled) return;
      const currentError = !current ? "请输入当前软件密码。" : "";
      const newError = !next ? "请输入新密码。" : next.length < 8 || next.length > 64 ? "新密码要 8 至 64 位。" : "";
      fieldError(fields[0], currentError); fieldError(fields[1], newError);
      if (currentError || newError) { (currentError ? currentInput : newInput).focus(); return; }
      submit.disabled = true; submit.textContent = "正在修改…";
      const operation = beginPanelOperation("password", "password-busy", "正在修改软件密码，等待实际结果。");
      state.authBusy = true;
      operation.onDismiss = clearPasswordFields;
      showPanelProgress(operation, "password-busy");
      let accepted = false;
      try {
        const result = await api("/software/password", { method: "POST", body: { currentPassword: current, newPassword: next }, timeoutMs: 30000 });
        accepted = true;
        if (!currentPanelOperation(operation)) return;
        const info = await api("/software/status");
        if (!currentPanelOperation(operation)) return;
        if (result?.ok !== true || info?.signedIn !== false) throw localFailure("密码修改结果尚未完整确认，请先核对当前软件身份。", "PASSWORD_READBACK_MISMATCH");
        recordPanelOperation(operation, "success", "服务器已确认修改，且已读回旧软件会话退出；请使用新密码重新登录。");
        clearPasswordFields();
        if (result?.requiresEngineRestart === true) {
          const showSuccess = !operation.dismissed && operation.overlay?.isConnected
            && dialogFrames.at(-1)?.overlay === operation.overlay;
          // The confirmed password change retires this authenticated scene. Close its
          // progress/form frames before entering auth; feedback is newly mounted there,
          // rather than trying to replace an overlay removed by leaveMoonScene().
          operation.replacing = true;
          closeAllDialogs();
          operation.replacing = false;
          if (!currentPanelOperation(operation)) return;
          const handoff = stageAuthHandoff("密码已修改，请返回登录，重新连接手机服务。");
          if (!showSuccess || !showMoonFeedback("password-success", () => completeAuthHandoff(handoff, info))) {
            completeAuthHandoff(handoff, info);
          }
        } else {
          finishPanelFeedback(operation, "password-success");
          adoptSoftwareInfo(info); await refresh({ quiet: true });
        }
      } catch (error) {
        if (!currentPanelOperation(operation)) return;
        recordPanelOperation(operation, accepted || uncertainOperation(error) ? "unknown" : "error", safeError(error,"密码修改结果尚未确认，请先核对，不会自动重复提交。"));
        finishPanelFeedback(operation, "password-error");
        if (submit.isConnected) { submit.disabled = false; submit.textContent = "确认修改"; }
      } finally {
        clearPasswordFields();
        if (currentPanelOperation(operation)) state.authBusy = false;
      }
    });
  }
  function stageAuthHandoff(message = "软件账号已登录，请先进入花园，读取你的游戏号。") {
    backgroundAuthEpoch++; invalidateBackgroundSettings(true); invalidateDirtyNavigation();
    const handoff = { generation: state.engine.generation, instanceId: state.engine.instanceId, softwareUserId: softwareUserId(), message };
    pendingAuthHandoff = handoff;
    state.accountsReadState = "loading"; state.accountsError = "";
    render();
    return handoff;
  }
  function completeAuthHandoff(handoff, nextSoftware = null) {
    if (!handoff || pendingAuthHandoff !== handoff) return;
    pendingAuthHandoff = null;
    if (softwareUserId() !== handoff.softwareUserId) return;
    if (nextSoftware) adoptSoftwareInfo(nextSoftware);
    readNativeEngineState();
    if (state.engine.generation === handoff.generation && state.engine.instanceId === handoff.instanceId) restartNativeEngine();
    else if (["binding", "ready"].includes(state.engine.phase)) void refresh({ quiet: true });
    // Any underlying credential form belongs to the completed handoff, not the new session.
    closeAllDialogs();
  }
  function showLoginSuccessSheet(requiresRestart = false) {
    const handoff = requiresRestart ? stageAuthHandoff() : null;
    showDialog("欢迎回园", `${accountStatusCard("check", "登录状态", "软件账号已登录", "游戏号仍由你手动开始，不会自动运行。")}<section class="infocard"><div class="infocard-top">${icon("check")}<strong>本机资料</strong></div><p>进入后读取你的游戏号、设置和实际授权状态。</p></section>`,
      dialogActions('<button class="button primary-button" type="button" data-action="close-dialog">进入我的花园</button>'), "", () => completeAuthHandoff(handoff));
  }
  async function submitSoftwareAuth(form) {
    if (state.authBusy) return;
    delete state.panelResults["auth-error"];
    state.authOperation = { kind: "login", sequence: ++panelOperationSequence, status: "idle", at: new Date().toISOString() };
    readNativeEngineState();
    if (!engineReady()) { state.authError = "手机运行服务尚未就绪，登录没有提交。连接完成后按钮会自动恢复。"; state.authErrorMeta = { scope: "local-engine", code: "LOCAL_ENGINE_BINDING" }; syncAuth(); return; }
    if (state.authRetryAt > Date.now()) { syncAuth(); return; }
    const username = $("input[name=username]", form).value.trim();
    const password = $("input[name=password]", form).value;
    if (!username || !password) { state.authError = "请把软件账号和密码都填上。"; state.authErrorMeta = null; syncAuth(); return; }
    const operation = beginPanelOperation("login", "auth-login-loading", "正在核对软件账号登录结果…");
    state.authDraft = { username, password }; state.authError = ""; state.authErrorMeta = null; state.authBusy = true; syncAuth();
    try {
      const result = await api("/software/login", { method: "POST", body: { username, password }, timeoutMs: 30000 });
      if (!currentPanelOperation(operation)) return;
      if (result?.status?.signedIn !== true || result.status.user?.id === undefined) throw localFailure("登录资料尚未完整确认，请重新读取当前身份。", "SOFTWARE_AUTH_INCOMPLETE");
      adoptSoftwareInfo(result.status);
      operation.softwareUserId = softwareUserId();
      recordPanelOperation(operation, "success", "软件账号已登录；进入后读取你的游戏号，不会自动开始运行。");
      state.authDraft = { username, password: "" };
      if (result?.requiresEngineRestart === true) showLoginSuccessSheet(true);
      else { await refresh({ quiet: true }); if (currentPanelOperation(operation)) showLoginSuccessSheet(); }
    } catch (error) {
      if (!currentPanelOperation(operation)) return;
      const copy = {
        SOFTWARE_LOGIN_FAILED: "软件账号或密码不正确，请核对后重试。",
        SOFTWARE_DISABLED: "这个软件账号已被停用，请联系管理员核对。",
        SOFTWARE_TIMEOUT: "软件云服务响应超时，请稍后重试；本次结果尚未确认，不会自动重复登录。",
        SOFTWARE_UNREACHABLE: "手机运行服务已收到登录操作，但目前无法连接软件云服务，请检查网络后重试。",
        SOFTWARE_BASE_URL_MISSING: "这台手机尚未配置软件云服务地址，请在连接帮助中查看。",
        SOFTWARE_AUTH_INCOMPLETE: "软件云服务返回的登录资料不完整，请稍后重试或联系管理员。",
        LOGIN_THROTTLED: "登录尝试受到限制，请按服务器提示等待后重试。",
        LOCAL_REQUEST_STALE: "手机运行服务正在切换，这次登录结果未应用；连接就绪后请重新核对。",
      };
      state.authError = copy[error.code] || safeError(error, error.scope === "software-cloud" ? "软件云服务暂时无法完成登录，请稍后重试。" : "手机运行服务未能完成登录，请重新连接后核对。");
      state.authErrorMeta = { scope: error.scope || "local-engine", code: error.code || "LOCAL_REQUEST_FAILED", status: error.status || 0, requestId: error.requestId || "" };
      if (Number(error.status) === 429 && Number(error.retryAfterMs) > 0) {
        state.authRetryAt = Date.now() + Number(error.retryAfterMs);
        state.authError += ` 服务器要求等待 ${Math.ceil(Number(error.retryAfterMs) / 1000)} 秒。`;
      }
      recordPanelOperation(operation, uncertainOperation(error) ? "unknown" : "error", state.authError);
    } finally { if (currentPanelOperation(operation)) { state.authBusy = false; render(); } }
  }
  /* 注册按原型的 sheet 叠在登录页上：遮罩、标题、正文、固定操作区、关闭与返回栈都由这一层管，
     提交仍走正式 /software/register；成功后返回登录并保留账号、清空密码。 */
  function openRegisterSheet() {
    if (state.authBusy || $("#auth-register-form")) return;
    if (!engineReady()) { state.authError = "手机运行服务尚未就绪，连接完成后即可注册。"; state.authErrorMeta = { scope: "local-engine", code: "LOCAL_ENGINE_BINDING" }; syncAuth(); return; }
    delete state.panelResults["auth-error"];
    state.authOperation = { kind: "register", sequence: ++panelOperationSequence, status: "idle", at: new Date().toISOString() };
    let registrationOperation = null;
    let registerRetryTimer = null;
    const overlay = showMoonSheet(`<div class="sheet-scrim auth-sheet-scrim" data-auth-scrim><section class="bottom-sheet v2-sheet auth-sheet-layer moon-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-sheet-title">
      <div class="sheet-handle"></div>
      <header class="sheet-header"><div><p class="panel-eyebrow">登录</p><h2 id="auth-sheet-title">注册无尽夏</h2></div><button type="button" class="icon-button" aria-label="返回登录" data-auth-sheet-action="close">${AUTH_ICON.close}</button></header>
      <p class="panel-subtitle">从这里，开启你的花园时光</p>
      <div class="panel-scroll">
        <div class="panel-note"><strong>软件账号</strong>这里注册的是无尽夏软件账号；游戏号在登录后单独添加。</div>
        <form class="auth-form" id="auth-register-form" novalidate>
          <p class="field-error" id="register-error" role="alert" hidden></p>
          <div class="field-block"><div class="field-caption"><label for="register-username">软件账号<span class="required-mark">必填</span></label></div><input class="panel-input" id="register-username" name="username" type="text" minlength="3" maxlength="32" required autocomplete="username" placeholder="设置软件账号" aria-describedby="register-username-error" value="${esc(state.authDraft.username)}"><p class="field-error" id="register-username-error" role="alert" hidden></p></div>
          <div class="field-block"><div class="field-caption"><label for="register-password">登录密码<span class="required-mark">必填</span></label></div><div class="password-control"><input class="panel-input" id="register-password" name="password" type="password" minlength="8" maxlength="64" required autocomplete="new-password" placeholder="设置密码（8 至 64 位）" aria-describedby="register-password-error"><button class="icon-button" type="button" data-auth-sheet-action="reveal" aria-label="显示密码" aria-pressed="false">${icon("eye")}</button></div><p class="field-error" id="register-password-error" role="alert" hidden></p></div>
        </form>
        <div class="panel-note"><strong>注册后请登录</strong>注册成功后返回登录；软件账号会保留、密码会清空，不会自动登录或开始游戏任务。</div>
      </div>
      <footer class="panel-footer"><div class="panel-actions"><button type="button" class="secondary" data-auth-sheet-action="close">返回登录</button><button type="submit" form="auth-register-form" class="primary" id="register-submit">注册账号</button></div><p class="preview-label">${icon("eye")}这里只注册软件账号，不会自动开始游戏任务。</p></footer>
    </section></div>`, () => {
      window.clearTimeout(registerRetryTimer);
      const secretInput = overlay.querySelector('#register-password'); if (secretInput) secretInput.value = "";
      if (registrationOperation && !registrationOperation.replacing) {
        registrationOperation.dismissed = true; registrationOperation.formClosed = true;
      }
    });
    const password = $("#register-password");
    const usernameInput = overlay.querySelector('#register-username');
    const form = overlay.querySelector('#auth-register-form');
    const error = $("#register-error");
    const submit = $("#register-submit");
    const reveal = overlay.querySelector('[data-auth-sheet-action="reveal"]');
    reveal?.addEventListener("click", () => {
      if (!password) return;
      password.type = password.type === "password" ? "text" : "password";
      reveal.innerHTML = icon(password.type === "password" ? "eye" : "eyeOff");
      reveal.setAttribute("aria-label", password.type === "password" ? "显示密码" : "隐藏密码");
      reveal.setAttribute("aria-pressed", String(password.type !== "password"));
    });
    overlay.addEventListener("click", event => {
      if (event.target.closest("[data-auth-sheet-action=close]") || event.target === overlay) { closeDialog(); return; }
    });
    const fail = message => {
      if (!error.isConnected) return;
      error.className = "field-error"; error.setAttribute("role", "alert"); error.textContent = message; error.hidden = false;
    };
    /* Local validation belongs to each original field block. Request/limiting/unknown
       results remain separate and continue through the existing registration operation. */
    let fieldErrors = {};
    const sameAsUsername = "登录密码不能与软件账号相同。";
    const syncFieldErrors = () => {
      for (const [name, input] of [["username", usernameInput], ["password", password]]) {
        const message = fieldErrors[name] || "";
        const target = overlay.querySelector(`#register-${name}-error`);
        target.textContent = message; target.hidden = !message;
        if (message) input.setAttribute("aria-invalid", "true");
        else input.removeAttribute("aria-invalid");
      }
    };
    form.addEventListener("input", event => {
      const name = event.target.name;
      if (!["username", "password"].includes(name)) return;
      delete fieldErrors[name];
      if (name === "username" && fieldErrors.password === sameAsUsername) delete fieldErrors.password;
      syncFieldErrors();
    });
    const syncRegisterRetry = () => {
      window.clearTimeout(registerRetryTimer);
      if (!submit.isConnected) return;
      const wait = Math.max(0, state.registerRetryAt - Date.now());
      if (wait > 0) {
        submit.disabled = true; submit.textContent = `请在 ${Math.ceil(wait / 1000)} 秒后重试`;
        registerRetryTimer = window.setTimeout(syncRegisterRetry, Math.min(wait, 1000));
      } else if (!state.authBusy) { submit.disabled = false; submit.textContent = "注册账号"; }
    };
    const submitRegister = async event => {
      event?.preventDefault();
      if (!submit || submit.disabled || state.authBusy) return;
      if (registrationOperation?.completed) {
        if (dialogFrames[dialogFrames.length - 1]?.overlay === overlay) closeDialog();
        return;
      }
      if (state.registerRetryAt > Date.now()) { syncRegisterRetry(); return; }
      const username = usernameInput?.value.trim() || "";
      const secret = password?.value || "";
      // Mirror this project's current cloud/common.mjs rules without making a trial registration.
      fieldErrors = {};
      if (!username) fieldErrors.username = "软件账号还没有填写";
      else if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) fieldErrors.username = "软件账号需为 3 至 32 位字母、数字、下划线、点或连字符。";
      if (secret.length < 8) fieldErrors.password = "登录密码至少 8 位";
      else if (!/^[\x20-\x7e]{8,64}$/.test(secret)) fieldErrors.password = "登录密码需为 8 至 64 位可输入的英文字符、数字、符号或空格。";
      else if (secret === username) fieldErrors.password = sameAsUsername;
      syncFieldErrors();
      if (Object.keys(fieldErrors).length) { error.hidden = true; return; }
      if (!engineReady()) { fail("手机运行服务尚未就绪，本次注册没有提交。"); return; }
      const operation = beginPanelOperation("register", "auth-register-loading", "正在提交软件注册，请等待本次实际结果。");
      registrationOperation = operation;
      operation.onDismiss = () => {
        if (password.isConnected) password.value = "";
        if (overlay.isConnected) fail("注册请求仍在处理中，请等待本次结果，不要重复提交。");
      };
      error.hidden = true;
      state.authBusy = true;
      submit.disabled = true; submit.textContent = "正在注册…";
      usernameInput.disabled = true; password.disabled = true;
      reveal.disabled = true;
      showPanelProgress(operation, "auth-register-loading");
      try {
        const result = await api("/software/register", { method: "POST", body: { username, password: secret }, timeoutMs: 30000 });
        if (!currentPanelOperation(operation)) return;
        if (result?.ok !== true || result.registrationConfirmed !== true || !Number.isSafeInteger(result.user?.id)
          || result.user.id <= 0 || result.user.username !== username) {
          throw localFailure("软件注册结果尚未完整确认，请先通过正常登录核对；不会自动重复注册。", "SOFTWARE_REGISTER_UNCONFIRMED");
        }
        recordPanelOperation(operation, "success", "软件账号注册已由服务器确认，请返回登录；不会自动登录或开始游戏任务。", 1);
        operation.completed = true;
        const ownsUI = overlay.isConnected && !operation.dismissed
          && dialogFrames[dialogFrames.length - 1]?.overlay === operation.overlay;
        if (!ownsUI) {
          if (overlay.isConnected && !operation.formClosed && registrationOperation === operation) {
            state.authDraft = { username, password: "" };
            error.className = "field-description"; error.setAttribute("role", "status");
            error.textContent = "注册已确认，请返回登录。密码已清空，不会自动登录或开始游戏任务。"; error.hidden = false;
          }
          return;
        }
        finishPanelFeedback(operation, null);
        operation.replacing = true;
        if (dialogFrames[dialogFrames.length - 1]?.overlay === overlay) closeDialog();
        operation.replacing = false;
        state.authDraft = { username, password: "" };
        state.authError = ""; state.authErrorMeta = null;
        render();
        if (!hasDialog() && currentPanelOperation(operation)) showMoonFeedback("auth-register-success");
      } catch (err) {
        if (!currentPanelOperation(operation)) return;
        const unknown = uncertainOperation(err);
        const copy = { USERNAME_TAKEN: "这个软件账号已被使用，请换一个账号，或返回登录。", REGISTRATION_CLOSED: "当前注册功能已关闭，请联系管理员。",
          REGISTER_THROTTLED: "注册操作受到限制，请按服务器提示等待后重试。", INPUT_INVALID: "注册资料不符合要求，请核对软件账号和密码格式。" };
        let message = unknown ? "本次注册结果尚未确认，请先通过正常登录核对；不会自动重复注册。" : copy[err.code] || safeError(err,"这次注册未完成，请核对后重试。");
        if (Number(err.status) === 429 && Number(err.retryAfterMs) > 0) {
          state.registerRetryAt = Date.now() + Number(err.retryAfterMs);
          message += ` 服务器要求等待 ${Math.ceil(Number(err.retryAfterMs) / 1000)} 秒。`;
        }
        recordPanelOperation(operation, unknown ? "unknown" : "error", message);
        if (overlay.isConnected && !operation.formClosed && registrationOperation === operation) {
          finishPanelFeedback(operation, null);
          fail(message);
          if (password.isConnected) { password.value = ""; password.focus(); }
        }
      } finally {
        if (password.isConnected) password.value = "";
        if (currentPanelOperation(operation)) {
          state.authBusy = false;
          if (overlay.isConnected) {
            if (operation.completed) { usernameInput.disabled = true; password.disabled = true; reveal.disabled = true; submit.disabled = false; submit.textContent = "返回登录"; }
            else { usernameInput.disabled = false; password.disabled = false; reveal.disabled = false; syncRegisterRetry(); }
          }
          else renderIfIdle();
        }
      }
    };
    form.addEventListener("submit", submitRegister);
    syncRegisterRetry();
  }
  /* Read-only authentication conditions are children of the help sheet. Their values
     come from the current host; opening them never submits login/registration again. */
  function openAuthHelpConditionSheet(kind) {
    const service = kind === "service";
    const id = service ? "service-disconnected" : "auth-cloud-missing";
    const title = service ? "手机运行服务" : "软件云服务配置";
    const fallbackBody = () => {
      const configured = softwareInfo()?.cloudConfigured;
      const value = service
        ? engineReady() ? "手机服务已连接" : safeError({ message: state.engine.message }, "手机服务尚未就绪")
        : configured === true ? "已配置本项目云服务" : configured === false ? "未配置本项目云服务" : "当前云服务配置尚未读取";
      const description = service ? "这里显示本机服务当前读数。重新检查不会重复提交软件登录、注册或游戏操作。"
        : configured === true ? "地址已配置；能否登录仍以这次认证请求的实际结果为准。"
          : configured === false ? "这台手机还没有配置本项目的软件云服务地址，暂时无法登录。"
            : "先连接手机运行服务，再读取当前设备的云服务配置；未读取不等于未配置。";
      return `<section class="panel-status"><div><p class="panel-eyebrow">${service ? "当前连接" : "云服务地址"}</p><h3>${esc(value)}</h3><p>${esc(description)}</p></div></section>`;
    };
    const bodyHTML = () => {
      try { return window.MoonUI?.fieldsHTML?.(id) || fallbackBody(); }
      catch { return fallbackBody(); }
    };
    let html;
    try { html = window.MoonUI?.sheetHTML?.(id, dialogFrames.length + 1); } catch {}
    if (!html) html = `<div class="sheet-scrim auth-sheet-scrim" data-auth-scrim><section class="bottom-sheet v2-sheet auth-sheet-layer moon-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-condition-title"><div class="sheet-handle"></div><header class="sheet-header"><div><p class="panel-eyebrow">登录帮助</p><h2 id="auth-condition-title">${title}</h2></div><button type="button" class="icon-button" data-auth-condition-action="back" aria-label="返回登录帮助">${AUTH_ICON.close}</button></header><div class="panel-scroll">${bodyHTML()}</div><footer class="panel-footer"><div class="panel-actions"></div><p class="preview-label">${icon("eye")}状态以本机实际读取为准，不会自动提交登录。</p></footer></section></div>`;
    let poll = null;
    let refreshing = false;
    let readError = "";
    let renderedBody = null;
    const overlay = showMoonSheet(html, () => window.clearInterval(poll));
    /* This local listener owns the blank scrim; do not also let the generic scrim
       delegate pop the parent help sheet on the same event. */
    overlay.removeAttribute("data-scrim"); overlay.setAttribute("data-auth-scrim", "");
    const actions = overlay.querySelector(".panel-actions");
    actions.innerHTML = service
      ? `<button type="button" class="secondary" data-auth-condition-action="back">返回帮助</button><button type="button" class="primary" data-auth-condition-action="retry">重新检查手机服务</button>`
      : `<button type="button" class="primary" data-auth-condition-action="back">返回帮助</button>`;
    const update = () => {
      if (!overlay.isConnected) { window.clearInterval(poll); return; }
      const readContext = service ? nativeServiceReadContext(overlay) : null;
      if (service && !readContext) return;
      const scroll = overlay.querySelector(".panel-scroll");
      const next = bodyHTML() + (readError ? `<p class="field-error" role="alert">${esc(readError)}</p>` : "");
      if (service && !sameNativeServiceReadContext(readContext)) return;
      if (renderedBody !== next) { const keep = scroll.scrollTop; scroll.innerHTML = next; scroll.scrollTop = keep; renderedBody = next; }
      const retry = overlay.querySelector('[data-auth-condition-action="retry"]');
      if (retry) { retry.disabled = refreshing || state.authBusy; retry.textContent = refreshing ? "正在重新检查…" : "重新检查手机服务"; }
    };
    if (service) bindNativeServiceReadLayer(overlay, id, update);
    overlay.addEventListener("click", async event => {
      const action = event.target.closest("[data-auth-condition-action]")?.dataset.authConditionAction;
      if (action === "back" || event.target === overlay) { closeDialog(); return; }
      if (action !== "retry" || !service || refreshing || state.authBusy) return;
      refreshing = true; readError = ""; update();
      try { reconnectNativeEngine(true); await refresh({ quiet: false }); }
      catch (error) { readError = safeError(error, "本次手机服务状态未读到，请稍后重新检查。"); }
      finally { refreshing = false; update(); }
    });
    update();
    // Observe existing host callbacks only. This timer performs no API calls or reconnection.
    poll = window.setInterval(update, 1000);
  }
  /* 登录帮助保留原型三张说明卡和两个入口；云配置用中性入口与真实读数，不制造缺配置状态。 */
  function openAuthHelpSheet() {
    const info = softwareInfo();
    const cloudConfigured = info?.cloudConfigured;
    const cloudTitle = cloudConfigured === false ? "云服务尚未配置" : "软件云服务配置";
    const cloudDescription = cloudConfigured === false ? "查看此设备暂时无法登录的原因"
      : cloudConfigured === true ? "已配置本项目云服务，查看当前设备的配置说明" : "当前云服务配置尚未读取，查看读取条件";
    const overlay = showMoonSheet(`<div class="sheet-scrim auth-sheet-scrim" data-auth-scrim><section class="bottom-sheet v2-sheet auth-sheet-layer moon-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-sheet-title">
      <div class="sheet-handle"></div>
      <header class="sheet-header"><div><p class="panel-eyebrow">登录</p><h2 id="auth-sheet-title">登录帮助</h2></div><button type="button" class="icon-button" aria-label="关闭" data-auth-sheet-action="close">${AUTH_ICON.close}</button></header>
      <p class="panel-subtitle">软件身份和游戏账号分开管理</p>
      <div class="panel-scroll">
        <div class="panel-note"><strong>忘记软件密码</strong>请联系管理员重置软件账号密码。当前 App 没有自助短信找回入口。</div>
        <div class="panel-note"><strong>注册之后</strong>注册成功后返回登录，再进入你的软件账号。</div>
        <div class="panel-note"><strong>游戏账号在哪里？</strong>软件登录后，在「游戏号」中添加。游戏账号和密码保存在本机，不会因为软件登录自动开始任务。</div>
        <button type="button" class="panel-link" data-auth-sheet-action="service"><span>连接不上手机服务<small>查看重新连接和手机服务状态</small></span>${icon("chevronRight")}</button>
        <button type="button" class="panel-link" data-auth-sheet-action="cloud"><span>${cloudTitle}<small>${cloudDescription}</small></span>${icon("chevronRight")}</button>
      </div>
      <footer class="panel-footer"><div class="panel-actions"><button type="button" class="primary" data-auth-sheet-action="close">知道了</button></div><p class="preview-label">${icon("eye")}软件登录不会自动开始游戏任务。</p></footer>
    </section></div>`);
    overlay.addEventListener("click", event => {
      const action = event.target.closest("[data-auth-sheet-action]")?.dataset.authSheetAction;
      if (action === "service") { openAuthHelpConditionSheet("service"); return; }
      if (action === "cloud") { openAuthHelpConditionSheet("cloud"); return; }
      if (action === "close" || event.target === overlay) closeDialog();
    });
  }
  document.addEventListener("click",event => {
    const subTab = event.target.closest(".settings-context [data-stab]");
    const tab = event.target.closest("[data-tab]");
    /* 设置页内部的分类按钮只切分类，不能走 changeTab 重读配置：
       重读会把还没保存的草稿整份冲掉。卡片上的「设置」带 data-id，仍要切号，
       所以只对不带 data-id 的分类按钮提前返回。 */
    if (subTab && !subTab.dataset.id) { state.settingsTab = subTab.dataset.stab; render(); main.scrollTop = 0; return; }
    /* 卡片上的「设置」「日志」各自带着那张卡的 data-id：必须一起传下去，
       否则只会切到上次选中的账号（审查登记过的"串到旧选中号"）。 */
    if (tab) {
      if (subTab?.dataset.stab) state.settingsTab = subTab.dataset.stab;
      void changeTab(tab.dataset.tab, tab.dataset.id);
      return;
    }
    const help = event.target.closest("[data-help]");
    if (help) { event.preventDefault(); toggleHelp(help.dataset.help); return; }
    // 订单卡与花艺卡的开关：按路径写同一份草稿，保存仍走一次 PUT（不点开始就不启动账号）。
    const pathToggle = event.target.closest("[data-path]");
    if (pathToggle && !pathToggle.disabled && (state.draft || inSheet(pathToggle))) {
      const target=captureDraftTarget(pathToggle);
      if (pathToggle.dataset.path === "art.dailyMakeEnabled") {
        const next = !(getPath(target?.draft,"art.dailyMakeEnabled") === true && getPath(target?.draft,"art.autoReplenish") === true);
        if (applyDraftValue(target,"art.dailyMakeEnabled",next)) {
          const refreshedTarget = captureDraftTarget(pathToggle);
          if (applyDraftValue(refreshedTarget,"art.autoReplenish",next)) afterDraftChange(pathToggle);
        }
      } else if(applyDraftValue(target,pathToggle.dataset.path,getPath(target?.draft,pathToggle.dataset.path)!==true)) afterDraftChange(pathToggle);
      return;
    }
    const filter = event.target.closest("[data-filter]");
    if (filter) { state.accountFilter = filter.dataset.filter; render(); return; }
    const logCategory = event.target.closest("[data-log-category]");
    if (logCategory) { state.logsCategory = logCategory.dataset.logCategory || ""; state.logs = []; resetLogsPage(); void loadLogs(); return; }
    const detail = event.target.closest("[data-detail]");
    if (detail) { openDetail(detail.dataset.detail, detail.dataset.focus || ""); return; }
    const picker = event.target.closest("[data-picker]");
    if (picker && !picker.disabled) { openMultiPicker(picker.dataset.picker,picker); return; }
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if(action==="resume-config-draft"){
      const root=draftTransactionForNode(button);
      if(root && String(root.id)===button.dataset.draftTransaction)void resumeDraftTransaction(root,button);
      return;
    }
    if (action === "close-dialog") { closeTopDialog(); return; }
    if (action === "detail-done") { detailDone(button); return; }
    if (action === "detail-cancel") { detailCancel(); return; }
    if (action === "clear-egress") { showEgressClearConfirm(); return; }
    if (action === "clear-egress-confirmed") { closeTopDialog(); void saveEgress(true); return; }
    if (action === "toggle-upload-policy") { void toggleUploadPolicy(button); return; }
    if (action === "device-logs") {
      readNativeEngineState();
      const overlay = button.closest(".sheet-scrim,.dialog-overlay");
      const frame = dialogFrames[dialogFrames.length - 1];
      if (overlay ? frame?.overlay !== overlay : hasDialog()) return;
      const intent = { context: overlay ? frame.viewContext : accountChoiceContext(),
        logs: { scope: "device", category: state.logsCategory, day: state.logsDay } };
      const problem = navigationIntentProblem(intent);
      if (problem) { toast(problem); return; }
      if (overlay) closeDialog();
      void changeTab("logs", undefined, intent); return;
    }
    if (action === "add-account") addAccountDialog();
    if (action === "refresh") {
      const context = readContext();
      if (dialogFrames.length) closeTopDialog();
      void refreshFromUser({ reconnect: true }).then(result => {
        if (softwareUserId() !== context.softwareUserId || !sameReadContext(context) && result?.status !== "reconnecting") return;
        if (result?.status !== "stale" && result?.message) toast(result.message);
      }).catch(error => { if (sameReadContext(context)) toast(safeError(error, "本次读取未完成，请重新连接手机服务。")); });
      return;
    }
    if (action === "pick-account") { accountPickerSheet(); return; }
    if (action === "pick-log-scope") { logScopeSheet(); return; }
    if (action === "account-menu") { accountMenuDialog(button.dataset.id, button.dataset.name); return; }
    if (action === "settings-rules") { showRulesSheet(); return; }
    if (action === "help") { showUsageSheet(); return; }
    if (action === "help-auth") { closeTopDialog(); openAuthHelpSheet(); return; }
    if (action === "help-protection") { closeTopDialog(); showAccountProtectionSheet(state.selectedId); return; }
    if (action === "help-license") { closeTopDialog(); showLicenseSheet(); return; }
    if (action === "help-sync") { closeTopDialog(); showLogSyncSheet(); return; }
    if (action === "help-battery") { closeTopDialog(); showBackgroundSheet(); return; }
    if (action === "orders-state-help") { showOrdersStateSheet(); return; }
    if (action === "service-help") { showServiceDisconnectedSheet(); return; }
    if (action === "service-help-offline") { showServiceDisconnectedSheet(true); return; }
    if (action === "art-status") { showArtStatusSheet(); return; }
    if (action === "me-software") { showSoftwareSheet(); return; }
    if (action === "me-license") { showLicenseSheet(); return; }
    if (action === "me-sync") { showLogSyncSheet(); return; }
    if (action === "me-ownership") { showOwnershipSheet(); return; }
    if (action === "me-runtime") { showRuntimeSheet(); return; }
    if (action === "me-background") { showBackgroundSheet(); return; }
    if (action === "me-egress") { showEgressSheet(); return; }
    if (action === "account-runtime") { showAccountRuntimeSheet(button.dataset.id); return; }
    if (action === "account-protection") { showAccountProtectionSheet(button.dataset.id); return; }
    if (action === "customer-art-link") { showCustomerArtSheet(); return; }
    if (action === "daily-protection") { showDailyProtectionSheet(); return; }
    if (action === "daily-status") { showDailyStatusSheet(); return; }
    if (action === "open-art-detail") { closeTopDialog(); state.settingsTab = "art"; render(); return; }
    if (action === "log-detail") { showLogDetail(Number(button.dataset.index)); return; }
    if (action === "account-settings") void changeTab("settings",button.dataset.id);
    if (action === "account-logs") void changeTab("logs",button.dataset.id);
    if (action === "remove-account") removeAccountDialog(button.dataset.id);
    if (action === "reload-config") {
      if(state.dirty || configLayers().some(layer=>changedLayerPaths(layer).length))showConfirm("设置还没有保存","重新读取会放弃这次页面与详情里的修改，已经保存的设置不受影响。","放弃修改并重新读取",()=>{
        closeAllDialogs();pageDraftTransaction=null;state.config=null;state.draft=null;state.dirty=false;void loadConfig();
      });else void loadConfig();
      return;
    }
    if (action === "pick-arts") { artPickerDialog(button); return; }
    if (action === "pick-art-qualities") { artPickerDialog(button, "art.dailyQualities", "花艺品质"); return; }
    if (action === "pick-rack-arts") { artPickerDialog(button, "flowerRack.artIds", "花架成品名单"); return; }
    if (action === "reload-logs") { resetLogsPage(); void loadLogs(); }
    if (action === "logs-filter-open") { logFilterSheet(); return; }
    if (action === "apply-log-filters") {
      const overlay = button.closest(".sheet-scrim,.dialog-overlay");
      const frame = dialogFrames[dialogFrames.length - 1];
      if (!overlay || frame?.overlay !== overlay) return;
      const scope = overlay.querySelector("#log-filter-scope")?.value;
      const category = overlay.querySelector("#log-filter-category")?.value;
      const day = overlay.querySelector("#log-filter-day")?.value;
      const keyword = overlay.querySelector("#log-filter-keyword")?.value || "";
      const level = overlay.querySelector("#log-filter-level")?.value || "";
      const outcomeState = overlay.querySelector("#log-filter-outcome")?.value || "";
      const errorCode = overlay.querySelector("#log-filter-error-code")?.value || "";
      const operationId = overlay.querySelector("#log-filter-operation-id")?.value || "";
      const traceId = overlay.querySelector("#log-filter-trace-id")?.value || "";
      if (typeof scope !== "string" || typeof category !== "string" || typeof day !== "string" || typeof keyword !== "string" || typeof level !== "string" || typeof outcomeState !== "string") { toast("这份日志筛选字段不完整，请关闭后重新打开。"); return; }
      const intent = { context: frame.viewContext, logs: { scope, category, day, keyword, level, outcomeState, errorCode, operationId, traceId } };
      const problem = navigationIntentProblem(intent);
      if (problem) { toast(problem); return; }
      closeDialog();
      void changeTab("logs", scope === "device" ? undefined : scope, intent);
      return;
    }
    if (action === "clear-log-filters") {
      const overlay = button.closest(".sheet-scrim,.dialog-overlay");
      const frame = dialogFrames[dialogFrames.length - 1];
      if (overlay ? frame?.overlay !== overlay : hasDialog()) return;
      const scope = logSourceRef();
      const intent = { context: overlay ? frame.viewContext : accountChoiceContext(), logs: { scope, category: "", day: "", keyword: "", level: "", outcomeState: "", traceId: "", operationId: "" } };
      const problem = navigationIntentProblem(intent);
      if (problem) { toast(problem); return; }
      if (overlay) closeDialog();
      void changeTab("logs", scope === "device" ? undefined : scope, intent); return;
    }
    if (action === "logs-prev") void logsNewerPage();
    if (action === "logs-next") void logsOlderPage();
    if (action === "save-config") void saveConfig();
    /* 开始/停止一律要求按钮自带稳定账号 ID。迁入层旧按钮发的是 start-account/stop-account，
       正式层没有这两个分支，也不会退回去用"上次选中的号"顶替 —— 这里把缺 ID 变成一句能看懂的话。 */
    if (action === "start" || action === "stop") {
      const target = button.dataset.id ? String(button.dataset.id) : "";
      if (!target) {
        toast(action === "start" ? "这个开始按钮没有带上游戏号，请先选择要操作的账号。" : "这个停止按钮没有带上游戏号，请先选择要操作的账号。");
        return;
      }
      if (action === "start" && state.dirty) { showStartUnsaved(); return; }
      if (action === "start") { showAccountStartSheet(target); return; }
      showAccountStopSheet(target);
      return;
    }
    if (action === "confirm-start") { closeDialog(); void runAction(button.dataset.id,"start"); return; }
    if (action === "confirm-stop") { closeDialog(); void runAction(button.dataset.id,"stop"); return; }
    if (action === "switch-auth-mode") { openRegisterSheet(); return; }
    if (action === "reveal-password") { revealPassword(); return; }
    if (action === "auth-help") { openAuthHelpSheet(); return; }
    if (action === "auth-reconnect") { state.authError = ""; state.authErrorMeta = null; reconnectNativeEngine(true); void refresh({ quiet: false }); return; }
    if (action === "check-license") { void softwareCall("/software/license", { busy: "正在核对授权…" }); return; }
    if (action === "upload-logs") { closeDialog(); void changeTab("logs"); return; }
    if (action === "upload-filtered-logs") { void uploadFilteredLogs(); return; }
    if (action === "claim-data") { void softwareCall("/software/claim", { busy: "正在确认归属…" }); return; }
    if (action === "software-logout") { softwareLogout(); return; }
    if (action === "change-password") { softwarePasswordDialog(); return; }
    if (action === "background-settings") openBackgroundSettings(button);
    if (action === "open-manufacturer-settings") { openKeepAliveSettings("manufacturer"); return; }
    if (action === "open-exact-alarm-settings") { openKeepAliveSettings("exact-alarm"); return; }
    if (action === "toggle-screen-keep-on") {
      const facts = window.GardenHost?.serviceFacts?.() || {};
      window.GardenHost?.setScreenKeepOn?.(!(facts.screenKeepOn === true));
      return;
    }
    if (action === "start-keepalive-probe") { window.GardenHost?.startKeepAliveProbe?.(); return; }
    if (action === "cancel-keepalive-probe") { window.GardenHost?.cancelKeepAliveProbe?.(); return; }
    if (action === "toggle-keepalive-vpn") {
      const facts = window.GardenHost?.serviceFacts?.() || {};
      const next = !(facts.vpnEnabled === true);
      closeTopDialog();
      setKeepAliveVpn(next, facts);
      return;
    }
  });
  document.addEventListener("change",event => {
    const input = event.target;
    if (input.dataset?.configChoice && (state.draft || inSheet(input)) && (!input.closest("#dialog-host") || inSheet(input))) {
      if (draftSet(input.dataset.configChoice, input.value, captureDraftTarget(input))) afterDraftChange(input);
      return;
    }
    // 订单与花艺的数值格与勾选格：按路径写回同一份草稿，切分类不重取默认值。
    if (input.dataset?.input && (state.draft || inSheet(input)) && (!input.closest("#dialog-host") || inSheet(input))) {
      if(draftSet(input.dataset.input,input.value===""?null:Number(input.value),captureDraftTarget(input)))afterDraftChange(input);
      return;
    }
    if (input.dataset?.check && (state.draft || inSheet(input)) && (!input.closest("#dialog-host") || inSheet(input))) {
      const [path, rawValue] = String(input.dataset.check).split(":");
      const list = (draftGet(path) || []).map(Number).filter(one => Number.isFinite(one));
      const value = Number(rawValue);
      const next = input.checked ? [...new Set([...list, value])] : list.filter(one => one !== value);
      if(draftSet(path,next,captureDraftTarget(input)))afterDraftChange(input);return;
    }
    if ((!state.draft && !inSheet(input)) || (input.closest("#dialog-host") && !inSheet(input))) return;
    const target=captureDraftTarget(input);let changed=false;
    if (input.id === "plant-mode") changed=draftSet("plantMode",input.value,target);
    if (input.id === "group-size") changed=draftSet("groupSize",input.value===""?null:Number(input.value),target);
    if (input.id === "restock-count") changed=draftSet("restockCount",input.value===""?null:Number(input.value),target);
    if (input.id === "keep-water") changed=draftSet("keepWater",input.value===""?null:Number(input.value),target);
    if(!changed)return;
    if (inSheet(input)) { afterDraftChange(input); return; }
    updateDirty(); render();
  });
  document.addEventListener("input",event => {
    if (event.target.id === "egress-input") { state.egressDraft = event.target.value; state.egressEditing = true; }
    if (event.target.id === "software-username") state.authDraft.username = event.target.value;
    if (event.target.id === "software-password") state.authDraft.password = event.target.value;
  });
  document.addEventListener("submit",event => {
    if (event.target.id === "software-auth-form") { event.preventDefault(); void submitSoftwareAuth(event.target); return; }
    if (event.target.id !== "egress-form") return;
    event.preventDefault(); void saveEgress();
  });
  document.addEventListener("keydown",event => {
    const dialog = topDialog();
    if (!dialog) return;
    if (event.key === "Escape") { event.preventDefault(); closeTopDialog(); }
    if (event.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll("button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex='0']")];
    const first = focusable[0]; const last = focusable[focusable.length-1];
    if (!first) return;
    // 焦点被重画甩到弹层外面时先拉回栈顶这一层，再做首尾循环。
    if (!dialog.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); return; }
    if (event.shiftKey && document.activeElement === first) {event.preventDefault();last?.focus();}
    else if (!event.shiftKey && document.activeElement === last) {event.preventDefault();first?.focus();}
  });
  /* 键盘与安全区的归属在原生层：可用区由容器给出，这里只接收原生通知的真实键盘可见态，
     不再按获得焦点猜键盘，也不再扣第二遍边距。
     2026-10-22：原生不再对整个 WebView 加 padding，改为把窗口度量交给这里。
     单位约定：原生一律给 Android 物理 px，这里用「innerWidth / WebView 物理宽」实测比例换成 CSS px。
     不用 density 顶替 devicePixelRatio —— textZoom 或 initial-scale 一变，两者就不相等。 */
  const applyHostInsets = info => {
    const root = document.documentElement;
    const nativeWidth = Number(info.webViewPx && info.webViewPx.width);
    const ratio = nativeWidth > 0 && window.innerWidth > 0 ? window.innerWidth / nativeWidth : 1;
    const cssPx = value => {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return 0;
      return Math.round(n * ratio * 100) / 100;
    };
    const bars = info.barsPx || {};
    const ime = info.imePx || {};
    const imeVisible = ime.visible === true;
    /* 一份遮挡只算一次：safe-bottom 只表示系统栏/手势条，IME 单独一位；
       需要"两者取大"的容器用 --host-bottom，不再把两份相加。 */
    const safeBottom = cssPx(bars.bottom);
    const imeBottom = imeVisible ? cssPx(ime.bottom) : 0;
    root.style.setProperty("--host-safe-top", cssPx(bars.top) + "px");
    root.style.setProperty("--host-safe-right", cssPx(bars.right) + "px");
    root.style.setProperty("--host-safe-left", cssPx(bars.left) + "px");
    root.style.setProperty("--host-safe-bottom", safeBottom + "px");
    root.style.setProperty("--host-ime-bottom", imeBottom + "px");
    root.style.setProperty("--host-bottom", Math.max(safeBottom, imeBottom) + "px");
    /* 到顶自检：WebView 必须和窗口同宽同高、原点在 0,0。不是的话如实记 0，
       验收时能直接现读这一位，而不是靠肉眼猜"看起来到顶了"。 */
    const view = info.webViewPx || {};
    const win = info.windowPx || {};
    const fullWindow = Number(view.x) === 0 && Number(view.y) === 0
      && Math.abs(Number(view.width) - Number(win.width)) <= 1
      && Math.abs(Number(view.height) - Number(win.height)) <= 1;
    root.dataset.hostFullWindow = fullWindow ? "1" : "0";
    root.dataset.hostLayout = "ready";
    return { ratio, safeTop: cssPx(bars.top), safeBottom, imeVisible, fullWindow };
  };
  window.onGardenWindow = info => {
    if (!info) return;
    const root = document.documentElement;
    /* 旧代次不覆盖新场景：原生每次窗口度量变化都会加一，迟到的回调直接丢弃。 */
    const generation = Number(info.generation);
    if (Number.isFinite(generation)) {
      const applied = Number(root.dataset.hostGeneration);
      if (Number.isFinite(applied) && generation < applied) return;
      root.dataset.hostGeneration = String(generation);
    }
    document.body.classList.toggle("keyboard-open", info.keyboardVisible === true);
    const scale = Number(info.fontScale);
    if (Number.isFinite(scale) && scale > 0) root.style.setProperty("--g-text-scale", String(scale));
    const applied = applyHostInsets(info);
    // Persist only the native layout contract after the existing late-generation guard.
    // Return copies through GardenHost; never retain arbitrary bridge payload properties.
    const number = (object, key) => typeof object?.[key] === "number" && Number.isFinite(object[key]) ? object[key] : null;
    const numbers = (object, keys) => Object.fromEntries(keys.map(key => [key, number(object, key)]));
    acceptedNativeWindow = {
      schemaVersion: 1, source: "onGardenWindow-after-generation-guard", receivedAt: new Date().toISOString(),
      raw: { generation: number(info, "generation"), pageMode: typeof info.pageMode === "string" && info.pageMode.length <= 40 ? info.pageMode : null,
        keyboardVisible: typeof info.keyboardVisible === "boolean" ? info.keyboardVisible : null,
        fontScale: number(info, "fontScale"), density: number(info, "density"), dpr: number(info, "dpr"),
        windowPx: numbers(info.windowPx, ["width", "height"]), webViewPx: numbers(info.webViewPx, ["x", "y", "width", "height"]),
        barsPx: numbers(info.barsPx, ["top", "right", "bottom", "left"]),
        imePx: { ...numbers(info.imePx, ["bottom"]), visible: typeof info.imePx?.visible === "boolean" ? info.imePx.visible : null,
          ...(["legacy-visible-frame-residual", "legacy-reported-inset-fallback", "legacy-ime-hidden"].includes(info.imePx?.mode)
            ? { mode: info.imePx.mode, reportedBottom: Number.isSafeInteger(info.imePx.reportedBottom) && info.imePx.reportedBottom >= 0 ? info.imePx.reportedBottom : null } : {}) } },
      applied: { ...applied, hostGeneration: root.dataset.hostGeneration || null,
        hostFullWindow: root.dataset.hostFullWindow || null, hostLayout: root.dataset.hostLayout || null },
    };
  };
  window.onGardenBack = () => {
    if (!hasDialog()) return false;
    closeTopDialog();
    return true;
  };
  document.addEventListener("pointerdown", event => {
    if (event.target.closest("[data-action=reveal-password]") && document.activeElement === $("#software-password")) event.preventDefault();
  });
  if (window.AndroidBridge) document.documentElement.classList.add("native-shell");
  document.addEventListener("visibilitychange",() => { if (!document.hidden) { void refresh({quiet:true,includeDetails:state.tab !== "logs" || onFirstLogsPage()}); void refreshObservations(); } });
  window.addEventListener("online",() => { void refresh({quiet:true}); });
  // The native activity may call this after returning from Android settings.
  window.onGardenNativeResume = () => {
    const device = bridgeCall("deviceInfo");
    if (device && typeof device === "object") state.device = device;
    void refresh({quiet:true,includeDetails:state.tab !== "logs" || onFirstLogsPage()}); void refreshObservations();
  };
  window.GardenHost = {
    openKeepAliveSettings,
    toggleKeepAliveVpn: () => {
      const facts = window.GardenHost?.serviceFacts?.() || {};
      // A stale cached reading could turn a "close" click into another "open". Read the
      // live state at click time; enabled-but-not-connected still means "try again".
      try {
        const live = JSON.parse(window.AndroidBridge?.keepAliveStatus?.() || "null");
        if (live && live.vpn) { facts.vpnEnabled = live.vpn.enabled; facts.vpnActive = live.vpn.active; }
      } catch { /* fall back to the last rendered facts */ }
      const next = facts.vpnEnabled === true && facts.vpnActive === true ? false : true;
      setKeepAliveVpn(next, facts);
    },
    toggleScreenKeepOn: () => {
      const facts = window.GardenHost?.serviceFacts?.() || {};
      try {
        const live = JSON.parse(window.AndroidBridge?.keepAliveStatus?.() || "null");
        if (live && typeof live.screenKeepOn === "boolean") facts.screenKeepOn = live.screenKeepOn;
      } catch { /* fall back to the last rendered facts */ }
      window.GardenHost?.setScreenKeepOn?.(!(facts.screenKeepOn === true));
    },
    setScreenKeepOn: on => {
      const bridge = window.AndroidBridge;
      if (!bridge || typeof bridge.setScreenKeepOn !== "function") { toast("这个入口不在当前本机页面里，请更新 App 后再试。"); return; }
      try { bridge.setScreenKeepOn(Boolean(on)); } catch { toast("屏幕常亮设置未提交。"); return; }
      const device = bridgeCall("deviceInfo");
      if (device && typeof device === "object") state.device = device;
      toast(on ? "已请求开启屏幕常亮；以本机实际读数为准。" : "已请求关闭屏幕常亮。");
    },
    startKeepAliveProbe: () => {
      const bridge = window.AndroidBridge;
      if (!bridge || typeof bridge.startKeepAliveProbe !== "function") { toast("这个入口不在当前本机页面里，请更新 App 后再试。"); return; }
      try {
        const started = JSON.parse(bridge.startKeepAliveProbe());
        if (started.started === true) toast("五分钟自检已开始；请锁屏并保持屏幕关闭至少两分钟。");
        else toast(started.reason === "engine-not-alive" ? "引擎当前不在运行，无法开始自检。"
          : started.reason === "already-running" ? "已经有一次自检在进行中。"
            : "自检未开始：" + (started.reason || "原因未读取"));
      } catch { toast("自检未开始。"); }
      const device = bridgeCall("deviceInfo");
      if (device && typeof device === "object") state.device = device;
    },
    cancelKeepAliveProbe: () => {
      const bridge = window.AndroidBridge;
      if (!bridge || typeof bridge.cancelKeepAliveProbe !== "function") { toast("这个入口不在当前本机页面里，请更新 App 后再试。"); return; }
      try { bridge.cancelKeepAliveProbe(); toast("已取消本次自检。"); } catch { toast("取消未提交。"); }
      const device = bridgeCall("deviceInfo");
      if (device && typeof device === "object") state.device = device;
    },
    nativeWindowSnapshot: () => acceptedNativeWindow ? JSON.parse(JSON.stringify(acceptedNativeWindow)) : null,
  setSettingsTab(key) { state.settingsTab = key; render(); main.scrollTop = 0; },
    state, DETAILS, render, toast, signedIn, selected, accountName, shortTime, stateLabel, isPending, runningCount,
    draftGet, draftSet, parentGet, parentSet, updateDirty, sheetChanged, openMoonPanel, openDetail,
    captureDraftTarget,validateDraftTarget,applyDraftValue,registerDraftPicker,
    closeTopDialog, closeDialog, hasDialog, topDialog, dialogDepth: () => dialogFrames.length,
    topMoonFeedback, validateMoonFeedback: feedback => { const message = moonFeedbackProblem(feedback); return { ok: !message, message }; },
    rerenderMoonFeedback, navigateMoonSettings,
    detailDone, detailCancel, mountSheet: (html, onClose) => showMoonSheet(html, onClose), pushMoonLayer, orderStatus: key => orderStatusText(key), changeTab: (tab, id) => void changeTab(tab, id),
    /* 切换游戏号。迁入层的 choose:<id> 一直调 host.changeAccount，而这个成员从来没定义过，
       可选调用符让它既不报错也没反应 —— 点「切换」什么都不发生。这里补上真实实现，
       并显式区分"没带 ID"和"找不到这个号"，不再静默。 */
    changeAccount: id => {
      const target = String(id ?? "");
      if (!target) { toast("这个入口没有带上游戏号，请重新选择。"); return Promise.resolve(false); }
      if (!state.accounts.some(account => sameId(account.id, target))) { toast("找不到这个游戏号，刷新后再试。"); return Promise.resolve(false); }
      /* 返回 Promise，调用方（月色卡内「更多」）要等草稿真正换过来再开面板，
         否则会读到上一个号的读数。 */
      return changeTab(state.tab, target);
    },
    sheetKey: () => currentSheet()?.key || "", sheetDraft: () => currentSheet()?.draft || null, sheetOverlay:()=>currentSheet()?.overlay || null, inSheet: node => inSheet(node),
    rerenderSheet: () => { if (!renderSheet()) render(); }, pickAccount: () => accountPickerSheet(),
    catalog: () => ({ flowers: state.flowers, qualities: state.qualities, flowerArts: state.flowerArts, groupSizes: state.groupSizes, plantModes: state.plantModes,
      ready: state.catalogReady === true && Boolean(state.catalogSource && sameReadContext(state.catalogSource)), loading: state.catalogLoading === true,
      error: state.catalogError, source: state.catalogSource }),
    flowerId, buildId: () => CLIENT_BUILD_ID, main,
    /* 「我的」四行的右侧读数：沿用 renderMe 里同一套取法，读到什么报什么，读不到就说未读到。 */
    licenseLabel: () => { const info = softwareInfo(); return info ? (LICENSE_COPY[info.licenseState] || "状态未读到") : "状态未读到"; },
    syncLabel: () => { const info = softwareInfo(); const q = info?.queue; if (!info) return "未读到"; const pending = Number.isFinite(Number(q?.pending)) ? `${q.pending} 条` : "未读到"; return `待传 ${pending}${Number.isFinite(Number(q?.gapEvents)) ? ` · 缺口 ${q.gapEvents} 条` : ""}`; },
    serviceLabel: () => state.online ? (runningCount() ? `本机运行 · ${runningCount()} 个在跑` : "本机运行") : "未连接",
    egressLabel: () => { const route = state.egress; if (!route) return state.egressError ? "出口设置读取失败" : "出口设置尚未读取"; const label = route.routing === "proxy" ? `所有账号使用：${route.display}` : route.routing === "direct" ? "所有账号使用本机网络" : "尚未设置统一出口"; return state.online && !state.egressError ? label : `${label}（上次读取）`; },
    /* 短读数：与原型右列同密度；完整句子进各行详情，不在首页铺开。 */
    licenseShort: () => { const key = softwareInfo()?.licenseState; if (!Object.hasOwn(LICENSE_SHORT, key)) return "未读到"; return state.online ? LICENSE_SHORT[key] : `上次：${LICENSE_SHORT[key]}`; },
    syncShort: () => { const pending = softwareInfo()?.queue?.pending; if (pending === null || pending === undefined || pending === "" || typeof pending === "boolean" || !Number.isFinite(Number(pending))) return "未读到"; const label = `待传 ${pending} 条`; return state.online ? label : `上次：${label}`; },
    serviceShort: () => state.online ? (runningCount() ? `${runningCount()} 个在跑` : "本机运行") : "未连接",
    /* 服务面板的真实读数：与「运行服务」详情同一套字段来源，不把原型示例值当状态。
       连接、运行/等待数量、设备与通知/电池读数都现读；读不到返回 undefined，由面板显示未读取。 */
    serviceFacts: () => {
      const device = { ...(state.status?.device || {}), ...(state.device || {}) };
      const runtime = state.status?.runtime || {};
      const accounts = Array.isArray(state.accounts) ? state.accounts : [];
      return {
        online: state.online === true,
        running: accounts.filter(account => accountState(account) === "running").length,
        pending: accounts.filter(account => isPending(account)).length,
        service: device.serviceRunning ?? runtime.serviceRunning ?? runtime.running,
        foreground: device.foregroundServiceRunning ?? device.foregroundService ?? runtime.foregroundService,
        notifications: device.notificationsEnabled ?? device.notificationPermission,
        battery: device.batteryOptimizationExempt ?? device.ignoringBatteryOptimizations ?? device.batteryUnrestricted,
        android: device.androidVersion ?? device.release,
        model: device.model || device.deviceModel,
        lastRead: state.lastUpdated || null,
        /* 保活读数全部来自本机实际读取；缺字段就显示未读取，不按“应该已允许”补值。 */
        keepAlive: device.keepAlive && typeof device.keepAlive === "object" ? device.keepAlive : null,
        exactAlarms: device.keepAlive?.exactAlarmsAllowed,
        nextSelfCheckAtMs: device.keepAlive?.nextSelfCheckAtMs,
        selfCheckScheduled: device.keepAlive?.selfCheckScheduled,
        lastRecoveryAtMs: device.keepAlive?.lastRecoveryAtMs,
        lastRecoveryReason: device.keepAlive?.lastRecoveryReason,
        lastRecoveryOutcome: device.keepAlive?.lastRecoveryOutcome,
        engineAlive: device.keepAlive?.engine?.engineAlive,
        engineHeartbeatAgeMs: device.keepAlive?.engine?.heartbeatAgeMs,
        engineLastHealthAtMs: device.keepAlive?.engine?.lastHealthSampleAtMs,
        vpnEnabled: device.keepAlive?.vpn?.enabled,
        vpnActive: device.keepAlive?.vpn?.active,
        vpnReason: device.keepAlive?.vpn?.reason,
        manufacturer: device.keepAlive?.manufacturer,
        uiHeartbeatActive: device.keepAlive?.uiHeartbeat?.active,
        uiHeartbeatAgeMs: device.keepAlive?.uiHeartbeat?.ageMs,
        probe: device.keepAlive?.probe || null,
        screenKeepOn: device.keepAlive?.screenKeepOn,
        notificationChannel: device.keepAlive?.notificationChannel,
        reconnectWakeAtMs: device.keepAlive?.engine?.reconnectWakeAtMs,
        recoveryPending: device.keepAlive?.recoveryPending,
        vpnConsentGranted: device.keepAlive?.vpn?.consentGranted,
        vpnLastError: device.keepAlive?.vpn?.lastError,
        vpnFailureCount: device.keepAlive?.vpn?.failureCount,
      };
    },
    /* 服务面板的“刷新本机状态”原地重读，不关层。 */
    refreshNow: options => refreshFromUser(options),
    /* 我的页三张只读面板的真实来源：软件会话/日志队列/系统设置。 */
    licenseFacts: () => {
      const info = softwareInfo();
      if (!info) return null;
      return {
        username: info.user?.username || "未登录",
        state: LICENSE_COPY[info.licenseState] || "状态未读到",
        grace: Number.isFinite(Number(info.graceRemainingMs)) ? `${Math.max(0, Math.round(Number(info.graceRemainingMs) / 60000))} 分钟` : null,
        checkedAt: info.licenseCheckedAt || null,
        hardDeadlineAt: info.licenseHardDeadlineAt || null,
      };
    },
    syncFacts: () => {
      const q = softwareInfo()?.queue;
      if (!q) return null;
      const num = v => Number.isFinite(Number(v)) ? Number(v) : null;
      return {
        pending: num(q.pending), unowned: num(q.unowned), gap: num(q.gapEvents),
        lastUploadAt: q.lastUploadAt || null, baselineMs: num(q.baselineMs),
        quotaEvents: num(q.quotaEvents), quotaWarning: q.quotaWarning === true,
      };
    },
    egressShort: () => { const route = state.egress; if (!route) return state.egressError ? "读取失败" : "未读取"; const label = route.routing === "proxy" ? "已设代理" : route.routing === "direct" ? "本机网络" : "未设置"; return state.online && !state.egressError ? label : `上次：${label}`; },
    softwareInfo, readLogFilterCatalog, logSourceRef, logSourceOptions, logSourceView, logMeta: () => ({ loading: state.logsLoading, error: state.logsError, notice: state.logsNotice,
      continuation: state.logsContinuation, scope: state.logsScope, category: state.logsCategory, day: state.logsDay,
      keyword: state.logsKeyword, level: state.logsLevel, outcomeState: state.logsOutcome, errorCode: state.logsErrorCode,
      operationId: state.logsOperationId, traceId: state.logsTraceId, hasMore: state.logsHasMore, depth: state.logsStack.length }),
    filterLogsByCorrelation: (kind, value) => {
      if (!['traceId', 'operationId'].includes(kind) || typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,240}$/.test(value)) return;
      const record = state.selectedLogRecord;
      const scope = record?.scope || state.logsScope;
      if (scope !== state.logsScope) return;
      const logs = { scope, category: '', day: '', keyword: '', level: '', outcomeState: '',
        traceId: kind === 'traceId' ? value : '', operationId: kind === 'operationId' ? value : '' };
      const id = scope === 'device' || isArchivedLogRef(scope) ? undefined : String(record?.accountId ?? state.selectedId);
      void changeTab('logs', id, { context: accountChoiceContext(), logs });
    },
  };
  readNativeEngineState(); render(); bridgeCall("ready");
  void refresh({quiet:true}); void loadCatalog();
  window.setInterval(() => {
    if (document.hidden) return;
    // This observes an actual handshake, never promotes a connection after a delay.
    if (window.AndroidBridge && state.engine.phase !== "ready") readNativeEngineState();
    if ($("#software-auth-form") && (state.authRetryAt || !engineReady())) {
      if (state.authRetryAt && state.authRetryAt <= Date.now()) state.authRetryAt = 0;
      syncAuth();
    }
  }, 250);
  window.setInterval(() => {
    // No polling while hidden; this page never drives the game executor.
    // 弹层开着也要轮询：整页重画仍由 renderIfIdle 挡住，但启动/停止弹层要靠这次刷新
    // 读回真实状态（等待登录、运行中断、已运行），否则会永远停在“正在启动”。
    if (!document.hidden && !state.dirty && !state.busy && !state.egressEditing) {
      void refresh({quiet:true,includeDetails:state.tab === "logs" && onFirstLogsPage()});
    }
  },10000);
})();
