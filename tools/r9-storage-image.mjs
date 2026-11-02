// Resumable, lossless image construction against a stopped, real 002 database.
// Original data is read-only. Activation is a separate guarded startup step.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeEvidenceJson, decodeEvidenceJson } from '../runtime/backend/persistence/evidence-codec.mjs';
import { convertLandPolicyImage } from './r9-policy-image.mjs';
import { convertLegacyEvidenceImage } from './r9-evidence-image.mjs';
import { retireConfirmedReceiptImage, recoverLegacyReceiptPrefixes } from './r9-outbox-image.mjs';
import { convertLandCompatibilityImage } from './r9-compat-image.mjs';
import { convertLandPublicTextImage } from './r9-public-text-image.mjs';
import { BACKEND_LEDGER_SCHEMA_VERSION } from '../runtime/backend/persistence/schema.mjs';
import { LAND_HISTORY_RETIREMENT_SCHEMA, LAND_HISTORY_DELETE_GUARD } from '../runtime/backend/features/land/history-retirement.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map(process.argv.slice(2).map(arg => { const [key, ...value] = arg.replace(/^--/, '').split('='); return [key, value.join('=') || true]; }));
const mode = args.has('build') ? 'build' : 'plan';
const adb = 'C:/leidian/LDPlayer14/adb.exe', serial = 'emulator-5556', pkg = 'online.ainiannian.wujinxia';
const cli = '/data/local/tmp/r9-codex-sqlite', script = '/data/local/tmp/r9-storage-image.sql';
const source = 'files/data/garden.db', target = 'files/data/garden-r9-stage.db';
const out = path.resolve(root, String(args.get('out') || '.runtime/validation/r9-codex/image01'));
if (!out.startsWith(path.join(root, '.runtime') + path.sep)) throw new Error('Image evidence must stay in this worktree runtime');
fs.mkdirSync(out, { recursive: true });
const budget = Number(args.get('budget-ms') || 480000);
if (!Number.isSafeInteger(budget) || budget < 10000 || budget > 720000) throw new Error('Image batch budget must be 10 seconds to 12 minutes');
const deadline = Date.now() + budget;
const q = name => '"' + name.replaceAll('"', '""') + '"';
const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
const textLiteral = value => "CAST(X'" + Buffer.from(value, 'utf8').toString('hex') + "' AS TEXT)";
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const save = (name, data) => fs.writeFileSync(path.join(out, name + '.json'), JSON.stringify(data, null, 2));
const invoke = (argv, binary = false, allowFailure = false, commandTimeoutMs = 60000) => {
  try { return execFileSync(adb, ['-s', serial, ...argv], { encoding: binary ? undefined : 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 96 * 1024 * 1024,
    timeout: Math.max(1000, Math.min(commandTimeoutMs, deadline - Date.now())), windowsHide: true }); }
  catch (error) { if (allowFailure && error.status === 1) return ''; throw Object.assign(new Error('Device command did not complete'),
    { code: error.code || 'DEVICE_COMMAND_FAILED', deviceStatus: error.status, deviceSignal: error.signal }); }
};
function header(file) {
  const bytes = invoke(['exec-out', 'run-as', pkg, 'head', '-c', '100', file], true);
  if (bytes.length !== 100 || bytes.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') throw new Error('Invalid SQLite header');
  const size = Number(invoke(['shell', 'run-as', pkg, 'stat', '-c', '%s', file]).trim());
  return { bytes: size, headerHex: bytes.toString('hex') };
}
function sql(file, body, attached = false, longRead = false) {
  const local = path.join(out, 'command.sql');
  fs.writeFileSync(local, '.bail on\n.timeout 5000\n.mode json\n.explain off\n' +
    (attached ? `ATTACH DATABASE ${literal('file:' + source + '?mode=ro')} AS src;\n` : '') + body + '\n');
  invoke(['push', local, script]);
  const seconds = Math.max(1, Math.min(longRead ? 240 : 50, Math.floor((deadline - Date.now()) / 1000) - 5));
  if (longRead) save('integrity-budget', { task, seconds, remainingMs: deadline - Date.now(),
    originalUntouched: true, startedAt: new Date().toISOString() });
  const output = invoke(['shell', `run-as ${pkg} /system/bin/timeout -k 2 ${seconds} ${cli} ${literal(file)} < ${script}`], false, false, seconds * 1000 + 3000).trim();
  return output ? JSON.parse(output) : [];
}
const read = body => sql('file:' + source + '?mode=ro', body);
const write = body => sql(target, 'PRAGMA foreign_keys=OFF; PRAGMA synchronous=FULL;\n' + body, true, body.trim() === 'PRAGMA integrity_check;');
const WHITELIST = Object.freeze({
  backend_land_source_policy_receipts: ['receipt_json'],
  backend_land_domain_observations: ['frame_json'],
  backend_land_domain_compatibility_revalidations: ['receipt_json', 'frame_json'],
  backend_customer_observations: ['frame_json'],
  backend_customer_compatibility_revalidations: ['frame_json'],
  backend_order_flower_observations: ['payload_json'],
  backend_order_flower_compatibility_revalidations: ['payload_json'],
  backend_land_cost_contract_guard_events: ['receipt_json'],
});
let original, manifest, task = 'preflight', progressRows = null;
function frozen() {
  if (JSON.stringify(header(source)) !== JSON.stringify(original)) throw Object.assign(new Error('Original database changed; no image activation permitted'), { code: 'SOURCE_CHANGED' });
  if (invoke(['shell', 'pidof', pkg + ':engine'], false, true).trim()) throw new Error('Engine must remain stopped during image construction');
}
function progress(name) {
  if (!progressRows) progressRows = new Map(write('SELECT * FROM backend_r9_image_progress;').map(row => [row.task, row]));
  return progressRows.get(name);
}
function checkpoint(name, cursor, done, detail = {}) {
  write(`INSERT INTO backend_r9_image_progress VALUES(${literal(name)},${cursor},${Number(done)},${textLiteral(JSON.stringify(detail))})
    ON CONFLICT(task) DO UPDATE SET last_rowid=excluded.last_rowid,done=excluded.done,detail_json=excluded.detail_json;`);
  progressRows?.set(name, { task: name, last_rowid: cursor, done: Number(done), detail_json: JSON.stringify(detail) });
}
function checkRows(expected, actual, order) {
  // sha3_query includes query text, so both sides use the identical SELECT
  // against a temporary view. No raw game/credential rows leave SQLite here.
  const query = `SELECT * FROM _r9_verify ORDER BY ${order}`;
  const rows = write(`CREATE TEMP TABLE _r9_hash(expected TEXT,actual TEXT);
    CREATE TEMP VIEW _r9_verify AS ${expected};
    INSERT INTO _r9_hash(expected) SELECT hex(sha3_query(${literal(query)},256));
    DROP VIEW _r9_verify;
    CREATE TEMP VIEW _r9_verify AS ${actual};
    UPDATE _r9_hash SET actual=hex(sha3_query(${literal(query)},256));
    SELECT * FROM _r9_hash;`);
  if (rows.length !== 1 || rows[0].expected !== rows[0].actual) throw new Error('Copied row values differ from exact expected values');
  return rows[0].actual;
}
function packPrivate(recoverOnly = false) {
  const remaining = deadline - Date.now();
  if (remaining < 15000) return { state: 'checkpoint' };
  const argv = ['tools/r9-storage-pack.mjs', '--out=' + out, '--budget-ms=' + Math.min(480000, remaining - 3000)];
  if (recoverOnly) argv.push('--recover');
  const output = execFileSync(process.execPath, argv, { cwd: root, encoding: 'utf8', windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2 * 1024 * 1024, timeout: remaining - 1000 });
  return JSON.parse(output.trim().split(/\r?\n/).at(-1));
}

try {
  if (mode === 'build' && (invoke(['shell', 'pidof', pkg], false, true).trim() || invoke(['shell', 'pidof', pkg + ':engine'], false, true).trim()))
    throw new Error('Explicit durable STOP and closed App are required; this tool does not stop accounts');
  if (invoke(['shell', 'run-as', pkg, 'stat', '-c', '%s', 'files/data/garden-r9-before-image.db'], false, true).trim())
    throw new Error('A previous migration backup still needs its verified exit; preserve it');
  if (invoke(['shell', 'run-as', pkg, 'stat', '-c', '%s', 'files/data/storage-image-switch.json'], false, true).trim())
    throw new Error('A prepared image publication must settle before rebuilding its staged database');
  const status = read(`SELECT (SELECT count(*) FROM backend_run_intents WHERE desired_running=1) AS desired,
    (SELECT count(*) FROM backend_operations WHERE write_slot=1) AS slots,
    (SELECT kind FROM backend_native_stop_controls ORDER BY control_seq DESC LIMIT 1) AS control_kind,
    (SELECT stop_committed*cleanup_complete FROM backend_native_stop_controls ORDER BY control_seq DESC LIMIT 1) AS stopped,
    (SELECT control_seq FROM backend_native_stop_controls ORDER BY control_seq DESC LIMIT 1) AS stop_seq,
    (SELECT count(*) FROM backend_accounts WHERE account_id=1 AND server_id=2202 AND removed_at IS NULL
      AND subject_ref='580f3ad03d2e699bb437b23b19a68048235a637213ca78f98f26d2e8afaf2377') AS correct_subject;`)[0];
  if (status.correct_subject !== 1) throw new Error('002 nineteen identity does not match this work package');
  if (mode === 'build' && (status.desired !== 0 || status.slots !== 0 || status.control_kind !== 'STOP' || status.stopped !== 1))
    throw new Error('Database is not durably stopped and drained');
  const journal = read('PRAGMA journal_mode;')[0]?.journal_mode;
  if (journal !== 'delete') throw new Error('Image builder requires a frozen DELETE-journal source; WAL needs a different snapshot contract');
  if (read('SELECT MAX(version) AS version FROM backend_persistence_migrations;')[0]?.version < 6)
    throw new Error('Install and verify the frame-codec/storage-recovery runtime before constructing an image');
  original = header(source);
  if (mode === 'build') packPrivate(true);
  const schema = read("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name;");
  const tables = schema.filter(row => row.type === 'table' && !['backend_r9_image_progress','backend_r9_pack_progress'].includes(row.name));
  if (tables.some(row => /CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql))) throw new Error('Virtual tables require an explicit copy contract');
  const free = Number(invoke(['shell', 'run-as', pkg, 'df', '-k', 'files/data']).trim().split(/\r?\n/).at(-1).trim().split(/\s+/)[3]) * 1024;
  const stagedBytes = Number(invoke(['shell', 'run-as', pkg, 'stat', '-c', '%s', target], false, true).trim() || 0);
  if (!Number.isSafeInteger(free) || free < Math.max(0, original.bytes - stagedBytes) * 1.15 + 1024 * 1024 * 1024)
    throw new Error('Insufficient verified space for lossless image and bounded journal/sort space');
  const plan = { schema: 'r9-storage-image-plan/v1', original, schemaSha256: sha(JSON.stringify(schema)), tables: tables.length,
    freeBytes: free, codecs: WHITELIST, intent: status, journal };
  save('plan', plan);
  if (mode === 'plan') { console.log(JSON.stringify({ state: 'planned', tables: tables.length, originalBytes: original.bytes, freeBytes: free })); process.exit(0); }
  // test has empty stdout in both cases; stat supplies an explicit existence check.
  const targetSize = invoke(['shell', 'run-as', pkg, 'stat', '-c', '%s', target], false, true).trim();
  const emptyInterruptedImage = targetSize && Number(targetSize) <= 65536 &&
    write("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%';")[0].n === 0;
  if (!targetSize || emptyInterruptedImage) {
    manifest = { ...plan, imageId: crypto.randomUUID(), createdAt: new Date().toISOString(), proofComplete: false };
    write(`PRAGMA page_size=4096; PRAGMA auto_vacuum=INCREMENTAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=OFF; BEGIN;
      ${tables.map(row => row.sql + ';').join('\n')}
      CREATE TABLE backend_r9_image_progress(task TEXT PRIMARY KEY,last_rowid INTEGER NOT NULL,done INTEGER NOT NULL,detail_json TEXT NOT NULL);
      INSERT INTO backend_r9_image_progress VALUES('manifest',0,1,${textLiteral(JSON.stringify(manifest))}); COMMIT;`);
  } else {
    manifest = JSON.parse(progress('manifest')?.detail_json || 'null');
    if (!manifest || JSON.stringify(manifest.original) !== JSON.stringify(original) || manifest.schemaSha256 !== plan.schemaSha256)
      throw new Error('Existing staged image belongs to a different frozen source; preserve it for explicit recovery');
  }
  for (const table of tables) {
    task = 'table:' + table.name;
    if (progress(task)?.done === 1) continue;
    frozen();
    const fields = read(`PRAGMA table_xinfo(${q(table.name)});`).filter(col => col.hidden === 0).map(col => col.name);
    if (fields.includes('_r9_rowid')) throw new Error('Reserved verification column collision');
    const columns = fields.map(q), columnList = columns.join(','), codecs = (WHITELIST[table.name] || []).filter(name => fields.includes(name));
    if (/WITHOUT\s+ROWID/i.test(table.sql)) {
      const pk = read(`PRAGMA table_info(${q(table.name)});`).filter(col => col.pk > 0).sort((a,b) => a.pk-b.pk).map(col => q(col.name)).join(',');
      write(`PRAGMA synchronous=FULL; INSERT OR IGNORE INTO main.${q(table.name)}(${columnList}) SELECT ${columnList} FROM src.${q(table.name)};`);
      const hash = checkRows(`SELECT ${columnList} FROM src.${q(table.name)}`, `SELECT ${columnList} FROM main.${q(table.name)}`, pk);
      checkpoint(task, 0, true, { hash, rows: read(`SELECT count(*) AS n FROM ${q(table.name)};`)[0].n });
      continue;
    }
    const bounds = read(`SELECT MIN(rowid) AS first,MAX(rowid) AS last,count(*) AS n FROM ${q(table.name)};`)[0];
    if (!bounds.n) { checkpoint(task, 0, true, { rows: 0 }); continue; }
    if (![bounds.first,bounds.last].every(Number.isSafeInteger)) throw new Error('Row ordering exceeds exact migration integer range');
    let cursor = progress(task)?.last_rowid ?? bounds.first - 1;
    let detail = JSON.parse(progress(task)?.detail_json || '{"rows":0,"encodedCells":0,"savedTextBytes":0,"hash":""}');
    while (cursor < bounds.last && Date.now() < deadline - 5000) {
      frozen();
      let chunk = codecs.length ? 64 : 8192, values = [], end;
      for (;;) {
        end = read(`SELECT MAX(id) AS id FROM(SELECT rowid AS id FROM ${q(table.name)} WHERE rowid>${cursor} ORDER BY rowid LIMIT ${chunk});`)[0].id;
        if (!codecs.length) break;
        try {
          // Already encoded cells are copied and SQL-hashed unchanged below;
          // do not haul their large envelopes over ADB just to skip them.
          values = read(`SELECT rowid AS _r9_rowid,${codecs.map(name => `CASE WHEN length(${q(name)})<=8388608
            AND substr(${q(name)},1,9)!='zjson:v1:' THEN ${q(name)} ELSE NULL END AS ${q(name)}`).join(',')}
            FROM ${q(table.name)} WHERE rowid>${cursor} AND rowid<=${end} ORDER BY rowid;`);
          break;
        } catch (error) {
          if (!['ENOBUFS', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(error.code)) throw error;
          if (chunk === 1) { values = []; break; } // Copy an oversize row unchanged, never truncate it.
          chunk = Math.max(1, Math.floor(chunk / 2));
        }
      }
      if (!Number.isSafeInteger(end) || end <= cursor) throw new Error('Migration cursor did not advance');
      const range = `rowid>${cursor} AND rowid<=${end}`, replacements = new Map();
      if (codecs.length) {
        for (const row of values) for (const name of codecs) {
          const before = row[name];
          if (typeof before !== 'string' || before.startsWith('zjson:v1:')) continue;
          const after = encodeEvidenceJson(before, { minimumBytes: ['backend_order_flower_observations',
            'backend_order_flower_compatibility_revalidations'].includes(table.name) ? 4096 : 65536 });
          if (decodeEvidenceJson(after) !== before) throw new Error('Lossless evidence reconstruction failed');
          if (after === before) continue;
          if (!replacements.has(name)) replacements.set(name, []);
          replacements.get(name).push([row._r9_rowid, after]);
          detail.encodedCells++; detail.savedTextBytes += Buffer.byteLength(before) - Buffer.byteLength(after);
        }
      }
      const selected = fields.map(name => replacements.has(name)
        ? `CASE rowid ${replacements.get(name).map(([id,value]) => `WHEN ${id} THEN ${textLiteral(value)}`).join(' ')} ELSE ${q(name)} END AS ${q(name)}` : q(name)).join(',');
      const expected = `SELECT rowid AS _r9_rowid,${selected} FROM src.${q(table.name)} WHERE ${range}`;
      write(`PRAGMA synchronous=FULL; BEGIN;
        INSERT OR IGNORE INTO main.${q(table.name)}(rowid,${columnList}) ${expected}; COMMIT;`);
      const actual = `SELECT rowid AS _r9_rowid,${columnList} FROM main.${q(table.name)} WHERE ${range}`;
      const hash = checkRows(expected, actual, '_r9_rowid');
      detail.hash = sha(detail.hash + hash); detail.rows += Math.min(chunk, bounds.n - detail.rows);
      cursor = end; checkpoint(task, cursor, cursor === bounds.last, detail);
      save('status', { state: 'copying', imageId: manifest.imageId, task, cursor, end: bounds.last, detail, at: new Date().toISOString() });
    }
    if (cursor < bounds.last) break;
    const count = write(`SELECT count(*) AS n FROM main.${q(table.name)};`)[0].n;
    if (count !== bounds.n) throw new Error('Copied table cardinality differs');
  }
  const pending = tables.filter(table => progress('table:' + table.name)?.done === 1).length;
  if (pending !== tables.length || Date.now() >= deadline - 5000) {
    save('status', { state: 'checkpoint', imageId: manifest.imageId, copiedTables: pending, totalTables: tables.length, originalUntouched: true });
    console.log(JSON.stringify({ state: 'checkpoint', copiedTables: pending, totalTables: tables.length, originalUntouched: true })); process.exit(0);
  }
  task = 'transform:land-policy-public/v1';
  const publicProof = convertLandPolicyImage({ read, write, progress, frozen, deadline, save });
  if (!publicProof.done || Date.now() >= deadline - 5000) {
    console.log(JSON.stringify({ state: 'checkpoint', task, originalUntouched: true })); process.exit(0);
  }
  task = 'transform:land-compatibility-public/v1';
  const compatibilityProof = convertLandCompatibilityImage({ read, write, progress, frozen, deadline, save });
  if (!compatibilityProof.done || Date.now() >= deadline - 5000) {
    console.log(JSON.stringify({ state: 'checkpoint', task, originalUntouched: true })); process.exit(0);
  }
  task = 'codec:legacy-auxiliary-evidence';
  const publicTextProof = convertLandPublicTextImage({ read, write, progress, frozen, deadline, save });
  if (!publicTextProof.done || Date.now() >= deadline - 5000) {
    console.log(JSON.stringify({ state: 'checkpoint', task: 'transform:public-json-text', originalUntouched: true })); process.exit(0);
  }
  const legacyCodecProof = convertLegacyEvidenceImage({ read, write, progress, frozen, deadline, save });
  if (!legacyCodecProof.done || Date.now() >= deadline - 5000) {
    console.log(JSON.stringify({ state: 'checkpoint', task, originalUntouched: true })); process.exit(0);
  }
  task = 'retire:scheduler-confirmed-receipts/v1';
  const legacyPrefixProof = recoverLegacyReceiptPrefixes({ read, write, progress, frozen, deadline, save });
  if (!legacyPrefixProof.done || Date.now() >= deadline - 5000) {
    console.log(JSON.stringify({ state: 'checkpoint', task: 'recover:legacy-scheduler-receipt-prefixes/v1', originalUntouched: true })); process.exit(0);
  }
  const outboxRetirementProof = retireConfirmedReceiptImage({ read, write, progress, frozen, deadline, save });
  if (!outboxRetirementProof.done || Date.now() >= deadline - 5000) {
    console.log(JSON.stringify({ state: 'checkpoint', task, originalUntouched: true })); process.exit(0);
  }
  save('confirmation-roots-after-transform', write('SELECT * FROM backend_outbox_confirmed_progress ORDER BY consumer_id,owner_ref,subject_ref;'));
  const bindingAddition = write(`SELECT (SELECT count(*) FROM main.backend_land_source_policy_bindings)-
    (SELECT count(*) FROM src.backend_land_source_policy_bindings) AS n;`)[0].n;
  const originalPublicObjects = schema.some(item => item.type === 'table' && item.name === 'backend_land_policy_public_objects')
    ? '(SELECT count(*) FROM src.backend_land_policy_public_objects)' : '0';
  const publicObjectAddition = write(`SELECT (SELECT count(*) FROM main.backend_land_policy_public_objects)-${originalPublicObjects} AS n;`)[0].n;
  const versionAddition = read(`SELECT count(*) AS n FROM backend_persistence_migrations WHERE version=${BACKEND_LEDGER_SCHEMA_VERSION};`)[0].n ? 0 : 1;
  if (!write(`SELECT version FROM backend_persistence_migrations WHERE version=${BACKEND_LEDGER_SCHEMA_VERSION};`).length)
    write(`INSERT INTO backend_persistence_migrations VALUES(${BACKEND_LEDGER_SCHEMA_VERSION},${literal(new Date().toISOString())},
      'Byte-exact shared public JSON evidence; dependency-guarded configuration and confirmed log history exits');`);
  // Preserve AUTOINCREMENT recovery roots even when the largest old row is gone.
  if (!progress('roots:sqlite-sequence')?.done) {
    if (read("SELECT 1 AS found FROM sqlite_schema WHERE name='sqlite_sequence';").length)
      write('BEGIN; DELETE FROM sqlite_sequence; INSERT INTO sqlite_sequence(rowid,name,seq) SELECT rowid,name,seq FROM src.sqlite_sequence; COMMIT;');
    checkpoint('roots:sqlite-sequence', 0, true);
  }
  write(LAND_HISTORY_RETIREMENT_SCHEMA);
  for (const item of schema.filter(row => row.type !== 'table')) {
    if (item.type === 'trigger' && item.name === 'backend_land_lifecycle_events_no_delete') {
      const normalize = text => text.replace(/IF\s+NOT\s+EXISTS\s+/gi, '').replace(/\s+/g, ' ').trim().replace(/;$/, '');
      const legacy = "CREATE TRIGGER backend_land_lifecycle_events_no_delete BEFORE DELETE ON backend_land_lifecycle_events BEGIN SELECT RAISE(ABORT,'land lifecycle evidence is append only'); END";
      if (![normalize(legacy), normalize(LAND_HISTORY_DELETE_GUARD)].includes(normalize(item.sql)))
        throw new Error('Unknown land lifecycle protection contract; original remains untouched');
      write(LAND_HISTORY_DELETE_GUARD); continue;
    }
    task = item.type + ':' + item.name;
    if (progress(task)?.done === 1) continue;
    const existing = write(`SELECT sql FROM sqlite_schema WHERE type=${literal(item.type)} AND name=${literal(item.name)};`)[0];
    if (existing) {
      const normalize = text => text.replace(/IF\s+NOT\s+EXISTS\s+/gi, '').replace(/\s+/g, ' ').trim().replace(/;$/, '');
      if (normalize(existing.sql) !== normalize(item.sql)) throw new Error('Private image structure conflicts with the frozen source definition');
      checkpoint(task, 0, true, { sourceDefinitionSha256: sha(item.sql), alreadyCreatedAndMatched: true }); continue;
    }
    frozen(); write(`BEGIN; ${item.sql}; INSERT INTO backend_r9_image_progress VALUES(${literal(task)},0,1,'{}'); COMMIT;`);
    if (Date.now() >= deadline - 5000) { console.log(JSON.stringify({ state: 'checkpoint', task, originalUntouched: true })); process.exit(0); }
  }
  task = 'physical-free-pages';
  if (write('PRAGMA auto_vacuum;')[0]?.auto_vacuum !== 2) throw new Error('Private image must support bounded incremental vacuum');
  let freePages = write('PRAGMA freelist_count;')[0].freelist_count;
  let packProof = null;
  if (freePages > 65536) {
    task = 'private-dense-pack'; frozen(); packProof = packPrivate();
    if (packProof.state !== 'packed') { console.log(JSON.stringify({ state: 'checkpoint', task, originalUntouched: true })); process.exit(0); }
    frozen(); freePages = write('PRAGMA freelist_count;')[0].freelist_count;
  }
  while (freePages > 0 && Date.now() < deadline - 10000) {
    frozen(); write('PRAGMA incremental_vacuum(128);');
    const next = write('PRAGMA freelist_count;')[0].freelist_count;
    if (next >= freePages) throw new Error('Private image free-page reclamation did not advance');
    freePages = next; save('status', { state: 'trimming-free-pages', freePages, originalUntouched: true });
  }
  if (freePages) { console.log(JSON.stringify({ state: 'checkpoint', task, freePages, originalUntouched: true })); process.exit(0); }
  task = 'integrity-check';
  // Never start the whole-file read with a leftover partial allowance after a
  // dense copy. Yield a durable checkpoint and let the next fresh batch own it.
  if (deadline - Date.now() < 255000) {
    save('status', { state: 'checkpoint-before-full-integrity', originalUntouched: true });
    console.log(JSON.stringify({ state: 'checkpoint', task, originalUntouched: true })); process.exit(0);
  }
  save('status', { state: 'checking-full-private-integrity', originalUntouched: true, startedAt: new Date().toISOString() });
  const integrity = write('PRAGMA integrity_check;');
  if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw new Error('Staged image integrity check did not pass');
  task = 'foreign-key-check';
  if (write('PRAGMA foreign_key_check;').length) throw new Error('Staged image has unresolved foreign key references');
  frozen();
  for (const table of tables) {
    const counts = write(`SELECT (SELECT count(*) FROM src.${q(table.name)}) AS original,(SELECT count(*) FROM main.${q(table.name)}) AS compacted;`)[0];
    const addition = table.name === 'backend_land_source_policy_bindings' ? bindingAddition
      : table.name === 'backend_persistence_migrations' ? versionAddition
        : table.name === 'backend_land_policy_public_objects' ? publicObjectAddition
          : table.name === 'backend_outbox_confirmed_progress' ? legacyPrefixProof.created
          : table.name === 'backend_outbox_receipts' ? -outboxRetirementProof.retired : 0;
    if (counts.original + addition !== counts.compacted) throw new Error('Final image cardinality changed');
  }
  const proof = { ...manifest, proofComplete: true, verifiedAt: new Date().toISOString(), tables: tables.length,
    landHistoryExit: { currentHeadAndCallbackRequired: true, originalOperationAndWireEvidenceUnchanged: true,
      recoveryTables: ['backend_land_history_retirement_callbacks','backend_land_history_retirement_progress'] },
    replacedPrivateBookkeeping: ['backend_r9_pack_progress'],
    publicProof, compatibilityProof, publicTextProof, legacyCodecProof, legacyPrefixProof, outboxRetirementProof, packProof, bindingAddition, publicObjectAddition, versionAddition, minimumRuntimeSchema: BACKEND_LEDGER_SCHEMA_VERSION,
    tableProofs: write("SELECT task,last_rowid,detail_json FROM backend_r9_image_progress WHERE task LIKE 'table:%' ORDER BY task;") };
  checkpoint('seal', 0, true, proof);
  invoke(['shell', 'run-as', pkg, 'chmod', '600', target]);
  const compacted = header(target);
  const request = { schema: 'garden-storage-image-switch/v1', imageId: manifest.imageId, original, compacted };
  save('switch-request', request); save('status', { state: 'verified-stage', original, compacted, imageId: manifest.imageId, originalUntouched: true });
  console.log(JSON.stringify({ state: 'verified-stage', originalBytes: original.bytes, compactedBytes: compacted.bytes, imageId: manifest.imageId, activationRequested: false }));
} catch (error) {
  if (Date.now() >= deadline - 5000) {
    save('status', { state: 'checkpoint', task, originalUntouched: true });
    console.log(JSON.stringify({ state: 'checkpoint', task, originalUntouched: true })); process.exit(0);
  }
  save('failure', { task, code: error.code || 'IMAGE_BUILD_FAILED', deviceStatus: error.deviceStatus, deviceSignal: error.deviceSignal,
    message: error.message, originalUntouched: true, at: new Date().toISOString() });
  console.log(JSON.stringify({ state: 'failed', task, code: error.code || 'IMAGE_BUILD_FAILED', message: error.message, originalUntouched: true })); process.exitCode = 2;
}
