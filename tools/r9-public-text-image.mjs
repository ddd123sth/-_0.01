import crypto from 'node:crypto';
import { decodeEvidenceJson, encodeEvidenceJson } from '../runtime/backend/persistence/evidence-codec.mjs';
import { packLandPublicJsonText, readLandPublicJsonText } from '../runtime/backend/features/land/public-json-storage.mjs';
const quote = value => "CAST(X'" + Buffer.from(value).toString('hex') + "' AS TEXT)";
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const SPECS = [ ['backend_land_source_policy_receipts','receipt_ref','policy'],
  ['backend_land_domain_compatibility_revalidations','revalidation_ref','compatibility'] ];
export function convertLandPublicTextImage({ read, write, progress, frozen, deadline, save }) {
  const summaries = [], encoding = new Map(), verified = new Map(); let encodingBytes = 0;
  const encode = raw => {
    const key = hash(raw); if (encoding.has(key)) return encoding.get(key);
    const text = encodeEvidenceJson(raw), bytes = Buffer.byteLength(text);
    if (bytes <= 8 * 1024 * 1024) {
      encoding.set(key, text); encodingBytes += bytes;
      while (encodingBytes > 16 * 1024 * 1024 || encoding.size > 32) {
        const first = encoding.keys().next().value; encodingBytes -= Buffer.byteLength(encoding.get(first)); encoding.delete(first);
      }
    }
    return text;
  };
  for (const [table, pk, kind] of SPECS) {
    const task = 'transform:public-json-text/v1:' + table, prior = progress(task);
    if (prior?.done === 1) { summaries.push({ table, ...JSON.parse(prior.detail_json) }); continue; }
    let cursor = prior?.last_rowid ?? 0;
    const detail = JSON.parse(prior?.detail_json || '{"converted":0,"unchanged":0,"originalStoredBytes":0,"replacementStoredBytes":0,"hash":""}');
    const maximum = read(`SELECT COALESCE(MAX(rowid),0) AS n FROM ${table};`)[0].n;
    while (cursor < maximum && Date.now() < deadline - 5000) {
      frozen();
      let rows, chunk = kind === 'policy' ? 128 : 16;
      for (;;) {
        try {
          rows = read(`SELECT rowid AS id,${pk} AS ref,CASE
            WHEN substr(receipt_json,1,9)='zjson:v1:' THEN receipt_json
            WHEN json_valid(receipt_json)=0 THEN receipt_json
            WHEN json_type(receipt_json,'$.storageVersion') IS NOT NULL THEN NULL ELSE receipt_json END AS receipt_json
            FROM ${table} WHERE rowid>${cursor} ORDER BY rowid LIMIT ${chunk};`); break;
        } catch (error) {
          if (!['ENOBUFS','ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(error.code) || chunk === 1) throw error;
          chunk = Math.max(1, Math.floor(chunk / 2));
        }
      }
      const updates = [], objects = new Map();
      for (const row of rows) {
        if (row.receipt_json === null) { detail.unchanged++; continue; }
        const raw = decodeEvidenceJson(row.receipt_json), receipt = JSON.parse(raw);
        if (receipt.version !== (kind === 'policy' ? 'land-source-policy/v1' : 'land-domain-compatibility-revalidation/v1')) { detail.unchanged++; continue; }
        const packed = packLandPublicJsonText(raw, kind, encode);
        if (!packed.objects.length) { detail.unchanged++; continue; }
        const values = new Map(packed.objects.map(one => [one.objectRef, one.objectJson]));
        const restored = readLandPublicJsonText({ get(_sql, ref) { return { object_json: values.get(ref) }; } }, JSON.parse(packed.receiptJson), kind);
        if (restored !== raw) throw new Error('Legacy raw JSON text did not reconstruct exactly');
        updates.push({ row, next: packed.receiptJson });
        for (const object of packed.objects) if (!verified.has(object.objectRef)) objects.set(object.objectRef, object.objectJson);
        detail.converted++; detail.originalStoredBytes += Buffer.byteLength(row.receipt_json);
        detail.replacementStoredBytes += Buffer.byteLength(packed.receiptJson);
        detail.hash = hash(detail.hash + row.ref + hash(raw) + hash(packed.receiptJson));
      }
      const sql = ['BEGIN;', 'CREATE TEMP TABLE _r9_public_text_assert(ok INTEGER CHECK(ok=1));'];
      for (const [ref, value] of objects) {
        const existing = write(`SELECT object_json FROM backend_land_policy_public_objects WHERE object_ref=${quote(ref)};`)[0];
        if (existing) {
          if (decodeEvidenceJson(existing.object_json) !== decodeEvidenceJson(value)) throw new Error('Existing raw public object conflicts');
        } else sql.push(`INSERT INTO backend_land_policy_public_objects VALUES(${quote(ref)},${quote(value)});
          INSERT INTO _r9_public_text_assert SELECT EXISTS(SELECT 1 FROM backend_land_policy_public_objects WHERE object_ref=${quote(ref)} AND object_json=${quote(value)});`);
      }
      for (const { row, next } of updates) sql.push(`UPDATE ${table} SET receipt_json=${quote(next)} WHERE rowid=${row.id} AND ${pk}=${quote(row.ref)};
        INSERT INTO _r9_public_text_assert SELECT changes()=1;`);
      cursor = rows.at(-1).id;
      sql.push(`INSERT INTO backend_r9_image_progress VALUES(${quote(task)},${cursor},${Number(cursor === maximum)},${quote(JSON.stringify(detail))})
        ON CONFLICT(task) DO UPDATE SET last_rowid=excluded.last_rowid,done=excluded.done,detail_json=excluded.detail_json; COMMIT;`);
      write(sql.join('\n'));
      for (const ref of objects.keys()) { verified.delete(ref); verified.set(ref, true); while (verified.size > 128) verified.delete(verified.keys().next().value); }
      save('status', { state: 'sharing-byte-exact-public-json', table, cursor, maximum, ...detail, originalUntouched: true,
        savingsCountersAreSourceToFinalNotAdditive: true });
    }
    if (cursor < maximum) return { done: false, summaries };
    if (!maximum) write(`INSERT OR IGNORE INTO backend_r9_image_progress VALUES(${quote(task)},0,1,${quote(JSON.stringify(detail))});`);
    summaries.push({ table, ...detail });
  }
  return { done: true, summaries };
}
