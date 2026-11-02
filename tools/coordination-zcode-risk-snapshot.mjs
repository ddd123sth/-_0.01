import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connectDeviceApi } from './device-local-api.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phase = process.argv[2];
if (!['before', 'after', 'final'].includes(phase)) throw new Error('Invalid phase');
const options = Object.fromEntries(process.argv.slice(3).map(arg => {
  const match = /^--(out|serial|index)=(.+)$/.exec(arg);
  if (!match) throw new Error('Expected --out=<directory> [--serial=emulator-5554|5556|5558] [--index=0|1|2]');
  return [match[1], match[2]];
}));
if (!options.out?.trim()) throw new Error('Explicit --out=<current evidence directory> required');
const serials = ['emulator-5554', 'emulator-5556', 'emulator-5558'];
if (options.index !== undefined && !/^[012]$/.test(options.index)) throw new Error('Index must be 0, 1 or 2');
const serial = options.serial ?? serials[Number(options.index ?? 2)];
const index = options.index === undefined ? serials.indexOf(serial) : Number(options.index);
if (!serials.includes(serial) || serials[index] !== serial) throw new Error('Serial/index mismatch');
const output = path.resolve(root, options.out);
if (fs.existsSync(output) && fs.readdirSync(output).some(name => name.startsWith(phase + '-ledger-') || name === phase + '-risk-summary.json')) throw new Error('Phase evidence already exists; use a new --out directory');
fs.mkdirSync(output, { recursive: true });
const canonical = value => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(one => JSON.parse(canonical(one)))
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
const digest = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const api = connectDeviceApi({ serial, packageName: 'online.ainiannian.wujinxia' });
const report = { taskId: 'risk-snapshot', at: new Date().toISOString(), phase, serial, index, accounts: [] };
try {
  const status = await api.request('GET', '/api/local/status');
  for (const account of status.accounts) {
    if (account.desiredRunning || account.running || account.state !== 'stopped') throw new Error('Account not stopped');
    const pages = [], rows = [];
    let cursor = '', totals;
    for (let page = 0; page < 100; page++) {
      const body = await api.request('GET', '/api/local/accounts/' + account.id + '/writes?limit=100' + cursor);
      pages.push(body); rows.push(...body.writes); totals ||= body.totals;
      if (canonical(totals) !== canonical(body.totals)) throw new Error('Ledger changed during readonly capture');
      if (!body.page.hasMore) break;
      if (page === 99) throw new Error('Ledger page budget exceeded');
      cursor = '&beforePreparedAt=' + encodeURIComponent(body.page.older.beforePreparedAt)
        + '&beforeOperationId=' + encodeURIComponent(body.page.older.beforeOperationId);
    }
    if (rows.length !== totals.total) throw new Error('Ledger capture incomplete');
    const unknown = rows.filter(one => ['unknown', 'unverified'].includes(one.verdict ?? one.status));
    const slots = rows.filter(one => one.writeSlot);
    const legacy = pages[0]?.historical || [];
    fs.writeFileSync(path.join(output, phase + '-ledger-' + account.id + '.json'), JSON.stringify({ pages }, null, 2) + '\n', { flag: 'wx' });
    report.accounts.push({ id: account.id, runEpoch: account.runEpoch, state: account.state,
      desiredRunning: account.desiredRunning, retryAt: account.retryAt, executionBoundary: account.executionBoundary,
      totals, pageCount: pages.length, rowsCaptured: rows.length, unknownRowsCaptured: unknown.length,
      ledgerCanonicalSha256: digest(rows), unknownCanonicalSha256: digest(unknown),
      writeSlotCanonicalSha256: digest(slots), returnedWriteSlots: slots.length,
      legacyFirstPageRows: legacy.length, legacyFirstPageCanonicalSha256: digest(legacy),
      legacyFirstPageOnly: true, legacyEvidencePreserved: pages.every(one => one.legacyEvidencePreserved === true) });
    if (totals.writeSlot !== 0 || slots.length !== 0) throw new Error('Current slot occupancy requires coordinator assessment');
  }
  if (status.runtime.runningCount || status.runtime.pendingCount) throw new Error('Runtime not idle');
  report.nativeStop = status.nativeStop;
  report.nativeStopControl = status.nativeStopControl;
  fs.writeFileSync(path.join(output, phase + '-risk-summary.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
} finally { api.close(); }
