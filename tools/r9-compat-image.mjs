// Private stopped-image transformation. Every replacement reconstructs exactly
// the original decoded JSON text; no observation or outcome is removed.
import crypto from 'node:crypto';
import { decodeEvidenceJson, encodeEvidenceJson } from '../runtime/backend/persistence/evidence-codec.mjs';
import { packLandCompatibilityReceipt, readLandCompatibilityReceipt } from '../runtime/backend/features/land/source-policy-storage.mjs';
import { canonical } from '../runtime/backend/common.mjs';
const literal = text => "CAST(X'" + Buffer.from(text).toString('hex') + "' AS TEXT)";
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
export function convertLandCompatibilityImage({ read, write, progress, frozen, deadline, save }) {
  const task = 'transform:land-compatibility-public/v2', prior = progress(task);
  if (prior?.done === 1) return { done: true, ...JSON.parse(prior.detail_json) };
  let cursor = prior?.last_rowid ?? 0;
  const detail = JSON.parse(prior?.detail_json || '{"converted":0,"unchanged":0,"savedTextBytes":0,"hash":""}');
  const maximum = read('SELECT COALESCE(MAX(rowid),0) AS n FROM backend_land_domain_compatibility_revalidations;')[0].n;
  const memo = new Map(); let memoBytes = 0;
  const canonicalMemo = new Map(); let canonicalBytes = 0;
  const canonicalPublic = value => {
    const raw = JSON.stringify(value), key = digest(raw), hit = canonicalMemo.get(key);
    if (hit) return hit;
    const text = canonical(value), bytes = Buffer.byteLength(text);
    if (bytes <= 8 * 1024 * 1024) {
      canonicalMemo.set(key, text); canonicalBytes += bytes;
      while (canonicalBytes > 16 * 1024 * 1024 || canonicalMemo.size > 32) {
        const first = canonicalMemo.keys().next().value; canonicalBytes -= Buffer.byteLength(canonicalMemo.get(first)); canonicalMemo.delete(first);
      }
    }
    return text;
  };
  const canonicalReceipt = receipt => {
    const version = receipt.authorizedVersionEvidence;
    const versionText = '{' + Object.keys(version).sort().map(key => JSON.stringify(key) + ':' +
      (['tables','sourceProofs','validatedBundle','tableHashes'].includes(key) ? canonicalPublic(version[key]) : canonical(version[key]))).join(',') + '}';
    const receiptText = '{' + Object.keys(receipt).sort().map(key => JSON.stringify(key) + ':' +
      (key === 'authorizedVersionEvidence' ? versionText : canonical(receipt[key]))).join(',') + '}';
    return { receiptText, bindingCanonical: '{"versionEvidence":' + versionText + '}' };
  };
  const encodePublicObject = text => {
    const key = digest(text), hit = memo.get(key);
    if (hit) return hit;
    const result = encodeEvidenceJson(text), bytes = Buffer.byteLength(result);
    if (bytes <= 8 * 1024 * 1024) {
      memo.set(key, result); memoBytes += bytes;
      while (memoBytes > 16 * 1024 * 1024 || memo.size > 32) {
        const first = memo.keys().next().value; memoBytes -= Buffer.byteLength(memo.get(first)); memo.delete(first);
      }
    }
    return result;
  };
  while (cursor < maximum && Date.now() < deadline - 5000) {
    frozen();
    const rows = read(`SELECT rowid AS id,revalidation_ref,receipt_json FROM backend_land_domain_compatibility_revalidations
      WHERE rowid>${cursor} ORDER BY rowid LIMIT 4;`);
    const sql = ['BEGIN;', 'CREATE TEMP TABLE _r9_compat_assert(ok INTEGER CHECK(ok=1));'];
    for (const row of rows) {
      const text = decodeEvidenceJson(row.receipt_json), receipt = JSON.parse(text);
      if (receipt.storageVersion || receipt.version !== 'land-domain-compatibility-revalidation/v1') { detail.unchanged++; continue; }
      const computed = canonicalReceipt(receipt), originalEncoding = computed.receiptText === text ? 'canonical' : 'json-stringify';
      const packed = packLandCompatibilityReceipt(receipt, { encodePublicObject, bindingCanonical: computed.bindingCanonical,
        receiptCanonical: computed.receiptText, originalEncoding });
      if (!packed.objects.length) { detail.unchanged++; continue; }
      const objects = new Map(packed.objects.map(one => [one.objectRef, one.objectJson]));
      const reconstructed = readLandCompatibilityReceipt({ get(_sql, ref) { return { object_json: objects.get(ref) }; } }, packed.receiptJson);
      const reconstructedText = originalEncoding === 'canonical' ? canonicalReceipt(reconstructed).receiptText : JSON.stringify(reconstructed);
      if (reconstructedText !== text) { detail.unchanged++; continue; }
      for (const object of packed.objects) {
        sql.push(`INSERT OR IGNORE INTO backend_land_policy_public_objects VALUES(${literal(object.objectRef)},${literal(object.objectJson)});
          INSERT INTO _r9_compat_assert SELECT EXISTS(SELECT 1 FROM backend_land_policy_public_objects
            WHERE object_ref=${literal(object.objectRef)} AND object_json=${literal(object.objectJson)});`);
      }
      sql.push(`UPDATE backend_land_domain_compatibility_revalidations SET receipt_json=${literal(packed.receiptJson)} WHERE rowid=${row.id};
        INSERT INTO _r9_compat_assert SELECT EXISTS(SELECT 1 FROM backend_land_domain_compatibility_revalidations
          WHERE rowid=${row.id} AND receipt_json=${literal(packed.receiptJson)});`);
      detail.converted++; detail.savedTextBytes += Buffer.byteLength(row.receipt_json) - Buffer.byteLength(packed.receiptJson);
      detail.hash = digest(detail.hash + row.revalidation_ref + digest(text) + digest(packed.receiptJson));
    }
    cursor = rows.at(-1).id;
    sql.push(`INSERT INTO backend_r9_image_progress VALUES(${literal(task)},${cursor},${Number(cursor === maximum)},${literal(JSON.stringify(detail))})
      ON CONFLICT(task) DO UPDATE SET last_rowid=excluded.last_rowid,done=excluded.done,detail_json=excluded.detail_json; COMMIT;`);
    write(sql.join('\n'));
    save('status', { state: 'sharing-land-compatibility-public-objects', cursor, maximum, ...detail, originalUntouched: true });
  }
  if (!maximum) write(`INSERT OR IGNORE INTO backend_r9_image_progress VALUES(${literal(task)},0,1,${literal(JSON.stringify(detail))});`);
  return { done: cursor === maximum, ...detail };
}
