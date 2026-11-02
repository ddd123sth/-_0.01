// 无尽夏安卓端专用管理后台构建脚本
// 纯静态、零构建依赖：不装 npm 包、不引打包器，只把 admin/src 里允许的文件复制进 admin/dist，
// 生成 sha256 清单给云服务按 /admin/ 静态挂载用。参考仓库目录在本脚本里一次都不读。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "admin", "src");
const distDir = path.join(root, "admin", "dist");

// 后台运行时可达的文件闭包：加文件必须同时说明它为什么是必需的。
const SOURCES = ["index.html", "styles.css", "app.mjs", "views.mjs", "console.mjs", "session.mjs", "api.mjs"];

// 源码模块按本仓惯例留 .mjs；产物出 .js，因为云服务的静态 MIME 表（cloud/app.mjs 的 STATIC_TYPES）
// 只把 .js 认成 text/javascript，octet-stream 的模块浏览器不执行。这里只做扩展名替换，不打包、不合并。
const MODULES = ["app.mjs", "views.mjs", "console.mjs", "session.mjs", "api.mjs"];
const OUTPUT_FOR = new Map(SOURCES.map((name) => [name, MODULES.includes(name) ? name.replace(/\.mjs$/, ".js") : name]));
const ALLOWED = SOURCES.map((name) => OUTPUT_FOR.get(name));

function emitText(text) {
  let out = text;
  for (const name of MODULES) out = out.split(name).join(OUTPUT_FOR.get(name));
  return out;
}

// 隔离闸：原站域名、支付网关、原站服务端文件名与任何绝对站点地址都不许随包分发。
const FORBIDDEN = [
  { token: "wdhysj.cn", why: "原网页版域名" },
  { token: "xunhupay", why: "原网页版支付网关" },
  { token: "api-admin.js", why: "原网页版管理服务端文件" },
  { token: "auth-routes.js", why: "原网页版认证路由文件" },
  { token: "http://", why: "绝对地址会破坏 connect-src 'self' 与独立站点入口" },
  { token: "https://", why: "绝对地址会破坏 connect-src 'self' 与独立站点入口" },
];

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

function readSource(name) {
  const file = path.join(srcDir, name);
  if (!fs.existsSync(file)) throw new Error(`后台源文件缺失：admin/src/${name}`);
  return fs.readFileSync(file, "utf8");
}

// admin/src 是后台源码目录的唯一名册：多出来的文件说明有东西没登记，构建直接停。
function checkSourceRoster() {
  if (!fs.existsSync(srcDir)) throw new Error("admin/src 目录不存在");
  const present = fs.readdirSync(srcDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const extras = present.filter((name) => !SOURCES.includes(name));
  const missing = SOURCES.filter((name) => !present.includes(name));
  if (extras.length) throw new Error(`admin/src 里有未登记的文件：${extras.join("、")}；请删掉或先说明它为什么必需`);
  if (missing.length) throw new Error(`admin/src 缺少文件：${missing.join("、")}`);
  const dirs = fs.readdirSync(srcDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (dirs.length) throw new Error(`admin/src 下不允许有子目录：${dirs.join("、")}`);
  return present;
}

function isolationProblems(name, text) {
  const problems = [];
  for (const item of FORBIDDEN) {
    if (text.includes(item.token)) problems.push(`${name} 含禁词 ${item.token}（${item.why}）`);
  }
  if (text.includes("我的花园世界/")) problems.push(`${name} 含参考仓库路径：构建产物不得指向参考目录`);
  if (name.endsWith(".html")) {
    const stripped = text.replace(/<script[^>]*\bsrc\s*=[^>]*>\s*<\/script>/gi, "");
    if (/<script/i.test(stripped)) problems.push(`${name} 含内联 script：云服务的 CSP 是 script-src 'self'`);
    if (/\son[a-z]+\s*=/i.test(text)) problems.push(`${name} 含内联事件属性`);
    if (/(\sstyle\s*=|<style)/i.test(text)) problems.push(`${name} 含内联样式：CSP 是 style-src 'self'`);
  }
  if (name === "api.mjs" || name === "app.mjs") {
    // 接口层与入口只允许同源相对路径；主机名或端口写死就违反 connect-src 'self'。
    if (/\bfetch\s*\(\s*["'`][A-Za-z][A-Za-z0-9+.-]*:/i.test(text)) problems.push(`${name} 用带协议的地址发请求`);
  }
  return problems;
}

// 产物侧还要再过一道：扩展名替换必须换干净，入口指得到实际存在的模块。
function emitProblems(sourceName, distName, text) {
  const problems = [];
  if (/\.mjs\b/.test(text)) problems.push(`${distName} 里还留着 .mjs 引用：产物扩展名没替换干净，浏览器会按 octet-stream 拒收模块`);
  if (sourceName === "index.html" && !/<script type="module" src="app\.js"><\/script>/.test(text)) {
    problems.push("index.html 的入口脚本必须指向产物里的 app.js");
  }
  return problems;
}

// 清单只有文件与哈希，不写时间戳：同一份源码重复构建结果必须逐字节相同。
function buildManifest(files) {
  return {
    service: "wujinxia-app-admin",
    version: "0.1.0",
    mount: "/admin/",
    entry: "index.html",
    CSP: ["script-src 'self'", "style-src 'self'", "connect-src 'self'", "frame-ancestors 'none'"],
    note: "静态文件由云服务挂在 /admin/ 下；接口只走同源 /api/admin/*。管理员令牌只存在页面内存，浏览器本地存储不写凭据。产物扩展名为 .js，源码模块仍是 admin/src 下的 .mjs。",
    files,
  };
}

function main() {
  const roster = checkSourceRoster();
  const contents = roster.map((name) => ({ source: name, dist: OUTPUT_FOR.get(name), text: readSource(name) }));
  const problems = contents.flatMap((item) => isolationProblems(item.source, item.text));
  if (problems.length) throw new Error(`后台隔离闸拦下：\n  ${problems.join("\n  ")}`);

  const emitted = contents.map((item) => ({ ...item, out: emitText(item.text) }));
  const emitIssues = emitted.flatMap((item) => [...isolationProblems(item.dist, item.out), ...emitProblems(item.source, item.dist, item.out)]);
  if (emitIssues.length) throw new Error(`后台产物闸拦下：\n  ${emitIssues.join("\n  ")}`);

  // 清掉上一次产物，包括不在名册里的陈旧文件，dist 不留旧版残留。
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  const files = [];
  for (const item of emitted) {
    const target = path.join(distDir, item.dist);
    fs.writeFileSync(target, item.out, "utf8");
    files.push({ path: item.dist, source: item.source, bytes: Buffer.byteLength(item.out, "utf8"), sha256: sha256(Buffer.from(item.out, "utf8")) });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest = buildManifest(files);
  fs.writeFileSync(path.join(distDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`后台静态产物：${files.length} 个文件进入 admin/dist，清单含每个文件的 sha256；隔离闸与产物闸已过。`);
  return { files, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

export { ALLOWED, FORBIDDEN, MODULES, OUTPUT_FOR, SOURCES, emitProblems, emitText, isolationProblems, main, sha256 };
