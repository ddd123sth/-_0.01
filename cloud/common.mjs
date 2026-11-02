// Shared result + validation helpers for the wujinxia cloud service.
// Handlers return {status, body}; the entry point turns them into JSON.
export function result(status, body, extraHeaders) {
  return { status, body, headers: extraHeaders };
}
export function ok(body) { return result(200, body); }
export function created(body) { return result(201, body); }
export function fail(status, error, code) { return result(status, { error, code }); }

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

const USERNAME = /^[A-Za-z0-9_.-]{3,32}$/u;
const INSTALL_ID = /^[A-Za-z0-9_-]{8,64}$/u;
const EVENT_ID = /^[A-Za-z0-9_-]{8,64}$/u;
const PASSWORD_CHARS = /^[\x21-\x7e\x20]{8,64}$/u;

export function validUsername(value) {
  return typeof value === 'string' && USERNAME.test(value);
}
export function validInstallId(value) {
  return typeof value === 'string' && INSTALL_ID.test(value);
}
export function validEventId(value) {
  return typeof value === 'string' && EVENT_ID.test(value);
}
export function validSoftwarePassword(value, username) {
  // 8-64 printable ASCII (space allowed), must differ from the username.
  if (typeof value !== 'string' || !PASSWORD_CHARS.test(value)) return false;
  if (username !== undefined && value === username) return false;
  return true;
}
export function validAdminPassword(value) {
  return typeof value === 'string' && PASSWORD_CHARS.test(value);
}
export function validIso(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && /\d{4}-\d{2}-\d{2}T/u.test(value);
}
export function boundedString(value, max) {
  if (typeof value !== 'string') return false;
  return value.length <= max;
}
export function optionalBounded(value, max) {
  return value === undefined || value === null || boundedString(value, max);
}

export function integerAtLeast(value, min) {
  return Number.isInteger(value) && value >= min;
}
