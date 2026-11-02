#!/usr/bin/env node
// 无尽夏安卓端专用云服务的发布工具（本项目独立编写，不调用原网页版的部署脚本）。
//
// 隔离边界（AGENTS.md「两台服务器安排」）：
//   · 只操作本项目的用户/服务/目录：`wujinxia-app-cloud`、`/opt/wujinxia-app-cloud`、`/var/lib/wujinxia-app-cloud`、
//     站点配置 `/etc/nginx/conf.d/wujinxia-app-cloud.conf`、专用端口占位符。
//   · 计划里的每条命令都先过禁词闸：出现原站服务名、原站目录、原站域名、原站站点配置编号或 IP 字面量就直接拒绝。
//   · 共享 nginx 服务的 reload/restart 不在本项目命令里（会把原站入口一起重启），只在 README 里作为人工步骤列出。
//   · 默认 dry-run：只打印将要执行的命令，不起 ssh/scp/curl；必须显式 `--apply`。本轮不允许连任何服务器。
//   · `.env`、密钥、`*.db`、凭据文件出现在待上传清单里就拒绝发布。
//
// 用法：node tools/wujinxia-deploy.mjs [--apply] [--rollback] [--host <ssh别名>] [--port <回环端口>]
//                                     [--domain <子域名>] [--version <期望版本>] [--release <上一版 sha>]
//                                     [--source-root <目录>] [--out <产物目录>]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  BackupError, parseArgv, projectRoot, localStamp, sha256File, runCommand, parseRemote, redact,
} from './wujinxia-backup.mjs';

export const SERVICE = 'wujinxia-app-cloud';
export const INSTALL_DIR = '/opt/' + SERVICE;
export const RELEASES_DIR = INSTALL_DIR + '/releases';
export const CURRENT_LINK = INSTALL_DIR + '/current';
export const STATE_DIR = '/var/lib/' + SERVICE;
export const DB_REMOTE_FILE = STATE_DIR + '/wujinxia-cloud.db';
export const ENV_DIR = '/etc/' + SERVICE;
export const ENV_FILE = ENV_DIR + '/env';
export const REMOTE_BACKUP_DIR = '/var/backups/' + SERVICE;
export const SITE_CONF_PATH = '/etc/nginx/conf.d/' + SERVICE + '.conf';
export const UNIT_PATH = '/etc/systemd/system/' + SERVICE + '.service';
export const HEALTH_PATH = '/api/software/health';
export const NODE_MIN = { major: 22, minor: 13 };
export const DEFAULT_TMP_DIR = '.runtime/wujinxia-deploy';

// 禁词：原站的服务名、目录、域名与站点配置编号。出现在任何待执行命令或产物文本里都视为越界。
// 注意：`garden-node1` 与 `aliyun-huantong` 是两台机器的 SSH 别名（同一台物理服务器可以承载两个项目），
// 禁词只针对原站的服务名、目录、域名与站点配置，不针对机器别名。
export const FORBIDDEN_TARGETS = [
  { pattern: /garden-node-api/gi, label: '原站节点 API 服务名' },
  { pattern: /garden-node-sync/gi, label: '原站节点同步服务名' },
  { pattern: /garden-world/gi, label: '原站部署目录名' },
  { pattern: /\/opt\/garden(?![-\w]*wujinxia)/gi, label: '原站部署目录前缀 /opt/garden*' },
  { pattern: /ainiannian\.online/gi, label: '原站域名' },
  { pattern: /wdhysj\.cn/gi, label: '原站后端域名' },
  { pattern: /27350309/g, label: '原站站点配置编号' },
];

// 共享入口命令：重启/重载 nginx 会连带原站入口，本项目工具不自动执行。
export const SHARED_ENTRY_COMMANDS = [
  { pattern: /nginx\s+-s\s+(reload|restart|quit|stop)/gi, label: '共享 nginx 信号命令' },
  { pattern: /systemctl\s+(reload|restart|reload-or-restart|stop|try-restart)\s+nginx/gi, label: '共享 nginx systemd 操作' },
];

export const IPV4_PATTERN = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
// 回环地址是本项目服务唯一允许绑定的地址，不算「写死服务器 IP」。
export const IPV4_ALLOWED = new Set(['127.0.0.1']);

export function findIpLiterals(text) {
  const found = [];
  IPV4_PATTERN.lastIndex = 0;
  let match;
  while ((match = IPV4_PATTERN.exec(String(text || ''))) !== null) {
    if (!IPV4_ALLOWED.has(match[0])) found.push(match[0]);
  }
  return found;
}

// 待上传清单里出现这些就是凭据/数据泄漏，直接拒绝发布。
// 只按「文件名形态 + 内容特征」判定，不拿 password/token 这类字样泛拦源码文件名（cloud/ 里本来就有密码与会话相关源码）。
export const SECRET_PATTERNS = [
  { pattern: /(^|\/)\.env(\.[^/]*)?$/i, allow: /\.(env\.(example|sample|template))$/i, label: '.env 环境变量文件' },
  { pattern: /\.db$/i, label: 'SQLite 主库文件' },
  { pattern: /\.db-(wal|shm)$/i, label: 'SQLite WAL/SHM 文件' },
  { pattern: /(^|\/)\.runtime(\/|$)/i, label: '本机运行态目录' },
  { pattern: /(^|\/)\.git(\/|$)/i, label: 'Git 元数据' },
  { pattern: /\.(pem|crt|der|p12|pfx|jks|keystore|kdbx|asc|gpg)$/i, label: '证书、私钥或密钥库' },
  { pattern: /(^|\/)(secrets?|credentials?|credential-store)([._-][^/]*)?$/i, label: '凭据文件' },
  { pattern: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i, label: 'SSH 私钥' },
  { pattern: /(^|\/)\.(npmrc|netrc|pgpass)$/i, label: '其他本机凭据文件' },
];

// 内容特征：只拦 PEM 私钥块（文件名闸不是通用密钥扫描器，见 deploy/README.md）。
export const SECRET_CONTENT_PATTERNS = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: 'PEM 私钥块' },
];

export class DeployError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeployError';
  }
}

// ── 校验闸 ───────────────────────────────────────────────────────────────

export function scanForbidden(text) {
  const hits = [];
  const source = String(text || '');
  for (const rule of FORBIDDEN_TARGETS) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(source)) hits.push(rule.label);
  }
  for (const rule of SHARED_ENTRY_COMMANDS) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(source)) hits.push(rule.label);
  }
  return hits;
}

export function assertCleanTargets(items, context) {
  const problems = [];
  for (const item of items) {
    const text = Array.isArray(item) ? item.join(' ') : String(item.argv ? item.argv.join(' ') : item);
    const hits = scanForbidden(text);
    if (hits.length) problems.push(hits.join('、') + ' → ' + text.slice(0, 160));
    const ips = findIpLiterals(text);
    if (ips.length) problems.push('命令里出现服务器 IP 字面量（必须用 SSH 别名）→ ' + ips.join(',') + ' in ' + text.slice(0, 160));
  }
  if (problems.length) {
    throw new DeployError('发布被拒绝（越界目标 ' + problems.length + ' 处，' + context + '）：\n  · ' + problems.join('\n  · '));
  }
}

export function findSecrets(files) {
  const hits = [];
  for (const rel of files) {
    const posix = String(rel).split(path.sep).join('/');
    for (const rule of SECRET_PATTERNS) {
      if (rule.pattern.test(posix) && !(rule.allow && rule.allow.test(posix))) {
        hits.push({ file: posix, label: rule.label });
        break;
      }
    }
  }
  return hits;
}

export function walkFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const walk = (dir, relBase) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      const rel = relBase ? relBase + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(root, '');
  return out;
}

export function nodeVersionCheck(versionString = process.version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(versionString));
  if (!m) return { ok: false, current: String(versionString), message: '读不到 Node 版本' };
  const [, major, minor] = m.map(Number);
  const ok = major > NODE_MIN.major || (major === NODE_MIN.major && minor >= NODE_MIN.minor);
  return {
    ok,
    current: versionString,
    required: `>=${NODE_MIN.major}.${NODE_MIN.minor}`,
    message: ok
      ? `Node ${versionString} 满足内置 node:sqlite 的要求（>=${NODE_MIN.major}.${NODE_MIN.minor}）`
      : `Node ${versionString} 低于 ${NODE_MIN.major}.${NODE_MIN.minor}：目标机需改用满足版本的 Node，或显式加 --experimental-sqlite 启动`,
  };
}

export function findSecretContent(sourceRoot, files) {
  const hits = [];
  for (const rel of files) {
    const abs = path.join(sourceRoot, rel.split('/').join(path.sep));
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
    const text = fs.readFileSync(abs).toString('utf8');
    for (const rule of SECRET_CONTENT_PATTERNS) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(text)) hits.push({ file: rel, label: rule.label });
    }
    // 发布内容本身也不许带原站引用：服务名、目录、域名、站点配置编号一律拒绝随包分发。
    for (const rule of FORBIDDEN_TARGETS) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(text)) hits.push({ file: rel, label: '内容含原站引用（' + rule.label + '）' });
    }
  }
  return hits;
}

export function collectContent(options = {}) {
  const root = options.sourceRoot;
  const groups = [];
  const cloudDir = path.join(root, 'cloud');
  if (!fs.existsSync(cloudDir)) throw new DeployError('找不到本项目云服务源码目录：' + cloudDir + '（发布内容只从本仓 cloud/ 取，不从原站取）');
  const cloudFiles = walkFiles(cloudDir).map((rel) => 'cloud/' + rel);
  if (!cloudFiles.length) throw new DeployError('cloud/ 里没有任何文件，不能发空包');
  groups.push({ name: 'cloud', files: cloudFiles });
  const distDir = path.join(root, 'admin', 'dist');
  if (fs.existsSync(distDir)) {
    const distFiles = walkFiles(distDir).map((rel) => 'admin/dist/' + rel);
    if (!distFiles.length) throw new DeployError('admin/dist/ 存在但是空目录：先构建后台，或删掉空目录再发');
    groups.push({ name: 'admin/dist', files: distFiles });
  }
  const all = groups.flatMap((group) => group.files);
  const secrets = findSecrets(all);
  if (secrets.length) {
    throw new DeployError('待上传清单含凭据或本机数据，拒绝发布：\n  · '
      + secrets.map((s) => s.file + '（' + s.label + '）').join('\n  · ')
      + '\n  凭据只放目标机的 ' + ENV_FILE + '，库文件只放 ' + STATE_DIR + '/。');
  }
  const contentHits = findSecretContent(root, all);
  if (contentHits.length) {
    throw new DeployError('待上传内容违规（私钥或原站引用），拒绝发布：\n  · '
      + contentHits.map((s) => s.file + '（' + s.label + '）').join('\n  · '));
  }
  return { root, groups, files: all, distPresent: Boolean(fs.existsSync(distDir)) };
}

// ── 产物文本 ─────────────────────────────────────────────────────────────

export function renderServiceUnit(ctx = {}) {
  const port = ctx.port === undefined || ctx.port === null ? '{{PORT}}' : ctx.port;
  const nodeBin = ctx.nodeBin || '/usr/bin/env';
  const entry = ctx.entry || 'cloud/server.mjs';
  return [
    '# 本项目专用 systemd 单元：独立用户、独立目录、只绑回环端口。',
    '# 与网页版服务互不影响：本单元不引用原站任何服务名、目录或端口。',
    '[Unit]',
    'Description=WuJinXia app cloud (无尽夏安卓端专用云服务)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    'User=' + SERVICE,
    'Group=' + SERVICE,
    'WorkingDirectory=' + CURRENT_LINK,
    'StateDirectory=' + SERVICE,
    'StateDirectoryMode=0750',
    'EnvironmentFile=' + ENV_FILE,
    'Environment=WUJINXIA_DATA_DIR=' + STATE_DIR,
    'Environment=WUJINXIA_DB_FILE=' + DB_REMOTE_FILE,
    'Environment=WUJINXIA_BIND=127.0.0.1',
    'Environment=WUJINXIA_PORT=' + port,
    'Environment=NODE_ENV=production',
    'ExecStart=' + nodeBin + ' node ' + entry,
    'Restart=on-failure',
    'RestartSec=3',
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'ProtectSystem=full',
    'ProtectHome=true',
    'ReadWritePaths=' + STATE_DIR,
    'LimitNOFILE=4096',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

export function renderNginxConf(ctx = {}) {
  const domain = ctx.domain || '{{DOMAIN}}';
  const port = ctx.port === undefined || ctx.port === null ? '{{PORT}}' : ctx.port;
  const cert = ctx.tlsCert || '{{TLS_CERT}}';
  const key = ctx.tlsKey || '{{TLS_KEY}}';
  return [
    '# 本项目专用站点配置：独立子域名与独立回环上游端口。',
    '# 落到 ' + SITE_CONF_PATH + '；共享 nginx 的 reload 是人工步骤（见 deploy/README.md），本工具不自动执行，',
    '# 以免连带重启原网页版入口。',
    'server {',
    '    listen 80;',
    '    listen [::]:80;',
    '    server_name ' + domain + ';',
    '    return 301 https://$host$request_uri;',
    '}',
    '',
    'server {',
    '    listen 443 ssl;',
    '    listen [::]:443 ssl;',
    '    http2 on;',
    '    server_name ' + domain + ';',
    '',
    '    ssl_certificate ' + cert + ';',
    '    ssl_certificate_key ' + key + ';',
    '    ssl_protocols TLSv1.2 TLSv1.3;',
    '',
    '    client_max_body_size 1m;',
    '',
    '    location / {',
    '        proxy_pass http://127.0.0.1:' + port + ';',
    '        proxy_http_version 1.1;',
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    '        proxy_read_timeout 30s;',
    '    }',
    '}',
    '',
  ].join('\n');
}

export function renderInstallScript(ctx = {}) {
  return [
    '#!/usr/bin/env bash',
    '# 本项目一次性装机步骤（只创建 wujinxia-app-cloud 的用户、目录与服务，不碰网页版的任何用户、目录、服务、站点、库或备份）。',
    'set -euo pipefail',
    '',
    'SERVICE="' + SERVICE + '"',
    'INSTALL_DIR="' + INSTALL_DIR + '"',
    'STATE_DIR="' + STATE_DIR + '"',
    'ENV_DIR="' + ENV_DIR + '"',
    'BACKUP_DIR="' + REMOTE_BACKUP_DIR + '"',
    '',
    '# ① 独立系统用户：没有家目录、没有登录 shell。',
    'getent passwd "$SERVICE" >/dev/null 2>&1 || \\',
    '  useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin "$SERVICE"',
    '',
    '# ② 独立目录与权限 0750（发布件与数据互不混放）。',
    'install -d -m 0755 "$INSTALL_DIR" "$INSTALL_DIR/releases"',
    'install -d -m 0750 -o "$SERVICE" -g "$SERVICE" "$STATE_DIR"',
    'install -d -m 0750 -o root -g "$SERVICE" "$ENV_DIR"',
    'install -d -m 0750 -o "$SERVICE" -g "$SERVICE" "$BACKUP_DIR"',
    '',
    '# ③ 环境变量文件由运维手工放置（本脚本不写任何密钥内容）：',
    '#    ' + ENV_FILE + '，权限 0640，属主 root:"$SERVICE"，键名见 deploy/README.md。',
    'if [ ! -f "' + ENV_FILE + '" ]; then',
    '  echo "缺少 ' + ENV_FILE + '，先由运维写入再启动服务" >&2',
    'fi',
    '',
    '# ④ 专用站点配置与 systemd 单元（都是本项目文件名，不覆盖网页版站点配置）。',
    'install -m 0644 nginx-wujinxia.conf ' + SITE_CONF_PATH,
    'install -m 0644 ' + SERVICE + '.service ' + UNIT_PATH,
    'systemctl daemon-reload',
    'systemctl enable ' + SERVICE + '.service',
    '',
    '# ⑤ 部署前先复核空闲回环端口（' + (ctx.port === undefined || ctx.port === null ? '{{PORT}}' : ctx.port) + '），端口被占就换一个，不换用网页版的端口：',
    '#    ssh <别名> "ss -ltnp | grep -w \':<端口>\' || echo PORT_FREE"',
    '',
    '# ⑥ 共享 nginx 入口需要 reload 才能加载新站点配置。这一步由运维人工执行，',
    '#    且执行前要确认不影响网页版入口——本工具不会自动跑 nginx reload。',
    '',
  ].join('\n');
}

// ── tar（零依赖 ustar 写入与读取）────────────────────────────────────────

function octalField(value, digits) {
  return value.toString(8).padStart(digits, '0');
}

function splitTarName(name) {
  const bytes = Buffer.byteLength(name, 'utf8');
  if (bytes <= 100) return { prefix: '', base: name };
  const idx = name.lastIndexOf('/', name.length - 1 - Math.max(0, name.length - 100));
  if (idx > 0 && Buffer.byteLength(name.slice(0, idx), 'utf8') <= 155 && Buffer.byteLength(name.slice(idx + 1), 'utf8') <= 100) {
    return { prefix: name.slice(0, idx), base: name.slice(idx + 1) };
  }
  throw new DeployError('打包路径过长（超过 ustar 100+155 字节限制）：' + name);
}

function tarHeader(fields) {
  const { name, type, size = 0, mode = 0o644, mtimeSec = 0, linkName = '' } = fields;
  const header = Buffer.alloc(512, 0);
  const { prefix, base } = splitTarName(name);
  header.write(base, 0, 'latin1');
  header.write(octalField(mode, 7), 100, 'latin1');
  header.write(octalField(0, 7), 108, 'latin1');
  header.write(octalField(0, 7), 116, 'latin1');
  header.write(octalField(size, 11), 124, 'latin1');
  header.write(octalField(Math.floor(mtimeSec), 11), 136, 'latin1');
  header.write('        ', 148, 'latin1');
  header.write(type, 156, 'latin1');
  if (linkName) header.write(linkName, 157, 'latin1');
  header.write('ustar\0', 257, 'latin1');
  header.write('00', 263, 'latin1');
  header.write(prefix, 345, 'latin1');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(octalField(sum, 6) + '\0 ', 148, 'latin1');
  return header;
}

const padTo512 = (buf) => (buf.length % 512 === 0 ? buf : Buffer.concat([buf, Buffer.alloc(512 - (buf.length % 512), 0)]));

// entries: [{name, content:Buffer|null, mode}]；目录自动补齐，全部按名字排序保证产物可复现。
export function createTarFile(entries, outFile, options = {}) {
  const mtimeSec = options.mtimeSec !== undefined
    ? options.mtimeSec
    : Math.floor(Date.now() / 1000);
  const sorted = entries.slice().sort((a, b) => (a.name < b.name ? -1 : 1));
  const dirs = new Set();
  for (const entry of sorted) {
    const parts = entry.name.split('/');
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
  }
  const chunks = [];
  for (const name of [...dirs].sort()) {
    chunks.push(tarHeader({ name: name + '/', type: '5', mode: 0o755, mtimeSec }));
  }
  for (const entry of sorted) {
    const content = entry.content || Buffer.alloc(0);
    chunks.push(tarHeader({ name: entry.name, type: '0', size: content.length, mode: entry.mode || 0o644, mtimeSec }));
    chunks.push(padTo512(content));
  }
  chunks.push(Buffer.alloc(1024, 0));
  const archive = Buffer.concat(chunks);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, archive);
  return { outFile, bytes: archive.length, fileCount: sorted.length, dirCount: dirs.size };
}

export function readTarEntries(tarFile) {
  const buf = fs.readFileSync(tarFile);
  const out = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const nameField = header.subarray(0, 100).toString('latin1').replace(/\0.*$/, '');
    const prefixField = header.subarray(345, 500).toString('latin1').replace(/\0.*$/, '');
    const type = String.fromCharCode(header[156] || 0x30);
    const size = parseInt(header.subarray(124, 136).toString('latin1').replace(/\0.*$/, '') || '0', 8) || 0;
    const fullName = prefixField ? prefixField + '/' + nameField : nameField;
    offset += 512;
    const data = type === '0' ? buf.subarray(offset, offset + size) : null;
    if (data) out.push({ name: fullName.replace(/\/$/, ''), type, size, sha256: crypto.createHash('sha256').update(data).digest('hex') });
    else out.push({ name: fullName, type, size: 0, sha256: null });
    offset += Math.ceil(size / 512) * 512;
  }
  return out;
}

// ── 构建产物 ─────────────────────────────────────────────────────────────

export function buildArtifacts(ctx) {
  const { sourceRoot, outDir, version, port, domain, entry } = ctx;
  const content = collectContent({ sourceRoot });
  const fileRecords = content.files.map((rel) => {
    const abs = path.join(sourceRoot, rel.split('/').join(path.sep));
    const buffer = fs.readFileSync(abs);
    return {
      name: rel,
      content: buffer,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      size: buffer.length,
    };
  });
  const digest = crypto.createHash('sha256').update(fileRecords
    .map((record) => record.name + ':' + record.sha256).join('\n')).digest('hex');
  const releaseSha = digest.slice(0, 16);
  const tarPath = path.join(outDir, SERVICE + '.tar');
  const tar = createTarFile(fileRecords, tarPath);
  const unit = renderServiceUnit({ port, entry });
  const nginx = renderNginxConf({ port, domain });
  const install = renderInstallScript({ port });
  fs.writeFileSync(path.join(outDir, SERVICE + '.service'), unit);
  fs.writeFileSync(path.join(outDir, 'nginx-wujinxia.conf'), nginx);
  fs.writeFileSync(path.join(outDir, 'install.sh'), install);
  const nodeCheck = nodeVersionCheck(ctx.nodeVersionString || process.version);
  const manifest = {
    kind: 'wujinxia-deploy-manifest',
    service: SERVICE,
    version,
    releaseSha,
    createdAt: new Date().toISOString(),
    installDir: INSTALL_DIR,
    currentLink: CURRENT_LINK,
    stateDir: STATE_DIR,
    envFile: ENV_FILE,
    siteConf: SITE_CONF_PATH,
    unitPath: UNIT_PATH,
    healthPath: HEALTH_PATH,
    port: port === undefined ? '{{PORT}}' : port,
    domain: domain || '{{DOMAIN}}',
    entry: entry || 'cloud/server.mjs',
    tar: path.basename(tarPath),
    tarBytes: tar.bytes,
    tarSha256: sha256File(tarPath),
    fileCount: fileRecords.length,
    totalBytes: fileRecords.reduce((sum, record) => sum + record.size, 0),
    groups: content.groups.map((group) => ({ name: group.name, files: group.files.length })),
    distPresent: content.distPresent,
    node: nodeCheck,
    files: fileRecords.map((record) => ({ path: record.name, sha256: record.sha256, size: record.size })),
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const texts = { unit, nginx, install };
  assertCleanTargets([unit, nginx, install], '产物文本');
  return { outDir, tarPath, manifest, texts };
}

// ── 发布与回滚计划 ───────────────────────────────────────────────────────

export function resolveDeployConfig(flags = {}, env = process.env, root = projectRoot()) {
  const hostRaw = flags.host || env.WUJINXIA_DEPLOY_HOST || '';
  const portRaw = flags.port !== undefined && flags.port !== true ? String(flags.port) : (env.WUJINXIA_DEPLOY_PORT || '');
  const outDir = path.resolve(String(flags.out || env.WUJINXIA_DEPLOY_OUT || path.join(root, DEFAULT_TMP_DIR)));
  return {
    root,
    sourceRoot: path.resolve(String(flags['source-root'] || env.WUJINXIA_DEPLOY_SOURCE_ROOT || root)),
    outDir,
    host: hostRaw,
    port: portRaw ? Number(portRaw) : undefined,
    domain: flags.domain ? String(flags.domain) : (env.WUJINXIA_DEPLOY_DOMAIN || ''),
    version: flags.version ? String(flags.version) : (env.WUJINXIA_DEPLOY_VERSION || ''),
    entry: flags.entry ? String(flags.entry) : (env.WUJINXIA_DEPLOY_ENTRY || 'cloud/server.mjs'),
    nodeBin: flags['node-bin'] ? String(flags['node-bin']) : (env.WUJINXIA_NODE_BIN || '/usr/bin/env'),
    release: flags.release ? String(flags.release) : (env.WUJINXIA_DEPLOY_RELEASE || ''),
    apply: Boolean(flags.apply),
    traceFile: env.WUJINXIA_EXEC_TRACE ? path.resolve(env.WUJINXIA_EXEC_TRACE) : null,
    transportStub: env.WUJINXIA_TRANSPORT_STUB ? path.resolve(env.WUJINXIA_TRANSPORT_STUB) : null,
  };
}

export function assertHost(host) {
  const text = String(host || '');
  if (!text) throw new DeployError('缺少目标机 SSH 别名：请设置 WUJINXIA_DEPLOY_HOST（本项目部署机别名，例如 garden-node1）');
  if (!/^[A-Za-z0-9._-]+$/.test(text)) throw new DeployError('目标机别名格式不对：' + text);
  if (/^[0-9]/.test(text)) throw new DeployError('目标机别名不能是 IP 或数字开头，请用 ~/.ssh/config 的别名：' + text);
  if (findIpLiterals(text).length) throw new DeployError('禁止在命令里写死服务器 IP，请用 ~/.ssh/config 的别名：' + text);
  const hits = scanForbidden(text);
  if (hits.length) throw new DeployError('目标别名指向原站资源（' + hits.join('、') + '）：' + text);
  return text;
}

export function assertPort(port, { required = false } = {}) {
  if (port === undefined || port === null || port === '') {
    if (required) throw new DeployError('缺少端口：发布前必须复核空闲回环端口，用 --port 指定（127.0.0.1 上的端口，不复用网页版端口）');
    return undefined;
  }
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new DeployError('端口必须是 1024–65535 的整数，现得到：' + port);
  }
  return value;
}

const sshWrap = (host, script) => ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', host, script];

export function buildDeployPlan(ctx) {
  const host = assertHost(ctx.host);
  const port = assertPort(ctx.port, { required: ctx.apply });
  if (!ctx.version) throw new DeployError('缺少期望版本：发布要用 --version（或 WUJINXIA_DEPLOY_VERSION）指定，健康检查才有核对基准');
  const manifest = ctx.manifest;
  const release = manifest.releaseSha;
  const portText = port === undefined ? '{{PORT}}' : String(port);
  const commands = [
    { label: '复核回环端口是否空闲（本项目专用端口，不复用网页版端口）', argv: sshWrap(host, `ss -ltnp 2>/dev/null | grep -w ':${portText}' || echo PORT_FREE_${portText}`) },
    { label: '创建本次发布目录', argv: sshWrap(host, `install -d -m 0755 ${RELEASES_DIR}/${release}`) },
    { label: '上传发布包', argv: ['scp', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', ctx.tarPath, `${host}:${INSTALL_DIR}/releases/${release}.tar`] },
    { label: '远端 sha256 与本机对平', argv: sshWrap(host, `sha256sum ${INSTALL_DIR}/releases/${release}.tar`) },
    { label: '解包并切 current 软链，只重启本项目服务', argv: sshWrap(host, [
      'set -e',
      `tar -xf ${INSTALL_DIR}/releases/${release}.tar -C ${INSTALL_DIR}/releases/${release}`,
      `ln -sfn ${INSTALL_DIR}/releases/${release} ${CURRENT_LINK}`,
      `rm -f ${INSTALL_DIR}/releases/${release}.tar`,
      `systemctl restart ${SERVICE}`,
    ].join('; ')) },
    { label: '服务状态', argv: sshWrap(host, `systemctl is-active ${SERVICE}`) },
    { label: '健康检查核对版本', argv: sshWrap(host, `curl -fsS --max-time 10 http://127.0.0.1:${portText}${HEALTH_PATH}`) },
  ];
  assertCleanTargets(commands, '发布命令');
  return { host, port, release, commands, expectedVersion: ctx.version, tarSha256: manifest.tarSha256 };
}

export function buildRollbackPlan(ctx) {
  const host = assertHost(ctx.host);
  const port = assertPort(ctx.port, { required: ctx.apply });
  const release = String(ctx.release || '');
  if (!/^[0-9a-f]{8,16}$/.test(release)) {
    throw new DeployError('--rollback 需要 --release <上一版 sha>（8–16 位十六进制，取自远端 ' + RELEASES_DIR + ' 目录名）');
  }
  const portText = port === undefined ? '{{PORT}}' : String(port);
  const commands = [
    { label: '确认上一版发布目录存在', argv: sshWrap(host, `test -d ${RELEASES_DIR}/${release} && echo RELEASE_OK_${release}`) },
    { label: '只切本项目 current 软链并重启本项目服务', argv: sshWrap(host, [
      'set -e',
      `ln -sfn ${RELEASES_DIR}/${release} ${CURRENT_LINK}`,
      `systemctl restart ${SERVICE}`,
    ].join('; ')) },
    { label: '健康检查核对版本', argv: sshWrap(host, `curl -fsS --max-time 10 http://127.0.0.1:${portText}${HEALTH_PATH}`) },
  ];
  assertCleanTargets(commands, '回滚命令');
  return { host, port, release, commands };
}

export function executePlan(plan, ctx) {
  const results = [];
  for (const step of plan.commands) {
    const res = runCommand({
      argv: step.argv,
      apply: ctx.apply,
      traceFile: ctx.traceFile,
      transportStub: ctx.transportStub,
      label: step.label,
    });
    results.push({ label: step.label, argv: res.argv, dryRun: res.dryRun, status: res.status, stdout: res.stdout, printed: res.printed });
    if (res.dryRun) continue;
    if (res.status !== 0) {
      throw new DeployError('发布中断：命令「' + redact(res.printed).slice(0, 200) + '」退出码 '
        + String(res.status ?? (res.error ? res.error.message : '未知')) + '；'
        + redact(String(res.stderr || res.stdout || '')).slice(0, 400));
    }
  }
  const health = results[results.length - 1];
  if (health && !health.dryRun) {
    let parsed;
    try {
      parsed = JSON.parse(String(health.stdout || '').trim());
    } catch {
      throw new DeployError('健康检查回包不是 JSON，发布结果不可信：' + redact(String(health.stdout || '')).slice(0, 200));
    }
    if (parsed.service !== SERVICE || parsed.version !== plan.expectedVersion) {
      throw new DeployError(`健康检查核对不符：期望 service=${SERVICE} version=${plan.expectedVersion}，实得 service=${String(parsed.service)} version=${String(parsed.version)}`);
    }
  }
  return results;
}

// ── CLI ─────────────────────────────────────────────────────────────────

export const HELP_TEXT = [
  '用法：node tools/wujinxia-deploy.mjs [选项]',
  '  默认只做校验并生成产物到 .runtime/wujinxia-deploy/，然后打印将要执行的命令（dry-run），不连任何服务器。',
  '选项：--host <ssh别名> --port <回环端口> --domain <子域名> --version <期望版本> --entry <入口文件>',
  '      --source-root <内容根目录> --out <产物目录> --release <上一版 sha> --rollback --apply',
  '环境变量：WUJINXIA_DEPLOY_HOST / _PORT / _DOMAIN / _VERSION / _ENTRY / _SOURCE_ROOT / _OUT / _RELEASE，',
  '  WUJINXIA_EXEC_TRACE（执行痕迹文件）、WUJINXIA_TRANSPORT_STUB（测试用命令替身）。',
].join('\n');

export function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const log = deps.log || ((text) => console.log(text));
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    log('[发布] 失败：' + error.message);
    return 2;
  }
  if (parsed.help) {
    log(HELP_TEXT);
    return 0;
  }
  const flags = { ...parsed.flags, apply: parsed.apply };
  if (parsed.command && parsed.command !== 'deploy' && parsed.command !== 'rollback') {
    log(HELP_TEXT);
    log('[发布] 失败：未知命令 ' + parsed.command);
    return 2;
  }
  const ctx = resolveDeployConfig(flags, env);
  try {
    assertPort(ctx.port, { required: false });
    if (parsed.command === 'rollback' || parsed.flags.rollback) {
      const plan = buildRollbackPlan({ ...ctx, manifest: null });
      for (const step of plan.commands) {
        log('[发布] ' + (ctx.apply ? 'exec' : 'dry-run') + ' ' + step.label + '：' + step.argv.join(' '));
      }
      executePlan(plan, ctx);
      log('[发布] ' + (ctx.apply ? '已执行回滚' : 'dry-run：没有起 ssh/scp/curl'));
      log('RESULT_JSON=' + JSON.stringify({ mode: 'rollback', apply: ctx.apply, release: plan.release, host: plan.host, commands: plan.commands.length }));
      return 0;
    }
    fs.mkdirSync(ctx.outDir, { recursive: true });
    const version = ctx.version;
    if (!version) throw new DeployError('缺少期望版本：用 --version 或 WUJINXIA_DEPLOY_VERSION 指定（健康检查要按它核对）');
    const artifacts = buildArtifacts({ ...ctx, version });
    log('[发布] 内容校验通过：' + artifacts.manifest.fileCount + ' 个文件、' + artifacts.manifest.groups
      .map((group) => group.name + '=' + group.files).join('，') + '，后台构建件 ' + (artifacts.manifest.distPresent ? '已包含' : '没有（admin/dist 不存在）'));
    log('[发布] ' + artifacts.manifest.node.message);
    log('[发布] 发布包：' + artifacts.tarPath + '（sha256 ' + artifacts.manifest.tarSha256.slice(0, 16) + '…，release ' + artifacts.manifest.releaseSha + '）');
    log('[发布] 产物：' + SERVICE + '.service、nginx-wujinxia.conf、install.sh、manifest.json → ' + ctx.outDir);
    const plan = buildDeployPlan({ ...ctx, version, manifest: artifacts.manifest, tarPath: artifacts.tarPath });
    for (const step of plan.commands) {
      log('[发布] ' + (ctx.apply ? 'exec' : 'dry-run') + ' ' + step.label + '：' + step.argv.join(' '));
    }
    const results = executePlan(plan, ctx);
    log('[发布] ' + (ctx.apply ? '发布命令已执行完，健康检查已核对版本 ' + version : 'dry-run：没有起 scp/ssh/curl，不建远端目录、不重启服务'));
    log('RESULT_JSON=' + JSON.stringify({
      mode: ctx.apply ? 'apply' : 'dry-run',
      releaseSha: artifacts.manifest.releaseSha,
      fileCount: artifacts.manifest.fileCount,
      tar: artifacts.tarPath,
      host: plan.host,
      port: plan.port === undefined ? null : plan.port,
      expectedVersion: version,
      commands: plan.commands.map((step) => step.argv.join(' ')),
      executed: results.filter((r) => !r.dryRun).length,
    }));
    return 0;
  } catch (error) {
    if (error instanceof DeployError || error instanceof BackupError) {
      log('[发布] 失败：' + redact(error.message));
      log('RESULT_JSON=' + JSON.stringify({ ok: false, error: redact(error.message) }));
      return 3;
    }
    log('[发布] 意外失败：' + redact(String(error && error.stack || error)).slice(0, 600));
    return 4;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
