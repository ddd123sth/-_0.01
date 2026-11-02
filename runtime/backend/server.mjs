import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createBackend } from './bootstrap.mjs';
import { readCatalog } from './compat/catalog.mjs';
import { canonical, newId, parseStored, plainObject, problem, safeBackendErrorPath } from './common.mjs';
import { CONFIG_FIELDS, atPath } from './config/fields.mjs';
import { snapshotCacheStats } from './facts/snapshot-cache.mjs';
import { syncCosts } from './execution/sync-costs.mjs';
import { confirmSourceInstallBinding, readImportedEvidenceDigests } from './migration/evidence-digests.mjs';
import { hashLedgerBytes, ledgerJsonFingerprint, serializeLedgerJson } from './persistence/json-contract.mjs';
import { orderFlowerAuditDomain, projectOrderFlowerPreparation, projectOrderFlowerVerification,
  readOrderFlowerTargetAudit, projectOrderFlowerLaterAdmission, projectOrderFlowerCurrentNeedAdmission } from './features/order-flower/audit-projection.mjs';
import { readOrderFlowerDeliveryAudit } from './features/order-flower/audit-accounting.mjs';
import { orderFlowerAuxiliaryAuditDomain, readOrderFlowerAuxiliaryAuditTarget } from './features/order-flower/auxiliary-audit.mjs';
import { WATERWHEEL_CONTRACT_REF, WATERWHEEL_DEFINITIONS, WATERWHEEL_METHODS, WATERWHEEL_SCOPES, WATERWHEEL_POST_READ } from './features/waterwheel/rpc-contract.mjs';
import { WATERWHEEL_EXTENSION_ID, WATERWHEEL_SOURCE_PIN } from './official-waterwheel-extension.mjs';
import { FREE_WATER_CONTRACT_REF, FREE_WATER_DEFINITIONS, FREE_WATER_METHODS, FREE_WATER_SCOPES, FREE_WATER_POST_READ } from './features/free-water/rpc-contract.mjs';
import { FREE_WATER_EXTENSION_ID, FREE_WATER_SOURCE_PIN } from './official-free-water-extension.mjs';
import { FLOWER_RACK_CONTRACT_REF, FLOWER_RACK_DEFINITIONS, FLOWER_RACK_METHODS, FLOWER_RACK_POST_READ, FLOWER_RACK_SCOPES } from './features/flower-rack/rpc-contract.mjs';
import { FLOWER_RACK_EXTENSION_ID, FLOWER_RACK_SOURCE_PIN } from './official-flower-rack-extension.mjs';
import { resolveAcceptedLandObservationEvidence } from './features/land/compatibility-evidence.mjs';
import { resolveAcceptedCustomerObservationEvidence } from './features/customer/projection.mjs';
import { startExplicitAccount } from './execution/explicit-account-start.mjs';

const token = process.env.GARDEN_LOCAL_TOKEN || '', port = Number(process.env.GARDEN_LOCAL_PORT);
if (!/^[a-f0-9]{64}$/i.test(token) || !Number.isSafeInteger(port) || port < 1024 || port > 65535) throw problem('LOCAL_HOST_CONFIG_REQUIRED', '本机回环鉴权尚未配置', 503);
function failureCauses(error) {
  const result = [], pending = [error], seen = new Set();
  while (pending.length && result.length < 4) {
    const current = pending.shift(); if (!current || typeof current !== 'object' || seen.has(current)) continue; seen.add(current);
    result.push({ code: /^[A-Z0-9_]{1,96}$/.test(String(current.code || '')) ? current.code : null,
      sqliteCode: Number.isSafeInteger(current.errcode) ? current.errcode : null, path: safeBackendErrorPath(current, 3) });
    pending.push(current.cause); if (current instanceof AggregateError) pending.push(...current.errors.slice(0, 3));
  }
  return result;
}
function saveLastFailure(kind, detail) {
  const dir = process.env.DATA_DIR;
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || !['request','fatal','exit'].includes(kind)) return;
  try {
    const text = JSON.stringify({ schema: 'backend-last-failure/v1', kind, at: new Date().toISOString(), pid: process.pid,
      generation: process.env.GARDEN_NATIVE_GENERATION ?? null, ...detail });
    if (Buffer.byteLength(text) <= 4096) fs.writeFileSync(path.join(dir, 'backend-last-' + kind + '.json'), text, { mode: 0o600 });
  } catch { /* This bounded diagnostic is never a recovery or STOP authority. */ }
}
process.on('uncaughtExceptionMonitor', (error, origin) => saveLastFailure('fatal', {
  code: /^[A-Z0-9_]{1,96}$/.test(String(error?.code || '')) ? error.code : 'BACKEND_UNCAUGHT_ERROR',
  origin: ['uncaughtException','unhandledRejection'].includes(origin) ? origin : 'unknown', path: safeBackendErrorPath(error), causes: failureCauses(error) }));
process.on('exit', code => saveLastFailure('exit', { code }));
let localEventLoopDelay = null;
try {
  const monitor = monitorEventLoopDelay({ resolution: 20 });
  monitor.enable();
  localEventLoopDelay = monitor;
} catch { /* Optional control-plane profiling must never prevent engine startup. */ }
if (!process.env.DATA_DIR || !path.isAbsolute(process.env.DATA_DIR)) throw problem('LOCAL_STORAGE_CONFIG_REQUIRED', '本机资料目录尚未配置', 503);
process.env.GARDEN_REQUIRE_CREDENTIAL_KEY = '1'; process.env.NODE_ENV = 'production';
delete process.env.GAME_WS_PROXY; delete process.env.GAME_HTTP_PROXY; delete process.env.GARDEN_DEV_UNTHROTTLE;
const here = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(here, '../../ui');
const backend = createBackend({ dataDir: process.env.DATA_DIR, credentialKey: process.env.GARDEN_CREDENTIAL_KEY,
  baseUrl: process.env.GARDEN_SOFTWARE_BASE_URL, deviceProfilePath: process.env.GARDEN_ANDROID_DEVICE_PROFILE,
  stopFile: process.env.GARDEN_LOCAL_STOP_FILE, appVersion: process.env.GARDEN_APP_VERSION });
let closing = false;
function reply(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
  response.end(JSON.stringify(value));
}
async function body(request, maxBytes = 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw problem('LOCAL_BODY_TOO_LARGE', '请求超过此入口的资料上限', 413);
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw problem('LOCAL_BODY_INVALID', '请求不是有效JSON', 400); }
}
function authorized(request) {
  const actual = Buffer.from(request.headers.authorization || ''), expected = Buffer.from('Bearer ' + token);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected) &&
    (!request.headers.origin || request.headers.origin === 'http://127.0.0.1:' + port);
}
function activeAccount(id) { return backend.accounts.row(backend.owner(), id); }
function writeRow(row) {
  return { operationId: row.operation_id, method: row.method,
    featureId: row.feature_id, scope: row.scope, status: row.business_verdict, transport: row.transport_state,
    verdict: row.business_verdict, revision: row.revision, configRevision: row.config_revision,
    runEpoch: row.run_epoch, connectionEpoch: row.connection_epoch, writeSlot: row.write_slot === 1,
    preparedAt: row.prepared_at, updatedAt: row.updated_at };
}
function writeRows(subjectRef, ownerRef, limit = 100) {
  return backend.ledger.listOperations({ subjectRef, ownerRef, limit }).map(writeRow);
}
function writeSummaryRows(subjectRef, ownerRef, limit = 12) {
  return backend.store.all(`SELECT operation_id,method,feature_id,scope,business_verdict,transport_state,revision,config_revision,
    run_epoch,connection_epoch,write_slot,prepared_at,updated_at FROM backend_operations
    WHERE owner_ref=? AND subject_ref=? ORDER BY prepared_at DESC,operation_id DESC LIMIT ?`, ownerRef, subjectRef, limit).map(writeRow);
}

function publicEvidence(value, depth = 0) {
  if (depth > 14) return '[层数超限]';
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.replace(/\b(?:https?|wss?):\/\/[^\s]+/giu, '[网络地址已隐藏]').slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 256).map(item => publicEvidence(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 256).map(([key, entry]) => [key,
    /password|passwd|credential|authorization|cookie|secret|token|username|endpoint/i.test(key) &&
      !(key === 'tokenPresent' && typeof entry === 'boolean') &&
      !(key === 'authorizationRef' && typeof entry === 'string' && /^art-cost-authorization:[a-f0-9]{64}$/.test(entry))
      ? '[已隐藏]' : publicEvidence(entry, depth + 1)]));
  return null;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1:' + port);
    if (!url.pathname.startsWith('/api/local/')) {
      if (!['GET', 'HEAD'].includes(request.method)) return reply(response, 405, { error: '不支持此操作' });
      const relative = decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      const file = path.resolve(uiRoot, relative);
      if (!file.startsWith(uiRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return reply(response, 404, { error: '页面不存在' });
      const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' }[path.extname(file)] || 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" });
      if (request.method === 'HEAD') return response.end();
      fs.createReadStream(file).pipe(response); return;
    }
    if (!authorized(request)) return reply(response, 401, { error: '本机连接授权已失效，请重新连接手机运行服务', code: 'LOCAL_TOKEN_INVALID', scope: 'local-engine' });
    const route = url.pathname.slice('/api/local'.length), method = request.method;
    // Debug builds only: deliberately block the Node event loop so the Java liveness
    // watchdog can be tested against the real "process alive, engine wedged" case.
    // The route is unreachable unless the service sets GARDEN_DEBUG_TOOLS=1.
    if (route === '/debug/stall' && method === 'POST' && process.env.GARDEN_DEBUG_TOOLS === '1') {
      const input = await body(request, 512);
      const ms = Math.max(0, Math.min(120000, Number(input && input.ms) || 0));
      reply(response, 200, { scheduledMs: ms });
      setImmediate(() => { const end = Date.now() + ms; while (Date.now() < end) { /* intentional */ } });
      return;
    }
    if (route === '/debug/account-hold' && method === 'POST' && process.env.GARDEN_DEBUG_TOOLS === '1') {
      // Debug only: apply or release the same subject-scoped recovery hold the
      // bootstrap uses, without fabricating business data or a cleanup row.
      const input = await body(request, 512);
      const id = String(Number(input && input.accountRef)), action = input && input.action;
      if (!/^[1-9]\d*$/.test(id) || !['hold', 'release'].includes(action))
        return reply(response, 400, { error: '调试账号隔离参数无效' });
      const ownerRef = backend.owner();
      const result = backend.debugSubjectHold({ ownerRef, accountRef: id, action });
      backend.log(ownerRef, id, action === 'hold' ? '调试：已按账号作用域暂停本号新写；其他账号不受影响。' : '调试：已解除本号作用域暂停。', 'warn',
        { eventType: 'debug-account-scope-hold', action, subjectRef: result.subjectRef });
      return reply(response, 200, { ok: true, action, ...result });
    }
    if (route === '/debug/mail-raw' && method === 'GET' && process.env.GARDEN_DEBUG_TOOLS === '1') {
      try { return reply(response, 200, backend.mailDebugFrame({ ownerRef: backend.owner(), subjectRef: url.searchParams.get('subjectRef') || null }) || {}); }
      catch (error) { return reply(response, 200, { error: String(error?.code || error?.message || 'MAIL_DEBUG_FAILED').slice(0, 120) }); }
    }
    if (route === '/debug/reward-state' && method === 'GET' && process.env.GARDEN_DEBUG_TOOLS === '1') {
      try { return reply(response, 200, backend.rewardStateView({ ownerRef: backend.owner(), accountRef: url.searchParams.get('accountRef') || '3' })); }
      catch (error) { return reply(response, 200, { error: String(error?.code || error?.message || 'REWARD_STATE_FAILED').slice(0, 120) }); }
    }
    if (route === '/debug/reward-tables' && method === 'GET' && process.env.GARDEN_DEBUG_TOOLS === '1') {
      try {
        return reply(response, 200, backend.rewardTableStatus({ ownerRef: backend.owner(), accountRef: url.searchParams.get('accountRef') || '3' }));
      } catch (error) {
        return reply(response, 200, { error: typeof error?.code === 'string' ? error.code : 'REWARD_TABLE_STATUS_FAILED',
          message: String(error?.message || error).slice(0, 200) });
      }
    }
    if (route === '/debug/claim-frame' && method === 'GET' && process.env.GARDEN_DEBUG_TOOLS === '1') {
      const frame = backend.rewardDebugFrame({ ownerRef: backend.owner(), subjectRef: url.searchParams.get('subjectRef') || null });
      return reply(response, 200, frame || {});
    }
    if (route === '/debug/native-network' && method === 'GET' && process.env.GARDEN_DEBUG_TOOLS === '1') {
      // Bounded, read-only observation history for C10 evidence. Debug builds only.
      return reply(response, 200, backend.debugNativeNetworkObservations(Number(url.searchParams.get('limit') || 20)));
    }
    if (route === '/debug/snapshot-cache' && method === 'GET' && process.env.GARDEN_DEBUG_TOOLS === '1')
      return reply(response, 200, snapshotCacheStats(backend.store));
    if (route === '/debug/sync-costs' && ['GET','POST'].includes(method) && process.env.GARDEN_DEBUG_TOOLS === '1')
      return reply(response, 200, syncCosts(backend.store, method === 'POST'));
    if (route === '/debug/land-history-exit' && method === 'GET' && process.env.GARDEN_DEBUG_TOOLS === '1')
      return reply(response,200,backend.landRuntime.knownHistoryStatus());
    if (route === '/debug/outbox-retired-consumer' && method === 'POST' && process.env.GARDEN_DEBUG_TOOLS === '1') {
      const input=await body(request,512),ownerRef=backend.owner();
      if(!['order.customer','order.resident','order.satin','order.decorate'].includes(input?.parentFeatureId)
          ||!/^[1-9]\d*$/.test(String(input.accountRef)))throw problem('OUTBOX_CONSUMER_PROBE_INVALID','旧订阅核验参数无效',400);
      const account=backend.accounts.row(ownerRef,String(input.accountRef)),consumerId=`scheduler:${ownerRef}:${account.subject_ref}:${input.parentFeatureId}`;
      if(!backend.store.get('SELECT 1 FROM backend_outbox_consumer_retirements WHERE consumer_id=?',consumerId))
        throw problem('OUTBOX_CONSUMER_NOT_RETIRED','订阅尚未取得真实替代确认，未尝试旧消费',409);
      const events=backend.ledger.readPendingOutbox({consumerId,ownerRef,subjectRef:account.subject_ref,limit:1});
      return reply(response,200,{rejected:false,returned:events.length});
    }
    if (route === '/debug/account-readd' && method === 'POST' && process.env.GARDEN_DEBUG_TOOLS === '1') {
      const input=await body(request,512),ownerRef=backend.owner();
      if (!['prepare','resume'].includes(input?.action)) throw problem('ACCOUNT_READD_ACTION_INVALID','重新添加动作无效',400);
      const result=await backend.accountReaddRecovery[input.action]({ownerRef,accountRef:String(input.accountRef),
        expectedUid:input.expectedUid,expectedServerId:input.expectedServerId});
      return reply(response,200,result);
    }
    if (route === '/debug/business-stage-hold' && process.env.GARDEN_DEBUG_TOOLS === '1') {
      if (method === 'GET') return reply(response, 200, backend.debugStageHold.snapshot());
      if (method === 'POST') {
        const input = await body(request, 512);
        if (input?.action === 'release') return reply(response, 200, backend.debugStageHold.release());
        const ownerRef = backend.owner(), accountRef = String(input?.accountRef || '');
        const account = backend.accounts.row(ownerRef, accountRef);
        const held = backend.debugStageHold.arm({ ownerRef, accountRef, subjectRef: account.subject_ref, featureId: input?.featureId, stage: input?.stage });
        const refresh = input?.requireFreshRead === true ? backend.debugInvalidateCurrentFacts({ ownerRef, accountRef, featureId: input?.featureId }) : null;
        return reply(response, 200, { ...held, refresh });
      }
    }
    if (route.startsWith('/debug/')) return reply(response, 404, { error: '接口不存在' });
    if (route === '/ready' && method === 'GET') return reply(response, 200, backend.readiness());
    if (route === '/health' && method === 'GET') {
      const controlStarted = process.hrtime.bigint();
      const health = backend.health();
      const controlHandlerMs = Number(process.hrtime.bigint() - controlStarted) / 1_000_000;
      const toMs = value => Number.isFinite(value) ? Number(Math.max(0, Math.min(120000, value / 1_000_000)).toFixed(3)) : null;
      const controlPlane = { handlerMs: Number(Math.max(0, Math.min(120000, controlHandlerMs)).toFixed(3)),
        eventLoopLagAvailable: false, eventLoopLagP99Ms: null, eventLoopLagMaxMs: null };
      if (localEventLoopDelay) {
        try {
          const p99 = toMs(localEventLoopDelay.percentile(99)), max = toMs(localEventLoopDelay.max);
          localEventLoopDelay.reset();
          if (p99 !== null && max !== null) {
            controlPlane.eventLoopLagAvailable = true;
            controlPlane.eventLoopLagP99Ms = p99;
            controlPlane.eventLoopLagMaxMs = max;
          }
        } catch {
          try { localEventLoopDelay.reset(); } catch { /* Best effort only. */ }
        }
      }
      return reply(response, health.responsive && health.databaseResponsive ? 200 : 503, { ...health, controlPlane });
    }
    if (route === '/native-recovery/import' && method === 'POST') {
      return reply(response, 200, backend.importNativeRecoveryEvents((await body(request)).events));
    }
    if (route === '/status' && method === 'GET') return reply(response, 200, backend.status());
    if (route === '/engine-restart' && method === 'POST') {
      const authorization = backend.authorizeEngineRestart(await body(request, 4096));
      if (authorization.accepted !== true) return reply(response, 409, { ok: false, restartScheduled: false,
        reasonCode: authorization.reasonCode || 'ENGINE_RESTART_NOT_AUTHORIZED' });
      reply(response, 202, { ok: true, restartScheduled: true });
      setImmediate(() => { void shutdown(); });
      return;
    }
    if (route === '/stop-all' && method === 'POST') {
      // stopCommitted and cleanupComplete are deliberately separate facts.
      // A body-level 200 carries both; the HTTP status never upgrades an
      // un-drained stop into a completed one.
      const result = await backend.nativeStopAll(await body(request, 4096));
      return reply(response, 200, result);
    }
    if (route === '/native-start' && method === 'POST') {
      return reply(response, 200, backend.nativeStartControl(await body(request, 4096)));
    }
    if (route.startsWith('/software/')) {
      if (route === '/software/status' && method === 'GET') return reply(response, 200, backend.softwareStatus());
      if (route === '/software/logs' && method === 'POST') {
        return reply(response, 409, { reason: 'selection_required', message: '请到运行日志页按当前筛选范围选择上传。', queue: backend.legacyLogging.queueView() });
      }
      const handled = await backend.software.routes.handle(route, method, method === 'GET' ? null : await body(request));
      return reply(response, handled?.status || 404, handled?.payload || { error: '接口不存在' });
    }
    if (route === '/network' && method === 'POST') {
      const input = await body(request, 4096);
      const receipt = backend.supervisor.networkChanged(input);
      // Exact old retries ACK their stored receipt without rewinding the
      // public network view. Closure/drain remain separate supervisor work.
      Object.assign(backend.network, { online: receipt.online, transport: receipt.transport });
      return reply(response, 200, { ...receipt, ok: true });
    }
    if (!backend.readiness().ready) throw problem('LOCAL_ENGINE_BINDING', '手机运行服务正在准备当前软件身份', 503);
    if (route === '/catalog' && method === 'GET') return reply(response, 200, readCatalog());
    const ownerRef = backend.owner();
    if (route === '/archived-accounts') {
      if (method !== 'GET') throw problem('ARCHIVED_ACCOUNT_ACTION_FORBIDDEN', '归档游戏号仅允许读取历史资料', 405);
      if ([...url.searchParams.keys()].some(key => !['currentAccountRef', 'afterArchivedAccountRef', 'limit'].includes(key))) throw problem('ARCHIVED_ACCOUNT_QUERY_INVALID', '历史来源读取参数不正确', 400);
      return reply(response, 200, backend.archivedAccounts.list({ ownerRef,
        currentAccountRef: url.searchParams.get('currentAccountRef'), afterArchivedAccountRef: url.searchParams.get('afterArchivedAccountRef'),
        limit: Number(url.searchParams.get('limit') || 50) }));
    }
    const archiveUpload = /^\/archived-accounts\/([1-9]\d*)\/logs\/upload-selection$/.exec(route);
    if (archiveUpload && method === 'POST') {
      const input = await body(request, 16 * 1024), allowed = new Set(['category','day','from','to','keyword','level','outcomeState','errorCode','operationId','traceId']);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.has(key)))
        throw problem('LOG_MANUAL_FILTER_INVALID', '手动日志上传只接受日志页筛选条件', 400);
      backend.software.authorize({ ownerRef });
      const archive = backend.archivedAccounts.resolve({ ownerRef, archivedAccountRef: archiveUpload[1] });
      const accountRef = archive.accountRef, subjectRef = archive.subjectRef;
      const local = backend.logs.selectIds({ ownerRef, accountRef, ...input });
      const sourceRefs = backend.legacyHistory.selectUploadSources({ ownerRef, accountRef, subjectRef,
        ...input, includeRemoved: true, readOnlyArchive: true, limit: 10000 });
      const selected = local.sourceLogIds.length + sourceRefs.length;
      if (!selected) return reply(response, 200, { sent: 0, confirmed: true, reason: 'empty_selection', selected: 0 });
      const frozen = backend.cloudSync.createManualSelection({ accountRef, ...local, sourceRefs });
      const result = await backend.cloudSync.flush({ manual: true, selectionRef: frozen.selectionRef });
      return reply(response, 200, { ...result, selection: frozen });
    }
    const archiveMatch = /^\/archived-accounts\/([1-9]\d*)(?:\/([^/]+))?$/.exec(route);
    if (archiveMatch) {
      if (method !== 'GET') throw problem('ARCHIVED_ACCOUNT_ACTION_FORBIDDEN', '归档游戏号仅允许读取历史资料', 405);
      const query = Object.fromEntries(url.searchParams);
      const currentAccountRef = query.currentAccountRef ?? null;
      delete query.currentAccountRef;
      if (Object.hasOwn(query, 'limit')) query.limit = Number(query.limit);
      return reply(response, 200, backend.archivedAccounts.read({ ownerRef, archivedAccountRef: archiveMatch[1],
        currentAccountRef, view: archiveMatch[2], query }));
    }
    if (route === '/accounts' && method === 'GET') return reply(response, 200, { accounts: backend.accounts.list(ownerRef) });
    if (route === '/accounts' && method === 'POST') {
      const input = await body(request);
      if (Object.keys(input).some(key => !['username', 'password', 'remark', 'nickname', 'serverId'].includes(key))) throw problem('GAME_ACCOUNT_INPUT_INVALID', '账号资料格式不正确', 400);
      const result = await backend.accounts.add({ ownerRef, username: input.username, password: input.password, serverId: input.serverId, remark: input.remark || input.nickname || '' });
      return reply(response, 201, { ...result, id: Number(result.accountRef), verify: { attempted: true, ok: true, missing: [] } });
    }
    if (route === '/egress' && method === 'GET') return reply(response, 200, backend.egress.publicSettings());
    if (route === '/egress' && method === 'PUT') {
      return reply(response, 200, backend.egress.save(await body(request)));
    }
    if (route === '/upload-policy' && method === 'GET') return reply(response, 200, backend.legacyLogging.queueView().uploadPolicy);
    if (route === '/upload-policy' && method === 'PUT') {
      const input = await body(request);
      if (typeof input.wifiOnly !== 'boolean' || Object.keys(input).some(key => key !== 'wifiOnly')) throw problem('UPLOAD_POLICY_INVALID', '日志上传设置格式不正确', 400);
      return reply(response, 200, backend.legacyLogging.savePolicy(input.wifiOnly));
    }
    if (route === '/logs' && method === 'GET') return reply(response, 200, backend.logs.page({ ownerRef, accountRef: '0',
      limit: Number(url.searchParams.get('limit') || 15), beforeLocalId: url.searchParams.get('beforeLocalId'), category: url.searchParams.get('category'), day: url.searchParams.get('day'),
      from: url.searchParams.get('from'), to: url.searchParams.get('to'), keyword: url.searchParams.get('keyword'), level: url.searchParams.get('level'),
      outcomeState: url.searchParams.get('outcomeState'), errorCode: url.searchParams.get('errorCode'), operationId: url.searchParams.get('operationId'), traceId: url.searchParams.get('traceId') }));
    if (route === '/logs/upload-selection' && method === 'POST') {
      const input = await body(request, 16 * 1024), allowed = new Set(['category','day','from','to','keyword','level','outcomeState','errorCode','operationId','traceId']);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.has(key)))
        throw problem('LOG_MANUAL_FILTER_INVALID', '手动日志上传只接受日志页筛选条件', 400);
      backend.software.authorize({ ownerRef });
      const selection = backend.logs.selectIds({ ownerRef, accountRef: '0', ...input });
      if (!selection.sourceLogIds.length) return reply(response, 200, { sent: 0, confirmed: true, reason: 'empty_selection', selected: 0 });
      const frozen = backend.cloudSync.createManualSelection({ accountRef: '0', ...selection });
      const result = await backend.cloudSync.flush({ manual: true, selectionRef: frozen.selectionRef });
      return reply(response, 200, { ...result, selection: frozen });
    }
    if (route === '/migration/pair' && method === 'POST') return reply(response, 201, backend.pairMigration(await body(request)));
    if (route === '/migration/source-install-binding' && method === 'POST') {
      const input = await body(request);
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['pairingRef', 'commandId', 'expectedInstallId', 'expectedSignerFingerprint', 'scope', 'proof'].includes(key))) {
        throw problem('MIGRATION_INSTALL_BINDING_INPUT_INVALID', '原安装关联确认参数无效', 400);
      }
      backend.software.authorize({ ownerRef });
      return reply(response, 200, confirmSourceInstallBinding({ ...input, store: backend.store, ownerRef,
        targetInfo: { appId: 'online.ainiannian.wujinxia', cloudRef: backend.software.cloudRef } }));
    }
    if (route === '/migration/offer' && method === 'POST') {
      const input = await body(request);
      return reply(response, 201, await backend.migration.createOffer({ ...input, targetOwnerRef: ownerRef }));
    }
    if (route === '/migration/import' && method === 'POST') {
      const input = await body(request, 256 * 1024 * 1024);
      return reply(response, 200, await backend.migration.importEnvelope({ ...input, targetOwnerRef: ownerRef }));
    }
    if (route === '/migration/status' && method === 'GET') return reply(response, 200, backend.migration.status({ targetOwnerRef: ownerRef, sessionId: url.searchParams.get('sessionId') }));
    if (route === '/migration/egress/offer' && method === 'POST') return reply(response, 201, await backend.egressMigration.createOffer({ ...await body(request), targetOwnerRef: ownerRef }));
    if (route === '/migration/egress/import' && method === 'POST') return reply(response, 200, await backend.egressMigration.importEnvelope({ ...await body(request), targetOwnerRef: ownerRef }));
    if (route === '/migration/egress/status' && method === 'GET') return reply(response, 200, backend.egressMigration.status({ targetOwnerRef: ownerRef, sessionId: url.searchParams.get('sessionId') }));
    const detailMatch = /^\/accounts\/([1-9]\d*)\/writes\/([a-zA-Z0-9_-]{8,128})$/.exec(route);
    if (detailMatch) {
      if (method !== 'GET') throw problem('WRITE_AUDIT_READ_ONLY', '原操作凭据只允许读取', 405);
      const row = activeAccount(detailMatch[1]), operation = backend.ledger.operation(detailMatch[2]);
      if(!operation){
        const retired=backend.ledger.retiredOperation(detailMatch[2]);
        if(retired&&retired.ownerRef===ownerRef&&retired.subjectRef===row.subject_ref){
          backend.software.authorize({ownerRef});
          return reply(response,200,{...retired,transport:'answered',writeSlot:false,auditVersion:'known-land-retirement/v1',
            message:'已确认收获的完整明细已退出；稳定序号、原件指纹及防重代次根保留。'});
        }
      }
      if (!operation || operation.owner_ref !== ownerRef || operation.subject_ref !== row.subject_ref) throw problem('WRITE_AUDIT_NOT_FOUND', '操作不属于当前软件身份与游戏主体', 404);
      backend.software.authorize({ ownerRef });
      const { get, all } = backend.store, operationId = operation.operation_id, subjectRef = operation.subject_ref;
      const digest = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
      const fields = (value, names) => Object.fromEntries(names.filter(key => value && Object.hasOwn(value, key)).map(key => [key, value[key]]));
      const changedProjections = [], missing = [];
      const safe = (value, label) => {
        const projected = publicEvidence(value);
        if (canonical(projected) !== canonical(value)) changedProjections.push(label);
        return projected;
      };
      const has = name => !!get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name);
      const bounded = (table, limit, sql, ...params) => {
        if (!has(table)) return { available: false, complete: false, limit, rows: [] };
        const selected = all(sql, ...params, limit + 1);
        return { available: true, complete: selected.length <= limit, limit, rows: selected.slice(0, limit) };
      };
      const ordinaryFlowerDomain = orderFlowerAuditDomain(operation);
      const auxiliaryFlowerDomain = orderFlowerAuxiliaryAuditDomain(operation);
      const finiteDomain = operation.feature_id === 'order.customer' && operation.scope === 'order-customer' && operation.method === 'orderCustomer.finishOrder'
        ? 'customer' : operation.feature_id === 'order.customer' && operation.scope === 'order-reject' && operation.method === 'orderCustomer.rejectOrder' &&
          ['customer-policy-reject/single-v1', 'customer-physical-reject/single-v1'].includes(operation.factBasis?.version)
          ? 'customer-reject' : operation.feature_id === 'order.customer' && operation.scope === 'order-customer-gen' && operation.method === 'orderCustomer.genOrder' &&
            operation.factBasis?.version === 'customer-generation-admission/headless-empty-stock-v1'
            ? 'customer-generation' : operation.feature_id === 'art.make' && operation.scope === 'flower-art-make' && operation.method === 'flowerArt.makeFlowerArt' ? 'art'
              : operation.feature_id === 'art.daily' && operation.scope === 'flower-art-daily' && operation.method === 'flowerArt.makeFlowerArt' ? 'art-daily'
                : operation.feature_id === 'art.customer-batch' && operation.scope === 'flower-art-customer-batch' && operation.method === 'flowerArt.makeFlowerArt' ? 'art-customer-batch'
                : operation.feature_id === 'art.first-album' && operation.scope === 'vase-album-recv' && operation.method === 'collectRwd.recvArtCreateRwdByVase' ? 'art-first-album'
                  : operation.feature_id === 'art.first-share' && operation.scope === 'art-first-share' && operation.method === 'usr.share' ? 'art-first-share'
                : ordinaryFlowerDomain || auxiliaryFlowerDomain;
      const customerTargetDomain = finiteDomain === 'customer' || finiteDomain === 'customer-reject';
      const contextFields = ['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch'];
      const bindingFields = ['connectionEpoch', 'requestSequence', 'wireKey', 'responseRef'];
      const sameFields = (left, right, names) => !!left && !!right && names.every(key => left[key] === right[key]);
      const versionFields = ['source', 'gameVersion', 'protocolVersion', 'loginResponseRef', 'reportedServerVersion', 'serverVersionBinding'];
      const finiteSource = value => {
        if (!value) return null;
        const out = fields(value, ['kind', 'sourceKind', 'source', 'transport', 'method', 'connectionEpoch', 'requestSequence', 'wireKey', 'responseRef',
          'observationRef', 'serverId', 'officialUid', 'receivedDeviceMs', 'gameVersion', 'protocolVersion', 'loginResponseRef',
          'reportedServerVersion', 'serverVersionBinding']);
        for (const key of ['version', 'versionEvidence']) if (Object.hasOwn(value, key)) out[key] = fields(value[key], versionFields);
        return out;
      };
      const physicalClose = value => {
        if (!value) return null;
        const out = fields(value, ['closed', 'connectionEpoch', 'closureEvidenceRef', 'code']);
        if (Object.hasOwn(value, 'after')) out.after = fields(value.after, bindingFields);
        return out;
      };
      const bridgeReference = value => value ? { ...fields(value, ['leaseRef', 'operationId', 'bridgeFingerprint']),
        originalContext: fields(value.originalContext, contextFields), newContext: fields(value.newContext, contextFields), after: fields(value.after, bindingFields) } : null;
      const leaseReceipt = value => {
        if (!value) return null;
        const out = fields(value, ['version', 'leaseRef', 'operationId', 'officialUid', 'answerEvidenceId', 'answerEvidenceFingerprint', 'bridgeFingerprint']);
        for (const key of ['originalContext', 'newContext']) if (Object.hasOwn(value, key)) out[key] = fields(value[key], contextFields);
        if (Object.hasOwn(value, 'after')) out.after = fields(value.after, bindingFields);
        if (Object.hasOwn(value, 'oldPhysicalCloseReceipt')) out.oldPhysicalCloseReceipt = physicalClose(value.oldPhysicalCloseReceipt);
        for (const key of ['oldLoginSource', 'newLoginSource']) if (Object.hasOwn(value, key)) out[key] = finiteSource(value[key]);
        return out;
      };
      const costReceipt = value => {
        if (!value) return null;
        const out = fields(value, ['version', 'kind', 'known', 'complete', 'operationId', 'unitRef', 'quotaRef', 'gameVersion', 'protocolVersion',
          'artId', 'vaseId', 'num', 'recipeFingerprint', 'additionalCurrencyCostKnown', 'gold', 'yb', 'vaseConsumed', 'costObservationOnly',
          'globalFreeRuleProven', 'bridgeFingerprint', 'actBoReported', 'proxyBoReported', 'noOtherPositiveReportedCost', 'exactVersionRecipeOnly',
          'receiptRef', 'receiptFingerprint']);
        if (Object.hasOwn(value, 'flowersIds')) out.flowersIds = Array.isArray(value.flowersIds) ? value.flowersIds.slice(0, 3) : null;
        for (const key of ['consumptions', 'positiveCostFlows']) if (Object.hasOwn(value, key)) out[key] = Array.isArray(value[key])
          ? value[key].slice(0, 8).map(one => fields(one, ['itemId', 'quantity'])) : null;
        for (const key of ['produced', 'originalCurrencies']) if (Object.hasOwn(value, key)) out[key] = fields(value[key],
          key === 'produced' ? ['itemId', 'quantity'] : ['gold', 'yb']);
        for (const key of ['answer', 'postRead']) if (Object.hasOwn(value, key)) out[key] = finiteSource(value[key]);
        return out;
      };
      const artPreparation = value => {
        if (!value) return null;
        const out = fields(value, ['artId', 'vaseId', 'num', 'parentNpcId', 'parentLifecycleRef', 'parentContentFingerprint', 'parentNeed',
          'parentPolicyFingerprint', 'acceptedDecisionRef', 'customerCancelEpoch', 'demandRef', 'unitRef', 'officialUid', 'recipeFingerprint']);
        if (Object.hasOwn(value, 'flowersIds')) out.flowersIds = Array.isArray(value.flowersIds) ? value.flowersIds.slice(0, 3) : null;
        if (Object.hasOwn(value, 'versionEvidence')) out.versionEvidence = fields(value.versionEvidence, versionFields);
        if (Object.hasOwn(value, 'keepPolicy')) out.keepPolicy = fields(value.keepPolicy, ['known', 'keep', 'policyRef']);
        if (Object.hasOwn(value, 'beforeItems')) out.beforeItems = Array.isArray(value.beforeItems) ? value.beforeItems.slice(0, 8)
          .map(one => ({ ...fields(one, ['itemId', 'quantity', 'basisRef']), source: finiteSource(one.source) })) : null;
        if (Object.hasOwn(value, 'beforeProfile')) out.beforeProfile = { ...fields(value.beforeProfile, ['gold', 'yb']), source: finiteSource(value.beforeProfile?.source) };
        if (Object.hasOwn(value, 'beforeVase')) out.beforeVase = { ...fields(value.beforeVase, ['uid', 'vaseId', 'uTime', 'cTime']), source: finiteSource(value.beforeVase?.source) };
        if (Object.hasOwn(value, 'costObservation')) out.costObservation = fields(value.costObservation,
          ['kind', 'unitRef', 'quotaRef', 'gameVersion', 'protocolVersion', 'recipeFingerprint']);
        if (Object.hasOwn(value, 'costContract')) out.costContract = costReceipt(value.costContract);
        if (Object.hasOwn(value, 'productionUnit')) out.productionUnit = fields(value.productionUnit,
          ['unitRef', 'ordinal', 'authorizationRef', 'sourceCostReceiptRef']);
        return out;
      };
      const quotaReceipt = value => {
        if (!value) return null;
        const out = fields(value, ['version', 'operationId', 'quotaRef', 'unitRef', 'parentLifecycleRef', 'demandRef', 'recipeFingerprint', 'verdict',
          'reasonCode', 'originalConnectionEpoch', 'postReadRef', 'quotaConsumedPermanently', 'resourceFootprintsRetained', 'resourceCoverageApplied', 'currentEffectsPublished']);
        if (Object.hasOwn(value, 'observedCostReceipt')) out.observedCostReceipt = costReceipt(value.observedCostReceipt);
        return out;
      };
      const projectQuotaBinding = value => {
        const out = fields(value, ['version', 'operationId', 'semanticKey', 'paramsFingerprint']);
        if (Object.hasOwn(value, 'context')) out.context = fields(value.context, contextFields);
        if (Object.hasOwn(value, 'art')) out.art = artPreparation(value.art);
        for (const [key, names] of Object.entries({ targets: ['memberKey', 'targetKind', 'targetRef', 'lifecycleRef', 'targetFingerprint'],
          resources: ['resourceKey', 'resourceKind', 'resourceRef', 'basisRef', 'accountingRef', 'quantity'], resourceBindings: ['resourceKey', 'memberKey', 'quantity'] })) {
          if (Object.hasOwn(value, key)) out[key] = Array.isArray(value[key]) ? value[key].slice(0, 8).map(one => fields(one, names)) : null;
        }
        return out;
      };
      const storedEvidenceValid = entry => ledgerJsonFingerprint({ kind: entry.kind, source: entry.source, payload: entry.payload, observedAt: entry.observed_at }) === entry.payload_fingerprint;
      // This is exactly the persisted land projection's semantic hash contract.
      // Hash the stored frame locally; expose only the digest and finite cells.
      const landPayloadFields = ['profile', 'landUid', 'landBase', 'landChanges', 'cultivates', 'bag', 'itemExt', 'bi', 'bo', 'bd', 'top', 'harvestMap'];
      const landSemantic = value => Array.isArray(value) ? value.map(landSemantic) : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).filter(([key]) => !['source', 'sourceRef', 'semanticVersion', 'observationRef', 'responseRef'].includes(key))
          .map(([key, child]) => [key, landSemantic(child)])) : value;
      const landPayloadFingerprint = frame => frame && landPayloadFields.every(key => Object.hasOwn(frame, key))
        ? digest(Object.fromEntries(landPayloadFields.map(key => [key, landSemantic(frame[key])]))) : null;
      const sourceFields = ['observationRef', 'responseRef', 'wireKey', 'connectionEpoch', 'requestSequence', 'method', 'kind', 'sourceKind',
        'serverMs', 'serverRespondedMs', 'sentMonotonicMs', 'receivedMonotonicMs', 'decodeVersion'];
      const cell = value => value ? fields(value, ['presence', 'state', 'value', 'sourceRef', 'reasonCode', 'rawType', 'rawValue']) : null;
      const targetFields = ['landId', 'semanticVersion', 'cropRef', 'lifecycleRef', 'flowerId', 'plantTime', 'harvestCnt', 'status', 'state', 'emptyRef'];
      const originalFields = ['operationId', 'proposalId', 'ownerRef', 'accountRef', 'subjectRef', 'featureId', 'scope', 'method', 'semanticKey',
        'paramsFingerprint', 'runEpoch', 'connectionEpoch', 'configRevision', 'cancelEpoch', 'ownerEpoch', 'executorRef', 'traceId'];
      const original = { ...fields(operation.original, originalFields), factBasis: operation.factBasis,
        targets: operation.original.targets.map(target => fields(target, ['memberKey', 'targetKind', 'targetRef', 'lifecycleRef', 'targetFingerprint'])),
        resources: operation.original.resources.map(resource => fields(resource, ['resourceKey', 'resourceKind', 'resourceRef', 'basisRef', 'accountingRef', 'quantity'])),
        ...(Object.hasOwn(operation.original, 'resourceBindings') ? { resourceBindings: operation.original.resourceBindings.map(binding => fields(binding, ['resourceKey', 'memberKey', 'quantity'])) } : {}),
        previousUnsentOperations: (operation.original.previousUnsentOperations || []).map(previous => fields(previous,
          ['operationId', 'originalFingerprint', 'evidenceId', 'evidenceFingerprint'])) };
      const evidencePage = bounded('backend_operation_evidence', 200,
        'SELECT evidence_id,evidence_key,kind,source,payload_json,payload_fingerprint,observed_at,recorded_at FROM backend_operation_evidence WHERE operation_id=? ORDER BY evidence_id LIMIT ?', operationId);
      const evidence = evidencePage.rows.map(entry => ({ ...entry, payload: parseStored(entry.payload_json, '原操作证据') }));
      const permitAvailable = has('backend_send_permits');
      const permit = permitAvailable ? get(`SELECT permit_id,operation_id,owner_ref,subject_ref,owner_epoch,run_epoch,connection_epoch,
        method,params_fingerprint,consumed,consumed_at,wire_key,request_sequence,created_at FROM backend_send_permits
        WHERE operation_id=? AND owner_ref=? AND subject_ref=?`, operationId, ownerRef, subjectRef) : null;
      if (!permit) missing.push('send-permit');
      const resourceKeys = new Set(operation.resources.map(resource => resource.resource_key));
      const landAccelerationCardOperation = operation.feature_id === 'land.acceleration' && operation.scope === 'land-speedup' &&
        operation.method === 'usrLand.speedUp';
      const coveragePage = bounded('backend_official_item_coverage', 64, `SELECT coverage_key,owner_ref,subject_ref,operation_id,resource_key,
        quantity,basis_ref,post_read_ref,connection_epoch,request_sequence,result_fingerprint,evidence_json,recorded_at
        FROM backend_official_item_coverage WHERE owner_ref=? AND subject_ref=? AND operation_id=? ORDER BY coverage_key LIMIT ?`, ownerRef, subjectRef, operationId);
      const coverage = coveragePage.rows.filter(entry => resourceKeys.has(entry.resource_key)).map(({ evidence_json: stored, ...entry }) => {
        const proof = parseStored(stored, '资源覆盖证据'), projected = fields(proof,
          ['version', 'itemId', 'writeResponseRef', 'postReadRef', 'sendBinding', 'spent', 'absoluteValue', 'absoluteSourceRef', 'settlementRef']);
        const landAccelerationCardCoverage = landAccelerationCardOperation && entry.resource_key &&
          operation.resources.some(resource => resource.resource_key === entry.resource_key && resource.resource_kind === 'item' &&
            resource.resource_ref === 'item:1001' && resource.quantity === 1) &&
          proof.version === 'official-item-coverage/land-acceleration/v1' && proof.itemId === 1001;
        const expectedCoverageVersion = ordinaryFlowerDomain ? 'official-item-coverage/order-flower-after-close/v1'
          : finiteDomain === 'art-customer-batch' ? 'official-item-coverage/art-customer-batch-after-close/v2'
            : 'official-item-coverage/' + finiteDomain + '-after-close/v1';
        const crossed = finiteDomain && proof.version === expectedCoverageVersion;
        if (crossed || landAccelerationCardCoverage) {
          if (crossed) {
            Object.assign(projected, fields(proof, ['absoluteKind', 'bridgeEvidenceId', 'bridgeEvidenceFingerprint', 'artId', 'recipeFingerprint',
              'settlementFingerprint', 'costReceiptRef', 'costReceiptFingerprint', 'answerEvidenceId', 'answerEvidenceFingerprint',
              ...(ordinaryFlowerDomain ? ['kind', 'gained', 'businessVerdict', 'businessOutcomeProvenByCoverage', 'originalFingerprint'] : []),
              ...(finiteDomain === 'art-customer-batch' ? ['parentLifecycleRef'] : [])]));
            projected.sendBinding = fields(proof.sendBinding, bindingFields);
            projected.postReadBridge = bridgeReference(proof.postReadBridge);
          }
          if (landAccelerationCardCoverage) {
            Object.assign(projected, fields(proof, ['extensionId', 'extensionRef', 'baseDataSnapshotId', 'bundleRef',
              'loginResponseRef', 'beforeAbsolute', 'afterAbsolute']));
            projected.sendBinding = fields(proof.sendBinding, bindingFields);
          }
          const link = evidence => ({ coverageKey: entry.coverage_key, ownerRef: entry.owner_ref, subjectRef: entry.subject_ref,
            operationId: entry.operation_id, resourceKey: entry.resource_key, quantity: entry.quantity, basisRef: entry.basis_ref,
            postReadRef: entry.post_read_ref, connectionEpoch: entry.connection_epoch, requestSequence: entry.request_sequence, evidence });
          // result_fingerprint covers the whole original camel-case link,
          // not evidence_json alone. Preserve that exact reproducible meaning.
          const storedResult = safe(link(projected), 'coverage-result:' + entry.coverage_key);
          return { ...entry, evidence: projected, evidenceProjectionComplete: canonical(projected) === canonical(proof), storedResult,
            storedResultIntegrity: { storedFingerprintVerified: digest(link(proof)) === entry.result_fingerprint,
              projectionFingerprint: digest(storedResult), complete: canonical(storedResult) === canonical(link(proof)) } };
        }
        return { ...entry, evidence: projected, evidenceProjectionComplete: canonical(projected) === canonical(proof) };
      });
      const coverageScopeValid = coverage.length === coveragePage.rows.length;
      const cardItemResources = operation.resources.filter(resource => resource.resource_kind === 'item' && resource.resource_ref === 'item:1001');
      const cardItemResourceKeys = new Set(cardItemResources.map(resource => resource.resource_key));
      const cardItemCoverageRows = coverage.filter(entry => cardItemResourceKeys.has(entry.resource_key));
      const landAccelerationCardCoverageComplete = !landAccelerationCardOperation ||
        cardItemCoverageRows.every(entry => entry.evidence?.version === 'official-item-coverage/land-acceleration/v1' &&
          entry.evidence?.itemId === 1001 && entry.evidenceProjectionComplete &&
          entry.storedResultIntegrity?.storedFingerprintVerified === true && entry.storedResultIntegrity?.complete === true) &&
        (operation.business_verdict !== 'confirmed' || cardItemResources.length === 1 && cardItemCoverageRows.length > 0 &&
          cardItemCoverageRows.reduce((sum, entry) => sum + entry.quantity, 0) === cardItemResources[0].quantity);
      if (landAccelerationCardOperation && !landAccelerationCardCoverageComplete) missing.push('land-acceleration-item-coverage-incomplete');
      const waterwheelKind = Object.keys(WATERWHEEL_METHODS).find(kind => operation.feature_id === 'waterwheel' &&
        operation.scope === WATERWHEEL_SCOPES[kind] && operation.method === WATERWHEEL_METHODS[kind]);
      const flowerRackKind = Object.keys(FLOWER_RACK_METHODS).find(kind => operation.feature_id === 'flower-rack' &&
        operation.scope === FLOWER_RACK_SCOPES[kind] && operation.method === FLOWER_RACK_METHODS[kind]);
      const flowerRackOperation = Boolean(flowerRackKind);
      let flowerRackAudit = null, flowerRackAuditComplete = true;
      if (flowerRackOperation) {
        const rackMissing = [], rackChanged = [];
        const parseRack = (raw, label) => { try { return parseStored(raw, label); } catch { rackMissing.push('flower-rack-stored-source-invalid:' + label); return null; } };
        const prepRow = evidence.find(entry => entry.kind === 'finite-domain-preparation' && entry.source === 'backend/write-gateway/v2' &&
          entry.payload?.domain === operation.scope && storedEvidenceValid(entry));
        const contractRow = evidence.find(entry => entry.kind === 'admitted-operation-contract' && entry.source === 'backend/write-gateway/v2' && storedEvidenceValid(entry));
        const preparation = prepRow?.payload?.preparation, extension = preparation?.extension, target = operation.original.targets?.[0];
        const resultSettlement = operation.targetSettlements?.find(one => one.member_key === target?.memberKey);
        const result = resultSettlement?.result, proof = result?.evidence?.payload;
        const extBody = extension && Object.fromEntries(Object.entries(extension).filter(([key]) => key !== 'extensionRef'));
        const targetParams = flowerRackKind === 'unlock' ? { standId: preparation?.rackId } : flowerRackKind === 'sell'
          ? { rackId: preparation?.rackId, iid: preparation?.artId, num: preparation?.quantity } : { rackId: preparation?.rackId };
        const descriptor = { ...FLOWER_RACK_DEFINITIONS[flowerRackKind], postRead: Object.fromEntries(Object.entries(FLOWER_RACK_POST_READ)
          .filter(([key]) => key !== 'validateResponseCoverage')) };
        const prepValid = preparation?.kind === flowerRackKind && prepRow?.payload?.domain === operation.scope &&
          extension?.extensionId === FLOWER_RACK_EXTENSION_ID && extension.sourcePin === FLOWER_RACK_SOURCE_PIN &&
          extension.extensionRef === 'sha256:' + digest(extBody) && extension.loginResponseRef === preparation.loginResponseRef &&
          extension.bundleRef === preparation.bundleRef && extension.baseDataSnapshotId && extension.sourceProof?.sourcePin === FLOWER_RACK_SOURCE_PIN &&
          extension.sourceProof?.matchedRanges?.length === 8 && typeof preparation.sourceRef === 'string' &&
          typeof preparation.sourceFingerprint === 'string' && Number.isSafeInteger(preparation.officialUid) && preparation.officialUid > 0 &&
          contractRow?.payload?.featureId === 'flower-rack' && contractRow.payload.scope === operation.scope &&
          contractRow.payload.method === operation.method && contractRow.payload.contractId === FLOWER_RACK_CONTRACT_REF + '/' + flowerRackKind &&
          canonical(contractRow.payload) === canonical(descriptor) && operation.original.paramsFingerprint === digest(targetParams) &&
          target?.targetKind === 'flower-rack' && target.targetRef === `flower-rack:${subjectRef}:${preparation.targetKey}` &&
          target.memberKey === 'flower-rack:' + digest([preparation.targetKey, flowerRackKind === 'unlock' ? 0 : preparation.artId]);
        if (!prepValid) rackMissing.push('flower-rack-preparation-contract');
        const answerRow = evidence.find(entry => entry.kind === 'official-answer' && entry.source === 'backend/write-gateway/v2' && storedEvidenceValid(entry) &&
          entry.payload?.method === operation.method && entry.payload?.connectionEpoch === operation.connection_epoch &&
          entry.payload?.requestSequence === permit?.request_sequence && entry.payload?.wireKey === permit?.wire_key &&
          typeof entry.payload?.responseRef === 'string' && entry.payload.responseRef.length > 0);
        if (operation.transport_state === 'answered' && !answerRow) rackMissing.push('flower-rack-matched-write-answer');
        const bridgeEvidence = evidence.find(entry => entry.kind === 'after-close-login-post-read' && entry.source === 'backend/write-gateway/v2' &&
          storedEvidenceValid(entry) && entry.payload?.operationId === operationId);
        const lease = has('backend_session_verification_leases') ? get(`SELECT * FROM backend_session_verification_leases WHERE operation_id=? AND owner_ref=? AND account_ref=? AND subject_ref=?
          ORDER BY lease_ref LIMIT 1`, operationId, ownerRef, operation.account_ref, subjectRef) : null;
        const rawBridge = lease?.bridge_json ? parseRack(lease.bridge_json, 'lease') : null;
        const bridgeReceipt = rawBridge ? leaseReceipt(rawBridge) : null;
        let leaseCheck = { valid: false };
        try { if (rawBridge && lease) leaseCheck = backend.supervisor.validateReadSnapshotLease({ leaseRef: lease.lease_ref, operationId,
          originalContext: parseRack(lease.original_context_json, 'lease-context'), newContext: rawBridge.newContext,
          after: parseRack(lease.after_json, 'lease-after'), bridgeFingerprint: lease.bridge_fingerprint, phase: 'settling' }); } catch { /* report incomplete below */ }
        const leaseValid = !!lease && !!rawBridge && digest(rawBridge) === lease.bridge_fingerprint && leaseCheck.valid === true &&
          bridgeEvidence?.payload?.leaseRef === lease.lease_ref && bridgeEvidence.payload.bridgeFingerprint === lease.bridge_fingerprint &&
          rawBridge.operationId === operationId && rawBridge.oldPhysicalCloseReceipt?.closed === true &&
          rawBridge.oldPhysicalCloseReceipt.connectionEpoch === operation.connection_epoch &&
          rawBridge.newLoginSource?.responseRef === proof?.postReadRef && rawBridge.officialUid === preparation?.officialUid;
        if (operation.transport_state === 'answered' && !leaseValid) rackMissing.push('flower-rack-postread-lease');
        const closeRef = rawBridge?.oldPhysicalCloseReceipt?.closureEvidenceRef;
        const close = closeRef && has('backend_session_connection_closures') ? get(`SELECT * FROM backend_session_connection_closures WHERE evidence_ref=? AND owner_ref=? AND account_ref=?
          AND subject_ref=? AND executor_ref=? AND owner_epoch=? AND run_epoch=? AND connection_epoch=?`, closeRef, ownerRef, operation.account_ref, subjectRef,
          lease?.executor_ref, operation.original.ownerEpoch, operation.run_epoch, operation.connection_epoch) : null;
        const closeProof = close?.proof_json ? parseRack(close.proof_json, 'physical-close') : null;
        const closeValid = !!close && closeProof?.closed === true && closeProof.connectionEpoch === operation.connection_epoch &&
          close.evidence_ref === 'session-close:' + digest([lease.executor_ref, subjectRef, operation.connection_epoch, close.proof_kind]);
        if (operation.transport_state === 'answered' && !closeValid) rackMissing.push('flower-rack-physical-close');
        const closeAfterProjection = closeProof && Object.hasOwn(closeProof, 'after') ? fields(closeProof.after, bindingFields) : null;
        const closeAfterValid = !closeProof || !Object.hasOwn(closeProof, 'after') || !!rawBridge &&
          canonical(closeAfterProjection) === canonical(closeProof.after) && canonical(closeAfterProjection) === canonical(rawBridge.after);
        if (operation.transport_state === 'answered' && !closeAfterValid) rackMissing.push('flower-rack-physical-close-after-mismatch');
        const sourceRows = [];
        for (const [kind, ref, epoch, required] of [['preparation', preparation?.sourceRef, operation.connection_epoch, prepValid],
          ['post', proof?.postReadRef, rawBridge?.newContext?.connectionEpoch, operation.transport_state === 'answered']]) {
          if (typeof ref !== 'string' || !ref) { if (required) rackMissing.push('flower-rack-source-ref:' + kind); continue; }
          const row = has('backend_flower_rack_receipts') ? get(`SELECT * FROM backend_flower_rack_receipts WHERE response_ref=? AND owner_ref=? AND account_ref=? AND subject_ref=? AND connection_epoch=?`,
            ref, ownerRef, operation.account_ref, subjectRef, epoch) : null;
          const value = row ? parseRack(row.value_json, kind + '-value') : null;
          const expected = kind === 'preparation' ? { uid: preparation?.officialUid, map: preparation?.sourceMap } : proof?.postValue;
          const sourceValid = !!row && !!value && digest(value) === row.value_fingerprint && row.response_ref === ref &&
            row.owner_epoch === operation.original.ownerEpoch && row.run_epoch === operation.run_epoch && row.connection_epoch === epoch &&
            row.request_sequence === (kind === 'preparation' ? preparation?.sourceSequence : proof?.postSource?.requestSequence) &&
            row.method === (kind === 'preparation' ? preparation?.sourceMethod : 'index.login') && canonical(value) === canonical(expected);
          if (required && !sourceValid) rackMissing.push('flower-rack-source-integrity:' + kind);
          const projected = value ? safe(value, 'flower-rack-source:' + kind) : null;
          sourceRows.push({ kind, responseRef: ref, present: !!row, required, requestSequence: row?.request_sequence ?? null,
            connectionEpoch: row?.connection_epoch ?? null, valueFingerprint: row?.value_fingerprint ?? null,
            valueFingerprintVerified: sourceValid, valueProjectionComplete: !!projected && canonical(projected) === canonical(value), value: projected });
        }
        let writeItemFlow = null;
        if (operation.transport_state === 'answered' && proof?.writeFlow) {
          const flow = proof.writeFlow;
          const frameRow = has('backend_official_item_frames') ? get(`SELECT * FROM backend_official_item_frames WHERE observation_ref=? AND owner_ref=? AND account_ref=? AND subject_ref=?
            AND connection_epoch=? AND request_sequence=? AND response_ref=? AND wire_key=?`, flow.observationRef, ownerRef, operation.account_ref, subjectRef,
            flow.connectionEpoch, flow.requestSequence, flow.responseRef, flow.wireKey) : null;
          const writeSource = frameRow ? parseRack(frameRow.source_json, 'write-item-source') : null;
          const writePayload = frameRow ? parseRack(frameRow.payload_json, 'write-item-payload') : null;
          const itemId = flowerRackKind === 'receive' || flowerRackKind === 'unlock' ? 11 : preparation?.artId;
          const landRow = frameRow && has('backend_land_domain_observations') ? get(`SELECT observation_ref,connection_epoch,request_sequence,wire_key,response_ref,frame_json
            FROM backend_land_domain_observations WHERE observation_ref=? AND owner_ref=? AND account_ref=? AND subject_ref=? AND connection_epoch=? AND request_sequence=? AND wire_key=? AND response_ref=?`,
            flow.observationRef, ownerRef, operation.account_ref, subjectRef, flow.connectionEpoch, flow.requestSequence, flow.wireKey, flow.responseRef) : null;
          const accepted = landRow ? resolveAcceptedLandObservationEvidence({ store: backend.store,
            context: { ownerRef, accountRef: operation.account_ref, subjectRef, ownerEpoch: operation.original.ownerEpoch,
              runEpoch: operation.run_epoch, connectionEpoch: operation.connection_epoch }, observationRef: landRow.observation_ref,
            source: writeSource }) : null;
          const acceptedFrame = accepted?.accepted === true ? accepted.frame : null;
          const expectedFlow = { bi: writePayload?.bi?.items?.[String(itemId)] ?? null, bo: writePayload?.bo?.items?.[String(itemId)] ?? null,
            bd: writePayload?.bd?.items?.[String(itemId)] ?? null };
          const expectedBiCoverage = { presence: writePayload?.bi?.presence ?? 'missing', state: writePayload?.bi?.state ?? 'unobserved',
            itemPresent: writePayload?.bi?.presence === 'present' && writePayload.bi.state === 'known' &&
              plainObject(writePayload.bi.items) && Object.hasOwn(writePayload.bi.items, String(itemId)) };
          const expectedProfileGold = acceptedFrame?.profile?.gold || null;
          const expectedProfileGoldCoverage = { presence: expectedProfileGold?.presence ?? 'missing',
            state: expectedProfileGold?.state ?? 'unobserved' };
          const newGoldCoverageKeys = ['biCoverage','profileGold','profileGoldCoverage'];
          const hasGoldCoverage = newGoldCoverageKeys.every(key => Object.hasOwn(flow, key));
          const hasPartialGoldCoverage = newGoldCoverageKeys.some(key => Object.hasOwn(flow, key)) && !hasGoldCoverage;
          const flowValid = !!flow && !!frameRow && !!writeSource && !!writePayload && !!acceptedFrame && writeSource.method === operation.method &&
            writeSource.responseRef === answerRow?.payload?.responseRef && writeSource.responseRef === flow.responseRef &&
            writeSource.connectionEpoch === operation.connection_epoch && writeSource.requestSequence === permit?.request_sequence &&
            writeSource.wireKey === permit?.wire_key && flow.method === operation.method && flow.responseRef === answerRow?.payload?.responseRef &&
            flow.connectionEpoch === operation.connection_epoch && flow.requestSequence === permit?.request_sequence && flow.wireKey === permit?.wire_key &&
            digest({ source: acceptedFrame.source, bi: writePayload.bi, bo: writePayload.bo, bd: writePayload.bd }) === flow.frameFingerprint &&
            canonical(expectedFlow) === canonical({ bi: flow.bi, bo: flow.bo, bd: flow.bd }) &&
            !hasPartialGoldCoverage && (!hasGoldCoverage || canonical(expectedBiCoverage) === canonical(flow.biCoverage) &&
              canonical(expectedProfileGold) === canonical(flow.profileGold) &&
              canonical(expectedProfileGoldCoverage) === canonical(flow.profileGoldCoverage));
          if (!flowValid) rackMissing.push('flower-rack-matched-item-flow');
          writeItemFlow = { present: !!frameRow, observationRef: flow.observationRef, responseRef: flow.responseRef, requestSequence: flow.requestSequence,
            connectionEpoch: flow.connectionEpoch, wireKey: flow.wireKey, itemId, values: expectedFlow,
            frameFingerprint: flow.frameFingerprint, fingerprintVerified: flowValid };
        } else if (operation.transport_state === 'answered') rackMissing.push('flower-rack-matched-item-flow');
        const proofFields = ['traceId','targetRef','extensionRef','kind','rackId','artId','quantity','beforeValue','afterValue','writeResponseRef','postReadRef','bridgeFingerprint',
          'frameFingerprint','sourceRef','sourceFingerprint','postValue','postSource','postExtension','writeFlow','beforeGoldSource','postGoldSource','matchedGold'];
        const projectedProof = fields(proof, proofFields);
        if (projectedProof.postExtension) projectedProof.postExtension = fields(projectedProof.postExtension,
          ['extensionId','sourcePin','sourceReferenceVersion','sourceReferenceSha256','gameSha256','matchedRanges','bundleRef','baseDataSnapshotId','loginResponseRef','sourceVersion',
            'resourceSha256','baseTableHashes','tableHashes','sourceProof','rules','extensionRef','officialUid']);
        if (projectedProof.writeFlow) projectedProof.writeFlow = fields(projectedProof.writeFlow,
          ['method','responseRef','observationRef','requestSequence','connectionEpoch','wireKey','bi','bo','bd','boCoverage','bdCoverage',
            'biCoverage','profileGold','profileGoldCoverage','frameFingerprint']);
        const postExtBody = proof?.postExtension && Object.fromEntries(Object.entries(proof.postExtension).filter(([key]) => key !== 'extensionRef'));
        const expectedResolutionState = operation.business_verdict === 'confirmed' ? 'released' : 'historical_footprint';
        const resourceResolutionValid = Array.isArray(result?.resourceResolutions) && result.resourceResolutions.length === operation.resources.length &&
          result.resourceResolutions.every(one => operation.resources.some(resource => resource.resource_key === one.resourceKey) && one.state === expectedResolutionState);
        const settlementValid = !!resultSettlement && hashLedgerBytes(resultSettlement.result_json) === resultSettlement.result_fingerprint &&
          result?.member?.memberKey === target?.memberKey && result.member.verdict === operation.business_verdict &&
          result.verificationVersion === resultSettlement.verification_version && resultSettlement.verification_version === 'flower-rack/target-postread/v1' &&
          proof?.targetRef === target?.targetRef && proof.extensionRef === extension?.extensionRef &&
          proof?.writeResponseRef === answerRow?.payload?.responseRef && proof?.postReadRef === rawBridge?.newLoginSource?.responseRef &&
          proof?.bridgeFingerprint === lease?.bridge_fingerprint && proof?.postExtension?.extensionRef === 'sha256:' + digest(postExtBody) &&
          proof.postExtension?.loginResponseRef === proof.postReadRef && canonical(projectedProof) === canonical(proof) && resourceResolutionValid;
        if (operation.transport_state === 'answered' && !settlementValid) rackMissing.push('flower-rack-target-settlement');
        const eventRows = lease && has('backend_session_verification_events') ? all(`SELECT event_ref,lease_ref,event_kind,receipt_json,recorded_at FROM backend_session_verification_events
          WHERE lease_ref=? ORDER BY recorded_at,event_ref LIMIT 33`, lease.lease_ref) : [];
        const events = eventRows.slice(0, 32).map(row => {
          const raw = parseRack(row.receipt_json, 'lease-event'), projected = raw ? safe(raw, 'flower-rack-event:' + row.event_ref) : null;
          return { eventRef: row.event_ref, leaseRef: row.lease_ref, eventKind: row.event_kind, recordedAt: row.recorded_at,
            receipt: projected, receiptFingerprint: raw ? digest(raw) : null, projectionComplete: !!raw && canonical(raw) === canonical(projected) };
        });
        const eventsComplete = eventRows.length <= 32 && ['created','old-closed-new-epoch','fresh-login-observed'].every(kind => events.some(row => row.eventKind === kind)) &&
          (lease?.state !== 'released' || events.some(row => row.eventKind === 'durable-outcome-released')) && events.every(row => row.projectionComplete);
        if (operation.transport_state === 'answered' && !eventsComplete) rackMissing.push('flower-rack-postread-events');
        const leaseProjectionComplete = !!rawBridge && canonical(bridgeReceipt) === canonical(rawBridge);
        const closeProjectionComplete = !!closeProof && closeAfterValid &&
          canonical(fields(closeProof, ['closed','connectionEpoch','closureEvidenceRef','leaseRef','operationId','code','source', ...(Object.hasOwn(closeProof, 'after') ? ['after'] : [])])) === canonical(closeProof);
        flowerRackAudit = { applicable: true, kind: flowerRackKind, complete: rackMissing.length === 0 && sourceRows.every(row => !row.required || row.valueFingerprintVerified && row.valueProjectionComplete) &&
          (!operation.transport_state || operation.transport_state !== 'answered' || leaseValid && closeValid && settlementValid && eventsComplete && leaseProjectionComplete && closeProjectionComplete && writeItemFlow?.fingerprintVerified === true),
          contract: { featureId: 'flower-rack', scope: operation.scope, method: operation.method, contractId: FLOWER_RACK_CONTRACT_REF + '/' + flowerRackKind,
            extensionId: extension?.extensionId ?? null, extensionRef: extension?.extensionRef ?? null, sourcePin: extension?.sourcePin ?? null },
          settlement: resultSettlement ? { verdict: resultSettlement.verdict, resultFingerprintVerified: hashLedgerBytes(resultSettlement.result_json) === resultSettlement.result_fingerprint,
            evidenceProjectionComplete: canonical(projectedProof) === canonical(proof), evidence: projectedProof,
            result: { member: result?.member, verificationVersion: result?.verificationVersion, resourceResolutions: result?.resourceResolutions } } : null,
          sourceReceipts: sourceRows, writeItemFlow, postReadBridge: { complete: leaseValid && closeValid && eventsComplete && leaseProjectionComplete && closeProjectionComplete,
            lease: lease ? { ...fields(lease, ['lease_ref','operation_id','executor_ref','owner_ref','account_ref','subject_ref','owner_epoch','run_epoch','original_connection_epoch',
              'new_connection_epoch','state','active','bridge_fingerprint','reason_code','created_at','updated_at']), receipt: bridgeReceipt,
              receiptFingerprint: rawBridge ? digest(rawBridge) : null, receiptProjectionComplete: !!rawBridge && canonical(bridgeReceipt) === canonical(rawBridge) } : null,
            physicalClose: close ? { ...fields(close, ['evidence_ref','executor_ref','owner_epoch','run_epoch','connection_epoch','proof_kind','recorded_at']), proof: closeProof,
              proofFingerprint: closeProof ? digest(closeProof) : null } : null, events: { complete: eventsComplete, rows: events } }, missing: rackMissing };
        flowerRackAuditComplete = flowerRackAudit.complete;
        if (!flowerRackAuditComplete) missing.push('flower-rack-audit-incomplete');
      }
      const waterwheelOperation = Boolean(waterwheelKind);
      let waterwheelAudit = null, waterwheelAuditComplete = true;
      if (waterwheelOperation) {
        const waterwheelMissing = [], waterwheelChanged = [];
        const storedReceipt = (table, ref, connectionEpoch = operation.connection_epoch) => {
          if (!has(table)) return null;
          return get(`SELECT * FROM ${table} WHERE response_ref=? AND owner_ref=? AND account_ref=? AND subject_ref=? AND connection_epoch=?`,
            ref, ownerRef, operation.account_ref, subjectRef, connectionEpoch);
        };
        const prepRow = evidence.find(entry => entry.kind === 'finite-domain-preparation' && entry.source === 'backend/write-gateway/v2' &&
          entry.payload?.domain === operation.scope && storedEvidenceValid(entry));
        const contractRow = evidence.find(entry => entry.kind === 'admitted-operation-contract' && entry.source === 'backend/write-gateway/v2' &&
          storedEvidenceValid(entry));
        const preparation = prepRow?.payload?.preparation;
        const extension = preparation?.extension;
        const extensionBody = extension && Object.fromEntries(Object.entries(extension).filter(([key]) => key !== 'extensionRef'));
        const target = operation.original.targets?.[0];
        const expectedParams = waterwheelKind === 'share' ? { shareId: 9, ext: { opType: 1 } } : {};
        const { validateResponseCoverage: _wheelCoverage, ...waterwheelPostRead } = WATERWHEEL_POST_READ;
        const expectedDescriptor = { ...WATERWHEEL_DEFINITIONS[waterwheelKind], postRead: waterwheelPostRead };
        const sourcePreparationValid = prepRow && preparation?.kind === waterwheelKind &&
          prepRow.payload.domain === operation.scope && extension?.extensionId === WATERWHEEL_EXTENSION_ID &&
          extension?.sourcePin === WATERWHEEL_SOURCE_PIN && extension?.extensionRef === 'sha256:' + digest(extensionBody) &&
          extension?.loginResponseRef === preparation.loginResponseRef && extension?.bundleRef === preparation.bundleRef &&
          extension?.baseDataSnapshotId && extension?.sourceProof?.sourcePin === WATERWHEEL_SOURCE_PIN &&
          extension?.sourceProof?.matchedRanges?.length === 30 &&
          typeof preparation.sourceRef === 'string' && typeof preparation.sourceFingerprint === 'string' &&
          ['index.login', 'waterwheel.enter'].includes(preparation.sourceMethod) &&
          contractRow?.payload?.featureId === 'waterwheel' && contractRow.payload.scope === operation.scope &&
          contractRow.payload.method === operation.method && contractRow.payload.contractId === WATERWHEEL_CONTRACT_REF + '/' + waterwheelKind &&
          canonical(contractRow.payload) === canonical(expectedDescriptor) &&
          canonical(operation.original.resources || []) === canonical([]) && operation.original.paramsFingerprint === digest(expectedParams) &&
          target?.targetKind === 'waterwheel' && target?.targetRef === `waterwheel:${subjectRef}:${preparation.generationRef}:${preparation.count}:${preparation.slot}` &&
          typeof preparation.generationRef === 'string' && Number.isSafeInteger(preparation.count) && Number.isSafeInteger(preparation.slot);
        if (!sourcePreparationValid) waterwheelMissing.push('waterwheel-preparation-contract');
        const answerRow = evidence.find(entry => entry.kind === 'official-answer' && entry.source === 'backend/write-gateway/v2' &&
          storedEvidenceValid(entry) && entry.payload?.method === operation.method && entry.payload?.connectionEpoch === operation.connection_epoch &&
          entry.payload?.requestSequence === permit?.request_sequence && entry.payload?.wireKey === permit?.wire_key &&
          typeof entry.payload?.responseRef === 'string' && entry.payload.responseRef.length > 0);
        if (operation.transport_state === 'answered' && !answerRow) waterwheelMissing.push('waterwheel-matched-write-answer');
        const settlement = operation.targetSettlements?.find(one => one.member_key === target?.memberKey);
        const result = settlement?.result;
        const proof = result?.evidence?.payload;
        const postBridgeRow = evidence.find(entry => entry.kind === 'after-close-login-post-read' && entry.source === 'backend/write-gateway/v2' && storedEvidenceValid(entry));
        const bridgeProofValid = waterwheelKind && postBridgeRow?.payload?.operationId === operation.operation_id &&
          postBridgeRow.payload.leaseRef === proof?.bridge?.leaseRef &&
          postBridgeRow.payload.bridgeFingerprint === proof?.bridge?.bridgeFingerprint &&
          postBridgeRow.payload.newLoginResponseRef === proof?.postReadRef &&
          postBridgeRow.payload.oldPhysicalCloseReceipt?.closed === true &&
          postBridgeRow.payload.oldPhysicalCloseReceipt?.connectionEpoch === operation.connection_epoch &&
          postBridgeRow.payload.newContext?.connectionEpoch === proof?.bridge?.newConnectionEpoch;
        if (operation.transport_state === 'answered' && answerRow?.payload?.responseRef !== proof?.writeResponseRef)
          waterwheelMissing.push('waterwheel-write-response-reference');
        const proofFields = ['traceId', 'targetRef', 'extensionRef', 'postExtension', 'writeResponseRef', 'postReadRef', 'beforeCount', 'afterCount',
          'beforeItem7', 'afterItem7', 'item7Delta', 'beforeItem7SourceRef', 'afterItem7SourceRef', 'shareAdvanced', 'writeItem7Flow',
          'beforeItem7BasisRef', 'beforeItem7Effective', 'afterItem7Effective', 'afterBalanceSource', 'bridge'];
        const proofProjection = fields(proof, proofFields);
        if (proofProjection.writeItem7Flow) proofProjection.writeItem7Flow = fields(proofProjection.writeItem7Flow,
          ['observationRef', 'responseRef', 'requestSequence', 'wireKey', 'bi', 'bo', 'bd', 'boCoverage', 'bdCoverage', 'boCostEvidence', 'frameFingerprint']);
        if (proofProjection.postExtension) proofProjection.postExtension = fields(proofProjection.postExtension,
          ['extensionId', 'sourcePin', 'sourceVersion', 'baseDataSnapshotId', 'bundleRef', 'loginResponseRef', 'resourceSha256',
            'baseTableHashes', 'tableHashes', 'sourceProof', 'rules', 'extensionRef']);
        const postExtension = proof?.postExtension;
        const postExtensionBody = postExtension && Object.fromEntries(Object.entries(postExtension).filter(([key]) => key !== 'extensionRef'));
        const postExtensionValid = postExtension?.extensionId === WATERWHEEL_EXTENSION_ID && postExtension.sourcePin === WATERWHEEL_SOURCE_PIN &&
          postExtension.extensionRef === 'sha256:' + digest(postExtensionBody) && postExtension.loginResponseRef === proof?.postReadRef &&
          typeof postExtension.bundleRef === 'string' && !!postExtension.bundleRef && typeof postExtension.baseDataSnapshotId === 'string' &&
          !!postExtension.baseDataSnapshotId && postExtension.sourceProof?.sourcePin === WATERWHEEL_SOURCE_PIN &&
          postExtension.sourceProof?.extensionId === WATERWHEEL_EXTENSION_ID && postExtension.sourceProof?.matchedRanges?.length === 30;
        const settlementComplete = settlement && hashLedgerBytes(settlement.result_json) === settlement.result_fingerprint &&
          result?.member?.memberKey === target?.memberKey && result.member.verdict === operation.business_verdict &&
          result.verificationVersion === settlement.verification_version && settlement.verification_version === 'waterwheel/target-postread/v1' &&
          result.evidence?.kind === 'domain-verification' && result.evidence?.source === 'backend/write-gateway/v2' &&
          proof?.traceId === operation.original.traceId && proof?.targetRef === target?.targetRef && proof?.extensionRef === extension?.extensionRef &&
          postExtensionValid &&
          canonical(proofProjection) === canonical(proof) && bridgeProofValid && Array.isArray(result.resourceResolutions) && result.resourceResolutions.length === 0;
        if (operation.transport_state === 'answered' && !settlementComplete) waterwheelMissing.push('waterwheel-target-settlement');
        const wheelRows = [];
        const sourceRefs = [...new Set([preparation?.sourceRef, proof?.writeResponseRef, proof?.postReadRef])];
        for (const ref of sourceRefs) {
          if (typeof ref !== 'string' || !ref) { waterwheelMissing.push('waterwheel-source-reference-missing'); continue; }
          const isWrite = ref === proof?.writeResponseRef, isPost = ref === proof?.postReadRef;
          const receiptRequired = !isWrite || waterwheelKind === 'skip';
          const expectedPostEpoch = proof?.bridge?.newConnectionEpoch;
          const receipt = storedReceipt('backend_waterwheel_receipts', ref, isPost ? expectedPostEpoch : operation.connection_epoch);
          if (!receipt) { wheelRows.push({ responseRef: ref, present: false, required: receiptRequired });
            if (receiptRequired) waterwheelMissing.push('waterwheel-source-receipt:' + ref); continue; }
          let value = null;
          try { value = parseStored(receipt.value_json, '水车官服来源'); } catch { /* completeness below records the missing source */ }
          const valid = value && digest(value) === receipt.value_fingerprint && receipt.method ===
            (isPost ? 'index.login' : isWrite ? operation.method : preparation.sourceMethod) && receipt.owner_epoch === operation.original.ownerEpoch &&
            receipt.run_epoch === operation.run_epoch && (ref === proof?.writeResponseRef
              ? receipt.request_sequence === permit?.request_sequence && receipt.response_ref === answerRow?.payload?.responseRef && receipt.method === operation.method
              : isPost ? Number.isSafeInteger(expectedPostEpoch) && expectedPostEpoch > operation.connection_epoch && receipt.response_ref === proof?.postReadRef &&
                receipt.request_sequence === proof?.bridge?.newLoginRequestSequence &&
                receipt.connection_epoch === proof?.bridge?.newConnectionEpoch && receipt.method === 'index.login'
                : receipt.value_fingerprint === preparation.sourceFingerprint && receipt.response_ref === preparation.sourceRef &&
                  receipt.request_sequence < permit?.request_sequence && receipt.method === preparation.sourceMethod);
          if (!valid) waterwheelMissing.push('waterwheel-source-fingerprint:' + ref);
          const valueView = value;
          wheelRows.push({ responseRef: ref, present: true, method: receipt.method, requestSequence: receipt.request_sequence,
            connectionEpoch: receipt.connection_epoch, valueFingerprint: receipt.value_fingerprint, valueFingerprintVerified: valid,
            valueProjectionVersion: 'waterwheel-decoded-source/v1', valueProjectionFingerprint: valueView ? digest(valueView) : null,
            valueProjectionComplete: !!valueView && canonical(valueView) === canonical(value), value: valueView });
        }
        let itemFlow = null;
        const flow = proof?.writeItem7Flow;
        if (['recv', 'share'].includes(waterwheelKind)) {
          const frame = flow && has('backend_official_item_frames') ? get(`SELECT * FROM backend_official_item_frames WHERE observation_ref=? AND owner_ref=?
            AND account_ref=? AND subject_ref=? AND connection_epoch=? AND request_sequence=? AND response_ref=? AND wire_key=?`,
          flow.observationRef, ownerRef, operation.account_ref, subjectRef, operation.connection_epoch, flow.requestSequence, flow.responseRef, flow.wireKey) : null;
          const admitted = frame && has('backend_land_domain_observations') ? get(`SELECT accepted,frame_json,payload_fingerprint FROM backend_land_domain_observations
            WHERE observation_ref=? AND owner_ref=? AND account_ref=? AND subject_ref=? AND connection_epoch=? AND request_sequence=? AND response_ref=? AND wire_key=?`,
          flow.observationRef, ownerRef, operation.account_ref, subjectRef, operation.connection_epoch, flow.requestSequence, flow.responseRef, flow.wireKey) : null;
          if (frame && admitted?.accepted === 1) {
            const itemPayload = parseStored(frame.payload_json, '水车奖励物品帧'), itemSource = parseStored(frame.source_json, '水车奖励来源');
            const landFrame = parseStored(admitted.frame_json, '水车奖励完整帧');
            const actual = { bi: itemPayload.bi?.items?.['7'] ?? null, bo: itemPayload.bo?.items?.['7'] ?? null,
              bd: itemPayload.bd?.items?.['7'] ?? null };
            const actualValues = Object.fromEntries(Object.entries(actual).map(([key, cellValue]) => [key,
              cellValue?.presence === 'present' && cellValue.state === 'known' && Number.isSafeInteger(cellValue.value) ? cellValue.value : null]));
            const boCollection = itemPayload.bo;
            const boCoverage = { presence: boCollection?.presence ?? 'missing', state: boCollection?.state ?? 'unobserved',
              item7Present: boCollection?.presence === 'present' && boCollection.state === 'known' &&
                !!boCollection.items && Object.hasOwn(boCollection.items, '7') };
            const bdCollection = itemPayload.bd;
            const bdCoverage = { presence: bdCollection?.presence ?? 'missing', state: bdCollection?.state ?? 'unobserved',
              item7Present: bdCollection?.presence === 'present' && bdCollection.state === 'known' &&
                !!bdCollection.items && Object.hasOwn(bdCollection.items, '7') };
            const boItem = boCollection?.items?.['7'];
            const boCostEvidence = boItem?.presence === 'present' && boItem.state === 'known'
              ? boItem.value === 0 ? 'explicit-zero' : null
              : boCoverage.presence === 'present' && boCoverage.state === 'known' && !boCoverage.item7Present ? 'known-map-missing-key'
                : boCoverage.presence === 'missing' && boCoverage.state === 'unobserved' ? 'not-reported-net-conservation' : null;
            const semantic = value => Array.isArray(value) ? value.map(semantic) : value && typeof value === 'object'
              ? Object.fromEntries(Object.entries(value).filter(([key]) => !['source', 'sourceRef', 'semanticVersion', 'observationRef', 'responseRef'].includes(key))
                .map(([key, child]) => [key, semantic(child)])) : value;
            const landPayload = Object.fromEntries(['profile', 'landUid', 'landBase', 'landChanges', 'cultivates', 'bag', 'itemExt', 'bi', 'bo', 'bd', 'top', 'harvestMap']
              .map(key => [key, semantic(landFrame[key])]));
            const frameValid = itemSource.method === operation.method && itemSource.responseRef === flow.responseRef &&
              itemSource.requestSequence === flow.requestSequence && itemSource.wireKey === flow.wireKey &&
              flow.requestSequence === permit?.request_sequence && flow.wireKey === permit?.wire_key &&
              flow.responseRef === answerRow?.payload?.responseRef && proof?.writeResponseRef === answerRow?.payload?.responseRef &&
              canonical(itemPayload) === canonical(Object.fromEntries(['bag','itemExt','bi','bo','bd'].map(key => [key, landFrame[key]]))) &&
              admitted.payload_fingerprint === digest(landPayload) && digest({ source: landFrame.source, bi: itemPayload.bi, bo: itemPayload.bo, bd: itemPayload.bd }) === flow.frameFingerprint &&
              actualValues.bi === flow.bi && actualValues.bo === flow.bo && actualValues.bd === flow.bd &&
              canonical(boCoverage) === canonical(flow.boCoverage) && canonical(bdCoverage) === canonical(flow.bdCoverage) &&
              boCostEvidence === flow.boCostEvidence;
            itemFlow = { present: true, source: fields(itemSource, ['method', 'responseRef', 'wireKey', 'connectionEpoch', 'requestSequence']),
              values: actual, reportedValues: actualValues, fingerprintVerified: frameValid };
            if (!frameValid) waterwheelMissing.push('waterwheel-item-flow-fingerprint');
          } else waterwheelMissing.push('waterwheel-item-flow-source');
        }
        const bridgeLeasePage = bounded('backend_session_verification_leases', 1, `SELECT lease_ref,operation_id,executor_ref,owner_ref,account_ref,subject_ref,
          owner_epoch,run_epoch,original_connection_epoch,new_connection_epoch,state,active,original_context_json,after_json,bridge_json,
          bridge_fingerprint,reason_code,created_at,updated_at FROM backend_session_verification_leases
          WHERE operation_id=? AND owner_ref=? AND account_ref=? AND subject_ref=? ORDER BY lease_ref LIMIT ?`,
        operation.operation_id, ownerRef, operation.account_ref, subjectRef);
        const lease = bridgeLeasePage.rows[0] || null;
        let bridgeAudit = { available: bridgeLeasePage.available, complete: false, lease: null, physicalClose: null, events: { available: has('backend_session_verification_events'), complete: false, rows: [] } };
        if (!lease || !lease.bridge_json) waterwheelMissing.push('waterwheel-postread-lease');
        else {
          const receipt = parseStored(lease.bridge_json, '水车关闭后登录原始桥'), projected = leaseReceipt(receipt);
          const originalContext = parseStored(lease.original_context_json, '水车原连接上下文'), after = parseStored(lease.after_json, '水车原写绑定');
          const validation = backend.supervisor.validateReadSnapshotLease({ leaseRef: lease.lease_ref, operationId: operation.operation_id,
            originalContext, newContext: receipt.newContext, after, bridgeFingerprint: lease.bridge_fingerprint, phase: 'settling' });
          const leaseEventsPage = bounded('backend_session_verification_events', 32, `SELECT event_ref,lease_ref,event_kind,receipt_json,recorded_at
            FROM backend_session_verification_events WHERE lease_ref=? ORDER BY recorded_at,event_ref LIMIT ?`, lease.lease_ref);
          const leaseEvents = leaseEventsPage.rows.map(({ receipt_json, ...entry }) => {
            const raw = parseStored(receipt_json, '水车关闭登录租约事件');
            const receiptView = safe(raw, 'waterwheel-lease-event:' + entry.event_ref);
            return { ...entry, receipt: receiptView, receiptFingerprint: digest(raw), projectionComplete: canonical(receiptView) === canonical(raw) };
          });
          const closeRef = receipt.oldPhysicalCloseReceipt?.closureEvidenceRef;
          const close = typeof closeRef === 'string' && has('backend_session_connection_closures') ? get(`SELECT evidence_ref,executor_ref,
            owner_epoch,run_epoch,connection_epoch,proof_kind,proof_json,recorded_at FROM backend_session_connection_closures
            WHERE evidence_ref=? AND owner_ref=? AND account_ref=? AND subject_ref=? AND executor_ref=? AND owner_epoch=? AND run_epoch=? AND connection_epoch=?`,
          closeRef, ownerRef, operation.account_ref, subjectRef, lease.executor_ref, operation.original.ownerEpoch, operation.run_epoch, operation.connection_epoch) : null;
          let closeView = null;
          if (close) {
            const raw = parseStored(close.proof_json, '水车原物理关闭记录');
            const view = fields(raw, ['closed','connectionEpoch','leaseRef','operationId','code','source']);
            if (Object.hasOwn(raw, 'after')) view.after = fields(raw.after, ['connectionEpoch','requestSequence','wireKey','responseRef']);
            closeView = { ...fields(close, ['evidence_ref','executor_ref','owner_epoch','run_epoch','connection_epoch','proof_kind','recorded_at']),
              proof: view, proofFingerprint: digest(raw), projectionComplete: canonical(view) === canonical(raw),
              evidenceRefVerified: close.evidence_ref === 'session-close:' + digest([lease.executor_ref, subjectRef, operation.connection_epoch, close.proof_kind]) };
          }
          const eventsComplete = leaseEventsPage.available && leaseEventsPage.complete &&
            ['created','old-closed-new-epoch','fresh-login-observed'].every(kind => leaseEvents.some(entry => entry.event_kind === kind)) &&
            (lease.state !== 'released' || leaseEvents.some(entry => entry.event_kind === 'durable-outcome-released'));
          const leaseComplete = lease.owner_ref === ownerRef && lease.account_ref === operation.account_ref && lease.subject_ref === subjectRef &&
            lease.operation_id === operation.operation_id && lease.original_connection_epoch === operation.connection_epoch &&
            lease.new_connection_epoch === proof?.bridge?.newConnectionEpoch && receipt.operationId === operation.operation_id &&
            receipt.newLoginSource?.responseRef === proof?.postReadRef && receipt.newLoginSource?.requestSequence === proof?.bridge?.newLoginRequestSequence &&
            receipt.newLoginSource?.wireKey === proof?.bridge?.newLoginWireKey &&
            receipt.officialUid === preparation?.uid && digest(receipt) === lease.bridge_fingerprint &&
            proof?.bridge?.bridgeFingerprint === lease.bridge_fingerprint && validation.valid === true &&
            digest(receipt) === lease.bridge_fingerprint && canonical(projected) === canonical(receipt);
          if (!leaseComplete) waterwheelMissing.push('waterwheel-postread-lease-integrity');
          if (!closeView?.proof?.closed || closeView.projectionComplete !== true || closeView.evidenceRefVerified !== true)
            waterwheelMissing.push('waterwheel-postread-physical-close');
          if (!eventsComplete || leaseEvents.some(entry => entry.projectionComplete !== true)) waterwheelMissing.push('waterwheel-postread-lease-events');
          bridgeAudit = { available: bridgeLeasePage.available, complete: leaseComplete && eventsComplete && !!closeView?.proof?.closed &&
            closeView.projectionComplete === true && closeView.evidenceRefVerified === true,
            lease: { ...fields(lease, ['lease_ref','operation_id','executor_ref','owner_ref','account_ref','subject_ref','owner_epoch','run_epoch',
              'original_connection_epoch','new_connection_epoch','state','active','bridge_fingerprint','reason_code','created_at','updated_at']),
              receipt: projected, receiptFingerprint: digest(receipt), receiptProjectionComplete: canonical(projected) === canonical(receipt),
              validation: fields(validation, ['valid','current','reasonCode','leaseRef','operationId','bridgeFingerprint']) },
            physicalClose: closeView, events: { available: leaseEventsPage.available, complete: eventsComplete, limit: leaseEventsPage.limit, rows: leaseEvents } };
        }
        const projection = { applicable: true, contract: { kind: waterwheelKind, featureId: 'waterwheel', scope: operation.scope,
          method: operation.method, extensionId: extension?.extensionId ?? null, extensionRef: extension?.extensionRef ?? null,
          baseDataSnapshotId: extension?.baseDataSnapshotId ?? null, bundleRef: extension?.bundleRef ?? null,
          loginResponseRef: extension?.loginResponseRef ?? null, sourcePin: extension?.sourcePin ?? null,
          sourceProof: extension?.sourceProof ? { sourcePin: extension.sourceProof.sourcePin, sourceVersion: extension.sourceProof.sourceReferenceVersion,
            sourceReferenceSha256: extension.sourceProof.sourceReferenceSha256, gameSha256: extension.sourceProof.gameSha256,
            matchedRanges: extension.sourceProof.matchedRanges.map(range => fields(range,
              ['name','pinnedStart','pinnedEnd','actualStart','actualEnd','sha256'])) } : null },
          settlement: settlement ? { settlementKey: settlement.settlement_key, verdict: settlement.verdict,
            verificationVersion: settlement.verification_version, resultFingerprintVerified: hashLedgerBytes(settlement.result_json) === settlement.result_fingerprint,
            evidenceProjectionComplete: canonical(proofProjection) === canonical(proof), evidence: proofProjection,
            result: { member: result?.member, verificationVersion: result?.verificationVersion,
              resourceResolutions: result?.resourceResolutions, transportTermination: result?.transportTermination } } : null,
          postReadBridge: bridgeAudit, sourceReceipts: wheelRows, itemFlow, missing: waterwheelMissing };
        waterwheelAudit = safe(projection, 'waterwheelAudit');
        waterwheelAuditComplete = waterwheelMissing.length === 0 && wheelRows.every(row => !row.present ||
          row.valueFingerprintVerified && row.valueProjectionComplete && row.valueProjectionFingerprint === row.valueFingerprint) &&
          bridgeAudit.complete === true &&
          (!settlement || canonical(waterwheelAudit) === canonical(projection));
        if (!waterwheelAuditComplete) missing.push('waterwheel-audit-incomplete');
      }
      const freeWaterKind = Object.keys(FREE_WATER_METHODS).find(kind => operation.feature_id === 'free-water' &&
        operation.scope === FREE_WATER_SCOPES[kind] && operation.method === FREE_WATER_METHODS[kind]);
      const freeWaterOperation = Boolean(freeWaterKind);
      let freeWaterAudit = null, freeWaterAuditComplete = true;
      if (freeWaterOperation) {
        const freeMissing = [];
        const parseFree = (raw, label) => { try { return parseStored(raw, label); } catch { freeMissing.push('free-water-stored-source-invalid:' + label); return null; } };
        const prepRow = evidence.find(entry => entry.kind === 'finite-domain-preparation' && entry.source === 'backend/write-gateway/v2' &&
          entry.payload?.domain === operation.scope && storedEvidenceValid(entry));
        const contractRow = evidence.find(entry => entry.kind === 'admitted-operation-contract' && entry.source === 'backend/write-gateway/v2' &&
          storedEvidenceValid(entry));
        const preparation = prepRow?.payload?.preparation, extension = preparation?.extension, target = operation.original.targets?.[0];
        const extensionBody = extension && Object.fromEntries(Object.entries(extension).filter(([key]) => key !== 'extensionRef'));
        const params = freeWaterKind === 'receive' ? { idx: preparation?.idx } : { shareId: 13, ext: { opType: 1, id: preparation?.idx } };
        const { validateResponseCoverage: _freeCoverage, ...freePostRead } = FREE_WATER_POST_READ;
        const expectedDescriptor = { ...FREE_WATER_DEFINITIONS[freeWaterKind], postRead: freePostRead };
        const factSnapshot = preparation?.factSnapshot;
        const factSnapshotValid = factSnapshot && factSnapshot.fingerprint === preparation.sourceFingerprint &&
          factSnapshot.fingerprint === digest({ value: factSnapshot.value, sources: factSnapshot.sources }) &&
          factSnapshot.sources?.water?.responseRef === preparation.sourceRef && factSnapshot.value?.water &&
          (factSnapshot.value.share13 === null ? !factSnapshot.sources?.share13 : !!factSnapshot.sources?.share13?.responseRef);
        const sourcePreparationValid = preparation?.kind === freeWaterKind && prepRow?.payload?.domain === operation.scope && factSnapshotValid &&
          Number.isSafeInteger(preparation.idx) && [0,1].includes(preparation.idx) && Number.isSafeInteger(preparation.uid) && preparation.uid > 0 &&
          extension?.extensionId === FREE_WATER_EXTENSION_ID && extension?.sourcePin === FREE_WATER_SOURCE_PIN &&
          extension?.extensionRef === 'sha256:' + digest(extensionBody) && extension?.loginResponseRef === preparation.loginResponseRef &&
          extension?.bundleRef === preparation.bundleRef && typeof extension?.baseDataSnapshotId === 'string' &&
          extension.sourceProof?.extensionId === FREE_WATER_EXTENSION_ID && extension.sourceProof?.sourcePin === FREE_WATER_SOURCE_PIN &&
          extension.sourceProof?.matchedRanges?.length === 13 && typeof preparation.sourceRef === 'string' &&
          typeof preparation.sourceFingerprint === 'string' && typeof preparation.dayKey === 'string' &&
          typeof preparation.dayProofRef === 'string' && contractRow?.payload?.featureId === 'free-water' &&
          contractRow.payload.scope === operation.scope && contractRow.payload.method === operation.method &&
          contractRow.payload.contractId === FREE_WATER_CONTRACT_REF + '/' + freeWaterKind &&
          canonical(contractRow.payload) === canonical(expectedDescriptor) && operation.original.paramsFingerprint === digest(params) &&
          target?.targetKind === 'free-water' && target.targetRef === `free-water:${subjectRef}:${preparation.dayKey}:${preparation.idx}` &&
          target.memberKey === 'free-water:' + digest([preparation.dayKey, preparation.idx]) &&
          target.targetFingerprint === digest({ targetRef: target.targetRef, sourceRef: preparation.sourceRef, extensionRef: extension.extensionRef });
        if (!sourcePreparationValid) freeMissing.push('free-water-preparation-contract');
        const answerRow = evidence.find(entry => entry.kind === 'official-answer' && entry.source === 'backend/write-gateway/v2' &&
          storedEvidenceValid(entry) && entry.payload?.method === operation.method && entry.payload?.connectionEpoch === operation.connection_epoch &&
          entry.payload?.requestSequence === permit?.request_sequence && entry.payload?.wireKey === permit?.wire_key &&
          typeof entry.payload?.responseRef === 'string');
        if (operation.transport_state === 'answered' && !answerRow) freeMissing.push('free-water-matched-write-answer');
        const settlement = operation.targetSettlements?.find(one => one.member_key === target?.memberKey), result = settlement?.result, proof = result?.evidence?.payload;
        const bridgeEvidence = evidence.find(entry => entry.kind === 'after-close-login-post-read' && entry.source === 'backend/write-gateway/v2' && storedEvidenceValid(entry));
        const bridgeValid = bridgeEvidence?.payload?.operationId === operation.operation_id && typeof bridgeEvidence.payload.leaseRef === 'string' &&
          bridgeEvidence.payload.bridgeFingerprint === proof?.bridgeFingerprint &&
          bridgeEvidence.payload.newLoginResponseRef === proof?.postReadRef &&
          bridgeEvidence.payload.newLoginRequestSequence === proof?.postReadRequestSequence &&
          bridgeEvidence.payload.newLoginConnectionEpoch === proof?.postReadConnectionEpoch &&
          bridgeEvidence.payload.oldPhysicalCloseReceipt?.closed === true &&
          bridgeEvidence.payload.oldPhysicalCloseReceipt?.connectionEpoch === operation.connection_epoch;
        if (operation.transport_state === 'answered' && answerRow?.payload?.responseRef !== proof?.writeResponseRef)
          freeMissing.push('free-water-write-response-reference');
        const proofFields = ['traceId','targetRef','extensionRef','dayKey','postReadRef','postReadRequestSequence','postReadConnectionEpoch','writeResponseRef',
          'item7Before','item7After','item7Gain','item7EffectiveDelta','receivedIndices','share13After','writeItem7Flow','postExtension','postSources',
          'officialDay','officialDayProofRef','bridgeFingerprint'];
        const proofProjection = fields(proof, proofFields);
        if (proofProjection.writeItem7Flow) proofProjection.writeItem7Flow = fields(proofProjection.writeItem7Flow,
          ['method','responseRef','requestSequence','connectionEpoch','wireKey','observationRef','bi','bo','bd','boCoverage','bdCoverage','frameFingerprint']);
        if (proofProjection.postExtension) proofProjection.postExtension = fields(proofProjection.postExtension,
          ['extensionId','sourcePin','sourceVersion','baseDataSnapshotId','bundleRef','loginResponseRef','resourceSha256','baseTableHashes','tableHashes','sourceProof','rules','extensionRef']);
        if (proofProjection.postSources) proofProjection.postSources = fields(proofProjection.postSources, ['water','share13']);
        if (proofProjection.officialDay) proofProjection.officialDay = fields(proofProjection.officialDay,
          ['current','key','startMs','endMs','proofRef']);
        const postExtension = proof?.postExtension;
        const postExtensionBody = postExtension && Object.fromEntries(Object.entries(postExtension).filter(([key]) => key !== 'extensionRef'));
        const postExtensionValid = postExtension?.extensionId === FREE_WATER_EXTENSION_ID && postExtension.sourcePin === FREE_WATER_SOURCE_PIN &&
          postExtension.extensionRef === 'sha256:' + digest(postExtensionBody) && postExtension.loginResponseRef === proof?.postReadRef &&
          postExtension.sourceProof?.matchedRanges?.length === 13 && postExtension.bundleRef && postExtension.baseDataSnapshotId;
        const settlementComplete = settlement && hashLedgerBytes(settlement.result_json) === settlement.result_fingerprint &&
          result?.member?.memberKey === target?.memberKey && result.member.verdict === operation.business_verdict &&
          result.verificationVersion === settlement.verification_version && settlement.verification_version === 'free-water/target-postread/v1' &&
          proof?.traceId === operation.original.traceId && proof?.targetRef === target?.targetRef && proof?.extensionRef === extension?.extensionRef && postExtensionValid &&
          proof?.officialDayProofRef === proof?.postReadRef && proof.officialDay?.proofRef === proof.postReadRef &&
          proof.officialDay?.key === preparation?.dayKey &&
          canonical(proofProjection) === canonical(proof) && bridgeValid && Array.isArray(result.resourceResolutions) && result.resourceResolutions.length === 0;
        if (operation.transport_state === 'answered' && !settlementComplete) freeMissing.push('free-water-target-settlement');
        const sourceRows = [];
        const answered = operation.transport_state === 'answered';
        for (const [kind, ref, expectedEpoch, required] of [
          ['preparation-water', preparation?.factSnapshot?.sources?.water?.responseRef, operation.connection_epoch, true],
          ['preparation-share13', preparation?.factSnapshot?.sources?.share13?.responseRef, operation.connection_epoch, freeWaterKind === 'share'],
          ['write', proof?.writeResponseRef, operation.connection_epoch, false],
          ['post', proof?.postReadRef, proof?.postReadConnectionEpoch, answered]]) {
          if (typeof ref !== 'string' || !ref) { if (required) freeMissing.push('free-water-source-reference:' + kind); continue; }
          const row = has('backend_free_water_receipts') ? get(`SELECT * FROM backend_free_water_receipts WHERE response_ref=? AND owner_ref=? AND account_ref=?
            AND subject_ref=? AND connection_epoch=?`, ref, ownerRef, operation.account_ref, subjectRef, expectedEpoch) : null;
          if (!row) { sourceRows.push({ kind, responseRef: ref, present: false, required }); if (required) freeMissing.push('free-water-source-receipt:' + kind); continue; }
          let value = null; try { value = parseStored(row.value_json, '每日水滴来源事实'); } catch { /* report below */ }
          const expectedDomainValue = kind === 'preparation-water' ? preparation?.factSnapshot?.value?.water :
            kind === 'preparation-share13' ? preparation?.factSnapshot?.value?.share13 :
              kind === 'post' ? proof?.postSources?.[freeWaterKind === 'share' ? 'share13' : 'water'] : null;
          const expectedSource = kind === 'preparation-water' ? preparation?.factSnapshot?.sources?.water :
            kind === 'preparation-share13' ? preparation?.factSnapshot?.sources?.share13 :
              kind === 'post' ? proof?.postSources?.[freeWaterKind === 'share' ? 'share13' : 'water'] : null;
          const sourceValid = value && digest(value) === row.value_fingerprint && row.owner_epoch === operation.original.ownerEpoch &&
            row.run_epoch === operation.run_epoch && row.response_ref === ref && row.connection_epoch === expectedEpoch &&
            (!expectedSource || expectedSource.responseRef === row.response_ref && expectedSource.method === row.method &&
              expectedSource.connectionEpoch === row.connection_epoch && expectedSource.requestSequence === row.request_sequence) &&
            (kind !== 'write' || row.method === operation.method && row.request_sequence === permit?.request_sequence) &&
            (kind !== 'post' || row.method === 'index.login' && row.request_sequence === proof?.postReadRequestSequence) &&
            (kind !== 'preparation-water' && kind !== 'preparation-share13' && kind !== 'post' ||
              canonical(value[kind === 'preparation-water' ? 'water' : kind === 'preparation-share13' ? 'share13' : freeWaterKind === 'share' ? 'share13' : 'water']) === canonical(expectedDomainValue));
          if (!sourceValid && required) freeMissing.push('free-water-source-fingerprint:' + kind);
          const projection = safe(value, 'free-water-source:' + kind);
          sourceRows.push({ kind, responseRef: ref, present: true, required, method: row.method, requestSequence: row.request_sequence,
            connectionEpoch: row.connection_epoch, valueFingerprint: row.value_fingerprint, valueFingerprintVerified: sourceValid,
            valueProjectionFingerprint: projection ? digest(projection) : null, valueProjectionComplete: !!projection && canonical(projection) === canonical(value), value: projection });
        }
        const dayRows = [];
        for (const [kind, ref] of [['preparation', preparation?.dayProofRef], ['post', proof?.officialDayProofRef]]) {
          if (kind === 'post' && !answered) continue;
          const row = typeof ref === 'string' && has('backend_customer_generation_days') ? get(`SELECT * FROM backend_customer_generation_days WHERE response_ref=?
            AND owner_ref=? AND account_ref=? AND subject_ref=?`, ref, ownerRef, operation.account_ref, subjectRef) : null;
          if (!row) { freeMissing.push('free-water-official-day:' + kind); dayRows.push({ kind, responseRef: ref ?? null, present: false }); continue; }
          let value = null; try { value = parseStored(row.payload_json, '水滴官方日原始证据'); } catch { /* report below */ }
          const valid = value && digest(value) === row.payload_fingerprint && value.officialDay?.known === true &&
            value.officialDay.key === preparation?.dayKey && row.response_ref === ref && value.source?.responseRef === ref &&
            value.source?.method === 'index.login' && row.owner_ref === ownerRef && row.account_ref === operation.account_ref &&
            row.subject_ref === subjectRef && row.connection_epoch === (kind === 'preparation' ? operation.connection_epoch : proof?.postReadConnectionEpoch);
          if (!valid) freeMissing.push('free-water-official-day-fingerprint:' + kind);
          const dayProjection = safe(value, 'free-water-day:' + kind);
          dayRows.push({ kind, responseRef: ref, present: true, payloadFingerprint: row.payload_fingerprint,
            fingerprintVerified: valid, payloadProjectionComplete: canonical(dayProjection) === canonical(value), payload: dayProjection });
        }
        const flow = proof?.writeItem7Flow; let itemFlow = null;
        if (answered && ['receive','share'].includes(freeWaterKind)) {
          const frame = flow && has('backend_official_item_frames') ? get(`SELECT * FROM backend_official_item_frames WHERE observation_ref=? AND owner_ref=?
            AND account_ref=? AND subject_ref=? AND connection_epoch=? AND request_sequence=? AND response_ref=? AND wire_key=?`, flow.observationRef, ownerRef,
          operation.account_ref, subjectRef, operation.connection_epoch, flow.requestSequence, flow.responseRef, flow.wireKey) : null;
          const admitted = frame && has('backend_land_domain_observations') ? get(`SELECT accepted,frame_json,payload_fingerprint FROM backend_land_domain_observations
            WHERE observation_ref=? AND owner_ref=? AND account_ref=? AND subject_ref=? AND connection_epoch=? AND request_sequence=? AND response_ref=? AND wire_key=?`,
          flow.observationRef, ownerRef, operation.account_ref, subjectRef, operation.connection_epoch, flow.requestSequence, flow.responseRef, flow.wireKey) : null;
          let frameValid = false, values = null;
          const admittedEvidence = frame ? resolveAcceptedLandObservationEvidence({ store: backend.store,
            context: { ownerRef, accountRef: operation.account_ref, subjectRef, ownerEpoch: operation.original.ownerEpoch,
              runEpoch: operation.run_epoch, connectionEpoch: operation.connection_epoch }, observationRef: flow.observationRef,
            source: parseFree(frame.source_json, 'item-source') }) : null;
          if (frame && admittedEvidence?.accepted === true) {
            const payload = parseFree(frame.payload_json, 'item-frame'), source = parseFree(frame.source_json, 'item-source');
            const admittedFrame = admittedEvidence.frame;
            if (payload && source && admittedFrame) {
              const cell = key => payload[key]?.items?.['7'] ?? null;
              values = { bi: cell('bi'), bo: cell('bo'), bd: cell('bd') };
              const semantic = value => Array.isArray(value) ? value.map(semantic) : value && typeof value === 'object'
                ? Object.fromEntries(Object.entries(value).filter(([key]) => !['source','sourceRef','semanticVersion','observationRef','responseRef'].includes(key))
                  .map(([key, child]) => [key, semantic(child)])) : value;
              const landPayload = Object.fromEntries(['profile','landUid','landBase','landChanges','cultivates','bag','itemExt','bi','bo','bd','top','harvestMap']
                .map(key => [key, semantic(admittedFrame[key])]));
              frameValid = source.method === operation.method && source.responseRef === flow.responseRef && source.requestSequence === flow.requestSequence &&
                source.wireKey === flow.wireKey && flow.responseRef === answerRow?.payload?.responseRef && flow.requestSequence === permit?.request_sequence &&
                flow.wireKey === permit?.wire_key && flow.connectionEpoch === operation.connection_epoch && typeof flow.frameFingerprint === 'string' &&
                admitted.payload_fingerprint === digest(landPayload) &&
              digest({ source: admittedFrame.source, bi: payload.bi, bo: payload.bo, bd: payload.bd }) === flow.frameFingerprint &&
              canonical(payload) === canonical(Object.fromEntries(['bag','itemExt','bi','bo','bd'].map(key => [key, admittedFrame[key]]))) &&
              canonical(values) === canonical({ bi: flow.bi, bo: flow.bo, bd: flow.bd });
            }
          }
          if (!frameValid) freeMissing.push('free-water-item-flow-source');
          itemFlow = { present: !!frame, observationRef: flow?.observationRef ?? null, responseRef: flow?.responseRef ?? null,
            requestSequence: flow?.requestSequence ?? null, wireKey: flow?.wireKey ?? null, values, fingerprintVerified: frameValid };
        }
        const lease = has('backend_session_verification_leases') ? get(`SELECT * FROM backend_session_verification_leases WHERE operation_id=? AND owner_ref=? AND account_ref=? AND subject_ref=?
          ORDER BY lease_ref LIMIT 1`, operation.operation_id, ownerRef, operation.account_ref, subjectRef) : null;
        let bridgeAudit = { complete: false, lease: null, physicalClose: null, events: { complete: false, rows: [] } };
        if (!lease?.bridge_json) { if (answered) freeMissing.push('free-water-postread-lease'); }
        else {
          const raw = parseFree(lease.bridge_json, 'bridge'), originalContext = parseFree(lease.original_context_json, 'original-context'),
            leaseAfter = parseFree(lease.after_json, 'write-binding');
          if (!raw || !originalContext || !leaseAfter) { freeMissing.push('free-water-postread-lease-integrity'); }
          const view = raw ? leaseReceipt(raw) : null;
          let leaseValidation = { valid: false, reasonCode: 'FREE_WATER_LEASE_SOURCE_INVALID' };
          try { if (raw && originalContext && leaseAfter) leaseValidation = backend.supervisor.validateReadSnapshotLease({ leaseRef: lease.lease_ref,
            operationId: operation.operation_id, originalContext, newContext: raw.newContext, after: leaseAfter,
            bridgeFingerprint: lease.bridge_fingerprint, phase: 'settling' }); } catch { /* keep bounded incomplete projection */ }
          const leaseValid = raw?.operationId === operation.operation_id && digest(raw) === lease.bridge_fingerprint &&
            bridgeEvidence?.payload?.leaseRef === lease.lease_ref && bridgeEvidence?.payload?.bridgeFingerprint === lease.bridge_fingerprint &&
            raw?.newLoginSource?.responseRef === proof?.postReadRef && raw?.officialUid === preparation?.uid &&
            lease.new_connection_epoch === proof?.postReadConnectionEpoch && lease.owner_epoch === operation.original.ownerEpoch &&
            lease.run_epoch === operation.run_epoch && leaseValidation.valid === true;
          const closeRef = raw?.oldPhysicalCloseReceipt?.closureEvidenceRef;
          const close = closeRef && has('backend_session_connection_closures') ? get(`SELECT * FROM backend_session_connection_closures WHERE evidence_ref=? AND owner_ref=?
            AND account_ref=? AND subject_ref=? AND executor_ref=? AND owner_epoch=? AND run_epoch=? AND connection_epoch=?`, closeRef, ownerRef,
          operation.account_ref, subjectRef, lease.executor_ref, operation.original.ownerEpoch, operation.run_epoch, operation.connection_epoch) : null;
          let closeView = null;
          if (close) { const closeRaw = parseFree(close.proof_json, 'physical-close');
            if (!closeRaw) { closeView = null; }
            else {
            const closeProof = fields(closeRaw, ['closed','connectionEpoch','leaseRef','operationId','code','source']);
            closeView = { ...fields(close, ['evidence_ref','executor_ref','owner_epoch','run_epoch','connection_epoch','proof_kind','recorded_at']),
              proof: closeProof, proofFingerprint: digest(closeRaw), projectionComplete: canonical(closeProof) === canonical(closeRaw),
              evidenceRefVerified: close.evidence_ref === 'session-close:' + digest([lease.executor_ref, subjectRef, operation.connection_epoch, close.proof_kind]) }; }
          }
          const rows = has('backend_session_verification_events') ? all(`SELECT event_ref,lease_ref,event_kind,receipt_json,recorded_at FROM backend_session_verification_events
            WHERE lease_ref=? ORDER BY recorded_at,event_ref LIMIT 33`, lease.lease_ref) : [];
          const events = rows.slice(0,32).flatMap(row => { const event = parseFree(row.receipt_json, 'lease-event'); if (!event) return [];
            const projected = safe(event, 'free-water-lease-event:' + row.event_ref);
            return { eventRef: row.event_ref, leaseRef: row.lease_ref, eventKind: row.event_kind, recordedAt: row.recorded_at,
              receipt: projected, receiptFingerprint: digest(event), projectionComplete: canonical(projected) === canonical(event) }; });
          const eventsValid = rows.length <= 32 && ['created','old-closed-new-epoch','fresh-login-observed'].every(kind => events.some(event => event.eventKind === kind)) &&
            (lease.state !== 'released' || events.some(event => event.eventKind === 'durable-outcome-released')) && events.every(event => event.projectionComplete);
          if (!leaseValid) freeMissing.push('free-water-postread-lease-integrity');
          if (!closeView?.proof?.closed || !closeView.projectionComplete || !closeView.evidenceRefVerified) freeMissing.push('free-water-physical-close');
          if (!eventsValid) freeMissing.push('free-water-postread-events');
          bridgeAudit = { complete: leaseValid && eventsValid && !!closeView?.proof?.closed && closeView.projectionComplete && closeView.evidenceRefVerified,
            lease: { ...fields(lease, ['lease_ref','operation_id','executor_ref','owner_ref','account_ref','subject_ref','owner_epoch','run_epoch',
              'original_connection_epoch','new_connection_epoch','state','active','bridge_fingerprint','reason_code','created_at','updated_at']),
              receipt: view, receiptFingerprint: digest(raw), receiptProjectionComplete: canonical(view) === canonical(raw) },
            physicalClose: closeView, events: { complete: eventsValid, rows: events } };
        }
        const freeProjection = { applicable: true, contract: { featureId: 'free-water', kind: freeWaterKind, scope: operation.scope, method: operation.method,
          contractId: FREE_WATER_CONTRACT_REF + '/' + freeWaterKind, extensionId: extension?.extensionId ?? null, extensionRef: extension?.extensionRef ?? null,
          loginResponseRef: extension?.loginResponseRef ?? null, bundleRef: extension?.bundleRef ?? null, sourcePin: extension?.sourcePin ?? null,
          sourceProof: extension?.sourceProof ?? null, dayKey: preparation?.dayKey ?? null, idx: preparation?.idx ?? null },
          settlement: settlement ? { settlementKey: settlement.settlement_key, verdict: settlement.verdict,
            resultFingerprintVerified: hashLedgerBytes(settlement.result_json) === settlement.result_fingerprint,
            evidenceProjectionComplete: canonical(proofProjection) === canonical(proof), evidence: proofProjection,
            result: { member: result?.member, verificationVersion: result?.verificationVersion, resourceResolutions: result?.resourceResolutions } } : null,
          sourceReceipts: sourceRows, officialDay: dayRows, itemFlow, postReadBridge: bridgeAudit, missing: freeMissing };
        freeWaterAudit = safe(freeProjection, 'freeWaterAudit');
        freeWaterAuditComplete = freeMissing.length === 0 && sourceRows.every(row => !row.present || row.valueFingerprintVerified && row.valueProjectionComplete) &&
          (!answered || bridgeAudit.complete === true) && canonical(freeWaterAudit) === canonical(freeProjection);
        if (!freeWaterAuditComplete) missing.push('free-water-audit-incomplete');
      }
      const hasWaterResource = operation.resources.some(resource => resource.resource_kind === 'item' && resource.resource_ref === 'item:7');
      const itemSources = [], itemSourceRefs = new Set(), itemSourceRequests = new Set();
      const itemSourcesAvailable = has('backend_official_item_frames');
      function addItemSource(binding, label, observationRef = null) {
        if (!hasWaterResource || !itemSourcesAvailable) return;
        const requestKey = canonical([binding?.responseRef ?? null, binding?.requestSequence ?? null, binding?.wireKey ?? null, observationRef]);
        if (itemSourceRequests.has(requestKey)) return;
        if (itemSourceRequests.size >= 32) { changedProjections.push('item7Sources.limit'); return; }
        itemSourceRequests.add(requestKey);
        let found = null;
        if (observationRef) found = get(`SELECT observation_ref,account_ref,connection_epoch,request_sequence,response_ref,wire_key,source_json,payload_json,recorded_at
          FROM backend_official_item_frames WHERE observation_ref=? AND owner_ref=? AND account_ref=? AND subject_ref=? AND connection_epoch=?`,
        observationRef, ownerRef, operation.account_ref, subjectRef, operation.connection_epoch);
        else if (binding?.connectionEpoch === operation.connection_epoch && Number.isSafeInteger(binding.requestSequence) && binding.requestSequence > 0 &&
          typeof binding.responseRef === 'string' && typeof binding.wireKey === 'string') found = get(`SELECT observation_ref,account_ref,connection_epoch,
          request_sequence,response_ref,wire_key,source_json,payload_json,recorded_at FROM backend_official_item_frames WHERE owner_ref=? AND account_ref=? AND subject_ref=?
          AND connection_epoch=? AND response_ref=? AND request_sequence=? AND wire_key=?`, ownerRef, operation.account_ref, subjectRef,
        operation.connection_epoch, binding.responseRef, binding.requestSequence, binding.wireKey);
        if (!found) { missing.push(label); return; }
        if (itemSourceRefs.has(found.observation_ref)) return;
        itemSourceRefs.add(found.observation_ref);
        const payload = parseStored(found.payload_json, '单项资源来源'), source = parseStored(found.source_json, '资源来源绑定');
        const selected = {};
        for (const key of ['bag', 'bi', 'bo', 'bd']) selected[key] = { map: fields(payload[key], ['presence', 'state', 'sourceRef', 'reasonCode']), item: cell(payload[key]?.items?.['7']) };
        const ext = payload.itemExt?.value?.['7'];
        selected.itemExt = { map: fields(payload.itemExt, ['presence', 'state', 'sourceRef', 'reasonCode']), item: ext ? {
          ...fields(ext, ['valid', 'sourceRef', 'reasonCode']), fields: Object.fromEntries(['limit', 'resetNum', 'lrms', 'restoreNum', 'cd', 'lems'].map(key => [key, cell(ext.fields?.[key])])) } : null };
        itemSources.push(safe({ observationRef: found.observation_ref, accountRef: found.account_ref, connectionEpoch: found.connection_epoch,
          requestSequence: found.request_sequence, responseRef: found.response_ref, wireKey: found.wire_key, source: fields(source, sourceFields),
          recordedAt: found.recorded_at, itemId: 7, item: selected, projectionFingerprint: digest(selected) }, 'item7Source:' + found.observation_ref));
      }
      for (const entry of evidence) if (entry.kind === 'official-answer') addItemSource(entry.payload, 'item7-write-source:' + entry.evidence_id);
      const observationsAvailable = has('backend_land_domain_observations') && (!ordinaryFlowerDomain || has('backend_order_flower_observations')),
        targetObservations = [], observationRefs = new Set(), observationLimit = 16;
      const observationsWithinLimit = operation.targetSettlements.length <= observationLimit;
      let domainAudit = null, finiteLease = null, finitePreparation = null;
      if (finiteDomain) {
        const preparation = evidence.find(entry => entry.kind === 'finite-domain-preparation' && entry.source === 'backend/write-gateway/v2' &&
          entry.payload?.domain === finiteDomain && storedEvidenceValid(entry));
        finitePreparation = preparation?.payload?.preparation || null;
        if (!finitePreparation) missing.push('domain-finite-preparation');
        const leases = bounded('backend_session_verification_leases', 1, `SELECT lease_ref,operation_id,executor_ref,owner_ref,account_ref,subject_ref,
          owner_epoch,run_epoch,original_connection_epoch,new_connection_epoch,state,active,original_context_json,after_json,bridge_json,
          bridge_fingerprint,reason_code,created_at,updated_at FROM backend_session_verification_leases
          WHERE operation_id=? AND owner_ref=? AND account_ref=? AND subject_ref=? ORDER BY lease_ref LIMIT ?`,
        operationId, ownerRef, operation.account_ref, subjectRef);
        const lease = leases.rows[0] || null;
        let leaseRow = null, closure = null, leaseEvents = { available: has('backend_session_verification_events'), complete: false, limit: 32, rows: [] };
        if (!lease) missing.push('domain-verification-lease');
        if (lease) {
          const originalContext = parseStored(lease.original_context_json, '原后验租约归属'), after = parseStored(lease.after_json, '原后验租约写绑定');
          const receipt = lease.bridge_json ? parseStored(lease.bridge_json, '原后验关闭登录桥') : null, projected = leaseReceipt(receipt);
          const validation = receipt && typeof backend.supervisor.validateReadSnapshotLease === 'function'
            ? backend.supervisor.validateReadSnapshotLease({ leaseRef: lease.lease_ref, operationId, originalContext,
              newContext: receipt.newContext, after, bridgeFingerprint: lease.bridge_fingerprint }) : { valid: false, current: false, reasonCode: 'VERIFICATION_BRIDGE_NOT_READY' };
          finiteLease = { lease, receipt, validation, originalContext, after };
          leaseRow = { ...fields(lease, ['lease_ref', 'operation_id', 'executor_ref', 'owner_ref', 'account_ref', 'subject_ref', 'owner_epoch', 'run_epoch',
            'original_connection_epoch', 'new_connection_epoch', 'state', 'active', 'bridge_fingerprint', 'reason_code', 'created_at', 'updated_at']),
          originalContext: fields(originalContext, contextFields), after: fields(after, bindingFields), bridge: projected,
          bridgeIntegrity: { storedFingerprintVerified: !!receipt && digest(receipt) === lease.bridge_fingerprint,
            projectionFingerprint: projected ? digest(projected) : null, complete: !!receipt && canonical(projected) === canonical(receipt) },
          validation: fields(validation, ['valid', 'current', 'reasonCode', 'leaseRef', 'operationId', 'bridgeFingerprint']) };
          const page = bounded('backend_session_verification_events', 32, `SELECT e.event_ref,e.lease_ref,e.event_kind,e.receipt_json,e.recorded_at
            FROM backend_session_verification_events e JOIN backend_session_verification_leases l ON l.lease_ref=e.lease_ref
            WHERE l.lease_ref=? AND l.operation_id=? AND l.owner_ref=? AND l.account_ref=? AND l.subject_ref=? ORDER BY e.recorded_at,e.event_ref LIMIT ?`,
          lease.lease_ref, operationId, ownerRef, operation.account_ref, subjectRef);
          leaseEvents = { ...page, rows: page.rows.map(({ receipt_json, ...entry }) => {
            const raw = parseStored(receipt_json, '原后验租约事件'), out = leaseReceipt(raw);
            Object.assign(out, fields(raw, ['reasonCode', 'businessVerdict', 'originalUnknownAndResourcesUnchanged', 'recoveryEvidenceId',
              'originalVerdict', 'originalOutcomeAndResourcesUnchanged']));
            for (const key of ['currentContext']) if (Object.hasOwn(raw, key)) out[key] = fields(raw[key], contextFields);
            if (Object.hasOwn(raw, 'currentLoginSource')) out.currentLoginSource = finiteSource(raw.currentLoginSource);
            if (Object.hasOwn(raw, 'previousExecution')) out.previousExecution = fields(raw.previousExecution,
              ['kind', 'closed', 'evidenceRef', 'evidenceHash', 'closureEvidenceRef', 'executorRef', 'connectionEpoch', 'source', 'code']);
            return safe({ ...entry, receipt: out, receiptFingerprint: digest(raw), receiptProjectionComplete: canonical(out) === canonical(raw) },
              'verification-event:' + entry.event_ref);
          }) };
          const closeRef = receipt?.oldPhysicalCloseReceipt?.closureEvidenceRef;
          const close = typeof closeRef === 'string' && has('backend_session_connection_closures') ? get(`SELECT evidence_ref,executor_ref,
            owner_epoch,run_epoch,connection_epoch,proof_kind,proof_json,recorded_at FROM backend_session_connection_closures
            WHERE evidence_ref=? AND owner_ref=? AND account_ref=? AND subject_ref=? AND executor_ref=? AND owner_epoch=? AND run_epoch=? AND connection_epoch=?`,
          closeRef, ownerRef, operation.account_ref, subjectRef, lease.executor_ref, operation.original.ownerEpoch, operation.run_epoch, operation.connection_epoch) : null;
          if (close) {
            const proof = parseStored(close.proof_json, '原后验物理关闭回执'), out = fields(proof, ['closed', 'connectionEpoch', 'leaseRef', 'operationId', 'code', 'source']);
            if (Object.hasOwn(proof, 'after')) out.after = fields(proof.after, bindingFields);
            closure = safe({ ...fields(close, ['evidence_ref', 'executor_ref', 'owner_epoch', 'run_epoch', 'connection_epoch', 'proof_kind', 'recorded_at']),
              proof: out, proofFingerprint: digest(proof), proofProjectionComplete: canonical(out) === canonical(proof),
              evidenceRefVerified: close.evidence_ref === 'session-close:' + digest([lease.executor_ref, subjectRef, operation.connection_epoch, close.proof_kind]) }, 'domain-physical-close');
          } else missing.push('domain-physical-close');
          if (validation.valid !== true) missing.push('domain-verification-bridge');
        }
        domainAudit = { domain: finiteDomain, contract: finiteDomain === 'customer' ? 'customer-after-close-login/v1'
          : finiteDomain === 'customer-reject' ? 'customer-reject-after-close-login/v1'
            : finiteDomain === 'customer-generation' ? 'customer-generation-after-close-login/v1'
          : finiteDomain === 'art-daily' ? 'art-daily/after-close-login/v1'
            : finiteDomain === 'art-customer-batch' ? 'art-customer-batch/after-close-login/v2'
              : finiteDomain === 'art-first-album' ? 'art-first-album/after-close-login/v1'
                : finiteDomain === 'art-first-share' ? 'art-first-share/after-close-login/v1'
            : ordinaryFlowerDomain ? 'order-flower-after-close-login/v1' : auxiliaryFlowerDomain
                ? 'order-flower-' + auxiliaryFlowerDomain.split('-')[2] + '-after-close-login/v1' : 'art-after-close-login/v1',
          lease: { available: leases.available, complete: leases.complete, present: !!leaseRow, row: leaseRow, events: leaseEvents, physicalClose: closure },
          costObservation: null };
        if (ordinaryFlowerDomain && finitePreparation) {
          domainAudit.deliveryAccounting = readOrderFlowerDeliveryAudit({ store: backend.store, operation, preparation: finitePreparation });
          missing.push(...domainAudit.deliveryAccounting.missing);
        }
        if (finiteDomain === 'art' && finitePreparation?.costObservation) {
          const quotaRef = finitePreparation?.costObservation?.quotaRef, quotaAvailable = has('backend_art_cost_observation_quotas');
          const quota = quotaAvailable && typeof quotaRef === 'string' ? get(`SELECT quota_ref,owner_ref,account_ref,subject_ref,game_version,protocol_version,
            recipe_fingerprint,art_id,unit_ref,demand_ref,parent_lifecycle_ref,operation_id,state,binding_json,binding_fingerprint,verdict,
            receipt_json,receipt_fingerprint,revision,created_at,updated_at FROM backend_art_cost_observation_quotas
            WHERE quota_ref=? AND operation_id=? AND owner_ref=? AND account_ref=? AND subject_ref=?`,
          quotaRef, operationId, ownerRef, operation.account_ref, subjectRef) : null;
          let quotaRow = null, costHead = null, scopeCounts = null, events = { available: has('backend_art_cost_observation_events'), complete: false, limit: 32, rows: [] };
          if (quota) {
            scopeCounts = { matchingVersionRecipeQuotaRows: get(`SELECT COUNT(*) AS count FROM backend_art_cost_observation_quotas
              WHERE owner_ref=? AND account_ref=? AND subject_ref=? AND game_version=? AND protocol_version=? AND recipe_fingerprint=?`,
            ownerRef, operation.account_ref, subjectRef, quota.game_version, quota.protocol_version, quota.recipe_fingerprint).count,
            potentiallySentUnitOperations: get(`SELECT COUNT(*) AS count FROM backend_operations WHERE owner_ref=? AND account_ref=? AND subject_ref=?
              AND feature_id='art.make' AND scope='flower-art-make' AND method='flowerArt.makeFlowerArt' AND semantic_key=? AND transport_state!='not_sent'`,
            ownerRef, operation.account_ref, subjectRef, operation.semantic_key).count };
            const binding = parseStored(quota.binding_json, '花艺原成本观察单件'), projectedBinding = projectQuotaBinding(binding);
            const receipt = quota.receipt_json ? parseStored(quota.receipt_json, '花艺原成本观察结算') : null, projectedReceipt = quotaReceipt(receipt);
            const rawCost = receipt?.observedCostReceipt, projectedCost = costReceipt(rawCost);
            quotaRow = { ...fields(quota, ['quota_ref', 'owner_ref', 'account_ref', 'subject_ref', 'game_version', 'protocol_version', 'recipe_fingerprint',
              'art_id', 'unit_ref', 'demand_ref', 'parent_lifecycle_ref', 'operation_id', 'state', 'binding_fingerprint', 'verdict', 'receipt_fingerprint',
              'revision', 'created_at', 'updated_at']), binding: projectedBinding, receipt: projectedReceipt,
            bindingIntegrity: { storedFingerprintVerified: digest(binding) === quota.binding_fingerprint,
              projectionFingerprint: digest(projectedBinding), complete: canonical(binding) === canonical(projectedBinding),
              matchesOperation: binding.operationId === operationId && sameFields(binding.context, operation.original, contextFields) &&
                binding.semanticKey === operation.semantic_key && binding.paramsFingerprint === operation.params_fingerprint &&
                canonical(binding.targets) === canonical(operation.original.targets) && canonical(binding.resources) === canonical(operation.original.resources) &&
                canonical(binding.resourceBindings) === canonical(operation.original.resourceBindings) && canonical(binding.art) === canonical(finitePreparation) },
            receiptIntegrity: { storedFingerprintVerified: !!receipt && digest(receipt) === quota.receipt_fingerprint,
              projectionFingerprint: projectedReceipt ? digest(projectedReceipt) : null, complete: !!receipt && canonical(receipt) === canonical(projectedReceipt) } };
            if (rawCost) {
              const body = Object.fromEntries(Object.entries(rawCost).filter(([key]) => !['receiptRef', 'receiptFingerprint'].includes(key)));
              costHead = { source: 'original-cost-observation-quota-settlement', operationId, quotaRef, receipt: projectedCost,
                receiptIntegrity: { storedFingerprintVerified: digest(body) === rawCost.receiptFingerprint && rawCost.receiptRef === 'art-observed-cost:' + digest(body),
                  projectionFingerprint: projectedCost ? digest(Object.fromEntries(Object.entries(projectedCost).filter(([key]) => !['receiptRef', 'receiptFingerprint'].includes(key)))) : null,
                  complete: canonical(rawCost) === canonical(projectedCost) } };
            }
            const page = bounded('backend_art_cost_observation_events', 32, `SELECT e.event_key,e.quota_ref,e.operation_id,e.kind,e.payload_json,e.payload_fingerprint,e.recorded_at
              FROM backend_art_cost_observation_events e JOIN backend_art_cost_observation_quotas q ON q.quota_ref=e.quota_ref
              WHERE q.quota_ref=? AND q.owner_ref=? AND q.account_ref=? AND q.subject_ref=? AND e.operation_id=? ORDER BY e.recorded_at,e.event_key LIMIT ?`,
            quotaRef, ownerRef, operation.account_ref, subjectRef, operationId);
            events = { ...page, rows: page.rows.map(({ payload_json, ...entry }) => {
              const payload = parseStored(payload_json, '花艺成本观察事件'), out = entry.kind === 'cost-observation-settled' ? quotaReceipt(payload) : fields(payload,
                ['candidateFingerprint', 'quotaRef', 'unitRef', 'demandRef', 'parentLifecycleRef', 'recipeFingerprint', 'originalOutcomesUnchanged', 'exactOwnReservationChecked']);
              if (Object.hasOwn(payload, 'inputResourceKeys')) out.inputResourceKeys = Array.isArray(payload.inputResourceKeys) ? payload.inputResourceKeys.slice(0, 8) : null;
              if (Object.hasOwn(payload, 'priorNonSendProof')) out.priorNonSendProof = payload.priorNonSendProof ? fields(payload.priorNonSendProof,
                ['known', 'kind', 'operationId', 'originalFingerprint', 'evidenceId', 'evidenceFingerprint']) : null;
              return safe({ ...entry, payload: out, storedFingerprintVerified: digest(payload) === entry.payload_fingerprint,
                eventKeyVerified: entry.event_key === 'art-cost-event:' + digest([entry.quota_ref, entry.operation_id, entry.kind, payload]),
                payloadProjectionComplete: canonical(out) === canonical(payload) }, 'art-cost-event:' + entry.event_key);
            }) };
          } else missing.push('art-cost-observation-quota');
          domainAudit.costObservation = { available: quotaAvailable, present: !!quotaRow, scopeCounts, quota: quotaRow, events, costHead };
        }
        if (finiteDomain === 'art' && finitePreparation?.productionUnit) {
          const available = has('backend_art_production_units'), unitRef = finitePreparation.productionUnit.unitRef;
          const row = available ? get(`SELECT unit_ref,owner_ref,subject_ref,parent_lifecycle_ref,recipe_fingerprint,ordinal,art_id,demand_ref,
            cost_receipt_ref,cost_receipt_fingerprint,account_ref,operation_id,state,binding_json,binding_fingerprint,verdict,
            receipt_json,receipt_fingerprint,revision,created_at,updated_at FROM backend_art_production_units
            WHERE unit_ref=? AND operation_id=? AND owner_ref=? AND account_ref=? AND subject_ref=?`,
          unitRef, operationId, ownerRef, operation.account_ref, subjectRef) : null;
          let unit = null, events = { available: has('backend_art_production_events'), complete: false, limit: 32, rows: [] };
          if (row) {
            const binding = parseStored(row.binding_json, '花艺原正常制作单件'), projected = projectQuotaBinding(binding);
            const receipt = row.receipt_json ? parseStored(row.receipt_json, '花艺原正常制作结算') : null;
            const projectedReceipt = fields(receipt, ['version', 'unitRef', 'demandRef', 'parentLifecycleRef', 'recipeFingerprint', 'ordinal',
              'operationId', 'verdict', 'reasonCode', 'postReadRef', 'sourceCostReceiptRef', 'actualCostReceiptRef',
              'originalOutcomeAndResourceFootprintsUnchanged', 'currentEffectsPublished']);
            const { binding_json: _binding, receipt_json: _receipt, ...columns } = row;
            unit = { ...columns, binding: projected, receipt: projectedReceipt,
              bindingIntegrity: { storedFingerprintVerified: digest(binding) === row.binding_fingerprint,
                complete: canonical(binding) === canonical(projected), matchesOperation: binding.operationId === operationId &&
                  sameFields(binding.context, operation.original, contextFields) && canonical(binding.art) === canonical(finitePreparation) &&
                  binding.semanticKey === operation.semantic_key && binding.paramsFingerprint === operation.params_fingerprint &&
                  canonical(binding.targets) === canonical(operation.original.targets) && canonical(binding.resources) === canonical(operation.original.resources) &&
                  canonical(binding.resourceBindings) === canonical(operation.original.resourceBindings) },
              receiptIntegrity: { storedFingerprintVerified: !!receipt && digest(receipt) === row.receipt_fingerprint,
                complete: !!receipt && canonical(receipt) === canonical(projectedReceipt) } };
            const page = bounded('backend_art_production_events', 32, `SELECT event_ref,unit_ref,operation_id,event_kind,payload_json,payload_fingerprint,recorded_at
              FROM backend_art_production_events WHERE unit_ref=? AND operation_id=? ORDER BY recorded_at,event_ref LIMIT ?`, unitRef, operationId);
            events = { ...page, rows: page.rows.map(({ payload_json, ...entry }) => {
              const payload = parseStored(payload_json, '花艺原正常制作事件');
              const projected = fields(payload, ['operationId', 'authorizationRef', 'version', 'unitRef', 'demandRef', 'parentLifecycleRef',
                'recipeFingerprint', 'ordinal', 'verdict', 'reasonCode', 'postReadRef', 'sourceCostReceiptRef', 'actualCostReceiptRef',
                'originalOutcomeAndResourceFootprintsUnchanged', 'currentEffectsPublished']);
              if (Object.hasOwn(payload, 'identity')) projected.identity = fields(payload.identity, ['ownerRef', 'subjectRef', 'parentLifecycleRef', 'recipeFingerprint', 'ordinal']);
              if (Object.hasOwn(payload, 'priorNonSendProof')) projected.priorNonSendProof = payload.priorNonSendProof === null ? null : fields(payload.priorNonSendProof,
                ['kind', 'operationId', 'originalFingerprint', 'evidenceId', 'evidenceFingerprint']);
              return { ...entry, payload: projected, storedFingerprintVerified: digest(payload) === entry.payload_fingerprint,
                eventKeyVerified: entry.event_ref === 'art-production-event:' + digest([entry.unit_ref, entry.operation_id, entry.event_kind, payload]),
                payloadProjectionComplete: canonical(payload) === canonical(projected) };
            }) };
          } else missing.push('art-normal-production-unit');
          domainAudit.productionUnit = { available, present: !!unit, unit, events };
        }
      }
      function addFiniteTarget(settlement) {
        const label = 'target-post-observation:' + settlement.member_key, target = operation.targets.find(one => one.member_key === settlement.member_key)?.original;
        if (auxiliaryFlowerDomain) {
          const result = readOrderFlowerAuxiliaryAuditTarget({ store: backend.store, operation, settlement,
            lease: finiteLease?.lease, landPayloadFingerprint });
          missing.push(...result.missing.map(code => label + ':' + code));
          if (!result.complete && result.missing.length === 0) missing.push(label + ':auxiliary-audit-incomplete');
          targetObservations.push(safe(result, label));
          return;
        }
        const verification = settlement.result?.evidence?.payload, receipt = finiteLease?.receipt, login = receipt?.newLoginSource;
        const bridge = evidence.find(entry => entry.kind === 'after-close-login-post-read' && entry.source === 'backend/write-gateway/v2' &&
          entry.payload?.version === domainAudit.contract && entry.payload.operationId === operationId && entry.payload.leaseRef === finiteLease?.lease?.lease_ref && storedEvidenceValid(entry));
        const firstRewardDomain = finiteDomain === 'art-first-album' || finiteDomain === 'art-first-share';
        const firstRewardProof = verification;
        const firstAlbumProofValid = finiteDomain === 'art-first-album' && firstRewardProof?.operationId === operationId &&
          firstRewardProof?.targetRef === target?.targetRef && firstRewardProof?.artId === finitePreparation?.artId &&
          firstRewardProof?.vaseId === finitePreparation?.vaseId && Number.isSafeInteger(firstRewardProof?.beforeExp) &&
          Number.isSafeInteger(firstRewardProof?.afterExp) && Number.isSafeInteger(firstRewardProof?.experienceGain) &&
          firstRewardProof.afterExp - firstRewardProof.beforeExp === firstRewardProof.experienceGain && firstRewardProof.experienceGain > 0 &&
          firstRewardProof?.writeResponseRef === finiteLease?.receipt?.after?.responseRef &&
          firstRewardProof?.newLoginResponseRef === login?.responseRef &&
          firstRewardProof?.bridgeFingerprint === finiteLease?.lease?.bridge_fingerprint && firstRewardProof?.leaseRef === finiteLease?.lease?.lease_ref;
        const firstShareProofValid = finiteDomain === 'art-first-share' && firstRewardProof?.operationId === operationId &&
          firstRewardProof?.targetRef === target?.targetRef && firstRewardProof?.traceId === operation.original.traceId &&
          firstRewardProof?.artId === finitePreparation?.artId && firstRewardProof?.shareId === 6 &&
          firstRewardProof?.writeResponseRef === finiteLease?.receipt?.after?.responseRef &&
          firstRewardProof?.newLoginResponseRef === login?.responseRef &&
          firstRewardProof?.bridgeFingerprint === finiteLease?.lease?.bridge_fingerprint && firstRewardProof?.leaseRef === finiteLease?.lease?.lease_ref;
        const batchPostReadProof = verification?.postReadProof;
        const batchPostReadValid = finiteDomain === 'art-customer-batch' &&
          batchPostReadProof?.version === 'art-customer-batch/after-close-login/v2' && batchPostReadProof.operationId === operationId &&
          batchPostReadProof.leaseRef === finiteLease?.lease?.lease_ref &&
          batchPostReadProof.bridgeFingerprint === finiteLease?.lease?.bridge_fingerprint &&
          batchPostReadProof.postReadRef === login?.responseRef && batchPostReadProof.newLoginResponseRef === login?.responseRef &&
          batchPostReadProof.newLoginConnectionEpoch === login?.connectionEpoch &&
          batchPostReadProof.newLoginRequestSequence === login?.requestSequence && batchPostReadProof.newLoginWireKey === login?.wireKey &&
          batchPostReadProof.officialUid === login?.officialUid && sameFields(batchPostReadProof.newContext, receipt?.newContext, contextFields) &&
          sameFields(batchPostReadProof.newLogin, login, bindingFields) && sameFields(batchPostReadProof.after, receipt?.after, bindingFields);
        const firstRewardPostReadValid = firstRewardDomain
          ? firstAlbumProofValid || firstShareProofValid
          : finiteDomain === 'art-customer-batch' ? batchPostReadValid && sameFields(verification?.newLogin, login, bindingFields)
            : sameFields(verification?.postRead, login, bindingFields);
        if (!target || !verification || !receipt || !login || finiteLease.validation?.valid !== true || !bridge ||
          bridge.payload.bridgeFingerprint !== finiteLease.lease.bridge_fingerprint || !sameFields(bridge.payload.newContext, receipt.newContext, contextFields) ||
          !sameFields(bridge.payload.newLogin, login, bindingFields) || !firstRewardPostReadValid ||
          ledgerJsonFingerprint(settlement.result) !== settlement.result_fingerprint) { missing.push(label); return; }
        if ((finiteDomain === 'art-daily' || finiteDomain === 'art-customer-batch') && (verification.traceId !== operation.original.traceId ||
            !sameFields(verification.after, receipt.after, bindingFields) || !sameFields(verification.newLogin, login, bindingFields))) {
          missing.push(label + ':art-trace-or-login-binding'); return;
        }
        if (ordinaryFlowerDomain) {
          const result = readOrderFlowerTargetAudit({ store: backend.store, operation, preparation: finitePreparation,
            settlement, receipt, lease: finiteLease.lease, bridgeEvidence: bridge, landPayloadFingerprint });
          missing.push(...result.missing);
          if (result.observation) targetObservations.push(safe(result.observation, label));
          return;
        }
        const next = receipt.newContext;
        const customer = has('backend_customer_observations') ? get(`SELECT observation_ref,owner_epoch,run_epoch,connection_epoch,request_sequence,wire_key,
          response_ref,payload_fingerprint,accepted,reason_code,frame_json,recorded_at FROM backend_customer_observations
          WHERE owner_ref=? AND account_ref=? AND subject_ref=? AND owner_epoch=? AND run_epoch=? AND connection_epoch=?
          AND request_sequence=? AND wire_key=? AND response_ref=? AND source_kind='response' AND method='index.login'`,
        ownerRef, operation.account_ref, subjectRef, next.ownerEpoch, next.runEpoch, next.connectionEpoch, login.requestSequence, login.wireKey, login.responseRef) : null;
        const land = observationsAvailable ? get(`SELECT observation_ref,connection_epoch,request_sequence,wire_key,response_ref,payload_fingerprint,accepted,reason_code,frame_json,recorded_at
          FROM backend_land_domain_observations WHERE owner_ref=? AND account_ref=? AND subject_ref=? AND connection_epoch=? AND request_sequence=? AND wire_key=? AND response_ref=?`,
        ownerRef, operation.account_ref, subjectRef, next.connectionEpoch, login.requestSequence, login.wireKey, login.responseRef) : null;
        const hasLandCompatibility = finiteDomain === 'art-daily' || finiteDomain === 'art-customer-batch' || firstRewardDomain ||
          finiteDomain === 'customer' || finiteDomain === 'customer-reject' || finiteDomain === 'customer-generation';
        const customerCompatibility = hasLandCompatibility ? resolveAcceptedCustomerObservationEvidence({ store: backend.store,
          context: next, requestSequence: login.requestSequence, responseRef: login.responseRef }) : null;
        const customerFrame = customerCompatibility?.accepted === true ? customerCompatibility.frame :
          customer ? parseStored(customer.frame_json, '有限目标新登录来源') : null;
        const landSource = land ? parseStored(land.frame_json, '有限目标新登录物品来源')?.source : null;
        const landCompatibility = hasLandCompatibility && land ? resolveAcceptedLandObservationEvidence({ store: backend.store,
          context: next, observationRef: land.observation_ref, source: landSource }) : null;
        const landFrame = landCompatibility?.accepted === true ? landCompatibility.frame :
          land ? parseStored(land.frame_json, '有限目标新登录物品来源') : null;
        const derivedLandFingerprint = landPayloadFingerprint(landFrame);
        if (!customer || (hasLandCompatibility ? customerCompatibility?.accepted !== true : customer.accepted !== 1) ||
          !customerFrame?.admissible || !sameFields(customerFrame.context, next, contextFields) ||
          !sameFields(customerFrame.source, login, bindingFields) || digest(customerFrame.payload) !== customer.payload_fingerprint ||
          !land || (hasLandCompatibility ? landCompatibility?.accepted !== true : land.accepted !== 1) ||
          !landFrame?.admissible || !sameFields(landFrame.context, next, contextFields) ||
          !sameFields(landFrame.source, login, bindingFields) || landFrame.source.method !== 'index.login') { missing.push(label); return; }
        if (derivedLandFingerprint === null || derivedLandFingerprint !== land.payload_fingerprint) missing.push(label + ':item-source-payload-hash');
        const itemIds = finiteDomain === 'customer-generation' || finiteDomain === 'art-first-album' ? [] :
          finiteDomain === 'art-first-share' ? [7] : customerTargetDomain ? [finitePreparation?.artId, 1002]
          : [...new Set([...(finitePreparation?.flowersIds || []), finitePreparation?.artId])];
        if (!['customer-generation', 'art-first-album'].includes(finiteDomain) && !itemIds.length || itemIds.length > 8 || itemIds.some(id => !Number.isSafeInteger(id) || id <= 0)) { missing.push(label); return; }
        const bag = landFrame.bag, bagComplete = bag?.presence === 'present' && bag.state === 'known' && landFrame.coverage?.bagComplete === true;
        const itemValues = itemIds.map(itemId => ({ itemId, cell: cell(bag?.items?.[itemId]),
          missingKeyProvenZero: bagComplete && !Object.hasOwn(bag.items || {}, String(itemId)) }));
        const knownCell = value => value?.presence === 'present' && value.state === 'known';
        if (!bagComplete || !knownCell(landFrame.profile?.uid) || landFrame.profile.uid.value !== receipt.officialUid ||
          !knownCell(customerFrame.payload.profileUid) || customerFrame.payload.profileUid.value !== receipt.officialUid ||
          itemValues.some(one => !one.missingKeyProvenZero && (!knownCell(one.cell) || !Number.isSafeInteger(one.cell.value) || one.cell.value < 0))) {
          missing.push(label); return;
        }
        const out = { kind: 'after-close-login', domain: finiteDomain, memberKey: settlement.member_key, target: fields(target,
          ['memberKey', 'targetKind', 'targetRef', 'lifecycleRef', 'targetFingerprint']), leaseRef: finiteLease.lease.lease_ref,
          bridgeFingerprint: finiteLease.lease.bridge_fingerprint, officialUid: receipt.officialUid,
          originalContext: fields(receipt.originalContext, contextFields), newContext: fields(next, contextFields), write: fields(receipt.after, bindingFields),
          newLogin: finiteSource(login), physicalClose: physicalClose(receipt.oldPhysicalCloseReceipt),
          bridgeEvidenceId: bridge.evidence_id, bridgeEvidenceFingerprint: bridge.payload_fingerprint,
          settlementRef: settlement.settlement_key, settlementFingerprint: settlement.result_fingerprint,
          customerObservation: { observationRef: customer.observation_ref, source: finiteSource(customerFrame.source),
            payloadFingerprint: customer.payload_fingerprint, storedFingerprintVerified: digest(customerFrame.payload) === customer.payload_fingerprint,
            accepted: true, recordedAt: customer.recorded_at },
          itemObservation: { observationRef: land.observation_ref, source: finiteSource(landFrame.source), accepted: true, recordedAt: land.recorded_at,
            payloadFingerprint: land.payload_fingerprint, derivedPayloadFingerprint: derivedLandFingerprint,
            storedFingerprintVerified: derivedLandFingerprint === land.payload_fingerprint,
            payloadHashContract: 'backend-land-domain/semantic-observation-v1',
            uid: cell(landFrame.profile?.uid), bag: { map: fields(bag, ['presence', 'state', 'sourceRef', 'reasonCode']), providedComplete: bagComplete, items: itemValues } } };
        if (finiteDomain === 'customer-generation') {
          const payload = customerFrame.payload, map = payload.orderMap, stock = payload.orderStockList, counter = payload.eligibilityInputs?.count107;
          const completeMap = map?.presence === 'present' && map.state === 'known' && map.sourceProvidedMapComplete === true &&
            map.decodedComplete === true && Array.isArray(map.entries) && map.total === map.entries.length && map.entries.every(one => one.readable === true);
          const completeStock = stock?.presence === 'present' && stock.state === 'known' && stock.sourceProvidedListComplete === true &&
            stock.decodedComplete === true && Array.isArray(stock.entries) && stock.total === stock.entries.length && stock.entries.every(one => one.readable === true);
          const orderFields = ['dialogId', 'artId', 'num', 'pathId', 'cTime'];
          const projectOrder = one => ({ npcId: one.npcId, fields: Object.fromEntries(orderFields.map(key => [key, cell(one.fields?.[key])])) });
          const bagValues = Object.entries(bag.items || {}), bagValuesKnown = bagValues.every(([id, one]) => /^[1-9]\d*$/.test(id) && knownCell(one) && Number.isSafeInteger(one.value) && one.value >= 0);
          const positiveBag = bagValuesKnown ? Object.fromEntries(bagValues.filter(([, one]) => one.value > 0).map(([id, one]) => [id, one.value])) : null;
          const counterKeys = ['domain', 'uid', 'type', 'tdyCnt', 'totCnt', 'rTime'];
          const counterKnown = counterKeys.every(key => knownCell(counter?.[key])) && counter.uid.value === receipt.officialUid && counter.type.value === 107;
          const profileKnown = knownCell(landFrame.profile?.gold) && knownCell(landFrame.profile?.yuanbao);
          out.generation = { businessFingerprint: finitePreparation.businessFingerprint,
            day: fields(finitePreparation.day, ['known', 'key', 'startMs', 'endMs', 'utcOffsetMinutes', 'proofRef', 'reasonCode']),
            beforeBoard: finitePreparation.beforeBoard, beforeStock: finitePreparation.beforeStock, beforeCount: finitePreparation.beforeCount,
            orderMap: fields(map, ['presence', 'state', 'total', 'sourceProvidedMapComplete', 'decodedComplete']),
            orderStockList: fields(stock, ['presence', 'state', 'total', 'sourceProvidedListComplete', 'decodedComplete']),
            board: completeMap ? map.entries.slice(0, 9).map(projectOrder) : [], boardProjectionComplete: completeMap && map.total <= 9,
            stock: completeStock ? stock.entries.slice(0, 32).map(projectOrder) : [], stockProjectionComplete: completeStock && stock.total <= 32,
            count107: Object.fromEntries(counterKeys.map(key => [key, cell(counter?.[key])])),
            gold: cell(landFrame.profile?.gold), yb: cell(landFrame.profile?.yuanbao),
            absoluteBag: { known: bagValuesKnown, fingerprint: positiveBag ? digest(positiveBag) : null,
              positiveItemCount: positiveBag ? Object.keys(positiveBag).length : null, rule: 'complete-absolute-bag-positive-integer-counts/zero-and-missing-equivalent/v1' },
            targetEffect: operation.business_verdict === 'confirmed' && Array.isArray(verification.orders?.addedBoard)
              ? { source: 'derived-from-persisted-confirmed-order-verification', kind: 'new-orders-original-board-preserved',
                addedBoardCount: verification.orders.addedBoard.length, addedStockCount: verification.orders.stock?.total ?? null } : null,
            accounting: verification.accounting, orders: verification.orders, costs: verification.costs };
          if (!completeMap || !completeStock || !counterKnown || !bagValuesKnown || !profileKnown || !knownCell(payload.uid) ||
              payload.uid.value !== receipt.officialUid || !knownCell(payload.domain) || !knownCell(payload.customer)) { missing.push(label); return; }
          if (!out.generation.boardProjectionComplete) missing.push(label + ':board-projection-limit');
          if (!out.generation.stockProjectionComplete) missing.push(label + ':stock-projection-limit');
        } else if (customerTargetDomain) {
          const payload = customerFrame.payload, map = payload.orderMap, order = map?.entries?.find(one => one.npcId === finitePreparation.npcId);
          const mapComplete = map?.presence === 'present' && map.state === 'known' && map.sourceProvidedMapComplete === true && Array.isArray(map.entries) && map.total === map.entries.length;
          out.customer = { uid: cell(payload.uid), profileUid: cell(payload.profileUid), domain: cell(payload.domain), own: cell(payload.customer),
            orderMap: fields(map, ['presence', 'state', 'total', 'sourceProvidedMapComplete', 'decodedComplete', 'reportedEmpty', 'coverageKind']),
            completeProvidedMap: mapComplete, originalNpcId: finitePreparation.npcId, targetAbsentProven: mapComplete && !order,
            targetOrder: order ? { ...fields(order, ['npcId', 'presence', 'state', 'readable', 'contentFingerprint', 'fingerprintKind', 'reasonCode']),
              fields: Object.fromEntries(['dialogId', 'artId', 'num', 'pathId', 'cTime'].map(key => [key, cell(order.fields?.[key])])) } : null,
            targetEffect: fields(verification.targetEffect, ['kind', 'npcId', 'originalLifecycleRef', 'originalContentFingerprint']),
            beforeOrder: fields(verification.beforeOrder, ['npcId', 'dialogId', 'artId', 'num', 'pathId', 'cTime']),
            afterOrder: verification.afterOrder ? fields(verification.afterOrder, ['npcId', 'dialogId', 'artId', 'num', 'pathId', 'cTime']) : null };
          if (!mapComplete || !knownCell(payload.domain) || !knownCell(payload.customer) || !knownCell(payload.uid) ||
            payload.uid.value !== receipt.officialUid) { missing.push(label); return; }
          if (finiteDomain === 'customer-reject') {
            const initialItems = finitePreparation.beforeItems, initialProfile = finitePreparation.beforeProfile;
            const itemBalances = itemValues.map(one => {
              const initial = Array.isArray(initialItems) ? initialItems.find(item => item.itemId === one.itemId) : null;
              return { itemId: one.itemId, before: initial?.quantity ?? null,
                after: one.missingKeyProvenZero ? 0 : one.cell?.value ?? null,
                beforeBasisRef: initial?.basisRef ?? null, beforeSource: finiteSource(initial?.source), afterSource: finiteSource(landFrame.source) };
            });
            const profileKnown = knownCell(landFrame.profile?.gold) && knownCell(landFrame.profile?.yuanbao);
            const currencies = { beforeGold: initialProfile?.gold ?? null, afterGold: profileKnown ? landFrame.profile.gold.value : null,
              beforeYb: initialProfile?.yb ?? null, afterYb: profileKnown ? landFrame.profile.yuanbao.value : null,
              beforeSource: finiteSource(initialProfile?.source), afterSource: finiteSource(landFrame.source) };
            const unchanged = itemBalances.every(one => Number.isSafeInteger(one.before) && one.before >= 0 && one.after === one.before) &&
              Number.isSafeInteger(currencies.beforeGold) && currencies.beforeGold >= 0 && currencies.afterGold === currencies.beforeGold &&
              Number.isSafeInteger(currencies.beforeYb) && currencies.beforeYb >= 0 && currencies.afterYb === currencies.beforeYb;
            out.customer.rejection = { filteredDecisionRef: finitePreparation.filteredDecisionRef ?? null,
              acceptedDecisionRef: finitePreparation.acceptedDecisionRef ?? null, cause: finitePreparation.rejectCause ?? null,
              policyFingerprint: finitePreparation.policyFingerprint ?? null,
              policy: fields(operation.factBasis?.policy, ['enabled', 'coinTiers', 'autoReject', 'featureCancelEpoch']),
              balances: { items: itemBalances, currencies }, observedBalancesUnchanged: unchanged,
              noDeliveryInferredFromMissingFlow: false, originalResourceReservations: operation.resources.length };
            if (!unchanged) { missing.push(label + ':reject-balances'); return; }
          }
        } else if (finiteDomain === 'art-first-album' || finiteDomain === 'art-first-share') {
          const inputs = customerFrame.payload.artEligibilityInputs, flower = inputs?.flowerArt, collect = inputs?.collectRwd,
            shareTotal = inputs?.shareTot, history = finiteDomain === 'art-first-album' ? collect?.artCreateRwdList : flower?.sRecvList,
            rawClaimMap = collect?.map, type13Present = rawClaimMap?.sourceProvidedMapComplete === true &&
              Array.isArray(rawClaimMap.value?.keys) && rawClaimMap.value.keys.includes(13),
            albumDefaultEmpty = finiteDomain === 'art-first-album' && knownCell(collect?.domain) && knownCell(rawClaimMap) &&
              rawClaimMap.sourceProvidedMapComplete === true && rawClaimMap.decodedComplete === true && history?.presence === 'missing' &&
              (!type13Present || knownCell(collect?.uid) && collect.uid.value === receipt.officialUid),
            shareDefaultEmpty = finiteDomain === 'art-first-share' && knownCell(flower?.domain) && knownCell(flower?.uid) &&
              flower.uid.value === receipt.officialUid && knownCell(flower?.makeList) && flower.makeList.value?.length >= 0 &&
              history?.presence === 'missing',
            historyEntries = history?.presence === 'present' && history.state === 'known' && Array.isArray(history.value)
              ? history.value : albumDefaultEmpty || shareDefaultEmpty ? [] : null,
            albumExperienceDefault = finiteDomain === 'art-first-album' && knownCell(collect?.domain) && knownCell(rawClaimMap) &&
              rawClaimMap.sourceProvidedMapComplete === true && rawClaimMap.decodedComplete === true && !type13Present,
            albumExperienceProvided = finiteDomain === 'art-first-album' && type13Present && knownCell(collect?.uid) &&
              collect.uid.value === receipt.officialUid && knownCell(collect?.exp),
            exp = finiteDomain === 'art-first-album'
              ? albumExperienceProvided ? { ...collect.exp, sourceRef: customerFrame.source.responseRef }
                : albumExperienceDefault ? { presence: 'present', state: 'known', value: 0, sourceRef: customerFrame.source.responseRef,
                  derivedDefault: true, derivationRule: 'official-current-complete-103-map-without-type13-getMb(13)?.exp||0' }
                  : collect?.exp || { presence: 'missing', state: 'unobserved', value: null, reasonCode: 'COLLECT_RWD_13_EXP_NOT_CURRENT' }
              : flower?.exp,
            quotaRow = shareTotal?.map?.entries?.['6'];
          const rewardFields = ['operationId', 'featureId', 'artId', 'vaseId', 'claimArtIds', 'claimSetFingerprint', 'shareRoute',
            'beforeExp', 'beforeShareRow', 'beforeShareBalances', 'sourceRefs', 'loginResponseRef', 'versionEvidence', 'dataSnapshotId',
            'extension', 'extensionRef'];
          out.art = { firstReward: { preparation: fields(finitePreparation, rewardFields),
            source: finiteSource(customerFrame.source), loginSource: finiteSource(login),
            vaseMap: fields(inputs?.vases?.map, ['presence', 'state', 'total', 'sourceProvidedMapComplete', 'decodedComplete']),
            madeArts: fields(flower?.makeList, ['presence', 'state', 'sourceProvidedListComplete', 'decodedComplete']),
            collectDomain: fields(collect?.domain, ['presence', 'state', 'sourceRef']), collectMap: fields(collect?.map,
              ['presence', 'state', 'total', 'sourceProvidedMapComplete', 'decodedComplete']),
            claimHistory: { presence: historyEntries && history?.presence !== 'present' ? 'derived' : history?.presence ?? 'missing',
              state: historyEntries ? 'known' : history?.state ?? 'unobserved', defaultEmpty: albumDefaultEmpty || shareDefaultEmpty,
              source: finiteSource(history?.source || (albumDefaultEmpty ? rawClaimMap?.source : shareDefaultEmpty ? flower?.makeList?.source : null)),
              total: historyEntries?.length ?? null,
              valuesFingerprint: historyEntries ? digest(historyEntries) : null,
              targetClaimed: historyEntries ? historyEntries.includes(finitePreparation?.artId) : null,
              claimedIds: historyEntries ? historyEntries.filter(Number.isSafeInteger) : null },
            experience: { ...cell(exp), source: finiteSource(customerFrame.source), sourceField: finiteDomain === 'art-first-album' ? '103.0.13.3' : '106.0.1',
              derivedDefault: exp?.derivedDefault === true, derivationRule: exp?.derivationRule || null }, shareDomain: fields(shareTotal?.domain, ['presence', 'state', 'sourceRef']),
            shareMap: fields(shareTotal?.map, ['presence', 'state', 'total', 'sourceProvidedMapComplete', 'decodedComplete']),
            share6: quotaRow ? { presence: quotaRow.presence, state: quotaRow.state, value: fields(quotaRow.value,
              ['uid', 'tmpId', 'shareCnt', 'recvCnt', 'recvTime', 'totCnt', 'uTime', 'cTime']) } : null,
            profile: { gold: cell(landFrame.profile?.gold), yuanbao: cell(landFrame.profile?.yuanbao) },
            bag: { complete: bagComplete, items: itemValues.map(one => ({ itemId: one.itemId, cell: one.cell,
              missingKeyProvenZero: one.missingKeyProvenZero })) },
            verification: fields(verification, ['verdict', 'reasonCode', 'verificationVersion', 'evidence', 'resourceResolutions']) } };
          const profileKnown = knownCell(landFrame.profile?.gold) && knownCell(landFrame.profile?.yuanbao);
          if (!knownCell(inputs?.flowerArt?.uid) || inputs.flowerArt.uid.value !== receipt.officialUid || !profileKnown ||
              finiteDomain === 'art-first-album' && (!historyEntries || !knownCell(exp)) ||
              finiteDomain === 'art-first-share' && (!historyEntries || !shareTotal?.map?.sourceProvidedMapComplete || !bagComplete ||
                !knownCell(landFrame.bag?.items?.['7']) && !itemValues[0]?.missingKeyProvenZero)) {
            missing.push(label + ':first-reward-source-projection'); return;
          }
        } else {
          const inputs = customerFrame.payload.artEligibilityInputs, map = inputs?.vases?.map, vaseId = finitePreparation.vaseId;
          const vase = map?.entries?.find(one => one.vaseId === vaseId), makeList = inputs?.flowerArt?.makeList;
          const list = makeList?.presence === 'present' && makeList.state === 'known' && Array.isArray(makeList.value) ? makeList.value : null;
          out.art = { ...fields(finitePreparation, ['artId', 'recipeFingerprint', 'parentLifecycleRef', 'demandRef', 'unitRef']),
            gold: cell(landFrame.profile?.gold), yb: cell(landFrame.profile?.yuanbao),
            vaseMap: fields(map, ['presence', 'state', 'total', 'sourceProvidedMapComplete', 'decodedComplete']),
            vase: vase ? { ...fields(vase, ['vaseId', 'presence', 'state', 'readable', 'reasonCode']),
              fields: Object.fromEntries(['uid', 'vaseId', 'uTime', 'cTime'].map(key => [key, cell(vase.fields?.[key])])) } : null,
            ownArtUid: cell(inputs?.flowerArt?.uid), makeHistory: { ...fields(makeList, ['presence', 'state', 'reasonCode']),
              total: list?.length ?? null, containsArt: list ? list.includes(finitePreparation.artId) : null,
              valuesFingerprint: list ? digest(list) : null, meaning: 'first-make-history-not-product-quantity' },
            observedCostReceipt: costReceipt(verification.observedCostReceipt) };
          if (finiteDomain === 'art-daily') {
            const dailyFields = ['operationId', 'traceId', 'targetRef', 'recipeFingerprint', 'unitRef', 'dayKey', 'writeResponseRef', 'after', 'newLogin', 'postRead', 'postReadRef',
              'bridgeFingerprint', 'dailyDataSnapshotId', 'postDataSnapshotId', 'postLoginResponseRef', 'postVersionEvidence', 'postRowProof',
              'postCatalogSource', 'beforeProfile', 'afterProfile', 'costContract', 'currencyFlows', 'flows', 'deltas', 'resourceResolutions'];
            out.art.dailyVerification = fields(verification, dailyFields);
            if (out.art.dailyVerification.postRead) out.art.dailyVerification.postRead = fields(out.art.dailyVerification.postRead, bindingFields);
          }
          if (finiteDomain === 'art-customer-batch') {
            const batchFields = ['operationId', 'traceId', 'targetRef', 'parentLifecycleRef', 'parentDecisionRef', 'batchQuantity', 'artId',
              'recipeFingerprint', 'writeResponseRef', 'after', 'newLogin', 'postReadRef', 'bridgeFingerprint', 'sourceSnapshotRef',
              'postDataSnapshotId', 'postVersionEvidence', 'postRecipeSource', 'postRowProof', 'beforeProduct', 'beforeProfile',
              'afterProfile', 'inputBalances', 'currencyFlows', 'flows', 'deltas', 'postReadProof'];
            out.art.customerBatchVerification = fields(verification, batchFields);
            if (out.art.customerBatchVerification.newLogin) out.art.customerBatchVerification.newLogin = fields(out.art.customerBatchVerification.newLogin, bindingFields);
          }
          if (!vase || !['uid', 'vaseId', 'uTime', 'cTime'].every(key => knownCell(vase.fields?.[key])) ||
            vase.fields.uid.value !== receipt.officialUid || vase.fields.vaseId.value !== vaseId ||
            !knownCell(inputs?.flowerArt?.uid) || inputs.flowerArt.uid.value !== receipt.officialUid || !list ||
            !knownCell(landFrame.profile?.gold) || !knownCell(landFrame.profile?.yuanbao)) { missing.push(label); return; }
        }
        targetObservations.push(safe(out, label));
      }
      for (const settlement of operation.targetSettlements.slice(0, observationLimit)) {
        if (finiteDomain) { addFiniteTarget(settlement); continue; }
        if (waterwheelOperation || freeWaterOperation || flowerRackOperation) continue;
        const verification = settlement.result?.evidence?.payload, after = verification?.after?.source;
        addItemSource(verification?.postRead, 'item7-post-source:' + settlement.member_key);
        const target = operation.targets.find(entry => entry.member_key === settlement.member_key)?.original;
        const landId = Number(String(target?.targetRef || '').split(':').at(-1));
        const label = 'target-post-observation:' + settlement.member_key;
        const observationKey = canonical([after?.observationRef ?? null, Number.isSafeInteger(landId) ? landId : null]);
        if (!after?.observationRef || observationRefs.has(observationKey)) { if (!after?.observationRef) missing.push(label); continue; }
        observationRefs.add(observationKey);
        if (!observationsAvailable || after.connectionEpoch !== operation.connection_epoch || !Number.isSafeInteger(landId) || landId <= 0 ||
          !Number.isSafeInteger(after.requestSequence) || typeof after.responseRef !== 'string' || typeof after.wireKey !== 'string') { missing.push(label); continue; }
        const found = get(`SELECT observation_ref,account_ref,connection_epoch,request_sequence,wire_key,response_ref,payload_fingerprint,
          accepted,reason_code,frame_json,recorded_at FROM backend_land_domain_observations WHERE observation_ref=? AND owner_ref=? AND account_ref=? AND subject_ref=?
          AND connection_epoch=? AND request_sequence=? AND response_ref=? AND wire_key=?`, after.observationRef, ownerRef, operation.account_ref, subjectRef,
        operation.connection_epoch, after.requestSequence, after.responseRef, after.wireKey);
        if (!found) { missing.push(label); continue; }
        const frame = parseStored(found.frame_json, '目标后读来源');
        const land = value => value ? { ...fields(value, ['valid', 'removed', 'explicitEmptyObject', 'sourceRef', 'reasonCode']),
          fields: Object.fromEntries(['flowerId', 'state', 'harvestCnt', 'plantTime', 'nextTime'].map(key => [key, cell(value.fields?.[key])])) } : null;
        targetObservations.push(safe({ observationRef: found.observation_ref, accountRef: found.account_ref, connectionEpoch: found.connection_epoch,
          requestSequence: found.request_sequence, wireKey: found.wire_key, responseRef: found.response_ref, payloadFingerprint: found.payload_fingerprint,
          accepted: found.accepted === 1, reasonCode: found.reason_code, recordedAt: found.recorded_at, source: fields(frame.source, sourceFields), landId,
          coverage: fields(frame.coverage, ['landMapComplete', 'evidenceRef']),
          landBase: { map: fields(frame.landBase, ['presence', 'state', 'sourceRef', 'reasonCode']), target: land(frame.landBase?.value?.[landId]) },
          landChanges: { map: fields(frame.landChanges, ['presence', 'state', 'sourceRef', 'reasonCode']), target: land(frame.landChanges?.value?.[landId]) } }, label));
      }
      for (const entry of coverage) if (entry.evidence.itemId === 7 && typeof entry.evidence.absoluteSourceRef === 'string') addItemSource(null, 'item7-coverage-source:' + entry.coverage_key, entry.evidence.absoluteSourceRef);
      const candidateFingerprint = digest({ semanticKey: operation.semantic_key, paramsFingerprint: operation.params_fingerprint,
        targets: operation.original.targets, factBasis: operation.factBasis });
      const factBasisJson = canonical(operation.factBasis), ledgerFactBasisJson = serializeLedgerJson(operation.factBasis), candidateNeedle = '"candidateFingerprint":' + JSON.stringify(candidateFingerprint);
      const laterAdmissionNeedle = '"version":"order-flower/later-generation-after-exact-closed-execution/v1"';
      const currentNeedAdmissionNeedle = '"version":"order-flower/current-need-after-exact-closed-execution/v1"';
      const basisPage = bounded('backend_admission_basis', 64, `SELECT a.basis_id,a.operation_id,a.subject_ref,a.constraint_key,a.basis_key,a.conclusion,
        a.operation_revision,a.fact_basis_json,a.affected_json,a.evidence_json,a.reason_code,a.recorded_at,o.original_fingerprint,
        o.original_json AS referenced_original_json
        FROM backend_admission_basis a JOIN backend_operations o ON o.operation_id=a.operation_id
        WHERE o.owner_ref=? AND a.subject_ref=? AND o.subject_ref=? AND a.fact_basis_json=? AND
        (instr(a.affected_json,?)>0 OR (?=1 AND instr(a.affected_json,'"candidateFingerprint":')=0 AND
          (instr(a.evidence_json,?)>0 OR instr(a.evidence_json,?)>0)))
        ORDER BY a.basis_id LIMIT ?`,
      ownerRef, subjectRef, subjectRef, ledgerFactBasisJson, candidateNeedle, ordinaryFlowerDomain ? 1 : 0,
      laterAdmissionNeedle, currentNeedAdmissionNeedle);
      const legacyBasisPage = bounded('backend_legacy_admission_basis', 64, `SELECT b.basis_id,b.basis_key,b.constraint_ref,b.source_fingerprint,b.conclusion,
        b.fact_basis_json,b.fact_basis_fingerprint,b.affected_json,b.evidence_json,b.reason_code,b.recorded_at,
        COALESCE(c.operation_ref,l.operation_ref) AS original_operation_ref,COALESCE(c.transfer_id,l.transfer_id) AS transfer_id,
        COALESCE(c.archive_id,l.archive_id) AS archive_id,l.source_fingerprint AS operation_source_fingerprint,l.source_origin_key
        FROM backend_legacy_admission_basis b LEFT JOIN backend_legacy_constraint_index c ON c.constraint_ref=b.constraint_ref AND c.owner_ref=b.owner_ref AND c.subject_ref=b.subject_ref
        LEFT JOIN backend_legacy_operation_index l ON l.operation_ref=COALESCE(c.operation_ref,b.constraint_ref) AND l.owner_ref=b.owner_ref AND l.subject_ref=b.subject_ref
        WHERE b.owner_ref=? AND b.subject_ref=? AND b.fact_basis_fingerprint=? AND b.fact_basis_json=? AND instr(b.affected_json,?)>0 ORDER BY b.basis_id LIMIT ?`,
      ownerRef, subjectRef, digest(operation.factBasis), factBasisJson, candidateNeedle);
      function basisEvidence(value) {
        const out = fields(value, ['version', 'isolationReceiptRef', 'isolationReceiptHash', 'transition', 'originalOutcomeUnchanged', 'originalResourceCoverageUnchanged',
          'resourceCoverageProven', 'originalResourceFootprintUnchanged', 'budgetAccountingVersion', 'available', 'previousResultUnchanged', 'isolationReasonCode']);
        if (value.currentCheckpoint) out.currentCheckpoint = fields(value.currentCheckpoint, ['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch',
          'executorRef', 'source', 'uid', 'serverId', 'requestSequence', 'responseRef', 'wireKey', 'receivedDeviceMs', 'receivedMonotonicMs', 'serverRespondedMs',
          'observedAt', 'identityRef', 'accountVerificationRef', 'verificationRef']);
        if (value.previousExecution) out.previousExecution = fields(value.previousExecution, ['kind', 'closed', 'executionClosed', 'operationRequestEnded', 'requestTerminated',
          'ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch', 'executorRef', 'method', 'requestSequence', 'wireKey', 'responseRef',
          'receivedDeviceMs', 'targetSettlementRef',
          'evidenceRef', 'evidenceHash', 'sourceRef', 'closureRef', 'closeEvidenceCode', 'closedAt', 'recordedAt', 'transferId', 'sessionId', 'originalTransferId',
          'originalSessionId', 'envelopeFingerprint', 'payloadFingerprint', 'sourceOwnerFingerprint', 'sourceAppId', 'sourceCloudRef', 'sourceInstallId',
          'installBindingRef', 'sourceSignerFingerprint', 'sourceDescriptorFingerprint', 'pairingRef', 'sourceFenceRef', 'sourceStopEvidenceRef', 'fencedAt',
          'importCompletedAt', 'sourceSignatureVerification', 'signatureReverifiedDuringRead', 'timeBasis', 'verificationRef']);
        if (value.original) {
          out.original = fields(value.original, [...originalFields, 'kind', 'originalFingerprint', 'operationRef', 'transferId', 'archiveId', 'sourceFingerprint',
            'sourceOperationId', 'sourceOriginKey', 'sourceSubjectRef', 'sourceVersion', 'preparedAt', 'sourceExportedAt', 'transportState', 'businessVerdict', 'writeSlot']);
          const meta = value.original.lifecycleTargetMetadata;
          if (meta) out.original.lifecycleTargetMetadata = { ...fields(meta, ['declaredTargetRef', 'originalDetailsAvailable', 'preparedAt', 'sourceExportedAt']),
            targetBasis: meta.targetBasis ? fields(meta.targetBasis, targetFields) : null,
            targets: (meta.targets || []).map(target => fields(target, [...targetFields, 'memberKey', 'targetKind', 'targetRef', 'targetFingerprint', 'phase'])),
            targetFactsConflictLandIds: meta.targetFactsConflictLandIds || [] };
        }
        if (value.currentTarget) out.currentTarget = { ...fields(value.currentTarget, [...targetFields, 'explicitEmptyObject', 'needWaterStageRef', 'harvestStageRef']), source: fields(value.currentTarget.source, sourceFields) };
        if (value.retainedResource) out.retainedResource = fields(value.retainedResource, ['operationId', 'resourceKey', 'resourceRef', 'quantity', 'unreflectedQuantity',
          'coveredQuantity', 'state', 'constraintRefs', 'sourceFingerprints', 'sourceInstallId', 'sourceSignerFingerprint', 'transfers']);
        return out;
      }
      function projectBases(page, label) {
        return page.rows.flatMap(({ fact_basis_json, affected_json, evidence_json, referenced_original_json, ...entry }) => {
          const affected = parseStored(affected_json, '候选准入范围');
          const proof = parseStored(evidence_json, '候选准入依据');
          if (affected.candidateFingerprint !== candidateFingerprint) {
            if (label !== 'backendBasis' || !ordinaryFlowerDomain || Object.hasOwn(affected, 'candidateFingerprint')) return [];
            const associated = proof.version === 'order-flower/current-need-after-exact-closed-execution/v1'
              ? projectOrderFlowerCurrentNeedAdmission({ store: backend.store, operation, basisRow: entry, affected, evidence: proof,
                referenceOriginalJson: referenced_original_json, referenceOriginalFingerprint: entry.original_fingerprint })
              : projectOrderFlowerLaterAdmission({ store: backend.store, operation, preparation: finitePreparation,
                basisRow: entry, factBasis: parseStored(fact_basis_json, '三订单有限候选事实'), affected, evidence: proof,
                referenceOriginalJson: referenced_original_json, referenceOriginalFingerprint: entry.original_fingerprint });
            if (!associated.associated) { missing.push(label + ':finite-association:' + entry.basis_id + ':' + associated.reasonCode); return []; }
            if (!associated.complete) missing.push(label + ':finite-projection:' + entry.basis_id);
            return [safe({ ...entry, factBasis: parseStored(fact_basis_json, '候选准入事实'), affected: associated.affected,
              associationVerified: true, associationContract: associated.associationContract, projectionComplete: associated.complete,
              evidenceFingerprint: digest(proof), evidenceProjectionComplete: canonical(associated.evidence) === canonical(proof),
              evidence: associated.evidence }, label + ':' + entry.basis_id)];
          }
          const projectedProof = basisEvidence(proof);
          return [safe({ ...entry, factBasis: parseStored(fact_basis_json, '候选准入事实'),
            affected: fields(affected, ['candidateFingerprint', 'constraintRef', 'targetRef', 'lifecycleRef', 'rawTargetRefs', 'rawResourceKeys']),
            evidenceFingerprint: digest(proof), evidenceProjectionComplete: canonical(projectedProof) === canonical(proof), evidence: projectedProof }, label + ':' + entry.basis_id)];
        });
      }
      const groupRef = typeof operation.factBasis?.groupRef === 'string' ? operation.factBasis.groupRef : null;
      const groupPage = groupRef ? bounded('backend_land_group_receipts', 128, `SELECT receipt_ref,group_ref,kind,payload_json,recorded_at
        FROM backend_land_group_receipts WHERE owner_ref=? AND subject_ref=? AND group_ref=? ORDER BY recorded_at,receipt_ref LIMIT ?`, ownerRef, subjectRef, groupRef)
        : { available: has('backend_land_group_receipts'), complete: true, limit: 128, rows: [] };
      const retiredGroupDetails = groupRef && has('backend_land_group_history_totals') ? backend.store.get(`SELECT retired_count
        FROM backend_land_group_history_totals WHERE owner_ref=? AND subject_ref=? AND group_ref=?`, ownerRef, subjectRef, groupRef)?.retired_count || 0 : 0;
      if (retiredGroupDetails > 0) groupPage.complete = false;
      const groupReceipts = groupPage.rows.map(({ payload_json, ...entry }) => {
        const payload = parseStored(payload_json, '原土地组回执'), document = payload.document;
        const out = fields(payload, ['revision', 'documentFingerprint', 'operationId', 'settlementRef', 'featureId', 'verdict', 'reasonCode', 'postReadRef',
          'memberKey', 'landId', 'originalMemberState', 'originalRoundRef', 'originalRoundDenominator']);
        if (document) {
          out.document = fields(document, ['groupRef', 'flowerId', 'capacity', 'configRevision', 'pendingConfigRevision', 'state', 'layoutBasis', 'adoption']);
          out.document.members = (document.members || []).map(member => ({ ...fields(member, ['memberKey', 'landId', 'cropRef', 'emptyRef', 'operationId', 'proposalId',
            'state', 'reasonCode', 'predictedYield', 'maturityGuardRequired', 'currentUnknownOperationId', 'currentUnknownFeature']),
          ...(member.currentBinding ? { currentBinding: fields(member.currentBinding, ['state', 'receiptRef', 'operationId', 'currentStageRef', 'reasonCode']) } : {}) }));
          out.document.priorBindings = (document.priorBindings || []).map(binding => fields(binding, ['groupRef', 'memberKey', 'receiptRef']));
          out.document.currentBinding = document.currentBinding ? fields(document.currentBinding, ['state', 'reasonCode']) : null;
          out.document.round = document.round ? { ...fields(document.round, ['roundRef', 'state']), denominator: document.round.members?.length ?? 0,
            members: (document.round.members || []).map(member => fields(member, ['memberKey', 'landId', 'cropRef', 'stageRef', 'state', 'operationId'])) } : null;
        }
        if (payload.evidence) out.evidence = basisEvidence(payload.evidence);
        return safe({ ...entry, payloadFingerprint: digest(payload), receiptRefVerified: entry.receipt_ref === digest([ownerRef, subjectRef, groupRef, entry.kind, payload]),
          payloadProjectionComplete: canonical(out) === canonical(payload), payload: out }, 'group:' + entry.receipt_ref);
      });
      const backendBases = projectBases(basisPage, 'backendBasis'), legacyBases = projectBases(legacyBasisPage, 'legacyBasis');
      const publicOriginal = safe(original, 'original');
      const originalProjectionComplete = canonical(publicOriginal) === canonical(operation.original);
      if (!originalProjectionComplete) missing.push('original-projection-incomplete');
      const publicFactBasis = safe(operation.factBasis, 'factBasis'), publicTargets = safe(operation.targets.map(target => target.original), 'targets');
      const publicBindings = safe(operation.resourceBindings, 'resourceBindings'), publicCoverage = safe(coverage, 'coverage');
      const publicSettlements = safe(operation.targetSettlements.map(({ result_json: _storedResult, ...entry }) => {
        if (finiteDomain === 'art-customer-batch') {
          const raw = entry.result?.evidence?.payload;
          const projected = fields(raw, ['operationId', 'traceId', 'targetRef', 'parentLifecycleRef', 'parentDecisionRef', 'batchQuantity', 'artId',
            'recipeFingerprint', 'writeResponseRef', 'after', 'newLogin', 'postReadRef', 'bridgeFingerprint', 'sourceSnapshotRef',
            'postDataSnapshotId', 'postVersionEvidence', 'postRecipeSource', 'postRowProof', 'beforeProduct', 'beforeProfile',
            'afterProfile', 'inputBalances', 'currencyFlows', 'flows', 'deltas', 'postReadProof', 'member', 'businessVerdict',
            'resourceResolutions', 'verificationVersion', 'transportTermination']);
          if (projected.newLogin) projected.newLogin = fields(projected.newLogin, bindingFields);
          const complete = canonical(projected) === canonical(raw);
          if (!complete) changedProjections.push('customer-art-batch-settlement-whitelist:' + entry.settlement_key);
          return { ...entry, result: { ...entry.result, evidence: { ...entry.result?.evidence, payload: projected } },
            resultIntegrity: { storedFingerprintVerified: ledgerJsonFingerprint(entry.result) === entry.result_fingerprint,
              projectionComplete: complete, hashContract: 'backend-ledger-json/v1' } };
        }
        if (finiteDomain === 'art-daily') {
          const raw = entry.result?.evidence?.payload;
          const projected = fields(raw, ['operationId', 'traceId', 'targetRef', 'recipeFingerprint', 'unitRef', 'dayKey', 'batchQuantity', 'targetStock', 'mode', 'quality', 'outputItemRow', 'writeResponseRef', 'after', 'newLogin', 'postRead', 'postReadRef',
            'bridgeFingerprint', 'dailyDataSnapshotId', 'postDataSnapshotId', 'postLoginResponseRef', 'postVersionEvidence', 'postRowProof',
            'postCatalogSource', 'beforeProfile', 'afterProfile', 'costContract', 'currencyFlows', 'flows', 'deltas', 'resourceResolutions',
            'code', 'officialAnswerRetained', 'permitId']);
          if (projected.postRead) projected.postRead = fields(projected.postRead, bindingFields);
          const complete = canonical(projected) === canonical(raw);
          if (!complete) changedProjections.push('daily-art-settlement-whitelist:' + entry.settlement_key);
          return { ...entry, result: { ...entry.result, evidence: { ...entry.result?.evidence, payload: projected } },
            resultIntegrity: { storedFingerprintVerified: ledgerJsonFingerprint(entry.result) === entry.result_fingerprint,
              projectionComplete: complete, hashContract: 'backend-ledger-json/v1' } };
        }
        if (!ordinaryFlowerDomain && !auxiliaryFlowerDomain) return entry;
        const projected = projectOrderFlowerVerification(entry.result?.evidence?.payload);
        if (!projected.complete) changedProjections.push('target-settlement-whitelist:' + entry.settlement_key);
        return { ...entry, result: { ...entry.result, evidence: { ...entry.result?.evidence, payload: projected.value } },
          resultIntegrity: { storedFingerprintVerified: ledgerJsonFingerprint(entry.result) === entry.result_fingerprint,
            projectionComplete: projected.complete, hashContract: 'backend-ledger-json/v1' } };
      }), 'targetSettlements');
      const publicEvidenceRows = evidence.map(entry => {
        let payload = entry.payload, projectionComplete = true;
        if (finiteDomain === 'art-customer-batch' && entry.kind === 'finite-domain-preparation') {
          const preparation = entry.payload?.preparation;
          payload = { domain: entry.payload?.domain ?? null, preparation: fields(preparation, ['operationId', 'traceId', 'targetRef', 'parentTargetRef',
            'parentLifecycleRef', 'parentDecisionRef', 'parentContentFingerprint', 'parentNpcId', 'officialUid', 'artId', 'orderNeed',
            'finishedStockAllocated', 'batchQuantity', 'vaseId', 'flowersIds', 'recipeFingerprint', 'catalogSource', 'recipeRowProof',
            'inputMultiset', 'inputBalances', 'beforeProduct', 'beforeProfile', 'loginResponseRef', 'dataSnapshotId', 'versionEvidence']) };
          projectionComplete = canonical(payload) === canonical(entry.payload);
        } else if (finiteDomain === 'art-customer-batch' && entry.kind === 'domain-verification') {
          payload = fields(entry.payload, ['version', 'featureId', 'scope', 'method', 'operationId', 'traceId', 'targetRef', 'parentLifecycleRef',
            'parentDecisionRef', 'batchQuantity', 'artId', 'recipeFingerprint', 'writeResponseRef', 'after', 'newLogin', 'postReadRef',
            'bridgeFingerprint', 'sourceSnapshotRef', 'postDataSnapshotId', 'postVersionEvidence', 'postRecipeSource', 'postRowProof',
            'beforeProduct', 'beforeProfile', 'afterProfile', 'inputBalances', 'currencyFlows', 'flows', 'deltas', 'postReadProof',
            'member', 'businessVerdict', 'resourceResolutions', 'verificationVersion', 'transportTermination']);
          if (payload.newLogin) payload.newLogin = fields(payload.newLogin, bindingFields);
          projectionComplete = canonical(payload) === canonical(entry.payload);
        } else if ((ordinaryFlowerDomain || auxiliaryFlowerDomain) && entry.kind === 'finite-domain-preparation') {
          const projected = projectOrderFlowerPreparation(payload?.preparation);
          payload = { domain: payload?.domain ?? null, preparation: projected.value };
          projectionComplete = projected.complete && canonical(payload) === canonical(entry.payload);
        } else if ((ordinaryFlowerDomain || auxiliaryFlowerDomain) && entry.kind === 'domain-verification') {
          const projected = projectOrderFlowerVerification(payload); payload = projected.value; projectionComplete = projected.complete;
        } else if ((ordinaryFlowerDomain || auxiliaryFlowerDomain) && entry.kind === 'admitted-operation-contract') {
          payload = fields(payload, ['kind', 'featureId', 'scope', 'method', 'counterId', 'countOffset', 'rewardItemId', 'targetKind', 'contractId', 'shareId', 'openId', 'currentNeed']);
          payload.postRead = fields(entry.payload?.postRead, ['contractId', 'kind', 'method', 'args', 'evidenceRef']);
          projectionComplete = canonical(payload) === canonical(entry.payload);
        }
        if (!projectionComplete) changedProjections.push('evidence-whitelist:' + entry.evidence_id);
        return { evidenceId: entry.evidence_id, evidenceKey: entry.evidence_key, kind: entry.kind, source: entry.source,
          fingerprint: entry.payload_fingerprint, observedAt: entry.observed_at, recordedAt: entry.recorded_at,
          ...(ordinaryFlowerDomain || auxiliaryFlowerDomain || finiteDomain === 'art-daily' || finiteDomain === 'art-customer-batch' ? { storedFingerprintVerified: storedEvidenceValid(entry), payloadProjectionComplete: projectionComplete,
            hashContract: 'backend-ledger-json/v1' } : {}), payload: safe(payload, 'evidence:' + entry.evidence_id) };
      });
      if ((ordinaryFlowerDomain || auxiliaryFlowerDomain || finiteDomain === 'art-daily' || finiteDomain === 'art-customer-batch') && !evidence.every(storedEvidenceValid)) missing.push('domain-ledger-evidence-hash');
      let domainAuditComplete = true;
      if (domainAudit) {
        const lease = domainAudit.lease, cost = domainAudit.costObservation;
        domainAuditComplete = lease.available && lease.complete && lease.present && lease.row.bridgeIntegrity.storedFingerprintVerified &&
          lease.row.bridgeIntegrity.complete && lease.row.validation.valid === true && !!lease.physicalClose &&
          lease.physicalClose.proofProjectionComplete && lease.physicalClose.evidenceRefVerified && lease.events.available && lease.events.complete &&
          ['created', 'old-closed-new-epoch', 'fresh-login-observed'].every(kind => lease.events.rows.some(entry => entry.event_kind === kind)) &&
          (lease.row.state !== 'released' || lease.events.rows.some(entry => entry.event_kind === 'durable-outcome-released')) &&
          lease.events.rows.every(entry => entry.receiptProjectionComplete) &&
          coverage.every(entry => entry.evidenceProjectionComplete && entry.storedResultIntegrity?.storedFingerprintVerified && entry.storedResultIntegrity.complete) &&
          (operation.business_verdict !== 'confirmed' || operation.resources.every(resource => coverage.filter(entry => entry.resource_key === resource.resource_key)
            .reduce((sum, entry) => sum + entry.quantity, 0) === resource.quantity));
        if (cost) domainAuditComplete = domainAuditComplete && cost.available && cost.present && cost.scopeCounts?.matchingVersionRecipeQuotaRows === 1 &&
          cost.scopeCounts.potentiallySentUnitOperations === 1 && cost.quota.state === 'settled' && cost.quota.bindingIntegrity.storedFingerprintVerified &&
          cost.quota.bindingIntegrity.complete && cost.quota.bindingIntegrity.matchesOperation && cost.quota.receiptIntegrity.storedFingerprintVerified &&
          cost.quota.receiptIntegrity.complete && cost.events.available && cost.events.complete && cost.events.rows.length > 0 &&
          cost.events.rows.every(entry => entry.storedFingerprintVerified && entry.eventKeyVerified && entry.payloadProjectionComplete) &&
          (operation.business_verdict !== 'confirmed' || !!cost.costHead && cost.costHead.receiptIntegrity.storedFingerprintVerified && cost.costHead.receiptIntegrity.complete);
        const production = domainAudit.productionUnit;
        if (production) domainAuditComplete = domainAuditComplete && production.available && production.present && production.unit.state === 'settled' &&
          production.unit.bindingIntegrity.storedFingerprintVerified && production.unit.bindingIntegrity.complete && production.unit.bindingIntegrity.matchesOperation &&
          production.unit.receiptIntegrity.storedFingerprintVerified && production.unit.receiptIntegrity.complete && production.events.available &&
          production.events.complete && production.events.rows.some(entry => entry.event_kind === 'normal-unit-settled') &&
          production.events.rows.every(entry => entry.storedFingerprintVerified && entry.eventKeyVerified && entry.payloadProjectionComplete);
        if (domainAudit.deliveryAccounting?.required) domainAuditComplete = domainAuditComplete &&
          domainAudit.deliveryAccounting.available && domainAudit.deliveryAccounting.complete;
        domainAudit.complete = !!domainAuditComplete;
        domainAudit = safe(domainAudit, 'domainAudit');
        if (changedProjections.includes('domainAudit')) { domainAudit.complete = false; domainAuditComplete = false; }
      }
      backend.software.authorize({ ownerRef });
      if (backend.owner() !== ownerRef || activeAccount(detailMatch[1]).subject_ref !== subjectRef) throw problem('WRITE_AUDIT_NOT_FOUND', '操作不属于当前软件身份与游戏主体', 404);
      return reply(response, 200, { readOnly: true, operationId: operation.operation_id,
        ownerRef, subjectRef: row.subject_ref, accountRef: operation.account_ref, method: operation.method, featureId: operation.feature_id,
        transport: operation.transport_state, verdict: operation.business_verdict, writeSlot: operation.write_slot === 1,
        revision: operation.revision, runEpoch: operation.run_epoch, connectionEpoch: operation.connection_epoch,
        auditVersion: finiteDomain ? 'backend-write-trace/v3' : 'backend-write-trace/v2', originalFingerprint: operation.original_fingerprint, paramsFingerprint: operation.params_fingerprint,
        semanticKey: operation.semantic_key, scope: operation.scope, configRevision: operation.config_revision, cancelEpoch: operation.cancel_epoch,
        original: publicOriginal, originalIntegrity: { storedFingerprintVerified: ledgerJsonFingerprint(operation.original) === operation.original_fingerprint,
          projectionFingerprint: ledgerJsonFingerprint(publicOriginal), complete: originalProjectionComplete, hashContract: 'backend-ledger-json/v1' },
        sendPermit: { available: permitAvailable, present: !!permit, row: permit,
          timeBasis: 'consumed_at-is-recorded-inside-claim-transaction-before-socket-send-not-commit-or-byte-send-time' },
        preparedAt: operation.prepared_at, updatedAt: operation.updated_at, factBasis: publicFactBasis,
        targets: publicTargets,
        resources: operation.resources.map(resource => ({ resourceKey: resource.resource_key, resourceKind: resource.resource_kind,
          resourceRef: resource.resource_ref, quantity: resource.quantity, state: resource.state, accountingRef: resource.accounting_ref,
          basisRef: resource.basis_ref, releaseEvidenceId: resource.release_evidence_id, updatedAt: resource.updated_at })),
        resourceBindings: publicBindings, targetSettlements: publicSettlements,
         resourceCoverage: { available: coveragePage.available,
           complete: coveragePage.complete && coverageScopeValid && landAccelerationCardCoverageComplete, limit: coveragePage.limit,
          rows: publicCoverage,
          ...([['order.resident', 'order-resident', 'orderFlower.finishOrder'],
            ['order.satin', 'order-satin', 'orderFlower.finishSatinOrder'],
            ['order.decorate', 'order-decorate', 'orderFlower.finishDecorateOrder']].some(tuple =>
              tuple[0] === operation.feature_id && tuple[1] === operation.scope && tuple[2] === operation.method)
            ? { diagnostics: typeof backend.landRuntime.resources.inspectOrderFlowerCoverage === 'function'
              ? publicEvidence(backend.landRuntime.resources.inspectOrderFlowerCoverage({ ownerRef, subjectRef, operationId: operation.operation_id }))
              : { available: false, applicable: true, reasonCode: 'ORDER_FLOWER_COVERAGE_DIAGNOSTICS_UNAVAILABLE', operationId: operation.operation_id, links: [] } } : {}) },
        item7Sources: { required: hasWaterResource, available: itemSourcesAvailable, limit: 32, complete: !hasWaterResource || itemSourcesAvailable && !missing.some(label => label.startsWith('item7-')) && !changedProjections.includes('item7Sources.limit'), rows: itemSources },
        targetPostObservations: { available: observationsAvailable, limit: observationLimit, complete: observationsAvailable && observationsWithinLimit && !missing.some(label => label.startsWith('target-post-')), rows: targetObservations },
        admission: { candidateFingerprint, backend: { available: basisPage.available,
          complete: basisPage.complete && !missing.some(label => label.startsWith('backendBasis:finite-')), limit: basisPage.limit, rows: backendBases },
          legacy: { available: legacyBasisPage.available, complete: legacyBasisPage.complete, limit: legacyBasisPage.limit, rows: legacyBases } },
        groupReceipts: { groupRef, available: groupPage.available, complete: groupPage.complete, retiredDetails: retiredGroupDetails, limit: groupPage.limit, rows: groupReceipts },
        ...(domainAudit ? { domainAudit } : {}),
        ...(flowerRackOperation ? { flowerRackAudit } : {}),
        ...(waterwheelOperation ? { waterwheelAudit } : {}),
        ...(freeWaterOperation ? { freeWaterAudit } : {}),
         auditProjection: { evidenceLimit: evidencePage.limit, evidenceComplete: evidencePage.complete, missing,
           changedProjections, complete: originalProjectionComplete && evidencePage.complete && coveragePage.complete && coverageScopeValid &&
             landAccelerationCardCoverageComplete && basisPage.complete && legacyBasisPage.complete && groupPage.complete && observationsWithinLimit &&
             domainAuditComplete && flowerRackAuditComplete && waterwheelAuditComplete && freeWaterAuditComplete && !missing.length && !changedProjections.length,
          byteSendTimeAvailable: false },
        evidence: publicEvidenceRows });
    }
    const match = /^\/accounts\/(\d+)(?:\/(config|start|stop|state-check|read-current|probe-login-sync|probe-relogin|logs|logs\/upload-selection|legacy-logs|legacy-log-policy|migration-digests|observations|writes|mirror))?$/.exec(route);
    if (match) {
      const id = String(Number(match[1])), operation = match[2], row = activeAccount(id);
      if (!operation && method === 'GET') return reply(response, 200, { account: backend.accounts.publicAccount(ownerRef, id) });
      if (!operation && method === 'DELETE') return reply(response, 200, backend.accounts.remove({ ownerRef, accountRef: id }));
      if (operation === 'migration-digests' && method === 'GET') {
        backend.software.authorize({ ownerRef });
        return reply(response, 200, readImportedEvidenceDigests({ store: backend.store, ownerRef, accountRef: id, subjectRef: row.subject_ref }));
      }
      if (operation === 'config' && method === 'GET') {
        const receipt = backend.config.read({ ownerRef, accountRef: id });
        return reply(response, 200, { config: receipt.config, metadata: readCatalog().metadata, application: receipt });
      }
      if (operation === 'config' && method === 'PUT') {
        const input = await body(request), expectedRevision = input.expectedRevision;
        delete input.expectedRevision;
        const requestedCommandId = input.commandId;
        delete input.commandId;
        if (requestedCommandId !== undefined && (typeof requestedCommandId !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedCommandId)))
          throw problem('CONFIG_COMMAND_INVALID', '设置保存命令编号格式不正确', 400);
        const commandId = requestedCommandId || newId();
        // The client command id travels end-to-end: a retried save with the
        // same id and identical body replays the stored receipt instead of
        // writing a second revision.
        const receipt = backend.config.save({ ownerRef, accountRef: id, config: input, expectedRevision, commandId });
        const context = backend.supervisor.context(row.subject_ref);
        if (context) backend.scheduler.notify(context);
        if (receipt?.config?.mail?.enabled === true) backend.maybeMailPrefetch({ ownerRef, accountRef: id });
        backend.log(ownerRef, id, '已保存设置；实际功能资格与用户意愿分别记录，保存不会启动游戏号。', 'info',
          { savedRevision: receipt.savedRevision, changedFeatures: receipt.changedFeatures, acceptedRevision: receipt.acceptedRevision,
            ...(receipt.duplicate === true ? { duplicate: true } : {}) });
        return reply(response, 200, { config: receipt.config, metadata: readCatalog().metadata, application: receipt,
          commandId, duplicate: receipt.duplicate === true });
      }
      if (operation === 'start' && method === 'POST') {
        const input = await body(request, 4096);
        if (!plainObject(input) || Object.keys(input).some(key => !['expectedPriorRunEpoch', 'commandId'].includes(key)) ||
            !Number.isSafeInteger(input.expectedPriorRunEpoch) || input.expectedPriorRunEpoch < 0)
          throw problem('START_CONTROL_REVISION_REQUIRED', '启动前必须携带刚读取的账号停止代次', 400);
        if (input.commandId !== undefined && (typeof input.commandId !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.commandId)))
          throw problem('START_COMMAND_INVALID', '启动命令编号格式不正确', 400);
        if (Number(backend.supervisor.intent(ownerRef, id)?.run_epoch || 0) !== input.expectedPriorRunEpoch)
          throw problem('RUN_INTENT_CHANGED', '启动请求对应的停止代次已变化，请先刷新账号状态', 409);
        if (backend.isAccountStopPending({ ownerRef, accountRef: id, subjectRef: row.subject_ref })) {
          throw problem('ACCOUNT_STOP_PENDING', '本机已保存这个游戏号的停止请求，完成停止前不能重新开始', 409);
        }
        const { flight, commandId, nativeStartControl } = startExplicitAccount(backend, {
          ownerRef, accountRef: id, expectedPriorRunEpoch: input.expectedPriorRunEpoch,
          ...(input.commandId !== undefined ? { commandId: input.commandId } : {}) });
        flight.catch(error => {
          const state = backend.supervisor.project(ownerRef, id), code = String(error.code || 'SESSION_START_FAILED');
          if (!state.desiredRunning && ['REAL_ABORTED', 'PROTOCOL_CANCELLED', 'RUN_INTENT_REVOKED', 'CONNECTION_RETIRED'].includes(code)) {
            backend.log(ownerRef, id, '启动已取消，游戏号保持停止。', 'info', { code, desiredRunning: false });
          } else backend.log(ownerRef, id, '官服连接尚未完成：' + code, 'error', { code,
            ...(Number.isFinite(error.details?.retryAfterMs) ? { retryAtMs: Date.now() + error.details.retryAfterMs } : {}) });
        });
        return reply(response, 202, { accepted: true, commandId, nativeStartControl,
          account: backend.accounts.publicAccount(ownerRef, id) });
      }
      if (operation === 'stop' && method === 'POST') {
        const input = await body(request, 4096);
        if (!plainObject(input) || Object.keys(input).some(key => key !== 'commandId') || input.commandId !== undefined &&
            (typeof input.commandId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.commandId))) {
          throw problem('ACCOUNT_STOP_COMMAND_INVALID', '单号停止指令编号格式不正确', 400);
        }
        const commandId = input.commandId || newId();
        const result = await backend.stopAccount({ ownerRef, accountRef: id, commandId });
        return reply(response, result.cleanupComplete ? 200 : 409, { ...result, commandId, ok: result.cleanupComplete, account: backend.accounts.publicAccount(ownerRef, id) });
      }
      if (operation === 'logs' && method === 'GET') return reply(response, 200, backend.legacyHistory.composePage({ currentLogs: backend.logs,
        ownerRef, accountRef: id, subjectRef: row.subject_ref, limit: Number(url.searchParams.get('limit') || 15),
        beforeLocalId: url.searchParams.get('beforeLocalId'), beforeBusinessId: url.searchParams.get('beforeBusinessId'),
        category: url.searchParams.get('category'), day: url.searchParams.get('day'), from: url.searchParams.get('from'), to: url.searchParams.get('to'),
        keyword: url.searchParams.get('keyword'), level: url.searchParams.get('level'), outcomeState: url.searchParams.get('outcomeState'),
        errorCode: url.searchParams.get('errorCode'), operationId: url.searchParams.get('operationId'), traceId: url.searchParams.get('traceId') }));
      if (operation === 'logs/upload-selection' && method === 'POST') {
        const input = await body(request, 16 * 1024), allowed = new Set(['category','day','from','to','keyword','level','outcomeState','errorCode','operationId','traceId']);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.has(key)))
          throw problem('LOG_MANUAL_FILTER_INVALID', '手动日志上传只接受日志页筛选条件', 400);
        backend.software.authorize({ ownerRef });
        const selection = backend.logs.selectIds({ ownerRef, accountRef: id, ...input });
        const sourceRefs = backend.legacyHistory.selectUploadSources({ ownerRef, accountRef: id, subjectRef: row.subject_ref,
          ...input, limit: 10000 });
        const selected = selection.sourceLogIds.length + sourceRefs.length;
        if (!selected) return reply(response, 200, { sent: 0, confirmed: true, reason: 'empty_selection', selected: 0 });
        const frozen = backend.cloudSync.createManualSelection({ accountRef: id, ...selection, sourceRefs });
        const result = await backend.cloudSync.flush({ manual: true, selectionRef: frozen.selectionRef });
        return reply(response, 200, { ...result, selection: frozen });
      }
      if (operation === 'legacy-logs' && method === 'GET') {
        const scope = { ownerRef, accountRef: id, subjectRef: row.subject_ref, transferId: url.searchParams.get('transferId') || undefined };
        return reply(response, 200, { summary: backend.legacyLogging.readAccount(scope),
          ...backend.legacyLogging.page({ ...scope, limit: Number(url.searchParams.get('limit') || 50), afterEventRef: url.searchParams.get('afterEventRef') || '' }) });
      }
      if (operation === 'legacy-log-policy' && method === 'POST') {
        const input = await body(request);
        if (Object.keys(input).some(key => !['transferId', 'commandId', 'expectedTargetInstallId', 'expectedIdentityEpoch'].includes(key))) throw problem('LEGACY_LOG_POLICY_INPUT_INVALID', '旧日志策略映射参数无效', 400);
        return reply(response, 200, backend.legacyLogging.restorePolicy({ ...input, ownerRef, accountRef: id, subjectRef: row.subject_ref }));
      }
      if (operation === 'writes' && method === 'GET') {
        const rawLimit = url.searchParams.get('limit'), limit = rawLimit === null ? 100 : /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw problem('WRITE_PAGE_INVALID', '操作页大小无效', 400);
        const page = backend.ledger.listOperationsPage({ ownerRef, subjectRef: row.subject_ref, limit,
          beforePreparedAt: url.searchParams.get('beforePreparedAt'), beforeOperationId: url.searchParams.get('beforeOperationId') });
        return reply(response, 200, { writes: page.rows.map(writeRow), page: page.page, totals: page.totals,
          historical: backend.legacy.operationsPage({ ownerRef, subjectRef: row.subject_ref, afterOperationRef: url.searchParams.get('afterOperationRef') || '' }), legacyEvidencePreserved: true });
      }
      const wakeEnabled = (saved, wake) => {
        if (wake.featureKey === 'order.team') return saved?.orders?.team?.enabled === true && saved.orders.team.realWrite === true;
        const main = CONFIG_FIELDS.find(field => field.featureId === wake.featureKey && field.type === 'boolean' &&
          (/^(?:plant|harvest|water)Enabled$/.test(field.dtoPath) || /\.(?:enabled|makeEnabled)$/.test(field.dtoPath)));
        return !!main && atPath(saved, main.dtoPath).value === true;
      };
      if (operation === 'observations' && method === 'GET') {
        const runtime = backend.supervisor.project(ownerRef, id), context = { ownerRef, accountRef: id, subjectRef: row.subject_ref };
        if (url.searchParams.get('view') === 'resources') {
          const raw=url.searchParams.get('itemIds')||'', parts=raw.split(','), itemIds=parts.map(Number);
          if (!raw || parts.length>16 || parts.some(one=>!/^\d{1,16}$/.test(one)) ||
              itemIds.some(one=>!Number.isSafeInteger(one)||one<=0) || new Set(itemIds).size!==itemIds.length)
            throw problem('ITEM_PREVIEW_LIST_INVALID','物品窄读需要1至16个不同的正整数编号',400);
          const actor=backend.supervisor.context(row.subject_ref);
          if (!actor?.isCurrent?.() || actor.ownerRef!==ownerRef || String(actor.accountRef)!==id || actor.subjectRef!==row.subject_ref)
            throw problem('ITEM_PREVIEW_CURRENT_CONTEXT_REQUIRED','当前账号尚无可用的本人事实',409);
          const active=Object.fromEntries(['ownerRef','accountRef','subjectRef','ownerEpoch','runEpoch','connectionEpoch'].map(key=>[key,actor[key]]));
          const balances=backend.landRuntime.resources.balanceBatch({context:active,itemIds});
          const budgets=backend.landRuntime.resources.budgetBatch({context:active,itemIds,quantity:1,keep:0});
          return reply(response,200,{resourcePreview:true,readOnly:true,noGameRequestSent:true,writeEligible:false,
            buildId:backend.buildId,context:active,balances,budgets});
        }
        if (url.searchParams.get('view') === 'summary') {
          const writes = writeSummaryRows(row.subject_ref, ownerRef, 12);
          const wakes = backend.scheduler.snapshot(context, { summary: true });
          const actor = backend.supervisor.context(row.subject_ref);
          const customer = backend.customerReadModel.summary({ ...context, ownerEpoch: actor?.ownerEpoch ?? null,
            runEpoch: actor?.runEpoch ?? null, connectionEpoch: actor?.connectionEpoch ?? null });
          const wakeView = Object.fromEntries(wakes.map(wake => [wake.featureKey, { enabled: wake.enabled === true,
            state: wake.state, reasonCode: wake.reasonCode,
            nextCheckAtMs: wake.officialDueAtMs ?? wake.fallbackDueAtMs }]));
          return reply(response, 200, { summaryOnly: true, available: runtime.connected, source: runtime.connected ? 'new-official-facts' : null,
            buildId: backend.buildId, wakes: wakeView, persistentWakes: wakes, recentWrites: writes,
            customer: { current: customer.current, available: customer.available, reasonCode: customer.reasonCode,
              identity: customer.identity, revision: customer.revision, summaryOnly: true },
            orders: { available: customer.current, customer: { available: customer.current, stage: 'validation-only', scope: 'finished-stock-single' },
              ...backend.specialOrderRuntime.publicView(actor), reason: '订单按当前官服事实逐步核验' },
            art: { available: runtime.connected, stage: 'validation-only', reason: '优先补齐已接受顾客单所需的花艺' },
            dailyTaskRewards: { available: false, reason: '日常奖励尚未重建' },
            ledger: { available: true, currentInFlight: writes.filter(one => one.writeSlot), legacyEvidencePreserved: true },
            reason: runtime.connected ? '已连接官服；摘要读取未展开土地详情' : '这个游戏号当前没有连接官服' });
        }
        // Narrow land read for the controller's natural-target decision. The full projection below builds
        // historical admission, customer planning, flower orders and art planning in one synchronous tick,
        // which can hold the event loop long enough to delay another account's dispatch. This view keeps the
        // default full contract untouched and returns only what a land target needs, naming what it skipped.
        if (url.searchParams.get('view') === 'land') {
          const saved = backend.config.read(context).config;
          const land = backend.landRuntime.publicView({ ...context, config: saved });
          const wakes = backend.scheduler.snapshot(context, { summary: true });
          return reply(response, 200, { landOnly: true, available: runtime.connected,
            source: runtime.connected ? 'new-official-facts' : null, buildId: backend.buildId, session: runtime,
            clock: backend.facts.clock(row.subject_ref), serverNowMs: backend.facts.clock(row.subject_ref).nowMs,
            lands: land.current ? land.lands : null, groups: land.current ? land.groups : null, land,
            wakes: Object.fromEntries(wakes.map(wake => [wake.featureKey, { enabled: wakeEnabled(saved, wake),
              state: wake.state, reasonCode: wake.reasonCode, nextCheckAtMs: wake.officialDueAtMs ?? wake.fallbackDueAtMs }])),
            persistentWakes: wakes,
            omittedSections: ['recentWrites', 'legacyHistoricalAdmission', 'customerPublicView', 'customerPlanning',
              'customerInventory', 'flowerOrders', 'artPlanning', 'orderFlowerPlanning', 'publicResourceConfiguration',
              'sessionEvidence'],
            reason: runtime.connected ? (land.current ? '窄读：仅土地自然目标所需事实，未展开历史写、顾客、订单与花艺全量'
              : '窄读：已连接官服，当前土地事实尚未读到') : '这个游戏号当前没有连接官服' });
        }
        // A full projection is deliberately no longer one atomic synchronous island: sections are built with
        // yields between them so other accounts can dispatch. That means the parts can describe moments a few
        // milliseconds apart, so the response says how many yields it took instead of pretending otherwise.
        let projectionYields = 0;
        // A lifecycle/identity change during a yield invalidates the whole read. Do not combine the
        // pre-yield session with another owner's, run's or connection's current projections.
        const projectionBinding = () => {
          const identity = backend.software.status(), actor = backend.supervisor.context(row.subject_ref);
          const account = activeAccount(id);
          return canonical({ ownerRef: backend.owner(), ownerBound: backend.readiness().ready,
            identityEpoch: identity.identityEpoch, installId: identity.installId, userId: identity.userId,
            subjectRef: account.subject_ref, uid: parseStored(account.profile_json, '游戏号安全资料').uid,
            actor: actor ? [actor.ownerEpoch, actor.runEpoch, actor.connectionEpoch] : null,
            intent: backend.store.get('SELECT run_epoch,desired_running FROM backend_run_intents WHERE owner_ref=? AND account_ref=?', ownerRef, id),
            control: backend.store.get('SELECT control_seq FROM backend_native_stop_controls ORDER BY control_seq DESC LIMIT 1'),
            configRevision: backend.config.read(context).savedRevision });
        };
        const bindingBefore = projectionBinding();
        const requireSameBinding = () => {
          if (projectionBinding() !== bindingBefore) throw problem('OBSERVATION_CONTEXT_CHANGED', '读取期间游戏号或软件状态已改变，请刷新后重读', 409);
        };
        const breathe = async () => { projectionYields += 1; await new Promise(resolve => setImmediate(resolve)); requireSameBinding(); };
        const writes = writeRows(row.subject_ref, ownerRef, 12);
        // Each section below is a synchronous island over this account's whole ledger and read models.
        // Yielding between them keeps one controller's full projection from holding the event loop long
        // enough to delay another account's dispatch; nothing here is skipped, shrunk or reordered.
        await breathe();
        const historical = backend.legacy.currentAdmission({ ownerRef, subjectRef: row.subject_ref });
        const customerPlanning = backend.customerPlanning(context, { requestLocal: true });
        await breathe();
        const saved = customerPlanning.settings?.config ?? backend.config.read(context).config;
        const land = backend.landRuntime.publicView({ ...context, config: saved }), wakes = backend.scheduler.snapshot(context);
        await breathe();
        const actor = backend.supervisor.context(row.subject_ref);
        const customer = backend.customerReadModel.publicView({ ...context, ownerEpoch: actor?.ownerEpoch ?? null,
          runEpoch: actor?.runEpoch ?? null, connectionEpoch: actor?.connectionEpoch ?? null });
        const flowerOrderCurrent = actor?.ownerRef === ownerRef && String(actor.accountRef) === id && actor.isCurrent() &&
          ['ownerEpoch', 'runEpoch', 'connectionEpoch'].every(key => Number.isSafeInteger(actor[key]) && actor[key] > 0);
        const flowerOrders = flowerOrderCurrent ? backend.orderFlowerReadModel.publicView({ ...context, ownerEpoch: actor.ownerEpoch,
          runEpoch: actor.runEpoch, connectionEpoch: actor.connectionEpoch }) : {
          source: 'rebuilt-order-flower-readonly', context, current: false, available: false, readOnly: true, writeEligible: false,
          reasonCode: 'ORDER_FLOWER_READ_CONTEXT_NOT_CURRENT', identity: { verified: false },
          fields: Object.fromEntries(['uid', 'residentMap', 'satin', 'decorate', 'stockMap', 'tdyMap', 'recvIds', 'recvTime', 'uTime', 'cTime', 'rTime']
            .map(key => [key, { presence: 'missing', state: 'unobserved', value: null, current: false, reasonCode: 'NO_CURRENT_CONNECTION' }])) };
        const customerItemIds = [...new Set(customer.orders.map(order => order.fields.artId)
          .filter(cell => cell.presence === 'present' && cell.state === 'known').map(cell => cell.value))];
        const customerInventory = actor && customer.current ? backend.landRuntime.resources.view({ context: { ...context,
          ownerEpoch: actor.ownerEpoch, runEpoch: actor.runEpoch, connectionEpoch: actor.connectionEpoch }, itemIds: customerItemIds }) : null;
        await breathe();
        const artPlanning = backend.artPlanning(context, customerPlanning);
        await breathe();
        const orderFlowerPlanning = backend.orderFlowerPlanning(context);
        const resourceConfiguration = backend.store.get('SELECT receipt_ref,connection_epoch,payload_json,recorded_at FROM backend_official_public_resources WHERE owner_ref=? AND subject_ref=? ORDER BY recorded_at DESC,receipt_ref DESC LIMIT 1', ownerRef, row.subject_ref);
        const historyComplete = !row.migration_key || backend.store.get('SELECT state FROM backend_migration_imports WHERE transfer_id=?', row.migration_key)?.state === 'imported';
        requireSameBinding();
        return reply(response, 200, { available: runtime.connected, source: runtime.connected ? 'new-official-facts' : null, buildId: backend.buildId, session: runtime,
          projectionYields,
          sessionEvidence: backend.supervisor.evidence(ownerRef, id),
          clock: backend.facts.clock(row.subject_ref), serverNowMs: backend.facts.clock(row.subject_ref).nowMs,
          lands: land.current ? land.lands : null, groups: land.current ? land.groups : null, land,
          publicResourceConfiguration: resourceConfiguration ? { receiptRef: resourceConfiguration.receipt_ref,
            connectionEpoch: resourceConfiguration.connection_epoch, recordedAt: resourceConfiguration.recorded_at,
            configuration: parseStored(resourceConfiguration.payload_json, '官方公开资源配置') } : null,
          plantableFlowerIds: null, emptyLandIds: null,
          wakes: Object.fromEntries(wakes.map(wake => [wake.featureKey, { enabled: wakeEnabled(saved, wake),
            state: wake.state, reasonCode: wake.reasonCode,
            nextCheckAtMs: wake.officialDueAtMs ?? wake.fallbackDueAtMs }])), persistentWakes: wakes, recentWrites: writes,
          ledger: { available: true, currentInFlight: writes.filter(one => one.writeSlot),
            historical: { available: historyComplete, unresolvedOperationCount: historical.operations.length,
              targetCount: historical.targets.length, resourceFootprintCount: historical.resourceFootprints.length,
              originalUnknownPreserved: true, currentAdmissionIndependent: true, reasonCode: historyComplete ? historical.noteCode : 'MIGRATION_ARCHIVE_INCOMPLETE' }, legacyEvidencePreserved: true },
          customer: { ...customer, itemBalances: customerInventory, planning: customerPlanning.result }, orders: { available: customer.current, customer: { available: customer.current, stage: 'validation-only', scope: 'finished-stock-single' },
            ...backend.specialOrderRuntime.publicView(backend.supervisor.context(row.subject_ref)), reason: '订单按当前官服事实逐步核验' }, art: { available: runtime.connected, stage: 'validation-only', planning: artPlanning, reason: '优先补齐已接受顾客单所需的花艺' },
          orderFlower: { ...flowerOrders, planning: orderFlowerPlanning },
          dailyTaskRewards: { available: false, reason: '日常奖励尚未重建' }, reason: runtime.connected ? land.current ? '种收浇读取本次官服事实，业务处于限定实服验收阶段' : '已连接官服，当前土地事实尚未读到' : '这个游戏号当前没有连接官服' });
      }
      if (['read-current', 'probe-login-sync', 'probe-relogin'].includes(operation) && method === 'POST') {
        const input = await body(request);
        if (Object.keys(input).length) throw problem('CURRENT_READ_ARGUMENTS_INVALID', '当前只读刷新不接受自定义方法或参数', 400);
        return reply(response, 200, await backend.readCurrentFacts({ ownerRef, accountRef: id, subjectRef: row.subject_ref,
          normalLoginSyncProbe: operation === 'probe-login-sync', normalReloginProbe: operation === 'probe-relogin' }));
      }
      if (operation === 'state-check' && method === 'POST') {
        const input = await body(request);
        const started = backend.inspections.begin({ ownerRef, accountRef: id, paths: input.paths });
        started.completion.catch(error => backend.log(ownerRef, id, '只读状态核对尚未完成：' + String(error.code || 'INSPECTION_FAILED'), 'warn'));
        return reply(response, 202, { accepted: true, inspectionId: started.inspectionId, desiredRunningUnchanged: true });
      }
      if (operation === 'state-check' && method === 'GET') return reply(response, 200, { checkpoint: backend.inspections.latest({ ownerRef, accountRef: id }) });
      if (operation === 'mirror' && method === 'GET') return reply(response, 200, { available: Boolean(backend.inspections.latest({ ownerRef, accountRef: id })),
        checkpoint: backend.inspections.latest({ ownerRef, accountRef: id }), source: 'readonly-checkpoint', historicalSnapshot: true });
    }
    return reply(response, 404, { error: '接口不存在', code: 'LOCAL_ROUTE_NOT_FOUND' });
  } catch (error) {
    const diagnosticRef = newId();
    const diagnosticPath = safeBackendErrorPath(error);
    saveLastFailure('request', { diagnosticRef, code: /^[A-Z0-9_]{1,96}$/.test(String(error.code || '')) ? error.code : 'BACKEND_REQUEST_FAILED',
      path: diagnosticPath, causes: failureCauses(error) });
    const errorClass = /^[A-Za-z]{1,48}$/.test(error.name || '') ? error.name : 'Error';
    try { backend.log(backend.software.ownerRef(), '0', '本机请求未完成，诊断编号：' + diagnosticRef, 'error',
      { diagnosticRef, code: /^[A-Z0-9_]{1,96}$/.test(String(error.code || '')) ? error.code : 'BACKEND_REQUEST_FAILED',
        ...(diagnosticPath ? { path: diagnosticPath } : {}) }); }
    catch { /* A failed store must not hide the original request's error receipt. */ }
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : error.scope === 'software-cloud' ? 502 : 500;
    const scope = ['local-engine', 'software-local', 'software-cloud'].includes(error.scope) ? error.scope : /^SOFTWARE_/.test(error.code || '') ? 'software-local' : 'local-engine';
    const retryAfterMs = error.retryAfterMs ?? error.details?.retryAfterMs;
    const message = error.code === 'SESSION_COOLDOWN_ACTIVE' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? error.message + '（约' + Math.ceil(retryAfterMs / 1000) + '秒后可重试）' : error.message;
    return reply(response, status, { error: error.status ? message : '本机处理未完成，原资料已保留，请查看本次错误编号',
      code: /^[A-Z0-9_]{1,96}$/.test(String(error.code || '')) ? error.code : 'BACKEND_REQUEST_FAILED', scope,
      requestId: /^[A-Za-z0-9-]{1,80}$/.test(error.requestId || '') ? error.requestId : diagnosticRef,
      ...(Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? { retryAfterMs } : {}),
      diagnosticRef, ...(error.details ? { details: error.details } : {}) });
  }
});
server.listen(port, '127.0.0.1', () => {
  void backend.initialize().catch(error => process.stderr.write('新后端初始化未完成：' + String(error.code || 'INITIALIZATION_FAILED') + '\n'));
  process.stdout.write('GARDEN_LOCAL_READY\n');
});
async function shutdown() {
  if (closing) return; closing = true;
  try { localEventLoopDelay?.disable(); } catch { /* Optional profiling cannot block shutdown. */ }
  // Stop new local HTTP work and retire idle keep-alive sockets immediately.
  // The supervisor independently drains admitted game writes before backend
  // shutdown closes its native/session helpers.
  server.close();
  server.closeIdleConnections?.();
  let settled = false;
  const hardDeadline = setTimeout(() => {
    server.closeAllConnections?.();
    if (!settled) process.exit(1);
  }, 20000);
  try {
    const result = await backend.shutdown();
    settled = true;
    clearTimeout(hardDeadline);
    if (result.cleanupComplete) {
      server.closeAllConnections?.();
      process.exit(0);
    }
    // Cleanup deliberately left its durable ledger/owner fence intact. Do not
    // keep the service process alive indefinitely after the bounded attempt.
    server.closeAllConnections?.();
    process.exit(1);
  } catch {
    settled = true;
    clearTimeout(hardDeadline);
    server.closeAllConnections?.();
    process.exit(1);
  }
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
