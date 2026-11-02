// Debug transport for this App's authenticated local API. Session tokens stay in memory.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function connectDeviceApi({ adb = process.env.GARDEN_ANDROID_ADB || 'C:/leidian/LDPlayer14/adb.exe', serial = process.env.GARDEN_ANDROID_SERIAL || 'emulator-5554',
  packageName = process.env.GARDEN_ANDROID_PACKAGE || 'online.ainiannian.wujinxia', adbPort = null } = {}) {
  if (!['online.ainiannian.garden', 'online.ainiannian.wujinxia'].includes(packageName)) throw new Error('仅允许本项目的新旧发行包');
  if (adbPort !== null && (!Number.isInteger(adbPort) || adbPort < 1024 || adbPort > 65535)) throw new Error('ADB服务端口无效');
  const invoke = args => execFileSync(adb, [...(adbPort === null ? [] : ['-P', String(adbPort)]), '-s', serial, ...args], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  let session;
  try { session = JSON.parse(invoke(['shell', 'run-as', packageName, 'cat', 'files/engine-session.json'])); }
  catch { throw new Error('无法读取本应用的调试会话，请先在指定设备打开 App。'); }
  if (!/^[a-f0-9]{64}$/.test(session.token || '') || !Number.isInteger(session.port)) throw new Error('本应用调试会话不完整');
  const forwarded = invoke(['forward', 'tcp:0', 'tcp:' + session.port]).trim();
  if (!/^\d+$/.test(forwarded)) throw new Error('无法创建本任务的设备转发');
  return {
    async request(method, route, body) {
      if (!route.startsWith('/api/local/')) throw new Error('仅允许本应用本机接口');
      const response = await fetch('http://127.0.0.1:' + forwarded + route, {
        method, headers: { Authorization: 'Bearer ' + session.token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(method === 'POST' && (route === '/api/local/accounts' || route.startsWith('/api/local/migration/')) ? 150000 : 15000),
      });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error || '本机接口未完成请求'), {
        status: response.status,
        code: /^[A-Z0-9_]{1,96}$/.test(String(result.code || '')) ? result.code : 'LOCAL_REQUEST_FAILED',
        details: result.details,
        ...(Number.isFinite(result.retryAfterMs) ? { retryAfterMs: result.retryAfterMs } : {}),
      });
      return result;
    },
    close() { invoke(['forward', '--remove', 'tcp:' + forwarded]); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const api = connectDeviceApi();
  try {
    const status = await api.request('GET', '/api/local/status');
    console.log(JSON.stringify({ platform: status.platform, execution: status.execution, scope: status.scope, runtime: status.runtime,
      accounts: status.accounts.map(({ id, nickname, name, serverName, state }) => ({ id, nickname, name, serverName, state })) }, null, 2));
  } finally { api.close(); }
}
