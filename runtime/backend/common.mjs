import { decodeEvidenceJson } from './persistence/evidence-codec.mjs';
export { encodeEvidenceJson } from './persistence/evidence-codec.mjs';
import crypto from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { timedStoredParse } from '../performance-diagnostics.mjs';

export function problem(code, message, status = 409, details = undefined) {
  return Object.assign(new Error(message), { code, status, details });
}

// Immutable verification evidence is stored with the operation trace bound
// into its payload. Callers use the same constructor when comparing the live
// verifier result with that stored representation.
export function gatewayVerificationEvidencePayload(traceId, evidence) {
  if (typeof traceId !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(traceId) || !plainObject(evidence) ||
      Object.hasOwn(evidence, 'traceId') && evidence.traceId !== traceId) {
    throw problem('BACKEND_VERIFICATION_EVIDENCE_TRACE_CONFLICT', '验证证据与原操作追踪标识不一致', 409);
  }
  return { traceId, ...evidence };
}
export function safeBackendErrorPath(error, maximum = 6) {
  const limit = Number.isSafeInteger(maximum) ? Math.max(1, Math.min(6, maximum)) : 6;
  const locations = typeof error?.stack === 'string' ? error.stack.split(/\r?\n/).slice(1).map(line =>
    /(?:file:\/\/)?[^\s()]*(backend\/[A-Za-z0-9_.\/-]+\.mjs):(\d+):(\d+)/.exec(line)).filter(Boolean) : [];
  return locations.filter(match => !match[1].split('/').some(part => part === '.' || part === '..'))
    .slice(0, limit).map(match => `${match[1]}:${Number(match[2])}:${Number(match[3])}`).join(' > ').slice(0, 512) || null;
}
export function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw problem('BACKEND_INPUT_INVALID', field + '格式不正确', 400);
  return value;
}
export function integer(value, field, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) throw problem('BACKEND_INPUT_INVALID', field + '必须是有效整数', 400);
  return value;
}
export function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function canonicalAt(value, path) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item, index) => canonicalAt(item, path + '[' + index + ']')).join(',') + ']';
  if (plainObject(value)) return '{' + Object.keys(value).sort().map(key => {
    const safeKey = /^[A-Za-z0-9_$.-]{1,64}$/.test(key) ? key : '<redacted-key>';
    return JSON.stringify(key) + ':' + canonicalAt(value[key], path + '.' + safeKey);
  }).join(',') + '}';
  const actualType = typeof value === 'number' ? 'non-finite-number' : typeof value;
  const safePath = typeof path === 'string' ? path.slice(0, 192) : '$';
  throw problem('BACKEND_VALUE_INVALID', '数据包含不可持久化的值', 400, { path: safePath, actualType });
}
export function canonical(value) {
  return canonicalAt(value, '$');
}
export const fingerprint = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
export const newId = () => crypto.randomUUID();
export const clone = value => JSON.parse(canonical(value));
const deeplyFrozenStableObjects = new WeakSet();
function freezeStableGraph(value) {
  if (!value || typeof value !== 'object') return true;
  if (deeplyFrozenStableObjects.has(value)) return true;
  const proxy = utilTypes.isProxy(value);
  let stable = !proxy;
  if (!proxy) {
    // An enumerable getter can change the graph while Object.values reads it.
    // Detect it without invoking it so neither this node nor its ancestors are
    // memoized as a stable graph. Object.values below remains the sole value
    // read and preserves the old traversal order and getter timing.
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const key of Object.keys(descriptors)) {
        const descriptor = descriptors[key];
        if (descriptor.enumerable && !Object.hasOwn(descriptor, 'value')) { stable = false; break; }
      }
    } catch { stable = false; }
  }
  let childrenStable = true;
  for (const child of Object.values(value)) if (!freezeStableGraph(child)) childrenStable = false;
  Object.freeze(value);
  stable = stable && childrenStable;
  if (stable) deeplyFrozenStableObjects.add(value);
  return stable;
}
export function freeze(value) {
  freezeStableGraph(value);
  return value;
}
export function parseStored(value, field) {
  const measured = field === 'customer read model' || field === 'land domain model' || field === '顾客生成日期来源';
  const parse = () => {
    try { return JSON.parse(decodeEvidenceJson(value)); } catch { throw problem('BACKEND_STORAGE_CORRUPT', field + '无法读取，原资料已保留', 500); }
  };
  return measured ? timedStoredParse(field, typeof value === 'string' ? value.length : null, parse) : parse();
}
