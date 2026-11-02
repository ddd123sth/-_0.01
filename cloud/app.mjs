// Assembles the cloud service: modules, HTTP handler, static admin and retention purge.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { openStore } from './db.mjs';
import { createPasswordHasher } from './password.mjs';
import { createSessionManager } from './session.mjs';
import { createRateLimiter } from './ratelimit.mjs';
import { createLogPurger } from './purge.mjs';
import { createSoftwareRoutes } from './auth.mjs';
import { createLogRoutes } from './logs.mjs';
import { createAdminRoutes } from './admin.mjs';
import { getSettings } from './settings.mjs';
import { SERVICE_NAME, SERVICE_VERSION } from './config.mjs';

const JSON_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const STATIC_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2',
};

function securityHeaders(csp) {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': csp,
  };
}

function splitPattern(pattern) { return pattern.split('/').filter(Boolean); }
function matchPattern(segments, pattern) {
  const parts = splitPattern(pattern);
  if (parts.length !== segments.length) return null;
  const params = {};
  for (let index = 0; index < parts.length; index += 1) {
    const token = parts[index];
    if (token.startsWith(':')) { params[token.slice(1)] = decodeURIComponent(segments[index]); continue; }
    if (token !== segments[index]) return null;
  }
  return params;
}

function bootstrapAdmin(store, config, hasher) {
  const file = config.adminBootstrapFile;
  if (!file || !fs.existsSync(file)) return Promise.resolve();
  const existing = store.get('SELECT COUNT(*) AS n FROM admins').n;
  if (Number(existing) > 0) return Promise.resolve();
  const text = fs.readFileSync(file, 'utf8');
  const created = store.nowIso();
  const jobs = [];
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.includes('\t') ? '\t' : ':';
    const index = trimmed.indexOf(separator);
    if (index <= 0) continue;
    const username = trimmed.slice(0, index).trim();
    const password = trimmed.slice(index + separator.length);
    if (!username || !password) continue;
    jobs.push(hasher.hash(password).then(hash => {
      try { store.run('INSERT INTO admins(username,password_hash,enabled,created_at) VALUES(?,?,1,?)', username, hash, created); }
      catch { /* duplicate, skip */ }
    }));
  }
  return Promise.all(jobs);
}

export async function createApp(config) {
  const store = openStore({ file: config.dbFile });
  const hasher = createPasswordHasher(config.scrypt);
  const sessions = createSessionManager(store, config);
  const limiter = createRateLimiter(store);
  // 〔K27·2026-10-20〕健康口原来把 `db: 'ok'` 和 `version: '0.1.0'` 写死在返回里：
  // 数据库读穿了也照样报 ok，两个不同发布件在外部看完全一样。现在 db 真读一次、带上本次启动代际。
  const health = () => {
    let dbReadable = false;
    try { dbReadable = Number(store.get('SELECT 1 AS n')?.n) === 1; } catch { dbReadable = false; }
    return { ok: dbReadable, service: SERVICE_NAME, version: SERVICE_VERSION, generation: bootGeneration,
      serverTimeMs: Date.now(), db: dbReadable ? 'ok' : 'unavailable' };
  };
  const bootGeneration = crypto.randomUUID();

  await bootstrapAdmin(store, config, hasher);

  const routes = [
    ...createSoftwareRoutes({ store, config, hasher, sessions, limiter, health }),
    ...createLogRoutes({ store, config, sessions }),
    ...createAdminRoutes({ store, config, hasher, sessions, limiter, health }),
  ];
  // This budget belongs to the app instance, not an individual HTTP request.
  // Keeping it beside the shared route table makes concurrent log batches
  // observe the same slot count while auth and license routes remain free.
  let logRequestsInFlight = 0;

  // 〔K27·2026-10-20〕清理语义抽到 purge.mjs 做唯一出处：服务与 `cloud/cli.mjs purge-logs` 调的是同一个函数，
  // 不再出现「CLI 按 occurred_at 直删、服务按首次接收锚定两级保留」两套账并存那种会删错行的形状。
  const { purgeOnce } = createLogPurger({ store, config, bootGeneration });

  async function readBody(request, limitBytes) {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > limitBytes) return { tooLarge: true };
      chunks.push(chunk);
    }
    if (!size) return { value: {} };
    try { return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; }
    catch { return { invalid: true }; }
  }

  function resolveBearer(request) {
    const header = request.headers.authorization || '';
    if (typeof header !== 'string') return '';
    const match = /^Bearer (.+)$/u.exec(header);
    return match ? match[1].trim() : '';
  }

  function serveStatic(request, response, pathname) {
    const staticDir = path.resolve(config.adminStaticDir);
    const methodsAllowed = request.method === 'GET' || request.method === 'HEAD';
    if (!methodsAllowed) {
      response.writeHead(405, { ...securityHeaders(JSON_CSP), 'Content-Type': 'application/json; charset=utf-8', Allow: 'GET, HEAD' });
      return response.end(JSON.stringify({ error: '管理后台仅支持只读访问', code: 'METHOD_NOT_ALLOWED' }));
    }
    if (!fs.existsSync(staticDir) || !fs.statSync(staticDir).isDirectory()) {
      return writeJson(response, 404, { error: '管理后台静态资源尚未构建', code: 'ADMIN_STATIC_MISSING' });
    }
    let relative = pathname === '/admin' || pathname === '/admin/' ? 'index.html' : pathname.slice('/admin/'.length);
    relative = decodeURIComponent(relative).replace(/^\/+/u, '');
    if (relative === '') relative = 'index.html';
    const target = path.resolve(staticDir, relative);
    const within = target === staticDir || target.startsWith(staticDir + path.sep);
    if (!within) return writeJson(response, 404, { error: '管理后台静态资源不存在', code: 'ADMIN_STATIC_NOT_FOUND' });
    let file = target;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      const fallback = path.join(target, 'index.html');
      if (fs.existsSync(fallback) && fs.statSync(fallback).isFile()) file = fallback;
      else return writeJson(response, 404, { error: '管理后台静态资源不存在', code: 'ADMIN_STATIC_NOT_FOUND' });
    }
    const type = STATIC_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    response.writeHead(200, { ...securityHeaders(STATIC_CSP), 'Content-Type': type });
    if (request.method === 'HEAD') return response.end();
    fs.createReadStream(file).pipe(response);
    return undefined;
  }

  function redirect(response, location) {
    response.writeHead(302, { ...securityHeaders(JSON_CSP), Location: location });
    response.end();
  }

  function writeJson(response, status, body, extraHeaders) {
    const headers = { ...securityHeaders(JSON_CSP), 'Content-Type': 'application/json; charset=utf-8', ...(extraHeaders || {}) };
    response.writeHead(status, headers);
    response.end(JSON.stringify(body));
  }

  async function handler(request, response) {
    const host = `${config.bind === '::1' ? '[::1]' : config.bind}:${config.port}`;
    let url;
    try { url = new URL(request.url, `http://${host}`); }
    catch { return writeJson(response, 400, { error: '请求地址格式不正确', code: 'INPUT_INVALID' }); }
    const pathname = url.pathname.replace(/\/{2,}/gu, '/');

    if (request.method === 'GET' || request.method === 'HEAD') {
      if (pathname === '/') return redirect(response, '/admin/');
      if (pathname === '/admin') return redirect(response, '/admin/');
      if (pathname === '/admin/' || pathname.startsWith('/admin/')) return serveStatic(request, response, pathname);
    }

    const segments = url.pathname.split('/').filter(Boolean);
    const matchedPath = routes.filter(route => matchPattern(segments, route.path));
    if (!matchedPath.length) {
      return writeJson(response, 404, { error: '接口不存在', code: 'ROUTE_NOT_FOUND' });
    }
    const route = matchedPath.find(item => item.method === request.method);
    if (!route) {
      const allowed = [...new Set(matchedPath.map(item => item.method))].join(', ');
      return writeJson(response, 405, { error: '不支持此方法', code: 'METHOD_NOT_ALLOWED' }, { Allow: allowed });
    }

    // 大正文先过在途闸，再看写库排队：日志拥塞时要把新批量挡在门外（带 Retry-After），
    // 不能让它把授权、续期与本机停止一起拖住。额度取不到就是 503，不静默丢弃。
    async function withLogSlot(route, run) {
      if (route.path !== '/api/logs/batch') return run();
      if (logRequestsInFlight >= config.logBudget.globalRequestsInFlight) {
        return writeJson(response, 503, { error: '日志通道在途已满，请按 Retry-After 稍后重发', code: 'LOG_QUEUE_FULL' }, { 'Retry-After': '5' });
      }
      logRequestsInFlight += 1;
      try { return await run(); } finally { logRequestsInFlight -= 1; }
    }

    const limitBytes = route.maxBody || config.normalBodyBytes;
    return withLogSlot(route, async () => {
    const body = await readBody(request, limitBytes);
    if (body.tooLarge) return writeJson(response, 413, { error: '请求体超过大小限制', code: 'BODY_TOO_LARGE' });
    if (body.invalid) return writeJson(response, 400, { error: '请求体不是合法的 JSON', code: 'INPUT_INVALID' });

    const ctx = {
      method: request.method,
      pathname,
      params: matchPattern(segments, route.path) || {},
      query: url.searchParams,
      body: body.value,
      headers: request.headers,
      bearer: resolveBearer(request),
      ip: request.socket.remoteAddress || '',
    };
    try {
      const result = await route.handler(ctx);
      if (!result || typeof result.status !== 'number') return writeJson(response, 500, { error: '服务处理异常', code: 'INTERNAL_ERROR' });
      return writeJson(response, result.status, result.body, result.headers);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      const code = typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR';
      const message = status >= 500 ? '服务器内部错误' : String(error?.message || '请求处理失败');
      return writeJson(response, status, { error: message, code });
    }
    });
  }

  function close() {
    try { store.db.close(); } catch { /* ignore */ }
  }

  return { handler, store, config, sessions, hasher, limiter, purgeOnce, bootGeneration, close };
}

export async function startServer(config) {
  const app = await createApp(config);
  const server = http.createServer(app.handler);
  app.purgeOnce({ trigger: 'boot' });
  const timer = setInterval(() => { try { app.purgeOnce({ trigger: 'timer' }); } catch { /* keep the service alive */ } }, config.purgeIntervalMinutes * 60_000);
  timer.unref?.();
  server.on('close', () => clearInterval(timer));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.bind, () => {
      server.removeListener('error', reject);
      resolve({ server, app, address: server.address(), close: () => new Promise(done => { clearInterval(timer); server.close(() => { app.close(); done(); }); }) });
    });
  });
}
