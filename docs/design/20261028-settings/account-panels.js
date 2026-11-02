/*
 * Design-only account, software, device and log panels.
 * Source inventory: ui/app.js:149-189, 596-748, 798-827, 879-940,
 * 1004-1050, 1094-1229, 1264-1288, 1304-1315.
 * Values below are layout examples. No credentials, API calls or persistence.
 */
(() => {
  const note = (label, description, tone) => ({ type: "note", label, description, ...(tone ? { tone } : {}) });
  const status = (label, value, description, tone) => ({ type: "status", label, value, ...(description ? { description } : {}), ...(tone ? { tone } : {}) });
  const action = (label, target, description, tone) => ({ type: "action", label, target, ...(description ? { description } : {}), ...(tone ? { tone } : {}) });
  const confirmClose = { label: "知道了", action: "close" };
  const backClose = { label: "返回", action: "close" };
  const cancelClose = { label: "取消", action: "close" };
  const licenseScenarios = [
    { id: "license-valid", label: "授权有效", tone: "success", description: "联网核对完成，可以按已保存设置手动开始。" },
    { id: "license-unactivated", label: "尚未取得授权", tone: "warning", description: "软件已登录，当前未读到可用运行资格。先核对授权。" },
    { id: "license-expired", label: "离线宽限到期", tone: "warning", description: "需要重新联网核对，当前不能继续新增游戏写入。" },
    { id: "license-disabled", label: "账号已停用", tone: "danger", description: "服务器已停用当前软件账号，本机不再接受新写入。" },
    { id: "license-offline", label: "离线宽限内", tone: "warning", description: "授权仍有效，显示剩余宽限；恢复网络后再核对。" },
    { id: "license-unverified", label: "期限待核实", tone: "warning", description: "离线宽限期限无法核实，需要联网核对。" }
  ];
  const panels = {
    "register": {
      title: "注册无尽夏", subtitle: "从这里，开启你的花园时光", group: "登录", kind: "sheet", scope: "form",
      fields: [
        note("软件账号", "这里注册的是无尽夏软件账号；游戏号在登录后单独添加。"),
        { type: "text", key: "username", label: "软件账号", placeholder: "设置软件账号", required: true, max: 32 },
        { type: "password", key: "password", label: "登录密码", placeholder: "设置密码（8 至 64 位）", required: true, min: 8, max: 64 },
        note("请勿输入真实凭据", "这是设计原型，输入仅留在当前页面内存，不提交注册。")
      ],
      primary: { label: "注册账号", action: "register-preview" }, secondary: { label: "返回登录", action: "close" },
      scenarios: [
        { id: "auth-register-loading", label: "注册中", description: "主按钮与账号、密码输入禁用，显示正在连接服务器。" },
        { id: "auth-register-success", label: "注册成功", tone: "success", description: "提示注册成功，请登录；返回登录并保留账号，清空密码。" },
        { id: "auth-error", label: "注册失败", tone: "danger", description: "表单顶部显示具体中文错误，保留账号供修改后重试。" }
      ]
    },
    "auth-help": {
      title: "登录帮助", subtitle: "软件身份和游戏账号分开管理", group: "登录", kind: "sheet",
      fields: [
        note("忘记软件密码", "请联系管理员重置软件账号密码。当前 App 没有自助短信找回入口。"),
        note("注册之后", "注册成功后返回登录，再进入你的软件账号。"),
        note("游戏账号在哪里？", "软件登录后，在「游戏号」中添加。游戏账号和密码保存在本机，不会因为软件登录自动开始任务。"),
        action("连接不上手机服务", "service-disconnected", "查看重新连接和手机服务状态"),
        action("云服务尚未配置", "auth-cloud-missing", "查看此设备暂时无法登录的原因")
      ], primary: confirmClose
    },
    "auth-login-loading": {
      title: "正在登录", subtitle: "设计示意 · 正在连接本项目云服务", group: "登录", kind: "sheet",
      fields: [status("登录状态", "正在连接服务器…", "账号、密码、显隐按钮与注册切换暂不可操作。"), note("稍候再试", "等待真实响应；登录成功也不会自动开启游戏任务。")],
      primary: { label: "查看成功反馈", action: "open-auth-login-success" }, secondary: backClose
    },
    "auth-register-loading": {
      title: "正在注册", subtitle: "设计示意 · 正在连接本项目云服务", group: "登录", kind: "sheet",
      fields: [status("注册状态", "正在连接服务器…", "请求处理中避免重复提交。"), note("注册完成后", "返回登录页；账号保留，密码清空。")],
      primary: { label: "查看注册结果", action: "open-auth-register-success" }, secondary: backClose
    },
    "auth-register-success": {
      title: "注册成功", subtitle: "设计示意 · 软件账号注册反馈", group: "登录", kind: "sheet",
      fields: [status("下一步", "请登录软件账号", "注册成功后不会自动登录或开始游戏任务。", "success")],
      primary: { label: "返回登录", action: "return-login" }
    },
    "auth-login-success": {
      title: "欢迎回园", subtitle: "设计示意 · 软件账号登录反馈", group: "登录", kind: "sheet",
      fields: [status("登录状态", "已登录", "种花、浇水、收花仍需在手机上手动点击开始。", "success"), note("本机资料", "登录后读取当前软件身份、授权与本机游戏号归属。")],
      primary: { label: "进入我的花园", action: "enter-accounts" }
    },
    "auth-error": {
      title: "暂时无法登录", subtitle: "设计示意 · 登录页内联错误", group: "登录", kind: "sheet",
      fields: [
        status("连接结果", "这台手机现在连不上本项目的云服务，请稍后再试。", "错误显示在账号表单顶部，账号输入保留。", "danger"),
        note("表单校验", "账号或密码为空时显示「请把软件账号和密码都填上」。"),
        action("查看登录帮助", "auth-help")
      ], primary: { label: "返回修改并重试", action: "close" }
    },
    "auth-cloud-missing": {
      title: "云服务尚未配置", subtitle: "设计示意 · 当前设备登录条件", group: "登录", kind: "sheet",
      fields: [status("云服务地址", "未配置", "这台手机还没有配置本项目的云服务地址，暂时无法登录。", "warning"), note("处理方式", "由本项目的设备配置入口补齐云服务信息后，再从正常登录页进入。原型不会创建地址或凭据。")], primary: confirmClose
    },
    "add-account": {
      title: "添加游戏号", subtitle: "先核对官服身份，再保存到本机", group: "账号", kind: "sheet", scope: "form",
      fields: [
        note("添加流程", "正式 App 会用填写的账号密码登录游戏一次，核对成功后才保存；区服由官服确认，不需要手动选择。"),
        { type: "text", key: "gameUsername", label: "游戏账号", placeholder: "输入官服登录账号", required: true, max: 160 },
        { type: "password", key: "gamePassword", label: "登录密码", placeholder: "输入游戏登录密码", required: true, max: 256 },
        { type: "text", key: "gameRemark", label: "账号备注", placeholder: "方便自己识别，选填", max: 40 },
        note("核对大约需要十几到几十秒", "只添加你有权使用的账号。密码不会显示在游戏号列表或运行日志中。"),
        note("原型演示", "请使用任意虚构文字体验表单。此处不连接官服、不保存账号或密码。")
      ], primary: { label: "登录核对并保存", action: "add-preview-account" }, secondary: { label: "先不添加", action: "close" },
      scenarios: [
        { id: "add-account-verifying", label: "登录核对中", description: "显示正在登录游戏核对；禁用重复提交；可关闭本次添加。" },
        { id: "add-account-success", label: "核对成功", tone: "success", description: "显示已保存的游戏昵称、区服与读取情况，进入当前游戏号设置。" },
        { id: "add-account-partial", label: "部分状态未读到", tone: "warning", description: "身份核对成功，但列明本次未读取的必要状态，不捏造库存或资源值。" },
        { id: "add-account-unverified", label: "未做登录核对", tone: "warning", description: "忠实保留已有保存但未核对的反馈，不显示核对成功。" },
        { id: "add-account-error", label: "添加失败", tone: "danger", description: "显示中文与官方脱敏诊断、清空密码，提供本机添加记录入口。" }
      ]
    },
    "add-account-verifying": {
      title: "正在核对游戏身份", subtitle: "设计示意 · 添加过程", group: "账号", kind: "sheet",
      fields: [status("官服登录", "正在登录游戏核对…", "通常需要十几到几十秒，请等待实际结果。"), note("核对内容", "确认登录成功与官服返回的身份、区服；读取不到的项目会单独列出。"), note("关闭本次添加", "关闭会取消本次页面等待并清空密码。再次操作前应先查看实际保存状态。")],
      primary: { label: "查看成功状态", action: "open-add-account-success" }, secondary: { label: "关闭本次添加", action: "close" }
    },
    "add-account-success": {
      title: "游戏号已添加", subtitle: "设计示意 · 无真实登录与保存", group: "账号", kind: "sheet",
      fields: [status("身份核对", "已登进游戏核对", "昵称、区服以官服本次返回为准。", "success"), status("游戏号", "示例游戏号", "仅用于原型版式展示。"), status("运行安排", "尚未开始", "先选择需要的功能，保存后再手动开始。")],
      primary: { label: "去设置功能", action: "view-land" }, secondary: { label: "返回游戏号", action: "close" }
    },
    "add-account-partial": {
      title: "已添加，部分状态未读到", subtitle: "设计示意 · 身份核对成功后的读取提示", group: "账号", kind: "sheet",
      fields: [status("登录核对", "已确认游戏身份", "可以进入设置；依赖未读取状态的候选操作暂不执行。", "success"), status("本次未读到", "配花库存 · 花瓶库存", "此处仅作状态缺失示例，正式页面逐项显示本次真实缺项。", "warning"), note("不会据此拒单", "状态读不到不能直接判定做不了；正常连接后再读取当前状态。")], primary: { label: "查看功能设置", action: "view-land" }
    },
    "add-account-unverified": {
      title: "已保存，未完成登录核对", subtitle: "设计示意 · 已有流程的非成功反馈", group: "账号", kind: "sheet",
      fields: [status("保存结果", "游戏号已保存", "这次没有做登录核对，因此不显示「核对成功」。", "warning"), note("下一步", "通过正常连接读取当前官服身份和状态；在真实资格明确后规划执行。")], primary: { label: "查看游戏号", action: "close" }
    },
    "add-account-error": {
      title: "这次没登进去", subtitle: "设计示意 · 账号没有保存", group: "账号", kind: "sheet",
      fields: [
        status("登录结果", "官方登录失败", "正式页面显示本次实际中文错误，密码输入清空。", "danger"),
        status("官方登录码", "以本次官服返回为准", "仅在官方实际提供时展示，不制造诊断编号。"),
        status("官方游戏码 / 返回码", "按实际返回显示", "若未提供，保持未提供；不把 HTTP 成功当作登录成功。"),
        status("官方原文", "官方未提供原文。", "如存在原文，凭据隐藏，超长内容截断；保留多行阅读空间。"),
        action("查看本机 / 添加记录", "logs-device", "核对本次添加的完整脱敏记录")
      ], primary: { label: "返回重新填写", action: "open-add-account" }, secondary: cancelClose
    },
    "account-more": {
      title: "游戏号管理", subtitle: "设计示意 · 当前选中的游戏号", group: "账号", kind: "sheet",
      fields: [
        status("当前游戏号", "跟随当前选择", "正式 App 展示当前昵称与已确认区服。"),
        action("功能设置", "account-settings-guide", "种花收花、交订单与花艺按账号独立保存"),
        action("运行记录", "logs-account", "查看当前游戏号的动作、等待与异常"),
        action("运行与恢复状态", "account-runtime", "查看连接、停止与等待恢复状态"),
        action("本机资料与执行保护", "account-protection", "同号单会话、当前状态与未确认记录说明"),
        { type: "divider", label: "账号操作" },
        action("移除这个游戏号", "remove-account", "从本机移除凭据、设置与运行安排；历史记录单独保留", "danger")
      ], primary: backClose
    },
    "account-settings-guide": {
      title: "当前游戏号设置", subtitle: "设计示意 · 设置按账号独立保存", group: "账号", kind: "sheet",
      fields: [note("三个设置分类", "种花收花、交订单、花艺共用当前账号的一份草稿；切换分类不清空未保存修改。"), note("保存与开始", "开关只修改草稿，保存不自动启动游戏号；保存后由你点击开始。")],
      primary: { label: "去功能设置", action: "view-land" }, secondary: backClose
    },
    "choose-account": {
      title: "选择游戏号", subtitle: "设计示意 · 仅切换当前查看对象", group: "账号", kind: "sheet", scope: "form",
      fields: [{ type: "select", key: "selectedAccount", label: "当前游戏号", value: "我的花园", options: [{ value: "我的花园", label: "我的花园", description: "示意账号 · 本机独立设置" }, { value: "向晚花园", label: "向晚花园", description: "示意账号 · 本机独立设置" }, { value: "晴天花园", label: "晴天花园", description: "示意账号 · 本机独立设置" }] }, note("切换范围", "设置与日志只展示所选账号。已有运行安排不会因切换查看对象而改变。")],
      primary: { label: "切换账号", action: "select-preview-account" }, secondary: cancelClose
    },
    "account-start": {
      title: "开始照料花园", subtitle: "设计示意 · 开始请求与运行状态分开展示", group: "账号", kind: "sheet",
      fields: [status("即将使用", "当前账号已保存的设置", "保存本身不会开始；点击后仍须读取实际连接与执行状态。"), note("开始之后", "先连接游戏，再根据当前状态安排任务。启动、连接和等待恢复都会显示在账号卡片上。"), action("本机执行与身份保护", "account-protection")],
      primary: { label: "开始运行（演示）", action: "start-preview-account" }, secondary: cancelClose,
      scenarios: [{ id: "account-starting", label: "启动中", description: "按钮显示处理中，账号状态进入正在启动或正在连接。" }, { id: "account-runtime", label: "实际运行状态", description: "请求提交后显示官服连接与任务状态，不能仅凭提示认定运行。" }, { id: "account-action-unknown", label: "启动结果未确认", tone: "warning", description: "超时或断线时先刷新读取，不重复点开始。" }]
    },
    "account-stop": {
      title: "停止当前任务", subtitle: "设计示意 · 随时撤销当前运行意图", group: "账号", kind: "sheet",
      fields: [status("停止范围", "当前游戏号", "停止本机任务并撤销该号的运行安排。"), note("当前在途", "以真实返回与实际停止状态为准；未确认的操作记录继续保留。"), note("等待中的账号也能停止", "正在启动、连接、排队、恢复、等待网络与允许登录时，都提供停止任务。")],
      primary: { label: "停止任务（演示）", action: "stop-preview-account" }, secondary: cancelClose,
      scenarios: [{ id: "account-stopping", label: "停止中", description: "按钮显示处理中；账号显示正在停止。" }, { id: "account-stopped", label: "已停止", tone: "success", description: "展示读回的实际停止状态。" }, { id: "account-action-unknown", label: "停止结果未确认", tone: "warning", description: "刷新读取实际状态；不以请求已提交代签停止成功。" }]
    },
    "account-starting": {
      title: "正在启动", subtitle: "设计示意 · 开始请求已提交", group: "账号", kind: "sheet",
      fields: [status("当前状态", "正在连接游戏", "启动请求已提交，请查看实际运行状态。"), note("任务还没开始？", "连接、排队与恢复仍属于保留运行安排，显示停止任务，不重复提供另一个开始按钮。"), action("查看运行记录", "logs-account")], primary: { label: "返回查看状态", action: "close" }
    },
    "account-stopping": {
      title: "正在停止", subtitle: "设计示意 · 停止请求已提交", group: "账号", kind: "sheet",
      fields: [status("当前状态", "正在停止任务…", "等待手机服务读回实际停止状态。"), note("保留记录", "已发生的游戏结果不回滚，未确认记录不清除。")], primary: { label: "返回查看状态", action: "close" }
    },
    "account-stopped": {
      title: "任务已停止", subtitle: "设计示意 · 实际状态反馈", group: "账号", kind: "sheet",
      fields: [status("当前状态", "已停止", "当前游戏号不再保留本次运行安排。", "success"), note("重新开始", "需要继续时，核对保存设置后手动开始。")], primary: confirmClose
    },
    "account-action-unknown": {
      title: "结果暂时无法确认", subtitle: "设计示意 · 启停请求超时或连接中断", group: "账号", kind: "sheet",
      fields: [status("处理结果", "先刷新查看实际状态", "请求可能已经到达手机服务，不重复提交来猜测结果。", "warning"), action("查看手机服务", "service"), action("查看当前账号记录", "logs-account")], primary: { label: "刷新状态（演示）", action: "refresh-preview" }, secondary: backClose
    },
    "account-runtime": {
      title: "账号运行状态", subtitle: "设计示意 · 每种等待都有明确含义", group: "账号", kind: "sheet",
      fields: [
        status("运行中", "已连接游戏", "按当前账号已保存且开启的功能安排执行。", "success"),
        status("正在启动 / 连接", "保留运行安排", "正在连接官服，不显示第二个开始按钮。"),
        status("等待运行 / 正在恢复", "条件满足后核对当前状态再继续", "可显示下次尝试时间；用户可随时停止。", "warning"),
        status("等待网络 / 允许登录", "暂未连接游戏", "等待不等同运行中，可随时停止任务。", "warning"),
        status("正在停止 / 需要重新停止", "继续核对实际停止结果", "不清除未确认记录。", "warning"),
        status("运行中断 / 已暂停", "查看本次具体原因", "根据本次可信状态处理，不用历史未确认永久拦住账号。", "danger"),
        status("未运行 / 已停止", "可按保存设置开始", "先保存当前修改。"),
        status("状态未读到", "刷新读取当前状态", "必要状态缺失仅限制依赖它的候选。", "warning")
      ], primary: confirmClose
    },
    "account-protection": {
      title: "本机资料与执行保护", subtitle: "设计说明 · 与现有项目约束一致", group: "账号", kind: "sheet",
      fields: [
        note("一个游戏号，一个执行会话", "接管前核对旧执行方已停止；当前真正的在途操作仍须串行。"),
        note("未确认记录会保留", "保留原操作与证据，不重发、不清账、不把未知改成成功。"),
        note("历史审计与当前执行分开", "正常连接后重新读取当前官服状态，合法业务按本次可信状态规划，不以所有历史旧账先核清为前提。"),
        note("只限制当前依赖", "缺少资格或必要状态时，仅限制依赖它的候选，不永久连坐整号。"),
        note("移除不是清账", "移除本机游戏号后，历史操作记录仍单独保留。删除重加不能绕过当前在途保护。"),
        action("查看当前账号日志", "logs-account")
      ], primary: confirmClose
    },
    "remove-account": {
      title: "移除这个游戏号？", subtitle: "设计示意 · 仅影响当前本机游戏号", group: "账号", kind: "confirm",
      fields: [note("将从本机移除", "这个游戏号的账号密码、设置与运行安排会从这台手机移除。", "danger"), note("历史记录仍保留", "历史操作记录单独保存；未确认操作不会因此清除。移除不会删除官服游戏角色。")],
      primary: { label: "确认移除", action: "remove-preview-account" }, secondary: { label: "先不删", action: "close" },
      scenarios: [{ id: "remove-account-busy", label: "移除中", description: "确认按钮禁用并显示正在移除，避免重复提交。" }, { id: "remove-account-success", label: "已移除", tone: "success", description: "关闭面板并刷新列表，提示已从这台手机移除。" }, { id: "remove-account-error", label: "移除失败", tone: "danger", description: "保留面板并恢复确认按钮，提示刷新后重试。" }]
    },
    "remove-account-busy": {
      title: "正在移除…", subtitle: "设计示意 · 请勿重复提交", group: "账号", kind: "sheet",
      fields: [status("当前操作", "正在移除本机游戏号", "历史操作记录继续保留。")], primary: backClose
    },
    "remove-account-success": {
      title: "已从这台手机移除", subtitle: "设计示意 · 本机列表反馈", group: "账号", kind: "sheet",
      fields: [status("移除结果", "本机游戏号已移除", "账号列表更新；官服角色与历史操作记录不因本机移除而删除。", "success")], primary: confirmClose
    },
    "remove-account-error": {
      title: "这个号没能移除", subtitle: "设计示意 · 保留原现场", group: "账号", kind: "sheet",
      fields: [status("移除结果", "请刷新后重试", "正式页面显示本次实际中文错误，恢复确认按钮。", "danger"), action("查看运行与停止状态", "account-runtime")], primary: { label: "刷新状态（演示）", action: "refresh-preview" }, secondary: backClose
    },
    "accounts-empty": {
      title: "先添加一个游戏号", subtitle: "设计示意 · 本机账号列表为空", group: "账号", kind: "sheet",
      fields: [note("从一座花园开始", "把游戏号保存在这台手机，再选择要自动执行的种花、浇水、收花等已授权功能。")], primary: { label: "添加游戏号", action: "open-add-account" }
    },
    "accounts-unreadable": {
      title: "暂时无法读取游戏号", subtitle: "设计示意 · 服务未连接", group: "账号", kind: "sheet",
      fields: [status("本机账号", "状态暂时无法确认", "手机运行服务还没连接，请重新连接后再操作。", "warning")], primary: { label: "重新连接（演示）", action: "refresh-preview" }
    },
    "unsaved-settings": {
      title: "设置还没有保存", subtitle: "离开当前账号或设置页前", group: "通用提示", kind: "confirm",
      fields: [note("要放弃这次修改吗？", "离开后将放弃当前未保存草稿，已经保存的设置不受影响。", "warning")],
      primary: { label: "放弃修改并离开", action: "discard-preview-draft" }, secondary: { label: "继续编辑", action: "close" }
    },
    "license": {
      title: "软件授权", subtitle: "设计示意 · 软件身份与运行资格", group: "我的", kind: "sheet",
      fields: [
        status("软件账号", "当前软件账号", "生产页面读取真实软件身份；不使用游戏昵称替代。"),
        status("授权状态", "有效", "本机离线约可继续 45 分钟，此数值仅为排版示意。", "success"),
        status("最近核对", "10 月 20 日 10:30", "示意时间；实际显示本次服务器核对时间。"),
        note("授权与任务", "授权有效后，仍需要你选择功能并手动开始游戏号。"),
        action("查看离线宽限说明", "license-offline"),
        action("本机历史资料归属", "data-ownership", "查看待确认资料与当前软件账号的关系")
      ], primary: { label: "立即核对授权", action: "check-preview-license" }, secondary: backClose, scenarios: licenseScenarios
    },
    "license-valid": {
      title: "软件授权有效", subtitle: "设计示意 · 已联网核对", group: "授权状态", kind: "sheet",
      fields: [status("当前资格", "有效", "可以按已保存设置手动开始；新账号功能仍默认关闭。", "success"), status("离线剩余", "约 45 分钟", "示意值；实际剩余以本机最新读取为准。"), note("稍后自动复核", "授权有效期间，App 也会按需要再次向服务器核对。")], primary: { label: "立即核对授权", action: "check-preview-license" }, secondary: backClose
    },
    "license-unactivated": {
      title: "尚未取得运行授权", subtitle: "设计示意 · 已登录但当前资格未读到", group: "授权状态", kind: "sheet",
      fields: [status("授权状态", "待核对", "当前未读到可用的运行资格，请先联网核对授权。", "warning"), note("登录与授权分开", "登录成功确认软件身份，运行资格以服务器最新结果为准。")], primary: { label: "立即核对授权", action: "check-preview-license" }, secondary: backClose
    },
    "license-expired": {
      title: "离线宽限已到期", subtitle: "设计示意 · 需要重新联网核对", group: "授权状态", kind: "sheet",
      fields: [status("离线剩余", "0 分钟", "需要重新联网核对登录资格，才能继续运行。", "warning"), note("保留现场", "本机游戏号、设置与未确认记录保留。重新联网后核对当前状态，不重发历史未知操作。")], primary: { label: "联网核对授权", action: "check-preview-license" }, secondary: backClose
    },
    "license-disabled": {
      title: "软件账号已停用", subtitle: "设计示意 · 当前软件资格已暂停", group: "授权状态", kind: "sheet",
      fields: [status("当前资格", "已停用", "这个软件账号已被停用，本机不再接受新的游戏写入。", "danger"), note("需要处理", "按本项目既有管理流程核对停用原因；不得通过换身份或新账号绕过。"), action("查看软件登录帮助", "auth-help")], primary: backClose
    },
    "license-offline": {
      title: "暂时离线，授权仍有效", subtitle: "设计示意 · 宽限期限已可核实", group: "授权状态", kind: "sheet",
      fields: [status("剩余离线宽限", "约 45 分钟", "以真实读回的剩余时间为准；到期需联网核对。", "warning"), note("恢复连接后", "本机会再向本项目云服务核对授权；日志保留在队列中，按同步节奏发送。"), action("查看手机服务状态", "service"), action("查看待传日志", "sync")], primary: { label: "现在核对授权", action: "check-preview-license" }, secondary: backClose
    },
    "license-unverified": {
      title: "授权期限待核实", subtitle: "设计示意 · 需联网读取可信期限", group: "授权状态", kind: "sheet",
      fields: [status("离线宽限", "无法核实", "已暂停新的游戏写入，请先联网核对。", "warning"), note("不会猜测剩余时间", "读不到期限时展示待核实，不能把未读到写成 0 或授权有效。")], primary: { label: "联网核对授权", action: "check-preview-license" }, secondary: backClose
    },
    "license-checking": {
      title: "正在核对授权…", subtitle: "设计示意 · 软件账号请求处理中", group: "授权状态", kind: "sheet",
      fields: [status("核对状态", "等待服务器返回", "本次软件请求尚未完成，不重复提交。")], primary: backClose
    },
    "license-error": {
      title: "授权核对未完成", subtitle: "设计示意 · 保留最后可信结果", group: "授权状态", kind: "sheet",
      fields: [status("核对结果", "这一步没有完成，请稍后再试。", "正式页面展示本次安全中文错误；无法核实的时间不会冒充有效。", "danger"), action("查看手机服务", "service")], primary: { label: "重新核对（演示）", action: "check-preview-license" }, secondary: backClose
    },
    "password": {
      title: "修改软件账号密码", subtitle: "这里修改软件密码，和游戏密码无关", group: "我的", kind: "sheet", scope: "form",
      fields: [
        note("改密后需要重新登录", "本机软件会话全部作废，正在运行的任务会先停止。", "warning"),
        { type: "password", key: "currentPassword", label: "当前密码", placeholder: "输入当前软件密码", required: true, max: 64 },
        { type: "password", key: "newPassword", label: "新密码", placeholder: "设置新密码（8 至 64 位）", required: true, min: 8, max: 64 },
        note("设计原型", "请勿输入真实密码。输入不联网、不持久化，关闭后清空。")
      ], primary: { label: "确认修改", action: "change-preview-password" }, secondary: { label: "先不改", action: "close" },
      scenarios: [{ id: "password-busy", label: "修改中", description: "按钮禁用并显示正在修改。" }, { id: "password-success", label: "修改成功", tone: "success", description: "关闭面板，清空密码，提示重新登录。" }, { id: "password-error", label: "修改失败", tone: "danger", description: "显示具体中文错误，恢复确认按钮，密码表单清空。" }]
    },
    "password-busy": {
      title: "正在修改密码…", subtitle: "设计示意 · 请等待本次结果", group: "我的", kind: "sheet",
      fields: [status("当前操作", "正在修改软件账号密码", "停止本机任务并使软件会话作废，完成后需重新登录。")], primary: backClose
    },
    "password-success": {
      title: "密码已修改", subtitle: "设计示意 · 软件会话已失效", group: "我的", kind: "sheet",
      fields: [status("修改结果", "请重新登录软件账号", "游戏密码没有修改；本机设置与历史记录保留。", "success")], primary: { label: "重新登录", action: "return-login" }
    },
    "password-error": {
      title: "密码没有改成", subtitle: "设计示意 · 实际错误在表单附近显示", group: "我的", kind: "sheet",
      fields: [status("修改结果", "请核对当前密码后重试", "正式页面显示真实中文原因，不能预判密码已修改。", "danger"), note("长度校验", "新密码需为 8 至 64 位。提交完成后密码输入清空。")], primary: { label: "重新填写", action: "open-password" }, secondary: backClose
    },
    "logout": {
      title: "退出软件账号？", subtitle: "退出前会先停止本机任务", group: "我的", kind: "confirm",
      fields: [note("将撤销运行安排", "先停止本机正在执行的任务，撤销已保留的运行安排。", "warning"), note("本机资料继续保留", "游戏密码、设置和历史记录仍留在这台手机上；未确认操作记录不会清除。再次登录不自动开始任务。")],
      primary: { label: "确认退出", action: "logout-preview" }, secondary: cancelClose,
      scenarios: [{ id: "logout-busy", label: "退出中", description: "显示正在退出；等待停止与退出结果。" }, { id: "logout-error", label: "退出未完成", tone: "danger", description: "保留当前身份，显示实际错误并刷新状态。" }]
    },
    "logout-busy": {
      title: "正在退出…", subtitle: "设计示意 · 先停止本机任务", group: "我的", kind: "sheet",
      fields: [status("当前操作", "停止任务并撤销运行安排", "不清除本机游戏资料或未确认记录。")], primary: backClose
    },
    "logout-error": {
      title: "退出尚未完成", subtitle: "设计示意 · 身份与任务状态待刷新", group: "我的", kind: "sheet",
      fields: [status("退出结果", "这一步没有完成，请稍后再试。", "先读取实际软件身份和本机任务状态。", "danger")], primary: { label: "刷新状态（演示）", action: "refresh-preview" }, secondary: backClose
    },
    "sync": {
      title: "日志同步", subtitle: "设计示意 · 本机队列状态", group: "我的", kind: "sheet",
      fields: [
        status("待传日志", "128 条", "示意值，实际从本机队列读取。"),
        status("未归属日志", "6 条", "未确认归属的记录不会上传。", "warning"),
        status("日志缺口", "0 条", "只有真实缺口才展示非零数，不将缺口当作已传。"),
        status("上次同步", "10 月 20 日 10:30:00", "尚未同步时显示「还没有同步过」。"),
        status("同步节奏", "约 30 秒一批", "所有日志共用 1 分钟发送额度；此处为版式示例。"),
        status("同步配额", "未达上限的八成", "实际展示当前待传数量、真实上限与八成预警。"),
        action("确认本机资料归属", "data-ownership", "只在存在待确认历史资料时展示操作"),
        action("查看本机 / 添加记录", "logs-device")
      ], primary: { label: "立即上传日志", action: "upload-preview-logs" }, secondary: backClose,
      scenarios: [{ id: "sync-empty", label: "没有待传日志", tone: "success", description: "显示 0 条与上次同步时间，不显示虚假的新上传记录。" }, { id: "sync-warning", label: "配额八成预警", tone: "warning", description: "列出实际待传数和上限，保留缺口与未归属字段。" }, { id: "sync-busy", label: "上传中", description: "显示正在上传运行记录，防止重复提交。" }, { id: "sync-success", label: "上传完成", tone: "success", description: "明确本次送出条数，不等同清空全部队列。" }, { id: "sync-error", label: "同步失败", tone: "danger", description: "保留待传队列，显示实际错误并可重试。" }]
    },
    "sync-empty": {
      title: "没有待传日志", subtitle: "设计示意 · 队列为空", group: "日志同步", kind: "sheet",
      fields: [status("待传日志", "0 条", "当前没有等待上传的已归属记录。", "success"), status("未归属日志", "0 条"), status("日志缺口", "0 条"), status("上次同步", "按实际读取时间显示", "未发生过同步时显示还没有同步过。")], primary: backClose
    },
    "sync-warning": {
      title: "待传日志接近配额", subtitle: "设计示意 · 八成预警", group: "日志同步", kind: "sheet",
      fields: [status("同步配额", "待传 800 条 / 上限 1,000 条", "仅用于展示八成预警；生产页面读取实际队列与配额。", "warning"), status("未归属日志", "6 条", "确认归属前不上传。"), status("日志缺口", "0 条", "如出现缺口，按真实记录说明。"), note("上传节奏", "全部日志共用发送额度；立即上传仍按服务端结果显示本次实际送出条数。")], primary: { label: "立即上传日志", action: "upload-preview-logs" }, secondary: backClose
    },
    "sync-busy": {
      title: "正在上传运行记录…", subtitle: "设计示意 · 等待本次同步结果", group: "日志同步", kind: "sheet",
      fields: [status("当前操作", "正在处理本机待传队列", "请求处理中不重复提交。")], primary: backClose
    },
    "sync-success": {
      title: "本次日志已送出", subtitle: "设计示意 · 按实际条数反馈", group: "日志同步", kind: "sheet",
      fields: [status("这次送出", "32 条运行记录", "示意值；其余记录继续按队列与额度发送。", "success"), note("仍有待传？", "本次完成不代表全部队列已清空。回到日志同步查看最新待传、未归属与缺口状态。")], primary: { label: "查看队列状态", action: "open-sync" }
    },
    "sync-error": {
      title: "日志暂时未能送出", subtitle: "设计示意 · 本机队列保留", group: "日志同步", kind: "sheet",
      fields: [status("本次同步", "这一步没有完成，请稍后再试。", "显示实际中文错误；未送出的日志继续保留。", "danger"), action("查看软件授权", "license"), action("查看资料归属", "data-ownership")], primary: { label: "重新上传（演示）", action: "upload-preview-logs" }, secondary: backClose
    },
    "data-ownership": {
      title: "本机资料归属", subtitle: "设计示意 · 当前软件身份与历史资料", group: "我的", kind: "sheet",
      fields: [status("当前软件账号", "当前登录的软件身份", "使用软件账号，不能拿管理员或游戏昵称替代。"), status("待确认游戏号", "2 个", "仅为布局示意；生产页面以本机实际待归属资料为准。", "warning"), status("未归属日志", "6 条", "确认前不会上传未归属记录。", "warning"), note("确认的影响", "把本机待归属游戏资料关联到当前软件账号。确认前不会恢复旧任务或上传未归属记录；确认也不会自动创建新的运行意图。"), note("历史未知仍保留", "归属变更不清除原操作与证据，也不把未知写标成成功。")],
      primary: { label: "确认归属到当前软件账号", action: "claim-preview-data" }, secondary: { label: "稍后处理", action: "close" },
      scenarios: [{ id: "data-ownership-busy", label: "确认中", description: "显示正在确认归属，等待实际结果。" }, { id: "data-ownership-success", label: "归属已确认", tone: "success", description: "按实际迁入数量提示；需要时重新连接本机执行器。" }, { id: "data-ownership-empty", label: "没有待确认资料", description: "本机已经没有待确认的历史资料。" }, { id: "data-ownership-error", label: "归属未完成", tone: "danger", description: "不变更归属，保留现场并显示具体错误。" }]
    },
    "data-ownership-busy": {
      title: "正在确认归属…", subtitle: "设计示意 · 处理本机历史资料", group: "资料归属", kind: "sheet",
      fields: [status("当前操作", "等待归属确认结果", "未确认记录与原证据持续保留。")], primary: backClose
    },
    "data-ownership-success": {
      title: "本机资料归属已确认", subtitle: "设计示意 · 不代表自动开始任务", group: "资料归属", kind: "sheet",
      fields: [status("确认结果", "本机 2 个游戏号归到当前软件账号", "示意数量；正式页面显示实际迁入数量。", "success"), note("重新连接执行器", "若归属变化需要重连，显示正在重新连接本机执行器；不支持自动重连时提示重新打开 App。"), note("开始由你决定", "按当前账号真实状态与保留意图核对，不恢复已撤销业务意图。")], primary: confirmClose
    },
    "data-ownership-empty": {
      title: "没有待确认的历史资料", subtitle: "设计示意 · 当前无需迁入", group: "资料归属", kind: "sheet",
      fields: [status("归属状态", "本机已经没有待确认的历史资料", "不重复迁入或制造新的资料归属。", "success")], primary: confirmClose
    },
    "data-ownership-error": {
      title: "归属尚未确认", subtitle: "设计示意 · 本机资料保持原状", group: "资料归属", kind: "sheet",
      fields: [status("确认结果", "这一步没有完成，请稍后再试。", "正式页面显示具体中文原因；未归属记录不上传。", "danger")], primary: { label: "重新核对（演示）", action: "open-data-ownership" }, secondary: backClose
    },
    "service": {
      title: "手机运行服务", subtitle: "设计示意 · 数据以本机实际读取为准", group: "我的", kind: "sheet",
      fields: [
        status("手机服务", "已连接", "示意状态，不代表设备现场。", "success"),
        status("游戏已连接", "1 个账号", "只统计真正已连接并运行的游戏号。"),
        status("待连接或恢复", "1 个账号", "等待状态单独统计，可随时停止。", "warning"),
        status("后台运行服务", "已启动"), status("持续运行通知", "已开启"),
        status("通知权限", "已允许"), status("电池优化", "已允许持续运行"),
        status("手机型号", "Xiaomi 15", "原型目标机型示意，未读取真机。"),
        status("系统版本", "Android · 以本机读数为准", "尚未读取时显示未读取，不以目标机型推测系统版本。"),
        status("最近读取", "10 月 20 日 10:30:00", "示意时间，读取失败显示未读取。"),
        action("后台运行与电池设置", "battery"), action("未连接时怎么办", "service-disconnected")
      ], primary: { label: "刷新本机状态", action: "refresh-preview" }, secondary: backClose,
      scenarios: [{ id: "service-loading", label: "首次读取", description: "先显示品牌与正在读取本机运行服务，不闪业务面板。" }, { id: "service-disconnected", label: "服务未连接", tone: "warning", description: "提示重新连接，不能把缓存账号显示为已确认运行。" }, { id: "service-unread", label: "部分状态未读取", tone: "warning", description: "单项显示未读取，不用否定值或假正常替代。" }]
    },
    "service-loading": {
      title: "正在读取手机状态", subtitle: "设计示意 · 首次进入", group: "本机运行", kind: "sheet",
      fields: [status("本机服务", "正在读取本机运行服务…"), status("软件身份", "等待本机读回", "软件身份未读到时不展示业务面板。")], primary: { label: "重新连接（演示）", action: "refresh-preview" }
    },
    "service-disconnected": {
      title: "手机服务未连接", subtitle: "设计示意 · 当前不能确认账号运行状态", group: "本机运行", kind: "sheet",
      fields: [status("本机连接", "未连接", "请先重新连接服务，再查看游戏号是否仍在运行。", "warning"), note("重新连接", "App 会尝试重新连接本机执行器。网络、超时或连接校验失效时仍以重新读取的实际结果为准。"), note("连接校验失效", "若显示连接校验已失效，请重新打开 App。不会直接重新发送游戏操作。")], primary: { label: "重新连接（演示）", action: "refresh-preview" }, secondary: backClose
    },
    "service-unread": {
      title: "部分设备状态未读取", subtitle: "设计示意 · 单项缺失不假报正常", group: "本机运行", kind: "sheet",
      fields: [status("后台运行服务", "未读取"), status("持续运行通知", "未读取"), status("通知权限", "未读取"), status("电池优化", "未读取"), note("读取规则", "状态不明确时显示未读取。返回 App 或手动刷新后重新读取当前设备状态。")], primary: { label: "重新读取（演示）", action: "refresh-preview" }, secondary: backClose
    },
    "battery": {
      title: "允许 App 在后台运行", subtitle: "锁屏或切换应用后，仍需系统允许", group: "我的", kind: "sheet",
      fields: [
        status("通知权限", "已允许（示意）", "让持续运行通知正常显示。"),
        status("电池策略", "不限制（示意）", "按当前手机系统设置允许后台活动。"),
        { type: "list", label: "需要检查", options: [
          { value: "notifications", label: "允许通知", description: "检查系统通知权限与持续运行通知。" },
          { value: "battery", label: "电池策略设为不限制", description: "具体名称以当前系统为准。" },
          { value: "background", label: "允许后台活动", description: "检查本机后台运行设置，返回后重新读状态。" }
        ] },
        note("系统强行停止", "在系统中强行停止会停止 App，需要重新打开；不能保证自动复活或无限保活。", "warning"),
        note("需要按设备验证", "雷电只提供模拟器结果，不能替代 Xiaomi / HyperOS 真机稳定性验收。")
      ], primary: { label: "查看系统设置引导", action: "open-background-settings" }, secondary: backClose,
      scenarios: [{ id: "background-settings", label: "打开系统设置", description: "在安卓 App 中打开当前设备的系统设置；原型只展示引导。" }, { id: "background-settings-error", label: "系统页未打开", tone: "warning", description: "提供从手机设置手动进入 App 后台管理的提示。" }]
    },
    "background-settings": {
      title: "前往手机系统设置", subtitle: "设计示意 · 不在原型内修改设备权限", group: "本机运行", kind: "sheet",
      fields: [note("在正式 Android App 中", "点击后打开手机系统的后台运行设置。按该系统的名称检查通知、后台活动和电池限制。"), note("返回 App 后", "重新读取设备状态，显示实际是否已允许；不因为打开了设置页就标记成功。"), status("浏览器原型", "不会打开或修改系统权限", "此面板展示跳转前后应有的完整说明。")], primary: { label: "返回查看设备状态", action: "open-service" }, secondary: backClose
    },
    "background-settings-error": {
      title: "设置页面未能打开", subtitle: "设计示意 · 原生桥接不可用或系统跳转失败", group: "本机运行", kind: "sheet",
      fields: [status("跳转结果", "请从手机设置进入这个 App 的后台管理", "浏览器中显示请在安卓 App 中打开，或手动进入手机设置。", "warning"), note("手动路径", "手机设置 → 应用 → 无尽夏 → 通知 / 电池 / 后台活动。实际名称以当前系统为准。")], primary: confirmClose
    },
    "network": {
      title: "统一网络出口", subtitle: "全部游戏号共用这台手机的出口设置", group: "我的", kind: "sheet", scope: "form",
      fields: [
        status("当前方式", "本机网络（示意）", "已配置代理时显示脱敏地址；敏感账号密码不回显。"),
        { type: "password", key: "proxy", label: "出口 IP / 代理地址", placeholder: "IP:端口 或 http://代理地址", required: true, description: "此处输入仅用于设计演示，请勿输入真实代理口令。" },
        note("适用范围", "应用到本机所有游戏号。地址留空不能提交；使用「改用本机网络」清除已配置出口。"),
        action("改用本机网络", "network-clear", "清除统一代理配置"),
        action("查看代理已配置状态", "network-proxy", "完整地址只在必要内存传递，不把口令写入提示或日志")
      ], primary: { label: "应用到所有账号", action: "apply-preview-network" }, secondary: cancelClose,
      scenarios: [{ id: "network-loading", label: "应用中", description: "显示应用中，统一禁用冲突操作。" }, { id: "network-proxy", label: "代理已应用", tone: "success", description: "显示脱敏代理出口，清空敏感输入。" }, { id: "network-direct", label: "已改用本机网络", tone: "success", description: "清除配置并提示全部账号已改用本机网络。" }, { id: "network-error", label: "保存失败", tone: "danger", description: "在出口设置旁显示具体中文错误，可修改后重试。" }, { id: "network-unread", label: "出口未读取", tone: "warning", description: "尚未读取当前出口时禁用应用，提示刷新。" }]
    },
    "network-clear": {
      title: "改用本机网络", subtitle: "设计示意 · 清除统一代理出口", group: "网络出口", kind: "confirm",
      fields: [note("影响所有游戏号", "清除统一代理配置后，本机所有游戏号使用手机当前网络。")], primary: { label: "改用本机网络", action: "clear-preview-network" }, secondary: cancelClose
    },
    "network-loading": {
      title: "正在应用网络出口…", subtitle: "设计示意 · 统一出口保存中", group: "网络出口", kind: "sheet",
      fields: [status("当前操作", "应用中", "等待本机服务返回后，清空敏感输入并读回脱敏出口状态。")], primary: backClose
    },
    "network-proxy": {
      title: "统一出口已应用", subtitle: "设计示意 · 不使用真实网络地址", group: "网络出口", kind: "sheet",
      fields: [status("全部账号使用", "已配置的代理出口", "当前出口按安全脱敏后的地址显示，口令不会回显。", "success"), status("敏感输入", "已清空", "保存结束后只保留脱敏显示。")], primary: { label: "返回出口设置", action: "open-network" }
    },
    "network-direct": {
      title: "已改用本机网络", subtitle: "设计示意 · 清除统一代理后的反馈", group: "网络出口", kind: "sheet",
      fields: [status("全部账号使用", "本机网络", "统一代理配置已清除，此处为原型演示。", "success")], primary: confirmClose
    },
    "network-error": {
      title: "出口设置未保存", subtitle: "设计示意 · 输入旁显示真实错误", group: "网络出口", kind: "sheet",
      fields: [status("保存结果", "出口设置未保存，请重试。", "空输入时提示请输入出口 IP:端口或完整代理地址。其他错误按本次安全中文原因显示。", "danger"), note("不改变显示结果", "失败时不显示应用成功，不把地址或口令写进错误提示。")], primary: { label: "返回修改", action: "open-network" }, secondary: backClose
    },
    "network-unread": {
      title: "出口设置暂时未读取", subtitle: "设计示意 · 当前方式无法确认", group: "网络出口", kind: "sheet",
      fields: [status("当前出口", "未读到", "手机服务未连接或出口读取失败时禁用应用。", "warning"), note("重新读取", "恢复本机连接并刷新，读取当前出口后再操作。")], primary: { label: "刷新状态（演示）", action: "refresh-preview" }, secondary: backClose
    },
    "log-filters": {
      title: "筛选运行日志", subtitle: "筛选完整记录来源，每次回到第一页", group: "日志", kind: "sheet", scope: "form",
      fields: [
        { type: "select", key: "logSource", label: "查看记录", value: "device", options: [{ value: "device", label: "本机 / 添加记录", description: "软件连接、账号添加与本机异常" }, { value: "我的花园", label: "我的花园", description: "示意游戏号" }, { value: "向晚花园", label: "向晚花园", description: "示意游戏号" }, { value: "晴天花园", label: "晴天花园", description: "示意游戏号" }] },
        { type: "select", key: "logCategory", label: "分类", value: "", options: [{ value: "", label: "全部分类" }, ...["种花", "浇水", "收花", "订单", "花艺", "日常奖励", "连接", "启停", "设置", "状态核对", "异常", "其他"].map(label => ({ value: label, label }))] },
        { type: "select", key: "logDay", label: "日期", value: "", options: [{ value: "", label: "全部日期" }, { value: "2026-10-20", label: "2026-10-20（示意）" }, { value: "2026-10-19", label: "2026-10-19（示意）" }], description: "正式页面只列服务端现读确实有记录的日期，不手工制造空白日期。" },
        note("分页规则", "每页 15 条；变更来源、类别或日期时回到第一页，筛选不只作用于当前这 15 条。")
      ], primary: { label: "查看筛选结果", action: "apply-preview-log-filters" }, secondary: { label: "清除筛选", action: "clear-preview-log-filters" },
      scenarios: [{ id: "logs-loading", label: "读取中", description: "保留筛选栏，列表显示正在读取运行日志。" }, { id: "logs-empty", label: "没有记录", description: "没有筛选时解释本机添加、连接异常和操作进度的记录位置。" }, { id: "logs-filter-empty", label: "筛选结果为空", description: "可换类别、日期或清除筛选，不暗示原日志消失。" }, { id: "logs-error", label: "读取失败", tone: "danger", description: "显示中文错误与重新读取，禁用无法确认的下一页。" }, { id: "logs-pagination", label: "分页边界", description: "第一页上页禁用，末页下页禁用，读取中两者禁用。" }]
    },
    "log-categories": {
      title: "日志分类", subtitle: "完整分类 · 设计示意", group: "日志", kind: "sheet", scope: "form",
      fields: [{ type: "chips", key: "logCategory", label: "选择一个分类", value: "", options: [{ value: "", label: "全部" }, ...["种花", "浇水", "收花", "订单", "花艺", "日常奖励", "连接", "启停", "设置", "状态核对", "异常", "其他"].map(label => ({ value: label, label }))] }, note("类别来源", "沿用当前 App 的全部 12 类日志；不是只筛当前页的可见行。")], primary: { label: "应用分类", action: "apply-preview-log-filters" }, secondary: backClose
    },
    "logs-device": {
      title: "本机 / 添加记录", subtitle: "设计示意 · 当前查看来源", group: "日志", kind: "sheet",
      fields: [note("这里记录什么", "账号添加失败、连接异常、软件操作和本机服务事件保存到对应本机记录。"), action("筛选来源、分类与日期", "log-filters"), action("查看读取失败状态", "logs-error")], primary: { label: "去本机日志", action: "view-device-logs" }, secondary: backClose
    },
    "logs-account": {
      title: "当前游戏号日志", subtitle: "设计示意 · 跟随当前选中游戏号", group: "日志", kind: "sheet",
      fields: [note("这里记录什么", "查看当前游戏号实际动作、暂未执行原因、状态核对与异常。实际结果以官服确认与持久记录为准。"), note("记录标签", "错误为需要处理，警告为请留意，完成为已完成，其余为运行记录；颜色同时配文字。"), action("筛选来源、分类与日期", "log-filters"), action("阅读记录详情示例", "log-detail")], primary: { label: "去当前账号日志", action: "view-account-logs" }, secondary: backClose
    },
    "log-detail": {
      title: "运行记录", subtitle: "设计示意 · 展示信息层级，不伪造官服结果", group: "日志", kind: "sheet",
      fields: [status("记录时间", "10 月 20 日 10:30:00", "示意时间"), status("所属游戏号", "当前选中游戏号"), status("分类", "状态核对"), status("状态", "请留意", "用文字和颜色同时表达，避免只依赖颜色。", "warning"), note("记录内容示例", "正在读取当前官服状态；依赖未读取状态的候选暂缓，其余合法候选独立规划。"), note("完整记录", "长说明可以在这里连续阅读。记录内容保留，不提供修改操作结果的入口。")], primary: confirmClose
    },
    "logs-loading": {
      title: "正在读取运行日志…", subtitle: "设计示意 · 筛选栏保持可见", group: "日志状态", kind: "sheet",
      fields: [status("当前读取", "正在读取运行日志…", "显示列表骨架；分页按钮禁用，等待实际结果。")], primary: backClose
    },
    "logs-empty": {
      title: "还没有记录", subtitle: "设计示意 · 当前来源尚无日志", group: "日志状态", kind: "sheet",
      fields: [note("记录会出现在这里", "账号添加失败、连接异常和实际操作进度会保存在对应记录中。"), action("切换日志来源", "log-filters")], primary: backClose
    },
    "logs-filter-empty": {
      title: "这个筛选下没有记录", subtitle: "设计示意 · 历史记录不会因筛选而消失", group: "日志状态", kind: "sheet",
      fields: [note("试试更换条件", "换一个分类或日期，或者清除筛选查看全部记录。"), action("修改筛选条件", "log-filters")], primary: { label: "清除筛选", action: "clear-preview-log-filters" }, secondary: backClose
    },
    "logs-error": {
      title: "运行日志暂时无法读取", subtitle: "设计示意 · 列表读取错误", group: "日志状态", kind: "sheet",
      fields: [status("读取结果", "运行日志暂时无法读取，请重新读取。", "实际错误只显示安全中文，不暴露堆栈、地址、凭据或令牌。", "danger"), note("分页状态", "当前失败后清除无法确认的下页游标，不让用户继续翻到不可信结果。")], primary: { label: "重新读取（演示）", action: "reload-preview-logs" }, secondary: backClose
    },
    "logs-pagination": {
      title: "日志翻页", subtitle: "设计示意 · 每页 15 条", group: "日志状态", kind: "sheet",
      fields: [status("第一页", "上一页禁用", "下一页仅在服务端确认有更旧记录与有效游标时可用。"), status("中间页", "上一页 / 下一页可用", "显示第 N 页；翻页后回到列表顶部。"), status("最后一页", "下一页禁用", "不制造更多日志。"), status("读取中", "上一页 / 下一页均禁用", "避免并发翻页改变当前筛选。"), note("自动刷新", "第一页可刷新最新记录；查看旧页时不自动跳回最新页。")], primary: confirmClose
    },
    "help": {
      title: "使用说明", subtitle: "软件身份、游戏号与本机运行各有入口", group: "我的", kind: "sheet",
      fields: [action("登录与注册", "auth-help"), action("游戏号与执行保护", "account-protection"), action("授权与离线宽限", "license"), action("日志同步与资料归属", "sync"), action("后台运行与系统设置", "battery"), note("原型数据", "所有账号、数量、时间与状态均为设计示意。没有连接软件云服务、官服、设备或真实账号。")], primary: confirmClose
    }
  };
  // Keep state navigation and explicit panel targets in the common renderer's format.
  for (const spec of Object.values(panels)) {
    if (spec.scenarios && !spec.related) {
      spec.related = spec.scenarios.map(({ id, label }) => ({ label, target: id }));
    }
    for (const button of [spec.primary, spec.secondary]) {
      if (button?.action?.startsWith("open-")) {
        button.target = button.action.slice(5);
        button.action = "open-panel";
      }
    }
    for (const field of spec.fields || []) {
      if (field.type === "list" && field.options && !field.items) {
        field.items = field.options.map(({ label, description }) => ({ label, value: description || "" }));
      }
    }
  }
  window.GARDEN_PANEL_SPECS = Object.assign(window.GARDEN_PANEL_SPECS || {}, panels);
})();
