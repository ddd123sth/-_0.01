// 无尽夏安卓端专用管理后台 · 离线检查
// 不启动浏览器：跑构建脚本、核产物、查隔离闸，再单测纯逻辑层与会话处置。
// 这些只是辅助判据，不能替代雷电模拟器上连官服的真实实测。
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const adminDir = path.join(projectRoot, "admin");
const srcDir = path.join(adminDir, "src");
const distDir = path.join(adminDir, "dist");
const buildScript = path.join(projectRoot, "tools", "build-admin.mjs");
const scratchDir = path.join(projectRoot, ".runtime", "admin-console-test");

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const read = (file) => fs.readFileSync(file, "utf8");

function runBuild() {
  const result = spawnSync(process.execPath, [buildScript], { cwd: projectRoot, encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

const firstBuild = runBuild();
const console_ = await import(pathToFileURL(path.join(srcDir, "console.mjs")).href);
const session = await import(pathToFileURL(path.join(srcDir, "session.mjs")).href);
const views = await import(pathToFileURL(path.join(srcDir, "views.mjs")).href);
const build = await import(pathToFileURL(buildScript).href);

function tagBodies(html) {
  return (html.match(/<[^>]+>/g) || []);
}

/* 内联事件与内联样式只能活在标签体里：接口数据经 esc() 后只剩实体文本，
 * 所以判据要落在标签体上，既不会被转义后的数据误报，也拦得住真的 onclick="..."。 */
function assertNoInlineMarkup(html, label) {
  const inlineHandlers = tagBodies(html).filter((tag) => /\son[a-z]+\s*=/i.test(tag));
  const inlineStyles = tagBodies(html).filter((tag) => /\sstyle\s*=/i.test(tag));
  assert.deepEqual(inlineHandlers, [], `${label} 的标签体里不得有内联事件属性`);
  assert.deepEqual(inlineStyles, [], `${label} 的标签体里不得有内联样式`);
  assert.deepEqual(tagBodies(html).filter((tag) => /<script|<iframe|<object|<embed/i.test(tag) && !/<script[^>]*\bsrc\s*=[^>]*>/i.test(tag)), [], `${label} 不得内嵌脚本或可嵌外框的标签`);
}

/* ==================== 1. 构建产物与清单 ==================== */

test("构建脚本产出 admin/dist 并写出 sha256 清单", () => {
  assert.equal(firstBuild.status, 0, `构建退出码应为 0，实际输出：${firstBuild.stderr || firstBuild.stdout}`);
  assert.ok(fs.existsSync(path.join(distDir, "manifest.json")), "缺少 manifest.json");
  const manifest = JSON.parse(read(path.join(distDir, "manifest.json")));
  assert.equal(manifest.service, "wujinxia-app-admin");
  assert.equal(manifest.entry, "index.html");
  assert.deepEqual(manifest.CSP, ["script-src 'self'", "style-src 'self'", "connect-src 'self'", "frame-ancestors 'none'"]);
  assert.equal(manifest.files.length, build.ALLOWED.length, "清单文件数应等于允许文件数");
  assert.deepEqual(manifest.files.map((file) => file.path).slice().sort(), [...build.ALLOWED].sort());
  assert.deepEqual(walk(distDir).filter((relative) => relative.endsWith(".mjs")), [], "产物里不得留 .mjs：云服务静态 MIME 表只认 .js");
  for (const file of manifest.files) {
    const target = path.join(distDir, file.path);
    assert.ok(fs.existsSync(target), `产物缺文件：${file.path}`);
    const disk = fs.readFileSync(target);
    assert.equal(file.sha256, sha256(disk), `${file.path} 的清单哈希与磁盘内容不一致`);
    assert.equal(file.bytes, disk.byteLength, `${file.path} 的清单字节数与磁盘内容不一致`);
    const emitted = Buffer.from(build.emitText(read(path.join(srcDir, file.source))), "utf8");
    assert.equal(file.sha256, sha256(emitted), `${file.path} 与源码经扩展名替换后的内容不一致`);
    assert.equal(file.source.replace(/\.mjs$/, ".js"), file.path, `${file.source} 的产物名映射不对`);
  }
  // 模块图完整性：产物里每个 import 与入口脚本都要指得到清单里的实际文件。
  const listed = new Set(manifest.files.map((file) => file.path));
  for (const file of manifest.files) {
    const text = read(path.join(distDir, file.path));
    for (const specifier of text.match(/from "\.\/[^"]+"|src="[^"]+"/g) || []) {
      const name = specifier.replace(/^from "\.\//, "").replace(/^src="/, "").replace(/"$/, "");
      assert.ok(listed.has(name), `${file.path} 引用了产物里不存在的 ${name}`);
    }
  }
});

test("重复构建幂等：清单与每个文件哈希逐字节相同", () => {
  const before = read(path.join(distDir, "manifest.json"));
  const beforeHashes = new Map(JSON.parse(before).files.map((file) => [file.path, file.sha256]));
  const second = runBuild();
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const after = read(path.join(distDir, "manifest.json"));
  assert.equal(after, before, "重复构建的 manifest.json 应当逐字节相同（清单里不得带时间戳）");
  for (const file of JSON.parse(after).files) {
    assert.equal(beforeHashes.get(file.path), file.sha256);
    assert.equal(file.sha256, sha256(fs.readFileSync(path.join(distDir, file.path))));
  }
});

test("构建清掉产物目录里的陈旧文件，dist 除清单外不多出任何文件", () => {
  fs.mkdirSync(distDir, { recursive: true });
  const stale = path.join(distDir, "stale-from-previous-version.txt");
  const staleDir = path.join(distDir, "old-sub");
  fs.writeFileSync(stale, "旧版残留\n", "utf8");
  fs.mkdirSync(staleDir, { recursive: true });
  fs.writeFileSync(path.join(staleDir, "also-stale.mjs"), "export const gone = 1;\n", "utf8");
  const rebuilt = runBuild();
  assert.equal(rebuilt.status, 0, rebuilt.stderr || rebuilt.stdout);
  assert.equal(fs.existsSync(stale), false, "旧版残留文件必须被构建清掉");
  assert.equal(fs.existsSync(staleDir), false, "旧版残留目录必须被构建清掉");
  const manifest = JSON.parse(read(path.join(distDir, "manifest.json")));
  const expected = [...manifest.files.map((file) => file.path), "manifest.json"].sort();
  assert.deepEqual(walk(distDir), expected, "admin/dist 里除了清单列出的文件与 manifest.json 不该有多余文件");
});

/* ==================== 2. 静态与隔离检查 ==================== */

test("dist/index.html 没有内联脚本体、内联事件与内联样式", () => {
  const html = read(path.join(distDir, "index.html"));
  const scriptTags = html.match(/<script[^>]*>/gi) || [];
  assert.ok(scriptTags.length >= 1, "入口页应当以外部模块脚本装载代码");
  for (const tag of scriptTags) {
    assert.match(tag, /\bsrc\s*=/i, `脚本标签必须走外部文件：${tag}`);
  }
  const withoutExternal = html.replace(/<script[^>]*\bsrc\s*=[^>]*>\s*<\/script>/gi, "");
  assert.doesNotMatch(withoutExternal, /<script/i, "不得有内联 script 体（CSP：script-src 'self'）");
  assert.doesNotMatch(html, /<script[^>]*>(?!\s*<\/script>)/i, "脚本标签与闭合标签之间不得有内容（CSP：script-src 'self'）");
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "不得有内联事件属性");
  assert.doesNotMatch(html, /(\sstyle\s*=|<style)/i, "不得有内联样式（CSP：style-src 'self'）");
  assert.doesNotMatch(html, /javascript:/i, "不得使用 javascript: 地址");
  assert.match(html, /<link[^>]*href="styles\.css"/i, "样式必须走外部 CSS");
  assert.match(html, /<script type="module" src="app\.js"><\/script>/, "入口脚本要指得到产物里真实存在的模块");
  assert.equal(html.includes(".mjs"), false, "产物页面不得引用 .mjs：静态服务会按 octet-stream 发，浏览器拒收模块");
});

test("dist 全部文件不含绝对地址与原站禁词", () => {
  for (const relative of walk(distDir)) {
    const text = read(path.join(distDir, relative));
    for (const token of ["http://", "https://", "wdhysj.cn", "xunhupay", "api-admin.js", "auth-routes.js"]) {
      assert.equal(text.includes(token), false, `${relative} 含禁词 ${token}`);
    }
    assert.equal(text.includes("我的花园世界"), false, `${relative} 含参考仓库目录名：产物不得指向参考目录`);
  }
  const api = read(path.join(distDir, "api.js"));
  assert.match(api, /"\/api\/admin"/, "接口层必须以相对路径 /api/admin 为前缀");
  assert.doesNotMatch(api, /\bfetch\s*\(\s*["'`][A-Za-z][A-Za-z0-9+.-]*:/i, "请求地址不得带协议前缀");
  assert.doesNotMatch(api, /\blocalhost\b|127\.0\.0\.1|:\d{2,5}\b/, "不得写死主机或端口");
});

test("构建脚本的隔离闸确实会拦下违规内容", () => {
  assert.deepEqual(build.isolationProblems("index.html", "<div>正常</div>"), []);
  const offenders = [
    ["index.html", `<script>alert(1)</script>`],
    ["index.html", `<a onclick="evil()">x</a>`],
    ["index.html", `<div style="color:red">x</div>`],
    ["api.mjs", "const url = \"https://wdhysj.cn/api/admin/login\";"],
    ["views.mjs", "import { handler } from \"../../server/src/api-admin.js\";"],
    ["app.mjs", "fetch(\"https://pay.xunhupay.com/v1/trade\")"],
    ["styles.css", "/* 参考 D:/AI/AiCode/我的花园世界/web/src/styles/tokens.css */"],
  ];
  for (const [name, text] of offenders) {
    assert.ok(build.isolationProblems(name, text).length > 0, `${name} 的违规内容应当被拦下：${text}`);
  }
  // 产物闸：扩展名没替换干净也要拦下，否则浏览器按 octet-stream 拒收模块。
  assert.ok(build.emitProblems("app.mjs", "app.js", 'import "./console.js";').length === 0);
  assert.ok(build.emitProblems("app.mjs", "app.js", 'import "./console.mjs";').length > 0, "残留 .mjs 引用必须被拦");
  assert.ok(build.emitProblems("index.html", "index.html", '<script type="module" src="app.mjs"></script>').length > 0, "入口指错文件必须被拦");
  assert.equal(build.emitText('import { esc } from "./console.mjs";'), 'import { esc } from "./console.js";');
  assert.deepEqual(build.SOURCES.filter((name) => !build.MODULES.includes(name) && name !== "index.html" && name !== "styles.css"), [], "除 HTML、CSS 与模块外不许有别的产物类型");
});

/* ==================== 3. 纯逻辑单测 ==================== */

test("导航名册恰好三个入口，名称齐全且没有第四个", () => {
  assert.deepEqual(console_.NAV.map((item) => item.label), ["用户管理", "运行日志", "后台设置"]);
  assert.equal(console_.NAV.length, 3, `后台只允许三个入口，实际 ${console_.NAV.length} 个`);
  assert.deepEqual(console_.NAV.map((item) => item.route), ["#/users", "#/logs", "#/settings"]);
  assert.equal(new Set(console_.NAV.map((item) => item.key)).size, 3);
  for (const item of console_.NAV) {
    assert.ok(item.tip.length > 8, `${item.label} 的说明要写清这一页做什么`);
    assert.equal(/["']/.test(item.label + item.tip), false, "中文文案里不嵌 ASCII 双引号");
  }
  assert.equal(console_.DEFAULT_ROUTE, "#/users");
  assert.equal(console_.navByRoute("#/logs").label, "运行日志");
  assert.equal(console_.navByKey("nope"), null);
  assert.equal(console_.normalizeRoute("#/billing"), console_.DEFAULT_ROUTE, "名册外的路由一律回默认页，不凭空造第四页");
  // 渲染层出的导航链接也必须正好三条。
  const shell = views.shellView({ ...state(), route: "#/users" }, "<p>x</p>");
  assert.equal((shell.match(/<nav\b/gi) || []).length, 1, "只有一组主导航");
  assert.equal((shell.match(/href="#\/(users|logs|settings)"/g) || []).length, 3, "侧栏导航链接必须恰好三条");
  assert.doesNotMatch(shell, /工作台|游戏账号管理|设备管理/, "不增加工作台、游戏账号管理或设备管理页面");
  const disclaimer = "后台不提供远程登录游戏、读取游戏密码、远程改花种、启动游戏任务或接管失联手机的入口。";
  assert.ok(shell.includes(disclaimer), "外壳要把禁止入口这句话写明");
  const withoutDisclaimer = shell.split(disclaimer).join("");
  assert.doesNotMatch(withoutDisclaimer, /远程登录游戏|读取游戏密码|远程改花种|启动游戏任务|接管失联/, "禁止入口只许出现在限定句里，不能做成能点的控件");
});

test("日志筛选参数构造：每项都下发、可组合、空值不发、时间转 ISO", () => {
  const filters = {
    userId: "12",
    installId: "install-12",
    stableId: "stable-7",
    nickname: "可可",
    serverName: "夏日",
    from: "2026-10-01T08:30",
    to: "2026-10-02 19:05:07",
    level: "error",
    category: "浇水",
    errorCode: "SESSION_REVOKED",
    traceId: "run-2026-10-01-a",
    operationId: "op-2026-10-01-a",
    eventState: "failed",
    outcomeState: "unconfirmed",
    attempted: "true",
    q: "harvest 失败",
  };
  const query = console_.buildLogQuery(filters, 3, 50);
  for (const key of console_.LOG_FILTER_KEYS) {
    assert.ok(query.includes(`&${key}=`) || query.includes(`?${key}=`), `${key} 应出现在查询串里`);
  }
  assert.match(query, /from=2026-10-01T08%3A30%3A00/, "补齐到秒的 ISO 时刻");
  assert.match(query, /to=2026-10-02T19%3A05%3A07/);
  assert.match(query, /page=3/);
  assert.match(query, /pageSize=50/);
  assert.match(query, /q=harvest%20%E5%A4%B1%E8%B4%A5/);
  // 包括精确安装/操作关联与独立事件状态筛选的十六个可组合字段。
  assert.equal(console_.LOG_FILTER_KEYS.filter((key) => query.includes(`${key}=`)).length, 16);
  const empty = console_.buildLogQuery({ userId: "", nickname: "   ", level: "", q: "", from: "", to: "" }, 0, 9999);
  assert.equal(empty, "?page=1&pageSize=100", "空值不下发，pageSize 上限 100，page 下限 1");
  assert.equal(console_.buildLogQuery({}, 1, 0), "?page=1&pageSize=20", "非法每页条数回默认 20");
  assert.equal(console_.buildLogQuery({}, 1, 7).includes("pageSize=7"), true);
  assert.equal(console_.buildLogQuery({ from: "不是时刻" }, 1, 20), "?page=1&pageSize=20", "读不出的时间不下发，不猜");
  assert.equal(console_.normalizeIso("2026-10-01"), "2026-10-01T00:00:00");
  assert.equal(console_.normalizeIso("2026-10-01T08:30:15.400Z"), "2026-10-01T08:30:15.400Z");
  assert.equal(console_.normalizeIso(""), "");
  assert.equal(console_.buildRunQuery("trace-1"), "?traceId=trace-1");
  assert.equal(console_.buildRunQuery("trace-1", "42", "inst-1"), "?traceId=trace-1&userId=42&installId=inst-1");
});

test("用户搜索查询串与 hash 路由解析", () => {
  assert.equal(console_.buildUserQuery("", 1, 20), "?page=1&pageSize=20");
  assert.equal(console_.buildUserQuery("  苦瓜大王  ", 2, 10), "?q=%E8%8B%A6%E7%93%9C%E5%A4%A7%E7%8E%8B&page=2&pageSize=10");
  assert.equal(console_.buildUserQuery("x", 0, 100000), "?q=x&page=1&pageSize=100");
  assert.equal(console_.buildHash("#/logs", { userId: "12" }), "#/logs?userId=12");
  assert.deepEqual(console_.parseHash("#/logs?userId=12&page=2"), { route: "#/logs", query: { userId: "12", page: "2" } });
  assert.equal(console_.parseHash("#/whatever").route, console_.DEFAULT_ROUTE);
  assert.equal(console_.parseHash("").route, console_.DEFAULT_ROUTE);
  assert.equal(console_.logFiltersFromQuery({ userId: "9" }).userId, "9");
  assert.equal(console_.logFiltersFromQuery({ userId: "9" }).q, "");
  assert.equal(console_.activeFilterCount({ q: " a ", level: "", from: "" }), 1);
});

test("分页页码计算", () => {
  assert.equal(console_.pageCount(0, 20), 1);
  assert.equal(console_.pageCount(1, 20), 1);
  assert.equal(console_.pageCount(40, 20), 2);
  assert.equal(console_.pageCount(41, 20), 3);
  assert.deepEqual(console_.pageRange(41, 3, 20), { from: 41, to: 41, total: 41, totalPages: 3, page: 3, pageSize: 20 });
  assert.deepEqual(console_.pageRange(41, 2, 20).from, 21);
  assert.equal(console_.pageRange(0, 1, 20).from, 0);
  assert.deepEqual(console_.pageWindow(1, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(console_.pageWindow(10, 20), [1, 0, 9, 10, 11, 0, 20]);
  assert.deepEqual(console_.pageWindow(1, 20), [1, 2, 0, 20]);
  assert.deepEqual(console_.pageWindow(20, 20), [1, 0, 19, 20]);
  for (const pages of [console_.pageWindow(1, 20), console_.pageWindow(10, 20), console_.pageWindow(20, 20)]) {
    assert.ok(pages.filter((entry) => entry !== 0).includes(1), "页码条要能跳到第一页");
    assert.ok(pages.filter((entry) => entry !== 0).includes(20), "页码条要能跳到最后一页");
  }
  assert.equal(console_.clampPageSize(101), 100);
  assert.equal(console_.clampPageSize("-3"), 20);
  assert.deepEqual(console_.PAGE_SIZE_CHOICES, [10, 20, 50, 100]);
});

test("错误码到中文提示映射，只按 code 判分支", () => {
  assert.equal(console_.errorCodeText("SESSION_REVOKED"), "会话已被撤销，请重新登录");
  assert.equal(console_.errorCodeText("SOFTWARE_DISABLED"), "该软件用户已被停用");
  assert.equal(console_.errorCodeText("LOG_BATCH_TOO_LARGE"), "单批日志超出大小限制");
  assert.equal(console_.errorCodeText("EVENT_CONFLICT"), "同一事件标识收到不同内容，原记录未被覆盖");
  assert.equal(console_.errorCodeText("INPUT_INVALID").includes("不符合要求"), true);
  assert.equal(console_.errorCodeText("MYSTERY_CODE"), "未登记错误码：MYSTERY_CODE", "未登记的码要原样带出，不编造结论");
  assert.equal(console_.errorCodeText(""), "未给出错误码");
  assert.equal(console_.isSessionFailure("SESSION_EXPIRED"), true);
  assert.equal(console_.isSessionFailure("INPUT_INVALID"), false);
  for (const [code, text] of Object.entries(console_.ERROR_CODE_TEXT)) {
    assert.ok(text.length > 3, `${code} 的中文提示不能是空的`);
    assert.equal(/["']/.test(text), false, `${code} 的文案里不嵌 ASCII 双引号`);
  }
});

test("脱敏渲染：界面出不了原文密码", () => {
  const fake = {
    id: 1,
    userId: 12,
    installId: "install-abc",
    occurredAt: "2026-10-19T01:02:03Z",
    receivedAt: "2026-10-19T01:02:05Z",
    level: "error",
    category: "login",
    message: "登录失败 password=abc123 已按白名单掩码",
    diagnostic: 'authorization: Bearer SuperSecretToken99, refresh_token="rt-abcdef123456"',
    appVersion: "0.9.1",
    errorCode: "SOFTWARE_LOGIN_FAILED",
    traceId: "run-1",
    operationId: "op-1",
    outcome: { sent: 3, confirmed: 2, unconfirmed: 1 },
    isError: true,
  };
  const excerpt = console_.logExcerpt(fake);
  assert.equal(excerpt.includes("abc123"), false, "渲染文本里不得出现原文密码");
  assert.ok(excerpt.includes(console_.MASK_MARK), "掩码标记要出现在渲染文本里");
  assert.match(excerpt, /password=〔已脱敏〕/);
  const rows = console_.logDetailRows(fake);
  const rendered = JSON.stringify(rows);
  for (const leak of ["abc123", "SuperSecretToken99", "rt-abcdef123456"]) {
    assert.equal(rendered.includes(leak), false, `脱敏诊断里漏出 ${leak}`);
  }
  assert.ok(rows.some((row) => row.label === "脱敏诊断" && row.value.includes(console_.MASK_MARK)));
  assert.ok(rows.some((row) => row.label === "来源安装标识" && row.value === "install-abc"));
  assert.ok(rows.some((row) => row.label === "来源" && row.value.includes("手机上报")));
  const hashA = "a".repeat(64), hashB = "b".repeat(64);
  const typedRows = console_.logDetailRows({ ...fake, diagnostic: { domainId: "profile", difference: "same-response-projection-changed",
    changedPaths: [{ path: "profile.uid", storedFingerprint: hashA, currentFingerprint: hashB }], removedPaths: [], addedPaths: [],
    priorProjectionReceiptAvailable: true } });
  assert.ok(typedRows.some((row) => row.label === "原投影收据存在" && row.value === "是"));
  assert.ok(typedRows.some((row) => row.label === "值或来源差异" && row.value.includes(hashA) && row.value.includes(hashB)));
  assert.ok(typedRows.some((row) => row.label === "本次未投影字段" && row.value === "无"));
  assert.ok(typedRows.some((row) => row.label === "新增字段" && row.value === "无"));
  // 渲染层出的整页 HTML 同样不能带出原文
  const html = views.logsView(logsState(fake));
  assert.equal(html.includes("abc123"), false, "整页 HTML 里不得出现原文密码");
  assert.equal(html.includes("SuperSecretToken99"), false);
  assert.ok(html.includes(console_.MASK_MARK));
  assert.equal(console_.maskSecrets("stableId=7 nickname=可可 traceId=run-1"), "stableId=7 nickname=可可 traceId=run-1", "排障字段不该被一起抹掉");
  assert.equal(console_.containsSecret("password=hunter2"), true);
  assert.equal(console_.containsSecret("种花完成"), false);
  assert.equal(console_.esc('<b>"x"</b>'), "&lt;b&gt;&quot;x&quot;&lt;/b&gt;");
  assert.equal(console_.esc(undefined), "");

  // 用户名与备注这类接口数据必须转义后才进 DOM，脚本片段进不了页面。
  const hostile = { id: 7, username: '<b>x</b><img src=x onerror="alert(1)">', enabled: true, createdAt: "2026-10-01T00:00:00Z", remark: "排障备注 password=abc123" };
  const usersHtml = views.usersView({ ...state(), users: { ...state().users, data: { items: [hostile], total: 1, page: 1, pageSize: 20 }, openId: "7" } });
  assert.equal(usersHtml.includes("<b>x</b>"), false, "接口给的尖括号必须转义后再进 DOM");
  assert.ok(usersHtml.includes("&lt;b&gt;x&lt;/b&gt;"));
  assert.equal(usersHtml.includes("abc123"), false, "备注里的原文密码不得出现在 HTML 里");
  assertNoInlineMarkup(usersHtml, "用户管理页");
  assertNoInlineMarkup(html, "运行日志页");
});

test("日志为空时的措辞只说没收到，不替手机与官服下结论", () => {
  const emptyState = {
    logs: { filters: console_.cleanLogFilters({}), page: 1, pageSize: 20, loading: false, error: "", data: { items: [], total: 0 }, expanded: new Set(), run: { traceId: "", items: [], loading: false, error: "" } },
  };
  const html = views.logsView({ ...state(), ...emptyState, route: "#/logs" });
  const notice = console_.noRecentLogsNotice();
  assert.ok(html.includes(notice), "空态要带上只说没收到的那句限定");
  assert.ok(html.includes(console_.logAcceptedNotice()), "要写明上传成功只代表云端保存成功");
  // 把两句限定本身去掉后，页面其他地方一个字都不许再替手机或官服下结论。
  const rest = html.split(notice).join("").split(console_.logAcceptedNotice()).join("");
  for (const banned of ["已停止", "已离线", "已关机", "已断开", "操作成功", "已成功", "运行正常"]) {
    assert.equal(rest.includes(banned), false, `界面措辞不得断言 ${banned}`);
  }
  assert.ok(html.includes("手机上报"));
  assert.ok(html.includes("云端只确认收到"));
});

test("设置校验：保留期限 1 到 3650 整数，载荷只带允许的键", () => {
  assert.deepEqual(console_.validateDays("30", "普通记录保留天数"), { ok: true, value: 30, error: "" });
  assert.equal(console_.validateDays("0").ok, false);
  assert.equal(console_.validateDays("3651").ok, false);
  assert.equal(console_.validateDays("1").ok, true);
  assert.equal(console_.validateDays("3650").ok, true);
  assert.equal(console_.validateDays("30.5").ok, false, "只收整数天");
  assert.equal(console_.validateDays("").ok, false);
  assert.equal(console_.validateDays("abc").ok, false);
  assert.deepEqual(console_.buildSettingsPayload({ allowRegistration: false, normalDays: 30, errorDays: 90 }), {
    allowRegistration: false,
    retention: { normalDays: 30, errorDays: 90 },
  });
  assert.deepEqual(Object.keys(console_.buildSettingsPayload({ sessionTtlMinutes: 30, graceHours: 24 })), [], "非契约键一律不发");
  assert.deepEqual(console_.buildSettingsPayload({ allowRegistration: true }), { allowRegistration: true });
  assert.equal(console_.validateNewPassword("short").ok, false);
  assert.equal(console_.validateNewPassword("GoodPassw0rd!").ok, true);
  assert.equal(console_.validateNewPassword("with space here").ok, false);
  assert.equal(console_.validateNewPassword("demo1234", "demo1234").ok, false, "新密码不能等于用户名");
});

test("时刻与大小格式：读不到就明说读不到", () => {
  assert.match(console_.formatTime("2026-10-19T01:02:03Z"), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(console_.formatTime(""), console_.DASH);
  assert.equal(console_.formatTime("乱写的时刻"), console_.DASH);
  assert.equal(console_.levelText("error"), "错误");
  assert.equal(console_.levelText("unknown"), "未标注级别");
  assert.equal(console_.isErrorRecord({ level: "error" }), true);
  assert.equal(console_.isErrorRecord({ isError: false, level: "error" }), false, "服务端结论优先于猜");
  assert.equal(console_.outcomeText({ sent: 3, confirmed: 2, unconfirmed: 1 }), "发出 3 · 已确认 2 · 未确认 1");
  assert.equal(console_.outcomeText(undefined), "");
  assert.equal(console_.formatBytes(2048), "2.0 KiB");
  assert.equal(console_.formatBytes(undefined), console_.DASH);
  const backup = console_.describeBackup({});
  assert.equal(backup.hasResult, false);
  assert.ok(backup.lines[0].value.includes("不能推断"));
  const okBackup = console_.describeBackup({ lastAt: "2026-10-18T20:00:00Z", ok: true, sizeBytes: 1048576, sha256: "ab12", detail: "一致性快照已加密外传" });
  assert.equal(okBackup.hasResult, true);
  assert.equal(okBackup.lines.find((line) => line.label === "结果").value, "成功");
  assert.equal(okBackup.lines.find((line) => line.label === "大小").value, "1.0 MiB");
});

/* ==================== 4. 会话处置 ==================== */

test("管理员会话只存在内存变量里，不碰浏览器本地存储", () => {
  const source = read(path.join(srcDir, "session.mjs"));
  assert.deepEqual(console_.findStorageUsage(source), [], "session.mjs 里不得出现浏览器本地存储调用");
  const appSource = read(path.join(srcDir, "app.mjs"));
  assert.deepEqual(console_.findStorageUsage(appSource), [], "入口层也不得写浏览器本地存储");

  assert.equal(session.isLoggedIn(), false);
  assert.equal(session.readAccessToken(), "");
  session.clearSession();

  const described = session.startSession({
    accessToken: "adm-access-token-value",
    accessExpiresAt: "2026-10-19T02:00:00Z",
    refreshToken: "adm-refresh-token-value",
    refreshExpiresAt: "2026-10-26T02:00:00Z",
    admin: { id: 1, username: "wx_admin" },
  });
  assert.deepEqual(described, { loggedIn: true, admin: "wx_admin", accessExpiresAt: Date.parse("2026-10-19T02:00:00Z"), hasRefreshToken: true });
  assert.equal(JSON.stringify(described).includes("adm-access-token-value"), false, "对外返回的会话描述里不得带令牌原文");
  assert.equal(session.isLoggedIn(), true);
  assert.equal(session.whoami(), "wx_admin");
  assert.equal(session.readAccessToken(), "adm-access-token-value");
  assert.equal(session.shouldRefresh(Date.parse("2026-10-19T01:00:00Z")), false);
  assert.equal(session.shouldRefresh(Date.parse("2026-10-19T01:59:40Z")), true, "距到期 30 秒内要提前续期");
  assert.equal(session.isExpired(Date.parse("2026-10-19T01:00:00Z")), false);
  assert.equal(session.isExpired(Date.parse("2026-10-19T02:00:01Z")), true);
  assert.equal(session.secondsUntilAccessExpiry(Date.parse("2026-10-19T01:59:00Z")), 60);

  const beforeFailure = session.describe();
  assert.throws(() => session.startSession({ accessToken: "" }), /缺少访问令牌/, "没有访问令牌就不能算登录成功");
  assert.deepEqual(session.describe(), beforeFailure, "回包不合格时既不新建会话，也不把已有会话改成半条");
  session.clearSession();
  assert.equal(session.isLoggedIn(), false, "清除后内存里不留任何令牌");
  assert.throws(() => session.startSession({ accessExpiresAt: "2026-10-19T02:00:00Z" }), /缺少访问令牌/);
  assert.equal(session.isLoggedIn(), false);

  session.startSession({ accessToken: "t2", accessExpiresAt: "2026-10-19T02:00:00Z", refreshToken: "r2", admin: { username: "b" } });
  assert.deepEqual(session.invalidate(), { loggedIn: false, admin: "", accessExpiresAt: 0, hasRefreshToken: false });
  assert.equal(session.readAccessToken(), "");
  assert.equal(session.readRefreshToken(), "");
  assert.equal(session.isLoggedIn(), false);
  assert.equal(session.isExpired(), true, "没有会话就是不可用");
  assert.equal(session.shouldRefresh(Date.parse("2026-10-19T01:00:00Z")), false, "没有会话就无从续期");
  assert.equal(session.secondsUntilAccessExpiry(), null);
  assert.throws(() => session.startSession({ accessToken: "" }), /缺少访问令牌/, "没有访问令牌就不能算登录成功");
  assert.equal(session.isLoggedIn(), false, "失败的登录不能留下半条会话");
  session.clearSession();
  assert.equal(session.isLoggedIn(), false);
});

test("本地存储扫描尺有效：摘掉尺就翻红", () => {
  fs.mkdirSync(scratchDir, { recursive: true });
  const source = read(path.join(srcDir, "session.mjs"));
  const copyPath = path.join(scratchDir, "session-with-storage.mjs");
  fs.writeFileSync(copyPath, `${source}\nwindow.sessionStorage.setItem("token", "x");\n`, "utf8");
  const hits = console_.findStorageUsage(read(copyPath));
  assert.ok(hits.length > 0, "把 sessionStorage 塞进副本后扫描必须报错；报错的尺本身失效了");
  assert.ok(hits.some((hit) => /sessionStorage/i.test(hit.token)));
  assert.ok(console_.findStorageUsage("localStorage.getItem('t')").length > 0);
  assert.ok(console_.findStorageUsage("document.cookie = 'x'").length > 0);
  assert.deepEqual(console_.findStorageUsage("没有用到任何浏览器本地存储"), []);
  // 尺本身失效的自检：去掉注入行的副本必须仍然干净
  assert.deepEqual(console_.findStorageUsage(read(path.join(srcDir, "session.mjs"))), []);
  fs.rmSync(copyPath, { force: true });
});

test("入口页与登录页把刷新后要重新登录这件事说清楚", () => {
  const html = read(path.join(distDir, "index.html"));
  assert.match(html, /Content-Security-Policy/, "入口页自带 CSP，与云服务一致");
  assert.match(html, /script-src 'self'; style-src 'self'/);
  const login = views.loginView({ loginError: "", busy: "" });
  assert.ok(login.includes("只保存在本页内存里"));
  assert.ok(login.includes("需要重新登录"));
  assert.ok(login.includes("浏览器本地存储不写任何凭据"));
  assert.doesNotMatch(login, /localStorage|sessionStorage/);
  assert.equal(/<script/i.test(login), false);
  assert.equal(/\son[a-z]+\s*=/i.test(login), false);
  assert.equal(/\sstyle\s*=/i.test(login), false, "渲染出的 HTML 不带内联样式");
});

/* ==================== 5. 入口模块装载冒烟（Node 里替身 DOM，不开浏览器） ==================== */

const SMOKE_SCRIPT = String.raw`
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const SRC = __SRC__;
const serviceBase = new URL("../", pathToFileURL(SRC + "/api.js")).pathname.replace(/\/+$/, "");
const listeners = {};
const fetched = [];
let hashValue = "";
const element = { className: "", innerHTML: "" };

globalThis.document = {
  getElementById: () => element,
  addEventListener: (type, handler) => { listeners[type] = handler; },
};
globalThis.window = {
  location: { get hash() { return hashValue; }, set hash(value) { hashValue = value; } },
  addEventListener: (type, handler) => { listeners[type] = handler; },
};
// 浏览器本地存储一旦被子类代码碰到就直接抛错：这是运行时尺，摘掉就翻红。
for (const name of ["localStorage", "sessionStorage", "indexedDB"]) {
  Object.defineProperty(globalThis.window, name, { get() { throw new Error("界面代码访问了浏览器本地存储：" + name); } });
  Object.defineProperty(globalThis, name, { get() { throw new Error("界面代码访问了浏览器本地存储：" + name); } });
}
Object.defineProperty(globalThis.document, "cookie", {
  get() { throw new Error("界面代码读了 document.cookie"); },
  set() { throw new Error("界面代码写了 document.cookie"); },
});

const USERS = { items: [{ id: 42, username: "<b>x</b>", enabled: true, createdAt: "2026-10-01T00:00:00Z", lastLoginAt: null, remark: "排障备注 password=abc123", latestLogAt: "2026-10-19T01:00:00Z", logCount: 3 }], total: 1, page: 1, pageSize: 20 };
const LOGS = { items: [{ id: 5, eventId: "ev-5", userId: 42, installId: "inst-5", stableId: "st-5", nickname: "可可", serverName: "夏日", occurredAt: "2026-10-19T01:00:00Z", receivedAt: "2026-10-19T01:00:02Z", level: "error", category: "plant", message: "种花失败 password=abc123", appVersion: "0.9.1", errorCode: "SOFTWARE_LOGIN_FAILED", traceId: "run-5", operationId: "op-5", outcome: { sent: 3, confirmed: 2, unconfirmed: 1 }, diagnostic: "Bearer SuperSecretToken99", isError: true }], total: 1, page: 1, pageSize: 20 };
const SETTINGS = { allowRegistration: true, retention: { normalDays: 30, errorDays: 90 }, backup: { lastAt: "2026-10-18T20:00:00Z", ok: true, sizeBytes: 2048, sha256: "ab12", detail: "一致性快照已加密外传" }, sessionTtlMinutes: 30, graceHours: 24, licenseRenewAfterSeconds: 60 };

function respond(url) {
  if (url.startsWith("/api/admin/logs/runs?")) return { items: LOGS.items };
  if (url.startsWith("/api/admin/logs?")) return LOGS;
  if (url.startsWith("/api/admin/users?")) return USERS;
  if (url.startsWith("/api/admin/settings")) return SETTINGS;
  return { ok: true };
}

globalThis.fetch = async (url, init = {}) => {
  assert.ok(url.startsWith(serviceBase + "/api/admin/"), "生产构建应按实际静态挂载路径请求同源 /api/admin/*");
  const relativeUrl = url.slice(serviceBase.length);
  fetched.push({ url: relativeUrl, method: init.method || "GET", auth: (init.headers && init.headers.authorization) || "", body: init.body || "" });
  assert.match(relativeUrl, /^\/api\/admin\//, "后台只能按同源相对路径调 /api/admin/*");
  return { ok: true, status: 200, async text() { return JSON.stringify(respond(relativeUrl)); } };
};

// 事件委托的替身：页面里没有内联事件属性，所有交互都靠 data 属性加委托监听。
function button(action, attrs) {
  const el = { getAttribute: (name) => (name === "data-action" ? action : (attrs && attrs[name]) || null) };
  el.closest = () => el;
  return el;
}
function clickEl(el) {
  listeners.click({ target: el, preventDefault: () => {} });
  return tick();
}
function fakeForm(name, fields, attrs) {
  return {
    getAttribute: (key) => (key === "data-form" ? name : (attrs && attrs[key]) || null),
    __fields: fields || {},
  };
}
globalThis.FormData = class {
  constructor(form) { this.map = form.__fields || {}; }
  get(key) { return this.map[key]; }
};
function submitForm(form) {
  listeners.submit({ target: form, preventDefault: () => {} });
  return tick();
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
const { LOG_FILTER_KEYS: LOG_FILTER_KEYS_IN_CHILD } = await import(pathToFileURL(SRC + "/console.js").href);
const session = await import(pathToFileURL(SRC + "/session.js").href);
await import(pathToFileURL(SRC + "/app.js").href);

assert.ok(element.innerHTML.includes("无尽夏管理后台"), "未登录时首屏出登录页");
assert.ok(element.innerHTML.includes("需要重新登录"), "登录页要说明刷新后需重新登录");
assert.equal(hashValue, "#/users", "首屏把地址补到默认入口");
assert.equal(typeof listeners.hashchange, "function");
assert.equal(typeof listeners.click, "function");
assert.equal(typeof listeners.submit, "function");

session.startSession({ accessToken: "smoke-access-token", accessExpiresAt: "2099-01-01T00:00:00Z", refreshToken: "smoke-refresh-token", admin: { id: 1, username: "smoke_admin" } });

const pages = {};
async function goto(hash) {
  hashValue = hash;
  listeners.hashchange();
  await tick();
  pages[hash] = element.innerHTML;
  assert.ok(element.innerHTML.includes("smoke_admin"), hash + " 外壳要显示当前管理员");
  assert.equal(element.innerHTML.includes("smoke-access-token"), false, hash + " 不得把令牌原文渲染进页面");
  assert.equal(element.innerHTML.includes("abc123"), false, hash + " 不得出现原文密码");
  assert.equal(element.innerHTML.includes("SuperSecretToken99"), false, hash + " 不得出现未脱敏令牌");
  assert.equal(/<script/i.test(element.innerHTML), false, hash + " 渲染结果不得含脚本标签");
  const tags = element.innerHTML.match(/<[^>]+>/g) || [];
  assert.deepEqual(tags.filter((tag) => /\son[a-z]+\s*=/i.test(tag)), [], hash + " 标签体里不得有内联事件属性");
  assert.deepEqual(tags.filter((tag) => /\sstyle\s*=/i.test(tag)), [], hash + " 标签体里不得有内联样式");
  // 中文文案里不嵌 ASCII 双引号：把标签去掉后，剩下的可见文字不该再出现引号字符。
  const visible = element.innerHTML.replace(/<[^>]*>/g, " ");
  assert.equal(visible.includes(String.fromCharCode(34)), false, hash + " 的可见文案里不得嵌 ASCII 双引号");
  assert.equal(visible.includes("http://") || visible.includes("https://"), false, hash + " 的可见文案里不得出现绝对地址");
}

await goto("#/logs");
await clickEl(button("toggle-log-detail", { "data-id": "5" }));
pages["#/logs"] = element.innerHTML;
assert.ok(pages["#/logs"].includes("〔已脱敏〕"), "日志页要出掩码标记");
assert.ok(pages["#/logs"].includes("手机上报"), "日志页要保留手机上报来源属性");
assert.ok(pages["#/logs"].includes("种花失败"), "日志页要出简明的内容");
assert.ok(pages["#/logs"].includes("SOFTWARE_LOGIN_FAILED"), "日志页要带错误码原文便于比对");
assert.ok(pages["#/logs"].includes("inst-5"), "日志页要显示来源安装标识");
assert.ok(pages["#/logs"].includes("最近没有日志只表示云端没有收到新记录"));
assert.ok(fetched.some((entry) => entry.url.startsWith("/api/admin/logs?") && entry.auth === "Bearer smoke-access-token"));

await goto("#/users");
assert.ok(pages["#/users"].includes("&lt;b&gt;x&lt;/b&gt;"), "用户名必须转义后进 DOM");
assert.ok(pages["#/users"].includes("#/logs?userId=42"), "查看该用户运行日志要带上用户标识");
assert.ok(pages["#/users"].includes("还没登录过"), "最近登录读不到时明说读不到");

await goto("#/settings");
assert.ok(pages["#/settings"].includes("最近备份结果（只读）"));
assert.ok(pages["#/settings"].includes("2.0 KiB"), "备份大小按只读展示");
assert.ok(fetched.some((entry) => entry.url === "/api/admin/settings" && entry.method === "GET"));

await goto("#/logs?userId=42");
assert.ok(fetched.some((entry) => entry.url.includes("/api/admin/logs?") && entry.url.includes("userId=42")), "跳转带上的用户标识要下发成筛选条件");

// ---- 交互链路：筛选表单、二次确认、密码重置不回显、同次运行、退出 ----
await submitForm(fakeForm("log-filters", { userId: "42", installId: "inst-5", stableId: "st-5", nickname: "可可", serverName: "夏日", from: "2026-10-01T08:30", to: "2026-10-02", level: "error", category: "浇水", errorCode: "SESSION_REVOKED", traceId: "run-5", operationId: "op-5", eventState: "failed", outcomeState: "unconfirmed", attempted: "true", q: "种花", pageSize: "500" }));
const filterCall = fetched[fetched.length - 1];
assert.ok(filterCall.url.startsWith("/api/admin/logs?"));
for (const key of LOG_FILTER_KEYS_IN_CHILD) assert.ok(filterCall.url.includes(key + "="), "筛选项 " + key + " 要下发：" + filterCall.url);
assert.ok(filterCall.url.includes("pageSize=100"), "每页条数超上限要被夹到 100：" + filterCall.url);
assert.ok(filterCall.url.includes("from=2026-10-01T08%3A30%3A00"));

await goto("#/users");
await clickEl(button("toggle-user-row", { "data-id": "42" }));
assert.ok(element.innerHTML.includes("type=\"password\""), "展开行里要有只留在输入框里的新密码框");
assert.ok(element.innerHTML.includes("重置密码") && element.innerHTML.includes("保存备注"));

await submitForm(fakeForm("reset-password", { password: "short" }, { "data-id": "42" }));
assert.equal(fetched.some((entry) => entry.url === "/api/admin/users/42/reset-password"), false, "不合格的新密码不得发给云端");
assert.ok(element.innerHTML.includes("新密码需要"), "要提示密码不合格");

await submitForm(fakeForm("reset-password", { password: "FreshPass456" }, { "data-id": "42" }));
const resetCall = fetched.find((entry) => entry.url === "/api/admin/users/42/reset-password");
assert.ok(resetCall && resetCall.method === "POST", "合格的密码才发出去");
assert.ok(JSON.parse(resetCall.body).password === "FreshPass456");
assert.equal(element.innerHTML.includes("FreshPass456"), false, "界面不得回显新密码");
assert.ok(element.innerHTML.includes("全部会话与刷新凭据已被撤销"));

await submitForm(fakeForm("remark", { remark: "用户自己在手机上申请停用" }, { "data-id": "42" }));
assert.ok(fetched.some((entry) => entry.url === "/api/admin/users/42/remark" && JSON.parse(entry.body).remark === "用户自己在手机上申请停用"));

await clickEl(button("disable-user", { "data-id": "42" }));
assert.ok(element.innerHTML.includes("确认停用这个软件用户吗"), "停用要先出二次确认");
assert.ok(element.innerHTML.includes("停用会撤销该用户的全部会话"), "二次确认要展示会撤销其全部会话");
assert.equal(fetched.some((entry) => entry.url === "/api/admin/users/42/enabled"), false, "没确认之前不许写");
await submitForm(fakeForm("confirm-reason", { reason: "按用户申请" }));
await clickEl(button("confirm-yes"));
const disableCall = fetched.find((entry) => entry.url === "/api/admin/users/42/enabled");
assert.ok(disableCall && disableCall.method === "POST");
assert.deepEqual(JSON.parse(disableCall.body), { enabled: false, reason: "按用户申请" });
assert.ok(element.innerHTML.includes("已停用"));

await clickEl(button("enable-user", { "data-id": "42" }));
const enableCall = fetched.filter((entry) => entry.url === "/api/admin/users/42/enabled").pop();
assert.deepEqual(JSON.parse(enableCall.body), { enabled: true });
assert.ok(element.innerHTML.includes("不会复活已撤销的会话"), "启用后的说明要说清不复活会话");

await goto("#/logs");
await clickEl(button("toggle-log-detail", { "data-id": "5" }));
assert.ok(element.innerHTML.includes("脱敏诊断"), "行展开要显示完整脱敏诊断");
assert.ok(element.innerHTML.includes("展开同次运行"));
await clickEl(button("open-run", { "data-trace": "run-5", "data-user": "42", "data-install": "inst-5" }));
assert.ok(fetched.some((entry) => entry.url === "/api/admin/logs/runs?traceId=run-5&userId=42&installId=inst-5"), "展开同次运行要按 traceId 与原用户/安装范围拉取");
assert.ok(element.innerHTML.includes("同次运行 run-5"));
await clickEl(button("close-run"));
assert.equal(element.innerHTML.includes("同次运行 run-5"), false, "收起后不再显示同次运行块");

await goto("#/settings");
await submitForm(fakeForm("settings", { allowRegistration: null, normalDays: "45", errorDays: "abc" }));
assert.equal(fetched.some((entry) => entry.method === "PUT"), false, "保留期限不合法时不得下发设置");
assert.ok(element.innerHTML.includes("必须是 1 到 3650 的整数"));
await submitForm(fakeForm("settings", { allowRegistration: "on", normalDays: "45", errorDays: "120" }));
const putCall = fetched.find((entry) => entry.method === "PUT");
assert.equal(putCall.url, "/api/admin/settings");
assert.deepEqual(JSON.parse(putCall.body), { allowRegistration: true, retention: { normalDays: 45, errorDays: 120 } });

await submitForm(fakeForm("admin-password", { currentPassword: "OldPass123", newPassword: "NewPass456" }));
const pwdCall = fetched.find((entry) => entry.url === "/api/admin/password");
assert.ok(pwdCall && pwdCall.method === "POST");
assert.deepEqual(JSON.parse(pwdCall.body), { currentPassword: "OldPass123", newPassword: "NewPass456" });
assert.equal(element.innerHTML.includes("NewPass456"), false, "改密后界面不得回显新密码");
assert.equal(session.isLoggedIn(), false, "改密成功后云端撤销全部会话，本地内存会话也要清掉");
assert.ok(element.innerHTML.includes("无尽夏管理后台"), "改密后回到登录页要求重新登录");

session.startSession({ accessToken: "smoke-access-token", accessExpiresAt: "2099-01-01T00:00:00Z", refreshToken: "smoke-refresh-token", admin: { id: 1, username: "smoke_admin" } });
await goto("#/users");
await clickEl(button("logout"));
assert.ok(fetched.some((entry) => entry.url === "/api/admin/logout" && JSON.parse(entry.body).refreshToken === "smoke-refresh-token"), "退出要先把刷新凭据交给云端撤销");
assert.equal(session.isLoggedIn(), false);
assert.equal(session.readAccessToken(), "", "退出后内存里不留令牌");

console.log(JSON.stringify({ ok: true, pages: Object.keys(pages), fetched: fetched.map((entry) => entry.method + " " + entry.url) }));
`;

test("入口模块在替身 DOM 下装载：三个入口页都能渲染、令牌不外泄、接口只走同源相对路径", () => {
  fs.mkdirSync(scratchDir, { recursive: true });
  const scriptPath = path.join(scratchDir, "smoke-entry.mjs");
  fs.writeFileSync(scriptPath, SMOKE_SCRIPT.replace("__SRC__", JSON.stringify(distDir.split(path.sep).join("/"))), "utf8");
  const result = spawnSync(process.execPath, [scriptPath], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(result.status, 0, `冒烟未通过：${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout.trim().split("\n").pop());
  assert.equal(report.ok, true);
  assert.deepEqual(report.pages, ["#/logs", "#/users", "#/settings", "#/logs?userId=42"]);
  assert.ok(report.fetched.length >= 20, "交互链路应当真的发得出请求");
  for (const call of report.fetched) {
    const [method, url] = call.split(" ");
    assert.match(method, /^(GET|POST|PUT)$/, `意外的方法：${call}`);
    assert.match(url, /^\/api\/admin\//, `接口调用必须同源相对路径：${call}`);
    assert.doesNotMatch(call, /https?:|\/\/[a-z0-9.-]+\.[a-z]{2,}/i, `调用里不得出现主机名或绝对地址：${call}`);
  }
  assert.ok(report.fetched.includes("PUT /api/admin/settings"), "后台设置的保存要走到 PUT /api/admin/settings");
  assert.ok(report.fetched.includes("GET /api/admin/logs/runs?traceId=run-5&userId=42&installId=inst-5"), "展开同次运行要按原用户/安装范围拉取");
  assert.ok(report.fetched.includes("POST /api/admin/users/42/enabled"), "停用与启用要写云端");
  assert.ok(report.fetched.includes("POST /api/admin/logout"), "退出要通知云端撤销会话");
});

test("后台全部界面模块的源码都不碰浏览器本地存储", () => {
  for (const name of ["session.mjs", "api.mjs", "app.mjs", "views.mjs", "console.mjs"]) {
    // console.mjs 只允许那份扫描尺本身出现关键词，其余文件命中即红。
    const hits = name === "console.mjs" ? [] : console_.findStorageUsage(read(path.join(srcDir, name)));
    assert.deepEqual(hits, [], `${name} 不得出现浏览器本地存储调用`);
  }
  for (const relative of walk(distDir)) {
    if (path.basename(relative) === "console.js" || !relative.endsWith(".js")) continue;
    assert.deepEqual(console_.findStorageUsage(read(path.join(distDir, relative))), [], `${relative} 产物里不得有浏览器本地存储调用`);
  }
});

/* ==================== 辅助构造 ==================== */

function state() {
  return {
    route: "#/users",
    session: { loggedIn: true, admin: "wx_admin" },
    busy: "",
    loginError: "",
    notice: null,
    confirm: null,
    users: { q: "", page: 1, pageSize: 20, loading: false, error: "", data: null, openId: null },
    logs: { filters: console_.cleanLogFilters({}), page: 1, pageSize: 20, loading: false, error: "", data: null, expanded: new Set(), run: { traceId: "", items: [], loading: false, error: "" } },
    settings: { loading: false, busy: "", error: "", data: null, form: null, passwordMessage: null },
  };
}

function logsState(record) {
  const base = state();
  return {
    ...base,
    route: "#/logs",
    logs: { ...base.logs, data: { items: [record], total: 1, page: 1, pageSize: 20 }, expanded: new Set([String(record.id)]) },
  };
}

function userState(record) {
  const base = state();
  return {
    ...base,
    users: { ...base.users, data: { items: [record], total: 1, page: 1, pageSize: 20 }, openId: String(record.id) },
  };
}
