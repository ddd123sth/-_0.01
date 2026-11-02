import crypto from 'node:crypto';

// Existing ledger byte contract, extracted without changing its output.
// JSON.stringify enumerates integer-like keys numerically even after lexical
// object construction. common.canonical is a separate semantic hash contract.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export function normalizeLedgerJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!Array.isArray(value) && !object(value)) throw new TypeError('Ledger payload must contain JSON values only');
  if (seen.has(value)) throw new TypeError('Ledger payload must not contain cycles');
  seen.add(value);
  const normalized = Array.isArray(value) ? value.map(item => normalizeLedgerJson(item, seen))
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, normalizeLedgerJson(value[key], seen)]));
  seen.delete(value);
  return normalized;
}
export const serializeLedgerJson = value => JSON.stringify(normalizeLedgerJson(value));
export const hashLedgerBytes = text => {
  if (typeof text !== 'string') throw new TypeError('Ledger byte hash requires stored JSON text');
  return crypto.createHash('sha256').update(text).digest('hex');
};
export const ledgerJsonFingerprint = value => hashLedgerBytes(serializeLedgerJson(value));
