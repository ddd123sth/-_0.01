import { createHash } from 'node:crypto';
import { clone, fingerprint, freeze, plainObject, problem } from '../common.mjs';

const PROTOCOL_KEY = 'smallaitt';
export const SYNC_DATA_TYPE = 'G.ISyncData';
export const FRAME_LIMIT_BYTES = 8 * 1024 * 1024;
export const paramsFingerprint = value => fingerprint(value);

export function captureParams(args) {
  if (!plainObject(args)) throw problem('PROTOCOL_ARGUMENT_INVALID', '游戏请求参数必须是普通对象', 400);
  return freeze(clone(args));
}

export function buildPayload(method, args, token = null) {
  if (typeof method !== 'string' || !/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(method)) throw problem('PROTOCOL_METHOD_INVALID', '游戏方法名未通过协议检查', 400);
  const encoded = [];
  const text = JSON.stringify([method, args, token]);
  // Match the captured official client's code-point loop; no toJSON method on
  // untrusted caller objects can execute because args has already been captured.
  for (const character of text) encoded.push(character.charCodeAt(0) ^ 0x77);
  const a = '[' + encoded.join(',') + ']';
  return { sign: createHash('md5').update(a + PROTOCOL_KEY, 'utf8').digest('hex'), a, l: 'zh' };
}

export function buildRequestFrame({ method, args, token = null, wireKey }) {
  return '$#|#$' + JSON.stringify({ e: 'request', d: { r: 'gs', p: buildPayload(method, args, token), k: wireKey } });
}

export function decodeType(raw) {
  if (raw === undefined || raw === null) return { ok: true, dsName: null };
  let codes;
  try { codes = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return { ok: false, reason: 'TYPE_NOT_JSON' }; }
  if (!Array.isArray(codes) || codes.length > 256 || codes.some(code => !Number.isInteger(code) || code < 0 || code > 0xffff)) return { ok: false, reason: 'TYPE_CODE_INVALID' };
  let checksum = 0;
  for (const character of PROTOCOL_KEY) checksum ^= character.charCodeAt(0);
  return { ok: true, dsName: codes.map(code => String.fromCharCode((code ^ checksum) & 0xffff)).join('') || null };
}

function messageShape(message) {
  if (message === undefined || message === null || message === '' || message === 0) return { messagePresent: false, rejected: false, noticeOnly: false, remoteCode: null, remoteKey: null };
  const numeric = value => Number.isSafeInteger(value) ? value : typeof value === 'string' && /^\d{1,10}$/.test(value) ? Number(value) : null;
  const code = numeric(message) ?? (plainObject(message) ? ['code', 'msgCode', 'msgId', 'id', 'm'].map(key => numeric(message[key])).find(value => value !== null) ?? null : null);
  const remoteKey = plainObject(message) && typeof message.code === 'string' && /^\$?[A-Za-z][A-Za-z0-9_]{0,39}$/.test(message.code) ? message.code : null;
  // A {msg,type} presentation notice has no rejection code. Preserve its
  // presence without converting it into either a business failure or success.
  const noticeOnly = plainObject(message) && !Object.hasOwn(message, 'code') && Object.hasOwn(message, 'type') && typeof message.msg === 'string';
  return { messagePresent: true, rejected: code !== null && code !== 0 || remoteKey !== null, noticeOnly, remoteCode: code, remoteKey };
}

export function decodeEnvelope(frame) {
  if (!plainObject(frame)) return { envelopeOk: false, envelopeReason: 'ENVELOPE_NOT_OBJECT' };
  const type = decodeType(frame.d);
  const status = messageShape(frame.m);
  return { ...status, envelopeOk: type.ok && frame.f === undefined,
    envelopeReason: !type.ok ? type.reason : frame.f !== undefined ? 'UNKNOWN_ENCODING_FLAG' : null,
    dsName: type.dsName ?? null, value: frame.v,
    serverReceivedMs: Number.isFinite(frame.r) ? frame.r : null,
    serverRespondedMs: Number.isFinite(frame.t) ? frame.t : null };
}

export function extractSessionMetadata(value, dsName) {
  if (!plainObject(value)) return {};
  let raw = value.$other ?? value.other;
  if (!raw && dsName === SYNC_DATA_TYPE) raw = value['2'];
  if (!plainObject(raw)) return {};
  const token = raw.token ?? raw['1'];
  const serverMs = raw.ms ?? raw['3'];
  const version = raw.ver ?? raw['0'];
  return { token: typeof token === 'string' && token.length > 0 && token.length <= 4096 ? token : null,
    serverMs: Number.isFinite(serverMs) ? serverMs : null,
    // IOther.ver is server-version display metadata, not the client RPC
    // protocol contract. Keep the historical `version` alias for old readers.
    version: typeof version === 'string' || typeof version === 'number' ? version : null,
    reportedServerVersion: typeof version === 'string' || typeof version === 'number' ? version : null };
}

export function observationValue(value, dsName) {
  if (value === undefined) return null;
  const copied = clone(value);
  if (!plainObject(copied)) return copied;
  for (const key of ['$other', 'other', ...(dsName === SYNC_DATA_TYPE ? ['2'] : [])]) {
    if (plainObject(copied[key])) { delete copied[key].token; delete copied[key]['1']; }
  }
  return copied;
}

function documents(text) {
  const output = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (start < 0) { if (character === '{') { start = index; depth = 1; } continue; }
    if (quoted) { if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === '"') quoted = false; continue; }
    if (character === '"') quoted = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) { output.push(text.slice(start, index + 1)); start = -1; }
  }
  return output;
}

export function parseSocketDocuments(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buffer.length > FRAME_LIMIT_BYTES) throw problem('PROTOCOL_FRAME_TOO_LARGE', '游戏响应超出接收上限');
  const text = buffer.toString('utf8').trim();
  const parts = text.includes('$#|#$') ? text.split('$#|#$').filter(Boolean) : [text];
  const output = [];
  for (const part of parts) {
    if (part.trim() === 'connectionEnabled' || part.trim() === '"connectionEnabled"') { output.push('connectionEnabled'); continue; }
    try { output.push(JSON.parse(part)); }
    catch { for (const source of documents(part)) { try { output.push(JSON.parse(source)); } catch { /* Unrecognized fragments never become facts. */ } } }
  }
  return output;
}
