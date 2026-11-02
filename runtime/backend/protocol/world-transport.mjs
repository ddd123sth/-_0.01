import { clone, freeze, newId, plainObject, problem } from '../common.mjs';
import { isIP } from 'node:net';
import {
  buildRequestFrame, captureParams, decodeEnvelope, extractSessionMetadata, FRAME_LIMIT_BYTES,
  observationValue, paramsFingerprint, parseSocketDocuments, SYNC_DATA_TYPE,
} from './codec.mjs';
import { authenticateGame } from './login.mjs';

export const READ_METHODS = Object.freeze(['usrLand.refresh', 'waterwheel.enter', 'mail.getList',
  // R10 interface note (adjacent Codex request): name-level reads for the other
  // owner's palace/team cards. Empty-argument contract is unchanged.
  'taskDly.enter', 'orderPalace.enter']);
// Isolated official 480.0.46 acceleration extension. Keep the historical
// write allowlist unchanged; these methods still require the independent
// acceleration descriptor and the shared gateway permit before sending.
export const LAND_ACCELERATION_WRITE_METHODS = Object.freeze(['usrLand.speedUp', 'usrLand.speedUpFree']);
export const WATERWHEEL_WRITE_METHODS = Object.freeze(['waterwheel.recv', 'waterwheel.skip']);
export const FREE_WATER_WRITE_METHODS = Object.freeze(['freeWater.recv']);
export const FLOWER_RACK_WRITE_METHODS = Object.freeze(['flowerRack.unlockStand', 'flowerRack.sell', 'flowerRack.recvSellMoney', 'flowerRack.cancelSell']);
export const ART_FIRST_ALBUM_WRITE_METHODS = Object.freeze(['collectRwd.recvArtCreateRwdByVase']);
// R10 reward/upgrade cards. Each method still needs its registry feature,
// scope and gateway descriptor before a frame can be prepared.
export const REWARD_WRITE_METHODS = Object.freeze(['mail.pickOneKey', 'benefitBox.draw', 'taskDly.recv', 'taskDly.recvBox',
  'taskWeek.recv', 'taskMain.recv', 'storyMain.unlock', 'fml.bld', 'fmlLand.harvestAll', 'fmlLand.plant', 'fmlLand.unlock',
  'fmlLand.upgrade', 'cultivate.upgrade', 'shopCultivate.buy', 'shopCultivate.refresh',
  // Name-level support only, per the adjacent Codex request: palace/team still
  // need their own registry feature, scope and gateway contract before sending.
  'orderPalace.finishOrder', 'orderTeam.takeOrder', 'orderTeam.submitOrder', 'orderTeam.recvRwd', 'orderTeam.takeStoredOrder']);
const isRegisteredWriteMethod = method => WRITE_METHODS.includes(method) || LAND_ACCELERATION_WRITE_METHODS.includes(method) ||
  WATERWHEEL_WRITE_METHODS.includes(method) || FREE_WATER_WRITE_METHODS.includes(method) || FLOWER_RACK_WRITE_METHODS.includes(method) ||
  ART_FIRST_ALBUM_WRITE_METHODS.includes(method) || REWARD_WRITE_METHODS.includes(method);
// G480 [255676,255752): the normal client requests this once after login.
// Probe only, not an admitted business post-read until actual coverage is known.
const NORMAL_LOGIN_SYNC_PROBE_METHOD = 'usr.lazySync';
export const WRITE_METHODS = Object.freeze(['usrLand.plant', 'usrLand.plantBatch', 'usrLand.water', 'usrLand.waterBatch', 'usrLand.harvest',
  'orderCustomer.finishOrder', 'flowerArt.makeFlowerArt', 'orderCustomer.rejectOrder', 'orderCustomer.genOrder',
  'orderFlower.finishOrder', 'orderFlower.finishSatinOrder', 'orderFlower.finishDecorateOrder',
  // Name-level support only. Registry and the write gateway still bind each
  // auxiliary RPC to its exact feature/scope/operation contract.
  'usr.share', 'orderFlower.recvOrderRwd', 'taskAch.recv', 'orderFlower.enter']);
const REQUEST_TIMEOUT_MS = 15000;
const ENDPOINT_HINT_LIMIT = 128;
const ROUTE_FAILURE_CODES = new Set(['PROTOCOL_CONNECT_FAILED', 'PROTOCOL_READY_TIMEOUT', 'PROTOCOL_CONNECTION_CLOSED', 'PROTOCOL_SEND_FAILED', 'PROTOCOL_TRANSPORT_FAILED']);

function routeFailure(error, { physicalClosed = false } = {}) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return ROUTE_FAILURE_CODES.has(code) ||
    physicalClosed && /^SOCKET_\d{1,5}$/.test(code);
}

export function createWorldEndpointPreferences({ maxSubjects = ENDPOINT_HINT_LIMIT } = {}) {
  if (!Number.isSafeInteger(maxSubjects) || maxSubjects < 1 || maxSubjects > 1024) throw new TypeError('endpoint preference bound is invalid');
  const hints = new Map();
  const identityKey = (ownerRef, subjectRef) => typeof ownerRef === 'string' && ownerRef.length > 0 && ownerRef.length <= 512 &&
    typeof subjectRef === 'string' && subjectRef.length > 0 && subjectRef.length <= 512
    ? JSON.stringify([ownerRef, subjectRef]) : null;
  const endpointKey = endpoint => endpoint && typeof endpoint.host === 'string' && Number.isInteger(endpoint.port)
    ? endpoint.host + ':' + endpoint.port : null;
  function failed({ ownerRef, subjectRef, endpoint, connectionEpoch, physicalCloseProved }) {
    const key = identityKey(ownerRef, subjectRef), failedEndpoint = endpointKey(endpoint);
    if (!key || !failedEndpoint || !Number.isSafeInteger(connectionEpoch) || connectionEpoch < 1 || physicalCloseProved !== true) return false;
    hints.delete(key);
    hints.set(key, { failedEndpoint, failedEpoch: connectionEpoch });
    while (hints.size > maxSubjects) hints.delete(hints.keys().next().value);
    return true;
  }
  function order({ ownerRef, subjectRef, connectionEpoch, endpoints }) {
    if (!Array.isArray(endpoints)) return [];
    const key = identityKey(ownerRef, subjectRef), hint = key ? hints.get(key) : null;
    if (!hint) return endpoints.slice();
    if (!Number.isSafeInteger(connectionEpoch) || connectionEpoch <= hint.failedEpoch) return endpoints.slice();
    const index = endpoints.findIndex(endpoint => endpointKey(endpoint) === hint.failedEndpoint);
    if (index < 0) { hints.delete(key); return endpoints.slice(); }
    return [...endpoints.slice(0, index), ...endpoints.slice(index + 1), endpoints[index]];
  }
  function succeeded({ ownerRef, subjectRef, connectionEpoch }) {
    const key = identityKey(ownerRef, subjectRef), hint = key ? hints.get(key) : null;
    if (hint && Number.isSafeInteger(connectionEpoch) && connectionEpoch > hint.failedEpoch) hints.delete(key);
  }
  return Object.freeze({ failed, order, succeeded, size: () => hints.size });
}
const defaultEndpointPreferences = createWorldEndpointPreferences();

const HEARTBEAT_INTERVAL_MS = 60000;
const monotonicMs = () => Number(process.hrtime.bigint()) / 1e6;

function closedError(code = 'PROTOCOL_CONNECTION_CLOSED', mayHaveSent = false) {
  return Object.assign(problem(code, '与官服的当前连接已结束'), { transportFailure: true, mayHaveSent });
}

function worldLoginArgs(auth) {
  const info = auth.device.deviceInfo;
  // Use only this device's collected values. Do not import the old world's
  // captured-device fallback, auto reconnect, iface planner, or sync mirror.
  const deviceInfo = {
    osType: 'Android', deviceId: auth.device.deviceId,
    isEmulator: info.isEmulator === true,
    osVersion: String(info.osVersion || ''), brand: String(info.brand || ''), model: String(info.model || ''),
    networkType: String(info.networkType || ''), sysLanguage: String(info.sysLanguage || ''),
    screenWidthPx: info.screenWidthPx, screenHeightPx: info.screenHeightPx,
    deviceType: String(info.deviceType || 'Phone'), appVersion: auth.device.appVersion,
  };
  return { aid: auth.aid, gsIdx: auth.serverId, token: auth.sessionToken,
    osType: 2, isNative: true, deviceId: auth.device.deviceId, isSimulator: auth.device.isSimulator,
    deviceInfo, inviter: {}, version: auth.worldVersion, chnId: auth.chnId, area: auth.area };
}

async function openWorld({ auth, endpoint, proxy, signal, isCurrent, connectionEpoch, onObservation, onClosed, onPhysicalClosed, WebSocketClass, ProxyAgentClass }) {
  let socket;
  let opened = false;
  let entered = false;
  let closing = false;
  let closeNotified = false;
  let physicalCloseNotified = false;
  let intentionalClose = false;
  let closeReason = null;
  let sequence = 0;
  let rpcToken = null;
  let versionEvidence = null;
  let heartbeatTimer = null;
  let pingTimer = null;
  let heartbeatInFlight = false;
  let readyResolve;
  let readyReject;
  let closeResolve;
  let closePromise = null;
  let closeTimer = null;
  const pending = new Map();
  const matchedWriteResponses = new Map();
  let normalLoginSyncProbed = false, normalReloginProbed = false, businessWritePrepared = false;
  // Confirmed continuous session time. Only a matched usr.heartTick reply, or a
  // gap-free run of them, counts: the supervisor may not treat wall-clock
  // distance from connect as a stable session.
  const liveness = { openedMono: null, closedMono: null, heartbeatsConfirmed: 0, lastHeartbeatMono: null,
    continuousSinceMono: null, longestContinuousMs: 0 };
  function heartbeatConfirmed() {
    const at = monotonicMs();
    if (liveness.continuousSinceMono === null || liveness.lastHeartbeatMono === null ||
        at - liveness.lastHeartbeatMono > HEARTBEAT_INTERVAL_MS * 2) liveness.continuousSinceMono = at;
    liveness.lastHeartbeatMono = at;
    liveness.heartbeatsConfirmed += 1;
    liveness.longestContinuousMs = Math.max(liveness.longestContinuousMs, Math.floor(at - liveness.continuousSinceMono));
  }
  const readyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  readyPromise.catch(() => {}); // Constructor/early owner cancellation may fail before await is installed.
  const current = () => !signal?.aborted && isCurrent() === true;
  const isOpen = () => !closing && entered && current() && socket?.readyState === WebSocketClass.OPEN;
  const rejectPending = error => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  const stopTimers = () => { clearInterval(heartbeatTimer); clearInterval(pingTimer); heartbeatTimer = null; pingTimer = null; };
  const notifyClose = code => {
    if (closeNotified || !entered) return;
    closeNotified = true;
    try { onClosed?.({ code, intentional: intentionalClose, connectionEpoch }); } catch { /* Close remains final. */ }
  };
  const notifyPhysicalClose = socketCode => {
    if (physicalCloseNotified) return;
    physicalCloseNotified = true;
    const code = closeReason || 'SOCKET_' + socketCode;
    try { onPhysicalClosed?.({ code, socketCode: 'SOCKET_' + socketCode, intentional: intentionalClose, physicalClosed: true, connectionEpoch }); } catch { /* Physical close remains final. */ }
  };
  function observe(observation) {
    if (!current() || closing || !onObservation) return;
    try {
      const result = onObservation(freeze(clone(observation)));
      if (result && typeof result.then === 'function') result.catch(() => close('PROTOCOL_OBSERVATION_FAILED', false));
    } catch { close('PROTOCOL_OBSERVATION_FAILED', false); }
  }
  function close(code = 'PROTOCOL_CLOSED_BY_OWNER', intentional = true) {
    if (closePromise) return closePromise;
    closing = true; intentionalClose = intentional; closeReason = code;
    liveness.closedMono ??= monotonicMs();
    stopTimers(); signal?.removeEventListener('abort', abort);
    readyReject(closedError(code)); rejectPending(closedError(code, true));
    closePromise = new Promise(resolve => { closeResolve = resolve; });
    notifyClose(code);
    if (!socket || socket.readyState === WebSocketClass.CLOSED) closeResolve({ closed: true, code, connectionEpoch });
    else {
      closeTimer = setTimeout(() => { try { socket.terminate(); } catch { /* Already closed. */ } }, 2000);
      closeTimer.unref?.();
      try { socket.close(); } catch { try { socket.terminate(); } catch { /* Close event or timeout settles. */ } }
    }
    return closePromise;
  }
  const abort = () => { close('PROTOCOL_CANCELLED', true); };
  function request(method, params, { token = rpcToken, permit = null, timeoutMs = REQUEST_TIMEOUT_MS, control = false, normalSyncProbe = false } = {}) {
    if (!current() || closing || socket?.readyState !== WebSocketClass.OPEN || !opened || !control && !entered) throw closedError();
    const requestSequence = ++sequence;
    if (!Number.isSafeInteger(requestSequence)) throw problem('PROTOCOL_SEQUENCE_EXHAUSTED', '当前连接请求序号已耗尽');
    const wireKey = `ws|${Date.now()}|${requestSequence}`;
    const frame = buildRequestFrame({ method, args: params, token, wireKey });
    const parameterFingerprint = paramsFingerprint(params);
    let resolve;
    let reject;
    const responsePromise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const sentDeviceMs = Date.now();
    const sentMonotonicMs = monotonicMs();
    const timer = setTimeout(() => {
      pending.delete(wireKey);
      reject(Object.assign(problem('PROTOCOL_RPC_TIMEOUT', '官服请求未在本次期限内返回'), { transportFailure: true, mayHaveSent: true, method, wireKey, requestSequence }));
      // A consumed business permit cannot continue to own an open ambiguous
      // transport. Real closure precedes the supervisor's bounded recovery.
      if (permit) void close('PROTOCOL_RPC_TIMEOUT', false);
    }, timeoutMs);
    timer.unref?.();
    pending.set(wireKey, { method, wireKey, requestSequence, sentDeviceMs, sentMonotonicMs,
      operationId: permit?.operationId ?? null, resolve, reject, timer });
    try {
      if (!current() || closing || socket.readyState !== WebSocketClass.OPEN) throw closedError();
      if (permit) {
        // Everything needed to serialize the immutable frame is computed before
        // claim. This synchronous final fence and ws.send have no intervening await.
        if (typeof permit.claim !== 'function' || permit.claim({ method, paramsFingerprint: parameterFingerprint, connectionEpoch, wireKey, requestSequence }) !== true) throw problem('PROTOCOL_PERMIT_REJECTED', '发送凭证已失效');
        socket.send(frame, error => { if (error) { const item = pending.get(wireKey); if (item) { clearTimeout(item.timer); pending.delete(wireKey); item.reject(closedError('PROTOCOL_SEND_FAILED', true)); } void close('PROTOCOL_SEND_FAILED', false); } });
        // This is a local socket API dispatch timestamp, not proof of network
        // arrival. It is synchronous and follows ws.send() with no await gap.
        try { permit.dispatched?.({ method, connectionEpoch, wireKey, requestSequence }); } catch { /* the already-sent operation stays immutable */ }
      } else if (control || READ_METHODS.includes(method) || normalSyncProbe && method === NORMAL_LOGIN_SYNC_PROBE_METHOD) {
        socket.send(frame, error => { if (error) { const item = pending.get(wireKey); if (item) { clearTimeout(item.timer); pending.delete(wireKey); item.reject(closedError('PROTOCOL_SEND_FAILED', true)); } void close('PROTOCOL_SEND_FAILED', false); } });
      } else throw problem('PROTOCOL_PERMIT_REQUIRED', '业务发送必须经过统一持久发送网关');
    } catch (error) {
      clearTimeout(timer); pending.delete(wireKey);
      // Synchronous rejection must reach the gateway before it records a frame
      // as transmitted. Avoid leaving an orphan rejected promise on this path.
      responsePromise.catch(() => {}); reject(error); throw error;
    }
    return responsePromise;
  }
  function response(frame, item, source = 'response') {
    const envelope = decodeEnvelope(frame);
    const metadata = envelope.envelopeOk ? extractSessionMetadata(envelope.value, envelope.dsName) : {};
    if (metadata.token) rpcToken = metadata.token;
    const receivedDeviceMs = Date.now();
    const value = observationValue(envelope.value, envelope.dsName);
    const responseRef = `official-response:${newId()}`;
    if (source === 'response' && item?.method === 'index.login' && envelope.envelopeOk && envelope.dsName === SYNC_DATA_TYPE) {
      versionEvidence = freeze({ source: 'normal-package-hop-and-matched-world-login/v1',
        clientChannel: typeof auth.chnId === 'string' && auth.chnId.length <= 128 || Number.isSafeInteger(auth.chnId) ? auth.chnId : null,
        gameVersion: auth.publicResources?.gameVersion ?? null,
        protocolVersion: typeof metadata.version === 'string' && /^[0-9]+(?:\.[0-9]+){1,5}$/.test(metadata.version) ? metadata.version : null,
        reportedServerVersion: typeof metadata.reportedServerVersion === 'string' && /^[0-9]+(?:\.[0-9]+){1,5}$/.test(metadata.reportedServerVersion)
          ? metadata.reportedServerVersion : null,
        loginResponseRef: responseRef });
    }
    return { responseRef, transport: source === 'push' ? 'push' : 'answered', method: item?.method ?? null, operationId: item?.operationId ?? null,
      wireKey: item?.wireKey ?? (source === 'late' && typeof frame.k === 'string' && frame.k.length <= 128 ? frame.k : null), connectionEpoch, source,
      sentDeviceMs: item?.sentDeviceMs ?? null, receivedDeviceMs,
      requestSequence: item?.requestSequence ?? null, sentMonotonicMs: item?.sentMonotonicMs ?? null, receivedMonotonicMs: monotonicMs(),
      versionEvidence,
      envelopeOk: envelope.envelopeOk, envelopeReason: envelope.envelopeReason ?? null,
      dsName: envelope.dsName ?? null, value, rejected: envelope.rejected === true,
      messagePresent: envelope.messagePresent === true, noticeOnly: envelope.noticeOnly === true,
      remoteCode: envelope.remoteCode ?? null, remoteKey: envelope.remoteKey ?? null,
      serverReceivedMs: envelope.serverReceivedMs ?? null, serverRespondedMs: envelope.serverRespondedMs ?? null,
      serverMs: metadata.serverMs ?? null, protocolVersion: metadata.version ?? null,
      reportedServerVersion: metadata.reportedServerVersion ?? null };
  }
  let readyTimer;
  try {
    if (!current()) throw closedError('PROTOCOL_CANCELLED');
    socket = new WebSocketClass(`wss://${endpoint.host}:${endpoint.port}/?sgid=${auth.serverId}`, {
      ...(proxy ? { agent: new ProxyAgentClass(proxy) } : {}),
      perMessageDeflate: false, maxPayload: FRAME_LIMIT_BYTES, handshakeTimeout: REQUEST_TIMEOUT_MS,
    });
    socket.on('message', data => {
      if (!current() || closing) return;
      let messages;
      try { messages = parseSocketDocuments(data); }
      catch { close('PROTOCOL_FRAME_INVALID', false); return; }
      for (const message of messages) {
        if (!current() || closing) break;
        if (message === 'connectionEnabled') { opened = true; readyResolve(); continue; }
        if (!plainObject(message)) continue;
        if (message.e === 'response' && plainObject(message.d)) {
          const item = pending.get(message.d.k);
          if (!item) {
            // This socket still owns the current epoch, so a decodable IOther
            // can rotate its private token. Preserve the late wire evidence
            // without settling any pending request or assigning its method.
            try { observe(response(message.d, null, 'late')); } catch { /* Unsupported late envelopes create no fact. */ }
            continue;
          }
          pending.delete(item.wireKey); clearTimeout(item.timer);
          try {
            const result = response(message.d, item);
            if (isRegisteredWriteMethod(item.method)) {
              matchedWriteResponses.set(result.responseRef, freeze({ connectionEpoch, requestSequence: item.requestSequence, wireKey: item.wireKey }));
              if (matchedWriteResponses.size > 64) matchedWriteResponses.delete(matchedWriteResponses.keys().next().value);
            }
            observe(result);
            item.resolve(freeze(result));
          } catch { item.resolve({ responseRef: `official-response:${newId()}`, transport: 'answered', method: item.method, wireKey: item.wireKey,
            connectionEpoch, requestSequence: item.requestSequence, source: 'response', sentDeviceMs: item.sentDeviceMs, sentMonotonicMs: item.sentMonotonicMs,
            receivedDeviceMs: Date.now(), receivedMonotonicMs: monotonicMs(), envelopeOk: false, envelopeReason: 'RESPONSE_DECODE_FAILED', value: null, rejected: false }); }
        } else if (plainObject(message.d) && Object.hasOwn(message.d, 'v')) {
          try { observe(response(message.d, null, 'push')); } catch { /* Unsupported push creates no fact. */ }
        }
      }
    });
    socket.on('error', () => { readyReject(closedError('PROTOCOL_CONNECT_FAILED')); rejectPending(closedError('PROTOCOL_TRANSPORT_FAILED', true)); void close('PROTOCOL_CONNECT_FAILED', false); });
    socket.on('close', code => {
      closing = true; stopTimers(); clearTimeout(readyTimer); clearTimeout(closeTimer); signal?.removeEventListener('abort', abort);
      readyReject(closedError('PROTOCOL_CONNECTION_CLOSED')); rejectPending(closedError('PROTOCOL_CONNECTION_CLOSED', true));
      notifyClose(`SOCKET_${code}`); notifyPhysicalClose(code); closeResolve?.({ closed: true, code: `SOCKET_${code}`, connectionEpoch });
    });
    readyTimer = setTimeout(() => { readyReject(closedError('PROTOCOL_READY_TIMEOUT')); void close('PROTOCOL_READY_TIMEOUT', false); }, REQUEST_TIMEOUT_MS);
    readyTimer.unref?.(); signal?.addEventListener('abort', abort, { once: true });
    await readyPromise; clearTimeout(readyTimer);
    if (!current()) throw closedError('PROTOCOL_CANCELLED');
    const initial = await request('index.login', captureParams(worldLoginArgs(auth)), { token: null, control: true, timeoutMs: 45000 });
    if (closing || !current() || socket.readyState !== WebSocketClass.OPEN) throw closedError(closeReason || 'PROTOCOL_WORLD_LOGIN_CLOSED', true);
    if (!initial.envelopeOk || initial.dsName !== SYNC_DATA_TYPE || initial.rejected || initial.messagePresent && !initial.noticeOnly) {
      throw Object.assign(problem('PROTOCOL_WORLD_LOGIN_UNCONFIRMED', '世界登录没有形成可核实的本次会话'), {
        remoteCode: Number.isSafeInteger(initial.remoteCode) ? initial.remoteCode : null,
        remoteKey: typeof initial.remoteKey === 'string' && /^\$?[A-Za-z][A-Za-z0-9_]{0,39}$/.test(initial.remoteKey) ? initial.remoteKey : null,
        envelopeReason: typeof initial.envelopeReason === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(initial.envelopeReason) ? initial.envelopeReason : null,
        messagePresent: initial.messagePresent === true,
      });
    }
    // Captured world protocol uses the returned IOther token when present;
    // otherwise the gateway session plus the selected server forms its RPC token.
    // This is a session-format rule, never a reason to re-enter the world.
    rpcToken ||= `${auth.sessionToken}|${auth.serverId}`;
    entered = true;
    liveness.openedMono = monotonicMs();
    const tlsSocket = socket?._socket;
    const privateEndpointIdentity = Object.freeze({ source: 'tls-socket-after-matched-world-login/v1',
      sourceMethod: auth.endpointEvidence?.sourceMethod ?? null, parser: auth.endpointEvidence?.parser ?? null,
      parsedEndpointsFingerprint: auth.endpointEvidence?.parsedEndpointsFingerprint ?? null,
      observedAt: auth.endpointEvidence?.observedAt ?? null, selectedHost: endpoint.host, selectedPort: endpoint.port,
      localAddress: typeof tlsSocket?.localAddress === 'string' && isIP(tlsSocket.localAddress) ? tlsSocket.localAddress : null,
      localPort: Number.isSafeInteger(tlsSocket?.localPort) && tlsSocket.localPort > 0 && tlsSocket.localPort <= 65535 ? tlsSocket.localPort : null,
      remoteAddress: typeof tlsSocket?.remoteAddress === 'string' && isIP(tlsSocket.remoteAddress) ? tlsSocket.remoteAddress : null,
      remotePort: Number.isSafeInteger(tlsSocket?.remotePort) && tlsSocket.remotePort > 0 && tlsSocket.remotePort <= 65535 ? tlsSocket.remotePort : null,
      proxyConfigured: typeof proxy === 'string' && proxy.length > 0 });
    const context = freeze({ aid: auth.aid, serverId: auth.serverId, connectionEpoch,
      endpoint: `${endpoint.host}:${endpoint.port}`, loginObservation: initial, authenticationObservations: auth.observations,
      privateEndpointIdentity,
      publicResources: auth.publicResources ?? null,
      adPlaybackRouting: auth.publicResources?.adPlaybackRouting ?? { source: 'official-sdk-effective-ad-route/v1', known: false,
        openAdRewardSdk: { known: false, value: null, source: null }, nativeAbSwitch: { known: false, value: null, source: null } },
      versionEvidence });
    function orderVideoRequestRouting() {
      const input = context.adPlaybackRouting;
      const open = input?.openAdRewardSdk, native = input?.nativeAbSwitch;
      const valid = input?.known === true && open?.known === true && typeof open.value === 'boolean' &&
        native?.known === true && typeof native.value === 'boolean';
      return Object.freeze({ source: 'official-sdk-effective-ad-route/v1', known: valid,
        openAdRewardSdk: Object.freeze({ known: valid, value: valid ? open.value : null }),
        nativeAbSwitch: Object.freeze({ known: valid, value: valid ? native.value : null }),
        ...(valid ? { proofRef: `normal-sdk-route-connection-${connectionEpoch}` } : {}) });
    }
    const connection = {
      context, isOpen,
      orderVideoRequestRouting,
      probeNormalLoginSync() {
        if (!isOpen() || normalLoginSyncProbed || businessWritePrepared || versionEvidence?.gameVersion !== '480.0.27' || versionEvidence.protocolVersion !== '480.0.0') throw problem('NORMAL_LOGIN_SYNC_PROBE_NOT_AVAILABLE', '当前连接不满足一次正常登录同步取证边界');
        normalLoginSyncProbed = true;
        return request(NORMAL_LOGIN_SYNC_PROBE_METHOD, {}, { normalSyncProbe: true });
      },
      probeNormalRelogin() {
        // G480 [253731,254011) uses _enter(true) on the existing GS socket;
        // [254441,255753) keeps the original GW body token and current outer
        // token. No account material leaves this private transport closure.
        if (!isOpen() || normalReloginProbed || businessWritePrepared || pending.size || heartbeatInFlight || versionEvidence?.gameVersion !== '480.0.27' || versionEvidence.protocolVersion !== '480.0.0') throw problem('NORMAL_RELOGIN_PROBE_NOT_AVAILABLE', '当前连接不满足一次正常同连接重登取证边界');
        normalReloginProbed = true;
        return request('index.reLogin', captureParams(worldLoginArgs(auth)), { control: true, timeoutMs: 45000 });
      },
      read(method, args = {}, { after = null } = {}) {
        if (!READ_METHODS.includes(method)) throw problem('PROTOCOL_READ_NOT_REGISTERED', '此方法没有进入已审只读名单', 400);
        const params = captureParams(args);
        if (Object.keys(params).length !== 0) throw problem('PROTOCOL_READ_ARGUMENT_INVALID', '当前土地读取合同只允许空参数', 400);
        if (after !== null) {
          const actual = after && matchedWriteResponses.get(after.responseRef);
          if (!actual || actual.connectionEpoch !== connectionEpoch || after.connectionEpoch !== connectionEpoch ||
              actual.wireKey !== after.wireKey || actual.requestSequence !== after.requestSequence || sequence < actual.requestSequence) {
            throw problem('PROTOCOL_AFTER_WRITE_BARRIER_INVALID', '独立写后读取缺少本连接真实匹配回包依据');
          }
        }
        return request(method, params);
      },
      prepareWrite(method, args) {
        if (!isRegisteredWriteMethod(method)) throw problem('PROTOCOL_WRITE_NOT_REGISTERED', '此方法没有进入本阶段业务传输名单', 400);
        businessWritePrepared = true;
        const params = captureParams(args);
        const parameterFingerprint = paramsFingerprint(params);
        let used = false;
        return Object.freeze({ method, paramsFingerprint: parameterFingerprint,
          send(permit) {
            if (used) throw problem('PROTOCOL_FRAME_ALREADY_USED', '同一准备帧不可再次发送');
            if (!permit || typeof permit.claim !== 'function') throw problem('PROTOCOL_PERMIT_REQUIRED', '业务发送缺少统一网关凭证');
            used = true;
            return request(method, params, { permit });
          } });
      },
      heartTick() { return request('usr.heartTick', captureParams({}), { control: true }); },
      ping() { if (!isOpen()) return false; socket.ping(); return true; },
      liveness() { return freeze({ openedMono: liveness.openedMono, closedMono: liveness.closedMono,
        heartbeatsConfirmed: liveness.heartbeatsConfirmed, longestContinuousMs: liveness.longestContinuousMs,
        lastHeartbeatMono: liveness.lastHeartbeatMono }); },
      close,
    };
    heartbeatTimer = setInterval(async () => {
      if (heartbeatInFlight || !isOpen()) return;
      heartbeatInFlight = true;
      try {
        const reply = await connection.heartTick();
        if (!reply.envelopeOk || reply.rejected) close('PROTOCOL_HEARTBEAT_REJECTED', false);
        else heartbeatConfirmed();
      } catch { close('PROTOCOL_HEARTBEAT_FAILED', false); }
      finally { heartbeatInFlight = false; }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
    pingTimer = setInterval(() => { try { connection.ping(); } catch { close('PROTOCOL_PING_FAILED', false); } }, HEARTBEAT_INTERVAL_MS);
    pingTimer.unref?.();
    return Object.freeze(connection);
  } catch (error) {
    clearTimeout(readyTimer);
    const closed = await close('PROTOCOL_START_FAILED', true);
    if (error && typeof error === 'object') {
      error.transportClosed = closed?.closed === true && closed.connectionEpoch === connectionEpoch;
      error.closedConnectionEpoch = closed?.connectionEpoch;
      error.closeEvidenceCode = closed?.code;
    }
    throw error;
  }
}

async function defaultLoadTransportDependencies() {
  const [{ default: WebSocket }, { HttpsProxyAgent }] = await Promise.all([import('ws'), import('https-proxy-agent')]);
  return { WebSocket, HttpsProxyAgent };
}

export function createWorldConnector({ authenticate = authenticateGame,
  loadTransportDependencies = defaultLoadTransportDependencies, preferences = defaultEndpointPreferences } = {}) {
  if (typeof authenticate !== 'function' || typeof loadTransportDependencies !== 'function' ||
      typeof preferences?.order !== 'function' || typeof preferences?.failed !== 'function' || typeof preferences?.succeeded !== 'function') {
    throw new TypeError('World connector requires authentication, transport-dependency and preference ports');
  }
  return async function connectGame({ account, ownerRef = null, subjectRef = null, allowEndpointPreference = true, signal, isCurrent, isTransportOwnerCurrent = isCurrent,
    onClosed, onObservation, proxy = '', deviceProfilePath, connectionEpoch } = {}) {
    if (typeof isCurrent !== 'function' || !Number.isSafeInteger(connectionEpoch) || connectionEpoch < 1) throw problem('PROTOCOL_OWNER_CONTEXT_REQUIRED', '官服连接必须绑定当前执行权和连接代际');
    let auth;
    try {
      if (signal?.aborted || !isCurrent()) throw closedError('PROTOCOL_CANCELLED');
      auth = await authenticate({ account, signal, isCurrent, proxy, deviceProfilePath });
    } catch (error) {
      if (error && typeof error === 'object') {
        error.transportClosed = true; error.closedConnectionEpoch = connectionEpoch;
        error.closeEvidenceCode = 'PROTOCOL_AUTH_NO_WORLD'; error.worldSocketOpened = false;
      }
      throw error;
    }
    const closeBeforeWorld = (error, fallbackCode = 'PROTOCOL_PRE_WORLD_FAILED') => {
      const failure = error && typeof error === 'object' ? error : problem(fallbackCode, String(error ?? fallbackCode), 503);
      failure.transportClosed = true;
      failure.closedConnectionEpoch = connectionEpoch;
      failure.closeEvidenceCode = typeof failure.code === 'string' ? failure.code : fallbackCode;
      failure.worldSocketOpened = false;
      return failure;
    };
    let dependencies, WebSocketClass, ProxyAgentClass, endpoints, endpoint;
    try {
      if (signal?.aborted || !isCurrent()) throw closedError('PROTOCOL_CANCELLED');
      dependencies = await loadTransportDependencies();
      if (signal?.aborted || !isCurrent()) throw closedError('PROTOCOL_CANCELLED');
      WebSocketClass = dependencies?.WebSocket; ProxyAgentClass = dependencies?.HttpsProxyAgent;
      if (typeof WebSocketClass !== 'function' || proxy && typeof ProxyAgentClass !== 'function') {
        throw problem('PROTOCOL_TRANSPORT_DEPENDENCIES_INVALID', '官服传输运行依赖不可用', 503);
      }
      endpoints = allowEndpointPreference ? preferences.order({ ownerRef, subjectRef, connectionEpoch, endpoints: auth.endpoints }) : auth.endpoints.slice();
      if (!endpoints.length) throw problem('PROTOCOL_ENDPOINT_MISSING', '本次官服查询未给可用TLS世界服端点');
      endpoint = endpoints[0];
    } catch (error) {
      throw closeBeforeWorld(error);
    }
    const reportFailure = (reason, physicalCloseProved) => {
      if (!allowEndpointPreference || typeof isTransportOwnerCurrent !== 'function' || !isTransportOwnerCurrent() || physicalCloseProved !== true ||
          !routeFailure(reason, { physicalClosed: true }) || reason?.intentional === true) return;
      preferences.failed({ ownerRef, subjectRef, endpoint, connectionEpoch, physicalCloseProved: true });
    };
    try {
      const connection = await openWorld({ auth, endpoint, proxy, signal, isCurrent, connectionEpoch, onObservation,
        WebSocketClass, ProxyAgentClass,
        onClosed: reason => onClosed?.(reason),
        onPhysicalClosed: reason => {
          if (reason?.connectionEpoch === connectionEpoch && reason.physicalClosed === true) reportFailure(reason, true);
        } });
      if (!isCurrent()) {
        const closed = await connection.close();
        if (closed?.closed !== true || closed.connectionEpoch !== connectionEpoch) throw problem('PROTOCOL_CANCELLED', '连接建立后执行权已变化且物理关闭未确认');
        throw problem('PROTOCOL_CANCELLED', '当前游戏连接启动已取消');
      }
      if (allowEndpointPreference) preferences.succeeded({ ownerRef, subjectRef, connectionEpoch });
      return connection;
    } catch (error) {
      const closed = error?.transportClosed === true && error.closedConnectionEpoch === connectionEpoch;
      reportFailure(error, closed);
      throw error;
    }
  };
}
export const connectGame = createWorldConnector();
