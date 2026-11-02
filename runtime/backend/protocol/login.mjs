import path from 'node:path';
import { fingerprint, plainObject, problem } from '../common.mjs';
import {
  ANDROID_AUTH_DEFAULTS, androidDeviceContext, readAndroidDeviceProfile, buildAndroidAccountLoginBody,
  assertV5LoginBodyKeys, buildAndroidAccountRequestAttempt, buildAndroidAccountLoginHeaders,
  decryptAndroidAccountResponse, parseAndroidAccountHandoff, queryPackageConfigHop, clientInfoHop,
  queryInitParamsHop, buildAndroidSdkLoginBody, parseAndroidSdkCredentials, requestJson, freshSdkSession0,
} from '../../../vendor/garden-engine/server/src/game/android-auth.js';
import { withAndroidLoginSignal } from '../../../vendor/garden-engine/server/src/game/android-login-context.js';
import { buildPayload } from './codec.mjs';
import { createEffectiveAdPlaybackRouteCollector } from './ad-login-route.mjs';

const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
function publicResourceConfiguration(body) {
  const cleanUrl = value => {
    if (typeof value !== 'string' || value.length > 2048) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
      return url.href;
    } catch { return null; }
  };
  const data = plainObject(body?.data) ? body.data : {}, zip = plainObject(data.zipConfig) ? data.zipConfig : {};
  const cdnList = Array.isArray(zip.cdnList) ? zip.cdnList.map(cleanUrl).filter(Boolean).slice(0, 12) : [];
  const entryUrl = cleanUrl(body?.url), gameVersion = [data.gameConfig?.gameVersion, body?.userParams?.gameVersion]
    .find(value => typeof value === 'string' && /^[0-9]+(?:\.[0-9]+){1,5}$/.test(value)) ?? null;
  return { source: 'normal-auth-package-hop-public-config/v1', observedAt: new Date().toISOString(),
    available: entryUrl !== null || cdnList.length > 0, entryUrl, cdnList, gameVersion };
}
function check(signal, isCurrent) {
  if (signal?.aborted || isCurrent && !isCurrent()) throw problem('PROTOCOL_CANCELLED', '当前游戏连接启动已取消');
}
function configurationValueType(value) {
  return value === undefined ? 'absent' : value === null ? 'null' : Array.isArray(value) ? 'array'
    : plainObject(value) ? 'object' : ['string', 'number', 'boolean'].includes(typeof value) ? typeof value : 'other';
}
function adResponseSummary(body, statusCode) {
  const http = statusCode !== undefined && statusCode !== null && Number.isSafeInteger(Number(statusCode))
    ? Number(statusCode) : null;
  const httpStatus = http !== null && http >= 100 && http <= 599 ? http : null;
  const hasCode = plainObject(body) && Object.prototype.hasOwnProperty.call(body, 'code');
  const rawCode = hasCode ? body.code : null;
  const officialCode = typeof rawCode === 'number' && Number.isSafeInteger(rawCode) ||
    typeof rawCode === 'string' && /^[0-9]{1,10}$/.test(rawCode) ? Number(rawCode) : null;
  const rawStatus = plainObject(body) ? body.status : undefined;
  const status = rawStatus === undefined ? 'absent' : rawStatus === 1 || rawStatus === '1' ? 'numeric-success'
    : typeof rawStatus === 'string' && rawStatus.trim().toLowerCase() === 'success' ? 'success'
      : typeof rawStatus === 'string' && /^(?:fail|failed|error)$/i.test(rawStatus.trim()) ? 'fail' : 'other';
  const dataType = configurationValueType(plainObject(body) ? body.data : undefined);
  return { httpStatus, officialCode, codeProvided: hasCode, status, dataType,
    bodyType: configurationValueType(body), abConfigType: configurationValueType(plainObject(body) ? body.ab_config : undefined),
    ...(plainObject(body) && Array.isArray(body.ab_config) ? { abConfigLength: body.ab_config.length } : {}) };
}
function successfulSdkLoginParamsCallback(body, summary) {
  // G480 newSend normalizes status success/1 to 1 and reports `fail` or a
  // truthy bizCode as its callback error. _queryLoginParams accepts when that
  // error is absent and data exists; the unrelated `code` field is not a gate.
  const httpOk = summary.httpStatus !== null && summary.httpStatus >= 200 && summary.httpStatus < 300;
  const statusOk = ['success', 'numeric-success', 'absent'].includes(summary.status);
  const callbackError = plainObject(body) && Object.hasOwn(body, 'status') && Boolean(body.bizCode);
  return httpOk && statusOk && !callbackError && plainObject(body?.data);
}
function phaseFailure(phase, error) {
  const safeCode = typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'PROTOCOL_LOGIN_FAILED';
  const result = problem(safeCode, `${phase}未完成（${safeCode}）`);
  result.phase = phase;
  result.sourceNamespace = phase === '官服账号认证' ? 'v5-account' : phase === '渠道会话兑换' ? 'sdk-login' : undefined;
  result.transportFailure = error?.transportFailure === true;
  if (Number.isSafeInteger(error?.remoteCode)) result.remoteCode = error.remoteCode;
  if (Number.isSafeInteger(error?.loginCode)) result.loginCode = error.loginCode;
  if (Number.isSafeInteger(error?.retryAfterMs) && error.retryAfterMs >= 1000) result.retryAfterMs = error.retryAfterMs;
  if (typeof error?.loginCodeKey === 'string' && /^[A-Za-z_][A-Za-z0-9_.]{1,40}$/.test(error.loginCodeKey)) result.loginCodeKey = error.loginCodeKey;
  if (typeof error?.transportCode === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.transportCode)) result.transportCode = error.transportCode;
  if (typeof error?.loginKind === 'string' && /^[a-z_]{2,40}$/.test(error.loginKind)) result.loginKind = error.loginKind;
  return result;
}
function parseEndpoints(body) {
  const list = [body?.v?.['6']?.['2'], body?.v?.['6']?.gsInfoList, body?.v?.gsInfoList, body?.v?.servers].find(Array.isArray) || [];
  const seen = new Set();
  const endpoints = [];
  for (const value of list) {
    if (!plainObject(value)) continue;
    const host = text(value['0'] ?? value.host);
    const port = Number(value['2'] ?? value.port_ssl ?? value.portSsl);
    const status = value['4'] ?? value.status;
    if (!host || !/^[A-Za-z0-9.-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535 || status !== undefined && Number(status) <= 0) continue;
    const key = `${host}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key); endpoints.push({ host, port });
  }
  return endpoints;
}

// Authentication is deliberately explicit and single-attempt. The caller owns
// retry/egress selection and must retain the same account's unique read owner.
export async function authenticateGame({ account, proxy = '', deviceProfilePath, signal, isCurrent } = {}) {
  if (!plainObject(account) || !text(account.username) || !text(account.password)) throw problem('PROTOCOL_CREDENTIALS_MISSING', '缺少受保护来源的既有游戏凭据');
  if (typeof deviceProfilePath !== 'string' || !path.isAbsolute(deviceProfilePath)) throw problem('PROTOCOL_DEVICE_PROFILE_MISSING', '必须指定当前设备档案的绝对路径');
  const profile = readAndroidDeviceProfile(deviceProfilePath);
  const deviceId = text(profile?.equipment?.deviceId) ?? text(profile?.deviceId);
  if (!profile || !deviceId) throw problem('PROTOCOL_DEVICE_PROFILE_INVALID', '当前设备档案缺少真实设备标识');
  const device = androidDeviceContext([], { profile, deviceId, appVersion: ANDROID_AUTH_DEFAULTS.appVersion });
  const chnId = ANDROID_AUTH_DEFAULTS.chnId;
  const appVersion = device.appVersion;
  const observations = [];
  let publicResources = null;
  let publicResourceBase = null;
  const adPlaybackRoute = createEffectiveAdPlaybackRouteCollector();
  function updatePublicResourceShape() {
    if (publicResourceBase) publicResources = { ...publicResourceBase, adPlaybackRouting: adPlaybackRoute.snapshot() };
  }
  function capturePublicResourceShape(source, body, responseSummary = null) {
    adPlaybackRoute.capture(source, body, responseSummary);
    if (source === 'queryPackageConfig') publicResourceBase = publicResourceConfiguration(body);
    updatePublicResourceShape();
  }
  function markPublicResourceShapeUnknown(source, reasonCode, responseSummary = null) {
    updatePublicResourceShape();
  }
  return withAndroidLoginSignal(signal, async () => {
    async function phase(label, action) {
      check(signal, isCurrent);
      try { const value = await action(); check(signal, isCurrent); observations.push({ phase: label, state: 'answered', observedAt: new Date().toISOString() }); return value; }
      catch (error) { throw phaseFailure(label, error); }
    }
    // Some legacy hop parsers contain a host fallback loop. This adapter permits
    // exactly one real HTTP request per hop; subsequent loop entries cannot send.
    function singleHopRequest({ capturePublicResources = null } = {}) {
      let sent = false;
      let firstError = null;
      return async (host, requestPath, body, options = {}) => {
        if (sent) throw firstError || problem('PROTOCOL_IMPLICIT_RETRY_BLOCKED', '本次认证不自动切域或重发');
        check(signal, isCurrent); sent = true;
        try {
          const result = await requestJson(host, requestPath, body, { ...options, proxy, signal });
          if (capturePublicResources) capturePublicResourceShape(capturePublicResources, result.body);
          check(signal, isCurrent); return result;
        } catch (error) { firstError = error; throw error; }
      };
    }
    const session0 = freshSdkSession0();
    const packageConfig = await phase('渠道入场参数', () => queryPackageConfigHop({ device, session0, appVersion, proxy }, { request: singleHopRequest({ capturePublicResources: 'queryPackageConfig' }) }));
    if (!packageConfig.uuid) throw problem('PROTOCOL_UUID_MISSING', '官服未下发本次入场参数');
    let clientIp;
    try { clientIp = (await phase('渠道出口信息', () => clientInfoHop({ proxy }, { request: singleHopRequest() }))).clientIp; }
    catch (error) {
      check(signal, isCurrent);
      if (!error.transportFailure) throw error;
      observations.push({ phase: '渠道出口信息', state: 'unavailable', reasonCode: error.code });
    }
    const preflight = await phase('渠道前置信息', () => queryInitParamsHop({ uuid: packageConfig.uuid, chnId, gameId: ANDROID_AUTH_DEFAULTS.gameId, proxy }, { request: singleHopRequest({ capturePublicResources: 'queryInitParams' }) }));
    clientIp ||= preflight.ip;
    const loginBody = buildAndroidAccountLoginBody({ username: account.username, password: account.password,
      deviceId, device, appVersion, passwordEncoded: account.passwordEncoded === true });
    assertV5LoginBodyKeys(loginBody);
    const { secureRequest } = buildAndroidAccountRequestAttempt(loginBody);
    const accountResponse = await phase('官服账号认证', () => requestJson(ANDROID_AUTH_DEFAULTS.accountHost, ANDROID_AUTH_DEFAULTS.accountLoginPath, secureRequest.body, {
      proxy, signal, headers: buildAndroidAccountLoginHeaders({ deviceId, appVersion, nonce: secureRequest.headers.nonce, ivVersion: secureRequest.headers.requestSecurityIvVersion }),
    }));
    let handoff;
    try { handoff = parseAndroidAccountHandoff({ ...accountResponse, body: decryptAndroidAccountResponse(accountResponse.body, secureRequest.context) }); }
    catch (error) { throw phaseFailure('官服账号认证', error); }
    const sdkBody = buildAndroidSdkLoginBody({ handoff, device, packageId: packageConfig.plain?.packageId || ANDROID_AUTH_DEFAULTS.packageId,
      uuid: packageConfig.uuid, clientIp, gameVersion: packageConfig.plain?.gameVersion });
    const sdkHost = packageConfig.host;
    const sdkResponse = await phase('渠道会话兑换', () => requestJson(sdkHost, `/game/login/mdcl/c${chnId}/mdgid/${ANDROID_AUTH_DEFAULTS.gameId}/env/prod`, sdkBody, { proxy, signal }));
    capturePublicResourceShape('SDKlogin', sdkResponse.body);
    let sdk;
    try { sdk = parseAndroidSdkCredentials(sdkResponse); }
    catch (error) { throw phaseFailure('渠道会话兑换', error); }
    const loginUserParams = plainObject(sdkResponse?.body?.userParams) ? sdkResponse.body.userParams : null;
    const loginParamsPresent = loginUserParams !== null && Object.keys(loginUserParams).length > 0;
    let effectiveUserParams = loginUserParams;
    let effectiveParamsSource = 'SDKlogin.userParams';
    let routeParamsKnown = loginParamsPresent;
    if (!loginParamsPresent && packageConfig.uuid) {
      // The official SDK calls queryLoginParams only when login returned no
      // nonempty userParams and this normal package hop supplied a UUID. UUID
      // is a precondition, not a wire field: newSend sends lang plus token.
      const paramsPath = `/game/queryLoginParams/mdcl/c${chnId}/mdgid/${ANDROID_AUTH_DEFAULTS.gameId}/env/prod`;
      let result = null, failureCode = null;
      try {
        check(signal, isCurrent);
        result = await requestJson(sdkHost, paramsPath, { lang: sdkBody.lang, token: sdk.sdkToken },
          { proxy, signal, timeoutMs: 10000 });
        check(signal, isCurrent);
      } catch (error) {
        if (error?.code === 'PROTOCOL_CANCELLED' || error?.code === 'REAL_ABORTED' || signal?.aborted || isCurrent && !isCurrent()) {
          if (error?.code === 'PROTOCOL_CANCELLED') throw error;
          throw problem('PROTOCOL_CANCELLED', '当前游戏连接启动已取消');
        }
        failureCode = typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code)
          ? error.code : 'SDK_LOGIN_PARAMS_QUERY_UNAVAILABLE';
      }
      if (failureCode) {
        const httpStatus = Number.isSafeInteger(Number(result?.statusCode)) && Number(result.statusCode) >= 100 && Number(result.statusCode) <= 599
          ? Number(result.statusCode) : null;
        const summary = { httpStatus, officialCode: null, codeProvided: false, status: 'absent', dataType: 'absent' };
        markPublicResourceShapeUnknown('queryLoginParams', 'SDK_LOGIN_PARAMS_QUERY_UNAVAILABLE', summary);
        observations.push({ phase: 'SDK广告路由参数读取', state: 'unavailable', reasonCode: failureCode, httpStatus, officialCode: null });
      } else {
        const body = plainObject(result?.body) ? result.body : {};
        const summary = adResponseSummary(body, result?.statusCode);
        const accepted = successfulSdkLoginParamsCallback(body, summary);
        if (accepted) {
          capturePublicResourceShape('queryLoginParams', body, summary);
          effectiveUserParams = body.data;
          effectiveParamsSource = 'queryLoginParams.data';
          routeParamsKnown = true;
        } else {
          markPublicResourceShapeUnknown('queryLoginParams', 'SDK_LOGIN_PARAMS_RESPONSE_REJECTED', summary);
          observations.push({ phase: 'SDK广告路由参数读取', state: 'unavailable', reasonCode: 'SDK_LOGIN_PARAMS_RESPONSE_REJECTED',
            httpStatus: summary.httpStatus, officialCode: summary.officialCode });
        }
        if (accepted) observations.push({ phase: 'SDK广告路由参数读取', state: 'answered', reasonCode: null,
          httpStatus: summary.httpStatus, officialCode: summary.officialCode });
      }
    } else if (!loginParamsPresent) {
      markPublicResourceShapeUnknown('queryLoginParams', 'SDK_LOGIN_PARAMS_UUID_UNAVAILABLE');
      observations.push({ phase: 'SDK广告路由参数读取', state: 'unavailable', reasonCode: 'SDK_LOGIN_PARAMS_UUID_UNAVAILABLE', httpStatus: null, officialCode: null });
    }
    adPlaybackRoute.setEffectiveRouteInput({ userParams: effectiveUserParams,
      source: effectiveParamsSource, known: routeParamsKnown });
    updatePublicResourceShape();
    const gatewayHost = 'hygnhf2.babigame.cn';
    async function gatewayCall(method, args) {
      const result = await requestJson(gatewayHost, '/gw', buildPayload(method, args, null), { proxy, signal, profile: 'dalvik' });
      if (result.statusCode < 200 || result.statusCode >= 300 || !plainObject(result.body) || result.body.m || result.body.err) throw problem('PROTOCOL_GATEWAY_REJECTED', '官服网关未接受本次请求');
      return result.body;
    }
    const gateway = await phase('游戏网关登录', () => gatewayCall('index.login', { sdkId: 10000, chnId,
      params: { token: sdk.sdkToken, open_id: sdk.openId, content: sdk.content, zoneCode: 'ys', launchOptions: { scene: 1400, query: {} } } }));
    const gatewayAccount = gateway.v?.acc;
    const other = gateway.v?.$other ?? gateway.v?.other;
    const aid = Number(gatewayAccount?.id);
    const serverId = Number(account.serverId || gatewayAccount?.lastGsIdx);
    const sessionToken = text(other?.token);
    if (!Number.isSafeInteger(aid) || aid <= 0 || !Number.isSafeInteger(serverId) || serverId <= 0 || !sessionToken) throw problem('PROTOCOL_GATEWAY_IDENTITY_INVALID', '网关没有给出可核实的账号、区服或会话');
    const serverInfo = await phase('世界服端点查询', () => gatewayCall('index.getGsInfoList', { aid, idx: serverId, chnId }));
    const endpoints = parseEndpoints(serverInfo);
    if (!endpoints.length) throw problem('PROTOCOL_ENDPOINT_MISSING', '本次官服查询未给可用TLS世界服端点');
    const endpointObservation = observations.filter(one => one.phase === '世界服端点查询' && one.state === 'answered').at(-1) ?? null;
    // Tokens and device fields are only returned to the private world transport.
    return { aid, serverId, chnId, sessionToken, endpoints,
      endpointEvidence: { sourceMethod: 'index.getGsInfoList', parser: 'parseEndpoints/v1',
        parsedEndpointsFingerprint: fingerprint(endpoints), observedAt: endpointObservation?.observedAt ?? null },
      device, observations, publicResources,
      worldVersion: device.version, area: 'ca' };
  });
}
