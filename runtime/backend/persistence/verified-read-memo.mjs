import crypto from 'node:crypto';
import { canonical, freeze } from '../common.mjs';

// Cache a small derived conclusion, never an execution permission. Every hit
// rereads its exact SQL dependencies, including absent rows. Hash raw SQLite
// scalars without decoding/canonicalizing multi-megabyte JSON evidence again.
function digestRows(value) {
  const hash = crypto.createHash('sha256');
  const scalar = value => {
    if (value !== null && !['string', 'number', 'bigint'].includes(typeof value)) throw new TypeError('Non-scalar SQLite evidence');
    const text = value === null ? '' : String(value);
    hash.update(typeof value + ':' + Buffer.byteLength(text) + ':').update(text);
  };
  const rows = value === null ? [] : Array.isArray(value) ? value : [value];
  hash.update(value === null ? 'null' : Array.isArray(value) ? 'all' : 'get');
  for (const row of rows) {
    const keys = Object.keys(row).sort(); scalar(keys.length);
    for (const key of keys) { scalar(key); scalar(row[key]); }
  }
  return hash.digest('hex');
}

export function createVerifiedReadMemo(store, { maxEntries = 32, maxBytes = 1024 * 1024, maxReads = 256 } = {}) {
  const entries = new Map(); let bytes = 0, capture = null;
  const read = (method, args) => {
    const result = store[method](...args);
    if (capture) capture.push({ method, args, digest: digestRows(result) });
    return result;
  };
  const reader = { ...store, get: (...args) => read('get', args), all: (...args) => read('all', args) };
  function memo(key, calculate) {
    if (capture) return calculate();
    const prior = entries.get(key);
    if (prior) {
      entries.delete(key); bytes -= prior.bytes;
      if (prior.dependencies.every(dep => digestRows(store[dep.method](...dep.args)) === dep.digest)) {
        entries.set(key, prior); bytes += prior.bytes; return prior.value;
      }
    }
    const dependencies = []; capture = dependencies;
    let value;
    try { value = calculate(); } finally { capture = null; }
    const size = Buffer.byteLength(canonical({ key, dependencies, value }));
    if (dependencies.length > maxReads || size > maxBytes) return value;
    freeze(value); entries.set(key, { dependencies, value, bytes: size }); bytes += size;
    while (entries.size > maxEntries || bytes > maxBytes) {
      const oldest = entries.keys().next().value; bytes -= entries.get(oldest).bytes; entries.delete(oldest);
    }
    return value;
  }
  return { store: reader, memo };
}
