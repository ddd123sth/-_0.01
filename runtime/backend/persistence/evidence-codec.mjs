import { deflateSync, inflateSync } from 'node:zlib';
const PREFIX = 'zjson:v1:';
const LIMIT = 64 * 1024 * 1024;
// Only reconstructible evidence JSON uses this envelope. Ledger original_json,
// credentials, outcomes and byte-hash contracts keep their existing storage.
export function encodeEvidenceJson(text, { minimumBytes = 65536 } = {}) {
  if (typeof text !== 'string') throw new TypeError('Evidence JSON must be text');
  if (!Number.isSafeInteger(minimumBytes) || minimumBytes < 4096 || minimumBytes > 65536)
    throw new RangeError('Evidence compression threshold is out of bounds');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length < minimumBytes || bytes.length > LIMIT) return text;
  const packed = PREFIX + bytes.length + ':' + deflateSync(bytes, { level: 1 }).toString('hex');
  return Buffer.byteLength(packed) < bytes.length ? packed : text;
}
export function decodeEvidenceJson(text) {
  if (typeof text !== 'string' || !text.startsWith(PREFIX)) return text;
  const match = /^zjson:v1:([1-9][0-9]*):([a-f0-9]+)$/.exec(text);
  if (!match || match[2].length % 2 || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) > LIMIT)
    throw new TypeError('Invalid compressed evidence envelope');
  const bytes = inflateSync(Buffer.from(match[2], 'hex'), { maxOutputLength: Number(match[1]) });
  if (bytes.length !== Number(match[1])) throw new TypeError('Compressed evidence length mismatch');
  const value = bytes.toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(bytes)) throw new TypeError('Invalid evidence UTF-8');
  return value;
}
