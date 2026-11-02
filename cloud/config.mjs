// Environment-driven configuration for the wujinxia cloud service.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVICE_NAME = 'wujinxia-app-cloud';
export const SERVICE_VERSION = '0.1.0';
const here = path.dirname(fileURLToPath(import.meta.url));

// 取值必须来自传给 loadConfig 的那份环境，不能绕过参数直接读 process.env：
// 否则测试与任何显式传入配置的调用都会拿到默认值，护栏看着配了、其实没生效。
function integerEnv(env, name, def, { min, max } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`环境变量 ${name} 必须是整数`);
  if (min !== undefined && value < min) throw new Error(`环境变量 ${name} 不能小于 ${min}`);
  if (max !== undefined && value > max) throw new Error(`环境变量 ${name} 不能大于 ${max}`);
  return value;
}

export function loadConfig(env = process.env) {
  const bind = env.WUJINXIA_BIND && env.WUJINXIA_BIND.trim() ? env.WUJINXIA_BIND.trim() : '127.0.0.1';
  const portRaw = env.WUJINXIA_PORT;
  const port = portRaw === undefined || portRaw === '' ? null : Number(portRaw);
  if (port === null) throw new Error('必须通过环境变量 WUJINXIA_PORT 指定监听端口');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('环境变量 WUJINXIA_PORT 必须是 1024 到 65535 之间的整数端口');
  }
  if (bind !== '127.0.0.1' && bind !== '::1' && bind !== 'localhost') {
    throw new Error('云服务只能绑定回环地址，请设置 WUJINXIA_BIND 为 127.0.0.1');
  }

  const dataDir = env.WUJINXIA_DATA_DIR && env.WUJINXIA_DATA_DIR.trim()
    ? path.resolve(env.WUJINXIA_DATA_DIR.trim())
    : path.resolve(here, '..', '.runtime', 'wujinxia-cloud');
  const dbFile = env.WUJINXIA_DB_FILE && env.WUJINXIA_DB_FILE.trim()
    ? path.resolve(env.WUJINXIA_DB_FILE.trim())
    : path.join(dataDir, 'wujinxia-cloud.db');
  const adminStaticDir = env.WUJINXIA_ADMIN_STATIC_DIR && env.WUJINXIA_ADMIN_STATIC_DIR.trim()
    ? path.resolve(env.WUJINXIA_ADMIN_STATIC_DIR.trim())
    : path.resolve(here, '..', 'admin', 'dist');

  return {
    bind,
    port,
    dataDir,
    dbFile,
    adminStaticDir,
    adminBootstrapFile: env.WUJINXIA_ADMIN_BOOTSTRAP_FILE ? path.resolve(env.WUJINXIA_ADMIN_BOOTSTRAP_FILE) : '',
    sessionTtlMinutes: integerEnv(env, 'WUJINXIA_SESSION_TTL_MINUTES', 900, { min: 1, max: 60 * 24 * 30 }),
    refreshTtlDays: integerEnv(env, 'WUJINXIA_REFRESH_TTL_DAYS', 30, { min: 1, max: 3650 }),
    // 离线宽限的上界就是 24 小时：云端配置值本身必须封住，否则手机上再怎么接受也拦不住一个 30 天的宽限。
    graceHours: integerEnv(env, 'WUJINXIA_GRACE_HOURS', 24, { min: 1, max: 24 }),
    licenseRenewAfterSeconds: integerEnv(env, 'WUJINXIA_LICENSE_RENEW_AFTER_SECONDS', 60, { min: 5, max: 3600 }),
    retentionNormalDays: integerEnv(env, 'WUJINXIA_RETENTION_NORMAL_DAYS', 30, { min: 1, max: 3650 }),
    retentionErrorDays: integerEnv(env, 'WUJINXIA_RETENTION_ERROR_DAYS', 90, { min: 1, max: 3650 }),
    // 收据至少活到「首次接收 + 180 天」与「事件发生 + 180 天」里较晚的那个；窗口外的旧事件明确拒收。
    receiptWindowDays: integerEnv(env, 'WUJINXIA_RECEIPT_WINDOW_DAYS', 180, { min: 1, max: 3650 }),
    // 一轮清理最多处理这么多行，防止一次 UPDATE/DELETE 把整库扫穿、把授权与续期挤在同一线程上等。
    maintenanceRows: integerEnv(env, 'WUJINXIA_MAINTENANCE_ROWS', 100, { min: 1, max: 1000 }),
    purgeIntervalMinutes: integerEnv(env, 'WUJINXIA_PURGE_INTERVAL_MINUTES', 60, { min: 1, max: 24 * 30 }),
    // 日志通道的准入预算：这些数字是按固定节奏参数推出来的护栏（一个安装实例最快 60 秒一次请求、
    // 一批最多 100 条/64KiB），不是实测容量结论。真实安装规模 N 与压测仍未做，容量按待验处理。
    logBudget: {
      installRequestsPerMinute: integerEnv(env, 'WUJINXIA_LOG_BUDGET_INSTALL_REQUESTS', 6, { min: 1, max: 1000 }),
      installEventsPerMinute: integerEnv(env, 'WUJINXIA_LOG_BUDGET_INSTALL_EVENTS', 600, { min: 1, max: 100000 }),
      installBytesPerMinute: integerEnv(env, 'WUJINXIA_LOG_BUDGET_INSTALL_BYTES', 256 * 1024, { min: 1024, max: 16 * 1024 * 1024 }),
      userRequestsPerMinute: integerEnv(env, 'WUJINXIA_LOG_BUDGET_USER_REQUESTS', 30, { min: 1, max: 10000 }),
      ipRequestsPerMinute: integerEnv(env, 'WUJINXIA_LOG_BUDGET_IP_REQUESTS', 120, { min: 1, max: 100000 }),
      globalRequestsInFlight: integerEnv(env, 'WUJINXIA_LOG_BUDGET_GLOBAL_IN_FLIGHT', 8, { min: 1, max: 1024 }),
    },
    normalBodyBytes: integerEnv(env, 'WUJINXIA_MAX_BODY_BYTES', 16 * 1024, { min: 1024, max: 1024 * 1024 }),
    logBatchBodyBytes: integerEnv(env, 'WUJINXIA_MAX_LOG_BATCH_BYTES', 256 * 1024, { min: 1024, max: 16 * 1024 * 1024 }),
    logBatchMaxEvents: integerEnv(env, 'WUJINXIA_MAX_LOG_EVENTS', 100, { min: 1, max: 100 }),
    scrypt: {
      n: integerEnv(env, 'WUJINXIA_SCRYPT_N', 32768, { min: 2, max: 1024 * 1024 }),
      r: integerEnv(env, 'WUJINXIA_SCRYPT_R', 8, { min: 1, max: 1024 }),
      p: integerEnv(env, 'WUJINXIA_SCRYPT_P', 1, { min: 1, max: 64 }),
      keylen: integerEnv(env, 'WUJINXIA_SCRYPT_KEYLEN', 32, { min: 16, max: 128 }),
      maxmem: integerEnv(env, 'WUJINXIA_SCRYPT_MAXMEM', 64 * 1024 * 1024, { min: 1024 * 1024 }),
      concurrency: integerEnv(env, 'WUJINXIA_SCRYPT_CONCURRENCY', 2, { min: 1, max: 16 }),
      queueLimit: integerEnv(env, 'WUJINXIA_SCRYPT_QUEUE_LIMIT', 32, { min: 1, max: 1024 }),
    },
  };
}

export const FILE_MODE = 0o600;
export const DIR_MODE = 0o700;
