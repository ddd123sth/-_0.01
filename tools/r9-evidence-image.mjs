// Only columns whose complete production reader set uses parseStored. This is
// an exact decoded-byte conversion in the private image, never an audit verdict
// rewrite and never permission to encode operation/credential originals.
import crypto from 'node:crypto';
import { encodeEvidenceJson, decodeEvidenceJson } from '../runtime/backend/persistence/evidence-codec.mjs';
const specs = Object.freeze({ backend_order_flower_auxiliary_observations: ['source_json', 'payload_json'],
  backend_order_flower_auxiliary_heads: ['source_json', 'payload_json'] });
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const textValue = value => "CAST(X'" + Buffer.from(value).toString('hex') + "' AS TEXT)";
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

export function convertLegacyEvidenceImage({ read, write, progress, frozen, deadline, save }) {
  const summaries = [];
  for (const [table, columns] of Object.entries(specs)) {
    const task = 'codec:' + table, prior = progress(task);
    if (prior?.done === 1) { summaries.push({ table, ...JSON.parse(prior.detail_json) }); continue; }
    let cursor = prior?.last_rowid ?? 0;
    const detail = JSON.parse(prior?.detail_json || '{"encodedCells":0,"savedTextBytes":0,"hash":""}');
    const maximum = read(`SELECT COALESCE(MAX(rowid),0) AS n FROM ${table};`)[0].n;
    while (cursor < maximum && Date.now() < deadline - 5000) {
      frozen(); let rows, chunk = 16;
      for (;;) {
        try {
          rows = read(`SELECT rowid AS id,${columns.map(column => `CASE WHEN length(${column}) BETWEEN 65536 AND 8388608
            AND substr(${column},1,9)!='zjson:v1:' THEN ${column} ELSE NULL END AS ${column}`).join(',')}
            FROM ${table} WHERE rowid>${cursor} ORDER BY rowid LIMIT ${chunk};`); break;
        } catch (error) {
          if (!['ENOBUFS','ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(error.code) || chunk === 1) throw error;
          chunk = Math.max(1, Math.floor(chunk / 2));
        }
      }
      const statements = ['BEGIN;', 'CREATE TEMP TABLE _r9_codec_assert(ok INTEGER CHECK(ok=1));'];
      for (const row of rows) for (const column of columns) {
        if (typeof row[column] !== 'string') continue;
        const before = row[column], after = encodeEvidenceJson(before);
        if (after === before) continue;
        if (decodeEvidenceJson(after) !== before) throw new Error('Legacy evidence exact bytes did not reconstruct');
        statements.push(`UPDATE ${table} SET ${column}=${textValue(after)} WHERE rowid=${row.id};
          INSERT INTO _r9_codec_assert SELECT EXISTS(SELECT 1 FROM ${table} WHERE rowid=${row.id} AND ${column}=${textValue(after)});`);
        detail.encodedCells++; detail.savedTextBytes += Buffer.byteLength(before) - Buffer.byteLength(after);
        detail.hash = hash(detail.hash + row.id + ':' + column + ':' + hash(before) + ':' + hash(after));
      }
      cursor = rows.at(-1).id;
      statements.push(`INSERT INTO backend_r9_image_progress VALUES(${literal(task)},${cursor},${Number(cursor === maximum)},${textValue(JSON.stringify(detail))})
        ON CONFLICT(task) DO UPDATE SET last_rowid=excluded.last_rowid,done=excluded.done,detail_json=excluded.detail_json; COMMIT;`);
      write(statements.join('\n')); save('status', { state: 'encoding-legacy-evidence', table, cursor, maximum, ...detail, originalUntouched: true });
    }
    if (cursor < maximum) return { done: false, summaries };
    // Empty tables need a durable completed root as well.
    if (!maximum) write(`INSERT OR IGNORE INTO backend_r9_image_progress VALUES(${literal(task)},0,1,${textValue(JSON.stringify(detail))});`);
    summaries.push({ table, ...detail });
  }
  return { done: true, summaries };
}
