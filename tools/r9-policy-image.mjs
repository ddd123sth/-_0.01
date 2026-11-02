// Real, stopped-device image conversion. All source rows stay read-only;
// checkpoints and byte-equivalence proofs belong to the private staged image.
import crypto from 'node:crypto';
import { canonical, parseStored, plainObject } from '../runtime/backend/common.mjs';
import { encodeEvidenceJson, decodeEvidenceJson } from '../runtime/backend/persistence/evidence-codec.mjs';
import { LAND_POLICY_OBJECT_SCHEMA, packLandSourcePolicyBinding, readLandSourcePolicyBinding } from '../runtime/backend/features/land/source-policy-storage.mjs';
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const literal = text => "'" + text.replaceAll("'", "''") + "'";
const textValue = text => "CAST(X'" + Buffer.from(text).toString('hex') + "' AS TEXT)";
const TASK = 'transform:land-policy-public/v3';
const PUBLIC_FIELDS = new Set(['tables', 'sourceProofs', 'validatedBundle', 'tableHashes']);
function boundedMemo(maximumBytes) {
  const entries = new Map(); let bytes = 0;
  return (key, build) => {
    if (entries.has(key)) { const value = entries.get(key); entries.delete(key); entries.set(key, value); return value.text; }
    const text = build(), size = Buffer.byteLength(text);
    if (size > maximumBytes) return text;
    while (entries.size >= 8 || bytes + size > maximumBytes) {
      const oldest = entries.keys().next().value; bytes -= entries.get(oldest).size; entries.delete(oldest);
    }
    entries.set(key, { text, size }); bytes += size; return text;
  };
}

export function convertLandPolicyImage({ read, write, progress, frozen, deadline, save }) {
  const publicCanonical = boundedMemo(16 * 1024 * 1024), publicEncoding = boundedMemo(8 * 1024 * 1024);
  // These rows have immutable update/delete triggers. Remember only the digest
  // of a byte-verified object, so later slices need not resend its megabytes of
  // identical SQL literals. This memo contains no authority or fact freshness.
  const verifiedObjects = new Map();
  const existingObjects = new Map(); let existingObjectBytes = 0;
  const existingBindingReader = { get(_sql, objectRef) {
    if (existingObjects.has(objectRef)) return { object_json: existingObjects.get(objectRef) };
    const row = write(`SELECT object_json FROM backend_land_policy_public_objects WHERE object_ref=${literal(objectRef)};`)[0];
    if (!row) return null;
    const size = Buffer.byteLength(row.object_json);
    if (size <= 8 * 1024 * 1024) {
      existingObjects.set(objectRef, row.object_json); existingObjectBytes += size;
      while (existingObjectBytes > 16 * 1024 * 1024 || existingObjects.size > 32) {
        const key = existingObjects.keys().next().value; existingObjectBytes -= Buffer.byteLength(existingObjects.get(key)); existingObjects.delete(key);
      }
    }
    return row;
  } };
  const encodePublicObject = text => publicEncoding(digest(text), () => encodeEvidenceJson(text));
  const bindingCanonical = binding => '{' + Object.keys(binding).sort().map(key => JSON.stringify(key) + ':' +
    (key === 'versionEvidence' && plainObject(binding[key]) ? '{' + Object.keys(binding[key]).sort().map(field => {
      const object = binding[key][field];
      const text = PUBLIC_FIELDS.has(field) && (plainObject(object) || Array.isArray(object))
        ? publicCanonical(digest(JSON.stringify(object)), () => canonical(object)) : canonical(object);
      return JSON.stringify(field) + ':' + text;
    }).join(',') + '}' : canonical(binding[key]))).join(',') + '}';
  write(LAND_POLICY_OBJECT_SCHEMA);
  let prior = progress(TASK), cursor = prior?.last_rowid ?? 0;
  const detail = JSON.parse(prior?.detail_json || '{"converted":0,"unchanged":0,"byteLayoutKept":0,"savedTextBytes":0,"hash":""}');
  if (prior?.done === 1) return { done: true, ...detail };
  if (write("SELECT count(*) AS n FROM sqlite_schema WHERE type='trigger' AND name='backend_land_source_policy_no_update';")[0].n)
    throw new Error('Policy image conversion must precede original immutable trigger publication');
  const maximum = read('SELECT COALESCE(MAX(rowid),0) AS n FROM backend_land_source_policy_receipts;')[0].n;
  while (cursor < maximum && Date.now() < deadline - 5000) {
    frozen();
    const rows = read(`SELECT rowid AS id,receipt_ref,CASE
      WHEN substr(receipt_json,1,9)='zjson:v1:' THEN receipt_json
      WHEN json_valid(receipt_json)=0 THEN receipt_json
      WHEN json_extract(receipt_json,'$.storageVersion')='land-source-policy-storage/v2' THEN NULL
      ELSE receipt_json END AS receipt_json FROM backend_land_source_policy_receipts
      WHERE rowid>${cursor} ORDER BY rowid LIMIT 64;`);
    const candidates = [], objects = new Map(), bindings = new Map();
    for (const row of rows) {
      if (row.receipt_json === null) { detail.unchanged++; continue; }
      const originalText = decodeEvidenceJson(row.receipt_json), value = parseStored(originalText, 'original source policy');
      if (value?.version !== 'land-source-policy/v1' || !value.binding) { detail.unchanged++; continue; }
      const canonicalBinding = bindingCanonical(value.binding);
      const packed = packLandSourcePolicyBinding(value.binding, { bindingCanonical: canonicalBinding, encodePublicObject });
      if (!packed.objects.length) { detail.unchanged++; continue; }
      const canonicalReceipt = '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' +
        (key === 'binding' ? canonicalBinding : canonical(value[key]))).join(',') + '}';
      if (row.receipt_ref !== 'land-source-policy:' + digest(canonicalReceipt)) throw new Error('Original policy receipt fingerprint differs');
      const next = JSON.stringify({ storageVersion: 'land-source-policy-storage/v2', bindingRef: packed.bindingRef,
        originalEncoding: canonicalReceipt === originalText ? 'canonical' : 'json-stringify',
        receipt: { ...value, binding: null } });
      const objectMap = new Map(packed.objects.map(object => [object.objectRef, object.objectJson]));
      const reconstructed = { ...value, binding: readLandSourcePolicyBinding({ get(_sql, key) {
        return { object_json: objectMap.get(key) };
      } }, packed.bindingJson) };
      if (bindingCanonical(reconstructed.binding) !== canonicalBinding) throw new Error('Public binding exact canonical bytes did not reconstruct');
      // A different original byte layout is left in its original cell. Never
      // substitute semantic equality for the promised original JSON bytes.
      if (canonicalReceipt !== originalText && JSON.stringify(reconstructed) !== originalText) { detail.byteLayoutKept++; continue; }
      candidates.push({ ...row, packed, next, originalSha256: digest(originalText) });
    }
    const existing = candidates.length ? write(`SELECT binding_ref,binding_json FROM backend_land_source_policy_bindings
      WHERE binding_ref IN(${[...new Set(candidates.map(row => row.packed.bindingRef))].map(literal).join(',')});`) : [];
    const existingMap = new Map(existing.map(row => [row.binding_ref, row.binding_json]));
    const accepted = candidates.filter(row => {
      const before = existingMap.get(row.packed.bindingRef);
      if (before !== undefined && before !== row.packed.bindingJson) {
        // The same semantic binding may already have a different JSON member
        // order. Canonical originals reconstruct byte-for-byte from either
        // representation; leave noncanonical layouts intact if not identical.
        if (JSON.parse(row.next).originalEncoding === 'canonical' &&
            digest(bindingCanonical(readLandSourcePolicyBinding(existingBindingReader, before))) === row.packed.bindingRef) {
          row.packed = { ...row.packed, bindingJson: before, objects: [] }; return true;
        }
        detail.byteLayoutKept++; return false;
      }
      existingMap.set(row.packed.bindingRef, row.packed.bindingJson);
      return true;
    });
    for (const row of accepted) {
      bindings.set(row.packed.bindingRef, row.packed.bindingJson);
      for (const object of row.packed.objects) objects.set(object.objectRef, object.objectJson);
      detail.converted++; detail.savedTextBytes += Buffer.byteLength(row.receipt_json) - Buffer.byteLength(row.next);
      detail.hash = digest(detail.hash + row.receipt_ref + row.originalSha256 + digest(row.next));
    }
    cursor = rows.at(-1).id;
    const statements = ['BEGIN;', 'CREATE TEMP TABLE _r9_policy_assert(ok INTEGER CHECK(ok=1));'];
    for (const [ref, json] of objects) if (verifiedObjects.get(ref) !== digest(json))
      statements.push(`INSERT OR IGNORE INTO backend_land_policy_public_objects VALUES(${literal(ref)},${textValue(json)});
        INSERT INTO _r9_policy_assert SELECT EXISTS(SELECT 1 FROM backend_land_policy_public_objects WHERE object_ref=${literal(ref)} AND object_json=${textValue(json)});`);
    for (const [ref, json] of bindings) statements.push(`INSERT OR IGNORE INTO backend_land_source_policy_bindings VALUES(${literal(ref)},${textValue(json)});
      INSERT INTO _r9_policy_assert SELECT EXISTS(SELECT 1 FROM backend_land_source_policy_bindings WHERE binding_ref=${literal(ref)} AND binding_json=${textValue(json)});`);
    for (const row of accepted) statements.push(`UPDATE backend_land_source_policy_receipts SET receipt_json=${textValue(row.next)} WHERE rowid=${row.id};
      INSERT INTO _r9_policy_assert SELECT EXISTS(SELECT 1 FROM backend_land_source_policy_receipts WHERE rowid=${row.id}
        AND receipt_ref=${literal(row.receipt_ref)} AND receipt_json=${textValue(row.next)});`);
    statements.push(`INSERT INTO backend_r9_image_progress VALUES(${literal(TASK)},${cursor},${Number(cursor === maximum)},${textValue(JSON.stringify(detail))})
      ON CONFLICT(task) DO UPDATE SET last_rowid=excluded.last_rowid,done=excluded.done,detail_json=excluded.detail_json; COMMIT;`);
    write(statements.join('\n'));
    for (const [ref, json] of objects) {
      verifiedObjects.delete(ref); verifiedObjects.set(ref, digest(json));
      while (verifiedObjects.size > 128) verifiedObjects.delete(verifiedObjects.keys().next().value);
    }
    save('status', { state: 'sharing-legacy-public-objects', cursor, maximum, ...detail, originalUntouched: true });
  }
  return { done: cursor === maximum, ...detail };
}
